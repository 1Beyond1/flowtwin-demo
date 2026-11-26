import { clockLabel, forecastStations, MAX_FORECAST_STATIONS } from "./forecast.mjs";
import { parseOptionalNumber } from "./number.mjs";

const MINUTES_PER_DAY = 24 * 60;
const VALID_ENERGY_TYPES = new Set(["electric", "fuel", "hybridElectric", "hybridFuel"]);
const DEFAULT_OFFSETS = Object.freeze([0, 30, 60, 90, 120]);
const MAX_OFFSETS = 8;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseClockMinutes(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour >= 24 || minute < 0 || minute >= 60) return null;
  return hour * 60 + minute;
}

function parseMinuteInput(value, fallback = 0) {
  const numeric = parseOptionalNumber(value);
  if (numeric !== null) return normalizeMinuteOfDay(numeric);
  const clock = parseClockMinutes(value);
  if (clock !== null) return clock;
  return normalizeMinuteOfDay(fallback);
}

function normalizeMinuteOfDay(value) {
  const rounded = Math.round(Number(value) || 0);
  const mod = rounded % MINUTES_PER_DAY;
  return mod < 0 ? mod + MINUTES_PER_DAY : mod;
}

function isFuelEnergy(energyType) {
  return energyType === "fuel" || energyType === "hybridFuel";
}

/**
 * Time-of-use (TOU) tariff multiplier for a given minute of day.
 * Fuel branches remain flat at 1.0; EV branches follow a standard 4-tier
 * valley / flat / peak / super-peak schedule.
 */
export function touTariffForMinute(minutes, energyType = "electric") {
  if (isFuelEnergy(energyType)) {
    return {
      tariffTier: "基准油价",
      tariffCode: "flat",
      touMultiplier: 1.0
    };
  }
  const m = parseMinuteInput(minutes, 0);
  if (m >= 23 * 60 || m < 7 * 60) {
    return {
      tariffTier: "谷时",
      tariffCode: "valley",
      touMultiplier: 0.68
    };
  }
  if (m >= 19 * 60 && m < 21 * 60) {
    return {
      tariffTier: "尖峰",
      tariffCode: "super-peak",
      touMultiplier: 1.38
    };
  }
  if ((m >= 10 * 60 && m < 15 * 60)
    || (m >= 18 * 60 && m < 19 * 60)
    || (m >= 21 * 60 && m < 22 * 60)) {
    return {
      tariffTier: "峰时",
      tariffCode: "peak",
      touMultiplier: 1.28
    };
  }
  return {
    tariffTier: "平时",
    tariffCode: "flat",
    touMultiplier: 1.0
  };
}

function normalizeOffsets(rawOffsets) {
  if (!Array.isArray(rawOffsets)) return DEFAULT_OFFSETS.slice();
  const seen = new Set();
  for (const item of rawOffsets) {
    const parsed = parseOptionalNumber(item);
    if (parsed === null) continue;
    seen.add(Math.round(clamp(parsed, 0, 360)));
  }
  if (!seen.size) return DEFAULT_OFFSETS.slice();
  seen.add(0);
  return Array.from(seen).sort((a, b) => a - b).slice(0, MAX_OFFSETS);
}

function formatRecommendation(bestWindow) {
  if (!bestWindow || bestWindow.offsetMinutes === 0) {
    return `当前出发窗口（${bestWindow?.departureClock || "00:00"}）综合排队与费用已最优，可直接出发`;
  }
  const waitPart = bestWindow.waitSavingVsNow >= 0.1
    ? `预计排队减少 ${bestWindow.waitSavingVsNow.toFixed(1)} 分钟`
    : bestWindow.waitSavingVsNow <= -0.1
      ? `预计排队增加 ${Math.abs(bestWindow.waitSavingVsNow).toFixed(1)} 分钟`
      : "预计排队基本持平";
  const costPart = bestWindow.costSavingVsNow >= 0.1
    ? `费用节省 ¥${bestWindow.costSavingVsNow.toFixed(1)}`
    : bestWindow.costSavingVsNow <= -0.1
      ? `费用增加 ¥${Math.abs(bestWindow.costSavingVsNow).toFixed(1)}`
      : "费用基本持平";
  return `建议推迟 ${bestWindow.offsetMinutes} 分钟（${bestWindow.departureClock} 出发）：${waitPart}，${costPart}（${bestWindow.tariffTier}）`;
}

/**
 * Evaluate multiple departure offsets for a target station, balancing
 * forecasted arrival queue (wait/P90), time-of-use energy cost, and delay.
 */
export function optimizeDepartureWindows(input = {}) {
  const safeInput = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const rawStations = Array.isArray(safeInput.stations)
    ? safeInput.stations.slice(0, MAX_FORECAST_STATIONS).filter((item) => item && typeof item === "object")
    : [];
  if (!rawStations.length) {
    throw Object.assign(new Error("STATIONS_REQUIRED"), { statusCode: 400 });
  }

  const requestedStationId = safeInput.stationId !== undefined && safeInput.stationId !== null
    ? String(safeInput.stationId).trim()
    : "";
  const targetStation = (requestedStationId
    ? rawStations.find((station) => station.id !== undefined && String(station.id) === requestedStationId)
    : null) || rawStations[0];

  const scenario = safeInput.scenario && typeof safeInput.scenario === "object" && !Array.isArray(safeInput.scenario)
    ? safeInput.scenario
    : {};
  const baseDepartureMinutes = parseMinuteInput(
    safeInput.baseDepartureMinutes ?? safeInput.departureMinutes ?? scenario.departureMinutes,
    0
  );
  const rawArrivalOffset = parseOptionalNumber(
    safeInput.arrivalOffsetMinutes
      ?? scenario.arrivalOffsetMinutes
      ?? targetStation.arrivalOffsetMinutes
      ?? targetStation.etaMinutes
  );
  const arrivalOffsetMinutes = Number(clamp(rawArrivalOffset ?? 20, 0, 720).toFixed(1));

  const energyType = VALID_ENERGY_TYPES.has(safeInput.energyType) ? safeInput.energyType : "electric";
  const fuelMode = isFuelEnergy(energyType);
  const rawUnits = parseOptionalNumber(safeInput.energyUnits);
  const energyUnits = Number(clamp(rawUnits ?? (fuelMode ? 25 : 32), 1, 300).toFixed(1));
  const offsets = normalizeOffsets(safeInput.offsets);

  const rawPrice = parseOptionalNumber(targetStation.price ?? targetStation.unitPrice);
  const baseUnitPrice = Number((rawPrice !== null && rawPrice > 0 ? rawPrice : (fuelMode ? 7.85 : 1.45)).toFixed(2));
  const horizonMinutes = Math.max(30, Math.min(240, Math.ceil(arrivalOffsetMinutes + 15)));

  const stationForForecast = {
    ...targetStation,
    arrivalOffsetMinutes
  };

  const draftWindows = offsets.map((offsetMinutes) => {
    const absoluteDeparture = baseDepartureMinutes + offsetMinutes;
    const departureMinutes = normalizeMinuteOfDay(absoluteDeparture);
    const departureClock = clockLabel(absoluteDeparture);
    const arrivalAbsolute = absoluteDeparture + arrivalOffsetMinutes;
    const arrivalClock = clockLabel(arrivalAbsolute);

    const forecastResult = forecastStations([stationForForecast], {
      ...scenario,
      departureMinutes: absoluteDeparture,
      arrivalOffsetMinutes,
      horizonMinutes
    });
    const stationForecast = forecastResult.stations[0] || {};
    const prediction = stationForecast.arrivalForecast || stationForecast.prediction || stationForecast.baseline || {};
    const waitMinutes = Number((parseOptionalNumber(prediction.wait ?? stationForecast.wait) ?? 0).toFixed(1));
    const p50Minutes = Number((parseOptionalNumber(prediction.p50 ?? stationForecast.p50) ?? 0).toFixed(1));
    const p90Minutes = Number((parseOptionalNumber(prediction.p90 ?? stationForecast.p90) ?? 0).toFixed(1));
    const occupancy = Number((parseOptionalNumber(prediction.occupancy ?? stationForecast.baseline?.occupancy ?? targetStation.occupancy) ?? 0.5).toFixed(3));
    const risk = prediction.risk || (p90Minutes >= 20 || occupancy >= 0.82 ? "forecast-risk" : "forecast-ready");

    const tariff = touTariffForMinute(arrivalAbsolute, energyType);
    const unitPrice = Number((baseUnitPrice * tariff.touMultiplier).toFixed(2));
    const estimatedEnergyCost = Number((unitPrice * energyUnits).toFixed(1));
    const score = Number((p90Minutes * 0.7 + waitMinutes * 0.5 + estimatedEnergyCost * 0.25 + offsetMinutes * 0.04).toFixed(2));

    return {
      offsetMinutes,
      label: offsetMinutes === 0 ? "现在" : `+${offsetMinutes}分`,
      departureMinutes,
      departureClock,
      arrivalClock,
      waitMinutes,
      p50Minutes,
      p90Minutes,
      occupancy,
      risk,
      tariffTier: tariff.tariffTier,
      tariffCode: tariff.tariffCode,
      touMultiplier: tariff.touMultiplier,
      baseUnitPrice,
      unitPrice,
      estimatedEnergyCost,
      waitSavingVsNow: 0,
      p90SavingVsNow: 0,
      costSavingVsNow: 0,
      score,
      isCurrent: offsetMinutes === 0,
      isRecommended: false
    };
  });

  const baseline = draftWindows.find((item) => item.offsetMinutes === 0) || draftWindows[0];
  const windows = draftWindows.map((item) => ({
    ...item,
    waitSavingVsNow: Number((baseline.waitMinutes - item.waitMinutes).toFixed(1)),
    p90SavingVsNow: Number((baseline.p90Minutes - item.p90Minutes).toFixed(1)),
    costSavingVsNow: Number((baseline.estimatedEnergyCost - item.estimatedEnergyCost).toFixed(1))
  }));

  const currentWindow = windows.find((item) => item.offsetMinutes === 0) || windows[0];
  const lowestScoreWindow = windows.reduce((best, item) => {
    if (item.score < best.score - 1e-9) return item;
    if (Math.abs(item.score - best.score) <= 1e-9 && item.offsetMinutes < best.offsetMinutes) return item;
    return best;
  }, currentWindow);

  const recommendedTarget = lowestScoreWindow.offsetMinutes !== 0
    && lowestScoreWindow.waitSavingVsNow < 1.2
    && lowestScoreWindow.costSavingVsNow < 1.5
    ? currentWindow
    : lowestScoreWindow;

  for (const item of windows) {
    item.isRecommended = item.offsetMinutes === recommendedTarget.offsetMinutes;
  }

  const bestWindow = windows.find((item) => item.isRecommended) || currentWindow;
  const stationId = String(targetStation.id ?? "station-0");
  const stationName = String(targetStation.name ?? "补能站").slice(0, 100);

  return {
    stationId,
    stationName,
    energyType,
    energyUnits,
    baseDepartureMinutes,
    baseDepartureClock: clockLabel(baseDepartureMinutes),
    arrivalOffsetMinutes,
    windows,
    bestWindow,
    recommendation: formatRecommendation(bestWindow),
    assumptions: {
      description: "基于 FlowTwin 站点排队仿真与演示分时电价曲线，评估不同推迟出发窗口的到站排队和补能费用综合代价。",
      touSchedule: fuelMode
        ? "燃油模式按基准油价（1.0x）计价，不受分时电价倍率影响。"
        : "谷时 23:00-07:00（0.68x）、平时 07:00-10:00/15:00-18:00/22:00-23:00（1.00x）、峰时 10:00-15:00/18:00-19:00/21:00-22:00（1.28x）、尖峰 19:00-21:00（1.38x），按预计到站时刻计价。",
      scoreFormula: "score = p90*0.7 + wait*0.5 + estimatedEnergyCost*0.25 + offsetMinutes*0.04（越低越优；若相比现在排队节省 < 1.2 分钟且费用节省 < ¥1.5，保持立即出发）。"
    }
  };
}
