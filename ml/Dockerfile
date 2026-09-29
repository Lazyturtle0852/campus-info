# 毎朝の学習ジョブ（build_table.py → train.py）を動かすコンテナ。
# 待機中は scheduler.py だけが動き、学習の間だけ pandas / LightGBM を読み込む。
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Tokyo

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY build_table.py train.py run_daily.sh scheduler.py ./

# サーバー（node ユーザー、uid 1000）と同じ持ち主で /data/ml に書く
RUN useradd --uid 1000 --create-home trainer
USER trainer

CMD ["python", "scheduler.py"]
