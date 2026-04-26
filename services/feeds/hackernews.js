const axios = require('axios');

const BASE = 'https://hn.algolia.com/api/v1';

async function search(q, { tags = 'story', hitsPerPage = 10, hoursBack = 168 } = {}) {
  const numericFilters = `created_at_i>${Math.floor((Date.now() - hoursBack * 3600 * 1000) / 1000)}`;
  try {
    const res = await axios.get(`${BASE}/search`, {
      params: { query: q, tags, hitsPerPage, numericFilters },
      timeout: 10000,
    });
    return {
      articles: (res.data.hits || []).map((h) => ({
        title: h.title,
        url: h.url,
        source: 'Hacker News',
        publishedAt: h.created_at,
        points: h.points,
        commentsCount: h.num_comments,
      })),
    };
  } catch (err) {
    console.warn('[hackernews] failed:', err.message);
    return { articles: [], reason: err.message };
  }
}

module.exports = { search };
