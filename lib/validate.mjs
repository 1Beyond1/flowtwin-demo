const STRATEGIES = ["nearest", "cheapest", "realtime", "flowtwin"];

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function createRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function quantile(values, probability) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }

function std(values) {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => Math.pow(value - average, 2))));
}

function number(value, fallback, min = 0, max = Number.POSITIVE_INFINITY) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

function stationTemplates(stations) {
  if (!Array.isArray(stations) || !stations.length) return null;
  return stations.slice(0, 20).map((station, index) => ({
    id: String(station?.id || `s${index + 1}`),
    distance: number(station?.detour ?? (Number(station?.distance) > 100 ? Number(station.distance) / 1000 : station?.distance), 2 + index * 1.4, 0.1, 80),
    baseWait: number(station?.wait ?? station?.p50, 5 + index, 0, 180),
    price: number(station?.price, 1.2 + index * 0.08, 0.1, 100),
    capacity: number(station?.capacity, 14 + index * 2, 1, 500),
    load: number(station?.occupancy, 0.35 + index * 0.05, 0.05, 0.99),
    reliability: number(station?.reliability, 1 - number(station?.occupancy, 0.5, 0.05, 0.99) * 0.22, 0.5, 0.99),
    margin: number(station?.grossMargin, 12 + index, 0, 1000)
  }));
}

function createScenarios(seed, count, inputStations = null) {
  const random = createRandom(seed);
  const suppliedTemplates = stationTemplates(inputStations);
  const templates = suppliedTemplates || Array.from({ length: 30 }, (_, stationIndex) => ({
    id: `s${stationIndex + 1}`,
    distance: 2 + random() * 16,
    baseWait: 2 + random() * 18,
    price: 0.85 + random() * 0.95,
    capacity: 12 + random() * 18,
    load: 0.25 + random() * 0.6,
    reliability: 0.72 + random() * 0.27,
    margin: 10 + random() * 8
  }));
  return Array.from({ length: count }, (_, tripIndex) => {
    const stations = templates.map((template) => ({
      ...template,
      distance: clamp(template.distance * (0.85 + random() * 0.3), 0.1, 100),
      baseWait: clamp(template.baseWait * (0.75 + random() * 0.5), 0, 180),
      price: clamp(template.price * (0.96 + random() * 0.08), 0.1, 100),
      reliability: clamp(template.reliability * (0.96 + random() * 0.05), 0.5, 0.999)
    }));
    return {
      id: tripIndex,
      deadline: 45 + random() * 45,
      stations
    };
  });
}

function choose(strategy, stations, loads, allocations, deadline) {
  const queueAt = (station, index) => station.baseWait + loads[index] / station.capacity * 14;
  if (strategy === "flowtwin") {
    const scored = stations.map((station, index) => {
      const predictedTail = queueAt(station, index) + (1 - station.reliability) * 52;
      const deadlineRisk = station.distance * 2.7 + predictedTail > deadline ? 36 : 0;
      return {
        index,
        base: predictedTail * 0.72 + station.distance * 0.18 + station.price * 2.2 + deadlineRisk,
        allocationPressure: allocations[index] / station.capacity
      };
    });
    const bestBase = Math.min(...scored.map((item) => item.base));
    const candidates = scored.filter((item) => item.base <= bestBase + 1.5);
    return candidates.sort((a, b) => a.allocationPressure - b.allocationPressure || a.base - b.base)[0].index;
  }
  const score = (station, index) => {
    const queue = station.baseWait + loads[index] / station.capacity * 14;
    if (strategy === "nearest") return station.distance;
    if (strategy === "cheapest") return station.price;
    if (strategy === "realtime") return queue + station.distance * 0.35;
    return queue;
  };
  return stations.reduce((best, station, index) => score(station, index) < score(stations[best], best) ? index : best, 0);
}

function runStrategy(scenarios, strategy) {
  const waits = [];
  const onTime = [];
  const loads = Array(scenarios[0]?.stations?.length || 8).fill(0);
  const allocations = Array(scenarios[0]?.stations?.length || 8).fill(0);
  let grossProfit = 0;
  let discountCost = 0;
  for (const scenario of scenarios) {
    loads.forEach((load, index) => { loads[index] = Math.max(0, load * 0.9 - 0.12); });
    const index = choose(strategy, scenario.stations, loads, allocations, scenario.deadline);
    const station = scenario.stations[index];
    const predictableTail = (1 - station.reliability) * 52;
    const queue = station.baseWait + loads[index] / station.capacity * 14 + predictableTail;
    const totalMinutes = station.distance * 2.7 + queue;
    const discount = strategy === "flowtwin" ? 4.5 : 0;
    loads[index] += 1;
    allocations[index] += 1;
    waits.push(queue);
    onTime.push(totalMinutes <= scenario.deadline ? 1 : 0);
    if (strategy === "flowtwin") {
      grossProfit += station.margin * 0.3;
      discountCost += discount * 0.3;
    }
  }
  return {
    strategy,
    trips: scenarios.length,
    averageWait: Number(mean(waits).toFixed(2)),
    p90Wait: Number(quantile(waits, 0.9).toFixed(2)),
    onTimeRate: Number((mean(onTime) * 100).toFixed(2)),
    loadDispersion: Number(std(allocations.map((value, index) => value / scenarios[0].stations[index].capacity)).toFixed(3)),
    roi: Number((discountCost ? grossProfit / discountCost : 0).toFixed(3)),
    grossProfit: Number(grossProfit.toFixed(2)),
    discountCost: Number(discountCost.toFixed(2))
  };
}

export function validateStrategies({ seed = 20260719, trips = 1000, stations = null } = {}) {
  const count = Math.max(1000, Math.min(10000, Number(trips) || 1000));
  const templates = stationTemplates(stations);
  const scenarios = createScenarios(Number(seed) || 20260719, count, stations);
  const results = Object.fromEntries(STRATEGIES.map((strategy) => [strategy, runStrategy(scenarios, strategy)]));
  return {
    seed: Number(seed) || 20260719,
    trips: count,
    inputMode: templates ? "current-stations" : "synthetic-stations",
    stationCount: scenarios[0]?.stations?.length || 0,
    strategies: results,
    metricDefinitions: {
      averageWait: "所有行程到站前预计等待时间的平均值（分钟）",
      p90Wait: "等待时间的 90 分位数（分钟）",
      onTimeRate: "路线行驶时间加等待时间不超过用户时限的比例",
      loadDispersion: "输入站点最终分配量的标准差，越低越均衡",
      roi: "演示优惠带来的毛利 / 优惠成本；非 FlowTwin 策略不发券，因此为 0"
    },
    assumptions: "固定种子合成出行样本，仅用于方案对比，不代表能链真实经营数据。"
  };
}

export { createScenarios, runStrategy };
