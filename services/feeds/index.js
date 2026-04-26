const newsAPI = require('./newsAPI');
const hackernews = require('./hackernews');

async function gatherNewsFor(query, { lane }) {
  const tasks = [];
  if (newsAPI.isConfigured()) tasks.push(newsAPI.search(query, { pageSize: 8 }).then((r) => ({ source: 'newsapi', ...r })));
  if (lane === 'tech') tasks.push(hackernews.search(query, { hitsPerPage: 6 }).then((r) => ({ source: 'hackernews', ...r })));

  const settled = await Promise.allSettled(tasks);
  const articles = [];
  const sourcesUsed = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value.articles?.length) {
      articles.push(...s.value.articles.map((a) => ({ ...a, _source: s.value.source })));
      sourcesUsed.push(s.value.source);
    }
  }
  articles.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  return { articles: articles.slice(0, 15), sourcesUsed };
}

module.exports = { gatherNewsFor };
