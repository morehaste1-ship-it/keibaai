import React, { useCallback, useEffect, useState } from 'react';
import { History, Undo2 } from 'lucide-react';
import { COMPONENT_KEYS, COMPONENT_LABELS } from '../utils/dataScore';
import { WEIGHTS_UPDATED_EVENT } from './DataPredictionPanel';

interface Metrics {
  top3InTop5: number;
  firstTop3: number;
  races: number;
}
interface WeightVersion {
  id: number;
  weights: Record<string, number>;
  reason: string;
  note: string | null;
  metrics: {
    races?: number;
    holdout?: { current: Metrics; candidate: Metrics | null } | null;
  } | null;
  adoptedAt: string;
}

const REASON_LABEL: Record<string, string> = { auto: '自動見直し', revert: '戻した', 'auto-revert': '自動で戻した' };
interface LiveStat {
  races: number;
  top3InTop5: number | null;
}
const liveText = (s: LiveStat | undefined) => (s && s.races > 0 && s.top3InTop5 !== null ? `${s.top3InTop5}%（${s.races}R）` : '-');
const SHOW = 8;
const fmt = (w: Record<string, number>) => COMPONENT_KEYS.map((k) => `${COMPONENT_LABELS[k]}${w[k] ?? 0}`).join('・');

/** 配分の自動見直し：採用中の配分・履歴・1つ前に戻す */
export const WeightHistoryView: React.FC = () => {
  const [current, setCurrent] = useState<Record<string, number> | null>(null);
  const [versions, setVersions] = useState<WeightVersion[]>([]);
  const [live, setLive] = useState<Record<string, LiveStat>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch('/api/weights')
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '配分の読み込みに失敗しました');
        setCurrent(data.current);
        setVersions(data.versions);
        setLive(data.live ?? {});
      })
      .catch((e) => setMsg(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const revert = async () => {
    const prev = versions[1]?.weights;
    const text = prev ? fmt(prev) : '既定の配分';
    if (!window.confirm(`採用中の配分を、1つ前の配分に戻します。\n${text}\n（次に記録する予想から使います）`)) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/weights/revert', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '戻せませんでした');
      setMsg('1つ前の配分に戻しました');
      load();
      window.dispatchEvent(new Event(WEIGHTS_UPDATED_EVENT));
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!current) return msg ? <p className="text-[11px] text-red-300">{msg}</p> : null;

  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-[11px] text-slate-300 space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold text-white flex items-center gap-1">
          <History className="w-3.5 h-3.5 text-teal-400" />
          配分の自動見直し
        </p>
        {versions.length > 0 && (
          <button
            onClick={revert}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-0.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            <Undo2 className="w-3 h-3" />
            1つ前に戻す
          </button>
        )}
      </div>
      <p>
        採用中の配分：<b className="text-white">{fmt(current)}</b>
        {versions.length === 0 && <span className="text-slate-500">（既定の配分。まだ見直しで変わっていません）</span>}
      </p>
      <p className="text-slate-400">
        実際の予想の成績（前日・当日の予想で、3着以内の馬が上位5頭に入った割合）：既定の配分 {liveText(live['0'])}
        {versions.length > 0 && <>・採用中の版 {liveText(live[String(versions[0].id)])}</>}
      </p>
      {versions.length > 0 && (
        <table className="w-full">
          <thead>
            <tr className="text-slate-500 text-left">
              <th className="font-normal pr-2">日時</th>
              <th className="font-normal pr-2">種類</th>
              <th className="font-normal pr-2">配分</th>
              <th className="font-normal pr-2 whitespace-nowrap">実際の成績</th>
              <th className="font-normal">理由</th>
            </tr>
          </thead>
          <tbody>
            {versions.slice(0, SHOW).map((v, i) => (
              <tr key={v.id} className={`align-top border-t border-slate-800 ${i === 0 ? 'text-white' : ''}`}>
                <td className="pr-2 whitespace-nowrap">{new Date(v.adoptedAt).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                <td className="pr-2 whitespace-nowrap">
                  {REASON_LABEL[v.reason] ?? v.reason}
                  {i === 0 && <span className="ml-1 text-teal-300">（採用中）</span>}
                </td>
                <td className="pr-2">{fmt(v.weights)}</td>
                <td className="pr-2 whitespace-nowrap">{liveText(live[String(v.id)])}</td>
                <td className="text-slate-400">{v.note ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {msg && <p className="text-teal-300">{msg}</p>}
      <p className="text-[10px] text-slate-500">
        毎週火曜の夜間処理で、結果がそろったレース（前日・当日・過去レースの検証など）を使って配分を見直します。古い7割で候補を探し、直近3割で今の配分を0.5ポイント以上上回ったときだけ採用します（物差しは「3着以内の馬が合計点の上位5頭に入った割合」）。50レース未満のときは変えず、1回で動かすのは各項目±5%までです。採用した配分は、次に記録する予想と、データ予想の「採用中の配分に戻す」で使われます。あわせて、採用した配分で実際の予想（前日・当日）の成績が前の版より2ポイント以上下がったら（それぞれ50レース以上で比較）、自動で前の配分に戻します。自動で戻した配分は、その後の見直しで再び採用しません。
      </p>
    </div>
  );
};
