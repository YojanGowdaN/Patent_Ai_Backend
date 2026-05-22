'use strict';

/**
 * Database adapter — automatically picks the right engine:
 *   DATABASE_URL set  →  PostgreSQL  (Replit / production)
 *   DATABASE_URL not set  →  SQLite file  (local VS Code dev, no install needed)
 *
 * Both expose the same async query(sql, params) → { rows } interface.
 */

const USE_PG = !!process.env.DATABASE_URL;

// ─── PostgreSQL path ────────────────────────────────────────────────────────
if (USE_PG) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', (err) => console.error('[DB] PG pool error:', err.message));

  async function initSchema() {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'applicant',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS patents (
          id SERIAL PRIMARY KEY,
          patent_id TEXT UNIQUE NOT NULL,
          applicant_name TEXT NOT NULL,
          inventor_name TEXT,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          technical_domain TEXT NOT NULL,
          claims TEXT,
          status TEXT NOT NULL DEFAULT 'Submitted',
          novelty_score NUMERIC,
          patent_strength_score NUMERIC,
          formality_score NUMERIC,
          ai_report JSONB,
          similarity_risk BOOLEAN DEFAULT FALSE,
          filing_date TIMESTAMPTZ DEFAULT NOW(),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS activity (
          id SERIAL PRIMARY KEY,
          patent_id TEXT,
          patent_title TEXT,
          action TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS trademarks (
          id SERIAL PRIMARY KEY,
          trademark_name TEXT NOT NULL,
          owner TEXT NOT NULL,
          category TEXT NOT NULL,
          goods_services_class TEXT,
          status TEXT NOT NULL DEFAULT 'Active',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      console.log('[DB] PostgreSQL schema ready');
    } catch (err) {
      console.error('[DB] Schema init error:', err.message);
    } finally {
      client.release();
    }
  }

  initSchema();
  module.exports = { query: (sql, params = []) => pool.query(sql, params) };

// ─── SQLite path (local dev — no install required) ──────────────────────────
} else {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    console.error('[DB] ERROR: better-sqlite3 is not installed.');
    console.error('[DB] Run:  npm install  inside the backend folder, then restart.');
    process.exit(1);
  }
  const path = require('path');

  const dbFile = path.join(__dirname, '..', 'patentai.sqlite');
  const sqlite = new Database(dbFile);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Create tables
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'applicant',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS patents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patent_id TEXT UNIQUE NOT NULL,
      applicant_name TEXT NOT NULL,
      inventor_name TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      technical_domain TEXT NOT NULL,
      claims TEXT,
      status TEXT NOT NULL DEFAULT 'Submitted',
      novelty_score REAL,
      patent_strength_score REAL,
      formality_score REAL,
      ai_report TEXT,
      similarity_risk INTEGER DEFAULT 0,
      filing_date TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patent_id TEXT,
      patent_title TEXT,
      action TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS trademarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trademark_name TEXT NOT NULL,
      owner TEXT NOT NULL,
      category TEXT NOT NULL,
      goods_services_class TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  console.log('[DB] SQLite ready →', dbFile);

  // ── SQL translation: PostgreSQL syntax → SQLite ──────────────────────────
  function adaptSql(sql) {
    return sql
      .replace(/\$(\d+)/g, '?')                                       // $1 → ?
      .replace(/ILIKE/gi, 'LIKE')                                     // case-insensitive LIKE
      .replace(/NOW\s*\(\s*\)/gi, "datetime('now')")                  // NOW() → datetime('now')
      .replace(/EXTRACT\s*\(\s*YEAR\s+FROM\s+(\w+)\s*\)/gi,          // EXTRACT(YEAR FROM col)
               "CAST(strftime('%Y', $1) AS INTEGER)")
      .replace(/similarity_risk\s*=\s*TRUE/gi,  'similarity_risk = 1') // boolean literals
      .replace(/similarity_risk\s*=\s*FALSE/gi, 'similarity_risk = 0')
      .replace(/::text/gi, '')                                         // PG casts
      .replace(/::integer/gi, '');
  }

  function adaptParams(params) {
    return params.map(p => {
      if (p === true)  return 1;
      if (p === false) return 0;
      return p;
    });
  }

  // Deserialise a SQLite row back to JS-friendly types
  function convertRow(row) {
    if (!row) return row;
    const r = { ...row };
    // boolean
    if ('similarity_risk' in r) r.similarity_risk = r.similarity_risk === 1;
    // JSON blob
    if ('ai_report' in r && typeof r.ai_report === 'string' && r.ai_report) {
      try { r.ai_report = JSON.parse(r.ai_report); } catch { /* leave as string */ }
    }
    return r;
  }

  // Extract table name from INSERT INTO <table> or UPDATE <table>
  function tableFrom(sql) {
    const m = sql.match(/(?:INSERT\s+INTO|UPDATE)\s+(\w+)/i);
    return m ? m[1] : null;
  }

  // Strip RETURNING clause and return the column list (unused but parsed)
  function stripReturning(sql) {
    const match = sql.match(/\s+RETURNING\s+([\s\S]+)$/i);
    const hasReturning = !!match;
    const cleaned = sql.replace(/\s+RETURNING\s+[\s\S]+$/i, '');
    return { cleaned, hasReturning };
  }

  async function query(sql, params = []) {
    const adapted = adaptSql(sql);
    const p = adaptParams(params);
    const { cleaned, hasReturning } = stripReturning(adapted);
    const upper = cleaned.trim().toUpperCase();

    // SELECT
    if (upper.startsWith('SELECT')) {
      const rows = sqlite.prepare(cleaned).all(...p).map(convertRow);
      return { rows };
    }

    // INSERT / UPDATE / DELETE
    const info = sqlite.prepare(cleaned).run(...p);

    if (!hasReturning) {
      return { rows: [], rowCount: info.changes };
    }

    // Re-fetch the affected row(s) after write
    const table = tableFrom(cleaned);
    if (!table) return { rows: [] };

    if (upper.startsWith('INSERT')) {
      const row = sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
      return { rows: row ? [convertRow(row)] : [] };
    }

    if (upper.startsWith('UPDATE')) {
      // All our UPDATE statements use WHERE id = $1, so params[0] is the id
      const row = sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(p[0]);
      return { rows: row ? [convertRow(row)] : [] };
    }

    return { rows: [] };
  }

  module.exports = { query };
}
