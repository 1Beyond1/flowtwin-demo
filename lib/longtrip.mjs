import { getEnergyProfile, isFuelEnergyType } from "./energy.mjs";
import { forecastStations, selectForecastPoint, stationArrivalOffset, SIMULATION_CONFIDENCE, SIMULATION_SOURCE, waitToP50, waitToP90 } from "./forecast.mjs";
import { paretoFront } from "./decision.mjs";

const MAX_STOPS = 6;
// Six remains the normal/default bound. Long-trip adaptive planning gets a
// larger but explicit twelve-stop ceiling: enough for the previously tested
// Beijing→布达拉宫 class of trip without turning every click into dozens of
// route-verification requests.
const MAX_ADAPTIVE_STOPS = 12;
// Legacy direct callers keep an 18-candidate route-coverage sample (two per
// ninth of the corridor). Adaptive browser planning passes through the full
// bounded request candidate set and protects computation with the separate
// evaluation budget below.
const MAX_CANDIDATES = 18;
// Adaptive planning may inspect more candidates than the normal six-stop
// route, but it still needs a finite input bound so a dense POI response
// cannot turn one click into an unbounded combinatorial search.
const MAX_ADAPTIVE_CANDIDATES = 72;
// This protects an exposed HTTP endpoint from a dense POI payload. It is an
// evaluation budget, not a limit on how many refuelling stops a valid route
// may contain. The adaptive seed below is always evaluated before this budget.
const MAX_ADAPTIVE_SEQUENCE_EVALUATIONS = 12000;
// A hybrid is planned one energy path at a time; the caller states which one.
const ENERGY_TYPE_KEYS = new Set(["electric", "fuel", "hybridElectric", "hybridFuel"]);
// AMap POIs and the current demo feed do not expose payment/exit timestamps.
// Keep this as a separate, explicit buffer instead of hiding it inside queue
// wait or charge time. A future enterprise adapter can override it per station.
export const DEFAULT_PAYMENT_EXIT_MINUTES = Object.freeze({ fuel: 3, electric: 5 });
// 标准正态的 90 分位。用来在 p50/p90 和标准差之间来回换算。
const Z90 = 1.2816;

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rounded(value, digits = 1) {
  return Number(Number(value || 0).toFixed(digits));
}

function forecastArray(station) {
  const candidates = [station?.forecast, station?.predictions, station?.waitForecast, station?.queueForecast, station?.arrivalForecast, station?.waitByArrival, station?.predictedWaits];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map((point, index) => typeof point === "number" ? { minute: index * 5, wait: point } : point);
    }
    if (candidate && typeof candidate === "object") {
      return Object.entries(candidate).map(([minute, point]) => typeof point === "number"
        ? { minute: Number(minute), wait: point }
        : Object.assign({}, point, { minute: point?.minute ?? Number(minute) }));
    }
  }
  return null;
}

function staticStationPrediction(station) {
  const fallbackWait = Math.max(0, finite(station?.wait, finite(station?.p50, 0)));
  const wait = Math.max(0, finite(station?.wait, fallbackWait));
  const p50 = Math.max(0, finite(station?.p50, waitToP50(wait)));
  const p90 = Math.max(p50, finite(station?.p90, waitToP90(wait)));
  return {
    wait: rounded(wait),
    p50: rounded(p50),
    p90: rounded(p90),
    source: station?.source || "legacy-station-fields",
    confidence: station?.confidence || "legacy",
    confidenceScore: Number.isFinite(Number(station?.confidenceScore)) ? Number(station.confidenceScore) : null,
    confidenceLevel: station?.confidenceLevel || null,
    confidenceLabel: station?.confidenceLabel || null,
    confidenceReasons: Array.isArray(station?.confidenceReasons) ? station.confidenceReasons.slice(0, 8) : [],
    asOf: station?.asOf || null,
    horizonMinutes: Number.isFinite(Number(station?.horizonMinutes)) ? Number(station.horizonMinutes) : null,
    forecastMinute: null,
    requestedOffsetMinutes: null,
    interpolated: false
  };
}

/**
 * Pick a station's wait at the ETA that the sequence actually reaches it.
 * Forecast payloads are preferred; p50/p90/wait on the station remain a
 * compatibility fallback for older clients and fixtures.
 */
export function resolveStationPrediction(station = {}, arrivalOffsetMinutes = 0) {
  const points = forecastArray(station);
  if (!points?.length) return staticStationPrediction(station);
  const selected = selectForecastPoint(points, arrivalOffsetMinutes);
  if (!selected) return staticStationPrediction(station);
  const fallback = staticStationPrediction(station);
  const wait = Math.max(0, finite(selected.wait, fallback.wait));
  const p50 = Math.max(0, finite(selected.p50, waitToP50(wait)));
  const p90 = Math.max(p50, finite(selected.p90, waitToP90(wait)));
  return {
    wait: rounded(wait),
    p50: rounded(p50),
    p90: rounded(p90),
    source: selected.source || station.source || SIMULATION_SOURCE,
    confidence: selected.confidence || station.confidence || SIMULATION_CONFIDENCE,
    confidenceScore: Number.isFinite(Number(selected.confidenceScore))
      ? Number(selected.confidenceScore)
      : Number.isFinite(Number(station.confidenceScore)) ? Number(station.confidenceScore) : null,
    confidenceLevel: selected.confidenceLevel || station.confidenceLevel || null,
    confidenceLabel: selected.confidenceLabel || station.confidenceLabel || null,
    confidenceReasons: Array.isArray(selected.confidenceReasons)
      ? selected.confidenceReasons.slice(0, 8)
      : Array.isArray(station.confidenceReasons) ? station.confidenceReasons.slice(0, 8) : [],
    asOf: selected.asOf || station.asOf || null,
    horizonMinutes: Number.isFinite(Number(selected.horizonMinutes))
      ? Number(selected.horizonMinutes)
      : Number.isFinite(Number(station.horizonMinutes)) ? Number(station.horizonMinutes) : null,
    forecastMinute: Number.isFinite(Number(selected.minute)) ? Number(selected.minute) : null,
    requestedOffsetMinutes: Number.isFinite(Number(selected.requestedOffsetMinutes))
      ? Number(selected.requestedOffsetMinutes)
      : Number(arrivalOffsetMinutes) || 0,
    interpolated: Boolean(selected.interpolated)
  };
}

function explicitStationOffset(station, input) {
  const direct = [
    station?._arrivalOffsetMinutes,
    station?.arrivalOffsetMinutes,
    station?.etaMinutes,
    station?.eta
  ].map(Number).find(Number.isFinite);
  if (Number.isFinite(direct)) return Math.max(0, direct);
  const offset = stationArrivalOffset(station, input);
  // stationArrivalOffset returns zero for a missing value. Zero is a valid ETA,
  // but a station at least one kilometre along the route is normally not a
  // zero-minute stop, so only use it when the caller actually supplied an ETA.
  const hasAbsolute = [station?.arrivalMinute, station?.arrivalAtMinutes, station?.arrivalAt, station?.arrivalTime]
    .some((value) => value !== undefined && value !== null && String(value).trim() !== "");
  return hasAbsolute ? offset : Number.NaN;
}

function estimatedDrivingOffset(station, totalDistanceKm, baseDurationMinutes) {
  const explicit = Number(station?._progressKm);
  if (Number.isFinite(explicit) && totalDistanceKm > 0) {
    return Math.max(0, baseDurationMinutes * explicit / totalDistanceKm);
  }
  return 0;
}

function attachOptionalForecasts(stations, input) {
  const raw = Array.isArray(stations) ? stations : [];
  const shouldForecast = input && input.useForecast !== false && Number.isFinite(Number(input.departureMinutes));
  if (!shouldForecast || raw.some((station) => forecastArray(station)?.length)) return raw;
  const generated = forecastStations(raw, {
    departureMinutes: Number(input.departureMinutes),
    horizonMinutes: input.horizonMinutes,
    intervalMinutes: input.intervalMinutes,
    demandFactor: input.demandFactor,
    trafficFactor: input.trafficFactor,
    weatherFactor: input.weatherFactor
  });
  const byId = new Map(generated.stations.map((station) => [String(station.id), station]));
  return raw.map((station) => {
    const prediction = byId.get(String(station?.id));
    if (!prediction) return station;
    return Object.assign({}, prediction, station, {
      forecast: prediction.forecast,
      prediction: prediction.prediction,
      arrivalForecast: prediction.arrivalForecast,
      arrivalOffsetMinutes: prediction.arrivalOffsetMinutes,
      etaMinutes: prediction.etaMinutes,
      arrivalMinute: prediction.arrivalMinute,
      wait: prediction.wait,
      p50: prediction.p50,
      p90: prediction.p90,
      source: prediction.source,
      stationSource: station.source || prediction.stationSource,
      asOf: prediction.asOf,
      confidence: prediction.confidence,
      confidenceScore: prediction.confidenceScore,
      confidenceLevel: prediction.confidenceLevel,
      confidenceLabel: prediction.confidenceLabel,
      confidenceReasons: prediction.confidenceReasons,
      horizonMinutes: prediction.horizonMinutes
    });
  });
}

function stationDetour(station) {
  return Math.max(0, finite(station?.detourKm ?? station?.detour, 0));
}

function stationProgress(station, totalDistanceKm) {
  const direct = finite(station?.progressKm, NaN);
  if (Number.isFinite(direct)) return clamp(direct, 0, totalDistanceKm);
  const ratio = finite(station?.routeProgress, NaN);
  return Number.isFinite(ratio) ? clamp(ratio, 0, 1) * totalDistanceKm : NaN;
}

function chargeMinutes(amount, energyType, station) {
  if (amount <= 1e-6) return 0;
  if (isFuelEnergyType(energyType)) {
    // These rates are an explicit demo estimate unless a future station-data
    // adapter provides them. They allow the route objectives to compare the
    // duration of different refuelling stops without claiming live telemetry.
    const litresPerMinute = clamp(finite(station?.estimatedRefuelRateLpm, 8), 3, 16);
    return Math.max(4, Math.ceil(amount / litresPerMinute + 2));
  }
  // AMap POIs do not expose charger power. Use a deterministic, labelled
  // estimate here so the fast option can optimise total charging time instead
  // of merely choosing the lowest queue time.
  const averagePower = clamp(finite(station?.estimatedChargePowerKw, 110), 50, 300);
  return Math.max(4, Math.ceil(amount / averagePower * 60 + 3));
}

export function paymentExitMinutes(energyType, station = {}) {
  const explicit = Number(
    station?.paymentExitMinutes
      ?? station?.paymentExitBufferMinutes
      ?? station?.paymentAndExitMinutes
  );
  if (Number.isFinite(explicit)) return Number(clamp(explicit, 1, 15).toFixed(1));
  return isFuelEnergyType(energyType)
    ? DEFAULT_PAYMENT_EXIT_MINUTES.fuel
    : DEFAULT_PAYMENT_EXIT_MINUTES.electric;
}

function segmentDistances(sequence, totalDistanceKm) {
  if (!sequence.length) return [totalDistanceKm];
  const distances = [];
  let previousProgress = 0;
  let previousDetour = 0;
  sequence.forEach((station) => {
    const progress = station._progressKm;
    const detour = station._detourKm;
    distances.push(Math.max(0, progress - previousProgress + previousDetour / 2 + detour / 2));
    previousProgress = progress;
    previousDetour = detour;
  });
  distances.push(Math.max(0, totalDistanceKm - previousProgress + previousDetour / 2));
  return distances;
}

function planConfidence(stops) {
  const scored = stops.filter((stop) => Number.isFinite(Number(stop?.confidenceScore)));
  if (!scored.length) return { score: null, level: null, label: null };
  const score = Number((scored.reduce((sum, stop) => sum + Number(stop.confidenceScore), 0) / scored.length).toFixed(0));
  const level = scored.some((stop) => stop.confidenceLevel === "low") || score < 56
    ? "low"
    : scored.some((stop) => stop.confidenceLevel === "medium") || score < 76
      ? "medium"
      : "high";
  return {
    score,
    level,
    label: `${level === "high" ? "高" : level === "medium" ? "中" : "低"}（演示口径）`
  };
}

function evaluateSequence(sequence, input) {
  const energyType = ENERGY_TYPE_KEYS.has(input.energyType) ? input.energyType : "electric";
  const isFuel = isFuelEnergyType(energyType);
  const profile = getEnergyProfile(energyType);
  const totalDistanceKm = Math.max(0, finite(input.distanceKm));
  const baseDurationMinutes = Math.max(0, finite(input.durationMinutes));
  const departureMinutes = Number.isFinite(Number(input.departureMinutes)) ? Number(input.departureMinutes) : null;
  const soc = clamp(finite(input.soc, 0), 0, 100);
  const minArrivalSoc = clamp(finite(input.minArrivalSoc, profile.safetyReservePercent), 0, 100);
  const maxDetourKm = Number.isFinite(Number(input.maxDetourKm)) ? Math.max(0, Number(input.maxDetourKm)) : Infinity;
  const currentStartEnergy = profile.capacity * soc / 100;
  const destinationTargetEnergy = profile.capacity * minArrivalSoc / 100;
  const safetyEnergy = profile.capacity * profile.safetyReservePercent / 100;
  const totalDetourKm = sequence.reduce((sum, station) => sum + station._detourKm, 0);
  if (totalDetourKm > maxDetourKm + 1e-6) return null;

  const legs = segmentDistances(sequence, totalDistanceKm);
  let energy = currentStartEnergy;
  let totalAmount = 0;
  let energyCost = 0;
  let p50Wait = 0;
  let totalWait = 0;
  let waitVariance = 0;
  let chargingMinutes = 0;
  let paymentExitMinutesTotal = 0;
  let elapsedP50 = 0;
  const forecastSources = new Set();
  const forecastAsOf = new Set();
  const forecastHorizons = [];
  const stops = [];
  let drivingDistanceToStation = 0;

  for (let index = 0; index < sequence.length; index += 1) {
    const station = sequence[index];
    const legDistanceKm = legs[index];
    drivingDistanceToStation += legDistanceKm;
    energy -= legDistanceKm * profile.consumptionPerKm;
    if (energy < safetyEnergy - 1e-6) return null;
    const nextLegDistanceKm = legs[index + 1];
    const requiredAfterStop = nextLegDistanceKm * profile.consumptionPerKm + (index === sequence.length - 1 ? destinationTargetEnergy : safetyEnergy);
    if (requiredAfterStop > profile.capacity + 1e-6) return null;
    const amount = Math.max(0, (requiredAfterStop - energy) / profile.transferEfficiency);
    const freeAmount = Math.max(0, (profile.capacity - energy) / profile.transferEfficiency);
    if (amount > freeAmount + 1e-6) return null;
    const stationChargeMinutes = chargeMinutes(amount, energyType, station);
    const arrivalSoc = clamp(energy / profile.capacity * 100, 0, 100);
    const estimatedArrivalOffset = totalDistanceKm > 0
      ? baseDurationMinutes * drivingDistanceToStation / Math.max(totalDistanceKm, totalDistanceKm + totalDetourKm)
      : 0;
    const explicitArrivalOffset = explicitStationOffset(station, input);
    const arrivalOffsetMinutes = Number.isFinite(explicitArrivalOffset)
      ? explicitArrivalOffset
      : estimatedArrivalOffset + elapsedP50;
    const prediction = resolveStationPrediction(station, arrivalOffsetMinutes);
    energy += amount * profile.transferEfficiency;
    totalAmount += amount;
    energyCost += amount * Math.max(0, finite(station.price, 0));
    const stationWait = Math.max(0, finite(prediction.wait, prediction.p50));
    const stationP50 = Math.max(0, finite(prediction.p50, waitToP50(stationWait)));
    const stationP90 = Math.max(stationP50, finite(prediction.p90, waitToP90(stationWait)));
    const stationPaymentExitMinutes = paymentExitMinutes(energyType, station);
    totalWait += stationWait;
    p50Wait += stationP50;
    // 分位数不可加：把各站 P90 直接相加，等于假定四个停站同时踩中各自最差的
    // 那 10%——真要独立发生，概率是万分之一。而且停得越多罚得越重，reliable
    // 排序恰好是按 totalMinutesP90 排的，等于凭空偏袒少停站的方案。
    // 改成按独立性卷积：由每站自己的 p50/p90 反解标准差（正态近似下
    // p90 = p50 + 1.2816σ），总体方差取各站之和，最后再还原成 P90。
    // 单停时退化为该站原始 P90，与旧口径一致。
    const sigma = Math.max(0, (stationP90 - stationP50) / Z90);
    waitVariance += sigma * sigma;
    chargingMinutes += stationChargeMinutes;
    paymentExitMinutesTotal += stationPaymentExitMinutes;
    elapsedP50 += stationChargeMinutes + stationP50 + stationPaymentExitMinutes;
    if (prediction.source) forecastSources.add(String(prediction.source));
    if (prediction.asOf) forecastAsOf.add(String(prediction.asOf));
    if (Number.isFinite(Number(prediction.horizonMinutes))) forecastHorizons.push(Number(prediction.horizonMinutes));
    stops.push({
      id: station.id,
      name: station.name,
      progressKm: Number(station._progressKm.toFixed(1)),
      detourKm: Number(station._detourKm.toFixed(1)),
      arrivalOffsetMinutes: rounded(arrivalOffsetMinutes),
      arrivalMinute: departureMinutes === null ? null : rounded(departureMinutes + arrivalOffsetMinutes),
      arrivalSoc: Number(arrivalSoc.toFixed(1)),
      targetSoc: Number((energy / profile.capacity * 100).toFixed(1)),
      amount: Number(amount.toFixed(1)),
      unit: profile.unit,
      chargeMinutes: stationChargeMinutes,
      paymentExitMinutes: stationPaymentExitMinutes,
      stopMinutesP50: Number((stationP50 + stationChargeMinutes + stationPaymentExitMinutes).toFixed(1)),
      stopMinutesP90: Number((stationP90 + stationChargeMinutes + stationPaymentExitMinutes).toFixed(1)),
      estimatedChargePowerKw: isFuel ? null : Number(clamp(finite(station.estimatedChargePowerKw, 110), 50, 300).toFixed(0)),
      estimatedRefuelRateLpm: isFuel ? Number(clamp(finite(station.estimatedRefuelRateLpm, 8), 3, 16).toFixed(1)) : null,
      wait: rounded(stationWait),
      p50: rounded(stationP50),
      p90: rounded(stationP90),
      forecastMinute: prediction.forecastMinute,
      forecastRequestedOffsetMinutes: prediction.requestedOffsetMinutes,
      forecastInterpolated: prediction.interpolated,
      asOf: prediction.asOf,
      source: prediction.source,
      confidence: prediction.confidence,
      horizonMinutes: prediction.horizonMinutes,
      price: Number(Math.max(0, finite(station.price, 0)).toFixed(2))
    });
  }

  const p90Wait = p50Wait + Z90 * Math.sqrt(waitVariance);
  const finalLegDistanceKm = legs.at(-1) || 0;
  energy -= finalLegDistanceKm * profile.consumptionPerKm;
  if (energy < destinationTargetEnergy - 1e-6) return null;
  const arrivalSoc = clamp(energy / profile.capacity * 100, 0, 100);
  const totalDistanceWithDetourKm = totalDistanceKm + totalDetourKm;
  const totalStopMinutesP50 = Math.round(chargingMinutes + paymentExitMinutesTotal + p50Wait);
  const totalStopMinutesP90 = Math.round(chargingMinutes + paymentExitMinutesTotal + p90Wait);
  const totalMinutesP50 = Math.round(baseDurationMinutes + totalStopMinutesP50);
  const totalMinutesP90 = Math.round(baseDurationMinutes + totalStopMinutesP90);
  const hasDeadline = Number.isFinite(Number(input.deadlineOffsetMinutes))
    || Number.isFinite(Number(input.deadlineMinutes))
    || Number.isFinite(Number(input.arrivalDeadlineMinutes));
  let deadlineOffsetMinutes = null;
  if (hasDeadline) {
    if (Number.isFinite(Number(input.deadlineOffsetMinutes))) {
      deadlineOffsetMinutes = Math.max(0, Number(input.deadlineOffsetMinutes));
    } else {
      const absoluteDeadline = Number(input.deadlineMinutes ?? input.arrivalDeadlineMinutes);
      deadlineOffsetMinutes = departureMinutes === null
        ? Math.max(0, absoluteDeadline)
        : Math.max(0, absoluteDeadline - departureMinutes);
    }
  }
  const p50LateMinutes = deadlineOffsetMinutes === null ? 0 : Math.max(0, totalMinutesP50 - deadlineOffsetMinutes);
  const p90LateMinutes = deadlineOffsetMinutes === null ? 0 : Math.max(0, totalMinutesP90 - deadlineOffsetMinutes);
  // A supplied deadline is a hard feasibility condition.  Without one the
  // legacy API keeps returning all physically feasible sequences.
  if (hasDeadline && p90LateMinutes > 0) return null;
  const source = forecastSources.size === 1
    ? [...forecastSources][0]
    : forecastSources.size > 1 ? "mixed" : "legacy-station-fields";
  const asOf = forecastAsOf.size === 1 ? [...forecastAsOf][0] : null;
  const horizonMinutes = forecastHorizons.length ? Math.max(...forecastHorizons) : null;
  const confidenceSummary = planConfidence(stops);
  const totalCost = Number(energyCost.toFixed(1));
  const roadTolls = Math.max(0, finite(input.roadTolls, 0));
  const serviceCost = Math.max(0, finite(input.serviceCost, 0));
  const fullCost = Number((energyCost + roadTolls + serviceCost).toFixed(1));
  const evaluation = {
    waitMinutes: rounded(totalWait),
    queueWaitMinutes: rounded(totalWait),
    p50WaitMinutes: Math.round(p50Wait),
    p90WaitMinutes: Math.round(p90Wait),
    serviceMinutes: Math.round(chargingMinutes),
    paymentExitMinutes: Math.round(paymentExitMinutesTotal),
    totalStopMinutesP50,
    totalStopMinutesP90,
    etaMinutes: totalMinutesP50,
    etaP50Minutes: totalMinutesP50,
    etaP90Minutes: totalMinutesP90,
    energyCost: totalCost,
    roadTolls: Number(roadTolls.toFixed(1)),
    serviceCost: Number(serviceCost.toFixed(1)),
    totalCost: fullCost,
    objectives: {
      fastest: totalMinutesP50,
      reliable: totalMinutesP90,
      cheapest: fullCost
    }
  };
  return {
    stopCount: sequence.length,
    stops,
    legs: legs.map((distanceKm) => Number(distanceKm.toFixed(1))),
    totalDetourKm: Number(totalDetourKm.toFixed(1)),
    totalDistanceKm: Number(totalDistanceWithDetourKm.toFixed(1)),
    totalAmount: Number(totalAmount.toFixed(1)),
    unit: profile.unit,
    chargingMinutes,
    waitMinutes: rounded(totalWait),
    totalWaitMinutes: rounded(totalWait),
    queueWaitMinutes: rounded(totalWait),
    p50WaitMinutes: Math.round(p50Wait),
    p90WaitMinutes: Math.round(p90Wait),
    serviceMinutes: Math.round(chargingMinutes),
    paymentExitMinutes: Math.round(paymentExitMinutesTotal),
    totalStopMinutesP50,
    totalStopMinutesP90,
    energyCost: totalCost,
    roadTolls: Number(roadTolls.toFixed(1)),
    serviceCost: Number(serviceCost.toFixed(1)),
    totalCost: fullCost,
    totalMinutesP50,
    totalMinutesP90,
    etaMinutes: totalMinutesP50,
    etaP50Minutes: totalMinutesP50,
    etaP90Minutes: totalMinutesP90,
    arrivalOffsetMinutes: totalMinutesP50,
    arrivalMinutes: departureMinutes === null ? null : departureMinutes + totalMinutesP50,
    arrivalSoc: Number(arrivalSoc.toFixed(1)),
    targetArrivalSoc: minArrivalSoc,
    deadlineOffsetMinutes,
    p50LateMinutes,
    p90LateMinutes,
    lateMinutes: p90LateMinutes,
    feasible: true,
    timingFeasible: true,
    evaluation,
    metrics: evaluation,
    objectiveValues: evaluation.objectives,
    forecastSource: source,
    asOf,
    confidence: source === SIMULATION_SOURCE ? SIMULATION_CONFIDENCE : "legacy",
    confidenceScore: confidenceSummary.score,
    confidenceLevel: confidenceSummary.level,
    confidenceLabel: confidenceSummary.label,
    horizonMinutes
  };
}

function enumerateSequences(candidates, maxStops, minStops = 0, limit = Infinity, meta = null) {
  const sequences = [[]];
  if (minStops > 0) sequences.length = 0;
  const visit = (start, sequence) => {
    if (sequences.length >= limit) {
      if (meta && Number.isFinite(limit)) meta.exhausted = true;
      return;
    }
    if (sequence.length >= minStops && sequence.length > 0) sequences.push(sequence);
    if (sequence.length >= maxStops) return;
    for (let index = start; index < candidates.length; index += 1) {
      const next = sequence.concat(candidates[index]);
      visit(index + 1, next);
      if (sequences.length >= limit) {
        if (meta && Number.isFinite(limit)) meta.exhausted = true;
        return;
      }
    }
  };
  visit(0, []);
  return sequences;
}

function buildAdaptiveGreedySequence(candidates, totalDistanceKm, input = {}, maxStops = MAX_ADAPTIVE_STOPS) {
  const energyType = ENERGY_TYPE_KEYS.has(input.energyType) ? input.energyType : "electric";
  const profile = getEnergyProfile(energyType);
  const soc = clamp(finite(input.soc, 0), 0, 100);
  const requestedReserve = input.minArrivalSoc === null || input.minArrivalSoc === undefined || input.minArrivalSoc === ""
    ? profile.safetyReservePercent
    : clamp(finite(input.minArrivalSoc, profile.safetyReservePercent), 0, 100);
  const safetyEnergy = profile.capacity * profile.safetyReservePercent / 100;
  const startEnergy = profile.capacity * soc / 100;
  const initialRange = Math.max(0, startEnergy - safetyEnergy) / profile.consumptionPerKm;
  const fullRange = Math.max(0, profile.capacity - safetyEnergy) / profile.consumptionPerKm;
  const finalRange = Math.max(0, profile.capacity - profile.capacity * requestedReserve / 100) / profile.consumptionPerKm;
  const sorted = candidates.slice().sort((a, b) => a._progressKm - b._progressKm);
  const sequence = [];
  let cursor = -1;
  let previousProgress = 0;
  let previousDetour = 0;

  for (let step = 0; step <= maxStops; step += 1) {
    const finalLeg = totalDistanceKm - previousProgress + previousDetour / 2;
    if (sequence.length > 0 && finalLeg <= finalRange + 1e-6) return sequence;
    if (sequence.length >= maxStops) return null;
    const availableRange = sequence.length === 0 ? initialRange : fullRange;
    let nextIndex = -1;
    for (let index = cursor + 1; index < sorted.length; index += 1) {
      const candidate = sorted[index];
      const leg = candidate._progressKm - previousProgress + previousDetour / 2 + candidate._detourKm / 2;
      if (leg <= availableRange + 1e-6) nextIndex = index;
      if (candidate._progressKm >= totalDistanceKm - 1) break;
    }
    if (nextIndex < 0) return null;
    const station = sorted[nextIndex];
    sequence.push(station);
    cursor = nextIndex;
    previousProgress = station._progressKm;
    previousDetour = station._detourKm;
  }
  return null;
}

function candidateScore(station, totalDistanceKm, input = {}) {
  const explicit = explicitStationOffset(station, input);
  const offset = Number.isFinite(explicit)
    ? explicit
    : estimatedDrivingOffset(station, totalDistanceKm, Math.max(0, finite(input.durationMinutes)));
  const prediction = resolveStationPrediction(station, offset);
  return station._detourKm * 12 + prediction.p90 + prediction.p50 * 0.25;
}

function estimateMinimumStopCount(input = {}, totalDistanceKm = finite(input.distanceKm)) {
  const energyType = ENERGY_TYPE_KEYS.has(input.energyType) ? input.energyType : "electric";
  const profile = getEnergyProfile(energyType);
  const distance = Math.max(0, finite(totalDistanceKm));
  const soc = clamp(finite(input.soc, 0), 0, 100);
  const safetyPercent = profile.safetyReservePercent;
  const requestedReserve = input.minArrivalSoc === null || input.minArrivalSoc === undefined || input.minArrivalSoc === ""
    ? safetyPercent
    : clamp(finite(input.minArrivalSoc, safetyPercent), 0, 100);
  const startEnergy = profile.capacity * soc / 100;
  const safetyEnergy = profile.capacity * safetyPercent / 100;
  const initialSafeRange = Math.max(0, startEnergy - safetyEnergy) / profile.consumptionPerKm;
  const fullSafeRange = Math.max(1e-6, profile.capacity - safetyEnergy) / profile.consumptionPerKm;
  const finalLegRange = Math.max(0, profile.capacity - profile.capacity * requestedReserve / 100) / profile.consumptionPerKm;
  if (distance <= initialSafeRange + 1e-6) return 0;
  const distanceAfterFirstAndFinal = distance - initialSafeRange - finalLegRange;
  // Once the initial tank is not enough, at least one stop is required. The
  // first stop covers the initial refill; every extra full safety-bounded leg
  // adds one more stop, so the +1 is intentional rather than an off-by-one.
  return distanceAfterFirstAndFinal <= 1e-6
    ? 1
    : Math.ceil(distanceAfterFirstAndFinal / fullSafeRange) + 1;
}

function selectCoverageCandidates(sortedCandidates, totalDistanceKm, maxCandidates, input = {}) {
  if (sortedCandidates.length <= maxCandidates) return sortedCandidates;
  const bucketCount = Math.max(1, Math.ceil(maxCandidates / 2));
  const buckets = Array.from({ length: bucketCount }, () => []);
  sortedCandidates.forEach((station) => {
    const ratio = totalDistanceKm > 0 ? station._progressKm / totalDistanceKm : 0;
    const index = clamp(Math.floor(ratio * bucketCount), 0, bucketCount - 1);
    buckets[index].push(station);
  });
  buckets.forEach((bucket) => bucket.sort((a, b) => candidateScore(a, totalDistanceKm, input) - candidateScore(b, totalDistanceKm, input) || a._progressKm - b._progressKm));

  const selected = [];
  // First pass guarantees one high-quality candidate in every occupied route
  // section. The second pass preserves local alternatives for queue/price
  // comparison without allowing a dense city cluster to consume the pool.
  for (let pass = 0; pass < 2 && selected.length < maxCandidates; pass += 1) {
    buckets.forEach((bucket) => {
      const candidate = bucket[pass];
      if (candidate && selected.length < maxCandidates) selected.push(candidate);
    });
  }
  if (selected.length < maxCandidates) {
    sortedCandidates
      .filter((candidate) => !selected.includes(candidate))
      .sort((a, b) => candidateScore(a, totalDistanceKm, input) - candidateScore(b, totalDistanceKm, input) || a._progressKm - b._progressKm)
      .slice(0, maxCandidates - selected.length)
      .forEach((candidate) => selected.push(candidate));
  }
  return selected.sort((a, b) => a._progressKm - b._progressKm || candidateScore(a, totalDistanceKm, input) - candidateScore(b, totalDistanceKm, input));
}

function stationIdentity(station = {}) {
  const id = String(station?.id ?? "").trim();
  if (id) return `id:${id}`;
  const location = Array.isArray(station?.location)
    ? station.location.map((value) => Number(value).toFixed(6)).join(",")
    : String(station?.location ?? station?.coordinate ?? "").trim();
  const progress = Number.isFinite(Number(station?.progressKm))
    ? Number(station.progressKm).toFixed(2)
    : Number.isFinite(Number(station?.routeProgress)) ? Number(station.routeProgress).toFixed(5) : "";
  const name = String(station?.name ?? "").trim().toLowerCase();
  return `fallback:${name}|${location}|${progress}`;
}

function dedupeStations(stations = []) {
  const seen = new Set();
  const unique = [];
  let duplicatesRemoved = 0;
  for (const station of Array.isArray(stations) ? stations : []) {
    const key = stationIdentity(station);
    if (seen.has(key)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(key);
    unique.push(station);
  }
  return { stations: unique, duplicatesRemoved };
}

function uniquePlansByStops(plans) {
  const seen = new Set();
  return plans.filter((plan) => {
    const key = plan.stops.map((stop) => stop.id).join("|") || "direct";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function planSignature(plan) {
  return (plan?.stops || []).map((stop) => stop.id).join("|") || "direct";
}

const OBJECTIVE_LABELS = {
  fastest: "fastest",
  reliable: "reliable",
  cheapest: "cheapest"
};

const PARETO_OBJECTIVES = [
  { key: "totalMinutesP50", direction: "min" },
  { key: "totalMinutesP90", direction: "min" },
  { key: "energyCost", direction: "min" }
];

const objectiveComparators = {
  // Fastest means the earliest ETA after real driving time, estimated charge
  // time, typical (P50) queue wait and the explicit payment/exit buffer have
  // all been included.
  fastest: (a, b) => a.totalMinutesP50 - b.totalMinutesP50
    || a.chargingMinutes - b.chargingMinutes
    || a.p50WaitMinutes - b.p50WaitMinutes
    || a.totalDetourKm - b.totalDetourKm
    || a.energyCost - b.energyCost,
  // Reliable deliberately optimises the tail outcome rather than the average:
  // lower P90 wait, fewer high-risk stops, then a larger arrival reserve.
  reliable: (a, b) => a.totalMinutesP90 - b.totalMinutesP90
    || a.p90WaitMinutes - b.p90WaitMinutes
    || b.arrivalSoc - a.arrivalSoc
    || a.totalDetourKm - b.totalDetourKm
    || a.energyCost - b.energyCost,
  // Lowest cost uses the cost fields actually supplied to this planner. When
  // road tolls or service costs are unavailable they remain explicitly zero;
  // the result must not pretend to know an unprovided price.
  cheapest: (a, b) => a.totalCost - b.totalCost
    || a.energyCost - b.energyCost
    || a.roadTolls - b.roadTolls
    || a.totalDetourKm - b.totalDetourKm
    || a.totalMinutesP50 - b.totalMinutesP50
    || a.p90WaitMinutes - b.p90WaitMinutes
};

function selectObjectivePlans(feasible) {
  const raw = {};
  ["fastest", "reliable", "cheapest"].forEach((objective) => {
    const sorted = feasible.slice().sort(objectiveComparators[objective]);
    raw[objective] = sorted[0] || null;
  });
  const objectiveBySignature = new Map();
  Object.entries(raw).forEach(([objective, plan]) => {
    if (!plan) return;
    const signature = planSignature(plan);
    if (!objectiveBySignature.has(signature)) objectiveBySignature.set(signature, []);
    objectiveBySignature.get(signature).push(objective);
  });
  const decorate = (plan, objective = null, extra = {}) => {
    if (!plan) return null;
    const objectives = objectiveBySignature.get(planSignature(plan)) || [];
    return Object.assign({}, plan, {
      objective,
      objectives,
      badges: objectives.slice(),
      objectiveLabels: Object.fromEntries(objectives.map((key) => [key, OBJECTIVE_LABELS[key]])),
      uniqueStopPlan: objectives.length <= 1,
      paretoOptimal: Boolean(extra.paretoOptimal),
      ...extra
    });
  };
  return {
    plansByObjective: Object.fromEntries(Object.entries(raw).map(([objective, plan]) => [objective, decorate(plan, objective)])),
    decorate,
    objectiveBySignature
  };
}

export function buildLongTripPlans(input = {}) {
  const totalDistanceKm = Math.max(0, finite(input.distanceKm));
  const minimumStops = estimateMinimumStopCount(input, totalDistanceKm);
  const dedupedInput = dedupeStations(input.stations);
  const planningStations = attachOptionalForecasts(dedupedInput.stations, input);
  const rankedCandidates = planningStations
    .map((station) => Object.assign({}, station, {
      _progressKm: stationProgress(station, totalDistanceKm),
      _detourKm: stationDetour(station)
    }))
    .filter((station) => Number.isFinite(station._progressKm) && station._progressKm > 1 && station._progressKm < totalDistanceKm - 1)
    .sort((a, b) => a._progressKm - b._progressKm
      || a._detourKm - b._detourKm
      || candidateScore(a, totalDistanceKm, input) - candidateScore(b, totalDistanceKm, input));
  const candidateBudget = input.adaptiveMaxStops === true
    ? Math.min(rankedCandidates.length, MAX_ADAPTIVE_CANDIDATES)
    : MAX_CANDIDATES;
  const candidates = selectCoverageCandidates(rankedCandidates, totalDistanceKm, candidateBudget, input);
  const candidateSearchComplete = rankedCandidates.length <= candidateBudget;
  // In adaptive mode the candidate set remains broad enough to cover a long
  // corridor, while the actual number of route-verification stops is capped at
  // twelve. Candidate count and stop count are intentionally separate: many
  // candidates are useful for comparing price/wait trade-offs, but only twelve
  // waypoints can be sent into a single plan.
  // If the energy model says the destination is already reachable, do not
  // enumerate optional stop subsets just to prove that a direct trip wins.
  // This is both the correct product behaviour and prevents a short route with
  // many nearby POIs from expanding into 2^18 unnecessary evaluations.
  const directRoute = minimumStops === 0;
  const maxStops = directRoute
    ? 0
    : input.adaptiveMaxStops === true
    ? clamp(Math.floor(finite(input.maxStops, MAX_ADAPTIVE_STOPS)), 0, MAX_ADAPTIVE_STOPS)
    : clamp(Math.floor(finite(input.maxStops, MAX_STOPS)), 0, MAX_STOPS);

  let sequences;
  const searchMeta = { exhausted: false };
  if (directRoute) {
    sequences = [[]];
  } else if (input.adaptiveMaxStops === true) {
    // Seed the adaptive search with a route-length-aware furthest-reachable
    // walk. This makes a valid long route available without enumerating every
    // subset of a dense station list. The bounded subset pass is only for
    // finding alternative price/wait trade-offs after the seed.
    const seed = buildAdaptiveGreedySequence(candidates, totalDistanceKm, input, maxStops);
    const alternatives = enumerateSequences(candidates, maxStops, Math.max(1, minimumStops), MAX_ADAPTIVE_SEQUENCE_EVALUATIONS, searchMeta);
    const seen = new Set();
    sequences = [];
    if (seed) {
      const signature = seed.map(stationIdentity).join("|");
      seen.add(signature);
      sequences.push(seed);
    }
    alternatives.forEach((sequence) => {
      const signature = sequence.map(stationIdentity).join("|");
      if (seen.has(signature)) return;
      seen.add(signature);
      sequences.push(sequence);
    });
  } else {
    sequences = enumerateSequences(candidates, maxStops);
  }
  const evaluated = sequences
    .map((sequence) => evaluateSequence(sequence, input))
    .filter(Boolean);
  const feasible = uniquePlansByStops(evaluated);
  if (!feasible.length) {
    return {
      plans: [],
      candidatesConsidered: candidates.length,
      candidatesAvailable: rankedCandidates.length,
      candidateSearchComplete,
      sequenceEvaluations: sequences.length,
      sequenceSearchComplete: input.adaptiveMaxStops === true ? !searchMeta?.exhausted : true,
      maxStops,
      minimumStops,
      adaptiveMaxStops: input.adaptiveMaxStops === true,
      duplicatesRemoved: dedupedInput.duplicatesRemoved,
      reason: input.adaptiveMaxStops === true && (searchMeta?.exhausted || !candidateSearchComplete)
        ? "SEARCH_BUDGET_EXHAUSTED"
        : "NO_FEASIBLE_SEQUENCE"
    };
  }

  const objectiveSelection = selectObjectivePlans(feasible);
  const pareto = paretoFront(feasible, PARETO_OBJECTIVES);
  const paretoSignatures = new Set(pareto.map(planSignature));
  const plansByObjective = Object.fromEntries(Object.entries(objectiveSelection.plansByObjective).map(([objective, plan]) => [
    objective,
    plan ? Object.assign({}, plan, { paretoOptimal: paretoSignatures.has(planSignature(plan)) }) : null
  ]));
  // Three display roles may legitimately point at one route.  The role-specific
  // object keeps the old API, while objectives/badges explain the reuse instead
  // of manufacturing an inferior “different” route just to fill a card quota.
  const selected = ["fastest", "reliable", "cheapest"]
    .map((objective) => plansByObjective[objective])
    .filter(Boolean);
  const paretoPlans = pareto.map((plan) => {
    const decorated = objectiveSelection.decorate(plan, null, {
      paretoOptimal: true,
      objective: null
    });
    return Object.assign({}, decorated, {
      objectives: decorated.objectives || [],
      badges: decorated.badges || []
    });
  });

  return {
    plans: selected,
    plansByObjective,
    paretoPlans,
    paretoFront: paretoPlans,
    objectiveDefinitions: {
      fastest: "最小化 ETA/P50",
      reliable: "最小化 ETA/P90",
      cheapest: "最小化全程演示成本（补能 + 已提供的道路通行费）"
    },
    candidatesConsidered: candidates.length,
    candidatesAvailable: rankedCandidates.length,
    candidateSearchComplete,
    sequenceEvaluations: sequences.length,
    sequenceSearchComplete: input.adaptiveMaxStops === true ? !searchMeta?.exhausted : true,
    duplicatesRemoved: dedupedInput.duplicatesRemoved,
    maxStops,
    minimumStops,
    adaptiveMaxStops: input.adaptiveMaxStops === true,
    reason: null
  };
}
