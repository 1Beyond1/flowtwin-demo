import test from "node:test";
import assert from "node:assert/strict";
import { forecastStations, selectForecastPoint } from "../lib/forecast.mjs";
import { buildLongTripPlans } from "../lib/longtrip.mjs";
import { dominates, paretoFront } from "../lib/decision.mjs";

function forecastStation(overrides = {}) {
  return {
    id: "forecast-station",
    name: "预测站",
    occupancy: 0.78,
    wait: 24,
    capacity: 6,
    arrivalRate: 5,
    serviceRate: 1,
    trend: 0.002,
    ...overrides
  };
}

test("forecast uses departure clock and station ETA, with explicit simulation metadata", () => {
  const morning = forecastStations([forecastStation({ arrivalOffsetMinutes: 0 })], { departureMinutes: 360 });
  const evening = forecastStations([forecastStation({ arrivalOffsetMinutes: 0 })], { departureMinutes: 1080 });
  const atZero = morning.stations[0];
  const atTwenty = forecastStations([forecastStation({ arrivalOffsetMinutes: 20 })], { departureMinutes: 360 }).stations[0];

  assert.notEqual(morning.asOf, evening.asOf);
  assert.notDeepEqual(
    morning.stations[0].forecast.map((point) => point.wait),
    evening.stations[0].forecast.map((point) => point.wait)
  );
  assert.notEqual(atZero.wait, atTwenty.wait);
  assert.equal(atTwenty.prediction.requestedOffsetMinutes, 20);
  assert.equal(atTwenty.source, "simulation");
  assert.equal(atTwenty.simulation, true);
  assert.equal(atTwenty.confidence, "simulation-only");
  assert.equal(atTwenty.horizonMinutes, 30);
  assert.equal(atTwenty.method, "aggregate-flow-simulation");
  assert.equal(atTwenty.inputSnapshot, null);
  for (const point of atTwenty.forecast) {
    for (const key of ["wait", "p50", "p90", "asOf", "source", "confidence", "horizonMinutes"]) {
      assert.ok(point[key] !== undefined, `forecast point is missing ${key}`);
    }
  }
});

function portStation(overrides = {}) {
  return {
    id: "port-station",
    name: "端口预测站",
    capacity: 2,
    arrivalRate: 0,
    serviceRate: 1,
    totalPorts: 2,
    idlePorts: 0,
    chargingPorts: 2,
    faultPorts: 0,
    queueVehicles: 0,
    estimatedReleaseMinutes: [0, 30],
    averageSessionMinutes: 30,
    arrivalOffsetMinutes: 0,
    snapshotTime: "2026-08-09T12:00:00Z",
    dataSource: "test snapshot",
    freshnessSeconds: 60,
    ...overrides
  };
}

test("port discrete-event forecast changes when a charging port release changes", () => {
  const released = forecastStations([portStation({ estimatedReleaseMinutes: [0, 0] })]).stations[0];
  const delayed = forecastStations([portStation({ estimatedReleaseMinutes: [30, 30] })]).stations[0];
  assert.equal(released.method, "port-discrete-event");
  assert.ok(delayed.wait > released.wait);
  assert.equal(delayed.dataAsOf, "2026-08-09T12:00:00Z");
  assert.equal(delayed.freshnessSeconds, 60);
  assert.match(delayed.explanation, /simulation 仿真/);
});

test("port discrete-event forecast never lowers wait when the current queue grows", () => {
  const noQueue = forecastStations([portStation({ queueVehicles: 0 })]).stations[0];
  const queue = forecastStations([portStation({ queueVehicles: 3 })]).stations[0];
  assert.ok(queue.wait >= noQueue.wait);
  assert.ok(queue.p90 >= queue.p50 && queue.p50 >= 0);
});

test("port inputs are clipped to safe ranges and keep counts within total ports", () => {
  const result = forecastStations([portStation({
    totalPorts: 2,
    idlePorts: 99,
    chargingPorts: 99,
    faultPorts: 99,
    queueVehicles: -10,
    estimatedReleaseMinutes: Array.from({ length: 700 }, (_, index) => index - 20),
    averageSessionMinutes: 999,
    freshnessSeconds: 99999999
  })]).stations[0];
  const snapshot = result.inputSnapshot;
  assert.equal(snapshot.estimatedReleaseMinutes.length, 2);
  assert.ok(snapshot.estimatedReleaseMinutes.every((value) => value >= 0 && value <= 240));
  assert.ok(snapshot.idlePorts + snapshot.chargingPorts + snapshot.faultPorts <= snapshot.totalPorts);
  assert.equal(snapshot.queueVehicles, 0);
  assert.equal(snapshot.averageSessionMinutes, 240);
  assert.equal(snapshot.freshnessSeconds, 604800);
});

test("port forecast is deterministic and demand/weather factors are monotonic", () => {
  const first = forecastStations([portStation()], { demandFactor: 1.2, weatherFactor: 1.2 });
  const second = forecastStations([portStation()], { demandFactor: 1.2, weatherFactor: 1.2 });
  const calm = forecastStations([portStation()], { demandFactor: 1, weatherFactor: 1 }).stations[0];
  const stressed = first.stations[0];
  assert.deepEqual(first, second);
  assert.ok(stressed.forecast.at(-1).p90 >= calm.forecast.at(-1).p90);
});

test("forecast selection interpolates the queue wait at an ETA offset", () => {
  const points = [
    { minute: 0, wait: 4, p50: 3, p90: 8 },
    { minute: 10, wait: 14, p50: 11, p90: 25 }
  ];
  const selected = selectForecastPoint(points, 5);
  assert.equal(selected.wait, 9);
  assert.equal(selected.p50, 7);
  assert.equal(selected.p90, 16.5);
  assert.equal(selected.interpolated, true);
});

test("long-trip ETA and objective sorting use arrival-time forecast values", () => {
  const makeStation = (id, progressKm, wait, p50, p90) => ({
    id,
    progressKm,
    detourKm: 1,
    // These legacy fields deliberately disagree with the forecast.  The
    // planner must use the forecast at the supplied ETA instead.
    wait: 80,
    p50: 80,
    p90: 90,
    price: 1,
    arrivalOffsetMinutes: 60,
    forecast: [
      { minute: 0, wait: 80, p50: 80, p90: 90, source: "simulation", confidence: "simulation-only", horizonMinutes: 90 },
      { minute: 60, wait, p50, p90, source: "simulation", confidence: "simulation-only", horizonMinutes: 90 }
    ]
  });
  const result = buildLongTripPlans({
    distanceKm: 300,
    durationMinutes: 210,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    maxStops: 1,
    maxDetourKm: 8,
    stations: [
      makeStation("slow-at-eta", 120, 45, 45, 60),
      makeStation("fast-at-eta", 121, 2, 2, 4)
    ]
  });

  assert.equal(result.plansByObjective.fastest.stops[0].id, "fast-at-eta");
  assert.equal(result.plansByObjective.reliable.stops[0].id, "fast-at-eta");
  assert.equal(result.plansByObjective.fastest.stops[0].p50, 2);
  assert.equal(result.plansByObjective.fastest.stops[0].arrivalOffsetMinutes, 60);
  assert.equal(result.plansByObjective.fastest.forecastSource, "simulation");
});

test("Pareto front keeps only genuinely non-dominated plans", () => {
  const plans = [
    { id: "balanced", eta: 30, risk: 10, cost: 10 },
    { id: "fast", eta: 20, risk: 20, cost: 12 },
    { id: "safe", eta: 40, risk: 5, cost: 15 },
    { id: "dominated", eta: 35, risk: 15, cost: 20 }
  ];
  const objectives = ["eta", "risk", "cost"];
  assert.equal(dominates(plans[0], plans[3], objectives), true);
  assert.deepEqual(paretoFront(plans, objectives).map((plan) => plan.id), ["balanced", "fast", "safe"]);
});

test("an identical optimum may be reused and is labelled with all winning objectives", () => {
  const result = buildLongTripPlans({
    distanceKm: 300,
    durationMinutes: 210,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    maxStops: 1,
    maxDetourKm: 8,
    stations: [{ id: "only", progressKm: 120, detourKm: 1, p50: 4, p90: 8, price: 1.2 }]
  });
  const signatures = ["fastest", "reliable", "cheapest"].map((objective) => result.plansByObjective[objective].stops.map((stop) => stop.id).join("|"));
  assert.deepEqual(new Set(signatures).size, 1);
  assert.deepEqual(result.plansByObjective.fastest.objectives, ["fastest", "reliable", "cheapest"]);
  assert.deepEqual(result.plansByObjective.fastest.badges, ["fastest", "reliable", "cheapest"]);
  assert.equal(result.plans.length, 3);
});
