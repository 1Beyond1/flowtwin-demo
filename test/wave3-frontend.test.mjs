import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repoRoot = new URL("..", import.meta.url);
const appJsPath = fileURLToPath(new URL("./app.js", repoRoot));

async function readFrontendFiles() {
  const [html, appJs] = await Promise.all([
    readFile(new URL("./index.html", repoRoot), "utf8"),
    readFile(new URL("./app.js", repoRoot), "utf8")
  ]);
  return { html, appJs };
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

function extractAppFunction(appJs, name) {
  const start = appJs.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `expected function ${name} in app.js`);
  let parenDepth = 0;
  let paramsClosed = false;
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
    if (!paramsClosed) {
      if (ch === "(") parenDepth += 1;
      else if (ch === ")") {
        parenDepth -= 1;
        if (parenDepth === 0) paramsClosed = true;
      }
      continue;
    }
    if (ch === "{") { braceDepth += 1; seenOpen = true; }
    else if (ch === "}") {
      braceDepth -= 1;
      if (seenOpen && braceDepth === 0) return appJs.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

test("Wave 3 DOM contract: all required IDs, script order, display-mode visibility, and icon coverage", async () => {
  const { html, appJs } = await readFrontendFiles();

  // 1. Script order: service-intent.js -> vehicle-presets.js -> app.js
  const idxServiceIntent = html.indexOf('<script src="./service-intent.js"></script>');
  const idxVehiclePresets = html.indexOf('<script src="./vehicle-presets.js"></script>');
  const idxAppJs = html.indexOf('<script src="./app.js"></script>');
  assert.ok(idxServiceIntent > 0, "service-intent.js script tag must exist");
  assert.ok(idxVehiclePresets > idxServiceIntent, "vehicle-presets.js must load after service-intent.js");
  assert.ok(idxAppJs > idxVehiclePresets, "app.js must load after vehicle-presets.js");

  // 2. All Wave 3 DOM IDs exist in index.html
  const requiredIds = [
    // F2 Departure Window Optimizer
    "departureWindowCard",
    "departureWindowSummary",
    "departureWindowList",
    // F3 Vehicle Presets & Cost Ledger
    "vehiclePresetSelect",
    "vehiclePresetSpecLine",
    "customVehicleDetails",
    "customVehicleName",
    "customVehicleCapacity",
    "customVehicleConsumption",
    "customVehiclePeakPower",
    "saveCustomVehicleButton",
    "deleteCustomVehicleButton",
    "activeVehiclePill",
    "activeVehiclePillText",
    "openVehiclePresetButton",
    "tripCostBreakdownCard",
    "tripCostEnergyValue",
    "tripCostTollsValue",
    "tripCostCouponRow",
    "tripCostCouponValue",
    "tripCostTouSavingValue",
    "tripCostPerKmValue",
    "tripCostTotalValue",
    "saveCostLedgerButton",
    "openCostLedgerButton",
    "costLedgerSection",
    "ledgerKpiCount",
    "ledgerKpiPaid",
    "ledgerKpiSavings",
    "ledgerKpiAvgPerKm",
    "costLedgerList",
    "exportLedgerCsvButton",
    "clearLedgerButton",
    // F4 Operator Pareto ROI + Coupon Loop
    "operatorParetoCard",
    "operatorParetoChart",
    "operatorParetoReadout",
    "operatorParetoTiers",
    "operatorIssueCouponButton",
    "operatorCouponLoopCard",
    "operatorRefreshCouponsButton",
    "operatorResetCouponsButton",
    "goDriverCouponButton",
    "couponKpiActive",
    "couponKpiClaimed",
    "couponKpiRedeemed",
    "couponKpiRate",
    "couponKpiDiscount",
    "operatorCouponList",
    "operatorRedemptionLog",
    "stationCouponBanner",
    "claimStationCouponButton",
    "redeemStationCouponButton",
    "viewOperatorRedemptionButton",
    // F5 Vision Canvas Queue Annotator
    "visionStageFrame",
    "visionCanvasStage",
    "visionAnnotatorCanvas",
    "visionAnnotatorControls",
    "visionLoadSampleAnnotateButton",
    "visionDemoBoxesButton",
    "visionUndoBoxButton",
    "visionClearBoxesButton",
    "visionTargetStationSelect",
    "visionAnnotatorSummary",
    "visionApplyFeedbackButton",
    "visionFeedbackBanner",
    "visionFeedbackText",
    "visionJumpDriverButton",
    "visionJumpOperatorButton"
  ];
  for (const id of requiredIds) {
    assert.equal(html.includes(`id="${id}"`), true, `index.html must include id="${id}"`);
  }

  // F2 Departure Window Card must be visible in BOTH reviewer and user modes (no data-reviewer-only)
  const depCardTagMatch = html.match(/<section[^>]*id="departureWindowCard"[^>]*>/);
  assert.ok(depCardTagMatch, "departureWindowCard section tag should exist");
  assert.equal(/data-reviewer-only/.test(depCardTagMatch[0]), false, "departureWindowCard must NOT have data-reviewer-only");

  // 3. Every data-lucide icon name across index.html and app.js exists in LUCIDE_ICON_PATHS
  const iconKeys = extractLucideMapKeys(appJs);
  const referenced = new Set();
  for (const m of `${html}\n${appJs}`.matchAll(/data-lucide=["']([a-z0-9-]+)["']/g)) {
    referenced.add(m[1]);
  }
  for (const m of appJs.matchAll(/setAttribute\(\s*["']data-lucide["']\s*,\s*["']([a-z0-9-]+)["']\s*\)/g)) {
    referenced.add(m[1]);
  }
  const missing = Array.from(referenced).filter((name) => !iconKeys.has(name)).sort();
  assert.deepEqual(missing, [], `missing SVG icon paths in LUCIDE_ICON_PATHS: ${missing.join(", ")}`);
});

test("Wave 3 security boundary: zero innerHTML in Wave 3 code and payment receipt rows", async () => {
  const { appJs } = await readFrontendFiles();
  const marker = "// Wave 3 Features:";
  const wave3Start = appJs.indexOf(marker);
  const beginStart = appJs.indexOf("function begin()", wave3Start);
  assert.ok(wave3Start > 0 && beginStart > wave3Start, "Wave 3 module section should be clearly bounded");
  const wave3Code = appJs.slice(wave3Start, beginStart);
  assert.equal(/\.innerHTML\b/.test(wave3Code), false, "Wave 3 code must never assign innerHTML; use safe DOM builders");
  assert.equal(/\.outerHTML\b/.test(wave3Code), false, "Wave 3 code must never assign outerHTML");
  assert.equal(/insertAdjacentHTML\b/.test(wave3Code), false, "Wave 3 code must never use insertAdjacentHTML");

  const receiptFn = extractAppFunction(appJs, "renderPaymentReceipt");
  assert.equal(/\.innerHTML\b/.test(receiptFn), false, "renderPaymentReceipt must build receipt rows with safe DOM APIs");
});

test("Wave 3 API wiring: all new endpoints use JSON Content-Type headers and version/timeout guards", async () => {
  const { appJs } = await readFrontendFiles();

  // Verify postJson always sends Content-Type: application/json
  const postJsonFn = extractAppFunction(appJs, "postJson");
  assert.match(postJsonFn, /"Content-Type":\s*"application\/json"/);

  // Verify /api/departure-windows sends Content-Type: application/json + AbortController + requestVersion
  const depFn = extractAppFunction(appJs, "requestDepartureWindows");
  assert.match(depFn, /fetch\(["']\/api\/departure-windows["']/);
  assert.match(depFn, /"Content-Type":\s*"application\/json"/);
  assert.match(depFn, /new AbortController\(\)/);
  assert.match(depFn, /departureWindowRequestVersion/);

  // Verify Coupon APIs
  assert.match(appJs, /getJson\(["']\/api\/coupons["']/);
  assert.match(appJs, /postJson\(["']\/api\/coupons\/issue["']/);
  assert.match(appJs, /postJson\(["']\/api\/coupons\/claim["']/);
  assert.match(appJs, /postJson\(["']\/api\/coupons\/redeem["']/);

  // Verify Vision queue feedback API
  assert.match(appJs, /postJson\(["']\/api\/vision\/queue-feedback["']/);

  // Verify localStorage / sessionStorage keys from contract
  assert.match(appJs, /FLOWTWIN_ACTIVE_VEHICLE_V1/);
  assert.match(appJs, /FLOWTWIN_CUSTOM_VEHICLES_V1/);
  assert.match(appJs, /FLOWTWIN_COST_LEDGER_V1/);
});

test("Wave 3 syntax check: node --check app.js passes cleanly", () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ["--check", appJsPath], { stdio: "pipe" });
  }, "node --check app.js must pass without syntax errors");
});

test("Wave 3 functional logic: fallback departure windows, TOU badges, ledger summaries, coupon matching, and vision box occupancy", async () => {
  const { appJs } = await readFrontendFiles();
  const fns = [
    "formatClock",
    "resolveTouBadgeSpec",
    "buildLocalFallbackDepartureWindows",
    "summarizeCostLedgerEntries",
    "couponStationMatch",
    "countVisionAnnotations",
    "formatParetoPointReadout"
  ].map((name) => extractAppFunction(appJs, name)).join("\n\n");

  const context = {
    window: {},
    vehiclePresetsLib: {},
    state: {
      departureMinutes: 18 * 60,
      visionAnnotations: [
        { id: "c1", kind: "charging" },
        { id: "c2", kind: "charging" },
        { id: "c3", kind: "charging" },
        { id: "c4", kind: "charging" },
        { id: "i1", kind: "idle" },
        { id: "i2", kind: "idle" },
        { id: "q1", kind: "queue" },
        { id: "q2", kind: "queue" },
        { id: "q3", kind: "queue" },
        { id: "f1", kind: "fault" }
      ]
    },
    activeEnergyKind: () => "electric",
    referenceEnergyPrice: () => 1.45,
    getVehiclePresetsApi: () => ({})
  };
  vm.createContext(context);
  vm.runInContext(fns, context);

  // 1. 5-window departure fallback
  const dep = context.buildLocalFallbackDepartureWindows(
    { id: "st-1", name: "双井超级充电中心", price: 1.4, p50: 10, p90: 16, occupancy: 0.72, arrivalOffsetMinutes: 15 },
    { energyAmount: 45, firstLegKm: 12 }
  );
  assert.equal(dep.windows.length, 5);
  assert.deepEqual(Array.from(dep.windows, (w) => w.offsetMinutes), [0, 30, 60, 90, 120]);
  assert.equal(dep.windows[0].isCurrent, true);
  assert.equal(dep.windows.filter((w) => w.isRecommended).length, 1);

  // 2. TOU badge mapping
  assert.equal(context.resolveTouBadgeSpec({ tariffCode: "valley", tariffTier: "谷时" }).cls, "tou-valley");
  assert.equal(context.resolveTouBadgeSpec({ tariffCode: "flat", tariffTier: "平时" }).cls, "tou-flat");
  assert.equal(context.resolveTouBadgeSpec({ tariffCode: "peak", tariffTier: "峰时" }).cls, "tou-peak");
  assert.equal(context.resolveTouBadgeSpec({ tariffCode: "critical", tariffTier: "尖峰" }).cls, "tou-critical");

  // 3. Vision annotation counts (4 charging, 2 idle, 3 queue, 1 fault -> 71% occupancy)
  const counts = Object.assign({}, context.countVisionAnnotations());
  assert.deepEqual(counts, { charging: 4, idle: 2, queue: 3, fault: 1 });
  const occPct = Math.round(((counts.charging + counts.fault) / (counts.charging + counts.idle + counts.fault)) * 100);
  assert.equal(occPct, 71);

  // 4. Coupon station matching (by ID and by name)
  assert.equal(context.couponStationMatch({ stationId: "st-1", stationName: "A站" }, { id: "st-1", name: "B站" }), true);
  assert.equal(context.couponStationMatch({ stationId: "st-2", stationName: "双井超级充电中心" }, { id: "st-9", name: "双井超级充电中心" }), true);
  assert.equal(context.couponStationMatch({ stationId: "st-2", stationName: "A站" }, { id: "st-9", name: "B站" }), false);

  // 5. Ledger summary
  const summary = context.summarizeCostLedgerEntries([
    { totalPaid: 42.5, totalSavings: 8.5, distanceKm: 50 },
    { totalPaid: 57.5, totalSavings: 11.5, distanceKm: 150 }
  ]);
  assert.equal(summary.count, 2);
  assert.equal(summary.totalPaid, 100);
  assert.equal(summary.totalSavings, 20);
  assert.equal(summary.avgCostPerKm, 0.5);

  // 6. Pareto readout formatting (positive, negative, and ¥0 zero-subsidy baseline)
  const readout = context.formatParetoPointReadout({
    couponAmount: 6,
    divertedVehicles: 9,
    platformCouponCost: 54,
    scenarioRoi: 1.42,
    p90WaitAfter: 11.2,
    isParetoOptimal: true,
    isRecommended: true
  });
  assert.match(readout, /Pareto 前沿/);
  assert.match(readout, /¥6/);
  assert.match(readout, /1\.42x/);

  const zeroReadout = context.formatParetoPointReadout({
    couponAmount: 0,
    divertedVehicles: 1,
    platformCouponCost: 0,
    scenarioRoi: 17.0,
    p90WaitAfter: 15.0
  });
  assert.match(zeroReadout, /零补贴基线/);
  assert.equal(/17\.00x/.test(zeroReadout), false, "¥0 baseline readout must not display inflated 17.00x ROI");

  const negReadout = context.formatParetoPointReadout({
    couponAmount: 12,
    divertedVehicles: 10,
    platformCouponCost: 120,
    scenarioRoi: -0.65,
    p90WaitAfter: 10.5
  });
  assert.match(negReadout, /-0\.65x/);
});

test("Red-Team frontend fixes: P0-1..3, P1-1..8, and P2-1..6 regression guards", async () => {
  const { html, appJs } = await readFrontendFiles();

  // P0-1: findActiveCampaignForStation ONLY matches status === "active" (never superseded)
  const couponFns = [
    "couponStationMatch",
    "findActiveCampaignForStation",
    "loadCostLedgerFromStorage"
  ].map((name) => extractAppFunction(appJs, name)).join("\n\n");

  const storageData = new Map();
  const ctx = {
    COST_LEDGER_STORAGE_KEY: "FLOWTWIN_COST_LEDGER_V1",
    window: {
      localStorage: {
        getItem: (k) => (storageData.has(k) ? storageData.get(k) : null)
      }
    },
    state: {
      activeCoupons: [
        { couponId: "old-1", stationId: "st-1", stationName: "双井站", status: "superseded", discountAmount: 6 },
        { couponId: "new-2", stationId: "st-2", stationName: "方庄站", status: "active", discountAmount: 10 }
      ]
    }
  };
  vm.createContext(ctx);
  vm.runInContext(couponFns, ctx);

  assert.equal(ctx.findActiveCampaignForStation({ id: "st-1", name: "双井站" }), null, "superseded campaign must NOT be returned as active");
  assert.equal(ctx.findActiveCampaignForStation({ id: "st-2", name: "方庄站" })?.couponId, "new-2");

  // P0-3: loadCostLedgerFromStorage filters null, primitives, and nested arrays
  storageData.set("FLOWTWIN_COST_LEDGER_V1", JSON.stringify([null, "bad", 42, [], { id: "entry-1", totalPaid: 32.5 }]));
  const loadedLedger = Array.from(ctx.loadCostLedgerFromStorage());
  assert.equal(loadedLedger.length, 1);
  assert.equal(loadedLedger[0].id, "entry-1");

  // P0-1: finalizeStationPaymentWithCoupon clears stale local claim and never fabricates fake redemption
  const finalizePayFn = extractAppFunction(appJs, "finalizeStationPaymentWithCoupon");
  assert.match(finalizePayFn, /clearLocalCouponClaimForStation\(station\)/);
  assert.match(finalizePayFn, /分流券已失效或已重置，按原价结算/);
  assert.match(finalizePayFn, /forceNoDiscount:\s*true/);
  assert.match(appJs, /postJson\(["']\/api\/coupons\/reset["']/);

  // P0-2: exportCostLedgerCsv fallback uses hardened formula-injection neutralization
  const exportCsvFn = extractAppFunction(appJs, "exportCostLedgerCsv");
  assert.equal(exportCsvFn.includes("/^[\\s\\uFEFF\\u00A0]*[=+\\-@]|^[\\t\\r\\n]/"), true, "exportCostLedgerCsv fallback must neutralize whitespace-padded formula prefixes");
  const csvRe = /^[\s\uFEFF\u00A0]*[=+\-@]|^[\t\r\n]/;
  for (const payload of ["=SUM(A1)", "  =1+1", "\uFEFF+cmd", "\u00A0-2", "\t@evil", "\r\nfoo"]) {
    assert.equal(csvRe.test(payload), true, `expected formula guard to catch ${JSON.stringify(payload)}`);
  }
  assert.equal(csvRe.test("双井超级充电中心"), false);

  // P1-1 & P1-2: applyDepartureWindow version guard, multi-stop sync, pending key dedupe, hideDepartureWindows abort
  const applyDepFn = extractAppFunction(appJs, "applyDepartureWindow");
  assert.match(applyDepFn, /departureApplyVersion/);
  assert.match(applyDepFn, /recomputeMultiStopRecordsFromStations\(\)/);
  assert.match(applyDepFn, /syncStationForecastsIntoRouteCandidates\(\)/);
  const hideDepFn = extractAppFunction(appJs, "hideDepartureWindows");
  assert.match(hideDepFn, /\+\+state\.departureWindowRequestVersion/);
  assert.match(hideDepFn, /state\.departureWindowAbortController\.abort\(\)/);
  assert.match(hideDepFn, /state\.departureWindowPendingKey = null/);
  const reqDepFn = extractAppFunction(appJs, "requestDepartureWindows");
  assert.match(reqDepFn, /state\.departureWindowPendingKey === reqKey/);
  assert.match(reqDepFn, /String\(state\.selectedStation\.id\) !== String\(station\.id\)/);

  // P1-3: applyVisionQueueFeedback contract alignment, race guards, operator select refresh
  const visionFn = extractAppFunction(appJs, "applyVisionQueueFeedback");
  const versionBumps = visionFn.match(/\+\+state\.stationForecastRequestVersion/g) || [];
  assert.ok(versionBumps.length >= 2, "applyVisionQueueFeedback must bump stationForecastRequestVersion before and after patching");
  assert.match(visionFn, /\bmethod,/);
  assert.match(visionFn, /\binputSnapshot,/);
  assert.match(visionFn, /\bavailablePorts,/);
  assert.match(visionFn, /populateOperatorTargetSelect\(\)/);
  assert.match(visionFn, /recomputeMultiStopRecordsFromStations\(\)/);

  // P1-4: renderOperatorParetoCurve handles negative ROI without clamping to 0 and excludes ¥0 baseline from ROI scale
  const paretoFn = extractAppFunction(appJs, "renderOperatorParetoCurve");
  assert.equal(/const yRoi = \(val\) => padT \+ plotH - \(Math\.max\(0,/.test(paretoFn), false, "yRoi must not clamp negative ROI to 0");
  assert.match(paretoFn, /isBaselineZero/);
  assert.match(paretoFn, /minRoi/);

  // P1-5: issueOperatorCoupon prioritizes targetStationSelect among executable stations, blocks < ¥1, never fabricates 1.25 / 6
  const issueFn = extractAppFunction(appJs, "issueOperatorCoupon");
  assert.match(issueFn, /当前沿线没有可承接发券的合作站点，无法下发激励券/);
  assert.match(issueFn, /平台券金额需至少 ¥1 才可下发/);
  assert.equal(/\?\?\s*1\.25/.test(issueFn), false, "issueOperatorCoupon must never fabricate fallback ROI 1.25");
  assert.equal(/\?\?\s*6\b/.test(issueFn), false, "issueOperatorCoupon must never fabricate fallback diverted vehicles 6");

  // P1-6: applyVehiclePresetById preserves multi-stop routes by triggering replan
  const applyPresetFn = extractAppFunction(appJs, "applyVehiclePresetById");
  assert.match(applyPresetFn, /const wasMultiStop = Boolean\(state\.multiStopRouteRecords\)/);
  assert.match(applyPresetFn, /replanRoutesViaStations\(\)/);
  assert.match(applyPresetFn, /finalizeOfflinePlan\(/);
  assert.match(applyPresetFn, /updateEnergyControls\(\{\s*skipInsight:/);

  // P1-7: openSettings uses preventScroll: true before scrolling target into view
  const openSettingsFn = extractAppFunction(appJs, "openSettings");
  assert.match(openSettingsFn, /focus\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.match(openSettingsFn, /requestAnimationFrame\([\s\S]*?scrollIntoView\(\{\s*behavior:\s*"smooth",\s*block:\s*"start"\s*\}\)/);

  // P1-8 & P2-1 & P2-6: index.html DOM & responsive CSS contracts
  assert.match(html, /<input[^>]*id="customVehicleConsumption"[^>]*min="3"/);
  assert.match(html, /\.option-top\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(html, /\.departure-window-list\s*\{[^}]*grid-auto-columns:\s*minmax\(108px,\s*1fr\);/);
  assert.match(html, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.operator-actions\s*\{[^}]*flex-direction:\s*column;/);
  assert.match(html, /id="operatorResetCouponsButton"/);

  // P2-1: app.js consumption clamp aligns with min=3
  const saveVehicleFn = extractAppFunction(appJs, "handleSaveCustomVehicle");
  assert.match(saveVehicleFn, /Math\.max\(3,\s*Math\.min\(40,/);

  // P2-2: per-energy vehicle preset map persistence
  assert.match(appJs, /function loadActiveVehiclePresetMap\(/);
  assert.match(appJs, /function saveActiveVehiclePresetId\(/);

  // P2-3: aligned TOU schedule (0.68 / 1.28 / 1.38) and payment receipt TOU tier
  const fallbackDepFn = extractAppFunction(appJs, "buildLocalFallbackDepartureWindows");
  assert.match(fallbackDepFn, /mult:\s*0\.68/);
  assert.match(fallbackDepFn, /mult:\s*1\.28/);
  assert.match(fallbackDepFn, /mult:\s*1\.38/);
  assert.match(fallbackDepFn, /基准油价/);
  const breakdownFn = extractAppFunction(appJs, "computeCurrentTripBreakdown");
  assert.match(breakdownFn, /peakTouMultiplier\s*=\s*isFuel\s*\?\s*1\s*:\s*1\.38/);
  const receiptFn = extractAppFunction(appJs, "renderPaymentReceipt");
  assert.match(receiptFn, /resolveStationPaymentPricing\(/);
  assert.match(receiptFn, /pricing\.tariffTier/);

  // P2-5: 100-box cap on visionAnnotations
  assert.match(appJs, /state\.visionAnnotations\.length\s*>=\s*100/);
  assert.match(appJs, /最多支持标注 100 个目标框/);
});
