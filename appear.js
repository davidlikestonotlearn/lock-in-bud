// Chrome runs this file as a content script. The dashboard loads it with a script tag.
// An IIFE

(() => {
  // Do not add another buddy if these scripts run a second time.
  // If the website happens to use this ID, leave its element alone too.
  if (document.getElementById('lock-in-buddy-root')) return;

  const root = document.createElement('div');
  root.id = 'lock-in-buddy-root';
  root.dataset.lockInBuddyRoot = 'true';

  // This is fixed HTML written by us. Chat input is displayed with textContent in buddy.js.
  // Prefixing IDs keeps names like "messages" and "chat-input" available to the website.
  root.innerHTML = `
    <section id="lock-in-buddy-panel" class="buddy-panel" aria-label="Buddy panel" hidden>

      <header class="panel-header">
        <div class="mini-buddy" aria-hidden="true">••</div>
        <div><h2>Your buddy</h2><p><span class="status-dot"></span> Here for you</p></div>
        <button id="lock-in-buddy-close-panel" class="icon-button" aria-label="Close buddy panel" type="button">×</button>
      </header>

      <div class="focus-plan">
        <p class="plan-label">YOUR FOCUS</p>
        <p id="lock-in-buddy-current-task" class="current-task">Set a task to begin.</p>
        <p id="lock-in-buddy-current-step" class="current-step" hidden></p>
        <details id="lock-in-buddy-task-editor" open>
          <summary>Set or edit your task</summary>
          <form id="lock-in-buddy-task-form" class="task-form">
            <label for="lock-in-buddy-task-input">What are you working on?</label>
            <input id="lock-in-buddy-task-input" placeholder="e.g. Study biology" maxlength="500" autocomplete="off" required />
            <label for="lock-in-buddy-step-input">First small step (optional)</label>
            <input id="lock-in-buddy-step-input" placeholder="e.g. Review five flashcards" maxlength="500" autocomplete="off" />
            <button id="lock-in-buddy-save-task" class="primary-button" type="submit">Save task</button>
            <p class="task-help">Saving a changed task resets the shared timer.</p>
          </form>
        </details>
      </div>
      <div class="ai-tools">
        <label class="ai-toggle" for="lock-in-buddy-ai-enabled">
          <input id="lock-in-buddy-ai-enabled" type="checkbox" aria-describedby="lock-in-buddy-ai-privacy" />
          Check YouTube relevance with AI
        </label>
        <p id="lock-in-buddy-ai-privacy" class="ai-privacy">Optional · sends your saved task and current video title to the local analysis service and GroqCloud during a running focus session.</p>
        <p id="lock-in-buddy-ai-status" class="ai-status" role="status">AI checks are off.</p>
        <button id="lock-in-buddy-ai-retry" class="reset-button" type="button" hidden>Check again</button>
      </div>
      <p id="lock-in-buddy-save-status" class="save-status" role="status">Loading your session…</p>
      <button id="lock-in-buddy-retry-load" class="reset-button" type="button" hidden>Retry loading session</button>

      <div class="tabs" role="tablist" aria-label="Buddy tools">
        <button id="lock-in-buddy-chat-tab" class="tab active" role="tab" aria-selected="true" aria-controls="lock-in-buddy-chat-view" type="button">Chat</button>
        <button id="lock-in-buddy-timer-tab" class="tab" role="tab" aria-selected="false" aria-controls="lock-in-buddy-timer-view" tabindex="-1" type="button">Focus timer</button>
      </div>

      <div id="lock-in-buddy-chat-view" role="tabpanel" aria-labelledby="lock-in-buddy-chat-tab">
        <div id="lock-in-buddy-messages" class="messages" role="log" aria-live="polite" aria-label="Chat messages"></div>
        <p class="demo-note">Demo chat · try “done”, “more time”, or “break”</p>
        <form id="lock-in-buddy-chat-form" class="chat-form">
          <label class="sr-only" for="lock-in-buddy-chat-input">Message your buddy</label>
          <input id="lock-in-buddy-chat-input" placeholder="Tell buddy what’s on your mind…" maxlength="500" autocomplete="off" required />
          <button class="send-button" aria-label="Send message" type="submit">↑</button>
        </form>
        <button id="lock-in-buddy-chat-focus" class="primary-button chat-focus" type="button">Start 25 min focus</button>
      </div>

      <div id="lock-in-buddy-timer-view" class="timer-view" role="tabpanel" aria-labelledby="lock-in-buddy-timer-tab" hidden>
        <p class="timer-label">FOCUS TIME - LET'S LOCK IN</p>
        <div id="lock-in-buddy-timer-display" class="timer-display" role="timer" aria-label="Time remaining">25:00</div>
        <p id="lock-in-buddy-timer-status">Ready when you are.</p>
        <div class="durations" aria-label="Timer duration">
          <button data-minutes="5" aria-pressed="false" type="button">5 min</button>
          <button data-minutes="10" aria-pressed="false" type="button">10 min</button>
          <button data-minutes="25" class="selected" aria-pressed="true" type="button">25 min</button>
        </div>
        <button id="lock-in-buddy-start-timer" class="primary-button" type="button">Start focusing</button>
        <button id="lock-in-buddy-reset-timer" class="reset-button" type="button">Reset timer</button>
        <button id="lock-in-buddy-check-in" class="reset-button" type="button" hidden>Check in with Buddy</button>
        <p id="lock-in-buddy-timer-announcement" class="sr-only" aria-live="polite"></p>
      </div>

      <div id="lock-in-buddy-session-note" class="panel-footer">Small steps count, too.</div>
    </section>

    <button id="lock-in-buddy-ai-reminder" class="ai-reminder" type="button" aria-label="Open Buddy’s video reminder" hidden>
      <span role="status">This video may be a detour. Let’s return to your task.</span>
    </button>

    <button id="lock-in-buddy-button" class="buddy" aria-label="Open buddy chat. Drag to move." aria-expanded="false" aria-controls="lock-in-buddy-panel" type="button">
      <span class="buddy-face" aria-hidden="true"><span class="eyes"><i></i><i></i></span><span class="smile"></span></span>
    </button>
  `;

  // Keep the buddy outside the website's app container so in-page navigation leaves it in place.
  document.body.append(root);
})();
