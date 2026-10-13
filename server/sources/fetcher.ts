/**
 * 行儀のよい取得処理（PoliteFetcher）
 *
 * - 全リクエストを1本の列に並べ、前回の応答完了から minIntervalMs 以上空けて送る
 * - 取得したページはディスクに保存し、有効期限内なら再アクセスしない
 * - 403 / 429 / 503 を受けたらアクセス制限とみなし、一定時間すべての取得を停止する
 *   （接続元を変えるなどの回避はしない）
 * - 自動リトライはしない（相手サーバーへの負荷を増やさないため）
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface FetchedPage {
  url: string;
  status: number;
  text: string;
  fetchedAt: string; // ISO8601
  fromCache: boolean;
  cacheFile: string;
}

export interface FetchLogEntry {
  url: string;
  status: number | null;
  fromCache: boolean;
  error: string | null;
  cacheFile: string | null;
  fetchedAt: string;
}

export interface PoliteFetcherOptions {
  /** リクエスト間隔の最小値（ミリ秒）。既定 3000 */
  minIntervalMs?: number;
  /** アクセス制限を受けた後の停止時間（ミリ秒）。既定 30分 */
  cooldownMs?: number;
  /** タイムアウト（ミリ秒）。既定 20000 */
  timeoutMs?: number;
  /** キャッシュ保存先 */
  cacheDir?: string;
  userAgent?: string;
  /** 取得のたびに呼ばれる（fetch_log への記録用） */
  onLog?: (entry: FetchLogEntry) => void;
}

export interface GetOptions {
  /** キャッシュの有効期限（ミリ秒）。0 なら必ず取りに行く。既定 1時間 */
  maxAgeMs?: number;
  /** true ならディスクに保存しない（大量に読むページ用。maxAgeMs も 0 として扱う） */
  noStore?: boolean;
}

export class RateLimitedError extends Error {
  constructor(
    message: string,
    public readonly retryAfter: Date,
  ) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

export class FetchFailedError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = 'FetchFailedError';
  }
}

const RATE_LIMIT_STATUSES = new Set([403, 429, 503]);

interface CacheMeta {
  url: string;
  status: number;
  contentType: string | null;
  fetchedAt: string;
}

export class PoliteFetcher {
  private readonly minIntervalMs: number;
  private readonly cooldownMs: number;
  private readonly timeoutMs: number;
  private readonly cacheDir: string;
  private readonly userAgent: string;
  private readonly onLog?: (entry: FetchLogEntry) => void;

  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private cooldownUntil = 0;

  constructor(opts: PoliteFetcherOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 3000;
    this.cooldownMs = opts.cooldownMs ?? 30 * 60 * 1000;
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.cacheDir = opts.cacheDir ?? path.resolve(process.cwd(), 'data', 'cache');
    this.userAgent = opts.userAgent ?? process.env.KEIBA_USER_AGENT ?? 'KeibaAI-Pro/0.1 (personal use)';
    this.onLog = opts.onLog;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  /** 停止中なら再開予定時刻、そうでなければ null */
  getCooldownUntil(): Date | null {
    return this.cooldownUntil > Date.now() ? new Date(this.cooldownUntil) : null;
  }

  async get(url: string, opts: GetOptions = {}): Promise<FetchedPage> {
    const noStore = opts.noStore === true;
    const maxAgeMs = noStore ? 0 : opts.maxAgeMs ?? 60 * 60 * 1000;

    const cached = this.readCache(url, maxAgeMs);
    if (cached) {
      this.log({ url, status: cached.status, fromCache: true, error: null, cacheFile: cached.cacheFile, fetchedAt: cached.fetchedAt });
      return cached;
    }

    // 列に並べて1件ずつ処理する
    const task = this.queue.then(() => this.fetchNetwork(url, noStore));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async fetchNetwork(url: string, noStore = false): Promise<FetchedPage> {
    const now = Date.now();
    if (this.cooldownUntil > now) {
      throw new RateLimitedError('アクセス制限中のため取得を停止しています', new Date(this.cooldownUntil));
    }

    const wait = this.lastRequestAt + this.minIntervalMs - now;
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();

    const fetchedAt = new Date().toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': this.userAgent, 'Accept-Language': 'ja' },
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (e: any) {
      const msg = e?.name === 'AbortError' ? 'タイムアウトしました' : `通信エラー: ${e?.message ?? e}`;
      this.log({ url, status: null, fromCache: false, error: msg, cacheFile: null, fetchedAt });
      throw new FetchFailedError(msg, url, null);
    } finally {
      clearTimeout(timer);
      // 間隔は「前回の応答完了」から数える（応答が遅いときほど間隔が広がる）
      this.lastRequestAt = Date.now();
    }

    if (RATE_LIMIT_STATUSES.has(res.status)) {
      this.cooldownUntil = Date.now() + this.cooldownMs;
      const msg = `アクセス制限の可能性があります（HTTP ${res.status}）。${Math.round(this.cooldownMs / 60000)}分間取得を停止します`;
      this.log({ url, status: res.status, fromCache: false, error: msg, cacheFile: null, fetchedAt });
      throw new RateLimitedError(msg, new Date(this.cooldownUntil));
    }
    if (!res.ok) {
      const msg = `取得に失敗しました（HTTP ${res.status}）`;
      this.log({ url, status: res.status, fromCache: false, error: msg, cacheFile: null, fetchedAt });
      throw new FetchFailedError(msg, url, res.status);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type');
    const cacheFile = noStore ? '' : this.writeCache(url, buf, { url, status: res.status, contentType, fetchedAt });
    const text = decodeBody(buf, contentType);

    this.log({ url, status: res.status, fromCache: false, error: null, cacheFile: cacheFile || null, fetchedAt });
    return { url, status: res.status, text, fetchedAt, fromCache: false, cacheFile };
  }

  private cachePaths(url: string) {
    const hash = crypto.createHash('sha1').update(url).digest('hex');
    return { body: path.join(this.cacheDir, `${hash}.bin`), meta: path.join(this.cacheDir, `${hash}.json`) };
  }

  private readCache(url: string, maxAgeMs: number): FetchedPage | null {
    if (maxAgeMs <= 0) return null;
    const p = this.cachePaths(url);
    if (!fs.existsSync(p.body) || !fs.existsSync(p.meta)) return null;
    try {
      const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8')) as CacheMeta;
      if (Date.now() - new Date(meta.fetchedAt).getTime() > maxAgeMs) return null;
      const buf = fs.readFileSync(p.body);
      return {
        url,
        status: meta.status,
        text: decodeBody(buf, meta.contentType),
        fetchedAt: meta.fetchedAt,
        fromCache: true,
        cacheFile: p.body,
      };
    } catch {
      return null;
    }
  }

  private writeCache(url: string, buf: Buffer, meta: CacheMeta): string {
    const p = this.cachePaths(url);
    fs.writeFileSync(p.body, buf);
    fs.writeFileSync(p.meta, JSON.stringify(meta));
    return p.body;
  }

  private log(entry: FetchLogEntry) {
    try {
      this.onLog?.(entry);
    } catch {
      // 記録の失敗で取得処理を止めない
    }
  }
}

/**
 * 文字コードを判定して文字列に変換する。
 * 優先順: HTTPヘッダーの charset → HTML内の meta charset → UTF-8
 * （netkeiba は EUC-JP のページがあるため判定が必要）
 */
export function decodeBody(buf: Buffer, contentType: string | null): string {
  let charset = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  const normalized = (charset ?? 'utf-8').toLowerCase().replace(/^(x-)?euc[-_]?jp$/, 'euc-jp').replace(/^(shift[-_]?jis|sjis|x-sjis)$/, 'shift_jis');
  try {
    return new TextDecoder(normalized).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
