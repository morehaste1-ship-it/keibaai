/**
 * 日中の出馬表の取り込み（馬番・枠番が発表されたらすぐに取り込み、前日予想まで記録する）
 *
 * 実行: npx tsx server/scripts/run-cards.ts
 * 定期実行: launchd（com.keibaai.cards）で 毎日 10:40・13:00、木曜 14:30・16:00
 * - 枠順の発表：通常は前日の10時すぎ。土日の重賞（前日発売あり）は金曜10時すぎ、早いもの（G1など）は木曜14時以降
 * - 対象は「明日から3日後まで」の開催日。まだ馬番が付いていないレース（未取り込みを含む）だけを読み、
 *   馬番が付いていたら出馬表・単勝オッズ（発売前は予想オッズ）を保存して、既定の配分で前日予想（eve）を記録し直す
 * - 馬番がまだ無ければ、出走予定の段階の出馬表として保存だけする（前日予想は記録しない。次の回で読み直す）
 * - 新しく出てきた出走馬の過去走・血統も取る（取得済みの馬は読まない。50分で止める）
 * - 夜間処理・過去レースの取り込みなど、ほかの取得が動いていればスキップする（次の時刻に回る）
 * - 試験用：環境変数 KEIBA_CARDS_BASE=YYYY-MM-DD で「今日」を変えられる（通常は使わない）
 */
import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { NetkeibaSource } from '../sources/netkeiba';
import { PoliteFetcher } from '../sources/fetcher';
import { JraCalendar } from '../sources/jra-calendar';
import { acquireLock, readLock, releaseLock } from '../services/crawl-lock';
import { ScoreService } from '../services/score-service';
import { ReviewService } from '../services/review-service';
import { diskShortage } from '../services/maintenance';
import { createDbFetcher, runHorseStage } from './jockey-stage';

/** 何日先まで見るか（木曜に日曜分を取れるように3日） */
const DAYS_AHEAD = 3;
/** 出走馬の過去走・血統の取得に使う時間の上限 */
const HORSE_STAGE_MS = 50 * 60 * 1000;

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 取り消しを除く出走馬が全員、馬番付きか */
export function hasAllNumbers(entries: { horseNumber: number | null; scratched?: boolean }[]): boolean {
  const active = entries.filter((e) => !e.scratched);
  return active.length > 0 && active.every((e) => e.horseNumber !== null);
}

async function main(): Promise<void> {
  console.log(`[Cards] start ${new Date().toISOString()}`);
  const shortage = diskShortage();
  if (shortage) {
    console.log(`[Cards] 中止: ${shortage}`);
    return;
  }
  if (!acquireLock('cards')) {
    const info = readLock();
    console.log(`[Cards] ほかの取得が実行中のためスキップします（${info?.owner ?? '不明'}・${info?.startedAt ?? ''}）。次の時刻に取り込みます`);
    return;
  }
  const db = openDatabase();
  const calendar = new JraCalendar();
  try {
    const repo = new RaceRepository(db);
    const source = new NetkeibaSource(new PoliteFetcher({ onLog: (e) => repo.logFetch(e) }));
    const numbered: string[] = []; // この回で馬番付きになったレース
    let waiting = 0; // まだ馬番が無いレース

    const base = process.env.KEIBA_CARDS_BASE ? new Date(`${process.env.KEIBA_CARDS_BASE}T00:00:00`) : new Date();
    for (let k = 1; k <= DAYS_AHEAD; k++) {
      const d = new Date(base);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + k);
      const date = ymd(d);
      let races;
      try {
        races = await calendar.fetchRacesOnDate(d);
      } catch (err: any) {
        console.log(`[Cards] ${date}: 開催の確認に失敗しました（${err?.message ?? err}）`);
        continue;
      }
      if (races.length === 0) continue;

      let skipped = 0;
      let fetched = 0;
      let waitingOfDay = 0;
      for (const race of races) {
        const known = repo.findInternalKey('race', { source: 'netkeiba', id: race.raceId });
        if (known && hasAllNumbers(repo.getEntries(known))) {
          skipped++;
          continue;
        }
        try {
          const card = await source.fetchRaceCard({ source: 'netkeiba', id: race.raceId });
          if (card.entries.length === 0) {
            waitingOfDay++;
            continue;
          }
          const raceKey = repo.saveRaceCard(card);
          fetched++;
          if (hasAllNumbers(repo.getEntries(raceKey))) numbered.push(raceKey);
          else waitingOfDay++;
        } catch (err: any) {
          console.log(`[Cards] NG ${race.raceId}: ${err?.message ?? err}`);
        }
      }
      waiting += waitingOfDay;
      console.log(`[Cards] ${date}: ${races.length}レース（取り込み済み${skipped}・今回読んだ${fetched}・馬番まだ${waitingOfDay}）`);
    }
    await calendar.close().catch(() => {});

    if (numbered.length === 0) {
      console.log(`[Cards] 新しく馬番が付いたレースはありません${waiting > 0 ? `（馬番の発表待ち ${waiting}レース）` : ''}`);
      return;
    }

    // 新しく出てきた出走馬の過去走・血統（取得済みの馬は読まない）
    const horse = await runHorseStage(repo, createDbFetcher(repo), 1500, Date.now() + HORSE_STAGE_MS);
    if (horse.rateLimited) console.log('[Cards] アクセス制限を受けたため、残りの馬は夜間処理で取得します');

    // 単勝オッズ（発売前は予想オッズ）を取り、前日予想を記録し直す
    const review = new ReviewService(repo, new ScoreService(repo), source);
    let recorded = 0;
    const kinds: Record<string, number> = {};
    for (const raceKey of numbered) {
      try {
        const raceId = repo.findRaceSourceId(raceKey, 'netkeiba');
        if (raceId) {
          try {
            repo.saveWinOdds(await source.fetchWinOdds({ source: 'netkeiba', id: raceId }));
          } catch (err: any) {
            console.log(`[Cards] オッズなし ${raceKey}: ${err?.message ?? err}`);
          }
        }
        const rec = review.recordAuto(raceKey, new Date(), 'eve');
        recorded++;
        const kind = rec.settings.oddsKind ?? 'なし';
        kinds[kind] = (kinds[kind] ?? 0) + 1;
      } catch (err: any) {
        console.log(`[Cards] 記録なし ${raceKey}: ${err?.message ?? err}`);
      }
    }
    const kindText = Object.entries(kinds)
      .map(([k, n]) => `${k === 'forecast' ? '予想オッズ' : k === 'live' ? '発売中' : k === 'final' ? '確定' : 'オッズなし'}${n}`)
      .join('・');
    console.log(
      `[Cards] 前日予想を記録 ${recorded}/${numbered.length}レース（${kindText || '-'}）` + (waiting > 0 ? `／馬番の発表待ち ${waiting}レース` : ''),
    );
  } catch (err: any) {
    console.error('[Cards] fatal:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    await calendar.close().catch(() => {});
    db.close();
    releaseLock();
    console.log(`[Cards] end ${new Date().toISOString()}`);
  }
}

if (process.argv[1]?.includes('run-cards')) main();
