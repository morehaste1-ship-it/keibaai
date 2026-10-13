/**
 * データ予想：配分（重み）を掛けた合計点と印の付け方
 */
import type { AptitudeMatrixView, PredictionMark } from '../types/keiba';

export type ComponentKey = 'recent' | 'aptitude' | 'jockey' | 'matchup' | 'history' | 'state' | 'closing' | 'margin' | 'speed' | 'frame' | 'change' | 'layoff';

export const COMPONENT_LABELS: Record<ComponentKey, string> = {
  recent: '近走',
  aptitude: '適性',
  jockey: '騎手',
  matchup: '相性',
  history: '過去10年',
  state: '状態',
  closing: '末脚',
  margin: '着差',
  speed: 'スピード',
  frame: '枠',
  change: '条件替わり',
  layoff: '休み明け',
};

export const COMPONENT_KEYS: ComponentKey[] = ['recent', 'aptitude', 'jockey', 'matchup', 'history', 'state', 'closing', 'margin', 'speed', 'frame', 'change', 'layoff'];
/** データ不足の判定に数えない項目（あとから追加し、データがそろうまで時間がかかる項目。既存の判定を変えないため） */
const NOT_COUNTED_FOR_SHORTAGE: ComponentKey[] = ['closing', 'margin', 'speed', 'frame', 'change', 'layoff'];

export interface ScoreComponent {
  score: number;
  hasData: boolean;
  detail: string;
}

export interface ScoreItem {
  horseNumber: number | null;
  frameNumber: number | null;
  horseName: string;
  jockeyName: string | null;
  popularity: number | null;
  winOdds: number | null;
  mainStyle: string | null;
  firstCornerAvg?: { ratio: number; n: number } | null;
  sireName: string | null;
  bmsName: string | null;
  intervalDays: number | null;
  jockeyChanged: boolean | null;
  prevJockeyName: string | null;
  bodyWeight: number | null;
  bodyWeightDiff: number | null;
  recentRuns?: { date: string; venueName: string | null; raceName: string | null; surface: string | null; distance: number | null; finishText: string | null; popularity: number | null }[];
  combo?: { rides: number; top3: number; wins: number } | null;
  aptitudeMatrix?: AptitudeMatrixView;
  components: Record<ComponentKey, ScoreComponent>;
}

export type Weights = Record<ComponentKey, number>;

export interface RankedItem extends ScoreItem {
  total: number;
  rank: number;
  mark: PredictionMark;
  /** データ不足（中立の項目が3つ以上）か */
  shortage: boolean;
}

/** データ不足の馬の扱い */
export type ShortageMode = 'keep' | 'exclude' | 'lower';

export const SHORTAGE_LABELS: Record<ShortageMode, string> = {
  keep: 'そのまま（中立50点で計算）',
  exclude: '印の対象外にする',
  lower: '中立を低めに見る（40点で計算）',
};

/** 中立（データ不足）とみなす項目がこの数以上の馬を「データ不足」とする */
export const SHORTAGE_THRESHOLD = 3;
const LOWER_NEUTRAL = 40;

/** データ不足（中立）の項目の数。末脚・着差・スピードは追加したばかりでデータがそろうまで時間がかかるため数えない（既存の判定を変えないため） */
export function neutralCount(item: ScoreItem): number {
  return COMPONENT_KEYS.filter((k) => !NOT_COUNTED_FOR_SHORTAGE.includes(k) && item.components[k] && !item.components[k].hasData).length;
}

/** 配分を掛けた合計点（0〜100）。配分の合計が0なら0点。lower のときは中立の項目を40点として計算 */
export function totalScore(item: ScoreItem, weights: Weights, mode: ShortageMode = 'keep'): number {
  const wSum = COMPONENT_KEYS.reduce((s, k) => s + Math.max(0, weights[k] || 0), 0);
  if (wSum === 0) return 0;
  const sum = COMPONENT_KEYS.reduce((s, k) => {
    // 項目が無いデータ（末脚を追加する前の古いデータなど）は中立として扱う
    const c = item.components[k] ?? { score: 50, hasData: false, detail: '' };
    const score = mode === 'lower' && !c.hasData ? LOWER_NEUTRAL : c.score;
    return s + score * Math.max(0, weights[k] || 0);
  }, 0);
  return Math.round((sum / wSum) * 10) / 10;
}

/**
 * 合計点の順位で印を付ける：1位◎ 2位◯ 3位▲ 4〜5位△。
 * ☆は印の無い馬のうち6番人気以下で合計点が最も高い馬。同点は馬番の小さい順
 */
export function rankAndMark(items: ScoreItem[], weights: Weights, mode: ShortageMode = 'keep'): RankedItem[] {
  const ranked = items
    .map((it) => ({
      ...it,
      total: totalScore(it, weights, mode),
      rank: 0,
      mark: '' as PredictionMark,
      shortage: neutralCount(it) >= SHORTAGE_THRESHOLD,
    }))
    .sort((a, b) => b.total - a.total || (a.horseNumber ?? 99) - (b.horseNumber ?? 99));
  ranked.forEach((r, i) => (r.rank = i + 1));
  // exclude のときは、データ不足の馬を飛ばして印を付ける
  const markable = ranked.filter((r) => !(mode === 'exclude' && r.shortage));
  const marks: PredictionMark[] = ['◎', '◯', '▲', '△', '△'];
  markable.forEach((r, i) => (r.mark = marks[i] ?? ''));
  const hole = markable.find((r) => r.mark === '' && r.popularity !== null && r.popularity >= 6);
  if (hole) hole.mark = '☆';
  return ranked;
}

/** 補正の強さ */
export interface Smoothing {
  horseK: number;
  jockeyK: number;
}
export const DEFAULT_SMOOTHING: Smoothing = { horseK: 3, jockeyK: 10 };

/** 「1戦1勝の馬」が補正後に何%として扱われるか（基準30%の例） */
export function smoothingExample(horseK: number): number {
  return Math.round(((1 + 0.3 * horseK) / (1 + horseK)) * 100);
}

/** 比率を保ったまま、合計がちょうど100になるよう整数に整える（端数は大きい順に1ずつ配る） */
export function normalizeTo100(weights: Weights): Weights {
  const sum = COMPONENT_KEYS.reduce((s, k) => s + Math.max(0, weights[k] || 0), 0);
  if (sum === 0) return { ...weights };
  const raw = COMPONENT_KEYS.map((k) => ({ k, v: (Math.max(0, weights[k] || 0) / sum) * 100 }));
  const next = { ...weights };
  for (const r of raw) next[r.k] = Math.floor(r.v);
  let rest = 100 - COMPONENT_KEYS.reduce((s, k) => s + next[k], 0);
  for (const r of [...raw].sort((a, b) => (b.v % 1) - (a.v % 1))) {
    if (rest <= 0) break;
    next[r.k] += 1;
    rest--;
  }
  return next;
}

/** 各項目の説明（比率バー・スライダーにマウスを乗せたときに表示する） */
export interface ComponentDescription {
  summary: string;
  source: string;
  lines: string[];
}

export const COMPONENT_DESCRIPTIONS: Record<ComponentKey, ComponentDescription> = {
  recent: {
    summary: '最近の調子。直近5走（JRA）の着順を点数にします。',
    source: 'netkeiba の馬の競走成績ページ（馬の過去走）',
    lines: [
      '着順の点数：1着100・2着80・3着65・4〜5着45・6〜9着25・10着以下10・中止など0',
      '新しいレースほど重く数えます（重み 5・4・3・2・1）',
      'JRAの出走歴が無い馬は中立の50点',
    ],
  },
  aptitude: {
    summary: '今回の条件が合うか。過去走で今回と同じ条件のときの3着以内率です。',
    source: 'netkeiba の馬の過去走。出走3走未満の馬は、父・母の父の産駒成績（netkeiba の種牡馬ページ）も使用',
    lines: [
      '条件は3つ：①芝ダート×距離帯（〜1400・〜1800・〜2200・2201〜）②会場 ③馬場（画面で選んだ馬場）。この3つの平均',
      '出走数が少ない条件は、基準の率の「仮のレース」を何戦分か足して率を補正（1戦1勝で100%になるのを防ぐ。初期値3戦）',
      '基準の率＝血統からの推定（父の産駒を2、母の父の産駒を1の重みで平均）。血統が無ければ全体平均の30%',
      '出走歴が無く血統がある馬は、血統の率をそのまま使用',
      '点数：複勝率60%で100点、30%で50点',
    ],
  },
  jockey: {
    summary: '騎手の腕と得意条件。今回の騎手の、今回と同じ条件での3着以内率です。',
    source: 'netkeiba の騎手成績ページ（過去5年・JRAのみ）',
    lines: [
      '条件：今回と同じ会場・芝ダート・距離帯',
      '騎乗数が少ないときは、その騎手の全体の複勝率で「仮のレース」を何戦分か足して補正（初期値10戦）',
      '騎手成績が未取得なら中立の50点',
      '点数：複勝率60%で100点、30%で50点',
    ],
  },
  matchup: {
    summary: 'この馬とこの騎手・枠の組み合わせが合うか。',
    source: 'netkeiba の騎手成績（過去5年）と、馬の過去走から判定した脚質',
    lines: [
      '①騎手が「この馬の主な脚質」と同じ脚質の馬に乗ったときの複勝率',
      '②騎手が今回と同じ枠帯（内1〜3・中4〜6・外7〜8枠）のときの複勝率',
      '①と②の平均。どちらも騎手の全体の複勝率で「仮のレース」を何戦分か足して補正（初期値10戦）',
      '馬の主な脚質＝直近10走で最も多い脚質（最初のコーナーの位置で判定：1番手=逃げ、頭数の1/3以内=先行、2/3以内=差し、それより後ろ=追込）',
    ],
  },
  history: {
    summary: 'このレースで好走しやすい位置取りか。過去10年の傾向です。',
    source: '過去10年の同一レース（競走名・会場・芝ダ・距離が一致）の結果。「過去10年を取得」で集めた分のみ',
    lines: [
      '3着以内に入った馬の4コーナーの位置を「前（頭数の1/3以内）・中（2/3以内）・後（それより後ろ）」に分けて数える',
      'この馬の主な脚質を位置に当てはめる（逃げ・先行=前、差し=中、追込=後）',
      '最も多い位置を100点とし、その位置の割合に応じて点数化',
      '過去のレースが5レース未満のときは、点数を中立の50点に寄せる（1レースなら差を5分の1に縮める）',
      '過去データが無い、または馬の脚質が不明なら中立の50点',
    ],
  },
  state: {
    summary: '今回の臨戦過程。前走からの間隔・当日の馬体重・乗り替わりで加減します。',
    source: 'netkeiba の馬の過去走（前走の日付・騎手）と、出馬表（当日の馬体重）、騎手成績',
    lines: [
      '50点を基準に加減',
      '前走からの間隔：14日以内 −10／15〜62日 +10／63〜90日 ±0／91日以上（休み明け） −10',
      '当日の馬体重：増減が±10kg以上なら −10（発表後に出馬表を取り込み直すと反映）',
      '乗り替わり：今回と前走の騎手の過去5年の複勝率の差（例：10%上なら+10）を最大±15点まで加減。前走騎手の成績が未取得なら±0',
      '初期配分は0%（スライダーを上げると合計点に効きます）',
    ],
  },
  closing: {
    summary: '最後の伸び（末脚）。直近10走で上がり3F（最後の600m）がレース内で3位以内だった割合です。',
    source: 'netkeiba の馬の競走成績ページ（上がり3位以内の印）',
    lines: [
      '直近10走のうち、上がり順位が分かる走だけで数える（夜間の過去走の取り込みで順に増えます）',
      '出走数が少ない馬は、平均の20%で「仮のレース」を何戦分か足して補正（馬の補正の強さと同じ。初期値3戦）',
      '点数：上がり3位以内の割合20%で50点、40%以上で100点',
      '上がり順位のデータが無い馬は中立の50点',
      '初期配分は0%（答え合わせの「項目ごとの当たり具合」を見て、上げるかを判断できます）',
    ],
  },
  margin: {
    summary: '負けた内容。直近5走で、勝ち馬から何秒離されたかです（着順だけでは分からない「惜しい負け」を拾います）。',
    source: 'netkeiba の馬の競走成績ページ（着差）',
    lines: [
      '1走ごとの点数：勝ち＝100点、0.5秒差＝80点、1.0秒差＝60点、2.5秒差以上＝0点（1秒につき40点下げる）',
      '新しい走ほど重く数える（近走と同じ 5:4:3:2:1）',
      '着差のデータが無い馬は中立の50点（夜間の過去走の取り込み直しで順に増えます）',
      '初期配分は0%（過去レースの検証と毎週の自動見直しで効果を確かめます）',
    ],
  },
  speed: {
    summary: '走破タイムの速さ。コース・距離・馬場ごとの基準タイムより、1000mあたり何秒速く走ったかを点数にしたものです。',
    source: 'netkeiba の馬の競走成績ページ（走破タイム）と、DBにたまった全馬の過去走から自前で計算した基準タイム（有料のタイム指数は使いません）',
    lines: [
      '基準タイム：同じ競馬場・芝ダート・距離・馬場で3着以内に入った馬の走破タイムの中央値（レース日より前の走だけ）',
      '走数が10走未満の条件は、馬場を問わない → 競馬場を問わない の順に広げて計算',
      '直近5走のうち良いほうの2走の平均。1000mあたり基準と同じで50点、1秒速いと+25点（1走だけの馬は差を半分に）',
      '走破タイムか基準タイムが無い馬は中立の50点',
      '初期配分は0%（過去レースの検証と毎週の自動見直しで効果を確かめます）',
    ],
  },
  frame: {
    summary: '枠の有利不利。今回のコースで、内枠・中枠・外枠のどこが3着以内に来やすいかです。',
    source: 'DBにたまった全馬の過去走（同じ競馬場・芝ダート・距離、過去5年、レース日より前の走だけ）',
    lines: [
      '枠を 内(1-3)・中(4-6)・外(7-8) に分け、今回の枠グループの3着以内率をコース全体の率と比べる',
      '全体と同じで50点。全体より1割高いと+20点（例：全体30%で33%なら70点）',
      '走数が少ない枠グループは、全体の率で「仮の50走」を足して補正',
      'コースの過去走が100走未満、または枠番が未発表なら中立の50点',
      '初期配分は0%（過去レースの検証と毎週の自動見直しで効果を確かめます）',
    ],
  },
  change: {
    summary: '条件替わり。前走から芝ダートや距離が変わるとき、その馬が過去に同じ変化をしたときの成績です。',
    source: 'netkeiba の馬の過去走（芝ダート・距離・着順）',
    lines: [
      '変化の種類：芝→ダート／ダート→芝／距離延長（200m以上）／距離短縮（200m以上）',
      'その馬の過去の同じ変化での3着以内率を、その馬のふだんの3着以内率と比べる（同じで50点、10ポイント高いと+20点）',
      '回数が少ない馬は、ふだんの率で「仮のレース」を足して補正（馬の補正の強さと同じ）',
      '前走から大きな変化がなければ50点。初めての変化、出走歴なしなら中立の50点',
      '初期配分は0%（過去レースの検証と毎週の自動見直しで効果を確かめます）',
    ],
  },
  layoff: {
    summary: '休み明け。前走から91日以上あいたとき、その馬が過去の休み明けでどうだったかです。',
    source: 'netkeiba の馬の過去走（日付・着順）と、DBにたまった全馬の過去走（休み明け全体の傾向）',
    lines: [
      'その馬の過去の休み明けの3着以内率を、その馬のふだんの3着以内率と比べる（同じで50点、10ポイント高いと+20点）',
      '初めての休み明けは、全体の傾向（休み明けはふだんより何割成績が落ちるか）で見積もる',
      '休み明けでなければ50点。出走歴なしなら中立の50点',
      '「状態」の項目にも休み明けの −10 があります（配分の見直しで、どちらが効くかを確かめます）',
      '初期配分は0%（過去レースの検証と毎週の自動見直しで効果を確かめます）',
    ],
  },
};
