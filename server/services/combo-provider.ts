/**
 * 組み合わせ補正の表（区分ごとの補正値）を用意する
 *
 * 表は「そのレースの月の1日より前」に結果がそろった予想の記録だけで作る（未来の結果を使わない）。
 * 作るには全記録を読むため十数秒かかる。そこで
 *  - 作った表は data/combo-adjust/<年月>-v<配分の版>.json に保存し、次からはそれを読む（サーバーを再起動しても速い）
 *  - 同じ処理の中では、記録から作った1頭ずつの材料をメモリに持ち、月が変わっても読み直さない（付け直しを速くする）
 * 配分の版が変わる（毎週の見直しで採用）と、順位の付け方が変わるので表を作り直す。
 * 順位は「組み合わせ」の項目を除いた合計点で付ける（自分の点数で自分を補正しないため）。
 * DB は読むだけ。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RaceRepository } from '../db/repository';
import { DEFAULT_DB_PATH } from '../db/index';
import { COMPONENT_KEYS } from '../../src/utils/dataScore';
import { buildSamples } from './weight-tuner';
import { activeWeights } from './score-service';
import {
  COMBO_MIN_ITEMS,
  comboCellsOf,
  expectationTable,
  fitComboAdjust,
  type ComboAdjust,
  type ComboCells,
} from './combo-adjust';

interface Material {
  date: string;
  rank: number;
  heads: number;
  top3: boolean;
  cells: ComboCells;
}

const tableCache = new Map<string, ComboAdjust | null>();
/** builtMonth = 材料を作った実際の年月（月が替わったら、前の月の終わりに増えた記録を入れるため作り直す） */
let materialCache: { version: number; builtMonth: string; items: Material[] } | null = null;

function cacheDir(): string {
  return path.join(path.dirname(DEFAULT_DB_PATH), 'combo-adjust');
}

/** 記録から1頭ずつの材料を作る（順位は「組み合わせ」を除いた今の配分の合計点） */
function buildMaterials(repo: RaceRepository): Material[] {
  const weights = activeWeights(repo) as Record<string, number>;
  const keys = COMPONENT_KEYS.filter((k) => k !== 'pattern');
  const wSum = keys.reduce((s, k) => s + Math.max(0, weights[k] ?? 0), 0);
  if (wSum <= 0) return [];
  const out: Material[] = [];
  for (const s of buildSamples(repo.listScoredRecordsWithOutcome())) {
    const race = repo.getRace(s.raceKey);
    if (!race) continue;
    const entries = new Map(repo.getEntries(s.raceKey).map((e) => [e.horseNumber, e]));
    const ranked = s.horses
      .map((h) => {
        let t = 0;
        for (const k of keys) t += (h.scores[k] ?? 50) * Math.max(0, weights[k] ?? 0);
        return { h, t: Math.round((t / wSum) * 10) / 10 };
      })
      .sort((a, b) => b.t - a.t || a.h.horseNumber - b.h.horseNumber);
    ranked.forEach(({ h }, i) => {
      const e = entries.get(h.horseNumber);
      let cells: ComboCells = [null, null, null];
      if (e?.netkeibaHorseId && repo.hasHorseRuns(e.netkeibaHorseId)) {
        const p = repo.latestHorseRunBefore(e.netkeibaHorseId, s.date);
        cells = comboCellsOf({
          date: s.date,
          distance: race.distance,
          raceName: race.name ?? '',
          grade: race.grade ?? null,
          sex: e.sex ?? null,
          age: e.age ?? null,
          prev: p ? { date: p.date, raceName: p.raceName, distance: p.distance, finish: p.finishPosition, style: p.runningStyle } : null,
        });
      }
      out.push({ date: s.date, rank: i + 1, heads: s.horses.length, top3: h.finish <= 3, cells });
    });
  }
  return out;
}

/** レース日 date の月に使う補正の表。記録が足りなければ null（補正しない） */
export function comboTableFor(repo: RaceRepository, date: string): ComboAdjust | null {
  const month = date.slice(0, 7);
  const version = repo.getActiveWeightVersion()?.id ?? 0;
  const key = `${month}-v${version}`;
  if (tableCache.has(key)) return tableCache.get(key)!;
  const file = path.join(cacheDir(), `${key}.json`);
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { table: [string, { adj: number; n: number }][] | null };
      const t = raw.table ? new Map(raw.table) : null;
      tableCache.set(key, t);
      return t;
    }
  } catch {
    // 壊れたファイルは作り直す
  }
  const thisMonth = new Date().toISOString().slice(0, 7);
  if (!materialCache || materialCache.version !== version || materialCache.builtMonth < thisMonth) {
    materialCache = { version, builtMonth: thisMonth, items: buildMaterials(repo) };
  }
  const past = materialCache.items.filter((m) => m.date < `${month}-01`);
  let table: ComboAdjust | null = null;
  if (past.length >= COMBO_MIN_ITEMS) {
    const exp = expectationTable(past);
    table = fitComboAdjust(past.map((m) => ({ cells: m.cells, exp: exp(m.rank, m.heads), top3: m.top3 })));
  }
  tableCache.set(key, table);
  // 保存するのは、もう記録が増えない月の表だけ：先月以前の月と、3日以降に作った今月の表
  // （月初の1〜2日は前の月の終わりのレースの結果がまだ入ることがある。来月以降の表は保存しない）
  const today = new Date().toISOString().slice(0, 10);
  if (month < thisMonth || (month === thisMonth && today >= `${thisMonth}-03`)) {
    try {
      fs.mkdirSync(cacheDir(), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ month, version, createdAt: new Date().toISOString(), table: table ? [...table.entries()] : null }));
    } catch {
      // 保存できなくても計算は続ける
    }
  }
  return table;
}

/** テスト用：メモリの表と材料を捨てる */
export function clearComboCache(): void {
  tableCache.clear();
  materialCache = null;
}
