/**
 * 「近走にクラス補正を入れたら、過去レースで成績が上がるか」を測る（読むだけ・DBに書き込まない）
 *
 * 実行: npx tsx server/scripts/check-class-recent.ts
 *       npx tsx server/scripts/check-class-recent.ts --race 20261108-05-11   … そのレースだけ馬ごとに詳しく出す
 *
 * 背景
 *  - 今の近走は着順だけの点数（1着100・2着80・3着65・4〜5着45・6〜9着25・10着以下10、新しい順に重み5:4:3:2:1）。
 *    G1の6着も条件戦の6着も同じ25点になる（2026/11/8 アルゼンチン共和国杯で
 *    宝塚記念6着のファミリータイムを拾えなかった反省）。
 *  - クラス補正の候補：各走の着順点に、そのレースのグレードぶんの上乗せをする（100点で頭打ち）。
 *    上乗せ（倍率1.0）: G1 +20 / G2 +15 / G3 +10 / L・OP +5 / それ以外 +0
 *    倍率 0.5 / 1.0 / 1.5 の3通りを並べて測り、効き方（用量反応）を見る。
 *
 * グレードの取り方
 *  - 本番に適用済みの方式に合わせ、過去走のレース名の末尾（例「毎日王冠(GII)」）から読む
 *    （score-service の gradeFromRaceName をそのまま使う）。
 *  - 監査として、旧方式（races テーブルを (日付・競馬場・レース番号) で引く）との
 *    カバー率の差と、両方で判定できた走での一致率・食い違いの例も出す。
 *
 * 数字の読み方（weight-tuner と同じ物差し・同じ採用基準）
 *  - 物差し：3着以内の馬が合計点の上位5頭に入った割合（%）。配分は今の採用中の配分を使う。
 *  - 日付順に古い7割＝学習用、新しい3割＝確認用に分ける。
 *  - 採用の目安：確認用で成績がプラス、かつ1レースずつの勝敗の z が 1.645 以上（符号検定・片側5%）、
 *    決着したレースが30以上。今の配分の自動見直しと同じ基準。
 *  - このスクリプトは合計点の「近走」だけを差し替えて比べる。DB・記録は一切変更しない。
 */
import { openDatabase } from '../db/index';
import { RaceRepository, type PredictionRecord, type RaceOutcome } from '../db/repository';
import { COMPONENT_KEYS } from '../../src/utils/dataScore';
import { finishPoints, activeWeights, gradeFromRaceName, normalizeGrade as normalizeGradeProd, GRADE_BONUS } from '../services/score-service';
import { venueCodeFromName, makeRaceKey } from '../domain/keys';
import type { VenueCode } from '../domain/types';

const TOP_N = 5;
const RECENT_WEIGHTS = [5, 4, 3, 2, 1];
const PREFERENCE: Record<string, number> = { auto: 0, eve: 1, backtest: 2, manual: 3 };
const SIGN_Z = 1.645;
const MIN_DECIDED = 30;

/** グレード表記（GI/G1 など）をそろえる。重賞・L・OP 以外は null（本体の normalizeGrade と同じ） */
const normalizeGrade = normalizeGradeProd;

/** 倍率1.0のときの上乗せ点（本体の GRADE_BONUS と同じ値を使う） */
const BONUS: Record<string, number> = GRADE_BONUS;
const SCALES = [0.5, 1.0, 1.5];

type Weights = Record<string, number>;

interface HorseCalc {
  horseNumber: number;
  horseName: string;
  finish: number;
  scores: Record<string, number | null>;
  recentOld: number | null;
  recentNew: Map<number, number | null>; // scale -> 新しい近走点
}

interface Sample {
  raceKey: string;
  date: string;
  horses: HorseCalc[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 記録に保存された項目点から合計点を出す（weight-tuner と同じ計算） */
function totalOf(scores: Record<string, number | null>, w: Weights, recentOverride?: number | null): number {
  const wSum = COMPONENT_KEYS.reduce((s, k) => s + Math.max(0, w[k] ?? 0), 0);
  if (wSum === 0) return 0;
  let s = 0;
  for (const k of COMPONENT_KEYS) {
    const v = k === 'recent' && recentOverride !== undefined ? recentOverride : scores[k];
    s += (v ?? 50) * Math.max(0, w[k] ?? 0);
  }
  return Math.round((s / wSum) * 10) / 10;
}

function hitsOf(smp: Sample, w: Weights, scale: number | null): number {
  const ranked = smp.horses
    .map((h) => ({ h, t: totalOf(h.scores, w, scale === null ? undefined : (h.recentNew.get(scale) ?? undefined)) }))
    .sort((a, b) => b.t - a.t || a.h.horseNumber - b.h.horseNumber);
  return ranked.slice(0, TOP_N).filter((x) => x.h.finish <= 3).length;
}

function metrics(samples: Sample[], w: Weights, scale: number | null) {
  let hit = 0;
  let top3Total = 0;
  let firstHit = 0;
  for (const smp of samples) {
    const ranked = smp.horses
      .map((h) => ({ h, t: totalOf(h.scores, w, scale === null ? undefined : (h.recentNew.get(scale) ?? undefined)) }))
      .sort((a, b) => b.t - a.t || a.h.horseNumber - b.h.horseNumber);
    const top3 = smp.horses.filter((h) => h.finish <= 3);
    top3Total += top3.length;
    hit += ranked.slice(0, TOP_N).filter((x) => x.h.finish <= 3).length;
    if (ranked[0] && ranked[0].h.finish <= 3) firstHit++;
  }
  return {
    top3InTop5: top3Total > 0 ? Math.round((hit / top3Total) * 1000) / 10 : 0,
    firstTop3: samples.length > 0 ? Math.round((firstHit / samples.length) * 1000) / 10 : 0,
    races: samples.length,
  };
}

function winLoss(samples: Sample[], w: Weights, scale: number) {
  let win = 0;
  let lose = 0;
  for (const smp of samples) {
    const d = hitsOf(smp, w, scale) - hitsOf(smp, w, null);
    if (d > 0) win++;
    else if (d < 0) lose++;
  }
  const n = win + lose;
  return { win, lose, z: n > 0 ? (win - n / 2) / Math.sqrt(n / 4) : 0 };
}

function main(): void {
  const onlyRace = arg('race');
  const db = openDatabase();
  try {
    const repo = new RaceRepository(db);
    const weights = activeWeights(repo);
    console.log(`[Class] 今の配分: 近走 ${weights.recent ?? 0}%（合計点はこの配分で計算）`);

    // 1レース1記録（当日 > 前日 > 検証用 > 手動）に絞る
    const rows = repo.listScoredRecordsWithOutcome();
    const byRace = new Map<string, { record: PredictionRecord; outcome: RaceOutcome; date: string }>();
    for (const r of rows) {
      if (onlyRace && r.record.raceKey !== onlyRace) continue;
      const prev = byRace.get(r.record.raceKey);
      if (!prev || (PREFERENCE[r.record.source] ?? 9) < (PREFERENCE[prev.record.source] ?? 9)) byRace.set(r.record.raceKey, r);
    }

    const gradeCache = new Map<string, { found: boolean; grade: string | null }>();
    const gradeOfRun = (date: string, venueName: string | null, raceNo: number | null): { found: boolean; grade: string | null } => {
      if (!venueName || raceNo === null) return { found: false, grade: null };
      const code: VenueCode | null = venueCodeFromName(venueName);
      if (!code) return { found: false, grade: null };
      const key = makeRaceKey(date, code, raceNo);
      if (!gradeCache.has(key)) {
        const race = repo.getRace(key);
        gradeCache.set(key, { found: race !== null, grade: race?.grade ?? null });
      }
      return gradeCache.get(key)!;
    };

    let covRuns = 0;
    let covKnown = 0;
    let covGraded = 0;
    // 名前方式（本番の適用済み方式）との引き当て方式の比較
    let nameGraded = 0;
    let agreeBoth = 0;
    let disagreeBoth = 0;
    const disagreeSamples: string[] = [];
    let skippedHorses = 0;
    let recentCheckOk = 0;
    let recentCheckNg = 0;

    const samples: Sample[] = [];
    for (const { record, outcome, date } of byRace.values()) {
      const race = repo.getRace(record.raceKey);
      if (!race) continue;
      const finishByNo = new Map(outcome.finishes.map((f) => [f.horseNumber, f.finishPosition]));
      const entryByNo = new Map(repo.getEntries(record.raceKey).map((e) => [e.horseNumber, e]));
      const horses: HorseCalc[] = [];
      for (const m of record.marks) {
        const finish = finishByNo.get(m.horseNumber);
        if (!m.scores || typeof finish !== 'number') continue;
        const entry = entryByNo.get(m.horseNumber);
        const horseId = entry?.netkeibaHorseId ?? null;
        let recentOld: number | null = null;
        const recentNew = new Map<number, number | null>();
        if (horseId) {
          const runs = repo
            .listHorseRuns(horseId)
            .filter((r) => r.date < race.date)
            .slice(0, 5);
          if (runs.length > 0) {
            const ws = RECENT_WEIGHTS.slice(0, runs.length);
            const wSum = ws.reduce((a, b) => a + b, 0);
            recentOld = Math.round(runs.reduce((s, r, i) => s + finishPoints(r.finishPosition) * ws[i], 0) / wSum);
            // 保存された近走点と一致するか（DBの過去走が後から取り直されて変わっていないかの確認）
            const stored = m.scores['recent'];
            if (typeof stored === 'number') {
              if (Math.abs(stored - recentOld) <= 1) recentCheckOk++;
              else recentCheckNg++;
            }
            const grades = runs.map((r) => {
              // 本番の適用済み方式（レース名の末尾から読む）で測る
              const g = gradeFromRaceName(r.raceName);
              if (g) nameGraded++;
              // 旧方式（races テーブル引き当て）との比較（カバー率と一致率の監査用）
              const info = gradeOfRun(r.date, r.venueName, r.raceNo);
              covRuns++;
              if (info.found) {
                covKnown++;
                const joinG = normalizeGrade(info.grade);
                if (joinG) covGraded++;
                if (joinG === g) agreeBoth++;
                else {
                  disagreeBoth++;
                  if (disagreeSamples.length < 10) disagreeSamples.push(`${r.date} ${r.raceName ?? ''}（表: ${joinG ?? 'なし'} / 名前: ${g ?? 'なし'}）`);
                }
              }
              return g;
            });
            for (const scale of SCALES) {
              let s = 0;
              runs.forEach((r, i) => {
                const g = grades[i];
                s += (g ? Math.min(100, finishPoints(r.finishPosition) + BONUS[g] * scale) : finishPoints(r.finishPosition)) * ws[i];
              });
              recentNew.set(scale, Math.round(s / wSum));
            }
          }
        } else {
          skippedHorses++;
        }
        if (recentNew.size === 0) for (const scale of SCALES) recentNew.set(scale, null);
        horses.push({ horseNumber: m.horseNumber, horseName: m.horseName, finish, scores: m.scores, recentOld, recentNew });
      }
      if (horses.filter((h) => h.finish <= 3).length >= 3 && horses.length >= 5) {
        samples.push({ raceKey: record.raceKey, date, horses });
      }
    }

    samples.sort((a, b) => a.date.localeCompare(b.date) || a.raceKey.localeCompare(b.raceKey));
    console.log(`[Class] 対象: ${samples.length}レース`);
    if (covRuns > 0) {
      console.log(
        `[Class] グレードのカバー率（旧・表引き方式）: 近5走 ${covRuns}走のうち判明 ${covKnown}走（${Math.round((covKnown / covRuns) * 100)}%）・重賞等 ${covGraded}走（${Math.round((covGraded / covRuns) * 100)}%）`,
      );
      console.log(
        `[Class] グレードのカバー率（本番・名前方式）: 近5走 ${covRuns}走のうち重賞等 ${nameGraded}走（${Math.round((nameGraded / covRuns) * 100)}%）`,
      );
      const bothN = agreeBoth + disagreeBoth;
      if (bothN > 0) {
        console.log(
          `[Class] 両方式の一致率: 表引きで判明した ${bothN}走のうち一致 ${agreeBoth}走（${Math.round((agreeBoth / bothN) * 1000) / 10}%）・食い違い ${disagreeBoth}走`,
        );
        for (const s of disagreeSamples) console.log(`[Class]   食い違い例: ${s}`);
      }
    }
    console.log(`[Class] 近走点の再現チェック: 保存値と一致 ${recentCheckOk}頭 / 不一致 ${recentCheckNg}頭（不一致が多いときは過去走の取り直しで記録時と変わっています）`);
    if (skippedHorses > 0) console.log(`[Class] 馬IDが無くて近走を計算し直せなかった馬: ${skippedHorses}頭（その馬は補正なしとして扱います）`);

    if (onlyRace) {
      const smp = samples.find((s) => s.raceKey === onlyRace);
      if (!smp) {
        console.log(`[Class] ${onlyRace} の記録（点数つき・結果つき）が見つかりませんでした`);
        return;
      }
      console.log(`\n[Class] ${smp.raceKey}（${smp.date}）馬ごとの変化（配分は今の採用中）`);
      const base = smp.horses
        .map((h) => ({ h, t: totalOf(h.scores, weights) }))
        .sort((a, b) => b.t - a.t || a.h.horseNumber - b.h.horseNumber);
      const baseRank = new Map(base.map((x, i) => [x.h.horseNumber, i + 1]));
      for (const scale of SCALES) {
        const ranked = smp.horses
          .map((h) => ({ h, t: totalOf(h.scores, weights, h.recentNew.get(scale) ?? undefined) }))
          .sort((a, b) => b.t - a.t || a.h.horseNumber - b.h.horseNumber);
        const rank = new Map(ranked.map((x, i) => [x.h.horseNumber, i + 1]));
        console.log(`[Class] -- 倍率 ${scale} --`);
        for (const x of ranked) {
          console.log(
            `[Class] ${x.h.horseNumber}番 ${x.h.horseName} 着順${x.h.finish} 近走 ${x.h.recentOld ?? '-'}→${x.h.recentNew.get(scale) ?? '-'} 合計 ${totalOf(x.h.scores, weights)}→${x.t} 順位 ${baseRank.get(x.h.horseNumber)}→${rank.get(x.h.horseNumber)}`,
          );
        }
      }
      return;
    }

    if (samples.length < 50) {
      console.log('[Class] 対象が50レース未満のため、判定はしません（件数だけ参考にしてください）');
    }
    const holdN = Math.max(20, Math.round(samples.length * 0.3));
    const train = samples.slice(0, samples.length - holdN);
    const hold = samples.slice(samples.length - holdN);
    const sign = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
    for (const [label, part] of [['全レース', samples], ['学習用（古い7割）', train], ['確認用（新しい3割）', hold]] as const) {
      const base = metrics(part, weights, null);
      console.log(`\n[Class] ${label}: ${part.length}レース・今の近走での成績 ${base.top3InTop5}%（1位の複勝率 ${base.firstTop3}%）`);
      for (const scale of SCALES) {
        const m = metrics(part, weights, scale);
        const wl = winLoss(part, weights, scale);
        console.log(
          `[Class] 倍率${scale}: ${m.top3InTop5}%（${sign(m.top3InTop5 - base.top3InTop5)}）・1位複勝 ${m.firstTop3}%・勝敗 ${wl.win}勝${wl.lose}敗 z=${wl.z.toFixed(2)}`,
        );
      }
    }
    console.log('\n[Class] 採用の目安（配分の自動見直しと同じ）: 確認用でプラス、勝敗の z が 1.645 以上、決着30レース以上');
    console.log('[Class] 倍率どうしで効きが単調に増えるか（用量反応）も見てください。1つの倍率だけ跳ねる場合は偶然の可能性があります');
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
