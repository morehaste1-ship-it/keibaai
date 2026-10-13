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
  // 実際の予想で成績が下がって自動で戻した配分は、もう一度採用しない
  if (result.adopted && result.candidate) {
    const same = (w: unknown) =>
      !!w && typeof w === 'object' && COMPONENT_KEYS.every((k) => ((w as Weights)[k] ?? 0) === (result.candidate![k] ?? 0));
    if (repo.listWeightVersions().some((v) => v.reason === 'auto-revert' && same((v.metrics as any)?.rejected))) {
      return {
        result: { ...result, adopted: false, message: `${result.message}。ただし、この配分は以前に実際の予想で成績が下がって自動で戻したため、採用しません` },
        version: null,
      };
    }
  }
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

// ---------------- 実際の予想の見張り（採用した配分で、前日・当日の予想の成績が下がっていないか） ----------------

/** 比べるのに必要な実際のレース数（今の版・前の版それぞれ） */
export const LIVE_MIN_RACES = 50;
/** 前の版よりこのポイント以上低ければ、自動で前の配分に戻す */
export const LIVE_MAX_DROP = 2;

export interface LiveStat {
  versionId: number;
  races: number;
  /** 3着以内の馬が、その予想の上位5頭に入った割合（%）。レースが無ければ null */
  top3InTop5: number | null;
}

/** 記録した時点で採用中だった配分の版（0 = 既定の配分）。版の番号を保存する前の記録に使う */
function versionAt(versionsAsc: WeightVersion[], recordedAt: string): number {
  let id = 0;
  for (const v of versionsAsc) if (v.adoptedAt <= recordedAt) id = v.id;
  return id;
}

/** 版ごとの実際の予想（当日の自動 > 前日予想、1レース1件）の成績 */
export function liveStatsByVersion(repo: RaceRepository): Map<number, LiveStat> {
  const versionsAsc = [...repo.listWeightVersions()].reverse();
  const byRace = new Map<string, { record: PredictionRecord; outcome: RaceOutcome }>();
  for (const r of repo.listScoredRecordsWithOutcome()) {
    if (r.record.source !== 'auto' && r.record.source !== 'eve') continue;
    const prev = byRace.get(r.record.raceKey);
    if (!prev || (prev.record.source === 'eve' && r.record.source === 'auto')) byRace.set(r.record.raceKey, r);
  }
  const acc = new Map<number, { races: number; hit: number; top3: number }>();
  for (const { record, outcome } of byRace.values()) {
    const finish = new Map(outcome.finishes.map((f) => [f.horseNumber, f.finishPosition]));
    const top3 = record.marks.filter((m) => {
      const p = finish.get(m.horseNumber);
      return typeof p === 'number' && p >= 1 && p <= 3;
    });
    if (top3.length < 3) continue;
    const vid = record.settings.weightsVersionId ?? versionAt(versionsAsc, record.recordedAt);
    const a = acc.get(vid) ?? { races: 0, hit: 0, top3: 0 };
    a.races++;
    a.top3 += top3.length;
    a.hit += top3.filter((m) => m.rank <= TOP_N).length;
    acc.set(vid, a);
  }
  const out = new Map<number, LiveStat>();
  for (const [vid, a] of acc) out.set(vid, { versionId: vid, races: a.races, top3InTop5: a.top3 > 0 ? Math.round((a.hit / a.top3) * 1000) / 10 : null });
  return out;
}

export interface LiveCheckResult {
  reverted: boolean;
  message: string;
  current: LiveStat | null;
  previous: LiveStat | null;
  version: WeightVersion | null;
}

/**
 * 今の版の実際の成績が、前の版より LIVE_MAX_DROP ポイント以上低ければ、自動で前の配分に戻す（履歴に「自動で戻した」として残す）。
 * 今の版が「戻した」配分のとき・どちらかのレースが LIVE_MIN_RACES 未満のときは何もしない
 */
export function runLiveCheck(repo: RaceRepository, opts: { dryRun?: boolean } = {}): LiveCheckResult {
  const versions = repo.listWeightVersions();
  const none = (message: string, current: LiveStat | null = null, previous: LiveStat | null = null): LiveCheckResult => ({ reverted: false, message, current, previous, version: null });
  if (versions.length === 0) return none('既定の配分のままのため、比べる版がありません');
  const cur = versions[0];
  if (cur.reason === 'revert' || cur.reason === 'auto-revert') return none('今の配分は「戻した」配分のため、比べません');
  const prevId = versions[1]?.id ?? 0;
  const stats = liveStatsByVersion(repo);
  const c = stats.get(cur.id) ?? { versionId: cur.id, races: 0, top3InTop5: null };
  const p = stats.get(prevId) ?? { versionId: prevId, races: 0, top3InTop5: null };
  if (c.races < LIVE_MIN_RACES || p.races < LIVE_MIN_RACES || c.top3InTop5 === null || p.top3InTop5 === null) {
    return none(`実際のレースが足りないため比べません（今の版 ${c.races}レース・前の版 ${p.races}レース。それぞれ${LIVE_MIN_RACES}レース以上で比べます）`, c, p);
  }
  if (c.top3InTop5 > p.top3InTop5 - LIVE_MAX_DROP) {
    return none(`問題なし（実際の成績：前の版 ${p.top3InTop5}% → 今の版 ${c.top3InTop5}%）`, c, p);
  }
  const message = `実際の予想で成績が下がったため、前の配分に自動で戻しました（3着以内の馬が上位5頭に入った割合：前の版 ${p.top3InTop5}%・${p.races}レース → 今の版 ${c.top3InTop5}%・${c.races}レース）`;
  if (opts.dryRun) return { reverted: false, message: `${message}（--dry のため戻していません）`, current: c, previous: p, version: null };
  const version = repo.addWeightVersion({
    weights: versions[1]?.weights ?? { ...DEFAULT_WEIGHTS },
    reason: 'auto-revert',
    note: message,
    metrics: { live: { current: c, previous: p }, rejected: cur.weights },
  });
  return { reverted: true, message, current: c, previous: p, version };
}
