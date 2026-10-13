/**
 * 3連単予想の解説を Gemini に書かせるためのプロンプト作成
 *
 * 画面で組み立てた買い目とデータの根拠だけを渡し、それ以外の情報を使わないよう指示する。
 * 受け取る内容は画面から送られるため、型と長さをここで確認・切り詰める。
 */

export interface CommentaryPlan {
  kind: string;
  available: boolean;
  reason: string;
  formation: string;
  ticketCount: number;
  summary: string;
  horses: string[][]; // 馬ごとの解説の行（1行目が見出し）
}

export interface CommentaryPayload {
  race: string;
  pace: string;
  plans: CommentaryPlan[];
}

const MAX_TEXT = 400;
const MAX_LINES = 10;
const MAX_HORSES = 6;

const str = (v: unknown, max = MAX_TEXT): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** 画面から届いた内容を検証して整える。形式が不正なら null */
export function sanitizePayload(body: any): CommentaryPayload | null {
  if (!body || typeof body !== 'object' || !Array.isArray(body.plans)) return null;
  const plans: CommentaryPlan[] = body.plans.slice(0, 3).map((p: any) => ({
    kind: str(p?.kind, 10),
    available: Boolean(p?.available),
    reason: str(p?.reason),
    formation: str(p?.formation),
    ticketCount: Number.isFinite(p?.ticketCount) ? Math.max(0, Math.min(100, Math.trunc(p.ticketCount))) : 0,
    summary: str(p?.summary),
    horses: Array.isArray(p?.horses)
      ? p.horses.slice(0, MAX_HORSES).map((h: any) => (Array.isArray(h) ? h.slice(0, MAX_LINES).map((l: unknown) => str(l)) : []))
      : [],
  }));
  if (plans.length === 0 || !plans.every((p) => ['本命', '中穴', '大穴'].includes(p.kind))) return null;
  return { race: str(body.race, 200), pace: str(body.pace, 800), plans };
}

export function buildCommentaryPrompt(p: CommentaryPayload): string {
  const planText = p.plans
    .map((plan) => {
      if (!plan.available) return `■${plan.kind}：作成できず（理由：${plan.reason}）`;
      const horses = plan.horses.map((lines) => lines.map((l, i) => (i === 0 ? `・${l}` : `  - ${l}`)).join('\n')).join('\n');
      return `■${plan.kind}：${plan.formation}（${plan.ticketCount}点）\n組み立て：${plan.summary}\n根拠データ：\n${horses}`;
    })
    .join('\n\n');

  return `あなたは日本の中央競馬（JRA）の予想解説者です。以下は、あるレースについてアプリがデータから組み立てた3連単の買い目と、その根拠データです。
これをもとに、競馬ファンが読みやすい日本語の解説を書いてください。

## 厳守するルール
- 下の「根拠データ」に書かれている事実と数字だけを使うこと。書かれていない成績・血統・調教・コメント・ニュースなどを補ったり推測したりしないこと。
- 「データなし」となっている項目は、データが無いと正直に書くこと。
- 買い目（馬番・点数）は変更せず、そのまま書くこと。
- 断定的に的中を約束する表現は使わないこと。最後に「予想は過去データに基づく参考情報です」と一文添えること。

## 出力の形
1. 展開予想（2〜3文）
2. 本命・中穴・大穴それぞれについて：買い目を1行で書き、そのあとに「なぜその馬を選んだか」を、馬の実績・調子、コース適性、騎手との相性、状態、展開との相性の観点から3〜6文で説明。作成できなかったものは理由を1文で書く。
全体で1200字程度まで。見出しは「■」で始めること。

## レース
${p.race}

## 展開予想の材料
${p.pace}

## 買い目と根拠データ
${planText}
`;
}

// ---------------- Gemini 専門家深掘り（実データのみ） ----------------

export interface DeliberationPayload {
  race: string;
  pace: string;
  /** 馬ごとの根拠の行（1行目が見出し）。データ予想の順位順 */
  horses: string[][];
  /** 3連単の買い目の要約（本命・中穴・大穴） */
  plans: string[];
  question: string;
}

const MAX_DELIB_HORSES = 18;
const MAX_DELIB_LINES = 12;

/** 画面から届いた深掘り用の内容を検証して整える。形式が不正なら null */
export function sanitizeDeliberation(body: any): DeliberationPayload | null {
  if (!body || typeof body !== 'object' || !Array.isArray(body.horses) || body.horses.length === 0) return null;
  const horses = body.horses
    .slice(0, MAX_DELIB_HORSES)
    .map((h: any) => (Array.isArray(h) ? h.slice(0, MAX_DELIB_LINES).map((l: unknown) => str(l)) : []))
    .filter((h: string[]) => h.length > 0);
  if (horses.length === 0) return null;
  return {
    race: str(body.race, 200),
    pace: str(body.pace, 800),
    horses,
    plans: Array.isArray(body.plans) ? body.plans.slice(0, 3).map((p: unknown) => str(p)) : [],
    question: str(body.question, 300),
  };
}

export function buildDeliberationPrompt(p: DeliberationPayload): string {
  const horses = p.horses.map((lines) => lines.map((l, i) => (i === 0 ? `・${l}` : `  - ${l}`)).join('\n')).join('\n');
  return `あなたは日本の中央競馬（JRA）の予想解説者です。以下は、あるレースについてアプリが集めた実データ（過去走・騎手成績・血統の産駒成績・過去10年の傾向）と、そこから計算した予想です。
これをもとに、レース全体の見立てを日本語で書いてください。

## 厳守するルール
- 下の「出走馬の根拠データ」「展開予想の材料」「買い目」に書かれている事実と数字だけを使うこと。書かれていない成績・血統・調教・厩舎コメント・ニュース・馬場傾向などを補ったり推測したりしないこと。
- 「データなし」「データ不足」「未取得」となっている項目は、データが無いと正直に書くこと。
- 断定的に的中を約束する表現は使わないこと。最後に「予想は過去データに基づく参考情報です」と一文添えること。
${p.question ? '- 質問がデータで答えられない内容（調教・厩舎の様子など）の場合は、データが無いため答えられないと書き、データで言えることだけを書くこと。\n' : ''}
## 出力の形
1. ■展開の見立て（2〜3文）
2. ■本命（◎）の根拠と不安点（3〜5文）
3. ■上位人気（1〜3番人気）の死角：データにある弱点だけを挙げる。弱点が見当たらない馬はそう書く
4. ■中穴・大穴の注目馬：データ上の根拠と、3着以内に入るための条件
${p.question ? '5. ■ご質問への回答\n' : ''}全体で1500字程度まで。見出しは「■」で始めること。

## レース
${p.race}

## 展開予想の材料
${p.pace}

## 買い目（アプリの3連単予想）
${p.plans.length > 0 ? p.plans.join('\n') : 'なし'}

## 出走馬の根拠データ（データ予想の順位順）
${horses}
${p.question ? `\n## ユーザーからの質問\n${p.question}\n` : ''}`;
}

// ---------------- Gemini の混雑時の自動やり直し ----------------

/** 混雑（503）・回数制限（429）による失敗か */
export function isRetryableGeminiError(err: any): boolean {
  const code = err?.status ?? err?.code ?? err?.error?.code;
  if (code === 503 || code === 429 || code === 'UNAVAILABLE' || code === 'RESOURCE_EXHAUSTED') return true;
  const msg = String(err?.message ?? err ?? '');
  return /"code"\s*:\s*(503|429)|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/i.test(msg);
}

/** 混雑による失敗のときだけ、待ち時間をおいてやり直す（既定：5秒後・15秒後の最大2回） */
export async function withGeminiRetry<T>(
  fn: () => Promise<T>,
  delaysMs: number[] = [5000, 15000],
  onRetry?: (attempt: number, err: any) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delaysMs.length || !isRetryableGeminiError(err)) throw err;
      onRetry?.(attempt + 1, err);
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
}
