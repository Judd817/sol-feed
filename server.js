'use strict';

const express   = require('express');
const cors      = require('cors');
const WebSocket = require('ws');

const app = express();
app.use(cors());

const PORT        = process.env.PORT || 3000;
const BIRDEYE_KEY = process.env.BIRDEYE_KEY || '';

const MIN_LIQ_USD   = 0;
const MIN_LARGE_USD = 0;

const MAX_KEEP = 200;
const newPairs = [];
const largeTrades = [];
let connected = false;
let ws = null;

function pushRing(arr, item, max = MAX_KEEP) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

function connectBirdeye() {
  if (!BIRDEYE_KEY) {
    console.error('Missing BIRDEYE_KEY');
    setTimeout(connectBirdeye, 10000);
    return;
  }

  // Try both ways: query + header (some gateways are picky)
  const url = `wss://public-api.birdeye.so/socket/solana?x-api-key=${encodeURIComponent(BIRDEYE_KEY)}`;
  const headers = {
    'origin': 'https://birdeye.so',
    'x-api-key': BIRDEYE_KEY,
  };

  console.log('Connecting to Birdeye WS…');
  ws = new WebSocket(url, { headers, perMessageDeflate: false });

  ws.on('open', () => {
    connected = true;
    console.log('Birdeye WS connected');

    // Some accounts require an explicit auth frame
    ws.send(JSON.stringify({ type: 'AUTH', api_key: BIRDEYE_KEY }));

    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'SUBSCRIBE_NEW_PAIR',        min_liquidity: MIN_LIQ_USD }));
      ws.send(JSON.stringify({ type: 'SUBSCRIBE_LARGE_TRADE_TXS', min_volume:   MIN_LARGE_USD }));
    }, 200);
  });

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.type === 'ERROR') { console.error('WS server ERROR:', msg); return; }
    if (msg.type === 'NEW_PAIR_DATA' && msg.data)         pushRing(newPairs, msg.data);
    if (msg.type === 'TXS_LARGE_TRADE_DATA' && msg.data)  pushRing(largeTrades, msg.data);
  });

  ws.on('unexpected-response', (_req, res) => {
    console.error('WS unexpected:', res.statusCode, res.statusMessage);
  });

  ws.on('error', (e) => console.error('WS error:', e?.message || e));
  ws.on('close', () => { connected = false; console.log('Birdeye WS closed – reconnecting…'); setTimeout(connectBirdeye, 5000); });
}

connectBirdeye();

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

app.listen(PORT, () => console.log(`API running on ${PORT}`));
