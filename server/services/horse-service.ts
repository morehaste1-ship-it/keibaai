/**
 * 馬の過去走の取得と、「騎手 × 馬の脚質・枠」の相性分析
 *
 * アクセス制限を避けるため:
 * - 騎手ページと同じ取得処理（5秒間隔）を使う
 * - 6日以内に取得済みの馬は読まない（同じ週に何度も読まない）
 * - 1回の上限ページ数を設け、403/429/503 を受けたら全体を中断する
 */

import type { NetkeibaSource } from '../sources/netkeiba';
import { RateLimitedError } from '../sources/fetcher';
import type { HorseRunRecord, JockeyRunRecord, RaceRepository } from '../db/repository';
import { cutoffDate, frameGroupOf, runningStyleOf, type RateRow } from './jockey-service';

const JRA_VENUE_CODES = new Set(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']);
const SKIP_IF_FETCHED_WITHIN_MS = 6 * 24 * 60 * 60 * 1000;
/** 馬の主な脚質を判定するときに見る直近の走数 */
const STYLE_WINDOW = 10;

export interface HorseCrawlStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  totalHorses: number;
  doneHorses: number;
  skippedHorses: number;
  pagesFetched: number;
  pageBudget: number;
  stoppedReason: string | null;
  rateLimited: boolean;
  errors: string[];
}

export interface MatchupItem {
  horseNumber: number | null;
  frameNumber: number | null;
  horseName: string;
  horseId: string | null;
  jockeyId: string | null;
  jockeyName: string | null;
  horseStatus: 'ok' | 'no_id' | 'not_fetched' | 'no_runs';
  /** 馬の主な脚質（直近10走で最も多いもの）と内訳 */
  mainStyle: string | null;
  mainStyleShare: number | null;
  styleCounts: Record<string, number>;
  /** 馬の脚質別の成績（直近10走） */
  horseStyleRates: RateRow[];
  /** 騎手が「馬の主な脚質」の馬で3着以内に入った率（過去5年） */
  jockeyStyleRate: RateRow | null;
  /** 騎手が今回の枠（内・中・外）で3着以内に入った率（過去5年） */
  jockeyFrameRate: RateRow | null;
  /** この馬とこの騎手のコンビ成績（全期間・JRA） */
  combo: RateRow | null;
  recent: Pick<
    HorseRunRecord,
    'date' | 'venueName' | 'raceName' | 'surface' | 'distance' | 'trackCondition' | 'headcount' | 'frameNumber' | 'popularity' | 'finishText' | 'jockeyName' | 'passing' | 'runningStyle' | 'last3f'
  >[];
}

export interface MatchupAnalysis {
  raceKey: string;
  note: string;
  items: MatchupItem[];
}

function emptyStatus(): HorseCrawlStatus {
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    totalHorses: 0,
    doneHorses: 0,
    skippedHorses: 0,
    pagesFetched: 0,
    pageBudget: 0,
    stoppedReason: null,
    rateLimited: false,
    errors: [],
  };
}

function rateOf(label: string, runs: { finishPosition: number | null }[]): RateRow {
  return {
    label,
    rides: runs.length,
    top3: runs.filter((r) => r.finishPosition !== null && r.finishPosition <= 3).length,
    wins: runs.filter((r) => r.finishPosition === 1).length,
  };
}

export class HorseService {
  private status: HorseCrawlStatus = emptyStatus();

  constructor(
    private readonly source: NetkeibaSource,
    private readonly repo: RaceRepository,
  ) {}

  getStatus(): HorseCrawlStatus {
    return { ...this.status, errors: [...this.status.errors] };
  }

  /** 馬の過去走を取得して保存する */
  async crawl(horseIds: string[], pageBudget = 1500, deadline?: number): Promise<HorseCrawlStatus> {
    if (this.status.running) throw new Error('馬の過去走を取得中です。終わってから実行してください');
    this.status = {
      ...emptyStatus(),
      running: true,
      startedAt: new Date().toISOString(),
      totalHorses: horseIds.length,
      pageBudget,
    };
    let consecutiveErrors = 0;

    try {
      for (const horseId of horseIds) {
        const fetchedAt = this.repo.getHorseFetchedAt(horseId);
        if (fetchedAt && Date.now() - new Date(fetchedAt).getTime() < SKIP_IF_FETCHED_WITHIN_MS) {
          this.status.skippedHorses++;
          this.status.doneHorses++;
          continue;
        }
        if (this.status.pagesFetched >= pageBudget) {
          this.status.stoppedReason = `1回の上限（${pageBudget}ページ）に達したため、続きは次回取得します`;
          break;
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          this.status.stoppedReason = '終了時刻になったため、続きは次回取得します';
          break;
        }
        try {
          this.status.pagesFetched++;
          const page = await this.source.fetchHorsePage(horseId);
          const now = new Date().toISOString();
          const runs: HorseRunRecord[] = page.rows
            .filter((r) => JRA_VENUE_CODES.has(r.raceId.substring(4, 6)))
            .map((r) => ({
              horseId,
              raceId: r.raceId,
              date: r.date,
              venueName: r.venueName,
              raceNo: r.raceNo,
              raceName: r.raceName,
              headcount: r.headcount,
              frameNumber: r.frameNumber,
              horseNumber: r.horseNumber,
              winOdds: r.winOdds,
              popularity: r.popularity,
              finishPosition: r.finishPosition,
              finishText: r.finishText,
              jockeyId: r.jockeyId,
              jockeyName: r.jockeyName,
              surface: r.surface,
              distance: r.distance,
              trackCondition: r.trackCondition,
              passing: r.passing,
              firstCorner: r.firstCorner,
              runningStyle: runningStyleOf(r.firstCorner, r.headcount),
              last3f: r.last3f,
              last3fRank: r.last3fRank,
              bodyWeight: r.bodyWeight,
              bodyWeightDiff: r.bodyWeightDiff,
              timeSec: r.timeSec,
              marginSec: r.marginSec,
              carriedWeight: r.carriedWeight,
              paceFront: r.paceFront,
              paceBack: r.paceBack,
              fetchedAt: now,
            }));
          this.repo.saveHorseRuns(horseId, page.horseName, runs);
          consecutiveErrors = 0;
        } catch (err: any) {
          if (err instanceof RateLimitedError || err?.name === 'RateLimitedError') {
            this.status.stoppedReason = `アクセス制限の可能性があるため中断しました（${err.message}）`;
            this.status.rateLimited = true;
            break;
          }
          this.status.errors.push(`${horseId}: ${err?.message ?? err}`);
          consecutiveErrors++;
          if (consecutiveErrors >= 5) {
            this.status.stoppedReason = 'エラーが5回続いたため中断しました';
            break;
          }
        }
        this.status.doneHorses++;
      }
    } finally {
      this.status.running = false;
      this.status.finishedAt = new Date().toISOString();
    }
    return this.getStatus();
  }

  /** 選択中レースの出走馬ごとに、馬の脚質と騎手の相性を分析する */
  analyzeRace(raceKey: string): MatchupAnalysis {
    const race = this.repo.getRace(raceKey);
    if (!race) throw new Error('対象レースが未登録です');
    const jockeyFrom = cutoffDate(5);
    const jockeyRunsCache = new Map<string, JockeyRunRecord[]>();

    const items = this.repo.getEntries(raceKey).map((e): MatchupItem => {
      const horseId = e.netkeibaHorseId ?? null;
      const jockeyId = e.jockeyId ?? null;
      const item: MatchupItem = {
        horseNumber: e.horseNumber,
        frameNumber: e.frameNumber,
        horseName: e.horseName,
        horseId,
        jockeyId,
        jockeyName: (jockeyId && this.repo.getJockeyName(jockeyId)) || e.jockey,
        horseStatus: 'ok',
        mainStyle: null,
        mainStyleShare: null,
        styleCounts: {},
        horseStyleRates: [],
        jockeyStyleRate: null,
        jockeyFrameRate: null,
        combo: null,
        recent: [],
      };

      // 騎手の今回の枠での成績（馬の過去走が無くても出せる）
      let jockeyRuns: JockeyRunRecord[] = [];
      if (jockeyId) {
        jockeyRuns = jockeyRunsCache.get(jockeyId) ?? this.repo.listJockeyRuns(jockeyId, jockeyFrom);
        jockeyRunsCache.set(jockeyId, jockeyRuns);
        const fg = frameGroupOf(e.frameNumber);
        if (fg && jockeyRuns.length > 0) {
          item.jockeyFrameRate = rateOf(fg, jockeyRuns.filter((r) => frameGroupOf(r.frameNumber) === fg));
        }
      }

      if (!horseId) return { ...item, horseStatus: 'no_id' };
      if (!this.repo.getHorseFetchedAt(horseId)) return { ...item, horseStatus: 'not_fetched' };
      const runs = this.repo.listHorseRuns(horseId);
      if (runs.length === 0) return { ...item, horseStatus: 'no_runs' };

      const window = runs.filter((r) => r.runningStyle).slice(0, STYLE_WINDOW);
      for (const r of window) item.styleCounts[r.runningStyle as string] = (item.styleCounts[r.runningStyle as string] ?? 0) + 1;
      const top = Object.entries(item.styleCounts).sort((a, b) => b[1] - a[1])[0];
      if (top) {
        item.mainStyle = top[0];
        item.mainStyleShare = Math.round((top[1] / window.length) * 100) / 100;
      }
      item.horseStyleRates = Object.keys(item.styleCounts).map((s) =>
        rateOf(s, window.filter((r) => r.runningStyle === s)),
      );

      if (item.mainStyle && jockeyRuns.length > 0) {
        item.jockeyStyleRate = rateOf(item.mainStyle, jockeyRuns.filter((r) => r.runningStyle === item.mainStyle));
      }
      if (jockeyId) {
        item.combo = rateOf('コンビ', runs.filter((r) => r.jockeyId === jockeyId));
      }
      item.recent = runs.slice(0, 5).map((r) => ({
        date: r.date,
        venueName: r.venueName,
        raceName: r.raceName,
        surface: r.surface,
        distance: r.distance,
        trackCondition: r.trackCondition,
        headcount: r.headcount,
        frameNumber: r.frameNumber,
        popularity: r.popularity,
        finishText: r.finishText,
        jockeyName: r.jockeyName,
        passing: r.passing,
        runningStyle: r.runningStyle,
        last3f: r.last3f,
      }));
      return item;
    });

    return {
      raceKey,
      note: `馬の主な脚質は直近${STYLE_WINDOW}走（JRA）で最も多いもの。騎手の成績は過去5年。コンビ成績は全期間（JRA）`,
      items,
    };
  }
}
