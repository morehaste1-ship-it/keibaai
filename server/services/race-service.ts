/**
 * レース取得・保存のサービス層
 *
 * スクレイピング、DB保存、推定値計算などの複合処理を一つのインターフェースで提供
 */

import type { RaceDataSource } from '../sources/types';
import type { RaceRepository } from '../db/repository';
import type { RaceRecord, EntryRecord, WinOddsRecord } from '../domain/types';

export interface RaceCard {
  race: RaceRecord;
  entries: Array<EntryRecord & { odds?: WinOddsRecord | null }>;
}

export class RaceService {
  constructor(
    private readonly source: RaceDataSource,
    private readonly repo: RaceRepository,
  ) {}

  /**
   * レース ID またはURL からレースをスクレイピングして DB に保存、結果を返す
   */
  async fetchAndSaveRace(input: string): Promise<RaceCard> {
    // 入力をパース（URL or レース ID）
    const raceRef = this.source.parseRaceInput(input);
    if (!raceRef) {
      throw new Error(`Invalid race input: "${input}". Expected race ID (12 digits) or netkeiba URL`);
    }

    // 出馬表を取得
    const raceCardResult = await this.source.fetchRaceCard(raceRef);

    // DB に保存
    this.repo.saveRaceCard(raceCardResult);

    // DB から読み出して返す（最新のデータを返すため）
    const race = this.repo.getRace(raceCardResult.race.raceKey);
    if (!race) throw new Error('Failed to retrieve saved race');

    const entries = this.repo.getEntries(raceCardResult.race.raceKey);

    // オッズを添付（ある場合）
    const odds = this.repo.getLatestWinOdds(raceCardResult.race.raceKey);
    const oddsMap = new Map(odds.map((o) => [o.horseNumber, o]));

    const entriesWithOdds = entries.map((e) => ({
      ...e,
      odds: e.horseNumber ? oddsMap.get(e.horseNumber) : null,
    }));

    return {
      race,
      entries: entriesWithOdds,
    };
  }

  /**
   * DB から既存のレース情報を取得
   */
  getRaceCard(raceKey: string): RaceCard | null {
    const race = this.repo.getRace(raceKey);
    if (!race) return null;

    const entries = this.repo.getEntries(raceKey);
    const odds = this.repo.getLatestWinOdds(raceKey);
    const oddsMap = new Map(odds.map((o) => [o.horseNumber, o]));

    const entriesWithOdds = entries.map((e) => ({
      ...e,
      odds: e.horseNumber ? oddsMap.get(e.horseNumber) : null,
    }));

    return {
      race,
      entries: entriesWithOdds,
    };
  }

  /**
   * 最近のレース一覧を取得
   */
  listRaces(limit: number = 20): RaceRecord[] {
    return this.repo.listRaces().slice(0, limit);
  }

  /** 指定日以降のレース（画面の TOP 用） */
  listRacesFrom(fromDate: string, limit: number): RaceRecord[] {
    return this.repo.listRacesFrom(fromDate, limit);
  }

  /** 指定日のレース（画面の「過去のレース」用） */
  listRacesOnDate(date: string): RaceRecord[] {
    return this.repo.listRacesOnDate(date);
  }

  /** 指定日より前の開催日とレース数（新しい順） */
  listPastRaceDates(beforeDate: string): { date: string; races: number }[] {
    return this.repo.listPastRaceDates(beforeDate);
  }
}
