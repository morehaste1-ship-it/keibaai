/**
 * netkeiba スクレイピング実装
 *
 * netkeiba.com から出馬表・オッズ・馬情報を抽出
 */

import type { RaceCardResult, RaceDataSource, SourceEntry, SourceHorse, SourcePastResult, WinOddsResult } from './types';
import { SourceParseError } from './types';
import type { EntryRecord, RaceRecord, SourceRef, VenueCode, TrackCondition, Weather } from '../domain/types';
import { PoliteFetcher, type FetchFailedError, type RateLimitedError } from './fetcher';

/** 結果ページの1行（1頭分） */
export interface RaceResultRow {
  horseNumber: number;
  horseName: string;
  finishText: string; // 着順の元表記（中止・除外などを含む）
  finishPosition: number | null;
  popularity: number | null;
  winOdds: number | null;
  passing: string | null; // コーナー通過順の元表記（例: 2-2-1-1）
  corner4: number | null; // 4コーナーの通過順位（何番手）
  last3f: number | null; // 上がり3F（秒）
  bodyWeight: number | null;
  bodyWeightDiff: number | null;
}

/** 結果ページ全体（レース情報 + 全出走馬） */
export interface RaceResultPage {
  raceName: string;
  surface: string;
  distance: number;
  trackCondition: string | null;
  headcount: number;
  rows: RaceResultRow[];
  /** レースのペース（結果ページの「ペース:S/M/H」）。表記が無ければ null */
  pace: 'S' | 'M' | 'H' | null;
}

/**
 * コーナー通過順位の表記（例: 10=4(8,13)2(3,15)(1,7,16)14-9）を、馬番→何番手 にする。
 * かっこ内は同じ位置（並び）として同じ番手、- や = は間隔の表記なので番手には影響しない
 */
export function parseCornerOrder(text: string): Map<number, number> {
  const out = new Map<number, number>();
  let pos = 1;
  for (const m of text.replace(/\s+/g, '').matchAll(/\(([\d,]+)\)|(\d+)/g)) {
    const nums = (m[1] ?? m[2]).split(',').filter(Boolean).map(Number);
    for (const n of nums) out.set(n, pos);
    pos += nums.length;
  }
  return out;
}

/** 結果ページのコーナー通過順位の表から、コーナーごとの並びを読む（記載のあるコーナーのみ、番号順） */
export function parseCornerTable(html: string): { corner: number; order: Map<number, number> }[] {
  const table = /<table[^>]*Corner_Num[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1];
  if (!table) return [];
  const out: { corner: number; order: Map<number, number> }[] = [];
  for (const m of table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)) {
    const corner = parseInt(m[1].replace(/<[^>]+>/g, ''), 10);
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    if (!Number.isFinite(corner) || !text) continue;
    out.push({ corner, order: parseCornerOrder(text) });
  }
  return out.sort((a, b) => a.corner - b.corner);
}

/** 3連単の払戻（同着のときは複数） */
export interface TrifectaPayout {
  combo: [number, number, number]; // 1着-2着-3着の馬番
  payout: number; // 100円あたりの払戻金（円）
}

/**
 * 結果ページの払戻表（class="Payout_Detail_Table"）から3連単（tr class="Tan3"）を読む。
 * 馬番は <ul> ごとに1組、金額は <br> 区切りで組と同じ順に並ぶ
 */
export function parseTrifectaPayouts(html: string): TrifectaPayout[] {
  const row = /<tr[^>]*class="Tan3"[^>]*>([\s\S]*?)<\/tr>/i.exec(html)?.[1];
  if (!row) return [];
  const resultCell = /<td[^>]*class="Result"[^>]*>([\s\S]*?)<\/td>/i.exec(row)?.[1] ?? '';
  const payoutCell = /<td[^>]*class="Payout"[^>]*>([\s\S]*?)<\/td>/i.exec(row)?.[1] ?? '';
  const combos = (resultCell.match(/<ul[\s\S]*?<\/ul>/gi) || []).map((ul) =>
    [...ul.matchAll(/<span>\s*(\d+)\s*<\/span>/gi)].map((m) => Number(m[1])),
  );
  const payouts = payoutCell
    .split(/<br\s*\/?>/i)
    .map((s) => Number(s.replace(/<[^>]+>/g, '').replace(/[,円\s]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (combos.length === 0 || combos.length !== payouts.length || combos.some((c) => c.length !== 3)) {
    throw new SourceParseError('3連単の払戻の形式が想定と異なります');
  }
  return combos.map((c, i) => ({ combo: [c[0], c[1], c[2]], payout: payouts[i] }));
}

/** 答え合わせで使う券種（枠連は対象外） */
export type BetType = 'tansho' | 'fukusho' | 'wide' | 'umaren' | 'umatan' | 'sanrenpuku' | 'sanrentan';
/** 払戻表の行の class 名 → 券種 */
const PAYOUT_ROW_CLASS: Record<string, BetType> = {
  Tansho: 'tansho',
  Fukusho: 'fukusho',
  Wide: 'wide',
  Umaren: 'umaren',
  Umatan: 'umatan',
  Fuku3: 'sanrenpuku',
  Tan3: 'sanrentan',
};
export interface Payout {
  combo: number[]; // 馬番（単勝・複勝は1頭、馬連・ワイド・馬単は2頭、3連複・3連単は3頭）
  payout: number; // 100円あたりの払戻金（円）
}
const BET_SIZE: Record<BetType, number> = { tansho: 1, fukusho: 1, wide: 2, umaren: 2, umatan: 2, sanrenpuku: 3, sanrentan: 3 };

/**
 * 払戻表（class="Payout_Detail_Table"）から券種ごとの払戻を読む。
 * 単勝・複勝は <div><span>馬番</span></div>（空の span を挟む）、ほかは <ul> ごとに1組。金額は <br> 区切りで組と同じ順
 */
export function parseAllPayouts(html: string): Partial<Record<BetType, Payout[]>> {
  const out: Partial<Record<BetType, Payout[]>> = {};
  for (const m of html.matchAll(/<tr[^>]*class="(\w+)"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const type = PAYOUT_ROW_CLASS[m[1]];
    if (!type) continue;
    const resultCell = /<td[^>]*class="Result"[^>]*>([\s\S]*?)<\/td>/i.exec(m[2])?.[1] ?? '';
    const payoutCell = /<td[^>]*class="Payout"[^>]*>([\s\S]*?)<\/td>/i.exec(m[2])?.[1] ?? '';
    const uls = resultCell.match(/<ul[\s\S]*?<\/ul>/gi);
    const combos = uls
      ? uls.map((ul) => [...ul.matchAll(/<span>\s*(\d+)\s*<\/span>/gi)].map((x) => Number(x[1])))
      : [...resultCell.matchAll(/<span>\s*(\d+)\s*<\/span>/gi)].map((x) => [Number(x[1])]);
    const payouts = payoutCell
      .split(/<br\s*\/?>/i)
      .map((x) => Number(x.replace(/<[^>]+>/g, '').replace(/[,円\s]/g, '')))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (combos.length === 0 || combos.length !== payouts.length || combos.some((c) => c.length !== BET_SIZE[type])) {
      throw new SourceParseError(`払戻（${m[1]}）の形式が想定と異なります`);
    }
    out[type] = combos.map((c, i) => ({ combo: c, payout: payouts[i] }));
  }
  return out;
}


/** 走破タイム「1:31.6」「58.9」→ 秒。読めなければ null */
export function parseRaceTime(v: string | undefined): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}\.\d)$/.exec((v ?? '').trim());
  if (!m) return null;
  const sec = (m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2]);
  return sec > 0 ? Math.round(sec * 10) / 10 : null;
}

/** 着差「-0.2」「0.4」「0.0」→ 数値。読めなければ null */
export function parseSigned(v: string | undefined): number | null {
  const t = (v ?? '').trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null;
}

/** 斤量など正の数「55」「55.5」→ 数値。読めなければ null */
function parsePositive(v: string | undefined): number | null {
  const n = Number.parseFloat((v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** ペース「34.5-33.5」→ 前半3F・後半3F（秒）。読めなければ null */
export function parsePace(v: string | undefined): { paceFront: number | null; paceBack: number | null } {
  const m = /^(\d{2}\.\d)-(\d{2}\.\d)$/.exec((v ?? '').trim());
  return m ? { paceFront: parseFloat(m[1]), paceBack: parseFloat(m[2]) } : { paceFront: null, paceBack: null };
}

/** 馬体重の表記（例: 452(+2)、452(-4)、452(0)）を数値にする。計不などは null */
export function parseBodyWeight(text: string | null | undefined): { bodyWeight: number | null; bodyWeightDiff: number | null } {
  const m = /(\d{3})\s*\(\s*([+-]?\d+)\s*\)/.exec((text ?? '').replace(/\s+/g, ''));
  if (m) return { bodyWeight: parseInt(m[1], 10), bodyWeightDiff: parseInt(m[2], 10) };
  const only = /^\s*(\d{3})\s*$/.exec(text ?? '');
  return { bodyWeight: only ? parseInt(only[1], 10) : null, bodyWeightDiff: null };
}

/** 血統（父・母・母の父） */
export interface Pedigree {
  sireId: string | null;
  sireName: string | null;
  damName: string | null;
  bmsId: string | null;
  bmsName: string | null;
}

/** 産駒成績の1区分（例: 芝の〜1800、芝の良）の着順内訳 */
export interface SireStatRow {
  role: 'sire' | 'bms'; // 父としての成績 / 母の父としての成績
  surface: '芝' | 'ダート' | '障害';
  kind: 'distance' | 'condition';
  bucket: string; // 距離: -1400 / -1800 / -2200 / -2600 / 2600- 、馬場: 良 / 稍重 / 重 / 不良
  first: number;
  second: number;
  third: number;
  other: number;
}

/**
 * 産駒成績ページの表の並び（netkeiba の列順）。
 * 1ページに表が6つあり、1〜3つ目 = 父として（芝・ダート・障害）、4〜6つ目 = 母の父として（同）
 */
const SIRE_SURFACES: SireStatRow['surface'][] = ['芝', 'ダート', '障害'];
/** リンクの区分記号の先頭文字（芝 t / ダート d / 障害 s） */
const SIRE_SURFACE_CODE: Record<SireStatRow['surface'], string> = { 芝: 't', ダート: 'd', 障害: 's' };
const SIRE_BUCKETS: Record<SireStatRow['kind'], Record<SireStatRow['surface'], string[]>> = {
  distance: {
    芝: ['-1400', '-1800', '-2200', '-2600', '2600-'],
    ダート: ['-1400', '-1800', '-2200', '-2600', '2600-'],
    障害: ['全距離'],
  },
  condition: {
    芝: ['良', '稍重', '重', '不良'],
    ダート: ['良', '稍重', '重', '不良'],
    障害: ['良', '稍重', '重', '不良'],
  },
};

/** 馬場の略記（稍・不）を正式表記（稍重・不良）にそろえる */
export function normalizeCondition(text: string | null | undefined): string | null {
  if (!text) return null;
  const map: Record<string, string> = { '良': '良', '稍': '稍重', '稍重': '稍重', '重': '重', '不': '不良', '不良': '不良' };
  return map[text.trim()] ?? text.trim();
}

/** 騎手成績ページの1行（1騎乗分） */
export interface JockeyPageRow {
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
  finishText: string;
  horseName: string | null;
  horseId: string | null;
  surface: string | null;
  distance: number | null;
  trackCondition: string | null;
  passing: string | null;
  firstCorner: number | null;
}

/** 馬の競走成績ページの1行（1走分） */
export interface HorseRunRow {
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
  finishText: string;
  jockeyId: string | null;
  jockeyName: string | null;
  surface: string | null;
  distance: number | null;
  trackCondition: string | null;
  passing: string | null;
  firstCorner: number | null;
  last3f: number | null;
  /** そのレースでの上がり順位：1〜3 = 上がり3位以内（ページの rank_N の印）、0 = 4位以下、null = 不明 */
  last3fRank: number | null;
  bodyWeight: number | null; // 馬体重（kg）
  bodyWeightDiff: number | null; // 前走比
  /** 走破タイム（秒。例 1:31.6 → 91.6）。不明は null */
  timeSec: number | null;
  /** 着差（秒）。勝ち馬は2着との差をマイナスで（例 -0.2）、それ以外は勝ち馬との差。不明は null */
  marginSec: number | null;
  /** 斤量（kg） */
  carriedWeight: number | null;
  /** レースの前半3F・後半3F（秒。ページの「ペース」欄 例 34.5-33.5） */
  paceFront: number | null;
  paceBack: number | null;
}

/** 馬の競走成績ページ全体 */
export interface HorsePage {
  horseName: string | null;
  rows: HorseRunRow[];
}

/** 騎手成績ページ全体 */
export interface JockeyPage {
  jockeyName: string | null;
  lastPage: number | null;
  rows: JockeyPageRow[];
}

export class NetkeibaSource implements RaceDataSource {
  readonly id = 'netkeiba' as const;
  private fetcher: PoliteFetcher;

  constructor(fetcher?: PoliteFetcher) {
    this.fetcher = fetcher ?? new PoliteFetcher();
  }

  parseRaceInput(input: string): SourceRef | null {
    // URL から race_id を抽出
    // 例: https://race.netkeiba.com/race/result.html?race_id=202605040210
    const match = /race_id=(\d{12})/.exec(input);
    if (match) {
      return { source: 'netkeiba', id: match[1] };
    }

    // race_id として直接渡された場合
    if (/^\d{12}$/.test(input)) {
      return { source: 'netkeiba', id: input };
    }

    return null;
  }

  async fetchRaceCard(raceRef: SourceRef, date?: string): Promise<RaceCardResult> {
    if (raceRef.source !== 'netkeiba') {
      throw new Error(`Invalid source: ${raceRef.source}`);
    }

    const raceId = raceRef.id;
    const url = `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}`;

    let page;
    try {
      page = await this.fetcher.get(url, { noStore: true }); // 毎回新規取得し、写しも保存しない（読み返さないため）
    } catch (err: any) {
      throw new Error(`Failed to fetch race card: ${err?.message ?? err}`);
    }

    if (page.status !== 200) {
      throw new Error(`Failed to fetch race card (HTTP ${page.status})`);
    }

    // HTML をパース
    return this.parseRaceCard(page.text, raceId, url, date);
  }

  async fetchWinOdds(raceRef: SourceRef): Promise<WinOddsResult> {
    if (raceRef.source !== 'netkeiba') {
      throw new Error(`Invalid source: ${raceRef.source}`);
    }

    const raceId = raceRef.id;
    // 単勝オッズ（type=1）の JSON API。発走前の値を取得する
    const url = `https://race.netkeiba.com/api/api_get_jra_odds.html?race_id=${raceId}&type=1&action=init`;

    let page;
    try {
      page = await this.fetcher.get(url, { noStore: true }); // オッズは都度取得し、写しも保存しない
    } catch (err: any) {
      throw new Error(`Failed to fetch odds: ${err?.message ?? err}`);
    }

    if (page.status !== 200) {
      throw new Error(`Failed to fetch odds (HTTP ${page.status})`);
    }

    return this.parseWinOdds(page.text, raceId);
  }

  /**
   * 過去レースの結果ページを取得（着順・人気・確定単勝オッズ・4コーナー通過順）
   * 確定済みのレースは内容が変わらないため、キャッシュを7日間有効にして再アクセスを減らす
   */
  async fetchRaceResult(raceRef: SourceRef): Promise<RaceResultPage> {
    if (raceRef.source !== 'netkeiba') {
      throw new Error(`Invalid source: ${raceRef.source}`);
    }

    const raceId = raceRef.id;
    const url = `https://race.netkeiba.com/race/result.html?race_id=${raceId}`;

    let page;
    try {
      page = await this.fetcher.get(url, { maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
    } catch (err: any) {
      throw new Error(`Failed to fetch race result: ${err?.message ?? err}`);
    }

    if (page.status !== 200) {
      throw new Error(`Failed to fetch race result (HTTP ${page.status})`);
    }

    return this.parseRaceResult(page.text, raceId);
  }

  /**
   * 結果ページを解析する。列は見出し名で探すため、列の並びが変わっても対応しやすい
   */
  private parseRaceResult(html: string, raceId: string): RaceResultPage {
    const titleMatch = /<title>([^<]+)<\/title>/.exec(html);
    const title = titleMatch?.[1] || '';
    const rawName = title.match(/【?([^【】|]+)/)?.[1]?.trim() || '';
    const raceName = rawName.replace(/(出馬表|結果|払戻).*$/, '').trim();

    // 芝・ダ・障と距離（例: 「芝1600m」「ダ1300m」）
    const courseMatch = html.match(/(芝|ダ|障)(\d{4})m/);
    if (!courseMatch) {
      throw new SourceParseError('結果ページの距離・馬場種別が取得できません');
    }
    const surfaceMap: Record<string, string> = { '芝': '芝', 'ダ': 'ダート', '障': '障害' };
    const surface = surfaceMap[courseMatch[1]];
    const distance = parseInt(courseMatch[2], 10);

    // 馬場状態（良・稍重・重・不良）。ページでは「稍」「不」と省略されることがある。表記が見つからない場合は null
    const condMatch = html.match(/馬場[：:]\s*(良|稍重|稍|重|不良|不)/);
    const trackCondition = normalizeCondition(condMatch?.[1] ?? null);

    // 結果テーブル（着順・馬名などの見出しを含む table）を探す
    const table = (html.match(/<table[\s\S]*?<\/table>/gi) || []).find(
      (t) => t.includes('着順') && t.includes('馬名') && t.includes('単勝'),
    );
    if (!table) {
      throw new SourceParseError('結果テーブルが見つかりません（未確定の可能性）');
    }

    const cellsOf = (rowHtml: string): string[] =>
      [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
        m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
      );

    const rowHtmls = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const headerIdx = rowHtmls.findIndex((r) => cellsOf(r).includes('着順'));
    if (headerIdx < 0) {
      throw new SourceParseError('結果テーブルの見出しが見つかりません');
    }
    const headers = cellsOf(rowHtmls[headerIdx]).map((h) => h.replace(/\s/g, ''));
    const colOf = (pred: (h: string) => boolean) => headers.findIndex(pred);
    const iFinish = colOf((h) => h === '着順');
    const iNumber = colOf((h) => h === '馬番');
    const iName = colOf((h) => h === '馬名');
    const iPop = colOf((h) => h === '人気');
    const iOdds = colOf((h) => h.includes('単勝'));
    const iPass = colOf((h) => h.includes('コーナー'));
    const iLast3f = colOf((h) => h.includes('後3F') || h.includes('上り'));
    const iWeight = colOf((h) => h.startsWith('馬体重'));
    if (iFinish < 0 || iNumber < 0 || iName < 0) {
      throw new SourceParseError('結果テーブルの列が想定と異なります');
    }

    const rows: RaceResultRow[] = [];
    for (const rowHtml of rowHtmls.slice(headerIdx + 1)) {
      const cells = cellsOf(rowHtml);
      const horseNumber = parseInt(cells[iNumber] ?? '', 10);
      const horseName = cells[iName] ?? '';
      if (Number.isNaN(horseNumber) || !horseName) continue;

      const finishText = cells[iFinish] ?? '';
      const finishPosition = /^\d+$/.test(finishText) ? parseInt(finishText, 10) : null;
      const popularity = iPop >= 0 && /^\d+$/.test(cells[iPop] ?? '') ? parseInt(cells[iPop], 10) : null;
      const oddsNum = iOdds >= 0 ? Number.parseFloat(cells[iOdds] ?? '') : NaN;
      const passing = iPass >= 0 && cells[iPass] ? cells[iPass] : null;
      // 4コーナーの通過順位 = 通過順の最後の数字（例: 2-2-1-1 → 1）
      const passNums = passing ? passing.match(/\d+/g) : null;
      const corner4 = passNums ? parseInt(passNums[passNums.length - 1], 10) : null;

      const l3 = iLast3f >= 0 ? Number.parseFloat(cells[iLast3f] ?? '') : NaN;
      rows.push({
        horseNumber,
        horseName,
        finishText,
        finishPosition,
        popularity,
        winOdds: Number.isFinite(oddsNum) && oddsNum > 0 ? oddsNum : null,
        passing,
        corner4,
        last3f: Number.isFinite(l3) && l3 > 0 ? l3 : null,
        ...parseBodyWeight(iWeight >= 0 ? cells[iWeight] : null),
      });
    }

    if (rows.length === 0) {
      throw new SourceParseError(`結果の行が取得できませんでした (race_id=${raceId})`);
    }

    // 着順の表の「コーナー通過順」が空のページでは、コーナー通過順位の表から補う
    const corners = parseCornerTable(html);
    if (corners.length > 0) {
      for (const r of rows) {
        if (r.passing) continue;
        const ps = corners.map((c) => c.order.get(r.horseNumber)).filter((x): x is number => x !== undefined);
        if (ps.length === 0) continue;
        r.passing = ps.join('-');
        r.corner4 = ps[ps.length - 1];
      }
    }
    const paceMatch = /ペース[:：]\s*(?:<[^>]+>\s*)*([SMH])/.exec(html);

    return {
      raceName,
      surface,
      distance,
      trackCondition,
      headcount: rows.length,
      rows,
      pace: (paceMatch?.[1] as 'S' | 'M' | 'H' | undefined) ?? null,
    };
  }

  /**
   * 答え合わせ用に、確定した結果（着順＋3連単の払戻）を取得する。
   * 発走前・未確定のページを保存しないよう、キャッシュは使わない
   */
  async fetchRaceOutcome(
    raceId: string,
  ): Promise<{ result: RaceResultPage; trifecta: TrifectaPayout[]; payouts: Partial<Record<BetType, Payout[]>> }> {
    if (!/^\d{12}$/.test(raceId)) throw new Error(`レースIDが不正です: ${raceId}`);
    const page = await this.fetcher.get(`https://race.netkeiba.com/race/result.html?race_id=${raceId}`, { noStore: true });
    if (page.status !== 200) throw new Error(`Failed to fetch race result (HTTP ${page.status})`);
    const result = this.parseRaceResult(page.text, raceId);
    const trifecta = parseTrifectaPayouts(page.text);
    if (trifecta.length === 0) throw new SourceParseError('3連単の払戻が見つかりません（未確定の可能性）');
    return { result, trifecta, payouts: parseAllPayouts(page.text) };
  }

  /**
   * 騎手の成績ページ（1ページ20行・新しい順）を取得する
   * 大量に読むためキャッシュには保存しない
   */
  async fetchJockeyPage(jockeyId: string, page: number): Promise<JockeyPage> {
    if (!/^\d{5}$/.test(jockeyId)) throw new Error(`騎手IDが不正です: ${jockeyId}`);
    const url =
      page <= 1
        ? `https://db.netkeiba.com/jockey/result/recent/${jockeyId}/`
        : `https://db.netkeiba.com/jockey/race.html&id=${jockeyId}&page=${page}`;

    const res = await this.fetcher.get(url, { noStore: true });
    if (res.status !== 200) {
      throw new Error(`Failed to fetch jockey page (HTTP ${res.status})`);
    }
    return this.parseJockeyPage(res.text);
  }

  /** 騎手成績ページを解析する（列は見出し名で探す） */
  private parseJockeyPage(html: string): JockeyPage {
    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? '';
    const jockeyName = title.includes('の騎手成績') ? title.split('の騎手成績')[0].trim() : null;

    const pageNums = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => parseInt(m[1], 10));
    const lastPage = pageNums.length > 0 ? Math.max(...pageNums) : null;

    const table = (html.match(/<table[\s\S]*?<\/table>/gi) || []).find(
      (t) => t.includes('日付') && t.includes('着') && t.includes('通過'),
    );
    if (!table) {
      return { jockeyName, lastPage, rows: [] };
    }

    const cellsOf = (rowHtml: string): string[] =>
      [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
        m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(),
      );

    const rowHtmls = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const headerIdx = rowHtmls.findIndex((r) => cellsOf(r).some((c) => c.replace(/\s/g, '') === '日付'));
    if (headerIdx < 0) {
      return { jockeyName, lastPage, rows: [] };
    }
    const headers = cellsOf(rowHtmls[headerIdx]).map((h) => h.replace(/\s/g, ''));
    const col = (name: string) => headers.findIndex((h) => h === name);
    const iDate = col('日付');
    const iKaisai = col('開催');
    const iR = col('R');
    const iName = col('レース名');
    const iHead = col('頭数');
    const iFrame = col('枠番');
    const iNum = col('馬番');
    const iOdds = col('単勝');
    const iPop = col('人気');
    const iFinish = col('着順');
    const iHorse = col('馬名');
    const iDist = col('距離');
    const iCond = col('馬場');
    const iPass = col('通過');
    if (iDate < 0 || iFinish < 0 || iDist < 0) {
      throw new SourceParseError('騎手成績テーブルの列が想定と異なります');
    }

    const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? parseInt(v, 10) : null);
    const surfaceMap: Record<string, string> = { '芝': '芝', 'ダ': 'ダート', '障': '障害' };

    const rows: JockeyPageRow[] = [];
    for (const rowHtml of rowHtmls.slice(headerIdx + 1)) {
      const cells = cellsOf(rowHtml);
      const dateMatch = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(cells[iDate] ?? '');
      const raceId = rowHtml.match(/\/race\/(\d{12})\//)?.[1] ?? null;
      if (!dateMatch || !raceId) continue;

      const distMatch = /^(芝|ダ|障)(\d{3,4})/.exec(cells[iDist] ?? '');
      const finishText = cells[iFinish] ?? '';
      const oddsNum = iOdds >= 0 ? Number.parseFloat(cells[iOdds] ?? '') : NaN;
      const passing = iPass >= 0 && cells[iPass] ? cells[iPass] : null;
      const passNums = passing ? passing.match(/\d+/g) : null;

      rows.push({
        raceId,
        date: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
        venueName: iKaisai >= 0 ? (cells[iKaisai] ?? '').replace(/\d/g, '') || null : null,
        raceNo: iR >= 0 ? num(cells[iR]) : null,
        raceName: iName >= 0 ? cells[iName] || null : null,
        headcount: iHead >= 0 ? num(cells[iHead]) : null,
        frameNumber: iFrame >= 0 ? num(cells[iFrame]) : null,
        horseNumber: iNum >= 0 ? num(cells[iNum]) : null,
        winOdds: Number.isFinite(oddsNum) && oddsNum > 0 ? oddsNum : null,
        popularity: iPop >= 0 ? num(cells[iPop]) : null,
        finishPosition: num(finishText),
        finishText,
        horseName: iHorse >= 0 ? cells[iHorse] || null : null,
        horseId: rowHtml.match(/\/horse\/(\d{10})/)?.[1] ?? null,
        surface: distMatch ? surfaceMap[distMatch[1]] : null,
        distance: distMatch ? parseInt(distMatch[2], 10) : null,
        trackCondition: iCond >= 0 ? normalizeCondition(cells[iCond]) : null,
        passing,
        firstCorner: passNums ? parseInt(passNums[0], 10) : null,
      });
    }

    return { jockeyName, lastPage, rows };
  }

  /**
   * 馬の競走成績ページ（全走・1ページ）を取得する。大量に読むためキャッシュには保存しない
   */
  async fetchHorsePage(horseId: string): Promise<HorsePage> {
    if (!/^\d{10}$/.test(horseId)) throw new Error(`馬IDが不正です: ${horseId}`);
    const res = await this.fetcher.get(`https://db.netkeiba.com/horse/result/${horseId}/`, { noStore: true });
    if (res.status !== 200) {
      throw new Error(`Failed to fetch horse page (HTTP ${res.status})`);
    }
    return this.parseHorsePage(res.text);
  }

  /**
   * 馬の競走成績ページを解析する。
   * 見出しに2列分の項目（タイム指数など）があり列数がずれる場合に備え、
   * 「タイム」より後ろの列は右端からの位置で読む
   */
  private parseHorsePage(html: string): HorsePage {
    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? '';
    const horseName = title.includes('の競走成績') ? title.split('の競走成績')[0].trim() : null;

    const table = (html.match(/<table[\s\S]*?<\/table>/gi) || []).find(
      (t) => t.includes('日付') && t.includes('通過') && t.includes('騎手'),
    );
    if (!table) return { horseName, rows: [] };

    const cellsOf = (rowHtml: string): string[] =>
      [...rowHtml.matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].flatMap((m) => {
        const text = m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        const span = parseInt(/colspan="?(\d+)/i.exec(m[1])?.[1] ?? '1', 10);
        return Array.from({ length: Math.max(1, span) }, () => text);
      });

    // セルの属性（class など）。上がり3位以内の印（rank_1〜3）を読むために使う。cellsOf と同じく colspan を展開する
    const attrsOf = (rowHtml: string): string[] =>
      [...rowHtml.matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].flatMap((m) => {
        const span = parseInt(/colspan="?(\d+)/i.exec(m[1])?.[1] ?? '1', 10);
        return Array.from({ length: Math.max(1, span) }, () => m[1]);
      });

    const rowHtmls = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const headerIdx = rowHtmls.findIndex((r) => cellsOf(r).some((c) => c.replace(/\s/g, '') === '日付'));
    if (headerIdx < 0) return { horseName, rows: [] };
    const headers = cellsOf(rowHtmls[headerIdx]).map((h) => h.replace(/\s/g, ''));
    const col = (name: string) => headers.findIndex((h) => h === name);
    const iTime = col('タイム');
    const idx = {
      date: col('日付'), kaisai: col('開催'), r: col('R'), name: col('レース名'), head: col('頭数'),
      frame: col('枠番'), num: col('馬番'), odds: col('オッズ'), pop: col('人気'), finish: col('着順'),
      jockey: col('騎手'), dist: col('距離'), cond: col('馬場'), pass: col('通過'), last3f: col('上り'),
      weight: col('馬体重'), time: iTime, margin: col('着差'), kinryo: col('斤量'), pace: col('ペース'),
    };
    if (idx.date < 0 || idx.finish < 0 || idx.dist < 0) {
      throw new SourceParseError('競走成績テーブルの列が想定と異なります');
    }

    const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? parseInt(v, 10) : null);
    const surfaceMap: Record<string, string> = { '芝': '芝', 'ダ': 'ダート', '障': '障害' };

    const rows: HorseRunRow[] = [];
    for (const rowHtml of rowHtmls.slice(headerIdx + 1)) {
      const cells = cellsOf(rowHtml);
      const attrs = attrsOf(rowHtml);
      // 列数が見出しと違う場合、「タイム」より後ろは右端からの位置で読む
      const posOf = (i: number): number => {
        if (i < 0) return -1;
        if (cells.length === headers.length || iTime < 0 || i <= iTime) return i;
        return cells.length - (headers.length - i);
      };
      const at = (i: number): string | undefined => (i < 0 ? undefined : cells[posOf(i)]);
      const dateMatch = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(at(idx.date) ?? '');
      const raceId = rowHtml.match(/\/race\/(\d{12})\//)?.[1] ?? null;
      if (!dateMatch || !raceId) continue;

      const distMatch = /^(芝|ダ|障)(\d{3,4})/.exec(at(idx.dist) ?? '');
      const finishText = at(idx.finish) ?? '';
      const oddsNum = Number.parseFloat(at(idx.odds) ?? '');
      const passingText = at(idx.pass);
      const passing = passingText && /^\d+(-\d+)*$/.test(passingText) ? passingText : null;
      const passNums = passing ? passing.match(/\d+/g) : null;
      const last3f = Number.parseFloat(at(idx.last3f) ?? '');
      const rankMark = idx.last3f >= 0 ? /rank_([123])\b/.exec(attrs[posOf(idx.last3f)] ?? '') : null;
      const hasLast3f = Number.isFinite(last3f) && last3f > 0;

      rows.push({
        raceId,
        date: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
        venueName: (at(idx.kaisai) ?? '').replace(/\d/g, '') || null,
        raceNo: num(at(idx.r)),
        raceName: at(idx.name) || null,
        headcount: num(at(idx.head)),
        frameNumber: num(at(idx.frame)),
        horseNumber: num(at(idx.num)),
        winOdds: Number.isFinite(oddsNum) && oddsNum > 0 ? oddsNum : null,
        popularity: num(at(idx.pop)),
        finishPosition: num(finishText),
        finishText,
        jockeyId: rowHtml.match(/\/jockey\/(?:result\/recent\/)?(\d{5})/)?.[1] ?? null,
        jockeyName: at(idx.jockey) || null,
        surface: distMatch ? surfaceMap[distMatch[1]] : null,
        distance: distMatch ? parseInt(distMatch[2], 10) : null,
        trackCondition: normalizeCondition(at(idx.cond)),
        passing,
        firstCorner: passNums ? parseInt(passNums[0], 10) : null,
        last3f: hasLast3f ? last3f : null,
        last3fRank: rankMark ? Number(rankMark[1]) : hasLast3f ? 0 : null,
        ...parseBodyWeight(at(idx.weight)),
        timeSec: parseRaceTime(at(idx.time)),
        marginSec: parseSigned(at(idx.margin)),
        carriedWeight: parsePositive(at(idx.kinryo)),
        ...parsePace(at(idx.pace)),
      });
    }
    // 成績の行（レースへのリンク）があるのに1行も読めない場合は、ページ構造の変更とみなす
    if (rows.length === 0 && /\/race\/\d{12}\//.test(table)) {
      throw new SourceParseError('競走成績が読み取れませんでした（ページ構造の変更の可能性）');
    }
    return { horseName, rows };
  }

  /** 血統ページから父・母・母の父を取得する（大量に読むためキャッシュしない） */
  async fetchPedigree(horseId: string): Promise<Pedigree> {
    if (!/^[0-9a-z]{10}$/i.test(horseId)) throw new Error(`馬IDが不正です: ${horseId}`);
    const res = await this.fetcher.get(`https://db.netkeiba.com/horse/ped/${horseId}/`, { noStore: true });
    if (res.status !== 200) throw new Error(`Failed to fetch pedigree (HTTP ${res.status})`);
    return this.parsePedigree(res.text);
  }

  /**
   * 血統表を解析する。血統表は世代ごとに rowspan が半分になる表のため、
   * 1代目（rowspan 最大）の2つ = 父・母、2代目の3つ目 = 母の父 とする
   */
  private parsePedigree(html: string): Pedigree {
    const table = (html.match(/<table[^>]*blood_table[^>]*>[\s\S]*?<\/table>/i) ?? [])[0];
    if (!table) throw new SourceParseError('血統表が見つかりません');
    const cells = [...table.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)].map((m) => {
      const span = parseInt(/rowspan="?(\d+)/i.exec(m[1])?.[1] ?? '1', 10);
      const link = /href="[^"]*\/horse\/([0-9a-z]{10})\/?"[^>]*>([\s\S]*?)<\/a>/i.exec(m[2]);
      const name = (link?.[2] ?? m[2]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().split(' ')[0] || null;
      return { span, id: link?.[1] ?? null, name };
    });
    const spans = [...new Set(cells.map((c) => c.span))].sort((a, b) => b - a);
    if (spans.length < 2) throw new SourceParseError('血統表の形式が想定と異なります');
    const gen1 = cells.filter((c) => c.span === spans[0]);
    const gen2 = cells.filter((c) => c.span === spans[1]);
    if (gen1.length < 2 || gen2.length < 4) throw new SourceParseError('血統表の形式が想定と異なります');
    return {
      sireId: gen1[0].id,
      sireName: gen1[0].name,
      damName: gen1[1].name,
      bmsId: gen2[2].id,
      bmsName: gen2[2].name,
    };
  }

  /** 種牡馬の産駒成績（距離別・馬場別、父として/母の父として）を取得する */
  async fetchSireStats(sireId: string): Promise<SireStatRow[]> {
    if (!/^[0-9a-z]{10}$/i.test(sireId)) throw new Error(`種牡馬IDが不正です: ${sireId}`);
    const base = `https://db.netkeiba.com/horse/sire/${sireId}/?syusai=10&mode=1`;
    const dist = await this.fetcher.get(`${base}&type=2`, { noStore: true });
    const cond = await this.fetcher.get(`${base}&type=1`, { noStore: true });
    if (dist.status !== 200 || cond.status !== 200) throw new Error('Failed to fetch sire stats');
    return [
      ...this.parseSireStats(dist.text, 'distance'),
      ...this.parseSireStats(cond.text, 'condition'),
    ];
  }

  /**
   * 産駒成績ページを読む。表は6つ（1〜3つ目 = 父として 芝・ダート・障害、4〜6つ目 = 母の父として 同）。
   * 各表の見出し直後の1行目が「累計」で、その下に年ごとの行が続く。累計行の数値は
   * 区分ごとに 1着・2着・3着・着外 の順。成績がない表は見出しだけになる（その表は行を作らない）
   */
  private parseSireStats(html: string, kind: SireStatRow['kind']): SireStatRow[] {
    const tables = html.match(/<table[^>]*race_table_01[^>]*>[\s\S]*?<\/table>/gi) || [];
    if (tables.length !== 6) {
      throw new SourceParseError(`産駒成績の表の数が想定と異なります（${tables.length}個）`);
    }
    const rows: SireStatRow[] = [];
    tables.forEach((table, ti) => {
      const role: SireStatRow['role'] = ti < 3 ? 'sire' : 'bms';
      const surface = SIRE_SURFACES[ti % 3];
      const buckets = SIRE_BUCKETS[kind][surface];
      // 見出し（th だけの行）を除いた最初の行 = 累計行。年の行から始まる場合は累計がないとみなす
      const first = (table.match(/<tr[\s\S]*?<\/tr>/gi) || []).find((r) => /<td/i.test(r));
      if (!first) return;
      const cells = [...first.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      const label = cells[0].replace(/<[^>]+>/g, '').trim();
      if (/^\d{4}$/.test(label)) return;
      // リンクがある場合は「全年（year=0。母の父の表は 0000）」で、区分記号が表の位置（芝ダ障）と一致することを確認する
      const codes = [...first.matchAll(/year=(\d+)&(?:amp;)?mode=(\w+)/gi)];
      if (codes.some((c) => Number(c[1]) !== 0 || c[2][0] !== SIRE_SURFACE_CODE[surface])) {
        throw new SourceParseError(`産駒成績の表の並びが想定と異なります（${role} ${surface}）`);
      }
      const nums = cells.slice(1).map((c) => Number(c.replace(/<[^>]+>/g, '').replace(/,/g, '').trim()));
      if (nums.length !== buckets.length * 4 || nums.some((n) => !Number.isInteger(n) || n < 0)) {
        throw new SourceParseError(`産駒成績の列の数が想定と異なります（${role} ${surface}: ${nums.length}列）`);
      }
      buckets.forEach((bucket, i) => {
        rows.push({
          role,
          surface,
          kind,
          bucket,
          first: nums[i * 4],
          second: nums[i * 4 + 1],
          third: nums[i * 4 + 2],
          other: nums[i * 4 + 3],
        });
      });
    });
    return rows;
  }

  async fetchHorseHistory(horseRef: SourceRef): Promise<{ horse: SourceHorse; results: SourcePastResult[] }> {
    // TODO: 馬情報ページの実装
    throw new Error('fetchHorseHistory not implemented yet');
  }

  /**
   * レース結果ページから出馬表を解析
   */
  private parseRaceCard(html: string, raceId: string, url: string, date?: string): RaceCardResult {
    // レース基本情報を抽出
    const race = this.extractRaceInfo(html, raceId, date);

    // 出馬表を抽出
    const entries = this.extractEntries(html);

    // 頭数は取得できた出走馬の数
    race.headcount = entries.length;

    return {
      raceRef: { source: 'netkeiba', id: raceId },
      race,
      entries: entries.map((e, idx) => ({
        ...e,
        raceKey: race.raceKey,
        scratched: false,
      })),
    };
  }

  /**
   * HTML からレース基本情報を抽出
   */
  private extractRaceInfo(html: string, raceId: string, dateOverride?: string): RaceRecord {
    // race_id から会場・レース番号を抽出
    // 形式: YYYY + 会場コード(2桁, 5-6文字目) + 開催回(2桁) + 日目(2桁) + Rコード(2桁)
    const venueCode = raceId.substring(4, 6); // 01-10（JRA）
    const raceNo = parseInt(raceId.substring(10, 12), 10); // R01-R12

    // 日付は race_id に含まれないため、引数（YYYY-MM-DD）を優先。未指定時は HTML から抽出
    const date = dateOverride ?? this.extractDateFromHtml(html);
    if (!date) {
      throw new Error(`レース日付が取得できません (race_id=${raceId})`);
    }
    const dateStr = date.replace(/-/g, ''); // YYYYMMDD
    const raceKey = `${dateStr}-${venueCode}-${String(raceNo).padStart(2, '0')}`;

    // ページタイトルからレース名を抽出
    const titleMatch = /<title>([^<]+)<\/title>/.exec(html);
    const title = titleMatch?.[1] || '';
    const raceNameMatch = title.match(/【?([^【】|]+)/); // 【xxx R レース名】 など
    // 末尾の「出馬表」などのページ名は除去する
    const raceName = (raceNameMatch?.[1]?.trim() || '').replace(/出馬表.*$/, '').trim();

    // 会場名をコードから決定（JRA 10場）
    const venueMap: Record<string, string> = {
      '01': '札幌', '02': '函館', '03': '福島', '04': '新潟', '05': '東京',
      '06': '中山', '07': '中京', '08': '京都', '09': '阪神', '10': '小倉'
    };
    const venueName = venueMap[venueCode] || 'Unknown';

    // グレード（GI/GII/GIII/G1/G2/G3/L/OP など）をタイトルから抽出（画面表記のまま保存）
    const gradeMatch = title.match(/(GIII|GII|GI|G3|G2|G1|L|OP|条件)/);
    const grade = gradeMatch?.[1] ?? null;

    // 天候・馬場状態をテーブルから抽出
    const weatherMatch = html.match(/天候[：:]([^\<]+)/);
    const weather = this.normalizeWeather(weatherMatch?.[1]?.trim() || null);

    const conditionMatch = html.match(/馬場[：:]([^\<]+)/);
    const trackCondition = this.normalizeTrackCondition(conditionMatch?.[1]?.trim() || null);

    // コース情報（サーフェス・距離・回り）を抽出。表記例: 「芝1600m」「ダ1300m (左)」
    // 既定値は入れない。取得できない場合はエラーにし、そのレースは失敗として記録する
    // 実際のHTML例: <span> ダ1300m</span> (左) / <span> 芝1600m</span> (左&nbsp;A)
    // 「m」の後に </span> が入る場合があり、回りの後に馬場区分（A など）が続く場合がある
    const courseMatch = html.match(/(芝|ダ|障)(\d{4})m(?:<\/span>)?(?:\s*\(([左右])[^)]*\))?/);
    if (!courseMatch) {
      throw new Error('距離・馬場の情報が取得できません');
    }
    const surfaceMap: Record<string, string> = { '芝': '芝', 'ダ': 'ダート', '障': '障害' };
    const surface = surfaceMap[courseMatch[1]];
    const distance = parseInt(courseMatch[2], 10);
    const turn = courseMatch[3] ?? null; // 回りが無い場合は null

    // 発走時刻（例: 「10:05発走」）。取得できない場合は null
    const postTimeMatch = html.match(/(\d{1,2}:\d{2})\s*発走/);
    const postTime = postTimeMatch?.[1] ?? null;

    return {
      raceKey,
      date,
      venueCode: venueCode as VenueCode,
      venueName,
      raceNo,
      name: raceName,
      grade,
      surface: surface as any,
      distance,
      courseVariant: null,
      turn,
      weather,
      trackCondition,
      postTime,
      headcount: null,
    };
  }

  /**
   * 出馬表テーブルから馬情報を抽出
   */
  private extractEntries(html: string): Omit<SourceEntry, 'raceKey'>[] {
    const entries: Omit<SourceEntry, 'raceKey'>[] = [];

    // class に Shutuba_Table を含む出馬表テーブルを抽出
    const tableMatch = html.match(/<table[^>]*class="[^"]*Shutuba_Table[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
    if (!tableMatch) {
      throw new Error('出馬表テーブルが見つかりません');
    }

    const tableHtml = tableMatch[1];

    // 出走馬の行のみ（class に HorseList を含む tr）
    // raw HTML には tbody が無い場合があるため（ブラウザが自動補完する）、table 全体から探す
    const rows = tableHtml.match(/<tr[^>]*class="[^"]*HorseList[^"]*"[^>]*>[\s\S]*?<\/tr>/gi) || [];

    rows.forEach((rowHtml, rowIdx) => {
      try {
        const entry = this.parseTableRow(rowHtml);
        if (entry) {
          entries.push(entry);
        }
      } catch (err: any) {
        console.warn(`行 ${rowIdx + 1} の解析に失敗: ${err?.message ?? err}`);
      }
    });

    return entries;
  }

  /**
   * テーブル1行を解析
   */
  private parseTableRow(rowHtml: string): Omit<SourceEntry, 'raceKey'> | null {
    const cells: string[] = [];
    const cellMatches = rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi);

    for (const match of cellMatches) {
      let cell = match[1];
      // HTML タグと改行を削除
      cell = cell.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      cells.push(cell);
    }

    if (cells.length < 7) {
      return null; // データ不足
    }

    // 枠 / 馬番 / 印 / 馬名 / 性齢 / 斤量 / 騎手 / ... / 厩舎（出馬表の列）
    // 馬番は枠順確定前は空欄になるため、空なら null として行は残す
    const parsedNumber = parseInt(cells[1], 10);
    const horseNumber = Number.isNaN(parsedNumber) ? null : parsedNumber;
    const horseName = cells[3];
    const sexAgeParts = cells[4].match(/^(牡|牝|セン)(\d+)$/);
    const sex = sexAgeParts?.[1] || null;
    const age = sexAgeParts?.[2] ? parseInt(sexAgeParts[2], 10) : null;
    const weight = parseFloat(cells[5]);
    // 騎手名の先頭「▲」は見習い騎手の印（斤量減量の対象）。名前からは外し、別フラグにする
    const apprentice = cells[6].startsWith('▲');
    const jockey = cells[6].replace(/^▲/, '');
    const trainer = cells[7]?.split('\n')?.[0] || null; // 厩舎名（出馬表の列）

    if (!horseName) {
      return null;
    }

    // netkeiba の馬ID（10桁）・騎手ID（5桁）をリンクから取り出す（無ければ null）
    const netkeibaHorseId = rowHtml.match(/db\.netkeiba\.com\/horse\/(\d{10})/)?.[1] ?? null;
    const jockeyId = rowHtml.match(/\/jockey\/(?:result\/recent\/)?(\d{5})/)?.[1] ?? null;

    return {
      netkeibaHorseId,
      jockeyId,
      horseNumber,
      frameNumber: parseInt(cells[0], 10) || null,
      horseName,
      sex: sex as any || null,
      age,
      jockey,
      apprentice,
      trainer,
      carriedWeight: weight || null,
      // 当日の馬体重（発表後のみ。例: 548(+2)）。発表前は空なので null
      ...(() => {
        const w = parseBodyWeight(rowHtml.match(/class="Weight"[^>]*>([\s\S]*?)<\/td>/)?.[1]?.replace(/<[^>]+>/g, ''));
        return { bodyWeight: w.bodyWeight, bodyWeightDiff: w.bodyWeightDiff };
      })(),
      scratched: false, // 結果ページに乗っている馬は出走している
      horseRef: { source: 'netkeiba', id: horseName }, // 暫定：馬名を ID として使用（後で馬詳細ページから ID を取得）
    };
  }

  /**
   * 単勝オッズを抽出（オッズ API の JSON から）
   * 形式: data.odds["1"][馬番(2桁)] = [オッズ(小数の文字列), "0.0", 人気順(文字列)]
   * status: 発売中は "middle"（2026-10-12 確認）。確定後は "result"、発売前の予想オッズは "yoso"（未確認）
   */
  private parseWinOdds(json: string, raceId: string): WinOddsResult {
    const fetchedAt = new Date().toISOString();

    let body: any;
    try {
      body = JSON.parse(json);
    } catch {
      throw new SourceParseError('オッズ応答が JSON として解釈できません');
    }

    // オッズの段階：result = 確定、middle = 発売中、それ以外（発売前の yoso など）= 予想オッズ
    const status = String(body?.status ?? '');
    const kind: 'final' | 'live' | 'forecast' = status === 'result' ? 'final' : status === 'middle' ? 'live' : 'forecast';
    const winTable = body?.data?.odds?.['1'];
    if (!winTable || typeof winTable !== 'object') {
      // 発売前などでオッズが未公開の場合
      throw new SourceParseError('単勝オッズが見つかりません（未公開の可能性）');
    }

    const odds = Object.entries(winTable).map(([key, value]: [string, any]) => {
      const horseNumber = parseInt(key, 10);
      const winOdds = Number.parseFloat(String(value?.[0] ?? ''));
      const popularity = parseInt(String(value?.[2] ?? ''), 10);
      return {
        horseNumber,
        // 0 や欠損は「オッズ未確定（取消など）」として null にする
        winOdds: Number.isFinite(winOdds) && winOdds > 0 ? winOdds : null,
        popularity: Number.isFinite(popularity) && popularity > 0 ? popularity : null,
        fetchedAt,
        kind,
      };
    }).filter((o) => !Number.isNaN(o.horseNumber));

    return {
      raceRef: { source: 'netkeiba', id: raceId },
      odds,
    };
  }

  /**
   * HTML から開催日（YYYY-MM-DD）を抽出（書式「2026年10月10日」は未確認）
   */
  private extractDateFromHtml(html: string): string | null {
    const m = html.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!m) return null;
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }

  private normalizeWeather(text: string | null): Weather | null {
    if (!text) return null;
    const map: Record<string, Weather> = {
      '晴': '晴', '曇': '曇', '小雨': '小雨', '雨': '雨', '小雪': '小雪', '雪': '雪',
    };
    return map[text] || null;
  }

  private normalizeTrackCondition(text: string | null): TrackCondition | null {
    if (!text) return null;
    // ページでは「稍」「不」と省略されることがある
    const map: Record<string, TrackCondition> = {
      '良': '良', '稍重': '稍重', '稍': '稍重', '重': '重', '不良': '不良', '不': '不良',
    };
    return map[text] || null;
  }
}
