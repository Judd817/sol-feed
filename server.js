// ----- WS CONNECT (try multiple URL/header styles + protocols) -----
let ws = null;
let candidateIndex = 0;

const WS_CANDIDATES = (key) => ([
  // protocol is optional, we’ll pass it when present
  { url: 'wss://public-api.birdeye.so/socket/solana',
    headers: { 'x-api-key': key, 'Origin': 'https://birdeye.so', 'User-Agent': 'Mozilla/5.0' } },
  { url: 'wss://public-api.birdeye.so/socket?chain=solana',
    headers: { 'x-api-key': key, 'Origin': 'https://birdeye.so', 'User-Agent': 'Mozilla/5.0' } },
  { url: `wss://public-api.birdeye.so/socket/solana?x-api-key=${encodeURIComponent(key)}`,
    headers: { 'Origin': 'https://birdeye.so', 'User-Agent': 'Mozilla/5.0' } },
  { url: `wss://public-api.birdeye.so/socket?x-api-key=${encodeURIComponent(key)}&chain=solana`,
    headers: { 'Origin': 'https://birdeye.so', 'User-Agent': 'Mozilla/5.0' } },

  // same two but with a protocol hint, in case Birdeye enforces one
  { url: 'wss://public-api.birdeye.so/socket/solana',
    protocol: 'json',
    headers: { 'x-api-key': key, 'Origin': 'https://birdeye.so', 'User-Agent': 'Mozilla/5.0' } },
  { url: 'wss://public-api.birdeye.so/socket?chain=solana',
    protocol: 'json',
    headers: { 'x-api-key': key, 'Origin': 'https://birdeye.so', 'User-Agent': 'Mozilla/5.0' } },
]);

function connect() {
  if (!BIRDEYE_KEY) {
    console.error('Missing BIRDEYE_KEY env var.');
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
    pingTimer = setInterval(() => { try { ws.ping(); } catch {} }, 20_000);

    ws.send(JSON.stringify({ type: 'SUBSCRIBE_NEW_PAIR',          min_liquidity: MIN_LIQ_USD }));
    ws.send(JSON.stringify({ type: 'SUBSCRIBE_LARGE_TRADE_TXS',   min_volume:   MIN_LARGE_USD }));
  });

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg?.type === 'WELCOME') return;

    if (msg?.type === 'NEW_PAIR_DATA' && msg.data)        pushRing(newPairs, msg.data);
    else if (msg?.type === 'TXS_LARGE_TRADE_DATA' && msg.data) pushRing(largeTrades, msg.data);
    else if (msg?.type === 'ERROR' || msg?.statusCode >= 400)   console.error('[WS] server ERROR:', msg);
  });

  // Critical: capture the response BODY and headers on 4xx
  ws.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (c) => { body += c.toString(); });
    res.on('end', () => {
      console.error(`[WS] unexpected response ${res.statusCode}`, {
        headers: res.headers,
        body: body?.slice(0, 500) || null
      });
      candidateIndex++;
      try { ws.close(); } catch {}
    });
  });

  ws.on('error', (err) => console.error('[WS] error:', err?.message || String(err)));

  ws.on('close', () => {
    if (pingTimer) clearInterval(pingTimer);
    connected = false;
    console.log('[WS] closed – reconnecting...');
    setTimeout(connect, 4000);
  });
}
