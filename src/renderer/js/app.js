'use strict';
/* YANKENT POS app shell — login, navigation, routing. */
window.App = window.App || {};

App.current = { user: null, view: 'pos' };

document.addEventListener('DOMContentLoaded', () => {
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
      await App._start();
    } catch (e2) {
      err.textContent = e2.message;
    }
  });

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
  let online = false;
  try { online = await App.pos.telegram.isOnline(); } catch {}
  if (online) {
    el.innerHTML = '<span class="dot on"></span><span class="on-txt">Online</span>';
  } else {
    el.innerHTML = '<span class="dot off"></span><span class="off-txt">Offline — POS still works</span>';
  }
};
