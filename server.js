'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

// -------- ENV --------
const PORT = Number(process.env.PORT || 3000);
const BIRDEYE_KEY = String(process.env.BIRDEYE_KEY || '').trim();

// Filters, tweak as needed
const MIN_LIQ_USD     = Number(process.env.MIN_LIQ_USD || 10000);
const MIN_TRADE_USD   = Number(process.env.MIN_TRADE_USD || 5000);
const MIN_24H_VOL_USD = Number(process.env.MIN_24H_VOL_USD || 50000);
const MIN_24H_TRADES  = Number(process.env.MIN_24H_TRADES || 50);
const MIN_AGE_MINUTES = Number(process.env.MIN_AGE_MINUTES || 10);

// Polling
const POLL_MS = Number(process.env.POLL_MS || 10000);

// -------- APP --------
const app = express();
app.use(cors());

// -------- BUFFERS --------
const MAX_KEEP = 200;
const newPairs = [];
const largeTrades = [];
let connected = false;

function pushRing(arr, item, max = MAX_KEEP) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}
function h(v) {
  const sig = v?.txHash || v?.signature || v?.tx || v?.pairAddress || v?.mint || JSON.stringify(v);
  return crypto.createHash('sha1').update(String(sig)).digest('hex');
}
const seenPairs = new Set();
const seenTrades = new Set();

// -------- Birdeye REST candidates --------
// We will try these in order until one returns 200 OK.
const NP_CANDIDATES = [
  // most likely
  'https://public-api.birdeye.so/defi/tokenlist?sort_by=created_at&sort_type=desc&offset=0&limit=50&chain=solana',
  'https://public-api.birdeye.so/public/tokenlist?sort_by=created_at&sort_type=desc&offset=0&limit=50&chain=solana',
  'https://public-api.birdeye.so/tokenlist?sort_by=created_at&sort_type=desc&offset=0&limit=50&chain=solana',
];

const LT_CANDIDATES = [
  // most likely
  'https://public-api.birdeye.so/defi/large_trades?chain=solana&offset=0&limit=50',
  'https://public-api.birdeye.so/public/large_trades?chain=solana&offset=0&limit=50',
  'https://public-api.birdeye.so/large_trades?chain=solana&offset=0&limit=50',
];

let NP_URL = null;
let LT_URL = null;

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'Accept': 'application/json' }
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${txt.slice(0,200)}`);
  try { return JSON.parse(txt); } catch { return { data: null, raw: txt }; }
}

async function findWorkingUrl(candidates, label) {
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { 'X-API-KEY': BIRDEYE_KEY } });
      if (res.ok) {
        console.log(`[REST] ${label} OK -> ${url}`);
        return url;
      }
      const body = await res.text();
      console.error(`[REST] ${label} candidate ${res.status} :: ${url} :: ${body.slice(0,120)}`);
    } catch (e) {
      console.error(`[REST] ${label} candidate error :: ${url} :: ${e.message}`);
    }
  }
  throw new Error(`[REST] No working ${label} endpoint found`);
}

function toNum(x, d=0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function minutesAgo(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

// -------- FILTERS --------
function passPairFilters(p) {
  const liq      = toNum(p.liquidityUSD ?? p.liquidity_usd ?? 0);
  const vol24    = toNum(p.volumeUsd24h ?? p.volume_usd_24h ?? p.v24hUsd ?? 0);
  const trades24 = toNum(p.transaction_count_24h ?? p.trades24h ?? 0);
  const created  = p.created_at ?? p.createdAt ?? p.listedAt ?? p.added_time;

  if (liq < MIN_LIQ_USD) return false;
  if (vol24 < MIN_24H_VOL_USD) return false;
  if (trades24 < MIN_24H_TRADES) return false;
  if (minutesAgo(created) < MIN_AGE_MINUTES) return false;
  return true;
}
function passTradeFilters(t) {
  const usd = toNum(t.volumeUSD ?? t.volume_usd ?? t.buy_usd ?? t.sell_usd ?? 0);
  return usd >= MIN_TRADE_USD;
}

// -------- POLLER --------
async function pollOnce() {
  if (!BIRDEYE_KEY) {
    console.error('[REST] Missing BIRDEYE_KEY');
    return;
  }
  try {
    if (!NP_URL) NP_URL = await findWorkingUrl(NP_CANDIDATES, 'new-pairs');
    if (!LT_URL) LT_URL = await findWorkingUrl(LT_CANDIDATES, 'large-trades');

    const np = await fetchJson(NP_URL);
    const lt = await fetchJson(LT_URL);

    const npItems = Array.isArray(np?.data) ? np.data : Array.isArray(np) ? np : [];
    for (const it of npItems) {
      const key = h(it);
      if (seenPairs.has(key)) continue;
      if (!passPairFilters(it)) continue;
      seenPairs.add(key);
      pushRing(newPairs, it);
    }

    const ltItems = Array.isArray(lt?.data) ? lt.data : Array.isArray(lt) ? lt : [];
    for (const it of ltItems) {
      const key = h(it);
      if (seenTrades.has(key)) continue;
      if (!passTradeFilters(it)) continue;
      seenTrades.add(key);
      pushRing(largeTrades, it);
    }

    connected = true;
  } catch (e) {
    connected = false;
    console.error('[REST] poll error:', e.message || e);
    // reset URLs so we retry candidates next loop
    NP_URL = null;
    LT_URL = null;
  }
}

function startPolling() {
  console.log('[REST] mode enabled, polling every', POLL_MS, 'ms');
  pollOnce();
  setInterval(pollOnce, POLL_MS);
}

// -------- HTTP --------
const sliceLast = (arr, n = 100) => [...arr].slice(-n).reverse();

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    mode: 'rest',
    connected,
    newPairs: newPairs.length,
    largeTrades: largeTrades.length,
    filters: { MIN_LIQ_USD, MIN_TRADE_USD, MIN_24H_VOL_USD, MIN_24H_TRADES, MIN_AGE_MINUTES },
    endpoints: { NP_URL, LT_URL }
  });
});

app.get('/new-pairs', (_req, res) => {
  res.json({ data: sliceLast(newPairs) });
});

app.get('/whales', (req, res) => {
  const min = Number(req.query.min_buy_usd || MIN_TRADE_USD);
  const data = sliceLast(largeTrades).filter(t => toNum(t.volumeUSD ?? t.volume_usd ?? t.buy_usd ?? 0) >= min);
  res.json({ data });
});

// -------- BOOT --------
app.listen(PORT, () => {
  console.log(`API on ${PORT}`);
  startPolling();
});

process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
