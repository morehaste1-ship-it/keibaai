import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { openDatabase } from './server/db/index.ts';
import { RaceRepository } from './server/db/repository.ts';
import { NetkeibaSource } from './server/sources/netkeiba.ts';
import { PoliteFetcher } from './server/sources/fetcher.ts';
import { RaceService } from './server/services/race-service.ts';
import { JraCalendar } from './server/sources/jra-calendar.ts';
import { BatchService } from './server/services/batch-service.ts';
import { HistoryService } from './server/services/history-service.ts';
import { JockeyService } from './server/services/jockey-service.ts';
import { HorseService } from './server/services/horse-service.ts';
import { ScoreService, MAX_HORSE_K, MAX_JOCKEY_K, activeWeights } from './server/services/score-service.ts';
import { liveStatsByVersion, revertWeights } from './server/services/weight-tuner.ts';
import { buildCommentaryPrompt, buildDeliberationPrompt, sanitizeDeliberation, sanitizePayload, withGeminiRetry } from './server/services/commentary.ts';
import { acquireLock, lockHeldByOther, releaseLock } from './server/services/crawl-lock.ts';

/** 夜間ジョブなど別のプロセスが取得中なら 409 を返す（同時アクセスを防ぐ） */
function busyByOther(res: express.Response): boolean {
  const other = lockHeldByOther();
  if (!other) return false;
  res.status(409).json({ status: 'error', error: `ほかの取得（${other.owner}）が実行中です。終わってから実行してください` });
  return true;
}
import { PedigreeService, PEDIGREE_MIN_RUNS } from './server/services/pedigree-service.ts';
import { ReviewService, validateSettings } from './server/services/review-service.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// Initialize database
const db = openDatabase();
const repo = new RaceRepository(db);
const fetcher = new PoliteFetcher({
  onLog: (entry) => repo.logFetch(entry),
});
const source = new NetkeibaSource(fetcher);
const raceService = new RaceService(source, repo);
const calendar = new JraCalendar();
const batchService = new BatchService(calendar, source, repo);
// 過去10年分の収集は別のブラウザを使う（週末バッチの終了処理と干渉しないように）
const historyService = new HistoryService(new JraCalendar(), source, repo);
// 騎手成績は大量に読むため、間隔を長くした専用の取得処理を使う（アクセス制限対策）
const jockeyFetcher = new PoliteFetcher({ minIntervalMs: 5000, onLog: (entry) => repo.logFetch(entry) });
const jockeyService = new JockeyService(new NetkeibaSource(jockeyFetcher), repo);
// 馬の過去走も同じ取得処理（5秒間隔・アクセス制限の停止を共有）を使う
const horseService = new HorseService(new NetkeibaSource(jockeyFetcher), repo);
const scoreService = new ScoreService(repo);
const pedigreeService = new PedigreeService(new NetkeibaSource(jockeyFetcher), repo);
// 答え合わせ（結果ページは1レース1ページのため、通常の取得処理を使う）
const reviewService = new ReviewService(repo, scoreService, source);

// Initialize Gemini client if API key is present
const apiKey = process.env.GEMINI_API_KEY;
let aiClient: GoogleGenAI | null = null;
if (apiKey) {
  aiClient = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// API Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    timestamp: new Date().toISOString(),
  });
});

// レースの取得・保存（スクレイピング）
app.post('/api/race/fetch', async (req, res) => {
  try {
    const { raceInput } = req.body;
    if (!raceInput) {
      return res.status(400).json({ error: 'raceInput is required' });
    }

    const raceCard = await raceService.fetchAndSaveRace(raceInput);
    res.json({
      status: 'success',
      raceCard,
    });
  } catch (error: any) {
    console.error('Error in /api/race/fetch:', error);
    res.status(400).json({
      status: 'error',
      error: error.message || 'Failed to fetch race',
    });
  }
});

// 既存レースの取得
app.get('/api/race/:raceKey', (req, res) => {
  try {
    const { raceKey } = req.params;
    const raceCard = raceService.getRaceCard(raceKey);

    if (!raceCard) {
      return res.status(404).json({ error: 'Race not found' });
    }

    res.json({
      status: 'success',
      raceCard,
    });
  } catch (error: any) {
    console.error('Error in /api/race/:raceKey:', error);
    res.status(500).json({
      status: 'error',
      error: error.message || 'Internal server error',
    });
  }
});

// 最近のレース一覧
app.get('/api/races', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const races = raceService.listRaces(limit);

    res.json({
      status: 'success',
      races,
    });
  } catch (error: any) {
    console.error('Error in /api/races:', error);
    res.status(500).json({
      status: 'error',
      error: error.message || 'Internal server error',
    });
  }
});

// 基準日から対象の週末（土曜日）を決める
// 土曜→その日 / 日曜→前日の土曜 / 月〜金→次の土曜
function resolveWeekendSaturday(base: Date): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const dow = d.getDay();
  if (dow === 6) return d;
  if (dow === 0) {
    d.setDate(d.getDate() - 1);
    return d;
  }
  d.setDate(d.getDate() + (6 - dow));
  return d;
}

function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// バッチ処理：指定日を基準に週末のレースを事前取得
// body: { date: "YYYY-MM-DD" }（省略時は今日）
app.post('/api/batch/prepare-weekend', async (req, res) => {
  if (busyByOther(res)) return;
  try {
    const dateInput = req.body?.date;
    let base = new Date();

    if (dateInput !== undefined && dateInput !== null && dateInput !== '') {
      if (typeof dateInput !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
        return res.status(400).json({
          status: 'error',
          error: 'date は YYYY-MM-DD 形式で指定してください',
        });
      }
      base = new Date(`${dateInput}T00:00:00`);
      if (isNaN(base.getTime())) {
        return res.status(400).json({
          status: 'error',
          error: '日付が不正です',
        });
      }
    }

    const saturday = resolveWeekendSaturday(base);
    console.log(`[API] Starting batch prepare-weekend (target Saturday: ${formatYmd(saturday)})...`);
    const status = await batchService.prepareWeekendRaces(saturday);

    res.json({
      status: 'success',
      targetSaturday: formatYmd(saturday),
      batch: status,
    });
  } catch (error: any) {
    console.error('Error in /api/batch/prepare-weekend:', error);
    res.status(500).json({
      status: 'error',
      error: error.message || 'Batch execution failed',
    });
  }
});

// 単日のレースを取得（祝日の平日開催など）
// body: { date: "YYYY-MM-DD" }（必須）
app.post('/api/batch/prepare-day', async (req, res) => {
  if (busyByOther(res)) return;
  try {
    const dateInput = req.body?.date;
    if (typeof dateInput !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      return res.status(400).json({
        status: 'error',
        error: 'date は YYYY-MM-DD 形式で指定してください',
      });
    }
    const target = new Date(`${dateInput}T00:00:00`);
    if (isNaN(target.getTime())) {
      return res.status(400).json({ status: 'error', error: '日付が不正です' });
    }

    console.log(`[API] Starting batch prepare-day (target: ${formatYmd(target)})...`);
    const status = await batchService.prepareSingleDayRaces(target);

    res.json({
      status: 'success',
      targetDate: formatYmd(target),
      batch: status,
    });
  } catch (error: any) {
    console.error('Error in /api/batch/prepare-day:', error);
    res.status(500).json({
      status: 'error',
      error: error.message || 'Batch execution failed',
    });
  }
});

// DB に保存済みのレース（出馬表・オッズ付き）一覧を返す（画面の起動時読み込み用）
// query: from=YYYY-MM-DD（その日以降・TOP 用）／date=YYYY-MM-DD（その日だけ・過去のレース用）／どちらも無ければ新しい順
app.get('/api/races/cards', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 200);
    const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const { from, date } = req.query;
    if ((from !== undefined && !isDate(from)) || (date !== undefined && !isDate(date))) {
      return res.status(400).json({ status: 'error', error: 'from・date は YYYY-MM-DD で指定してください' });
    }
    const races = isDate(date)
      ? raceService.listRacesOnDate(date)
      : isDate(from)
        ? raceService.listRacesFrom(from, limit)
        : raceService.listRaces(limit);
    const raceCards = races
      .map((r) => raceService.getRaceCard(r.raceKey))
      .filter((c) => c !== null);

    res.json({
      status: 'success',
      raceCards,
    });
  } catch (error: any) {
    console.error('Error in /api/races/cards:', error);
    res.status(500).json({
      status: 'error',
      error: error.message || 'Internal server error',
    });
  }
});

// 過去10年の同一レース結果を取得・保存（DB書き込みあり。時間がかかる）
// body: { raceKey: "YYYYMMDD-VV-RR" }
app.post('/api/history/collect', async (req, res) => {
  try {
    const raceKey = req.body?.raceKey;
    if (typeof raceKey !== 'string' || !/^\d{8}-\d{2}-\d{2}$/.test(raceKey)) {
      return res.status(400).json({ status: 'error', error: 'raceKey は YYYYMMDD-VV-RR 形式で指定してください' });
    }
    if (!repo.getRace(raceKey)) {
      return res.status(404).json({ status: 'error', error: '対象レースが未登録です' });
    }

    console.log(`[API] Starting history collect (raceKey: ${raceKey})...`);
    const result = await historyService.collect(raceKey, 10);
    res.json({ status: 'success', ...result });
  } catch (error: any) {
    console.error('Error in /api/history/collect:', error);
    res.status(500).json({ status: 'error', error: error.message || 'History collect failed' });
  }
});

// 保存済みの過去結果を分析する（DB読み取りのみ）
// query: condition=all|良|稍重|重|不良（詳細を表示する馬場。省略時は全馬場）、raceCondition=今回の馬場（強調表示用）
app.get('/api/history/analysis/:raceKey', (req, res) => {
  try {
    const { raceKey } = req.params;
    if (!/^\d{8}-\d{2}-\d{2}$/.test(raceKey)) {
      return res.status(400).json({ status: 'error', error: 'raceKey の形式が不正です' });
    }
    const condition = req.query.condition as string | undefined;
    if (condition !== undefined && !['all', '良', '稍重', '重', '不良'].includes(condition)) {
      return res.status(400).json({ status: 'error', error: 'condition は all・良・稍重・重・不良 のいずれかです' });
    }
    const raceCondition = req.query.raceCondition as string | undefined;
    if (raceCondition !== undefined && !['良', '稍重', '重', '不良'].includes(raceCondition)) {
      return res.status(400).json({ status: 'error', error: 'raceCondition は 良・稍重・重・不良 のいずれかです' });
    }
    if (!repo.getRace(raceKey)) {
      return res.status(404).json({ status: 'error', error: '対象レースが未登録です' });
    }

    const analysis = historyService.analyze(raceKey, condition, raceCondition);
    res.json({ status: 'success', analysis });
  } catch (error: any) {
    console.error('Error in /api/history/analysis:', error);
    res.status(500).json({ status: 'error', error: error.message || 'Analysis failed' });
  }
});

// 選択中レースの騎手の成績（過去5年）を取得する。時間がかかるため裏で実行し、すぐ返す（DB書き込みあり）
// body: { raceKey: "YYYYMMDD-VV-RR" }
app.post('/api/jockeys/crawl', (req, res) => {
  if (busyByOther(res)) return;
  try {
    const raceKey = req.body?.raceKey;
    if (typeof raceKey !== 'string' || !/^\d{8}-\d{2}-\d{2}$/.test(raceKey)) {
      return res.status(400).json({ status: 'error', error: 'raceKey は YYYYMMDD-VV-RR 形式で指定してください' });
    }
    if (!repo.getRace(raceKey)) {
      return res.status(404).json({ status: 'error', error: '対象レースが未登録です' });
    }
    if (jockeyService.getStatus().running) {
      return res.status(409).json({ status: 'error', error: '騎手成績を取得中です。終わってから実行してください' });
    }
    const raceJockeyIds = Array.from(
      new Set(repo.getEntries(raceKey).map((e) => e.jockeyId).filter((id): id is string => Boolean(id))),
    );
    // jockeyId を指定した場合はその騎手だけ取得する（仕様確認用）
    const onlyId = req.body?.jockeyId;
    if (onlyId !== undefined && (typeof onlyId !== 'string' || !raceJockeyIds.includes(onlyId))) {
      return res.status(400).json({ status: 'error', error: '指定の騎手はこのレースに騎乗していません' });
    }
    const jockeyIds = onlyId ? [onlyId] : raceJockeyIds;
    if (jockeyIds.length === 0) {
      return res.status(400).json({
        status: 'error',
        error: '騎手IDが未保存です。先に出馬表を取り込み直してください（週末データを取得 / この日だけ取得）',
      });
    }

    // 手動実行は1回 1500 ページ（約2時間）まで、1人だけなら 400 ページ（約35分）まで
    if (!acquireLock('server')) return res.status(409).json({ status: 'error', error: 'ほかの取得が実行中です' });
    jockeyService
      .crawl(jockeyIds, onlyId ? 400 : 1500)
      .catch((err) => console.error('[Jockey] crawl failed:', err))
      .finally(() => releaseLock());
    res.status(202).json({ status: 'started', jockeys: jockeyIds.length });
  } catch (error: any) {
    console.error('Error in /api/jockeys/crawl:', error);
    res.status(500).json({ status: 'error', error: error.message || 'Jockey crawl failed' });
  }
});

// 騎手成績の取得状況
app.get('/api/jockeys/crawl-status', (req, res) => {
  res.json({ status: 'success', crawl: jockeyService.getStatus() });
});

// 選択中レースの騎手分析（DB読み取りのみ）
app.get('/api/jockeys/analysis/:raceKey', (req, res) => {
  try {
    const { raceKey } = req.params;
    if (!/^\d{8}-\d{2}-\d{2}$/.test(raceKey)) {
      return res.status(400).json({ status: 'error', error: 'raceKey の形式が不正です' });
    }
    if (!repo.getRace(raceKey)) {
      return res.status(404).json({ status: 'error', error: '対象レースが未登録です' });
    }
    res.json({ status: 'success', analysis: jockeyService.analyze(raceKey) });
  } catch (error: any) {
    console.error('Error in /api/jockeys/analysis:', error);
    res.status(500).json({ status: 'error', error: error.message || 'Analysis failed' });
  }
});

// 選択中レースの出走馬の過去走を取得する（裏で実行し、すぐ返す。DB書き込みあり）
app.post('/api/horses/crawl', (req, res) => {
  if (busyByOther(res)) return;
  try {
    const raceKey = req.body?.raceKey;
    if (typeof raceKey !== 'string' || !/^\d{8}-\d{2}-\d{2}$/.test(raceKey)) {
      return res.status(400).json({ status: 'error', error: 'raceKey は YYYYMMDD-VV-RR 形式で指定してください' });
    }
    if (!repo.getRace(raceKey)) {
      return res.status(404).json({ status: 'error', error: '対象レースが未登録です' });
    }
    if (horseService.getStatus().running) {
      return res.status(409).json({ status: 'error', error: '馬の過去走を取得中です。終わってから実行してください' });
    }
    const horseIds = Array.from(
      new Set(repo.getEntries(raceKey).map((e) => e.netkeibaHorseId).filter((id): id is string => Boolean(id))),
    );
    if (horseIds.length === 0) {
      return res.status(400).json({ status: 'error', error: '馬IDが未保存です。先に出馬表を取り込み直してください' });
    }
    // 過去走の取得後、血統と産駒成績を取得する（出走が少ない馬を先に。血統は取得済みなら読まない）
    if (!acquireLock('server')) return res.status(409).json({ status: 'error', error: 'ほかの取得が実行中です' });
    horseService
      .crawl(horseIds, 100)
      .then(async (st) => {
        if (st.rateLimited) return;
        const lowRun = horseIds.filter((id) => repo.listHorseRuns(id).length < PEDIGREE_MIN_RUNS);
        const others = horseIds.filter((id) => !lowRun.includes(id));
        const ped = await pedigreeService.crawl([...lowRun, ...others], 200);
        console.log(`[Pedigree] race ${raceKey}: 血統${ped.pedigreesFetched}頭・産駒成績${ped.siresFetched}頭分`, ped.errors);
      })
      .catch((err) => console.error('[Horse] crawl failed:', err))
      .finally(() => releaseLock());
    res.status(202).json({ status: 'started', horses: horseIds.length });
  } catch (error: any) {
    console.error('Error in /api/horses/crawl:', error);
    res.status(500).json({ status: 'error', error: error.message || 'Horse crawl failed' });
  }
});

app.get('/api/horses/crawl-status', (req, res) => {
  res.json({ status: 'success', crawl: horseService.getStatus() });
});

// 馬の脚質 × 騎手の相性（DB読み取りのみ）
app.get('/api/matchup/:raceKey', (req, res) => {
  try {
    const { raceKey } = req.params;
    if (!/^\d{8}-\d{2}-\d{2}$/.test(raceKey)) {
      return res.status(400).json({ status: 'error', error: 'raceKey の形式が不正です' });
    }
    if (!repo.getRace(raceKey)) {
      return res.status(404).json({ status: 'error', error: '対象レースが未登録です' });
    }
    res.json({ status: 'success', analysis: horseService.analyzeRace(raceKey) });
  } catch (error: any) {
    console.error('Error in /api/matchup:', error);
    res.status(500).json({ status: 'error', error: error.message || 'Analysis failed' });
  }
});

// データ予想の点数（各項目0〜100）。配分は画面側で掛ける（DB読み取りのみ）
// query: condition=良|稍重|重|不良（省略時はレースの馬場）
app.get('/api/score/:raceKey', (req, res) => {
  try {
    const { raceKey } = req.params;
    if (!/^\d{8}-\d{2}-\d{2}$/.test(raceKey)) {
      return res.status(400).json({ status: 'error', error: 'raceKey の形式が不正です' });
    }
    const condition = req.query.condition as string | undefined;
    if (condition !== undefined && !['良', '稍重', '重', '不良'].includes(condition)) {
      return res.status(400).json({ status: 'error', error: 'condition は 良・稍重・重・不良 のいずれかです' });
    }
    if (!repo.getRace(raceKey)) {
      return res.status(404).json({ status: 'error', error: '対象レースが未登録です' });
    }
    // 補正の強さ（任意）：horseK=0〜10、jockeyK=0〜30 の整数
    const parseK = (v: unknown, max: number): number | undefined | null => {
      if (v === undefined) return undefined;
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
    };
    const horseK = parseK(req.query.horseK, MAX_HORSE_K);
    const jockeyK = parseK(req.query.jockeyK, MAX_JOCKEY_K);
    if (horseK === null || jockeyK === null) {
      return res.status(400).json({
        status: 'error',
        error: `horseK は0〜${MAX_HORSE_K}、jockeyK は0〜${MAX_JOCKEY_K} の整数で指定してください`,
      });
    }
    res.json({ status: 'success', score: scoreService.compute(raceKey, condition, { horseK, jockeyK }) });
  } catch (error: any) {
    console.error('Error in /api/score:', error);
    res.status(500).json({ status: 'error', error: error.message || 'Score failed' });
  }
});

// 3連単予想の解説を Gemini に書かせる（画面で組み立てた買い目と根拠データを受け取る。DBは使わない）
app.post('/api/trifecta-commentary', async (req, res) => {
  try {
    if (!aiClient) {
      return res.status(400).json({ status: 'error', error: 'Gemini の APIキーが設定されていません（.env の GEMINI_API_KEY）' });
    }
    const payload = sanitizePayload(req.body);
    if (!payload) {
      return res.status(400).json({ status: 'error', error: '送信された予想データの形式が不正です' });
    }
    // 混雑（503・429）のときは 5秒後・15秒後に自動でやり直す
    const client = aiClient;
    const response = await withGeminiRetry(
      () => client.models.generateContent({ model: 'gemini-3.8-flash', contents: buildCommentaryPrompt(payload) }),
      undefined,
      (n) => console.log(`[Gemini] 混雑のため再試行 ${n}回目（3連単の解説）`),
    );
    const text = response.text ?? '';
    if (!text.trim()) {
      return res.status(502).json({ status: 'error', error: 'Gemini から解説が返ってきませんでした' });
    }
    res.json({ status: 'success', model: 'gemini-3.8-flash', commentary: text });
  } catch (error: any) {
    console.error('Error in /api/trifecta-commentary:', error?.message ?? error);
    res.status(502).json({ status: 'error', error: `Gemini の呼び出しに失敗しました：${error?.message ?? error}` });
  }
});

// Gemini 専門家深掘り（実データの根拠だけを送る。失敗時に作り話の代替文は出さない）
app.post('/api/race-deliberation', async (req, res) => {
  try {
    if (!aiClient) {
      return res.status(400).json({ status: 'error', error: 'Gemini の APIキーが設定されていません（.env の GEMINI_API_KEY）' });
    }
    const payload = sanitizeDeliberation(req.body);
    if (!payload) {
      return res.status(400).json({ status: 'error', error: '送信されたデータの形式が不正です' });
    }
    // 混雑（503・429）のときは 5秒後・15秒後に自動でやり直す
    const client = aiClient;
    const response = await withGeminiRetry(
      () => client.models.generateContent({ model: 'gemini-3.8-flash', contents: buildDeliberationPrompt(payload) }),
      undefined,
      (n) => console.log(`[Gemini] 混雑のため再試行 ${n}回目（深掘り）`),
    );
    const text = response.text ?? '';
    if (!text.trim()) {
      return res.status(502).json({ status: 'error', error: 'Gemini から回答が返ってきませんでした' });
    }
    res.json({ status: 'success', model: 'gemini-3.8-flash', analysis: text });
  } catch (error: any) {
    console.error('Error in /api/race-deliberation:', error?.message ?? error);
    res.status(502).json({ status: 'error', error: `Gemini の呼び出しに失敗しました：${error?.message ?? error}` });
  }
});

// 答え合わせ：今の設定で予想を記録する（発走前のみ。同じレースは上書き）
app.post('/api/review/record/:raceKey', (req, res) => {
  try {
    const { raceKey } = req.params;
    if (!/^\d{8}-\d{2}-\d{2}$/.test(raceKey)) {
      return res.status(400).json({ status: 'error', error: 'raceKey の形式が不正です' });
    }
    const { settings, error } = validateSettings(req.body?.settings);
    if (!settings) return res.status(400).json({ status: 'error', error });
    const rec = reviewService.record(raceKey, 'manual', settings);
    res.json({ status: 'success', recordedAt: rec.recordedAt });
  } catch (error: any) {
    res.status(400).json({ status: 'error', error: error.message || '記録に失敗しました' });
  }
});

// 答え合わせ：結果（着順・3連単の払戻）を取り込む
app.post('/api/review/outcome/:raceKey', async (req, res) => {
  try {
    const { raceKey } = req.params;
    if (!/^\d{8}-\d{2}-\d{2}$/.test(raceKey)) {
      return res.status(400).json({ status: 'error', error: 'raceKey の形式が不正です' });
    }
    if (!repo.getRace(raceKey)) return res.status(404).json({ status: 'error', error: '対象レースが未登録です' });
    await reviewService.fetchOutcome(raceKey);
    res.json({ status: 'success' });
  } catch (error: any) {
    res.status(502).json({ status: 'error', error: error.message || '結果の取得に失敗しました' });
  }
});

// 配分の自動見直し：採用中の配分と履歴
app.get('/api/weights', (req, res) => {
  try {
    // 版ごとの実際の予想の成績（0 = 既定の配分）
    const live = Object.fromEntries([...liveStatsByVersion(repo)].map(([id, s]) => [id, s]));
    res.json({ status: 'success', current: activeWeights(repo), versions: repo.listWeightVersions(), live });
  } catch (error: any) {
    res.status(500).json({ status: 'error', error: error.message || '配分の読み込みに失敗しました' });
  }
});

// 配分の自動見直し：1つ前の配分に戻す
app.post('/api/weights/revert', (req, res) => {
  try {
    const v = revertWeights(repo);
    res.json({ status: 'success', version: v });
  } catch (error: any) {
    res.status(400).json({ status: 'error', error: error.message || '戻せませんでした' });
  }
});

// 答え合わせ：一覧と集計
app.get('/api/review', (req, res) => {
  try {
    const scope = req.query.scope === 'all' ? 'all' : 'graded';
    res.json({ status: 'success', review: reviewService.review(scope) });
  } catch (error: any) {
    console.error('Error in /api/review:', error);
    res.status(500).json({ status: 'error', error: error.message || 'Review failed' });
  }
});

// 過去の開催日とレース数（新しい順）。query: before=YYYY-MM-DD（この日より前）
app.get('/api/races/dates', (req, res) => {
  try {
    const before = req.query.before;
    if (typeof before !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(before)) {
      return res.status(400).json({ status: 'error', error: 'before は YYYY-MM-DD で指定してください' });
    }
    res.json({ status: 'success', dates: raceService.listPastRaceDates(before) });
  } catch (error: any) {
    console.error('Error in /api/races/dates:', error);
    res.status(500).json({ status: 'error', error: error.message || 'Internal server error' });
  }
});

// Development vs Production serving
async function setupVite() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: {
        middlewareMode: true,
        // DB・ログへの書き込みで画面が再読み込みされないように監視対象から外す
        watch: { ignored: ['**/data/**', '**/logs/**', '**/*.sqlite*'] },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🏇 KeibaAI Server running on http://0.0.0.0:${PORT}`);
  });
}

setupVite().catch((err) => {
  console.error('Failed to start server:', err);
});
