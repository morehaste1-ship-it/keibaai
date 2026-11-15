/**
 * 組み合わせ補正を点数に入れたら当たりが増えるかを確かめる（読むだけ・DBに書き込まない・予想の記録も変えない）
 *
 * 実行: npm run combo-adjust
 *
 * 方法
 *  結果のそろった予想の記録（1レース1件）について、各馬の「組み合わせ補正」の点数を計算する
 *  （server/services/combo-adjust.ts。補正の大きさは、そのレースの月より前の記録だけで計算するので未来の結果は混ざらない）。
 *  今の配分（組み合わせを除く）に、組み合わせ補正を 0・3・5・10・13・15・20 の配分で足した場合の成績
 *  （3着以内の馬が合計点の上位5頭に入った割合・1位の馬の3着内率）と、1レースずつの勝敗（補正なしとの比較）を出す。
 *  配分の見直しと同じく、新しい3割のレース（確認用）の結果を主に見る
 */
import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { buildSamples, type TuneSample } from '../services/weight-tuner';
import { activeWeights } from '../services/score-service';
import { COMPONENT_KEYS as ALL_KEYS } from '../../src/utils/dataScore';
// 「組み合わせ」の項目は、調べる対象そのものなので合計点から除く
const COMPONENT_KEYS = ALL_KEYS.filter((k) => k !== 'pattern');
import {
  COMBO_MIN_ITEMS,
  comboCellsOf,
  comboScoreOf,
  expectationTable,
  fitComboAdjust,
  type ComboAdjust,
  type ComboCells,
} from '../services/combo-adjust';

const HOLDOUT_SHARE = 0.3;
const TOP_N = 5;
const COMBO_WEIGHTS = [0, 3, 5, 10, 13, 15, 20];

interface HorseRow {
  horseNumber: number;
  base: number;
  rank: number;
  heads: number;
  top3: boolean;
  finish: number;
  cells: ComboCells;
  combo: number;
  hasData: boolean;
}
interface RaceRow {
  raceKey: string;
  date: string;
  horses: HorseRow[];
}

/** 配分 wc で組み合わせ補正を足したときの、1レースの「上位5頭に入った3着内の頭数」と「1位が3着内か」 */
function evalRace(r: RaceRow, wSum: number, wc: number): { hits: number; first: boolean; top3: number } {
  const ranked = r.horses
    .map((h) => ({ h, t: Math.round(((h.base * wSum + h.combo * wc) / (wSum + wc)) * 10) / 10 }))
    .sort((a, b) => b.t - a.t || a.h.horseNumber - b.h.horseNumber);
  return {
    hits: ranked.slice(0, TOP_N).filter((x) => x.h.finish <= 3).length,
    first: !!ranked[0] && ranked[0].h.finish <= 3,
    top3: r.horses.filter((h) => h.finish <= 3).length,
  };
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
    const samples: TuneSample[] = buildSamples(repo.listScoredRecordsWithOutcome());
    console.log(`[ComboAdj] 結果のそろった予想の記録 ${samples.length.toLocaleString()} レース`);
    if (samples.length === 0 || wSum <= 0) return;

    const raceStmt = db.prepare('SELECT name, grade, distance FROM races WHERE race_key = ?');
    const entryStmt = db.prepare('SELECT netkeiba_horse_id AS hid, sex, age FROM entries WHERE race_key = ? AND horse_number = ?');
    const prevStmt = db.prepare(
      `SELECT date, race_name, distance, finish_position, running_style FROM horse_runs WHERE horse_id = ? AND date < ? ORDER BY date DESC LIMIT 1`,
    );
    const hasRunsStmt = db.prepare('SELECT 1 FROM horse_runs WHERE horse_id = ? LIMIT 1');

    // 1) 各馬の区分と、今の配分での合計点・順位
    const races: RaceRow[] = [];
    for (const s of samples) {
      const race = raceStmt.get(s.raceKey) as { name: string; grade: string | null; distance: number } | undefined;
      if (!race) continue;
      const scored = s.horses
        .map((h) => {
          let t = 0;
          for (const k of COMPONENT_KEYS) t += (h.scores[k] ?? 50) * Math.max(0, weights[k] ?? 0);
          return { h, base: t / wSum };
        })
        .sort((a, b) => Math.round(b.base * 10) - Math.round(a.base * 10) || a.h.horseNumber - b.h.horseNumber);
      const horses: HorseRow[] = scored.map(({ h, base }, i) => {
        const e = entryStmt.get(s.raceKey, h.horseNumber) as { hid: string | null; sex: string | null; age: number | null } | undefined;
        let cells: ComboCells = [null, null, null];
        // 成績ページが未取得の馬は区分なし（初出走と取り違えないため）
        if (e?.hid && hasRunsStmt.get(e.hid)) {
          const p = prevStmt.get(e.hid, s.date) as
            | { date: string; race_name: string | null; distance: number | null; finish_position: number | null; running_style: string | null }
            | undefined;
          cells = comboCellsOf({
            date: s.date,
            distance: race.distance,
            raceName: race.name ?? '',
            grade: race.grade,
            sex: e.sex,
            age: e.age,
            prev: p ? { date: p.date, raceName: p.race_name, distance: p.distance, finish: p.finish_position, style: p.running_style } : null,
          });
        }
        return { horseNumber: h.horseNumber, base, rank: i + 1, heads: s.horses.length, top3: h.finish <= 3, finish: h.finish, cells, combo: 50, hasData: false };
      });
      races.push({ raceKey: s.raceKey, date: s.date, horses });
    }

    // 2) 月ごとに、それより前の記録だけで補正を計算して点数を付ける
    const months = [...new Set(races.map((r) => r.date.slice(0, 7)))].sort();
    const past: HorseRow[] = [];
    let lastTable: ComboAdjust | null = null;
    let withAdj = 0;
    let horsesTotal = 0;
    for (const m of months) {
      let table: ComboAdjust | null = null;
      if (past.length >= COMBO_MIN_ITEMS) {
        const exp = expectationTable(past);
        table = fitComboAdjust(past.map((h) => ({ cells: h.cells, exp: exp(h.rank, h.heads), top3: h.top3 })));
        lastTable = table;
      }
      const inMonth = races.filter((r) => r.date.slice(0, 7) === m);
      for (const r of inMonth)
        for (const h of r.horses) {
          const sc = comboScoreOf(h.cells, table);
          h.combo = sc.score;
          h.hasData = sc.hasData;
          horsesTotal++;
          if (sc.hasData) withAdj++;
        }
      for (const r of inMonth) past.push(...r.horses);
    }
    console.log(
      `[ComboAdj] 対象 ${horsesTotal.toLocaleString()} 頭・補正が付いた馬 ${withAdj.toLocaleString()} 頭（${((withAdj / Math.max(1, horsesTotal)) * 100).toFixed(1)}%）・今の配分の合計 ${wSum}`,
    );
    if (lastTable) {
      console.log('[ComboAdj] 最新の補正（3着内率の差。点数は 10ポイントあたり 20点）:');
      for (const [c, a] of [...lastTable.entries()].sort((x, y) => x[1].adj - y[1].adj)) {
        console.log(`  ${pad(c, 34)}${pad(`${a.adj >= 0 ? '+' : ''}${(a.adj * 100).toFixed(1)}pt`, 10)}${a.n.toLocaleString()}頭`);
      }
    }

    // 3) 配分ごとの成績
    const holdN = Math.round(races.length * HOLDOUT_SHARE);
    const parts = [
      { label: `確認用（新しい${holdN}レース・${races[races.length - holdN]?.date ?? '-'} 以降）`, list: races.slice(races.length - holdN) },
      { label: `全レース（${races.length}レース）`, list: races },
    ];
    for (const part of parts) {
      console.log(`\n[ComboAdj] ${part.label}`);
      const base = part.list.map((r) => evalRace(r, wSum, 0));
      const baseHits = base.reduce((s, x) => s + x.hits, 0);
      const top3Total = base.reduce((s, x) => s + x.top3, 0);
      for (const wc of COMBO_WEIGHTS) {
        const res = part.list.map((r) => evalRace(r, wSum, wc));
        const hits = res.reduce((s, x) => s + x.hits, 0);
        const first = res.filter((x) => x.first).length;
        let win = 0;
        let lose = 0;
        res.forEach((x, i) => {
          if (x.hits > base[i].hits) win++;
          else if (x.hits < base[i].hits) lose++;
        });
        const dec = win + lose;
        const z = dec > 0 ? (win - dec / 2) / Math.sqrt(dec / 4) : 0;
        const rate = (hits / Math.max(1, top3Total)) * 100;
        const diff = ((hits - baseHits) / Math.max(1, top3Total)) * 100;
        console.log(
          `[ComboAdj]   配分 ${String(wc).padStart(2)}：上位5頭に3着内 ${rate.toFixed(2)}%` +
            `・1位の3着内率 ${((first / Math.max(1, res.length)) * 100).toFixed(1)}%` +
            (wc === 0 ? '（補正なし）' : `　差 ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}ポイント・${win}勝${lose}敗（ずれ ${z.toFixed(2)}）`),
        );
      }
    }
    console.log('\n[ComboAdj] 見方：確認用で差がプラス、かつ「ずれ」が1.65以上なら、偶然とは言いにくい改善です');
    console.log(`[ComboAdj] 所要 ${Math.round((Date.now() - t0) / 1000)}秒`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err: any) {
  console.error('[ComboAdj] 失敗:', err?.message ?? err);
  process.exitCode = 1;
}
