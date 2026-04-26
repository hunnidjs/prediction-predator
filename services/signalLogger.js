const { query } = require('./db');
const { CLASSIFIER_MODEL, FORECAST_MODEL } = require('./anthropic');

async function logSignal({ market, classification, forecast, evaluation, newsBundle, brokerResult, mode }) {
  try {
    const res = await query(
      `INSERT INTO signals (
        market_ticker, event_ticker, question, category, side,
        market_yes_price_cents, market_no_price_cents, spread_cents,
        model_p_yes, confidence, edge_cents, recommended_size_usd, rationale,
        forecast_model, classifier_model, news_sources_used,
        resolves_at, trading_mode, order_action, order_external_id
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
      )
      ON CONFLICT (market_ticker, signal_version, (DATE(created_at))) DO NOTHING
      RETURNING id`,
      [
        market.ticker,
        market.event_ticker || null,
        market.title,
        classification.lane,
        evaluation.side,
        evaluation.yesPriceC,
        evaluation.noPriceC,
        evaluation.spreadC,
        forecast.p_yes,
        forecast.confidence,
        evaluation.edgeC,
        evaluation.sizeUsd,
        forecast.rationale,
        FORECAST_MODEL,
        CLASSIFIER_MODEL,
        newsBundle.sourcesUsed || [],
        market.close_time || null,
        mode,
        brokerResult.action,
        brokerResult.orderExternalId || null,
      ],
    );
    return res.rows[0]?.id || null;
  } catch (err) {
    console.error('[signalLogger] failed:', err.message);
    return null;
  }
}

async function getOpenSignals(limit = 50) {
  const res = await query(
    `SELECT * FROM signals WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows;
}

async function getRecentResolutions(hours = 24) {
  const res = await query(
    `SELECT * FROM signals WHERE resolved_at >= now() - ($1 || ' hours')::interval ORDER BY resolved_at DESC`,
    [String(hours)],
  );
  return res.rows;
}

async function markResolved({ id, outcome, wasCorrect, pnlUsd }) {
  await query(
    `UPDATE signals SET resolved_outcome=$2, was_correct=$3, pnl_usd=$4, resolved_at=now() WHERE id=$1`,
    [id, outcome, wasCorrect, pnlUsd],
  );
}

module.exports = { logSignal, getOpenSignals, getRecentResolutions, markResolved };
