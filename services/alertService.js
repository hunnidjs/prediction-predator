const axios = require('axios');

const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;

function isConfigured() {
  return Boolean(BOT && CHAT);
}

async function sendMessage(text, { silent = false } = {}) {
  if (!isConfigured()) {
    console.log('[alert] (telegram unconfigured) ', text.slice(0, 200));
    return { ok: false, reason: 'unconfigured' };
  }
  try {
    const url = `https://api.telegram.org/bot${BOT}/sendMessage`;
    const res = await axios.post(url, {
      chat_id: CHAT,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: silent,
    }, { timeout: 10000 });
    return { ok: true, data: res.data };
  } catch (err) {
    console.error('[alert] telegram send failed:', err.response?.data || err.message);
    return { ok: false, reason: err.message };
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function alertSignal(signal, brokerResult) {
  const sideEmoji = signal.side === 'YES' ? '✅' : '❌';
  const edgePct = (signal.edge_cents / 100).toFixed(2);
  const modeBadge = brokerResult?.mode === 'live' ? '🔴 LIVE'
    : brokerResult?.mode === 'paper' ? '📄 PAPER'
    : '🔍 SIGNAL';
  const action = brokerResult?.action || 'logged';

  const lines = [
    `${modeBadge}  ${sideEmoji} <b>${escapeHtml(signal.side)}</b> — ${escapeHtml(signal.category)}`,
    `<i>${escapeHtml(signal.question)}</i>`,
    '',
    `Market: <b>${signal.market_yes_price_cents}¢</b> YES / <b>${signal.market_no_price_cents}¢</b> NO`,
    `Model: <b>${(signal.model_p_yes * 100).toFixed(0)}%</b> YES (conf ${(signal.confidence * 100).toFixed(0)}%)`,
    `Edge: <b>${signal.edge_cents}¢</b> · Spread: ${signal.spread_cents}¢`,
    `Size: $${Number(signal.recommended_size_usd).toFixed(2)}`,
    '',
    `<b>Why:</b> ${escapeHtml(signal.rationale).slice(0, 800)}`,
    '',
    `<code>${escapeHtml(signal.market_ticker)}</code> · ${action}`,
  ];
  return sendMessage(lines.join('\n'));
}

async function alertResolution({ signal, outcome, wasCorrect, pnlUsd }) {
  const emoji = wasCorrect ? '🎯' : '💥';
  const txt = [
    `${emoji} <b>RESOLVED</b> — ${escapeHtml(signal.category)}`,
    `<i>${escapeHtml(signal.question)}</i>`,
    `Bet: ${signal.side} @ ${signal.market_yes_price_cents}¢ · Outcome: <b>${outcome}</b>`,
    `Model said: ${(signal.model_p_yes * 100).toFixed(0)}% YES (conf ${(signal.confidence * 100).toFixed(0)}%)`,
    `P&L: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}`,
  ].join('\n');
  return sendMessage(txt);
}

async function alertSystem(text, { silent = true } = {}) {
  return sendMessage(`⚙️ ${text}`, { silent });
}

async function alertError(text) {
  return sendMessage(`🚨 <b>ERROR</b>\n${escapeHtml(text)}`);
}

async function dailyDigest({ openSignals, recentResolutions, calibration }) {
  const lines = ['📊 <b>Daily Digest</b>', ''];
  lines.push(`Open signals: <b>${openSignals.length}</b>`);
  if (recentResolutions.length) {
    const wins = recentResolutions.filter((r) => r.was_correct).length;
    lines.push(`Last 24h resolved: ${recentResolutions.length} · ${wins} correct`);
  }
  if (calibration?.brierScore != null) {
    lines.push(`Lifetime Brier: ${calibration.brierScore.toFixed(3)} (lower = better, 0.25 = coinflip)`);
  }
  return sendMessage(lines.join('\n'), { silent: true });
}

module.exports = {
  isConfigured,
  sendMessage,
  alertSignal,
  alertResolution,
  alertSystem,
  alertError,
  dailyDigest,
};
