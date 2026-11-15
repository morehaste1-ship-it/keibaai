/**
 * データの組み合わせ分析（読むだけ・DBに書き込まない・予想の点数には使わない）
 *
 * 実行: npx tsx server/scripts/check-combos.ts            … 2016年以降の走で集計
 *       npx tsx server/scripts/check-combos.ts --from 2019-01-01
 *
 * 何をするか
 *  馬の成績ページから集めた全走（horse_runs、JRAの10場のみ）を1走ずつ見て、
 *  「休み明け×クラス」「枠×コース」のような2〜3項目の組み合わせごとに成績を集計する。
 *  項目は、その走より前に分かっていること（前走の内容・間隔・枠・斤量など）だけを使う。
 *  馬場・馬体重は当日に分かる情報なので、表の名前に【当日】と付ける（前日予想では使えない）
 *
 * 見方
 *  強い馬は人気になるので、単純な3着内率では「強い馬が多かった」だけの差が出る。
 *  そこで人気ごと（頭数の帯ごと）の3着内率（全体の平均）から「人気どおりなら何頭が3着内に来るか（期待）」を計算し、
 *  実際との差（人気で説明できない差）を主に見る。
 *   - 差      : 実際の3着内率 − 人気から期待される3着内率（ポイント）
 *   - z       : 差が偶然で出る大きさの何倍か。±3 以上を「有力」とする（組み合わせが多いため厳しめ）
 *   - 前後一致: 期間を前半・後半に分けても差の向きが同じなら ○（たまたまの偏りを除くため）
 *   - 単回収  : 単勝を100円ずつ買ったときの回収率（参考）
 *  件数が MIN_COUNT 未満の組み合わせは表示しない
 *
 * 出力: 画面に「有力」の一覧、data/analysis/combos-YYYY-MM-DD.md に全ての表
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../db/index';
import { gradeFromRaceName } from '../services/score-service';

const MIN_COUNT = 100;
const STRONG_Z = 3;
const JRA_VENUES = new Set(['札幌', '函館', '福島', '新潟', '東京', '中山', '中京', '京都', '阪神', '小倉']);

interface Run {
  horseId: string;
  date: string;
  venue: string;
  raceName: string;
  headcount: number | null;
  frame: number | null;
  winOdds: number | null;
  popularity: number | null;
  finish: number | null;
  jockeyId: string | null;
  surface: string | null;
  distance: number | null;
  condition: string | null;
  style: string | null;
  last3fRank: number | null;
  bodyDiff: number | null;
  carried: number | null;
}

/** 1走分の特徴（組み合わせの材料）。値が null の項目はその表に入れない */
type Features = Record<string, string | null>;

// ---------- 区分の作り方 ----------

/** クラス（新馬・未勝利・1勝・2勝・3勝・OP・G3・G2・G1）。旧表記（500万下など）も読む */
export function classOf(raceName: string): string | null {
  const g = gradeFromRaceName(raceName);
  if (g === 'G1' || g === 'G2' || g === 'G3') return g;
  if (g === 'L' || g === 'OP') return 'OP';
  const s = raceName.normalize('NFKC');
  if (s.includes('新馬')) return '新馬';
  if (s.includes('未勝利')) return '未勝利';
  if (/1勝|500万/.test(s)) return '1勝';
  if (/2勝|1000万/.test(s)) return '2勝';
  if (/3勝|1600万/.test(s)) return '3勝';
  if (s.includes('オープン')) return 'OP';
  return null;
}
const CLASS_RANK: Record<string, number> = { 新馬: 0, 未勝利: 0, '1勝': 1, '2勝': 2, '3勝': 3, OP: 4, G3: 5, G2: 6, G1: 7 };

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
export function intervalBand(days: number): string {
  if (days <= 7) return '連闘';
  if (days <= 21) return '中1〜2週';
  if (days <= 42) return '中3〜5週';
  if (days <= 69) return '中6〜9週';
  if (days <= 182) return '10週〜半年';
  return '半年以上';
}
function distBand(d: number): string {
  if (d <= 1400) return '〜1400m';
  if (d <= 1800) return '1500〜1800m';
  if (d <= 2200) return '1900〜2200m';
  if (d <= 2800) return '2300〜2800m';
  return '2900m〜';
}
function finishBand(f: number | null): string | null {
  if (f === null || f <= 0) return null;
  if (f === 1) return '前走1着';
  if (f <= 3) return '前走2〜3着';
  if (f <= 5) return '前走4〜5着';
  if (f <= 9) return '前走6〜9着';
  return '前走10着以下';
}
function popBand(p: number | null, prefix: string): string | null {
  if (p === null || p <= 0) return null;
  if (p === 1) return `${prefix}1番人気`;
  if (p <= 3) return `${prefix}2〜3番人気`;
  if (p <= 6) return `${prefix}4〜6番人気`;
  if (p <= 9) return `${prefix}7〜9番人気`;
  return `${prefix}10番人気以下`;
}
function bodyBand(d: number | null): string | null {
  if (d === null) return null;
  if (d <= -10) return '馬体重-10kg以下';
  if (d <= -4) return '馬体重-4〜-8kg';
  if (d <= 2) return '馬体重±2kg以内';
  if (d <= 8) return '馬体重+4〜+8kg';
  return '馬体重+10kg以上';
}
function carriedBand(diff: number): string {
  if (diff <= -2) return '斤量2kg以上減';
  if (diff < 0) return '斤量1kg減';
  if (diff === 0) return '斤量同じ';
  if (diff < 2) return '斤量1kg増';
  return '斤量2kg以上増';
}
function last3fBand(r: number | null): string | null {
  if (r === null || r <= 0) return null;
  if (r === 1) return '前走上がり1位';
  if (r <= 3) return '前走上がり2〜3位';
  return '前走上がり4位以下';
}
function frameBand(frame: number | null, headcount: number | null): string | null {
  if (!frame || !headcount || headcount < 8) return null;
  if (frame <= 2) return '内枠(1〜2枠)';
  if (frame <= 6) return '中枠(3〜6枠)';
  return '外枠(7〜8枠)';
}
function season(date: string): string {
  const m = Number(date.slice(5, 7));
  if (m >= 3 && m <= 5) return '春';
  if (m >= 6 && m <= 8) return '夏';
  if (m >= 9 && m <= 11) return '秋';
  return '冬';
}

/** 走（cur）と、その馬の1つ前の走（prev）から特徴を作る。prev は cur より前の日付の走だけ */
export function featuresOf(cur: Run, prev: Run | null, sex: string | null, sire: string | null): Features {
  const cls = classOf(cur.raceName);
  const birthYear = Number(cur.horseId.slice(0, 4));
  const age = birthYear > 1990 ? Number(cur.date.slice(0, 4)) - birthYear : null;
  const surf = cur.surface; // 「芝」「ダート」
  const f: Features = {
    クラス: cls,
    距離帯: cur.distance ? distBand(cur.distance) : null,
    コース: cur.distance && surf ? `${cur.venue}${surf}${cur.distance}m` : null,
    芝ダ: surf,
    枠: frameBand(cur.frame, cur.headcount),
    馬場: cur.condition,
    性齢: sex && age ? `${sex}${age >= 6 ? '6歳以上' : `${age}歳`}` : null,
    季節: season(cur.date),
    父: sire,
    馬体重: bodyBand(cur.bodyDiff),
    間隔: null, 距離変更: null, 前走着順: null, 前走人気: null, 前走上がり: null,
    前走脚質: null, 斤量増減: null, 乗り替わり: null, 昇級降級: null, 芝ダ替わり: null,
  };
  if (!prev) {
    f.間隔 = '初出走';
    return f;
  }
  f.間隔 = intervalBand(daysBetween(prev.date, cur.date));
  if (prev.distance && cur.distance) {
    const d = cur.distance - prev.distance;
    f.距離変更 = d >= 200 ? '距離延長' : d <= -200 ? '距離短縮' : '距離ほぼ同じ';
  }
  f.前走着順 = finishBand(prev.finish);
  f.前走人気 = popBand(prev.popularity, '前走');
  f.前走上がり = last3fBand(prev.last3fRank);
  f.前走脚質 = prev.style ? `前走${prev.style}` : null;
  if (prev.carried && cur.carried) f.斤量増減 = carriedBand(cur.carried - prev.carried);
  if (prev.jockeyId && cur.jockeyId) f.乗り替わり = prev.jockeyId === cur.jockeyId ? '同じ騎手' : '乗り替わり';
  const pc = classOf(prev.raceName);
  if (pc && cls && JRA_VENUES.has(prev.venue)) {
    const diff = CLASS_RANK[cls] - CLASS_RANK[pc];
    f.昇級降級 = diff > 0 ? '昇級' : diff < 0 ? '降級' : '同クラス';
  }
  if (prev.surface && cur.surface) f.芝ダ替わり = prev.surface === cur.surface ? '芝ダ同じ' : `${prev.surface}→${surf}`;
  return f;
}

/** 調べる組み合わせ。note = 調べる理由（ネットの分析記事などでよく使われる視点） */
export const COMBOS: { keys: string[]; note: string; dayOf?: boolean }[] = [
  { keys: ['間隔', 'クラス'], note: '休み明けが効くクラス・効かないクラス' },
  { keys: ['間隔', '距離帯'], note: '休み明けと距離（長距離ほど叩き良化型が多いと言われる）' },
  { keys: ['間隔', '馬体重'], note: '休み明けの馬体重の増減（太め残り・成長分）', dayOf: true },
  { keys: ['間隔', '性齢'], note: '休み明けと性・年齢' },
  { keys: ['距離変更', '前走着順'], note: '距離延長・短縮と前走の着順' },
  { keys: ['距離変更', '前走脚質'], note: '距離短縮の先行馬・延長の差し馬など' },
  { keys: ['前走着順', '前走人気'], note: '前走の人気と着順（人気薄の好走・人気馬の凡走からの巻き返し）' },
  { keys: ['前走上がり', '前走着順'], note: '前走で負けたが上がりは速かった馬' },
  { keys: ['枠', 'コース'], note: 'コースごとの枠の有利不利' },
  { keys: ['前走脚質', 'コース'], note: 'コースごとの脚質の有利不利（前走の脚質で代用）' },
  { keys: ['前走脚質', '芝ダ', '馬場'], note: '馬場状態と脚質', dayOf: true },
  { keys: ['斤量増減', 'クラス'], note: '前走からの斤量の増減（JRA-VANの重賞分析でよく使われる）' },
  { keys: ['乗り替わり', '前走着順'], note: '騎手が替わったときの成績' },
  { keys: ['昇級降級', '前走着順'], note: '昇級初戦・降級初戦' },
  { keys: ['芝ダ替わり', '前走着順'], note: '芝⇔ダートの替わり' },
  { keys: ['性齢', '季節'], note: '性・年齢と季節（夏は牝馬、など）' },
  { keys: ['性齢', 'クラス'], note: '若い馬・高齢馬のクラス別成績' },
  { keys: ['父', '芝ダ', '馬場'], note: '種牡馬と馬場状態（道悪の得意・不得意）', dayOf: true },
];

// ---------- 集計 ----------

interface Cell {
  n: number;
  win: number;
  top3: number;
  exp: number;
  variance: number;
  ret: number;
  firstHalf: { obs: number; exp: number };
  secondHalf: { obs: number; exp: number };
}
function newCell(): Cell {
  return { n: 0, win: 0, top3: 0, exp: 0, variance: 0, ret: 0, firstHalf: { obs: 0, exp: 0 }, secondHalf: { obs: 0, exp: 0 } };
}
export interface Row {
  combo: string;
  label: string;
  n: number;
  winRate: number;
  top3Rate: number;
  expRate: number;
  diff: number;
  z: number;
  consistent: boolean;
  winReturn: number;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function signed(x: number, digits = 1): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(digits)}`;
}

function main(): void {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf('--from');
  const from = fromIdx >= 0 && args[fromIdx + 1] ? args[fromIdx + 1] : '2016-01-01';
  const db = openDatabase();
  try {
    const t0 = Date.now();
    const rows = db
      .prepare(
        `SELECT horse_id, date, venue_name, race_name, headcount, frame_number, win_odds, popularity, finish_position,
                jockey_id, surface, distance, track_condition, running_style, last3f_rank, body_weight_diff, carried_weight
           FROM horse_runs ORDER BY horse_id, date`,
      )
      .iterate() as IterableIterator<Record<string, unknown>>;
    const sexOf = new Map<string, string>();
    for (const r of db
      .prepare(`SELECT netkeiba_horse_id AS id, sex FROM entries WHERE netkeiba_horse_id IS NOT NULL AND sex IS NOT NULL`)
      .all() as { id: string; sex: string }[]) {
      sexOf.set(r.id, r.sex);
    }
    const sireOf = new Map<string, string>();
    for (const r of db.prepare(`SELECT horse_id AS id, sire_name AS sire FROM horse_pedigree WHERE sire_name IS NOT NULL`).all() as {
      id: string;
      sire: string;
    }[]) {
      sireOf.set(r.id, r.sire);
    }

    // 1走ずつ、特徴と結果を作る
    type Sample = { f: Features; pop: number; heads: number; top3: boolean; win: boolean; odds: number | null; date: string };
    const samples: Sample[] = [];
    let prev: Run | null = null;
    for (const raw of rows) {
      const run: Run = {
        horseId: String(raw.horse_id),
        date: String(raw.date),
        venue: String(raw.venue_name ?? ''),
        raceName: String(raw.race_name ?? ''),
        headcount: (raw.headcount as number | null) ?? null,
        frame: (raw.frame_number as number | null) ?? null,
        winOdds: (raw.win_odds as number | null) ?? null,
        popularity: (raw.popularity as number | null) ?? null,
        finish: (raw.finish_position as number | null) ?? null,
        jockeyId: (raw.jockey_id as string | null) ?? null,
        surface: (raw.surface as string | null) ?? null,
        distance: (raw.distance as number | null) ?? null,
        condition: (raw.track_condition as string | null) ?? null,
        style: (raw.running_style as string | null) ?? null,
        last3fRank: (raw.last3f_rank as number | null) ?? null,
        bodyDiff: (raw.body_weight_diff as number | null) ?? null,
        carried: (raw.carried_weight as number | null) ?? null,
      };
      // 前の走は「同じ馬で、日付が前」のものだけ（同じ日の重複行は前走にしない）
      const p = prev && prev.horseId === run.horseId && prev.date < run.date ? prev : null;
      if (
        run.date >= from &&
        JRA_VENUES.has(run.venue) &&
        run.finish !== null && run.finish > 0 &&
        run.popularity !== null && run.popularity > 0 &&
        (run.surface === '芝' || run.surface === 'ダート')
      ) {
        samples.push({
          f: featuresOf(run, p, sexOf.get(run.horseId) ?? null, sireOf.get(run.horseId) ?? null),
          pop: run.popularity,
          heads: run.headcount ?? 0,
          top3: run.finish <= 3,
          win: run.finish === 1,
          odds: run.winOdds,
          date: run.date,
        });
      }
      if (!prev || prev.horseId !== run.horseId || prev.date < run.date) prev = run;
    }
    if (samples.length === 0) {
      console.log(`[Combo] ${from} 以降のJRAの走がありません`);
      return;
    }

    // 人気ごとの3着内率（期待値のもと）。頭数で3着内に入りやすさが違うため、頭数の帯ごとに分ける。10番人気以下はまとめる
    const headBand = (n: number) => (n <= 8 ? 0 : n <= 12 ? 1 : n <= 16 ? 2 : 3);
    const popKey = (p: number, n: number) => headBand(n) * 100 + Math.min(p, 10);
    const popStat = new Map<number, { n: number; top3: number }>();
    for (const s of samples) {
      const k = popKey(s.pop, s.heads);
      const st = popStat.get(k) ?? { n: 0, top3: 0 };
      st.n++;
      if (s.top3) st.top3++;
      popStat.set(k, st);
    }
    const popRate = (p: number, n: number) => {
      const st = popStat.get(popKey(p, n))!;
      return st.top3 / st.n;
    };
    const dates = samples.map((s) => s.date).sort();
    const midDate = dates[Math.floor(dates.length / 2)];
    const totalTop3 = samples.filter((s) => s.top3).length / samples.length;

    const all: Row[] = [];
    const sections: string[] = [];
    for (const combo of COMBOS) {
      const name = combo.keys.join('×') + (combo.dayOf ? '【当日】' : '');
      const cells = new Map<string, Cell>();
      for (const s of samples) {
        const vals = combo.keys.map((k) => s.f[k]);
        if (vals.some((v) => v === null || v === undefined)) continue;
        const label = vals.join('・');
        const c = cells.get(label) ?? newCell();
        const e = popRate(s.pop, s.heads);
        c.n++;
        if (s.win) c.win++;
        if (s.top3) c.top3++;
        c.exp += e;
        c.variance += e * (1 - e);
        if (s.win && s.odds) c.ret += s.odds;
        const half = s.date < midDate ? c.firstHalf : c.secondHalf;
        half.exp += e;
        if (s.top3) half.obs++;
        cells.set(label, c);
      }
      const rows: Row[] = [];
      for (const [label, c] of cells) {
        if (c.n < MIN_COUNT) continue;
        const diff = (c.top3 - c.exp) / c.n;
        const z = c.variance > 0 ? (c.top3 - c.exp) / Math.sqrt(c.variance) : 0;
        const d1 = c.firstHalf.obs - c.firstHalf.exp;
        const d2 = c.secondHalf.obs - c.secondHalf.exp;
        rows.push({
          combo: name,
          label,
          n: c.n,
          winRate: c.win / c.n,
          top3Rate: c.top3 / c.n,
          expRate: c.exp / c.n,
          diff,
          z,
          consistent: d1 !== 0 && d2 !== 0 && Math.sign(d1) === Math.sign(d2),
          winReturn: c.ret / c.n,
        });
      }
      rows.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
      all.push(...rows);
      const lines = [
        `## ${name}`,
        '',
        `${combo.note}。表示 ${rows.length} 区分（${MIN_COUNT}走以上）`,
        '',
        '| 区分 | 走数 | 勝率 | 3着内率 | 人気からの期待 | 差 | z | 前後一致 | 単回収 |',
        '|---|---:|---:|---:|---:|---:|---:|:-:|---:|',
        ...rows.map(
          (r) =>
            `| ${r.label} | ${r.n} | ${pct(r.winRate)} | ${pct(r.top3Rate)} | ${pct(r.expRate)} | ${signed(r.diff * 100)}pt | ${signed(r.z)} | ${r.consistent ? '○' : '×'} | ${Math.round(r.winReturn * 100)}% |`,
        ),
        '',
      ];
      sections.push(lines.join('\n'));
    }

    const strong = all.filter((r) => Math.abs(r.z) >= STRONG_Z && r.consistent).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    const header = [
      `# データの組み合わせ分析（${new Date().toISOString().slice(0, 10)}）`,
      '',
      `対象: ${from} 以降のJRAの走 ${samples.length.toLocaleString()} 走（前半・後半の境目 ${midDate}）。全体の3着内率 ${pct(totalTop3)}`,
      '',
      '差 = 実際の3着内率 − 人気から期待される3着内率。z が ±3 以上で、前半・後半で差の向きが同じものを「有力」としています。',
      '【当日】の付いた表は当日に分かる情報（馬場・馬体重）を使っているため、前日予想にはそのまま使えません。',
      '',
      `## 有力（${strong.length} 件）`,
      '',
      '| 組み合わせ | 区分 | 走数 | 3着内率 | 期待 | 差 | z |',
      '|---|---|---:|---:|---:|---:|---:|',
      ...strong.map((r) => `| ${r.combo} | ${r.label} | ${r.n} | ${pct(r.top3Rate)} | ${pct(r.expRate)} | ${signed(r.diff * 100)}pt | ${signed(r.z)} |`),
      '',
    ].join('\n');

    const outDir = path.join(process.cwd(), 'data', 'analysis');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `combos-${new Date().toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(outPath, header + '\n' + sections.join('\n'));

    console.log(`[Combo] 対象 ${samples.length.toLocaleString()} 走（${from} 以降・JRAのみ）・全体の3着内率 ${pct(totalTop3)}`);
    const filled = (k: string) => pct(samples.filter((x) => x.f[k] !== null && x.f[k] !== undefined).length / samples.length);
    console.log(`[Combo] 項目の埋まり具合: クラス ${filled('クラス')}・前走 ${filled('前走着順')}・性齢 ${filled('性齢')}・父 ${filled('父')}・前走上がり ${filled('前走上がり')}・馬体重 ${filled('馬体重')}`);
    console.log(`[Combo] 有力（z±${STRONG_Z}以上・前半後半で同じ向き）: ${strong.length} 件。上位30件:`);
    for (const r of strong.slice(0, 30)) {
      console.log(`  ${r.combo}｜${r.label}｜${r.n}走 3着内 ${pct(r.top3Rate)}（期待 ${pct(r.expRate)}・差 ${signed(r.diff * 100)}pt・z ${signed(r.z)}）`);
    }
    console.log(`[Combo] 全ての表: ${outPath}`);
    console.log(`[Combo] 所要 ${Math.round((Date.now() - t0) / 1000)}秒`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && /check-combos\.ts$/.test(process.argv[1])) main();
