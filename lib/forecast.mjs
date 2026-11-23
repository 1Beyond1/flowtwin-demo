import { parseOptionalNumber } from "./number.mjs";

const MINUTES_PER_DAY = 24 * 60;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// 等待时间分位数的形状参数。p50/p90 都由同一个 wait 派生，而 operator.mjs 还要
// 反着来——把前端送过来的 p90 还原成模型口径的 wait。这里原本写 1.68、运营端写
// 1.65，同一个站点在预测页和运营页因此挂着两条不同的分布，反解时又按 1.65 去
// 解 1.68 生成的数。统一到一处，两边至少在说同一件事。
export const WAIT_P50_FACTOR = 0.82;
export const WAIT_P90_FACTOR = 1.65;
export const WAIT_P90_OFFSET = 3;
export const SIMULATION_SOURCE = "simulation";
export const SIMULATION_CONFIDENCE = "simulation-only";
export const waitToP50 = (wait) => wait * WAIT_P50_FACTOR;
export const waitToP90 = (wait) => wait * WAIT_P90_FACTOR + WAIT_P90_OFFSET;
export const p90ToWait = (p90) => (p90 - WAIT_P90_OFFSET) / WAIT_P90_FACTOR;

export const MAX_FORECAST_STATIONS = 60;
export const MAX_FORECAST_POINTS = 61;
export const MAX_PORTS = 200;
export const MAX_QUEUE_VEHICLES = 500;
const MAX_STATION_SIMULATION_EVENTS = 1500;
const MAX_TOTAL_SIMULATION_EVENTS = 30000;
const MAX_FRESHNESS_SECONDS = 7 * 24 * 60 * 60;
const MAX_SIMULATION_WAIT_MINUTES = 240;
const PORT_STATE_FIELDS = ["idlePorts", "chargingPorts", "faultPorts"];
const PORT_RESERVATION_FIELDS = ["reservedPorts", "reservationQueueAhead", "waitingVehicles"];
const PORT_STATE_INPUTS = {
  idlePorts: ["idlePorts", "availableUnits"],
  chargingPorts: ["chargingPorts", "occupiedUnits"],
  faultPorts: ["faultPorts", "faultUnits"]
};

function confidenceLevel(score) {
  return score >= 76 ? "high" : score >= 56 ? "medium" : "low";
}

function confidenceLabel(score, sourceKind = "simulation") {
  const level = confidenceLevel(score);
  const label = sourceKind === "enterprise-prior" ? "企业先验+仿真" : "演示口径";
  return `${level === "high" ? "高" : level === "medium" ? "中" : "低"}（${label}）`;
}

/**
 * `confidence` remains the backwards-compatible source label
 * (`simulation-only`).  The actual, explainable confidence is exposed beside
 * it so the UI does not have to pretend that every simulated point is 96% or
 * that a synthetic result has the same evidence as a complete port snapshot.
 */
export function deriveForecastConfidence({
  method = "aggregate-flow-simulation",
  station = {},
  arrivalOffsetMinutes = 0,
  horizonMinutes = 30,
  demandFactor = 1,
  trafficFactor = 1,
  weatherFactor = 1,
  enterprisePrior = null
} = {}) {
  let score = 52;
  const reasons = ["演示仿真，不含能链实时经营样本"];
  const hasEnterprisePrior = Boolean(enterprisePrior?.matched);
  if (hasEnterprisePrior) {
    score += 8;
    reasons.push("使用企业生产拟合数据的城市×油电类型×小时需求先验");
    const matchDistance = parseOptionalNumber(enterprisePrior.matchDistanceKm);
    if (matchDistance !== null && matchDistance > 80) {
      score -= 7;
      reasons.push("企业先验按最近城市中心近似匹配");
    }
  }
  const port = station?.portSnapshot;
  if (method === "port-discrete-event" && port) {
    score += 14;
    reasons.push("使用端口级状态和排队字段");
    const complete = [
      port.totalPorts,
      port.idlePorts,
      port.chargingPorts,
      port.faultPorts,
      port.queueVehicles,
      port.averageSessionMinutes,
      port.reservationQueueAhead
    ].every((value) => parseOptionalNumber(value) !== null);
    if (complete) {
      score += 8;
      reasons.push("端口分区字段完整");
    } else {
      score -= 8;
      reasons.push("部分端口或预约队列字段由规则补全");
    }
    const freshness = parseOptionalNumber(port.freshnessSeconds);
    if (freshness !== null) {
      if (freshness <= 15 * 60) {
        score += 5;
        reasons.push("输入快照较新");
      } else if (freshness > 60 * 60) {
        score -= 8;
        reasons.push("输入快照偏旧");
      }
    } else {
      reasons.push("未提供真实时间戳");
    }
  } else {
    score += 4;
    reasons.push("使用聚合流量近似");
    if (parseOptionalNumber(station?.capacity) === null
      || parseOptionalNumber(station?.arrivalRate) === null
      || parseOptionalNumber(station?.serviceRate) === null) {
      score -= 8;
      reasons.push("部分聚合字段使用演示默认值");
    }
  }

  const offset = Math.max(0, parseOptionalNumber(arrivalOffsetMinutes) ?? 0);
  const horizon = Math.max(1, parseOptionalNumber(horizonMinutes) ?? 30);
  if (offset <= horizon) {
    score += 10;
    reasons.push("到站时间在预测窗口内");
  } else {
    score -= 18;
    reasons.push(`到站时间超出 ${horizon} 分钟预测窗口`);
  }
  if ([demandFactor, trafficFactor, weatherFactor].every((value) => parseOptionalNumber(value) !== null)) {
    score += 3;
    reasons.push("已纳入时段、路况和天气因子");
  }
  score = Math.round(clamp(score, 25, 88));
  const level = confidenceLevel(score);
  return {
    score,
    level,
    label: confidenceLabel(score, hasEnterprisePrior ? "enterprise-prior" : "simulation"),
    reasons
  };
}

function hash(value) {
  let result = 2166136261;
  for (const character of String(value || "station")) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function number(value, fallback, min = 0, max = Number.POSITIVE_INFINITY) {
  const result = parseOptionalNumber(value);
  return result !== null ? clamp(result, min, max) : fallback;
}

function minuteOfDay(value, fallback = 0) {
  const result = parseOptionalNumber(value);
  if (result === null) return fallback;
  const normalized = result % MINUTES_PER_DAY;
  return normalized < 0 ? normalized + MINUTES_PER_DAY : normalized;
}

export function clockLabel(minutes) {
  const totalMinutes = minuteOfDay(Math.round(minuteOfDay(minutes)));
  const hour = Math.floor(totalMinutes / 60).toString().padStart(2, "0");
  const minute = (totalMinutes % 60).toString().padStart(2, "0");
  return `${hour}:${minute}`;
}

function simulationAsOf(departureMinutes) {
  // Do not use Date.now(): a deterministic simulation is easier to test and is
  // less likely to be mistaken for a live operational timestamp.
  return `simulation@${clockLabel(departureMinutes)}`;
}

function parseClock(value) {
  const match = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return Number.NaN;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60
    ? hour * 60 + minute
    : Number.NaN;
}

function valueForStation(mapping, station, fallback = Number.NaN) {
  if (!mapping || typeof mapping !== "object") return fallback;
  const keys = [station?.id, station?.name].filter((value) => value !== undefined && value !== null).map(String);
  for (const key of keys) {
    const parsed = parseOptionalNumber(mapping[key]);
    if (parsed !== null) return parsed;
  }
  return fallback;
}

/**
 * Resolve the expected offset from departure to a station.  The aliases are
 * intentional: older callers sent etaMinutes/arrivalMinute while the newer
 * planner uses arrivalOffsetMinutes.  An absolute arrivalMinute is converted
 * into a forward same-day offset so midnight crossings remain harmless.
 */
export function stationArrivalOffset(station = {}, scenario = {}) {
  const mapped = valueForStation(
    scenario.arrivalOffsets || scenario.etaByStation || scenario.arrivalByStation,
    station
  );
  const direct = [
    mapped,
    station.arrivalOffsetMinutes,
    station.arrivalOffset,
    station.etaOffsetMinutes,
    station.etaMinutes,
    station.eta,
    station.travelMinutes,
    scenario.arrivalOffsetMinutes,
    scenario.arrivalMinutes,
    scenario.etaMinutes
  ].map(parseOptionalNumber).find((value) => value !== null);
  if (direct !== undefined && direct !== null) return Math.max(0, direct);

  const departureParsed = parseOptionalNumber(scenario.departureMinutes);
  const departureValue = departureParsed !== null
    ? departureParsed
    : parseClock(scenario.departureMinutes);
  const departure = minuteOfDay(departureValue, 0);
  const absolute = [station.arrivalMinute, station.arrivalAtMinutes]
    .map(parseOptionalNumber)
    .find((value) => value !== null);
  if (absolute !== undefined && absolute !== null) {
    let offset = absolute - departure;
    if (offset < 0) offset += MINUTES_PER_DAY;
    return Math.max(0, offset);
  }

  const arrivalClock = parseClock(station.arrivalAt || station.arrivalTime || (typeof station.eta === "string" ? station.eta : ""));
  if (Number.isFinite(arrivalClock)) {
    let offset = arrivalClock - departure;
    if (offset < 0) offset += MINUTES_PER_DAY;
    return Math.max(0, offset);
  }
  return 0;
}

function pointMinute(point, fallback = Number.NaN) {
  const value = [point?.minute, point?.offsetMinutes, point?.arrivalOffsetMinutes, point?.arrivalOffset, point?.etaMinutes, point?.eta, point?.arrivalMinutes, point?.offset]
    .map(parseOptionalNumber)
    .find((item) => item !== null);
  return value !== undefined && value !== null ? value : fallback;
}

function finitePointValue(point, key, fallback = Number.NaN) {
  const value = parseOptionalNumber(point?.[key]);
  return value !== null ? value : fallback;
}

function normalizePredictionPoint(point = {}, fallback = {}, metadata = {}) {
  const fallbackWait = parseOptionalNumber(fallback.wait)
    ?? parseOptionalNumber(fallback.p50)
    ?? 0;
  const wait = Math.max(0, finitePointValue(point, "wait", fallbackWait));
  const p50 = Math.max(0, finitePointValue(point, "p50", waitToP50(wait)));
  const p90 = Math.max(p50, finitePointValue(point, "p90", waitToP90(wait)));
  const pointConfidenceScore = parseOptionalNumber(point.confidenceScore);
  const metadataConfidenceScore = parseOptionalNumber(metadata.confidenceScore);
  const pointHorizon = parseOptionalNumber(point.horizonMinutes);
  return {
    ...point,
    wait: Number(wait.toFixed(1)),
    p50: Number(p50.toFixed(1)),
    p90: Number(p90.toFixed(1)),
    asOf: point.asOf || metadata.asOf || SIMULATION_SOURCE,
    source: point.source || metadata.source || SIMULATION_SOURCE,
    confidence: point.confidence || metadata.confidence || SIMULATION_CONFIDENCE,
    confidenceScore: pointConfidenceScore ?? metadataConfidenceScore ?? null,
    confidenceLevel: point.confidenceLevel || metadata.confidenceLevel || null,
    confidenceLabel: point.confidenceLabel || metadata.confidenceLabel || null,
    confidenceReasons: Array.isArray(point.confidenceReasons)
      ? point.confidenceReasons.slice(0, 8)
      : Array.isArray(metadata.confidenceReasons) ? metadata.confidenceReasons.slice(0, 8) : [],
    horizonMinutes: pointHorizon ?? metadata.horizonMinutes
  };
}

/**
 * Pick the prediction that applies at an arrival offset.  Linear interpolation
 * avoids a discontinuity when a route ETA falls between the five-minute sample
 * points; outside the published horizon the closest point is used and the
 * requested offset is retained for auditability.
 */
export function selectForecastPoint(forecast = [], arrivalOffsetMinutes = 0) {
  if (!Array.isArray(forecast) || !forecast.length) return null;
  const points = forecast
    .map((point, index) => ({ point, minute: pointMinute(point, index) }))
    .filter(({ minute }) => Number.isFinite(minute))
    .sort((a, b) => a.minute - b.minute);
  if (!points.length) return null;
  const requested = Math.max(0, parseOptionalNumber(arrivalOffsetMinutes) ?? 0);
  const exact = points.find(({ minute }) => Math.abs(minute - requested) < 1e-9);
  if (exact) {
    return {
      ...exact.point,
      minute: exact.minute,
      requestedOffsetMinutes: requested,
      interpolated: false
    };
  }
  if (requested <= points[0].minute) {
    return {
      ...points[0].point,
      minute: points[0].minute,
      requestedOffsetMinutes: requested,
      interpolated: false
    };
  }
  if (requested >= points.at(-1).minute) {
    return {
      ...points.at(-1).point,
      minute: points.at(-1).minute,
      requestedOffsetMinutes: requested,
      interpolated: false
    };
  }

  const upperIndex = points.findIndex(({ minute }) => minute > requested);
  const lower = points[upperIndex - 1];
  const upper = points[upperIndex];
  const ratio = (requested - lower.minute) / Math.max(1e-9, upper.minute - lower.minute);
  const result = { ...lower.point };
  ["wait", "p50", "p90", "occupancy", "arrivalRate", "serviceRate", "confidenceScore"].forEach((key) => {
    const lowerValue = parseOptionalNumber(lower.point?.[key]);
    const upperValue = parseOptionalNumber(upper.point?.[key]);
    if (lowerValue !== null && upperValue !== null) {
      result[key] = Number((lowerValue + (upperValue - lowerValue) * ratio).toFixed(1));
    }
  });
  const interpolatedConfidence = parseOptionalNumber(result.confidenceScore);
  return {
    ...result,
    minute: Number(requested.toFixed(1)),
    requestedOffsetMinutes: requested,
    interpolated: true,
    asOf: lower.point.asOf,
    source: lower.point.source,
    confidence: lower.point.confidence || upper.point.confidence,
    confidenceLevel: interpolatedConfidence !== null
      ? confidenceLevel(interpolatedConfidence)
      : lower.point.confidenceLevel || upper.point.confidenceLevel || null,
    confidenceLabel: interpolatedConfidence !== null
      ? confidenceLabel(interpolatedConfidence)
      : lower.point.confidenceLabel || upper.point.confidenceLabel || null,
    confidenceReasons: Array.from(new Set([
      ...(Array.isArray(lower.point.confidenceReasons) ? lower.point.confidenceReasons : []),
      ...(Array.isArray(upper.point.confidenceReasons) ? upper.point.confidenceReasons : [])
    ])).slice(0, 8),
    horizonMinutes: lower.point.horizonMinutes ?? upper.point.horizonMinutes
  };
}

function normalizeStation(station, index) {
  const seed = hash(`${station?.id || station?.name || "station"}-${index}`);
  const occupancy = number(station?.occupancy, 0.45 + (seed % 30) / 100, 0.05, 0.96);
  const wait = number(station?.wait ?? station?.p50, 5 + (seed % 8), 0, 120);
  const capacity = number(station?.capacity, 12 + (seed % 13), 1, 500);
  const enterpriseDemandFactor = number(station?.enterpriseDemandFactor, 1, 0.65, 1.45);
  const baseArrivalRate = number(station?.arrivalRate, 1.2 + (seed % 20) / 10, 0, 100);
  const arrivalRate = number(baseArrivalRate * enterpriseDemandFactor, baseArrivalRate, 0, 100);
  const serviceRate = number(station?.serviceRate, 1.6 + (seed % 16) / 10, 0.1, 100);
  const trend = number(station?.trend, ((seed % 9) - 4) / 1000, -0.02, 0.02);
  const portSnapshot = normalizePortSnapshot(station, serviceRate);
  return {
    id: String(station?.id || `station-${index}`),
    name: String(station?.name || `补能站 ${index + 1}`).slice(0, 100),
    type: String(station?.type || "充电站").slice(0, 30),
    location: station?.location ?? null,
    address: String(station?.address || "").slice(0, 160),
    stationSource: String(station?.source || "演示输入").slice(0, 80),
    price: number(station?.price, 0, 0, 1000),
    detour: number(station?.detour, 0, 0, 1000),
    occupancy,
    wait,
    p50: number(station?.p50, waitToP50(wait), 0, 180),
    p90: number(station?.p90, waitToP90(wait), 0, 300),
    capacity,
    baseArrivalRate,
    arrivalRate,
    enterpriseDemandFactor,
    enterprisePrior: station?.enterprisePrior?.matched ? station.enterprisePrior : null,
    serviceRate,
    trend,
    seed,
    arrivalOffsetMinutes: stationArrivalOffset(station, scenarioForStation(station)),
    portSnapshot
  };
}

function hasInputValue(value, key) {
  return Boolean(
    value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, key) &&
    value[key] !== undefined && value[key] !== null && value[key] !== ""
  );
}

function firstInputValue(value, keys = []) {
  for (const key of keys) {
    if (hasInputValue(value, key)) return value[key];
  }
  return undefined;
}

function boundedInteger(value, fallback, min, max) {
  const numeric = parseOptionalNumber(value);
  return numeric !== null ? clamp(Math.round(numeric), min, max) : fallback;
}

function boundedText(value, max = 120) {
  if (value === undefined || value === null) return null;
  const result = String(value).trim().slice(0, max);
  return result || null;
}

function normalizeReleaseMinutes(value, totalPorts) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_PORTS)
    .map(parseOptionalNumber)
    .filter((item) => item !== null)
    .slice(0, Math.min(MAX_PORTS, Math.max(0, totalPorts)))
    .map((item) => Number(clamp(item, 0, 240).toFixed(1)));
}

/**
 * Port-level inputs are optional.  The marker is deliberately based only on
 * fields supplied by the caller; legacy `capacity`/`occupancy` must continue
 * to use the aggregate model rather than silently becoming a port model.
 */
function hasPortInput(station) {
  const totalValue = parseOptionalNumber(firstInputValue(station, ["totalPorts", "totalUnits"]));
  const hasTotal = totalValue !== null && totalValue > 0;
  const hasStateField = PORT_STATE_FIELDS.some((key) => (
    parseOptionalNumber(firstInputValue(station, PORT_STATE_INPUTS[key])) !== null
  ));
  const hasReservationField = PORT_RESERVATION_FIELDS.some((key) => (
    parseOptionalNumber(firstInputValue(station, [key, key.replace("Ports", "Units")])) !== null
  ));
  const releaseCount = Array.isArray(station?.estimatedReleaseMinutes)
    ? station.estimatedReleaseMinutes.slice(0, MAX_PORTS).map(parseOptionalNumber).filter((item) => item !== null).length
    : 0;
  if (!hasStateField && releaseCount === 0) return false;
  // A reservation count without capacity/physical state is not enough to
  // activate the port model. It must not silently turn a legacy aggregate
  // station into a fake port snapshot.
  if (!hasStateField && !hasTotal && hasReservationField) return false;
  if (hasTotal) return true;

  const stateTotal = PORT_STATE_FIELDS.reduce((sum, key) => {
    const value = firstInputValue(station, PORT_STATE_INPUTS[key]);
    if (parseOptionalNumber(value) === null) return sum;
    return sum + boundedInteger(value, 0, 0, MAX_PORTS);
  }, 0);
  return stateTotal > 0 || releaseCount > 0;
}

function normalizePortSnapshot(station, legacyServiceRate) {
  if (!hasPortInput(station)) return null;

  const rawRelease = Array.isArray(station?.estimatedReleaseMinutes)
    ? station.estimatedReleaseMinutes.slice(0, MAX_PORTS)
    : [];
  const explicitIdle = parseOptionalNumber(firstInputValue(station, ["idlePorts", "availableUnits"])) !== null;
  const explicitCharging = parseOptionalNumber(firstInputValue(station, ["chargingPorts", "occupiedUnits"])) !== null;
  const explicitFault = parseOptionalNumber(firstInputValue(station, ["faultPorts", "faultUnits"])) !== null;
  const rawCounts = [
    explicitIdle ? boundedInteger(firstInputValue(station, ["idlePorts", "availableUnits"]), 0, 0, MAX_PORTS) : 0,
    explicitCharging ? boundedInteger(firstInputValue(station, ["chargingPorts", "occupiedUnits"]), 0, 0, MAX_PORTS) : 0,
    explicitFault ? boundedInteger(firstInputValue(station, ["faultPorts", "faultUnits"]), 0, 0, MAX_PORTS) : 0
  ];
  const releaseCount = rawRelease
    .map(parseOptionalNumber)
    .filter((item) => item !== null)
    .length;
  const derivedTotal = rawCounts[0] + Math.max(rawCounts[1], releaseCount) + rawCounts[2];
  const totalValue = parseOptionalNumber(firstInputValue(station, ["totalPorts", "totalUnits"]));
  const explicitTotal = totalValue !== null && totalValue > 0;
  const totalPorts = explicitTotal
    ? boundedInteger(totalValue, 1, 1, MAX_PORTS)
    : boundedInteger(derivedTotal, 1, 1, MAX_PORTS);

  const chargingCandidate = explicitCharging
    ? boundedInteger(firstInputValue(station, ["chargingPorts", "occupiedUnits"]), 0, 0, totalPorts)
    : Math.min(totalPorts, releaseCount);
  const faultCandidate = explicitFault
    ? boundedInteger(firstInputValue(station, ["faultPorts", "faultUnits"]), 0, 0, totalPorts)
    : 0;
  const canInferIdleFromPartition = explicitCharging || releaseCount > 0;
  const idleCandidate = explicitIdle
    ? boundedInteger(firstInputValue(station, ["idlePorts", "availableUnits"]), 0, 0, totalPorts)
    : canInferIdleFromPartition
      ? Math.max(0, totalPorts - chargingCandidate - faultCandidate)
      : 0;
  // Keep the order visible and deterministic when a malformed input claims
  // more ports than the total: idle -> charging -> fault, never exceeding the
  // declared capacity.
  const idlePorts = Math.min(idleCandidate, totalPorts);
  const chargingPorts = Math.min(chargingCandidate, Math.max(0, totalPorts - idlePorts));
  const faultPorts = Math.min(faultCandidate, Math.max(0, totalPorts - idlePorts - chargingPorts));
  const reservedInput = firstInputValue(station, ["reservedPorts", "reservedUnits", "reservedConnectors"]);
  const reservedPorts = boundedInteger(reservedInput, 0, 0, idlePorts);
  const availablePorts = Math.max(0, idlePorts - reservedPorts);
  const estimatedReleaseMinutes = normalizeReleaseMinutes(station?.estimatedReleaseMinutes, totalPorts);
  const averageInput = parseOptionalNumber(station?.averageSessionMinutes);
  const enterpriseServiceMinutes = parseOptionalNumber(station?.enterprisePrior?.meanServiceMinutes);
  const fallbackSessionMinutes = enterpriseServiceMinutes !== null
    ? (60 / Math.max(0.1, parseOptionalNumber(legacyServiceRate) ?? 1.6)) * 0.65 + enterpriseServiceMinutes * 0.35
    : 60 / Math.max(0.1, parseOptionalNumber(legacyServiceRate) ?? 1.6);
  const averageSessionMinutes = averageInput !== null
    ? Number(clamp(averageInput, 1, 240).toFixed(1))
    : Number(clamp(fallbackSessionMinutes, 1, 240).toFixed(1));
  const waitingInput = firstInputValue(station, ["waitingVehicles", "queueVehicles"]);
  const queueVehicles = boundedInteger(waitingInput, 0, 0, MAX_QUEUE_VEHICLES);
  const reservationQueueAhead = boundedInteger(
    firstInputValue(station, ["reservationQueueAhead", "reservationAhead", "reservedVehicles"]),
    0,
    0,
    MAX_QUEUE_VEHICLES
  );
  const freshnessSeconds = hasInputValue(station, "freshnessSeconds")
    ? boundedInteger(station.freshnessSeconds, null, 0, MAX_FRESHNESS_SECONDS)
    : null;
  const snapshotTime = boundedText(station?.snapshotTime);
  const dataSource = boundedText(station?.dataSource);
  const availabilitySource = boundedText(station?.availabilitySource) || dataSource || "演示补能位状态";
  const queueSource = boundedText(station?.queueSource) || "演示预约队列";
  return {
    hasPortData: true,
    totalPorts,
    idlePorts,
    availablePorts,
    reservedPorts,
    chargingPorts,
    faultPorts,
    waitingVehicles: queueVehicles,
    queueVehicles,
    reservationQueueAhead,
    estimatedReleaseMinutes,
    averageSessionMinutes,
    snapshotTime,
    dataSource,
    availabilitySource,
    queueSource,
    freshnessSeconds,
    inputSnapshot: {
      totalPorts,
      idlePorts,
      availablePorts,
      reservedPorts,
      chargingPorts,
      faultPorts,
      waitingVehicles: queueVehicles,
      queueVehicles,
      reservationQueueAhead,
      estimatedReleaseMinutes,
      averageSessionMinutes,
      snapshotTime,
      dataSource,
      availabilitySource,
      queueSource,
      freshnessSeconds
    }
  };
}

// Kept separate so normalizeStation can remain a small, pure normalizer while
// still accepting the station-level aliases used by older API callers.
function scenarioForStation(station) {
  return station && typeof station === "object" && station._forecastScenario
    ? station._forecastScenario
    : {};
}

function timeOfDayFactor(absoluteMinutes) {
  const dayMinute = minuteOfDay(absoluteMinutes);
  // A smooth, explainable demand rhythm, not a learned model.  The two waves
  // make a 08:00 request and an 18:00 request produce different simulations.
  const morning = Math.sin((dayMinute - 360) / 180);
  const evening = Math.sin((dayMinute - 960) / 150);
  return clamp(1 + morning * 0.07 + evening * 0.08, 0.82, 1.18);
}

function forecastHorizon(scenario) {
  return number(scenario?.horizonMinutes, 30, 5, 240);
}

function forecastInterval(scenario) {
  return number(scenario?.intervalMinutes, 5, 1, 60);
}

function portAvailability(snapshot) {
  const available = [];
  const parsedAvailable = parseOptionalNumber(snapshot.availablePorts);
  const availableIdlePorts = parsedAvailable !== null
    ? parsedAvailable
    : snapshot.idlePorts;
  for (let index = 0; index < availableIdlePorts; index += 1) available.push(0);
  for (let index = 0; index < snapshot.chargingPorts; index += 1) {
    const release = parseOptionalNumber(snapshot.estimatedReleaseMinutes[index]);
    available.push(release !== null ? release : snapshot.averageSessionMinutes);
  }
  return available;
}

function siftDown(heap, startIndex) {
  const length = heap.length;
  let index = startIndex;
  const value = heap[index];
  while (true) {
    const left = (index << 1) + 1;
    if (left >= length) break;
    const right = left + 1;
    const smallest = right < length && heap[right] < heap[left] ? right : left;
    if (heap[smallest] >= value) break;
    heap[index] = heap[smallest];
    index = smallest;
  }
  heap[index] = value;
}

function buildMinHeap(values) {
  const heap = values.slice();
  for (let index = Math.floor(heap.length / 2) - 1; index >= 0; index -= 1) {
    siftDown(heap, index);
  }
  return heap;
}

function scheduleVehicle(heap, arrivalMinute, sessionMinutes) {
  if (!heap.length) return;
  const start = Math.max(arrivalMinute, heap[0]);
  heap[0] = start + sessionMinutes;
  siftDown(heap, 0);
}

function isSyntheticPortSnapshot(snapshot) {
  const source = `${snapshot?.dataSource || ""} ${snapshot?.availabilitySource || ""} ${snapshot?.queueSource || ""}`;
  return /演示|simulation|仿真/i.test(source);
}

function countAvailablePorts(heap, minute) {
  if (!heap.length || heap[0] > minute + 1e-9) return 0;
  let count = 0;
  const limit = minute + 1e-9;
  for (let index = 0; index < heap.length; index += 1) {
    if (heap[index] <= limit) count += 1;
  }
  return count;
}

function forecastPortStation(station, context, eventBudget) {
  const snapshot = station.portSnapshot;
  const dataAsOf = snapshot.snapshotTime || context.asOf;
  const source = station.enterprisePrior ? "enterprise-prior+simulation" : SIMULATION_SOURCE;
  const usablePorts = Math.max(0, snapshot.totalPorts - snapshot.faultPorts);
  const physicalServiceRate = usablePorts / Math.max(1, snapshot.averageSessionMinutes);
  // A synthetic demo snapshot must not extrapolate a small demand mismatch for
  // hours and turn it into a six-hour phantom queue. Keep the demo demand close
  // to physical throughput while preserving the current port state and initial
  // queue. Real station feeds are not capped by this demo-only guard.
  const syntheticDemandCap = isSyntheticPortSnapshot(snapshot)
    ? Math.max(0.1, physicalServiceRate * 1.05)
    : Number.POSITIVE_INFINITY;
  const effectiveArrivalRate = Math.min(station.arrivalRate, syntheticDemandCap);
  const syntheticGuardNote = isSyntheticPortSnapshot(snapshot)
    ? "；演示需求按物理服务能力的 105% 封顶，避免远期虚拟队列无限累积"
    : "";

  // Single-pass forward incremental simulation backed by a binary min-heap so
  // each sample point advances from the previous simulation minute instead of
  // replaying from t=0 on every sample.
  const heap = buildMinHeap(portAvailability(snapshot));
  const saturationThreshold = context.horizonMinutes + MAX_SIMULATION_WAIT_MINUTES;
  let stationEvents = 0;
  const initialQueue = snapshot.queueVehicles + snapshot.reservationQueueAhead;
  for (let index = 0; index < initialQueue; index += 1) {
    if (!heap.length || heap[0] >= saturationThreshold) break;
    if (stationEvents >= MAX_STATION_SIMULATION_EVENTS || eventBudget.remaining <= 0) break;
    scheduleVehicle(heap, 0, snapshot.averageSessionMinutes);
    stationEvents += 1;
    eventBudget.remaining -= 1;
  }

  let currentMinute = 0;
  let fractionalArrivals = 0;
  let scheduledArrivals = 0;
  const forecast = context.points.map((minute) => {
    while (currentMinute < minute - 1e-9 && scheduledArrivals < MAX_QUEUE_VEHICLES) {
      const stepAbsoluteMinutes = context.departureMinutes + currentMinute;
      const stepLocalPattern = 1 + Math.sin((station.seed % 31 + currentMinute) / 18) * 0.04;
      const stepTimeFactor = clamp(stepLocalPattern * timeOfDayFactor(stepAbsoluteMinutes), 0.75, 1.35);
      const rawArrivalRate = effectiveArrivalRate
        * context.demandFactor * context.trafficFactor * context.weatherFactor * stepTimeFactor;
      fractionalArrivals += Math.min(rawArrivalRate, syntheticDemandCap);
      const count = Math.min(MAX_QUEUE_VEHICLES - scheduledArrivals, Math.floor(fractionalArrivals));
      fractionalArrivals -= count;
      if (count > 0 && heap.length && heap[0] < saturationThreshold) {
        for (let index = 0; index < count; index += 1) {
          if (heap[0] >= saturationThreshold || stationEvents >= MAX_STATION_SIMULATION_EVENTS || eventBudget.remaining <= 0) break;
          scheduleVehicle(heap, currentMinute, snapshot.averageSessionMinutes);
          stationEvents += 1;
          eventBudget.remaining -= 1;
        }
      }
      scheduledArrivals += count;
      currentMinute += 1;
    }

    const nextRelease = heap.length ? heap[0] : Number.POSITIVE_INFINITY;
    const wait = Number.isFinite(nextRelease)
      ? clamp(nextRelease - minute, 0, MAX_SIMULATION_WAIT_MINUTES)
      : MAX_SIMULATION_WAIT_MINUTES;
    const availableAtArrival = countAvailablePorts(heap, minute);
    const occupiedAtArrival = Math.max(0, heap.length - availableAtArrival);
    const occupancy = clamp(
      (occupiedAtArrival + snapshot.reservedPorts) / Math.max(1, snapshot.totalPorts),
      0.05,
      0.99
    );
    const absoluteMinutes = context.departureMinutes + minute;
    const localPattern = 1 + Math.sin((station.seed % 31 + minute) / 18) * 0.04;
    const timeFactor = clamp(localPattern * timeOfDayFactor(absoluteMinutes), 0.75, 1.35);
    const p50 = waitToP50(wait);
    const p90 = Math.max(p50, waitToP90(wait));
    const confidence = deriveForecastConfidence({
      method: "port-discrete-event",
      station,
      arrivalOffsetMinutes: minute,
      horizonMinutes: context.horizonMinutes,
      demandFactor: context.demandFactor,
      trafficFactor: context.trafficFactor,
      weatherFactor: context.weatherFactor,
      enterprisePrior: station.enterprisePrior
    });
    return {
      minute,
      absoluteMinute: Number(absoluteMinutes.toFixed(1)),
      occupancy: Number(occupancy.toFixed(3)),
      wait: Number(wait.toFixed(1)),
      p50: Number(p50.toFixed(1)),
      p90: Number(p90.toFixed(1)),
      arrivalRate: Number(Math.min(
        effectiveArrivalRate * context.demandFactor * context.trafficFactor * context.weatherFactor * timeFactor,
        syntheticDemandCap
      ).toFixed(2)),
      serviceRate: Number(physicalServiceRate.toFixed(2)),
      preArrivalVehicles: scheduledArrivals,
      waitingVehicles: snapshot.waitingVehicles,
      reservationQueueAhead: snapshot.reservationQueueAhead,
      availablePorts: availableAtArrival,
      reservedPorts: snapshot.reservedPorts,
      risk: p90 >= 20 || occupancy >= 0.82 ? "forecast-risk" : "forecast-ready",
      method: "port-discrete-event",
      asOf: context.asOf,
      source,
      confidence: source,
      confidenceScore: confidence.score,
      confidenceLevel: confidence.level,
      confidenceLabel: confidence.label,
      confidenceReasons: confidence.reasons,
      horizonMinutes: context.horizonMinutes,
      simulation: true,
      dataAsOf,
      freshnessSeconds: snapshot.freshnessSeconds
    };
  });
  const arrivalOffsetMinutes = Math.max(0, station.arrivalOffsetMinutes);
  const arrivalForecast = normalizePredictionPoint(
    selectForecastPoint(forecast, arrivalOffsetMinutes) || forecast[0],
    station,
    context.metadata
  );
  const arrivalConfidence = deriveForecastConfidence({
    method: "port-discrete-event",
    station,
    arrivalOffsetMinutes,
    horizonMinutes: context.horizonMinutes,
    demandFactor: context.demandFactor,
    trafficFactor: context.trafficFactor,
    weatherFactor: context.weatherFactor,
    enterprisePrior: station.enterprisePrior
  });
  return {
    id: station.id,
    name: station.name,
    type: station.type,
    location: station.location,
    address: station.address,
    source,
    stationSource: station.stationSource,
    price: station.price,
    detour: station.detour,
    baseline: forecast[0],
    forecast,
    prediction: arrivalForecast,
    arrivalForecast,
    arrivalOffsetMinutes: Number(arrivalOffsetMinutes.toFixed(1)),
    etaMinutes: Number(arrivalOffsetMinutes.toFixed(1)),
    arrivalMinute: Number((context.departureMinutes + arrivalOffsetMinutes).toFixed(1)),
    wait: arrivalForecast.wait,
    p50: arrivalForecast.p50,
    p90: arrivalForecast.p90,
    asOf: context.asOf,
    dataAsOf,
    freshnessSeconds: snapshot.freshnessSeconds,
    method: "port-discrete-event",
    inputSnapshot: snapshot.inputSnapshot,
    totalPorts: snapshot.totalPorts,
    idlePorts: snapshot.idlePorts,
    availablePorts: snapshot.availablePorts,
    reservedPorts: snapshot.reservedPorts,
    chargingPorts: snapshot.chargingPorts,
    faultPorts: snapshot.faultPorts,
    waitingVehicles: snapshot.waitingVehicles,
    queueVehicles: snapshot.queueVehicles,
    reservationQueueAhead: snapshot.reservationQueueAhead,
    estimatedReleaseMinutes: snapshot.estimatedReleaseMinutes,
    averageSessionMinutes: snapshot.averageSessionMinutes,
    confidence: source,
    confidenceScore: arrivalConfidence.score,
    confidenceLevel: arrivalConfidence.level,
    confidenceLabel: arrivalConfidence.label,
    confidenceReasons: arrivalConfidence.reasons,
    enterprisePrior: station.enterprisePrior,
    availabilitySource: snapshot.availabilitySource,
    queueSource: snapshot.queueSource,
    inputDataSource: snapshot.dataSource,
    dataSource: station.enterprisePrior
      ? "能链生产拟合数据需求先验 + FlowTwin 仿真"
      : "FlowTwin 演示仿真",
    horizonMinutes: context.horizonMinutes,
    simulation: true,
    explanation: `${station.enterprisePrior ? "企业需求先验 + " : ""}simulation 仿真：使用总枪位、空闲/预约/充电中/故障状态、已到站等待车辆和到站前预约队列，先安排队列再安排预计到达车辆，估算到站等待${syntheticGuardNote}；dataAsOf=${dataAsOf}，预约队列与补能位状态当前为${snapshot.dataSource || "演示输入"}，企业先验仅为城市×油电类型×小时需求，不代表具体站点实时经营数据。`
  };
}

export function forecastStations(stations = [], scenario = {}) {
  const safeScenario = scenario && typeof scenario === "object" ? scenario : {};
  const departureParsed = parseOptionalNumber(safeScenario.departureMinutes);
  const departureMinutes = departureParsed !== null
    ? departureParsed
    : (parseClock(safeScenario.departureMinutes) || 0);
  const horizonMinutes = forecastHorizon(safeScenario);
  const requestedInterval = forecastInterval(safeScenario);
  const estimatedPoints = Math.floor(horizonMinutes / requestedInterval) + 1;
  const intervalMinutes = estimatedPoints > MAX_FORECAST_POINTS
    ? Math.max(requestedInterval, horizonMinutes / (MAX_FORECAST_POINTS - 1))
    : requestedInterval;
  const points = [];
  for (let minute = 0; minute <= horizonMinutes + 1e-9 && points.length < MAX_FORECAST_POINTS; minute += intervalMinutes) {
    points.push(Number(minute.toFixed(1)));
  }
  if (points.at(-1) < horizonMinutes) {
    if (points.length >= MAX_FORECAST_POINTS) points[points.length - 1] = horizonMinutes;
    else points.push(horizonMinutes);
  }
  const scenarioFactor = number(safeScenario.demandFactor, 1, 0.5, 2);
  const trafficFactor = number(safeScenario.trafficFactor, 1, 0.7, 1.5);
  // 天气因子来自高德实况：雨雪天抬高峰值等待。缺省为 1（无影响），故不接天气时
  // 预测与原来完全一致的口径仍然成立，但时段会影响到站时的模拟需求。
  const weatherFactor = number(safeScenario.weatherFactor, 1, 0.8, 1.5);
  const asOf = simulationAsOf(departureMinutes);
  const metadata = {
    asOf,
    source: SIMULATION_SOURCE,
    confidence: SIMULATION_CONFIDENCE,
    horizonMinutes,
    simulation: true
  };
  const safeStations = Array.isArray(stations)
    ? stations.slice(0, MAX_FORECAST_STATIONS).map((station, index) => normalizeStation(
      Object.assign({}, station, { _forecastScenario: safeScenario }),
      index
    ))
    : [];

  const forecastContext = {
    departureMinutes,
    horizonMinutes,
    intervalMinutes: Number(intervalMinutes.toFixed(2)),
    points,
    demandFactor: scenarioFactor,
    trafficFactor,
    weatherFactor,
    asOf,
    metadata
  };
  const eventBudget = { remaining: MAX_TOTAL_SIMULATION_EVENTS };

  const forecastedStations = safeStations.map((station) => {
    if (station.portSnapshot) return forecastPortStation(station, forecastContext, eventBudget);
    const forecast = points.map((minute) => {
      const absoluteMinutes = departureMinutes + minute;
      const localPattern = 1 + Math.sin((station.seed % 31 + minute) / 18) * 0.04;
      const timeFactor = clamp(localPattern * timeOfDayFactor(absoluteMinutes), 0.75, 1.35);
      // 天气抬到达率（雨雪天更多人来充电），不碰服务率--服务能力本身没变，
      // 变的是需求侧。这样 P50/P90 会随天气单调上升，方向可解释。
      const netFlow = (station.arrivalRate * scenarioFactor * trafficFactor * weatherFactor * timeFactor - station.serviceRate) / station.capacity;
      const occupancy = clamp(station.occupancy + station.trend * minute + netFlow * minute * 0.16, 0.05, 0.99);
      // Keep the time-of-day factor in the wait estimate itself, not only in
      // the next five-minute occupancy update.  Otherwise a saturated station
      // would erase the departure-time signal after occupancy hit its clamp.
      const queueWait = station.wait * (0.72 + occupancy * 0.7) + Math.max(0, occupancy - 0.75) * 34;
      const wait = clamp(queueWait * timeFactor, 0, 180);
      const p50 = waitToP50(wait);
      const p90 = waitToP90(wait);
      const confidence = deriveForecastConfidence({
        method: "aggregate-flow-simulation",
        station,
        arrivalOffsetMinutes: minute,
        horizonMinutes,
        demandFactor: scenarioFactor,
        trafficFactor,
        weatherFactor,
        enterprisePrior: station.enterprisePrior
      });
      return {
        minute,
        absoluteMinute: Number(absoluteMinutes.toFixed(1)),
        occupancy: Number(occupancy.toFixed(3)),
        wait: Number(wait.toFixed(1)),
        p50: Number(p50.toFixed(1)),
        p90: Number(p90.toFixed(1)),
        arrivalRate: Number((station.arrivalRate * scenarioFactor * timeFactor).toFixed(2)),
        serviceRate: Number(station.serviceRate.toFixed(2)),
        risk: p90 >= 20 || occupancy >= 0.82 ? "forecast-risk" : "forecast-ready",
        ...metadata,
        source: station.enterprisePrior ? "enterprise-prior+simulation" : metadata.source,
        confidence: station.enterprisePrior ? "enterprise-prior+simulation" : metadata.confidence,
        confidenceScore: confidence.score,
        confidenceLevel: confidence.level,
        confidenceLabel: confidence.label,
        confidenceReasons: confidence.reasons
      };
    });
    const arrivalOffsetMinutes = Math.max(0, station.arrivalOffsetMinutes);
    const arrivalForecast = normalizePredictionPoint(
      selectForecastPoint(forecast, arrivalOffsetMinutes) || forecast[0],
      station,
      metadata
    );
    const arrivalConfidence = deriveForecastConfidence({
      method: "aggregate-flow-simulation",
      station,
      arrivalOffsetMinutes,
      horizonMinutes,
      demandFactor: scenarioFactor,
      trafficFactor,
      weatherFactor,
      enterprisePrior: station.enterprisePrior
    });
    return {
      id: station.id,
      name: station.name,
      type: station.type,
      location: station.location,
      address: station.address,
      // `source` is the source of this forecast, not a claim about the POI.
      // Keep the original POI source separately so callers do not lose it.
      source: station.enterprisePrior ? "enterprise-prior+simulation" : SIMULATION_SOURCE,
      stationSource: station.stationSource,
      price: station.price,
      detour: station.detour,
      baseline: forecast[0],
      forecast,
      prediction: arrivalForecast,
      arrivalForecast,
      arrivalOffsetMinutes: Number(arrivalOffsetMinutes.toFixed(1)),
      etaMinutes: Number(arrivalOffsetMinutes.toFixed(1)),
      arrivalMinute: Number((departureMinutes + arrivalOffsetMinutes).toFixed(1)),
      wait: arrivalForecast.wait,
      p50: arrivalForecast.p50,
      p90: arrivalForecast.p90,
      asOf,
      dataAsOf: asOf,
      freshnessSeconds: null,
      method: "aggregate-flow-simulation",
      inputSnapshot: null,
      confidence: station.enterprisePrior ? "enterprise-prior+simulation" : SIMULATION_CONFIDENCE,
      confidenceScore: arrivalConfidence.score,
      confidenceLevel: arrivalConfidence.level,
      confidenceLabel: arrivalConfidence.label,
      confidenceReasons: arrivalConfidence.reasons,
      horizonMinutes,
      simulation: true,
      // 原来标的是“每 5 分钟到达率”。模型里 arrivalRate 是按分钟外推的，
      // 5 分钟只是画图的取样间隔，不是速率的单位。同时把到站 ETA 和 simulation
      // 写进响应，避免把仿真数据误读成实时经营数据。
      enterprisePrior: station.enterprisePrior,
      explanation: `${station.enterprisePrior ? "企业需求先验 + " : ""}simulation 仿真：按预计到站 ${arrivalOffsetMinutes.toFixed(0)} 分钟、当前占用率 ${(station.occupancy * 100).toFixed(0)}%、到达率 ${station.arrivalRate.toFixed(1)} 辆/分钟、服务率 ${station.serviceRate.toFixed(1)} 辆/分钟估计；企业先验仅提供城市×油电类型×小时需求倍率，不代表具体站点实时经营数据。`
    };
  });

  return {
    horizonMinutes,
    intervalMinutes: Number(intervalMinutes.toFixed(2)),
    asOf,
    method: forecastedStations.some((station) => station.method === "port-discrete-event")
      ? "port-discrete-event"
      : "aggregate-flow-simulation",
    dataAsOf: forecastedStations.find((station) => station.dataAsOf)?.dataAsOf || asOf,
    freshnessSeconds: forecastedStations.find((station) => parseOptionalNumber(station.freshnessSeconds) !== null)?.freshnessSeconds ?? null,
    source: forecastedStations.some((station) => station.enterprisePrior)
      ? "enterprise-prior+simulation"
      : SIMULATION_SOURCE,
    confidence: forecastedStations.some((station) => station.enterprisePrior)
      ? "enterprise-prior+simulation"
      : SIMULATION_CONFIDENCE,
    simulation: true,
    // 原来写的是“当前占用率 + 到达率 - 服务率 + 时段/路况因子”：漏掉了除以
    // 车位数、站点趋势项和高占用拥堵惩罚。现在公开的口径与实际计算一致。
    model: forecastedStations.some((station) => station.method === "port-discrete-event")
      ? `${forecastedStations.some((station) => station.enterprisePrior) ? "企业城市×油电类型×小时需求先验 + " : ""}simulation 仿真：端口级离散事件；按端口释放时间、当前排队和到站前预计到达车辆安排服务，不代表具体站点实时经营数据。`
      : `${forecastedStations.some((station) => station.enterprisePrior) ? "企业城市×油电类型×小时需求先验 + " : ""}simulation 仿真：可解释队列近似；占用率随 (到达率×时段/路况/天气因子 − 服务率)/车位数 与站点趋势项外推，等待随占用率上升，超 75% 后加拥堵惩罚`,
    scenario: {
      demandFactor: scenarioFactor,
      trafficFactor,
      weatherFactor,
      departureMinutes
    },
    stations: forecastedStations
  };
}

export { hash };
