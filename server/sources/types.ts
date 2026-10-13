/**
 * 取得元アダプタの共通ルール
 *
 * netkeiba 用・JRA-VAN 用などのアダプタは、すべてこのインターフェースを実装する。
 * アダプタは「取得して共通形式に変換する」までを担当し、保存はしない（保存はリポジトリの役割）。
 * 内部キー（horseKey など）はリポジトリが割り当てるため、アダプタは取得元のID（SourceRef）だけを返す。
 */
import type {
  EntryRecord,
  HorseRecord,
  PastResultRecord,
  RaceRecord,
  SourceId,
  SourceRef,
  WinOddsRecord,
} from '../domain/types';

/** アダプタが返す出走馬。horseKey の代わりに取得元の馬IDを持つ */
export type SourceEntry = Omit<EntryRecord, 'raceKey' | 'horseKey'> & { horseRef: SourceRef };

/** アダプタが返す馬情報 */
export type SourceHorse = Omit<HorseRecord, 'horseKey'> & { horseRef: SourceRef };

/** アダプタが返す過去走 */
export type SourcePastResult = Omit<PastResultRecord, 'horseKey'>;

/** 出馬表の取得結果 */
export interface RaceCardResult {
  raceRef: SourceRef;
  race: RaceRecord; // raceKey は開催日・場・Rから決まるのでアダプタ側で生成してよい
  entries: SourceEntry[];
}

/** 単勝オッズの取得結果 */
export interface WinOddsResult {
  raceRef: SourceRef;
  odds: Omit<WinOddsRecord, 'raceKey'>[];
}

/** 馬の詳細（基本情報＋過去走）の取得結果 */
export interface HorseHistoryResult {
  horse: SourceHorse;
  results: SourcePastResult[];
}

export interface RaceDataSource {
  readonly id: SourceId;

  /** ユーザー入力（URLやID）を取得元のレース参照に変換する。解釈できなければ null */
  parseRaceInput(input: string): SourceRef | null;

  fetchRaceCard(raceRef: SourceRef): Promise<RaceCardResult>;
  fetchWinOdds(raceRef: SourceRef): Promise<WinOddsResult>;
  fetchHorseHistory(horseRef: SourceRef): Promise<HorseHistoryResult>;
}

/** 取得元のページ構造が想定と違うなど、解析に失敗したことを示すエラー */
export class SourceParseError extends Error {
  constructor(
    message: string,
    public readonly url?: string,
  ) {
    super(message);
    this.name = 'SourceParseError';
  }
}
