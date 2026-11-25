import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_ORIGIN,
  isPlaceholderValue,
  loadConfig,
  normalizeAiBaseUrl,
  resolveDefaultOrigin
} from "../lib/config.mjs";
import { API_CONTRACTS } from "../lib/contracts.mjs";
import { buildUploadFallback, DEFAULT_SYNTHETIC_SCENE_IMAGE } from "../lib/cv.mjs";
import { executeFeishu } from "../lib/feishu.mjs";
import {
  clearFeishuCaches,
  getFeishuSyncStatus,
  startFeishuSync
} from "../lib/feishu-bitable.mjs";
import { forecastStations, selectForecastPoint } from "../lib/forecast.mjs";
import { buildLongTripPlans } from "../lib/longtrip.mjs";
import { simulateOperator } from "../lib/operator.mjs";
import { formatPlanResponse, parseTripIntent, resolveOfflinePlace, resolvePlace } from "../lib/plan.mjs";
import { createRateLimiter } from "../lib/rate-limit.mjs";
import { createVersionChecker, loadVersionInfo } from "../lib/version.mjs";
import {
  buildLongTripApiInput,
  createRequestHandler,
  extractMultipartFile
} from "../server.mjs";

const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080
]);

async function withServer(overrides, run) {
  const limiter = overrides.rateLimiter || createRateLimiter({
    limits: {
      plan: 100, stt: 100, map: 100, cv: 100, operator: 100, validate: 100,
      "feishu-sync": 100, "feishu-status": 100, approve: 100, "version-check": 100, execution: 100
    },
    trustProxy: false
  });
  let server;
  let port;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = createServer(createRequestHandler({ ...overrides, rateLimiter: limiter }));
    await new Promise((resolve) => candidate.listen(0, "127.0.0.1", resolve));
    const boundPort = candidate.address().port;
    if (!FETCH_BAD_PORTS.has(boundPort)) {
      server = candidate;
      port = boundPort;
      break;
    }
    await new Promise((resolve) => candidate.close(resolve));
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await run({ baseUrl, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("offline gazetteer resolves major hubs without AMap key and keeps unknown places null", async () => {
  const hit = await resolvePlace("上海东方明珠", {});
  assert.ok(hit);
  assert.equal(hit.sourceType, "offline-gazetteer");
  assert.equal(hit.name, "上海东方明珠广播电视塔");
  assert.deepEqual(hit.coordinate, [121.4997, 31.2397]);

  const airport = await resolvePlace("大兴机场", {});
  assert.equal(airport.name, "北京大兴国际机场");
  assert.deepEqual(airport.coordinate, [116.41, 39.509]);

  // Legacy brand alias was removed cleanly; default origin stays neutral
  assert.equal(DEFAULT_ORIGIN.name, "北京国贸 CBD");
  assert.deepEqual(DEFAULT_ORIGIN.coordinate, [116.461, 39.909]);
  assert.equal(resolveOfflinePlace("能链北京总部"), null);

  // All 7 canonical landmarks resolve cleanly in offline gazetteer
  const canonicalLandmarks = [
    ["故宫", "故宫博物院", "北京市"],
    ["长城", "八达岭长城", "北京市"],
    ["华山", "西岳华山风景区", "渭南市"],
    ["黄山", "黄山风景区", "黄山市"],
    ["泰山", "泰山风景区", "泰安市"],
    ["峨眉山", "峨眉山风景区", "乐山市"],
    ["鼓浪屿", "鼓浪屿", "厦门市"]
  ];
  for (const [alias, expectedName, expectedCity] of canonicalLandmarks) {
    const landmark = await resolvePlace(alias, {});
    assert.ok(landmark, `expected offline gazetteer match for ${alias}`);
    assert.equal(landmark.name, expectedName);
    assert.equal(landmark.city, expectedCity);
    assert.equal(landmark.sourceType, "offline-gazetteer");
  }

  // Custom defaultOrigin does NOT hardcode city="北京市"
  const customWithoutCity = resolveOfflinePlace("上海陆家嘴", {
    defaultOrigin: { name: "上海陆家嘴", coordinate: [121.499, 31.239] }
  });
  assert.equal(customWithoutCity.name, "上海陆家嘴");
  assert.equal(customWithoutCity.city, null);
  const customWithCity = resolveOfflinePlace("上海陆家嘴", {
    defaultOrigin: { name: "上海陆家嘴", coordinate: [121.499, 31.239], city: "上海市" }
  });
  assert.equal(customWithCity.city, "上海市");

  // Unknown/gibberish/unrecognized strings MUST return null
  for (const unknown of ["不存在的地方", "燕郊站", "那里", "", "随机火星基地"]) {
    assert.equal(await resolvePlace(unknown, {}), null, `expected null for ${unknown}`);
  }

  // /api/plan exposes mapConfigured and destinationSource cleanly
  await withServer({ config: {} }, async ({ baseUrl }) => {
    const offlinePlanRes = await fetch(`${baseUrl}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "去上海虹桥站，优先准时" })
    });
    assert.equal(offlinePlanRes.status, 200);
    const offlinePlan = await offlinePlanRes.json();
    assert.equal(offlinePlan.mapConfigured, false);
    assert.equal(offlinePlan.destinationSource, "offline-gazetteer");
    assert.deepEqual(offlinePlan.originLocation, [116.461, 39.909]);
    assert.deepEqual(offlinePlan.destinationLocation, [121.32, 31.194]);

    const unknownRes = await fetch(`${baseUrl}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "去不存在的地方" })
    });
    assert.equal(unknownRes.status, 200);
    const unknownPlan = await unknownRes.json();
    assert.equal(unknownPlan.mapConfigured, false);
    assert.equal(unknownPlan.destinationLocation, null);
    assert.equal(unknownPlan.destinationSource, null);
  });

  // Live AMap reports mapConfigured: true and destinationSource: "amap"
  await withServer({
    config: { webServiceKey: "live-key", amapServiceKeys: ["live-key"] },
    fetchImpl: async () => new Response(JSON.stringify({
      status: "1",
      geocodes: [{ formatted_address: "北京南站", province: "北京市", city: "北京市", district: "丰台区", level: "兴趣点", location: "116.379,39.865" }],
      pois: []
    }), { status: 200 })
  }, async ({ baseUrl }) => {
    const liveRes = await fetch(`${baseUrl}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "去北京南站" })
    });
    assert.equal(liveRes.status, 200);
    const livePlan = await liveRes.json();
    assert.equal(livePlan.mapConfigured, true);
    assert.equal(livePlan.destinationSource, "amap");
    assert.deepEqual(livePlan.destinationLocation, [116.379, 39.865]);
  });
});

test("config strips placeholder strings, supports default origin env overrides, and allows internal Docker HTTP URLs", async () => {
  assert.equal(isPlaceholderValue("replace_with_your_web_js_key"), true);
  assert.equal(isPlaceholderValue("YOUR_AI_API_KEY"), true);
  assert.equal(isPlaceholderValue("https://your-ai-gateway.example.com/v1"), true);
  assert.equal(isPlaceholderValue("https://api.deepseek.com/v1"), false);

  // Internal/Docker HTTP hostnames are allowed; public HTTP is still blocked
  assert.equal(normalizeAiBaseUrl("http://cv-service:5099"), "http://cv-service:5099");
  assert.equal(normalizeAiBaseUrl("http://ollama:11434/v1"), "http://ollama:11434/v1");
  assert.equal(normalizeAiBaseUrl("http://10.0.0.8:8080/v1"), "http://10.0.0.8:8080/v1");
  assert.equal(normalizeAiBaseUrl("http://host.docker.internal:5099"), "http://host.docker.internal:5099");
  assert.equal(normalizeAiBaseUrl("http://api.openai.com/v1"), "");
  assert.equal(normalizeAiBaseUrl("https://your-ai-gateway.example.com/v1"), "");

  // Cloud metadata SSRF endpoints MUST be blocked
  for (const blocked of [
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://metadata/v1",
    "http://instance-data/latest",
    "http://metadata.goog/computeMetadata/v1/",
    "http://svc.metadata.local/v1",
    "https://metadata.google.internal/computeMetadata/v1/"
  ]) {
    assert.equal(normalizeAiBaseUrl(blocked), "", `expected cloud metadata URL to be rejected: ${blocked}`);
  }

  const root = await mkdtemp(join(tmpdir(), "flowtwin-placeholder-"));
  try {
    await writeFile(join(root, ".env"), [
      "HOST=0.0.0.0",
      "AMAP_JS_KEY=replace_with_your_web_js_key",
      "AMAP_WEB_SERVICE_KEY_PRIMARY=YOUR_AMAP_KEY",
      "AI_BASE_URL=https://your-ai-gateway.example.com/v1",
      "AI_API_KEY=replace_with_your_ai_api_key",
      "AI_MODEL=YOUR_CHAT_MODEL_NAME",
      "CV_SERVICE_URL=http://cv-service:5099",
      "FLOWTWIN_DEFAULT_ORIGIN_NAME=上海陆家嘴",
      "FLOWTWIN_DEFAULT_ORIGIN_LNG=121.499",
      "FLOWTWIN_DEFAULT_ORIGIN_LAT=31.239"
    ].join("\n"), "utf8");

    const loaded = await loadConfig({ env: {}, root });
    assert.equal(loaded.host, "0.0.0.0");
    assert.equal(loaded.amapKey, "");
    assert.equal(loaded.webServiceKey, "");
    assert.deepEqual(loaded.amapServiceKeys, []);
    assert.equal(loaded.aiBaseUrl, "");
    assert.equal(loaded.aiApiKey, "");
    assert.equal(loaded.aiModel, "");
    assert.equal(loaded.cvServiceUrl, "http://cv-service:5099");
    assert.equal(loaded.defaultOrigin.name, "上海陆家嘴");
    assert.deepEqual(loaded.defaultOrigin.coordinate, [121.499, 31.239]);

    // Out-of-bounds origin coords safely fall back to DEFAULT_ORIGIN coordinate
    const badOrigin = resolveDefaultOrigin({
      FLOWTWIN_DEFAULT_ORIGIN_NAME: "自定义起点",
      FLOWTWIN_DEFAULT_ORIGIN_LNG: "999",
      FLOWTWIN_DEFAULT_ORIGIN_LAT: "31.2"
    });
    assert.equal(badOrigin.name, "自定义起点");
    assert.deepEqual(badOrigin.coordinate, [116.461, 39.909]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operator simulation rejects prototype property names as segmentId safely", () => {
  const sampleStations = [
    { id: "a", name: "A站", occupancy: 0.85, wait: 18, capacity: 20, demand: 14, price: 1.6 },
    { id: "b", name: "B站", occupancy: 0.35, wait: 5, capacity: 24, demand: 6, price: 1.2 }
  ];
  for (const dangerous of ["toString", "constructor", "__proto__", "valueOf"]) {
    const result = simulateOperator({ stations: sampleStations, discountAmount: 5, targetSegment: dangerous });
    assert.equal(result.assumptions.userSegmentSource, "default");
    assert.equal(result.assumptions.userSegment, "全部用户");
    assert.equal(Number.isFinite(result.assumptions.eligibleShare), true);
  }
});

test("extractMultipartFile trims unquoted boundary and preserves trailing -- bytes in binary payloads", () => {
  const payload = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]), Buffer.from("--")]);
  const boundary = "----FlowTwinBoundary123";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.webm"\r\nContent-Type: audio/webm\r\n\r\n`, "binary"),
    payload,
    Buffer.from(`\r\n--${boundary}--\r\n`, "binary")
  ]);
  const extracted = extractMultipartFile(body, `multipart/form-data; boundary=${boundary}   `);
  assert.ok(extracted);
  assert.equal(extracted.filename, "clip.webm");
  assert.equal(extracted.mime, "audio/webm");
  assert.deepEqual(extracted.data, payload);
});

test("HTTP server fixes: OPTIONS 204 empty body, static 405/HEAD, route cartype=2, CV mode norm, execution in-flight dedup", async () => {
  const seenRouteUrls = [];
  const seenCvBodies = [];
  let webhookCalls = 0;
  let releaseWebhook;
  const webhookGate = new Promise((resolve) => { releaseWebhook = resolve; });

  const mockFetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("direction/driving")) {
      seenRouteUrls.push(href);
      return new Response(JSON.stringify({
        status: "1",
        route: { paths: [{ distance: "12000", cost: { duration: "900", tolls: "0" }, steps: [] }] }
      }), { status: 200 });
    }
    if (href.includes("/analyze")) {
      seenCvBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        ok: true,
        mode: "local-ocr",
        inferenceStatus: "executed",
        source: "mock",
        vehicles: [],
        parking: [],
        arrivalRecognition: { status: "recognized", plate: "京A12345", confidence: 0.95 },
        paymentReceipt: { status: "not-run", receiptId: null, amount: null, message: "未执行" },
        dataBoundary: "mock"
      }), { status: 200 });
    }
    if (href.includes("feishu.example.net/hook")) {
      webhookCalls += 1;
      await webhookGate;
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  await withServer({
    config: {
      webServiceKey: "k",
      amapServiceKeys: ["k"],
      cvServiceUrl: "http://cv-service:5099",
      feishuWebhookUrl: "https://feishu.example.net/hook"
    },
    fetchImpl: mockFetch
  }, async ({ baseUrl }) => {
    // OPTIONS returns 204 with strictly empty body
    const optRes = await fetch(`${baseUrl}/api/plan`, { method: "OPTIONS" });
    assert.equal(optRes.status, 204);
    assert.equal(await optRes.text(), "");

    // POST to static file returns 405 Method Not Allowed; HEAD returns 200 empty body
    const postStatic = await fetch(`${baseUrl}/index.html`, { method: "POST" });
    assert.equal(postStatic.status, 405);
    assert.equal(postStatic.headers.get("allow"), "GET, HEAD");
    const headStatic = await fetch(`${baseUrl}/index.html`, { method: "HEAD" });
    assert.equal(headStatic.status, 200);
    assert.equal(await headStatic.text(), "");

    // Route preserves cartype=2 (PHEV/hybrid) alongside 0 and 1
    for (const cartype of ["0", "1", "2"]) {
      const routeRes = await fetch(`${baseUrl}/api/route?origin=116.461,39.909&destination=116.379,39.865&cartype=${cartype}`);
      assert.equal(routeRes.status, 200);
    }
    assert.ok(seenRouteUrls.some((u) => u.includes("cartype=0")));
    assert.ok(seenRouteUrls.some((u) => u.includes("cartype=1")));
    assert.ok(seenRouteUrls.some((u) => u.includes("cartype=2")));

    // CV normalizes mode before forwarding
    const cvRes = await fetch(`${baseUrl}/api/cv/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "  UPLOAD  ", imageData: "data:image/jpeg;base64,/9j/2Q==" })
    });
    assert.equal(cvRes.status, 200);
    assert.equal(seenCvBodies[0].mode, "upload");

    // Concurrent POST /api/execution with same idempotencyKey deduplicates in-flight webhook
    const execReq = () => fetch(`${baseUrl}/api/execution`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "exec-inflight-1", targetStation: "A站", discountAmount: 5 })
    });
    const [p1, p2] = [execReq(), execReq()];
    await new Promise((r) => setTimeout(r, 40));
    releaseWebhook();
    const [r1, r2] = await Promise.all([p1, p2]);
    const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
    assert.equal(webhookCalls, 1);
    assert.equal(d1.used, true);
    assert.equal(d2.used, true);
    assert.ok(d1.idempotent === true || d2.idempotent === true);
  });
});

test("CV fallback accepts JPEGs with trailing bytes after EOI and uses .jpg default scene image", () => {
  assert.equal(DEFAULT_SYNTHETIC_SCENE_IMAGE, "/assets/vision/default-camera-scene.jpg");
  const paddedJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]), Buffer.from("padding")]);
  const res = buildUploadFallback({ imageData: `data:image/jpeg;base64,${paddedJpeg.toString("base64")}` });
  assert.equal(res.ok, true);
});

test("executeFeishu prevents NaN strings when numeric fields are invalid", async () => {
  let sentBody = null;
  const res = await executeFeishu({
    payload: { targetStation: "测试站", discountAmount: "not-a-number", divertedVehicles: "oops", roi: NaN },
    config: { feishuWebhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test" },
    fetchImpl: async (_url, options) => {
      sentBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }
  });
  assert.equal(res.used, true);
  assert.equal(sentBody.content.text.includes("NaN"), false);
  assert.match(sentBody.content.text, /¥0 \/ 单/);
  assert.match(sentBody.content.text, /0 人/);
  assert.match(sentBody.content.text, /0\.00x/);
});

test("feishu-bitable omits empty 完成时间, guards non-object stations, registers job early, and keeps aiResult if sync-table PUT fails", async () => {
  clearFeishuCaches();
  const config = {
    feishuBaseUrl: "https://open.feishu.cn",
    feishuAppId: "app-id",
    feishuAppSecret: "app-secret",
    feishuAppToken: "app-token",
    feishuSnapshotTableId: "tbl-snap",
    feishuStrategyTableId: "tbl-strat",
    feishuSyncTableId: "tbl-sync"
  };
  let syncCreateFields = null;
  let syncPutCount = 0;
  let aiReady = false;
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("tenant_access_token")) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "tok", expire: 7200 }), { status: 200 });
    }
    if (href.includes("batch_create")) {
      return new Response(JSON.stringify({ code: 0, data: { records: [{ record_id: "snap-1" }] } }), { status: 200 });
    }
    if (href.includes("tbl-strat") && options.method === "POST") {
      return new Response(JSON.stringify({ code: 0, data: { record: { record_id: "strat-1" } } }), { status: 200 });
    }
    if (href.includes("tbl-sync") && options.method === "POST") {
      syncCreateFields = JSON.parse(options.body).fields;
      return new Response(JSON.stringify({ code: 0, data: { record: { record_id: "sync-rec-1" } } }), { status: 200 });
    }
    if (href.includes("tbl-strat") && (!options.method || options.method === "GET")) {
      return new Response(JSON.stringify({
        code: 0,
        data: { record: { fields: { AI策略: aiReady ? "分流建议完成" : "" } } }
      }), { status: 200 });
    }
    if (href.includes("tbl-sync") && options.method === "PUT") {
      syncPutCount += 1;
      return new Response(JSON.stringify({ code: 999, msg: "sync table permission error" }), { status: 500 });
    }
    throw new Error(`unexpected ${options.method} ${href}`);
  };

  // Non-object station entries do not crash startFeishuSync
  const started = await startFeishuSync({
    config,
    fetchImpl,
    payload: {
      runId: "run-bitable-fix",
      stations: [null, "bad", [1, 2], { id: "s1", name: "正常站", p90: 15 }]
    }
  });
  assert.equal(started.used, true);
  assert.equal(Object.hasOwn(syncCreateFields, "完成时间"), false);

  // Polling while still processing does NOT call PUT on sync table (no status transition)
  const stillProcessing = await getFeishuSyncStatus({ syncId: started.syncId, config, fetchImpl });
  assert.equal(stillProcessing.status, "processing");
  assert.equal(syncPutCount, 0);

  // When AI completes, sync-table PUT fails but aiResult is preserved!
  aiReady = true;
  const completed = await getFeishuSyncStatus({ syncId: started.syncId, config, fetchImpl });
  assert.equal(syncPutCount, 1);
  assert.equal(completed.status, "completed");
  assert.equal(completed.aiResult, "分流建议完成");
});

test("longtrip caps, enterprise-prior confidence, identity keying, and adaptive greedy detour enforcement", () => {
  const manyStations = Array.from({ length: 80 }, (_, i) => ({
    id: `st-${i}`,
    progressKm: 10 + i * 5,
    detourKm: 1,
    p50: 4,
    p90: 8,
    price: 1.2
  }));
  assert.equal(buildLongTripApiInput({ stations: manyStations, distanceKm: 500 }).stations.length, 40);
  assert.equal(buildLongTripApiInput({ stations: manyStations, distanceKm: 500, adaptiveMaxStops: true }).stations.length, 72);

  // Enterprise prior confidence label preserved on longtrip plan
  const withPrior = buildLongTripPlans({
    distanceKm: 300,
    durationMinutes: 200,
    departureMinutes: 480,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    maxStops: 1,
    maxDetourKm: 8,
    stations: [{
      id: "ep-1",
      name: "先验站",
      progressKm: 150,
      detourKm: 1,
      price: 1.3,
      enterpriseDemandFactor: 1.15,
      enterprisePrior: { matched: true, city: "北京市", energyType: "electric", matchDistanceKm: 12 }
    }]
  });
  assert.equal(withPrior.plansByObjective.fastest.confidence, "enterprise-prior+simulation");
  assert.match(withPrior.plansByObjective.fastest.confidenceLabel, /企业先验\+仿真/);

  // Stations without explicit id remain distinct via stationIdentity()
  const noIdPlans = buildLongTripPlans({
    distanceKm: 300,
    durationMinutes: 200,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    maxStops: 1,
    maxDetourKm: 8,
    stations: [
      { name: "无ID站A", progressKm: 140, detourKm: 0.5, p50: 2, p90: 4, price: 2.0 },
      { name: "无ID站B", progressKm: 160, detourKm: 0.5, p50: 15, p90: 25, price: 0.8 }
    ]
  });
  assert.equal(noIdPlans.plansByObjective.fastest.stops[0].name, "无ID站A");
  assert.equal(noIdPlans.plansByObjective.cheapest.stops[0].name, "无ID站B");

  // Adaptive greedy sequence enforces maxDetourKm
  const detourRespect = buildLongTripPlans({
    distanceKm: 800,
    durationMinutes: 540,
    energyType: "electric",
    soc: 30,
    minArrivalSoc: 20,
    adaptiveMaxStops: true,
    maxStops: 12,
    maxDetourKm: 3,
    stations: [
      { id: "low-detour-1", progressKm: 100, detourKm: 1, p50: 4, p90: 8, price: 1.2 },
      { id: "high-detour-1", progressKm: 120, detourKm: 5, p50: 2, p90: 4, price: 1.0 },
      { id: "low-detour-2", progressKm: 450, detourKm: 1, p50: 4, p90: 8, price: 1.2 },
      { id: "high-detour-2", progressKm: 470, detourKm: 5, p50: 2, p90: 4, price: 1.0 }
    ]
  });
  assert.equal(detourRespect.reason, null);
  assert.ok(detourRespect.plans.every((plan) => plan.totalDetourKm <= 3));
});

test("forecast port vs aggregate confidence parity, interpolated enterprise label, and aggregate arrivalRate factors", () => {
  const portResult = forecastStations([{
    id: "p-sim",
    totalPorts: 6,
    idlePorts: 2,
    chargingPorts: 4,
    faultPorts: 0,
    queueVehicles: 1,
    averageSessionMinutes: 25
  }], { departureMinutes: 480 });
  assert.equal(portResult.stations[0].confidence, "simulation-only");
  assert.equal(portResult.stations[0].forecast[0].confidence, "simulation-only");

  const aggCalm = forecastStations([{ id: "a1", arrivalRate: 2, serviceRate: 2, capacity: 12 }], {
    departureMinutes: 480,
    trafficFactor: 1,
    weatherFactor: 1
  }).stations[0];
  const aggStorm = forecastStations([{ id: "a1", arrivalRate: 2, serviceRate: 2, capacity: 12 }], {
    departureMinutes: 480,
    trafficFactor: 1.3,
    weatherFactor: 1.2
  }).stations[0];
  assert.ok(aggStorm.forecast[0].arrivalRate > aggCalm.forecast[0].arrivalRate * 1.4);

  const interpolated = selectForecastPoint([
    { minute: 0, wait: 4, source: "enterprise-prior+simulation", confidence: "enterprise-prior+simulation", confidenceScore: 60 },
    { minute: 10, wait: 12, source: "enterprise-prior+simulation", confidence: "enterprise-prior+simulation", confidenceScore: 80 }
  ], 5);
  assert.match(interpolated.confidenceLabel, /企业先验\+仿真/);
});

test("plan prefers contextOrigin over hallucinated aiRawOrigin and passes config to intent comparison", async () => {
  const result = await parseTripIntent({
    message: "中途想去吃麦当劳，然后再喝咖啡",
    context: {
      hasPlannedRoute: true,
      origin: "上海虹桥站",
      currentDestination: "杭州西湖风景名胜区"
    },
    config: { aiBaseUrl: "https://ai.flowtwin.dev/v1", aiApiKey: "k", aiModel: "m" },
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            origin: "北京",
            destination: "杭州西湖风景名胜区",
            services: ["餐饮"],
            requestMode: "supplement",
            actions: [{ type: "ADD_SERVICE", service: "餐饮", name: "麦当劳" }],
            clarificationNeeded: false
          })
        }
      }]
    }), { status: 200 })
  });
  assert.equal(result.origin, "上海虹桥站");

  const unconfigured = await parseTripIntent({
    message: "中途想去吃麦当劳",
    context: { hasPlannedRoute: true, currentDestination: "杭州东站" },
    config: {}
  });
  assert.equal(unconfigured.analysis.comparison.safety.aiFailureReason, "not_configured");
});

test("rate-limiter O(1) LRU eviction retains hot clients and evicts least-recently-used", () => {
  let clock = 1000;
  const limiter = createRateLimiter({
    limits: { plan: { limit: 10, windowMs: 60_000 } },
    maxEntries: 2,
    now: () => clock,
    trustProxy: false
  });
  limiter.consume("plan", "192.0.2.1"); // [1]
  clock += 10;
  limiter.consume("plan", "192.0.2.2"); // [1, 2]
  clock += 10;
  limiter.consume("plan", "192.0.2.1"); // touch 1 -> [2, 1]
  clock += 10;
  limiter.consume("plan", "192.0.2.3"); // evicts 2 -> [1, 3]
  assert.equal(limiter.size, 2);
  // Client 1 retained count=2 so next remaining is 7; client 2 was evicted so starts fresh with remaining=9
  assert.equal(limiter.consume("plan", "192.0.2.1").remaining, 7);
  assert.equal(limiter.consume("plan", "192.0.2.2").remaining, 9);
});

test("API_CONTRACTS covers all active routes and version supports validated FLOWTWIN_REPO override", async () => {
  for (const route of [
    "/api/health",
    "/api/contracts",
    "/api/version",
    "/api/version/check",
    "/api/plan",
    "/api/route",
    "/api/poi",
    "/api/weather",
    "/api/stt",
    "/api/forecast",
    "/api/longtrip",
    "/api/operator/simulate",
    "/api/validate",
    "/api/cv/health",
    "/api/cv/analyze",
    "/api/execution",
    "/api/feishu/health",
    "/api/feishu/sync",
    "/api/feishu/sync/:syncId",
    "/api/feishu/strategy/:strategyRecordId/approve"
  ]) {
    assert.ok(Object.hasOwn(API_CONTRACTS, route), `missing contract for ${route}`);
  }

  const info = await loadVersionInfo({
    root: process.cwd(),
    env: { FLOWTWIN_REPO: "acme-org/flowtwin-custom" },
    execImpl: async () => { throw new Error("no git"); }
  });
  assert.equal(info.repo, "acme-org/flowtwin-custom");

  const rejected = await loadVersionInfo({
    root: process.cwd(),
    env: { FLOWTWIN_REPO: "../evil/repo" },
    execImpl: async () => { throw new Error("no git"); }
  });
  assert.equal(rejected.repo, "1Beyond1/flowtwin-demo");

  let checkedUrl = "";
  const checker = createVersionChecker({
    localVersion: info,
    fetchImpl: async (url) => {
      checkedUrl = String(url);
      return new Response(JSON.stringify({ tag_name: "v1.1.1" }), { status: 200 });
    }
  });
  await checker.check();
  assert.match(checkedUrl, /\/repos\/acme-org\/flowtwin-custom\/releases\/latest$/);
});

test("explicit text origin takes precedence over context.originLocation and /runtime-config.js exposes defaultOrigin safely", async () => {
  const fromShanghai = await parseTripIntent({
    message: "从上海去杭州",
    context: {
      origin: "当前位置",
      originLocation: [116.461, 39.909],
      originLocationSource: "用户当前位置（浏览器定位）"
    },
    config: {}
  });
  assert.equal(fromShanghai.origin, "上海");
  assert.deepEqual(fromShanghai.locations.origin?.coordinate, [121.4737, 31.2304]);

  const fromUnknown = await parseTripIntent({
    message: "从不存在的城市去杭州",
    context: {
      origin: "当前位置",
      originLocation: [116.461, 39.909],
      originLocationSource: "用户当前位置（浏览器定位）"
    },
    config: {}
  });
  assert.equal(fromUnknown.origin, "不存在的城市");
  assert.equal(fromUnknown.locations.origin, null);
  assert.equal(formatPlanResponse(fromUnknown).originLocation, null);

  await withServer({
    config: {
      amapKey: "public-js-key",
      sttApiKey: "secret-stt-key",
      aiApiKey: "secret-ai-key",
      defaultOrigin: { name: "上海陆家嘴", coordinate: [121.499, 31.239] }
    }
  }, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/runtime-config.js`);
    assert.equal(res.status, 200);
    const script = await res.text();
    assert.equal(script.includes("secret-stt-key"), false);
    assert.equal(script.includes("secret-ai-key"), false);
    const jsonText = script.replace(/^window\.FLOWTWIN_CONFIG=/, "").replace(/;$/, "");
    const parsed = JSON.parse(jsonText);
    assert.deepEqual(parsed.defaultOrigin, { name: "上海陆家嘴", coord: [121.499, 31.239] });
    assert.equal(parsed.sttEnabled, true);
  });
});

test("extractMultipartFile ignores non-file fields containing name=\"file\" and preserves UTF-8 filenames and trailing CRLF", () => {
  const boundary = "----FlowTwinUtf8Boundary";
  const audioPayload = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x0d, 0x0a]);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\nContent-Disposition: form-data; name="file"; filename="spoof.wav"\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="语音指令_北京.webm"\r\nContent-Type: audio/webm\r\n\r\n`,
      "utf8"
    ),
    audioPayload,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
  ]);
  const extracted = extractMultipartFile(body, `multipart/form-data; boundary="${boundary}"`);
  assert.ok(extracted);
  assert.equal(extracted.filename, "语音指令_北京.webm");
  assert.equal(extracted.mime, "audio/webm");
  assert.deepEqual(extracted.data, audioPayload);
});

test("executionApi error coalescing does not mark failed responses as idempotent or cache them", async () => {
  let webhookCalls = 0;
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  await withServer({
    config: { feishuWebhookUrl: "https://feishu.example.net/hook" },
    fetchImpl: async () => {
      webhookCalls += 1;
      if (webhookCalls === 1) await gate;
      return new Response(JSON.stringify({ code: 500, msg: "boom" }), { status: 500 });
    }
  }, async ({ baseUrl }) => {
    const req = () => fetch(`${baseUrl}/api/execution`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "exec-error-coalesce-1", targetStation: "A站", discountAmount: 5 })
    });
    const [p1, p2] = [req(), req()];
    await new Promise((r) => setTimeout(r, 40));
    releaseFirst();
    const [r1, r2] = await Promise.all([p1, p2]);
    const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
    assert.equal(webhookCalls, 1);
    assert.equal(d1.mode, "error");
    assert.equal(d2.mode, "error");
    assert.notEqual(d1.idempotent, true);
    assert.notEqual(d2.idempotent, true);

    // Retry after failed execution must invoke upstream again (not served from cache)
    const r3 = await req();
    const d3 = await r3.json();
    assert.equal(webhookCalls, 2);
    assert.equal(d3.mode, "error");
    assert.notEqual(d3.idempotent, true);
  });
});

test("POST /api/cv/analyze preserves mode=sample for distinct local fallback when CV service is unconfigured", async () => {
  await withServer({ config: {} }, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/cv/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "sample",
        imageData: "data:image/png;base64,iVBORw0KGgo="
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.mode, "sample-fallback");
    assert.equal(data.source, "内置样例 · 未启用视觉推理模型");
    assert.equal(data.input.kind, "built-in-sample");
    assert.equal(data.note, "内置样板图未启用本地视觉推理服务，仅展示安全降级结构");
  });
});
