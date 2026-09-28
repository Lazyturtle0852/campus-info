const DASHBOARD_REFRESH_INTERVAL_MS =
    5 * 60 * 1000;

let dashboardUpdateInProgress = false;

function getTokyoDateString() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date());

    function getPart(type) {
        return parts.find(function (part) {
            return part.type === type;
        }).value;
    }

    return [getPart("year"), getPart("month"), getPart("day")].join("-");
}

function getFormValue(form, name, defaultValue) {
    if (!form) return defaultValue;
    const field = form.elements.namedItem(name);
    if (!field || field.value === "") return defaultValue;
    return field.value;
}

async function getDashboardData(form) {
    const params = new URLSearchParams({
        date: getFormValue(form, "date", getTokyoDateString()),
        stopCode: getFormValue(form, "stopCode", "23955"),
        destination: getFormValue(form, "destination", "shonandai"),
        seatingRate: getFormValue(form, "seatingRate", "0.6"),
        devicesPerPerson: getFormValue(
            form,
            "devicesPerPerson",
            "2"
        ),
        departureRate: getFormValue(form, "departureRate", "0.3"),
        busUseRate: getFormValue(form, "busUseRate", "0.45"),
        routeShare: getFormValue(form, "routeShare", "1")
    });

    const startTime = getFormValue(form, "startTime", null);
    const endTime = getFormValue(form, "endTime", null);

    if (startTime) params.set("startTime", startTime);
    if (endTime) params.set("endTime", endTime);

    const response = await fetch(
        "/api/dashboard?" + params.toString()
    );

    if (!response.ok) {
        const body = await response.json().catch(function () {
            return {};
        });

        throw new Error(
            body.error || "データの取得に失敗しました。"
        );
    }

    return response.json();
}


function renderLectures(lectureData) {
    const output = document.getElementById("j_out");
    if (!output) return;

    output.replaceChildren();
    const summary = document.createElement("p");

    if (!lectureData.currentPeriodCode) {
        summary.textContent = "現在は授業時間外です。";
        output.appendChild(summary);
        return;
    }

    summary.textContent =
        "現在は" + lectureData.currentPeriodCode +
        "限です。推定出席人数: " +
        lectureData.estimatedAttendance + "人";
    output.appendChild(summary);

    const list = document.createElement("ul");
    lectureData.currentClasses.forEach(function (course) {
        const item = document.createElement("li");
        item.textContent = course.title || course.SBJTNM || "授業名不明";
        list.appendChild(item);
    });
    output.appendChild(list);

    if (lectureData.unknownRooms.length > 0) {
        const warning = document.createElement("p");
        warning.textContent =
            "定員不明の教室: " + lectureData.unknownRooms.join(", ");
        output.appendChild(warning);
    }
}

function renderBuses(busData, options, busWindow) {
    const output = document.getElementById(
        options.outputId
    );

    if (!output) return;

    if (!busData) {
        output.textContent =
            options.directionLabel +
            "のバス情報を取得できませんでした。";
        return;
    }

    let windowText;

    if (busWindow) {
        windowText =
            "系統。対象時間帯 " +
            busWindow.start.slice(0, 5) +
            " - " +
            busWindow.end.slice(0, 5) +
            " の輸送力は";
    } else {
        windowText =
            "系統。対象時間帯の輸送力は";
    }

    const nextBus = busData.nextBus;

    if (!nextBus) {
        output.textContent =
            "本日、この条件に一致する今後の" +
            options.directionLabel +
            "のバスはありません。";
        return;
    }

    const routeNames = Array.isArray(nextBus.buses)
        ? nextBus.buses.map(function (bus) {
            return bus.routeShortName || "系統不明";
        })
        : ["系統不明"];

    const departureTime =
        typeof nextBus.departureTime === "string"
            ? nextBus.departureTime.slice(0, 5)
            : "時刻不明";

    output.textContent =
        options.directionLabel +
        "の次のバスは" +
        nextBus.minutesUntil +
        "分後です。" +
        departureTime +
        "発、" +
        routeNames.join("・") +
        windowText +
        busData.transportCapacity +
        "人です。";
}

function formatSignedNumber(value) {
    if (!Number.isFinite(value)) {
        return "算出不能";
    }

    if (value > 0) {
        return "+" + value;
    }

    return String(value);
}

function getQualityLabel(quality) {
    const labels = {
        valid: "正常",
        warning: "参考値",
        invalid: "信頼性不足"
    };

    return labels[quality] || "品質不明";
}

function renderWifiChange(wifiChange) {
    const output = document.getElementById(
        "wifi_change"
    );

    /*
     * HTML側が未実装でもエラーにしない。
     */
    if (!output) return;

    if (!wifiChange) {
        output.textContent =
            "Wi-Fi接続数の差分データを取得できませんでした。";
        return;
    }

    if (wifiChange.status === "insufficient_data") {
        output.textContent =
            "Wi-Fi接続数の差分計算には" +
            "2回分の観測が必要です。";
        return;
    }

    if (!Number.isFinite(wifiChange.deviceDelta)) {
        output.textContent =
            "Wi-Fi接続数の差分を計算できませんでした。";
        return;
    }

    const populationDelta = formatSignedNumber(
        wifiChange.estimatedPopulationDelta
    );

    const deviceDelta = formatSignedNumber(
        wifiChange.deviceDelta
    );

    output.textContent =
        "推定人口変化: " +
        populationDelta +
        "人／接続デバイス変化: " +
        deviceDelta +
        "台（" +
        wifiChange.intervalMinutes +
        "分間、" +
        getQualityLabel(wifiChange.quality) +
        "）";
}

function renderCampusStock(campusStock) {
    const output = document.getElementById("message");

    if (!output) return;

    if (!campusStock) {
        output.textContent =
            "キャンパス滞在人数を取得できませんでした。";
        return;
    }

    let measuredAtText = "計測時刻不明";

    if (campusStock.measuredAt) {
        measuredAtText = new Intl.DateTimeFormat(
            "ja-JP",
            {
                timeZone: "Asia/Tokyo",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
            }
        ).format(
            new Date(campusStock.measuredAt)
        );
    }

    output.textContent =
        "キャンパス接続デバイス数: " +
        campusStock.connectedDeviceCount +
        "台／推定滞在人数: " +
        campusStock.estimatedPopulation +
        "人（1人平均" +
        campusStock.averageDevicesPerPerson +
        "台、" +
        measuredAtText +
        "）";

    if (
        campusStock.estimatedMissingDeviceCount > 0
    ) {
        output.textContent +=
            " ※欠損分" +
            campusStock.estimatedMissingDeviceCount +
            "台を過去データから補完しています。";
    }
}

function renderCrowding(crowding, options) {
    const settings = options || {};

    const summary = document.getElementById(
        settings.summaryId || "crowding_summary"
    );

    const levelOutput = document.getElementById(
        settings.levelId || "crowding_level"
    );

    const detailOutput = document.getElementById(
        settings.detailId || "crowding_detail"
    );

    if (!summary || !levelOutput || !detailOutput) {
        return;
    }

    const colors = {
        low: {
            background: "#dcfce7",
            color: "#166534"
        },
        moderate: {
            background: "#fef9c3",
            color: "#854d0e"
        },
        crowded: {
            background: "#ffedd5",
            color: "#9a3412"
        },
        over_capacity: {
            background: "#fee2e2",
            color: "#991b1b"
        },
        unavailable: {
            background: "#e5e7eb",
            color: "#374151"
        }
    };

    const level = crowding
        ? crowding.level
        : "unavailable";

    const color =
        colors[level] || colors.unavailable;

    summary.style.backgroundColor =
        color.background;

    summary.style.color =
        color.color;

    if (
        !crowding ||
        crowding.status !== "available"
    ) {
        levelOutput.textContent =
            crowding && crowding.label
                ? crowding.label
                : "算出不能";

        detailOutput.textContent =
            settings.unavailableMessage ||
            "対象時間帯に混雑度を計算できません。";

        return;
    }

    levelOutput.textContent =
        crowding.label;

    detailOutput.textContent =
        "予測需要 " +
        crowding.predictedDemand +
        "人／輸送力 " +
        crowding.transportCapacity +
        "人（混雑率 " +
        crowding.loadPercentage +
        "%）";

    if (crowding.excessDemand > 0) {
        detailOutput.textContent +=
            "・定員超過予測 " +
            crowding.excessDemand +
            "人";
    }
}

function renderError(error) {
    const message =
        "エラー: " + error.message;

    const lectureOutput =
        document.getElementById("j_out");

    const busOutput =
        document.getElementById("b_s_out");

    const inboundBusOutput =
        document.getElementById("b_to_sfc_out");

    const stockOutput =
        document.getElementById("message");

    const wifiOutput =
        document.getElementById("wifi_change");

    const outboundCrowdingOutput =
        document.getElementById("crowding_level");

    const inboundCrowdingOutput =
        document.getElementById(
            "inbound_crowding_level"
        );

    if (lectureOutput) {
        lectureOutput.textContent = message;
    }

    if (busOutput) {
        busOutput.textContent = message;
    }

    if (inboundBusOutput) {
        inboundBusOutput.textContent = message;
    }

    if (stockOutput) {
        stockOutput.textContent = message;
    }

    if (wifiOutput) {
        wifiOutput.textContent = message;
    }

    if (outboundCrowdingOutput) {
        outboundCrowdingOutput.textContent =
            "算出不能";
    }

    if (inboundCrowdingOutput) {
        inboundCrowdingOutput.textContent =
            "算出不能";
    }
}

async function updateDashboard(form) {
    if (dashboardUpdateInProgress) {
        return;
    }

    dashboardUpdateInProgress = true;

    try {
        const data =
            await getDashboardData(form);

        renderLectures(data.lectures);

        renderBuses(
            data.buses,
            {
                outputId: "b_s_out",
                directionLabel: "湘南台方面"
            },
            data.parameters.busWindow
        );

        renderBuses(
            data.inboundBuses,
            {
                outputId: "b_to_sfc_out",
                directionLabel: "SFC方面"
            },
            data.parameters.busWindow
        );

        renderCampusStock(
            data.campusStock
        );

        renderWifiChange(
            data.wifiChange
        );

        renderCrowding(
            data.inboundCrowding,
            {
                summaryId:
                    "inbound_crowding_summary",

                levelId:
                    "inbound_crowding_level",

                detailId:
                    "inbound_crowding_detail",

                unavailableMessage:
                    "Wi-Fi接続数の差分が" +
                    "2回分そろうと算出できます。"
            }
        );

        renderCrowding(
            data.crowding,
            {
                summaryId: "crowding_summary",
                levelId: "crowding_level",
                detailId: "crowding_detail"
            }
        );
    } catch (error) {
        console.error(error);
        renderError(error);
    } finally {
        dashboardUpdateInProgress = false;
    }
}

document.addEventListener("DOMContentLoaded", function () {
    const form = document.getElementById("myForm");

    if (form) {
        form.addEventListener("submit", function (event) {
            event.preventDefault();
            updateDashboard(form);
        });
    }

    updateDashboard(form);

    setInterval(function () {
        updateDashboard(form);
    }, DASHBOARD_REFRESH_INTERVAL_MS);

    document.addEventListener(
        "visibilitychange",
        function () {
            if (
                document.visibilityState === "visible"
            ) {
                updateDashboard(form);
            }
        }
    );
});