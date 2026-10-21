import React, { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, RefreshCw, Download, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { DeviationDetail, DeviationSummaryView, type DeviationData, type DeviationSummaryData } from './DeviationView';
import { WeightHistoryView } from './WeightHistoryView';

interface MarkStat {
  n: number;
  win: number;
  top3: number;
}
interface PlanStat {
  races: number;
  hits: number;
  cost: number;
  payout: number;
  recovery: number | null;
}
interface Summary {
  races: number;
  marks: Record<string, MarkStat>;
  plans: Record<string, PlanStat>;
  bets?: Record<string, PlanStat>;
  deviation?: DeviationSummaryData;
}
interface BetResult {
  type: string;
  label: string;
  available: boolean;
  ticketCount: number;
  cost: number;
  hit: boolean;
  payout: number;
  refund: number;
}
interface ReviewRow {
  raceKey: string;
  source: 'auto' | 'manual' | 'eve';
  recordedAt: string;
  race: { name: string; date: string; venueName: string; raceNo: number } | null;
  settings: {
    weights: Record<string, number>;
    horseK: number;
    jockeyK: number;
    shortageMode: string;
    condition: string | null;
    oddsKind?: 'final' | 'live' | 'forecast' | null;
  };
  hasOutcome: boolean;
  hasDetail?: boolean;
  deviation?: DeviationData | null;
  winningCombos: [number, number, number][];
  marks: { mark: string; horseNumber: number; horseName: string; popularity: number | null; finishText: string | null; finishPosition: number | null }[];
  plans: { kind: string; available: boolean; reason: string; ticketCount: number; cost: number; hit: boolean; payout: number; refund: number }[];
  bets?: BetResult[] | null;
  /** その日の同じ競馬場・芝ダの馬場傾向（例：前残り・内枠有利） */
  dayBias?: string | null;
}

/** 開催日ごとの馬場傾向（その日の結果から。予想には使わず、分析用） */
interface DayBias {
  date: string;
  venueName: string;
  surface: string;
  races: number;
  label: string;
  text: string;
}

/** 券種と、印からの買い方（サーバーの BET_RULES と同じ） */
const BETS = [
  { type: 'tansho', label: '単勝', rule: '◎（1点）' },
  { type: 'fukusho', label: '複勝', rule: '◎（1点）' },
  { type: 'wide', label: 'ワイド', rule: '◎-◯、◎-▲（2点）' },
  { type: 'umaren', label: '馬連', rule: '◎から◯▲△△へ流し（4点）' },
  { type: 'umatan', label: '馬単', rule: '◎1着固定で◯▲△△へ（4点）' },
  { type: 'sanrenpuku', label: '3連複', rule: '◎軸・2頭目◯▲・3頭目◯▲△△（5点）' },
];

type Scope = 'graded' | 'all';
const SCOPE_LABEL: Record<Scope, string> = { graded: '重賞のみ', all: '全レース' };
const SCOPE_KEY = 'keiba-review-scope';
const loadScope = (): Scope => {
  try {
    return localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'graded';
  } catch {
    return 'graded';
  }
};

type SourceKey = 'eve' | 'auto' | 'manual' | 'backtest';
const SOURCE_LABEL: Record<SourceKey, string> = {
  eve: '前日予想（既定の配分）',
  auto: '当日の自動（既定の配分）',
  manual: '手動（記録した配分）',
  backtest: '過去レースの検証（既定の配分・確定オッズ）',
};
const SOURCE_SHORT: Record<SourceKey, string> = { eve: '前日', auto: '当日', manual: '手動', backtest: '検証' };
const ODDS_LABEL: Record<string, string> = { forecast: '予想オッズ', live: '発売中オッズ', final: '確定オッズ' };
const MARKS = ['◎', '◯', '▲', '☆'];
const KINDS = ['本命', '中穴', '大穴'];
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : '-');
const yen = (n: number) => `${n.toLocaleString('ja-JP')}円`;

/** 予想の答え合わせ（記録した予想と確定結果の照合・集計） */
export const ReviewPanel: React.FC = () => {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [summary, setSummary] = useState<Partial<Record<SourceKey, Summary>> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});
  const [openDev, setOpenDev] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>(loadScope);
  const [totalRows, setTotalRows] = useState(0);
  const [dayBiases, setDayBiases] = useState<DayBias[]>([]);
  const [showBias, setShowBias] = useState(false);

  const load = useCallback(() => {
    setError('');
    fetch(`/api/review?scope=${scope}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '答え合わせの読み込みに失敗しました');
        setRows(data.review.rows);
        setTotalRows(data.review.totalRows ?? data.review.rows.length);
        setDayBiases(data.review.dayBiases ?? []);
        setSummary(data.review.summary);
      })
      .catch((e) => setError(e.message));
  }, [scope]);

  const changeScope = (s: Scope) => {
    setScope(s);
    try {
      localStorage.setItem(SCOPE_KEY, s);
    } catch {
      /* 保存できなくても表示は切り替える */
    }
  };

  useEffect(() => {
    load();
    const onUpdate = () => load();
    window.addEventListener('keiba-review-updated', onUpdate);
    return () => window.removeEventListener('keiba-review-updated', onUpdate);
  }, [load]);

  const fetchOutcome = async (raceKey: string) => {
    setBusy(raceKey);
    setRowMsg((m) => ({ ...m, [raceKey]: '' }));
    try {
      const res = await fetch(`/api/review/outcome/${raceKey}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '結果の取得に失敗しました');
      load();
    } catch (e: any) {
      setRowMsg((m) => ({ ...m, [raceKey]: e.message }));
    } finally {
      setBusy(null);
    }
  };

  const summaryTable = (key: SourceKey) => {
    const s = summary?.[key];
    if (!s) return null;
    return (
      <div className="flex-1 min-w-[280px] bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
        <p className="text-xs font-bold text-white">
          {SOURCE_LABEL[key]}　<span className="font-normal text-slate-400">結果あり {s.races}レース</span>
        </p>
        <table className="mt-1 w-full text-[11px] text-slate-300">
          <thead>
            <tr className="text-slate-500">
              <th className="text-left font-normal">印</th>
              <th className="text-right font-normal">頭数</th>
              <th className="text-right font-normal">勝率</th>
              <th className="text-right font-normal">複勝率</th>
            </tr>
          </thead>
          <tbody>
            {MARKS.map((m) => (
              <tr key={m}>
                <td className="font-black">{m}</td>
                <td className="text-right">{s.marks[m].n}</td>
                <td className="text-right">{pct(s.marks[m].win, s.marks[m].n)}</td>
                <td className="text-right">{pct(s.marks[m].top3, s.marks[m].n)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="mt-2 w-full text-[11px] text-slate-300">
          <thead>
            <tr className="text-slate-500">
              <th className="text-left font-normal">3連単</th>
              <th className="text-right font-normal">購入</th>
              <th className="text-right font-normal">的中</th>
              <th className="text-right font-normal">購入額</th>
              <th className="text-right font-normal">払戻</th>
              <th className="text-right font-normal">回収率</th>
            </tr>
          </thead>
          <tbody>
            {KINDS.map((k) => {
              const p = s.plans[k];
              return (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="text-right">{p.races}R</td>
                  <td className="text-right">{p.hits}回</td>
                  <td className="text-right">{yen(p.cost)}</td>
                  <td className="text-right">{yen(p.payout)}</td>
                  <td className={`text-right font-bold ${p.recovery !== null && p.recovery >= 100 ? 'text-emerald-300' : ''}`}>
                    {p.recovery === null ? '-' : `${p.recovery}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {s.deviation && <DeviationSummaryView s={s.deviation} />}
        {s.bets && (
          <table className="mt-2 w-full text-[11px] text-slate-300">
            <thead>
              <tr className="text-slate-500">
                <th className="text-left font-normal">券種（印から）</th>
                <th className="text-right font-normal">購入</th>
                <th className="text-right font-normal">的中</th>
                <th className="text-right font-normal">購入額</th>
                <th className="text-right font-normal">払戻</th>
                <th className="text-right font-normal">回収率</th>
              </tr>
            </thead>
            <tbody>
              {BETS.map((b) => {
                const p = s.bets![b.type];
                if (!p) return null;
                return (
                  <tr key={b.type}>
                    <td title={b.rule} className="cursor-help">{b.label}</td>
                    <td className="text-right">{p.races}R</td>
                    <td className="text-right">{p.hits}回</td>
                    <td className="text-right">{yen(p.cost)}</td>
                    <td className="text-right">{yen(p.payout)}</td>
                    <td className={`text-right font-bold ${p.recovery !== null && p.recovery >= 100 ? 'text-emerald-300' : ''}`}>
                      {p.recovery === null ? '-' : `${p.recovery}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    );
  };

  return (
    <section className="max-w-7xl w-full mx-auto px-4 pt-4">
      <div className="bg-slate-900/60 border border-teal-800/60 rounded-xl p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-black text-white flex items-center gap-1.5">
            <ClipboardCheck className="w-4 h-4 text-teal-400" />
            予想の答え合わせ
          </h2>
          <div className="flex items-center gap-2">
            <div className="flex rounded border border-slate-700 overflow-hidden text-[11px]" role="group" aria-label="集計の対象">
              {(['graded', 'all'] as Scope[]).map((s) => (
                <button
                  key={s}
                  onClick={() => changeScope(s)}
                  aria-pressed={scope === s}
                  className={`px-2 py-1 ${scope === s ? 'bg-teal-700/60 text-white font-bold' : 'text-slate-300 hover:bg-slate-800'}`}
                >
                  {SCOPE_LABEL[s]}
                </button>
              ))}
            </div>
            <button
              onClick={load}
              className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              <RefreshCw className="w-3 h-3" />
              再読み込み
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {error}
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          {summaryTable('eve')}
          {summaryTable('auto')}
          {summaryTable('manual')}
          {(summary?.backtest?.races ?? 0) > 0 && summaryTable('backtest')}
        </div>
        <WeightHistoryView />

        {(summary?.backtest?.races ?? 0) > 0 && (
          <p className="text-[11px] text-slate-500">
            「過去レースの検証」は、取り込んだ過去のレースを、そのレース日より前の成績だけで予想し直した結果です（夜間処理と npm run past で増えていきます）。人気は確定オッズのため、前日・当日の予想より有利な条件です。数が多いため一覧には出さず、集計だけを表示します。
          </p>
        )}

        {rows && rows.length === 0 && (
          <p className="text-xs text-slate-400">
            {scope === 'graded' ? '重賞の記録はまだありません。' : 'まだ記録がありません。'}
            前日の深夜に全レースの前日予想（予想オッズ）、開催日の朝9:30に全レース、12時に重賞（昼のオッズで上書き）が既定の配分で自動記録されます。データ予想の「この予想を記録」でも記録できます。
          </p>
        )}

        {rows && totalRows > rows.length && (
          <p className="text-[11px] text-slate-500">
            一覧は新しい順に {rows.length}件を表示しています（全{totalRows}件。上の集計は全件が対象です）。
          </p>
        )}

        {dayBiases.length > 0 && (
          <div className="text-[11px] text-slate-300">
            <button onClick={() => setShowBias(!showBias)} className="flex items-center gap-0.5 font-bold text-amber-200 hover:underline">
              {showBias ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              開催日ごとの馬場傾向（{dayBiases.length}件）
            </button>
            {showBias && (
              <div className="mt-1 overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-slate-500 text-left">
                      <th className="font-normal pr-2">開催日</th>
                      <th className="font-normal pr-2">コース</th>
                      <th className="font-normal pr-2">判定</th>
                      <th className="font-normal">内訳（3着以内の馬。倍率は出走馬全体の割合との比）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dayBiases.map((b) => (
                      <tr key={`${b.date}-${b.venueName}-${b.surface}`} className="border-t border-slate-800 align-top">
                        <td className="pr-2 whitespace-nowrap">{b.date.slice(5).replace('-', '/')}</td>
                        <td className="pr-2 whitespace-nowrap">
                          {b.venueName}
                          {b.surface}
                        </td>
                        <td className="pr-2 whitespace-nowrap font-bold text-amber-200">{b.label}</td>
                        <td className="text-slate-400">{b.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1 text-[10px] text-slate-500">
                  その日の同じ競馬場・芝ダートの全レースの結果（4角の位置・枠番）から計算した分析用のデータです。当日の予想には使いません。前日予想では、この直近2週の傾向を「馬場傾向」の項目として使います。
                </p>
              </div>
            )}
          </div>
        )}

        {rows && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] text-slate-300">
              <thead>
                <tr className="text-slate-500 text-left">
                  <th className="px-2 py-1 font-normal">レース</th>
                  <th className="px-2 py-1 font-normal">記録</th>
                  <th className="px-2 py-1 font-normal">印（着順）</th>
                  <th className="px-2 py-1 font-normal">3連単</th>
                  <th className="px-2 py-1 font-normal">結果</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <React.Fragment key={`${r.raceKey}-${r.source}`}>
                  <tr className="border-t border-slate-800 align-top">
                    <td className="px-2 py-1 whitespace-nowrap">
                      {r.race ? `${r.race.date.slice(5).replace('-', '/')} ${r.race.venueName}${r.race.raceNo}R ${r.race.name}` : r.raceKey}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap" title={`配分 ${JSON.stringify(r.settings.weights)}／補正 馬${r.settings.horseK}・騎手${r.settings.jockeyK}／馬場 ${r.settings.condition ?? '-'}`}>
                      {SOURCE_SHORT[r.source] ?? r.source}
                      {r.settings.oddsKind !== undefined && (
                        <span className={`block text-[10px] ${r.settings.oddsKind ? 'text-slate-500' : 'text-amber-300/80'}`}>
                          {r.settings.oddsKind ? ODDS_LABEL[r.settings.oddsKind] ?? r.settings.oddsKind : 'オッズなし'}
                        </span>
                      )}
                      <span className="block text-slate-500">{new Date(r.recordedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    </td>
                    <td className="px-2 py-1">
                      {r.marks
                        .filter((m) => MARKS.includes(m.mark))
                        .map((m) => (
                          <span key={m.mark + m.horseNumber} className="inline-block mr-2 whitespace-nowrap">
                            <b>{m.mark}</b>
                            {m.horseNumber}
                            {r.hasOutcome && (
                              <span className={m.finishPosition !== null && m.finishPosition <= 3 ? 'text-emerald-300 font-bold' : 'text-slate-500'}>
                                （{m.finishPosition ?? m.finishText ?? '-'}{m.finishPosition !== null ? '着' : ''}）
                              </span>
                            )}
                          </span>
                        ))}
                    </td>
                    <td className="px-2 py-1">
                      {r.hasOutcome && r.bets && (
                        <span className="block text-[10px] text-slate-400">
                          券種：
                          {r.bets.filter((b) => b.hit).length === 0
                            ? 'すべて不的中'
                            : r.bets
                                .filter((b) => b.hit)
                                .map((b) => `${b.label} ${yen(b.payout)}`)
                                .join('・')}
                        </span>
                      )}
                      {r.plans.map((p) => (
                        <span key={p.kind} className="inline-block mr-2 whitespace-nowrap" title={p.available ? '' : p.reason}>
                          {p.kind}
                          {!p.available ? (
                            <span className="text-slate-600">（なし）</span>
                          ) : !r.hasOutcome ? (
                            <span className="text-slate-500">（{p.ticketCount}点）</span>
                          ) : p.hit ? (
                            <span className="text-emerald-300 font-bold">（的中 {yen(p.payout)}）</span>
                          ) : (
                            <span className="text-slate-500">（×）</span>
                          )}
                        </span>
                      ))}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      {r.hasOutcome ? (
                        <>
                          {r.winningCombos.map((c) => c.join('-')).join('／')}
                          {r.dayBias && <span className="block text-[10px] text-amber-200/80">当日の馬場：{r.dayBias}</span>}
                          {r.deviation && (
                            <button
                              onClick={() => setOpenDev(openDev === `${r.raceKey}-${r.source}` ? null : `${r.raceKey}-${r.source}`)}
                              className="flex items-center gap-0.5 mt-0.5 text-teal-300 hover:underline"
                            >
                              {openDev === `${r.raceKey}-${r.source}` ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                              ずれの分析
                            </button>
                          )}
                          {!r.hasDetail && (
                            <button
                              onClick={() => fetchOutcome(r.raceKey)}
                              disabled={busy !== null}
                              title="4角の位置・上がり・ペースを取り込み、ずれを分析します（夜間にも自動で取り込みます）"
                              className="flex items-center gap-1 mt-0.5 px-2 py-0.5 rounded border border-teal-700 text-teal-300 hover:bg-teal-900/30 disabled:opacity-40"
                            >
                              <Download className="w-3 h-3" />
                              {busy === r.raceKey ? '取得中…' : '詳細を取り込む'}
                            </button>
                          )}
                          {rowMsg[r.raceKey] && <span className="block text-red-300 whitespace-normal max-w-[16rem]">{rowMsg[r.raceKey]}</span>}
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => fetchOutcome(r.raceKey)}
                            disabled={busy !== null}
                            className="flex items-center gap-1 px-2 py-0.5 rounded border border-teal-700 text-teal-300 hover:bg-teal-900/30 disabled:opacity-40"
                          >
                            <Download className="w-3 h-3" />
                            {busy === r.raceKey ? '取得中…' : '結果を取得'}
                          </button>
                          {rowMsg[r.raceKey] && <span className="block text-red-300 whitespace-normal max-w-[16rem]">{rowMsg[r.raceKey]}</span>}
                        </>
                      )}
                    </td>
                  </tr>
                  {r.deviation && openDev === `${r.raceKey}-${r.source}` && (
                    <tr>
                      <td colSpan={5} className="px-2 pb-2">
                        <DeviationDetail d={r.deviation} />
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-slate-500">
          券種別は、印から決まった買い方（券種名にマウスを乗せると表示）を各100円で買ったと仮定した値で、全券種の払戻を取り込んだレースだけを集計します。回収率は、3連単を1点100円で買ったと仮定した値です（取消・除外を含む買い目は返還として払戻に加算）。印の集計では取消・除外の馬を除きます。「重賞のみ／全レース」で集計と一覧の対象を切り替えます（配分の修正案も対象に合わせて計算されます）。結果（着順・4角の位置・上がり・ペース）は夜間ジョブ（1時）で自動取得され、「ずれの分析」が作られます。レース後すぐ見たいときは「結果を取得」を押してください。
        </p>
      </div>
    </section>
  );
};
