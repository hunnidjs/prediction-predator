const axios = require('axios');
const crypto = require('crypto');
const { query } = require('../db');

const KEY = process.env.NEWSAPI_KEY;
const BASE = 'https://newsapi.org/v2';
const CACHE_TTL_MS = 30 * 60 * 1000;

function isConfigured() {
  return Boolean(KEY);
}

function hashQuery(parts) {
  return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex');
}

async function getCached(queryHash) {
  try {
    const res = await query(
      'SELECT payload, fetched_at FROM news_cache WHERE query_hash=$1 ORDER BY fetched_at DESC LIMIT 1',
      [queryHash],
    );
    if (!res.rows.length) return null;
    const age = Date.now() - new Date(res.rows[0].fetched_at).getTime();
    if (age > CACHE_TTL_MS) return null;
    return res.rows[0].payload;
  } catch {
    return null;
  }
}

async function storeCache(queryHash, source, queryStr, payload) {
  try {
    await query(
      'INSERT INTO news_cache (query_hash, source, query, payload) VALUES ($1, $2, $3, $4)',
      [queryHash, source, queryStr, payload],
    );
  } catch (err) {
    console.warn('[newsAPI] cache write failed:', err.message);
  }
}

async function search(q, { pageSize = 10, language = 'en', sortBy = 'relevancy', from = null } = {}) {
  if (!isConfigured()) return { articles: [], reason: 'no_api_key' };
  const params = { q, pageSize, language, sortBy, apiKey: KEY };
  if (from) params.from = from;
  const queryHash = hashQuery({ q, pageSize, language, sortBy, from });
  const cached = await getCached(queryHash);
  if (cached) return { articles: cached.articles || [], cached: true };
  try {
    const res = await axios.get(`${BASE}/everything`, { params, timeout: 12000 });
    const payload = {
      articles: (res.data.articles || []).map((a) => ({
        title: a.title,
        description: a.description,
        url: a.url,
        source: a.source?.name,
        publishedAt: a.publishedAt,
      })),
    };
    await storeCache(queryHash, 'newsapi', q, payload);
    return { articles: payload.articles, cached: false };
  } catch (err) {
    console.warn('[newsAPI] request failed:', err.response?.status, err.message);
    return { articles: [], reason: err.message };
  }
}

module.exports = { isConfigured, search };
