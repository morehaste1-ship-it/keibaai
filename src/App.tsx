import React, { useState, useEffect, useMemo } from 'react';
import { Race, Horse, WeatherCondition, TrackCondition } from './types/keiba';
import { analyzeRace } from './engine/keibaEngine';
import { Header } from './components/Header';
import { todayYmd } from './components/PastRacePicker';
import { RaceSummaryCard } from './components/RaceSummaryCard';
import { RaceCardTable } from './components/RaceCardTable';
import { CustomHorseModal } from './components/CustomHorseModal';
import { WeekendBatchButton } from './components/WeekendBatchButton';
import { HistoryPanel } from './components/HistoryPanel';
import { JockeyPanel } from './components/JockeyPanel';
import { MatchupPanel } from './components/MatchupPanel';
import { DataPredictionPanel } from './components/DataPredictionPanel';
import { ReviewPanel } from './components/ReviewPanel';
import { RealPedigreeView } from './components/RealPedigreeView';
import { RealUpsetView } from './components/RealUpsetView';
import { RealPaceView } from './components/RealPaceView';
import { RealTicketsView } from './components/RealTicketsView';
import { RealHeatmapView } from './components/RealHeatmapView';
import { RealAiView } from './components/RealAiView';
import type { RealDataView } from './utils/trifecta';
import type { PredictionMark, DataMarkInfo, RunningStyle } from './types/keiba';
import {
  Table2,
  Compass,
  Ticket,
  Dna,
  BrainCircuit,
  Trophy,
  AlertTriangle,
  Flame,
  CheckCircle,
  HelpCircle,
  ShieldAlert,
  Download,
  AlertCircle,
} from 'lucide-react';

type TabType = 'card' | 'heatmap' | 'upset' | 'pace' | 'tickets' | 'pedigree' | 'ai';

// DB の出馬表データ（raceCard）を画面用の Race 形式に変換する
function toRaceFromCard(raceCard: any): Race {
  return {
    id: raceCard.race.raceKey,
    name: raceCard.race.name,
    trackName: raceCard.race.venueName,
    round: raceCard.race.raceNo,
    grade: (raceCard.race.grade as any) || 'OP',
    distance: raceCard.race.distance,
    surface: raceCard.race.surface === 'ダート' ? 'ダート' : '芝',
    weather: (raceCard.race.weather || '晴') as WeatherCondition,
    condition: (raceCard.race.trackCondition || '良') as TrackCondition,
    postTime: raceCard.race.postTime || '',
    horses: raceCard.entries.map((e: any, i: number) => ({
      id: `${raceCard.race.raceKey}_${e.horseNumber ?? `x${i}`}`,
      name: e.horseName,
      number: e.horseNumber ?? 0,
      bracket: e.frameNumber || 0,
      jockey: e.jockey,
      trainer: e.trainer,
      weight: e.carriedWeight || 0,
      horseWeight: e.bodyWeight || 0,
      weightChange: e.bodyWeightDiff || 0,
      odds: e.odds?.winOdds || 0,
      popularity: e.odds?.popularity || 0,
      gender: (e.sex || '牡') as '牡' | '牝' | 'セン',
      age: e.age || 0,
      runningStyle: '差し' as any,
      pedigree: { sire: '', damSire: '', sireLine: '', aptitudeDist: '', heavyTrackAptitude: 'C', tokyoLongStraightAptitude: 'C', nakayamaSlopeAptitude: 'C' },
      pastRaces: [],
      speedRating: 70,
      staminaRating: 70,
      powerRating: 70,
      turnOfFootRating: 70,
      recentForm: 70,
    })),
  };
}

export default function App() {
  // レースはフェーズ3でデータベースから読み込む。それまでは未登録（0件）で起動する
  const [races, setRaces] = useState<Race[]>([]);
  const [selectedRaceId, setSelectedRaceId] = useState<string>('');
  const [currentWeather, setCurrentWeather] = useState<WeatherCondition>('晴');
  const [currentCondition, setCurrentCondition] = useState<TrackCondition>('良');
  const [activeTab, setActiveTab] = useState<TabType>('card');
  const [isAddHorseOpen, setIsAddHorseOpen] = useState<boolean>(false);
  const [hasGeminiKey, setHasGeminiKey] = useState<boolean>(false);
  // 表示中の過去の日付（null = 本日以降を表示）
  const [pastDate, setPastDate] = useState<string | null>(null);

  // スクレイピング関連の state
  const [raceInputValue, setRaceInputValue] = useState<string>('');
  const [isFetching, setIsFetching] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<string>('');

  // Check backend health and Gemini API key availability
  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        if (data.hasGeminiKey) setHasGeminiKey(true);
      })
      .catch((err) => console.log('Backend health check info:', err));
  }, []);

  const selectedRace: Race | null = useMemo(() => {
    return races.find((r) => r.id === selectedRaceId) || races[0] || null;
  }, [races, selectedRaceId]);

  // DB に保存済みのレース（出馬表・オッズ）を読み込む。TOP は本日以降、「過去のレース」で選んだ日はその日だけ
  useEffect(() => {
    const url = pastDate ? `/api/races/cards?date=${pastDate}` : `/api/races/cards?from=${todayYmd()}&limit=200`;
    let cancelled = false;
    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data.raceCards)) return;
        setRaces(data.raceCards.map(toRaceFromCard));
        setSelectedRaceId('');
      })
      .catch((err) => console.log('Saved race list load info:', err));
    return () => {
      cancelled = true;
    };
  }, [pastDate]);

  // When race changes, update weather and condition to that race's default
  const handleSelectRace = (id: string) => {
    const target = races.find((r) => r.id === id);
    if (target) {
      setSelectedRaceId(id);
      setCurrentWeather(target.weather);
      setCurrentCondition(target.condition);
    }
  };

  // データ予想（実データの点数）の印：馬番 → 印・順位・合計点
  const [dataMarks, setDataMarks] = useState<Record<number, DataMarkInfo> | null>(null);
  // データ予想の結果一式（各タブの実データ表示に使う）
  const [realData, setRealData] = useState<RealDataView | null>(null);

  // Run comprehensive evaluation whenever race or weather/condition changes
  const evaluatedData = useMemo(() => {
    // 印（◎○▲△☆）を付けるには出走馬が5頭以上必要。不足するレースは分析しない
    if (!selectedRace || selectedRace.horses.length < 5) return null;
    const data = analyzeRace(selectedRace, currentWeather, currentCondition);
    if (!dataMarks) return data;
    // 出馬表の印はデータ予想の印に置き換える（エンジンの仮データによる印は使わない）
    return {
      ...data,
      horses: data.horses.map((h) => {
        const m = dataMarks[h.number];
        if (!m) return { ...h, mark: '' as PredictionMark, markReason: undefined };
        // 血統・脚質・点数は実データに差し替える（エンジンの計算が終わった後なので、エンジンの結果は変わらない）
        const style = (['逃げ', '先行', '差し', '追込'] as string[]).includes(m.mainStyle ?? '') ? (m.mainStyle as RunningStyle) : h.runningStyle;
        return {
          ...h,
          mark: m.mark,
          markReason: `データ予想の合計${m.total.toFixed(1)}点（${m.rank}位）。内訳は上の「データ予想」パネルを参照`,
          dataTotal: m.total,
          dataRank: m.rank,
          dataStyle: m.mainStyle,
          runningStyle: style,
          pedigreeKnown: Boolean(m.sireName),
          dataAptitude: m.aptitudeMatrix ?? undefined,
          pedigree: { ...h.pedigree, sire: m.sireName ?? '', damSire: m.bmsName ?? '' },
        };
      }),
    };
  }, [selectedRace, currentWeather, currentCondition, dataMarks]);

  const handleAddHorse = (newHorse: Horse) => {
    setRaces((prevRaces) => {
      return prevRaces.map((r) => {
        if (r.id === selectedRaceId) {
          return {
            ...r,
            horses: [...r.horses, newHorse],
          };
        }
        return r;
      });
    });
  };

  // スクレイピングでレースを取得
  const handleFetchRace = async () => {
    if (!raceInputValue.trim()) {
      setFetchError('レース ID または URL を入力してください');
      return;
    }

    setIsFetching(true);
    setFetchError('');

    try {
      const response = await fetch('/api/race/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raceInput: raceInputValue.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'スクレイピングに失敗しました');
      }

      const { raceCard } = data;
      if (!raceCard) {
        throw new Error('レース情報が取得できませんでした');
      }

      // API レスポンスから Race 形式に変換
      const convertedRace: Race = toRaceFromCard(raceCard);

      setRaces((prev) => [convertedRace, ...prev]);
      setSelectedRaceId(convertedRace.id);
      setCurrentWeather(convertedRace.weather);
      setCurrentCondition(convertedRace.condition);
      setRaceInputValue('');
    } catch (err: any) {
      setFetchError(err.message || 'エラーが発生しました');
      console.error('Fetch error:', err);
    } finally {
      setIsFetching(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-white">
      {/* Race Scraping Form */}
      <div className="bg-slate-900/50 border-b border-slate-800 px-4 py-4">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5 text-emerald-400" />
              netkeiba からレースをスクレイピング
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={raceInputValue}
                onChange={(e) => setRaceInputValue(e.target.value)}
                placeholder="レース ID (12 digits) または netkeiba URL"
                onKeyPress={(e) => e.key === 'Enter' && handleFetchRace()}
                disabled={isFetching}
                className="flex-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
              />
              <button
                onClick={handleFetchRace}
                disabled={isFetching}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                <Download className="w-4 h-4" />
                {isFetching ? 'スクレイピング中...' : '取得'}
              </button>
            </div>
            {fetchError && (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                {fetchError}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Weekend Batch (manual fetch by date) */}
      <WeekendBatchButton />

      {/* Top Navigation & Live Condition Toggles */}
      <Header
        races={races}
        selectedRace={selectedRace}
        onSelectRace={handleSelectRace}
        weather={currentWeather}
        onWeatherChange={setCurrentWeather}
        condition={currentCondition}
        onConditionChange={setCurrentCondition}
        onOpenAddHorse={() => setIsAddHorseOpen(true)}
        hasGeminiKey={hasGeminiKey}
        pastDate={pastDate}
        onPickPastDate={setPastDate}
        onBackToUpcoming={() => setPastDate(null)}
      />

      {/* データ予想（実データの点数と印。配分はスライダーで変更） */}
      {selectedRace && (
        <DataPredictionPanel
          key={`d-${selectedRace.id}`}
          raceKey={selectedRace.id}
          condition={currentCondition}
          onMarks={setDataMarks}
          onData={setRealData}
        />
      )}

      {/* 過去10年の同一レース分析（レースを切り替えるとリセットされる） */}
      {selectedRace && (
        <HistoryPanel key={selectedRace.id} raceKey={selectedRace.id} condition={currentCondition} />
      )}

      {/* 騎手分析（過去5年） */}
      {selectedRace && <JockeyPanel key={`j-${selectedRace.id}`} raceKey={selectedRace.id} />}

      {/* 馬の脚質 × 騎手の相性 */}
      {selectedRace && <MatchupPanel key={`m-${selectedRace.id}`} raceKey={selectedRace.id} />}

      {/* 予想の答え合わせ（記録した予想と確定結果の照合。全レース共通） */}
      <ReviewPanel />

      {/* Main Content Area */}
      {!evaluatedData ? (
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-6">
        <div className="border border-dashed border-slate-700 rounded-xl p-10 text-center text-slate-400">
          <p className="text-base font-bold text-slate-200">レース未登録</p>
          <p className="text-sm mt-2">レースを取り込むと、出馬表と予想が表示されます。</p>
        </div>
      </main>
      ) : (
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-6 space-y-6">
        {/* Race Overview Card */}
        <RaceSummaryCard
          race={evaluatedData.race}
          course={evaluatedData.course}
          paceAnalysis={evaluatedData.paceAnalysis}
        />

        {/* Tab Navigation Navigation */}
        <div className="border-b border-slate-800 flex items-center gap-1 sm:gap-2 overflow-x-auto pb-px">
          {[
            { id: 'card' as TabType, label: '出馬表＆予想印', icon: Table2, badge: '印自動生成' },
            { id: 'heatmap' as TabType, label: 'データ予想ヒートマップ', icon: Flame, badge: '実データ' },
            { id: 'upset' as TabType, label: '人気馬死角＆中穴・大穴推奨', icon: ShieldAlert, badge: '実データ' },
            { id: 'pace' as TabType, label: '展開＆ハナ切り馬分析', icon: Compass, badge: '実データ' },
            { id: 'tickets' as TabType, label: 'AI推奨買い目＆資金配分', icon: Ticket, badge: '実データ' },
            { id: 'pedigree' as TabType, label: '血統＆適性マトリクス', icon: Dna, badge: '実データ' },
            { id: 'ai' as TabType, label: 'Gemini AI 専門家深掘り', icon: BrainCircuit, badge: '実データ' },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-3 sm:px-4 py-3 border-b-2 text-xs sm:text-sm font-bold transition whitespace-nowrap ${
                  isActive
                    ? 'border-emerald-400 text-white bg-slate-900/60'
                    : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? 'text-emerald-400' : 'text-slate-400'}`} />
                <span>{tab.label}</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold hidden sm:inline ${
                  isActive ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'
                }`}>
                  {tab.badge}
                </span>
              </button>
            );
          })}
        </div>

        <p className="text-[11px] text-amber-300/80">
          印と各タブの内容は、上の「データ予想」（実データ）の結果です。配分や設定を変えると連動して変わります。
        </p>

        {/* Tab Contents */}
        <div className="animate-in fade-in duration-200">
          {activeTab === 'card' && (
            <RaceCardTable
              horses={evaluatedData.horses}
              course={evaluatedData.course}
              onNavigateToHeatmap={() => setActiveTab('heatmap')}
            />
          )}

          {activeTab === 'heatmap' && <RealHeatmapView data={realData} />}

          {activeTab === 'upset' && <RealUpsetView data={realData} />}

          {activeTab === 'pace' && <RealPaceView data={realData} />}

          {activeTab === 'tickets' && <RealTicketsView data={realData} />}

          {activeTab === 'pedigree' && <RealPedigreeView data={realData} />}

          {activeTab === 'ai' && <RealAiView data={realData} />}
        </div>
      </main>
      )}

      {/* Footer */}
      <footer className="border-t border-slate-800 bg-slate-950 py-6 mt-12 text-slate-500 text-xs">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-300">KeibaAI Pro</span>
            <span>•</span>
            <span>JRA競馬分析＆AI予想プラットフォーム</span>
          </div>
          <div className="text-[11px] text-slate-500 text-center sm:text-right">
            ※馬券の購入は個人の責任において余裕をもってお楽しみください。20歳未満の勝馬投票券購入は法律で禁止されています。
          </div>
        </div>
      </footer>

      {/* Modal for adding custom horse */}
      {selectedRace && (
        <CustomHorseModal
          isOpen={isAddHorseOpen}
          onClose={() => setIsAddHorseOpen(false)}
          onAddHorse={handleAddHorse}
          currentHorseCount={selectedRace.horses.length}
        />
      )}
    </div>
  );
}
