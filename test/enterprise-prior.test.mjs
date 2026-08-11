import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { forecastStations } from "../lib/forecast.mjs";
import {
  enterprisePriorHealth,
  loadEnterpriseDemandPrior,
  resolveEnterpriseDemandPrior
} from "../lib/enterprise-prior.mjs";

test("enterprise prior loads as an offline city/type/hour artifact", async () => {
  const prior = await loadEnterpriseDemandPrior({ filePath: join(process.cwd(), "test", "fixtures", "enterprise-prior.fixture.json") });
  assert.equal(prior.available, true);
  assert.equal(prior.modelVersion, "fixture-enterprise-prior");
  assert.equal(prior.cityCount, 1);
  assert.equal(enterprisePriorHealth(prior).configured, true);
});

test("enterprise prior enriches a nearby POI without claiming station-level reality", async () => {
  const prior = await loadEnterpriseDemandPrior({ filePath: join(process.cwd(), "test", "fixtures", "enterprise-prior.fixture.json") });
  const evidence = resolveEnterpriseDemandPrior(prior, {
    id: "beijing-demo",
    name: "测试充电站",
    type: "充电站",
    location: [116.40, 39.90]
  }, { departureMinutes: 8 * 60 });
  assert.equal(evidence?.matched, true);
  assert.equal(evidence?.energyType, "electric");
  assert.match(evidence.sourceBoundary, /城市/);
  assert.ok(evidence.demandFactor >= 0.65 && evidence.demandFactor <= 1.45);
  assert.ok(evidence.confidenceScore < 90);
});

test("forecast exposes enterprise prior while retaining simulation queue semantics", async () => {
  const prior = await loadEnterpriseDemandPrior({ filePath: join(process.cwd(), "test", "fixtures", "enterprise-prior.fixture.json") });
  const evidence = resolveEnterpriseDemandPrior(prior, {
    id: "beijing-forecast",
    name: "测试加油站",
    type: "加油站",
    location: [116.40, 39.90],
    occupancy: 0.6,
    wait: 8,
    capacity: 12,
    arrivalRate: 1.4,
    serviceRate: 1.8
  }, { departureMinutes: 12 * 60 });
  const result = forecastStations([{
    id: "beijing-forecast",
    name: "测试加油站",
    type: "加油站",
    location: [116.40, 39.90],
    enterpriseDemandFactor: evidence.demandFactor,
    enterprisePrior: evidence,
    occupancy: 0.6,
    wait: 8,
    capacity: 12,
    arrivalRate: 1.4,
    serviceRate: 1.8
  }], { departureMinutes: 12 * 60 });
  const station = result.stations[0];
  assert.equal(result.source, "enterprise-prior+simulation");
  assert.equal(station.source, "enterprise-prior+simulation");
  assert.equal(station.enterprisePrior.matched, true);
  assert.match(station.explanation, /企业需求先验/);
  assert.equal(station.simulation, true);
});

test("forecast falls back to the original simulation when enterprise evidence is absent", () => {
  const result = forecastStations([{
    id: "unknown",
    name: "未匹配站点",
    type: "补能站",
    location: [120, 30]
  }], { departureMinutes: 480 });
  assert.equal(result.source, "simulation");
  assert.equal(result.stations[0].enterprisePrior, null);
  assert.equal(result.stations[0].confidence, "simulation-only");
});
