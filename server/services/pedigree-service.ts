/**
 * 血統（父・母の父）の取得と、産駒成績から「適性」を推定する
 *
 * - 対象は全出走馬（出走が少ない馬＝既定 3走未満を優先）。血統は一度取得したら再取得しない
 * - 種牡馬の産駒成績は 30 日以内に取得済みなら読まない
 * - 403/429/503 を受けたら全体を中断する
 */
import type { NetkeibaSource, SireStatRow } from '../sources/netkeiba';
import { RateLimitedError } from '../sources/fetcher';
import type { RaceRepository } from '../db/repository';

export const PEDIGREE_MIN_RUNS = 3;
const SIRE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
/** 率を使う最低の出走数（これ未満の区分は使わない） */
const MIN_SAMPLE = 10;

export interface PedigreeCrawlStatus {
  horses: number;
  pedigreesFetched: number;
  siresFetched: number;
  pagesFetched: number;
  stoppedReason: string | null;
  rateLimited: boolean;
  errors: string[];
}

/** 当サイトの距離帯 → netkeiba 産駒成績の距離区分 */
export function sireDistanceBuckets(distance: number): string[] {
  if (distance <= 1400) return ['-1400'];
  if (distance <= 1800) return ['-1800'];
  if (distance <= 2200) return ['-2200'];
  return ['-2600', '2600-'];
}

export interface PedigreeEstimate {
  rate: number; // 推定の3着以内率
  detail: string;
}

export class PedigreeService {
  constructor(
    private readonly source: NetkeibaSource,
    private readonly repo: RaceRepository,
  ) {}

  /** 血統と産駒成績を取得する（ページ数の上限あり） */
  async crawl(horseIds: string[], pageBudget = 600, deadline?: number): Promise<PedigreeCrawlStatus> {
    const late = () => deadline !== undefined && Date.now() >= deadline;
    const st: PedigreeCrawlStatus = {
      horses: horseIds.length,
      pedigreesFetched: 0,
      siresFetched: 0,
      pagesFetched: 0,
      stoppedReason: null,
      rateLimited: false,
      errors: [],
    };
    const sireIds = new Set<string>();
    try {
      for (const horseId of horseIds) {
        let ped = this.repo.getPedigree(horseId);
        if (!ped) {
          if (st.pagesFetched >= pageBudget || late()) {
            st.stoppedReason = late()
              ? '終了時刻になったため、続きは次回取得します'
              : `1回の上限（${pageBudget}ページ）に達したため、続きは次回取得します`;
            break;
          }
          st.pagesFetched++;
          try {
            const p = await this.source.fetchPedigree(horseId);
            this.repo.savePedigree(horseId, p);
            st.pedigreesFetched++;
            ped = { ...p, fetchedAt: new Date().toISOString() };
          } catch (err: any) {
            if (err instanceof RateLimitedError || err?.name === 'RateLimitedError') throw err;
            st.errors.push(`血統 ${horseId}: ${err?.message ?? err}`);
            continue;
          }
        }
        if (ped.sireId) sireIds.add(ped.sireId);
        if (ped.bmsId) sireIds.add(ped.bmsId);
      }

      for (const sireId of sireIds) {
        const at = this.repo.getSireStatsFetchedAt(sireId);
        if (at && Date.now() - new Date(at).getTime() < SIRE_REFRESH_MS) continue;
        if (st.pagesFetched + 2 > pageBudget || late()) {
          st.stoppedReason = late()
            ? '終了時刻になったため、続きは次回取得します'
            : `1回の上限（${pageBudget}ページ）に達したため、続きは次回取得します`;
          break;
        }
        st.pagesFetched += 2;
        try {
          this.repo.saveSireStats(sireId, await this.source.fetchSireStats(sireId));
          st.siresFetched++;
        } catch (err: any) {
          if (err instanceof RateLimitedError || err?.name === 'RateLimitedError') throw err;
          st.errors.push(`産駒成績 ${sireId}: ${err?.message ?? err}`);
        }
      }
    } catch (err: any) {
      st.stoppedReason = `アクセス制限の可能性があるため中断しました（${err?.message ?? err}）`;
      st.rateLimited = true;
    }
    return st;
  }

  /**
   * 産駒成績の指定区分（例: 馬場の重・不良、距離の -1800）での3着以内率を、父2・母の父1の重みで平均する。
   * 出走数が10未満の区分は使わない。血統が無い・区分のデータが無いときは null（適性表の補助に使う）
   */
  rateFor(horseId: string, surface: string, kind: SireStatRow['kind'], buckets: string[]): PedigreeEstimate | null {
    const ped = this.repo.getPedigree(horseId);
    if (!ped || (surface !== '芝' && surface !== 'ダート')) return null;
    const roleRate = (sireId: string | null, role: SireStatRow['role']) => {
      if (!sireId) return null;
      const rows = this.repo
        .listSireStats(sireId, role)
        .filter((r) => r.surface === surface && r.kind === kind && buckets.includes(r.bucket));
      const n = rows.reduce((s, r) => s + r.first + r.second + r.third + r.other, 0);
      const top3 = rows.reduce((s, r) => s + r.first + r.second + r.third, 0);
      return n >= MIN_SAMPLE ? top3 / n : null;
    };
    const sire = roleRate(ped.sireId, 'sire');
    const bms = roleRate(ped.bmsId, 'bms');
    const parts = [sire !== null ? { rate: sire, w: 2 } : null, bms !== null ? { rate: bms, w: 1 } : null].filter(
      (x): x is { rate: number; w: number } => x !== null,
    );
    if (parts.length === 0) return null;
    const pct = (r: number | null) => (r === null ? '-' : `${Math.round(r * 100)}%`);
    return {
      rate: parts.reduce((s, x) => s + x.rate * x.w, 0) / parts.reduce((s, x) => s + x.w, 0),
      detail: `父${ped.sireName ?? '-'} ${pct(sire)}・母父${ped.bmsName ?? '-'} ${pct(bms)}`,
    };
  }

  /**
   * 産駒成績から、今回の条件（芝ダ・距離帯・馬場）での3着以内率を推定する。
   * 父の成績を2、母の父の成績を1の重みで平均。出走数が少ない区分（10未満）は使わない
   */
  estimate(horseId: string, surface: string, distance: number, condition: string | null): PedigreeEstimate | null {
    const ped = this.repo.getPedigree(horseId);
    if (!ped || (surface !== '芝' && surface !== 'ダート')) return null;

    const rateOf = (rows: SireStatRow[]) => {
      const n = rows.reduce((s, r) => s + r.first + r.second + r.third + r.other, 0);
      const top3 = rows.reduce((s, r) => s + r.first + r.second + r.third, 0);
      return n >= MIN_SAMPLE ? { rate: top3 / n, n } : null;
    };
    const roleRate = (sireId: string | null, role: SireStatRow['role']) => {
      if (!sireId) return null;
      const stats = this.repo.listSireStats(sireId, role).filter((r) => r.surface === surface);
      const buckets = sireDistanceBuckets(distance);
      const parts = [
        rateOf(stats.filter((r) => r.kind === 'distance' && buckets.includes(r.bucket))),
        condition ? rateOf(stats.filter((r) => r.kind === 'condition' && r.bucket === condition)) : null,
      ].filter((p): p is { rate: number; n: number } => p !== null);
      if (parts.length === 0) return null;
      return parts.reduce((s, p) => s + p.rate, 0) / parts.length;
    };

    const sire = roleRate(ped.sireId, 'sire');
    const bms = roleRate(ped.bmsId, 'bms');
    const weighted = [
      sire !== null ? { rate: sire, w: 2 } : null,
      bms !== null ? { rate: bms, w: 1 } : null,
    ].filter((x): x is { rate: number; w: number } => x !== null);
    if (weighted.length === 0) return null;

    const rate = weighted.reduce((s, x) => s + x.rate * x.w, 0) / weighted.reduce((s, x) => s + x.w, 0);
    const pct = (r: number | null) => (r === null ? '-' : `${Math.round(r * 100)}%`);
    return {
      rate,
      detail: `血統: 父${ped.sireName ?? '-'} ${pct(sire)}・母父${ped.bmsName ?? '-'} ${pct(bms)}`,
    };
  }
}
