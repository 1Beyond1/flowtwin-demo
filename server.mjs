import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.mjs";
import { parseTripIntent, formatPlanResponse, planLimits } from "./lib/plan.mjs";
import { forecastStations } from "./lib/forecast.mjs";
import { simulateOperator } from "./lib/operator.mjs";
import { validateStrategies } from "./lib/validate.mjs";
import { executeFeishu } from "./lib/feishu.mjs";
import { buildLongTripPlans } from "./lib/longtrip.mjs";
import { API_CONTRACTS } from "./lib/contracts.mjs";
import { cleanTranscriptText, polishTranscriptText } from "./lib/stt.mjs";
import { hasAmapServiceKey, requestAmapJson } from "./lib/amap.mjs";
import {
  feishuConfigSummary,
  startFeishuSync,
  getFeishuSyncStatus,
  approveFeishuStrategy
} from "./lib/feishu-bitable.mjs";
import { createVersionChecker, loadVersionInfo, resolveVersionRoute } from "./lib/version.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
let config = null;
let versionInfo = null;
let versionChecker = null;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function parseCoordinate(value) {
  const parts = String(value || "").trim().split(",");
  if (parts.length !== 2 || parts.some((part) => !part || part.length > 24)) return null;
  const [longitude, latitude] = parts.map(Number);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude < 73 || longitude > 136 || latitude < 18 || latitude > 54) return null;
  return `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
}

function normalizePath(path, key, station) {
  const steps = Array.isArray(path.steps) ? path.steps : [];
  const points = steps.flatMap((step) => String(step.polyline || "").split(";")).map((point) => point.split(",").map(Number)).filter((point) => point.length === 2 && point.every(Number.isFinite));
  return {
    key,
    station,
    path: points,
    distance: Number(path.distance || 0) / 1000,
    duration: Number(path.cost?.duration || 0) / 60,
    tolls: Number(path.cost?.tolls || 0),
    policy: path.strategy || key,
    source: "高德 Web 路线 2.0"
  };
}

async function routeApi(requestUrl, response) {
  const origin = parseCoordinate(requestUrl.searchParams.get("origin"));
  const destination = parseCoordinate(requestUrl.searchParams.get("destination"));
  const waypoint = parseCoordinate(requestUrl.searchParams.get("waypoint"));
  const key = requestUrl.searchParams.get("plan") || "reliable";
  const strategies = { fastest: "38", reliable: "33", cheapest: "36" };
  if (!origin || !destination || !strategies[key]) return json(response, 400, { error: "INVALID_ROUTE_PARAMS" });

  if (!hasAmapServiceKey(config)) return json(response, 503, { error: "AMAP_WEB_SERVICE_KEY_MISSING" });
  const params = new URLSearchParams({
    origin,
    destination,
    strategy: strategies[key],
    cartype: requestUrl.searchParams.get("cartype") === "0" ? "0" : "1",
    ferry: "1",
    show_fields: "cost,navi,polyline"
  });
  if (waypoint) params.set("waypoints", waypoint);
  const result = (await requestAmapJson("https://restapi.amap.com/v5/direction/driving", params, { config, timeoutMs: 15000 })).payload || {};
  const paths = Array.isArray(result.route?.paths) ? result.route.paths : [];
  if (result.status !== "1" || !paths.length) return json(response, 502, { error: result.info || "AMAP_ROUTE_FAILED", infocode: result.infocode || null });
  const station = waypoint ? { location: waypoint.split(",").map(Number) } : null;
  return json(response, 200, {
    route: normalizePath(paths[0], key, station),
    alternatives: paths.length,
    source: "高德 Web 服务路线规划 2.0"
  });
}

const POI_SEARCH_TYPES = new Set(["fuel", "electric", "service", "meal", "coffee", "rest"]);
const SERVICE_POI_TYPES = new Set(["meal", "coffee", "rest"]);
const DEFAULT_POI_KEYWORDS = {
  fuel: "加油站",
  electric: "充电站",
  service: "服务区",
  meal: "餐厅",
  coffee: "咖啡厅",
  rest: "休息区"
};

function cleanPoiKeyword(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 60);
}

/**
 * Build the bounded AMap POI request.  Service keywords are user intent, not
 * credentials; only the server-side AMap key is kept out of the browser.
 */
export function buildPoiSearchRequest({ location, type, keyword } = {}) {
  const normalizedLocation = parseCoordinate(location);
  if (!normalizedLocation) return null;
  const normalizedType = POI_SEARCH_TYPES.has(type) ? type : "electric";
  const requestedKeyword = SERVICE_POI_TYPES.has(normalizedType) ? cleanPoiKeyword(keyword) : "";
  const resolvedKeyword = requestedKeyword || DEFAULT_POI_KEYWORDS[normalizedType];
  return {
    location: normalizedLocation,
    type: normalizedType,
    keyword: resolvedKeyword,
    params: new URLSearchParams({
      location: normalizedLocation,
      keywords: resolvedKeyword,
      radius: "30000",
      page_size: "20",
      page_num: "1",
      show_fields: "business,children"
    })
  };
}

// The browser-side PlaceSearch SDK is useful for map interaction, but it can
// return sparse results for motorway points far from a city centre. Query the
// same AMap Web Service from the local server for route-corridor POIs so the
// web-service key stays server-side and cross-province sampling is stable.
async function poiApi(requestUrl, response) {
  const search = buildPoiSearchRequest({
    location: requestUrl.searchParams.get("location"),
    type: requestUrl.searchParams.get("type"),
    keyword: requestUrl.searchParams.get("keyword")
  });
  if (!search) return json(response, 400, { error: "INVALID_POI_LOCATION" });
  const { location, type, keyword, params } = search;
  if (!hasAmapServiceKey(config)) return json(response, 503, { error: "AMAP_WEB_SERVICE_KEY_MISSING" });
  const result = (await requestAmapJson("https://restapi.amap.com/v5/place/around", params, { config, timeoutMs: 15000 })).payload || {};
  let pois = Array.isArray(result.pois) ? result.pois : [];
  if (result.status !== "1") {
    // POI discovery is an optional enrichment layer. A temporary quota or
    // upstream failure should let the browser use its SDK/fallback candidates
    // without turning the normal planning flow into a wall of 502 console
    // errors. The response remains explicit and never claims that POI data was
    // retrieved successfully.
    return json(response, 200, {
      pois: [],
      source: "高德 POI 暂不可用 · 已进入候选降级",
      degraded: true,
      warning: result.info || "AMAP_POI_FAILED",
      infocode: result.infocode || null,
      kind: type
    });
  }
  let source = "高德周边 POI";
  // Motorway samples often sit outside an urban POI radius even though the
  // nearest city has public charging stations. When the around-search is
  // empty, resolve the city first and perform a constrained city text search.
  // The returned POIs still go through the browser's route-corridor and detour
  // filters; this only broadens data discovery, not the safety judgement.
  if (!pois.length) {
    try {
      const reverseParams = new URLSearchParams({ location, radius: "1000", extensions: "base" });
      const reversePayload = (await requestAmapJson("https://restapi.amap.com/v3/geocode/regeo", reverseParams, { config, timeoutMs: 10000 })).payload || {};
      const cityValue = reversePayload?.regeocode?.addressComponent?.city;
      const city = Array.isArray(cityValue) ? cityValue.find(Boolean) : cityValue;
      if (reversePayload.status === "1" && typeof city === "string" && city.trim()) {
        const textParams = new URLSearchParams({
          keywords: keyword, city: city.trim(), citylimit: "true", offset: "25", page: "1", extensions: "base"
        });
        const textPayload = (await requestAmapJson("https://restapi.amap.com/v3/place/text", textParams, { config, timeoutMs: 10000 })).payload || {};
        if (textPayload.status === "1" && Array.isArray(textPayload.pois)) {
          pois = textPayload.pois;
          source = "高德城市文本 POI";
        }
      }
    } catch {
      // Empty search remains a valid, explicit absence of a confirmed POI.
    }
  }
  return json(response, 200, {
    pois: pois.map((poi) => ({
      id: poi.id,
      name: poi.name,
      address: poi.address,
      location: poi.location,
      tel: poi.tel,
      distance: poi.distance
    })),
    source,
    kind: type,
    requestedKeyword: keyword
  });
}

async function runtimeConfig(response) {
  const { amapKey, securityJsCode, sttApiKey } = config;
  // Only browser-safe map settings leave the server. STT keys stay server-side;
  // expose a boolean so the mic button can show a clear "not configured" state.
  const body = `window.FLOWTWIN_CONFIG=${JSON.stringify({
    amapKey,
    securityJsCode,
    mapMode: amapKey ? "live" : "fallback",
    sttEnabled: Boolean(sttApiKey)
  })};`;
  response.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

async function readRawBody(request, maxBytes = 8_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("REQUEST_TOO_LARGE"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function extractMultipartFile(buffer, contentType) {
  const boundaryMatch = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const parts = buffer.toString("binary").split(`--${boundary}`);
  for (const part of parts) {
    if (!/name="(?:file|audio)"/i.test(part) || !/Content-Disposition:/i.test(part)) continue;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    let body = part.slice(headerEnd + 4);
    if (body.endsWith("\r\n")) body = body.slice(0, -2);
    if (body.endsWith("--")) body = body.slice(0, -2);
    if (body.endsWith("\r\n")) body = body.slice(0, -2);
    const filename = headers.match(/filename="([^"]*)"/i)?.[1] || "audio.webm";
    const mime = headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim() || "application/octet-stream";
    return {
      filename,
      mime,
      data: Buffer.from(body, "binary")
    };
  }
  return null;
}

async function sttApi(request, response) {
  // Keys stay server-side; never log Authorization or audio payloads.
  if (!config.sttApiKey || !config.sttBaseUrl) return json(response, 503, { error: "STT_NOT_CONFIGURED" });
  const contentType = String(request.headers["content-type"] || "");
  const raw = await readRawBody(request, 8_000_000);
  if (!raw.length) return json(response, 400, { error: "STT_EMPTY_AUDIO" });

  let fileBuffer = raw;
  let filename = "audio.webm";
  let mime = contentType.split(";")[0].trim() || "application/octet-stream";

  if (contentType.toLowerCase().includes("multipart/form-data")) {
    const file = extractMultipartFile(raw, contentType);
    if (!file?.data?.length) return json(response, 400, { error: "AUDIO_FILE_REQUIRED" });
    fileBuffer = file.data;
    filename = file.filename || filename;
    mime = file.mime || mime;
  } else if (!contentType || contentType.toLowerCase().includes("application/json")) {
    return json(response, 400, { error: "AUDIO_BODY_REQUIRED" });
  }

  const form = new FormData();
  form.append("model", config.sttModel || "FunAudioLLM/SenseVoiceSmall");
  form.append("file", new Blob([fileBuffer], { type: mime }), filename);

  try {
    const upstream = await fetch(`${config.sttBaseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.sttApiKey}` },
      body: form,
      signal: AbortSignal.timeout(45000)
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return json(response, upstream.status === 429 ? 429 : 502, {
        error: upstream.status === 429 ? "STT_RATE_LIMITED" : "STT_UPSTREAM_ERROR"
      });
    }
    const rawText = String(payload.text || "").trim();
    if (!rawText) return json(response, 502, { error: "STT_EMPTY_TRANSCRIPT" });
    // SenseVoice embeds emotion/language tags; strip them, then optionally
    // ask the plan model to polish into a clean travel sentence.
    const stripped = cleanTranscriptText(rawText);
    const text = await polishTranscriptText(stripped || rawText, config);
    if (!text) return json(response, 502, { error: "STT_EMPTY_TRANSCRIPT" });
    return json(response, 200, {
      text,
      rawText: rawText === text ? undefined : rawText
    });
  } catch {
    return json(response, 502, { error: "STT_UPSTREAM_ERROR" });
  }
}

async function readJsonBody(request, maxBytes = 32768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("REQUEST_TOO_LARGE"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_JSON_OBJECT");
    return parsed;
  } catch {
    throw Object.assign(new Error("INVALID_JSON"), { statusCode: 400 });
  }
}

const LONG_TRIP_ENERGY_TYPES = new Set(["electric", "fuel", "hybridElectric", "hybridFuel"]);
const SAFE_MAPPING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function safeNumber(value, min, max, { integer = false, clamp = true } = {}) {
  if (value === null || value === undefined || typeof value === "boolean") return undefined;
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  if (!clamp && (parsed < min || parsed > max)) return undefined;
  const bounded = clamp ? Math.max(min, Math.min(max, parsed)) : parsed;
  return integer ? Math.floor(bounded) : bounded;
}

function safeDepartureMinutes(value) {
  const numeric = safeNumber(value, 0, 24 * 60);
  if (numeric !== undefined) return numeric;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60
    ? hour * 60 + minute
    : undefined;
}

function safeOffsetMapping(value) {
  if (!isObject(value)) return undefined;
  const result = {};
  let accepted = 0;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (accepted >= 200 || SAFE_MAPPING_KEYS.has(rawKey)) continue;
    const key = rawKey.trim();
    if (!key || key.length > 120) continue;
    const offset = safeNumber(rawValue, 0, 7 * 24 * 60);
    if (offset === undefined) continue;
    result[key] = offset;
    accepted += 1;
  }
  return accepted ? result : undefined;
}

function copyNumber(source, target, key, min, max, options) {
  if (!own(source, key)) return;
  const value = safeNumber(source[key], min, max, options);
  if (value !== undefined) target[key] = value;
}

function copyDeparture(source, target) {
  if (!own(source, "departureMinutes")) return;
  const value = safeDepartureMinutes(source.departureMinutes);
  if (value !== undefined) target.departureMinutes = value;
}

function copyForecastScenarioFields(source, target) {
  copyDeparture(source, target);
  copyNumber(source, target, "weatherFactor", 0.8, 1.5);
  copyNumber(source, target, "trafficFactor", 0.7, 1.5);
  copyNumber(source, target, "demandFactor", 0.5, 2);
  copyNumber(source, target, "horizonMinutes", 5, 240);
  copyNumber(source, target, "intervalMinutes", 1, 60);
  for (const key of ["arrivalOffsetMinutes", "arrivalMinutes", "etaMinutes"]) {
    copyNumber(source, target, key, 0, 7 * 24 * 60);
  }
  for (const key of ["arrivalOffsets", "etaByStation", "arrivalByStation"]) {
    if (!own(source, key)) continue;
    const value = safeOffsetMapping(source[key]);
    if (value !== undefined) target[key] = value;
  }
}

/**
 * Build the only long-trip fields that the HTTP API is allowed to pass to the
 * planner.  Keeping this constructor pure makes the boundary testable without
 * booting the server or touching an upstream service.
 */
export function buildLongTripApiInput(body = {}) {
  const source = isObject(body) ? body : {};
  const target = {};
  if (Array.isArray(source.stations)) target.stations = source.stations.slice(0, 40);

  copyNumber(source, target, "distanceKm", 0, 6000, { clamp: false });
  copyNumber(source, target, "durationMinutes", 0, 7 * 24 * 60);
  copyNumber(source, target, "soc", 0, 100);
  copyNumber(source, target, "minArrivalSoc", 0, 100);
  copyNumber(source, target, "maxStops", 0, 6, { integer: true });
  copyNumber(source, target, "maxDetourKm", 0, 1000);
  copyDeparture(source, target);
  copyNumber(source, target, "deadlineOffsetMinutes", 0, 7 * 24 * 60);
  copyNumber(source, target, "deadlineMinutes", 0, 7 * 24 * 60);
  copyNumber(source, target, "arrivalDeadlineMinutes", 0, 7 * 24 * 60);
  copyForecastScenarioFields(source, target);

  if (typeof source.energyType === "string" && LONG_TRIP_ENERGY_TYPES.has(source.energyType)) {
    target.energyType = source.energyType;
  }
  if (typeof source.useForecast === "boolean") target.useForecast = source.useForecast;
  return target;
}

/**
 * Normalize the forecast scenario independently from the server configuration.
 * In particular, station-arrival mappings are copied as bounded scalar maps;
 * arbitrary nested request data never reaches the forecast model.
 */
export function buildForecastApiScenario(scenario = {}) {
  const source = isObject(scenario) ? scenario : {};
  const target = {};
  copyForecastScenarioFields(source, target);
  return target;
}

async function planApi(request, response) {
  const body = await readJsonBody(request, 32768);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > planLimits.MAX_MESSAGE_LENGTH) return json(response, 400, { error: "MESSAGE_REQUIRED_OR_TOO_LONG", maxLength: planLimits.MAX_MESSAGE_LENGTH });
  const context = body.context && typeof body.context === "object" && !Array.isArray(body.context) ? body.context : {};
  const result = await parseTripIntent({ message, context, config });
  return json(response, 200, formatPlanResponse(result));
}

async function forecastApi(request, response) {
  const body = await readJsonBody(request, 128000);
  if (body.stations !== undefined && !Array.isArray(body.stations)) return json(response, 400, { error: "STATIONS_MUST_BE_ARRAY" });
  const scenario = buildForecastApiScenario(body.scenario);
  const result = forecastStations(body.stations || [], scenario);
  // Keep the model's existing response shape while making the accepted
  // departure/arrival scenario auditable to API callers. Only normalized
  // scenario fields are reflected; request data cannot replace server config.
  return json(response, 200, {
    ...result,
    scenario: { ...result.scenario, ...scenario }
  });
}

// 高德天气文案 -> 对补能等待的放大因子与是否恶劣。雨天/雪天更多人充电、服务也
// 更慢，预测模型据此抬高 P50/P90。只做有方向的放大，不编造精确系数。
const WEATHER_FACTOR_TABLE = [
  { match: /暴雪|大暴雨|暴雨|特大暴雨|强沙尘暴/, factor: 1.30, severe: true },
  { match: /大雪|暴风雨/, factor: 1.26, severe: true },
  { match: /大雨/, factor: 1.20, severe: false },
  { match: /中雪|雨夹雪/, factor: 1.16, severe: false },
  { match: /中雨|雷阵雨/, factor: 1.14, severe: false },
  { match: /小雨|阵雨|小雪|阵雪|冻雨/, factor: 1.10, severe: false },
  { match: /雾|霾/, factor: 1.08, severe: false },
  { match: /沙|浮尘|扬沙/, factor: 1.08, severe: false }
];
function weatherImpactFor(condition) {
  const text = String(condition || "");
  for (const row of WEATHER_FACTOR_TABLE) if (row.match.test(text)) return { weatherFactor: row.factor, severe: row.severe };
  return { weatherFactor: 1, severe: false };
}

const weatherCache = new Map();
const WEATHER_CACHE_MS = 10 * 60 * 1000;

async function weatherApi(requestUrl, response) {
  const location = parseCoordinate(requestUrl.searchParams.get("location"));
  if (!location) return json(response, 400, { error: "INVALID_LOCATION" });
  if (!hasAmapServiceKey(config)) return json(response, 503, { error: "AMAP_WEB_SERVICE_KEY_MISSING" });

  // 天气按 adcode 查；先逆地理拿到坐标所在区县的 adcode。
  const regeoParams = new URLSearchParams({ location, extensions: "base" });
  let adcode = null;
  let cityName = null;
  try {
    const regeoJson = (await requestAmapJson("https://restapi.amap.com/v3/geocode/regeo", regeoParams, { config, timeoutMs: 10000 })).payload || {};
    const component = regeoJson?.regeocode?.addressComponent;
    adcode = component?.adcode ? String(component.adcode) : null;
    cityName = component?.city ? String(component.city) : (component?.province ? String(component.province) : null);
  } catch { /* 落到下面的报错 */ }
  if (!adcode) return json(response, 502, { error: "AMAP_REGEO_FAILED" });

  const cached = weatherCache.get(adcode);
  if (cached && cached.expiresAt > Date.now()) return json(response, 200, cached.data);

  const weatherParams = new URLSearchParams({ city: adcode, extensions: "base" });
  let result;
  try {
    result = (await requestAmapJson("https://restapi.amap.com/v3/weather/weatherInfo", weatherParams, { config, timeoutMs: 10000 })).payload || {};
  } catch {
    return json(response, 502, { error: "AMAP_WEATHER_UNREACHABLE" });
  }
  const live = Array.isArray(result.lives) ? result.lives[0] : null;
  if (result.status !== "1" || !live) return json(response, 502, { error: result.info || "AMAP_WEATHER_FAILED", infocode: result.infocode || null });

  const { weatherFactor, severe } = weatherImpactFor(live.weather);
  const data = {
    adcode,
    city: live.city || cityName || null,
    condition: live.weather,
    temperature: Number(live.temperature) || null,
    humidity: live.humidity || null,
    wind: `${live.winddirection || ""} ${live.windpower || ""}`.trim(),
    reporttime: live.reporttime || null,
    weatherFactor,
    severe,
    source: "高德天气实况"
  };
  weatherCache.set(adcode, { data, expiresAt: Date.now() + WEATHER_CACHE_MS });
  return json(response, 200, data);
}

async function longTripApi(request, response) {
  const body = await readJsonBody(request, 128000);
  if (!Array.isArray(body.stations)) return json(response, 400, { error: "STATIONS_REQUIRED" });
  const input = buildLongTripApiInput(body);
  if (!Number.isFinite(input.distanceKm)) {
    return json(response, 400, { error: "INVALID_DISTANCE" });
  }
  return json(response, 200, buildLongTripPlans(input));
}

async function operatorApi(request, response) {
  const body = await readJsonBody(request, 128000);
  if (!Array.isArray(body.stations) || !body.stations.length) return json(response, 400, { error: "STATIONS_REQUIRED" });
  try {
    return json(response, 200, simulateOperator(body));
  } catch (error) {
    return json(response, 400, { error: error.message === "STATIONS_REQUIRED" ? error.message : "INVALID_OPERATOR_INPUT" });
  }
}

async function validateApi(request, response) {
  // Current-route samples can contain dozens of stations. Keep this comfortably
  // above the compact front-end validation input while retaining a finite cap.
  const body = await readJsonBody(request, 128000);
  if (body.stations !== undefined && !Array.isArray(body.stations)) return json(response, 400, { error: "STATIONS_MUST_BE_ARRAY" });
  return json(response, 200, validateStrategies({ seed: body.seed, trips: body.trips, stations: body.stations }));
}

async function executionApi(request, response) {
  const body = await readJsonBody(request, 16000);
  const result = await executeFeishu({ payload: body, config });
  return json(response, 200, result);
}

async function feishuSyncApi(request, response) {
  const body = await readJsonBody(request, 128000);
  const result = await startFeishuSync({ payload: body, config });
  return json(response, 200, result);
}

async function feishuStatusApi(syncId, response) {
  const result = await getFeishuSyncStatus({ syncId, config });
  return json(response, result.mode === "error" && result.code !== "FEISHU_SYNC_NOT_FOUND" ? 502 : 200, result);
}

async function feishuApproveApi(request, response, strategyRecordId) {
  const body = await readJsonBody(request, 8192);
  const result = await approveFeishuStrategy({
    strategyRecordId,
    status: body.status || "已确认",
    config
  });
  return json(response, 200, result);
}

async function staticFile(pathname, response) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const protectedNames = new Set([".env", ".env.example", "config.local.js", "server.mjs", "package.json", "package-lock.json"]);
  if (protectedNames.has(requested) || requested.startsWith(".git") || requested.includes("..")) {
    response.writeHead(404).end();
    return;
  }
  const target = normalize(join(root, requested));
  if (!target.startsWith(normalize(root))) {
    response.writeHead(404).end();
    return;
  }
  try {
    const fileStat = await stat(target);
    if (!fileStat.isFile()) throw new Error("not a file");
    const content = await readFile(target);
    const extension = extname(target).toLowerCase();
    response.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Cache-Control": extension === ".html" || extension === ".js" ? "no-cache" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

async function requestHandler(request, response) {
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "OPTIONS") return json(response, 204, {});
    const versionRoute = await resolveVersionRoute({
      method: request.method,
      pathname: requestUrl.pathname,
      versionInfo,
      checkVersion: () => versionChecker.check()
    });
    if (versionRoute) return json(response, versionRoute.status, versionRoute.body);
    if (requestUrl.pathname === "/api/health") return json(response, 200, {
      ok: true,
      service: "FlowTwin",
      dependencies: {
        amapConfigured: hasAmapServiceKey(config),
        feishu: feishuConfigSummary(config)
      }
    });
    if (request.method === "GET" && requestUrl.pathname === "/api/contracts") return json(response, 200, API_CONTRACTS);
    if (requestUrl.pathname === "/api/route") return await routeApi(requestUrl, response);
    if (requestUrl.pathname === "/api/poi") return await poiApi(requestUrl, response);
    if (requestUrl.pathname === "/api/weather") return await weatherApi(requestUrl, response);
  if (request.method === "POST" && requestUrl.pathname === "/api/plan") return await planApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/forecast") return await forecastApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/longtrip") return await longTripApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/operator/simulate") return await operatorApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/validate") return await validateApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/execution") return await executionApi(request, response);
    if (request.method === "GET" && requestUrl.pathname === "/api/feishu/health") return json(response, 200, { ok: true, ...feishuConfigSummary(config) });
    if (request.method === "POST" && requestUrl.pathname === "/api/feishu/sync") return await feishuSyncApi(request, response);
    if (request.method === "GET" && requestUrl.pathname.startsWith("/api/feishu/sync/")) {
      return await feishuStatusApi(decodeURIComponent(requestUrl.pathname.slice("/api/feishu/sync/".length)), response);
    }
    if (request.method === "POST" && requestUrl.pathname.startsWith("/api/feishu/strategy/") && requestUrl.pathname.endsWith("/approve")) {
      const strategyRecordId = requestUrl.pathname.slice("/api/feishu/strategy/".length, -"/approve".length);
      return await feishuApproveApi(request, response, decodeURIComponent(strategyRecordId));
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/stt") return await sttApi(request, response);
    if (requestUrl.pathname === "/runtime-config.js") return await runtimeConfig(response);
    return await staticFile(requestUrl.pathname, response);
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error("FlowTwin request failed without logging request data or credentials");
    return json(response, status, { error: status === 413 ? "REQUEST_TOO_LARGE" : status === 400 ? "INVALID_JSON" : "INTERNAL_SERVER_ERROR" });
  }
}

async function startServer() {
  config = await loadConfig({ root });
  versionInfo = await loadVersionInfo({ root });
  versionChecker = createVersionChecker({ localVersion: versionInfo });
  const port = config.port;
  createServer(requestHandler).listen(port, "127.0.0.1", () => {
    console.log(`FlowTwin running at http://127.0.0.1:${port}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch(() => {
    console.error("FlowTwin failed to start");
    process.exitCode = 1;
  });
}
