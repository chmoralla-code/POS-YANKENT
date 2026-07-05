'use strict';
/* Admin: user accounts & roles. */
window.App = window.App || {};
App.views = App.views || {};

App.views.users = {
  title: 'Users & Roles',
  users: [],

  async render(view) {
    this.viewEl = view;
    this.users = await App.pos.users.list();
    view.innerHTML = `
      <div class="toolbar"><div class="fill"></div><button class="btn btn-primary btn-sm" id="uAdd">+ Add User</button></div>
      <div class="panel" style="max-width:760px">
        <div class="panel-h">Users</div>
        <table class="tbl">
          <thead><tr><th>Username</th><th>Full name</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody id="uBody"></tbody>
        </table>
      </div>`;
    this._render();
    view.querySelector('#uAdd').onclick = () => this._edit(null);
    view.querySelector('#uBody').addEventListener('click', (e) => {
      const id = +e.target.closest('[data-id]')?.dataset.id; if (!id) return;
      if (e.target.dataset.act === 'edit') this._edit(id);
      else if (e.target.dataset.act === 'pw') this._pw(id);
      else if (e.target.dataset.act === 'toggle') this._toggleActive(id);
      else if (e.target.dataset.act === 'deluser') this._delete(id);
    });
  },

  _render() {
    this.viewEl.querySelector('#uBody').innerHTML = this.users.map((u) => `
      <tr data-id="${u.id}">
        <td class="mono">${App.ui.esc(u.username)}</td>
        <td>${App.ui.esc(u.full_name)}</td>
        <td><span class="badge ${u.role}">${u.role}</span></td>
        <td>${u.active ? '<span style="color:var(--ok)">active</span>' : '<span class="muted">inactive</span>'}</td>
        <td class="right">
          <button class="btn btn-sm btn-ghost" data-act="edit">Edit</button>
          <button class="btn btn-sm btn-ghost" data-act="pw">Password</button>
          <button class="btn btn-sm btn-ghost" data-act="toggle" title="${u.active ? 'Deactivate this user' : 'Reactivate this user'}">${u.active ? 'Deactivate' : 'Activate'}</button>
          <button class="btn btn-sm btn-danger" data-act="deluser" title="Delete this user">Delete</button>
        </td>
      </tr>`).join('');
  },

  async _toggleActive(id) {
    const u = this.users.find((x) => x.id === id);
    if (!u) return;
    if (u.active) {
      // Prevent deactivating the only active admin.
      if (u.role === 'admin') {
        const activeAdmins = this.users.filter((x) => x.role === 'admin' && x.active).length;
        if (activeAdmins <= 1) { App.ui.toast('Cannot deactivate the only active admin', 'err'); return; }
      }
      const ok = await App.ui.confirm(`Deactivate user "${u.username}"? They will no longer be able to log in. You can re-activate them later.`, { title: 'Deactivate user' });
      if (!ok) return;
    } else {
      const ok = await App.ui.confirm(`Reactivate user "${u.username}"? They will be able to log in again.`, { title: 'Activate user' });
      if (!ok) return;
    }
    try {
      await App.pos.users.update(id, { full_name: u.full_name, role: u.role, active: !u.active });
      App.ui.toast(u.active ? 'Deactivated ✓' : 'Activated ✓', 'ok');
      this.users = await App.pos.users.list(); this._render();
    } catch (e) { App.ui.toast(e.message, 'err'); }
  },

  async _delete(id) {
    const u = this.users.find((x) => x.id === id);
    if (!u) return;
    const ok = await App.ui.confirm(
      `Delete user "${u.username}"?${u.role === 'admin' ? '\n\nThey are an admin — make sure another active admin exists before deleting.' : ''}`,
      { danger: true, title: 'Delete user' }
    );
    if (!ok) return;
    try {
      const r = await App.pos.users.delete(id);
      if (r.deactivated) {
        App.ui.toast('User has sales history — deactivated instead of deleted', 'ok');
      } else {
        App.ui.toast('Deleted ✓', 'ok');
      }
      this.users = await App.pos.users.list(); this._render();
    } catch (e) { App.ui.toast(e.message, 'err'); }
  },

  _edit(id) {
    const u = id ? this.users.find((x) => x.id === id) : null;
    const m = App.ui.modal({
      title: id ? 'Edit User' : 'Add User', closeOnOverlay: false,
      bodyHtml: `<div class="field"><label class="fl">Username</label><input id="uUser" value="${u ? App.ui.esc(u.username) : ''}" ${u ? 'readonly' : ''}></div>
        <div class="field"><label class="fl">Full name</label><input id="uName" value="${u ? App.ui.esc(u.full_name) : ''}"></div>
        <div class="field"><label class="fl">Role</label><select id="uRole">
          <option value="cashier" ${u && u.role === 'cashier' ? 'selected' : ''}>Cashier — sell &amp; print only</option>
          <option value="admin" ${u && u.role === 'admin' ? 'selected' : ''}>Admin — full access</option>
        </select></div>
        ${u ? `<label class="row gap-sm"><input type="checkbox" id="uActive" ${u.active ? 'checked' : ''}> Active</label>` : ''}
        ${!u ? `<div class="field"><label class="fl">Password</label><input id="uPw" type="password"></div>` : ''}
        ${u ? `<div class="field"><label class="fl">Change password <span class="muted" style="text-transform:none;font-weight:400">— leave blank to keep current</span></label><input id="uPw" type="password" placeholder="New password (optional)"></div>` : ''}`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="ok">Save</button>`,
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="ok"]').onclick = async () => {
      try {
        if (id) {
          await App.pos.users.update(id, {
            full_name: m.el.querySelector('#uName').value.trim(),
            role: m.el.querySelector('#uRole').value,
            active: m.el.querySelector('#uActive').checked,
          });
          const newPw = m.el.querySelector('#uPw').value;
          if (newPw) {
            if (newPw.length < 4) { App.ui.toast('Password too short (min 4)', 'err'); return; }
            await App.pos.users.setPassword(id, newPw);
          }
        } else {
          const pw = m.el.querySelector('#uPw').value;
          if (!pw) { App.ui.toast('Enter a password', 'err'); return; }
          if (pw.length < 4) { App.ui.toast('Password too short (min 4)', 'err'); return; }
          await App.pos.users.create({
            username: m.el.querySelector('#uUser').value.trim(),
            full_name: m.el.querySelector('#uName').value.trim(),
            role: m.el.querySelector('#uRole').value,
            password: pw,
          });
        }
        App.ui.toast('Saved ✓', 'ok'); m.close();
        this.users = await App.pos.users.list(); this._render();
      } catch (e) { App.ui.toast(e.message, 'err'); }
    };
  },

  _pw(id) {
    const u = this.users.find((x) => x.id === id);
    const m = App.ui.modal({
      title: 'Change Password — ' + App.ui.esc(u.username), closeOnOverlay: false,
      bodyHtml: `<div class="hint" style="margin-bottom:10px">Set a new password for <b>${App.ui.esc(u.username)}</b> (${App.ui.esc(u.role)}).</div>
        <div class="field"><label class="fl">New password</label><input id="pw" type="password" autofocus></div>
        <div class="field"><label class="fl">Confirm password</label><input id="pw2" type="password"></div>`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="ok">Set Password</button>`,
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="ok"]').onclick = async () => {
      const pw = m.el.querySelector('#pw').value;
      const pw2 = m.el.querySelector('#pw2').value;
      if (!pw) { App.ui.toast('Enter a password', 'err'); return; }
      if (pw.length < 4) { App.ui.toast('Password too short (min 4)', 'err'); return; }
      if (pw !== pw2) { App.ui.toast('Passwords do not match', 'err'); return; }
      try { await App.pos.users.setPassword(id, pw); App.ui.toast('Password updated ✓', 'ok'); m.close(); }
      catch (e) { App.ui.toast(e.message, 'err'); }
    };
  },
};
