import React, { useEffect, useMemo, useState } from 'react';
import { Race } from '../types/keiba';
import { CalendarDays } from 'lucide-react';

interface RaceNavigatorProps {
  races: Race[];
  selectedRace: Race | null;
  onSelectRace: (raceId: string) => void;
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// レースID（YYYYMMDD-VV-RR）から開催日（YYYY-MM-DD）を取り出す。解釈できなければ空文字
function dateOf(race: Race): string {
  const m = /^(\d{4})(\d{2})(\d{2})-/.exec(race.id);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toDayNumber(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function formatDateLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}（${wd}）`;
}

export const RaceNavigator: React.FC<RaceNavigatorProps> = ({ races, selectedRace, onSelectRace }) => {
  // 登録されている開催日（昇順）
  const dates = useMemo(
    () => Array.from(new Set(races.map(dateOf).filter(Boolean))).sort(),
    [races],
  );

  // 今日に一番近い開催日（同じ距離なら今日以降を優先）
  const nearestDate = useMemo(() => {
    if (dates.length === 0) return '';
    const today = toDayNumber(todayString());
    const score = (ymd: string) => {
      const diff = toDayNumber(ymd) - today;
      return Math.abs(diff) * 2 + (diff < 0 ? 1 : 0);
    };
    return [...dates].sort((a, b) => score(a) - score(b))[0];
  }, [dates]);

  // ユーザーが選んだ日・会場（未選択なら既定値を使う）
  const [pickedDate, setPickedDate] = useState<string>('');
  const [pickedVenue, setPickedVenue] = useState<string>('');

  const activeDate = dates.includes(pickedDate) ? pickedDate : nearestDate;

  const racesOfDate = useMemo(
    () => races.filter((r) => dateOf(r) === activeDate).sort((a, b) => a.round - b.round),
    [races, activeDate],
  );

  const venues = useMemo(
    () => Array.from(new Set(racesOfDate.map((r) => r.trackName))),
    [racesOfDate],
  );

  const activeVenue = venues.includes(pickedVenue) ? pickedVenue : venues[0] ?? '';

  const racesOfVenue = useMemo(
    () => racesOfDate.filter((r) => r.trackName === activeVenue),
    [racesOfDate, activeVenue],
  );

  // 日付が切り替わったとき、選択中のレースが別の日なら、その日の先頭レースを選ぶ
  useEffect(() => {
    if (!activeDate) return;
    if (selectedRace && dateOf(selectedRace) === activeDate) return;
    const first = racesOfVenue[0] ?? racesOfDate[0];
    if (first) onSelectRace(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDate]);

  if (races.length === 0) {
    return <span className="text-sm font-bold text-slate-500">レース未登録</span>;
  }

  return (
    <div className="flex flex-col gap-2 min-w-0 w-full">
      {/* 開催日タブ */}
      <div className="flex flex-wrap gap-1.5 items-center">
        <CalendarDays className="w-4 h-4 text-amber-400 shrink-0" />
        {dates.map((d) => (
          <button
            key={d}
            onClick={() => {
              setPickedDate(d);
              setPickedVenue('');
            }}
            className={`px-3 py-1 rounded-lg text-xs font-bold border transition ${
              d === activeDate
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                : 'bg-slate-950 text-slate-400 border-slate-700 hover:text-slate-200'
            }`}
          >
            {formatDateLabel(d)}
          </button>
        ))}
      </div>

      {/* 会場タブ */}
      <div className="flex flex-wrap gap-1.5">
        {venues.map((v) => (
          <button
            key={v}
            onClick={() => {
              setPickedVenue(v);
              const first = racesOfDate.find((r) => r.trackName === v);
              if (first) onSelectRace(first.id);
            }}
            className={`px-3 py-1 rounded-lg text-xs font-bold border transition ${
              v === activeVenue
                ? 'bg-sky-500/20 text-sky-300 border-sky-500/50'
                : 'bg-slate-950 text-slate-400 border-slate-700 hover:text-slate-200'
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      {/* レース（R）ボタン */}
      <div className="flex flex-wrap gap-1">
        {racesOfVenue.map((r) => (
          <button
            key={r.id}
            onClick={() => onSelectRace(r.id)}
            title={`${r.name} ${r.surface}${r.distance}m`}
            className={`min-w-[3rem] px-2 py-1 rounded-md text-xs font-black border transition ${
              selectedRace?.id === r.id
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/60'
                : 'bg-slate-950 text-slate-300 border-slate-700 hover:text-white'
            }`}
          >
            {r.round}R
            {String(r.grade).startsWith('G') ? ` ${r.grade}` : ''}
          </button>
        ))}
      </div>

      {/* 選択中のレース名 */}
      {selectedRace && (
        <p className="text-xs text-slate-300 font-semibold truncate">
          {selectedRace.trackName} {selectedRace.round}R {selectedRace.name} {selectedRace.surface}
          {selectedRace.distance}m
        </p>
      )}
    </div>
  );
};
