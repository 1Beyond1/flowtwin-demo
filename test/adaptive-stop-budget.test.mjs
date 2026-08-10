import test from "node:test";
import assert from "node:assert/strict";
import { buildLongTripPlans } from "../lib/longtrip.mjs";
import { buildLongTripApiInput } from "../server.mjs";

test("adaptive HTTP input keeps a bounded twelve-stop budget", () => {
  const input = buildLongTripApiInput({
    distanceKm: 3000,
    durationMinutes: 1900,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    maxStops: 99,
    adaptiveMaxStops: true
  });

  assert.equal(input.adaptiveMaxStops, true);
  assert.equal(input.maxStops, 12);
});

test("adaptive planning can exceed six stops but never exceeds twelve", () => {
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
    // Deliberately keep the old value in the request. The adaptive flag still
    // takes precedence, but now clamps the route to the explicit twelve-stop
    // quota budget rather than allowing an unbounded sequence.
    maxStops: 99,
    adaptiveMaxStops: true,
    maxDetourKm: 8,
    stations
  });

  assert.equal(result.reason, null);
  assert.equal(result.adaptiveMaxStops, true);
  assert.equal(result.maxStops, 12);
  assert.ok(result.maxStops > 6);
  assert.ok(result.plans.some((plan) => plan.stopCount > 6));
  assert.ok(result.plans.every((plan) => plan.stopCount <= 12));
  assert.ok(result.plans.every((plan) => plan.legs.length === plan.stopCount + 1));
});

test("adaptive search reports an incomplete search instead of claiming proof", () => {
  const stations = Array.from({ length: 36 }, (_, index) => ({
    id: `dense-${index}`,
    progressKm: 10 + index * 50,
    detourKm: 0.1,
    p50: 3,
    p90: 6,
    price: 1
  }));
  const result = buildLongTripPlans({
    distanceKm: 2000,
    durationMinutes: 1400,
    energyType: "electric",
    soc: 30,
    minArrivalSoc: 2,
    adaptiveMaxStops: true,
    maxStops: 12,
    maxDetourKm: 8,
    stations
  });
  assert.equal(result.reason, null);
  assert.equal(result.sequenceSearchComplete, false);
  assert.ok(result.sequenceEvaluations >= 12000);
  assert.ok(result.plans.length > 0);
});
