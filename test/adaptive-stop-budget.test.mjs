import test from "node:test";
import assert from "node:assert/strict";
import { buildLongTripPlans } from "../lib/longtrip.mjs";
import { buildLongTripApiInput } from "../server.mjs";

test("adaptive HTTP input does not reintroduce a legacy maxStops field", () => {
  const input = buildLongTripApiInput({
    distanceKm: 3000,
    durationMinutes: 1900,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    maxStops: 1,
    adaptiveMaxStops: true
  });

  assert.equal(input.adaptiveMaxStops, true);
  assert.equal(Object.hasOwn(input, "maxStops"), false);
});

test("adaptive planning is not constrained by the legacy six-stop budget", () => {
  const stations = Array.from({ length: 10 }, (_, index) => ({
    id: `adaptive-${index + 1}`,
    name: `自适应候选点 ${index + 1}`,
    progressKm: 130 + index * 320,
    detourKm: 0.5,
    p50: 4,
    p90: 8,
    price: 1.2
  }));

  const result = buildLongTripPlans({
    distanceKm: 3000,
    durationMinutes: 1900,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    // Deliberately keep the old value in the request. The adaptive flag must
    // take precedence so a browser/client cannot accidentally inherit it.
    maxStops: 6,
    adaptiveMaxStops: true,
    maxDetourKm: 8,
    stations
  });

  assert.equal(result.reason, null);
  assert.equal(result.adaptiveMaxStops, true);
  assert.equal(result.maxStops, result.candidatesConsidered);
  assert.ok(result.maxStops > 6);
  assert.ok(result.plans.some((plan) => plan.stopCount > 6));
  assert.ok(result.plans.every((plan) => plan.legs.length === plan.stopCount + 1));
});
