'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

// -------- ENV --------
const PORT = Number(process.env.PORT || 3000);
const BIRDEYE_KEY = String(process.env.BIRDEYE_KEY || '').trim();

// polling cadence (ms)
const POLL_MS       = Number(process.env.POLL_MS || 30000);
const PAIR_POLL_MS  = Number(process.env.PAIR_POLL_MS || 120000);
const TRADE_POLL_MS = Number(process.env.TRADE_POLL_MS || 60000);

// filters for whales (query param still wins)
const DEFAULT_MIN_BUY_USD = Number(process.env.DEFAULT_MIN_BUY_USD || 5000);

// endpoints
const NP_URL = process.env.NP_URL || 'https://public-api.birdeye.so/defi/tokenlist?chain=solana&sort_by=created_at&sort_type=desc&offset=0&limit=50';

// DexScreener trade feed candidates (no key required)
const DS_TRADE_CANDIDATES = [
  'https://api.dexscreener.com/latest/dex/trades?chain=solana&limit=100',
  'https://api.dexscreener.com/latest/dex/trades/solana?limit=100',
  'https://api.dexscreener.com/latest/dex/trades?limit=100'
];

// -------- APP --------
const app = express();
app.use(cors());

// ring buffers
const MAX_KEEP = 200;
const newPairs = [];
const largeTrades = [];

let health = {
  mode: 'rest+ds',       // birdeye for pairs, dexscreener for whales
  connected: true,
  endpoints: { NP_URL, LT_URL: 'dexscreener' },
  lastPoll: null,
  lastPairsPoll: 0,
  lastTradesPoll: 0,
  lastError: null,
  dsTradeUrl: null
};

function pushRing(arr, item) {
  arr.push(item);
  if (arr.length > MAX_KEEP) arr.shift();
}
function safeNum(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}
function hashObj(obj) {
  const raw =
    obj?.txHash ||
    obj?.signature ||
    obj?.tx ||
    obj?.pairAddress ||
    obj?.mint ||
    JSON.stringify(obj);
  return crypto.createHash('sha1').update(String(raw)).digest('hex');
}

// ------------ FETCH HELPERS -------------
async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok || (json && json.success === false)) {
    const msg = json?.message || text.slice(0, 200);
    throw new Error(`HTTP ${res.status} :: ${msg}`);
  }
  return json ?? { raw: text };
}

// ------------- PAIRS (Birdeye) --------------
async function pollPairs() {
  try {
    if (!BIRDEYE_KEY) throw new Error('Missing BIRDEYE_KEY');
    const headers = { 'X-API-KEY': BIRDEYE_KEY, 'Accept': 'application/json' };
    const obj = await fetchJson(NP_URL, headers);

    // pick an array from various shapes
    const arr =
      Array.isArray(obj) ? obj :
      Array.isArray(obj?.data) ? obj.data :
      Array.isArray(obj?.data?.items) ? obj.data.items :
      Array.isArray(obj?.items) ? obj.items :
      [];

    let added = 0;
    for (const p of arr) {
      // Only basic sanity: has address/mint/name
      const mint = p.address || p.mint || p.mintAddress;
      if (!mint) continue;
      const id = hashObj(mint);
      if (!newPairs.some(x => x.__id === id)) {
        const pack = {
          __id: id,
          address: mint,
          name: p.name || p.symbol || '',
          symbol: p.symbol || '',
          liquidityUSD: safeNum(p.liquidityUSD ?? p.liquidity_usd ?? p.liquidity),
          v24hUSD: safeNum(p.v24hUSD ?? p.volumeUsd24h ?? p.volume_usd_24h),
          t24h: safeNum(p.transaction_count_24h ?? p.trades24h ?? p.t24h),
          createdAt: p.created_at || p.createdAt || p.listedAt || p.added_time || null,
          raw: p
        };
        pushRing(newPairs, pack);
        added++;
      }
    }
    health.lastPairsPoll = Date.now();
    if (added) console.log(`pairs add +${added} (total ${newPairs.length})`);
  } catch (e) {
    health.lastError = `pairs: ${e.message}`;
    console.error('[pairs]', e.message);
  }
}

// ------------- WHALES (DexScreener) --------------
async function pickDsTradeUrl() {
  if (health.dsTradeUrl) return health.dsTradeUrl;
  for (const url of DS_TRADE_CANDIDATES) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (res.ok) {
        // quick parse just to validate shape
        await res.text();
        health.dsTradeUrl = url;
        console.log('[ds] trades OK ->', url);
        return url;
      }
    } catch {}
  }
  throw new Error('No working DexScreener trades endpoint');
}

function tradeUsdFromDs(t) {
  // DexScreener trades usually include priceUsd & baseAmount/quoteAmount
  const priceUsd = safeNum(t.priceUsd);
  const amountBase = safeNum(t.baseAmount);
  const amountQuote = safeNum(t.quoteAmount);
  const amountUsd =
    safeNum(t.amountUsd) ||
    (priceUsd && amountBase ? priceUsd * amountBase : 0);
  return amountUsd || (priceUsd && amountQuote ? priceUsd * amountQuote : 0);
}

async function pollTrades() {
  try {
    const url = await pickDsTradeUrl();
    const obj = await fetchJson(url, { 'Accept': 'application/json' });

    const arr =
      Array.isArray(obj?.trades) ? obj.trades :
      Array.isArray(obj?.data) ? obj.data :
      Array.isArray(obj) ? obj : [];

    let added = 0;
    for (const t of arr) {
      // Only keep Solana trades
      const chain = (t.chain || t.blockchain || '').toLowerCase();
      if (chain && chain !== 'solana') continue;

      const usd = tradeUsdFromDs(t);
      const pack = {
        __id: hashObj(t.txHash || t.txId || t.tx || JSON.stringify(t)),
        txHash: t.txHash || t.txId || t.tx || null,
        pairAddress: t.pairAddress || t.pair || null,
        side: (t.side || t.trade || '').toLowerCase(), // buy/sell if provided
        priceUsd: safeNum(t.priceUsd),
        amountBase: safeNum(t.baseAmount),
        amountQuote: safeNum(t.quoteAmount),
        amountUsd: usd,
        blockTime: t.blockTime || t.timestamp || null,
        raw: t
      };

      if (!largeTrades.some(x => x.__id === pack.__id)) {
        pushRing(largeTrades, pack);
        added++;
      }
    }
    health.lastTradesPoll = Date.now();
    if (added) console.log(`trades add +${added} (total ${largeTrades.length})`);
  } catch (e) {
    health.lastError = `trades: ${e.message}`;
    console.error('[trades]', e.message);
  }
}

// ------------- SCHEDULER --------------
setInterval(() => { pollPairs(); }, Math.max(PAIR_POLL_MS, POLL_MS));
setInterval(() => { pollTrades(); }, Math.max(TRADE_POLL_MS, POLL_MS));

// kick off
pollPairs();
pollTrades();

// ------------- HTTP API --------------
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    mode: health.mode,
    connected: health.connected,
    newPairs: newPairs.length,
    largeTrades: largeTrades.length,
    filters: { DEFAULT_MIN_BUY_USD },
    endpoints: health.endpoints,
    nextPolls: {
      pairsInMs: Math.max(0, (health.lastPairsPoll + PAIR_POLL_MS) - Date.now()),
      tradesInMs: Math.max(0, (health.lastTradesPoll + TRADE_POLL_MS) - Date.now())
    },
    lastPoll: new Date().toISOString(),
    lastError: health.lastError
  });
});

app.get('/new-pairs', (_req, res) => {
  res.json({ data: [...newPairs].slice(-100).reverse() });
});

app.get('/whales', (req, res) => {
  const min = Number(req.query.min_buy_usd || DEFAULT_MIN_BUY_USD || 0);
  const data = largeTrades.filter(t => safeNum(t.amountUsd) >= min);
  res.json({ data: data.slice(-100).reverse() });
});

// optional probes
app.get('/_probe/ds', async (_req, res) => {
  try {
    const url = await pickDsTradeUrl();
    const sample = await fetchJson(url, { 'Accept': 'application/json' });
    res.json({ url, sample: Array.isArray(sample?.trades) ? sample.trades.slice(0, 2) : sample });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log('API on', PORT);
});
