const EDGE_MIN_CENTS = Number(process.env.EDGE_MIN_CENTS || 8);
const CONFIDENCE_MIN = Number(process.env.CONFIDENCE_MIN || 0.75);
const MAX_SPREAD_CENTS = Number(process.env.MAX_SPREAD_CENTS || 20);
const MIN_HOURS = Number(process.env.MIN_HOURS_TO_RESOLUTION || 24);
const MAX_DAYS = Number(process.env.MAX_DAYS_TO_RESOLUTION || 180);
const MAX_BET_USD = Number(process.env.MAX_BET_USD || 50);
const KELLY_FRACTION = Number(process.env.KELLY_FRACTION || 0.25);

function hoursUntil(ts) {
  if (!ts) return Infinity;
  const diff = new Date(ts).getTime() - Date.now();
  return diff / (1000 * 60 * 60);
}

function spreadCents(market) {
  if (market.yes_bid != null && market.yes_ask != null) {
    return Math.max(0, market.yes_ask - market.yes_bid);
  }
  return 0;
}

function fractionalKelly({ pYes, priceCents, side }) {
  if (priceCents <= 0 || priceCents >= 100) return 0;
  const p = side === 'YES' ? pYes : 1 - pYes;
  const priceProb = (side === 'YES' ? priceCents : 100 - priceCents) / 100;
  if (priceProb <= 0 || priceProb >= 1) return 0;
  // Kalshi binary contracts pay $1 if correct. Bet b at price q, win (1-q)/q on win, lose 1 on loss.
  const b = (1 - priceProb) / priceProb;
  const fullKelly = (p * b - (1 - p)) / b;
  return Math.max(0, fullKelly * KELLY_FRACTION);
}

function recommendedSizeUsd({ pYes, priceCents, side, bankrollUsd = MAX_BET_USD }) {
  const f = fractionalKelly({ pYes, priceCents, side });
  return Math.min(MAX_BET_USD, Math.max(0, bankrollUsd * f));
}

function evaluate({ market, forecast }) {
  const reasons = [];

  if (forecast.abstain) {
    return { fire: false, reason: `abstain: ${forecast.abstain_reason}` };
  }

  if (forecast.confidence < CONFIDENCE_MIN) {
    reasons.push(`confidence ${forecast.confidence.toFixed(2)} < ${CONFIDENCE_MIN}`);
  }

  const hours = hoursUntil(market.close_time);
  if (hours < MIN_HOURS) reasons.push(`resolves in ${hours.toFixed(1)}h (< ${MIN_HOURS})`);
  if (hours / 24 > MAX_DAYS) reasons.push(`resolves in ${(hours / 24).toFixed(0)}d (> ${MAX_DAYS})`);

  const spread = spreadCents(market);
  if (spread > MAX_SPREAD_CENTS) reasons.push(`spread ${spread}¢ > ${MAX_SPREAD_CENTS}`);

  if (market.yes_ask == null || market.yes_ask <= 0 || market.yes_ask >= 100) {
    reasons.push('no usable yes_ask');
  }

  // Pick the side with positive edge
  const yesAsk = market.yes_ask ?? market.last_price;
  const noAsk = market.no_ask ?? (yesAsk != null ? 100 - yesAsk : null);
  if (yesAsk == null || noAsk == null) {
    return { fire: false, reason: 'no usable ask prices' };
  }

  const yesEdge = Math.round(forecast.p_yes * 100 - yesAsk);
  const noEdge = Math.round((1 - forecast.p_yes) * 100 - noAsk);

  let side, edgeC, priceC;
  if (yesEdge >= noEdge) { side = 'YES'; edgeC = yesEdge; priceC = yesAsk; }
  else { side = 'NO'; edgeC = noEdge; priceC = noAsk; }

  if (edgeC < EDGE_MIN_CENTS) reasons.push(`edge ${edgeC}¢ < ${EDGE_MIN_CENTS}`);

  if (reasons.length) return { fire: false, reason: reasons.join('; '), side, edgeC };

  const sizeUsd = recommendedSizeUsd({ pYes: forecast.p_yes, priceCents: priceC, side });
  if (sizeUsd < 1) {
    return { fire: false, reason: `kelly size < $1 (${sizeUsd.toFixed(2)})`, side, edgeC };
  }

  return {
    fire: true,
    side,
    edgeC,
    spreadC: spread,
    yesPriceC: yesAsk,
    noPriceC: noAsk,
    pickedPriceC: priceC,
    sizeUsd: Math.round(sizeUsd * 100) / 100,
  };
}

module.exports = { evaluate, recommendedSizeUsd, fractionalKelly, hoursUntil, spreadCents };
