import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAiBaseUrl } from "../lib/config.mjs";
import { formatPlanResponse, parseTripIntent } from "../lib/plan.mjs";
import { forecastStations } from "../lib/forecast.mjs";
import { simulateOperator } from "../lib/operator.mjs";
import { validateStrategies } from "../lib/validate.mjs";
import { executeFeishu } from "../lib/feishu.mjs";

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
    message: "周五18:30从公司去大兴机场，电量22%，不能迟到，最多绕行5公里，最好附近能吃饭",
    config: { aiBaseUrl: "https://example.com/v1", aiApiKey: "test-secret", aiModel: "test-model", webServiceKey: "geo-secret" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          origin: "能链北京总部", destination: "大兴机场", departureTime: "18:30", arrivalDeadline: null,
          soc: 22, energyType: "electric", priority: "on_time", maxDetourKm: 5, services: ["餐饮"],
          clarificationNeeded: false, assistantReply: "已识别"
        }) } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "1", geocodes: [{ location: "116.410000,39.509000" }] }), { status: 200 });
    }
  });
  assert.equal(result.aiUsed, true);
  assert.equal(result.destination, "大兴机场");
  assert.deepEqual(result.locations.origin.coordinate, [116.491, 39.951]);
  assert.deepEqual(result.locations.destination.coordinate, [116.41, 39.509]);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-secret");
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
});

test("plan parser falls back locally when AI fails", async () => {
  const result = await parseTripIntent({
    message: "18:30去大兴机场，电量22%，不能迟到",
    config: { aiBaseUrl: "https://example.com/v1", aiApiKey: "test-secret", aiModel: "test-model" },
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(result.aiUsed, false);
  assert.equal(result.destination, "大兴机场");
  assert.equal(result.departureTime, "18:30");
  assert.equal(result.soc, 22);
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
