// SQLite (módulo nativo node:sqlite, sin dependencias compiladas).
// La usan dos procesos (app y worker), por eso WAL + busy_timeout.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { settings } from './settings.js';

let db;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(settings.dataDir, { recursive: true });
  db = new DatabaseSync(path.join(settings.dataDir, 'news.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;

    -- Solo titular, medio, link, fecha y (opcional) bajada recortada del RSS.
    CREATE TABLE IF NOT EXISTS news (
      id           INTEGER PRIMARY KEY,
      feed_id      TEXT    NOT NULL,
      source       TEXT    NOT NULL,
      title        TEXT    NOT NULL,
      title_key    TEXT    NOT NULL,
      link         TEXT    NOT NULL UNIQUE,
      summary      TEXT,
      published_at INTEGER NOT NULL,
      fetched_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS news_published ON news(published_at DESC);
    CREATE INDEX IF NOT EXISTS news_title_key ON news(title_key);

    CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dolar_hist (
      casa  TEXT    NOT NULL,
      venta REAL    NOT NULL,
      ts    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dolar_hist_casa_ts ON dolar_hist(casa, ts);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function kvGet(key) {
  const row = getDb().prepare('SELECT value, updated_at FROM kv WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value), updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

export function kvSet(key, value) {
  getDb()
    .prepare(
      `INSERT INTO kv(key, value, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), Date.now());
}
