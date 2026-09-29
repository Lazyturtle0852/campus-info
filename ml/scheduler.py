"""毎朝 RUN_AT（日本時間、既定 04:00）に run_daily.sh を流すだけの常駐プロセス。

cron をホストに置かずにコンテナの中で完結させるため。待っている間は pandas も
LightGBM も読み込まないので、メモリはほとんど使わない（学習は子プロセスで動く）。
起動時に RUN_ON_START=1 なら、まず1回流す（デプロイ直後の確認用）。
"""

from __future__ import annotations

import datetime as dt
import os
import subprocess
import time

TOKYO = dt.timezone(dt.timedelta(hours=9))
RUN_AT = os.environ.get("RUN_AT", "04:00")


def seconds_until_next_run(now: dt.datetime) -> float:
    hour, minute = (int(part) for part in RUN_AT.split(":"))
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += dt.timedelta(days=1)
    return (target - now).total_seconds()


def run() -> None:
    started = dt.datetime.now(TOKYO)
    print(f"[{started:%Y-%m-%d %H:%M}] 学習ジョブを始めます", flush=True)
    result = subprocess.run(["bash", "run_daily.sh"])
    print(f"[{dt.datetime.now(TOKYO):%Y-%m-%d %H:%M}] 終了（終了コード {result.returncode}）", flush=True)


def main() -> None:
    if os.environ.get("RUN_ON_START") == "1":
        run()
    while True:
        wait = seconds_until_next_run(dt.datetime.now(TOKYO))
        print(f"次は {wait / 3600:.1f} 時間後（{RUN_AT}）", flush=True)
        time.sleep(wait)
        run()


if __name__ == "__main__":
    main()
