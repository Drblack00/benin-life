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
  x DOUBLE PRECISION NOT NULL DEFAULT 1000,
  y DOUBLE PRECISION NOT NULL DEFAULT 700,
  misses INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS chatlog (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  ts BIGINT NOT NULL
);`;

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
    console.log('[db] PostgreSQL connected');
  } else {
    sdb = new DatabaseSync(path.join(__dirname, 'benin-life.db'));
    sdb.exec(SQLITE_SCHEMA);
    console.log('[db] SQLite connected (local)');
  }
}

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

export async function createPlayer(username, hash, now) {
  if (pool) {
    const r = await pool.query(
      `INSERT INTO players (username, pass_hash, cash, energy, hunger, happy, housing, cert, x, y, misses, created_at, last_seen)
       VALUES ($1,$2,10000,100,100,80,'face-me',0,1000,700,0,$3,$4) RETURNING id`,
      [username, hash, now, now]);
    return r.rows[0].id;
  }
  const r = sdb.prepare(
    `INSERT INTO players (username, pass_hash, cash, energy, hunger, happy, housing, cert, x, y, misses, created_at, last_seen)
     VALUES (?, ?, 10000, 100, 100, 80, 'face-me', 0, 1000, 700, 0, ?, ?)`)
    .run(username, hash, now, now);
  return Number(r.lastInsertRowid);
}

export async function savePlayer(p) {
  const params = [p.cash, p.energy, p.hunger, p.happy, p.housing, p.cert, p.x, p.y, p.misses, Date.now(), p.id];
  await runQ(
    'UPDATE players SET cash=?, energy=?, hunger=?, happy=?, housing=?, cert=?, x=?, y=?, misses=?, last_seen=? WHERE id=?',
    'UPDATE players SET cash=$1, energy=$2, hunger=$3, happy=$4, housing=$5, cert=$6, x=$7, y=$8, misses=$9, last_seen=$10 WHERE id=$11',
    params);
}

export async function addChat(username, text, ts) {
  await runQ(
    'INSERT INTO chatlog (username, text, ts) VALUES (?,?,?)',
    'INSERT INTO chatlog (username, text, ts) VALUES ($1,$2,$3)',
    [username, text, ts]);
}

export async function recentChat() {
  const rows = await getAll(
    'SELECT username, text, ts FROM chatlog ORDER BY id DESC LIMIT 40',
    'SELECT username, text, ts FROM chatlog ORDER BY id DESC LIMIT 40',
    []);
  return rows.reverse();
}
