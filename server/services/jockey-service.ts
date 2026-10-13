/**
 * 騎手成績の取得（過去5年・JRAのみ）と分析
 *
 * アクセス制限を受けないための方針:
 * - 騎手ページ専用の取得処理を使い、間隔を通常より長くする（既定 5 秒）
 * - 1回の実行で読むページ数に上限を設け、続きは次回に回す（進捗は DB に保存）
 * - 403/429/503 を受けたら、その回の取得をすべて中断する
 * - 2回目以降は、保存済みの最新日付に達した時点で読むのをやめる
 */

import fs from 'fs';
import path from 'path';
import type { NetkeibaSource, JockeyPage } from '../sources/netkeiba';
import { normalizeCondition } from '../sources/netkeiba';
import { RateLimitedError } from '../sources/fetcher';
import type { JockeyRunRecord, RaceRepository } from '../db/repository';

const JRA_VENUE_CODES = new Set(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']);

export type RunningStyle = '逃げ' | '先行' | '差し' | '追込';

/** 最初のコーナーの順位と頭数から脚質を判定する */
export function runningStyleOf(firstCorner: number | null, headcount: number | null): RunningStyle | null {
  if (firstCorner === null || headcount === null || headcount <= 0) return null;
  if (firstCorner === 1) return '逃げ';
  if (firstCorner <= headcount / 3) return '先行';
  if (firstCorner <= (headcount * 2) / 3) return '差し';
  return '追込';
}

export function distanceBandOf(distance: number | null): string | null {
  if (distance === null) return null;
  if (distance <= 1400) return '短距離(〜1400)';
  if (distance <= 1800) return 'マイル(〜1800)';
  if (distance <= 2200) return '中距離(〜2200)';
  return '長距離(2201〜)';
}

export function frameGroupOf(frame: number | null): string | null {
  if (frame === null) return null;
  if (frame <= 3) return '内枠(1-3)';
  if (frame <= 6) return '中枠(4-6)';
  return '外枠(7-8)';
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 今日から years 年前の日付（YYYY-MM-DD） */
export function cutoffDate(years: number, today = new Date()): string {
  const d = new Date(today);
  d.setFullYear(d.getFullYear() - years);
  return ymd(d);
}

export interface CrawlStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  totalJockeys: number;
  doneJockeys: number;
  pagesFetched: number;
  pageBudget: number;
  current: string | null;
  stoppedReason: string | null;
  errors: string[];
}

export interface RateRow {
  label: string;
  rides: number;
  top3: number;
  wins: number;
}

export interface JockeyAnalysisItem {
  jockeyId: string | null;
  name: string | null;
  horseNumber: number | null;
  horseName: string;
  status: 'ok' | 'no_id' | 'not_fetched';
  crawl: { backfillDone: boolean; newestDate: string | null; oldestDate: string | null } | null;
  rides: number;
  first: number;
  second: number;
  third: number;
  /** 着順（1〜3）ごとの脚質・枠の内訳 */
  byFinish: { finish: number; count: number; styles: Record<string, number>; frames: Record<string, number> }[];
  styleRates: RateRow[];
  frameRates: RateRow[];
  surfaceRates: RateRow[];
  distanceRates: RateRow[];
  venueRates: RateRow[];
  conditionRates: RateRow[];
  /** 今回と同じ条件（会場・芝ダ・距離帯）での成績 */
  current: RateRow | null;
  notes: { note: string; source?: string; checkedAt?: string }[];
  /** 直近の騎乗（netkeiba の騎手ページと見比べて仕様を確認するため） */
  recent: JockeyRunRecord[];
}

export interface JockeyAnalysis {
  raceKey: string;
  fromDate: string;
  styleRule: string;
  items: JockeyAnalysisItem[];
}

function emptyStatus(): CrawlStatus {
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    totalJockeys: 0,
    doneJockeys: 0,
    pagesFetched: 0,
    pageBudget: 0,
    current: null,
    stoppedReason: null,
    errors: [],
  };
}

function groupRates(runs: JockeyRunRecord[], keyOf: (r: JockeyRunRecord) => string | null): RateRow[] {
  const map = new Map<string, RateRow>();
  for (const r of runs) {
    const key = keyOf(r);
    if (!key) continue;
    const row = map.get(key) ?? { label: key, rides: 0, top3: 0, wins: 0 };
    row.rides++;
    if (r.finishPosition !== null && r.finishPosition <= 3) row.top3++;
    if (r.finishPosition === 1) row.wins++;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.rides - a.rides);
}

export class JockeyService {
  private status: CrawlStatus = emptyStatus();
  /** この時刻（ミリ秒）を過ぎたら、きりの良いところで止める（夜間ジョブ用）。null なら時刻では止めない */
  private deadline: number | null = null;
  private pastDeadline(): boolean {
    return this.deadline !== null && Date.now() >= this.deadline;
  }

  constructor(
    private readonly source: NetkeibaSource,
    private readonly repo: RaceRepository,
    private readonly notesPath = path.resolve(process.cwd(), 'server', 'data', 'jockey-notes.json'),
  ) {}

  getStatus(): CrawlStatus {
    return { ...this.status, errors: [...this.status.errors] };
  }

  /**
   * 騎手成績を取得して保存する。
   * @param jockeyIds 対象の騎手ID
   * @param pageBudget この回に読むページ数の上限（超えたら続きは次回）
   */
  async crawl(jockeyIds: string[], pageBudget = 3000, years = 5, deadline?: number): Promise<CrawlStatus> {
    this.deadline = deadline ?? null;
    if (this.status.running) throw new Error('騎手成績を取得中です。終わってから実行してください');

    this.status = {
      ...emptyStatus(),
      running: true,
      startedAt: new Date().toISOString(),
      totalJockeys: jockeyIds.length,
      pageBudget,
    };
    const cutoff = cutoffDate(years);
    let consecutiveErrors = 0;

    try {
      for (const jockeyId of jockeyIds) {
        if (this.status.pagesFetched >= pageBudget) {
          this.status.stoppedReason = `1回の上限（${pageBudget}ページ）に達したため、続きは次回取得します`;
          break;
        }
        if (this.pastDeadline()) {
          this.status.stoppedReason = '終了時刻になったため、続きは次回取得します';
          break;
        }
        this.status.current = jockeyId;
        try {
          await this.crawlOne(jockeyId, cutoff, pageBudget);
          consecutiveErrors = 0;
        } catch (err: any) {
          if (err instanceof RateLimitedError || err?.name === 'RateLimitedError') {
            this.status.stoppedReason = `アクセス制限の可能性があるため中断しました（${err.message}）`;
            break;
          }
          this.status.errors.push(`${jockeyId}: ${err?.message ?? err}`);
          consecutiveErrors++;
          if (consecutiveErrors >= 3) {
            this.status.stoppedReason = 'エラーが3回続いたため中断しました';
            break;
          }
        }
        this.status.doneJockeys++;
      }
    } finally {
      this.status.running = false;
      this.status.current = null;
      this.status.finishedAt = new Date().toISOString();
    }
    return this.getStatus();
  }

  /** 1人分：新しい分（前回以降）→ 過去分（5年前まで）の順に読む */
  private async crawlOne(jockeyId: string, cutoff: string, pageBudget: number): Promise<void> {
    const state = this.repo.getCrawlState(jockeyId) ?? {
      jockeyId,
      newestDate: null,
      backfillPage: 1,
      backfillDone: false,
    };
    let newest = state.newestDate;

    const fetchPage = async (page: number): Promise<JockeyPage | null> => {
      if (this.status.pagesFetched >= pageBudget || this.pastDeadline()) return null;
      this.status.pagesFetched++;
      const p = await this.source.fetchJockeyPage(jockeyId, page);
      if (page === 1) {
        if (p.rows.length === 0) throw new Error('成績表が読み取れませんでした（ページ構造の変更の可能性）');
        this.repo.upsertJockey(jockeyId, p.jockeyName);
      }
      this.saveRows(jockeyId, p, cutoff);
      for (const r of p.rows) if (!newest || r.date > newest) newest = r.date;
      return p;
    };

    // 1. 前回以降の新しい分（保存済みの最新日付に達したら終了）
    // 途中で上限に達した場合は最新日付を進めない（読み残しを次回に取り直すため）
    let updateComplete = !state.newestDate;
    if (state.newestDate) {
      for (let page = 1; ; page++) {
        const p = await fetchPage(page);
        if (!p) break;
        const reached = p.rows.some((r) => r.date <= (state.newestDate as string));
        if (reached || p.rows.length === 0 || (p.lastPage !== null && page >= p.lastPage)) {
          updateComplete = true;
          break;
        }
      }
    }
    const savedNewest = () => (updateComplete ? newest : state.newestDate);

    // 2. 過去分（5年前より古い行が出るまで。途中で止まっても次回この続きから）
    let page = state.backfillPage;
    let done = state.backfillDone;
    while (!done) {
      const p = await fetchPage(page);
      if (!p) break;
      const oldest = p.rows.reduce<string | null>((min, r) => (min === null || r.date < min ? r.date : min), null);
      if (p.rows.length === 0 || (oldest !== null && oldest < cutoff) || (p.lastPage !== null && page >= p.lastPage)) {
        done = true;
      } else {
        page++;
      }
      this.repo.saveCrawlState({ jockeyId, newestDate: savedNewest(), backfillPage: page, backfillDone: done });
    }
    this.repo.saveCrawlState({ jockeyId, newestDate: savedNewest(), backfillPage: page, backfillDone: done });
  }

  /** JRAかつ期間内の行だけを保存する */
  private saveRows(jockeyId: string, page: JockeyPage, cutoff: string): void {
    const fetchedAt = new Date().toISOString();
    const runs: JockeyRunRecord[] = page.rows
      .filter((r) => JRA_VENUE_CODES.has(r.raceId.substring(4, 6)) && r.date >= cutoff)
      .map((r) => ({
        jockeyId,
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
        horseName: r.horseName,
        horseId: r.horseId,
        surface: r.surface,
        distance: r.distance,
        trackCondition: r.trackCondition,
        passing: r.passing,
        firstCorner: r.firstCorner,
        runningStyle: runningStyleOf(r.firstCorner, r.headcount),
        fetchedAt,
      }));
    if (runs.length > 0) this.repo.saveJockeyRuns(runs);
  }

  private loadNotes(): Record<string, { note: string; source?: string; checkedAt?: string }[]> {
    try {
      return JSON.parse(fs.readFileSync(this.notesPath, 'utf8'));
    } catch {
      return {};
    }
  }

  /** 選択中レースの騎手ごとに、過去5年の成績を分析する */
  analyze(raceKey: string, years = 5): JockeyAnalysis {
    const race = this.repo.getRace(raceKey);
    if (!race) throw new Error('対象レースが未登録です');

    const fromDate = cutoffDate(years);
    const notes = this.loadNotes();
    const currentBand = distanceBandOf(race.distance);
    const currentLabel = `${race.venueName}・${race.surface}・${currentBand ?? '-'}`;

    const items: JockeyAnalysisItem[] = this.repo.getEntries(raceKey).map((e) => {
      const base: JockeyAnalysisItem = {
        jockeyId: e.jockeyId ?? null,
        name: e.jockey,
        horseNumber: e.horseNumber,
        horseName: e.horseName,
        status: 'ok',
        crawl: null,
        rides: 0,
        first: 0,
        second: 0,
        third: 0,
        byFinish: [],
        styleRates: [],
        frameRates: [],
        surfaceRates: [],
        distanceRates: [],
        venueRates: [],
        conditionRates: [],
        current: null,
        notes: [],
        recent: [],
      };
      if (!e.jockeyId) return { ...base, status: 'no_id' };

      const state = this.repo.getCrawlState(e.jockeyId);
      const runs = this.repo.listJockeyRuns(e.jockeyId, fromDate);
      base.notes = notes[e.jockeyId] ?? [];
      base.name = this.repo.getJockeyName(e.jockeyId) ?? e.jockey;
      if (!state || runs.length === 0) return { ...base, status: 'not_fetched' };

      base.crawl = {
        backfillDone: state.backfillDone,
        newestDate: runs[0]?.date ?? null,
        oldestDate: runs[runs.length - 1]?.date ?? null,
      };
      base.rides = runs.length;
      base.recent = runs.slice(0, 10);
      base.first = runs.filter((r) => r.finishPosition === 1).length;
      base.second = runs.filter((r) => r.finishPosition === 2).length;
      base.third = runs.filter((r) => r.finishPosition === 3).length;

      base.byFinish = [1, 2, 3].map((finish) => {
        const rs = runs.filter((r) => r.finishPosition === finish);
        const styles: Record<string, number> = {};
        const frames: Record<string, number> = {};
        for (const r of rs) {
          const s = r.runningStyle ?? '不明';
          styles[s] = (styles[s] ?? 0) + 1;
          const f = frameGroupOf(r.frameNumber) ?? '不明';
          frames[f] = (frames[f] ?? 0) + 1;
        }
        return { finish, count: rs.length, styles, frames };
      });

      base.styleRates = groupRates(runs, (r) => r.runningStyle);
      base.frameRates = groupRates(runs, (r) => frameGroupOf(r.frameNumber));
      base.surfaceRates = groupRates(runs, (r) => r.surface);
      base.distanceRates = groupRates(runs, (r) => distanceBandOf(r.distance));
      base.venueRates = groupRates(runs, (r) => r.venueName).slice(0, 6);
      base.conditionRates = groupRates(runs, (r) => normalizeCondition(r.trackCondition)); // 保存済みの略記（稍・不）もそろえる

      const same = runs.filter(
        (r) => r.venueName === race.venueName && r.surface === race.surface && distanceBandOf(r.distance) === currentBand,
      );
      base.current = groupRates(same, () => currentLabel)[0] ?? { label: currentLabel, rides: 0, top3: 0, wins: 0 };
      return base;
    });

    return {
      raceKey,
      fromDate,
      styleRule:
        '脚質は最初のコーナーの順位で判定（1番手=逃げ、頭数の1/3以内=先行、2/3以内=差し、それより後ろ=追込）。コーナーの無い直線コースは判定なし',
      items,
    };
  }
}
