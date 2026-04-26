const router = require('express').Router();
const { query } = require('../services/db');
const { runDiscoveryCycle } = require('../services/marketDiscovery');

router.get('/signals', async (req, res) => {
  const status = req.query.status || 'open';
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  let sql;
  if (status === 'open') sql = `SELECT * FROM signals WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT $1`;
  else if (status === 'resolved') sql = `SELECT * FROM signals WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT $1`;
  else sql = `SELECT * FROM signals ORDER BY created_at DESC LIMIT $1`;
  const result = await query(sql, [limit]);
  res.json({ signals: result.rows });
});

router.get('/signals/:id', async (req, res) => {
  const result = await query('SELECT * FROM signals WHERE id=$1', [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'not found' });
  res.json({ signal: result.rows[0] });
});

router.post('/signals/scan', async (req, res) => {
  // Trigger an out-of-band scan. Returns immediately with run id.
  const dryRun = Boolean(req.body?.dryRun);
  res.json({ status: 'started', dryRun });
  runDiscoveryCycle({ dryRun }).catch((err) => console.error('[/signals/scan] cycle error:', err.message));
});

module.exports = router;
