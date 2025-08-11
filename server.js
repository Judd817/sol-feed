const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

// Node 18+ has global fetch (works on Render). If not, uncomment next line:
// const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());

const BIRDEYE_KEY   = process.env.BIRDEYE_KEY || "";
const MIN_LIQ_USD   = Number(process.env.MIN_LIQ_USD   || 0);    // min liquidity for "new pairs" WS subscription
const MIN_LARGE_USD = Number(process.env.MIN_LARGE_USD || 0);    // min USD for "whale" trades WS subscription
const PORT          = process.env.PORT || 3000;

// In-memory ring buffers
const newPairs    = [];
const largeTrades = [];
function pushRing(arr, item, max = 200) { arr.push(item); if (arr.length > max) arr.shift(); }

// ---- Birdeye WS (optional; uses your BIRDEYE_KEY). If missing, we just skip WS. ----
function connectBirdseye() {
  if (!BIRDEYE_KEY) {
    console.log("No BIRDEYE_KEY set. Skipping Birdeye WS (REST fallback will still work).");
    return;
  }

  const url = `wss://public-api.birdeye.so/socket/solana?x-api-key=${encodeURIComponent(BIRDEYE_KEY)}`;
  const ws  = new WebSocket(url, { headers: { origin: "https://birdeye.so" } });

  ws.on("open", () => {
    console.log("Birdeye WS connected");
    // subscribe to new pairs + big trades
    ws.send(JSON.stringify({ type: "SUBSCRIBE_NEW_PAIR",     min_liquidity: MIN_LIQ_USD }));
    ws.send(JSON.stringify({ type: "SUBSCRIBE_LARGE_TRADE_TXS", min_volume:  MIN_LARGE_USD }));
  });

  ws.on("message", (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || !msg.type || !msg.data) return;

    if (msg.type === "NEW_PAIR_DATA") {
      const d = msg.data;
      pushRing(newPairs, {
        ts: d?.blockUnixTime,
        pair: d?.pairAddress,
        base: d?.baseMint,
        quote: d?.quoteMint,
        liqUsd: d?.liquidityUsd ?? null,
        url: d?.url || null
      });
    }

    if (msg.type === "TXS_LARGE_TRADE_DATA") {
      const d = msg.data;
      pushRing(largeTrades, {
        ts: d?.blockUnixTime,
        wallet: d?.owner,
        pool: d?.poolAddress,
        usd: d?.volumeUsd,
        from: { symbol: d?.from?.symbol, amount: d?.from?.uiAmount },
        to:   { symbol: d?.to?.symbol,   amount: d?.to?.uiAmount  },
        tx: d?.txHash,
        chart: `https://birdeye.so/token/${d?.to?.address || d?.from?.address || ""}?chain=solana`,
        explorer: `https://solscan.io/tx/${d?.txHash}`
      });
    }
  });

  ws.on("close", () => {
    console.log("WS closed; reconnecting in 2s...");
    setTimeout(connectBirdseye, 2000);
  });

  ws.on("error", (e) => {
    console.error("WS error:", e.message);
  });
}
connectBirdseye();

// ---------------------------------------------------------------------------
// REST endpoints
// ---------------------------------------------------------------------------

// health
app.get("/healthz", (_, res) => res.send("OK"));

// NEW PAIRS — REST fallback via DexScreener (no API key needed). Returns immediately.
app.get("/new-pairs", async (req, res) => {
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/pairs/solana", { timeout: 10_000 });
    const j = await r.json();
    const rows = (j?.pairs || [])
      .slice(0, 50) // latest 50
      .map(p => ({
        chain: p.chainId,
        dex: p.dexId,
        pair: p.pairAddress,
        base: p.baseToken?.symbol,
        quote: p.quoteToken?.symbol,
        priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
        liquidityUsd: p.liquidity?.usd ?? null,
        createdAt: p.pairCreatedAt ?? null,
        url: p.url
      }));
    res.json({ data: rows });
  } catch (e) {
    console.error("new-pairs fallback error:", e.message);
    res.json({ data: [] });
  }
});

// WHALES — uses the live WS buffer (fills over time). You can pass ?min_buy_usd=###
app.get("/whales", (req, res) => {
  const min = Number(req.query.min_buy_usd ?? MIN_LARGE_USD ?? 0);
  const filtered = largeTrades.filter(t => Number(t.usd) >= min);
  // latest first
  res.json({ data: filtered.slice(-100).reverse() });
});

// start
app.listen(PORT, () => {
  console.log("API running on", PORT);
});
