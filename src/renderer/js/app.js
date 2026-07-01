'use strict';
/* YANKENT POS app shell — login, navigation, routing. */
window.App = window.App || {};

App.current = { user: null, view: 'pos' };

document.addEventListener('DOMContentLoaded', () => {
  // Force-play the login background video (in case autoplay is blocked).
  const bgVideo = document.querySelector('.login-bg');
  if (bgVideo) { bgVideo.play().catch(() => {}); }

  const loginForm = document.getElementById('loginForm');
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('loginError');
    err.textContent = '';
    const u = document.getElementById('loginUser').value.trim();
    const p = document.getElementById('loginPass').value;
    try {
      const data = await App.pos.login(u, p);
      App.current.user = data.user;
      await App._showLoginSuccess();
      await App._start();
    } catch (e2) {
      err.textContent = e2.message;
      const card = document.querySelector('.login-card');
      card.style.animation = 'none'; void card.offsetWidth; card.style.animation = 'shake .4s';
    }
  });

  document.getElementById('forgotPw').onclick = (e) => { e.preventDefault(); App._forgotPassword(); };

  document.getElementById('logoutBtn').onclick = async () => {
    await App.pos.logout();
    App.current.user = null;
    document.getElementById('app').classList.add('hidden');
    document.getElementById('login').classList.remove('hidden');
    document.getElementById('loginPass').value = '';
    document.getElementById('loginUser').focus();
  };

  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => App._navigate(btn.dataset.view));
  });

  // "Send Report" button — available to all roles (cashier + admin).
  document.getElementById('sendReportBtn').addEventListener('click', async () => {
    const btn = document.getElementById('sendReportBtn');
    btn.disabled = true; btn.textContent = '📨 Sending…';
    try {
      const r = await App.pos.telegram.sendReport();
      if (r.ok) App.ui.toast('Sales report sent to owner ✓', 'ok');
      else App.ui.toast(r.error || 'Failed to send', 'err');
    } catch (e) { App.ui.toast(e.message, 'err'); }
    btn.disabled = false; btn.textContent = '📨 Send Report';
  });

  App._clock();
  setInterval(() => App._clock(), 1000);
  App._net();
  setInterval(() => App._net(), 15000);
  App._loginNet();
  setInterval(() => App._loginNet(), 15000);
});

App._start = async function () {
  // Load settings (currency symbol, printer config, etc.)
  try {
    const s = await App.pos.settings.getAll();
    App.settingsCache = s;
    App.currencySymbol = s.currency_symbol || '₱';
  } catch { App.settingsCache = {}; }

  const u = App.current.user;
  document.getElementById('navUser').textContent = u.full_name;
  document.getElementById('navRole').textContent = u.role;
  const isAdmin = u.role === 'admin';
  document.querySelectorAll('.nav-item.admin-only').forEach((n) => n.classList.toggle('hidden', !isAdmin));

  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  App._navigate(isAdmin ? 'pos' : 'pos');
};

App._navigate = async function (name) {
  if (!App.views[name]) return;
  // Role guard: cashiers cannot open admin views.
  if (App.views[name].title && ['Products & Inventory', 'Users & Roles', 'Reports', 'Settings'].includes(App.views[name].title) && App.current.user.role !== 'admin') {
    App.ui.toast('Administrator access required', 'err'); return;
  }
  App.current.view = name;
  document.querySelectorAll('.nav-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  const view = document.getElementById('view');
  document.getElementById('viewTitle').textContent = App.views[name].title;
  view.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading…</div>';
  try { await App.views[name].render(view); }
  catch (e) { view.innerHTML = `<div class="empty-state">Error: ${App.ui.esc(e.message)}</div>`; }
};

App._clock = function () {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString('en-PH', { hour12: false });
};

App._net = async function () {
  const el = document.getElementById('netStatus');
  if (!el) return;
  let online = false;
  try { online = await App.pos.telegram.isOnline(); } catch {}
  el.textContent = online ? '● Online' : '● Offline-ready';
};

App._loginNet = async function () {
  const el = document.getElementById('loginStatus');
  if (!el) return;
  // Instant first pass using the browser's network state.
  if (navigator.onLine) {
    el.innerHTML = '<span class="dot on"></span><span class="on-txt">Online</span>';
  } else {
    el.innerHTML = '<span class="dot off"></span><span class="off-txt">Offline — POS still works</span>';
  }
  // Confirm with a real reachability ping.
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

// ---- Login success animation ------------------------------------------
App._showLoginSuccess = function () {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'login-success-overlay';
    overlay.innerHTML = '<div class="check"></div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    setTimeout(() => {
      overlay.style.transition = 'opacity .3s';
      overlay.style.opacity = '0';
      setTimeout(() => { overlay.remove(); resolve(); }, 300);
    }, 700);
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
