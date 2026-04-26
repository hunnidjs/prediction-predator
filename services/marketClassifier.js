const { chat, CLASSIFIER_MODEL } = require('./anthropic');
const { query } = require('./db');

const SYSTEM = `You classify Kalshi prediction markets for an AI trading bot called Prediction Predator.

LANES THE BOT TRADES (in_scope=true):
- "tech": tech/AI company milestones, product launches, IPOs, stock-price targets, model releases, app metrics, layoffs at named companies.
- "current_events": breaking news, cultural happenings, geopolitical events, deaths/announcements, box office, awards, viral phenomena.
- "sports_arb": sports markets ONLY when there is an identifiable news/information angle a forecaster could exploit (e.g. post-injury announcement, pre-trade rumor, regulatory or eligibility change, breaking-news driven prop). Generic sports props or "thin liquidity" alone do NOT qualify.

LANES EXPLICITLY OUT OF SCOPE (in_scope=false):
- Anything Fed/economy/interest rates/CPI/GDP/jobs (econ — user views as rigged).
- Anything elections/political-figure-actions/legislation passing (politics — user views as rigged).
- Weather (out of scope for v1).
- Crypto price targets (out of scope for v1).
- Straight game-winner sports lines vs Vegas favorites.
- Multi-leg parlays of any kind: markets where multiple independent conditions must all simultaneously resolve YES (same-game parlays, cross-category combos, "all of these players record 2+ hits", multi-game/multi-player props). Joint probabilities are not forecastable from public news.
- Markets that are clearly inactive or untradeable (0¢ bid AND 0¢ ask, or no liquidity signal at all).

DEFAULT: When in doubt, in_scope=false. False positives waste forecaster spend; false negatives can be recovered by widening this prompt later.

Reply ONLY with JSON, no prose:
{"in_scope": boolean, "lane": "tech"|"current_events"|"sports_arb"|null, "reason": "<one sentence>"}`;

async function classifyMarket({ ticker, title, subtitle, eventTitle, rulesPrimary, closeTs }) {
  const userPrompt = [
    `Market ticker: ${ticker}`,
    eventTitle ? `Event: ${eventTitle}` : '',
    `Question/title: ${title}`,
    subtitle ? `Subtitle: ${subtitle}` : '',
    rulesPrimary ? `Resolution rules: ${rulesPrimary.slice(0, 600)}` : '',
    closeTs ? `Closes at: ${closeTs}` : '',
  ].filter(Boolean).join('\n');

  try {
    const { parsed, text } = await chat({
      model: CLASSIFIER_MODEL,
      system: SYSTEM,
      user: userPrompt,
      maxTokens: 200,
      temperature: 0.1,
    });
    if (!parsed || typeof parsed.in_scope !== 'boolean') {
      console.warn('[classifier] could not parse output for', ticker, '— raw:', text.slice(0, 200));
      return { in_scope: false, lane: null, reason: 'classifier_parse_failed' };
    }
    return parsed;
  } catch (err) {
    console.warn('[classifier] Claude call failed for', ticker, err.message);
    return { in_scope: false, lane: null, reason: `classifier_error: ${err.message}` };
  }
}

async function getCachedClassification(ticker) {
  try {
    const res = await query(
      'SELECT in_scope, category, reason, classified_at FROM market_classifications WHERE market_ticker=$1',
      [ticker],
    );
    return res.rows[0] || null;
  } catch {
    return null;
  }
}

async function saveClassification(ticker, classification, resolvesAt) {
  try {
    await query(
      `INSERT INTO market_classifications (market_ticker, in_scope, category, reason, classifier_model, resolves_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (market_ticker) DO UPDATE
       SET in_scope=EXCLUDED.in_scope, category=EXCLUDED.category, reason=EXCLUDED.reason,
           classifier_model=EXCLUDED.classifier_model, classified_at=now()`,
      [ticker, classification.in_scope, classification.lane, classification.reason, CLASSIFIER_MODEL, resolvesAt],
    );
  } catch (err) {
    console.warn('[classifier] save failed:', err.message);
  }
}

async function classifyOrCache(market) {
  const cached = await getCachedClassification(market.ticker);
  if (cached) {
    return { in_scope: cached.in_scope, lane: cached.category, reason: cached.reason, cached: true };
  }
  const result = await classifyMarket({
    ticker: market.ticker,
    title: market.title,
    subtitle: market.subtitle,
    eventTitle: market.event_title,
    rulesPrimary: market.rules_primary,
    closeTs: market.close_time,
  });
  await saveClassification(market.ticker, result, market.close_time);
  return { ...result, cached: false };
}

module.exports = { classifyMarket, classifyOrCache };
