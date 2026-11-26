import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { ENERGY_PROFILES } from "../lib/energy.mjs";
import { touTariffForMinute, optimizeDepartureWindows } from "../lib/departure-optimizer.mjs";
import { simulateOperator } from "../lib/operator.mjs";
import { createCouponStore } from "../lib/coupons.mjs";
import { VISION_ANNOTATION_KINDS, evaluateVisionQueueFeedback } from "../lib/vision-queue.mjs";
import { API_CONTRACTS } from "../lib/contracts.mjs";
import { createRateLimiter, DEFAULT_RATE_LIMITS, readRateLimitConfig } from "../lib/rate-limit.mjs";
import { createRequestHandler, rateLimitScopeForRequest } from "../server.mjs";

const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080
]);

async function withServer(overrides, run) {
  const limiter = overrides.rateLimiter || createRateLimiter({
    limits: {
      plan: 200, stt: 100, map: 200, cv: 100, operator: 200, validate: 100,
      "feishu-sync": 100, "feishu-status": 100, approve: 100, "version-check": 100, execution: 100
    },
    trustProxy: false
  });
  let server;
  let port;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = createServer(createRequestHandler({ ...overrides, rateLimiter: limiter }));
    await new Promise((resolve) => candidate.listen(0, "127.0.0.1", resolve));
    const boundPort = candidate.address().port;
    if (!FETCH_BAD_PORTS.has(boundPort)) {
      server = candidate;
      port = boundPort;
      break;
    }
    await new Promise((resolve) => candidate.close(resolve));
  }
  if (!server) throw new Error("FAILED_TO_BIND_SAFE_TEST_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await run({ baseUrl, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function loadVehiclePresetsModule() {
  const source = await readFile(new URL("../vehicle-presets.js", import.meta.url), "utf8");
  const context = { window: {}, console };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "vehicle-presets.js" });
  return context.window.FlowTwinVehiclePresets;
}

// ---------- F2: Departure Window Optimizer ----------

test("F2: touTariffForMinute covers valley, flat, peak, super-peak, and flat fuel pricing", () => {
  // Valley: 23:00-07:00
  assert.deepEqual(touTariffForMinute(23 * 60, "electric"), { tariffTier: "谷时", tariffCode: "valley", touMultiplier: 0.68 });
  assert.deepEqual(touTariffForMinute(2 * 60 + 30, "electric"), { tariffTier: "谷时", tariffCode: "valley", touMultiplier: 0.68 });
  assert.deepEqual(touTariffForMinute("06:59", "hybridElectric"), { tariffTier: "谷时", tariffCode: "valley", touMultiplier: 0.68 });

  // Flat: 07:00-10:00, 15:00-18:00, 22:00-23:00
  assert.deepEqual(touTariffForMinute("07:00", "electric"), { tariffTier: "平时", tariffCode: "flat", touMultiplier: 1.0 });
  assert.deepEqual(touTariffForMinute("16:30", "electric"), { tariffTier: "平时", tariffCode: "flat", touMultiplier: 1.0 });
  assert.deepEqual(touTariffForMinute("22:15", "electric"), { tariffTier: "平时", tariffCode: "flat", touMultiplier: 1.0 });

  // Peak: 10:00-15:00, 18:00-19:00, 21:00-22:00
  assert.deepEqual(touTariffForMinute("10:00", "electric"), { tariffTier: "峰时", tariffCode: "peak", touMultiplier: 1.28 });
  assert.deepEqual(touTariffForMinute("18:30", "electric"), { tariffTier: "峰时", tariffCode: "peak", touMultiplier: 1.28 });
  assert.deepEqual(touTariffForMinute("21:00", "electric"), { tariffTier: "峰时", tariffCode: "peak", touMultiplier: 1.28 });

  // Super-peak: 19:00-21:00
  assert.deepEqual(touTariffForMinute("19:00", "electric"), { tariffTier: "尖峰", tariffCode: "super-peak", touMultiplier: 1.38 });
  assert.deepEqual(touTariffForMinute("20:59", "electric"), { tariffTier: "尖峰", tariffCode: "super-peak", touMultiplier: 1.38 });

  // Fuel & hybridFuel stay flat at 1.0
  assert.deepEqual(touTariffForMinute("19:30", "fuel"), { tariffTier: "基准油价", tariffCode: "flat", touMultiplier: 1.0 });
  assert.deepEqual(touTariffForMinute("01:00", "hybridFuel"), { tariffTier: "基准油价", tariffCode: "flat", touMultiplier: 1.0 });
});

test("F2: optimizeDepartureWindows computes savings across TOU transitions and validates input", () => {
  assert.throws(() => optimizeDepartureWindows({ stations: [] }), /STATIONS_REQUIRED/);
  assert.throws(() => optimizeDepartureWindows({}), /STATIONS_REQUIRED/);

  const peakStation = {
    id: "st-cbd",
    name: "国贸超充站",
    type: "充电站",
    occupancy: 0.84,
    wait: 18,
    capacity: 16,
    arrivalRate: 2.2,
    serviceRate: 1.9,
    price: 1.6,
    etaMinutes: 20
  };

  // Departing at 19:30 (super-peak) with offsets pushing into 21:00/22:00/23:00 yields substantial TOU cost savings
  const result = optimizeDepartureWindows({
    stations: [peakStation],
    stationId: "st-cbd",
    baseDepartureMinutes: "19:30",
    arrivalOffsetMinutes: 20,
    energyType: "electric",
    energyUnits: 45,
    offsets: [60, 120, 210] // omits 0 intentionally: optimizer must inject 0 baseline
  });

  assert.equal(result.stationId, "st-cbd");
  assert.equal(result.stationName, "国贸超充站");
  assert.equal(result.baseDepartureClock, "19:30");
  assert.deepEqual(result.windows.map((w) => w.offsetMinutes), [0, 60, 120, 210]);
  assert.equal(result.windows[0].label, "现在");
  assert.equal(result.windows[0].isCurrent, true);
  assert.equal(result.windows[0].tariffCode, "super-peak");
  assert.equal(result.windows[3].tariffCode, "valley");
  assert.ok(result.windows[3].costSavingVsNow > 20, "valley transition should save substantial energy cost");
  assert.equal(result.windows.filter((w) => w.isRecommended).length, 1);
  assert.equal(result.bestWindow.isRecommended, true);
  assert.notEqual(result.bestWindow.offsetMinutes, 0);
  assert.match(result.recommendation, /建议推迟/);

  // Calm off-peak station already in valley keeps offset 0 as recommended
  const calmResult = optimizeDepartureWindows({
    stations: [{ id: "st-quiet", name: "深夜畅通站", occupancy: 0.2, wait: 1, capacity: 24, arrivalRate: 0.5, serviceRate: 2.5, price: 1.2 }],
    baseDepartureMinutes: "01:00",
    arrivalOffsetMinutes: 15,
    energyType: "electric",
    energyUnits: 30,
    offsets: [0, 30, 60]
  });
  assert.equal(calmResult.bestWindow.offsetMinutes, 0);
  assert.match(calmResult.recommendation, /当前出发窗口/);
});

test("F2: HTTP /api/departure-windows enforces method, CSRF, validation, and returns windows", async () => {
  assert.equal(rateLimitScopeForRequest("POST", "/api/departure-windows"), "map");

  await withServer({ config: {} }, async ({ baseUrl, port }) => {
    const getRes = await fetch(`${baseUrl}/api/departure-windows`);
    assert.equal(getRes.status, 405);
    assert.equal(getRes.headers.get("allow"), "POST");

    const csrfRes = await fetch(`${baseUrl}/api/departure-windows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ stations: [{ id: "s1", name: "测试站" }] })
    });
    assert.equal(csrfRes.status, 403);

    const emptyRes = await fetch(`${baseUrl}/api/departure-windows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ stations: [] })
    });
    assert.equal(emptyRes.status, 400);
    assert.equal((await emptyRes.json()).error, "STATIONS_REQUIRED");

    const okRes = await fetch(`${baseUrl}/api/departure-windows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({
        stations: [{ id: "s1", name: "望京超充站", occupancy: 0.8, wait: 15, price: 1.5 }],
        baseDepartureMinutes: "19:00",
        arrivalOffsetMinutes: 25,
        energyType: "electric",
        energyUnits: 40
      })
    });
    assert.equal(okRes.status, 200);
    const data = await okRes.json();
    assert.equal(data.stationId, "s1");
    assert.equal(data.windows.length, 5);
    assert.ok(data.bestWindow);
  });
});

// ---------- F3: Shared Vehicle Presets & Cost Ledger Helpers ----------

test("F3: built-in presets match ENERGY_PROFILES baselines exactly", async () => {
  const vp = await loadVehiclePresetsModule();
  assert.equal(vp.BUILTIN_VEHICLE_PRESETS.length, 8);

  const evStd = vp.getPresetById(vp.DEFAULT_PRESET_BY_ENERGY.electric);
  assert.equal(evStd.id, "ev-standard");
  assert.equal(evStd.capacity, ENERGY_PROFILES.electric.capacity);
  assert.equal(evStd.consumptionPerKm, ENERGY_PROFILES.electric.consumptionPerKm);
  assert.equal(evStd.nominalFullRangeKm, ENERGY_PROFILES.electric.nominalFullRangeKm);
  assert.equal(evStd.peakPowerKw, 180);

  const fuelStd = vp.getPresetById(vp.DEFAULT_PRESET_BY_ENERGY.fuel);
  assert.equal(fuelStd.id, "fuel-sedan");
  assert.equal(fuelStd.capacity, ENERGY_PROFILES.fuel.capacity);
  assert.equal(fuelStd.consumptionPerKm, ENERGY_PROFILES.fuel.consumptionPerKm);
  assert.equal(fuelStd.nominalFullRangeKm, ENERGY_PROFILES.fuel.nominalFullRangeKm);

  const hybStd = vp.getPresetById(vp.DEFAULT_PRESET_BY_ENERGY.hybrid);
  assert.equal(hybStd.id, "hybrid-commuter");
  assert.equal(hybStd.capacity, ENERGY_PROFILES.hybridElectric.capacity);
  assert.equal(hybStd.consumptionPerKm, ENERGY_PROFILES.hybridElectric.consumptionPerKm);
  assert.equal(hybStd.nominalFullRangeKm, ENERGY_PROFILES.hybridElectric.nominalFullRangeKm);
  assert.equal(hybStd.fuelCapacity, ENERGY_PROFILES.hybridFuel.capacity);
  assert.equal(hybStd.fuelConsumptionPerKm, ENERGY_PROFILES.hybridFuel.consumptionPerKm);
  assert.equal(hybStd.fuelNominalFullRangeKm, ENERGY_PROFILES.hybridFuel.nominalFullRangeKm);

  // Check remaining 5 presets exact figures
  assert.equal(vp.getPresetById("ev-800v-fast").nominalFullRangeKm, 617);
  assert.equal(vp.getPresetById("ev-urban-compact").nominalFullRangeKm, 435);
  assert.equal(vp.getPresetById("ev-long-suv").nominalFullRangeKm, 540);
  assert.equal(vp.getPresetById("fuel-suv").nominalFullRangeKm, 708);
  const erev = vp.getPresetById("hybrid-erev-suv");
  assert.equal(erev.nominalFullRangeKm, 219);
  assert.equal(erev.fuelNominalFullRangeKm, 956);

  // Energy-type filtering + profile conversion
  assert.equal(vp.getPresetsForEnergyType("electric").length, 4);
  assert.equal(vp.getPresetsForEnergyType("fuel").length, 2);
  assert.equal(vp.getPresetsForEnergyType("hybrid").length, 2);

  const profiles = vp.presetToEnergyProfiles(vp.getPresetById("ev-800v-fast"));
  assert.equal(profiles.electric.capacity, 100);
  assert.equal(profiles.electric.consumptionPerKm, 0.162);
  assert.equal(profiles.electric.peakPowerKw, 320);
  assert.equal(profiles.fuel.capacity, 55);
});

test("F3: custom preset sanitization, charging taper curve, cost breakdown, ledger summary, and CSV formula protection", async () => {
  const vp = await loadVehiclePresetsModule();

  // Valid custom preset
  const clean = vp.sanitizeCustomPreset({
    name: "  我的测试电车\u0007  ",
    energyType: "electric",
    capacity: 85,
    consumptionPer100Km: 15.5,
    peakPowerKw: 240
  });
  assert.ok(clean);
  assert.equal(clean.name, "我的测试电车");
  assert.equal(clean.capacity, 85);
  assert.equal(clean.consumptionPerKm, 0.155);
  assert.equal(clean.peakPowerKw, 240);
  assert.equal(clean.custom, true);

  // Invalid bounds rejected
  assert.equal(vp.sanitizeCustomPreset({ name: "", energyType: "electric", capacity: 80, consumptionPer100Km: 16 }), null);
  assert.equal(vp.sanitizeCustomPreset({ name: "过小电池", energyType: "electric", capacity: 5, consumptionPer100Km: 16 }), null);
  assert.equal(vp.sanitizeCustomPreset({ name: "过大电池", energyType: "electric", capacity: 300, consumptionPer100Km: 16 }), null);
  assert.equal(vp.sanitizeCustomPreset({ name: "异常电耗", energyType: "electric", capacity: 80, consumptionPer100Km: 60 }), null);
  assert.equal(vp.sanitizeCustomPreset({ name: "异常功率", energyType: "electric", capacity: 80, consumptionPer100Km: 16, peakPowerKw: 900 }), null);
  assert.equal(vp.sanitizeCustomPreset({ name: "未知能源", energyType: "hydrogen", capacity: 80, consumptionPer100Km: 16 }), null);

  // Charging curve models CV taper above 80% SOC
  const midBandMin = vp.estimateFastChargeMinutes({ energyKwh: 20, peakPowerKw: 180, fromSoc: 20, toSoc: 40 });
  const highBandMin = vp.estimateFastChargeMinutes({ energyKwh: 20, peakPowerKw: 180, fromSoc: 80, toSoc: 100 });
  const fast800vMin = vp.estimateFastChargeMinutes({ energyKwh: 50, peakPowerKw: 320, fromSoc: 20, toSoc: 80 });
  const std400vMin = vp.estimateFastChargeMinutes({ energyKwh: 50, peakPowerKw: 180, fromSoc: 20, toSoc: 80 });
  assert.ok(highBandMin > midBandMin * 2.5, `expected strong taper above 80% SOC (${highBandMin} vs ${midBandMin})`);
  assert.ok(fast800vMin < std400vMin, "higher peakPowerKw must charge faster");
  assert.equal(vp.estimateFastChargeMinutes({ energyKwh: 0, peakPowerKw: 180 }), 0);

  // Cost breakdown with TOU valley + coupon discount + tolls
  const breakdown = vp.computeTripCostBreakdown({
    energyType: "electric",
    energyNeeded: 40,
    unitPrice: 1.5,
    touMultiplier: 0.68,
    peakTouMultiplier: 1.38,
    tolls: 25,
    couponDiscount: 8,
    distanceKm: 200
  });
  assert.equal(breakdown.effectiveUnitPrice, 1.02);
  assert.equal(breakdown.grossEnergyCost, 40.8);
  assert.equal(breakdown.couponDiscount, 8);
  assert.equal(breakdown.netEnergyCost, 32.8);
  assert.equal(breakdown.totalCost, 57.8);
  assert.ok(breakdown.touSavings > 40);
  assert.equal(breakdown.costPerKm, 0.29);

  // Ledger summary
  const summary = vp.summarizeLedger([
    { distanceKm: 120, netEnergyCost: 24, tolls: 15, couponDiscount: 6, touSavings: 8, waitSavedMinutes: 7.5 },
    { distanceKm: 80, netEnergyCost: 16, tolls: 0, couponDiscount: 4, touSavings: 5, waitSavedMinutes: 4.5 }
  ]);
  assert.equal(summary.tripCount, 2);
  assert.equal(summary.totalDistanceKm, 200);
  assert.equal(summary.totalCost, 55);
  assert.equal(summary.totalCouponSavings, 10);
  assert.equal(summary.totalTouSavings, 13);
  assert.equal(summary.totalWaitSavedMinutes, 12);

  // CSV export: UTF-8 BOM, RFC4180 quoting, formula injection protection
  const csv = vp.exportLedgerToCsv([
    {
      timestamp: "2026-11-26 19:00",
      vehicleName: '=CMD|" /C calc"!A0',
      energyType: "electric",
      origin: "+SUM(A1:A2)",
      destination: "-2+3",
      stationName: '@HYPERLINK("http://evil"), 朝阳 "A" 站',
      distanceKm: 100,
      energyNeeded: 20,
      netEnergyCost: 22,
      tolls: 10,
      couponDiscount: 6,
      touSavings: 5,
      totalCost: 32,
      waitSavedMinutes: 4
    },
    {
      timestamp: "\t=1+1",
      vehicleName: "\r=2+2",
      energyType: "fuel",
      origin: "北京",
      destination: "天津",
      stationName: "服务区"
    },
    {
      timestamp: " =CMD|\" /C calc\"!A0",
      vehicleName: "\u00A0=HYPERLINK(\"http://evil\")",
      energyType: "\uFEFF=1+1",
      origin: "\n=1+1",
      destination: "  +1+1",
      stationName: "\u00A0-2+3"
    },
    {
      timestamp: "+1+1",
      vehicleName: "-2+3",
      energyType: "@SUM(1,1)",
      origin: " @SUM(1,1)",
      destination: "普通目的地",
      stationName: "普通站点"
    }
  ]);
  assert.equal(csv.startsWith("\uFEFF"), true, "CSV should start with UTF-8 BOM");
  assert.ok(csv.includes(`"'=CMD|"" /C calc""!A0"`), "leading = must be neutralized with single quote and RFC4180 escaped");
  assert.ok(csv.includes("'+SUM(A1:A2)"), "leading + must be neutralized");
  assert.ok(csv.includes("'-2+3"), "leading - must be neutralized");
  assert.ok(csv.includes(`"'@HYPERLINK(""http://evil""), 朝阳 ""A"" 站"`), "leading @ and quotes/commas must be neutralized");
  assert.ok(csv.includes("'\t=1+1"), "leading tab must be neutralized");
  assert.ok(csv.includes(`"'\n=2+2"`), "leading CR must be neutralized before newline normalization");
  assert.ok(csv.includes(`"' =CMD|"" /C calc""!A0"`), "leading space before = must be neutralized");
  assert.ok(csv.includes(`"'\u00A0=HYPERLINK(""http://evil"")"`), "leading NBSP before = must be neutralized");
  assert.ok(csv.includes("'\uFEFF=1+1"), "leading BOM before = must be neutralized");
  assert.ok(csv.includes(`"'\n=1+1"`), "leading LF before = must be neutralized");
  assert.ok(csv.includes("'  +1+1"), "leading spaces before + must be neutralized");
  assert.ok(csv.includes("'\u00A0-2+3"), "leading NBSP before - must be neutralized");
  assert.ok(csv.includes("'+1+1"), "leading +1+1 must be neutralized");
  assert.ok(csv.includes(`"'@SUM(1,1)"`), "leading @SUM(1,1) must be neutralized");
  assert.ok(csv.includes(`"' @SUM(1,1)"`), "leading space before @SUM(1,1) must be neutralized");
});

// ---------- F4A: Pareto ROI Curve & F4B: Live Coupon Lifecycle ----------

test("F4A: simulateOperator includes paretoCurve with mathematically valid Pareto optimality", () => {
  const result = simulateOperator({
    platformCoupon: 6,
    merchantCouponShare: 0.2,
    platformTakeRate: 0.14,
    platformVariableCost: 0.2,
    campaignBudget: 60,
    stations: [
      { id: "src-1", name: "拥堵源站", partner: true, controllable: true, couponEligible: true, merchantAccepted: true, occupancy: 0.9, wait: 24, capacity: 20, windowCapacity: 18, demand: 15, serviceRate: 4, price: 1.75 },
      { id: "dst-1", name: "空闲承接站", partner: true, controllable: true, couponEligible: true, merchantAccepted: true, occupancy: 0.3, wait: 4, capacity: 28, windowCapacity: 24, demand: 5, serviceRate: 6, price: 1.15 }
    ],
    targetStationId: "dst-1"
  });

  assert.ok(Array.isArray(result.paretoCurve));
  assert.deepEqual(result.paretoCurve.map((p) => p.couponAmount), [0, 2, 4, 6, 8, 10, 12, 15]);
  assert.equal(result.paretoCurve[0].isBaseline, true);
  assert.equal(result.paretoCurve[0].scenarioRoi, 0, "zero-coupon baseline must not produce an artificial variable-cost ROI spike");
  assert.equal(result.paretoCurve.slice(1).every((p) => p.isBaseline === false), true);
  assert.equal(result.paretoCurve.filter((p) => p.isCurrent).length, 1);
  assert.equal(result.paretoCurve.find((p) => p.isCurrent).couponAmount, 6);
  assert.ok(result.paretoCurve.some((p) => p.isParetoOptimal));

  // Verify Pareto dominance invariant independently across all returned points
  for (const pointA of result.paretoCurve) {
    assert.equal(typeof pointA.p90WaitAfter, "number");
    assert.equal(typeof pointA.averageWaitAfter, "number");
    assert.equal(typeof pointA.budgetBound, "boolean");
    assert.equal(typeof pointA.capacityBound, "boolean");
    assert.equal(typeof pointA.isBaseline, "boolean");
    const dominated = result.paretoCurve.some((pointB) => (
      pointB !== pointA
      && pointB.divertedVehicles >= pointA.divertedVehicles - 1e-6
      && pointB.scenarioRoi >= pointA.scenarioRoi - 1e-6
      && (pointB.divertedVehicles > pointA.divertedVehicles + 1e-6
        || pointB.scenarioRoi > pointA.scenarioRoi + 1e-6)
    ));
    assert.equal(pointA.isParetoOptimal, !dominated, `Pareto flag mismatch at couponAmount=${pointA.couponAmount}`);
  }
});

test("F4A regression: paretoCurve includes odd recommendedDiscount, exact fractional platformCoupon, and clean ¥0 baseline", () => {
  const result = simulateOperator({
    platformCoupon: 6.5,
    merchantCouponShare: 0,
    platformTakeRate: 0.28,
    platformVariableCost: 0.2,
    campaignBudget: 200,
    averageOrderUnits: 20,
    stations: [
      { id: "src-1", name: "拥堵源站", partner: true, controllable: true, couponEligible: true, merchantAccepted: true, occupancy: 0.92, wait: 26, capacity: 20, windowCapacity: 18, demand: 15, serviceRate: 4, price: 1.9 },
      { id: "dst-1", name: "空闲承接站", partner: true, controllable: true, couponEligible: true, merchantAccepted: true, occupancy: 0.28, wait: 3, capacity: 28, windowCapacity: 24, demand: 4, serviceRate: 6, price: 1.5 }
    ],
    targetStationId: "dst-1"
  });

  assert.equal(result.recommendedDiscount, 1);
  const tiers = result.paretoCurve.map((p) => p.couponAmount);
  assert.deepEqual(tiers, [0, 1, 2, 4, 6, 6.5, 8, 10, 12, 15]);

  const baseline = result.paretoCurve.find((p) => p.couponAmount === 0);
  assert.equal(baseline.isBaseline, true);
  assert.equal(baseline.scenarioRoi, 0);

  const recommendedPoint = result.paretoCurve.find((p) => p.couponAmount === 1);
  assert.ok(recommendedPoint, "odd recommendedDiscount (1) must be present on paretoCurve");
  assert.equal(recommendedPoint.isRecommended, true);
  assert.equal(recommendedPoint.isBaseline, false);
  assert.equal(result.paretoCurve.filter((p) => p.isRecommended).length, 1);

  const currentPoint = result.paretoCurve.find((p) => p.couponAmount === 6.5);
  assert.ok(currentPoint, "exact fractional platformCoupon (6.5) must be present on paretoCurve");
  assert.equal(currentPoint.isCurrent, true);
  assert.equal(result.paretoCurve.filter((p) => p.isCurrent).length, 1);
});

test("F4B: coupon store lifecycle (issue -> list -> claim -> idempotent claim -> redeem -> idempotent redeem -> exhausted -> reset)", () => {
  let clock = 1_700_000_000_000;
  const store = createCouponStore({ maxCampaigns: 10, ttlMs: 60_000, now: () => clock });

  // Validation errors
  assert.throws(() => store.issue({ stationId: "", stationName: "A", discountAmount: 5 }), (err) => err.statusCode === 400 && err.message === "INVALID_COUPON_INPUT");
  assert.throws(() => store.issue({ stationId: "st-1", stationName: "A", discountAmount: 0 }), (err) => err.statusCode === 400 && err.message === "INVALID_COUPON_INPUT");
  assert.throws(() => store.issue({ stationId: "st-1", stationName: "A", discountAmount: 150 }), (err) => err.statusCode === 400 && err.message === "INVALID_COUPON_INPUT");

  // Issue campaign with quota 1 to test exhaustion
  const issued = store.issue({
    stationId: "st-dst",
    stationName: "望京承接站",
    discountAmount: 8,
    maxRedemptions: 1,
    targetSegment: "price-sensitive",
    sourceScenarioRoi: 1.42,
    sourceDivertedVehicles: 5.5
  });
  assert.equal(issued.ok, true);
  assert.match(issued.campaign.couponId, /^cpn-[0-9a-f]+$/);
  assert.match(issued.campaign.code, /^FT-[0-9A-F]{4}$/);
  assert.equal(issued.campaign.remainingCount, 1);
  assert.equal(issued.summary.activeCampaigns, 1);

  // List campaigns
  const listed = store.list({ stationId: "st-dst", status: "active" });
  assert.equal(listed.campaigns.length, 1);
  assert.equal(listed.campaigns[0].couponId, issued.campaign.couponId);

  // Claim by stationId
  const claim1 = store.claim({ stationId: "st-dst", driverPlate: "京A·88888" });
  assert.equal(claim1.ok, true);
  assert.equal(claim1.idempotent, false);
  assert.match(claim1.claim.claimId, /^clm-[0-9a-f]+$/);
  assert.equal(claim1.claim.voucherCode, `${issued.campaign.code}-001`);
  assert.equal(claim1.campaign.remainingCount, 0);
  assert.equal(claim1.campaign.claimedCount, 1);

  // Idempotent duplicate claim for same driverPlate
  const claimDup = store.claim({ couponId: issued.campaign.couponId, driverPlate: "京A·88888" });
  assert.equal(claimDup.ok, true);
  assert.equal(claimDup.idempotent, true);
  assert.equal(claimDup.claim.claimId, claim1.claim.claimId);
  assert.equal(claimDup.campaign.claimedCount, 1);

  // Another driver hits exhaustion -> 409 COUPON_EXHAUSTED
  assert.throws(
    () => store.claim({ couponId: issued.campaign.couponId, driverPlate: "京B·99999" }),
    (err) => err.statusCode === 409 && err.message === "COUPON_EXHAUSTED"
  );

  // Redeem with invalid grossAmount -> 400
  assert.throws(
    () => store.redeem({ claimId: claim1.claim.claimId, grossAmount: -5 }),
    (err) => err.statusCode === 400 && err.message === "INVALID_REDEEM_INPUT"
  );

  // Redeem validly
  const redeemed = store.redeem({ claimId: claim1.claim.claimId, grossAmount: 42.5 });
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.idempotent, false);
  assert.equal(redeemed.redemption.discountApplied, 8);
  assert.equal(redeemed.redemption.netPaid, 34.5);
  assert.equal(redeemed.campaign.redeemedCount, 1);
  assert.equal(redeemed.campaign.totalDiscountRedeemed, 8);
  assert.equal(redeemed.summary.redemptionRate, 1);

  // Idempotent duplicate redeem does not double-count
  const redeemDup = store.redeem({ claimId: claim1.claim.claimId, grossAmount: 42.5 });
  assert.equal(redeemDup.ok, true);
  assert.equal(redeemDup.idempotent, true);
  assert.equal(redeemDup.campaign.redeemedCount, 1);
  assert.equal(redeemDup.campaign.totalDiscountRedeemed, 8);

  // Superseding campaign on same station preserves prior redemption stats
  const issued2 = store.issue({ stationId: "st-dst", stationName: "望京承接站", discountAmount: 10, maxRedemptions: 5 });
  assert.equal(issued2.summary.activeCampaigns, 1);
  assert.equal(issued2.summary.redeemedCount, 1);
  assert.equal(store.list({ status: "superseded" }).campaigns.length, 1);

  // Reset clears store cleanly
  const resetRes = store.reset();
  assert.equal(resetRes.ok, true);
  assert.equal(resetRes.cleared, 2);
  assert.equal(resetRes.summary.activeCampaigns, 0);
  assert.equal(store.list().campaigns.length, 0);
});

test("F4B: HTTP /api/coupons/* endpoints support full round-trip, method guards, and CSRF", async () => {
  assert.equal(rateLimitScopeForRequest("GET", "/api/coupons"), "map");
  assert.equal(rateLimitScopeForRequest("POST", "/api/coupons/issue"), "map");
  assert.equal(rateLimitScopeForRequest("POST", "/api/coupons/claim"), "map");
  assert.equal(rateLimitScopeForRequest("POST", "/api/coupons/redeem"), "map");
  assert.equal(rateLimitScopeForRequest("POST", "/api/coupons/reset"), "map");
  assert.equal(rateLimitScopeForRequest("POST", "/api/operator/simulate"), "operator");
  assert.equal(DEFAULT_RATE_LIMITS.operator, 60);
  assert.equal(readRateLimitConfig({}).limits.operator, 60);

  const couponStore = createCouponStore();
  await withServer({ config: {}, couponStore }, async ({ baseUrl, port }) => {
    const jsonHeaders = { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` };

    // Method guards
    assert.equal((await fetch(`${baseUrl}/api/coupons`, { method: "POST", headers: jsonHeaders, body: "{}" })).status, 405);
    assert.equal((await fetch(`${baseUrl}/api/coupons/issue`)).status, 405);
    assert.equal((await fetch(`${baseUrl}/api/coupons/claim`)).status, 405);
    assert.equal((await fetch(`${baseUrl}/api/coupons/redeem`)).status, 405);
    assert.equal((await fetch(`${baseUrl}/api/coupons/reset`)).status, 405);

    // CSRF rejection
    const csrfBlocked = await fetch(`${baseUrl}/api/coupons/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ stationId: "s1", stationName: "站1", discountAmount: 6 })
    });
    assert.equal(csrfBlocked.status, 403);

    // Issue -> List -> Claim -> Redeem -> Reset
    const issueRes = await fetch(`${baseUrl}/api/coupons/issue`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ stationId: "s-live", stationName: "三元桥超充站", discountAmount: 6, maxRedemptions: 10 })
    });
    assert.equal(issueRes.status, 200);
    const issued = await issueRes.json();

    const listRes = await fetch(`${baseUrl}/api/coupons?stationId=s-live`);
    assert.equal(listRes.status, 200);
    assert.equal((await listRes.json()).campaigns.length, 1);

    const claimRes = await fetch(`${baseUrl}/api/coupons/claim`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ couponId: issued.campaign.couponId, driverPlate: "京N·12345" })
    });
    assert.equal(claimRes.status, 200);
    const claimed = await claimRes.json();
    assert.equal(claimed.claim.driverPlate, "京N·12345");

    const redeemRes = await fetch(`${baseUrl}/api/coupons/redeem`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ claimId: claimed.claim.claimId, grossAmount: 36 })
    });
    assert.equal(redeemRes.status, 200);
    const redeemed = await redeemRes.json();
    assert.equal(redeemed.redemption.netPaid, 30);

    // Missing claim returns 404
    const missingRedeem = await fetch(`${baseUrl}/api/coupons/redeem`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ claimId: "clm-nonexistent", grossAmount: 20 })
    });
    assert.equal(missingRedeem.status, 404);
    assert.equal((await missingRedeem.json()).error, "CLAIM_NOT_FOUND");

    const resetRes = await fetch(`${baseUrl}/api/coupons/reset`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}"
    });
    assert.equal(resetRes.status, 200);
    assert.equal((await resetRes.json()).cleared, 1);
  });

  // Verify coupon issue/reset requests do not consume the operator simulation rate-limit bucket
  const tightOperatorLimiter = createRateLimiter({
    limits: { operator: 1, map: 20 },
    trustProxy: false
  });
  await withServer({ config: {}, couponStore: createCouponStore(), rateLimiter: tightOperatorLimiter }, async ({ baseUrl, port }) => {
    const jsonHeaders = { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` };
    for (let i = 0; i < 3; i += 1) {
      const issueRes = await fetch(`${baseUrl}/api/coupons/issue`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ stationId: `s-${i}`, stationName: `站${i}`, discountAmount: 5 })
      });
      assert.equal(issueRes.status, 200);
    }
    const resetRes = await fetch(`${baseUrl}/api/coupons/reset`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}"
    });
    assert.equal(resetRes.status, 200);

    // Operator simulate bucket is still untouched and allows its quota
    const simRes = await fetch(`${baseUrl}/api/operator/simulate`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        stations: [
          { id: "a", name: "A站", occupancy: 0.85, wait: 18, capacity: 20, demand: 14, price: 1.6 },
          { id: "b", name: "B站", occupancy: 0.3, wait: 4, capacity: 24, demand: 5, price: 1.2 }
        ],
        platformCoupon: 6,
        targetStationId: "b"
      })
    });
    assert.equal(simRes.status, 200);
  });
});

// ---------- F5: Vision Canvas Queue Feedback ----------

test("F5: evaluateVisionQueueFeedback validates boxes, handles queue-only fallback, and runs port-discrete-event", () => {
  assert.deepEqual(VISION_ANNOTATION_KINDS, ["charging", "idle", "queue", "fault"]);

  // Validation rejections
  assert.throws(() => evaluateVisionQueueFeedback({ annotations: [] }), (err) => err.statusCode === 400 && err.message === "INVALID_VISION_ANNOTATIONS");
  assert.throws(
    () => evaluateVisionQueueFeedback({ annotations: [{ kind: "unknown", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }),
    (err) => err.statusCode === 400 && err.message === "INVALID_VISION_ANNOTATIONS"
  );
  assert.throws(
    () => evaluateVisionQueueFeedback({ annotations: [{ kind: "charging", x: -0.1, y: 0.1, w: 0.2, h: 0.2 }] }),
    (err) => err.statusCode === 400 && err.message === "INVALID_VISION_ANNOTATIONS"
  );
  assert.throws(
    () => evaluateVisionQueueFeedback({ annotations: [{ kind: "charging", x: 0.1, y: 0.1, w: 0, h: 0.2 }] }),
    (err) => err.statusCode === 400 && err.message === "INVALID_VISION_ANNOTATIONS"
  );

  // Idle ports available -> 0 immediate wait
  const idleResult = evaluateVisionQueueFeedback({
    station: { id: "v-1", name: "视觉演示站", occupancy: 0.75, wait: 12, capacity: 6 },
    annotations: [
      { kind: "charging", x: 0.1, y: 0.2, w: 0.15, h: 0.2 },
      { kind: "charging", x: 0.3, y: 0.2, w: 0.15, h: 0.2 },
      { kind: "idle", x: 0.5, y: 0.2, w: 0.15, h: 0.2 },
      { kind: "fault", x: 0.7, y: 0.2, w: 0.15, h: 0.2 }
    ]
  });
  assert.equal(idleResult.ok, true);
  assert.equal(idleResult.source, "vision-manual-annotation");
  assert.equal(idleResult.sourceLabel, "视觉页人工标注回流（演示）");
  assert.deepEqual(idleResult.counts, { charging: 2, idle: 1, queue: 0, fault: 1, totalPorts: 4 });
  assert.equal(idleResult.stationForecast.method, "port-discrete-event");
  assert.equal(idleResult.before.wait, 12);
  assert.equal(idleResult.after.wait, 0);

  // Full charging + queue -> positive wait exceeding idle case
  const busyResult = evaluateVisionQueueFeedback({
    station: { id: "v-1", name: "视觉演示站", occupancy: 0.5, wait: 5, capacity: 4 },
    annotations: [
      { kind: "charging", x: 0.1, y: 0.1, w: 0.15, h: 0.15 },
      { kind: "charging", x: 0.3, y: 0.1, w: 0.15, h: 0.15 },
      { kind: "charging", x: 0.5, y: 0.1, w: 0.15, h: 0.15 },
      { kind: "fault", x: 0.7, y: 0.1, w: 0.15, h: 0.15 },
      { kind: "queue", x: 0.2, y: 0.6, w: 0.15, h: 0.15 },
      { kind: "queue", x: 0.4, y: 0.6, w: 0.15, h: 0.15 }
    ]
  });
  assert.equal(busyResult.counts.queue, 2);
  assert.equal(busyResult.counts.totalPorts, 4);
  assert.ok(busyResult.after.wait > 10, `expected substantial queue wait, got ${busyResult.after.wait}`);
  assert.ok(busyResult.after.p90 > busyResult.after.wait);

  // Queue-only fallback infers full ports from station capacity
  const queueOnly = evaluateVisionQueueFeedback({
    station: { id: "v-2", name: "仅排队标注站", capacity: 6 },
    annotations: [
      { kind: "queue", x: 0.2, y: 0.5, w: 0.2, h: 0.2 },
      { kind: "queue", x: 0.5, y: 0.5, w: 0.2, h: 0.2 }
    ]
  });
  assert.equal(queueOnly.counts.totalPorts, 6);
  assert.equal(queueOnly.snapshot.chargingPorts, 6);
  assert.equal(queueOnly.snapshot.idlePorts, 0);
  assert.equal(queueOnly.snapshot.inferredFromQueueOnly, true);
  assert.ok(queueOnly.after.wait > 0);
});

test("F5: HTTP /api/vision/queue-feedback enforces method, CSRF, validation, and returns forecast", async () => {
  assert.equal(rateLimitScopeForRequest("POST", "/api/vision/queue-feedback"), "map");

  await withServer({ config: {} }, async ({ baseUrl, port }) => {
    const jsonHeaders = { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` };

    assert.equal((await fetch(`${baseUrl}/api/vision/queue-feedback`)).status, 405);

    const csrfRes = await fetch(`${baseUrl}/api/vision/queue-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ annotations: [{ kind: "idle", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] })
    });
    assert.equal(csrfRes.status, 403);

    const badBoxRes = await fetch(`${baseUrl}/api/vision/queue-feedback`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ annotations: [{ kind: "charging", x: 1.5, y: 0.1, w: 0.2, h: 0.2 }] })
    });
    assert.equal(badBoxRes.status, 400);
    assert.equal((await badBoxRes.json()).error, "INVALID_VISION_ANNOTATIONS");

    const okRes = await fetch(`${baseUrl}/api/vision/queue-feedback`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        station: { id: "v-http", name: "HTTP 视觉站", occupancy: 0.6, wait: 8 },
        annotations: [
          { kind: "charging", x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          { kind: "charging", x: 0.4, y: 0.1, w: 0.2, h: 0.2 },
          { kind: "queue", x: 0.2, y: 0.6, w: 0.2, h: 0.2 }
        ]
      })
    });
    assert.equal(okRes.status, 200);
    const data = await okRes.json();
    assert.equal(data.ok, true);
    assert.equal(data.stationForecast.method, "port-discrete-event");
    assert.equal(data.counts.charging, 2);
    assert.equal(data.counts.queue, 1);

    // Forged enterprisePrior / enterpriseDemandFactor / prototype keys via HTTP must be stripped
    const spoofedBody = JSON.stringify({
      station: {
        id: "v-spoof",
        name: "伪造先验站",
        location: [116.461, 39.909],
        occupancy: 0.6,
        wait: 8,
        enterprisePrior: { matched: true, city: "北京", demandFactor: 1.4, meanServiceMinutes: 12 },
        enterpriseDemandFactor: 1.45,
        snapshotTime: "2099-01-01T00:00:00Z"
      },
      annotations: [
        { kind: "charging", x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { kind: "queue", x: 0.4, y: 0.5, w: 0.2, h: 0.2 }
      ]
    });
    const spoofRes = await fetch(`${baseUrl}/api/vision/queue-feedback`, {
      method: "POST",
      headers: jsonHeaders,
      body: spoofedBody
    });
    assert.equal(spoofRes.status, 200);
    const spoofData = await spoofRes.json();
    assert.equal(spoofData.stationForecast.source, "simulation");
    assert.notEqual(spoofData.stationForecast.source, "enterprise-prior+simulation");
    assert.equal(spoofData.stationForecast.enterprisePrior, null);
    assert.deepEqual(spoofData.stationForecast.location, [116.461, 39.909]);
  });
});

test("F5 regression: evaluateVisionQueueFeedback whitelists station fields and blocks enterprisePrior/prototype spoofing", () => {
  const maliciousStation = JSON.parse(JSON.stringify({
    id: "v-sec",
    name: "安全边界站",
    type: "充电站",
    address: "朝阳区测试路 1 号",
    location: ["not-a-lng", 39.9],
    price: 1.45,
    detour: 1.2,
    occupancy: 0.65,
    wait: 9,
    enterprisePrior: { matched: true, city: "上海", demandFactor: 1.4, matchDistanceKm: 2 },
    enterpriseDemandFactor: 1.45,
    snapshotTime: "2099-12-31T23:59:59Z"
  }));
  Object.defineProperty(maliciousStation, "__proto__", {
    value: { pollutedVision: true },
    enumerable: true
  });

  const cleanResult = evaluateVisionQueueFeedback({
    station: {
      id: "v-sec",
      name: "安全边界站",
      type: "充电站",
      address: "朝阳区测试路 1 号",
      price: 1.45,
      detour: 1.2,
      occupancy: 0.65,
      wait: 9
    },
    annotations: [
      { kind: "charging", x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      { kind: "queue", x: 0.4, y: 0.6, w: 0.2, h: 0.2 }
    ]
  });

  const spoofedResult = evaluateVisionQueueFeedback({
    station: maliciousStation,
    annotations: [
      { kind: "charging", x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      { kind: "queue", x: 0.4, y: 0.6, w: 0.2, h: 0.2 }
    ]
  });

  assert.equal(spoofedResult.stationForecast.source, "simulation");
  assert.notEqual(spoofedResult.stationForecast.source, "enterprise-prior+simulation");
  assert.equal(spoofedResult.stationForecast.confidence, "simulation-only");
  assert.equal(spoofedResult.stationForecast.enterprisePrior, null);
  assert.equal(spoofedResult.stationForecast.location, null, "invalid location coordinates must be dropped");
  assert.deepEqual(spoofedResult.after, cleanResult.after, "forged enterpriseDemandFactor must not alter forecast");
  assert.equal(({}).pollutedVision, undefined);
});

// ---------- Contracts Coverage ----------

test("API_CONTRACTS covers all Wave 3 routes and paretoCurve documentation", () => {
  const newRoutes = [
    "/api/departure-windows",
    "/api/coupons",
    "/api/coupons/issue",
    "/api/coupons/claim",
    "/api/coupons/redeem",
    "/api/coupons/reset",
    "/api/vision/queue-feedback"
  ];
  for (const route of newRoutes) {
    assert.ok(Object.hasOwn(API_CONTRACTS, route), `missing API_CONTRACTS entry for ${route}`);
  }
  assert.ok(Object.hasOwn(API_CONTRACTS["/api/operator/simulate"].response, "paretoCurve"));
});
