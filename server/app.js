const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { createAnalyzer, AnalysisError } = require('./groq');

// A factory lets tests use mocked Groq responses without starting the real server.
function createApp({ analyze = createAnalyzer(), requestLimit = 10, windowMs = 60000 } = {}) {
  const app = express();
  app.disable('x-powered-by');

  // The server is local. Allow extension origins and tools such as curl, but do
  // not let ordinary website scripts call the API from the user's browser.
  app.use((request, response, next) => {
    const origin = request.get('Origin');
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      return response.status(403).json({ error: 'origin_not_allowed', message: 'Use the Chrome extension to analyze videos.' });
    }
    if (origin) {
      response.set('Access-Control-Allow-Origin', origin);
      response.vary('Origin');
      response.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.set('Access-Control-Allow-Headers', 'Content-Type');
    }
    response.set('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') return response.sendStatus(204);
    next();
  });

  const limiter = rateLimit({
    windowMs, limit: requestLimit, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'rate_limit', message: 'Too many video checks. Wait a minute before checking again.' },
  });

  app.post('/api/analyze', limiter, (request, response, next) => {
    if (!request.is('application/json')) {
      return response.status(415).json({ error: 'invalid_content_type', message: 'Send an application/json request body.' });
    }
    next();
  }, express.json({ limit: '4kb' }), async (request, response, next) => {
    const body = request.body;
    if (!body || Array.isArray(body) || typeof body !== 'object'
      || Object.keys(body).some((key) => !['task', 'videoTitle'].includes(key))
      || ![body.task, body.videoTitle].every((value) => typeof value === 'string'
        && value.trim().length > 0 && value.length <= 500)) {
      return response.status(400).json({ error: 'invalid_input', message: 'Provide task and videoTitle as nonempty strings of at most 500 characters.' });
    }
    try {
      response.json(await analyze({ task: body.task.trim(), videoTitle: body.videoTitle.trim() }));
    } catch (error) { next(error); }
  });

  app.use((request, response) => response.status(404).json({ error: 'not_found', message: 'Use POST /api/analyze.' }));
  // Four parameters tell Express this middleware handles errors from earlier steps.
  app.use((error, request, response, next) => {
    if (error.type === 'entity.too.large') {
      return response.status(413).json({ error: 'body_too_large', message: 'The JSON request is too large.' });
    }
    if (error.type === 'entity.parse.failed') {
      return response.status(400).json({ error: 'invalid_json', message: 'Send valid JSON.' });
    }
    if (error instanceof AnalysisError) {
      return response.status(error.status).json({ error: error.code, message: error.message });
    }
    // Never send raw provider errors, input, or credentials back to the browser.
    response.status(500).json({ error: 'internal_error', message: 'The analysis service encountered an error.' });
  });
  return app;
}

module.exports = { createApp };
