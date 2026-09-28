import * as fs from "fs";
import * as path from "path";

/*
 * キャンパス人数の予報（M7）。
 *
 * ŷ(d,t) = b_type(t) + exp(β曜日 + γ·(週 − 1)) × Σₖ wₖ · C(d, t − k)
 *
 * C(d,t) は30分枠 t に開講中の授業の「推定履修者数」の合計
 * （教室定員 × 推定履修率）。b・w・β・γ は実測から学習し、
 * データが足りないうちは事前値を使う。
 */

const BIN_MINUTES = 30;
export const FORECAST_BINS = (function () {
    const bins = [];
    for (let minute = 7 * 60; minute < 22 * 60; minute += BIN_MINUTES) {
        bins.push(minute);
    }
    return bins;
})();

// k = 授業の時刻から見てどれだけ後か（負 = 授業の前）
const LAGS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
const DAY_TYPES = ["class", "closed_weekday", "closed_weekend"];
const ENROLLMENT_RATE = 0.7;
const DEFAULT_ROOM_CAPACITY = 50;
const FORECAST_HORIZON_DAYS = 31;
const HISTORY_DAYS = 60;
const LECTURE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_TRAINING_SAMPLES = 3;
const MIN_TRAINING_BINS_PER_DAY = 20;
const DAILY_RUN_MINUTE = 22 * 60;

const STAGE_LABELS = {
    prior: "事前値のみ（学期中の実測なし）",
    base_kernel: "ベースと前後の重みを学習",
    dow: "＋曜日係数を学習",
    decay: "＋週による減衰を学習"
};

/* ---------- 教室名 ---------- */

const ROOM_ALIASES = { "θ": "θ館" };

export function normalizeRoomName(roomName) {
    if (typeof roomName !== "string") return null;
    const normalized = roomName.normalize("NFKC").trim();
    if (!normalized) return null;
    return ROOM_ALIASES[normalized] || normalized;
}

export function getRoomNames(classInfo) {
    const locations =
        classInfo &&
        classInfo.classroom &&
        classInfo.classroom.locations;

    if (Array.isArray(locations)) {
        const rooms = locations
            .map(function (location) {
                return normalizeRoomName(location.room);
            })
            .filter(Boolean);

        if (rooms.length > 0) return Array.from(new Set(rooms));
    }

    const rawRoom =
        classInfo && classInfo.classroom
            ? classInfo.classroom.raw
            : classInfo && classInfo.CLRM;

    if (typeof rawRoom !== "string") return [];

    return Array.from(
        new Set(
            rawRoom
                .split(/[、,，/／・\s]+/)
                .map(normalizeRoomName)
                .filter(Boolean)
        )
    );
}

/* ---------- 日付 ---------- */

function addDays(dateString, days) {
    const date = new Date(dateString + "T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function weekdayOf(dateString) {
    return new Date(dateString + "T12:00:00+09:00").getUTCDay();
}

function dateRange(from, to) {
    const dates = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
        dates.push(date);
    }
    return dates;
}

/* ---------- 事前値 ---------- */

function middayBump(minute) {
    const hour = (minute + BIN_MINUTES / 2) / 60;
    return Math.exp(-Math.pow((hour - 14) / 4.2, 2));
}

function createPriorParams() {
    return {
        base: {
            class: FORECAST_BINS.map(function (m) { return 80 + 350 * middayBump(m); }),
            closed_weekday: FORECAST_BINS.map(function (m) { return 60 + 190 * middayBump(m); }),
            closed_weekend: FORECAST_BINS.map(function (m) { return 50 + 30 * middayBump(m); })
        },
        kernel: [0, 0.01, 0.04, 0.19, 0.55, 0.28, 0.14, 0.055, 0.015],
        dow: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0 },
        weekDecay: 0,
        stage: "prior",
        trainedAt: null,
        training: { classDays: 0, closedDays: 0, weeks: 0, rows: 0 }
    };
}

/* ---------- 数値計算 ---------- */

function solveLinearSystem(matrix, vector) {
    const n = vector.length;
    const a = matrix.map(function (row, i) { return row.concat([vector[i]]); });

    for (let col = 0; col < n; col += 1) {
        let pivot = col;
        for (let row = col + 1; row < n; row += 1) {
            if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
        }
        if (Math.abs(a[pivot][col]) < 1e-12) continue;
        const tmp = a[col]; a[col] = a[pivot]; a[pivot] = tmp;

        for (let row = col + 1; row < n; row += 1) {
            const factor = a[row][col] / a[col][col];
            if (factor === 0) continue;
            for (let k = col; k <= n; k += 1) a[row][k] -= factor * a[col][k];
        }
    }

    const x = new Array(n).fill(0);
    for (let row = n - 1; row >= 0; row -= 1) {
        if (Math.abs(a[row][row]) < 1e-12) continue;
        let sum = a[row][n];
        for (let k = row + 1; k < n; k += 1) sum -= a[row][k] * x[k];
        x[row] = sum / a[row][row];
    }
    return x;
}

function goldenSection(f, low, high, iterations) {
    const ratio = (Math.sqrt(5) - 1) / 2;
    let a = low, b = high;
    let c = b - ratio * (b - a), d = a + ratio * (b - a);
    let fc = f(c), fd = f(d);
    for (let i = 0; i < iterations; i += 1) {
        if (fc < fd) { b = d; d = c; fd = fc; c = b - ratio * (b - a); fc = f(c); }
        else { a = c; c = d; fc = fd; d = a + ratio * (b - a); fd = f(d); }
    }
    return (a + b) / 2;
}

function median(values) {
    if (values.length === 0) return null;
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.floor(sorted.length / 2)];
}

function tertiles(values) {
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    return {
        t1: sorted[Math.floor(sorted.length / 3)],
        t2: sorted[Math.floor(sorted.length * 2 / 3)]
    };
}

/* ---------- 予測 ---------- */

function classScale(params, feature) {
    if (feature.type !== "class") return 1;
    const dowCoef = params.dow[feature.dow] || 0;
    const week = feature.week || 1;
    return Math.exp(dowCoef + params.weekDecay * (week - 1));
}

function laggedClassPeople(feature, binIndex, lagIndex) {
    const source = binIndex - LAGS[lagIndex];
    if (source < 0 || source >= feature.classPeople.length) return 0;
    return feature.classPeople[source];
}

export function predictDay(params, feature) {
    const base = params.base[feature.type];
    const scale = classScale(params, feature);

    return FORECAST_BINS.map(function (_, i) {
        let classPart = 0;
        for (let j = 0; j < LAGS.length; j += 1) {
            classPart += params.kernel[j] * laggedClassPeople(feature, i, j);
        }
        return Math.max(0, base[i] + scale * classPart);
    });
}

/* ---------- 本体 ---------- */

export function createCampusForecaster(options) {
    const dataDir = options.dataDir;
    const classroomInfo = options.classroomInfo || {};
    const fetchJson = options.fetchJson;
    const getSnapshots = options.getSnapshots;
    const getTokyoTimeParts = options.getTokyoTimeParts;
    const getTokyoDateString = options.getTokyoDateString;
    const devicesPerPerson = options.devicesPerPerson;

    const lectureDir = path.join(dataDir, "lectures");
    const forecastsPath = path.join(dataDir, "forecasts.csv");
    const paramsPath = path.join(dataDir, "model_params.json");

    const lectureCache = new Map();
    let runs = [];               // { issuedAt, issuedDate, stage, byDate: { date: values[] } }
    let params = createPriorParams();
    let running = null;
    let timer = null;

    /* 授業API */

    async function readLectureFile(date) {
        try {
            const text = await fs.promises.readFile(
                path.join(lectureDir, date + ".json"),
                "utf8"
            );
            return JSON.parse(text);
        } catch (error) {
            return null;
        }
    }

    function isFresh(entry, date) {
        if (!entry) return false;
        const today = getTokyoDateString(new Date());
        return date < today || Date.now() - entry.fetchedAt < LECTURE_CACHE_TTL_MS;
    }

    async function getLectures(date) {
        let entry = lectureCache.get(date);
        if (!isFresh(entry, date)) {
            const fromDisk = await readLectureFile(date);
            if (fromDisk) entry = fromDisk;
        }
        if (isFresh(entry, date)) {
            lectureCache.set(date, entry);
            return entry.data;
        }

        try {
            const data = await fetchJson(
                "https://api.dtc.wide.ad.jp/lectures?date=" + date,
                "授業情報"
            );
            entry = { fetchedAt: Date.now(), data: data };
            lectureCache.set(date, entry);
            await fs.promises.mkdir(lectureDir, { recursive: true });
            await fs.promises.writeFile(
                path.join(lectureDir, date + ".json"),
                JSON.stringify(entry),
                "utf8"
            );
            return data;
        } catch (error) {
            // 取得に失敗しても、古いキャッシュがあればそれを使う。
            if (entry) return entry.data;
            throw error;
        }
    }

    async function getLecturesForDates(dates) {
        const result = {};
        const queue = dates.slice();
        async function worker() {
            while (queue.length > 0) {
                const date = queue.shift();
                try {
                    result[date] = await getLectures(date);
                } catch (error) {
                    result[date] = null;
                }
            }
        }
        await Promise.all([worker(), worker(), worker(), worker()]);
        return result;
    }

    /* 特徴量 */

    function roomCapacity(room) {
        const info = classroomInfo[room];
        return info && Number.isFinite(info.capacity)
            ? info.capacity
            : DEFAULT_ROOM_CAPACITY;
    }

    function buildFeature(date, lectureData) {
        const calendar = (lectureData && lectureData.calendar) || {};
        const weekday = weekdayOf(date);
        const closed = !lectureData || calendar.status === "closed";
        const type = closed
            ? (weekday === 0 || weekday === 6 ? "closed_weekend" : "closed_weekday")
            : "class";
        const roomsByBin = FORECAST_BINS.map(function () { return new Map(); });

        if (!closed) {
            (lectureData.courses || []).forEach(function (course) {
                const timetable = course.timetable || {};
                const start = timetable.startMinute;
                const end = timetable.endMinute;
                if (!Number.isFinite(start) || !Number.isFinite(end)) return;

                const rooms = getRoomNames(course);
                const keys = rooms.length > 0 ? rooms : ["course:" + course.entno];

                FORECAST_BINS.forEach(function (binStart, i) {
                    const overlap = Math.min(end, binStart + BIN_MINUTES) -
                        Math.max(start, binStart);
                    if (overlap < BIN_MINUTES / 2) return;
                    keys.forEach(function (key) {
                        roomsByBin[i].set(
                            key,
                            key.startsWith("course:") ? DEFAULT_ROOM_CAPACITY : roomCapacity(key)
                        );
                    });
                });
            });
        }

        return {
            date: date,
            type: type,
            dow: calendar.effectiveDayCode || String(weekday),
            week: calendar.semesterClassIndex || null,
            calendar: {
                status: lectureData ? calendar.status || null : "unknown",
                week: calendar.semesterClassIndex || null,
                effectiveDayCode: calendar.effectiveDayCode || null,
                reason: calendar.reason || null
            },
            classPeople: roomsByBin.map(function (rooms) {
                let total = 0;
                rooms.forEach(function (capacity) { total += capacity; });
                return total * ENROLLMENT_RATE;
            })
        };
    }

    async function buildFeatures(dates) {
        const lectures = await getLecturesForDates(dates);
        const features = {};
        dates.forEach(function (date) {
            features[date] = buildFeature(date, lectures[date]);
        });
        return features;
    }

    /* 実測（5分データ → 30分平均） */

    function aggregateObserved(fromDate) {
        const sums = {};
        (getSnapshots() || []).forEach(function (snapshot) {
            if (!snapshot || snapshot.quality === "invalid") return;
            const measured = new Date(snapshot.measuredAt);
            if (Number.isNaN(measured.getTime())) return;
            const date = getTokyoDateString(measured);
            if (fromDate && date < fromDate) return;
            const parts = getTokyoTimeParts(measured);
            const minute = parts.hour * 60 + parts.minute;
            const index = Math.floor((minute - FORECAST_BINS[0]) / BIN_MINUTES);
            if (index < 0 || index >= FORECAST_BINS.length) return;

            if (!sums[date]) {
                sums[date] = FORECAST_BINS.map(function () { return { total: 0, count: 0 }; });
            }
            sums[date][index].total += snapshot.estimatedTotalDeviceCount / devicesPerPerson;
            sums[date][index].count += 1;
        });

        const result = {};
        Object.keys(sums).forEach(function (date) {
            result[date] = sums[date].map(function (cell) {
                return cell.count > 0
                    ? { value: cell.total / cell.count, count: cell.count }
                    : null;
            });
        });
        return result;
    }

    /* 学習 */

    function trainingRows(features, observed, now) {
        const today = getTokyoDateString(now);
        const parts = getTokyoTimeParts(now);
        const nowMinute = parts.hour * 60 + parts.minute;
        const rows = [];

        Object.keys(observed).forEach(function (date) {
            const feature = features[date];
            if (!feature || feature.calendar.status === "unknown" || date > today) return;
            observed[date].forEach(function (cell, i) {
                if (!cell || cell.count < MIN_TRAINING_SAMPLES) return;
                if (date === today && FORECAST_BINS[i] + BIN_MINUTES > nowMinute) return;
                rows.push({ feature: feature, bin: i, y: cell.value });
            });
        });
        return rows;
    }

    function fit(rows, prior) {
        const classBinsByDay = {};
        const closedDays = new Set();
        const weeks = new Set();
        rows.forEach(function (row) {
            if (row.feature.type === "class") {
                classBinsByDay[row.feature.date] = (classBinsByDay[row.feature.date] || 0) + 1;
            } else {
                closedDays.add(row.feature.date);
            }
        });
        const classDays = Object.keys(classBinsByDay).filter(function (date) {
            return classBinsByDay[date] >= MIN_TRAINING_BINS_PER_DAY;
        });
        const dowDays = {};
        rows.forEach(function (row) {
            if (row.feature.type !== "class" || !classDays.includes(row.feature.date)) return;
            weeks.add(row.feature.week);
            if (!dowDays[row.feature.dow]) dowDays[row.feature.dow] = new Set();
            dowDays[row.feature.dow].add(row.feature.date);
        });

        const fitKernel = classDays.length >= 3;
        const fitDow = classDays.length >= 8;
        const fitDecay = weeks.size >= 3;
        let stage = "prior";
        if (fitKernel) stage = "base_kernel";
        if (fitKernel && fitDow) stage = "dow";
        if (fitKernel && fitDecay) stage = "decay";

        const model = JSON.parse(JSON.stringify(prior));
        model.stage = stage;
        model.training = {
            classDays: classDays.length,
            closedDays: closedDays.size,
            weeks: weeks.size,
            rows: rows.length
        };
        if (rows.length === 0) return model;

        const positive = [];
        rows.forEach(function (row) {
            row.feature.classPeople.forEach(function (v) { if (v > 0) positive.push(v); });
        });
        const cScale = median(positive) || 1000;

        const nBase = FORECAST_BINS.length;
        const nParams = DAY_TYPES.length * nBase + LAGS.length;
        const kernelOffset = DAY_TYPES.length * nBase;

        function solveLinearPart() {
            const A = Array.from({ length: nParams }, function () { return new Array(nParams).fill(0); });
            const v = new Array(nParams).fill(0);

            rows.forEach(function (row) {
                const f = row.feature;
                const scale = classScale(model, f);
                const index = [DAY_TYPES.indexOf(f.type) * nBase + row.bin];
                const value = [1];
                for (let j = 0; j < LAGS.length; j += 1) {
                    const c = laggedClassPeople(f, row.bin, j);
                    if (c !== 0) { index.push(kernelOffset + j); value.push(scale * c); }
                }
                for (let a = 0; a < index.length; a += 1) {
                    v[index[a]] += value[a] * row.y;
                    for (let b = 0; b < index.length; b += 1) {
                        A[index[a]][index[b]] += value[a] * value[b];
                    }
                }
            });

            // ベース：事前値への引き寄せ（1日分相当）と、隣の枠とのなめらかさ
            DAY_TYPES.forEach(function (type, t) {
                for (let i = 0; i < nBase; i += 1) {
                    const p = t * nBase + i;
                    A[p][p] += 1;
                    v[p] += prior.base[type][i];
                    if (i + 1 < nBase) {
                        const q = p + 1, smooth = 0.5;
                        A[p][p] += smooth; A[q][q] += smooth;
                        A[p][q] -= smooth; A[q][p] -= smooth;
                    }
                }
            });

            // 前後の重み：学習しない段階では事前値に固定する
            const ridge = fitKernel ? cScale * cScale : 1e12 * cScale * cScale;
            const smooth = fitKernel ? 2 * cScale * cScale : 0;
            for (let j = 0; j < LAGS.length; j += 1) {
                const p = kernelOffset + j;
                A[p][p] += ridge;
                v[p] += ridge * prior.kernel[j];
                if (j + 1 < LAGS.length && smooth > 0) {
                    const q = p + 1;
                    A[p][p] += smooth; A[q][q] += smooth;
                    A[p][q] -= smooth; A[q][p] -= smooth;
                }
            }

            const x = solveLinearSystem(A, v);
            DAY_TYPES.forEach(function (type, t) {
                model.base[type] = x.slice(t * nBase, (t + 1) * nBase).map(function (value) {
                    return Math.max(0, value);
                });
            });
            model.kernel = x.slice(kernelOffset).map(function (value) { return Math.max(0, value); });
        }

        function objective() {
            let sse = 0;
            const cache = {};
            rows.forEach(function (row) {
                const date = row.feature.date;
                if (!cache[date]) cache[date] = predictDay(model, row.feature);
                const diff = row.y - cache[date][row.bin];
                sse += diff * diff;
            });
            let penalty = 0;
            Object.keys(model.dow).forEach(function (key) {
                penalty += 3e5 * Math.pow(model.dow[key] / 0.2, 2);
            });
            penalty += 3e5 * Math.pow(model.weekDecay / 0.1, 2);
            return sse + penalty;
        }

        solveLinearPart();
        if (fitDow || fitDecay) {
            for (let iteration = 0; iteration < 4; iteration += 1) {
                if (fitDow) {
                    Object.keys(dowDays).forEach(function (key) {
                        if (dowDays[key].size < 2) return;
                        model.dow[key] = goldenSection(function (value) {
                            model.dow[key] = value;
                            return objective();
                        }, -0.5, 0.5, 24);
                    });
                    // 月曜を基準（= 0）にそろえる
                    const reference = model.dow["1"] || 0;
                    Object.keys(model.dow).forEach(function (key) { model.dow[key] -= reference; });
                }
                if (fitDecay) {
                    model.weekDecay = goldenSection(function (value) {
                        model.weekDecay = value;
                        return objective();
                    }, -0.2, 0.05, 24);
                }
                solveLinearPart();
            }
        }
        return model;
    }

    /* 予報の保存 */

    async function loadRuns() {
        runs = [];
        try {
            const text = await fs.promises.readFile(forecastsPath, "utf8");
            const byIssue = new Map();
            text.split("\n").slice(1).forEach(function (line) {
                if (!line.trim()) return;
                const first = line.indexOf(",");
                const second = line.indexOf(",", first + 1);
                const third = line.indexOf(",", second + 1);
                const issuedAt = line.slice(0, first);
                const targetDate = line.slice(first + 1, second);
                const stage = line.slice(second + 1, third);
                const values = JSON.parse(line.slice(third + 1).replace(/^"|"$/g, ""));
                if (!byIssue.has(issuedAt)) {
                    byIssue.set(issuedAt, {
                        issuedAt: issuedAt,
                        issuedDate: getTokyoDateString(new Date(issuedAt)),
                        stage: stage,
                        byDate: {}
                    });
                }
                byIssue.get(issuedAt).byDate[targetDate] = values;
            });
            runs = Array.from(byIssue.values()).sort(function (a, b) {
                return a.issuedAt < b.issuedAt ? -1 : 1;
            });
        } catch (error) {
            runs = [];
        }

        try {
            const saved = JSON.parse(await fs.promises.readFile(paramsPath, "utf8"));
            if (saved && saved.base && saved.kernel) params = saved;
        } catch (error) {
            params = createPriorParams();
        }
    }

    function pruneRuns(today) {
        // 過去の日付については「その日より前に出た最後の予報」と
        // 「当日最初の予報」だけを残す。未来の日付は全部残す。
        const keep = new Set();
        const targets = new Set();
        runs.forEach(function (run) { Object.keys(run.byDate).forEach(function (d) { targets.add(d); }); });
        targets.forEach(function (target) {
            if (target >= today) return;
            const chosen = selectRun(target);
            if (chosen) keep.add(chosen.issuedAt + "|" + target);
        });
        runs.forEach(function (run) {
            Object.keys(run.byDate).forEach(function (target) {
                if (target < today && !keep.has(run.issuedAt + "|" + target)) {
                    delete run.byDate[target];
                }
            });
        });
        runs = runs.filter(function (run) { return Object.keys(run.byDate).length > 0; });
    }

    async function saveRuns() {
        const lines = ["issued_at,target_date,stage,values"];
        runs.forEach(function (run) {
            Object.keys(run.byDate).sort().forEach(function (target) {
                lines.push([
                    run.issuedAt,
                    target,
                    run.stage,
                    '"' + JSON.stringify(run.byDate[target]) + '"'
                ].join(","));
            });
        });
        const temporaryPath = forecastsPath + ".tmp";
        await fs.promises.writeFile(temporaryPath, lines.join("\n") + "\n", "utf8");
        await fs.promises.rename(temporaryPath, forecastsPath);
        await fs.promises.writeFile(paramsPath, JSON.stringify(params, null, 2), "utf8");
    }

    function selectRun(target) {
        // 前日までに出た最後の予報。なければ当日最初の予報。
        let dayBefore = null;
        let sameDay = null;
        runs.forEach(function (run) {
            if (!run.byDate[target]) return;
            if (run.issuedDate < target) dayBefore = run;
            else if (!sameDay) sameDay = run;
        });
        return dayBefore || sameDay;
    }

    function latestRun(target) {
        for (let i = runs.length - 1; i >= 0; i -= 1) {
            if (runs[i].byDate[target]) return runs[i];
        }
        return null;
    }

    function forecastFor(target, today) {
        const run = target <= today ? selectRun(target) : latestRun(target);
        if (!run) return null;
        return {
            values: run.byDate[target],
            issuedAt: run.issuedAt,
            stage: run.stage,
            basis: run.issuedDate < target ? "day_before" : "same_day"
        };
    }

    /* 実行 */

    async function runForecast(reason) {
        if (running) return running;
        running = (async function () {
            const now = new Date();
            const today = getTokyoDateString(now);
            const observed = aggregateObserved(addDays(today, -HISTORY_DAYS));
            const trainingDates = Object.keys(observed).sort();
            const forecastDates = dateRange(today, addDays(today, FORECAST_HORIZON_DAYS));
            const features = await buildFeatures(
                Array.from(new Set(trainingDates.concat(forecastDates)))
            );

            params = fit(trainingRows(features, observed, now), createPriorParams());
            params.trainedAt = now.toISOString();

            const run = {
                issuedAt: now.toISOString(),
                issuedDate: today,
                stage: params.stage,
                byDate: {}
            };
            forecastDates.forEach(function (date) {
                // 授業APIが取れなかった日は、授業なしと取り違えないよう予報しない。
                if (features[date].calendar.status === "unknown") return;
                run.byDate[date] = predictDay(params, features[date]).map(Math.round);
            });
            runs.push(run);
            pruneRuns(today);
            await saveRuns();
            console.log(
                "キャンパス人数の予報を作成しました（" + reason + "、" +
                STAGE_LABELS[params.stage] + "、授業日" + params.training.classDays + "日分）。"
            );
            return run;
        })();

        try {
            return await running;
        } finally {
            running = null;
        }
    }

    function msUntilNextDailyRun() {
        const parts = getTokyoTimeParts(new Date());
        const nowMinute = parts.hour * 60 + parts.minute + parts.second / 60;
        let minutes = DAILY_RUN_MINUTE - nowMinute;
        if (minutes <= 0) minutes += 24 * 60;
        return Math.round(minutes * 60 * 1000);
    }

    function scheduleDailyRun() {
        clearTimeout(timer);
        timer = setTimeout(async function () {
            try {
                await runForecast("毎晩の定期実行");
            } catch (error) {
                console.error("キャンパス人数の予報作成に失敗しました。", error);
            } finally {
                scheduleDailyRun();
            }
        }, msUntilNextDailyRun());
    }

    async function initialize() {
        await fs.promises.mkdir(dataDir, { recursive: true });
        await loadRuns();

        const today = getTokyoDateString(new Date());
        const hasToday = runs.some(function (run) { return run.issuedDate === today; });
        if (!hasToday) {
            // 起動を止めないよう、初回の予報はバックグラウンドで作る。
            runForecast("起動時").catch(function (error) {
                console.error("起動時のキャンパス人数の予報作成に失敗しました。", error);
            });
        }
        scheduleDailyRun();
    }

    /* 画面向けのデータ */

    function peakOf(values) {
        let index = 0;
        values.forEach(function (v, i) { if (v > values[index]) index = i; });
        return { value: values[index], minute: FORECAST_BINS[index] };
    }

    function maeOf(actual, forecast, date, today, nowMinute) {
        if (!actual || !forecast) return null;
        const errors = [];
        actual.forEach(function (cell, i) {
            if (!cell || cell.count < MIN_TRAINING_SAMPLES) return;
            if (date === today && FORECAST_BINS[i] + BIN_MINUTES > nowMinute) return;
            errors.push(Math.abs(cell.value - forecast.values[i]));
        });
        if (errors.length === 0) return null;
        return errors.reduce(function (a, b) { return a + b; }, 0) / errors.length;
    }

    async function describeDays(dates, now) {
        const today = getTokyoDateString(now);
        const parts = getTokyoTimeParts(now);
        const nowMinute = parts.hour * 60 + parts.minute;
        const observed = aggregateObserved(dates[0]);
        const features = await buildFeatures(dates);

        return dates.map(function (date) {
            const feature = features[date];
            const forecast = forecastFor(date, today);
            const actualCells = date <= today ? observed[date] || null : null;
            const actual = actualCells
                ? actualCells.map(function (cell) { return cell ? Math.round(cell.value) : null; })
                : null;
            const actualValues = actual ? actual.filter(function (v) { return v !== null; }) : [];
            const peak = forecast ? peakOf(forecast.values) : null;

            return {
                date: date,
                type: feature.type,
                calendar: feature.calendar,
                forecast: forecast,
                actual: actual,
                forecastPeak: peak ? peak.value : null,
                forecastPeakMinute: peak ? peak.minute : null,
                actualPeak: actualValues.length > 0 ? Math.max.apply(null, actualValues) : null,
                mae: maeOf(actualCells, forecast, date, today, nowMinute)
            };
        });
    }

    async function getOverview(now) {
        const today = getTokyoDateString(now);
        const parts = getTokyoTimeParts(now);
        const observedDates = Object.keys(aggregateObserved(addDays(today, -HISTORY_DAYS))).sort();
        const first = observedDates.length > 0 && observedDates[0] < today
            ? observedDates[0]
            : addDays(today, -7);
        const days = await describeDays(
            dateRange(first, addDays(today, FORECAST_HORIZON_DAYS)),
            now
        );

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

        // 品質が invalid の回（全建物が欠けた回など）は飛ばして、最後の有効な値を出す。
        const snapshots = getSnapshots() || [];
        let latest = null;
        for (let i = snapshots.length - 1; i >= 0 && !latest; i -= 1) {
            if (snapshots[i].quality !== "invalid") latest = snapshots[i];
        }

        return {
            generatedAt: now.toISOString(),
            today: today,
            nowMinute: parts.hour * 60 + parts.minute,
            bins: FORECAST_BINS,
            devicesPerPerson: devicesPerPerson,
            current: latest
                ? {
                    population: Math.round(latest.estimatedTotalDeviceCount / devicesPerPerson),
                    measuredAt: latest.measuredAt,
                    quality: latest.quality
                }
                : null,
            model: {
                stage: params.stage,
                stageLabel: STAGE_LABELS[params.stage],
                trainedAt: params.trainedAt,
                training: params.training,
                forecasting: Boolean(running)
            },
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

    async function getDay(date, now) {
        const today = getTokyoDateString(now);
        const parts = getTokyoTimeParts(now);
        const days = await describeDays([date], now);
        return Object.assign(days[0], {
            today: today,
            nowMinute: parts.hour * 60 + parts.minute,
            bins: FORECAST_BINS,
            model: { stage: params.stage, stageLabel: STAGE_LABELS[params.stage] }
        });
    }

    return {
        initialize: initialize,
        runForecast: runForecast,
        getOverview: getOverview,
        getDay: getDay
    };
}
