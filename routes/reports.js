const router = require('express').Router();
const { query } = require('../services/db');
const { brierScore } = require('../services/resolver');
const { sendMessage } = require('../services/alertService');

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function buildSoakReport(hours) {
  const scanStats = await query(
    `SELECT
       COUNT(*)::int AS total,
       COALESCE(AVG(markets_scanned), 0)::numeric(10,1) AS avg_scanned,
       COALESCE(AVG(markets_classified_in_scope), 0)::numeric(10,1) AS avg_in_scope,
       COALESCE(SUM(errors_count), 0)::int AS total_errors,
       MAX(finished_at) AS latest_finished
     FROM scan_runs
     WHERE started_at >= now() - make_interval(hours => $1)
       AND finished_at IS NOT NULL`,
    [hours],
  );

  const firedSignals = await query(
    `SELECT id, market_ticker, category, side, edge_cents, model_p_yes, confidence,
            recommended_size_usd, question, created_at, resolved_outcome, was_correct, pnl_usd
       FROM signals
      WHERE created_at >= now() - make_interval(hours => $1)
      ORDER BY created_at DESC`,
    [hours],
  );

  const openCount = await query(
    `SELECT COUNT(*)::int AS n FROM signals WHERE resolved_at IS NULL`,
  );

  const catStats = await query(
    `SELECT COALESCE(category, 'unknown') AS category, COUNT(*)::int AS n
       FROM market_classifications
      WHERE classified_at >= now() - make_interval(hours => $1)
        AND in_scope = true
      GROUP BY 1
      ORDER BY n DESC
      LIMIT 10`,
    [hours],
  );

  let brier = null;
  try { brier = await brierScore(); } catch { brier = null; }

  return {
    windowHours: hours,
    scans: scanStats.rows[0],
    fired: firedSignals.rows,
    openTotal: openCount.rows[0].n,
    brierScore: brier,
    inScopeByCategory: catStats.rows,
  };
}

function recommendation(report) {
  const total = Number(report.scans.total);
  const avgInScope = Number(report.scans.avg_in_scope);
  const fired = report.fired.length;

  if (total === 0) {
    return 'No scans recorded in window — cron may not be firing. Check UptimeRobot keep-alive and Render logs.';
  }
  if (avgInScope < 1) {
    return 'Avg in-scope markets < 1/scan — classifier or category denylist may be too restrictive. Investigate before tuning gates.';
  }
  if (fired === 0 && avgInScope >= 5) {
    return 'Healthy in-scope volume but zero fires; gates (8¢ edge / 0.75 confidence) are doing their job. Hold for another 48h before tuning.';
  }
  if (fired === 0) {
    return 'Some in-scope volume but no fires yet. Soak more before drawing conclusions.';
  }
  return `${fired} signal(s) fired in window — review individual outcomes; tuning premature until more resolve.`;
}

function formatTelegram(report) {
  const { windowHours, scans, fired, openTotal, brierScore: brier, inScopeByCategory } = report;
  const lines = [`📊 <b>${windowHours}h Soak Report</b>`, ''];
  lines.push(`<b>Scans:</b> ${scans.total} completed (${scans.total_errors} errors)`);
  lines.push(`<b>Avg/scan:</b> ${scans.avg_scanned} markets · ${scans.avg_in_scope} in-scope`);
  lines.push(`<b>Signals:</b> ${fired.length} fired in window · ${openTotal} open total`);
  if (brier != null) {
    lines.push(`<b>Brier:</b> ${Number(brier).toFixed(3)} (lower = better, 0.25 = coinflip)`);
  }
  if (inScopeByCategory.length) {
    lines.push('');
    lines.push('<b>In-scope categories:</b>');
    inScopeByCategory.forEach((c) => lines.push(`  • ${escapeHtml(c.category)}: ${c.n}`));
  }
  if (fired.length) {
    lines.push('');
    lines.push('<b>Recent fires:</b>');
    fired.slice(0, 8).forEach((s) => {
      const conf = (Number(s.confidence) * 100).toFixed(0);
      lines.push(`  • ${escapeHtml(s.category)} ${s.side} @ ${s.edge_cents}¢ (conf ${conf}%) — <code>${escapeHtml(s.market_ticker)}</code>`);
    });
  }
  lines.push('');
  lines.push(`<i>${escapeHtml(recommendation(report))}</i>`);
  return lines.join('\n');
}

router.post('/reports/soak', async (req, res) => {
  const raw = Number(req.query.hours ?? req.body?.hours ?? 48);
  const hours = Math.max(1, Math.min(168, Number.isFinite(raw) ? raw : 48));
  try {
    const report = await buildSoakReport(hours);
    const msg = formatTelegram(report);
    const tg = await sendMessage(msg, { silent: true });
    res.json({ status: 'ok', windowHours: hours, telegram_sent: tg.ok, summary: report });
  } catch (err) {
    console.error('[/reports/soak] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
