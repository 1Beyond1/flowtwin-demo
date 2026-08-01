const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// 等待时间分位数的形状参数。p50/p90 都由同一个 wait 派生，而 operator.mjs 还要
// 反着来——把前端送过来的 p90 还原成模型口径的 wait。这里原本写 1.68、运营端写
// 1.65，同一个站点在预测页和运营页因此挂着两条不同的分布，反解时又按 1.65 去
// 解 1.68 生成的数。统一到一处，两边至少在说同一件事。
export const WAIT_P50_FACTOR = 0.82;
export const WAIT_P90_FACTOR = 1.65;
export const WAIT_P90_OFFSET = 3;
export const waitToP50 = (wait) => wait * WAIT_P50_FACTOR;
export const waitToP90 = (wait) => wait * WAIT_P90_FACTOR + WAIT_P90_OFFSET;
export const p90ToWait = (p90) => (p90 - WAIT_P90_OFFSET) / WAIT_P90_FACTOR;

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
  // 天气因子来自高德实况：雨雪天抬高峰值等待。缺省为 1（无影响），故不接天气时
  // 预测与原来完全一致。
  const weatherFactor = number(scenario?.weatherFactor, 1, 0.8, 1.5);
  const points = Array.from({ length: 7 }, (_, index) => index * 5);
  return {
    horizonMinutes: 30,
    intervalMinutes: 5,
    // 原来写的是"当前占用率 + 到达率 - 服务率 + 时段/路况因子"：漏掉了除以车位数
    // 这一步（同样的净流入，20 个车位的站和 5 个车位的站涨得完全不一样）、漏掉了
    // 站点自身的趋势项，也没提占用率 75% 以上那段额外的拥堵惩罚——而这三样恰好是
    // 模型里唯一有解释力的部分。照着代码重写。
    model: "可解释队列近似：占用率随 (到达率×时段路况天气因子 − 服务率)/车位数 与站点趋势项外推，等待随占用率线性上升，超 75% 后加拥堵惩罚",
    scenario: { demandFactor: scenarioFactor, trafficFactor, weatherFactor },
    stations: safeStations.map((station) => {
      const forecast = points.map((minute) => {
        const timeFactor = 1 + Math.sin((station.seed % 31 + minute) / 18) * 0.04;
        // 天气抬到达率（雨雪天更多人来充电），不碰服务率--服务能力本身没变，
        // 变的是需求侧。这样 P50/P90 会随天气单调上升，方向可解释。
        const netFlow = (station.arrivalRate * scenarioFactor * trafficFactor * weatherFactor * timeFactor - station.serviceRate) / station.capacity;
        const occupancy = clamp(station.occupancy + station.trend * minute + netFlow * minute * 0.16, 0.05, 0.99);
        const wait = clamp(station.wait * (0.72 + occupancy * 0.7) + Math.max(0, occupancy - 0.75) * 34, 0, 180);
        const p50 = waitToP50(wait);
        const p90 = waitToP90(wait);
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
        // 原来标的是"每 5 分钟到达率"。模型里 arrivalRate 是按分钟外推的
        // （netFlow×minute），5 分钟只是画图的取样间隔，不是速率的单位——把取样
        // 间隔写成速率单位，读数直接差 5 倍。同时补上占用率的实际数值，不然
        // "按当前占用率估计"这句话在界面上没有任何可核对的东西。
        explanation: `按当前占用率 ${(station.occupancy * 100).toFixed(0)}%、到达率 ${station.arrivalRate.toFixed(1)} 辆/分钟、服务率 ${station.serviceRate.toFixed(1)} 辆/分钟估计，不代表能链实时经营数据。`
      };
    })
  };
}

export { hash };
