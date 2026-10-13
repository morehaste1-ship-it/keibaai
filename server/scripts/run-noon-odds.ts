/**
 * 重賞（G1・G2・G3）の単勝オッズを当日12:00の値で更新し、答え合わせ用に既定の配分での予想を記録する（サーバーを起動せずに実行）
 *
 * 実行: npm run odds:noon
 * 定期実行: 毎日 12:00 に launchd から起動する（祝日の開催にも対応。重賞が無い日は何もせずに終わる）
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
  console.log(`[NoonOdds] start ${new Date().toISOString()} (date=${date})`);

  const db = openDatabase();
  try {
    const repo = new RaceRepository(db);
    const fetcher = new PoliteFetcher({
      onLog: (entry) => repo.logFetch(entry),
    });
    const source = new NetkeibaSource(fetcher);
    const calendar = new JraCalendar();
    const batchService = new BatchService(calendar, source, repo);

    const result = await batchService.refreshGradeRaceOdds(date);

    console.log(`[NoonOdds] result: total=${result.total} success=${result.success} failure=${result.failure}`);
    process.exitCode = result.failure > 0 ? 1 : 0;

    // 答え合わせ用に、既定の配分での予想（印・3連単の買い目）を記録する
    const review = new ReviewService(repo, new ScoreService(repo), source);
    for (const raceKey of repo.listRaceKeysByGradeOnDate(date, ['GI', 'GII', 'GIII', 'G1', 'G2', 'G3'])) {
      try {
        const rec = review.recordAuto(raceKey);
        console.log(`[Review] 予想を記録 ${raceKey}（◎${rec.marks.find((m) => m.mark === '◎')?.horseNumber ?? '-'}）`);
      } catch (err: any) {
        console.error(`[Review] 記録できません ${raceKey}: ${err?.message ?? err}`);
      }
    }
  } catch (err: any) {
    console.error('[NoonOdds] fatal:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    db.close();
    console.log(`[NoonOdds] end ${new Date().toISOString()}`);
  }
}

main();
