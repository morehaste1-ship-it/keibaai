import React, { useState } from 'react';
import { History, Undo2 } from 'lucide-react';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 2026-10-12 → 10/12（月）。年が今年でなければ年も付ける */
function label(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const thisYear = new Date().getFullYear();
  return `${y !== thisYear ? `${y}/` : ''}${m}/${d}（${wd}）`;
}

export function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface Props {
  /** 表示中の過去の日付（本日以降を表示中なら null） */
  pastDate: string | null;
  onPick: (date: string) => void;
  onBack: () => void;
}

/** 「過去のレース」：データがある過去の開催日をプルダウンで選ぶ（日付の一覧は初めて開いたときに読む） */
export const PastRacePicker: React.FC<Props> = ({ pastDate, onPick, onBack }) => {
  const [open, setOpen] = useState(false);
  const [dates, setDates] = useState<{ date: string; races: number }[] | null>(null);
  const [error, setError] = useState('');

  const load = () => {
    setError('');
    fetch(`/api/races/dates?before=${todayYmd()}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '過去の開催日の読み込みに失敗しました');
        setDates(data.dates);
      })
      .catch((e) => setError(e.message));
  };

  const toggle = () => {
    if (!open && dates === null) load();
    setOpen(!open);
  };

  const showSelect = open || pastDate !== null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {pastDate === null ? (
        <button
          onClick={toggle}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 font-bold"
          aria-expanded={open}
        >
          <History className="w-3.5 h-3.5 text-teal-400" />
          過去のレース
        </button>
      ) : (
        <>
          <span className="px-2 py-1 rounded-lg bg-teal-500/15 text-teal-200 border border-teal-500/40 font-bold">過去のレースを表示中</span>
          <button
            onClick={() => {
              setOpen(false);
              onBack();
            }}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 font-bold"
          >
            <Undo2 className="w-3.5 h-3.5" />
            本日以降に戻る
          </button>
        </>
      )}
      {showSelect && (
        <select
          aria-label="過去の開催日"
          value={pastDate ?? ''}
          onFocus={() => dates === null && load()}
          onChange={(e) => e.target.value && onPick(e.target.value)}
          className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-slate-200"
        >
          <option value="">{dates === null ? '読み込み中…' : dates.length === 0 ? '過去のレースはありません' : '開催日を選ぶ'}</option>
          {(dates ?? []).map((d) => (
            <option key={d.date} value={d.date}>
              {label(d.date)} {d.races}R
            </option>
          ))}
          {pastDate && dates !== null && !dates.some((d) => d.date === pastDate) && <option value={pastDate}>{label(pastDate)}</option>}
        </select>
      )}
      {error && <span className="text-red-300">{error}</span>}
    </div>
  );
};
