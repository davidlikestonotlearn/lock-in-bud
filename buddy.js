// appear.js creates the HTML before this file runs, in Chrome and in the dashboard.
(() => {

  const root = document.getElementById('lock-in-buddy-root');

  // Only initialize our own container, once. Leave any same-named website element alone.
  if (!root || root.dataset.lockInBuddyRoot !== 'true' || root.dataset.buddyInitialized === 'true') return; // Already attach buddies behavior
  root.dataset.buddyInitialized = 'true'; 

  // Search inside root instead of searching the website's entire document.
  const buddy = root.querySelector('#lock-in-buddy-button');
  const panel = root.querySelector('#lock-in-buddy-panel');
  const chatTab = root.querySelector('#lock-in-buddy-chat-tab');
  const timerTab = root.querySelector('#lock-in-buddy-timer-tab');
  const Session = globalThis.LockInBuddySession;
  const store = globalThis.LockInBuddyStore.createClient();
  const saveStatus = root.querySelector('#lock-in-buddy-save-status');
  const retryLoad = root.querySelector('#lock-in-buddy-retry-load');
  const aiToggle = root.querySelector('#lock-in-buddy-ai-enabled');
  const aiStatus = root.querySelector('#lock-in-buddy-ai-status');
  const aiRetry = root.querySelector('#lock-in-buddy-ai-retry');
  const aiReminder = root.querySelector('#lock-in-buddy-ai-reminder');
  const isYouTube = store.isExtension && location.origin === 'https://www.youtube.com';
  let settings = { enabled: false };
  let settingsBusy = false;
  let aiFeedback = { status: 'off' };
  let watcher = null;
  let state = null;
  let ready = false;
  let busy = false;

  function showError(error) {
    saveStatus.textContent = error.message || 'Buddy could not save your changes. Please try again.';
    saveStatus.classList.add('save-error');
    saveStatus.hidden = false;
  }

  function saveUI(patch) {
    if (ready) store.saveUI(patch).catch(showError);
  }

  // UI choices are separate from the shared task/timer, so dragging never
  // overwrites a newer session. Save only when a drag or other UI action finishes.
  function savePosition() {
    const rect = buddy.getBoundingClientRect();
    saveUI({ position: { left: rect.left, top: rect.top } });
  }

  function placeBuddy(position) {
    buddy.style.left = `${Math.max(0, Math.min(position.left, window.innerWidth - buddy.offsetWidth))}px`;
    buddy.style.top = `${Math.max(0, Math.min(position.top, window.innerHeight - buddy.offsetHeight))}px`;
    positionPanel();
  }

  // Keep clicks and typing inside buddy from triggering the website's shortcuts.
  root.addEventListener('click', (event) => event.stopPropagation());
  root.addEventListener('keyup', (event) => event.stopPropagation());

  // Place the open panel near buddy without going off-screen.
  function positionPanel() {
    aiReminder.hidden = !panel.hidden || aiFeedback.classification !== 'distracting';
    if (!aiReminder.hidden) {
      const rect = buddy.getBoundingClientRect();
      const top = rect.top >= aiReminder.offsetHeight + 24 ? rect.top - aiReminder.offsetHeight - 12 : rect.bottom + 12;
      aiReminder.style.left = `${Math.max(12, Math.min(rect.right - aiReminder.offsetWidth, window.innerWidth - aiReminder.offsetWidth - 12))}px`;
      aiReminder.style.top = `${Math.max(12, Math.min(top, window.innerHeight - aiReminder.offsetHeight - 12))}px`;
    }
    // An early return stops the function when there is nothing to position.
    if (panel.hidden) return;

    // This rectangle gives buddy's current position and size in the browser window.
    const rect = buddy.getBoundingClientRect();
    panel.style.maxHeight = `${window.innerHeight - 24}px`; // Limits the panels height
    panel.style.overflowY = 'auto'; // Allows overflow, scrolling if necessary

    let left = rect.right - panel.offsetWidth;
    const aboveSpace = rect.top - 24;
    const belowSpace = window.innerHeight - rect.bottom - 24;
    let top;

    if (panel.offsetHeight <= aboveSpace) top = rect.top - panel.offsetHeight - 12;
    else if (panel.offsetHeight <= belowSpace) top = rect.bottom + 12;
    else if (rect.right + panel.offsetWidth + 24 <= window.innerWidth || rect.left - panel.offsetWidth >= 24) {
      // A tall panel can sit beside Buddy instead of covering the chat controls.
      left = rect.right + panel.offsetWidth + 24 <= window.innerWidth
        ? rect.right + 12 : rect.left - panel.offsetWidth - 12;
      top = rect.top + (rect.height - panel.offsetHeight) / 2;
    } else {
      // On narrow screens, scroll the panel in the larger space above or below.
      panel.style.maxHeight = `${Math.min(window.innerHeight - 24, Math.max(120, aboveSpace, belowSpace))}px`;
      top = aboveSpace >= belowSpace ? rect.top - panel.offsetHeight - 12 : rect.bottom + 12;
    }
    // Math.min sets the upper limit; Math.max sets the lower limit (a 12px margin).
    panel.style.left = `${Math.max(12, Math.min(left, window.innerWidth - panel.offsetWidth - 12))}px`;
    panel.style.top = `${Math.max(12, Math.min(top, window.innerHeight - panel.offsetHeight - 12))}px`;
  }

  // Show the panel when open is true; hide it when false.
  // It also moves keyboard focus and tells screen readers whether the panel is open.
  function setPanelOpen(open, moveFocus = true) {
    // ! reverses a boolean, if open/true, hidden is false. vice versa
    panel.hidden = !open;

    buddy.setAttribute('aria-expanded', String(open));
    if (open && chatTab.classList.contains('active')) scrollChatToLatest();
    positionPanel(); // Runs panel positioning

    // When opening, put keyboard focus on the selected tab button.
    // Focus moves the keyboard to that tab
    if (moveFocus) {
      if (open) (chatTab.classList.contains('active') ? chatTab : timerTab).focus();
      else buddy.focus();
    }
    saveUI({ panelOpen: open });
  }

  function scrollChatToLatest() {
    const log = root.querySelector('#lock-in-buddy-messages');
    log.scrollTop = log.scrollHeight;
  }

  // Dragging state: null means no drag is happening; otherwise drag stores its details.
  // suppressClick prevents releasing a drag from also opening or closing the panel.
  // Pointer events work for a mouse, touch screen, or pen.
  let drag = null;
  let suppressClick = false;
  // This callback runs when a pointer presses buddy. Save where the drag began.
  buddy.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return; // 0 is left click, everything else, ignore this function

    const rect = buddy.getBoundingClientRect();
    drag = {x: event.clientX, // Pointers horizontal & vertical position
            y: event.clientY, 
            left: rect.left, // Buddys hori & vert position
            top: rect.top, 
            moved: false }; // Determines if a press is a drag
    suppressClick = false; 

    // Keep receiving pointer events even when the pointer leaves buddy's circle.
    buddy.setPointerCapture(event.pointerId); 
  });

  // While dragging, move buddy by the distance the pointer has traveled.
  buddy.addEventListener('pointermove', (event) => {
    if (!drag) return; // Stop if there is no active drag to track.

    // Calculates the position how far the pointer move from where you pressed
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;

    // Ignore tiny movements so a slightly shaky click still counts as a click.
    if (Math.hypot(dx, dy) > 5) drag.moved = true; // Move more than 5px - drag moved
    if (!drag.moved) return; // If not, return

    buddy.classList.add('dragging'); // Adds dragging cursor

    // Move buddy to his starting position plus pointer movement, keeping him inside the window.
    buddy.style.left = `${Math.max(0, Math.min(drag.left + dx, window.innerWidth - buddy.offsetWidth))}px`;
    buddy.style.top = `${Math.max(0, Math.min(drag.top + dy, window.innerHeight - buddy.offsetHeight))}px`;
    positionPanel();
  });


  // Clear the dragging state and remember whether to ignore the next click.
  // Several pointer events share this function because each can end a drag.
  function finishDrag() {
    if (!drag) return;
    suppressClick = drag.moved;
    if (drag.moved) savePosition();
    drag = null;
    buddy.classList.remove('dragging');
  }

  buddy.addEventListener('pointerup', finishDrag);
  buddy.addEventListener('pointercancel', finishDrag);
  buddy.addEventListener('lostpointercapture', finishDrag);

  // A normal click toggles the panel; a click caused by dragging is ignored.
  buddy.addEventListener('click', (event) => {
    // detail === 0 includes keyboard clicks, which should still work after dragging.
    if (suppressClick && event.detail !== 0) // If you are releasing 
      { suppressClick = false; return; }  // Clear the flag and exit before toggling the panel.

    setPanelOpen(panel.hidden);
  });

  // Clicking the close button calls setPanelOpen with false to hide the panel.
  root.querySelector('#lock-in-buddy-close-panel').addEventListener('click', () => setPanelOpen(false));
  aiReminder.addEventListener('click', () => setPanelOpen(true));

  // This keyboard callback lets Escape close an open panel.
  root.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault();
      setPanelOpen(false);
    }
  });

  // Clamp to the new viewport, but keep the saved preference so a temporarily
  // small window does not permanently move Buddy on the next full-sized reload.
  window.addEventListener('resize', () => placeBuddy(buddy.getBoundingClientRect()));

  // Show the view belonging to the supplied chat or timer button.
  function switchTab(tab) {
    // forEach runs this callback once for each button, updating both tabs.
    [chatTab, timerTab].forEach((button) => {
      const selected = button === tab; // Returns true or false based on what tab is 
      button.classList.toggle('active', selected); // Add the active class when selected; remove it otherwise.
      button.setAttribute('aria-selected', String(selected));

      // Only the selected tab is reached with the Tab key; arrows switch between tabs.
      button.tabIndex = selected ? 0 : -1;
      // aria-controls contains the ID of the view this button belongs to.
      root.querySelector(`#${button.getAttribute('aria-controls')}`).hidden = !selected;
    });
    if (tab === chatTab) scrollChatToLatest();
    positionPanel(); // Fix the position since chat and timer have different heights
    saveUI({ tab: tab === timerTab ? 'timer' : 'chat' });
  }

  // Set up the same click and keyboard behavior for each tab button.
  [chatTab, timerTab].forEach((tab) => {
    // A click selects this particular tab.
    tab.addEventListener('click', () => switchTab(tab));
    // Arrow keys switch tabs; Home selects chat and End selects the timer.
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); // Stop these keys from scrolling the page.
      const next = event.key === 'Home' ? chatTab : event.key === 'End' ? timerTab : tab === chatTab ? timerTab : chatTab;
      switchTab(next);
      next.focus();
    });
  });

  const messages = root.querySelector('#lock-in-buddy-messages');
  const taskInput = root.querySelector('#lock-in-buddy-task-input');
  const stepInput = root.querySelector('#lock-in-buddy-step-input');
  const taskEditor = root.querySelector('#lock-in-buddy-task-editor');
  const taskForm = root.querySelector('#lock-in-buddy-task-form');
  const currentTask = root.querySelector('#lock-in-buddy-current-task');
  const currentStep = root.querySelector('#lock-in-buddy-current-step');
  const chatInput = root.querySelector('#lock-in-buddy-chat-input');
  const chatFocus = root.querySelector('#lock-in-buddy-chat-focus');
  const display = root.querySelector('#lock-in-buddy-timer-display');
  const timerStatus = root.querySelector('#lock-in-buddy-timer-status');
  const startButton = root.querySelector('#lock-in-buddy-start-timer');
  const checkIn = root.querySelector('#lock-in-buddy-check-in');
  const announcement = root.querySelector('#lock-in-buddy-timer-announcement');
  const durationButtons = [...root.querySelectorAll('[data-minutes]')];
  const actionControls = [
    ...taskForm.querySelectorAll('input, button'), chatInput,
    root.querySelector('.send-button'), chatFocus, startButton,
    root.querySelector('#lock-in-buddy-reset-timer'), ...durationButtons,
  ];
  let taskDraftDirty = false;
  let messagesSignature = '';
  let completionPending = false;
  let nextCompletionAttempt = 0;

  function renderControls() {
    aiToggle.disabled = !ready || settingsBusy || !store.isExtension;
    actionControls.forEach((control) => { control.disabled = !ready || busy; });
    durationButtons.forEach((button) => {
      button.disabled = !ready || busy || state?.status === 'running';
    });
  }

  function renderTimer() {
    if (!state) return;
    const remaining = Session.secondsLeft(state);
    display.textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  }

  function renderSession(next) {
    const previous = state;
    state = next;
    currentTask.textContent = next.task ? `${next.taskDone ? '✓ ' : ''}${next.task}` : 'Set a task to begin.';
    currentStep.textContent = next.step ? `First step: ${next.step}` : '';
    currentStep.hidden = !next.step;
    // A sync from another tab must not erase an unfinished form edit.
    if (!taskDraftDirty) {
      taskInput.value = next.task;
      stepInput.value = next.step;
    }

    // Only touch the chat log when its contents change; timer ticks never rebuild
    // it or make screen readers announce the same conversation again.
    const signature = JSON.stringify(next.messages);
    if (signature !== messagesSignature) {
      const existingIds = [...messages.children].map((node) => node.dataset.messageId);
      const nextIds = new Set(next.messages.map((message) => message.id));
      [...messages.children].forEach((node) => {
        if (!nextIds.has(node.dataset.messageId)) node.remove();
      });
      next.messages.forEach((saved) => {
        if (existingIds.includes(saved.id)) return;
        const message = document.createElement('div');
        message.dataset.messageId = saved.id;
        message.className = `message ${saved.sender}-message`;
        message.textContent = saved.text; // User text is displayed, never evaluated as HTML.
        messages.append(message);
      });
      messages.scrollTop = messages.scrollHeight;
      messagesSignature = signature;
    }

    const labels = {
      idle: ['Ready when you are.', 'Start focusing'],
      running: ['One thing at a time. You’ve got this.', 'Pause timer'],
      paused: ['Paused. Resume when you’re ready.', 'Resume focusing'],
      completed: [next.taskDone ? 'Task complete. Nice work!' : 'Time is up! Check in with Buddy.', 'Start again'],
    };
    [timerStatus.textContent, startButton.textContent] = labels[next.status];
    chatFocus.textContent = next.status === 'running' ? 'View focus timer'
      : next.status === 'paused' ? 'Resume focus time' : `Start ${next.duration / 60} min focus`;
    checkIn.hidden = next.status !== 'completed';
    durationButtons.forEach((button) => {
      const selected = Number(button.dataset.minutes) * 60 === next.duration;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    if (next.status === 'completed' && previous?.status !== 'completed') {
      announcement.textContent = next.taskDone ? 'Task complete. Nice work!' : 'Timer complete. Check in with Buddy.';
    } else if (next.status !== 'completed') announcement.textContent = '';
    renderTimer();
    renderControls();
    positionPanel();
    watcher?.update(state, settings);
  }

  function renderAIFeedback(feedback) {
    aiFeedback = feedback;
    aiStatus.dataset.classification = feedback.classification || '';
    const statusText = {
      off: 'AI checks are off.',
      idle: 'Start or resume a focus session to check videos.',
      waiting: 'Open a YouTube video to check its relevance.',
      checking: 'Checking this video against your task…',
      error: `Video check unavailable. ${feedback.error || 'Try again later.'} Wait a minute before retrying.`,
    };
    const resultText = {
      relevant: 'This video looks related to your task.',
      distracting: 'This video may be a detour. Let’s return to your task.',
      uncertain: 'I’m not sure this video fits your task. You decide.',
    };
    aiStatus.textContent = feedback.status === 'result'
      ? `${resultText[feedback.classification]} ${feedback.reason}` : statusText[feedback.status];
    aiRetry.hidden = feedback.status !== 'error';
    positionPanel();
  }

  function renderSettings(next) {
    settings = next;
    aiToggle.checked = next.enabled;
    if (isYouTube) watcher?.update(state, settings);
    else {
      aiStatus.textContent = !store.isExtension ? 'AI checks are available in the installed Chrome extension.'
        : settings.enabled ? 'AI checks are on. Open a YouTube video during a focus session.' : 'AI checks are off.';
    }
  }

  aiToggle.addEventListener('change', async () => {
    settingsBusy = true;
    renderControls();
    try { await store.setDetection(aiToggle.checked); }
    catch (error) { aiToggle.checked = settings.enabled; aiStatus.textContent = error.message; }
    finally { settingsBusy = false; renderControls(); }
  });
  aiRetry.addEventListener('click', () => watcher?.retry());

  // Wait for the save before treating an action as successful. This also prevents
  // rapid repeated clicks in this tab; the worker handles overlapping other tabs.
  async function act(action) {
    if (!ready || busy) return false;
    busy = true;
    saveStatus.hidden = true;
    saveStatus.classList.remove('save-error');
    renderControls();
    try {
      await store.dispatch(action);
      return true;
    } catch (error) {
      showError(error);
      return false;
    } finally {
      busy = false;
      renderControls();
    }
  }

  taskForm.addEventListener('input', () => { taskDraftDirty = true; });
  taskEditor.addEventListener('toggle', positionPanel);
  taskForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const task = taskInput.value.trim();
    const step = stepInput.value.trim();
    if (!task) {
      showError(new Error('Give your task a name first.'));
      taskInput.focus();
      return;
    }
    if (await act({ type: 'setTask', task, step })) {
      taskDraftDirty = false;
      // Use the latest synced state if another tab changed the task while saving.
      taskInput.value = state.task;
      stepInput.value = state.step;
      taskEditor.open = false;
      switchTab(chatTab);
      chatInput.focus();
    }
  });

  root.querySelector('#lock-in-buddy-chat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = chatInput.value.trim();
    if (!text) return;
    if (await act({ type: 'chat', text })) {
      chatInput.value = '';
      if (state.task && !taskDraftDirty) taskEditor.open = false;
      chatInput.focus();
    }
  });

  function needsTask() {
    if (state?.task) return false;
    taskEditor.open = true;
    showError(new Error('Set a task above, or tell Buddy what you’re working on in chat.'));
    taskInput.focus();
    positionPanel();
    return true;
  }

  chatFocus.addEventListener('click', async () => {
    if (needsTask()) return;
    if (state.status === 'running' || await act({ type: 'start' })) {
      switchTab(timerTab);
      timerTab.focus();
    }
  });
  startButton.addEventListener('click', () => {
    if (needsTask()) return;
    act({ type: state.status === 'running' ? 'pause' : 'start' });
  });
  root.querySelector('#lock-in-buddy-reset-timer').addEventListener('click', () => act({ type: 'reset' }));
  durationButtons.forEach((button) => button.addEventListener('click', () => {
    act({ type: 'setDuration', duration: Number(button.dataset.minutes) * 60 });
  }));
  checkIn.addEventListener('click', () => {
    switchTab(chatTab);
    chatInput.focus();
  });

  // The interval only paints the display. Persisting every tick would create
  // unnecessary writes; one saved endTime is enough to recover the countdown.
  async function refreshTimer() {
    renderTimer();
    if (!ready || completionPending || Date.now() < nextCompletionAttempt
      || state?.status !== 'running' || Session.secondsLeft(state) > 0) return;
    completionPending = true;
    try { await store.dispatch({ type: 'reconcile' }); }
    catch (error) {
      nextCompletionAttempt = Date.now() + 5000;
      showError(error);
    }
    finally { completionPending = false; }
  }

  renderControls();
  let stopObserving = null;
  if (isYouTube) {
    const YouTube = globalThis.LockInBuddyYouTube;
    watcher = YouTube.createWatcher({
      readVideo: () => YouTube.readVideo(document, location),
      analyze: (video) => store.analyzeVideo(video), onFeedback: renderAIFeedback,
    });
    stopObserving = YouTube.observe(watcher, document, window);
  }
  store.subscribeSettings(renderSettings);
  store.subscribe(renderSession);
  let renderInterval = null;
  async function loadSession() {
    retryLoad.disabled = true;
    try {
      const { ui } = await store.load();
      if (ui.position) placeBuddy(ui.position);
      switchTab(ui.tab === 'timer' ? timerTab : chatTab);
      setPanelOpen(ui.panelOpen, false); // Restore without stealing the website's focus.
      taskEditor.open = !state.task;
      ready = true;
      saveStatus.hidden = true;
      root.querySelector('#lock-in-buddy-session-note').textContent = store.isExtension
        ? 'One focus session across your extension tabs.' : 'Saved in this browser · demo chat.';
      renderControls();
      positionPanel();
      saveStatus.classList.remove('save-error');
      retryLoad.hidden = true;
      if (!renderInterval) renderInterval = setInterval(refreshTimer, 250);
    } catch (error) {
      showError(error);
      retryLoad.hidden = false;
    } finally { retryLoad.disabled = false; }
  }
  retryLoad.addEventListener('click', loadSession);
  loadSession();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ready) {
      // Refresh after a suspended tab becomes visible, even if its events were delayed.
      store.dispatch({ type: 'reconcile' }).catch(showError);
      refreshTimer();
    }
  });
  // pagehide also happens when a page enters the back/forward cache, so only
  // discard the connection when the page is really leaving.
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) {
      clearInterval(renderInterval);
      stopObserving?.();
      store.destroy();
    }
  });
})();
