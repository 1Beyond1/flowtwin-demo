import { randomUUID } from "node:crypto";

const DEFAULT_FEISHU_BASE_URL = "https://open.feishu.cn";
const MAX_STATIONS = 40;
const MAX_TEXT = 500;
const MAX_FORECAST_STATIONS = 6;
const MAX_RELEASE_MINUTES = 12;
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
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// Feishu Bitable date fields (type 5) accept Unix timestamps in milliseconds,
// not ISO-8601 strings. Keep the input boundary flexible because the rest of
// FlowTwin naturally carries ISO timestamps.
function dateTimeValue(value, fallback = Date.now()) {
  if (value === null || value === undefined || value === "") return "";
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
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

function apiPath(config, tableId, suffix = "") {
  const appToken = encodeURIComponent(text(config.feishuAppToken, 300));
  const table = encodeURIComponent(text(tableId, 200));
  return `/open-apis/bitable/v1/apps/${appToken}/tables/${table}/records${suffix}`;
}

async function getTenantAccessToken(config, fetchImpl) {
  const appId = text(config.feishuAppId, 200);
  const appSecret = text(config.feishuAppSecret, 300);
  const cached = tokenCache.get(appId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const baseUrl = safeBaseUrl(config.feishuBaseUrl);
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
  tokenCache.set(appId, { token: payload.tenant_access_token, expiresAt: Date.now() + expiresIn * 1000 });
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
  return {
    [names.runId]: text(runId, 100),
    [names.snapshotAt]: dateTimeValue(snapshotAt),
    [names.stationId]: text(station.id, 100),
    [names.stationName]: text(station.name || "补能站", 100),
    [names.city]: text(station.city || station.region || "沿线", 80),
    [names.energyType]: text(station.type || "未知", 40),
    [names.capacity]: finite(station.capacity),
    [names.occupancy]: finite(station.occupancy),
    [names.arrivals15m]: finite(station.arrivals15m ?? station.arrivalRate),
    [names.serviceRate]: finite(station.serviceRate),
    [names.p50]: finite(station.p50 ?? station.wait),
    [names.p90]: finite(station.p90 ?? station.wait),
    [names.price]: finite(station.price),
    [names.discount]: finite(station.discount),
    [names.diversion]: finite(station.diversionRate),
    [names.roi]: finite(station.roi),
    [names.source]: text(source || station.source || "FlowTwin 演示仿真", 160),
    [names.dataAsOf]: dateTimeValue(dataAsOf || snapshotAt)
  };
}

function finiteOrNull(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function boundedSnapshotValue(value, min, max) {
  const result = finiteOrNull(value);
  if (result === null) return null;
  return Math.min(max, Math.max(min, Math.round(result)));
}

function forecastEvidenceForStation(station = {}) {
  const input = station.forecastInputSnapshot || station.inputSnapshot || {};
  const method = text(station.forecastMethod || station.method || "", 60);
  const source = text(station.forecastSource || station.source || "", 80);
  const dataAsOf = text(station.forecastDataAsOf || station.dataAsOf || station.forecastAsOf || "", 100);
  const p50 = finiteOrNull(station.forecastArrivalWaitP50 ?? station.arrivalForecast?.p50 ?? station.prediction?.p50 ?? station.p50);
  const p90 = finiteOrNull(station.forecastArrivalWaitP90 ?? station.arrivalForecast?.p90 ?? station.prediction?.p90 ?? station.p90);
  const hasPortSnapshot = method === "port-discrete-event" || Object.keys(input).some((key) => [
    "totalPorts", "idlePorts", "chargingPorts", "faultPorts", "queueVehicles", "estimatedReleaseMinutes"
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
    result.portSnapshot = {
      totalPorts: boundedSnapshotValue(input.totalPorts, 1, 500),
      idlePorts: boundedSnapshotValue(input.idlePorts, 0, 500),
      chargingPorts: boundedSnapshotValue(input.chargingPorts, 0, 500),
      faultPorts: boundedSnapshotValue(input.faultPorts, 0, 500),
      queueVehicles: boundedSnapshotValue(input.queueVehicles, 0, 5000),
      estimatedReleaseMinutes: Array.isArray(input.estimatedReleaseMinutes)
        ? input.estimatedReleaseMinutes.slice(0, MAX_RELEASE_MINUTES).map((value) => finiteOrNull(value)).filter((value) => value !== null).map((value) => Math.min(240, Math.max(0, value)))
        : [],
      averageSessionMinutes: finiteOrNull(input.averageSessionMinutes) === null
        ? null
        : Math.min(240, Math.max(1, finiteOrNull(input.averageSessionMinutes))),
      dataSource: text(input.dataSource || "FlowTwin 演示仿真", 100)
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

function boundedJson(value, max = 2000) {
  let result = JSON.stringify(value);
  if (result.length <= max) return result;
  const compact = { ...value, forecastEvidence: Array.isArray(value.forecastEvidence) ? value.forecastEvidence.slice(0, 2) : [] };
  result = JSON.stringify(compact);
  if (result.length <= max) return result;
  return JSON.stringify({ source: "FlowTwin 演示仿真", evidenceTruncated: true });
}

function strategyFields(strategy, runId, strategyId, sourceStation, receivingStation, createdAt) {
  const names = FIELD_NAMES.strategy;
  const impact = strategy?.impact || {};
  const before = strategy?.before || {};
  const after = strategy?.after || {};
  return {
    [names.strategyId]: text(strategyId, 100),
    [names.runId]: text(runId, 100),
    [names.sourceStation]: text(sourceStation?.name || strategy?.sourceStation || "未指定", 100),
    [names.receivingStation]: text(receivingStation?.name || strategy?.targetStation?.name || "未指定", 100),
    [names.objective]: text(strategy?.targetUser || strategy?.targetSegment || "供需分流", 100),
    [names.discount]: finite(strategy?.discountAmount),
    [names.diverted]: finite(impact.divertedVehicles),
    [names.waitChange]: finite(after.p90Wait) - finite(before.p90Wait),
    [names.roi]: finite(impact.roi),
    [names.evidence]: boundedJson({
      recommendedDiscount: strategy?.recommendedDiscount ?? null,
      recommendedRoi: finite(strategy?.recommendedBasis?.roi),
      capacityBound: Boolean(strategy?.capacityBound),
      source: "FlowTwin 演示仿真",
      analysisBoundary: "仅解释 FlowTwin 仿真记录；不得把仿真说成企业实时经营数据，不得重算或篡改 P50、P90、ROI；字段缺失时明确说明。",
      forecastEvidence: buildForecastEvidence(strategy, sourceStation, receivingStation)
    }),
    [names.risk]: text(strategy?.recommendation || strategy?.recommendedBasis?.rule || "待运营复核", 200),
    [names.approval]: "待确认",
    [names.createdAt]: dateTimeValue(createdAt)
  };
}

function syncFields(job, status, error = "") {
  const names = FIELD_NAMES.sync;
  return {
    [names.syncId]: text(job.syncId, 100),
    [names.runId]: text(job.runId, 100),
    [names.status]: text(status, 40),
    [names.startedAt]: dateTimeValue(job.startedAt),
    [names.finishedAt]: status === "completed" || status === "error" ? dateTimeValue(new Date()) : "",
    [names.count]: finite(job.stationCount),
    [names.aiStatus]: text(job.aiStatus || "processing", 40),
    [names.error]: text(error, 300)
  };
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

function makeJob(payload = {}) {
  const now = new Date().toISOString();
  const runId = text(payload.runId || `flowtwin-${now.replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`, 100);
  const syncId = `sync-${randomUUID()}`;
  return {
    runId,
    syncId,
    startedAt: now,
    stationCount: Array.isArray(payload.stations) ? Math.min(payload.stations.length, MAX_STATIONS) : 0,
    aiStatus: "processing",
    status: "syncing",
    strategyRecordId: "",
    syncRecordId: ""
  };
}

export async function startFeishuSync({ payload = {}, config = {}, fetchImpl = fetch } = {}) {
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

  const job = makeJob(payload);
  runIndex.set(job.runId, job);
  try {
    const token = await getTenantAccessToken(config, fetchImpl);
    const snapshotAt = new Date().toISOString();
    const stations = Array.isArray(payload.stations) ? payload.stations.slice(0, MAX_STATIONS) : [];
    const snapshotRecords = await createRecords({
      config,
      token,
      tableId: config.feishuSnapshotTableId,
      fetchImpl,
      fieldsList: stations.map((station) => stationFields(station, job.runId, snapshotAt, payload.source, payload.dataAsOf))
    });
    const strategy = payload.strategy || payload;
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
      const syncRecord = await createRecord({
        config,
        token,
        tableId: config.feishuSyncTableId,
        fetchImpl,
        fields: syncFields(job, job.status)
      });
      job.syncRecordId = text(syncRecord.record_id || syncRecord.recordId, 200);
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
    return publicResult;
  } catch (error) {
    jobs.set(job.syncId, job);
    runIndex.delete(job.runId);
    job.status = "error";
    job.aiStatus = "error";
    return {
      used: false,
      mode: "error",
      status: "error",
      syncId: job.syncId,
      runId: job.runId,
      code: error?.code || "FEISHU_SYNC_FAILED",
      message: "飞书同步失败，请检查应用权限、表格字段和接口频控。"
    };
  }
}

export async function getFeishuSyncStatus({ syncId, config = {}, fetchImpl = fetch } = {}) {
  const job = jobs.get(text(syncId, 120));
  if (!job) return { used: false, mode: "error", code: "FEISHU_SYNC_NOT_FOUND", message: "同步记录不存在或服务已重启。" };
  if (job.status === "error") return { used: false, mode: "error", ...job.public, status: "error" };
  try {
    const token = await getTenantAccessToken(config, fetchImpl);
    const record = await readRecord({ config, token, tableId: config.feishuStrategyTableId, recordId: job.strategyRecordId, fetchImpl });
    const aiResult = extractFieldValue(record, config.feishuAiStrategyField || "AI策略");
    const completed = Boolean(aiResult.trim());
    job.aiStatus = completed ? "completed" : "processing";
    job.status = completed ? "completed" : "processing";
    if (job.syncRecordId && config.feishuSyncTableId) {
      await updateRecord({
        config,
        token,
        tableId: config.feishuSyncTableId,
        recordId: job.syncRecordId,
        fields: syncFields(job, job.status)
      });
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
      message: "暂时无法读取飞书 AI 结果，请稍后重试。"
    };
  }
}

export async function approveFeishuStrategy({ strategyRecordId, status = "已确认", config = {}, fetchImpl = fetch } = {}) {
  if (!configReady(config)) return { used: false, mode: "local-demo", code: "FEISHU_BITABLE_NOT_CONFIGURED" };
  try {
    const token = await getTenantAccessToken(config, fetchImpl);
    await updateRecord({
      config,
      token,
      tableId: config.feishuStrategyTableId,
      recordId: text(strategyRecordId, 200),
      fields: { [config.feishuApprovalField || "审批状态"]: text(status, 40) },
      fetchImpl
    });
    return { used: true, mode: "feishu-bitable", status: text(status, 40), message: "策略状态已写回飞书。" };
  } catch (error) {
    return { used: false, mode: "error", code: error?.code || "FEISHU_APPROVAL_FAILED", message: "策略状态写回失败。" };
  }
}

export function clearFeishuCaches() {
  jobs.clear();
  runIndex.clear();
  tokenCache.clear();
}
