import * as fs from "fs";
import * as path from "path";

/*
 * 学習用の表を後から作るための生データをためる。
 *
 * - building_readings.csv : /crowd の建物ごとの接続端末数（5分ごと）
 * - lecture_snapshots/    : 授業APIの、その日に取得した時間割と学事暦
 *
 * 表そのものは ml/build_table.py がこれらから組み立てる。
 */

const BUILDING_READING_HEADERS = ["measured_at", "building_key", "client_count"];
// 授業の前（朝）と、その日の授業が終わった後（夜）に時間割を保存する。
// 夜の分では翌日の時間割も先に取っておく（朝4時の学習で翌日＝当日の予報に使う）。
const LECTURE_SNAPSHOT_MINUTES = [6 * 60, 21 * 60];

/*
 * /crowd の建物ごとの端末数。API の項目名が apClientCount から
 * clientCount（除外端末を引いた数）に変わったので、両方を受け付ける。
 */
export function getReadingDeviceCount(reading) {
    if (!reading) return null;
    if (Number.isFinite(reading.clientCount)) return reading.clientCount;
    if (Number.isFinite(reading.apClientCount)) return reading.apClientCount;
    return null;
}

export function createDataStore(options) {
    const dataDir = options.dataDir;
    const fetchJson = options.fetchJson;
    const getTokyoDateString = options.getTokyoDateString;
    const getTokyoTimeParts = options.getTokyoTimeParts;

    const buildingReadingsPath = path.join(dataDir, "building_readings.csv");
    const lectureSnapshotDir = path.join(dataDir, "lecture_snapshots");
    let lastBuildingMeasuredAt = null;
    let timer = null;

    async function ensureBuildingReadingsFile() {
        try {
            const text = await fs.promises.readFile(buildingReadingsPath, "utf8");
            const lines = text.trimEnd().split("\n");
            if (lines.length > 1) {
                lastBuildingMeasuredAt = lines[lines.length - 1].split(",")[0];
            }
        } catch (error) {
            await fs.promises.writeFile(
                buildingReadingsPath,
                BUILDING_READING_HEADERS.join(",") + "\n",
                "utf8"
            );
        }
    }

    /* 建物ごとの値を追記する。同じ計測時刻は1回だけ。 */
    async function appendBuildingReadings(crowdData, measuredAt) {
        if (!measuredAt || measuredAt === lastBuildingMeasuredAt) return;
        const rows = (crowdData.readings || [])
            .filter(function (reading) {
                return reading.areaKey === reading.buildingKey &&
                    Number.isFinite(getReadingDeviceCount(reading));
            })
            .map(function (reading) {
                return [measuredAt, reading.buildingKey, getReadingDeviceCount(reading)].join(",");
            });
        if (rows.length === 0) return;
        await fs.promises.appendFile(buildingReadingsPath, rows.join("\n") + "\n", "utf8");
        lastBuildingMeasuredAt = measuredAt;
    }

    /* その日の時間割を保存する（同じ日の分は新しいもので上書き）。 */
    async function snapshotLectures(date) {
        const data = await fetchJson(
            "https://api.dtc.wide.ad.jp/lectures?date=" + date,
            "授業情報"
        );
        await fs.promises.mkdir(lectureSnapshotDir, { recursive: true });
        const filePath = path.join(lectureSnapshotDir, date + ".json");
        const temporaryPath = filePath + ".tmp";
        await fs.promises.writeFile(
            temporaryPath,
            JSON.stringify({ fetchedAt: new Date().toISOString(), data: data }),
            "utf8"
        );
        await fs.promises.rename(temporaryPath, filePath);
    }

    function msUntilNextSnapshot() {
        const parts = getTokyoTimeParts(new Date());
        const nowMinute = parts.hour * 60 + parts.minute + parts.second / 60;
        const waits = LECTURE_SNAPSHOT_MINUTES.map(function (minute) {
            const wait = minute - nowMinute;
            return wait > 0 ? wait : wait + 24 * 60;
        });
        return Math.round(Math.min.apply(null, waits) * 60 * 1000);
    }

    function scheduleLectureSnapshots() {
        clearTimeout(timer);
        timer = setTimeout(async function () {
            try {
                const today = getTokyoDateString(new Date());
                await snapshotLectures(today);
                await snapshotLectures(addDays(today, 1));
            } catch (error) {
                console.error("時間割の保存に失敗しました。", error);
            } finally {
                scheduleLectureSnapshots();
            }
        }, msUntilNextSnapshot());
    }

    function addDays(date, days) {
        const d = new Date(date + "T12:00:00+09:00");
        d.setUTCDate(d.getUTCDate() + days);
        return getTokyoDateString(d);
    }

    function hasLectureSnapshot(date) {
        return fs.existsSync(path.join(lectureSnapshotDir, date + ".json"));
    }

    async function initialize() {
        await fs.promises.mkdir(dataDir, { recursive: true });
        await ensureBuildingReadingsFile();

        const today = getTokyoDateString(new Date());
        [today, addDays(today, 1)].forEach(function (date) {
            if (hasLectureSnapshot(date)) return;
            snapshotLectures(date).catch(function (error) {
                console.error("起動時の時間割の保存に失敗しました。", error);
            });
        });
        scheduleLectureSnapshots();
    }

    return {
        initialize: initialize,
        appendBuildingReadings: appendBuildingReadings,
        snapshotLectures: snapshotLectures,
        hasLectureSnapshot: hasLectureSnapshot
    };
}
