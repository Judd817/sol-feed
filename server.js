'use strict';

/**
 * sol-feed — Birdeye REST poller with boot poll + fallback pairs
 * Routes:
 *   GET /                       -> health
 *   GET /new-pairs              -> recent new pairs
 *   GET /whales?min_buy_usd=NUM -> large trades filtered by USD
 *   GET /_probe/pairs           -> debug sample from new_listing
 *   GET /_probe/trades          -> debug sample from trades
 *   POST /_poll                 -> trigger both pollers now
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ---- ENV ----
const PORT = Number(process.env.PORT || 3000);
const BIRDEYE_KEY = String(process.env.BIRDEYE_KEY || '').trim();

const MIN_LIQ_USD     = Number(process.env.MIN_LIQ_USD || 0);
const MIN_TRADE_USD   = Number(process.env.MIN_TRADE_USD || 1);
const MIN_24H_VOL_USD = Number(process.env.MIN_24H_VOL_USD || 0);
const MIN_24H_TRADES  = Number(process.env.MIN_24H_TRADES || 0);
const MIN_AGE_MINUTES = Number(process.env.MIN_AGE_MINUTES || 0);

const PAIR_POLL_MS  = Number(process.env.PAIR_POLL_MS  || 120000);
const TRADE_POLL_MS = Number(process.env.TRADE_POLL_MS || 420000);
const TICK_MS       = 15000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

// ---- Birdeye endpoints ----
// Limit must be 1..20 per Birdeye error message.
const NP_URL = 'https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=20';
// Trades v3
const LT_URL_PRIMARY  = 'https://public-api.birdeye.so/defi/v3/txs?limit=100&sort_by=block_unix_time&sort_type=desc';
const LT_URL_FALLBACK = 'https://public-api.birdeye.so/defi/v3/txs/recent?chain=solana&limit=100';

// ---- STATE ----
const MAX_KEEP = 200;
const newPairs = [];
const largeTrades = [];
const seenPairs  = new Set();
const seenTrades = new Set();

let connected = false;
let lastPoll  = null;
let lastError = null;

let nextPairPollAt   = Date.now() + 2000; // quick first tick
let nextTradePollAt  = Date.now() + 2000;
let pairBackoffMs    = 0;
let tradeBackoffMs   = 0;

// ---- HELPERS ----
function jitter(ms){ return ms + Math.floor(Math.random()*0.25*ms); }
function pushRing(arr, item, max=MAX_KEEP){ arr.push(item); if(arr.length>max) arr.shift(); }
function hash(v){
  const s = v?.tx_hash || v?.txHash || v?.signature || v?.tx ||
            v?.pool_id || v?.pairAddress || v?.mint || JSON.stringify(v);
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}
function toNum(x,d=0){ const n=Number(x); return Number.isFinite(n)?n:d; }
function minutesAgo(ts){
  const t=typeof ts==='number'?ts:Date.parse(ts);
  if(!Number.isFinite(t)) return Infinity;
  return (Date.now()-t)/60000;
}
async function fetchRaw(url){
  return fetch(url, {
    headers: {
      'X-API-KEY': BIRDEYE_KEY,
      'X-CHAIN': 'solana',
      'Accept': 'application/json'
    }
  });
}
async function fetchJson(url){
  const res = await fetchRaw(url);
  const txt = await res.text();
  let obj = null; try { obj = JSON.parse(txt); } catch {}
  if (!res.ok || (obj && obj.success === false)) {
    const e = new Error(`HTTP ${res.status} :: ${(obj && obj.message) || txt.slice(0,200)}`);
    e.status = res.status;
    throw e;
  }
  return obj ?? { data:null, raw:txt };
}
function pickFirstArray(obj){
  if (!obj || typeof obj!=='object') return [];
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj.data)) return obj.data;
  const pref = ['items','transactions','txs','records','rows','result','list'];
  if (obj.data && typeof obj.data==='object') {
    for (const k of pref) if (Array.isArray(obj.data[k])) return obj.data[k];
    for (const k of Object.keys(obj.data)) if (Array.isArray(obj.data[k])) return obj.data[k];
  }
  for (const k of pref) if (Array.isArray(obj[k])) return obj[k];
  for (const k of Object.keys(obj)) if (Array.isArray(obj[k])) return obj[k];
  return [];
}
function passPairFilters(p){
  const liq = toNum(p.liquidityUSD ?? p.liquidity_usd ?? p.liquidity ?? 0);
  const v24 = toNum(p.volumeUsd24h ?? p.volume_usd_24h ?? p.v24hUsd ?? p.v24hUSD ?? 0);
  const t24 = toNum(p.transaction_count_24h ?? p.trades24h ?? p.t24h ?? 0);
  const created = p.created_at ?? p.createdAt ?? p.listedAt ?? p.added_time ?? p.launchAt ?? p.block_unix_time;
  if (liq < MIN_LIQ_USD) return false;
  if (v24 < MIN_24H_VOL_USD) return false;
  if (t24 < MIN_24H_TRADES) return false;
  if (MIN_AGE_MINUTES>0 && minutesAgo(created)<MIN_AGE_MINUTES) return false;
  return true;
}
function tradeUsd(t){
  const keys = [
    'value_usd','usd_value','quoteValueUsd','baseValueUsd',
    'amount_usd','amountUSD','usdAmount','sizeUsd','notionalUsd',
    'volumeUSD','volume_usd','quoteUsd','baseUsd','usd','price_usd'
  ];
  for (const k of keys) { const v = toNum(t?.[k]); if (v>0) return v; }
  const qty = toNum(t?.amount ?? t?.size ?? t?.qty ?? t?.quoteAmount ?? t?.baseAmount ?? 0);
  const px  = toNum(t?.price ?? t?.avgPrice ?? t?.p ?? t?.quotePrice ?? t?.avg_price ?? 0);
  const v = qty * px;
  return Number.isFinite(v) ? v : 0;
}
function passTradeFilters(t){ return tradeUsd(t) >= MIN_TRADE_USD; }

// ---- INTERNAL: trades fetch with fallback ----
async function fetchTradesWithFallback(){
  try {
    return await fetchJson(LT_URL_PRIMARY);
  } catch (e) {
    if (e.status && e.status >= 400 && e.status < 500) {
      console.warn('primary trades endpoint failed, trying recent:', e.message || e);
      return await fetchJson(LT_URL_FALLBACK);
    }
    throw e;
  }
}

// ---- FALLBACK: derive "new pairs" from recent trades if listing is empty ----
async function derivePairsFromRecentTrades(windowMinutes = 120){
  const raw = await fetchTradesWithFallback();
  const arr = pickFirstArray(raw);
  const cutoff = Date.now() - windowMinutes * 60 * 1000;

  const map = new Map();
  for (const t of arr) {
    const pool = t.pool_id || t.poolId || null;
    const base = t.base || {};
    const quote = t.quote || {};
    const whenMs = Number(t.block_unix_time ? t.block_unix_time * 1000 : Date.now());
    if (whenMs < cutoff) continue;

    const k = pool || `${base.address}|${quote.address}`;
    if (!k) continue;
    if (!map.has(k)) {
      map.set(k, {
        pool_id: pool || null,
        base, quote,
        block_unix_time: t.block_unix_time || Math.floor(Date.now()/1000),
        liquidityUSD: 0,
        volumeUsd24h: 0,
        transaction_count_24h: 0,
        created_at: new Date().toISOString()
      });
    }
  }
  return [...map.values()];
}

// ---- POLLERS ----
async function pollPairs(){
  try {
    const np = await fetchJson(NP_URL);
    let arr = pickFirstArray(np);

    if (!Array.isArray(arr) || arr.length === 0) {
      const synth = await derivePairsFromRecentTrades(120);
      arr = synth;
    }

    let added = 0;
    for (const it of arr) {
      const key = hash(it);
      if (seenPairs.has(key)) continue;
      if (!passPairFilters(it)) continue;
      seenPairs.add(key); pushRing(newPairs,it); added++;
    }
    if (added) console.log(`pairs add +${added} (total ${newPairs.length})`);
    pairBackoffMs = 0;
  } catch (e) {
    lastError = String(e);
    console.error('pollPairs error:', e.message || e);
    if (e.status === 429) pairBackoffMs = Math.min((pairBackoffMs||30000)*2, MAX_BACKOFF_MS);
  } finally {
    nextPairPollAt = Date.now() + jitter(PAIR_POLL_MS + pairBackoffMs);
  }
}

async function pollTrades(){
  try {
    const lt = await fetchTradesWithFallback();
    const arr = pickFirstArray(lt);
    let added = 0;
    for (const it of arr) {
      const key = hash(it);
      if (seenTrades.has(key)) continue;
      if (!passTradeFilters(it)) continue;
      seenTrades.add(key); pushRing(largeTrades,it); added++;
    }
    if (added) console.log(`trades add +${added} (total ${largeTrades.length})`);
    tradeBackoffMs = 0;
  } catch (e) {
    lastError = String(e);
    console.error('pollTrades error:', e.message || e);
    if (e.status === 429) tradeBackoffMs = Math.min((tradeBackoffMs||60000)*2, MAX_BACKOFF_MS);
  } finally {
    nextTradePollAt = Date.now() + jitter(TRADE_POLL_MS + tradeBackoffMs);
  }
}

function tick(){
  const now = Date.now();
  if (now >= nextPairPollAt)  pollPairs();
  if (now >= nextTradePollAt) pollTrades();
  connected = true; lastPoll = new Date().toISOString();
}

// ---- HTTP ----
const sliceLast = (arr, n=100) => [...arr].slice(-n).reverse();

app.get('/', (_req,res) => {
  res.json({
    ok:true, mode:'rest', connected,
    newPairs:newPairs.length, largeTrades:largeTrades.length,
    filters:{ MIN_LIQ_USD, MIN_TRADE_USD, MIN_24H_VOL_USD, MIN_24H_TRADES, MIN_AGE_MINUTES },
    endpoints:{ NP_URL, LT_URL_PRIMARY, LT_URL_FALLBACK },
    nextPolls:{ pairsInMs: Math.max(0,nextPairPollAt-Date.now()), tradesInMs: Math.max(0,nextTradePollAt-Date.now()) },
    lastPoll, lastError
  });
});

app.get('/new-pairs', (_req,res) => res.json({ data: sliceLast(newPairs) }));

app.get('/whales', (req,res) => {
  const min = Number(req.query.min_buy_usd || MIN_TRADE_USD);
  res.json({ data: sliceLast(largeTrades).filter(t => tradeUsd(t) >= min) });
});

app.get('/_probe/pairs', async (_req,res) => {
  try {
    const raw = await fetchJson(NP_URL);
    res.json({ url: NP_URL, sample: pickFirstArray(raw).slice(0,10) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/_probe/trades', async (_req,res) => {
  try {
    const raw = await fetchTradesWithFallback();
    res.json({ url_primary: LT_URL_PRIMARY, url_fallback: LT_URL_FALLBACK, sample: pickFirstArray(raw).slice(0,10) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/_poll', async (_req,res) => {
  try {
    await Promise.all([pollPairs(), pollTrades()]);
    res.json({ ok:true, newPairs:newPairs.length, largeTrades:largeTrades.length });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ---- BOOT ----
app.listen(PORT, () => {
  console.log(`sol-feed listening on ${PORT}`);
  // kick immediately so you see data
  pollPairs().catch(()=>{});
  pollTrades().catch(()=>{});
  setInterval(tick, TICK_MS);
});
