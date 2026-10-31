/**
 * 騎手の効きを、距離帯 × 重賞/一般 と、騎手ごとの長距離成績で調べる（読むだけ・DBに書き込まない）
 *
 * 実行: npx tsx server/scripts/check-jockey.ts
 *       npx tsx server/scripts/check-jockey.ts --band 中距離   … 騎手ごとの一覧の距離帯を変える（既定 長距離）
 *       npx tsx server/scripts/check-jockey.ts --rides 30      … 騎手ごとの一覧に出す最少騎乗数（既定 30）
 *
 * 1. 距離帯 × 重賞/一般：「騎手」「相性」が、その項目だけでどれだけ当てられるか。
 *    頭数が違うと偶然の当たりやすさも変わるため、「偶然からの上積み率」＝（実際 − 偶然）÷（100 − 偶然）で比べる
 * 2. 騎手ごとの長距離成績：騎手成績（過去5年・JRA）から、その距離帯の騎乗数・勝率・3着以内率を出す
 */
import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { COMPONENT_KEYS } from '../../src/utils/dataScore';
import { distanceBandOf } from '../services/jockey-service';
import { buildSamples, evaluateWeights } from '../services/weight-tuner';

const GRADED = ['GI', 'GII', 'GIII', 'G1', 'G2', 'G3'];
const BAND_ORDER = ['短距離(〜1400)', 'マイル(〜1800)', '中距離(〜2200)', '長距離(2201〜)'];
/** この件数未満のまとまりは、偶然に振れるため参考値として（*）を付ける */
const FEW_RACES = 50;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 表示幅をそろえる（全角2・半角1で数えて右に空白を足す） */
function pad(text: string, width: number): string {
  const w = [...text].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - w));
}

/** その項目だけで予想した場合の「偶然からの上積み率」（%）。使えるレースが無ければ null */
function liftOf(samples: ReturnType<typeof buildSamples>, key: string): { lift: number; rate: number; chance: number } | null {
  const usable = samples.filter((s) => s.horses.some((h) => h.scores[key] !== undefined));
  if (usable.length === 0) return null;
  const w = Object.fromEntries(COMPONENT_KEYS.map((x) => [x, x === key ? 1 : 0]));
  const rate = evaluateWeights(usable, w).top3InTop5;
  const chance = (5 / (usable.reduce((s, x) => s + x.horses.length, 0) / usable.length)) * 100;
  return { lift: Math.round(((rate - chance) / (100 - chance)) * 1000) / 10, rate, chance: Math.round(chance * 10) / 10 };
}

function main(): void {
  const bandArg = arg('band') ?? '長距離';
  const minRides = Number(arg('rides') ?? 30);
  if (!Number.isFinite(minRides) || minRides < 1) {
    console.error('[JK] --rides は1以上の数で指定してください');
    process.exitCode = 1;
    return;
  }
  const targetBand = BAND_ORDER.find((b) => b.startsWith(bandArg));
  if (!targetBand) {
    console.error(`[JK] --band は次のいずれかで指定してください: ${BAND_ORDER.map((b) => b.split('(')[0]).join(' / ')}`);
    process.exitCode = 1;
    return;
  }

  const db = openDatabase();
  try {
    const repo = new RaceRepository(db);

    // ---- 1. 距離帯 × 重賞/一般 ----
    const groups = new Map<string, ReturnType<RaceRepository['listScoredRecordsWithOutcome']>>();
    for (const r of repo.listScoredRecordsWithOutcome()) {
      const race = repo.getRace(r.record.raceKey);
      const band = race ? distanceBandOf(race.distance) : null;
      if (!race || !band) continue;
      const key = `${band}|${GRADED.includes(race.grade ?? '') ? '重賞' : '一般'}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }

    console.log('[JK] 1. 距離帯 × 重賞/一般　「偶然からの上積み率」＝（実際 − 偶然）÷（100 − 偶然）。高いほど効いています');
    console.log(`[JK] ${pad('距離帯', 18)}${pad('区分', 8)}${'レース'.padStart(8)}  ${'騎手'.padStart(7)}  ${'相性'.padStart(7)}  ${'近走'.padStart(7)}`);
    for (const band of BAND_ORDER) {
      for (const kind of ['重賞', '一般']) {
        const rows = groups.get(`${band}|${kind}`);
        if (!rows) continue;
        const samples = buildSamples(rows);
        if (samples.length === 0) continue;
        const cell = (k: string) => {
          const v = liftOf(samples, k);
          return (v === null ? '-' : `${v.lift}%`).padStart(7);
        };
        const few = samples.length < FEW_RACES ? '*' : ' ';
        console.log(`[JK] ${pad(band, 18)}${pad(kind, 8)}${String(samples.length).padStart(7)}R${few} ${cell('jockey')}  ${cell('matchup')}  ${cell('recent')}`);
      }
    }
    console.log(`[JK] （*）は${FEW_RACES}レース未満。偶然に振れるため参考値です`);

    // ---- 2. 騎手ごとの成績（その距離帯・過去5年・JRA） ----
    const [lo, hi] =
      targetBand === '短距離(〜1400)' ? [0, 1400] : targetBand === 'マイル(〜1800)' ? [1401, 1800] : targetBand === '中距離(〜2200)' ? [1801, 2200] : [2201, 9999];
    const rides = db
      .prepare(
        `SELECT r.jockey_id AS id, COALESCE(j.name, r.jockey_id) AS name, COUNT(*) AS n,
                SUM(CASE WHEN r.finish_position = 1 THEN 1 ELSE 0 END) AS win,
                SUM(CASE WHEN r.finish_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
         FROM jockey_runs r LEFT JOIN jockeys j ON j.jockey_id = r.jockey_id
         WHERE r.distance BETWEEN ? AND ? AND r.surface <> '障害' AND r.finish_position IS NOT NULL
         GROUP BY r.jockey_id HAVING n >= ? ORDER BY (CAST(top3 AS REAL) / n) DESC`,
      )
      .all(lo, hi, minRides) as { id: string; name: string; n: number; win: number; top3: number }[];
    // 比較用：同じ騎手の全距離の成績
    const allStmt = db.prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN finish_position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3
       FROM jockey_runs WHERE jockey_id = ? AND surface <> '障害' AND finish_position IS NOT NULL`,
    );
    console.log(`\n[JK] 2. ${targetBand}の騎手成績（騎手成績ページ・過去5年・JRA・障害を除く／${minRides}騎乗以上）`);
    if (rides.length === 0) {
      console.log('[JK] 対象の騎乗がありません（騎手成績が未取得か、騎乗数が足りません）');
    } else {
      console.log(`[JK] ${pad('騎手', 14)}${'騎乗'.padStart(6)}${'勝率'.padStart(8)}${'3着内率'.padStart(9)}${'全距離'.padStart(9)}${'差'.padStart(8)}`);
      for (const r of rides) {
        const a = allStmt.get(r.id) as { n: number; top3: number };
        const bandRate = (r.top3 / r.n) * 100;
        const allRate = a.n > 0 ? (a.top3 / a.n) * 100 : 0;
        const diff = bandRate - allRate;
        console.log(
          `[JK] ${pad(r.name, 14)}${String(r.n).padStart(6)}${`${((r.win / r.n) * 100).toFixed(1)}%`.padStart(8)}` +
            `${`${bandRate.toFixed(1)}%`.padStart(9)}${`${allRate.toFixed(1)}%`.padStart(9)}${`${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`.padStart(8)}`,
        );
      }
      console.log('[JK] 「全距離」はその騎手の全距離での3着以内率、「差」はこの距離帯との差です。プラスが大きいほどこの距離帯が得意です');
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err: any) {
  console.error('[JK] 失敗:', err?.message ?? err);
  process.exitCode = 1;
}
