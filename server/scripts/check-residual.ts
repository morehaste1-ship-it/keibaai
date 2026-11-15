/**
 * 組み合わせ分析の候補が「アプリの点数」でも説明しきれないかを確かめる（読むだけ・DBに書き込まない）
 *
 * 実行: npm run residual
 *
 * 背景
 *  npm run combos は「人気」と比べた差を見た。アプリの点数には前走の着順（近走）などがすでに入っているので、
 *  人気との差をそのまま足すと二重に数えてしまう。そこで、結果のそろった予想の記録（1レース1件）について、
 *  今の配分で計算した合計点の順位から「この順位なら何%が3着内に来るか（期待）」を出し、
 *  候補ごとに実際との差が残るかを見る
 *
 * 期待の出し方: 合計点の順位（10位以下はまとめる）と頭数の帯ごとの3着内率（全レースの平均）
 * 期間の分け方: 配分の見直しと同じく、日付順で古い7割（学習用）・新しい3割（確認用）
 * 判定:
 *   残る     … 全体で |z| ≥ 2 かつ、古い7割・新しい3割の両方で差の向きが同じ
 *   弱い     … 向きは同じだが |z| < 2
 *   残らない … 向きがそろわない
 * 前走などの情報は、そのレースの日付より前の走（horse_runs）だけを使う
 */
import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { buildSamples } from '../services/weight-tuner';
import { activeWeights, normalizeGrade } from '../services/score-service';
import { COMPONENT_KEYS as ALL_KEYS } from '../../src/utils/dataScore';
// 「組み合わせ」の項目は、調べる対象そのものなので合計点から除く
const COMPONENT_KEYS = ALL_KEYS.filter((k) => k !== 'pattern');
import { classOf, intervalBand } from './check-combos';

const HOLDOUT_SHARE = 0.3;
const CLASS_RANK: Record<string, number> = { 新馬: 0, 未勝利: 0, '1勝': 1, '2勝': 2, '3勝': 3, OP: 4, G3: 5, G2: 6, G1: 7 };

/** 1頭分（候補の判定に使う情報と、点数の順位・結果） */
export interface Item {
  date: string;
  rank: number;
  heads: number;
  top3: boolean;
  /** 前走の着順（不明は null）。前走が無い（初出走）は prevExists = false */
  prevExists: boolean;
  prevFinish: number | null;
  prevStyle: string | null;
  intervalDays: number | null;
  distance: number;
  distChange: number | null;
  cls: string | null;
  prevCls: string | null;
  sex: string | null;
  age: number | null;
}

/** 調べる候補（npm run combos の結果から選んだもの） */
export const CANDIDATES: { group: string; label: string; test: (x: Item) => boolean }[] = [
  { group: '①前走の着順', label: '前走1着', test: (x) => x.prevFinish === 1 },
  { group: '①前走の着順', label: '前走2〜3着', test: (x) => x.prevFinish !== null && x.prevFinish >= 2 && x.prevFinish <= 3 },
  { group: '①前走の着順', label: '前走4〜5着', test: (x) => x.prevFinish !== null && x.prevFinish >= 4 && x.prevFinish <= 5 },
  { group: '①前走の着順', label: '前走6〜9着', test: (x) => x.prevFinish !== null && x.prevFinish >= 6 && x.prevFinish <= 9 },
  { group: '①前走の着順', label: '前走10着以下', test: (x) => x.prevFinish !== null && x.prevFinish >= 10 },
  { group: '②長い休み明け', label: '半年以上（全体）', test: (x) => x.intervalDays !== null && x.intervalDays >= 183 },
  { group: '②長い休み明け', label: '半年以上・1800m以下', test: (x) => x.intervalDays !== null && x.intervalDays >= 183 && x.distance <= 1800 },
  { group: '②長い休み明け', label: '半年以上・1勝クラス', test: (x) => x.intervalDays !== null && x.intervalDays >= 183 && x.cls === '1勝' },
  {
    group: '③牝馬の休み明け',
    label: '牝3〜4歳・10週〜半年',
    test: (x) => x.sex === '牝' && (x.age === 3 || x.age === 4) && x.intervalDays !== null && x.intervalDays >= 70 && x.intervalDays <= 182,
  },
  { group: '③牝馬の休み明け', label: '牝3歳・半年以上', test: (x) => x.sex === '牝' && x.age === 3 && x.intervalDays !== null && x.intervalDays >= 183 },
  { group: '④距離延長×前走逃げ', label: '距離延長（200m以上）・前走逃げ', test: (x) => x.distChange !== null && x.distChange >= 200 && x.prevStyle === '逃げ' },
  {
    group: '⑤昇級初戦',
    label: '昇級・前走1着',
    test: (x) => x.prevFinish === 1 && x.cls !== null && x.prevCls !== null && CLASS_RANK[x.cls] > CLASS_RANK[x.prevCls],
  },
  { group: '参考', label: '初出走・未勝利戦', test: (x) => !x.prevExists && x.cls === '未勝利' },
];

export interface ResidualRow {
  group: string;
  label: string;
  n: number;
  rate: number;
  exp: number;
  diff: number;
  z: number;
  trainDiff: number | null;
  holdDiff: number | null;
  holdN: number;
  verdict: '残る' | '弱い' | '残らない' | '件数不足';
}

/** 点数の順位から期待される3着内率を作り、候補ごとの差を出す（純粋な計算部分。テストしやすいよう分けている） */
export function analyzeResidual(items: Item[]): { rows: ResidualRow[]; splitDate: string | null } {
  if (items.length === 0) return { rows: [], splitDate: null };
  const headBand = (n: number) => (n <= 8 ? 0 : n <= 12 ? 1 : n <= 16 ? 2 : 3);
  const key = (x: Item) => headBand(x.heads) * 100 + Math.min(x.rank, 10);
  const base = new Map<number, { n: number; top3: number }>();
  for (const x of items) {
    const b = base.get(key(x)) ?? { n: 0, top3: 0 };
    b.n++;
    if (x.top3) b.top3++;
    base.set(key(x), b);
  }
  const expOf = (x: Item) => {
    const b = base.get(key(x))!;
    return b.top3 / b.n;
  };
  const dates = [...new Set(items.map((x) => x.date))].sort();
  const splitDate = dates[Math.floor(dates.length * (1 - HOLDOUT_SHARE))] ?? dates[dates.length - 1];

  const rows: ResidualRow[] = [];
  for (const c of CANDIDATES) {
    let n = 0, obs = 0, exp = 0, v = 0;
    const tr = { n: 0, obs: 0, exp: 0 };
    const ho = { n: 0, obs: 0, exp: 0 };
    for (const x of items) {
      if (!c.test(x)) continue;
      const e = expOf(x);
      n++;
      exp += e;
      v += e * (1 - e);
      if (x.top3) obs++;
      const part = x.date < splitDate ? tr : ho;
      part.n++;
      part.exp += e;
      if (x.top3) part.obs++;
    }
    const diff = n > 0 ? (obs - exp) / n : 0;
    const z = v > 0 ? (obs - exp) / Math.sqrt(v) : 0;
    const trainDiff = tr.n > 0 ? (tr.obs - tr.exp) / tr.n : null;
    const holdDiff = ho.n > 0 ? (ho.obs - ho.exp) / ho.n : null;
    let verdict: ResidualRow['verdict'];
    if (n < 50 || tr.n < 20 || ho.n < 20) verdict = '件数不足';
    else {
      const same = trainDiff !== null && holdDiff !== null && Math.sign(trainDiff) === Math.sign(diff) && Math.sign(holdDiff) === Math.sign(diff) && diff !== 0;
      verdict = !same ? '残らない' : Math.abs(z) >= 2 ? '残る' : '弱い';
    }
    rows.push({ group: c.group, label: c.label, n, rate: n ? obs / n : 0, exp: n ? exp / n : 0, diff, z, trainDiff, holdDiff, holdN: ho.n, verdict });
  }
  return { rows, splitDate };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function pt(x: number | null): string {
  return x === null ? '-' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pt`;
}
function pad(text: string, width: number): string {
  const w = [...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - w));
}

function main(): void {
  const db = openDatabase();
  try {
    const t0 = Date.now();
    const repo = new RaceRepository(db);
    const weights = activeWeights(repo) as Record<string, number>;
    const wSum = COMPONENT_KEYS.reduce((s, k) => s + Math.max(0, weights[k] ?? 0), 0);
    const samples = buildSamples(repo.listScoredRecordsWithOutcome());
    console.log(`[Residual] 結果のそろった予想の記録 ${samples.length.toLocaleString()} レース`);
    if (samples.length === 0 || wSum <= 0) return;

    const raceStmt = db.prepare('SELECT name, grade, distance, headcount FROM races WHERE race_key = ?');
    const entryStmt = db.prepare('SELECT netkeiba_horse_id AS hid, sex, age FROM entries WHERE race_key = ? AND horse_number = ?');
    const prevStmt = db.prepare(
      `SELECT date, venue_name, race_name, distance, finish_position, running_style FROM horse_runs
        WHERE horse_id = ? AND date < ? ORDER BY date DESC LIMIT 1`,
    );

    const hasRunsStmt = db.prepare('SELECT 1 FROM horse_runs WHERE horse_id = ? LIMIT 1');
    const items: Item[] = [];
    let noHorse = 0;
    for (const s of samples) {
      const race = raceStmt.get(s.raceKey) as { name: string; grade: string | null; distance: number; headcount: number | null } | undefined;
      if (!race) continue;
      const g = normalizeGrade(race.grade);
      const cls = g === 'G1' || g === 'G2' || g === 'G3' ? g : g === 'L' || g === 'OP' ? 'OP' : classOf(race.name ?? '');
      // 画面と同じ合計点（データ不足の項目は中立50点）で順位を付ける
      const ranked = s.horses
        .map((h) => {
          let t = 0;
          for (const k of COMPONENT_KEYS) t += (h.scores[k] ?? 50) * Math.max(0, weights[k] ?? 0);
          return { h, t: Math.round((t / wSum) * 10) / 10 };
        })
        .sort((a, b) => b.t - a.t || a.h.horseNumber - b.h.horseNumber);
      ranked.forEach(({ h }, i) => {
        const e = entryStmt.get(s.raceKey, h.horseNumber) as { hid: string | null; sex: string | null; age: number | null } | undefined;
        // 馬の成績ページが未取得の馬は、前走の有無が分からないので除く（初出走と取り違えないため）
        if (!e || !e.hid || !hasRunsStmt.get(e.hid)) {
          noHorse++;
          return;
        }
        const p = prevStmt.get(e.hid, s.date) as
          | { date: string; venue_name: string; race_name: string; distance: number | null; finish_position: number | null; running_style: string | null }
          | undefined;
        items.push({
          date: s.date,
          rank: i + 1,
          heads: s.horses.length,
          top3: h.finish <= 3,
          prevExists: !!p,
          prevFinish: p && p.finish_position && p.finish_position > 0 ? p.finish_position : null,
          prevStyle: p?.running_style ?? null,
          intervalDays: p ? Math.round((Date.parse(s.date) - Date.parse(p.date)) / 86400000) : null,
          distance: race.distance,
          distChange: p && p.distance ? race.distance - p.distance : null,
          cls,
          prevCls: p ? classOf(p.race_name ?? '') : null,
          sex: e.sex,
          age: e.age,
        });
      });
    }

    const { rows, splitDate } = analyzeResidual(items);
    console.log(
      `[Residual] 対象 ${items.length.toLocaleString()} 頭（馬の成績が未取得で除いた ${noHorse} 頭）・確認用は ${splitDate} 以降・合計点の配分は今の版`,
    );
    console.log('[Residual] 差 = 実際の3着内率 − 合計点の順位から期待される3着内率（アプリの点数で説明できない分）');
    console.log(`  ${pad('候補', 34)}${pad('頭数', 8)}${pad('3着内', 8)}${pad('期待', 8)}${pad('差', 9)}${pad('z', 7)}${pad('古い7割', 10)}${pad('新しい3割', 11)}判定`);
    let group = '';
    for (const r of rows) {
      if (r.group !== group) {
        console.log(`  ${r.group}`);
        group = r.group;
      }
      console.log(
        `    ${pad(r.label, 32)}${pad(String(r.n), 8)}${pad(pct(r.rate), 8)}${pad(pct(r.exp), 8)}${pad(pt(r.diff), 9)}${pad(`${r.z >= 0 ? '+' : ''}${r.z.toFixed(1)}`, 7)}${pad(pt(r.trainDiff), 10)}${pad(pt(r.holdDiff), 11)}${r.verdict}`,
      );
    }
    console.log(`[Residual] 所要 ${Math.round((Date.now() - t0) / 1000)}秒`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && /check-residual\.ts$/.test(process.argv[1])) main();
