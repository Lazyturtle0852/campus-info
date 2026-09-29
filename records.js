import * as fs from "fs";
import * as path from "path";

/*
 * 実績の表（/records）の中身をそろえる。
 *
 * - x01〜x16：朝4時の学習ジョブ（ml/）が作った training_table.csv
 * - y（実測）：サーバーがためている5分ごとの値から、その場で30分枠にまとめる
 *   （表は朝に作るので、今日の実測はこちらで足さないと出ない）
 * - 予報：学習ジョブがその朝に出した予報を predictions_log.csv にためている
 *
 * y のまとめ方は ml/build_table.py の load_targets と同じ。
 */

const BIN_MINUTES = 30;
const FIRST_BIN = 7 * 60;
const LAST_BIN = 21 * 60 + 30;
const MIN_SAMPLES = 3;
const PREDICTION_COLUMNS = ["pred_A", "pred_B", "pred_dow_mean"];

// 公開してよい（バックアップで取りに来る）ファイル。
const PUBLIC_DATA_FILES = [
    "crowd_snapshots.csv",
    "building_readings.csv",
    "ml/training_table.csv",
    "ml/predictions_log.csv",
    "ml/eval_by_week.csv",
    "ml/eval_summary.md",
    "ml/importance_A.csv",
    "ml/importance_B.csv",
    "ml/last_run.json"
];

function parseSimpleCsv(text) {
    // ml/ が書く CSV は引用符を使わないので、単純に分ける。
    const lines = text.split("\n").filter(Boolean);
    if (lines.length === 0) return [];
    const headers = lines[0].split(",");
    return lines.slice(1).map(function (line) {
        const cells = line.split(",");
        const row = {};
        headers.forEach(function (header, i) { row[header] = cells[i] ?? ""; });
        return row;
    });
}

function toNumber(value) {
    if (value === "" || value === undefined || value === null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function minuteToTime(minute) {
    return String(Math.floor(minute / 60)).padStart(2, "0") + ":" +
        String(minute % 60).padStart(2, "0");
}

export function createRecords(options) {
    const dataDir = options.dataDir;
    const mlDir = path.join(dataDir, "ml");
    const fileCache = new Map();

    async function readCsvCached(filePath) {
        let stat;
        try {
            stat = await fs.promises.stat(filePath);
        } catch (error) {
            return [];
        }
        const cached = fileCache.get(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs) return cached.rows;
        const rows = parseSimpleCsv(await fs.promises.readFile(filePath, "utf8"));
        fileCache.set(filePath, { mtimeMs: stat.mtimeMs, rows: rows });
        return rows;
    }

    async function readJson(filePath) {
        try {
            return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
        } catch (error) {
            return null;
        }
    }

    let actualCache = { key: null, value: null };

    /* 日付 → 30分枠ごとの実測（人）と、その枠に入った5分データの数。 */
    function actualByDate() {
        const snapshots = options.getSnapshots();
        const last = snapshots[snapshots.length - 1];
        const key = snapshots.length + "|" + (last ? last.measuredAt : "");
        if (actualCache.key === key) return actualCache.value;

        const result = new Map();
        snapshots.forEach(function (snapshot) {
            if (snapshot.quality === "invalid") return;
            if (!Number.isFinite(snapshot.estimatedTotalDeviceCount)) return;
            // 日本時間には夏時間が無いので、9時間ずらして UTC として読む（数万件を毎回変換するため）。
            const tokyo = new Date(new Date(snapshot.measuredAt).getTime() + 9 * 60 * 60 * 1000);
            const minute = tokyo.getUTCHours() * 60 + tokyo.getUTCMinutes();
            if (minute < FIRST_BIN || minute >= LAST_BIN + BIN_MINUTES) return;
            const bin = minuteToTime(FIRST_BIN + Math.floor((minute - FIRST_BIN) / BIN_MINUTES) * BIN_MINUTES);
            const date = tokyo.toISOString().slice(0, 10);
            if (!result.has(date)) result.set(date, new Map());
            const bins = result.get(date);
            const cell = bins.get(bin) || { sum: 0, count: 0 };
            cell.sum += snapshot.estimatedTotalDeviceCount / options.devicesPerPerson;
            cell.count += 1;
            bins.set(bin, cell);
        });
        actualCache = { key: key, value: result };
        return result;
    }

    function meanAbsError(rows, column) {
        const errors = rows
            .filter(function (row) {
                return row.y_samples >= MIN_SAMPLES &&
                    row.y_people !== null && row[column] !== null;
            })
            .map(function (row) { return Math.abs(row.y_people - row[column]); });
        if (errors.length === 0) return null;
        return Math.round(errors.reduce(function (a, b) { return a + b; }, 0) / errors.length * 10) / 10;
    }

    async function getDay(date) {
        const table = (await readCsvCached(path.join(mlDir, "training_table.csv")))
            .filter(function (row) { return row.date === date; });
        const predictions = (await readCsvCached(path.join(mlDir, "predictions_log.csv")))
            .filter(function (row) { return row.date === date; });
        const actual = actualByDate().get(date) || new Map();
        const predictionByBin = new Map(predictions.map(function (row) {
            return [row.bin_start, row];
        }));
        const tableByBin = new Map(table.map(function (row) { return [row.bin_start, row]; }));

        const rows = [];
        for (let minute = FIRST_BIN; minute <= LAST_BIN; minute += BIN_MINUTES) {
            const bin = minuteToTime(minute);
            const x = tableByBin.get(bin) || {};
            const cell = actual.get(bin);
            const prediction = predictionByBin.get(bin) || {};
            const row = { bin_start: bin };
            Object.keys(x).forEach(function (key) {
                if (/^x\d\d_/.test(key)) {
                    row[key] = key === "x09_dow" || key === "x11_day_type"
                        ? x[key] || null
                        : toNumber(x[key]);
                }
            });
            row.y_people = cell ? Math.round(cell.sum / cell.count * 10) / 10 : null;
            row.y_samples = cell ? cell.count : 0;
            PREDICTION_COLUMNS.forEach(function (column) {
                row[column] = toNumber(prediction[column]);
            });
            rows.push(row);
        }

        const errors = {};
        PREDICTION_COLUMNS.forEach(function (column) {
            errors[column] = meanAbsError(rows, column);
        });
        return {
            date: date,
            hasFeatures: table.length > 0,
            issuedAt: predictions.length > 0 ? predictions[0].issued_at || null : null,
            rows: rows,
            meanAbsError: errors
        };
    }

    /* 予報を出した日ごとの誤差（実測との差の絶対値の平均）。変化を眺める用。 */
    async function getHistory() {
        const predictions = await readCsvCached(path.join(mlDir, "predictions_log.csv"));
        const actual = actualByDate();
        const byDate = new Map();
        predictions.forEach(function (row) {
            if (!byDate.has(row.date)) byDate.set(row.date, []);
            byDate.get(row.date).push(row);
        });
        const table = await readCsvCached(path.join(mlDir, "training_table.csv"));
        const dates = Array.from(new Set(table.map(function (row) { return row.date; })))
            .concat(Array.from(actual.keys()))
            .filter(function (date, i, all) { return all.indexOf(date) === i; })
            .sort();

        const history = Array.from(byDate.keys()).sort().map(function (date) {
            const bins = actual.get(date) || new Map();
            const rows = byDate.get(date).map(function (prediction) {
                const cell = bins.get(prediction.bin_start);
                const row = {
                    y_people: cell ? cell.sum / cell.count : null,
                    y_samples: cell ? cell.count : 0
                };
                PREDICTION_COLUMNS.forEach(function (column) {
                    row[column] = toNumber(prediction[column]);
                });
                return row;
            });
            const errors = {};
            PREDICTION_COLUMNS.forEach(function (column) {
                errors[column] = meanAbsError(rows, column);
            });
            return { date: date, meanAbsError: errors };
        });
        return { dates: dates, history: history };
    }

    async function directorySize(dir) {
        let total = 0;
        let entries = [];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (error) {
            return 0;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                total += await directorySize(full);
            } else {
                total += (await fs.promises.stat(full)).size;
            }
        }
        return total;
    }

    /* 監視用：最後に取れた時刻、今日の取れ具合、データ容量、取り直しと学習の状況。 */
    async function getStatus() {
        const now = new Date();
        const snapshots = options.getSnapshots();
        const latest = snapshots[snapshots.length - 1] || null;
        const today = options.getTokyoDateString(now);
        const parts = options.getTokyoTimeParts(now);
        const nowMinute = parts.hour * 60 + parts.minute;
        const endMinute = Math.min(nowMinute, LAST_BIN + BIN_MINUTES);
        const expected = Math.max(0, Math.floor((endMinute - FIRST_BIN) / 5));
        const todayBins = actualByDate().get(today) || new Map();
        let got = 0;
        todayBins.forEach(function (cell) { got += cell.count; });

        return {
            now: now.toISOString(),
            collection: {
                lastMeasuredAt: latest ? latest.measuredAt : null,
                lastQuality: latest ? latest.quality : null,
                minutesSinceLast: latest
                    ? Math.round((now - new Date(latest.measuredAt)) / 60000)
                    : null,
                totalSnapshots: snapshots.length
            },
            today: {
                date: today,
                expectedSamples: expected,
                validSamples: got,
                missingRate: expected > 0
                    ? Math.round((1 - Math.min(got, expected) / expected) * 1000) / 1000
                    : null
            },
            dataBytes: await directorySize(dataDir),
            backfill: options.getBackfillStatus(),
            training: await readJson(path.join(mlDir, "last_run.json"))
        };
    }

    /* バックアップ用に公開するファイルの一覧（時間割の保存分も含む）。 */
    async function listDataFiles() {
        const files = [];
        for (const name of PUBLIC_DATA_FILES) {
            try {
                const stat = await fs.promises.stat(path.join(dataDir, name));
                files.push({ path: name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
            } catch (error) {
                // まだ作られていないファイルは載せない
            }
        }
        let snapshots = [];
        try {
            snapshots = await fs.promises.readdir(path.join(dataDir, "lecture_snapshots"));
        } catch (error) {
            snapshots = [];
        }
        snapshots
            .filter(function (name) { return /^\d{4}-\d{2}-\d{2}\.json$/.test(name); })
            .sort()
            .forEach(function (name) { files.push({ path: "lecture_snapshots/" + name }); });
        return files;
    }

    function resolveDataFile(relativePath) {
        const clean = String(relativePath || "");
        if (PUBLIC_DATA_FILES.includes(clean) ||
            /^lecture_snapshots\/\d{4}-\d{2}-\d{2}\.json$/.test(clean)) {
            return path.join(dataDir, clean);
        }
        return null;
    }

    return {
        getDay: getDay,
        getHistory: getHistory,
        getStatus: getStatus,
        listDataFiles: listDataFiles,
        resolveDataFile: resolveDataFile
    };
}
