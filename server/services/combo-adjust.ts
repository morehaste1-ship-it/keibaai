/**
 * 組み合わせ補正（アプリの合計点で説明しきれない傾向を、データから学んで補う）
 *
 * npm run residual で「残る」と分かった傾向を、3つのグループの区分にまとめる。
 *  A 前走      : 前走1着・昇級 / 前走1着（昇級でない）/ 前走2〜3着 / 4〜5着 / 6〜9着 / 10着以下 / 初出走・未勝利戦 / 初出走（その他）
 *  B 間隔      : 半年以上の休み明け / 牝3〜4歳の10週〜半年の休み明け（どちらでもない馬は区分なし）
 *  C 距離と脚質: 距離延長（200m以上）で前走逃げ（それ以外は区分なし）
 * 1頭は各グループで多くても1つの区分に入る。
 *
 * 補正の大きさ（区分ごとの「実際の3着内率 − 合計点の順位から期待される3着内率」）は、
 * そのレースの月より前の記録だけで計算する（未来の結果を使わない）。
 * グループどうしの重なり（例: 半年以上の休み明けの馬は前走も負けていることが多い）を二重に数えないよう、
 * 1つのグループの補正を、他のグループの補正を差し引いたうえで計算し直すことを数回くり返す。
 * 件数の少ない区分は 0 に寄せる（件数 ÷ (件数 + SHRINK_K) を掛ける）。
 * 点数 = 50 + 補正の合計 × POINTS（10ポイント低いと −20点）。0〜100点に収める
 */
import { gradeFromRaceName, normalizeGrade } from './score-service';

export const COMBO_POINTS = 200;
export const COMBO_SHRINK_K = 200;
/** 補正を計算するのに必要な、それより前の頭数（少ないうちは補正しない） */
export const COMBO_MIN_ITEMS = 5000;
const FIT_ROUNDS = 4;

const CLASS_RANK: Record<string, number> = { 新馬: 0, 未勝利: 0, '1勝': 1, '2勝': 2, '3勝': 3, OP: 4, G3: 5, G2: 6, G1: 7 };

/** クラス（新馬・未勝利・1勝・2勝・3勝・OP・G3・G2・G1）。旧表記（500万下など）も読む。grade はレースのグレード欄 */
export function raceClassOf(raceName: string, grade?: string | null): string | null {
  const g = normalizeGrade(grade ?? null) ?? gradeFromRaceName(raceName);
  if (g === 'G1' || g === 'G2' || g === 'G3') return g;
  if (g === 'L' || g === 'OP') return 'OP';
  const s = raceName.normalize('NFKC');
  if (s.includes('新馬')) return '新馬';
  if (s.includes('未勝利')) return '未勝利';
  if (/1勝|500万/.test(s)) return '1勝';
  if (/2勝|1000万/.test(s)) return '2勝';
  if (/3勝|1600万/.test(s)) return '3勝';
  if (s.includes('オープン')) return 'OP';
  return null;
}

/** 区分を決めるのに使う情報（すべてレース前に分かること） */
export interface ComboInput {
  date: string;
  distance: number;
  raceName: string;
  grade: string | null;
  sex: string | null;
  age: number | null;
  /** 前走（その馬の、レース日より前の最後の走）。出走歴なしは null */
  prev: { date: string; raceName: string | null; distance: number | null; finish: number | null; style: string | null } | null;
}

export const COMBO_GROUPS = ['前走', '間隔', '距離と脚質'] as const;
export type ComboCells = [string | null, string | null, string | null];

export function comboCellsOf(x: ComboInput): ComboCells {
  const cls = raceClassOf(x.raceName, x.grade);
  if (!x.prev) return [cls === '未勝利' ? '初出走・未勝利戦' : '初出走', null, null];
  const p = x.prev;
  const prevCls = p.raceName ? raceClassOf(p.raceName) : null;
  let a: string | null = null;
  const f = p.finish !== null && p.finish > 0 ? p.finish : null;
  if (f === 1) a = cls && prevCls && CLASS_RANK[cls] > CLASS_RANK[prevCls] ? '前走1着・昇級' : '前走1着';
  else if (f !== null && f <= 3) a = '前走2〜3着';
  else if (f !== null && f <= 5) a = '前走4〜5着';
  else if (f !== null && f <= 9) a = '前走6〜9着';
  else if (f !== null) a = '前走10着以下';
  const days = Math.round((Date.parse(x.date) - Date.parse(p.date)) / 86400000);
  let b: string | null = null;
  if (days >= 183) b = '半年以上の休み明け';
  else if (days >= 70 && x.sex === '牝' && (x.age === 3 || x.age === 4)) b = '牝3〜4歳・10週〜半年の休み明け';
  const c = p.distance && x.distance - p.distance >= 200 && p.style === '逃げ' ? '距離延長・前走逃げ' : null;
  return [a, b, c];
}

/** 学習に使う1頭分 */
export interface FitItem {
  cells: ComboCells;
  /** 合計点の順位から期待される3着内率 */
  exp: number;
  top3: boolean;
}

/** 区分ごとの補正（3着内率の差。例: -0.076 = 7.6ポイント低い） */
export type ComboAdjust = Map<string, { adj: number; n: number }>;

export function fitComboAdjust(items: FitItem[]): ComboAdjust {
  const adj = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const it of items) for (const c of it.cells) if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  const other = (it: FitItem, g: number) => it.cells.reduce((s, c, i) => (i !== g && c ? s + (adj.get(c) ?? 0) : s), 0);
  for (let round = 0; round < FIT_ROUNDS; round++) {
    for (let g = 0; g < COMBO_GROUPS.length; g++) {
      const sum = new Map<string, number>();
      for (const it of items) {
        const c = it.cells[g];
        if (!c) continue;
        sum.set(c, (sum.get(c) ?? 0) + ((it.top3 ? 1 : 0) - (it.exp + other(it, g))));
      }
      for (const [c, s] of sum) {
        const n = counts.get(c)!;
        adj.set(c, (s / n) * (n / (n + COMBO_SHRINK_K)));
      }
    }
  }
  const out: ComboAdjust = new Map();
  for (const [c, a] of adj) out.set(c, { adj: a, n: counts.get(c) ?? 0 });
  return out;
}

/** 点数と説明。補正が無い（学習前）・区分に当たらない馬は 50点 */
export function comboScoreOf(cells: ComboCells, table: ComboAdjust | null): { score: number; hasData: boolean; detail: string } {
  if (!table) return { score: 50, hasData: false, detail: '補正を計算する記録がまだ足りません' };
  const parts: string[] = [];
  let sum = 0;
  for (const c of cells) {
    if (!c) continue;
    const a = table.get(c);
    if (!a) continue;
    sum += a.adj;
    parts.push(`${c} ${a.adj >= 0 ? '+' : ''}${(a.adj * 100).toFixed(1)}pt`);
  }
  const score = Math.max(0, Math.min(100, Math.round(50 + sum * COMBO_POINTS)));
  return {
    score,
    hasData: parts.length > 0,
    detail: parts.length ? `点数で説明しきれない傾向: ${parts.join('・')}` : '当てはまる傾向なし',
  };
}

/** 合計点の順位（10位以下はまとめる）と頭数の帯ごとの3着内率 */
export function expectationTable(rows: { rank: number; heads: number; top3: boolean }[]): (rank: number, heads: number) => number {
  const key = (r: number, h: number) => (h <= 8 ? 0 : h <= 12 ? 1 : h <= 16 ? 2 : 3) * 100 + Math.min(r, 10);
  const m = new Map<number, { n: number; t: number }>();
  for (const x of rows) {
    const k = key(x.rank, x.heads);
    const b = m.get(k) ?? { n: 0, t: 0 };
    b.n++;
    if (x.top3) b.t++;
    m.set(k, b);
  }
  const all = rows.length ? rows.filter((x) => x.top3).length / rows.length : 0;
  return (r, h) => {
    const b = m.get(key(r, h));
    return b && b.n > 0 ? b.t / b.n : all;
  };
}
