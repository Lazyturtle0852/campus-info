#!/usr/bin/env bash
# 本番（VPS の /opt/campus-info）を最新にする。
#
# GitHub Actions（.github/workflows/deploy.yml）が SSH で呼ぶ。デプロイ用の鍵は
# authorized_keys の command= でこのスクリプトしか動かせないようにしてある（DEPLOY.md）。
#
# 標準入力には、GitHub Secrets から組み立てた次の行が来る（無ければ今あるものを使う）。
#   CLASSROOMS_B64=<教室定員 JSON を base64 にしたもの>
#   HC_COLLECT_URL=<healthchecks.io の URL（取得）>
#   HC_TRAIN_URL=<healthchecks.io の URL（学習）>
#
# 全体を main() に入れてあるのは、途中の git reset がこのファイル自身を書き換えるため
# （bash は読みながら実行するので、関数にしておかないとずれた位置から読み直す）。
set -euo pipefail

main() {
  cd "$(dirname "$0")/.."

  echo "==> 設定を受け取る"
  local input
  input="$(mktemp)"
  trap 'rm -f "$input"' EXIT
  if [ ! -t 0 ]; then
    cat > "$input"
  fi

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
    echo "private-data/kyousitu_size.json がありません（Secrets の CLASSROOMS_B64 を確認）" >&2
    exit 1
  fi

  if grep -qE '^HC_(COLLECT|TRAIN)_URL=' "$input"; then
    grep -E '^HC_(COLLECT|TRAIN)_URL=' "$input" > .env.tmp
    mv .env.tmp .env
    chmod 600 .env
    echo "    .env を更新しました"
  fi

  echo "==> コードを main にそろえる"
  git fetch --quiet origin main
  git reset --hard --quiet origin/main
  git log -1 --format='    %h %s'

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
