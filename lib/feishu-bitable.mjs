import { createHash, randomUUID } from "node:crypto";
import { parseOptionalNumber } from "./number.mjs";

const DEFAULT_FEISHU_BASE_URL = "https://open.feishu.cn";
const MAX_STATIONS = 40;
const MAX_TEXT = 500;
const MAX_FORECAST_STATIONS = 6;
const MAX_RELEASE_MINUTES = 12;
// Feishu AI fields have a much smaller practical context than the Bitable API
// request envelope. Keep the explanatory JSON deliberately compact; the
// numeric strategy fields remain separate columns and the snapshot table keeps
// the detailed station records.
const MAX_AI_INPUT_BYTES = 1000;
const MAX_AI_FORECAST_STATIONS = 2;
export const MAX_FEISHU_JOBS = 500;
export const FEISHU_JOB_TTL_MS = 60 * 60 * 1000;
const MAX_TOKEN_CACHE_ENTRIES = 100;
export const STRATEGY_RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const ALLOWED_APPROVAL_STATUSES = Object.freeze([
  "待确认",
  "已确认",
  "已执行",
  "已拒绝",
  "已驳回",
  "已取消"
]);
const ALLOWED_APPROVAL_STATUS_SET = new Set(ALLOWED_APPROVAL_STATUSES);

const jobs = new Map();
const runIndex = new Map();
const tokenCache = new Map();

const FIELD_NAMES = {
  snapshot: {
    runId: "运行批次",
    snapshotAt: "快照时间",
    stationId: "站点ID",
    stationName: "站点名称",
    city: "城市",
    energyType: "能源类型",
    capacity: "站点容量",
    occupancy: "当前占用",
    arrivals15m: "15分钟到达",
    serviceRate: "服务率",
    p50: "P50等待",
    p90: "P90等待",
    price: "价格",
    discount: "优惠",
    diversion: "分流率",
    roi: "ROI",
    source: "数据来源",
    dataAsOf: "数据时点"
  },
  strategy: {
    strategyId: "策略ID",
    runId: "运行批次",
    sourceStation: "拥堵站",
    receivingStation: "承接站",
    objective: "目标",
    discount: "优惠金额",
    diverted: "预计分流",
    waitChange: "预计等待变化",
    roi: "预计ROI",
    evidence: "策略输入",
    risk: "风险说明",
    approval: "审批状态",
    createdAt: "创建时间"
  },
  sync: {
    syncId: "同步ID",
    runId: "运行批次",
    status: "同步状态",
    startedAt: "开始时间",
    finishedAt: "完成时间",
    count: "写入数量",
    aiStatus: "AI状态",
    error: "错误信息"
  }
};

function text(value, max = MAX_TEXT) {
  return String(value ?? "").trim().slice(0, max);
}

function finite(value, fallback = 0) {
  const number = parseOptionalNumber(value);
  return number !== null ? number : fallback;
}

// Feishu Bitable date fields (type 5) accept Unix timestamps in milliseconds,
// not ISO-8601 strings. Keep the input boundary flexible because the rest of
// FlowTwin naturally carries ISO timestamps.
function dateTimeValue(value, fallback = Date.now()) {
  if (value === null || value === undefined || value === "") return "";
  const numeric = parseOptionalNumber(value);
  if (numeric !== null && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeBaseUrl(value) {
  try {
    const url = new URL(value || DEFAULT_FEISHU_BASE_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function configReady(config = {}) {
  return Boolean(
    safeBaseUrl(config.feishuBaseUrl) &&
    text(config.feishuAppId, 200) &&
    text(config.feishuAppSecret, 300) &&
    text(config.feishuAppToken, 300) &&
    text(config.feishuSnapshotTableId, 200) &&
    text(config.feishuStrategyTableId, 200)
  );
}

export function feishuConfigSummary(config = {}) {
  return {
    configured: configReady(config),
    baseUrlConfigured: Boolean(safeBaseUrl(config.feishuBaseUrl)),
    appConfigured: Boolean(text(config.feishuAppId, 200) && text(config.feishuAppSecret, 300)),
    bitableConfigured: Boolean(text(config.feishuAppToken, 300)),
    snapshotTableConfigured: Boolean(text(config.feishuSnapshotTableId, 200)),
    strategyTableConfigured: Boolean(text(config.feishuStrategyTableId, 200)),
    syncTableConfigured: Boolean(text(config.feishuSyncTableId, 200)),
    aiField: text(config.feishuAiStrategyField || "AI策略", 100)
  };
}

function pruneJobs({
  nowMs = Date.now(),
  maxJobs = MAX_FEISHU_JOBS,
  jobTtlMs = FEISHU_JOB_TTL_MS
} = {}) {
  const limit = Math.max(1, Math.floor(Number(maxJobs) || MAX_FEISHU_JOBS));
  const ttl = Math.max(1, Math.floor(Number(jobTtlMs) || FEISHU_JOB_TTL_MS));
  for (const [syncId, job] of jobs) {
    if (nowMs - (job.createdAtMs ?? 0) >= ttl) {
      jobs.delete(syncId);
      if (runIndex.get(job.runId) === job) runIndex.delete(job.runId);
    }
  }
  for (const [runId, job] of runIndex) {
    if (nowMs - (job.createdAtMs ?? 0) >= ttl) {
      runIndex.delete(runId);
    }
  }
  while (jobs.size > limit) {
    const oldestKey = jobs.keys().next().value;
    const oldest = jobs.get(oldestKey);
    jobs.delete(oldestKey);
    if (oldest && runIndex.get(oldest.runId) === oldest) runIndex.delete(oldest.runId);
  }
  while (runIndex.size > limit) {
    runIndex.delete(runIndex.keys().next().value);
  }
}

function pruneTokens(nowMs = Date.now()) {
  for (const [key, cached] of tokenCache) {
    if (cached.expiresAt <= nowMs) tokenCache.delete(key);
  }
  while (tokenCache.size >= MAX_TOKEN_CACHE_ENTRIES) {
    tokenCache.delete(tokenCache.keys().next().value);
  }
}

function apiPath(config, tableId, suffix = "") {
  const appToken = encodeURIComponent(text(config.feishuAppToken, 300));
  const table = encodeURIComponent(text(tableId, 200));
  return `/open-apis/bitable/v1/apps/${appToken}/tables/${table}/records${suffix}`;
}

async function getTenantAccessToken(config, fetchImpl) {
  const baseUrl = safeBaseUrl(config.feishuBaseUrl);
  const appId = text(config.feishuAppId, 200);
  const appSecret = text(config.feishuAppSecret, 300);
  const cacheKey = createHash("sha256").update(`${baseUrl}\0${appId}\0${appSecret}`).digest("hex");
  const nowMs = Date.now();
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs + 30_000) return cached.token;
  const response = await fetchImpl(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(10000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0 || !payload.tenant_access_token) {
    throw Object.assign(new Error("FEISHU_AUTH_FAILED"), { code: "FEISHU_AUTH_FAILED", httpStatus: response.status });
  }
  const expiresIn = Math.max(60, Number(payload.expire) || 7200);
  pruneTokens(nowMs);
  tokenCache.set(cacheKey, { token: payload.tenant_access_token, expiresAt: nowMs + expiresIn * 1000 });
  return payload.tenant_access_token;
}

async function bitableRequest({ config, token, path, method = "GET", body, fetchImpl }) {
  const baseUrl = safeBaseUrl(config.feishuBaseUrl);
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.code || 0) !== 0) {
    throw Object.assign(new Error("FEISHU_BITABLE_REQUEST_FAILED"), {
      code: "FEISHU_BITABLE_REQUEST_FAILED",
      httpStatus: response.status,
      feishuCode: payload.code || null
    });
  }
  return payload.data || {};
}

function stationFields(station, runId, snapshotAt, source, dataAsOf) {
  const names = FIELD_NAMES.snapshot;
  const safeStation = station && typeof station === "object" && !Array.isArray(station) ? station : {};
  return {
    [names.runId]: text(runId, 100),
    [names.snapshotAt]: dateTimeValue(snapshotAt),
    [names.stationId]: text(safeStation.id, 100),
    [names.stationName]: text(safeStation.name || "补能站", 100),
    [names.city]: text(safeStation.city || safeStation.region || "沿线", 80),
    [names.energyType]: text(safeStation.type || "未知", 40),
    [names.capacity]: finite(safeStation.capacity),
    [names.occupancy]: finite(safeStation.occupancy),
    [names.arrivals15m]: finite(safeStation.arrivals15m ?? safeStation.arrivalRate),
    [names.serviceRate]: finite(safeStation.serviceRate),
    [names.p50]: finite(safeStation.p50 ?? safeStation.wait),
    [names.p90]: finite(safeStation.p90 ?? safeStation.wait),
    [names.price]: finite(safeStation.price),
    [names.discount]: finite(safeStation.discount),
    [names.diversion]: finite(safeStation.diversionRate),
    [names.roi]: finite(safeStation.roi),
    [names.source]: text(source || safeStation.source || "FlowTwin 演示仿真", 160),
    [names.dataAsOf]: dateTimeValue(dataAsOf || snapshotAt)
  };
}

function finiteOrNull(value) {
  return parseOptionalNumber(value);
}

function boundedSnapshotValue(value, min, max) {
  const result = finiteOrNull(value);
  if (result === null) return null;
  return Math.min(max, Math.max(min, Math.round(result)));
}

function isRetryableFeishuError(error) {
  const status = Number(error?.httpStatus);
  return [408, 425, 429, 500, 502, 503, 504].includes(status)
    || error?.name === "AbortError"
    || error?.name === "TimeoutError"
    || /timeout|timed? ?out/i.test(String(error?.message || ""));
}

function forecastEvidenceForStation(station = {}) {
  const input = station.forecastInputSnapshot || station.inputSnapshot || {};
  const method = text(station.forecastMethod || station.method || "", 60);
  const source = text(station.forecastSource || station.source || "", 80);
  const dataAsOf = text(station.forecastDataAsOf || station.dataAsOf || station.forecastAsOf || "", 100);
  const p50 = finiteOrNull(station.forecastArrivalWaitP50 ?? station.arrivalForecast?.p50 ?? station.prediction?.p50 ?? station.p50);
  const p90 = finiteOrNull(station.forecastArrivalWaitP90 ?? station.arrivalForecast?.p90 ?? station.prediction?.p90 ?? station.p90);
  const hasPortSnapshot = method === "port-discrete-event" || Object.keys(input).some((key) => [
    "totalPorts", "idlePorts", "availablePorts", "reservedPorts", "chargingPorts", "faultPorts",
    "waitingVehicles", "queueVehicles", "reservationQueueAhead", "estimatedReleaseMinutes"
  ].includes(key));
  const result = {
    stationId: text(station.id, 80),
    stationName: text(station.name || "补能站", 100),
    method: method || "aggregate-flow-simulation",
    source: source || "simulation",
    simulation: station.forecastSimulation !== false,
    dataAsOf: dataAsOf || null,
    freshnessSeconds: boundedSnapshotValue(station.forecastFreshnessSeconds ?? station.freshnessSeconds, 0, 604800),
    arrivalWaitP50: p50,
    arrivalWaitP90: p90
  };
  if (hasPortSnapshot) {
    const waitingVehicles = boundedSnapshotValue(input.waitingVehicles ?? input.queueVehicles, 0, 5000);
    const queueVehicles = boundedSnapshotValue(input.queueVehicles ?? input.waitingVehicles, 0, 5000);
    result.portSnapshot = {
      totalPorts: boundedSnapshotValue(input.totalPorts, 1, 500),
      idlePorts: boundedSnapshotValue(input.idlePorts, 0, 500),
      availablePorts: boundedSnapshotValue(input.availablePorts ?? input.idlePorts, 0, 500),
      reservedPorts: boundedSnapshotValue(input.reservedPorts, 0, 500),
      chargingPorts: boundedSnapshotValue(input.chargingPorts, 0, 500),
      faultPorts: boundedSnapshotValue(input.faultPorts, 0, 500),
      waitingVehicles,
      queueVehicles,
      reservationQueueAhead: boundedSnapshotValue(input.reservationQueueAhead, 0, 5000),
      estimatedReleaseMinutes: Array.isArray(input.estimatedReleaseMinutes)
        ? input.estimatedReleaseMinutes.slice(0, MAX_RELEASE_MINUTES).map((value) => finiteOrNull(value)).filter((value) => value !== null).map((value) => Math.min(240, Math.max(0, value)))
        : [],
      averageSessionMinutes: finiteOrNull(input.averageSessionMinutes) === null
        ? null
        : Math.min(240, Math.max(1, finiteOrNull(input.averageSessionMinutes))),
      dataSource: text(input.dataSource || "FlowTwin 演示仿真", 100),
      availabilitySource: text(input.availabilitySource || "未标明来源", 100),
      queueSource: text(input.queueSource || "未标明来源", 100)
    };
  }
  return result;
}

function buildForecastEvidence(strategy, sourceStation, receivingStation) {
  const candidates = [
    sourceStation,
    receivingStation,
    ...(Array.isArray(strategy?.stations) ? strategy.stations : [])
  ].filter(Boolean);
  const seen = new Set();
  return candidates
    .filter((station) => {
      const key = String(station.id || station.name || "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_FORECAST_STATIONS)
    .map(forecastEvidenceForStation);
}

function aiForecastEvidenceForStation(evidence = {}) {
  const compact = {
    stationName: text(evidence.stationName || "补能站", 80),
    method: text(evidence.method || "aggregate-flow-simulation", 50),
    arrivalWaitP50: finiteOrNull(evidence.arrivalWaitP50),
    arrivalWaitP90: finiteOrNull(evidence.arrivalWaitP90)
  };
  if (evidence.portSnapshot) {
    compact.portSnapshot = {
      totalPorts: boundedSnapshotValue(evidence.portSnapshot.totalPorts, 1, 500),
      availablePorts: boundedSnapshotValue(evidence.portSnapshot.availablePorts ?? evidence.portSnapshot.idlePorts, 0, 500),
      reservedPorts: boundedSnapshotValue(evidence.portSnapshot.reservedPorts, 0, 500),
      waitingVehicles: boundedSnapshotValue(evidence.portSnapshot.waitingVehicles ?? evidence.portSnapshot.queueVehicles, 0, 5000),
      reservationQueueAhead: boundedSnapshotValue(evidence.portSnapshot.reservationQueueAhead, 0, 5000)
    };
  }
  return compact;
}

function boundedJson(value, maxBytes = MAX_AI_INPUT_BYTES) {
  const byteLength = (input) => Buffer.byteLength(input, "utf8");
  let result = JSON.stringify(value);
  if (byteLength(result) <= maxBytes) return result;
  const compact = {
    source: "FlowTwin 演示仿真",
    boundary: "来源为 FlowTwin 演示仿真；非企业实时经营结论。",
    congestionStation: value?.congestionStation || null,
    receivingStation: value?.receivingStation || null,
    metrics: value?.metrics || null
  };
  result = JSON.stringify(compact);
  if (byteLength(result) <= maxBytes) return result;
  return JSON.stringify({
    source: "FlowTwin 演示仿真",
    boundary: "来源为 FlowTwin 演示仿真；非企业实时经营结论。"
  });
}

function strategyFields(strategy, runId, strategyId, sourceStation, receivingStation, createdAt) {
  const names = FIELD_NAMES.strategy;
  const impact = strategy?.impact || {};
  const before = strategy?.before || {};
  const after = strategy?.after || {};
  const waitChange = finite(after.p90Wait) - finite(before.p90Wait);
  const forecastEvidence = buildForecastEvidence(strategy, sourceStation, receivingStation)
    .slice(0, MAX_AI_FORECAST_STATIONS)
    .map(aiForecastEvidenceForStation);
  const firstPortSnapshot = forecastEvidence[0]?.portSnapshot;
  return {
    [names.strategyId]: text(strategyId, 100),
    [names.runId]: text(runId, 100),
    [names.sourceStation]: text(sourceStation?.name || strategy?.sourceStation || "未指定", 100),
    [names.receivingStation]: text(receivingStation?.name || strategy?.targetStation?.name || "未指定", 100),
    [names.objective]: text(strategy?.targetUser || strategy?.targetSegment || "供需分流", 100),
    [names.discount]: finite(strategy?.discountAmount),
    [names.diverted]: finite(impact.divertedVehicles),
    [names.waitChange]: waitChange,
    [names.roi]: finite(impact.roi),
    [names.evidence]: boundedJson({
      source: "FlowTwin 演示仿真",
      boundary: "来源为 FlowTwin 演示仿真；非企业实时经营结论。",
      congestionStation: text(sourceStation?.name || strategy?.sourceStation || "未指定", 80),
      receivingStation: text(receivingStation?.name || strategy?.targetStation?.name || "未指定", 80),
      metrics: {
        discount: finite(strategy?.discountAmount),
        diverted: finite(impact.divertedVehicles),
        waitChange,
        roi: finite(impact.roi),
        recommendedDiscount: strategy?.recommendedDiscount ?? null,
        recommendedRoi: finite(strategy?.recommendedBasis?.roi),
        capacityBound: Boolean(strategy?.capacityBound),
        rule: text(strategy?.recommendation || strategy?.recommendedBasis?.rule || "待运营复核", 100),
        forecastP50: finiteOrNull(forecastEvidence[0]?.arrivalWaitP50),
        forecastP90: finiteOrNull(forecastEvidence[0]?.arrivalWaitP90),
        queueVehicles: finiteOrNull(firstPortSnapshot?.waitingVehicles ?? firstPortSnapshot?.queueVehicles)
      },
      forecastEvidence
    }),
    [names.risk]: text(strategy?.recommendation || strategy?.recommendedBasis?.rule || "待运营复核", 200),
    [names.approval]: "待确认",
    [names.createdAt]: dateTimeValue(createdAt)
  };
}

function syncFields(job, status, error = "") {
  const names = FIELD_NAMES.sync;
  const fields = {
    [names.syncId]: text(job.syncId, 100),
    [names.runId]: text(job.runId, 100),
    [names.status]: text(status, 40),
    [names.startedAt]: dateTimeValue(job.startedAt),
    [names.count]: finite(job.stationCount),
    [names.aiStatus]: text(job.aiStatus || "processing", 40),
    [names.error]: text(error, 300)
  };
  if (status === "completed" || status === "error") {
    fields[names.finishedAt] = dateTimeValue(new Date());
  }
  return fields;
}

async function createRecords({ config, token, tableId, fieldsList, fetchImpl }) {
  if (!fieldsList.length) return [];
  const data = await bitableRequest({
    config,
    token,
    fetchImpl,
    method: "POST",
    path: apiPath(config, tableId, "/batch_create"),
    body: { records: fieldsList.map((fields) => ({ fields })) }
  });
  return Array.isArray(data.records) ? data.records : [];
}

async function createRecord({ config, token, tableId, fields, fetchImpl }) {
  const data = await bitableRequest({
    config,
    token,
    fetchImpl,
    method: "POST",
    path: apiPath(config, tableId),
    body: { fields }
  });
  return data.record || data;
}

async function readRecord({ config, token, tableId, recordId, fetchImpl }) {
  const data = await bitableRequest({
    config,
    token,
    path: `${apiPath(config, tableId)}/${encodeURIComponent(recordId)}`,
    fetchImpl
  });
  return data.record || data;
}

async function updateRecord({ config, token, tableId, recordId, fields, fetchImpl }) {
  return bitableRequest({
    config,
    token,
    fetchImpl,
    method: "PUT",
    path: `${apiPath(config, tableId)}/${encodeURIComponent(recordId)}`,
    body: { fields }
  });
}

function extractFieldValue(record, fieldName) {
  const value = record?.fields?.[fieldName];
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => extractFieldValue({ fields: { value: item } }, "value")).filter(Boolean).join("、");
  if (typeof value === "object") return text(value.text || value.name || value.value || JSON.stringify(value), 2000);
  return "";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function makeJob(payload = {}, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  const runId = text(payload.runId || `flowtwin-${now.replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`, 100);
  const syncId = `sync-${randomUUID()}`;
  const validStationCount = Array.isArray(payload.stations)
    ? Math.min(payload.stations.filter(isPlainObject).length, MAX_STATIONS)
    : 0;
  return {
    runId,
    syncId,
    startedAt: now,
    createdAtMs: nowMs,
    stationCount: validStationCount,
    aiStatus: "processing",
    status: "syncing",
    strategyRecordId: "",
    syncRecordId: ""
  };
}

export async function startFeishuSync({
  payload = {},
  config = {},
  fetchImpl = fetch,
  now = Date.now,
  maxJobs = MAX_FEISHU_JOBS,
  jobTtlMs = FEISHU_JOB_TTL_MS
} = {}) {
  const nowMs = typeof now === "function" ? Number(now()) : Number(now) || Date.now();
  pruneJobs({ nowMs, maxJobs, jobTtlMs });

  if (!configReady(config)) {
    return {
      used: false,
      mode: "local-demo",
      status: "not-configured",
      code: "FEISHU_BITABLE_NOT_CONFIGURED",
      message: "未配置飞书多维表格，当前保留本地演示。"
    };
  }
  const existing = payload.runId ? runIndex.get(text(payload.runId, 100)) : null;
  if (existing) return existing.public || {
    used: true,
    mode: "feishu-bitable",
    status: existing.status,
    syncId: existing.syncId,
    runId: existing.runId,
    stationCount: existing.stationCount,
    message: "相同运行批次正在同步。"
  };

  const job = makeJob(payload, nowMs);
  jobs.set(job.syncId, job);
  runIndex.set(job.runId, job);
  pruneJobs({ nowMs, maxJobs, jobTtlMs });
  try {
    const token = await getTenantAccessToken(config, fetchImpl);
    const snapshotAt = new Date(nowMs).toISOString();
    const stations = Array.isArray(payload.stations)
      ? payload.stations.filter(isPlainObject).slice(0, MAX_STATIONS)
      : [];
    const snapshotRecords = await createRecords({
      config,
      token,
      tableId: config.feishuSnapshotTableId,
      fetchImpl,
      fieldsList: stations.map((station) => stationFields(station, job.runId, snapshotAt, payload.source, payload.dataAsOf))
    });
    const strategyInput = isPlainObject(payload.strategy) ? payload.strategy : payload;
    const strategyStations = Array.isArray(strategyInput.stations)
      ? strategyInput.stations.filter(isPlainObject).slice(0, MAX_STATIONS)
      : [];
    // The browser sends the snapshot list only once at the top level. Reuse it
    // server-side for fallback evidence without duplicating it in the request
    // body sent to the Feishu sync endpoint.
    const strategy = {
      ...strategyInput,
      stations: strategyStations.length ? strategyStations : stations
    };
    const sourceStation = strategy.sourceStation || strategy.stations?.slice?.().sort?.((a, b) => Number(b.p90 || 0) - Number(a.p90 || 0))[0];
    const strategyId = `strategy-${randomUUID()}`;
    const strategyRecord = await createRecord({
      config,
      token,
      tableId: config.feishuStrategyTableId,
      fetchImpl,
      fields: strategyFields(strategy, job.runId, strategyId, sourceStation, strategy.targetStation, snapshotAt)
    });
    job.strategyRecordId = text(strategyRecord.record_id || strategyRecord.recordId, 200);
    job.status = "processing";
    job.stationCount = snapshotRecords.length || stations.length;
    if (config.feishuSyncTableId) {
      try {
        const syncRecord = await createRecord({
          config,
          token,
          tableId: config.feishuSyncTableId,
          fetchImpl,
          fields: syncFields(job, job.status)
        });
        job.syncRecordId = text(syncRecord.record_id || syncRecord.recordId, 200);
      } catch {
        // Optional sync log table write failure must not abort strategy sync.
      }
    }
    const publicResult = {
      used: true,
      mode: "feishu-bitable",
      status: job.status,
      syncId: job.syncId,
      runId: job.runId,
      stationCount: job.stationCount,
      strategyRecordId: job.strategyRecordId,
      source: "FlowTwin 演示仿真",
      message: "运营快照已同步，正在等待飞书 AI 字段完成分析。"
    };
    job.public = publicResult;
    jobs.set(job.syncId, job);
    pruneJobs({ nowMs, maxJobs, jobTtlMs });
    return publicResult;
  } catch (error) {
    job.status = "error";
    job.aiStatus = "error";
    const errorResult = {
      used: false,
      mode: "error",
      status: "error",
      syncId: job.syncId,
      runId: job.runId,
      code: error?.code || "FEISHU_SYNC_FAILED",
      retryable: isRetryableFeishuError(error),
      message: "飞书同步失败，请检查应用权限、表格字段和接口频控。"
    };
    job.public = errorResult;
    jobs.set(job.syncId, job);
    runIndex.delete(job.runId);
    pruneJobs({ nowMs, maxJobs, jobTtlMs });
    return errorResult;
  }
}

export async function getFeishuSyncStatus({
  syncId,
  config = {},
  fetchImpl = fetch,
  now = Date.now,
  maxJobs = MAX_FEISHU_JOBS,
  jobTtlMs = FEISHU_JOB_TTL_MS
} = {}) {
  const nowMs = typeof now === "function" ? Number(now()) : Number(now) || Date.now();
  pruneJobs({ nowMs, maxJobs, jobTtlMs });
  const job = jobs.get(text(syncId, 120));
  if (!job) return { used: false, mode: "error", code: "FEISHU_SYNC_NOT_FOUND", message: "同步记录不存在或服务已重启。" };
  if (job.status === "error") return { used: false, mode: "error", ...job.public, status: "error" };
  if (job.status === "syncing" || !job.strategyRecordId) {
    return {
      used: true,
      mode: "feishu-bitable",
      status: "syncing",
      aiStatus: job.aiStatus || "processing",
      syncId: job.syncId,
      runId: job.runId,
      stationCount: job.stationCount,
      aiResult: null,
      source: "FlowTwin 演示仿真",
      message: "正在写入飞书多维表格，请稍后刷新。"
    };
  }
  try {
    const token = await getTenantAccessToken(config, fetchImpl);
    const record = await readRecord({ config, token, tableId: config.feishuStrategyTableId, recordId: job.strategyRecordId, fetchImpl });
    const aiResult = extractFieldValue(record, config.feishuAiStrategyField || "AI策略");
    const completed = Boolean(aiResult.trim());
    const previousStatus = job.status;
    const previousAiStatus = job.aiStatus;
    job.aiStatus = completed ? "completed" : "processing";
    job.status = completed ? "completed" : "processing";
    const statusChanged = job.status !== previousStatus || job.aiStatus !== previousAiStatus;
    if (statusChanged && job.syncRecordId && config.feishuSyncTableId) {
      try {
        await updateRecord({
          config,
          token,
          tableId: config.feishuSyncTableId,
          recordId: job.syncRecordId,
          fields: syncFields(job, job.status),
          fetchImpl
        });
      } catch {
        // Optional sync table updates must not discard the already-fetched AI result.
      }
    }
    return {
      used: true,
      mode: "feishu-bitable",
      status: job.status,
      aiStatus: job.aiStatus,
      syncId: job.syncId,
      runId: job.runId,
      stationCount: job.stationCount,
      aiResult: aiResult || null,
      source: "FlowTwin 演示仿真",
      message: completed ? "飞书 AI 分析已完成。" : "飞书 AI 正在分析，请稍后刷新。"
    };
  } catch (error) {
    return {
      used: false,
      mode: "error",
      status: "error",
      syncId: job.syncId,
      code: error?.code || "FEISHU_STATUS_FAILED",
      retryable: isRetryableFeishuError(error),
      message: isRetryableFeishuError(error)
        ? "飞书 AI 读取暂时波动，可自动重试。"
        : "暂时无法读取飞书 AI 结果，请检查应用权限和 AI 字段配置。"
    };
  }
}

export async function approveFeishuStrategy({ strategyRecordId, status = "已确认", config = {}, fetchImpl = fetch } = {}) {
  const normalizedRecordId = typeof strategyRecordId === "string" ? strategyRecordId.trim() : "";
  if (!STRATEGY_RECORD_ID_PATTERN.test(normalizedRecordId)) {
    return {
      used: false,
      mode: "error",
      code: "INVALID_STRATEGY_RECORD_ID",
      message: "策略记录 ID 无效。"
    };
  }
  const normalizedStatus = typeof status === "string" ? status.trim() : "";
  if (!ALLOWED_APPROVAL_STATUS_SET.has(normalizedStatus)) {
    return {
      used: false,
      mode: "error",
      code: "INVALID_APPROVAL_STATUS",
      message: "不支持的审批状态。"
    };
  }
  if (!configReady(config)) return { used: false, mode: "local-demo", code: "FEISHU_BITABLE_NOT_CONFIGURED" };
  try {
    const token = await getTenantAccessToken(config, fetchImpl);
    await updateRecord({
      config,
      token,
      tableId: config.feishuStrategyTableId,
      recordId: normalizedRecordId,
      fields: { [config.feishuApprovalField || "审批状态"]: normalizedStatus },
      fetchImpl
    });
    return { used: true, mode: "feishu-bitable", status: normalizedStatus, message: "策略状态已写回飞书。" };
  } catch (error) {
    return { used: false, mode: "error", code: error?.code || "FEISHU_APPROVAL_FAILED", message: "策略状态写回失败。" };
  }
}

export function feishuCacheStats() {
  return {
    jobs: jobs.size,
    runIndex: runIndex.size,
    tokens: tokenCache.size
  };
}

export function clearFeishuCaches() {
  jobs.clear();
  runIndex.clear();
  tokenCache.clear();
}
