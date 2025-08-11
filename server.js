'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());

// ---- ENV ----
const PORT = Number(process.env.PORT || 3000);
const BIRDEYE_KEY = String(process.env.BIRDEYE_KEY || '').trim();

const MIN_LIQ_USD     = Number(process.env.MIN_LIQ_USD || 0);
const MIN_TRADE_USD   = Number(process.env.MIN_TRADE_USD || 1);
const MIN_24H_VOL_USD = Number(process.env.MIN_24H_VOL_USD || 0);
const MIN_24H_TRADES  = Number(process.env.MIN_24H_TRADES || 0);
const MIN_AGE_MINUTES = Number(process.env.MIN_AGE_MINUTES || 0);

// poll pacing (independent)
const PAIR_POLL_MS  = Number(process.env.PAIR_POLL_MS  || 120000); // 2 min
const TRADE_POLL_MS = Number(process.env.TRADE_POLL_MS || 420000); // 7 min
const TICK_MS       = 15000; // scheduler tick

// ---- STATE ----
const MAX_KEEP = 200;
const newPairs = [];
const largeTrades = [];
const seenPairs  = new Set();
const seenTrades = new Set();

let connected = false;
let lastPoll  = null;
let lastError = null;

let NP_URL = null;
let LT_URL = null;

// backoffs & pacing
let nextPairPollAt   = Date.now() + jitter(PAIR_POLL_MS);
let pairBackoffMs    = 0;

let nextTradePollAt  = Date.now() + jitter(TRADE_POLL_MS);
let tradeBackoffMs   = 0;

const MAX_BACKOFF_MS = 10 * 60 * 1000; // 10 min

// ---- HELPERS ----
function jitter(ms) { return ms + Math.floor(Math.random()*0.25*ms); }
function pushRing(arr, item, max=MAX_KEEP){ arr.push(item); if(arr.length>max) arr.shift(); }
function hash(v){ const s=v?.txHash||v?.signature||v?.tx||v?.pairAddress||v?.mint||JSON.stringify(v); return crypto.createHash('sha1').update(String(s)).digest('hex'); }
function toNum(x,d=0){ const n=Number(x); return Number.isFinite(n)?n:d; }
function minutesAgo(ts){ const t=typeof ts==='number'?ts:Date.parse(ts); if(!Number.isFinite(t)) return Infinity; return (Date.now()-t)/60000; }

async function fetchRaw(url){
  return fetch(url, { headers: { 'X-API-KEY': BIRDEYE_KEY, 'Accept': 'application/json' } });
}
async function fetchJson(url){
  const res = await fetchRaw(url);
  const txt = await res.text();
  let obj = null; try { obj = JSON.parse(txt); } catch {}
  if (!res.ok || (obj && obj.success === false)) {
    const e = new Error(`HTTP ${res.status} :: ${(obj && obj.message) || txt.slice(0,200)}`);
    e.status = res.status; throw e;
  }
  return obj ?? { data:null, raw:txt };
}

const TOKEN_CANDIDATES = [
  'https://public-api.birdeye.so/defi/tokenlist?offset=0&limit=50&chain=solana',
  'https://public-api.birdeye.so/public/tokenlist?offset=0&limit=50&chain=solana',
  'https://public-api.birdeye.so/tokenlist?offset=0&limit=50&chain=solana',
];
const TRADE_CANDIDATES = [
  'https://public-api.birdeye.so/defi/large_trades?chain=solana&offset=0&limit=50',
  'https://public-api.birdeye.so/public/large_trades?chain=solana&offset=0&limit=50',
  'https://public-api.birdeye.so/large_trades?chain=solana&offset=0&limit=50',
];

async function findUrl(cands,label){
  for (const url of cands) {
    try { const r = await fetchRaw(url); await r.text(); if (r.ok) return url; } catch {}
  }
  throw new Error(`No working ${label} endpoint`);
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
  const created = p.created_at ?? p.createdAt ?? p.listedAt ?? p.added_time ?? p.launchAt;
  if (liq < MIN_LIQ_USD) return false;
  if (v24 < MIN_24H_VOL_USD) return false;
  if (t24 < MIN_24H_TRADES) return false;
  if (MIN_AGE_MINUTES>0 && minutesAgo(created)<MIN_AGE_MINUTES) return false;
  return true;
}

function tradeUsd(t){
  const keys = [
    'volumeUSD','volume_usd','usd_volume','amountUSD','amount_usd','usdAmount',
    'usd_value','value_usd','quoteUsd','baseUsd','usd','sizeUsd','notionalUsd',
    'quote_amount_usd','base_amount_usd','buy_usd','sell_usd','quoteValueUsd','baseValueUsd'
  ];
  for (const k of keys) { const v = toNum(t?.[k]); if (v>0) return v; }
  const qty = toNum(t?.amount ?? t?.size ?? t?.qty ?? t?.quoteAmount ?? t?.baseAmount ?? 0);
  const px  = toNum(t?.price ?? t?.avgPrice ?? t?.p ?? t?.quotePrice ?? t?.avg_price ?? 0);
  const v = qty * px;
  return Number.isFinite(v) ? v : 0;
}
function passTradeFilters(t){ return tradeUsd(t) >= MIN_TRADE_USD; }

// ---- POLLERS ----
async function pollPairs(){
  try {
    if (!NP_URL) NP_URL = await findUrl(TOKEN_CANDIDATES,'new-pairs');
    const np = await fetchJson(NP_URL);
    const arr = pickFirstArray(np);
    let add = 0;
    for (const it of arr) {
      const key = hash(it);
      if (seenPairs.has(key)) continue;
      if (!passPairFilters(it)) continue;
      seenPairs.add(key); pushRing(newPairs,it); add++;
    }
    pairBackoffMs = 0;
  } catch (e) {
    if (e.status === 429) {
      pairBackoffMs = Math.min((pairBackoffMs||30000)*2, MAX_BACKOFF_MS);
    } else {
      NP_URL = null; // re-probe next time
    }
  } finally {
    nextPairPollAt = Date.now() + jitter(PAIR_POLL_MS + pairBackoffMs);
  }
}

async function pollTrades(){
  try {
    if (!LT_URL) LT_URL = await findUrl(TRADE_CANDIDATES,'large-trades');
    const lt = await fetchJson(LT_URL);
    const arr = pickFirstArray(lt);
    let add = 0;
    for (const it of arr) {
      const key = hash(it);
      if (seenTrades.has(key)) continue;
      if (!passTradeFilters(it)) continue;
      seenTrades.add(key); pushRing(largeTrades,it); add++;
    }
    tradeBackoffMs = 0;
  } catch (e) {
    if (e.status === 429) {
      tradeBackoffMs = Math.min((tradeBackoffMs||60000)*2, MAX_BACKOFF_MS);
    } else {
      LT_URL = null;
    }
  } finally {
    nextTradePollAt = Date.now() + jitter(TRADE_POLL_MS + tradeBackoffMs);
  }
}

function tick(){
  const now = Date.now();
  if (now >= nextPairPollAt)  pollPairs();
  if (now >= nextTradePollAt) pollTrades();
  connected = true; lastError = null; lastPoll = new Date().toISOString();
}

// ---- HTTP ----
const sliceLast = (arr, n=100) => [...arr].slice(-n).reverse();

app.get('/', (_req,res) => {
  res.json({
    ok:true, mode:'rest', connected,
    newPairs:newPairs.length, largeTrades:largeTrades.length,
    filters:{ MIN_LIQ_USD, MIN_TRADE_USD, MIN_24H_VOL_USD, MIN_24H_TRADES, MIN_AGE_MINUTES },
    endpoints:{ NP_URL, LT_URL },
    nextPolls:{ pairsInMs: Math.max(0,nextPairPollAt-Date.now()), tradesInMs: Math.max(0,nextTradePollAt-Date.now()) },
    lastPoll, lastError
  });
});
app.get('/new-pairs', (_req,res) => res.json({ data: sliceLast(newPairs) }));
app.get('/whales', (req,res) => {
  const min = Number(req.query.min_buy_usd || MIN_TRADE_USD);
  res.json({ data: sliceLast(largeTrades).filter(t => tradeUsd(t) >= min) });
});
app.get('/_probe/trades', async (_req,res) => {
  try {
    if (!LT_URL) LT_URL = await findUrl(TRADE_CANDIDATES,'large-trades');
    const raw = await fetchJson(LT_URL);
    res.json({ url: LT_URL, sample: pickFirstArray(raw).slice(0,10) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- BOOT ----
app.listen(PORT, () => {
  setInterval(tick, TICK_MS);
});
