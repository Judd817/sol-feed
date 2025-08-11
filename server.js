'use strict';

const express   = require('express');
const cors      = require('cors');
const WebSocket = require('ws');

// ----- ENV -----
const PORT          = Number(process.env.PORT || 3000);
const BIRDEYE_KEY   = String(process.env.BIRDEYE_KEY || '').trim();
const MIN_LIQ_USD   = Number(process.env.MIN_LIQ_USD || 0);
const MIN_LARGE_USD = Number(process.env.MIN_LARGE_USD || 0);

// ----- APP -----
const app = express();
app.use(cors());

// ----- RING BUFFERS -----
const MAX_KEEP    = 200;
const newPairs    = [];
const largeTrades = [];
let   connected   = false;

function pushRing(arr, item, max = MAX_KEEP) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

// ----- WS CONNECT (multi URL styles + diagnostic on 4xx) -----
let ws = null;
let candidateIndex = 0;

const WS_CANDIDATES = (key) => ([
  { url: 'wss://public-api.birdeye.so/socket/solana',
    headers: { 'x-api-key': key, 'Origin': 'https://birdeye.so', 'User-Agent': 'Mozilla/5.0' } },
  { url: 'wss://public-api.birdeye.so/socket?chain=solana',
    headers: { 'x-api-key': key, 'Origin': 'https://birdeye.so', 'User-Agent': 'Mozilla/5.0' } },
  { url: `wss://public-api.birdeye.so/socket/solana?x-api-key=${encodeURIComponent(key)}`,
    headers: { 'Origin': 'https://birdeye.so', 'User-Agent': 'Mozilla/5.0' } },
  { url: `wss://public-api.birdeye.so/socket?x-api-key=${encodeURIComponent(key)}&chain=solana`,
    headers: { 'Origin': 'https://birdeye.so', 'User-Agent': 'Mozilla/5.0' } },
  // optional protocol hint
  { url: 'wss://public-api.birdeye.so/socket/solana',
    protocol: 'json',
    headers: { 'x-api-key': key, 'Origin': 'https://birdeye.so', 'User-Agent': 'Mozilla/5.0' } },
  { url: 'wss://public-api.birdeye.so/socket?chain=solana',
    protocol: 'json',
    headers: { 'x-api-key': key, 'Origin': 'https://birdeye.so', 'User-Agent': 'Mozilla/5.0' } },
]);

function connect() {
  if (!BIRDEYE_KEY) {
    console.error('Missing BIRDEYE_KEY env var. Will retry.');
    setTimeout(connect, 10000);
    return;
  }

  const list = WS_CANDIDATES(BIRDEYE_KEY);
  const pick = list[candidateIndex % list.length];

  console.log(`[WS] Connecting (candidate ${candidateIndex + 1}/${list.length}): ${pick.url}${pick.protocol ? ` [protocol=${pick.protocol}]` : ''}`);

  const wsOpts = {
    headers: pick.headers,
    perMessageDeflate: false,
    handshakeTimeout: 15000,
  };

  ws = pick.protocol
    ? new WebSocket(pick.url, pick.protocol, wsOpts)
    : new WebSocket(pick.url, wsOpts);

  let pingTimer = null;

  ws.once('open', () => {
    connected = true;
    console.log('[WS] connected ✅');

    pingTimer = setInterval(() => { try { ws.ping(); } catch {} }, 20000);

    // subscriptions
    ws.send(JSON.stringify({ type: 'SUBSCRIBE_NEW_PAIR',          min_liquidity: MIN_LIQ_USD }));
    ws.send(JSON.stringify({ type: 'SUBSCRIBE_LARGE_TRADE_TXS',   min_volume:   MIN_LARGE_USD }));
  });

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg?.type === 'WELCOME') return;

    if (msg?.type === 'NEW_PAIR_DATA' && msg.data) {
      pushRing(newPairs, msg.data);
    } else if (msg?.type === 'TXS_LARGE_TRADE_DATA' && msg.data) {
      pushRing(largeTrades, msg.data);
    } else if (msg?.type === 'ERROR' || msg?.statusCode >= 400) {
      console.error('[WS] server ERROR:', msg);
    }
  });

  // capture headers and body on 4xx for debugging
  ws.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (c) => { body += c.toString(); });
    res.on('end', () => {
      console.error(`[WS] unexpected response ${res.statusCode}`, {
        headers: res.headers,
        body: body ? body.slice(0, 500) : null
      });
      candidateIndex++;
      try { ws.close(); } catch {}
    });
  });

  ws.on('error', (err) => {
    console.error('[WS] error:', err?.message || String(err));
  });

  ws.on('close', () => {
    if (pingTimer) clearInterval(pingTimer);
    connected = false;
    console.log('[WS] closed, reconnecting...');
    setTimeout(connect, 4000);
  });
}

connect();

// ----- HTTP API -----
app.get('/', (_req, res) => {
  res.json({ ok: true, connected, newPairs: newPairs.length, largeTrades: largeTrades.length });
});

app.get('/new-pairs', (_req, res) => {
  res.json({ data: [...newPairs].slice(-100).reverse() });
});

app.get('/whales', (req, res) => {
  const min = Number(req.query.min_buy_usd || 0);
  const data = largeTrades.filter(t => Number(t.volumeUSD || 0) >= min);
  res.json({ data: data.slice(-100).reverse() });
});

app.listen(PORT, () => {
  console.log(`API on ${PORT}`);
});

// keep process alive and log crashes
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
