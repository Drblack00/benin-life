// ============================================================
// Benin Life — multiplayer game server
// Real-time life simulator on a real map of Benin City, Nigeria.
//
// Systems:
// - Accounts (bcrypt, lockout), live movement + chat (WebSocket)
// - Jobs, food, fun, education, sleep, housing/rent (game-day loop)
// - Elections: weekly Governor votes — run, vote, govern
// - Businesses: buy shops, earn daily income
// - Bank: savings with interest, loans with interest
// - Vehicles: keke/car = faster movement (server-validated)
// - Street runs: risky hustle — police wahala, fines, detention
// - Dice betting (fictional currency)
// - DMs: private player messages; player profiles
// - Admin API: players, chat, broadcast, ban, election control
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
  saveGame, countAdmins, listPlayers, setBanned, setAdmin,
  addChat, recentChat, getBusiness, createBusiness, listBusinesses,
  currentElection, createElection, closeElection, lastWinner,
  addCandidate, listCandidates, hasVoted, castVote, topCandidate,
  addDm, dmThreads, dmHistory, unreadDmCount, markDmRead,
  getMeta, setMeta, bumpVisits,
  addFriendRequest, respondFriendRequest, removeFriend, listFriendships, areFriends,
  createRoom, listRooms, getRoom, deleteRoom, joinRoom, leaveRoom, roomMembers,
  roomMemberRole, setRoomMuted, playerRooms,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------- Config ----------------
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || 'benin-life-dev-secret-change-me';
if (!process.env.SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET not set — using dev default. Set it in production!');
}
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const BOUNDS = { latMin: 6.27, latMax: 6.43, lngMin: 5.56, lngMax: 5.67 };
const BASE_MAX_SPEED_MPS = 250; // anti-cheat baseline (foot)
const DAY_MS = 5 * 60 * 1000;
const SAVE_MS = 30 * 1000;
const ELECTION_DAYS = 7; // game days per election cycle
const RUN_FEE = 50000;

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

const BIZ = {
  mamaput:  { name: 'Mama Put Spot', cost: 50000,  income: 3000,  icon: '🍲' },
  boutique: { name: 'Boutique',      cost: 150000, income: 8000,  icon: '👗' },
  lounge:   { name: 'Lounge & Bar',  cost: 400000, income: 20000, icon: '🍾' },
};

const VEHICLES = {
  none: { name: 'Trek (on foot)', cost: 0,      mult: 1,   icon: '🚶' },
  keke: { name: 'Keke Napep',     cost: 80000,  mult: 1.6,  icon: '🛺' },
  car:  { name: 'Toyota Camry',   cost: 300000, mult: 2.2,  icon: '🚗' },
};

const STUDY_COST = 5000;
const GOV_SALARY = 25000;
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
function speedMultOf(p) { return (VEHICLES[p.vehicle] || VEHICLES.none).mult; }

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

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

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
  const makeAdmin = (await countAdmins()) === 0;
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

app.get('/api/stats', async (req, res) => {
  const visits = Number((await getMeta('visits')) || 0);
  const gov = governorId ? (await getPlayerById(governorId)) : null;
  res.json({ online: online.size, visits, governor: gov ? gov.username : null });
});

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
    vehicle: r.vehicle, savings: Number(r.savings), loan: Number(r.loan),
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
app.get('/api/admin/election', requireAdmin, async (req, res) => {
  const el = await currentElection();
  res.json({ election: el, candidates: el ? await listCandidates(el.id) : [], governorId });
});
app.post('/api/admin/end-election', requireAdmin, async (req, res) => {
  await tallyElection(true);
  res.json({ ok: true, governorId });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---------------- Live state ----------------
const online = new Map();
let day = 1;
let dayStart = Date.now();
let election = null;
let governorId = 0;

// ---------------- Street finds (Pokémon-GO-style spawns) ----------------
const spawns = new Map(); // id -> {id,lat,lng,kind,icon,amount,expires}
let spawnSeq = 1;

// ---------------- Social: friends, rooms, mentions ----------------
const roomChats = new Map(); // roomId -> [{name,text,ts,gov}] (last 50)
const roomRead = new Map();  // `${pid}:${roomId}` -> ts last read
const PRESET_ROOMS = [
  { name: 'Hustle Talk', topic: 'Money moves & business gist', icon: '💼' },
  { name: 'Market Deals', topic: 'Buy & sell with players', icon: '🛒' },
  { name: 'Governance', topic: 'Elections, laws & city talk', icon: '🗳️' },
  { name: 'Street Gist', topic: 'Bants, vibes & randomness', icon: '🎲' },
];
async function seedRooms() {
  const existing = await listRooms();
  if (existing.length) return;
  for (const r of PRESET_ROOMS) await createRoom(r.name, r.topic, r.icon, 0);
  console.log('[rooms] seeded preset rooms');
}
function sendTo(pid, msg) {
  const o = online.get(pid);
  if (o && o.ws.readyState === 1) o.ws.send(JSON.stringify(msg));
}
// friends list enriched with live presence + location for the client
async function friendsFor(pid) {
  const list = await listFriendships(pid);
  return list.map(f => {
    const o = online.get(f.other_id);
    return { ...f, online: !!o, lat: o ? o.p.lat : null, lng: o ? o.p.lng : null };
  });
}
function roomHistory(roomId) {
  if (!roomChats.has(roomId)) roomChats.set(roomId, []);
  return roomChats.get(roomId);
}
async function roomListFor(pid) {
  const rooms = await listRooms();
  const mine = new Set(await playerRooms(pid));
  return Promise.all(rooms.map(async (r) => {
    const hist = roomHistory(r.id);
    const readTs = roomRead.get(`${pid}:${r.id}`) || 0;
    const unread = hist.filter(m => m.ts > readTs && m.name !== online.get(pid)?.p.username).length;
    return { ...r, members: Number(r.members), joined: mine.has(Number(r.id)), unread };
  }));
}
function notifyMentions(text, fromName, where) {  // where: {kind:'city'} or {kind:'room', roomId, roomName}
  const seen = new Set();
  for (const m of text.matchAll(/@([A-Za-z0-9_]{3,20})/g)) {
    const uname = m[1].toLowerCase();
    if (seen.has(uname)) continue;
    seen.add(uname);
    for (const o of online.values()) {
      if (o.p.username.toLowerCase() === uname && o.p.username !== fromName) {
        sendTo(o.p.id, {
          t: 'mention', from: fromName,
          where: where.kind === 'room' ? `room:${where.roomId}` : 'city',
          roomName: where.roomName || null,
          text: text.slice(0, 80),
        });
      }
    }
  }
}const SPAWN_KINDS = [
  { kind: 'cash', icon: '💵', w: 50 },
  { kind: 'snack', icon: '🍲', w: 25 },
  { kind: 'energy', icon: '🥤', w: 25 },
];
function pickSpawnKind() {
  let r = Math.random() * 100, acc = 0;
  for (const k of SPAWN_KINDS) { acc += k.w; if (r < acc) return k; }
  return SPAWN_KINDS[0];
}
function spawnTick() {
  const now = Date.now();
  for (const [id, s] of spawns) {
    if (s.expires < now) { spawns.delete(id); broadcast({ t: 'despawn', id }); }
  }
  if (spawns.size > 80) return;
  for (const o of online.values()) {
    const p = o.p;
    let near = 0;
    for (const s of spawns.values()) if (haversineM(p.lat, p.lng, s.lat, s.lng) < 800) near++;
    if (near >= 4) continue;
    const n = Math.random() < 0.5 ? 1 : 2;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 150 + Math.random() * 450; // meters from player
      const lat = p.lat + (dist * Math.cos(ang)) / 110540;
      const lng = p.lng + (dist * Math.sin(ang)) / (111320 * Math.cos(p.lat * Math.PI / 180));
      if (!inBounds(lat, lng)) continue;
      const kind = pickSpawnKind();
      const s = {
        id: spawnSeq++,
        lat: +lat.toFixed(6), lng: +lng.toFixed(6),
        kind: kind.kind, icon: kind.icon,
        amount: kind.kind === 'cash' ? 300 + Math.floor(Math.random() * 1200) : 0,
        expires: now + 180000,
      };
      spawns.set(s.id, s);
      broadcast({ t: 'spawn', s });
    }
  }
}

function pub(p) {
  return { id: p.id, name: p.username, lat: p.lat, lng: p.lng, housing: p.housing, gov: p.id === governorId };
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
  send(o, {
    t: 'you', cash: p.cash, energy: p.energy, hunger: p.hunger, happy: p.happy,
    housing: p.housing, cert: p.cert, lat: p.lat, lng: p.lng,
    vehicle: p.vehicle, savings: p.savings, loan: p.loan,
    speedMult: speedMultOf(p), detained: Date.now() < o.detainedUntil,
    gov: p.id === governorId, note: note || null,
  });
}
async function persist(o) {
  await saveGame({ ...o.p, last_seen: Date.now() });
}

// ---------------- Elections ----------------
async function tallyElection(forced) {
  const el = await currentElection();
  if (!el) return;
  const top = await topCandidate(el.id);
  const winnerId = top ? top.player_id : 0;
  await closeElection(el.id, winnerId || null);
  if (winnerId) {
    governorId = winnerId;
    await setMeta('governor_id', winnerId);
    const w = await getPlayerById(winnerId);
    broadcast({ t: 'sys', text: `👑 ${w ? w.username : 'Someone'} is the new Governor of Benin City!` });
    broadcast({ t: 'gov', id: winnerId, name: w ? w.username : '' });
  } else {
    broadcast({ t: 'sys', text: `🗳️ Election ended with no candidates. A new race begins!` });
  }
  election = await createElection(day, day + ELECTION_DAYS);
  broadcast({ t: 'election', ...(await electionState(null)) });
  // close campaign rooms from the finished race
  try {
    const rooms = await listRooms();
    for (const r of rooms) {
      if (Number(r.creator_id) !== 0 && r.icon === '📣' && /'s Campaign$/.test(r.name)) {
        await deleteRoom(Number(r.id));
        roomChats.delete(Number(r.id));
      }
    }
    for (const oid of online.keys()) sendTo(oid, { t: 'rooms', rooms: await roomListFor(oid) });
  } catch (e) { console.error('[campaign cleanup]', e.message); }
  console.log(`[election] #${el.id} closed, winner=${winnerId || 'none'}`);
}

async function electionState(playerId) {
  const el = await currentElection();
  if (!el) return { active: false };
  const candidates = await listCandidates(el.id);
  return {
    active: true, id: el.id,
    endsInDays: Math.max(0, el.end_day - day),
    candidates,
    voted: playerId ? await hasVoted(el.id, playerId) : false,
    running: playerId ? candidates.some(c => Number(c.player_id) === playerId) : false,
    governorId,
  };
}

// ---------------- Game actions (server-authoritative) ----------------
async function doAct(o, m) {
  const p = o.p;
  const now = Date.now();
  if (now < o.detainedUntil && !['chat'].includes(m.a)) {
    return sys(o, `⛓️ You're in detention for ${Math.ceil((o.detainedUntil - now) / 1000)}s. Sit this one out.`);
  }
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
  // ---------- Elections ----------
  else if (m.a === 'run') {
    const el = await currentElection();
    if (!el) return sys(o, 'No election running right now.');
    const cands = await listCandidates(el.id);
    if (cands.some(c => Number(c.player_id) === p.id)) return sys(o, 'You are already running.');
    if (p.cash < RUN_FEE) return sys(o, `Campaign fee is ₦${RUN_FEE.toLocaleString()}.`);
    p.cash -= RUN_FEE;
    await addCandidate(el.id, p.id);
    await persist(o);
    pushYou(o, `🗳️ You're on the ballot! Campaign across the city.`);
    broadcast({ t: 'sys', text: `🗳️ ${p.username} is running for Governor!` });
    // campaign room for this candidate
    try {
      const campId = await createRoom(`${p.username}'s Campaign`, `Campaign HQ — vote ${p.username} for Governor!`, '📣', p.id);
      await joinRoom(campId, p.id, 'owner');
      roomRead.set(`${p.id}:${campId}`, Date.now());
      for (const oid of online.keys()) sendTo(oid, { t: 'rooms', rooms: await roomListFor(oid) });
    } catch (e) { console.error('[campaign room]', e.message); }
  }
  else if (m.a === 'vote') {
    const el = await currentElection();
    if (!el) return sys(o, 'No election running right now.');
    const cid = Number(m.candidate);
    const cands = await listCandidates(el.id);
    if (!cands.some(c => Number(c.player_id) === cid)) return sys(o, 'That candidate is not running.');
    if (await hasVoted(el.id, p.id)) return sys(o, 'You already voted in this election.');
    await castVote(el.id, p.id, cid);
    pushYou(o, '🗳️ Vote cast! Results at the end of the race.');
    send(o, { t: 'election', ...(await electionState(p.id)) });
  }
  else if (m.a === 'gov_broadcast') {
    if (p.id !== governorId) return sys(o, 'Only the Governor can do that.');
    const left = cdLeft('govbc');
    if (left) return sys(o, `Governor broadcast available in ${left}s.`);
    const text = clean(m.text);
    if (!text) return;
    o.cds.govbc = now + 24 * 3600 * 1000;
    broadcast({ t: 'sys', text: `👑 Governor ${p.username}: ${text}` });
  }
  // ---------- Business ----------
  else if (m.a === 'buy_biz') {
    const b = BIZ[m.biz];
    if (!b) return sys(o, 'Unknown business.');
    if (await getBusiness(p.id)) return sys(o, 'You already own a business. One empire at a time!');
    if (p.cash < b.cost) return sys(o, `You need ₦${b.cost.toLocaleString()} to open this.`);
    p.cash -= b.cost;
    await createBusiness(p.id, m.biz, now);
    await persist(o);
    send(o, { t: 'biz', biz: m.biz });
    pushYou(o, `${b.icon} You now own a ${b.name}! Income lands every game day.`);
  }
  // ---------- Bank ----------
  else if (m.a === 'bank') {
    const amt = Math.floor(Number(m.amount));
    if (!amt || amt <= 0) return sys(o, 'Enter a valid amount.');
    if (m.op === 'deposit') {
      if (p.cash < amt) return sys(o, "You don't have that much cash.");
      p.cash -= amt; p.savings += amt;
      await persist(o);
      pushYou(o, `🏦 Deposited ₦${amt.toLocaleString()}. Savings earn 2%/day.`);
    } else if (m.op === 'withdraw') {
      if (p.savings < amt) return sys(o, "You don't have that much saved.");
      p.savings -= amt; p.cash += amt;
      await persist(o);
      pushYou(o, `🏦 Withdrew ₦${amt.toLocaleString()}.`);
    }
  }
  else if (m.a === 'loan') {
    const amt = Math.floor(Number(m.amount));
    if (!amt || amt <= 0 || amt > 100000) return sys(o, 'Loans: ₦1 – ₦100,000.');
    if (p.loan > 0) return sys(o, 'Repay your current loan first.');
    p.loan = amt; p.cash += amt;
    await persist(o);
    pushYou(o, `🏦 Loan of ₦${amt.toLocaleString()} approved. 10% daily interest — don't play!`);
  }
  else if (m.a === 'repay') {
    const amt = Math.floor(Number(m.amount));
    if (!amt || amt <= 0) return sys(o, 'Enter a valid amount.');
    if (p.loan <= 0) return sys(o, 'You have no loan.');
    const pay = Math.min(amt, p.loan, p.cash);
    if (pay <= 0) return sys(o, "You don't have the cash.");
    p.cash -= pay; p.loan -= pay;
    await persist(o);
    pushYou(o, p.loan > 0 ? `Repaid ₦${pay.toLocaleString()}. ₦${p.loan.toLocaleString()} left.` : '🎉 Loan fully repaid!');
  }
  // ---------- Vehicles ----------
  else if (m.a === 'buy_vehicle') {
    const v = VEHICLES[m.v];
    if (!v || m.v === 'none') return sys(o, 'Unknown vehicle.');
    if (p.vehicle === m.v) return sys(o, 'You already own this.');
    if (p.cash < v.cost) return sys(o, `You need ₦${v.cost.toLocaleString()}.`);
    p.cash -= v.cost;
    p.vehicle = m.v;
    await persist(o);
    pushYou(o, `${v.icon} ${v.name} acquired! You move ${v.mult}x faster.`);
  }
  // ---------- Street runs (crime risk) ----------
  else if (m.a === 'runs') {
    const left = cdLeft('runs');
    if (left) return sys(o, `Lay low for ${left}s.`);
    o.cds.runs = now + 120 * 1000;
    const r = Math.random();
    if (r < 0.60) {
      const gain = 3000 + Math.floor(Math.random() * 5000);
      p.cash += gain;
      p.energy = clamp(p.energy - 10, 0, 100);
      await persist(o);
      pushYou(o, `🏃 Street runs paid off: +₦${gain.toLocaleString()}. No wahala this time.`);
    } else if (r < 0.85) {
      await persist(o);
      pushYou(o, '👀 Police dey road — you dodge am. Nothing gained, nothing lost.');
    } else {
      if (p.cash >= 10000) {
        p.cash -= 10000;
        await persist(o);
        pushYou(o, '🚔 Police wahala! They seized ₦10,000 as "bail".');
      } else {
        o.detainedUntil = now + 3 * 60 * 1000;
        await persist(o);
        pushYou(o, '⛓️ Caught! 3 minutes detention. Think about your life choices.');
      }
    }
  }
  // ---------- Dice betting ----------
  else if (m.a === 'bet') {
    const amt = Math.floor(Number(m.amount));
    const pick = Math.floor(Number(m.pick));
    if (!amt || amt < 100 || amt > 10000) return sys(o, 'Stake: ₦100 – ₦10,000.');
    if (!pick || pick < 1 || pick > 6) return sys(o, 'Pick a number 1–6.');
    if (p.cash < amt) return sys(o, "You can't cover that stake.");
    p.cash -= amt;
    const roll = 1 + Math.floor(Math.random() * 6);
    if (roll === pick) {
      const win = amt * 5;
      p.cash += win;
      await persist(o);
      pushYou(o, `🎲 Rolled ${roll} — JACKPOT! +₦${win.toLocaleString()}`);
    } else {
      await persist(o);
      pushYou(o, `🎲 Rolled ${roll}, you picked ${pick}. Stake gone. Try again?`);
    }
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

// Daily economy: business income, bank interest, loan interest, governor salary
async function runEconomy() {
  try {
    // businesses pay owners (online or not)
    for (const b of await listBusinesses()) {
      const def = BIZ[b.type];
      if (!def) continue;
      const owner = await getPlayerById(b.owner_id);
      if (!owner) continue;
      owner.cash = Number(owner.cash) + def.income;
      await saveGame(owner);
      const o = online.get(owner.id);
      if (o) {
        o.p.cash = owner.cash;
        pushYou(o, `${def.icon} ${def.name} earned you ₦${def.income.toLocaleString()} today.`);
      }
    }
    // bank interest + loan interest for everyone
    for (const r of await listPlayers()) {
      let dirty = false;
      const p = { ...r, cash: Number(r.cash), savings: Number(r.savings), loan: Number(r.loan) };
      if (p.savings > 0) {
        const interest = Math.floor(p.savings * 0.02);
        p.savings += interest; p.cash += 0; dirty = true;
        const o = online.get(p.id);
        if (o) { o.p.savings = p.savings; pushYou(o, `🏦 Savings interest: +₦${interest.toLocaleString()}`); }
      }
      if (p.loan > 0) {
        const interest = Math.ceil(p.loan * 0.10);
        p.loan += interest; dirty = true;
        const o = online.get(p.id);
        if (o) { o.p.loan = p.loan; sys(o, `🏦 Loan interest: +₦${interest.toLocaleString()} (now ₦${p.loan.toLocaleString()}). Repay am!`); }
      }
      if (dirty) await saveGame(p);
    }
    // governor salary
    if (governorId) {
      const g = await getPlayerById(governorId);
      if (g) {
        g.cash = Number(g.cash) + GOV_SALARY;
        await saveGame(g);
        const o = online.get(governorId);
        if (o) { o.p.cash = g.cash; pushYou(o, `👑 Governor salary: +₦${GOV_SALARY.toLocaleString()}`); }
      }
    }
  } catch (e) { console.error('[economy]', e.message); }
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
      vehicle: row.vehicle || 'none', savings: Number(row.savings) || 0,
      loan: Number(row.loan) || 0, dm_read_ts: Number(row.dm_read_ts) || 0,
    },
    lastMove: 0, lastChat: 0, lastPos: null, cds: {}, detainedUntil: 0,
  };
  if (!inBounds(o.p.lat, o.p.lng)) { o.p.lat = SPAWN.lat; o.p.lng = SPAWN.lng; }
  o.lastPos = { lat: o.p.lat, lng: o.p.lng, ts: Date.now() };
  online.set(id, o);
  const visits = await bumpVisits().catch(() => 0);
  console.log(`[+] ${row.username} connected (${online.size} online)`);

  const biz = await getBusiness(id);
  const govRow = governorId ? await getPlayerById(governorId) : null;

  send(o, {
    t: 'init',
    you: { ...pub(o.p), cash: o.p.cash, energy: o.p.energy, hunger: o.p.hunger, happy: o.p.happy, cert: o.p.cert, is_admin: !!o.p.is_admin, vehicle: o.p.vehicle, savings: o.p.savings, loan: o.p.loan, speedMult: speedMultOf(o.p) },
    players: [...online.values()].filter(x => x.p.id !== id).map(x => pub(x.p)),
    day, endsIn: Math.max(0, DAY_MS - (Date.now() - dayStart)),
    chat: chatMemory.slice(-40),
    zones: ZONES, jobs: JOBS, food: FOOD, fun: FUN, housing: HOUSING, bounds: BOUNDS,
    bizTypes: BIZ, vehicles: VEHICLES,
    biz: biz ? biz.type : null,
    election: await electionState(id),
    governor: govRow ? { id: govRow.id, name: govRow.username } : null,
    unreadDm: await unreadDmCount(id),
    visits,
    spawns: [...spawns.values()],
    friends: await friendsFor(id),
    rooms: await roomListFor(id),
  });
  broadcast({ t: 'join', p: pub(o.p) }, id);
  broadcast({ t: 'stats', online: online.size });
  setTimeout(() => { try { spawnTick(); } catch (e) { console.error('[spawn]', e.message); } }, 1500);

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const now = Date.now();

    if (m.t === 'move') {
      if (now - o.lastMove < 40) return;
      o.lastMove = now;
      if (now < o.detainedUntil) return send(o, { t: 'snap', lat: o.p.lat, lng: o.p.lng });
      const lat = Number(m.lat), lng = Number(m.lng);
      if (!isFinite(lat) || !isFinite(lng) || !inBounds(lat, lng)) return;
      const maxSpeed = BASE_MAX_SPEED_MPS * speedMultOf(o.p);
      const dt = Math.max(0.05, (now - o.lastPos.ts) / 1000);
      const d = haversineM(o.lastPos.lat, o.lastPos.lng, lat, lng);
      if (d / dt > maxSpeed) {
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
      const entry = { name: o.p.username, text, ts: now, gov: o.p.id === governorId };
      chatMemory.push(entry);
      if (chatMemory.length > 60) chatMemory = chatMemory.slice(-60);
      await addChat(o.p.username, text, now).catch(e => console.error('[chat]', e.message));
      broadcast({ t: 'chat', id, ...entry, lat: o.p.lat, lng: o.p.lng });
      notifyMentions(text, o.p.username, { kind: 'city' });
    }
    else if (m.t === 'act') {
      await doAct(o, m).catch(e => { console.error('[act]', e.message); sys(o, 'Something went wrong, try again.'); });
    }
    else if (m.t === 'dm') {
      const toId = Number(m.to);
      const target = toId && toId !== o.p.id ? await getPlayerById(toId) : null;
      if (!target) return send(o, { t: 'err', text: 'Player not found.' });
      const text = clean(m.text);
      if (!text) return;
      await addDm(o.p.id, toId, text, now);
      const to = online.get(toId);
      if (to) {
        send(to, { t: 'dm', from: o.p.id, fromName: o.p.username, text, ts: now });
        send(to, { t: 'dm_unread', n: await unreadDmCount(toId) });
      }
      send(o, { t: 'dm_sent', to: toId });
    }
    else if (m.t === 'dm_threads') {
      send(o, { t: 'dm_threads', threads: await dmThreads(o.p.id) });
    }
    else if (m.t === 'dm_history') {
      const withId = Number(m.with);
      const other = withId ? await getPlayerById(withId) : null;
      if (!other) return;
      send(o, { t: 'dm_history', with: withId, withName: other.username, msgs: await dmHistory(o.p.id, withId) });
    }
    else if (m.t === 'dm_read') {
      o.p.dm_read_ts = now;
      await markDmRead(o.p.id, now);
      send(o, { t: 'dm_unread', n: 0 });
    }
    else if (m.t === 'collect') {
      const p = o.p;
      const s = spawns.get(Number(m.id));
      if (!s) return;
      if (Date.now() > s.expires) { spawns.delete(s.id); return; }
      if (haversineM(p.lat, p.lng, s.lat, s.lng) > 300) {
        sys(o, '📍 Too far — walk closer to grab it!');
        return;
      }
      spawns.delete(s.id);
      let msg;
      if (s.kind === 'cash') { p.cash += s.amount; msg = `💵 Street find! +₦${s.amount.toLocaleString()}`; }
      else if (s.kind === 'snack') { p.hunger = clamp(p.hunger + 25, 0, 100); msg = '🍲 Tasty street find! Hunger +25'; }
      else { p.energy = clamp(p.energy + 25, 0, 100); msg = '🥤 Cold drink! Energy +25'; }
      await persist(o);
      pushYou(o, msg);
      broadcast({ t: 'despawn', id: s.id });
    }
    else if (m.t === 'profile') {
      const tp = await getPlayerById(Number(m.id));
      if (!tp) return;
      const tbiz = await getBusiness(tp.id);
      send(o, {
        t: 'profile',
        p: {
          id: tp.id, username: tp.username, cash: Number(tp.cash),
          housing: tp.housing, vehicle: tp.vehicle || 'none', cert: !!Number(tp.cert),
          biz: tbiz ? tbiz.type : null, gov: tp.id === governorId,
          online: online.has(tp.id),
        },
      });
    }
    // ---------------- Friends ----------------
    else if (m.t === 'friend_add') {
      const uname = String(m.username || '').trim();
      if (!uname) return;
      const target = await getPlayerByName(uname);
      if (!target) return sys(o, `No player named "${uname}".`);
      const res = await addFriendRequest(id, target.id);
      if (res === 'self') return sys(o, 'You cannot add yourself.');
      if (res === 'exists') return sys(o, 'Already friends or request pending.');
      if (res === 'accepted') {
        sys(o, `🤝 You and ${target.username} are now friends!`);
        sendTo(target.id, { t: 'sys', text: `🤝 You and ${o.p.username} are now friends!` });
        sendTo(target.id, { t: 'friends', friends: await friendsFor(target.id) });
      } else {
        sys(o, `🤝 Friend request sent to ${target.username}.`);
        sendTo(target.id, {
          t: 'friend_request',
          from: { id: o.p.id, username: o.p.username },
          friends: await friendsFor(target.id),
        });
      }
      send(o, { t: 'friends', friends: await friendsFor(id) });
    }
    else if (m.t === 'friend_accept' || m.t === 'friend_decline') {
      const otherId = Number(m.playerId);
      const ok = await respondFriendRequest(id, otherId, m.t === 'friend_accept');
      if (!ok) return sys(o, 'No such request.');
      const other = await getPlayerById(otherId);
      const uname = other ? other.username : 'them';
      sys(o, m.t === 'friend_accept' ? `🤝 You are now friends with ${uname}!` : `Request from ${uname} declined.`);
      sendTo(otherId, {
        t: 'sys',
        text: m.t === 'friend_accept' ? `🤝 ${o.p.username} accepted your friend request!` : `😶 ${o.p.username} declined your friend request.`,
      });
      sendTo(otherId, { t: 'friends', friends: await friendsFor(otherId) });
      send(o, { t: 'friends', friends: await friendsFor(id) });
    }
    else if (m.t === 'friend_remove') {
      const otherId = Number(m.playerId);
      await removeFriend(id, otherId);
      send(o, { t: 'friends', friends: await friendsFor(id) });
      sendTo(otherId, { t: 'friends', friends: await friendsFor(otherId) });
      sys(o, 'Friend removed.');
    }
    else if (m.t === 'friends') {
      send(o, { t: 'friends', friends: await friendsFor(id) });
    }
    // ---------------- Rooms ----------------
    else if (m.t === 'rooms') {
      send(o, { t: 'rooms', rooms: await roomListFor(id) });
    }
    else if (m.t === 'create_room') {
      const name = clean(m.name).slice(0, 30);
      if (!name) return sys(o, 'Give the room a name.');
      const topic = clean(m.topic).slice(0, 80);
      const icon = String(m.icon || '💬').slice(0, 4);
      const roomId = await createRoom(name, topic, icon, id);
      await joinRoom(roomId, id, 'owner');
      roomRead.set(`${id}:${roomId}`, Date.now());
      for (const oid of online.keys()) sendTo(oid, { t: 'rooms', rooms: await roomListFor(oid) });
      send(o, { t: 'room_joined', roomId });
    }
    else if (m.t === 'join_room') {
      const roomId = Number(m.roomId);
      const room = await getRoom(roomId);
      if (!room) return sys(o, 'Room not found.');
      await joinRoom(roomId, id, 'member');
      roomRead.set(`${id}:${roomId}`, Date.now());
      send(o, { t: 'room_joined', roomId, history: roomHistory(roomId).slice(-50) });
      for (const oid of online.keys()) sendTo(oid, { t: 'rooms', rooms: await roomListFor(oid) });
    }
    else if (m.t === 'leave_room') {
      const roomId = Number(m.roomId);
      await leaveRoom(roomId, id);
      send(o, { t: 'room_left', roomId });
      for (const oid of online.keys()) sendTo(oid, { t: 'rooms', rooms: await roomListFor(oid) });
    }
    else if (m.t === 'room_chat') {
      const roomId = Number(m.roomId);
      const mem = await roomMemberRole(roomId, id);
      if (!mem) return sys(o, 'Join the room first.');
      if (Date.now() < mem.muted_until) return sys(o, '🔇 You are muted in this room.');
      if (now - o.lastChat < 1200) return send(o, { t: 'err', text: 'Slow down on the chat.' });
      o.lastChat = now;
      const text = clean(m.text);
      if (!text) return;
      const room = await getRoom(roomId);
      const entry = { name: o.p.username, text, ts: now, gov: o.p.id === governorId };
      const hist = roomHistory(roomId);
      hist.push(entry);
      if (hist.length > 50) hist.splice(0, hist.length - 50);
      const members = await roomMembers(roomId);
      for (const mb of members) {
        const mo = online.get(mb.player_id);
        if (mo && mo.ws.readyState === 1) {
          send(mo, { t: 'room_msg', roomId, ...entry });
          if (mb.player_id !== id) {
            const unread = hist.filter(x => x.ts > (roomRead.get(`${mb.player_id}:${roomId}`) || 0) && x.name !== mo.p.username).length;
            send(mo, { t: 'room_unread', roomId, unread });
          }
        }
      }
      notifyMentions(text, o.p.username, { kind: 'room', roomId, roomName: room ? room.name : '' });
    }
    else if (m.t === 'room_members') {
      const roomId = Number(m.roomId);
      const mem = await roomMemberRole(roomId, id);
      if (!mem) return;
      const members = await roomMembers(roomId);
      send(o, {
        t: 'room_members', roomId,
        members: members.map(x => ({ ...x, online: online.has(x.player_id) })),
      });
    }
    else if (m.t === 'room_read') {
      roomRead.set(`${id}:${Number(m.roomId)}`, Date.now());
    }
    else if (m.t === 'kick_room' || m.t === 'mute_room') {
      const roomId = Number(m.roomId);
      const targetId = Number(m.playerId);
      const mem = await roomMemberRole(roomId, id);
      const room = await getRoom(roomId);
      const isAdmin = !!o.p.is_admin;
      if (!mem || (mem.role !== 'owner' && !isAdmin)) return sys(o, 'Only the room owner can do that.');
      if (targetId === id) return sys(o, 'You cannot moderate yourself.');
      if (m.t === 'kick_room') {
        await leaveRoom(roomId, targetId);
        sendTo(targetId, { t: 'sys', text: `👢 You were kicked from "${room ? room.name : 'a room'}".` });
        sendTo(targetId, { t: 'room_left', roomId });
        sys(o, 'Member kicked.');
      } else {
        const mins = Math.max(1, Math.min(1440, Number(m.minutes) || 10));
        await setRoomMuted(roomId, targetId, Date.now() + mins * 60000);
        sendTo(targetId, { t: 'sys', text: `🔇 You are muted in "${room ? room.name : 'a room'}" for ${mins}m.` });
        sys(o, `Muted for ${mins}m.`);
      }
      const members = await roomMembers(roomId);
      for (const mb of members) sendTo(mb.player_id, {
        t: 'room_members', roomId,
        members: members.map(x => ({ ...x, online: online.has(x.player_id) })),
      });
    }
  });

  ws.on('close', () => {
    if (online.get(id) === o) {
      online.delete(id);
      persist(o).catch(e => console.error('[save]', e.message));
      broadcast({ t: 'leave', id });
      broadcast({ t: 'stats', online: online.size });
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
    await runEconomy();
    const el = await currentElection();
    if (el && day >= el.end_day) await tallyElection(false);
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
setInterval(spawnTick, 45000);
setTimeout(spawnTick, 5000);

// ---------------- Boot ----------------
election = await currentElection();
if (!election) election = await createElection(1, 1 + ELECTION_DAYS);
governorId = Number((await getMeta('governor_id')) || 0);
await seedRooms().catch(e => console.error('[rooms]', e.message));

server.listen(PORT, () => {
  console.log(`🌆 Benin Life server live on port ${PORT} — Day ${day} — db: ${dbMode()} — maps: ${MAPS_KEY ? 'key set' : 'NO KEY (fallback map)'}`);
});
