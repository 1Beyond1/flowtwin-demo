import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createAmapFileCache } from "../lib/amap-cache.mjs";
import { paretoFront } from "../lib/decision.mjs";
import { evaluateStationStop } from "../lib/energy.mjs";
import { enterprisePriorHealth } from "../lib/enterprise-prior.mjs";
import { clearFeishuCaches, feishuCacheStats, getFeishuSyncStatus, startFeishuSync } from "../lib/feishu-bitable.mjs";
import { clockLabel, forecastStations, MAX_FORECAST_POINTS, MAX_FORECAST_STATIONS, MAX_PORTS, MAX_QUEUE_VEHICLES } from "../lib/forecast.mjs";
import { buildLongTripPlans, estimateMinimumStopCount } from "../lib/longtrip.mjs";
import { parseOptionalNumber } from "../lib/number.mjs";
import { simulateOperator } from "../lib/operator.mjs";
import { formatPlanResponse, parseTripIntent } from "../lib/plan.mjs";
import { polishTranscriptText } from "../lib/stt.mjs";
import { validateStrategies } from "../lib/validate.mjs";

test("forecastStations handles worst-case port discrete-event payload within milliseconds and enforces caps", () => {
  const stations = Array.from({ length: 120 }, (_, index) => ({
    id: `dos-port-${index}`,
    name: `压测端口站 ${index}`,
    totalPorts: 500,
    idlePorts: 10,
    chargingPorts: 490,
    faultPorts: 0,
    queueVehicles: 5000,
    reservationQueueAhead: 5000,
    estimatedReleaseMinutes: Array.from({ length: 490 }, (_, p) => (p % 30) + 1),
    averageSessionMinutes: 15,
    arrivalRate: 100,
    serviceRate: 10,
    dataSource: "real-feed-stress-test"
  }));

  const started = performance.now();
  const result = forecastStations(stations, {
    departureMinutes: 480,
    horizonMinutes: 240,
    intervalMinutes: 1,
    demandFactor: 2,
    trafficFactor: 1.5,
    weatherFactor: 1.5
  });
  const elapsedMs = performance.now() - started;

  assert.equal(result.stations.length, MAX_FORECAST_STATIONS);
  assert.ok(result.stations[0].forecast.length <= MAX_FORECAST_POINTS);
  assert.equal(result.stations[0].totalPorts, MAX_PORTS);
  assert.equal(result.stations[0].queueVehicles, MAX_QUEUE_VEHICLES);
  // Every station in a large batch gets a fair per-station event budget and
  // never starves down to zero wait when later in the array.
  assert.ok(result.stations[0].wait > 0, "first congested station should have positive wait");
  assert.ok(result.stations.at(-1).wait > 0, "last congested station must not starve to zero wait");
  assert.ok(elapsedMs < 1500, `worst-case forecast took ${elapsedMs.toFixed(1)} ms`);
});

test("P2-3: 40 identical congested port stations share event budget fairly without starving tail stations", () => {
  const stations = Array.from({ length: 40 }, (_, index) => ({
    id: `fair-port-${index}`,
    name: `公平预算站 ${index}`,
    totalPorts: 10,
    idlePorts: 0,
    chargingPorts: 10,
    faultPorts: 0,
    queueVehicles: 40,
    reservationQueueAhead: 5,
    estimatedReleaseMinutes: [5, 8, 10, 12, 15, 18, 20, 22, 25, 28],
    averageSessionMinutes: 20,
    arrivalRate: 1.2,
    serviceRate: 0.5,
    dataSource: "real-feed-fair-test"
  }));
  const result = forecastStations(stations, { departureMinutes: 480, horizonMinutes: 60, intervalMinutes: 5 });
  assert.equal(result.stations.length, 40);
  assert.ok(result.stations[0].wait > 0);
  assert.ok(result.stations[39].wait > 0);
  assert.ok(Math.abs(result.stations[0].wait - result.stations[39].wait) <= 5);
});

test("clockLabel rounds without producing :60 or 24:00", () => {
  assert.equal(clockLabel(59.6), "01:00");
  assert.equal(clockLabel(1439.6), "00:00");
  assert.equal(clockLabel(-0.4), "00:00");
  assert.equal(clockLabel(480), "08:00");
});

test("non-adaptive longtrip 18-station payload and 5000-item paretoFront finish in milliseconds", () => {
  const stations = Array.from({ length: 18 }, (_, index) => ({
    id: `std-${index}`,
    name: `标准沿线站 ${index}`,
    progressKm: 40 + index * 55,
    detourKm: 0.5,
    p50: 4 + (index % 5),
    p90: 8 + (index % 7) * 2,
    price: 1.1 + (index % 4) * 0.2
  }));

  const ltStart = performance.now();
  const ltResult = buildLongTripPlans({
    distanceKm: 1100,
    durationMinutes: 700,
    energyType: "electric",
    soc: 25,
    minArrivalSoc: 10,
    maxStops: 6,
    maxDetourKm: 20,
    stations
  });
  const ltElapsed = performance.now() - ltStart;

  assert.equal(ltResult.reason, null);
  assert.ok(ltResult.plans.length > 0);
  assert.ok(ltResult.sequenceEvaluations <= 4001);
  assert.ok(ltElapsed < 1500, `18-station non-adaptive longtrip took ${ltElapsed.toFixed(1)} ms`);

  // 5000-item Pareto front benchmark + exactness
  const items = Array.from({ length: 5000 }, (_, i) => ({
    id: i,
    totalMinutesP50: 100 + (i % 97),
    totalMinutesP90: 120 + ((i * 7) % 101),
    energyCost: 50 + ((i * 13) % 89)
  }));
  const pfStart = performance.now();
  const front = paretoFront(items, [
    { key: "totalMinutesP50", direction: "min" },
    { key: "totalMinutesP90", direction: "min" },
    { key: "energyCost", direction: "min" }
  ]);
  const pfElapsed = performance.now() - pfStart;
  assert.ok(front.length > 0 && front.length < items.length);
  assert.ok(pfElapsed < 1000, `5000-item paretoFront took ${pfElapsed.toFixed(1)} ms`);

  // Verify input order stability on equal non-dominated points and reject array/object coercion
  const equalItems = [
    { id: "first", a: 10, b: 10, c: 10 },
    { id: "dominated", a: 12, b: 12, c: 12 },
    { id: "second", a: 10, b: 10, c: 10 },
    { id: "array-null", a: [], b: 1, c: 1 }
  ];
  assert.deepEqual(paretoFront(equalItems, ["a", "b", "c"]).map((item) => item.id), ["first", "second", "array-null"]);
});

test("P2-2: evaluateStationStop treats maxDetourKm: null as unconstrained Infinity rather than 0", () => {
  const stop = evaluateStationStop({
    energyType: "electric",
    soc: 50,
    minArrivalSoc: 20,
    firstLegKm: 80,
    totalDistanceKm: 200,
    detourKm: 4.5,
    maxDetourKm: null
  });
  assert.equal(stop.maxDetourKm, Infinity);
  assert.equal(stop.detourWithinLimit, true);
  assert.equal(stop.feasible, true);
});

test("P1-6: estimateMinimumStopCount respects minArrivalSoc for direct trip feasibility", () => {
  // 50% SOC electric (54 kWh), 100 km consumes 18 kWh -> 33.3% arrival SOC,
  // which is above safety reserve (2%) but BELOW requested minArrivalSoc (40%).
  const minStops = estimateMinimumStopCount({
    distanceKm: 100,
    energyType: "electric",
    soc: 50,
    minArrivalSoc: 40
  });
  assert.equal(minStops, 1);

  const plans = buildLongTripPlans({
    distanceKm: 100,
    durationMinutes: 80,
    energyType: "electric",
    soc: 50,
    minArrivalSoc: 40,
    maxStops: 3,
    maxDetourKm: 10,
    stations: [{ id: "mid", name: "中途站", progressKm: 50, detourKm: 0.5, p50: 4, p90: 8, price: 1.3 }]
  });
  assert.equal(plans.reason, null);
  assert.equal(plans.plansByObjective.fastest.stopCount, 1);
  assert.ok(plans.plansByObjective.fastest.arrivalSoc >= 40);
});

test("P1-7: parseTripIntent preserves multi-turn context.origin unless explicitly overridden", async () => {
  const localSupplement = await parseTripIntent({
    message: "中途想去吃麦当劳",
    context: {
      hasPlannedRoute: true,
      origin: "上海虹桥站",
      currentDestination: "杭州西湖风景名胜区"
    },
    config: {},
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(localSupplement.origin, "上海虹桥站");

  const aiSupplement = await parseTripIntent({
    message: "中途想去吃麦当劳，然后再喝咖啡",
    context: {
      hasPlannedRoute: true,
      origin: "上海虹桥站",
      currentDestination: "杭州西湖风景名胜区"
    },
    config: { aiBaseUrl: "https://ai.example/v1", aiApiKey: "k", aiModel: "m" },
    fetchImpl: async (url) => {
      if (String(url).includes("chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          origin: null,
          destination: "杭州西湖风景名胜区",
          services: ["餐饮"],
          requestMode: "supplement",
          actions: [{ type: "ADD_SERVICE", service: "餐饮", name: "麦当劳" }],
          clarificationNeeded: false,
          assistantReply: "已补充"
        }) } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "0", geocodes: [], pois: [] }), { status: 200 });
    }
  });
  assert.equal(aiSupplement.origin, "上海虹桥站");

  const explicitNewOrigin = await parseTripIntent({
    message: "从南京南站出发去上海",
    context: { origin: "上海虹桥站", hasPlannedRoute: true, currentDestination: "杭州" },
    config: {},
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(explicitNewOrigin.origin, "南京南站");
});

test("P1-8: parseOptionalNumber prevents null/empty/boolean coercion to 0 across modules", async () => {
  assert.equal(parseOptionalNumber(null), null);
  assert.equal(parseOptionalNumber(undefined), null);
  assert.equal(parseOptionalNumber(""), null);
  assert.equal(parseOptionalNumber("   "), null);
  assert.equal(parseOptionalNumber(false), null);
  assert.equal(parseOptionalNumber([]), null);
  assert.equal(parseOptionalNumber(0), 0);
  assert.equal(parseOptionalNumber("0"), 0);

  // operator.mjs: campaignBudget: null must NOT become 0 and zero out simulation
  const op = simulateOperator({
    campaignBudget: null,
    platformCoupon: 6,
    stations: [
      { id: "src", partner: true, controllable: true, couponEligible: true, merchantAccepted: true, occupancy: 0.9, wait: 22, capacity: 20, windowCapacity: 18, demand: 14, price: 1.8 },
      { id: "dst", partner: true, controllable: true, couponEligible: true, merchantAccepted: true, occupancy: 0.3, wait: 4, capacity: 30, windowCapacity: 24, demand: 5, price: 1.1 }
    ]
  });
  assert.equal(op.campaignBudget, null);
  assert.ok(op.impact.acceptedOrders > 0);

  // plan.mjs: agreement.score: null must remain null in formatPlanResponse
  const localPlan = await parseTripIntent({
    message: "去南京",
    config: {},
    fetchImpl: async () => { throw new Error("offline"); }
  });
  const formatted = formatPlanResponse(localPlan);
  assert.equal(formatted.analysis.comparison.agreement.score, null);

  // longtrip.mjs: deadlineOffsetMinutes: null and maxDetourKm: null must not become 0
  const lt = buildLongTripPlans({
    distanceKm: 300,
    durationMinutes: 210,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    deadlineOffsetMinutes: null,
    maxDetourKm: null,
    stations: [{ id: "s1", progressKm: 150, detourKm: 2, p50: 5, p90: 10, price: 1.4 }]
  });
  assert.equal(lt.reason, null);
  assert.equal(lt.plansByObjective.fastest.deadlineOffsetMinutes, null);

  // forecast.mjs: freshnessSeconds: null must not get the <= 15m freshness bonus
  const fcNull = forecastStations([{
    id: "p1", totalPorts: 4, idlePorts: 1, chargingPorts: 3, faultPorts: 0,
    queueVehicles: 1, reservationQueueAhead: 0, averageSessionMinutes: 30,
    freshnessSeconds: null
  }]).stations[0];
  const fcFresh = forecastStations([{
    id: "p1", totalPorts: 4, idlePorts: 1, chargingPorts: 3, faultPorts: 0,
    queueVehicles: 1, reservationQueueAhead: 0, averageSessionMinutes: 30,
    freshnessSeconds: 0
  }]).stations[0];
  assert.ok(fcFresh.confidenceScore > fcNull.confidenceScore);

  // enterprise-prior.mjs: holdoutWape: null stays null
  const health = enterprisePriorHealth({ available: true, holdoutWape: null, rollingValidationMeanWape: null });
  assert.equal(health.holdoutWape, null);
  assert.equal(health.rollingValidationMeanWape, null);

  // validate.mjs: serviceMinutes: null falls back to default (35), not 1
  const validated = validateStrategies({
    seed: 1,
    trips: 1000,
    stations: [{ id: "v1", type: "充电站", serviceMinutes: null, paymentExitMinutes: null }]
  });
  assert.equal(validated.stationTemplates[0].serviceMinutes, 35);
  assert.equal(validated.stationTemplates[0].paymentExitMinutes, 5);
});

test("P1-5: AMap disk cache evicts oldest and expired entries within file/byte caps", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowtwin-amap-evict-"));
  try {
    let clock = 1_700_000_000_000;
    const cache = createAmapFileCache({
      root,
      now: () => clock,
      staleIfErrorMs: 1_000,
      maxFiles: 2,
      maxBytes: 100_000
    });
    for (let i = 0; i < 4; i += 1) {
      clock += 100;
      await cache.getOrLoad("route", `k-${i}`, async () => ({ index: i }), { ttlMs: 10_000 });
    }
    const files = (await readdir(cache.directory)).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 2);
    assert.ok(cache.getStats().evicted >= 2);
    assert.equal(await cache.read("route", "k-0"), null);
    assert.notEqual(await cache.read("route", "k-3"), null);

    // Advance past ttl + stale window and prune
    clock += 20_000;
    const pruned = await cache.prune();
    assert.equal(pruned, 2);

    // Byte cap triggers eviction even when file count is below maxFiles, and ttlMs: null falls back to default TTL
    const byteCache = createAmapFileCache({
      root,
      now: () => clock,
      maxFiles: 20,
      maxBytes: 1200
    });
    for (let i = 0; i < 4; i += 1) {
      clock += 100;
      await byteCache.getOrLoad("route", `big-${i}`, async () => ({ payload: "x".repeat(450) }), { ttlMs: null });
    }
    const remainingFiles = (await readdir(byteCache.directory)).filter((name) => name.endsWith(".json"));
    assert.ok(remainingFiles.length <= 2, `expected <= 2 files under maxBytes=1200, got ${remainingFiles.length}`);
    assert.notEqual(await byteCache.read("route", "big-3"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P1-5 & P2: Feishu job table enforces maxJobs/TTL bounds and aligns metrics.queueVehicles", async () => {
  clearFeishuCaches();
  const config = {
    feishuBaseUrl: "https://open.feishu.cn",
    feishuAppId: "app-evict",
    feishuAppSecret: "secret-evict",
    feishuAppToken: "token-evict",
    feishuSnapshotTableId: "tbl-snap",
    feishuStrategyTableId: "tbl-strat"
  };
  let lastStrategyFields = null;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("tenant_access_token")) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "tok", expire: 7200 }), { status: 200 });
    }
    if (String(url).includes("batch_create")) {
      return new Response(JSON.stringify({ code: 0, data: { records: [{ record_id: "snap-1" }] } }), { status: 200 });
    }
    if (options.method === "POST") {
      lastStrategyFields = JSON.parse(options.body).fields;
      return new Response(JSON.stringify({ code: 0, data: { record: { record_id: "rec-1" } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, data: { record: { fields: { AI策略: "done" } } } }), { status: 200 });
  };

  let clock = 1_700_000_000_000;
  const syncIds = [];
  for (let i = 0; i < 4; i += 1) {
    clock += 100;
    const res = await startFeishuSync({
      config,
      fetchImpl,
      now: () => clock,
      maxJobs: 2,
      jobTtlMs: 5_000,
      payload: {
        runId: `run-${i}`,
        stations: [{
          id: "st-1",
          name: "测试端口站",
          forecastMethod: "port-discrete-event",
          forecastInputSnapshot: { totalPorts: 10, idlePorts: 1, chargingPorts: 9, faultPorts: 0, waitingVehicles: 7, queueVehicles: 7, reservationQueueAhead: 2 }
        }]
      }
    });
    syncIds.push(res.syncId);
  }
  assert.equal(feishuCacheStats().jobs, 2);
  assert.equal(feishuCacheStats().runIndex, 2);
  const evidence = JSON.parse(lastStrategyFields["策略输入"]);
  assert.equal(evidence.metrics.queueVehicles, 7);

  // Oldest job evicted by capacity
  const evicted = await getFeishuSyncStatus({ syncId: syncIds[0], config, fetchImpl, now: () => clock, maxJobs: 2, jobTtlMs: 5_000 });
  assert.equal(evicted.code, "FEISHU_SYNC_NOT_FOUND");

  // Advance clock beyond TTL -> remaining jobs expire
  clock += 10_000;
  const expired = await getFeishuSyncStatus({ syncId: syncIds[3], config, fetchImpl, now: () => clock, maxJobs: 2, jobTtlMs: 5_000 });
  assert.equal(expired.code, "FEISHU_SYNC_NOT_FOUND");
  assert.equal(feishuCacheStats().jobs, 0);
});

test("P2: longtrip passes confidenceScore onto stops and computes plan.confidenceScore, and STT detects tags across repeated calls", async () => {
  const lt = buildLongTripPlans({
    distanceKm: 300,
    durationMinutes: 210,
    departureMinutes: 480,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    maxStops: 1,
    maxDetourKm: 8,
    stations: [{ id: "fc-stop", name: "预测站", progressKm: 150, detourKm: 1, capacity: 12, arrivalRate: 2, serviceRate: 3, price: 1.4 }]
  });
  const plan = lt.plansByObjective.fastest;
  assert.equal(typeof plan.stops[0].confidenceScore, "number");
  assert.equal(typeof plan.confidenceScore, "number");
  assert.ok(["low", "medium", "high"].includes(plan.confidenceLevel));

  // Consecutive STT tag detection must not fail due to stateful /g regex lastIndex
  let calls = 0;
  const aiConfig = { aiBaseUrl: "https://ai.example/v1", aiApiKey: "k", aiModel: "m" };
  const fakeFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: "去北京南站" } }] }), { status: 200 });
  };
  await polishTranscriptText("<|zh|><|NEUTRAL|>去北京南站", aiConfig, fakeFetch);
  await polishTranscriptText("<|zh|><|NEUTRAL|>去北京南站", aiConfig, fakeFetch);
  assert.equal(calls, 2);
});
