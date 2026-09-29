#!/usr/bin/env bash
# 本番（VPS の /opt/campus-info）を最新にする。
#
# GitHub Actions（.github/workflows/deploy.yml）が SSH で呼ぶ。デプロイ用の鍵は
# authorized_keys の command= でこのスクリプトしか動かせないようにしてある（DEPLOY.md）。
#
# 標準入力には、GitHub Secrets から組み立てた次の行が来る（無ければ今あるものを使う）。
#   CLASSROOMS_B64=<教室定員 JSON を base64 にしたもの>（任意。DTC API に定員は無い）
#   HC_COLLECT_URL=<healthchecks.io の URL（取得）>
#   HC_TRAIN_URL=<healthchecks.io の URL（学習）>
#   ACTION=train   … デプロイの代わりに、朝の学習ジョブをいますぐ1回動かす（.github/workflows/train.yml）
#
# 全体を main() に入れてあるのは、途中の git reset がこのファイル自身を書き換えるため
# （bash は読みながら実行するので、関数にしておかないとずれた位置から読み直す）。
set -euo pipefail

main() {
  cd "$(dirname "$0")/.."

  # まずコードを main にそろえ、そろえた後の update.sh で続きを動かす
  # （このスクリプト自身の変更も、その回のデプロイから効くようにする）。
  if [ -z "${CAMPUS_INFO_UPDATED:-}" ]; then
    local saved
    saved="$(mktemp)"
    if [ ! -t 0 ]; then
      cat > "$saved"
    fi
    echo "==> コードを main にそろえる"
    git fetch --quiet origin main
    git reset --hard --quiet origin/main
    git log -1 --format='    %h %s'
    CAMPUS_INFO_UPDATED=1 exec bash deploy/update.sh < "$saved"
  fi

  echo "==> 設定を受け取る"
  local input
  input="$(mktemp)"
  trap 'rm -f "${input:-}"' EXIT
  cat > "$input"

  mkdir -p private-data
  local classrooms
  classrooms="$(sed -n 's/^CLASSROOMS_B64=//p' "$input" | tr -d '[:space:]')"
  if [ -n "$classrooms" ]; then
    printf '%s' "$classrooms" | base64 -d > private-data/kyousitu_size.json.tmp
    # 壊れた JSON で置き換えてサーバーが起動できなくなるのを防ぐ
    python3 -c 'import json,sys; json.load(open(sys.argv[1]))' private-data/kyousitu_size.json.tmp
    mv private-data/kyousitu_size.json.tmp private-data/kyousitu_size.json
    echo "    教室定員を更新しました"
  fi
  if [ ! -f private-data/kyousitu_size.json ]; then
    echo "    教室定員のファイルは無し（どの教室も既定の定員で数えます）"
  fi

  if grep -qE '^HC_(COLLECT|TRAIN)_URL=' "$input"; then
    grep -E '^HC_(COLLECT|TRAIN)_URL=' "$input" > .env.tmp
    mv .env.tmp .env
    chmod 600 .env
    echo "    .env を更新しました"
  fi

  if grep -qx 'ACTION=train' "$input"; then
    echo "==> 学習ジョブをいますぐ動かす"
    docker compose exec -T trainer bash run_daily.sh
    docker compose exec -T trainer cat /data/ml/last_run.json
    return 0
  fi

  echo "==> コンテナを作り直す"
  docker compose up -d --build --remove-orphans
  docker image prune -f > /dev/null

  echo "==> 確認"
  local port
  port="$(grep -E '^APP_PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
  port="${port:-3021}"
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/api/status"; then
      curl -fsS "http://127.0.0.1:$port/api/status" | head -c 400; echo
      docker compose ps --format '    {{.Name}}  {{.Status}}'
      return 0
    fi
    sleep 2
  done
  echo "サーバーが応答しません" >&2
  docker compose logs --tail 50 dashboard >&2
  exit 1
}

main "$@"
