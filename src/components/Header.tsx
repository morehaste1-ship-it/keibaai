import React from 'react';
import { Race, TrackCondition, WeatherCondition } from '../types/keiba';
import { Sparkles, CloudRain, Sun, Cloud, RefreshCw, PlusCircle } from 'lucide-react';
import { RaceNavigator } from './RaceNavigator';
import { PastRacePicker } from './PastRacePicker';

interface HeaderProps {
  races: Race[];
  selectedRace: Race | null;
  onSelectRace: (raceId: string) => void;
  weather: WeatherCondition;
  onWeatherChange: (w: WeatherCondition) => void;
  condition: TrackCondition;
  onConditionChange: (c: TrackCondition) => void;
  onOpenAddHorse: () => void;
  hasGeminiKey: boolean;
  /** 表示中の過去の日付（本日以降を表示中なら null） */
  pastDate: string | null;
  onPickPastDate: (date: string) => void;
  onBackToUpcoming: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  races,
  selectedRace,
  onSelectRace,
  weather,
  onWeatherChange,
  condition,
  onConditionChange,
  onOpenAddHorse,
  hasGeminiKey,
  pastDate,
  onPickPastDate,
  onBackToUpcoming,
}) => {
  return (
    <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur-md sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        {/* App Title & Brand */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 via-teal-500 to-amber-400 p-[2px] shadow-lg shadow-emerald-500/20">
            <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
              <span className="text-xl font-black text-emerald-400">🏇</span>
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-black tracking-tight text-white flex items-center gap-1.5">
                KeibaAI <span className="text-emerald-400">Pro</span>
              </h1>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                v2.5 Hybrid Engine
              </span>
            </div>
            <p className="text-xs text-slate-400 font-medium">
              競馬AI予想・血統適性・コース補正・展開＆ハナ切り馬分析
            </p>
          </div>
        </div>

        {/* 開催日・会場・レースの切り替え */}
        <div className="flex items-start gap-2 min-w-0 w-full sm:w-auto">
          <div className="min-w-0 flex-1 flex flex-col gap-2">
            {races.length === 0 ? (
              <span className="text-sm font-bold text-slate-500">
                {pastDate ? 'この日のレースはありません' : '本日以降のレースはまだありません（週末の出馬表は金曜1時の夜間処理で入ります）'}
              </span>
            ) : (
              <RaceNavigator key={pastDate ?? 'upcoming'} races={races} selectedRace={selectedRace} onSelectRace={onSelectRace} />
            )}
            <PastRacePicker pastDate={pastDate} onPick={onPickPastDate} onBack={onBackToUpcoming} />
          </div>

          {/* Add custom horse button */}
          <button
            onClick={onOpenAddHorse}
            disabled={!selectedRace}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
            title="出走馬を追加/編集"
          >
            <PlusCircle className="w-3.5 h-3.5 text-emerald-400" />
            <span>出走馬追加</span>
          </button>
        </div>

        {/* Dynamic Condition & Weather Bar (Triggers Instant Recalculation!) */}
        <div className="flex items-center gap-3 bg-slate-950/70 border border-slate-800 rounded-xl px-3 py-1.5">
          {/* Weather Selector */}
          <div className="flex items-center gap-1 text-xs">
            <span className="text-slate-400 text-[11px] font-bold mr-1">天候:</span>
            {(['晴', '曇', '雨'] as WeatherCondition[]).map((w) => (
              <button
                key={w}
                onClick={() => onWeatherChange(w)}
                className={`px-2 py-0.5 rounded text-xs font-bold transition flex items-center gap-1 ${
                  weather === w
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/50'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {w === '晴' && <Sun className="w-3 h-3 text-amber-400" />}
                {w === '曇' && <Cloud className="w-3 h-3 text-slate-400" />}
                {w === '雨' && <CloudRain className="w-3 h-3 text-blue-400" />}
                {w}
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-slate-800" />

          {/* Track Condition (馬場状態) */}
          <div className="flex items-center gap-1 text-xs">
            <span className="text-slate-400 text-[11px] font-bold mr-1">馬場:</span>
            {(['良', '稍重', '重', '不良'] as TrackCondition[]).map((c) => {
              const isActive = condition === c;
              let activeColor = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50';
              if (c === '重' || c === '不良') {
                activeColor = 'bg-blue-600/30 text-blue-300 border-blue-500/60 font-black';
              } else if (c === '稍重') {
                activeColor = 'bg-amber-500/20 text-amber-300 border-amber-500/50';
              }

              return (
                <button
                  key={c}
                  onClick={() => onConditionChange(c)}
                  className={`px-2 py-0.5 rounded text-xs font-bold transition border ${
                    isActive ? activeColor : 'text-slate-400 border-transparent hover:text-slate-200'
                  }`}
                >
                  {c}
                </button>
              );
            })}
          </div>

          <div className="h-4 w-px bg-slate-800" />

          {/* AI Status Badge */}
          <div className="flex items-center gap-1.5 text-[11px] text-slate-300">
            <Sparkles className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
            <span className="font-semibold text-emerald-400">
              {hasGeminiKey ? 'Gemini 3.8 Flash 連携' : 'AIエンジン稼働中'}
            </span>
          </div>
        </div>
      </div>
    </header>
  );
};
