// The UI uses this small adapter instead of knowing where its data is stored.
// Extension pages and websites: one worker. Standalone preview: localStorage + a browser lock.
(() => {
  if (globalThis.LockInBuddyStore) return;
  const Session = globalThis.LockInBuddySession;
  const Analysis = globalThis.LockInBuddyAnalysis;

  function createClient() {
    const isExtension = Boolean(globalThis.chrome?.runtime?.id);
    const uiKey = Session.UI_PREFIX + (location.origin === 'null' ? 'dashboard-file' : location.origin);
    const listeners = new Set();
    const settingsListeners = new Set();
    let current = null;
    let localQueue = Promise.resolve();

    function publishSettings(saved) {
      const settings = Analysis.normalizeSettings(saved);
      settingsListeners.forEach((listener) => listener(settings));
      return settings;
    }

    function publish(saved) {
      const state = Session.normalize(saved);
      // A slower request must not paint over an already-received newer revision.
      if (current && state.revision < current.revision) return current;
      current = state;
      listeners.forEach((listener) => listener(state));
      return state;
    }

    async function request(command, extra = {}) {
      let response;
      try {
        response = await chrome.runtime.sendMessage({ channel: 'lock-in-buddy', command, ...extra });
      } catch {
        throw new Error('Buddy could not reconnect. If you reloaded the extension, refresh this website tab.');
      }
      if (!response?.ok) throw new Error(response?.error || 'Buddy could not save your changes. Please try again.');
      if (response.state) publish(response.state);
      if (response.settings) publishSettings(response.settings);
      return response;
    }

    function readLocal(key) {
      const value = localStorage.getItem(key);
      try { return value ? JSON.parse(value) : null; }
      catch { return null; }
    }

    function withLocalLock(work) {
      const run = () => globalThis.navigator?.locks
        ? navigator.locks.request(Session.STORAGE_KEY, work) : work();
      const result = localQueue.then(run);
      localQueue = result.catch(() => {});
      return result;
    }

    function updateLocal(action) {
      return withLocalLock(() => {
        const stored = readLocal(Session.STORAGE_KEY);
        const previous = Session.normalize(stored);
        const state = Session.reduce(previous, action);
        if (!stored || !Array.isArray(stored.history) || (!stored.active && previous.active)
          || state.revision !== previous.revision) {
          localStorage.setItem(Session.STORAGE_KEY, JSON.stringify(state));
        }
        // Native storage events reach other tabs, but not other clients in this
        // document (Buddy and the preview dashboard each have their own client).
        window.dispatchEvent(new CustomEvent('lock-in-buddy-session-change', { detail: state }));
        return current;
      });
    }

    const storageListener = (changes, area) => {
      if (area === 'local' && changes[Session.STORAGE_KEY]?.newValue) publish(changes[Session.STORAGE_KEY].newValue);
      if (area === 'local' && changes[Analysis.SETTINGS_KEY]) publishSettings(changes[Analysis.SETTINGS_KEY].newValue);
    };
    const localListener = (event) => {
      if (event.key === Session.STORAGE_KEY || event.key === null) publish(readLocal(Session.STORAGE_KEY));
    };
    const samePageListener = (event) => publish(event.detail);
    if (isExtension) chrome.storage.onChanged.addListener(storageListener);
    else {
      window.addEventListener('storage', localListener);
      window.addEventListener('lock-in-buddy-session-change', samePageListener);
    }

    return {
      isExtension,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeSettings(listener) {
        settingsListeners.add(listener);
        return () => settingsListeners.delete(listener);
      },
      async setDetection(enabled) {
        if (!isExtension) throw new Error('AI checks are available in the installed Chrome extension.');
        return (await request('aiSettings', { enabled })).settings;
      },
      async analyzeVideo(video) {
        if (!isExtension) return { skipped: true };
        return (await request('analyze', video)).analysis;
      },
      async load() {
        if (isExtension) return request('load');
        const state = await updateLocal({ type: 'reconcile' });
        const settings = publishSettings({ enabled: false });
        return { state, ui: Session.normalizeUI(readLocal(uiKey)), settings };
      },
      async dispatch(action) {
        return isExtension ? (await request('session', { action })).state : updateLocal(action);
      },
      async saveUI(patch) {
        if (isExtension) return (await request('ui', { patch })).ui;
        return withLocalLock(() => {
          const ui = Session.normalizeUI({ ...Session.normalizeUI(readLocal(uiKey)), ...patch });
          localStorage.setItem(uiKey, JSON.stringify(ui));
          return ui;
        });
      },
      destroy() {
        listeners.clear();
        settingsListeners.clear();
        if (isExtension) chrome.storage.onChanged.removeListener(storageListener);
        else {
          window.removeEventListener('storage', localListener);
          window.removeEventListener('lock-in-buddy-session-change', samePageListener);
        }
      },
    };
  }

  globalThis.LockInBuddyStore = { createClient };
})();
