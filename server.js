'use strict';

const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');            // kept for future WS enable
const crypto = require('crypto');

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 3000);
const FEED_MODE = String(process.env.FEED_MODE || 'rest'); // 'rest' or 'ws'
const BIRDEYE_KEY = String(process.env.BIRDEYE_KEY || '').trim();

// REST endpoints, required for FEED_MODE=rest
const REST_NEW_PAIRS_URL = String(process.env.REST_NEW_PAIRS_URL || '').trim();
const REST_LARGE_TRADES_URL = String(process.env.REST_LARGE_TRADES_URL || '').trim();

// Optional REST tuning
const POLL_MS = Number(process.env.POLL_MS || 10_000);           // 10s
const MIN_LIQ_USD = Number(process.env.MIN_LIQ_USD || 0);
const MIN_LARGE_USD = Number(process.env.MIN_LARGE_USD || 0);

// ---------- APP ----------
const app = express();
app.use(cors());

// ---------- RING BUFFERS ----------
const MAX_KEEP = 200;
const newPairs = [];
const largeTrades = [];
let connected = false;

function pushRing(arr, item, max = MAX_KEEP) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

function dedupeKey(v) {
  // Try common fields, then stable JSON hash
  const sig = v?.txHash || v?.signature || v?.tx || v?.pairAddress || v?.mint || JSON.stringify(v);
  return crypto.createHash('sha1').update(String(sig)).digest('hex');
}

const seenPairs = new Set();
const seenTrades = new Set();

// ---------- REST POLLER ----------
async function restFetch(url) {
  const res = await fetch(url, {
    headers: {
      'X-API-KEY': BIRDEYE_KEY,
      'Accept': 'application/json'
    }
  });
  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} :: ${txt.slice(0, 200)}`);
  }
  try { return JSON.parse(txt); } catch { return { data: null, raw: txt }; }
}

async function pollOnce() {
  if (!BIRDEYE_KEY) {
    console.error('[REST] Missing BIRDEYE_KEY');
    return;
  }
  if (!REST_NEW_PAIRS_URL || !REST_LARGE_TRADES_URL) {
    console.error('[REST] Set REST_NEW_PAIRS_URL and REST_LARGE_TRADES_URL env vars');
    return;
  }

  try {
    // New Pairs
    const np = await restFetch(REST_NEW_PAIRS_URL);
    const npItems = Array.isArray(np?.data) ? np.data : Array.isArray(np) ? np : [];
    for (const it of npItems) {
      // Optional liquidity filter if field exists
      const liq = Number(it?.liquidityUSD || it?.liquidity_usd || 0);
      if (liq >= MIN_LIQ_USD) {
        const k = dedupeKey(it);
        if (!seenPairs.has(k)) {
          seenPairs.add(k);
          pushRing(newPairs, it);
        }
      }
    }

    // Large Trades
    const lt = await restFetch(REST_LARGE_TRADES_URL);
    const ltItems = Array.isArray(lt?.data) ? lt.data : Array.isArray(lt) ? lt : [];
    for (const it of ltItems) {
      const vol = Number(it?.volumeUSD || it?.volume_usd || it?.buy_usd || it?.sell_usd || 0);
      if (vol >= MIN_LARGE_USD) {
        const k = dedupeKey(it);
        if (!seenTrades.has(k)) {
          seenTrades.add(k);
          pushRing(largeTrades, it);
        }
      }
    }

    connected = true;
  } catch (e) {
    connected = false;
    console.error('[REST] poll error:', e.message || e);
  }
}

function startRest() {
  console.log('[REST] mode enabled, polling every', POLL_MS, 'ms');
  pollOnce();
  setInterval(pollOnce, POLL_MS);
}

// ---------- WS MODE (kept for later if you get WS-enabled key) ----------
let ws = null;
let candidateIndex = 0;
const WS_CANDIDATES = (key) => ([
  { url: 'wss://public-api.birdeye.so/socket/solana',
    headers: { 'x-api-key': key, 'x-chain': 'solana', 'Origin': 'https://app.birdeye.so', 'User-Agent': 'Mozilla/5.0' } },
  { url: 'wss://public-api.birdeye.so/socket?chain=solana',
    headers: { 'x-api-key': key, 'x-chain': 'solana', 'Origin': 'https://app.birdeye.so', 'User-Agent': 'Mozilla/5.0' } },
  { url: `wss://public-api.birdeye.so/socket/solana?x-api-key=${encodeURIComponent(key)}&chain=solana`,
    headers: { 'x-chain': 'solana', 'Origin': 'https://app.birdeye.so', 'User-Agent': 'Mozilla/5.0' } },
]);

function startWs() {
  if (!BIRDEYE_KEY) {
    console.error('Missing BIRDEYE_KEY env var. Set it in Render, then Manual Deploy.');
    return;
  }
  const list = WS_CANDIDATES(BIRDEYE_KEY);
  const pick = list[candidateIndex % list.length];
  console.log(`[WS] Connecting (candidate ${candidateIndex + 1}/${list.length}): ${pick.url}`);
  ws = new WebSocket(pick.url, { headers: pick.headers, perMessageDeflate: false, handshakeTimeout: 15000 });

  let pingTimer = null;

  ws.once('open', () => {
    connected = true;
    console.log('[WS] connected ✅');
    pingTimer = setInterval(() => { try { ws.ping(); } catch {} }, 20_000);
    ws.send(JSON.stringify({ type: 'SUBSCRIBE_NEW_PAIR',        min_liquidity: MIN_LIQ_USD }));
    ws.send(JSON.stringify({ type: 'SUBSCRIBE_LARGE_TRADE_TXS', min_volume:   MIN_LARGE_USD }));
  });

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg?.type === 'WELCOME') return;
    if (msg?.type === 'NEW_PAIR_DATA' && msg.data) pushRing(newPairs, msg.data);
    else if (msg?.type === 'TXS_LARGE_TRADE_DATA' && msg.data) pushRing(largeTrades, msg.data);
    else if (msg?.type === 'ERROR' || msg?.statusCode >= 400) console.error('[WS] server ERROR:', msg);
  });

  ws.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', c => { body += c.toString(); });
    res.on('end', () => {
      console.error(`[WS] unexpected response ${res.statusCode}`, { headers: res.headers, body: body ? body.slice(0, 800) : null });
      candidateIndex++;
      try { ws.close(); } catch {}
      setTimeout(startWs, 4000);
    });
  });

  ws.on('error', (err) => console.error('[WS] error:', err?.message || String(err)));
  ws.on('close', () => { if (pingTimer) clearInterval(pingTimer); connected = false; console.log('[WS] closed, reconnecting...'); setTimeout(startWs, 4000); });
}

// ---------- BOOT ----------
if (FEED_MODE === 'rest') startRest();
else startWs();

// ---------- HTTP ----------
const sliceLast = (arr, n = 100) => [...arr].slice(-n).reverse();

app.get('/', (_req, res) => {
  res.json({ ok: true, mode: FEED_MODE, connected, newPairs: newPairs.length, largeTrades: largeTrades.length });
});

app.get('/new-pairs', (_req, res) => {
  res.json({ data: sliceLast(newPairs) });
});

app.get('/whales', (req, res) => {
  const min = Number(req.query.min_buy_usd || 0);
  const data = sliceLast(largeTrades).filter(t => Number(t.volumeUSD || t.volume_usd || t.buy_usd || 0) >= min);
  res.json({ data });
});

app.listen(PORT, () => {
  console.log(`API on ${PORT}`);
});

process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
