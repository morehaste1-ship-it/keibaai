/**
 * 定期バッチ処理サービス
 *
 * 木曜 21:00 に次週末のレースを取得（launchd）
 * 画面のボタンから、指定日を基準に週末、または単日のレースを取得
 */

import type { RaceDataSource } from '../sources/types';
import type { RaceRepository } from '../db/repository';
import type { CalendarRace, JraCalendar } from '../sources/jra-calendar';

export interface BatchStatus {
  executedAt: string;
  totalRaces: number;
  successCount: number;
  failureCount: number;
  details: BatchRaceResult[];
}

export interface BatchRaceResult {
  raceId: string;
  status: 'success' | 'failure';
  message: string;
  horseCount?: number;
  fetchedAt?: string;
}

export class BatchService {
  constructor(
    private readonly calendar: JraCalendar,
    private readonly source: RaceDataSource,
    private readonly repo: RaceRepository,
  ) {}

  /**
   * 週末のレースを一括取得
   * @param targetSaturday 対象の土曜日。省略時は次の土曜（木曜夜の定期実行用）
   */
  async prepareWeekendRaces(targetSaturday?: Date): Promise<BatchStatus> {
    return this.runWithCalendar(async () => {
      const races = await this.calendar.fetchNextWeekendRaces(targetSaturday);
      console.log(`[Batch] Found ${races.length} races for weekend`);
      return races;
    }, 'weekend');
  }

  /**
   * 指定した1日だけのレースを取得（祝日の平日開催など）
   * @param date 対象日
   */
  async prepareSingleDayRaces(date: Date): Promise<BatchStatus> {
    return this.runWithCalendar(async () => {
      const races = await this.calendar.fetchRacesOnDate(date);
      console.log(`[Batch] Found ${races.length} races for single day`);
      return races;
    }, 'single day');
  }

  /**
   * 対象レースを取得し、出馬表・単勝オッズを保存する（共通処理）
   */
  private async runWithCalendar(
    loadRaces: () => Promise<CalendarRace[]>,
    label: string,
  ): Promise<BatchStatus> {
    const executedAt = new Date().toISOString();
    const details: BatchRaceResult[] = [];

    try {
      // 1. 対象のレース一覧を取得
      const races = await loadRaces();

      // 2. 各レースについて出馬表を取得
      let successCount = 0;
      let failureCount = 0;

      for (const race of races) {
        try {
          console.log(`[Batch] Fetching race ${race.raceId} (${race.trackName} ${race.date})`);

          // レース情報を取得
          const raceCard = await this.source.fetchRaceCard({
            source: 'netkeiba',
            id: race.raceId,
          });

          // 出走馬が0頭（出馬表が未公開など）は保存せず、失敗として記録する
          if (raceCard.entries.length === 0) {
            throw new Error('出走馬が0頭です（出馬表が未公開の可能性）');
          }

          // DB に保存
          this.repo.saveRaceCard(raceCard);

          // 単勝オッズ（バッチ時点の値）を保存。失敗しても出馬表の成功は維持する
          try {
            const odds = await this.source.fetchWinOdds({ source: 'netkeiba', id: race.raceId });
            this.repo.saveWinOdds(odds);
          } catch (oddsErr: any) {
            console.warn(`[Batch] odds skipped ${race.raceId}: ${oddsErr?.message ?? oddsErr}`);
          }

          // 成功ログ
          details.push({
            raceId: race.raceId,
            status: 'success',
            message: `${race.trackName} ${race.raceName}`,
            horseCount: raceCard.entries.length,
            fetchedAt: executedAt,
          });

          successCount++;
          console.log(`[Batch] ✓ ${race.raceId}`);
        } catch (err: any) {
          // 失敗ログ
          details.push({
            raceId: race.raceId,
            status: 'failure',
            message: err?.message ?? 'Unknown error',
          });

          failureCount++;
          console.error(`[Batch] ✗ ${race.raceId}: ${err?.message ?? err}`);
        }
      }

      return {
        executedAt,
        totalRaces: races.length,
        successCount,
        failureCount,
        details,
      };
    } catch (err: any) {
      console.error(`[Batch] Failed to prepare ${label} races:`, err);
      return {
        executedAt,
        totalRaces: 0,
        successCount: 0,
        failureCount: 1,
        details: [
          {
            raceId: 'batch',
            status: 'failure',
            message: err?.message ?? 'Batch execution failed',
          },
        ],
      };
    } finally {
      // Puppeteer のブラウザインスタンスをクローズ
      await (this.calendar as any).close().catch(() => {});
    }
  }

  /**
   * 重賞（GI・GII・GIII）の単勝オッズを指定日の時点で更新する（当日12:00に実行）
   * @param date 対象日 YYYY-MM-DD
   */
  async refreshGradeRaceOdds(date: string): Promise<{ total: number; success: number; failure: number }> {
    const raceKeys = this.repo.listRaceKeysByGradeOnDate(date, ['GI', 'GII', 'GIII', 'G1', 'G2', 'G3']);
    console.log(`[Batch] Grade race odds refresh ${date}: ${raceKeys.length} races`);
    return this.refreshOdds(raceKeys);
  }

  /**
   * 指定日の全レースの単勝オッズを更新する（朝の全レース予想の前に実行）
   * @param date 対象日 YYYY-MM-DD
   */
  async refreshAllRaceOdds(date: string): Promise<{ total: number; success: number; failure: number }> {
    const raceKeys = this.repo.listRaceKeysOnDate(date);
    console.log(`[Batch] All race odds refresh ${date}: ${raceKeys.length} races`);
    return this.refreshOdds(raceKeys);
  }

  /** 指定レースの単勝オッズを1レースずつ取得して保存する */
  private async refreshOdds(raceKeys: string[]): Promise<{ total: number; success: number; failure: number }> {
    let success = 0;
    let failure = 0;
    for (const raceKey of raceKeys) {
      const raceId = this.repo.findRaceSourceId(raceKey, 'netkeiba');
      if (!raceId) {
        failure++;
        console.error(`[Batch] ✗ ${raceKey}: 取得元IDが未登録です`);
        continue;
      }
      try {
        const odds = await this.source.fetchWinOdds({ source: 'netkeiba', id: raceId });
        this.repo.saveWinOdds(odds);
        success++;
        console.log(`[Batch] ✓ odds ${raceKey}`);
      } catch (err: any) {
        failure++;
        console.error(`[Batch] ✗ odds ${raceKey}: ${err?.message ?? err}`);
      }
    }

    return { total: raceKeys.length, success, failure };
  }

  /**
   * 馬詳細情報を取得・補完する（将来実装）
   * 現在は出馬表のみ取得し、馬詳細は別途オンデマンド取得
   */
  async fetchHorseDetailsForRace(raceKey: string): Promise<void> {
    // TODO: implement horse history fetching
    // 各馬について fetchHorseHistory() を呼び出し
    console.log(`[Batch] Horse details for ${raceKey} - not yet implemented`);
  }
}
