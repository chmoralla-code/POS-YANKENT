'use strict';
/* YANKENT POS app shell — login, navigation, routing. */
window.App = window.App || {};

App.current = { user: null, view: 'pos' };
App.DEV_FACEBOOK = 'https://www.facebook.com/profile.php?id=61584774638218';

App._delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

App._initStartup = async function () {
  const splash = document.getElementById('startup');
  const status = document.getElementById('startupStatus');
  const fill = document.querySelector('.startup-bar-fill');
  const startupVer = document.getElementById('startupVersion');
  if (!splash) return;

  const reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const minShow = reducedMotion ? 200 : 850;
  const started = Date.now();

  const setStep = (pct, msg) => {
    if (typeof window.__startupSetStep === 'function') window.__startupSetStep(pct, msg);
    else {
      if (status) status.textContent = msg;
      if (fill) fill.style.width = pct + '%';
    }
  };

  if (window.__startupProgress) clearInterval(window.__startupProgress);

  try {
    setStep(12, 'Starting YANKENT POS…');
    await App._delay(reducedMotion ? 0 : 120);

    setStep(40, 'Connecting to database…');
    if (window.pos && App.pos.waitForReady) {
      await Promise.race([
        App.pos.waitForReady(),
        new Promise((resolve) => setTimeout(resolve, 15000)),
      ]);
    }
    if (window.pos && App.pos.update) {
      const ver = await App.pos.update.getVersion();
      const label = ver ? 'v' + ver : '';
      if (startupVer) startupVer.textContent = label;
      const loginVer = document.getElementById('loginVersion');
      if (loginVer && ver) loginVer.textContent = 'v' + ver;
    }

    setStep(72, 'Loading interface…');
    const bg = document.querySelector('.login-bg');
    if (bg && bg.tagName === 'IMG') {
      await Promise.race([
        new Promise((resolve) => {
          if (bg.complete) resolve();
          else bg.addEventListener('load', resolve, { once: true });
        }),
        App._delay(reducedMotion ? 0 : 700),
      ]);
    }

    setStep(100, 'Ready');
  } catch {
    setStep(100, 'Ready');
  }

  const elapsed = Date.now() - started;
  if (elapsed < minShow) await App._delay(minShow - elapsed);

  splash.classList.add('leaving');
  splash.setAttribute('aria-busy', 'false');
  document.body.classList.remove('is-startup');
  const login = document.getElementById('login');
  if (login) login.style.visibility = 'visible';
  await App._delay(reducedMotion ? 80 : 420);
  splash.remove();
};

document.addEventListener('DOMContentLoaded', async () => {
  await App._initStartup();

  const loginForm = document.getElementById('loginForm');
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('loginError');
    err.textContent = '';
    const u = document.getElementById('loginUser').value.trim();
    const p = document.getElementById('loginPass').value;
    const btn = document.getElementById('loginBtn');
    btn.classList.add('is-loading'); btn.disabled = true;
    btn.textContent = '';
    try {
      const data = await App.pos.login(u, p);
      App.current.user = data.user;
      btn.classList.remove('is-loading');
      btn.classList.add('is-success');
      btn.textContent = '✓ Welcome';
      await App._showLoginSuccess(data.user);
      await App._start();
    } catch (e2) {
      btn.classList.remove('is-loading', 'is-success');
      btn.disabled = false; btn.textContent = 'Sign In';
      err.textContent = e2.message;
      const panel = document.querySelector('.login-panel');
      panel.classList.remove('shake-err');
      void panel.offsetWidth;
      panel.classList.add('shake-err');
    }
  });

  document.getElementById('forgotPw').onclick = (e) => { e.preventDefault(); App._forgotPassword(); };

  const devCredit = document.getElementById('devCredit');
  if (devCredit) {
    devCredit.onclick = (e) => {
      e.preventDefault();
      App.pos.openExternal(App.DEV_FACEBOOK).catch((err) => App.ui.toast(err.message, 'err'));
    };
  }

  const pwToggle = document.getElementById('loginPwToggle');
  const pwInput = document.getElementById('loginPass');
  if (pwToggle && pwInput) {
    pwToggle.onclick = () => {
      const show = pwInput.type === 'password';
      pwInput.type = show ? 'text' : 'password';
      pwToggle.textContent = show ? '🙈' : '👁';
      pwToggle.title = show ? 'Hide password' : 'Show password';
      pwToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    };
  }

  App._renderPrinterHealth = function (info) {
    const health = info || {};
    const state = health.status || (health.printerConnected ? 'ready' : 'offline');
    const barState = document.getElementById('printerStatusBarState');
    const appButton = document.getElementById('printerRecoveryBtn');
    const appLabel = document.getElementById('printerRecoveryBtnState');
    let dot = 'off';
    let barText = 'Printer not connected';
    let buttonText = 'Printer offline';

    if (state === 'ready') {
      dot = 'on';
      barText = 'Printer ready';
      buttonText = 'Printer ready';
    } else if (state === 'repair-available') {
      barText = 'Replacement found · click to fix';
      buttonText = 'Fix printer';
    } else if (state === 'needs-selection') {
      barText = 'Choose a printer';
      buttonText = 'Choose printer';
    } else if (state === 'disabled') {
      barText = 'Printing disabled';
      buttonText = 'Printing disabled';
    } else if (state === 'bluetooth-configured') {
      const bluetoothReady = App.printer && App.printer.isConnected();
      if (bluetoothReady) dot = 'on';
      barText = bluetoothReady ? 'Bluetooth printer ready' : 'Bluetooth printer configured';
      buttonText = bluetoothReady ? 'Printer ready' : 'Bluetooth configured';
    } else if (health.driverAvailable === false) {
      barText = 'Driver not installed';
    }

    if (barState) barState.innerHTML = '<span class="dot ' + dot + '"></span> ' + App.ui.esc(barText);
    if (appButton) {
      appButton.classList.remove('is-ready', 'needs-attention', 'is-checking');
      appButton.classList.add(dot === 'on' ? 'is-ready' : 'needs-attention');
      appButton.setAttribute('aria-label', buttonText + '. Open Printer Recovery');
      appButton.title = buttonText + ' — open Printer Recovery';
    }
    if (appLabel) appLabel.textContent = buttonText;
    App._printerHealth = health;
  };

  // ---- Bottom-left printer status indicator (visible on all pages) -----
  App._checkLoginPrinterStatus = async function () {
    // If the startup test print is in flight, don't overwrite the
    // "Testing print..." status — let it show until the test resolves.
    if (App._printerTesting) return;
    const requestId = App._printerCheckSeq = (App._printerCheckSeq || 0) + 1;
    try {
      const info = await App.pos.printer.checkStatus();
      if (requestId === App._printerCheckSeq) App._renderPrinterHealth(info);
    } catch {
      if (requestId === App._printerCheckSeq) App._renderPrinterHealth({ status: 'offline', ready: false });
    }
  };
  App._checkLoginPrinterStatus();
  App._showPrinterRecovery = async function () {
    if (document.getElementById('printerRecoveryDialog')) return;
    const returnFocus = document.activeElement;
    const m = App.ui.modal({
      title: 'Printer Recovery',
      bodyHtml: '<div class="printer-recovery-loading"><span class="dot checking"></span> Checking Windows printers…</div>',
      closeOnOverlay: false,
    });
    let loadSequence = 0;
    const backgroundStates = ['app', 'login', 'printerStatusBar']
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((element) => ({ element, inert: element.inert }));
    backgroundStates.forEach(({ element }) => { element.inert = true; });
    const dialog = m.el.querySelector('.modal');
    const title = m.el.querySelector('.modal-h > span:first-child');
    dialog.id = 'printerRecoveryDialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'printerRecoveryTitle');
    dialog.setAttribute('tabindex', '-1');
    if (title) title.id = 'printerRecoveryTitle';

    const handleDialogKey = (event) => {
      const topModal = document.querySelector('#modal-root > .modal-overlay:last-child');
      if (topModal !== m.el) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        m.close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...m.el.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleDialogKey);
    m.onClose = () => {
      loadSequence += 1;
      document.removeEventListener('keydown', handleDialogKey);
      backgroundStates.forEach(({ element, inert }) => { element.inert = inert; });
      if (returnFocus && typeof returnFocus.focus === 'function') setTimeout(() => returnFocus.focus(), 0);
    };

    const queueText = (printer) => {
      if (!printer) return 'None detected';
      return printer.name + (printer.port ? ' · ' + printer.port : '');
    };

    const render = (health) => {
      const status = health.status || 'offline';
      const selected = health.selected || null;
      const choices = Array.isArray(health.connectedThermalPrinters) ? health.connectedThermalPrinters : [];
      const saved = health.configured || 'Not configured';
      const savedState = health.configuredPrinter && health.configuredPrinter.connected === false ? ' · disconnected' : '';
      let headline = 'Printer needs attention';
      let summary = health.message || health.error || 'No connected thermal printer was found.';
      let tone = 'needs-attention';

      if (status === 'ready') {
        headline = 'Printer is ready';
        summary = health.repaired ? health.message : 'Receipts will print to the connected queue below.';
        tone = 'is-ready';
      } else if (status === 'repair-available') {
        headline = 'Replacement printer found';
        summary = 'Windows kept the old queue, but YANKENT found one safe connected replacement.';
      } else if (status === 'needs-selection') {
        headline = 'Choose which printer to use';
        summary = 'More than one thermal printer is connected, so YANKENT will not guess.';
      } else if (status === 'disabled') {
        headline = 'Printing is disabled';
        summary = 'An administrator disabled receipt printing in Settings. Recovery will not turn it back on.';
      } else if (status === 'bluetooth-configured') {
        headline = App.printer && App.printer.isConnected() ? 'Bluetooth printer is ready' : 'Bluetooth printer is configured';
        summary = health.message || 'Use Printer Settings before switching this register to a Windows printer.';
        if (App.printer && App.printer.isConnected()) tone = 'is-ready';
      }

      const choicesHtml = choices.length && !selected
        ? '<div class="printer-recovery-candidates"><div class="printer-recovery-k">Connected thermal printers</div><ul>' +
          choices.map((printer) => '<li>' + App.ui.esc(queueText(printer)) + '</li>').join('') +
          '</ul></div>'
        : '';
      const activeLabel = selected
        ? (status === 'repair-available' ? 'Safe replacement' : (status === 'ready' ? 'Active printer' : 'Detected Windows printer'))
        : 'Connected printer';
      const canOpenSettings = App.current.user && App.current.user.role === 'admin';

      m.body.innerHTML =
        '<div id="printerRecovery" class="printer-recovery">' +
          '<section class="printer-recovery-summary ' + tone + '" role="status" aria-live="polite">' +
            '<span class="printer-recovery-summary-icon" aria-hidden="true">🖨</span>' +
            '<div><h3>' + App.ui.esc(headline) + '</h3><p>' + App.ui.esc(summary) + '</p></div>' +
          '</section>' +
          '<div class="printer-recovery-route">' +
            '<div class="printer-recovery-row"><span class="printer-recovery-k">Saved printer</span><span class="printer-recovery-v">' + App.ui.esc(saved + savedState) + '</span></div>' +
            '<div class="printer-recovery-arrow" aria-hidden="true">↓</div>' +
            '<div class="printer-recovery-row"><span class="printer-recovery-k">' + App.ui.esc(activeLabel) + '</span><span class="printer-recovery-v">' + App.ui.esc(queueText(selected)) + '</span></div>' +
          '</div>' +
          choicesHtml +
          '<div id="printerRecoveryFeedback" class="printer-recovery-feedback" aria-live="polite"></div>' +
          '<div class="printer-recovery-actions">' +
            (health.canAutoRecover ? '<button type="button" class="btn btn-primary" id="printerRecoveryRepair">Use Connected Printer</button>' : '') +
            (health.ready && App.current.user ? '<button type="button" class="btn btn-primary" id="printerRecoveryTest">Run Test Print</button>' : '') +
            '<button type="button" class="btn btn-ghost" id="printerRecoveryRefresh">Refresh</button>' +
            (canOpenSettings ? '<button type="button" class="btn btn-ghost" id="printerRecoverySettings">Printer Settings</button>' : '') +
          '</div>' +
          (!canOpenSettings && status !== 'ready' && status !== 'repair-available'
            ? '<p class="printer-recovery-guidance">Ask an administrator to select the correct queue in Settings.</p>'
            : '') +
          '<p class="printer-recovery-note">Recovery changes only where new receipts are sent. It never clears old queued print jobs and never prints a test automatically.</p>' +
        '</div>';

      const refreshButton = m.el.querySelector('#printerRecoveryRefresh');
      if (refreshButton) refreshButton.onclick = () => load();

      const repairButton = m.el.querySelector('#printerRecoveryRepair');
      if (repairButton) {
        repairButton.onclick = async () => {
          repairButton.disabled = true;
          repairButton.setAttribute('aria-busy', 'true');
          repairButton.textContent = 'Repairing…';
          try {
            const result = await App.pos.printer.autoRecover();
            loadSequence += 1;
            App._printerCheckSeq = (App._printerCheckSeq || 0) + 1;
            if (result.repaired && App.current.user) {
              try {
                const persisted = await App.pos.settings.getAll();
                App.settingsCache = persisted;
                if (App.views && App.views.settings) App.views.settings.s = persisted;
                const typeField = document.getElementById('s_printer_type');
                const printerField = document.getElementById('sStartupPrinter');
                const routeField = document.getElementById('sPrinterRoute');
                if (typeField) typeField.value = persisted.printer_type || 'system';
                if (printerField) printerField.value = persisted.startup_test_printer || '';
                if (routeField && result.selected) routeField.textContent = 'Ready: ' + queueText(result.selected);
              } catch {
                // The main process already saved the repair; settings reload can retry later.
              }
            }
            App._renderPrinterHealth(result);
            render(result);
            App.ui.toast(result.repaired ? 'Printer route repaired ✓' : (result.message || 'Printer route unchanged'), result.repaired ? 'ok' : 'err');
          } catch (error) {
            const feedback = m.el.querySelector('#printerRecoveryFeedback');
            if (feedback) feedback.textContent = 'Recovery failed: ' + error.message;
            repairButton.disabled = false;
            repairButton.removeAttribute('aria-busy');
            repairButton.textContent = 'Try Recovery Again';
          }
        };
      }

      const testButton = m.el.querySelector('#printerRecoveryTest');
      if (testButton) {
        testButton.onclick = async () => {
          testButton.disabled = true;
          testButton.setAttribute('aria-busy', 'true');
          testButton.textContent = 'Sending test…';
          const feedback = m.el.querySelector('#printerRecoveryFeedback');
          try {
            const result = await App.pos.printer.startupTest();
            if (feedback) feedback.textContent = 'Test print sent to ' + result.printer + '.';
            App.ui.toast('Test print sent to "' + result.printer + '" ✓', 'ok');
          } catch (error) {
            if (feedback) feedback.textContent = 'Test print failed: ' + error.message;
          } finally {
            testButton.disabled = false;
            testButton.removeAttribute('aria-busy');
            testButton.textContent = 'Run Test Print';
          }
        };
      }

      const settingsButton = m.el.querySelector('#printerRecoverySettings');
      if (settingsButton) settingsButton.onclick = () => { m.close(); App._navigate('settings'); };

      const primary = m.el.querySelector('#printerRecoveryRepair, #printerRecoveryTest, #printerRecoveryRefresh');
      if (primary) setTimeout(() => primary.focus(), 0);
    };

    const load = async () => {
      const requestId = ++loadSequence;
      m.body.innerHTML = '<div class="printer-recovery-loading"><span class="dot checking"></span> Checking Windows printers…</div>';
      try {
        const health = await App.pos.printer.windowsStatus();
        if (requestId !== loadSequence || !m.el.isConnected) return;
        App._renderPrinterHealth(health);
        render(health);
      } catch (error) {
        if (requestId !== loadSequence || !m.el.isConnected) return;
        render({ status: 'offline', ready: false, message: 'Printer discovery failed: ' + error.message, connectedThermalPrinters: [] });
      }
    };

    dialog.focus();
    await load();
  };

  ['printerStatusBar', 'printerRecoveryBtn'].forEach((id) => {
    const trigger = document.getElementById(id);
    if (trigger) trigger.addEventListener('click', () => App._showPrinterRecovery());
  });


  // ---- Startup test-print status (login printer status bar) --------------
  // While the main process runs the startup auto test-print to the POS-58,
  // the bottom-left printer status bar shows "Testing print..." with an
  // animated effect instead of the usual "Printer connected" text.  When
  // the test finishes (or is skipped/failed), the bar reverts to the normal
  // status via _checkLoginPrinterStatus().
  App._setPrinterTestStatus = function (data) {
    const statusEl = document.getElementById('printerStatusBarState');
    const appButton = document.getElementById('printerRecoveryBtn');
    const appLabel = document.getElementById('printerRecoveryBtnState');
    if (!statusEl) return;
    const state = data && data.state;
    if (state === 'testing') {
      App._printerTesting = true;
      statusEl.innerHTML = '<span class="dot checking"></span><span class="testing-txt">Testing print<span class="chk-ellipsis"></span></span>';
      if (appButton) {
        appButton.classList.remove('is-ready', 'needs-attention');
        appButton.classList.add('is-checking');
      }
      if (appLabel) appLabel.textContent = 'Testing printer…';
    } else {
      App._printerTesting = false;
      // Briefly show the result, then revert to the normal status check.
      if (state === 'done') {
        statusEl.innerHTML = '<span class="dot on"></span> Printer connected';
      } else if (state === 'skipped' || state === 'error') {
        statusEl.innerHTML = '<span class="dot off"></span> Printer not connected';
      }
      // After a moment, run the full status check for an accurate reading.
      if (appButton) {
        appButton.classList.remove('is-checking');
        appButton.classList.add(state === 'done' ? 'is-ready' : 'needs-attention');
      }
      if (appLabel) appLabel.textContent = state === 'done' ? 'Printer ready' : 'Printer offline';
      setTimeout(() => App._checkLoginPrinterStatus(), 800);
    }
  };
  // Listen for live status updates from the main process.
  if (window.pos && window.pos.onPrinterTestStatus) {
    window.pos.onPrinterTestStatus((data) => App._setPrinterTestStatus(data));
  }
  // Also query the current state in case the renderer loaded after the
  // event was already sent (the test print fires ~5s after boot).
  if (window.pos && window.pos.getPrinterTestStatus) {
    window.pos.getPrinterTestStatus().then((d) => {
      if (d && d.state === 'testing') App._setPrinterTestStatus(d);
    });
  }

  const setupBtn = document.getElementById('loginSetupPrinter');
  if (setupBtn) {
    setupBtn.onclick = async () => {
      const ok = await App.ui.confirm('Install the thermal printer driver now? Windows will ask for admin permission (UAC). Click Yes when prompted.', { title: 'Printer setup' });
      if (!ok) return;
      setupBtn.disabled = true; setupBtn.textContent = 'Launching…';
      try {
        const r = await App.pos.printer.setupFromLogin();
        if (r && r.launched) {
          App.ui.toast('Driver installer launched — follow the Windows prompts ✓', 'ok');
          setTimeout(() => App._checkLoginPrinterStatus(), 5000);
        } else {
          App.ui.toast('Could not launch installer', 'err');
        }
      } catch (e) {
        App.ui.toast('Setup failed: ' + e.message, 'err');
      } finally {
        setupBtn.disabled = false; setupBtn.textContent = 'Setup Printer';
      }
    };
  }

  document.getElementById('logoutBtn').onclick = async () => {
    // Re-entrancy guard: the idle timeout can fire logoutBtn.click() while
    // a send-report confirm/send is already in flight, which would re-enter
    // this handler, open a second nested confirm modal, and double-send.
    if (App._loggingOut) return;
    App._loggingOut = true;
    const btn = document.getElementById('logoutBtn');
    const orig = btn ? btn.textContent : '';
    // Ask the cashier whether to send the sales report + backup to the
    // owner via Telegram before ending the session.  "No" skips sending
    // and proceeds straight to logout — no data is lost either way.
    try {
      const send = await App.ui.confirm(
        'Send the sales report + backup to the owner via Telegram before signing out?',
        { title: 'Send Telegram report?', okText: 'Yes, send', cancelText: 'No, just sign out' }
      );
      if (send) {
        if (btn) { btn.disabled = true; btn.textContent = 'Sending report…'; }
        try {
          const r = await App.pos.telegram.sendReport();
          if (r && r.ok) App.ui.toast(r.warning ? ('Report sent, backup failed' + (r.warning ? ': ' + r.warning : '')) : 'Report + backup sent to owner ✓', r.warning ? 'err' : 'ok');
          else if (r && r.error) App.ui.toast(r.error, 'err');
        } catch (e) {
          // Offline or not configured — silently skip (no data lost)
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = orig; }
        }
      }
    } catch (e) {
      // confirm() dismissed — proceed to logout without sending
    }
    await App.pos.logout();
    App.current.user = null;
    App._loggingOut = false;
    App._batteryLowSent = false; // reset low-battery flag so a new session can alert again
    document.getElementById('app').classList.add('hidden');
    document.getElementById('login').classList.remove('hidden');
    const printerBar = document.getElementById('printerStatusBar');
    if (printerBar) printerBar.classList.remove('hidden');
    document.getElementById('loginPass').value = '';
    const lb = document.getElementById('loginBtn');
    if (lb) { lb.classList.remove('is-loading', 'is-success'); lb.disabled = false; lb.textContent = 'Sign In'; }
    const le = document.getElementById('loginError');
    if (le) le.textContent = '';
    document.getElementById('loginUser').focus();
    App._checkLoginPrinterStatus();
  };

  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => App._navigate(btn.dataset.view));
  });

  // "Send Report" button — available to all roles (cashier + admin).
  document.getElementById('sendReportBtn').addEventListener('click', async () => {
    const btn = document.getElementById('sendReportBtn');
    const label = btn.querySelector('.nav-label');
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    if (label) label.textContent = 'Sending…';
    try {
      const r = await App.pos.telegram.sendReport();
      if (r.ok) App.ui.toast(r.warning ? ('Report sent, backup failed: ' + r.warning) : 'Report + backup sent to owner ✓', r.warning ? 'err' : 'ok');
      else App.ui.toast(r.error || 'Failed to send', 'err');
    } catch (e) { App.ui.toast(e.message, 'err'); }
    btn.disabled = false; btn.setAttribute('aria-busy', 'false');
    if (label) label.textContent = 'Send report';
  });

  // Theme toggle (dark / light). Persists in localStorage; respects system
  // preference on first visit. Applies immediately so the login screen honors it.
  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) themeBtn.addEventListener('click', App._toggleTheme);
  App._applyStoredTheme();

  App._clock();
  // Self-adjusting clock: aligns the next tick to the wall-clock second
  // boundary so the clock doesn't drift visibly, and skips ticks when the
  // window is hidden (no repaint needed while minimized). This keeps the
  // 1Hz Intl.toLocaleTimeString call off the main thread when idle.
  const clockTick = () => {
    if (!document.hidden) App._clock();
    App._clockTimer = setTimeout(clockTick, 1000 - (Date.now() % 1000));
  };
  App._clockTimer = setTimeout(clockTick, 1000 - (Date.now() % 1000));
  App._net();
  App._intervals = {
    net: setInterval(() => App._net(), 15000),
    loginNet: setInterval(() => App._loginNet(), 15000),
  };
  App._loginNet();
  App._loginVersion();

  // When the window is hidden (minimized / alt-tabbed), pause all the
  // background pollers so an unattended register doesn't burn CPU/GPU
  // re-rendering an invisible UI. They resume on visibilitychange.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (App._clockTimer) { clearTimeout(App._clockTimer); App._clockTimer = null; }
    } else if (!App._clockTimer) {
      App._clock();
      App._clockTimer = setTimeout(clockTick, 1000 - (Date.now() % 1000));
    }
    if (!document.hidden) App._checkLoginPrinterStatus();
  });

  // ---- Power resume / wake — reconnect the printer proactively ----------
  // After a laptop sleep, hibernate, or power-off → power-on cycle, the
  // Bluetooth GATT characteristic held in App.printer is stale: writes
  // throw even though the printer is physically on.  The main process
  // sends a 'pos:power:resume' event (from Electron's powerMonitor) a
  // few seconds after wake — long enough for the BLE/USB adapter to
  // re-enumerate.  Here we drop the dead handle and kick off a
  // background reconnect so the NEXT sale prints without the cashier
  // having to re-pair or see a "Printer not connected" toast mid-sale.
  if (window.pos && window.pos.onPowerResume) {
    window.pos.onPowerResume((_reason) => { App._handlePowerResume(); });
  }
});

/** Reconnect the thermal printer after a wake/power-cycle.
 *  Runs in the background (no modal) so it doesn't interrupt the cashier.
 *  Shows a toast only if reconnection fails, nudging them to re-pair. */
App._handlePowerResume = async function () {
  // Drop any stale handle first — a dead GATT characteristic will keep
  // reporting isConnected()=true but throw on every write.
  App.printer._characteristic = null;
  const s = App.settingsCache || {};
  if (!s.printer_device_name) {
    await App._checkLoginPrinterStatus();
    return; // system printer has no GATT state to reconnect
  }
  const ok = await App.printer.reconnectWithRetry();
  if (ok) {
    App.ui.toast('Printer reconnected after wake ✓', 'ok');
  } else if (s.printer_type !== 'system') {
    // Only warn when there's no system-printer fallback to save the next sale.
    App.ui.toast('Printer lost after wake — re-pair in Settings, or set Printer type to System printer', 'err');
  }
  await App._checkLoginPrinterStatus();
};

App._start = async function () {
  // Load settings (currency symbol, printer config, etc.)
  try {
    const s = await App.pos.settings.getAll();
    App.settingsCache = s;
    App.currencySymbol = s.currency_symbol || '₱';
  } catch { App.settingsCache = {}; }

  // ---- Proactive printer reconnect on login -----------------------------
  // On a fresh boot (laptop was powered off then on), the POS auto-starts
  // and the cashier logs in — but the Bluetooth GATT link from the previous
  // session is gone.  Kick off a background reconnect here (with retries)
  // so the first sale of the day prints without a "not connected" error.
  // No modal — just a toast if it can't reconnect and there's no fallback.
  if (App.settingsCache && App.settingsCache.printer_device_name) {
    App.printer.reconnectWithRetry().then((ok) => {
      if (ok) App.ui.toast('Printer connected ✓', 'ok');
      else if (App.settingsCache.printer_type !== 'system') {
        App.ui.toast('Printer not connected — pair in Settings or set Printer type to System printer', 'err');
      }
    }).catch(() => {});
  }

  const u = App.current.user;
  document.getElementById('navUser').textContent = u.full_name;
  document.getElementById('navRole').textContent = u.role === 'admin' ? 'Administrator' : 'Cashier';
  const isAdmin = u.role === 'admin';
  document.querySelectorAll('.admin-only').forEach((n) => n.classList.toggle('hidden', !isAdmin));

  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  const printerBar = document.getElementById('printerStatusBar');
  if (printerBar) printerBar.classList.add('hidden');
  App._checkLoginPrinterStatus();
  App._navigate(isAdmin ? 'pos' : 'pos');

  // ---- Idle timeout --------------------------------------------------
  // Every 30s the renderer sends a heartbeat to the main process.  If the
  // main process reports the session is dead (exceeded the idle timeout
  // configured in Settings), the app auto-logs out so an unattended POS
  // can't be used by someone else.
  if (!App._idleChecker) {
    // Reset the idle timer on any user activity. mousemove is throttled to
    // at most one write per 2s (the value is only read every 30s anyway),
    // so a busy mouse no longer fires a JS callback hundreds of times/sec.
    let lastActivityWrite = 0;
    const resetActivity = () => {
      const now = Date.now();
      if (now - lastActivityWrite > 2000) { lastActivityWrite = now; App._lastActivity = now; }
    };
    ['mousemove', 'keydown', 'click', 'touchstart', 'wheel'].forEach((ev) =>
      document.addEventListener(ev, resetActivity, { passive: true })
    );
    App._lastActivity = Date.now();

    App._idleChecker = setInterval(async () => {
      // Only check when the app is visible (not on the login screen).
      const appEl = document.getElementById('app');
      if (!appEl || appEl.classList.contains('hidden')) return;
      if (document.hidden) return; // tab/window minimized — don't burn CPU on heartbeat
      try {
        const res = await App.pos.heartbeat();
        if (res && res.alive === false) {
          App.ui.toast('Session expired due to inactivity', 'err');
          document.getElementById('logoutBtn').click();
        }
      } catch {}
    }, 30000); // check every 30 seconds
  }

  // ---- Low-battery auto-send ------------------------------------------
  // When the laptop battery drops to 20% or below AND it's not charging,
  // automatically send the sales report + backup to the owner via Telegram
  // so no data is lost if the laptop dies. Only fires once per low-battery
  // episode (resets when the battery is charged above 25% or plugged in).
  if (!App._batteryMonitor && navigator.getBattery) {
    App._batteryLowSent = false;
    navigator.getBattery().then((battery) => {
      const check = async () => {
        // Only act while logged in.
        const appEl = document.getElementById('app');
        if (!appEl || appEl.classList.contains('hidden')) return;
        const low = battery.level <= 0.20 && !battery.charging;
        if (low && !App._batteryLowSent) {
          App.ui.toast('Low battery — sending report to owner…', 'err');
          try {
            const r = await App.pos.telegram.sendReport();
            if (r && r.ok) {
              // Only latch the flag after a successful send so a failed
              // attempt (e.g. session expired mid-send, offline) can retry
              // on the next poll instead of being lost forever.
              App._batteryLowSent = true;
              App.ui.toast('Report + backup sent (low battery) ✓', 'ok');
            }
          } catch {} // offline or not configured — skip silently (will retry)
        } else if (!low && App._batteryLowSent) {
          // Reset the flag once the battery recovers so it can fire again later.
          App._batteryLowSent = false;
        }
      };
      battery.addEventListener('levelchange', check);
      battery.addEventListener('chargingchange', check);
      // Also poll every 60s as a safety net (the events can be unreliable).
      App._batteryMonitor = setInterval(check, 60000);
    }).catch(() => {}); // some machines don't expose the Battery API
  }
};

App._navigate = async function (name) {
  if (!App.views[name]) return;
  // Role guard: cashiers cannot open admin views.
  const adminOnlyViews = new Set(['products', 'users', 'reports', 'settings']);
  if (adminOnlyViews.has(name) && App.current.user.role !== 'admin') {
    App.ui.toast('Administrator access required', 'err'); return;
  }
  // Tear down the current view (disconnect observers, etc.) before swapping.
  if (App.current.view && App.views[App.current.view] && typeof App.views[App.current.view].destroy === 'function') {
    try { App.views[App.current.view].destroy(); } catch (e) { /* ignore teardown errors */ }
  }
  App.current.view = name;
  document.querySelectorAll('.nav-item[data-view]').forEach((b) => {
    const active = b.dataset.view === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const view = document.getElementById('view');
  view.classList.remove('view-pos');
  document.getElementById('viewTitle').textContent = App.views[name].title;
  view.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading…</div>';
  try { await App.views[name].render(view); }
  catch (e) {
    if (e.code === 'SESSION_EXPIRED') {
      App.ui.toast('Session expired — please log in again', 'err');
      document.getElementById('logoutBtn').click();
      return;
    }
    view.innerHTML = `<div class="empty-state">Error: ${App.ui.esc(e.message)}</div>`;
  }
};

// Persistent clock nodes — rebuilt once, updated via textContent so the
// per-second tick never forces a full innerHTML teardown/re-layout (the
// Intl formatting is still done, but DOM mutation is minimal and avoids
// triggering style/layout on sibling nodes).
App._clockNodes = null;
App._clock = function () {
  const el = document.getElementById('clock');
  if (!el) return;
  const now = new Date();
  const time = now.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Manila' });
  if (!App._clockNodes) {
    // Build the structure once.
    const t = document.createElement('span'); t.className = 'clk-time';
    const d = document.createElement('span'); d.className = 'clk-date';
    el.textContent = '';
    el.appendChild(t); el.appendChild(document.createTextNode(' ')); el.appendChild(d);
    App._clockNodes = { t, d };
    App._clockDate = '';
  }
  // Only mutate the time node every tick.
  if (App._clockNodes.t.textContent !== time) App._clockNodes.t.textContent = time;
  // Date changes at most once per day — avoid touching the DOM otherwise.
  const date = now.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric', timeZone: 'Asia/Manila' });
  if (App._clockDate !== date) { App._clockDate = date; App._clockNodes.d.textContent = date; }
};

App._net = async function () {
  const el = document.getElementById('netStatus');
  if (!el) return;
  if (document.hidden) return; // window minimized — no repaint needed
  // Skip the IPC round-trip when the app shell (topbar) is hidden on the
  // login screen — the pill isn't visible, so no need to ping Telegram.
  const appEl = document.getElementById('app');
  if (appEl && appEl.classList.contains('hidden')) return;
  let online = false;
  try { online = await App.pos.telegram.isOnline(); } catch {}
  el.textContent = online ? '● Online' : '● Offline-ready';
};

// ---- Theme (dark / light) ---------------------------------------------
App._applyTheme = function (theme) {
  const isDark = theme === 'dark';
  document.documentElement.classList.toggle('theme-dark', isDark);
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.textContent = isDark ? '☀' : '☾';
    btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  }
};

App._toggleTheme = function () {
  const next = document.documentElement.classList.contains('theme-dark') ? 'light' : 'dark';
  localStorage.setItem('yankent-theme', next);
  App._applyTheme(next);
};

App._applyStoredTheme = function () {
  let theme = localStorage.getItem('yankent-theme');
  if (!theme) {
    const prefersDark = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
    theme = prefersDark ? 'dark' : 'light';
  }
  App._applyTheme(theme);
};

App._loginNet = async function () {
  const el = document.getElementById('loginStatus');
  if (!el) return;
  if (document.hidden) return; // window minimized — skip the IPC ping
  // Skip when the login screen is hidden (user is already in the app) —
  // the animated "checking" state isn't visible and we avoid the IPC ping.
  const loginEl = document.getElementById('login');
  if (loginEl && loginEl.classList.contains('hidden')) return;
  const checking = '<span class="dot checking"></span><span class="chk-txt">Checking connection<span class="chk-ellipsis"></span></span>';
  // Show the animated "checking" state while the reachability ping is in flight.
  el.innerHTML = checking;
  // Instant first pass using the browser's network state.
  if (!navigator.onLine) {
    el.innerHTML = '<span class="dot off"></span><span class="off-txt">Offline — POS still works</span>';
    return;
  }
  // Confirm with a real reachability ping (keep the animated state until it resolves).
  el.innerHTML = checking;
  try {
    const online = await App.pos.telegram.isOnline();
    if (online) {
      el.innerHTML = '<span class="dot on"></span><span class="on-txt">Online</span>';
    } else {
      el.innerHTML = '<span class="dot off"></span><span class="off-txt">Offline — POS still works</span>';
    }
  } catch {
    el.innerHTML = '<span class="dot off"></span><span class="off-txt">Offline — POS still works</span>';
  }
};

App._loginVersion = async function () {
  try {
    const ver = await App.pos.update.getVersion();
    document.getElementById('loginVersion').textContent = 'v' + ver;
  } catch {}
  const updateLink = document.getElementById('loginCheckUpdates');
  updateLink.onclick = (e) => {
    e.preventDefault();
    App._checkUpdates();
  };

  // One app-lifetime listener is enough. Automatic background checks use it
  // to make an available update visible without interrupting the cashier.
  if (!App._updateAvailableSubscription) {
    App._updateAvailableSubscription = App.pos.update.onUpdateAvailable((info) => {
      const version = info && info.version ? String(info.version) : '';
      updateLink.textContent = version ? `Update v${version} available` : 'Update available';
      App.ui.toast(version ? `YANKENT POS v${version} is available` : 'A YANKENT POS update is available', 'ok');
    });
  }
};

App._checkUpdates = function () {
  if (App._updateCheckPromise) return App._updateCheckPromise;

  const el = document.getElementById('loginCheckUpdates');
  const orig = el.textContent;
  el.setAttribute('aria-disabled', 'true');
  el.textContent = 'Checking…';
  App._updateCheckPromise = (async () => {
    try {
    const r = await App.pos.update.check();
    if (r.devMode) {
      App.ui.toast('Dev mode — publish a GitHub Release to test updates', 'ok');
    } else if (r.available && App._isNewer(r.version, r.currentVersion)) {
      const ok = await App._showWhatsNew(r);
      if (!ok) return false;
      return App._showDownloadProgress(r);
    } else {
      App._showUpToDate(r.currentVersion);
    }
    return true;
    } catch (e) {
      App.ui.toast(e.message, 'err');
      return false;
    }
  })().finally(() => {
    el.textContent = orig;
    el.removeAttribute('aria-disabled');
    App._updateCheckPromise = null;
  });

  return App._updateCheckPromise;
};

// ---- "What's New" modal ------------------------------------------------
App._isNewer = function (a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return true;
    if (da < db) return false;
  }
  return false; // equal
};

App._parseReleaseNotes = function (notes) {
  return window.YankentReleaseNotes.parse(notes);
};

App._showWhatsNew = function (r) {
  return new Promise((resolve) => {
    const returnFocus = document.activeElement;
    const groups = App._parseReleaseNotes(r.releaseNotes);
    const totalItems = groups.reduce((total, group) => total + group.items.length, 0);
    const from = r.currentVersion || '—', to = r.version || '—';
    const totalLabel = `${totalItems} ${totalItems === 1 ? 'highlight' : 'highlights'}`;
    const body = `
      <div class="wn-release">
        <section class="wn-hero">
          <div class="wn-eyebrow"><span class="wn-ready-dot" aria-hidden="true"></span>Update ready</div>
          <div class="wn-hero-grid">
            <div class="wn-hero-copy">
              <div class="wn-title">A better YANKENT POS is ready.</div>
              <div class="wn-caption">Review the changes, then download the update when it suits your counter.</div>
            </div>
            <div class="wn-version-flow" aria-label="Update from version ${App.ui.esc(from)} to version ${App.ui.esc(to)}">
              <div class="wn-version-card">
                <span class="wn-version-label">Installed</span>
                <strong class="wn-from">v${App.ui.esc(from)}</strong>
              </div>
              <span class="wn-arrow" aria-hidden="true">→</span>
              <div class="wn-version-card wn-version-card-new">
                <span class="wn-version-label">Available</span>
                <strong class="wn-to">v${App.ui.esc(to)}</strong>
              </div>
            </div>
          </div>
        </section>
        <section class="wn-changes" aria-labelledby="wnChangesHeading">
          <div class="wn-section-head">
            <div>
              <span class="wn-section-kicker">Release notes</span>
              <h3 id="wnChangesHeading">What's included</h3>
            </div>
            ${totalItems ? `<span class="wn-total">${App.ui.esc(totalLabel)}</span>` : ''}
          </div>
          <div class="wn-list">
            ${groups.length ? groups.map((g) => `
              <section class="wn-group wn-group-${App.ui.esc(g.key)}">
                <div class="wn-group-h">
                  <span class="wn-ic" aria-hidden="true">${App.ui.esc(g.marker)}</span>
                  <span>${App.ui.esc(g.label)}</span>
                  ${g.items.length > 1 ? `<span class="wn-cnt">${g.items.length}</span>` : ''}
                </div>
                <ul class="wn-items">
                  ${g.items.map((it) => `<li class="wn-item">${App.ui.esc(it.text)}</li>`).join('')}
                </ul>
              </section>`).join('') : `
              <div class="wn-empty">
                <span class="wn-empty-mark" aria-hidden="true">+</span>
                <div><strong>Improvements are included</strong><span>Detailed release notes were not provided for this version.</span></div>
              </div>`}
          </div>
          <div class="wn-install-note">
            <span class="wn-install-ic" aria-hidden="true">↓</span>
            <div><strong>Download now, restart when ready.</strong><span>You can keep using YANKENT POS while the update downloads in the background.</span></div>
          </div>
        </section>
      </div>`;
    const m = App.ui.modal({
      title: "What's New",
      wide: true,
      bodyHtml: body,
      footerHtml: `<button class="btn btn-ghost" data-a="no">Not now</button>
        <button class="btn btn-primary" data-a="yes">Download update</button>`,
    });
    const dialog = m.el.querySelector('.modal');
    const heading = m.el.querySelector('.modal-h > span');
    const primaryAction = m.el.querySelector('[data-a="yes"]');
    const backgroundStates = ['app', 'login', 'printerStatusBar']
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((element) => ({ element, inert: element.inert }));
    backgroundStates.forEach(({ element }) => { element.inert = true; });
    dialog.classList.add('wn-modal');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    heading.id = 'wnDialogTitle';
    dialog.setAttribute('aria-labelledby', heading.id);
    dialog.setAttribute('tabindex', '-1');
    let settled = false;
    let environmentRestored = false;
    let onKeyDown = null;
    const restoreEnvironment = () => {
      if (environmentRestored) return;
      environmentRestored = true;
      if (onKeyDown) document.removeEventListener('keydown', onKeyDown);
      backgroundStates.forEach(({ element, inert }) => { element.inert = inert; });
      if (returnFocus && typeof returnFocus.focus === 'function') setTimeout(() => returnFocus.focus(), 0);
    };
    onKeyDown = (event) => {
      const topModal = document.querySelector('#modal-root > .modal-overlay:last-child');
      if (topModal !== m.el) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...m.el.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const finish = (choice, close = true) => {
      if (settled) return;
      settled = true;
      restoreEnvironment();
      if (close) m.close();
      resolve(choice);
    };
    document.addEventListener('keydown', onKeyDown);
    primaryAction.onclick = () => finish(true);
    m.el.querySelector('[data-a="no"]').onclick = () => finish(false);
    m.onClose = () => {
      restoreEnvironment();
      finish(false, false);
    };
    requestAnimationFrame(() => primaryAction.focus());
  });
};

App._showUpToDate = function (ver) {
  const m = App.ui.modal({
    title: 'You’re up to date',
    bodyHtml: `
      <div style="text-align:center;padding:14px 4px">
        <div class="wn-ok-badge">✓</div>
        <div class="wn-ver" style="margin-top:10px"><span class="wn-to">v${App.ui.esc(ver)}</span></div>
        <div class="wn-caption" style="margin-top:6px">YANKENT POS is already running the latest version.</div>
      </div>`,
    footerHtml: `<button class="btn btn-primary" data-a="ok">OK</button>`,
  });
  m.el.querySelector('[data-a="ok"]').onclick = () => m.close();
};

// ---- Download progress modal ------------------------------------------
App._fmtBytes = function (n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
};

App._showDownloadProgress = function (r) {
  return new Promise((resolve) => {
    const from = r.currentVersion, to = r.version;
    const body = `
      <div class="dl-head">
        <div class="dl-ver"><span class="dl-from">v${App.ui.esc(from)}</span><span class="dl-arrow">→</span><span class="dl-to">v${App.ui.esc(to)}</span></div>
        <div class="dl-caption">Downloading the latest version of YANKENT POS.</div>
      </div>
      <div class="dl-bar-wrap">
        <div class="dl-bar" id="dlBar" style="width:0%"></div>
      </div>
      <div class="dl-meta">
        <div class="dl-pct" id="dlPct">0%</div>
        <div class="dl-stat" id="dlStat">Starting download…</div>
      </div>
      <div class="dl-sub" id="dlSub">—</div>`;
    const m = App.ui.modal({
      title: 'Updating YANKENT POS',
      bodyHtml: body,
      footerHtml: `<button class="btn btn-ghost" data-a="hide">Run in background</button>`,
    });
    const root = m.el;
    let done = false;
    let stallTimer = null;
    let lastPct = -1;
    let subscriptionIds = [];
    const cleanup = () => {
      subscriptionIds.forEach((id) => {
        try { App.pos.update.off(id); } catch {}
      });
      subscriptionIds = [];
    };
    const finish = (success) => {
      if (done) return false;
      done = true;
      clearTimeout(stallTimer);
      cleanup();
      resolve(success);
      return true;
    };
    const setPct = (pct) => {
      const p = Math.max(0, Math.min(100, pct));
      const bar = root.querySelector('#dlBar');
      const pc = root.querySelector('#dlPct');
      if (bar) bar.style.width = p + '%';
      if (pc) pc.textContent = Math.round(p) + '%';
    };

    const armStallWatchdog = () => {
      clearTimeout(stallTimer);
      // Surface a clear failure if the download never starts or stops making
      // progress for 90 seconds, including when the modal is hidden.
      stallTimer = setTimeout(() => {
        if (done) return;
        if (lastPct < 0) onError('Download did not start — this version may be older than the one you are running, or the network is blocking GitHub.');
        if (lastPct >= 0) onError('Download stalled. Check your internet connection and try again.');
      }, 90000);
    };

    const onProgress = (p) => {
      if (done) return;
      armStallWatchdog();
      const pct = (p && typeof p.percent === 'number') ? p.percent : 0;
      if (pct !== lastPct) lastPct = pct;
      setPct(pct);
      const stat = root.querySelector('#dlStat');
      const sub = root.querySelector('#dlSub');
      const transferred = App._fmtBytes(p.transferred);
      const total = App._fmtBytes(p.total);
      const speed = p.bytesPerSecond ? App._fmtBytes(p.bytesPerSecond) + '/s' : '';
      if (stat) stat.textContent = `${transferred} / ${total}${speed ? ' · ' + speed : ''}`;
      if (sub) sub.textContent = pct >= 100 ? 'Finalizing…' : 'Downloading…';
    };
    const onDownloaded = () => {
      if (!finish(true)) return;
      setPct(100);
      const stat = root.querySelector('#dlStat');
      const sub = root.querySelector('#dlSub');
      if (stat) stat.textContent = 'Update downloaded successfully';
      if (sub) sub.textContent = 'The app will restart to install.';
      m.body.innerHTML = `<div class="dl-done"><div class="dl-ok-badge">✓</div><div class="dl-ver" style="margin-top:10px"><span class="dl-to">v${App.ui.esc(to)}</span></div><div class="dl-caption">Update ready. Restart to finish installing.</div></div>`;
      // Replace footer with Install button
      m.el.querySelector('.modal-f').innerHTML = `<button class="btn btn-primary" data-a="install">Restart & Install</button>`;
      m.el.querySelector('[data-a="install"]').onclick = async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        let installFailed = false;
        let installErrorId = null;
        const stopListening = () => {
          if (installErrorId === null) return;
          App.pos.update.off(installErrorId);
          installErrorId = null;
        };
        installErrorId = App.pos.update.onError((message) => {
          installFailed = true;
          button.disabled = false;
          stopListening();
          App.ui.toast('Could not start the installer: ' + (message || 'unknown error'), 'err');
        });
        try {
          await App.pos.update.install();
          if (!installFailed) m.close();
          setTimeout(stopListening, 10000);
        } catch (e) {
          stopListening();
          button.disabled = false;
          App.ui.toast('Could not start the installer: ' + e.message, 'err');
        }
      };
      App.ui.toast('Update ready — install on restart', 'ok');
    };
    const onError = (msg) => {
      if (!finish(false)) return;
      const sub = root.querySelector('#dlSub');
      if (sub) { sub.textContent = 'Error: ' + (msg || 'download failed'); sub.style.color = 'var(--danger)'; }
      const isDowngrade = !App._isNewer(to, from);
      const hint = isDowngrade
        ? `You are running v${App.ui.esc(from)}, which is newer than the available v${App.ui.esc(to)}. Auto-update cannot downgrade. To install v${App.ui.esc(to)}, run its setup.exe manually.`
        : 'Check your internet connection and try again. If GitHub is blocked on your network, download the installer directly from the release page.';
      m.el.querySelector('.modal-f').innerHTML = `<button class="btn btn-primary" data-a="close">Close</button>`;
      m.el.querySelector('[data-a="close"]').onclick = () => m.close();
      App.ui.toast('Update download failed: ' + (msg || 'error'), 'err');
      // Show a clear hint in the body
      const stat = root.querySelector('#dlStat');
      if (stat) { stat.textContent = isDowngrade ? 'Downgrade not allowed' : 'Download stalled'; stat.style.color = 'var(--danger)'; }
      const sub2 = root.querySelector('#dlSub');
      if (sub2) sub2.innerHTML = App.ui.esc(hint);
    };

    // Defensive: never attempt a downgrade through the auto-updater.
    if (!App._isNewer(to, from)) {
      onError('This version is older than the one you are running.');
      return;
    }

    subscriptionIds = [
      App.pos.update.onDownloadProgress(onProgress),
      App.pos.update.onDownloaded(onDownloaded),
      App.pos.update.onError(onError),
    ];
    m.el.querySelector('[data-a="hide"]').onclick = () => { m.close(); };

    // Kick off the download now that listeners are attached.
    armStallWatchdog();
    App.pos.update.download().then(onDownloaded).catch((e) => onError(e.message));
  });
};

// ---- Login success animation ------------------------------------------
App._showLoginSuccess = function (user) {
  return new Promise((resolve) => {
    const name = user && user.full_name ? user.full_name : 'Cashier';
    const role = user && user.role === 'admin' ? 'Administrator' : 'Cashier';
    const overlay = document.createElement('div');
    overlay.className = 'login-success-overlay';
    overlay.innerHTML = `
      <div class="login-success-card">
        <div class="login-success-burst" aria-hidden="true"></div>
        <div class="login-success-ring" aria-hidden="true">
          <svg class="login-success-check" viewBox="0 0 52 52">
            <circle class="login-success-fill" cx="26" cy="26" r="24"></circle>
            <circle class="login-success-circle" cx="26" cy="26" r="24"></circle>
            <path class="login-success-path" d="M14.5 27.2l7.4 7.4L37.8 18.5"></path>
          </svg>
        </div>
        <p class="login-success-title">Welcome back</p>
        <p class="login-success-name">${App.ui.esc(name)}</p>
        <span class="login-success-role">${App.ui.esc(role)}</span>
        <p class="login-success-sub">Opening register…</p>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    const reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const holdMs = reducedMotion ? 400 : 1400;
    const leaveMs = reducedMotion ? 150 : 450;

    setTimeout(() => {
      overlay.classList.add('leaving');
      setTimeout(() => { overlay.remove(); resolve(); }, leaveMs);
    }, holdMs);
  });
};

// ---- Forgot password flow ---------------------------------------------
App._forgotPassword = function () {
  // Step 1: ask for username
  const m = App.ui.modal({
    title: 'Forgot Password',
    bodyHtml: `<div class="field"><label class="fl">Enter your username</label><input id="fpUser" placeholder="username" autofocus></div>
      <div class="hint">A request will be sent to the admin's Telegram for approval.</div>`,
    footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="send">Send Request</button>`,
  });
  m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
  m.el.querySelector('[data-a="send"]').onclick = async () => {
    const username = m.el.querySelector('#fpUser').value.trim();
    if (!username) { App.ui.toast('Enter your username', 'err'); return; }
    const btn = m.el.querySelector('[data-a="send"]'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const res = await App.pos.requestPasswordReset(username);
      m.close();
      App._awaitApproval(res.token, res.username);
    } catch (e) {
      App.ui.toast(e.message, 'err');
      btn.disabled = false; btn.textContent = 'Send Request';
    }
  };
};

// Step 2: wait for admin approval (polls every 5s)
App._awaitApproval = function (token, username) {
  let interval = null;
  const m = App.ui.modal({
    title: 'Waiting for Approval',
    bodyHtml: `<div style="text-align:center;padding:10px 0">
      <div class="spinner" style="margin:0 auto 12px"></div>
      <div style="font-weight:700">Request sent for <b>${App.ui.esc(username)}</b></div>
      <div class="hint" style="margin-top:6px">The admin will receive a Telegram message.<br>Waiting for approval…</div>
      <div class="hint" style="margin-top:8px">This will expire in 10 minutes.</div>
    </div>`,
    footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button>`,
  });
  m.el.querySelector('[data-a="cancel"]').onclick = () => { clearInterval(interval); m.close(); };
  const check = async () => {
    try {
      const r = await App.pos.checkResetApproval(token);
      if (r.status === 'approved') {
        clearInterval(interval); m.close();
        App._resetForm(token, username);
      } else if (r.status === 'denied') {
        clearInterval(interval); m.close();
        App.ui.toast('Request was denied by admin', 'err');
      } else if (r.status === 'expired') {
        clearInterval(interval); m.close();
        App.ui.toast('Request expired', 'err');
      }
    } catch {}
  };
  // Start polling (first check after 2s, then every 6s).
  interval = setInterval(check, 6000);
  setTimeout(check, 2000);
};

// Step 3: reset password form (applies to existing admin or cashier usernames)
App._resetForm = function (token, username) {
  const m = App.ui.modal({
    title: 'Reset Password',
    bodyHtml: `<div class="field"><label class="fl">Username</label><input value="${App.ui.esc(username)}" readonly></div>
      <div class="field"><label class="fl">New password</label>
        <div class="pw-field"><input id="rpPw" type="password" autofocus><button type="button" class="pw-toggle" data-tgt="rpPw" title="Show/hide">👁</button></div>
      </div>
      <div class="field"><label class="fl">Confirm password</label>
        <div class="pw-field"><input id="rpPw2" type="password"><button type="button" class="pw-toggle" data-tgt="rpPw2" title="Show/hide">👁</button></div>
      </div>
      <div class="hint">Minimum 4 characters.</div>`,
    footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="ok">SAVE</button>`,
  });
  m.el.querySelectorAll('.pw-toggle').forEach((b) => {
    b.onclick = () => {
      const inp = m.el.querySelector('#' + b.dataset.tgt);
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      b.textContent = show ? '🙈' : '👁';
    };
  });
  m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
  m.el.querySelector('[data-a="ok"]').onclick = async () => {
    const pw = m.el.querySelector('#rpPw').value;
    const pw2 = m.el.querySelector('#rpPw2').value;
    if (pw !== pw2) { App.ui.toast('Passwords do not match', 'err'); return; }
    if (pw.length < 4) { App.ui.toast('Password too short (min 4)', 'err'); return; }
    const btn = m.el.querySelector('[data-a="ok"]'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await App.pos.resetPassword(token, pw);
      m.close();
      App.ui.toast('Password reset! You can now sign in.', 'ok');
      document.getElementById('loginUser').value = username;
      document.getElementById('loginPass').focus();
    } catch (e) {
      App.ui.toast(e.message, 'err');
      btn.disabled = false; btn.textContent = 'SAVE';
    }
  };
};
