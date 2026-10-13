/**
 * 配分の自動見直しを手動で実行する（段階C）
 *
 * 実行: npm run tune            見直して、条件を満たせば採用する
 *       npm run tune -- --dry   見直しの結果を表示するだけ（採用しない）
 * 定期実行: 毎週火曜の夜間ジョブで自動実行
 */
import { openDatabase } from '../db/index';
import { RaceRepository } from '../db/repository';
import { logWeightReview } from './tune-stage';

const db = openDatabase();
try {
  logWeightReview(new RaceRepository(db), { dryRun: process.argv.includes('--dry') });
} catch (err: any) {
  console.error('[Tune] fatal:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  db.close();
}
