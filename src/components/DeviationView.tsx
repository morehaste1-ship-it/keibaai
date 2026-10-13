import React from 'react';
import { COMPONENT_KEYS, COMPONENT_LABELS, type Weights } from '../utils/dataScore';
import { applyWeightsFromReview } from './DataPredictionPanel';

/** サーバーの Deviation と同じ形 */
export interface DeviationData {
  basis: 'recorded' | 'recomputed';
  pace: { forecast: string | null; actual: string | null; hit: boolean | null };
  top3: { horseNumber: number; horseName: string; finish: number; mark: string; mainStyle: string | null; corner4: number | null; group: string | null; last3fRank: number | null; favored: boolean | null }[];
  styleMisreads: { horseNumber: number; horseName: string; mark: string; predicted: string; predictedGroup: string; actualGroup: string; finish: number | null }[];
  markedLosers: { mark: string; horseNumber: number; horseName: string; finish: number | null; finishText: string; reasons: string[] }[];
  missed: { horseNumber: number; horseName: string; finish: number; popularity: number | null; weakPoints: string[] }[];
  componentGap: Record<string, number | null>;
}

export interface DeviationSummaryData {
  races: number;
  paceHit: number;
  paceTotal: number;
  favoredTop3: number;
  styledTop3: number;
  componentGap: Record<string, { avg: number | null; races: number }>;
  suggestion?: { weights: Record<string, number>; alpha: number; races: number } | null;
}

const DEFAULT_LABEL = '既定（近走30・適性25・騎手20・相性15・過去10年10・状態0・末脚0・着差0・スピード0）';

const gapText = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${v > 0 ? '+' : ''}${v}`);
const gapClass = (v: number | null | undefined) =>
  v === null || v === undefined ? 'text-slate-500' : v >= 10 ? 'text-emerald-300 font-bold' : v <= -5 ? 'text-rose-300' : 'text-slate-300';

/** 1レース分の「予想と結果のずれ」 */
export const DeviationDetail: React.FC<{ d: DeviationData }> = ({ d }) => (
  <div className="space-y-2 text-[11px] text-slate-300 bg-slate-950/60 border border-slate-800 rounded-lg p-3">
    {d.basis === 'recomputed' && (
      <p className="text-amber-300/80">※この記録は分析用の情報を保存する前のため、脚質・点数・展開予想は今の点数で補って分析しています（印・買い目は記録どおり）。</p>
    )}
    <p>
      <b className="text-white">展開</b>：予想 {d.pace.forecast ?? '-'} → 実際 {d.pace.actual ?? '不明'}
      {d.pace.hit === true && <span className="ml-1 text-emerald-300">（的中）</span>}
      {d.pace.hit === false && <span className="ml-1 text-rose-300">（外れ）</span>}
    </p>
    <div>
      <b className="text-white">3着以内の馬</b>
      <ul className="mt-0.5 space-y-0.5">
        {d.top3.map((t) => (
          <li key={t.horseNumber}>
            {t.finish}着 {t.mark || '無印'} {t.horseNumber}番{t.horseName}：予想の脚質 {t.mainStyle ?? '不明'}
            {t.favored === true && <span className="text-emerald-300">（展開予想で有利）</span>}
            {t.favored === false && <span className="text-rose-300">（展開予想では不利）</span>}
            ／4角{t.corner4 ?? '-'}番手（{t.group ?? '-'}）・上がり{t.last3fRank ?? '-'}位
          </li>
        ))}
      </ul>
    </div>
    {d.markedLosers.length > 0 && (
      <div>
        <b className="text-white">◎◯▲が3着以内に入らなかった理由（候補）</b>
        <ul className="mt-0.5 space-y-0.5">
          {d.markedLosers.map((m) => (
            <li key={m.horseNumber}>
              {m.mark}
              {m.horseNumber}番{m.horseName}（{m.finish ?? m.finishText}
              {m.finish !== null ? '着' : ''}）：{m.reasons.join('／')}
            </li>
          ))}
        </ul>
      </div>
    )}
    {d.missed.length > 0 && (
      <div>
        <b className="text-white">見落とし（無印で3着以内）</b>
        <ul className="mt-0.5 space-y-0.5">
          {d.missed.map((m) => (
            <li key={m.horseNumber}>
              {m.finish}着 {m.horseNumber}番{m.horseName}（{m.popularity ?? '-'}番人気）：低かった項目 {m.weakPoints.length > 0 ? m.weakPoints.join('・') : 'なし'}
            </li>
          ))}
        </ul>
      </div>
    )}
    {d.styleMisreads.length > 0 && (
      <p>
        <b className="text-white">脚質の読み違い</b>（予想の脚質と実際の4角の位置が違った馬）：
        {d.styleMisreads.map((s) => `${s.mark}${s.horseNumber}番（予想${s.predicted}→実際${s.actualGroup}${s.finish !== null ? `・${s.finish}着` : ''}）`).join('、')}
      </p>
    )}
    <div>
      <b className="text-white">項目ごとの当たり具合</b>（3着以内の馬の平均点 − それ以外の馬の平均点。大きいほど着順をよく当てた項目）
      <div className="mt-1 flex flex-wrap gap-2">
        {COMPONENT_KEYS.map((k) => (
          <span key={k} className="px-1.5 py-0.5 rounded border border-slate-800">
            {COMPONENT_LABELS[k]} <span className={gapClass(d.componentGap[k])}>{gapText(d.componentGap[k])}</span>
          </span>
        ))}
      </div>
    </div>
  </div>
);

/** 配分の修正案と「この配分を適用」ボタン */
const SuggestionView: React.FC<{ sg: NonNullable<DeviationSummaryData['suggestion']> }> = ({ sg }) => {
  const [msg, setMsg] = React.useState('');
  const apply = () => {
    const text = COMPONENT_KEYS.map((k) => `${COMPONENT_LABELS[k]}${sg.weights[k]}%`).join('・');
    if (!window.confirm(`データ予想の配分を次の値に変更します。\n${text}\n（データ予想パネルの「既定に戻す」で元に戻せます）`)) return;
    applyWeightsFromReview(sg.weights as Weights);
    setMsg('データ予想の配分に反映しました');
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-slate-500" title={`既定の配分 ${DEFAULT_LABEL} に、当たり具合から計算した配分を${Math.round(sg.alpha * 100)}%混ぜた値（10レースで最大50%）`}>
        配分の修正案{sg.races < 10 ? '（参考）' : ''}：
      </span>
      {COMPONENT_KEYS.map((k) => (
        <span key={k}>
          {COMPONENT_LABELS[k]}
          <b className="text-white">{sg.weights[k]}%</b>
        </span>
      ))}
      <button onClick={apply} className="px-2 py-0.5 rounded border border-emerald-700 text-emerald-300 hover:bg-emerald-900/30">
        この配分を適用
      </button>
      {msg && <span className="text-emerald-300">{msg}</span>}
    </div>
  );
};

/** ずれの集計（自動・手動それぞれの集計表の下に出す） */
export const DeviationSummaryView: React.FC<{ s: DeviationSummaryData }> = ({ s }) => (
  <div className="mt-2 text-[11px] text-slate-300 space-y-1">
    <p className="text-slate-500">予想と結果のずれ（分析できた {s.races}レース）{s.races > 0 && s.races < 10 && <span className="text-amber-300/80">　※10レース未満のため参考値</span>}</p>
    <p>
      展開予想の的中 {s.paceTotal > 0 ? `${s.paceHit}/${s.paceTotal}` : '-'}　／　3着以内の馬が展開予想で有利な脚質だった割合{' '}
      {s.styledTop3 > 0 ? `${s.favoredTop3}/${s.styledTop3}頭` : '-'}
    </p>
    <div className="flex flex-wrap gap-2">
      {COMPONENT_KEYS.map((k) => (
        <span key={k} className="px-1.5 py-0.5 rounded border border-slate-800" title={`${s.componentGap[k]?.races ?? 0}レースの平均`}>
          {COMPONENT_LABELS[k]} <span className={gapClass(s.componentGap[k]?.avg)}>{gapText(s.componentGap[k]?.avg)}</span>
        </span>
      ))}
    </div>
    {s.suggestion && <SuggestionView sg={s.suggestion} />}
  </div>
);
