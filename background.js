// Chrome can stop this worker whenever it is idle. Storage, not these variables,
// is the source of truth. The queue only serializes overlapping commands while awake.
importScripts('session.js', 'analysis.js');

const Session = globalThis.LockInBuddySession;
const ALARM_NAME = 'lock-in-buddy-focus-complete';
const Analysis = globalThis.LockInBuddyAnalysis;
const analysisService = Analysis.createService();
let queue = Promise.resolve();

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') }).catch(console.error);
});

function enqueue(work) {
  const result = queue.then(work);
  queue = result.catch(() => {}); // A failed command must not block later commands.
  return result;
}

async function schedule(state) {
  if (state.status === 'running') {
    const alarm = await chrome.alarms.get(ALARM_NAME);
    if (!alarm || alarm.scheduledTime !== state.endTime) {
      await chrome.alarms.create(ALARM_NAME, { when: state.endTime });
    }
  } else {
    await chrome.alarms.clear(ALARM_NAME);
  }
}

async function updateSession(action) {
  const stored = await chrome.storage.local.get(Session.STORAGE_KEY);
  const previous = Session.normalize(stored[Session.STORAGE_KEY]);
  const state = Session.reduce(previous, action);
  if (!stored[Session.STORAGE_KEY] || !Array.isArray(stored[Session.STORAGE_KEY].history)
    || (!stored[Session.STORAGE_KEY].active && previous.active)
    || state.revision !== previous.revision) {
    await chrome.storage.local.set({ [Session.STORAGE_KEY]: state });
  }
  await schedule(state);
  return state;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.channel !== 'lock-in-buddy' || sender.id !== chrome.runtime.id) return;
  // AI network calls have their own path, so a slow server never holds the
  // session-write queue or delays pause/reset/history/dashboard operations.
  const work = request.command === 'analyze' ? analyzeVideo(request, sender) : enqueue(async () => {
    if (request.command === 'session') return { state: await updateSession(request.action) };
    if (request.command === 'aiSettings') {
      if (typeof request.enabled !== 'boolean') throw new Error('Choose whether to enable AI checks.');
      const settings = { enabled: request.enabled };
      await chrome.storage.local.set({ [Analysis.SETTINGS_KEY]: settings });
      if (!settings.enabled) analysisService.clear();
      return { settings };
    }

    // Derive the website from Chrome's sender metadata, not from a supplied key.
    const origin = new URL(sender.url).origin;
    const uiKey = Session.UI_PREFIX + origin;
    if (request.command === 'load') {
      const state = await updateSession({ type: 'reconcile' });
      const stored = await chrome.storage.local.get(uiKey);
      const ai = await chrome.storage.local.get(Analysis.SETTINGS_KEY);
      return { state, ui: Session.normalizeUI(stored[uiKey]), settings: Analysis.normalizeSettings(ai[Analysis.SETTINGS_KEY]) };
    }
    if (request.command === 'ui') {
      const stored = await chrome.storage.local.get(uiKey);
      const ui = Session.normalizeUI({ ...Session.normalizeUI(stored[uiKey]), ...request.patch });
      await chrome.storage.local.set({ [uiKey]: ui });
      return { ui };
    }
    throw new Error('Unknown Buddy request.');
  });
  work.then((result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: error.message }));
  return true; // Keep the message response open while asynchronous work finishes.
});

async function analysisContext() {
  const saved = await chrome.storage.local.get(Session.STORAGE_KEY);
  const ai = await chrome.storage.local.get(Analysis.SETTINGS_KEY);
  return { state: Session.normalize(saved[Session.STORAGE_KEY]), settings: Analysis.normalizeSettings(ai[Analysis.SETTINGS_KEY]) };
}

async function analyzeVideo(request, sender) {
  // Chrome can keep the document's original sender URL after YouTube's SPA
  // navigation (e.g. homepage -> video). Verify the trusted origin here;
  // youtube.js checks the current location and video title before requesting.
  if (new URL(sender.url).origin !== 'https://www.youtube.com') {
    throw new Error('Video checks are available on YouTube.');
  }
  if (typeof request.videoTitle !== 'string' || !request.videoTitle.trim() || request.videoTitle.length > 500) {
    throw new Error('A video title is required (at most 500 characters).');
  }
  const { state, settings } = await enqueue(analysisContext);
  if (!settings.enabled || state.status !== 'running' || Session.secondsLeft(state) === 0
    || request.task !== state.task) return { analysis: { skipped: true } };
  const result = await analysisService.analyze(state.task, request.videoTitle.trim());
  const latest = await enqueue(analysisContext);
  if (!latest.settings.enabled || latest.state.status !== 'running' || Session.secondsLeft(latest.state) === 0
    || latest.state.task !== state.task || latest.state.active?.id !== state.active?.id) {
    return { analysis: { skipped: true } };
  }
  return { analysis: result };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) enqueue(() => updateSession({ type: 'reconcile' })).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => enqueue(() => updateSession({ type: 'reconcile' })).catch(console.error));
chrome.runtime.onInstalled.addListener(() => enqueue(() => updateSession({ type: 'reconcile' })).catch(console.error));

// Recreate a missing alarm whenever the worker wakes up, including after a restart.
enqueue(() => updateSession({ type: 'reconcile' })).catch(console.error);
