/**
 * DB を手動でバックアップする（夜間実行でも毎回最初に自動で取る）
 *
 * 実行: npm run backup
 */
import { openDatabase } from '../db/index';
import { backupDatabase, uploadOffsite } from '../services/db-backup';

async function main(): Promise<void> {
  const db = openDatabase();
  try {
    const r = await backupDatabase(db);
    console.log(`[Backup] ${r.file}（${Math.round(r.bytes / 1024)}KB）`);
    if (r.removed.length > 0) console.log(`[Backup] 古いバックアップを削除: ${r.removed.join(', ')}`);
    const o = uploadOffsite(r.file);
    console.log(`[Backup] Google ドライブ: ${o.message}`);
  } catch (err: any) {
    console.error('[Backup] 失敗:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
