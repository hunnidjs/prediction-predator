const { gatherNewsFor } = require('./feeds');

function buildSearchQuery(market) {
  // Prefer subtitle if it's specific, fallback to title cleaned
  const candidates = [market.subtitle, market.title].filter(Boolean);
  let q = candidates[0] || '';
  q = q.replace(/\?/g, '').replace(/[“”"']/g, '').trim();
  if (q.length > 150) q = q.slice(0, 150);
  return q;
}

async function bundleForMarket(market, lane) {
  const q = buildSearchQuery(market);
  if (!q) return { articles: [], sourcesUsed: [], query: '' };
  const result = await gatherNewsFor(q, { lane });
  return { ...result, query: q };
}

function renderForPrompt(bundle) {
  if (!bundle.articles?.length) return '(no recent news articles found for this market)';
  return bundle.articles.map((a, i) => {
    const date = a.publishedAt ? new Date(a.publishedAt).toISOString().slice(0, 10) : 'undated';
    return `[${i + 1}] (${date}, ${a.source || a._source})\n${a.title}\n${a.description || ''}\n${a.url}`;
  }).join('\n\n');
}

module.exports = { bundleForMarket, renderForPrompt };
