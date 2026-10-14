/**
 * 過去同一レース（10年分）の収集と分析
 *
 * 「同じレース」= 競走名・会場・芝ダ・距離が一致するもの。
 * 会場の改修などで別の会場で行われた年（代替開催）も、競走名・芝ダ・距離が一致すれば同じレースとして保存する（実際の会場も保存）。
 * 開催日は年ごとにずれるため、同じ曜日に合わせた日から探し、見つからなければ前後2週間の土日月に広げる。
 * 馬場は収集時には絞らず全件保存し、分析時に馬場ごとに集計する。
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

/** 馬場の区分（分析の表示順） */
export const TRACK_CONDITIONS = ['良', '稍重', '重', '不良'] as const;
/** 何日先まで探すか（同じ曜日に合わせた日からの前後の日数） */
const SEARCH_RANGE_DAYS = 15;
/** 土日の開催一覧が空だったとき、もう一度読むまでの待ち時間（netkeiba が一時的に空を返すことがあるため） */
const EMPTY_RETRY_WAIT_MS = 5000;
/** 開催一覧が空で返り続けたことを表す印（この年以降の取得を止める） */
const LIST_UNAVAILABLE = '開催一覧が取得できません';

/**
 * その年に探す日の一覧（近い順）。
 * 基準のレース日と同じ曜日で、その年の同じ月日に最も近い日を起点に、前後 SEARCH_RANGE_DAYS 日の土・日・月を近い順に並べる
 */
export function searchDatesFor(year: number, base: Date): Date[] {
  const center = new Date(year, base.getMonth(), base.getDate());
  // 同じ曜日に合わせる（-3〜+3日）
  let diff = base.getDay() - center.getDay();
  if (diff > 3) diff -= 7;
  if (diff < -3) diff += 7;
  const aligned = new Date(center);
  aligned.setDate(aligned.getDate() + diff);
  const out: { d: Date; dist: number }[] = [];
  for (let off = -SEARCH_RANGE_DAYS; off <= SEARCH_RANGE_DAYS; off++) {
    const d = new Date(aligned);
    d.setDate(d.getDate() + off);
    if ([0, 1, 6].includes(d.getDay())) out.push({ d, dist: Math.abs(off) });
  }
  return out.sort((a, b) => a.dist - b.dist || a.d.getTime() - b.d.getTime()).map((x) => x.d);
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
  /** 実際の会場（代替開催なら今回と違う会場） */
  venueName?: string;
  /** 保存済みのため、今回は取得しなかった */
  alreadySaved?: boolean;
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
  venueName: string;
  trackCondition: string | null;
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
  venueName: string;
  raceId: string;
  horseNumber: number;
  horseName: string | null;
  winOdds: number | null;
  headcount: number | null;
  trackCondition: string | null;
  corner4: number | null;
  passing: string | null;
}

/** 馬場ごとの要約（1行分） */
export interface ConditionSummary {
  /** 良・稍重・重・不良。null = 全馬場 */
  condition: string | null;
  races: number;
  /** 年（新しい順） */
  years: string[];
  favorite: { races: number; win: number; top3: number };
  /** 3着以内の馬の4角の平均位置と、4角3番手以内だった割合 */
  top3Corner: { horses: number; average: number | null; frontShare: number | null };
  /** 3着以内の馬の平均人気 */
  top3AvgPopularity: number | null;
}

export interface HistoryAnalysis {
  /** condition = 詳細を表示している馬場（null = 全馬場）、raceCondition = 今回のレースの馬場（画面上部の選択） */
  race: { raceKey: string; name: string; venueName: string; surface: string; distance: number; condition: string | null; raceCondition: string | null };
  seriesKey: string;
  raceCount: number;
  /** 全馬場と馬場ごとの要約（全馬場が先頭） */
  byCondition: ConditionSummary[];
  /** 代替開催（今回と別の会場）の年 */
  substituteYears: { year: string; venueName: string }[];
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

    // 保存済みの年（取り直さない。ただし馬場が不明の年は取り直す）
    const savedYears = new Map<number, { date: string; venueName: string; raceId: string; horses: number; condition: string | null }>();
    for (const r of this.repo.listHistoryRuns(seriesKey)) {
      const y = Number(r.date.slice(0, 4));
      const cur = savedYears.get(y);
      if (cur) cur.horses++;
      else savedYears.set(y, { date: r.date, venueName: r.venueName, raceId: r.sourceRaceId, horses: 1, condition: r.trackCondition });
    }

    let unavailable = false;
    try {
      for (let k = 1; k <= years; k++) {
        const year = base.getFullYear() - k;
        if (unavailable) {
          results.push({ year, status: 'error', message: `${LIST_UNAVAILABLE}（前の年で止めました）。時間をおいて押し直してください` });
          continue;
        }
        const saved = savedYears.get(year);
        // 馬場が不明のまま保存された年（以前の読み取りの不具合）は、取り直して馬場を補う
        if (saved && saved.condition !== null) {
          results.push({
            year,
            status: 'saved',
            raceId: saved.raceId,
            date: saved.date,
            venueName: saved.venueName,
            horseCount: saved.horses,
            alreadySaved: true,
            message: `保存済み（${saved.date} ${saved.venueName}・${saved.horses}頭・馬場: ${saved.condition ?? '不明'}）`,
          });
          continue;
        }
        try {
          const r = await this.collectYear(year, base, race, names, seriesKey);
          if (r.status === 'error' && r.message.startsWith(LIST_UNAVAILABLE)) unavailable = true;
          results.push(r);
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
    // 開催一覧の競走名は省略表記（例: 「アイルランド」）のため、名前では絞らず
    // 一覧の文字に含まれる芝ダ・距離（例: 「芝1800m」）で候補を絞る
    const surfaceChar: Record<string, string> = { '芝': '芝', 'ダート': 'ダ', '障害': '障' };
    const courseToken = `${surfaceChar[race.surface] ?? race.surface}${race.distance}m`;
    // 一覧の省略名が正式名の先頭と一致するか（アクセスを減らすため、先に確認する）
    const shortNameOf = (text: string) =>
      normalizeRaceName(text.normalize('NFKC').replace(/^\s*\d+R\s*/, '').split(/\s+/)[0] ?? '');
    const likely = (c: CalendarRace) => {
      const s = shortNameOf(c.raceName);
      return s.length >= 2 && names.some((n) => n.startsWith(s));
    };

    // 同じ曜日に合わせた日から近い順に、見つかるまで1日ずつ探す
    let hit: CalendarRace | null = null;
    let page: Awaited<ReturnType<NetkeibaSource['fetchRaceResult']>> | null = null;
    const checkedDays: string[] = [];
    let sameCourseSeen = 0;
    let weekendDays = 0;
    let emptyWeekendDays = 0;
    for (const d of searchDatesFor(year, base)) {
      checkedDays.push(formatYmd(d).slice(5));
      let dayRaces = await this.calendar.fetchRacesOnDate(d);
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      if (weekend) {
        weekendDays++;
        // 土日なのに空なら、一時的な空の応答の可能性があるため少し待って読み直す
        if (dayRaces.length === 0) {
          await new Promise((r) => setTimeout(r, EMPTY_RETRY_WAIT_MS));
          dayRaces = await this.calendar.fetchRacesOnDate(d);
          if (dayRaces.length === 0) emptyWeekendDays++;
        }
        // 最初の土日が2日続けて空なら、一覧が取得できない状態とみなして止める
        if (emptyWeekendDays >= 2 && emptyWeekendDays === weekendDays) {
          return {
            year,
            status: 'error',
            message: `${LIST_UNAVAILABLE}（土日の一覧が空で返りました。netkeiba 側の一時的な不調の可能性）。時間をおいて押し直してください`,
          };
        }
      }
      const sameCourse = dayRaces.filter((c) => c.raceName.normalize('NFKC').includes(courseToken));
      sameCourseSeen += sameCourse.length;
      // 同じ会場は省略名が合わないものも確認する（名称の表記ゆれに備える）。別の会場（代替開催）は省略名が合うものだけ
      const ordered = [
        ...sameCourse.filter((c) => c.trackName === race.venueName && likely(c)),
        ...sameCourse.filter((c) => c.trackName !== race.venueName && likely(c)),
        ...sameCourse.filter((c) => c.trackName === race.venueName && !likely(c)),
      ].slice(0, 4);
      for (const c of ordered) {
        const p = await this.source.fetchRaceResult({ source: 'netkeiba', id: c.raceId });
        if (names.includes(normalizeRaceName(p.raceName))) {
          hit = c;
          page = p;
          break;
        }
      }
      if (hit) break;
    }
    if (!hit || !page) {
      return {
        year,
        status: 'not_found',
        message:
          `${checkedDays.length}日分（${checkedDays[0]}〜の土日月）を探しましたが「${race.name}」（${courseToken}）がありません` +
          (sameCourseSeen === 0 ? '' : '（名称変更の可能性）'),
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
      venueName: found.trackName,
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
    const substitute = found.trackName !== race.venueName;
    return {
      year,
      status: 'saved',
      raceId: hit.raceId,
      date: hit.date,
      venueName: found.trackName,
      horseCount: runs.length,
      message:
        `${runs.length}頭を保存（${hit.date} ${found.trackName}${substitute ? '・代替開催' : ''}・馬場: ${page.trackCondition ?? '不明'}）`,
    };
  }

  /**
   * 保存済みの過去結果から分析する。
   * @param conditionInput 詳細を表示する馬場（良・稍重・重・不良）。省略・'all' なら全馬場
   * @param raceCondition 今回のレースの馬場（表示で強調するため。省略時はレースに登録された馬場）
   */
  analyze(raceKey: string, conditionInput?: string, raceCondition?: string): HistoryAnalysis {
    const race = this.repo.getRace(raceKey);
    if (!race) throw new Error('対象レースが未登録です');

    const seriesKey = seriesKeyOf(race.name, race.venueName, race.surface, race.distance);
    const condition = conditionInput && conditionInput !== 'all' ? conditionInput : null;

    const all = this.repo.listHistoryRuns(seriesKey);
    const runs = condition ? all.filter((r) => r.trackCondition === condition) : all;

    // 馬場ごとの要約（全馬場・良・稍重・重・不良）
    const summarize = (cond: string | null): ConditionSummary => {
      const rs = cond ? all.filter((r) => r.trackCondition === cond) : all;
      const fav = rs.filter((r) => r.popularity === 1);
      const t3 = rs.filter((r) => r.finishPosition !== null && r.finishPosition <= 3);
      const cs = t3.map((r) => r.corner4).filter((n): n is number => n !== null);
      return {
        condition: cond,
        races: new Set(rs.map((r) => r.sourceRaceId)).size,
        years: [...new Set(rs.map((r) => r.date.slice(0, 4)))].sort((a, b) => b.localeCompare(a)),
        favorite: {
          races: fav.length,
          win: fav.filter((r) => r.finishPosition === 1).length,
          top3: fav.filter((r) => r.finishPosition !== null && r.finishPosition <= 3).length,
        },
        top3Corner: {
          horses: t3.length,
          average: mean(cs),
          frontShare: cs.length > 0 ? Math.round((cs.filter((n) => n <= 3).length / cs.length) * 100) / 100 : null,
        },
        top3AvgPopularity: mean(t3.map((r) => r.popularity).filter((n): n is number => n !== null)),
      };
    };
    const byCondition = [summarize(null), ...TRACK_CONDITIONS.map((c) => summarize(c))];
    const substituteYears = [
      ...new Map(all.filter((r) => r.venueName !== race.venueName).map((r) => [r.date.slice(0, 4), r.venueName])).entries(),
    ]
      .map(([year, venueName]) => ({ year, venueName }))
      .sort((a, b) => b.year.localeCompare(a.year));
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
        venueName: r.venueName,
        trackCondition: r.trackCondition,
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
          venueName: r.venueName,
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
        ? `詳細は馬場「${condition}」の結果のみで集計しています（対象: ${raceCount}回分）`
        : `詳細は全馬場の結果で集計しています（対象: ${raceCount}回分）`,
      '「4角」は最終コーナーの通過順位です（コーナーが3つ以下のコースでは最後のコーナー）',
      '「1番人気が勝ったレースで、その馬が過去に勝ってきたレース」は馬ごとの過去走データが必要なため未集計です（馬別の過去走取得は未実装）',
    ];
    if (all.length === 0) {
      notes.push('保存済みの過去データがありません。先に「過去10年を取得」を実行してください');
    } else if (raceCount > 0 && raceCount < 3) {
      notes.push(`対象が${raceCount}回と少ないため、傾向は参考程度に見てください`);
    }
    if (substituteYears.length > 0) {
      notes.push(`代替開催（別の会場）の年も含めています: ${substituteYears.map((x) => `${x.year}年 ${x.venueName}`).join('・')}`);
    }

    return {
      race: {
        raceKey,
        name: race.name,
        venueName: race.venueName,
        surface: race.surface,
        distance: race.distance,
        condition,
        raceCondition: raceCondition || race.trackCondition || null,
      },
      seriesKey,
      raceCount,
      byCondition,
      substituteYears,
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
