/**
 * 「上乗せの価値」を距離帯ごとに測る（読むだけ・DBに書き込まない）
 *
 * 実行: npx tsx server/scripts/check-margin.ts
 *       npx tsx server/scripts/check-margin.ts --step 10   … 動かす幅（既定 5ポイント）
 *       npx tsx server/scripts/check-margin.ts --all       … 距離帯に分けず、全レースだけを見る
 *
 * 「その項目だけで予想した場合の成績」ではなく、
 * 「今の配分から、その項目を +step ／ −step したときに成績がどう変わるか」を測る。
 * 近走と着差のように中身が重なる項目は、単独では強くても足しても効かない。それを見分けるための道具。
 *
 * 数字の読み方
 *  - 変化：3着以内の馬が上位5頭に入った割合のポイント差。プラスなら上げた方がよい
 *  - 勝敗：1レースずつ比べて、良くなったレース数 − 悪くなったレース数（引き分けは除く）。
 *    変化がプラスでも勝敗が拮抗していれば、少数のレースに引っ張られているだけの可能性が高い
 */
import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { COMPONENT_KEYS, COMPONENT_LABELS } from '../../src/utils/dataScore';
import { distanceBandOf } from '../services/jockey-service';
import { buildSamples, evaluateWeights, type TuneSample } from '../services/weight-tuner';
import { activeWeights } from '../services/score-service';

const BAND_ORDER = ['短距離(〜1400)', 'マイル(〜1800)', '中距離(〜2200)', '長距離(2201〜)'];
const TOP_N = 5;
/** この件数未満のまとまりは参考値として（*）を付ける */
const FEW_RACES = 100;

type Weights = Record<string, number>;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pad(text: string, width: number): string {
  const w = [...text].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - w));
}

/** 1レースで、3着以内の馬が合計点の上位5頭に何頭入ったか（評価の計算は weight-tuner と同じ） */
function hitsOf(smp: TuneSample, w: Weights, wSum: number): number {
  const ranked = smp.horses
    .map((h) => {
      let s = 0;
      for (const k of COMPONENT_KEYS) s += (h.scores[k] ?? 50) * Math.max(0, w[k] ?? 0);
      return { h, t: wSum > 0 ? Math.round((s / wSum) * 10) / 10 : 0 };
    })
    .sort((a, b) => b.t - a.t || a.h.horseNumber - b.h.horseNumber);
  return ranked.slice(0, TOP_N).filter((x) => x.h.finish <= 3).length;
}

/** 1レースずつ比べた勝敗（良くなった数・悪くなった数） */
function winLoss(samples: TuneSample[], base: Weights, next: Weights): { win: number; lose: number } {
  const bSum = COMPONENT_KEYS.reduce((s, k) => s + Math.max(0, base[k] ?? 0), 0);
  const nSum = COMPONENT_KEYS.reduce((s, k) => s + Math.max(0, next[k] ?? 0), 0);
  let win = 0;
  let lose = 0;
  for (const s of samples) {
    const d = hitsOf(s, next, nSum) - hitsOf(s, base, bSum);
    if (d > 0) win++;
    else if (d < 0) lose++;
  }
  return { win, lose };
}

function report(label: string, samples: TuneSample[], current: Weights, step: number): void {
  const baseRate = evaluateWeights(samples, current).top3InTop5;
  const few = samples.length < FEW_RACES ? '（*参考値）' : '';
  console.log(`\n[Mg] ${label}：${samples.length}レース・今の配分での成績 ${baseRate}%${few}`);
  console.log(`[Mg] ${pad('項目', 16)}${'配分'.padStart(6)}${`+${step}の変化`.padStart(11)}${'勝敗'.padStart(11)}${`−${step}の変化`.padStart(11)}${'勝敗'.padStart(11)}`);

  const rows = COMPONENT_KEYS.map((k) => {
    const cur = current[k] ?? 0;
    const up = { ...current, [k]: cur + step };
    const upRate = Math.round((evaluateWeights(samples, up).top3InTop5 - baseRate) * 10) / 10;
    const upWl = winLoss(samples, current, up);
    let downRate: number | null = null;
    let downWl: { win: number; lose: number } | null = null;
    if (cur >= step) {
      const down = { ...current, [k]: cur - step };
      downRate = Math.round((evaluateWeights(samples, down).top3InTop5 - baseRate) * 10) / 10;
      downWl = winLoss(samples, current, down);
    }
    return { k, cur, upRate, upWl, downRate, downWl };
  }).sort((a, b) => b.upRate - a.upRate);

  const sign = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
  const wl = (x: { win: number; lose: number } | null) => (x === null ? '-' : `${x.win}勝${x.lose}敗`);
  for (const r of rows) {
    console.log(
      `[Mg] ${pad(COMPONENT_LABELS[r.k], 16)}${`${r.cur}%`.padStart(6)}` +
        `${sign(r.upRate).padStart(11)}${wl(r.upWl).padStart(11)}` +
        `${(r.downRate === null ? '-' : sign(r.downRate)).padStart(11)}${wl(r.downWl).padStart(11)}`,
    );
  }
}

function main(): void {
  const step = Number(arg('step') ?? 5);
  if (!Number.isFinite(step) || step < 1 || step > 50) {
    console.error('[Mg] --step は1〜50の数で指定してください');
    process.exitCode = 1;
    return;
  }
  const onlyAll = process.argv.includes('--all');

  const db = openDatabase();
  try {
    const repo = new RaceRepository(db);
    const current = activeWeights(repo);
    console.log(`[Mg] 今の配分: ${COMPONENT_KEYS.map((k) => `${COMPONENT_LABELS[k]}${current[k] ?? 0}`).join('・')}`);
    console.log(`[Mg] 物差し：3着以内の馬が、合計点の上位5頭に入った割合（±${step}ポイント動かしたときの差）`);

    const rows = repo.listScoredRecordsWithOutcome();
    const byBand = new Map<string, typeof rows>();
    for (const r of rows) {
      const race = repo.getRace(r.record.raceKey);
      const band = race ? distanceBandOf(race.distance) : null;
      if (!band) continue;
      const list = byBand.get(band) ?? [];
      list.push(r);
      byBand.set(band, list);
    }

    report('全レース', buildSamples(rows), current, step);
    if (!onlyAll) {
      for (const band of BAND_ORDER) {
        const list = byBand.get(band);
        if (!list) continue;
        const samples = buildSamples(list);
        if (samples.length > 0) report(band, samples, current, step);
      }
    }
    console.log(`\n[Mg] 見方：「+${step}の変化」がプラスで、勝敗も勝ち越していれば、その項目を上げる価値があります`);
    console.log('[Mg] 　　　単独の効きが高くても、ここがほぼ0なら、すでにある項目と中身が重なっています');
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err: any) {
  console.error('[Mg] 失敗:', err?.message ?? err);
  process.exitCode = 1;
}
