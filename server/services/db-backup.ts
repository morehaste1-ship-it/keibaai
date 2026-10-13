/**
 * DB の自動バックアップ
 *
 * - SQLite のバックアップ機能（db.backup）で、使用中でも安全にコピーする
 * - 保存先：data/backup/keiba-YYYYMMDD.sqlite（同じ日に2回取ると上書き）
 * - 直近 keep 日分を残し、それより古いバックアップ（このフォルダ内の keiba-YYYYMMDD.sqlite のみ）を削除する
 * - uploadOffsite：できたバックアップを rclone で Google ドライブ（gdrive:KeibaAI-backup）へも送る（Mac が壊れたとき用。直近3日分）
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import type { DB } from '../db/index';

export const BACKUP_KEEP = 7;
export const DEFAULT_BACKUP_DIR = process.env.KEIBA_BACKUP_DIR || path.resolve(process.cwd(), 'data', 'backup');
const NAME = /^keiba-(\d{8})\.sqlite$/;

const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

export async function backupDatabase(
  db: DB,
  dir: string = DEFAULT_BACKUP_DIR,
  keep: number = BACKUP_KEEP,
  now: Date = new Date(),
): Promise<{ file: string; bytes: number; removed: string[] }> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `keiba-${ymd(now)}.sqlite`);
  const tmp = `${file}.tmp`;
  // 途中で失敗しても前のバックアップを壊さないよう、一時ファイルに書いてから置き換える
  await db.backup(tmp);
  // コピーを1ファイルで完結する形（WAL を使わない形式）にしておく。戻すときはこの1ファイルをコピーするだけでよい
  const copy = new Database(tmp);
  copy.pragma('journal_mode = DELETE');
  copy.close();
  fs.renameSync(tmp, file);
  const bytes = fs.statSync(file).size;

  const backups = fs
    .readdirSync(dir)
    .filter((f) => NAME.test(f))
    .sort(); // 日付順（古い順）
  const removed = backups.slice(0, Math.max(0, backups.length - keep));
  for (const f of removed) {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = path.join(dir, f + suffix);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  return { file, bytes, removed };
}

// ---------------- Google ドライブへの写し（rclone） ----------------

/** 送り先（rclone のリモート名:フォルダ）。KEIBA_OFFSITE_REMOTE=off で送らない */
export const OFFSITE_REMOTE = process.env.KEIBA_OFFSITE_REMOTE || 'gdrive:KeibaAI-backup';
/** 送り先に残す日数（これより古い keiba-*.sqlite は送り先から消す） */
export const OFFSITE_KEEP_DAYS = 3;

export interface OffsiteResult {
  status: 'ok' | 'skipped' | 'failed';
  message: string;
}

type Runner = (args: string[]) => string;

/**
 * Google の許可（OAuth の token）が切れた・取り消されたときのエラーか。
 * 「テスト中」のアプリは7日で許可が切れるため、毎週 rclone config reconnect が必要
 */
export function isAuthExpired(text: string): boolean {
  return /invalid_grant|token (has been )?expired|expired or revoked|couldn't fetch token|empty token|unauthorized_client|reconnect/i.test(text);
}

/** rclone を実行する（launchd から動くときも見つかるよう、よく入る場所を PATH に足す） */
const defaultRunner: Runner = (args) => {
  const home = process.env.HOME ?? '';
  const PATH = [process.env.PATH ?? '', '/usr/local/bin', '/opt/homebrew/bin', `${home}/bin`].join(':');
  return execFileSync('rclone', args, { encoding: 'utf8', timeout: 10 * 60 * 1000, env: { ...process.env, PATH } });
};

/**
 * バックアップファイルを Google ドライブなど（rclone のリモート）へ送り、送り先の古いバックアップを消す。
 * rclone が無い・リモートが未設定・通信できないときは送らずに結果を返す（例外は投げない）
 */
export function uploadOffsite(file: string, remote: string = OFFSITE_REMOTE, run: Runner = defaultRunner): OffsiteResult {
  if (remote === 'off') return { status: 'skipped', message: '送らない設定です（KEIBA_OFFSITE_REMOTE=off）' };
  const remoteName = remote.split(':')[0];
  try {
    const remotes = run(['listremotes']).split('\n').map((s) => s.trim());
    if (!remotes.includes(`${remoteName}:`)) {
      return { status: 'skipped', message: `rclone に「${remoteName}」の設定がありません（rclone config で作成すると送ります）` };
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { status: 'skipped', message: 'rclone が入っていないため送りません' };
    return { status: 'failed', message: `rclone の確認に失敗しました（${String(err?.message ?? err).split('\n')[0]}）` };
  }
  try {
    run(['copy', file, remote]);
    run(['delete', remote, '--min-age', `${OFFSITE_KEEP_DAYS}d`, '--include', 'keiba-*.sqlite']);
    return { status: 'ok', message: `${remote} へ送りました（${OFFSITE_KEEP_DAYS}日より古いものは送り先から削除）` };
  } catch (err: any) {
    const text = String(err?.message ?? err);
    if (isAuthExpired(text)) {
      return {
        status: 'failed',
        message: `許可の期限切れです。ターミナルで rclone config reconnect ${remoteName}: を実行し、ブラウザで「許可」を押してください（次回の夜間実行から送れます）`,
      };
    }
    return { status: 'failed', message: `送れませんでした（${text.split('\n')[0]}）。次回の夜間実行で送り直します` };
  }
}
