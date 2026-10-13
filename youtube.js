// Only inspect the current watch-page title. No transcripts or browsing history.
(() => {
  if (globalThis.LockInBuddyYouTube) return;

  function readVideo(document, location) {
    const url = new URL(location.href);
    const id = url.searchParams.get('v');
    if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/watch' || !id) return null;
    const player = document.querySelector('ytd-watch-flexy[video-id]');
    // YouTube can update the URL before replacing the old video's heading.
    if (player && player.getAttribute('video-id') !== id) return null;
    const heading = document.querySelector('ytd-watch-metadata h1 yt-formatted-string, ytd-watch-metadata h1, #info-contents h1');
    const title = heading?.textContent?.trim();
    const tabTitle = document.title?.replace(/ - YouTube$/, '').replace(/^\(\d+\)\s*/, '').trim();
    // Wait if the tab title and heading are still from different SPA updates.
    if (document.title?.endsWith(' - YouTube') && tabTitle !== title) return null;
    return title && title.length <= 500 ? { id, title } : null;
  }

  // This controller is independent of the DOM, so navigation/race rules can be tested.
  function createWatcher({ readVideo, analyze, onFeedback }) {
    let state = null;
    let enabled = false;
    let navigating = false;
    let key = '';
    let generation = 0;
    let destroyed = false;

    function snapshot() {
      if (!enabled) return { key: 'off', status: 'off' };
      if (state?.status !== 'running' || !state.task || state.endTime <= Date.now()) return { key: 'idle', status: 'idle' };
      const video = navigating ? null : readVideo();
      if (!video) return { key: 'waiting', status: 'waiting' };
      return { key: JSON.stringify([state.active?.id, state.task, video.id, video.title]), task: state.task, video };
    }

    async function scan() {
      if (destroyed) return;
      const current = snapshot();
      if (current.key === key) return;
      key = current.key;
      const requestGeneration = ++generation;
      if (!current.video) { onFeedback({ status: current.status }); return; }
      onFeedback({ status: 'checking' });
      let result;
      try { result = await analyze({ videoTitle: current.video.title, task: current.task }); }
      catch (error) { result = { error: error.message || 'The video check is unavailable.' }; }
      // A response from a previous video/session must never paint the current one.
      if (destroyed || requestGeneration !== generation || snapshot().key !== current.key) return;
      if (result.skipped) { onFeedback({ status: 'idle' }); return; }
      onFeedback(result.error ? { status: 'error', error: result.error } : { status: 'result', ...result });
    }

    return {
      scan,
      update(next, settings) { state = next; enabled = settings.enabled; return scan(); },
      navigate(started) { navigating = started; return scan(); },
      retry() { key = ''; return scan(); },
      destroy() { destroyed = true; generation += 1; },
    };
  }

  function observe(watcher, document, window) {
    let debounce = null;
    const schedule = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => watcher.scan(), 600);
    };
    const start = () => watcher.navigate(true);
    const finish = () => { watcher.navigate(false); schedule(); };
    const visible = () => { if (!document.hidden) schedule(); };
    const observer = new MutationObserver((records) => {
      // Buddy's own countdown/rendering changes should not reset the debounce.
      if (records.some((record) => {
        const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        return !element?.closest('#lock-in-buddy-root');
      })) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['video-id'] });
    document.addEventListener('yt-navigate-start', start);
    document.addEventListener('yt-navigate-finish', finish);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('popstate', finish);
    // The fallback also notices timer expiry and history.replaceState navigation.
    const interval = setInterval(() => watcher.scan(), 1000);
    schedule();
    return () => {
      clearTimeout(debounce);
      clearInterval(interval);
      observer.disconnect();
      document.removeEventListener('yt-navigate-start', start);
      document.removeEventListener('yt-navigate-finish', finish);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('popstate', finish);
      watcher.destroy();
    };
  }

  globalThis.LockInBuddyYouTube = { readVideo, createWatcher, observe };
})();
