const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

const app = express();
app.use(cors());

const BIRDEYE_KEY = process.env.BIRDEYE_KEY || "";
const MIN_LIQ = Number(process.env.MIN_LIQ_USD || 25000);
const MIN_LARGE = Number(process.env.MIN_LARGE_USD || 10000);
const PORT = process.env.PORT || 3000;

const newPairs = [];
const largeTrades = [];
function pushRing(arr, item, max = 100) { arr.push(item); if (arr.length > max) arr.shift(); }

function connectBirdeye() {
  if (!BIRDEYE_KEY) { console.error("Missing BIRDEYE_KEY"); return; }
  const url = `wss://public-api.birdeye.so/socket/solana?x-api-key=${BIRDEYE_KEY}`;
  const ws = new WebSocket(url, { headers: { Origin: "https://birdeye.so" } });

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "SUBSCRIBE_NEW_PAIR", min_liquidity: MIN_LIQ }));
    ws.send(JSON.stringify({ type: "SUBSCRIBE_LARGE_TRADE_TXS", min_volume: MIN_LARGE }));
    console.log("Birdeye WS connected");
  });

  ws.on("message", (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === "NEW_PAIR_DATA" && msg.data) {
      const d = msg.data;
      pushRing(newPairs, {
        pair: d.address,
        baseMint: d.base?.address,
        baseSymbol: d.base?.symbol,
        quoteSymbol: d.quote?.symbol,
        t: d.blockTime,
        chart: `https://birdeye.so/token/${d.base?.address}?chain=solana`,
        trade: `https://dexscreener.com/solana/${d.address}`
      });
    }

    if (msg.type === "TXS_LARGE_TRADE_DATA" && msg.data) {
      const d = msg.data;
      pushRing(largeTrades, {
        ts: d.blockUnixTime,
        wallet: d.owner,
        pool: d.poolAddress,
        volumeUSD: d.volumeUSD,
        from: { symbol: d.from?.symbol, amount: d.from?.uiAmount },
        to:   { symbol: d.to?.symbol,   amount: d.to?.uiAmount },
        tx: d.txHash,
        chart: `https://birdeye.so/token/${d.to?.address || ""}?chain=solana`,
        explorer: `https://solscan.io/tx/${d.txHash}`
      });
    }
  });

  ws.on("close", () => { console.log("WS closed, reconnecting..."); setTimeout(connectBirdeye, 2000); });
  ws.on("error", (e) => { console.error("WS error", e.message); try { ws.close(); } catch {} });
}
connectBirdeye();

app.get("/", (_req, res) => res.send("OK"));
app.get("/new-pairs", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 100);
  res.json({ data: [...newPairs].slice(-limit).reverse() });
});
app.get("/whales", (req, res) => {
  const min = Number(req.query.min_buy_usd || MIN_LARGE);
  const limit = Math.min(Number(req.query.limit || 50), 100);
  const filtered = largeTrades.filter(x => (x.volumeUSD || 0) >= min);
  res.json({ data: filtered.slice(-limit).reverse() });
});

app.listen(PORT, () => console.log("API running on", PORT));
