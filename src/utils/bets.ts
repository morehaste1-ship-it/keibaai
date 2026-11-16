/**
 * 3連複・3連単ボックスの買い目（画面・記録・検証で共通に使う）
 *
 * 3連複は、データ予想の合計点の差からレースの形を判定して買い方を選ぶ
 *  - 2強：1位・2位が3位を SANRENPUKU_RULE.twoGap 点以上離している → 1位・2位の2頭軸 → 相手（3位から）
 *  - 1強：1位が2位を SANRENPUKU_RULE.oneGap 点以上離している       → 1位の1頭軸 → 相手（2位から）
 *  - 混戦：どちらでもない                                           → 上位のボックス
 * 判定の基準（点差）は server/scripts/check-bets.ts で過去の記録から決める
 */

/** 3連複の1点（馬番を小さい順に並べた3頭） */
export type Trio = [number, number, number];
/** 3連単の1点（1着・2着・3着の馬番） */
export type Trifecta = [number, number, number];

const sortTrio = (a: number, b: number, c: number): Trio => [a, b, c].sort((x, y) => x - y) as Trio;

function uniqTrios(list: Trio[]): Trio[] {
  const seen = new Set<string>();
  return list.filter((t) => {
    const k = t.join('-');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 3連複：1頭軸流し（軸1頭＋相手から2頭） */
export function trioAxis1(axis: number, partners: number[]): Trio[] {
  const p = partners.filter((x) => x !== axis);
  const out: Trio[] = [];
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) out.push(sortTrio(axis, p[i], p[j]));
  return uniqTrios(out);
}

/** 3連複：2頭軸流し（軸2頭＋相手1頭） */
export function trioAxis2(a: number, b: number, partners: number[]): Trio[] {
  return uniqTrios(partners.filter((x) => x !== a && x !== b).map((c) => sortTrio(a, b, c)));
}

/** 3連複：ボックス */
export function trioBox(horses: number[]): Trio[] {
  const h = [...new Set(horses)];
  const out: Trio[] = [];
  for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++) for (let k = j + 1; k < h.length; k++) out.push(sortTrio(h[i], h[j], h[k]));
  return out;
}

/** 3連単：ボックス */
export function trifectaBox(horses: number[]): Trifecta[] {
  const h = [...new Set(horses)];
  const out: Trifecta[] = [];
  for (const a of h) for (const b of h) for (const c of h) if (a !== b && b !== c && a !== c) out.push([a, b, c]);
  return out;
}

export type RaceShape = '2強' | '1強' | '混戦';

/** 3連複の判定基準（点差は合計点の差。check-bets.ts の結果で決める） */
export interface TrioRule {
  /** 2強：2位と3位の点差がこれ以上 */
  twoGap: number;
  /** 1強：1位と2位の点差がこれ以上 */
  oneGap: number;
  /** 2頭軸の相手の数 */
  twoPartners: number;
  /** 1頭軸の相手の数 */
  onePartners: number;
  /** 混戦のボックスの頭数 */
  boxSize: number;
}

/** 合計点の高い順の点から、レースの形を判定する */
export function raceShapeOf(totalsDesc: number[], rule: TrioRule): { shape: RaceShape; gap12: number; gap23: number } {
  const gap12 = (totalsDesc[0] ?? 0) - (totalsDesc[1] ?? 0);
  const gap23 = (totalsDesc[1] ?? 0) - (totalsDesc[2] ?? 0);
  if (gap23 >= rule.twoGap) return { shape: '2強', gap12, gap23 };
  if (gap12 >= rule.oneGap) return { shape: '1強', gap12, gap23 };
  return { shape: '混戦', gap12, gap23 };
}

/** 3連複の提案。ranked は合計点の高い順（馬番と合計点） */
export function planTrio(
  ranked: { horseNumber: number; total: number }[],
  rule: TrioRule,
): { shape: RaceShape; gap12: number; gap23: number; axis: number[]; partners: number[]; tickets: Trio[] } | null {
  if (ranked.length < 5) return null;
  const n = ranked.map((r) => r.horseNumber);
  const s = raceShapeOf(ranked.map((r) => r.total), rule);
  if (s.shape === '2強') {
    const partners = n.slice(2, 2 + rule.twoPartners);
    return { ...s, axis: [n[0], n[1]], partners, tickets: trioAxis2(n[0], n[1], partners) };
  }
  if (s.shape === '1強') {
    const partners = n.slice(1, 1 + rule.onePartners);
    return { ...s, axis: [n[0]], partners, tickets: trioAxis1(n[0], partners) };
  }
  const box = n.slice(0, rule.boxSize);
  return { ...s, axis: [], partners: box, tickets: trioBox(box) };
}

/**
 * 選べる買い方（画面の買い目タブ・答え合わせで共通）。
 * 自動で切り替えるのはやめ（2026-11-16 の検証で、合計点の差で切り替えても確認用で回収率が下がった）、目的に合わせて選べるように並べる。
 * ref = 過去の記録での成績（npm run check-bets の確認用：2025-10-25 以降の3,682レース）
 */
export interface MenuBet {
  /** 答え合わせの券種キー（sanrenpuku は以前からある「今の3連複」） */
  id: 'sanrenpuku' | 'sanrenpuku_axis1' | 'sanrenpuku_box5' | 'sanrentan_box4' | 'sanrentan_box5';
  group: '3連複' | '3連単';
  label: string;
  rule: string;
  purpose: string;
  /** 払戻の券種 */
  payoutType: 'sanrenpuku' | 'sanrentan';
  ordered: boolean;
  ref: { hit: number; recovery: number };
}

export const BET_MENU: MenuBet[] = [
  { id: 'sanrenpuku', group: '3連複', label: '3連複 ◎軸', rule: '◎軸・2頭目◯▲・3頭目◯▲△△（5点）', purpose: '回収率重視', payoutType: 'sanrenpuku', ordered: false, ref: { hit: 21.2, recovery: 72.9 } },
  { id: 'sanrenpuku_axis1', group: '3連複', label: '3連複 1頭軸流し', rule: 'データ1位を軸に2〜6位へ流し（10点）', purpose: '的中率重視', payoutType: 'sanrenpuku', ordered: false, ref: { hit: 29.6, recovery: 67.5 } },
  { id: 'sanrenpuku_box5', group: '3連複', label: '3連複 5頭ボックス', rule: 'データ1〜5位のボックス（10点）', purpose: '軸を決めにくいとき', payoutType: 'sanrenpuku', ordered: false, ref: { hit: 28.8, recovery: 69.6 } },
  { id: 'sanrentan_box4', group: '3連単', label: '3連単 4頭ボックス', rule: 'データ1〜4位のボックス（24点）', purpose: '着順を問わず高配当', payoutType: 'sanrentan', ordered: true, ref: { hit: 17.0, recovery: 63.2 } },
  { id: 'sanrentan_box5', group: '3連単', label: '3連単 5頭ボックス', rule: 'データ1〜5位のボックス（60点）', purpose: '的中率重視（点数が多い）', payoutType: 'sanrentan', ordered: true, ref: { hit: 28.8, recovery: 64.5 } },
];

/** 買い方の買い目。horses は印と順位（取消・除外の馬を含んでよい）。必要な馬がそろわなければ null */
export function menuTickets(id: MenuBet['id'], horses: { horseNumber: number | null; mark: string; rank: number }[]): number[][] | null {
  const valid = horses.filter((h): h is { horseNumber: number; mark: string; rank: number } => h.horseNumber !== null);
  const byRank = [...valid].sort((a, b) => a.rank - b.rank).map((h) => h.horseNumber);
  const of = (m: string) => valid.filter((h) => h.mark === m).map((h) => h.horseNumber);
  switch (id) {
    case 'sanrenpuku': {
      const [hon] = of('◎');
      const [tai] = of('◯');
      const [tan] = of('▲');
      const ren = of('△');
      if (hon === undefined || tai === undefined || tan === undefined || ren.length < 2) return null;
      const out: Trio[] = [];
      for (const b of [tai, tan]) for (const c of [tai, tan, ...ren]) if (b !== c) out.push(sortTrio(hon, b, c));
      return uniqTrios(out);
    }
    case 'sanrenpuku_axis1':
      return byRank.length >= 6 ? trioAxis1(byRank[0], byRank.slice(1, 6)) : null;
    case 'sanrenpuku_box5':
      return byRank.length >= 5 ? trioBox(byRank.slice(0, 5)) : null;
    case 'sanrentan_box4':
      return byRank.length >= 4 ? trifectaBox(byRank.slice(0, 4)) : null;
    case 'sanrentan_box5':
      return byRank.length >= 5 ? trifectaBox(byRank.slice(0, 5)) : null;
  }
}
