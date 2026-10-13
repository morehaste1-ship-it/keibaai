/**
 * 過去レースの取り込みと予想し直しを手動で実行する（検証用・段階B）
 *
 * 実行: npm run past
 *   オプション（npm run past -- --hours 3 のように指定）
 *   --hours N         N時間で止める（既定: 上限ページ数に達するまで）
 *   --race-pages N    出馬表・結果の上限ページ数（既定 1500。1レース2ページ）
 *   --horse-pages N   馬の過去走の上限ページ数（既定 2000。5秒間隔で約2.8時間）
 *   --from YYYY-MM-DD この日までさかのぼる（既定 2021-01-01）
 *   --rescore         取得はせず、予想し直し済みの過去レースを今の計算（追加した項目を含む）で記録し直す
 * 途中で止めても（Ctrl+C）、取り込み済みの分は保存され、次回は続きから
 */
import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { acquireLock, readLock, releaseLock } from '../services/crawl-lock';
import { DEFAULT_PAST_FROM } from '../services/past-service';
import { runPastRescore, runPastStage } from './past-stage';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function positive(name: string): number | undefined {
  const v = arg(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} は正の数で指定してください（${v}）`);
  return n;
}

async function main(): Promise<void> {
  console.log(`[Past] script start ${new Date().toISOString()}`);
  const hours = positive('hours');
  const from = arg('from') ?? DEFAULT_PAST_FROM;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error(`--from は YYYY-MM-DD で指定してください（${from}）`);
  const opts = {
    deadline: hours ? Date.now() + hours * 3600 * 1000 : undefined,
    maxRacePages: positive('race-pages'),
    maxHorsePages: positive('horse-pages'),
    fromDate: from,
  };
  if (!acquireLock('past')) {
    console.log(`[Past] ほかの取得が実行中のためスキップします（${readLock()?.owner ?? '不明'}）`);
    return;
  }
  const db = openDatabase();
  try {
    if (process.argv.includes('--rescore')) runPastRescore(new RaceRepository(db));
    else await runPastStage(new RaceRepository(db), opts);
  } finally {
    db.close();
    releaseLock();
    console.log(`[Past] script end ${new Date().toISOString()}`);
  }
}

main().catch((err) => {
  console.error('[Past] fatal:', err?.message ?? err);
  process.exitCode = 1;
});
