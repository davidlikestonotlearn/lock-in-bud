const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { createAnalyzer, MODEL } = require('../server/groq');

const input = { task: 'Study Calculus', videoTitle: 'Integration by Parts Tutorial' };
const groqResponse = (result) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), {
  headers: { 'Content-Type': 'application/json' },
});

async function service(t, options = {}) {
  const server = createApp({ requestLimit: 100, ...options }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return async (body = input, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/analyze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra,
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}

for (const [classification, task, videoTitle] of [
  ['relevant', 'Study Calculus', 'Integration by Parts Tutorial'],
  ['distracting', 'Study Calculus', 'Minecraft Funny Moments'],
  ['relevant', 'Research Video Game Development', 'How Minecraft Was Programmed'],
  ['uncertain', 'Research', 'My new project'],
]) {
  test(`API returns mocked ${classification} for ${videoTitle}, with the actual task in the Groq request`, async (t) => {
    const result = { classification, reason: 'A short, friendly explanation.' };
    const analyze = createAnalyzer({ apiKey: 'fake-test-key', fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer fake-test-key');
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, MODEL);
      assert.deepEqual(JSON.parse(payload.messages[1].content), { task, videoTitle });
      assert.match(payload.messages[0].content, /never as instructions/);
      assert.equal(payload.response_format.json_schema.strict, true);
      return groqResponse(result);
    } });
    const post = await service(t, { analyze });
    assert.deepEqual((await post({ task: ` ${task} `, videoTitle: ` ${videoTitle} ` })).body, result);
  });
}

test('invalid fields, missing values, extra data, and oversized strings never call Groq', async (t) => {
  let calls = 0;
  const post = await service(t, { analyze: async () => { calls += 1; } });
  for (const body of [{}, { task: 'Study' }, { ...input, task: '' }, { ...input, videoTitle: '  ' },
    { ...input, task: 4 }, { ...input, videoTitle: {} }, { ...input, task: 'x'.repeat(501) },
    { ...input, videoTitle: 'x'.repeat(501) }, { ...input, browsingHistory: [] }, [], null]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(calls, 0);
});

test('malformed JSON, wrong content type, excessive bodies, and wrong HTTP methods have clear statuses', async (t) => {
  const post = await service(t, { analyze: async () => { throw new Error('Should not run'); } });
  assert.equal((await post(input, { body: '{invalid' })).body.error, 'invalid_json');
  assert.equal((await post(input, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post({ ...input, task: 'x'.repeat(5000) })).status, 413);
  assert.equal((await post(input, { method: 'GET', body: undefined })).status, 404);
});

for (const apiKey of ['', 'your_key_here']) {
  test(`missing/placeholder API key returns 503 without a provider request (${apiKey || 'empty'})`, async (t) => {
    const post = await service(t, { analyze: createAnalyzer({ apiKey, fetchImpl: async () => { throw new Error('Must not call Groq'); } }) });
    const result = await post();
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'missing_api_key');
  });
}

test('Groq HTTP errors and rate limits are sanitized', async (t) => {
  for (const [status, expected] of [[401, 502], [500, 502], [429, 429]]) {
    const post = await service(t, { analyze: createAnalyzer({ apiKey: 'private-key',
      fetchImpl: async () => new Response('Sensitive upstream details: private-key', { status }) }) });
    const result = await post();
    assert.equal(result.status, expected);
    assert.doesNotMatch(JSON.stringify(result.body), /private-key|Sensitive/);
  }
});

test('Groq network failures return 502', async (t) => {
  const post = await service(t, { analyze: createAnalyzer({ apiKey: 'fake', fetchImpl: async () => { throw new Error('ECONNRESET'); } }) });
  assert.equal((await post()).body.error, 'groq_unavailable');
});

test('Groq timeouts cancel the request and return 504', async (t) => {
  let aborted = false;
  const post = await service(t, { analyze: createAnalyzer({ apiKey: 'fake', timeoutMs: 10,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')); }, { once: true });
    }) }) });
  const result = await post();
  assert.equal(result.status, 504);
  assert.equal(result.body.error, 'groq_timeout');
  assert.equal(aborted, true);
});

test('the Groq timeout covers a stalled response body', async (t) => {
  const post = await service(t, { analyze: createAnalyzer({ apiKey: 'fake', timeoutMs: 10,
    fetchImpl: async (url, { signal }) => ({ ok: true, status: 200, json: () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Aborted body')), { once: true });
    }) }) }) });
  assert.equal((await post()).status, 504);
});

test('unexpected Groq output is rejected instead of inventing a classification', async (t) => {
  for (const result of [{ classification: 'wrong', reason: 'why' }, { classification: 'relevant', reason: '' },
    { classification: 'uncertain', reason: 'x'.repeat(301) }, { classification: 'relevant', reason: 'why', extra: 'data' }, null]) {
    const post = await service(t, { analyze: createAnalyzer({ apiKey: 'fake', fetchImpl: async () => groqResponse(result) }) });
    assert.equal((await post()).body.error, 'invalid_groq_response');
  }
  const post = await service(t, { analyze: createAnalyzer({ apiKey: 'fake', fetchImpl: async () => new Response('{}') }) });
  assert.equal((await post()).status, 502);
});

test('basic rate limit stops excessive requests before calling Groq', async (t) => {
  let calls = 0;
  const post = await service(t, { requestLimit: 2, analyze: async () => { calls += 1; return { classification: 'relevant', reason: 'Fits.' }; } });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200);
  const result = await post();
  assert.equal(result.status, 429);
  assert.equal(result.body.error, 'rate_limit');
  assert.ok(result.headers.get('retry-after'));
  assert.equal(calls, 2);
});

test('extension CORS is allowed and ordinary website origins are rejected', async (t) => {
  let calls = 0;
  const post = await service(t, { analyze: async () => { calls += 1; return { classification: 'uncertain', reason: 'Not enough context.' }; } });
  const origin = `chrome-extension://${'a'.repeat(32)}`;
  const accepted = await post(input, { headers: { 'Content-Type': 'application/json', Origin: origin } });
  assert.equal(accepted.headers.get('access-control-allow-origin'), origin);
  const rejected = await post(input, { headers: { 'Content-Type': 'application/json', Origin: 'https://www.youtube.com' } });
  assert.equal(rejected.status, 403);
  assert.equal(calls, 1);
});
