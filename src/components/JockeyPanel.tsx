import React, { useCallback, useEffect, useState } from 'react';
import { UserRound, Loader2, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';

interface RateRow {
  label: string;
  rides: number;
  top3: number;
  wins: number;
}

interface JockeyItem {
  jockeyId: string | null;
  name: string | null;
  horseNumber: number | null;
  horseName: string;
  status: 'ok' | 'no_id' | 'not_fetched';
  crawl: { backfillDone: boolean; newestDate: string | null; oldestDate: string | null } | null;
  rides: number;
  first: number;
  second: number;
  third: number;
  byFinish: { finish: number; count: number; styles: Record<string, number>; frames: Record<string, number> }[];
  styleRates: RateRow[];
  frameRates: RateRow[];
  surfaceRates: RateRow[];
  distanceRates: RateRow[];
  venueRates: RateRow[];
  conditionRates: RateRow[];
  current: RateRow | null;
  notes: { note: string; source?: string; checkedAt?: string }[];
  recent: {
    raceId: string;
    date: string;
    venueName: string | null;
    raceNo: number | null;
    raceName: string | null;
    headcount: number | null;
    frameNumber: number | null;
    horseNumber: number | null;
    popularity: number | null;
    finishText: string | null;
    horseName: string | null;
    surface: string | null;
    distance: number | null;
    trackCondition: string | null;
    passing: string | null;
    runningStyle: string | null;
  }[];
}

interface Analysis {
  fromDate: string;
  styleRule: string;
  items: JockeyItem[];
}

interface CrawlStatus {
  running: boolean;
  totalJockeys: number;
  doneJockeys: number;
  pagesFetched: number;
  pageBudget: number;
  stoppedReason: string | null;
  errors: string[];
  finishedAt: string | null;
}

const rate = (top3: number, rides: number) => (rides > 0 ? `${Math.round((top3 / rides) * 100)}%` : '-');

const RateChips: React.FC<{ title: string; rows: RateRow[] }> = ({ title, rows }) => (
  <div>
    <p className="text-[11px] font-bold text-slate-400 mb-1">{title}</p>
    <div className="flex flex-wrap gap-1">
      {rows.length === 0 && <span className="text-[11px] text-slate-500">-</span>}
      {rows.map((r) => (
        <span key={r.label} className="px-2 py-0.5 rounded-md text-[11px] border border-slate-700 bg-slate-950 text-slate-200">
          {r.label} <span className="font-bold text-emerald-300">{rate(r.top3, r.rides)}</span>
          <span className="text-slate-500">（{r.top3}/{r.rides}）</span>
        </span>
      ))}
    </div>
  </div>
);

const countText = (m: Record<string, number>) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}${v}`)
    .join(' / ') || '-';

export const JockeyPanel: React.FC<{ raceKey: string }> = ({ raceKey }) => {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [crawl, setCrawl] = useState<CrawlStatus | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const loadAnalysis = useCallback(async () => {
    const res = await fetch(`/api/jockeys/analysis/${raceKey}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '騎手分析の読み込みに失敗しました');
    setAnalysis(data.analysis);
  }, [raceKey]);

  const loadStatus = useCallback(async () => {
    const res = await fetch('/api/jockeys/crawl-status');
    const data = await res.json();
    setCrawl(data.crawl);
    return data.crawl as CrawlStatus;
  }, []);

  useEffect(() => {
    loadAnalysis().catch((e) => setError(e.message));
    loadStatus().catch(() => {});
  }, [loadAnalysis, loadStatus]);

  // 取得中は5秒ごとに進捗を確認し、終わったら分析を読み直す
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

  const handleCrawl = async (jockeyId?: string) => {
    setError('');
    try {
      const res = await fetch('/api/jockeys/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jockeyId ? { raceKey, jockeyId } : { raceKey }),
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
            <UserRound className="w-4 h-4 text-violet-400" />
            騎手分析（過去5年・JRA）
          </h2>
          <button
            onClick={() => handleCrawl()}
            disabled={crawl?.running}
            className="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {crawl?.running && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {crawl?.running ? '取得中…' : 'このレースの騎手成績を取得（DB保存）'}
          </button>
        </div>

        {crawl?.running && (
          <p className="text-[11px] text-slate-300">
            取得中: {crawl.doneJockeys}/{crawl.totalJockeys}人・{crawl.pagesFetched}/{crawl.pageBudget}ページ
            （5秒間隔。1人あたり数分〜十数分かかります。画面を閉じても取得は続きます）
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
            <p className="text-[11px] text-slate-500">
              集計期間: {analysis.fromDate} 以降 / {analysis.styleRule}
            </p>
            <div className="overflow-x-auto border border-slate-800 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-slate-900 text-slate-400">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-semibold">馬番・馬名</th>
                    <th className="text-left px-2 py-1.5 font-semibold">騎手</th>
                    <th className="text-right px-2 py-1.5 font-semibold">騎乗</th>
                    <th className="text-right px-2 py-1.5 font-semibold">1着</th>
                    <th className="text-right px-2 py-1.5 font-semibold">2着</th>
                    <th className="text-right px-2 py-1.5 font-semibold">3着</th>
                    <th className="text-right px-2 py-1.5 font-semibold">複勝率</th>
                    <th className="text-left px-2 py-1.5 font-semibold">今回条件の複勝率</th>
                    <th className="text-left px-2 py-1.5 font-semibold">取得状況</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.items.map((j) => {
                    const key = `${j.horseNumber}-${j.horseName}`;
                    const isOpen = open === key;
                    return (
                      <React.Fragment key={key}>
                        <tr
                          className="border-t border-slate-800 text-slate-200 cursor-pointer hover:bg-slate-800/40"
                          onClick={() => setOpen(isOpen ? null : key)}
                        >
                          <td className="px-2 py-1 whitespace-nowrap">
                            {isOpen ? <ChevronDown className="w-3 h-3 inline" /> : <ChevronRight className="w-3 h-3 inline" />}{' '}
                            {j.horseNumber ?? '-'} {j.horseName}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap">{j.name ?? '-'}</td>
                          <td className="px-2 py-1 text-right">{j.rides || '-'}</td>
                          <td className="px-2 py-1 text-right">{j.rides ? j.first : '-'}</td>
                          <td className="px-2 py-1 text-right">{j.rides ? j.second : '-'}</td>
                          <td className="px-2 py-1 text-right">{j.rides ? j.third : '-'}</td>
                          <td className="px-2 py-1 text-right font-bold text-emerald-300">
                            {rate(j.first + j.second + j.third, j.rides)}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap">
                            {j.current ? `${rate(j.current.top3, j.current.rides)}（${j.current.top3}/${j.current.rides}）` : '-'}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap text-slate-400">
                            {/* 騎手IDが無い・取得中のときも表示し、押せない理由を示す */}
                            <button
                              onClick={(ev) => {
                                ev.stopPropagation();
                                if (j.jockeyId) handleCrawl(j.jockeyId);
                              }}
                              disabled={!j.jockeyId || crawl?.running}
                              title={
                                !j.jockeyId
                                  ? '騎手IDが未保存です。出馬表を取り込み直してください'
                                  : crawl?.running
                                    ? '別の取得が実行中です'
                                    : 'この騎手の成績（過去5年）だけを取得します'
                              }
                              className="mr-2 px-2 py-0.5 rounded border border-violet-500/50 text-violet-300 hover:bg-violet-500/10 text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              この騎手だけ取得
                            </button>
                            {j.status === 'no_id'
                              ? '騎手ID未保存（出馬表を取り込み直してください）'
                              : j.status === 'not_fetched'
                                ? '未取得'
                                : j.crawl?.backfillDone
                                  ? '5年分取得済み'
                                  : `取得途中（${j.crawl?.oldestDate ?? '-'}〜）`}
                          </td>
                        </tr>
                        {isOpen && j.status === 'ok' && (
                          <tr className="border-t border-slate-800 bg-slate-950/60">
                            <td colSpan={9} className="px-3 py-3">
                              <div className="flex flex-col gap-3">
                                <div>
                                  <p className="text-[11px] font-bold text-slate-400 mb-1">着順別の脚質・枠（3着以内）</p>
                                  {j.byFinish.map((b) => (
                                    <p key={b.finish} className="text-[11px] text-slate-200">
                                      {b.finish}着 {b.count}回：脚質 {countText(b.styles)}　枠 {countText(b.frames)}
                                    </p>
                                  ))}
                                </div>
                                <RateChips title="脚質別の複勝率" rows={j.styleRates} />
                                <RateChips title="枠別の複勝率" rows={j.frameRates} />
                                <RateChips title="芝・ダート別" rows={j.surfaceRates} />
                                <RateChips title="距離帯別" rows={j.distanceRates} />
                                <RateChips title="会場別（騎乗数の多い順）" rows={j.venueRates} />
                                <RateChips title="馬場状態別" rows={j.conditionRates} />
                                <div>
                                  <p className="text-[11px] font-bold text-slate-400 mb-1">
                                    直近10件の騎乗（netkeibaの騎手ページと見比べて確認用）
                                    {j.jockeyId && (
                                      <a
                                        href={`https://db.netkeiba.com/jockey/result/recent/${j.jockeyId}/`}
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
                                          {['日付', '会場', 'R', 'レース名', '距離', '馬場', '頭数', '枠', '馬番', '人気', '着順', '馬名', '通過', '脚質'].map((h) => (
                                            <th key={h} className="text-left pr-3 font-semibold">{h}</th>
                                          ))}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {j.recent.map((r) => (
                                          <tr key={r.raceId}>
                                            <td className="pr-3">{r.date}</td>
                                            <td className="pr-3">{r.venueName ?? '-'}</td>
                                            <td className="pr-3">{r.raceNo ?? '-'}</td>
                                            <td className="pr-3">{r.raceName ?? '-'}</td>
                                            <td className="pr-3">{r.surface ?? ''}{r.distance ?? ''}</td>
                                            <td className="pr-3">{r.trackCondition ?? '-'}</td>
                                            <td className="pr-3">{r.headcount ?? '-'}</td>
                                            <td className="pr-3">{r.frameNumber ?? '-'}</td>
                                            <td className="pr-3">{r.horseNumber ?? '-'}</td>
                                            <td className="pr-3">{r.popularity ?? '-'}</td>
                                            <td className="pr-3">{r.finishText ?? '-'}</td>
                                            <td className="pr-3">{r.horseName ?? '-'}</td>
                                            <td className="pr-3">{r.passing ?? '-'}</td>
                                            <td className="pr-3 font-bold text-violet-300">{r.runningStyle ?? '-'}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                                <div>
                                  <p className="text-[11px] font-bold text-slate-400 mb-1">メモ（調査結果）</p>
                                  {j.notes.length === 0 ? (
                                    <p className="text-[11px] text-slate-500">未登録</p>
                                  ) : (
                                    j.notes.map((n, i) => (
                                      <p key={i} className="text-[11px] text-slate-200">
                                        {n.note}
                                        {n.source && (
                                          <a href={n.source} target="_blank" rel="noreferrer" className="text-sky-400 ml-1 underline">
                                            出典
                                          </a>
                                        )}
                                        {n.checkedAt && <span className="text-slate-500 ml-1">（{n.checkedAt}確認）</span>}
                                      </p>
                                    ))
                                  )}
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
          </>
        )}
      </div>
    </section>
  );
};
