import test from "node:test";
import assert from "node:assert/strict";
import { buildAiHealthSummary, buildForecastApiScenario, buildLongTripApiInput, routeSourceLabel } from "../server.mjs";
import { forecastStations } from "../lib/forecast.mjs";
import { buildLongTripPlans } from "../lib/longtrip.mjs";

function stations() {
  return [
    {
      id: "stable",
      progressKm: 120,
      detourKm: 1,
      wait: 2,
      occupancy: 0.5,
      capacity: 1,
      arrivalRate: 8,
      serviceRate: 0.5,
      trend: 0,
      arrivalOffsetMinutes: 30,
      price: 1
    },
    {
      id: "quiet",
      progressKm: 121,
      detourKm: 1,
      wait: 5,
      occupancy: 0.2,
      capacity: 10,
      arrivalRate: 0.5,
      serviceRate: 5,
      trend: 0,
      arrivalOffsetMinutes: 30,
      price: 1
    }
  ];
}

function legacyRequest() {
  return {
    distanceKm: 300,
    durationMinutes: 210,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    maxStops: 1,
    maxDetourKm: 8,
    stations: stations()
  };
}

test("AI health summary exposes only configuration booleans", () => {
  const summary = buildAiHealthSummary({
    aiBaseUrl: "https://primary.example/v1",
    aiApiKey: "primary-secret",
    aiModel: "primary-model",
    aiBackupBaseUrl: "https://backup.example/v1",
    aiBackupApiKey: "backup-secret",
    aiBackupModel: "backup-model"
  });
  assert.deepEqual(summary, {
    configured: true,
    primaryConfigured: true,
    backupConfigured: true
  });
  assert.deepEqual(Object.keys(summary).sort(), ["backupConfigured", "configured", "primaryConfigured"]);
  assert.equal(JSON.stringify(summary).includes("primary.example"), false);
  assert.equal(JSON.stringify(summary).includes("primary-secret"), false);
  assert.equal(JSON.stringify(summary).includes("primary-model"), false);
});

test("route responses distinguish fresh AMap results from local cache hits", () => {
  assert.equal(routeSourceLabel("miss"), "高德 Web 服务路线规划 2.0");
  assert.equal(routeSourceLabel("hit"), "本地路线缓存 · 高德结果");
  assert.equal(routeSourceLabel("stale"), "本地路线缓存 · 高德结果（上游暂不可用）");
});

test("longtrip adapter whitelists and bounds forecast controls", () => {
  const input = buildLongTripApiInput({
    ...legacyRequest(),
    departureMinutes: "08:00",
    deadlineOffsetMinutes: "300",
    deadlineMinutes: 900,
    weatherFactor: 9,
    trafficFactor: -1,
    demandFactor: "2.5",
    horizonMinutes: 999,
    intervalMinutes: 0,
    useForecast: "false",
    unapproved: { nested: true }
  });

  assert.equal(input.departureMinutes, 480);
  assert.equal(input.deadlineOffsetMinutes, 300);
  assert.equal(input.deadlineMinutes, 900);
  assert.equal(input.weatherFactor, 1.5);
  assert.equal(input.trafficFactor, 0.7);
  assert.equal(input.demandFactor, 2);
  assert.equal(input.horizonMinutes, 240);
  assert.equal(input.intervalMinutes, 1);
  assert.equal(input.useForecast, undefined);
  assert.equal(Object.hasOwn(input, "unapproved"), false);
  assert.equal(Object.hasOwn(buildLongTripApiInput({ distanceKm: -1, stations: [] }), "distanceKm"), false);
});

test("forecast adapter preserves departure time and station arrival offsets", () => {
  const scenario = buildForecastApiScenario({
    departureMinutes: "08:00",
    arrivalOffsets: { stable: "30", quiet: 45, unapproved: { value: 60 } },
    demandFactor: 1.2
  });
  assert.equal(scenario.departureMinutes, 480);
  assert.deepEqual(scenario.arrivalOffsets, { stable: 30, quiet: 45 });

  const result = forecastStations([{ id: "stable", wait: 2 }], scenario);
  assert.equal(result.stations[0].arrivalOffsetMinutes, 30);
  assert.equal(result.stations[0].arrivalMinute, 510);
});

test("API-adapted forecast changes longtrip ranking while legacy input is unchanged", () => {
  const legacy = buildLongTripApiInput(legacyRequest());
  const legacyDirect = buildLongTripPlans({
    distanceKm: 300,
    durationMinutes: 210,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    maxStops: 1,
    maxDetourKm: 8,
    stations: stations()
  });
  const legacyPlans = buildLongTripPlans(legacy);

  assert.equal(legacy.departureMinutes, undefined);
  assert.deepEqual(legacyPlans, legacyDirect);
  assert.equal(legacyPlans.plansByObjective.fastest.stops[0].id, "stable");

  const forecastInput = buildLongTripApiInput({
    ...legacyRequest(),
    departureMinutes: 480,
    demandFactor: 2,
    horizonMinutes: 30,
    intervalMinutes: 5,
    useForecast: true
  });
  const forecastPlans = buildLongTripPlans(forecastInput);

  assert.equal(forecastPlans.plansByObjective.fastest.stops[0].id, "quiet");
  assert.equal(forecastPlans.plansByObjective.reliable.stops[0].id, "quiet");
  assert.equal(forecastPlans.plansByObjective.fastest.forecastSource, "simulation");
  assert.notDeepEqual(forecastPlans, legacyPlans);
});
