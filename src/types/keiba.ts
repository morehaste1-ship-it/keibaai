export type TrackCondition = '良' | '稍重' | '重' | '不良';
export type WeatherCondition = '晴' | '曇' | '小雨' | '雨';
export type SurfaceType = '芝' | 'ダート';
export type RunningStyle = '逃げ' | '先行' | '差し' | '追込';
export type PaceType = '超スロー' | 'スロー' | '平均' | 'ハイ' | '超ハイ';
export type PredictionMark = '◎' | '◯' | '▲' | '△' | '☆' | '消' | '';

export interface HorsePastRace {
  date: string;
  raceName: string;
  grade: string;
  track: string;
  surface: SurfaceType;
  distance: number;
  condition: TrackCondition;
  rank: number;
  totalHorses: number;
  odds: number;
  popularity: number;
  jockey: string;
  weight: number;
  time: string;
  last3F: number; // 上がり3ハロン (秒)
  passingRank: string; // 例: "1-1", "4-3", "12-10"
  margin: string; // 着差 例: "アタマ", "1 1/4", "クビ", "0.2"
}

export interface PedigreeInfo {
  sire: string; // 父
  damSire: string; // 母父
  sireLine: string; // 系統 (サンデー系, キングマンボ系, ノーザンダンサー系, etc.)
  aptitudeDist: string; // 得意距離 例: "1200m〜1600m"
  heavyTrackAptitude: 'S' | 'A' | 'B' | 'C'; // 重馬場適性
  tokyoLongStraightAptitude: 'S' | 'A' | 'B' | 'C'; // 東京の直線適性
  nakayamaSlopeAptitude: 'S' | 'A' | 'B' | 'C'; // 中山急坂適性
}

export interface Horse {
  id: string;
  number: number; // 馬番
  bracket: number; // 枠番 (1〜8)
  name: string;
  gender: '牡' | '牝' | 'セン';
  age: number;
  jockey: string;
  trainer: string;
  weight: number; // 斤量
  horseWeight: number; // 馬体重
  weightChange: number; // 前走比
  odds: number; // 単勝オッズ
  popularity: number; // 人気
  runningStyle: RunningStyle;
  pedigree: PedigreeInfo;
  pastRaces: HorsePastRace[];

  // 評価指標 (Base metrics)
  speedRating: number; // スピード指数 (60-100)
  staminaRating: number; // スタミナ指数
  powerRating: number; // パワー指数 (急坂・重馬場)
  turnOfFootRating: number; // 瞬発力・上がり指数
  recentForm: number; // 調子・近走勢い (0-100)
  trainerRating?: number; // 調教師成績・リーディング指数 (0-100)
  conditionStatus?: '絶好調' | '好調' | '普通' | '不安' | '下降気味'; // 馬の当日の気配・コンディション
  conditionNote?: string; // 馬体・追い切り等の特記事項

  // 算出フィールド (Computed by Engine)
  aiScore?: number; // 総合AI指数 (0-100)
  adjustedScore?: number; // コース・馬場補正後指数
  winProb?: number; // 勝率 (%)
  quinellaProb?: number; // 連対率 (1〜2着率 %)
  placeProb?: number; // 複勝圏内率 (1〜3着率 %)
  courseQuinellaRate?: number; // 当該コース適性 連対率 (%)
  distanceQuinellaRate?: number; // 距離適性 連対率 (%)
  conditionQuinellaRate?: number; // 馬場状態適性 連対率 (%)
  styleAdvantageRate?: number; // 脚質×展開 有利度 (%)
  trainerJockeyRate?: number; // 厩舎・騎手 連対率 (%)
  overallStrengthScore?: number; // 総合戦力スコア (0-100)
  expectedValue?: number; // 期待値 (EV)
  mark?: PredictionMark;
  markReason?: string;
  /** データ予想（実データ）の合計点・順位・脚質。データ予想の読み込み後に入る */
  dataTotal?: number;
  dataRank?: number;
  dataStyle?: string | null;
  /** 血統が実データ（netkeiba の血統ページ）由来か。false なら未取得 */
  pedigreeKnown?: boolean;
  /** 状況別の適性（実データ）。データ予想の読み込み後に入る */
  dataAptitude?: AptitudeMatrixView;
  isDarkHorse?: boolean; // 中穴・大穴注目フラグ
  darkHorseCategory?: '中穴' | '大穴' | '穴無し'; // 中穴 or 大穴
  
  // 上位人気馬の死角・3着圏外リスク分析
  topFavRisk?: {
    riskLevel: '高危険' | '中警戒' | '低(堅実)';
    reasons: string[]; // なぜ飛ぶ（3着以内に入らない）と言えるのかの根拠
    collapseScenario: string; // 凡走シナリオ
  };
}

export interface CourseCharacteristics {
  trackId: string;
  trackName: string; // 東京, 中山, 京都, 阪神, etc.
  surface: SurfaceType;
  distance: number;
  courseType?: '内' | '外' | '直線' | '本線';
  turnType: '右回り' | '左回り' | '直線';
  straightLength: number; // 直線距離 (m)
  slopeHeight: number; // 高低差 (m)
  slopeDetail: string; // 坂の解説
  description: string;
  
  // 補正係数 (Correction Multipliers)
  frameBias: {
    inside: number; // 1-2枠 (内枠補正)
    middle: number; // 3-6枠
    outside: number; // 7-8枠 (外枠補正)
  };
  styleBias: {
    nige: number; // 逃げ補正
    senko: number; // 先行補正
    sashi: number; // 差し補正
    oikomi: number; // 追込補正
  };
  heavyTrackStyleShift: {
    frontBonus: number; // 重馬場で先行・逃げに加算される有利度
  };
  
  // 過去データ展開実績 (特にハナ切り逃げ馬など)
  historicalPaceData: {
    frontRunnerWinRate: number; // 逃げ馬勝率
    frontRunnerPlaceRate: number; // 逃げ馬複勝率
    frontRunner3rdCount: number; // 過去10年等で3着内に粘った回数
    frontRunnerTotal: number;
    bestPassingRankTrend: string;
    keyInsight: string;
  };
}

export interface Race {
  id: string;
  name: string;
  grade: 'G1' | 'G2' | 'G3' | 'OP' | '特別' | '平場';
  trackName: string;
  surface: SurfaceType;
  distance: number;
  courseType?: '内' | '外' | '直線' | '本線';
  round: number; // 例: 11R
  weather: WeatherCondition;
  condition: TrackCondition;
  postTime: string;
  horses: Horse[];
}

export interface PacePrediction {
  predictedPace: PaceType;
  frontRunners: string[]; // ハナを争う馬たち
  paceIndex: number; // 1〜5 (スロー〜ハイ)
  historicalLeaderNote: string; // 過去の逃げ馬データ知見
  biasNote: string;
  deploymentSummary: string;
}

export interface BettingTicket {
  type: '単勝' | '複勝' | '馬連' | 'ワイド' | '3連複' | '3連単';
  selection: number[]; // 馬番の組み合わせ
  selectionNames: string[];
  estimatedOdds: number;
  expectedValue: number;
  allocatedAmount: number; // 資金配分 (円)
  targetReturn: number; // 的中時想定払戻金
  category: '堅実' | 'バランス' | '中穴狙い' | '大穴一発逆転';
  rationale: string;
}

export interface TicketStrategyPlan {
  name: string;
  description: string;
  badge: string;
  recommendedBudgetPct: number;
  tickets: BettingTicket[];
  totalStake: number;
  maxReturn: number;
  coverageDesc: string;
}

export interface FavoriteUpsetAnalysis {
  targetFavorite: Horse; // 3着圏外が危惧される上位人気馬
  riskScore: number; // 危険度スコア 0-100
  riskReasons: string[]; // なぜ3着以内に入らないと言えるのかの根拠
  substitutePicks: Horse[]; // 代わりに浮上する中穴・大穴推奨馬
  upsetScenario: string; // 崩壊＆波乱決着シナリオ
}


/** 状況別の適性（サーバーの aptitude-matrix と同じ形）。自身の成績と血統の傾向を別々に持つ */
export interface AptitudeEntryView {
  rank: 'S' | 'A' | 'B' | 'C' | null;
  detail: string;
}
export interface AptitudeMatrixView {
  heavy: { own: AptitudeEntryView; pedigree: AptitudeEntryView };
  bestDistance: { own: { label: string | null; detail: string }; pedigree: { label: string | null; detail: string } };
  venues: (AptitudeEntryView & { venue: string; top3: number; n: number })[];
  features: (AptitudeEntryView & { key: string; label: string; venues: string[] })[];
  currentVenue: string;
}

/** データ予想パネルから出馬表へ渡す、馬番ごとの実データ */
export interface DataMarkInfo {
  mark: PredictionMark;
  rank: number;
  total: number;
  sireName: string | null;
  bmsName: string | null;
  mainStyle: string | null;
  aptitudeMatrix: AptitudeMatrixView | null;
}
