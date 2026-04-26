const { chat, FORECAST_MODEL } = require('./anthropic');
const { renderForPrompt } = require('./newsBundler');

const SYSTEM = `You are a probabilistic forecaster for a Kalshi prediction-market trading bot.

Your job: read a market question, the resolution rules, the current market price, and a bundle of recent news, then output a calibrated probability that YES resolves true.

CRITICAL RULES:
1. Calibration matters more than confidence. If you don't know, say so — return wide uncertainty (confidence < 0.6) and the bot will skip.
2. NEVER anchor on the market price. Form your own forecast first; we compare to market separately.
3. If the market is fundamentally unknowable from public news (insider sports info, private corporate decisions, weather), set abstain=true.
4. If the market resolves on a specific data print or event you can't verify, set abstain=true.
5. If news contradicts itself or is too thin (< 2 substantive articles), confidence should be ≤ 0.65.
6. Base rates matter: how often have similar things happened? State the base rate explicitly in your reasoning.
7. Be honest about look-ahead-free reasoning — only use info available BEFORE the market resolves.

OUTPUT (JSON only, no prose):
{
  "abstain": boolean,
  "abstain_reason": "<string or null>",
  "p_yes": <number 0..1>,
  "confidence": <number 0..1, your confidence in your p_yes>,
  "rationale": "<2-4 sentences: base rate, key evidence, residual uncertainty>",
  "key_facts": ["<fact 1>", "<fact 2>", ...]
}`;

function buildUserPrompt({ market, newsBundle }) {
  const yesCents = market.yes_bid != null ? `bid ${market.yes_bid}¢ / ask ${market.yes_ask}¢` : `${market.last_price ?? '?'}¢`;
  return [
    `MARKET TICKER: ${market.ticker}`,
    `LANE: ${market.lane || 'unknown'}`,
    `QUESTION: ${market.title}`,
    market.subtitle ? `SUBTITLE: ${market.subtitle}` : '',
    market.rules_primary ? `RESOLUTION RULES:\n${market.rules_primary.slice(0, 1500)}` : '',
    `CURRENT MARKET PRICE: YES ${yesCents}`,
    `CLOSES: ${market.close_time}`,
    '',
    `RECENT NEWS BUNDLE (search: "${newsBundle.query}"):`,
    renderForPrompt(newsBundle),
    '',
    'Output JSON only.',
  ].filter(Boolean).join('\n');
}

async function forecast({ market, newsBundle }) {
  try {
    const { parsed, text, usage } = await chat({
      model: FORECAST_MODEL,
      system: SYSTEM,
      user: buildUserPrompt({ market, newsBundle }),
      maxTokens: 1200,
      temperature: 0.3,
    });

    if (!parsed) {
      console.warn('[forecast] parse failed for', market.ticker, '— raw:', text.slice(0, 300));
      return { abstain: true, abstain_reason: 'forecast_parse_failed', p_yes: 0.5, confidence: 0, rationale: '', key_facts: [], usage };
    }

    const cleaned = {
      abstain: Boolean(parsed.abstain),
      abstain_reason: parsed.abstain_reason || null,
      p_yes: Number.isFinite(parsed.p_yes) ? Math.max(0.001, Math.min(0.999, parsed.p_yes)) : 0.5,
      confidence: Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
      rationale: String(parsed.rationale || '').slice(0, 2000),
      key_facts: Array.isArray(parsed.key_facts) ? parsed.key_facts.slice(0, 8).map(String) : [],
      usage,
    };
    return cleaned;
  } catch (err) {
    console.error('[forecast] Claude call failed for', market.ticker, err.message);
    return { abstain: true, abstain_reason: `forecast_error: ${err.message}`, p_yes: 0.5, confidence: 0, rationale: '', key_facts: [] };
  }
}

module.exports = { forecast };
