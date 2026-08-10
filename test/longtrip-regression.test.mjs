import test from "node:test";
import assert from "node:assert/strict";
import { buildLongTripPlans } from "../lib/longtrip.mjs";

test("1200 km EV trip at 22% SOC produces an energy-safe multi-stop sequence", () => {
  const capacityKwh = 108;
  const consumptionPerKm = 0.18;
  const safetyReservePercent = 2;
  const safetyKwh = capacityKwh * safetyReservePercent / 100;
  const result = buildLongTripPlans({
    distanceKm: 1200,
    durationMinutes: 743,
    energyType: "electric",
    soc: 22,
    minArrivalSoc: safetyReservePercent,
    maxStops: 6,
    maxDetourKm: 30,
    stations: [
      { id: "corridor-1", name: "沿线补能候选点 1", progressKm: 75, detourKm: 0.4, wait: 5, p50: 5, p90: 10, price: 1.5 },
      { id: "corridor-2", name: "沿线补能候选点 2", progressKm: 350, detourKm: 0.4, wait: 5, p50: 5, p90: 10, price: 1.5 },
      { id: "corridor-3", name: "沿线补能候选点 3", progressKm: 650, detourKm: 0.4, wait: 5, p50: 5, p90: 10, price: 1.5 },
      { id: "corridor-4", name: "沿线补能候选点 4", progressKm: 900, detourKm: 0.4, wait: 5, p50: 5, p90: 10, price: 1.5 }
    ]
  });

  assert.equal(result.reason, null);
  const plan = result.plans.find((candidate) => candidate.stopCount >= 2);
  assert.ok(plan, "the 1200 km corridor must not collapse to an unsafe backup");
  assert.ok(plan.stopCount <= 6);
  assert.equal(plan.legs.length, plan.stopCount + 1);
  assert.ok(plan.arrivalSoc >= safetyReservePercent);

  let energy = capacityKwh * 22 / 100;
  plan.stops.forEach((stop, index) => {
    energy -= plan.legs[index] * consumptionPerKm;
    // The public plan rounds each station amount to 0.1 units. Allow that
    // presentation rounding in this independent replay of the energy ledger;
    // the planner's internal, unrounded ledger still checks the exact floor.
    assert.ok(energy >= safetyKwh - 0.2, `leg ${index + 1} reaches a station below the safety reserve`);
    assert.ok(stop.amount > 0);
    energy += stop.amount * 0.92;
    assert.ok(energy <= capacityKwh + 1e-6, `leg ${index + 1} buys more than the battery can hold`);
  });
  energy -= plan.legs.at(-1) * consumptionPerKm;
  assert.ok(energy >= safetyKwh - 0.2, "the final leg must arrive above the safety reserve");
});

test("a 100% EV short trip remains direct and does not force a charging stop", () => {
  const result = buildLongTripPlans({
    distanceKm: 80,
    durationMinutes: 70,
    energyType: "electric",
    soc: 100,
    minArrivalSoc: 2,
    maxStops: 6,
    stations: [{ id: "nearby", progressKm: 35, detourKm: 0.4, wait: 6, p50: 5, p90: 10, price: 1.5 }]
  });

  assert.equal(result.reason, null);
  assert.ok(result.plans.some((plan) => plan.stopCount === 0));
  assert.ok(result.plans.every((plan) => plan.stopCount === 0));
});

test("duplicate station identities are removed before sequence enumeration", () => {
  const result = buildLongTripPlans({
    distanceKm: 900,
    durationMinutes: 620,
    energyType: "electric",
    soc: 35,
    minArrivalSoc: 2,
    maxStops: 6,
    maxDetourKm: 8,
    stations: [
      { id: "same-station", name: "重复候选", progressKm: 90, detourKm: 0.4, p50: 4, p90: 8, price: 1.2 },
      { id: "same-station", name: "重复候选的另一条记录", progressKm: 90, detourKm: 0.4, p50: 30, p90: 60, price: 5 },
      { id: "mid-station", name: "中途候选", progressKm: 360, detourKm: 0.4, p50: 4, p90: 8, price: 1.2 },
      { id: "late-station", name: "后段候选", progressKm: 650, detourKm: 0.4, p50: 4, p90: 8, price: 1.2 }
    ]
  });

  assert.equal(result.duplicatesRemoved, 1);
  for (const plan of result.plans) {
    const ids = plan.stops.map((stop) => stop.id);
    assert.equal(new Set(ids).size, ids.length);
  }
});
