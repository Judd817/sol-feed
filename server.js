'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const BIRDEYE_KEY = String(process.env.BIRDEYE_KEY || '').trim();

const MIN_LIQ_USD     = Number(process.env.MIN_LIQ_USD || 0);
const MIN_TRADE_USD   = Number(process.env.MIN_TRADE_USD || 1);
const MIN_24H_VOL_USD = Number(process.env.MIN_24H_VOL_USD || 0);
const MIN_24H_TRADES  = Number(process.env.MIN_24H_TRADES || 0);
const MIN_AGE_MINUTES = Number(process.env.MIN_AGE_MINUTES || 0);

const POLL_MS = Number(process.env.POLL_MS || 15000); // slower base poll to reduce 429s
const TRADE_POLL_FACTOR = 4; // poll trades every 4x slower than pairs

const app = express();
app.use(cors());

const MAX_KEEP = 200;
const newPairs = [];
const largeTrades = [];
let connected = false;

let NP_URL = null;
let LT_URL = null;
let lastPoll = null;
let lastError = null;
let lastRawNP = null;
let lastRawLT = null;

let seenPairs = new Set();
let seenTrades = new Set();

let tradeBackoffMs = 0;
let lastTradePoll = 0;

function pushRing(arr, item, max = MAX_KEEP) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}
function hash(v) {
  const s = v?.txHash || v?.signature || v?.tx || v?.pairAddress || v?.mint || JSON.stringify(v);
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}
function toNum(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function minutesAgo(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

async function fetchRaw(url) {
  return fetch(url, { headers: { 'X-API-KEY': BIRDEYE_KEY, 'Accept': 'application/json' } });
}
async function fetchJson(url) {
  const res = await fetchRaw(url);
  const txt = await res.text();
  let obj = null;
  try { obj = JSON.parse(txt); } catch {}
  if (!res.ok || (obj && obj.success === false)) {
    const msg = obj?.message || txt.slice(0, 200);
    throw new Error(`HTTP ${res.status} :: ${msg}`);
  }
  return obj ?? { data: null, raw: txt };
}

const TOKEN_CANDIDATES = [
  'https://public-api.birdeye.so/defi/tokenlist?offset=0&limit=50&chain=solana',
  'https://public-api.birdeye.so/public/tokenlist?offset=0&limit=50&chain=solana',
  'https://public-api.birdeye.so/tokenlist?offset=0&limit=50&chain=solana'
];
const TRADE_CANDIDATES = [
  'https://public-api.birdeye.so/defi/large_trades?chain=solana&offset=0&limit=50',
  'https://public-api.birdeye.so/public/large_trades?chain=solana&offset=0&limit=50',
  'https://public-api.birdeye.so/large_trades?chain=solana&offset=0&limit=50'
];

async function findUrl(cands, label) {
  for (const url of cands) {
    try {
      const r = await fetchRaw(url);
      await r.text();
      if (r.ok) {
        console.log(`[REST] ${label} OK -> ${url}`);
        return url;
      } else {
        console.log(`[REST] ${label} try ${r.status} -> ${url}`);
      }
    } catch (e) {
      console.log(`[REST] ${label} error -> ${url} :: ${e.message}`);
    }
  }
  throw new Error(`No working ${label} endpoint`);
}

function pickFirstArray(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj.data)) return obj.data;
  if (obj.data && typeof obj.data === 'object') {
    for (const k of Object.keys(obj.data)) {
      if (Array.isArray(obj.data[k])) return obj.data[k];
    }
  }
  for (const k of Object.keys(obj)) {
    if (Array.isArray(obj[k])) return obj[k];
  }
  return [];
}

function passPairFilters(p) {
  const liq      = toNum(p.liquidityUSD ?? p.liquidity_usd ?? p.liquidity ?? 0);
  const vol24    = toNum(p.volumeUsd24h ?? p.volume_usd_24h ?? p.v24hUsd ?? p.v24hUSD ?? 0);
  const trades24 = toNum(p.transaction_count_24h ?? p.trades24h ?? p.t24h ?? 0);
  const created  = p.created_at ?? p.createdAt ?? p.listedAt ?? p.added_time ?? p.launchAt;
  if (liq < MIN_LIQ_USD) return false;
  if (vol24 < MIN_24H_VOL_USD) return false;
  if (trades24 < MIN_24H_TRADES) return false;
  if (MIN_AGE_MINUTES > 0 && minutesAgo(created) < MIN_AGE_MINUTES) return false;
  return true;
}

function tradeUsd(t) {
  const keys = [
    'volumeUSD','volume_usd','usd_volume','amountUSD','amount_usd',
    'usdAmount','usd_value','value_usd','quoteUsd','baseUsd',
    'usd','sizeUsd','notionalUsd','quote_amount_usd','base_amount_usd',
    'buy_usd','sell_usd','quoteValueUsd','baseValueUsd'
  ];
  for (const k of keys) {
    const v = toNum(t?.[k]);
    if (v > 0) return v;
  }
  const qty = toNum(t?.amount ?? t?.size ?? t?.qty ?? 0);
  const px  = toNum(t?.price ?? t?.avgPrice ?? t?.p ?? 0);
  return qty * px;
}

function passTradeFilters(t) {
  return tradeUsd(t) >= MIN_TRADE_USD;
}

async function pollOnce() {
  try {
    if (!BIRDEYE_KEY) throw new Error('Missing BIRDEYE_KEY');

    if (!NP_URL) NP_URL = await findUrl(TOKEN_CANDIDATES, 'new-pairs');
    const np = await fetchJson(NP_URL);
    lastRawNP = np;
    const npItems = pickFirstArray(np);
    for (const it of npItems) {
      const key = hash(it);
      if (seenPairs.has(key)) continue;
      if (!passPairFilters(it)) continue;
      seenPairs.add(key);
      pushRing(newPairs, it);
    }

    // Trades — only poll if backoff passed
    const now = Date.now();
    if (now - lastTradePoll > (POLL_MS * TRADE_POLL_FACTOR) + tradeBackoffMs) {
      if (!LT_URL) LT_URL = await findUrl(TRADE_CANDIDATES, 'large-trades');
      try {
        const lt = await fetchJson(LT_URL);
        lastRawLT = lt;
        const ltItems = pickFirstArray(lt);
        for (const it of ltItems) {
          const key = hash(it);
          if (seenTrades.has(key)) continue;
          if (!passTradeFilters(it)) continue;
          seenTrades.add(key);
          pushRing(largeTrades, it);
        }
        tradeBackoffMs = 0;
      } catch (te) {
        if (String(te).includes('429')) {
          tradeBackoffMs = Math.min((tradeBackoffMs || 5000) * 2, 120000);
          console.warn(`[REST] trades 429, backoff now ${tradeBackoffMs} ms`);
        } else {
          throw te;
        }
      }
      lastTradePoll = now;
    }

    connected = true;
    lastError = null;
  } catch (e) {
    connected = false;
    lastError = e.message || String(e);
    NP_URL = null;
    LT_URL = null;
    console.error('[REST] poll error:', lastError);
  } finally {
    lastPoll = new Date().toISOString();
  }
}

function startPolling() {
  console.log('[REST] mode enabled');
  pollOnce();
  setInterval(pollOnce, POLL_MS);
}

app.get('/', (_req, res) => {
  res.json({
    ok: true, mode: 'rest', connected,
    newPairs: newPairs.length, largeTrades: largeTrades.length,
    filters: { MIN_LIQ_USD, MIN_TRADE_USD, MIN_24H_VOL_USD, MIN_24H_TRADES, MIN_AGE_MINUTES },
    endpoints: { NP_URL, LT_URL }, lastPoll, lastError
  });
});
app.get('/new-pairs', (_req, res) => res.json({ data: [...newPairs].slice(-100).reverse() }));
app.get('/whales', (req, res) => {
  const min = Number(req.query.min_buy_usd || MIN_TRADE_USD);
  res.json({ data: [...largeTrades].filter(t => tradeUsd(t) >= min).slice(-100).reverse() });
});
app.get('/_debug', (_req, res) => res.json({
  endpoints: { NP_URL, LT_URL }, lastPoll, lastError,
  sampleNP: pickFirstArray(lastRawNP).slice(0, 3),
  sampleLT: pickFirstArray(lastRawLT).slice(0, 3)
}));

app.listen(PORT, () => {
  console.log(`API on ${PORT}`);
  startPolling();
});

process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
