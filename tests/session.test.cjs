// Run with: node tests/session.test.cjs
// No dependencies: Node's VM gives each fake tab/worker its own script context.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const project = path.join(__dirname, '..');
const code = (file) => fs.readFileSync(path.join(project, file), 'utf8');

function loadSession() {
  const context = vm.createContext({ crypto: webcrypto });
  vm.runInContext(code('session.js'), context);
  return context.LockInBuddySession;
}
const Session = loadSession();

test('a task, small step, conversation, and correct running time survive serialization', () => {
  let state = Session.reduce(Session.create(), { type: 'setTask', task: 'Study biology', step: 'Review five flashcards' }, 1000);
  state = Session.reduce(state, { type: 'setDuration', duration: 300 }, 1000);
  state = Session.reduce(state, { type: 'start' }, 1000);
  const restored = Session.normalize(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.task, 'Study biology');
  assert.equal(restored.step, 'Review five flashcards');
  assert.equal(restored.endTime, 301000);
  assert.equal(Session.secondsLeft(restored, 46000), 255);
  assert.equal(restored.messages.length, 3);
});

test('pause preserves elapsed time and resume establishes a new finish timestamp', () => {
  let state = Session.reduce(Session.create(), { type: 'chat', text: 'Write my essay' }, 1000);
  state = Session.reduce(state, { type: 'start' }, 1000);
  state = Session.reduce(state, { type: 'pause' }, 46000);
  assert.equal(state.remaining, 1455);
  assert.equal(state.endTime, null);
  assert.equal(Session.secondsLeft(state, 500000), 1455);
  state = Session.reduce(state, { type: 'start' }, 500000);
  assert.equal(state.endTime, 1955000);
});

test('late timers complete once, even with repeated checks from several tabs', () => {
  let state = Session.reduce(Session.create(), { type: 'setTask', task: 'Homework' }, 1000);
  state = Session.reduce(state, { type: 'start' }, 1000);
  state = Session.reduce(state, { type: 'reconcile' }, 1600000);
  const revision = state.revision;
  for (let i = 0; i < 5; i += 1) state = Session.reduce(state, { type: 'reconcile' }, 1700000);
  assert.equal(state.status, 'completed');
  assert.equal(state.revision, revision);
  assert.equal(state.messages.filter((message) => message.text.startsWith('Focus time is up')).length, 1);
});

test('check-in commands continue, pause, and finish the actual focus session', () => {
  let state = Session.reduce(Session.create(), { type: 'chat', text: 'Read chapter three' }, 1000);
  state = Session.reduce(state, { type: 'start' }, 1000);
  state = Session.reduce(state, { type: 'chat', text: 'not done' }, 2000);
  assert.equal(state.status, 'running');
  assert.equal(state.taskDone, false);
  state = Session.reduce(state, { type: 'chat', text: 'break' }, 11000);
  assert.equal(state.status, 'paused');
  assert.equal(state.remaining, 1490);
  state = Session.reduce(state, { type: 'chat', text: 'more time' }, 21000);
  assert.equal(state.status, 'running');
  assert.equal(state.endTime, 1511000);
  state = Session.reduce(state, { type: 'reconcile' }, 1511000);
  state = Session.reduce(state, { type: 'chat', text: 'more time' }, 1600000);
  assert.equal(state.endTime, 3100000);
  state = Session.reduce(state, { type: 'chat', text: 'done!' }, 1601000);
  assert.equal(state.taskDone, true);
  assert.equal(state.status, 'completed');
  assert.equal(state.endTime, null);
});

test('a changed task and reset stop the old countdown, and invalid commands do not mutate input', () => {
  let state = Session.reduce(Session.create(), { type: 'setTask', task: 'Old task' }, 1000);
  state = Session.reduce(state, { type: 'start' }, 1000);
  const snapshot = JSON.stringify(state);
  assert.throws(() => Session.reduce(state, { type: 'setDuration', duration: 600 }, 2000), /Pause/);
  assert.equal(JSON.stringify(state), snapshot);
  state = Session.reduce(state, { type: 'setTask', task: 'New task', step: 'First paragraph' }, 2000);
  assert.equal(state.status, 'idle');
  assert.equal(state.endTime, null);
  assert.equal(state.remaining, 1500);
  state = Session.reduce(state, { type: 'start' }, 3000);
  state = Session.reduce(state, { type: 'reset' }, 5000);
  assert.equal(state.task, 'New task');
  assert.equal(state.remaining, 1500);
  assert.equal(state.status, 'idle');
});

test('saved UI is validated and chat history stays bounded', () => {
  assert.equal(Session.normalizeUI({ position: { left: 'bad', top: 0 }, tab: 'bad' }).position, null);
  assert.equal(Session.normalize({ version: 1, status: 'running', endTime: 'bad' }).status, 'idle');
  let state = Session.create();
  for (let i = 0; i < 60; i += 1) state = Session.reduce(state, { type: 'chat', text: `Message ${i}` }, i);
  assert.equal(state.messages.length, 100);
  assert.equal(state.messages.at(-2).text, 'Message 59');
});

const { fakeExtension } = require('./extension-fixture.cjs');

test('real worker/client scripts serialize concurrent tabs and broadcast one session', async () => {
  const extension = fakeExtension();
  const youtube = extension.client('https://www.youtube.com/watch?v=123');
  const google = extension.client('https://www.google.com/search?q=study');
  const googleStates = [];
  google.subscribe((state) => googleStates.push(state));
  await Promise.all([youtube.load(), google.load()]);
  await youtube.dispatch({ type: 'setTask', task: 'Shared task', step: 'One small step' });
  await Promise.all([youtube.dispatch({ type: 'start' }), google.dispatch({ type: 'start' })]);
  let saved = extension.data[Session.STORAGE_KEY];
  assert.equal(saved.messages.filter((message) => message.text.startsWith('Let’s focus')).length, 1);
  assert.equal(googleStates.at(-1).task, 'Shared task');
  assert.equal(googleStates.at(-1).status, 'running');
  assert.equal(extension.alarms.get('lock-in-buddy-focus-complete').scheduledTime, saved.endTime);

  await Promise.all([youtube.dispatch({ type: 'chat', text: 'Hello from YouTube' }),
    google.dispatch({ type: 'chat', text: 'Hello from Google' })]);
  saved = extension.data[Session.STORAGE_KEY];
  assert.ok(saved.messages.some((message) => message.text === 'Hello from YouTube'));
  assert.ok(saved.messages.some((message) => message.text === 'Hello from Google'));

  await google.dispatch({ type: 'pause' });
  assert.equal(extension.data[Session.STORAGE_KEY].status, 'paused');
  assert.equal(extension.alarms.size, 0);
  await youtube.dispatch({ type: 'reset' });
  assert.equal(googleStates.at(-1).status, 'idle');
  youtube.destroy();
  google.destroy();
});

test('refresh and worker restart preserve state, repair alarms, and isolate website UI', async () => {
  const extension = fakeExtension();
  const youtube = extension.client('https://www.youtube.com/watch?v=123');
  const google = extension.client('https://www.google.com/search?q=study');
  await youtube.load();
  await youtube.dispatch({ type: 'setTask', task: 'Persistent task' });
  await youtube.dispatch({ type: 'start' });
  await Promise.all([
    youtube.saveUI({ position: { left: 80, top: 90 } }),
    youtube.saveUI({ panelOpen: true, tab: 'timer' }),
    google.saveUI({ position: { left: 400, top: 500 } }),
  ]);
  const endTime = extension.data[Session.STORAGE_KEY].endTime;
  extension.alarms.clear();
  extension.wakeWorker();
  youtube.destroy();
  const refreshed = extension.client('https://www.youtube.com/watch?v=456');
  const loaded = await refreshed.load();
  assert.equal(loaded.state.task, 'Persistent task');
  assert.equal(loaded.state.endTime, endTime);
  assert.equal(loaded.ui.position.left, 80);
  assert.equal(loaded.ui.panelOpen, true);
  assert.equal(loaded.ui.tab, 'timer');
  assert.equal((await google.load()).ui.position.left, 400);
  assert.equal(extension.alarms.get('lock-in-buddy-focus-complete').scheduledTime, endTime);

  // Simulate returning after the deadline, with two tabs asking at once.
  extension.data[Session.STORAGE_KEY].endTime = Date.now() - 1000;
  await Promise.all([refreshed.dispatch({ type: 'reconcile' }), google.dispatch({ type: 'reconcile' })]);
  const saved = extension.data[Session.STORAGE_KEY];
  assert.equal(saved.status, 'completed');
  assert.equal(saved.messages.filter((message) => message.text.startsWith('Focus time is up')).length, 1);
  assert.equal(extension.alarms.size, 0);
  refreshed.destroy();
  google.destroy();
});

test('an invalid action does not poison the worker queue', async () => {
  const extension = fakeExtension();
  const client = extension.client('https://www.google.com/');
  await client.load();
  await assert.rejects(client.dispatch({ type: 'start' }), /Set a task/);
  await client.dispatch({ type: 'setTask', task: 'Still works' });
  assert.equal(extension.data[Session.STORAGE_KEY].task, 'Still works');
  client.destroy();
});

test('the background alarm completes a session after all website clients have closed', async () => {
  const extension = fakeExtension();
  const client = extension.client('https://www.youtube.com/watch?v=123');
  await client.load();
  await client.dispatch({ type: 'setTask', task: 'Finish in the background' });
  await client.dispatch({ type: 'start' });
  client.destroy();
  extension.data[Session.STORAGE_KEY].endTime = Date.now() - 1000;
  extension.onAlarm.fire({ name: 'lock-in-buddy-focus-complete' });
  // This is a new connection. Its load queues behind the alarm event's work.
  const reopened = extension.client('https://www.google.com/');
  const { state } = await reopened.load();
  assert.equal(state.status, 'completed');
  assert.equal(state.messages.filter((message) => message.text.startsWith('Focus time is up')).length, 1);
  assert.equal(extension.alarms.size, 0);
  reopened.destroy();
});

function startFocus(at = 1000) {
  let state = Session.reduce(Session.create(), { type: 'setTask', task: 'Algorithms' }, at);
  state = Session.reduce(state, { type: 'setDuration', duration: 300 }, at);
  return Session.reduce(state, { type: 'start' }, at);
}

test('history records exact active milliseconds, excluding long pauses and late alarm delay', () => {
  let state = startFocus();
  const id = state.active.id;
  state = Session.reduce(state, { type: 'pause' }, 1234);
  assert.equal(state.remaining, 299.766);
  assert.equal(state.history.length, 0);
  assert.equal(Session.statistics(state, 900000).totalMs, 234);
  state = Session.reduce(JSON.parse(JSON.stringify(state)), { type: 'start' }, 1000000);
  assert.equal(state.active.id, id);
  const deadline = state.endTime;
  state = Session.reduce(state, { type: 'reconcile' }, deadline + 600000);
  const record = state.history[0];
  assert.equal(record.id, id);
  assert.equal(record.task, 'Algorithms');
  assert.equal(record.plannedDuration, 300);
  assert.equal(record.focusedMs, 300000);
  assert.equal(record.endedAt, deadline);
  assert.equal(record.outcome, 'completed');
  assert.equal(record.reason, 'timer');
  assert.equal(record.segments.length, 2);
  assert.equal(state.active, null);
  state = Session.reduce(state, { type: 'chat', text: 'done' }, deadline + 700000);
  state = Session.reduce(state, { type: 'reset' }, deadline + 800000);
  assert.equal(state.history.length, 1);
});

test('repeated short pauses do not add or lose time through rounding', () => {
  let state = startFocus();
  for (let i = 0; i < 10; i++) {
    state = Session.reduce(state, { type: 'pause' }, 1000 + i * 1000 + 123);
    state = Session.reduce(state, { type: 'start' }, 2000 + i * 1000);
  }
  state = Session.reduce(state, { type: 'chat', text: 'done' }, 11000);
  assert.equal(state.history[0].focusedMs, 1230);
});

test('early done while running or paused counts only active time; idle done creates no session', () => {
  for (const paused of [false, true]) {
    let state = startFocus();
    if (paused) state = Session.reduce(state, { type: 'pause' }, 11000);
    state = Session.reduce(state, { type: 'chat', text: 'done' }, 51000);
    assert.equal(state.history[0].focusedMs, paused ? 10000 : 50000);
    assert.equal(state.history[0].reason, 'done');
    assert.equal(Session.statistics(state).completedSessions, 1);
    state = Session.reduce(state, { type: 'chat', text: 'done' }, 61000);
    assert.equal(state.history.length, 1);
  }
  let idle = Session.reduce(Session.create(), { type: 'setTask', task: 'No timer' }, 1000);
  idle = Session.reduce(idle, { type: 'chat', text: 'done' }, 9000);
  assert.equal(idle.history.length, 0);
});

test('reset, task changes, and duration changes retain partial time and the original plan', () => {
  for (const action of [{ type: 'reset' }, { type: 'setTask', task: 'New task' }, { type: 'setDuration', duration: 600 }]) {
    let state = Session.reduce(startFocus(), { type: 'pause' }, 61000);
    state = Session.reduce(state, action, 91000);
    assert.equal(state.history[0].task, 'Algorithms');
    assert.equal(state.history[0].plannedDuration, 300);
    assert.equal(state.history[0].focusedMs, 60000);
    assert.equal(state.history[0].outcome, 'reset');
    assert.equal(Session.statistics(state).completedSessions, 0);
    assert.equal(state.active, null);
    state = Session.reduce(state, { type: 'reset' }, 101000);
    assert.equal(state.history.length, 1);
  }
  const instantReset = Session.reduce(startFocus(), { type: 'reset' }, 1000);
  assert.equal(instantReset.history.length, 0);
});

test('today statistics split midnight intervals, include active time, and exclude paused time', () => {
  const midnight = new Date(2026, 9, 9).getTime();
  let state = startFocus(midnight - 120000);
  state = Session.reduce(state, { type: 'pause' }, midnight + 60000);
  assert.equal(Session.statistics(state, midnight + 120000).todayMs, 60000);
  state = Session.reduce(state, { type: 'start' }, midnight + 600000);
  assert.equal(Session.statistics(state, midnight + 660000).todayMs, 120000);
  state = Session.reduce(state, { type: 'reconcile' }, midnight + 1000000);
  const stats = Session.statistics(state, midnight + 1000000);
  assert.equal(stats.todayMs, 180000);
  assert.equal(stats.totalMs, 300000);
  assert.equal(stats.completedSessions, 1);
  assert.equal(stats.averageMs, 300000);
});

test('history validation rejects corrupt records and duplicate IDs, deriving time from intervals', () => {
  const state = Session.reduce(startFocus(), { type: 'reconcile' }, 301000);
  const record = state.history[0];
  state.history.push({ ...record }, { ...record, id: 'invalid', endedAt: -1 }, null);
  state.history[0].focusedMs = 99999999;
  const restored = Session.normalize(state);
  assert.equal(restored.history.length, 1);
  assert.equal(restored.history[0].focusedMs, 300000);
  assert.equal(Session.normalize({ version: 1, history: 'broken' }).history.length, 0);
});

test('concurrent completion, alarm, and worker restart preserve exactly one history record', async () => {
  const extension = fakeExtension();
  const youtube = extension.client('https://www.youtube.com/');
  const google = extension.client('https://www.google.com/');
  await youtube.load();
  extension.data[Session.STORAGE_KEY] = startFocus(Date.now() - 400000);
  extension.onAlarm.fire({ name: 'lock-in-buddy-focus-complete' });
  await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? youtube : google).dispatch({ type: 'reconcile' })));
  assert.equal(extension.data[Session.STORAGE_KEY].history.length, 1);
  assert.equal(extension.data[Session.STORAGE_KEY].history[0].focusedMs, 300000);
  extension.wakeWorker();
  const loaded = await google.load();
  assert.equal(loaded.state.history.length, 1);
  assert.equal(loaded.state.history[0].focusedMs, 300000);
  youtube.destroy();
  google.destroy();
});

test('a failed storage write leaves completion retryable without duplicate history', async () => {
  const extension = fakeExtension();
  const client = extension.client('https://www.google.com/');
  await client.load();
  extension.data[Session.STORAGE_KEY] = startFocus(Date.now() - 400000);
  extension.failNextWrite();
  await assert.rejects(client.dispatch({ type: 'reconcile' }), /quota/);
  assert.equal(extension.data[Session.STORAGE_KEY].status, 'running');
  const state = await client.dispatch({ type: 'reconcile' });
  assert.equal(state.history.length, 1);
  assert.equal(state.status, 'completed');
  client.destroy();
});

test('clicking the extension action opens the native extension dashboard', async () => {
  const extension = fakeExtension();
  extension.action.onClicked.fire();
  assert.equal(extension.openedTabs[0].url, 'chrome-extension://test-extension/dashboard/index.html');
});

test('native dashboard and supported websites share session history and statistics', async () => {
  const extension = fakeExtension();
  const youtube = extension.client('https://www.youtube.com/');
  const dashboard = extension.client('chrome-extension://test-extension/dashboard/index.html');
  await youtube.load();
  extension.data[Session.STORAGE_KEY] = startFocus(Date.now() - 400000);
  await youtube.dispatch({ type: 'reconcile' });
  const { state } = await dashboard.load();
  assert.equal(state.history.length, 1);
  assert.equal(Session.statistics(state).completedSessions, 1);
  assert.equal(Session.statistics(state).totalMs, 300000);
  youtube.destroy();
  dashboard.destroy();
});

test('upgrading a pre-history timer preserves its deadline without inventing past study time', () => {
  const old = { version: 1, revision: 4, task: 'Existing task', duration: 300,
    remaining: 300, status: 'running', endTime: 301000 };
  let state = Session.normalize(old, 101000);
  assert.equal(state.endTime, 301000);
  assert.equal(state.history.length, 0);
  assert.equal(state.active.startedAt, 101000);
  state = Session.reduce(state, { type: 'reconcile' }, 401000);
  assert.equal(state.history[0].focusedMs, 200000);
  assert.equal(state.history[0].plannedDuration, 300);
});

test('reset or task change arriving after expiry keeps the original completed record', () => {
  for (const action of [{ type: 'reset' }, { type: 'setTask', task: 'Next task' }]) {
    const state = Session.reduce(startFocus(), action, 401000);
    assert.equal(state.status, 'idle');
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].outcome, 'completed');
    assert.equal(state.history[0].task, 'Algorithms');
    assert.equal(state.history[0].endedAt, 301000);
    assert.equal(state.history[0].focusedMs, 300000);
  }
});

test('standalone Buddy and dashboard clients synchronize within the same document', async () => {
  let now = 1000;
  const values = new Map();
  const listeners = new Map();
  const window = {
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatchEvent(event) { listeners.get(event.type)?.forEach((listener) => listener(event)); },
  };
  let lockQueue = Promise.resolve();
  const context = vm.createContext({ crypto: webcrypto, window,
    location: new URL('http://localhost/dashboard/'),
    Date: class extends Date { static now() { return now; } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    localStorage: { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
    navigator: { locks: { request(key, work) {
      const result = lockQueue.then(work);
      lockQueue = result.catch(() => {});
      return result;
    } } },
  });
  vm.runInContext(code('session.js'), context);
  vm.runInContext(code('analysis.js'), context);
  vm.runInContext(code('storage.js'), context);
  const buddy = context.LockInBuddyStore.createClient();
  const dashboard = context.LockInBuddyStore.createClient();
  let dashboardState;
  dashboard.subscribe((state) => { dashboardState = state; });
  await Promise.all([buddy.load(), dashboard.load()]);
  await buddy.dispatch({ type: 'setTask', task: 'One document' });
  await buddy.dispatch({ type: 'start' });
  assert.equal(dashboardState.status, 'running');
  now = 31000;
  await buddy.dispatch({ type: 'chat', text: 'done' });
  assert.equal(dashboardState.history.length, 1);
  assert.equal(dashboardState.history[0].focusedMs, 30000);
  assert.equal(dashboardState.taskDone, true);
  buddy.destroy();
  dashboard.destroy();
  assert.equal(listeners.get('lock-in-buddy-session-change').size, 0);
});
