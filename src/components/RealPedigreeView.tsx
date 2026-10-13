import React from 'react';
import { Dna } from 'lucide-react';
import type { RealDataView } from '../utils/trifecta';
import { RankBadge } from './RaceCardTable';

const MARK_CLASS: Record<string, string> = {
  '◎': 'text-red-400',
  '◯': 'text-sky-400',
  '▲': 'text-emerald-400',
  '△': 'text-amber-400',
  '☆': 'text-purple-400',
};

/** 血統＆適性マトリクス（実データ）：全頭の血統と状況別の適性を一覧にする */
export const RealPedigreeView: React.FC<{ data: RealDataView | null }> = ({ data }) => {
  if (!data) return <p className="text-xs text-slate-400 p-4">データ予想の読み込み後に表示されます。</p>;
  const horses = [...data.ranked].sort((a, b) => (a.horseNumber ?? 99) - (b.horseNumber ?? 99));
  const venue = data.race?.venueName ?? horses[0]?.aptitudeMatrix?.currentVenue ?? '';
  const features = horses[0]?.aptitudeMatrix?.features ?? [];

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
      <h3 className="text-base font-black text-white flex items-center gap-2">
        <Dna className="w-4 h-4 text-emerald-400" />
        血統＆適性マトリクス（実データ）
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] text-slate-300">
          <thead>
            <tr className="text-slate-500 border-b border-slate-800">
              <th rowSpan={2} className="px-2 py-1 text-left font-normal">印</th>
              <th rowSpan={2} className="px-2 py-1 text-left font-normal">馬</th>
              <th rowSpan={2} className="px-2 py-1 text-left font-normal">父 / 母父</th>
              <th colSpan={2} className="px-2 py-1 text-center font-normal">重馬場・道悪</th>
              <th colSpan={2} className="px-2 py-1 text-center font-normal">ベスト距離</th>
              <th rowSpan={2} className="px-2 py-1 text-center font-normal">{venue}</th>
              {features.map((f) => (
                <th key={f.key} rowSpan={2} className="px-2 py-1 text-center font-normal" title={f.venues.join('・')}>
                  {f.label}
                </th>
              ))}
            </tr>
            <tr className="text-slate-500 border-b border-slate-800">
              <th className="px-1 font-normal">自身</th>
              <th className="px-1 font-normal">血統</th>
              <th className="px-1 font-normal">自身</th>
              <th className="px-1 font-normal">血統</th>
            </tr>
          </thead>
          <tbody>
            {horses.map((h) => {
              const a = h.aptitudeMatrix;
              const v = a?.venues.find((x) => x.venue === venue);
              return (
                <tr key={`${h.horseNumber}-${h.horseName}`} className="border-t border-slate-800/70">
                  <td className={`px-2 py-1 text-sm font-black ${MARK_CLASS[h.mark] ?? ''}`}>{h.mark}</td>
                  <td className="px-2 py-1 whitespace-nowrap text-slate-200">
                    {h.horseNumber} {h.horseName}
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    {h.sireName ? (
                      <>
                        {h.sireName}
                        <span className="text-slate-500"> / {h.bmsName ?? '-'}</span>
                      </>
                    ) : (
                      <span className="text-slate-500">未取得</span>
                    )}
                  </td>
                  {a ? (
                    <>
                      <td className="px-1 text-center"><RankBadge rank={a.heavy.own.rank} detail={a.heavy.own.detail} /></td>
                      <td className="px-1 text-center"><RankBadge rank={a.heavy.pedigree.rank} detail={a.heavy.pedigree.detail} /></td>
                      <td className="px-1 text-center whitespace-nowrap cursor-help" title={a.bestDistance.own.detail}>
                        {a.bestDistance.own.label ?? <span className="text-slate-500">不足</span>}
                      </td>
                      <td className="px-1 text-center whitespace-nowrap cursor-help" title={a.bestDistance.pedigree.detail}>
                        {a.bestDistance.pedigree.label ?? <span className="text-slate-500">不足</span>}
                      </td>
                      <td className="px-1 text-center">
                        {v && v.n > 0 ? (
                          <span className="whitespace-nowrap">
                            <RankBadge rank={v.rank} detail={v.detail} />
                            <span className="text-slate-500 ml-1">{v.top3}/{v.n}</span>
                          </span>
                        ) : (
                          <span className="text-slate-600">-</span>
                        )}
                      </td>
                      {a.features.map((f) => (
                        <td key={f.key} className="px-1 text-center"><RankBadge rank={f.rank} detail={f.detail} /></td>
                      ))}
                    </>
                  ) : (
                    <td colSpan={5 + features.length} className="px-2 text-slate-500">データなし</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-slate-500">
        自身＝その馬の成績（出走数で補正した3着以内率）、血統＝父・母父の産駒成績（父2：母父1）。S(80点〜)・A(60〜)・B(40〜)・C(〜39)、「不足」はデータ不足。
        競馬場・特徴別は自身の成績のみ（競馬場別の産駒成績は未取得）。札にマウスを乗せると根拠が出ます。行を開いた出馬表の「状況別適性診断」で10場すべてを確認できます。
      </p>
    </div>
  );
};
