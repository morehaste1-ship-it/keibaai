/**
 * 距離帯ごとに、予想の各項目がどれだけ効いているかを調べる（読むだけ・DBに書き込まない）
 *
 * 実行: npx tsx server/scripts/check-band.ts
 *       npx tsx server/scripts/check-band.ts --min 20   … この件数未満の距離帯は詳細を出さない（既定 20）
 *
 * 物差しは配分の自動見直しと同じ「3着以内の馬が、合計点の上位5頭に入った割合」。
 * 「その項目だけで予想した場合」の割合を距離帯ごとに出すので、長距離で騎手がどれだけ効くかを比べられる。
 * - 対象は、結果がそろっていて各項目の点数を保存している予想の記録（前日・当日・検証用）。1レース1件
 * - データのある馬の割合が低い項目は、中立50点の同点が多く数字の意味が薄いため「参考外」と表示する
 */
import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { COMPONENT_KEYS, COMPONENT_LABELS } from '../../src/utils/dataScore';
import { distanceBandOf } from '../services/jockey-service';
import { buildSamples, evaluateWeights } from '../services/weight-tuner';
import { activeWeights } from '../services/score-service';

/** データのある馬がこの割合未満の項目は「参考外」とする */
const DATA_SHARE_MIN = 0.5;
/** 項目名の表示幅をそろえる（全角2・半角1で数えて右に空白を足す） */
function padLabel(text: string, width = 16): string {
  const w = [...text].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - w));
}

const BAND_ORDER = ['短距離(〜1400)', 'マイル(〜1800)', '中距離(〜2200)', '長距離(2201〜)'];

function main(): void {
  const i = process.argv.indexOf('--min');
  const minRaces = i >= 0 ? Number(process.argv[i + 1]) : 20;
  if (!Number.isFinite(minRaces) || minRaces < 1) {
    console.error('[Band] --min は1以上の数で指定してください');
    process.exitCode = 1;
    return;
  }

  const db = openDatabase();
  try {
    const repo = new RaceRepository(db);
    const current = activeWeights(repo);
    const rows = repo.listScoredRecordsWithOutcome();

    // 距離帯ごとに記録を分ける（レースが未登録・距離が不明なものは除く）
    const byBand = new Map<string, typeof rows>();
    for (const r of rows) {
      const race = repo.getRace(r.record.raceKey);
      const band = race ? distanceBandOf(race.distance) : null;
      if (!band) continue;
      const list = byBand.get(band) ?? [];
      list.push(r);
      byBand.set(band, list);
    }

    const bands = [...BAND_ORDER.filter((b) => byBand.has(b)), ...[...byBand.keys()].filter((b) => !BAND_ORDER.includes(b))];
    console.log(`[Band] 対象の記録 ${rows.length}件／距離帯 ${bands.length}区分（${minRaces}レース未満は詳細なし）`);
    console.log('[Band] 物差し：3着以内の馬が、合計点の上位5頭に入った割合');

    for (const band of bands) {
      const samples = buildSamples(byBand.get(band)!);
      if (samples.length === 0) {
        console.log(`\n[Band] ${band}: 使えるレースがありません`);
        continue;
      }
      // 偶然に選んだ場合の目安（5頭 ÷ 平均の出走頭数 × 3着以内の3頭）
      const avgHorses = samples.reduce((s, x) => s + x.horses.length, 0) / samples.length;
      const chance = Math.round((5 / avgHorses) * 1000) / 10;
      const all = evaluateWeights(samples, current);
      console.log(
        `\n[Band] ${band}: ${samples.length}レース（平均${avgHorses.toFixed(1)}頭・偶然なら約${chance}%）` +
          `／今の配分での成績 ${all.top3InTop5}%`,
      );
      if (samples.length < minRaces) {
        console.log(`[Band]   レース数が少ないため詳細は出しません（${minRaces}レース以上で表示）`);
        continue;
      }
      const single = COMPONENT_KEYS.map((k) => {
        const w = Object.fromEntries(COMPONENT_KEYS.map((x) => [x, x === k ? 1 : 0]));
        // その項目の点数を保存していない記録（項目を追加する前の記録）は数えない
        const usable = samples.filter((s) => s.horses.some((h) => h.scores[k] !== undefined));
        const horses = usable.flatMap((s) => s.horses);
        const share = horses.length > 0 ? horses.filter((h) => h.scores[k] !== null && h.scores[k] !== undefined).length / horses.length : 0;
        return { k, n: usable.length, rate: usable.length > 0 ? evaluateWeights(usable, w).top3InTop5 : null, share };
      })
        .filter((x) => x.rate !== null)
        .sort((a, b) => (b.rate as number) - (a.rate as number));
      for (const s of single) {
        const mark = s.share < DATA_SHARE_MIN ? '（参考外）' : '';
        console.log(
          `[Band]   ${padLabel(COMPONENT_LABELS[s.k])}${String(s.rate).padStart(5)}%` +
            `　配分${String(current[s.k] ?? 0).padStart(3)}%　${s.n}R・データあり${Math.round(s.share * 100)}%${mark}`,
        );
      }
    }
    console.log('\n[Band] 見方：偶然の目安より高いほど効いている項目です。距離帯の間で同じ項目を比べると、どの距離で効くかが分かります');
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err: any) {
  console.error('[Band] 失敗:', err?.message ?? err);
  process.exitCode = 1;
}
