# campus-info

SFC のキャンパス人数を Wi-Fi 接続数（DTC API）から数え、LightGBM で毎朝その日の30分ごとの人数を予報し、答え合わせを記録するサイトです。

- 本番: https://campus-info.lazyta-toru.net （このサイトについて: `/about`、実績の表: `/records`）
- 見本（ダミーデータ）と説明ページ: https://lazyturtle0852.github.io/campus-info/
- ためたデータ: `data` ブランチ（毎晩保存）

| 場所 | 中身 |
|---|---|
| `faapp_2.js` ほか | 画面と API。5分ごとの取得（`datastore.js`）、過去分の取り直し（`backfill.js`）、実績の表（`records.js`） |
| `ml/` | 学習用の表づくりと LightGBM。本番では `trainer` コンテナが毎朝4時に動かす（`ml/README.md`） |
| `compose.yaml` / `deploy/` | 本番の構成とデプロイ（`DEPLOY.md`） |
| `staticfile_public/` | 画面 |
| `scripts/build_pages.py` | GitHub Pages 用の見本サイトを組み立てる |
