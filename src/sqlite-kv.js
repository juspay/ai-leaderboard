import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';

/**
 * SQLite-backed KV adapter that matches the Cloudflare KV interface.
 * Uses a simple key-value table: kv_store(key TEXT PRIMARY KEY, value TEXT).
 * Drop-in replacement for env.LEADERBOARD_KV used throughout the codebase.
 *
 * Every method is synchronous. Callers still `await` them, which is harmless —
 * but it means an awaited get/put resolves on the microtask queue rather than
 * yielding to the event loop. Two concurrent /api/usage requests therefore
 * cannot interleave inside logUsage's read-modify-write, which is exactly the
 * clobbering that helpers.js:kvPut has a hand-rolled guard against.
 */
export function createSqliteKV(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  // WAL survives a SIGKILL mid-write; the default rollback journal is likelier
  // to leave a truncated database behind when the pod is evicted.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  // Prepared once, reused for the life of the process.
  let stmts = null;
  const prepare = () => (stmts ||= {
    get: db.prepare('SELECT value FROM kv_store WHERE key = ?'),
    put: db.prepare(
      'INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
    ),
    del: db.prepare('DELETE FROM kv_store WHERE key = ?'),
  });

  return {
    _db: db,

    get(key, type) {
      const row = prepare().get.get(key);
      if (!row) return null;
      return type === 'json' ? JSON.parse(row.value) : row.value;
    },

    put(key, val) {
      const text = typeof val === 'string' ? val : JSON.stringify(val);
      prepare().put.run(key, text);
    },

    delete(key) {
      prepare().del.run(key);
    },

    quit() {
      db.close();
    },
  };
}
