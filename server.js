'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { z } = require('zod');

/* ------------ ENV ------------ */
const PORT = Number(process.env.PORT || 3000);
const BIRDEYE_KEY = String(process.env.BIRDEYE_KEY || '').trim();

/* base cadences, ms */
const POLL_MS       = Number(process.env.POLL_MS || 30000);
const PAIR_POLL_MS  = Number(process.env.PAIR_POLL_MS || 180000);
const TRADE_POLL_MS = Number(process.env.TRADE_POLL_MS || 180000);

/* whales default filter */
const DEFAULT_MIN_BUY_USD = Number(process.env.DEFAULT_MIN_BUY_USD || 5000);

/* external endpoints */
const NP_URL = process.env.NP_URL || 'https://public-api.birdeye.so/defi/tokenlist?chain=solana&sort_by=created_at&sort_type=desc&offset=0&limit=50';
const LT_URL = process.env.LT_URL || '';

/* DexScreener fallbacks for trades */
const DS_TRADE_CANDIDATES = [
  'https://api.dexscreener.com/latest/dex/trades?chain=solana&limit=100',
  'https://api.dexscreener.com/latest/dex/trades/solana?limit=100',
  'https://api.dexscreener.com/latest/dex/trades?limit=100'
];

/* backoff limits */
const INITIAL_BACKOFF_MS = Number(process.env.INITIAL_BACKOFF_MS || 30000);
const MAX_BACKOFF_MS     = Number(process.env.MAX_BACKOFF_MS || 900000); // 15 min

/* ------------ APP ------------ */
const app = express();
app.use(cors());

/* ring buffers */
const MAX_KEEP = 500;
const newPairs = [];
const largeTrades = [];

/* health + limiter state */
const health = {
  mode: 'rest',
  connected: true,
  counts: { newPairs: 0, largeTrades: 0 },
  filters: { DEFAULT_MIN_BUY_USD },
  endpoints: { NP_URL, LT_URL: LT_URL || 'dexscreener' },
  nextPolls: { pairsInMs: 0, tradesInMs: 0 },
  lastPoll: null,
  lastError: null,
  limiter: {
    pairs:  { baseMs: PAIR_POLL_MS, nextAt: 0, backoffMs: 0, etag: null, lastStatus: null },
    trades: { baseMs: TRADE_POLL_MS, nextAt: 0, backoffMs: 0, etag: null, lastStatus: null, src: LT_URL ? 'birdeye' : 'dexscreener' }
  },
  dsTradeUrl: null
};

/* ------------ helpers ------------ */
function pushRing(arr, item, max = MAX_KEEP) { arr.push(item); if (arr.length > max) arr.shift(); }
function safeNum(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function hashObj(obj) {
  const raw = obj?.txHash || obj?.signature || obj?.tx || obj?.pairAddress || obj?.mint || JSON.stringify(obj);
  return crypto.createHash('sha1').update(String(raw)).digest('hex');
}
const nowIso = () => new Date().toISOString();
const jitter = (ms, pct = 0.15) => {
  const span = ms * pct;
  return Math.floor((Math.random() * span * 2) - span);
};
function parseRetryAfter(h) {
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const when = Date.parse(h);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}
function shouldThrottle(key) {
  return Date.now() < (health.limiter[key].nextAt || 0);
}
function onSuccess(key) {
  const lim = health.limiter[key];
  lim.backoffMs = 0;
  lim.nextAt = Date.now() + lim.baseMs + jitter(lim.baseMs, 0.20);
}
function onBackoff(key, retryAfterMs) {
  const lim = health.limiter[key];
  if (retryAfterMs && retryAfterMs > 0) {
    lim.backoffMs = Math.min(retryAfterMs, MAX_BACKOFF_MS);
  } else {
    lim.backoffMs = lim.backoffMs ? Math.min(lim.backoffMs * 2, MAX_BACKOFF_MS) : INITIAL_BACKOFF_MS;
  }
  lim.nextAt = Date.now() + lim.backoffMs + jitter(lim.backoffMs, 0.20);
}
async function fetchSmart(url, key, extraHeaders = {}) {
  const lim = health.limiter[key];
  const headers = { 'Accept': 'application/json', ...extraHeaders };
  if (lim.etag) headers['If-None-Match'] = lim.etag;

  const res = await fetch(url, { headers });
  lim.lastStatus = res.status;

  const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
  const etag = res.headers.get('etag');
  if (etag) lim.etag = etag;

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  return { ok: res.ok, status: res.status, retryAfter, json, text };
}

/* ------------ PAIRS, Birdeye ------------ */
async function pollPairs() {
  try {
    if (shouldThrottle('pairs')) return;
    if (!BIRDEYE_KEY) throw new Error('Missing BIRDEYE_KEY');

    const r = await fetchSmart(NP_URL, 'pairs', { 'X-API-KEY': BIRDEYE_KEY });
    if (r.status === 304) { onSuccess('pairs'); return; }
    if (!r.ok) {
      if (r.status === 429 || r.status >= 500) onBackoff('pairs', r.retryAfter);
      else onSuccess('pairs');
      throw new Error(`pairs HTTP ${r.status}`);
    }

    const arr =
      Array.isArray(r.json) ? r.json :
      Array.isArray(r.json?.data) ? r.json.data :
      Array.isArray(r.json?.data?.items) ? r.json.data.items :
      Array.isArray(r.json?.items) ? r.json.items : [];

    let added = 0;
    for (const p of arr) {
      const mint = p.address || p.mint || p.mintAddress;
      if (!mint) continue;
      const id = hashObj(mint);
      if (!newPairs.some(x => x.__id === id)) {
        const created = Number(p.created_at || p.createdAt || p.listedAt || p.added_time) || null;
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

    health.counts.newPairs = newPairs.length;
    onSuccess('pairs');
  } catch (e) {
    health.lastError = String(e.message || e);
  } finally {
    health.nextPolls.pairsInMs = Math.max(0, (health.limiter.pairs.nextAt || 0) - Date.now());
  }
}

/* ------------ TRADES via Birdeye or DexScreener ------------ */
async function pickDsTradeUrl() {
  if (health.dsTradeUrl) return health.dsTradeUrl;
  for (const url of DS_TRADE_CANDIDATES) {
    try {
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (r.ok) {
        await r.text(); // just warm up
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
    if (shouldThrottle('trades')) return;

    let r, source = '';
    if (LT_URL) {
      if (!BIRDEYE_KEY) throw new Error('Missing BIRDEYE_KEY');
      r = await fetchSmart(LT_URL, 'trades', { 'X-API-KEY': BIRDEYE_KEY, 'Accept': 'application/json' });
      source = 'birdeye';
      if (!r.ok && r.status === 404) {
        // fallback immediately to DexScreener if Birdeye path is wrong
        const url = await pickDsTradeUrl();
        r = await fetchSmart(url, 'trades', { 'Accept': 'application/json' });
        source = 'dexscreener';
      }
    } else {
      const url = await pickDsTradeUrl();
      r = await fetchSmart(url, 'trades', { 'Accept': 'application/json' });
      source = 'dexscreener';
    }

    if (r.status === 304) { onSuccess('trades'); return; }
    if (!r.ok) {
      if (r.status === 429 || r.status >= 500) onBackoff('trades', r.retryAfter);
      else onSuccess('trades');
      throw new Error(`trades HTTP ${r.status}`);
    }

    const arr =
      Array.isArray(r.json?.trades) ? r.json.trades :
      Array.isArray(r.json?.data) ? r.json.data :
      Array.isArray(r.json) ? r.json : [];

    let added = 0;
    for (const t of arr) {
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

    health.counts.largeTrades = largeTrades.length;
    onSuccess('trades');
  } catch (e) {
    health.lastError = String(e.message || e);
  } finally {
    health.nextPolls.tradesInMs = Math.max(0, (health.limiter.trades.nextAt || 0) - Date.now());
  }
}

/* ------------ scheduler ------------ */
/* trigger on intervals, throttle is enforced in the pollers */
setInterval(pollPairs, Math.max(PAIR_POLL_MS, POLL_MS));
setInterval(pollTrades, Math.max(TRADE_POLL_MS, POLL_MS));
pollPairs();
pollTrades();

/* ------------ validation, pagination, routes ------------ */
const commonPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  sort: z.enum(['asc', 'desc']).default('desc')
});
const whalesQuerySchema = commonPageSchema.extend({
  min_buy_usd: z.coerce.number().min(0).default(DEFAULT_MIN_BUY_USD),
  side: z.enum(['buy', 'sell']).optional(),
  token: z.string().trim().min(1).max(50).optional(),
  pair: z.string().trim().min(3).max(200).optional(),
  since: z.coerce.number().optional(),
  until: z.coerce.number().optional()
});
const pairsQuerySchema = commonPageSchema.extend({
  min_liquidity_usd: z.coerce.number().min(0).default(0),
  min_v24h_usd: z.coerce.number().min(0).default(0),
  symbol: z.string().trim().min(1).max(50).optional(),
  since: z.coerce.number().optional(),
  until: z.coerce.number().optional()
});
function encodeCursor(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function decodeCursor(s) { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { return null; } }
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
function handleRoute(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (e) { res.status(400).json({ ok: false, error: String(e.message || e), time: nowIso() }); }
  };
}

/* health */
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    mode: health.mode,
    connected: health.connected,
    counts: { newPairs: newPairs.length, largeTrades: largeTrades.length },
    filters: { DEFAULT_MIN_BUY_USD },
    endpoints: health.endpoints,
    limiter: {
      pairs:  { nextAt: health.limiter.pairs.nextAt, backoffMs: health.limiter.pairs.backoffMs, lastStatus: health.limiter.pairs.lastStatus },
      trades: { nextAt: health.limiter.trades.nextAt, backoffMs: health.limiter.trades.backoffMs, lastStatus: health.limiter.trades.lastStatus, src: health.limiter.trades.src }
    },
    nextPolls: {
      pairsInMs: Math.max(0, (health.limiter.pairs.nextAt || 0) - Date.now()),
      tradesInMs: Math.max(0, (health.limiter.trades.nextAt || 0) - Date.now())
    },
    lastPoll: nowIso(),
    lastError: health.lastError
  });
});

/* new pairs */
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
  res.json({ ok: true, data: items, page: { limit: q.limit, sort: q.sort, nextCursor }, time: nowIso() });
}));

/* whales */
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

/* probes */
app.get('/_probe/ds', handleRoute(async (_req, res) => {
  const url = await pickDsTradeUrl();
  const sample = await fetch(url, { headers: { 'Accept': 'application/json' } }).then(r => r.json()).catch(() => null);
  res.json({ ok: true, url, sample, time: nowIso() });
}));

/* start */
app.listen(PORT, () => { console.log(`API on ${PORT}`); });
