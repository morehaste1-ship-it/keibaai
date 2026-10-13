/**
 * 共通データ形式（Canonical Model）
 *
 * 取得元（netkeiba / 将来の JRA-VAN）に依存しない、アプリ内部の標準データ形式。
 * 取得元アダプタは必ずこの形に変換してから保存する。
 * 取得元が変わっても、この型とデータベースは変更しない。
 */

export type SourceId = 'netkeiba' | 'jravan' | 'manual';

/** 取得元側のID参照（例: netkeiba のレースID、馬ID） */
export interface SourceRef {
  source: SourceId;
  id: string;
}

export type Surface = '芝' | 'ダート' | '障害';
export type TrackCondition = '良' | '稍重' | '重' | '不良';
export type Weather = '晴' | '曇' | '小雨' | '雨' | '小雪' | '雪';
export type Sex = '牡' | '牝' | 'セン';

/** JRA 競馬場コード（01〜10） */
export type VenueCode = '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10';

/** レース基本情報 */
export interface RaceRecord {
  /** 内部キー: YYYYMMDD-競馬場コード-レース番号（例: 20261004-06-11） */
  raceKey: string;
  date: string; // YYYY-MM-DD
  venueCode: VenueCode;
  venueName: string;
  raceNo: number;
  name: string;
  grade: string | null; // G1 / G2 / G3 / L / OP / 条件名など。不明なら null
  surface: Surface;
  distance: number;
  courseVariant: string | null; // 内 / 外 / 直線 など
  turn: string | null; // 右 / 左 / 直線
  weather: Weather | null;
  trackCondition: TrackCondition | null;
  postTime: string | null; // HH:MM
  headcount: number | null;
}

/** 出走馬（出馬表の1行） */
export interface EntryRecord {
  raceKey: string;
  horseKey: string;
  horseNumber: number | null; // 馬番（枠順確定前は null）
  frameNumber: number | null; // 枠番
  horseName: string;
  sex: Sex | null;
  age: number | null;
  jockey: string | null; // 騎手名（見習いの印「▲」は含まない）
  apprentice: boolean; // 見習い騎手か（斤量減量の対象）
  trainer: string | null;
  carriedWeight: number | null; // 斤量
  bodyWeight: number | null; // 馬体重
  bodyWeightDiff: number | null; // 前走比
  scratched: boolean; // 出走取消・除外
  netkeibaHorseId?: string | null; // netkeiba 馬ID（10桁）
  jockeyId?: string | null; // netkeiba 騎手ID（5桁）
}

/** 馬の基本情報 */
export interface HorseRecord {
  horseKey: string;
  name: string;
  sex: Sex | null;
  birthYear: number | null;
  sire: string | null; // 父
  dam: string | null; // 母
  damSire: string | null; // 母父
}

/** 単勝オッズ（取得時刻つきで時系列保存） */
export interface WinOddsRecord {
  raceKey: string;
  horseNumber: number;
  winOdds: number | null;
  popularity: number | null;
  fetchedAt: string; // ISO8601
  /** 確定オッズか、発売中の暫定値か、事前の予想オッズか */
  kind: 'final' | 'live' | 'forecast';
}

/** 過去走（馬の成績1行） */
export interface PastResultRecord {
  horseKey: string;
  date: string; // YYYY-MM-DD
  venueName: string;
  raceName: string;
  grade: string | null;
  surface: Surface | null;
  distance: number | null;
  trackCondition: TrackCondition | null;
  weather: Weather | null;
  headcount: number | null;
  horseNumber: number | null;
  finishPosition: number | null; // 中止・除外などは null
  finishNote: string | null; // 「中止」「除外」など
  popularity: number | null;
  winOdds: number | null;
  jockey: string | null;
  carriedWeight: number | null;
  time: string | null; // 例: 1:07.8
  margin: string | null;
  passing: string | null; // 通過順 例: 3-3
  last3F: number | null; // 上がり3F（秒）
  bodyWeight: number | null;
}

/**
 * 推定値・派生指標
 * オッズ逆算など「実データではない値」は必ずここに入れ、is_estimated で区別する。
 */
export interface EntryMetricRecord {
  raceKey: string;
  horseKey: string;
  metric: string; // speedRating / staminaRating など
  value: number;
  isEstimated: boolean;
  method: string; // 例: odds-inverse-v1
  computedAt: string;
}
