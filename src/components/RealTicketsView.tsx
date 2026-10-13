import React, { useMemo, useState } from 'react';
import { Ticket as TicketIcon, Copy, Check } from 'lucide-react';
import { buildPlans, type RealDataView } from '../utils/trifecta';

const KIND_STYLE: Record<string, string> = {
  本命: 'border-red-500/50 text-red-300',
  中穴: 'border-sky-500/50 text-sky-300',
  大穴: 'border-amber-500/50 text-amber-300',
};
const UNIT = 100;

/** 馬番の並びから重複を除いて「・」でつなぐ（同じ馬が複数の役割で入る場合の表示用） */
const uniq = (ns: number[]) => [...new Set(ns)].join('・');

/**
 * 予算を買い目の数で均等に分け、1点あたりの金額（100円単位・切り捨て）と余りを出す
 */
export function splitBudget(budget: number, ticketCount: number): { perTicket: number; used: number; rest: number } {
  if (!Number.isFinite(budget) || budget <= 0 || ticketCount <= 0) return { perTicket: 0, used: 0, rest: Math.max(0, budget || 0) };
  const perTicket = Math.floor(budget / ticketCount / UNIT) * UNIT;
  const used = perTicket * ticketCount;
  return { perTicket, used, rest: budget - used };
}

/** AI推奨買い目＆資金配分（実データ：3連単予想の買い目と均等配分） */
export const RealTicketsView: React.FC<{ data: RealDataView | null }> = ({ data }) => {
  const plans = useMemo(() => (data ? buildPlans(data.ranked) : []), [data]);
  const [selected, setSelected] = useState<Record<string, boolean>>({ 本命: true, 中穴: true, 大穴: true });
  const [budget, setBudget] = useState<number>(3000);
  const [copied, setCopied] = useState(false);
  if (!data) return <p className="text-xs text-slate-400 p-4">データ予想の読み込み後に表示されます。</p>;

  const name = (n: number) => data.ranked.find((h) => h.horseNumber === n)?.horseName ?? '';
  const chosen = plans.filter((p) => p.available && selected[p.kind]);
  // 同じ組み合わせが複数の予想に入っている場合は1点として数える
  const tickets = [...new Map(chosen.flatMap((p) => p.tickets).map((t) => [`${t.first}-${t.second}-${t.third}`, t])).values()];
  const { perTicket, used, rest } = splitBudget(budget, tickets.length);
  const ticketText = tickets.map((t) => `${t.first}→${t.second}→${t.third}${perTicket > 0 ? ` ${perTicket}円` : ''}`).join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`3連単\n${ticketText}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
        <h3 className="text-base font-black text-white flex items-center gap-2">
          <TicketIcon className="w-4 h-4 text-emerald-400" />
          3連単の買い目（データ予想の印から）
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {plans.map((p) => (
            <div key={p.kind} className={`rounded-xl border p-3 text-[11px] ${KIND_STYLE[p.kind]} ${p.available ? '' : 'opacity-60'}`}>
              <label className="flex items-center gap-2 text-sm font-black">
                <input
                  type="checkbox"
                  disabled={!p.available}
                  checked={p.available && Boolean(selected[p.kind])}
                  onChange={(e) => setSelected({ ...selected, [p.kind]: e.target.checked })}
                />
                {p.kind}
                <span className="text-[11px] font-normal text-slate-400">{p.available ? `${p.tickets.length}点` : '作成できず'}</span>
              </label>
              {p.available ? (
                <>
                  <p className="mt-1 text-slate-300">
                    1着 {uniq(p.formation.first)} → 2着 {uniq(p.formation.second)} → 3着 {uniq(p.formation.third)}
                  </p>
                  <p className="mt-1 text-slate-400">{p.summary}</p>
                </>
              ) : (
                <p className="mt-1 text-slate-400">{p.reason}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
        <h4 className="text-sm font-black text-white">資金配分（均等買い）</h4>
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
          <label className="flex items-center gap-2">
            予算
            <input
              type="number"
              min={0}
              step={100}
              value={budget}
              onChange={(e) => setBudget(Math.max(0, Number(e.target.value) || 0))}
              className="w-28 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-right text-white"
            />
            円
          </label>
          <span>
            選んだ買い目 <b className="text-white">{tickets.length}点</b>
          </span>
          <span>
            1点あたり <b className="text-emerald-300">{perTicket.toLocaleString('ja-JP')}円</b>
          </span>
          <span>
            合計 {used.toLocaleString('ja-JP')}円（余り {rest.toLocaleString('ja-JP')}円）
          </span>
          <button
            onClick={copy}
            disabled={tickets.length === 0}
            className="flex items-center gap-1 px-2 py-1 rounded border border-slate-700 hover:bg-slate-800 disabled:opacity-40"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copied ? 'コピーしました' : '買い目をコピー'}
          </button>
        </div>
        {tickets.length > 0 && perTicket === 0 && (
          <p className="text-[11px] text-amber-300">予算が足りません（{tickets.length}点を100円ずつ買うには {(tickets.length * UNIT).toLocaleString('ja-JP')}円 必要です）。</p>
        )}
        {tickets.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-1 text-[11px] text-slate-300">
            {tickets.map((t) => (
              <span key={`${t.first}-${t.second}-${t.third}`} className="bg-slate-950/60 border border-slate-800 rounded px-2 py-1" title={`${name(t.first)} → ${name(t.second)} → ${name(t.third)}`}>
                {t.first}→{t.second}→{t.third}
                {perTicket > 0 && <span className="text-slate-500 ml-1">{perTicket}円</span>}
              </span>
            ))}
          </div>
        )}
        <p className="text-[10px] text-slate-500">
          1点あたりの金額は、予算を点数で割って100円単位で切り捨てた額です。複数の予想で同じ組み合わせが重なる場合は1点として数えます。オッズ（3連単の配当）は取得していないため、配当に応じた傾斜配分は行っていません。
        </p>
      </div>
    </div>
  );
};
