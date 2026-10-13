/**
 * 騎手成績の取得（バッチ共通の段）
 *
 * 今日以降のレースに騎乗する騎手の成績（過去5年）を取得する。
 * アクセス制限を避けるため、騎手ページ専用の取得処理で間隔を 5 秒にし、1回の上限ページ数を設ける。
 */
import type { RaceRepository } from '../db/repository';
import { PoliteFetcher } from '../sources/fetcher';
import { NetkeibaSource } from '../sources/netkeiba';
import { JockeyService } from '../services/jockey-service';
import { HorseService } from '../services/horse-service';
import { PedigreeService, PEDIGREE_MIN_RUNS } from '../services/pedigree-service';

/**
 * 木曜バッチで全騎手を取得するか。
 * 2026-10-10 横山和生騎手の1人分で仕様を確認済み（ユーザー確認）。木曜バッチで全騎手を取得する
 */
export const JOCKEY_BATCH_ENABLED = true;

/** 馬の過去走の1回の上限ページ数（1頭1ページ・5秒間隔で約2時間）。環境変数 KEIBA_HORSE_PAGE_BUDGET で変更可 */
export const DEFAULT_HORSE_PAGE_BUDGET = Number(process.env.KEIBA_HORSE_PAGE_BUDGET) || 1500;

/** db.netkeiba.com 用の取得処理（5秒間隔）。馬・騎手で共有し、アクセス制限の停止も共有する */
export function createDbFetcher(repo: RaceRepository): PoliteFetcher {
  return new PoliteFetcher({ minIntervalMs: 5000, onLog: (entry) => repo.logFetch(entry) });
}

/** 今日以降のレースに出走する馬の過去走を取得する。アクセス制限を受けたら rateLimited=true を返す */
export async function runHorseStage(
  repo: RaceRepository,
  fetcher: PoliteFetcher = createDbFetcher(repo),
  pageBudget = DEFAULT_HORSE_PAGE_BUDGET,
  deadline?: number,
): Promise<{ rateLimited: boolean }> {
  const horseIds = repo.listHorseIdsFromDate(todayString());
  console.log(`[Horse] start: ${horseIds.length} horses, budget ${pageBudget} pages`);
  if (horseIds.length === 0) {
    console.log('[Horse] 馬IDの付いた出走馬がありません（出馬表を取り込み直すと馬IDが保存されます）');
    return { rateLimited: false };
  }
  const service = new HorseService(new NetkeibaSource(fetcher), repo);
  const status = await service.crawl(horseIds, pageBudget, deadline);
  console.log(
    `[Horse] done: ${status.doneHorses}/${status.totalHorses} horses (skip ${status.skippedHorses}), ${status.pagesFetched} pages` +
      (status.stoppedReason ? ` / 中断: ${status.stoppedReason}` : ''),
  );
  for (const e of status.errors) console.log(`[Horse] NG ${e}`);
  if (status.rateLimited) return { rateLimited: true };

  // 全出走馬の血統と父・母の父の産駒成績を取得する（血統は一度取れば再取得しない）。
  // 出走が少ない馬（新馬・2歳など）を先に取得し、続いてそのほかの馬
  const lowRunIds = repo.listLowRunHorseIdsFromDate(todayString(), PEDIGREE_MIN_RUNS);
  const lowSet = new Set(lowRunIds);
  const pedIds = [...lowRunIds, ...horseIds.filter((id) => !lowSet.has(id))];
  const pending = pedIds.filter((id) => !repo.getPedigree(id)).length;
  console.log(`[Pedigree] start: ${pedIds.length} horses（未取得 ${pending}頭。${PEDIGREE_MIN_RUNS}走未満の${lowRunIds.length}頭を優先）`);
  const ped = await new PedigreeService(new NetkeibaSource(fetcher), repo).crawl(pedIds, 1500, deadline);
  console.log(
    `[Pedigree] done: 血統${ped.pedigreesFetched}頭・産駒成績${ped.siresFetched}頭分, ${ped.pagesFetched} pages` +
      (ped.stoppedReason ? ` / 中断: ${ped.stoppedReason}` : ''),
  );
  for (const e of ped.errors) console.log(`[Pedigree] NG ${e}`);
  return { rateLimited: ped.rateLimited };
}

/** 1回の上限ページ数（5秒間隔で約5.5時間）。環境変数 KEIBA_JOCKEY_PAGE_BUDGET で変更可 */
export const DEFAULT_JOCKEY_PAGE_BUDGET = Number(process.env.KEIBA_JOCKEY_PAGE_BUDGET) || 4000;

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function runJockeyStage(
  repo: RaceRepository,
  pageBudget = DEFAULT_JOCKEY_PAGE_BUDGET,
  fetcher: PoliteFetcher = createDbFetcher(repo),
  opts: { deadline?: number; includeIncomplete?: boolean } = {},
): Promise<void> {
  // 次の出走予定の騎手を先に、そのあと（夜間ジョブでは）5年分がそろっていない騎手を続ける
  const upcoming = repo.listJockeyIdsFromDate(todayString());
  const jockeyIds = opts.includeIncomplete
    ? [...upcoming, ...repo.listIncompleteJockeyIds().filter((id) => !upcoming.includes(id))]
    : upcoming;
  console.log(`[Jockey] start: ${jockeyIds.length} jockeys, budget ${pageBudget} pages`);
  if (jockeyIds.length === 0) {
    console.log('[Jockey] 騎手IDの付いた出走馬がありません（出馬表を取り込み直すと騎手IDが保存されます）');
    return;
  }

  const service = new JockeyService(new NetkeibaSource(fetcher), repo);
  const status = await service.crawl(jockeyIds, pageBudget, 5, opts.deadline);

  console.log(
    `[Jockey] done: ${status.doneJockeys}/${status.totalJockeys} jockeys, ${status.pagesFetched} pages` +
      (status.stoppedReason ? ` / 中断: ${status.stoppedReason}` : ''),
  );
  for (const e of status.errors) console.log(`[Jockey] NG ${e}`);
}
