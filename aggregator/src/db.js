/*
 * Copyright 2026 hotBrief contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

let db = null;

/**
 * Open (or return cached) SQLite handle. Schema is idempotent.
 */
export function getDb(dataDir = './data') {
  if (db) return db;

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const file = path.join(dataDir, 'aggregator.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT NOT NULL,
      title       TEXT NOT NULL,
      url         TEXT NOT NULL,
      hot         INTEGER DEFAULT 0,
      fetched_at  INTEGER NOT NULL,
      UNIQUE(source, title) ON CONFLICT REPLACE
    );

    CREATE INDEX IF NOT EXISTS idx_items_fetched ON items(fetched_at);
    CREATE INDEX IF NOT EXISTS idx_items_source  ON items(source);

    CREATE TABLE IF NOT EXISTS pushed (
      key        TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      pushed_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pushed_at ON pushed(pushed_at);
  `);

  return db;
}

export function insertItems(items) {
  const conn = getDb();
  const stmt = conn.prepare(
    `INSERT OR REPLACE INTO items (source, title, url, hot, fetched_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  const tx = conn.transaction((rows) => {
    for (const r of rows) stmt.run(r.source, r.title, r.url, r.hot ?? 0, r.fetched_at ?? now);
  });
  tx(items);
}

/**
 * Fetch items inserted within the last `windowMin` minutes.
 */
export function recentItems(windowMin = 240) {
  const since = Date.now() - windowMin * 60 * 1000;
  return getDb()
    .prepare(`SELECT source, title, url, hot, fetched_at FROM items WHERE fetched_at >= ? ORDER BY fetched_at DESC`)
    .all(since);
}

export function recordPush(key, kind) {
  getDb()
    .prepare(`INSERT OR REPLACE INTO pushed (key, kind, pushed_at) VALUES (?, ?, ?)`)
    .run(key, kind, Date.now());
}

/**
 * True if `key` was pushed within the last `hours` hours.
 */
export function wasPushedRecently(key, hours) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  const row = getDb()
    .prepare(`SELECT pushed_at FROM pushed WHERE key = ? AND pushed_at >= ?`)
    .get(key, since);
  return Boolean(row);
}

/**
 * Drop items and pushed entries older than `hours`.
 * Called periodically to keep the DB compact.
 */
export function pruneOld(hours = 72) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  getDb().prepare(`DELETE FROM items  WHERE fetched_at < ?`).run(cutoff);
  getDb().prepare(`DELETE FROM pushed WHERE pushed_at  < ?`).run(cutoff);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
