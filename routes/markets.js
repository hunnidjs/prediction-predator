const router = require('express').Router();
const kalshi = require('../services/kalshiClient');
const { query } = require('../services/db');

router.get('/markets', async (req, res) => {
  try {
    const data = await kalshi.listOpenMarkets({ limit: Number(req.query.limit) || 50 });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/markets/:ticker', async (req, res) => {
  try {
    const data = await kalshi.getMarket(req.params.ticker);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/markets/:ticker/orderbook', async (req, res) => {
  try {
    const data = await kalshi.getOrderbook(req.params.ticker);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/classifications', async (req, res) => {
  const inScope = req.query.in_scope === 'true' ? true : req.query.in_scope === 'false' ? false : null;
  let sql = 'SELECT * FROM market_classifications';
  const params = [];
  if (inScope !== null) {
    sql += ' WHERE in_scope=$1';
    params.push(inScope);
  }
  sql += ' ORDER BY classified_at DESC LIMIT 200';
  const result = await query(sql, params);
  res.json({ classifications: result.rows });
});

module.exports = router;
