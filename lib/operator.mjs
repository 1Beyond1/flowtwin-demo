import { waitToP50, waitToP90, p90ToWait, WAIT_P90_OFFSET } from "./forecast.mjs";

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

// 人群标签决定"有多少人真的会为一张券改变行为"。原来是三条 if 顺流而下，
// "新能源长途用户"会先撞上 /长途/ 拿到 0.62，永远轮不到 /电车/ 的 0.74——
// 命中顺序而不是文本本身决定了结果。改成全部匹配后取最低值：同时属于多个
// 人群时，用最保守的那个响应率，宁可低估分流效果也不要高估。
const USER_SEGMENTS = [
  { pattern: /价格|省钱|优惠|折扣/, share: 0.82, label: "价格敏感" },
  { pattern: /电车|新能源|纯电/, share: 0.74, label: "新能源车主" },
  { pattern: /长途|跨城|出行/, share: 0.62, label: "长途出行" }
];

// 界面上的人群其实是四个固定选项，用正则去猜它们自己的中文标签是反着来的：
// "准时敏感 · 高峰出行"会因为一个"敏感"字被判成"价格敏感 0.82"，而准时敏感
// 恰恰是最不肯为一张券绕路的人；"低电量 · SOC 低于 25%"一条都命中不了，
// 悄悄退回 0.68 的兜底值。所以固定选项按稳定的 id 直接查表，正则只留给
// 外部调用方传进来的自由文本。响应率是演示假设，不是实测值。
const SEGMENT_BY_ID = {
  // 可接受绕行是这个人群的定义本身，对券值最敏感。
  "price-sensitive": { share: 0.82, label: "价格敏感" },
  // 高峰赶时间：绕行的时间成本远高于券面价值，只有少数人会改站。
  "time-sensitive": { share: 0.35, label: "准时敏感" },
  // 低电量必须尽快补能，改站意愿高，但真正的约束是能不能安全开到。
  "low-soc": { share: 0.71, label: "低电量" },
  all: { share: 0.68, label: "全部用户" }
};

function userSegment(targetUser, segmentId) {
  const id = String(segmentId || "").slice(0, 32);
  if (SEGMENT_BY_ID[id]) return { ...SEGMENT_BY_ID[id], matched: true, source: "segment-id" };
  const value = String(targetUser || "all").slice(0, 64);
  const matched = USER_SEGMENTS.filter((segment) => segment.pattern.test(value));
  if (!matched.length) return { share: 0.68, label: "全部用户", matched: false, source: "default" };
  const pick = matched.reduce((lowest, segment) => segment.share < lowest.share ? segment : lowest);
  return {
    share: pick.share,
    label: matched.map((segment) => segment.label).join("+"),
    matched: true,
    source: "text-match"
  };
}

// 排队论的基本事实：等待时间不是负载的线性函数，ρ→1 时会发散。用 1/(1-ρ)
// 的形状，"把车从 92% 的站挪到 60% 的站"才有它应有的价值——线性模型会把
// 这次调度算得几乎毫无意义，而那恰恰是这个产品要证明的事情。
function congestionFactor(occupancy) {
  return 1 / Math.max(0.08, 1 - clamp(occupancy, 0, 0.97));
}

// 拥堵到一定程度，用户会放弃排队掉头就走。这部分流失是"把车引导到空闲站点"
// 真正创造的价值来源，也是下面 ROI 口径的依据。
function abandonRate(occupancy) {
  return clamp((occupancy - 0.7) / 0.3, 0, 1) * 0.35;
}

// 需求加权的真 90 分位：按等待时长排序后累计需求，找到 90% 的车辆落在哪个
// 等待水平以内。原来这里取的是"最差站点的等待"，那是最大值不是分位数，
// 一个站就能主导整张网的指标，而且和同一个函数里需求加权的 averageWait
// 口径不一致。lib/validate.mjs 早就用的是真分位数。
function demandWeightedQuantile(stations, field, probability) {
  const totalDemand = stations.reduce((sum, station) => sum + station.demand, 0);
  if (!stations.length) return 0;
  if (totalDemand <= 0) {
    const values = stations.map((station) => station[field]).sort((a, b) => a - b);
    return values[Math.min(values.length - 1, Math.floor((values.length - 1) * probability))];
  }
  const sorted = stations.slice().sort((a, b) => a[field] - b[field]);
  const threshold = totalDemand * probability;
  let cumulative = 0;
  for (const station of sorted) {
    cumulative += station.demand;
    if (cumulative >= threshold) return station[field];
  }
  return sorted[sorted.length - 1][field];
}

function normalizeStations(stations) {
  return (Array.isArray(stations) ? stations : []).slice(0, 200).map((station, index) => {
    const seed = hash(`${station?.id || station?.name || "station"}-${index}`);
    const capacity = asNumber(station?.capacity, 14 + seed % 12, 1, 500);
    const occupancy = asNumber(station?.occupancy, 0.42 + seed % 42 / 100, 0.05, 0.97);
    const demand = asNumber(station?.demand ?? station?.arrivalRate, capacity * (0.35 + occupancy * 0.5), 0, capacity * 4);
    const serviceRate = asNumber(station?.serviceRate, capacity * 0.19, 0.1, capacity * 2);
    // 前端其实每站都送了 p90，只是这里从来不看它，于是等待时间被 occupancy
    // 重新编了一遍。结果是 renderOperatorFlow 按真实 p90 挑"拥堵站"，模型却按
    // 自己造的 wait 算后果——箭头图指着 A 站，底下那排数字说的却是 B 站。
    // p90ToWait 是这个模型自己的口径（与 forecast.mjs 共用同一组系数），直接反解
    // 回去，模型和界面至少排在同一个序上。三个字段都没有时才退回 occupancy 的经验式。
    const p90Wait = asNumber(station?.p90, NaN, 0, 300);
    const waitFromP90 = Number.isFinite(p90Wait) && p90Wait > WAIT_P90_OFFSET ? p90ToWait(p90Wait) : NaN;
    const waitFallback = Number.isFinite(waitFromP90) ? waitFromP90 : 4 + occupancy * 18;
    const wait = asNumber(station?.wait ?? station?.p50, waitFallback, 0, 180);
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

// 排队人数以前写的是 demand - serviceRate，而这两个量根本不在一个口径上：
// 承接站的"空余容量"按 capacity * 0.82 - demand 算，排队却按 serviceRate 算，
// 而 serviceRate 的默认值只有 capacity * 0.19、demand 的默认值约 capacity * 0.6。
// 于是每个站都背着一条凭空产生的常驻队伍，而且往"有空余容量"的站分流，反而
// 会把这个指标顶上去——面板最显眼的"峰值排队"永远朝反方向走。
// 改用利特尔法则 L = λW：排队人数 = 到达率 × 等待时间，两个量都是这个模型
// 自己算得自洽的（wait 已经由 congestionFactor 驱动）。demand 是 30 分钟窗口
// 内的到达量，wait 是分钟，所以除以 30 换成同一时间基准。
const WINDOW_MINUTES = 30;

function queueLength(station) {
  return Math.max(0, station.demand * (station.wait / WINDOW_MINUTES));
}

function snapshot(stations) {
  const totalDemand = stations.reduce((sum, station) => sum + station.demand, 0);
  const weighted = (field) => stations.reduce((sum, station) => sum + station[field] * station.demand, 0) / Math.max(totalDemand, 1);
  const averageOccupancy = weighted("occupancy");
  const variance = stations.reduce((sum, station) => sum + Math.pow(station.occupancy - averageOccupancy, 2), 0) / Math.max(1, stations.length);
  return {
    totalDemand: Number(totalDemand.toFixed(2)),
    averageWait: Number(weighted("wait").toFixed(2)),
    p90Wait: Number(demandWeightedQuantile(stations, "wait", 0.9).toFixed(2)),
    averageOccupancy: Number(averageOccupancy.toFixed(3)),
    occupancyDispersion: Number(Math.sqrt(variance).toFixed(3)),
    peakQueue: Number(Math.max(...stations.map(queueLength), 0).toFixed(2))
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
  // targetSegment 是界面固定选项的稳定 id；targetUser 是给人看的中文标签，
  // 也是外部调用方唯一会传的东西，所以两个都收。
  const segment = userSegment(targetUser, input.targetSegment ?? input.segmentId);
  const eligibleShare = segment.share;
  // 被分流的车原本就要在网内某个站补能，只是换了个站。对一个网络运营商来说
  // 这是营收搬家，不是新增营收——原来按 35% 毛利率把它记成"新增毛利"，等于
  // 把左口袋的钱掏到右口袋再算一次利润，而优惠成本却是按全部订单实打实付的。
  // 真正被创造出来的价值只有两块：一是被券拉来的增量订单，二是原本会因为
  // 排队太长而放弃、现在被空闲站点接住的那部分需求。
  const sourceAbandonRate = pressureDemand > 0
    ? sourceStations.reduce((sum, station) => sum + station.demand * clamp((station.occupancy - 0.56) / 0.38, 0, 1) * abandonRate(station.occupancy), 0) / pressureDemand
    : 0;
  const previewDiscount = (amount) => {
    const responseRate = amount / (amount + 7);
    const switchRate = clamp((0.06 + responseRate * 0.32) * eligibleShare, 0, 0.38);
    const diverted = Math.min(pressureDemand * switchRate, targetSpare * 0.78);
    const remainingSpare = Math.max(0, targetSpare - diverted);
    const incremental = Math.min(totalDemand * clamp(0.015 + responseRate * 0.055, 0, 0.075), remainingSpare * 0.65);
    const acceptedOrders = diverted + incremental;
    const discountCost = acceptedOrders * amount;
    // 承接站接下这些车之后自己的拥堵水平，决定了"救回来"的部分能留住多少。
    const targetOccupancyAfter = clamp(target.occupancy + (diverted + incremental) / Math.max(1, target.capacity) * 0.22, 0.05, 0.99);
    const retained = Math.max(0, diverted * (sourceAbandonRate - abandonRate(targetOccupancyAfter)));
    const newVolumeGrossProfit = incremental * target.margin;
    const retainedGrossProfit = retained * target.margin;
    const incrementalGrossProfit = newVolumeGrossProfit + retainedGrossProfit;
    return {
      responseRate,
      switchRate,
      diverted,
      incremental,
      retained,
      newVolumeGrossProfit,
      retainedGrossProfit,
      acceptedOrders,
      discountCost,
      incrementalGrossProfit,
      roi: discountCost > 0 ? incrementalGrossProfit / discountCost : 0
    };
  };
  const outcome = previewDiscount(discount);
  const { responseRate, switchRate, diverted, incremental, retained, newVolumeGrossProfit, retainedGrossProfit, acceptedOrders, discountCost, incrementalGrossProfit, roi } = outcome;
  // diverted 的物理上限就是 targetSpare * 0.78（承接站再空也只能吃下这么多），
  // 而原来的"目标分流量"取的正是这个上限本身，于是 diverted >= desiredDiversion
  // 只有在极限意义上才成立，而且到那时 ROI 早就跌破 1 了。结果是这个筛选条件
  // 从来没有真正选中过任何一档，`|| 15` 兜底值才是唯一的输出——推荐的永远是
  // 搜索区间里最贵、也最亏的那一档。
  const diversionCeiling = targetSpare * 0.78;
  // 目标分流量按拥堵侧的实际压力算，不再夹到承接站容量上：夹过之后目标恒等于
  // 上限，而 diverted 只能渐近逼近上限，于是"是否达标"永远是否——一个永远
  // 报失败的指标，读起来像是"券给得不够"，实际说的是"承接站装不下"。这两件事
  // 对应的处置完全不同（加码 vs 换站/扩容），必须分开报。
  const desiredDiversion = Math.max(1, pressureDemand * 0.22);
  const capacityBound = desiredDiversion > diversionCeiling;
  // 搜索区间跟着实际可设的优惠走（上限 100），否则用户把券设到 ¥20 时，
  // 推荐值永远停在 ¥15，没法和当前设置比较。
  const searchCeiling = Math.max(15, Math.ceil(discount));
  const candidateDiscounts = Array.from({ length: searchCeiling }, (_, index) => index + 1)
    .map((amount) => ({ amount, result: previewDiscount(amount) }));
  // 改成一个明确的最优化问题：在不亏本（ROI ≥ 1）的前提下，尽可能多地缓解
  // 拥堵；同样分流量时取更便宜的那档。一档都不盈利就如实返回 null。
  const profitable = candidateDiscounts.filter((candidate) => candidate.result.roi >= 1);
  const recommendedCandidate = profitable.length
    ? profitable.reduce((best, candidate) => candidate.result.diverted > best.result.diverted + 1e-9 ? candidate : best)
    : null;
  const recommendedDiscount = recommendedCandidate?.amount ?? null;
  const recommendedDiversion = recommendedCandidate ? recommendedCandidate.result.diverted : 0;
  const movableDemand = sourceStations.reduce((sum, station) => sum + station.demand * clamp((station.occupancy - 0.56) / 0.38, 0, 1), 0);
  const after = baseStations.map((station) => {
    const demand = station.id === target.id
      ? station.demand + diverted + incremental
      : Math.max(0, station.demand - station.demand * clamp((station.occupancy - 0.56) / 0.38, 0, 1) / Math.max(movableDemand, 1) * diverted);
    const occupancy = clamp(station.occupancy + (demand - station.demand) / station.capacity * 0.22, 0.05, 0.99);
    // 等待时间只跟负载走，而且是凸的。原来写的是
    //   wait + demandChangeRate * 10 + (occupancy - station.occupancy) * 6
    // 而 occupancy - station.occupancy 恒等于 demandChangeRate * 0.22，
    // 于是第二项只是第一项的 13% 复读——同一个量借着代理变量被算了两次，
    // 既说不清模型到底认为一辆车值多少等待，也把拥堵的非线性抹平了。
    const wait = clamp(station.wait * congestionFactor(occupancy) / congestionFactor(station.occupancy), 0, 180);
    const p90 = waitToP90(wait);
    const atRisk = p90 >= 20 || occupancy >= 0.82;
    return {
      ...station,
      demand: Number(demand.toFixed(2)),
      occupancy: Number(occupancy.toFixed(3)),
      wait: Number(wait.toFixed(2)),
      p50: Number(waitToP50(wait).toFixed(2)),
      p90: Number(p90.toFixed(2)),
      status: atRisk ? "forecast-risk" : "forecast-ready",
      riskLabel: atRisk ? "高峰风险" : "策略后可用"
    };
  });
  const beforeMetrics = snapshot(baseStations);
  const afterMetrics = snapshot(after);
  return {
    targetStation: { id: target.id, name: target.name },
    targetUser: String(targetUser || "all").slice(0, 64),
    discountAmount: discount,
    recommendedDiscount,
    // 推荐值本身也要可审计：它能分流多少、够不够到目标、以及"没有推荐值"
    // 时到底是因为一档都不盈利，而不是因为算不出来。
    recommendedBasis: recommendedCandidate
      ? {
        diverted: Number(recommendedDiversion.toFixed(2)),
        roi: Number(recommendedCandidate.result.roi.toFixed(3)),
        meetsDesiredDiversion: recommendedDiversion >= Math.min(desiredDiversion, diversionCeiling) - 1e-9,
        rule: "在 ROI ≥ 1 的档位中取分流量最大者"
      }
      : { diverted: 0, roi: 0, meetsDesiredDiversion: false, rule: "当前负载与毛利结构下，没有任何券值能同时做到不亏本，故不给出推荐值" },
    desiredDiversion: Number(desiredDiversion.toFixed(2)),
    diversionCeiling: Number(diversionCeiling.toFixed(2)),
    // 目标高于上限时，缺口不是优惠力度问题，而是承接站没有那么多空位。
    capacityBound,
    unservedPressure: Number(Math.max(0, desiredDiversion - diversionCeiling).toFixed(2)),
    before: beforeMetrics,
    after: afterMetrics,
    stations: after.map((station) => ({ ...station, changedDemand: Number((station.demand - (baseStations.find((item) => item.id === station.id)?.demand || 0)).toFixed(2)) })),
    impact: {
      divertedVehicles: Number(diverted.toFixed(2)),
      incrementalOrders: Number(incremental.toFixed(2)),
      // 分流量里真正"救回来"的部分：原本会因排队放弃、现在被承接站接住。
      // ROI 分子只认这一块加上增量订单，不把网内搬家算成新增毛利。
      retainedOrders: Number(retained.toFixed(2)),
      newVolumeGrossProfit: Number(newVolumeGrossProfit.toFixed(2)),
      retainedGrossProfit: Number(retainedGrossProfit.toFixed(2)),
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
      responseRate: Number(responseRate.toFixed(3)),
      userSegment: segment.label,
      // 文本没命中任何人群标签时用的是 0.68 的兜底值，得说出来，
      // 否则界面上那个精确到小数点后三位的响应率会显得像是识别出来的。
      userSegmentMatched: segment.matched,
      // segment-id：界面固定选项直接查表；text-match：对自由文本做的关键词
      // 匹配，可能过宽；default：什么都没命中，用的是全体均值。
      userSegmentSource: segment.source,
      roiBasis: "ROI 分子只计增量订单毛利与挽回流失毛利；站点间的需求转移属网内搬家，不计为新增毛利。",
      waitModel: "等待时间按 1/(1-负载) 的拥堵因子缩放，负载趋近饱和时非线性上升。",
      // 分位数取在"站点平均等待"这个量上，不是单车等待——写清楚口径，
      // 否则这个数会被当成"90% 的车等待不超过它"，那需要站内排队分布。
      p90Basis: "P90 为需求加权的 90 分位站点等待（90% 的到站车辆，其所在站点的平均等待不超过该值），非最差站点值。"
    }
  };
}

export { normalizeStations, snapshot };
