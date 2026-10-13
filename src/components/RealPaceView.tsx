import React, { useMemo } from 'react';
import { Compass } from 'lucide-react';
import type { RankedItem } from '../utils/dataScore';
import { forecastPace, type RealDataView } from '../utils/trifecta';

const STYLES = ['逃げ', '先行', '差し', '追込'] as const;
const STYLE_CLASS: Record<string, string> = {
  逃げ: 'border-rose-500/50 text-rose-300',
  先行: 'border-amber-500/50 text-amber-300',
  差し: 'border-emerald-500/50 text-emerald-300',
  追込: 'border-sky-500/50 text-sky-300',
  不明: 'border-slate-700 text-slate-400',
};

/** 最初のコーナーの平均位置の表示（例: 前から18%） */
const posText = (h: RankedItem) =>
  h.firstCornerAvg ? `前から${Math.round(h.firstCornerAvg.ratio * 100)}%（${h.firstCornerAvg.n}走平均）` : '位置データなし';

/** 展開＆ハナ切り馬分析（実データ） */
export const RealPaceView: React.FC<{ data: RealDataView | null }> = ({ data }) => {
  const pace = useMemo(() => (data ? forecastPace(data.ranked, data.historyCorner) : null), [data]);
  if (!data || !pace) return <p className="text-xs text-slate-400 p-4">データ予想の読み込み後に表示されます。</p>;

  // 脚質ごとに、最初のコーナーの平均位置が前の順に並べる
  const groups = [...STYLES, '不明'].map((s) => ({
    style: s,
    horses: data.ranked
      .filter((h) => (s === '不明' ? !h.mainStyle : h.mainStyle === s))
      .sort((a, b) => (a.firstCornerAvg?.ratio ?? 9) - (b.firstCornerAvg?.ratio ?? 9)),
  }));
  // ハナ候補：主な脚質が逃げの馬、いなければ平均位置が最も前の馬
  const leaders = groups[0].horses.length > 0 ? groups[0].horses : [...data.ranked].filter((h) => h.firstCornerAvg).sort((a, b) => a.firstCornerAvg!.ratio - b.firstCornerAvg!.ratio).slice(0, 1);
  const hc = data.historyCorner;

  return (
    <div className="space-y-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2">
        <h3 className="text-base font-black text-white flex items-center gap-2">
          <Compass className="w-4 h-4 text-emerald-400" />
          展開予想（実データ）：<span className="text-amber-300">{pace.pace}</span>
        </h3>
        <p className="text-xs text-slate-300">{pace.text}</p>
        <p className="text-xs text-slate-300">
          ハナ候補：
          {leaders.length === 0
            ? 'データなし'
            : leaders.map((h) => `${h.horseNumber}番${h.horseName}（${posText(h)}）`).join('、')}
          {groups[0].horses.length === 0 && leaders.length > 0 && '　※主な脚質が逃げの馬がいないため、平均位置が最も前の馬'}
        </p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
        <h4 className="text-sm font-black text-white">脚質別の出走馬（最初のコーナーの平均位置が前の順）</h4>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
          {groups.map((g) => (
            <div key={g.style} className={`rounded-xl border p-2 ${STYLE_CLASS[g.style]}`}>
              <p className="text-xs font-black">
                {g.style}（{g.horses.length}頭）
              </p>
              <ul className="mt-1 space-y-1 text-[11px] text-slate-300">
                {g.horses.map((h) => (
                  <li key={h.horseNumber}>
                    <span className="font-bold text-slate-100">
                      {h.mark && <span className="mr-0.5">{h.mark}</span>}
                      {h.horseNumber} {h.horseName}
                    </span>
                    <span className="block text-[10px] text-slate-500">{posText(h)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-slate-500">
          主な脚質＝直近10走で最も多い脚質（最初のコーナーの位置で判定：1番手=逃げ、頭数の1/3以内=先行、2/3以内=差し、それより後ろ=追込）。平均位置＝最初のコーナーの順位÷頭数の平均。
        </p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2">
        <h4 className="text-sm font-black text-white">過去10年のこのレース：3着以内の馬の4コーナーの位置</h4>
        {!hc || hc.total === 0 ? (
          <p className="text-xs text-slate-400">過去10年のデータがありません（「過去10年を取得」で集めたレースのみ）。</p>
        ) : (
          <div className="space-y-1">
            {(['前', '中', '後'] as const).map((k) => (
              <div key={k} className="flex items-center gap-2 text-[11px] text-slate-300">
                <span className="w-24">{k === '前' ? '前（〜1/3）' : k === '中' ? '中（〜2/3）' : '後（それ以降）'}</span>
                <div className="flex-1 h-3 bg-slate-800 rounded overflow-hidden">
                  <div className="h-full bg-emerald-500/70" style={{ width: `${(hc[k] / hc.total) * 100}%` }} />
                </div>
                <span className="w-28 text-right whitespace-nowrap">
                  {hc[k]}頭（{Math.round((hc[k] / hc.total) * 100)}%）
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
