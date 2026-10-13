/**
 * 過去レースの取り込みと予想し直し（夜間ジョブ・手動スクリプト共通の段）
 */
import type { RaceRepository } from '../db/repository';
import { PoliteFetcher } from '../sources/fetcher';
import { NetkeibaSource } from '../sources/netkeiba';
import { JraCalendar } from '../sources/jra-calendar';
import { PastService, type PastRunOptions } from '../services/past-service';
import { ReviewService } from '../services/review-service';
import { ScoreService } from '../services/score-service';
import { createDbFetcher } from './jockey-stage';
import { diskShortage } from '../services/maintenance';

/** 予想し直し済みの過去レースを、今の計算で記録し直す（取得はしない） */
export function runPastRescore(repo: RaceRepository): void {
  const raceSource = new NetkeibaSource(new PoliteFetcher({ onLog: (entry) => repo.logFetch(entry) }));
  const review = new ReviewService(repo, new ScoreService(repo), raceSource);
  const service = new PastService(repo, new JraCalendar(), raceSource, raceSource, review);
  const started = Date.now();
  const r = service.rescore();
  console.log(`[Past] 計算し直し: ${r.done}/${r.total}レース（${Math.round((Date.now() - started) / 1000)}秒）`);
  for (const e of r.errors.slice(0, 30)) console.log(`[Past] NG ${e}`);
}

export async function runPastStage(repo: RaceRepository, opts: PastRunOptions = {}): Promise<{ rateLimited: boolean }> {
  const raceSource = new NetkeibaSource(new PoliteFetcher({ onLog: (entry) => repo.logFetch(entry) }));
  const dbSource = new NetkeibaSource(createDbFetcher(repo));
  const review = new ReviewService(repo, new ScoreService(repo), raceSource);
  const service = new PastService(repo, new JraCalendar(), raceSource, dbSource, review);
  console.log(
    `[Past] start（${opts.fromDate ?? '2021-01-01'} までさかのぼる・上限 出馬表/結果${opts.maxRacePages ?? 1500}ページ・馬${opts.maxHorsePages ?? 2000}ページ・血統${opts.maxPedigreePages ?? 600}ページ）`,
  );
  const shortage = diskShortage();
  if (shortage) {
    console.log(`[Past] 中止: ${shortage}`);
    return { rateLimited: false };
  }
  const r = await service.run({ ...opts, stopCheck: opts.stopCheck ?? (() => diskShortage()) });
  const s = repo.pastSummary();
  console.log(
    `[Past] done: 確認した日${r.datesChecked}・取り込み${r.racesImported}レース・失敗${r.racesFailed}・予想し直し${r.racesPredicted}レース／` +
      `出馬表・結果${r.racePages}ページ・馬${r.horsePages}ページ・血統${r.pedigreePages}ページ（${r.pedigreesFetched}頭）` +
      (r.stoppedReason ? ` / ${r.stoppedReason}` : ''),
  );
  console.log(
    `[Past] 累計: 予想し直し済み${s.byStatus.predicted ?? 0}・馬の取得待ち${s.byStatus.imported ?? 0}・失敗${s.byStatus.failed ?? 0}レース／` +
      `確認済み${s.checkedDates}日（開催${s.raceDays}日）・最も古い日 ${s.oldestDate ?? '-'}`,
  );
  for (const e of r.errors.slice(0, 30)) console.log(`[Past] NG ${e}`);
  if (r.errors.length > 30) console.log(`[Past] NG ほか${r.errors.length - 30}件`);
  return { rateLimited: r.rateLimited };
}
