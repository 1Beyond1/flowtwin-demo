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

function serviceMinutesFor(station = {}) {
  const explicit = Number(station?.serviceMinutes ?? station?.averageSessionMinutes ?? station?.chargeMinutes);
  if (Number.isFinite(explicit)) return clamp(explicit, 1, 240);
  return /油|燃油|fuel/i.test(String(station?.type || "")) ? 8 : 35;
}

function paymentExitMinutesFor(station = {}) {
  const explicit = Number(station?.paymentExitMinutes ?? station?.paymentExitBufferMinutes);
  if (Number.isFinite(explicit)) return clamp(explicit, 1, 15);
  return /油|燃油|fuel/i.test(String(station?.type || "")) ? 3 : 5;
}

function stationTemplates(stations) {
  if (!Array.isArray(stations) || !stations.length) return null;
  return stations.slice(0, 20).map((station, index) => ({
    id: String(station?.id || `s${index + 1}`),
    type: String(station?.type || "充电站"),
    distance: number(station?.detour ?? (Number(station?.distance) > 100 ? Number(station.distance) / 1000 : station?.distance), 2 + index * 1.4, 0.1, 80),
    baseWait: number(station?.wait ?? station?.p50, 5 + index, 0, 180),
    serviceMinutes: serviceMinutesFor(station),
    paymentExitMinutes: paymentExitMinutesFor(station),
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
    type: "充电站",
    distance: 2 + random() * 16,
    baseWait: 2 + random() * 18,
    serviceMinutes: 35,
    paymentExitMinutes: 5,
    price: 0.85 + random() * 0.95,
    capacity: 12 + random() * 18,
    load: 0.25 + random() * 0.6,
    reliability: 0.72 + random() * 0.27,
    margin: 10 + random() * 8
  }));
  return Array.from({ length: count }, (_, tripIndex) => {
    const stations = templates.map((template) => {
      const reliability = clamp(template.reliability * (0.96 + random() * 0.05), 0.5, 0.999);
      // 尾部风险最大能到 26 分钟，是这个实验里最大的一项。原来 FlowTwin 的
      // 打分函数直接读 (1-reliability)*52，而结算时的实际等待加的也是同一个
      // 数——它不是在预测，是在看答案。准点率 68%→93% 主要就是这么来的。
      // 改成带误差的估计：FlowTwin 看到的是 ±30% 的预测值，实际发生的是
      // tail。赢多少算多少，赢的部分才是模型真本事。
      const tail = (1 - reliability) * 52;
      return {
        ...template,
        distance: clamp(template.distance * (0.85 + random() * 0.3), 0.1, 100),
        baseWait: clamp(template.baseWait * (0.75 + random() * 0.5), 0, 180),
        serviceMinutes: clamp(template.serviceMinutes * (0.9 + random() * 0.2), 1, 240),
        price: clamp(template.price * (0.96 + random() * 0.08), 0.1, 100),
        reliability,
        tail,
        tailEstimate: clamp(tail * (0.7 + random() * 0.6), 0, 60)
      };
    });
    return {
      id: tripIndex,
      // Include genuinely tight schedules so the on-time metric remains discriminative.
      deadline: 18 + random() * 42,
      stations
    };
  });
}

function choose(strategy, stations, loads, allocations, deadline) {
  const queueAt = (station, index) => station.baseWait + loads[index] / station.capacity * 14;
  const predictedStopMinutes = (station, index, tail = 0) => queueAt(station, index) + station.serviceMinutes + station.paymentExitMinutes + tail;
  if (strategy === "flowtwin") {
    const scored = stations.map((station, index) => {
      // tailEstimate 是带误差的预测值；真实值 station.tail 只在结算时使用。
      const predictedStop = predictedStopMinutes(station, index, station.tailEstimate ?? (1 - station.reliability) * 52);
      const deadlineRisk = station.distance * 2.7 + predictedStop > deadline ? 36 : 0;
      return {
        index,
        base: predictedStop * 0.72 + station.distance * 0.18 + station.price * 2.2 + deadlineRisk,
        allocationPressure: allocations[index] / station.capacity
      };
    });
    const bestBase = Math.min(...scored.map((item) => item.base));
    const candidates = scored.filter((item) => item.base <= bestBase + 1.5);
    return candidates.sort((a, b) => a.allocationPressure - b.allocationPressure || a.base - b.base)[0].index;
  }
  const score = (station, index) => {
    const stop = predictedStopMinutes(station, index);
    if (strategy === "nearest") return station.distance;
    if (strategy === "cheapest") return station.price;
    if (strategy === "realtime") return stop + station.distance * 0.35;
    return stop;
  };
  return stations.reduce((best, station, index) => score(station, index) < score(stations[best], best) ? index : best, 0);
}

// 分流券面额（元/单）。只在把司机劝离他本来会去的站点时才发放。
const DIVERSION_DISCOUNT = 4.5;

function runStrategy(scenarios, strategy) {
  const waits = [];
  const stopTimes = [];
  const onTime = [];
  const loads = Array(scenarios[0]?.stations?.length || 8).fill(0);
  const allocations = Array(scenarios[0]?.stations?.length || 8).fill(0);
  let discountCost = 0;
  let divertedTrips = 0;
  let compensatedTrips = 0;
  const realisedQueue = (station, index) => station.baseWait + loads[index] / station.capacity * 14 + (station.tail ?? (1 - station.reliability) * 52);
  const realisedStop = (station, index) => realisedQueue(station, index) + station.serviceMinutes + station.paymentExitMinutes;
  for (const scenario of scenarios) {
    loads.forEach((load, index) => { loads[index] = Math.max(0, load * 0.9 - 0.12); });
    const index = choose(strategy, scenario.stations, loads, allocations, scenario.deadline);
    const station = scenario.stations[index];
    const queue = realisedQueue(station, index);
    const totalStopMinutes = queue + station.serviceMinutes + station.paymentExitMinutes;
    const totalMinutes = station.distance * 2.7 + totalStopMinutes;
    const arrivedOnTime = totalMinutes <= scenario.deadline;
    if (strategy === "flowtwin") {
      // 原来这里对每一单都记 margin*0.3 的毛利和 4.5*0.3 的券成本，0.3 在
      // 相除时整个约掉，ROI 恒等于 mean(margin)/4.5——换种子、换样本量都只在
      // 3.1~3.3 之间，跟策略选得好不好毫无关系。而且券根本没进 choose()，
      // 它不改变任何决策，却被拿来算收益，等于凭空造了一个实验结论。
      // 现在只算成本：先求司机自己会去哪（realtime 口径，考虑排队、补能服务、
      // 支付驶离和距离），
      // 推荐与之不同就是一次分流；但真正要发券的只有"让他多花时间"的那部分——
      // 更快的站点不需要拿钱哄人去。收益是系统级的，放到 validateStrategies 里算。
      const spontaneous = choose("realtime", scenario.stations, loads, allocations, scenario.deadline);
      if (spontaneous !== index) {
        divertedTrips += 1;
        const alternative = scenario.stations[spontaneous];
        if (totalMinutes > alternative.distance * 2.7 + realisedStop(alternative, spontaneous)) {
          compensatedTrips += 1;
          discountCost += DIVERSION_DISCOUNT;
        }
      }
    }
    loads[index] += 1;
    allocations[index] += 1;
    waits.push(queue);
    stopTimes.push(totalStopMinutes);
    onTime.push(arrivedOnTime ? 1 : 0);
  }
  // 原来这里报的是利用率的标准差，而它随行程数线性放大：同一套站点跑
  // 1000 次是 4.34，跑 8000 次是 34.6。样本量一改，"负载均衡"看起来就崩了。
  // 改用变异系数（标准差/均值），量纲抵消，样本量和站点数都不影响。
  const utilisation = allocations.map((value, index) => value / scenarios[0].stations[index].capacity);
  const utilisationMean = mean(utilisation);
  return {
    strategy,
    trips: scenarios.length,
    averageWait: Number(mean(waits).toFixed(2)),
    p90Wait: Number(quantile(waits, 0.9).toFixed(2)),
    averageStopMinutes: Number(mean(stopTimes).toFixed(2)),
    p90StopMinutes: Number(quantile(stopTimes, 0.9).toFixed(2)),
    onTimeRate: Number((mean(onTime) * 100).toFixed(2)),
    loadDispersion: Number((utilisationMean ? std(utilisation) / utilisationMean : 0).toFixed(3)),
    roi: 0,
    grossProfit: 0,
    discountCost: Number(discountCost.toFixed(2)),
    divertedTrips,
    compensatedTrips
  };
}

export function validateStrategies({ seed = 20260719, trips = 1000, stations = null } = {}) {
  const count = Math.max(1000, Math.min(10000, Number(trips) || 1000));
  const templates = stationTemplates(stations);
  const scenarios = createScenarios(Number(seed) || 20260719, count, stations);
  const results = Object.fromEntries(STRATEGIES.map((strategy) => [strategy, runStrategy(scenarios, strategy)]));
  // 分流券买到的东西是系统级的：被劝走的那位司机自己多等了，收益落在他让出
  // 的车位上——后面那些人少排了队。所以 ROI 不能按单归因，只能拿整轮
  // FlowTwin 和整轮 realtime（用户不被干预时的自发选择）对比：多出来的准点单
  // 是收益，券的总支出是成本。
  const meanMargin = mean(scenarios[0]?.stations?.map((station) => station.margin) || [0]);
  const flowtwin = results.flowtwin;
  const baseline = results.realtime;
  const savedTrips = Math.round((flowtwin.onTimeRate - baseline.onTimeRate) / 100 * count);
  const grossProfit = savedTrips * meanMargin;
  flowtwin.savedTrips = savedTrips;
  flowtwin.grossProfit = Number(grossProfit.toFixed(2));
  flowtwin.roi = Number((flowtwin.discountCost ? grossProfit / flowtwin.discountCost : 0).toFixed(3));
  return {
    seed: Number(seed) || 20260719,
    trips: count,
    inputMode: templates ? "current-stations" : "synthetic-stations",
    stationCount: scenarios[0]?.stations?.length || 0,
    stationTemplates: templates || [],
    strategies: results,
    metricDefinitions: {
      averageWait: "所有行程到站前实际排队时间的平均值（分钟），不含补能服务和支付驶离",
      p90Wait: "排队时间的 90 分位数（分钟），不含补能服务和支付驶离",
      averageStopMinutes: "排队 + 补能服务 + 支付驶离缓冲的平均补能停靠耗时（分钟）",
      p90StopMinutes: "补能停靠耗时的 90 分位数（分钟）",
      onTimeRate: "路线行驶时间加排队、补能服务和支付驶离缓冲不超过用户时限的比例",
      loadDispersion: "各站点最终利用率（分配量/容量）的变异系数，标准差除以均值，与样本量和站点数无关，越低越均衡",
      roi: "整轮 FlowTwin 相对整轮 realtime 多出的准点单毛利 / 券的总支出；系统级口径，不按单归因，非 FlowTwin 策略不发券因此为 0",
      divertedTrips: "FlowTwin 的推荐与用户自发选择（考虑排队、补能服务、支付驶离和距离）不一致的行程数",
      compensatedTrips: "分流之后用户实际总耗时反而变长、因而需要发券补偿的行程数；推荐更快站点时不发券",
      savedTrips: "相对 realtime 基线多出来的准点行程数（准点率差 × 样本量）"
    },
    methodology: {
      scenarioGeneration: {
        distanceMultiplier: "每次行程按基础距离乘以 0.85–1.15",
        waitMultiplier: "每次行程按基础排队乘以 0.75–1.25",
        serviceMultiplier: "每次行程按基础补能服务时长乘以 0.9–1.1",
        priceMultiplier: "每次行程按基础价格乘以 0.96–1.04",
        deadlineMinutes: "每次行程生成 18–60 分钟的到达时限",
        tailEstimate: "尾部风险真值为 (1−可靠度)×52 分钟；FlowTwin 只拿到它 0.7–1.3 倍的带误差预测值，结算按真值，预测错了自己承担"
      },
      formulas: {
        queue: "基础排队 + 当前分配负载 / 站点容量 × 14 + 尾部风险真值",
        stopMinutes: "实际排队 + 补能服务时长 + 支付驶离缓冲",
        totalMinutes: "站点距离 × 2.7 + 补能停靠耗时",
        flowTwinScore: "0.72 ×（排队 + 补能服务 + 支付驶离缓冲 + 尾部风险预测值）+ 0.18 × 距离 + 2.2 × 价格 + 到达时限风险；近似同分时优先分配压力更低的站点",
        roi: "券成本 = 4.5 元 × 需补偿单数；毛利 = (FlowTwin 准点率 − realtime 准点率) × 样本量 × 站点平均毛利"
      },
      strategies: {
        nearest: "仅按距离最短选站",
        cheapest: "仅按价格最低选站",
        realtime: "按补能停靠耗时 + 距离加权选站；也用作 FlowTwin 的反事实基线（用户不被干预时的自发选择）",
        flowtwin: "综合队列、尾部风险预测、时限、距离、价格和站点分配压力选站"
      }
    },
    assumptions: "固定种子合成出行样本，仅用于可复现的策略对比，不代表能链真实经营数据。四个策略跑在同一批行程和同一套站点上；尾部风险对 FlowTwin 也只是带误差的预测值，不是已知答案。"
  };
}

export { createScenarios, runStrategy };
