/**
 * 週末レース取得バッチ（サーバーを起動せずに実行）
 *
 * 実行: npm run batch
 * 定期実行: launchd（木曜 21:00）から起動される
 */

import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { NetkeibaSource } from '../sources/netkeiba';
import { PoliteFetcher } from '../sources/fetcher';
import { JraCalendar } from '../sources/jra-calendar';
import { BatchService } from '../services/batch-service';
import {
  JOCKEY_BATCH_ENABLED,
  DEFAULT_JOCKEY_PAGE_BUDGET,
  createDbFetcher,
  runHorseStage,
  runJockeyStage,
} from './jockey-stage';
import { acquireLock, readLock, releaseLock } from '../services/crawl-lock';

async function main(): Promise<void> {
  console.log(`[Batch] start ${new Date().toISOString()}`);
  if (!acquireLock('batch')) {
    console.log(`[Batch] ほかの取得が実行中のためスキップします（${readLock()?.owner ?? '不明'}）`);
    return;
  }

  const db = openDatabase();
  try {
    const repo = new RaceRepository(db);
    const fetcher = new PoliteFetcher({
      onLog: (entry) => repo.logFetch(entry),
    });
    const source = new NetkeibaSource(fetcher);
    const calendar = new JraCalendar();
    const batchService = new BatchService(calendar, source, repo);

    const status = await batchService.prepareWeekendRaces();

    console.log(
      `[Batch] result: total=${status.totalRaces} success=${status.successCount} failure=${status.failureCount}`,
    );
    for (const d of status.details) {
      if (d.status !== 'success') {
        console.log(`[Batch] NG ${d.raceId}: ${d.message}`);
      }
    }

    process.exitCode = status.failureCount > 0 ? 1 : 0;

    // 出馬表・オッズの後に、出走馬の過去走 → 騎乗騎手の成績（過去5年）の順に取得する。
    // 失敗しても出馬表の結果には影響させない。アクセス制限を受けたら騎手の取得は行わない
    try {
      const dbFetcher = createDbFetcher(repo);
      const horse = await runHorseStage(repo, dbFetcher);
      if (horse.rateLimited) {
        console.log('[Jockey] 馬の取得でアクセス制限を受けたため、騎手成績の取得は次回に回します');
      } else if (JOCKEY_BATCH_ENABLED) {
        await runJockeyStage(repo, DEFAULT_JOCKEY_PAGE_BUDGET, dbFetcher);
      } else {
        console.log('[Jockey] 木曜バッチでの騎手成績の取得は停止中です（仕様確認後に有効化）');
      }
    } catch (err: any) {
      console.error('[Jockey] stage failed:', err?.message ?? err);
    }
  } catch (err: any) {
    console.error('[Batch] fatal:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    db.close();
    releaseLock();
    console.log(`[Batch] end ${new Date().toISOString()}`);
  }
}

main();
