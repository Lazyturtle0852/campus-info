/*
 * バス混雑の予報。
 *
 * キャンパス人数の30分ごとの系列 N(t) の差分 Δ(t) = N(t+30) − N(t) を移動需要とみなす。
 *   Δ > 0：湘南台 → SFC に来た人。到着の TRAVEL_MINUTES 分前に湘南台を出た便に乗ったとする。
 *   Δ < 0：SFC → 湘南台 に帰った人。同じ枠に SFC を出る便に乗ったとする。
 * 需要 = |Δ| × バス利用率 を、その枠の便の定員合計と比べる。
 *
 * 人数の予報そのものは知らない。getCampusSeries と getDepartures を差し替えれば
 * 別の予報や時刻表でも動く。
 */

const DEFAULT_BUS_SHARE = 0.45;
const DEFAULT_TRAVEL_MINUTES = 20;

function minutesToTime(minutes) {
    const m = ((minutes % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, "0") + ":" +
        String(m % 60).padStart(2, "0");
}

function timeToMinutes(time) {
    const parts = String(time).split(":").map(Number);
    return parts[0] * 60 + parts[1] + (parts[2] || 0) / 60;
}

function classify(demand, capacity) {
    if (demand === null) {
        return { level: "unavailable", label: "算出待ち", loadPercentage: null };
    }
    if (capacity <= 0) {
        return demand > 0
            ? { level: "unavailable", label: "便なし", loadPercentage: null }
            : { level: "low", label: "需要なし", loadPercentage: null };
    }
    const load = demand / capacity;
    let level;
    let label;
    if (load < 0.5) {
        level = "low";
        label = "空いています";
    } else if (load < 0.8) {
        level = "moderate";
        label = "やや混雑";
    } else if (load <= 1) {
        level = "crowded";
        label = "混雑";
    } else {
        level = "over_capacity";
        label = "非常に混雑";
    }
    return { level: level, label: label, loadPercentage: Math.round(load * 100) };
}

function deltaAt(values, index) {
    if (!values) return null;
    const a = values[index];
    const b = values[index + 1];
    if (a === null || a === undefined || b === null || b === undefined) return null;
    return b - a;
}

export function createBusForecaster(options) {
    const getCampusSeries = options.getCampusSeries;
    const getDepartures = options.getDepartures;
    const capacities = options.capacities || {};
    const travelMinutes = options.travelMinutes === undefined
        ? DEFAULT_TRAVEL_MINUTES
        : options.travelMinutes;

    function departuresIn(departures, start, end) {
        return departures.filter(function (bus) {
            const minute = timeToMinutes(bus.departureTime);
            return minute >= start && minute < end;
        });
    }

    function buildDirection(direction, series, departures, busShare) {
        const inbound = direction === "to_sfc";
        const offset = inbound ? travelMinutes : 0;
        const slots = [];

        for (let i = 0; i + 1 < series.bins.length; i += 1) {
            const start = series.bins[i];
            const end = series.bins[i + 1];
            const busStart = start - offset;
            const busEnd = end - offset;
            const buses = departures ? departuresIn(departures, busStart, busEnd) : [];
            const capacity = buses.reduce(function (sum, bus) {
                return sum + (capacities[bus.routeShortName] || 0);
            }, 0);

            function toDemand(delta) {
                if (delta === null) return null;
                const moved = inbound ? Math.max(delta, 0) : Math.max(-delta, 0);
                return Math.round(moved * busShare);
            }

            const forecastDelta = deltaAt(series.forecast, i);
            const actualDelta = deltaAt(series.actual, i);
            const demand = toDemand(forecastDelta);
            const actualDemand = toDemand(actualDelta);

            slots.push(Object.assign({
                start: minutesToTime(start),
                end: minutesToTime(end),
                startMinute: start,
                busWindow: { start: minutesToTime(busStart), end: minutesToTime(busEnd) },
                forecastDelta: forecastDelta,
                actualDelta: actualDelta,
                demand: demand,
                actualDemand: actualDemand,
                buses: buses.length,
                capacity: capacity,
                perBus: demand !== null && buses.length > 0
                    ? Math.round(demand / buses.length)
                    : null,
                departures: buses.map(function (bus) {
                    return {
                        time: bus.departureTime.slice(0, 5),
                        route: bus.routeShortName
                    };
                }),
                unknownRoutes: buses
                    .filter(function (bus) { return !capacities[bus.routeShortName]; })
                    .map(function (bus) { return bus.routeShortName; }),
                actual: actualDemand === null ? null : classify(actualDemand, capacity)
            }, classify(demand, capacity)));
        }

        const rated = slots.filter(function (slot) { return slot.loadPercentage !== null; });
        const peak = rated.reduce(function (best, slot) {
            return !best || slot.loadPercentage > best.loadPercentage ? slot : best;
        }, null);

        return {
            direction: direction,
            available: Boolean(departures),
            totalDemand: series.forecast
                ? slots.reduce(function (sum, slot) { return sum + (slot.demand || 0); }, 0)
                : null,
            peak: peak
                ? { start: peak.start, end: peak.end, loadPercentage: peak.loadPercentage, level: peak.level, label: peak.label }
                : null,
            slots: slots
        };
    }

    async function getDay(date, requestOptions) {
        const busShare = requestOptions && requestOptions.busShare !== undefined
            ? requestOptions.busShare
            : DEFAULT_BUS_SHARE;
        const series = await getCampusSeries(date);

        async function safeDepartures(direction) {
            try {
                return await getDepartures(date, direction);
            } catch (error) {
                console.error("時刻表の取得に失敗しました（" + direction + "）。", error);
                return null;
            }
        }

        const departures = await Promise.all([
            safeDepartures("to_sfc"),
            safeDepartures("to_shonandai")
        ]);

        return {
            date: date,
            assumptions: { busShare: busShare, travelMinutes: travelMinutes },
            campus: series,
            toSfc: buildDirection("to_sfc", series, departures[0], busShare),
            toShonandai: buildDirection("to_shonandai", series, departures[1], busShare)
        };
    }

    return { getDay: getDay };
}
