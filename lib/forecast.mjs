const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function hash(value) {
  let result = 2166136261;
  for (const character of String(value || "station")) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function number(value, fallback, min = 0, max = Number.POSITIVE_INFINITY) {
  const result = Number(value);
  return Number.isFinite(result) ? clamp(result, min, max) : fallback;
}

function normalizeStation(station, index) {
  const seed = hash(`${station?.id || station?.name || "station"}-${index}`);
  const occupancy = number(station?.occupancy, 0.45 + (seed % 30) / 100, 0.05, 0.96);
  const wait = number(station?.wait ?? station?.p50, 5 + (seed % 8), 0, 120);
  const capacity = number(station?.capacity, 12 + (seed % 13), 1, 500);
  const arrivalRate = number(station?.arrivalRate, 1.2 + (seed % 20) / 10, 0, 100);
  const serviceRate = number(station?.serviceRate, 1.6 + (seed % 16) / 10, 0.1, 100);
  const trend = number(station?.trend, ((seed % 9) - 4) / 1000, -0.02, 0.02);
  return {
    id: String(station?.id || `station-${index}`),
    name: String(station?.name || `补能站 ${index + 1}`).slice(0, 100),
    type: String(station?.type || "充电站").slice(0, 30),
    location: station?.location ?? null,
    address: String(station?.address || "").slice(0, 160),
    source: String(station?.source || "演示输入").slice(0, 80),
    price: number(station?.price, 0, 0, 1000),
    detour: number(station?.detour, 0, 0, 1000),
    occupancy,
    wait,
    capacity,
    arrivalRate,
    serviceRate,
    trend,
    seed
  };
}

export function forecastStations(stations = [], scenario = {}) {
  const safeStations = Array.isArray(stations) ? stations.slice(0, 200).map(normalizeStation) : [];
  const scenarioFactor = number(scenario?.demandFactor, 1, 0.5, 2);
  const trafficFactor = number(scenario?.trafficFactor, 1, 0.7, 1.5);
  const points = Array.from({ length: 7 }, (_, index) => index * 5);
  return {
    horizonMinutes: 30,
    intervalMinutes: 5,
    model: "可解释队列近似：当前占用率 + 到达率 - 服务率 + 时段/路况因子",
    scenario: { demandFactor: scenarioFactor, trafficFactor },
    stations: safeStations.map((station) => {
      const forecast = points.map((minute) => {
        const timeFactor = 1 + Math.sin((station.seed % 31 + minute) / 18) * 0.04;
        const netFlow = (station.arrivalRate * scenarioFactor * trafficFactor * timeFactor - station.serviceRate) / station.capacity;
        const occupancy = clamp(station.occupancy + station.trend * minute + netFlow * minute * 0.16, 0.05, 0.99);
        const wait = clamp(station.wait * (0.72 + occupancy * 0.7) + Math.max(0, occupancy - 0.75) * 34, 0, 180);
        const p50 = wait * 0.82;
        const p90 = wait * 1.68 + 3;
        return {
          minute,
          occupancy: Number(occupancy.toFixed(3)),
          wait: Number(wait.toFixed(1)),
          p50: Number(p50.toFixed(1)),
          p90: Number(p90.toFixed(1)),
          arrivalRate: Number((station.arrivalRate * scenarioFactor * timeFactor).toFixed(2)),
          serviceRate: Number(station.serviceRate.toFixed(2)),
          risk: p90 >= 20 || occupancy >= 0.82 ? "forecast-risk" : "forecast-ready"
        };
      });
      return {
        id: station.id,
        name: station.name,
        type: station.type,
        location: station.location,
        address: station.address,
        source: station.source,
        price: station.price,
        detour: station.detour,
        baseline: forecast[0],
        forecast,
        explanation: `按当前占用率、每 5 分钟到达率 ${station.arrivalRate.toFixed(1)}、服务率 ${station.serviceRate.toFixed(1)} 估计，不代表能链实时经营数据。`
      };
    })
  };
}

export { hash };
