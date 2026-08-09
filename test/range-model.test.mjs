import test from "node:test";
import assert from "node:assert/strict";
import { ENERGY_PROFILES, VEHICLE_RANGE_GUIDANCE } from "../lib/energy.mjs";

test("vehicle range baselines stay aligned with the demo guidance", () => {
  const electricFull = ENERGY_PROFILES.electric.capacity / ENERGY_PROFILES.electric.consumptionPerKm;
  const fuelFull = ENERGY_PROFILES.fuel.capacity / ENERGY_PROFILES.fuel.consumptionPerKm;
  const hybridFull = ENERGY_PROFILES.hybridElectric.capacity / ENERGY_PROFILES.hybridElectric.consumptionPerKm
    + ENERGY_PROFILES.hybridFuel.capacity / ENERGY_PROFILES.hybridFuel.consumptionPerKm;

  assert.equal(Math.round(electricFull), VEHICLE_RANGE_GUIDANCE.electricFullRangeKm);
  assert.ok(fuelFull >= VEHICLE_RANGE_GUIDANCE.fuelFullRangeKm - 1);
  assert.ok(hybridFull >= VEHICLE_RANGE_GUIDANCE.hybridCombinedFullRangeKm - 15);
  assert.ok(hybridFull <= VEHICLE_RANGE_GUIDANCE.hybridCombinedFullRangeKm + 15);
});
