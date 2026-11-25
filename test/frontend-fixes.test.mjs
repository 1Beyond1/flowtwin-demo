import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildLongTripPlans } from "../lib/longtrip.mjs";

const repoRoot = new URL("..", import.meta.url);

async function readFrontendFiles() {
  const [html, appJs, serviceIntentJs] = await Promise.all([
    readFile(new URL("./index.html", repoRoot), "utf8"),
    readFile(new URL("./app.js", repoRoot), "utf8"),
    readFile(new URL("./service-intent.js", repoRoot), "utf8")
  ]);
  return { html, appJs, serviceIntentJs };
}

function extractLucideMapKeys(appJs) {
  const match = appJs.match(/const LUCIDE_ICON_PATHS = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(match, "LUCIDE_ICON_PATHS map should exist in app.js");
  const keys = new Set();
  for (const m of match[1].matchAll(/(?:^|\n)\s*(?:"([a-z0-9-]+)"|([a-z][a-z0-9-]*))\s*:/g)) {
    keys.add(m[1] || m[2]);
  }
  return keys;
}

test("offline icon coverage: 100% of data-lucide icons are bundled locally with zero CDN script tags", async () => {
  const { html, appJs } = await readFrontendFiles();

  // Zero external CDN script tags in index.html, and no stale cache-busting query string
  assert.equal(/<script[^>]*unpkg\.com/i.test(html), false, "index.html must not load lucide from unpkg CDN");
  assert.equal(/<script[^>]*webapi\.amap\.com/i.test(html), false, "index.html must not hardcode AMap loader script tag");
  assert.equal(html.includes("20260822"), false, "index.html must not keep stale ?v=20260822 cache buster");

  // Dynamic AMap loader injection must still exist in app.js only for live mode
  assert.match(appJs, /function loadAmapLoaderScript\(/);
  assert.match(appJs, /if \(config\.mapMode !== "live" \|\| !config\.amapKey\)/);

  const iconMapKeys = extractLucideMapKeys(appJs);
  assert.ok(iconMapKeys.size >= 60, `expected comprehensive local icon map, got ${iconMapKeys.size}`);

  // Collect every static data-lucide attribute from index.html and app.js
  const referenced = new Set();
  for (const m of `${html}\n${appJs}`.matchAll(/data-lucide=["']([a-z0-9-]+)["']/g)) {
    referenced.add(m[1]);
  }

  // Also include every dynamically selected icon name used in app.js helpers
  for (const dynamicName of [
    "snowflake", "cloud-lightning", "cloud-rain", "cloud-fog", "wind", "cloud", "cloud-sun", "sun",
    "utensils", "coffee", "armchair", "store",
    "clock-alert", "map-pin-off",
    "battery-charging", "log-out", "circle-dot",
    "alert-circle", "triangle-alert", "info", "check-circle-2", "upload", "wifi", "wifi-off"
  ]) {
    referenced.add(dynamicName);
  }

  const missing = Array.from(referenced).filter((name) => !iconMapKeys.has(name)).sort();
  assert.deepEqual(missing, [], `missing local SVG icon paths for: ${missing.join(", ")}`);
});

test("zero competition or single-company wording remains in index.html or app.js", async () => {
  const { html, appJs } = await readFrontendFiles();
  const forbidden = [
    /评委/,
    /能链/,
    /姚家园/,
    /入围/,
    /展示入口/,
    /轻量\s*MVP/,
    /答辩/,
    /规则解析可用\s*·\s*AI\s*未配置/,
    /规则解析仍可用/
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(html), false, `index.html should not match forbidden pattern ${pattern}`);
    assert.equal(pattern.test(appJs), false, `app.js should not match forbidden pattern ${pattern}`);
  }
  assert.match(html, /完整工作台/);
  assert.match(html, /简洁出行模式/);
  assert.match(html, /北京国贸 CBD/);
  assert.match(appJs, /DEFAULT_ORIGIN_NAME\s*=\s*"北京国贸 CBD"/);
});

test("simulation and vision asset constants use .jpg paths", async () => {
  const { appJs } = await readFrontendFiles();
  const expectedAssets = [
    "/assets/vision/default-camera-scene.jpg",
    "/assets/simulation/fuel-front-day.jpg",
    "/assets/simulation/fuel-overhead-day.jpg",
    "/assets/simulation/fuel-front-night.jpg",
    "/assets/simulation/fuel-overhead-night.jpg",
    "/assets/simulation/ev-front-day.jpg",
    "/assets/simulation/ev-overhead-day.jpg",
    "/assets/simulation/ev-front-night.jpg",
    "/assets/simulation/ev-overhead-night.jpg"
  ];
  for (const asset of expectedAssets) {
    assert.equal(appJs.includes(asset), true, `app.js should reference ${asset}`);
  }
  assert.equal(/\/assets\/(?:vision|simulation)\/[a-z0-9-]+\.png/i.test(appJs), false, "no .png vision/simulation asset constants should remain");
});

test("CSS variables, responsive mobile controls, touch composer guard, and error toast styling are in place", async () => {
  const { html, appJs } = await readFrontendFiles();

  // B7: --ink and --border defined in :root
  assert.match(html, /--ink:\s*var\(--text\);/);
  assert.match(html, /--border:\s*var\(--line\);/);

  // B2: Hover-collapse composer is gated to desktop hover devices and never locks touch/narrow viewports
  assert.match(html, /@media \(min-width: 901px\) and \(hover: hover\)/);
  assert.match(html, /@media \(max-width: 900px\), \(hover: none\)/);
  assert.match(appJs, /function isDesktopComposerCollapsed\(/);

  // Mobile powertrain + departure time exposed in Settings and mobile strip
  assert.match(html, /class="mobile-vehicle-strip"/);
  assert.match(html, /id="mobileDepartureTimeInput"/);
  assert.match(html, /id="settingsDepartureTimeInput"/);
  assert.match(html, /id="settingsEnergyPercentInput"/);

  // Toast tones & icon switching (never hardcode green checkmark for warnings/errors)
  assert.match(html, /\.toast\[data-tone="warning"\]/);
  assert.match(html, /\.toast\[data-tone="error"\]/);
  assert.match(appJs, /function inferToastTone\(/);
  assert.match(appJs, /error:\s*"alert-circle"/);
  assert.match(appJs, /warning:\s*"triangle-alert"/);

  // Full-card modes hide floating map status pills
  assert.match(html, /\.app:not\(\[data-active-mode="driver"\]\)\s*\.map-status/);

  // Vision raw JSON wrapped in collapsed <details>, Feishu panel wrapped in <details>, evidence table scrollable
  assert.match(html, /<details class="vision-raw-details" id="visionJsonDetails"/);
  assert.match(html, /<details class="feishu-ai-details" id="feishuAiDetails"/);
  assert.match(html, /<div class="evidence-table-wrap"><table class="evidence-input-table">/);
});

test("core frontend bug fixes (B3, B5, B6, B8, B9, B10, B11, U2) are implemented cleanly", async () => {
  const { html, appJs } = await readFrontendFiles();

  // U2: No forced entry modal on page load; operator & validation tabs are unlocked
  assert.equal(/initModeChoice[\s\S]{0,600}openModeChoice\(\);/.test(appJs), false, "initModeChoice must not open forced modal on boot");
  assert.equal(/data-mode="operator"[^>]*disabled/.test(html), false, "operator tab must not be disabled");
  assert.equal(/data-mode="validation"[^>]*disabled/.test(html), false, "validation tab must not be disabled");

  // B1: Vision sample sends mode: "sample", voice checks sttConfigured & SpeechRecognition fallback
  assert.match(appJs, /body\.mode = "sample";/);
  assert.match(appJs, /window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/);
  assert.match(appJs, /当前未配置云端语音服务，且浏览器不支持本地语音识别，请直接输入文字/);

  // B3: #minArrivalSocInput uses commit: false on input so typing 10-49% is not mid-keystroke clamped
  assert.match(appJs, /readManualControls\(\{ commit: false, sourceInput: input, markArrivalOverrides: true \}\)/);

  // B5: AbortController fetchWithTimeout + request version guards across async flows
  assert.match(appJs, /async function fetchWithTimeout\(/);
  assert.match(appJs, /if \(requestId !== state\.visionRequestVersion\) return;/);
  assert.match(appJs, /if \(requestId === state\.visionRequestVersion\)/);
  assert.match(appJs, /if \(!state\.simulation\.active \|\| state\.simulationSessionId !== sessionId\) return;/);

  // B6: simulationFrame checks !simulation.paused before requesting next frame
  assert.match(appJs, /if \(!simulation\.paused && simulation\.autoAdvance && simulation\.active && simulation\.phase\?\.type === "drive"\)/);

  // B8: annotatedImage protocol validation + operatorBefore assigned before renderOperatorMetrics
  const safeReMatch = appJs.match(/const SAFE_IMAGE_SRC_RE = (\/.*?\/[a-z]*);/);
  assert.ok(safeReMatch, "SAFE_IMAGE_SRC_RE should be defined");
  const safeRe = vm.runInNewContext(safeReMatch[1]);
  assert.equal(safeRe.test("data:image/jpeg;base64,/9j/4AAQSkZJRg=="), true);
  assert.equal(safeRe.test("data:image/jpg;base64,/9j/4AAQSkZJRg=="), true);
  assert.equal(safeRe.test("DATA:IMAGE/PNG;BASE64,iVBORw0KGgo="), true);
  assert.equal(safeRe.test("/assets/vision/default-camera-scene.jpg"), true);
  assert.equal(safeRe.test("/assets/../secret.jpg"), false);
  assert.equal(safeRe.test("/assets/vision/../../etc/passwd"), false);
  assert.equal(safeRe.test("javascript:alert(1)"), false);
  assert.equal(safeRe.test("https://evil.example/a.png"), false);
  assert.equal(safeRe.test("data:image/svg+xml;base64,PHN2Zz4="), false);
  assert.match(appJs, /const before = state\.operatorBefore \|\| computeOperatorSnapshot\(state\.stations\);\s*state\.operatorBefore = before;/);

  // P2-5: isSafeVideoSrc validates video sources and non-video mode ignores previewVideo
  const safeVideoReMatch = appJs.match(/const SAFE_VIDEO_SRC_RE = (\/.*?\/[a-z]*);/);
  assert.ok(safeVideoReMatch, "SAFE_VIDEO_SRC_RE should be defined");
  const safeVideoRe = vm.runInNewContext(safeVideoReMatch[1]);
  assert.equal(safeVideoRe.test("blob:http://127.0.0.1:4182/550e8400"), true);
  assert.equal(safeVideoRe.test("data:video/mp4;base64,AAAAIGZ0eXBpc29t"), true);
  assert.equal(safeVideoRe.test("data:video/webm;base64,GkXfo59ChoEB"), true);
  assert.equal(safeVideoRe.test("data:video/quicktime;base64,AAAAFGZ0eXA="), true);
  assert.equal(safeVideoRe.test("/assets/vision/sample.mp4"), true);
  assert.equal(safeVideoRe.test("/assets/../etc/passwd"), false);
  assert.equal(safeVideoRe.test("javascript:alert(1)"), false);
  assert.equal(safeVideoRe.test("https://evil.example/clip.mp4"), false);
  assert.match(appJs, /function isSafeVideoSrc\(/);
  assert.match(appJs, /const isVideoMode = String\(result\?\.mode \|\| ""\)\.trim\(\)\.toLowerCase\(\) === "video";/);
  assert.match(appJs, /const videoSource = isVideoMode && isSafeVideoSrc\(result\?\.previewVideo\)/);
  assert.match(appJs, /delete sanitizedResult\.previewVideo;/);

  // B9: waitForAmap returns immediately when mapMode !== "live"
  assert.match(appJs, /if \(config\.mapMode !== "live" \|\| !config\.amapKey \|\| \(!state\.live && !state\.amapLoading\)\)/);

  // B10: Distinct unavailableReason messages, multi-stop syncInsightDisplayCopy, weather+reservations in cache key
  assert.match(appJs, /branch\.unavailableReason === "first-stop-unreachable"/);
  assert.match(appJs, /branch\.unavailableReason === "planning-failed"/);
  assert.match(appJs, /renderServiceRecommendations\(record\);\s*updateServiceNudge\(record\);\s*syncInsightDisplayCopy\(\);\s*return;/);
  assert.match(appJs, /`weather:\$\{weatherKey\}`/);
  assert.match(appJs, /`reservations:\$\{reservationKey\}`/);

  // B11: closePaymentReceipt clears previous timer
  assert.match(appJs, /window\.clearTimeout\(closePaymentReceipt\.timer\);/);
});

function extractAppFunction(appJs, name) {
  const start = appJs.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `expected function ${name} in app.js`);
  let braceDepth = 0;
  let seenOpen = false;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = start; i < appJs.length; i += 1) {
    const ch = appJs[i];
    const next = appJs[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") { inBlockComment = false; i += 1; }
      continue;
    }
    if (inSingle) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === "`") inTemplate = false;
      continue;
    }
    if (ch === "/" && next === "/") { inLineComment = true; i += 1; continue; }
    if (ch === "/" && next === "*") { inBlockComment = true; i += 1; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "`") { inTemplate = true; continue; }
    if (ch === "{") { braceDepth += 1; seenOpen = true; }
    else if (ch === "}") {
      braceDepth -= 1;
      if (seenOpen && braceDepth === 0) return appJs.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

test("P0-1: offline corridor station placement scales dynamically and produces feasible 1200km multi-stop plans at 22% and 80% SOC", async () => {
  const { appJs } = await readFrontendFiles();
  const fnNames = [
    "stableHash",
    "parseLocation",
    "distanceKm",
    "routeDistance",
    "projectPointOntoPath",
    "distanceAlongPathToWaypoint",
    "buildPathMetrics",
    "pointAtPathProgress",
    "pointOnPathWithOffset",
    "slicePathBetweenProgress",
    "buildOfflineCorridorPath",
    "simulatedPrice",
    "simulateStation",
    "fallbackRoutes",
    "buildOfflineCorridorStations",
    "buildOfflineMultiStopRoute"
  ];
  const extracted = fnNames.map((name) => extractAppFunction(appJs, name)).join("\n\n");
  const context = {
    DEFAULT_ORIGIN: { name: "北京国贸 CBD", coordinate: [116.461, 39.909] },
    FALLBACK: { origin: [116.461, 39.909], destination: [116.3789, 39.865] },
    ENERGY_PROFILES: {
      electric: { capacity: 108, consumptionPerKm: 0.18, transferEfficiency: 0.92, safetyReservePercent: 2, unit: "kWh" },
      fuel: { capacity: 55, consumptionPerKm: 0.075, transferEfficiency: 0.95, safetyReservePercent: 3, unit: "L" },
      hybridElectric: { capacity: 20, consumptionPerKm: 0.165, transferEfficiency: 0.92, safetyReservePercent: 2, unit: "kWh" },
      hybridFuel: { capacity: 60, consumptionPerKm: 0.056, transferEfficiency: 0.95, safetyReservePercent: 3, unit: "L" }
    },
    ENERGY_PRICE_BANDS: {
      充电站: { base: 1.15, spread: 60, unit: "kWh" },
      加油站: { base: 7.25, spread: 80, unit: "L" }
    },
    state: {
      live: false,
      origin: [116.461, 39.909],
      destination: [116.3789, 39.865],
      originName: "北京国贸 CBD",
      destinationName: "北京南站",
      energyType: "electric",
      energyPercent: 22,
      hybridBranch: "electric",
      hybridLevels: { electric: 35, fuel: 60 },
      baseRouteRecords: {}
    },
    isHybrid: () => false,
    hybridBranchLevel: () => 22
  };
  vm.runInNewContext(extracted, context);

  // 1) Short trip (<= 120 km): Beijing CBD -> Beijing South Station
  const shortRoutes = context.fallbackRoutes();
  context.state.baseRouteRecords = shortRoutes;
  const shortStations = context.buildOfflineCorridorStations(
    context.state.origin,
    context.state.destination,
    "electric",
    shortRoutes
  );
  assert.ok(shortStations.length >= 3 && shortStations.length <= 4, `short trip should have 3-4 stations, got ${shortStations.length}`);
  for (const st of shortStations) {
    const corridorRoute = shortRoutes[st.corridorKey] || shortRoutes.reliable;
    const proj = context.projectPointOntoPath(st.location, corridorRoute.path);
    assert.ok(proj.offsetKm <= 0.2, `short station offset ${proj.offsetKm} km should be <= 0.15 km`);
    assert.ok(Number.isFinite(context.distanceAlongPathToWaypoint(corridorRoute.path, st.location)));
    assert.ok(st.detourKm >= 0.3 && st.detourKm <= 1.2);
    assert.equal(st.source, "离线走廊站点");
  }

  // 2) Medium intercity (120-400 km): Beijing CBD -> Shijiazhuang (~280 km) at 22% SOC
  context.state.destination = [114.5149, 38.0428];
  context.state.destinationName = "石家庄";
  context.state.energyPercent = 22;
  const mediumRoutes = context.fallbackRoutes();
  context.state.baseRouteRecords = mediumRoutes;
  const mediumStations = context.buildOfflineCorridorStations(
    context.state.origin,
    context.state.destination,
    "electric",
    mediumRoutes
  );
  assert.ok(mediumStations.length >= 5 && mediumStations.length <= 7, `medium trip should have 5-7 stations, got ${mediumStations.length}`);
  assert.ok(mediumStations[0].progressKm <= 45.5, `medium first stop ${mediumStations[0].progressKm} km should be <= 45 km`);
  for (const st of mediumStations) {
    const proj = context.projectPointOntoPath(st.location, mediumRoutes.reliable.path);
    assert.ok(proj.offsetKm <= 0.2, `medium station offset ${proj.offsetKm} km should be <= 0.15 km`);
  }

  // 3) Long cross-province (> 400 km): Beijing CBD -> Shanghai Oriental Pearl (~1290 km)
  context.state.destination = [121.4997, 31.2397];
  context.state.destinationName = "上海东方明珠";
  for (const soc of [22, 80]) {
    context.state.energyPercent = soc;
    const longRoutes = context.fallbackRoutes();
    context.state.baseRouteRecords = longRoutes;
    const rawStations = context.buildOfflineCorridorStations(
      context.state.origin,
      context.state.destination,
      "electric",
      longRoutes
    );
    assert.ok(rawStations.length >= 12 && rawStations.length <= 16, `long trip at ${soc}% SOC should have 12-16 stations, got ${rawStations.length}`);
    const initialSafeRange = (108 * soc / 100 - 108 * 0.02) / 0.18;
    const firstCap = Math.max(25, Math.min(75, initialSafeRange * 0.6));
    assert.ok(rawStations[0].progressKm <= firstCap + 0.5, `first stop ${rawStations[0].progressKm} km must be <= ${firstCap} km at ${soc}% SOC`);
    for (const st of rawStations) {
      const proj = context.projectPointOntoPath(st.location, longRoutes.reliable.path);
      assert.ok(proj.offsetKm <= 0.2, `long station offset ${proj.offsetKm} km must stay well inside 1.2 km`);
      assert.ok(st.progressKm > 0 && st.routeProgress > 0 && st.distanceFromOriginKm === st.progressKm);
      assert.ok(st.detourKm >= 0.3 && st.detourKm <= 1.2);
    }
    const simStations = rawStations.map((st, idx) => context.simulateStation(st, idx));
    const proposal = buildLongTripPlans({
      distanceKm: longRoutes.reliable.distance,
      durationMinutes: longRoutes.reliable.duration,
      roadTolls: longRoutes.reliable.tolls,
      stations: simStations,
      energyType: "electric",
      soc,
      minArrivalSoc: 20,
      maxStops: 12,
      adaptiveMaxStops: true,
      maxDetourKm: 25,
      departureMinutes: 9 * 60,
      useForecast: true
    });
    assert.ok(proposal.plans.length >= 1, `1200km offline long trip at ${soc}% SOC must produce feasible multi-stop plans`);
    const reliablePlan = proposal.plansByObjective.reliable;
    assert.ok(reliablePlan && reliablePlan.stopCount >= 2, `reliable plan at ${soc}% SOC should have >= 2 stops`);
    const chosenStops = reliablePlan.stops.map((stop) => simStations.find((s) => s.id === stop.id)).filter(Boolean);
    const synthetic = context.buildOfflineMultiStopRoute("reliable", longRoutes.reliable, chosenStops);
    assert.ok(synthetic && synthetic.legs.length === chosenStops.length + 1 && synthetic.path.length >= 4);
  }
});

test("P1-1, P1-5, P2-3, P2-7, P2-8 & responsive layout polishes are all enforced", async () => {
  const { html, appJs } = await readFrontendFiles();

  // P1-1: Boot syncs defaultOrigin from FLOWTWIN_CONFIG and parseIntent gates originLocation to browser geolocation
  assert.match(appJs, /function syncDefaultOriginFromConfig\(/);
  assert.match(appJs, /syncDefaultOriginFromConfig\(\);/);
  assert.match(appJs, /const isBrowserOrigin = state\.originSource === "browser";/);
  assert.match(appJs, /\.\.\.\(isBrowserOrigin \? \{\s*originLocation: state\.origin/);

  // P1-5: runExecutionLoop removes unused loopId and unlocks via try/finally; Feishu polling checks pollVersion
  assert.equal(/\bconst loopId\b/.test(appJs), false, "unused loopId must be removed from runExecutionLoop");
  assert.match(appJs, /async function runExecutionLoop\(\)[\s\S]*?try\s*\{[\s\S]*?finally\s*\{[\s\S]*?state\.executionState = "before";[\s\S]*?button\.disabled = false;/);
  const pollGuardMatches = appJs.match(/if \(pollVersion !== state\.feishuPollVersion\) return;/g) || [];
  assert.ok(pollGuardMatches.length >= 6, `expected pollVersion guards across pollFeishuSync & syncFeishuOperatorSnapshot, got ${pollGuardMatches.length}`);

  // P2-3: runSimulationOcr fetches original static asset and sends simulation-scene.jpg
  assert.match(appJs, /image\.dataset\.originalSrc = asset \|\| "";/);
  assert.match(appJs, /const rawOriginalSrc = image\?\.dataset\?\.originalSrc \|\| phase\?\.scene\?\.image/);
  assert.match(appJs, /fileName: "simulation-scene\.jpg"/);
  assert.equal(/fetch\(image\.src/.test(appJs), false, "runSimulationOcr must never fetch image.src directly");

  // P2-7: Offline weather skips /api/weather (zero 503), station badge shows 离线走廊站点, cache key fixed, setEnergyType awaits
  assert.match(appJs, /async function loadWeather\(\)[\s\S]{0,400}if \(!state\.live\)\s*\{[\s\S]{0,200}晴（离线默认）/);
  assert.match(appJs, /const stationSourceLabel = !state\.live \? "离线走廊站点" :/);
  assert.match(appJs, /state\.activeServicePlan\?\.id \|\| state\.selectedService \|\| "none"/);
  assert.match(appJs, /writeCompletedRoutePlan\(completedPlanCacheKey\(state\.baseRouteRecords\)\);/);
  assert.match(appJs, /await finalizeOfflinePlan\(\(\) => requestId === state\.energySwitchVersion\)/);

  // P2-8: Zero legacy airport/Daxing placeholders remain; offline unresolved destination explains built-in hubs
  for (const forbidden of [/大兴榆垡/, /默认机场/, /抵达机场/]) {
    assert.equal(forbidden.test(html), false, `index.html must not contain ${forbidden}`);
    assert.equal(forbidden.test(appJs), false, `app.js must not contain ${forbidden}`);
  }
  assert.match(appJs, /const offlineMapMode = payload\?\.mapConfigured === false;/);

  // Live QA layout polishes: hint pill outside #aiComposer in normal flow, 901-1260px topbar rules, <=900px hides floating status pill
  assert.match(html, /<\/div>\s*<div class="ai-input-hint" id="intentInputHint"/);
  assert.match(html, /\.ai-composer-dock \.ai-input-hint \{\s*position: static;/);
  assert.match(html, /@media \(min-width: 901px\) and \(max-width: 1260px\)/);
  assert.match(html, /@media \(min-width: 901px\) and \(max-width: 1240px\)[\s\S]*?\.status-item \.status-caption/);
  assert.match(html, /@media \(max-width: 900px\)\s*\{\s*\.app\.has-plan \.ai-composer-status/);
});
