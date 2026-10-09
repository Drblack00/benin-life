// ============================================================
// Benin Life — multiplayer client on a REAL map of Benin City
// Google Maps renderer (dark-styled) with canvas fallback.
// Movement, chat, zones and sim systems shared by both.
// ============================================================
'use strict';

const $ = (id) => document.getElementById(id);
const SPEED = 0.0011; // degrees/sec (~120 m/s, gamey)
let speedMult = 1;

let CFG = { mapsKey: '', spawn: { lat: 6.3345, lng: 5.6040 }, bounds: null };
let ws = null, token = localStorage.getItem('bl_token') || null;
let myName = localStorage.getItem('bl_name') || null;
let me = null;
const players = new Map(); // id -> {id,name,lat,lng,tlat,tlng,housing,gov}
let ZONES = {}, JOBS = {}, FOOD = {}, FUN = {}, HOUSING = {}, BOUNDS = null;
let BIZT = {}, VEHT = {};
let myBiz = null, election = { active: false }, governor = null, unreadDm = 0;
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
      BIZT = m.bizTypes; VEHT = m.vehicles;
      myBiz = m.biz; election = m.election; governor = m.governor;
      unreadDm = m.unreadDm || 0;
      speedMult = m.you.speedMult || 1;
      players.clear();
      for (const p of m.players) players.set(p.id, { ...p, tlat: p.lat, tlng: p.lng });
      $('auth-screen').classList.add('hidden');
      $('game-screen').classList.remove('hidden');
      if (me.is_admin) $('btn-admin').classList.remove('hidden');
      $('chat-msgs').innerHTML = '';
      for (const c of m.chat) addChat(c.name, c.text, c.name === myName, c.gov);
      addSys(`${myName} entered Benin City 🌆`);
      if (governor) addSys(`👑 ${governor.name} is the Governor of Benin City`);
      updateDmBadge();
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
      addChat(m.name, m.text, m.name === myName, m.gov);
      bubbleFor(m.id, m.lat, m.lng, m.text);
      break;
    case 'snap':
      if (me) { me.lat = m.lat; me.lng = m.lng; clickTarget = null; }
      break;
    case 'you':
      Object.assign(me, {
        cash: m.cash, energy: m.energy, hunger: m.hunger, happy: m.happy,
        housing: m.housing, cert: m.cert, lat: m.lat, lng: m.lng,
        vehicle: m.vehicle, savings: m.savings, loan: m.loan, gov: m.gov,
      });
      if (m.speedMult) speedMult = m.speedMult;
      updateHUD();
      if (m.note) toast(m.note);
      if (!$('zone-panel').classList.contains('hidden') && currentZone) renderZone(currentZone);
      if (!$('menu-panel').classList.contains('hidden') && menuTab) renderMenuBody();
      break;
    case 'biz':
      myBiz = m.biz;
      break;
    case 'election':
      election = m;
      if (!$('menu-panel').classList.contains('hidden') && menuTab === 'election') renderMenuBody();
      break;
    case 'gov':
      governor = { id: m.id, name: m.name };
      if (me) me.gov = (me.id === m.id);
      for (const p of players.values()) p.gov = (p.id === m.id);
      if (renderer && renderer.setGov) renderer.setGov(m.id);
      break;
    case 'stats':
      updateOnline(m.online);
      break;
    case 'dm':
      toast(`✉️ ${m.fromName}: ${m.text.slice(0, 60)}`);
      break;
    case 'dm_sent':
      break;
    case 'dm_unread':
      unreadDm = m.n;
      updateDmBadge();
      break;
    case 'dm_threads':
      renderThreads(m.threads);
      break;
    case 'dm_history':
      renderConversation(m.with, m.withName, m.msgs);
      break;
    case 'profile':
      renderProfile(m.p);
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
function addChat(name, text, isMe, gov) {
  const el = document.createElement('div');
  el.className = 'msg' + (isMe ? ' me' : '');
  const who = document.createElement('span');
  who.className = 'who'; who.textContent = (gov ? '👑 ' : '') + name + ': ';
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
function updateOnline(n) { $('online-count').textContent = `• ${n !== undefined ? n : players.size + 1} online`; }

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
      icon: dotIcon(colorFor(p.id), isMe), title: (p.gov ? '👑 ' : '') + p.name,
    });
    if (!isMe) mk.addListener('click', () => openProfile(p.id));
    this.markers.set(p.id, mk);
  }
  setGov(id) {
    for (const [pid, mk] of this.markers) {
      const pl = pid === (me && me.id) ? me : players.get(pid);
      if (pl) mk.setTitle((pid === id ? '👑 ' : '') + (pl.name || pl.username || ''));
    }
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
      const x = e.clientX - r.left, y = e.clientY - r.top;
      for (const p of players.values()) {
        const pp = this.ll2px(p.lat, p.lng, r.width, r.height);
        if (Math.hypot(pp.x - x, pp.y - y) < 26) { openProfile(p.id); return; }
      }
      const ll = this.px2ll(x, y, r.width, r.height);
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
    const dot = (lat, lng, color, label, isMe, gov) => {
      const p = P(lat, lng);
      ctx.beginPath(); ctx.arc(p.x, p.y, isMe ? 11 : 9, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      if (isMe) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke(); }
      ctx.font = '600 11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = isMe ? '#22c55e' : '#eef4fa';
      ctx.fillText(label, p.x, p.y - 16);
      if (gov) { ctx.font = '15px sans-serif'; ctx.fillText('👑', p.x, p.y - 30); }
    };
    for (const p of players.values()) dot(p.lat, p.lng, colorFor(p.id), p.name, false, p.gov);
    if (me) dot(me.lat, me.lng, colorFor(me.id), me.name + ' (you)', true, me.gov);
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
  const sp = SPEED * speedMult;
  let dlat = 0, dlng = 0;
  if (keys.up) dlat += 1;
  if (keys.down) dlat -= 1;
  if (keys.right) dlng += 1;
  if (keys.left) dlng -= 1;
  if (dlat || dlng) {
    clickTarget = null;
    const n = Math.hypot(dlat, dlng);
    me.lat = clamp(me.lat + (dlat / n) * sp * dt, BOUNDS.latMin, BOUNDS.latMax);
    me.lng = clamp(me.lng + (dlng / n) * sp * dt, BOUNDS.lngMin, BOUNDS.lngMax);
    sendMove();
  } else if (clickTarget) {
    const dM = haversineM(me.lat, me.lng, clickTarget.lat, clickTarget.lng);
    if (dM < 10) { clickTarget = null; }
    else {
      const stepM = Math.min(dM, sp * 111320 * dt);
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

// ============================================================
// MENU — Bank, Business, Garage, Election, Dice, Street Runs
// ============================================================
let menuTab = null;
const MENU_ITEMS = [
  ['bank', '🏦', 'Bank'],
  ['biz', '🏪', 'Business'],
  ['garage', '🚗', 'Garage'],
  ['election', '🗳️', 'Election'],
  ['dice', '🎲', 'Dice'],
  ['runs', '🏃', 'Street Runs'],
];
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
$('btn-menu').onclick = () => openMenu(null);
$('menu-close').onclick = () => { $('menu-panel').classList.add('hidden'); menuTab = null; };

function openMenu(tab) {
  menuTab = tab;
  $('menu-panel').classList.remove('hidden');
  renderMenuBody();
}
function arow() { const d = document.createElement('div'); d.className = 'arow'; return d; }
function numInput(ph) { const i = document.createElement('input'); i.type = 'number'; i.min = '1'; i.placeholder = ph || 'Amount'; return i; }

function renderMenuBody() {
  const body = $('menu-body');
  body.innerHTML = '';
  if (!menuTab) {
    $('menu-title').textContent = 'Menu';
    const grid = document.createElement('div');
    grid.className = 'menu-grid';
    for (const [key, icon, label] of MENU_ITEMS) {
      const b = document.createElement('button');
      b.className = 'menu-tile';
      b.innerHTML = `<span class="mt-icon">${icon}</span><span>${label}</span>`;
      b.onclick = () => openMenu(key);
      grid.appendChild(b);
    }
    if (me.gov) {
      const gb = document.createElement('button');
      gb.className = 'menu-tile gov-tile';
      gb.innerHTML = `<span class="mt-icon">👑</span><span>Governor Broadcast</span>`;
      gb.onclick = () => openMenu('govbc');
      grid.appendChild(gb);
    }
    body.appendChild(grid);
    return;
  }
  const back = document.createElement('button');
  back.className = 'go'; back.textContent = '‹ Back'; back.style.marginBottom = '10px';
  back.onclick = () => openMenu(null);
  body.appendChild(back);
  ({ bank: renderBank, biz: renderBizMenu, garage: renderGarage, election: renderElection, dice: renderDice, runs: renderRuns, govbc: renderGovBc }[menuTab] || (() => {}))(body);
}

function renderBank(body) {
  $('menu-title').textContent = '🏦 Bank';
  body.appendChild(section('Your money'));
  body.appendChild(note(`Cash: ${fmt(me.cash)} • Savings: ${fmt(me.savings)} (2%/day) • Loan: ${fmt(me.loan)} (10%/day)`));
  body.appendChild(section('Deposit / Withdraw'));
  let r = arow();
  const di = numInput('Amount'); const db = document.createElement('button');
  db.className = 'go'; db.textContent = 'Deposit';
  db.onclick = () => send({ t: 'act', a: 'bank', op: 'deposit', amount: +di.value });
  r.appendChild(di); r.appendChild(db); body.appendChild(r);
  r = arow();
  const wi = numInput('Amount'); const wb = document.createElement('button');
  wb.className = 'go'; wb.textContent = 'Withdraw';
  wb.onclick = () => send({ t: 'act', a: 'bank', op: 'withdraw', amount: +wi.value });
  r.appendChild(wi); r.appendChild(wb); body.appendChild(r);
  body.appendChild(section('Loans — up to ₦100,000'));
  if (me.loan > 0) {
    body.appendChild(note(`Owing: ${fmt(me.loan)}`));
    r = arow();
    const pi = numInput('Repay amount'); const pb = document.createElement('button');
    pb.className = 'go'; pb.textContent = 'Repay';
    pb.onclick = () => send({ t: 'act', a: 'repay', amount: +pi.value });
    r.appendChild(pi); r.appendChild(pb); body.appendChild(r);
  } else {
    r = arow();
    const li = numInput('Loan amount'); const lb = document.createElement('button');
    lb.className = 'go'; lb.textContent = 'Borrow';
    lb.onclick = () => send({ t: 'act', a: 'loan', amount: +li.value });
    r.appendChild(li); r.appendChild(lb); body.appendChild(r);
  }
}

function renderBizMenu(body) {
  $('menu-title').textContent = '🏪 Business';
  if (myBiz && BIZT[myBiz]) {
    const b = BIZT[myBiz];
    body.appendChild(note(`${b.icon} You own a ${b.name} — it earns you ₦${b.income.toLocaleString()} every game day.`));
  } else {
    body.appendChild(section('Buy a business — daily income'));
    for (const [k, b] of Object.entries(BIZT))
      body.appendChild(row(`${b.icon} ${b.name}`, `₦${b.cost.toLocaleString()} • +₦${b.income.toLocaleString()}/day`, 'Buy',
        () => send({ t: 'act', a: 'buy_biz', biz: k }), me.cash < b.cost));
  }
}

function renderGarage(body) {
  $('menu-title').textContent = '🚗 Garage';
  const cur = VEHT[me.vehicle] || VEHT.none;
  body.appendChild(note(`Current: ${cur.icon} ${cur.name} (${speedMult}x speed)`));
  body.appendChild(section('Buy a ride — move faster'));
  for (const [k, v] of Object.entries(VEHT)) {
    if (k === 'none') continue;
    const owned = me.vehicle === k;
    body.appendChild(row(`${v.icon} ${v.name}`, `₦${v.cost.toLocaleString()} • ${v.mult}x speed`, owned ? '✓' : 'Buy',
      () => send({ t: 'act', a: 'buy_vehicle', v: k }), owned || me.cash < v.cost));
  }
}

function renderElection(body) {
  $('menu-title').textContent = '🗳️ Election';
  if (governor) body.appendChild(note(`👑 Current Governor: ${governor.name} (salary ₦25,000/day, daily city broadcast)`));
  if (!election.active) { body.appendChild(note('No election running right now.')); return; }
  body.appendChild(note(`Race ends in ~${election.endsInDays} game day(s). ${election.voted ? 'You have voted ✓' : 'You have not voted yet.'}`));
  body.appendChild(section('Candidates'));
  if (!election.candidates.length) body.appendChild(note('No candidates yet. Be the first!'));
  for (const c of election.candidates) {
    const isGov = governor && Number(c.player_id) === governor.id;
    body.appendChild(row(`${isGov ? '👑 ' : ''}${c.username}`, `${c.votes} vote(s)`,
      election.voted ? '🗳' : 'Vote',
      () => send({ t: 'act', a: 'vote', candidate: c.player_id }), election.voted));
  }
  body.appendChild(section('Run for Governor'));
  if (election.running) body.appendChild(note('You are on the ballot! Campaign in the city chat.'));
  else body.appendChild(row('Join the race', '₦50,000 campaign fee', 'Run',
    () => { if (confirm('Pay ₦50,000 campaign fee to run for Governor?')) send({ t: 'act', a: 'run' }); },
    me.cash < 50000));
}

let dicePick = 0;
function renderDice(body) {
  $('menu-title').textContent = '🎲 Dice';
  body.appendChild(note('Pick 1–6. Roll your number, win 5x your stake! Stake: ₦100 – ₦10,000.'));
  const picks = document.createElement('div'); picks.className = 'dice-picks';
  for (let i = 1; i <= 6; i++) {
    const b = document.createElement('button');
    b.className = 'dice-btn' + (dicePick === i ? ' sel' : '');
    b.textContent = i;
    b.onclick = () => { dicePick = i; renderMenuBody(); };
    picks.appendChild(b);
  }
  body.appendChild(picks);
  const r = arow();
  const inp = numInput('Stake'); inp.value = 500;
  const go = document.createElement('button'); go.className = 'go'; go.textContent = 'Roll 🎲';
  go.onclick = () => {
    if (!dicePick) return toast('Pick a number first!');
    send({ t: 'act', a: 'bet', amount: +inp.value, pick: dicePick });
  };
  r.appendChild(inp); r.appendChild(go); body.appendChild(r);
}

function renderRuns(body) {
  $('menu-title').textContent = '🏃 Street Runs';
  body.appendChild(note('Risky street hustle. 60% chance you score ₦3k–₦8k. Sometimes police dodge am, sometimes wahala: ₦10,000 "bail" or 3 minutes detention. Cooldown 2 min.'));
  const b = document.createElement('button'); b.className = 'primary'; b.textContent = 'Do street runs 🏃';
  b.style.marginTop = '10px';
  b.onclick = () => send({ t: 'act', a: 'runs' });
  body.appendChild(b);
}

function renderGovBc(body) {
  $('menu-title').textContent = '👑 Governor Broadcast';
  body.appendChild(note('As Governor, your word carries weight. Address the city (once per day):'));
  const r = arow();
  const inp = document.createElement('input'); inp.placeholder = 'Announcement…'; inp.maxLength = 200;
  const go = document.createElement('button'); go.className = 'go'; go.textContent = 'Send';
  go.onclick = () => { if (inp.value.trim()) { send({ t: 'act', a: 'gov_broadcast', text: inp.value }); inp.value = ''; } };
  r.appendChild(inp); r.appendChild(go); body.appendChild(r);
}

// ============================================================
// DMS
// ============================================================
let dmWith = null, dmWithName = '';
$('btn-dm').onclick = () => { $('dm-panel').classList.remove('hidden'); dmWith = null; send({ t: 'dm_threads' }); };
$('dm-close').onclick = () => $('dm-panel').classList.add('hidden');
$('dm-back').onclick = () => { dmWith = null; send({ t: 'dm_threads' }); };

function updateDmBadge() {
  const b = $('dm-badge');
  if (unreadDm > 0) { b.textContent = unreadDm > 9 ? '9+' : unreadDm; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}

function renderThreads(threads) {
  dmWith = null;
  $('dm-back').classList.add('hidden');
  const body = $('dm-body'); body.innerHTML = '';
  if (!threads.length) body.appendChild(note('No messages yet. Tap any player on the map to message them.'));
  for (const th of threads) {
    const d = document.createElement('div'); d.className = 'dm-thread';
    const b = document.createElement('b'); b.textContent = th.username;
    const prev = document.createElement('span'); prev.className = 'dm-prev'; prev.textContent = th.last_text || '';
    d.appendChild(b); d.appendChild(document.createTextNode(' ')); d.appendChild(prev);
    if (th.unread > 0) {
      const tag = document.createElement('span'); tag.className = 'tag on'; tag.textContent = th.unread + ' new';
      d.appendChild(document.createTextNode(' ')); d.appendChild(tag);
    }
    d.onclick = () => { dmWith = th.pid; dmWithName = th.username; send({ t: 'dm_history', with: th.pid }); };
    body.appendChild(d);
  }
}

function renderConversation(withId, withName, msgs) {
  $('dm-back').classList.remove('hidden');
  const body = $('dm-body'); body.innerHTML = '';
  const box = document.createElement('div'); box.id = 'dm-conv';
  for (const m of msgs) {
    const d = document.createElement('div');
    d.className = 'msg' + (m.from_id === me.id ? ' me' : '');
    d.appendChild(document.createTextNode(m.text));
    box.appendChild(d);
  }
  body.appendChild(box);
  box.scrollTop = box.scrollHeight;
  const r = arow();
  const inp = document.createElement('input'); inp.placeholder = `Message ${withName}…`; inp.maxLength = 200;
  const go = document.createElement('button'); go.className = 'go'; go.textContent = '➤';
  const sendDm = () => {
    const t = inp.value.trim(); if (!t) return;
    send({ t: 'dm', to: withId, text: t });
    const d = document.createElement('div'); d.className = 'msg me'; d.textContent = t;
    box.appendChild(d); box.scrollTop = box.scrollHeight; inp.value = '';
  };
  go.onclick = sendDm;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendDm(); });
  r.appendChild(inp); r.appendChild(go); body.appendChild(r);
  send({ t: 'dm_read' });
}

// ============================================================
// PROFILES
// ============================================================
function openProfile(id) {
  send({ t: 'profile', id });
  $('profile-modal').classList.remove('hidden');
  $('profile-title').textContent = '👤';
  $('profile-body').innerHTML = '<p style="color:#93a5b8">Loading…</p>';
}
$('profile-close').onclick = () => $('profile-modal').classList.add('hidden');

function renderProfile(p) {
  $('profile-title').textContent = (p.gov ? '👑 ' : '') + p.username;
  const body = $('profile-body'); body.innerHTML = '';
  const v = (VEHT && VEHT[p.vehicle]) || { icon: '🚶', name: 'On foot' };
  const rows = [
    ['Status', p.online ? '🟢 online' : '⚫ offline'],
    ['Cash', fmt(p.cash)],
    ['Housing', ((HOUSING || {})[p.housing] || {}).name || p.housing],
    ['Vehicle', `${v.icon} ${v.name}`],
    ['Business', p.biz && BIZT[p.biz] ? `${BIZT[p.biz].icon} ${BIZT[p.biz].name}` : '—'],
    ['Education', p.cert ? '🎓 Certified' : '—'],
  ];
  for (const [k, val] of rows) {
    const d = document.createElement('div'); d.className = 'prof-row';
    const s = document.createElement('span'); s.textContent = k;
    const b = document.createElement('b'); b.textContent = val;
    d.appendChild(s); d.appendChild(b); body.appendChild(d);
  }
  if (p.id !== me.id) {
    const b = document.createElement('button'); b.className = 'primary';
    b.style.marginTop = '12px'; b.textContent = `✉️ Message ${p.username}`;
    b.onclick = () => {
      $('profile-modal').classList.add('hidden');
      $('dm-panel').classList.remove('hidden');
      dmWith = p.id; dmWithName = p.username;
      send({ t: 'dm_history', with: p.id });
    };
    body.appendChild(b);
  }
}

// ============================================================
// LIVE COUNTERS on the auth screen
// ============================================================
async function loadStats() {
  try {
    const r = await fetch('/api/stats');
    const s = await r.json();
    $('live-counts').textContent =
      `🟢 ${s.online} online now • 👥 ${(s.visits || 0).toLocaleString()} visits` +
      (s.governor ? ` • 👑 Gov ${s.governor}` : '');
  } catch {}
}
loadStats();
setInterval(loadStats, 30000);
