'use strict';

const express   = require('express');
const cors      = require('cors');
const WebSocket = require('ws');

const app = express();
app.use(cors());

const PORT        = process.env.PORT || 3000;
const BIRDEYE_KEY = process.env.BIRDEYE_KEY || '';

const MAX_KEEP = 200;
const MIN_LIQ_USD = 0;     // leave at 0 unless you want to filter
const MIN_LARGE_USD = 0;   // leave at 0 unless you want to filter

let ws;
let connected = false;
const newPairs = [];
const largeTrades = [];

function pushRing(arr, item, max = MAX_KEEP) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

function connect() {
  if (!BIRDEYE_KEY) {
    console.error('Missing BIRDEYE_KEY env var');
    setTimeout(connect, 10_000);
    return;
  }

  // Birdeye WS: send key as header; specify chain as query
  const url = 'wss://public-api.birdeye.so/socket?chain=solana';
  const headers = {
    'x-api-key': BIRDEYE_KEY,
    'origin': 'https://birdeye.so',
  };

  console.log('Connecting to Birdeye WS…');
  ws = new WebSocket(url, { headers });

  ws.on('open', () => {
    connected = true;
    console.log('Birdeye WS connected');

    // subscribe channels
    ws.send(JSON.stringify({ type: 'SUBSCRIBE_NEW_PAIR',      min_liquidity: MIN_LIQ_USD }));
    ws.send(JSON.stringify({ type: 'SUBSCRIBE_LARGE_TRADE_TXS', min_volume:   MIN_LARGE_USD }));
  });

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.type === 'WELCOME') {
      console.log('WS: WELCOME');
      return;
    }
    if (msg.type === 'ERROR') {
      console.error('WS server ERROR:', msg);
      return;
    }
    if (msg.type === 'NEW_PAIR_DATA' && msg.data) {
      pushRing(newPairs, msg.data);
      return;
    }
    if (msg.type === 'TXS_LARGE_TRADE_DATA' && msg.data) {
      pushRing(largeTrades, msg.data);
      return;
    }
  });

  ws.on('close', () => {
    connected = false;
    console.log('Birdeye WS closed – reconnecting…');
    setTimeout(connect, 5_000);
  });

  ws.on('error', (e) => {
    console.error('WS error:', e && e.message ? e.message : e);
  });
}

connect();

// HTTP API
app.get('/', (_req, res) => {
  res.json({ ok: true, connected, newPairs: newPairs.length, largeTrades: largeTrades.length });
});

app.get('/new-pairs', (_req, res) => {
  res.json({ data: [...newPairs].slice(-100).reverse() });
});

app.get('/whales', (req, res) => {
  const min = Number(req.query.min_buy_usd || 0);
  const filtered = largeTrades.filter(t => Number(t.volumeUSD || 0) >= min);
  res.json({ data: filtered.slice(-100).reverse() });
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`API on ${PORT}`));
