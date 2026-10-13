const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { fakeExtension } = require('./extension-fixture.cjs');
const context = vm.createContext({ URL, AbortController, setTimeout, clearTimeout });
for (const file of ['analysis.js', 'youtube.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
}
const Analysis = context.LockInBuddyAnalysis;
const YouTube = context.LockInBuddyYouTube;
const relevant = { classification: 'relevant', reason: 'This supports your task.' };
const response = (value = relevant, status = 200) => new Response(JSON.stringify(value), { status });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the worker service deduplicates concurrent requests and caches results for five minutes', async () => {
  let calls = 0;
  let now = 0;
  const waiting = deferred();
  const service = Analysis.createService({ now: () => now, fetchImpl: async () => { calls += 1; await waiting.promise; return response(); } });
  const first = service.analyze('Calculus', 'Integration');
  const second = service.analyze('Calculus', 'Integration');
  waiting.resolve();
  assert.deepEqual(plain(await first), relevant);
  await second;
  await service.analyze('Calculus', 'Integration');
  assert.equal(calls, 1);
  now = 300001;
  await service.analyze('Calculus', 'Integration');
  assert.equal(calls, 2);
  await service.analyze('Game development', 'Integration');
  assert.equal(calls, 3);
});

test('backend failures use a one-minute cooldown and can recover', async () => {
  let now = 0;
  let calls = 0;
  const service = Analysis.createService({ now: () => now, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) throw new Error('Offline');
    return response();
  } });
  assert.match((await service.analyze('Task', 'Video')).error, /Start the local/);
  await service.analyze('Task', 'Video');
  assert.equal(calls, 1);
  now = 60001;
  assert.deepEqual(plain(await service.analyze('Task', 'Video')), relevant);
});

test('HTTP errors, malformed results, and backend timeouts produce neutral errors', async () => {
  for (const fetchImpl of [async () => response({ message: 'Set GROQ_API_KEY.' }, 503),
    async () => response({ classification: 'wrong', reason: 'Bad' }), async () => new Response('invalid JSON')]) {
    const service = Analysis.createService({ fetchImpl });
    const result = await service.analyze('Task', 'Video');
    assert.equal(typeof result.error, 'string');
    assert.equal(result.classification, undefined);
  }
  const service = Analysis.createService({ timeoutMs: 10, fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }) });
  assert.match((await service.analyze('Task', 'Video')).error, /timed out/);
});

function watcherFixture() {
  const requests = [];
  const feedback = [];
  let video = { id: 'a', title: 'Integration' };
  const watcher = YouTube.createWatcher({ readVideo: () => video,
    analyze: async (input) => { requests.push(plain(input)); return relevant; }, onFeedback: (value) => feedback.push(plain(value)) });
  const state = { task: 'Calculus', status: 'running', endTime: Date.now() + 600000, active: { id: 'session-a' } };
  return { watcher, state, requests, feedback, video: (next) => { video = next; } };
}

test('the title watcher sends nothing until opted in with a running, unexpired session', async () => {
  const f = watcherFixture();
  for (const [state, enabled] of [[f.state, false], [{ ...f.state, status: 'idle' }, true],
    [{ ...f.state, status: 'paused' }, true], [{ ...f.state, status: 'completed' }, true],
    [{ ...f.state, endTime: Date.now() - 1 }, true]]) {
    await f.watcher.update(state, { enabled });
  }
  assert.equal(f.requests.length, 0);
  await f.watcher.update(f.state, { enabled: true });
  assert.deepEqual(f.requests, [{ task: 'Calculus', videoTitle: 'Integration' }]);
});

test('YouTube video/title changes, changed tasks, and new sessions trigger checks without duplicate scans', async () => {
  const f = watcherFixture();
  await f.watcher.update(f.state, { enabled: true });
  for (let i = 0; i < 5; i += 1) await f.watcher.scan();
  assert.equal(f.requests.length, 1);
  f.video({ id: 'b', title: 'Minecraft Funny Moments' });
  await f.watcher.scan();
  assert.equal(f.requests.length, 2);
  f.video({ id: 'b', title: 'How Minecraft Was Programmed' });
  await f.watcher.scan();
  await f.watcher.update({ ...f.state, task: 'Research Video Game Development' }, { enabled: true });
  await f.watcher.update({ ...f.state, active: { id: 'session-b' } }, { enabled: true });
  assert.equal(f.requests.length, 5);
});

test('navigation start suspends checks until the new title is ready; leaving watch pages clears feedback', async () => {
  const f = watcherFixture();
  await f.watcher.update(f.state, { enabled: true });
  await f.watcher.navigate(true);
  f.video({ id: 'b', title: 'A new video' });
  await f.watcher.scan();
  assert.equal(f.requests.length, 1);
  await f.watcher.navigate(false);
  assert.equal(f.requests.length, 2);
  f.video(null);
  await f.watcher.scan();
  assert.equal(f.feedback.at(-1).status, 'waiting');
});

test('responses for old videos, paused sessions, and disabled detection cannot show stale reminders', async () => {
  for (const change of ['video', 'pause', 'disable', 'destroy']) {
    const pending = deferred();
    const feedback = [];
    let video = { id: 'a', title: 'Old title' };
    const watcher = YouTube.createWatcher({ readVideo: () => video, analyze: () => pending.promise, onFeedback: (value) => feedback.push(value) });
    const state = { task: 'Study', status: 'running', endTime: Date.now() + 600000 };
    const first = watcher.update(state, { enabled: true });
    if (change === 'video') { video = null; await watcher.scan(); }
    if (change === 'pause') await watcher.update({ ...state, status: 'paused' }, { enabled: true });
    if (change === 'disable') await watcher.update(state, { enabled: false });
    if (change === 'destroy') watcher.destroy();
    pending.resolve({ classification: 'distracting', reason: 'Old result.' });
    await first;
    assert.equal(feedback.some((value) => value.status === 'result'), false);
  }
});

test('watcher preserves uncertain classifications and permits manual retry after an error', async () => {
  let calls = 0;
  const feedback = [];
  const watcher = YouTube.createWatcher({ readVideo: () => ({ id: 'a', title: 'A vague title' }),
    analyze: async () => ++calls === 1 ? { error: 'Offline' } : { classification: 'uncertain', reason: 'The title is vague.' },
    onFeedback: (value) => feedback.push(value) });
  await watcher.update({ task: 'Study', status: 'running', endTime: Date.now() + 100000 }, { enabled: true });
  assert.equal(feedback.at(-1).status, 'error');
  await watcher.retry();
  assert.equal(feedback.at(-1).classification, 'uncertain');
});

test('DOM title reading ignores non-video pages and mismatched player IDs during navigation', () => {
  let playerID = 'a';
  let title = 'Integration by Parts';
  const document = { querySelector: (selector) => selector === 'ytd-watch-flexy[video-id]'
    ? { getAttribute: () => playerID } : { textContent: title } };
  assert.equal(YouTube.readVideo(document, new URL('https://www.youtube.com/')), null);
  assert.deepEqual(plain(YouTube.readVideo(document, new URL('https://www.youtube.com/watch?v=a'))), { id: 'a', title });
  assert.equal(YouTube.readVideo(document, new URL('https://www.youtube.com/watch?v=b')), null);
  document.title = 'A stale tab title - YouTube';
  assert.equal(YouTube.readVideo(document, new URL('https://www.youtube.com/watch?v=a')), null);
  document.title = `${title} - YouTube`;
  assert.equal(YouTube.readVideo(document, new URL('https://www.youtube.com/watch?v=a')).title, title);
  playerID = 'b'; title = '  ';
  assert.equal(YouTube.readVideo(document, new URL('https://www.youtube.com/watch?v=b')), null);
});

test('real worker and storage client send only the saved task and title to the fixed backend URL', async () => {
  const calls = [];
  const extension = fakeExtension({ fetchImpl: async (url, options) => { calls.push({ url, options }); return response(); } });
  const youtube = extension.client('https://www.youtube.com/watch?v=a');
  const dashboard = extension.client('chrome-extension://test-extension/dashboard/index.html');
  await youtube.load();
  assert.equal((await dashboard.load()).settings.enabled, false);
  await youtube.dispatch({ type: 'setTask', task: 'Study Calculus' });
  await youtube.dispatch({ type: 'start' });
  const request = { task: 'Study Calculus', videoTitle: 'Integration by Parts' };
  assert.equal((await youtube.analyzeVideo(request)).skipped, true);
  await dashboard.setDetection(true);
  assert.deepEqual(plain(await youtube.analyzeVideo(request)), relevant);
  await Promise.all([youtube.analyzeVideo(request), youtube.analyzeVideo(request)]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/api/analyze');
  assert.deepEqual(JSON.parse(calls[0].options.body), request);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(extension.data['lock-in-buddy-session-v1'].history.length, 0);
  await assert.rejects(dashboard.analyzeVideo(request), /YouTube/);
  assert.equal((await youtube.analyzeVideo({ ...request, task: 'Unsaved forged task' })).skipped, true);
  await assert.rejects(youtube.analyzeVideo({ ...request, videoTitle: '' }), /title/);
  await dashboard.setDetection(false);
  assert.equal((await youtube.load()).settings.enabled, false);
  youtube.destroy(); dashboard.destroy();
});

test('homepage-to-watch SPA navigation works when Chrome sender metadata still has the homepage URL', async () => {
  const calls = [];
  const extension = fakeExtension({ fetchImpl: async (url, options) => {
    calls.push(JSON.parse(options.body));
    return response();
  } });
  // The document started on the homepage, so its message metadata stays there.
  const youtube = extension.client('https://www.youtube.com/');
  await youtube.load();
  await youtube.dispatch({ type: 'setTask', task: 'Study Calculus' });
  const state = await youtube.dispatch({ type: 'start' });
  await youtube.setDetection(true);
  let currentVideo = null;
  const feedback = [];
  const watcher = YouTube.createWatcher({ readVideo: () => currentVideo,
    analyze: (video) => youtube.analyzeVideo(video), onFeedback: (value) => feedback.push(value) });
  await watcher.update(state, { enabled: true });
  assert.equal(calls.length, 0);
  currentVideo = { id: 'a', title: 'Integration by Parts Tutorial' };
  await watcher.scan();
  assert.equal(feedback.at(-1).classification, 'relevant');
  assert.deepEqual(calls, [{ task: 'Study Calculus', videoTitle: 'Integration by Parts Tutorial' }]);
  const google = extension.client('https://www.google.com/');
  await assert.rejects(google.analyzeVideo({ task: state.task, videoTitle: currentVideo.title }), /YouTube/);
  assert.equal(calls.length, 1);
  watcher.destroy(); youtube.destroy(); google.destroy();
});

test('a pending AI call does not delay timer commands; a paused session discards its result', async () => {
  const waiting = deferred();
  const started = deferred();
  const extension = fakeExtension({ fetchImpl: async () => { started.resolve(); await waiting.promise; return response(); } });
  const youtube = extension.client('https://www.youtube.com/watch?v=a');
  await youtube.load();
  await youtube.dispatch({ type: 'setTask', task: 'Study' });
  await youtube.dispatch({ type: 'start' });
  await youtube.setDetection(true);
  const analysis = youtube.analyzeVideo({ task: 'Study', videoTitle: 'Title' });
  await started.promise;
  let forced = false;
  const timeout = setTimeout(() => { forced = true; waiting.resolve(); }, 1000);
  try {
    const paused = await youtube.dispatch({ type: 'pause' });
    assert.equal(forced, false, 'Pause must finish while the AI call is still pending');
    assert.equal(paused.status, 'paused');
    assert.equal(extension.data['lock-in-buddy-session-v1'].status, 'paused');
  } finally { clearTimeout(timeout); waiting.resolve(); }
  assert.equal((await analysis).skipped, true);
  youtube.destroy();
});

test('disabling detection aborts a pending backend call without changing the session', async () => {
  const started = deferred();
  let aborted = false;
  const extension = fakeExtension({ fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    started.resolve();
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')); }, { once: true });
  }) });
  const youtube = extension.client('https://www.youtube.com/watch?v=a');
  await youtube.load();
  await youtube.dispatch({ type: 'setTask', task: 'Study' });
  await youtube.dispatch({ type: 'start' });
  await youtube.setDetection(true);
  const before = JSON.stringify(extension.data['lock-in-buddy-session-v1']);
  const pending = youtube.analyzeVideo({ task: 'Study', videoTitle: 'Title' });
  await started.promise;
  await youtube.setDetection(false);
  assert.equal((await pending).skipped, true);
  assert.equal(aborted, true);
  assert.equal(JSON.stringify(extension.data['lock-in-buddy-session-v1']), before);
  youtube.destroy();
});
