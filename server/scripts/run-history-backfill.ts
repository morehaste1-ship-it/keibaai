/**
 * 過去の重賞の「過去10年」と、その出走馬の成績を、まとめてさかのぼって取得する（組み合わせ補正のレース専用区分の検証用）
 *
 * 実行: npm run history-backfill              … 次の「ほかの取得の5分前」まで取得する（毎日。2026-11-18 に月〜木から変更）
 *       npm run history-backfill -- --status   … 進み具合を表示するだけ（取得しない）
 *       npm run history-backfill -- --force    … 以前の曜日の制限を外すためのもの（今は毎日動くので同じ動き）
 * 自動実行: launchd com.keibaai.backfill（30分ごとに起動を試みる。ほかの取得の実行中は何もしない）
 *
 * 対象: 予想の記録と結果がそろった過去の重賞（G1・G2・G3）。新しいレースから順に
 *  （配分の見直しの確認用は新しい3割のレースなので、そこから埋める）
 * 1レースごとに
 *  ① 過去10年の同一レースの結果（取得済みの年は飛ばす。馬IDが無い年は結果ページだけ読み直す）
 *  ② その過去10年に出た馬の成績ページ（一度取った馬は取り直さない）
 * 止める時刻（ほかの自動取得の5分前。Mac のローカル時間）と、そのあと始めない時間
 *  毎日 0:55（夜間処理 1:00）・10:35（出馬表 10:40）・12:55（出馬表 13:00）… 止めてから10分は始めない（実行中は印で分かる）
 *  毎日 9:25（朝のオッズ 9:30）・11:55（昼のオッズ 12:00）… オッズの取得は印を取らないので、止めてから30分は始めない
 *  木曜 14:25・15:55（出馬表 14:30・16:00）・20:55（週末の準備 batch 21:00）… 止めてから10分は始めない
 * アクセス制限の兆候が出たら、翌朝6:00まで止める（data/history-backfill-pause.json）
 * 過去10年を探し終えたレースは data/history-backfill-done-v2.json に記録し、見つからない年を毎回探し直さない
 * 開催一覧が一時的に取れないときは、そのレースを飛ばして次へ。3レース続いたら、その回は止める（30分後の起動でやり直す）
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_DB_PATH, openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { acquireLock, readLock, releaseLock } from '../services/crawl-lock';
import { HistoryService, LIST_UNAVAILABLE, seriesKeyOf } from '../services/history-service';
import { HorseService } from '../services/horse-service';
import { gradeFromRaceName, normalizeGrade } from '../services/score-service';
import { NetkeibaSource } from '../sources/netkeiba';
import { JraCalendar } from '../sources/jra-calendar';
import { createDbFetcher } from './jockey-stage';

/** 止める時刻（時・分）。weekday を付けたものはその曜日だけ（0=日〜6=土）。blockMin = 止めてから何分は始めないか（既定10分） */
const STOP_TIMES: { h: number; m: number; weekday?: number; blockMin?: number }[] = [
  { h: 0, m: 55 },
  { h: 9, m: 25, blockMin: 30 },
  { h: 10, m: 35 },
  { h: 11, m: 55, blockMin: 30 },
  { h: 12, m: 55 },
  { h: 14, m: 25, weekday: 4 },
  { h: 15, m: 55, weekday: 4 },
  { h: 20, m: 55, weekday: 4 },
];
/** 実行する曜日（毎日。ほかの自動取得と重なる時間は STOP_TIMES で避ける） */
const RUN_WEEKDAYS = new Set([0, 1, 2, 3, 4, 5, 6]);
/** 残り時間がこれ未満なら始めない */
const MIN_WINDOW_MS = 5 * 60 * 1000;

const PAUSE_FILE = path.join(path.dirname(DEFAULT_DB_PATH), 'history-backfill-pause.json');
/** 過去10年を探し終えたレース（見つからない年があっても、探し直さない。毎回同じ日付を探すのは無駄なため） */
// v2：2026-11-16 に名前の照合（表記ゆれ・冠名・別会場）を直したため、全レースを探し直す（古い v1 のファイルは使わずに残す）
const DONE_FILE = path.join(path.dirname(DEFAULT_DB_PATH), 'history-backfill-done-v2.json');

function loadDone(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(DONE_FILE, 'utf8')) as string[]);
  } catch {
    return new Set();
  }
}
function saveDone(done: Set<string>): void {
  try {
    fs.writeFileSync(DONE_FILE, JSON.stringify([...done]));
  } catch {
    // 書けなくても続行（次回また探すだけ）
  }
}

/**
 * 今、始めてはいけない時間帯か：止める時刻から blockMin 分間（既定10分＝ほかの取得の開始5分前〜開始5分後）。
 * ほかの取得が始まる直前・直後に印を取ってしまい、ほかの取得を飛ばさせないため
 */
export function inBlockedWindow(now: Date): boolean {
  for (const add of [-1, 0]) {
    for (const t of STOP_TIMES) {
      const d = new Date(now);
      d.setDate(d.getDate() + add);
      d.setHours(t.h, t.m, 0, 0);
      if (t.weekday !== undefined && d.getDay() !== t.weekday) continue;
      const diff = now.getTime() - d.getTime();
      if (diff >= 0 && diff < (t.blockMin ?? 10) * 60 * 1000) return true;
    }
  }
  return false;
}

/** now より後で最初に来る「止める時刻」 */
export function nextStopTime(now: Date): Date {
  let best: Date | null = null;
  for (let add = 0; add <= 7; add++) {
    for (const t of STOP_TIMES) {
      const d = new Date(now);
      d.setDate(d.getDate() + add);
      d.setHours(t.h, t.m, 0, 0);
      if (t.weekday !== undefined && d.getDay() !== t.weekday) continue;
      if (d.getTime() > now.getTime() && (!best || d < best)) best = d;
    }
    if (best) return best;
  }
  throw new Error('止める時刻が見つかりません');
}

function pausedUntil(): number | null {
  try {
    const v = JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8')) as { until: string };
    const t = Date.parse(v.until);
    return Number.isFinite(t) && t > Date.now() ? t : null;
  } catch {
    return null;
  }
}

function pauseUntilTomorrowMorning(reason: string): void {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(6, 0, 0, 0);
  try {
    fs.writeFileSync(PAUSE_FILE, JSON.stringify({ until: d.toISOString(), reason, at: new Date().toISOString() }));
  } catch {
    // 書けなくても続行（次の起動でまた制限に当たれば止まる）
  }
  console.log(`[Backfill] ${reason}。${d.toLocaleString('ja-JP')} まで取得を止めます`);
}

/** 対象の重賞（予想の記録と結果がそろった過去のレース。新しい順） */
function targetRaces(repo: RaceRepository, db: ReturnType<typeof openDatabase>, today: string) {
  const rows = db
    .prepare(
      `SELECT DISTINCT r.race_key AS raceKey, r.date AS date, r.name AS name, r.grade AS grade,
              r.venue_name AS venueName, r.surface AS surface, r.distance AS distance
         FROM races r
         JOIN prediction_records p ON p.race_key = r.race_key
         JOIN race_outcomes o ON o.race_key = r.race_key
        WHERE r.date < ?
        ORDER BY r.date DESC, r.race_key`,
    )
    .all(today) as { raceKey: string; date: string; name: string; grade: string | null; venueName: string; surface: string; distance: number }[];
  return rows
    .filter((r) => {
      const g = normalizeGrade(r.grade) ?? gradeFromRaceName(r.name);
      return g === 'G1' || g === 'G2' || g === 'G3';
    })
    .map((r) => ({ ...r, seriesKey: seriesKeyOf(r.name, r.venueName, r.surface, r.distance) }));
}

/** そのレースから見た過去10年のうち、馬ID付きで保存済みの年数 */
function savedYearsWithIds(repo: RaceRepository, seriesKey: string, raceDate: string): number {
  const baseYear = Number(raceDate.slice(0, 4));
  const years = new Set<number>();
  for (const h of repo.listHistoryRuns(seriesKey)) {
    const y = Number(h.date.slice(0, 4));
    if (h.horseId && y < baseYear && y >= baseYear - 10) years.add(y);
  }
  return years.size;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function showStatus(repo: RaceRepository, db: ReturnType<typeof openDatabase>): void {
  const races = targetRaces(repo, db, ymd(new Date()));
  const series = [...new Set(races.map((r) => r.seriesKey))];
  const full = races.filter((r) => savedYearsWithIds(repo, r.seriesKey, r.date) >= 10).length;
  const some = races.filter((r) => savedYearsWithIds(repo, r.seriesKey, r.date) > 0).length;
  const horses = repo.listHistoryHorseIdsToFetch(series);
  console.log(`[Backfill] 対象の重賞 ${races.length}レース（${series.length}シリーズ）`);
  console.log(`[Backfill]   過去10年が10年分そろった ${full}レース・一部だけ ${some - full}レース・まだ ${races.length - some}レース（見つからない年があるレースは10年にならないことがあります）`);
  console.log(`[Backfill]   過去10年の出走馬 ${horses.total}頭のうち成績取得済み ${horses.fetched}頭・残り ${horses.pending.length}頭`);
  const p = pausedUntil();
  if (p) console.log(`[Backfill]   アクセス制限の兆候のため ${new Date(p).toLocaleString('ja-JP')} まで停止中`);
}

async function run(repo: RaceRepository, db: ReturnType<typeof openDatabase>, deadline: number): Promise<void> {
  const races = targetRaces(repo, db, ymd(new Date()));
  console.log(`[Backfill] 対象の重賞 ${races.length}レース・終了時刻 ${new Date(deadline).toLocaleString('ja-JP')}`);
  const fetcher = createDbFetcher(repo);
  const source = new NetkeibaSource(fetcher);
  const history = new HistoryService(new JraCalendar(), source, repo);
  const searched = loadDone();
  let done = 0;
  // 「開催一覧が取得できない」が続いた回数（3レース続いたら本当の不調とみなして止める。1レースだけなら飛ばして次へ）
  let unavailableStreak = 0;
  for (const r of races) {
    if (Date.now() >= deadline) {
      console.log('[Backfill] 終了時刻になったため、続きは次回に回します');
      return;
    }
    const label = `${r.date} ${r.venueName} ${r.name}`;
    // ① 過去10年（すでに10年そろっていれば、アクセスなしで飛ばす）
    if (!searched.has(r.raceKey) && savedYearsWithIds(repo, r.seriesKey, r.date) < 10) {
      try {
        const res = await history.collect(r.raceKey, 10);
        const added = res.years.filter((y) => y.status === 'saved' && !y.alreadySaved).length;
        const missing = res.years.filter((y) => y.status !== 'saved').map((y) => y.year);
        console.log(
          `[Backfill] ${label}：過去10年 ${res.savedCount}/10年` +
            (added > 0 ? `（今回 ${added}年）` : '') +
            (missing.length > 0 ? `／見つからない年 ${missing.join('・')}` : ''),
        );
        if (res.years.some((y) => y.status === 'error' && y.message.includes('アクセス制限'))) {
          pauseUntilTomorrowMorning('アクセス制限の兆候（過去10年の取得中）');
          return;
        }
        if (res.years.some((y) => y.status === 'error' && y.message.startsWith(LIST_UNAVAILABLE))) {
          unavailableStreak++;
          if (unavailableStreak >= 3) {
            console.log('[Backfill] 開催一覧が3レース続けて取得できないため（netkeiba の一時的な不調の可能性）、今回はここで止めます');
            return;
          }
          console.log('[Backfill] 開催一覧が取得できない年があったため、このレースは次回に回して次へ進みます');
          continue;
        }
        unavailableStreak = 0;
        // エラーの年が無ければ探し終えたとして記録する（見つからない年は探し直さない）
        if (!res.years.some((y) => y.status === 'error')) {
          searched.add(r.raceKey);
          saveDone(searched);
        }
      } catch (err: any) {
        console.log(`[Backfill] NG ${label}: ${err?.message ?? err}`);
        if (err?.name === 'RateLimitedError') {
          pauseUntilTomorrowMorning('アクセス制限の兆候（過去10年の取得中）');
          return;
        }
        continue;
      }
    }
    // ② 過去10年の出走馬の成績
    const t = repo.listHistoryHorseIdsToFetch([r.seriesKey]);
    if (t.pending.length > 0) {
      if (Date.now() >= deadline) {
        console.log('[Backfill] 終了時刻になったため、続きは次回に回します');
        return;
      }
      const st = await new HorseService(source, repo).crawl(t.pending, 100000, deadline);
      console.log(`[Backfill] ${label}：出走馬の成績 ${st.pagesFetched}頭を取得（残り ${t.pending.length - st.doneHorses}頭）`);
      for (const e of st.errors.slice(0, 5)) console.log(`[Backfill] NG ${e}`);
      if (st.rateLimited) {
        pauseUntilTomorrowMorning('アクセス制限の兆候（出走馬の成績の取得中）');
        return;
      }
    }
    done++;
  }
  console.log(`[Backfill] 全${races.length}レースの取得が済みました（今回 ${done}レースを確認）`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  console.log(`[Backfill] script start ${new Date().toISOString()}`);
  if (args.includes('--status')) {
    const db = openDatabase();
    try {
      showStatus(new RaceRepository(db), db);
    } finally {
      db.close();
    }
    return;
  }
  const now = new Date();
  if (!args.includes('--force') && !RUN_WEEKDAYS.has(now.getDay())) {
    console.log('[Backfill] 今日は実行しない曜日です');
    return;
  }
  const p = pausedUntil();
  if (p) {
    console.log(`[Backfill] アクセス制限の兆候のため ${new Date(p).toLocaleString('ja-JP')} まで止めています`);
    return;
  }
  if (inBlockedWindow(now)) {
    console.log('[Backfill] ほかの自動取得の開始前後のため、今回は実行しません');
    return;
  }
  const deadline = nextStopTime(now).getTime();
  if (deadline - now.getTime() < MIN_WINDOW_MS) {
    console.log('[Backfill] まもなくほかの自動取得が始まるため、今回は実行しません');
    return;
  }
  if (!acquireLock('history-backfill')) {
    console.log(`[Backfill] ほかの取得が実行中のためスキップします（${readLock()?.owner ?? '不明'}）`);
    return;
  }
  const db = openDatabase();
  try {
    await run(new RaceRepository(db), db, deadline);
  } catch (err: any) {
    console.error('[Backfill] fatal:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    db.close();
    releaseLock();
    console.log(`[Backfill] script end ${new Date().toISOString()}`);
  }
}

if (process.argv[1] && /run-history-backfill\.ts$/.test(process.argv[1])) main();
