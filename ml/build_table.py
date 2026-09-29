"""学習用の表（1行 = 1日 × 30分枠）を、サーバーがためた生データから組み立てる。

入力（--data-dir の下）
  crowd_snapshots.csv   5分ごとのキャンパス全体の端末数（正解 y の元）
  lecture_snapshots/    その日に取得した時間割と学事暦（説明変数 x の元）
  lectures/             予報用にキャッシュした時間割（lecture_snapshots が無い日の代わり）

出力
  説明変数 x01〜x11（おまかせ A）、x12〜x16（B で足す、時刻に合わせた履修人数）、
  目的変数 y_people と、その30分枠に入った5分データの数 y_samples。
  未来の日は y が空の行になる（予報に使う）。
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path

import pandas as pd

BIN_MINUTES = 30
BINS = list(range(7 * 60, 22 * 60, BIN_MINUTES))  # 7:00〜21:30
PERIODS = range(1, 8)
ROOM_ALIASES = {"θ": "θ館"}


def normalize_room(name):
    if not isinstance(name, str):
        return None
    name = unicodedata.normalize("NFKC", name).strip()
    if not name:
        return None
    return ROOM_ALIASES.get(name, name)


def room_names(course: dict) -> list[str]:
    """faapp_2.js / forecast.js の getRoomNames と同じ規則。"""
    classroom = course.get("classroom") or {}
    rooms = [normalize_room(loc.get("room")) for loc in classroom.get("locations") or []]
    rooms = [r for r in rooms if r]
    if rooms:
        return list(dict.fromkeys(rooms))
    raw = classroom.get("raw")
    if not isinstance(raw, str):
        return []
    parts = [normalize_room(p) for p in re.split(r"[、,，/／・\s]+", raw)]
    return list(dict.fromkeys(p for p in parts if p))


def load_lectures(data_dir: Path) -> dict[str, tuple[dict, str]]:
    """日付 → (授業APIの中身, 出どころ)。lecture_snapshots を優先する。"""
    result: dict[str, tuple[dict, str]] = {}
    for sub, source in (("lectures", "forecast_cache"), ("lecture_snapshots", "daily_snapshot")):
        folder = data_dir / sub
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*.json")):
            body = json.loads(path.read_text(encoding="utf-8"))
            data = body.get("data", body) if isinstance(body, dict) else body
            if isinstance(data, dict) and "calendar" in data:
                result[path.stem] = (data, source)
    return result


def day_features(date: str, lectures: dict, capacity_of) -> dict:
    cal = lectures.get("calendar") or {}
    weekday = pd.Timestamp(date).isoweekday()  # 1=月 … 7=日
    closed = cal.get("status") == "closed"
    reason = cal.get("reason") or ""
    if closed:
        day_type = "closed"
    elif "代替" in reason:
        day_type = "substitute"
    else:
        day_type = "normal"

    per_period = {p: {} for p in PERIODS}
    per_bin = [dict() for _ in BINS]
    if not closed:
        for course in lectures.get("courses") or []:
            tt = course.get("timetable") or {}
            keys = room_names(course) or [f"course:{course.get('entno')}"]
            period = tt.get("periodNumber")
            if period in per_period:
                for key in keys:
                    per_period[period][key] = capacity_of(key)
            start, end = tt.get("startMinute"), tt.get("endMinute")
            if start is None or end is None:
                continue
            for i, b in enumerate(BINS):
                if min(end, b + BIN_MINUTES) - max(start, b) >= BIN_MINUTES / 2:
                    for key in keys:
                        per_bin[i][key] = capacity_of(key)

    return {
        "periods": {p: sum(rooms.values()) for p, rooms in per_period.items()},
        "active": [sum(rooms.values()) for rooms in per_bin],
        "dow": str(cal.get("effectiveDayCode") or weekday),
        "week": cal.get("semesterClassIndex"),
        "day_type": day_type,
    }


def load_targets(data_dir: Path, devices_per_person: float) -> pd.DataFrame:
    path = data_dir / "crowd_snapshots.csv"
    if not path.exists():
        return pd.DataFrame(columns=["date", "bin", "y_people", "y_samples"])
    snaps = pd.read_csv(path, usecols=["measured_at", "estimated_total_device_count", "quality"])
    snaps = snaps[snaps["quality"] != "invalid"].copy()
    t = pd.to_datetime(snaps["measured_at"], utc=True, format="ISO8601").dt.tz_convert("Asia/Tokyo")
    snaps["date"] = t.dt.strftime("%Y-%m-%d")
    minute = t.dt.hour * 60 + t.dt.minute
    snaps["bin"] = (minute - BINS[0]) // BIN_MINUTES
    snaps = snaps[(snaps["bin"] >= 0) & (snaps["bin"] < len(BINS))]
    snaps["people"] = snaps["estimated_total_device_count"] / devices_per_person
    return (
        snaps.groupby(["date", "bin"])
        .agg(y_people=("people", "mean"), y_samples=("people", "size"))
        .reset_index()
    )


def build(args) -> pd.DataFrame:
    data_dir = Path(args.data_dir)
    capacities = {}
    if args.classrooms:
        capacities = json.loads(Path(args.classrooms).read_text(encoding="utf-8"))

    def capacity_of(room: str) -> float:
        info = capacities.get(room) if not room.startswith("course:") else None
        cap = info.get("capacity") if isinstance(info, dict) else None
        cap = cap if isinstance(cap, (int, float)) else args.default_capacity
        return cap * args.enrollment_rate

    lectures = load_lectures(data_dir)
    targets = load_targets(data_dir, args.devices_per_person)
    missing = sorted(set(targets["date"]) - set(lectures))
    if missing:
        print(f"時間割が無いので飛ばした日: {len(missing)}日（{missing[0]} など）")

    rows = []
    for date in sorted(lectures):
        if args.date_from and date < args.date_from:
            continue
        if args.date_to and date > args.date_to:
            continue
        data, source = lectures[date]
        f = day_features(date, data, capacity_of)
        active = f["active"]
        for i, b in enumerate(BINS):
            def lag(k):  # k 枠前（負なら後）の、開講中の履修人数
                j = i - k
                return active[j] if 0 <= j < len(active) else 0.0

            row = {
                "date": date,
                "bin": i,
                "bin_start": f"{b // 60:02d}:{b % 60:02d}",
                "x01_time_min": b,
            }
            for p in PERIODS:
                row[f"x{p + 1:02d}_p{p}"] = round(f["periods"][p], 1)
            row.update({
                "x09_dow": f["dow"],
                "x10_week": f["week"],
                "x11_day_type": f["day_type"],
                "x12_active": round(lag(0), 1),
                "x13_active_m30": round(lag(1), 1),
                "x14_active_m60": round(lag(2), 1),
                "x15_active_p30": round(lag(-1), 1),
                "x16_active_p60": round(lag(-2), 1),
                "lecture_source": source,
            })
            rows.append(row)

    table = pd.DataFrame(rows)
    if table.empty:
        return table
    table = table.merge(targets, on=["date", "bin"], how="left")
    table["y_samples"] = table["y_samples"].fillna(0).astype(int)
    table["y_people"] = table["y_people"].round(1)
    return table.drop(columns=["bin"])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", default="../data", help="サーバーの CROWD_DATA_DIR をコピーした場所")
    parser.add_argument("--classrooms", default=None, help="教室定員の JSON（kyousitu_size.json）")
    parser.add_argument("--out", default="output/training_table.csv")
    parser.add_argument("--devices-per-person", type=float, default=1.5)
    parser.add_argument("--enrollment-rate", type=float, default=0.7, help="教室定員のうち履修している割合（仮）")
    parser.add_argument("--default-capacity", type=float, default=50, help="定員が分からない教室の定員")
    parser.add_argument("--from", dest="date_from", default=None)
    parser.add_argument("--to", dest="date_to", default=None)
    args = parser.parse_args()

    table = build(args)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # 書きかけの表をサーバーが読まないよう、一時ファイルに書いてから置き換える
    tmp = out.with_name(out.name + ".tmp")
    table.to_csv(tmp, index=False)
    tmp.replace(out)

    if table.empty:
        print("時間割のデータが見つかりませんでした。")
        return
    labeled = table[table["y_samples"] >= 3]
    days = table.groupby("date")["x11_day_type"].first()
    print(f"書き出し: {out}（{len(table)}行、{table['date'].nunique()}日分）")
    print(f"  正解のある行: {len(labeled)}行（{labeled['date'].nunique()}日）")
    print(f"  日の種類: {days.value_counts().to_dict()}")


if __name__ == "__main__":
    main()
