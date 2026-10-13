/**
 * 朝の全レース予想：その日の全レースの単勝オッズを更新し、答え合わせ用に既定の配分での予想を記録する（サーバーを起動せずに実行）
 *
 * 実行: npm run odds:morning
 * 定期実行: 毎日 9:30 に launchd から起動する。開催がない日は何もせずに終わる
 * - 出馬表は夜間ジョブ（1時）で当日分を取り込み済みの前提（未取り込みなら記録しない）
 * - 発走時刻を過ぎたレースは記録しない（ReviewService.record の確認による）
 * - 重賞は12時の処理（odds:noon）で昼のオッズの予想に上書きされる
 */

import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { NetkeibaSource } from '../sources/netkeiba';
import { PoliteFetcher } from '../sources/fetcher';
import { JraCalendar } from '../sources/jra-calendar';
import { BatchService } from '../services/batch-service';
import { ScoreService } from '../services/score-service';
import { ReviewService } from '../services/review-service';

// ローカル時間の今日を YYYY-MM-DD で返す
function todayString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main(): Promise<void> {
  const date = todayString();
  console.log(`[Morning] start ${new Date().toISOString()} (date=${date})`);

  const db = openDatabase();
  try {
    const repo = new RaceRepository(db);
    const raceKeys = repo.listRaceKeysOnDate(date);
    if (raceKeys.length === 0) {
      console.log('[Morning] 本日の出馬表はありません（開催なし、または夜間ジョブで未取り込み）。何もせずに終わります');
      return;
    }

    const fetcher = new PoliteFetcher({
      onLog: (entry) => repo.logFetch(entry),
    });
    const source = new NetkeibaSource(fetcher);
    const batchService = new BatchService(new JraCalendar(), source, repo);

    const result = await batchService.refreshAllRaceOdds(date);
    console.log(`[Morning] odds: total=${result.total} success=${result.success} failure=${result.failure}`);

    // 答え合わせ用に、既定の配分での予想（印・買い目）を全レース記録する
    const review = new ReviewService(repo, new ScoreService(repo), source);
    let recorded = 0;
    const skipped: string[] = [];
    for (const raceKey of raceKeys) {
      try {
        review.recordAuto(raceKey);
        recorded++;
      } catch (err: any) {
        skipped.push(`${raceKey}: ${err?.message ?? err}`);
      }
    }
    console.log(`[Review] 予想を記録 ${recorded}/${raceKeys.length}レース`);
    for (const s of skipped) console.log(`[Review] 記録なし ${s}`);
    process.exitCode = result.failure > 0 ? 1 : 0;
  } catch (err: any) {
    console.error('[Morning] fatal:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    db.close();
    console.log(`[Morning] end ${new Date().toISOString()}`);
  }
}

main();
