/**
 * 近走のクラス補正の掛け方を比べる（読むだけ・DBに書き込まない）
 *
 * 実行: npx tsx server/scripts/check-class.ts
 *
 * 比べるもの
 *  ① 補正なし        … 着順点だけ
 *  ② 1走ごとに頭打ち … 重賞・L・OPに上乗せ。ただし1走100点まで（G1の1着も未勝利戦の1着も100点）
 *  ③ 合計で頭打ち    … 1走は100点を超えてよい（G1の1着=120点）。近走の合計だけ100点まで
 *
 * 方法：結果のそろった予想の記録（1レース1件）について、出走馬の近走の点数だけを3通りに計算し直し、
 * 今の配分での成績（3着以内の馬が上位5頭に入った割合）と、1レースずつの勝敗を比べる。
 * 配分の見直しと同じく、新しい3割のレース（確認用）での結果を主に見る。過去走はレース日より前の走だけを使う
 */
import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { buildSamples, evaluateWeights, metricsRaw, type TuneSample } from '../services/weight-tuner';
import { activeWeights, recentScoreOf, type RecentClassMode } from '../services/score-service';

const MODES: { mode: RecentClassMode; label: string }[] = [
  { mode: 'none', label: '①補正なし' },
  { mode: 'capRun', label: '②1走ごとに頭打ち' },
  { mode: 'capTotal', label: '③合計で頭打ち' },
];
const HOLDOUT_SHARE = 0.3;

function pad(text: string, width: number): string {
  const w = [...text].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - w));
}

function main(): void {
  const db = openDatabase();
  try {
    const repo = new RaceRepository(db);
    const weights = activeWeights(repo);
    const base = buildSamples(repo.listScoredRecordsWithOutcome());
    console.log(`[Class] 対象 ${base.length}レース・近走の配分 ${weights.recent ?? 0}%`);
    if (base.length === 0) return;

    // 近走の点数だけを3通りに計算し直したデータを作る
    const sets: Record<RecentClassMode, TuneSample[]> = { none: [], capRun: [], capTotal: [] };
    let horses = 0;
    let changed = 0; // ②と③で近走の点数が違う馬
    let boosted = 0; // 補正が付いた馬（①と③が違う）
    const stored: Record<RecentClassMode, number> = { none: 0, capRun: 0, capTotal: 0 }; // 保存済みの点数と一致した馬
    for (const smp of base) {
      const race = repo.getRace(smp.raceKey);
      if (!race) continue;
      const idByNumber = new Map(repo.getEntries(smp.raceKey).map((e) => [e.horseNumber, e.netkeibaHorseId]));
      const recents = smp.horses.map((h) => {
        const id = idByNumber.get(h.horseNumber);
        const runs = id ? repo.listHorseRuns(id).filter((r) => r.date < race.date) : [];
        return Object.fromEntries(MODES.map((m) => [m.mode, recentScoreOf(runs, m.mode)])) as Record<RecentClassMode, number | null>;
      });
      smp.horses.forEach((h, i) => {
        horses++;
        if (recents[i].capRun !== recents[i].capTotal) changed++;
        if (recents[i].none !== recents[i].capTotal) boosted++;
        for (const m of MODES) if ((h.scores.recent ?? null) === recents[i][m.mode]) stored[m.mode]++;
      });
      for (const m of MODES) {
        sets[m.mode].push({ ...smp, horses: smp.horses.map((h, i) => ({ ...h, scores: { ...h.scores, recent: recents[i][m.mode] } })) });
      }
    }
    const n = sets.none.length;
    const pct = (v: number) => `${Math.round((v / Math.max(1, horses)) * 1000) / 10}%`;
    console.log(`[Class] 出走馬 ${horses}頭のうち、補正が付く馬 ${boosted}頭（${pct(boosted)}）・②と③で点数が違う馬 ${changed}頭（${pct(changed)}）`);
    console.log(`[Class] 保存済みの近走の点数との一致：①${pct(stored.none)}・②${pct(stored.capRun)}・③${pct(stored.capTotal)}（いま記録に入っている計算がどれかの目安）`);

    const holdN = Math.round(n * HOLDOUT_SHARE);
    const parts: { label: string; from: number; to: number }[] = [
      { label: `確認用（新しい${holdN}レース）`, from: n - holdN, to: n },
      { label: `全レース（${n}レース）`, from: 0, to: n },
    ];
    const wl = (a: TuneSample[], b: TuneSample[]) => {
      // 同じ配分で、データ（近走の点数）だけが違う2つを1レースずつ比べる
      let win = 0;
      let lose = 0;
      for (let i = 0; i < a.length; i++) {
        const d = metricsRaw([b[i]], weights).top3InTop5 - metricsRaw([a[i]], weights).top3InTop5;
        if (d > 0) win++;
        else if (d < 0) lose++;
      }
      const dec = win + lose;
      return { win, lose, z: dec > 0 ? (win - dec / 2) / Math.sqrt(dec / 4) : 0 };
    };
    for (const part of parts) {
      const cut = (m: RecentClassMode) => sets[m].slice(part.from, part.to);
      console.log(`\n[Class] ${part.label}`);
      const baseRate = metricsRaw(cut('none'), weights).top3InTop5;
      for (const m of MODES) {
        const rate = metricsRaw(cut(m.mode), weights).top3InTop5;
        const r = m.mode === 'none' ? null : wl(cut('none'), cut(m.mode));
        console.log(
          `[Class]   ${pad(m.label, 20)}${evaluateWeights(cut(m.mode), weights).top3InTop5.toFixed(1).padStart(6)}%` +
            (r ? `　①との差 ${(rate - baseRate >= 0 ? '+' : '') + (rate - baseRate).toFixed(2)}ポイント・${r.win}勝${r.lose}敗（ずれ ${r.z.toFixed(2)}）` : ''),
        );
      }
      const r23 = wl(cut('capRun'), cut('capTotal'));
      const d23 = metricsRaw(cut('capTotal'), weights).top3InTop5 - metricsRaw(cut('capRun'), weights).top3InTop5;
      console.log(`[Class]   ③と②の直接比較：${(d23 >= 0 ? '+' : '') + d23.toFixed(2)}ポイント・${r23.win}勝${r23.lose}敗（ずれ ${r23.z.toFixed(2)}）`);
    }
    console.log('\n[Class] 見方：「ずれ」が1.65以上なら、偶然とは言いにくい改善です。確認用の結果を主に見てください');
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err: any) {
  console.error('[Class] 失敗:', err?.message ?? err);
  process.exitCode = 1;
}
