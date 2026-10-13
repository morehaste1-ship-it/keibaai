/**
 * 夜間ジョブ（毎日 1:00 に launchd から起動。終了時刻になったら続きは翌晩）
 *
 * - 最初に、ディスクの空き（2GB 以上）と DB の大きさ（直近のバックアップの半分以上）を確かめ、異常なら何もせず止める
 * - DB をバックアップする（data/backup、直近7日分）。そのあと7日より古いページの写し（data/cache）を消す
 * - 次に、予想を記録したレース（前日まで）の結果を取り込む（答え合わせ用）
 * - 火曜は、続けて配分の自動見直しを行う（採用した配分は、その夜の前日予想から使う）
 * - その日に開催があれば、その日の出馬表を全レース取り込み直す（枠順・騎手・馬IDが確定した最新の出馬表にするため）
 * - 翌日に開催があれば、翌日の出馬表・単勝オッズを取り込む（金曜は週末分をまとめて取り込むため不要）
 * - 金曜（木曜の深夜）だけ、最初に週末の出馬表・単勝オッズを取得する（旧・木曜21時バッチ）
 * - そのあと、出走馬の過去走 → 血統 → 騎手成績（出走予定の騎手、続いて取得途中の騎手）の順に取得
 * - 最後に、翌日の全レースの単勝オッズ（発売前は予想オッズ）を取り直し、既定の配分で「前日予想」（eve）を記録する。
 *   終了時刻を過ぎていても行う（取得はレース数ページのみ）
 * - 終了時刻まで時間が残っていれば、過去レースの取り込みと予想し直し（検証用）を進める
 * - 終了時刻は環境変数 KEIBA_NIGHTLY_UNTIL（既定 06:00）
 * - ほかの取得（画面・手動スクリプト）が動いていればスキップする
 *
 * 実行: npm run nightly
 */
import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { NetkeibaSource } from '../sources/netkeiba';
import { PoliteFetcher } from '../sources/fetcher';
import { JraCalendar } from '../sources/jra-calendar';
import { BatchService } from '../services/batch-service';
import { acquireLock, readLock, releaseLock } from '../services/crawl-lock';
import { createDbFetcher, runHorseStage, runJockeyStage } from './jockey-stage';
import { ScoreService } from '../services/score-service';
import { ReviewService } from '../services/review-service';
import { backupDatabase, uploadOffsite } from '../services/db-backup';
import { runPastStage } from './past-stage';
import { logWeightReview } from './tune-stage';
import { DEFAULT_DB_PATH } from '../db/index';
import { DEFAULT_BACKUP_DIR } from '../services/db-backup';
import { dbShrinkProblem, diskShortage, pruneCache } from '../services/maintenance';
import path from 'path';

/** ローカル時間の日付を YYYY-MM-DD で返す */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "HH:MM" から、次に来るその時刻（ミリ秒）を求める */
export function nextDeadline(hhmm: string, now = new Date()): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  const [h, min] = m ? [Number(m[1]), Number(m[2])] : [6, 0];
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

async function main(): Promise<void> {
  console.log(`[Nightly] start ${new Date().toISOString()}`);
  if (!acquireLock('nightly')) {
    const info = readLock();
    console.log(`[Nightly] ほかの取得が実行中のためスキップします（${info?.owner ?? '不明'}・${info?.startedAt ?? ''}）`);
    return;
  }

  // 異常があれば何もしない（空き不足のまま書き込まない・作り直された空の DB で正しいバックアップを押し出さない）
  const problem = diskShortage() ?? (process.env.KEIBA_SKIP_DB_CHECK === '1' ? null : dbShrinkProblem(DEFAULT_DB_PATH, DEFAULT_BACKUP_DIR));
  if (problem) {
    console.log(`[Nightly] 中止: ${problem}`);
    releaseLock();
    console.log(`[Nightly] end ${new Date().toISOString()}`);
    process.exitCode = 1;
    return;
  }

  const deadline = nextDeadline(process.env.KEIBA_NIGHTLY_UNTIL || '06:00');
  console.log(`[Nightly] 終了時刻 ${new Date(deadline).toLocaleString('ja-JP')}`);
  const db = openDatabase();
  try {
    const repo = new RaceRepository(db);

    // その夜の書き込みを始める前に DB をバックアップする（直近7日分を残す）
    try {
      const b = await backupDatabase(db);
      console.log(`[Backup] ${b.file}（${Math.round(b.bytes / 1024)}KB）${b.removed.length > 0 ? ` 古いものを削除: ${b.removed.join(', ')}` : ''}`);
      const o = uploadOffsite(b.file);
      console.log(`[Backup] Google ドライブ: ${o.message}`);
    } catch (err: any) {
      console.log(`[Backup] バックアップに失敗しました（${err?.message ?? err}）。取得はそのまま続けます`);
    }

    // 7日より古いページの写しを消す（予想のデータには影響しない）
    try {
      const c = pruneCache(path.resolve(process.cwd(), 'data', 'cache'));
      console.log(`[Cache] 古いページの写しを削除: ${c.files}ファイル（${(c.bytes / 1024 ** 2).toFixed(1)}MB）`);
    } catch (err: any) {
      console.log(`[Cache] 写しの整理に失敗しました（${err?.message ?? err}）`);
    }

    // 答え合わせ用：予想を記録したレース（前日まで）の結果を取り込む
    try {
      const raceFetcher = new PoliteFetcher({ onLog: (entry) => repo.logFetch(entry) });
      const review = new ReviewService(repo, new ScoreService(repo), new NetkeibaSource(raceFetcher));
      const y = new Date();
      y.setDate(y.getDate() - 1);
      const until = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
      const r = await review.fetchPendingOutcomes(until);
      console.log(`[Review] 結果の取り込み: ${r.success}/${r.total}`);
      for (const e of r.errors) console.log(`[Review] NG ${e}`);
    } catch (err: any) {
      console.log(`[Review] 結果の取り込みを中断しました（${err?.message ?? err}）`);
    }

    // 火曜（月曜の深夜）は、週末の結果がそろったところで配分を見直す
    if (new Date().getDay() === 2 || process.env.KEIBA_NIGHTLY_TUNE === '1') {
      try {
        logWeightReview(repo);
      } catch (err: any) {
        console.log(`[Tune] 配分の見直しを中断しました（${err?.message ?? err}）`);
      }
    }

    // その日に開催があれば、その日の出馬表を取り込み直す（金曜1時の時点では未確定だった翌日以降の出馬表を最新にする）
    try {
      const fetcher = new PoliteFetcher({ onLog: (entry) => repo.logFetch(entry) });
      const batch = new BatchService(new JraCalendar(), new NetkeibaSource(fetcher), repo);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const status = await batch.prepareSingleDayRaces(today);
      if (status.totalRaces === 0 && status.failureCount > 0) {
        console.log(`[Today] 開催の確認に失敗しました（${status.details[0]?.message ?? '不明'}）`);
      } else if (status.totalRaces === 0) {
        console.log('[Today] 本日の開催はありません');
      } else {
        console.log(`[Today] 本日の出馬表を取り込み直し: total=${status.totalRaces} success=${status.successCount} failure=${status.failureCount}`);
        for (const d of status.details) if (d.status !== 'success') console.log(`[Today] NG ${d.raceId}: ${d.message}`);
      }
    } catch (err: any) {
      console.log(`[Today] 本日の出馬表の取り込み直しを中断しました（${err?.message ?? err}）`);
    }

    // 金曜（木曜の深夜）は、週末の出馬表・オッズを先に取得する
    const isFriday = new Date().getDay() === 5;
    const tomorrow = new Date();
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 翌日に開催があれば、翌日の出馬表を取り込む（前日予想のため。金曜は下の週末分に含まれる）
    if (!isFriday) {
      try {
        const fetcher = new PoliteFetcher({ onLog: (entry) => repo.logFetch(entry) });
        const batch = new BatchService(new JraCalendar(), new NetkeibaSource(fetcher), repo);
        const status = await batch.prepareSingleDayRaces(tomorrow);
        if (status.totalRaces === 0 && status.failureCount > 0) {
          console.log(`[Tomorrow] 開催の確認に失敗しました（${status.details[0]?.message ?? '不明'}）`);
        } else if (status.totalRaces === 0) {
          console.log('[Tomorrow] 翌日の開催はありません');
        } else {
          console.log(`[Tomorrow] 翌日の出馬表を取り込み: total=${status.totalRaces} success=${status.successCount} failure=${status.failureCount}`);
          for (const d of status.details) if (d.status !== 'success') console.log(`[Tomorrow] NG ${d.raceId}: ${d.message}`);
        }
      } catch (err: any) {
        console.log(`[Tomorrow] 翌日の出馬表の取り込みを中断しました（${err?.message ?? err}）`);
      }
    }

    if (isFriday || process.env.KEIBA_NIGHTLY_WEEKEND === '1') {
      const fetcher = new PoliteFetcher({ onLog: (entry) => repo.logFetch(entry) });
      const batch = new BatchService(new JraCalendar(), new NetkeibaSource(fetcher), repo);
      const status = await batch.prepareWeekendRaces();
      console.log(`[Batch] result: total=${status.totalRaces} success=${status.successCount} failure=${status.failureCount}`);
      for (const d of status.details) if (d.status !== 'success') console.log(`[Batch] NG ${d.raceId}: ${d.message}`);
    }

    const dbFetcher = createDbFetcher(repo);
    const horse = await runHorseStage(repo, dbFetcher, 3000, deadline);
    if (horse.rateLimited) {
      console.log('[Jockey] アクセス制限を受けたため、騎手成績の取得は次回に回します');
    } else if (Date.now() < deadline) {
      await runJockeyStage(repo, 100000, dbFetcher, { deadline, includeIncomplete: true });
    } else {
      console.log('[Jockey] 終了時刻を過ぎたため、騎手成績の取得は次回に回します');
    }

    // 前日予想：翌日の全レースのオッズ（発売前は予想オッズ）を取り直し、既定の配分で記録する
    try {
      const date = ymd(tomorrow);
      const keys = repo.listRaceKeysOnDate(date);
      if (keys.length === 0) {
        console.log('[Eve] 翌日のレースはありません');
      } else {
        const fetcher = new PoliteFetcher({ onLog: (entry) => repo.logFetch(entry) });
        const source = new NetkeibaSource(fetcher);
        const odds = await new BatchService(new JraCalendar(), source, repo).refreshAllRaceOdds(date);
        console.log(`[Eve] オッズ: ${odds.success}/${odds.total}`);
        const review = new ReviewService(repo, new ScoreService(repo), source);
        let recorded = 0;
        const kinds: Record<string, number> = {};
        for (const k of keys) {
          try {
            const rec = review.recordAuto(k, new Date(), 'eve');
            recorded++;
            const kind = rec.settings.oddsKind ?? 'なし';
            kinds[kind] = (kinds[kind] ?? 0) + 1;
          } catch (err: any) {
            console.log(`[Eve] 記録なし ${k}: ${err?.message ?? err}`);
          }
        }
        const kindText = Object.entries(kinds)
          .map(([k, n]) => `${k === 'forecast' ? '予想オッズ' : k === 'live' ? '発売中' : k === 'final' ? '確定' : 'オッズなし'}${n}`)
          .join('・');
        console.log(`[Eve] 前日予想を記録 ${recorded}/${keys.length}レース（${kindText || '-'}）`);
      }
    } catch (err: any) {
      console.log(`[Eve] 前日予想の記録を中断しました（${err?.message ?? err}）`);
    }

    // 残った時間で、過去レースの取り込みと予想し直し（検証用）
    if (horse.rateLimited) {
      console.log('[Past] アクセス制限を受けたため、過去レースの取り込みは次回に回します');
    } else if (Date.now() < deadline) {
      try {
        await runPastStage(repo, { deadline });
      } catch (err: any) {
        console.log(`[Past] 過去レースの取り込みを中断しました（${err?.message ?? err}）`);
      }
    } else {
      console.log('[Past] 終了時刻を過ぎたため、過去レースの取り込みは次回に回します');
    }
  } catch (err: any) {
    console.error('[Nightly] fatal:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    db.close();
    releaseLock();
    console.log(`[Nightly] end ${new Date().toISOString()}`);
  }
}

if (process.argv[1]?.includes('run-nightly')) main();
