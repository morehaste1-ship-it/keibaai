/**
 * 過去同一レース（10年分）の収集と分析
 *
 * 「同じレース」= 競走名・会場・芝ダ・距離が一致するもの。
 * 馬場は収集時には絞らず全件保存し、分析時に条件として絞り込む（馬場が違う年も後で比較できるように）。
 */

import type { NetkeibaSource } from '../sources/netkeiba';
import type { CalendarRace, JraCalendar } from '../sources/jra-calendar';
import type { HistoryRunRecord, RaceRepository } from '../db/repository';

/** 競走名の照合用に正規化する（全角半角・空白・括弧・グレード表記を除く） */
export function normalizeRaceName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[()（）【】\[\]]/g, '')
    .replace(/^\d+R/i, '')
    .replace(/G(I{1,3}|[123])(?![A-Za-z])/gi, '')
    .toLowerCase();
}

/** 同一シリーズを表すキー（競走名・会場・芝ダ・距離） */
export function seriesKeyOf(raceName: string, venueName: string, surface: string, distance: number): string {
  return `${normalizeRaceName(raceName)}|${venueName}|${surface}|${distance}`;
}

function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}

export interface HistoryYearResult {
  year: number;
  status: 'saved' | 'not_found' | 'mismatch' | 'error';
  raceId?: string;
  date?: string;
  horseCount?: number;
  message: string;
}

export interface HistoryCollectResult {
  raceKey: string;
  seriesKey: string;
  savedCount: number;
  years: HistoryYearResult[];
}

export interface CornerHorse {
  year: string;
  date: string;
  raceId: string;
  finishPosition: number;
  horseNumber: number;
  horseName: string | null;
  corner4: number | null;
  passing: string | null;
  headcount: number | null;
}

export interface FavoriteWin {
  year: string;
  date: string;
  raceId: string;
  horseNumber: number;
  horseName: string | null;
  winOdds: number | null;
  headcount: number | null;
  trackCondition: string | null;
  corner4: number | null;
  passing: string | null;
}

export interface HistoryAnalysis {
  race: { raceKey: string; name: string; venueName: string; surface: string; distance: number; condition: string | null };
  seriesKey: string;
  raceCount: number;
  favorite: {
    races: number;
    win: number;
    second: number;
    third: number;
    outside: number;
    unknown: number;
  };
  top3Corner: {
    horses: number;
    average: number | null;
    distribution: { position: number; count: number }[];
    buckets: { label: string; count: number }[];
    unknown: number;
    list: CornerHorse[];
  };
  favoriteWins: {
    count: number;
    averageWinOdds: number | null;
    averageHeadcount: number | null;
    list: FavoriteWin[];
  };
  notes: string[];
}

export class HistoryService {
  constructor(
    private readonly calendar: JraCalendar,
    private readonly source: NetkeibaSource,
    private readonly repo: RaceRepository,
  ) {}

  /**
   * 対象レースと同じ競走の過去 years 年分を取得して保存する。
   * 各年は開催日の前後3日を探し、競走名・会場で照合する。
   */
  async collect(raceKey: string, years = 10): Promise<HistoryCollectResult> {
    const race = this.repo.getRace(raceKey);
    if (!race) throw new Error('対象レースが未登録です');

    const target = normalizeRaceName(race.name);
    if (!target) throw new Error('競走名が未登録のため、過去データを照合できません');

    const seriesKey = seriesKeyOf(race.name, race.venueName, race.surface, race.distance);
    const base = new Date(`${race.date}T00:00:00`);
    const results: HistoryYearResult[] = [];

    // 旧名対応表に登録された旧名も、同じレースの名前として照合に使う
    const names = [
      target,
      ...this.repo
        .listRaceAliases()
        .filter((a) => normalizeRaceName(a.raceName) === target)
        .map((a) => normalizeRaceName(a.aliasName))
        .filter((n) => n.length > 0),
    ];

    try {
      for (let k = 1; k <= years; k++) {
        const year = base.getFullYear() - k;
        try {
          results.push(await this.collectYear(year, base, race, names, seriesKey));
        } catch (err: any) {
          results.push({ year, status: 'error', message: err?.message ?? String(err) });
        }
      }
    } finally {
      await this.calendar.close().catch(() => {});
    }

    return {
      raceKey,
      seriesKey,
      savedCount: results.filter((r) => r.status === 'saved').length,
      years: results,
    };
  }

  private async collectYear(
    year: number,
    base: Date,
    race: { name: string; venueName: string; surface: string; distance: number },
    names: string[],
    seriesKey: string,
  ): Promise<HistoryYearResult> {
    const center = new Date(year, base.getMonth(), base.getDate());

    // 前後3日の同会場レースを集める
    const candidates: CalendarRace[] = [];
    for (let off = -3; off <= 3; off++) {
      const d = new Date(center);
      d.setDate(d.getDate() + off);
      const dayRaces = await this.calendar.fetchRacesOnDate(d);
      candidates.push(...dayRaces.filter((c) => c.trackName === race.venueName));
    }

    // 開催一覧の競走名は省略表記（例: 「アイルランド」）のため、名前では絞らず
    // 一覧の文字に含まれる芝ダ・距離（例: 「芝1800m」）で候補を絞る
    const surfaceChar: Record<string, string> = { '芝': '芝', 'ダート': 'ダ', '障害': '障' };
    const courseToken = `${surfaceChar[race.surface] ?? race.surface}${race.distance}m`;
    const sameCourse = candidates.filter((c) => c.raceName.normalize('NFKC').includes(courseToken));
    if (sameCourse.length === 0) {
      return { year, status: 'not_found', message: `前後3日の${race.venueName}に${courseToken}のレースがありません` };
    }

    // 一覧の省略名が正式名の先頭と一致するものから確認する（アクセスを減らすため）
    const shortNameOf = (text: string) =>
      normalizeRaceName(text.normalize('NFKC').replace(/^\s*\d+R\s*/, '').split(/\s+/)[0] ?? '');
    const likely = (c: CalendarRace) => {
      const s = shortNameOf(c.raceName);
      return s.length >= 2 && names.some((n) => n.startsWith(s));
    };
    const ordered = [...sameCourse.filter(likely), ...sameCourse.filter((c) => !likely(c))].slice(0, 8);

    // 結果ページのタイトルの競走名が正式名と一致するものを採用する
    let hit: CalendarRace | null = null;
    let page: Awaited<ReturnType<NetkeibaSource['fetchRaceResult']>> | null = null;
    for (const c of ordered) {
      const p = await this.source.fetchRaceResult({ source: 'netkeiba', id: c.raceId });
      if (names.includes(normalizeRaceName(p.raceName))) {
        hit = c;
        page = p;
        break;
      }
    }
    if (!hit || !page) {
      return {
        year,
        status: 'not_found',
        message: `${courseToken}の候補${ordered.length}件に「${race.name}」がありません（名称変更の可能性）`,
      };
    }

    // 芝ダ・距離の確認（一覧の表記と結果ページが食い違う場合は採用しない）
    if (page.surface !== race.surface || page.distance !== race.distance) {
      return {
        year,
        status: 'mismatch',
        raceId: hit.raceId,
        date: hit.date,
        message: `芝ダ・距離が一致しません（${page.surface}${page.distance}m）`,
      };
    }

    const fetchedAt = new Date().toISOString();
    const found = hit;
    const result = page;
    const runs: HistoryRunRecord[] = result.rows.map((r) => ({
      sourceRaceId: found.raceId,
      horseNumber: r.horseNumber,
      seriesKey,
      date: found.date,
      venueName: race.venueName,
      raceName: result.raceName,
      surface: result.surface,
      distance: result.distance,
      trackCondition: result.trackCondition,
      headcount: result.headcount,
      horseName: r.horseName,
      finishPosition: r.finishPosition,
      finishText: r.finishText,
      popularity: r.popularity,
      winOdds: r.winOdds,
      passing: r.passing,
      corner4: r.corner4,
      fetchedAt,
    }));

    this.repo.saveHistoryRuns(runs);
    return {
      year,
      status: 'saved',
      raceId: hit.raceId,
      date: hit.date,
      horseCount: runs.length,
      message: `${runs.length}頭を保存（馬場: ${page.trackCondition ?? '不明'}）`,
    };
  }

  /**
   * 保存済みの過去結果から分析する。
   * @param conditionInput 馬場で絞り込む（良・稍重・重・不良）。省略時はレースの馬場、それも無ければ全馬場
   */
  analyze(raceKey: string, conditionInput?: string): HistoryAnalysis {
    const race = this.repo.getRace(raceKey);
    if (!race) throw new Error('対象レースが未登録です');

    const seriesKey = seriesKeyOf(race.name, race.venueName, race.surface, race.distance);
    const condition = conditionInput || race.trackCondition || null;

    const all = this.repo.listHistoryRuns(seriesKey);
    const runs = condition ? all.filter((r) => r.trackCondition === condition) : all;
    const raceCount = new Set(runs.map((r) => r.sourceRaceId)).size;

    // 1. 1番人気の着順
    const favRuns = runs.filter((r) => r.popularity === 1);
    const favorite = { races: favRuns.length, win: 0, second: 0, third: 0, outside: 0, unknown: 0 };
    for (const r of favRuns) {
      if (r.finishPosition === 1) favorite.win++;
      else if (r.finishPosition === 2) favorite.second++;
      else if (r.finishPosition === 3) favorite.third++;
      else if (r.finishPosition !== null) favorite.outside++;
      else favorite.unknown++;
    }

    // 2. 3着以内の馬の4コーナー通過順位
    const top3 = runs.filter((r) => r.finishPosition !== null && r.finishPosition <= 3);
    const corners = top3.map((r) => r.corner4).filter((n): n is number => n !== null);
    const countByPos = new Map<number, number>();
    for (const c of corners) countByPos.set(c, (countByPos.get(c) ?? 0) + 1);
    const distribution = [...countByPos.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([position, count]) => ({ position, count }));
    const bucketDefs: { label: string; test: (n: number) => boolean }[] = [
      { label: '1番手', test: (n) => n === 1 },
      { label: '2番手', test: (n) => n === 2 },
      { label: '3番手', test: (n) => n === 3 },
      { label: '4〜5番手', test: (n) => n >= 4 && n <= 5 },
      { label: '6番手以下', test: (n) => n >= 6 },
    ];
    const buckets = bucketDefs.map((b) => ({ label: b.label, count: corners.filter(b.test).length }));

    const cornerList: CornerHorse[] = top3
      .map((r) => ({
        year: r.date.slice(0, 4),
        date: r.date,
        raceId: r.sourceRaceId,
        finishPosition: r.finishPosition as number,
        horseNumber: r.horseNumber,
        horseName: r.horseName,
        corner4: r.corner4,
        passing: r.passing,
        headcount: r.headcount,
      }))
      .sort((a, b) => b.date.localeCompare(a.date) || a.finishPosition - b.finishPosition);

    // 3. 1番人気が勝ったレースの概要（同シリーズ内の傾向。馬ごとの過去の勝ち鞍は未集計）
    const winRuns = favRuns.filter((r) => r.finishPosition === 1);
    const favoriteWins = {
      count: winRuns.length,
      averageWinOdds: mean(winRuns.map((r) => r.winOdds).filter((n): n is number => n !== null)),
      averageHeadcount: mean(winRuns.map((r) => r.headcount).filter((n): n is number => n !== null)),
      list: winRuns
        .map((r) => ({
          year: r.date.slice(0, 4),
          date: r.date,
          raceId: r.sourceRaceId,
          horseNumber: r.horseNumber,
          horseName: r.horseName,
          winOdds: r.winOdds,
          headcount: r.headcount,
          trackCondition: r.trackCondition,
          corner4: r.corner4,
          passing: r.passing,
        }))
        .sort((a, b) => b.date.localeCompare(a.date)),
    };

    const notes: string[] = [
      condition
        ? `馬場「${condition}」の結果のみで集計しています（対象: ${raceCount}回分）`
        : `馬場が未指定のため、全馬場の結果で集計しています（対象: ${raceCount}回分）`,
      '「4角」は最終コーナーの通過順位です（コーナーが3つ以下のコースでは最後のコーナー）',
      '「1番人気が勝ったレースで、その馬が過去に勝ってきたレース」は馬ごとの過去走データが必要なため未集計です（馬別の過去走取得は未実装）',
    ];
    if (raceCount === 0) {
      notes.push('保存済みの過去データがありません。先に「過去10年を取得」を実行してください');
    }

    return {
      race: {
        raceKey,
        name: race.name,
        venueName: race.venueName,
        surface: race.surface,
        distance: race.distance,
        condition,
      },
      seriesKey,
      raceCount,
      favorite,
      top3Corner: {
        horses: top3.length,
        average: mean(corners),
        distribution,
        buckets,
        unknown: top3.length - corners.length,
        list: cornerList,
      },
      favoriteWins,
      notes,
    };
  }
}
