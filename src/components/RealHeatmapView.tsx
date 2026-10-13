import React from 'react';
import { Flame } from 'lucide-react';
import { COMPONENT_KEYS, COMPONENT_LABELS } from '../utils/dataScore';
import type { RealDataView } from '../utils/trifecta';

/** 点数（0〜100）の色。高いほど暖色、データ不足は灰色 */
export function heatClass(score: number, hasData: boolean): string {
  if (!hasData) return 'bg-slate-900 text-slate-500 italic';
  if (score >= 80) return 'bg-rose-500/70 text-white font-black';
  if (score >= 65) return 'bg-orange-500/50 text-white font-bold';
  if (score >= 50) return 'bg-amber-500/30 text-amber-100';
  if (score >= 35) return 'bg-sky-500/20 text-sky-200';
  return 'bg-slate-800 text-slate-400';
}

const LEGEND = [
  { label: '80点〜', cls: heatClass(80, true) },
  { label: '65〜79', cls: heatClass(65, true) },
  { label: '50〜64', cls: heatClass(50, true) },
  { label: '35〜49', cls: heatClass(35, true) },
  { label: '〜34', cls: heatClass(0, true) },
  { label: 'データ不足', cls: heatClass(0, false) },
];

/** データ予想のヒートマップ（実データ：各項目の点数を色分け） */
export const RealHeatmapView: React.FC<{ data: RealDataView | null }> = ({ data }) => {
  if (!data) return <p className="text-xs text-slate-400 p-4">データ予想の読み込み後に表示されます。</p>;
  const rows = [...data.ranked].sort((a, b) => a.rank - b.rank);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
      <h3 className="text-base font-black text-white flex items-center gap-2">
        <Flame className="w-4 h-4 text-rose-400" />
        データ予想ヒートマップ（実データ）
      </h3>
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        {LEGEND.map((l) => (
          <span key={l.label} className={`px-1.5 py-0.5 rounded ${l.cls}`}>
            {l.label}
          </span>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] border-separate border-spacing-0.5">
          <thead>
            <tr className="text-slate-500">
              <th className="px-2 py-1 text-left font-normal">順位</th>
              <th className="px-2 py-1 text-left font-normal">印・馬</th>
              <th className="px-2 py-1 text-right font-normal">人気</th>
              {COMPONENT_KEYS.map((k) => (
                <th key={k} className="px-2 py-1 text-center font-normal">
                  {COMPONENT_LABELS[k]}
                </th>
              ))}
              <th className="px-2 py-1 text-center font-normal">合計</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={`${h.horseNumber}-${h.horseName}`}>
                <td className="px-2 py-1 text-slate-400">{h.rank}</td>
                <td className="px-2 py-1 whitespace-nowrap text-slate-200">
                  <span className="font-black mr-1">{h.mark}</span>
                  {h.horseNumber} {h.horseName}
                </td>
                <td className="px-2 py-1 text-right text-slate-400">{h.popularity ?? '-'}</td>
                {COMPONENT_KEYS.map((k) => {
                  const c = h.components[k];
                  return (
                    <td key={k} title={c.detail} className={`px-2 py-1 text-center rounded cursor-help ${heatClass(c.score, c.hasData)}`}>
                      {c.score}
                    </td>
                  );
                })}
                <td className={`px-2 py-1 text-center rounded ${heatClass(h.total, true)}`}>{h.total.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-slate-500">
        各項目はデータ予想の点数（0〜100点）、合計は上の「データ予想」の配分で計算した点数です。灰色の斜体はデータ不足で中立50点にした項目です。マスにマウスを乗せると根拠が出ます。
        実データからは勝率・連対率の予測を計算していないため、点数の色分けで強弱を表しています。
      </p>
    </div>
  );
};
