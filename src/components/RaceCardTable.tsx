import React, { useState } from 'react';
import { Horse, CourseCharacteristics, type AptitudeMatrixView } from '../types/keiba';
import { JRA_FRAME_COLORS, MARK_COLORS } from '../utils/jraColors';
import { getWinRateHeat, getQuinellaRateHeat, QUINELLA_RATE_LEVELS } from '../utils/heatmapUtils';
import { ChevronDown, ChevronUp, Star, Award, Zap, Shield, TrendingUp, HelpCircle, Flame, Sparkles } from 'lucide-react';

interface RaceCardTableProps {
  horses: Horse[];
  course: CourseCharacteristics;
  onSelectHorse?: (horse: Horse) => void;
  onNavigateToHeatmap?: () => void;
}

/** 状況別適性のランクの色（実データ） */
export const APT_RANK_CLASS: Record<string, string> = {
  S: 'bg-rose-500/20 text-rose-300',
  A: 'bg-emerald-500/20 text-emerald-300',
  B: 'bg-sky-500/20 text-sky-300',
  C: 'bg-slate-800 text-slate-400',
  none: 'bg-slate-900 text-slate-500 border border-slate-700',
};

type SortField = 'number' | 'aiScore' | 'odds' | 'expectedValue' | 'winProb' | 'quinellaProb';

export const RaceCardTable: React.FC<RaceCardTableProps> = ({
  horses,
  course,
  onNavigateToHeatmap,
}) => {
  const [expandedHorseId, setExpandedHorseId] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>('number');
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [isHeatmapMode, setIsHeatmapMode] = useState<boolean>(true);
  // 勝率・連対・複勝・期待値・穴/危険の札はエンジンの仮データ由来のため、スイッチを押したときだけ灰色で表示する
  const [showEngineRef, setShowEngineRef] = useState<boolean>(false);
  const engineSortFields: SortField[] = ['winProb', 'quinellaProb', 'expectedValue'];
  const effectiveSort: SortField = !showEngineRef && engineSortFields.includes(sortField) ? 'number' : sortField;

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(field === 'number' || field === 'odds');
    }
  };

  const sortedHorses = [...horses].sort((a, b) => {
    let aVal = a[effectiveSort] || 0;
    let bVal = b[effectiveSort] || 0;
    if (effectiveSort === 'aiScore') {
      // 順位で並べる（同点は順位の付け方＝馬番の小さい順に従う）。降順で1位が先頭
      aVal = a.dataRank ? -a.dataRank : -999;
      bVal = b.dataRank ? -b.dataRank : -999;
    }
    const asc = effectiveSort === sortField ? sortAsc : true;
    if (asc) return aVal > bVal ? 1 : -1;
    return aVal < bVal ? 1 : -1;
  });

  const toggleExpand = (id: string) => {
    setExpandedHorseId(expandedHorseId === id ? null : id);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
      {/* Table Top Controls */}
      <div className="p-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-950/50">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-black text-white flex items-center gap-2">
            <span>出馬表 ＆ AI予想印</span>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
              全{horses.length}頭
            </span>
          </h3>
          <p className="text-xs text-slate-400 hidden sm:inline">
            ※印や期待値をクリックすると選定ロジックを確認できます
          </p>
        </div>

        {/* Sort and Mode Buttons */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* 仮データの参考値の表示スイッチ */}
          <button
            onClick={() => setShowEngineRef(!showEngineRef)}
            title="勝率・連対・複勝・期待値・穴/危険の札は、エンジンの仮の能力値から計算した参考値です（実データの裏付けなし）"
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition border ${
              showEngineRef ? 'bg-slate-700 text-slate-200 border-slate-500' : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700'
            }`}
          >
            {showEngineRef ? '仮データの参考値を隠す' : '仮データの参考値を表示'}
          </button>

          {showEngineRef && (
          <>
          {/* Heatmap Mode Toggle */}
          <button
            onClick={() => setIsHeatmapMode(!isHeatmapMode)}
            className={`px-3 py-1.5 rounded-lg text-xs font-black transition flex items-center gap-1.5 ${
              isHeatmapMode
                ? 'bg-gradient-to-r from-rose-500 to-orange-500 text-white shadow-md shadow-rose-500/20'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <Flame className={`w-3.5 h-3.5 ${isHeatmapMode ? 'fill-white text-white' : 'text-rose-400'}`} />
            <span>{isHeatmapMode ? '🔥 ヒートマップ: ON' : 'ヒートマップ: OFF'}</span>
          </button>

          {onNavigateToHeatmap && (
            <button
              onClick={onNavigateToHeatmap}
              className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-rose-300 border border-rose-500/30 transition flex items-center gap-1"
            >
              <Sparkles className="w-3.5 h-3.5 text-rose-400" />
              <span className="hidden sm:inline">ヒートマップ詳細分析へ</span>
            </button>
          )}
          </>
          )}

          <div className="h-4 w-px bg-slate-800 mx-1 hidden sm:block" />

          <span className="text-slate-400 font-bold mr-0.5">並び替え:</span>
          {[
            { key: 'quinellaProb' as SortField, label: '連対率' },
            { key: 'winProb' as SortField, label: '勝率' },
            { key: 'aiScore' as SortField, label: 'データ点' },
            { key: 'odds' as SortField, label: 'オッズ' },
            { key: 'expectedValue' as SortField, label: '期待値' },
            { key: 'number' as SortField, label: '馬番' },
          ]
            .filter((item) => showEngineRef || !engineSortFields.includes(item.key))
            .map((item) => (
            <button
              key={item.key}
              onClick={() => handleSort(item.key)}
              className={`px-2 py-1 rounded-lg font-bold transition flex items-center gap-1 ${
                effectiveSort === item.key
                  ? 'bg-rose-500 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {item.label}
              {effectiveSort === item.key && (sortAsc ? '▲' : '▼')}
            </button>
          ))}
        </div>
      </div>

      {/* Heatmap Legend Bar */}
      {showEngineRef && isHeatmapMode && (
        <div className="px-4 py-2 bg-slate-950/80 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="font-black text-rose-300 flex items-center gap-1">
              <Flame className="w-3.5 h-3.5 fill-rose-500 text-rose-500" />
              連対率・勝率ヒートマップ強度:
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {QUINELLA_RATE_LEVELS.map((lvl) => (
                <span
                  key={lvl.grade}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${lvl.bgClass} ${lvl.textClass} ${lvl.borderClass}`}
                >
                  {lvl.label}
                </span>
              ))}
            </div>
          </div>
          <span className="text-slate-400 hidden md:inline">
            ※セル背景の暖色（赤・橙）が濃いほど上位入線（1〜2着）確率が高いことを示します
          </span>
        </div>
      )}

      {/* Main Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-950 text-slate-400 text-[11px] font-bold uppercase tracking-wider border-b border-slate-800">
              <th className="py-3 px-2 text-center w-12">枠/番</th>
              <th className="py-3 px-2 text-center w-14">AI印</th>
              <th className="py-3 px-3">馬名 / 性齢 / 斤量 / 騎手</th>
              <th className="py-3 px-3 hidden md:table-cell">血統 (父 / 母父)</th>
              <th className="py-3 px-2 text-center">脚質</th>
              <th className="py-3 px-3 text-right">単勝 (人気)</th>
              <th className="py-3 px-3 text-center" title="データ予想（実データ）の合計点と順位。配分を変えると連動します">データ点 (順位)</th>
              {showEngineRef && (
                <>
                  <th className="py-3 px-3 text-right text-slate-500">
                    {isHeatmapMode ? '連対率 / 勝率 (参考・仮データ)' : '勝率 / 連対 / 複勝 (参考・仮データ)'}
                  </th>
                  <th className="py-3 px-3 text-center text-slate-500">期待値(EV) (参考)</th>
                </>
              )}
              <th className="py-3 px-2 text-center w-10">詳細</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80 text-xs font-medium">
            {sortedHorses.map((horse) => {
              const frameInfo = JRA_FRAME_COLORS[horse.bracket] || JRA_FRAME_COLORS[1];
              const markColor = horse.mark ? MARK_COLORS[horse.mark] : null;
              const isExpanded = expandedHorseId === horse.id;
              const isTopPick = horse.mark === '◎';
              const isHolePick = horse.mark === '☆';
              const winHeat = getWinRateHeat(horse.winProb || 0);
              const quinellaHeat = getQuinellaRateHeat(horse.quinellaProb || 0);
              const isHotQuinella = (horse.quinellaProb || 0) >= 40;

              return (
                <React.Fragment key={horse.id}>
                  <tr
                    onClick={() => toggleExpand(horse.id)}
                    className={`transition-colors cursor-pointer hover:bg-slate-800/60 ${
                      isHeatmapMode && isHotQuinella
                        ? 'bg-rose-950/20'
                        : isTopPick
                        ? 'bg-red-950/15'
                        : isHolePick
                        ? 'bg-purple-950/15'
                        : isExpanded
                        ? 'bg-slate-800/40'
                        : ''
                    }`}
                  >
                    {/* Bracket & Horse Number */}
                    <td className="py-3 px-2 text-center">
                      <div className="flex flex-col items-center justify-center gap-0.5">
                        <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${frameInfo.badge}`}>
                          {horse.bracket}
                        </span>
                        <span className="font-mono text-base font-black text-white">
                          {horse.number}
                        </span>
                      </div>
                    </td>

                    {/* AI Mark */}
                    <td className="py-3 px-2 text-center">
                      {horse.mark ? (
                        <div className="flex flex-col items-center">
                          <span
                            className={`w-7 h-7 rounded-lg flex items-center justify-center text-sm font-black border ${markColor?.bg} ${markColor?.text}`}
                          >
                            {horse.mark}
                          </span>
                          <span className="text-[10px] text-slate-400 mt-0.5">
                            {markColor?.label}
                          </span>
                        </div>
                      ) : (
                        <span className="text-slate-600">-</span>
                      )}
                    </td>

                    {/* Horse Name & Info */}
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-black text-white hover:text-emerald-400 transition">
                          {horse.name}
                        </span>
                        {showEngineRef && horse.isDarkHorse && (
                          <span title="参考（仮データ）" className={`opacity-50 grayscale px-1.5 py-0.2 rounded text-[10px] font-black border flex items-center gap-0.5 ${
                            horse.darkHorseCategory === '大穴'
                              ? 'bg-purple-500/20 text-purple-300 border-purple-500/50'
                              : 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                          }`}>
                            <Star className="w-2.5 h-2.5 fill-current" />
                            {horse.darkHorseCategory || '穴注目'}
                          </span>
                        )}
                        {showEngineRef && horse.topFavRisk && horse.popularity <= 3 && horse.topFavRisk.riskLevel === '高危険' && (
                          <span title="参考（仮データ）" className="opacity-50 grayscale px-1.5 py-0.2 rounded text-[10px] font-black bg-rose-500/20 text-rose-300 border border-rose-500/50 flex items-center gap-0.5">
                            3着外危険
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                        <span>{horse.gender}{horse.age}</span>
                        <span>•</span>
                        <span>{horse.weight}kg</span>
                        <span>•</span>
                        <span className="text-slate-200 font-bold">{horse.jockey}</span>
                        <span className="text-slate-400">調:{horse.trainer}</span>
                        {horse.conditionStatus && (
                          <span className={`px-1 py-0.2 rounded text-[10px] font-bold ${
                            horse.conditionStatus === '絶好調' ? 'bg-emerald-500/20 text-emerald-300' :
                            horse.conditionStatus === '不安' ? 'bg-rose-500/20 text-rose-300' : 'bg-slate-800 text-slate-300'
                          }`}>
                            {horse.conditionStatus}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Pedigree */}
                    <td className="py-3 px-3 hidden md:table-cell">
                      {horse.pedigreeKnown ? (
                        <>
                          <div className="text-xs font-semibold text-slate-200">父: {horse.pedigree.sire}</div>
                          <div className="text-[11px] text-slate-400">
                            母父: {horse.pedigree.damSire || '-'}
                            {horse.pedigree.sireLine ? ` (${horse.pedigree.sireLine})` : ''}
                          </div>
                        </>
                      ) : (
                        <div className="text-[11px] text-slate-500" title="血統は出走数の少ない馬から夜間に取得します">
                          {horse.dataTotal === undefined ? '読み込み中…' : '未取得'}
                        </div>
                      )}
                    </td>

                    {/* Running Style */}
                    <td className="py-3 px-2 text-center">
                      {horse.dataTotal === undefined || !horse.dataStyle ? (
                        <span className="text-[11px] text-slate-500" title="直近10走の最初のコーナーの位置から判定します">
                          {horse.dataTotal === undefined ? '…' : '不明'}
                        </span>
                      ) : (
                      <span
                        title="直近10走で最も多い脚質（最初のコーナーの位置で判定）"
                        className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                          horse.runningStyle === '逃げ'
                            ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                            : horse.runningStyle === '先行'
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            : horse.runningStyle === '差し'
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                        }`}
                      >
                        {horse.runningStyle}
                      </span>
                      )}
                    </td>

                    {/* Odds & Popularity */}
                    <td className="py-3 px-3 text-right">
                      <div className="font-mono text-sm font-black text-amber-300">
                        {horse.odds.toFixed(1)}倍
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {horse.popularity}番人気
                      </div>
                    </td>

                    {/* データ点（データ予想の合計点・順位） */}
                    <td className="py-3 px-3 text-center">
                      {horse.dataTotal === undefined ? (
                        <span className="text-[11px] text-slate-500">…</span>
                      ) : (
                        <div className="flex flex-col items-center">
                          <span className="font-mono text-sm font-black text-white">
                            {horse.dataTotal.toFixed(1)}
                            <span className="text-[10px] text-slate-400 font-normal">点</span>
                          </span>
                          <div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden mt-1">
                            <div
                              className={`h-full rounded-full ${horse.dataRank === 1 ? 'bg-gradient-to-r from-amber-400 to-rose-500' : (horse.dataRank ?? 99) <= 3 ? 'bg-emerald-400' : 'bg-slate-500'}`}
                              style={{ width: `${Math.min(Math.max(horse.dataTotal, 0), 100)}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-slate-400 mt-0.5">{horse.dataRank}位</span>
                        </div>
                      )}
                    </td>

                    {/* Win / Quinella / Place Prob（参考・仮データ。スイッチON時のみ灰色で表示） */}
                    {showEngineRef && (
                    <td className="py-2.5 px-3 text-right font-mono opacity-50 grayscale">
                      {isHeatmapMode ? (
                        <div
                          className={`p-1.5 rounded-xl border transition shadow-sm ${quinellaHeat.bgClass} ${quinellaHeat.borderClass}`}
                        >
                          <div className="flex items-center justify-between gap-1 mb-0.5">
                            <span className="text-[10px] text-slate-300 font-bold flex items-center gap-0.5">
                              {(horse.quinellaProb || 0) >= 35 && (
                                <Flame className="w-3 h-3 text-rose-400 fill-rose-400" />
                              )}
                              連対
                            </span>
                            <span className={`font-mono text-xs font-black ${quinellaHeat.textClass}`}>
                              {horse.quinellaProb}%
                            </span>
                          </div>
                          {/* Quinella Heat Bar */}
                          <div className="w-full h-1.5 bg-slate-900/90 rounded-full overflow-hidden mb-1">
                            <div
                              className={`h-full rounded-full bg-gradient-to-r ${quinellaHeat.heatBarColor}`}
                              style={{ width: `${Math.min(((horse.quinellaProb || 0) / 60) * 100, 100)}%` }}
                            />
                          </div>
                          <div className="flex items-center justify-between text-[10px]">
                            <span className={`font-mono ${winHeat.textClass}`}>
                              勝 {horse.winProb}%
                            </span>
                            <span className="text-slate-400">
                              複 <span className="text-blue-300 font-semibold">{horse.placeProb}%</span>
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div className="flex items-center justify-end gap-1.5">
                            <span className="text-[10px] text-slate-400">勝</span>
                            <span
                              className={`text-xs font-bold px-1 rounded ${
                                (horse.winProb || 0) >= 20 ? 'bg-rose-500/20 text-rose-300' : 'text-white'
                              }`}
                            >
                              {horse.winProb}%
                            </span>
                          </div>
                          <div className="flex items-center justify-end gap-1.5 text-[10px]">
                            <span className="text-slate-400">連</span>
                            <span className="text-emerald-400 font-bold">{horse.quinellaProb}%</span>
                            <span className="text-slate-500">/</span>
                            <span className="text-blue-400 font-semibold">{horse.placeProb}%</span>
                          </div>
                        </div>
                      )}
                    </td>

                    )}

                    {/* Expected Value (EV)（参考・仮データ） */}
                    {showEngineRef && (
                    <td className="py-3 px-3 text-center opacity-50 grayscale">
                      <span
                        className={`inline-block font-mono text-xs font-black px-2 py-0.5 rounded ${
                          (horse.expectedValue || 1.0) >= 1.25
                            ? 'bg-amber-400 text-slate-950 font-black ring-2 ring-amber-400/40 shadow-sm'
                            : (horse.expectedValue || 1.0) >= 1.05
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            : 'text-slate-400'
                        }`}
                      >
                        {horse.expectedValue?.toFixed(2) || '1.00'}
                      </span>
                    </td>
                    )}

                    {/* Expand Arrow */}
                    <td className="py-3 px-2 text-center text-slate-400">
                      {isExpanded ? (
                        <ChevronUp className="w-4 h-4 text-emerald-400 mx-auto" />
                      ) : (
                        <ChevronDown className="w-4 h-4 mx-auto" />
                      )}
                    </td>
                  </tr>

                  {/* Expanded Detail Drawer */}
                  {isExpanded && (
                    <tr className="bg-slate-950/80 border-b border-slate-800">
                      <td colSpan={showEngineRef ? 10 : 8} className="p-4">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          {/* Reason for Mark & AI View */}
                          <div className="md:col-span-2 space-y-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-black text-emerald-400 flex items-center gap-1">
                                <Award className="w-3.5 h-3.5" />
                                AI予想印選定ロジック
                              </span>
                              {horse.mark && (
                                <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-800 text-slate-200">
                                  印: {horse.mark} ({MARK_COLORS[horse.mark]?.label})
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-slate-300 leading-relaxed bg-slate-900/90 p-3 rounded-xl border border-slate-800 font-medium">
                              {horse.markReason || '総合指数およびコース適性から上位に格付けされています。'}
                            </p>

                            {/* Top Favorite Failure Risk Warning in Drawer */}
                            {showEngineRef && horse.topFavRisk && horse.popularity <= 3 && (
                              <div className={`opacity-50 grayscale p-3 rounded-xl border ${
                                horse.topFavRisk.riskLevel === '高危険'
                                  ? 'bg-rose-950/30 border-rose-500/40 text-rose-300'
                                  : 'bg-amber-950/30 border-amber-500/40 text-amber-300'
                              }`}>
                                <div className="flex items-center gap-1.5 font-black text-xs mb-1.5">
                                  <span>🚨 3着圏外（馬券外）リスク評価: {horse.topFavRisk.riskLevel}</span>
                                </div>
                                <ul className="space-y-1 text-[11px] text-slate-300 leading-snug">
                                  {horse.topFavRisk.reasons.map((r, i) => (
                                    <li key={i} className="flex items-start gap-1">
                                      <span className="text-rose-400 font-bold">•</span>
                                      <span>{r}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {/* Past Races Snapshot */}
                            {horse.pastRaces && horse.pastRaces.length > 0 && (
                              <div className="mt-3">
                                <div className="text-[11px] font-bold text-slate-400 mb-1.5">近走戦績:</div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                  {horse.pastRaces.map((pr, idx) => (
                                    <div key={idx} className="bg-slate-900 p-2.5 rounded-lg border border-slate-800 text-[11px]">
                                      <div className="flex items-center justify-between text-slate-200 font-bold mb-1">
                                        <span>{pr.raceName} ({pr.grade})</span>
                                        <span className={`px-1.5 py-0.2 rounded font-black ${
                                          pr.rank === 1 ? 'bg-amber-400 text-slate-950' : pr.rank <= 3 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'
                                        }`}>
                                          {pr.rank}着 / {pr.totalHorses}頭
                                        </span>
                                      </div>
                                      <div className="text-slate-400 flex items-center justify-between">
                                        <span>{pr.track}{pr.surface}{pr.distance}m ({pr.condition})</span>
                                        <span className="font-mono text-slate-300">上り3F: {pr.last3F}s</span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Aptitude Matrix */}
                          <div className="bg-slate-900/90 p-3.5 rounded-xl border border-slate-800 flex flex-col justify-between">
                            <div>
                              <div className="text-xs font-black text-slate-200 mb-2.5 flex items-center gap-1.5">
                                <Zap className="w-3.5 h-3.5 text-amber-400" />
                                状況別適性診断 (実データ)
                              </div>
                              {!horse.dataAptitude ? (
                                <p className="text-[11px] text-slate-500">データ予想の読み込み後に表示されます</p>
                              ) : (
                                <AptitudeDiagnosis apt={horse.dataAptitude} />
                              )}
                            </div>

                            <div className="mt-3 pt-2.5 border-t border-slate-800 flex items-center justify-between text-[11px]">
                              <span className="text-slate-400">馬体重(前走比):</span>
                              <span className="font-mono text-slate-200">
                                {horse.horseWeight}kg ({horse.weightChange >= 0 ? `+${horse.weightChange}` : horse.weightChange})
                              </span>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/** ランクの小さな札（根拠はマウスを乗せると表示） */
export const RankBadge: React.FC<{ rank: string | null; detail: string; suffix?: string }> = ({ rank, detail, suffix }) => (
  <span title={detail} className={`inline-block font-black px-1.5 py-0.5 rounded text-[11px] cursor-help ${APT_RANK_CLASS[rank ?? 'none']}`}>
    {rank ?? '不足'}
    {suffix && <span className="font-normal ml-0.5">{suffix}</span>}
  </span>
);

/** 状況別適性診断（自身の成績と血統の傾向を分けて表示） */
const AptitudeDiagnosis: React.FC<{ apt: AptitudeMatrixView }> = ({ apt }) => (
  <div className="space-y-3 text-xs">
    <table className="w-full">
      <thead>
        <tr className="text-[10px] text-slate-500">
          <th className="text-left font-normal">項目</th>
          <th className="text-center font-normal">自身の成績</th>
          <th className="text-center font-normal">血統の傾向</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className="py-1 text-slate-400">重馬場・道悪</td>
          <td className="text-center"><RankBadge rank={apt.heavy.own.rank} detail={apt.heavy.own.detail} /></td>
          <td className="text-center"><RankBadge rank={apt.heavy.pedigree.rank} detail={apt.heavy.pedigree.detail} /></td>
        </tr>
        <tr>
          <td className="py-1 text-slate-400">ベスト距離</td>
          <td className="text-center text-slate-200 font-semibold cursor-help" title={apt.bestDistance.own.detail}>
            {apt.bestDistance.own.label ?? <span className="text-slate-500 font-normal">不足</span>}
          </td>
          <td className="text-center text-slate-200 font-semibold cursor-help" title={apt.bestDistance.pedigree.detail}>
            {apt.bestDistance.pedigree.label ?? <span className="text-slate-500 font-normal">不足</span>}
          </td>
        </tr>
        {apt.features.map((f) => (
          <tr key={f.key}>
            <td className="py-1 text-slate-400" title={f.venues.join('・')}>
              {f.label}
              <span className="block text-[10px] text-slate-600">{f.venues.join('・')}</span>
            </td>
            <td className="text-center"><RankBadge rank={f.rank} detail={f.detail} /></td>
            <td className="text-center text-[10px] text-slate-600" title="競馬場別の産駒成績は取得していません">—</td>
          </tr>
        ))}
      </tbody>
    </table>

    <div>
      <p className="text-[10px] text-slate-500 mb-1">競馬場別（自身の成績・3着内/出走）</p>
      <div className="grid grid-cols-5 gap-1">
        {apt.venues.map((v) => (
          <div
            key={v.venue}
            title={v.detail}
            className={`rounded px-1 py-0.5 text-center cursor-help border ${
              v.venue === apt.currentVenue ? 'border-emerald-500/70 bg-emerald-950/30' : 'border-slate-800'
            }`}
          >
            <div className="text-[10px] text-slate-400">{v.venue}</div>
            {v.n === 0 ? (
              <div className="text-[10px] text-slate-600">-</div>
            ) : (
              <div className="text-[10px]">
                <span className={`font-black px-1 rounded ${APT_RANK_CLASS[v.rank ?? 'none']}`}>{v.rank}</span>
                <span className="text-slate-400 ml-0.5">{v.top3}/{v.n}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>

    <p className="text-[10px] text-slate-500 pt-1 border-t border-slate-800">
      自身の成績は出走数で補正した3着以内率、血統は父・母父の産駒成績（父2：母父1）。複勝率60%=100点として S(80点〜)・A(60〜)・B(40〜)・C(〜39)。緑枠は今回の競馬場。札にマウスを乗せると根拠が出ます
    </p>
  </div>
);
