import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4182);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

async function localConfig() {
  let text = "";
  try {
    text = await readFile(join(root, "config.local.js"), "utf8");
  } catch {}
  const readValue = (name) => text.match(new RegExp(`${name}:\\s*["']([^"']+)["']`))?.[1] || "";
  return {
    amapKey: process.env.AMAP_JS_KEY || readValue("amapKey"),
    securityJsCode: process.env.AMAP_SECURITY_JS_CODE || readValue("securityJsCode"),
    webServiceKey: process.env.AMAP_WEB_SERVICE_KEY || readValue("webServiceKey")
  };
}

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

  const { webServiceKey } = await localConfig();
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
  const { amapKey, securityJsCode } = await localConfig();
  const body = `window.FLOWTWIN_CONFIG=${JSON.stringify({ amapKey, securityJsCode, mapMode: amapKey ? "live" : "fallback" })};`;
  response.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

async function staticFile(pathname, response) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  if (requested === ".env" || requested === "config.local.js" || requested.startsWith(".git") || requested.includes("..")) {
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
    if (requestUrl.pathname === "/api/health") return json(response, 200, { ok: true, service: "FlowTwin" });
    if (requestUrl.pathname === "/api/route") return await routeApi(requestUrl, response);
    if (requestUrl.pathname === "/runtime-config.js") return await runtimeConfig(response);
    return await staticFile(requestUrl.pathname, response);
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: "INTERNAL_SERVER_ERROR" });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`FlowTwin running at http://127.0.0.1:${port}`);
});
