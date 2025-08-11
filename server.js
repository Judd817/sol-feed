'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 3000);
const BIRDEYE_KEY = String(process.env.BIRDEYE_KEY || '').trim();

// Softer defaults so you see data immediately
const MIN_LIQ_USD     = Number(process.env.MIN_LIQ_USD || 0);
const MIN_TRADE_USD   = Number(process.env.MIN_TRADE_USD || 1);
const MIN_24H_VOL_USD = Number(process.env.MIN_24H_VOL_USD || 0);
const MIN_24H_TRADES  = Number(process.env.MIN_24H_TRADES || 0);
const MIN_AGE_MINUTES = Number(process.env.MIN_AGE_MINUTES || 0);

// Polling
const POLL_MS = Number(process.env.POLL_MS || 10000);

// ---------- APP ----------
const app = express();
app.use(cors());

// ---------- BUFFERS ----------
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

function pushRing(arr, item, max = MAX_KEEP) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}
function hash(v) {
  const s = v?.txHash || v?.signature || v?.tx || v?.pairAddress || v?.mint || JSON.stringify(v);
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}
const seenPairs = new Set();
const seenTrades = new Set();

function toNum(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function minutesAgo(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

// ---------- REST helpers ----------
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

// Candidate endpoints
const TOKEN_CANDIDATES = [
  'https://public-api.birdeye.so/defi/tokenlist?offset=0&limit=50&chain=solana',
  'https://public-api.birdeye.so/public/tokenlist?offset=0&limit=50&chain=solana',
  'https://public-api.birdeye.so/tokenlist?offset=0&limit=50&chain=solana',
  'https://public-api.birdeye.so/defi/new_tokens?offset=0&limit=50&chain=solana'
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
      await r.text(); // consume for logging if needed
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

// ---------- tolerant array pickers ----------
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

// ---------- filters ----------
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

// detect USD size across many possible field names
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
  // fallback combo: size * price
  const qty = toNum(t?.amount ?? t?.size ?? t?.qty ?? 0);
  const px  = toNum(t?.price ?? t?.avgPrice ?? t?.p ?? 0);
  const v = qty * px;
  return Number.isFinite(v) ? v : 0;
}

function passTradeFilters(t) {
  return tradeUsd(t) >= MIN_TRADE_USD;
}

// ---------- poller ----------
async function pollOnce() {
  try {
    if (!BIRDEYE_KEY) throw new Error('Missing BIRDEYE_KEY');

    if (!NP_URL) NP_URL = await findUrl(TOKEN_CANDIDATES, 'new-pairs');
    if (!LT_URL) LT_URL = await findUrl(TRADE_CANDIDATES, 'large-trades');

    const np = await fetchJson(NP_URL);
    const lt = await fetchJson(LT_URL);

    lastRawNP = np;
    lastRawLT = lt;

    const npItems = pickFirstArray(np);
    const ltItems = pickFirstArray(lt);

    let addedPairs = 0;
    for (const it of npItems) {
      const key = hash(it);
      if (seenPairs.has(key)) continue;
      if (!passPairFilters(it)) continue;
      seenPairs.add(key);
      pushRing(newPairs, it);
      addedPairs++;
    }

    let addedTrades = 0;
    for (const it of ltItems) {
      const key = hash(it);
      if (seenTrades.has(key)) continue;
      if (!passTradeFilters(it)) continue;
      seenTrades.add(key);
      pushRing(largeTrades, it);
      addedTrades++;
    }

    connected = true;
    lastError = null;
    console.log(`[REST] poll ok: pairs+${addedPairs}, trades+${addedTrades}`);
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
  console.log('[REST] mode enabled, polling every', POLL_MS, 'ms');
  pollOnce();
  setInterval(pollOnce, POLL_MS);
}

// ---------- HTTP ----------
const sliceLast = (arr, n = 100) => [...arr].slice(-n).reverse();

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    mode: 'rest',
    connected,
    newPairs: newPairs.length,
    largeTrades: largeTrades.length,
    filters: { MIN_LIQ_USD, MIN_TRADE_USD, MIN_24H_VOL_USD, MIN_24H_TRADES, MIN_AGE_MINUTES },
    endpoints: { NP_URL, LT_URL },
    lastPoll,
    lastError
  });
});

app.get('/new-pairs', (_req, res) => {
  res.json({ data: sliceLast(newPairs) });
});

app.get('/whales', (req, res) => {
  const min = Number(req.query.min_buy_usd || MIN_TRADE_USD);
  const data = sliceLast(largeTrades).filter(t => tradeUsd(t) >= min);
  res.json({ data });
});

// Debug
app.get('/_debug', (_req, res) => {
  res.json({
    endpoints: { NP_URL, LT_URL },
    lastPoll, lastError,
    sampleNP: Array.isArray(lastRawNP?.data) ? lastRawNP.data.slice(0, 3) : lastRawNP?.data || lastRawNP,
    sampleLT: Array.isArray(lastRawLT?.data) ? lastRawLT.data.slice(0, 3) : lastRawLT?.data || lastRawLT
  });
});

// ---------- BOOT ----------
app.listen(PORT, () => {
  console.log(`API on ${PORT}`);
  startPolling();
});

process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
