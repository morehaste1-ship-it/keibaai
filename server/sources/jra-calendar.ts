/**
 * JRA レースカレンダー取得（Puppeteer 版）
 *
 * netkeiba.com のカレンダーから次週末のレース情報を抽出
 * Puppeteer でブラウザを制御して JavaScript 実行後の DOM を取得
 */

import puppeteer, { type Browser } from 'puppeteer';

export interface CalendarRace {
  raceId: string; // 12 digits: YYYYMMDDVVRR
  date: string; // YYYY-MM-DD
  dayOfWeek: string; // '土' or '日'
  trackName: string; // 札幌, 函館, etc.
  raceNo: number;
  raceName: string;
  time?: string;
}

export class JraCalendar {
  private browser: Browser | null = null;

  /**
   * Puppeteer ブラウザインスタンスを初期化
   */
  async init(): Promise<void> {
    if (this.browser) return;

    // Vercel 環境での Puppeteer 実行に対応
    const isVercel = process.env.VERCEL === '1';

    this.browser = await puppeteer.launch({
      headless: true,
      args: isVercel
        ? ['--no-sandbox', '--disable-setuid-sandbox']
        : [],
    });
  }

  /**
   * Puppeteer インスタンスをクローズ
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * 週末（土日）のレース情報を取得
   * @param targetSaturday 対象の土曜日。省略時は「次の土曜」（木曜夜の定期実行用）
   */
  async fetchNextWeekendRaces(targetSaturday?: Date): Promise<CalendarRace[]> {
    await this.init();
    if (!this.browser) throw new Error('Browser not initialized');

    const now = new Date();
    const nextSaturday = targetSaturday ?? this.getNextDayOfWeek(now, 6);
    const nextSunday = new Date(nextSaturday);
    nextSunday.setDate(nextSunday.getDate() + 1);

    const races: CalendarRace[] = [];

    try {
      // 土曜日のレースを取得
      const saturdayRaces = await this.fetchRacesForDate(nextSaturday);
      races.push(...saturdayRaces);
      console.log(`[Calendar] Saturday (${this.formatDate(nextSaturday)}): ${saturdayRaces.length} races`);

      // 日曜日のレースを取得
      const sundayRaces = await this.fetchRacesForDate(nextSunday);
      races.push(...sundayRaces);
      console.log(`[Calendar] Sunday (${this.formatDate(nextSunday)}): ${sundayRaces.length} races`);
    } catch (err: any) {
      console.error('[Calendar] Error fetching races:', err?.message ?? err);
    }

    return races;
  }

  /**
   * 指定した1日のレース一覧を取得（祝日の平日開催など）
   */
  async fetchRacesOnDate(date: Date): Promise<CalendarRace[]> {
    await this.init();
    if (!this.browser) throw new Error('Browser not initialized');
    return this.fetchRacesForDate(date);
  }

  /**
   * 指定日付のレース一覧を取得
   */
  private async fetchRacesForDate(date: Date): Promise<CalendarRace[]> {
    if (!this.browser) throw new Error('Browser not initialized');

    const dateStr = this.formatDate(date);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const yyyymmdd = `${year}${month}${day}`;

    const url = `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${yyyymmdd}`;

    const page = await this.browser.newPage();
    page.setDefaultTimeout(15000);

    try {
      await page.goto(url, { waitUntil: 'networkidle0' });

      // JavaScript 実行後の DOM からレース情報を抽出
      const races = await page.evaluate((targetYyyymmdd) => {
        const races: any[] = [];
        const seen = new Set<string>();

        // netkeiba のレースリスト構造を探す
        // <a href="/race/result.html?race_id=YYYYMMDDVVRR">レース名</a>
        const links = document.querySelectorAll('a[href*="race_id="]');

        links.forEach((link) => {
          const href = (link as HTMLAnchorElement).href;
          const match = /race_id=(\d{12})/.exec(href);
          if (!match) return;

          const raceId = match[1];

          // JRA の会場コード（01〜10）以外（地方競馬）を除外
          // race_id 形式: YYYY VV KK NN RR（VV=会場コードは5〜6桁目）
          const venueCheck = raceId.substring(4, 6);
          if (!/^(0[1-9]|10)$/.test(venueCheck)) return;

          const raceName = (link.textContent || '').replace(/\s+/g, ' ').trim();

          // 同一レースには結果リンクと動画アイコン（文字なし）の2つがあるため、文字の長い方を採用する
          if (seen.has(raceId)) {
            const existing = races.find((r) => r.raceId === raceId);
            if (existing && raceName.length > existing.raceName.length) existing.raceName = raceName;
            return;
          }
          seen.add(raceId);

          // race_id から会場コードとレース番号を抽出（形式: YYYY VV KK NN RR）
          const venueCode = raceId.substring(4, 6);
          const raceNoStr = raceId.substring(10, 12);
          const raceNo = parseInt(raceNoStr, 10);

          // 日付は race_id からは取れないため、指定された対象日を使用
          const date = `${targetYyyymmdd.substring(0, 4)}-${targetYyyymmdd.substring(4, 6)}-${targetYyyymmdd.substring(6, 8)}`;

          // 会場名
          // JRA 10場（netkeiba の会場コード）
          const venueMap: Record<string, string> = {
            '01': '札幌',
            '02': '函館',
            '03': '福島',
            '04': '新潟',
            '05': '東京',
            '06': '中山',
            '07': '中京',
            '08': '京都',
            '09': '阪神',
            '10': '小倉',
          };
          const trackName = venueMap[venueCode] || 'Unknown';

          races.push({
            raceId,
            date,
            trackName,
            raceNo,
            raceName,
          });
        });

        return races;
      }, yyyymmdd);

      return races;
    } catch (err: any) {
      console.warn(`[Calendar] Failed to fetch ${dateStr}:`, err?.message ?? err);
      return [];
    } finally {
      await page.close();
    }
  }

  /**
   * 次の指定曜日を取得
   */
  private getNextDayOfWeek(baseDate: Date, targetDay: number): Date {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + 1);

    while (date.getDay() !== targetDay) {
      date.setDate(date.getDate() + 1);
    }

    return date;
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}
