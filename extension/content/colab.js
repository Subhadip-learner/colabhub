// content/colab.js — the ColabHub presence on the Colab page.
//
//   1. Ctrl/Cmd+S                       → 'notebookSaved'   (debounced auto-sync in the background)
//   2. a code cell finishes executing   → 'cellExecuted'    (Auto-Push, if enabled for this notebook)
//   3. a small toast in the corner shows commit status ("Pushed notebook to main after cell run")
//
// We never scrape the DOM for notebook *content* (fragile); the bytes come from Google Drive.
// Execution detection is deliberately loose: Colab's DOM changes, so we combine several signals
// and let the background debounce them.

(() => {
  if (window.__colabHubInstalled) return;
  window.__colabHubInstalled = true;

  const send = (msg, cb) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError; // extension reloaded → ignore
        cb?.(res);
      });
    } catch {
      /* extension context invalidated; page needs refresh */
    }
  };

  // ------------------------------------------------------------- 1. save --
  let lastSave = 0;
  window.addEventListener(
    'keydown',
    (e) => {
      const isSave = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's';
      if (!isSave) return;
      const now = Date.now();
      if (now - lastSave < 2000) return;
      lastSave = now;
      send({ type: 'notebookSaved' });
    },
    true,
  );

  // ----------------------------------------------------- 2. cell execution --
  //
  // Signals (any of them counts as "a cell ran"):
  //   a) Shift+Enter / Ctrl+Enter / Alt+Enter while focus is inside a cell editor
  //   b) click on a cell's run button (the ▶ circle) or "Runtime → Run all/… " menu items
  //   c) a cell element leaves the "running/pending" state (attribute or class change)
  // (a)+(b) fire at *start*; (c) fires at *end*. We report the end when we can see it, otherwise
  // the start, and the background debounces (8 s after the last signal) before pushing.

  let lastRun = 0;
  const RUN_MIN_GAP = 1500;
  const notifyRun = (why) => {
    const now = Date.now();
    if (now - lastRun < RUN_MIN_GAP) return;
    lastRun = now;
    send({ type: 'cellExecuted', why }, (res) => {
      if (res?.ok && res.result?.scheduled) toast('⏳ Cell ran — pushing to GitHub shortly…', 'pending', 3000);
    });
  };

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' || !(e.shiftKey || e.ctrlKey || e.metaKey || e.altKey)) return;
      const t = e.target;
      const inEditor = t?.closest?.('.cell, .codecell, colab-cell, .monaco-editor, .inputarea, [class*="cell"]');
      if (inEditor) startRunWatch('key');
    },
    true,
  );

  window.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const runBtn = t.closest('colab-run-button, .cell-execution, .cell-execution-container, [aria-label^="Run cell"], [aria-label="Run"], [command="runtime-run-cell"], [command="runtime-run-all"], [command="runtime-run-before"], [command="runtime-run-after"], [command="runtime-run-selection"]');
      if (runBtn) startRunWatch('click');
    },
    true,
  );

  // (c) watch for running → done transitions
  let watching = false;
  let watchTimer = null;
  let observer = null;
  const RUNNING_SELECTOR = '.cell.running, .cell.pending, colab-cell[running], [class*="cell"][class*="running"], .cell-execution.running, colab-run-button[running], .running';

  function anyRunning() {
    try {
      return document.querySelector(RUNNING_SELECTOR) != null;
    } catch {
      return false;
    }
  }

  function startRunWatch(why) {
    // Report immediately if we can't see a running state (e.g. instant cells) — the background
    // debounce makes this safe.
    if (!anyRunning()) {
      // give Colab a tick to flip into "running"; if it never does, treat the keypress as the run
      setTimeout(() => (anyRunning() ? armObserver(why) : notifyRun(why)), 150);
      return;
    }
    armObserver(why);
  }

  function armObserver(why) {
    if (watching) return;
    watching = true;
    observer = new MutationObserver(() => {
      if (anyRunning()) return;
      // settled: nothing running anymore
      stopWatch();
      notifyRun(`${why}:done`);
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'running', 'aria-busy'], childList: true });
    // never watch forever (long-running training cells): push after 10 min at the latest
    watchTimer = setTimeout(() => {
      stopWatch();
      notifyRun(`${why}:timeout`);
    }, 10 * 60 * 1000);
  }

  function stopWatch() {
    watching = false;
    observer?.disconnect();
    observer = null;
    clearTimeout(watchTimer);
    watchTimer = null;
  }

  // ------------------------------------------------------------- 3. toast --
  let host = null;
  let hideTimer = null;
  function ensureHost() {
    if (host?.isConnected) return host;
    host = document.createElement('div');
    host.id = 'colabhub-toast-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
        .toast { display: flex; align-items: center; gap: 10px; max-width: 360px; padding: 10px 14px; border-radius: 10px; color: #fff;
                 background: #0b1a44; box-shadow: 0 8px 24px rgba(0,0,0,.28); border: 1px solid rgba(255,255,255,.12);
                 opacity: 0; transform: translateY(8px); transition: opacity .18s ease, transform .18s ease; pointer-events: auto; }
        .toast.show { opacity: 1; transform: none; }
        .toast[data-kind="ok"] { background: #0f5132; }
        .toast[data-kind="pending"] { background: #0b1a44; }
        .toast[data-kind="warn"] { background: #7a4b00; }
        .toast[data-kind="error"] { background: #7a1f1f; }
        .logo { width: 20px; height: 20px; border-radius: 5px; flex: none; background: #0b1a44 url(${chrome.runtime.getURL('icons/icon32.png')}) center/cover; box-shadow: 0 0 0 1px rgba(255,255,255,.25); }
        .msg { flex: 1; }
        .msg b { font-weight: 600; }
        a { color: #cfe1ff; text-decoration: underline; }
        button { all: unset; cursor: pointer; opacity: .7; padding: 0 2px; }
        button:hover { opacity: 1; }
      </style>
      <div class="toast" role="status" aria-live="polite">
        <span class="logo"></span>
        <span class="msg"></span>
        <button title="Dismiss" aria-label="Dismiss">✕</button>
      </div>`;
    shadow.querySelector('button').addEventListener('click', hideToast);
    (document.body || document.documentElement).appendChild(host);
    return host;
  }

  function toast(html, kind = 'ok', ms = 4500) {
    const h = ensureHost();
    const t = h.shadowRoot.querySelector('.toast');
    t.dataset.kind = kind;
    h.shadowRoot.querySelector('.msg').innerHTML = html;
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(hideTimer);
    if (ms > 0) hideTimer = setTimeout(hideToast, ms);
  }

  function hideToast() {
    host?.shadowRoot?.querySelector('.toast')?.classList.remove('show');
  }

  // Status pushed from the background (after a sync finishes) …
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'syncStatus') return;
    showStatus(msg.status, msg.meta);
  });

  // … and a light poll as a fallback (service worker may have been asleep when the tab loaded).
  let lastShownAt = 0;
  function showStatus(status, meta = {}) {
    if (!status || !status.at || status.at <= lastShownAt) return;
    lastShownAt = status.at;
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const link = meta.commitUrl || status.commitUrl ? ` · <a href="${esc(meta.commitUrl || status.commitUrl)}" target="_blank" rel="noopener">view commit</a>` : '';
    switch (status.state) {
      case 'synced':
        if (status.trigger === 'cell') toast(status.pushed === false ? `✔ ${esc(status.message)}` : `✅ <b>${esc(status.message)}</b>${link}`, status.pushed === false ? 'pending' : 'ok');
        else if (status.pushed && (status.trigger === 'save' || status.trigger === 'interval')) toast(`✅ <b>${esc(status.message)}</b>${link}`, 'ok');
        break;
      case 'conflict':
        toast(`⚠️ <b>Not pushed:</b> ${esc(status.message)} — open ColabHub to resolve.`, 'warn', 8000);
        break;
      case 'secrets':
        toast(`🔒 <b>Not pushed:</b> ${esc(status.message)}. Open ColabHub to review.`, 'warn', 8000);
        break;
      case 'error':
        toast(`❌ <b>Push failed:</b> ${esc(status.message)}`, 'error', 8000);
        break;
      default:
        break;
    }
  }

  let pollTimer = null;
  function poll() {
    send({ type: 'getStatus' }, (res) => {
      if (res?.ok && res.result?.connected) showStatus(res.result.status, { commitUrl: res.result.lastCommitUrl });
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(pollTimer);
      pollTimer = null;
    } else if (!pollTimer) {
      pollTimer = setInterval(poll, 5000);
    }
  });
  if (!document.hidden) pollTimer = setInterval(poll, 5000);
  // Don't replay the last status as a toast on page load — only new events.
  send({ type: 'getStatus' }, (res) => {
    if (res?.ok && res.result?.status?.at) lastShownAt = res.result.status.at;
  });
})();
