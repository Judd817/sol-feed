// server.js
// Solid, minimal Birdeye → Express bridge with WS + REST

const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

// ─────────────────────────────────────────────────────────────────────────────
// Env & config
// ─────────────────────────────────────────────────────────────────────────────
const BIRDEYE_KEY   = process.env.BIRDEYE_KEY || "";
const MIN_LIQ_USD   = Number(process.env.MIN_LIQ_USD ?? 25000) || 0;
const MIN_LARGE_USD = Number(process.env.MIN_LARGE_USD ?? 10000) || 0;
const PORT          = Number(process.env.PORT || 3000);

// Sanity guard – logs only; endpoints will still return [] if not set
if (!BIRDEYE_KEY) {
  console.warn("[WARN] BIRDEYE_KEY is not set — WebSocket will not subscribe.");
}

// Ring buffers (keeps last N items in memory)
const MAX_PAIRS  = 200;
const MAX_TRADES = 200;

const newPairs    = [];
const largeTrades = [];

function pushRing(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());

// Health check (Render watches this)
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// Root: tiny status
app.get("/", (req, res) => {
  res.json({
    ok: true,
    newPairs: newPairs.length,
    largeTrades: largeTrades.length,
  });
});

// Return recent new pairs (WS-buffered). If empty, safe REST fallback.
app.get("/new-pairs", async (req, res) => {
  const data = newPairs.slice(-50).reverse();
  if (data.length) return res.json({ data });

  // Fallback: Birdeye token list (latest created). Use required headers.
  try {
    if (!BIRDEYE_KEY) return res.json({ data: [] });

    const url = "https://public-api.birdeye.so/defi/tokenlist?sort_by=created_at&sort_type=desc&offset=0&limit=50";
    const r = await fetch(url, {
      headers: {
        "accept": "application/json",
        "x-chain": "solana",
        "x-api-key": BIRDEYE_KEY,
      },
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error("[fallback /new-pairs] non-200", r.status, txt.slice(0, 200));
      return res.json({ data: [] });
    }

    const j = await r.json();
    // If shape differs, just pass through to see it
    return res.json({ data: j?.data || j || [] });
  } catch (e) {
    console.error("[fallback /new-pairs] error", e);
    return res.json({ data: [] });
  }
});

// Return recent large trades (WS-buffered only; NO HTTP fallback to avoid HTML/JSON issues)
app.get("/whales", (req, res) => {
  const minBuy = Number(req.query.min_buy_usd || 0) || 0;
  const data = largeTrades
    .filter(t => Number(t?.d?.txUsdValue ?? t?.txUsdValue ?? 0) >= minBuy)
    .slice(-100)
    .reverse();

  res.json({ data });
});

// ─────────────────────────────────────────────────────────────────────────────
// Birdeye WebSocket connect + subscriptions
// ─────────────────────────────────────────────────────────────────────────────
let ws;
let reconnectTimer = null;
let reconnectDelayMs = 2000; // backoff up to ~20s
const MAX_BACKOFF = 20000;

function connectBirdeye() {
  if (!BIRDEYE_KEY) {
    console.warn("[WS] Missing BIRDEYE_KEY; skipping WS connect");
    return;
  }

  const url = `wss://public-api.birdeye.so/socket/solana?x-api-key=${encodeURIComponent(BIRDEYE_KEY)}`;

  ws = new WebSocket(url, {
    headers: { Origin: "https://birdeye.so" },
  });

  ws.on("open", () => {
    console.log("[WS] connected");
    reconnectDelayMs = 2000; // reset backoff

    // Subscribe to new pairs
    ws.send(JSON.stringify({
      type: "SUBSCRIBE_NEW_PAIR",
      min_liquidity: MIN_LIQ_USD,
    }));

    // Subscribe to large trades
    ws.send(JSON.stringify({
      type: "SUBSCRIBE_LARGE_TRADE_TXS",
      min_volume: MIN_LARGE_USD,
    }));
  });

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (!msg?.type) return;

    // Uncomment to see traffic details:
    // if (msg.type !== "ping") console.log("[WS msg]", msg.type);

    // Expected message types:
    // - "NEW_PAIR_DATA" with msg.data
    // - "TXS_LARGE_TRADE_DATA" with msg.data
    if (msg.type === "NEW_PAIR_DATA" && msg.data) {
      // Store raw; your UI can map/format as needed
      pushRing(newPairs, msg.data, MAX_PAIRS);
    } else if (msg.type === "TXS_LARGE_TRADE_DATA" && msg.data) {
      pushRing(largeTrades, msg.data, MAX_TRADES);
    }
  });

  ws.on("error", (err) => {
    console.error("[WS] error", err?.message || err);
  });

  ws.on("close", (code) => {
    console.warn("[WS] closed", code);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_BACKOFF);
    console.log(`[WS] reconnecting... (next delay=${reconnectDelayMs}ms)`);
    connectBirdeye();
  }, reconnectDelayMs);
}

// Kick off the WS
connectBirdeye();

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[HTTP] running on ${PORT}`);
});

// Hardening
process.on("unhandledRejection", (e) => {
  console.error("[unhandledRejection]", e);
});
process.on("uncaughtException", (e) => {
  console.error("[uncaughtException]", e);
});
