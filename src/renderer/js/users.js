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
        </td>
      </tr>`).join('');
  },

  _edit(id) {
    const u = id ? this.users.find((x) => x.id === id) : null;
    const m = App.ui.modal({
      title: id ? 'Edit User' : 'Add User',
      bodyHtml: `<div class="field"><label class="fl">Username</label><input id="uUser" value="${u ? App.ui.esc(u.username) : ''}" ${u ? 'readonly' : ''}></div>
        <div class="field"><label class="fl">Full name</label><input id="uName" value="${u ? App.ui.esc(u.full_name) : ''}"></div>
        <div class="field"><label class="fl">Role</label><select id="uRole">
          <option value="cashier" ${u && u.role === 'cashier' ? 'selected' : ''}>Cashier — sell &amp; print only</option>
          <option value="admin" ${u && u.role === 'admin' ? 'selected' : ''}>Admin — full access</option>
        </select></div>
        ${u ? `<label class="row gap-sm"><input type="checkbox" id="uActive" ${u.active ? 'checked' : ''}> Active</label>` : ''}
        ${!u ? `<div class="field"><label class="fl">Password</label><input id="uPw" type="password"></div>` : ''}`,
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
        } else {
          await App.pos.users.create({
            username: m.el.querySelector('#uUser').value.trim(),
            full_name: m.el.querySelector('#uName').value.trim(),
            role: m.el.querySelector('#uRole').value,
            password: m.el.querySelector('#uPw').value,
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
      title: 'Reset Password — ' + u.username,
      bodyHtml: `<div class="field"><label class="fl">New password</label><input id="pw" type="password" autofocus></div>`,
      footerHtml: `<button class="btn btn-ghost" data-a="cancel">Cancel</button><button class="btn btn-primary" data-a="ok">Set</button>`,
    });
    m.el.querySelector('[data-a="cancel"]').onclick = () => m.close();
    m.el.querySelector('[data-a="ok"]').onclick = async () => {
      const pw = m.el.querySelector('#pw').value;
      if (!pw) { App.ui.toast('Enter a password', 'err'); return; }
      try { await App.pos.users.setPassword(id, pw); App.ui.toast('Password set ✓', 'ok'); m.close(); }
      catch (e) { App.ui.toast(e.message, 'err'); }
    };
  },
};
