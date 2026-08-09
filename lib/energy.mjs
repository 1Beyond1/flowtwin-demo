/**
 * Deterministic energy feasibility helpers shared by the test suite and used
 * as the reference model for the browser planner.
 *
 * All distances are road distances in kilometres. `amount` is energy bought
 * at the station (kWh for EVs, litres for ICE vehicles), before transfer loss.
 */
export const ENERGY_PROFILES = Object.freeze({
  electric: Object.freeze({
    // Demo vehicle baseline: a full battery is calibrated to about 600 km
    // before the safety reserve is applied. This keeps route spacing from
    // underestimating a normal long-range EV while preserving explicit SOC
    // and safety-floor calculations.
    capacity: 108,
    consumptionPerKm: 0.18,
    transferEfficiency: 0.92,
    safetyReservePercent: 2,
    unit: "kWh",
    nominalFullRangeKm: 600
  }),
  fuel: Object.freeze({
    capacity: 55,
    consumptionPerKm: 0.075,
    transferEfficiency: 0.95,
    safetyReservePercent: 3,
    unit: "L",
    nominalFullRangeKm: 733
  }),
  // A plug-in hybrid plans on one energy path at a time, but its pack is about a
  // quarter of a BEV's and its engine runs in a more efficient regime. Planning
  // its electric branch with the BEV profile would overstate the safe first leg
  // roughly fourfold, which is exactly the kind of unreachable stop the planner
  // is supposed to reject.
  hybridElectric: Object.freeze({
    capacity: 20,
    consumptionPerKm: 0.165,
    transferEfficiency: 0.92,
    safetyReservePercent: 2,
    unit: "kWh",
    nominalFullRangeKm: 121
  }),
  hybridFuel: Object.freeze({
    // The hybrid display treats electric and fuel branches as one vehicle's
    // combined full-load reference. 60 L keeps the two independent branches
    // near a 1,200 km combined reference without pretending one branch can
    // spend the other's energy.
    capacity: 60,
    consumptionPerKm: 0.056,
    transferEfficiency: 0.95,
    safetyReservePercent: 3,
    unit: "L",
    nominalFullRangeKm: 1071
  })
});

export const VEHICLE_RANGE_GUIDANCE = Object.freeze({
  electricFullRangeKm: 600,
  fuelFullRangeKm: 733,
  hybridCombinedFullRangeKm: 1200
});

// `hybridFuel` and `hybridElectric` are the two branches of a hybrid vehicle;
// both still behave as a single-tank problem once a branch is chosen.
export function isFuelEnergyType(energyType) {
  return energyType === "fuel" || energyType === "hybridFuel";
}

export function getEnergyProfile(energyType = "electric") {
  return ENERGY_PROFILES[energyType] || ENERGY_PROFILES.electric;
}

function clampPercent(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, parsed));
}

function finiteDistance(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function baseState(input = {}) {
  const profile = getEnergyProfile(input.energyType);
  const soc = clampPercent(input.soc);
  const minArrivalSoc = clampPercent(input.minArrivalSoc);
  const currentEnergy = profile.capacity * soc / 100;
  const targetEnergy = profile.capacity * minArrivalSoc / 100;
  const safetyReserveEnergy = profile.capacity * profile.safetyReservePercent / 100;
  return { profile, soc, minArrivalSoc, currentEnergy, targetEnergy, safetyReserveEnergy };
}

export function evaluateDirectTrip(input = {}) {
  const state = baseState(input);
  const distanceKm = finiteDistance(input.distanceKm);
  const consumed = distanceKm * state.profile.consumptionPerKm;
  const remainingEnergy = state.currentEnergy - consumed;
  const arrivalSoc = Math.max(0, Math.min(100, remainingEnergy / state.profile.capacity * 100));
  return {
    ...state,
    distanceKm,
    consumed,
    remainingEnergy,
    arrivalSoc,
    canDirect: remainingEnergy >= state.targetEnergy,
    needsCharge: remainingEnergy < state.targetEnergy,
    maxTheoreticalRangeKm: state.currentEnergy / state.profile.consumptionPerKm,
    maxSafeFirstLegKm: Math.max(0, state.currentEnergy - state.safetyReserveEnergy) / state.profile.consumptionPerKm
  };
}

export function evaluateStationStop(input = {}) {
  const direct = evaluateDirectTrip(input);
  const firstLegKm = finiteDistance(input.firstLegKm);
  const totalDistanceKm = Math.max(firstLegKm, finiteDistance(input.totalDistanceKm ?? input.distanceKm));
  const firstLegConsumed = firstLegKm * direct.profile.consumptionPerKm;
  const totalConsumed = totalDistanceKm * direct.profile.consumptionPerKm;
  const energyAtStation = direct.currentEnergy - firstLegConsumed;
  const canReachStation = energyAtStation >= direct.safetyReserveEnergy;
  const requestedAmount = Math.max(0, (direct.targetEnergy + totalConsumed - direct.currentEnergy) / direct.profile.transferEfficiency);
  const stationFreeCapacity = Math.max(0, direct.profile.capacity - Math.max(0, energyAtStation));
  const maxPurchasableAmount = stationFreeCapacity / direct.profile.transferEfficiency;
  const amount = canReachStation ? Math.min(requestedAmount, maxPurchasableAmount) : 0;
  const remainingEnergy = energyAtStation + amount * direct.profile.transferEfficiency - (totalConsumed - firstLegConsumed);
  const arrivalSoc = Math.max(0, Math.min(100, remainingEnergy / direct.profile.capacity * 100));
  const detourKm = finiteDistance(input.detourKm);
  const maxDetourKm = Number.isFinite(Number(input.maxDetourKm)) ? Math.max(0, Number(input.maxDetourKm)) : Infinity;
  const detourWithinLimit = detourKm <= maxDetourKm + 1e-6;
  const targetMet = remainingEnergy >= direct.targetEnergy - 1e-6;
  return {
    ...direct,
    firstLegKm,
    totalDistanceKm,
    firstLegConsumed,
    totalConsumed,
    energyAtStation,
    arrivalAtStationSoc: Math.max(0, Math.min(100, energyAtStation / direct.profile.capacity * 100)),
    requestedAmount,
    maxPurchasableAmount,
    amount,
    remainingEnergy,
    arrivalSoc,
    canReachStation,
    detourKm,
    maxDetourKm,
    detourWithinLimit,
    targetMet,
    feasible: canReachStation && detourWithinLimit && targetMet
  };
}
