/**
 * 重賞（G1・G2・G3）の過去10年の同一レースを自動で取得する（夜間処理から呼ぶ）
 *
 * - 対象：今日から7日先までに登録されている重賞（出走予定の段階でも対象）
 * - 取得済みの年は読み直さない。足りない年と、馬場が不明の年だけを取る（HistoryService.collect と同じ）
 * - 見つからなかった年（創設10年未満・名称変更など）は、レース当日まで毎晩探し直す
 * - 開催一覧が取得できない状態（netkeiba の一時的な不調）になったら、その夜はそこで止める
 * - 終了時刻を過ぎたら、残りは次の夜に回す
 * - 結果は馬IDも保存する。馬IDが無い年（保存を始める前に取得）は、結果ページだけを読み直して補う
 * - runHistoryHorseStage：過去10年に出た馬の成績ページを取る（休み明けの日数などを出すため）
 */
import type { RaceRepository } from '../db/repository';
import { NetkeibaSource } from '../sources/netkeiba';
import { PoliteFetcher } from '../sources/fetcher';
import { JraCalendar } from '../sources/jra-calendar';
import { HistoryService, LIST_UNAVAILABLE, seriesKeyOf } from '../services/history-service';
import { HorseService } from '../services/horse-service';

/** 何日先までの重賞を対象にするか */
export const HISTORY_DAYS_AHEAD = 7;
/** 対象のグレード（表記ゆれを含む） */
export const HISTORY_GRADES = ['G1', 'G2', 'G3', 'GI', 'GII', 'GIII'];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 今日から HISTORY_DAYS_AHEAD 日先までの重賞のレースキー */
function targetRaceKeys(repo: RaceRepository, today: Date): string[] {
  const keys: string[] = [];
  for (let k = 0; k <= HISTORY_DAYS_AHEAD; k++) {
    const d = new Date(today);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + k);
    keys.push(...repo.listRaceKeysByGradeOnDate(ymd(d), HISTORY_GRADES));
  }
  return keys;
}

/** 過去10年の出走馬の成績ページを1晩に取る上限（5秒間隔で約50分） */
export const HISTORY_HORSE_PAGE_BUDGET = 600;

/**
 * 対象の重賞の過去10年に出た馬の成績ページを取得する（休み明けの日数などを、その馬の前走から出すため）。
 * 一度取った馬は取り直さない（引退した馬の成績は増えないため）。新しい開催の馬から順に取る
 */
export async function runHistoryHorseStage(
  repo: RaceRepository,
  source: NetkeibaSource,
  deadline?: number,
  today = new Date(),
  budget = HISTORY_HORSE_PAGE_BUDGET,
): Promise<{ rateLimited: boolean }> {
  const seriesKeys = [
    ...new Set(
      targetRaceKeys(repo, today)
        .map((k) => repo.getRace(k))
        .filter((r): r is NonNullable<typeof r> => !!r)
        .map((r) => seriesKeyOf(r.name, r.venueName, r.surface, r.distance)),
    ),
  ];
  const t = repo.listHistoryHorseIdsToFetch(seriesKeys);
  console.log(`[HistoryHorse] 過去10年の出走馬 ${t.total}頭のうち成績取得済み ${t.fetched}頭・今回の対象 ${Math.min(t.pending.length, budget)}頭`);
  if (t.pending.length === 0) return { rateLimited: false };
  const status = await new HorseService(source, repo).crawl(t.pending, budget, deadline);
  console.log(
    `[HistoryHorse] done: ${status.doneHorses}/${status.totalHorses}頭, ${status.pagesFetched} pages` +
      (status.stoppedReason ? ` / 中断: ${status.stoppedReason}` : ''),
  );
  for (const e of status.errors.slice(0, 20)) console.log(`[HistoryHorse] NG ${e}`);
  return { rateLimited: status.rateLimited };
}

export async function runHistoryStage(repo: RaceRepository, deadline?: number, today = new Date()): Promise<void> {
  const keys = targetRaceKeys(repo, today);
  console.log(`[History] 対象の重賞 ${keys.length}レース（今日から${HISTORY_DAYS_AHEAD}日先まで）`);
  if (keys.length === 0) return;

  const service = new HistoryService(new JraCalendar(), new NetkeibaSource(new PoliteFetcher({ onLog: (e) => repo.logFetch(e) })), repo);
  for (const raceKey of keys) {
    if (deadline !== undefined && Date.now() >= deadline) {
      console.log('[History] 終了時刻を過ぎたため、残りは次の夜に回します');
      return;
    }
    const race = repo.getRace(raceKey);
    const label = race ? `${race.date.slice(5)} ${race.venueName}${race.raceNo}R ${race.name}` : raceKey;
    try {
      const r = await service.collect(raceKey, 10);
      const added = r.years.filter((y) => y.status === 'saved' && !y.alreadySaved).length;
      const missing = r.years.filter((y) => y.status !== 'saved').map((y) => y.year);
      console.log(
        `[History] ${label}：${r.savedCount}/10年` +
          (added > 0 ? `（今回 ${added}年を取得）` : '（追加なし）') +
          (missing.length > 0 ? `／見つからない年 ${missing.join('・')}` : ''),
      );
      if (r.years.some((y) => y.status === 'error' && y.message.startsWith(LIST_UNAVAILABLE))) {
        console.log('[History] 開催一覧が取得できないため（netkeiba の一時的な不調の可能性）、今夜はここで止めます');
        return;
      }
    } catch (err: any) {
      console.log(`[History] NG ${label}: ${err?.message ?? err}`);
    }
  }
}
