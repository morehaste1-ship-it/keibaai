/**
 * 騎手成績だけを取得する（手動実行用）
 *
 * 実行: npm run jockeys
 */
import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { acquireLock, readLock, releaseLock } from '../services/crawl-lock';
import { runJockeyStage } from './jockey-stage';

async function main(): Promise<void> {
  console.log(`[Jockey] script start ${new Date().toISOString()}`);
  if (!acquireLock('jockeys')) {
    console.log(`[Jockey] ほかの取得が実行中のためスキップします（${readLock()?.owner ?? '不明'}）`);
    return;
  }
  const db = openDatabase();
  try {
    await runJockeyStage(new RaceRepository(db));
  } catch (err: any) {
    console.error('[Jockey] fatal:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    db.close();
    releaseLock();
    console.log(`[Jockey] script end ${new Date().toISOString()}`);
  }
}

main();
