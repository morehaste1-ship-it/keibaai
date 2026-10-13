/**
 * リポジトリ: 共通形式のデータをデータベースに保存・読み出す窓口
 *
 * 取得元アダプタの結果（取得元ID付き）を受け取り、内部キーを割り当てて保存する。
 * 画面・予想ロジック側はここから読み出すだけで、取得元を意識しない。
 */
import crypto from 'crypto';
import type { DB } from './index';
import type {
  EntryMetricRecord,
  EntryRecord,
  HorseRecord,
  PastResultRecord,
  RaceRecord,
  SourceRef,
  WinOddsRecord,
} from '../domain/types';
import type { HorseHistoryResult, RaceCardResult, WinOddsResult } from '../sources/types';
import type { FetchLogEntry } from '../sources/fetcher';
import type { Pedigree, SireStatRow } from '../sources/netkeiba';

type Entity = 'race' | 'horse';

/** 騎手の1騎乗分（jockey_runs の1行） */
export interface JockeyRunRecord {
  jockeyId: string;
  raceId: string;
  date: string;
  venueName: string | null;
  raceNo: number | null;
  raceName: string | null;
  headcount: number | null;
  frameNumber: number | null;
  horseNumber: number | null;
  winOdds: number | null;
  popularity: number | null;
  finishPosition: number | null;
  finishText: string | null;
  horseName: string | null;
  horseId: string | null;
  surface: string | null;
  distance: number | null;
  trackCondition: string | null;
  passing: string | null;
  firstCorner: number | null;
  runningStyle: string | null;
  fetchedAt: string;
}

/** 馬の1走分（horse_runs の1行） */
export interface HorseRunRecord {
  horseId: string;
  raceId: string;
  date: string;
  venueName: string | null;
  raceNo: number | null;
  raceName: string | null;
  headcount: number | null;
  frameNumber: number | null;
  horseNumber: number | null;
  winOdds: number | null;
  popularity: number | null;
  finishPosition: number | null;
  finishText: string | null;
  jockeyId: string | null;
  jockeyName: string | null;
  surface: string | null;
  distance: number | null;
  trackCondition: string | null;
  passing: string | null;
  firstCorner: number | null;
  runningStyle: string | null;
  last3f: number | null;
  /** 上がり順位：1〜3 = 上がり3位以内、0 = 4位以下、null = 不明（v11 より前に取得した走など） */
  last3fRank?: number | null;
  bodyWeight?: number | null;
  bodyWeightDiff?: number | null;
  /** 走破タイム（秒。例 1:31.6 → 91.6）。不明は null */
  timeSec?: number | null;
  /** 着差（秒）。勝ち馬は2着との差をマイナスで（例 -0.2）、それ以外は勝ち馬との差。不明は null */
  marginSec?: number | null;
  /** 斤量（kg） */
  carriedWeight?: number | null;
  /** レースの前半3F・後半3F（秒。ページの「ペース」欄 例 34.5-33.5） */
  paceFront?: number | null;
  paceBack?: number | null;
  fetchedAt: string;
}

/** 騎手成績の取得進捗 */
export interface JockeyCrawlState {
  jockeyId: string;
  newestDate: string | null;
  backfillPage: number;
  backfillDone: boolean;
}

/** 過去同一レースの1頭分の結果（history_runs の1行） */
export interface HistoryRunRecord {
  sourceRaceId: string;
  horseNumber: number;
  seriesKey: string;
  date: string;
  venueName: string;
  raceName: string;
  surface: string;
  distance: number;
  trackCondition: string | null;
  headcount: number | null;
  horseName: string | null;
  finishPosition: number | null;
  finishText: string | null;
  popularity: number | null;
  winOdds: number | null;
  passing: string | null;
  corner4: number | null;
  fetchedAt: string;
}

/** 答え合わせ用に記録した予想 */
export interface PredictionRecord {
  raceKey: string;
  /** auto = 当日朝・昼の自動記録、eve = 前日予想（前日の深夜に自動記録）、manual = 画面から記録、backtest = 過去レースの検証用 */
  source: 'auto' | 'manual' | 'eve' | 'backtest';
  recordedAt: string;
  settings: {
    weights: Record<string, number>;
    horseK: number;
    jockeyK: number;
    shortageMode: string;
    condition: string | null;
    /** 記録時の展開予想（ずれの分析用。古い記録には無い） */
    paceForecast?: { pace: string; favored: string[] };
    /** 記録に使った単勝オッズの段階（forecast = 予想オッズ、live = 発売中、final = 確定、null = オッズなし）。古い記録には無い */
    oddsKind?: 'final' | 'live' | 'forecast' | null;
    /** 記録したときに採用中だった配分の版（0 = 既定の配分）。古い記録には無い */
    weightsVersionId?: number;
  };
  marks: {
    horseNumber: number;
    horseName: string;
    mark: string;
    rank: number;
    total: number;
    popularity: number | null;
    /** 以下はずれの分析用（古い記録には無い） */
    mainStyle?: string | null;
    firstCornerRatio?: number | null;
    scores?: Record<string, number | null>; // 項目ごとの点数（データ不足は null）
  }[];
  plans: { kind: string; available: boolean; reason: string; tickets: { first: number; second: number; third: number }[] }[];
}

/** 採用した配分（配分の自動見直しの履歴） */
export interface WeightVersion {
  id: number;
  weights: Record<string, number>;
  reason: string;
  note: string | null;
  metrics: Record<string, unknown> | null;
  adoptedAt: string;
}

/** 確定した結果（答え合わせ用） */
export interface RaceOutcome {
  raceKey: string;
  finishes: {
    horseNumber: number;
    horseName: string;
    finishPosition: number | null;
    finishText: string;
    popularity: number | null;
    /** 以下はずれの分析用（meta.detailVersion が 2 以上の結果のみ） */
    corner4?: number | null;
    last3f?: number | null;
    last3fRank?: number | null;
    bodyWeightDiff?: number | null;
  }[];
  trifecta: { combo: [number, number, number]; payout: number }[];
  /** 全券種の払戻（v9 以降に取り込んだ結果のみ。古い結果は null） */
  payouts?: Record<string, { combo: number[]; payout: number }[]> | null;
  /** ペース（S/M/H）・頭数など。detailVersion 2 以上なら、4角・上がり・馬体重も finishes に入っている */
  meta?: { pace: 'S' | 'M' | 'H' | null; headcount: number; detailVersion: number } | null;
  fetchedAt: string;
}

export class RaceRepository {
  constructor(private readonly db: DB) {}

  // ---------- 取得元IDの対応 ----------

  findInternalKey(entity: Entity, ref: SourceRef): string | null {
    const row = this.db
      .prepare('SELECT internal_key FROM source_ids WHERE entity = ? AND source = ? AND source_id = ?')
      .get(entity, ref.source, ref.id) as { internal_key: string } | undefined;
    return row?.internal_key ?? null;
  }

  private linkSourceId(entity: Entity, internalKey: string, ref: SourceRef) {
    this.db
      .prepare(
        `INSERT INTO source_ids (entity, internal_key, source, source_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(entity, source, source_id) DO UPDATE SET internal_key = excluded.internal_key`,
      )
      .run(entity, internalKey, ref.source, ref.id);
  }

  /** 取得元の馬IDに対応する内部キーを返す。未登録なら新しく発行する */
  private resolveHorseKey(ref: SourceRef): string {
    const existing = this.findInternalKey('horse', ref);
    if (existing) return existing;
    const key = `h_${crypto.randomUUID()}`;
    this.linkSourceId('horse', key, ref);
    return key;
  }

  // ---------- 保存 ----------

  /** 出馬表を保存する。同じレースを再取得した場合は出走馬一覧を置き換える */
  saveRaceCard(result: RaceCardResult): string {
    const now = new Date().toISOString();
    const r = result.race;

    this.db.transaction(() => {
      this.upsertRace(r, now);
      this.linkSourceId('race', r.raceKey, result.raceRef);

      this.db.prepare('DELETE FROM entries WHERE race_key = ?').run(r.raceKey);
      for (const e of result.entries) {
        const horseKey = this.resolveHorseKey(e.horseRef);
        this.ensureHorse(horseKey, e.horseName, e.sex, now);
        this.insertEntry({ ...e, raceKey: r.raceKey, horseKey }, now);
      }
    })();

    return r.raceKey;
  }

  /** 単勝オッズを保存する（上書きせず、取得時刻ごとに追加） */
  saveWinOdds(result: WinOddsResult): string {
    const raceKey = this.findInternalKey('race', result.raceRef);
    if (!raceKey) throw new Error('先に出馬表を取り込んでください（対象レースが未登録です）');

    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO win_odds (race_key, horse_number, win_odds, popularity, kind, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const o of result.odds) stmt.run(raceKey, o.horseNumber, o.winOdds, o.popularity, o.kind, o.fetchedAt);
    })();
    return raceKey;
  }

  /** 馬の基本情報と過去走を保存する */
  saveHorseHistory(result: HorseHistoryResult): string {
    const now = new Date().toISOString();
    const h = result.horse;

    let horseKey = '';
    this.db.transaction(() => {
      horseKey = this.resolveHorseKey(h.horseRef);
      this.db
        .prepare(
          `INSERT INTO horses (horse_key, name, sex, birth_year, sire, dam, dam_sire, updated_at)
           VALUES (@horseKey, @name, @sex, @birthYear, @sire, @dam, @damSire, @now)
           ON CONFLICT(horse_key) DO UPDATE SET
             name = excluded.name, sex = COALESCE(excluded.sex, horses.sex),
             birth_year = COALESCE(excluded.birth_year, horses.birth_year),
             sire = COALESCE(excluded.sire, horses.sire), dam = COALESCE(excluded.dam, horses.dam),
             dam_sire = COALESCE(excluded.dam_sire, horses.dam_sire), updated_at = excluded.updated_at`,
        )
        .run({ horseKey, name: h.name, sex: h.sex, birthYear: h.birthYear, sire: h.sire, dam: h.dam, damSire: h.damSire, now });

      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO past_results (
           horse_key, date, venue_name, race_name, grade, surface, distance, track_condition, weather,
           headcount, horse_number, finish_position, finish_note, popularity, win_odds, jockey,
           carried_weight, time, margin, passing, last3f, body_weight, updated_at
         ) VALUES (
           @horseKey, @date, @venueName, @raceName, @grade, @surface, @distance, @trackCondition, @weather,
           @headcount, @horseNumber, @finishPosition, @finishNote, @popularity, @winOdds, @jockey,
           @carriedWeight, @time, @margin, @passing, @last3F, @bodyWeight, @now
         )`,
      );
      for (const p of result.results) stmt.run({ ...p, horseKey, now });
    })();

    return horseKey;
  }

  /** 過去同一レースの結果を保存する（同じレース・馬番は上書き） */
  saveHistoryRuns(runs: HistoryRunRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO history_runs (
         source_race_id, horse_number, series_key, date, venue_name, race_name, surface, distance,
         track_condition, headcount, horse_name, finish_position, finish_text, popularity, win_odds,
         passing, corner4, fetched_at
       ) VALUES (
         @sourceRaceId, @horseNumber, @seriesKey, @date, @venueName, @raceName, @surface, @distance,
         @trackCondition, @headcount, @horseName, @finishPosition, @finishText, @popularity, @winOdds,
         @passing, @corner4, @fetchedAt
       )
       ON CONFLICT(source_race_id, horse_number) DO UPDATE SET
         series_key = excluded.series_key, date = excluded.date, venue_name = excluded.venue_name,
         race_name = excluded.race_name, surface = excluded.surface, distance = excluded.distance,
         track_condition = excluded.track_condition, headcount = excluded.headcount,
         horse_name = excluded.horse_name, finish_position = excluded.finish_position,
         finish_text = excluded.finish_text, popularity = excluded.popularity, win_odds = excluded.win_odds,
         passing = excluded.passing, corner4 = excluded.corner4, fetched_at = excluded.fetched_at`,
    );
    this.db.transaction(() => {
      for (const r of runs) stmt.run(r);
    })();
  }

  /** 同一シリーズ（競走名・会場・芝ダ・距離が一致）の過去結果を新しい順に返す */
  listHistoryRuns(seriesKey: string): HistoryRunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM history_runs WHERE series_key = ? ORDER BY date DESC, horse_number')
      .all(seriesKey) as any[];
    return rows.map((r) => ({
      sourceRaceId: r.source_race_id,
      horseNumber: r.horse_number,
      seriesKey: r.series_key,
      date: r.date,
      venueName: r.venue_name,
      raceName: r.race_name,
      surface: r.surface,
      distance: r.distance,
      trackCondition: r.track_condition,
      headcount: r.headcount,
      horseName: r.horse_name,
      finishPosition: r.finish_position,
      finishText: r.finish_text,
      popularity: r.popularity,
      winOdds: r.win_odds,
      passing: r.passing,
      corner4: r.corner4,
      fetchedAt: r.fetched_at,
    }));
  }

  // ---------- 騎手 ----------

  /** 指定日以降のレースに騎乗する騎手ID（重複なし） */
  listJockeyIdsFromDate(fromDate: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.jockey_id AS id FROM entries e JOIN races r ON r.race_key = e.race_key
         WHERE r.date >= ? AND e.jockey_id IS NOT NULL ORDER BY e.jockey_id`,
      )
      .all(fromDate) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** 取得を始めたが、5年分がまだそろっていない騎手ID（夜間ジョブで続きを取得する） */
  listIncompleteJockeyIds(): string[] {
    return (
      this.db.prepare('SELECT jockey_id FROM jockey_crawl_state WHERE backfill_done = 0 ORDER BY updated_at').all() as {
        jockey_id: string;
      }[]
    ).map((r) => r.jockey_id);
  }

  upsertJockey(jockeyId: string, name: string | null): void {
    this.db
      .prepare(
        `INSERT INTO jockeys (jockey_id, name, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(jockey_id) DO UPDATE SET name = COALESCE(excluded.name, jockeys.name), updated_at = excluded.updated_at`,
      )
      .run(jockeyId, name, new Date().toISOString());
  }

  getJockeyName(jockeyId: string): string | null {
    const r = this.db.prepare('SELECT name FROM jockeys WHERE jockey_id = ?').get(jockeyId) as { name: string } | undefined;
    return r?.name ?? null;
  }

  saveJockeyRuns(runs: JockeyRunRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO jockey_runs (
         jockey_id, race_id, date, venue_name, race_no, race_name, headcount, frame_number, horse_number,
         win_odds, popularity, finish_position, finish_text, horse_name, horse_id, surface, distance,
         track_condition, passing, first_corner, running_style, fetched_at
       ) VALUES (
         @jockeyId, @raceId, @date, @venueName, @raceNo, @raceName, @headcount, @frameNumber, @horseNumber,
         @winOdds, @popularity, @finishPosition, @finishText, @horseName, @horseId, @surface, @distance,
         @trackCondition, @passing, @firstCorner, @runningStyle, @fetchedAt
       )`,
    );
    this.db.transaction(() => {
      for (const r of runs) stmt.run(r);
    })();
  }

  /** 騎手の騎乗成績（指定日以降、新しい順） */
  listJockeyRuns(jockeyId: string, fromDate: string): JockeyRunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM jockey_runs WHERE jockey_id = ? AND date >= ? ORDER BY date DESC')
      .all(jockeyId, fromDate) as any[];
    return rows.map((r) => ({
      jockeyId: r.jockey_id,
      raceId: r.race_id,
      date: r.date,
      venueName: r.venue_name,
      raceNo: r.race_no,
      raceName: r.race_name,
      headcount: r.headcount,
      frameNumber: r.frame_number,
      horseNumber: r.horse_number,
      winOdds: r.win_odds,
      popularity: r.popularity,
      finishPosition: r.finish_position,
      finishText: r.finish_text,
      horseName: r.horse_name,
      horseId: r.horse_id,
      surface: r.surface,
      distance: r.distance,
      trackCondition: r.track_condition,
      passing: r.passing,
      firstCorner: r.first_corner,
      runningStyle: r.running_style,
      fetchedAt: r.fetched_at,
    }));
  }

  getCrawlState(jockeyId: string): JockeyCrawlState | null {
    const r = this.db.prepare('SELECT * FROM jockey_crawl_state WHERE jockey_id = ?').get(jockeyId) as any;
    return r
      ? { jockeyId: r.jockey_id, newestDate: r.newest_date, backfillPage: r.backfill_page, backfillDone: r.backfill_done === 1 }
      : null;
  }

  saveCrawlState(s: JockeyCrawlState): void {
    this.db
      .prepare(
        `INSERT INTO jockey_crawl_state (jockey_id, newest_date, backfill_page, backfill_done, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(jockey_id) DO UPDATE SET newest_date = excluded.newest_date, backfill_page = excluded.backfill_page,
           backfill_done = excluded.backfill_done, updated_at = excluded.updated_at`,
      )
      .run(s.jockeyId, s.newestDate, s.backfillPage, s.backfillDone ? 1 : 0, new Date().toISOString());
  }

  // ---------- 馬の過去走 ----------

  /** 指定日以降のレースに出走する馬の netkeiba 馬ID（重複なし） */
  listHorseIdsFromDate(fromDate: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.netkeiba_horse_id AS id FROM entries e JOIN races r ON r.race_key = e.race_key
         WHERE r.date >= ? AND e.netkeiba_horse_id IS NOT NULL ORDER BY e.netkeiba_horse_id`,
      )
      .all(fromDate) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** 馬の過去走を保存し、最終取得日時を記録する */
  saveHorseRuns(horseId: string, horseName: string | null, runs: HorseRunRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO horse_runs (
         horse_id, race_id, date, venue_name, race_no, race_name, headcount, frame_number, horse_number,
         win_odds, popularity, finish_position, finish_text, jockey_id, jockey_name, surface, distance,
         track_condition, passing, first_corner, running_style, last3f, last3f_rank, body_weight, body_weight_diff,
         time_sec, margin_sec, carried_weight, pace_front, pace_back, fetched_at
       ) VALUES (
         @horseId, @raceId, @date, @venueName, @raceNo, @raceName, @headcount, @frameNumber, @horseNumber,
         @winOdds, @popularity, @finishPosition, @finishText, @jockeyId, @jockeyName, @surface, @distance,
         @trackCondition, @passing, @firstCorner, @runningStyle, @last3f, @last3fRank, @bodyWeight, @bodyWeightDiff,
         @timeSec, @marginSec, @carriedWeight, @paceFront, @paceBack, @fetchedAt
       )`,
    );
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const r of runs)
        stmt.run({
          ...r,
          last3fRank: r.last3fRank ?? null,
          bodyWeight: r.bodyWeight ?? null,
          bodyWeightDiff: r.bodyWeightDiff ?? null,
          timeSec: r.timeSec ?? null,
          marginSec: r.marginSec ?? null,
          carriedWeight: r.carriedWeight ?? null,
          paceFront: r.paceFront ?? null,
          paceBack: r.paceBack ?? null,
        });
      this.db
        .prepare(
          `INSERT INTO horse_crawl_state (horse_id, horse_name, fetched_at) VALUES (?, ?, ?)
           ON CONFLICT(horse_id) DO UPDATE SET horse_name = COALESCE(excluded.horse_name, horse_crawl_state.horse_name),
             fetched_at = excluded.fetched_at`,
        )
        .run(horseId, horseName, now);
    })();
  }

  getHorseFetchedAt(horseId: string): string | null {
    const r = this.db.prepare('SELECT fetched_at FROM horse_crawl_state WHERE horse_id = ?').get(horseId) as
      | { fetched_at: string }
      | undefined;
    return r?.fetched_at ?? null;
  }

  /**
   * スピード指数の基準：条件に合う過去走のうち3着以内の走破タイム（秒）。指定日より前の走だけ
   * venue・condition が null の条件は問わない
   */
  listTop3Times(q: { venue: string | null; surface: string; distance: number; condition: string | null }, beforeDate: string): number[] {
    const where = ['surface = ?', 'distance = ?', 'date < ?', 'finish_position BETWEEN 1 AND 3', 'time_sec IS NOT NULL'];
    const args: (string | number)[] = [q.surface, q.distance, beforeDate];
    if (q.venue) {
      where.push('venue_name = ?');
      args.push(q.venue);
    }
    if (q.condition) {
      where.push('track_condition = ?');
      args.push(q.condition);
    }
    return (this.db.prepare(`SELECT time_sec FROM horse_runs WHERE ${where.join(' AND ')}`).all(...args) as { time_sec: number }[]).map((r) => r.time_sec);
  }

  /**
   * 枠の有利不利：条件に合う過去走の枠番ごとの出走数と3着以内の数。fromDate 以上・beforeDate より前の走だけ
   */
  frameStats(q: { venue: string; surface: string; distance: number }, fromDate: string, beforeDate: string): { frame: number; n: number; top3: number }[] {
    return this.db
      .prepare(
        `SELECT frame_number AS frame, COUNT(*) AS n, SUM(CASE WHEN finish_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
         FROM horse_runs
         WHERE venue_name = ? AND surface = ? AND distance = ? AND date >= ? AND date < ?
           AND frame_number IS NOT NULL AND finish_position IS NOT NULL
         GROUP BY frame_number`,
      )
      .all(q.venue, q.surface, q.distance, fromDate, beforeDate) as { frame: number; n: number; top3: number }[];
  }

  /**
   * 休み明け（前走から minDays 日以上）の全体の傾向：beforeDate より前の走のうち、前走がある走の数・3着以内の数と、
   * そのうち休み明けの走の数・3着以内の数
   */
  layoffStats(beforeDate: string, minDays: number): { n: number; top3: number; layoffN: number; layoffTop3: number } {
    const r = this.db
      .prepare(
        `WITH x AS (
           SELECT finish_position, date, LAG(date) OVER (PARTITION BY horse_id ORDER BY date) AS prev
           FROM horse_runs WHERE date < ?
         )
         SELECT COUNT(*) AS n,
                SUM(CASE WHEN finish_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3,
                SUM(CASE WHEN julianday(date) - julianday(prev) >= ? THEN 1 ELSE 0 END) AS layoffN,
                SUM(CASE WHEN julianday(date) - julianday(prev) >= ? AND finish_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS layoffTop3
         FROM x WHERE prev IS NOT NULL AND finish_position IS NOT NULL`,
      )
      .get(beforeDate, minDays, minDays) as { n: number; top3: number | null; layoffN: number | null; layoffTop3: number | null };
    return { n: r.n, top3: r.top3 ?? 0, layoffN: r.layoffN ?? 0, layoffTop3: r.layoffTop3 ?? 0 };
  }

  /** 馬の過去走（新しい順） */
  listHorseRuns(horseId: string): HorseRunRecord[] {
    const rows = this.db.prepare('SELECT * FROM horse_runs WHERE horse_id = ? ORDER BY date DESC').all(horseId) as any[];
    return rows.map((r) => ({
      horseId: r.horse_id,
      raceId: r.race_id,
      date: r.date,
      venueName: r.venue_name,
      raceNo: r.race_no,
      raceName: r.race_name,
      headcount: r.headcount,
      frameNumber: r.frame_number,
      horseNumber: r.horse_number,
      winOdds: r.win_odds,
      popularity: r.popularity,
      finishPosition: r.finish_position,
      finishText: r.finish_text,
      jockeyId: r.jockey_id,
      jockeyName: r.jockey_name,
      surface: r.surface,
      distance: r.distance,
      trackCondition: r.track_condition,
      passing: r.passing,
      firstCorner: r.first_corner,
      runningStyle: r.running_style,
      last3f: r.last3f,
      last3fRank: r.last3f_rank ?? null,
      bodyWeight: r.body_weight ?? null,
      bodyWeightDiff: r.body_weight_diff ?? null,
      timeSec: r.time_sec ?? null,
      marginSec: r.margin_sec ?? null,
      carriedWeight: r.carried_weight ?? null,
      paceFront: r.pace_front ?? null,
      paceBack: r.pace_back ?? null,
      fetchedAt: r.fetched_at,
    }));
  }

  // ---------- 血統・産駒成績 ----------

  /** 指定日以降のレースに出走する馬のうち、JRAの出走が minRuns 未満の馬ID */
  listLowRunHorseIdsFromDate(fromDate: string, minRuns: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.netkeiba_horse_id AS id FROM entries e JOIN races r ON r.race_key = e.race_key
         WHERE r.date >= ? AND e.netkeiba_horse_id IS NOT NULL
           AND (SELECT COUNT(*) FROM horse_runs h WHERE h.horse_id = e.netkeiba_horse_id) < ?
         ORDER BY e.netkeiba_horse_id`,
      )
      .all(fromDate, minRuns) as { id: string }[];
    return rows.map((r) => r.id);
  }

  getPedigree(horseId: string): (Pedigree & { fetchedAt: string }) | null {
    const r = this.db.prepare('SELECT * FROM horse_pedigree WHERE horse_id = ?').get(horseId) as any;
    return r
      ? { sireId: r.sire_id, sireName: r.sire_name, damName: r.dam_name, bmsId: r.bms_id, bmsName: r.bms_name, fetchedAt: r.fetched_at }
      : null;
  }

  savePedigree(horseId: string, p: Pedigree): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO horse_pedigree (horse_id, sire_id, sire_name, dam_name, bms_id, bms_name, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(horseId, p.sireId, p.sireName, p.damName, p.bmsId, p.bmsName, new Date().toISOString());
  }

  getSireStatsFetchedAt(sireId: string): string | null {
    const r = this.db.prepare('SELECT fetched_at FROM sire_stats_state WHERE sire_id = ?').get(sireId) as
      | { fetched_at: string }
      | undefined;
    return r?.fetched_at ?? null;
  }

  /** 種牡馬の産駒成績を置き換えて保存する */
  saveSireStats(sireId: string, rows: SireStatRow[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM sire_stats WHERE sire_id = ?').run(sireId);
      const stmt = this.db.prepare(
        `INSERT INTO sire_stats (sire_id, role, surface, kind, bucket, first, second, third, other)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) stmt.run(sireId, r.role, r.surface, r.kind, r.bucket, r.first, r.second, r.third, r.other);
      this.db
        .prepare(
          `INSERT INTO sire_stats_state (sire_id, fetched_at) VALUES (?, ?)
           ON CONFLICT(sire_id) DO UPDATE SET fetched_at = excluded.fetched_at`,
        )
        .run(sireId, new Date().toISOString());
    })();
  }

  listSireStats(sireId: string, role: SireStatRow['role']): SireStatRow[] {
    return (
      this.db.prepare('SELECT * FROM sire_stats WHERE sire_id = ? AND role = ?').all(sireId, role) as any[]
    ).map((r) => ({
      role: r.role,
      surface: r.surface,
      kind: r.kind,
      bucket: r.bucket,
      first: r.first,
      second: r.second,
      third: r.third,
      other: r.other,
    }));
  }

  // ---------- 旧名対応 ----------

  /** 全ての旧名対応（現在名, 旧名） */
  listRaceAliases(): { raceName: string; aliasName: string }[] {
    return (this.db.prepare('SELECT race_name, alias_name FROM race_aliases').all() as any[]).map((r) => ({
      raceName: r.race_name,
      aliasName: r.alias_name,
    }));
  }

  /** 推定値・派生指標を保存する */
  saveEntryMetrics(metrics: EntryMetricRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO entry_metrics (race_key, horse_key, metric, value, is_estimated, method, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const m of metrics) stmt.run(m.raceKey, m.horseKey, m.metric, m.value, m.isEstimated ? 1 : 0, m.method, m.computedAt);
    })();
  }

  logFetch(e: FetchLogEntry): void {
    this.db
      .prepare('INSERT INTO fetch_log (url, status, from_cache, error, cache_file, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.url, e.status, e.fromCache ? 1 : 0, e.error, e.cacheFile, e.fetchedAt);
  }

  // ---------- 読み出し ----------

  // ---- 答え合わせ ----

  /** 予想を記録する（同じレース・同じ種類は上書き） */
  savePredictionRecord(r: PredictionRecord): void {
    this.db
      .prepare(
        `INSERT INTO prediction_records (race_key, source, recorded_at, settings_json, marks_json, plans_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(race_key, source) DO UPDATE SET
           recorded_at = excluded.recorded_at, settings_json = excluded.settings_json,
           marks_json = excluded.marks_json, plans_json = excluded.plans_json`,
      )
      .run(r.raceKey, r.source, r.recordedAt, JSON.stringify(r.settings), JSON.stringify(r.marks), JSON.stringify(r.plans));
  }

  listPredictionRecords(): PredictionRecord[] {
    return (this.db.prepare('SELECT * FROM prediction_records ORDER BY race_key DESC, source').all() as any[]).map((r) => ({
      raceKey: r.race_key,
      source: r.source,
      recordedAt: r.recorded_at,
      settings: JSON.parse(r.settings_json),
      marks: JSON.parse(r.marks_json),
      plans: JSON.parse(r.plans_json),
    }));
  }

  saveRaceOutcome(o: RaceOutcome): void {
    this.db
      .prepare(
        `INSERT INTO race_outcomes (race_key, finishes_json, trifecta_json, payouts_json, meta_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(race_key) DO UPDATE SET
           finishes_json = excluded.finishes_json, trifecta_json = excluded.trifecta_json,
           payouts_json = excluded.payouts_json, meta_json = excluded.meta_json, fetched_at = excluded.fetched_at`,
      )
      .run(
        o.raceKey,
        JSON.stringify(o.finishes),
        JSON.stringify(o.trifecta),
        o.payouts ? JSON.stringify(o.payouts) : null,
        o.meta ? JSON.stringify(o.meta) : null,
        o.fetchedAt,
      );
  }

  getRaceOutcome(raceKey: string): RaceOutcome | null {
    const r = this.db.prepare('SELECT * FROM race_outcomes WHERE race_key = ?').get(raceKey) as any;
    return r
      ? {
          raceKey: r.race_key,
          finishes: JSON.parse(r.finishes_json),
          trifecta: JSON.parse(r.trifecta_json),
          payouts: r.payouts_json ? JSON.parse(r.payouts_json) : null,
          meta: r.meta_json ? JSON.parse(r.meta_json) : null,
          fetchedAt: r.fetched_at,
        }
      : null;
  }

  /** 予想を記録したレース（指定日まで） */
  listRecordedRaceKeysUntil(untilDate: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT p.race_key FROM prediction_records p JOIN races r ON r.race_key = p.race_key
           WHERE r.date <= ? ORDER BY p.race_key`,
        )
        .all(untilDate) as { race_key: string }[]
    ).map((r) => r.race_key);
  }

  /** 予想を記録済みで、結果が未取得のレース（指定日まで） */
  listRaceKeysAwaitingOutcome(untilDate: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT p.race_key FROM prediction_records p
           JOIN races r ON r.race_key = p.race_key
           LEFT JOIN race_outcomes o ON o.race_key = p.race_key
           WHERE o.race_key IS NULL AND r.date <= ?
           ORDER BY p.race_key`,
        )
        .all(untilDate) as { race_key: string }[]
    ).map((r) => r.race_key);
  }

  /** 指定日以降のレース（日付・会場・R の順） */
  listRacesFrom(fromDate: string, limit: number): RaceRecord[] {
    return (
      this.db.prepare('SELECT * FROM races WHERE date >= ? ORDER BY date, venue_code, race_no LIMIT ?').all(fromDate, limit) as any[]
    ).map(toRace);
  }

  /** 指定日のレース（会場・R の順） */
  listRacesOnDate(date: string): RaceRecord[] {
    return (this.db.prepare('SELECT * FROM races WHERE date = ? ORDER BY venue_code, race_no').all(date) as any[]).map(toRace);
  }

  /** 指定日より前の開催日とレース数（新しい順） */
  listPastRaceDates(beforeDate: string): { date: string; races: number }[] {
    return this.db
      .prepare('SELECT date, COUNT(*) AS races FROM races WHERE date < ? GROUP BY date ORDER BY date DESC')
      .all(beforeDate) as { date: string; races: number }[];
  }

  listRaces(): RaceRecord[] {
    return (this.db.prepare('SELECT * FROM races ORDER BY date DESC, venue_code, race_no').all() as any[]).map(toRace);
  }

  getRace(raceKey: string): RaceRecord | null {
    const row = this.db.prepare('SELECT * FROM races WHERE race_key = ?').get(raceKey);
    return row ? toRace(row) : null;
  }

  getEntries(raceKey: string): EntryRecord[] {
    return (
      this.db.prepare('SELECT * FROM entries WHERE race_key = ? ORDER BY horse_number IS NULL, horse_number').all(raceKey) as any[]
    ).map(toEntry);
  }

  getHorse(horseKey: string): HorseRecord | null {
    const r = this.db.prepare('SELECT * FROM horses WHERE horse_key = ?').get(horseKey) as any;
    return r
      ? { horseKey: r.horse_key, name: r.name, sex: r.sex, birthYear: r.birth_year, sire: r.sire, dam: r.dam, damSire: r.dam_sire }
      : null;
  }

  /** 各馬番について最新の単勝オッズを返す */
  getLatestWinOdds(raceKey: string): WinOddsRecord[] {
    const rows = this.db
      .prepare(
        `SELECT o.* FROM win_odds o
         JOIN (SELECT horse_number, MAX(fetched_at) AS f FROM win_odds WHERE race_key = ? GROUP BY horse_number) l
           ON o.horse_number = l.horse_number AND o.fetched_at = l.f
         WHERE o.race_key = ? ORDER BY o.horse_number`,
      )
      .all(raceKey, raceKey) as any[];
    return rows.map((r) => ({
      raceKey: r.race_key,
      horseNumber: r.horse_number,
      winOdds: r.win_odds,
      popularity: r.popularity,
      fetchedAt: r.fetched_at,
      kind: r.kind,
    }));
  }

  /** レースの取得元ID（netkeiba のレースID）を返す。未登録なら null */
  findRaceSourceId(raceKey: string, source: SourceRef['source'] = 'netkeiba'): string | null {
    const row = this.db
      .prepare('SELECT source_id FROM source_ids WHERE entity = ? AND internal_key = ? AND source = ?')
      .get('race', raceKey, source) as { source_id: string } | undefined;
    return row?.source_id ?? null;
  }

  // ---- 配分の自動見直し ----

  /** 採用した配分の履歴（新しい順） */
  listWeightVersions(): WeightVersion[] {
    return (this.db.prepare('SELECT * FROM weight_versions ORDER BY id DESC').all() as any[]).map((r) => ({
      id: r.id,
      weights: JSON.parse(r.weights_json),
      reason: r.reason,
      note: r.note,
      metrics: r.metrics_json ? JSON.parse(r.metrics_json) : null,
      adoptedAt: r.adopted_at,
    }));
  }

  /** 採用中の配分（無ければ null = 既定の配分） */
  getActiveWeightVersion(): WeightVersion | null {
    return this.listWeightVersions()[0] ?? null;
  }

  addWeightVersion(v: Omit<WeightVersion, 'id' | 'adoptedAt'>, adoptedAt = new Date().toISOString()): WeightVersion {
    const info = this.db
      .prepare('INSERT INTO weight_versions (weights_json, reason, note, metrics_json, adopted_at) VALUES (?, ?, ?, ?, ?)')
      .run(JSON.stringify(v.weights), v.reason, v.note, v.metrics ? JSON.stringify(v.metrics) : null, adoptedAt);
    return { ...v, id: Number(info.lastInsertRowid), adoptedAt };
  }

  /** 結果があり、項目ごとの点数を保存した予想の記録（配分の見直し用） */
  listScoredRecordsWithOutcome(): { record: PredictionRecord; outcome: RaceOutcome; date: string }[] {
    const out: { record: PredictionRecord; outcome: RaceOutcome; date: string }[] = [];
    for (const rec of this.listPredictionRecords()) {
      if (!rec.marks.some((m) => m.scores)) continue;
      const outcome = this.getRaceOutcome(rec.raceKey);
      const race = this.getRace(rec.raceKey);
      if (outcome && race) out.push({ record: rec, outcome, date: race.date });
    }
    return out;
  }

  // ---- 過去レースの取り込み（検証用） ----

  /** 開催の有無を確認済みの日（YYYY-MM-DD） */
  listCheckedPastDates(): Set<string> {
    return new Set((this.db.prepare('SELECT date FROM past_dates').all() as { date: string }[]).map((r) => r.date));
  }

  /**
   * 確認済みの日の記録（race_count がマイナスなら「土日なのに開催0件」だった回数で、要再確認）
   */
  getPastDate(date: string): { raceCount: number; checkedAt: string } | null {
    const r = this.db.prepare('SELECT race_count, checked_at FROM past_dates WHERE date = ?').get(date) as any;
    return r ? { raceCount: r.race_count, checkedAt: r.checked_at } : null;
  }

  /** 要再確認の日（土日なのに開催0件だった日）のうち、指定日時より前に確認した日（新しい順） */
  listRecheckPastDates(checkedBefore: string): string[] {
    return (
      this.db.prepare('SELECT date FROM past_dates WHERE race_count < 0 AND checked_at < ? ORDER BY date DESC').all(checkedBefore) as { date: string }[]
    ).map((r) => r.date);
  }

  markPastDate(date: string, raceCount: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO past_dates (date, race_count, checked_at) VALUES (?, ?, ?)')
      .run(date, raceCount, new Date().toISOString());
  }

  getPastRace(raceKey: string): { status: string; horseAttempts: number } | null {
    const r = this.db.prepare('SELECT status, horse_attempts FROM past_races WHERE race_key = ?').get(raceKey) as any;
    return r ? { status: r.status, horseAttempts: r.horse_attempts } : null;
  }

  setPastRace(raceKey: string, status: 'imported' | 'predicted' | 'failed', message: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO past_races (race_key, status, message, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(race_key) DO UPDATE SET status = excluded.status, message = excluded.message, updated_at = excluded.updated_at`,
      )
      .run(raceKey, status, message, new Date().toISOString());
  }

  listPastRaces(status: string): { raceKey: string; horseAttempts: number }[] {
    return (this.db.prepare('SELECT race_key, horse_attempts FROM past_races WHERE status = ? ORDER BY race_key DESC').all(status) as any[]).map(
      (r) => ({ raceKey: r.race_key, horseAttempts: r.horse_attempts }),
    );
  }

  incrementPastHorseAttempts(raceKeys: string[]): void {
    const stmt = this.db.prepare('UPDATE past_races SET horse_attempts = horse_attempts + 1, updated_at = ? WHERE race_key = ?');
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const k of raceKeys) stmt.run(now, k);
    })();
  }

  /** 取り込み状況の集計（ログ用） */
  pastSummary(): { byStatus: Record<string, number>; checkedDates: number; raceDays: number; recheckDates: number; oldestDate: string | null } {
    const byStatus: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM past_races GROUP BY status').all() as any[]) byStatus[r.status] = r.n;
    const d = this.db.prepare('SELECT COUNT(*) AS n, SUM(race_count > 0) AS days, SUM(race_count < 0) AS recheck, MIN(date) AS oldest FROM past_dates').get() as any;
    return { byStatus, checkedDates: d.n ?? 0, raceDays: d.days ?? 0, recheckDates: d.recheck ?? 0, oldestDate: d.oldest ?? null };
  }

  /** 予想の記録があるか（種類を問わない） */
  hasPredictionRecord(raceKey: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM prediction_records WHERE race_key = ? LIMIT 1').get(raceKey);
  }

  /** 指定日の全レースのキー一覧（朝の全レース予想用） */
  listRaceKeysOnDate(date: string): string[] {
    return (this.db.prepare('SELECT race_key FROM races WHERE date = ? ORDER BY race_key').all(date) as { race_key: string }[]).map((r) => r.race_key);
  }

  /** 指定日・指定グレードのレースキー一覧（重賞の定時更新用） */
  listRaceKeysByGradeOnDate(date: string, grades: string[]): string[] {
    if (grades.length === 0) return [];
    const placeholders = grades.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT race_key FROM races WHERE date = ? AND grade IN (${placeholders}) ORDER BY race_key`)
      .all(date, ...grades) as { race_key: string }[];
    return rows.map((r) => r.race_key);
  }

  getPastResults(horseKey: string): PastResultRecord[] {
    return (this.db.prepare('SELECT * FROM past_results WHERE horse_key = ? ORDER BY date DESC').all(horseKey) as any[]).map((r) => ({
      horseKey: r.horse_key,
      date: r.date,
      venueName: r.venue_name,
      raceName: r.race_name,
      grade: r.grade,
      surface: r.surface,
      distance: r.distance,
      trackCondition: r.track_condition,
      weather: r.weather,
      headcount: r.headcount,
      horseNumber: r.horse_number,
      finishPosition: r.finish_position,
      finishNote: r.finish_note,
      popularity: r.popularity,
      winOdds: r.win_odds,
      jockey: r.jockey,
      carriedWeight: r.carried_weight,
      time: r.time,
      margin: r.margin,
      passing: r.passing,
      last3F: r.last3f,
      bodyWeight: r.body_weight,
    }));
  }

  getEntryMetrics(raceKey: string): EntryMetricRecord[] {
    return (this.db.prepare('SELECT * FROM entry_metrics WHERE race_key = ?').all(raceKey) as any[]).map((r) => ({
      raceKey: r.race_key,
      horseKey: r.horse_key,
      metric: r.metric,
      value: r.value,
      isEstimated: r.is_estimated === 1,
      method: r.method,
      computedAt: r.computed_at,
    }));
  }

  // ---------- 内部処理 ----------

  private upsertRace(r: RaceRecord, now: string) {
    this.db
      .prepare(
        `INSERT INTO races (race_key, date, venue_code, venue_name, race_no, name, grade, surface, distance,
           course_variant, turn, weather, track_condition, post_time, headcount, updated_at)
         VALUES (@raceKey, @date, @venueCode, @venueName, @raceNo, @name, @grade, @surface, @distance,
           @courseVariant, @turn, @weather, @trackCondition, @postTime, @headcount, @now)
         ON CONFLICT(race_key) DO UPDATE SET
           name = excluded.name, grade = excluded.grade, surface = excluded.surface, distance = excluded.distance,
           course_variant = excluded.course_variant, turn = excluded.turn, weather = excluded.weather,
           track_condition = excluded.track_condition, post_time = excluded.post_time,
           headcount = excluded.headcount, updated_at = excluded.updated_at`,
      )
      .run({ ...r, now });
  }

  /** 馬の行がなければ最小限の情報で作る（詳細は saveHorseHistory で埋まる） */
  private ensureHorse(horseKey: string, name: string, sex: string | null, now: string) {
    this.db
      .prepare(
        `INSERT INTO horses (horse_key, name, sex, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(horse_key) DO NOTHING`,
      )
      .run(horseKey, name, sex, now);
  }

  private insertEntry(e: EntryRecord, now: string) {
    this.db
      .prepare(
        `INSERT INTO entries (race_key, horse_key, horse_number, frame_number, horse_name, sex, age, jockey, trainer,
           carried_weight, body_weight, body_weight_diff, scratched, apprentice, netkeiba_horse_id, jockey_id, updated_at)
         VALUES (@raceKey, @horseKey, @horseNumber, @frameNumber, @horseName, @sex, @age, @jockey, @trainer,
           @carriedWeight, @bodyWeight, @bodyWeightDiff, @scratched, @apprentice, @netkeibaHorseId, @jockeyId, @now)`,
      )
      .run({
        ...e,
        scratched: e.scratched ? 1 : 0,
        apprentice: e.apprentice ? 1 : 0,
        netkeibaHorseId: e.netkeibaHorseId ?? null,
        jockeyId: e.jockeyId ?? null,
        now,
      });
  }
}

function toRace(r: any): RaceRecord {
  return {
    raceKey: r.race_key,
    date: r.date,
    venueCode: r.venue_code,
    venueName: r.venue_name,
    raceNo: r.race_no,
    name: r.name,
    grade: r.grade,
    surface: r.surface,
    distance: r.distance,
    courseVariant: r.course_variant,
    turn: r.turn,
    weather: r.weather,
    trackCondition: r.track_condition,
    postTime: r.post_time,
    headcount: r.headcount,
  };
}

function toEntry(r: any): EntryRecord {
  return {
    raceKey: r.race_key,
    horseKey: r.horse_key,
    horseNumber: r.horse_number,
    frameNumber: r.frame_number,
    horseName: r.horse_name,
    sex: r.sex,
    age: r.age,
    jockey: r.jockey,
    trainer: r.trainer,
    carriedWeight: r.carried_weight,
    bodyWeight: r.body_weight,
    bodyWeightDiff: r.body_weight_diff,
    scratched: r.scratched === 1,
    apprentice: r.apprentice === 1,
    netkeibaHorseId: r.netkeiba_horse_id ?? null,
    jockeyId: r.jockey_id ?? null,
  };
}
