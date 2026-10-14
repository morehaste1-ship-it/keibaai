import React, { useState } from 'react';
import { History, Loader2, AlertCircle } from 'lucide-react';
import type { TrackCondition } from '../types/keiba';

interface CollectYear {
  year: number;
  status: 'saved' | 'not_found' | 'mismatch' | 'error';
  date?: string;
  venueName?: string;
  alreadySaved?: boolean;
  message: string;
}

interface ConditionSummary {
  condition: string | null;
  races: number;
  years: string[];
  favorite: { races: number; win: number; top3: number };
  top3Corner: { horses: number; average: number | null; frontShare: number | null };
  top3AvgPopularity: number | null;
}

/** 詳細を表示する馬場（all = 全馬場） */
type DetailCondition = 'all' | '良' | '稍重' | '重' | '不良';
const DETAIL_OPTIONS: DetailCondition[] = ['all', '良', '稍重', '重', '不良'];
const condLabel = (c: string | null) => (c === null || c === 'all' ? '全馬場' : c);
/** これ未満の回数は「少数」として参考扱いにする */
const FEW_RACES = 3;

interface CornerHorse {
  year: string;
  date: string;
  venueName: string;
  trackCondition: string | null;
  finishPosition: number;
  horseNumber: number;
  horseName: string | null;
  corner4: number | null;
  passing: string | null;
  headcount: number | null;
}

interface FavoriteWin {
  year: string;
  date: string;
  venueName: string;
  horseNumber: number;
  horseName: string | null;
  winOdds: number | null;
  headcount: number | null;
  corner4: number | null;
  passing: string | null;
}

interface Analysis {
  race: { raceKey: string; name: string; venueName: string; surface: string; distance: number; condition: string | null; raceCondition: string | null };
  raceCount: number;
  byCondition: ConditionSummary[];
  substituteYears: { year: string; venueName: string }[];
  favorite: { races: number; win: number; second: number; third: number; outside: number; unknown: number };
  top3Corner: {
    horses: number;
    average: number | null;
    distribution: { position: number; count: number }[];
    buckets: { label: string; count: number }[];
    unknown: number;
    list: CornerHorse[];
  };
  favoriteWins: { count: number; averageWinOdds: number | null; averageHeadcount: number | null; list: FavoriteWin[] };
  notes: string[];
}

const STATUS_LABEL: Record<CollectYear['status'], string> = {
  saved: '保存',
  not_found: '未検出',
  mismatch: '条件不一致',
  error: 'エラー',
};

const STATUS_CLASS: Record<CollectYear['status'], string> = {
  saved: 'text-emerald-300 border-emerald-500/40',
  not_found: 'text-slate-400 border-slate-700',
  mismatch: 'text-amber-300 border-amber-500/40',
  error: 'text-red-300 border-red-500/40',
};

interface HistoryPanelProps {
  raceKey: string;
  condition: TrackCondition;
}

export const HistoryPanel: React.FC<HistoryPanelProps> = ({ raceKey, condition }) => {
  const [busy, setBusy] = useState<'collect' | 'analyze' | null>(null);
  const [error, setError] = useState<string>('');
  const [years, setYears] = useState<CollectYear[]>([]);
  const [seriesVenue, setSeriesVenue] = useState<string>('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [detail, setDetail] = useState<DetailCondition>('all');

  const runAnalyze = async (cond: DetailCondition = detail): Promise<void> => {
    const res = await fetch(
      `/api/history/analysis/${raceKey}?condition=${encodeURIComponent(cond)}&raceCondition=${encodeURIComponent(condition)}`,
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '分析に失敗しました');
    setAnalysis(data.analysis);
  };

  const handleAnalyze = async (cond: DetailCondition = detail) => {
    setBusy('analyze');
    setError('');
    setDetail(cond);
    try {
      await runAnalyze(cond);
    } catch (err: any) {
      setError(err.message || 'エラーが発生しました');
    } finally {
      setBusy(null);
    }
  };

  const handleCollect = async () => {
    setBusy('collect');
    setError('');
    setYears([]);
    try {
      const res = await fetch('/api/history/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raceKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '取得に失敗しました');
      setYears(data.years ?? []);
      setSeriesVenue(String(data.seriesKey ?? '').split('|')[1] ?? '');
      await runAnalyze();
    } catch (err: any) {
      setError(err.message || 'エラーが発生しました');
    } finally {
      setBusy(null);
    }
  };

  const pct = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : '-');

  return (
    <section className="max-w-7xl w-full mx-auto px-4 pt-4">
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-black text-white flex items-center gap-1.5">
            <History className="w-4 h-4 text-sky-400" />
            過去10年の同一レース分析
            <span className="text-[11px] font-semibold text-slate-400">（競走名・会場・芝ダ・距離が一致）</span>
          </h2>
          <div className="flex gap-2">
            <button
              onClick={handleCollect}
              disabled={busy !== null}
              className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {busy === 'collect' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {busy === 'collect' ? '取得中（数分かかります）…' : '過去10年を取得（DB保存）'}
            </button>
            <button
              onClick={() => handleAnalyze()}
              disabled={busy !== null}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === 'analyze' ? '分析中…' : '分析を表示'}
            </button>
          </div>
        </div>

        <p className="text-[11px] text-slate-400">
          今回の馬場: <span className="font-bold text-slate-200">{condition}</span>（画面上部の馬場の選択）。過去の結果は馬場ごとに集計します
        </p>

        {error && (
          <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {error}
          </div>
        )}

        {years.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {years.map((y) => (
              <span
                key={y.year}
                title={y.message}
                className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border bg-slate-950 ${STATUS_CLASS[y.status]}`}
              >
                {y.year}年 {STATUS_LABEL[y.status]}
                {y.status === 'saved' && y.venueName && seriesVenue && y.venueName !== seriesVenue && `（${y.venueName}）`}
                {y.alreadySaved && <span className="text-slate-500 font-normal">・済</span>}
              </span>
            ))}
          </div>
        )}

        {analysis && (
          <div className="flex flex-col gap-4 pt-2 border-t border-slate-800">
            <p className="text-xs text-slate-300 font-semibold">
              {analysis.race.name}（{analysis.race.venueName} {analysis.race.surface}{analysis.race.distance}m）
              ・保存 {analysis.byCondition[0]?.races ?? 0} 回
              {analysis.substituteYears.length > 0 && (
                <span className="text-slate-500 font-normal">
                  （うち代替開催 {analysis.substituteYears.map((x) => `${x.year}年${x.venueName}`).join('・')}）
                </span>
              )}
            </p>

            {/* 0. 馬場ごとの傾向 */}
            <div>
              <h3 className="text-xs font-bold text-violet-300 mb-2">馬場ごとの傾向（行を押すと、下の詳細をその馬場で表示）</h3>
              <div className="overflow-x-auto border border-slate-800 rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-slate-900 text-slate-400">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-semibold">馬場</th>
                      <th className="text-left px-2 py-1.5 font-semibold">回数（年）</th>
                      <th className="text-left px-2 py-1.5 font-semibold">1番人気 1着／3着内</th>
                      <th className="text-left px-2 py-1.5 font-semibold">3着内の平均人気</th>
                      <th className="text-left px-2 py-1.5 font-semibold">3着内の4角平均</th>
                      <th className="text-left px-2 py-1.5 font-semibold">3着内で4角3番手以内</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.byCondition.map((c) => {
                      const key: DetailCondition = (c.condition ?? 'all') as DetailCondition;
                      const isRace = c.condition !== null && c.condition === condition;
                      const selected = key === detail;
                      return (
                        <tr
                          key={key}
                          onClick={() => c.races > 0 && handleAnalyze(key)}
                          className={`border-t border-slate-800 ${c.races > 0 ? 'cursor-pointer hover:bg-slate-800/60' : 'text-slate-600'} ${
                            selected ? 'bg-violet-500/10' : ''
                          } ${c.races > 0 ? 'text-slate-200' : ''}`}
                        >
                          <td className="px-2 py-1 font-bold whitespace-nowrap">
                            {condLabel(c.condition)}
                            {isRace && <span className="ml-1 text-amber-300 font-semibold">今回</span>}
                            {selected && <span className="ml-1 text-violet-300 font-semibold">表示中</span>}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap">
                            {c.races > 0 ? (
                              <>
                                {c.races}回
                                <span className="text-slate-500">（{c.years.map((y) => y.slice(2)).join('・')}）</span>
                                {c.condition !== null && c.races < FEW_RACES && <span className="ml-1 text-amber-400/80">少数</span>}
                              </>
                            ) : (
                              'なし'
                            )}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap">
                            {c.favorite.races > 0 ? `${c.favorite.win}／${c.favorite.top3}（${c.favorite.races}回中）` : '-'}
                          </td>
                          <td className="px-2 py-1">{c.top3AvgPopularity !== null ? `${c.top3AvgPopularity}番人気` : '-'}</td>
                          <td className="px-2 py-1">{c.top3Corner.average !== null ? `${c.top3Corner.average}番手` : '-'}</td>
                          <td className="px-2 py-1">
                            {c.top3Corner.frontShare !== null ? `${Math.round(c.top3Corner.frontShare * 100)}%` : '-'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mt-2 text-[11px]">
                <span className="text-slate-400">詳細の馬場:</span>
                {DETAIL_OPTIONS.map((o) => (
                  <button
                    key={o}
                    onClick={() => handleAnalyze(o)}
                    disabled={busy !== null}
                    className={`px-2 py-0.5 rounded-md border font-semibold ${
                      o === detail ? 'bg-violet-500/20 text-violet-200 border-violet-500/50' : 'border-slate-700 text-slate-400 hover:bg-slate-800'
                    }`}
                  >
                    {condLabel(o)}
                  </button>
                ))}
                <span className="text-slate-500">（以下の1〜3は「{condLabel(detail)}」で {analysis.raceCount} 回分）</span>
              </div>
            </div>

            {/* 1. 1番人気の着順 */}
            <div>
              <h3 className="text-xs font-bold text-amber-300 mb-2">1. 1番人気の着順（{analysis.favorite.races} 回）</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { label: '1着', n: analysis.favorite.win },
                  { label: '2着', n: analysis.favorite.second },
                  { label: '3着', n: analysis.favorite.third },
                  { label: '着外', n: analysis.favorite.outside },
                ].map((c) => (
                  <div key={c.label} className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
                    <p className="text-[11px] text-slate-400">{c.label}</p>
                    <p className="text-lg font-black text-white">
                      {c.n}
                      <span className="text-[11px] font-semibold text-slate-400 ml-1">
                        ({pct(c.n, analysis.favorite.races)})
                      </span>
                    </p>
                  </div>
                ))}
              </div>
              {analysis.favorite.unknown > 0 && (
                <p className="text-[11px] text-slate-500 mt-1">着順不明（取消・除外など）: {analysis.favorite.unknown} 回</p>
              )}
            </div>

            {/* 2. 3着以内の4コーナー通過順 */}
            <div>
              <h3 className="text-xs font-bold text-emerald-300 mb-2">
                2. 3着以内の馬の4コーナー通過順（{analysis.top3Corner.horses} 頭）
                {analysis.top3Corner.average !== null && (
                  <span className="text-slate-300 font-semibold ml-2">平均 {analysis.top3Corner.average} 番手</span>
                )}
              </h3>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {analysis.top3Corner.buckets.map((b) => (
                  <span key={b.label} className="px-2 py-0.5 rounded-md text-[11px] font-semibold border border-slate-700 bg-slate-950 text-slate-200">
                    {b.label}: {b.count} 頭
                  </span>
                ))}
                {analysis.top3Corner.distribution.map((d) => (
                  <span key={d.position} className="px-2 py-0.5 rounded-md text-[11px] text-slate-400 border border-slate-800">
                    {d.position}番手×{d.count}
                  </span>
                ))}
              </div>
              {analysis.top3Corner.unknown > 0 && (
                <p className="text-[11px] text-slate-500 mb-2">通過順不明: {analysis.top3Corner.unknown} 頭</p>
              )}
              <div className="max-h-72 overflow-y-auto border border-slate-800 rounded-lg">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-900 text-slate-400">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-semibold">開催日</th>
                      <th className="text-left px-2 py-1.5 font-semibold">馬場</th>
                      <th className="text-left px-2 py-1.5 font-semibold">着順</th>
                      <th className="text-left px-2 py-1.5 font-semibold">馬番・馬名</th>
                      <th className="text-left px-2 py-1.5 font-semibold">4角</th>
                      <th className="text-left px-2 py-1.5 font-semibold">通過順</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.top3Corner.list.map((h) => (
                      <tr key={`${h.date}-${h.horseNumber}`} className="border-t border-slate-800 text-slate-200">
                        <td className="px-2 py-1 whitespace-nowrap">
                          {h.date}
                          {h.venueName !== analysis.race.venueName && <span className="text-slate-500">（{h.venueName}）</span>}
                        </td>
                        <td className="px-2 py-1">{h.trackCondition ?? '-'}</td>
                        <td className="px-2 py-1">{h.finishPosition}着</td>
                        <td className="px-2 py-1">{h.horseNumber} {h.horseName ?? ''}</td>
                        <td className="px-2 py-1 font-bold text-emerald-300">
                          {h.corner4 !== null ? `${h.corner4}番手` : '-'}
                        </td>
                        <td className="px-2 py-1 text-slate-400">{h.passing ?? '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 3. 1番人気が勝ったレース */}
            <div>
              <h3 className="text-xs font-bold text-sky-300 mb-2">
                3. 1番人気が勝った回（{analysis.favoriteWins.count} 回）
                {analysis.favoriteWins.averageWinOdds !== null && (
                  <span className="text-slate-300 font-semibold ml-2">
                    平均単勝 {analysis.favoriteWins.averageWinOdds} 倍 / 平均頭数 {analysis.favoriteWins.averageHeadcount} 頭
                  </span>
                )}
              </h3>
              {analysis.favoriteWins.list.length > 0 ? (
                <ul className="text-xs text-slate-200 flex flex-col gap-1">
                  {analysis.favoriteWins.list.map((w) => (
                    <li key={`${w.date}-${w.horseNumber}`} className="bg-slate-950 border border-slate-800 rounded-md px-2 py-1">
                      {w.date}
                      {w.venueName !== analysis.race.venueName ? `（${w.venueName}）` : ''} {w.horseName ?? ''}（{w.horseNumber}番）単勝 {w.winOdds ?? '-'} 倍 / {w.headcount ?? '-'}頭 / 4角 {w.corner4 !== null ? `${w.corner4}番手` : '-'}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-slate-500">該当なし</p>
              )}
            </div>

            <div className="text-[11px] text-slate-500 flex flex-col gap-0.5">
              {analysis.notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
