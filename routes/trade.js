const router = require('express').Router();
const kalshi = require('../services/kalshiClient');
const { describeMode } = require('../services/broker');

router.get('/trade/mode', (req, res) => {
  res.json(describeMode());
});

router.get('/trade/balance', async (req, res) => {
  if (!kalshi.isConfigured()) return res.status(400).json({ error: 'kalshi not configured' });
  try {
    const data = await kalshi.getBalance();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/trade/positions', async (req, res) => {
  if (!kalshi.isConfigured()) return res.status(400).json({ error: 'kalshi not configured' });
  try {
    const data = await kalshi.getPositions();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
