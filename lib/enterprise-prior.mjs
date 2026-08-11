import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_MATCH_DISTANCE_KM = 220;
const EARTH_RADIUS_KM = 6371;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function finite(value, fallback = Number.NaN) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeLocation(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = finite(value[0]);
  const latitude = finite(value[1]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude < 73 || longitude > 136 || latitude < 18 || latitude > 54) return null;
  return [longitude, latitude];
}

function distanceKm(left, right) {
  const [lng1, lat1] = left.map((value) => value * Math.PI / 180);
  const [lng2, lat2] = right.map((value) => value * Math.PI / 180);
  const deltaLat = lat2 - lat1;
  const deltaLng = lng2 - lng1;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function energyKey(station = {}) {
  const value = `${station.type || ""} ${station.name || ""}`;
  if (/加油|油站|燃油/.test(value)) return "fuel";
  if (/充电|换电|电站|超充/.test(value)) return "electric";
  return null;
}

function minuteOfDay(value) {
  const numeric = finite(value, 0);
  const normalized = numeric % 1440;
  return normalized < 0 ? normalized + 1440 : normalized;
}

function stationArrivalOffset(station = {}, scenario = {}) {
  const values = [
    station.arrivalOffsetMinutes,
    station.arrivalOffset,
    station.etaOffsetMinutes,
    station.etaMinutes,
    station.travelMinutes,
    scenario.arrivalOffsetMinutes,
    scenario.arrivalMinutes,
    scenario.etaMinutes
  ].map(Number);
  const direct = values.find(Number.isFinite);
  return Number.isFinite(direct) ? Math.max(0, direct) : 0;
}

function interpolate(values, arrivalMinute) {
  if (!Array.isArray(values) || values.length !== 24) return null;
  const normalized = minuteOfDay(arrivalMinute);
  const hour = Math.floor(normalized / 60);
  const ratio = (normalized % 60) / 60;
  const current = finite(values[hour]);
  const next = finite(values[(hour + 1) % 24]);
  if (!Number.isFinite(current) || !Number.isFinite(next)) return null;
  return current + (next - current) * ratio;
}

function confidenceLevel(score) {
  return score >= 76 ? "high" : score >= 56 ? "medium" : "low";
}

function confidenceLabel(score) {
  const level = confidenceLevel(score);
  return `${level === "high" ? "高" : level === "medium" ? "中" : "低"}（企业拟合先验）`;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || payload.artifactVersion !== 1) return null;
  if (!Array.isArray(payload.cities) || !payload.cities.length) return null;
  const cities = payload.cities.map((entry) => ({
    city: String(entry?.city || "").slice(0, 80),
    centroid: normalizeLocation(entry?.centroid),
    types: entry?.types && typeof entry.types === "object" ? entry.types : {}
  })).filter((entry) => entry.city && entry.centroid);
  if (!cities.length) return null;
  return {
    artifactVersion: 1,
    modelVersion: String(payload.modelVersion || "enterprise-prior").slice(0, 80),
    modelType: String(payload.modelType || "enterprise demand prior").slice(0, 120),
    source: String(payload.source || "企业生产拟合数据").slice(0, 80),
    sourceBoundary: String(payload.sourceBoundary || "城市×类型×小时离线需求先验").slice(0, 180),
    trainingBaseDate: String(payload.trainingBaseDate || "").slice(0, 20),
    trainingBucketCount: finite(payload.trainingBucketCount, null),
    holdoutWape: finite(payload.holdoutWape, null),
    rollingValidationMeanWape: finite(payload.rollingValidationMeanWape, null),
    stationCount: finite(payload.stationCount, null),
    cityCount: cities.length,
    cities,
    limitations: Array.isArray(payload.limitations) ? payload.limitations.map(String).slice(0, 8) : []
  };
}

export async function loadEnterpriseDemandPrior({ root = process.cwd(), filePath } = {}) {
  const target = filePath || join(root, "data", "enterprise-demand-prior.json");
  try {
    const payload = validatePayload(JSON.parse(await readFile(target, "utf8")));
    if (!payload) throw new Error("INVALID_ENTERPRISE_PRIOR");
    return { configured: true, available: true, filePath: target, ...payload };
  } catch {
    return {
      configured: false,
      available: false,
      filePath: target,
      modelVersion: null,
      sourceBoundary: "企业需求先验未加载；继续使用原有仿真预测",
      cities: []
    };
  }
}

export function enterprisePriorHealth(prior = {}) {
  return {
    configured: prior.available === true,
    available: prior.available === true,
    modelVersion: prior.modelVersion || null,
    modelType: prior.modelType || null,
    source: prior.source || null,
    sourceBoundary: prior.sourceBoundary || null,
    cityCount: Number(prior.cityCount || 0),
    stationCount: Number(prior.stationCount || 0),
    holdoutWape: Number.isFinite(Number(prior.holdoutWape)) ? Number(prior.holdoutWape) : null,
    rollingValidationMeanWape: Number.isFinite(Number(prior.rollingValidationMeanWape))
      ? Number(prior.rollingValidationMeanWape)
      : null
  };
}

export function resolveEnterpriseDemandPrior(prior, station = {}, scenario = {}) {
  if (!prior?.available || !Array.isArray(prior.cities)) return null;
  const location = normalizeLocation(station.location);
  const type = energyKey(station);
  if (!location || !type) return null;
  let nearest = null;
  for (const city of prior.cities) {
    if (!city.types?.[type]) continue;
    const candidateDistance = distanceKm(location, city.centroid);
    if (!nearest || candidateDistance < nearest.distanceKm) nearest = { city, distanceKm: candidateDistance };
  }
  if (!nearest || nearest.distanceKm > MAX_MATCH_DISTANCE_KM) return null;
  const typeData = nearest.city.types[type];
  const departureMinutes = finite(scenario.departureMinutes, 0);
  const arrivalOffsetMinutes = stationArrivalOffset(station, scenario);
  const arrivalMinute = departureMinutes + arrivalOffsetMinutes;
  const rawFactor = interpolate(typeData.hourlyDemandMultiplier, arrivalMinute);
  const ordersPerStationHour = interpolate(typeData.hourlyOrdersPerStation, arrivalMinute);
  if (!Number.isFinite(rawFactor)) return null;
  // The frozen prior must influence the simulation without overwhelming live
  // route constraints. Wider regional variation remains visible in evidence.
  const demandFactor = clamp(rawFactor, 0.65, 1.45);
  const wape = finite(typeData.holdoutWape, prior.holdoutWape);
  let score = 72;
  const reasons = ["使用企业生产拟合数据的城市×油电类型×小时需求先验"];
  if (nearest.distanceKm <= 30) {
    score += 6;
    reasons.push("候选站接近样本城市中心");
  } else if (nearest.distanceKm <= 80) {
    score += 2;
    reasons.push("候选站位于样本城市覆盖范围");
  } else {
    score -= 7;
    reasons.push("仅按最近样本城市近似匹配");
  }
  if (Number.isFinite(wape)) {
    score -= clamp(wape * 32, 3, 18);
    reasons.push(`该层级留出 WAPE ${Math.round(wape * 1000) / 10}%`);
  }
  const samples = finite(typeData.holdoutSamples, 0);
  if (samples >= 300) {
    score += 4;
    reasons.push(`留出窗口样本 ${Math.round(samples)} 条`);
  }
  score = Math.round(clamp(score, 42, 82));
  return {
    matched: true,
    city: nearest.city.city,
    energyType: type,
    matchMethod: "nearest-enterprise-city-centroid",
    matchDistanceKm: Number(nearest.distanceKm.toFixed(1)),
    arrivalMinute: Number(arrivalMinute.toFixed(1)),
    demandFactor: Number(demandFactor.toFixed(4)),
    rawDemandFactor: Number(rawFactor.toFixed(4)),
    predictedOrdersPerStationHour: Number.isFinite(ordersPerStationHour)
      ? Number(ordersPerStationHour.toFixed(5))
      : null,
    meanServiceMinutes: Number.isFinite(Number(typeData.meanServiceMinutes))
      ? Number(typeData.meanServiceMinutes)
      : null,
    stationCount: Number(typeData.stationCount || 0),
    holdoutSamples: Number(typeData.holdoutSamples || 0),
    holdoutWape: Number.isFinite(wape) ? Number(wape) : null,
    modelVersion: prior.modelVersion,
    modelType: prior.modelType,
    source: prior.source,
    sourceBoundary: prior.sourceBoundary,
    confidenceScore: score,
    confidenceLevel: confidenceLevel(score),
    confidenceLabel: confidenceLabel(score),
    confidenceReasons: reasons.slice(0, 8)
  };
}

export function enrichStationsWithEnterprisePrior(prior, stations = [], scenario = {}) {
  if (!Array.isArray(stations)) return [];
  return stations.slice(0, 200).map((station) => {
    const clean = { ...(station && typeof station === "object" ? station : {}) };
    // These fields are server-authoritative. Never accept a browser-provided
    // object that could impersonate enterprise evidence.
    delete clean.enterprisePrior;
    delete clean.enterpriseDemandFactor;
    const resolved = resolveEnterpriseDemandPrior(prior, clean, scenario);
    if (!resolved) return clean;
    return {
      ...clean,
      enterpriseDemandFactor: resolved.demandFactor,
      enterprisePrior: resolved
    };
  });
}

