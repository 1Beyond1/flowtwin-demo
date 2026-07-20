const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function hash(value) {
  let result = 0;
  for (const character of String(value || "station")) result = (result * 31 + character.charCodeAt(0)) >>> 0;
  return result;
}

function asNumber(value, fallback, min = 0, max = Number.POSITIVE_INFINITY) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, min, max) : fallback;
}

function userShare(targetUser) {
  const value = String(targetUser || "all").slice(0, 64);
  if (/价格|敏感|省钱/.test(value)) return 0.82;
  if (/长途|跨城|出行/.test(value)) return 0.62;
  if (/电车|新能源/.test(value)) return 0.74;
  return 0.68;
}

function normalizeStations(stations) {
  return (Array.isArray(stations) ? stations : []).slice(0, 200).map((station, index) => {
    const seed = hash(`${station?.id || station?.name || "station"}-${index}`);
    const capacity = asNumber(station?.capacity, 14 + seed % 12, 1, 500);
    const occupancy = asNumber(station?.occupancy, 0.42 + seed % 42 / 100, 0.05, 0.97);
    const demand = asNumber(station?.demand ?? station?.arrivalRate, capacity * (0.35 + occupancy * 0.5), 0, capacity * 4);
    const serviceRate = asNumber(station?.serviceRate, capacity * 0.19, 0.1, capacity * 2);
    const wait = asNumber(station?.wait ?? station?.p50, 4 + occupancy * 18, 0, 180);
    const margin = asNumber(station?.grossMargin, 11 + seed % 7, 0, 1000);
    return {
      id: String(station?.id || `station-${index}`),
      name: String(station?.name || `补能站 ${index + 1}`).slice(0, 100),
      type: String(station?.type || "充电站").slice(0, 30),
      location: station?.location ?? null,
      address: String(station?.address || "").slice(0, 160),
      source: String(station?.source || "演示输入").slice(0, 80),
      detour: asNumber(station?.detour, 0, 0, 1000),
      capacity,
      occupancy,
      demand,
      serviceRate,
      wait,
      margin,
      price: asNumber(station?.price, 1.2 + seed % 55 / 100, 0, 100),
      seed
    };
  });
}

function snapshot(stations) {
  const totalDemand = stations.reduce((sum, station) => sum + station.demand, 0);
  const weighted = (field) => stations.reduce((sum, station) => sum + station[field] * station.demand, 0) / Math.max(totalDemand, 1);
  const averageOccupancy = weighted("occupancy");
  const variance = stations.reduce((sum, station) => sum + Math.pow(station.occupancy - averageOccupancy, 2), 0) / Math.max(1, stations.length);
  return {
    totalDemand: Number(totalDemand.toFixed(2)),
    averageWait: Number(weighted("wait").toFixed(2)),
    p90Wait: Number(Math.max(...stations.map((station) => station.wait * 1.65 + 3), 0).toFixed(2)),
    averageOccupancy: Number(averageOccupancy.toFixed(3)),
    occupancyDispersion: Number(Math.sqrt(variance).toFixed(3)),
    peakQueue: Number(Math.max(...stations.map((station) => Math.max(0, station.demand - station.serviceRate)), 0).toFixed(2))
  };
}

export function simulateOperator(input = {}) {
  const { stations = [], discountAmount = 6, targetStationId = null, targetUser = "all" } = input;
  const baseStations = normalizeStations(stations);
  if (!baseStations.length) throw new Error("STATIONS_REQUIRED");
  const discount = asNumber(input.discountAmount ?? input.discount ?? discountAmount, 0, 0, 100);
  const targetInput = input.targetStationId ?? input.targetStation ?? targetStationId;
  const targetId = typeof targetInput === "object" ? targetInput?.id : targetInput;
  const target = baseStations.find((station) => station.id === String(targetId)) || baseStations.slice().sort((a, b) => {
    const scoreA = a.wait + a.occupancy * 18 + a.detour * 0.4;
    const scoreB = b.wait + b.occupancy * 18 + b.detour * 0.4;
    return scoreA - scoreB;
  })[0];
  const sourceStations = baseStations.filter((station) => station.id !== target.id);
  const pressureDemand = sourceStations.reduce((sum, station) => sum + station.demand * clamp((station.occupancy - 0.56) / 0.38, 0, 1), 0);
  const targetSpare = Math.max(0, target.capacity * 0.82 - target.demand);
  const totalDemand = baseStations.reduce((sum, station) => sum + station.demand, 0);
  const eligibleShare = userShare(targetUser);
  const previewDiscount = (amount) => {
    const responseRate = amount / (amount + 7);
    const switchRate = clamp((0.06 + responseRate * 0.32) * eligibleShare, 0, 0.38);
    const diverted = Math.min(pressureDemand * switchRate, targetSpare * 0.78);
    const remainingSpare = Math.max(0, targetSpare - diverted);
    const incremental = Math.min(totalDemand * clamp(0.015 + responseRate * 0.055, 0, 0.075), remainingSpare * 0.65);
    const acceptedOrders = diverted + incremental;
    const discountCost = acceptedOrders * amount;
    const incrementalGrossProfit = incremental * target.margin + diverted * target.margin * 0.35;
    return {
      responseRate,
      switchRate,
      diverted,
      incremental,
      acceptedOrders,
      discountCost,
      incrementalGrossProfit,
      roi: discountCost > 0 ? incrementalGrossProfit / discountCost : 0
    };
  };
  const outcome = previewDiscount(discount);
  const { responseRate, switchRate, diverted, incremental, acceptedOrders, discountCost, incrementalGrossProfit, roi } = outcome;
  const desiredDiversion = Math.min(Math.max(1, pressureDemand * 0.22), targetSpare * 0.78);
  const recommendedDiscount = Array.from({ length: 15 }, (_, index) => index + 1)
    .map((amount) => ({ amount, result: previewDiscount(amount) }))
    .find((candidate) => candidate.result.diverted >= desiredDiversion && candidate.result.roi >= 1)?.amount || 15;
  const movableDemand = sourceStations.reduce((sum, station) => sum + station.demand * clamp((station.occupancy - 0.56) / 0.38, 0, 1), 0);
  const after = baseStations.map((station) => {
    const demand = station.id === target.id
      ? station.demand + diverted + incremental
      : Math.max(0, station.demand - station.demand * clamp((station.occupancy - 0.56) / 0.38, 0, 1) / Math.max(movableDemand, 1) * diverted);
    const occupancy = clamp(station.occupancy + (demand - station.demand) / station.capacity * 0.22, 0.05, 0.99);
    const demandChangeRate = (demand - station.demand) / station.capacity;
    const wait = clamp(station.wait + demandChangeRate * 10 + (occupancy - station.occupancy) * 6, 0, 180);
    return {
      ...station,
      demand: Number(demand.toFixed(2)),
      occupancy: Number(occupancy.toFixed(3)),
      wait: Number(wait.toFixed(2)),
      p50: Number((wait * 0.82).toFixed(2)),
      p90: Number((wait * 1.65 + 3).toFixed(2)),
      status: wait * 1.65 + 3 >= 20 || occupancy >= 0.82 ? "forecast-risk" : "forecast-ready",
      riskLabel: wait * 1.65 + 3 >= 20 || occupancy >= 0.82 ? "高峰风险" : "策略后可用"
    };
  });
  const beforeMetrics = snapshot(baseStations);
  const afterMetrics = snapshot(after);
  return {
    targetStation: { id: target.id, name: target.name },
    targetUser: String(targetUser || "all").slice(0, 64),
    discountAmount: discount,
    recommendedDiscount,
    desiredDiversion: Number(desiredDiversion.toFixed(2)),
    before: beforeMetrics,
    after: afterMetrics,
    stations: after.map((station) => ({ ...station, changedDemand: Number((station.demand - (baseStations.find((item) => item.id === station.id)?.demand || 0)).toFixed(2)) })),
    impact: {
      divertedVehicles: Number(diverted.toFixed(2)),
      incrementalOrders: Number(incremental.toFixed(2)),
      acceptedOrders: Number(acceptedOrders.toFixed(2)),
      discountCost: Number(discountCost.toFixed(2)),
      incrementalGrossProfit: Number(incrementalGrossProfit.toFixed(2)),
      roi: Number(roi.toFixed(3)),
      switchRate: Number(switchRate.toFixed(4))
    },
    recommendation: afterMetrics.p90Wait <= beforeMetrics.p90Wait && afterMetrics.averageWait <= beforeMetrics.averageWait && afterMetrics.occupancyDispersion <= beforeMetrics.occupancyDispersion && roi >= 1
      ? "recommended"
      : afterMetrics.p90Wait <= beforeMetrics.p90Wait && afterMetrics.averageWait <= beforeMetrics.averageWait
        ? "operationally-effective"
        : "risk",
    assumptions: {
      description: "演示仿真：优惠敏感度、站点容量、服务率和当前负载共同决定分流结果，不代表能链实时经营数据。",
      eligibleShare: Number(eligibleShare.toFixed(3)),
      responseRate: Number(responseRate.toFixed(3))
    }
  };
}

export { normalizeStations, snapshot };
