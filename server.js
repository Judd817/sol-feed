'use strict';

const express   = require('express');
const cors      = require('cors');
const WebSocket = require('ws');

// -------- ENV --------
const PORT          = Number(process.env.PORT || 3000);
const BIRDEYE_KEY   = String(process.env.BIRDEYE_KEY || '').trim();
const MIN_LIQ_USD   = Number(process.env.MIN_LIQ_USD || 0);
const MIN_LARGE_USD = Number(process.env.MIN_LARGE_USD || 0);

// -------- APP --------
const app = express();
app.use(cors());

// -------- RING BUFFERS --------
const MAX_KEEP    = 200;
const newPairs    = [];
const largeTrades = [];
let   connected   = false;

function pushRing(arr, item, max = MAX_KEEP) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

// -------- WS CONNECT, MULTI CANDIDATES, DEEP DIAGNOSTICS --------
let ws = null;
let candidateIndex = 0;

// Full list of URL and header styles we want to try
const WS_CANDIDATES = (key) => ([
  // Header auth, explicit chain header, common Origin
  { url: 'wss://public-api.birdeye.so/socket/solana',
    headers: {
      'x-api-key': key,
      'x-chain': 'solana',
      'Origin': 'https://app.birdeye.so',
      'User-Agent': 'Mozilla/5.0'
    }
  },

  // Same URL, alternate Origin
  { url: 'wss://public-api.birdeye.so/socket/solana',
    headers: {
      'x-api-key': key,
      'x-chain': 'solana',
      'Origin': 'https://birdeye.so',
      'User-Agent': 'Mozilla/5.0'
    }
  },

  // Socket root with chain query
  { url: 'wss://public-api.birdeye.so/socket?chain=solana',
    headers: {
      'x-api-key': key,
      'x-chain': 'solana',
      'Origin': 'https://app.birdeye.so',
      'User-Agent': 'Mozilla/5.0'
    }
  },

  // Add Bearer in case gateway expects Authorization as well
  { url: 'wss://public-api.birdeye.so/socket/solana',
    headers: {
      'Authorization': `Bearer ${key}`,
      'x-api-key': key,
      'x-chain': 'solana',
      'Origin': 'https://app.birdeye.so',
      'User-Agent': 'Mozilla/5.0'
    }
  },

  // Query param key as a last resort
  { url: `wss://public-api.birdeye.so/socket/solana?x-api-key=${encodeURIComponent(key)}&chain=solana`,
    headers: {
      'x-chain': 'solana',
      'Origin': 'https://app.birdeye.so',
      'User-Agent': 'Mozilla/5.0'
    }
  },
]);

function connect() {
  if (!BIRDEYE_KEY) {
    console.error('Missing BIRDEYE_KEY env var. Set it in Render, then Manual Deploy.');
    setTimeout(connect, 10000);
    return;
  }

  const list = WS_CANDIDATES(BIRDEYE_KEY);
  const pick = list[candidateIndex % list.length];

  console.log(`[WS] Connecting (candidate ${candidateIndex + 1}/${list.length}): ${pick.url}`);

  const wsOpts = {
    headers: pick.headers,
    perMessageDeflate: false,
    handshakeTimeout: 15000,
  };

  ws = new WebSocket(pick.url, wsOpts);

  let pingTimer = null;

  ws.once('open', () => {
    connected = true;
    console.log('[WS] connected ✅');

    // keep-alive ping to avoid idle timeouts
    pingTimer = setInterval(() => { try { ws.ping(); } catch {} }, 20000);

    // subscriptions
    ws.send(JSON.stringify({ type: 'SUBSCRIBE_NEW_PAIR',        min_liquidity: MIN_LIQ_USD }));
    ws.send(JSON.stringify({ type: 'SUBSCRIBE_LARGE_TRADE_TXS', min_volume:   MIN_LARGE_USD }));
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

  // Capture response headers and the first part of the body on 4xx
  ws.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (c) => { body += c.toString(); });
    res.on('end', () => {
      console.error(`[WS] unexpected response ${res.statusCode}`, {
        headers: res.headers,
        body: body ? body.slice(0, 800) : null
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
    const next = (candidateIndex + 1);
    const total = WS_CANDIDATES(BIRDEYE_KEY).length;
    connected = false;
    console.log(`[WS] closed, reconnecting... next candidate ${next}/${total}`);
    setTimeout(connect, 4000);
  });
}

connect();

// -------- HTTP API --------
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

// Extra safety
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
