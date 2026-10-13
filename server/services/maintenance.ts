/**
 * 保守：ディスクの空き・DB の大きさの確認と、ページの写し（data/cache）の整理
 *
 * - ディスクの空きが MIN_FREE_BYTES を切ったら、夜間ジョブ・過去レースの取り込みを止める
 * - DB が直近のバックアップより極端に小さければ（消えて作り直された疑い）、夜間ジョブを止める
 *   （空の DB をバックアップして、正しいバックアップを古い順の削除で押し出さないため）
 * - ページの写しは CACHE_KEEP_DAYS 日より古いものを消す（同じページを何度も取りに行かないための一時ファイル。予想のデータには影響しない）
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export const MIN_FREE_BYTES = 2 * 1024 ** 3;
export const CACHE_KEEP_DAYS = 7;
/** バックアップに対して、今の DB がこの割合より小さければ異常とみなす */
const DB_SHRINK_RATIO = 0.5;
/** これより小さいバックアップとは比べない（始めたばかりの DB など） */
const DB_CHECK_MIN_BACKUP = 5 * 1024 ** 2;

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)}GB`;
const mb = (b: number) => `${(b / 1024 ** 2).toFixed(1)}MB`;

/** 指定パスのディスクの空き（バイト）。取れなければ null */
export function freeDiskBytes(p: string = process.cwd()): number | null {
  try {
    const anyFs = fs as any;
    if (typeof anyFs.statfsSync === 'function') {
      const s = anyFs.statfsSync(p);
      return Number(s.bavail) * Number(s.bsize);
    }
    const out = execSync(`df -k "${p}"`, { encoding: 'utf8' }).trim().split('\n').pop() ?? '';
    const avail = Number(out.split(/\s+/)[3]);
    return Number.isFinite(avail) ? avail * 1024 : null;
  } catch {
    return null;
  }
}

/** 空きが足りなければ理由の文を返す（足りていれば null） */
export function diskShortage(p: string = process.cwd(), min = MIN_FREE_BYTES): string | null {
  const free = freeDiskBytes(p);
  if (free === null || free >= min) return null;
  return `Mac の空き容量が ${gb(free)} しかありません（${gb(min)} 未満）。容量を空けてから再開してください（data/keiba.sqlite と data/backup は消さないでください）`;
}

/** DB（本体＋WAL）が直近のバックアップより極端に小さければ理由の文を返す */
export function dbShrinkProblem(dbPath: string, backupDir: string): string | null {
  try {
    if (!fs.existsSync(backupDir)) return null;
    const latest = fs
      .readdirSync(backupDir)
      .filter((f) => /^keiba-\d{8}\.sqlite$/.test(f))
      .sort()
      .pop();
    if (!latest) return null;
    const backupBytes = fs.statSync(path.join(backupDir, latest)).size;
    if (backupBytes < DB_CHECK_MIN_BACKUP) return null;
    const size = (f: string) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
    const current = size(dbPath) + size(`${dbPath}-wal`);
    if (current >= backupBytes * DB_SHRINK_RATIO) return null;
    return (
      `データベース（${mb(current)}）が直近のバックアップ ${latest}（${mb(backupBytes)}）より極端に小さくなっています。` +
      `消えて作り直された可能性があるため処理を止めました。バックアップから戻すか、問題がなければ KEIBA_SKIP_DB_CHECK=1 を付けて実行してください`
    );
  } catch {
    return null;
  }
}

/** ページの写しのうち、keepDays 日より古いものを消す */
export function pruneCache(dir: string, keepDays = CACHE_KEEP_DAYS, now = Date.now()): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(dir)) return { files, bytes };
  const limit = now - keepDays * 24 * 3600 * 1000;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(bin|json)$/.test(f)) continue;
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isFile() && st.mtimeMs < limit) {
      fs.unlinkSync(p);
      files++;
      bytes += st.size;
    }
  }
  return { files, bytes };
}
