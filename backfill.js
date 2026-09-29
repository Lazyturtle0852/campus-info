import * as fs from "fs";
import * as path from "path";

/*
 * 5分ごとの取得が抜けた分を、/crowd?time=（過去の時刻も引ける）で取り直す。
 *
 * - 初回は BACKFILL_FROM の日から今までを、2秒に1回のペースで埋める（半日ほどかかる）。
 *   API が 429（呼びすぎ）や 5xx を返したら、しばらく待って同じ時刻を取り直す。
 * - 以降は6時間ごとに、直近2日分だけを見直す。
 * - どこまで見たかは backfill_state.json に残すので、再起動しても続きから始まる。
 * - 抜けた日の時間割も、授業APIから取っておく（学習用の表の x の元）。
 */

const SLOT_MS = 5 * 60 * 1000;
const RECHECK_MS = 48 * 60 * 60 * 1000;
const RUN_EVERY_MS = 6 * 60 * 60 * 1000;
// 学習に使うのは 7:00〜21:59。建物ごとの統計のために前後へ少し広げる。
const FIRST_HOUR = 6;
const LAST_HOUR = 22;
// 計測時刻より生データがこれ以上古ければ「その時刻のデータは無い」とみなす。
const STALE_RAW_MS = 15 * 60 * 1000;
const SAVE_STATE_EVERY = 50;
const RETRY_WAITS_MS = [30 * 1000, 60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000];

export function createBackfiller(options) {
    const statePath = path.join(options.dataDir, "backfill_state.json");
    const fromDate = options.from;
    const intervalMs = options.intervalMs || 2000;
    let running = false;
    let timer = null;
    let state = { checkedThrough: null, lastRun: null, current: null };

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

    function tokyoHour(date) {
        return (date.getUTCHours() + 9) % 24;
    }

    function hasRawData(crowdData) {
        if (!crowdData || !crowdData.latestRawAt || !crowdData.measuredAt) return false;
        const lag = new Date(crowdData.measuredAt) - new Date(crowdData.latestRawAt);
        return Number.isFinite(lag) && lag <= STALE_RAW_MS;
    }

    /* 429 や 5xx は相手の都合なので、待ってから同じ時刻をもう一度取りに行く。 */
    async function fetchWithRetry(slot) {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await options.fetchJson(
                    "https://api.dtc.wide.ad.jp/crowd?time=" + slot.toISOString(),
                    "キャンパス混雑情報（取り直し）"
                );
            } catch (error) {
                const status = error.upstreamStatus;
                const retryable = status === 429 || (status >= 500 && status < 600) || !status;
                if (!retryable || attempt >= RETRY_WAITS_MS.length) throw error;
                console.warn("取り直しを待ちます（" + (status || error.message) + "）: " +
                    RETRY_WAITS_MS[attempt] / 1000 + "秒");
                await sleep(RETRY_WAITS_MS[attempt]);
            }
        }
    }

    async function run() {
        if (running || !fromDate) return;
        running = true;
        const startedAt = new Date();
        const fromMs = new Date(fromDate + "T00:00:00+09:00").getTime();
        const resumeMs = state.checkedThrough
            ? new Date(state.checkedThrough).getTime() - RECHECK_MS
            : fromMs;
        let cursor = Math.ceil(Math.max(fromMs, resumeMs) / SLOT_MS) * SLOT_MS;
        const end = Math.floor((Date.now() - 10 * 60 * 1000) / SLOT_MS) * SLOT_MS;
        const counts = { checked: 0, saved: 0, empty: 0, failed: 0 };
        let lastDate = null;

        try {
            for (; cursor <= end; cursor += SLOT_MS) {
                const slot = new Date(cursor);
                const hour = tokyoHour(slot);
                if (hour < FIRST_HOUR || hour > LAST_HOUR) continue;

                const date = options.getTokyoDateString(slot);
                if (date !== lastDate) {
                    lastDate = date;
                    await options.ensureLectures(date).catch(function (error) {
                        console.error("過去の時間割の取得に失敗しました: " + date, error.message);
                    });
                }

                counts.checked += 1;
                if (options.hasSnapshotNear(slot.toISOString())) continue;

                try {
                    const crowdData = await fetchWithRetry(slot);
                    if (hasRawData(crowdData)) {
                        await options.ingest(crowdData);
                        counts.saved += 1;
                    } else {
                        counts.empty += 1;
                    }
                } catch (error) {
                    counts.failed += 1;
                    console.error("取り直しに失敗しました: " + slot.toISOString(), error.message);
                }

                if ((counts.saved + counts.empty + counts.failed) % SAVE_STATE_EVERY === 0) {
                    state.checkedThrough = slot.toISOString();
                    state.current = { startedAt: startedAt.toISOString(), ...counts };
                    await saveState();
                }
                await sleep(intervalMs);
            }
            state.checkedThrough = new Date(end).toISOString();
        } finally {
            state.current = null;
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
        // 起動直後の取得や学習用の読み込みとぶつからないよう、少し待ってから始める。
        schedule(60 * 1000);
    }

    function getStatus() {
        return {
            from: fromDate || null,
            running: running,
            checkedThrough: state.checkedThrough,
            current: state.current,
            lastRun: state.lastRun
        };
    }

    return { start: start, run: run, getStatus: getStatus };
}
