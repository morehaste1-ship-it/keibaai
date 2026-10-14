/**
 * 馬場が空のまま保存されたレースに、結果ページの馬場を補う（一度だけの修復用）
 *
 * 実行: npx tsx server/scripts/fix-track-conditions.ts          … 試運転（何件をどの馬場に直すかを表示するだけ。データは変えない）
 *       npx tsx server/scripts/fix-track-conditions.ts --apply  … 書き込む（先にDBのバックアップを data/backup/before-fix に取る）
 * - 対象は今日より前のレースのうち、馬場が空のものだけ。馬場が入っているレースは上書きしない
 * - 結果ページを1件ずつ読む（3秒間隔。保存済みのページの写しがあればそれを使う）。読めなかったレースはそのまま
 * - 夜間処理・過去レースの取り込みが動いている間は実行しない
 * - 書き込んだあとは npm run past -- --rescore で検証用の予想を計算し直す
 */
import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { PoliteFetcher } from '../sources/fetcher';
import { NetkeibaSource } from '../sources/netkeiba';
import { acquireLock, readLock, releaseLock } from '../services/crawl-lock';
import path from 'node:path';
import { DEFAULT_BACKUP_DIR, backupDatabase } from '../services/db-backup';

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`[Fix] start ${new Date().toISOString()}（${apply ? '書き込みあり' : '試運転：データは変えません'}）`);
  if (!acquireLock('fix-conditions')) {
    console.log(`[Fix] ほかの取得が実行中のため中止します（${readLock()?.owner ?? '不明'}）。終わってからもう一度実行してください`);
    return;
  }
  const db = openDatabase();
  try {
    const repo = new RaceRepository(db);
    const targets = repo.listRacesWithoutCondition(todayString());
    console.log(`[Fix] 馬場が空のレース: ${targets.length}件`);
    if (targets.length === 0) return;

    if (apply) {
      // 夜間処理のバックアップ（同じ日付の名前）を上書きしないよう、別のフォルダに取る
      const b = await backupDatabase(db, path.join(DEFAULT_BACKUP_DIR, 'before-fix'), 3);
      console.log(`[Fix] 書き込む前のバックアップ: ${b.file}`);
    }

    const source = new NetkeibaSource(new PoliteFetcher({ onLog: (e) => repo.logFetch(e) }));
    const counts: Record<string, number> = {};
    const skipped: string[] = [];
    let filled = 0;
    for (const [i, t] of targets.entries()) {
      const label = `${t.date} ${t.venueName}${t.raceNo}R ${t.name}`;
      try {
        const raceId = repo.findRaceSourceId(t.raceKey, 'netkeiba');
        if (!raceId) throw new Error('取得元のレースIDが未登録');
        const page = await source.fetchRaceResult({ source: 'netkeiba', id: raceId });
        if (!page.trackCondition) throw new Error('結果ページに馬場の表記なし');
        counts[page.trackCondition] = (counts[page.trackCondition] ?? 0) + 1;
        if (apply && repo.fillRaceTrackCondition(t.raceKey, page.trackCondition)) filled++;
      } catch (err: any) {
        skipped.push(`${label}: ${err?.message ?? err}`);
      }
      if ((i + 1) % 20 === 0) console.log(`[Fix] ${i + 1}/${targets.length}件を確認`);
    }
    const summary = Object.entries(counts).map(([k, v]) => `${k} ${v}件`).join('・') || 'なし';
    console.log(`[Fix] 結果ページで分かった馬場: ${summary}`);
    console.log(apply ? `[Fix] 書き込み: ${filled}件` : `[Fix] 試運転のため書き込みはしていません（--apply で書き込みます）`);
    console.log(`[Fix] 読めなかったレース: ${skipped.length}件`);
    for (const s of skipped.slice(0, 20)) console.log(`[Fix]   ${s}`);
    if (skipped.length > 20) console.log(`[Fix]   ほか${skipped.length - 20}件`);
  } catch (err: any) {
    console.error('[Fix] 失敗:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    db.close();
    releaseLock();
    console.log(`[Fix] end ${new Date().toISOString()}`);
  }
}

main();
