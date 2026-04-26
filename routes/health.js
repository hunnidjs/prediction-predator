const router = require('express').Router();
const kalshi = require('../services/kalshiClient');
const newsAPI = require('../services/feeds/newsAPI');
const alerts = require('../services/alertService');
const { query } = require('../services/db');
const { describeMode } = require('../services/broker');

router.get('/health', async (req, res) => {
  const checks = {
    server: 'ok',
    mode: describeMode(),
    kalshi_configured: kalshi.isConfigured(),
    anthropic_configured: Boolean(process.env.ANTHROPIC_API_KEY),
    newsapi_configured: newsAPI.isConfigured(),
    telegram_configured: alerts.isConfigured(),
  };
  try {
    await query('SELECT 1');
    checks.database = 'ok';
  } catch (err) {
    checks.database = `error: ${err.message}`;
  }
  res.json(checks);
});

module.exports = router;
