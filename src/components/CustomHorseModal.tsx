import React, { useState } from 'react';
import { Horse, RunningStyle } from '../types/keiba';
import { X, Plus, Sparkles } from 'lucide-react';

interface CustomHorseModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddHorse: (horse: Horse) => void;
  currentHorseCount: number;
}

export const CustomHorseModal: React.FC<CustomHorseModalProps> = ({
  isOpen,
  onClose,
  onAddHorse,
  currentHorseCount,
}) => {
  const [name, setName] = useState<string>('');
  const [jockey, setJockey] = useState<string>('武豊');
  const [weight, setWeight] = useState<number>(58.0);
  const [odds, setOdds] = useState<number>(8.5);
  const [runningStyle, setRunningStyle] = useState<RunningStyle>('先行');
  const [sire, setSire] = useState<string>('ロードカナロア');
  const [damSire, setDamSire] = useState<string>('ディープインパクト');
  const [sireLine, setSireLine] = useState<string>('キングマンボ系');
  const [heavyTrackAptitude, setHeavyTrackAptitude] = useState<'S' | 'A' | 'B' | 'C'>('A');
  const [conditionStatus, setConditionStatus] = useState<'絶好調' | '好調' | '普通' | '不安'>('好調');
  const [trainerRating, setTrainerRating] = useState<number>(85);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const nextNumber = currentHorseCount + 1;
    const bracket = Math.min(Math.ceil((nextNumber / (currentHorseCount + 1)) * 8), 8) || 1;

    const newHorse: Horse = {
      id: `custom_${Date.now()}`,
      number: nextNumber,
      bracket: Math.min(Math.max(bracket, 1), 8),
      name: name.trim(),
      gender: '牡',
      age: 4,
      jockey,
      trainer: '新規厩舎',
      trainerRating,
      conditionStatus,
      conditionNote: conditionStatus === '絶好調' ? '追い切りで抜群の加速力、馬体充実' : '順調に仕上がる',
      weight,
      horseWeight: 500,
      weightChange: 0,
      odds,
      popularity: odds < 5 ? 2 : odds < 12 ? 5 : 8,
      runningStyle,
      pedigree: {
        sire,
        damSire,
        sireLine,
        aptitudeDist: '1200m〜1600m',
        heavyTrackAptitude,
        tokyoLongStraightAptitude: 'A',
        nakayamaSlopeAptitude: 'A',
      },
      speedRating: 90,
      staminaRating: 85,
      powerRating: 88,
      turnOfFootRating: 88,
      recentForm: 90,
      pastRaces: [],
    };

    onAddHorse(newHorse);
    setName('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded-lg bg-emerald-500/20 text-emerald-400">
              <Sparkles className="w-4 h-4" />
            </span>
            <h3 className="text-base font-black text-white">出走馬の追加・カスタム登録</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-300 mb-1">
              馬名 <span className="text-rose-400">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: ゴールドシップ、イクイノックス"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-400"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">騎手名</label>
              <input
                type="text"
                value={jockey}
                onChange={(e) => setJockey(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-400"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">斤量 (kg)</label>
              <input
                type="number"
                step="0.5"
                value={weight}
                onChange={(e) => setWeight(parseFloat(e.target.value) || 57.0)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-400"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">想定単勝オッズ (倍)</label>
              <input
                type="number"
                step="0.1"
                value={odds}
                onChange={(e) => setOdds(parseFloat(e.target.value) || 5.0)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-400"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">脚質</label>
              <select
                value={runningStyle}
                onChange={(e) => setRunningStyle(e.target.value as RunningStyle)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-400"
              >
                <option value="逃げ">逃げ (ハナを主張)</option>
                <option value="先行">先行 (好位追走)</option>
                <option value="差し">差し (中団待機)</option>
                <option value="追込">追込 (後方一気)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">父 (種牡馬)</label>
              <input
                type="text"
                value={sire}
                onChange={(e) => setSire(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-400"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">母父</label>
              <input
                type="text"
                value={damSire}
                onChange={(e) => setDamSire(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-400"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">血統系統</label>
              <select
                value={sireLine}
                onChange={(e) => setSireLine(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-400"
              >
                <option value="キングマンボ系">キングマンボ系 (ロードカナロア等)</option>
                <option value="サンデーサイレンス系">サンデーサイレンス系 (ディープ等)</option>
                <option value="ノーザンダンサー系">ノーザンダンサー系</option>
                <option value="ヘニーヒューズ系">ヘニーヒューズ系</option>
                <option value="その他">その他</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">重馬場適性</label>
              <select
                value={heavyTrackAptitude}
                onChange={(e) => setHeavyTrackAptitude(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-400"
              >
                <option value="S">Sランク (道悪得意・激走)</option>
                <option value="A">Aランク (良)</option>
                <option value="B">Bランク (普通)</option>
                <option value="C">Cランク (道悪苦手)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">当日のコンディション気配</label>
              <select
                value={conditionStatus}
                onChange={(e) => setConditionStatus(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-400"
              >
                <option value="絶好調">絶好調 (毛艶抜群・気迫溢れる)</option>
                <option value="好調">好調 (順調)</option>
                <option value="普通">普通 (平行線)</option>
                <option value="不安">不安 (気配鈍い・発汗)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">調教師評価指数 (0〜100)</label>
              <input
                type="number"
                min="60"
                max="100"
                value={trainerRating}
                onChange={(e) => setTrainerRating(parseInt(e.target.value) || 85)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-400"
              />
            </div>
          </div>

          <div className="pt-2 flex justify-end gap-2 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-xl transition"
            >
              キャンセル
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-black rounded-xl shadow-lg shadow-emerald-500/25 transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>登録して再計算</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
