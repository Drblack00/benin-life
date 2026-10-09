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
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chatlog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
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
  created_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS chatlog (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  ts BIGINT NOT NULL
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
    console.log('[db] PostgreSQL connected');
  } else {
    sdb = new DatabaseSync(path.join(__dirname, 'benin-life.db'));
    sdb.exec(SQLITE_SCHEMA);
    await ensureColumn('lat', 'REAL NOT NULL DEFAULT 6.3345', '');
    await ensureColumn('lng', 'REAL NOT NULL DEFAULT 5.6040', '');
    await ensureColumn('is_admin', 'INTEGER NOT NULL DEFAULT 0', '');
    await ensureColumn('banned', 'INTEGER NOT NULL DEFAULT 0', '');
    console.log('[db] SQLite connected (local)');
  }
}

// ---------- domain operations ----------
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
      `INSERT INTO players (username, pass_hash, cash, energy, hunger, happy, housing, cert, lat, lng, misses, is_admin, banned, created_at, last_seen)
       VALUES ($1,$2,10000,100,100,80,'face-me',0,6.3345,5.6040,0,$3,0,$4,$5) RETURNING id`,
      [username, hash, admin, now, now]);
    return r.rows[0].id;
  }
  const r = sdb.prepare(
    `INSERT INTO players (username, pass_hash, cash, energy, hunger, happy, housing, cert, lat, lng, misses, is_admin, banned, created_at, last_seen)
     VALUES (?, ?, 10000, 100, 100, 80, 'face-me', 0, 6.3345, 5.6040, 0, ?, 0, ?, ?)`)
    .run(username, hash, admin, now, now);
  return Number(r.lastInsertRowid);
}

export async function savePlayer(p) {
  const params = [p.cash, p.energy, p.hunger, p.happy, p.housing, p.cert, p.lat, p.lng, p.misses, p.is_admin, p.banned, Date.now(), p.id];
  await runQ(
    'UPDATE players SET cash=?, energy=?, hunger=?, happy=?, housing=?, cert=?, lat=?, lng=?, misses=?, is_admin=?, banned=?, last_seen=? WHERE id=?',
    'UPDATE players SET cash=$1, energy=$2, hunger=$3, happy=$4, housing=$5, cert=$6, lat=$7, lng=$8, misses=$9, is_admin=$10, banned=$11, last_seen=$12 WHERE id=$13',
    params);
}

// Gameplay-only save: never touches is_admin / banned, so a stale
// in-memory session can never clobber an admin ban or promotion.
export async function saveGame(p) {
  const params = [p.cash, p.energy, p.hunger, p.happy, p.housing, p.cert, p.lat, p.lng, p.misses, Date.now(), p.id];
  await runQ(
    'UPDATE players SET cash=?, energy=?, hunger=?, happy=?, housing=?, cert=?, lat=?, lng=?, misses=?, last_seen=? WHERE id=?',
    'UPDATE players SET cash=$1, energy=$2, hunger=$3, happy=$4, housing=$5, cert=$6, lat=$7, lng=$8, misses=$9, last_seen=$10 WHERE id=$11',
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
    'SELECT id, username, cash, energy, hunger, happy, housing, cert, lat, lng, misses, is_admin, banned, created_at, last_seen FROM players ORDER BY last_seen DESC LIMIT 500',
    'SELECT id, username, cash, energy, hunger, happy, housing, cert, lat, lng, misses, is_admin, banned, created_at, last_seen FROM players ORDER BY last_seen DESC LIMIT 500',
    []);
}

export async function setBanned(id, banned) {
  await runQ('UPDATE players SET banned=? WHERE id=?', 'UPDATE players SET banned=$1 WHERE id=$2', [banned ? 1 : 0, id]);
}

export async function setAdmin(id, isAdmin) {
  await runQ('UPDATE players SET is_admin=? WHERE id=?', 'UPDATE players SET is_admin=$1 WHERE id=$2', [isAdmin ? 1 : 0, id]);
}

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
