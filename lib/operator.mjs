import { waitToP50, waitToP90, p90ToWait, WAIT_P90_OFFSET } from "./forecast.mjs";

const WINDOW_MINUTES = 30;
const CONTROL_FIELDS = ["partner", "controllable", "couponEligible", "merchantAccepted"];
const ECONOMIC_FIELDS = ["platformCoupon", "merchantCouponShare", "platformTakeRate", "platformVariableCost", "campaignBudget"];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function hash(value) {
  let result = 0;
  for (const character of String(value || "station")) result = (result * 31 + character.charCodeAt(0)) >>> 0;
  return result;
}

function asNumber(value, fallback, min = 0, max = Number.POSITIVE_INFINITY) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, min, max) : fallback;
}

function asShare(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return clamp(number > 1 && number <= 100 ? number / 100 : number, 0, 1);
}

function asBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") {
    if (["false", "0", "no", "n", "否"].includes(value.trim().toLowerCase())) return false;
    if (["true", "1", "yes", "y", "是"].includes(value.trim().toLowerCase())) return true;
  }
  return Boolean(value);
}

function firstDefined(value, keys) {
  for (const key of keys) {
    if (value?.[key] !== undefined && value?.[key] !== null) return value[key];
  }
  return undefined;
}

// 人群标签决定"有多少人真的会为一张券改变行为"。多个标签同时命中时取最保守
// 的响应率，宁可低估分流效果，也不要把自然语言标签的重叠当成额外转化。
const USER_SEGMENTS = [
  { pattern: /价格|省钱|优惠|折扣/, share: 0.82, label: "价格敏感" },
  { pattern: /电车|新能源|纯电/, share: 0.74, label: "新能源车主" },
  { pattern: /长途|跨城|出行/, share: 0.62, label: "长途出行" }
];

const SEGMENT_BY_ID = {
  "price-sensitive": { share: 0.82, label: "价格敏感" },
  "time-sensitive": { share: 0.35, label: "准时敏感" },
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

// 排队等待随负载呈凸增长，避免把 92% 的站点和 60% 的站点当成只差 32 个点。
function congestionFactor(occupancy) {
  return 1 / Math.max(0.08, 1 - clamp(occupancy, 0, 0.97));
}

function abandonRate(occupancy) {
  return clamp((occupancy - 0.7) / 0.3, 0, 1) * 0.35;
}

// 需求加权的真 90 分位：按等待时长排序后累计需求，而不是取最差站点。
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

function controlMetadataPresent(station) {
  return CONTROL_FIELDS.some((field) => hasOwn(station, field));
}

function controlState(station) {
  // 全部缺失时保留旧 API 的演示调用兼容；只要某站开始声明边界字段，
  // 该站缺失的其它字段就按未知处理，不能因为一个 partner=true 自动推断已接受券。
  const legacyDefaults = !controlMetadataPresent(station);
  const flags = Object.fromEntries(CONTROL_FIELDS.map((field) => [
    field,
    asBoolean(station?.[field], legacyDefaults ? true : false)
  ]));
  const reasons = [];
  for (const field of CONTROL_FIELDS) {
    if (!legacyDefaults && !hasOwn(station, field)) reasons.push(`${field}:missing`);
    else if (!flags[field]) reasons.push(`${field}:false`);
  }
  return {
    ...flags,
    controlMetadataPresent: !legacyDefaults,
    executionEligible: CONTROL_FIELDS.every((field) => flags[field]),
    navigationOnly: !CONTROL_FIELDS.every((field) => flags[field]),
    ineligibleReasons: reasons
  };
}

function windowCapacityValue(station, fallback) {
  return firstDefined(station, [
    "windowCapacity",
    "windowAcceptCapacity",
    "windowAcceptanceCapacity",
    "acceptanceCapacity",
    "availableCapacity",
    "arrivalCapacity"
  ]) ?? fallback;
}

function normalizeStations(stations, options = {}) {
  return (Array.isArray(stations) ? stations : []).slice(0, 200).map((station, index) => {
    const raw = station && typeof station === "object" ? station : {};
    const seed = hash(`${raw.id || raw.name || "station"}-${index}`);
    const capacity = asNumber(raw.capacity, 14 + seed % 12, 1, 500);
    const occupancy = asNumber(raw.occupancy, 0.42 + seed % 42 / 100, 0.05, 0.97);
    const demand = asNumber(raw.demand ?? raw.arrivalRate, capacity * (0.35 + occupancy * 0.5), 0, capacity * 4);
    const serviceRateProvided = hasOwn(raw, "serviceRate") || hasOwn(raw, "serviceCapacity");
    const serviceRate = asNumber(firstDefined(raw, ["serviceRate", "serviceCapacity"]), capacity * 0.19, 0.1, capacity * 2);
    const baselineServiceRate = Math.max(0.1, capacity * 0.19);
    const serviceFactor = clamp(serviceRate / baselineServiceRate, 0.1, 2);
    const p90Wait = asNumber(raw.p90, NaN, 0, 300);
    const waitFromP90 = Number.isFinite(p90Wait) && p90Wait > WAIT_P90_OFFSET ? p90ToWait(p90Wait) : NaN;
    const waitFallback = Number.isFinite(waitFromP90) ? waitFromP90 : 4 + occupancy * 18;
    const wait = asNumber(raw.wait ?? raw.p50, waitFallback, 0, 180);
    const priceProvided = hasOwn(raw, "price") || hasOwn(raw, "unitPrice");
    const price = asNumber(firstDefined(raw, ["price", "unitPrice"]), 1.2 + seed % 55 / 100, 0, 100);
    const orderValueProvided = ["orderValue", "averageOrderValue", "transactionValue"].some((field) => hasOwn(raw, field));
    const orderValue = asNumber(firstDefined(raw, ["orderValue", "averageOrderValue", "transactionValue"]), price * 20, 0, 100000);
    const marginProvided = hasOwn(raw, "grossMargin") || hasOwn(raw, "merchantMargin") || hasOwn(raw, "merchantContributionPerOrder");
    const margin = asNumber(firstDefined(raw, ["merchantContributionPerOrder", "merchantMargin", "grossMargin"]), orderValue * 0.35, 0, 10000);
    const rawWindowCapacity = windowCapacityValue(raw, capacity * 0.82);
    const windowCapacityProvided = [
      "windowCapacity", "windowAcceptCapacity", "windowAcceptanceCapacity", "acceptanceCapacity", "availableCapacity", "arrivalCapacity"
    ].some((field) => hasOwn(raw, field));
    const windowCapacity = asNumber(rawWindowCapacity, capacity * 0.82, 0, 10000);
    // 显式窗口容量是上限，服务率不足时只能进一步打折，服务率提升不能突破该上限。
    const effectiveWindowCapacity = Math.min(windowCapacity, windowCapacity * serviceFactor);
    const control = controlState(raw);
    const stationDataSource = String(raw.dataSource ?? raw.source ?? "演示输入").slice(0, 120);
    const asOf = raw.asOf == null ? null : String(raw.asOf).slice(0, 80);
    return {
      id: String(raw.id || `station-${index}`),
      name: String(raw.name || `补能站 ${index + 1}`).slice(0, 100),
      type: String(raw.type || "充电站").slice(0, 30),
      location: raw.location ?? null,
      address: String(raw.address || "").slice(0, 160),
      source: String(raw.source || stationDataSource).slice(0, 80),
      dataSource: stationDataSource,
      asOf,
      detour: asNumber(raw.detour, 0, 0, 1000),
      capacity,
      occupancy,
      demand,
      serviceRate,
      serviceRateProvided,
      serviceFactor,
      wait,
      margin,
      marginProvided,
      price,
      priceProvided,
      orderValue,
      orderValueProvided,
      windowCapacity,
      windowCapacityProvided,
      effectiveWindowCapacity,
      windowSpare: Math.max(0, effectiveWindowCapacity - demand),
      ...control,
      seed
    };
  });
}

// L = λW。demand 是窗口内到达量，wait 是分钟，因此除以窗口长度得到窗口内排队量。
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

function finiteInput(input, keys) {
  return keys.some((key) => hasOwn(input, key) && Number.isFinite(Number(input[key])));
}

function stationSummary(station) {
  if (!station) return null;
  return {
    id: station.id,
    name: station.name,
    type: station.type,
    partner: station.partner,
    controllable: station.controllable,
    couponEligible: station.couponEligible,
    merchantAccepted: station.merchantAccepted,
    executionEligible: station.executionEligible,
    navigationOnly: station.navigationOnly,
    ineligibleReasons: station.ineligibleReasons,
    windowCapacity: Number(station.windowCapacity.toFixed(2)),
    effectiveWindowCapacity: Number(station.effectiveWindowCapacity.toFixed(2)),
    windowSpare: Number(station.windowSpare.toFixed(2)),
    price: station.price,
    serviceRate: station.serviceRate,
    dataSource: station.dataSource,
    asOf: station.asOf
  };
}

export function simulateOperator(input = {}) {
  const stationsInput = Array.isArray(input.stations) ? input.stations : [];
  if (!stationsInput.length) throw new Error("STATIONS_REQUIRED");

  const baseStations = normalizeStations(stationsInput);
  const discountFallback = asNumber(input.discountAmount ?? input.discount ?? 6, 6, 0, 100);
  const platformCouponProvided = finiteInput(input, ["platformCoupon", "platformCouponAmount"]);
  const platformCoupon = asNumber(firstDefined(input, ["platformCoupon", "platformCouponAmount"]), discountFallback, 0, 100);
  const merchantCouponShare = asShare(firstDefined(input, ["merchantCouponShare", "merchantShare"]), 0);
  const platformTakeRate = asShare(input.platformTakeRate, 0.12);
  const platformVariableCost = asNumber(input.platformVariableCost, 0.18, 0, 10000);
  const campaignBudgetProvided = finiteInput(input, ["campaignBudget"]);
  const campaignBudget = campaignBudgetProvided ? asNumber(input.campaignBudget, 0, 0, 100000000) : Number.POSITIVE_INFINITY;
  const averageOrderUnits = asNumber(firstDefined(input, ["averageOrderUnits", "averageOrderKwh", "energyPerOrder"]), 20, 1, 1000);
  const targetUser = String(input.targetUser ?? "all").slice(0, 64);
  const targetInput = input.targetStationId ?? input.targetStation ?? null;
  const targetId = typeof targetInput === "object" ? targetInput?.id : targetInput;
  const requestedTarget = targetId == null ? null : baseStations.find((station) => station.id === String(targetId)) || null;
  const eligibleStations = baseStations.filter((station) => station.executionEligible);
  const requestedTargetIsExecutable = requestedTarget?.executionEligible === true;
  const targetCandidates = eligibleStations.slice();
  const targetScore = (station) => station.wait
    + station.occupancy * 18
    + station.detour * 0.4
    + station.price * 2
    - station.serviceFactor * 2
    - clamp(station.windowSpare / Math.max(station.effectiveWindowCapacity, 1), 0, 1) * 3;
  const target = requestedTargetIsExecutable
    ? requestedTarget
    : targetCandidates.sort((a, b) => targetScore(a) - targetScore(b))[0] || null;
  const sourceStations = target ? eligibleStations.filter((station) => station.id !== target.id) : [];
  const navigationOnlyStations = baseStations.filter((station) => !station.executionEligible);
  const segment = userSegment(targetUser, input.targetSegment ?? input.segmentId);
  const eligibleShare = segment.share;
  const sourcePressureRows = sourceStations.map((station) => {
    const congestionPressure = clamp((station.occupancy - 0.56) / 0.38, 0, 1);
    const waitPressure = clamp(station.wait / 30, 0, 1.5);
    const servicePressure = clamp(1 / station.serviceFactor, 0.5, 2);
    const weight = clamp(congestionPressure * (0.65 + waitPressure * 0.35) * servicePressure, 0, 1.5);
    return { station, weight, pressure: station.demand * weight };
  });
  const pressureDemand = sourcePressureRows.reduce((sum, row) => sum + row.pressure, 0);
  const totalExecutableDemand = eligibleStations.reduce((sum, station) => sum + station.demand, 0);
  const sourcePriceWeight = sourcePressureRows.reduce((sum, row) => sum + row.pressure, 0);
  const sourcePrice = sourcePriceWeight > 0
    ? sourcePressureRows.reduce((sum, row) => sum + row.station.price * row.pressure, 0) / sourcePriceWeight
    : sourceStations.reduce((sum, station) => sum + station.price, 0) / Math.max(1, sourceStations.length);
  const sourceAbandonRate = pressureDemand > 0
    ? sourcePressureRows.reduce((sum, row) => sum + row.pressure * abandonRate(row.station.occupancy), 0) / pressureDemand
    : 0;
  const targetSpare = target?.windowSpare || 0;

  const targetOrderValue = target ? (target.orderValueProvided ? target.orderValue : target.price * averageOrderUnits) : 0;
  const platformRevenuePerOrder = target ? targetOrderValue * platformTakeRate : 0;
  const merchantContributionPerOrder = target?.margin || 0;
  const platformCouponCostPerOrder = (amount) => amount * (1 - merchantCouponShare);

  function previewDiscount(amount) {
    if (!target) {
      return {
        responseRate: 0,
        priceAdvantage: 0,
        switchRate: 0,
        diverted: 0,
        incremental: 0,
        retained: 0,
        newVolumeGrossProfit: 0,
        retainedGrossProfit: 0,
        acceptedOrders: 0,
        discountCost: 0,
        platformCouponCost: 0,
        merchantCouponCost: 0,
        platformRevenue: 0,
        platformVariableCostTotal: 0,
        platformContribution: 0,
        merchantContribution: 0,
        platformNewOrders: 0,
        networkTransferOrders: 0,
        platformCost: 0,
        scenarioRoi: 0,
        budgetRemaining: Number.isFinite(campaignBudget) ? campaignBudget : null
      };
    }
    const coupon = asNumber(amount, 0, 0, 100);
    const responseRate = coupon > 0 ? coupon / (coupon + 7) : 0;
    const priceAdvantage = sourceStations.length
      ? clamp((sourcePrice - target.price) / Math.max(sourcePrice, 0.1), -0.6, 0.6)
      : 0;
    // 价格更低、服务率更高的承接站更容易承接同等券值的用户。
    const priceMultiplier = clamp(1 + priceAdvantage * 0.65, 0.55, 1.4);
    const serviceMultiplier = clamp(0.72 + target.serviceFactor * 0.24, 0.55, 1.25);
    const switchRate = clamp((0.025 + responseRate * 0.36) * eligibleShare * priceMultiplier * serviceMultiplier, 0, 0.65);
    const rawDiverted = Math.min(pressureDemand * switchRate, targetSpare);
    const incrementalBase = totalExecutableDemand * clamp(0.005 + responseRate * 0.06, 0, 0.08);
    const rawIncremental = Math.min(
      incrementalBase * clamp(1 + priceAdvantage * 0.35, 0.7, 1.25),
      Math.max(0, targetSpare - rawDiverted)
    );
    const couponCostPerOrder = platformCouponCostPerOrder(coupon);
    const budgetOrderCap = Number.isFinite(campaignBudget) && couponCostPerOrder > 0
      ? campaignBudget / couponCostPerOrder
      : Number.POSITIVE_INFINITY;
    const acceptedCap = Math.min(targetSpare, budgetOrderCap);
    const acceptedRaw = Math.min(rawDiverted + rawIncremental, acceptedCap);
    const diverted = Math.min(rawDiverted, acceptedRaw);
    const incremental = Math.min(rawIncremental, Math.max(0, acceptedRaw - diverted));
    const acceptedOrders = diverted + incremental;
    const targetOccupancyAfter = clamp(target.occupancy + acceptedOrders / Math.max(1, target.capacity) * 0.22, 0.05, 0.99);
    const retained = Math.max(0, Math.min(diverted, diverted * (sourceAbandonRate - abandonRate(targetOccupancyAfter))));
    const newVolumeGrossProfit = incremental * merchantContributionPerOrder;
    const retainedGrossProfit = retained * merchantContributionPerOrder;
    const platformNewOrders = incremental + retained;
    const networkTransferOrders = Math.max(0, diverted - retained);
    const discountCost = acceptedOrders * coupon;
    const platformCouponCost = acceptedOrders * couponCostPerOrder;
    const merchantCouponCost = acceptedOrders * coupon * merchantCouponShare;
    const platformRevenue = platformNewOrders * platformRevenuePerOrder;
    const platformVariableCostTotal = platformNewOrders * platformVariableCost;
    const platformContribution = platformRevenue - platformCouponCost - platformVariableCostTotal;
    const merchantContribution = acceptedOrders * merchantContributionPerOrder - merchantCouponCost;
    const platformCost = platformCouponCost + platformVariableCostTotal;
    const scenarioRoi = platformCost > 0 ? platformContribution / platformCost : 0;
    return {
      responseRate,
      priceAdvantage,
      switchRate,
      diverted,
      incremental,
      retained,
      newVolumeGrossProfit,
      retainedGrossProfit,
      acceptedOrders,
      discountCost,
      platformCouponCost,
      merchantCouponCost,
      platformRevenue,
      platformVariableCostTotal,
      platformContribution,
      merchantContribution,
      platformNewOrders,
      networkTransferOrders,
      platformCost,
      scenarioRoi,
      budgetRemaining: Number.isFinite(campaignBudget) ? Math.max(0, campaignBudget - platformCouponCost) : null
    };
  }

  const outcome = previewDiscount(platformCoupon);
  const {
    responseRate,
    priceAdvantage,
    switchRate,
    diverted,
    incremental,
    retained,
    newVolumeGrossProfit,
    retainedGrossProfit,
    acceptedOrders,
    discountCost,
    platformCouponCost,
    merchantCouponCost,
    platformRevenue,
    platformVariableCostTotal,
    platformContribution,
    merchantContribution,
    platformNewOrders,
    networkTransferOrders,
    platformCost,
    scenarioRoi,
    budgetRemaining
  } = outcome;
  const desiredDiversion = Math.max(1, pressureDemand * 0.22);
  const diversionCeiling = targetSpare;
  const capacityBound = desiredDiversion > diversionCeiling;
  const budgetBound = Number.isFinite(campaignBudget) && platformCouponCost >= campaignBudget - 1e-9 && acceptedOrders > 0;
  const searchCeiling = Math.max(15, Math.ceil(platformCoupon));
  const candidateDiscounts = target
    ? Array.from({ length: searchCeiling }, (_, index) => index + 1).map((amount) => ({ amount, result: previewDiscount(amount) }))
    : [];
  // 推荐只在平台场景 ROI >= 1 的券档里挑分流最多者；无法证明经济可行时，
  // 仍返回带 scenario/insufficient-data 标签的仿真结果，不把它冒充真实经营 ROI。
  const profitable = candidateDiscounts.filter((candidate) => candidate.result.scenarioRoi >= 1 && candidate.result.acceptedOrders > 0);
  const recommendedCandidate = profitable.length
    ? profitable.reduce((best, candidate) => {
      if (candidate.result.diverted > best.result.diverted + 1e-9) return candidate;
      if (Math.abs(candidate.result.diverted - best.result.diverted) <= 1e-9 && candidate.amount < best.amount) return candidate;
      return best;
    })
    : null;
  const recommendedDiscount = recommendedCandidate?.amount ?? null;
  const recommendedDiversion = recommendedCandidate?.result.diverted ?? 0;

  const movedBySource = new Map();
  if (pressureDemand > 0) {
    for (const row of sourcePressureRows) movedBySource.set(row.station.id, diverted * row.pressure / pressureDemand);
  }
  const after = baseStations.map((station) => {
    const moved = movedBySource.get(station.id) || 0;
    const demand = target && station.id === target.id
      ? station.demand + acceptedOrders
      : station.executionEligible
        ? Math.max(0, station.demand - moved)
        : station.demand;
    const occupancy = clamp(station.occupancy + (demand - station.demand) / Math.max(1, station.capacity) * 0.22, 0.05, 0.99);
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
      windowSpare: Number(Math.max(0, station.effectiveWindowCapacity - demand).toFixed(2)),
      changedDemand: Number((demand - station.demand).toFixed(2)),
      strategyRole: target && station.id === target.id ? "target" : moved > 0 ? "source" : station.navigationOnly ? "navigation-only" : null,
      status: atRisk ? "forecast-risk" : "forecast-ready",
      riskLabel: atRisk ? "高峰风险" : "策略后可用"
    };
  });
  const beforeMetrics = snapshot(baseStations);
  const afterMetrics = snapshot(after);

  const missingEconomicFields = ECONOMIC_FIELDS.filter((field) => {
    if (field === "platformCoupon") return !platformCouponProvided;
    if (field === "campaignBudget") return !campaignBudgetProvided;
    return !finiteInput(input, [field]);
  });
  const missingStationEconomicFields = baseStations
    .filter((station) => station.executionEligible && !station.priceProvided)
    .map((station) => `${station.id}:price`);
  const insufficientData = missingEconomicFields.length > 0 || missingStationEconomicFields.length > 0;
  const labels = ["scenario"];
  if (insufficientData) labels.push("insufficient-data");
  if (!target) labels.push("navigation-only");
  if (capacityBound) labels.push("capacity-constrained");
  if (budgetBound) labels.push("budget-constrained");
  const dataSource = String(input.dataSource ?? baseStations.find((station) => station.dataSource)?.dataSource ?? "演示输入").slice(0, 120);
  const asOf = input.asOf == null ? baseStations.find((station) => station.asOf)?.asOf ?? null : String(input.asOf).slice(0, 80);
  const providedEconomicFields = ECONOMIC_FIELDS.filter((field) => !missingEconomicFields.includes(field));

  return {
    // 旧客户端仍使用 discountAmount/impact.roi；新客户端应使用 platformCoupon/scenarioRoi。
    targetStation: stationSummary(target),
    requestedTargetStation: stationSummary(requestedTarget),
    targetUser,
    discountAmount: platformCoupon,
    platformCoupon,
    merchantCouponShare,
    platformTakeRate,
    platformVariableCost,
    campaignBudget: Number.isFinite(campaignBudget) ? campaignBudget : null,
    dataSource,
    asOf,
    labels,
    dataLabels: labels,
    insufficientData,
    roiType: "scenario",
    realRoi: null,
    execution: {
      mode: target ? "strategy" : "navigation-only",
      executable: Boolean(target),
      targetStationId: target?.id ?? null,
      executableStationIds: eligibleStations.map((station) => station.id),
      navigationOnlyStationIds: navigationOnlyStations.map((station) => station.id),
      boundary: "仅对 partner、controllable、couponEligible、merchantAccepted 全部为 true 的站点执行券与分流；其它站点仅导航。"
    },
    navigationOnlyStations: navigationOnlyStations.map(stationSummary),
    recommendedDiscount,
    recommendedPlatformCoupon: recommendedDiscount,
    recommendedBasis: recommendedCandidate
      ? {
        diverted: Number(recommendedDiversion.toFixed(2)),
        platformContribution: Number(recommendedCandidate.result.platformContribution.toFixed(2)),
        merchantContribution: Number(recommendedCandidate.result.merchantContribution.toFixed(2)),
        scenarioRoi: Number(recommendedCandidate.result.scenarioRoi.toFixed(3)),
        roi: Number(recommendedCandidate.result.scenarioRoi.toFixed(3)),
        meetsDesiredDiversion: recommendedDiversion >= Math.min(desiredDiversion, diversionCeiling) - 1e-9,
        rule: "在平台场景 ROI ≥ 1 的券档中取分流量最大者"
      }
      : {
        diverted: 0,
        platformContribution: 0,
        merchantContribution: 0,
        scenarioRoi: 0,
        roi: 0,
        meetsDesiredDiversion: false,
        rule: target
          ? "当前平台成本、容量与负载下，没有任何券值能同时做到场景 ROI ≥ 1，故不给出推荐值"
          : "没有合作且接受平台策略的承接站，仅提供导航，不生成可执行策略"
      },
    desiredDiversion: Number(desiredDiversion.toFixed(2)),
    diversionCeiling: Number(diversionCeiling.toFixed(2)),
    capacityBound,
    unservedPressure: Number(Math.max(0, desiredDiversion - diversionCeiling).toFixed(2)),
    budgetBound,
    budgetRemaining: budgetRemaining == null ? null : Number(budgetRemaining.toFixed(2)),
    before: beforeMetrics,
    after: afterMetrics,
    stations: after,
    impact: {
      divertedVehicles: Number(diverted.toFixed(2)),
      incrementalOrders: Number(incremental.toFixed(2)),
      retainedOrders: Number(retained.toFixed(2)),
      platformNewOrders: Number(platformNewOrders.toFixed(2)),
      networkTransferOrders: Number(networkTransferOrders.toFixed(2)),
      newVolumeGrossProfit: Number(newVolumeGrossProfit.toFixed(2)),
      retainedGrossProfit: Number(retainedGrossProfit.toFixed(2)),
      acceptedOrders: Number(acceptedOrders.toFixed(2)),
      discountCost: Number(discountCost.toFixed(2)),
      platformCouponCost: Number(platformCouponCost.toFixed(2)),
      merchantCouponCost: Number(merchantCouponCost.toFixed(2)),
      platformCoupon: Number(platformCoupon.toFixed(2)),
      merchantCouponShare: Number(merchantCouponShare.toFixed(3)),
      platformRevenue: Number(platformRevenue.toFixed(2)),
      platformVariableCost: Number(platformVariableCostTotal.toFixed(2)),
      platformCost: Number(platformCost.toFixed(2)),
      incrementalGrossProfit: Number((newVolumeGrossProfit + retainedGrossProfit).toFixed(2)),
      platformContribution: Number(platformContribution.toFixed(2)),
      merchantContribution: Number(merchantContribution.toFixed(2)),
      scenarioRoi: Number(scenarioRoi.toFixed(3)),
      roiType: "scenario",
      // 旧字段保留为场景 ROI 别名，不能解读为真实结算 ROI。
      roi: Number(scenarioRoi.toFixed(3)),
      switchRate: Number(switchRate.toFixed(4)),
      priceAdvantage: Number(priceAdvantage.toFixed(4)),
      capacityUsed: Number(acceptedOrders.toFixed(2)),
      capacityRemaining: Number(Math.max(0, targetSpare - acceptedOrders).toFixed(2)),
      responseRate: Number(responseRate.toFixed(3))
    },
    // 顶层也给出平台/商户口径，便于非前端调用方不必解析 impact。
    platformContribution: Number(platformContribution.toFixed(2)),
    merchantContribution: Number(merchantContribution.toFixed(2)),
    scenarioRoi: Number(scenarioRoi.toFixed(3)),
    roi: Number(scenarioRoi.toFixed(3)),
    recommendation: !target
      ? "navigation-only"
      : afterMetrics.p90Wait <= beforeMetrics.p90Wait
        && afterMetrics.averageWait <= beforeMetrics.averageWait
        && afterMetrics.occupancyDispersion <= beforeMetrics.occupancyDispersion
        && scenarioRoi >= 1
        ? "recommended"
        : afterMetrics.p90Wait <= beforeMetrics.p90Wait && afterMetrics.averageWait <= beforeMetrics.averageWait
          ? "operationally-effective"
          : "risk",
    assumptions: {
      description: "平台场景仿真：券敏感度、价格、服务能力、窗口承接容量和平台成本共同决定分流结果；不代表能链实时结算数据。",
      eligibleShare: Number(eligibleShare.toFixed(3)),
      responseRate: Number(responseRate.toFixed(3)),
      userSegment: segment.label,
      userSegmentMatched: segment.matched,
      userSegmentSource: segment.source,
      averageOrderUnits,
      platformCoupon,
      merchantCouponShare,
      platformTakeRate,
      platformVariableCost,
      campaignBudget: Number.isFinite(campaignBudget) ? campaignBudget : null,
      economics: {
        requiredFields: ECONOMIC_FIELDS,
        providedFields: providedEconomicFields,
        missingFields: [...missingEconomicFields, ...missingStationEconomicFields],
        sufficientForRealRoi: !insufficientData,
        roiLabel: "scenarioRoi 仅表示带标签的场景结果，不是实时经营或财务结算 ROI。"
      },
      executionBoundary: "网内搬家不计平台新增订单；只有 incrementalOrders 与 retainedOrders 进入 platformContribution。",
      roiBasis: "platformContribution = 平台新增订单收入 - 平台券成本 - 平台新增订单可变成本；merchantContribution 单独计承接站订单贡献与商户承担券成本。",
      waitModel: "等待时间按 1/(1-负载) 的拥堵因子缩放，负载趋近饱和时非线性上升。",
      capacityModel: "acceptedOrders 不得超过承接站有效窗口容量与 campaignBudget 可购买的订单数。",
      p90Basis: "P90 为需求加权的 90 分位站点排队（90% 的到站车辆，其所在站点的平均排队不超过该值），非最差站点值。",
      dataSource,
      asOf
    }
  };
}

export { normalizeStations, snapshot };
