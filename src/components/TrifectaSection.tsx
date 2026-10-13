import React, { useMemo, useState } from 'react';
import { Ticket as TicketIcon, ChevronDown, ChevronRight, Sparkles, Loader2, AlertCircle } from 'lucide-react';
import type { RankedItem } from '../utils/dataScore';
import { buildPlans, explainHorse, forecastPace, type HistoryCorner, type RaceInfo } from '../utils/trifecta';

const KIND_STYLE: Record<string, string> = {
  本命: 'border-red-500/50 text-red-300',
  中穴: 'border-sky-500/50 text-sky-300',
  大穴: 'border-amber-500/50 text-amber-300',
};

interface Props {
  ranked: RankedItem[];
  race: RaceInfo | null;
  history: HistoryCorner | null;
}

/** 3連単の予想（本命・中穴・大穴）と解説 */
export const TrifectaSection: React.FC<Props> = ({ ranked, race, history }) => {
  const pace = useMemo(() => forecastPace(ranked, history), [ranked, history]);
  const plans = useMemo(() => buildPlans(ranked), [ranked]);
  const byNumber = useMemo(() => new Map(ranked.filter((h) => h.horseNumber !== null).map((h) => [h.horseNumber as number, h])), [ranked]);
  const [open, setOpen] = useState<string | null>('本命');
  const name = (n: number) => byNumber.get(n)?.horseName ?? '';

  // Gemini による解説（買い目が変わったら作り直しが必要なので、どの買い目で作ったかも覚えておく）
  const signature = useMemo(
    () => JSON.stringify(plans.map((p) => [p.kind, p.tickets.map((t) => `${t.first}-${t.second}-${t.third}`)])),
    [plans],
  );
  const [ai, setAi] = useState<{ text: string; signature: string } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');

  const requestCommentary = async () => {
    setAiLoading(true);
    setAiError('');
    try {
      const payload = {
        race: race ? `${race.venueName} ${race.surface}${race.distance}m ${race.name}` : '',
        pace: `${pace.pace}。${pace.text}`,
        plans: plans.map((p) => ({
          kind: p.kind,
          available: p.available,
          reason: p.reason,
          formation: `1着 ${p.formation.first.join('・')} → 2着 ${p.formation.second.join('・')} → 3着 ${p.formation.third.join('・')}`,
          ticketCount: p.tickets.length,
          summary: p.summary,
          horses: p.keyHorses
            .map((n) => byNumber.get(n))
            .filter((h): h is RankedItem => Boolean(h))
            .map((h) => explainHorse(h, pace)),
        })),
      };
      const res = await fetch('/api/trifecta-commentary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gemini の解説の作成に失敗しました');
      setAi({ text: data.commentary, signature });
    } catch (e: any) {
      setAiError(e.message || 'エラーが発生しました');
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 pt-3 border-t border-slate-800">
      <h3 className="text-sm font-black text-white flex items-center gap-1.5">
        <TicketIcon className="w-4 h-4 text-emerald-400" />
        3連単予想{race ? `（${race.venueName} ${race.surface}${race.distance}m ${race.name}）` : ''}
      </h3>

      <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-300">
        <p className="font-bold text-white">展開予想：{pace.pace}</p>
        <p className="mt-0.5">{pace.text}</p>
      </div>

      {plans.map((p) => {
        const isOpen = open === p.kind;
        return (
          <div key={p.kind} className={`rounded-lg border ${KIND_STYLE[p.kind]} bg-slate-950/40`}>
            <button
              onClick={() => setOpen(isOpen ? null : p.kind)}
              className="w-full flex items-center justify-between px-3 py-2 text-left"
            >
              <span className="text-xs font-black flex items-center gap-1">
                {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                {p.kind}
                {p.available ? (
                  <span className="text-slate-300 font-semibold ml-2">
                    1着 {p.formation.first.join('・')} → 2着 {p.formation.second.join('・')} → 3着 {p.formation.third.join('・')}（{p.tickets.length}点）
                  </span>
                ) : (
                  <span className="text-slate-500 font-normal ml-2">作成できません：{p.reason}</span>
                )}
              </span>
            </button>
            {isOpen && p.available && (
              <div className="px-3 pb-3 flex flex-col gap-2 text-[11px] text-slate-200">
                <p className="text-slate-300">{p.summary}</p>
                <div className="flex flex-wrap gap-1">
                  {p.tickets.map((t) => (
                    <span
                      key={`${t.first}-${t.second}-${t.third}`}
                      className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-900 font-mono"
                      title={`${name(t.first)} → ${name(t.second)} → ${name(t.third)}`}
                    >
                      {t.first}→{t.second}→{t.third}
                    </span>
                  ))}
                </div>
                <div className="flex flex-col gap-2">
                  {p.keyHorses.map((n) => {
                    const h = byNumber.get(n);
                    if (!h) return null;
                    const [head, ...rest] = explainHorse(h, pace);
                    return (
                      <div key={n} className="rounded border border-slate-800 bg-slate-900/60 px-2 py-1.5">
                        <p className="font-bold text-white">{head}</p>
                        <ul className="list-disc pl-4 mt-0.5 space-y-0.5 text-slate-300">
                          {rest.map((l) => (
                            <li key={l}>{l}</li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
      {/* Gemini による解説 */}
      <div className="rounded-lg border border-emerald-800/60 bg-slate-950/60 px-3 py-2 flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-bold text-white flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
            Gemini による解説（上の買い目と根拠データだけを使って文章にまとめます）
          </p>
          <button
            onClick={requestCommentary}
            disabled={aiLoading}
            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {aiLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {aiLoading ? '作成中…' : ai ? 'Geminiで解説を書き直す' : 'Geminiで解説を書く'}
          </button>
        </div>
        {aiError && (
          <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {aiError}（上のデータによる解説はそのまま使えます）
          </div>
        )}
        {ai && ai.signature !== signature && (
          <p className="text-[11px] text-amber-300">配分や設定が変わり、買い目が変わりました。最新の買い目で解説するには「書き直す」を押してください。</p>
        )}
        {ai && <div className="text-[12px] leading-relaxed text-slate-200 whitespace-pre-wrap">{ai.text}</div>}
      </div>

      <p className="text-[10px] text-slate-500">
        買い目はデータ予想の順位と保存済みの単勝人気から機械的に組み立てています。3連単のオッズ（想定配当）は未取得です。予想は過去データに基づく参考情報で、的中を保証するものではありません。
      </p>
    </div>
  );
};
