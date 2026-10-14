/**
 * 予想の答え合わせ
 *
 * - 予想の記録：eve = 前日予想（前日の深夜に全レース・予想オッズ）、auto = 当日の自動記録（朝9:30に全レース、12時に重賞を昼のオッズで上書き）、
 *   manual = 画面の「この予想を記録」（今の配分）。eve・auto は既定の配分
 *   どちらも、画面と同じ関数（点数→印→3連単の買い目）で計算して保存する
 * - 結果の取り込み：確定した着順と3連単の払戻
 * - 答え合わせ：印の着順、3連単の的中・回収率（1点100円で買ったと仮定）
 */
import type { PredictionRecord, RaceOutcome, RaceRepository } from '../db/repository';
import type { NetkeibaSource } from '../sources/netkeiba';
import { DEFAULT_HORSE_K, DEFAULT_JOCKEY_K, DEFAULT_WEIGHTS, MAX_HORSE_K, MAX_JOCKEY_K, activeWeights, type ScoreService } from './score-service';
import { COMPONENT_KEYS, normalizeTo100, rankAndMark, type ShortageMode, type Weights } from '../../src/utils/dataScore';
import { buildPlans, forecastPace } from '../../src/utils/trifecta';
import { COMPONENT_LABELS } from '../../src/utils/dataScore';

export type RecordSource = PredictionRecord['source'];
export type Settings = PredictionRecord['settings'];

const CONDITIONS = ['良', '稍重', '重', '不良'];
const SHORTAGE_MODES: ShortageMode[] = ['keep', 'exclude', 'lower'];
const TICKET_PRICE = 100;
/** 答え合わせの対象：重賞のみ／全レース */
export type ReviewScope = 'graded' | 'all';
const GRADED = ['GI', 'GII', 'GIII', 'G1', 'G2', 'G3'];
/** 一覧に返す記録の上限（全レースだと週に100件前後増えるため。集計は全件） */
export const REVIEW_ROW_LIMIT = 200;
/** 印の集計対象 */
export const REVIEW_MARKS = ['◎', '◯', '▲', '☆'] as const;
export const PLAN_KINDS = ['本命', '中穴', '大穴'] as const;

/** 画面から送られた設定を確かめる（不正なら理由を返す） */
export function validateSettings(input: any): { settings?: Settings; error?: string } {
  if (!input || typeof input !== 'object') return { error: '設定がありません' };
  const weights: Record<string, number> = {};
  for (const k of COMPONENT_KEYS) {
    const v = input.weights?.[k];
    if (!Number.isInteger(v) || v < 0 || v > 100) return { error: `配分（${k}）は0〜100の整数で指定してください` };
    weights[k] = v;
  }
  const { horseK, jockeyK, shortageMode, condition } = input;
  if (!Number.isInteger(horseK) || horseK < 0 || horseK > MAX_HORSE_K) return { error: 'horseK が不正です' };
  if (!Number.isInteger(jockeyK) || jockeyK < 0 || jockeyK > MAX_JOCKEY_K) return { error: 'jockeyK が不正です' };
  if (!SHORTAGE_MODES.includes(shortageMode)) return { error: 'データ不足の扱いが不正です' };
  if (!CONDITIONS.includes(condition)) return { error: '馬場は 良・稍重・重・不良 のいずれかです' };
  return { settings: { weights, horseK, jockeyK, shortageMode, condition } };
}

/** 結果の詳細（4角・上がり・馬体重・ペース）を持つ取り込みの版。これ未満の結果は夜間に取り込み直す */
export const OUTCOME_DETAIL_VERSION = 2;

/** 上がり3Fの順位（速い順。同タイムは同順位。記録が無い馬は null） */
export function last3fRankOf(rows: { last3f: number | null }[], v: number | null): number | null {
  if (v === null) return null;
  return rows.filter((r) => r.last3f !== null && (r.last3f as number) < v).length + 1;
}

/** 発走時刻（ローカル時刻）。不明なら null */
function postTimeOf(date: string, postTime: string | null): Date | null {
  if (!postTime || !/^\d{1,2}:\d{2}$/.test(postTime)) return null;
  const [h, m] = postTime.split(':').map(Number);
  const d = new Date(`${date}T00:00:00`);
  d.setHours(h, m, 0, 0);
  return d;
}

export class ReviewService {
  constructor(
    private repo: RaceRepository,
    private scoreService: ScoreService,
    private source: NetkeibaSource,
  ) {}

  /**
   * 設定どおりに印と買い目を計算して記録する
   * 検証用（backtest）は終わったレースを予想し直すため、発走時刻・結果の有無の確認をしない
   * （点数はレース日より前の成績だけで計算されるため、結果は混ざらない）
   */
  record(raceKey: string, source: RecordSource, settings: Settings, now = new Date()): PredictionRecord {
    const race = this.repo.getRace(raceKey);
    if (!race) throw new Error('対象レースが未登録です');
    if (source !== 'backtest') {
      if (this.repo.getRaceOutcome(raceKey)) throw new Error('結果を取り込み済みのため、記録し直せません');
      const post = postTimeOf(race.date, race.postTime);
      const raceDay = new Date(`${race.date}T23:59:59`);
      if ((post && now >= post) || (!post && now > raceDay)) throw new Error('発走時刻を過ぎたため記録できません');
    }

    const score = this.scoreService.compute(raceKey, settings.condition ?? undefined, {
      horseK: settings.horseK,
      jockeyK: settings.jockeyK,
    });
    const ranked = rankAndMark(score.items as any, settings.weights as Weights, settings.shortageMode as ShortageMode);
    const plans = buildPlans(ranked);
    const pace = forecastPace(ranked, score.historyCorner);
    // 使ったオッズの段階（いちばん新しく取得したオッズの種類）
    const latestOdds = this.repo
      .getLatestWinOdds(raceKey)
      .reduce<{ fetchedAt: string; kind: 'final' | 'live' | 'forecast' } | null>((a, o) => (!a || o.fetchedAt > a.fetchedAt ? o : a), null);
    const rec: PredictionRecord = {
      raceKey,
      source,
      recordedAt: now.toISOString(),
      settings: {
        ...settings,
        paceForecast: { pace: pace.pace, favored: pace.favored },
        oddsKind: latestOdds?.kind ?? null,
        weightsVersionId: this.repo.getActiveWeightVersion()?.id ?? 0,
      },
      marks: ranked
        .filter((r) => r.horseNumber !== null)
        .map((r) => ({
          horseNumber: r.horseNumber as number,
          horseName: r.horseName,
          mark: r.mark,
          rank: r.rank,
          total: r.total,
          popularity: r.popularity,
          mainStyle: r.mainStyle,
          firstCornerRatio: r.firstCornerAvg?.ratio ?? null,
          scores: Object.fromEntries(COMPONENT_KEYS.map((k) => [k, r.components[k].hasData ? r.components[k].score : null])),
        })),
      plans: plans.map((p) => ({ kind: p.kind, available: p.available, reason: p.reason, tickets: p.tickets })),
    };
    this.repo.savePredictionRecord(rec);
    return rec;
  }

  /**
   * 既定の設定で記録する（auto = 当日朝・昼の自動記録、eve = 前日予想）。馬場はレース情報の馬場（無ければ良）
   */
  recordAuto(raceKey: string, now = new Date(), source: 'auto' | 'eve' | 'backtest' = 'auto'): PredictionRecord {
    const race = this.repo.getRace(raceKey);
    const condition = race?.trackCondition && CONDITIONS.includes(race.trackCondition) ? race.trackCondition : '良';
    return this.record(
      raceKey,
      source,
      { weights: activeWeights(this.repo), horseK: DEFAULT_HORSE_K, jockeyK: DEFAULT_JOCKEY_K, shortageMode: 'keep', condition },
      now,
    );
  }

  /**
   * 確定した結果を取り込む（1レース1ページ）
   * @param opts.saveFinalOdds 結果ページの確定単勝オッズ・人気も保存する（過去レースの検証用）
   */
  async fetchOutcome(raceKey: string, opts: { saveFinalOdds?: boolean } = {}): Promise<RaceOutcome> {
    const raceId = this.repo.findRaceSourceId(raceKey, 'netkeiba');
    if (!raceId) throw new Error('取得元のレースIDが未登録です');
    const { result, trifecta, payouts } = await this.source.fetchRaceOutcome(raceId);
    if (opts.saveFinalOdds) {
      const fetchedAt = new Date().toISOString();
      this.repo.saveWinOdds({
        raceRef: { source: 'netkeiba', id: raceId },
        odds: result.rows.map((r) => ({ horseNumber: r.horseNumber, winOdds: r.winOdds ?? null, popularity: r.popularity, fetchedAt, kind: 'final' as const })),
      });
    }
    const outcome: RaceOutcome = {
      raceKey,
      finishes: result.rows.map((r) => ({
        horseNumber: r.horseNumber,
        horseName: r.horseName,
        finishPosition: r.finishPosition,
        finishText: r.finishText,
        popularity: r.popularity,
        corner4: r.corner4,
        last3f: r.last3f,
        last3fRank: last3fRankOf(result.rows, r.last3f),
        bodyWeightDiff: r.bodyWeightDiff,
      })),
      trifecta,
      payouts,
      meta: { pace: result.pace, headcount: result.headcount, detailVersion: OUTCOME_DETAIL_VERSION },
      fetchedAt: new Date().toISOString(),
    };
    this.repo.saveRaceOutcome(outcome);
    // 前日の出馬表では馬場が未発表のことがあるため、レースの馬場が空なら結果ページの馬場で埋める（入っていれば上書きしない）
    if (result.trackCondition) this.repo.fillRaceTrackCondition(raceKey, result.trackCondition);
    return outcome;
  }

  /** 記録済み・結果未取得のレースの結果をまとめて取り込む（夜間ジョブ用） */
  async fetchPendingOutcomes(untilDate: string): Promise<{ total: number; success: number; errors: string[] }> {
    // 結果が未取得のレースと、ずれの分析用の情報（4角・上がり・ペース）が無い古い結果のレースを取り込む
    const keys = this.repo.listRecordedRaceKeysUntil(untilDate).filter((k) => {
      const o = this.repo.getRaceOutcome(k);
      return !o || (o.meta?.detailVersion ?? 0) < OUTCOME_DETAIL_VERSION;
    });
    const errors: string[] = [];
    let success = 0;
    for (const k of keys) {
      try {
        await this.fetchOutcome(k);
        success++;
      } catch (err: any) {
        if (err?.name === 'RateLimitedError') throw err;
        errors.push(`${k}: ${err?.message ?? err}`);
      }
    }
    return { total: keys.length, success, errors };
  }

  /**
   * 分析用の情報（脚質・項目の点数・展開予想）を保存する前の記録には、今の点数で補って分析する。
   * 印・買い目は記録のまま。補った記録は settings.analysisBasis = 'recomputed' とする
   */
  private withAnalysisData(rec: PredictionRecord, outcome: RaceOutcome | null): PredictionRecord {
    if (!outcome || rec.marks.some((m) => m.scores)) return rec;
    try {
      const score = this.scoreService.compute(rec.raceKey, rec.settings.condition ?? undefined, { horseK: rec.settings.horseK, jockeyK: rec.settings.jockeyK });
      const ranked = rankAndMark(score.items as any, rec.settings.weights as Weights, rec.settings.shortageMode as ShortageMode);
      const byNo = new Map(ranked.map((r) => [r.horseNumber, r]));
      const pace = forecastPace(ranked, score.historyCorner);
      return {
        ...rec,
        settings: { ...rec.settings, paceForecast: { pace: pace.pace, favored: pace.favored }, analysisBasis: 'recomputed' } as any,
        marks: rec.marks.map((m) => {
          const r = byNo.get(m.horseNumber);
          return r
            ? {
                ...m,
                mainStyle: r.mainStyle,
                firstCornerRatio: r.firstCornerAvg?.ratio ?? null,
                scores: Object.fromEntries(COMPONENT_KEYS.map((k) => [k, r.components[k].hasData ? r.components[k].score : null])),
              }
            : m;
        }),
      };
    } catch {
      return rec;
    }
  }

  /**
   * 記録の答え合わせと集計
   * @param scope graded = 重賞のみ（既定）／all = 全レース
   */
  review(scope: ReviewScope = 'graded'): ReviewResult {
    const rows = this.repo.listPredictionRecords().flatMap((rec) => {
      const race = this.repo.getRace(rec.raceKey);
      if (scope === 'graded' && !(race && GRADED.includes(race.grade ?? ''))) return [];
      const outcome = this.repo.getRaceOutcome(rec.raceKey);
      return evaluate(this.withAnalysisData(rec, outcome), outcome, race ? { name: race.name, date: race.date, venueName: race.venueName, raceNo: race.raceNo } : null);
    });
    // 検証用（過去レースの予想し直し）は数が多いため一覧には出さず、集計だけに使う
    const listed = rows.filter((r) => r.source !== 'backtest');
    return {
      scope,
      totalRows: listed.length,
      rows: listed.slice(0, REVIEW_ROW_LIMIT),
      summary: {
        backtest: summarize(rows.filter((r) => r.source === 'backtest')),
        eve: summarize(rows.filter((r) => r.source === 'eve')),
        auto: summarize(rows.filter((r) => r.source === 'auto')),
        manual: summarize(rows.filter((r) => r.source === 'manual')),
      },
    };
  }
}

// ---------------- 答え合わせ（計算のみ） ----------------

export interface ReviewRow {
  raceKey: string;
  source: RecordSource;
  recordedAt: string;
  race: { name: string; date: string; venueName: string; raceNo: number } | null;
  settings: Settings;
  hasOutcome: boolean;
  /** 結果にずれの分析用の情報（4角・上がり・ペース）があるか */
  hasDetail: boolean;
  /** 1着-2着-3着（同着は複数） */
  winningCombos: [number, number, number][];
  marks: { mark: string; horseNumber: number; horseName: string; popularity: number | null; finishText: string | null; finishPosition: number | null }[];
  plans: { kind: string; available: boolean; reason: string; ticketCount: number; cost: number; hit: boolean; payout: number; refund: number }[];
  /** 券種別（印から決まった買い方をしたと仮定）。全券種の払戻が無い結果（v9 より前）は null */
  bets: BetResult[] | null;
  /** 予想と結果のずれ（分析に必要な情報がそろったレースのみ） */
  deviation: Deviation | null;
}

export interface BetResult {
  type: string;
  label: string;
  available: boolean;
  ticketCount: number;
  cost: number;
  hit: boolean;
  payout: number;
  refund: number;
}

export interface MarkStat {
  n: number;
  win: number;
  top3: number;
}
export interface PlanStat {
  races: number;
  hits: number;
  cost: number;
  payout: number;
  /** 回収率（%）。購入なしなら null */
  recovery: number | null;
}
export interface Summary {
  races: number;
  marks: Record<string, MarkStat>;
  plans: Record<string, PlanStat>;
  /** 券種別（全券種の払戻があるレースのみ） */
  bets: Record<string, PlanStat>;
  /** 予想と結果のずれの集計 */
  deviation: DeviationSummary;
}

/** 券種と、印からの買い方（各100円） */
export const BET_RULES: { type: string; label: string; ordered: boolean; rule: string }[] = [
  { type: 'tansho', label: '単勝', ordered: true, rule: '◎' },
  { type: 'fukusho', label: '複勝', ordered: true, rule: '◎' },
  { type: 'wide', label: 'ワイド', ordered: false, rule: '◎-◯、◎-▲' },
  { type: 'umaren', label: '馬連', ordered: false, rule: '◎から◯▲△△へ流し' },
  { type: 'umatan', label: '馬単', ordered: true, rule: '◎1着固定で◯▲△△へ' },
  { type: 'sanrenpuku', label: '3連複', ordered: false, rule: '◎軸・2頭目◯▲・3頭目◯▲△△' },
];

/** 印から券種ごとの買い目を作る。必要な印がそろわなければ null */
export function betTickets(marks: PredictionRecord['marks'], type: string): number[][] | null {
  const of = (m: string) => marks.filter((x) => x.mark === m).map((x) => x.horseNumber);
  const [hon] = of('◎');
  const [tai] = of('◯');
  const [tan] = of('▲');
  const ren = of('△');
  if (hon === undefined) return null;
  const himo = [tai, tan, ...ren].filter((x): x is number => x !== undefined);
  switch (type) {
    case 'tansho':
    case 'fukusho':
      return [[hon]];
    case 'wide':
      return tai !== undefined && tan !== undefined ? [[hon, tai], [hon, tan]] : null;
    case 'umaren':
    case 'umatan':
      return himo.length === 4 ? himo.map((h) => [hon, h]) : null;
    case 'sanrenpuku': {
      if (tai === undefined || tan === undefined || ren.length < 2) return null;
      const seen = new Set<string>();
      const out: number[][] = [];
      for (const b of [tai, tan])
        for (const c of [tai, tan, ...ren]) {
          if (b === c) continue;
          const key = [hon, b, c].sort((x, y) => x - y).join('-');
          if (seen.has(key)) continue;
          seen.add(key);
          out.push([hon, b, c]);
        }
      return out;
    }
    default:
      return null;
  }
}
export interface ReviewResult {
  scope: ReviewScope;
  /** 対象の記録の件数（集計はすべてを使い、一覧は新しい順に REVIEW_ROW_LIMIT 件まで返す） */
  totalRows: number;
  rows: ReviewRow[];
  summary: { backtest: Summary; eve: Summary; auto: Summary; manual: Summary };
}

/** 取消・除外（馬券は返還）か */
const isScratched = (text: string | null | undefined) => /取消|除外/.test(text ?? '');

export function evaluate(rec: PredictionRecord, outcome: RaceOutcome | null, race: ReviewRow['race']): ReviewRow {
  const byNumber = new Map((outcome?.finishes ?? []).map((f) => [f.horseNumber, f]));
  const scratched = new Set((outcome?.finishes ?? []).filter((f) => isScratched(f.finishText)).map((f) => f.horseNumber));
  const marks = rec.marks
    .filter((m) => m.mark !== '')
    .map((m) => {
      const f = byNumber.get(m.horseNumber);
      return {
        mark: m.mark,
        horseNumber: m.horseNumber,
        horseName: m.horseName,
        popularity: m.popularity,
        finishText: f?.finishText ?? null,
        finishPosition: f?.finishPosition ?? null,
      };
    });
  const plans = rec.plans.map((p) => {
    const cost = p.available ? p.tickets.length * TICKET_PRICE : 0;
    let payout = 0;
    let refund = 0;
    let hit = false;
    if (outcome && p.available) {
      for (const t of p.tickets) {
        if ([t.first, t.second, t.third].some((n) => scratched.has(n))) {
          refund += TICKET_PRICE;
          continue;
        }
        const win = outcome.trifecta.find((w) => w.combo[0] === t.first && w.combo[1] === t.second && w.combo[2] === t.third);
        if (win) {
          hit = true;
          payout += win.payout;
        }
      }
    }
    return { kind: p.kind, available: p.available, reason: p.reason, ticketCount: p.available ? p.tickets.length : 0, cost, hit, payout, refund };
  });
  // 券種別（全券種の払戻がある結果のみ）
  const bets: BetResult[] | null = outcome?.payouts
    ? BET_RULES.map((rule) => {
        const tickets = betTickets(rec.marks, rule.type);
        if (!tickets) return { type: rule.type, label: rule.label, available: false, ticketCount: 0, cost: 0, hit: false, payout: 0, refund: 0 };
        const wins = outcome.payouts?.[rule.type] ?? [];
        const key = (c: number[]) => (rule.ordered ? c : [...c].sort((x, y) => x - y)).join('-');
        let payout = 0;
        let refund = 0;
        let hit = false;
        for (const t of tickets) {
          if (t.some((n) => scratched.has(n))) {
            refund += TICKET_PRICE;
            continue;
          }
          for (const w of wins) {
            if (key(w.combo) === key(t)) {
              hit = true;
              payout += w.payout;
            }
          }
        }
        return { type: rule.type, label: rule.label, available: true, ticketCount: tickets.length, cost: tickets.length * TICKET_PRICE, hit, payout, refund };
      })
    : null;
  return {
    raceKey: rec.raceKey,
    source: rec.source,
    recordedAt: rec.recordedAt,
    race,
    settings: rec.settings,
    hasOutcome: Boolean(outcome),
    hasDetail: (outcome?.meta?.detailVersion ?? 0) >= OUTCOME_DETAIL_VERSION,
    winningCombos: (outcome?.trifecta ?? []).map((w) => w.combo),
    marks,
    plans,
    bets,
    deviation: analyzeDeviation(rec, outcome),
  };
}

/** 結果のあるレースだけを集計する。取消・除外の馬は印の集計から除く */
export function summarize(rows: ReviewRow[]): Summary {
  const done = rows.filter((r) => r.hasOutcome);
  const marks: Record<string, MarkStat> = {};
  for (const mk of REVIEW_MARKS) {
    const list = done.flatMap((r) => r.marks.filter((m) => m.mark === mk && !isScratched(m.finishText)));
    marks[mk] = {
      n: list.length,
      win: list.filter((m) => m.finishPosition === 1).length,
      top3: list.filter((m) => m.finishPosition !== null && m.finishPosition <= 3).length,
    };
  }
  const plans: Record<string, PlanStat> = {};
  for (const kind of PLAN_KINDS) {
    const list = done.flatMap((r) => r.plans.filter((p) => p.kind === kind && p.available));
    const cost = list.reduce((s, p) => s + p.cost, 0);
    const payout = list.reduce((s, p) => s + p.payout + p.refund, 0);
    plans[kind] = {
      races: list.length,
      hits: list.filter((p) => p.hit).length,
      cost,
      payout,
      recovery: cost > 0 ? Math.round((payout / cost) * 1000) / 10 : null,
    };
  }
  const bets: Record<string, PlanStat> = {};
  for (const rule of BET_RULES) {
    const list = done.flatMap((r) => (r.bets ?? []).filter((b) => b.type === rule.type && b.available));
    const cost = list.reduce((s, b) => s + b.cost, 0);
    const payout = list.reduce((s, b) => s + b.payout + b.refund, 0);
    bets[rule.type] = {
      races: list.length,
      hits: list.filter((b) => b.hit).length,
      cost,
      payout,
      recovery: cost > 0 ? Math.round((payout / cost) * 1000) / 10 : null,
    };
  }
  return {
    races: done.length,
    marks,
    plans,
    bets,
    deviation: summarizeDeviation(done.map((r) => r.deviation).filter((d): d is Deviation => d !== null)),
  };
}

// ---------------- 予想と結果のずれの分析 ----------------

export interface Deviation {
  /** recorded = 記録時の点数・脚質で分析／recomputed = 記録が古いため今の点数で補って分析 */
  basis: 'recorded' | 'recomputed';
  pace: { forecast: string | null; actual: string | null; hit: boolean | null };
  /** 3着以内の馬（予想の脚質・実際の4角の位置・上がり順位） */
  top3: { horseNumber: number; horseName: string; finish: number; mark: string; mainStyle: string | null; corner4: number | null; group: string | null; last3fRank: number | null; favored: boolean | null }[];
  /** 予想の脚質と実際の4角の位置（前・中・後）が違った馬 */
  styleMisreads: { horseNumber: number; horseName: string; mark: string; predicted: string; predictedGroup: string; actualGroup: string; finish: number | null }[];
  /** ◎◯▲で3着以内に入らなかった馬と、その理由の候補 */
  markedLosers: { mark: string; horseNumber: number; horseName: string; finish: number | null; finishText: string; reasons: string[] }[];
  /** 無印で3着以内に入った馬と、点数が低かった項目 */
  missed: { horseNumber: number; horseName: string; finish: number; popularity: number | null; weakPoints: string[] }[];
  /** 項目ごとの「3着以内の馬の平均点 − それ以外の馬の平均点」（データ不足の項目は除いて計算。計算できなければ null） */
  componentGap: Record<string, number | null>;
}

const PACE_OF_FORECAST: Record<string, string> = { ハイペース寄り: 'ハイ', 平均ペース: '平均', スロー寄り: 'スロー' };
const PACE_OF_RESULT: Record<string, string> = { H: 'ハイ', M: '平均', S: 'スロー' };
const STYLE_GROUP: Record<string, string> = { 逃げ: '前', 先行: '前', 差し: '中', 追込: '後' };
const CORE = ['◎', '◯', '▲'];

/** 4角の番手を 前（頭数の1/3以内）・中（2/3以内）・後 に分ける */
export function cornerGroup(corner4: number | null | undefined, headcount: number): string | null {
  if (!corner4 || headcount <= 0) return null;
  if (corner4 <= headcount / 3) return '前';
  if (corner4 <= (headcount * 2) / 3) return '中';
  return '後';
}

/** 予想の記録と結果から、ずれを分析する。分析に必要な情報が無ければ null */
export function analyzeDeviation(rec: PredictionRecord, outcome: RaceOutcome | null): Deviation | null {
  if (!outcome || (outcome.meta?.detailVersion ?? 0) < OUTCOME_DETAIL_VERSION) return null;
  if (!rec.marks.some((m) => m.scores)) return null; // 分析用の情報を保存する前の記録
  const headcount = outcome.meta?.headcount ?? outcome.finishes.length;
  const byNo = new Map(outcome.finishes.map((f) => [f.horseNumber, f]));
  const favored = rec.settings.paceForecast?.favored ?? [];
  const forecast = rec.settings.paceForecast ? PACE_OF_FORECAST[rec.settings.paceForecast.pace] ?? null : null;
  const actual = outcome.meta?.pace ? PACE_OF_RESULT[outcome.meta.pace] : null;

  const top3 = outcome.finishes
    .filter((f) => f.finishPosition !== null && f.finishPosition <= 3)
    .sort((a, b) => (a.finishPosition as number) - (b.finishPosition as number))
    .map((f) => {
      const m = rec.marks.find((x) => x.horseNumber === f.horseNumber);
      const style = m?.mainStyle ?? null;
      return {
        horseNumber: f.horseNumber,
        horseName: f.horseName,
        finish: f.finishPosition as number,
        mark: m?.mark ?? '',
        mainStyle: style,
        corner4: f.corner4 ?? null,
        group: cornerGroup(f.corner4, headcount),
        last3fRank: f.last3fRank ?? null,
        favored: style ? favored.includes(style) : null,
      };
    });

  const styleMisreads: Deviation['styleMisreads'] = [];
  for (const m of rec.marks) {
    const f = byNo.get(m.horseNumber);
    if (!m.mainStyle || !f) continue;
    const pg = STYLE_GROUP[m.mainStyle];
    const ag = cornerGroup(f.corner4, headcount);
    if (pg && ag && pg !== ag)
      styleMisreads.push({ horseNumber: m.horseNumber, horseName: m.horseName, mark: m.mark, predicted: m.mainStyle, predictedGroup: pg, actualGroup: ag, finish: f.finishPosition });
  }

  const markedLosers: Deviation['markedLosers'] = [];
  for (const m of rec.marks.filter((x) => CORE.includes(x.mark))) {
    const f = byNo.get(m.horseNumber);
    if (!f || (f.finishPosition !== null && f.finishPosition <= 3)) continue;
    const reasons: string[] = [];
    const g = cornerGroup(f.corner4, headcount);
    const r = f.last3fRank ?? null;
    if (/取消|除外/.test(f.finishText)) reasons.push(`${f.finishText}`);
    if (g === '前' && r !== null && r > headcount / 2) reasons.push(`前で運んだが失速（4角${f.corner4}番手・上がり${r}位）`);
    if (g === '後' && r !== null && r <= 3) reasons.push(`後方から追い込んだが届かず（4角${f.corner4}番手・上がり${r}位）`);
    if (f.bodyWeightDiff !== null && f.bodyWeightDiff !== undefined && Math.abs(f.bodyWeightDiff) >= 8)
      reasons.push(`馬体重の大きな増減（${f.bodyWeightDiff > 0 ? '+' : ''}${f.bodyWeightDiff}kg）`);
    const pg = m.mainStyle ? STYLE_GROUP[m.mainStyle] : undefined;
    if (pg && g && pg !== g) reasons.push(`想定と違う位置取り（予想${m.mainStyle}＝${pg}、実際は4角${g}）`);
    if (reasons.length === 0)
      reasons.push(`位置取り・上がりに目立った敗因なし（4角${f.corner4 ?? '-'}番手・上がり${r ?? '-'}位。能力・条件負けの可能性）`);
    markedLosers.push({ mark: m.mark, horseNumber: m.horseNumber, horseName: m.horseName, finish: f.finishPosition, finishText: f.finishText, reasons });
  }

  const missed: Deviation['missed'] = [];
  for (const t of top3.filter((x) => !x.mark)) {
    const m = rec.marks.find((x) => x.horseNumber === t.horseNumber);
    const weak = COMPONENT_KEYS.map((k) => {
      const v = m?.scores?.[k];
      if (v === undefined) return null; // 記録時に無かった項目（末脚の追加前の記録など）
      if (v === null) return `${COMPONENT_LABELS[k]}データなし`;
      return v < 50 ? `${COMPONENT_LABELS[k]}${v}点` : null;
    }).filter((x): x is string => x !== null);
    missed.push({ horseNumber: t.horseNumber, horseName: t.horseName, finish: t.finish, popularity: byNo.get(t.horseNumber)?.popularity ?? null, weakPoints: weak });
  }

  const componentGap: Record<string, number | null> = {};
  const topNos = new Set(top3.map((t) => t.horseNumber));
  for (const k of COMPONENT_KEYS) {
    const vals = (inTop: boolean) =>
      rec.marks
        .filter((m) => byNo.has(m.horseNumber) && !/取消|除外/.test(byNo.get(m.horseNumber)!.finishText) && topNos.has(m.horseNumber) === inTop)
        .map((m) => m.scores?.[k])
        .filter((v): v is number => typeof v === 'number');
    const a = vals(true);
    const b = vals(false);
    componentGap[k] = a.length > 0 && b.length > 0 ? Math.round((a.reduce((x, y) => x + y, 0) / a.length - b.reduce((x, y) => x + y, 0) / b.length) * 10) / 10 : null;
  }

  const basis = (rec.settings as any).analysisBasis === 'recomputed' ? 'recomputed' : 'recorded';
  return { basis, pace: { forecast, actual, hit: forecast && actual ? forecast === actual : null }, top3, styleMisreads, markedLosers, missed, componentGap };
}

/** ずれの集計（分析できたレースのみ） */
export interface DeviationSummary {
  races: number;
  paceHit: number;
  paceTotal: number;
  /** 3着以内の馬のうち、予想で有利とした脚質だった頭数 / 脚質が分かった頭数 */
  favoredTop3: number;
  styledTop3: number;
  /** 項目ごとの「3着以内 − それ以外」の平均点差の平均（計算できたレースのみ） */
  componentGap: Record<string, { avg: number | null; races: number }>;
  /** 配分の修正案（既定の配分と、当たり具合から計算した配分を、レース数に応じて混ぜたもの）。計算できなければ null */
  suggestion: WeightSuggestion | null;
}

export interface WeightSuggestion {
  weights: Record<string, number>;
  /** 当たり具合から計算した配分をどれだけ混ぜたか（0〜0.5。10レースで最大の0.5） */
  alpha: number;
  races: number;
}

/** 修正案で、当たり具合の配分を混ぜる割合の上限と、上限に達するレース数 */
export const SUGGEST_MAX_ALPHA = 0.5;
export const SUGGEST_FULL_RACES = 10;

/**
 * 配分の修正案を作る。
 * 項目ごとの平均点差（マイナスは0とみなす）の比で配分した「当たり具合の配分」を作り、
 * 既定の配分と 割合 alpha（= 0.5 × min(1, レース数/10)）で混ぜて、合計100の整数にする
 */
export function suggestWeights(
  gap: Record<string, { avg: number | null; races: number }>,
  races: number,
  base: Record<string, number> = DEFAULT_WEIGHTS,
): WeightSuggestion | null {
  if (races <= 0) return null;
  const g = Object.fromEntries(COMPONENT_KEYS.map((k) => [k, Math.max(0, gap[k]?.avg ?? 0)]));
  const sum = COMPONENT_KEYS.reduce((s, k) => s + g[k], 0);
  if (sum <= 0) return null;
  const alpha = SUGGEST_MAX_ALPHA * Math.min(1, races / SUGGEST_FULL_RACES);
  const mixed = Object.fromEntries(COMPONENT_KEYS.map((k) => [k, (1 - alpha) * (base[k] ?? 0) + alpha * ((g[k] / sum) * 100)])) as Weights;
  return { weights: normalizeTo100(mixed), alpha: Math.round(alpha * 100) / 100, races };
}

export function summarizeDeviation(devs: Deviation[]): DeviationSummary {
  const paced = devs.filter((d) => d.pace.hit !== null);
  const styled = devs.flatMap((d) => d.top3.filter((t) => t.favored !== null));
  const componentGap: DeviationSummary['componentGap'] = {};
  for (const k of COMPONENT_KEYS) {
    const v = devs.map((d) => d.componentGap[k]).filter((x): x is number => typeof x === 'number');
    componentGap[k] = { avg: v.length > 0 ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null, races: v.length };
  }
  return {
    suggestion: suggestWeights(componentGap, devs.length),
    races: devs.length,
    paceHit: paced.filter((d) => d.pace.hit).length,
    paceTotal: paced.length,
    favoredTop3: styled.filter((t) => t.favored).length,
    styledTop3: styled.length,
    componentGap,
  };
}
