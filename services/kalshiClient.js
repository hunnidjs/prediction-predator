const crypto = require('crypto');
const axios = require('axios');

const BASE = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
const KEY_ID = process.env.KALSHI_API_KEY_ID;
const RAW_PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY || '';

function loadPrivateKey() {
  if (!RAW_PRIVATE_KEY) return null;
  const pem = RAW_PRIVATE_KEY.includes('\\n')
    ? RAW_PRIVATE_KEY.replace(/\\n/g, '\n')
    : RAW_PRIVATE_KEY;
  try {
    return crypto.createPrivateKey({ key: pem, format: 'pem' });
  } catch (err) {
    console.error('[kalshi] failed to parse KALSHI_PRIVATE_KEY:', err.message);
    return null;
  }
}

let _privateKey = null;
function getPrivateKey() {
  if (_privateKey) return _privateKey;
  _privateKey = loadPrivateKey();
  return _privateKey;
}

function signRequest(method, pathOnly) {
  const privateKey = getPrivateKey();
  if (!privateKey || !KEY_ID) {
    throw new Error('Kalshi credentials missing — set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY');
  }
  const timestamp = String(Date.now());
  const message = `${timestamp}${method.toUpperCase()}${pathOnly}`;
  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return {
    'KALSHI-ACCESS-KEY': KEY_ID,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'Content-Type': 'application/json',
  };
}

function pathFromUrl(url) {
  const u = new URL(url);
  return u.pathname;
}

async function authedRequest(method, urlPath, { params, data } = {}) {
  const fullUrl = urlPath.startsWith('http') ? urlPath : `${BASE}${urlPath}`;
  const pathOnly = pathFromUrl(fullUrl);
  const headers = signRequest(method, pathOnly);
  try {
    const res = await axios({ method, url: fullUrl, params, data, headers, timeout: 15000 });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const msg = `[kalshi] ${method} ${pathOnly} failed status=${status} body=${JSON.stringify(body).slice(0, 300)}`;
    const wrapped = new Error(msg);
    wrapped.status = status;
    wrapped.body = body;
    throw wrapped;
  }
}

async function publicRequest(method, urlPath, { params } = {}) {
  const fullUrl = urlPath.startsWith('http') ? urlPath : `${BASE}${urlPath}`;
  try {
    const res = await axios({ method, url: fullUrl, params, timeout: 15000 });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const wrapped = new Error(`[kalshi] public ${method} ${urlPath} failed status=${status}`);
    wrapped.status = status;
    throw wrapped;
  }
}

// Kalshi v2 now returns prices as dollars (e.g. 0.42) and liquidity as `_fp` fields.
// We normalize back to the cents-and-ints shape the rest of the codebase assumes.
//
// Sentinel handling: Kalshi reports "no offer" sides as 0.0000 (no real ask)
// or 1.0000 (max-of-range sentinel on ask). Bids do the same with 0.0000.
// We collapse those to null so a downstream `m.yes_ask != null` check means
// "there is a real, executable price."
function dollarsToCents(d) {
  if (d == null) return null;
  const n = Number(d);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function realPriceCents(d) {
  const c = dollarsToCents(d);
  if (c == null || c <= 0 || c >= 100) return null;
  return c;
}

function normalizeMarket(m) {
  if (!m) return m;
  return {
    ...m,
    yes_ask: realPriceCents(m.yes_ask_dollars),
    no_ask: realPriceCents(m.no_ask_dollars),
    yes_bid: realPriceCents(m.yes_bid_dollars),
    no_bid: realPriceCents(m.no_bid_dollars),
    last_price: dollarsToCents(m.last_price_dollars),
    volume: Number(m.volume_fp ?? m.volume ?? 0),
    volume_24h: Number(m.volume_24h_fp ?? m.volume_24h ?? 0),
    open_interest: Number(m.open_interest_fp ?? m.open_interest ?? 0),
  };
}

function normalizeMarketsResponse(data) {
  if (!data) return data;
  if (Array.isArray(data.markets)) return { ...data, markets: data.markets.map(normalizeMarket) };
  if (data.market) return { ...data, market: normalizeMarket(data.market) };
  return data;
}

async function listOpenMarkets({ limit = 200, cursor = null, eventTicker = null } = {}) {
  const params = { status: 'open', limit };
  if (cursor) params.cursor = cursor;
  if (eventTicker) params.event_ticker = eventTicker;
  const data = await publicRequest('GET', '/markets', { params });
  return normalizeMarketsResponse(data);
}

async function listEvents({ limit = 100, cursor = null, status = 'open' } = {}) {
  const params = { limit, status };
  if (cursor) params.cursor = cursor;
  return publicRequest('GET', '/events', { params });
}

async function getMarket(ticker) {
  const data = await publicRequest('GET', `/markets/${ticker}`);
  return normalizeMarketsResponse(data);
}

async function getOrderbook(ticker, depth = 5) {
  return publicRequest('GET', `/markets/${ticker}/orderbook`, { params: { depth } });
}

async function listSettledMarkets({ limit = 200, cursor = null, minCloseTs = null } = {}) {
  const params = { status: 'settled', limit };
  if (cursor) params.cursor = cursor;
  if (minCloseTs) params.min_close_ts = minCloseTs;
  const data = await publicRequest('GET', '/markets', { params });
  return normalizeMarketsResponse(data);
}

async function getBalance() {
  return authedRequest('GET', '/portfolio/balance');
}

async function getPositions() {
  return authedRequest('GET', '/portfolio/positions');
}

async function placeOrder({ ticker, side, action, count, type = 'limit', yesPrice, noPrice, clientOrderId }) {
  const body = {
    ticker,
    side,
    action,
    count,
    type,
    client_order_id: clientOrderId,
  };
  if (yesPrice != null) body.yes_price = yesPrice;
  if (noPrice != null) body.no_price = noPrice;
  return authedRequest('POST', '/portfolio/orders', { data: body });
}

async function cancelOrder(orderId) {
  return authedRequest('DELETE', `/portfolio/orders/${orderId}`);
}

function isConfigured() {
  return Boolean(KEY_ID && getPrivateKey());
}

module.exports = {
  isConfigured,
  listOpenMarkets,
  listEvents,
  getMarket,
  getOrderbook,
  listSettledMarkets,
  getBalance,
  getPositions,
  placeOrder,
  cancelOrder,
};
