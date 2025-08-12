'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { z } = require('zod');

// -------- ENV --------
const PORT = Number(process.env.PORT || 3000);
const BIRDEYE_KEY = String(process.env.BIRDEYE_KEY || '').trim();

const POLL_MS       = Number(process.env.POLL_MS || 30000);
const PAIR_POLL_MS  = Number(process.env.PAIR_POLL_MS || 120000);
const TRADE_POLL_MS = Number(process.env.TRADE_POLL_MS || 60000);

const DEFAULT_MIN_BUY_USD = Number(process.env.DEFAULT_MIN_BUY_USD || 5000);

// Endpoints
const NP_URL = process.env.NP_URL || 'https://public-api.birdeye.so/defi/tokenlist?chain=solana&sort_by=created_at&sort_type=desc&offset=0&limit=50';
// If you set LT_URL on Render, we will use it first, else try DexScreener
const LT_URL = process.env.LT_URL || '';

const DS_TRADE_CANDIDATES = [
  'https://api.dexscreener.com/latest/dex/trades?chain=solana&limit=100',
  'https://api.dexscreener.com/latest/dex/trades/solana?limit=100',
  'https://api.dexscreener.com/latest/dex/trades?limit=100'
];

// -------- APP --------
const app = express();
app.use(cors());

// ring buffers
const MAX_KEEP = 500;
const newPairs = [];
const largeTrades = [];

const health = {
  mode: 'rest',
  connected: true,
  endpoints: { NP_URL, LT_URL: LT_URL || 'dexscreener' },
  lastPoll: null,
  lastPairsPoll: 0,
  lastTradesPoll: 0,
  lastError: null,
  dsTradeUrl: null
};

// ---------- helpers ----------
function pushRing(arr, item, max = MAX_KEEP) {
  arr.push(item);
  if (arr.length > max) arr.shift();
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
async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  const txt = await res.text();
  let json = null;
  try { json = JSON.parse(txt); } catch {}
  if (!res.ok || (json && json.success === false)) {
    const msg = json?.message || txt.slice(0, 200);
    throw new Error(`HTTP ${res.status} :: ${msg}`);
  }
  return json ?? { raw: txt };
}
const nowIso = () => new Date().toISOString();

// ---------- PAIRS, Birdeye ----------
async function pollPairs() {
  try {
    if (!BIRDEYE_KEY) throw new Error('Missing BIRDEYE_KEY');
    const headers = { 'X-API-KEY': BIRDEYE_KEY, 'Accept': 'application/json' };
    const obj = await fetchJson(NP_URL, headers);
    const arr =
      Array.isArray(obj) ? obj :
      Array.isArray(obj?.data) ? obj.data :
      Array.isArray(obj?.data?.items) ? obj.data.items :
      Array.isArray(obj?.items) ? obj.items : [];

    let added = 0;
    for (const p of arr) {
      const mint = p.address || p.mint || p.mintAddress;
      if (!mint) continue;
      const id = hashObj(mint);
      if (!newPairs.some(x => x.__id === id)) {
        const created =
          Number(p.created_at || p.createdAt || p.listedAt || p.added_time) || null;

        const pack = {
          __id: id,
          address: String(mint),
          name: p.name || p.symbol || '',
          symbol: p.symbol || '',
          liquidityUSD: safeNum(p.liquidityUSD ?? p.liquidity_usd ?? p.liquidity),
          v24hUSD: safeNum(p.v24hUSD ?? p.volumeUsd24h ?? p.volume_usd_24h),
          t24h: safeNum(p.transaction_count_24h ?? p.trades24h ?? p.t24h),
          createdAtMs: created,
          createdAt: created ? new Date(created).toISOString() : null,
          raw: p
        };
        pushRing(newPairs, pack);
        added++;
      }
    }
    health.lastPairsPoll = Date.now();
    if (added) console.log(`pairs +${added} / ${newPairs.length}`);
  } catch (e) {
    health.lastError = `pairs: ${e.message}`;
    console.error('[pairs]', e.message);
  }
}

// ---------- WHALES via LT_URL or DexScreener ----------
async function pickDsTradeUrl() {
  if (health.dsTradeUrl) return health.dsTradeUrl;
  for (const url of DS_TRADE_CANDIDATES) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (res.ok) {
        await res.text();
        health.dsTradeUrl = url;
        return url;
      }
    } catch {}
  }
  throw new Error('No working DexScreener trades endpoint');
}

function tradeUsdFromDs(t) {
  const priceUsd = safeNum(t.priceUsd);
  const base = safeNum(t.baseAmount);
  const quote = safeNum(t.quoteAmount);
  const usd = safeNum(t.amountUsd) || (priceUsd && base ? priceUsd * base : 0);
  return usd || (priceUsd && quote ? priceUsd * quote : 0);
}

async function pollTrades() {
  try {
    let obj, source = '';
    if (LT_URL) {
      if (!BIRDEYE_KEY) throw new Error('Missing BIRDEYE_KEY for LT_URL');
      obj = await fetchJson(LT_URL, { 'X-API-KEY': BIRDEYE_KEY, 'Accept': 'application/json' });
      source = 'birdeye';
    } else {
      const url = await pickDsTradeUrl();
      obj = await fetchJson(url, { 'Accept': 'application/json' });
      source = 'dexscreener';
    }

    const arr =
      Array.isArray(obj?.trades) ? obj.trades :
      Array.isArray(obj?.data) ? obj.data :
      Array.isArray(obj) ? obj : [];

    let added = 0;
    for (const t of arr) {
      // normalize fields
      const chain = (t.chain || t.blockchain || '').toLowerCase();
      if (chain && chain !== 'solana') continue;

      const ts = Number(t.blockTime || t.timestamp || t.ts || 0) || Date.now();
      const side = (t.side || t.trade || t.type || '').toLowerCase();
      const sym = t.baseSymbol || t.baseToken || t.symbol || '';
      const pairAddr = t.pairAddress || t.pair || t.marketAddress || null;
      const txh = t.txHash || t.txId || t.tx || null;

      const pack = {
        __id: hashObj(txh || JSON.stringify(t)),
        txHash: txh,
        pairAddress: pairAddr,
        token: sym,
        side: side === 'buy' || side === 'sell' ? side : null,
        priceUsd: safeNum(t.priceUsd),
        amountBase: safeNum(t.baseAmount),
        amountQuote: safeNum(t.quoteAmount),
        amountUsd: tradeUsdFromDs(t),
        blockTimeMs: ts,
        blockTime: new Date(ts).toISOString(),
        src: source,
        raw: t
      };

      if (!largeTrades.some(x => x.__id === pack.__id)) {
        pushRing(largeTrades, pack);
        added++;
      }
    }
    health.lastTradesPoll = Date.now();
    if (added) console.log(`trades +${added} / ${largeTrades.length}`);
  } catch (e) {
    health.lastError = `trades: ${e.message}`;
    console.error('[trades]', e.message);
  }
}

// ---------- scheduler ----------
setInterval(pollPairs, Math.max(PAIR_POLL_MS, POLL_MS));
setInterval(pollTrades, Math.max(TRADE_POLL_MS, POLL_MS));
pollPairs();
pollTrades();

// ---------- validation ----------
const commonPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(), // base64 of {k:id or ts, id}
  sort: z.enum(['asc', 'desc']).default('desc')
});
const whalesQuerySchema = commonPageSchema.extend({
  min_buy_usd: z.coerce.number().min(0).default(DEFAULT_MIN_BUY_USD),
  side: z.enum(['buy', 'sell']).optional(),
  token: z.string().trim().min(1).max(50).optional(),
  pair: z.string().trim().min(3).max(200).optional(),
  since: z.coerce.number().optional(),  // ms epoch
  until: z.coerce.number().optional()   // ms epoch
});
const pairsQuerySchema = commonPageSchema.extend({
  min_liquidity_usd: z.coerce.number().min(0).default(0),
  min_v24h_usd: z.coerce.number().min(0).default(0),
  symbol: z.string().trim().min(1).max(50).optional(),
  since: z.coerce.number().optional(),
  until: z.coerce.number().optional()
});

// ---------- pagination helpers ----------
function encodeCursor(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function decodeCursor(s) {
  try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); }
  catch { return null; }
}
function pageBy(arr, keyFn, { limit, sort, cursor }) {
  const sorted = [...arr].sort((a, b) => {
    const ka = keyFn(a), kb = keyFn(b);
    if (ka === kb) return a.__id.localeCompare(b.__id) * (sort === 'asc' ? 1 : -1);
    return (ka - kb) * (sort === 'asc' ? 1 : -1);
  });

  let start = 0;
  if (cursor) {
    const c = decodeCursor(cursor);
    if (c && c.k != null && c.id) {
      start = sorted.findIndex(x => keyFn(x) === c.k && x.__id === c.id) + 1;
      if (start < 0) start = 0;
    }
  }

  const slice = sorted.slice(start, start + limit);
  const last = slice[slice.length - 1];
  const nextCursor = last ? encodeCursor({ k: keyFn(last), id: last.__id }) : null;
  return { items: slice, nextCursor };
}

// ---------- error wrapper ----------
function handleRoute(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      res.status(400).json({
        ok: false,
        error: String(e.message || e),
        time: nowIso()
      });
    }
  };
}

// ---------- routes ----------
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    mode: health.mode,
    connected: health.connected,
    counts: { newPairs: newPairs.length, largeTrades: largeTrades.length },
    filters: { DEFAULT_MIN_BUY_USD },
    endpoints: health.endpoints,
    nextPolls: {
      pairsInMs: Math.max(0, (health.lastPairsPoll + PAIR_POLL_MS) - Date.now()),
      tradesInMs: Math.max(0, (health.lastTradesPoll + TRADE_POLL_MS) - Date.now())
    },
    lastPoll: nowIso(),
    lastError: health.lastError
  });
});

app.get('/new-pairs', handleRoute((req, res) => {
  const q = pairsQuerySchema.parse(req.query);

  let data = newPairs.filter(p => {
    if (q.symbol && !(p.symbol?.toLowerCase().includes(q.symbol.toLowerCase()) || p.name?.toLowerCase().includes(q.symbol.toLowerCase()))) return false;
    if (p.liquidityUSD < q.min_liquidity_usd) return false;
    if (p.v24hUSD < q.min_v24h_usd) return false;
    if (q.since && (p.createdAtMs ?? 0) < q.since) return false;
    if (q.until && (p.createdAtMs ?? 0) > q.until) return false;
    return true;
  });

  const { items, nextCursor } = pageBy(data, x => x.createdAtMs || 0, q);

  res.json({
    ok: true,
    data: items,
    page: { limit: q.limit, sort: q.sort, nextCursor },
    time: nowIso()
  });
}));

app.get('/whales', handleRoute((req, res) => {
  const q = whalesQuerySchema.parse(req.query);

  let data = largeTrades.filter(t => {
    if (safeNum(t.amountUsd) < q.min_buy_usd) return false;
    if (q.side && t.side !== q.side) return false;
    if (q.token && !(t.token || '').toLowerCase().includes(q.token.toLowerCase())) return false;
    if (q.pair && !(t.pairAddress || '').toLowerCase().includes(q.pair.toLowerCase())) return false;
    if (q.since && (t.blockTimeMs || 0) < q.since) return false;
    if (q.until && (t.blockTimeMs || 0) > q.until) return false;
    return true;
  });

  const { items, nextCursor } = pageBy(data, x => x.blockTimeMs || 0, q);

  res.json({
    ok: true,
    data: items,
    page: { limit: q.limit, sort: q.sort, nextCursor },
    filters: { min_buy_usd: q.min_buy_usd, side: q.side || null, token: q.token || null, pair: q.pair || null },
    time: nowIso()
  });
}));

// probes
app.get('/_probe/ds', handleRoute(async (_req, res) => {
  const url = await pickDsTradeUrl();
  const sample = await fetchJson(url, { 'Accept': 'application/json' });
  res.json({ ok: true, url, sample: Array.isArray(sample?.trades) ? sample.trades.slice(0, 2) : sample, time: nowIso() });
}));

// ---------- OpenAPI for RapidAPI ----------
const openapi = {
  openapi: '3.0.3',
  info: { title: 'Sol Feed API', version: '1.0.0', description: 'Solana new pairs and whale trades.' },
  servers: [{ url: 'https://sol-feed.onrender.com' }],
  paths: {
    '/new-pairs': {
      get: {
        summary: 'List recent new token pairs',
        parameters: [
          { name: 'min_liquidity_usd', in: 'query', schema: { type: 'number', minimum: 0 }, required: false },
          { name: 'min_v24h_usd', in: 'query', schema: { type: 'number', minimum: 0 }, required: false },
          { name: 'symbol', in: 'query', schema: { type: 'string' }, required: false },
          { name: 'since', in: 'query', schema: { type: 'integer' }, required: false },
          { name: 'until', in: 'query', schema: { type: 'integer' }, required: false },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 }, required: false },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, required: false },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc','desc'] }, required: false }
        ],
        responses: { '200': { description: 'OK' } }
      }
    },
    '/whales': {
      get: {
        summary: 'List large trades',
        parameters: [
          { name: 'min_buy_usd', in: 'query', schema: { type: 'number', minimum: 0 }, required: false },
          { name: 'side', in: 'query', schema: { type: 'string', enum: ['buy','sell'] }, required: false },
          { name: 'token', in: 'query', schema: { type: 'string' }, required: false },
          { name: 'pair', in: 'query', schema: { type: 'string' }, required: false },
          { name: 'since', in: 'query', schema: { type: 'integer' }, required: false },
          { name: 'until', in: 'query', schema: { type: 'integer' }, required: false },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 }, required: false },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, required: false },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc','desc'] }, required: false }
        ],
        responses: { '200': { description: 'OK' } }
      }
    }
  }
};
app.get('/openapi.json', (_req, res) => res.json(openapi));
app.get('/docs', (_req, res) => {
  res.json({
    ok: true,
    quickstart: {
      whales: '/whales?min_buy_usd=10000&limit=50',
      whales_next: 'use page.nextCursor as ?cursor=...',
      pairs: '/new-pairs?min_liquidity_usd=20000&limit=50'
    },
    schema: '/openapi.json',
    time: nowIso()
  });
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`API on ${PORT}`);
});
