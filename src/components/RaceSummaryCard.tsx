import React from 'react';
import { Race, CourseCharacteristics, PacePrediction } from '../types/keiba';
import { Compass, Flame, ShieldAlert, Award, TrendingUp, Info } from 'lucide-react';

interface RaceSummaryCardProps {
  race: Race;
  course: CourseCharacteristics;
  paceAnalysis: PacePrediction;
}

export const RaceSummaryCard: React.FC<RaceSummaryCardProps> = ({
  race,
  course,
  paceAnalysis,
}) => {
  const isSprintS = race.id === 'sprinters_stakes' || race.name.includes('スプリンターズ');

  return (
    <div className="bg-gradient-to-r from-slate-900 via-slate-900/95 to-slate-950 border border-slate-800 rounded-2xl p-5 shadow-xl relative overflow-hidden">
      {/* Decorative Glow */}
      <div className="absolute -top-12 -right-12 w-64 h-64 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-12 -left-12 w-64 h-64 bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10">
        {/* Top Info Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <span className="px-3 py-1 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-lg text-sm font-black tracking-wider">
              {race.grade}
            </span>
            <h2 className="text-2xl font-black text-white tracking-tight">
              {race.trackName} {race.round}R {race.name}
            </h2>
            <span className="text-slate-400 font-semibold text-sm">
              {race.surface}{race.distance}m ({course.turnType})
            </span>
          </div>

          <div className="flex items-center gap-2">
            <div className="px-3 py-1 bg-slate-800 rounded-lg text-xs font-semibold text-slate-300 border border-slate-700">
              発走 <span className="text-white font-bold">{race.postTime}</span>
            </div>
            <div className="px-3 py-1 bg-slate-800 rounded-lg text-xs font-semibold text-slate-300 border border-slate-700">
              出走 <span className="text-emerald-400 font-bold">{race.horses.length}頭</span>
            </div>
            <div className={`px-3 py-1 rounded-lg text-xs font-black border ${
              race.condition === '良'
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-blue-500/20 text-blue-300 border-blue-500/40'
            }`}>
              {race.weather} / {race.condition}馬場
            </div>
          </div>
        </div>

        {/* 3 Key Analysis Metrics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          {/* Card 1: Course Characteristics */}
          <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1 font-semibold">
                <span className="flex items-center gap-1.5">
                  <Compass className="w-3.5 h-3.5 text-emerald-400" />
                  コース形態・直線
                </span>
                <span className="text-white font-bold">{course.straightLength}m</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed font-medium">
                {course.slopeDetail}
              </p>
            </div>
            <div className="mt-2.5 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px]">
              <span className="text-slate-400">枠順バイアス:</span>
              <span className="font-bold text-amber-300">
                {course.frameBias.inside > 1.1 ? '内枠有利 (1-3枠)' : course.frameBias.outside > 1.05 ? '外枠有利' : '枠順フラット'}
              </span>
            </div>
          </div>

          {/* Card 2: Pace Prediction */}
          <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1 font-semibold">
                <span className="flex items-center gap-1.5">
                  <Flame className="w-3.5 h-3.5 text-rose-400" />
                  ペース想定
                </span>
                <span className={`px-2 py-0.5 rounded text-[11px] font-black ${
                  paceAnalysis.predictedPace.includes('ハイ')
                    ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                    : paceAnalysis.predictedPace.includes('スロー')
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                    : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                }`}>
                  {paceAnalysis.predictedPace}ペース
                </span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed font-medium">
                {paceAnalysis.deploymentSummary}
              </p>
            </div>
            <div className="mt-2.5 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px]">
              <span className="text-slate-400">有利脚質:</span>
              <span className="font-bold text-emerald-400">
                {course.styleBias.nige >= 1.2 ? '逃げ・先行粘り込み' : course.styleBias.sashi >= 1.2 ? '差し・好位抜け出し' : '先行〜好位差し'}
              </span>
            </div>
          </div>

          {/* Card 3: Historical Front-runner Data (ハナ切り馬の過去実績) */}
          <div className="bg-slate-950/60 border border-amber-500/30 rounded-xl p-3.5 flex flex-col justify-between relative overflow-hidden">
            <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/5 rounded-full blur-xl pointer-events-none" />
            <div>
              <div className="flex items-center justify-between text-xs text-amber-300 mb-1 font-bold">
                <span className="flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-amber-400" />
                  逃げ・ハナ切り馬の過去データ
                </span>
                <span className="px-2 py-0.5 bg-amber-500/20 text-amber-300 rounded font-black text-[11px]">
                  複勝率 {course.historicalPaceData.frontRunnerPlaceRate}%
                </span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed font-medium">
                {isSprintS
                  ? 'スプリンターズS過去10年: ハナを切った逃げ馬が過去4回3着以内（複勝率40%）！ハイペースでも内ラチ沿いの経済コースを通れば粘り込み多発。'
                  : course.historicalPaceData.keyInsight}
              </p>
            </div>
            <div className="mt-2.5 pt-2 border-t border-amber-500/20 flex items-center justify-between text-[11px]">
              <span className="text-slate-400">好走ポジション帯:</span>
              <span className="font-bold text-amber-300">{course.historicalPaceData.bestPassingRankTrend}</span>
            </div>
          </div>
        </div>

        {/* Insight Alert Box */}
        <div className="bg-emerald-950/40 border border-emerald-500/30 rounded-xl px-4 py-2.5 flex items-center gap-3">
          <Info className="w-4 h-4 text-emerald-400 shrink-0" />
          <p className="text-xs text-emerald-200/90 font-medium">
            <strong className="text-emerald-300 font-bold">AI補正値適用中:</strong> {course.trackName}{course.distance}mの「{course.slopeDetail ? '坂・直線勾配' : 'コース起伏'}」「枠順バイアス」「馬場状態({race.condition})」を反映し、各馬の走破力・展開利害・血統適合度を再計算しました。
          </p>
        </div>
      </div>
    </div>
  );
};
