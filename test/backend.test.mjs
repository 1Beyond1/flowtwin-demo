import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAiBaseUrl } from "../lib/config.mjs";
import { formatPlanResponse, parseTripIntent } from "../lib/plan.mjs";
import { forecastStations } from "../lib/forecast.mjs";
import { simulateOperator } from "../lib/operator.mjs";
import { validateStrategies } from "../lib/validate.mjs";
import { executeFeishu } from "../lib/feishu.mjs";
import { evaluateDirectTrip, evaluateStationStop } from "../lib/energy.mjs";
import { buildLongTripPlans } from "../lib/longtrip.mjs";

const stations = [
  { id: "a", name: "A站", type: "充电站", occupancy: 0.78, wait: 16, capacity: 20, demand: 14, serviceRate: 4, price: 1.55 },
  { id: "b", name: "B站", type: "充电站", occupancy: 0.42, wait: 6, capacity: 24, demand: 8, serviceRate: 5, price: 1.22 },
  { id: "c", name: "C站", type: "充电站", occupancy: 0.56, wait: 9, capacity: 18, demand: 10, serviceRate: 4, price: 1.35 }
];

test("AI base URL rejects unsafe protocols and credentials", () => {
  assert.equal(normalizeAiBaseUrl("file:///tmp/key"), "");
  assert.equal(normalizeAiBaseUrl("https://user:pass@example.com/v1"), "");
  assert.equal(normalizeAiBaseUrl("https://ark.cn-beijing.volces.com/api/coding/v3"), "https://ark.cn-beijing.volces.com/api/coding/v3");
});

test("plan parser uses strict AI JSON and returns locations without exposing secrets", async () => {
  const calls = [];
  const result = await parseTripIntent({
    message: "从公司去大兴机场，最晚19:30前到，到达至少保留60%，最多绕行5公里，最好附近能吃饭",
    config: { aiBaseUrl: "https://example.com/v1", aiApiKey: "test-secret", aiModel: "test-model", webServiceKey: "geo-secret" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          origin: "能链北京总部", destination: "大兴机场", arrivalDeadline: null,
          minArrivalSoc: 60, energyType: "electric", priority: "on_time", maxDetourKm: 5, services: ["餐饮"],
          clarificationNeeded: false, assistantReply: "已识别"
        }) } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "1", geocodes: [{ location: "116.410000,39.509000" }] }), { status: 200 });
    }
  });
  assert.equal(result.aiUsed, true);
  assert.equal(result.destination, "大兴机场");
  assert.equal(result.minArrivalSoc, 60);
  assert.deepEqual(result.locations.origin.coordinate, [116.491, 39.951]);
  assert.deepEqual(result.locations.destination.coordinate, [116.41, 39.509]);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-secret");
  assert.equal(calls[0].options.body.includes("departureTime"), false);
  assert.equal(calls[0].options.body.includes('"soc"'), false);
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
});

test("plan parser leaves current time and energy to the client controls", async () => {
  const result = await parseTripIntent({
    message: "18:30去大兴机场，电量22%，不能迟到",
    config: { aiBaseUrl: "https://example.com/v1", aiApiKey: "test-secret", aiModel: "test-model" },
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(result.aiUsed, false);
  assert.equal(result.destination, "大兴机场");
  assert.equal(Object.hasOwn(result, "departureTime"), false);
  assert.equal(Object.hasOwn(result, "soc"), false);
});

test("plan parser keeps parsing the destination arrival reserve", async () => {
  const result = await parseTripIntent({
    message: "现在电量22%，去北京南站，到达目的地时电量要有80%以上",
    context: { destination: "北京南站", minArrivalSoc: 20 },
    config: {},
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(result.minArrivalSoc, 80);
});

test("plan parser leaves deadline and arrival reserve unset when the user did not request them", async () => {
  const result = await parseTripIntent({
    message: "从能链北京总部去北京南站，尽量省钱",
    context: { arrivalDeadline: "19:30", minArrivalSoc: 40 },
    config: {},
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(result.arrivalDeadline, null);
  assert.equal(result.minArrivalSoc, null);
});

test("an explicit new destination wins over a stale airport completion", async () => {
  const result = await parseTripIntent({
    message: "从能链北京总部前往燕郊站，到达至少保留30%",
    context: { destination: "北京大兴国际机场" },
    config: { aiBaseUrl: "https://example.com/v1", aiApiKey: "test-secret", aiModel: "test-model" },
    fetchImpl: async (url) => {
      if (url.includes("chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          origin: "能链北京总部", destination: "北京大兴国际机场", arrivalDeadline: null,
          minArrivalSoc: 20, energyType: "electric", priority: "on_time", maxDetourKm: null, services: [], clarificationNeeded: false
        }) } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "0", geocodes: [] }), { status: 200 });
    }
  });
  assert.equal(result.destination, "燕郊站");
  assert.equal(result.clarificationNeeded, false);
  assert.equal(result.locations.destination, null);
});

test("national geocoding accepts a destination outside Beijing", async () => {
  const result = await parseTripIntent({
    message: "从能链北京总部前往燕郊站",
    config: { webServiceKey: "geo-key" },
    fetchImpl: async () => new Response(JSON.stringify({
      status: "1",
      geocodes: [{ province: "河北省", city: "廊坊市", district: "三河市", location: "116.814,39.999" }]
    }), { status: 200 })
  });
  assert.equal(result.destination, "燕郊站");
  assert.deepEqual(result.locations.destination.coordinate, [116.814, 39.999]);
});

test("ambiguous 东方明珠 is canonicalized to the Shanghai landmark before geocoding", async () => {
  const requestedUrls = [];
  const result = await parseTripIntent({
    message: "从能链北京总部前往东方明珠，最晚23:00前到",
    config: { webServiceKey: "geo-key" },
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      return new Response(JSON.stringify({
        status: "1",
        geocodes: [{ province: "上海市", city: "上海市", district: "浦东新区", location: "121.4997,31.2397" }]
      }), { status: 200 });
    }
  });
  assert.equal(result.destination, "上海东方明珠广播电视塔");
  assert.match(requestedUrls[0], /%E4%B8%8A%E6%B5%B7%E4%B8%9C%E6%96%B9%E6%98%8E%E7%8F%A0%E5%B9%BF%E6%92%AD%E7%94%B5%E8%A7%86%E5%A1%94/);
  assert.deepEqual(result.locations.destination.coordinate, [121.4997, 31.2397]);
});

test("plan response exposes parsed and destinationLocation contract", () => {
  const response = formatPlanResponse({
    origin: "能链北京总部",
    destination: "大兴机场",
    aiUsed: false,
    locations: { origin: { coordinate: [116.491, 39.951], source: "默认" }, destination: { coordinate: [116.41, 39.509], source: "高德" } }
  });
  assert.equal(response.parsed.destination, "大兴机场");
  assert.deepEqual(response.destinationLocation, [116.41, 39.509]);
  assert.equal(response.locationSources.destination, "高德");
});

test("forecast is deterministic and produces 0..30 minute points", () => {
  const first = forecastStations(stations, { demandFactor: 1.1 });
  const second = forecastStations(stations, { demandFactor: 1.1 });
  assert.deepEqual(first, second);
  assert.deepEqual(first.stations[0].forecast.map((point) => point.minute), [0, 5, 10, 15, 20, 25, 30]);
  assert.ok(first.stations[0].forecast.every((point) => point.occupancy >= 0.05 && point.occupancy <= 0.99));
});

test("operator simulation changes with discount and calculates impact", () => {
  const low = simulateOperator({ stations, discountAmount: 0, targetStationId: "b", targetUser: "价格敏感用户" });
  const high = simulateOperator({ stations, discountAmount: 10, targetStationId: "b", targetUser: "价格敏感用户" });
  assert.ok(high.impact.divertedVehicles > low.impact.divertedVehicles);
  assert.ok(high.impact.discountCost > 0);
  assert.notEqual(high.after.averageWait, high.before.averageWait);
  assert.equal(high.stations.length, 3);
});

test("operator simulation defaults to the lowest-load receiving station", () => {
  const result = simulateOperator({ stations, discountAmount: 6 });
  assert.equal(result.targetStation.id, "b");
});

test("validation runs at least 1000 seeded trips for all strategies", () => {
  const result = validateStrategies({ seed: 42, trips: 1000, stations });
  assert.equal(result.trips, 1000);
  assert.equal(result.inputMode, "current-stations");
  assert.equal(result.stationCount, 3);
  assert.equal(result.stationTemplates.length, 3);
  assert.ok(result.methodology.formulas.queue.includes("基础等待"));
  assert.deepEqual(Object.keys(result.strategies), ["nearest", "cheapest", "realtime", "flowtwin"]);
  for (const summary of Object.values(result.strategies)) {
    assert.equal(summary.trips, 1000);
    assert.ok(Number.isFinite(summary.averageWait));
    assert.ok(Number.isFinite(summary.p90Wait));
    assert.ok(summary.onTimeRate >= 0 && summary.onTimeRate <= 100);
  }
  assert.ok(result.strategies.flowtwin.averageWait <= result.strategies.realtime.averageWait);
  assert.ok(result.strategies.flowtwin.p90Wait <= result.strategies.realtime.p90Wait);
  assert.ok(result.strategies.flowtwin.loadDispersion <= result.strategies.realtime.loadDispersion);
});

test("Feishu execution stays local without a webhook", async () => {
  const result = await executeFeishu({ payload: { targetStation: "B站" }, config: {} });
  assert.equal(result.used, false);
  assert.equal(result.mode, "local-demo");
});

test("energy model skips charging when a full EV can meet the destination reserve directly", () => {
  const result = evaluateDirectTrip({ energyType: "electric", soc: 100, minArrivalSoc: 20, distanceKm: 55 });
  assert.equal(result.canDirect, true);
  assert.equal(result.needsCharge, false);
  assert.ok(result.arrivalSoc > 80);
});

test("energy model rejects a low-SOC EV station that cannot be reached with the safety reserve", () => {
  const result = evaluateStationStop({
    energyType: "electric", soc: 5, minArrivalSoc: 20,
    firstLegKm: 18, totalDistanceKm: 60, detourKm: 3, maxDetourKm: 8
  });
  assert.equal(result.canReachStation, false);
  assert.equal(result.feasible, false);
  assert.equal(result.amount, 0);
});

test("energy model charges at a reachable station and honours the requested arrival reserve", () => {
  const result = evaluateStationStop({
    energyType: "electric", soc: 5, minArrivalSoc: 80,
    firstLegKm: 8, totalDistanceKm: 55, detourKm: 2, maxDetourKm: 8
  });
  assert.equal(result.canReachStation, true);
  assert.equal(result.targetMet, true);
  assert.equal(result.feasible, true);
  assert.ok(result.amount > 70);
  assert.ok(result.arrivalSoc >= 80);
});

test("energy model rejects otherwise reachable stations that violate the detour cap", () => {
  const result = evaluateStationStop({
    energyType: "fuel", soc: 15, minArrivalSoc: 20,
    firstLegKm: 10, totalDistanceKm: 100, detourKm: 9, maxDetourKm: 5
  });
  assert.equal(result.canReachStation, true);
  assert.equal(result.detourWithinLimit, false);
  assert.equal(result.feasible, false);
});

test("long-trip planner generates a safe multi-stop EV sequence", () => {
  const result = buildLongTripPlans({
    distanceKm: 900,
    durationMinutes: 600,
    energyType: "electric",
    soc: 65,
    minArrivalSoc: 20,
    maxStops: 3,
    maxDetourKm: 8,
    stations: [
      { id: "s1", name: "第一补能站", progressKm: 230, detourKm: 1.4, p50: 5, p90: 12, price: 1.32 },
      { id: "s2", name: "第二补能站", progressKm: 470, detourKm: 1.8, p50: 7, p90: 14, price: 1.18 },
      { id: "s3", name: "第三补能站", progressKm: 710, detourKm: 1.6, p50: 4, p90: 10, price: 1.26 }
    ]
  });
  assert.ok(result.plans.length >= 1);
  assert.ok(result.plans.every((plan) => plan.arrivalSoc >= 20));
  assert.ok(result.plans.some((plan) => plan.stopCount >= 3));
  const longPlan = result.plans.find((plan) => plan.stopCount >= 3);
  assert.ok(longPlan.stops.every((stop) => stop.amount > 0 && stop.arrivalSoc >= 2));
});

test("long-trip planner exposes distinct fastest, reliable and cheapest objectives", () => {
  const result = buildLongTripPlans({
    distanceKm: 620,
    durationMinutes: 440,
    energyType: "electric",
    soc: 60,
    minArrivalSoc: 20,
    maxStops: 3,
    maxDetourKm: 8,
    stations: [
      { id: "fast-a", progressKm: 200, detourKm: 1, p50: 2, p90: 28, price: 1.9, estimatedChargePowerKw: 250 },
      { id: "safe-a", progressKm: 205, detourKm: 1, p50: 7, p90: 8, price: 1.6, estimatedChargePowerKw: 100 },
      { id: "cheap-a", progressKm: 210, detourKm: 1, p50: 10, p90: 12, price: 0.65, estimatedChargePowerKw: 75 },
      { id: "fast-b", progressKm: 420, detourKm: 1, p50: 2, p90: 28, price: 1.9, estimatedChargePowerKw: 250 },
      { id: "safe-b", progressKm: 425, detourKm: 1, p50: 7, p90: 8, price: 1.6, estimatedChargePowerKw: 100 },
      { id: "cheap-b", progressKm: 430, detourKm: 1, p50: 10, p90: 12, price: 0.65, estimatedChargePowerKw: 75 }
    ]
  });
  const { fastest, reliable, cheapest } = result.plansByObjective;
  assert.deepEqual(fastest.stops.map((stop) => stop.id), ["fast-a", "fast-b"]);
  assert.deepEqual(reliable.stops.map((stop) => stop.id), ["safe-a", "safe-b"]);
  assert.deepEqual(cheapest.stops.map((stop) => stop.id), ["cheap-a", "cheap-b"]);
  assert.ok(fastest.totalMinutesP50 < reliable.totalMinutesP50);
  assert.ok(reliable.totalMinutesP90 < fastest.totalMinutesP90);
  assert.ok(cheapest.energyCost < reliable.energyCost);
});

test("long-trip planner keeps a short trip as a direct route", () => {
  const result = buildLongTripPlans({
    distanceKm: 80,
    durationMinutes: 70,
    energyType: "electric",
    soc: 80,
    minArrivalSoc: 20,
    maxStops: 3,
    stations: []
  });
  assert.equal(result.plans[0].stopCount, 0);
  assert.equal(result.plans[0].totalAmount, 0);
  assert.ok(result.plans[0].arrivalSoc >= 20);
});

test("long-trip planner accounts for every leg of a three-stop national EV trip", () => {
  const result = buildLongTripPlans({
    distanceKm: 900,
    durationMinutes: 600,
    energyType: "electric",
    soc: 65,
    minArrivalSoc: 20,
    maxStops: 3,
    maxDetourKm: 8,
    stations: [
      { id: "north-hebei", name: "冀北补能站", progressKm: 230, detourKm: 1.4, p50: 5, p90: 12, price: 1.32 },
      { id: "central-shandong", name: "鲁中补能站", progressKm: 470, detourKm: 1.8, p50: 7, p90: 14, price: 1.18 },
      { id: "south-jiangsu", name: "苏北补能站", progressKm: 710, detourKm: 1.6, p50: 4, p90: 10, price: 1.26 }
    ]
  });
  const threeStopPlan = result.plans.find((plan) => plan.stopCount === 3);

  assert.ok(threeStopPlan, "the corridor should require and return a three-stop option");
  assert.deepEqual(threeStopPlan.stops.map((stop) => stop.id), ["north-hebei", "central-shandong", "south-jiangsu"]);
  assert.equal(threeStopPlan.legs.length, 4, "three charging stops create four driving legs");
  assert.equal(threeStopPlan.legs.reduce((sum, distance) => sum + distance, 0), threeStopPlan.totalDistanceKm);
  assert.ok(threeStopPlan.stops.every((stop) => stop.arrivalSoc >= 2 && stop.targetSoc > stop.arrivalSoc));
  assert.ok(threeStopPlan.totalDetourKm <= 8);
  assert.ok(threeStopPlan.arrivalSoc >= threeStopPlan.targetArrivalSoc);
});

test("long-trip planner supports a six-stop national EV corridor", () => {
  const result = buildLongTripPlans({
    distanceKm: 1700,
    durationMinutes: 1080,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    maxStops: 6,
    maxDetourKm: 8,
    stations: [
      { id: "s1", name: "第一站", progressKm: 150, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s2", name: "第二站", progressKm: 400, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s3", name: "第三站", progressKm: 650, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s4", name: "第四站", progressKm: 900, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s5", name: "第五站", progressKm: 1150, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s6", name: "第六站", progressKm: 1400, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 }
    ]
  });
  const sixStopPlan = result.plans.find((plan) => plan.stopCount === 6);
  assert.ok(sixStopPlan, "the public planner should support six charging stops");
  assert.equal(sixStopPlan.legs.length, 7);
  assert.ok(sixStopPlan.arrivalSoc >= sixStopPlan.targetArrivalSoc);
});

test("long-trip planner supports multi-stop fuel routing under the same six-stop cap", () => {
  const result = buildLongTripPlans({
    distanceKm: 1200,
    durationMinutes: 780,
    energyType: "fuel",
    soc: 22,
    minArrivalSoc: 20,
    maxStops: 6,
    maxDetourKm: 18,
    stations: [
      { id: "fuel-1", name: "第一综合能源站", progressKm: 100, detourKm: 0.5, p50: 4, p90: 8, price: 7.4 },
      { id: "fuel-2", name: "第二综合能源站", progressKm: 500, detourKm: 0.5, p50: 4, p90: 8, price: 7.4 },
      { id: "fuel-3", name: "第三综合能源站", progressKm: 900, detourKm: 0.5, p50: 4, p90: 8, price: 7.4 }
    ]
  });
  const multiStopPlan = result.plans.find((plan) => plan.stopCount >= 3);
  assert.ok(multiStopPlan, "fuel mode should create a multi-stop route instead of reporting a false cap failure");
  assert.equal(multiStopPlan.unit, "L");
  assert.ok(multiStopPlan.arrivalSoc >= multiStopPlan.targetArrivalSoc);
});

test("long-trip planner returns an explicit no-solution result when a corridor needs more than six stops", () => {
  const result = buildLongTripPlans({
    distanceKm: 2300,
    durationMinutes: 1440,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    maxStops: 99,
    maxDetourKm: 8,
    stations: [
      { id: "s1", name: "第一站", progressKm: 150, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s2", name: "第二站", progressKm: 450, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s3", name: "第三站", progressKm: 750, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s4", name: "第四站", progressKm: 1050, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s5", name: "第五站", progressKm: 1350, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s6", name: "第六站", progressKm: 1650, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s7", name: "第七站", progressKm: 1950, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 }
    ]
  });

  assert.equal(result.maxStops, 6, "the public planner must not silently exceed its six-stop cap");
  assert.deepEqual(result.plans, []);
  assert.equal(result.reason, "NO_FEASIBLE_SEQUENCE");
  assert.equal(result.candidatesConsidered, 7);
});
