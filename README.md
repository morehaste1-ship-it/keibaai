<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/08db5fe8-32a1-4b13-943f-9c047e8d5b45

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## DB のバックアップと戻し方

- 夜間実行（毎日1:00）の最初に、`data/backup/keiba-YYYYMMDD.sqlite` へ自動でバックアップします（直近7日分を残し、古いものは自動で削除）。
- 手動で取る場合：`cd ~/keibaai && npm run backup`
- 戻し方（例：10月12日の状態に戻す）
  1. サーバーを起動したウィンドウで Ctrl+C を押して止める（夜間実行の最中は避ける）
  2. 今の DB を念のため別名で残す：`cd ~/keibaai/data && mv -n keiba.sqlite keiba-before-restore.sqlite && rm -f keiba.sqlite-wal keiba.sqlite-shm`
  3. バックアップをコピーする：`cp backup/keiba-20261012.sqlite keiba.sqlite`
  4. `keibaai-start.command` で起動し直す
- Google ドライブへの写し：rclone に「gdrive」という接続を作っておくと、夜間実行（と `npm run backup`）のたびに、バックアップを Google ドライブの `KeibaAI-backup` フォルダへも送ります（直近3日分）。rclone が無い・未設定のときは送らずにログに残します。送らないようにするには `KEIBA_OFFSITE_REMOTE=off`
- Mac が壊れたなどで Google ドライブから戻す場合：ブラウザで Google ドライブの `KeibaAI-backup` から `keiba-日付.sqlite` をダウンロードし、上の手順3の `backup/keiba-20261012.sqlite` の代わりに使う
- 注意：容量を空けるときも `data/keiba.sqlite` と `data/backup` は消さない
