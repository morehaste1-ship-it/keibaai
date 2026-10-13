// JRA Standard Frame Colors (枠色)
export interface FrameColorDef {
  frame: number;
  name: string;
  bg: string;
  text: string;
  border: string;
  badge: string;
}

export const JRA_FRAME_COLORS: Record<number, FrameColorDef> = {
  1: {
    frame: 1,
    name: '1枠 (白)',
    bg: 'bg-white',
    text: 'text-slate-900',
    border: 'border-slate-300',
    badge: 'bg-white text-slate-900 font-black border border-slate-300',
  },
  2: {
    frame: 2,
    name: '2枠 (黒)',
    bg: 'bg-slate-900',
    text: 'text-white',
    border: 'border-slate-700',
    badge: 'bg-slate-900 text-white font-black border border-slate-600',
  },
  3: {
    frame: 3,
    name: '3枠 (赤)',
    bg: 'bg-red-600',
    text: 'text-white',
    border: 'border-red-500',
    badge: 'bg-red-600 text-white font-black',
  },
  4: {
    frame: 4,
    name: '4枠 (青)',
    bg: 'bg-blue-600',
    text: 'text-white',
    border: 'border-blue-500',
    badge: 'bg-blue-600 text-white font-black',
  },
  5: {
    frame: 5,
    name: '5枠 (黄)',
    bg: 'bg-yellow-400',
    text: 'text-slate-900',
    border: 'border-yellow-300',
    badge: 'bg-yellow-400 text-slate-900 font-black',
  },
  6: {
    frame: 6,
    name: '6枠 (緑)',
    bg: 'bg-emerald-600',
    text: 'text-white',
    border: 'border-emerald-500',
    badge: 'bg-emerald-600 text-white font-black',
  },
  7: {
    frame: 7,
    name: '7枠 (橙)',
    bg: 'bg-orange-500',
    text: 'text-white',
    border: 'border-orange-400',
    badge: 'bg-orange-500 text-white font-black',
  },
  8: {
    frame: 8,
    name: '8枠 (桃)',
    bg: 'bg-pink-500',
    text: 'text-white',
    border: 'border-pink-400',
    badge: 'bg-pink-500 text-white font-black',
  },
};

export const MARK_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  '◎': { bg: 'bg-red-500/20 border-red-500', text: 'text-red-400', label: '本命' },
  '◯': { bg: 'bg-blue-500/20 border-blue-500', text: 'text-blue-400', label: '対抗' },
  '▲': { bg: 'bg-emerald-500/20 border-emerald-500', text: 'text-emerald-400', label: '単穴' },
  '△': { bg: 'bg-amber-500/20 border-amber-500', text: 'text-amber-400', label: '連下' },
  '☆': { bg: 'bg-purple-500/20 border-purple-500', text: 'text-purple-300', label: '特注穴' },
};
