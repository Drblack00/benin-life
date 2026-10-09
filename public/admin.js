// Benin Life — admin dashboard
'use strict';
const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('bl_admin_token') || null;

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}

async function doLogin() {
  $('a-err').textContent = '';
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('a-username').value.trim(), password: $('a-password').value }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Failed');
    if (!j.is_admin) throw new Error('This account is not an admin.');
    token = j.token;
    sessionStorage.setItem('bl_admin_token', token);
    showDash();
  } catch (e) { $('a-err').textContent = e.message; }
}
$('a-btn').onclick = doLogin;
$('a-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

function showDash() {
  $('admin-login').classList.add('hidden');
  $('admin-dash').classList.remove('hidden');
  refresh();
  setInterval(refresh, 5000);
}

const ago = (ts) => {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
};
const fmt = (n) => '₦' + Number(n || 0).toLocaleString();

async function refresh() {
  try {
    const players = await api('/api/admin/players');
    const online = players.filter(p => p.online).length;
    $('a-online').textContent = `${online} online`;
    $('p-count').textContent = `${players.length} accounts`;
    const tb = $('p-body');
    tb.innerHTML = '';
    for (const p of players) {
      const tr = document.createElement('tr');
      const tags = [
        p.online ? '<span class="tag on">online</span>' : '<span class="tag">offline</span>',
        p.is_admin ? '<span class="tag adm">admin</span>' : '',
        p.banned ? '<span class="tag ban">banned</span>' : '',
      ].join(' ');
      tr.innerHTML = `<td><b>${esc(p.username)}</b></td><td>${tags}</td><td>${fmt(p.cash)}</td>` +
        `<td>${esc(p.housing)}</td><td>${ago(p.last_seen)}</td><td></td>`;
      const td = tr.lastChild;
      if (!p.is_admin) {
        const ban = document.createElement('button');
        ban.className = 'mini' + (p.banned ? '' : ' danger');
        ban.textContent = p.banned ? 'Unban' : 'Ban';
        ban.onclick = async () => { await api('/api/admin/ban', { method: 'POST', body: JSON.stringify({ username: p.username, banned: !p.banned }) }); refresh(); };
        const mk = document.createElement('button');
        mk.className = 'mini'; mk.textContent = 'Make admin';
        mk.onclick = async () => { if (confirm(`Make ${p.username} an admin?`)) { await api('/api/admin/make-admin', { method: 'POST', body: JSON.stringify({ username: p.username }) }); refresh(); } };
        td.appendChild(ban); td.appendChild(mk);
      } else {
        td.textContent = '—';
      }
      tb.appendChild(tr);
    }
    const chat = await api('/api/admin/chat');
    const box = $('admin-chat');
    box.innerHTML = '';
    for (const c of chat.slice(-60)) {
      const d = document.createElement('div');
      d.className = 'msg';
      d.innerHTML = `<span class="who">${esc(c.username)}: </span>`;
      d.appendChild(document.createTextNode(c.text));
      box.appendChild(d);
    }
  } catch (e) {
    if (/Admin only|unauthorized/i.test(e.message)) {
      sessionStorage.removeItem('bl_admin_token');
      location.reload();
    }
  }
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

$('b-send').onclick = async () => {
  const t = $('b-text').value.trim();
  if (!t) return;
  await api('/api/admin/broadcast', { method: 'POST', body: JSON.stringify({ text: t }) });
  $('b-text').value = '';
  alert('Broadcast sent 📢');
};
$('b-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('b-send').click(); });

if (token) showDash();
