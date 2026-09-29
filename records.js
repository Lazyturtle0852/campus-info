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

    /* その日の時間割の学事暦（授業API の保存分）。 */
    async function readCalendar(date) {
        const body = await readJson(path.join(dataDir, "lecture_snapshots", date + ".json")) ||
            await readJson(path.join(dataDir, "lectures", date + ".json"));
        const data = body && (body.data || body);
        const cal = data && data.calendar;
        if (!cal) return { status: "unknown" };
        return {
            status: cal.status === "closed" ? "closed" : "open",
            reason: cal.reason || null,
            week: cal.semesterClassIndex ?? null
        };
    }

    /*
     * 日付 → 30分ごとの人数の系列（バス混雑の予報が使う）。
     * 予報は LightGBM B。当日と過去はその朝に出したもの（predictions_log）、
     * 明日以降は最新の予報（predictions.csv）。
     */
    async function getSeries(date) {
        const now = new Date();
        const today = options.getTokyoDateString(now);
        const parts = options.getTokyoTimeParts(now);
        const file = date <= today ? "predictions_log.csv" : "predictions.csv";
        const predictions = (await readCsvCached(path.join(mlDir, file)))
            .filter(function (row) { return row.date === date; });
        const predictionByBin = new Map(predictions.map(function (row) {
            return [row.bin_start, toNumber(row.pred_B)];
        }));
        const actual = actualByDate().get(date) || new Map();
        const bins = [];
        for (let minute = FIRST_BIN; minute <= LAST_BIN; minute += BIN_MINUTES) bins.push(minute);
        const forecast = bins.map(function (minute) {
            const value = predictionByBin.get(minuteToTime(minute));
            return value === undefined ? null : value;
        });
        const actualValues = bins.map(function (minute) {
            const cell = actual.get(minuteToTime(minute));
            return cell && cell.count >= MIN_SAMPLES ? Math.round(cell.sum / cell.count) : null;
        });
        const issuedAt = predictions.length > 0 ? predictions[0].issued_at || null : null;
        const trained = await readJson(path.join(mlDir, "last_run.json"));
        return {
            bins: bins,
            forecast: forecast.some(function (v) { return v !== null; }) ? forecast : null,
            actual: actualValues.some(function (v) { return v !== null; }) ? actualValues : null,
            forecastInfo: predictions.length > 0
                ? {
                    basis: date === today ? "same_day" : "day_before",
                    issuedAt: issuedAt || (trained && trained.finishedAt) || null
                }
                : null,
            today: today,
            nowMinute: parts.hour * 60 + parts.minute,
            calendar: await readCalendar(date)
        };
    }

    /* ---------- トップ画面（キャンパス人数）向け ---------- */

    function binMinutes() {
        const bins = [];
        for (let minute = FIRST_BIN; minute <= LAST_BIN; minute += BIN_MINUTES) bins.push(minute);
        return bins;
    }

    function addDays(date, days) {
        const d = new Date(date + "T12:00:00+09:00");
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
    }

    async function readLectures(date) {
        const body = await readJson(path.join(dataDir, "lecture_snapshots", date + ".json")) ||
            await readJson(path.join(dataDir, "lectures", date + ".json"));
        return body ? body.data || body : null;
    }

    // 時間割の JSON は1日分でも大きいので、日の種類と学事暦だけを少しの間覚えておく。
    const calendarCache = new Map();
    const CALENDAR_TTL_MS = 10 * 60 * 1000;

    /* 日の種類と学事暦（以前のトップ画面と同じ形）。 */
    async function describeCalendar(date) {
        const cached = calendarCache.get(date);
        if (cached && Date.now() - cached.at < CALENDAR_TTL_MS) return cached.value;
        const value = await readCalendarUncached(date);
        calendarCache.set(date, { at: Date.now(), value: value });
        return value;
    }

    async function readCalendarUncached(date) {
        const lectures = await readLectures(date);
        const cal = (lectures && lectures.calendar) || {};
        const weekday = new Date(date + "T12:00:00+09:00").getUTCDay();
        const closed = !lectures || cal.status === "closed";
        return {
            type: closed ? (weekday === 0 || weekday === 6 ? "closed_weekend" : "closed_weekday") : "class",
            calendar: {
                status: lectures ? cal.status || null : "unknown",
                week: cal.semesterClassIndex || null,
                effectiveDayCode: cal.effectiveDayCode || null,
                reason: cal.reason || null
            }
        };
    }

    /*
     * その日の LightGBM（B）の予報。今日と過去はその朝に出したもの（predictions_log）、
     * それが無い日と明日以降は、最新の学習で出したもの（predictions.csv）。
     */
    async function forecastFor(date, today) {
        const sources = date <= today
            ? ["predictions_log.csv", "predictions.csv"]
            : ["predictions.csv"];
        const lastRun = await readJson(path.join(mlDir, "last_run.json"));
        for (const file of sources) {
            const rows = (await readCsvCached(path.join(mlDir, file)))
                .filter(function (row) { return row.date === date; });
            if (rows.length === 0) continue;
            const byBin = new Map(rows.map(function (row) { return [row.bin_start, toNumber(row.pred_B)]; }));
            const values = binMinutes().map(function (minute) {
                const v = byBin.get(minuteToTime(minute));
                return v === undefined || v === null ? null : Math.max(0, Math.round(v));
            });
            if (values.every(function (v) { return v === null; })) continue;
            const issuedAt = rows[0].issued_at || (lastRun && lastRun.finishedAt) || null;
            const issuedDate = issuedAt ? options.getTokyoDateString(new Date(issuedAt)) : today;
            return {
                values: values.map(function (v) { return v === null ? 0 : v; }),
                issuedAt: issuedAt,
                stage: "lightgbm",
                basis: issuedDate < date ? "day_before" : "same_day"
            };
        }
        return null;
    }

    function peakOf(values) {
        let index = 0;
        values.forEach(function (v, i) { if (v > values[index]) index = i; });
        return { value: values[index], minute: binMinutes()[index] };
    }

    async function describeDays(dates, now) {
        const today = options.getTokyoDateString(now);
        const parts = options.getTokyoTimeParts(now);
        const nowMinute = parts.hour * 60 + parts.minute;
        const actualAll = actualByDate();
        const bins = binMinutes();
        const days = [];
        for (const date of dates) {
            const kind = await describeCalendar(date);
            const forecast = await forecastFor(date, today);
            const cells = date <= today ? actualAll.get(date) || null : null;
            const actual = cells
                ? bins.map(function (minute) {
                    const cell = cells.get(minuteToTime(minute));
                    return cell ? Math.round(cell.sum / cell.count) : null;
                })
                : null;
            const actualValues = actual ? actual.filter(function (v) { return v !== null; }) : [];
            const peak = forecast ? peakOf(forecast.values) : null;
            let mae = null;
            if (cells && forecast) {
                const errors = [];
                bins.forEach(function (minute, i) {
                    const cell = cells.get(minuteToTime(minute));
                    if (!cell || cell.count < MIN_SAMPLES) return;
                    if (date === today && minute + BIN_MINUTES > nowMinute) return;
                    errors.push(Math.abs(cell.sum / cell.count - forecast.values[i]));
                });
                if (errors.length > 0) mae = errors.reduce(function (a, b) { return a + b; }, 0) / errors.length;
            }
            days.push({
                date: date,
                type: kind.type,
                calendar: kind.calendar,
                forecast: forecast,
                actual: actual,
                forecastPeak: peak ? peak.value : null,
                forecastPeakMinute: peak ? peak.minute : null,
                actualPeak: actualValues.length > 0 ? Math.max.apply(null, actualValues) : null,
                mae: mae
            });
        }
        return days;
    }

    /* 学習に使った日数（正解のある日を、授業日と授業のない日に分けて数える）。 */
    async function describeModel() {
        const lastRun = await readJson(path.join(mlDir, "last_run.json"));
        const table = await readCsvCached(path.join(mlDir, "training_table.csv"));
        const classDays = new Set();
        const closedDays = new Set();
        table.forEach(function (row) {
            if (Number(row.y_samples) < MIN_SAMPLES) return;
            (row.x11_day_type === "closed" ? closedDays : classDays).add(row.date);
        });
        let label = "LightGBM（まだ学習していません）";
        if (lastRun && lastRun.status === "ok") label = "LightGBM（毎朝4時に学習）";
        if (lastRun && lastRun.status === "skipped") label = "LightGBM（学習できる日数が足りず見送り）";
        if (lastRun && lastRun.status === "failed") label = "LightGBM（直近の学習に失敗）";
        return {
            stage: "lightgbm",
            stageLabel: label,
            trainedAt: lastRun && lastRun.status === "ok" ? lastRun.finishedAt : null,
            training: { classDays: classDays.size, closedDays: closedDays.size },
            forecasting: false
        };
    }

    function tertiles(values) {
        const sorted = values.slice().sort(function (a, b) { return a - b; });
        return {
            t1: sorted[Math.floor(sorted.length / 3)],
            t2: sorted[Math.floor(sorted.length * 2 / 3)]
        };
    }

    async function getCampusOverview(now) {
        const today = options.getTokyoDateString(now);
        const parts = options.getTokyoTimeParts(now);
        const observed = Array.from(actualByDate().keys()).sort()
            .filter(function (date) { return date >= addDays(today, -60) && date < today; });
        const first = observed.length > 0 ? observed[0] : addDays(today, -7);
        const dates = [];
        for (let date = first; date <= addDays(today, 31); date = addDays(date, 1)) dates.push(date);
        const days = await describeDays(dates, now);

        const pastClassDays = days.filter(function (day) {
            return day.date < today && day.type === "class" && day.actualPeak !== null;
        });
        const recent = days
            .filter(function (day) { return day.date < today && day.type === "class" && day.mae !== null; })
            .slice(-7);
        const upcomingPeaks = days
            .filter(function (day) { return day.date >= today && day.type === "class" && day.forecastPeak !== null; })
            .map(function (day) { return day.forecastPeak; });
        let colorScale = null;
        if (pastClassDays.length >= 10) {
            colorScale = Object.assign({ basis: "actual" }, tertiles(pastClassDays.map(function (d) { return d.actualPeak; })));
        } else if (upcomingPeaks.length >= 3) {
            colorScale = Object.assign({ basis: "forecast" }, tertiles(upcomingPeaks));
        }

        // 品質が invalid の回は飛ばして、最後の有効な値を出す。
        const snapshots = options.getSnapshots();
        let latest = null;
        for (let i = snapshots.length - 1; i >= 0 && !latest; i -= 1) {
            if (snapshots[i].quality !== "invalid") latest = snapshots[i];
        }

        return {
            generatedAt: now.toISOString(),
            today: today,
            nowMinute: parts.hour * 60 + parts.minute,
            bins: binMinutes(),
            devicesPerPerson: options.devicesPerPerson,
            current: latest
                ? {
                    population: Math.round(latest.estimatedTotalDeviceCount / options.devicesPerPerson),
                    measuredAt: latest.measuredAt,
                    quality: latest.quality
                }
                : null,
            model: await describeModel(),
            recentMae: recent.length > 0
                ? {
                    value: recent.reduce(function (a, d) { return a + d.mae; }, 0) / recent.length,
                    days: recent.length
                }
                : null,
            colorScale: colorScale,
            days: days
        };
    }

    async function getCampusDay(date, now) {
        const today = options.getTokyoDateString(now);
        const parts = options.getTokyoTimeParts(now);
        const days = await describeDays([date], now);
        const model = await describeModel();
        return Object.assign(days[0], {
            today: today,
            nowMinute: parts.hour * 60 + parts.minute,
            bins: binMinutes(),
            model: { stage: model.stage, stageLabel: model.stageLabel }
        });
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
        getSeries: getSeries,
        getCampusOverview: getCampusOverview,
        getCampusDay: getCampusDay,
        getStatus: getStatus,
        listDataFiles: listDataFiles,
        resolveDataFile: resolveDataFile
    };
}
