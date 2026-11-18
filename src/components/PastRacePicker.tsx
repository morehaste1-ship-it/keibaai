import React, { useEffect, useState } from 'react';
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

type DateRow = { date: string; races: number };
/** 前回読んだ開催日の一覧の保存先（この端末だけ。次に開いたときにすぐ出すため） */
const DATES_CACHE_KEY = 'keibaai.ui.pastDates';

function loadCachedDates(): DateRow[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(DATES_CACHE_KEY) ?? 'null');
    return Array.isArray(v) ? (v as DateRow[]) : null;
  } catch {
    return null;
  }
}

/**
 * 「過去のレース」：データがある過去の開催日をプルダウンで選ぶ。
 * 日付の一覧は画面を開いた時点で読み込んでおく（以前は「過去のレース」を押してから読んでいたため、一覧が出るまで待たされた）。
 * 前回の一覧をこの端末に覚えておき、読み込みが終わるまではそれを出す
 */
export const PastRacePicker: React.FC<Props> = ({ pastDate, onPick, onBack }) => {
  const [open, setOpen] = useState(false);
  const [dates, setDates] = useState<DateRow[] | null>(() => loadCachedDates());
  const [error, setError] = useState('');

  const load = () => {
    setError('');
    fetch(`/api/races/dates?before=${todayYmd()}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '過去の開催日の読み込みに失敗しました');
        setDates(data.dates);
        try {
          localStorage.setItem(DATES_CACHE_KEY, JSON.stringify(data.dates));
        } catch {
          // 保存できなくても表示には影響させない
        }
      })
      .catch((e) => setError(e.message));
  };

  // 画面を開いた時点で読み込む
  useEffect(() => {
    load();
  }, []);

  const toggle = () => setOpen(!open);

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
          onChange={(e) => e.target.value && onPick(e.target.value)}
          className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-slate-200"
        >
          <option value="">{dates === null ? '読み込み中…' : dates.length === 0 ? '過去のレースはありません' : '開催日を選ぶ'}</option>
          {(dates ?? []).map((d) => (
            <option key={d.date} value={d.date}>
              {label(d.date)} {d.races}R
            </option>
          ))}
          {pastDate && !(dates ?? []).some((d) => d.date === pastDate) && <option value={pastDate}>{label(pastDate)}</option>}
        </select>
      )}
      {error && <span className="text-red-300">{error}</span>}
    </div>
  );
};
