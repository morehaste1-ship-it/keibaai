import React, { useCallback, useEffect, useState } from 'react';
import { Link2, Loader2, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';

interface RateRow {
  label: string;
  rides: number;
  top3: number;
  wins: number;
}

interface MatchupItem {
  horseNumber: number | null;
  frameNumber: number | null;
  horseName: string;
  horseId: string | null;
  jockeyId: string | null;
  jockeyName: string | null;
  horseStatus: 'ok' | 'no_id' | 'not_fetched' | 'no_runs';
  mainStyle: string | null;
  mainStyleShare: number | null;
  styleCounts: Record<string, number>;
  horseStyleRates: RateRow[];
  jockeyStyleRate: RateRow | null;
  jockeyFrameRate: RateRow | null;
  combo: RateRow | null;
  recent: {
    date: string;
    venueName: string | null;
    raceName: string | null;
    surface: string | null;
    distance: number | null;
    trackCondition: string | null;
    headcount: number | null;
    frameNumber: number | null;
    popularity: number | null;
    finishText: string | null;
    jockeyName: string | null;
    passing: string | null;
    runningStyle: string | null;
    last3f: number | null;
  }[];
}

interface Analysis {
  note: string;
  items: MatchupItem[];
}

interface CrawlStatus {
  running: boolean;
  totalHorses: number;
  doneHorses: number;
  skippedHorses: number;
  pagesFetched: number;
  stoppedReason: string | null;
  errors: string[];
  finishedAt: string | null;
}

const rateText = (r: RateRow | null) =>
  r && r.rides > 0 ? `${Math.round((r.top3 / r.rides) * 100)}%（${r.top3}/${r.rides}）` : '-';

const STATUS_TEXT: Record<MatchupItem['horseStatus'], string> = {
  ok: '',
  no_id: '馬ID未保存（出馬表を取り込み直してください）',
  not_fetched: '過去走未取得',
  no_runs: 'JRAの出走歴なし',
};

export const MatchupPanel: React.FC<{ raceKey: string }> = ({ raceKey }) => {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [crawl, setCrawl] = useState<CrawlStatus | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const loadAnalysis = useCallback(async () => {
    const res = await fetch(`/api/matchup/${raceKey}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '相性分析の読み込みに失敗しました');
    setAnalysis(data.analysis);
  }, [raceKey]);

  const loadStatus = useCallback(async () => {
    const res = await fetch('/api/horses/crawl-status');
    const data = await res.json();
    setCrawl(data.crawl);
    return data.crawl as CrawlStatus;
  }, []);

  useEffect(() => {
    loadAnalysis().catch((e) => setError(e.message));
    loadStatus().catch(() => {});
  }, [loadAnalysis, loadStatus]);

  useEffect(() => {
    if (!crawl?.running) return;
    const timer = setInterval(async () => {
      try {
        const s = await loadStatus();
        if (!s.running) await loadAnalysis();
      } catch {
        // 次回の確認で再試行
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [crawl?.running, loadStatus, loadAnalysis]);

  const handleCrawl = async () => {
    setError('');
    try {
      const res = await fetch('/api/horses/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raceKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '取得を開始できませんでした');
      await loadStatus();
    } catch (e: any) {
      setError(e.message || 'エラーが発生しました');
    }
  };

  return (
    <section className="max-w-7xl w-full mx-auto px-4 pt-4">
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-black text-white flex items-center gap-1.5">
            <Link2 className="w-4 h-4 text-amber-400" />
            馬の脚質 × 騎手の相性
          </h2>
          <button
            onClick={handleCrawl}
            disabled={crawl?.running}
            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {crawl?.running && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {crawl?.running ? '取得中…' : 'このレースの馬の過去走を取得（DB保存）'}
          </button>
        </div>

        {crawl?.running && (
          <p className="text-[11px] text-slate-300">
            取得中: {crawl.doneHorses}/{crawl.totalHorses}頭（5秒間隔。1頭1ページ。6日以内に取得済みの馬は読みません）
          </p>
        )}
        {!crawl?.running && crawl?.finishedAt && (crawl.stoppedReason || crawl.errors.length > 0) && (
          <div className="text-[11px] text-amber-300">
            {crawl.stoppedReason && <p>{crawl.stoppedReason}</p>}
            {crawl.errors.map((e) => (
              <p key={e}>{e}</p>
            ))}
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {error}
          </div>
        )}

        {analysis && (
          <>
            <p className="text-[11px] text-slate-500">{analysis.note}</p>
            <div className="overflow-x-auto border border-slate-800 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-slate-900 text-slate-400">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-semibold">枠・馬番・馬名</th>
                    <th className="text-left px-2 py-1.5 font-semibold">馬の主な脚質</th>
                    <th className="text-left px-2 py-1.5 font-semibold">騎手</th>
                    <th className="text-left px-2 py-1.5 font-semibold">騎手×同脚質の複勝率</th>
                    <th className="text-left px-2 py-1.5 font-semibold">騎手×今回の枠の複勝率</th>
                    <th className="text-left px-2 py-1.5 font-semibold">コンビ成績</th>
                    <th className="text-left px-2 py-1.5 font-semibold">近5走の着順</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.items.map((m) => {
                    const key = `${m.horseNumber}-${m.horseName}`;
                    const isOpen = open === key;
                    return (
                      <React.Fragment key={key}>
                        <tr
                          className="border-t border-slate-800 text-slate-200 cursor-pointer hover:bg-slate-800/40"
                          onClick={() => setOpen(isOpen ? null : key)}
                        >
                          <td className="px-2 py-1 whitespace-nowrap">
                            {isOpen ? <ChevronDown className="w-3 h-3 inline" /> : <ChevronRight className="w-3 h-3 inline" />}{' '}
                            {m.frameNumber ?? '-'}枠 {m.horseNumber ?? '-'} {m.horseName}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap">
                            {m.horseStatus !== 'ok' ? (
                              <span className="text-slate-500">{STATUS_TEXT[m.horseStatus]}</span>
                            ) : m.mainStyle ? (
                              <span className="font-bold text-amber-300">
                                {m.mainStyle}
                                <span className="text-slate-400 font-normal ml-1">
                                  （{Math.round((m.mainStyleShare ?? 0) * 100)}%）
                                </span>
                              </span>
                            ) : (
                              '-'
                            )}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap">{m.jockeyName ?? '-'}</td>
                          <td className="px-2 py-1 whitespace-nowrap">{rateText(m.jockeyStyleRate)}</td>
                          <td className="px-2 py-1 whitespace-nowrap">
                            {m.jockeyFrameRate ? `${m.jockeyFrameRate.label} ${rateText(m.jockeyFrameRate)}` : '-'}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap">
                            {m.combo && m.combo.rides > 0
                              ? `${m.combo.rides}走 1着${m.combo.wins} 3着内${m.combo.top3}`
                              : m.horseStatus === 'ok'
                                ? '初コンビ'
                                : '-'}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap">{m.recent.map((r) => r.finishText || '-').join(' - ') || '-'}</td>
                        </tr>
                        {isOpen && m.horseStatus === 'ok' && (
                          <tr className="border-t border-slate-800 bg-slate-950/60">
                            <td colSpan={7} className="px-3 py-3">
                              <p className="text-[11px] font-bold text-slate-400 mb-1">
                                脚質の内訳（直近10走）:{' '}
                                {m.horseStyleRates
                                  .map((r) => `${r.label}${r.rides}回（3着内${r.top3}）`)
                                  .join(' / ') || '-'}
                                {m.horseId && (
                                  <a
                                    href={`https://db.netkeiba.com/horse/result/${m.horseId}/`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-sky-400 ml-2 underline font-normal"
                                  >
                                    netkeibaで開く
                                  </a>
                                )}
                              </p>
                              <div className="overflow-x-auto">
                                <table className="text-[11px] text-slate-200">
                                  <thead className="text-slate-500">
                                    <tr>
                                      {['日付', '会場', 'レース名', '距離', '馬場', '頭数', '枠', '人気', '着順', '騎手', '通過', '脚質', '上り'].map((h) => (
                                        <th key={h} className="text-left pr-3 font-semibold">{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {m.recent.map((r) => (
                                      <tr key={`${r.date}-${r.raceName}`}>
                                        <td className="pr-3">{r.date}</td>
                                        <td className="pr-3">{r.venueName ?? '-'}</td>
                                        <td className="pr-3">{r.raceName ?? '-'}</td>
                                        <td className="pr-3">{r.surface ?? ''}{r.distance ?? ''}</td>
                                        <td className="pr-3">{r.trackCondition ?? '-'}</td>
                                        <td className="pr-3">{r.headcount ?? '-'}</td>
                                        <td className="pr-3">{r.frameNumber ?? '-'}</td>
                                        <td className="pr-3">{r.popularity ?? '-'}</td>
                                        <td className="pr-3">{r.finishText ?? '-'}</td>
                                        <td className="pr-3">{r.jockeyName ?? '-'}</td>
                                        <td className="pr-3">{r.passing ?? '-'}</td>
                                        <td className="pr-3 font-bold text-amber-300">{r.runningStyle ?? '-'}</td>
                                        <td className="pr-3">{r.last3f ?? '-'}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
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
          </>
        )}
      </div>
    </section>
  );
};
