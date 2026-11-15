/**
 * 重賞（G1・G2・G3）の過去10年の同一レースを自動で取得する（夜間処理から呼ぶ）
 *
 * - 対象：今日から7日先までに登録されている重賞（出走予定の段階でも対象）
 * - 取得済みの年は読み直さない。足りない年と、馬場が不明の年だけを取る（HistoryService.collect と同じ）
 * - 見つからなかった年（創設10年未満・名称変更など）は、レース当日まで毎晩探し直す
 * - 開催一覧が取得できない状態（netkeiba の一時的な不調）になったら、その夜はそこで止める
 * - 終了時刻を過ぎたら、残りは次の夜に回す
 */
import type { RaceRepository } from '../db/repository';
import { NetkeibaSource } from '../sources/netkeiba';
import { PoliteFetcher } from '../sources/fetcher';
import { JraCalendar } from '../sources/jra-calendar';
import { HistoryService, LIST_UNAVAILABLE } from '../services/history-service';

/** 何日先までの重賞を対象にするか */
export const HISTORY_DAYS_AHEAD = 7;
/** 対象のグレード（表記ゆれを含む） */
export const HISTORY_GRADES = ['G1', 'G2', 'G3', 'GI', 'GII', 'GIII'];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function runHistoryStage(repo: RaceRepository, deadline?: number, today = new Date()): Promise<void> {
  const keys: string[] = [];
  for (let k = 0; k <= HISTORY_DAYS_AHEAD; k++) {
    const d = new Date(today);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + k);
    keys.push(...repo.listRaceKeysByGradeOnDate(ymd(d), HISTORY_GRADES));
  }
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
