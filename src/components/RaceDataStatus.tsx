import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, CheckCircle2, AlertTriangle, Info } from 'lucide-react';

interface StatusItem {
  key: string;
  label: string;
  level: 'ok' | 'warn' | 'info';
  text: string;
  detail: string | null;
}

interface Props {
  raceKey: string;
  /** 項目を押したときに移動する先（例：過去10年 → 過去10年の欄） */
  onJump?: (key: string) => void;
  /** これが変わったら読み直す（データ予想の読み込み完了など） */
  refreshToken?: unknown;
}

const LEVEL_CLASS: Record<StatusItem['level'], string> = {
  ok: 'border-emerald-700/60 bg-emerald-500/10 text-emerald-200',
  warn: 'border-amber-500/60 bg-amber-500/15 text-amber-200',
  info: 'border-slate-700 bg-slate-900/60 text-slate-300',
};
const LEVEL_ICON = { ok: CheckCircle2, warn: AlertTriangle, info: Info };

/** レースのデータの状態（馬番・オッズ・過去走・血統・騎手成績・過去10年・馬場・予想の記録）を1行で表示する */
export const RaceDataStatus: React.FC<Props> = ({ raceKey, onJump, refreshToken }) => {
  const [items, setItems] = useState<StatusItem[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    setError('');
    fetch(`/api/races/${raceKey}/status`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'データの状態を読み込めませんでした');
        setItems(data.raceStatus.items);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, [raceKey]);

  useEffect(() => {
    load();
  }, [load, refreshToken]);

  const warns = items?.filter((i) => i.level === 'warn').length ?? 0;

  return (
    <section className="max-w-7xl w-full mx-auto px-4 pt-4">
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-black text-white">
            データの状態
            {items && (
              <span className={`ml-2 text-[11px] font-semibold ${warns > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>
                {warns > 0 ? `欠けが${warns}項目あります（黄色の項目にマウスを乗せると詳細）` : 'そろっています'}
              </span>
            )}
          </h2>
          <button
            onClick={load}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} />
            確認し直す
          </button>
        </div>
        {error && <p className="text-[11px] text-red-300">{error}</p>}
        {items && (
          <div className="flex flex-wrap gap-1.5">
            {items.map((i) => {
              const Icon = LEVEL_ICON[i.level];
              const clickable = !!onJump && (i.key === 'history' || i.key === 'jockeys');
              return (
                <button
                  key={i.key}
                  type="button"
                  title={i.detail ?? undefined}
                  onClick={() => clickable && onJump?.(i.key)}
                  className={`flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] ${LEVEL_CLASS[i.level]} ${
                    clickable ? 'hover:brightness-125 cursor-pointer' : 'cursor-default'
                  }`}
                >
                  <Icon className="w-3 h-3 shrink-0" />
                  <span className="text-slate-400">{i.label}</span>
                  <span className="font-bold">{i.text}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};
