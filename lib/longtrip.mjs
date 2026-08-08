import { getEnergyProfile, isFuelEnergyType } from "./energy.mjs";
import { forecastStations, selectForecastPoint, stationArrivalOffset, SIMULATION_CONFIDENCE, SIMULATION_SOURCE, waitToP50, waitToP90 } from "./forecast.mjs";
import { paretoFront } from "./decision.mjs";

const MAX_STOPS = 6;
// Six stops makes a full combinations-of-36 search unnecessarily expensive.
// Keep 18 route-coverage candidates (two per ninth of the corridor) so the
// optimiser still sees every part of a national route: sum(C(18, 0..6)) is
// only about 31k sequences, small enough for a responsive API request.
const MAX_CANDIDATES = 18;
// A hybrid is planned one energy path at a time; the caller states which one.
const ENERGY_TYPE_KEYS = new Set(["electric", "fuel", "hybridElectric", "hybridFuel"]);
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
    elapsedP50 += stationChargeMinutes + stationP50;
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
  const totalMinutesP50 = Math.round(baseDurationMinutes + chargingMinutes + p50Wait);
  const totalMinutesP90 = Math.round(baseDurationMinutes + chargingMinutes + p90Wait);
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
  const totalCost = Number(energyCost.toFixed(1));
  const evaluation = {
    waitMinutes: rounded(totalWait),
    p50WaitMinutes: Math.round(p50Wait),
    p90WaitMinutes: Math.round(p90Wait),
    etaMinutes: totalMinutesP50,
    etaP50Minutes: totalMinutesP50,
    etaP90Minutes: totalMinutesP90,
    energyCost: totalCost,
    totalCost,
    objectives: {
      fastest: totalMinutesP50,
      reliable: totalMinutesP90,
      cheapest: totalCost
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
    p50WaitMinutes: Math.round(p50Wait),
    p90WaitMinutes: Math.round(p90Wait),
    energyCost: totalCost,
    totalCost,
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
    horizonMinutes
  };
}

function enumerateSequences(candidates, maxStops) {
  const sequences = [[]];
  const visit = (start, sequence) => {
    if (sequence.length >= maxStops) return;
    for (let index = start; index < candidates.length; index += 1) {
      const next = sequence.concat(candidates[index]);
      sequences.push(next);
      visit(index + 1, next);
    }
  };
  visit(0, []);
  return sequences;
}

function candidateScore(station, totalDistanceKm, input = {}) {
  const explicit = explicitStationOffset(station, input);
  const offset = Number.isFinite(explicit)
    ? explicit
    : estimatedDrivingOffset(station, totalDistanceKm, Math.max(0, finite(input.durationMinutes)));
  const prediction = resolveStationPrediction(station, offset);
  return station._detourKm * 12 + prediction.p90 + prediction.p50 * 0.25;
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
  // time and typical (P50) station waiting time have all been included.
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
  // Lowest cost is energy purchase first; actual road tolls are added later
  // after every candidate is verified by the AMap road-routing response.
  cheapest: (a, b) => a.energyCost - b.energyCost
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
  const maxStops = clamp(Math.floor(finite(input.maxStops, MAX_STOPS)), 0, MAX_STOPS);
  const planningStations = attachOptionalForecasts(input.stations, input);
  const rankedCandidates = planningStations
    .map((station) => Object.assign({}, station, {
      _progressKm: stationProgress(station, totalDistanceKm),
      _detourKm: stationDetour(station)
    }))
    .filter((station) => Number.isFinite(station._progressKm) && station._progressKm > 1 && station._progressKm < totalDistanceKm - 1)
    .sort((a, b) => a._progressKm - b._progressKm
      || a._detourKm - b._detourKm
      || candidateScore(a, totalDistanceKm, input) - candidateScore(b, totalDistanceKm, input));
  const candidates = selectCoverageCandidates(rankedCandidates, totalDistanceKm, MAX_CANDIDATES, input);

  const evaluated = enumerateSequences(candidates, maxStops)
    .map((sequence) => evaluateSequence(sequence, input))
    .filter(Boolean);
  const feasible = uniquePlansByStops(evaluated);
  if (!feasible.length) {
    return { plans: [], candidatesConsidered: candidates.length, maxStops, reason: "NO_FEASIBLE_SEQUENCE" };
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
      cheapest: "最小化补能成本"
    },
    candidatesConsidered: candidates.length,
    maxStops,
    reason: null
  };
}
