require('dotenv').config();
const path = require('path');
const express = require('express');
const cron = require('node-cron');

const { describeMode } = require('./services/broker');
const { runDiscoveryCycle } = require('./services/marketDiscovery');
const { resolveOpenSignals, refreshCalibrationBuckets, runDailyDigest } = require('./services/resolver');
const { alertSystem } = require('./services/alertService');

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(require('./routes/health'));
app.use(require('./routes/signals'));
app.use(require('./routes/markets'));
app.use(require('./routes/calibration'));
app.use(require('./routes/trade'));

app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

const PORT = Number(process.env.PORT || 3002);

function bootCrons() {
  const discovery = process.env.DISCOVERY_CRON || '*/30 * * * *';
  const resolver = process.env.RESOLVER_CRON || '15 9 * * *';
  const digest = process.env.DAILY_DIGEST_CRON || '0 9 * * *';

  if (cron.validate(discovery)) {
    cron.schedule(discovery, () => {
      runDiscoveryCycle().catch((err) => console.error('[cron:discovery]', err.message));
    });
    console.log(`[cron] discovery scheduled: ${discovery}`);
  } else {
    console.warn(`[cron] invalid DISCOVERY_CRON: ${discovery}`);
  }

  if (cron.validate(resolver)) {
    cron.schedule(resolver, async () => {
      try {
        await resolveOpenSignals();
        await refreshCalibrationBuckets();
      } catch (err) {
        console.error('[cron:resolver]', err.message);
      }
    });
    console.log(`[cron] resolver scheduled: ${resolver}`);
  }

  if (cron.validate(digest)) {
    cron.schedule(digest, () => {
      runDailyDigest().catch((err) => console.error('[cron:digest]', err.message));
    });
    console.log(`[cron] digest scheduled: ${digest}`);
  }
}

const server = app.listen(PORT, () => {
  const { mode, note } = describeMode();
  console.log(`[server] Prediction Predator listening on :${PORT}`);
  console.log(`[server] TRADING_MODE=${mode}${note ? ' (' + note + ')' : ''}`);
  bootCrons();
  alertSystem(`Prediction Predator booted · mode=${mode}`).catch(() => {});
});

function shutdown(signal) {
  console.log(`[server] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandledRejection:', err);
});
