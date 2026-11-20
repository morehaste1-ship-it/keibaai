import React, { useEffect, useMemo, useState } from 'react';
import { Trophy, RefreshCw, Copy, Check } from 'lucide-react';
import { allocateWin5, WIN5_DEFAULT_BUDGET, type Win5Candidate } from '../utils/win5';
import { useNearViewport } from '../utils/useNearViewport';

interface Leg {
  leg: number;
  raceKey: string | null;
  label: string;
  postTime: string | null;
  candidates: Win5Candidate[];
  note: string | null;
}
interface Plan {
  date: string | null;
  legs: Leg[];
  calibRaces: number;
}
interface HistoryRow {
  date: string;
  budget: number;
  points: number;
  hitProb: number;
  legs: { leg: number; label: string; picks: number[]; winners: number[] | null; hit: boolean | null }[];
  decided: number;
  hits: number;
  allHit: boolean | null;
}

const BUDGET_KEY = 'keibaai.ui.win5Budget';
const loadBudget = (): number => {
  try {
    const v = Number(localStorage.getItem(BUDGET_KEY));
    return Number.isInteger(v) && v >= 1 ? v : WIN5_DEFAULT_BUDGET;
  } catch {
    return WIN5_DEFAULT_BUDGET;
  }
};
const pct = (p: number) => (p >= 0.01 ? `${(p * 100).toFixed(1)}%` : `${(p * 100).toFixed(2)}%`);

/** WIN5：対象5レースの買い目（予算の中で5レースとも当たる確率が最大になる頭数）と、記録した予想の答え合わせ */
export const Win5Panel: React.FC = () => {
  const [ref, near] = useNearViewport<HTMLElement>();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState<number>(loadBudget);
  const [copied, setCopied] = useState(false);

  const apply = (data: any) => {
    setPlan(data.plan ?? null);
    setHistory(data.history ?? []);
    setLoaded(true);
  };

  useEffect(() => {
    if (!near) return;
    fetch('/api/win5')
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'WIN5 の読み込みに失敗しました');
        apply(data);
      })
      .catch((e) => setError(e.message));
  }, [near]);

  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/win5/refresh', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '読み直せませんでした');
      if (!data.found) setError('WIN5 の対象レースはまだ発表されていません');
      apply(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const changeBudget = (v: number) => {
    const b = Math.max(1, Math.floor(v) || 1);
    setBudget(b);
    try {
      localStorage.setItem(BUDGET_KEY, String(b));
    } catch {
      /* 保存できなくても計算は変える */
    }
  };

  const ready = !!plan && plan.legs.length === 5 && plan.legs.every((l) => l.candidates.length > 0);
  const alloc = useMemo(
    () => (ready && plan ? allocateWin5(plan.legs.map((l) => ({ leg: l.leg, label: l.label, candidates: l.candidates })), budget) : null),
    [ready, plan, budget],
  );

  const copy = async () => {
    if (!plan || !alloc) return;
    const text = ['WIN5', ...plan.legs.map((l, i) => `${i + 1}レース目 ${l.label}：${l.candidates.slice(0, alloc.picks[i]).map((c) => c.horseNumber).join('・')}`), `${alloc.points}点`].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section ref={ref} className="max-w-7xl w-full mx-auto px-4 pt-4">
      <div className="bg-slate-900/60 border border-amber-700/50 rounded-xl p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-black text-white flex items-center gap-2">
            <Trophy className="w-4 h-4 text-amber-400" />
            WIN5{plan?.date ? `（${plan.date}）` : ''}
          </h2>
          <button
            onClick={refresh}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-1 rounded border border-slate-700 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} />
            対象レースを読み直す
          </button>
        </div>
        {error && <p className="text-xs text-amber-300">{error}</p>}
        {!loaded && !error && <p className="text-xs text-slate-400">読み込み中…</p>}
        {loaded && !plan && <p className="text-xs text-slate-400">WIN5 の対象レースがまだ保存されていません。「対象レースを読み直す」を押すか、出馬表の自動取得を待ってください。</p>}

        {plan && (
          <>
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
              <label className="flex items-center gap-2">
                予算
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={budget}
                  onChange={(e) => changeBudget(Number(e.target.value))}
                  className="w-24 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-right text-white"
                />
                点（{(budget * 100).toLocaleString('ja-JP')}円まで）
              </label>
              {alloc ? (
                <>
                  <span>
                    買い目 <b className="text-white">{alloc.points}点</b>（{(alloc.points * 100).toLocaleString('ja-JP')}円）
                  </span>
                  <span>
                    5レースとも当たる確率の目安 <b className="text-amber-300">{pct(alloc.hitProb)}</b>
                  </span>
                  <button onClick={copy} className="flex items-center gap-1 px-2 py-1 rounded border border-slate-700 hover:bg-slate-800">
                    {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    {copied ? 'コピーしました' : '買い目をコピー'}
                  </button>
                </>
              ) : (
                <span className="text-slate-400">5レースとも出馬表（馬番）がそろうと、買い目を作ります</span>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
              {plan.legs.map((l, i) => {
                const k = alloc ? alloc.picks[i] : 0;
                return (
                  <div key={l.leg} className="rounded-lg border border-slate-700 p-2 text-[11px] text-slate-300">
                    <p className="font-bold text-white">
                      {i + 1}レース目 {l.postTime ? <span className="text-slate-400 font-normal">{l.postTime}</span> : null}
                    </p>
                    <p className="text-slate-300">{l.label}</p>
                    {l.note && <p className="mt-1 text-amber-300">{l.note}</p>}
                    {alloc && (
                      <p className="mt-1 text-slate-400">
                        {k}頭・当たる確率の目安 {pct(alloc.legProbs[i])}
                      </p>
                    )}
                    <ul className="mt-1 space-y-0.5">
                      {l.candidates.slice(0, Math.max(k + 2, 3)).map((c, j) => (
                        <li key={c.horseNumber} className={j < k ? 'text-white font-bold' : 'text-slate-500'}>
                          {c.horseNumber} {c.horseName}
                          <span className="ml-1 font-normal text-slate-400">
                            {c.mark || ''} {pct(c.prob)}
                            {c.popularity ? `・${c.popularity}人気` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-slate-500">
              確率の目安は、データ予想の順位ごとの過去の1着率（{plan.calibRaces.toLocaleString('ja-JP')}レースの記録）から出しています。予算の中で5レースとも当たる確率が一番高くなるように、各レースの頭数を決めています（太字が買い目、灰色は次の候補）。
            </p>
          </>
        )}

        {history.length > 0 && (
          <table className="w-full text-[11px] text-slate-300">
            <thead>
              <tr className="text-slate-500">
                <th className="text-left font-normal">記録した予想</th>
                <th className="text-right font-normal">点数</th>
                <th className="text-right font-normal">確率の目安</th>
                <th className="text-right font-normal">当たったレース</th>
                <th className="text-right font-normal">結果</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.date} title={h.legs.map((l, i) => `${i + 1}:${l.label} 買い ${l.picks.join('・')} → 1着 ${l.winners?.join('・') ?? '未確定'}`).join('\n')} className="cursor-help">
                  <td>{h.date}</td>
                  <td className="text-right">{h.points}点</td>
                  <td className="text-right">{pct(h.hitProb)}</td>
                  <td className="text-right">
                    {h.hits}/{h.decided}
                  </td>
                  <td className={`text-right font-bold ${h.allHit ? 'text-emerald-300' : ''}`}>{h.allHit === null ? '結果待ち' : h.allHit ? '的中' : '不的中'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
};
