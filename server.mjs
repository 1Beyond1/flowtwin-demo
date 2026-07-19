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
import { API_CONTRACTS } from "./lib/contracts.mjs";

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
  if (!origin || !destination || !waypoint || !strategies[key]) return json(response, 400, { error: "INVALID_ROUTE_PARAMS" });

  const { webServiceKey } = config;
  if (!webServiceKey) return json(response, 503, { error: "AMAP_WEB_SERVICE_KEY_MISSING" });
  const params = new URLSearchParams({
    origin,
    destination,
    waypoints: waypoint,
    strategy: strategies[key],
    cartype: requestUrl.searchParams.get("cartype") === "0" ? "0" : "1",
    ferry: "1",
    show_fields: "cost,navi,polyline",
    key: webServiceKey
  });
  const upstream = await fetch(`https://restapi.amap.com/v5/direction/driving?${params}`, {
    headers: { "User-Agent": "FlowTwin-Demo/1.0" },
    signal: AbortSignal.timeout(15000)
  });
  const result = await upstream.json();
  const paths = Array.isArray(result.route?.paths) ? result.route.paths : [];
  if (result.status !== "1" || !paths.length) return json(response, 502, { error: result.info || "AMAP_ROUTE_FAILED", infocode: result.infocode || null });
  const station = { location: waypoint.split(",").map(Number) };
  return json(response, 200, {
    route: normalizePath(paths[0], key, station),
    alternatives: paths.length,
    source: "高德 Web 服务路线规划 2.0"
  });
}

async function runtimeConfig(response) {
  const { amapKey, securityJsCode } = config;
  const body = `window.FLOWTWIN_CONFIG=${JSON.stringify({ amapKey, securityJsCode, mapMode: amapKey ? "live" : "fallback" })};`;
  response.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
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
  const body = await readJsonBody(request, 16000);
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
    if (request.method === "POST" && requestUrl.pathname === "/api/plan") return await planApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/forecast") return await forecastApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/operator/simulate") return await operatorApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/validate") return await validateApi(request, response);
    if (request.method === "POST" && requestUrl.pathname === "/api/execution") return await executionApi(request, response);
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
