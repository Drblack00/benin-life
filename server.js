// ============================================================
// Benin Life — multiplayer game server
// Real-time life simulator on a real map of Benin City, Nigeria.
// - Player accounts (register/login, bcrypt, lockout on abuse)
// - Live player presence + movement broadcast (WebSocket)
// - Global live chat with rate limiting + profanity filter
// - Server-authoritative game actions (anti-cheat: speed checks,
//   zone checks, bounds checks — clients can't fake anything)
// - Game-day loop with automatic rent deduction
// - Admin API: player list, chat log, broadcast, ban/unban
// - PostgreSQL in production (DATABASE_URL), SQLite locally
// ============================================================

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initDb, dbMode, getPlayerByName, getPlayerById, createPlayer,
  savePlayer, saveGame, countAdmins, listPlayers, setBanned, setAdmin,
  addChat, recentChat,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------- Config ----------------
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || 'benin-life-dev-secret-change-me';
if (!process.env.SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET not set — using dev default. Set it in production!');
}
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
// Benin City playable bounds (city and environs)
const BOUNDS = { latMin: 6.27, latMax: 6.43, lngMin: 5.56, lngMax: 5.67 };
const MAX_SPEED_MPS = 250; // anti-cheat: nobody moves faster than this
const DAY_MS = 5 * 60 * 1000;
const SAVE_MS = 30 * 1000;

// ---------------- Game data: real Benin City coordinates ----------------
const ZONES = {
  ring:    { name: 'Ring Road',        lat: 6.3345,  lng: 5.6040,  r: 700, color: '#3b3f4a', icon: '🛣️' },
  oba:     { name: 'Oba Market',       lat: 6.33458, lng: 5.61977, r: 600, color: '#7a4a1e', icon: '🧺' },
  newbenin:{ name: 'New Benin Market', lat: 6.34993, lng: 5.63147, r: 700, color: '#6b3fa0', icon: '🏬' },
  uniben:  { name: 'UNIBEN',           lat: 6.40009, lng: 5.60915, r: 900, color: '#1e5f8a', icon: '🎓' },
  zoo:     { name: 'Ogba Zoo',         lat: 6.3056,  lng: 5.59444, r: 700, color: '#2e7d32', icon: '🦁' },
  kada:    { name: 'Kada Plaza',       lat: 6.31537, lng: 5.6277,  r: 600, color: '#8a1e3f', icon: '🎬' },
  housing: { name: 'GRA Housing',      lat: 6.32424, lng: 5.6196,  r: 700, color: '#5d6b7a', icon: '🏠' },
};
const SPAWN = { lat: 6.3345, lng: 5.6040 };

const JOBS = {
  porter: { name: 'Market Porter',  zone: 'oba',      pay: 2500, energy: 25, cd: 30 },
  keke:   { name: 'Keke Driver',    zone: 'ring',     pay: 4000, energy: 30, cd: 60 },
  shop:   { name: 'Shop Assistant', zone: 'newbenin', pay: 3500, energy: 25, cd: 45 },
  intern: { name: 'Graduate Intern',zone: 'uniben',   pay: 6000, energy: 30, cd: 90, cert: true },
};

const FOOD = {
  mamaput:  { name: 'Mama Put', cost: 800,  hunger: 30, energy: 15, happy: 0 },
  suya:     { name: 'Suya',     cost: 1500, hunger: 35, energy: 0,  happy: 10 },
  shawarma: { name: 'Shawarma', cost: 2000, hunger: 40, energy: 20, happy: 5 },
};

const FUN = {
  zoo:    { name: 'Ogba Zoo visit', cost: 1500, happy: 25, energy: -10 },
  cinema: { name: 'Kada Cinema',    cost: 2500, happy: 30, energy: 0 },
};

const HOUSING = {
  'face-me': { name: 'Face-me-I-face-you', rent: 5000 },
  selfcon:   { name: 'Self-contain',       rent: 12000 },
  flat:      { name: '2-Bedroom Flat',     rent: 25000 },
  bridge:    { name: 'Under the Bridge',   rent: 0 },
};

const STUDY_COST = 5000;
const BAD_WORDS = ['fuck', 'shit', 'bitch', 'nigga', 'nigger', 'dick', 'pussy', 'asshole', 'bastard', 'whore', 'slut'];

// ---------------- Database ----------------
await initDb();
let chatMemory = (await recentChat()).map(r => ({ name: r.username, text: r.text, ts: Number(r.ts) }));

// ---------------- Helpers ----------------
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function inZone(p, key) {
  const z = ZONES[key];
  return haversineM(p.lat, p.lng, z.lat, z.lng) <= z.r;
}
function inBounds(lat, lng) {
  return lat >= BOUNDS.latMin && lat <= BOUNDS.latMax && lng >= BOUNDS.lngMin && lng <= BOUNDS.lngMax;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function clean(text) {
  let t = String(text || '').trim().slice(0, 200);
  for (const w of BAD_WORDS) t = t.replace(new RegExp(w, 'gi'), '***');
  return t;
}

// ---------------- Auth tokens ----------------
function signToken(id) {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const body = `${id}.${exp}`;
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return Buffer.from(`${body}.${sig}`).toString('base64url');
}
function verifyToken(tok) {
  try {
    const s = Buffer.from(String(tok), 'base64url').toString('utf8');
    const parts = s.split('.');
    if (parts.length !== 3) return null;
    const [id, exp, sig] = parts;
    if (Date.now() > Number(exp)) return null;
    const good = crypto.createHmac('sha256', SECRET).update(`${id}.${exp}`).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    return Number(id);
  } catch { return null; }
}
async function adminFromReq(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return null;
  const id = verifyToken(m[1]);
  if (!id) return null;
  const p = await getPlayerById(id);
  if (!p || !Number(p.is_admin) || Number(p.banned)) return null;
  return p;
}

// ---------------- App ----------------
const app = express();
app.use(express.json({ limit: '32kb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Rate limiter for auth endpoints (per IP)
const authHits = new Map();
function authLimit(req, res, next) {
  const ip = req.ip || 'x';
  const now = Date.now();
  const arr = (authHits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now);
  authHits.set(ip, arr);
  if (arr.length > 10) return res.status(429).json({ error: 'Too many attempts, slow down.' });
  next();
}
// Per-account lockout: 5 failed logins -> 15 min block
const lockouts = new Map();
function lockCheck(name) {
  const l = lockouts.get(name);
  if (l && l.until > Date.now()) return Math.ceil((l.until - Date.now()) / 1000);
  return 0;
}
function lockFail(name) {
  const l = lockouts.get(name) || { count: 0, until: 0 };
  l.count += 1;
  if (l.count >= 5) { l.until = Date.now() + 15 * 60 * 1000; l.count = 0; }
  lockouts.set(name, l);
}

const USER_RE = /^[a-zA-Z0-9_]{3,16}$/;

app.post('/api/register', authLimit, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!USER_RE.test(username)) return res.status(400).json({ error: 'Username: 3-16 letters, numbers or _.' });
  if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password: min 8 characters.' });
  if (await getPlayerByName(username)) return res.status(409).json({ error: 'Username taken.' });
  const hash = bcrypt.hashSync(password, 10);
  const now = Date.now();
  const makeAdmin = (await countAdmins()) === 0; // first account ever = game admin
  const id = await createPlayer(username, hash, now, makeAdmin);
  res.json({ token: signToken(id), username, is_admin: makeAdmin });
});

app.post('/api/login', authLimit, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const locked = lockCheck(username);
  if (locked) return res.status(429).json({ error: `Account locked. Try again in ${Math.ceil(locked / 60)} min.` });
  const row = await getPlayerByName(username);
  if (!row || !bcrypt.compareSync(password, row.pass_hash)) {
    lockFail(username);
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  if (Number(row.banned)) return res.status(403).json({ error: 'This account is banned.' });
  lockouts.delete(username);
  await saveGame({ ...row, last_seen: Date.now() });
  res.json({ token: signToken(row.id), username: row.username, is_admin: !!Number(row.is_admin) });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, online: online.size, day, db: dbMode() });
});

// Public client config (maps key is referrer-restricted, safe to expose)
app.get('/api/config', (req, res) => {
  res.json({ mapsKey: MAPS_KEY, spawn: SPAWN, bounds: BOUNDS });
});

// ---------------- Admin API ----------------
async function requireAdmin(req, res, next) {
  const a = await adminFromReq(req);
  if (!a) return res.status(403).json({ error: 'Admin only.' });
  req.admin = a;
  next();
}
app.get('/api/admin/players', requireAdmin, async (req, res) => {
  const rows = await listPlayers();
  const onlineIds = new Set(online.keys());
  res.json(rows.map(r => ({
    id: r.id, username: r.username, cash: Number(r.cash), energy: Number(r.energy),
    hunger: Number(r.hunger), happy: Number(r.happy), housing: r.housing,
    cert: Number(r.cert), lat: Number(r.lat), lng: Number(r.lng),
    is_admin: !!Number(r.is_admin), banned: !!Number(r.banned),
    online: onlineIds.has(r.id), last_seen: Number(r.last_seen),
  })));
});
app.get('/api/admin/chat', requireAdmin, async (req, res) => {
  const rows = await recentChat(200);
  res.json(rows.map(r => ({ username: r.username, text: r.text, ts: Number(r.ts) })));
});
app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
  const text = clean(req.body.text);
  if (!text) return res.status(400).json({ error: 'Empty message.' });
  broadcast({ t: 'sys', text: `📢 ${text}` });
  res.json({ ok: true });
});
app.post('/api/admin/ban', requireAdmin, async (req, res) => {
  const target = await getPlayerByName(String(req.body.username || '').trim());
  if (!target) return res.status(404).json({ error: 'Player not found.' });
  if (Number(target.is_admin)) return res.status(400).json({ error: 'Cannot ban an admin.' });
  const banned = !!req.body.banned;
  await setBanned(target.id, banned);
  const o = online.get(target.id);
  if (banned && o) { try { o.ws.close(4403, 'banned'); } catch {} }
  res.json({ ok: true, banned });
});
app.post('/api/admin/make-admin', requireAdmin, async (req, res) => {
  const target = await getPlayerByName(String(req.body.username || '').trim());
  if (!target) return res.status(404).json({ error: 'Player not found.' });
  await setAdmin(target.id, true);
  res.json({ ok: true });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---------------- Live state ----------------
const online = new Map(); // id -> { ws, p, lastMove, lastChat, lastPos, cds: {} }
let day = 1;
let dayStart = Date.now();

function pub(p) {
  return { id: p.id, name: p.username, lat: p.lat, lng: p.lng, housing: p.housing };
}
function broadcast(msg, exceptId) {
  const s = JSON.stringify(msg);
  for (const [id, o] of online) {
    if (id === exceptId) continue;
    if (o.ws.readyState === 1) o.ws.send(s);
  }
}
function send(o, msg) {
  if (o.ws.readyState === 1) o.ws.send(JSON.stringify(msg));
}
function sys(o, text) { send(o, { t: 'sys', text }); }
function pushYou(o, note) {
  const p = o.p;
  send(o, { t: 'you', cash: p.cash, energy: p.energy, hunger: p.hunger, happy: p.happy, housing: p.housing, cert: p.cert, lat: p.lat, lng: p.lng, note: note || null });
}
async function persist(o) {
  await saveGame({ ...o.p, last_seen: Date.now() });
}

// ---------------- Game actions (server-authoritative) ----------------
async function doAct(o, m) {
  const p = o.p;
  const now = Date.now();
  const cdLeft = (key) => {
    const until = o.cds[key] || 0;
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  };

  if (m.a === 'work') {
    const job = JOBS[m.job];
    if (!job) return sys(o, 'Unknown job.');
    if (!inZone(p, job.zone)) return sys(o, `Go to ${ZONES[job.zone].name} to work as ${job.name}.`);
    if (job.cert && !p.cert) return sys(o, 'You need a UNIBEN certificate for this job. Study at UNIBEN first.');
    const left = cdLeft('work:' + m.job);
    if (left) return sys(o, `Rest small — ${job.name} available in ${left}s.`);
    if (p.energy < job.energy) return sys(o, 'Too tired. Eat or sleep first.');
    o.cds['work:' + m.job] = now + job.cd * 1000;
    p.energy = clamp(p.energy - job.energy, 0, 100);
    p.cash += job.pay;
    await persist(o);
    pushYou(o, `+₦${job.pay.toLocaleString()} — ${job.name} shift done 💪`);
  }
  else if (m.a === 'eat') {
    const f = FOOD[m.item];
    if (!f) return sys(o, 'Unknown food.');
    if (p.cash < f.cost) return sys(o, "You can't afford that. Hustle first!");
    p.cash -= f.cost;
    p.hunger = clamp(p.hunger + f.hunger, 0, 100);
    p.energy = clamp(p.energy + f.energy, 0, 100);
    p.happy = clamp(p.happy + f.happy, 0, 100);
    await persist(o);
    pushYou(o, `${f.name} devoured 😋`);
  }
  else if (m.a === 'fun') {
    const f = FUN[m.what];
    if (!f) return sys(o, 'Unknown fun.');
    const zoneKey = m.what === 'zoo' ? 'zoo' : 'kada';
    if (!inZone(p, zoneKey)) return sys(o, `Go to ${ZONES[zoneKey].name} first.`);
    if (p.cash < f.cost) return sys(o, "You can't afford that.");
    p.cash -= f.cost;
    p.happy = clamp(p.happy + f.happy, 0, 100);
    p.energy = clamp(p.energy + f.energy, 0, 100);
    await persist(o);
    pushYou(o, `${f.name} — vibes restored ✨`);
  }
  else if (m.a === 'study') {
    if (!inZone(p, 'uniben')) return sys(o, 'Go to UNIBEN to study.');
    if (p.cert) return sys(o, 'You already have your certificate.');
    const left = cdLeft('study');
    if (left) return sys(o, `Classes resume in ${left}s.`);
    if (p.cash < STUDY_COST) return sys(o, `Tuition is ₦${STUDY_COST.toLocaleString()}.`);
    o.cds.study = now + 60 * 1000;
    p.cash -= STUDY_COST;
    p.energy = clamp(p.energy - 15, 0, 100);
    p.cert = 1;
    await persist(o);
    pushYou(o, '🎓 Certificate earned! Graduate Intern unlocked.');
  }
  else if (m.a === 'sleep') {
    const left = cdLeft('sleep');
    if (left) return sys(o, `You just slept. (${left}s)`);
    o.cds.sleep = now + 60 * 1000;
    p.energy = 100;
    p.hunger = clamp(p.hunger - 15, 0, 100);
    await persist(o);
    pushYou(o, '😴 Fully rested.');
  }
  else if (m.a === 'rent') {
    const h = HOUSING[m.h];
    if (!h) return sys(o, 'Unknown housing.');
    if (!inZone(p, 'housing')) return sys(o, 'Go to the GRA Housing area to change housing.');
    p.housing = m.h;
    p.misses = 0;
    await persist(o);
    pushYou(o, `Moved to: ${h.name} 🏠`);
  }
  else {
    sys(o, 'Unknown action.');
  }
}

async function chargeRent(o) {
  const p = o.p;
  const h = HOUSING[p.housing] || HOUSING['face-me'];
  if (h.rent === 0) return;
  if (p.cash >= h.rent) {
    p.cash -= h.rent;
    p.misses = 0;
    sys(o, `🏠 Rent paid: ₦${h.rent.toLocaleString()} (${h.name})`);
  } else {
    p.misses += 1;
    if (p.misses >= 3) {
      p.housing = 'bridge';
      p.misses = 0;
      p.happy = clamp(p.happy - 20, 0, 100);
      sys(o, '⚠️ EVICTED! 3 missed rents. You now sleep under the bridge. Hustle hard to recover.');
    } else {
      sys(o, `⚠️ Landlord is knocking! Rent missed (${p.misses}/3). Pay ₦${h.rent.toLocaleString()} soon.`);
    }
  }
  await persist(o);
  pushYou(o);
}

// ---------------- WebSocket ----------------
wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const id = verifyToken(url.searchParams.get('token'));
  if (!id) { ws.close(4401, 'bad token'); return; }
  const row = await getPlayerById(id);
  if (!row) { ws.close(4401, 'no player'); return; }
  if (Number(row.banned)) { ws.close(4403, 'banned'); return; }

  const old = online.get(id);
  if (old) { try { old.ws.close(4409, 'new session'); } catch {} }

  const o = {
    ws,
    p: {
      ...row,
      cash: Number(row.cash), energy: Number(row.energy), hunger: Number(row.hunger),
      happy: Number(row.happy), lat: Number(row.lat), lng: Number(row.lng),
      misses: Number(row.misses), cert: Number(row.cert),
      is_admin: Number(row.is_admin), banned: Number(row.banned),
    },
    lastMove: 0, lastChat: 0, lastPos: null, cds: {},
  };
  // clamp spawned position into bounds (safety for old rows)
  if (!inBounds(o.p.lat, o.p.lng)) { o.p.lat = SPAWN.lat; o.p.lng = SPAWN.lng; }
  o.lastPos = { lat: o.p.lat, lng: o.p.lng, ts: Date.now() };
  online.set(id, o);
  console.log(`[+] ${row.username} connected (${online.size} online)`);

  send(o, {
    t: 'init',
    you: { ...pub(o.p), cash: o.p.cash, energy: o.p.energy, hunger: o.p.hunger, happy: o.p.happy, cert: o.p.cert, is_admin: !!o.p.is_admin },
    players: [...online.values()].filter(x => x.p.id !== id).map(x => pub(x.p)),
    day, endsIn: Math.max(0, DAY_MS - (Date.now() - dayStart)),
    chat: chatMemory.slice(-40),
    zones: ZONES, jobs: JOBS, food: FOOD, fun: FUN, housing: HOUSING, bounds: BOUNDS,
  });
  broadcast({ t: 'join', p: pub(o.p) }, id);

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const now = Date.now();

    if (m.t === 'move') {
      if (now - o.lastMove < 40) return;
      o.lastMove = now;
      const lat = Number(m.lat), lng = Number(m.lng);
      if (!isFinite(lat) || !isFinite(lng) || !inBounds(lat, lng)) return; // invalid: ignore
      // anti-cheat: speed check against last accepted position
      const dt = Math.max(0.05, (now - o.lastPos.ts) / 1000);
      const d = haversineM(o.lastPos.lat, o.lastPos.lng, lat, lng);
      if (d / dt > MAX_SPEED_MPS) {
        // teleport attempt: snap client back
        send(o, { t: 'snap', lat: o.p.lat, lng: o.p.lng });
        return;
      }
      o.p.lat = lat; o.p.lng = lng;
      o.lastPos = { lat, lng, ts: now };
      broadcast({ t: 'mv', id, lat, lng }, id);
    }
    else if (m.t === 'chat') {
      if (now - o.lastChat < 1200) return send(o, { t: 'err', text: 'Slow down on the chat.' });
      o.lastChat = now;
      const text = clean(m.text);
      if (!text) return;
      const entry = { name: o.p.username, text, ts: now };
      chatMemory.push(entry);
      if (chatMemory.length > 60) chatMemory = chatMemory.slice(-60);
      await addChat(o.p.username, text, now).catch(e => console.error('[chat]', e.message));
      broadcast({ t: 'chat', id, ...entry, lat: o.p.lat, lng: o.p.lng });
    }
    else if (m.t === 'act') {
      await doAct(o, m).catch(e => { console.error('[act]', e.message); sys(o, 'Something went wrong, try again.'); });
    }
  });

  ws.on('close', () => {
    if (online.get(id) === o) {
      online.delete(id);
      persist(o).catch(e => console.error('[save]', e.message));
      broadcast({ t: 'leave', id });
      console.log(`[-] ${o.p.username} left (${online.size} online)`);
    }
  });
});

// ---------------- Game loop ----------------
setInterval(async () => {
  if (Date.now() - dayStart >= DAY_MS) {
    day++;
    dayStart = Date.now();
    await Promise.all([...online.values()].map(o => chargeRent(o).catch(e => console.error('[rent]', e.message))));
    broadcast({ t: 'day', day, endsIn: DAY_MS });
    console.log(`[day] Day ${day} — ${online.size} online`);
  }
}, 1000);

setInterval(() => {
  for (const o of online.values()) {
    const p = o.p;
    p.hunger = clamp(p.hunger - 3, 0, 100);
    if (p.hunger <= 0) {
      p.energy = clamp(p.energy - 5, 0, 100);
      p.happy = clamp(p.happy - 5, 0, 100);
    }
    persist(o).catch(e => console.error('[save]', e.message));
    pushYou(o);
  }
}, 60000);

setInterval(() => { for (const o of online.values()) persist(o).catch(e => console.error('[save]', e.message)); }, SAVE_MS);

server.listen(PORT, () => {
  console.log(`🌆 Benin Life server live on port ${PORT} — Day ${day} — db: ${dbMode()} — maps: ${MAPS_KEY ? 'key set' : 'NO KEY (fallback map)'}`);
});
