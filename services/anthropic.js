const Anthropic = require('@anthropic-ai/sdk');

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[anthropic] ANTHROPIC_API_KEY not set — Claude calls will fail');
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001';
const FORECAST_MODEL = process.env.FORECAST_MODEL || 'claude-sonnet-4-6';

async function chat({ model, system, user, maxTokens = 1024, temperature = 0.2, jsonMode = true }) {
  const messages = [{ role: 'user', content: user }];
  const resp = await client.messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages,
  });
  const text = resp.content?.map((c) => c.text || '').join('') || '';
  if (!jsonMode) return { text, usage: resp.usage };
  const parsed = extractJSON(text);
  return { text, parsed, usage: resp.usage };
}

function extractJSON(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

module.exports = { client, chat, CLASSIFIER_MODEL, FORECAST_MODEL };
