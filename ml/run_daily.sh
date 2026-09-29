#!/usr/bin/env bash
# 毎朝の学習ジョブ本体。scheduler.py から呼ばれる（手で1回だけ流すときも同じ）。
#   1. サーバーがためた生データ（/data）から学習用の表を作る
#   2. LightGBM を学習し直して、今日の予報を出す（/data/ml に書く）
# 成否は healthchecks.io（HC_TRAIN_URL）に知らせる。
set -uo pipefail

DATA_DIR="${DATA_DIR:-/data}"
OUT_DIR="$DATA_DIR/ml"
CLASSROOMS="${CLASSROOMS_PATH:-/private-data/kyousitu_size.json}"

ping_hc() {
  [ -n "${HC_TRAIN_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 -X POST "${HC_TRAIN_URL%/}$1" > /dev/null || true
}

mkdir -p "$OUT_DIR"
ping_hc /start

classroom_args=()
if [ -f "$CLASSROOMS" ]; then
  classroom_args=(--classrooms "$CLASSROOMS")
else
  echo "教室定員の JSON が無いので、定員はすべて既定値で計算します: $CLASSROOMS"
fi

if python build_table.py --data-dir "$DATA_DIR" "${classroom_args[@]}" --out "$OUT_DIR/training_table.csv" \
   && python train.py --table "$OUT_DIR/training_table.csv" --out-dir "$OUT_DIR"; then
  ping_hc ""
else
  status=$?
  printf '{"finishedAt": "%s", "status": "failed", "exitCode": %d}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status" > "$OUT_DIR/last_run.json"
  ping_hc /fail
  exit "$status"
fi
