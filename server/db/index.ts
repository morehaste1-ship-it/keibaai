import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { MIGRATIONS } from './migrations';

export type DB = Database.Database;

/** 既定の保存先。環境変数 KEIBA_DB_PATH で変更可能 */
export const DEFAULT_DB_PATH = process.env.KEIBA_DB_PATH || path.resolve(process.cwd(), 'data', 'keiba.sqlite');

/**
 * データベースを開き、未適用のマイグレーションを実行して返す。
 * @param dbPath ':memory:' を渡すとメモリ上に作成（テスト用）
 */
export function openDatabase(dbPath: string = DEFAULT_DB_PATH): DB {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    );
  `);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);

  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    })();
  }
}
