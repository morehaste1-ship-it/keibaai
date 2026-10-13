/**
 * データベースの設計図（マイグレーション）
 *
 * 変更するときは既存の要素を書き換えず、配列の末尾に新しいバージョンを追加する。
 * 起動時に未適用のものだけが順番に実行される。
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      -- レース
      CREATE TABLE races (
        race_key        TEXT PRIMARY KEY,           -- YYYYMMDD-場コード-R
        date            TEXT NOT NULL,              -- YYYY-MM-DD
        venue_code      TEXT NOT NULL,
        venue_name      TEXT NOT NULL,
        race_no         INTEGER NOT NULL,
        name            TEXT NOT NULL,
        grade           TEXT,
        surface         TEXT NOT NULL,
        distance        INTEGER NOT NULL,
        course_variant  TEXT,
        turn            TEXT,
        weather         TEXT,
        track_condition TEXT,
        post_time       TEXT,
        headcount       INTEGER,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_races_date ON races(date);

      -- 馬
      CREATE TABLE horses (
        horse_key   TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        sex         TEXT,
        birth_year  INTEGER,
        sire        TEXT,
        dam         TEXT,
        dam_sire    TEXT,
        updated_at  TEXT NOT NULL
      );

      -- 出走馬（出馬表）
      CREATE TABLE entries (
        race_key          TEXT NOT NULL REFERENCES races(race_key) ON DELETE CASCADE,
        horse_key         TEXT NOT NULL REFERENCES horses(horse_key),
        horse_number      INTEGER,
        frame_number      INTEGER,
        horse_name        TEXT NOT NULL,
        sex               TEXT,
        age               INTEGER,
        jockey            TEXT,
        trainer           TEXT,
        carried_weight    REAL,
        body_weight       INTEGER,
        body_weight_diff  INTEGER,
        scratched         INTEGER NOT NULL DEFAULT 0,
        updated_at        TEXT NOT NULL,
        PRIMARY KEY (race_key, horse_key)
      );

      -- 単勝オッズ（時系列。取得のたびに行を追加し、上書きしない）
      CREATE TABLE win_odds (
        race_key      TEXT NOT NULL REFERENCES races(race_key) ON DELETE CASCADE,
        horse_number  INTEGER NOT NULL,
        win_odds      REAL,
        popularity    INTEGER,
        kind          TEXT NOT NULL,                -- final / live / forecast
        fetched_at    TEXT NOT NULL,
        PRIMARY KEY (race_key, horse_number, fetched_at)
      );

      -- 過去走
      CREATE TABLE past_results (
        horse_key        TEXT NOT NULL REFERENCES horses(horse_key),
        date             TEXT NOT NULL,
        venue_name       TEXT NOT NULL,
        race_name        TEXT NOT NULL,
        grade            TEXT,
        surface          TEXT,
        distance         INTEGER,
        track_condition  TEXT,
        weather          TEXT,
        headcount        INTEGER,
        horse_number     INTEGER,
        finish_position  INTEGER,
        finish_note      TEXT,
        popularity       INTEGER,
        win_odds         REAL,
        jockey           TEXT,
        carried_weight   REAL,
        time             TEXT,
        margin           TEXT,
        passing          TEXT,
        last3f           REAL,
        body_weight      INTEGER,
        updated_at       TEXT NOT NULL,
        PRIMARY KEY (horse_key, date, venue_name, race_name)
      );

      -- 推定値・派生指標（オッズ逆算などはここ。実データと混ぜない）
      CREATE TABLE entry_metrics (
        race_key      TEXT NOT NULL REFERENCES races(race_key) ON DELETE CASCADE,
        horse_key     TEXT NOT NULL REFERENCES horses(horse_key),
        metric        TEXT NOT NULL,
        value         REAL NOT NULL,
        is_estimated  INTEGER NOT NULL,
        method        TEXT NOT NULL,
        computed_at   TEXT NOT NULL,
        PRIMARY KEY (race_key, horse_key, metric)
      );

      -- 取得元IDと内部キーの対応表（netkeiba と JRA-VAN を併存させるため）
      CREATE TABLE source_ids (
        entity        TEXT NOT NULL,                -- race / horse
        internal_key  TEXT NOT NULL,
        source        TEXT NOT NULL,                -- netkeiba / jravan / manual
        source_id     TEXT NOT NULL,
        PRIMARY KEY (entity, source, source_id)
      );
      CREATE INDEX idx_source_ids_internal ON source_ids(entity, internal_key);

      -- 取得履歴（どのページをいつ取りに行き、結果どうだったか）
      CREATE TABLE fetch_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        url           TEXT NOT NULL,
        status        INTEGER,
        from_cache    INTEGER NOT NULL,
        error         TEXT,
        cache_file    TEXT,
        fetched_at    TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'entries_apprentice',
    sql: `
      -- 見習い騎手フラグ（騎手名の「▲」を別列に分離）
      ALTER TABLE entries ADD COLUMN apprentice INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 3,
    name: 'history_runs',
    sql: `
      -- 過去10年の同一レース結果（同じ競走名・会場・距離・馬場を1シリーズとして束ねる）
      CREATE TABLE history_runs (
        source_race_id   TEXT NOT NULL,              -- netkeiba のレースID（12桁）
        horse_number     INTEGER NOT NULL,
        series_key       TEXT NOT NULL,              -- 競走名正規化|会場|芝ダ|距離
        date             TEXT NOT NULL,              -- YYYY-MM-DD
        venue_name       TEXT NOT NULL,
        race_name        TEXT NOT NULL,
        surface          TEXT NOT NULL,
        distance         INTEGER NOT NULL,
        track_condition  TEXT,                       -- 良 / 稍重 / 重 / 不良（結果ページの馬場）
        headcount        INTEGER,
        horse_name       TEXT,
        finish_position  INTEGER,                    -- 着順（取消・除外などは null）
        finish_text      TEXT,                       -- 着順の元表記（中止・除外など）
        popularity       INTEGER,                    -- 人気
        win_odds         REAL,                       -- 確定単勝オッズ
        passing          TEXT,                       -- コーナー通過順の元表記（例: 2-2-1-1）
        corner4          INTEGER,                    -- 4コーナーの通過順位（何番手か）
        fetched_at       TEXT NOT NULL,
        PRIMARY KEY (source_race_id, horse_number)
      );
      CREATE INDEX idx_history_series ON history_runs(series_key);
    `,
  },
  {
    version: 4,
    name: 'jockeys_and_aliases',
    sql: `
      -- 出馬表の netkeiba 馬ID・騎手ID（騎手成績・馬の過去走の取得に使う）
      ALTER TABLE entries ADD COLUMN netkeiba_horse_id TEXT;
      ALTER TABLE entries ADD COLUMN jockey_id TEXT;

      -- 騎手
      CREATE TABLE jockeys (
        jockey_id   TEXT PRIMARY KEY,               -- netkeiba 騎手ID（5桁）
        name        TEXT,
        updated_at  TEXT NOT NULL
      );

      -- 騎手の騎乗成績（JRAのみ・過去5年分）
      CREATE TABLE jockey_runs (
        jockey_id        TEXT NOT NULL,
        race_id          TEXT NOT NULL,             -- netkeiba レースID（12桁）
        date             TEXT NOT NULL,             -- YYYY-MM-DD
        venue_name       TEXT,
        race_no          INTEGER,
        race_name        TEXT,
        headcount        INTEGER,
        frame_number     INTEGER,
        horse_number     INTEGER,
        win_odds         REAL,
        popularity       INTEGER,
        finish_position  INTEGER,
        finish_text      TEXT,
        horse_name       TEXT,
        horse_id         TEXT,
        surface          TEXT,                      -- 芝 / ダート / 障害
        distance         INTEGER,
        track_condition  TEXT,
        passing          TEXT,                      -- 通過順の元表記（例: 3-3-4）
        first_corner     INTEGER,                   -- 最初のコーナーの順位
        running_style    TEXT,                      -- 逃げ / 先行 / 差し / 追込（最初のコーナーで判定）
        fetched_at       TEXT NOT NULL,
        PRIMARY KEY (jockey_id, race_id)
      );
      CREATE INDEX idx_jockey_runs_date ON jockey_runs(jockey_id, date);

      -- 騎手成績の取得進捗（途中で止まっても続きから取得するため）
      CREATE TABLE jockey_crawl_state (
        jockey_id      TEXT PRIMARY KEY,
        newest_date    TEXT,                        -- 保存済みの最新日付
        backfill_page  INTEGER NOT NULL DEFAULT 1,  -- 過去分の次に読むページ
        backfill_done  INTEGER NOT NULL DEFAULT 0,  -- 5年前まで読み終えたか
        updated_at     TEXT NOT NULL
      );

      -- レース名の旧名対応表（過去10年分析で旧名の年も同じレースとして扱う）
      CREATE TABLE race_aliases (
        race_name   TEXT NOT NULL,                  -- 現在の競走名（例: アイルランドT）
        alias_name  TEXT NOT NULL,                  -- 旧名（例: 府中牝馬S）
        PRIMARY KEY (race_name, alias_name)
      );
      INSERT INTO race_aliases (race_name, alias_name) VALUES ('アイルランドT', '府中牝馬S');
    `,
  },
  {
    version: 5,
    name: 'remove_fuchu_himba_alias',
    sql: `
      -- 府中牝馬S（2023年以前は牝馬限定）はアイルランドTとは別のレースとして扱う
      DELETE FROM race_aliases WHERE race_name = 'アイルランドT' AND alias_name = '府中牝馬S';
      -- 旧名対応で アイルランドT のシリーズに保存された府中牝馬Sの結果を取り除く
      DELETE FROM history_runs WHERE series_key LIKE 'アイルランド%' AND race_name LIKE '府中牝馬%';
    `,
  },
  {
    version: 6,
    name: 'horse_runs',
    sql: `
      -- 馬の過去走（netkeiba 馬ID単位・JRAのみ）
      CREATE TABLE horse_runs (
        horse_id         TEXT NOT NULL,             -- netkeiba 馬ID（10桁）
        race_id          TEXT NOT NULL,
        date             TEXT NOT NULL,
        venue_name       TEXT,
        race_no          INTEGER,
        race_name        TEXT,
        headcount        INTEGER,
        frame_number     INTEGER,
        horse_number     INTEGER,
        win_odds         REAL,
        popularity       INTEGER,
        finish_position  INTEGER,
        finish_text      TEXT,
        jockey_id        TEXT,
        jockey_name      TEXT,
        surface          TEXT,
        distance         INTEGER,
        track_condition  TEXT,
        passing          TEXT,
        first_corner     INTEGER,
        running_style    TEXT,                      -- 逃げ / 先行 / 差し / 追込（最初のコーナーで判定）
        last3f           REAL,
        fetched_at       TEXT NOT NULL,
        PRIMARY KEY (horse_id, race_id)
      );
      CREATE INDEX idx_horse_runs_date ON horse_runs(horse_id, date);

      -- 馬ごとの最終取得日時（同じ週に何度も読まないため）
      CREATE TABLE horse_crawl_state (
        horse_id    TEXT PRIMARY KEY,
        horse_name  TEXT,
        fetched_at  TEXT NOT NULL
      );
    `,
  },
  {
    version: 7,
    name: 'pedigree_and_body_weight',
    sql: `
      -- 過去走の馬体重（前走からの増減の計算に使う）
      ALTER TABLE horse_runs ADD COLUMN body_weight INTEGER;
      ALTER TABLE horse_runs ADD COLUMN body_weight_diff INTEGER;

      -- 血統（父・母・母の父）
      CREATE TABLE horse_pedigree (
        horse_id    TEXT PRIMARY KEY,
        sire_id     TEXT,
        sire_name   TEXT,
        dam_name    TEXT,
        bms_id      TEXT,
        bms_name    TEXT,
        fetched_at  TEXT NOT NULL
      );

      -- 種牡馬の産駒成績（累計。父として / 母の父として）
      CREATE TABLE sire_stats (
        sire_id   TEXT NOT NULL,
        role      TEXT NOT NULL,             -- sire / bms
        surface   TEXT NOT NULL,             -- 芝 / ダート / 障害
        kind      TEXT NOT NULL,             -- distance / condition
        bucket    TEXT NOT NULL,             -- -1400 / -1800 / -2200 / -2600 / 2600- / 良 / 稍重 / 重 / 不良
        first     INTEGER NOT NULL,
        second    INTEGER NOT NULL,
        third     INTEGER NOT NULL,
        other     INTEGER NOT NULL,
        PRIMARY KEY (sire_id, role, surface, kind, bucket)
      );
      CREATE TABLE sire_stats_state (
        sire_id     TEXT PRIMARY KEY,
        fetched_at  TEXT NOT NULL
      );
    `,
  },
  {
    version: 8,
    name: 'prediction_review',
    sql: `
      -- 答え合わせ用：記録した予想（auto = 12時の自動記録・既定の配分、manual = 画面のボタン）
      CREATE TABLE prediction_records (
        race_key       TEXT NOT NULL,
        source         TEXT NOT NULL,            -- auto / manual
        recorded_at    TEXT NOT NULL,
        settings_json  TEXT NOT NULL,            -- 配分・補正の強さ・データ不足の扱い・馬場
        marks_json     TEXT NOT NULL,            -- 馬ごとの印・順位・合計点・人気
        plans_json     TEXT NOT NULL,            -- 3連単（本命・中穴・大穴）の買い目
        PRIMARY KEY (race_key, source)
      );

      -- 答え合わせ用：確定した結果（着順と3連単の払戻）
      CREATE TABLE race_outcomes (
        race_key       TEXT PRIMARY KEY,
        finishes_json  TEXT NOT NULL,
        trifecta_json  TEXT NOT NULL,
        fetched_at     TEXT NOT NULL
      );
    `,
  },
  {
    version: 9,
    name: 'outcome_all_payouts',
    sql: `
      -- 答え合わせ用：3連単以外も含む全券種の払戻（単勝・複勝・ワイド・馬連・馬単・3連複・3連単）
      ALTER TABLE race_outcomes ADD COLUMN payouts_json TEXT;
    `,
  },
  {
    version: 10,
    name: 'outcome_meta',
    sql: `
      -- 答え合わせ用：レースのペース・頭数など（予想とのずれの分析に使う）
      ALTER TABLE race_outcomes ADD COLUMN meta_json TEXT;
    `,
  },
  {
    version: 11,
    name: 'horse_runs_last3f_rank',
    sql: `
      -- 過去走の上がり順位（1〜3 = 上がり3位以内、0 = 4位以下、NULL = 不明）。「末脚」の点数に使う
      ALTER TABLE horse_runs ADD COLUMN last3f_rank INTEGER;
    `,
  },
  {
    version: 12,
    name: 'past_races',
    sql: `
      -- 過去レースの取り込み（検証用）：開催の有無を確認した日
      CREATE TABLE past_dates (
        date        TEXT PRIMARY KEY,               -- YYYY-MM-DD
        race_count  INTEGER NOT NULL,               -- その日のレース数（0 = 開催なし）
        checked_at  TEXT NOT NULL
      );

      -- 過去レースの取り込み状況（imported = 出馬表・結果・確定オッズを保存済み、predicted = 検証用の予想を記録済み、failed = 取り込めなかった）
      CREATE TABLE past_races (
        race_key        TEXT PRIMARY KEY,
        status          TEXT NOT NULL,
        horse_attempts  INTEGER NOT NULL DEFAULT 0,  -- 出走馬の過去走の取得を試みた回数（2回で、取れない馬があっても予想する）
        message         TEXT,
        updated_at      TEXT NOT NULL
      );
    `,
  },
  {
    version: 13,
    name: 'weight_versions',
    sql: `
      -- 配分の自動見直し：採用した配分の履歴（最新の行が採用中。行が無ければ既定の配分）
      CREATE TABLE weight_versions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        weights_json  TEXT NOT NULL,
        reason        TEXT NOT NULL,                -- auto = 自動見直し、revert = 1つ前に戻す など
        note          TEXT,                         -- 画面に出す説明
        metrics_json  TEXT,                         -- 見直し時の成績（学習用・確認用の当たり具合）
        adopted_at    TEXT NOT NULL
      );
    `,
  },
  {
    version: 14,
    name: 'horse_runs_time_margin',
    sql: `
      -- 過去走の走破タイム・着差・斤量・前後半3F（着差・スピード指数の項目に使う。追加前に取得した走は NULL）
      ALTER TABLE horse_runs ADD COLUMN time_sec REAL;        -- 走破タイム（秒）
      ALTER TABLE horse_runs ADD COLUMN margin_sec REAL;      -- 着差（秒。勝ち馬は2着との差をマイナスで）
      ALTER TABLE horse_runs ADD COLUMN carried_weight REAL;  -- 斤量（kg）
      ALTER TABLE horse_runs ADD COLUMN pace_front REAL;      -- レースの前半3F（秒）
      ALTER TABLE horse_runs ADD COLUMN pace_back REAL;       -- レースの後半3F（秒）
    `,
  },
  {
    version: 15,
    name: 'horse_runs_course_index',
    sql: `
      -- スピード指数の基準タイム（コース・距離・馬場ごとの3着以内の走破タイム）を速く集計するための索引（データは変えない）
      CREATE INDEX IF NOT EXISTS idx_horse_runs_course ON horse_runs (surface, distance, venue_name, track_condition, date);
    `,
  },
];
