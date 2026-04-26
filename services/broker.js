const kalshi = require('./kalshiClient');

const MODE = (process.env.TRADING_MODE || 'signals').toLowerCase();
const LIVE_OK = String(process.env.LIVE_TRADING_CONFIRMED || '').toLowerCase() === 'true';
const MAX_BET_USD = Number(process.env.MAX_BET_USD || 50);

function describeMode() {
  if (MODE === 'live' && !LIVE_OK) {
    return { mode: 'signals', note: 'TRADING_MODE=live but LIVE_TRADING_CONFIRMED!=true — falling back to signals' };
  }
  return { mode: MODE, note: null };
}

function priceCentsForSide(signal) {
  return signal.side === 'YES' ? signal.market_yes_price_cents : signal.market_no_price_cents;
}

function sizeContracts(signal) {
  const priceCents = priceCentsForSide(signal);
  if (priceCents <= 0 || priceCents >= 100) return 0;
  const costPerContract = priceCents / 100;
  const cappedUsd = Math.min(Number(signal.recommended_size_usd || 0), MAX_BET_USD);
  const contracts = Math.floor(cappedUsd / costPerContract);
  return Math.max(0, contracts);
}

async function placeOrderForSignal(signal) {
  const { mode, note } = describeMode();
  if (note) console.warn(`[broker] ${note}`);
  const contracts = sizeContracts(signal);

  if (contracts < 1) {
    return { action: 'skipped_size_zero', mode, contracts: 0 };
  }

  const priceCents = priceCentsForSide(signal);
  const clientOrderId = `pp-${signal.market_ticker}-${Date.now().toString(36)}`;

  if (mode === 'signals') {
    return {
      action: 'would_have_bet',
      mode,
      contracts,
      priceCents,
      clientOrderId,
      note: 'TRADING_MODE=signals — no order sent',
    };
  }

  if (mode === 'paper') {
    return {
      action: 'paper_filled',
      mode,
      contracts,
      priceCents,
      clientOrderId,
      note: 'paper portfolio updated, no real order',
    };
  }

  if (mode === 'live') {
    if (!kalshi.isConfigured()) {
      return { action: 'live_blocked_no_creds', mode, contracts: 0, note: 'Kalshi creds missing' };
    }
    const orderArgs = {
      ticker: signal.market_ticker,
      action: 'buy',
      side: signal.side === 'YES' ? 'yes' : 'no',
      count: contracts,
      type: 'limit',
      clientOrderId,
    };
    if (signal.side === 'YES') orderArgs.yesPrice = priceCents;
    else orderArgs.noPrice = priceCents;
    const result = await kalshi.placeOrder(orderArgs);
    return {
      action: 'live_submitted',
      mode,
      contracts,
      priceCents,
      clientOrderId,
      orderExternalId: result?.order?.order_id || null,
      raw: result,
    };
  }

  return { action: 'unknown_mode', mode, contracts: 0 };
}

module.exports = { describeMode, placeOrderForSignal, sizeContracts };
