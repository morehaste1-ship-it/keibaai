/**
 * 取得処理の二重起動を防ぐロック（data/crawl.lock）
 *
 * 夜間ジョブ・手動スクリプト・画面からの取得が同時に netkeiba へアクセスしないようにする。
 * 同じプロセス内では何度取っても良い（画面から馬と騎手を同時に取る場合など）。
 * 持ち主のプロセスが終了していたら、古いロックとして取り直す。
 */
import fs from 'fs';
import path from 'path';

export const LOCK_PATH = process.env.KEIBA_LOCK_PATH || path.resolve(process.cwd(), 'data', 'crawl.lock');

export interface LockInfo {
  pid: number;
  owner: string;
  startedAt: string;
}

let heldCount = 0;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export function readLock(): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

/** 別のプロセスが取得中ならその情報、そうでなければ null */
export function lockHeldByOther(): LockInfo | null {
  const info = readLock();
  if (!info || info.pid === process.pid || !isAlive(info.pid)) return null;
  return info;
}

/** ロックを取る。別のプロセスが取得中なら false */
export function acquireLock(owner: string): boolean {
  if (heldCount > 0) {
    heldCount++;
    return true;
  }
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, owner, startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      heldCount = 1;
      return true;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      const info = readLock();
      if (info && info.pid !== process.pid && isAlive(info.pid)) return false;
      // 持ち主が終了している古いロック（または読めないロック）は取り除いて取り直す
      fs.rmSync(LOCK_PATH, { force: true });
    }
  }
  return false;
}

export function releaseLock(): void {
  if (heldCount === 0) return;
  heldCount--;
  if (heldCount > 0) return;
  const info = readLock();
  if (info && info.pid === process.pid) fs.rmSync(LOCK_PATH, { force: true });
}
