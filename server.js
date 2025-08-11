'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

// ----- ENV -----
const PORT = Number(process.env.PORT || 3000);
const BIRDEYE_KEY = String(process.env.BIRDEYE_KEY || '').trim();
const REST_NEW_PAIRS_URL = String(process.env.REST_NEW_PAIRS_URL || '').trim();
const REST_LARGE_TRADES_URL = String(process.env.REST_LARGE_TRADES_URL || '').trim();

// Filters
const MIN_LIQ_USD      = Number(process.env.MIN_LIQ_USD || 10000);
const MIN_TRADE_USD    = Number(process.env.MIN_TRADE_USD || 5000);
const MIN_24H_VOL_USD  = Number(process.env.MIN_24H_VOL_USD || 50000);
const MIN_24H_TRADES   = Number(process.env.MIN_24H_TRADES || 50);
const MIN_AGE_MINUTES  = Number(process.env.MIN_AGE_MINUTES || 10);

// Polling
const POLL_MS = Number(process.env.POLL_MS || 10000);

// ----- APP -----
const app = express();
app.use(cors());

// ----- BUFFERS -----
const MAX_KEEP = 200;
const newPairs = [];
const largeTrades = [];
let connected = false;

function pushRing(arr, item, max = MAX_KEEP) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}
function hashKey(v) {
  const sig = v?.txHash || v?.signature || v?.tx || v?.pairAddress || v?.mint || JSON.stringify(v);
  return crypto.createHash('sha1').update(String(sig)).digest('hex');
}
const seenPairs = new Set();
const seenTrades = new Set();

// ----- HELPERS -----
async function restFetch(url) {
  const res = await fetch(url, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'Accept': 'application/json' }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${text.slice(0,200)}`);
  try { return JSON.parse(text); } catch { return { data: null, raw: text }; }
}
function toNum(x, d=0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function minutesAgo(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

// ----- FILTERS -----
function passPairFilters(p) {
  // Birdeye fields vary, try common names
  const liq = toNum(p.liquidityUSD ?? p.liquidity_usd ?? 0);
  const vol24 = toNum(p.volumeUsd24h ?? p.volume_usd_24h ?? p.v24hUsd ?? 0);
  const trades24 = toNum(p.transaction_count_24h ?? p.trades24h ?? 0);
  const createdAt = p.created_at ?? p.createdAt ?? p.listedAt ?? p.added_time;

  if (liq < MIN_LIQ_USD) return false;
  if (vol24 < MIN_24H_VOL_USD) return false;
  if (trades24 < MIN_24H_TRADES) return false;
  if (minutesAgo(createdAt) < MIN_AGE_MINUTES) return false;
  return true;
}
function passTradeFilters(t) {
  const usd = toNum(t.volumeUSD ?? t.volume_usd ?? t.buy_usd ?? t.sell_usd ?? 0);
  return usd >= MIN_TRADE_USD;
}

// ----- POLLER -----
async function pollOnce() {
  if (!BIRDEYE_KEY || !REST_NEW_PAIRS_URL || !REST_LARGE_TRADES_URL) {
    console.error('[REST] Missing env vars. Need BIRDEYE_KEY, REST_NEW_PAIRS_URL, REST_LARGE_TRADES_URL');
    return;
  }

  try {
    // New pairs
    const np = await restFetch(REST_NEW_PAIRS_URL);
    const listPairs = Array.isArray(np?.data) ? np.data : Array.isArray(np) ? np : [];
    for (const it of listPairs) {
      const key = hashKey(it);
      if (seenPairs.has(key)) continue;
      if (!passPairFilters(it)) continue;
      seenPairs.add(key);
      pushRing(newPairs, it);
    }

    // Large trades
    const lt = await restFetch(REST_LARGE_TRADES_URL);
    const listTrades = Array.isArray(lt?.data) ? lt.data : Array.isArray(lt) ? lt : [];
    for (const it of listTrades) {
      const key = hashKey(it);
      if (seenTrades.has(key)) continue;
      if (!passTradeFilters(it)) continue;
      seenTrades.add(key);
      pushRing(largeTrades, it);
    }

    connected = true;
  } catch (e) {
    connected = false;
    console.error('[REST] poll error:', e.message || e);
  }
}

function startPolling() {
  console.log('[REST] polling every', POLL_MS, 'ms');
  pollOnce();
  setInterval(pollOnce, POLL_MS);
}

// ----- HTTP -----
const sliceLast = (arr, n = 100) => [...arr].slice(-n).reverse();

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    mode: 'rest',
    connected,
    newPairs: newPairs.length,
    largeTrades: largeTrades.length,
    filters: {
      MIN_LIQ_USD, MIN_TRADE_USD, MIN_24H_VOL_USD, MIN_24H_TRADES, MIN_AGE_MINUTES
    }
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

// ----- BOOT -----
app.listen(PORT, () => {
  console.log(`API on ${PORT}`);
  startPolling();
});

// safety
process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
