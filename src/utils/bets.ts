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
