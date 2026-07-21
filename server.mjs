import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
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

const root = fileURLToPath(new URL(".", import.meta.url));
const config = await loadConfig({ root });
const port = config.port;

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
  if (!/^\d{2,3}\.\d{1,6},\d{2}\.\d{1,6}$/.test(value || "")) return null;
  const [longitude, latitude] = value.split(",").map(Number);
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

  const { webServiceKey } = config;
  if (!webServiceKey) return json(response, 503, { error: "AMAP_WEB_SERVICE_KEY_MISSING" });
  const params = new URLSearchParams({
    origin,
    destination,
    strategy: strategies[key],
    cartype: requestUrl.searchParams.get("cartype") === "0" ? "0" : "1",
    ferry: "1",
    show_fields: "cost,navi,polyline",
    key: webServiceKey
  });
  if (waypoint) params.set("waypoints", waypoint);
  const upstream = await fetch(`https://restapi.amap.com/v5/direction/driving?${params}`, {
    headers: { "User-Agent": "FlowTwin-Demo/1.0" },
    signal: AbortSignal.timeout(15000)
  });
  const result = await upstream.json();
  const paths = Array.isArray(result.route?.paths) ? result.route.paths : [];
  if (result.status !== "1" || !paths.length) return json(response, 502, { error: result.info || "AMAP_ROUTE_FAILED", infocode: result.infocode || null });
  const station = waypoint ? { location: waypoint.split(",").map(Number) } : null;
  return json(response, 200, {
    route: normalizePath(paths[0], key, station),
    alternatives: paths.length,
    source: "高德 Web 服务路线规划 2.0"
  });
}

// The browser-side PlaceSearch SDK is useful for map interaction, but it can
// return sparse results for motorway points far from a city centre. Query the
// same AMap Web Service from the local server for route-corridor POIs so the
// web-service key stays server-side and cross-province sampling is stable.
async function poiApi(requestUrl, response) {
  const location = parseCoordinate(requestUrl.searchParams.get("location"));
  const requestedType = requestUrl.searchParams.get("type");
  const type = requestedType === "fuel" ? "fuel" : requestedType === "service" ? "service" : "electric";
  const keyword = type === "fuel" ? "加油站" : type === "service" ? "服务区" : "充电站";
  if (!location) return json(response, 400, { error: "INVALID_POI_LOCATION" });
  const { webServiceKey } = config;
  if (!webServiceKey) return json(response, 503, { error: "AMAP_WEB_SERVICE_KEY_MISSING" });
  const params = new URLSearchParams({
    key: webServiceKey,
    location,
    keywords: keyword,
    radius: "30000",
    page_size: "20",
    page_num: "1",
    show_fields: "business,children"
  });
  const upstream = await fetch(`https://restapi.amap.com/v5/place/around?${params}`, {
    headers: { "User-Agent": "FlowTwin-Demo/1.0" },
    signal: AbortSignal.timeout(15000)
  });
  const result = await upstream.json();
  let pois = Array.isArray(result.pois) ? result.pois : [];
  if (result.status !== "1") return json(response, 502, { error: result.info || "AMAP_POI_FAILED", infocode: result.infocode || null });
  let source = "高德周边 POI";
  // Motorway samples often sit outside an urban POI radius even though the
  // nearest city has public charging stations. When the around-search is
  // empty, resolve the city first and perform a constrained city text search.
  // The returned POIs still go through the browser's route-corridor and detour
  // filters; this only broadens data discovery, not the safety judgement.
  if (!pois.length) {
    try {
      const reverseParams = new URLSearchParams({ key: webServiceKey, location, radius: "1000", extensions: "base" });
      const reverse = await fetch(`https://restapi.amap.com/v3/geocode/regeo?${reverseParams}`, {
        headers: { "User-Agent": "FlowTwin-Demo/1.0" }, signal: AbortSignal.timeout(10000)
      });
      const reversePayload = await reverse.json();
      const cityValue = reversePayload?.regeocode?.addressComponent?.city;
      const city = Array.isArray(cityValue) ? cityValue.find(Boolean) : cityValue;
      if (reversePayload.status === "1" && typeof city === "string" && city.trim()) {
        const textParams = new URLSearchParams({
          key: webServiceKey, keywords: keyword, city: city.trim(), citylimit: "true", offset: "25", page: "1", extensions: "base"
        });
        const textSearch = await fetch(`https://restapi.amap.com/v3/place/text?${textParams}`, {
          headers: { "User-Agent": "FlowTwin-Demo/1.0" }, signal: AbortSignal.timeout(10000)
        });
        const textPayload = await textSearch.json();
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
    kind: type
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
  return json(response, 200, forecastStations(body.stations || [], body.scenario || {}));
}

async function longTripApi(request, response) {
  const body = await readJsonBody(request, 128000);
  if (!Array.isArray(body.stations)) return json(response, 400, { error: "STATIONS_REQUIRED" });
  if (!Number.isFinite(Number(body.distanceKm)) || Number(body.distanceKm) < 0 || Number(body.distanceKm) > 6000) {
    return json(response, 400, { error: "INVALID_DISTANCE" });
  }
  return json(response, 200, buildLongTripPlans({
    distanceKm: Number(body.distanceKm),
    durationMinutes: Number(body.durationMinutes) || 0,
    stations: body.stations.slice(0, 40),
    energyType: body.energyType,
    soc: body.soc,
    minArrivalSoc: body.minArrivalSoc,
    maxStops: body.maxStops,
    maxDetourKm: body.maxDetourKm
  }));
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

createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "OPTIONS") return json(response, 204, {});
    if (requestUrl.pathname === "/api/health") return json(response, 200, { ok: true, service: "FlowTwin" });
    if (request.method === "GET" && requestUrl.pathname === "/api/contracts") return json(response, 200, API_CONTRACTS);
    if (requestUrl.pathname === "/api/route") return await routeApi(requestUrl, response);
    if (requestUrl.pathname === "/api/poi") return await poiApi(requestUrl, response);
  if (request.method === "POST" && requestUrl.pathname === "/api/plan") return await planApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/forecast") return await forecastApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/longtrip") return await longTripApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/operator/simulate") return await operatorApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/validate") return await validateApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/execution") return await executionApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/stt") return await sttApi(request, response);
    if (requestUrl.pathname === "/runtime-config.js") return await runtimeConfig(response);
    return await staticFile(requestUrl.pathname, response);
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error("FlowTwin request failed without logging request data or credentials");
    return json(response, status, { error: status === 413 ? "REQUEST_TOO_LARGE" : status === 400 ? "INVALID_JSON" : "INTERNAL_SERVER_ERROR" });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`FlowTwin running at http://127.0.0.1:${port}`);
});
