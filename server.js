'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

// ENV
const PORT = Number(process.env.PORT || 3000);
const BIRDEYE_KEY = String(process.env.BIRDEYE_KEY || '').trim();

// Filters, tweak later
const MIN_LIQ_USD     = Number(process.env.MIN_LIQ_USD || 10000);
const MIN_TRADE_USD   = Number(process.env.MIN_TRADE_USD || 5000);
const MIN_24H_VOL_USD = Number(process.env.MIN_24H_VOL_USD || 50000);
const MIN_24H_TRADES  = Number(process.env.MIN_24H_TRADES || 50);
const MIN_AGE_MINUTES = Number(process.env.MIN_AGE_MINUTES || 10);

// Polling
const POLL_MS = Number(process.env.POLL_MS || 10000);

// App
const app = express();
app.use(cors());

// Buffers
const MAX_KEEP = 200;
const newPairs = [];
const largeTrades = [];
let connected = false;

function pushRing(a, v, m = MAX_KEEP) { a.push(v); if (a.length > m) a.shift(); }
function h(v) { const s = v?.txHash || v?.signature || v?.tx || v?.pairAddress || v?.mint || JSON.stringify(v); return crypto.createHash('sha1').update(String(s)).digest('hex'); }
const seenPairs = new Set();
const seenTrades = new Set();

// Candidate endpoints
// We expand token endpoints since your logs showed "sort_by invalid format".
const TOKEN_CANDIDATES = [
  // simplest
  'https://public-api.birdeye.so/defi/tokenlist?offset=0&limit=50&chain=solana',
  // common sorts Birdeye has used historically
  'https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=50&chain=solana',
  'https://public-api.birdeye.so/defi/tokenlist?sort_by=volume_usd_24h&sort_type=desc&offset=0&limit=50&chain=solana',
  'https://public-api.birdeye.so/defi/tokenlist?sort_by=liquidity_usd&sort_type=desc&offset=0&limit=50&chain=solana',
  // alt route some deployments expose
  'https://public-api.birdeye.so/public/tokenlist?offset=0&limit=50&chain=solana',
  // fallback guess for "new tokens"
  'https://public-api.birdeye.so/defi/new_tokens?offset=0&limit=50&chain=solana'
];

const TRADE_CANDIDATES = [
  'https://public-api.birdeye.so/defi/large_trades?chain=solana&offset=0&limit=50',
  'https://public-api.birdeye.so/defi/txs/large_trades?chain=solana&offset=0&limit=50',
  'https://public-api.birdeye.so/public/large_trades?chain=solana&offset=0&limit=50'
];

let NP_URL = null;
let LT_URL = null;
let backoffMs = 5000; // for 429s

async function fetchRaw(url) {
  return fetch(url, { headers: { 'X-API-KEY': BIRDEYE_KEY, 'Accept': 'application/json' } });
}

async function fetchJson(url) {
  const res = await fetchRaw(url);
  const txt = await res.text();
  // Treat JSON bodies like {success:false,message:"Not found"} as failures
  let obj = null;
  try { obj = JSON.parse(txt); } catch {}
  if (!res.ok || (obj && obj.success === false)) {
    const msg = obj?.message || txt.slice(0, 200);
    throw new Error(`HTTP ${res.status} :: ${msg}`);
  }
  return obj ?? { data: null, raw: txt };
}

async function findUrl(cands, label) {
  for (const url of cands) {
    try {
      const r = await fetchRaw(url);
      const body = await r.text();
      if (r.status === 429) {
        console.warn(`[REST] ${label} candidate 429 Too Many Requests -> ${url}`);
        continue;
      }
      if (!r.ok) {
        console.warn(`[REST] ${label} candidate ${r.status} -> ${url} :: ${body.slice(0, 120)}`);
        continue;
      }
      // If body says success:false, skip
      try {
        const j = JSON.parse(body);
        if (j && j.success === false) {
          console.warn(`[REST] ${label} candidate success:false -> ${url} :: ${j.message || 'no message'}`);
          continue;
        }
      } catch {}
      console.log(`[REST] ${label} OK -> ${url}`);
      return url;
    } catch (e) {
      console.warn(`[REST] ${label} candidate error -> ${url} :: ${e.message}`);
    }
  }
  throw new Error(`[REST] No working ${label} endpoint found`);
}

function toNum(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function minutesAgo(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

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

async function pollOnce() {
  if (!BIRDEYE_KEY) {
    console.error('[REST] Missing BIRDEYE_KEY');
    return;
  }
  try {
    if (!NP_URL) NP_URL = await findUrl(TOKEN_CANDIDATES, 'new-pairs');
    if (!LT_URL) LT_URL = await findUrl(TRADE_CANDIDATES, 'large-trades');

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
    backoffMs = 5000; // reset backoff on success
  } catch (e) {
    connected = false;
    console.error('[REST] poll error:', e.message || e);
    // If 429 anywhere, back off more to stop hammering
    if (String(e.message || '').includes('429')) {
      backoffMs = Math.min(backoffMs * 2, 120000);
      console.warn(`[REST] backing off due to 429. Next poll in ${backoffMs} ms`);
    }
    // clear URLs so we re-probe next time
    NP_URL = null;
    LT_URL = null;
  }
}

function startPolling() {
  console.log('[REST] mode enabled, polling every', POLL_MS, 'ms');
  pollOnce();
  setInterval(pollOnce, POLL_MS);
}

// HTTP
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
  const data = sliceLast(largeTrades).filter(t => {
    const usd = toNum(t.volumeUSD ?? t.volume_usd ?? t.buy_usd ?? t.sell_usd ?? 0);
    return usd >= min;
  });
  res.json({ data });
});

// Boot
app.listen(PORT, () => {
  console.log(`API on ${PORT}`);
  startPolling();
});

process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
