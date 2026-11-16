/**
 * 3連複・3連単ボックスの買い方を、過去の予想記録と払戻で比べる（読むだけ・DBに書き込まない）
 *
 * 実行: npm run check-bets
 *
 * 比べるもの（100円ずつ買ったとして）
 *  3連複：今の答え合わせの買い方（◎軸・2頭目◯▲・3頭目◯▲△△）／いつも2頭軸／いつも1頭軸／いつも5頭ボックス
 *          ／レースの形で選ぶ（2強→2頭軸・1強→1頭軸・混戦→ボックス。判定の点差を何通りも試す）／穴あり（◎＋中穴候補の2頭軸）
 *  3連単：4頭ボックス・5頭ボックス・今の「本命」
 * 見るもの：的中率・回収率・1レースの平均点数。日付順で古い7割（学習用）で点差の基準を選び、新しい3割（確認用）で確かめる。
 * 回収率は高配当1回で大きく動くので、確認用で「今の買い方」との回収率の差と、そのずれ（レースを選び直して測ったばらつき比）も出す
 */
import { openDatabase } from '../db/index';
import { RaceRepository, type PredictionRecord, type RaceOutcome } from '../db/repository';
import { planTrio, trifectaBox, trioAxis1, trioAxis2, trioBox, type Trio, type TrioRule } from '../../src/utils/bets';

const PRICE = 100;
/** 取消・除外（返還）。答え合わせ（review-service.ts）と同じ判定 */
const isScratched = (text: string | null | undefined) => /取消|除外/.test(text ?? '');
const HOLDOUT_SHARE = 0.3;
const PREFERENCE: Record<string, number> = { auto: 0, eve: 1, backtest: 2, manual: 3 };
const GAPS = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8];
const BASE_RULE: Omit<TrioRule, 'twoGap' | 'oneGap'> = { twoPartners: 5, onePartners: 5, boxSize: 5 };

interface RaceRow {
  raceKey: string;
  date: string;
  /** 合計点の高い順 */
  ranked: { horseNumber: number; total: number; mark: string; popularity: number | null; rank: number }[];
  scratched: Set<number>;
  trio: Map<string, number>;
  tri: Map<string, number>;
  honmei: { first: number; second: number; third: number }[] | null;
}

interface Result {
  races: number;
  hits: number;
  cost: number;
  payout: number;
  tickets: number;
  profits: number[];
  /** レースごとの払戻・費用（回収率の差のずれを、レースを選び直して計算するため） */
  pays: number[];
  costs: number[];
}

/** 1レースの買い目の収支（取消を含む買い目は返還＝費用に入れない） */
function settle(r: RaceRow, tickets: number[][], ordered: boolean): { cost: number; payout: number; hit: boolean } {
  let cost = 0;
  let payout = 0;
  let hit = false;
  const table = ordered ? r.tri : r.trio;
  for (const t of tickets) {
    if (t.some((n) => r.scratched.has(n))) continue;
    cost += PRICE;
    const key = (ordered ? t : [...t].sort((a, b) => a - b)).join('-');
    const p = table.get(key);
    if (p) {
      payout += p;
      hit = true;
    }
  }
  return { cost, payout, hit };
}

function evaluate(rows: RaceRow[], make: (r: RaceRow) => number[][] | null, ordered: boolean): Result {
  const res: Result = { races: 0, hits: 0, cost: 0, payout: 0, tickets: 0, profits: [], pays: [], costs: [] };
  for (const r of rows) {
    const t = make(r);
    if (!t || t.length === 0) {
      res.profits.push(0);
      res.pays.push(0);
      res.costs.push(0);
      continue;
    }
    const s = settle(r, t, ordered);
    res.pays.push(s.payout);
    res.costs.push(s.cost);
    if (s.cost === 0) {
      res.profits.push(0);
      continue;
    }
    res.races++;
    res.tickets += t.length;
    res.cost += s.cost;
    res.payout += s.payout;
    if (s.hit) res.hits++;
    res.profits.push(s.payout - s.cost);
  }
  return res;
}

const roi = (x: Result) => (x.cost > 0 ? (x.payout / x.cost) * 100 : 0);
function line(label: string, x: Result): string {
  return `${label.padEnd(1)}：${x.races}R・的中率 ${x.races ? ((x.hits / x.races) * 100).toFixed(1) : '-'}%・回収率 ${roi(x).toFixed(1)}%・平均 ${x.races ? (x.tickets / x.races).toFixed(1) : '-'}点`;
}
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 回収率の差（a − b）と、そのずれ。点数の違う買い方でも比べられるよう、収支ではなく回収率で比べる。
 * ずれは、同じレースの組を選び直して（1000回）差のばらつきを測ったもの（差 ÷ ばらつき）
 */
function diff(a: Result, b: Result): string {
  const n = a.pays.length;
  if (n === 0) return '-';
  const ratio = (idx: number[] | null, x: Result) => {
    let p = 0;
    let c = 0;
    if (idx) for (const i of idx) { p += x.pays[i]; c += x.costs[i]; }
    else { p = x.pays.reduce((s, v) => s + v, 0); c = x.costs.reduce((s, v) => s + v, 0); }
    return c > 0 ? (p / c) * 100 : 0;
  };
  const d0 = ratio(null, a) - ratio(null, b);
  const rnd = mulberry32(12345);
  const ds: number[] = [];
  for (let k = 0; k < 1000; k++) {
    const idx = Array.from({ length: n }, () => Math.floor(rnd() * n));
    ds.push(ratio(idx, a) - ratio(idx, b));
  }
  const mean = ds.reduce((s, v) => s + v, 0) / ds.length;
  const sd = Math.sqrt(ds.reduce((s, v) => s + (v - mean) ** 2, 0) / (ds.length - 1));
  return `回収率 ${d0 >= 0 ? '+' : ''}${d0.toFixed(1)}pt（ずれ ${sd > 0 ? (d0 / sd).toFixed(2) : '-'}）`;
}

/** 今の答え合わせの3連複（◎軸・2頭目◯▲・3頭目◯▲△△） */
function currentTrio(r: RaceRow): number[][] | null {
  const of = (m: string) => r.ranked.filter((h) => h.mark === m).map((h) => h.horseNumber);
  const [hon] = of('◎');
  const [tai] = of('◯');
  const [tan] = of('▲');
  const ren = of('△');
  if (hon === undefined || tai === undefined || tan === undefined || ren.length < 2) return null;
  const out: Trio[] = [];
  const seen = new Set<string>();
  for (const b of [tai, tan])
    for (const c of [tai, tan, ...ren]) {
      if (b === c) continue;
      const t = [hon, b, c].sort((x, y) => x - y) as Trio;
      if (!seen.has(t.join('-'))) {
        seen.add(t.join('-'));
        out.push(t);
      }
    }
  return out;
}

/** 中穴候補（◎◯▲以外・4〜9番人気・データの順位が人気より3つ以上高い。trifecta.ts と同じ条件）の最上位 */
function midOf(r: RaceRow): number | null {
  const m = r.ranked
    .filter((h) => !['◎', '◯', '▲'].includes(h.mark) && h.popularity !== null && h.popularity >= 4 && h.popularity <= 9 && h.rank <= h.popularity - 3)
    .sort((a, b) => a.rank - b.rank)[0];
  return m ? m.horseNumber : null;
}

function main(): void {
  const db = openDatabase();
  try {
    const t0 = Date.now();
    const repo = new RaceRepository(db);
    const byRace = new Map<string, { record: PredictionRecord; outcome: RaceOutcome; date: string }>();
    for (const x of repo.listScoredRecordsWithOutcome()) {
      const prev = byRace.get(x.record.raceKey);
      if (!prev || (PREFERENCE[x.record.source] ?? 9) < (PREFERENCE[prev.record.source] ?? 9)) byRace.set(x.record.raceKey, x);
    }
    const rows: RaceRow[] = [];
    let noPayout = 0;
    for (const { record, outcome, date } of byRace.values()) {
      const trioPay = outcome.payouts?.sanrenpuku;
      const triPay = outcome.payouts?.sanrentan ?? outcome.trifecta;
      if (!trioPay || trioPay.length === 0 || !triPay || triPay.length === 0) {
        noPayout++;
        continue;
      }
      const ranked = record.marks
        .filter((m) => typeof m.horseNumber === 'number')
        .map((m) => ({ horseNumber: m.horseNumber, total: m.total, mark: m.mark, popularity: m.popularity, rank: m.rank }))
        .sort((a, b) => a.rank - b.rank);
      if (ranked.length < 7) continue;
      rows.push({
        raceKey: record.raceKey,
        date,
        ranked,
        // 取消・除外だけを返還にする（競走中止は返還されない。答え合わせと同じ判定）
        scratched: new Set(outcome.finishes.filter((f) => isScratched(f.finishText)).map((f) => f.horseNumber)),
        trio: new Map(trioPay.map((p) => [[...p.combo].sort((a, b) => a - b).join('-'), p.payout])),
        tri: new Map(triPay.map((p) => [p.combo.join('-'), p.payout])),
        honmei: record.plans.find((p) => p.kind === '本命' && p.available)?.tickets ?? null,
      });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.raceKey.localeCompare(b.raceKey));
    const holdN = Math.round(rows.length * HOLDOUT_SHARE);
    const train = rows.slice(0, rows.length - holdN);
    const hold = rows.slice(rows.length - holdN);
    console.log(`[Bets] 対象 ${rows.length}レース（3連複・3連単の払戻がそろったもの。払戻なしで除外 ${noPayout}レース）・確認用は ${hold[0]?.date ?? '-'} 以降の ${holdN}レース`);
    if (rows.length < 100) {
      console.log('[Bets] レースが少ないため判定しません');
      return;
    }

    const n = (r: RaceRow) => r.ranked.map((h) => h.horseNumber);
    const fixed: { label: string; make: (r: RaceRow) => number[][] | null; ordered: boolean }[] = [
      { label: '3連複 今の買い方（◎軸・◯▲・◯▲△△）', make: currentTrio, ordered: false },
      { label: '3連複 いつも2頭軸（1・2位→3〜7位）', make: (r) => trioAxis2(n(r)[0], n(r)[1], n(r).slice(2, 7)), ordered: false },
      { label: '3連複 いつも1頭軸（1位→2〜6位）', make: (r) => trioAxis1(n(r)[0], n(r).slice(1, 6)), ordered: false },
      { label: '3連複 いつも5頭ボックス', make: (r) => trioBox(n(r).slice(0, 5)), ordered: false },
      { label: '3連単 4頭ボックス', make: (r) => trifectaBox(n(r).slice(0, 4)), ordered: true },
      { label: '3連単 5頭ボックス', make: (r) => trifectaBox(n(r).slice(0, 5)), ordered: true },
      { label: '3連単 今の「本命」', make: (r) => (r.honmei ? r.honmei.map((t) => [t.first, t.second, t.third]) : null), ordered: true },
    ];
    const baseTrain = evaluate(train, currentTrio, false);
    const baseHold = evaluate(hold, currentTrio, false);
    for (const [label, part, base] of [
      ['学習用（古い7割）', train, baseTrain],
      ['確認用（新しい3割）', hold, baseHold],
    ] as const) {
      console.log(`\n[Bets] ${label}`);
      for (const f of fixed) {
        const x = evaluate(part, f.make, f.ordered);
        console.log(`[Bets]   ${line(f.label, x)}` + (f.ordered || f.make === currentTrio ? '' : `　今の3連複との差 ${diff(x, base)}`));
      }
    }

    // レースの形で選ぶ：点差の基準を学習用で選ぶ（回収率が最も高いもの・的中率が最も高いもの）
    const grid: { rule: TrioRule; tr: Result; ho: Result }[] = [];
    for (const twoGap of GAPS)
      for (const oneGap of GAPS) {
        const rule: TrioRule = { ...BASE_RULE, twoGap, oneGap };
        const make = (r: RaceRow) => planTrio(r.ranked, rule)?.tickets ?? null;
        grid.push({ rule, tr: evaluate(train, make, false), ho: evaluate(hold, make, false) });
      }
    const shapeCount = (rule: TrioRule, part: RaceRow[]) => {
      const c: Record<string, number> = { '2強': 0, '1強': 0, 混戦: 0 };
      for (const r of part) {
        const p = planTrio(r.ranked, rule);
        if (p) c[p.shape]++;
      }
      return `2強${c['2強']}・1強${c['1強']}・混戦${c['混戦']}`;
    };
    const show = (title: string, best: { rule: TrioRule; tr: Result; ho: Result }) => {
      console.log(`\n[Bets] レースの形で選ぶ（${title}）：2強＝2位と3位の差 ${best.rule.twoGap}点以上・1強＝1位と2位の差 ${best.rule.oneGap}点以上`);
      console.log(`[Bets]   学習用 ${line('', best.tr)}（${shapeCount(best.rule, train)}）`);
      console.log(`[Bets]   確認用 ${line('', best.ho)}（${shapeCount(best.rule, hold)}）　今の3連複との差 ${diff(best.ho, baseHold)}`);
    };
    show('学習用の回収率が最も高い基準', [...grid].sort((a, b) => roi(b.tr) - roi(a.tr))[0]);
    show('学習用の的中率が最も高い基準', [...grid].sort((a, b) => b.tr.hits / Math.max(1, b.tr.races) - a.tr.hits / Math.max(1, a.tr.races) || roi(b.tr) - roi(a.tr))[0]);

    // 穴あり：中穴候補がいるレースだけで、◎＋中穴候補の2頭軸（相手は上位4頭から）と、上の「回収率が最も高い基準」を比べる
    const bestRule = [...grid].sort((a, b) => roi(b.tr) - roi(a.tr))[0].rule;
    for (const [label, part] of [
      ['学習用', train],
      ['確認用', hold],
    ] as const) {
      const withMid = part.filter((r) => midOf(r) !== null);
      const midMake = (r: RaceRow) => {
        const m = midOf(r)!;
        const top = n(r)[0];
        return trioAxis2(top, m, n(r).filter((x) => x !== m && x !== top).slice(0, 4));
      };
      const a = evaluate(withMid, midMake, false);
      const b = evaluate(withMid, (r) => planTrio(r.ranked, bestRule)?.tickets ?? null, false);
      console.log(`\n[Bets] 穴あり（中穴候補がいる ${withMid.length}レース・${label}）`);
      console.log(`[Bets]   ◎＋中穴候補の2頭軸 ${line('', a)}　形で選ぶとの差 ${diff(a, b)}`);
      console.log(`[Bets]   形で選ぶ           ${line('', b)}`);
    }
    console.log('\n[Bets] 見方：回収率は高配当1回で大きく動きます。確認用で「今の3連複との差」（回収率の差）がプラスで、ずれが1.65以上なら偶然とは言いにくい改善です');
    console.log(`[Bets] 所要 ${Math.round((Date.now() - t0) / 1000)}秒`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err: any) {
  console.error('[Bets] 失敗:', err?.message ?? err);
  process.exitCode = 1;
}
