# キャンパス人数予報（勾配ブースティング）

サーバーがためた生データから学習用の表を作り、LightGBM で学習して、比べる相手と並べて評価する。
考え方は `/mlstrategy`（`staticfile_public/mlstrategy.html`）を参照。

## サーバーがためているもの（`CROWD_DATA_DIR` の下）

| ファイル | 中身 | 書く処理 |
|---|---|---|
| `crowd_snapshots.csv` | 5分ごとのキャンパス全体の端末数（正解 y の元） | `faapp_2.js` |
| `building_readings.csv` | 5分ごとの建物ごとの端末数 | `datastore.js` |
| `lecture_snapshots/YYYY-MM-DD.json` | その日の時間割と学事暦（毎日 06:00 と 21:00 に保存） | `datastore.js` |
| `lectures/YYYY-MM-DD.json` | 以前の予報（M7、削除済み）がキャッシュした時間割。あれば補助に使う | — |

## 本番での動き

VPS では `trainer` コンテナ（`ml/Dockerfile`）が常駐し、`scheduler.py` が毎朝 04:00 に `run_daily.sh` を動かします。
`run_daily.sh` は `build_table.py` → `train.py` を実行して `/data/ml`（サーバーと共有の Volume）に書き、成否を healthchecks.io（`HC_TRAIN_URL`）に知らせます。
その朝の予報は `predictions_log.csv` にためられ、`/records` で実測と並べて表示されます。

## 使い方（手元）

```bash
cd ml
uv sync                      # 初回だけ。macOS では brew install libomp も必要

# 本番のデータを手元へコピー（Docker の場合）
docker compose cp dashboard:/app/data ./data-snapshot

# 1. 学習用の表を作る（1行 = 1日 × 30分枠）
uv run python build_table.py --data-dir ./data-snapshot \
    --classrooms ../private-data/kyousitu_size.json

# 2. 学習して評価し、今日以降を予報する
uv run python train.py
```

## 出力（`ml/output/`）

| ファイル | 中身 |
|---|---|
| `training_table.csv` | 学習用の表。説明変数 x01〜x16、目的変数 `y_people`、30分枠に入った5分データの数 `y_samples` |
| `eval_by_week.csv` / `eval_summary.md` | 週ごとの評価（その週より前で学習し、その週で評価）。実測との差の絶対値の平均（人） |
| `model_A.txt` / `model_B.txt` | 全データで学習し直した LightGBM のモデル |
| `importance_A.csv` / `importance_B.csv` | どの説明変数がどれだけ効いたか |
| `predictions.csv` | 今日以降の予報 |

## 説明変数

| 列 | 中身 |
|---|---|
| `x01_time_min` | 30分枠の開始時刻（分） |
| `x02_p1`〜`x08_p7` | その日の1〜7限の推定履修人数（教室定員 × 推定履修率 0.7。定員不明は50人） |
| `x09_dow` | 曜日（代替授業日は時間割上の曜日）。カテゴリ |
| `x10_week` | 学期の何週目か。授業のない日は空 |
| `x11_day_type` | `normal` / `substitute`（代替授業日）/ `closed`。カテゴリ |
| `x12_active`〜`x16_active_p60` | B で足す、時刻に合わせた履修人数（その枠、30分前、1時間前、30分後、1時間後） |

## 比べる相手

- `prev_week`：先週の同じ曜日・同じ時刻の実測
- `dow_time_mean`：学習期間の「日の種類 × 曜日 × 時刻」の平均
- `lgbm_A`：x01〜x11（完全におまかせ）
- `lgbm_B`：A ＋ x12〜x16

時間割は毎週ほぼ同じなので、`dow_time_mean` に勝てるかが最大の関門。
架空データでの動作確認（10/1〜11/13、時間割は本物・人数は架空）では、`dow_time_mean` ±34人、`lgbm_B` ±39人、`lgbm_A` ±41人、`prev_week` ±52人だった。
