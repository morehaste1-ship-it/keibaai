import React, { useEffect, useMemo, useState } from 'react';
import { Calculator, RotateCcw, AlertCircle, BookmarkPlus } from 'lucide-react';
import { TrifectaSection } from './TrifectaSection';
import type { HistoryCorner, RaceInfo, RealDataView } from '../utils/trifecta';
import type { DataMarkInfo, TrackCondition } from '../types/keiba';
import {
  COMPONENT_KEYS,
  COMPONENT_LABELS,
  rankAndMark,
  normalizeTo100,
  DEFAULT_SMOOTHING,
  SHORTAGE_LABELS,
  SHORTAGE_THRESHOLD,
  smoothingExample,
  type ShortageMode,
  type Smoothing,
  COMPONENT_DESCRIPTIONS,
  type ComponentKey,
  type ScoreItem,
  type Weights,
} from '../utils/dataScore';

const STORAGE_KEY = 'keibaai.scoreWeights';
const SMOOTHING_KEY = 'keibaai.scoreSmoothing';
const SHORTAGE_KEY = 'keibaai.shortageMode';
/** 保存した配分が、どの版の「採用中の配分」を見たうえでのものか（配分の自動見直しの版。0 = 既定の配分） */
const WEIGHTS_VERSION_KEY = 'keibaai.weightsVersion';
/** 答え合わせパネルで配分を戻したときなどに、データ予想を読み直す合図 */
export const WEIGHTS_UPDATED_EVENT = 'keiba-weights-updated';

function hasSavedWeights(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function loadWeightsVersion(): number | null {
  try {
    const v = localStorage.getItem(WEIGHTS_VERSION_KEY);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

function loadSmoothing(): Smoothing {
  try {
    const v = JSON.parse(localStorage.getItem(SMOOTHING_KEY) ?? 'null');
    if (v && Number.isInteger(v.horseK) && Number.isInteger(v.jockeyK)) {
      return { horseK: Math.min(10, Math.max(0, v.horseK)), jockeyK: Math.min(30, Math.max(0, v.jockeyK)) };
    }
  } catch {
    // 読めなければ既定値
  }
  return DEFAULT_SMOOTHING;
}

function loadShortage(): ShortageMode {
  try {
    const v = localStorage.getItem(SHORTAGE_KEY);
    if (v === 'keep' || v === 'exclude' || v === 'lower') return v;
  } catch {
    // 読めなければ既定値
  }
  return 'keep';
}

function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できなくても画面の動作には影響させない
  }
}

/** 比率バー・凡例の色（項目ごと） */
const COMPONENT_COLORS: Record<string, string> = {
  recent: 'bg-emerald-400',
  aptitude: 'bg-sky-400',
  jockey: 'bg-violet-400',
  matchup: 'bg-amber-400',
  history: 'bg-rose-400',
  state: 'bg-slate-300',
  closing: 'bg-pink-400',
  margin: 'bg-lime-400',
  speed: 'bg-cyan-400',
  frame: 'bg-orange-400',
  change: 'bg-indigo-400',
  layoff: 'bg-yellow-200',
  position: 'bg-teal-300',
  jockeyPos: 'bg-fuchsia-400',
  trend: 'bg-amber-200',
};

/** 保存済みの配分を読み、無い項目（新しく増えた項目など）は既定値で補う */
function loadWeights(defaults: Weights): Weights {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const w = JSON.parse(raw);
    const merged = { ...defaults };
    for (const k of COMPONENT_KEYS) if (typeof w?.[k] === 'number') merged[k] = w[k];
    return merged;
  } catch {
    return defaults;
  }
}

/** 答え合わせパネルの「この配分を適用」から、配分を保存して画面に反映する */
export const APPLY_WEIGHTS_EVENT = 'keiba-apply-weights';
export function applyWeightsFromReview(w: Weights): void {
  saveWeights(w);
  window.dispatchEvent(new CustomEvent(APPLY_WEIGHTS_EVENT, { detail: w }));
}

function saveWeights(w: Weights): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(w));
  } catch {
    // 保存できなくても画面の動作には影響させない
  }
}

const MARK_CLASS: Record<string, string> = {
  '◎': 'text-red-400',
  '◯': 'text-blue-400',
  '▲': 'text-emerald-400',
  '△': 'text-slate-300',
  '☆': 'text-amber-300',
};

interface Props {
  raceKey: string;
  condition: TrackCondition;
  /** 印（馬番 → 印）を親に渡す。出馬表タブの印の置き換えに使う */
  onMarks: (marks: Record<number, DataMarkInfo> | null) => void;
  /** データ予想の結果一式を親に渡す（各タブの実データ表示に使う） */
  onData?: (data: RealDataView | null) => void;
}

export const DataPredictionPanel: React.FC<Props> = ({ raceKey, condition, onMarks, onData }) => {
  const [items, setItems] = useState<ScoreItem[] | null>(null);
  const [meta, setMeta] = useState<{ race: RaceInfo; historyCorner: HistoryCorner } | null>(null);
  const [defaults, setDefaults] = useState<Weights | null>(null);
  const [weights, setWeights] = useState<Weights | null>(null);
  const [error, setError] = useState('');
  // マウスを乗せている項目（説明の表示用）
  // 項目の説明のツールチップ（マウスの位置に重ねて表示。画面の配置は動かさない）
  const [tip, setTip] = useState<{ k: ComponentKey; x: number; y: number } | null>(null);
  const hovered = tip?.k ?? null;
  const tipHandlers = (k: ComponentKey) => ({
    onMouseEnter: (e: React.MouseEvent) => setTip({ k, x: e.clientX, y: e.clientY }),
    onMouseMove: (e: React.MouseEvent) => setTip({ k, x: e.clientX, y: e.clientY }),
    onMouseLeave: () => setTip(null),
  });
  // 補正の強さ（スライダーの表示用）と、計算に使う値（動かし終わって少し待ってから反映）
  const [smoothing, setSmoothing] = useState<Smoothing>(loadSmoothing);
  const [appliedSmoothing, setAppliedSmoothing] = useState<Smoothing>(smoothing);
  const [shortageMode, setShortageMode] = useState<ShortageMode>(loadShortage);
  // 自動見直しで採用中の配分が変わり、保存した配分と違うときのお知らせ
  const [versionNotice, setVersionNotice] = useState<{ id: number; adoptedAt: string | null; reason: string | null } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const onUpdated = () => setReloadKey((n) => n + 1);
    window.addEventListener(WEIGHTS_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(WEIGHTS_UPDATED_EVENT, onUpdated);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setAppliedSmoothing(smoothing);
      saveSetting(SMOOTHING_KEY, JSON.stringify(smoothing));
    }, 300);
    return () => clearTimeout(t);
  }, [smoothing]);

  useEffect(() => {
    let cancelled = false;
    setError('');
    fetch(
      `/api/score/${raceKey}?condition=${encodeURIComponent(condition)}&horseK=${appliedSmoothing.horseK}&jockeyK=${appliedSmoothing.jockeyK}`,
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'データ予想の読み込みに失敗しました');
        if (cancelled) return;
        setItems(data.score.items);
        setMeta({ race: data.score.race, historyCorner: data.score.historyCorner });
        const def: Weights = data.score.defaultWeights;
        setDefaults(def);
        setWeights((prev) => prev ?? loadWeights(def));
        // 採用中の配分の版が、保存した配分を決めたときと違えば知らせる（保存した配分が採用中と同じなら黙って更新）
        const versionId: number = data.score.weightsVersion?.id ?? 0;
        // 保存した配分が無い、または自動見直しの履歴がまだ無く版も未記録（この機能より前に保存した配分）なら知らせない
        if (!hasSavedWeights() || (versionId === 0 && loadWeightsVersion() === null)) {
          saveSetting(WEIGHTS_VERSION_KEY, String(versionId));
          setVersionNotice(null);
        } else if (loadWeightsVersion() !== versionId) {
          const saved = loadWeights(def);
          if (COMPONENT_KEYS.every((k) => saved[k] === def[k])) {
            saveSetting(WEIGHTS_VERSION_KEY, String(versionId));
            setVersionNotice(null);
          } else {
            setVersionNotice({ id: versionId, adoptedAt: data.score.weightsVersion?.adoptedAt ?? null, reason: data.score.weightsVersion?.reason ?? null });
          }
        } else {
          setVersionNotice(null);
        }
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [raceKey, condition, appliedSmoothing, reloadKey]);

  const ranked = useMemo(
    () => (items && weights ? rankAndMark(items, weights, shortageMode) : null),
    [items, weights, shortageMode],
  );

  // 印を親（出馬表タブ）へ渡す
  useEffect(() => {
    if (!ranked) {
      onMarks(null);
      onData?.(null);
      return;
    }
    onData?.({ ranked, race: meta?.race ?? null, historyCorner: meta?.historyCorner ?? null });
    const map: Record<number, DataMarkInfo> = {};
    for (const r of ranked)
      if (r.horseNumber !== null)
        map[r.horseNumber] = { mark: r.mark, rank: r.rank, total: r.total, sireName: r.sireName, bmsName: r.bmsName, mainStyle: r.mainStyle, aptitudeMatrix: r.aptitudeMatrix ?? null };
    onMarks(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranked, meta]);

  // 答え合わせパネルの修正案を受け取る
  useEffect(() => {
    const onApply = (e: Event) => {
      const w = (e as CustomEvent<Weights>).detail;
      if (w && COMPONENT_KEYS.every((k) => typeof w[k] === 'number')) setWeights({ ...w });
    };
    window.addEventListener(APPLY_WEIGHTS_EVENT, onApply);
    return () => window.removeEventListener(APPLY_WEIGHTS_EVENT, onApply);
  }, []);

  const changeWeight = (key: keyof Weights, value: number) => {
    if (!weights) return;
    const next = { ...weights, [key]: value };
    setWeights(next);
    saveWeights(next);
  };

  const resetWeights = () => {
    if (!defaults) return;
    setWeights(defaults);
    saveWeights(defaults);
    if (versionNotice) saveSetting(WEIGHTS_VERSION_KEY, String(versionNotice.id));
    setVersionNotice(null);
  };

  const keepSavedWeights = () => {
    if (versionNotice) saveSetting(WEIGHTS_VERSION_KEY, String(versionNotice.id));
    setVersionNotice(null);
  };

  const wSum = weights ? COMPONENT_KEYS.reduce((s, k) => s + weights[k], 0) : 0;

  // 答え合わせ用に、今の設定での予想を記録する（サーバーで同じ計算をして保存）
  const [recordMsg, setRecordMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const recordPrediction = async () => {
    if (!weights) return;
    setRecording(true);
    setRecordMsg(null);
    try {
      const res = await fetch(`/api/review/record/${raceKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: { weights, horseK: appliedSmoothing.horseK, jockeyK: appliedSmoothing.jockeyK, shortageMode, condition },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '記録に失敗しました');
      setRecordMsg({ ok: true, text: `記録しました（${new Date(data.recordedAt).toLocaleTimeString('ja-JP')}）。発走前なら押し直すと上書きされます` });
      window.dispatchEvent(new Event('keiba-review-updated'));
    } catch (e: any) {
      setRecordMsg({ ok: false, text: e.message });
    } finally {
      setRecording(false);
    }
  };

  // 今の比率を保ったまま、合計がちょうど100%になるように整える
  const normalizeWeights = () => {
    if (!weights || wSum === 0) return;
    const next = normalizeTo100(weights);
    setWeights(next);
    saveWeights(next);
  };

  return (
    <section className="max-w-7xl w-full mx-auto px-4 pt-4">
      <div className="bg-slate-900/60 border border-emerald-800/60 rounded-xl p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-black text-white flex items-center gap-1.5">
            <Calculator className="w-4 h-4 text-emerald-400" />
            データ予想（実データの点数で印を付けています）
          </h2>
          <span className="text-[11px] text-slate-400">集計の馬場: {condition}</span>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {error}
          </div>
        )}

        {versionNotice && defaults && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-teal-500/10 border border-teal-500/30 rounded-lg text-[11px] text-teal-100">
            <span>
              {versionNotice.id === 0
                ? '採用中の配分が既定の配分に戻りました'
                : `${versionNotice.reason === 'auto' ? '配分の自動見直しで、' : ''}採用中の配分が変わりました（${versionNotice.adoptedAt ? new Date(versionNotice.adoptedAt).toLocaleDateString('ja-JP') : ''}${versionNotice.reason === 'revert' ? '・1つ前に戻した' : ''}）`}
              ：{COMPONENT_KEYS.map((k) => `${COMPONENT_LABELS[k]}${defaults[k]}%`).join('・')}。今は、以前に保存した配分で表示しています。
            </span>
            <button onClick={resetWeights} className="px-2 py-0.5 rounded border border-teal-600 text-teal-200 hover:bg-teal-900/40">
              採用中の配分にする
            </button>
            <button onClick={keepSavedWeights} className="px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:bg-slate-800">
              今の配分のままにする
            </button>
          </div>
        )}

        {weights && (
          <div className="flex flex-col gap-2 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2">
            {/* 配分の合計と、実際に計算に使う比率 */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-300">
                配分の合計:{' '}
                <span className={`text-sm font-black ${wSum === 100 ? 'text-emerald-300' : 'text-amber-300'}`}>{wSum}%</span>
                {wSum !== 100 && (
                  <span className="text-[11px] text-amber-300 ml-2">
                    100%ではありません（計算は下のバーの比率で行います）
                  </span>
                )}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={normalizeWeights}
                  disabled={wSum === 100 || wSum === 0}
                  className="px-2 py-1 text-[11px] rounded border border-emerald-700 text-emerald-300 hover:bg-emerald-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  合計を100%にそろえる
                </button>
                <button
                  onClick={resetWeights}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-slate-700 text-slate-300 hover:bg-slate-800"
                >
                  <RotateCcw className="w-3 h-3" />
                  採用中の配分に戻す
                </button>
              </div>
            </div>

            {/* 比率のバー（各項目が合計点の何割を占めるか） */}
            <div className="flex h-5 w-full overflow-hidden rounded border border-slate-700">
              {wSum === 0 ? (
                <div className="flex-1 flex items-center justify-center text-[10px] text-slate-500">配分がすべて0%です</div>
              ) : (
                COMPONENT_KEYS.filter((k) => weights[k] > 0).map((k) => {
                  const share = (weights[k] / wSum) * 100;
                  return (
                    <div
                      key={k}
                      className={`${COMPONENT_COLORS[k]} flex items-center justify-center text-[10px] font-bold text-slate-950 whitespace-nowrap overflow-hidden`}
                      style={{ width: `${share}%` }}
                      {...tipHandlers(k)}
                    >
                      {share >= 8 ? `${COMPONENT_LABELS[k]} ${Math.round(share)}%` : ''}
                    </div>
                  );
                })
              )}
            </div>

            <p className="text-[10px] text-slate-500">
              比率バーやスライダーの項目名にマウスを乗せると、その項目の計算方法と元データがツールチップで表示されます。合計点＝各項目の点数×比率の合計です。
            </p>

            {/* 項目の説明のツールチップ（マウスの近くに重ねて表示。操作の邪魔にならないよう、マウスの操作は下に通す） */}
            {tip && hovered && (
              <div
                role="tooltip"
                className="fixed z-50 pointer-events-none w-[340px] max-w-[90vw] rounded-lg border border-slate-600 bg-slate-900/95 shadow-xl px-3 py-2 text-[11px] text-slate-300"
                style={{
                  left: Math.min(Math.max(tip.x, 180), window.innerWidth - 180),
                  top: tip.y,
                  // 上に十分な余白があればマウスの上に、無ければ下に出す
                  transform: tip.y > 300 ? 'translate(-50%, calc(-100% - 14px))' : 'translate(-50%, 18px)',
                }}
              >
                <p className="font-bold text-white flex items-center gap-1.5 flex-wrap">
                  <span className={`inline-block w-2.5 h-2.5 rounded-sm ${COMPONENT_COLORS[hovered]}`} />
                  {COMPONENT_LABELS[hovered]}（設定 {weights[hovered]}%{wSum > 0 ? `・実際 ${Math.round((weights[hovered] / wSum) * 100)}%` : ''}）
                </p>
                <p className="text-slate-200 mt-0.5">{COMPONENT_DESCRIPTIONS[hovered].summary}</p>
                <p className="text-slate-400 mt-0.5">データ：{COMPONENT_DESCRIPTIONS[hovered].source}</p>
                <ul className="mt-1 list-disc pl-4 space-y-0.5">
                  {COMPONENT_DESCRIPTIONS[hovered].lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                  {hovered === 'aptitude' && (
                    <li className="text-sky-300">今の補正の強さ：仮{appliedSmoothing.horseK}戦（下の「補正の強さ」で変更できます）</li>
                  )}
                  {(hovered === 'jockey' || hovered === 'matchup') && (
                    <li className="text-violet-300">今の補正の強さ：仮{appliedSmoothing.jockeyK}戦（下の「補正の強さ」で変更できます）</li>
                  )}
                </ul>
              </div>
            )}

            {/* スライダー（設定値） */}
            <div className="flex flex-wrap items-end gap-4">
              {COMPONENT_KEYS.map((k) => (
                <label
                  key={k}
                  className="flex flex-col text-[11px] text-slate-300 min-w-[110px]"
                >
                  {/* 項目名に乗せたときだけ説明を出す（スライダーを動かすときは出さない） */}
                  <span className="flex items-center gap-1 cursor-help" {...tipHandlers(k)}>
                    <span className={`inline-block w-2.5 h-2.5 rounded-sm ${COMPONENT_COLORS[k]}`} />
                    {COMPONENT_LABELS[k]} <span className="font-bold text-white">{weights[k]}%</span>
                    {wSum !== 100 && wSum > 0 && (
                      <span className="text-slate-500">（実際 {Math.round((weights[k] / wSum) * 100)}%）</span>
                    )}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={weights[k]}
                    onChange={(e) => changeWeight(k, Number(e.target.value))}
                    className="accent-emerald-500"
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        {/* 補正の強さと、データ不足の馬の扱い */}
        <div className="flex flex-wrap gap-4 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-[11px] text-slate-300">
          <div className="flex flex-col gap-1 min-w-[260px] flex-1">
            <p className="font-bold text-white">補正の強さ（出走数が少ないときに平均へ寄せる度合い）</p>
            <label className="flex items-center gap-2">
              <span className="w-28">馬（適性）</span>
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={smoothing.horseK}
                onChange={(e) => setSmoothing({ ...smoothing, horseK: Number(e.target.value) })}
                className="accent-sky-500 flex-1"
              />
              <span className="w-16 text-right font-bold text-white">仮{smoothing.horseK}戦</span>
            </label>
            <label className="flex items-center gap-2">
              <span className="w-28">騎手（騎手・相性）</span>
              <input
                type="range"
                min={0}
                max={30}
                step={1}
                value={smoothing.jockeyK}
                onChange={(e) => setSmoothing({ ...smoothing, jockeyK: Number(e.target.value) })}
                className="accent-violet-500 flex-1"
              />
              <span className="w-16 text-right font-bold text-white">仮{smoothing.jockeyK}戦</span>
            </label>
            <p className="text-slate-400">
              例：1戦1勝（実際100%）の馬は、今の設定だと
              <span className="font-bold text-sky-300"> {smoothingExample(smoothing.horseK)}% </span>
              として扱います（基準30%の場合）。0にすると補正なし、大きくするほど平均に近づきます。
            </p>
            <button
              onClick={() => setSmoothing(DEFAULT_SMOOTHING)}
              disabled={smoothing.horseK === DEFAULT_SMOOTHING.horseK && smoothing.jockeyK === DEFAULT_SMOOTHING.jockeyK}
              className="self-start flex items-center gap-1 px-2 py-1 rounded border border-slate-700 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RotateCcw className="w-3 h-3" />
              既定に戻す（馬3戦・騎手10戦）
            </button>
          </div>
          <div className="flex flex-col gap-1 min-w-[220px]">
            <p className="font-bold text-white">データ不足の馬の扱い</p>
            <p className="text-slate-400">中立（データ不足）の項目が{SHORTAGE_THRESHOLD}つ以上ある馬が対象</p>
            {(Object.keys(SHORTAGE_LABELS) as ShortageMode[]).map((m) => (
              <label key={m} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name={`shortage-${raceKey}`}
                  checked={shortageMode === m}
                  onChange={() => {
                    setShortageMode(m);
                    saveSetting(SHORTAGE_KEY, m);
                  }}
                  className="accent-emerald-500"
                />
                {SHORTAGE_LABELS[m]}
              </label>
            ))}
          </div>
        </div>

        {ranked && (
          <div className="overflow-x-auto border border-slate-800 rounded-lg">
            <table className="w-full text-xs">
              <thead className="bg-slate-900 text-slate-400">
                <tr>
                  <th className="text-left px-2 py-1.5 font-semibold">印</th>
                  <th className="text-left px-2 py-1.5 font-semibold">順位</th>
                  <th className="text-left px-2 py-1.5 font-semibold">馬番・馬名</th>
                  <th className="text-left px-2 py-1.5 font-semibold">騎手</th>
                  <th className="text-right px-2 py-1.5 font-semibold">人気</th>
                  <th className="text-left px-2 py-1.5 font-semibold">間隔</th>
                  <th className="text-left px-2 py-1.5 font-semibold">乗替</th>
                  <th className="text-left px-2 py-1.5 font-semibold">馬体重</th>
                  <th className="text-right px-2 py-1.5 font-semibold">合計</th>
                  {COMPONENT_KEYS.map((k) => (
                    <th key={k} className="text-right px-2 py-1.5 font-semibold cursor-help" title={COMPONENT_DESCRIPTIONS[k].summary}>
                      {COMPONENT_LABELS[k]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ranked.map((r) => (
                  <tr key={`${r.horseNumber}-${r.horseName}`} className="border-t border-slate-800 text-slate-200">
                    <td className={`px-2 py-1 text-base font-black ${MARK_CLASS[r.mark] ?? ''}`}>{r.mark}</td>
                    <td className="px-2 py-1">{r.rank}</td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      {r.horseNumber ?? '-'} {r.horseName}
                      {r.shortage && (
                        <span className="ml-1 px-1 rounded text-[10px] border border-amber-600/60 text-amber-300">データ不足</span>
                      )}
                      {r.mainStyle && <span className="text-[10px] text-slate-500 ml-1">（{r.mainStyle}）</span>}
                      {r.sireName && (
                        <span className="block text-[10px] text-slate-500">
                          父 {r.sireName}・母父 {r.bmsName ?? '-'}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap">{r.jockeyName ?? '-'}</td>
                    <td className="px-2 py-1 text-right">{r.popularity ?? '-'}</td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      {r.intervalDays === null ? '初出走' : r.intervalDays >= 91 ? `休み明け（${r.intervalDays}日）` : `${r.intervalDays}日`}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      {r.jockeyChanged === null ? '-' : r.jockeyChanged ? (
                        <span className="text-amber-300" title={`前走: ${r.prevJockeyName ?? '-'}`}>乗替</span>
                      ) : (
                        '継続'
                      )}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      {r.bodyWeight === null ? '未発表' : `${r.bodyWeight}${r.bodyWeightDiff === null ? '' : `（${r.bodyWeightDiff > 0 ? '+' : ''}${r.bodyWeightDiff}）`}`}
                    </td>
                    <td className="px-2 py-1 text-right font-black text-emerald-300">{r.total.toFixed(1)}</td>
                    {COMPONENT_KEYS.map((k) => {
                      const c = r.components[k];
                      return (
                        <td
                          key={k}
                          title={c.detail}
                          className={`px-2 py-1 text-right cursor-help ${c.hasData ? '' : 'text-slate-500 italic'}`}
                        >
                          {c.score}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-slate-500">
          各項目は0〜100点。灰色の斜体は、データ不足のため中立の50点にした項目です。数字にマウスを乗せると根拠が出ます。☆は印の無い6番人気以下で合計点が最も高い馬です。「状態」（間隔・馬体重・乗り替わり）は初期配分0%で、スライダーを上げると点数に反映されます。当日の馬体重は、発表後に出馬表を取り込み直すと入ります。
        </p>

        {/* 3連単予想（本命・中穴・大穴）と解説。配分や設定を変えると連動して変わる */}
        {ranked && <TrifectaSection ranked={ranked} race={meta?.race ?? null} history={meta?.historyCorner ?? null} />}

        {/* 答え合わせ用の記録 */}
        {ranked && (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <button
              onClick={recordPrediction}
              disabled={recording || smoothing.horseK !== appliedSmoothing.horseK || smoothing.jockeyK !== appliedSmoothing.jockeyK}
              className="flex items-center gap-1 px-2 py-1 rounded border border-emerald-700 text-emerald-300 hover:bg-emerald-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <BookmarkPlus className="w-3.5 h-3.5" />
              {recording ? '記録中…' : 'この予想を記録（答え合わせ用）'}
            </button>
            <span className="text-slate-500">今の配分・補正・データ不足の扱い・馬場で、印と3連単の買い目を記録します</span>
            {recordMsg && <span className={recordMsg.ok ? 'text-emerald-300' : 'text-red-300'}>{recordMsg.text}</span>}
          </div>
        )}
      </div>
    </section>
  );
};
