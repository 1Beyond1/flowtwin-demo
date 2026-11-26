import { forecastStations, waitToP50, waitToP90 } from "./forecast.mjs";
import { parseOptionalNumber } from "./number.mjs";

export const VISION_ANNOTATION_KINDS = Object.freeze(["charging", "idle", "queue", "fault"]);

const VALID_KINDS = new Set(VISION_ANNOTATION_KINDS);
const MAX_ANNOTATIONS = 100;
const SOURCE_LABEL = "视觉页人工标注回流（演示）";
const hasOwn = (value, key) => Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeScalarString(value, maxLen, fallback = "") {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLen);
  return text || fallback;
}

function sanitizeLocation(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const lng = parseOptionalNumber(raw[0]);
  const lat = parseOptionalNumber(raw[1]);
  if (lng === null || lat === null) return null;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
  return [lng, lat];
}

function pickSafeScenario(scenario) {
  const safe = {};
  if (hasOwn(scenario, "departureMinutes")) {
    const dep = parseOptionalNumber(scenario.departureMinutes);
    if (dep !== null) {
      safe.departureMinutes = clamp(dep, 0, 24 * 60);
    } else if (typeof scenario.departureMinutes === "string" && /^\d{1,2}:\d{2}$/.test(scenario.departureMinutes.trim())) {
      safe.departureMinutes = scenario.departureMinutes.trim();
    }
  }
  const numericBounds = [
    ["weatherFactor", 0.8, 1.5],
    ["trafficFactor", 0.7, 1.5],
    ["demandFactor", 0.5, 2],
    ["intervalMinutes", 1, 60]
  ];
  for (const [key, min, max] of numericBounds) {
    if (!hasOwn(scenario, key)) continue;
    const parsed = parseOptionalNumber(scenario[key]);
    if (parsed !== null) safe[key] = clamp(parsed, min, max);
  }
  return safe;
}

function validateAnnotations(rawAnnotations) {
  if (!Array.isArray(rawAnnotations) || !rawAnnotations.length || rawAnnotations.length > MAX_ANNOTATIONS) {
    throw httpError(400, "INVALID_VISION_ANNOTATIONS");
  }
  const normalized = [];
  for (const item of rawAnnotations) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw httpError(400, "INVALID_VISION_ANNOTATIONS");
    }
    const kind = String(item.kind || "").trim();
    if (!VALID_KINDS.has(kind)) {
      throw httpError(400, "INVALID_VISION_ANNOTATIONS");
    }
    const x = parseOptionalNumber(item.x);
    const y = parseOptionalNumber(item.y);
    const w = parseOptionalNumber(item.w);
    const h = parseOptionalNumber(item.h);
    if (x === null || y === null || w === null || h === null) {
      throw httpError(400, "INVALID_VISION_ANNOTATIONS");
    }
    if (x < 0 || x > 1 || y < 0 || y > 1 || w <= 0 || w > 1 || h <= 0 || h > 1) {
      throw httpError(400, "INVALID_VISION_ANNOTATIONS");
    }
    normalized.push({ kind, x, y, w, h });
  }
  return normalized;
}

/**
 * Convert manual bounding-box annotations (charging / idle / queue / fault)
 * from the vision canvas into a port-level snapshot and run the existing
 * port-discrete-event queue forecast so operators & drivers see immediate
 * before/after queue impact.
 */
export function evaluateVisionQueueFeedback(input = {}) {
  const safeInput = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const annotations = validateAnnotations(safeInput.annotations);
  const station = safeInput.station && typeof safeInput.station === "object" && !Array.isArray(safeInput.station)
    ? safeInput.station
    : {};
  const scenario = safeInput.scenario && typeof safeInput.scenario === "object" && !Array.isArray(safeInput.scenario)
    ? safeInput.scenario
    : {};

  const counts = { charging: 0, idle: 0, queue: 0, fault: 0 };
  for (const box of annotations) {
    counts[box.kind] += 1;
  }

  const markedPorts = counts.charging + counts.idle + counts.fault;
  let totalPorts;
  let chargingPorts;
  let idlePorts;
  let faultPorts;
  if (markedPorts > 0) {
    totalPorts = markedPorts;
    chargingPorts = counts.charging;
    idlePorts = counts.idle;
    faultPorts = counts.fault;
  } else {
    // Only queue boxes were marked: infer station ports as currently full so
    // the marked queue translates into concrete waiting time.
    const inferredCapacity = parseOptionalNumber(
      hasOwn(station, "totalPorts")
        ? station.totalPorts
        : (hasOwn(station, "capacity") ? station.capacity : undefined)
    );
    totalPorts = Math.max(4, Math.min(200, Math.round(inferredCapacity ?? 8)));
    chargingPorts = totalPorts;
    idlePorts = 0;
    faultPorts = 0;
  }

  const stationType = safeScalarString(hasOwn(station, "type") ? station.type : undefined, 30, "充电站");
  const isFuelStation = /加油/.test(stationType);
  const parsedSession = parseOptionalNumber(
    hasOwn(station, "averageSessionMinutes") ? station.averageSessionMinutes : undefined
  );
  const averageSessionMinutes = Number(clamp(parsedSession ?? (isFuelStation ? 8 : 28), 3, 120).toFixed(1));

  // Stagger remaining session times across currently occupied ports so the
  // discrete-event queue produces smooth, physically realistic wait deltas.
  const estimatedReleaseMinutes = [];
  for (let index = 0; index < chargingPorts; index += 1) {
    const remaining = averageSessionMinutes * (index + 1) / (chargingPorts + 1);
    estimatedReleaseMinutes.push(Number(remaining.toFixed(1)));
  }

  const occupancy = Number(clamp((chargingPorts + faultPorts) / Math.max(1, totalPorts), 0.05, 0.99).toFixed(3));
  const arrivalOffsetParsed = parseOptionalNumber(
    (hasOwn(safeInput, "arrivalOffsetMinutes") ? safeInput.arrivalOffsetMinutes : undefined)
    ?? (hasOwn(scenario, "arrivalOffsetMinutes") ? scenario.arrivalOffsetMinutes : undefined)
    ?? (hasOwn(station, "arrivalOffsetMinutes") ? station.arrivalOffsetMinutes : undefined)
  );
  const arrivalOffsetMinutes = Number(clamp(arrivalOffsetParsed ?? 0, 0, 240).toFixed(1));
  const horizonMinutes = Math.max(30, Math.min(240, Math.ceil(arrivalOffsetMinutes + 30)));

  const beforeOccParsed = parseOptionalNumber(hasOwn(station, "occupancy") ? station.occupancy : undefined);
  const beforeWaitRaw = hasOwn(station, "wait")
    ? station.wait
    : (hasOwn(station, "p50") ? station.p50 : undefined);
  const beforeWaitParsed = parseOptionalNumber(beforeWaitRaw);
  const beforeP50Parsed = parseOptionalNumber(hasOwn(station, "p50") ? station.p50 : undefined);
  const beforeP90Parsed = parseOptionalNumber(hasOwn(station, "p90") ? station.p90 : undefined);
  const resolvedBeforeWait = beforeWaitParsed ?? 0;
  const before = {
    occupancy: Number((beforeOccParsed ?? 0).toFixed(3)),
    wait: Number(resolvedBeforeWait.toFixed(1)),
    p50: Number((beforeP50Parsed ?? waitToP50(resolvedBeforeWait)).toFixed(1)),
    p90: Number((beforeP90Parsed ?? waitToP90(resolvedBeforeWait)).toFixed(1))
  };

  // Whitelist only safe scalar/coordinate station fields. Never spread raw
  // untrusted station input (which would allow spoofing enterprisePrior or
  // enterpriseDemandFactor or injecting prototype keys).
  const stationPrice = hasOwn(station, "price") ? parseOptionalNumber(station.price) : null;
  const stationDetour = hasOwn(station, "detour") ? parseOptionalNumber(station.detour) : null;
  const stationEta = hasOwn(station, "etaMinutes") ? parseOptionalNumber(station.etaMinutes) : null;
  const stationSourceText = safeScalarString(hasOwn(station, "source") ? station.source : undefined, 80, "");
  const stationStationSourceText = safeScalarString(
    hasOwn(station, "stationSource") ? station.stationSource : undefined,
    80,
    ""
  );

  const stationForForecast = {
    id: safeScalarString(hasOwn(station, "id") ? station.id : undefined, 120, "vision-station"),
    name: safeScalarString(hasOwn(station, "name") ? station.name : undefined, 100, "视觉标注站点"),
    type: stationType,
    address: safeScalarString(hasOwn(station, "address") ? station.address : undefined, 160, ""),
    location: hasOwn(station, "location") ? sanitizeLocation(station.location) : null,
    ...(stationPrice !== null ? { price: Number(clamp(stationPrice, 0, 1000).toFixed(2)) } : {}),
    ...(stationDetour !== null ? { detour: Number(clamp(stationDetour, 0, 1000).toFixed(2)) } : {}),
    ...(beforeWaitParsed !== null ? { wait: Number(clamp(beforeWaitParsed, 0, 180).toFixed(1)) } : {}),
    ...(beforeP50Parsed !== null ? { p50: Number(clamp(beforeP50Parsed, 0, 180).toFixed(1)) } : {}),
    ...(beforeP90Parsed !== null ? { p90: Number(clamp(beforeP90Parsed, 0, 300).toFixed(1)) } : {}),
    ...(stationEta !== null ? { etaMinutes: Number(clamp(stationEta, 0, 240).toFixed(1)) } : {}),
    ...(stationSourceText ? { source: stationSourceText } : {}),
    ...(stationStationSourceText ? { stationSource: stationStationSourceText } : {}),
    capacity: totalPorts,
    totalPorts,
    idlePorts,
    chargingPorts,
    faultPorts,
    reservedPorts: 0,
    reservationQueueAhead: 0,
    waitingVehicles: counts.queue,
    queueVehicles: counts.queue,
    estimatedReleaseMinutes,
    averageSessionMinutes,
    freshnessSeconds: 0,
    occupancy,
    arrivalOffsetMinutes,
    dataSource: SOURCE_LABEL,
    availabilitySource: SOURCE_LABEL,
    queueSource: SOURCE_LABEL
  };

  const forecastResult = forecastStations([stationForForecast], {
    ...pickSafeScenario(scenario),
    arrivalOffsetMinutes,
    horizonMinutes
  });
  const stationForecast = forecastResult.stations[0];
  const prediction = stationForecast.arrivalForecast || stationForecast.baseline;

  const after = {
    occupancy: prediction.occupancy,
    wait: prediction.wait,
    p50: prediction.p50,
    p90: prediction.p90,
    risk: prediction.risk
  };

  const snapshot = {
    totalPorts,
    idlePorts,
    chargingPorts,
    faultPorts,
    waitingVehicles: counts.queue,
    queueVehicles: counts.queue,
    occupancy,
    averageSessionMinutes,
    estimatedReleaseMinutes,
    freshnessSeconds: 0,
    inferredFromQueueOnly: markedPorts === 0,
    dataSource: SOURCE_LABEL,
    availabilitySource: SOURCE_LABEL,
    queueSource: SOURCE_LABEL
  };

  const summary = markedPorts > 0
    ? `已标注 ${counts.charging} 充电中 / ${counts.idle} 空闲 / ${counts.queue} 排队 / ${counts.fault} 故障（共 ${totalPorts} 枪位），回流端口离散事件预测后预计等待 ${after.wait.toFixed(1)} 分钟（P90 ${after.p90.toFixed(1)} 分钟）。`
    : `已标注 ${counts.queue} 辆排队车（未标枪位，按 ${totalPorts} 枪位满载推算），回流端口离散事件预测后预计等待 ${after.wait.toFixed(1)} 分钟（P90 ${after.p90.toFixed(1)} 分钟）。`;

  return {
    ok: true,
    source: "vision-manual-annotation",
    sourceLabel: SOURCE_LABEL,
    counts: {
      charging: counts.charging,
      idle: counts.idle,
      queue: counts.queue,
      fault: counts.fault,
      totalPorts
    },
    snapshot,
    before,
    after,
    stationForecast,
    summary,
    dataBoundary: "人工标注框回流仅用于演示端口级离散事件队列更新，不代表真实摄像头自动检测或场站实时经营数据。"
  };
}
