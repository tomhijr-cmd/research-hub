/**
 * Vercel serverless function: /api/claude
 *
 * Proxies Gemini API calls for the AI Search feature in Research Hub.
 * Supports two operation types:
 *
 *   type: 'expand'  — Query expansion: turns a natural-language research
 *                     question into optimised Semantic Scholar search terms.
 *
 *   type: 'rank'    — Re-ranking: scores and explains up to 20 papers for
 *                     relevance to the original research question.
 *
 * POST body: { type, query, keywords?, papers? }
 * GEMINI_API_KEY must be set in Vercel project → Environment Variables.
 */

const https = require('https');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const TIMEOUT_MS = 30000; // 30 seconds — ranking 20 papers can take a moment

module.exports = async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[gemini] GEMINI_API_KEY is not set in environment variables.');
    return res.status(500).json({ error: 'Server misconfiguration: GEMINI_API_KEY not set.' });
  }

  const { type, query, keywords = [], papers = [] } = req.body || {};

  if (!type || !query) {
    return res.status(400).json({ error: 'Missing required fields: type, query' });
  }

  let systemPrompt, userMessage;

  if (type === 'expand') {
    // ── Gemini call 1: Query expansion ──────────────────────────────────────
    // Returns { searchTerms[], interpretation, suggestions[] }
    systemPrompt = [
      'You are an academic research assistant specialising in Human-Robot Interaction (HRI)',
      'and social psychology — specifically priming, emotional contagion, and carry-over effects.',
      'Given a researcher\'s question and their keyword profile, your job is to extract',
      'optimised Semantic Scholar search terms that will surface the most relevant academic papers.',
      '',
      'Return ONLY valid JSON with this exact shape (no markdown, no explanation outside the JSON):',
      '{',
      '  "searchTerms": string[],   // 6-8 academic search terms, short phrases work best on S2',
      '  "interpretation": string,  // 1-2 sentence plain-language summary of what you understood',
      '  "suggestions": string[]    // 3 alternative/broader queries if the original may be too narrow',
      '}',
    ].join('\n');

    userMessage = [
      `Research question: "${query}"`,
      '',
      `User's active keyword profile: ${keywords.length ? keywords.join(', ') : 'none set'}`,
    ].join('\n');

  } else if (type === 'rank') {
    // ── Gemini call 2: Re-ranking + explanations ────────────────────────────
    // Returns [{ paperId, score, explanation }]
    systemPrompt = [
      'You are an academic research assistant. Given a researcher\'s question and a list of papers,',
      'score each paper\'s relevance to the question on a scale of 1-10 and write a concise',
      '2-3 sentence explanation of WHY it is or is not relevant.',
      '',
      'Scoring guide:',
      '  9-10 = Directly addresses the question, highly relevant',
      '   7-8 = Clearly related, provides useful context or methodology',
      '   4-6 = Partially relevant, tangentially related',
      '   1-3 = Weak connection, unlikely to be useful for this question',
      '',
      'Return ONLY a valid JSON array with this exact shape (no markdown, no explanation outside the JSON):',
      '[{ "paperId": string, "score": number, "explanation": string }]',
      '',
      'Include ALL papers from the input list in your response, even low-scoring ones.',
      'Keep each explanation to 2-3 sentences maximum.',
    ].join('\n');

    userMessage = [
      `Research question: "${query}"`,
      '',
      'Papers to rank:',
      JSON.stringify(papers, null, 2),
    ].join('\n');

  } else {
    return res.status(400).json({ error: `Unknown type: "${type}". Must be "expand" or "rank".` });
  }

  try {
    const requestBody = JSON.stringify({
      contents: [{ parts: [{ text: userMessage }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.3 },
    });

    const geminiResponse = await callGeminiApi(apiKey, requestBody);

    // Extract the text content from Gemini's response
    const text = geminiResponse?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Pull out the JSON — Gemini sometimes wraps it in markdown code fences
    const jsonMatch = text.match(/\[[\s\S]*?\]|\{[\s\S]*?\}/);
    if (!jsonMatch) {
      console.error('[gemini] No JSON found in Gemini response. Raw text:', text.slice(0, 500));
      throw new Error('AI returned an unexpected response format.');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(parsed);

  } catch (err) {
    console.error('[gemini] Error:', err.message);
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
};

/**
 * Make an HTTPS POST request to the Gemini API.
 * Returns the parsed JSON response body.
 */
function callGeminiApi(apiKey, body) {
  return new Promise((resolve, reject) => {
    const url     = new URL(`${GEMINI_URL}?key=${apiKey}`);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const msg = parsed?.error?.message || `Gemini API error (${res.statusCode})`;
            const err = new Error(msg);
            err.statusCode = res.statusCode;
            reject(err);
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error('Invalid JSON response from Gemini API'));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const err = new Error('AI request timed out after 30 seconds.');
      err.statusCode = 504;
      reject(err);
    });

    req.on('error', (err) => {
      err.statusCode = 502;
      reject(err);
    });

    req.write(body);
    req.end();
  });
}
