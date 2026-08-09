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

const MAX_PORTS = 500;
const MAX_QUEUE_VEHICLES = 5000;
const MAX_FRESHNESS_SECONDS = 7 * 24 * 60 * 60;
const MAX_SIMULATION_WAIT_MINUTES = 240;
const PORT_INPUT_FIELDS = [
  "totalPorts",
  "idlePorts",
  "chargingPorts",
  "faultPorts",
  "queueVehicles",
  "estimatedReleaseMinutes",
  "averageSessionMinutes",
  "snapshotTime",
  "dataSource",
  "freshnessSeconds"
];

function hash(value) {
  let result = 2166136261;
  for (const character of String(value || "station")) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function number(value, fallback, min = 0, max = Number.POSITIVE_INFINITY) {
  const result = Number(value);
  return Number.isFinite(result) ? clamp(result, min, max) : fallback;
}

function minuteOfDay(value, fallback = 0) {
  const result = Number(value);
  if (!Number.isFinite(result)) return fallback;
  const normalized = result % MINUTES_PER_DAY;
  return normalized < 0 ? normalized + MINUTES_PER_DAY : normalized;
}

function clockLabel(minutes) {
  const normalized = minuteOfDay(minutes);
  const hour = Math.floor(normalized / 60).toString().padStart(2, "0");
  const minute = Math.round(normalized % 60).toString().padStart(2, "0");
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
    const value = mapping[key];
    if (Number.isFinite(Number(value))) return Number(value);
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
  ].map(Number).find(Number.isFinite);
  if (Number.isFinite(direct)) return Math.max(0, direct);

  const departureValue = Number.isFinite(Number(scenario.departureMinutes))
    ? Number(scenario.departureMinutes)
    : parseClock(scenario.departureMinutes);
  const departure = minuteOfDay(departureValue, 0);
  const absolute = [station.arrivalMinute, station.arrivalAtMinutes]
    .map(Number)
    .find(Number.isFinite);
  if (Number.isFinite(absolute)) {
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
    .map(Number)
    .find(Number.isFinite);
  return Number.isFinite(value) ? value : fallback;
}

function finitePointValue(point, key, fallback = Number.NaN) {
  const value = Number(point?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function normalizePredictionPoint(point = {}, fallback = {}, metadata = {}) {
  const fallbackWait = Number.isFinite(Number(fallback.wait))
    ? Number(fallback.wait)
    : Number.isFinite(Number(fallback.p50))
      ? Number(fallback.p50)
      : 0;
  const wait = Math.max(0, finitePointValue(point, "wait", fallbackWait));
  const p50 = Math.max(0, finitePointValue(point, "p50", waitToP50(wait)));
  const p90 = Math.max(p50, finitePointValue(point, "p90", waitToP90(wait)));
  return {
    ...point,
    wait: Number(wait.toFixed(1)),
    p50: Number(p50.toFixed(1)),
    p90: Number(p90.toFixed(1)),
    asOf: point.asOf || metadata.asOf || SIMULATION_SOURCE,
    source: point.source || metadata.source || SIMULATION_SOURCE,
    confidence: point.confidence || metadata.confidence || SIMULATION_CONFIDENCE,
    horizonMinutes: Number.isFinite(Number(point.horizonMinutes))
      ? Number(point.horizonMinutes)
      : metadata.horizonMinutes
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
  const requested = Math.max(0, Number(arrivalOffsetMinutes) || 0);
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
  ["wait", "p50", "p90", "occupancy", "arrivalRate", "serviceRate"].forEach((key) => {
    const lowerValue = Number(lower.point?.[key]);
    const upperValue = Number(upper.point?.[key]);
    if (Number.isFinite(lowerValue) && Number.isFinite(upperValue)) {
      result[key] = Number((lowerValue + (upperValue - lowerValue) * ratio).toFixed(1));
    }
  });
  return {
    ...result,
    minute: Number(requested.toFixed(1)),
    requestedOffsetMinutes: requested,
    interpolated: true,
    asOf: lower.point.asOf,
    source: lower.point.source,
    confidence: lower.point.confidence,
    horizonMinutes: lower.point.horizonMinutes
  };
}

function normalizeStation(station, index) {
  const seed = hash(`${station?.id || station?.name || "station"}-${index}`);
  const occupancy = number(station?.occupancy, 0.45 + (seed % 30) / 100, 0.05, 0.96);
  const wait = number(station?.wait ?? station?.p50, 5 + (seed % 8), 0, 120);
  const capacity = number(station?.capacity, 12 + (seed % 13), 1, 500);
  const arrivalRate = number(station?.arrivalRate, 1.2 + (seed % 20) / 10, 0, 100);
  const serviceRate = number(station?.serviceRate, 1.6 + (seed % 16) / 10, 0.1, 100);
  const trend = number(station?.trend, ((seed % 9) - 4) / 1000, -0.02, 0.02);
  const portSnapshot = normalizePortSnapshot(station, capacity, serviceRate);
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
    arrivalRate,
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

function boundedInteger(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? clamp(Math.round(numeric), min, max) : fallback;
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
    .map((item) => Number(item))
    .filter(Number.isFinite)
    .slice(0, Math.min(MAX_PORTS, Math.max(0, totalPorts)))
    .map((item) => Number(clamp(item, 0, 240).toFixed(1)));
}

/**
 * Port-level inputs are optional.  The marker is deliberately based only on
 * fields supplied by the caller; legacy `capacity`/`occupancy` must continue
 * to use the aggregate model rather than silently becoming a port model.
 */
function hasPortInput(station) {
  return PORT_INPUT_FIELDS.some((key) => hasInputValue(station, key));
}

function normalizePortSnapshot(station, legacyCapacity, legacyServiceRate) {
  if (!hasPortInput(station)) return null;

  const rawRelease = Array.isArray(station?.estimatedReleaseMinutes)
    ? station.estimatedReleaseMinutes.slice(0, MAX_PORTS)
    : [];
  const explicitIdle = hasInputValue(station, "idlePorts");
  const explicitCharging = hasInputValue(station, "chargingPorts");
  const explicitFault = hasInputValue(station, "faultPorts");
  const rawCounts = [
    explicitIdle ? boundedInteger(station.idlePorts, 0, 0, MAX_PORTS) : 0,
    explicitCharging ? boundedInteger(station.chargingPorts, 0, 0, MAX_PORTS) : 0,
    explicitFault ? boundedInteger(station.faultPorts, 0, 0, MAX_PORTS) : 0
  ];
  const releaseCount = rawRelease
    .map(Number)
    .filter(Number.isFinite)
    .length;
  const derivedTotal = Math.max(
    1,
    ...rawCounts,
    releaseCount,
    Number.isFinite(Number(legacyCapacity)) ? Number(legacyCapacity) : 1
  );
  const totalPorts = boundedInteger(
    station?.totalPorts,
    boundedInteger(derivedTotal, 1, 1, MAX_PORTS),
    1,
    MAX_PORTS
  );

  const chargingCandidate = explicitCharging
    ? boundedInteger(station.chargingPorts, 0, 0, totalPorts)
    : Math.min(totalPorts, releaseCount);
  const faultCandidate = explicitFault
    ? boundedInteger(station.faultPorts, 0, 0, totalPorts)
    : 0;
  const idleCandidate = explicitIdle
    ? boundedInteger(station.idlePorts, 0, 0, totalPorts)
    : Math.max(0, totalPorts - chargingCandidate - faultCandidate);
  // Keep the order visible and deterministic when a malformed input claims
  // more ports than the total: idle -> charging -> fault, never exceeding the
  // declared capacity.
  const idlePorts = Math.min(idleCandidate, totalPorts);
  const chargingPorts = Math.min(chargingCandidate, Math.max(0, totalPorts - idlePorts));
  const faultPorts = Math.min(faultCandidate, Math.max(0, totalPorts - idlePorts - chargingPorts));
  const estimatedReleaseMinutes = normalizeReleaseMinutes(station?.estimatedReleaseMinutes, totalPorts);
  const averageInput = Number(station?.averageSessionMinutes);
  const averageSessionMinutes = Number.isFinite(averageInput)
    ? Number(clamp(averageInput, 1, 240).toFixed(1))
    : Number(clamp(60 / Math.max(0.1, Number(legacyServiceRate) || 1.6), 1, 240).toFixed(1));
  const queueVehicles = boundedInteger(station?.queueVehicles, 0, 0, MAX_QUEUE_VEHICLES);
  const freshnessSeconds = hasInputValue(station, "freshnessSeconds")
    ? boundedInteger(station.freshnessSeconds, null, 0, MAX_FRESHNESS_SECONDS)
    : null;
  const snapshotTime = boundedText(station?.snapshotTime);
  const dataSource = boundedText(station?.dataSource);
  return {
    hasPortData: true,
    totalPorts,
    idlePorts,
    chargingPorts,
    faultPorts,
    queueVehicles,
    estimatedReleaseMinutes,
    averageSessionMinutes,
    snapshotTime,
    dataSource,
    freshnessSeconds,
    inputSnapshot: {
      totalPorts,
      idlePorts,
      chargingPorts,
      faultPorts,
      queueVehicles,
      estimatedReleaseMinutes,
      averageSessionMinutes,
      snapshotTime,
      dataSource,
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
  for (let index = 0; index < snapshot.idlePorts; index += 1) available.push(0);
  for (let index = 0; index < snapshot.chargingPorts; index += 1) {
    const release = Number(snapshot.estimatedReleaseMinutes[index]);
    available.push(Number.isFinite(release) ? release : snapshot.averageSessionMinutes);
  }
  return available;
}

function scheduleVehicle(available, arrivalMinute, sessionMinutes) {
  if (!available.length) return;
  let earliestIndex = 0;
  for (let index = 1; index < available.length; index += 1) {
    if (available[index] < available[earliestIndex]) earliestIndex = index;
  }
  const start = Math.max(arrivalMinute, available[earliestIndex]);
  available[earliestIndex] = start + sessionMinutes;
}

function schedulePortDemand(station, snapshot, scenario, available, beforeMinute) {
  for (let index = 0; index < snapshot.queueVehicles; index += 1) {
    scheduleVehicle(available, 0, snapshot.averageSessionMinutes);
  }
  let fractionalArrivals = 0;
  let scheduledArrivals = 0;
  const endMinute = Math.max(0, Number(beforeMinute) || 0);
  for (let minute = 0; minute < endMinute - 1e-9; minute += 1) {
    const absoluteMinutes = scenario.departureMinutes + minute;
    const localPattern = 1 + Math.sin((station.seed % 31 + minute) / 18) * 0.04;
    const timeFactor = clamp(localPattern * timeOfDayFactor(absoluteMinutes), 0.75, 1.35);
    fractionalArrivals += station.arrivalRate * scenario.demandFactor * scenario.trafficFactor * scenario.weatherFactor * timeFactor;
    const count = Math.min(MAX_QUEUE_VEHICLES - scheduledArrivals, Math.floor(fractionalArrivals));
    fractionalArrivals -= count;
    for (let index = 0; index < count; index += 1) {
      scheduleVehicle(available, minute, snapshot.averageSessionMinutes);
    }
    scheduledArrivals += count;
    if (scheduledArrivals >= MAX_QUEUE_VEHICLES) break;
  }
  return scheduledArrivals;
}

function forecastPortStation(station, context) {
  const snapshot = station.portSnapshot;
  const dataAsOf = snapshot.snapshotTime || context.asOf;
  const forecast = context.points.map((minute) => {
    const available = portAvailability(snapshot);
    const preArrivalVehicles = schedulePortDemand(station, snapshot, context, available, minute);
    const nextRelease = available.length ? Math.min(...available) : Number.POSITIVE_INFINITY;
    const wait = Number.isFinite(nextRelease)
      ? clamp(nextRelease - minute, 0, MAX_SIMULATION_WAIT_MINUTES)
      : MAX_SIMULATION_WAIT_MINUTES;
    const usablePorts = Math.max(0, snapshot.totalPorts - snapshot.faultPorts);
    const queuedOnUsablePorts = Math.min(usablePorts, snapshot.queueVehicles + preArrivalVehicles);
    const occupancy = clamp(
      (snapshot.chargingPorts + queuedOnUsablePorts) / Math.max(1, snapshot.totalPorts),
      0.05,
      0.99
    );
    const absoluteMinutes = context.departureMinutes + minute;
    const localPattern = 1 + Math.sin((station.seed % 31 + minute) / 18) * 0.04;
    const timeFactor = clamp(localPattern * timeOfDayFactor(absoluteMinutes), 0.75, 1.35);
    const p50 = waitToP50(wait);
    const p90 = Math.max(p50, waitToP90(wait));
    return {
      minute,
      absoluteMinute: Number(absoluteMinutes.toFixed(1)),
      occupancy: Number(occupancy.toFixed(3)),
      wait: Number(wait.toFixed(1)),
      p50: Number(p50.toFixed(1)),
      p90: Number(p90.toFixed(1)),
      arrivalRate: Number((station.arrivalRate * context.demandFactor * context.trafficFactor * context.weatherFactor * timeFactor).toFixed(2)),
      serviceRate: Number((available.length / Math.max(1, snapshot.averageSessionMinutes)).toFixed(2)),
      preArrivalVehicles,
      risk: p90 >= 20 || occupancy >= 0.82 ? "forecast-risk" : "forecast-ready",
      method: "port-discrete-event",
      asOf: context.asOf,
      source: SIMULATION_SOURCE,
      confidence: SIMULATION_CONFIDENCE,
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
  return {
    id: station.id,
    name: station.name,
    type: station.type,
    location: station.location,
    address: station.address,
    source: SIMULATION_SOURCE,
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
    chargingPorts: snapshot.chargingPorts,
    faultPorts: snapshot.faultPorts,
    queueVehicles: snapshot.queueVehicles,
    estimatedReleaseMinutes: snapshot.estimatedReleaseMinutes,
    averageSessionMinutes: snapshot.averageSessionMinutes,
    confidence: SIMULATION_CONFIDENCE,
    horizonMinutes: context.horizonMinutes,
    simulation: true,
    explanation: `simulation 仿真：使用 totalPorts、idlePorts、chargingPorts、faultPorts、queueVehicles、estimatedReleaseMinutes、averageSessionMinutes，先安排当前排队车辆，再安排到站偏移前的预计到达车辆，估算到站等待；dataAsOf=${dataAsOf}，不代表能链实时经营数据。`
  };
}

export function forecastStations(stations = [], scenario = {}) {
  const safeScenario = scenario && typeof scenario === "object" ? scenario : {};
  const departureMinutes = Number.isFinite(Number(safeScenario.departureMinutes))
    ? Number(safeScenario.departureMinutes)
    : parseClock(safeScenario.departureMinutes) || 0;
  const horizonMinutes = forecastHorizon(safeScenario);
  const intervalMinutes = forecastInterval(safeScenario);
  const points = [];
  for (let minute = 0; minute <= horizonMinutes + 1e-9; minute += intervalMinutes) {
    points.push(Number(minute.toFixed(1)));
  }
  if (points.at(-1) < horizonMinutes) points.push(horizonMinutes);
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
    ? stations.slice(0, 200).map((station, index) => normalizeStation(
      Object.assign({}, station, { _forecastScenario: safeScenario }),
      index
    ))
    : [];

  const forecastContext = {
    departureMinutes,
    horizonMinutes,
    intervalMinutes,
    points,
    demandFactor: scenarioFactor,
    trafficFactor,
    weatherFactor,
    asOf,
    metadata
  };

  const forecastedStations = safeStations.map((station) => {
    if (station.portSnapshot) return forecastPortStation(station, forecastContext);
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
        ...metadata
      };
    });
    const arrivalOffsetMinutes = Math.max(0, station.arrivalOffsetMinutes);
    const arrivalForecast = normalizePredictionPoint(
      selectForecastPoint(forecast, arrivalOffsetMinutes) || forecast[0],
      station,
      metadata
    );
    return {
      id: station.id,
      name: station.name,
      type: station.type,
      location: station.location,
      address: station.address,
      // `source` is the source of this forecast, not a claim about the POI.
      // Keep the original POI source separately so callers do not lose it.
      source: SIMULATION_SOURCE,
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
      confidence: SIMULATION_CONFIDENCE,
      horizonMinutes,
      simulation: true,
      // 原来标的是“每 5 分钟到达率”。模型里 arrivalRate 是按分钟外推的，
      // 5 分钟只是画图的取样间隔，不是速率的单位。同时把到站 ETA 和 simulation
      // 写进响应，避免把仿真数据误读成实时经营数据。
      explanation: `simulation 仿真：按预计到站 ${arrivalOffsetMinutes.toFixed(0)} 分钟、当前占用率 ${(station.occupancy * 100).toFixed(0)}%、到达率 ${station.arrivalRate.toFixed(1)} 辆/分钟、服务率 ${station.serviceRate.toFixed(1)} 辆/分钟估计，不代表能链实时经营数据。`
    };
  });

  return {
    horizonMinutes,
    intervalMinutes,
    asOf,
    method: forecastedStations.some((station) => station.method === "port-discrete-event")
      ? "port-discrete-event"
      : "aggregate-flow-simulation",
    dataAsOf: forecastedStations.find((station) => station.dataAsOf)?.dataAsOf || asOf,
    freshnessSeconds: forecastedStations.find((station) => Number.isFinite(station.freshnessSeconds))?.freshnessSeconds ?? null,
    source: SIMULATION_SOURCE,
    confidence: SIMULATION_CONFIDENCE,
    simulation: true,
    // 原来写的是“当前占用率 + 到达率 - 服务率 + 时段/路况因子”：漏掉了除以
    // 车位数、站点趋势项和高占用拥堵惩罚。现在公开的口径与实际计算一致。
    model: forecastedStations.some((station) => station.method === "port-discrete-event")
      ? "simulation 仿真：端口级离散事件；按端口释放时间、当前排队和到站前预计到达车辆安排服务，不代表能链实时经营数据。"
      : "simulation 仿真：可解释队列近似；占用率随 (到达率×时段/路况/天气因子 − 服务率)/车位数 与站点趋势项外推，等待随占用率上升，超 75% 后加拥堵惩罚",
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
