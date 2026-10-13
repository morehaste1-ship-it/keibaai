/**
 * データ予想の点数（各項目 0〜100）を出走馬ごとに計算する
 *
 * 項目: 近走 / 適性（芝ダ・距離帯、会場、馬場）/ 騎手 / 相性（騎手×脚質、騎手×枠）/ 過去10年の傾向 / 状態 / 末脚 / 着差 / スピード
 *       / 枠（コースの枠の有利不利）/ 条件替わり（距離・芝ダの変化）/ 休み明け
 * 配分（重み）は画面側で掛けて合計する（スライダーで変えられるように）。
 * DB は読むだけで書き込まない。
 * 未来のデータが混ざらないよう、馬・騎手・過去10年の成績はすべて「レース日より前」のものだけを使う
 * （過去のレースを予想し直す検証でも、当時と同じ条件で計算できるように）。
 */

import type { HorseRunRecord, JockeyRunRecord, RaceRepository } from '../db/repository';
import { cutoffDate, distanceBandOf, frameGroupOf } from './jockey-service';
import { seriesKeyOf } from './history-service';
import { PedigreeService } from './pedigree-service';
import { buildAptitudeMatrix, type AptitudeMatrix } from './aptitude-matrix';

/** 着順の点数（近走） */
export function finishPoints(finish: number | null): number {
  if (finish === null) return 0;
  if (finish === 1) return 100;
  if (finish === 2) return 80;
  if (finish === 3) return 65;
  if (finish <= 5) return 45;
  if (finish <= 9) return 25;
  return 10;
}

/** 少ない出走数の率を、基準の率に寄せて補正する */
export function smoothRate(top3: number, n: number, prior: number, k: number): number {
  return (top3 + prior * k) / (n + k);
}

/** 3着以内率 → 点数（60% で 100 点） */
export function rateToScore(rate: number): number {
  return Math.max(0, Math.min(100, Math.round((rate / 0.6) * 100)));
}

const RECENT_WEIGHTS = [5, 4, 3, 2, 1];
const HORSE_PRIOR = 0.3;
/** 補正の強さ（足す「仮のレース」の数）の既定値と範囲 */
export const DEFAULT_HORSE_K = 3;
export const DEFAULT_JOCKEY_K = 10;
export const MAX_HORSE_K = 10;
export const MAX_JOCKEY_K = 30;
const STYLE_WINDOW = 10;
/** 末脚：直近何走を見るか・平均の率（補正の基準）・100点になる率（平均20%で50点） */
const CLOSING_WINDOW = 10;
const CLOSING_PRIOR = 0.2;
const CLOSING_FULL_RATE = 0.4;
/** 着差：直近何走を見るか・1秒あたり何点下げるか（勝ち＝100点、0.5秒差＝80点、2.5秒差以上＝0点） */
const MARGIN_WINDOW = 5;
const MARGIN_POINTS_PER_SEC = 40;
/** スピード指数：直近何走を見るか・良いほうの何走を使うか・基準タイムに必要な走数・1000mあたり1秒速いと何点上げるか */
const SPEED_WINDOW = 5;
const SPEED_BEST = 2;
const SPEED_MIN_SAMPLES = 10;
const SPEED_POINTS_PER_SEC = 25;
/** 枠：何年分の過去走を見るか・必要な走数・枠グループの補正の強さ・全体平均との比 1.0 差あたりの点数 */
const FRAME_YEARS = 5;
const FRAME_MIN_RUNS = 100;
const FRAME_K = 50;
const FRAME_POINTS = 200;
/** 条件替わり：距離が何m以上変わったら「延長・短縮」とみなすか */
const CHANGE_DISTANCE = 200;
/** 休み明け：前走から何日以上を休み明けとするか（状態の項目と同じ） */
const LAYOFF_DAYS = 91;
/** 条件替わり・休み明け：その馬のふだんの3着以内率との差 1.0（100ポイント）あたりの点数（10ポイント高いと+20点） */
const DIFF_POINTS = 200;
/** 休み明けの全体の傾向（月ごとに1回だけ計算して使い回す。キー = レース日の年月） */
const layoffPriorCache = new Map<string, { factor: number; detail: string } | null>();
/** 「過去10年」の点数をそのまま使うのに必要な過去のレース数（これ未満は中立寄りに補正） */
export const HISTORY_MIN_RACES = 5;

export interface ScoreComponent {
  score: number;
  hasData: boolean;
  detail: string;
}

export interface ScoreItem {
  horseNumber: number | null;
  frameNumber: number | null;
  horseName: string;
  jockeyName: string | null;
  popularity: number | null;
  winOdds: number | null;
  mainStyle: string | null;
  /** 直近10走の最初のコーナーの平均位置（頭数に対する割合。0に近いほど前）。展開の表示用 */
  firstCornerAvg: { ratio: number; n: number } | null;
  sireName: string | null;
  bmsName: string | null;
  /** 前走からの日数（出走歴なしは null） */
  intervalDays: number | null;
  /** 乗り替わりか（前走の騎手と違う）。出走歴なし・不明は null */
  jockeyChanged: boolean | null;
  prevJockeyName: string | null;
  /** 当日の馬体重と増減（発表前は null） */
  bodyWeight: number | null;
  bodyWeightDiff: number | null;
  /** 近5走（解説用） */
  recentRuns: { date: string; venueName: string | null; raceName: string | null; surface: string | null; distance: number | null; finishText: string | null; popularity: number | null }[];
  /** この馬と今回の騎手のコンビ成績（JRA全期間）。騎手IDが無ければ null */
  combo: { rides: number; top3: number; wins: number } | null;
  /** 状況別の適性（重馬場・東京・中山・ベスト距離） */
  aptitudeMatrix: AptitudeMatrix;
  components: {
    recent: ScoreComponent;
    aptitude: ScoreComponent;
    jockey: ScoreComponent;
    matchup: ScoreComponent;
    history: ScoreComponent;
    state: ScoreComponent;
    closing: ScoreComponent;
    margin: ScoreComponent;
    speed: ScoreComponent;
    frame: ScoreComponent;
    change: ScoreComponent;
    layoff: ScoreComponent;
  };
}

export interface ScoreResult {
  raceKey: string;
  condition: string | null;
  defaultWeights: Record<keyof ScoreItem['components'], number>;
  /** 採用中の配分の版（自動見直しの履歴が無ければ null = 既定の配分） */
  weightsVersion: { id: number; adoptedAt: string; reason: string } | null;
  /** 今回の計算に使った補正の強さ */
  smoothing: { horseK: number; jockeyK: number };
  /** レースの基本情報（解説用） */
  race: { name: string; venueName: string; surface: string; distance: number };
  /** 過去10年の同レースで3着以内の馬の4角位置（前・中・後）の内訳 */
  historyCorner: { 前: number; 中: number; 後: number; total: number };
  items: ScoreItem[];
}

export const DEFAULT_WEIGHTS: ScoreResult['defaultWeights'] = {
  recent: 30,
  aptitude: 25,
  jockey: 20,
  matchup: 15,
  history: 10,
  state: 0,
  closing: 0,
  margin: 0,
  speed: 0,
  frame: 0,
  change: 0,
  layoff: 0,
};

/** 着差（秒）→ 点数。勝ち（マイナス・0）は100点 */
export function marginPoints(margin: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - Math.max(0, margin) * MARGIN_POINTS_PER_SEC)));
}

/** 数値の中央値 */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 採用中の配分（配分の自動見直しで採用したもの。履歴が無ければ既定の配分）
 * 新しく増えた項目は既定値で補う
 */
export function activeWeights(repo: RaceRepository): ScoreResult['defaultWeights'] {
  const v = repo.getActiveWeightVersion();
  const out = { ...DEFAULT_WEIGHTS };
  if (v) for (const k of Object.keys(out) as (keyof typeof out)[]) if (typeof v.weights[k] === 'number') out[k] = v.weights[k];
  return out;
}

/** 2つの日付（YYYY-MM-DD）の差の日数 */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

const pct = (r: number) => `${Math.round(r * 100)}%`;
const clampScore = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/** 前走 → 今回 の条件の変化（芝ダが替われば「芝→ダート」、距離が200m以上変われば「距離延長・短縮」、それ以外は null） */
export function changeTypeOf(
  prev: { surface: string | null; distance: number | null },
  next: { surface: string | null; distance: number | null },
): string | null {
  const sOk = (s: string | null) => s === '芝' || s === 'ダート';
  if (sOk(prev.surface) && sOk(next.surface) && prev.surface !== next.surface) return `${prev.surface}→${next.surface}`;
  // 障害 ⇔ 平地 は距離の比較をせず、別の変化として扱う
  if (prev.surface && next.surface && (prev.surface === '障害') !== (next.surface === '障害')) return `${prev.surface}→${next.surface}`;
  if (prev.distance && next.distance) {
    if (next.distance - prev.distance >= CHANGE_DISTANCE) return '距離延長';
    if (prev.distance - next.distance >= CHANGE_DISTANCE) return '距離短縮';
  }
  return null;
}
const isTop3 = (r: { finishPosition: number | null }) => r.finishPosition !== null && r.finishPosition <= 3;
const NEUTRAL = (detail: string): ScoreComponent => ({ score: 50, hasData: false, detail });

/** 4角の位置（前・中・後） */
function cornerGroup(corner: number | null, headcount: number | null): '前' | '中' | '後' | null {
  if (corner === null || headcount === null || headcount <= 0) return null;
  if (corner <= headcount / 3) return '前';
  if (corner <= (headcount * 2) / 3) return '中';
  return '後';
}

const STYLE_TO_GROUP: Record<string, '前' | '中' | '後'> = { 逃げ: '前', 先行: '前', 差し: '中', 追込: '後' };

export class ScoreService {
  private readonly pedigree: PedigreeService;

  constructor(private readonly repo: RaceRepository) {
    // 推定（DB読み取り）だけに使うため、取得元は渡さない
    this.pedigree = new PedigreeService(null as any, repo);
  }

  compute(
    raceKey: string,
    conditionInput?: string,
    opts: { horseK?: number; jockeyK?: number } = {},
  ): ScoreResult {
    const HORSE_K = opts.horseK ?? DEFAULT_HORSE_K;
    const JOCKEY_K = opts.jockeyK ?? DEFAULT_JOCKEY_K;
    const race = this.repo.getRace(raceKey);
    if (!race) throw new Error('対象レースが未登録です');

    const condition = conditionInput || race.trackCondition || null;
    const band = distanceBandOf(race.distance);
    const oddsMap = new Map(this.repo.getLatestWinOdds(raceKey).map((o) => [o.horseNumber, o]));
    // レース日より前の成績だけを使う（同じ日以降の走は含めない）
    const beforeRace = (r: { date: string }) => r.date < race.date;
    const jockeyFrom = cutoffDate(5, new Date(`${race.date}T00:00:00`));
    const jockeyCache = new Map<string, JockeyRunRecord[]>();

    // スピード指数の基準タイム：コース・距離・馬場ごとの3着以内の走破タイムの中央値（レース日より前の走だけ）。
    // 走数が足りなければ 馬場を問わない → 競馬場を問わない の順に広げ、それでも足りなければ null
    const baseCache = new Map<string, { time: number; label: string } | null>();
    const baseTimeOf = (r: HorseRunRecord): { time: number; label: string } | null => {
      if (!r.surface || r.surface === '障害' || !r.distance) return null;
      const key = `${r.venueName}|${r.surface}|${r.distance}|${r.trackCondition}`;
      if (baseCache.has(key)) return baseCache.get(key)!;
      const tries: { venue: string | null; condition: string | null; label: string }[] = [
        { venue: r.venueName, condition: r.trackCondition, label: `${r.venueName}${r.surface}${r.distance}m・${r.trackCondition ?? '-'}` },
        { venue: r.venueName, condition: null, label: `${r.venueName}${r.surface}${r.distance}m` },
        { venue: null, condition: r.trackCondition, label: `${r.surface}${r.distance}m・${r.trackCondition ?? '-'}（全競馬場）` },
      ];
      let found: { time: number; label: string } | null = null;
      for (const t of tries) {
        const times = this.repo.listTop3Times({ venue: t.venue, surface: r.surface, distance: r.distance, condition: t.condition }, race.date);
        if (times.length >= SPEED_MIN_SAMPLES) {
          found = { time: median(times), label: t.label };
          break;
        }
      }
      baseCache.set(key, found);
      return found;
    };

    // 過去10年：3着以内の馬の4角位置の割合（全馬場）
    const historyTop3 = this.repo
      .listHistoryRuns(seriesKeyOf(race.name, race.venueName, race.surface, race.distance))
      .filter((r) => beforeRace(r) && isTop3(r));
    const groupCounts: Record<'前' | '中' | '後', number> = { 前: 0, 中: 0, 後: 0 };
    for (const r of historyTop3) {
      const g = cornerGroup(r.corner4, r.headcount);
      if (g) groupCounts[g]++;
    }
    const groupTotal = groupCounts.前 + groupCounts.中 + groupCounts.後;
    const historyRaceCount = new Set(historyTop3.map((r) => r.sourceRaceId)).size;
    // 0件の位置が0点にならないよう +1 で補正した割合
    const groupShare = (g: '前' | '中' | '後') => (groupCounts[g] + 1) / (groupTotal + 3);
    const maxShare = Math.max(groupShare('前'), groupShare('中'), groupShare('後'));

    // 枠の有利不利：同じ競馬場・芝ダ・距離の過去5年の走（レース日より前）を枠グループ（内・中・外）ごとに集計
    const frameGroups = new Map<string, { n: number; top3: number }>();
    let frameTotal = { n: 0, top3: 0 };
    if (race.surface && race.surface !== '障害' && race.distance) {
      const rows = this.repo.frameStats(
        { venue: race.venueName, surface: race.surface, distance: race.distance },
        cutoffDate(FRAME_YEARS, new Date(`${race.date}T00:00:00`)),
        race.date,
      );
      for (const r of rows) {
        const g = frameGroupOf(r.frame);
        if (!g) continue;
        const cur = frameGroups.get(g) ?? { n: 0, top3: 0 };
        frameGroups.set(g, { n: cur.n + r.n, top3: cur.top3 + r.top3 });
        frameTotal = { n: frameTotal.n + r.n, top3: frameTotal.top3 + r.top3 };
      }
    }

    // 休み明けの全体の傾向（休み明けの走の3着以内率 ÷ 全体の3着以内率）。その月の1日より前の走で計算し、月ごとに使い回す
    const layoffPrior = (() => {
      const key = race.date.slice(0, 7);
      if (!layoffPriorCache.has(key)) {
        const st = this.repo.layoffStats(`${key}-01`, LAYOFF_DAYS);
        layoffPriorCache.set(
          key,
          st.n >= 1000 && st.layoffN >= 100 && st.top3 > 0
            ? {
                factor: st.layoffTop3 / st.layoffN / (st.top3 / st.n),
                detail: `全体では休み明けの3着以内率 ${pct(st.layoffTop3 / st.layoffN)}（ふだん ${pct(st.top3 / st.n)}）`,
              }
            : null,
        );
      }
      return layoffPriorCache.get(key)!;
    })();

    const items = this.repo.getEntries(raceKey).map((e): ScoreItem => {
      const odds = e.horseNumber !== null ? oddsMap.get(e.horseNumber) : undefined;
      const runs: HorseRunRecord[] = e.netkeibaHorseId ? this.repo.listHorseRuns(e.netkeibaHorseId).filter(beforeRace) : [];
      const jockeyRuns: JockeyRunRecord[] = e.jockeyId
        ? jockeyCache.get(e.jockeyId) ?? this.repo.listJockeyRuns(e.jockeyId, jockeyFrom).filter(beforeRace)
        : [];
      if (e.jockeyId) jockeyCache.set(e.jockeyId, jockeyRuns);

      // 馬の主な脚質（直近10走で最多。同数なら新しい走の脚質）
      const styled = runs.filter((r) => r.runningStyle).slice(0, STYLE_WINDOW);
      const counts: Record<string, number> = {};
      for (const r of styled) counts[r.runningStyle as string] = (counts[r.runningStyle as string] ?? 0) + 1;
      const mainStyle = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const cornerRuns = runs
        .slice(0, STYLE_WINDOW)
        .filter((r) => r.firstCorner !== null && r.headcount !== null && (r.headcount as number) > 0);
      const firstCornerAvg =
        cornerRuns.length > 0
          ? { ratio: cornerRuns.reduce((s, r) => s + (r.firstCorner as number) / (r.headcount as number), 0) / cornerRuns.length, n: cornerRuns.length }
          : null;

      // 1. 近走
      let recent: ScoreComponent;
      const last5 = runs.slice(0, 5);
      if (last5.length === 0) {
        recent = NEUTRAL('JRAの出走歴なし（中立50点）');
      } else {
        const ws = RECENT_WEIGHTS.slice(0, last5.length);
        const score = last5.reduce((s, r, i) => s + finishPoints(r.finishPosition) * ws[i], 0) / ws.reduce((a, b) => a + b, 0);
        recent = {
          score: Math.round(score),
          hasData: true,
          detail: `近${last5.length}走: ${last5.map((r) => r.finishText || '-').join('-')}`,
        };
      }

      // 2. 適性（芝ダ・距離帯 / 会場 / 馬場）
      // 出走数が少ない区分は「血統からの推定値」に寄せて補正する（血統が無ければ全体平均30%）
      const ped = e.netkeibaHorseId ? this.pedigree.estimate(e.netkeibaHorseId, race.surface, race.distance, condition) : null;
      const prior = ped?.rate ?? HORSE_PRIOR;
      let aptitude: ScoreComponent;
      if (runs.length === 0) {
        aptitude = ped
          ? { score: rateToScore(ped.rate), hasData: true, detail: `出走歴なしのため${ped.detail}から推定` }
          : NEUTRAL('JRAの出走歴なし・血統未取得（中立50点）');
      } else {
        const subsets: { label: string; rs: HorseRunRecord[] }[] = [
          { label: `${race.surface}${band ?? ''}`, rs: runs.filter((r) => r.surface === race.surface && distanceBandOf(r.distance) === band) },
          { label: race.venueName, rs: runs.filter((r) => r.venueName === race.venueName) },
        ];
        if (condition) subsets.push({ label: `馬場${condition}`, rs: runs.filter((r) => r.trackCondition === condition) });
        const rates = subsets.map((s) => smoothRate(s.rs.filter(isTop3).length, s.rs.length, prior, HORSE_K));
        aptitude = {
          score: rateToScore(rates.reduce((a, b) => a + b, 0) / rates.length),
          hasData: true,
          detail:
            subsets.map((s) => `${s.label} ${s.rs.filter(isTop3).length}/${s.rs.length}`).join('・') +
            `（3着内/出走）／補正の基準: ${ped ? `${ped.detail}` : '全体平均30%'}`,
        };
      }

      // 3. 騎手（今回と同じ会場・芝ダ・距離帯、全体の複勝率に寄せて補正）
      let jockey: ScoreComponent;
      const jockeyOverall = jockeyRuns.length > 0 ? jockeyRuns.filter(isTop3).length / jockeyRuns.length : null;
      if (jockeyOverall === null) {
        jockey = NEUTRAL(e.jockeyId ? '騎手成績が未取得（中立50点）' : '騎手ID未保存（中立50点）');
      } else {
        const same = jockeyRuns.filter(
          (r) => r.venueName === race.venueName && r.surface === race.surface && distanceBandOf(r.distance) === band,
        );
        const rate = smoothRate(same.filter(isTop3).length, same.length, jockeyOverall, JOCKEY_K);
        jockey = {
          score: rateToScore(rate),
          hasData: true,
          detail: `同条件 ${same.filter(isTop3).length}/${same.length}・全体 ${pct(jockeyOverall)}`,
        };
      }

      // 4. 相性（騎手×馬の主な脚質、騎手×今回の枠）
      let matchup: ScoreComponent;
      const parts: { label: string; rate: number }[] = [];
      if (jockeyOverall !== null && mainStyle) {
        const rs = jockeyRuns.filter((r) => r.runningStyle === mainStyle);
        parts.push({ label: `${mainStyle}${rs.filter(isTop3).length}/${rs.length}`, rate: smoothRate(rs.filter(isTop3).length, rs.length, jockeyOverall, JOCKEY_K) });
      }
      const fg = frameGroupOf(e.frameNumber);
      if (jockeyOverall !== null && fg) {
        const rs = jockeyRuns.filter((r) => frameGroupOf(r.frameNumber) === fg);
        parts.push({ label: `${fg}${rs.filter(isTop3).length}/${rs.length}`, rate: smoothRate(rs.filter(isTop3).length, rs.length, jockeyOverall, JOCKEY_K) });
      }
      matchup =
        parts.length === 0
          ? NEUTRAL('脚質・枠・騎手成績のいずれかが不足（中立50点）')
          : {
              score: rateToScore(parts.reduce((s, p) => s + p.rate, 0) / parts.length),
              hasData: true,
              detail: `騎手×${parts.map((p) => p.label).join('・')}`,
            };

      // 5. 過去10年の傾向（3着以内の馬の4角位置）
      let history: ScoreComponent;
      const group = mainStyle ? STYLE_TO_GROUP[mainStyle] : undefined;
      if (groupTotal === 0) {
        history = NEUTRAL('過去10年のデータなし（中立50点）');
      } else if (!group) {
        history = NEUTRAL('馬の脚質が不明（中立50点）');
      } else {
        // 過去のレース数が少ないときは、中立の50点に寄せる（5レース未満は差を レース数/5 に縮める）
        const raw = Math.round((groupShare(group) / maxShare) * 100);
        const factor = Math.min(1, historyRaceCount / HISTORY_MIN_RACES);
        history = {
          score: Math.round(50 + (raw - 50) * factor),
          hasData: true,
          detail:
            `3着内の4角位置 前${groupCounts.前}・中${groupCounts.中}・後${groupCounts.後}／この馬=${group}` +
            (factor < 1 ? `（過去${historyRaceCount}レースのみのため、本来${raw}点を中立寄りに補正）` : ''),
        };
      }

      // 6. 状態（前走からの間隔・当日の馬体重の増減・乗り替わり）。50点を基準に加減
      const last = runs[0] ?? null;
      const intervalDays = last ? daysBetween(last.date, race.date) : null;
      const jockeyChanged = last && last.jockeyId && e.jockeyId ? last.jockeyId !== e.jockeyId : null;
      let state: ScoreComponent;
      if (!last) {
        state = NEUTRAL('JRAの出走歴なし（中立50点）');
      } else {
        let pts = 50;
        const notes: string[] = [];
        if (intervalDays !== null) {
          if (intervalDays <= 14) {
            pts -= 10;
            notes.push(`中1週以内（${intervalDays}日）−10`);
          } else if (intervalDays <= 62) {
            pts += 10;
            notes.push(`中2〜8週（${intervalDays}日）+10`);
          } else if (intervalDays >= 91) {
            pts -= 10;
            notes.push(`休み明け（${intervalDays}日）−10`);
          } else {
            notes.push(`間隔${intervalDays}日 ±0`);
          }
        }
        if (e.bodyWeightDiff !== null && e.bodyWeightDiff !== undefined) {
          if (Math.abs(e.bodyWeightDiff) >= 10) {
            pts -= 10;
            notes.push(`馬体重${e.bodyWeightDiff > 0 ? '+' : ''}${e.bodyWeightDiff}kg −10`);
          } else {
            notes.push(`馬体重${e.bodyWeightDiff > 0 ? '+' : ''}${e.bodyWeightDiff}kg ±0`);
          }
        } else {
          notes.push('当日の馬体重は未発表');
        }
        if (jockeyChanged && last.jockeyId) {
          const prevRuns = this.repo.listJockeyRuns(last.jockeyId, jockeyFrom).filter(beforeRace);
          if (jockeyOverall !== null && prevRuns.length > 0) {
            const prevRate = prevRuns.filter(isTop3).length / prevRuns.length;
            const diff = Math.max(-15, Math.min(15, Math.round((jockeyOverall - prevRate) * 100)));
            pts += diff;
            notes.push(`乗り替わり（${last.jockeyName ?? '前走騎手'}→今回 複勝率${pct(prevRate)}→${pct(jockeyOverall)}）${diff >= 0 ? '+' : ''}${diff}`);
          } else {
            notes.push(`乗り替わり（${last.jockeyName ?? '前走騎手'}→今回。騎手成績が未取得のため ±0）`);
          }
        } else if (jockeyChanged === false) {
          notes.push('継続騎乗 ±0');
        }
        state = { score: Math.max(0, Math.min(100, pts)), hasData: true, detail: notes.join('・') };
      }

      // 7. 末脚（直近10走で上がり3位以内だった割合。上がり順位が分かる走のみ）
      let closing: ScoreComponent;
      const ranked3f = runs.slice(0, CLOSING_WINDOW).filter((r) => r.last3fRank !== null && r.last3fRank !== undefined);
      if (ranked3f.length === 0) {
        closing = NEUTRAL('上がり順位のデータなし（中立50点）');
      } else {
        const top = ranked3f.filter((r) => (r.last3fRank as number) >= 1 && (r.last3fRank as number) <= 3).length;
        const rate = smoothRate(top, ranked3f.length, CLOSING_PRIOR, HORSE_K);
        closing = {
          score: Math.max(0, Math.min(100, Math.round((rate / CLOSING_FULL_RATE) * 100))),
          hasData: true,
          detail: `上がり3位以内 ${top}/${ranked3f.length}走（直近${CLOSING_WINDOW}走のうち順位が分かる走）`,
        };
      }

      // 8. 着差（直近5走の勝ち馬との差。新しい走ほど重く数える）
      let margin: ScoreComponent;
      const marginRuns = runs.slice(0, MARGIN_WINDOW).filter((r) => r.marginSec !== null && r.marginSec !== undefined);
      if (marginRuns.length === 0) {
        margin = NEUTRAL('着差のデータなし（中立50点）');
      } else {
        const ws = RECENT_WEIGHTS.slice(0, marginRuns.length);
        const pts = marginRuns.reduce((s, r, i) => s + marginPoints(r.marginSec as number) * ws[i], 0) / ws.reduce((a, b) => a + b, 0);
        margin = {
          score: Math.round(pts),
          hasData: true,
          detail: `近${marginRuns.length}走の着差: ${marginRuns.map((r) => ((r.marginSec as number) <= 0 ? '勝' : `${(r.marginSec as number).toFixed(1)}`)).join('-')}（秒）`,
        };
      }

      // 9. スピード指数（直近5走の走破タイムを、コース・距離・馬場の基準タイムと比べた1000mあたりの秒差。良いほうの2走の平均）
      let speed: ScoreComponent;
      const speedRuns = runs
        .slice(0, SPEED_WINDOW)
        .filter((r) => r.timeSec !== null && r.timeSec !== undefined && r.distance)
        .map((r) => {
          const base = baseTimeOf(r);
          return base ? { r, base, diff: (base.time - (r.timeSec as number)) / ((r.distance as number) / 1000) } : null;
        })
        .filter((x): x is { r: HorseRunRecord; base: { time: number; label: string }; diff: number } => x !== null);
      if (speedRuns.length === 0) {
        speed = NEUTRAL('走破タイムか基準タイムのデータなし（中立50点）');
      } else {
        const best = [...speedRuns].sort((a, b) => b.diff - a.diff).slice(0, SPEED_BEST);
        const avg = best.reduce((s, x) => s + x.diff, 0) / best.length;
        const raw = 50 + avg * SPEED_POINTS_PER_SEC;
        // 1走しか無いときは差を半分にして中立寄りにする
        const pts = 50 + (raw - 50) * Math.min(1, speedRuns.length / SPEED_BEST);
        const fmt = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
        speed = {
          score: Math.max(0, Math.min(100, Math.round(pts))),
          hasData: true,
          detail:
            `基準より1000mあたり ${best.map((x) => `${fmt(x.diff)}秒（${x.r.date.slice(2).replace(/-/g, '/')} ${x.base.label}）`).join('・')} 速い` +
            `（直近${SPEED_WINDOW}走のうち${speedRuns.length}走で計算、良いほう${best.length}走の平均）`,
        };
      }

      // その馬のふだんの3着以内率（条件替わり・休み明けの比較の基準。少ない馬は全体平均30%に寄せる）
      const finished = runs.filter((r) => r.finishPosition !== null);
      const baseRate = Math.max(0.05, smoothRate(finished.filter(isTop3).length, finished.length, HORSE_PRIOR, HORSE_K));
      // 前の走 → 次の走 の組（runs は新しい順なので runs[i+1] → runs[i]）
      const pairs = runs.slice(0, -1).map((next, i) => ({ prev: runs[i + 1], next }));

      // 10. 枠（今回の枠グループの3着以内率を、そのコース全体の率と比べる）
      let frame: ScoreComponent;
      const myGroup = frameGroupOf(e.frameNumber);
      if (!myGroup) {
        frame = NEUTRAL('枠番が未発表（中立50点）');
      } else if (frameTotal.n < FRAME_MIN_RUNS) {
        frame = NEUTRAL(`このコースの過去走が${frameTotal.n}走で少ない（${FRAME_MIN_RUNS}走未満は中立50点）`);
      } else {
        const overall = frameTotal.top3 / frameTotal.n;
        const g = frameGroups.get(myGroup) ?? { n: 0, top3: 0 };
        const rate = smoothRate(g.top3, g.n, overall, FRAME_K);
        frame = {
          score: clampScore(50 + (rate / overall - 1) * FRAME_POINTS),
          hasData: true,
          detail:
            `${race.venueName}${race.surface}${race.distance}m（過去${FRAME_YEARS}年）の${myGroup} 3着内 ${g.top3}/${g.n}（${g.n > 0 ? pct(g.top3 / g.n) : '-'}）` +
            `／コース全体 ${pct(overall)}`,
        };
      }

      // 11. 条件替わり（前走から芝ダ・距離が変わるとき、その馬の過去の同じ変化での成績を、ふだんの成績と比べる）
      let change: ScoreComponent;
      const changeType = last ? changeTypeOf(last, race) : null;
      if (!last) {
        change = NEUTRAL('JRAの出走歴なし（中立50点）');
      } else if (!changeType) {
        change = {
          score: 50,
          hasData: true,
          detail: `前走（${last.surface ?? '-'}${last.distance ?? '-'}m）から大きな変化なし（50点）`,
        };
      } else {
        const same = pairs.filter((p) => p.next.finishPosition !== null && changeTypeOf(p.prev, p.next) === changeType);
        const t3 = same.filter((p) => isTop3(p.next)).length;
        if (same.length === 0) {
          change = NEUTRAL(`今回が初めての${changeType}（前走 ${last.surface ?? '-'}${last.distance ?? '-'}m。中立50点）`);
        } else {
          const rate = smoothRate(t3, same.length, baseRate, HORSE_K);
          change = {
            score: clampScore(50 + (rate - baseRate) * DIFF_POINTS),
            hasData: true,
            detail: `${changeType}（前走 ${last.surface ?? '-'}${last.distance ?? '-'}m）：過去の${changeType} 3着内 ${t3}/${same.length}／ふだん ${pct(baseRate)}`,
          };
        }
      }

      // 12. 休み明け（前走から91日以上のとき、その馬の過去の休み明けの成績を、ふだんの成績と比べる。初めてなら全体の傾向）
      let layoff: ScoreComponent;
      if (!last || intervalDays === null) {
        layoff = NEUTRAL('JRAの出走歴なし（中立50点）');
      } else if (intervalDays < LAYOFF_DAYS) {
        layoff = { score: 50, hasData: true, detail: `休み明けではない（間隔${intervalDays}日。50点）` };
      } else {
        const same = pairs.filter((p) => p.next.finishPosition !== null && daysBetween(p.prev.date, p.next.date) >= LAYOFF_DAYS);
        const t3 = same.filter((p) => isTop3(p.next)).length;
        if (same.length === 0 && !layoffPrior) {
          layoff = NEUTRAL(`休み明け（${intervalDays}日）。この馬は初めてで、全体の傾向もデータ不足（中立50点）`);
        } else {
          // 全体の傾向（休み明けは何割ほど成績が落ちるか）を基準に、その馬の過去の休み明けで補正する
          const prior = baseRate * (layoffPrior?.factor ?? 1);
          const rate = smoothRate(t3, same.length, prior, HORSE_K);
          layoff = {
            score: clampScore(50 + (rate - baseRate) * DIFF_POINTS),
            hasData: true,
            detail:
              `休み明け（${intervalDays}日）：この馬の過去の休み明け 3着内 ${t3}/${same.length}／ふだん ${pct(baseRate)}` +
              (layoffPrior ? `／${layoffPrior.detail}` : ''),
          };
        }
      }

      const pedRow = e.netkeibaHorseId ? this.repo.getPedigree(e.netkeibaHorseId) : null;
      // 状況別の適性（血統の推定は今回と同じ芝ダの産駒成績から）
      const pedLookup =
        e.netkeibaHorseId && pedRow
          ? {
              heavy: this.pedigree.rateFor(e.netkeibaHorseId, race.surface, 'condition', ['重', '不良']),
              distance: ['-1400', '-1800', '-2200', '-2600', '2600-']
                .map((b) => ({ bucket: b, est: this.pedigree.rateFor(e.netkeibaHorseId as string, race.surface, 'distance', [b]) }))
                .filter((x) => x.est !== null)
                .map((x) => ({ bucket: x.bucket, rate: x.est!.rate, detail: x.est!.detail })),
            }
          : null;
      const aptitudeMatrix = buildAptitudeMatrix(runs, race.surface, race.venueName, pedLookup, HORSE_K);
      return {
        horseNumber: e.horseNumber,
        frameNumber: e.frameNumber,
        horseName: e.horseName,
        jockeyName: (e.jockeyId && this.repo.getJockeyName(e.jockeyId)) || e.jockey,
        popularity: odds?.popularity ?? null,
        winOdds: odds?.winOdds ?? null,
        mainStyle,
        firstCornerAvg,
        sireName: pedRow?.sireName ?? null,
        bmsName: pedRow?.bmsName ?? null,
        intervalDays,
        jockeyChanged,
        prevJockeyName: last?.jockeyName ?? null,
        bodyWeight: e.bodyWeight ?? null,
        bodyWeightDiff: e.bodyWeightDiff ?? null,
        recentRuns: last5.map((r) => ({
          date: r.date,
          venueName: r.venueName,
          raceName: r.raceName,
          surface: r.surface,
          distance: r.distance,
          finishText: r.finishText,
          popularity: r.popularity,
        })),
        combo: e.jockeyId
          ? (() => {
              const rs = runs.filter((r) => r.jockeyId === e.jockeyId);
              return { rides: rs.length, top3: rs.filter(isTop3).length, wins: rs.filter((r) => r.finishPosition === 1).length };
            })()
          : null,
        aptitudeMatrix,
        components: { recent, aptitude, jockey, matchup, history, state, closing, margin, speed, frame, change, layoff },
      };
    });

    return {
      raceKey,
      condition,
      // 画面の「既定の配分」は、配分の自動見直しで採用中の配分
      defaultWeights: activeWeights(this.repo),
      weightsVersion: (() => {
        const v = this.repo.getActiveWeightVersion();
        return v ? { id: v.id, adoptedAt: v.adoptedAt, reason: v.reason } : null;
      })(),
      smoothing: { horseK: HORSE_K, jockeyK: JOCKEY_K },
      race: { name: race.name, venueName: race.venueName, surface: race.surface, distance: race.distance },
      historyCorner: { ...groupCounts, total: groupTotal },
      items,
    };
  }
}
