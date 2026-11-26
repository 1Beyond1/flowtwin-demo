import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ORIGIN, loadConfig } from "./lib/config.mjs";
import { parseTripIntent, formatPlanResponse, planLimits } from "./lib/plan.mjs";
import { forecastStations, MAX_FORECAST_STATIONS } from "./lib/forecast.mjs";
import { simulateOperator } from "./lib/operator.mjs";
import { validateStrategies } from "./lib/validate.mjs";
import { executeFeishu } from "./lib/feishu.mjs";
import { buildLongTripPlans } from "./lib/longtrip.mjs";
import { createLongTripPlanCache } from "./lib/longtrip-cache.mjs";
import { API_CONTRACTS } from "./lib/contracts.mjs";
import { polishTranscriptText } from "./lib/stt.mjs";
import { hasAmapServiceKey, requestAmapJson } from "./lib/amap.mjs";
import {
  feishuConfigSummary,
  startFeishuSync,
  getFeishuSyncStatus,
  approveFeishuStrategy
} from "./lib/feishu-bitable.mjs";
import { createVersionChecker, loadVersionInfo, resolveVersionRoute } from "./lib/version.mjs";
import { AMAP_CACHE_TTLS, createAmapFileCache } from "./lib/amap-cache.mjs";
import { createRateLimiter, readRateLimitConfig } from "./lib/rate-limit.mjs";
import { localVisionFallback, validateVisionResult, visionHealthSummary } from "./lib/cv.mjs";
import { enterprisePriorHealth, enrichStationsWithEnterprisePrior, loadEnterpriseDemandPrior } from "./lib/enterprise-prior.mjs";
import { parseOptionalNumber } from "./lib/number.mjs";
import { optimizeDepartureWindows } from "./lib/departure-optimizer.mjs";
import { createCouponStore } from "./lib/coupons.mjs";
import { evaluateVisionQueueFeedback } from "./lib/vision-queue.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
let config = null;
let versionInfo = null;
let versionChecker = null;
let enterprisePrior = null;
const executionCache = new Map();
const executionInFlight = new Map();
const EXECUTION_CACHE_TTL_MS = 15 * 60 * 1000;
const EXECUTION_CACHE_MAX = 1_000;
let cvInFlight = 0;
const MAX_CV_IN_FLIGHT = 1;
const longTripPlanCache = createLongTripPlanCache();
const defaultCouponStore = createCouponStore();
let rateLimiter = createRateLimiter({
  ...readRateLimitConfig(),
  trustProxy: process.env.FLOWTWIN_TRUST_PROXY
});

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://webapi.amap.com https://*.amap.com https://*.autonavi.com",
  "style-src 'self' 'unsafe-inline' https://*.amap.com",
  "img-src 'self' data: blob: https://*.amap.com https://*.autonavi.com https://*.is.autonavi.com",
  "media-src 'self' data: blob:",
  "font-src 'self' data: https://*.amap.com",
  "connect-src 'self' https://*.amap.com https://*.autonavi.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join("; ");

export const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  // The entry flow can request browser location after an explicit user click.
  // Keep camera/microphone scoped to this origin and do not grant geolocation
  // to embedded third parties.
  "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(self)"
});

const SAFE_BAD_REQUEST_CODES = new Set([
  "INVALID_JSON",
  "INVALID_REQUEST_URL",
  "INVALID_URI_ENCODING",
  "BAD_REQUEST",
  "STATIONS_REQUIRED",
  "INVALID_COUPON_INPUT",
  "INVALID_REDEEM_INPUT",
  "INVALID_VISION_ANNOTATIONS"
]);
const SAFE_CLIENT_ERROR_CODES = new Set([
  ...SAFE_BAD_REQUEST_CODES,
  "COUPON_NOT_FOUND",
  "COUPON_EXHAUSTED",
  "CLAIM_NOT_FOUND"
]);

export function parseRequestUrl(request) {
  const rawHost = request?.headers?.host;
  const host = rawHost === undefined ? "localhost" : String(rawHost).trim();
  if (!host || /[\s\\/@\u0000-\u001f\u007f]/.test(host)) {
    throw Object.assign(new Error("INVALID_REQUEST_URL"), { statusCode: 400 });
  }
  const rawUrl = request?.url || "/";
  if (/[\u0000-\u001f\u007f]/.test(String(rawUrl))) {
    throw Object.assign(new Error("INVALID_REQUEST_URL"), { statusCode: 400 });
  }
  try {
    const base = new URL(`http://${host}`);
    if (base.pathname !== "/" || base.username || base.password || base.search || base.hash) {
      throw new Error("INVALID_HOST");
    }
    const parsed = new URL(rawUrl, base);
    if (parsed.protocol !== base.protocol || parsed.host.toLowerCase() !== base.host.toLowerCase()) {
      throw new Error("HOST_MISMATCH");
    }
    return parsed;
  } catch {
    throw Object.assign(new Error("INVALID_REQUEST_URL"), { statusCode: 400 });
  }
}

function safeDecodeUriComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw Object.assign(new Error("INVALID_URI_ENCODING"), { statusCode: 400 });
  }
}

export function validatePostRequestSecurity(request, requestUrl, { allowNonJson = false } = {}) {
  const headers = request?.headers || {};
  const secFetchSite = String(headers["sec-fetch-site"] || "").trim().toLowerCase();
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return { ok: false, status: 403, error: "CSRF_FORBIDDEN" };
  }

  const rawOrigin = headers.origin;
  if (rawOrigin !== undefined && String(rawOrigin).trim() !== "") {
    const originText = String(rawOrigin).trim();
    if (originText.toLowerCase() === "null") {
      return { ok: false, status: 403, error: "CSRF_FORBIDDEN" };
    }
    let originUrl;
    try {
      originUrl = new URL(originText);
    } catch {
      return { ok: false, status: 403, error: "CSRF_FORBIDDEN" };
    }
    if (!["http:", "https:"].includes(originUrl.protocol)) {
      return { ok: false, status: 403, error: "CSRF_FORBIDDEN" };
    }
    const forwardedProto = String(headers["x-forwarded-proto"] || "").split(",", 1)[0].trim().toLowerCase();
    if ((forwardedProto === "https" || request?.socket?.encrypted) && originUrl.protocol === "http:") {
      return { ok: false, status: 403, error: "CSRF_FORBIDDEN" };
    }
    // Normalize the incoming Host header under the Origin's scheme so standard
    // default ports (`Host: example.com:80` + `Origin: http://example.com` and
    // `Host: example.com:443` + `Origin: https://example.com`) match, while
    // mismatched port/scheme combinations (`:443` with `http:` or `:80` with
    // `https:`) are rejected.
    const hostHeader = headers.host !== undefined && String(headers.host).trim() !== ""
      ? String(headers.host).trim()
      : String(requestUrl?.host || "").trim();
    let expectedHostUrl;
    try {
      expectedHostUrl = new URL(`${originUrl.protocol}//${hostHeader}`);
      if (expectedHostUrl.pathname !== "/" || expectedHostUrl.username || expectedHostUrl.password
        || expectedHostUrl.search || expectedHostUrl.hash) {
        return { ok: false, status: 403, error: "CSRF_FORBIDDEN" };
      }
    } catch {
      return { ok: false, status: 403, error: "CSRF_FORBIDDEN" };
    }
    if (originUrl.host.toLowerCase() !== expectedHostUrl.host.toLowerCase()) {
      return { ok: false, status: 403, error: "CSRF_FORBIDDEN" };
    }
  }

  if (!allowNonJson) {
    const mediaType = String(headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json") {
      return { ok: false, status: 415, error: "UNSUPPORTED_MEDIA_TYPE" };
    }
  }
  return { ok: true };
}

export function rateLimitScopeForRequest(method, pathname) {
  const normalizedMethod = String(method || "").toUpperCase();
  const normalizedPath = String(pathname || "");
  if (normalizedMethod === "POST") {
    if (normalizedPath === "/api/plan") return "plan";
    if (normalizedPath === "/api/stt") return "stt";
    if (
      normalizedPath === "/api/forecast"
      || normalizedPath === "/api/longtrip"
      || normalizedPath === "/api/departure-windows"
      || normalizedPath === "/api/coupons/issue"
      || normalizedPath === "/api/coupons/claim"
      || normalizedPath === "/api/coupons/redeem"
      || normalizedPath === "/api/coupons/reset"
      || normalizedPath === "/api/vision/queue-feedback"
    ) return "map";
    if (normalizedPath === "/api/cv/analyze") return "cv";
    if (normalizedPath === "/api/operator/simulate") return "operator";
    if (normalizedPath === "/api/validate") return "validate";
    if (normalizedPath === "/api/feishu/sync") return "feishu-sync";
    if (normalizedPath.startsWith("/api/feishu/strategy/") && normalizedPath.endsWith("/approve")) return "approve";
    if (normalizedPath === "/api/execution") return "execution";
    return null;
  }
  if (normalizedMethod === "GET" && ["/api/route", "/api/poi", "/api/weather", "/api/coupons"].includes(normalizedPath)) return "map";
  if (normalizedMethod === "GET" && normalizedPath === "/api/version/check") return "version-check";
  if (normalizedMethod === "GET" && normalizedPath.startsWith("/api/feishu/sync/")) return "feishu-status";
  return null;
}

export function applyRateLimit(request, response, limiter = rateLimiter, requestUrl = null) {
  const method = String(request?.method || "").toUpperCase();
  if (method === "OPTIONS") return true;
  const url = requestUrl || parseRequestUrl(request);
  const scope = rateLimitScopeForRequest(method, url.pathname);
  if (!scope) return true;
  const decision = limiter.check(scope, request);
  if (decision.allowed) return true;
  const retryAfterSeconds = Math.max(1, Number(decision.retryAfterSeconds) || 1);
  response.writeHead(429, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    "Retry-After": String(retryAfterSeconds)
  });
  response.end(JSON.stringify({ error: "RATE_LIMITED", scope, retryAfterSeconds }));
  return false;
}

export function buildAiHealthSummary(source = {}) {
  const primaryConfigured = Boolean(source.aiBaseUrl && source.aiApiKey && source.aiModel);
  const backupConfigured = Boolean(source.aiBackupBaseUrl && source.aiBackupApiKey && source.aiBackupModel);
  return {
    configured: primaryConfigured || backupConfigured,
    primaryConfigured,
    backupConfigured
  };
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...headers
  });
  response.end(JSON.stringify(body));
}

function methodNotAllowed(response, allowedMethods) {
  const allowed = Array.isArray(allowedMethods) ? allowedMethods : [allowedMethods];
  return json(response, 405, {
    error: "METHOD_NOT_ALLOWED",
    allowed: allowed.join(", ")
  }, { Allow: allowed.join(", ") });
}

function parseCoordinate(value) {
  const parts = String(value || "").trim().split(",");
  if (parts.length !== 2 || parts.some((part) => !part || part.length > 24)) return null;
  const [longitude, latitude] = parts.map(Number);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude < 73 || longitude > 136 || latitude < 18 || latitude > 54) return null;
  return `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
}

export function parseRouteWaypoints(value, maxWaypoints = 16) {
  const text = String(value || "").trim();
  if (!text) return [];
  const parts = text.split(";").map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.length > maxWaypoints) return null;
  const points = parts.map(parseCoordinate);
  return points.every(Boolean) ? points : null;
}

function pickAddressText(value) {
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.trim());
    return first ? first.trim() : "";
  }
  return typeof value === "string" ? value.trim() : "";
}

function normalizePath(path, key, station) {
  const steps = Array.isArray(path.steps) ? path.steps : [];
  const points = steps.flatMap((step) => String(step.polyline || "").split(";")).map((point) => point.split(",").map(Number)).filter((point) => point.length === 2 && point.every(Number.isFinite));
  const roadNames = steps
    .map((step) => String(step.road || step.road_name || "").trim())
    .filter(Boolean)
    .slice(0, 80);
  const highwaySteps = steps.filter((step) => /高速|expressway|highway/i.test(`${step.road || ""} ${step.toll_road || ""}`));
  return {
    key,
    station,
    path: points,
    distance: Number(path.distance || 0) / 1000,
    duration: Number(path.cost?.duration || 0) / 60,
    tolls: Number(path.cost?.tolls || 0),
    highway: highwaySteps.length > 0,
    routeClass: highwaySteps.length > 0 ? "highway" : "unknown",
    roadNames,
    policy: path.strategy || key,
    source: "高德 Web 路线 2.0"
  };
}

export function isPublicDemoMode(source = {}) {
  return source?.publicDemo === true
    || ["1", "true", "yes", "on"].includes(String(source?.FLOWTWIN_PUBLIC_DEMO || "").trim().toLowerCase());
}

function remoteWriteDisabled(activeConfig = config) {
  return isPublicDemoMode(activeConfig || {}) || isPublicDemoMode(process.env);
}

function publicWriteDisabledResponse(response, code, message) {
  return json(response, 200, {
    used: false,
    mode: "local-demo",
    status: "disabled",
    code,
    message
  });
}

export function routeSourceLabel(cacheState) {
  if (cacheState === "hit") return "本地路线缓存 · 高德结果";
  if (cacheState === "stale") return "本地路线缓存 · 高德结果（上游暂不可用）";
  return "高德 Web 服务路线规划 2.0";
}

async function routeApi(requestUrl, response, runtime) {
  const origin = parseCoordinate(requestUrl.searchParams.get("origin"));
  const destination = parseCoordinate(requestUrl.searchParams.get("destination"));
  const legacyWaypoint = parseCoordinate(requestUrl.searchParams.get("waypoint"));
  const parsedWaypoints = parseRouteWaypoints(requestUrl.searchParams.get("waypoints"));
  const waypoints = parsedWaypoints === null
    ? null
    : parsedWaypoints.length
      ? parsedWaypoints
      : legacyWaypoint ? [legacyWaypoint] : [];
  const key = requestUrl.searchParams.get("plan") || "reliable";
  const strategies = { fastest: "38", reliable: "33", cheapest: "36" };
  if (!origin || !destination || waypoints === null || !strategies[key]) return json(response, 400, { error: "INVALID_ROUTE_PARAMS" });

  const rawCarType = String(requestUrl.searchParams.get("cartype") ?? "").trim();
  const cartype = rawCarType === "0" || rawCarType === "1" || rawCarType === "2" ? rawCarType : "1";
  const params = new URLSearchParams({
    origin,
    destination,
    strategy: strategies[key],
    cartype,
    ferry: "1",
    show_fields: "cost,navi,polyline"
  });
  if (waypoints.length) params.set("waypoints", waypoints.join(";"));
  let cached;
  try {
    cached = await requestCachedAmap("route", "https://restapi.amap.com/v5/direction/driving", params, {
      timeoutMs: 15000,
      staleIfErrorMs: 2 * 60 * 60 * 1000
    }, runtime);
  } catch (error) {
    return errorResponseForAmap(error, response, "AMAP_ROUTE_FAILED");
  }
  const result = cached.payload || {};
  const paths = Array.isArray(result.route?.paths) ? result.route.paths : [];
  if (result.status !== "1" || !paths.length) return json(response, 502, { error: result.info || "AMAP_ROUTE_FAILED", infocode: result.infocode || null });
  const station = waypoints.length === 1 ? { location: waypoints[0].split(",").map(Number) } : null;
  return json(response, 200, {
    route: normalizePath(paths[0], key, station),
    alternatives: paths.length,
    source: routeSourceLabel(cached.cache?.state),
    cache: cached.cache || { state: "bypass" }
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

function amapError(result, fallback = "AMAP_REQUEST_FAILED") {
  const error = new Error(result?.error || fallback);
  error.amapResult = result || null;
  return error;
}

/**
 * Read/write normalized AMap payloads through the optional disk cache. The
 * loader still goes through requestAmapJson, so key rotation and provider
 * error handling remain in one place. A stale successful payload can be
 * returned only when the upstream request fails; its response metadata makes
 * that boundary visible to the browser.
 */
async function requestCachedAmap(kind, endpoint, params, options = {}, runtime = {}) {
  const activeConfig = runtime.config || config || {};
  const fetchImpl = runtime.fetchImpl || fetch;
  const load = async () => {
    const result = await requestAmapJson(endpoint, params, {
      config: activeConfig,
      fetchImpl,
      timeoutMs: options.timeoutMs || 10000
    });
    if (!result.ok) throw amapError(result);
    return result.payload || {};
  };
  if (!activeConfig?.amapCache) return { payload: await load(), cache: { state: "bypass" } };
  const cached = await activeConfig.amapCache.getOrLoad(kind, params.toString(), load, {
    ttlMs: options.ttlMs || AMAP_CACHE_TTLS[kind] || AMAP_CACHE_TTLS.route,
    staleIfErrorMs: options.staleIfErrorMs
  });
  return {
    payload: cached.value || {},
    cache: cached.cache,
    upstreamError: cached.upstreamError || null
  };
}

function errorResponseForAmap(error, response, fallback = "AMAP_UPSTREAM_UNAVAILABLE") {
  const result = error?.amapResult;
  if (result?.error === "AMAP_WEB_SERVICE_KEY_MISSING") {
    return json(response, 503, { error: "AMAP_WEB_SERVICE_KEY_MISSING" });
  }
  return json(response, 502, {
    error: result?.error || fallback,
    infocode: result?.infocode || null
  });
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
async function poiApi(requestUrl, response, runtime) {
  const search = buildPoiSearchRequest({
    location: requestUrl.searchParams.get("location"),
    type: requestUrl.searchParams.get("type"),
    keyword: requestUrl.searchParams.get("keyword")
  });
  if (!search) return json(response, 400, { error: "INVALID_POI_LOCATION" });
  const { location, type, keyword, params } = search;
  let around;
  try {
    around = await requestCachedAmap("poi", "https://restapi.amap.com/v5/place/around", params, {
      timeoutMs: 15000,
      staleIfErrorMs: 7 * 24 * 60 * 60 * 1000
    }, runtime);
  } catch (error) {
    const failure = error?.amapResult;
    if (failure?.error === "AMAP_WEB_SERVICE_KEY_MISSING") return json(response, 503, { error: "AMAP_WEB_SERVICE_KEY_MISSING" });
    return json(response, 200, {
      pois: [],
      source: "高德 POI 暂不可用 · 已进入候选降级",
      degraded: true,
      warning: failure?.error || "AMAP_POI_FAILED",
      infocode: failure?.infocode || null,
      kind: type,
      cache: { state: "miss" }
    });
  }
  const result = around.payload || {};
  let pois = Array.isArray(result.pois) ? result.pois : [];
  if (result.status !== "1") {
    return json(response, 200, {
      pois: [],
      source: "高德 POI 暂不可用 · 已进入候选降级",
      degraded: true,
      warning: result.info || "AMAP_POI_FAILED",
      infocode: result.infocode || null,
      kind: type,
      cache: around.cache || { state: "bypass" }
    });
  }
  let source = "高德周边 POI";
  // Motorway samples often sit outside an urban POI radius even though the
  // nearest city has public charging stations. For China's four direct-controlled
  // municipalities AMap returns `city: []` and places the city name in `province`.
  if (!pois.length) {
    try {
      const reverseParams = new URLSearchParams({ location, radius: "1000", extensions: "base" });
      const reverse = await requestCachedAmap("regeo", "https://restapi.amap.com/v3/geocode/regeo", reverseParams, {
        timeoutMs: 10000,
        staleIfErrorMs: 30 * 24 * 60 * 60 * 1000
      }, runtime);
      const reversePayload = reverse.payload || {};
      const component = reversePayload?.regeocode?.addressComponent || {};
      const city = pickAddressText(component.city) || pickAddressText(component.province);
      if (reversePayload.status === "1" && city) {
        const textParams = new URLSearchParams({
          keywords: keyword, city, citylimit: "true", offset: "25", page: "1", extensions: "base"
        });
        const text = await requestCachedAmap("place", "https://restapi.amap.com/v3/place/text", textParams, {
          timeoutMs: 10000,
          staleIfErrorMs: 30 * 24 * 60 * 60 * 1000
        }, runtime);
        const textPayload = text.payload || {};
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
    requestedKeyword: keyword,
    cache: around.cache || { state: "bypass" }
  });
}

async function runtimeConfig(response, runtime) {
  const activeConfig = runtime.config || config || {};
  const { amapKey, securityJsCode, sttApiKey } = activeConfig;
  const originConfig = activeConfig.defaultOrigin || DEFAULT_ORIGIN;
  const originCoord = Array.isArray(originConfig?.coord) && originConfig.coord.length === 2
    ? originConfig.coord
    : Array.isArray(originConfig?.coordinate) && originConfig.coordinate.length === 2
      ? originConfig.coordinate
      : DEFAULT_ORIGIN.coordinate;
  const defaultOrigin = {
    name: typeof originConfig?.name === "string" && originConfig.name.trim()
      ? originConfig.name.trim()
      : DEFAULT_ORIGIN.name,
    coord: [...originCoord]
  };
  // Only browser-safe map settings leave the server. STT keys stay server-side;
  // expose a boolean so the mic button can show a clear "not configured" state.
  const body = `window.FLOWTWIN_CONFIG=${JSON.stringify({
    amapKey,
    securityJsCode,
    mapMode: amapKey ? "live" : "fallback",
    sttEnabled: Boolean(sttApiKey),
    defaultOrigin
  })};`;
  response.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS
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

export function extractMultipartFile(buffer, contentType) {
  if (!buffer) return null;
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!raw.length) return null;
  const boundaryMatch = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) return null;
  const boundary = (boundaryMatch[1] || boundaryMatch[2] || "").trim();
  if (!boundary) return null;

  const delimiter = Buffer.from(`--${boundary}`, "utf8");
  const headerSeparator = Buffer.from("\r\n\r\n");
  let offset = raw.indexOf(delimiter, 0);
  while (offset !== -1) {
    let partStart = offset + delimiter.length;
    // Closing delimiter `--<boundary>--` ends the multipart stream.
    if (partStart + 1 < raw.length && raw[partStart] === 0x2d && raw[partStart + 1] === 0x2d) {
      break;
    }
    if (partStart + 1 < raw.length && raw[partStart] === 0x0d && raw[partStart + 1] === 0x0a) {
      partStart += 2;
    } else if (partStart < raw.length && raw[partStart] === 0x0a) {
      partStart += 1;
    }
    const nextBoundary = raw.indexOf(delimiter, partStart);
    if (nextBoundary === -1) break;

    const partSlice = raw.subarray(partStart, nextBoundary);
    const headerEnd = partSlice.indexOf(headerSeparator);
    if (headerEnd >= 0) {
      // Decode ONLY the header slice as UTF-8 so binary payloads are never
      // scanned for field names and non-ASCII filenames stay intact.
      const headers = partSlice.subarray(0, headerEnd).toString("utf8");
      const disposition = headers.match(/^Content-Disposition:\s*([^\r\n]+)/im)?.[1] || "";
      if (/(?:^|;\s*)name="(?:file|audio)"/i.test(disposition)) {
        let body = partSlice.subarray(headerEnd + headerSeparator.length);
        if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
          body = body.subarray(0, body.length - 2);
        }
        let filename = disposition.match(/(?:^|;\s*)filename="([^"]*)"/i)?.[1] || "";
        if (!filename) {
          const extMatch = disposition.match(/(?:^|;\s*)filename\*=UTF-8''([^;\r\n]+)/i);
          if (extMatch?.[1]) {
            try { filename = decodeURIComponent(extMatch[1].trim()); } catch {}
          }
        }
        filename = filename || "audio.webm";
        const mime = headers.match(/^Content-Type:\s*([^\r\n]+)/im)?.[1]?.trim() || "application/octet-stream";
        return {
          filename,
          mime,
          data: body
        };
      }
    }
    offset = nextBoundary;
  }
  return null;
}

async function sttApi(request, response, runtime) {
  const activeConfig = runtime.config || config || {};
  const fetchImpl = runtime.fetchImpl || fetch;
  // Keys stay server-side; never log Authorization or audio payloads.
  if (!activeConfig.sttApiKey || !activeConfig.sttBaseUrl) return json(response, 503, { error: "STT_NOT_CONFIGURED" });
  const contentType = String(request.headers["content-type"] || "");
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (!mediaType || mediaType === "application/json") {
    return json(response, 400, { error: "AUDIO_BODY_REQUIRED" });
  }
  if (mediaType === "text/plain" || mediaType === "application/x-www-form-urlencoded") {
    return json(response, 415, { error: "UNSUPPORTED_MEDIA_TYPE" });
  }
  const raw = await readRawBody(request, 8_000_000);
  if (!raw.length) return json(response, 400, { error: "STT_EMPTY_AUDIO" });

  let fileBuffer = raw;
  let filename = "audio.webm";
  let mime = mediaType || "application/octet-stream";

  if (mediaType === "multipart/form-data") {
    const file = extractMultipartFile(raw, contentType);
    if (!file?.data?.length) return json(response, 400, { error: "AUDIO_FILE_REQUIRED" });
    fileBuffer = file.data;
    filename = file.filename || filename;
    mime = file.mime || mime;
  }

  const form = new FormData();
  form.append("model", activeConfig.sttModel || "FunAudioLLM/SenseVoiceSmall");
  form.append("file", new Blob([fileBuffer], { type: mime }), filename);

  try {
    const upstream = await fetchImpl(`${activeConfig.sttBaseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${activeConfig.sttApiKey}` },
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
    // Pass rawText directly so polishTranscriptText can detect SenseVoice tags
    // before stripping them and decide whether LLM cleanup is warranted.
    const text = await polishTranscriptText(rawText, activeConfig, fetchImpl);
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
  const parsed = parseOptionalNumber(value);
  if (parsed === null) return undefined;
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
  const stationCap = source.adaptiveMaxStops === true ? 72 : 40;
  if (Array.isArray(source.stations)) target.stations = source.stations.slice(0, stationCap);

  copyNumber(source, target, "distanceKm", 0, 6000, { clamp: false });
  copyNumber(source, target, "durationMinutes", 0, 7 * 24 * 60);
  copyNumber(source, target, "soc", 0, 100);
  copyNumber(source, target, "minArrivalSoc", 0, 100);
  copyNumber(source, target, "roadTolls", 0, 100000);
  copyNumber(source, target, "serviceCost", 0, 100000);
  // Normal callers remain at six stops. The browser's long-trip mode gets a
  // separate twelve-stop ceiling so a long route can be planned without
  // allowing an unbounded request to multiply AMap segment calls.
  copyNumber(source, target, "maxStops", 0, source.adaptiveMaxStops === true ? 12 : 6, { integer: true });
  copyNumber(source, target, "maxDetourKm", 0, 1000);
  copyDeparture(source, target);
  copyNumber(source, target, "deadlineOffsetMinutes", 0, 7 * 24 * 60);
  copyNumber(source, target, "deadlineMinutes", 0, 7 * 24 * 60);
  copyNumber(source, target, "arrivalDeadlineMinutes", 0, 7 * 24 * 60);
  copyForecastScenarioFields(source, target);

  if (typeof source.energyType === "string" && LONG_TRIP_ENERGY_TYPES.has(source.energyType)) {
    target.energyType = source.energyType;
  }
  // Adaptive planning is an explicit server-side opt-in from the browser
  // planner. The ordinary legacy contract remains bounded for compatibility.
  if (source.adaptiveMaxStops === true) target.adaptiveMaxStops = true;
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

async function planApi(request, response, runtime) {
  const activeConfig = runtime.config || config || {};
  const fetchImpl = runtime.fetchImpl || fetch;
  const body = await readJsonBody(request, 32768);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > planLimits.MAX_MESSAGE_LENGTH) return json(response, 400, { error: "MESSAGE_REQUIRED_OR_TOO_LONG", maxLength: planLimits.MAX_MESSAGE_LENGTH });
  const context = body.context && typeof body.context === "object" && !Array.isArray(body.context) ? body.context : {};
  const result = await parseTripIntent({ message, context, config: activeConfig, fetchImpl });
  return json(response, 200, {
    ...formatPlanResponse(result),
    mapConfigured: hasAmapServiceKey(activeConfig)
  });
}

async function forecastApi(request, response, runtime) {
  const activePrior = runtime.enterprisePrior ?? enterprisePrior;
  const body = await readJsonBody(request, 128000);
  if (body.stations !== undefined && !Array.isArray(body.stations)) return json(response, 400, { error: "STATIONS_MUST_BE_ARRAY" });
  const scenario = buildForecastApiScenario(body.scenario);
  const boundedStations = Array.isArray(body.stations) ? body.stations.slice(0, MAX_FORECAST_STATIONS) : [];
  const stations = enrichStationsWithEnterprisePrior(activePrior, boundedStations, scenario);
  const result = forecastStations(stations, scenario);
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

async function weatherApi(requestUrl, response, runtime) {
  const activeConfig = runtime.config || config || {};
  const location = parseCoordinate(requestUrl.searchParams.get("location"));
  if (!location) return json(response, 400, { error: "INVALID_LOCATION" });
  if (!hasAmapServiceKey(activeConfig)) return json(response, 503, { error: "AMAP_WEB_SERVICE_KEY_MISSING" });

  // 天气按 adcode 查；先逆地理拿到坐标所在区县的 adcode。
  const regeoParams = new URLSearchParams({ location, extensions: "base" });
  let adcode = null;
  let cityName = null;
  try {
    const regeo = await requestCachedAmap("regeo", "https://restapi.amap.com/v3/geocode/regeo", regeoParams, {
      timeoutMs: 10000,
      staleIfErrorMs: 30 * 24 * 60 * 60 * 1000
    }, runtime);
    const regeoJson = regeo.payload || {};
    const component = regeoJson?.regeocode?.addressComponent;
    adcode = component?.adcode ? String(component.adcode) : null;
    cityName = pickAddressText(component?.city) || pickAddressText(component?.province) || null;
  } catch { /* 落到下面的报错 */ }
  if (!adcode) return json(response, 502, { error: "AMAP_REGEO_FAILED" });

  const weatherParams = new URLSearchParams({ city: adcode, extensions: "base" });
  let weather;
  try {
    weather = await requestCachedAmap("weather", "https://restapi.amap.com/v3/weather/weatherInfo", weatherParams, {
      timeoutMs: 10000,
      staleIfErrorMs: 2 * 60 * 60 * 1000
    }, runtime);
  } catch {
    return json(response, 502, { error: "AMAP_WEATHER_UNREACHABLE" });
  }
  const result = weather.payload || {};
  const live = Array.isArray(result.lives) ? result.lives[0] : null;
  if (result.status !== "1" || !live) return json(response, 502, { error: result.info || "AMAP_WEATHER_FAILED", infocode: result.infocode || null });

  const { weatherFactor, severe } = weatherImpactFor(live.weather);
  const data = {
    adcode,
    city: live.city || cityName || null,
    condition: live.weather,
    temperature: parseOptionalNumber(live.temperature),
    humidity: live.humidity || null,
    wind: `${live.winddirection || ""} ${live.windpower || ""}`.trim(),
    reporttime: live.reporttime || null,
    weatherFactor,
    severe,
    source: weather.cache?.state === "stale" ? "高德天气缓存 · 上游暂不可用" : "高德天气实况",
    cache: weather.cache || { state: "bypass" }
  };
  return json(response, 200, data);
}

async function longTripApi(request, response, runtime) {
  const activePrior = runtime.enterprisePrior ?? enterprisePrior;
  const activePlanCache = runtime.longTripPlanCache || longTripPlanCache;
  const body = await readJsonBody(request, 128000);
  if (!Array.isArray(body.stations)) return json(response, 400, { error: "STATIONS_REQUIRED" });
  const input = buildLongTripApiInput(body);
  if (!Number.isFinite(input.distanceKm)) {
    return json(response, 400, { error: "INVALID_DISTANCE" });
  }
  const scenario = buildForecastApiScenario(body);
  input.stations = enrichStationsWithEnterprisePrior(activePrior, input.stations, scenario);
  const cached = await activePlanCache.getOrLoad(input, () => buildLongTripPlans(input));
  return json(response, 200, { ...cached.value, cache: cached.cache });
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

async function departureWindowsApi(request, response) {
  const body = await readJsonBody(request, 128000);
  if (!Array.isArray(body.stations) || !body.stations.length) return json(response, 400, { error: "STATIONS_REQUIRED" });
  const scenario = buildForecastApiScenario(body.scenario);
  try {
    return json(response, 200, optimizeDepartureWindows({
      stations: body.stations.slice(0, MAX_FORECAST_STATIONS),
      stationId: body.stationId,
      baseDepartureMinutes: body.baseDepartureMinutes ?? body.departureMinutes,
      arrivalOffsetMinutes: body.arrivalOffsetMinutes,
      energyType: body.energyType,
      energyUnits: body.energyUnits,
      offsets: body.offsets,
      scenario
    }));
  } catch (error) {
    return json(response, 400, { error: error.message === "STATIONS_REQUIRED" ? error.message : "BAD_REQUEST" });
  }
}

function couponDomainErrorResponse(error, response, fallbackCode = "INVALID_COUPON_INPUT") {
  const status = Number(error?.statusCode);
  if ([400, 404, 409].includes(status) && SAFE_CLIENT_ERROR_CODES.has(error?.message)) {
    return json(response, status, { error: error.message });
  }
  return json(response, 400, { error: fallbackCode });
}

function couponsListApi(requestUrl, response, runtime) {
  const stationId = requestUrl.searchParams.get("stationId") || undefined;
  const status = requestUrl.searchParams.get("status") || undefined;
  return json(response, 200, runtime.couponStore.list({ stationId, status }));
}

async function couponsIssueApi(request, response, runtime) {
  const body = await readJsonBody(request, 16384);
  try {
    return json(response, 200, runtime.couponStore.issue(body));
  } catch (error) {
    return couponDomainErrorResponse(error, response, "INVALID_COUPON_INPUT");
  }
}

async function couponsClaimApi(request, response, runtime) {
  const body = await readJsonBody(request, 16384);
  try {
    return json(response, 200, runtime.couponStore.claim(body));
  } catch (error) {
    return couponDomainErrorResponse(error, response, "COUPON_NOT_FOUND");
  }
}

async function couponsRedeemApi(request, response, runtime) {
  const body = await readJsonBody(request, 16384);
  try {
    return json(response, 200, runtime.couponStore.redeem(body));
  } catch (error) {
    return couponDomainErrorResponse(error, response, "INVALID_REDEEM_INPUT");
  }
}

async function couponsResetApi(request, response, runtime) {
  await readJsonBody(request, 8192);
  return json(response, 200, runtime.couponStore.reset());
}

async function visionQueueFeedbackApi(request, response) {
  const body = await readJsonBody(request, 65536);
  const scenario = buildForecastApiScenario(body.scenario);
  try {
    return json(response, 200, evaluateVisionQueueFeedback({
      station: body.station,
      annotations: body.annotations,
      arrivalOffsetMinutes: body.arrivalOffsetMinutes,
      scenario
    }));
  } catch (error) {
    if (error?.message === "INVALID_VISION_ANNOTATIONS") {
      return json(response, 400, { error: "INVALID_VISION_ANNOTATIONS" });
    }
    throw error;
  }
}

async function validateApi(request, response) {
  // Current-route samples can contain dozens of stations. Keep this comfortably
  // above the compact front-end validation input while retaining a finite cap.
  const body = await readJsonBody(request, 128000);
  if (body.stations !== undefined && !Array.isArray(body.stations)) return json(response, 400, { error: "STATIONS_MUST_BE_ARRAY" });
  return json(response, 200, validateStrategies({ seed: body.seed, trips: body.trips, stations: body.stations }));
}

async function cvHealthApi(response, runtime) {
  const activeConfig = runtime.config || config || {};
  const fetchImpl = runtime.fetchImpl || fetch;
  const summary = visionHealthSummary(activeConfig);
  if (!activeConfig.cvServiceUrl) return json(response, 200, summary);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const upstream = await fetchImpl(`${activeConfig.cvServiceUrl.replace(/\/$/, "")}/health`, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    const payload = await upstream.json().catch(() => null);
    const localServiceOk = upstream.ok && payload?.ok === true;
    const runtimeInfo = payload?.runtime && typeof payload.runtime === "object" ? payload.runtime : null;
    const runtimeAvailable = localServiceOk && runtimeInfo?.ocrAvailable === true;
    const modelLoaded = localServiceOk && runtimeInfo?.ocrLoaded === true;
    return json(response, 200, {
      ...summary,
      serviceReachable: localServiceOk,
      runtimeAvailable,
      modelLoaded,
      inferenceReady: Boolean(runtimeAvailable && modelLoaded),
      status: !localServiceOk
        ? "unreachable"
        : !runtimeAvailable
          ? "runtime-unavailable"
          : modelLoaded
            ? "ready"
            : "warming",
      localServiceOk,
      localRuntime: runtimeInfo
    });
  } catch {
    return json(response, 200, {
      ...summary,
      serviceReachable: false,
      runtimeAvailable: false,
      modelLoaded: false,
      inferenceReady: false,
      status: "unreachable",
      localServiceOk: false,
      localRuntime: null
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function isCompletedVisionInference(result) {
  return validateVisionResult(result)
    && (result.inferenceStatus === "executed" || result.inferenceStatus === "synthetic");
}

const NON_RETRYABLE_VISION_REASON_CODES = new Set([
  "VIDEO_OCR_TIMEOUT",
  "VIDEO_OCR_FAILED",
  "VIDEO_DECODE_FAILED",
  "VIDEO_DECODER_UNAVAILABLE",
  "VIDEO_FRAME_DIMENSIONS_TOO_LARGE",
  "OCR_IMAGE_DECODE_FAILED",
  "OCR_IMAGE_DECODER_UNAVAILABLE",
  "OCR_NUMPY_UNAVAILABLE",
  "PADDLEOCR_RUNTIME_UNAVAILABLE",
  "PADDLEOCR_CLASS_UNAVAILABLE",
  "PADDLEOCR_LOCAL_MODEL_DIRS_REQUIRED",
  "PADDLEOCR_INFERENCE_METHOD_UNAVAILABLE",
  "IMAGE_DIMENSIONS_TOO_LARGE",
  "IMAGE_CONTENT_INVALID",
  "IMAGE_TOO_LARGE",
  "VIDEO_TOO_LARGE",
  "UNSUPPORTED_CV_MODE"
]);

export function isTransientVisionResult(result) {
  if (!validateVisionResult(result)) return false;
  if (!["not-run", "error"].includes(String(result.inferenceStatus || ""))) return false;
  if (result.retryable === false) return false;
  const reasonCode = String(result.reasonCode || "").trim().toUpperCase();
  if (reasonCode && NON_RETRYABLE_VISION_REASON_CODES.has(reasonCode)) return false;
  const mode = String(result.mode || "");
  if (mode === "local-video-ocr-unavailable") {
    // Video timeouts and decode/dependency failures are deterministic or already
    // consumed the full video budget; only retry while PaddleOCR is still warming up.
    if (result.retryable === true || reasonCode === "PADDLEOCR_NOT_READY") return true;
    return Array.isArray(result.evidence)
      && result.evidence.some((item) => String(item || "").includes("PADDLEOCR_NOT_READY"));
  }
  return [
    "local-ocr-unavailable",
    "local-ocr-error"
  ].includes(mode);
}

export function isRetryableVisionStatus(status) {
  return [408, 429, 502, 503, 504].includes(Number(status));
}

async function cvAnalyzeApi(request, response, runtime) {
  const activeConfig = runtime.config || config || {};
  const fetchImpl = runtime.fetchImpl || fetch;
  // Finish reading and validating the JSON body BEFORE taking the single-flight
  // CV slot so a slow or invalid upload cannot starve other CV requests.
  const body = await readJsonBody(request, 36 * 1024 * 1024);
  if (cvInFlight >= MAX_CV_IN_FLIGHT) {
    return json(response, 503, {
      error: "CV_BUSY",
      message: "本地视觉服务正在处理上一份请求，请稍后重试。"
    }, { "Retry-After": "3" });
  }
  cvInFlight += 1;
  try {
    // A built-in sample is still an image input. Normalize it to the same upload
    // path so the local OCR model, rather than a synthetic result generator,
    // decides whether a plate is actually present.
    const requestedMode = String(body?.mode || "").trim().toLowerCase();
    const normalizedMode = requestedMode === "sample" && body?.imageData
      ? "upload"
      : requestedMode;
    const upstreamBody = { ...body, mode: normalizedMode };
    if (activeConfig.cvServiceUrl && ["upload", "video"].includes(normalizedMode)) {
      // PaddleOCR may load local weights on the first request. Video sampling
      // also needs more time than a single image, but must remain bounded.
      const maxAttempts = 3;
      const retryDelayMs = 2000;
      let lastStatus = null;
      let lastResult = null;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), normalizedMode === "video" ? 120000 : 60000);
        try {
          const upstream = await fetchImpl(`${activeConfig.cvServiceUrl.replace(/\/$/, "")}/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(upstreamBody),
            signal: controller.signal
          });
          const result = await upstream.json().catch(() => null);
          lastStatus = upstream.status;
          lastResult = result;
          if (upstream.ok && isCompletedVisionInference(result)) {
            return json(response, 200, result);
          }
          const retryable = isRetryableVisionStatus(upstream.status) || isTransientVisionResult(result);
          if (!retryable || attempt >= maxAttempts - 1) break;
        } catch {
          // Do not retry an aborted request blindly: the CV process may still be
          // working on the original image and a retry would duplicate work.
          break;
        } finally {
          clearTimeout(timeout);
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
      if (lastResult && typeof lastResult === "object" && validateVisionResult(lastResult)) {
        return json(response, lastStatus === 429 ? 429 : 200, lastResult);
      }
      if (lastStatus === 429 && lastResult && typeof lastResult === "object") {
        return json(response, 429, lastResult);
      }
      if (lastStatus && lastStatus >= 400 && lastStatus < 500) {
        return json(response, lastStatus, lastResult && typeof lastResult === "object" ? lastResult : { error: "CV_REQUEST_REJECTED" });
      }
    }
    const fallback = localVisionFallback({ ...body, mode: requestedMode });
    return json(response, fallback.ok === false ? 400 : 200, fallback);
  } finally {
    cvInFlight = Math.max(0, cvInFlight - 1);
  }
}

async function executionApi(request, response, runtime) {
  const activeConfig = runtime.config || config || {};
  const fetchImpl = runtime.fetchImpl || fetch;
  if (remoteWriteDisabled(activeConfig)) {
    return publicWriteDisabledResponse(response, "PUBLIC_DEMO_EXECUTION_DISABLED", "公开 Demo 已关闭飞书执行通知，当前保留本地执行演示。");
  }
  const body = await readJsonBody(request, 16000);
  const rawKey = body?.runId ?? body?.executionId ?? body?.idempotencyKey;
  const key = typeof rawKey === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(rawKey.trim())
    ? rawKey.trim()
    : null;
  const now = Date.now();
  for (const [cachedKey, cached] of executionCache) {
    if (cached.expiresAt <= now) executionCache.delete(cachedKey);
  }
  if (key) {
    const cached = executionCache.get(key);
    if (cached) return json(response, 200, { ...cached.result, idempotent: true });
    const pending = executionInFlight.get(key);
    if (pending) {
      const result = await pending;
      return json(response, 200, result?.mode === "error" ? result : { ...result, idempotent: true });
    }
  }
  const executionPromise = Promise.resolve().then(() => executeFeishu({ payload: body, config: activeConfig, fetchImpl }));
  if (key) executionInFlight.set(key, executionPromise);
  let result;
  try {
    result = await executionPromise;
  } finally {
    if (key && executionInFlight.get(key) === executionPromise) executionInFlight.delete(key);
  }
  if (key && result?.mode !== "error") {
    if (executionCache.size >= EXECUTION_CACHE_MAX) executionCache.delete(executionCache.keys().next().value);
    executionCache.set(key, { result, expiresAt: Date.now() + EXECUTION_CACHE_TTL_MS });
  }
  return json(response, 200, result);
}

async function feishuSyncApi(request, response, runtime) {
  const activeConfig = runtime.config || config || {};
  const fetchImpl = runtime.fetchImpl || fetch;
  if (remoteWriteDisabled(activeConfig)) {
    return publicWriteDisabledResponse(response, "PUBLIC_DEMO_FEISHU_SYNC_DISABLED", "公开 Demo 已关闭飞书写入，当前保留本地运营策略演示。");
  }
  const body = await readJsonBody(request, 128000);
  const result = await startFeishuSync({ payload: body, config: activeConfig, fetchImpl });
  return json(response, 200, result);
}

async function feishuStatusApi(syncId, response, runtime) {
  const activeConfig = runtime.config || config || {};
  const fetchImpl = runtime.fetchImpl || fetch;
  if (remoteWriteDisabled(activeConfig)) {
    return publicWriteDisabledResponse(response, "PUBLIC_DEMO_FEISHU_STATUS_DISABLED", "公开 Demo 已关闭飞书结果读取，当前保留本地运营策略演示。");
  }
  const result = await getFeishuSyncStatus({ syncId, config: activeConfig, fetchImpl });
  return json(response, result.mode === "error" && result.code !== "FEISHU_SYNC_NOT_FOUND" ? 502 : 200, result);
}

async function feishuApproveApi(request, response, strategyRecordId, runtime) {
  const activeConfig = runtime.config || config || {};
  const fetchImpl = runtime.fetchImpl || fetch;
  if (remoteWriteDisabled(activeConfig)) {
    return publicWriteDisabledResponse(response, "PUBLIC_DEMO_FEISHU_APPROVE_DISABLED", "公开 Demo 已关闭飞书策略写回，当前保留本地审批演示。");
  }
  const body = await readJsonBody(request, 8192);
  const result = await approveFeishuStrategy({
    strategyRecordId,
    status: body.status ?? "已确认",
    config: activeConfig,
    fetchImpl
  });
  const badInput = result.code === "INVALID_STRATEGY_RECORD_ID" || result.code === "INVALID_APPROVAL_STATUS";
  return json(response, badInput ? 400 : 200, result);
}

export function isBlockedStaticRequest(requestedPath) {
  const requested = String(requestedPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const basename = requested.split("/").at(-1) || "";
  const protectedNames = new Set(["server.mjs", "package.json", "package-lock.json"]);
  const protectedDirectories = [".git", "runtime", "data", "cv-service", "lib", "test", "docs", "node_modules"];
  const publicRootFiles = new Set(["index.html", "app.js", "service-intent.js", "vehicle-presets.js", "favicon.ico", "manifest.webmanifest"]);
  return !requested
    || requested.includes("..")
    || protectedNames.has(requested)
    || /^\.env(?:[.-]|$)/i.test(basename)
    || /^config\.local\.js(?:[.-]|$)/i.test(basename)
    || protectedDirectories.some((directory) => requested === directory || requested.startsWith(`${directory}/`))
    // The browser only needs the entry HTML, its two scripts, and public image
    // assets. Treat every other local file as private by default so a newly
    // created log, handoff note, or deployment artifact cannot become public.
    || !(publicRootFiles.has(requested) || requested.startsWith("assets/"));
}

async function staticFile(request, pathname, response) {
  const method = String(request?.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return methodNotAllowed(response, ["GET", "HEAD"]);
  }
  let requested;
  try {
    requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    response.end(method === "HEAD" ? undefined : "Bad Request");
    return;
  }
  if (isBlockedStaticRequest(requested)) {
    response.writeHead(404, { ...SECURITY_HEADERS }).end();
    return;
  }
  const target = normalize(join(root, requested));
  if (!target.startsWith(normalize(root))) {
    response.writeHead(404, { ...SECURITY_HEADERS }).end();
    return;
  }
  try {
    const fileStat = await stat(target);
    if (!fileStat.isFile()) throw new Error("not a file");
    const content = method === "HEAD" ? null : await readFile(target);
    const extension = extname(target).toLowerCase();
    response.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Content-Length": String(fileStat.size),
      // 入口和脚本禁止复用旧响应，避免服务端已经切换版本、客户端浏览器却仍执行上一版 app.js。
      "Cache-Control": extension === ".html" || extension === ".js"
        ? "no-store, max-age=0"
        : "public, max-age=300",
      ...SECURITY_HEADERS
    });
    response.end(method === "HEAD" ? undefined : content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    response.end(method === "HEAD" ? undefined : "Not found");
  }
}

export function createRequestHandler(overrides = {}) {
  return async function handleRequest(request, response) {
    const runtime = {
      config: overrides.config ?? config ?? {},
      enterprisePrior: overrides.enterprisePrior ?? enterprisePrior,
      versionInfo: overrides.versionInfo ?? versionInfo,
      versionChecker: overrides.versionChecker ?? versionChecker,
      rateLimiter: overrides.rateLimiter ?? rateLimiter,
      longTripPlanCache: overrides.longTripPlanCache ?? longTripPlanCache,
      couponStore: overrides.couponStore ?? defaultCouponStore,
      fetchImpl: overrides.fetchImpl ?? fetch
    };
    try {
      const requestUrl = parseRequestUrl(request);
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Cache-Control": "no-store",
          ...SECURITY_HEADERS
        });
        response.end();
        return;
      }
      if (!applyRateLimit(request, response, runtime.rateLimiter, requestUrl)) return;
      const versionRoute = await resolveVersionRoute({
        method: request.method,
        pathname: requestUrl.pathname,
        versionInfo: runtime.versionInfo,
        checkVersion: () => runtime.versionChecker?.check?.()
      });
      if (versionRoute) return json(response, versionRoute.status, versionRoute.body);
      if (requestUrl.pathname === "/api/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return json(response, 200, {
          ok: true,
          service: "FlowTwin",
          dependencies: {
            amapConfigured: hasAmapServiceKey(runtime.config),
            ai: buildAiHealthSummary(runtime.config),
            feishu: { ...feishuConfigSummary(runtime.config), publicWriteEnabled: !remoteWriteDisabled(runtime.config) },
            cv: visionHealthSummary(runtime.config),
            enterprisePrior: enterprisePriorHealth(runtime.enterprisePrior)
          },
          amapCache: runtime.config.amapCache?.getStats?.() || null,
          longTripPlanCache: runtime.longTripPlanCache.getStats()
        });
      }
      if (requestUrl.pathname === "/api/contracts") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return json(response, 200, API_CONTRACTS);
      }
      if (["/api/route", "/api/poi", "/api/weather"].includes(requestUrl.pathname)) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if (requestUrl.pathname === "/api/route") return await routeApi(requestUrl, response, runtime);
        if (requestUrl.pathname === "/api/poi") return await poiApi(requestUrl, response, runtime);
        return await weatherApi(requestUrl, response, runtime);
      }
      if (requestUrl.pathname === "/api/coupons") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return couponsListApi(requestUrl, response, runtime);
      }
      const postOnlyPaths = new Set([
        "/api/plan",
        "/api/forecast",
        "/api/longtrip",
        "/api/departure-windows",
        "/api/operator/simulate",
        "/api/coupons/issue",
        "/api/coupons/claim",
        "/api/coupons/redeem",
        "/api/coupons/reset",
        "/api/vision/queue-feedback",
        "/api/validate",
        "/api/cv/analyze",
        "/api/execution",
        "/api/feishu/sync",
        "/api/stt"
      ]);
      const isFeishuApprovePath = requestUrl.pathname.startsWith("/api/feishu/strategy/")
        && requestUrl.pathname.endsWith("/approve");
      if (postOnlyPaths.has(requestUrl.pathname) && request.method !== "POST") {
        return methodNotAllowed(response, ["POST"]);
      }
      if (isFeishuApprovePath && request.method !== "POST") {
        return methodNotAllowed(response, ["POST"]);
      }
      if (request.method === "POST" && (postOnlyPaths.has(requestUrl.pathname) || isFeishuApprovePath)) {
        const securityCheck = validatePostRequestSecurity(request, requestUrl, {
          allowNonJson: requestUrl.pathname === "/api/stt"
        });
        if (!securityCheck.ok) {
          return json(response, securityCheck.status, { error: securityCheck.error });
        }
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/plan") return await planApi(request, response, runtime);
      if (request.method === "POST" && requestUrl.pathname === "/api/forecast") return await forecastApi(request, response, runtime);
      if (request.method === "POST" && requestUrl.pathname === "/api/longtrip") return await longTripApi(request, response, runtime);
      if (request.method === "POST" && requestUrl.pathname === "/api/departure-windows") return await departureWindowsApi(request, response);
      if (request.method === "POST" && requestUrl.pathname === "/api/operator/simulate") return await operatorApi(request, response);
      if (request.method === "POST" && requestUrl.pathname === "/api/coupons/issue") return await couponsIssueApi(request, response, runtime);
      if (request.method === "POST" && requestUrl.pathname === "/api/coupons/claim") return await couponsClaimApi(request, response, runtime);
      if (request.method === "POST" && requestUrl.pathname === "/api/coupons/redeem") return await couponsRedeemApi(request, response, runtime);
      if (request.method === "POST" && requestUrl.pathname === "/api/coupons/reset") return await couponsResetApi(request, response, runtime);
      if (request.method === "POST" && requestUrl.pathname === "/api/vision/queue-feedback") return await visionQueueFeedbackApi(request, response);
      if (request.method === "POST" && requestUrl.pathname === "/api/validate") return await validateApi(request, response);
      if (requestUrl.pathname === "/api/cv/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return await cvHealthApi(response, runtime);
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/cv/analyze") return await cvAnalyzeApi(request, response, runtime);
      if (request.method === "POST" && requestUrl.pathname === "/api/execution") return await executionApi(request, response, runtime);
      if (requestUrl.pathname === "/api/feishu/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return json(response, 200, { ok: true, ...feishuConfigSummary(runtime.config), publicWriteEnabled: !remoteWriteDisabled(runtime.config) });
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/feishu/sync") return await feishuSyncApi(request, response, runtime);
      if (requestUrl.pathname.startsWith("/api/feishu/sync/")) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return await feishuStatusApi(safeDecodeUriComponent(requestUrl.pathname.slice("/api/feishu/sync/".length)), response, runtime);
      }
      if (request.method === "POST" && isFeishuApprovePath) {
        const strategyRecordId = requestUrl.pathname.slice("/api/feishu/strategy/".length, -"/approve".length);
        return await feishuApproveApi(request, response, safeDecodeUriComponent(strategyRecordId), runtime);
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/stt") return await sttApi(request, response, runtime);
      if (requestUrl.pathname === "/runtime-config.js") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return await runtimeConfig(response, runtime);
      }
      return await staticFile(request, requestUrl.pathname, response);
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      if (status >= 500) {
        const tag = String(error?.code || error?.name || "ERROR").replace(/[^\w.-]/g, "").slice(0, 48);
        console.error(`FlowTwin request failed (${tag}) without logging request data or credentials`);
      }
      const code = status === 413
        ? "REQUEST_TOO_LARGE"
        : status === 400
          ? (SAFE_BAD_REQUEST_CODES.has(error?.message) ? error.message : "INVALID_JSON")
          : (status === 404 || status === 409) && SAFE_CLIENT_ERROR_CODES.has(error?.message)
            ? error.message
            : "INTERNAL_SERVER_ERROR";
      return json(response, status, { error: code });
    }
  };
}

const requestHandler = createRequestHandler();

async function startServer() {
  config = await loadConfig({ root });
  rateLimiter = createRateLimiter({
    ...readRateLimitConfig(config.rateLimitEnv || process.env),
    trustProxy: config.trustProxy || config.rateLimitEnv?.FLOWTWIN_TRUST_PROXY || process.env.FLOWTWIN_TRUST_PROXY
  });
  enterprisePrior = await loadEnterpriseDemandPrior({ root, filePath: join(root, "runtime", "enterprise-demand-prior.json") });
  // Disk cache is ignored by Git and blocked from static serving. It lowers
  // repeated-demo quota use without replacing live route verification.
  config.amapCache = createAmapFileCache({ root });
  versionInfo = await loadVersionInfo({ root });
  versionChecker = createVersionChecker({ localVersion: versionInfo, repo: versionInfo.repo });
  const host = config.host || "127.0.0.1";
  const port = config.port;
  const server = createServer(requestHandler);
  server.requestTimeout = 130_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  server.listen(port, host, () => {
    console.log(`FlowTwin running at http://${host}:${port}`);
  });
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`FlowTwin received ${signal}, shutting down`);
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    const tag = String(error?.code || error?.name || "UNKNOWN_ERROR").replace(/[^\w.-]/g, "").slice(0, 48);
    console.error(`FlowTwin failed to start (${tag})`);
    process.exitCode = 1;
  });
}
