// ============================================================
// db.js — database adapter for Benin Life
// Uses PostgreSQL when DATABASE_URL is set (production),
// otherwise local SQLite (node:sqlite, zero dependencies).
// All operations are async with an identical API.
// ============================================================
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pool = null; // pg Pool (production or injected test pool)
let sdb = null;  // sqlite db (local dev)

// Test hook: inject a pg-compatible pool (pg-mem). Not used in prod.
export function _injectPool(p) { pool = p; }

export function dbMode() { return pool ? 'postgres' : 'sqlite'; }

const SQLITE_SCHEMA = `
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
  lat REAL NOT NULL DEFAULT 6.3345,
  lng REAL NOT NULL DEFAULT 5.6040,
  misses INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  vehicle TEXT NOT NULL DEFAULT 'none',
  savings INTEGER NOT NULL DEFAULT 0,
  loan INTEGER NOT NULL DEFAULT 0,
  dm_read_ts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chatlog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER UNIQUE NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS elections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_day INTEGER NOT NULL,
  end_day INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'voting',
  winner_id INTEGER
);
CREATE TABLE IF NOT EXISTS candidates (
  election_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  UNIQUE(election_id, player_id)
);
CREATE TABLE IF NOT EXISTS votes (
  election_id INTEGER NOT NULL,
  voter_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  UNIQUE(election_id, voter_id)
);
CREATE TABLE IF NOT EXISTS dms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  cash INTEGER NOT NULL DEFAULT 10000,
  energy INTEGER NOT NULL DEFAULT 100,
  hunger INTEGER NOT NULL DEFAULT 100,
  happy INTEGER NOT NULL DEFAULT 80,
  housing TEXT NOT NULL DEFAULT 'face-me',
  cert INTEGER NOT NULL DEFAULT 0,
  lat DOUBLE PRECISION NOT NULL DEFAULT 6.3345,
  lng DOUBLE PRECISION NOT NULL DEFAULT 5.6040,
  misses INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  vehicle TEXT NOT NULL DEFAULT 'none',
  savings INTEGER NOT NULL DEFAULT 0,
  loan INTEGER NOT NULL DEFAULT 0,
  dm_read_ts BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS chatlog (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  ts BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS businesses (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER UNIQUE NOT NULL,
  type TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS elections (
  id SERIAL PRIMARY KEY,
  start_day INTEGER NOT NULL,
  end_day INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'voting',
  winner_id INTEGER
);
CREATE TABLE IF NOT EXISTS candidates (
  election_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  UNIQUE(election_id, player_id)
);
CREATE TABLE IF NOT EXISTS votes (
  election_id INTEGER NOT NULL,
  voter_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  UNIQUE(election_id, voter_id)
);
CREATE TABLE IF NOT EXISTS dms (
  id SERIAL PRIMARY KEY,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  ts BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;

// ---------- low-level helpers (same API, both backends) ----------
async function runQ(sqliteSql, pgSql, params) {
  if (pool) { await pool.query(pgSql, params); return; }
  sdb.prepare(sqliteSql).run(...params);
}
async function getOne(sqliteSql, pgSql, params) {
  if (pool) { const r = await pool.query(pgSql, params); return r.rows[0] || null; }
  return sdb.prepare(sqliteSql).get(...params) || null;
}
async function getAll(sqliteSql, pgSql, params) {
  if (pool) { const r = await pool.query(pgSql, params); return r.rows; }
  return sdb.prepare(sqliteSql).all(...params);
}

// Add a column if missing (for upgrading existing databases)
async function ensureColumn(col, sqliteDef, pgDef) {
  try {
    await runQ(
      `ALTER TABLE players ADD COLUMN ${col} ${sqliteDef}`,
      `ALTER TABLE players ADD COLUMN ${col} ${pgDef}`,
      []);
  } catch (e) {
    if (/duplicate|already exists/i.test(e.message)) return; // already there
    throw e;
  }
}

export async function initDb() {
  if (pool || process.env.DATABASE_URL) {
    if (!pool) {
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 5,
      });
    }
    await pool.query(PG_SCHEMA);
    await ensureColumn('lat', 'REAL NOT NULL DEFAULT 6.3345', 'DOUBLE PRECISION NOT NULL DEFAULT 6.3345');
    await ensureColumn('lng', 'REAL NOT NULL DEFAULT 5.6040', 'DOUBLE PRECISION NOT NULL DEFAULT 5.6040');
    await ensureColumn('is_admin', 'INTEGER NOT NULL DEFAULT 0', 'INTEGER NOT NULL DEFAULT 0');
    await ensureColumn('banned', 'INTEGER NOT NULL DEFAULT 0', 'INTEGER NOT NULL DEFAULT 0');
    await ensureColumn('vehicle', "TEXT NOT NULL DEFAULT 'none'", "TEXT NOT NULL DEFAULT 'none'");
    await ensureColumn('savings', 'INTEGER NOT NULL DEFAULT 0', 'INTEGER NOT NULL DEFAULT 0');
    await ensureColumn('loan', 'INTEGER NOT NULL DEFAULT 0', 'INTEGER NOT NULL DEFAULT 0');
    await ensureColumn('dm_read_ts', 'INTEGER NOT NULL DEFAULT 0', 'BIGINT NOT NULL DEFAULT 0');
    console.log('[db] PostgreSQL connected');
  } else {
    sdb = new DatabaseSync(path.join(__dirname, 'benin-life.db'));
    sdb.exec(SQLITE_SCHEMA);
    await ensureColumn('lat', 'REAL NOT NULL DEFAULT 6.3345', '');
    await ensureColumn('lng', 'REAL NOT NULL DEFAULT 5.6040', '');
    await ensureColumn('is_admin', 'INTEGER NOT NULL DEFAULT 0', '');
    await ensureColumn('banned', 'INTEGER NOT NULL DEFAULT 0', '');
    await ensureColumn('vehicle', "TEXT NOT NULL DEFAULT 'none'", '');
    await ensureColumn('savings', 'INTEGER NOT NULL DEFAULT 0', '');
    await ensureColumn('loan', 'INTEGER NOT NULL DEFAULT 0', '');
    await ensureColumn('dm_read_ts', 'INTEGER NOT NULL DEFAULT 0', '');
    console.log('[db] SQLite connected (local)');
  }
}

// ---------- players ----------
export async function getPlayerByName(username) {
  return getOne(
    'SELECT * FROM players WHERE username = ?',
    'SELECT * FROM players WHERE username = $1',
    [username]);
}

export async function getPlayerById(id) {
  return getOne(
    'SELECT * FROM players WHERE id = ?',
    'SELECT * FROM players WHERE id = $1',
    [id]);
}

export async function createPlayer(username, hash, now, isAdmin) {
  const admin = isAdmin ? 1 : 0;
  if (pool) {
    const r = await pool.query(
      `INSERT INTO players (username, pass_hash, cash, energy, hunger, happy, housing, cert, lat, lng, misses, is_admin, banned, vehicle, savings, loan, dm_read_ts, created_at, last_seen)
       VALUES ($1,$2,10000,100,100,80,'face-me',0,6.3345,5.6040,0,$3,0,'none',0,0,0,$4,$5) RETURNING id`,
      [username, hash, admin, now, now]);
    return r.rows[0].id;
  }
  const r = sdb.prepare(
    `INSERT INTO players (username, pass_hash, cash, energy, hunger, happy, housing, cert, lat, lng, misses, is_admin, banned, vehicle, savings, loan, dm_read_ts, created_at, last_seen)
     VALUES (?, ?, 10000, 100, 100, 80, 'face-me', 0, 6.3345, 5.6040, 0, ?, 0, 'none', 0, 0, 0, ?, ?)`)
    .run(username, hash, admin, now, now);
  return Number(r.lastInsertRowid);
}

// Gameplay-only save: never touches is_admin / banned, so a stale
// in-memory session can never clobber an admin ban or promotion.
export async function saveGame(p) {
  const params = [p.cash, p.energy, p.hunger, p.happy, p.housing, p.cert, p.lat, p.lng, p.misses, p.vehicle, p.savings, p.loan, p.dm_read_ts, Date.now(), p.id];
  await runQ(
    'UPDATE players SET cash=?, energy=?, hunger=?, happy=?, housing=?, cert=?, lat=?, lng=?, misses=?, vehicle=?, savings=?, loan=?, dm_read_ts=?, last_seen=? WHERE id=?',
    'UPDATE players SET cash=$1, energy=$2, hunger=$3, happy=$4, housing=$5, cert=$6, lat=$7, lng=$8, misses=$9, vehicle=$10, savings=$11, loan=$12, dm_read_ts=$13, last_seen=$14 WHERE id=$15',
    params);
}

export async function countAdmins() {
  const r = await getOne(
    'SELECT COUNT(*) AS c FROM players WHERE is_admin = 1',
    'SELECT COUNT(*) AS c FROM players WHERE is_admin = 1',
    []);
  return Number(r.c);
}

export async function listPlayers() {
  return getAll(
    'SELECT id, username, cash, energy, hunger, happy, housing, cert, lat, lng, misses, is_admin, banned, vehicle, savings, loan, created_at, last_seen FROM players ORDER BY last_seen DESC LIMIT 500',
    'SELECT id, username, cash, energy, hunger, happy, housing, cert, lat, lng, misses, is_admin, banned, vehicle, savings, loan, created_at, last_seen FROM players ORDER BY last_seen DESC LIMIT 500',
    []);
}

export async function setBanned(id, banned) {
  await runQ('UPDATE players SET banned=? WHERE id=?', 'UPDATE players SET banned=$1 WHERE id=$2', [banned ? 1 : 0, id]);
}

export async function setAdmin(id, isAdmin) {
  await runQ('UPDATE players SET is_admin=? WHERE id=?', 'UPDATE players SET is_admin=$1 WHERE id=$2', [isAdmin ? 1 : 0, id]);
}

// ---------- chat ----------
export async function addChat(username, text, ts) {
  await runQ(
    'INSERT INTO chatlog (username, text, ts) VALUES (?,?,?)',
    'INSERT INTO chatlog (username, text, ts) VALUES ($1,$2,$3)',
    [username, text, ts]);
}

export async function recentChat(limit = 40) {
  const rows = await getAll(
    'SELECT username, text, ts FROM chatlog ORDER BY id DESC LIMIT ?',
    'SELECT username, text, ts FROM chatlog ORDER BY id DESC LIMIT $1',
    [limit]);
  return rows.reverse();
}

// ---------- businesses ----------
export async function getBusiness(ownerId) {
  return getOne(
    'SELECT * FROM businesses WHERE owner_id = ?',
    'SELECT * FROM businesses WHERE owner_id = $1',
    [ownerId]);
}

export async function createBusiness(ownerId, type, now) {
  await runQ(
    'INSERT INTO businesses (owner_id, type, created_at) VALUES (?,?,?)',
    'INSERT INTO businesses (owner_id, type, created_at) VALUES ($1,$2,$3)',
    [ownerId, type, now]);
}

export async function listBusinesses() {
  return getAll(
    'SELECT b.*, p.username FROM businesses b JOIN players p ON p.id = b.owner_id',
    'SELECT b.*, p.username FROM businesses b JOIN players p ON p.id = b.owner_id',
    []);
}

// ---------- elections ----------
export async function currentElection() {
  return getOne(
    "SELECT * FROM elections WHERE status = 'voting' ORDER BY id DESC LIMIT 1",
    "SELECT * FROM elections WHERE status = 'voting' ORDER BY id DESC LIMIT 1",
    []);
}

export async function createElection(startDay, endDay) {
  if (pool) {
    const r = await pool.query(
      "INSERT INTO elections (start_day, end_day, status) VALUES ($1,$2,'voting') RETURNING *",
      [startDay, endDay]);
    return r.rows[0];
  }
  const r = sdb.prepare("INSERT INTO elections (start_day, end_day, status) VALUES (?,?,'voting')").run(startDay, endDay);
  return getOne('SELECT * FROM elections WHERE id = ?', 'SELECT * FROM elections WHERE id = $1', [Number(r.lastInsertRowid)]);
}

export async function closeElection(id, winnerId) {
  await runQ(
    "UPDATE elections SET status='done', winner_id=? WHERE id=?",
    "UPDATE elections SET status='done', winner_id=$1 WHERE id=$2",
    [winnerId, id]);
}

export async function lastWinner() {
  return getOne(
    "SELECT e.*, p.username AS winner_name FROM elections e LEFT JOIN players p ON p.id = e.winner_id WHERE e.status='done' ORDER BY e.id DESC LIMIT 1",
    "SELECT e.*, p.username AS winner_name FROM elections e LEFT JOIN players p ON p.id = e.winner_id WHERE e.status='done' ORDER BY e.id DESC LIMIT 1",
    []);
}

export async function addCandidate(electionId, playerId) {
  try {
    await runQ(
      'INSERT INTO candidates (election_id, player_id) VALUES (?,?)',
      'INSERT INTO candidates (election_id, player_id) VALUES ($1,$2)',
      [electionId, playerId]);
    return true;
  } catch (e) { return false; } // already running
}

export async function listCandidates(electionId) {
  return getAll(
    `SELECT c.player_id, p.username, COUNT(v.voter_id) AS votes
     FROM candidates c JOIN players p ON p.id = c.player_id
     LEFT JOIN votes v ON v.election_id = c.election_id AND v.candidate_id = c.player_id
     WHERE c.election_id = ? GROUP BY c.player_id, p.username ORDER BY votes DESC`,
    `SELECT c.player_id, p.username, COUNT(v.voter_id)::int AS votes
     FROM candidates c JOIN players p ON p.id = c.player_id
     LEFT JOIN votes v ON v.election_id = c.election_id AND v.candidate_id = c.player_id
     WHERE c.election_id = $1 GROUP BY c.player_id, p.username ORDER BY votes DESC`,
    [electionId]);
}

export async function hasVoted(electionId, voterId) {
  const r = await getOne(
    'SELECT 1 AS x FROM votes WHERE election_id = ? AND voter_id = ?',
    'SELECT 1 AS x FROM votes WHERE election_id = $1 AND voter_id = $2',
    [electionId, voterId]);
  return !!r;
}

export async function castVote(electionId, voterId, candidateId) {
  try {
    await runQ(
      'INSERT INTO votes (election_id, voter_id, candidate_id) VALUES (?,?,?)',
      'INSERT INTO votes (election_id, voter_id, candidate_id) VALUES ($1,$2,$3)',
      [electionId, voterId, candidateId]);
    return true;
  } catch (e) { return false; } // already voted
}

export async function topCandidate(electionId) {
  const rows = await listCandidates(electionId);
  return rows[0] || null;
}

// ---------- DMs ----------
export async function addDm(fromId, toId, text, ts) {
  await runQ(
    'INSERT INTO dms (from_id, to_id, text, ts) VALUES (?,?,?,?)',
    'INSERT INTO dms (from_id, to_id, text, ts) VALUES ($1,$2,$3,$4)',
    [fromId, toId, text, ts]);
}

export async function dmThreads(playerId) {
  // conversation partners, newest first (portable across SQLite + Postgres)
  const partners = await getAll(
    'SELECT DISTINCT CASE WHEN from_id=? THEN to_id ELSE from_id END AS pid FROM dms WHERE from_id=? OR to_id=?',
    'SELECT DISTINCT CASE WHEN from_id=$1 THEN to_id ELSE from_id END AS pid FROM dms WHERE from_id=$1 OR to_id=$1',
    [playerId, playerId, playerId]);
  const out = [];
  for (const row of partners) {
    const pid = Number(row.pid);
    const other = await getPlayerById(pid);
    if (!other) continue;
    const last = await getOne(
      'SELECT text, ts FROM dms WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY id DESC LIMIT 1',
      'SELECT text, ts FROM dms WHERE (from_id=$1 AND to_id=$2) OR (from_id=$3 AND to_id=$4) ORDER BY id DESC LIMIT 1',
      [playerId, pid, pid, playerId]);
    const unread = await getOne(
      'SELECT COUNT(*) AS c FROM dms WHERE to_id=? AND from_id=? AND ts > (SELECT dm_read_ts FROM players WHERE id=?)',
      'SELECT COUNT(*) AS c FROM dms WHERE to_id=$1 AND from_id=$2 AND ts > (SELECT dm_read_ts FROM players WHERE id=$3)',
      [playerId, pid, playerId]);
    out.push({
      pid, username: other.username,
      last_text: (last && last.text) || '', last_ts: Number((last && last.ts) || 0),
      unread: Number(unread.c),
    });
  }
  out.sort((a, b) => b.last_ts - a.last_ts);
  return out.slice(0, 30);
}

export async function dmHistory(a, b, limit = 50) {
  const rows = await getAll(
    'SELECT from_id, to_id, text, ts FROM dms WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY id ASC LIMIT ?',
    'SELECT from_id, to_id, text, ts FROM dms WHERE (from_id=$1 AND to_id=$2) OR (from_id=$3 AND to_id=$4) ORDER BY id ASC LIMIT $5',
    [a, b, b, a, limit]);
  return rows;
}

export async function unreadDmCount(playerId) {
  const r = await getOne(
    'SELECT COUNT(*) AS c FROM dms WHERE to_id=? AND ts > (SELECT dm_read_ts FROM players WHERE id=?)',
    'SELECT COUNT(*) AS c FROM dms WHERE to_id=$1 AND ts > (SELECT dm_read_ts FROM players WHERE id=$2)',
    [playerId, playerId]);
  return Number(r.c);
}

export async function markDmRead(playerId, ts) {
  await runQ('UPDATE players SET dm_read_ts=? WHERE id=?', 'UPDATE players SET dm_read_ts=$1 WHERE id=$2', [ts, playerId]);
}

// ---------- meta (visits, governor) ----------
export async function getMeta(key) {
  const r = await getOne('SELECT value FROM meta WHERE key=?', 'SELECT value FROM meta WHERE key=$1', [key]);
  return r ? r.value : null;
}

export async function setMeta(key, value) {
  if (pool) {
    await pool.query(
      'INSERT INTO meta (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
      [key, String(value)]);
  } else {
    sdb.prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  }
}

export async function bumpVisits() {
  const v = Number((await getMeta('visits')) || 0) + 1;
  await setMeta('visits', v);
  return v;
}
