const router = require('express').Router();
const { query } = require('../services/db');
const { brierScore, refreshCalibrationBuckets } = require('../services/resolver');

router.get('/calibration', async (req, res) => {
  await refreshCalibrationBuckets().catch(() => {});
  const buckets = await query(`SELECT * FROM calibration_buckets ORDER BY category, bucket_lower`);
  const brier = await brierScore();
  const summary = await query(`
    SELECT
      COUNT(*) FILTER (WHERE resolved_outcome IS NULL) AS open_count,
      COUNT(*) FILTER (WHERE resolved_outcome IS NOT NULL) AS resolved_count,
      COUNT(*) FILTER (WHERE was_correct=true) AS correct_count,
      COUNT(*) FILTER (WHERE was_correct=false) AS wrong_count,
      SUM(pnl_usd) AS total_pnl_usd
    FROM signals
  `);
  res.json({ buckets: buckets.rows, brier, summary: summary.rows[0] });
});

router.get('/calibration/by-category', async (req, res) => {
  const result = await query(`
    SELECT
      category,
      COUNT(*) FILTER (WHERE resolved_outcome IS NOT NULL) AS resolved,
      COUNT(*) FILTER (WHERE was_correct=true) AS correct,
      AVG(POWER(model_p_yes - CASE WHEN resolved_outcome='YES' THEN 1 ELSE 0 END, 2))
        FILTER (WHERE resolved_outcome IS NOT NULL) AS brier,
      SUM(pnl_usd) AS pnl_usd
    FROM signals GROUP BY category
  `);
  res.json({ rows: result.rows });
});

module.exports = router;
