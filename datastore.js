import * as fs from "fs";
import * as path from "path";

/*
 * 学習用の表を後から作るための生データをためる。
 *
 * - building_readings.csv : /crowd の建物ごとの接続端末数（5分ごと）
 * - lecture_snapshots/    : 授業APIの、その日に取得した時間割と学事暦
 * - lectures/             : 明後日から1か月先までの時間割（LightGBM の先の予報用。毎晩取り直す）
 *
 * 表そのものは ml/build_table.py がこれらから組み立てる。
 */

const BUILDING_READING_HEADERS = ["measured_at", "building_key", "client_count"];
// 授業の前（朝）と、その日の授業が終わった後（夜）に時間割を保存する。
// 夜の分では翌日の時間割も先に取っておく（朝4時の学習で翌日＝当日の予報に使う）。
const LECTURE_SNAPSHOT_MINUTES = [6 * 60, 21 * 60];
const UPCOMING_DAYS = 31;

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
    const upcomingLectureDir = path.join(dataDir, "lectures");
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
                await prefetchUpcomingLectures();
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

    /* 明後日から UPCOMING_DAYS 日先までの時間割を、半日より古ければ取り直す。 */
    async function prefetchUpcomingLectures() {
        const today = getTokyoDateString(new Date());
        await fs.promises.mkdir(upcomingLectureDir, { recursive: true });
        for (let offset = 2; offset <= UPCOMING_DAYS; offset += 1) {
            const date = addDays(today, offset);
            const filePath = path.join(upcomingLectureDir, date + ".json");
            try {
                const stat = await fs.promises.stat(filePath);
                if (Date.now() - stat.mtimeMs < 12 * 60 * 60 * 1000) continue;
            } catch (error) {
                // まだ無い
            }
            try {
                const data = await fetchJson(
                    "https://api.dtc.wide.ad.jp/lectures?date=" + date,
                    "授業情報（先の日）"
                );
                const temporaryPath = filePath + ".tmp";
                await fs.promises.writeFile(
                    temporaryPath,
                    JSON.stringify({ fetchedAt: new Date().toISOString(), data: data }),
                    "utf8"
                );
                await fs.promises.rename(temporaryPath, filePath);
            } catch (error) {
                console.error("先の日の時間割の取得に失敗しました: " + date, error.message);
            }
            // DTC API を続けて叩きすぎない
            await new Promise(function (resolve) { setTimeout(resolve, 2000); });
        }
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
        prefetchUpcomingLectures().catch(function (error) {
            console.error("先の日の時間割の取得に失敗しました。", error);
        });
    }

    return {
        initialize: initialize,
        appendBuildingReadings: appendBuildingReadings,
        snapshotLectures: snapshotLectures,
        hasLectureSnapshot: hasLectureSnapshot
    };
}
