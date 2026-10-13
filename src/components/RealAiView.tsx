import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BrainCircuit, Sparkles, Send, RefreshCw, AlertCircle, HelpCircle } from 'lucide-react';
import { buildPlans, explainHorse, forecastPace, type RealDataView } from '../utils/trifecta';
import { weakPoints } from './RealUpsetView';

const PRESETS = [
  '上位人気馬（1〜3番人気）の死角は？データの根拠つきで',
  '中穴・大穴候補が3着以内に入るための条件は？',
  'もし重馬場になったら、重・不良の成績や血統から浮上する馬は？',
  '展開がスローになった場合に有利になる馬は？',
];

/** 馬番の並びから重複を除いて「・」でつなぐ（同じ馬が複数の役割で入る場合の表示用） */
const uniq = (ns: number[]) => [...new Set(ns)].join('・');

/** Gemini 専門家深掘り（実データの根拠だけを Gemini に送る） */
export const RealAiView: React.FC<{ data: RealDataView | null }> = ({ data }) => {
  const [question, setQuestion] = useState('');
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pace = useMemo(() => (data ? forecastPace(data.ranked, data.historyCorner) : null), [data]);
  // 回答が届いたら、回答の位置まで画面を動かす（ボタンの下に表示されるため見落とさないように）
  const resultRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (text) resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [text]);

  if (!data || !pace) return <p className="text-xs text-slate-400 p-4">データ予想の読み込み後に表示されます。</p>;

  const run = async (q: string) => {
    setLoading(true);
    setError('');
    try {
      const ranked = [...data.ranked].sort((a, b) => a.rank - b.rank);
      const horses = ranked.map((h) => {
        const lines = explainHorse(h, pace);
        if (h.popularity !== null && h.popularity <= 3) {
          const w = weakPoints(h);
          lines.push(`死角（データ上）：${w.length > 0 ? w.join('／') : '目立った死角なし'}`);
        }
        return lines;
      });
      const plans = buildPlans(data.ranked).map((p) =>
        p.available
          ? `${p.kind}：1着 ${uniq(p.formation.first)} → 2着 ${uniq(p.formation.second)} → 3着 ${uniq(p.formation.third)}（${p.tickets.length}点）`
          : `${p.kind}：作成できず（${p.reason}）`,
      );
      const r = data.race;
      const res = await fetch('/api/race-deliberation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          race: r ? `${r.venueName} ${r.surface}${r.distance}m ${r.name}` : '',
          pace: `${pace.pace}。${pace.text}`,
          horses,
          plans,
          question: q,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Gemini の呼び出しに失敗しました');
      setText(d.analysis);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-slate-900 border border-emerald-500/30 rounded-2xl p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-black text-white flex items-center gap-2">
            <BrainCircuit className="w-4 h-4 text-emerald-400" />
            Gemini による深掘り（実データのみ）
          </h3>
          <button
            onClick={() => run('')}
            disabled={loading}
            className="flex items-center gap-1.5 px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-black rounded-lg disabled:opacity-50"
          >
            {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {loading ? '生成中…' : 'レース全体の見立てを書かせる'}
          </button>
        </div>
        <p className="text-[11px] text-slate-400">
          データ予想の根拠（近走・適性・騎手・相性・状態・展開・人気馬の死角）と3連単の買い目だけを送り、データにないこと（調教・厩舎コメントなど）は書かないよう指示しています。
        </p>
      </div>

      {error && (
        <div className="p-3 bg-rose-950/40 border border-rose-500/40 rounded-xl text-rose-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {text && (
        <div ref={resultRef} className="bg-slate-900 border border-emerald-800/60 rounded-2xl p-4 scroll-mt-4">
          <p className="text-[11px] text-slate-500 mb-2">Gemini 3.8 Flash の回答（実データをもとに作成）</p>
          <div className="text-xs text-slate-200 leading-relaxed whitespace-pre-line">{text}</div>
        </div>
      )}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 space-y-2">
        <p className="flex items-center gap-1.5 text-xs text-slate-400 font-bold">
          <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
          質問の例
        </p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((q) => (
            <button
              key={q}
              disabled={loading}
              onClick={() => {
                setQuestion(q);
                run(q);
              }}
              className="text-xs px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 hover:text-emerald-300 hover:border-emerald-500/50 disabled:opacity-50 text-left"
            >
              {q}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={question}
            maxLength={300}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && question.trim() && !loading && run(question)}
            placeholder="気になる馬や展開について質問（データで答えられる範囲で回答します）"
            className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-400"
          />
          <button
            onClick={() => run(question)}
            disabled={loading || !question.trim()}
            className="flex items-center gap-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-lg border border-slate-700 disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5 text-emerald-400" />
            質問する
          </button>
        </div>
      </div>

    </div>
  );
};
