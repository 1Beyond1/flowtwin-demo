import test from "node:test";
import assert from "node:assert/strict";
import { createLongTripPlanCache } from "../lib/longtrip-cache.mjs";

test("long-trip plan cache reuses an unchanged normalized planning input", async () => {
  let now = 10_000;
  let loads = 0;
  const cache = createLongTripPlanCache({ now: () => now, ttlMs: 1_000 });
  const input = {
    distanceKm: 1200,
    soc: 22,
    stations: [{ id: "a", p90: 18, occupancy: 0.6, price: 1.4 }]
  };
  const first = await cache.getOrLoad(input, () => ({ run: ++loads }));
  const second = await cache.getOrLoad({ ...input, stations: [{ price: 1.4, occupancy: 0.6, p90: 18, id: "a" }] }, () => ({ run: ++loads }));
  assert.equal(first.cache.state, "miss");
  assert.equal(second.cache.state, "hit");
  assert.equal(second.value.run, 1);
  assert.equal(loads, 1);
  assert.equal(cache.getStats().hit, 1);
  now += 1_001;
  const expired = await cache.getOrLoad(input, () => ({ run: ++loads }));
  assert.equal(expired.cache.state, "miss");
  assert.equal(loads, 2);
});

test("long-trip plan cache misses when station pressure changes", async () => {
  let loads = 0;
  const cache = createLongTripPlanCache();
  const base = { distanceKm: 1200, soc: 22, stations: [{ id: "a", p50: 9, p90: 18, price: 1.4 }] };
  await cache.getOrLoad(base, () => ({ run: ++loads }));
  const changed = await cache.getOrLoad({ ...base, stations: [{ id: "a", p50: 16, p90: 34, price: 1.4 }] }, () => ({ run: ++loads }));
  assert.equal(changed.cache.state, "miss");
  assert.equal(changed.value.run, 2);
  assert.equal(loads, 2);
});

test("long-trip plan cache ignores display timestamps but retains five-minute pressure snapshots", async () => {
  let loads = 0;
  const cache = createLongTripPlanCache();
  const base = {
    distanceKm: 1200,
    departureMinutes: 961,
    stations: [{
      id: "a",
      p50: 9,
      p90: 18,
      availablePorts: 3,
      snapshotTime: "simulation@16:01",
      freshnessSeconds: 1,
      enterprisePrior: { demandFactor: 1.1, meanServiceMinutes: 35, arrivalMinute: 1024 }
    }]
  };
  await cache.getOrLoad(base, () => ({ run: ++loads }));
  const repeated = await cache.getOrLoad({
    ...base,
    departureMinutes: 964,
    stations: [{
      ...base.stations[0],
      snapshotTime: "simulation@16:04",
      freshnessSeconds: 4,
      enterprisePrior: { ...base.stations[0].enterprisePrior, arrivalMinute: 1027 }
    }]
  }, () => ({ run: ++loads }));
  assert.equal(repeated.cache.state, "hit");

  const changedPorts = await cache.getOrLoad({
    ...base,
    departureMinutes: 964,
    stations: [{ ...base.stations[0], availablePorts: 2 }]
  }, () => ({ run: ++loads }));
  assert.equal(changedPorts.cache.state, "miss");
  assert.equal(loads, 2);
});
