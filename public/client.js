// ============================================================
// Benin Life — multiplayer client
// Login, live Benin City map, movement, real-time chat,
// zone interactions (jobs, food, fun, study, housing, sleep)
// ============================================================
'use strict';

const $ = (id) => document.getElementById(id);
const WORLD = { w: 2000, h: 1400 };

let ws = null, token = localStorage.getItem('bl_token') || null;
let myName = localStorage.getItem('bl_name') || null;
let me = null;                       // my full state
const players = new Map();           // id -> {id,name,x,y,d,housing}
let ZONES = {}, JOBS = {}, FOOD = {}, FUN = {}, HOUSING = {};
let day = 1, dayEndsIn = 0;
let mode = 'login';                  // or 'register'
let currentZone = null, manualClose = false;
let reconnectTimer = null, manualLogout = false;

// ---------- movement ----------
const keys = {};
let clickTarget = null;
const cam = { x: 0, y: 0, scale: 1 };
let lastMoveSent = 0;
const bubbles = []; // {pid, text, until}

// ============================================================
// AUTH
// ============================================================
$('tab-login').onclick = () => setMode('login');
$('tab-register').onclick = () => setMode('register');
function setMode(m) {
  mode = m;
  $('tab-login').classList.toggle('active', m === 'login');
  $('tab-register').classList.toggle('active', m === 'register');
  $('auth-btn').textContent = m === 'login' ? 'Enter the city →' : 'Create account →';
  $('auth-err').textContent = '';
}
$('auth-btn').onclick = doAuth;
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth(); });

async function doAuth() {
  const username = $('username').value.trim();
  const password = $('password').value;
  $('auth-err').textContent = '';
  if (!username || !password) { $('auth-err').textContent = 'Enter username and password.'; return; }
  $('auth-btn').disabled = true;
  try {
    const r = await fetch('/api/' + mode, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Failed');
    token = j.token; myName = j.username;
    localStorage.setItem('bl_token', token);
    localStorage.setItem('bl_name', myName);
    connect();
  } catch (e) {
    $('auth-err').textContent = e.message;
  }
  $('auth-btn').disabled = false;
}

$('btn-logout').onclick = () => {
  manualLogout = true;
  localStorage.removeItem('bl_token');
  localStorage.removeItem('bl_name');
  if (ws) ws.close();
  location.reload();
};

// ============================================================
// WEBSOCKET
// ============================================================
function connect() {
  if (!token) return;
  manualLogout = false;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => { $('reconnect').classList.add('hidden'); };

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };

  ws.onclose = () => {
    if (manualLogout) return;
    $('reconnect').classList.remove('hidden');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2500);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

function handle(m) {
  switch (m.t) {
    case 'init':
      me = m.you; day = m.day; dayEndsIn = m.endsIn;
      ZONES = m.zones; JOBS = m.jobs; FOOD = m.food; FUN = m.fun; HOUSING = m.housing;
      players.clear();
      for (const p of m.players) players.set(p.id, p);
      $('auth-screen').classList.add('hidden');
      $('game-screen').classList.remove('hidden');
      $('chat-msgs').innerHTML = '';
      for (const c of m.chat) addChat(c.name, c.text, c.name === myName);
      addSys(`${myName} entered Benin City 🌆`);
      fit(); updateHUD(); startLoop();
      break;
    case 'join':
      players.set(m.p.id, m.p);
      addSys(`${m.p.name} entered the city 👋`);
      updateOnline();
      break;
    case 'leave': {
      const p = players.get(m.id);
      players.delete(m.id);
      if (p) addSys(`${p.name} left the city`);
      updateOnline();
      break;
    }
    case 'mv': {
      const p = players.get(m.id);
      if (p) { p.tx = m.x; p.ty = m.y; p.d = m.d; }
      break;
    }
    case 'chat':
      addChat(m.name, m.text, m.name === myName);
      bubbleFor(m.id, m.name, m.text);
      break;
    case 'you':
      Object.assign(me, { cash: m.cash, energy: m.energy, hunger: m.hunger, happy: m.happy, housing: m.housing, cert: m.cert });
      updateHUD();
      if (m.note) toast(m.note);
      if (!$('zone-panel').classList.contains('hidden') && currentZone) renderZone(currentZone);
      break;
    case 'sys': addSys(m.text); break;
    case 'err': toast('⚠️ ' + m.text); break;
    case 'day':
      day = m.day; dayEndsIn = m.endsIn; updateHUD();
      addSys(`📅 Day ${day} begins in Benin City`);
      break;
  }
}

// ============================================================
// CHAT
// ============================================================
function addChat(name, text, isMe) {
  const el = document.createElement('div');
  el.className = 'msg' + (isMe ? ' me' : '');
  const who = document.createElement('span');
  who.className = 'who'; who.textContent = name + ': ';
  el.appendChild(who);
  el.appendChild(document.createTextNode(text));
  const box = $('chat-msgs');
  box.appendChild(el);
  while (box.children.length > 120) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
function addSys(text) {
  const el = document.createElement('div');
  el.className = 'msg sys'; el.textContent = text;
  const box = $('chat-msgs');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
function bubbleFor(pid, name, text) {
  const near = pid === me.id ||
    (players.get(pid) && dist(players.get(pid), me) < 550);
  if (!near) return;
  bubbles.push({ pid, text: text.slice(0, 80), until: Date.now() + 5000 });
}
function sendChat() {
  const inp = $('chat-input');
  const text = inp.value.trim();
  if (!text) return;
  send({ t: 'chat', text });
  inp.value = '';
}
$('chat-send').onclick = sendChat;
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
function updateOnline() {
  $('online-count').textContent = `• ${players.size + 1} online`;
}

// ============================================================
// CANVAS / MAP
// ============================================================
const canvas = $('map');
const ctx = canvas.getContext('2d');

function fit() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, r.width * dpr);
  canvas.height = Math.max(1, r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', fit);

function w2s(x, y) {
  const r = canvas.getBoundingClientRect();
  return { x: (x - cam.x) * cam.scale + r.width / 2, y: (y - cam.y) * cam.scale + r.height / 2 };
}
function s2w(sx, sy) {
  const r = canvas.getBoundingClientRect();
  return { x: (sx - r.width / 2) / cam.scale + cam.x, y: (sy - r.height / 2) / cam.scale + cam.y };
}
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function colorFor(id) { return `hsl(${(id * 137) % 360} 70% 55%)`; }

function zoneAt(x, y) {
  for (const [k, z] of Object.entries(ZONES))
    if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return k;
  return null;
}

function draw() {
  const r = canvas.getBoundingClientRect();
  const vw = r.width, vh = r.height;
  ctx.clearRect(0, 0, vw, vh);

  // ground
  ctx.fillStyle = '#14210f';
  ctx.fillRect(0, 0, vw, vh);

  // subtle grid
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  const gs = 100 * cam.scale;
  const ox = (vw / 2 - cam.x * cam.scale) % gs, oy = (vh / 2 - cam.y * cam.scale) % gs;
  ctx.beginPath();
  for (let x = ox; x < vw; x += gs) { ctx.moveTo(x, 0); ctx.lineTo(x, vh); }
  for (let y = oy; y < vh; y += gs) { ctx.moveTo(0, y); ctx.lineTo(vw, y); }
  ctx.stroke();

  // roads: spokes from ring road to each zone
  const ring = ZONES.ring;
  if (ring) {
    const c = w2s(ring.x + ring.w / 2, ring.y + ring.h / 2);
    ctx.strokeStyle = '#3a3f4a'; ctx.lineWidth = 26 * cam.scale; ctx.lineCap = 'round';
    for (const [k, z] of Object.entries(ZONES)) {
      if (k === 'ring') continue;
      const p = w2s(z.x + z.w / 2, z.y + z.h / 2);
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    }
    // ring road circle
    ctx.strokeStyle = '#f5b301'; ctx.lineWidth = 5 * cam.scale;
    ctx.beginPath(); ctx.arc(c.x, c.y, 120 * cam.scale, 0, Math.PI * 2); ctx.stroke();
  }

  // zones
  for (const [k, z] of Object.entries(ZONES)) {
    const p = w2s(z.x, z.y);
    const w = z.w * cam.scale, h = z.h * cam.scale;
    ctx.fillStyle = z.color + '55';
    ctx.strokeStyle = z.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(p.x, p.y, w, h, 14 * cam.scale);
    ctx.fill(); ctx.stroke();
    ctx.font = `${Math.max(13, 20 * cam.scale)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(z.icon, p.x + w / 2, p.y + 30 * cam.scale);
    ctx.font = `600 ${Math.max(11, 14 * cam.scale)}px sans-serif`;
    ctx.fillStyle = '#eef4fa';
    ctx.fillText(z.name, p.x + w / 2, p.y + 52 * cam.scale);
  }

  const now = Date.now();
  // other players (interpolated)
  for (const p of players.values()) {
    if (p.tx !== undefined) {
      p.x = (p.x ?? p.tx) + (p.tx - (p.x ?? p.tx)) * 0.25;
      p.y = (p.y ?? p.ty) + (p.ty - (p.y ?? p.ty)) * 0.25;
    }
    drawPlayer(p.x, p.y, p.d || 0, colorFor(p.id), p.name, false);
  }
  // me
  if (me) drawPlayer(me.x, me.y, me.d || 0, colorFor(me.id), me.name + ' (you)', true);

  // speech bubbles
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    if (b.until < now) { bubbles.splice(i, 1); continue; }
    const p = b.pid === (me && me.id) ? me : players.get(b.pid);
    if (!p) { bubbles.splice(i, 1); continue; }
    const s = w2s(p.x, p.y - 44);
    ctx.font = '12px sans-serif';
    const tw = ctx.measureText(b.text).width + 18;
    ctx.fillStyle = 'rgba(10,14,20,0.92)';
    ctx.strokeStyle = '#2b3a4d';
    ctx.beginPath();
    ctx.roundRect(s.x - tw / 2, s.y - 20, tw, 26, 8);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#eef4fa'; ctx.textAlign = 'center';
    ctx.fillText(b.text, s.x, s.y - 2);
  }
}

function drawPlayer(x, y, d, color, label, isMe) {
  const s = w2s(x, y);
  const R = 16 * cam.scale;
  ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  if (isMe) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke(); }
  // facing tick
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(s.x + Math.cos(d) * R, s.y + Math.sin(d) * R);
  ctx.stroke();
  // name
  ctx.font = `600 ${Math.max(10, 12 * cam.scale)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = isMe ? '#22c55e' : '#eef4fa';
  ctx.fillText(label, s.x, s.y - R - 8);
}

// ---------- main loop ----------
let loopStarted = false;
function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  let last = performance.now();
  requestAnimationFrame(function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (me) {
      updateCamera();
      movePlayer(dt);
      const z = zoneAt(me.x, me.y);
      if (z !== currentZone) {
        currentZone = z; manualClose = false;
        if (z) openZone(z); else closeZone();
      }
      // day countdown
      dayEndsIn = Math.max(0, dayEndsIn - dt * 1000);
    }
    draw();
    requestAnimationFrame(frame);
  });
  setInterval(updateHUD, 1000);
}

function updateCamera() {
  const r = canvas.getBoundingClientRect();
  cam.scale = Math.max(0.45, Math.min(1, Math.min(r.width / 1100, r.height / 750)));
  cam.x += (me.x - cam.x) * 0.12;
  cam.y += (me.y - cam.y) * 0.12;
}

function movePlayer(dt) {
  const speed = 300;
  let dx = 0, dy = 0;
  if (keys.up) dy -= 1;
  if (keys.down) dy += 1;
  if (keys.left) dx -= 1;
  if (keys.right) dx += 1;
  if (dx || dy) {
    clickTarget = null;
    const len = Math.hypot(dx, dy);
    me.x = clampN(me.x + (dx / len) * speed * dt, 20, WORLD.w - 20);
    me.y = clampN(me.y + (dy / len) * speed * dt, 20, WORLD.h - 20);
    me.d = Math.atan2(dy, dx);
    sendMove();
  } else if (clickTarget) {
    const d = dist(me, clickTarget);
    if (d < 8) { clickTarget = null; }
    else {
      const step = Math.min(d, speed * dt);
      me.d = Math.atan2(clickTarget.y - me.y, clickTarget.x - me.x);
      me.x += ((clickTarget.x - me.x) / d) * step;
      me.y += ((clickTarget.y - me.y) / d) * step;
      sendMove();
    }
  }
}
function clampN(v, a, b) { return Math.max(a, Math.min(b, v)); }
function sendMove() {
  const now = performance.now();
  if (now - lastMoveSent < 100) return;
  lastMoveSent = now;
  send({ t: 'move', x: Math.round(me.x), y: Math.round(me.y), d: +me.d.toFixed(2) });
}

// ---------- input ----------
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = keyName(e.key);
  if (k) { keys[k] = true; clickTarget = null; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  const k = keyName(e.key);
  if (k) keys[k] = false;
});
function keyName(k) {
  k = k.toLowerCase();
  if (k === 'arrowup' || k === 'w') return 'up';
  if (k === 'arrowdown' || k === 's') return 'down';
  if (k === 'arrowleft' || k === 'a') return 'left';
  if (k === 'arrowright' || k === 'd') return 'right';
  return null;
}
canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  clickTarget = s2w(e.clientX - r.left, e.clientY - r.top);
});
// D-pad
document.querySelectorAll('#dpad button').forEach((b) => {
  const k = b.dataset.k;
  const on = (e) => { e.preventDefault(); keys[k] = true; clickTarget = null; };
  const off = (e) => { e.preventDefault(); keys[k] = false; };
  b.addEventListener('pointerdown', on);
  b.addEventListener('pointerup', off);
  b.addEventListener('pointerleave', off);
  b.addEventListener('pointercancel', off);
});

// ============================================================
// HUD + ZONE PANELS
// ============================================================
const fmt = (n) => '₦' + Number(n || 0).toLocaleString();
function updateHUD() {
  if (!me) return;
  const mm = String(Math.floor(dayEndsIn / 60000)).padStart(1, '0');
  const ss = String(Math.floor((dayEndsIn % 60000) / 1000)).padStart(2, '0');
  $('hud-day').textContent = `📅 Day ${day} • ${mm}:${ss}`;
  $('hud-cash').textContent = fmt(me.cash);
  $('bar-energy').style.width = me.energy + '%';
  $('bar-hunger').style.width = me.hunger + '%';
  $('bar-happy').style.width = me.happy + '%';
  updateOnline();
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = text;
  $('toast-wrap').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function openZone(key) {
  if (manualClose && currentZone === key) return;
  $('zone-icon').textContent = ZONES[key].icon;
  $('zone-name').textContent = ZONES[key].name;
  renderZone(key);
  $('zone-panel').classList.remove('hidden');
}
function closeZone() { $('zone-panel').classList.add('hidden'); }
$('zone-close').onclick = () => { manualClose = true; closeZone(); };
$('btn-help').onclick = () => $('help-panel').classList.remove('hidden');
$('help-close').onclick = () => $('help-panel').classList.add('hidden');

function row(title, sub, btnText, fn, disabled) {
  const d = document.createElement('div');
  d.className = 'action-row';
  const info = document.createElement('div');
  info.className = 'info';
  const b = document.createElement('b'); b.textContent = title;
  const s = document.createElement('span'); s.textContent = sub;
  info.appendChild(b); info.appendChild(s);
  const btn = document.createElement('button');
  btn.className = 'go'; btn.textContent = btnText;
  btn.disabled = !!disabled;
  btn.onclick = fn;
  d.appendChild(info); d.appendChild(btn);
  return d;
}

function renderZone(key) {
  const body = $('zone-body');
  body.innerHTML = '';
  const jobsHere = Object.entries(JOBS).filter(([, j]) => j.zone === key);

  if (key === 'oba' || key === 'newbenin') {
    body.appendChild(section('💼 Jobs here'));
    for (const [jk, j] of jobsHere)
      body.appendChild(row(j.name, `₦${j.pay.toLocaleString()} • -${j.energy}⚡`, 'Work', () => send({ t: 'act', a: 'work', job: jk })));
    body.appendChild(section('🍲 Food stalls'));
    const items = key === 'oba' ? ['mamaput', 'suya'] : ['shawarma', 'suya'];
    for (const ik of items) {
      const f = FOOD[ik];
      body.appendChild(row(f.name, `₦${f.cost.toLocaleString()} • +${f.hunger}🍲`, 'Eat', () => send({ t: 'act', a: 'eat', item: ik })));
    }
  }
  if (key === 'ring') {
    body.appendChild(section('💼 Jobs here'));
    for (const [jk, j] of jobsHere)
      body.appendChild(row(j.name, `₦${j.pay.toLocaleString()} • -${j.energy}⚡`, 'Work', () => send({ t: 'act', a: 'work', job: jk })));
    body.appendChild(note('The heartbeat of Benin City. Keke drivers rule these roads.'));
  }
  if (key === 'uniben') {
    body.appendChild(section('🎓 Education'));
    if (!me.cert)
      body.appendChild(row('Study for certificate', '₦5,000 tuition • -15⚡', 'Study', () => send({ t: 'act', a: 'study' })));
    else
      body.appendChild(note('🎓 Certified! Graduate Intern unlocked.'));
    body.appendChild(section('💼 Jobs here'));
    for (const [jk, j] of jobsHere)
      body.appendChild(row(j.name, `₦${j.pay.toLocaleString()} • -${j.energy}⚡${j.cert ? ' • needs certificate' : ''}`, 'Work',
        () => send({ t: 'act', a: 'work', job: jk }), j.cert && !me.cert));
  }
  if (key === 'zoo' || key === 'kada') {
    const fk = key === 'zoo' ? 'zoo' : 'cinema';
    const f = FUN[fk];
    body.appendChild(section('✨ Vibes'));
    body.appendChild(row(f.name, `₦${f.cost.toLocaleString()} • +${f.happy}😊`, 'Go', () => send({ t: 'act', a: 'fun', what: fk })));
  }
  if (key === 'housing') {
    body.appendChild(section('🏠 Housing — rent due every day'));
    for (const [hk, h] of Object.entries(HOUSING)) {
      const cur = me.housing === hk ? ' • current' : '';
      body.appendChild(row(h.name, h.rent ? `₦${h.rent.toLocaleString()}/day${cur}` : `Free${cur}`, me.housing === hk ? '✓' : 'Move',
        () => send({ t: 'act', a: 'rent', h: hk }), me.housing === hk));
    }
  }
  // rest section everywhere
  body.appendChild(section('😴 Rest'));
  body.appendChild(row('Sleep', 'Restore ⚡ to full • -15🍲', 'Sleep', () => send({ t: 'act', a: 'sleep' })));

  function section(t) { const p = document.createElement('p'); p.innerHTML = `<b>${t}</b>`; p.style.margin = '10px 0 6px'; return p; }
  function note(t) { const p = document.createElement('p'); p.style.cssText = 'color:#93a5b8;font-size:13px'; p.textContent = t; return p; }
}

// chat toggle on touch devices
(function () {
  const btn = document.createElement('button');
  btn.id = 'chat-toggle'; btn.className = 'icon-btn'; btn.textContent = '💬';
  btn.onclick = () => $('chat-panel').classList.toggle('open');
  $('main').appendChild(btn);
})();

// auto-login if token saved
if (token && myName) {
  $('username').value = myName;
  connect();
}
fit();
