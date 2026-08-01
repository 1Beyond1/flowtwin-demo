import { getEnergyProfile, isFuelEnergyType } from "./energy.mjs";

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
  let waitVariance = 0;
  let chargingMinutes = 0;
  const stops = [];

  for (let index = 0; index < sequence.length; index += 1) {
    const station = sequence[index];
    const legDistanceKm = legs[index];
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
    energy += amount * profile.transferEfficiency;
    totalAmount += amount;
    energyCost += amount * Math.max(0, finite(station.price, 0));
    const stationP50 = Math.max(0, finite(station.p50, station.wait));
    const stationP90 = Math.max(0, finite(station.p90, station.wait));
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
    stops.push({
      id: station.id,
      name: station.name,
      progressKm: Number(station._progressKm.toFixed(1)),
      detourKm: Number(station._detourKm.toFixed(1)),
      arrivalSoc: Number(arrivalSoc.toFixed(1)),
      targetSoc: Number((energy / profile.capacity * 100).toFixed(1)),
      amount: Number(amount.toFixed(1)),
      unit: profile.unit,
      chargeMinutes: stationChargeMinutes,
      estimatedChargePowerKw: isFuel ? null : Number(clamp(finite(station.estimatedChargePowerKw, 110), 50, 300).toFixed(0)),
      estimatedRefuelRateLpm: isFuel ? Number(clamp(finite(station.estimatedRefuelRateLpm, 8), 3, 16).toFixed(1)) : null,
      p50: Math.round(Math.max(0, finite(station.p50, station.wait))),
      p90: Math.round(Math.max(0, finite(station.p90, station.wait))),
      price: Number(Math.max(0, finite(station.price, 0)).toFixed(2))
    });
  }

  const p90Wait = p50Wait + Z90 * Math.sqrt(waitVariance);
  const finalLegDistanceKm = legs.at(-1) || 0;
  energy -= finalLegDistanceKm * profile.consumptionPerKm;
  if (energy < destinationTargetEnergy - 1e-6) return null;
  const arrivalSoc = clamp(energy / profile.capacity * 100, 0, 100);
  const totalDistanceWithDetourKm = totalDistanceKm + totalDetourKm;
  return {
    stopCount: sequence.length,
    stops,
    legs: legs.map((distanceKm) => Number(distanceKm.toFixed(1))),
    totalDetourKm: Number(totalDetourKm.toFixed(1)),
    totalDistanceKm: Number(totalDistanceWithDetourKm.toFixed(1)),
    totalAmount: Number(totalAmount.toFixed(1)),
    unit: profile.unit,
    chargingMinutes,
    p50WaitMinutes: Math.round(p50Wait),
    p90WaitMinutes: Math.round(p90Wait),
    energyCost: Number(energyCost.toFixed(1)),
    totalMinutesP50: Math.round(baseDurationMinutes + chargingMinutes + p50Wait),
    totalMinutesP90: Math.round(baseDurationMinutes + chargingMinutes + p90Wait),
    arrivalSoc: Number(arrivalSoc.toFixed(1)),
    targetArrivalSoc: minArrivalSoc
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

function candidateScore(station) {
  return station._detourKm * 12 + Math.max(0, finite(station.p90, station.wait)) + Math.max(0, finite(station.p50, station.wait)) * 0.25;
}

function selectCoverageCandidates(sortedCandidates, totalDistanceKm, maxCandidates) {
  if (sortedCandidates.length <= maxCandidates) return sortedCandidates;
  const bucketCount = Math.max(1, Math.ceil(maxCandidates / 2));
  const buckets = Array.from({ length: bucketCount }, () => []);
  sortedCandidates.forEach((station) => {
    const ratio = totalDistanceKm > 0 ? station._progressKm / totalDistanceKm : 0;
    const index = clamp(Math.floor(ratio * bucketCount), 0, bucketCount - 1);
    buckets[index].push(station);
  });
  buckets.forEach((bucket) => bucket.sort((a, b) => candidateScore(a) - candidateScore(b) || a._progressKm - b._progressKm));

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
      .sort((a, b) => candidateScore(a) - candidateScore(b) || a._progressKm - b._progressKm)
      .slice(0, maxCandidates - selected.length)
      .forEach((candidate) => selected.push(candidate));
  }
  return selected.sort((a, b) => a._progressKm - b._progressKm || candidateScore(a) - candidateScore(b));
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
  const used = new Set();
  const result = {};
  ["fastest", "reliable", "cheapest"].forEach((objective) => {
    const sorted = feasible.slice().sort(objectiveComparators[objective]);
    const distinct = sorted.find((candidate) => !used.has(planSignature(candidate)));
    const selected = distinct || sorted[0] || null;
    if (!selected) return;
    result[objective] = Object.assign({}, selected, {
      objective,
      uniqueStopPlan: Boolean(distinct)
    });
    if (distinct) used.add(planSignature(selected));
  });
  return result;
}

export function buildLongTripPlans(input = {}) {
  const totalDistanceKm = Math.max(0, finite(input.distanceKm));
  const maxStops = clamp(Math.floor(finite(input.maxStops, MAX_STOPS)), 0, MAX_STOPS);
  const rankedCandidates = (Array.isArray(input.stations) ? input.stations : [])
    .map((station) => Object.assign({}, station, {
      _progressKm: stationProgress(station, totalDistanceKm),
      _detourKm: stationDetour(station)
    }))
    .filter((station) => Number.isFinite(station._progressKm) && station._progressKm > 1 && station._progressKm < totalDistanceKm - 1)
    .sort((a, b) => a._progressKm - b._progressKm || a._detourKm - b._detourKm || finite(a.p90) - finite(b.p90));
  const candidates = selectCoverageCandidates(rankedCandidates, totalDistanceKm, MAX_CANDIDATES);

  const evaluated = enumerateSequences(candidates, maxStops)
    .map((sequence) => evaluateSequence(sequence, input))
    .filter(Boolean);
  const feasible = uniquePlansByStops(evaluated);
  if (!feasible.length) {
    return { plans: [], candidatesConsidered: candidates.length, maxStops, reason: "NO_FEASIBLE_SEQUENCE" };
  }

  const plansByObjective = selectObjectivePlans(feasible);
  const selected = uniquePlansByStops(Object.values(plansByObjective));
  const overflow = selected.length < 3
    ? feasible.slice().sort(objectiveComparators.reliable)
    : [];
  selected.push(...overflow.filter((candidate) => !selected.some((plan) => planSignature(plan) === planSignature(candidate))).slice(0, 3 - selected.length));

  return {
    plans: selected.slice(0, 3),
    plansByObjective,
    candidatesConsidered: candidates.length,
    maxStops,
    reason: null
  };
}
