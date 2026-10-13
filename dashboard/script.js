// The dashboard uses the same client and saved snapshot as the floating Buddy.
(() => {
  const Session = globalThis.LockInBuddySession;
  const store = globalThis.LockInBuddyStore.createClient();
  const get = (id) => document.getElementById(id);
  const status = get('dashboard-status');
  let state = null;
  let visibleRows = 20;
  let historySignature = '';
  let reconcilePending = false;
  let retryAt = 0;

  function formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  function showError(error) {
    status.hidden = false;
    status.classList.add('error');
    status.textContent = error.message || 'Could not load your study data. Please try again.';
    get('retry-load').hidden = false;
  }

  function renderStats() {
    if (!state) return;
    const stats = Session.statistics(state);
    get('today-time').textContent = formatTime(stats.todayMs);
    get('completed-count').textContent = String(stats.completedSessions);
    get('total-time').textContent = formatTime(stats.totalMs);
    get('average-time').textContent = formatTime(stats.averageMs);
    const remaining = Session.secondsLeft(state);
    const clock = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
    const details = { idle: 'Ready when you are.', running: `Focusing · ${clock} remaining`,
      paused: `Paused · ${clock} remaining`, completed: state.taskDone ? 'Task complete. Nice work!' : 'Focus time complete. Check in with Buddy.' };
    get('focus-heading').textContent = state.task || 'Set a task to begin.';
    get('focus-detail').textContent = state.task ? details[state.status] : 'Open Buddy to set your task and timer.';
  }

  function renderHistory() {
    const records = [...state.history].sort((a, b) => b.endedAt - a.endedAt);
    get('history-count').textContent = `${records.length} saved ${records.length === 1 ? 'session' : 'sessions'}`;
    get('history-empty').hidden = records.length > 0;
    get('history-table-container').hidden = records.length === 0;
    get('load-more').hidden = records.length <= visibleRows;
    const rows = document.createDocumentFragment();
    for (const record of records.slice(0, visibleRows)) {
      const row = document.createElement('tr');
      const result = record.outcome === 'reset' ? 'Reset · partial' : record.reason === 'done' ? 'Completed early' : 'Completed';
      for (const text of [record.task, new Date(record.endedAt).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      }), formatTime(record.plannedDuration * 1000), formatTime(record.focusedMs), result]) {
        const cell = document.createElement('td');
        cell.textContent = text; // A task name is data, never HTML.
        row.append(cell);
      }
      row.lastElementChild.className = `result ${record.outcome}`;
      rows.append(row);
    }
    get('history-rows').replaceChildren(rows);
  }

  function render(next) {
    state = next;
    renderStats();
    const signature = JSON.stringify(next.history);
    if (signature !== historySignature) {
      historySignature = signature;
      renderHistory();
    }
  }

  async function load() {
    get('retry-load').disabled = true;
    try {
      await store.load();
      status.hidden = true;
      status.classList.remove('error');
      get('retry-load').hidden = true;
      get('open-buddy').disabled = false;
    } catch (error) { showError(error); }
    finally { get('retry-load').disabled = false; }
  }

  async function tick() {
    renderStats();
    if (!state || state.status !== 'running' || Session.secondsLeft(state) > 0
      || reconcilePending || Date.now() < retryAt) return;
    reconcilePending = true;
    try {
      await store.dispatch({ type: 'reconcile' });
      status.hidden = true;
      get('retry-load').hidden = true;
    } catch (error) {
      retryAt = Date.now() + 5000;
      showError(error);
    } finally { reconcilePending = false; }
  }

  get('data-source').textContent = store.isExtension
    ? 'Study history is saved locally in your Chrome profile. Optional AI checks send only your task and current YouTube title to the analysis service and GroqCloud.'
    : 'Local preview · This demo uses separate browser data. Open the extension icon for your real study history.';
  get('open-buddy').addEventListener('click', () => {
    if (get('lock-in-buddy-panel').hidden) get('lock-in-buddy-button').click();
    get('lock-in-buddy-timer-tab').click();
    get('lock-in-buddy-timer-tab').focus();
  });
  get('retry-load').addEventListener('click', load);
  get('load-more').addEventListener('click', () => { visibleRows += 20; renderHistory(); });
  store.subscribe(render);
  load();
  const interval = setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) { clearInterval(interval); store.destroy(); }
  });
})();
