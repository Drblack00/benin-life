// ============================================================
// Benin Life — multiplayer game server
// Real-time life simulator set in Benin City, Nigeria.
// - Player accounts (register/login, bcrypt passwords)
// - Live player presence + movement broadcast (WebSocket)
// - Global live chat with rate limiting + profanity filter
// - Server-authoritative game actions (work, eat, fun, study,
//   sleep, housing) so cash/stats can't be faked by clients
// - Game-day loop with automatic weekly-style rent deduction
// - SQLite persistence (node:sqlite, no native deps)
// ============================================================

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------- Config ----------------
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || 'benin-life-dev-secret-change-me';
if (!process.env.SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET not set — using dev default. Set it in production!');
}
const WORLD = { w: 2000, h: 1400 };
const DAY_MS = 5 * 60 * 1000; // 5 real minutes = 1 game day
const SAVE_MS = 30 * 1000;

// ---------------- Game data ----------------
const ZONES = {
  ring:    { name: 'Ring Road',        x: 880,  y: 600,  w: 240, h: 200, color: '#3b3f4a', icon: '🛣️' },
  oba:     { name: 'Oba Market',       x: 150,  y: 150,  w: 400, h: 300, color: '#7a4a1e', icon: '🧺' },
  newbenin:{ name: 'New Benin Market', x: 1450, y: 150,  w: 400, h: 300, color: '#6b3fa0', icon: '🏬' },
  uniben:  { name: 'UNIBEN',           x: 150,  y: 950,  w: 400, h: 300, color: '#1e5f8a', icon: '🎓' },
  zoo:     { name: 'Ogba Zoo',         x: 1450, y: 950,  w: 400, h: 300, color: '#2e7d32', icon: '🦁' },
  kada:    { name: 'Kada Cinema',      x: 850,  y: 60,   w: 300, h: 220, color: '#8a1e3f', icon: '🎬' },
  housing: { name: 'Housing Estate',   x: 850,  y: 1100, w: 300, h: 220, color: '#5d6b7a', icon: '🏠' },
};

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
const db = new DatabaseSync(path.join(__dirname, 'benin-life.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    cash INTEGER NOT NULL DEFAULT 10000,
    energy INTEGER NOT NULL DEFAULT 100,
    hunger INTEGER NOT NULL DEFAULT 100,
    happy INTEGER NOT NULL DEFAULT 80,
    housing TEXT NOT NULL DEFAULT 'face-me',
    cert INTEGER NOT NULL DEFAULT 0,
    x REAL NOT NULL DEFAULT 1000,
    y REAL NOT NULL DEFAULT 700,
    misses INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chatlog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
`);
const q = {
  byName: db.prepare('SELECT * FROM players WHERE username = ?'),
  byId: db.prepare('SELECT * FROM players WHERE id = ?'),
  insert: db.prepare(`INSERT INTO players (username, pass_hash, cash, energy, hunger, happy, housing, cert, x, y, misses, created_at, last_seen)
                      VALUES (?, ?, 10000, 100, 100, 80, 'face-me', 0, 1000, 700, 0, ?, ?)`),
  save: db.prepare('UPDATE players SET cash=?, energy=?, hunger=?, happy=?, housing=?, cert=?, x=?, y=?, misses=?, last_seen=? WHERE id=?'),
  chat: db.prepare('INSERT INTO chatlog (username, text, ts) VALUES (?, ?, ?)'),
  recentChat: db.prepare('SELECT username, text, ts FROM chatlog ORDER BY id DESC LIMIT 40'),
};

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

// ---------------- App ----------------
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple per-IP rate limiter for auth endpoints
const authHits = new Map();
function authLimit(req, res, next) {
  const ip = req.ip || 'x';
  const now = Date.now();
  const arr = (authHits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now);
  authHits.set(ip, arr);
  if (arr.length > 12) return res.status(429).json({ error: 'Too many attempts, slow down.' });
  next();
}

const USER_RE = /^[a-zA-Z0-9_]{3,16}$/;

app.post('/api/register', authLimit, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!USER_RE.test(username)) return res.status(400).json({ error: 'Username: 3-16 letters, numbers or _.' });
  if (password.length < 4 || password.length > 72) return res.status(400).json({ error: 'Password: min 4 characters.' });
  if (q.byName.get(username)) return res.status(409).json({ error: 'Username taken.' });
  const hash = bcrypt.hashSync(password, 10);
  const now = Date.now();
  const r = q.insert.run(username, hash, now, now);
  res.json({ token: signToken(Number(r.lastInsertRowid)), username });
});

app.post('/api/login', authLimit, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const row = q.byName.get(username);
  if (!row || !bcrypt.compareSync(password, row.pass_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  q.save.run(row.cash, row.energy, row.hunger, row.happy, row.housing, row.cert, row.x, row.y, row.misses, Date.now(), row.id);
  res.json({ token: signToken(row.id), username: row.username });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, online: online.size, day });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---------------- Live state ----------------
const online = new Map(); // id -> { ws, p, lastMove, lastChat, cds: {} }
let day = 1;
let dayStart = Date.now();
let chatMemory = q.recentChat.all().reverse().map(r => ({ name: r.username, text: r.text, ts: r.ts }));

function pub(p) {
  return { id: p.id, name: p.username, x: Math.round(p.x), y: Math.round(p.y), d: p.d || 0, housing: p.housing };
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
  send(o, { t: 'you', cash: p.cash, energy: p.energy, hunger: p.hunger, happy: p.happy, housing: p.housing, cert: p.cert, note: note || null });
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function inZone(p, key, pad = 70) {
  const z = ZONES[key];
  return p.x >= z.x - pad && p.x <= z.x + z.w + pad && p.y >= z.y - pad && p.y <= z.y + z.h + pad;
}
function clean(text) {
  let t = String(text || '').trim().slice(0, 200);
  for (const w of BAD_WORDS) t = t.replace(new RegExp(w, 'gi'), '***');
  return t;
}
function persist(o) {
  const p = o.p;
  q.save.run(p.cash, p.energy, p.hunger, p.happy, p.housing, p.cert, p.x, p.y, p.misses, Date.now(), p.id);
}

// ---------------- Game actions (server-authoritative) ----------------
function doAct(o, m) {
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
    persist(o);
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
    persist(o);
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
    persist(o);
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
    persist(o);
    pushYou(o, '🎓 Certificate earned! Graduate Intern unlocked.');
  }
  else if (m.a === 'sleep') {
    const left = cdLeft('sleep');
    if (left) return sys(o, `You just slept. (${left}s)`);
    o.cds.sleep = now + 60 * 1000;
    p.energy = 100;
    p.hunger = clamp(p.hunger - 15, 0, 100);
    persist(o);
    pushYou(o, '😴 Fully rested.');
  }
  else if (m.a === 'rent') {
    const h = HOUSING[m.h];
    if (!h) return sys(o, 'Unknown housing.');
    if (!inZone(p, 'housing')) return sys(o, 'Go to the Housing Estate to change housing.');
    p.housing = m.h;
    p.misses = 0;
    persist(o);
    pushYou(o, `Moved to: ${h.name} 🏠`);
  }
  else {
    sys(o, 'Unknown action.');
  }
}

function chargeRent(o) {
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
  persist(o);
  pushYou(o);
}

// ---------------- WebSocket ----------------
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const id = verifyToken(url.searchParams.get('token'));
  if (!id) { ws.close(4401, 'bad token'); return; }
  const row = q.byId.get(id);
  if (!row) { ws.close(4401, 'no player'); return; }

  // Kick any older session for this player
  const old = online.get(id);
  if (old) { try { old.ws.close(4409, 'new session'); } catch {} }

  const o = { ws, p: { ...row, d: 0 }, lastMove: 0, lastChat: 0, cds: {} };
  online.set(id, o);
  console.log(`[+] ${row.username} connected (${online.size} online)`);

  send(o, {
    t: 'init',
    you: { ...pub(o.p), cash: o.p.cash, energy: o.p.energy, hunger: o.p.hunger, happy: o.p.happy, cert: o.p.cert },
    players: [...online.values()].filter(x => x.p.id !== id).map(x => pub(x.p)),
    day, endsIn: Math.max(0, DAY_MS - (Date.now() - dayStart)),
    chat: chatMemory.slice(-40),
    zones: ZONES, jobs: JOBS, food: FOOD, fun: FUN, housing: HOUSING,
  });
  broadcast({ t: 'join', p: pub(o.p) }, id);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    const now = Date.now();

    if (m.t === 'move') {
      if (now - o.lastMove < 40) return; // ~25/s max
      o.lastMove = now;
      o.p.x = clamp(Number(m.x) || 0, 20, WORLD.w - 20);
      o.p.y = clamp(Number(m.y) || 0, 20, WORLD.h - 20);
      o.p.d = Number(m.d) || 0;
      broadcast({ t: 'mv', id, x: Math.round(o.p.x), y: Math.round(o.p.y), d: o.p.d }, id);
    }
    else if (m.t === 'chat') {
      if (now - o.lastChat < 1200) return send(o, { t: 'err', text: 'Slow down on the chat.' });
      o.lastChat = now;
      const text = clean(m.text);
      if (!text) return;
      const entry = { name: o.p.username, text, ts: now };
      chatMemory.push(entry);
      if (chatMemory.length > 60) chatMemory = chatMemory.slice(-60);
      q.chat.run(o.p.username, text, now);
      broadcast({ t: 'chat', id, ...entry });
    }
    else if (m.t === 'act') {
      doAct(o, m);
    }
  });

  ws.on('close', () => {
    if (online.get(id) === o) {
      online.delete(id);
      persist(o);
      broadcast({ t: 'leave', id });
      console.log(`[-] ${o.p.username} left (${online.size} online)`);
    }
  });
});

// ---------------- Game loop ----------------
setInterval(() => {
  // Day rollover
  if (Date.now() - dayStart >= DAY_MS) {
    day++;
    dayStart = Date.now();
    for (const o of online.values()) chargeRent(o);
    broadcast({ t: 'day', day, endsIn: DAY_MS });
    console.log(`[day] Day ${day} — ${online.size} online`);
  }
}, 1000);

// Slow stat decay (every 60s)
setInterval(() => {
  for (const o of online.values()) {
    const p = o.p;
    p.hunger = clamp(p.hunger - 3, 0, 100);
    if (p.hunger <= 0) {
      p.energy = clamp(p.energy - 5, 0, 100);
      p.happy = clamp(p.happy - 5, 0, 100);
    }
    persist(o);
    pushYou(o);
  }
}, 60000);

// Periodic position save
setInterval(() => { for (const o of online.values()) persist(o); }, SAVE_MS);

server.listen(PORT, () => {
  console.log(`🌆 Benin Life server live on port ${PORT} — Day ${day}`);
});
