/**
 * 勝率・連対率ヒートマップ用カラー計算および強度判定ユーティリティ
 */

export interface HeatLevel {
  label: string;
  grade: 'S+' | 'A' | 'B' | 'C' | 'D';
  bgClass: string;
  textClass: string;
  borderClass: string;
  badgeBg: string;
  heatBarColor: string;
  minVal: number;
}

export const WIN_RATE_LEVELS: HeatLevel[] = [
  {
    label: '激熱 (単勝最有力)',
    grade: 'S+',
    minVal: 25,
    bgClass: 'bg-rose-500/25',
    textClass: 'text-rose-200 font-black',
    borderClass: 'border-rose-500/50',
    badgeBg: 'bg-rose-500 text-white',
    heatBarColor: 'from-rose-500 to-red-600',
  },
  {
    label: '高勝率 (勝ち負け)',
    grade: 'A',
    minVal: 18,
    bgClass: 'bg-orange-500/20',
    textClass: 'text-orange-200 font-black',
    borderClass: 'border-orange-500/40',
    badgeBg: 'bg-orange-500 text-white',
    heatBarColor: 'from-orange-500 to-amber-500',
  },
  {
    label: '好走圏 (単穴射程)',
    grade: 'B',
    minVal: 10,
    bgClass: 'bg-amber-500/15',
    textClass: 'text-amber-200 font-bold',
    borderClass: 'border-amber-500/30',
    badgeBg: 'bg-amber-500 text-slate-950 font-bold',
    heatBarColor: 'from-amber-500 to-yellow-500',
  },
  {
    label: '連下押さえ',
    grade: 'C',
    minVal: 5,
    bgClass: 'bg-emerald-500/10',
    textClass: 'text-emerald-300 font-semibold',
    borderClass: 'border-emerald-500/20',
    badgeBg: 'bg-emerald-600 text-white',
    heatBarColor: 'from-emerald-500 to-teal-500',
  },
  {
    label: '低確率・見送り',
    grade: 'D',
    minVal: 0,
    bgClass: 'bg-slate-800/40',
    textClass: 'text-slate-400 font-normal',
    borderClass: 'border-slate-800',
    badgeBg: 'bg-slate-700 text-slate-300',
    heatBarColor: 'from-slate-600 to-slate-700',
  },
];

export const QUINELLA_RATE_LEVELS: HeatLevel[] = [
  {
    label: '鉄板級 (連対率50%超)',
    grade: 'S+',
    minVal: 50,
    bgClass: 'bg-rose-500/30',
    textClass: 'text-rose-200 font-black',
    borderClass: 'border-rose-500/60 ring-1 ring-rose-500/30',
    badgeBg: 'bg-rose-500 text-white shadow-sm shadow-rose-500/50',
    heatBarColor: 'from-rose-500 via-amber-500 to-yellow-400',
  },
  {
    label: '有力連軸 (連対率35〜49%)',
    grade: 'A',
    minVal: 35,
    bgClass: 'bg-orange-500/25',
    textClass: 'text-orange-200 font-black',
    borderClass: 'border-orange-500/50',
    badgeBg: 'bg-orange-500 text-white',
    heatBarColor: 'from-orange-500 to-amber-500',
  },
  {
    label: '連対圏内 (連対率20〜34%)',
    grade: 'B',
    minVal: 20,
    bgClass: 'bg-amber-500/20',
    textClass: 'text-amber-200 font-bold',
    borderClass: 'border-amber-500/40',
    badgeBg: 'bg-amber-500 text-slate-950 font-bold',
    heatBarColor: 'from-amber-400 to-emerald-400',
  },
  {
    label: 'ヒモ候補 (連対率10〜19%)',
    grade: 'C',
    minVal: 10,
    bgClass: 'bg-emerald-500/15',
    textClass: 'text-emerald-300 font-medium',
    borderClass: 'border-emerald-500/30',
    badgeBg: 'bg-emerald-600/80 text-white',
    heatBarColor: 'from-emerald-500 to-teal-500',
  },
  {
    label: '連対薄 (連対率10%未満)',
    grade: 'D',
    minVal: 0,
    bgClass: 'bg-slate-800/40',
    textClass: 'text-slate-400',
    borderClass: 'border-slate-800',
    badgeBg: 'bg-slate-700 text-slate-400',
    heatBarColor: 'from-slate-600 to-slate-800',
  },
];

export function getWinRateHeat(rate: number): HeatLevel {
  return WIN_RATE_LEVELS.find((l) => rate >= l.minVal) || WIN_RATE_LEVELS[WIN_RATE_LEVELS.length - 1];
}

export function getQuinellaRateHeat(rate: number): HeatLevel {
  return QUINELLA_RATE_LEVELS.find((l) => rate >= l.minVal) || QUINELLA_RATE_LEVELS[QUINELLA_RATE_LEVELS.length - 1];
}

/**
 * 0〜100の任意のスコアに対するヒートマップスタイル（背景・文字色・バー色）
 */
export function getMetricHeatStyle(value: number, min = 0, max = 100): {
  bg: string;
  text: string;
  border: string;
  pct: number;
} {
  const norm = Math.min(Math.max(((value - min) / (max - min)) * 100, 0), 100);

  if (norm >= 80) {
    return {
      bg: 'bg-rose-500/30',
      text: 'text-rose-200 font-black',
      border: 'border-rose-500/50',
      pct: norm,
    };
  }
  if (norm >= 60) {
    return {
      bg: 'bg-orange-500/25',
      text: 'text-orange-200 font-bold',
      border: 'border-orange-500/40',
      pct: norm,
    };
  }
  if (norm >= 40) {
    return {
      bg: 'bg-amber-500/20',
      text: 'text-amber-200 font-semibold',
      border: 'border-amber-500/30',
      pct: norm,
    };
  }
  if (norm >= 20) {
    return {
      bg: 'bg-emerald-500/15',
      text: 'text-emerald-300 font-medium',
      border: 'border-emerald-500/20',
      pct: norm,
    };
  }
  return {
    bg: 'bg-slate-800/40',
    text: 'text-slate-400 font-normal',
    border: 'border-slate-800',
    pct: norm,
  };
}
