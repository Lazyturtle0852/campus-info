import * as fs from "fs";
import * as path from "path";

/*
 * 5分ごとの取得が抜けた分を、/crowd/range（期間を指定すると5分ごとの値をまとめて返す）で取り直す。
 *
 * - 1日（日本時間の0時〜24時）ずつ、1回の呼び出しで取る。初回は BACKFILL_FROM の日から今まで
 *   （2026-07-09 より前は API にデータが無い）。1日あたり数秒なので、全体でも数分で終わる。
 * - 以降は6時間ごとに、直近2日分だけを見直す。
 * - どこまで見たかは backfill_state.json に残すので、再起動しても続きから始まる。
 * - 抜けた日の時間割も、授業APIから取っておく（学習用の表の x の元）。
 */

const SLOT_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECHECK_DAYS = 2;
const RUN_EVERY_MS = 6 * 60 * 60 * 1000;
const PAUSE_BETWEEN_DAYS_MS = 3000;
const RETRY_WAITS_MS = [30 * 1000, 60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000];

export function createBackfiller(options) {
    const statePath = path.join(options.dataDir, "backfill_state.json");
    const fromDate = options.from;
    let running = false;
    let timer = null;
    let lastError = null;
    let progress = null;
    let state = { checkedThrough: null, lastRun: null };

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    async function loadState() {
        try {
            state = {
                ...state,
                ...JSON.parse(await fs.promises.readFile(statePath, "utf8"))
            };
        } catch (error) {
            // 初回はファイルが無い
        }
    }

    async function saveState() {
        const temporaryPath = statePath + ".tmp";
        await fs.promises.writeFile(temporaryPath, JSON.stringify(state, null, 2), "utf8");
        await fs.promises.rename(temporaryPath, statePath);
    }

    function addDays(date, days) {
        const d = new Date(date + "T12:00:00+09:00");
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
    }

    /* 429（呼びすぎ）・503（混雑）・5xx は相手の都合なので、待ってから同じ日をもう一度取る。 */
    async function fetchRange(start, end) {
        const url = "https://api.dtc.wide.ad.jp/crowd/range?startTime=" +
            start.toISOString() + "&endTime=" + end.toISOString();
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await options.fetchJson(url, "キャンパス混雑情報（期間）");
            } catch (error) {
                const status = error.upstreamStatus;
                const retryable = status === 429 || (status >= 500 && status < 600) || !status;
                if (!retryable || attempt >= RETRY_WAITS_MS.length) throw error;
                lastError = {
                    at: new Date().toISOString(),
                    range: start.toISOString(),
                    status: status || null,
                    waitSeconds: RETRY_WAITS_MS[attempt] / 1000
                };
                console.warn("取り直しを待ちます（" + (status || error.message) + "）: " +
                    RETRY_WAITS_MS[attempt] / 1000 + "秒");
                await sleep(RETRY_WAITS_MS[attempt]);
            }
        }
    }

    /*
     * /crowd/range の「建物ごとの時系列」を、/crowd と同じ形の5分ごとの値に組み直す。
     * 同じ5分枠に同じ建物の値が2つあれば、後のほうを使う。
     */
    function toSnapshots(body) {
        const slots = new Map();
        (body.readings || []).forEach(function (reading) {
            const times = reading.measuredAts || [];
            times.forEach(function (measuredAt, i) {
                const time = new Date(measuredAt).getTime();
                if (!Number.isFinite(time)) return;
                const slot = Math.floor(time / SLOT_MS) * SLOT_MS;
                if (!slots.has(slot)) slots.set(slot, { latestRaw: time, buildings: new Map() });
                const entry = slots.get(slot);
                entry.latestRaw = Math.max(entry.latestRaw, time);
                entry.buildings.set(reading.buildingKey, {
                    areaKey: reading.areaKey,
                    buildingKey: reading.buildingKey,
                    areaKeys: reading.areaKeys,
                    totalClientCount: (reading.totalClientCounts || [])[i] ?? null,
                    excludedClientCount: (reading.excludedClientCounts || [])[i] ?? null,
                    clientCount: (reading.clientCounts || [])[i] ?? null
                });
            });
        });
        return Array.from(slots.keys()).sort(function (a, b) { return a - b; }).map(function (slot) {
            const entry = slots.get(slot);
            return {
                type: "building-crowd-snapshot",
                generatedAt: body.generatedAt || null,
                measuredAt: new Date(slot).toISOString(),
                latestRawAt: new Date(entry.latestRaw).toISOString(),
                readings: Array.from(entry.buildings.values())
            };
        });
    }

    async function run() {
        if (running || !fromDate) return;
        running = true;
        const startedAt = new Date();
        const today = options.getTokyoDateString(startedAt);
        // 取り直しの開始日を変えたら、最初からやり直す
        if (state.from !== fromDate) {
            state = { from: fromDate, checkedThrough: null, lastRun: state.lastRun };
        }
        const resumeDate = state.checkedThrough
            ? addDays(options.getTokyoDateString(new Date(state.checkedThrough)), -RECHECK_DAYS)
            : fromDate;
        const counts = { days: 0, saved: 0, skipped: 0, failedDays: 0 };

        try {
            for (let date = resumeDate < fromDate ? fromDate : resumeDate; date <= today; date = addDays(date, 1)) {
                progress = { startedAt: startedAt.toISOString(), at: date, ...counts };
                await options.ensureLectures(date).catch(function (error) {
                    console.error("過去の時間割の取得に失敗しました: " + date, error.message);
                });

                const start = new Date(date + "T00:00:00+09:00");
                // 今日の分は、まだ処理が済んでいない直近10分を避ける
                const end = new Date(Math.min(start.getTime() + DAY_MS, Date.now() - 10 * 60 * 1000));
                if (end <= start) break;

                try {
                    const body = await fetchRange(start, end);
                    for (const snapshot of toSnapshots(body)) {
                        if (options.hasSnapshotNear(snapshot.measuredAt)) {
                            counts.skipped += 1;
                            continue;
                        }
                        await options.ingest(snapshot);
                        counts.saved += 1;
                    }
                    await options.flushStatistics();
                    state.checkedThrough = end.toISOString();
                    await saveState();
                } catch (error) {
                    counts.failedDays += 1;
                    console.error("取り直しに失敗しました: " + date, error.message);
                }
                counts.days += 1;
                await sleep(PAUSE_BETWEEN_DAYS_MS);
            }
        } finally {
            progress = null;
            state.lastRun = {
                startedAt: startedAt.toISOString(),
                finishedAt: new Date().toISOString(),
                ...counts
            };
            await saveState().catch(function () {});
            running = false;
            console.log("取り直しが終わりました。", state.lastRun);
        }
    }

    function schedule(delayMs) {
        clearTimeout(timer);
        timer = setTimeout(async function () {
            try {
                await run();
            } catch (error) {
                console.error("取り直しが止まりました。", error);
            } finally {
                schedule(RUN_EVERY_MS);
            }
        }, delayMs);
    }

    async function start() {
        await loadState();
        // 起動直後の取得とぶつからないよう、少し待ってから始める。
        schedule(30 * 1000);
    }

    function getStatus() {
        return {
            from: fromDate || null,
            running: running,
            checkedThrough: state.checkedThrough,
            current: progress,
            lastError: lastError,
            lastRun: state.lastRun
        };
    }

    return { start: start, run: run, getStatus: getStatus };
}
