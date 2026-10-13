/**
 * 状況別の適性（出馬表の行を開いたときの「状況別適性診断」）
 *
 * 「自身の成績」と「血統の傾向（父・母父の産駒成績）」を混ぜずに別々に出す。
 * - 重馬場・道悪：自身＝今回と同じ芝ダでの重・不良の3着以内率／血統＝産駒の同じ芝ダの重・不良
 * - ベスト距離：自身＝同じ芝ダで2走以上の距離帯のうち率が最高の帯／血統＝産駒の距離区分で率が最高の区分
 * - 競馬場別（JRA全10場）とコースの特徴別（急坂・直線が長い・小回り平坦）：自身のみ
 *   （競馬場別の産駒成績は取得していないため血統はなし。京都は内・外回りを区別できないため特徴別に含めない）
 * 自身の率は出走数が少ないとき全体平均30%に寄せて補正し（仮3戦が既定）、
 * データ予想と同じ点数（複勝率60%で100点）にしてから S(80〜)/A(60〜)/B(40〜)/C(〜39) に分ける
 */
import type { HorseRunRecord } from '../db/repository';
import { distanceBandOf } from './jockey-service';

export type AptRank = 'S' | 'A' | 'B' | 'C';
export interface AptitudeEntry {
  rank: AptRank | null; // null = データ不足
  detail: string;
}
export interface DistanceEntry {
  label: string | null; // null = データ不足
  detail: string;
}
export interface VenueEntry extends AptitudeEntry {
  venue: string;
  top3: number;
  n: number;
}
export interface FeatureEntry extends AptitudeEntry {
  key: string;
  label: string;
  venues: string[];
}
export interface AptitudeMatrix {
  heavy: { own: AptitudeEntry; pedigree: AptitudeEntry };
  bestDistance: { own: DistanceEntry; pedigree: DistanceEntry };
  venues: VenueEntry[];
  features: FeatureEntry[];
  /** 今回のレースの競馬場 */
  currentVenue: string;
}

/** 血統からの推定（呼び出し側で PedigreeService を使って渡す） */
export interface PedigreeLookup {
  heavy: { rate: number; detail: string } | null;
  /** 産駒成績の距離区分ごとの率 */
  distance: { bucket: string; rate: number; detail: string }[];
}

export const JRA_VENUES = ['札幌', '函館', '福島', '新潟', '東京', '中山', '中京', '京都', '阪神', '小倉'];
export const COURSE_FEATURES = [
  { key: 'slope', label: '急坂', venues: ['中山', '阪神', '中京'] },
  { key: 'straight', label: '直線が長い', venues: ['東京', '新潟'] },
  { key: 'flat', label: '小回り・平坦', venues: ['札幌', '函館', '福島', '小倉'] },
];

const PRIOR = 0.3;
const MIN_BAND_RUNS = 2;

export function rankOfScore(score: number): AptRank {
  if (score >= 80) return 'S';
  if (score >= 60) return 'A';
  if (score >= 40) return 'B';
  return 'C';
}
const toScore = (rate: number) => Math.max(0, Math.min(100, Math.round((rate / 0.6) * 100)));
const smooth = (top3: number, n: number, k: number) => (top3 + PRIOR * k) / (n + k);
const isTop3 = (r: HorseRunRecord) => r.finishPosition !== null && r.finishPosition <= 3;
const pct = (r: number) => `${Math.round(r * 100)}%`;

const BAND_LABEL: Record<string, string> = {
  '短距離(〜1400)': '〜1400m',
  'マイル(〜1800)': '〜1800m',
  '中距離(〜2200)': '〜2200m',
  '長距離(2201〜)': '2201m〜',
};
const SIRE_BUCKET_LABEL: Record<string, string> = {
  '-1400': '〜1400m',
  '-1800': '〜1800m',
  '-2200': '〜2200m',
  '-2600': '〜2600m',
  '2600-': '2600m超',
};

/** 自身の成績から1項目を作る */
function ownEntry(rs: HorseRunRecord[], label: string, k: number, extra = ''): AptitudeEntry {
  if (rs.length === 0) return { rank: null, detail: `${label}での出走なし` };
  const top3 = rs.filter(isTop3).length;
  const score = toScore(smooth(top3, rs.length, k));
  return { rank: rankOfScore(score), detail: `${label} ${top3}/${rs.length}（3着内/出走）・${score}点${extra}` };
}

export function buildAptitudeMatrix(
  runs: HorseRunRecord[],
  raceSurface: string,
  raceVenue: string,
  ped: PedigreeLookup | null,
  k: number,
): AptitudeMatrix {
  // 重馬場・道悪
  const heavyRuns = runs.filter((r) => r.surface === raceSurface && (r.trackCondition === '重' || r.trackCondition === '不良'));
  const heavy = {
    own: ownEntry(heavyRuns, `${raceSurface}の重・不良`, k),
    pedigree: ped?.heavy
      ? { rank: rankOfScore(toScore(ped.heavy.rate)), detail: `産駒の${raceSurface}重・不良 ${pct(ped.heavy.rate)}（${ped.heavy.detail}）` }
      : { rank: null, detail: ped ? '産駒の重・不良の成績が不足' : '血統未取得' },
  };

  // ベスト距離（自身）
  const byBand = new Map<string, HorseRunRecord[]>();
  for (const r of runs.filter((x) => x.surface === raceSurface)) {
    const b = distanceBandOf(r.distance);
    if (b) byBand.set(b, [...(byBand.get(b) ?? []), r]);
  }
  const cands = [...byBand.entries()]
    .filter(([, rs]) => rs.length >= MIN_BAND_RUNS)
    .map(([b, rs]) => ({ b, rs, rate: smooth(rs.filter(isTop3).length, rs.length, k) }))
    .sort((a, b) => b.rate - a.rate || b.rs.length - a.rs.length);
  const ownDist: DistanceEntry =
    cands.length > 0
      ? {
          label: BAND_LABEL[cands[0].b] ?? cands[0].b,
          detail: `${raceSurface} ` + cands.map((x) => `${BAND_LABEL[x.b] ?? x.b} ${x.rs.filter(isTop3).length}/${x.rs.length}`).join('・'),
        }
      : { label: null, detail: `${raceSurface}で同じ距離帯に2走以上の出走なし` };
  // ベスト距離（血統）
  let pedDist: DistanceEntry;
  if (ped && ped.distance.length > 0) {
    const best = [...ped.distance].sort((a, b) => b.rate - a.rate)[0];
    pedDist = {
      label: SIRE_BUCKET_LABEL[best.bucket] ?? best.bucket,
      detail: `産駒の${raceSurface} ` + ped.distance.map((d) => `${SIRE_BUCKET_LABEL[d.bucket] ?? d.bucket} ${pct(d.rate)}`).join('・'),
    };
  } else {
    pedDist = { label: null, detail: ped ? '産駒の距離別の成績が不足' : '血統未取得' };
  }

  // 競馬場別（全10場・自身のみ）
  const venues: VenueEntry[] = JRA_VENUES.map((v) => {
    const rs = runs.filter((r) => r.venueName === v);
    const l3 = rs.map((r) => r.last3f).filter((x): x is number => typeof x === 'number' && x > 0);
    const extra = v === '東京' && l3.length > 0 ? `・上がり3F平均 ${(l3.reduce((a, b) => a + b, 0) / l3.length).toFixed(1)}秒（参考）` : '';
    return { venue: v, top3: rs.filter(isTop3).length, n: rs.length, ...ownEntry(rs, v, k, extra) };
  });

  // コースの特徴別（自身のみ）
  const features: FeatureEntry[] = COURSE_FEATURES.map((f) => ({
    key: f.key,
    label: f.label,
    venues: f.venues,
    ...ownEntry(runs.filter((r) => f.venues.includes(r.venueName ?? '')), `${f.label}（${f.venues.join('・')}）`, k),
  }));

  return { heavy, bestDistance: { own: ownDist, pedigree: pedDist }, venues, features, currentVenue: raceVenue };
}
