/**
 * 位置どりの分析（コースの位置どりの有利不利・騎手の位置どりの癖・馬場傾向）
 *
 * - 位置は「4角（最後のコーナー）の位置 ÷ 頭数」で 0（先頭）〜1（最後方）に直し、前・中・後の3つに分ける
 * - どれもレース日より前のデータだけを使う（当日のレース結果は使わない）
 * - DB は読むだけ
 */
import type { HorseRunRecord, RaceRepository } from '../db/repository';
import { cutoffDate, frameGroupOf } from './jockey-service';

export type PosGroup = '前' | '中' | '後';
export const POS_GROUPS: PosGroup[] = ['前', '中', '後'];
const GROUP_CENTER: Record<PosGroup, number> = { 前: 1 / 6, 中: 1 / 2, 後: 5 / 6 };

/** 通過順（例 "6-7-7-3"）の最後のコーナーの位置 */
export function lastCornerOf(passing: string | null | undefined): number | null {
  if (!passing) return null;
  const nums = passing
    .split('-')
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
  return nums.length > 0 ? nums[nums.length - 1] : null;
}

/** 位置 → 0（先頭）〜1（最後方） */
export function positionRatio(pos: number, headcount: number): number {
  if (headcount <= 1) return 0;
  return Math.max(0, Math.min(1, (pos - 1) / (headcount - 1)));
}

export function groupOf(ratio: number): PosGroup {
  if (ratio <= 1 / 3) return '前';
  if (ratio <= 2 / 3) return '中';
  return '後';
}

function smooth(top3: number, n: number, prior: number, k: number): number {
  return (top3 + prior * k) / (n + k);
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

/** 馬のふだんの位置（直近10走の4角の位置の平均。2走未満なら null） */
export function usualRatio(runs: HorseRunRecord[]): { ratio: number; n: number } | null {
  const rs = runs
    .slice(0, 10)
    .map((r) => {
      const c = lastCornerOf(r.passing);
      return c !== null && r.headcount ? positionRatio(c, r.headcount) : null;
    })
    .filter((x): x is number => x !== null);
  if (rs.length < 2) return null;
  return { ratio: rs.reduce((a, b) => a + b, 0) / rs.length, n: rs.length };
}

// ---------- コースの位置どりの有利不利 ----------

export interface CourseBias {
  /** 集計に使った走数と馬場（null = 全馬場） */
  n: number;
  condition: string | null;
  overall: number;
  groups: Record<PosGroup, { n: number; top3: number; rate: number }>;
  /** 位置（0〜1）での3着以内率（前・中・後の中心の間を直線で補う） */
  rateAt: (ratio: number) => number;
}

const COURSE_YEARS = 5;
const COURSE_MIN_RUNS = 150;
const COURSE_CONDITION_MIN_RUNS = 300;
const COURSE_K = 50;

export function courseBias(
  repo: RaceRepository,
  race: { venueName: string; surface: string; distance: number; date: string },
  condition: string | null,
): CourseBias | null {
  if (!race.surface || race.surface === '障害' || !race.distance) return null;
  const all = repo.coursePositionRuns(
    { venue: race.venueName, surface: race.surface, distance: race.distance },
    cutoffDate(COURSE_YEARS, new Date(`${race.date}T00:00:00`)),
    race.date,
  );
  const sameCond = condition ? all.filter((r) => r.condition === condition) : [];
  const useCond = sameCond.length >= COURSE_CONDITION_MIN_RUNS;
  const rows = useCond ? sameCond : all;
  if (rows.length < COURSE_MIN_RUNS) return null;
  const counts: Record<PosGroup, { n: number; top3: number }> = { 前: { n: 0, top3: 0 }, 中: { n: 0, top3: 0 }, 後: { n: 0, top3: 0 } };
  let n = 0;
  let top3 = 0;
  for (const r of rows) {
    const c = lastCornerOf(r.passing);
    if (c === null) continue;
    const g = groupOf(positionRatio(c, r.headcount));
    counts[g].n++;
    n++;
    if (r.finish >= 1 && r.finish <= 3) {
      counts[g].top3++;
      top3++;
    }
  }
  if (n < COURSE_MIN_RUNS || top3 === 0) return null;
  const overall = top3 / n;
  const groups = Object.fromEntries(
    POS_GROUPS.map((g) => [g, { ...counts[g], rate: smooth(counts[g].top3, counts[g].n, overall, COURSE_K) }]),
  ) as CourseBias['groups'];
  const rateAt = (ratio: number) => {
    const x = Math.max(GROUP_CENTER.前, Math.min(GROUP_CENTER.後, ratio));
    const [a, b] = x <= GROUP_CENTER.中 ? (['前', '中'] as const) : (['中', '後'] as const);
    const t = (x - GROUP_CENTER[a]) / (GROUP_CENTER[b] - GROUP_CENTER[a]);
    return groups[a].rate + (groups[b].rate - groups[a].rate) * t;
  };
  return { n, condition: useCond ? condition : null, overall, groups, rateAt };
}

// ---------- 騎手の位置どりの癖 ----------

type PositionRow = { horseId: string; date: string; jockeyId: string | null; passing: string; headcount: number };
let rowCache: { rows: PositionRow[]; loadedAt: number } | null = null;
const tendencyCache = new Map<string, Map<string, { sum: number; n: number }>>();
const ROW_CACHE_MS = 60 * 60 * 1000;

/**
 * 騎手ごとの「その騎手が乗った走の4角の位置 − 同じ馬の前走の4角の位置」の合計と回数（マイナス = 前に行かせる）。
 * 指定日の月の1日より前の走で計算し、月ごとに使い回す
 */
export function jockeyTendencies(repo: RaceRepository, raceDate: string): Map<string, { sum: number; n: number }> {
  if (!rowCache || Date.now() - rowCache.loadedAt > ROW_CACHE_MS) {
    rowCache = { rows: repo.listPositionRows(), loadedAt: Date.now() };
    tendencyCache.clear();
  }
  const key = raceDate.slice(0, 7);
  const cached = tendencyCache.get(key);
  if (cached) return cached;
  const before = `${key}-01`;
  const out = new Map<string, { sum: number; n: number }>();
  const rows = rowCache.rows;
  for (let i = 1; i < rows.length; i++) {
    const cur = rows[i];
    const prev = rows[i - 1];
    if (cur.horseId !== prev.horseId || cur.date >= before || !cur.jockeyId) continue;
    const c = lastCornerOf(cur.passing);
    const p = lastCornerOf(prev.passing);
    if (c === null || p === null) continue;
    const d = positionRatio(c, cur.headcount) - positionRatio(p, prev.headcount);
    const t = out.get(cur.jockeyId) ?? { sum: 0, n: 0 };
    t.sum += d;
    t.n++;
    out.set(cur.jockeyId, t);
  }
  tendencyCache.set(key, out);
  return out;
}

/** 騎手の癖を馬の位置に足すときの補正の強さ（騎乗数が少ない騎手は0に寄せる） */
export const TENDENCY_K = 50;

// ---------- 馬場傾向（前・中・後と内・中・外枠の偏り） ----------

export interface TrackBias {
  races: number;
  /** 3着以内の馬の割合 ÷ 出走馬全体の割合（1より大きいほど有利。補正済み） */
  posLift: Record<PosGroup, number>;
  frameLift: Record<string, number>;
  /** 3着以内の馬の内訳（件数） */
  top3Pos: Record<PosGroup, number>;
  top3Frame: Record<string, number>;
  label: string;
}

const FRAME_GROUPS = ['内枠(1-3)', '中枠(4-6)', '外枠(7-8)'];
const BIAS_K = 10;
const BIAS_STRONG = 1.25;

export function summarizeBias(outcomes: ReturnType<RaceRepository['listCourseOutcomes']>): TrackBias | null {
  const valid = outcomes.filter((o) => o.horses.some((h) => h.corner4 !== null));
  if (valid.length === 0) return null;
  const allPos: Record<PosGroup, number> = { 前: 0, 中: 0, 後: 0 };
  const topPos: Record<PosGroup, number> = { 前: 0, 中: 0, 後: 0 };
  const allFrame: Record<string, number> = {};
  const topFrame: Record<string, number> = {};
  let allN = 0;
  let topN = 0;
  let allF = 0;
  let topF = 0;
  for (const o of valid) {
    for (const h of o.horses) {
      if (h.finish === null) continue;
      const isTop = h.finish >= 1 && h.finish <= 3;
      if (h.corner4 !== null && o.headcount > 1) {
        const g = groupOf(positionRatio(h.corner4, o.headcount));
        allPos[g]++;
        allN++;
        if (isTop) {
          topPos[g]++;
          topN++;
        }
      }
      const fg = frameGroupOf(h.frame);
      if (fg) {
        allFrame[fg] = (allFrame[fg] ?? 0) + 1;
        allF++;
        if (isTop) {
          topFrame[fg] = (topFrame[fg] ?? 0) + 1;
          topF++;
        }
      }
    }
  }
  if (allN === 0 || topN === 0) return null;
  const rate = topN / allN;
  const posLift = Object.fromEntries(POS_GROUPS.map((g) => [g, smooth(topPos[g], allPos[g], rate, BIAS_K) / rate])) as Record<PosGroup, number>;
  const fRate = allF > 0 ? topF / allF : rate;
  const frameLift = Object.fromEntries(
    FRAME_GROUPS.map((g) => [g, fRate > 0 ? smooth(topFrame[g] ?? 0, allFrame[g] ?? 0, fRate, BIAS_K) / fRate : 1]),
  );
  const labels: string[] = [];
  if (posLift.前 >= BIAS_STRONG) labels.push('前残り');
  else if (posLift.後 >= BIAS_STRONG) labels.push('差し・追込有利');
  if (frameLift['内枠(1-3)'] >= BIAS_STRONG) labels.push('内枠有利');
  else if (frameLift['外枠(7-8)'] >= BIAS_STRONG) labels.push('外枠有利');
  return {
    races: valid.length,
    posLift,
    frameLift,
    top3Pos: topPos,
    top3Frame: topFrame,
    label: valid.length < 3 ? 'レース数が少ない（参考）' : labels.length > 0 ? labels.join('・') : '目立った偏りなし',
  };
}

/** 馬場傾向の要約文（例：3着内 前5・中3・後1頭（前1.4倍）／内枠1.3倍 → 前残り・内枠有利） */
export function biasText(b: TrackBias): string {
  const lift = (x: number) => `${x.toFixed(1)}倍`;
  return (
    `${b.races}R・3着内 前${b.top3Pos.前}・中${b.top3Pos.中}・後${b.top3Pos.後}頭（前${lift(b.posLift.前)}・後${lift(b.posLift.後)}）` +
    `／内枠${lift(b.frameLift['内枠(1-3)'])}・外枠${lift(b.frameLift['外枠(7-8)'])} → ${b.label}`
  );
}

export { pct as formatPct };
