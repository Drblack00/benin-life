// ============================================================
// Benin Life — multiplayer client on a REAL map of Benin City
// Google Maps renderer (dark-styled) with canvas fallback.
// Movement, chat, zones and sim systems shared by both.
// ============================================================
'use strict';

const $ = (id) => document.getElementById(id);
const SPEED = 0.0011; // degrees/sec (~120 m/s, gamey)

let CFG = { mapsKey: '', spawn: { lat: 6.3345, lng: 5.6040 }, bounds: null };
let ws = null, token = localStorage.getItem('bl_token') || null;
let myName = localStorage.getItem('bl_name') || null;
let me = null;
const players = new Map(); // id -> {id,name,lat,lng,tlat,tlng,housing}
let ZONES = {}, JOBS = {}, FOOD = {}, FUN = {}, HOUSING = {}, BOUNDS = null;
let day = 1, dayEndsIn = 0, mode = 'login';
let currentZone = null, manualClose = false;
let reconnectTimer = null, manualLogout = false;
const keys = {};
let clickTarget = null;
const bubbles = []; // {getPos:()=>{lat,lng}, text, until}
let renderer = null, loopStarted = false;

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, t = Math.PI / 180;
  const dLat = (lat2 - lat1) * t, dLng = (lng2 - lng1) * t;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * t) * Math.cos(lat2 * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const colorFor = (id) => `hsl(${(id * 137) % 360} 70% 55%)`;
const fmt = (n) => '₦' + Number(n || 0).toLocaleString();

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
  } catch (e) { $('auth-err').textContent = e.message; }
  $('auth-btn').disabled = false;
}
$('btn-logout').onclick = () => {
  manualLogout = true;
  localStorage.removeItem('bl_token'); localStorage.removeItem('bl_name');
  if (ws) ws.close();
  location.reload();
};
$('btn-admin').onclick = () => window.open('admin.html', '_blank');

// ============================================================
// WEBSOCKET
// ============================================================
function connect() {
  if (!token) return;
  manualLogout = false;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onopen = () => $('reconnect').classList.add('hidden');
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

async function handle(m) {
  switch (m.t) {
    case 'init':
      me = m.you; day = m.day; dayEndsIn = m.endsIn;
      ZONES = m.zones; JOBS = m.jobs; FOOD = m.food; FUN = m.fun; HOUSING = m.housing; BOUNDS = m.bounds;
      players.clear();
      for (const p of m.players) players.set(p.id, { ...p, tlat: p.lat, tlng: p.lng });
      $('auth-screen').classList.add('hidden');
      $('game-screen').classList.remove('hidden');
      if (me.is_admin) $('btn-admin').classList.remove('hidden');
      $('chat-msgs').innerHTML = '';
      for (const c of m.chat) addChat(c.name, c.text, c.name === myName);
      addSys(`${myName} entered Benin City 🌆`);
      await initRenderer();
      updateHUD(); startLoop();
      break;
    case 'join': {
      const p = { ...m.p, tlat: m.p.lat, tlng: m.p.lng };
      players.set(m.p.id, p);
      if (renderer) renderer.playerIn(p);
      addSys(`${m.p.name} entered the city 👋`);
      updateOnline();
      break;
    }
    case 'leave': {
      const p = players.get(m.id);
      players.delete(m.id);
      if (renderer) renderer.playerOut(m.id);
      if (p) addSys(`${p.name} left the city`);
      updateOnline();
      break;
    }
    case 'mv': {
      const p = players.get(m.id);
      if (p) { p.tlat = m.lat; p.tlng = m.lng; }
      break;
    }
    case 'chat':
      addChat(m.name, m.text, m.name === myName);
      bubbleFor(m.id, m.lat, m.lng, m.text);
      break;
    case 'snap':
      if (me) { me.lat = m.lat; me.lng = m.lng; clickTarget = null; }
      break;
    case 'you':
      Object.assign(me, {
        cash: m.cash, energy: m.energy, hunger: m.hunger, happy: m.happy,
        housing: m.housing, cert: m.cert, lat: m.lat, lng: m.lng,
      });
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
function bubbleFor(pid, lat, lng, text) {
  const near = !me || haversineM(me.lat, me.lng, lat, lng) < 1500 || (me && pid === me.id);
  if (!near) return;
  const src = pid === (me && me.id) ? me : players.get(pid);
  bubbles.push({ src: src || { lat, lng }, text: text.slice(0, 80), until: Date.now() + 5000 });
  if (bubbles.length > 12) bubbles.shift();
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
function updateOnline() { $('online-count').textContent = `• ${players.size + 1} online`; }

// ============================================================
// RENDERERS
// ============================================================
const DARK_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#161d29' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#161d29' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8a9bb0' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2c3a50' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3a4c68' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0b1220' }] },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];

function loadGoogleMaps(key) {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.maps) return resolve();
    const to = setTimeout(() => reject(new Error('timeout')), 10000);
    window.__blMapsReady = () => { clearTimeout(to); resolve(); };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__blMapsReady`;
    s.async = true; s.defer = true;
    s.onerror = () => { clearTimeout(to); reject(new Error('load failed')); };
    document.head.appendChild(s);
  });
}

function dotIcon(color, big) {
  const r = big ? 15 : 12, sz = big ? 38 : 32;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}"><circle cx="${sz / 2}" cy="${sz / 2}" r="${r}" fill="${color}" stroke="white" stroke-width="3"/></svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(sz, sz),
    anchor: new google.maps.Point(sz / 2, sz / 2),
  };
}

class GoogleRenderer {
  async init() {
    $('gmap').classList.remove('hidden');
    $('btn-recenter').classList.remove('hidden');
    this.map = new google.maps.Map($('gmap'), {
      center: { lat: me.lat, lng: me.lng },
      zoom: 14, styles: DARK_STYLE,
      disableDefaultUI: true, zoomControl: true,
      gestureHandling: 'greedy', clickableIcons: false,
    });
    // zone circles + labels
    for (const [k, z] of Object.entries(ZONES)) {
      new google.maps.Circle({
        center: { lat: z.lat, lng: z.lng }, radius: z.r,
        strokeColor: z.color, strokeWeight: 2, fillColor: z.color, fillOpacity: 0.18, map: this.map,
      });
      new google.maps.Marker({
        position: { lat: z.lat, lng: z.lng }, map: this.map,
        icon: { url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', scaledSize: new google.maps.Size(1, 1) },
        label: { text: `${z.icon} ${z.name}`, color: '#eef4fa', fontSize: '13px', fontWeight: '700' },
        clickable: false,
      });
    }
    this.markers = new Map();
    this.follow = true;
    this.followPauseUntil = 0;
    this.map.addListener('dragstart', () => { this.followPauseUntil = Date.now() + 15000; });
    this.map.addListener('click', (e) => this.tapCb && this.tapCb(e.latLng.lat(), e.latLng.lng()));
    // projection overlay for bubbles
    const ov = new google.maps.OverlayView();
    ov.onAdd = function () {}; ov.draw = function () {};
    ov.setMap(this.map);
    this.overlay = ov;
    for (const p of players.values()) this.playerIn(p);
    this.playerIn({ ...me, name: me.name + ' (you)' }, true);
  }
  playerIn(p, isMe) {
    if (this.markers.has(p.id)) return;
    const mk = new google.maps.Marker({
      position: { lat: p.lat, lng: p.lng }, map: this.map,
      icon: dotIcon(colorFor(p.id), isMe), title: p.name,
    });
    this.markers.set(p.id, mk);
  }
  playerOut(id) {
    const mk = this.markers.get(id);
    if (mk) { mk.setMap(null); this.markers.delete(id); }
  }
  frame() {
    for (const p of players.values()) {
      const mk = this.markers.get(p.id);
      if (mk) mk.setPosition({ lat: p.lat, lng: p.lng });
    }
    const myMk = this.markers.get(me.id);
    if (myMk) myMk.setPosition({ lat: me.lat, lng: me.lng });
    if (this.follow && Date.now() > this.followPauseUntil) this.map.setCenter({ lat: me.lat, lng: me.lng });
  }
  project(lat, lng) {
    try {
      const pr = this.overlay.getProjection();
      if (!pr) return null;
      const pt = pr.fromLatLngToDivPixel(new google.maps.LatLng(lat, lng));
      const wrap = $('map-wrap').getBoundingClientRect();
      const mapEl = $('gmap').getBoundingClientRect();
      return { x: pt.x + (mapEl.left - wrap.left), y: pt.y + (mapEl.top - wrap.top) };
    } catch { return null; }
  }
  onTap(cb) { this.tapCb = cb; }
  recenter() { this.followPauseUntil = 0; this.map.setCenter({ lat: me.lat, lng: me.lng }); }
}

class CanvasRenderer {
  init() {
    $('map').classList.remove('hidden');
    $('map-fallback-note').classList.remove('hidden');
    this.canvas = $('map');
    this.ctx = this.canvas.getContext('2d');
    this.tapCb = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const ll = this.px2ll(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
      if (this.tapCb) this.tapCb(ll.lat, ll.lng);
    });
    this.fit();
    window.addEventListener('resize', () => this.fit());
  }
  fit() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, r.width * dpr);
    this.canvas.height = Math.max(1, r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  scaleFor(w, h) { return Math.min(w, h) / 9000; } // ~9km view
  ll2px(lat, lng, w, h) {
    const s = this.scaleFor(w, h);
    const cx = me ? me.lng : 5.61, cy = me ? me.lat : 6.34;
    const mpx = 111320 * Math.cos(6.34 * Math.PI / 180) * s;
    const mpy = 110540 * s;
    return { x: w / 2 + (lng - cx) * mpx, y: h / 2 - (lat - cy) * mpy, s };
  }
  px2ll(x, y, w, h) {
    const s = this.scaleFor(w, h);
    const cx = me ? me.lng : 5.61, cy = me ? me.lat : 6.34;
    const mpx = 111320 * Math.cos(6.34 * Math.PI / 180) * s;
    const mpy = 110540 * s;
    return { lat: cy - (y - h / 2) / mpy, lng: cx + (x - w / 2) / mpx };
  }
  playerIn() {} playerOut() {}
  frame() {
    const ctx = this.ctx, c = this.canvas;
    const r = c.getBoundingClientRect(), w = r.width, h = r.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0e1622'; ctx.fillRect(0, 0, w, h);
    const P = (lat, lng) => this.ll2px(lat, lng, w, h);
    // roads between zones
    ctx.strokeStyle = '#2c3a50'; ctx.lineWidth = 5; ctx.lineCap = 'round';
    const zs = Object.values(ZONES);
    for (let i = 0; i < zs.length; i++) for (let j = i + 1; j < zs.length; j++) {
      const a = P(zs[i].lat, zs[i].lng), b = P(zs[j].lat, zs[j].lng);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // zones
    for (const z of zs) {
      const p = P(z.lat, z.lng), rr = z.r * p.s;
      ctx.fillStyle = z.color + '55'; ctx.strokeStyle = z.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.font = '20px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(z.icon, p.x, p.y - 6);
      ctx.font = '700 12px sans-serif'; ctx.fillStyle = '#eef4fa';
      ctx.fillText(z.name, p.x, p.y + 16);
    }
    // players
    const dot = (lat, lng, color, label, isMe) => {
      const p = P(lat, lng);
      ctx.beginPath(); ctx.arc(p.x, p.y, isMe ? 11 : 9, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      if (isMe) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke(); }
      ctx.font = '600 11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = isMe ? '#22c55e' : '#eef4fa';
      ctx.fillText(label, p.x, p.y - 16);
    };
    for (const p of players.values()) dot(p.lat, p.lng, colorFor(p.id), p.name, false);
    if (me) dot(me.lat, me.lng, colorFor(me.id), me.name + ' (you)', true);
  }
  project(lat, lng) {
    const r = this.canvas.getBoundingClientRect();
    const p = this.ll2px(lat, lng, r.width, r.height);
    const wrap = $('map-wrap').getBoundingClientRect();
    const cr = this.canvas.getBoundingClientRect();
    return { x: p.x + (cr.left - wrap.left), y: p.y + (cr.top - wrap.top) };
  }
  onTap(cb) { this.tapCb = cb; }
  recenter() {}
}

async function initRenderer() {
  try {
    const r = await fetch('/api/config');
    CFG = await r.json();
  } catch { CFG = { mapsKey: '', spawn: { lat: 6.3345, lng: 5.6040 } }; }
  let useGoogle = !!CFG.mapsKey;
  if (useGoogle) {
    try { await loadGoogleMaps(CFG.mapsKey); }
    catch (e) { useGoogle = false; toast('🗺️ Map key issue — stylized map active'); }
  }
  renderer = useGoogle ? new GoogleRenderer() : new CanvasRenderer();
  await renderer.init();
  renderer.onTap((lat, lng) => {
    if (!BOUNDS) return;
    clickTarget = {
      lat: clamp(lat, BOUNDS.latMin, BOUNDS.latMax),
      lng: clamp(lng, BOUNDS.lngMin, BOUNDS.lngMax),
    };
  });
  $('btn-recenter').onclick = () => renderer.recenter && renderer.recenter();
}

// ============================================================
// MAIN LOOP
// ============================================================
let lastMoveSent = 0;
function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  let last = performance.now();
  requestAnimationFrame(function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (me && renderer) {
      stepPlayer(dt);
      // interpolate remotes
      for (const p of players.values()) {
        if (p.tlat !== undefined) {
          p.lat += (p.tlat - p.lat) * 0.2;
          p.lng += (p.tlng - p.lng) * 0.2;
        }
      }
      renderer.frame();
      const z = zoneAt(me.lat, me.lng);
      if (z !== currentZone) {
        currentZone = z; manualClose = false;
        if (z) openZone(z); else closeZone();
      }
      dayEndsIn = Math.max(0, dayEndsIn - dt * 1000);
      drawBubbles();
    }
    requestAnimationFrame(frame);
  });
  setInterval(updateHUD, 1000);
  setInterval(drawBubbles, 300);
}

function stepPlayer(dt) {
  let dlat = 0, dlng = 0;
  if (keys.up) dlat += 1;
  if (keys.down) dlat -= 1;
  if (keys.right) dlng += 1;
  if (keys.left) dlng -= 1;
  if (dlat || dlng) {
    clickTarget = null;
    const n = Math.hypot(dlat, dlng);
    me.lat = clamp(me.lat + (dlat / n) * SPEED * dt, BOUNDS.latMin, BOUNDS.latMax);
    me.lng = clamp(me.lng + (dlng / n) * SPEED * dt, BOUNDS.lngMin, BOUNDS.lngMax);
    sendMove();
  } else if (clickTarget) {
    const dM = haversineM(me.lat, me.lng, clickTarget.lat, clickTarget.lng);
    if (dM < 10) { clickTarget = null; }
    else {
      const stepM = Math.min(dM, SPEED * 111320 * dt);
      const f = stepM / dM;
      me.lat = clamp(me.lat + (clickTarget.lat - me.lat) * f, BOUNDS.latMin, BOUNDS.latMax);
      me.lng = clamp(me.lng + (clickTarget.lng - me.lng) * f, BOUNDS.lngMin, BOUNDS.lngMax);
      sendMove();
    }
  }
}
function sendMove() {
  const now = performance.now();
  if (now - lastMoveSent < 100) return;
  lastMoveSent = now;
  send({ t: 'move', lat: +me.lat.toFixed(6), lng: +me.lng.toFixed(6) });
}
function zoneAt(lat, lng) {
  for (const [k, z] of Object.entries(ZONES))
    if (haversineM(lat, lng, z.lat, z.lng) <= z.r) return k;
  return null;
}

function drawBubbles() {
  const layer = $('bubble-layer');
  const now = Date.now();
  // prune
  for (let i = bubbles.length - 1; i >= 0; i--) if (bubbles[i].until < now) bubbles.splice(i, 1);
  layer.innerHTML = '';
  if (!renderer) return;
  for (const b of bubbles) {
    const pt = renderer.project(b.src.lat, b.src.lng);
    if (!pt) continue;
    const el = document.createElement('div');
    el.className = 'map-bubble';
    el.style.left = pt.x + 'px';
    el.style.top = (pt.y - 46) + 'px';
    el.textContent = b.text;
    layer.appendChild(el);
  }
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
function section(t) { const p = document.createElement('p'); p.innerHTML = `<b>${t}</b>`; p.style.margin = '10px 0 6px'; return p; }
function note(t) { const p = document.createElement('p'); p.style.cssText = 'color:#93a5b8;font-size:13px'; p.textContent = t; return p; }

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
    body.appendChild(note("The heartbeat of Benin City. Keke drivers rule these roads."));
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
  body.appendChild(section('😴 Rest'));
  body.appendChild(row('Sleep', 'Restore ⚡ to full • -15🍲', 'Sleep', () => send({ t: 'act', a: 'sleep' })));
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
