// Small shared helpers for opt-in settings and worker-to-backend requests.
(() => {
  if (globalThis.LockInBuddyAnalysis) return;
  const SETTINGS_KEY = 'lock-in-buddy-ai-v1';
  const API_URL = 'http://127.0.0.1:3000/api/analyze';
  const normalizeSettings = (saved) => ({ enabled: saved?.enabled === true });
  const validResult = (result) => result && ['relevant', 'distracting', 'uncertain'].includes(result.classification)
    && typeof result.reason === 'string' && result.reason.trim().length > 0 && result.reason.length <= 300;

  function createService({ fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 12000 } = {}) {
    const pending = new Map();
    const cache = new Map();

    async function request(task, videoTitle, controller) {
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(API_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task, videoTitle }), signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok) {
          return { error: typeof body.message === 'string' ? body.message.slice(0, 300) : 'The analysis service is unavailable. Try again later.' };
        }
        if (!validResult(body)) return { error: 'The analysis service returned an unexpected result.' };
        return { classification: body.classification, reason: body.reason.trim() };
      } catch {
        return { error: controller.signal.aborted ? 'The video check timed out. Try again later.'
          : 'Start the local analysis server, then try again.' };
      } finally { clearTimeout(timeout); }
    }

    function analyze(task, videoTitle) {
      const key = JSON.stringify([task, videoTitle]);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return Promise.resolve(cached.result);
      if (pending.has(key)) return pending.get(key).promise;
      const controller = new AbortController();
      const entry = { controller };
      entry.promise = request(task, videoTitle, controller).then((result) => {
        // Disabling detection clears/aborts entries; their late results stay discarded.
        if (pending.get(key) === entry) {
          for (const [savedKey, saved] of cache) if (saved.expiresAt <= now()) cache.delete(savedKey);
          cache.set(key, { result, expiresAt: now() + (result.error ? 60000 : 5 * 60000) });
          while (cache.size > 50) cache.delete(cache.keys().next().value);
        }
        return result;
      }).finally(() => { if (pending.get(key) === entry) pending.delete(key); });
      pending.set(key, entry);
      return entry.promise;
    }

    function clear() {
      cache.clear();
      for (const entry of pending.values()) entry.controller.abort();
      pending.clear();
    }
    return { analyze, clear };
  }

  globalThis.LockInBuddyAnalysis = { SETTINGS_KEY, API_URL, normalizeSettings, validResult, createService };
})();
