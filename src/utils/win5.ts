/**
 * WIN5 の買い目（画面・記録で共通）
 *
 * 5レースそれぞれの各馬の「1着になる確率の目安」（データ予想の順位ごとの過去の勝率から）を使い、
 * 点数（各レースの頭数の掛け算）が予算以内で、5レースとも当たる確率（各レースの選んだ馬の確率の合計の掛け算）が
 * 一番高くなるように、各レースの頭数を決める。全通り（各レース1〜MAX_PICKS頭）を調べる
 */

export const WIN5_DEFAULT_BUDGET = 500;
/** 1レースで選ぶ頭数の上限 */
export const WIN5_MAX_PICKS = 8;

export interface Win5Candidate {
  horseNumber: number;
  horseName: string;
  rank: number;
  mark: string;
  popularity: number | null;
  /** 1着になる確率の目安（そのレースの出走馬で合計1） */
  prob: number;
}

export interface Win5LegInput {
  leg: number;
  label: string;
  /** 確率の高い順 */
  candidates: Win5Candidate[];
}

export interface Win5Allocation {
  /** 各レースの頭数 */
  picks: number[];
  points: number;
  /** 5レースとも当たる確率の目安 */
  hitProb: number;
  /** 各レースの当たる確率の目安 */
  legProbs: number[];
}

/** 予算（点数の上限）の中で、5レースとも当たる確率が一番高い頭数の組を返す。同じ確率なら点数の少ないほう */
export function allocateWin5(legs: Win5LegInput[], budget: number): Win5Allocation | null {
  if (legs.length === 0 || legs.some((l) => l.candidates.length === 0) || budget < 1) return null;
  // 各レースの「上位 k 頭の確率の合計」
  const cum = legs.map((l) => {
    const out: number[] = [];
    let s = 0;
    for (let k = 0; k < Math.min(WIN5_MAX_PICKS, l.candidates.length); k++) {
      s += l.candidates[k].prob;
      out.push(s);
    }
    return out;
  });
  let best: Win5Allocation | null = null;
  const picks = new Array(legs.length).fill(1);
  const visit = (i: number, points: number, prob: number) => {
    if (points > budget) return;
    if (i === legs.length) {
      if (!best || prob > best.hitProb + 1e-12 || (Math.abs(prob - best.hitProb) <= 1e-12 && points < best.points)) {
        best = { picks: [...picks], points, hitProb: prob, legProbs: picks.map((k, j) => cum[j][k - 1]) };
      }
      return;
    }
    for (let k = 1; k <= cum[i].length; k++) {
      if (points * k > budget) break;
      picks[i] = k;
      visit(i + 1, points * k, prob * cum[i][k - 1]);
    }
  };
  visit(0, 1, 1);
  return best;
}
