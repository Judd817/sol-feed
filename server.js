// server.js
'use strict';

const express   = require('express');
const cors      = require('cors');
const WebSocket = require('ws');

const app  = express();
app.use(cors());

const PORT         = process.env.PORT || 3000;
const BIRDEYE_KEY  = process.env.BIRDEYE_KEY || "";

// Hard-code thresholds to show *all* events.
const MIN_LIQ_USD   = 0; // for NEW PAIRS subscription
const MIN_LARGE_USD = 0; // for LARGE TRADES subscription

// Ring buffers (keep latest N items)
const MAX_KEEP   = 200;
const newPairs   = [];
const largeTrades = [];
let connected = false;

function pushRing(arr, item, max = MAX_KEEP) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

// ---- Birdeye WebSocket connection ----
let ws = null;
let pingTimer = null;
let reconnectTimer = null;

function scheduleReconnect(ms = 3000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBirdeye();
  }, ms);
}

function connectBirdeye() {
  if (!BIRDEYE_KEY) {
    console.error('Missing BIRDEYE_KEY env var.');
    scheduleReconnect(10000);
    return;
  }

  const url = `wss://public-api.birdeye.so/socket/solana?x-api-key=${BIRDEYE_KEY}`;
  const headers = { Origin: 'https://birdeye.so' };

  console.log('Connecting to Birdeye WS…');
  ws = new WebSocket(url, { headers });

  ws.once('open', () => {
    connected = true;
    console.log('Birdeye WS connected');

    // Subscribe to streams (thresholds forced to 0 above)
    ws.send(JSON.stringify({ type: 'SUBSCRIBE_NEW_PAIR',        min_liquidity: MIN_LIQ_USD   }));
    ws.send(JSON.stringify({ type: 'SUBSCRIBE_LARGE_TRADE_TXS', min_volume:    MIN_LARGE_USD }));

    // Keep-alive
    pingTimer = setInterval(() => {
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
    }, 25000);
  });

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.type && msg.type !== 'ping' && msg.type !== 'pong') {
      console.log('WS msg:', msg.type);
    }

    // NEW PAIRS
    if (msg.type === 'NEW_PAIR_DATA' && msg.data) {
      const d = msg.data;
      const out = {
        ts:     d.block_unix_time ?? d.blockUnixTime ?? Math.floor(Date.now()/1000),
        base:   d.base_token  ?? d.baseToken  ?? null,
        quote:  d.quote_token ?? d.quoteToken ?? null,
        pair:   d.pair        ?? d.address    ?? null,
        raw:    d,
      };
      pushRing(newPairs, out);
    }

    // LARGE TRADES
    if (msg.type === 'TXS_LARGE_TRADE_DATA' && msg.data) {
      const d = msg.data;
      const amountUsd =
        d.volume_usd ?? d.volumeUSD ?? d.amountUSD ?? Number(d.usd_amount) ?? 0;

      const out = {
        ts:        d.block_unix_time ?? d.blockUnixTime ?? Math.floor(Date.now()/1000),
        wallet:    d.owner ?? d.wallet ?? null,
        amountUsd,
        base:      (d.from && d.from.symbol) || d.fromSymbol || null,
        quote:     (d.to   && d.to.symbol)   || d.toSymbol   || null,
        pool:      d.pool_address ?? d.poolAddress ?? null,
        raw:       d,
      };
      pushRing(largeTrades, out);
    }
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message || err);
  });

  ws.on('close', () => {
    console.log('Birdeye WS closed – reconnecting…');
    connected = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    scheduleReconnect();
  });
}

connectBirdeye();

// ---- HTTP API ----
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    connected,
    newPairs:    newPairs.length,
    largeTrades: largeTrades.length
  });
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.get('/new-pairs', (_req, res) => {
  res.json({ data: [...newPairs].slice(-100).reverse() });
});

app.get('/whales', (req, res) => {
  const min = Number(req.query.min_buy_usd || 0);
  const filtered = largeTrades.filter(x => (Number(x.amountUsd) || 0) >= min);
  res.json({ data: filtered.slice(-100).reverse() });
});

app.listen(PORT, () => {
  console.log(`API running on ${PORT}`);
});
