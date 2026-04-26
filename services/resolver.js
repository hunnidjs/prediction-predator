const kalshi = require('./kalshiClient');
const { query } = require('./db');
const { markResolved, getOpenSignals } = require('./signalLogger');
const { alertResolution, dailyDigest } = require('./alertService');

function pnlForSignal(signal, outcome) {
  // Kalshi binary: each contract pays $1 if your side wins, $0 if it loses.
  // Cost basis = contracts × price/100. We track "what we WOULD have made" even in signals mode.
  const contracts = Math.floor((Number(signal.recommended_size_usd) * 100) / signal.market_yes_price_cents) || 0;
  const wonSide = outcome === 'YES' ? 'YES' : outcome === 'NO' ? 'NO' : null;
  if (!wonSide) return 0;
  const won = signal.side === wonSide;
  const priceCents = signal.side === 'YES' ? signal.market_yes_price_cents : signal.market_no_price_cents;
  const cost = contracts * (priceCents / 100);
  const payout = won ? contracts * 1.0 : 0;
  return Math.round((payout - cost) * 100) / 100;
}

async function resolveOpenSignals() {
  const open = await getOpenSignals(500);
  console.log(`[resolver] checking ${open.length} open signals`);
  let resolved = 0;
  for (const signal of open) {
    try {
      const data = await kalshi.getMarket(signal.market_ticker);
      const market = data?.market;
      if (!market) continue;
      if (market.status !== 'settled' && market.status !== 'finalized') continue;
      const outcome = market.result === 'yes' ? 'YES' : market.result === 'no' ? 'NO' : null;
      if (!outcome) continue;
      const wasCorrect = outcome === signal.side;
      const pnl = pnlForSignal(signal, outcome);
      await markResolved({ id: signal.id, outcome, wasCorrect, pnlUsd: pnl });
      await alertResolution({ signal, outcome, wasCorrect, pnlUsd: pnl }).catch(() => {});
      resolved++;
    } catch (err) {
      console.warn('[resolver] failed for', signal.market_ticker, err.message);
    }
  }
  console.log(`[resolver] resolved ${resolved} signals`);
  return { checked: open.length, resolved };
}

async function refreshCalibrationBuckets() {
  // Bucket model_p_yes in 0.1 bins, observe yes-resolved fraction.
  await query(`
    INSERT INTO calibration_buckets (bucket_lower, bucket_upper, category, signal_count, yes_resolved_count, observed_freq, last_updated)
    SELECT
      FLOOR(model_p_yes * 10) / 10.0 AS bucket_lower,
      FLOOR(model_p_yes * 10) / 10.0 + 0.1 AS bucket_upper,
      category,
      COUNT(*)::int AS signal_count,
      SUM(CASE WHEN resolved_outcome='YES' THEN 1 ELSE 0 END)::int AS yes_resolved_count,
      (SUM(CASE WHEN resolved_outcome='YES' THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0)) AS observed_freq,
      now()
    FROM signals
    WHERE resolved_outcome IS NOT NULL
    GROUP BY 1, 2, 3
    ON CONFLICT (bucket_lower, bucket_upper, category) DO UPDATE SET
      signal_count = EXCLUDED.signal_count,
      yes_resolved_count = EXCLUDED.yes_resolved_count,
      observed_freq = EXCLUDED.observed_freq,
      last_updated = EXCLUDED.last_updated
  `);
}

async function brierScore() {
  const res = await query(`
    SELECT AVG(POWER(model_p_yes - CASE WHEN resolved_outcome='YES' THEN 1 ELSE 0 END, 2)) AS brier
    FROM signals WHERE resolved_outcome IS NOT NULL
  `);
  return Number(res.rows[0]?.brier) || null;
}

async function runDailyDigest() {
  try {
    const open = await getOpenSignals(100);
    const recent = await query(
      `SELECT * FROM signals WHERE resolved_at >= now() - interval '24 hours' ORDER BY resolved_at DESC`,
    );
    const brier = await brierScore();
    await dailyDigest({
      openSignals: open,
      recentResolutions: recent.rows,
      calibration: { brierScore: brier },
    });
  } catch (err) {
    console.warn('[resolver] digest failed:', err.message);
  }
}

module.exports = { resolveOpenSignals, refreshCalibrationBuckets, brierScore, runDailyDigest };
