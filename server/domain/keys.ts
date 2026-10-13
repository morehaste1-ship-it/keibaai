import type { VenueCode } from './types';

/** JRA 競馬場コードと名称の対応 */
export const VENUES: Record<VenueCode, string> = {
  '01': '札幌',
  '02': '函館',
  '03': '福島',
  '04': '新潟',
  '05': '東京',
  '06': '中山',
  '07': '中京',
  '08': '京都',
  '09': '阪神',
  '10': '小倉',
};

export function venueCodeFromName(name: string): VenueCode | null {
  const hit = (Object.entries(VENUES) as [VenueCode, string][]).find(([, n]) => n === name);
  return hit ? hit[0] : null;
}

/**
 * レースの内部キーを作る。
 * 取得元のIDに依存しないよう「開催日・競馬場・レース番号」だけで決める。
 * @param date YYYY-MM-DD
 */
export function makeRaceKey(date: string, venueCode: VenueCode, raceNo: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日付形式が不正です: ${date}`);
  if (!VENUES[venueCode]) throw new Error(`競馬場コードが不正です: ${venueCode}`);
  if (!Number.isInteger(raceNo) || raceNo < 1 || raceNo > 12) throw new Error(`レース番号が不正です: ${raceNo}`);
  return `${date.replace(/-/g, '')}-${venueCode}-${String(raceNo).padStart(2, '0')}`;
}
