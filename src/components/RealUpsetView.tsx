import React, { useMemo } from 'react';
import { ShieldAlert, Star } from 'lucide-react';
import type { RankedItem } from '../utils/dataScore';
import { COMPONENT_KEYS, COMPONENT_LABELS } from '../utils/dataScore';
import { explainHorse, forecastPace, longCandidates, midCandidates, type RealDataView } from '../utils/trifecta';

/** 点数がこれ未満の項目を「死角」とする */
const WEAK_SCORE = 40;
/** データ予想の順位が人気よりこれ以上低いと「死角」とする（3連単の中穴候補と同じ幅） */
const RANK_GAP = 3;

/** 人気馬の死角（実データから並べる。点数化はしない） */
export function weakPoints(h: RankedItem): string[] {
  const out: string[] = [];
  for (const k of COMPONENT_KEYS) {
    const c = h.components[k];
    if (c.hasData && c.score < WEAK_SCORE) out.push(`${COMPONENT_LABELS[k]}が${c.score}点（${c.detail}）`);
  }
  if (h.intervalDays !== null && h.intervalDays >= 91) out.push(`休み明け（前走から${h.intervalDays}日）`);
  if (h.intervalDays !== null && h.intervalDays <= 14) out.push(`中1週以内の詰まったローテーション（${h.intervalDays}日）`);
  if (h.jockeyChanged) out.push(`乗り替わり（前走 ${h.prevJockeyName ?? '-'} → 今回 ${h.jockeyName ?? '-'}）`);
  if (h.bodyWeightDiff !== null && Math.abs(h.bodyWeightDiff) >= 10)
    out.push(`馬体重の大きな増減（${h.bodyWeightDiff > 0 ? '+' : ''}${h.bodyWeightDiff}kg）`);
  if (h.popularity !== null && h.rank >= h.popularity + RANK_GAP) out.push(`データ予想は${h.rank}位（${h.popularity}番人気より${h.rank - h.popularity}つ下）`);
  if (h.shortage) out.push('データ不足の項目が多く、評価の確かさが低い');
  return out;
}

/** 人気馬の死角＆中穴・大穴推奨（実データ） */
export const RealUpsetView: React.FC<{ data: RealDataView | null }> = ({ data }) => {
  const pace = useMemo(() => (data ? forecastPace(data.ranked, data.historyCorner) : null), [data]);
  if (!data) return <p className="text-xs text-slate-400 p-4">データ予想の読み込み後に表示されます。</p>;
  const hasOdds = data.ranked.some((h) => h.popularity !== null);
  const favorites = data.ranked
    .filter((h) => h.popularity !== null && h.popularity <= 3)
    .sort((a, b) => (a.popularity as number) - (b.popularity as number));
  const mids = midCandidates(data.ranked);
  const longs = longCandidates(data.ranked);

  const holeCard = (h: RankedItem, kind: '中穴' | '大穴') => (
    <div key={`${kind}-${h.horseNumber}`} className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 text-[11px] text-slate-300 space-y-0.5">
      <p className={`font-black text-xs ${kind === '大穴' ? 'text-purple-300' : 'text-amber-300'}`}>
        <Star className="w-3 h-3 inline mr-1" />
        {kind}候補
      </p>
      {explainHorse(h, pace).map((l, i) => (
        <p key={i} className={i === 0 ? 'font-bold text-slate-100' : ''}>
          {l}
        </p>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
        <h3 className="text-base font-black text-white flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-rose-400" />
          人気馬（1〜3番人気）の死角
        </h3>
        {!hasOdds ? (
          <p className="text-xs text-slate-400">単勝オッズ（人気）が未取得のため表示できません。</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {favorites.map((h) => {
              const w = weakPoints(h);
              return (
                <div key={h.horseNumber} className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 text-[11px]">
                  <p className="text-xs font-black text-white">
                    {h.popularity}番人気　{h.horseNumber} {h.horseName}
                    <span className="ml-1 font-normal text-slate-400">
                      （データ{h.rank}位・{h.total.toFixed(1)}点{h.mark ? `・${h.mark}` : ''}）
                    </span>
                  </p>
                  {w.length === 0 ? (
                    <p className="mt-1 text-emerald-300">実データの範囲では目立った死角はありません</p>
                  ) : (
                    <ul className="mt-1 space-y-0.5 text-rose-200 list-disc pl-4">
                      {w.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="text-[10px] text-slate-500">
          死角の基準：データ予想の項目が{WEAK_SCORE}点未満、休み明け（91日以上）、中1週以内、乗り替わり、馬体重±10kg以上、データ予想の順位が人気より{RANK_GAP}つ以上下、データ不足。危険度の点数化はしていません。
        </p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
        <h3 className="text-base font-black text-white flex items-center gap-2">
          <Star className="w-4 h-4 text-amber-400" />
          中穴・大穴の推奨（3連単予想と同じ条件）
        </h3>
        {!hasOdds ? (
          <p className="text-xs text-slate-400">単勝オッズ（人気）が未取得のため選べません。</p>
        ) : mids.length + longs.length === 0 ? (
          <p className="text-xs text-slate-400">条件に合う馬はいません。</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {mids.map((h) => holeCard(h, '中穴'))}
            {longs.map((h) => holeCard(h, '大穴'))}
          </div>
        )}
        <p className="text-[10px] text-slate-500">
          中穴＝◎◯▲以外で、4〜9番人気かつデータ予想の順位が人気より3つ以上高い馬。大穴＝◎◯▲以外で、10番人気以下かつデータ予想が8位以内の馬（それぞれ上位2頭）。
        </p>
      </div>
    </div>
  );
};
