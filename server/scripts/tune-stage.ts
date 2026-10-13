/**
 * 配分の自動見直し（夜間ジョブ・手動スクリプト共通）。結果をログに出す
 */
import type { RaceRepository } from '../db/repository';
import { COMPONENT_KEYS, COMPONENT_LABELS } from '../../src/utils/dataScore';
import { buildSamples, evaluateWeights, runWeightReview } from '../services/weight-tuner';

const fmt = (w: Record<string, number>) => COMPONENT_KEYS.map((k) => `${COMPONENT_LABELS[k]}${w[k]}`).join('・');

export function logWeightReview(repo: RaceRepository, opts: { dryRun?: boolean } = {}): void {
  const { result, version } = runWeightReview(repo, opts);
  console.log(`[Tune] 対象 ${result.races}レース／今の配分: ${fmt(result.current)}`);
  if (result.train && result.holdout) {
    const t = result.train;
    const h = result.holdout;
    console.log(
      `[Tune] 3着以内の馬が上位5頭に入った割合　学習用 ${t.current.top3InTop5}%` +
        (t.candidate ? ` → 候補 ${t.candidate.top3InTop5}%` : '') +
        `／確認用（直近${h.current.races}レース） ${h.current.top3InTop5}%` +
        (h.candidate ? ` → 候補 ${h.candidate.top3InTop5}%` : ''),
    );
  }
  if (result.candidate) console.log(`[Tune] 候補の配分: ${fmt(result.candidate)}`);
  console.log(`[Tune] ${result.message}${opts.dryRun && result.adopted ? '（--dry のため採用していません）' : ''}`);
  if (version) console.log(`[Tune] 採用しました（版 ${version.id}）。次に記録する予想から使います`);

  // 項目ごとの効き具合：その項目だけで予想した場合の「3着以内の馬が上位5頭に入った割合」（参考。データの無い馬は中立50点）
  const samples = buildSamples(repo.listScoredRecordsWithOutcome());
  if (samples.length > 0) {
    const single = COMPONENT_KEYS.map((k) => {
      const w = Object.fromEntries(COMPONENT_KEYS.map((x) => [x, x === k ? 1 : 0]));
      // その項目の点数を保存していない記録（項目を追加する前の記録）は数えない
      const usable = samples.filter((s) => s.horses.some((h) => h.scores[k] !== undefined));
      // データのある馬の割合（低いと中立50点の同点が多く、数字に意味が薄い）
      const horses = usable.flatMap((s) => s.horses);
      const dataShare = horses.length > 0 ? horses.filter((h) => h.scores[k] !== null && h.scores[k] !== undefined).length / horses.length : 0;
      return { k, n: usable.length, m: usable.length > 0 ? evaluateWeights(usable, w).top3InTop5 : null, dataShare };
    });
    console.log(
      `[Tune] 項目ごとの効き具合（その項目だけで予想した場合・偶然なら約${Math.round((5 / 14) * 1000) / 10}%前後）: ` +
        single
          .map((x) => `${COMPONENT_LABELS[x.k]} ${x.m === null ? '-' : `${x.m}%`}（${x.n}R・データあり${Math.round(x.dataShare * 100)}%${x.dataShare < 0.5 ? '・参考外' : ''}）`)
          .join('・'),
    );
  }
}
