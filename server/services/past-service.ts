/**
 * 過去レースの取り込みと予想し直し（検証用・段階B）
 *
 * 新しい日から古い日へ順に、1日ずつ次を行う。
 *  1. その日の開催を確認（レース一覧ページ）
 *  2. 各レースの出馬表・結果（着順・4角・上がり・払戻）・確定単勝オッズを保存（1レース2ページ）
 *  3. 出走馬の過去走ページを取得（まだ一度も取っていない馬だけ）
 *  4. 出走馬がそろったレースから、既定の配分で予想し直して「検証用（backtest）」として記録
 *
 * - 点数はレース日より前の成績だけで計算するため、結果は予想に混ざらない
 * - 人気は確定オッズ（当日の朝・前日の予想とは異なる）。血統（産駒成績）は今の累計のため、わずかに未来の情報を含む
 * - すでに予想の記録があるレース（前日・当日・手動）は対象外（実際の予想として答え合わせされるため）
 * - 取得は1ページずつ（race.netkeiba.com は3秒、db.netkeiba.com は5秒の間隔）。上限ページ数・終了時刻で止まり、次回は続きから
 */
import type { RaceRepository } from '../db/repository';
import type { NetkeibaSource } from '../sources/netkeiba';
import type { JraCalendar } from '../sources/jra-calendar';
import { HorseService } from './horse-service';
import type { ReviewService } from './review-service';

/** どこまでさかのぼるか（既定。騎手成績の取得範囲と同じ約5年） */
export const DEFAULT_PAST_FROM = '2021-01-01';
/** 出走馬の過去走の取得を何回試みたら、取れない馬がいても予想するか */
const MAX_HORSE_ATTEMPTS = 2;
/** 1回にまとめて取得する馬の数 */
const HORSE_CHUNK = 100;

export interface PastRunOptions {
  deadline?: number;
  /** race.netkeiba.com（開催一覧・出馬表・結果）の上限ページ数 */
  maxRacePages?: number;
  /** db.netkeiba.com（馬の過去走）の上限ページ数 */
  maxHorsePages?: number;
  /** この日までさかのぼる（YYYY-MM-DD） */
  fromDate?: string;
  /** この日より前から始める（既定は今日。今日より前の日だけが対象） */
  today?: Date;
  /** 毎回のループで呼び、文を返したらそこで止める（ディスクの空き不足など） */
  stopCheck?: () => string | null;
}

export interface PastRunResult {
  datesChecked: number;
  racesImported: number;
  racesFailed: number;
  racesPredicted: number;
  racePages: number;
  horsePages: number;
  rateLimited: boolean;
  stoppedReason: string | null;
  errors: string[];
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const isRateLimited = (err: any) => err?.name === 'RateLimitedError';

export class PastService {
  constructor(
    private readonly repo: RaceRepository,
    private readonly calendar: JraCalendar,
    /** race.netkeiba.com 用（出馬表・結果） */
    private readonly raceSource: NetkeibaSource,
    /** db.netkeiba.com 用（馬の過去走） */
    private readonly dbSource: NetkeibaSource,
    /** 結果の取り込みと予想の記録（raceSource を使うもの） */
    private readonly review: ReviewService,
  ) {}

  /** 次に確認する日（今日より前で、まだ確認していない最も新しい日）。fromDate より前なら null */
  nextDate(fromDate: string, today: Date): string | null {
    const checked = this.repo.listCheckedPastDates();
    const d = new Date(today);
    d.setHours(0, 0, 0, 0);
    for (;;) {
      d.setDate(d.getDate() - 1);
      const s = ymd(d);
      if (s < fromDate) return null;
      if (!checked.has(s)) return s;
    }
  }

  /** 出走馬の過去走がそろった（または取得を試み終えた）取り込み済みレースを予想し直す */
  predictReady(): { predicted: number; errors: string[] } {
    let predicted = 0;
    const errors: string[] = [];
    for (const p of this.repo.listPastRaces('imported')) {
      if (this.pendingHorsesOf(p.raceKey).length > 0 && p.horseAttempts < MAX_HORSE_ATTEMPTS) continue;
      try {
        this.review.recordAuto(p.raceKey, new Date(), 'backtest');
        this.repo.setPastRace(p.raceKey, 'predicted');
        predicted++;
      } catch (err: any) {
        this.repo.setPastRace(p.raceKey, 'failed', `予想できません: ${err?.message ?? err}`);
        errors.push(`${p.raceKey}: 予想できません（${err?.message ?? err}）`);
      }
    }
    return { predicted, errors };
  }

  /**
   * 予想し直し済みの過去レースを、今の計算（追加した項目を含む）で計算し直して記録し直す。取得はしない
   * 項目を追加したときに、その項目の効き具合を過去レースで確かめるために使う
   */
  rescore(): { total: number; done: number; errors: string[] } {
    const keys = this.repo.listPastRaces('predicted').map((p) => p.raceKey);
    let done = 0;
    const errors: string[] = [];
    for (const k of keys) {
      try {
        this.review.recordAuto(k, new Date(), 'backtest');
        done++;
      } catch (err: any) {
        errors.push(`${k}: ${err?.message ?? err}`);
      }
    }
    return { total: keys.length, done, errors };
  }

  /** そのレースの出走馬のうち、過去走をまだ一度も取得していない馬 */
  private pendingHorsesOf(raceKey: string): string[] {
    return this.repo
      .getEntries(raceKey)
      .map((e) => e.netkeibaHorseId)
      .filter((id): id is string => !!id && !this.repo.getHorseFetchedAt(id));
  }

  async run(opts: PastRunOptions = {}): Promise<PastRunResult> {
    const fromDate = opts.fromDate ?? DEFAULT_PAST_FROM;
    const today = opts.today ?? new Date();
    const maxRacePages = opts.maxRacePages ?? 1500;
    const maxHorsePages = opts.maxHorsePages ?? 2000;
    const res: PastRunResult = {
      datesChecked: 0,
      racesImported: 0,
      racesFailed: 0,
      racesPredicted: 0,
      racePages: 0,
      horsePages: 0,
      rateLimited: false,
      stoppedReason: null,
      errors: [],
    };
    const timeUp = () => opts.deadline !== undefined && Date.now() >= opts.deadline;
    const horseService = new HorseService(this.dbSource, this.repo);
    // 出馬表・結果の取り込みを止めたか（上限・終わり・失敗）。止めたあとも、取り込み済みレースの馬の取得と予想は続ける
    let importStopped = false;

    try {
      for (;;) {
        const ready = this.predictReady();
        res.racesPredicted += ready.predicted;
        res.errors.push(...ready.errors);
        if (timeUp()) {
          res.stoppedReason = '終了時刻になったため、続きは次回取得します';
          break;
        }
        const stop = opts.stopCheck?.();
        if (stop) {
          res.stoppedReason = stop;
          break;
        }

        // 取り込み済みレースの出走馬の過去走（まだ取っていない馬）
        const imported = this.repo.listPastRaces('imported');
        const pendingByRace = imported.map((p) => ({ raceKey: p.raceKey, horses: this.pendingHorsesOf(p.raceKey) })).filter((x) => x.horses.length > 0);
        const pendingHorses = [...new Set(pendingByRace.flatMap((x) => x.horses))];
        if (pendingHorses.length > 0) {
          if (res.horsePages >= maxHorsePages) {
            res.stoppedReason = `馬の過去走の上限（${maxHorsePages}ページ）に達したため、続きは次回取得します`;
            break;
          }
          const chunk = pendingHorses.slice(0, HORSE_CHUNK);
          const chunkSet = new Set(chunk);
          this.repo.incrementPastHorseAttempts(pendingByRace.filter((x) => x.horses.some((h) => chunkSet.has(h))).map((x) => x.raceKey));
          const st = await horseService.crawl(chunk, maxHorsePages - res.horsePages, opts.deadline);
          res.horsePages += st.pagesFetched;
          res.errors.push(...st.errors.map((e) => `馬 ${e}`));
          if (st.rateLimited) {
            res.rateLimited = true;
            res.stoppedReason = st.stoppedReason;
            break;
          }
          if (st.stoppedReason && !st.stoppedReason.startsWith('1回の上限')) {
            res.stoppedReason = st.stoppedReason;
            if (timeUp() || st.stoppedReason.includes('エラー')) break;
          }
          continue;
        }

        // 次の日の取り込み
        if (importStopped) break;
        if (res.racePages >= maxRacePages) {
          res.stoppedReason = `出馬表・結果の上限（${maxRacePages}ページ）に達したため、続きは次回取得します`;
          importStopped = true;
          continue;
        }
        const date = this.nextDate(fromDate, today);
        if (!date) {
          res.stoppedReason = `${fromDate} までの取り込みが終わりました`;
          importStopped = true;
          continue;
        }
        const finished = await this.importDate(date, res, maxRacePages, timeUp);
        if (res.rateLimited) break;
        if (finished) {
          res.datesChecked++;
        } else {
          res.stoppedReason ??= '途中で止めたため、続きは次回取得します';
          importStopped = true;
        }
      }
      // 最後に取得した分も予想し直す
      const ready = this.predictReady();
      res.racesPredicted += ready.predicted;
      res.errors.push(...ready.errors);
    } finally {
      await this.calendar.close().catch(() => {});
    }
    return res;
  }

  /** 1日分を取り込む。最後まで終えたら true（その日を確認済みにする） */
  private async importDate(date: string, res: PastRunResult, maxRacePages: number, timeUp: () => boolean): Promise<boolean> {
    let races;
    try {
      res.racePages++;
      races = await this.calendar.fetchRacesOnDate(new Date(`${date}T00:00:00`));
    } catch (err: any) {
      if (isRateLimited(err)) res.rateLimited = true;
      res.errors.push(`${date}: 開催の確認に失敗（${err?.message ?? err}）`);
      res.stoppedReason = `${date} の開催の確認に失敗したため中断しました`;
      return false;
    }

    for (const race of races) {
      const knownKey = this.repo.findInternalKey('race', { source: 'netkeiba', id: race.raceId });
      if (knownKey && (this.repo.getPastRace(knownKey) || this.repo.hasPredictionRecord(knownKey))) continue;
      if (timeUp()) {
        res.stoppedReason = '終了時刻になったため、続きは次回取得します';
        return false;
      }
      if (res.racePages + 2 > maxRacePages) {
        res.stoppedReason = `出馬表・結果の上限（${maxRacePages}ページ）に達したため、続きは次回取得します`;
        return false;
      }
      let raceKey: string | null = knownKey;
      try {
        res.racePages++;
        const card = await this.raceSource.fetchRaceCard({ source: 'netkeiba', id: race.raceId });
        if (card.entries.length === 0) throw new Error('出走馬が0頭です');
        raceKey = this.repo.saveRaceCard(card);
        res.racePages++;
        await this.review.fetchOutcome(raceKey, { saveFinalOdds: true });
        this.repo.setPastRace(raceKey, 'imported');
        res.racesImported++;
      } catch (err: any) {
        if (isRateLimited(err)) {
          res.rateLimited = true;
          res.stoppedReason = `アクセス制限の可能性があるため中断しました（${err?.message ?? err}）`;
          return false;
        }
        res.racesFailed++;
        res.errors.push(`${race.raceId}: ${err?.message ?? err}`);
        if (raceKey) this.repo.setPastRace(raceKey, 'failed', err?.message ?? String(err));
      }
    }
    this.repo.markPastDate(date, races.length);
    return true;
  }
}
