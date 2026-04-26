const kalshi = require('./kalshiClient');
const { classifyOrCache } = require('./marketClassifier');
const { bundleForMarket } = require('./newsBundler');
const { forecast } = require('./forecastAgent');
const { evaluate, hoursUntil } = require('./edgeEvaluator');
const { logSignal } = require('./signalLogger');
const { placeOrderForSignal, describeMode } = require('./broker');
const { alertSignal, alertError } = require('./alertService');
const { query } = require('./db');

const MIN_HOURS = Number(process.env.MIN_HOURS_TO_RESOLUTION || 24);
const MAX_DAYS = Number(process.env.MAX_DAYS_TO_RESOLUTION || 180);
const PER_RUN_EVENT_CAP = Number(process.env.PER_RUN_EVENT_CAP || 300);
const PER_RUN_FORECAST_CAP = Number(process.env.PER_RUN_FORECAST_CAP || 25);
const CLASSIFY_CAP = Number(process.env.CLASSIFY_CAP || 80);

// Categories from /events that are explicitly out-of-scope per CLAUDE.md.
// Skipping at the event stage saves classifier spend on hundreds of markets.
const CATEGORY_DENYLIST = new Set([
  'Elections',
  'Politics',
  'Economics',
  'Financials',
  'Crypto',
  'Climate and Weather',
]);

// "1 leg max" rule: every Kalshi multi-variable / parlay market starts with
// KXMVE (Kalshi Multi-Variable Event). These dominate /markets default
// ordering by open_interest but are never forecastable — joint probabilities
// of independent conditions can't be derived from public news.
const PARLAY_TICKER_PREFIX = 'KXMVE';

let _running = false;

function isParlayTicker(ticker) {
  return typeof ticker === 'string' && ticker.startsWith(PARLAY_TICKER_PREFIX);
}

function withinResolutionWindow(market) {
  const h = hoursUntil(market.close_time);
  return h >= MIN_HOURS && h / 24 <= MAX_DAYS;
}

async function fetchInScopeEventsPaginated(maxEvents) {
  const out = [];
  let cursor = null;
  let totalSeen = 0;
  while (out.length < maxEvents) {
    const page = await kalshi.listEvents({ status: 'open', limit: 200, cursor });
    const events = page?.events || [];
    if (!events.length) break;
    totalSeen += events.length;
    for (const event of events) {
      if (CATEGORY_DENYLIST.has(event.category)) continue;
      out.push(event);
      if (out.length >= maxEvents) break;
    }
    cursor = page.cursor || null;
    if (!cursor) break;
  }
  return { events: out, totalSeen };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMarketsForEvents(events) {
  // Throttle to be polite to Kalshi (they 429 readily). publicRequest
  // already retries with backoff, but spacing avoids triggering it.
  const all = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    try {
      const data = await kalshi.listOpenMarkets({ eventTicker: event.event_ticker });
      const markets = data?.markets || [];
      for (const m of markets) {
        m.event_category = event.category;
        m.event_title = event.title;
      }
      all.push(...markets);
    } catch (err) {
      console.warn('[discovery] event-markets fetch failed:', event.event_ticker, err.message);
    }
    if (i < events.length - 1) await sleep(80);
  }
  return all;
}

function rankCandidates(markets) {
  // Adapter normalizes sentinel/no-offer prices to null. A market is a
  // candidate if AT LEAST ONE side has a real ask — edgeEvaluator picks
  // the side with positive edge later.
  return markets
    .filter(withinResolutionWindow)
    .filter((m) => !isParlayTicker(m.ticker))
    .filter((m) => m.yes_ask != null || m.no_ask != null)
    .sort((a, b) => {
      const liquidityA = (a.volume_24h || a.volume || 0) + (a.open_interest || 0);
      const liquidityB = (b.volume_24h || b.volume || 0) + (b.open_interest || 0);
      return liquidityB - liquidityA;
    });
}

async function startScanRun() {
  const res = await query('INSERT INTO scan_runs (started_at) VALUES (now()) RETURNING id');
  return res.rows[0].id;
}

async function finishScanRun(id, stats) {
  await query(
    `UPDATE scan_runs SET finished_at=now(), markets_scanned=$2, markets_classified_in_scope=$3,
     signals_fired=$4, errors_count=$5, notes=$6 WHERE id=$1`,
    [id, stats.scanned, stats.inScope, stats.fired, stats.errors, stats.notes || null],
  );
}

async function runDiscoveryCycle({ dryRun = false } = {}) {
  if (_running) {
    console.warn('[discovery] cycle already running, skipping');
    return { skipped: true };
  }
  _running = true;
  const stats = { scanned: 0, inScope: 0, fired: 0, errors: 0 };
  let runId = null;
  try {
    runId = await startScanRun();
    console.log('[discovery] starting scan run', runId);

    const { events, totalSeen } = await fetchInScopeEventsPaginated(PER_RUN_EVENT_CAP);
    console.log(`[discovery] events: ${totalSeen} seen, ${events.length} in allowed categories`);

    const allMarkets = await fetchMarketsForEvents(events);
    stats.scanned = allMarkets.length;
    console.log(`[discovery] fetched ${allMarkets.length} markets across ${events.length} events`);

    const candidates = rankCandidates(allMarkets);
    console.log(`[discovery] ${candidates.length} candidates after window+parlay+price filters`);

    const inScope = [];
    for (const market of candidates.slice(0, CLASSIFY_CAP)) {
      try {
        const classification = await classifyOrCache(market);
        if (classification.in_scope) {
          inScope.push({ market, classification });
        }
      } catch (err) {
        console.warn('[discovery] classify error:', market.ticker, err.message);
        stats.errors++;
      }
    }
    stats.inScope = inScope.length;
    console.log(`[discovery] ${inScope.length} markets in-scope after classification`);

    const toForecast = inScope.slice(0, PER_RUN_FORECAST_CAP);
    for (const { market, classification } of toForecast) {
      try {
        const newsBundle = await bundleForMarket(market, classification.lane);
        const fcst = await forecast({ market: { ...market, lane: classification.lane }, newsBundle });
        if (fcst.abstain) {
          console.log(`[discovery] ${market.ticker} abstain: ${fcst.abstain_reason}`);
          continue;
        }
        const evaluation = evaluate({ market, forecast: fcst });
        if (!evaluation.fire) {
          console.log(`[discovery] ${market.ticker} no fire: ${evaluation.reason}`);
          continue;
        }
        if (dryRun) {
          console.log(`[discovery] [dry] would fire ${market.ticker} ${evaluation.side} edge=${evaluation.edgeC}¢`);
          continue;
        }
        const signalRow = {
          market_ticker: market.ticker,
          event_ticker: market.event_ticker,
          question: market.title,
          category: classification.lane,
          side: evaluation.side,
          market_yes_price_cents: evaluation.yesPriceC,
          market_no_price_cents: evaluation.noPriceC,
          spread_cents: evaluation.spreadC,
          model_p_yes: fcst.p_yes,
          confidence: fcst.confidence,
          edge_cents: evaluation.edgeC,
          recommended_size_usd: evaluation.sizeUsd,
          rationale: fcst.rationale,
        };
        const brokerResult = await placeOrderForSignal(signalRow);
        const { mode } = describeMode();
        const id = await logSignal({
          market: { ...market, lane: classification.lane },
          classification,
          forecast: fcst,
          evaluation,
          newsBundle,
          brokerResult,
          mode,
        });
        if (id) {
          stats.fired++;
          await alertSignal(signalRow, brokerResult).catch((e) => console.warn('[discovery] alert failed:', e.message));
        } else {
          console.log(`[discovery] ${market.ticker} signal already logged today, skipping alert`);
        }
      } catch (err) {
        console.warn('[discovery] forecast/eval error:', market.ticker, err.message);
        stats.errors++;
      }
    }
  } catch (err) {
    console.error('[discovery] cycle error:', err.message);
    stats.errors++;
    await alertError(`Discovery cycle error: ${err.message}`).catch(() => {});
  } finally {
    if (runId) await finishScanRun(runId, stats).catch(() => {});
    _running = false;
    console.log('[discovery] cycle done', stats);
  }
  return stats;
}

module.exports = { runDiscoveryCycle };
