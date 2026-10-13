import React, { useState } from 'react';
import { CalendarDays, AlertCircle } from 'lucide-react';

interface BatchDetail {
  raceId: string;
  status: 'success' | 'failure';
  message: string;
}

interface BatchResponse {
  status: 'success' | 'error';
  error?: string;
  targetSaturday?: string;
  targetDate?: string;
  batch?: {
    totalRaces: number;
    successCount: number;
    failureCount: number;
    details: BatchDetail[];
  };
}

// ローカル時間の今日を YYYY-MM-DD で返す
function todayString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// YYYY-MM-DD に日数を足す（表示用）
function shiftDay(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function WeekendBatchButton() {
  const [date, setDate] = useState<string>(todayString());
  const [loadingKind, setLoadingKind] = useState<'weekend' | 'day' | null>(null);
  const [error, setError] = useState<string>('');
  const [result, setResult] = useState<BatchResponse | null>(null);

  const runFetch = async (kind: 'weekend' | 'day') => {
    if (!date) {
      setError('日付を選択してください');
      return;
    }

    setLoadingKind(kind);
    setError('');
    setResult(null);

    const endpoint = kind === 'weekend' ? '/api/batch/prepare-weekend' : '/api/batch/prepare-day';

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      });

      const data: BatchResponse = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'データの取得に失敗しました');
      }

      setResult(data);
    } catch (err: any) {
      setError(err.message || 'エラーが発生しました');
      console.error('Batch error:', err);
    } finally {
      setLoadingKind(null);
    }
  };

  const isLoading = loadingKind !== null;
  const batch = result?.batch;

  return (
    <div className="bg-slate-900/50 border-b border-slate-800 px-4 py-4">
      <div className="max-w-7xl mx-auto flex flex-col gap-2">
        <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
          <CalendarDays className="w-3.5 h-3.5 text-emerald-400" />
          出馬表を一括取得（週末＝指定日を基準に土日、単日＝指定日の1日だけ）
        </label>
        <div className="flex flex-wrap gap-2 items-center">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={isLoading}
            className="px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
          />
          <button
            onClick={() => runFetch('weekend')}
            disabled={isLoading}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <CalendarDays className="w-4 h-4" />
            {loadingKind === 'weekend' ? '取得中（数分かかります）…' : '週末データを取得'}
          </button>
          <button
            onClick={() => runFetch('day')}
            disabled={isLoading}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <CalendarDays className="w-4 h-4" />
            {loadingKind === 'day' ? '取得中（数分かかります）…' : 'この日だけ取得'}
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {error}
          </div>
        )}

        {batch && result?.targetSaturday && (
          <div className="px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs text-slate-300">
            <p>
              対象: {result.targetSaturday}（土）・{shiftDay(result.targetSaturday, 1)}（日）
            </p>
            <p className="mt-1">
              合計 {batch.totalRaces} レース / 成功 {batch.successCount} / 失敗 {batch.failureCount}
            </p>
            {batch.details
              .filter((d) => d.status === 'failure')
              .map((d) => (
                <p key={d.raceId} className="mt-1 text-red-300">
                  ✗ {d.raceId}: {d.message}
                </p>
              ))}
          </div>
        )}

        {batch && result?.targetDate && (
          <div className="px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs text-slate-300">
            <p>対象: {result.targetDate}（単日）</p>
            <p className="mt-1">
              合計 {batch.totalRaces} レース / 成功 {batch.successCount} / 失敗 {batch.failureCount}
            </p>
            {batch.details
              .filter((d) => d.status === 'failure')
              .map((d) => (
                <p key={d.raceId} className="mt-1 text-red-300">
                  ✗ {d.raceId}: {d.message}
                </p>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
