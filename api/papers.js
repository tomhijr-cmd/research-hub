/**
 * Vercel serverless function: /api/papers
 *
 * Proxies requests to the Semantic Scholar API.
 * The browser calls this endpoint; this function calls Semantic Scholar
 * server-side so there are no CORS or SSL issues.
 *
 * Query params are passed through unchanged, e.g.:
 *   /api/papers?query=social+robots&fields=title,abstract,...&limit=10
 */

const https = require('https');

const SS_API = 'api.semanticscholar.org';
const SS_PATH = '/graph/v1/paper/search';
const TIMEOUT_MS = 10000; // 10 seconds

module.exports = async function handler(req, res) {
  // Only allow GET
  if (req.method !== 'GET') {
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }

  // Build the query string from whatever the browser sent
  const qs = new URLSearchParams(req.query).toString();
  const fullPath = `${SS_PATH}?${qs}`;

  try {
    const data = await fetchFromSemanticScholar(fullPath);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(data);
  } catch (err) {
    const status = err.statusCode || 502;
    res.status(status).json({ message: err.message, data: null });
  }
};

/**
 * Make an HTTPS GET request to Semantic Scholar.
 * Returns the raw response body string.
 */
function fetchFromSemanticScholar(path) {
  return new Promise((resolve, reject) => {
    // Include the API key if set as a Vercel environment variable.
    // This gives a higher rate limit (100 req/s vs 1 req/s unauthenticated).
    // To enable: set S2_API_KEY in the Vercel project settings → Environment Variables.
    const headers = { 'User-Agent': 'ResearchHub/1.0' };
    if (process.env.S2_API_KEY) {
      headers['x-api-key'] = process.env.S2_API_KEY;
    }

    const options = {
      hostname: SS_API,
      path: path,
      method: 'GET',
      headers,
      timeout: TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429) {
          const err = new Error('Rate limited by Semantic Scholar. Wait 30 seconds and try again.');
          err.statusCode = 429;
          reject(err);
        } else {
          resolve(body);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const err = new Error('Semantic Scholar request timed out.');
      err.statusCode = 504;
      reject(err);
    });

    req.on('error', (err) => {
      err.statusCode = 502;
      reject(err);
    });

    req.end();
  });
}
