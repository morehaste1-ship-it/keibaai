/**
 * レースのデータの状態（画面上部の「データの状態」用）。DBを読むだけ
 *
 * 馬番・単勝オッズ・過去走・血統・騎手成績・過去10年・馬場・予想の記録について、
 * そろっているか（ok）、欠けがあるか（warn）、参考情報か（info）をまとめる
 */
import type { RaceRepository } from '../db/repository';
import { seriesKeyOf } from './history-service';

export type StatusLevel = 'ok' | 'warn' | 'info';

export interface StatusItem {
  key: 'numbers' | 'odds' | 'runs' | 'pedigree' | 'jockeys' | 'history' | 'condition' | 'records';
  label: string;
  level: StatusLevel;
  /** 画面に出す短い文 */
  text: string;
  /** 欠けている馬・騎手の名前など（マウスを乗せると表示） */
  detail: string | null;
}

export interface RaceStatus {
  raceKey: string;
  horses: number;
  items: StatusItem[];
}

const ODDS_KIND: Record<string, string> = { forecast: '予想オッズ', live: '発売中', final: '確定' };

function timeText(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const names = (list: string[], max = 8) => (list.length <= max ? list.join('、') : `${list.slice(0, max).join('、')} ほか${list.length - max}件`);

export function raceStatus(repo: RaceRepository, raceKey: string): RaceStatus | null {
  const race = repo.getRace(raceKey);
  if (!race) return null;
  const entries = repo.getEntries(raceKey).filter((e) => !e.scratched);
  const items: StatusItem[] = [];
  const horseName = (e: (typeof entries)[number]) => `${e.horseNumber ?? '-'}${e.horseName}`;

  // 馬番
  const noNumber = entries.filter((e) => e.horseNumber === null);
  items.push(
    entries.length === 0
      ? { key: 'numbers', label: '馬番', level: 'warn', text: '出走馬が未取り込み', detail: null }
      : noNumber.length === 0
        ? { key: 'numbers', label: '馬番', level: 'ok', text: `確定（${entries.length}頭）`, detail: null }
        : { key: 'numbers', label: '馬番', level: 'warn', text: `未確定（枠順の発表待ち）`, detail: `${noNumber.length}/${entries.length}頭に馬番がありません` },
  );

  // 単勝オッズ（最新の種類と時刻）
  const odds = repo.getLatestWinOdds(raceKey);
  if (odds.length === 0) {
    items.push({ key: 'odds', label: '単勝オッズ', level: 'warn', text: 'なし', detail: '前日・当日のオッズの取り込みで入ります' });
  } else {
    const latest = odds.reduce((a, b) => (a.fetchedAt > b.fetchedAt ? a : b));
    items.push({
      key: 'odds',
      label: '単勝オッズ',
      level: latest.kind === 'forecast' ? 'info' : 'ok',
      text: `${ODDS_KIND[latest.kind] ?? latest.kind}（${timeText(latest.fetchedAt)}）`,
      detail: null,
    });
  }

  // 過去走・血統（馬IDがある馬だけ）
  const withId = entries.filter((e) => e.netkeibaHorseId);
  const noRuns = withId.filter((e) => !repo.getHorseFetchedAt(e.netkeibaHorseId as string));
  const noPed = withId.filter((e) => !repo.getPedigree(e.netkeibaHorseId as string));
  const noId = entries.filter((e) => !e.netkeibaHorseId);
  items.push(
    noRuns.length === 0 && noId.length === 0
      ? { key: 'runs', label: '過去走', level: entries.length ? 'ok' : 'info', text: entries.length ? '全頭あり' : '-', detail: null }
      : {
          key: 'runs',
          label: '過去走',
          level: 'warn',
          text: `未取得 ${noRuns.length + noId.length}頭`,
          detail: names([...noRuns, ...noId].map(horseName)),
        },
  );
  items.push(
    noPed.length === 0
      ? { key: 'pedigree', label: '血統', level: entries.length ? 'ok' : 'info', text: entries.length ? '全頭あり' : '-', detail: null }
      : { key: 'pedigree', label: '血統', level: 'warn', text: `未取得 ${noPed.length}頭`, detail: names(noPed.map(horseName)) },
  );

  // 騎手成績
  const jockeys = new Map<string, string>();
  const noJockeyId: string[] = [];
  for (const e of entries) {
    if (e.jockeyId) jockeys.set(e.jockeyId, (e.jockeyId && repo.getJockeyName(e.jockeyId)) || e.jockey || e.jockeyId);
    else if (e.jockey) noJockeyId.push(e.jockey);
  }
  const noData: string[] = [];
  const partial: string[] = [];
  for (const [id, name] of jockeys) {
    const st = repo.jockeyDataStateOf(id);
    if (st.runs === 0) noData.push(name);
    else if (st.backfillDone === false) partial.push(name);
  }
  if (jockeys.size === 0 && noJockeyId.length === 0) {
    items.push({ key: 'jockeys', label: '騎手成績', level: 'info', text: '-', detail: null });
  } else if (noData.length === 0 && noJockeyId.length === 0 && partial.length === 0) {
    items.push({ key: 'jockeys', label: '騎手成績', level: 'ok', text: `全員あり（${jockeys.size}人）`, detail: null });
  } else {
    const parts: string[] = [];
    if (noData.length + noJockeyId.length > 0) parts.push(`未取得 ${noData.length + noJockeyId.length}人`);
    if (partial.length > 0) parts.push(`5年分の途中 ${partial.length}人`);
    const detail = [
      noData.length ? `未取得: ${names(noData)}` : '',
      noJockeyId.length ? `騎手IDなし: ${names(noJockeyId)}` : '',
      partial.length ? `5年分の途中: ${names(partial)}` : '',
    ]
      .filter(Boolean)
      .join('／');
    items.push({ key: 'jockeys', label: '騎手成績', level: noData.length + noJockeyId.length > 0 ? 'warn' : 'info', text: parts.join('・'), detail });
  }

  // 過去10年（同じレースの過去の結果）
  const hist = repo.listHistoryRuns(seriesKeyOf(race.name, race.venueName, race.surface, race.distance));
  const years = new Map<string, boolean>();
  for (const h of hist) {
    const y = h.date.slice(0, 4);
    years.set(y, (years.get(y) ?? false) || h.trackCondition === null);
  }
  const unknownYears = [...years].filter(([, nc]) => nc).map(([y]) => y);
  items.push(
    years.size === 0
      ? { key: 'history', label: '過去10年', level: 'info', text: '未取得', detail: '「過去10年の同一レース分析」の「過去10年を取得」で取り込めます（重賞など同じ名前のレースがあるとき）' }
      : {
          key: 'history',
          label: '過去10年',
          level: years.size >= 10 && unknownYears.length === 0 ? 'ok' : 'warn',
          text: `${years.size}年分${unknownYears.length ? `（馬場不明 ${unknownYears.length}年）` : ''}`,
          detail: unknownYears.length ? `馬場不明: ${unknownYears.sort().reverse().join('・')}年。「過去10年を取得」を押し直すと補えます` : null,
        },
  );

  // 馬場
  items.push(
    race.trackCondition
      ? { key: 'condition', label: '馬場', level: 'ok', text: race.trackCondition, detail: null }
      : { key: 'condition', label: '馬場', level: 'info', text: '未発表', detail: '画面上部の馬場の選択で計算しています' },
  );

  // 予想の記録
  const src = new Set(repo.predictionSourcesOf(raceKey));
  const recText = [src.has('eve') ? '前日' : '', src.has('auto') ? '当日' : '', src.has('manual') ? '手動' : ''].filter(Boolean).join('・');
  items.push({ key: 'records', label: '予想の記録', level: 'info', text: recText || 'まだなし', detail: null });

  return { raceKey, horses: entries.length, items };
}
