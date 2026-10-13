/**
 * 出走馬の過去走だけを取得する（手動実行用）
 *
 * 実行: npm run horses
 */
import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { acquireLock, readLock, releaseLock } from '../services/crawl-lock';
import { runHorseStage } from './jockey-stage';

async function main(): Promise<void> {
  console.log(`[Horse] script start ${new Date().toISOString()}`);
  if (!acquireLock('horses')) {
    console.log(`[Horse] ほかの取得が実行中のためスキップします（${readLock()?.owner ?? '不明'}）`);
    return;
  }
  const db = openDatabase();
  try {
    await runHorseStage(new RaceRepository(db));
  } catch (err: any) {
    console.error('[Horse] fatal:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    db.close();
    releaseLock();
    console.log(`[Horse] script end ${new Date().toISOString()}`);
  }
}

main();
