/**
 * 配分の自動見直し（段階C）
 *
 * 記録した予想（前日・当日・検証用など）に保存した「項目ごとの点数」と確定した着順から、
 * 配分を変えたら着順をどれだけ当てられたかを計算し直して、よりよい配分を探す。
 *
 * - 物差し：3着以内に入った馬が、合計点の上位5頭に入った割合（%）
 * - レースを日付順に並べ、古い7割で配分を探し（学習用）、新しい3割で確かめる（確認用）
 * - 確認用でも今の配分を MIN_GAIN ポイント以上上回ったときだけ採用する（たまたま当たった配分を避けるため）
 * - 対象が MIN_RACES レース未満なら変えない。1回の見直しで各項目は今の配分から ±MAX_STEP まで
 * - 1つのレースに記録が複数あるときは、当日 > 前日 > 検証用 > 手動 の順に1つだけ使う（点数は配分によらないため）
 */
import type { PredictionRecord, RaceOutcome, RaceRepository, WeightVersion } from '../db/repository';
import { COMPONENT_KEYS } from '../../src/utils/dataScore';
import { DEFAULT_WEIGHTS, activeWeights } from './score-service';

export { activeWeights };

export const MIN_RACES = 50;
export const MAX_STEP = 5;
/** 確認用で今の配分を何ポイント上回れば採用するか */
export const MIN_GAIN = 0.5;
/** 確認用に回す割合と最低レース数 */
const HOLDOUT_SHARE = 0.3;
const MIN_HOLDOUT = 20;
/** 合計点の上位何頭を見るか */
const TOP_N = 5;

export type Weights = Record<string, number>;

export interface TuneSample {
  raceKey: string;
  date: string;
  horses: { horseNumber: number; scores: Record<string, number | null>; finish: number }[];
}

export interface TuneMetrics {
  /** 3着以内の馬が合計点の上位5頭に入った割合（%） */
  top3InTop5: number;
  /** 合計点1位の馬の複勝率（%） */
  firstTop3: number;
  races: number;
}

export interface TuneResult {
  adopted: boolean;
  /** 採用しなかった理由、または採用の説明 */
  message: string;
  current: Weights;
  candidate: Weights | null;
  train: { current: TuneMetrics; candidate: TuneMetrics | null } | null;
  holdout: { current: TuneMetrics; candidate: TuneMetrics | null } | null;
  races: number;
}

const PREFERENCE: Record<string, number> = { auto: 0, eve: 1, backtest: 2, manual: 3 };

/** 記録と結果から、見直し用のデータ（1レース1件）を作る */
export function buildSamples(rows: { record: PredictionRecord; outcome: RaceOutcome; date: string }[]): TuneSample[] {
  const byRace = new Map<string, { record: PredictionRecord; outcome: RaceOutcome; date: string }>();
  for (const r of rows) {
    const prev = byRace.get(r.record.raceKey);
    if (!prev || (PREFERENCE[r.record.source] ?? 9) < (PREFERENCE[prev.record.source] ?? 9)) byRace.set(r.record.raceKey, r);
  }
  const samples: TuneSample[] = [];
  for (const { record, outcome, date } of byRace.values()) {
    const finishByNo = new Map(outcome.finishes.map((f) => [f.horseNumber, f.finishPosition]));
    const horses = record.marks
      .filter((m) => m.scores && typeof finishByNo.get(m.horseNumber) === 'number')
      .map((m) => ({ horseNumber: m.horseNumber, scores: m.scores as Record<string, number | null>, finish: finishByNo.get(m.horseNumber) as number }));
    // 3着以内の馬がそろわないレース（取消が多い・点数が無いなど）は使わない
    if (horses.filter((h) => h.finish <= 3).length >= 3 && horses.length >= 5) samples.push({ raceKey: record.raceKey, date, horses });
  }
  return samples.sort((a, b) => a.date.localeCompare(b.date) || a.raceKey.localeCompare(b.raceKey));
}

/** 画面と同じ計算の合計点（データ不足の項目は中立50点、0.1点単位） */
function total(scores: Record<string, number | null>, w: Weights, wSum: number): number {
  let s = 0;
  for (const k of COMPONENT_KEYS) s += (scores[k] ?? 50) * Math.max(0, w[k] ?? 0);
  return Math.round((s / wSum) * 10) / 10;
}

export function evaluateWeights(samples: TuneSample[], w: Weights): TuneMetrics {
  const wSum = COMPONENT_KEYS.reduce((s, k) => s + Math.max(0, w[k] ?? 0), 0);
  let hit = 0;
  let top3Total = 0;
  let firstHit = 0;
  for (const smp of samples) {
    const ranked = smp.horses
      .map((h) => ({ h, t: wSum > 0 ? total(h.scores, w, wSum) : 0 }))
      .sort((a, b) => b.t - a.t || a.h.horseNumber - b.h.horseNumber);
    const top = ranked.slice(0, TOP_N);
    const top3 = smp.horses.filter((h) => h.finish <= 3);
    top3Total += top3.length;
    hit += top.filter((x) => x.h.finish <= 3).length;
    if (ranked[0] && ranked[0].h.finish <= 3) firstHit++;
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    top3InTop5: top3Total > 0 ? r1((hit / top3Total) * 100) : 0,
    firstTop3: samples.length > 0 ? r1((firstHit / samples.length) * 100) : 0,
    races: samples.length,
  };
}

/** 今の配分から各項目 ±MAX_STEP の範囲で、1ポイントずつ付け替えて学習用の成績がよくなる配分を探す */
export function searchWeights(train: TuneSample[], current: Weights): Weights {
  let best = { ...current };
  let bestScore = evaluateWeights(train, best).top3InTop5;
  for (let iter = 0; iter < MAX_STEP * COMPONENT_KEYS.length; iter++) {
    let improved: { w: Weights; score: number } | null = null;
    for (const from of COMPONENT_KEYS) {
      if ((best[from] ?? 0) <= 0 || (best[from] ?? 0) - 1 < (current[from] ?? 0) - MAX_STEP) continue;
      for (const to of COMPONENT_KEYS) {
        if (to === from || (best[to] ?? 0) + 1 > (current[to] ?? 0) + MAX_STEP) continue;
        const w = { ...best, [from]: best[from] - 1, [to]: (best[to] ?? 0) + 1 };
        const score = evaluateWeights(train, w).top3InTop5;
        if (score > (improved?.score ?? bestScore)) improved = { w, score };
      }
    }
    if (!improved) break;
    best = improved.w;
    bestScore = improved.score;
  }
  return best;
}

export function tuneWeights(samples: TuneSample[], current: Weights): TuneResult {
  const base: TuneResult = { adopted: false, message: '', current, candidate: null, train: null, holdout: null, races: samples.length };
  if (samples.length < MIN_RACES) {
    return { ...base, message: `結果がそろったレースが${samples.length}件のため見直しません（${MIN_RACES}件以上で見直します）` };
  }
  const holdN = Math.max(MIN_HOLDOUT, Math.round(samples.length * HOLDOUT_SHARE));
  const train = samples.slice(0, samples.length - holdN);
  const hold = samples.slice(samples.length - holdN);
  const candidate = searchWeights(train, current);
  const tc = evaluateWeights(train, current);
  const hc = evaluateWeights(hold, current);
  const same = COMPONENT_KEYS.every((k) => (candidate[k] ?? 0) === (current[k] ?? 0));
  if (same) {
    return { ...base, train: { current: tc, candidate: null }, holdout: { current: hc, candidate: null }, message: '今の配分より学習用の成績がよくなる配分が見つからなかったため、変えません' };
  }
  const tn = evaluateWeights(train, candidate);
  const hn = evaluateWeights(hold, candidate);
  const result = { ...base, candidate, train: { current: tc, candidate: tn }, holdout: { current: hc, candidate: hn } };
  if (hn.top3InTop5 >= hc.top3InTop5 + MIN_GAIN) {
    return {
      ...result,
      adopted: true,
      message: `直近${hold.length}レースで、3着以内の馬が上位5頭に入った割合が ${hc.top3InTop5}% → ${hn.top3InTop5}% に上がるため採用`,
    };
  }
  return {
    ...result,
    message: `学習用では上がったが、直近${hold.length}レースでは ${hc.top3InTop5}% → ${hn.top3InTop5}% で、${MIN_GAIN}ポイント以上上回らなかったため変えません`,
  };
}

/** 見直しを行い、採用するときは履歴に追加する（dryRun なら追加しない） */
export function runWeightReview(repo: RaceRepository, opts: { dryRun?: boolean } = {}): { result: TuneResult; version: WeightVersion | null } {
  const current = activeWeights(repo);
  const result = tuneWeights(buildSamples(repo.listScoredRecordsWithOutcome()), current);
  if (!result.adopted || !result.candidate || opts.dryRun) return { result, version: null };
  const version = repo.addWeightVersion({
    weights: result.candidate,
    reason: 'auto',
    note: result.message,
    metrics: { races: result.races, train: result.train, holdout: result.holdout, previous: current },
  });
  return { result, version };
}

/** 1つ前の配分に戻す（履歴には「戻した」行として追加する） */
export function revertWeights(repo: RaceRepository): WeightVersion {
  const versions = repo.listWeightVersions();
  if (versions.length === 0) throw new Error('戻せる履歴がありません（既定の配分を使っています）');
  const prevWeights = versions[1]?.weights ?? { ...DEFAULT_WEIGHTS };
  const label = versions[1] ? `${versions[1].adoptedAt.slice(0, 10)} の配分` : '既定の配分';
  return repo.addWeightVersion({ weights: prevWeights, reason: 'revert', note: `1つ前（${label}）に戻しました`, metrics: null });
}
