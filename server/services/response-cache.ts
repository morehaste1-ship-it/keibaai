/**
 * 重い集計（答え合わせ・配分の履歴）の結果を使い回す
 *
 * 予想の記録・結果・配分の版が変わったとき（dataSignature が変わったとき）だけ計算し直す。
 * 記録の中身だけが書き換わる場合（予想の付け直しなど）に備え、MAX_AGE_MS を過ぎたら計算し直す。
 * 画面から記録・結果・配分を変える操作のあとは clear() で捨てる。
 */
import type { DB } from '../db/index';

const MAX_AGE_MS = 30 * 60 * 1000;

/** 予想の記録・結果・配分の版の「変わったかどうか」の目印（件数と最新の時刻。読むだけ・軽い） */
export function dataSignature(db: DB): string {
  const r = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) || '/' || IFNULL(MAX(recorded_at), '') FROM prediction_records) AS rec,
         (SELECT COUNT(*) || '/' || IFNULL(MAX(fetched_at), '') FROM race_outcomes) AS out,
         (SELECT COUNT(*) || '/' || IFNULL(MAX(id), 0) FROM weight_versions) AS ver`,
    )
    .get() as { rec: string; out: string; ver: string };
  return `${r.rec}|${r.out}|${r.ver}`;
}

export class ResponseCache {
  private readonly entries = new Map<string, { sig: string; at: number; value: unknown }>();

  constructor(private readonly db: DB) {}

  /** key ごとに、目印が同じで新しければ前回の結果、そうでなければ compute() の結果を返す */
  get<T>(key: string, compute: () => T): T {
    const sig = dataSignature(this.db);
    const hit = this.entries.get(key);
    if (hit && hit.sig === sig && Date.now() - hit.at < MAX_AGE_MS) return hit.value as T;
    const value = compute();
    this.entries.set(key, { sig, at: Date.now(), value });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
