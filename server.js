// server.js
const express   = require('express');
const cors      = require('cors');
const WebSocket = require('ws');

const app  = express();
app.use(cors());

// ---- Config (from Render env) ----
const BIRDEYE_KEY   = process.env.BIRDEYE_KEY || "";
const MIN_LIQ_USD   = Number(process.env.MIN_LIQ_USD   || 0);     // new-pair minimum liquidity (USD)
const MIN_LARGE_USD = Number(process.env.MIN_LARGE_USD || 0);     // large trade minimum size (USD)
const PORT          = Number(process.env.PORT || 3000);

// ---- In-memory buffers ----
const MAX_ITEMS  = 200;         // ring-buffer size
let newPairs     = [];          // most recent new pairs
let largeTrades  = [];          // most recent large trades

function pushRing(buf, item, max = MAX_ITEMS) {
  buf.push(item);
  if (buf.length > max) buf.shift();
}

// ---- Birdeye WS wiring ----
let ws;
let connected = false;

function connectBirdeye() {
  if (!BIRDEYE_KEY) {
    console.error("Missing BIRDEYE_KEY");
    return;
  }

  const url = `wss://public-api.birdeye.so/socket/solana?x-api-key=${BIRDEYE_KEY}`;
  ws = new WebSocket(url, { headers: { Origin: "https://birdeye.so" } });

  ws.on('open', () => {
    connected = true;

    // Subscribe to new pairs (liquidity in USD)
    ws.send(JSON.stringify({
      type: "SUBSCRIBE_NEW_PAIR",
      min_liquidity: MIN_LIQ_USD
    }));

    // Subscribe to large trades (USD)
    ws.send(JSON.stringify({
      type: "SUBSCRIBE_LARGE_TRADE_TXS",
      min_volume: MIN_LARGE_USD
    }));

    console.log('Birdeye WS connected');
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // NEW PAIR
      if (msg.type === "NEW_PAIR_DATA" && msg.data) {
        // Store a compact, consistent shape
        const d = msg.data;
        pushRing(newPairs, {
          ts: d.blockUnixTime ?? Date.now()/1000,
          mintA: d.mintA || d.symbolA || d.baseMint,
          mintB: d.mintB || d.symbolB || d.quoteMint,
          liqUSD: Number(d.liquidityUsd || d.liquidityUSD || d.liquidity_usd || 0),
          pool: d.poolAddress || d.pool || d.pool_id || null,
          dex: d.dex || d.market || d.source || null,
          chart: d.poolAddress ? `https://birdeye.so/pair/${d.poolAddress}?chain=solana` : null
        });
      }

      // LARGE TRADE (whales)
      if (msg.type === "TXS_LARGE_TRADE_DATA" && msg.data) {
        const t  = msg.data;
        pushRing(largeTrades, {
          ts: t.blockUnixTime ?? t.block_time ?? Date.now()/1000,
          wallet: t.owner || t.trader || t.wallet || null,
          pool: t.poolAddress || t.pool || null,
          side: t.side || t.tradeType || null,
          usd: Number(
            t.volumeUSD ?? t.volume_usd ?? t.usdAmount ?? t.amount_usd ?? 0
          ),
          symbol: t.symbol || t.tokenSymbol || null,
          tx: t.signature || t.txHash || null,
          chart: t.poolAddress ? `https://birdeye.so/pair/${t.poolAddress}?chain=solana` : null
        });
      }
    } catch (e) {
      // swallow non-JSON pings, etc.
    }
  });

  ws.on('close', () => {
    connected = false;
    console.log('Birdeye WS closed — reconnecting in 5s…');
    setTimeout(connectBirdeye, 5000);
  });

  ws.on('error', (err) => {
    console.log('Birdeye WS error:', err.message);
    try { ws.close(); } catch {}
  });
}

// Kick it off
connectBirdeye();

// ---- HTTP API ----

// quick health/debug
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    connected,
    newPairs: newPairs.length,
    largeTrades: largeTrades.length
  });
});

// latest new pairs (most-recent first)
app.get('/new-pairs', (_req, res) => {
  res.json({ data: [...newPairs].slice(-100).reverse() });
});

// whale trades, optional ?min_buy_usd=NUMBER
app.get('/whales', (req, res) => {
  const minBuy = Number(req.query.min_buy_usd || MIN_LARGE_USD || 0);
  const out = [...largeTrades]
    .filter(t => Number(t.usd || 0) >= minBuy)
    .slice(-200)
    .reverse();
  res.json({ data: out });
});

app.listen(PORT, () => {
  console.log(`API running on ${PORT}`);
});
