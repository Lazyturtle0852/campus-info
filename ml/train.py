"""学習用の表から勾配ブースティングを学習し、比べる相手と並べて評価する。

評価は日付で区切る：週ごとに「その週より前のデータで学習 → その週で評価」を繰り返す。
比べる相手
  prev_week      先週の同じ曜日・同じ時刻の実測
  dow_time_mean  学習期間の「日の種類 × 曜日 × 時刻」の平均
  lgbm_A         説明変数 x01〜x11（完全におまかせ）
  lgbm_B         A ＋ x12〜x16（時刻に合わせた履修人数）

最後に正解のある全行で学習し直し、正解のない（未来の）行を予報する。
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

FEATURES_A = [
    "x01_time_min", "x02_p1", "x03_p2", "x04_p3", "x05_p4", "x06_p5", "x07_p6", "x08_p7",
    "x09_dow", "x10_week", "x11_day_type",
]
FEATURES_B = FEATURES_A + ["x12_active", "x13_active_m30", "x14_active_m60", "x15_active_p30", "x16_active_p60"]
CATEGORICAL = ["x09_dow", "x11_day_type"]
MIN_SAMPLES = 3  # 30分枠に5分データが3つ以上ある行だけを正解として使う
MODELS = ["prev_week", "dow_time_mean", "lgbm_A", "lgbm_B"]


def load(path: str) -> pd.DataFrame:
    table = pd.read_csv(path, dtype={"x09_dow": str})
    table["date"] = pd.to_datetime(table["date"])
    for col in CATEGORICAL:
        table[col] = table[col].astype("category")
    return table


def lgbm(seed: int = 0) -> lgb.LGBMRegressor:
    # データが少ないうちは木を小さく、葉あたりの行数を多めにして過学習を抑える
    return lgb.LGBMRegressor(
        objective="l1",
        n_estimators=400,
        learning_rate=0.05,
        num_leaves=15,
        min_child_samples=10,
        subsample=0.9,
        subsample_freq=1,
        colsample_bytree=0.9,
        random_state=seed,
        verbose=-1,
    )


def predict_prev_week(train: pd.DataFrame, test: pd.DataFrame) -> np.ndarray:
    ref = train.set_index(["date", "x01_time_min"])["y_people"]
    keys = list(zip(test["date"] - pd.Timedelta(days=7), test["x01_time_min"]))
    return np.array([ref.get(k, np.nan) for k in keys], dtype=float)


def predict_dow_time_mean(train: pd.DataFrame, test: pd.DataFrame) -> np.ndarray:
    # 授業のある日とない日を混ぜないよう、日の種類でも分けて平均する
    full = train.groupby(["x11_day_type", "x09_dow", "x01_time_min"], observed=True)["y_people"].mean()
    by_type = train.groupby(["x11_day_type", "x01_time_min"], observed=True)["y_people"].mean()
    by_time = train.groupby("x01_time_min")["y_people"].mean()
    out = []
    for kind, dow, t in zip(test["x11_day_type"], test["x09_dow"], test["x01_time_min"]):
        out.append(full.get((kind, dow, t), by_type.get((kind, t), by_time.get(t, np.nan))))
    return np.array(out, dtype=float)


def fit_predict(features, train, test):
    model = lgbm()
    model.fit(train[features], train["y_people"], categorical_feature=CATEGORICAL)
    return model.predict(test[features]), model


def evaluate(labeled: pd.DataFrame, min_train_days: int) -> pd.DataFrame:
    labeled = labeled.copy()
    labeled["week_start"] = labeled["date"] - pd.to_timedelta(labeled["date"].dt.weekday, unit="D")
    rows = []
    for week in sorted(labeled["week_start"].unique()):
        train = labeled[labeled["date"] < week]
        test = labeled[labeled["week_start"] == week]
        if train["date"].nunique() < min_train_days or test.empty:
            continue
        preds = {
            "prev_week": predict_prev_week(train, test),
            "dow_time_mean": predict_dow_time_mean(train, test),
            "lgbm_A": fit_predict(FEATURES_A, train, test)[0],
            "lgbm_B": fit_predict(FEATURES_B, train, test)[0],
        }
        y = test["y_people"].to_numpy()
        # 全モデルが予測を出せた行だけで比べる（先週の値が無い行は除く）
        common = np.all([~np.isnan(p) for p in preds.values()], axis=0)
        if not common.any():
            continue
        row = {
            "week_start": pd.Timestamp(week).date(),
            "train_days": train["date"].nunique(),
            "test_rows": int(common.sum()),
        }
        for name, p in preds.items():
            row[name] = float(np.mean(np.abs(y[common] - p[common])))
        rows.append(row)
    return pd.DataFrame(rows)


def markdown_table(df: pd.DataFrame) -> str:
    header = "| " + " | ".join(df.columns) + " |"
    rule = "| " + " | ".join("---" for _ in df.columns) + " |"
    body = ["| " + " | ".join(str(v) for v in row) + " |" for row in df.itertuples(index=False)]
    return "\n".join([header, rule] + body)


def write_atomic(path: Path, write) -> None:
    """書きかけのファイルをサーバーが読まないよう、一時ファイルに書いてから置き換える。"""
    tmp = path.with_name(path.name + ".tmp")
    write(tmp)
    os.replace(tmp, path)


def append_prediction_log(out_dir: Path, today_rows: pd.DataFrame, issued_at: str) -> None:
    """その朝に出した当日の予報をためる。同じ日の分は出し直したもので置き換える。"""
    path = out_dir / "predictions_log.csv"
    rows = today_rows.copy()
    rows.insert(2, "issued_at", issued_at)
    if path.exists():
        old = pd.read_csv(path, dtype=str)
        old = old[~old["date"].isin(rows["date"].unique())]
        rows = pd.concat([old, rows.astype(str)], ignore_index=True)
    rows = rows.sort_values(["date", "bin_start"])
    write_atomic(path, lambda p: rows.to_csv(p, index=False))


def write_last_run(out_dir: Path, info: dict) -> None:
    info = {"finishedAt": pd.Timestamp.now(tz="UTC").isoformat(), **info}
    write_atomic(out_dir / "last_run.json", lambda p: p.write_text(json.dumps(info, ensure_ascii=False, indent=2)))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--table", default="output/training_table.csv")
    parser.add_argument("--out-dir", default="output")
    parser.add_argument("--min-train-days", type=int, default=5, help="評価を始めるのに必要な学習日数")
    parser.add_argument("--today", default=None, help="この日以降を予報する（既定は日本時間の今日）")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    table = load(args.table)
    labeled = table[(table["y_samples"] >= MIN_SAMPLES) & table["y_people"].notna()]
    today = pd.Timestamp(args.today or pd.Timestamp.now(tz="Asia/Tokyo").strftime("%Y-%m-%d"))
    future = table[table["date"] >= today]
    labeled = labeled[labeled["date"] < today]
    print(f"正解のある行: {len(labeled)}行（{labeled['date'].nunique()}日）、"
          f"予報する行: {len(future)}行（{today.date()} 以降）")
    if labeled["date"].nunique() < args.min_train_days:
        print(f"学習できる日が {args.min_train_days} 日に届いていません。データがたまるのを待ってください。")
        write_last_run(out_dir, {"status": "skipped", "labeledDays": int(labeled["date"].nunique())})
        return

    # 1. 週ごとの評価
    report = evaluate(labeled, args.min_train_days)
    report.to_csv(out_dir / "eval_by_week.csv", index=False)
    if report.empty:
        print("評価できる週がまだありません（学習用の週と評価用の週の両方が要ります）。")
    else:
        total = report["test_rows"].sum()
        summary = {m: float((report[m] * report["test_rows"]).sum() / total) for m in MODELS}
        lines = ["# 評価（実測との差の絶対値の平均・人）", "", markdown_table(report.round(1)), "",
                 "## 全期間", ""]
        for m in sorted(summary, key=summary.get):
            lines.append(f"- {m}: ±{summary[m]:.1f}人")
        (out_dir / "eval_summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
        print("\n".join(lines))

    # 2. 全データで学習し直し、未来の行を予報
    predictions = future[["date", "bin_start"]].copy()
    for name, features in (("A", FEATURES_A), ("B", FEATURES_B)):
        model = lgbm()
        model.fit(labeled[features], labeled["y_people"], categorical_feature=CATEGORICAL)
        model.booster_.save_model(str(out_dir / f"model_{name}.txt"))
        importance = pd.Series(model.booster_.feature_importance("gain"), index=features)
        (importance / importance.sum()).sort_values(ascending=False).round(3).to_csv(
            out_dir / f"importance_{name}.csv", header=["share"]
        )
        if not future.empty:
            predictions[f"pred_{name}"] = model.predict(future[features]).round(0)
    predictions["pred_dow_mean"] = predict_dow_time_mean(labeled, future).round(0)
    predictions["date"] = predictions["date"].dt.strftime("%Y-%m-%d")
    write_atomic(out_dir / "predictions.csv", lambda p: predictions.to_csv(p, index=False))

    # その日の答え合わせ用に、当日の予報だけを記録としてためる
    issued_at = pd.Timestamp.now(tz="UTC").isoformat()
    todays = predictions[predictions["date"] == today.strftime("%Y-%m-%d")]
    if not todays.empty:
        append_prediction_log(out_dir, todays, issued_at)
    write_last_run(out_dir, {
        "status": "ok",
        "labeledDays": int(labeled["date"].nunique()),
        "labeledRows": int(len(labeled)),
        "predictedToday": int(len(todays)),
    })
    print(f"\nモデルと予報を書き出しました: {out_dir}/model_A.txt, model_B.txt, predictions.csv, predictions_log.csv")


if __name__ == "__main__":
    main()
