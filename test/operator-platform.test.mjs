import assert from "node:assert/strict";
import test from "node:test";
import { simulateOperator } from "../lib/operator.mjs";

const economics = {
  platformCoupon: 4,
  merchantCouponShare: 0.25,
  platformTakeRate: 0.12,
  platformVariableCost: 0.2,
  campaignBudget: 1000,
  dataSource: "partner-feed",
  asOf: "2026-08-08T00:00:00Z"
};

const stations = [
  {
    id: "source",
    name: "高峰源站",
    partner: true,
    controllable: true,
    couponEligible: true,
    merchantAccepted: true,
    occupancy: 0.88,
    wait: 20,
    capacity: 20,
    windowCapacity: 18,
    demand: 12,
    serviceRate: 4,
    price: 1.8
  },
  {
    id: "target",
    name: "承接站",
    partner: true,
    controllable: true,
    couponEligible: true,
    merchantAccepted: true,
    occupancy: 0.35,
    wait: 5,
    capacity: 30,
    windowCapacity: 20,
    demand: 5,
    serviceRate: 6,
    price: 1.1
  },
  {
    id: "blocked",
    name: "非合作导航站",
    partner: false,
    controllable: false,
    couponEligible: true,
    merchantAccepted: true,
    occupancy: 0.1,
    wait: 1,
    capacity: 60,
    windowCapacity: 55,
    demand: 4,
    serviceRate: 12,
    price: 0.8
  }
];

function run(overrides = {}, stationOverrides = {}) {
  return simulateOperator({
    stations: stations.map((station) => ({ ...station, ...(stationOverrides[station.id] || {}) })),
    targetStationId: "target",
    ...economics,
    ...overrides
  });
}

test("platform coupon, price, service rate, and window capacity affect the executable scenario", () => {
  const noCoupon = run({ platformCoupon: 0 });
  const subsidized = run({ platformCoupon: 8 });
  assert.ok(subsidized.impact.divertedVehicles > noCoupon.impact.divertedVehicles);
  assert.ok(subsidized.impact.platformCouponCost > noCoupon.impact.platformCouponCost);

  const expensiveTarget = run({}, { target: { price: 2.2 } });
  assert.ok(run().impact.divertedVehicles > expensiveTarget.impact.divertedVehicles);

  const slowTarget = run({}, { target: { serviceRate: 1.5 } });
  const fastTarget = run({}, { target: { serviceRate: 10 } });
  assert.ok(fastTarget.impact.acceptedOrders > slowTarget.impact.acceptedOrders);

  const tightWindow = run({}, { target: { windowCapacity: 5 } });
  const openWindow = run({}, { target: { windowCapacity: 30 } });
  assert.ok(openWindow.impact.acceptedOrders > tightWindow.impact.acceptedOrders);
  const tightTarget = tightWindow.stations.find((station) => station.id === "target");
  assert.ok(tightTarget.demand <= tightTarget.effectiveWindowCapacity + 1e-9);
});

test("non-partner or non-accepted stations are navigation-only and cannot be selected", () => {
  const unaccepted = {
    id: "unaccepted",
    name: "未接受站",
    partner: true,
    controllable: true,
    couponEligible: true,
    merchantAccepted: false,
    occupancy: 0.05,
    wait: 1,
    capacity: 60,
    windowCapacity: 55,
    demand: 2,
    serviceRate: 12,
    price: 0.7
  };
  const result = simulateOperator({
    ...economics,
    platformCoupon: 6,
    stations: [...stations, unaccepted],
    targetStationId: "blocked"
  });

  assert.equal(result.targetStation.id, "target");
  assert.deepEqual(
    result.navigationOnlyStations.map((station) => station.id).sort(),
    ["blocked", "unaccepted"]
  );
  assert.equal(result.execution.targetStationId, "target");
  assert.equal(result.stations.find((station) => station.id === "blocked").executionEligible, false);
  assert.equal(result.stations.find((station) => station.id === "unaccepted").executionEligible, false);
});

test("an observable non-partner peak station can be a diversion source without becoming an execution target", () => {
  const result = simulateOperator({
    ...economics,
    platformCoupon: 8,
    targetStationId: "target",
    stations: [
      {
        ...stations[0],
        id: "external-peak",
        name: "站外高峰站",
        partner: false,
        controllable: false,
        couponEligible: false,
        merchantAccepted: false,
        occupancy: 0.92,
        wait: 28,
        demand: 16
      },
      stations[1]
    ]
  });

  assert.equal(result.targetStation.id, "target");
  assert.equal(result.execution.executable, true);
  assert.ok(result.impact.divertedVehicles > 0);
  assert.ok(result.stations.find((station) => station.id === "external-peak").changedDemand < 0);
  assert.equal(result.stations.find((station) => station.id === "external-peak").executionEligible, false);
});

test("legacy calls remain usable but economic output is explicitly labelled as scenario data", () => {
  const result = simulateOperator({
    discountAmount: 6,
    targetStationId: "target",
    stations: stations.map(({ partner, controllable, couponEligible, merchantAccepted, ...station }) => station)
  });

  assert.equal(result.targetStation.id, "target");
  assert.ok(result.labels.includes("scenario"));
  assert.ok(result.labels.includes("insufficient-data"));
  assert.equal(result.assumptions.economics.sufficientForRealRoi, false);
  assert.equal(typeof result.platformContribution, "number");
  assert.equal(typeof result.merchantContribution, "number");
  assert.equal(typeof result.scenarioRoi, "number");
  assert.equal(result.impact.roi, result.impact.scenarioRoi);
});

test("a network with no executable partner station returns navigation-only without a strategy", () => {
  const result = simulateOperator({
    ...economics,
    stations: [{
      ...stations[0],
      partner: false,
      controllable: false,
      couponEligible: false,
      merchantAccepted: false
    }],
    targetStationId: "source"
  });

  assert.equal(result.targetStation, null);
  assert.equal(result.execution.executable, false);
  assert.equal(result.recommendation, "navigation-only");
  assert.equal(result.impact.acceptedOrders, 0);
  assert.ok(result.labels.includes("navigation-only"));
});
