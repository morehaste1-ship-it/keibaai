/**
 * 3連単の予想（本命・中穴・大穴）と、データから組み立てる解説
 *
 * 買い目はフォーメーション（1着・2着・3着の候補を決めて組み合わせる）。
 * 解説の数字はすべて点数APIが返した実データ（各項目の根拠）から作り、無いものは「データなし」と書く。
 */
import type { RankedItem } from './dataScore';

export interface RaceInfo {
  name: string;
  venueName: string;
  surface: string;
  distance: number;
}

export interface HistoryCorner {
  前: number;
  中: number;
  後: number;
  total: number;
}

/** データ予想の結果一式（各タブで実データの表示に使う） */
export interface RealDataView {
  ranked: RankedItem[];
  race: RaceInfo | null;
  historyCorner: HistoryCorner | null;
}

export type Pace = 'ハイペース寄り' | '平均ペース' | 'スロー寄り';

export interface PaceForecast {
  pace: Pace;
  nige: string[];
  senko: string[];
  /** 有利になりやすい脚質 */
  favored: string[];
  text: string;
}

export interface Ticket {
  first: number;
  second: number;
  third: number;
}

export interface TrifectaPlan {
  kind: '本命' | '中穴' | '大穴';
  available: boolean;
  reason: string; // 作れなかった理由（available=false のとき）
  formation: { first: number[]; second: number[]; third: number[] };
  tickets: Ticket[];
  keyHorses: number[]; // 解説する馬（軸・穴）
  summary: string;
}

/** フォーメーションの各着の馬番から重複を除く（同じ馬が◎と中穴候補を兼ねる場合など。買い目の点数は変わらない） */
const dedupe = (f: { first: number[]; second: number[]; third: number[] }) => ({
  first: [...new Set(f.first)],
  second: [...new Set(f.second)],
  third: [...new Set(f.third)],
});

const label = (h: RankedItem) => `${h.horseNumber ?? '-'}番${h.horseName}`;
const num = (h: RankedItem) => h.horseNumber as number;

/** フォーメーションから3連単の組み合わせを作る（同じ馬が重なる組み合わせ・重複は除く） */
export function buildTickets(first: number[], second: number[], third: number[], mustInclude?: number[]): Ticket[] {
  const seen = new Set<string>();
  const out: Ticket[] = [];
  for (const a of first)
    for (const b of second)
      for (const c of third) {
        if (a === b || b === c || a === c) continue;
        if (mustInclude && ![a, b, c].some((x) => mustInclude.includes(x))) continue;
        const key = `${a}-${b}-${c}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ first: a, second: b, third: c });
      }
  return out;
}

/** 逃げ・先行の割合がこれ以上ならハイペース寄りと判定する */
export const FRONT_SHARE_HIGH = 0.4;

/** 主な脚質から展開を予想する */
export function forecastPace(items: RankedItem[], history: HistoryCorner | null): PaceForecast {
  const nige = items.filter((h) => h.mainStyle === '逃げ').map(label);
  const senko = items.filter((h) => h.mainStyle === '先行').map(label);
  let pace: Pace;
  let favored: string[];
  // 逃げ・先行が出走頭数の4割以上いると、前の争いが厳しくなりやすい（2026/10/11 アイルランドTの先行7頭崩れを受けて追加）
  const frontShare = items.length > 0 ? (nige.length + senko.length) / items.length : 0;
  if (nige.length >= 2 || frontShare >= FRONT_SHARE_HIGH) {
    pace = 'ハイペース寄り';
    favored = ['差し', '追込'];
  } else if (nige.length <= 1 && senko.length <= 3) {
    pace = 'スロー寄り';
    favored = ['逃げ', '先行'];
  } else {
    pace = '平均ペース';
    favored = ['先行', '差し'];
  }
  const parts = [
    nige.length === 0
      ? '主な脚質が「逃げ」の馬はいません'
      : `主な脚質が「逃げ」の馬は${nige.length}頭（${nige.join('・')}）`,
    `「先行」は${senko.length}頭（逃げ・先行で出走${items.length}頭の${Math.round(frontShare * 100)}%）`,
  ];
  let text = `${parts.join('、')}。そのため${pace}と予想し、${favored.join('・')}の馬に有利とみます。`;
  if (history && history.total > 0) {
    text += `過去10年のこのレースで3着以内に入った馬の4コーナーの位置は、前${history.前}・中${history.中}・後${history.後}でした。`;
  } else {
    text += '過去10年の位置取りデータはありません。';
  }
  return { pace, nige, senko, favored, text };
}

/** ◎◯▲の馬（本命の軸）。中穴・大穴の候補からは除く（除かないと穴の買い目が◎◯▲の並び替えになるため） */
const CORE_MARKS = ['◎', '◯', '▲'];

/** 中穴候補：◎◯▲以外で、4〜9番人気かつデータ予想の順位が人気より3つ以上高い馬（上位2頭） */
export function midCandidates(items: RankedItem[]): RankedItem[] {
  return items
    .filter((h) => !CORE_MARKS.includes(h.mark))
    .filter((h) => h.horseNumber !== null && h.popularity !== null && h.popularity >= 4 && h.popularity <= 9 && h.rank <= h.popularity - 3)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 2);
}

/** 大穴候補：◎◯▲以外で、10番人気以下かつデータ予想の順位が8位以内の馬（上位2頭） */
export function longCandidates(items: RankedItem[]): RankedItem[] {
  return items
    .filter((h) => !CORE_MARKS.includes(h.mark))
    .filter((h) => h.horseNumber !== null && h.popularity !== null && h.popularity >= 10 && h.rank <= 8)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 2);
}

export function buildPlans(items: RankedItem[]): TrifectaPlan[] {
  const byMark = (m: string) => items.filter((h) => h.mark === m && h.horseNumber !== null);
  const [hon] = byMark('◎');
  const [tai] = byMark('◯');
  const [tan] = byMark('▲');
  const ren = byMark('△');
  const hasOdds = items.some((h) => h.popularity !== null);
  const empty = { first: [], second: [], third: [] };

  const plans: TrifectaPlan[] = [];

  // 本命：1着◎ → 2着◯▲ → 3着◯▲△△（6点）
  if (hon && tai && tan) {
    const f = dedupe({ first: [num(hon)], second: [num(tai), num(tan)], third: [num(tai), num(tan), ...ren.map(num)] });
    plans.push({
      kind: '本命',
      available: true,
      reason: '',
      formation: f,
      tickets: buildTickets(f.first, f.second, f.third),
      keyHorses: [num(hon), num(tai), num(tan)],
      summary: `データ予想1位の${label(hon)}を1着に固定し、2位${label(tai)}・3位${label(tan)}を2着、そこに△を加えて3着とする堅実な組み立てです。`,
    });
  } else {
    plans.push({ kind: '本命', available: false, reason: '◎◯▲の印が付いた馬が3頭そろいません', formation: empty, tickets: [], keyHorses: [], summary: '' });
  }

  // 中穴：1着◎◯ → 2着 中穴候補・◎◯ → 3着 中穴候補・▲（中穴候補を必ず含む）
  const mids = midCandidates(items);
  if (!hasOdds) {
    plans.push({ kind: '中穴', available: false, reason: '単勝オッズ（人気）が保存されていないため、中穴候補を選べません', formation: empty, tickets: [], keyHorses: [], summary: '' });
  } else if (!hon || !tai || mids.length === 0) {
    plans.push({ kind: '中穴', available: false, reason: '条件（◎◯▲以外で、4〜9番人気かつデータ予想の順位が人気より3つ以上高い馬）に合う馬がいません', formation: empty, tickets: [], keyHorses: [], summary: '' });
  } else {
    const m = mids.map(num);
    const f = dedupe({ first: [num(hon), num(tai)], second: [...m, num(hon), num(tai)], third: [...m, ...(tan ? [num(tan)] : [])] });
    plans.push({
      kind: '中穴',
      available: true,
      reason: '',
      formation: f,
      tickets: buildTickets(f.first, f.second, f.third, m),
      keyHorses: [...m, num(hon), num(tai)],
      summary: `人気の割にデータ上の評価が高い${mids.map((h) => `${label(h)}（${h.popularity}番人気→データ${h.rank}位）`).join('・')}を2〜3着に入れ、◎◯を1着とする組み立てです。`,
    });
  }

  // 大穴：1着◎◯▲ → 2着◎◯▲ → 3着 大穴候補 ＋ 大穴候補が2着の組み合わせ（大穴候補は1頭）
  const longs = longCandidates(items);
  if (!hasOdds) {
    plans.push({ kind: '大穴', available: false, reason: '単勝オッズ（人気）が保存されていないため、大穴候補を選べません', formation: empty, tickets: [], keyHorses: [], summary: '' });
  } else if (!hon || !tai || !tan || longs.length === 0) {
    plans.push({ kind: '大穴', available: false, reason: '条件（◎◯▲以外で、10番人気以下かつデータ予想が8位以内）に合う馬がいません', formation: empty, tickets: [], keyHorses: [], summary: '' });
  } else {
    const L = num(longs[0]);
    const core = [num(hon), num(tai), num(tan)];
    const tickets = [...buildTickets(core, core, [L]), ...buildTickets(core, [L], core)];
    plans.push({
      kind: '大穴',
      available: true,
      reason: '',
      formation: dedupe({ first: core, second: [...core, L], third: [...core, L] }),
      tickets,
      keyHorses: [L, ...core],
      summary:
        `${longs[0].popularity}番人気ながらデータ予想${longs[0].rank}位の${label(longs[0])}を2着・3着に入れ、◎◯▲と組み合わせる高配当狙いです。` +
        (longs[1] ? `ほかに${label(longs[1])}（${longs[1].popularity}番人気・データ${longs[1].rank}位）も候補です（買い目には含めていません）。` : ''),
    });
  }
  return plans;
}

/** 馬1頭分の解説（実データの根拠だけで組み立てる） */
export function explainHorse(h: RankedItem, pace: PaceForecast | null): string[] {
  const c = h.components;
  const lines: string[] = [];
  const pop = h.popularity !== null ? `${h.popularity}番人気` : '人気不明';
  lines.push(`${label(h)}（${pop}・データ予想${h.rank}位・合計${h.total.toFixed(1)}点${h.mark ? `・印${h.mark}` : ''}）`);

  // 実績・調子
  if (h.recentRuns && h.recentRuns.length > 0) {
    const runs = h.recentRuns
      .map((r) => `${r.date.slice(5).replace('-', '/')} ${r.venueName ?? ''}${r.surface ?? ''}${r.distance ?? ''} ${r.finishText || '-'}着`)
      .join('、');
    lines.push(`実績・調子：近走 ${runs}（近走の点数${c.recent.score}）`);
  } else {
    lines.push('実績・調子：JRAの出走歴なし（データなし）');
  }
  // コース適性
  lines.push(`コース適性：${c.aptitude.hasData ? `${c.aptitude.detail}（適性${c.aptitude.score}点）` : 'データなし'}`);
  // 騎手
  lines.push(`騎手：${h.jockeyName ?? '-'}。${c.jockey.hasData ? `${c.jockey.detail}（騎手${c.jockey.score}点）` : '騎手成績はデータなし'}`);
  // 相性
  const combo = h.combo
    ? h.combo.rides > 0
      ? `この騎手とのコンビは${h.combo.rides}戦${h.combo.wins}勝・3着内${h.combo.top3}回`
      : 'この騎手とは初コンビ'
    : 'コンビ成績はデータなし';
  lines.push(`相性：${c.matchup.hasData ? `${c.matchup.detail}（相性${c.matchup.score}点）。` : ''}${combo}`);
  // 状態
  lines.push(`状態：${c.state.hasData ? c.state.detail : 'データなし'}`);
  // 末脚（古いデータで項目が無い場合は表示しない）
  if (c.closing) lines.push(`末脚：${c.closing.hasData ? `${c.closing.detail}（末脚${c.closing.score}点）` : 'データなし'}`);
  // 着差・スピード（古いデータで項目が無い場合は表示しない）
  if (c.margin) lines.push(`着差：${c.margin.hasData ? `${c.margin.detail}（着差${c.margin.score}点）` : 'データなし'}`);
  if (c.speed) lines.push(`スピード：${c.speed.hasData ? `${c.speed.detail}（スピード${c.speed.score}点）` : 'データなし'}`);
  // 枠・条件替わり・休み明け（古いデータで項目が無い場合は表示しない）
  if (c.frame) lines.push(`枠：${c.frame.hasData ? `${c.frame.detail}（枠${c.frame.score}点）` : 'データなし'}`);
  if (c.change) lines.push(`条件替わり：${c.change.hasData ? `${c.change.detail}（条件替わり${c.change.score}点）` : 'データなし'}`);
  if (c.layoff) lines.push(`休み明け：${c.layoff.hasData ? `${c.layoff.detail}（休み明け${c.layoff.score}点）` : 'データなし'}`);
  // 位置どり・騎手の位置どり・馬場傾向（古いデータで項目が無い場合は表示しない）
  if (c.position) lines.push(`位置どり：${c.position.hasData ? `${c.position.detail}（位置どり${c.position.score}点）` : 'データなし'}`);
  if (c.jockeyPos) lines.push(`騎手の位置どり：${c.jockeyPos.hasData ? `${c.jockeyPos.detail}（${c.jockeyPos.score}点）` : 'データなし'}`);
  if (c.trend) lines.push(`馬場傾向：${c.trend.hasData ? `${c.trend.detail}（馬場傾向${c.trend.score}点）` : 'データなし'}`);
  // 展開
  if (pace) {
    if (!h.mainStyle) {
      lines.push('展開：脚質のデータなし');
    } else {
      const fit = pace.favored.includes(h.mainStyle);
      lines.push(`展開：主な脚質は${h.mainStyle}。${pace.pace}の予想では${fit ? '展開が向きやすい' : '展開の後押しは受けにくい'}と見ます`);
    }
  }
  return lines;
}
