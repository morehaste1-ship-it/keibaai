/**
 * WIN5（指定された5レースの1着をすべて当てる）の予想
 *
 * - 対象レース：netkeiba の WIN5 ページ（今週分）から取得して win5_targets に保存（出馬表の取得のときに読む）
 * - 各馬の「1着になる確率の目安」：過去の予想の記録で、データ予想の順位（10位以下はまとめる）と頭数の帯ごとの1着率。
 *   そのレースの出走馬で合計1になるよう割り直す。表は月ごとに作り、その月の1日より前の記録だけを使う
 * - 頭数の決め方：src/utils/win5.ts の allocateWin5（予算の中で5レースとも当たる確率が最大になる組）
 * - 記録：出馬表の取得のとき、5レースとも馬番がそろったら予算 WIN5_DEFAULT_BUDGET で記録（同じ日は上書き）
 * DB は読むだけ（refresh・record を除く）
 */
import type { RaceRepository } from '../db/repository';
import type { NetkeibaSource } from '../sources/netkeiba';
import { rankAndMark, type ShortageMode, type Weights } from '../../src/utils/dataScore';
import { allocateWin5, WIN5_DEFAULT_BUDGET, type Win5Candidate } from '../../src/utils/win5';
import { activeWeights, type ScoreService } from './score-service';

const PREFERENCE: Record<string, number> = { auto: 0, eve: 1, backtest: 2, manual: 3 };
const PLAN_CACHE_MS = 10 * 60 * 1000;

export interface Win5Leg {
  leg: number;
  sourceRaceId: string;
  raceKey: string | null;
  date: string | null;
  label: string;
  postTime: string | null;
  /** 確率の高い順（出馬表がまだなら空） */
  candidates: Win5Candidate[];
  note: string | null;
}

export interface Win5Plan {
  date: string | null;
  legs: Win5Leg[];
  /** 確率の目安の元にした記録の数（レース） */
  calibRaces: number;
}

export interface Win5HistoryRow {
  date: string;
  recordedAt: string;
  budget: number;
  points: number;
  hitProb: number;
  legs: { leg: number; label: string; picks: number[]; winners: number[] | null; hit: boolean | null }[];
  /** 結果が出たレースの数・当たったレースの数・5レースとも当たったか（結果がそろうまで null） */
  decided: number;
  hits: number;
  allHit: boolean | null;
}

const headBand = (n: number) => (n <= 8 ? 0 : n <= 12 ? 1 : n <= 16 ? 2 : 3);
const calibKey = (rank: number, heads: number) => headBand(heads) * 100 + Math.min(rank, 10);

export class Win5Service {
  private calib = new Map<string, { table: Map<number, { n: number; w: number }>; races: number }>();
  private planCache = new Map<string, { at: number; plan: Win5Plan }>();

  constructor(
    private readonly repo: RaceRepository,
    private readonly score: ScoreService,
  ) {}

  /** WIN5 ページから対象レースを読み直して保存する。読めたレースIDを返す（発表前なら空） */
  async refresh(source: NetkeibaSource): Promise<string[]> {
    const ids = await source.fetchWin5RaceIds();
    if (ids.length === 5) {
      this.repo.saveWin5Targets(ids);
      this.planCache.clear();
    }
    return ids;
  }

  /** 順位・頭数ごとの1着率（その月の1日より前の記録で作る。月ごとに使い回す） */
  private calibration(date: string): { table: Map<number, { n: number; w: number }>; races: number } {
    const month = date.slice(0, 7);
    const hit = this.calib.get(month);
    if (hit) return hit;
    const byRace = new Map<string, { source: string; ranks: { horseNumber: number; rank: number }[]; winners: Set<number> }>();
    for (const { record, outcome, date: d } of this.repo.listScoredRecordsWithOutcome()) {
      if (d >= `${month}-01`) continue;
      const prev = byRace.get(record.raceKey);
      if (prev && (PREFERENCE[prev.source] ?? 9) <= (PREFERENCE[record.source] ?? 9)) continue;
      byRace.set(record.raceKey, {
        source: record.source,
        ranks: record.marks.map((m) => ({ horseNumber: m.horseNumber, rank: m.rank })),
        winners: new Set(outcome.finishes.filter((f) => f.finishPosition === 1).map((f) => f.horseNumber)),
      });
    }
    const table = new Map<number, { n: number; w: number }>();
    for (const r of byRace.values()) {
      if (r.winners.size === 0) continue;
      for (const m of r.ranks) {
        const k = calibKey(m.rank, r.ranks.length);
        const c = table.get(k) ?? { n: 0, w: 0 };
        c.n++;
        if (r.winners.has(m.horseNumber)) c.w++;
        table.set(k, c);
      }
    }
    const out = { table, races: byRace.size };
    this.calib.set(month, out);
    return out;
  }

  /** 保存済みの対象レースを、日付ごとの5レースにまとめる（同じ回に保存したものを1組とする） */
  private groups(): { date: string | null; legs: { leg: number; sourceRaceId: string; raceKey: string | null }[] }[] {
    const byBatch = new Map<string, { leg: number; sourceRaceId: string; raceKey: string | null }[]>();
    for (const t of this.repo.listWin5Targets()) {
      const list = byBatch.get(t.fetchedAt) ?? [];
      list.push({ leg: t.pageOrder, sourceRaceId: t.sourceRaceId, raceKey: this.repo.findInternalKey('race', { source: 'netkeiba', id: t.sourceRaceId }) });
      byBatch.set(t.fetchedAt, list);
    }
    return [...byBatch.values()].map((legs) => {
      legs.sort((a, b) => a.leg - b.leg);
      const dates = legs.map((l) => (l.raceKey ? this.repo.getRace(l.raceKey)?.date ?? null : null)).filter((d): d is string => !!d);
      return { date: dates.sort().pop() ?? null, legs };
    });
  }

  /** 対象の日付：指定があればその日、無ければ今日以降で一番近い日（無ければいちばん新しい日） */
  private pickGroup(date?: string) {
    const gs = this.groups();
    if (date) return gs.find((g) => g.date === date) ?? null;
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = gs.filter((g) => g.date === null || g.date >= today).sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
    if (upcoming.length > 0) return upcoming[0];
    return gs.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0] ?? null;
  }

  plan(date?: string): Win5Plan | null {
    const g = this.pickGroup(date);
    if (!g) return null;
    const cacheKey = `${g.date}|${g.legs.map((l) => l.raceKey ?? l.sourceRaceId).join(',')}`;
    const cached = this.planCache.get(cacheKey);
    if (cached && Date.now() - cached.at < PLAN_CACHE_MS) return cached.plan;

    const calib = this.calibration(g.date ?? new Date().toISOString().slice(0, 10));
    const weights = activeWeights(this.repo) as unknown as Weights;
    const legs: Win5Leg[] = g.legs.map((l) => {
      const base = { leg: l.leg, sourceRaceId: l.sourceRaceId, raceKey: l.raceKey };
      const race = l.raceKey ? this.repo.getRace(l.raceKey) : null;
      if (!race || !l.raceKey) {
        return { ...base, date: null, label: `レースID ${l.sourceRaceId}`, postTime: null, candidates: [], note: '出馬表がまだ取り込まれていません' };
      }
      const label = `${race.venueName}${race.raceNo}R ${race.name}`;
      const head = { ...base, date: race.date, label, postTime: race.postTime ?? null };
      const entries = this.repo.getEntries(l.raceKey).filter((e) => !e.scratched);
      if (entries.length === 0 || entries.some((e) => e.horseNumber === null)) {
        return { ...head, candidates: [], note: '馬番がまだ発表されていません' };
      }
      try {
        const sc = this.score.compute(l.raceKey, race.trackCondition ?? undefined);
        const ranked = rankAndMark(sc.items as any, weights, 'keep' as ShortageMode).filter((h) => h.horseNumber !== null);
        const heads = ranked.length;
        const raw = ranked.map((h) => {
          const c = calib.table.get(calibKey(h.rank, heads));
          // 記録が少ない区分は、全体の平均（1 ÷ 頭数）に寄せる
          const prior = 1 / Math.max(1, heads);
          return c ? (c.w + prior * 20) / (c.n + 20) : prior;
        });
        const sum = raw.reduce((s, v) => s + v, 0);
        const candidates: Win5Candidate[] = ranked
          .map((h, i) => ({
            horseNumber: h.horseNumber as number,
            horseName: h.horseName,
            rank: h.rank,
            mark: h.mark,
            popularity: h.popularity,
            prob: sum > 0 ? raw[i] / sum : 0,
          }))
          .sort((a, b) => b.prob - a.prob || a.rank - b.rank);
        return { ...head, candidates, note: null };
      } catch (err: any) {
        return { ...head, candidates: [], note: `予想を計算できません（${err?.message ?? err}）` };
      }
    });
    const plan: Win5Plan = { date: g.date, legs, calibRaces: calib.races };
    this.planCache.set(cacheKey, { at: Date.now(), plan });
    return plan;
  }

  /** 5レースとも馬番がそろっていれば、予算 budget の買い目を記録する（同じ日は上書き）。記録した日付を返す */
  record(budget = WIN5_DEFAULT_BUDGET): string | null {
    this.planCache.clear();
    const plan = this.plan();
    if (!plan || !plan.date || plan.legs.some((l) => l.candidates.length === 0)) return null;
    if (plan.legs.some((l) => l.raceKey && this.repo.getRaceOutcome(l.raceKey))) return null; // 結果が出たあとは記録し直さない
    const alloc = allocateWin5(
      plan.legs.map((l) => ({ leg: l.leg, label: l.label, candidates: l.candidates })),
      budget,
    );
    if (!alloc) return null;
    this.repo.saveWin5Record(plan.date, {
      budget,
      points: alloc.points,
      hitProb: alloc.hitProb,
      legs: plan.legs.map((l, i) => ({
        leg: l.leg,
        raceKey: l.raceKey,
        label: l.label,
        picks: l.candidates.slice(0, alloc.picks[i]).map((c) => c.horseNumber),
        legProb: alloc.legProbs[i],
      })),
    });
    return plan.date;
  }

  /** 記録した WIN5 の答え合わせ（各レースの1着が選んだ馬に入っていたか） */
  history(): Win5HistoryRow[] {
    return this.repo.listWin5Records().map((r) => {
      const legs = (r.plan.legs as { leg: number; raceKey: string | null; label: string; picks: number[] }[]).map((l) => {
        const out = l.raceKey ? this.repo.getRaceOutcome(l.raceKey) : null;
        const winners = out ? out.finishes.filter((f) => f.finishPosition === 1).map((f) => f.horseNumber) : null;
        return { leg: l.leg, label: l.label, picks: l.picks, winners, hit: winners ? winners.some((w) => l.picks.includes(w)) : null };
      });
      const decided = legs.filter((l) => l.hit !== null).length;
      const hits = legs.filter((l) => l.hit).length;
      return {
        date: r.date,
        recordedAt: r.recordedAt,
        budget: r.plan.budget,
        points: r.plan.points,
        hitProb: r.plan.hitProb,
        legs,
        decided,
        hits,
        allHit: decided === legs.length ? hits === legs.length : null,
      };
    });
  }
}
