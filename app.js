(function () {
  "use strict";

  const config = Object.assign(
    {
      amapKey: "",
      securityJsCode: "",
      mapMode: "live"
    },
    window.FLOWTWIN_CONFIG || {}
  );
  // Concrete service requests (for example “麦当劳”) travel through the
  // browser-side intent helper as first-class data.  The fallback keeps an old
  // cached deployment usable while the new helper file is loading.
  const serviceIntent = window.FlowTwinServiceIntent || {};

  // 必须和 lib/config.mjs 的 DEFAULT_ORIGIN.name 一致：后端用这个名字判断
  // "用户没说起点"，前端用它判断"这个起点是默认值，不是用户要求的"。
  const DEFAULT_ORIGIN_NAME = "能链北京总部";
  // 标准正态的 90 分位，用于在 p50/p90 和标准差之间换算。与 lib/longtrip.mjs
  // 的同名常量保持一致，两边算的是同一条路线的同一个 P90。
  const Z90 = 1.2816;
  const DEFAULT_LONG_TRIP_MAX_STOPS = 6;
  const ADAPTIVE_LONG_TRIP_MAX_STOPS = 12;
  const DEFAULT_VISION_SAMPLE_URL = "/assets/vision/default-camera-scene.png";
  // 地图/演示输入没有支付与驶离事件时间。单独保留一个透明的缓冲项，
  // 避免把这段时间偷偷塞进“排队”等字段；后续企业适配器可以按站点覆盖。
  const DEFAULT_PAYMENT_EXIT_MINUTES = Object.freeze({ fuel: 3, electric: 5 });

  // Local, user-supplied scene assets for the simulation-driving walkthrough.
  // They are deliberately separate from the vision sample: these images are
  // presentation evidence, not a camera feed and not a source of OCR truth.
  const SIMULATION_ASSETS = Object.freeze({
    fuel: Object.freeze({
      day: Object.freeze({ arrival: "/assets/simulation/fuel-front-day.png", station: "/assets/simulation/fuel-overhead-day.png" }),
      night: Object.freeze({ arrival: "/assets/simulation/fuel-front-night.png", station: "/assets/simulation/fuel-overhead-night.png" })
    }),
    electric: Object.freeze({
      day: Object.freeze({ arrival: "/assets/simulation/ev-front-day.png", station: "/assets/simulation/ev-overhead-day.png" }),
      night: Object.freeze({ arrival: "/assets/simulation/ev-front-night.png", station: "/assets/simulation/ev-overhead-night.png" })
    })
  });
  // The walkthrough is a review surface, not a race.  Stage changes are
  // manual by default; these values are only used when the reviewer turns on
  // optional automatic playback.
  // Automatic playback must leave the reservation result on screen long
  // enough for a reviewer to read it.  The async recalculation can take longer
  // than one animation frame, so the reservation phase also has a separate
  // post-completion hold below.
  const SIMULATION_STAGE_MS = Object.freeze({ reservation: 6000, recognition: 4200, queue: 6500, service: 6500, payment: 4200, leave: 3200, arrived: 4500 });

  function paymentExitMinutesFor(energyType, station = {}) {
    const explicit = Number(station?.paymentExitMinutes ?? station?.paymentExitBufferMinutes ?? station?.paymentAndExitMinutes);
    if (Number.isFinite(explicit)) return Number(Math.max(1, Math.min(15, explicit)).toFixed(1));
    return energyType === "fuel" || energyType === "hybridFuel"
      ? DEFAULT_PAYMENT_EXIT_MINUTES.fuel
      : DEFAULT_PAYMENT_EXIT_MINUTES.electric;
  }

  const FALLBACK = {
    origin: [116.491, 39.951],
    destination: [116.410, 39.509],
    routes: {
      fastest: [
        [116.491, 39.951], [116.523, 39.907], [116.531, 39.844], [116.514, 39.777],
        [116.482, 39.708], [116.454, 39.637], [116.426, 39.566], [116.410, 39.509]
      ],
      reliable: [
        [116.491, 39.951], [116.515, 39.912], [116.505, 39.852], [116.489, 39.789],
        [116.466, 39.715], [116.444, 39.648], [116.425, 39.585], [116.410, 39.509]
      ],
      cheapest: [
        [116.491, 39.951], [116.472, 39.913], [116.451, 39.852], [116.436, 39.790],
        [116.421, 39.721], [116.411, 39.652], [116.405, 39.581], [116.410, 39.509]
      ]
    },
    stations: [
      {
        id: "fallback-1",
        name: "亦庄能源驿站",
        address: "北京市大兴区荣华南路",
        location: [116.492, 39.789],
        type: "充电站"
      },
      {
        id: "fallback-2",
        name: "大兴榆垡综合能源站",
        address: "北京市大兴区榆垡镇",
        location: [116.445, 39.648],
        type: "充电站"
      },
      {
        id: "fallback-3",
        name: "机场东侧补能站",
        address: "北京大兴国际机场东侧",
        location: [116.421, 39.556],
        type: "充电站"
      },
      {
        id: "fallback-4",
        name: "南城综合能源服务站",
        address: "北京市大兴区黄村镇",
        location: [116.350, 39.725],
        type: "加油站"
      },
      {
        id: "fallback-5",
        name: "亦庄东侧加油站",
        address: "北京市大兴区荣华南路",
        location: [116.496, 39.790],
        type: "加油站"
      },
      {
        id: "fallback-6",
        name: "机场南路加油站",
        address: "北京市大兴区机场南路",
        location: [116.422, 39.584],
        type: "加油站"
      }
    ]
  };

  function getBrowserLocalMinutes(date = new Date()) {
    return date.getHours() * 60 + date.getMinutes();
  }

  // Read the visitor's own device clock once when the demo opens. The control
  // remains editable afterwards so a reviewer can test a planned departure time.
  const INITIAL_DEPARTURE_MINUTES = getBrowserLocalMinutes();
  const INITIAL_DEADLINE_MINUTES = (INITIAL_DEPARTURE_MINUTES + 120) % (24 * 60);

  const state = {
    AMap: null,
    map: null,
    live: false,
    mode: "driver",
    displayMode: "reviewer",
    selectedRoute: "reliable",
    routeSelectionTouched: false,
    origin: FALLBACK.origin,
    destination: FALLBACK.destination,
    routeRecords: {},
    routeDisplayKeys: [],
    routeDisplayGroups: [],
    routeCandidates: {},
    baseRouteRecords: {},
    multiStopRouteRecords: null,
    multiStopPlanningMeta: null,
    serviceRouteOverrides: {},
    reservationOverrides: {},
    routeOverlays: {},
    stationOverlays: [],
    stations: [],
    provisionalCorridorActive: false,
    selectedStation: null,
    stationMarkerById: new Map(),
    mobileInsightOpen: false,
    requestVersion: 0,
    departureMinutes: INITIAL_DEPARTURE_MINUTES,
    deadlineMinutes: INITIAL_DEADLINE_MINUTES,
    deadlineEnabled: true,
    energyPercent: 22,
    minArrivalSoc: 20,
    arrivalReserveEnabled: true,
    manualDeadlineOverride: null,
    manualArrivalReserveOverride: null,
    maxDetourKm: 8,
    detourExplicit: false,
    // 后端 formatPlanResponse 一直在返回 originLocation，但前端过去只取了
    // destinationLocation。结果是"从上海去杭州"照样从北京总部起算——画出来的
    // 折线是真的，却是另一趟行程的。起点必须和终点一样被解析、被显示、被校验。
    originName: DEFAULT_ORIGIN_NAME,
    originNote: "北京市朝阳区姚家园南路 1 号 · 演示默认起点",
    destinationName: "北京大兴国际机场",
    energyType: "electric",
    // A hybrid carries two independent levels. `hybridLevels` is the source of
    // truth for both; `energyPercent` mirrors whichever branch is being planned,
    // so every existing single-level calculation keeps working unchanged.
    hybridBranch: "electric",
    hybridBranchTouched: false,
    hybridLevels: { electric: 35, fuel: 60 },
    // 记录本轮规划里已经实测失败过的混动分支。evaluateEnergyBranch 用直线距离
    // 估可达性，会放过"直线够得着、路况够不着"的站，于是推荐电、规划器又判
    // NO_FEASIBLE_SEQUENCE。把规划结果反馈回来：活动分支三条线全挂就记一笔，
    // 之后的对比不再把它当可用，推荐才会落到另一分支。手动切换时清空，给用户
    // 重新尝试的余地；新一轮规划也清空。
    hybridFailedBranches: new Set(),
    hybridComparison: null,
    priority: "on_time",
    selectedService: null,
    serviceSuggestion: null,
    serviceSuggestionDismissed: new Set(),
    serviceRequestVersion: 0,
    activeServicePlan: null,
    executionState: "before",
    operatorBefore: null,
    operatorAfter: null,
    operatorOriginalStations: [],
    routeErrors: {},
    aiContext: null,
    parseAnalysis: null,
    aiHealth: { state: "checking", configured: null },
    aiActive: false,
    voiceAutoPlan: true,
    lastIntentSignature: null,
    lastRequestMode: "new_trip",
    forecastRequestVersion: 0,
    validationLoaded: false,
    validationPayload: null,
    pendingOperatorPayload: null,
    pendingOperatorSnapshot: null,
    feishuSync: null,
    feishuPollVersion: 0,
    hasPlannedRoute: false,
    vehiclePlate: "京A·FT2026",
    paymentState: "authorized",
    paymentReceipt: null,
    weather: null,
    // User-authored intermediate stops are kept separately from energy/service
    // stops.  They are resolved by AMap and merged into every subsequent road
    // segment request; the language model never supplies route geometry.
    tripWaypoints: [],
    actionJournal: [],
    lastAction: null,
    lastActionSummary: "",
    stationForecastRequestVersion: 0,
    stationForecastScenarioKey: null,
    visionResult: null,
    visionFile: null,
    visionRequestVersion: 0,
    simulation: {
      active: false,
      paused: false,
      autoAdvance: true,
      speed: 3,
      preferredSpeed: 3,
      phaseIndex: 0,
      phaseElapsedMs: 0,
      progress: 0,
      phases: [],
      recordKey: null,
      record: null,
      marker: null,
      fallbackMarker: null,
      rafId: null,
      lastFrameAt: 0,
      lastMapCenterAt: 0,
      lastCenteredPhaseIndex: -1,
      pathMetrics: null,
      savedMapView: null,
      stageContext: null,
      reservedStops: new Set(),
      recognitionResolved: false,
      ocrFallbackUsed: false,
      ocrFallbackAvailable: false,
      ocrBusy: false,
      ocrPhaseKey: null,
      recognizedPlate: null,
      reservationPending: false,
      reservationBeforeSnapshot: null,
      reservationAfterSnapshot: null,
      reservationStopKey: null,
      reservationEvidenceOpen: false,
      skippedStopIndexes: new Set(),
      ocrHealth: null
    }
  };

  // The first-run example intentionally leaves arrival time and reserve open.
  // Those are optional controls: pinning them in a static demo sentence makes
  // the experience depend on the viewer's local clock and can turn a useful
  // meal recommendation into an artificial "late" failure.
  const DEFAULT_DEMO_INTENT = "从能链北京总部前往上海东方明珠广播电视塔，优先准时";

  const ENERGY_PROFILES = {
    // Keep the browser mirror identical to lib/energy.mjs: the demo EV is
    // calibrated to a 600 km full-charge reference, while the fuel baseline
    // remains a little above the requested 600 km floor.
    electric: { capacity: 108, consumptionPerKm: 0.18, transferEfficiency: 0.92, safetyReservePercent: 2, unit: "kWh", nominalFullRangeKm: 600 },
    fuel: { capacity: 55, consumptionPerKm: 0.075, transferEfficiency: 0.95, safetyReservePercent: 3, unit: "L", nominalFullRangeKm: 733 },
    // A plug-in hybrid is not a BEV with a tank bolted on: its pack is roughly a
    // quarter the size and its engine runs in a more efficient regime. Reusing
    // the pure-EV profile would overstate its electric range about fourfold and
    // make every 油电 comparison meaningless.
    hybridElectric: { capacity: 20, consumptionPerKm: 0.165, transferEfficiency: 0.92, safetyReservePercent: 2, unit: "kWh", nominalFullRangeKm: 121 },
    hybridFuel: { capacity: 60, consumptionPerKm: 0.056, transferEfficiency: 0.95, safetyReservePercent: 3, unit: "L", nominalFullRangeKm: 1071 }
  };
  const VEHICLE_RANGE_GUIDANCE = { electricFullRangeKm: 600, fuelFullRangeKm: 733, hybridCombinedFullRangeKm: 1200 };

  const ENERGY_TYPES = ["electric", "fuel", "hybrid"];
  const VOICE_AUTO_PLAN_STORAGE_KEY = "FLOWTWIN_VOICE_AUTO_PLAN";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const byId = (id) => document.getElementById(id);

  function normalizeDisplayMode(value) {
    return value === "user" ? "user" : "reviewer";
  }

  function readVoiceAutoPlan() {
    try {
      return window.localStorage.getItem(VOICE_AUTO_PLAN_STORAGE_KEY) !== "false";
    } catch (_) {
      return true;
    }
  }

  function setVoiceAutoPlan(enabled, options = {}) {
    state.voiceAutoPlan = Boolean(enabled);
    const toggle = byId("voiceAutoPlanToggle");
    if (toggle) toggle.checked = state.voiceAutoPlan;
    if (options.persist === false) return;
    try {
      window.localStorage.setItem(VOICE_AUTO_PLAN_STORAGE_KEY, String(state.voiceAutoPlan));
    } catch (_) { /* ignore storage failures */ }
  }

  function isUserDisplayMode() {
    return state.displayMode === "user";
  }

  function displayCopy(value) {
    const text = String(value ?? "");
    if (!isUserDisplayMode()) return text;
    return text
      .replace(/总等待\s*P90/g, "预计排队")
      .replace(/P90\s*等待风险/g, "排队风险")
      .replace(/P90\s*等待/g, "预计排队")
      .replace(/P50\s*典型等待/g, "典型排队")
      .replace(/\bP90\b/g, "拥堵风险")
      .replace(/\bP50\b/g, "典型排队");
  }

  function syncStaticDisplayCopy() {
    $$('[data-reviewer-copy]').forEach((element) => {
      const reviewerCopy = element.dataset.reviewerCopy || element.textContent || "";
      const userCopy = element.dataset.userCopy || displayCopy(reviewerCopy);
      element.textContent = isUserDisplayMode() ? userCopy : reviewerCopy;
    });
    const chart = byId("forecastChart");
    if (chart) {
      chart.setAttribute("aria-label", isUserDisplayMode()
        ? "未来三十分钟预计排队与拥堵风险预测折线图"
        : "未来三十分钟 P50 与 P90 排队时间预测折线图");
    }
  }

  function setDisplayMode(mode, options = {}) {
    const next = normalizeDisplayMode(mode);
    state.displayMode = next;
    if (document.body) document.body.dataset.displayMode = next;
    byId("app")?.setAttribute("data-display-mode", next);
    $$('[data-display-mode-option]').forEach((button) => {
      const active = button.dataset.displayModeOption === next;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", String(active));
    });
    syncStaticDisplayCopy();
    // User mode never leaves an operations/evidence view open after the entry
    // points are hidden. Returning to driver keeps the safety and route panels
    // available without duplicating a second DOM tree.
    if (next === "user" && state.mode !== "driver") setMode("driver");
    if (state.hasPlannedRoute) renderRouteCards();
  }

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons({ attrs: { "stroke-width": 1.9 } });
    }
  }

  function initDemoNotice() {
    const backdrop = byId("demoNoticeBackdrop");
    const confirm = byId("demoNoticeConfirm");
    if (!backdrop || !confirm) return;
    const close = () => {
      backdrop.classList.add("hidden");
      confirm.blur();
    };
    confirm.addEventListener("click", close);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !backdrop.classList.contains("hidden")) close();
    });
  }

  let settingsPreviousFocus = null;
  let modeChoicePreviousFocus = null;
  let versionInfoLoading = null;

  function modeChoiceFocusableElements() {
    const panel = byId("modeChoicePanel");
    if (!panel) return [];
    return Array.from(panel.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"))
      .filter((element) => !element.disabled && !element.hidden && element.offsetParent !== null);
  }

  function closeModeChoice(mode = "reviewer") {
    const backdrop = byId("modeChoiceBackdrop");
    if (!backdrop || backdrop.hidden) return;
    setDisplayMode(mode);
    backdrop.hidden = true;
    document.body.classList.remove("mode-choice-open");
    const previous = modeChoicePreviousFocus;
    modeChoicePreviousFocus = null;
    if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus();
  }

  function openModeChoice() {
    const backdrop = byId("modeChoiceBackdrop");
    const panel = byId("modeChoicePanel");
    if (!backdrop || !panel) return;
    // Every page visit starts from the reviewer view. The choice is a session
    // decision only; it is deliberately not persisted between visits.
    setDisplayMode("reviewer", { persist: false });
    modeChoicePreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    backdrop.hidden = false;
    document.body.classList.add("mode-choice-open");
    window.setTimeout(() => {
      const first = modeChoiceFocusableElements()[0];
      (first || panel).focus();
    }, 0);
    refreshIcons();
  }

  function handleModeChoiceKeydown(event) {
    const backdrop = byId("modeChoiceBackdrop");
    if (!backdrop || backdrop.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModeChoice("reviewer");
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = modeChoiceFocusableElements();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function initModeChoice() {
    const backdrop = byId("modeChoiceBackdrop");
    if (!backdrop) return;
    $$('[data-display-mode-choice]').forEach((button) => {
      button.addEventListener("click", () => closeModeChoice(button.dataset.displayModeChoice));
    });
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModeChoice("reviewer");
    });
    document.addEventListener("keydown", handleModeChoiceKeydown);
    openModeChoice();
  }

  function settingsFocusableElements() {
    const panel = byId("settingsPanel");
    if (!panel) return [];
    return Array.from(panel.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"))
      .filter((element) => !element.disabled && !element.hidden && element.offsetParent !== null);
  }

  function setVersionText(id, value) {
    const element = byId(id);
    if (element) element.textContent = String(value ?? "");
  }

  function safeGithubUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function renderVersionInfo(payload) {
    const version = String(payload?.version || "1.1.0").replace(/^v/i, "");
    setVersionText("currentVersionValue", `v${version}`);
    setVersionText("currentCommitValue", payload?.commit ? String(payload.commit).slice(0, 7) : "—");
    const source = payload?.source || "package.json";
    const commitSource = payload?.commitSource ? ` · ${payload.commitSource}` : "";
    setVersionText("currentBuildSourceValue", `${source}${commitSource}`);
  }

  async function loadVersionInfo() {
    if (versionInfoLoading) return versionInfoLoading;
    versionInfoLoading = getJson("/api/version", 8000)
      .then((payload) => {
        renderVersionInfo(payload);
        setVersionText("versionInfoStatus", "版本信息已读取");
        return payload;
      })
      .catch(() => {
        // The visible fallback is the shipped package version, not a claim
        // about the remote checkout. Update checking has its own three states.
        renderVersionInfo({ version: "1.1.0", source: "本地页面默认值" });
        setVersionText("versionInfoStatus", "暂时无法读取服务版本信息");
        return null;
      })
      .finally(() => { versionInfoLoading = null; });
    return versionInfoLoading;
  }

  function renderVersionCheckState(stateName, message, payload = null) {
    const status = byId("versionCheckStatus");
    if (status) {
      status.dataset.state = stateName;
      status.textContent = message;
    }
    const link = byId("versionUpdateLink");
    const url = stateName === "update" ? safeGithubUrl(payload?.remote?.url) : null;
    if (link) {
      if (url) {
        link.href = url;
        link.hidden = false;
      } else {
        link.removeAttribute("href");
        link.hidden = true;
      }
    }
  }

  function versionUnavailableMessage(payload) {
    switch (payload?.reason) {
      case "LOCAL_COMMIT_NOT_PUBLISHED":
        return "当前为尚未发布的开发版本";
      case "LOCAL_COMMIT_UNAVAILABLE":
        return "当前部署缺少提交版本标识";
      case "GITHUB_RATE_LIMITED":
        return "GitHub 请求受限，请稍后重试";
      case "GITHUB_TIMEOUT":
      case "GITHUB_OFFLINE":
        return "暂时无法连接 GitHub";
      case "GITHUB_REPOSITORY_OR_MAIN_NOT_FOUND":
        return "无法读取 GitHub 主分支";
      default:
        return "暂时无法检查";
    }
  }

  async function checkVersion() {
    const button = byId("checkVersionButton");
    if (button?.disabled) return;
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
    renderVersionCheckState("checking", "正在检查更新…");
    try {
      const payload = await getJson("/api/version/check", 8000);
      renderVersionInfo(payload);
      if (payload?.status === "up-to-date" || payload?.isLatest === true) {
        renderVersionCheckState("latest", "已是最新", payload);
      } else if (payload?.status === "update-available" || payload?.updateAvailable === true) {
        renderVersionCheckState("update", "发现新版本", payload);
      } else {
        renderVersionCheckState("unavailable", versionUnavailableMessage(payload), payload);
      }
    } catch (_) {
      // A failed request is never treated as an old version.
      renderVersionCheckState("unavailable", "暂时无法检查");
    } finally {
      if (button) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    }
  }

  function openSettings() {
    const backdrop = byId("settingsBackdrop");
    const panel = byId("settingsPanel");
    const trigger = byId("settingsButton");
    if (!backdrop || !panel) return;
    settingsPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : trigger;
    backdrop.hidden = false;
    document.body.classList.add("settings-open");
    trigger?.setAttribute("aria-expanded", "true");
    window.setTimeout(() => {
      const first = settingsFocusableElements()[0];
      (first || panel).focus();
    }, 0);
    loadVersionInfo();
  }

  function closeSettings() {
    const backdrop = byId("settingsBackdrop");
    const trigger = byId("settingsButton");
    if (!backdrop || backdrop.hidden) return;
    backdrop.hidden = true;
    document.body.classList.remove("settings-open");
    trigger?.setAttribute("aria-expanded", "false");
    const previous = settingsPreviousFocus;
    settingsPreviousFocus = null;
    if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus();
    else trigger?.focus();
  }

  function handleSettingsKeydown(event) {
    const backdrop = byId("settingsBackdrop");
    if (!backdrop || backdrop.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeSettings();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = settingsFocusableElements();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function initSettings() {
    byId("settingsButton")?.addEventListener("click", openSettings);
    byId("settingsCloseButton")?.addEventListener("click", closeSettings);
    byId("settingsBackdrop")?.addEventListener("click", (event) => {
      if (event.target === byId("settingsBackdrop")) closeSettings();
    });
    byId("checkVersionButton")?.addEventListener("click", checkVersion);
    setVoiceAutoPlan(readVoiceAutoPlan(), { persist: false });
    byId("voiceAutoPlanToggle")?.addEventListener("change", (event) => {
      setVoiceAutoPlan(event.target.checked);
      showToast(event.target.checked ? "语音识别后将自动开始规划" : "语音识别结果将保留在输入框", 2400);
    });
    $$('[data-display-mode-option]').forEach((button) => {
      button.addEventListener("click", () => setDisplayMode(button.dataset.displayModeOption));
    });
    document.addEventListener("keydown", handleSettingsKeydown);
  }

  function setMapStatus(message, type) {
    const status = byId("mapStatus");
    if (!status) return;
    const text = status.querySelector("span");
    if (text) text.textContent = message;
    status.classList.toggle("error", type === "error");
    status.classList.toggle("ready", type === "ready");
    const icon = status.querySelector("i, svg");
    if (icon && type === "error") {
      icon.outerHTML = '<i data-lucide="triangle-alert"></i>';
      refreshIcons();
    }
  }

  function showToast(message, duration) {
    const toast = byId("toast");
    const text = byId("toastText");
    if (!toast || !text) return;
    text.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("visible"), duration || 2800);
  }

  function fitIntentInput() {
    const input = byId("intentInput");
    if (!input || input.tagName !== "TEXTAREA") return;
    const minHeight = 54;
    const maxHeight = 104;
    input.style.height = "auto";
    const next = Math.min(Math.max(input.scrollHeight, minHeight), maxHeight);
    input.style.height = `${next}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function revealServiceFlow(options = {}) {
    const panel = byId("insightPanel");
    const flow = byId("serviceFlow");
    const expand = byId("expandInsight");
    if (panel) {
      panel.hidden = false;
      panel.classList.remove("hidden", "collapsed");
      if (window.innerWidth <= 760) {
        state.mobileInsightOpen = true;
        panel.classList.add("mobile-visible");
        const sheet = byId("routeSheet");
        if (sheet) sheet.style.display = "none";
      }
    }
    if (expand) expand.hidden = false;
    if (flow) {
      try {
        flow.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      } catch (_) {
        flow.scrollIntoView();
      }
      if (options.attention !== false) {
        flow.classList.remove("attention");
        // Force reflow so repeated pulses still animate.
        void flow.offsetWidth;
        flow.classList.add("attention");
        window.clearTimeout(revealServiceFlow.timer);
        revealServiceFlow.timer = window.setTimeout(() => flow.classList.remove("attention"), 1500);
      }
    }
    if (options.toast) showToast(options.toast, options.toastDuration || 2600);
  }

  function clearDestinationCandidates() {
    const box = byId("destinationCandidates");
    if (!box) return;
    box.innerHTML = "";
    box.hidden = true;
  }

  function showDestinationCandidates(candidates) {
    const box = byId("destinationCandidates");
    const reply = byId("aiReply");
    if (!box) return;
    const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (list.length < 2) {
      clearDestinationCandidates();
      return;
    }
    if (reply) {
      reply.hidden = false;
      reply.classList.add("visible");
    }
    box.hidden = false;
    box.innerHTML = list.map((candidate, index) => {
      const name = String(candidate.name || candidate.destination || candidate.label || `候选 ${index + 1}`).trim();
      const city = String(candidate.city || "").trim();
      const address = String(candidate.address || candidate.district || "").trim();
      const meta = address || city;
      const title = meta ? `${name} · ${meta}` : name;
      const label = meta
        ? `<strong>${escapeHtml(name)}</strong><small>${escapeHtml(meta)}</small>`
        : `<strong>${escapeHtml(name)}</strong>`;
      return `<button type="button" class="destination-candidate" data-candidate-index="${index}" title="${escapeHtml(title)}">${label}</button>`;
    }).join("");
    box.dataset.candidates = JSON.stringify(list.map((candidate) => {
      const coordinate = candidate.coordinate || candidate.location || candidate.lnglat || null;
      return {
        name: candidate.name || candidate.destination || candidate.label || "",
        address: candidate.address || candidate.district || candidate.city || "",
        location: coordinate,
        coordinate,
        destination: candidate.destination || candidate.name || candidate.label || ""
      };
    }));
  }

  function replaceDestinationInIntent(value, destination) {
    const current = String(value || "").trim();
    const nextDestination = String(destination || "").trim();
    if (!current || !nextDestination) return current;

    // Replace the destination clause up to the first constraint separator.
    // A lazy match here could replace only "去"/"前往", leaving the old
    // ambiguous query behind (例如：南京南站南京).
    const replaced = current.replace(
      /((?:前往|去|到(?!达))\s*)[^，,。；;]+(?=[，,。；;]|$)/,
      `$1${nextDestination}`
    );
    return replaced === current ? `${current}，目的地定为${nextDestination}` : replaced;
  }

  async function pickDestinationCandidate(index) {
    const box = byId("destinationCandidates");
    if (!box?.dataset.candidates) return;
    let list = [];
    try { list = JSON.parse(box.dataset.candidates || "[]"); } catch (_) { list = []; }
    const candidate = list[Number(index)];
    if (!candidate) return;
    const name = String(candidate.name || candidate.destination || "").trim();
    if (!name) return;
    const location = candidate.location || candidate.coordinate || null;
    const input = byId("intentInput");
    const current = input ? input.value.trim() : "";
    // 起点用当前行程的实际起点，而不是写死"能链北京总部"--否则用户已经从上海出发
    // 规划，点选目的地候选时输入框会突然跳回"从能链北京总部前往…"。
    const originForSuggestion = state.originName || DEFAULT_ORIGIN_NAME;
    const nextMessage = current
      ? replaceDestinationInIntent(current, name)
      : `从${originForSuggestion}前往${name}`;
    if (input) {
      input.value = nextMessage.includes(name) ? nextMessage : `从${originForSuggestion}前往${name}`;
      fitIntentInput();
    }
    clearDestinationCandidates();
    setAiReply(`已选择目的地「${name}」，继续规划…`);
    setText("aiReplyMeta", "已选定候选目的地");
    await parseIntent({ explicitDestination: name, destinationLocation: location });
  }

  const voiceIntent = {
    recorder: null,
    stream: null,
    chunks: [],
    active: false
  };

  function setVoiceRecordingState(active) {
    voiceIntent.active = Boolean(active);
    const button = byId("voiceIntentButton");
    if (!button) return;
    button.classList.toggle("recording", voiceIntent.active);
    button.setAttribute("aria-pressed", voiceIntent.active ? "true" : "false");
    button.setAttribute("aria-label", voiceIntent.active ? "正在录音，再次点击结束" : "开始语音输入");
    button.title = voiceIntent.active ? "正在录音 · 再次点击结束" : "语音输入";
    button.dataset.recording = voiceIntent.active ? "true" : "false";
    setAiStatus(voiceIntent.active ? "正在录音" : "正在识别语音", voiceIntent.active ? "recording" : "loading");
  }

  async function stopVoiceIntent() {
    if (voiceIntent.recorder && voiceIntent.recorder.state !== "inactive") {
      try { voiceIntent.recorder.stop(); } catch (_) { /* ignore */ }
    }
    if (voiceIntent.stream) {
      voiceIntent.stream.getTracks().forEach((track) => track.stop());
      voiceIntent.stream = null;
    }
  }

  async function submitVoiceIntent(blob) {
    if (!blob || !blob.size) {
      setAiStatus("等待出行需求", "idle");
      showToast("未采集到有效语音，请重试", 2800);
      return;
    }
    const form = new FormData();
    const extension = (blob.type || "").includes("ogg") ? "ogg" : (blob.type || "").includes("mp4") ? "m4a" : "webm";
    form.append("file", blob, `intent.${extension}`);
    form.append("audio", blob, `intent.${extension}`);
    try {
      const response = await fetch("/api/stt", { method: "POST", body: form, headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 503 || payload.error === "STT_NOT_CONFIGURED" || payload.code === "STT_NOT_CONFIGURED") {
        setAiStatus("语音识别未配置", "unresolved");
        showToast("未配置语音识别", 3200);
        return;
      }
      if (!response.ok) throw new Error(payload.error || `HTTP_${response.status}`);
      const text = String(payload.text || payload.transcript || payload.result || "")
        .replace(/((?:前往|去|抵达|目的地(?:是)?|到(?!达)|导航(?:到|去)))\s*[。！？!?]+\s*/g, "$1 ")
        .trim();
      if (!text) {
        setAiStatus("未识别到语音", "unresolved");
        showToast("未识别到有效文本，请重试", 2800);
        return;
      }
      const input = byId("intentInput");
      if (input) {
        input.value = text;
        fitIntentInput();
        state.manualDeadlineOverride = null;
        state.manualArrivalReserveOverride = null;
      }
      if (state.voiceAutoPlan) {
        showToast("语音已识别，正在自动规划", 2200);
        await parseIntent({ source: "voice", force: true });
      } else {
        setAiStatus("语音已识别", "idle");
        setAiReply("语音内容已写入输入框，请检查后提交。 ");
        showToast("语音已写入输入框，可检查后提交", 3000);
      }
    } catch (error) {
      setAiStatus("语音识别失败", "unresolved");
      if (String(error?.message || "").includes("STT_NOT_CONFIGURED")) showToast("未配置语音识别", 3200);
      else showToast("语音识别失败，请稍后重试", 3200);
    }
  }

  async function toggleVoiceIntent() {
    if (voiceIntent.active) {
      await stopVoiceIntent();
      return;
    }
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
      showToast("当前环境不支持语音输入", 3200);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceIntent.stream = stream;
      voiceIntent.chunks = [];
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
      const mimeType = preferred.find((type) => window.MediaRecorder.isTypeSupported?.(type)) || "";
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      voiceIntent.recorder = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size) voiceIntent.chunks.push(event.data);
      });
      recorder.addEventListener("stop", async () => {
        setVoiceRecordingState(false);
        const blob = new Blob(voiceIntent.chunks, { type: recorder.mimeType || "audio/webm" });
        voiceIntent.chunks = [];
        if (voiceIntent.stream) {
          voiceIntent.stream.getTracks().forEach((track) => track.stop());
          voiceIntent.stream = null;
        }
        await submitVoiceIntent(blob);
      });
      recorder.start();
      setVoiceRecordingState(true);
      showToast("正在听写，再次点击结束", 2200);
    } catch (error) {
      setVoiceRecordingState(false);
      if (voiceIntent.stream) {
        voiceIntent.stream.getTracks().forEach((track) => track.stop());
        voiceIntent.stream = null;
      }
      const name = String(error?.name || "");
      if (name === "NotAllowedError" || name === "PermissionDeniedError") showToast("未获得麦克风权限", 3200);
      else if (name === "NotFoundError") showToast("未检测到可用麦克风", 3200);
      else showToast("无法启动语音输入", 3200);
    }
  }

  async function postJson(path, body, timeoutMs) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs || 45000);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body || {}),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP_${response.status}`);
      return payload;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function getJson(path, timeoutMs) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs || 20000);
    try {
      const response = await fetch(path, { headers: { Accept: "application/json" }, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP_${response.status}`);
      return payload;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function aiHealthLabel(stateName) {
    return {
      checking: "正在检查解析能力",
      configured: "AI 已配置 · 规则校验可用",
      "not-configured": "规则解析可用 · AI 未配置",
      unknown: "规则解析可用 · AI 状态未知"
    }[stateName] || "规则解析可用 · AI 状态未知";
  }

  function setAiHealthStatus(stateName) {
    const normalized = ["checking", "configured", "not-configured", "unknown"].includes(stateName) ? stateName : "unknown";
    state.aiHealth = {
      state: normalized,
      configured: normalized === "configured" ? true : normalized === "not-configured" ? false : null
    };
    // A health response must not overwrite an active plan or an in-flight parse.
    if (!state.aiActive && !state.hasPlannedRoute) setAiStatus(aiHealthLabel(normalized), normalized);
  }

  async function loadAiHealthStatus() {
    setAiHealthStatus("checking");
    try {
      const payload = await getJson("/api/health", 8000);
      const configured = payload?.dependencies?.ai?.configured;
      setAiHealthStatus(configured === true ? "configured" : configured === false ? "not-configured" : "unknown");
    } catch (_) {
      setAiHealthStatus("unknown");
    }
  }

  function resolvePlanAiStatus(payload = {}) {
    const ai = payload?.analysis?.ai;
    if (ai && typeof ai === "object") {
      const mode = String(ai.mode ?? "").trim().toLowerCase();
      if (ai.fallback === true) {
        return { label: "AI 暂不可用，已使用规则完成", state: "fallback", meta: payload.aiFallbackReason || "规则校验已完成" };
      }
      if (ai.used === true) {
        if (payload.destinationResolution === "ai-fallback") {
          return { label: "AI 已复核目的地", state: "ready", meta: "规则未直接识别，AI 复核后由高德确认" };
        }
        return { label: "AI 与规则协同完成", state: "ready", meta: "AI 与规则共同完成需求解析" };
      }
      if (ai.attempted === false || mode === "rules") {
        return { label: "规则解析完成", state: "rules", meta: "规则校验已完成" };
      }
    }

    // Backward compatibility for responses before analysis.ai was added.
    if (payload?.parsed?.aiUsed === true) {
      return { label: "AI 与规则协同完成", state: "ready", meta: "兼容旧版解析结果" };
    }
    if (payload?.parsed?.aiUsed === false || payload?.aiFallbackReason) {
      return { label: "AI 暂不可用，已使用规则完成", state: "fallback", meta: payload.aiFallbackReason || "规则校验已完成" };
    }
    return { label: "规则解析完成", state: "rules", meta: "规则校验已完成" };
  }

  function setAiStatus(label, stateName) {
    const status = byId("aiStatus");
    if (!status) return;
    const text = byId("aiStatusText");
    if (text) text.textContent = label;
    status.dataset.status = stateName || "idle";
    const meta = byId("aiModelLabel");
    const metaByState = {
      idle: "等待出行需求",
      recording: "正在采集语音",
      loading: "正在理解需求并调用路线工具",
      ready: "自然语言规划已完成",
      fallback: "本地规则已完成规划",
      rules: "规则校验已完成",
      checking: "正在检查解析能力",
      configured: "配置状态已确认",
      "not-configured": "规则解析仍可用",
      unknown: "规则解析仍可用",
      unresolved: "等待有效目的地"
    };
    if (meta) meta.textContent = metaByState[stateName] || "规则解析可用";
    const thinking = byId("aiThinking");
    if (thinking) thinking.hidden = stateName !== "loading";
  }

  function setAiReply(message) {
    const reply = byId("aiReply");
    if (!reply) return;
    const text = byId("aiReplyText");
    if (text) text.textContent = message || "已理解你的出行约束。";
    const meta = byId("aiReplyMeta");
    if (meta) meta.textContent = state.aiActive ? "正在理解并规划" : "规划已完成";
    reply.hidden = !message;
    reply.classList.toggle("visible", Boolean(message));
    if (!message) clearDestinationCandidates();
  }

  function setPlanningVisibility(hasPlan) {
    byId("app")?.classList.toggle("has-plan", Boolean(hasPlan));
    if (hasPlan) byId("intentInput")?.blur();
    const routeSheet = byId("routeSheet");
    const insightPanel = byId("insightPanel");
    const activeSummary = byId("activeRouteSummary");
    const expandInsight = byId("expandInsight");
    const expandRoutes = byId("expandRoutes");
    const manualControls = byId("manualControls");
    const parsedOutput = byId("parsedOutput");
    const tripContext = byId("tripContext");
    const serviceNudge = byId("serviceNudge");
    if (routeSheet) {
      routeSheet.hidden = !hasPlan;
      if (hasPlan) {
        // Every new plan starts as a complete comparison surface. A previous
        // manual collapse must not make the next result look like it is
        // missing cards or require the evaluator to discover a drawer.
        routeSheet.classList.remove("collapsed");
        routeSheet.style.removeProperty("display");
      }
    }
    if (insightPanel) {
      insightPanel.hidden = !hasPlan;
      if (hasPlan) insightPanel.classList.remove("hidden", "collapsed");
    }
    if (activeSummary) activeSummary.hidden = !hasPlan;
    if (expandInsight) expandInsight.hidden = !hasPlan;
    if (expandRoutes) expandRoutes.hidden = !hasPlan;
    if (manualControls) manualControls.hidden = !hasPlan;
    if (parsedOutput) parsedOutput.hidden = !hasPlan;
    if (tripContext) tripContext.hidden = !hasPlan;
    if (serviceNudge && !hasPlan) serviceNudge.hidden = true;
    $$('[data-mode]').filter((button) => !["driver", "vision"].includes(button.dataset.mode)).forEach((button) => {
      button.disabled = !hasPlan;
      button.title = hasPlan ? "" : "完成一次 AI 规划后可用";
    });
    if (!hasPlan) {
      setAiReply("");
      const healthState = state.aiHealth?.state || "unknown";
      setAiStatus(aiHealthLabel(healthState), healthState);
    }
    updateComposerActionLabel();
  }

  function extractDestinationFromInput(value) {
    // ASR may split “我想去南京大学” into “我想去。南京大学。”;
    // normalize that boundary before extracting the place name.
    const text = String(value || "")
      .replace(/((?:前往|去|抵达|目的地(?:是)?|到(?!达)|导航(?:到|去)))\s*[。！？!?]+\s*/g, "$1 ")
      .trim();
    const directMatches = Array.from(text.matchAll(/(?:前往|去|抵达|目的地(?:是)?|到(?!达))\s*([^，,。；;\n]{2,40})/g));
    const direct = String(directMatches.at(-1)?.[1] || "").trim().replace(/(?:然后|并且|最好).*$/, "");
    // A follow-up such as “中途想去吃麦当劳” contains “去”, but the
    // following words describe a service stop rather than a new destination.
    if (direct && !/^(?:吃|用餐|餐饮|餐厅|咖啡|休息|洗车|加油|充电|补能|麦当劳|肯德基|星巴克)/.test(direct)) return direct;
    const knownPlaces = ["上海东方明珠广播电视塔", "东方明珠广播电视塔", "东方明珠", "北京大兴国际机场", "大兴国际机场", "大兴机场", "首都国际机场", "首都机场", "北京南站", "北京西站", "北京站", "北京朝阳站", "天津滨海国际机场", "上海虹桥站", "上海浦东国际机场", "广州南站", "深圳北站"];
    return knownPlaces
      .map((place) => ({ place, index: text.lastIndexOf(place) }))
      .filter((item) => item.index >= 0)
      .sort((a, b) => b.index - a.index)[0]?.place || null;
  }

  function hasSupplementCue(value) {
    return /中途|途中|路上|顺便|另外|还想|再加|补充|加上|吃饭|吃点|吃个|用餐|午饭|午餐|晚饭|晚餐|早餐|餐厅|咖啡|休息|洗车|加油|充电|补能|少走|不走|尽量|再安排|最晚|截止|到达[^%]{0,20}\d+\s*%|保留[^%]{0,12}\d+\s*%|绕行[^\d]{0,4}\d+|纯电|燃油|油车|混动|插混|便宜|省钱|最快|准时/.test(String(value || ""));
  }

  function hasExplicitNewTripCue(value) {
    return /改(?:去|到|成)|换(?:去|到|成)|换个目的地|重新(?:规划|安排|去)|新行程|另一个目的地|目的地(?:是|改|换)|(?:^|[，。；\s])我(?:想|要)去/.test(String(value || ""));
  }

  function resolveRequestMode(value, parsed = {}) {
    if (!state.hasPlannedRoute) return "new_trip";
    const text = String(value || "").trim();
    const explicitDestination = extractDestinationFromInput(text);
    const supplementOnly = !explicitDestination && hasSupplementCue(text);
    if (supplementOnly) return "supplement";
    if (hasExplicitNewTripCue(text) || explicitDestination) return "new_trip";
    if (parsed.requestMode === "supplement" || parsed.requestMode === "new_trip") return parsed.requestMode;
    return hasSupplementCue(text) ? "supplement" : "new_trip";
  }

  function composerActionLabel() {
    if (!state.hasPlannedRoute) return "开始规划";
    return resolveRequestMode(byId("intentInput")?.value || "", {}) === "supplement"
      ? "补充到行程"
      : "重新规划";
  }

  function composerAriaLabel() {
    if (!state.hasPlannedRoute) return "提交新行程规划";
    return resolveRequestMode(byId("intentInput")?.value || "", {}) === "supplement"
      ? "提交补充行程"
      : "提交重新规划";
  }

  function updateComposerActionLabel() {
    const button = byId("composerSubmitButton");
    if (!button) return;
    button.setAttribute("aria-label", state.aiActive ? "正在提交行程规划" : composerAriaLabel());
    button.title = state.aiActive ? "正在提交行程规划" : composerActionLabel();
  }

  function setComposerSubmitting(active) {
    const button = byId("composerSubmitButton");
    if (!button) return;
    button.classList.toggle("is-loading", Boolean(active));
    button.disabled = Boolean(active);
    button.setAttribute("aria-busy", active ? "true" : "false");
    updateComposerActionLabel();
  }

  function mergeSupplementIntent(parsed, payload, value) {
    const currentServices = Array.isArray(state.aiContext?.services) ? state.aiContext.services : [];
    const parsedServices = Array.isArray(parsed?.services) ? parsed.services : [];
    const requestedServiceName = typeof serviceIntent.extractServiceKeyword === "function"
      ? serviceIntent.extractServiceKeyword(value)
      : null;
    const hasEnergyCue = /纯电|纯电动|电车|电动车|充电|燃油|油车|加油|混动|插混|油电/.test(String(value || ""));
    const hasPriorityCue = /不能迟到|准时|赶时间|最快|尽快|便宜|省钱|低成本|不想等|少等|等待/.test(String(value || ""));
    const hasDetourCue = /最多|不超过|不超|允许|绕行|绕路/.test(String(value || ""));
    const currentDeadline = state.deadlineEnabled ? formatClock(state.deadlineMinutes) : null;
    const currentReserve = state.arrivalReserveEnabled ? state.minArrivalSoc : null;
    const parsedEnergy = parsed?.energyType && parsed.energyType !== "unknown" ? parsed.energyType : state.energyType;
    const parsedActions = Array.isArray(parsed?.actions) ? parsed.actions.map((action) => Object.assign({}, action)) : [];
    const text = String(value || "");
    const serviceLabel = /洗车/.test(text)
      ? "洗车"
      : /休息|卫生间|厕所/.test(text)
        ? "休息"
        : /补能|充电|加油/.test(text)
          ? "补能"
          : /餐|饭|吃|喝|咖啡/.test(text)
            ? "餐饮"
            : null;
    let serviceActionFound = false;
    const mergedActions = parsedActions.map((action) => {
      if (action?.type !== "ADD_SERVICE" || !serviceLabel || action.service !== serviceLabel) return action;
      serviceActionFound = true;
      // The model may identify the category but omit or generalize the brand.
      // Local text evidence is authoritative for this field.
      return requestedServiceName
        ? Object.assign({}, action, { service: serviceLabel, name: requestedServiceName })
        : action;
    });
    if (serviceLabel && requestedServiceName && !serviceActionFound) {
      mergedActions.push({ type: "ADD_SERVICE", service: serviceLabel, name: requestedServiceName });
    }
    return Object.assign({}, parsed, {
      requestMode: "supplement",
      // A supplement never turns “吃麦当劳” into the trip destination. Keep
      // the existing coordinates so the same route is recalculated with the
      // added service stop.
      destination: state.destinationName,
      destinationLocation: state.destination,
      origin: state.originName,
      originLocation: state.origin,
      arrivalDeadline: parsed?.arrivalDeadline || currentDeadline,
      minArrivalSoc: parsed?.minArrivalSoc ?? currentReserve,
      energyType: hasEnergyCue ? parsedEnergy : state.energyType,
      priority: hasPriorityCue ? (parsed?.priority || state.priority) : state.priority,
      maxDetourKm: hasDetourCue
        ? (parsed?.maxDetourKm ?? state.maxDetourKm)
        : (state.detourExplicit ? state.maxDetourKm : null),
      services: Array.from(new Set([...currentServices, ...parsedServices])),
      actions: mergedActions
    });
  }

  function localIntentFallback(value) {
    const arrivalSocMatch = value.match(/(?:到达|抵达|终点|最后)[^%]{0,50}?(?:至少|要有|保持|保留|不低于|大于|超过|以上|剩余)[^%]{0,12}?(\d{1,3})\s*%/i);
    const deadlineMatch = value.match(/(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:前|之前|到达)/);
    const detourMatch = value.match(/(?:最多|不超过|不超|允许)\s*(\d+(?:\.\d+)?)\s*(?:公里|千米|km|KM)/);
    const deadline = deadlineMatch ? `${String(Number(deadlineMatch[1])).padStart(2, "0")}:${deadlineMatch[2]}` : null;
    const destination = extractDestinationFromInput(value);
    return {
      destination,
      arrivalDeadline: deadline,
      minArrivalSoc: arrivalSocMatch ? Math.max(5, Math.min(100, Number(arrivalSocMatch[1]))) : null,
      energyType: /混动|插混|混合动力|油电/.test(value)
        ? "hybrid"
        : value.includes("加油") || value.includes("燃油") || value.includes("油车") ? "fuel" : state.energyType,
      priority: value.includes("便宜") || value.includes("省") ? "cost" : value.includes("快") ? "time" : "reliable",
      maxDetourKm: detourMatch ? Math.max(0, Math.min(50, Number(detourMatch[1]))) : null,
      services: ["餐饮", "休息"].filter((service) => value.includes(service)),
      requestMode: resolveRequestMode(value, {}),
      clarificationNeeded: !destination
    };
  }

  const ACTION_SERVICE_LABELS = {
    餐饮: "餐饮",
    洗车: "洗车",
    休息: "休息",
    补能: "补能"
  };

  function actionServiceLabel(action) {
    const value = String(action?.service || action?.target || "").trim();
    if (ACTION_SERVICE_LABELS[value]) return ACTION_SERVICE_LABELS[value];
    if (/餐|饭|吃|咖啡|喝/.test(value)) return "餐饮";
    if (/洗车/.test(value)) return "洗车";
    if (/休息|卫生间/.test(value)) return "休息";
    if (/充电|加油|补能/.test(value)) return "补能";
    return null;
  }

  function actionSummary(action) {
    if (!action) return "";
    if (action.type === "ADD_SERVICE") return `补充${action.name || actionServiceLabel(action) || "服务停靠"}`;
    if (action.type === "ADD_WAYPOINT") return `补充途经${action.location}`;
    if (action.type === "REMOVE_STOP") return `移除${action.name || action.target || "停靠点"}`;
    if (action.type === "CHANGE_DESTINATION") return `修改目的地为${action.destination}`;
    if (action.type === "NEW_TRIP") return `开始前往${action.destination}的新行程`;
    if (action.type === "UPDATE_CONSTRAINT") {
      const labels = { arrivalDeadline: "到达时间", minArrivalSoc: "到达余量", maxDetourKm: "绕行上限", energyType: "动力类型", priority: "路线偏好" };
      return `修改${labels[action.constraint] || "行程条件"}`;
    }
    return "补充行程条件";
  }

  function actionModeLabel(actions, requestMode = state.lastRequestMode) {
    const list = Array.isArray(actions) ? actions : [];
    if (list.some((action) => action.type === "NEW_TRIP" || action.type === "CHANGE_DESTINATION")) return "开始新行程";
    if (list.some((action) => action.type === "UPDATE_CONSTRAINT")) return "修改行程约束";
    if (list.length || requestMode === "supplement") return "补充行程";
    return "开始规划";
  }

  function recordActionJournal(actions, outcome = {}) {
    const list = Array.isArray(actions) ? actions.filter(Boolean) : [];
    if (!list.length && !outcome.summary) {
      state.lastAction = null;
      state.lastActionSummary = "";
      return;
    }
    const entries = list.map((action) => ({
      type: action.type,
      summary: actionSummary(action),
      status: outcome.failed?.includes(action) ? "failed" : "applied"
    }));
    state.actionJournal = state.actionJournal.concat(entries.map((entry) => Object.assign(entry, { at: new Date().toISOString() }))).slice(-12);
    state.lastAction = list.at(-1) || null;
    state.lastActionSummary = outcome.summary || entries.map((entry) => entry.summary).join("；");
  }

  function clearSupplementalStopsForNewTrip() {
    state.tripWaypoints = [];
    state.activeServicePlan = null;
    state.selectedService = null;
    state.serviceSuggestion = null;
    state.serviceRouteOverrides = {};
    state.reservationOverrides = {};
    state.serviceSuggestionDismissed = new Set();
    state.aiContext = null;
    state.weather = null;
    // Deadline, arrival reserve and detour caps belong to the previous trip
    // unless the new request states them again.  The vehicle's current clock
    // and energy remain global top-bar state; trip-specific hard constraints do
    // not silently leak into a new destination.
    state.deadlineEnabled = false;
    state.arrivalReserveEnabled = false;
    state.manualDeadlineOverride = null;
    state.manualArrivalReserveOverride = null;
    state.detourExplicit = false;
    state.maxDetourKm = 8;
    state.stationForecastScenarioKey = null;
    state.stationForecastRequestVersion += 1;
    syncManualControls();
  }

  function geocodeWaypoint(query) {
    const text = String(query || "").trim();
    if (!text || !state.AMap?.Geocoder) return Promise.resolve(null);
    return new Promise((resolve) => {
      const geocoder = new state.AMap.Geocoder({ city: "全国" });
      geocoder.getLocation(text, (status, result) => {
        const geocodes = status === "complete" && Array.isArray(result?.geocodes) ? result.geocodes : [];
        const match = geocodes.find((item) => parseLocation(item.location));
        if (!match) return resolve(null);
        resolve({
          name: text,
          address: match.formattedAddress || match.address || text,
          location: parseLocation(match.location),
          source: "高德地理编码"
        });
      });
    });
  }

  async function addTripWaypoint(action) {
    const query = String(action?.location || "").trim();
    if (!query) return { ok: false, message: "途经点名称为空" };
    const existing = state.tripWaypoints.filter((waypoint) => waypoint.name === query || waypoint.address?.includes(query));
    if (existing.length) return { ok: true, waypoint: existing[0], duplicate: true };
    const resolved = await geocodeWaypoint(query);
    if (!resolved) return { ok: false, message: `未能定位途经点“${query}”，没有加入行程` };
    const waypoint = Object.assign(resolved, {
      id: `waypoint-${stableHash(`${query}-${resolved.location.join(",")}`)}`,
      kind: "waypoint",
      userOrder: state.tripWaypoints.length
    });
    state.tripWaypoints.push(waypoint);
    return { ok: true, waypoint };
  }

  function removeStopAction(action) {
    const target = String(action?.target || "").trim();
    const requestedName = String(action?.name || "").trim();
    const serviceLabel = actionServiceLabel(action);
    const active = state.activeServicePlan;
    const activeLabel = active?.serviceLabel || (active?.serviceType === "meal" || active?.serviceType === "coffee" ? "餐饮" : active?.serviceType === "rest" ? "休息" : null);
    const nameMatches = !requestedName || !active?.name || active.name.includes(requestedName) || requestedName.includes(active.name);
    if (active && ((serviceLabel && activeLabel === serviceLabel) || (target && active.name?.includes(target)) || (requestedName && nameMatches))) {
      state.activeServicePlan = null;
      state.selectedService = null;
      state.serviceRouteOverrides = {};
      if (state.aiContext) state.aiContext.services = (state.aiContext.services || []).filter((item) => item !== serviceLabel);
      return { ok: true, message: `已移除${active.name}` };
    }
    if (serviceLabel) {
      const services = Array.isArray(state.aiContext?.services) ? state.aiContext.services : [];
      if (services.includes(serviceLabel)) {
        state.aiContext.services = services.filter((item) => item !== serviceLabel);
        return { ok: true, message: `已取消${serviceLabel}服务要求` };
      }
      return { ok: false, message: `当前行程没有已加入的${serviceLabel}停靠` };
    }
    const candidates = state.tripWaypoints.filter((waypoint) => {
      const haystack = `${waypoint.name || ""} ${waypoint.address || ""}`;
      return haystack.includes(target) || target.includes(waypoint.name || "__missing__");
    });
    if (candidates.length > 1) return { ok: false, message: `“${target}”对应多个途经点，未自动删除` };
    if (candidates.length === 1) {
      state.tripWaypoints = state.tripWaypoints.filter((waypoint) => waypoint.id !== candidates[0].id);
      state.tripWaypoints.forEach((waypoint, index) => { waypoint.userOrder = index; });
      return { ok: true, message: `已移除途经${candidates[0].name}` };
    }
    return { ok: false, message: `没有找到可移除的停靠点“${target}”` };
  }

  function applyConstraintActions(actions) {
    const failures = [];
    (actions || []).filter((action) => action.type === "UPDATE_CONSTRAINT").forEach((action) => {
      const value = action.value;
      if (action.constraint === "arrivalDeadline") {
        const minutes = clockToMinutes(value, Number.NaN);
        if (!Number.isFinite(minutes)) return failures.push({ action, message: "到达时间格式无法识别" });
        state.deadlineMinutes = minutes;
        state.deadlineEnabled = true;
        state.manualDeadlineOverride = true;
      } else if (action.constraint === "minArrivalSoc") {
        const reserve = Number(value);
        if (!Number.isFinite(reserve)) return failures.push({ action, message: "到达余量格式无法识别" });
        state.minArrivalSoc = Math.max(5, Math.min(100, reserve));
        state.arrivalReserveEnabled = true;
        state.manualArrivalReserveOverride = true;
      } else if (action.constraint === "maxDetourKm") {
        const detour = Number(value);
        if (!Number.isFinite(detour)) return failures.push({ action, message: "绕行上限格式无法识别" });
        state.maxDetourKm = Math.max(0, Math.min(50, detour));
        state.detourExplicit = true;
      } else if (action.constraint === "energyType" && ENERGY_TYPES.includes(action.value)) {
        adoptEnergyType(action.value);
      } else if (action.constraint === "priority" && action.value) {
        state.priority = action.value;
      }
    });
    syncManualControls();
    updateEnergyControls();
    return failures;
  }

  async function applyPreRouteActions(actions) {
    const applied = [];
    const failed = [];
    for (const action of Array.isArray(actions) ? actions : []) {
      if (action.type === "ADD_WAYPOINT") {
        const result = await addTripWaypoint(action);
        (result.ok ? applied : failed).push(action);
        if (!result.ok) showToast(result.message, 3600);
      } else if (action.type === "REMOVE_STOP") {
        const result = removeStopAction(action);
        (result.ok ? applied : failed).push(action);
        if (!result.ok) showToast(result.message, 3600);
      }
    }
    const constraintFailures = applyConstraintActions(actions);
    constraintFailures.forEach(({ action, message }) => {
      failed.push(action);
      showToast(message, 3000);
    });
    return { applied, failed };
  }

  function inferLocalActions(value, parsed = {}) {
    const text = String(value || "");
    if (Array.isArray(parsed.actions) && parsed.actions.length) return parsed.actions;
    const actions = [];
    const serviceName = typeof serviceIntent.extractServiceKeyword === "function"
      ? serviceIntent.extractServiceKeyword(text)
      : null;
    if (/(中途|途中|路上|顺便|另外|还想|再加|补充|加上)/.test(text) && /(吃|饭|餐|咖啡|休息|洗车)/.test(text)) {
      actions.push({ type: "ADD_SERVICE", service: /咖啡/.test(text) ? "餐饮" : /休息/.test(text) ? "休息" : /洗车/.test(text) ? "洗车" : "餐饮", ...(serviceName ? { name: serviceName } : {}) });
    }
    const waypoint = text.match(/(?:途经|经过|路过)\s*([^，,。；;\s]{2,24})/);
    if (waypoint) actions.push({ type: "ADD_WAYPOINT", location: waypoint[1] });
    if (/(取消|不要|移除|删掉).*(餐饮|吃饭|咖啡|休息|洗车)/.test(text)) actions.push({ type: "REMOVE_STOP", target: /洗车/.test(text) ? "洗车" : /休息/.test(text) ? "休息" : "餐饮" });
    const deadlineMatch = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:前|之前|到达|截止)/);
    if (deadlineMatch) actions.push({ type: "UPDATE_CONSTRAINT", constraint: "arrivalDeadline", value: `${String(Number(deadlineMatch[1])).padStart(2, "0")}:${deadlineMatch[2]}` });
    const reserveMatch = text.match(/(?:到达|抵达|终点|最后)[^%]{0,50}?(?:至少|要有|保持|保留|不低于|大于|超过|以上|剩余)[^%]{0,12}?(\d{1,3})\s*%/i);
    if (reserveMatch) actions.push({ type: "UPDATE_CONSTRAINT", constraint: "minArrivalSoc", value: Number(reserveMatch[1]) });
    const detourMatch = text.match(/(?:最多|不超过|不超|允许)[^\d]{0,5}(\d+(?:\.\d+)?)\s*(?:公里|千米|km|KM)/);
    if (detourMatch) actions.push({ type: "UPDATE_CONSTRAINT", constraint: "maxDetourKm", value: Number(detourMatch[1]) });
    if (/混动|插混|混合动力|油电/.test(text)) actions.push({ type: "UPDATE_CONSTRAINT", constraint: "energyType", value: "hybrid" });
    else if (/加油|燃油|油车/.test(text)) actions.push({ type: "UPDATE_CONSTRAINT", constraint: "energyType", value: "fuel" });
    else if (/纯电|纯电动|电车|充电/.test(text)) actions.push({ type: "UPDATE_CONSTRAINT", constraint: "energyType", value: "electric" });
    if (/便宜|省钱|低成本/.test(text)) actions.push({ type: "UPDATE_CONSTRAINT", constraint: "priority", value: "cost" });
    else if (/最快|尽快/.test(text)) actions.push({ type: "UPDATE_CONSTRAINT", constraint: "priority", value: "time" });
    else if (/准时|不能迟到|不想迟到/.test(text)) actions.push({ type: "UPDATE_CONSTRAINT", constraint: "priority", value: "reliable" });
    if (!state.hasPlannedRoute && parsed.destination) actions.push({ type: "NEW_TRIP", destination: parsed.destination });
    return actions;
  }

  function clockToMinutes(value, fallback) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
  }

  function renderParsedIntent(parsed) {
    const labels = { time: "时间优先", cost: "成本优先", reliable: "准时优先", balanced: "综合最优", fastest: "时间优先", cheapest: "成本优先", on_time: "准时优先", wait: "少等待" };
    const chips = [
      `目的地 · ${parsed.destination || "已识别"}`,
      labels[parsed.priority] || "综合最优"
    ];
    if (state.deadlineEnabled) chips.push(`最晚${formatClock(state.deadlineMinutes)}`);
    if (state.arrivalReserveEnabled) chips.push(`到达≥${Number(state.minArrivalSoc)}%`);
    if (parsed.maxDetourKm !== null && parsed.maxDetourKm !== undefined && Number.isFinite(Number(parsed.maxDetourKm))) chips.push(`绕行≤${Number(parsed.maxDetourKm)}km`);
    (parsed.services || []).slice(0, 2).forEach((service) => chips.push(`需要${service}`));
    const row = byId("parsedRow");
    if (row) row.innerHTML = chips.map((chip) => `<span class="parsed-chip"></span>`).join("");
    if (row) Array.from(row.children).forEach((child, index) => { child.textContent = chips[index]; });
  }

  function normalizeParseAnalysis(value) {
    if (!value || typeof value !== "object") return null;
    const rawScore = value.score;
    const scoreValue = typeof rawScore === "number"
      ? rawScore
      : typeof rawScore === "string" && rawScore.trim() !== ""
        ? Number(rawScore)
        : NaN;
    const score = Number.isFinite(scoreValue) ? scoreValue : null;
    const level = String(value.level ?? "").trim();
    const rawFactors = Array.isArray(value.factors)
      ? value.factors
      : value.factors && typeof value.factors === "object"
        ? Object.entries(value.factors).map(([label, evidence]) => ({ label, evidence }))
        : [];
    const factors = rawFactors.map((factor, index) => {
      if (factor && typeof factor === "object") {
        const label = String(factor.label ?? factor.name ?? factor.key ?? factor.title ?? `依据 ${index + 1}`).trim();
        const rawStatus = String(factor.status ?? "").trim().toLowerCase();
        const status = ["pass", "warn", "fail"].includes(rawStatus) ? rawStatus : "";
        const rawDelta = factor.delta;
        const deltaValue = typeof rawDelta === "number"
          ? rawDelta
          : typeof rawDelta === "string" && rawDelta.trim() !== ""
            ? Number(rawDelta)
            : NaN;
        const delta = Number.isFinite(deltaValue) ? deltaValue : null;
        const evidence = String(factor.evidence ?? factor.detail ?? factor.reason ?? factor.value ?? factor.text ?? factor.description ?? "").trim();
        return { label, status, delta, evidence };
      }
      return { label: `依据 ${index + 1}`, status: "", delta: null, evidence: String(factor ?? "").trim() };
    }).filter((factor) => factor.label || factor.status || factor.delta !== null || factor.evidence).slice(0, 8);
    const rawComparison = value.comparison && typeof value.comparison === "object" ? value.comparison : null;
    const snapshot = (input) => {
      if (!input || typeof input !== "object") return null;
      const optionalNumber = (raw) => {
        // Number(null) is 0, but a blank arrival reserve/detour is not an
        // explicit zero constraint. Preserve the distinction in the evidence
        // panel so it agrees with the route card and manual controls.
        if (raw === null || raw === undefined || raw === "") return null;
        return Number.isFinite(Number(raw)) ? Number(raw) : null;
      };
      return {
        destination: String(input.destination ?? "").trim() || null,
        arrivalDeadline: String(input.arrivalDeadline ?? "").trim() || null,
        minArrivalSoc: optionalNumber(input.minArrivalSoc),
        energyType: String(input.energyType ?? "").trim() || null,
        priority: String(input.priority ?? "").trim() || null,
        maxDetourKm: optionalNumber(input.maxDetourKm),
        services: Array.isArray(input.services) ? input.services.slice(0, 6).map((item) => String(item).slice(0, 40)) : [],
        requestMode: String(input.requestMode ?? "").trim() || null,
        actions: Array.isArray(input.actions) ? input.actions.slice(0, 8).filter((item) => item && typeof item === "object") : []
      };
    };
    const comparison = rawComparison ? {
      originalText: String(rawComparison.originalText ?? "").trim().slice(0, 1200),
      status: String(rawComparison.status ?? "rules-only").trim(),
      statusLabel: String(rawComparison.statusLabel ?? "").trim(),
      rules: snapshot(rawComparison.rules),
      ai: snapshot(rawComparison.ai),
      final: snapshot(rawComparison.final),
      agreement: {
        compared: rawComparison.agreement?.compared === true,
        score: Number.isFinite(Number(rawComparison.agreement?.score)) ? Number(rawComparison.agreement.score) : null,
        label: String(rawComparison.agreement?.label ?? "").trim(),
        differences: Array.isArray(rawComparison.agreement?.differences) ? rawComparison.agreement.differences.slice(0, 10) : []
      },
      actions: {
        accepted: Array.isArray(rawComparison.actions?.accepted) ? rawComparison.actions.accepted.slice(0, 8) : [],
        rejected: Array.isArray(rawComparison.actions?.rejected) ? rawComparison.actions.rejected.slice(0, 8) : []
      },
      safety: {
        status: String(rawComparison.safety?.status ?? "review").trim(),
        conclusion: String(rawComparison.safety?.conclusion ?? "").trim(),
        checks: Array.isArray(rawComparison.safety?.checks) ? rawComparison.safety.checks.slice(0, 8) : []
      }
    } : null;
    if (score === null && !level && !factors.length && !comparison) return null;
    return { score, level, factors, comparison };
  }

  function formatParseScore(score) {
    if (!Number.isFinite(score)) return "";
    const points = score >= 0 && score <= 1 ? score * 100 : score;
    return `${Math.round(Math.max(0, Math.min(100, points)))}/100`;
  }

  function formatParseLevel(level) {
    const normalized = String(level ?? "").trim().toLowerCase();
    return {
      high: "高",
      medium: "中",
      confirm: "需确认",
      low: "需确认",
      "高": "高",
      "中": "中",
      "需确认": "需确认"
    }[normalized] || String(level ?? "").trim();
  }

  function formatFactorDelta(delta) {
    if (!Number.isFinite(delta)) return "";
    const rounded = Number.isInteger(delta) ? String(delta) : String(Math.round(delta * 100) / 100);
    return delta >= 0 ? `+${rounded}` : rounded;
  }

  function formatIntentComparisonValue(value, field) {
    if (value === null || value === undefined || value === "") return "—";
    const energyLabels = { electric: "纯电", fuel: "燃油", mixed: "混动", unknown: "未指定" };
    const priorityLabels = { on_time: "准时", fastest: "最快", cheapest: "最低成本", wait: "少等待", balanced: "综合" };
    const modeLabels = { new_trip: "新行程", supplement: "补充行程" };
    if (field === "energyType") return energyLabels[value] || String(value);
    if (field === "priority") return priorityLabels[value] || String(value);
    if (field === "requestMode") return modeLabels[value] || String(value);
    if (field === "minArrivalSoc") return `${value}%`;
    if (field === "maxDetourKm") return `${value} km`;
    if (field === "services") return Array.isArray(value) && value.length ? value.join("、") : "无";
    if (field === "actions") return Array.isArray(value) && value.length ? value.map(actionSummary).join("；") : "无";
    return String(value);
  }

  function renderIntentComparison(factorsPanel, comparison) {
    if (!comparison) return;
    const panel = document.createElement("section");
    panel.className = "parsed-intent-comparison";
    const header = document.createElement("div");
    header.className = "parsed-intent-comparison-head";
    const title = document.createElement("strong");
    title.textContent = "AI / 规则解析对比";
    const status = document.createElement("span");
    status.className = `parsed-intent-comparison-status ${comparison.status || "rules-only"}`;
    status.textContent = comparison.statusLabel || "解析链路已记录";
    header.append(title, status);
    panel.appendChild(header);

    if (comparison.originalText) {
      const original = document.createElement("p");
      original.className = "parsed-intent-comparison-original";
      original.textContent = `原始输入：${comparison.originalText}`;
      panel.appendChild(original);
    }

    const columns = document.createElement("div");
    columns.className = "parsed-intent-comparison-grid";
    const columnsData = [
      ["规则解析", comparison.rules],
      ["AI 解析", comparison.ai],
      ["最终规划输入", comparison.final]
    ];
    const fields = [
      ["destination", "终点"],
      ["arrivalDeadline", "到达时间"],
      ["minArrivalSoc", "到达余量"],
      ["energyType", "动力类型"],
      ["priority", "偏好"],
      ["services", "服务"],
      ["requestMode", "行程类型"],
      ["actions", "动作"]
    ];
    columnsData.forEach(([label, snapshot]) => {
      const column = document.createElement("div");
      column.className = "parsed-intent-comparison-column";
      const columnTitle = document.createElement("b");
      columnTitle.textContent = label;
      column.appendChild(columnTitle);
      fields.forEach(([field, fieldLabel]) => {
        const row = document.createElement("div");
        row.className = "parsed-intent-comparison-row";
        const key = document.createElement("span");
        key.textContent = fieldLabel;
        const value = document.createElement("strong");
        value.textContent = formatIntentComparisonValue(snapshot?.[field], field);
        row.append(key, value);
        column.appendChild(row);
      });
      columns.appendChild(column);
    });
    panel.appendChild(columns);

    const agreement = document.createElement("p");
    agreement.className = "parsed-intent-comparison-note";
    agreement.textContent = comparison.agreement?.compared
      ? `字段一致性：${comparison.agreement.label || `${comparison.agreement.score ?? "—"}%`}。不一致字段不会直接写入路线计算。`
      : (comparison.agreement?.label || "本轮未进行模型字段对比。");
    panel.appendChild(agreement);

    const safety = document.createElement("div");
    safety.className = `parsed-intent-comparison-safety ${comparison.safety?.status || "review"}`;
    safety.textContent = `最终安全校验：${comparison.safety?.conclusion || "等待校验"}`;
    panel.appendChild(safety);
    factorsPanel.appendChild(panel);
  }

  function renderParseAnalysis(value) {
    const analysis = normalizeParseAnalysis(value);
    state.parseAnalysis = analysis;
    const confidence = byId("parsedConfidence");
    const toggle = byId("parsedAnalysisToggle");
    const factorsPanel = byId("parsedAnalysisFactors");
    if (!confidence || !toggle || !factorsPanel) return;

    factorsPanel.replaceChildren();
    factorsPanel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    const toggleLabel = toggle.querySelector("span");
    if (toggleLabel) toggleLabel.textContent = "查看依据";

    if (!analysis) {
      confidence.textContent = "解析依据待生成";
      toggle.hidden = true;
      return;
    }

    const summary = [];
    if (analysis.score !== null) summary.push(`需求解析可信度 ${formatParseScore(analysis.score)}`);
    const levelLabel = formatParseLevel(analysis.level);
    if (levelLabel) summary.push(levelLabel);
    confidence.textContent = summary.join(" · ") || "解析依据已生成";

    analysis.factors.forEach((factor) => {
      const row = document.createElement("div");
      row.className = "parsed-analysis-factor";
      const head = document.createElement("div");
      head.className = "parsed-analysis-factor-head";
      const label = document.createElement("strong");
      label.className = "parsed-analysis-factor-label";
      label.textContent = factor.label;
      head.appendChild(label);
      const meta = document.createElement("span");
      meta.className = "parsed-analysis-factor-meta";
      if (factor.status) {
        const status = document.createElement("span");
        status.className = `parsed-analysis-factor-status ${factor.status}`;
        status.textContent = factor.status.toUpperCase();
        meta.appendChild(status);
      }
      const delta = formatFactorDelta(factor.delta);
      if (delta) {
        const deltaNode = document.createElement("span");
        deltaNode.className = "parsed-analysis-factor-delta";
        deltaNode.textContent = delta;
        meta.appendChild(deltaNode);
      }
      if (meta.childElementCount) head.appendChild(meta);
      row.appendChild(head);
      if (factor.evidence) {
        const evidence = document.createElement("span");
        evidence.className = "parsed-analysis-factor-evidence";
        evidence.textContent = factor.evidence;
        row.appendChild(evidence);
      }
      factorsPanel.appendChild(row);
    });
    renderIntentComparison(factorsPanel, analysis.comparison);
    toggle.hidden = !analysis.factors.length && !analysis.comparison;
  }

  // The current backend returns an arrival-time `prediction`. Older local
  // processes may still return only `forecast[]`; selecting the point here
  // keeps the front end on one ETA-based wait value while that process is
  // being restarted, without treating the fallback as live data.
  function selectForecastPointForArrival(entry, offsetMinutes) {
    const points = Array.isArray(entry?.forecast)
      ? entry.forecast.map((point, index) => Object.assign({}, point, { minute: Number(point?.minute ?? index * 5) }))
        .filter((point) => Number.isFinite(point.minute))
        .sort((a, b) => a.minute - b.minute)
      : [];
    if (!points.length) return null;
    const requested = Math.max(0, Number(offsetMinutes) || 0);
    const exact = points.find((point) => Math.abs(point.minute - requested) < 1e-9);
    if (exact) return exact;
    if (requested <= points[0].minute) return Object.assign({}, points[0], { requestedOffsetMinutes: requested });
    if (requested >= points.at(-1).minute) return Object.assign({}, points.at(-1), { requestedOffsetMinutes: requested });
    const rightIndex = points.findIndex((point) => point.minute >= requested);
    const left = points[Math.max(0, rightIndex - 1)];
    const right = points[rightIndex];
    const ratio = (requested - left.minute) / Math.max(0.0001, right.minute - left.minute);
    const interpolate = (key) => {
      const leftValue = Number(left[key]);
      const rightValue = Number(right[key]);
      return Number.isFinite(leftValue) && Number.isFinite(rightValue)
        ? Number((leftValue + (rightValue - leftValue) * ratio).toFixed(3))
        : left[key] ?? right[key];
    };
    return Object.assign({}, left, {
      minute: requested,
      requestedOffsetMinutes: requested,
      occupancy: interpolate("occupancy"),
      wait: interpolate("wait"),
      p50: interpolate("p50"),
      p90: interpolate("p90"),
      arrivalRate: interpolate("arrivalRate"),
      serviceRate: interpolate("serviceRate"),
      risk: ratio < 0.5 ? left.risk : right.risk
    });
  }

  function renderForecast(station, payload) {
    const entry = payload?.stations?.find((item) => item.id === station.id) || payload?.station || payload;
    const points = Array.isArray(entry?.forecast) ? entry.forecast : [];
    const p50 = points.map((point) => Number(point.p50 ?? point.wait ?? 0));
    const p90 = points.map((point) => Number(point.p90 ?? point.wait ?? 0));
    if (!points.length) return;
    const all = p50.concat(p90).filter(Number.isFinite);
    const maxValue = Math.max(20, ...all, 1);
    const makePoints = (values) => values.map((value, index) => {
      const x = 24 + (240 * index / Math.max(1, values.length - 1));
      const y = 98 - (76 * Math.min(maxValue, Math.max(0, value)) / maxValue);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const p50Line = byId("forecastP50Line");
    const p90Line = byId("forecastP90Line");
    if (p50Line) p50Line.setAttribute("points", makePoints(p50));
    if (p90Line) p90Line.setAttribute("points", makePoints(p90));
    const pointsGroup = byId("forecastPoints");
    if (pointsGroup) pointsGroup.innerHTML = p90.map((value, index) => {
      const x = 24 + (240 * index / Math.max(1, p90.length - 1));
      const y = 98 - (76 * Math.min(maxValue, Math.max(0, value)) / maxValue);
      return `<circle class="forecast-point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"><title>${displayCopy(`+${points[index].minute || 0} 分钟 · P90 ${value.toFixed(1)} 分钟`)}</title></circle>`;
    }).join("");
    const status = byId("forecastStatus");
    if (status) {
      const methodLabel = entry.method === "port-discrete-event" ? "端口级离散事件仿真" : "聚合流量仿真";
      const enterpriseLabel = String(entry.source || entry.forecastSource || "").includes("enterprise-prior")
        ? " · 企业需求先验已纳入"
        : "";
      status.textContent = `${entry.simulation || entry.forecastSource === "simulation" ? "仿真预测" : "演示预测"} · ${methodLabel}${enterpriseLabel} · ${entry.horizonMinutes || points.length * 5 - 5} 分钟`;
    }
    const meta = byId("forecastMeta");
    if (meta) {
      const text = meta.querySelector("span") || meta;
      const snapshot = entry.inputSnapshot;
      const portSummary = entry.method === "port-discrete-event" && snapshot
        ? `总枪位 ${snapshot.totalPorts ?? "—"} · 可用 ${snapshot.availablePorts ?? snapshot.idlePorts ?? "—"} · 已预约 ${snapshot.reservedPorts ?? "—"} · 等待 ${snapshot.waitingVehicles ?? snapshot.queueVehicles ?? "—"}`
        : "";
      const confidenceText = Number.isFinite(Number(entry.confidenceScore))
        ? ` · 置信度 ${entry.confidenceLabel || `${Math.round(Number(entry.confidenceScore))}/100`}`
        : "";
      text.textContent = `${entry.explanation || payload?.model || "可解释队列近似"}${entry.asOf ? ` · ${entry.asOf}` : ""}${portSummary ? ` · ${portSummary}` : ""}${confidenceText}`;
    }
    renderForecastEvidence(entry, payload);
  }

  function renderForecastEvidence(entry, payload) {
    const panel = byId("forecastEvidencePanel");
    const toggle = byId("forecastEvidenceToggle");
    if (!panel || !toggle) return;
    const snapshot = entry?.inputSnapshot || {};
    const scenario = payload?.scenario || entry?.scenario || {};
    const method = entry?.method === "port-discrete-event" ? "端口级离散事件仿真" : "聚合流量仿真";
    const points = Array.isArray(entry?.forecast) ? entry.forecast : [];
    const current = points[0] || {};
    const lines = [
      ["预测方法", method],
      ["补能位状态", `总枪位 ${snapshot.totalPorts ?? "—"} · 可用 ${snapshot.availablePorts ?? snapshot.idlePorts ?? "—"} · 已预约 ${snapshot.reservedPorts ?? "—"} · 充电中 ${snapshot.chargingPorts ?? "—"}`],
      ["预约队列", `已到站等待 ${snapshot.waitingVehicles ?? snapshot.queueVehicles ?? "—"} 辆 · 预计在前 ${snapshot.reservationQueueAhead ?? "—"} 辆 · ${snapshot.queueSource || "未标明来源"}`],
      ["服务参数", `平均服务 ${snapshot.averageSessionMinutes ?? "—"} 分钟 · 预计释放 ${Array.isArray(snapshot.estimatedReleaseMinutes) ? snapshot.estimatedReleaseMinutes.slice(0, 4).join(" / ") : "—"} 分钟`],
      ["情景输入", `到站偏移 ${scenario.arrivalOffsetMinutes ?? scenario.etaMinutes ?? 0} 分钟 · 天气因子 ${scenario.weatherFactor ?? 1} · 需求因子 ${scenario.demandFactor ?? 1}`],
      ["当前输出", `排队 P50 ${Number(current.p50 ?? current.wait ?? 0).toFixed(1)} 分钟 · 排队 P90 ${Number(current.p90 ?? current.wait ?? 0).toFixed(1)} 分钟`],
      ["企业需求先验", entry?.enterprisePrior?.matched
        ? `${entry.enterprisePrior.city} · ${entry.enterprisePrior.energyType === "fuel" ? "油站" : "电站"} · 需求倍率 ${Number(entry.enterprisePrior.demandFactor || 1).toFixed(2)} · 匹配距离 ${Number(entry.enterprisePrior.matchDistanceKm || 0).toFixed(1)} km`
        : "未匹配企业先验，使用演示输入"],
      ["置信度依据", Number.isFinite(Number(entry?.confidenceScore))
        ? `${entry.confidenceLabel || `${Math.round(Number(entry.confidenceScore))}/100`} · ${(entry.confidenceReasons || []).slice(0, 3).join("；")}`
        : "当前版本未计算动态置信度"],
      ["数据时间", entry?.asOf || snapshot.snapshotTime || "本次演示计算"],
      ["数据来源", entry?.dataSource || "FlowTwin 演示仿真"]
    ];
    panel.innerHTML = `${lines.map(([label, value]) => `<div><strong>${escapeHtml(label)}：</strong>${escapeHtml(value)}</div>`).join("")}<div><strong>计算口径：</strong>先按到站时刻选择预测点，再用端口释放事件、已到站等待和预约队列估计排队，并从排队分布计算 P50/P90；路线 ETA 另行叠加补能服务时长和支付驶离缓冲。当前补能位与预约队列仍是演示输入，不是能链企业实时数据。</div>${entry?.explanation ? `<div><strong>解释：</strong>${escapeHtml(entry.explanation)}</div>` : ""}`;
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  }

  // 天气来自高德实况（按起点所在区县）。它只影响预测的方向--雨雪天抬高峰值等待，
  // 不接天气时 weatherFactor 为 1，预测与原来完全一致。
  function weatherIcon(condition) {
    const text = String(condition || "");
    if (/雪/.test(text)) return "snowflake";
    if (/雷/.test(text)) return "cloud-lightning";
    if (/雨/.test(text)) return "cloud-rain";
    if (/雾|霾/.test(text)) return "cloud-fog";
    if (/沙|尘/.test(text)) return "wind";
    if (/阴/.test(text)) return "cloud";
    if (/云/.test(text)) return "cloud-sun";
    return "sun";
  }

  async function loadWeather() {
    const origin = state.origin;
    if (!Array.isArray(origin) || origin.length < 2 || !Number.isFinite(origin[0])) return;
    const location = `${origin[0].toFixed(6)},${origin[1].toFixed(6)}`;
    try {
      const response = await fetch(`/api/weather?${new URLSearchParams({ location })}`, { headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload && payload.condition) {
        state.weather = payload;
      } else {
        state.weather = null;
      }
    } catch {
      state.weather = null;
    }
    renderWeather();
  }

  function renderWeather() {
    const host = byId("originWeather");
    if (!host) return;
    const w = state.weather;
    if (!w || !w.condition) { host.hidden = true; host.textContent = ""; return; }
    const temp = Number.isFinite(w.temperature) ? `${w.temperature}°` : "";
    const label = `${w.city || ""} ${w.condition} ${temp}`.trim();
    host.innerHTML = `<i data-lucide="${weatherIcon(w.condition)}"></i>${escapeHtml(label)}`;
    host.classList.toggle("severe", Boolean(w.severe));
    host.hidden = false;
    refreshIcons();
  }

  async function requestForecast(station) {
    if (!station) return;
    const requestId = ++state.forecastRequestVersion;
    const status = byId("forecastStatus");
    if (status) status.textContent = "正在计算…";
    // A station can arrive here from an older route record with a legacy
    // forecast array but without the current method/input evidence. Do not
    // render that stale aggregate snapshot as if it were the current forecast
    // contract; the port-level demo snapshot must get a chance to run.
    if (Array.isArray(station.forecast) && station.forecast.length && station.forecastMethod && !reservationOverrideFor(station)) {
      renderForecast(station, station);
      return;
    }
    try {
      const forecastInput = buildStationForecastInput(station);
      const payload = await postJson("/api/forecast", {
        stations: [forecastInput],
        scenario: {
          departureMinutes: state.departureMinutes,
          energyType: state.energyType,
          weatherFactor: state.weather?.weatherFactor
        }
      }, 20000);
      if (requestId === state.forecastRequestVersion && state.selectedStation?.id === station.id) renderForecast(station, payload);
    } catch (error) {
      if (status) status.textContent = "本地演示预测";
    }
  }

  function plannerDeadlineOffset() {
    if (!state.deadlineEnabled) return undefined;
    const difference = Number(state.deadlineMinutes) - Number(state.departureMinutes);
    return Math.max(0, difference < 0 ? difference + 24 * 60 : difference);
  }

  function forecastScenarioKey(baseRoute) {
    return [
      state.departureMinutes,
      state.energyType,
      state.hybridBranch,
      state.destination?.join(","),
      Number(baseRoute?.distance || 0).toFixed(1),
      Number(state.weather?.weatherFactor || 1).toFixed(2),
      Object.entries(state.reservationOverrides || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, count]) => `${id}:${count}`)
        .join(",")
    ].join("|");
  }

  // 企业端口/枪位数据暂未开放。为了让评委能看到“站点排队时间”不是一条
  // 写死的数字，这里从已有演示占用率、容量和等待输入推导一份确定性的端口
  // 快照，交给后端的 port-discrete-event 仿真。预约字段只表示演示队列，
  // 必须明确标注为演示数据，不能伪装成能链实时站点状态；后续拿到脱敏
  // 站点接口时，只替换这层输入。
  function buildDemoPortSnapshot(station) {
    const totalPorts = Math.max(4, Math.min(60, Math.round(Number(station?.capacity) || 12)));
    const occupancy = Math.max(0, Math.min(0.96, Number(station?.occupancy) || 0));
    const faultPorts = occupancy >= 0.93 ? 1 : 0;
    const chargingPorts = Math.max(1, Math.min(totalPorts - faultPorts, Math.round(totalPorts * occupancy)));
    const idlePorts = Math.max(0, totalPorts - chargingPorts - faultPorts);
    const wait = Math.max(0, Number(station?.wait ?? station?.p50) || 0);
    // 两类预约状态有不同含义：reservedPorts 是已经锁定给预约用户的
    // 资源，reservationQueueAhead 是尚未分配资源、但在当前用户前面的
    // 预约订单。演示输入刻意保持保守，不把它们混成“实时排队人数”。
    const reservedPorts = Math.min(idlePorts, wait >= 12 ? 1 : 0);
    const availablePorts = Math.max(0, idlePorts - reservedPorts);
    // 当前有可用端口时，不再凭等待分钟倒推“此刻正在排队”的车辆；否则
    // 页面会同时出现“空闲 3/12”和“排队 2 辆”的误导性组合。未来到站的
    // 预约需求仍单列为 reservationQueueAhead，并由预测模型在 ETA 时刻重排。
    const queueVehicles = availablePorts > 0
      ? 0
      : Math.max(0, Math.min(24, Math.round(Math.max(0, wait - 4) / 6)));
    const reservationQueueAhead = Math.max(0, Math.min(6, Math.floor(Math.max(0, wait - 24) / 18)));
    const averageSessionMinutes = station?.type === "加油站" ? 8 : 35;
    const estimatedReleaseMinutes = Array.from({ length: chargingPorts }, (_, index) => Number(Math.max(0, wait * (0.8 + (index % 4) * 0.1)).toFixed(1)));
    return {
      totalPorts,
      idlePorts,
      availablePorts,
      chargingPorts,
      faultPorts,
      reservedPorts,
      waitingVehicles: queueVehicles,
      queueVehicles,
      reservationQueueAhead,
      estimatedReleaseMinutes,
      averageSessionMinutes,
      snapshotTime: `simulation@${formatClock(state.departureMinutes)}`,
      dataSource: "FlowTwin 演示仿真 · 端口状态 + 预约队列推演",
      availabilitySource: "FlowTwin 演示补能位状态",
      queueSource: "FlowTwin 演示预约队列",
      freshnessSeconds: null
    };
  }

  function buildStationForecastInput(station) {
    const input = Object.assign(
      {},
      station,
      station?.forecastInputSnapshot || buildDemoPortSnapshot(station)
    );
    const override = Math.max(0, Number(state.reservationOverrides?.[String(station?.id)]) || 0);
    const reservationAlreadyApplied = String(input.queueSource || "").includes("当前用户已预约")
      || String(input.dataSource || "").includes("当前用户预约");
    if (!override || reservationAlreadyApplied) return input;
    const currentAhead = Math.max(0, Number(input.reservationQueueAhead) || 0);
    return Object.assign(input, {
      reservationQueueAhead: Math.min(5000, currentAhead + override),
      queueSource: "FlowTwin 演示预约队列 · 当前用户已预约",
      dataSource: `${input.dataSource || "FlowTwin 演示仿真"} · 当前用户预约`
    });
  }

  function reservationOverrideFor(station) {
    return Math.max(0, Number(state.reservationOverrides?.[String(station?.id)]) || 0);
  }

  function renderReservationAction(station) {
    const action = byId("reservationAction");
    const button = byId("reservationButton");
    const status = byId("reservationStatus");
    if (!action || !button || !status) return;
    const isFuelStation = String(station?.type || "").includes("油");
    action.hidden = !station || isFuelStation;
    if (!station || isFuelStation) return;
    const override = reservationOverrideFor(station);
    button.disabled = override > 0;
    button.textContent = override > 0 ? "已预约" : "模拟预约";
    status.textContent = override > 0
      ? "已加入本次演示队列，等待时间已重新计算"
      : "仅用于演示预约队列，不创建真实订单";
  }

  async function simulateReservation() {
    const station = state.selectedStation;
    if (!station || String(station.type || "").includes("油")) return;
    const key = String(station.id);
    if (reservationOverrideFor(station) > 0) return;
    state.reservationOverrides[key] = 1;
    state.stationForecastScenarioKey = null;
    const base = state.baseRouteRecords.reliable || state.routeRecords.reliable;
    if (base) await ensureStationForecasts(base);
    const updated = state.stations.find((candidate) => String(candidate.id) === key) || station;
    state.selectedStation = updated;
    renderReservationAction(updated);
    selectStation(updated, false);
    showToast("已加入演示预约队列，站点等待时间已重新计算", 2600);
  }

  async function ensureStationForecasts(baseRoute) {
    const stations = Array.isArray(state.stations) ? state.stations : [];
    if (!stations.length || !baseRoute) return null;
    const scenarioKey = forecastScenarioKey(baseRoute);
    if (state.stationForecastScenarioKey === scenarioKey && stations.every((station) => (
      Array.isArray(station.forecast) && station.forecast.length && station.forecastMethod
    ))) return null;
    const requestId = ++state.stationForecastRequestVersion;
    const duration = Math.max(30, Number(baseRoute.duration || 30));
    const horizonMinutes = Math.min(240, Math.max(30, Math.ceil(duration / 5) * 5));
    const inputStations = stations.map((station) => Object.assign({}, station, {
      stationSource: station.source,
      ...buildStationForecastInput(station),
      arrivalOffsetMinutes: Math.max(0, Number.isFinite(Number(station.routeProgress))
        ? Number(station.routeProgress) * Number(baseRoute.duration || 0)
        : 0)
    }));
    try {
      const payload = await postJson("/api/forecast", {
        stations: inputStations,
        scenario: {
          departureMinutes: state.departureMinutes,
          weatherFactor: Number(state.weather?.weatherFactor) || 1,
          // No front-end demand or traffic feed is configured yet. Explicit 1
          // means “neutral simulation factor”, not invented live traffic data.
          trafficFactor: 1,
          demandFactor: 1,
          horizonMinutes,
          intervalMinutes: 5
        }
      }, 30000);
      if (requestId !== state.stationForecastRequestVersion) return null;
      const forecastById = new Map((payload.stations || []).map((entry) => [String(entry.id), entry]));
      state.stations = stations.map((station) => {
        const entry = forecastById.get(String(station.id));
        if (!entry) return station;
        const arrivalOffsetMinutes = Number.isFinite(Number(entry.arrivalOffsetMinutes))
          ? Number(entry.arrivalOffsetMinutes)
          : Math.max(0, Number(station.routeProgress || 0) * duration);
        const prediction = (entry.prediction && Object.keys(entry.prediction).length)
          ? entry.prediction
          : (entry.arrivalForecast && Object.keys(entry.arrivalForecast).length)
            ? entry.arrivalForecast
            : selectForecastPointForArrival(entry, arrivalOffsetMinutes) || {};
        const p50 = Number(prediction.p50 ?? entry.p50 ?? station.p50);
        const p90 = Number(prediction.p90 ?? entry.p90 ?? station.p90);
        const wait = Number(prediction.wait ?? entry.wait ?? station.wait);
        const risk = prediction.risk || entry.baseline?.risk || (p90 >= 20 ? "forecast-risk" : "forecast-ready");
        return Object.assign({}, station, {
          stationSource: station.source,
          forecast: entry.forecast,
          prediction,
          arrivalForecast: prediction,
          arrivalOffsetMinutes,
          arrivalMinute: Number.isFinite(Number(entry.arrivalMinute)) ? Number(entry.arrivalMinute) : state.departureMinutes + arrivalOffsetMinutes,
          wait: Number.isFinite(wait) ? wait : station.wait,
          p50: Number.isFinite(p50) ? p50 : station.p50,
          p90: Number.isFinite(p90) ? p90 : station.p90,
          forecastSource: entry.source || payload.source || "simulation",
          forecastAsOf: entry.asOf || payload.asOf || null,
          forecastMethod: entry.method || payload.method || "aggregate-flow-simulation",
          forecastDataAsOf: entry.dataAsOf || payload.dataAsOf || entry.asOf || payload.asOf || null,
          forecastFreshnessSeconds: Number.isFinite(Number(entry.freshnessSeconds)) ? Number(entry.freshnessSeconds) : null,
          forecastInputSnapshot: entry.inputSnapshot || null,
          forecastArrivalWaitP50: Number.isFinite(Number(prediction.p50)) ? Number(prediction.p50) : null,
          forecastArrivalWaitP90: Number.isFinite(Number(prediction.p90)) ? Number(prediction.p90) : null,
          forecastConfidence: entry.confidence || payload.confidence || "simulation-only",
          forecastConfidenceScore: Number.isFinite(Number(entry.confidenceScore)) ? Number(entry.confidenceScore) : null,
          forecastConfidenceLevel: entry.confidenceLevel || null,
          forecastConfidenceLabel: entry.confidenceLabel || null,
          forecastConfidenceReasons: Array.isArray(entry.confidenceReasons) ? entry.confidenceReasons.slice(0, 8) : [],
          forecastEnterprisePrior: entry.enterprisePrior || null,
          forecastHorizonMinutes: entry.horizonMinutes || payload.horizonMinutes || horizonMinutes,
          forecastSimulation: entry.simulation === true || payload.simulation === true || entry.source === "simulation" || payload.source === "simulation",
          status: risk,
          riskLabel: risk === "forecast-risk" ? "预测风险" : "预测可用"
        });
      });
      state.stationForecastScenarioKey = scenarioKey;
      if (state.operatorOriginalStations.length) {
        state.operatorOriginalStations = state.stations.map((station) => Object.assign({}, station));
        state.operatorBefore = computeOperatorSnapshot(state.stations);
        renderOperatorMetrics(state.operatorBefore, false);
        populateOperatorTargetSelect();
      }
      if (state.selectedStation) {
        state.selectedStation = state.stations.find((station) => station.id === state.selectedStation.id) || state.selectedStation;
        selectStation(state.selectedStation, false);
      }
      highlightSelectedStation();
      return payload;
    } catch {
      // Forecast is an enrichment layer. Existing deterministic station fields
      // remain usable, and the UI continues to label them as demonstration data.
      return null;
    }
  }

  function applyParsedIntent(parsed, payload) {
    const requestedDestination = String(parsed?.destination || "").trim();
    const destinationLocation = payload.destinationLocation || parsed.destinationLocation;
    const normalizedDestination = parseLocation(destinationLocation);
    // Never retain the last/default airport coordinates when a new destination
    // cannot be geocoded. Showing an explicit failure is safer than a plausible
    // but wrong route.
    if (!requestedDestination || !normalizedDestination) {
      return { ok: false, destination: requestedDestination };
    }
    // 起点和终点同等对待：解析得到坐标就采用，用户点名了一个起点却定位不到，
    // 就如实报错——绝不能默默地从北京总部出发去规划一趟上海出发的行程。
    const requestedOrigin = String(parsed?.origin || "").trim();
    const normalizedOrigin = parseLocation(payload.originLocation || parsed.originLocation);
    const originIsDefault = !requestedOrigin || requestedOrigin === DEFAULT_ORIGIN_NAME;
    if (normalizedOrigin) {
      state.origin = normalizedOrigin;
      state.originName = originIsDefault ? DEFAULT_ORIGIN_NAME : requestedOrigin;
      state.originNote = originIsDefault
        ? "北京市朝阳区姚家园南路 1 号 · 演示默认起点"
        : `${payload.locationSources?.origin || "高德定位"} · 按你指定的出发地规划`;
    } else if (!originIsDefault) {
      return { ok: false, destination: requestedDestination, origin: requestedOrigin, originUnresolved: true };
    }
    const parsedHasDeadline = Boolean(parsed.arrivalDeadline);
    const parsedReserve = Number(parsed.minArrivalSoc);
    const parsedHasReserve = parsed.minArrivalSoc !== null && parsed.minArrivalSoc !== undefined && parsed.minArrivalSoc !== "" && Number.isFinite(parsedReserve);
    if (state.manualDeadlineOverride === null) state.deadlineEnabled = parsedHasDeadline;
    if (state.deadlineEnabled && parsedHasDeadline) state.deadlineMinutes = clockToMinutes(parsed.arrivalDeadline, state.deadlineMinutes);
    if (state.manualArrivalReserveOverride === null) state.arrivalReserveEnabled = parsedHasReserve;
    if (state.arrivalReserveEnabled && parsedHasReserve) state.minArrivalSoc = Math.max(5, Math.min(100, parsedReserve));
    state.detourExplicit = parsed.maxDetourKm !== null && parsed.maxDetourKm !== undefined && Number.isFinite(Number(parsed.maxDetourKm));
    if (state.detourExplicit) {
      state.maxDetourKm = Math.max(0, Math.min(50, Number(parsed.maxDetourKm)));
    } else {
      state.maxDetourKm = 8;
    }
    // The parser reports a dual-energy vehicle as "mixed"; that is exactly the
    // hybrid case, and dropping it used to leave a 混动 user planned as a BEV.
    const parsedEnergyType = parsed.energyType === "mixed" ? "hybrid" : parsed.energyType;
    if (ENERGY_TYPES.includes(parsedEnergyType) && parsedEnergyType !== state.energyType) {
      adoptEnergyType(parsedEnergyType);
    }
    if (parsed.priority) state.priority = parsed.priority;
    state.destination = normalizedDestination;
    state.aiContext = Object.assign({}, state.aiContext || {}, parsed);
    renderParsedIntent(parsed);
    updateEnergyControls();
    const destinationName = byId("destinationName");
    state.destinationName = requestedDestination;
    if (destinationName) destinationName.textContent = state.destinationName;
    const destinationValue = document.querySelector(".route-field.destination-field .field-value");
    if (destinationValue) destinationValue.textContent = state.destinationName;
    setText("originName", state.originName);
    setText("originMeta", state.originNote);
    const departureValue = byId("departureValue");
    if (departureValue) departureValue.textContent = formatClock(state.departureMinutes);
    syncManualControls();
    return { ok: true, destination: requestedDestination };
  }

  function syncManualControls() {
    const energyInput = byId("topEnergyPercentInput");
    const departureInput = byId("departureTimeInput");
    const deadlineInput = byId("deadlineInput");
    const minArrivalInput = byId("minArrivalSocInput");
    if (energyInput) energyInput.value = String(Math.round(state.energyPercent));
    if (departureInput) departureInput.value = formatClock(state.departureMinutes);
    if (deadlineInput) deadlineInput.value = state.deadlineEnabled ? formatClock(state.deadlineMinutes) : "";
    if (minArrivalInput) minArrivalInput.value = state.arrivalReserveEnabled ? String(Math.round(state.minArrivalSoc)) : "";
    const arrivalValue = byId("arrivalValue");
    if (arrivalValue) arrivalValue.textContent = state.deadlineEnabled ? formatClock(state.deadlineMinutes) : "不限";
    const destinationMeta = byId("destinationMeta");
    if (destinationMeta) {
      const timeText = state.deadlineEnabled ? `最晚 ${formatClock(state.deadlineMinutes)} 前到达` : "到达时间不限";
      const reserveText = state.arrivalReserveEnabled ? `到达保留 ≥${state.minArrivalSoc}%` : "仅保留车辆安全下限";
      destinationMeta.textContent = `${timeText} · ${reserveText}`;
    }
  }

  function readManualControls(options = {}) {
    const energyInput = byId("topEnergyPercentInput");
    const departureInput = byId("departureTimeInput");
    const deadlineInput = byId("deadlineInput");
    const minArrivalInput = byId("minArrivalSocInput");
    const energy = Number(energyInput?.value);
    const rawMinArrival = String(minArrivalInput?.value || "").trim();
    const minArrival = rawMinArrival ? Number(rawMinArrival) : Number.NaN;
    if (Number.isFinite(energy)) state.energyPercent = Math.max(5, Math.min(100, energy));
    // 顶栏那一格在混动模式下编辑的是"当前分支"的能量，必须写回两级真值。
    syncHybridLevels("percent");
    if (Number.isFinite(minArrival)) state.minArrivalSoc = Math.max(5, Math.min(100, minArrival));
    if (departureInput?.value) state.departureMinutes = clockToMinutes(departureInput.value, state.departureMinutes);
    if (deadlineInput?.value) state.deadlineMinutes = clockToMinutes(deadlineInput.value, state.deadlineMinutes);
    if (options.markArrivalOverrides) {
      state.deadlineEnabled = Boolean(deadlineInput?.value);
      state.arrivalReserveEnabled = Number.isFinite(minArrival);
      state.manualDeadlineOverride = state.deadlineEnabled;
      state.manualArrivalReserveOverride = state.arrivalReserveEnabled;
    }
    syncManualControls();
    updateEnergyControls();
  }

  function stableHash(value) {
    let result = 0;
    const text = String(value || "station");
    for (let index = 0; index < text.length; index += 1) {
      result = (result * 31 + text.charCodeAt(index)) >>> 0;
    }
    return result;
  }

  function parseLocation(location) {
    if (!location) return null;
    if (Array.isArray(location)) return [Number(location[0]), Number(location[1])];
    if (typeof location === "string") {
      const parts = location.split(",").map(Number);
      return parts.length >= 2 && parts.every(Number.isFinite) ? [parts[0], parts[1]] : null;
    }
    if (typeof location.getLng === "function" && typeof location.getLat === "function") {
      const lng = Number(location.getLng());
      const lat = Number(location.getLat());
      return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
    }
    if (Number.isFinite(Number(location.lng)) && Number.isFinite(Number(location.lat))) {
      return [Number(location.lng), Number(location.lat)];
    }
    return null;
  }

  function formatClock(totalMinutes) {
    const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
    const hours = String(Math.floor(normalized / 60)).padStart(2, "0");
    const minutes = String(normalized % 60).padStart(2, "0");
    return `${hours}:${minutes}`;
  }

  function formatDuration(minutes) {
    const rounded = Math.max(1, Math.round(minutes));
    if (rounded < 60) return `${rounded} 分钟`;
    return `${Math.floor(rounded / 60)}小时${rounded % 60}分`;
  }

  function distanceKm(a, b) {
    const latScale = 111;
    const lngScale = 111 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
    return Math.sqrt(Math.pow((a[0] - b[0]) * lngScale, 2) + Math.pow((a[1] - b[1]) * latScale, 2));
  }

  function routeDistance(path) {
    let total = 0;
    for (let index = 1; index < path.length; index += 1) total += distanceKm(path[index - 1], path[index]);
    return total;
  }

  // A route polyline may be simplified by the routing API. Comparing a POI
  // only to its vertices makes an on-route station look tens of kilometres
  // away when it sits in the middle of a long segment. Always project onto
  // segments, then reuse the same geometry for the corridor filter, progress
  // label and later first-leg feasibility check.
  function projectPointOntoPath(point, path) {
    if (!Array.isArray(point) || !Array.isArray(path) || !path.length) return null;
    if (path.length === 1) return { offsetKm: distanceKm(point, path[0]), alongKm: 0, totalKm: 0 };
    let travelled = 0;
    let best = { offsetKm: Number.POSITIVE_INFINITY, alongKm: 0, totalKm: 0 };
    for (let index = 1; index < path.length; index += 1) {
      const a = path[index - 1];
      const b = path[index];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      const referenceLat = ((a[1] + b[1] + point[1]) / 3) * Math.PI / 180;
      const scaleX = 111 * Math.cos(referenceLat);
      const scaleY = 111;
      const bx = (b[0] - a[0]) * scaleX;
      const by = (b[1] - a[1]) * scaleY;
      const wx = (point[0] - a[0]) * scaleX;
      const wy = (point[1] - a[1]) * scaleY;
      const segmentKm = Math.hypot(bx, by);
      if (segmentKm < 0.0001) continue;
      const ratio = Math.max(0, Math.min(1, (wx * bx + wy * by) / (segmentKm * segmentKm)));
      const offsetKm = Math.hypot(wx - bx * ratio, wy - by * ratio);
      if (offsetKm < best.offsetKm) best = { offsetKm, alongKm: travelled + segmentKm * ratio, totalKm: 0 };
      travelled += segmentKm;
    }
    best.totalKm = travelled;
    return best;
  }

  function nearestPointDistance(point, path) {
    return projectPointOntoPath(point, path)?.offsetKm ?? Number.POSITIVE_INFINITY;
  }

  function routeProgress(point, path) {
    const projection = projectPointOntoPath(point, path);
    if (!projection || projection.totalKm <= 0) return 0;
    return Math.max(0, Math.min(1, projection.alongKm / projection.totalKm));
  }

  // 把站点投影到"沿线进度/走廊偏离"时用的参考路线。实况模式下还没有真实路线
  // 时返回空折线：投影到北京→大兴机场的演示折线上，会给任意行程编造出一组
  // 看似合理的沿线里程。空折线会让 routeProgress 归 0、corridorKm 变成无穷，
  // 下游据此判定"无参考路线"，不会当成真实数据展示。
  function corridorReferenceRoute(routeKey = "reliable") {
    return state.baseRouteRecords[routeKey]
      || state.routeRecords[routeKey]
      || state.baseRouteRecords.reliable
      || state.routeRecords.reliable
      || { path: state.live ? [] : FALLBACK.routes.reliable };
  }

  // A hybrid can be planned on either energy path. Everything downstream stays
  // single-branch; this is the one place that decides which branch is live.
  function activeEnergyKind() {
    if (state.energyType === "hybrid") return state.hybridBranch === "fuel" ? "fuel" : "electric";
    // 这里必须直接读 state：isFuelActive() 反过来依赖本函数，会无限互相递归。
    return state.energyType === "fuel" ? "fuel" : "electric";
  }

  function isFuelActive() {
    return activeEnergyKind() === "fuel";
  }

  function isHybrid() {
    return state.energyType === "hybrid";
  }

  function getEnergyProfile(isFuel) {
    if (state.energyType === "hybrid") return isFuel ? ENERGY_PROFILES.hybridFuel : ENERGY_PROFILES.hybridElectric;
    return isFuel ? ENERGY_PROFILES.fuel : ENERGY_PROFILES.electric;
  }

  function clampPercent(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(5, Math.min(100, parsed)) : fallback;
  }

  // `energyPercent` is what the whole planner reads. In hybrid mode it is a
  // mirror of the active branch, so the two must be resynced on every change.
  function syncHybridLevels(source = "levels") {
    if (!isHybrid()) return;
    const kind = activeEnergyKind();
    const other = kind === "fuel" ? "electric" : "fuel";
    state.hybridLevels[other] = clampPercent(state.hybridLevels[other], other === "fuel" ? 60 : 35);
    if (source === "percent") state.hybridLevels[kind] = clampPercent(state.energyPercent, 35);
    else state.energyPercent = clampPercent(state.hybridLevels[kind], 35);
  }

  function hybridBranchLevel(kind) {
    if (!isHybrid()) return state.energyPercent;
    return activeEnergyKind() === kind ? state.energyPercent : clampPercent(state.hybridLevels[kind], kind === "fuel" ? 60 : 35);
  }

  // The shared backend energy model keys hybrid branches separately so its
  // physics match the profile the browser is planning with.
  function backendEnergyTypeKey() {
    if (isHybrid()) return isFuelActive() ? "hybridFuel" : "hybridElectric";
    return isFuelActive() ? "fuel" : "electric";
  }

  function energyNoun(isFuel = isFuelActive()) {
    return isFuel ? "油" : "电";
  }

  function activeStationType() {
    return isFuelActive() ? "加油站" : "充电站";
  }

  // In hybrid mode `state.stations` holds both networks. Any planner that has
  // already committed to one energy path must only see that path's stations.
  function stationsForActiveBranch(pool = state.stations) {
    if (!isHybrid()) return pool;
    const desiredType = activeStationType();
    return pool.filter((station) => station.type === desiredType);
  }

  // Hybrid planning keeps both the fuel and electric POI pools in the same
  // state array.  A single boolean saying that a corridor fallback exists is
  // therefore not enough: after switching from fuel to electric (or back),
  // the other branch's fallback must not suppress injection for the active
  // branch.  Derive the flag from the active network instead of trusting the
  // stale value left by the previous branch.
  function activeProvisionalCorridorActive(routeKey = null, pool = state.stations) {
    return stationsForActiveBranch(Array.isArray(pool) ? pool : [])
      .some((station) => {
        if (!station || station.provisionalCorridor !== true) return false;
        if (!routeKey) return true;
        return (station.provisionalRouteKey || "reliable") === routeKey;
      });
  }

  function profileForStationType(stationType) {
    const isFuel = stationType === "加油站";
    if (isHybrid()) return isFuel ? ENERGY_PROFILES.hybridFuel : ENERGY_PROFILES.hybridElectric;
    return isFuel ? ENERGY_PROFILES.fuel : ENERGY_PROFILES.electric;
  }

  // ¥ per driven kilometre — the only price basis that is comparable between a
  // ¥/kWh charger and a ¥/L pump.
  function stationCostPerKm(station) {
    const profile = profileForStationType(station?.type);
    return Math.max(0, Number(station?.price || 0)) * profile.consumptionPerKm;
  }

  // Energy burnt out of the tank the driver started with still costs money. Use
  // the median price of the matching network along this route as its value, so
  // a direct trip is not reported as a zero-cost trip.
  function referenceEnergyPrice(isFuel = isFuelActive()) {
    const desiredType = isFuel ? "加油站" : "充电站";
    const prices = state.stations
      .filter((station) => station.type === desiredType)
      .map((station) => Number(station.price))
      .filter((price) => Number.isFinite(price) && price > 0)
      .sort((a, b) => a - b);
    if (prices.length) return prices[Math.floor(prices.length / 2)];
    return isFuel ? 7.65 : 1.45;
  }

  function effectiveArrivalReserveSoc(profile) {
    // The user may leave the arrival reserve blank. That removes the personal
    // requirement, not the physical safety floor needed to avoid planning a
    // route that ends at an empty battery or tank.
    return state.arrivalReserveEnabled ? state.minArrivalSoc : profile.safetyReservePercent;
  }

  function hasArrivalDeadline() {
    return Boolean(state.deadlineEnabled);
  }

  function arrivalReserveDescription(record) {
    const fallback = getEnergyProfile(isFuelActive()).safetyReservePercent;
    const value = Number.isFinite(Number(record?.targetArrivalSoc))
      ? Number(record.targetArrivalSoc)
      : fallback;
    return record?.arrivalReserveRequired
      ? `目标到达余量 ≥${value}%`
      : `未设到达余量要求，系统安全下限 ≥${value}%`;
  }

  // The POI coordinate is not guaranteed to be an exact polyline vertex. Find
  // its nearest point on the actual route and return the driven distance to it.
  function distanceAlongPathToWaypoint(path, waypoint) {
    const projection = projectPointOntoPath(waypoint, path);
    if (!projection) return null;
    // A POI can be slightly off the road because its pin is at a parking lot
    // entrance. Anything farther away is not treated as a proven route stop.
    return projection.offsetKm <= 1.2 ? projection.alongKm : null;
  }

  function directEnergyState(record, isFuel) {
    const profile = getEnergyProfile(isFuel);
    const currentEnergy = profile.capacity * state.energyPercent / 100;
    const targetEnergy = profile.capacity * effectiveArrivalReserveSoc(profile) / 100;
    const consumption = Math.max(0, Number(record?.distance) || 0) * profile.consumptionPerKm;
    const remainingEnergy = currentEnergy - consumption;
    const safetyReserveEnergy = profile.capacity * profile.safetyReservePercent / 100;
    return {
      profile,
      currentEnergy,
      targetEnergy,
      consumption,
      remainingEnergy,
      canDirect: remainingEnergy >= targetEnergy,
      maxSafeFirstLegKm: Math.max(0, currentEnergy - safetyReserveEnergy) / profile.consumptionPerKm
    };
  }

  function estimateStationApproachKm(station) {
    // Before a route is requested, use a conservative geometry filter. The
    // final decision is always made from the returned road-route polyline.
    return distanceKm(state.origin, station.location) * 1.28;
  }

  function estimateStationDetourKm(station) {
    const direct = distanceKm(state.origin, state.destination);
    return Math.max(0, (distanceKm(state.origin, station.location) + distanceKm(station.location, state.destination) - direct) * 1.25);
  }

  // 电价与油价不是同一个量纲。快充按 ¥/kWh（电费+服务费），成品油按 ¥/L
  // （92# 零售价区间）。此前两者共用一条公式，燃油成本被低估约 5 倍，
  // 任何油电对比都不成立。价格仍为固定种子的演示值，不是实时挂牌价。
  const ENERGY_PRICE_BANDS = {
    充电站: { base: 1.15, spread: 60, unit: "kWh" },
    加油站: { base: 7.25, spread: 80, unit: "L" }
  };

  function simulatedPrice(stationType, hash) {
    const band = ENERGY_PRICE_BANDS[stationType] || ENERGY_PRICE_BANDS.充电站;
    return Number((band.base + (hash % band.spread) / 100).toFixed(2));
  }

  // 运营侧不能把高德检索到的所有站点都当成能链可调控站点。真实的 POI
  // 只回答“地图上有什么”，下面这组字段是为了演示平台边界而生成的固定
  // 种子配置：只有少量站点同时满足合作、可调控、可发券、商家接受四个条件。
  // 这不是企业签约表，也不是实时经营数据；请求运营接口时会再次显式携带
  // 这些字段，避免后端的旧版兼容逻辑把缺字段站点默认成可执行。
  const OPERATOR_DEMO_DEFAULTS = Object.freeze({
    dataSource: "FlowTwin 演示平台配置",
    asOf: "固定种子演示 · 非实时",
    platformCoupon: 6,
    merchantCouponShare: 0.35,
    platformTakeRate: 0.12,
    platformVariableCost: 0.18,
    campaignBudget: 240
  });

  function decorateOperatorDemoStations(stations) {
    const source = Array.isArray(stations) ? stations : [];
    if (!source.length) return source;
    const groups = new Map();
    source.forEach((station, index) => {
      const key = station.type || "补能站";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ station, index });
    });
    const eligibleIds = new Set();
    groups.forEach((group) => {
      const rank = ({ station }) => stableHash(`operator-platform:${station.id || station.name}`);
      const preferred = group
        .filter(({ station }) => rank({ station }) % 5 === 0)
        .sort((a, b) => rank(a) - rank(b));
      const minimum = Math.min(2, group.length);
      const selected = preferred.slice(0, 3);
      for (const entry of group.slice().sort((a, b) => rank(a) - rank(b))) {
        if (selected.length >= minimum) break;
        if (!selected.some((picked) => picked.station.id === entry.station.id)) selected.push(entry);
      }
      selected.slice(0, 3).forEach(({ station }) => eligibleIds.add(String(station.id)));
    });
    return source.map((station, index) => {
      if (station.operatorMeta?.metadataVersion === 1) return station;
      const seed = stableHash(`operator-economics:${station.id || station.name}`);
      const eligible = eligibleIds.has(String(station.id));
      const capacity = Math.max(1, Number(station.capacity) || 18);
      const operatorMeta = {
        metadataVersion: 1,
        partner: eligible,
        controllable: eligible,
        couponEligible: eligible,
        merchantAccepted: eligible,
        windowCapacity: Number((capacity * (eligible ? 0.82 : 0.68)).toFixed(2)),
        platformCoupon: OPERATOR_DEMO_DEFAULTS.platformCoupon,
        merchantCouponShare: OPERATOR_DEMO_DEFAULTS.merchantCouponShare,
        platformTakeRate: OPERATOR_DEMO_DEFAULTS.platformTakeRate,
        platformVariableCost: OPERATOR_DEMO_DEFAULTS.platformVariableCost,
        campaignBudget: OPERATOR_DEMO_DEFAULTS.campaignBudget,
        dataSource: OPERATOR_DEMO_DEFAULTS.dataSource,
        asOf: OPERATOR_DEMO_DEFAULTS.asOf,
        label: "演示平台配置（非企业真实字段）",
        seed
      };
      return Object.assign({}, station, { operatorMeta });
    });
  }

  function ensureOperatorDemoMetadata() {
    if (!Array.isArray(state.stations) || !state.stations.length) return [];
    if (state.stations.every((station) => station.operatorMeta?.metadataVersion === 1)) return state.stations;
    state.stations = decorateOperatorDemoStations(state.stations);
    return state.stations;
  }

  function simulateStation(poi, index) {
    const hash = stableHash(`${poi.id || poi.name}-${index}`);
    const occupancy = 0.42 + (hash % 44) / 100;
    const p50 = 4 + (hash % 10);
    const p90 = p50 + 5 + (hash % 11);
    const isRisk = p90 >= 20 || occupancy >= 0.82;
    const priceUnit = poi.type === "加油站" ? "L" : "kWh";
    return Object.assign({}, poi, {
      source: poi.sourceLabel || (poi.id && !String(poi.id).startsWith("fallback-") ? "高德真实 POI" : "固定场景 POI"),
      occupancy,
      p50,
      p90,
      wait: Math.round((p50 + p90) / 2),
      price: simulatedPrice(poi.type, hash).toFixed(2),
      priceUnit,
      // 高德 POI 不提供充电桩额定功率或油枪流速；以下是固定种子的
      // 演示估算，用于比较不同补能方案的时长，页面会明确标识其边界。
      estimatedChargePowerKw: 75 + (hash % 11) * 15,
      estimatedRefuelRateLpm: Number((6 + (hash % 7) * 0.8).toFixed(1)),
      status: isRisk ? "forecast-risk" : "forecast-ready",
      riskLabel: isRisk ? "高峰风险" : "预测可用",
      detour: (0.3 + (hash % 12) / 10).toFixed(1)
    });
  }

  // 服务区兜底检索（keyword="服务区"）拿回来的是服务区里的各种子 POI，其中相当一部分
  // 名字就叫"加油站"。它们随后被无条件打上 type:"充电站"，于是纯电车的方案里会出现
  // 「加油站 · 补 3.2kWh」——名字本身就在说它是加油设施，却当成充电候选推给电车。
  // "补能设施待确认"那句免责说的是"有没有桩"，不是"这其实是个加油站"。
  // 一个自报家门叫加油站的点，是它没有充电桩的证据，不是中性信息，直接排除。
  const FUEL_ONLY_NAME = /加油|加气|加氢|油站/;
  const CHARGING_NAME = /充电|充换|换电|超充/;
  // 而且 keyword="服务区" 是模糊匹配，还会捞回"北京顺丰速运有限公司安华里业务部
  // 职工暖心驿站""并渡口驿站"这类根本不是服务区的点。兜底之所以站得住脚，理由
  // 只有一条——真实高速服务区通常有桩；名字里连"服务区"都没有的 POI 不在这条
  // 理由的覆盖范围内，把顺丰的员工休息室当成电车补能点纯属检索副作用。
  const SERVICE_AREA_NAME = /服务区/;

  function normalizePoi(poi, index, type) {
    const location = parseLocation(poi.location);
    if (!location) return null;
    const serviceArea = type === "service-area";
    const rawName = String(poi.name || "");
    if (serviceArea) {
      if (!SERVICE_AREA_NAME.test(rawName)) return null;
      if (FUEL_ONLY_NAME.test(rawName) && !CHARGING_NAME.test(rawName)) return null;
    }
    const rawAddress = String(poi.address || "").trim();
    // 高德对一部分服务区只返回"服务区"三个字，方案里就会出现「本次补能：服务区」——
    // 司机没法知道是哪一个。地址只到区县（"十八里店""丰台区"），所以不能拼成
    // "十八里店服务区"——那是在造一个可能并不存在的站名。放进括号里当位置限定，
    // 和高德自己给全名的那些（"苏桥服务区(京德高速北京方向)"）是同一种写法。
    const bareServiceArea = serviceArea && !rawName.replace(/服务区/g, "").trim();
    const displayName = bareServiceArea && rawAddress
      ? `服务区（${rawAddress.slice(0, 20)}）`
      : poi.name || (type === "fuel" ? "综合能源站" : serviceArea ? "高速服务区" : "充电站");
    return {
      id: poi.id || `${type}-${index}-${location.join("-")}`,
      name: displayName,
      address: rawAddress || poi.name || "沿线补能站点",
      location,
       // Energy POIs use the Chinese network labels; service searches retain
       // their semantic type so an explicit “麦当劳/咖啡/休息” action can be
       // matched and ranked without confusing a restaurant with a charger.
       type: type === "fuel" ? "加油站" : type === "electric" || serviceArea ? "充电站" : type,
      tel: poi.tel || "",
      distance: Number(poi.distance) || null,
      serviceAreaCandidate: serviceArea,
      sourceLabel: serviceArea ? "高德真实服务区 · 补能设施待确认" : undefined
    };
  }

  function dedupePois(pois) {
    const seen = new Set();
    return pois.filter((poi) => {
      const key = poi.id || `${poi.name}-${poi.location.join(",")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function fallbackSvgPoints(path) {
    const startLat = FALLBACK.origin[1];
    const endLat = FALLBACK.destination[1];
    const startLng = FALLBACK.origin[0];
    const endLng = FALLBACK.destination[0];
    return path.map(([lng, lat]) => {
      const progress = Math.max(0, Math.min(1, (startLat - lat) / (startLat - endLat)));
      const expectedLng = startLng + (endLng - startLng) * progress;
      const x = 590 + progress * 500 + (lng - expectedLng) * 2500;
      const y = 170 + progress * 560;
      return `${Math.round(x)},${Math.round(y)}`;
    }).join(" ");
  }

  function renderFallbackMap() {
    const mapElement = byId("map");
    if (!mapElement) return;
    const routePoints = fallbackSvgPoints(FALLBACK.routes[state.selectedRoute] || FALLBACK.routes.reliable);
    mapElement.innerHTML = `
      <svg class="fallback-map" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <rect width="1440" height="900" fill="#e8ece8" />
        <path class="fallback-area" d="M0 80 L370 0 L510 300 L420 530 L0 610Z" />
        <path class="fallback-area second" d="M1090 0 L1440 0 L1440 490 L1220 430 L1040 230Z" />
        <g class="fallback-roads">
          <path d="M0 170 C290 210 420 130 710 210 S1120 240 1440 160" />
          <path d="M-20 365 C250 300 440 390 660 340 S1060 290 1460 380" />
          <path d="M-10 640 C290 570 480 650 720 590 S1100 570 1460 650" />
          <path d="M250 -10 C300 170 250 330 360 480 S390 730 330 920" />
          <path d="M645 -10 C600 180 740 300 675 470 S650 720 760 920" />
          <path d="M1010 -10 C930 190 1100 290 1005 460 S1110 730 1060 920" />
          <path class="fallback-highway" d="M105 40 C350 180 470 215 650 335 S840 520 1015 660 S1150 780 1240 900" />
          <path class="fallback-road-soft" d="M35 790 C240 710 470 760 600 650 S840 460 1170 490 S1320 620 1450 560" />
        </g>
        <polyline class="fallback-route" points="${routePoints}" style="display:${state.hasPlannedRoute ? "" : "none"}" />
        <g class="fallback-labels">
          <text x="615" y="210">北京市</text><text x="515" y="320">朝阳区</text><text x="670" y="480">大兴区</text><text x="365" y="510">亦庄</text>
          <g class="fallback-destination-labels" style="display:${state.hasPlannedRoute ? "" : "none"}"><text x="1110" y="720">机场方向</text><text x="825" y="590">榆垡</text><text x="1050" y="805">大兴机场</text></g>
        </g>
        <g class="fallback-pins" style="display:${state.hasPlannedRoute ? "" : "none"}"><circle cx="625" cy="190" r="10" /><circle cx="815" cy="505" r="10" /><circle cx="960" cy="630" r="10" /></g>
      </svg>`;
  }

  function fallbackRoutes() {
    const fastestDistance = routeDistance(FALLBACK.routes.fastest);
    const reliableDistance = routeDistance(FALLBACK.routes.reliable);
    const cheapestDistance = routeDistance(FALLBACK.routes.cheapest);
    return {
      fastest: { key: "fastest", path: FALLBACK.routes.fastest, distance: fastestDistance, duration: 73, policy: "速度优先" },
      reliable: { key: "reliable", path: FALLBACK.routes.reliable, distance: reliableDistance, duration: 87, policy: "实时路况" },
      cheapest: { key: "cheapest", path: FALLBACK.routes.cheapest, distance: cheapestDistance, duration: 101, policy: "费用优先" }
    };
  }

  // 某个目标（最快/最稳/最省）的高德查询失败时，下游仍然需要三个 key 都在。
  // 用同一次行程里另一条**真实**路线顶上，并留下 policyFallbackFrom 让卡片
  // 如实说明"该策略未返回独立路线"；绝不用演示折线填这个洞。
  function fillMissingObjectivesWithRealRoutes(liveRecords, keys) {
    const donorKey = ["reliable", "fastest", "cheapest"].find((key) => liveRecords[key]) || Object.keys(liveRecords)[0];
    const filled = Object.assign({}, liveRecords);
    keys.forEach((key) => {
      if (filled[key]) return;
      filled[key] = Object.assign({}, liveRecords[donorKey], { key, policyFallbackFrom: donorKey });
    });
    return filled;
  }

  // FALLBACK.routes 是固定的北京→大兴机场演示折线。退化的高德响应绝不能用它
  // 兜底：那样会在"高德已连接"的实况地图上画出一条与本次行程无关的路线，
  // 并把它的里程/时长喂给能耗与费用模型。宁可返回 null 让上层报缺失。
  function extractDrivingRoute(route, key, policy) {
    const rawPath = route.path || (route.steps || []).flatMap((step) => step.path || []);
    const path = rawPath.map(parseLocation).filter(Boolean);
    const distanceKm = Number(route.distance) / 1000;
    const durationMinutes = Number(route.time) / 60;
    if (path.length < 2 || !(distanceKm > 0) || !(durationMinutes > 0)) return null;
    return {
      key,
      path,
      distance: distanceKm,
      duration: durationMinutes,
      tolls: Number(route.tolls) || 0,
      highway: route.highway === true,
      routeClass: route.routeClass || (route.highway === true ? "highway" : "unknown"),
      roadNames: Array.isArray(route.roadNames) ? route.roadNames.slice(0, 80) : [],
      policy
    };
  }

  function markerContent(name, risk, type, selected, role) {
    const iconName = type === "加油站" ? "fuel" : "zap";
    const classes = ["station-marker", risk ? "risk" : "", selected ? "selected" : "", role ? `operator-${role}` : ""].filter(Boolean).join(" ");
    return `<span class="${classes}" title="${String(name).replace(/"/g, "&quot;")}"><i data-lucide="${iconName}"></i></span>`;
  }

  function addFallbackMarkers() {
    state.stations = FALLBACK.stations.map(simulateStation);
    renderStationSummary();
  }

  function clearLiveOverlays() {
    if (!state.map) return;
    Object.values(state.routeOverlays).forEach((overlay) => state.map.remove(overlay));
    state.routeOverlays = {};
    clearStationOverlays();
  }

  function clearStationOverlays() {
    if (!state.map) return;
    state.stationOverlays.forEach((overlay) => state.map.remove(overlay));
    state.stationOverlays = [];
    state.stationMarkerById.clear();
  }

  function addAmapMarker(poi, station) {
    if (!state.map || !state.AMap) return null;
    const AMap = state.AMap;
    const marker = new AMap.Marker({
      position: poi.location,
      content: markerContent(poi.name, station.status === "forecast-risk", poi.type, state.selectedStation && state.selectedStation.id === station.id, station.operatorRole),
      offset: new AMap.Pixel(-15, -15),
      zIndex: station.status === "forecast-risk" ? 110 : 105,
      title: poi.name
    });
    marker.setMap(state.map);
    marker.on("click", () => selectStation(station));
    state.stationMarkerById.set(station.id, marker);
    return marker;
  }

  function addAmapEndpoints(options = {}) {
    if (!state.map || !state.AMap) return [];
    const AMap = state.AMap;
    const includeDestination = options.includeDestination === undefined
      ? state.hasPlannedRoute || Boolean(state.baseRouteRecords.reliable)
      : Boolean(options.includeDestination);
    const make = (position, className, iconName, title) => {
      const marker = new AMap.Marker({
        position,
        content: `<span class="${className}" title="${title}"><i data-lucide="${iconName}"></i></span>`,
        offset: new AMap.Pixel(-12, -12),
        zIndex: 140,
        title
      });
      marker.setMap(state.map);
      return marker;
    };
    const endpoints = [make(
      state.origin,
      "origin-marker",
      "circle-dot",
      includeDestination ? (state.originName || DEFAULT_ORIGIN_NAME) : "起点"
    )];
    state.stationOverlays.push(endpoints[0]);
    if (includeDestination && state.destination) {
      endpoints.push(make(state.destination, "destination-marker", "map-pin", state.destinationName));
      state.stationOverlays.push(endpoints[1]);
    }
    refreshIcons();
    return endpoints;
  }

  function drawAmapRoutes() {
    if (!state.map || !state.AMap) return;
    const AMap = state.AMap;
    Object.values(state.routeOverlays).forEach((overlay) => state.map.remove(overlay));
    state.routeOverlays = {};
    Object.values(state.routeRecords).forEach((record) => {
      const selected = record.key === state.selectedRoute;
      const line = new AMap.Polyline({
        path: record.path,
        strokeColor: selected ? "#4A7DF0" : "#8795A2",
        strokeWeight: selected ? 7 : 3,
        strokeOpacity: selected ? 0.98 : 0.18,
        lineJoin: "round",
        lineCap: "round",
        showDir: false,
        zIndex: selected ? 90 : 70,
        ...(selected ? {} : { strokeStyle: "dashed", strokeDasharray: [10, 10] })
      });
      line.setMap(state.map);
      state.routeOverlays[record.key] = line;
    });
    if (state.routeOverlays[state.selectedRoute] && state.routeOverlays[state.selectedRoute].bringToFront) {
      state.routeOverlays[state.selectedRoute].bringToFront();
    }
  }

  function fitAmapView() {
    if (!state.map || !state.AMap) return;
    if (state.simulation?.active) return;
    if (!state.hasPlannedRoute && !state.baseRouteRecords.reliable) {
      state.map.setZoomAndCenter(11, state.origin);
      return;
    }
    const selectedRoute = state.routeOverlays[state.selectedRoute];
    const selectedMarker = state.selectedStation ? state.stationMarkerById.get(state.selectedStation.id) : null;
    const overlays = [selectedRoute, selectedMarker].filter(Boolean);
    if (overlays.length && state.map.setFitView) {
      state.map.setFitView(overlays, false, [90, 390, 245, 410], 11);
    } else {
      state.map.setZoomAndCenter(10, [(state.origin[0] + state.destination[0]) / 2, (state.origin[1] + state.destination[1]) / 2]);
    }
  }

  function queryDrivingOnce(key, policy, station) {
    if (state.tripWaypoints.length) return queryRouteSequence(key, [], { includeTripWaypoints: true });
    return new Promise((resolve) => {
      if (!state.AMap) return resolve(null);
      try {
        const driving = new state.AMap.Driving({ policy, ferry: 1, map: null, panel: false });
        const done = (status, result) => {
          const record = status === "complete" && result && result.routes && result.routes.length
            ? extractDrivingRoute(result.routes[0], key, policy)
            : null;
          if (record) {
            delete state.routeErrors[`${key}:base`];
            resolve(record);
          } else {
            state.routeErrors[`${key}:base`] = {
              // status 为 complete 却没有 record，说明响应本身退化（无折线或零里程）。
              status: status === "complete" ? "degenerate" : status,
              info: result && (result.info || result.message || result.type) || "unknown",
              result: result ? JSON.stringify(result).slice(0, 500) : null
            };
            resolve(null);
          }
        };
        driving.search(state.origin, state.destination, done);
      } catch (error) {
        state.routeErrors[`${key}:base`] = {
          status: "exception",
          info: error?.message || "AMAP_DRIVING_EXCEPTION"
        };
        resolve(null);
      }
    });
  }

  async function queryDriving(key, policy, station) {
    if (station?.location) return queryServerRoute(key, station);
    // Prefer the server-side route adapter for the base legs. It is backed by
    // the same AMap Web Service but benefits from the shared disk cache and
    // does not depend on a just-created browser SDK callback. The SDK remains
    // a fallback for deployments where only the browser key is available.
    if (!state.tripWaypoints.length) {
      const serverRecord = await queryServerBaseRoute(key, policy);
      if (serverRecord) return serverRecord;
    }
    // The JS SDK occasionally drops a whole burst of policy requests while the
    // map session is settling. A bounded retry is safe here: it only runs after
    // a missing result, while real route failures still remain failures.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record = await queryDrivingOnce(key, policy, station);
      if (record) return record;
      if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 260));
    }
    return null;
  }

  function formatRouteCoordinate(point) {
    const longitude = Number(point?.[0]);
    const latitude = Number(point?.[1]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return "";
    return `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
  }

  // 高德的失败分两类：限流/引擎抖动（重试就能过）和密钥、配额、确实无路可走
  // （重试多少次都一样）。以前两类都只重试一次就放弃，结果一次限流就能让整条
  // 多站候选作废——上海→杭州这种 188 km 的常规行程会直接显示"未生成方案"。
  const TERMINAL_ROUTE_INFOCODES = new Set([
    "10001", "10002", "10003", "10009", "10012", // 密钥/权限/配额：重试无意义
    "20000", "20001", "20800", "20801", "20802", "20803" // 参数错误 / 确实没有可行道路
  ]);

  async function fetchRouteOnce(params) {
    const response = await fetch(`/api/route?${params}`, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      // 服务端已经把高德的 info/infocode 透传出来了，不要再退化成一个光秃秃的
      // HTTP_502："配额用尽"和"这一秒请求太密"需要完全不同的处置和话术。
      const detail = await response.json().catch(() => ({}));
      const error = new Error(detail.error || `HTTP_${response.status}`);
      error.infocode = detail.infocode ? String(detail.infocode) : null;
      throw error;
    }
    const payload = await response.json();
    const route = payload.route;
    if (!route || !Array.isArray(route.path) || route.path.length < 2) throw new Error("INVALID_ROUTE_RESPONSE");
    return { route, payload };
  }

  async function fetchRouteWithRetry(params, attempts = 3) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await fetchRouteOnce(params);
      } catch (error) {
        lastError = error;
        if (error.infocode && TERMINAL_ROUTE_INFOCODES.has(error.infocode)) break;
        if (attempt < attempts - 1) {
          // 退避 + 抖动：多条腿是被同一波限流打回来的，等长重试会再撞在一起。
          const backoff = 240 * Math.pow(2, attempt) + Math.floor(Math.random() * 160);
          await new Promise((resolve) => window.setTimeout(resolve, backoff));
        }
      }
    }
    throw lastError || new Error("ROUTE_UNAVAILABLE");
  }

  function recordRouteError(errorKey, error) {
    state.routeErrors[errorKey] = {
      status: "error",
      info: error?.message || "ROUTE_UNAVAILABLE",
      infocode: error?.infocode || null,
      // 区分"再试一次也许就好"和"这条路本来就不通"，失败文案才能说人话。
      terminal: Boolean(error?.infocode && TERMINAL_ROUTE_INFOCODES.has(error.infocode))
    };
  }

  async function queryServerRoute(key, station) {
    const params = new URLSearchParams({
      origin: formatRouteCoordinate(state.origin),
      destination: formatRouteCoordinate(state.destination),
      waypoint: formatRouteCoordinate(station.location),
      plan: key,
      cartype: isFuelActive() ? "0" : "1"
    });
    // 三条策略几乎同时发起带途经点的请求，同样会撞上高德的每秒限流。这里过去
    // 完全没有重试，一次抖动就足以让这个站点被判定为"到不了"。
    try {
      const { route, payload } = await fetchRouteWithRetry(params);
      delete state.routeErrors[`${key}:waypoint`];
      return Object.assign({}, route, { key, station: Object.assign({}, station, { source: station.source }), routeSource: payload.source });
    } catch (error) {
      recordRouteError(`${key}:waypoint`, error);
      return null;
    }
  }

  async function searchNearby(keyword, center, type) {
    const location = Array.isArray(center) ? center.join(",") : "";
    const serverType = type === "fuel"
      ? "fuel"
      : type === "electric"
        ? "electric"
        : type === "service-area"
          ? "service"
          : typeof serviceIntent.serviceSearchType === "function" ? serviceIntent.serviceSearchType(type) : null;
    if (location && serverType) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const query = { location, type: serverType };
          // For a concrete request, send the same brand/keyword to the server
          // side AMap search. The web-service key stays private, while the
          // browser no longer has to broaden “麦当劳” into an arbitrary餐厅.
          if (["meal", "coffee", "rest"].includes(serverType) && keyword) query.keyword = keyword;
          const response = await fetch(`/api/poi?${new URLSearchParams(query)}`, { headers: { Accept: "application/json" } });
          const payload = response.ok ? await response.json().catch(() => ({})) : {};
          const pois = Array.isArray(payload.pois) ? payload.pois : [];
          if (pois.length) return pois.map((poi, index) => normalizePoi(poi, index, type)).filter(Boolean);

          // AMap may answer with 10021 (CUQPS) while the HTTP request itself
          // is still 200 because POI enrichment is optional. Retry only this
          // transient class so later corridor samples are not lost.
          const infocode = String(payload.infocode || "");
          const warning = String(payload.warning || "");
          const retryable = response.status === 429
            || ["10021", "10022", "10023", "10024"].includes(infocode)
            || /QPS|频率|rate.?limit|too many/i.test(warning);
          if (!retryable || attempt >= 2) break;
          await new Promise((resolve) => window.setTimeout(resolve, 420 * (attempt + 1)));
        } catch {
          // Fall through to the JS map SDK. A failed POI lookup must not turn a
          // valid map/routing session into a fake result.
          break;
        }
      }
    }
    return new Promise((resolve) => {
      if (!state.AMap) return resolve([]);
      const placeSearch = new state.AMap.PlaceSearch({
        pageSize: 20,
        pageIndex: 1,
        map: null,
        autoFitView: false
      });
      placeSearch.searchNearBy(keyword, center, 30000, (status, result) => {
        if (status === "complete" && result && result.poiList && Array.isArray(result.poiList.pois)) {
          resolve(result.poiList.pois.map((poi, index) => normalizePoi(poi, index, type)).filter(Boolean));
        } else {
          resolve([]);
        }
      });
    });
  }

  function buildPathMetrics(path) {
    if (!Array.isArray(path) || path.length < 2) return { lengths: [], total: 0 };
    const lengths = [];
    let total = 0;
    for (let index = 1; index < path.length; index += 1) {
      total += distanceKm(path[index - 1], path[index]);
      lengths.push(total);
    }
    return { lengths, total };
  }

  function pointAtPathProgress(path, progress, metrics = null) {
    if (!Array.isArray(path) || !path.length) return null;
    if (path.length === 1) return path[0];
    const target = Math.max(0, Math.min(1, Number(progress) || 0));
    const cached = metrics && Array.isArray(metrics.lengths) && metrics.lengths.length === path.length - 1 ? metrics : buildPathMetrics(path);
    const lengths = cached.lengths;
    const total = cached.total;
    if (!total) return path[Math.round(target * (path.length - 1))];
    const desired = target * total;
    const segmentIndex = lengths.findIndex((length) => length >= desired);
    const index = segmentIndex < 0 ? path.length - 1 : segmentIndex + 1;
    const previous = path[Math.max(0, index - 1)];
    const next = path[index];
    const segmentStart = index <= 1 ? 0 : lengths[index - 2];
    const segmentLength = Math.max(0.0001, lengths[index - 1] - segmentStart);
    const fraction = Math.max(0, Math.min(1, (desired - segmentStart) / segmentLength));
    return [previous[0] + (next[0] - previous[0]) * fraction, previous[1] + (next[1] - previous[1]) * fraction];
  }

  function stationSearchCenters(path, totalDistanceKm) {
    if (!Array.isArray(path) || path.length < 2) return [];
    const profile = getEnergyProfile(isFuelActive());
    const fullRange = profile.capacity / profile.consumptionPerKm;
    const spacingKm = Math.max(55, Math.min(120, Math.round(fullRange * 0.45)));
    const routeDistanceKm = Math.max(0, Number(totalDistanceKm) || routeDistance(path));
    const count = Math.max(3, Math.min(12, Math.ceil(routeDistanceKm / spacingKm) + 1));
    return Array.from({ length: count }, (_, index) => pointAtPathProgress(path, index / Math.max(1, count - 1))).filter(Boolean);
  }

  function stationRouteMetrics(station, route) {
    const path = Array.isArray(route?.path) ? route.path : [];
    const distance = Math.max(0, Number(route?.distance) || routeDistance(path));
    if (!path.length) {
      return { routeProgress: 0, progressKm: 0, corridorKm: Infinity, detourKm: Infinity, detour: "" };
    }
    const progress = routeProgress(station.location, path);
    const corridorKm = nearestPointDistance(station.location, path);
    const detourKm = Number(Math.max(0.4, corridorKm * 2 + 0.3).toFixed(1));
    return {
      routeProgress: Number(progress.toFixed(4)),
      progressKm: Number((progress * distance).toFixed(1)),
      corridorKm: Number(corridorKm.toFixed(1)),
      detourKm,
      detour: detourKm.toString()
    };
  }

  async function searchInBatches(tasks, batchSize = 1, gapMs = 220) {
    const results = [];
    for (let index = 0; index < tasks.length; index += batchSize) {
      const batch = tasks.slice(index, index + batchSize);
      const settled = await Promise.all(batch.map((task) => task()));
      results.push(...settled);
      // The AMap Web Service quota is per-second. Keep corridor searches
      // serial with a short gap so a long trip cannot lose its later samples
      // to a CUQPS response.
      if (index + batchSize < tasks.length && gapMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, gapMs));
      }
    }
    return results;
  }

  async function queryStations() {
    if (!state.AMap) return;
    state.provisionalCorridorActive = false;
    state.stationForecastScenarioKey = null;
    state.stationForecastRequestVersion += 1;
    const routeContexts = ["reliable", "cheapest"]
      .map((key) => ({ key, route: corridorReferenceRoute(key) }))
      .filter(({ route }) => Array.isArray(route?.path) && route.path.length > 1);
    const primaryDistanceKm = Math.max(0, Number(routeContexts[0]?.route?.distance) || 0);
    // On short trips the three AMap policies normally share one corridor; do
    // not spend another POI-search batch just to prove that. Alternate
    // corridors matter on intercity trips, where the zero-toll route can leave
    // the motorway entirely.
    const searchAlternateCorridors = primaryDistanceKm >= 120;
    const distinctContexts = [];
    routeContexts.forEach((context) => {
      if (context.key !== "reliable" && !searchAlternateCorridors) return;
      const signature = routeDisplayIdentity(context.route);
      if (!distinctContexts.some((known) => routeDisplayIdentity(known.route) === signature)
        && !distinctContexts.some((known) => !routeCorridorDiffers(context.route, known.route))) {
        distinctContexts.push(context);
      }
    });
    const primaryContext = distinctContexts.find((context) => context.key === "reliable")
      || distinctContexts[0]
      || { key: "reliable", route: corridorReferenceRoute("reliable") };
    const route = primaryContext.route;
    const path = route.path;
    // A hybrid can refuel or recharge, so both networks are searched and the
    // per-branch filters downstream decide which candidates each plan may use.
    const networks = isHybrid()
      ? [{ keyword: "充电站", type: "electric" }, { keyword: "加油站", type: "fuel" }]
      : [isFuelActive() ? { keyword: "加油站", type: "fuel" } : { keyword: "充电站", type: "electric" }];
    const stationTasks = distinctContexts.flatMap((context) => {
      const allCenters = stationSearchCenters(context.route.path, context.route.distance);
      const centerCount = context.key === primaryContext.key ? allCenters.length : Math.min(6, allCenters.length);
      const centers = allCenters.filter((center, index) => {
        if (centerCount >= allCenters.length) return true;
        const targetIndex = Math.round(index * (allCenters.length - 1) / Math.max(1, centerCount - 1));
        return index === targetIndex;
      });
      return centers.flatMap((center) => networks.map((network) => async () => {
        const set = await searchNearby(network.keyword, center, network.type);
        // Many cross-province motorway points have no POI explicitly named
        // “充电站”. Only then issue the service-area fallback; scheduling it
        // unconditionally doubled every long-trip POI request and caused
        // later corridor samples to hit AMap's CUQPS limit.
        if (network.type === "electric" && !set.length) {
          return {
            routeKey: context.key,
            set: await searchNearby("服务区", center, "service-area")
          };
        }
        return { routeKey: context.key, set };
      }));
    });
    const resultSets = await searchInBatches(stationTasks);
    // Keep a small, even sample from every point along the route rather than
    // filling the candidate pool with the first cities near the origin. This
    // matters for cross-province itineraries where the last third otherwise
    // never reaches the long-trip planner.
    const stagedPois = [];
    resultSets.forEach((result) => {
      dedupePois(result?.set || []).slice(0, 3).forEach((poi) => stagedPois.push(poi));
    });
    const corridorPois = dedupePois(stagedPois).filter((poi) => distinctContexts.some((context) => (
      nearestPointDistance(poi.location, context.route.path) < 22
    )));
    // Keep a bounded sample from every materially different corridor. Without
    // this, the reliable route's POIs fill the 36-item cap before the separate
    // zero-toll route reaches the long-trip planner.
    const corridorBalanced = distinctContexts.flatMap((context) => {
      const routePois = corridorPois
        .filter((poi) => nearestPointDistance(poi.location, context.route.path) < 22)
        .sort((a, b) => routeProgress(a.location, context.route.path) - routeProgress(b.location, context.route.path));
      return routePois.slice(0, Math.max(12, Math.ceil(36 / Math.max(1, distinctContexts.length))));
    });
    // 混动要同时保留油、电两张网。直接截断会让排在后面的那张网被整体切掉，
    // 所以按站点类型交替取样，再统一放宽上限。
    const selected = takeBalancedByType(
      dedupePois(corridorBalanced.concat(corridorPois)),
      isHybrid() ? 48 : 36
    );
    state.stations = selected.map((poi, index) => {
      const station = simulateStation(poi, index);
      const routeMetricsByPolicy = Object.fromEntries(distinctContexts.map((context) => [
        context.key,
        stationRouteMetrics(station, context.route)
      ]));
      return Object.assign(station, routeMetricsByPolicy[primaryContext.key] || stationRouteMetrics(station, route), {
        routeMetricsByPolicy
      });
    });
    renderStationSummary();
    clearStationOverlays();
    addAmapEndpoints();
    const displayCandidates = state.stations.filter((station) => {
      const awayFromOrigin = distanceKm(station.location, state.origin) > 1.2;
      const awayFromDestination = distanceKm(station.location, state.destination) > 0.8;
      return awayFromOrigin && awayFromDestination;
    });
    const markerCount = Math.max(4, Math.min(7, Math.ceil((Number(route.distance) || routeDistance(path)) / 130) + 2));
    const targets = Array.from({ length: markerCount }, (_, index) => (index + 1) / (markerCount + 1));
    const displayStations = [];
    targets.forEach((target) => {
      const candidate = displayCandidates
        .slice()
        .sort((a, b) => Math.abs(routeProgress(a.location, path) - target) - Math.abs(routeProgress(b.location, path) - target))
        .find((station) => !displayStations.some((selected) => selected.id === station.id));
      if (candidate) displayStations.push(candidate);
    });
    displayStations.forEach((station) => {
      const marker = addAmapMarker(station, station);
      if (marker) state.stationOverlays.push(marker);
    });
    refreshIcons();
  }

  function renderFallbackRouteVisuals() {
    const mapElement = byId("map");
    if (!mapElement || !mapElement.querySelector(".fallback-route")) return;
    const route = state.routeRecords[state.selectedRoute] || state.routeRecords.reliable;
    const line = mapElement.querySelector(".fallback-route");
    const pins = mapElement.querySelector(".fallback-pins");
    const destinationLabels = mapElement.querySelector(".fallback-destination-labels");
    const visible = Boolean(state.hasPlannedRoute && route);
    line.style.display = visible ? "" : "none";
    if (pins) pins.style.display = visible ? "" : "none";
    if (destinationLabels) destinationLabels.style.display = visible ? "" : "none";
    if (!visible) return;
    line.setAttribute("data-route", state.selectedRoute);
    line.setAttribute("points", fallbackSvgPoints(route.path));
  }

  function chooseStationForRoute(routeKey) {
    return chooseStationForRouteExcluding(routeKey, new Set());
  }

  // 按 type 轮转取样，保持各网络原有的沿线顺序。单一网络时等价于 slice(0, limit)。
  function takeBalancedByType(pois, limit) {
    const buckets = new Map();
    pois.forEach((poi) => {
      const key = poi.type || "unknown";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(poi);
    });
    if (buckets.size <= 1) return pois.slice(0, limit);
    const queues = Array.from(buckets.values());
    const picked = [];
    let cursor = 0;
    while (picked.length < limit && queues.some((queue) => queue.length)) {
      const queue = queues[cursor % queues.length];
      if (queue.length) picked.push(queue.shift());
      cursor += 1;
    }
    return picked;
  }

  function chooseStationForRouteExcluding(routeKey, excludedIds) {
    const route = state.routeRecords[routeKey] || state.routeRecords.reliable;
    if (!route || !state.stations.length) return null;
    const direct = directEnergyState(state.baseRouteRecords[routeKey] || route, isFuelActive());
    if (direct.canDirect) return null;
    const desiredType = isFuelActive() ? "加油站" : "充电站";
    const candidates = state.stations.filter((station) => {
      if (station.type !== desiredType || excludedIds.has(station.id)) return false;
      return estimateStationApproachKm(station) <= direct.maxSafeFirstLegKm + 0.5
        && estimateStationDetourKm(station) <= state.maxDetourKm + 0.5;
    });
    const targetProgress = { fastest: 0.38, reliable: 0.62, cheapest: 0.84 }[routeKey] || 0.62;
    const sorted = candidates.slice().sort((a, b) => {
      const routeScore = (station) => {
        const corridor = nearestPointDistance(station.location, route.path);
        const progress = Math.abs(routeProgress(station.location, route.path) - targetProgress);
        const approach = estimateStationApproachKm(station);
        // Below 12% this is a rescue decision, not an optimisation decision:
        // choose the closest safe station first. Route policy is only a tie
        // breaker, so all route cards may legitimately use the same nearby POI.
        if (state.energyPercent <= 12) return approach * 100 + corridor * 4 + Number(station.p90 || 0) * 0.1 + progress;
        const rescueBias = approach * 0.15;
        if (routeKey === "fastest") return corridor * 1.7 + progress * 5 + station.p50 * 0.18 + rescueBias;
        // ¥/L and ¥/kWh are different magnitudes. Score on cost per kilometre so
        // the price term keeps the same weight on both energy paths.
        if (routeKey === "cheapest") return corridor * 0.8 + progress * 1.5 + stationCostPerKm(station) * 190 + station.p90 * 0.015 + rescueBias;
        return corridor * 0.9 + station.p90 * 1.15 + station.occupancy * 5 + progress * 1.5 + rescueBias;
      };
      const scoreA = routeScore(a);
      const scoreB = routeScore(b);
      return scoreA - scoreB;
    });
    return sorted[0] || null;
  }

  async function queryServerLeg(key, origin, destination) {
    const params = new URLSearchParams({
      origin: formatRouteCoordinate(origin),
      destination: formatRouteCoordinate(destination),
      plan: key,
      cartype: isFuelActive() ? "0" : "1"
    });
    // Long trips require several independent road requests, and AMap throttles
    // per second, so a burst of legs can bounce with a transient 502. Retrying
    // never converts a failed request into a route; only a complete, valid
    // response is accepted, and a terminal infocode stops the retries at once.
    try {
      const { route } = await fetchRouteWithRetry(params);
      return route;
    } catch (error) {
      recordRouteError(`${key}:long-trip`, error);
      return null;
    }
  }

  function routeStopsWithTripWaypoints(stops = [], includeTripWaypoints = true, routeKey = "reliable") {
    const corridor = corridorReferenceRoute(routeKey);
    const baseStops = (Array.isArray(stops) ? stops : []).map((stop, index) => Object.assign({}, stop, {
      routeProgress: Number.isFinite(Number(stop?.routeProgress))
        ? Number(stop.routeProgress)
        : routeProgress(stop.location, corridor.path),
      _routeOrder: index
    }));
    if (!includeTripWaypoints || !state.tripWaypoints.length) {
      return baseStops.sort((a, b) => a.routeProgress - b.routeProgress || a._routeOrder - b._routeOrder);
    }
    const waypoints = state.tripWaypoints.map((waypoint, index) => Object.assign({}, waypoint, {
      kind: "waypoint",
      userOrder: Number.isFinite(Number(waypoint.userOrder)) ? Number(waypoint.userOrder) : index,
      routeProgress: routeProgress(waypoint.location, corridor.path),
      _routeOrder: -1000 + index
    }));
    return baseStops.concat(waypoints).sort((a, b) => {
      if (a.kind === "waypoint" && b.kind === "waypoint") return a.userOrder - b.userOrder;
      return a.routeProgress - b.routeProgress || a._routeOrder - b._routeOrder;
    });
  }

  // A policy can return the same physical road corridor as another policy. Keep
  // a stable identity for that corridor so objective labels can overlap instead
  // of inventing a second route only to make the cards look different.
  function routeIdentity(route, stops = []) {
    const path = Array.isArray(route?.path) ? route.path : [];
    const sample = [path[0], path[Math.floor(path.length / 2)], path.at(-1)]
      .map((point) => {
        const parsed = parseLocation(point);
        return parsed ? `${Number(parsed[0]).toFixed(4)},${Number(parsed[1]).toFixed(4)}` : "";
      })
      .join("|");
    const stopList = Array.isArray(stops) && stops.length ? stops : (route?.waypoints || []);
    const stopIdentity = stopList
      .map((stop) => stop?.id || `${Number(stop?.location?.[0]).toFixed(4)},${Number(stop?.location?.[1]).toFixed(4)}`)
      .join(",");
    return [
      Number(route?.distance || 0).toFixed(1),
      Number(route?.duration || 0).toFixed(1),
      Number(route?.tolls || 0).toFixed(1),
      sample,
      stopIdentity
    ].join(";");
  }

  function routeCorridorDiffers(left, right) {
    if (!left || !right) return false;
    const leftPath = Array.isArray(left.path) ? left.path : [];
    const rightPath = Array.isArray(right.path) ? right.path : [];
    if (leftPath.length < 2 || rightPath.length < 2) {
      return Math.abs(Number(left.distance || 0) - Number(right.distance || 0)) > 20
        || Math.abs(Number(left.tolls || 0) - Number(right.tolls || 0)) > 20;
    }
    const separation = [0.2, 0.4, 0.6, 0.8].reduce((total, ratio) => {
      const point = pointAtPathProgress(leftPath, ratio);
      return total + (point ? nearestPointDistance(point, rightPath) : 0);
    }, 0) / 4;
    return separation > 12
      || Math.abs(Number(left.distance || 0) - Number(right.distance || 0)) > 20
      || Math.abs(Number(left.tolls || 0) - Number(right.tolls || 0)) > 20;
  }

  // The three objective calculations can legitimately land on the same
  // physical corridor. Keep the full records internally (other parts of the
  // page still use the objective aliases), but use a geometry/stop signature
  // for the cards so we do not present the same trip three times.
  //
  // Do not use only three points from routeIdentity here. A highway route and
  // a no-toll national-road route can share the same origin, destination and
  // even the same broad midpoint while taking very different corridors. The
  // old signature also dropped distance, so those genuinely different
  // choices were incorrectly merged into one visible card.
  function routeDisplayIdentity(record) {
    const path = Array.isArray(record?.path) ? record.path : [];
    const ratios = [0, 0.14, 0.28, 0.42, 0.58, 0.72, 0.86, 1];
    const geometry = path.length
      ? ratios.map((ratio) => {
        const point = parseLocation(path[Math.min(path.length - 1, Math.round((path.length - 1) * ratio))]);
        if (!point) return "";
        // About 1 km buckets make small AMap ramp/shape differences merge,
        // while retaining a detour onto a different road corridor.
        return `${Number(point[0]).toFixed(2)},${Number(point[1]).toFixed(2)}`;
      }).join("|")
      : "";
    const stops = Array.isArray(record?.stops) && record.stops.length
      ? record.stops
      : Array.isArray(record?.waypoints) && record.waypoints.length
        ? record.waypoints
        : record?.station ? [record.station] : [];
    const stopIdentity = stops.map((stop) => {
      if (stop?.id) return String(stop.id);
      const point = parseLocation(stop?.location);
      return point ? `${Number(point[0]).toFixed(2)},${Number(point[1]).toFixed(2)}` : "";
    }).join(",");
    if (geometry) {
      // Keep distance in the signature, but not duration/tolls: the latter
      // can change between AMap objective policies on the same physical road.
      return `${Math.round(Number(record?.distance || 0))};${geometry};${stopIdentity}`;
    }
    const identity = String(record?.routeIdentity || "");
    return identity || `key:${record?.key || "unknown"}`;
  }

  function buildRouteDisplayGroups(records = {}) {
    const order = ["fastest", "reliable", "cheapest"];
    const groups = [];
    order.forEach((key) => {
      const record = records[key];
      if (!record) return;
      const identity = routeDisplayIdentity(record);
      const existing = groups.find((candidate) => candidate.identity === identity);
      if (existing) {
        existing.keys.push(key);
      } else {
        groups.push({ identity, keys: [key], representative: key });
      }
    });
    const preferred = [state.recommendedRoute, "reliable", "fastest", "cheapest"].filter(Boolean);
    groups.forEach((group) => {
      // A route identity can be shared by objective aliases whose feasibility
      // flags were calculated at different stages. Prefer a feasible alias for
      // the visible card so its heading, badge and card body cannot disagree.
      const feasiblePreferred = preferred.find((key) => group.keys.includes(key) && records[key]?.feasible);
      group.representative = feasiblePreferred
        || preferred.find((key) => group.keys.includes(key))
        || group.keys[0];
    });
    return groups;
  }

  async function queryRouteSequence(key, stops, options = {}) {
    const routeStops = routeStopsWithTripWaypoints(stops, options.includeTripWaypoints !== false, key);
    const locations = [state.origin].concat(routeStops.map((station) => station.location), [state.destination]);
    // Keep a small amount of concurrency instead of sending every long-trip
    // leg at once. This avoids transient route-service throttling while still
    // keeping multi-stop planning responsive.
    const destinations = locations.slice(1);
    const legs = [];
    for (let index = 0; index < destinations.length; index += 2) {
      const batch = await Promise.all(destinations.slice(index, index + 2).map((destination, offset) => {
        const originIndex = index + offset;
        return queryServerLeg(key, locations[originIndex], destination);
      }));
      legs.push(...batch);
    }
    if (legs.some((leg) => !leg)) return null;
    const path = legs.flatMap((leg, index) => index ? leg.path.slice(1) : leg.path);
    return {
      key,
      path,
      legs,
      waypoints: routeStops,
      viaWaypoints: routeStops.filter((stop) => stop.kind === "waypoint"),
      distance: legs.reduce((sum, leg) => sum + Number(leg.distance || 0), 0),
      duration: legs.reduce((sum, leg) => sum + Number(leg.duration || 0), 0),
      tolls: legs.reduce((sum, leg) => sum + Number(leg.tolls || 0), 0),
      highway: legs.some((leg) => leg?.highway === true),
      routeClass: legs.some((leg) => leg?.highway === true) ? "highway" : "unknown",
      roadNames: Array.from(new Set(legs.flatMap((leg) => Array.isArray(leg?.roadNames) ? leg.roadNames : []))).slice(0, 80),
      source: "高德逐段路线核验"
    };
  }

  // The branch is passed explicitly because the 油电对比 has to price a path the
  // planner is *not* currently on; defaulting to the live branch would make both
  // sides of the comparison use the same refuelling physics.
  function energyFillMinutes(amount, station, isFuel = isFuelActive()) {
    if (amount <= 1e-6) return 0;
    if (isFuel) {
      const rate = Math.max(3, Math.min(16, Number(station?.estimatedRefuelRateLpm) || 8));
      return Math.max(4, Math.ceil(amount / rate + 2));
    }
    const power = Math.max(50, Math.min(300, Number(station?.estimatedChargePowerKw) || 110));
    return Math.max(4, Math.ceil(amount / power * 60 + 3));
  }

  function longTripChargeMinutes(amount, station) {
    return energyFillMinutes(amount, station, isFuelActive());
  }

  function effectiveLongTripDetourLimit(baseRoute) {
    if (state.detourExplicit) return state.maxDetourKm;
    const baseDistanceKm = Math.max(0, Number(baseRoute?.distance || 0));
    // 8 km 适合市内行程，或用户明确要求了绕行上限的行程（detourExplicit）。
    // 城际行程不一样：能停的地方几乎只有高速服务区，而服务区是分方向建的，
    // 进出一次常常要多跑十几到二十几公里——得开到下一个互通才能掉头回来。
    // 原来只有 1.5% 的比例项，要到 533 km 以上才够得着 8 km，等于在 190–530 km
    // 这一整段把所有真实可用的服务区都判出局：上海→杭州 188 km 唯一能到的
    // 南湖服务区实测绕行 23.5 km，于是三条策略全部"无方案"。
    // 30 km 的上限本来就是这个函数认可的绕行天花板，这里只是让城际行程真的
    // 够得到它。绕行公里数会原样显示在路线卡片和验证页，由用户自己判断值不值。
    const intercityFloorKm = baseDistanceKm >= 120 ? 25 : 0;
    return Math.max(state.maxDetourKm, Math.min(30, Math.max(intercityFloorKm, baseDistanceKm * 0.015)));
  }

  // The forecast panel keeps a full 30--240 minute point series for every
  // visible station. That is useful in the browser, but sending those series
  // back to /api/longtrip can turn a national corridor request into hundreds
  // of kilobytes and hit the server's request-size guard before the planner
  // runs. The server regenerates the same deterministic forecast from these
  // scalar inputs, so the planning request must carry the station geometry and
  // model inputs only. In particular, do not drop progressKm/routeProgress or
  // provisionalCorridor: the former orders the sequence and the latter keeps
  // the explicit fallback boundary intact when the route is revalidated.
  function compactLongTripStation(station = {}, routeKey = null) {
    const snapshot = station.forecastInputSnapshot && typeof station.forecastInputSnapshot === "object"
      ? station.forecastInputSnapshot
      : {};
    const routeMetrics = routeKey && station.routeMetricsByPolicy && typeof station.routeMetricsByPolicy === "object"
      ? station.routeMetricsByPolicy[routeKey]
      : null;
    const fields = [
      "id", "name", "type", "location", "address", "source", "sourceLabel", "stationSource",
      "progressKm", "routeProgress", "detourKm", "detour", "price", "wait", "p50", "p90",
      "occupancy", "capacity", "arrivalRate", "serviceRate", "trend",
      "estimatedChargePowerKw", "estimatedRefuelRateLpm", "paymentExitMinutes", "arrivalOffsetMinutes", "arrivalMinute",
      "arrivalAtMinutes", "provisionalCorridor", "serviceAreaCandidate",
      "totalPorts", "idlePorts", "availablePorts", "reservedPorts", "chargingPorts", "faultPorts",
      "waitingVehicles", "queueVehicles", "reservationQueueAhead", "averageSessionMinutes",
      "estimatedReleaseMinutes", "snapshotTime", "dataSource", "availabilitySource", "queueSource",
      "freshnessSeconds"
    ];
    const compact = {};
    fields.forEach((key) => {
      const routeValue = routeMetrics && ["progressKm", "routeProgress", "detourKm", "detour"].includes(key)
        ? routeMetrics[key]
        : undefined;
      const value = routeValue !== undefined
        ? routeValue
        : station[key] === undefined || station[key] === null
        ? snapshot[key]
        : station[key];
      if (value === undefined || value === null) return;
      if (Array.isArray(value)) {
        const maxLength = key === "estimatedReleaseMinutes" ? 16 : 4;
        if (value.length <= maxLength && value.every((item) => Number.isFinite(Number(item)))) {
          compact[key] = value.map(Number);
        }
        return;
      }
      if (["id", "name", "type", "address", "source", "sourceLabel", "stationSource", "dataSource", "availabilitySource", "queueSource", "snapshotTime"].includes(key)) {
        compact[key] = String(value).slice(0, 180);
        return;
      }
      if (typeof value === "boolean") {
        compact[key] = value;
        return;
      }
      const numeric = Number(value);
      if (Number.isFinite(numeric)) compact[key] = numeric;
    });
    return compact;
  }

  // 界面上凡是要说"绕行上限是多少"的地方，都必须说这条路线真正被校验时用的那个
  // 数：城际行程放宽后仍然写 state.maxDetourKm，就是在用一个没生效的约束解释结果。
  function activeDetourLimitKm(record) {
    const limit = Number(record?.detourLimitKm);
    return Number.isFinite(limit) ? Number(limit.toFixed(1)) : state.maxDetourKm;
  }

  function longTripStopBudget(baseRoute) {
    const profile = getEnergyProfile(isFuelActive());
    const distanceKm = Math.max(0, Number(baseRoute?.distance || 0));
    const targetReserve = effectiveArrivalReserveSoc(profile);
    const safetyEnergy = profile.capacity * profile.safetyReservePercent / 100;
    const startEnergy = profile.capacity * state.energyPercent / 100;
    const initialSafeRange = Math.max(0, startEnergy - safetyEnergy) / profile.consumptionPerKm;
    const fullSafeRange = Math.max(0.001, profile.capacity - safetyEnergy) / profile.consumptionPerKm;
    const finalLegRange = Math.max(0, profile.capacity - profile.capacity * targetReserve / 100) / profile.consumptionPerKm;
    if (distanceKm <= initialSafeRange + 1e-6) return { minimumStops: 0, maxStops: ADAPTIVE_LONG_TRIP_MAX_STOPS, adaptiveMaxStops: true };
    const remainingAfterFirstAndFinal = distanceKm - initialSafeRange - finalLegRange;
    const minimumStops = remainingAfterFirstAndFinal <= 1e-6
      ? 1
      : Math.ceil(remainingAfterFirstAndFinal / fullSafeRange) + 1;
    // Long-trip mode is adaptive, but deliberately bounded. Twelve stops is
    // enough for the long-route demo while keeping real AMap segment calls
    // predictable (each additional stop adds another verified leg).
    return { minimumStops, maxStops: ADAPTIVE_LONG_TRIP_MAX_STOPS, adaptiveMaxStops: true };
  }

  function buildValidatedLongTripRecord(key, baseRoute, route, waypoints, servicePlan = null) {
    const profile = getEnergyProfile(isFuelActive());
    const targetArrivalSoc = effectiveArrivalReserveSoc(profile);
    const targetEnergy = profile.capacity * targetArrivalSoc / 100;
    const safetyEnergy = profile.capacity * profile.safetyReservePercent / 100;
    const legs = route.legs || [];
    if (legs.length !== waypoints.length + 1) return null;
    let energy = profile.capacity * state.energyPercent / 100;
    let totalAmount = 0;
    let chargeMinutes = 0;
    let p50Wait = 0;
    let waitVariance = 0;
    let energyCost = 0;
    let elapsedMinutes = 0;
    let paymentExitMinutesTotal = 0;
    const stops = [];
    for (let index = 0; index < waypoints.length; index += 1) {
      const waypoint = waypoints[index];
      const legDistance = Number(legs[index].distance || 0);
      elapsedMinutes += Number(legs[index].duration || 0);
      energy -= legDistance * profile.consumptionPerKm;
      if (waypoint.kind === "service") {
        elapsedMinutes += Math.max(0, Number(waypoint.durationMinutes || 0));
        continue;
      }
      if (waypoint.kind === "waypoint") continue;
      const energyWaypoint = waypoint.kind === "energy" || !waypoint.kind;
      if (!energyWaypoint) continue;
      const station = waypoint;
      const canReachStation = energy >= safetyEnergy - 1e-6;
      const nextEnergyIndex = waypoints.findIndex((candidate, candidateIndex) => candidateIndex > index && (candidate.kind === "energy" || !candidate.kind));
      const endLegIndex = nextEnergyIndex < 0 ? legs.length : nextEnergyIndex + 1;
      const travelToNextEnergyOrDestination = legs.slice(index + 1, endLegIndex).reduce((sum, leg) => sum + Number(leg.distance || 0), 0);
      const neededAfterStop = travelToNextEnergyOrDestination * profile.consumptionPerKm + (nextEnergyIndex < 0 ? targetEnergy : safetyEnergy);
      const capacityAvailable = Math.max(0, profile.capacity - Math.max(0, energy));
      const requestedAmount = Math.max(0, (neededAfterStop - energy) / profile.transferEfficiency);
      let amount = canReachStation ? Math.min(requestedAmount, capacityAvailable / profile.transferEfficiency) : 0;
      // When the current station is cheaper than every downstream stop, buy
      // more here (within capacity) and avoid the later, higher simulated
      // price. This is the energy-side part of the lowest-cost strategy.
      const laterEnergyStops = waypoints.slice(index + 1).filter((candidate) => candidate.kind === "energy" || !candidate.kind);
      const currentPrice = Math.max(0, Number(station.price || 0));
      const laterLowestPrice = Math.min(...laterEnergyStops.map((candidate) => Math.max(0, Number(candidate.price || 0))), Infinity);
      if (key === "cheapest" && laterEnergyStops.length && currentPrice > 0 && currentPrice < laterLowestPrice) {
        amount = Math.max(amount, capacityAvailable / profile.transferEfficiency);
      }
      const targetMetAtStop = energy + amount * profile.transferEfficiency >= neededAfterStop - 1e-6;
      const arrivalSoc = Math.max(0, Math.min(100, energy / profile.capacity * 100));
      energy += amount * profile.transferEfficiency;
      const stationChargeMinutes = longTripChargeMinutes(amount, station);
      const stationPaymentExitMinutes = paymentExitMinutesFor(isFuelActive() ? "fuel" : "electric", station);
      totalAmount += amount;
      chargeMinutes += stationChargeMinutes;
      paymentExitMinutesTotal += stationPaymentExitMinutes;
      // 0 is a valid no-queue observation; using `p50 || wait` would silently
      // replace it with the fallback wait. Also keep P90 monotonic when an
      // upstream/demo row is malformed.
      const rawP50Value = Number(station.p50);
      const rawP90Value = Number(station.p90);
      const rawWaitValue = Number(station.wait);
      const rawP50 = Math.max(0, Number.isFinite(rawP50Value) ? rawP50Value : Number.isFinite(rawWaitValue) ? rawWaitValue : 0);
      const rawP90 = Math.max(0, Number.isFinite(rawP90Value) ? rawP90Value : Number.isFinite(rawWaitValue) ? rawWaitValue : 0);
      const plannedP50 = rawP50;
      const plannedP90 = Math.max(plannedP50, rawP90);
      p50Wait += plannedP50;
      // 分位数不可加。各站 P90 直接相加，等于假定这一路每个补能点都同时踩中
      // 各自最差的那 10%——四站独立发生的概率是万分之一，而卡片上印的
      // "总排队 P90" 正是这个数。按独立性卷积：由每站 p50/p90 反解标准差，
      // 方差相加后再还原成 P90；只停一次时退化为该站原始 P90。
      const sigma = Math.max(0, (plannedP90 - plannedP50) / Z90);
      waitVariance += sigma * sigma;
      energyCost += amount * Math.max(0, Number(station.price || 0));
      stops.push(Object.assign({}, station, {
        sequence: stops.length + 1,
        legDistanceKm: Number(legDistance.toFixed(1)),
        arrivalSoc: Number(arrivalSoc.toFixed(1)),
        targetSoc: Number((energy / profile.capacity * 100).toFixed(1)),
        energyAmount: Number(amount.toFixed(1)),
        chargeMinutes: stationChargeMinutes,
        paymentExitMinutes: stationPaymentExitMinutes,
        stopMinutesP50: Number((plannedP50 + stationChargeMinutes + stationPaymentExitMinutes).toFixed(1)),
        stopMinutesP90: Number((plannedP90 + stationChargeMinutes + stationPaymentExitMinutes).toFixed(1)),
        arrivalMinute: Math.round(state.departureMinutes + elapsedMinutes),
        canReachStation,
        targetMetAtStop,
        energyCost: Number((amount * currentPrice).toFixed(1)),
        plannedP50: Number(plannedP50.toFixed(1)),
        plannedP90: Number(plannedP90.toFixed(1))
      }));
      elapsedMinutes += plannedP50 + stationChargeMinutes + stationPaymentExitMinutes;
      if (!canReachStation || !targetMetAtStop) break;
    }
    const p90Wait = p50Wait + Z90 * Math.sqrt(waitVariance);
    const finalLeg = Number(legs.at(-1)?.distance || 0);
    energy -= finalLeg * profile.consumptionPerKm;
    const arrivalSoc = Math.max(0, Math.min(100, energy / profile.capacity * 100));
    const detour = Math.max(0, Number(route.distance || 0) - Number(baseRoute?.distance || 0));
    const detourLimitKm = effectiveLongTripDetourLimit(baseRoute);
    const detourWithinLimit = detour <= detourLimitKm + 1e-6;
    const energyWaypointCount = waypoints.filter((waypoint) => waypoint.kind === "energy" || !waypoint.kind).length;
    const canReachAllStops = stops.length === energyWaypointCount && stops.every((stop) => stop.canReachStation && stop.targetMetAtStop);
    const targetSocMet = energy >= targetEnergy - 1e-6;
    const wait = Math.round(p50Wait);
    const serviceMinutes = Math.max(0, Number(servicePlan?.durationMinutes || 0));
    const overlapMinutes = servicePlan?.inlineStationId
      ? Math.min(serviceMinutes, Math.max(0, (stops.find((stop) => stop.id === servicePlan.inlineStationId)?.chargeMinutes || 0) + (stops.find((stop) => stop.id === servicePlan.inlineStationId)?.p50 || 0)))
      : 0;
    const serviceExtraMinutes = Math.max(0, serviceMinutes - overlapMinutes);
    const totalStopMinutesP50 = Math.round(p50Wait + chargeMinutes + paymentExitMinutesTotal);
    const totalStopMinutesP90 = Math.round(p90Wait + chargeMinutes + paymentExitMinutesTotal);
    const total = Number(route.duration || 0) + totalStopMinutesP50 + serviceExtraMinutes;
    const p90Total = Number(route.duration || 0) + totalStopMinutesP90 + serviceExtraMinutes;
    const arrival = state.departureMinutes + total;
    const lateMinutes = hasArrivalDeadline() ? Math.max(0, Math.ceil(arrival - state.deadlineMinutes)) : 0;
    const onTime = Math.max(50, Math.min(99, 98 - lateMinutes * 3 - Math.round(p90Wait) * 0.18 - stops.length * 1.5));
    const roadTolls = Math.max(0, Number(route.tolls || 0));
    // 价格来自演示站点数据，过路费来自高德逐段路线结果；不再用按里程
    // 硬编码的“道路成本”冒充实际费用。
    const cost = Math.max(0, energyCost + roadTolls);
    return Object.assign({}, route, {
      key,
      candidateKey: key,
      // Preserve which corridor pass produced this verified record. The
      // final objective reconciliation may otherwise choose the cheapest
      // metric from the reliable pass and erase a genuinely different
      // no-highway option.
      planningRole: key,
      station: stops[0] || null,
      stops,
      stopCount: stops.length,
      multiStop: stops.length > 1,
      servicePlan: servicePlan ? Object.assign({}, servicePlan, { extraMinutes: Math.round(serviceExtraMinutes) }) : null,
      wait,
      p50Wait: Math.round(p50Wait),
      p90Wait: Math.round(p90Wait),
      queueWaitMinutes: wait,
      chargeMinutes,
      chargingMinutes: chargeMinutes,
      serviceMinutes: Math.round(chargeMinutes),
      paymentExitMinutes: Math.round(paymentExitMinutesTotal),
      totalStopMinutesP50,
      totalStopMinutesP90,
      total,
      p90Total,
      arrival,
      lateMinutes,
      feasible: canReachAllStops && targetSocMet && detourWithinLimit && lateMinutes === 0,
      onTime,
      cost,
      energyCost: Number(energyCost.toFixed(1)),
      roadTolls: Number(roadTolls.toFixed(1)),
      directTrip: false,
      requiresStop: true,
      canReachStation: canReachAllStops,
      firstLegKm: stops[0]?.legDistanceKm ?? null,
      arrivalAtStationSoc: stops[0]?.arrivalSoc ?? null,
      maxSafeFirstLegKm: Number(((profile.capacity * state.energyPercent / 100 - safetyEnergy) / profile.consumptionPerKm).toFixed(1)),
      detour: Number(detour.toFixed(1)),
      detourLimitKm: Number(detourLimitKm.toFixed(1)),
      detourWithinLimit,
      energyReason: canReachAllStops ? (targetSocMet ? "multi-stop" : "target-unreachable") : "station-unreachable",
      energyAmount: Number(totalAmount.toFixed(1)),
      energyUnit: profile.unit,
      arrivalSoc: Number(arrivalSoc.toFixed(1)),
      targetArrivalSoc,
      arrivalReserveRequired: state.arrivalReserveEnabled,
      arrivalDeadlineRequired: state.deadlineEnabled,
      targetSocMet,
      viaWaypoints: Array.isArray(route.viaWaypoints) ? route.viaWaypoints : [],
      routeIdentity: routeIdentity(route, waypoints)
    });
  }

  async function requestLongTripPlans(routeKey = "reliable") {
    const base = state.baseRouteRecords[routeKey]
      || state.routeRecords[routeKey]
      || state.baseRouteRecords.reliable
      || state.routeRecords.reliable;
    if (!base || !Number.isFinite(Number(base.distance))) return null;
    const stopBudget = longTripStopBudget(base);
    // Do not wait for the combinatorial planner to discover that a low-SOC
    // trip has no first public POI inside the safe range. Add a clearly
    // labelled corridor anchor before the request, so 5% starts can still
    // express a safe “nearest first stop” plan instead of spending the whole
    // search budget on unreachable combinations.
    if (!activeProvisionalCorridorActive(routeKey) && state.energyPercent < 100) {
      const profile = getEnergyProfile(isFuelActive());
      const safetyEnergy = profile.capacity * profile.safetyReservePercent / 100;
      const initialSafeRange = Math.max(0, profile.capacity * state.energyPercent / 100 - safetyEnergy) / profile.consumptionPerKm;
      const hasSafeFirstCandidate = stationsForActiveBranch(state.stations).some((station) => {
        const routeMetrics = station.routeMetricsByPolicy?.[routeKey] || station;
        const progressKm = Number(routeMetrics.progressKm);
        const detourKm = Math.max(0, Number(routeMetrics.detourKm ?? routeMetrics.detour ?? 0));
        return Number.isFinite(progressKm) && progressKm > 1 && progressKm + detourKm / 2 <= initialSafeRange + 1e-6;
      });
      if (Number(base.distance) > initialSafeRange + 1e-6 && !hasSafeFirstCandidate) {
        injectProvisionalCorridorStations(routeKey);
      }
    }
    await ensureStationForecasts(base);
    // Once route verification has proved that public POI coverage is too sparse,
    // plan only with the explicit corridor anchors. Mixing the original sparse
    // POIs back in can repeatedly select an unverified urban station instead.
    const activeBranchStations = stationsForActiveBranch(state.stations)
      .filter((station) => !station.provisionalCorridor
        || (station.provisionalRouteKey || "reliable") === routeKey);
    const activeCorridorStations = activeBranchStations.filter((station) => station.provisionalCorridor === true
      && (station.provisionalRouteKey || "reliable") === routeKey);
    const planningStations = (activeCorridorStations.length ? activeCorridorStations : activeBranchStations)
      .map((station) => compactLongTripStation(station, routeKey));
    try {
      const proposal = await postJson("/api/longtrip", {
        distanceKm: base.distance,
        durationMinutes: base.duration,
        roadTolls: Math.max(0, Number(base.tolls || 0)),
        stations: planningStations,
        energyType: backendEnergyTypeKey(),
        soc: state.energyPercent,
        minArrivalSoc: effectiveArrivalReserveSoc(getEnergyProfile(isFuelActive())),
        maxStops: stopBudget.maxStops,
        adaptiveMaxStops: stopBudget.adaptiveMaxStops,
        maxDetourKm: effectiveLongTripDetourLimit(base),
        departureMinutes: state.departureMinutes,
        ...(plannerDeadlineOffset() !== undefined ? { deadlineOffsetMinutes: plannerDeadlineOffset() } : {}),
        weatherFactor: Number(state.weather?.weatherFactor) || 1,
        trafficFactor: 1,
        demandFactor: 1,
        horizonMinutes: Math.min(240, Math.max(30, Math.ceil(Number(base.duration || 30) / 5) * 5)),
        intervalMinutes: 5,
        useForecast: true
      }, 20000);
      return proposal;
    } catch (error) {
      // Do not silently fall through to the old single-stop estimator when the
      // multi-stop API itself was unavailable (for example a 413 caused by an
      // accidentally oversized forecast payload). A single stop is not a
      // safe substitute for a national trip and must never be presented as
      // one.
      state.multiStopPlanningMeta = {
        candidatesConsidered: planningStations.length,
        maxStops: stopBudget.maxStops,
        minimumStops: stopBudget.minimumStops,
        adaptiveMaxStops: stopBudget.adaptiveMaxStops,
        reason: "PLANNER_UNAVAILABLE",
        error: error?.message || "LONGTRIP_API_UNAVAILABLE",
        failure: "多站规划服务暂时不可用，未把单站估算冒充为全程补能方案。请稍后重试。"
      };
      return { plans: [], candidatesConsidered: planningStations.length, maxStops: stopBudget.maxStops, minimumStops: stopBudget.minimumStops, adaptiveMaxStops: true, reason: "PLANNER_UNAVAILABLE" };
    }
  }

  function injectProvisionalCorridorStations(routeKey = "reliable") {
    const base = state.baseRouteRecords[routeKey]
      || state.routeRecords[routeKey]
      || state.baseRouteRecords.reliable
      || state.routeRecords.reliable;
    // 兜底候选是按能源网络生成的。混动切换分支后，另一条网络还没有兜底点，
    // 这里必须按当前分支判断是否已注入，否则燃油分支会拿到 0 个可用候选。
    const branchStationType = activeStationType();
    if (!base?.path?.length || !Number.isFinite(Number(base.distance))
      || state.stations.some((station) => station.provisionalCorridor
        && (station.provisionalRouteKey || "reliable") === routeKey
        && station.type === branchStationType)) return 0;
    const profile = getEnergyProfile(isFuelActive());
    const totalDistanceKm = Number(base.distance);
    const targetEnergy = profile.capacity * effectiveArrivalReserveSoc(profile) / 100;
    const safetyEnergy = profile.capacity * profile.safetyReservePercent / 100;
    const initialEnergy = profile.capacity * state.energyPercent / 100;
    const initialSafeRange = Math.max(0, (initialEnergy - safetyEnergy) / profile.consumptionPerKm);
    const fullSafeRange = Math.max(0, (profile.capacity - safetyEnergy) / profile.consumptionPerKm);
    const maxFinalLeg = Math.max(0, (profile.capacity - targetEnergy) / profile.consumptionPerKm * 0.9);
    if (totalDistanceKm <= initialSafeRange + maxFinalLeg) return 0;

    const strideKm = Math.max(180, Math.min(310, fullSafeRange * 0.68));
    const generated = [];
    let previousProgress = 0;
    // The first anchor must itself be reachable with the driver's current
    // energy. A fixed 28 km floor made a 5% battery start impossible even
    // though the corridor fallback was meant to rescue exactly that case.
    // Keep a small geometric floor, but let the energy model choose the
    // position when the safe first-leg range is shorter.
    let desiredProgress = Math.max(5, Math.min(totalDistanceKm - maxFinalLeg, initialSafeRange * 0.7));
    // Keep adding corridor anchors until the final leg is reachable. There is
    // deliberately no fixed six/twelve-stop condition here; the energy model
    // and route length determine how many candidates are needed.
    while (totalDistanceKm - previousProgress > maxFinalLeg) {
      const reachableLimit = previousProgress === 0 ? initialSafeRange : fullSafeRange;
      const progressKm = Math.min(desiredProgress, totalDistanceKm - maxFinalLeg);
      const location = pointAtPathProgress(base.path, progressKm / totalDistanceKm);
      if (!location || progressKm <= previousProgress + 5) break;
      const sequence = generated.length + 1;
      const candidate = simulateStation({
        // The same physical progress can need two labelled fallback anchors:
        // one for the motorway/reliable corridor and one for the no-toll cheap
        // corridor. Their coordinates are different, so their identities must
        // be different too; otherwise state.stations.find(id) silently returns
        // the first branch's anchor and the cheap plan is validated on the
        // wrong corridor.
        id: `provisional-${routeKey}-${activeEnergyKind()}-${Math.round(progressKm)}-${sequence}`,
        name: `沿线补能候选点 ${sequence}`,
        address: "路线补能兜底候选 · 请在出发前确认现场设备",
        location,
        type: branchStationType,
        sourceLabel: "路线补能兜底候选 · 演示，需确认"
      }, 900 + sequence);
      generated.push(Object.assign(candidate, {
        provisionalCorridor: true,
        provisionalRouteKey: routeKey,
        routeProgress: Number((progressKm / totalDistanceKm).toFixed(4)),
        progressKm: Number(progressKm.toFixed(1)),
        corridorKm: 0,
        detourKm: 0.4,
        detour: "0.4"
      }));
      previousProgress = progressKm;
      desiredProgress = previousProgress + strideKm;
    }
    if (!generated.length) return 0;
    state.stations = state.stations.concat(generated);
    state.provisionalCorridorActive = true;
    return generated.length;
  }

  function buildProvisionalCorridorRoute(role, baseRoute, plan, stops) {
    const legDistances = Array.isArray(plan?.legs) ? plan.legs.map(Number).filter(Number.isFinite) : [];
    if (!baseRoute?.path?.length || legDistances.length !== stops.length + 1) return null;
    const distance = legDistances.reduce((sum, value) => sum + Math.max(0, value), 0);
    const baseDistance = Math.max(1, Number(baseRoute.distance || 0));
    const duration = Math.max(0, Number(baseRoute.duration || 0)) * (distance / baseDistance);
    return {
      key: role,
      path: baseRoute.path,
      legs: legDistances.map((legDistance) => ({
        distance: legDistance,
        duration: duration * (legDistance / Math.max(0.001, distance)),
        tolls: 0
      })),
      distance,
      duration,
      tolls: Math.max(0, Number(baseRoute.tolls || 0)),
      source: "高德主路线 + 沿线补能兜底候选（演示，需确认）",
      provisionalCorridorRoute: true
    };
  }

  function buildProvisionalCorridorPlan(baseRoute, stops) {
    const orderedStops = (Array.isArray(stops) ? stops : [])
      .slice()
      .sort((a, b) => Number(a?.progressKm || 0) - Number(b?.progressKm || 0));
    if (!baseRoute?.path?.length || !orderedStops.length) return null;
    let previousProgress = 0;
    let previousDetour = 0;
    const legs = orderedStops.map((stop) => {
      const progress = Math.max(previousProgress, Number(stop.progressKm) || 0);
      const detour = Math.max(0, Number(stop.detourKm ?? stop.detour ?? 0));
      const leg = Math.max(0, progress - previousProgress + previousDetour / 2 + detour / 2);
      previousProgress = progress;
      previousDetour = detour;
      return Number(leg.toFixed(1));
    });
    legs.push(Number(Math.max(0, Number(baseRoute.distance || 0) - previousProgress + previousDetour / 2).toFixed(1)));
    return { stops: orderedStops, stopCount: orderedStops.length, legs };
  }

  // The backend selects objective roles from corridor estimates.  Long-trip
  // verification then replaces that estimate with real AMap leg durations, and
  // adding a service stop can change one role again.  Reconcile the aliases
  // from the values visible in the final records instead of preserving a stale
  // role label.  Otherwise a card called “fastest” can legitimately be later
  // than the card called “reliable”.
  function reconcileRouteObjectiveAliases(records = {}) {
    const candidates = Object.values(records)
      .filter((record) => record && record.feasible !== false);
    if (!candidates.length) return records;
    const metric = (record, primary, fallback = 0) => {
      const value = Number(record?.[primary]);
      return Number.isFinite(value) ? value : Number(fallback) || 0;
    };
    const sameRoute = (left, right) => Boolean(left && right && (
      (left.routeIdentity && right.routeIdentity && left.routeIdentity === right.routeIdentity)
      || (!left.routeIdentity && !right.routeIdentity
        && Number(left.distance || 0) === Number(right.distance || 0)
        && Number(left.duration || 0) === Number(right.duration || 0)
        && (left.stops || []).map((stop) => stop.id).join("|") === (right.stops || []).map((stop) => stop.id).join("|"))
    ));
    const metricFastest = candidates.slice().sort((a, b) =>
      metric(a, "total", a.arrival) - metric(b, "total", b.arrival)
      || metric(a, "p50Wait", a.wait) - metric(b, "p50Wait", b.wait)
      || metric(a, "cost") - metric(b, "cost"))[0];
    const metricReliable = candidates.slice().sort((a, b) =>
      metric(a, "p90Total", a.total ?? a.arrival) - metric(b, "p90Total", b.total ?? b.arrival)
      || metric(b, "arrivalSoc") - metric(a, "arrivalSoc")
      || metric(a, "total", a.arrival) - metric(b, "total", b.arrival)
      || metric(a, "cost") - metric(b, "cost"))[0];
    const cheapest = candidates.slice().sort((a, b) =>
      metric(a, "cost") - metric(b, "cost")
      || metric(a, "total", a.arrival) - metric(b, "total", b.arrival)
      || metric(a, "p90Total", a.total ?? a.arrival) - metric(b, "p90Total", b.total ?? b.arrival))[0];
    // A validated record tagged with `planningRole=cheapest` came from the
    // dedicated zero-toll/low-cost corridor pass. Prefer that record over a
    // merely cheaper metric winner from the reliable-corridor pool; otherwise
    // the second pass can be silently collapsed back into the first route.
    // Keep an objective's own verified corridor when one exists. The metric
    // winner is still used as a fallback when a provider did not return a
    // dedicated policy result, but it must not replace the reliable corridor
    // with a materially different zero-toll corridor merely because the latter
    // happens to have a lower simulated P90. Otherwise the UI shows the cheap
    // national-road route twice and loses the real three-policy comparison.
    const fastest = candidates.find((record) => record?.planningRole === "fastest") || metricFastest;
    const reliable = candidates.find((record) => record?.planningRole === "reliable") || metricReliable;
    const cheapestRecord = candidates.find((record) => record?.planningRole === "cheapest") || cheapest;
    const fastestIsStable = sameRoute(fastest, reliable);
    const fastestIsCheap = sameRoute(fastest, cheapestRecord);
    const stableIsCheap = sameRoute(reliable, cheapestRecord);
    const isLongTrip = candidates.some((record) => record.multiStop || record.provisionalCorridorRoute);
    const names = isLongTrip
      ? { fastest: "最快到达", reliable: "最稳妥", cheapest: "最低成本" }
      : {
        fastest: fastestIsStable && fastestIsCheap ? "全优方案" : fastestIsStable ? "最快且最稳" : fastestIsCheap ? "最快且最省" : "最快到达",
        reliable: fastestIsStable && stableIsCheap ? "全优方案" : fastestIsStable ? "最快且最稳" : stableIsCheap ? "最稳且最省" : "最稳妥",
        cheapest: fastestIsCheap && stableIsCheap ? "全优方案" : fastestIsCheap ? "最快且最省" : stableIsCheap ? "最稳且最省" : "最低成本"
      };
    const preferredRole = ["cost", "cheapest"].includes(state.priority)
      ? "cheapest"
      : ["time", "fastest"].includes(state.priority)
        ? "fastest"
        : "reliable";
    // Keep a materially different validated corridor attached to its policy.
    // Pure metric reconciliation can otherwise select the low-wait fallback
    // for every alias and hide the genuine cheapest route from the cards.
    const aliases = {
      fastest,
      reliable,
      cheapest: cheapestRecord
    };
    return Object.fromEntries(Object.entries(aliases).map(([role, source]) => [role, Object.assign({}, source, {
      key: role,
      candidateKey: source.candidateKey || role,
      displayName: names[role],
      isActualFastest: sameRoute(source, fastest),
      isActualStable: sameRoute(source, reliable),
      isActualCheapest: sameRoute(source, cheapestRecord),
      stableCollision: fastestIsStable,
      costBackup: fastestIsCheap || stableIsCheap,
      recommended: role === preferredRole,
      objectiveBadges: [
        sameRoute(source, fastest) ? "最快" : null,
        sameRoute(source, reliable) ? "最稳妥" : null,
        sameRoute(source, cheapestRecord) ? "最低成本" : null
      ].filter(Boolean)
    })]));
  }

  async function replanLongTripRoutes() {
    let proposal = await requestLongTripPlans();
    // The long-trip endpoint is local and deterministic once its compact
    // inputs are assembled, but the first request can still lose a transient
    // server/connection race while the map session is settling. Retry this
    // bounded local planner failure once; do not retry energy infeasibility or
    // route-verification failures, because those are real evidence rather
    // than transport noise.
    if (proposal?.reason === "PLANNER_UNAVAILABLE") {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      proposal = await requestLongTripPlans();
    }

    // The base route API can return a materially different zero-toll corridor.
    // The original long-trip request was always seeded from the reliable
    // corridor, so its station pool and objective search could never discover
    // that alternative. Run the cheap objective once on its own corridor and
    // merge only its candidate plans; this keeps the three policy calculations
    // honest without showing the same physical trip three times.
    let cheapestProposal = null;
    const reliableBase = state.baseRouteRecords.reliable || state.routeRecords.reliable;
    const cheapestBase = state.baseRouteRecords.cheapest || state.routeRecords.cheapest;
    const materiallyDifferentCheapRoute = reliableBase && cheapestBase
      && (Math.abs(Number(reliableBase.distance || 0) - Number(cheapestBase.distance || 0)) > 20
        || Math.abs(Number(reliableBase.tolls || 0) - Number(cheapestBase.tolls || 0)) > 20
        || routeDisplayIdentity(reliableBase) !== routeDisplayIdentity(cheapestBase));
    if (materiallyDifferentCheapRoute) {
      cheapestProposal = await requestLongTripPlans("cheapest");
      if (cheapestProposal?.reason === "PLANNER_UNAVAILABLE") {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        cheapestProposal = await requestLongTripPlans("cheapest");
      }
      const cheapPlans = Array.isArray(cheapestProposal?.plans)
        ? cheapestProposal.plans.filter((plan) => Number(plan.stopCount || 0) >= 1)
        : [];
      if (!cheapPlans.length && !activeProvisionalCorridorActive("cheapest")
        && injectProvisionalCorridorStations("cheapest")) {
        // A zero-toll corridor often has fewer indexed charging POIs than the
        // motorway corridor. Use explicit, labelled geometry anchors only as a
        // planning fallback, then run the same validator again.
        cheapestProposal = await requestLongTripPlans("cheapest");
      }
    }
    // AMap can return no publicly indexed charger for a long motorway section.
    // Rather than declare that six charges cannot cover the distance, introduce
    // explicitly-labelled provisional corridor anchors and run the same energy
    // and real-road checks again. These anchors are never presented as a real
    // station or real-time availability signal.
    // A dense POI pool can exhaust the bounded subset search before it finds a
    // safe sequence, especially when the current SOC requires the first stop
    // to be close to the origin.  In that case the missing result is a search
    // coverage problem, not evidence that the corridor is impossible. Retry
    // with explicitly-labelled corridor anchors just as we do for a completed
    // but infeasible public-POI search.
    if (["NO_FEASIBLE_SEQUENCE", "SEARCH_BUDGET_EXHAUSTED"].includes(proposal?.reason)
      && injectProvisionalCorridorStations()) {
      proposal = await requestLongTripPlans();
    }
    // The long-trip evaluator deliberately includes a zero-stop candidate
    // when the destination is already reachable. Do not discard that direct
    // result and then manufacture a 0 kWh station visit from an overflow
    // candidate; let the normal direct-route branch render “无需补能”.
    const proposalPlans = [
      ...(Array.isArray(proposal?.plans) ? proposal.plans : []),
      ...(Array.isArray(cheapestProposal?.plans) ? cheapestProposal.plans : [])
    ];
    // A direct zero-stop result from the primary (reliable) corridor means the
    // normal direct-trip branch should render it. Do not let an optional cheap
    // corridor's own direct candidate discard a valid long-trip proposal.
    if (Array.isArray(proposal?.plans)
      && proposal.plans.some((plan) => Number(plan.stopCount || 0) === 0)) return false;
    const plans = proposalPlans.filter((plan) => Number(plan.stopCount || 0) >= 1);
    if (!plans.length) {
      if (proposal?.reason) {
        state.multiStopPlanningMeta = {
          candidatesConsidered: proposal.candidatesConsidered || 0,
          candidatesAvailable: proposal.candidatesAvailable || proposal.candidatesConsidered || 0,
          maxStops: proposal.maxStops ?? null,
          minimumStops: proposal.minimumStops || 0,
          adaptiveMaxStops: Boolean(proposal.adaptiveMaxStops),
          candidateSearchComplete: proposal.candidateSearchComplete !== false,
          sequenceSearchComplete: proposal.sequenceSearchComplete !== false,
          reason: proposal.reason,
          failure: proposal.reason === "NO_FEASIBLE_SEQUENCE"
            ? (() => {
              const minimum = Number(proposal.minimumStops) || 0;
              if (proposal.adaptiveMaxStops === true) {
                return `已检索 ${proposal.candidatesConsidered || 0} 个沿线补能候选；按当前${isFuelActive() ? "油量" : "电量"}与安全下限，理论上至少约需 ${minimum} 次补能，但在候选覆盖、可达性或绕行约束下仍未形成完整方案。`;
              }
              const cap = Number(proposal.maxStops) || DEFAULT_LONG_TRIP_MAX_STOPS;
              return minimum > cap
                ? `已检索 ${proposal.candidatesConsidered || 0} 个沿线补能候选；按当前${isFuelActive() ? "油量" : "电量"}与安全下限，理论上至少约需 ${minimum} 次补能，超过本次最多 ${cap} 次的规划预算。`
                : `已检索 ${proposal.candidatesConsidered || 0} 个沿线补能候选；在到达余量、绕行和站点可达性约束下，最多 ${cap} 次补能仍无法形成安全全程方案。`;
            })()
            : proposal.reason === "SEARCH_BUDGET_EXHAUSTED"
              ? "候选组合较多，本次搜索预算已用尽，系统没有把未完成的搜索冒充为“已证明不可行”。请减少候选范围或稍后重试。"
              : proposal.reason === "PLANNER_UNAVAILABLE"
                ? "多站规划服务短暂不可用，已重试一次；仍未完成时不会展示虚假的全程方案。"
              : "多站补能候选未能完成计算。"
        };
        return "no-feasible-sequence";
      }
      return false;
    }
    const roles = ["fastest", "reliable", "cheapest"];
    const plansByObjective = Object.assign(
      {},
      proposal?.plansByObjective && typeof proposal.plansByObjective === "object" ? proposal.plansByObjective : {},
      cheapestProposal?.plansByObjective && typeof cheapestProposal.plansByObjective === "object"
        ? { cheapest: cheapestProposal.plansByObjective.cheapest }
        : {}
    );
    // Keep candidate plans tied to the corridor that produced them. The cheap
    // objective is requested a second time when AMap returned a materially
    // different no-toll route. Mixing both responses into one fallback pool
    // lets the reliable pass validate a cheap-corridor sequence against the
    // motorway base, then alias reliable and cheapest to the same physical
    // record. That is precisely how the third card disappeared.
    const primaryPlans = (Array.isArray(proposal?.plans) ? proposal.plans : [])
      .filter((plan) => Number(plan.stopCount || 0) >= 1);
    const cheapPlans = (materiallyDifferentCheapRoute && Array.isArray(cheapestProposal?.plans)
      ? cheapestProposal.plans
      : [])
      .filter((plan) => Number(plan.stopCount || 0) >= 1);
    const validated = {};
    const routedBackup = {};
    for (let index = 0; index < roles.length; index += 1) {
      const role = roles[index];
      // Candidate estimates are screened again with the actual road geometry.
      // A station sequence that works on a corridor approximation may fail on
      // a particular road policy, so try the objective's plan first and then
      // safe alternatives instead of declaring the whole trip impossible.
      const rolePlans = role === "cheapest" && materiallyDifferentCheapRoute && cheapPlans.length
        ? cheapPlans
        : primaryPlans;
      const candidates = [
        rolePlans.find((candidate) => candidate.objective === role),
        // Only use the primary corridor's objective map for the primary pass.
        // When the cheap corridor has its own proposal, its station IDs and
        // progress metrics must not be mixed with the reliable corridor here.
        ...(role === "cheapest" && materiallyDifferentCheapRoute && cheapPlans.length
          ? []
          : [plansByObjective[role]]),
        rolePlans[index],
        ...rolePlans
      ].filter(Boolean);
      const seen = new Set();
      for (const plan of candidates) {
        const signature = (plan.stops || []).map((stop) => stop.id).join("|") || "direct";
        if (seen.has(signature)) continue;
        seen.add(signature);
        const stops = (plan.stops || []).map((stop) => {
          const station = state.stations.find((candidate) => String(candidate.id) === String(stop.id));
          const metrics = station?.routeMetricsByPolicy?.[role];
          return station && metrics
            ? Object.assign({}, station, metrics)
            : station;
        }).filter(Boolean);
        if (stops.length !== plan.stopCount) continue;
        // A plan returned from the other corridor is not a valid candidate for
        // this role. In particular, a reliable-corridor request can see cheap
        // anchors already present in the shared station pool; accepting those
        // IDs here makes the reliable alias silently become the cheap route.
        if (materiallyDifferentCheapRoute && role !== "cheapest"
          && stops.some((station) => station.provisionalCorridor
            && (station.provisionalRouteKey || "reliable") !== role)) continue;
        const base = state.baseRouteRecords[role] || state.baseRouteRecords.reliable;
        // A generated corridor anchor can lie on a motorway centre line and
        // therefore cannot always be used as a road-routing endpoint. Its
        // energy sequence is still calculated from the verified AMap main
        // route, but it is explicitly marked as a provisional stop rather
        // than being presented as a real charging facility.
        const energyWaypoints = stops.map((station) => Object.assign({}, station, { kind: "energy" }));
        const routeStops = routeStopsWithTripWaypoints(energyWaypoints, true, role);
        const route = activeProvisionalCorridorActive(role) && !state.tripWaypoints.length && stops.every((station) => (
          station.provisionalCorridor
          && (station.provisionalRouteKey || "reliable") === role
        ))
          ? buildProvisionalCorridorRoute(role, base, plan, stops)
          : await queryRouteSequence(role, routeStops, { includeTripWaypoints: false });
        const record = route && buildValidatedLongTripRecord(role, base, route, routeStops);
        if (record && !routedBackup[role]) routedBackup[role] = record;
        if (record?.feasible) {
          validated[role] = record;
          break;
        }
      }
    }
    // If the primary proposal only supplied a cheap-corridor sequence for the
    // reliable role, rebuild a labelled reliable-corridor sequence instead of
    // allowing objective reconciliation to rename the cheap route as both
    // “最稳妥” and “最低成本”. This uses the same provisional-anchor fallback
    // and the same energy/detour validator; it does not invent a real station.
    if (materiallyDifferentCheapRoute && (!validated.reliable || validated.reliable.planningRole !== "reliable")) {
      if (!activeProvisionalCorridorActive("reliable")) injectProvisionalCorridorStations("reliable");
      const reliableAnchors = state.stations
        .filter((station) => station.provisionalCorridor === true
          && (station.provisionalRouteKey || "reliable") === "reliable"
          && station.type === activeStationType())
        .sort((a, b) => Number(a.progressKm || 0) - Number(b.progressKm || 0));
      const reliablePlan = buildProvisionalCorridorPlan(reliableBase, reliableAnchors);
      if (reliablePlan) {
        const reliableStops = routeStopsWithTripWaypoints(
          reliablePlan.stops.map((station) => Object.assign({}, station, { kind: "energy" })),
          false,
          "reliable"
        );
        const reliableRoute = buildProvisionalCorridorRoute("reliable", reliableBase, reliablePlan, reliableStops);
        const reliableRecord = reliableRoute && buildValidatedLongTripRecord("reliable", reliableBase, reliableRoute, reliableStops);
        if (reliableRecord?.feasible) validated.reliable = reliableRecord;
      }
    }
    if (materiallyDifferentCheapRoute && !validated.cheapest) {
      // A cheap-corridor request can return a public POI sequence that is
      // rejected by the final leg-by-leg check. Do not then fall back to the
      // reliable corridor and silently lose the no-highway option: validate
      // the explicitly labelled cheap-corridor anchors as the same bounded
      // planning fallback used by the reliable branch.
      if (!activeProvisionalCorridorActive("cheapest")) injectProvisionalCorridorStations("cheapest");
      const cheapAnchors = state.stations
        .filter((station) => station.provisionalCorridor === true
          && (station.provisionalRouteKey || "reliable") === "cheapest"
          && station.type === activeStationType())
        .sort((a, b) => Number(a.progressKm || 0) - Number(b.progressKm || 0));
      const cheapPlan = buildProvisionalCorridorPlan(cheapestBase, cheapAnchors);
      if (cheapPlan) {
        const cheapStops = routeStopsWithTripWaypoints(
          cheapPlan.stops.map((station) => Object.assign({}, station, { kind: "energy" })),
          false,
          "cheapest"
        );
        const cheapRoute = buildProvisionalCorridorRoute("cheapest", cheapestBase, cheapPlan, cheapStops);
        const cheapRecord = cheapRoute && buildValidatedLongTripRecord("cheapest", cheapestBase, cheapRoute, cheapStops);
        if (cheapRecord?.feasible) validated.cheapest = cheapRecord;
      }
    }
    const available = Object.values(validated).filter((record) => record.feasible);
    if (!available.length) {
      // Some city-search POIs look feasible in corridor distance but fail once
      // their actual motorway approach is routed. Treat that exactly like an
      // empty corridor: add explicitly-labelled planning anchors and retry
      // before reporting that the long trip has no safe route.
      if (!activeProvisionalCorridorActive() && injectProvisionalCorridorStations()) {
        return replanLongTripRoutes();
      }
      // "未通过核验"曾经是一句什么都没说的话：候选路线其实已经算完了，
      // 四道闸门（能否到站 / 能否补够 / 绕行 / 是否误点）到底是哪一道拦下来的，
      // 记录里都有，只是被丢掉了。挑一条已经成功路由的候选，把真实原因说出来。
      const rejected = Object.values(routedBackup).filter(Boolean);
      const sample = rejected.slice().sort((a, b) => Number(b.canReachStation) - Number(a.canReachStation)
        || Number(b.targetSocMet) - Number(a.targetSocMet)
        || Number(a.detour) - Number(b.detour))[0];
      const describeRejection = (record) => {
        if (!record) return null;
        if (!record.canReachStation) return `候选补能点在当前${isFuelActive() ? "油量" : "电量"}下无法安全抵达（最远可达约 ${record.maxSafeFirstLegKm} km）。`;
        if (!record.targetSocMet) return `沿线候选点补能后仍达不到抵达余量要求（目标 ${record.targetArrivalSoc}%，实际 ${record.arrivalSoc}%）。`;
        if (!record.detourWithinLimit) return `最优候选需绕行 ${record.detour} km，超过 ${record.detourLimitKm} km 上限。可放宽绕行限制后重试。`;
        if (record.lateMinutes > 0) return `最优候选会比要求的抵达时间晚 ${record.lateMinutes} 分钟。`;
        return null;
      };
      const detail = describeRejection(sample);
      state.multiStopPlanningMeta = {
        candidatesConsidered: proposal.candidatesConsidered || 0,
        maxStops: proposal.maxStops ?? null,
        minimumStops: proposal.minimumStops || 0,
        adaptiveMaxStops: Boolean(proposal.adaptiveMaxStops),
        reason: "ROUTE_VERIFICATION_FAILED",
        rejectedRouted: rejected.length,
        rejectionSample: sample
          ? {
            stops: (sample.stops || []).map((stop) => stop.name),
            canReachStation: sample.canReachStation,
            targetSocMet: sample.targetSocMet,
            detour: sample.detour,
            detourLimitKm: sample.detourLimitKm,
            detourWithinLimit: sample.detourWithinLimit,
            lateMinutes: sample.lateMinutes,
            arrivalSoc: sample.arrivalSoc
          }
          : null,
        failure: detail
          ? `多站候选未通过核验：${detail}系统未将其展示为可执行方案。`
          : "多站候选未通过逐段真实路线核验，系统未将其展示为可执行方案。"
      };
      return "verification-failed";
    }
    // The verified records are the source of truth for the visible objective
    // labels. Do not keep the backend's corridor-level role if AMap's actual
    // leg durations changed the ranking.
    state.multiStopRouteRecords = reconcileRouteObjectiveAliases(
      Object.fromEntries(available.map((record, index) => [`verified-${index}`, record]))
    );
    const preferred = Object.entries(state.multiStopRouteRecords).find(([, record]) => record.recommended)?.[0] || "reliable";
    state.multiStopPlanningMeta = {
      candidatesConsidered: proposal.candidatesConsidered,
      candidatesAvailable: proposal.candidatesAvailable || proposal.candidatesConsidered,
      maxStops: proposal.maxStops,
      uniqueStopPlans: new Set(Object.values(plansByObjective).map((plan) => (plan?.stops || []).map((stop) => stop.id).join("|"))).size,
      candidateSearchComplete: proposal.candidateSearchComplete !== false,
      sequenceSearchComplete: proposal.sequenceSearchComplete !== false,
      searchCaveat: proposal.sequenceSearchComplete === false || proposal.candidateSearchComplete === false
        ? "当前结果来自有界搜索，未把搜索预算内的最佳结果表述为全局最优。"
        : null
    };
    state.routeCandidates = Object.assign({}, state.multiStopRouteRecords);
    state.routeRecords = Object.assign({}, state.multiStopRouteRecords);
    state.recommendedRoute = preferred;
    renderLiveStationMarkers();
    return true;
  }

  async function replanRoutesViaStations() {
    const longTripResult = await replanLongTripRoutes();
    if (longTripResult === true) return;
    if (longTripResult) {
      const failure = state.multiStopPlanningMeta?.failure || "当前约束下未形成安全的多站补能方案。";
      state.multiStopRouteRecords = null;
      state.routeCandidates = Object.fromEntries(Object.entries(state.baseRouteRecords).map(([key, route]) => [key, Object.assign({}, route, {
        key,
        station: null,
        planningFailure: failure
      })]));
      state.routeRecords = Object.assign({}, state.routeCandidates);
      state.selectedStation = null;
      showToast("未生成虚假的长途补能路线：请查看安全约束说明", 4000);
      return;
    }
    if (!state.AMap) return;
    const baseRecords = Object.assign({}, state.baseRouteRecords);
    state.routeRecords = Object.assign({}, baseRecords);
    const policies = makeDrivingPolicies(state.AMap);
    const entries = await Promise.all(Object.keys(policies).map(async (key) => {
      const base = baseRecords[key];
      if (!base) return [key, null];
      const direct = calculateEnergyPlan(Object.assign({}, base, { station: null }), key, isFuelActive());
      if (direct.canDirect) return [key, Object.assign({}, base, {
        station: null,
        directTrip: true,
        detour: 0,
        baseDistance: base.distance,
        baseDuration: base.duration
      })];

      const excluded = new Set();
      let lastRejected = null;
      // The first candidate normally passes. Retry a few alternatives only if
      // the actual road polyline proves the preliminary geometry wrong.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const station = chooseStationForRouteExcluding(key, excluded);
        if (!station) break;
        excluded.add(station.id);
        const replanned = await queryDriving(key, policies[key], station);
        if (!replanned) continue;
        const detour = Math.max(0, replanned.distance - base.distance);
        const candidate = Object.assign({}, replanned, {
          baseDistance: base.distance,
          baseDuration: base.duration,
          detour,
          station: Object.assign({}, station, { detour: detour.toFixed(1) })
        });
        const energy = calculateEnergyPlan(candidate, key, isFuelActive());
        if (energy.canReachStation && energy.detourWithinLimit && energy.targetMet) return [key, candidate];
        lastRejected = candidate;
      }
      return [key, Object.assign({}, lastRejected || base, {
        station: lastRejected?.station || null,
        detour: Number(lastRejected?.detour) || 0,
        baseDistance: base.distance,
        baseDuration: base.duration,
        planningFailure: "当前油/电量不足以安全抵达符合绕行约束的补能站"
      })];
    }));
    state.baseRouteRecords = baseRecords;
    state.routeCandidates = Object.fromEntries(entries.filter((entry) => entry[1]));
    state.routeRecords = Object.assign({}, state.routeCandidates);
    renderLiveStationMarkers();
  }

  function renderLiveStationMarkers() {
    if (!state.live || !state.map) return;
    clearStationOverlays();
    addAmapEndpoints();
    const plannedIds = new Set(Object.values(state.routeRecords)
      .flatMap((record) => (record.stops?.length ? record.stops : [record.station]))
      .map((station) => station?.id)
      .filter(Boolean));
    const route = corridorReferenceRoute();
    const displayCandidates = state.stations.filter((station) => {
      const awayFromOrigin = distanceKm(station.location, state.origin) > 1.2;
      const awayFromDestination = distanceKm(station.location, state.destination) > 0.8;
      return awayFromOrigin && awayFromDestination;
    });
    const displayStations = state.stations.filter((station) => plannedIds.has(station.id));
    [0.18, 0.43, 0.68, 0.9].forEach((target) => {
      const candidate = displayCandidates
        .slice()
        .sort((a, b) => Math.abs(routeProgress(a.location, route.path) - target) - Math.abs(routeProgress(b.location, route.path) - target))
        .find((station) => !displayStations.some((selected) => selected.id === station.id));
      if (candidate) displayStations.push(candidate);
    });
    displayStations.slice(0, 7).forEach((station) => {
      const marker = addAmapMarker(station, station);
      if (marker) state.stationOverlays.push(marker);
    });
    highlightSelectedStation();
  }

  function calculateRouteRecords() {
    if (state.multiStopRouteRecords) {
      // A service stop or a fresh AMap verification can change the visible
      // ordering.  Reconcile again instead of trusting the aliases created by
      // the previous planning pass.
      state.multiStopRouteRecords = reconcileRouteObjectiveAliases(state.multiStopRouteRecords);
      state.routeRecords = state.multiStopRouteRecords;
      const preferred = Object.entries(state.routeRecords).find(([, record]) => record.recommended)?.[0] || "reliable";
      state.recommendedRoute = preferred;
      return;
    }
    const candidates = Object.keys(state.routeCandidates || {}).length ? state.routeCandidates : state.routeRecords;
    // 实况模式下宁可借用本次行程另一条真实路线，也不能拿演示折线当基准：
    // base 会同时决定里程、时长和整套费用模型。
    const base = candidates.reliable
      || (state.live ? Object.values(candidates).find(Boolean) : null)
      || fallbackRoutes().reliable;
    const isFuel = isFuelActive();
    const profile = getEnergyProfile(isFuel);
    const referencePrice = referenceEnergyPrice(isFuel);
    const make = (candidateKey, record, station) => {
      const route = Object.assign({}, record || base, { station: station || null });
      const energyPlan = calculateEnergyPlan(route, candidateKey, isFuel);
      const hasStop = energyPlan.requiresStop && energyPlan.canReachStation;
      const wait = hasStop ? Math.max(0, Number.isFinite(Number(station?.wait)) ? Number(station.wait) : 5) : 0;
      const p50Wait = hasStop ? Math.max(0, Number.isFinite(Number(station?.p50)) ? Number(station.p50) : wait) : 0;
      const p90Wait = hasStop ? Math.max(p50Wait, Number.isFinite(Number(station?.p90)) ? Number(station.p90) : p50Wait) : 0;
      const chargingMinutes = hasStop ? energyPlan.chargeMinutes : 0;
      const paymentExitMinutes = hasStop ? paymentExitMinutesFor(isFuel ? "fuel" : "electric", station) : 0;
      const totalStopMinutesP50 = Math.round(p50Wait + chargingMinutes + paymentExitMinutes);
      const totalStopMinutesP90 = Math.round(p90Wait + chargingMinutes + paymentExitMinutes);
      const total = route.duration + totalStopMinutesP50;
      const p90Total = route.duration + totalStopMinutesP90;
      const arrival = state.departureMinutes + total;
      const lateMinutes = hasArrivalDeadline() ? Math.max(0, Math.ceil(arrival - state.deadlineMinutes)) : 0;
      const onTime = Math.max(55, Math.min(99, 98 - lateMinutes * 3 - p90Wait * 0.2));
      // 本次行程的现金支出：补能支出 + 通行/道路成本。与多站长途路径同口径。
      // 旧实现按目标写死 1.65/1.55/1.4 与 1.08/1.0/0.82 的“成本系数”，实际是在
      // 替 simulateStation 里被当成电价的油价打补丁；油价修正后必须去掉，
      // 否则燃油成本会被重复放大一次。
      const unitPrice = hasStop ? Math.max(0, Number(station?.price) || referencePrice) : referencePrice;
      const energyCost = hasStop ? unitPrice * energyPlan.amount : 0;
      // 通行费与磨损与动力类型无关。
      const roadCost = Math.max(0, Number(route.distance) || 0) * 0.08 + Math.max(0, Number(route.tolls) || 0);
      const serviceCost = energyPlan.chargeMinutes * 0.15;
      const cost = Math.max(20, energyCost + roadCost + serviceCost);
      return Object.assign({}, route, {
        energyCost: Number(energyCost.toFixed(1)),
        roadCost: Number(roadCost.toFixed(1)),
        energyUnitPrice: Number(unitPrice.toFixed(2)),
        // 全程能耗成本（含起步电/油的折价），用于油电对比而非现金支出对比。
        tripEnergyCost: Number((Math.max(0, Number(route.distance) || 0) * profile.consumptionPerKm * unitPrice).toFixed(1)),
        key: candidateKey,
        candidateKey: routeIdentity(route, station ? [station] : []),
        routeIdentity: routeIdentity(route, station ? [station] : []),
        station: station || null,
        wait,
        queueWaitMinutes: Math.round(wait),
        p50Wait: Math.round(p50Wait),
        p90Wait: Math.round(p90Wait),
        chargeMinutes: chargingMinutes,
        chargingMinutes,
        serviceMinutes: Math.round(chargingMinutes),
        paymentExitMinutes: Math.round(paymentExitMinutes),
        totalStopMinutesP50,
        totalStopMinutesP90,
        total,
        p90Total,
        arrival,
        lateMinutes,
        feasible: lateMinutes === 0 && energyPlan.targetMet && energyPlan.detourWithinLimit && (energyPlan.canDirect || energyPlan.canReachStation) && !route.planningFailure,
        onTime,
        cost,
        directTrip: energyPlan.canDirect,
        requiresStop: energyPlan.requiresStop,
        canReachStation: energyPlan.canReachStation,
        firstLegKm: energyPlan.firstLegKm,
        arrivalAtStationSoc: Number.isFinite(energyPlan.arrivalAtStationSoc) ? Number(energyPlan.arrivalAtStationSoc.toFixed(1)) : null,
        maxSafeFirstLegKm: Number.isFinite(energyPlan.maxSafeFirstLegKm) ? Number(energyPlan.maxSafeFirstLegKm.toFixed(1)) : null,
        detourWithinLimit: energyPlan.detourWithinLimit,
        energyReason: energyPlan.reason,
        energyAmount: Number(energyPlan.amount.toFixed(1)),
        energyUnit: energyPlan.unit,
        arrivalSoc: Number(energyPlan.arrivalSoc.toFixed(1)),
        targetArrivalSoc: effectiveArrivalReserveSoc(getEnergyProfile(isFuel)),
        arrivalReserveRequired: state.arrivalReserveEnabled,
        arrivalDeadlineRequired: state.deadlineEnabled,
        targetSocMet: energyPlan.targetMet
      });
    };
    const raw = [
      make("fastest", candidates.fastest || base, candidates.fastest?.station),
      make("reliable", candidates.reliable || base, candidates.reliable?.station),
      make("cheapest", candidates.cheapest || base, candidates.cheapest?.station)
    ];
    const feasibleFirst = (a, b) => Number(b.feasible) - Number(a.feasible);
    const sortFast = (a, b) => feasibleFirst(a, b) || a.arrival - b.arrival || a.cost - b.cost;
    const sortStable = (a, b) => feasibleFirst(a, b) || (a.p90Total || a.arrival) - (b.p90Total || b.arrival) || b.onTime - a.onTime || a.arrival - b.arrival;
    const sortCheap = (a, b) => feasibleFirst(a, b) || a.cost - b.cost || a.arrival - b.arrival;
    const actualFastest = raw.slice().sort(sortFast)[0];
    const actualStable = raw.slice().sort(sortStable)[0];
    const actualCheap = raw.slice().sort(sortCheap)[0];
    // Keep each objective's actual winner even when two objectives resolve to
    // the same physical road corridor. The previous de-duplication picked a
    // worse unused candidate just to force three visually different cards.
    const fastest = actualFastest;
    const stable = actualStable;
    const cheap = actualCheap;
    const sameRoute = (left, right) => Boolean(left && right && left.routeIdentity === right.routeIdentity);
    const fastestIsStable = sameRoute(actualFastest, actualStable);
    const fastestIsCheap = sameRoute(actualFastest, actualCheap);
    const stableIsCheap = sameRoute(actualStable, actualCheap);
    const stableCollision = fastestIsStable;
    const cheapCollision = fastestIsCheap || stableIsCheap;
    const decorate = (role, record, displayName, extra) => Object.assign({}, record, { key: role, displayName }, extra || {});
    state.routeRecords = {
      fastest: decorate("fastest", fastest, fastestIsStable && fastestIsCheap ? "全优方案" : fastestIsStable ? "最快且最稳" : fastestIsCheap ? "最快且最省" : "最快到达", { isActualFastest: true, isActualStable: fastestIsStable, isActualCheapest: fastestIsCheap }),
      reliable: decorate("reliable", stable, fastestIsStable && stableIsCheap ? "全优方案" : fastestIsStable ? "最快且最稳" : stableIsCheap ? "最稳且最省" : "最稳妥", { isActualFastest: fastestIsStable, isActualStable: true, isActualCheapest: stableIsCheap, stableCollision }),
      cheapest: decorate("cheapest", cheap, fastestIsCheap && stableIsCheap ? "全优方案" : fastestIsCheap ? "最快且最省" : stableIsCheap ? "最稳且最省" : "最低成本", { isActualFastest: fastestIsCheap, isActualStable: stableIsCheap, isActualCheapest: true, costBackup: cheapCollision })
    };
    Object.values(state.routeRecords).forEach((record) => {
      record.objectiveBadges = [
        record.isActualFastest ? "最快" : null,
        record.isActualStable ? "最稳妥" : null,
        record.isActualCheapest ? "最低成本" : null
      ].filter(Boolean);
    });
    Object.entries(state.serviceRouteOverrides || {}).forEach(([role, override]) => {
      if (!state.routeRecords[role]) return;
      state.routeRecords[role] = Object.assign({}, state.routeRecords[role], override, {
        key: role,
        candidateKey: role,
        displayName: state.routeRecords[role].displayName
      });
    });
    // Applying a service plan changes the actual ETA/P50/P90/cost.  Re-rank
    // after the override; otherwise the old role label can say “fastest” even
    // though another card now has an earlier verified arrival.
    state.routeRecords = reconcileRouteObjectiveAliases(state.routeRecords);
    const preferredRole = Object.entries(state.routeRecords).find(([, record]) => record.recommended)?.[0]
      || (["cost", "cheapest"].includes(state.priority)
        ? "cheapest"
        : ["time", "fastest"].includes(state.priority)
          ? "fastest"
          : "reliable");
    state.recommendedRoute = preferredRole;
    Object.entries(state.routeRecords).forEach(([role, record]) => { record.recommended = role === preferredRole; });
  }

  function setOptionText(button, record) {
    if (!button || !record) return;
    const strong = button.querySelector(".option-main strong");
    const metrics = button.querySelector(".option-metrics");
    const reason = button.querySelector(".option-reason");
    const stationLine = button.querySelector(".option-station");
    const tag = button.querySelector(".option-tag");
    const name = button.querySelector(".option-name-text");
    button.classList.toggle("infeasible", !record.feasible);
    if (name) name.textContent = displayCopy(record.displayName || { fastest: "最快到达", reliable: "最稳妥", cheapest: "最低成本" }[record.key]);
    if (strong) strong.textContent = formatClock(record.arrival);
    const serviceName = record.servicePlan?.name || "";
    if (metrics) {
      metrics.innerHTML = displayCopy(record.directTrip
        ? `<span>用时 <b>${formatDuration(record.total)}</b></span><span>直达 <b>无需补能</b></span><span>到达 <b>${record.arrivalSoc}%</b></span><span>成本 <b>¥${Math.round(record.cost)}</b></span>`
        : record.serviceOnly
          ? `<span>用时 <b>${formatDuration(record.total)}</b></span><span>服务 <b>${serviceName || "已加入"}</b></span><span>到达 <b>${record.arrivalSoc}%</b></span><span>${state.deadlineEnabled ? "准时" : "安全余量"} <b>${state.deadlineEnabled ? `${Math.round(record.onTime)}%` : `${record.targetArrivalSoc}%`}</b></span>`
        : record.multiStop
            ? `<span>用时 <b>${formatDuration(record.total)}</b></span><span>补能 <b>${record.stopCount} 次</b></span><span>停靠 <b>${formatDuration(record.totalStopMinutesP50 || 0)}</b></span>${serviceName ? `<span>服务 <b>${serviceName}</b></span>` : ""}<span>绕行 <b>${Number(record.detour || 0).toFixed(1)}km</b></span><span>排队 P90 <b>${record.p90Wait}分</b></span><span>费用 <b>¥${Math.round(record.cost)}</b></span><span>${state.deadlineEnabled ? "准时" : "安全余量"} <b>${state.deadlineEnabled ? `${Math.round(record.onTime)}%` : `${record.targetArrivalSoc}%`}</b></span>`
            : `<span>用时 <b>${formatDuration(record.total)}</b></span>${serviceName ? `<span>服务 <b>${serviceName}</b></span>` : ""}<span>停靠 <b>${formatDuration(record.totalStopMinutesP50 || 0)}</b></span><span>排队 P50 <b>${record.p50Wait ?? record.station?.p50 ?? "—"}分</b></span><span>排队 P90 <b>${record.p90Wait ?? record.station?.p90 ?? "—"}分</b></span><span>成本 <b>¥${Math.round(record.cost)}</b></span><span>${state.deadlineEnabled ? "准时" : "安全余量"} <b>${state.deadlineEnabled ? `${Math.round(record.onTime)}%` : `${record.targetArrivalSoc}%`}</b></span>`);
    }
    if (tag) {
      const objectiveBadgeText = record.feasible && Array.isArray(record.objectiveBadges) && record.objectiveBadges.length > 1
        ? `多目标：${record.objectiveBadges.join(" · ")}`
        : "";
      if (objectiveBadgeText && !record.servicePlan) tag.textContent = objectiveBadgeText;
      else if (record.directTrip) tag.textContent = "无需补能";
      else if (record.serviceOnly) tag.textContent = "服务已加入";
      else if (record.servicePlan) tag.textContent = "含服务";
      else if (record.planningFailure && state.multiStopPlanningMeta?.adaptiveMaxStops !== true
        && state.multiStopPlanningMeta?.reason === "NO_FEASIBLE_SEQUENCE"
        && Number(state.multiStopPlanningMeta?.minimumStops) > Number(state.multiStopPlanningMeta?.maxStops)) {
        tag.textContent = `需 ${state.multiStopPlanningMeta.minimumStops} 次补能`;
      }
      else if (!record.canReachStation) tag.textContent = "无法安全到站";
      else if (!record.detourWithinLimit) tag.textContent = "绕行超限";
      else if (!record.targetSocMet) tag.textContent = "目标电量不可达";
      else if (!record.feasible) tag.textContent = `超时 ${record.lateMinutes} 分钟`;
      else if (record.recommended) tag.textContent = "推荐";
      else if (record.isActualFastest) tag.textContent = `少 ${Math.max(1, Math.round((state.routeRecords.reliable.arrival - record.arrival)))} 分钟`;
      else if (record.isActualCheapest) tag.textContent = `省 ¥${Math.max(1, Math.round(state.routeRecords.fastest.cost - record.cost))}`;
      else if (record.costBackup) tag.textContent = "备选";
      else if (record.stableCollision) tag.textContent = "备选";
      else tag.textContent = `省 ¥${Math.max(1, Math.round(state.routeRecords.fastest.cost - record.cost))}`;
    }
    // 服务区候选点是真实的高德服务区 POI，但高德不告诉我们里面到底有没有
    // 充电桩/油枪——站点面板早就标了"补能设施待确认"，路线卡片却没有。
    // 对纯电用户来说，一个名字就叫"加油站"的候选点不带这句就是误导。
    const unconfirmedEquipment = (stations) => stations.some((station) => station && (station.serviceAreaCandidate || station.provisionalCorridor))
      ? " · 补能设施待确认"
      : "";
    if (stationLine) stationLine.textContent = displayCopy(record.directTrip
      ? `无需${isFuelActive() ? "加油" : "补能"} · 直达 ${state.destinationName} · 到达 ${record.arrivalSoc}%`
      : record.serviceOnly
        ? `服务停靠 · ${serviceName || "沿线服务"} · ETA 已按真实路线重算`
      : record.multiStop
        ? `连续${isFuelActive() ? "加油" : "补能"} ${record.stopCount} 次${serviceName ? ` · 含 ${serviceName}` : ""} · ${record.stops.map((stop) => stop.name).join(" → ")} · 到达 ${record.arrivalSoc}%${unconfirmedEquipment(record.stops || [])}`
      : !record.canReachStation
        ? (record.planningFailure || `当前余量不足以安全抵达候选${isFuelActive() ? "加油站" : "充电站"} · 不建议执行`)
        : `${isFuelActive() ? "加油" : "补能"} ${record.energyAmount}${record.energyUnit} · ${record.station?.name || "未匹配站点"}${serviceName ? ` · 含 ${serviceName}` : ""} · 到达 ${record.arrivalSoc}%${unconfirmedEquipment([record.station])}`);
    if (reason) {
      // 该策略的高德查询没返回独立路线，这里复用的是本次行程另一条真实路线。
      // 必须说出来，否则三张卡片看着像三条不同的路线。
      const policyNote = record.policyFallbackFrom
        ? `（高德未返回该策略的独立路线，此处沿用"${{ fastest: "最快到达", reliable: "最稳妥", cheapest: "最低成本" }[record.policyFallbackFrom] || record.policyFallbackFrom}"的真实路线）`
        : "";
      const withNote = (text) => (policyNote ? `${text}${policyNote}` : text);
      if (record.directTrip) {
        reason.textContent = displayCopy(withNote(`当前${isFuelActive() ? "油量" : "电量"}可满足${arrivalReserveDescription(record)}，不引入额外补能停靠。`));
        return;
      }
      if (record.serviceOnly) {
        reason.textContent = displayCopy(withNote(`已加入 ${serviceName || "沿线服务"} · 预计额外 ${record.servicePlan?.extraMinutes || 0} 分钟 · 到达余量 ${record.arrivalSoc}%。`));
        return;
      }
      if (record.multiStop) {
        if (!record.feasible) {
          reason.textContent = displayCopy(withNote(record.key === "cheapest"
            ? `高德低费用道路可将通行费降至 ¥${Math.round(record.roadTolls || 0)}，但预计晚到 ${record.lateMinutes} 分钟，不建议在当前时限下执行。`
            : `该补能策略未同时满足时限、到达余量或绕行约束，已保留为风险备选。`));
          return;
        }
        const summaries = {
          fastest: `高德时间优先道路 + 典型排队与补能服务更短；补能停靠总耗时 P50 ${record.totalStopMinutesP50} 分钟（排队 ${record.p50Wait} + 服务 ${record.serviceMinutes} + 支付驶离缓冲 ${record.paymentExitMinutes}）。`,
          reliable: `按到站时刻的预测 P90 比较尾部风险；当前补能停靠总耗时 P90 ${record.totalStopMinutesP90} 分钟（排队 P90 ${record.p90Wait} + 服务 ${record.serviceMinutes} + 支付驶离缓冲 ${record.paymentExitMinutes}）。`,
          cheapest: `费用 ¥${Math.round(record.cost)} = 补能 ¥${Math.round(record.energyCost || 0)} + 高德通行费 ¥${Math.round(record.roadTolls || 0)}；优先在模拟单价较低的站点补能。`
        };
         const baseReason = summaries[record.key] || `已逐段核验 ${record.stopCount} 次${isFuelActive() ? "加油" : "补能"}：补能停靠总耗时 P90 ${record.totalStopMinutesP90} 分钟。`;
        reason.textContent = displayCopy(withNote(serviceName ? `${baseReason} 已含服务停靠 ${serviceName}。` : baseReason));
        return;
      }
      if (!record.canReachStation) {
        reason.textContent = displayCopy(withNote(record.planningFailure || "候选站首段路程超出当前安全可达距离，已拦截该方案。"));
        return;
      }
      if (!record.detourWithinLimit) {
        // 城际行程放宽后的上限和用户看到的 8 km 不是一回事，要报实际用的那个，
        // 否则"超过 ≤8 km 约束"会去解释一条按 25 km 校验过的路线。
        reason.textContent = displayCopy(withNote(`实际绕行 ${Number(record.detour || 0).toFixed(1)} km，超过“绕行≤${activeDetourLimitKm(record)} km”约束。`));
        return;
      }
      const reasons = {
        fastest: `最终 ETA 最早 · 额外 ${record.station.detour} km · ${record.station.riskLabel}`,
        reliable: record.isActualCheapest ? `总成本最低 ¥${Math.round(record.cost)} · P90 ${record.station.p90} 分钟 · ${Math.round(record.onTime)}% 准时` : record.stableCollision ? `路线与站点的可解释备选 · P90 ${record.station.p90} 分钟 · ${Math.round(record.onTime)}% 准时` : record.feasible ? `P90 ${record.station.p90} 分钟 · 负载 ${(record.station.occupancy * 100).toFixed(0)}% · ${Math.round(record.onTime)}% 准时` : `风险备选，但超过到达时限 ${record.lateMinutes} 分钟`,
        cheapest: record.costBackup ? `路线与站点的可解释备选 · 绕行 ${record.station.detour} km · P90 ${record.station.p90} 分钟` : record.feasible ? `总成本最低 · 绕行 ${record.station.detour} km · 预计节省 ¥${Math.max(1, Math.round(state.routeRecords.fastest.cost - record.cost))}` : `成本备选，但超过到达时限，不建议执行`
      };
      reason.textContent = displayCopy(withNote(reasons[record.key]));
    }
  }

  function simulationTimeOfDay() {
    return state.departureMinutes >= 6 * 60 && state.departureMinutes < 18 * 60 ? "day" : "night";
  }

  function simulationStopsFor(record) {
    if (!record || record.directTrip) return [];
    if (record.multiStop && Array.isArray(record.stops)) return record.stops.filter((stop) => parseLocation(stop?.location));
    const station = record.station || record.stops?.[0];
    return station && parseLocation(station.location) ? [station] : [];
  }

  function simulationPathFor(record) {
    const path = Array.isArray(record?.path) ? record.path.map(parseLocation).filter(Boolean) : [];
    return path.length >= 2 ? path : [];
  }

  function simulationDriveDurationMs(record) {
    const duration = Number(record?.duration);
    const distance = Number(record?.distance);
    // The walkthrough compresses a real trip into a reviewable timeline, but it
    // must still leave enough time for the marker and AMap camera to keep up.
    // Route geometry and route metrics remain untouched; only playback time is
    // changed for the prototype experience.
    const estimate = Number.isFinite(duration) && duration > 0
      ? duration * 1600
      : Number.isFinite(distance) && distance > 0 ? distance * 210 : 30000;
    return Math.max(30000, Math.min(180000, Math.round(estimate)));
  }

  function simulationStopTarget(stop, path, fallbackProgress) {
    const location = parseLocation(stop?.location);
    const projection = location ? projectPointOntoPath(location, path) : null;
    const rawProgress = projection && projection.totalKm > 0
      ? projection.alongKm / projection.totalKm
      : fallbackProgress;
    const progress = Math.max(0.04, Math.min(0.96, Number.isFinite(rawProgress) ? rawProgress : fallbackProgress));
    return { progress, point: pointAtPathProgress(path, progress) };
  }

  function buildSimulationPhases(record) {
    const path = simulationPathFor(record);
    if (path.length < 2) return { path, phases: [] };
    const stops = simulationStopsFor(record);
    const driveDuration = simulationDriveDurationMs(record);
    const phases = [];
    let previousProgress = 0;
    const addDrive = (endProgress) => {
      const end = Math.max(previousProgress, Math.min(1, endProgress));
      const ratio = Math.max(0, end - previousProgress);
      if (ratio > 0.0001) {
        phases.push({ type: "drive", progressStart: previousProgress, progressEnd: end, durationMs: Math.max(1800, Math.round(driveDuration * ratio)), stop: null, targetPoint: pointAtPathProgress(path, end) });
      }
      previousProgress = end;
    };
    stops.forEach((stop, index) => {
      const fallback = (index + 1) / (stops.length + 1);
      const target = simulationStopTarget(stop, path, fallback);
      // Keep the station stop monotonic without adding the old 3.5% blind
      // jump. That jump could put the vehicle before the POI on one route and
      // past it on another. The marker now uses this exact projected point.
      const stopProgress = Math.min(0.96, Math.max(previousProgress + 0.006, target.progress));
      const stopPoint = pointAtPathProgress(path, stopProgress) || target.point;
      // Reservation is intentionally triggered just before the station rather
      // than after the car has already stopped. This mirrors the product story:
      // the system uses ETA to reserve the next available charging window as
      // arrival approaches, then the vehicle enters the station.
      if (!isFuelActive()) {
        const reservationLead = Math.min(0.018, Math.max(0.004, 3 / Math.max(1, routeDistance(path))));
        const reservationProgress = Math.max(previousProgress, stopProgress - reservationLead);
        addDrive(reservationProgress);
        const reservationBase = { stop, stopIndex: index, progressStart: reservationProgress, progressEnd: reservationProgress, targetPoint: pointAtPathProgress(path, reservationProgress) };
        phases.push({ ...reservationBase, type: "reservation", durationMs: SIMULATION_STAGE_MS.reservation });
      }
      addDrive(stopProgress);
      const base = { stop, stopIndex: index, progressStart: stopProgress, progressEnd: stopProgress, targetPoint: stopPoint };
      phases.push({ ...base, type: "recognition", durationMs: SIMULATION_STAGE_MS.recognition });
      phases.push({ ...base, type: "queue", durationMs: SIMULATION_STAGE_MS.queue });
      phases.push({ ...base, type: "service", durationMs: SIMULATION_STAGE_MS.service });
      phases.push({ ...base, type: "payment", durationMs: SIMULATION_STAGE_MS.payment });
      phases.push({ ...base, type: "leave", durationMs: SIMULATION_STAGE_MS.leave });
      previousProgress = stopProgress;
    });
    addDrive(1);
    phases.push({ type: "arrived", progressStart: 1, progressEnd: 1, durationMs: SIMULATION_STAGE_MS.arrived, stop: null });
    // A very short route can have no measurable drive segment after the last
    // stop. Keep the arrival phase so the user still sees completion clearly.
    return { path, phases, stops };
  }

  function simulationPhaseCopy(phase) {
    const stop = phase?.stop || {};
    const name = stop.name || `第 ${(phase?.stopIndex ?? 0) + 1} 个补能节点`;
    const fuel = isFuelActive();
    const p90 = Number(stop.p90 ?? stop.plannedP90 ?? stop.waitP90);
    const p50 = Number(stop.p50 ?? stop.plannedP50 ?? stop.waitP50);
    const serviceMinutes = Number(stop.chargeMinutes ?? stop.serviceMinutes ?? stop.refuelMinutes);
    switch (phase?.type) {
      case "drive": return { title: "沿路线行驶", meta: "车辆正在按已选路线前往下一个节点" };
      case "reservation": return { title: "即将到站 · 自动预约补能", meta: `${name} · 系统已根据 ETA 自动发起演示预约` };
      case "recognition": return { title: "进站车牌识别", meta: "尝试调用本地 PaddleOCR；识别失败不会生成虚假结果" };
      case "queue": return { title: "排队等待", meta: `${name} · ${Number.isFinite(p90) ? `P90 约 ${p90} 分钟` : Number.isFinite(p50) ? `典型约 ${p50} 分钟` : "等待时间为演示仿真"}` };
      case "service": return { title: fuel ? "加油服务" : "充电服务", meta: `${name} · ${Number.isFinite(serviceMinutes) ? `服务约 ${serviceMinutes} 分钟` : "服务时长为演示仿真"}` };
      case "payment": return { title: "离场自动扣款", meta: "演示车牌授权与电子收据流程，不连接真实支付" };
      case "leave": return { title: "完成补能，驶离站点", meta: "车辆离开停靠区，继续沿路线行驶" };
      case "arrived": return { title: "已到达目的地", meta: "本次模拟驾驶流程完成" };
      default: return { title: "准备出发", meta: "正在加载已选路线" };
    }
  }

  // Show the two endpoints before the route and station requests finish. This
  // prevents the map from staying at the old viewport while the UI says it is
  // calculating a new trip, and gives the reviewer an immediate visual cue
  // that the requested destination has been located.
  function previewDestinationComputation() {
    if (!state.live || !state.map || !state.AMap || !state.destination) return;
    clearLiveOverlays();
    state.selectedStation = null;
    const endpoints = addAmapEndpoints({ includeDestination: true });
    if (endpoints.length >= 2 && state.map.setFitView) {
      const distance = distanceKm(state.origin, state.destination);
      const maxZoom = distance >= 700 ? 8 : distance >= 300 ? 9 : distance >= 100 ? 10 : 12;
      state.map.setFitView(endpoints, false, [90, 390, 245, 410], maxZoom);
    } else {
      state.map.setZoomAndCenter(11, state.destination);
    }
    setMapStatus("目的地已定位 · 正在计算路线与沿线补能点");
    setText("mapAttribution", "高德地图 · 正在计算路线与补能点");
  }

  function simulationAssetFor(phase) {
    const energy = isFuelActive() ? "fuel" : "electric";
    const assets = SIMULATION_ASSETS[energy]?.[simulationTimeOfDay()];
    if (!assets) return null;
    if (phase?.type === "recognition" || phase?.type === "reservation") return assets.arrival;
    return assets.station;
  }

  function simulationSceneText(phase) {
    const energy = isFuelActive() ? "燃油" : "纯电";
    if (phase?.type === "reservation") return `这是${energy}车辆接近补能站的阶段素材。系统根据预计到站时间自动预约，不需要用户手动点击。`;
    if (phase?.type === "recognition") return `这是${energy}车辆到站素材，用于展示视觉链路。图片为 AI 生成样例，不代表实时摄像头。`;
    if (phase?.type === "queue") return `排队数量、端口占用和等待时长来自当前演示仿真；真实接入时由站点状态或企业数据替换。`;
    if (phase?.type === "service") return `展示${energy}补能场景。服务耗时是路线计算中的演示字段，不把图片识别当作服务完成依据。`;
    if (phase?.type === "payment") {
      const plate = state.simulation.recognizedPlate || (state.simulation.ocrFallbackUsed ? "预置样例车牌" : "已识别车牌");
      return `系统根据${plate}关联本次补能订单，在演示程序内自动生成扣款结果与电子收据；当前不调用真实支付接口。`;
    }
    return "AI 生成场景素材 · 用于模拟驾驶中的流程说明，不是实时摄像头画面。";
  }

  function simulationMetricValue(value, suffix = "") {
    return Number.isFinite(Number(value)) ? `${Number(value)}${suffix}` : "—";
  }

  function formatVisionTimestamp(value = null) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return "时间未知";
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
  }

  function simulationSnapshotFor(stop) {
    const canonical = state.stations.find((candidate) => String(candidate.id) === String(stop?.id)) || null;
    const station = canonical || state.selectedStation || stop || {};
    // A long-trip stop can be a compact copy created before the forecast
    // enrichment finishes. Keep the scene cards connected to the same
    // deterministic port snapshot used by /api/forecast instead of showing
    // empty placeholders while the right-hand forecast panel already has
    // usable station inputs.
    const fallback = buildDemoPortSnapshot(station);
    const input = canonical?.forecastInputSnapshot
      || canonical?.inputSnapshot
      || state.selectedStation?.forecastInputSnapshot
      || state.selectedStation?.inputSnapshot
      || stop?.forecastInputSnapshot
      || stop?.inputSnapshot
      || fallback;
    const firstFinite = (...values) => values.map(Number).find(Number.isFinite);
    const waitP50 = firstFinite(canonical?.p50, state.selectedStation?.p50, stop?.p50, canonical?.forecastArrivalWaitP50, state.selectedStation?.forecastArrivalWaitP50, stop?.forecastArrivalWaitP50, input.p50, fallback.p50, fallback.wait);
    const waitP90 = firstFinite(canonical?.p90, state.selectedStation?.p90, stop?.p90, canonical?.forecastArrivalWaitP90, state.selectedStation?.forecastArrivalWaitP90, stop?.forecastArrivalWaitP90, input.p90, fallback.p90, fallback.wait);
    const queue = firstFinite(input.queueVehicles, input.waitingVehicles, canonical?.queueVehicles, canonical?.waitingVehicles, state.selectedStation?.queueVehicles, state.selectedStation?.waitingVehicles, stop?.queueVehicles, stop?.waitingVehicles, fallback.queueVehicles, fallback.waitingVehicles);
    const total = firstFinite(input.totalPorts, canonical?.totalPorts, state.selectedStation?.totalPorts, stop?.totalPorts, fallback.totalPorts);
    const reserved = firstFinite(input.reservedPorts, canonical?.reservedPorts, state.selectedStation?.reservedPorts, stop?.reservedPorts, fallback.reservedPorts);
    const idle = firstFinite(input.idlePorts, canonical?.idlePorts, state.selectedStation?.idlePorts, stop?.idlePorts, fallback.idlePorts);
    const available = firstFinite(input.availablePorts, Number.isFinite(idle) && Number.isFinite(reserved) ? idle - reserved : undefined, canonical?.availablePorts, state.selectedStation?.availablePorts, stop?.availablePorts, fallback.availablePorts, fallback.idlePorts);
    const reservationQueueAhead = firstFinite(input.reservationQueueAhead, canonical?.reservationQueueAhead, state.selectedStation?.reservationQueueAhead, stop?.reservationQueueAhead, fallback.reservationQueueAhead);
    const charging = firstFinite(input.chargingPorts, canonical?.chargingPorts, state.selectedStation?.chargingPorts, stop?.chargingPorts, fallback.chargingPorts);
    const fault = firstFinite(input.faultPorts, canonical?.faultPorts, state.selectedStation?.faultPorts, stop?.faultPorts, fallback.faultPorts);
    const averageSession = firstFinite(input.averageSessionMinutes, canonical?.averageSessionMinutes, state.selectedStation?.averageSessionMinutes, stop?.averageSessionMinutes, fallback.averageSessionMinutes);
    const service = firstFinite(stop?.serviceMinutes, stop?.chargeMinutes, stop?.refuelMinutes, canonical?.serviceMinutes, canonical?.chargeMinutes, canonical?.refuelMinutes, state.selectedStation?.serviceMinutes, state.selectedStation?.chargeMinutes, state.selectedStation?.refuelMinutes, input.averageSessionMinutes, fallback.averageSessionMinutes);
    return {
      station,
      waitP50,
      waitP90,
      queue,
      idle,
      available,
      total,
      reserved,
      reservationQueueAhead,
      charging,
      fault,
      averageSession,
      service,
      source: station.forecastSource || input.dataSource || "FlowTwin 演示仿真"
    };
  }

  const SIMULATION_STATION_PHASES = new Set(["reservation", "recognition", "queue", "service", "payment", "leave"]);
  const SIMULATION_FLOW_STAGES = ["reservation", "recognition", "queue", "service", "payment"];

  function isSimulationStationPhase(phase) {
    return Boolean(phase && SIMULATION_STATION_PHASES.has(phase.type) && phase.stop);
  }

  function simulationStopIndexToSkip() {
    const simulation = state.simulation;
    const phases = simulation.phases || [];
    const current = simulation.phase || phases[simulation.phaseIndex];
    if (!current) return null;
    if (Number.isInteger(current.stopIndex)) return current.stopIndex;
    for (let index = Math.max(0, simulation.phaseIndex + 1); index < phases.length; index += 1) {
      const phase = phases[index];
      if (isSimulationStationPhase(phase) && Number.isInteger(phase.stopIndex)) return phase.stopIndex;
    }
    return null;
  }

  function simulationSkipTargetIndex(stopIndex) {
    const phases = state.simulation.phases || [];
    if (!Number.isInteger(stopIndex)) return null;
    for (let index = Math.max(0, state.simulation.phaseIndex); index < phases.length; index += 1) {
      const phase = phases[index];
      if (phase?.type === "leave" && phase.stopIndex === stopIndex) return index + 1;
    }
    return null;
  }

  function canSkipSimulationStop() {
    const simulation = state.simulation;
    if (!simulation.active || !simulation.phases.length || simulation.phase?.type === "arrived") return false;
    return simulationSkipTargetIndex(simulationStopIndexToSkip()) !== null;
  }

  function skipSimulationEnergyStop() {
    const simulation = state.simulation;
    if (!canSkipSimulationStop()) return;
    const stopIndex = simulationStopIndexToSkip();
    const targetIndex = simulationSkipTargetIndex(stopIndex);
    if (!Number.isInteger(stopIndex) || !Number.isInteger(targetIndex)) return;
    simulation.skippedStopIndexes.add(stopIndex);
    if (simulation.rafId) window.cancelAnimationFrame(simulation.rafId);
    simulation.rafId = null;
    simulation.reservationPending = false;
    simulation.recognitionResolved = true;
    simulation.ocrFallbackAvailable = false;
    simulation.paused = false;
    showToast(`已跳过第 ${stopIndex + 1} 个补能节点演示，车辆继续沿路线行驶`, 2800);
    if (targetIndex >= simulation.phases.length) {
      simulation.phase = { type: "arrived", progressStart: 1, progressEnd: 1, durationMs: 0, stop: null };
      simulation.progress = 1;
      simulation.paused = true;
      renderSimulationPhase(simulation.phase);
      updateSimulationMarker();
      return;
    }
    simulationEnterPhase(targetIndex);
  }

  function simulationStageGroupFor(phase) {
    if (phase?.type === "arrived") return { label: "已完成", icon: "check-circle-2" };
    if (isSimulationStationPhase(phase)) return { label: "进站服务", icon: "building-2" };
    return { label: "路上", icon: "navigation" };
  }

  function simulationActionFor(phase) {
    const simulation = state.simulation;
    if (!phase) return { visible: false };
    switch (phase.type) {
      case "reservation": {
        const pending = Boolean(simulation.reservationPending);
        return {
          visible: true,
          disabled: pending,
          label: pending ? "正在更新到站预测" : "继续行驶至补能站",
          icon: pending ? "loader-circle" : "navigation",
          note: pending ? "系统正在把预约队列纳入 P50 / P90 重新计算。" : "已自动预约；点击中央按钮继续，站内流程由您手动查看。"
        };
      }
      case "recognition":
        return simulation.recognitionResolved
          ? { visible: true, label: "进入排队预测", icon: "bar-chart-3", note: "车牌识别结果已确认，下一步查看排队与端口状态。" }
          : { visible: false };
      case "queue":
        return { visible: true, label: "进入补能服务", icon: isFuelActive() ? "fuel" : "battery-charging", note: "先看清 P50 / P90、排队车辆和空闲补能位，再进入服务。" };
      case "service":
        return { visible: true, label: "完成补能并生成电子收据", icon: "receipt", note: "服务时长为演示/企业先验推演，不代表真实订单已完成。" };
      case "payment":
        return { visible: true, label: "确认离场", icon: "log-out", note: "根据已识别车牌在演示程序内自动生成扣款与电子收据，不执行真实支付。" };
      case "leave":
        return { visible: true, label: "继续沿路线行驶", icon: "route", note: "车辆驶离停靠区，返回高德路线继续导航。" };
      case "arrived":
        return { visible: true, label: "结束本次演示", icon: "x", note: "演示结果会保留在当前卡片，点击后返回路线方案。" };
      default:
        return { visible: false };
    }
  }

  function renderSimulationStageRail(phase) {
    const rail = byId("simulationStageRail");
    if (!rail) return;
    const stationPhase = isSimulationStationPhase(phase);
    rail.hidden = !stationPhase;
    if (!stationPhase) return;
    const reservationStep = rail.querySelector('[data-simulation-stage="reservation"]');
    if (reservationStep) {
      reservationStep.hidden = isFuelActive();
      reservationStep.textContent = isFuelActive() ? "到站确认" : "提前预约";
      reservationStep.classList.toggle("is-unavailable", isFuelActive());
    }
    const currentIndex = SIMULATION_FLOW_STAGES.indexOf(phase.type);
    rail.querySelectorAll("[data-simulation-stage]").forEach((step) => {
      const key = step.dataset.simulationStage;
      const index = SIMULATION_FLOW_STAGES.indexOf(key);
      step.classList.toggle("is-current", key === phase.type);
      step.classList.toggle("is-done", index >= 0 && currentIndex >= 0 && index < currentIndex);
    });
    if (phase.type === "leave") {
      rail.querySelectorAll("[data-simulation-stage]").forEach((step) => {
        if (!step.hidden) {
          step.classList.remove("is-current");
          step.classList.add("is-done");
        }
      });
    }
  }

  function renderSimulationSceneAction(phase) {
    const wrapper = byId("simulationSceneAction");
    const button = byId("simulationScenePrimaryButton");
    const note = byId("simulationSceneActionNote");
    if (!wrapper || !button) return;
    const action = simulationActionFor(phase);
    wrapper.hidden = !action.visible;
    if (!action.visible) return;
    button.disabled = Boolean(action.disabled);
    button.innerHTML = `<i data-lucide="${action.icon || "arrow-right"}"></i><span>${action.label}</span>`;
    if (note) note.textContent = action.note || "";
  }

  function renderSimulationCompletion(phase, card, image, title, badge, text) {
    card.classList.add("is-complete");
    card.hidden = false;
    const media = card.querySelector(".simulation-scene-media");
    if (media) media.hidden = true;
    byId("simulationReservationSignal")?.setAttribute("hidden", "");
    byId("simulationReservationEvidenceToggle")?.setAttribute("hidden", "");
    byId("simulationReservationEvidence")?.setAttribute("hidden", "");
    byId("simulationStageRail")?.setAttribute("hidden", "");
    byId("simulationOcrRow")?.setAttribute("hidden", "");
    byId("simulationDataGrid")?.setAttribute("hidden", "");
    byId("simulationDataSource")?.setAttribute("hidden", "");
    byId("simulationQueueNote")?.setAttribute("hidden", "");
    byId("simulationOcrDetail")?.setAttribute("hidden", "");
    if (title) title.textContent = "本次模拟驾驶完成";
    if (badge) badge.textContent = "流程回顾";
    if (text) {
      text.hidden = false;
      text.textContent = `车辆已沿${state.simulation.record?.displayName || "已选路线"}到达${state.destinationName || "目的地"}，站内关键链路已按当前演示数据完成一轮回放。`;
    }
    const body = byId("simulationCompletionBody");
    const list = byId("simulationCompletionList");
    if (body) body.hidden = false;
    if (list) {
      const ocrCopy = state.simulation.ocrFallbackUsed
        ? "车牌识别：预置样例托底"
        : state.simulation.recognizedPlate
          ? `本地 PaddleOCR：${state.simulation.recognizedPlate}`
          : "本地 PaddleOCR：已执行";
      const items = [
        ["map", "高德真实路线与车辆追踪"],
        ["calendar-clock", `提前预约演示：${state.simulation.reservedStops?.size || 0} 个节点`],
        ["scan-line", ocrCopy],
        ["chart-no-axes", "P50 / P90 排队预测"],
        [isFuelActive() ? "fuel" : "battery-charging", "补能服务时长推演"],
        ["receipt", "车牌关联与演示电子收据"]
      ];
      list.innerHTML = items.map(([icon, label]) => `<div class="simulation-completion-item"><i data-lucide="${icon}"></i><span>${label}</span></div>`).join("");
    }
    renderSimulationSceneAction(phase);
  }

  function renderSimulationReservationEvidence(phase) {
    const toggle = byId("simulationReservationEvidenceToggle");
    const panel = byId("simulationReservationEvidence");
    if (!toggle || !panel) return;
    const isReservation = phase?.type === "reservation";
    toggle.hidden = !isReservation;
    if (!isReservation) {
      toggle.setAttribute("aria-expanded", "false");
      panel.hidden = true;
      panel.innerHTML = "";
      return;
    }
    const simulation = state.simulation;
    const before = simulation.reservationBeforeSnapshot || {};
    const after = simulation.reservationAfterSnapshot || before;
    const snapshot = after || before;
    const numberText = (value, suffix = "") => Number.isFinite(Number(value)) ? `${Number(value)}${suffix}` : "—";
    const available = Number.isFinite(Number(snapshot.available)) ? `${snapshot.available}/${numberText(snapshot.total)}` : "—";
    const queue = numberText(snapshot.queue, " 辆");
    const reservationAhead = numberText(snapshot.reservationQueueAhead, " 辆");
    const beforeAfter = Number.isFinite(Number(before.waitP50)) && Number.isFinite(Number(after.waitP50))
      ? `P50 ${before.waitP50} → ${after.waitP50} 分钟；P90 ${numberText(before.waitP90, " 分钟")} → ${numberText(after.waitP90, " 分钟")}`
      : "预约前后等待预测将在可用输入完整时对比";
    const eta = formatClock(Number(phase.stop?.arrivalMinute ?? state.departureMinutes));
    const station = escapeHtml(phase.stop?.name || "下一补能站");
    panel.innerHTML = [
      `<div class="simulation-reservation-evidence-row"><strong>触发条件</strong><span>车辆预计 ${eta} 到达「${station}」，系统在接近站点前预先写入预约状态。</span></div>`,
      `<div class="simulation-reservation-evidence-row"><strong>输入快照</strong><span>可用补能位 ${available} · 充电中 ${numberText(snapshot.charging, " 个")} · 已预约 ${numberText(snapshot.reserved, " 个")} · 已到站等待 ${queue} · 预约队列前方 ${reservationAhead}。</span></div>`,
      `<div class="simulation-reservation-evidence-row"><strong>计算过程</strong><span>把本车预计到站时刻加入端口离散事件队列，按端口释放时间、平均服务时长和预约队列前方车辆重新排程，再输出等待 P50/P90。</span></div>`,
      `<div class="simulation-reservation-evidence-row"><strong>本次结果</strong><span>${beforeAfter}</span></div>`,
      `<div class="simulation-reservation-evidence-row"><strong>数据边界</strong><span>${escapeHtml(String(snapshot.source || "FlowTwin 演示仿真"))}；这是本地演示/企业需求先验推演，不是实时站点经营数据。</span></div>`
    ].join("");
    const expanded = Boolean(simulation.reservationEvidenceOpen);
    toggle.setAttribute("aria-expanded", String(expanded));
    const label = toggle.querySelector("span");
    if (label) label.textContent = expanded ? "收起计算依据" : "展开计算依据";
    panel.hidden = !expanded;
  }

  function renderSimulationScene(phase) {
    const card = byId("simulationSceneCard");
    const image = byId("simulationSceneImage");
    const title = byId("simulationSceneTitle");
    const badge = byId("simulationSceneBadge");
    const text = byId("simulationSceneText");
    const ocrRow = byId("simulationOcrRow");
    if (!card || !image || !phase) {
      if (card) card.hidden = true;
      byId("simulationDataGrid")?.setAttribute("hidden", "");
      byId("simulationDataSource")?.setAttribute("hidden", "");
      byId("simulationQueueNote")?.setAttribute("hidden", "");
      byId("simulationSceneAction")?.setAttribute("hidden", "");
      byId("simulationCompletionBody")?.setAttribute("hidden", "");
      return;
    }
    if (phase.type === "arrived") {
      renderSimulationCompletion(phase, card, image, title, badge, text);
      return;
    }
    if (!isSimulationStationPhase(phase)) {
      card.hidden = true;
      card.classList.remove("is-complete");
      const media = card.querySelector(".simulation-scene-media");
      if (media) media.hidden = false;
      byId("simulationReservationSignal")?.setAttribute("hidden", "");
      byId("simulationReservationEvidenceToggle")?.setAttribute("hidden", "");
      byId("simulationReservationEvidence")?.setAttribute("hidden", "");
      byId("simulationStageRail")?.setAttribute("hidden", "");
      byId("simulationSceneAction")?.setAttribute("hidden", "");
      byId("simulationCompletionBody")?.setAttribute("hidden", "");
      byId("simulationDataGrid")?.setAttribute("hidden", "");
      byId("simulationDataSource")?.setAttribute("hidden", "");
      byId("simulationQueueNote")?.setAttribute("hidden", "");
      return;
    }
    const asset = simulationAssetFor(phase);
    card.hidden = false;
    card.classList.remove("is-complete");
    const media = card.querySelector(".simulation-scene-media");
    if (media) media.hidden = false;
    byId("simulationCompletionBody")?.setAttribute("hidden", "");
    const sceneKey = `${phase.type}:${phase.stopIndex ?? ""}`;
    const sameScene = image.dataset.simulationSceneKey === sceneKey;
    if (!sameScene) {
      image.dataset.simulationSceneKey = sceneKey;
      image.src = asset || "";
      image.alt = `${isFuelActive() ? "燃油" : "纯电"}车辆${simulationTimeOfDay() === "day" ? "白天" : "夜间"}补能演示素材`;
      image.onerror = () => { image.removeAttribute("src"); if (badge) badge.textContent = "素材未找到"; };
      if (badge) badge.textContent = asset ? "AI 生成素材" : "素材待替换";
    }
    if (title) {
        title.textContent = phase.type === "reservation"
        ? "预约队列已更新"
        : phase.type === "recognition"
          ? "到站视觉画面"
          : phase.type === "queue"
            ? "排队状态预测"
            : phase.type === "service"
              ? (isFuelActive() ? "加油服务" : "充电服务")
              : phase.type === "payment"
                ? "离场扣款流程"
                : "驶离补能站";
    }
    const snapshot = simulationSnapshotFor(phase.stop);
    if (text) text.textContent = phase.type === "reservation"
      ? `预约已自动触发。车辆继续沿高德路线行驶，预计 ${formatClock(Number(phase.stop?.arrivalMinute ?? state.departureMinutes))} 到达${phase.stop?.name || "下一补能站"}。`
      : simulationSceneText(phase);
    let dataGrid = byId("simulationDataGrid");
    if (!dataGrid) {
      dataGrid = document.createElement("div");
      dataGrid.id = "simulationDataGrid";
      dataGrid.className = "simulation-data-grid";
      text?.after(dataGrid);
    }
    const recognitionValue = state.simulation.recognitionResolved
      ? (state.simulation.ocrFallbackUsed ? "预置样例继续" : state.simulation.recognizedPlate || "已识别")
      : "待执行本地 OCR";
    const paymentPlate = state.simulation.recognizedPlate || (state.simulation.ocrFallbackUsed ? "预置样例车牌" : "已识别车牌");
    const stageItems = phase.type === "reservation"
      ? [["预约状态", state.simulation.reservationPending ? "计算中" : "已自动预约"], ["预计到站", formatClock(Number(phase.stop?.arrivalMinute ?? state.departureMinutes))]]
        : phase.type === "recognition"
          ? [["车牌链路", recognitionValue], ["到站状态", "已进入识别区"]]
        : phase.type === "queue"
          ? [["到站预计排队 P50", simulationMetricValue(snapshot.waitP50, " 分钟")], ["到站尾部排队 P90", simulationMetricValue(snapshot.waitP90, " 分钟")], ["当前可用补能位", Number.isFinite(snapshot.available) ? `${snapshot.available}/${snapshot.total}` : "—"], ["当前等待/预约", simulationMetricValue((Number(snapshot.queue) || 0) + (Number(snapshot.reservationQueueAhead) || 0), " 辆")]]
          : phase.type === "service"
            ? [[isFuelActive() ? "加油服务" : "充电服务", simulationMetricValue(snapshot.service, " 分钟")], ["预约占用", simulationMetricValue(snapshot.reserved, " 个")]]
          : phase.type === "payment"
              ? [["扣款依据", `车牌 ${paymentPlate} 关联订单`], ["扣款结果", "程序内自动完成（演示）"], ["电子收据", "已生成（演示）"]]
              : [["站点状态", "已完成补能"], ["下一动作", "继续沿路线行驶"]];
    dataGrid.innerHTML = stageItems.map(([label, value], index) => `<div class="simulation-data-item${index === 0 ? " is-primary" : ""}"><span>${escapeHtml(String(label))}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("");
    dataGrid.hidden = false;
    let source = byId("simulationDataSource");
    if (!source) {
      source = document.createElement("div");
      source.id = "simulationDataSource";
      source.className = "simulation-data-source";
      dataGrid.after(source);
    }
    source.textContent = phase.type === "recognition"
      ? "视觉素材：AI 生成样例；OCR：本地 PaddleOCR 实际调用；若服务回传标注图则展示标注结果，否则只展示结构化响应。"
      : `数据依据：${snapshot.source} · 排队/端口/服务时长仍是演示或企业先验推演。`;
    source.hidden = false;
    let queueNote = byId("simulationQueueNote");
    if (!queueNote) {
      queueNote = document.createElement("div");
      queueNote.id = "simulationQueueNote";
      queueNote.className = "simulation-queue-note";
      source.after(queueNote);
    }
    queueNote.hidden = phase.type !== "queue";
    if (phase.type === "queue") {
      const available = Number(snapshot.available);
      const total = Number(snapshot.total);
      const waiting = Math.max(0, Number(snapshot.queue) || 0);
      const reservationAhead = Math.max(0, Number(snapshot.reservationQueueAhead) || 0);
      if (Number.isFinite(available) && available > 0) {
        queueNote.textContent = `当前快照仍有 ${available}/${Number.isFinite(total) ? total : "—"} 个可用补能位；“当前等待/预约”仅统计此刻已到站等待 ${waiting} 辆 + 预约队列前方 ${reservationAhead} 辆。P50/P90 是按本车预计到站时刻重排的预测，途中新增需求与端口释放会纳入，因此当前有空闲位不等于到站时仍无需等待。`;
      } else {
        queueNote.textContent = `当前没有可用补能位；“当前等待/预约”为已到站等待 ${waiting} 辆 + 预约队列前方 ${reservationAhead} 辆。P50/P90 是按本车预计到站时刻重排的仿真结果，不是当前瞬时排队人数。`;
      }
    }
    let ocrDetail = byId("simulationOcrDetail");
    if (!ocrDetail) {
      ocrDetail = document.createElement("div");
      ocrDetail.id = "simulationOcrDetail";
      ocrDetail.className = "simulation-ocr-detail";
      source.after(ocrDetail);
    }
    ocrDetail.hidden = phase.type !== "recognition";
    if (phase.type === "recognition" && state.simulation.ocrAttemptedFor !== phase.stopIndex && !state.simulation.recognitionResolved) {
      ocrDetail.classList.remove("is-success");
      ocrDetail.textContent = "请点击“执行本地 OCR”。如果本地服务未返回可用结果，可明确选择预置样例继续；不会把素材中的文字冒充识别结果。";
    }
    if (ocrRow) ocrRow.hidden = phase.type !== "recognition";
    const ocrStatus = byId("simulationOcrStatus");
    const ocrFallbackButton = byId("simulationOcrFallbackButton");
    if (phase.type === "recognition") {
      if (ocrStatus && state.simulation.ocrAttemptedFor !== phase.stopIndex && !state.simulation.recognitionResolved) ocrStatus.textContent = "等待执行本地 OCR";
      if (ocrFallbackButton) ocrFallbackButton.hidden = !state.simulation.ocrFallbackAvailable || state.simulation.recognitionResolved;
    } else if (ocrFallbackButton) {
      ocrFallbackButton.hidden = true;
    }
    const ocrButton = byId("simulationOcrButton");
    if (ocrButton && phase.type === "recognition") {
      ocrButton.disabled = state.simulation.ocrBusy || state.simulation.recognitionResolved;
      ocrButton.textContent = state.simulation.ocrBusy ? "识别中…" : state.simulation.ocrAttemptedFor === phase.stopIndex ? "再次执行 OCR" : "执行本地 OCR";
    }
    const reservationSignal = byId("simulationReservationSignal");
    if (reservationSignal) reservationSignal.hidden = phase.type !== "reservation";
    renderSimulationReservationEvidence(phase);
    if (phase.type === "reservation") {
      setText("simulationReservationStation", phase.stop?.name || "下一补能站");
      setText("simulationReservationEta", `预计到站 ${formatClock(Number(phase.stop?.arrivalMinute ?? state.departureMinutes))}`);
      setText("simulationReservationCopy", state.simulation.reservationPending ? "系统正在根据预计到站时间安排补能窗口，并重新计算预约队列。" : "系统已根据预计到站时间自动安排补能窗口，无需手动操作。 ");
      const before = state.simulation.reservationBeforeSnapshot;
      const after = state.simulation.reservationAfterSnapshot;
      const delta = byId("simulationReservationDelta");
      if (delta) {
        if (state.simulation.reservationPending) delta.textContent = "预约处理完成后，P50 / P90 等待预测会在此处更新。";
        else if (before && after && Number.isFinite(before.waitP50) && Number.isFinite(after.waitP50)) delta.textContent = `预约前后已重算：P50 ${before.waitP50} → ${after.waitP50} 分钟 · P90 ${simulationMetricValue(after.waitP90, " 分钟")}。`;
        else delta.textContent = "预约已写入本轮演示状态；等待预测仍以演示/企业先验推演为依据。";
      }
    }
    renderSimulationStageRail(phase);
    renderSimulationSceneAction(phase);
  }

  function renderSimulationPhase(phase) {
    const copy = simulationPhaseCopy(phase);
    const group = simulationStageGroupFor(phase);
    setText("simulationPhaseTitle", copy.title);
    setText("simulationPhaseMeta", copy.meta);
    setText("simulationPhaseIndex", String(state.simulation.phaseIndex + 1).padStart(2, "0"));
    setText("simulationStageGroup", group.label);
    setText("simulationSpeedReadout", `${state.simulation.speed}×`);
    $$('[data-simulation-speed]').forEach((button) => button.classList.toggle("active", Number(button.dataset.simulationSpeed) === Number(state.simulation.speed)));
    setText("simulationAutoState", state.simulation.autoAdvance ? "路线自动 · 站内手动" : "全程手动推进");
    const total = Math.max(1, state.simulation.phases.length);
    const progress = byId("simulationProgressBar");
    if (progress) progress.style.width = `${Math.max(0, Math.min(100, state.simulation.progress * 100))}%`;
    const pause = byId("simulationPauseButton");
    if (pause) {
      const manual = !state.simulation.autoAdvance;
      const stationManual = isSimulationStationPhase(phase);
      const completed = phase?.type === "arrived";
      pause.disabled = manual || stationManual || completed;
      pause.innerHTML = manual
        ? '<i data-lucide="hand"></i><span>手动推进中</span>'
        : stationManual
          ? '<i data-lucide="hand"></i><span>站内手动推进</span>'
          : completed
            ? '<i data-lucide="check"></i><span>演示已完成</span>'
        : `<i data-lucide="${state.simulation.paused ? "play" : "pause"}"></i><span>${state.simulation.paused ? "继续模拟" : "暂停模拟"}</span>`;
    }
    const next = byId("simulationNextButton");
    if (next) {
      const arrived = phase?.type === "arrived";
      const recognitionPending = phase?.type === "recognition" && !state.simulation.recognitionResolved;
      const stationPhase = isSimulationStationPhase(phase);
      next.hidden = arrived || stationPhase;
      next.disabled = arrived || recognitionPending;
      next.innerHTML = arrived
        ? '<i data-lucide="check"></i><span>已到达目的地</span>'
        : recognitionPending
          ? '<i data-lucide="scan-line"></i><span>请先完成车牌识别</span>'
          : phase?.type === "drive"
            ? '<i data-lucide="route"></i><span>行驶至下一节点</span>'
            : '<i data-lucide="skip-forward"></i><span>进入下一阶段</span>';
    }
    const skipStop = byId("simulationSkipStopButton");
    if (skipStop) {
      const canSkip = canSkipSimulationStop();
      const reservationPending = phase?.type === "reservation" && state.simulation.reservationPending;
      skipStop.hidden = !canSkip;
      skipStop.disabled = !canSkip || reservationPending;
      skipStop.innerHTML = reservationPending
        ? '<i data-lucide="loader-circle"></i><span>预约处理中…</span>'
        : '<i data-lucide="skip-forward"></i><span>跳过本次充能演示</span>';
    }
    // Keep the toolbox discoverable throughout the walkthrough. It starts
    // expanded when simulation begins and only changes state when the user
    // explicitly clicks its toggle; station-phase rendering must not hide the
    // controls before the evaluator has a chance to see them.
    const destination = byId("simulationDestination");
    if (destination) destination.textContent = state.destinationName || "目的地";
    const navMeta = byId("simulationNavMeta");
    if (navMeta) navMeta.textContent = `${state.simulation.phaseIndex + 1}/${total} 阶段 · ${group.label} · ${state.simulation.record?.displayName || "已选方案"}`;
    renderSimulationScene(phase);
    refreshIcons();
  }

  async function autoReserveSimulationStop(stop) {
    if (!stop?.id || isFuelActive()) return;
    const key = String(stop.id);
    if (state.simulation.reservedStops.has(key)) return;
    state.simulation.reservedStops.add(key);
    state.simulation.reservationPending = true;
    state.simulation.reservationStopKey = key;
    state.simulation.reservationAfterSnapshot = null;
    state.reservationOverrides[key] = 1;
    state.stationForecastScenarioKey = null;
    const station = state.stations.find((candidate) => String(candidate.id) === key) || stop;
    state.selectedStation = station;
    selectStation(station, false);
    try {
      const base = state.baseRouteRecords.reliable || state.routeRecords.reliable;
      if (base) await ensureStationForecasts(base);
      const updated = state.stations.find((candidate) => String(candidate.id) === key) || station;
      state.selectedStation = updated;
      selectStation(updated, false);
      state.simulation.reservationAfterSnapshot = simulationSnapshotFor(updated);
      showToast(`已为您自动预约${updated.name || "下一补能站"}，等待时间已按预约队列重算`, 3200);
    } catch (error) {
      state.simulation.reservationAfterSnapshot = simulationSnapshotFor(station);
      showToast(`已记录预约演示状态，等待预测暂沿用当前数据 · ${error?.message || "服务稍后重试"}`, 3600);
    } finally {
      state.simulation.reservationPending = false;
      const phase = state.simulation.phase;
      if (phase?.stop && String(phase.stop.id) === key) {
        // Freeze the completed reservation card in automatic playback.  The
        // reviewer must be able to read the station, ETA, before/after P50/P90
        // and the expandable calculation evidence before the next phase starts.
        if (state.simulation.autoAdvance && phase.type === "reservation") {
          state.simulation.phaseElapsedMs = Number(phase.durationMs || SIMULATION_STAGE_MS.reservation);
          state.simulation.paused = true;
        }
        renderSimulationPhase(phase);
      }
    }
  }

  function fallbackSimulationPoint(point) {
    const mapElement = byId("map");
    if (!mapElement || !Array.isArray(point)) return null;
    const startLat = FALLBACK.origin[1];
    const endLat = FALLBACK.destination[1];
    const startLng = FALLBACK.origin[0];
    const endLng = FALLBACK.destination[0];
    const progress = Math.max(0, Math.min(1, (startLat - point[1]) / (startLat - endLat)));
    const expectedLng = startLng + (endLng - startLng) * progress;
    const x = 590 + progress * 500 + (point[0] - expectedLng) * 2500;
    const y = 170 + progress * 560;
    const rect = mapElement.getBoundingClientRect();
    const scale = Math.max(rect.width / 1440, rect.height / 900);
    return { left: (rect.width - 1440 * scale) / 2 + x * scale, top: (rect.height - 900 * scale) / 2 + y * scale };
  }

  function updateSimulationMarker() {
    const simulation = state.simulation;
    if (!simulation.active || !simulation.path?.length) return;
    const point = simulation.phase?.type !== "drive" && Array.isArray(simulation.phase?.targetPoint)
      ? simulation.phase.targetPoint
      : pointAtPathProgress(simulation.path, simulation.progress, simulation.pathMetrics);
    if (!point) return;
    if (simulation.marker?.setPosition) {
      simulation.marker.setPosition(point);
      // Keep the camera and marker on the same point. During a drive phase the
      // camera follows at a stable cadence; when a manual step enters a new
      // station phase it recentres once on the exact projected stop point.
      const now = performance.now();
      const phaseChanged = simulation.lastCenteredPhaseIndex !== simulation.phaseIndex;
      if (state.map?.setCenter && (phaseChanged || simulation.phase?.type === "drive")
        && (phaseChanged || now - simulation.lastMapCenterAt >= 70)) {
        state.map.setCenter(point);
        simulation.lastMapCenterAt = now;
        simulation.lastCenteredPhaseIndex = simulation.phaseIndex;
      }
    }
    if (simulation.fallbackMarker) {
      const position = fallbackSimulationPoint(point);
      if (position) {
        simulation.fallbackMarker.style.left = `${position.left}px`;
        simulation.fallbackMarker.style.top = `${position.top}px`;
      }
    }
    const progress = byId("simulationProgressBar");
    if (progress) progress.style.width = `${Math.max(0, Math.min(100, simulation.progress * 100))}%`;
  }

  function simulationMarkerContent() {
    return '<span class="simulation-vehicle-marker" aria-label="模拟车辆"><span aria-hidden="true">▲</span></span>';
  }

  function removeSimulationMarker() {
    if (state.simulation.marker?.setMap) state.simulation.marker.setMap(null);
    state.simulation.marker = null;
    state.simulation.fallbackMarker?.remove?.();
    state.simulation.fallbackMarker = null;
  }

  function createSimulationMarker() {
    removeSimulationMarker();
    const point = pointAtPathProgress(state.simulation.path, state.simulation.progress, state.simulation.pathMetrics);
    if (!point) return;
    if (state.live && state.map && state.AMap) {
      const marker = new state.AMap.Marker({ position: point, content: simulationMarkerContent(), offset: new state.AMap.Pixel(-15, -15), zIndex: 190, title: "模拟车辆" });
      marker.setMap(state.map);
      state.simulation.marker = marker;
    } else {
      const marker = document.createElement("span");
      marker.className = "simulation-fallback-marker";
      marker.setAttribute("aria-label", "模拟车辆");
      byId("map")?.appendChild(marker);
      state.simulation.fallbackMarker = marker;
    }
    updateSimulationMarker();
  }

  function simulationEnterPhase(index) {
    const simulation = state.simulation;
    const phase = simulation.phases[index];
    if (!phase) return;
    simulation.reservationEvidenceOpen = false;
    simulation.phaseIndex = index;
    simulation.phaseElapsedMs = 0;
    simulation.phase = phase;
    simulation.progress = phase.progressStart ?? simulation.progress;
    // Keep the selected playback speed for route segments. Station stages are
    // manually inspected, so their readout deliberately returns to 1×; the
    // next drive segment restores the preferred route speed.
    simulation.speed = phase.type === "drive" ? Number(simulation.preferredSpeed || 3) : 1;
    if (phase.type === "recognition") {
      simulation.recognitionResolved = false;
      simulation.ocrFallbackUsed = false;
      simulation.ocrFallbackAvailable = false;
      simulation.ocrBusy = false;
      simulation.ocrPhaseKey = phase.stopIndex;
      simulation.ocrAttemptedFor = null;
      simulation.recognizedPlate = null;
    }
    if (phase.type === "reservation") {
      simulation.reservationPending = true;
      simulation.reservationStopKey = phase.stop?.id ? String(phase.stop.id) : null;
      simulation.reservationBeforeSnapshot = simulationSnapshotFor(phase.stop);
      simulation.reservationAfterSnapshot = null;
    }
    // The checkbox controls only route playback. Once a vehicle reaches the
    // reservation/arrival card, every station stage is deliberately manual so
    // the reviewer can inspect OCR, queue prediction, service and payment.
    simulation.paused = simulation.autoAdvance && phase.type !== "drive";
    if (phase.stop && ["reservation", "recognition", "queue", "service", "payment", "leave"].includes(phase.type)) {
      const station = state.stations.find((candidate) => String(candidate.id) === String(phase.stop.id)) || phase.stop;
      state.selectedStation = station;
      selectStation(station, false);
      revealSimulationStationPanel();
    }
    renderSimulationPhase(phase);
    updateSimulationMarker();
    if (simulation.autoAdvance && phase.type === "drive" && !simulation.paused && !simulation.rafId) {
      simulation.lastFrameAt = performance.now();
      simulation.rafId = window.requestAnimationFrame(simulationFrame);
    }
    if (phase.type === "reservation") void autoReserveSimulationStop(phase.stop);
  }

  function handleSimulationSceneAction() {
    const simulation = state.simulation;
    if (!simulation.active || !simulation.phase) return;
    if (simulation.phase.type === "arrived") {
      stopSimulationDriving();
      return;
    }
    if (simulation.phase.type === "reservation" && simulation.reservationPending) {
      showToast("提前预约正在写入演示状态，请稍候片刻", 2200);
      return;
    }
    if (simulation.phase.type === "recognition" && !simulation.recognitionResolved) {
      void runSimulationOcr(true);
      return;
    }
    simulation.phaseElapsedMs = Number(simulation.phase.durationMs || 1);
    simulationAdvancePhase();
  }

  function simulationAdvancePhase() {
    const simulation = state.simulation;
    if (!simulation.active) return;
    if (simulation.phase?.type === "recognition" && !simulation.recognitionResolved) {
      showToast("请先执行本地 OCR；若识别失败，可选择使用预置样例继续", 3000);
      return;
    }
    const nextIndex = simulation.phaseIndex + 1;
    if (nextIndex >= simulation.phases.length) {
      // Keep the completed navigation state on screen until the reviewer
      // explicitly exits. This makes the final state inspectable and avoids
      // leaving a half-hidden marker/toolbox behind after the last frame.
      simulation.phase = { type: "arrived", progressStart: 1, progressEnd: 1, durationMs: 0, stop: null };
      simulation.progress = 1;
      simulation.paused = true;
      renderSimulationPhase(simulation.phase);
      updateSimulationMarker();
      if (simulation.rafId) window.cancelAnimationFrame(simulation.rafId);
      simulation.rafId = null;
      return;
    }
    simulationEnterPhase(nextIndex);
  }

  function simulationFrame(timestamp) {
    const simulation = state.simulation;
    if (!simulation.active) return;
    if (!simulation.autoAdvance) {
      simulation.rafId = null;
      return;
    }
    const activePhase = simulation.phase || simulation.phases[simulation.phaseIndex];
    if (activePhase?.type !== "drive") {
      simulation.paused = true;
      simulation.rafId = null;
      return;
    }
    const previous = simulation.lastFrameAt || timestamp;
    const delta = Math.min(100, Math.max(0, timestamp - previous));
    simulation.lastFrameAt = timestamp;
    if (!simulation.paused && simulation.autoAdvance) {
      const phase = simulation.phase || simulation.phases[simulation.phaseIndex];
      const phaseSpeed = phase?.type === "drive" ? simulation.speed : 1;
      simulation.phaseElapsedMs += delta * phaseSpeed;
      const duration = Math.max(1, Number(phase?.durationMs) || 1);
      const ratio = Math.min(1, simulation.phaseElapsedMs / duration);
      simulation.progress = (phase?.progressStart ?? simulation.progress) + ((phase?.progressEnd ?? simulation.progress) - (phase?.progressStart ?? simulation.progress)) * ratio;
      updateSimulationMarker();
      if (ratio >= 1) {
        simulationAdvancePhase();
      }
    }
    if (simulation.autoAdvance && simulation.active && simulation.phase?.type === "drive") {
      simulation.rafId = window.requestAnimationFrame(simulationFrame);
    } else {
      simulation.rafId = null;
    }
  }

  async function runSimulationOcr(force = false) {
    const image = byId("simulationSceneImage");
    const status = byId("simulationOcrStatus");
    const button = byId("simulationOcrButton");
    const detail = byId("simulationOcrDetail");
    if (!status) return;
    if (!image?.src) {
      status.textContent = "场景素材尚未加载，无法执行 OCR";
      if (detail) detail.textContent = "请先让到站视觉画面加载完成，再执行本地 OCR；不会把缺少图片当作识别成功。";
      state.simulation.ocrFallbackAvailable = true;
      renderSimulationPhase(state.simulation.phase);
      return;
    }
    const targetStopIndex = state.simulation.phase?.stopIndex;
    if (!force && state.simulation.ocrAttemptedFor === targetStopIndex) return;
    state.simulation.ocrAttemptedFor = targetStopIndex;
    const isCurrentRecognitionPhase = () => state.simulation.active
      && state.simulation.phase?.type === "recognition"
      && state.simulation.phase?.stopIndex === targetStopIndex;
    state.simulation.ocrBusy = true;
    state.simulation.ocrFallbackAvailable = false;
    detail?.classList.remove("is-success");
    if (button) { button.disabled = true; button.textContent = "识别中…"; }
    status.textContent = "正在调用本地 PaddleOCR…";
    try {
      const health = await getJson("/api/cv/health", 5000).catch((error) => ({ status: "unreachable", error: error?.message || "视觉服务健康检查失败" }));
      state.simulation.ocrHealth = health;
      if (health?.status === "unreachable" || health?.serviceReachable === false) {
        status.textContent = "本地 OCR 服务未启动";
        if (detail) detail.textContent = "视觉服务未连接（127.0.0.1:5099）。请先启动 cv-service，再点“再次执行 OCR”；本次不会生成虚假车牌。";
      } else if (health?.modelLoaded === false || health?.status === "warming") {
        status.textContent = "正在加载本地 PaddleOCR 模型…";
      }
      const response = await fetch(image.src, { cache: "no-store" });
      if (!response.ok) throw new Error("读取场景素材失败");
      const imageData = await readVisionBlob(await response.blob(), "模拟驾驶场景");
      const result = await postJson("/api/cv/analyze", { mode: "upload", imageData, fileName: "simulation-scene.png" }, 65000);
      // OCR runs asynchronously while the reviewer may manually advance to
      // the queue/service phase. Never let a late response rewrite the next
      // scene's badge or status with the previous phase's recognition result.
      if (!isCurrentRecognitionPhase()) return;
      const inference = visionInferenceStatus(result);
      const plate = result?.arrivalRecognition?.plate;
      const processingMs = Number(result?.processingMs);
      const timing = Number.isFinite(processingMs) ? ` · ${Math.round(processingMs)} ms` : "";
      const observedAt = formatVisionTimestamp(result?.observedAt || result?.timestamp);
      const badge = byId("simulationSceneBadge");
      if (inference === "executed" && plate) {
        state.simulation.recognitionResolved = true;
        state.simulation.ocrFallbackUsed = false;
        state.simulation.ocrFallbackAvailable = false;
        state.simulation.recognizedPlate = plate;
        status.textContent = `已成功识别：${plate}`;
        if (badge) badge.textContent = "本地 OCR 结果";
        if (detail) {
          detail.classList.add("is-success");
          detail.textContent = `实际结果：${plate} · 已成功识别 · 识别时间：${observedAt}${result?.arrivalRecognition?.confidence != null ? ` · 识别分数 ${Number(result.arrivalRecognition.confidence).toFixed(3)}` : ""} · 本次调用本地 PaddleOCR（${result?.engine || "本地服务"}）${timing}`;
        }
      } else if (inference === "executed") {
        state.simulation.recognitionResolved = false;
        state.simulation.ocrFallbackAvailable = true;
        status.textContent = "本地 OCR 已执行，但未识别到车牌";
        if (badge) badge.textContent = "本地 OCR 已执行";
        if (detail) detail.textContent = `实际结果：已完成本地 OCR 推理，但没有返回符合格式的车牌文本 · 识别时间：${observedAt} · 本次调用本地 PaddleOCR${timing}。可选择使用预置样例继续，不把它当成本次图片识别结果。`;
      } else {
        state.simulation.recognitionResolved = false;
        state.simulation.ocrFallbackAvailable = true;
        const serviceUnavailable = health?.status === "unreachable" || health?.serviceReachable === false;
        status.textContent = serviceUnavailable ? "本地 OCR 服务未启动" : "本次未执行 OCR，未生成虚假车牌";
        if (badge) badge.textContent = "OCR 未执行";
        const evidence = Array.isArray(result?.evidence) ? result.evidence.filter(Boolean).at(-1) : null;
        if (detail) detail.textContent = serviceUnavailable
          ? "视觉服务未连接（127.0.0.1:5099）。请先启动 cv-service，再点“再次执行 OCR”；可使用预置样例继续，但不会把它当成本次图片的真实识别结果。"
          : `实际响应：${evidence || result?.source || "本地模型尚未就绪"} · 本次未形成有效 OCR 结果${timing}。可选择使用预置样例继续，不把它当成本次图片识别结果。`;
      }
      if (result?.annotatedImage) {
        image.src = result.annotatedImage;
        image.alt = "本地 PaddleOCR 标注结果";
        const badge = byId("simulationSceneBadge");
        if (badge) badge.textContent = "本地 OCR 标注";
      }
    } catch (error) {
      if (!isCurrentRecognitionPhase()) return;
      state.simulation.recognitionResolved = false;
      state.simulation.ocrFallbackAvailable = true;
      status.textContent = `OCR 暂不可用 · ${error?.message || "未生成虚假结果"}`;
      const detail = byId("simulationOcrDetail");
      if (detail) detail.textContent = `实际响应：本地视觉服务请求失败，未生成车牌结果 · 处理时间：${formatVisionTimestamp()} · ${error?.message || "请检查服务状态"}。可选择使用预置样例继续。`;
    } finally {
      state.simulation.ocrBusy = false;
      if (isCurrentRecognitionPhase()) {
        if (button) {
          button.disabled = state.simulation.recognitionResolved;
          button.textContent = state.simulation.recognitionResolved ? "已完成 OCR" : "再次执行 OCR";
        }
        renderSimulationPhase(state.simulation.phase);
        // Auto mode never skips the station workflow.  After OCR completes,
        // keep the result visible and let the reviewer press the next-stage
        // button when ready.
        if (state.simulation.active && state.simulation.phase?.type === "recognition") state.simulation.paused = true;
      }
    }
  }

  function useSimulationOcrFallback() {
    const simulation = state.simulation;
    if (!simulation.active || simulation.phase?.type !== "recognition" || !simulation.ocrFallbackAvailable) return;
    simulation.recognitionResolved = true;
    simulation.ocrFallbackUsed = true;
    simulation.recognizedPlate = null;
    simulation.ocrFallbackAvailable = false;
    const status = byId("simulationOcrStatus");
    const detail = byId("simulationOcrDetail");
    const badge = byId("simulationSceneBadge");
    if (status) status.textContent = "已使用预置样例继续";
    if (badge) badge.textContent = "预置演示结果";
    detail?.classList.remove("is-success");
    if (detail) detail.textContent = `本地 OCR 未返回可用结果，当前仅使用预置车牌完成流程托底；使用时间：${formatVisionTimestamp()}；这不是本次图片的真实识别结果。`;
    renderSimulationPhase(simulation.phase);
    if (simulation.active && simulation.phase?.type === "recognition") simulation.paused = true;
  }

  function startSimulationDriving() {
    if (state.simulation.active) return;
    const record = state.routeRecords[state.selectedRoute];
    if (!record || record.feasible === false || !simulationPathFor(record).length) {
      showToast("当前方案没有可用于模拟驾驶的完整路线", 3000);
      return;
    }
    if (state.mode !== "driver") setMode("driver");
    const built = buildSimulationPhases(record);
    if (!built.phases.length) { showToast("当前路线阶段不足，无法开始模拟", 2600); return; }
    const simulation = state.simulation;
    const selectedSpeed = Number(document.querySelector("[data-simulation-speed].active")?.dataset.simulationSpeed || simulation.preferredSpeed || 3);
    simulation.active = true;
    simulation.preferredSpeed = Math.max(1, Math.min(3, selectedSpeed));
    simulation.speed = simulation.preferredSpeed;
    simulation.autoAdvance = Boolean(byId("simulationAutoAdvance")?.checked);
    simulation.paused = !simulation.autoAdvance;
    simulation.phaseIndex = 0;
    simulation.phaseElapsedMs = 0;
    simulation.progress = 0;
    simulation.phases = built.phases;
    simulation.path = built.path;
    simulation.recordKey = state.selectedRoute;
    simulation.record = record;
    simulation.lastFrameAt = 0;
    simulation.lastMapCenterAt = 0;
    simulation.lastCenteredPhaseIndex = -1;
    simulation.pathMetrics = buildPathMetrics(built.path);
    simulation.ocrAttemptedFor = null;
    simulation.recognitionResolved = false;
    simulation.ocrFallbackUsed = false;
    simulation.ocrFallbackAvailable = false;
    simulation.ocrBusy = false;
    simulation.ocrPhaseKey = null;
    simulation.recognizedPlate = null;
    simulation.reservationPending = false;
    simulation.reservationBeforeSnapshot = null;
    simulation.reservationAfterSnapshot = null;
    simulation.reservationStopKey = null;
    simulation.reservationEvidenceOpen = false;
    simulation.ocrHealth = null;
    simulation.reservedStops = new Set();
    simulation.skippedStopIndexes = new Set();
    simulation.savedMapView = state.live && state.map ? { center: parseLocation(state.map.getCenter?.()), zoom: state.map.getZoom?.() } : null;
    document.body.classList.add("simulation-active");
    byId("tripPanel")?.classList.remove("collapsed");
    byId("tripPanel")?.removeAttribute("hidden");
    const firstStop = built.stops?.[0];
    if (firstStop) {
      const station = state.stations.find((candidate) => String(candidate.id) === String(firstStop.id)) || firstStop;
      state.selectedStation = station;
      selectStation(station, false);
      revealSimulationStationPanel();
    }
    byId("simulationUi").hidden = false;
    byId("simulationToolbox").hidden = false;
    byId("simulationToolbox")?.setAttribute("aria-expanded", "true");
    if (state.live && state.map) {
      const routeKm = Number(record.distance) || routeDistance(built.path);
      const simulationZoom = routeKm >= 800 ? 10 : routeKm >= 300 ? 11 : routeKm >= 80 ? 12 : 13;
      const initialPoint = pointAtPathProgress(built.path, 0, simulation.pathMetrics);
      if (initialPoint && state.map.setZoomAndCenter) state.map.setZoomAndCenter(simulationZoom, initialPoint);
      else state.map.setZoom(simulationZoom);
    }
    drawAmapRoutes();
    createSimulationMarker();
    simulationEnterPhase(0);
    setSimulationSpeed(simulation.preferredSpeed);
    setText("mapAttribution", "高德路线 · 模拟驾驶 / 场景素材为演示");
    if (simulation.autoAdvance && !simulation.rafId) simulation.rafId = window.requestAnimationFrame(simulationFrame);
  }

  function stopSimulationDriving() {
    const simulation = state.simulation;
    if (simulation.rafId) window.cancelAnimationFrame(simulation.rafId);
    simulation.rafId = null;
    removeSimulationMarker();
    simulation.active = false;
    simulation.paused = false;
    simulation.phase = null;
    document.body.classList.remove("simulation-active");
    byId("simulationUi").hidden = true;
    byId("simulationToolbox").hidden = true;
    byId("simulationSceneCard").hidden = true;
    byId("simulationSceneImage")?.removeAttribute("data-simulation-scene-key");
    byId("simulationDataGrid")?.remove();
    byId("simulationDataSource")?.remove();
    byId("simulationQueueNote")?.remove();
    byId("simulationOcrDetail")?.remove();
    if (state.live && state.map) {
      const saved = simulation.savedMapView;
      if (saved?.center && saved.zoom) state.map.setZoomAndCenter(saved.zoom, saved.center);
      else fitAmapView();
    } else {
      renderFallbackRouteVisuals();
    }
    simulation.savedMapView = null;
    simulation.pathMetrics = null;
    setText("mapAttribution", state.live ? "高德地图 · 真实路线与 POI / 演示预测状态" : "固定场景地图 · POI 示意 / 演示预测状态");
    renderSimulationLaunch();
  }

  function revealSimulationStationPanel() {
    const panel = byId("insightPanel");
    if (!panel) return;
    panel.hidden = false;
    panel.classList.remove("hidden", "collapsed", "mobile-visible");
    if (window.innerWidth <= 760) panel.classList.add("mobile-visible");
  }

  function renderSimulationLaunch() {
    const record = state.routeRecords[state.selectedRoute];
    const valid = state.hasPlannedRoute && record && record.feasible !== false && simulationPathFor(record).length;
    $$('[data-simulation-route]').forEach((button) => {
      const routeKey = button.dataset.simulationRoute;
      const routeRecord = state.routeRecords[routeKey];
      const visible = Boolean(valid && routeRecord && routeRecord.feasible !== false && simulationPathFor(routeRecord).length && routeKey === state.selectedRoute && !state.simulation.active);
      button.hidden = !visible;
    });
  }

  function startSimulationForRoute(key) {
    if (state.simulation.active) return;
    if (key && state.routeRecords[key]) {
      state.selectedRoute = key;
      state.routeSelectionTouched = true;
      $$(".route-option").forEach((button) => button.classList.toggle("selected", button.dataset.route === key));
      if (state.live) drawAmapRoutes();
      else renderFallbackRouteVisuals();
      renderRouteCards();
    }
    startSimulationDriving();
  }

  function setSimulationAutoAdvance(checked) {
    state.simulation.autoAdvance = Boolean(checked);
    if (!state.simulation.autoAdvance && state.simulation.active) {
      state.simulation.paused = true;
      if (state.simulation.rafId) window.cancelAnimationFrame(state.simulation.rafId);
      state.simulation.rafId = null;
    }
    setText("simulationAutoState", state.simulation.autoAdvance ? "路线自动 · 站内手动" : "全程手动推进");
    if (state.simulation.active && state.simulation.autoAdvance) {
      const drivePhase = state.simulation.phase?.type === "drive";
      state.simulation.paused = !drivePhase;
      if (drivePhase && !state.simulation.rafId) {
        state.simulation.lastFrameAt = performance.now();
        state.simulation.rafId = window.requestAnimationFrame(simulationFrame);
      }
    }
    renderSimulationPhase(state.simulation.phase || state.simulation.phases[state.simulation.phaseIndex]);
  }

  function toggleSimulationToolbox() {
    const toolbox = byId("simulationToolbox");
    const toggle = byId("simulationToolboxToggle");
    if (!toolbox || !toggle) return;
    const expanded = toolbox.getAttribute("aria-expanded") !== "false";
    toolbox.setAttribute("aria-expanded", String(!expanded));
    toggle.setAttribute("aria-expanded", String(!expanded));
  }

  function setSimulationSpeed(speed) {
    const next = Math.max(1, Math.min(3, Number(speed) || 1));
    state.simulation.speed = next;
    state.simulation.preferredSpeed = next;
    $$('[data-simulation-speed]').forEach((button) => button.classList.toggle("active", Number(button.dataset.simulationSpeed) === next));
    setText("simulationSpeedReadout", `${next}×`);
  }

  function toggleSimulationPause() {
    if (!state.simulation.active) return;
    if (isSimulationStationPhase(state.simulation.phase)) {
      showToast("站内流程采用手动推进，请查看中央卡片", 2200);
      return;
    }
    if (!state.simulation.autoAdvance) {
      showToast("已关闭自动演示，请使用“快进到下一阶段”推进", 2200);
      return;
    }
    state.simulation.paused = !state.simulation.paused;
    renderSimulationPhase(state.simulation.phase || state.simulation.phases[state.simulation.phaseIndex]);
  }

  function renderRouteCards() {
    calculateRouteRecords();
    const displayGroups = buildRouteDisplayGroups(state.routeRecords);
    state.routeDisplayGroups = displayGroups;
    state.routeDisplayKeys = displayGroups.map((group) => group.representative);
    const selectedGroup = displayGroups.find((group) => group.keys.includes(state.selectedRoute));
    if (selectedGroup && selectedGroup.representative !== state.selectedRoute) {
      state.selectedRoute = selectedGroup.representative;
    }
    if (!state.routeSelectionTouched) {
      const recommendedGroup = displayGroups.find((group) => group.keys.includes(state.recommendedRoute));
      state.selectedRoute = recommendedGroup?.representative || state.routeDisplayKeys[0] || state.recommendedRoute || "reliable";
    }
    const current = state.routeRecords[state.selectedRoute];
    if (!state.routeSelectionTouched && !current?.feasible) {
      const fallbackGroup = displayGroups
        .filter((group) => state.routeRecords[group.representative]?.feasible)
        .sort((a, b) => state.routeRecords[a.representative].arrival - state.routeRecords[b.representative].arrival)[0];
      if (fallbackGroup) state.selectedRoute = fallbackGroup.representative;
    }
    const allSameRoute = displayGroups.length === 1 && displayGroups[0].keys.length > 1;
    $$(".route-option").forEach((button) => {
      const routeKey = button.dataset.route;
      const group = displayGroups.find((candidate) => candidate.representative === routeKey);
      const visible = Boolean(group);
      button.hidden = !visible;
      button.setAttribute("aria-hidden", String(!visible));
      button.tabIndex = visible ? 0 : -1;
      if (!visible) return;
      const record = state.routeRecords[routeKey];
      const displayRecord = allSameRoute
        ? Object.assign({}, record, {
          displayName: "最佳方案",
          objectiveBadges: ["最快", "最稳妥", "最低成本"]
        })
        : record;
      setOptionText(button, displayRecord);
    });
    $$("[data-route-shell]").forEach((shell) => {
      const routeKey = shell.dataset.routeShell;
      const group = displayGroups.find((candidate) => candidate.representative === routeKey);
      shell.hidden = !group;
    });
    const routeOptions = byId("routeOptions");
    routeOptions?.classList.toggle("single-route", displayGroups.length === 1);
    routeOptions?.classList.toggle("two-routes", displayGroups.length === 2);
    routeOptions?.classList.toggle("three-routes", displayGroups.length >= 3);
    $$(".route-option").forEach((button) => button.classList.toggle("selected", button.dataset.route === state.selectedRoute));
    const feasibleCount = displayGroups.filter((group) => state.routeRecords[group.representative]?.feasible).length;
    const heading = $(".sheet-heading h2");
    if (heading) heading.textContent = allSameRoute
      ? (state.routeRecords[displayGroups[0].representative]?.feasible ? "最佳方案" : "当前方案不可执行")
      : feasibleCount === displayGroups.length
        ? `${displayGroups.length} 条可行方案`
        : `${feasibleCount} 条可行 · ${displayGroups.length - feasibleCount} 条备用`;
    const headingNote = $(".sheet-heading span");
    if (headingNote) headingNote.textContent = allSameRoute
      ? "时间、风险与成本均落在同一条可执行路线上"
      : "按最终时间、风险和成本生成可解释对比";
    const expandLabel = byId("expandRoutes")?.querySelector("span");
    if (expandLabel) expandLabel.textContent = allSameRoute
      ? "最佳方案"
      : `${displayGroups.length} 条补能方案`;
    renderActiveRouteSummary();
    renderHybridCompare();
    updateInsight(state.routeRecords[state.selectedRoute]);
    syncArrivalPayment();
    renderSimulationLaunch();
  }

  // 混动车的两条补能路径必须放在同一条已核验路线上比较，否则"省钱"只是
  // 两次独立优化的副产品。这里对同一条路线分别核算电、油两侧的全程能耗
  // 成本、需要的补能次数与补能耗时，再按统一的时间价值折算给出建议。
  const HYBRID_TIME_VALUE_PER_HOUR = 60;

  function evaluateEnergyBranch(kind, distanceKm) {
    const isFuel = kind === "fuel";
    const profile = isFuel ? ENERGY_PROFILES.hybridFuel : ENERGY_PROFILES.hybridElectric;
    const stationType = isFuel ? "加油站" : "充电站";
    const pool = state.stations.filter((station) => station.type === stationType);
    const price = referenceEnergyPrice(isFuel);
    const level = hybridBranchLevel(kind);
    const reservePercent = effectiveArrivalReserveSoc(profile);
    const totalConsumed = Math.max(0, distanceKm) * profile.consumptionPerKm;
    const startEnergy = profile.capacity * level / 100;
    const reserveEnergy = profile.capacity * reservePercent / 100;
    const safetyEnergy = profile.capacity * profile.safetyReservePercent / 100;
    // 起步可用能量要留出到达余量；每次补满后同样只有到"满-安全下限"可用。
    const usableFromStart = Math.max(0, startEnergy - reserveEnergy);
    const usablePerFill = Math.max(1e-6, profile.capacity - safetyEnergy - reserveEnergy);
    const deficit = Math.max(0, totalConsumed - usableFromStart);
    const stops = deficit <= 1e-6 ? 0 : Math.ceil(deficit / usablePerFill);
    const purchased = deficit / profile.transferEfficiency;
    const medianP50 = pool.length
      ? pool.map((station) => Number(station.p50) || 0).sort((a, b) => a - b)[Math.floor(pool.length / 2)]
      : 8;
    const perFillAmount = stops > 0 ? purchased / stops : 0;
    const perFillMinutes = stops > 0 ? energyFillMinutes(perFillAmount, pool[0], isFuel) : 0;
    const stopMinutes = stops * (perFillMinutes + medianP50);
    // 能耗成本按"本次行程实际消耗"计价，含起步电/油的折价，
    // 这样直达也不会被算成零成本，两侧才可比。
    const energyCost = totalConsumed * price;
    const timeCost = stopMinutes / 60 * HYBRID_TIME_VALUE_PER_HOUR;
    // available 原来只看"有没有站、停几次不超上限"，不看第一站够不够得着。于是
    // 电量 22% 的混动电分支：deficit 算出来要停 4 次、池子里有 24 个充电站、4 ≤ 6，
    // 推荐器判 available=true 并推荐电（电更便宜）；可真正的多停规划器知道最近的
    // 充电站在 28km 外、22% 电只能跑 24km，直接判 NO_FEASIBLE_SEQUENCE。推荐器和
    // 规划器对同一条分支给出相反结论，自动换油分支就不会触发，三条线全挂"无法安全
    // 到站"，哪怕油分支 500km 续航明明能走。按规划器同一道门槛补一道：需要补能时，
    // 池子里必须至少有一个站落在当前电量可达范围内，否则这条路径不可用。
    const firstLegKm = Math.max(0, startEnergy - safetyEnergy) / profile.consumptionPerKm;
    const firstStopReachable = stops === 0 || pool.some((station) => estimateStationApproachKm(station) <= firstLegKm + 0.5);
    return {
      kind,
      label: isFuel ? "燃油" : "纯电",
      unit: profile.unit,
      stationType,
      stationCount: pool.length,
      level: Math.round(level),
      rangeKm: Math.max(0, Math.floor(usableFromStart / profile.consumptionPerKm)),
      price: Number(price.toFixed(2)),
      consumed: Number(totalConsumed.toFixed(1)),
      purchased: Number(purchased.toFixed(1)),
      stops,
      stopMinutes: Math.round(stopMinutes),
      energyCost: Number(energyCost.toFixed(1)),
      costPerKm: distanceKm > 0 ? Number((energyCost / distanceKm).toFixed(2)) : 0,
      generalizedCost: Number((energyCost + timeCost).toFixed(1)),
      // 混动分支只负责给出能量侧的可行性比较，不再人为设置六站/十二站上限。
      // 真正的站点顺序、逐段道路可达性和绕行约束仍由多站规划器复核。
      maxStops: null,
      exceedsStopCap: false,
      available: firstStopReachable && (stops === 0 || pool.length > 0),
      // 不可用原因要分清，否则面板会写"未检索到充电站"而池子里明明有 24 个。
      unavailableReason: !firstStopReachable && stops > 0
        ? "first-stop-unreachable"
        : pool.length === 0 && stops > 0
            ? "no-station"
            : null
    };
  }

  function computeHybridComparison() {
    if (!isHybrid()) return null;
    const record = state.routeRecords[state.selectedRoute] || state.routeRecords.reliable;
    const distanceKm = Math.max(0, Number(record?.baseDistance ?? record?.distance) || 0);
    if (!distanceKm) return null;
    const electric = evaluateEnergyBranch("electric", distanceKm);
    const fuel = evaluateEnergyBranch("fuel", distanceKm);
    // 规划结果反馈：evaluateEnergyBranch 用直线距离估第一站可达性，会放过"直线
    // 够得着、路况够不着"的站。活动分支的路线是真实规划器跑出来的，三条线全挂
    // 就是实测证据，比直线估算可靠--记一笔并强制标不可用。非活动分支的路线还没
    // 建，不能这样判。已失败过的分支也保持不可用，避免在电/油之间来回切换死循环。
    const activeKind = activeEnergyKind();
    for (const branch of [electric, fuel]) {
      if (state.hybridFailedBranches.has(branch.kind)) {
        branch.available = false;
        if (!branch.unavailableReason) branch.unavailableReason = "planning-failed";
        continue;
      }
      if (branch.kind === activeKind && branch.available) {
        const records = Object.values(state.routeRecords).filter(Boolean);
        const allFailed = records.length > 0 && records.every((r) => r.feasible === false);
        if (allFailed) {
          state.hybridFailedBranches.add(branch.kind);
          branch.available = false;
          branch.unavailableReason = "planning-failed";
        }
      }
    }
    // 沿线没有对应网络的站点、又确实需要补能时，这条路径不可执行。
    const candidates = [electric, fuel].filter((branch) => branch.available);
    const recommend = (candidates.length === 1
      ? candidates[0]
      : [electric, fuel].slice().sort((a, b) => a.generalizedCost - b.generalizedCost)[0]).kind;
    const winner = recommend === "fuel" ? fuel : electric;
    const loser = recommend === "fuel" ? electric : fuel;
    return {
      distanceKm: Number(distanceKm.toFixed(1)),
      electric,
      fuel,
      recommend,
      moneySaved: Number((loser.energyCost - winner.energyCost).toFixed(1)),
      minutesSaved: Math.round(loser.stopMinutes - winner.stopMinutes),
      timeValuePerHour: HYBRID_TIME_VALUE_PER_HOUR
    };
  }

  function branchCardMarkup(branch, comparison) {
    const active = activeEnergyKind() === branch.kind;
    const recommended = comparison.recommend === branch.kind;
    const stopText = !branch.available
        ? `沿线暂未检索到${branch.stationType}`
        : branch.stops === 0
          ? "无需补能，可直达"
          : `需补能 ${branch.stops} 次 · 约 ${branch.stopMinutes} 分钟`;
    return `<button type="button" class="hybrid-branch${active ? " active" : ""}" data-hybrid-branch="${branch.kind}" aria-pressed="${active}">
      <div class="hybrid-branch-head">
        <span class="hybrid-branch-name"><i data-lucide="${branch.kind === "fuel" ? "fuel" : "zap"}"></i>${branch.label}</span>
        ${recommended ? '<span class="hybrid-badge">推荐</span>' : ""}
      </div>
      <div class="hybrid-branch-cost">¥${branch.energyCost.toFixed(0)}<span>能耗成本</span></div>
      <div class="hybrid-branch-meta">${branch.costPerKm.toFixed(2)} 元/km · ${branch.price.toFixed(2)} 元/${branch.unit}</div>
      <div class="hybrid-branch-meta">${stopText}</div>
      <div class="hybrid-branch-meta">当前 ${branch.level}% · 可续驶约 ${branch.rangeKm} km</div>
    </button>`;
  }

  // renderHybridCompare 可以触发一次自动换路径，而换路径又会重绘路线卡片。
  // 这个标志保证自动切换最多发生一次，不会来回抖动。
  let hybridAutoSwitching = false;

  function renderHybridCompare() {
    const host = byId("hybridCompare");
    if (!host) return;
    const comparison = isHybrid() ? computeHybridComparison() : null;
    state.hybridComparison = comparison;
    host.hidden = !comparison;
    if (!comparison) {
      host.innerHTML = "";
      return;
    }
    // 建议只在用户没有手动指定过能源路径时自动生效，避免覆盖显式选择。
    if (!state.hybridBranchTouched && !hybridAutoSwitching && comparison.recommend !== activeEnergyKind()) {
      hybridAutoSwitching = true;
      applyHybridBranch(comparison.recommend, { touched: false })
        .catch(() => {})
        .finally(() => { hybridAutoSwitching = false; });
      return;
    }
    const winner = comparison.recommend === "fuel" ? comparison.fuel : comparison.electric;
    const loser = comparison.recommend === "fuel" ? comparison.electric : comparison.fuel;
    const money = comparison.moneySaved;
    const minutes = comparison.minutesSaved;
    // 便宜和快通常不指向同一条路径。只报对自己有利的那一半会让结论看着更
    // 漂亮，但用户按它决策会吃亏，所以两侧都要写清楚。
    let verdict;
    if (!loser.available) {
      // 不可用原因分三种，措辞必须和实际情况对得上：沿线确实没站、
      // 当前电量到不了最近的站、以及规划器实测排不出线（站直线够得着但路况够不着）。
      // 一律写成"未检索到可用"会把 24 个充电站说没了。
      const reason = loser.unavailableReason;
      const loserExplain = reason === "no-station"
          ? `沿线未检索到可用的${loser.stationType}`
          : reason === "first-stop-unreachable" || reason === "planning-failed"
            ? `当前${loser.label}剩余能量到不了最近的${loser.stationType}（可续驶约 ${loser.rangeKm} km）`
            : `沿线未检索到可用的${loser.stationType}`;
      verdict = `本段 ${comparison.distanceKm} km 只能走${winner.label}：${loserExplain}`;
    } else if (money > 0.5 && minutes > 0) {
      verdict = `本段 ${comparison.distanceKm} km 走${winner.label}更划算：省 ¥${money.toFixed(0)}，且少花 ${minutes} 分钟补能`;
    } else if (money > 0.5) {
      verdict = minutes < 0
        ? `本段 ${comparison.distanceKm} km 建议走${winner.label}：能耗省 ¥${money.toFixed(0)}，代价是多花 ${Math.abs(minutes)} 分钟补能`
        : `本段 ${comparison.distanceKm} km 走${winner.label}更划算：能耗省 ¥${money.toFixed(0)}`;
    } else if (minutes > 0) {
      verdict = money < -0.5
        ? `本段 ${comparison.distanceKm} km 建议走${winner.label}：少花 ${minutes} 分钟补能，代价是能耗多 ¥${Math.abs(money).toFixed(0)}`
        : `本段 ${comparison.distanceKm} km 走${winner.label}更划算：少花 ${minutes} 分钟补能`;
    } else {
      verdict = `本段 ${comparison.distanceKm} km 两条路径接近，默认按${winner.label}规划`;
    }
    host.innerHTML = `<div class="hybrid-compare-head">
        <div class="hybrid-compare-title"><i data-lucide="git-compare-arrows"></i>油电划算度对比</div>
        <div class="hybrid-compare-note">同一条已核验路线 · 时间按 ¥${comparison.timeValuePerHour}/小时折算</div>
      </div>
      <div class="hybrid-branches">${branchCardMarkup(comparison.electric, comparison)}${branchCardMarkup(comparison.fuel, comparison)}</div>
      <div class="hybrid-verdict">${verdict}<span>点击卡片可切换按哪条能源路径生成完整路线</span></div>`;
    Array.from(host.querySelectorAll("[data-hybrid-branch]")).forEach((button) => {
      button.addEventListener("click", () => applyHybridBranch(button.dataset.hybridBranch, { touched: true }));
    });
    refreshIcons();
  }

  // 切换能源路径不需要重新检索站点：混动模式下油、电两张网都已在 state.stations
  // 里，只需要按新分支重新做多站规划并重绘。
  async function applyHybridBranch(kind, options = {}) {
    if (!isHybrid()) return;
    const next = kind === "fuel" ? "fuel" : "electric";
    if (options.touched) state.hybridBranchTouched = true;
    // 用户手动切换是在显式重试，清掉之前自动换路径留下的失败记录，给这条分支
    // 重新评估的机会。自动换路径不带 touched，不清空，失败记忆保留到下一轮规划。
    if (options.touched) state.hybridFailedBranches = new Set();
    if (next === state.hybridBranch) {
      renderHybridCompare();
      return;
    }
    state.hybridBranch = next;
    syncHybridLevels();
    state.routeSelectionTouched = false;
    state.selectedRoute = "reliable";
    state.multiStopRouteRecords = null;
    state.multiStopPlanningMeta = null;
    updateEnergyControls();
    if (state.live && state.AMap) {
      setMapStatus(`正在按${next === "fuel" ? "燃油" : "纯电"}路径重新规划…`);
      await replanRoutesViaStations();
      drawAmapRoutes();
      fitAmapView();
      setMapStatus("高德地图已连接 · 真实路线与 POI 已更新", "ready");
    }
    renderRouteCards();
    if (options.touched) showToast(`已按${next === "fuel" ? "燃油" : "纯电"}路径重新生成路线`);
  }

  function selectedPaymentTarget() {
    const record = state.routeRecords[state.selectedRoute];
    if (!record?.feasible || record.directTrip || record.serviceOnly) return null;
    const station = record.multiStop ? record.stops?.[0] : record.station;
    if (!station?.id) return null;
    const amount = Number.isFinite(Number(station.energyCost))
      ? Number(station.energyCost)
      : Math.max(0, Number(record.energyAmount || 0) * Number(station.price || 0));
    return { record, station, amount: Number(amount.toFixed(1)) };
  }

  function syncArrivalPayment() {
    const button = byId("arrivalPaymentButton");
    const label = byId("arrivalPaymentText");
    const plate = byId("vehiclePlate");
    if (plate) plate.textContent = state.vehiclePlate;
    if (!button || !label) return;
    const target = selectedPaymentTarget();
    const paidForCurrentStation = target && state.paymentReceipt?.stationId === target.station.id;
    button.disabled = !target || paidForCurrentStation;
    button.classList.toggle("is-paid", Boolean(paidForCurrentStation));
    if (!target) {
      label.textContent = "等待到站";
      return;
    }
    label.textContent = paidForCurrentStation ? `已扣 ¥${state.paymentReceipt.amount.toFixed(1)}` : "模拟到站";
  }

  // 运营端若对当前这站执行过引流策略，司机在这站付费时就应当享受到那张券。
  // 这是"运营发券 -> 司机被引流 -> 司机实付减免"的闭环，没有它，运营页的优惠
  // 和出行页的扣款就是两个互不相干的数字。只在站点 id 吻合且策略已执行时计入。
  function activeDiversionDiscount(stationId) {
    const payload = state.pendingOperatorPayload;
    if (!payload || state.executionState !== "after") return 0;
    if (payload.targetStation?.id !== stationId) return 0;
    return Math.max(0, Number(payload.discountAmount || 0));
  }

  function renderPaymentReceipt(target) {
    const station = target.station;
    const unit = target.record.energyUnit || station.priceUnit || "kWh";
    // 多停方案的 station 是 stop 对象，带 energyAmount；单停方案的 station 是
    // record.station，没有这个字段（总量在 record.energyAmount 上）。用 ?? 兜底，
    // 别让单停收据印出"0.0 kWh"。
    const energyAmount = Number(station.energyAmount ?? target.record.energyAmount ?? 0);
    const unitPrice = Number(station.price || 0);
    const energyFee = Number.isFinite(Number(station.energyCost))
      ? Number(station.energyCost)
      : Number((energyAmount * unitPrice).toFixed(1));
    const discount = activeDiversionDiscount(station.id);
    const paid = Math.max(0, Number((energyFee - discount).toFixed(1)));
    const noun = isFuelActive() ? "加油" : "补能";

    setText("paymentReceiptTime", formatClock(Number(target.station.arrivalMinute) || state.departureMinutes));
    setText("paymentReceiptStation", `车牌 <b>${state.vehiclePlate}</b> · ${escapeHtml(station.name)}`);
    const rows = byId("paymentReceiptRows");
    if (rows) {
      rows.innerHTML = `
        <div class="payment-receipt-row"><span>${noun}量</span><b>${energyAmount.toFixed(1)} ${unit}</b></div>
        <div class="payment-receipt-row"><span>单价</span><b>¥${unitPrice.toFixed(2)}/${unit}</b></div>
        <div class="payment-receipt-row"><span>能源费</span><b>¥${energyFee.toFixed(1)}</b></div>
        ${discount > 0 ? `<div class="payment-receipt-row discount"><span>运营引流优惠</span><b>−¥${discount.toFixed(1)}</b></div>` : ""}`;
    }
    setText("paymentReceiptTotal", `¥${paid.toFixed(1)}`);
    setText("paymentReceiptFoot", discount > 0
      ? `车牌识别自动扣款 · 已核销运营端 ¥${discount.toFixed(1)} 引流券`
      : "车牌识别自动扣款 · 已授权");
    const overlay = byId("paymentReceiptOverlay");
    if (overlay) { overlay.hidden = false; overlay.classList.add("visible"); }
    refreshIcons();
    return { energyFee, discount, paid };
  }

  function closePaymentReceipt() {
    const overlay = byId("paymentReceiptOverlay");
    if (!overlay) return;
    overlay.classList.remove("visible");
    window.setTimeout(() => { overlay.hidden = true; }, 180);
  }

  async function runArrivalPayment() {
    const target = selectedPaymentTarget();
    if (!target) {
      showToast("请先生成可执行的补能路线", 2400);
      return;
    }
    const button = byId("arrivalPaymentButton");
    const label = byId("arrivalPaymentText");
    if (button) button.disabled = true;
    if (label) label.textContent = "识别车牌…";
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    state.paymentState = "paid";
    const breakdown = renderPaymentReceipt(target);
    state.paymentReceipt = {
      stationId: target.station.id,
      stationName: target.station.name,
      amount: breakdown.paid,
      energyFee: breakdown.energyFee,
      discount: breakdown.discount,
      createdAt: Date.now()
    };
    syncArrivalPayment();
    showToast(`车牌 ${state.vehiclePlate} 已在 ${target.station.name} 完成识别，实付 ¥${breakdown.paid.toFixed(1)}`, 4200);
    refreshIcons();
  }

  function renderActiveRouteSummary() {
    const summary = byId("activeRouteSummary");
    const record = state.routeRecords[state.selectedRoute];
    if (!summary || !record) return;
    if (record.directTrip) {
      summary.innerHTML = `<span>${record.displayName || "推荐方案"}</span><strong>直达 · 无需补能</strong><small>${formatClock(record.arrival)} 到达 · 余量 ${record.arrivalSoc}%</small>`;
      return;
    }
    if (record.serviceOnly) {
      summary.innerHTML = `<span>${record.displayName || "推荐方案"}</span><strong>已加入 · ${escapeHtml(record.servicePlan?.name || "沿线服务")}</strong><small>${formatClock(record.arrival)} 到达 · 额外 ${record.servicePlan?.extraMinutes || 0} 分钟</small>`;
      return;
    }
    if (record.multiStop) {
      const serviceNote = record.servicePlan?.name ? ` · 含 ${escapeHtml(record.servicePlan.name)}` : "";
      summary.innerHTML = `<span>${record.displayName || "推荐方案"}</span><strong>连续补能 ${record.stopCount} 次${serviceNote}</strong><small>${formatClock(record.arrival)} 到达 · 余量 ${record.arrivalSoc}%</small>`;
      return;
    }
    if (!record.station) {
      const title = record.planningFailure ? "未生成虚假的长途补能路线" : "未找到安全可达补能站";
      const hint = record.planningFailure || `请提高当前${isFuelActive() ? "油量" : "电量"}或放宽绕行约束`;
      summary.innerHTML = `<span>${record.displayName || "方案不可执行"}</span><strong>${title}</strong><small>${escapeHtml(hint)}</small>`;
      return;
    }
    const serviceNote = record.servicePlan?.name ? ` · 含 ${escapeHtml(record.servicePlan.name)}` : "";
    summary.innerHTML = `<span>${record.displayName || "推荐方案"}</span><strong>途经 · ${record.station.name}${serviceNote}</strong><small>${formatClock(record.arrival)} ${record.feasible ? "到达" : `· 超时 ${record.lateMinutes} 分`}</small>`;
  }

  function renderStopTimeline(record) {
    const timeline = byId("stopTimeline");
    if (!timeline) return;
    if (!record?.multiStop || !record.stops?.length) {
      timeline.hidden = true;
      timeline.innerHTML = "";
      return;
    }
    timeline.hidden = false;
    const hasProvisional = record.stops.some((stop) => stop.provisionalCorridor);
    const verificationNote = hasProvisional ? "高德主路线已核验 · 兜底候选需确认" : "逐段路线已核验";
     timeline.innerHTML = `<div class="stop-timeline-head"><strong>分段补能账本</strong><span>${verificationNote}</span></div>${record.stops.map((stop) => `<div class="stop-timeline-item"><b>${stop.sequence}</b><div><strong title="${escapeHtml(stop.name)}">${escapeHtml(stop.name)}</strong><small>到站 ${stop.arrivalSoc}% → 补至 ${stop.targetSoc}% · ${stop.legDistanceKm} km · 停靠 P50 ${stop.stopMinutesP50 ?? "—"} 分（排队 ${stop.plannedP50 ?? stop.p50 ?? "—"} + 服务 ${stop.chargeMinutes ?? "—"} + 支付驶离缓冲 ${stop.paymentExitMinutes ?? "—"}）${stop.provisionalCorridor ? " · 设备待确认" : ""}</small></div><span>+${stop.energyAmount}${record.energyUnit}</span></div>`).join("")}`;
  }

  function syncInsightDisplayCopy() {
    if (!isUserDisplayMode()) return;
    $$(".evidence-row span").forEach((element) => {
      element.textContent = displayCopy(element.textContent);
    });
  }

  function updateInsight(record) {
    if (!record) return;
    if (record.directTrip) {
      renderStopTimeline(null);
      renderDirectTripInsight(record);
      updateServiceNudge(record);
      syncInsightDisplayCopy();
      return;
    }
    if (record.serviceOnly) {
      renderStopTimeline(null);
      renderServiceOnlyInsight(record);
      updateServiceNudge(null);
      syncInsightDisplayCopy();
      return;
    }
    if (!record.station) {
      renderStopTimeline(null);
      renderNoStationInsight(record);
      updateServiceNudge(null);
      syncInsightDisplayCopy();
      return;
    }
    selectStation(record.station, false);
    renderStopTimeline(record);
    const reliable = Object.values(state.routeRecords).find((candidate) => candidate.isActualStable) || state.routeRecords.reliable || record;
    const evidence = $$(".evidence-row span");
    if (record.multiStop) {
      const hasProvisional = record.stops.some((stop) => stop.provisionalCorridor);
      if (evidence[0]) evidence[0].textContent = hasProvisional
        ? `高德主路线已核验；按沿线候选分配 ${record.stopCount} 次${isFuelActive() ? "加油" : "补能"}：首段 ${record.firstLegKm?.toFixed(1) || "—"} km，到达 ${state.destinationName} 预计余量 ${record.arrivalSoc}%。`
        : `已逐段核验 ${record.stopCount} 次${isFuelActive() ? "加油" : "补能"}：首段 ${record.firstLegKm?.toFixed(1) || "—"} km，到达 ${state.destinationName} 预计余量 ${record.arrivalSoc}%。`;
      if (evidence[1]) evidence[1].textContent = `建议累计${isFuelActive() ? "加油" : "补能"} ${record.energyAmount} ${record.energyUnit}；补能停靠总耗时 P50 ${record.totalStopMinutesP50} 分 / P90 ${record.totalStopMinutesP90} 分（排队 P50 ${record.p50Wait} + 服务 ${record.serviceMinutes} + 支付驶离缓冲 ${record.paymentExitMinutes}）。`;
      if (evidence[2]) evidence[2].textContent = `总绕行 ${Number(record.detour || 0).toFixed(1)} km · ${formatClock(record.arrival)} 抵达 · ${arrivalReserveDescription(record)}。`;
      renderServiceRecommendations(record);
      updateServiceNudge(record);
      return;
    }
    if (evidence[0]) evidence[0].textContent = `首段 ${record.firstLegKm?.toFixed(1) || "—"} km，到站余量 ${record.arrivalAtStationSoc ?? "—"}% · 绕行 ${record.station.detour} km，预计 ${formatClock(record.arrival)} 抵达${state.destinationName}`;
    if (evidence[1]) evidence[1].textContent = record.targetSocMet
      ? `建议补能 ${record.energyAmount} ${record.energyUnit}，预计到达剩余 ${record.arrivalSoc}%（${arrivalReserveDescription(record)}）`
      : `当前单次补能无法满足${arrivalReserveDescription(record)}，建议增加补能站`;
    if (evidence[2]) {
      const difference = Math.round(record.arrival - reliable.arrival);
      if (record.isActualStable && record.isActualFastest) evidence[2].textContent = "该方案同时拥有最早 ETA 与最低 P90 排队风险";
      else if (record.isActualStable) evidence[2].textContent = `该方案 P90 排队 ${record.station.p90} 分钟，在可行方案中尾部排队风险最低`;
      else if (record.isActualFastest) evidence[2].textContent = `相较低风险方案，预计提前 ${Math.max(0, Math.abs(difference))} 分钟`;
      else if (record.isActualCheapest) evidence[2].textContent = `该方案总成本最低，仍满足当前到达约束`;
      else evidence[2].textContent = `这是成本与风险的可解释备选方案，预计 ${formatClock(record.arrival)} 抵达`;
    }
    renderServiceRecommendations(record);
    updateServiceNudge(record);
    syncInsightDisplayCopy();
  }

  function setInsightBadge(label, risk) {
    const badge = byId("stationState");
    if (!badge) return;
    badge.innerHTML = `<i data-lucide="${risk ? "triangle-alert" : "check-circle-2"}"></i>${label}`;
    badge.classList.toggle("risk", Boolean(risk));
  }

  function renderDirectTripInsight(record) {
    state.selectedStation = null;
    highlightSelectedStation();
    setText("stationTitle", "本次行程无需补能");
    const subtitle = byId("stationSubtitle");
    if (subtitle) subtitle.innerHTML = `当前${isFuelActive() ? "油量" : "电量"}可直达 ${state.destinationName}<span class="source-badge"> · 真实路线 / 能耗模型计算</span>`;
    setInsightBadge("直达可行", false);
    const wait = byId("waitValue");
    if (wait) wait.innerHTML = `0 <small>分钟</small>`;
    setText("energyAdviceLabel", "到达余量");
    const advice = byId("energyAdviceValue");
    if (advice) advice.innerHTML = `${record.arrivalSoc} <small>%</small>`;
    const price = byId("stationPriceValue");
    if (price) price.innerHTML = "— <small>无需补能</small>";
    const forecastCard = byId("forecastChart")?.closest(".forecast-card");
    if (forecastCard) forecastCard.style.display = "none";
    const evidence = $$(".evidence-row span");
    if (evidence[0]) evidence[0].textContent = `直达 ${state.destinationName}，不经过补能站，也不增加绕行。`;
    if (evidence[1]) evidence[1].textContent = `预计到达剩余 ${record.arrivalSoc}%（${arrivalReserveDescription(record)}）。`;
    if (evidence[2]) evidence[2].textContent = `基于真实路线里程与 ${isFuelActive() ? "油耗" : "能耗"}参数计算，当前无需补能。`;
    setText("serviceStatus", "本次无补能停靠；如经过饭点或连续驾驶较久，系统会建议服务停靠");
    const serviceButton = byId("serviceFeedbackButton");
    if (serviceButton) {
      serviceButton.disabled = true;
      serviceButton.textContent = "等待服务建议";
    }
    renderServiceRecommendations(record);
    refreshIcons();
  }

  function renderServiceOnlyInsight(record) {
    state.selectedStation = null;
    highlightSelectedStation();
    setText("stationTitle", record.servicePlan?.name || "沿线服务停靠");
    const subtitle = byId("stationSubtitle");
    if (subtitle) subtitle.innerHTML = `已加入预计 ${record.servicePlan?.durationMinutes || 0} 分钟的服务停靠<span class="source-badge"> · ${record.servicePlan?.source || "高德真实 POI / 演示服务时长"}</span>`;
    setInsightBadge("服务已加入", false);
    const wait = byId("waitValue");
    if (wait) wait.innerHTML = `${record.servicePlan?.extraMinutes || 0} <small>额外分钟</small>`;
    setText("energyAdviceLabel", "到达余量");
    const advice = byId("energyAdviceValue");
    if (advice) advice.innerHTML = `${record.arrivalSoc} <small>%</small>`;
    const price = byId("stationPriceValue");
    if (price) price.innerHTML = "— <small>服务停靠</small>";
    const forecastCard = byId("forecastChart")?.closest(".forecast-card");
    if (forecastCard) forecastCard.style.display = "none";
    const evidence = $$(".evidence-row span");
    if (evidence[0]) evidence[0].textContent = `已将 ${record.servicePlan?.name || "沿线服务"} 作为独立停靠点加入高德路线。`;
    if (evidence[1]) evidence[1].textContent = `服务预计 ${record.servicePlan?.durationMinutes || 0} 分钟，额外增加 ${record.servicePlan?.extraMinutes || 0} 分钟。`;
    if (evidence[2]) evidence[2].textContent = `重新计算后预计 ${formatClock(record.arrival)} 抵达，到达余量 ${record.arrivalSoc}%（${arrivalReserveDescription(record)}）。`;
    renderServiceRecommendations(record);
    refreshIcons();
  }

  function renderNoStationInsight(record) {
    state.selectedStation = null;
    highlightSelectedStation();
    const hasLongTripFailure = Boolean(record.planningFailure);
    setText("stationTitle", hasLongTripFailure ? "未生成可执行长途方案" : "未找到安全可达补能站");
    const subtitle = byId("stationSubtitle");
    if (subtitle) subtitle.innerHTML = `${record.planningFailure || "当前约束下没有通过首段可达性校验的站点"}<span class="source-badge"> · 已阻止生成虚假可行方案</span>`;
    setInsightBadge("需调整出行条件", true);
    const wait = byId("waitValue");
    if (wait) wait.innerHTML = `— <small>分钟</small>`;
    setText("energyAdviceLabel", "安全可达");
    const advice = byId("energyAdviceValue");
    if (advice) advice.innerHTML = `不足 <small>请先补能</small>`;
    const price = byId("stationPriceValue");
    if (price) price.innerHTML = "— <small>暂无站点</small>";
    const forecastCard = byId("forecastChart")?.closest(".forecast-card");
    if (forecastCard) forecastCard.style.display = "none";
    const evidence = $$(".evidence-row span");
    if (hasLongTripFailure) {
      if (evidence[0]) evidence[0].textContent = record.planningFailure;
      const planningMeta = state.multiStopPlanningMeta || {};
      const minimumStops = Number(planningMeta.minimumStops) || 0;
      const maxStops = Number(planningMeta.maxStops) || DEFAULT_LONG_TRIP_MAX_STOPS;
      if (evidence[1]) evidence[1].textContent = planningMeta.adaptiveMaxStops === true
        ? `长途模式按车辆能量模型动态安排补能，单次最多校验 ${maxStops} 站；本次检索到 ${planningMeta.candidatesConsidered || 0} 个沿线候选。`
        : minimumStops > maxStops
        ? `按当前车辆${isFuelActive() ? "油量" : "电量"}模型，理论至少约需 ${minimumStops} 次补能；当前规划上限为 ${maxStops} 次，未把单站估算冒充全程方案。`
        : `系统最多支持连续补能 ${maxStops} 次，未用默认目的地或单站路线冒充结果。`;
      if (evidence[2]) evidence[2].textContent = `已同时检查逐段安全余量、${arrivalReserveDescription(record)}与绕行上限（≤${activeDetourLimitKm(record)} km）。`;
    } else {
      if (evidence[0]) evidence[0].textContent = "未通过“起点→补能站”安全可达性校验，因此未生成途经站路线。";
      if (evidence[1]) evidence[1].textContent = `当前${arrivalReserveDescription(record)}，请提高起始余量或选择更近站点。`;
      if (evidence[2]) evidence[2].textContent = `已同时检查首段可达性与绕行上限（≤${activeDetourLimitKm(record)} km）。`;
    }
    setText("serviceStatus", "请先获得可执行补能方案");
    const serviceButton = byId("serviceFeedbackButton");
    if (serviceButton) {
      serviceButton.disabled = true;
      serviceButton.textContent = "暂不可预约";
    }
    renderServiceRecommendations(record);
    refreshIcons();
  }

  function serviceRouteContext(record) {
    const distance = Math.max(0, Number(record?.distance || 0));
    const duration = Math.max(0, Number(record?.duration || 0));
    const explicitHighway = record?.highway === true || record?.routeClass === "highway";
    // AMap may omit road names on a cached/SDK route.  A long multi-stop
    // corridor is therefore treated as “service-area preferred”, but the UI
    // must not call it a confirmed highway unless the route metadata says so.
    const longCorridor = !explicitHighway && distance >= 180 && duration >= 150 && (record?.multiStop || Number(record?.tolls || 0) > 0);
    return {
      explicitHighway,
      serviceAreaPreferred: explicitHighway || longCorridor,
      label: explicitHighway ? "高速路线" : longCorridor ? "长途路线" : "普通道路"
    };
  }

  function serviceLocationLabel(record, progress) {
    const target = Math.max(0, Math.min(1, Number(progress) || 0));
    const landmarks = [
      ...(Array.isArray(record?.stops) ? record.stops : []),
      ...(Array.isArray(record?.viaWaypoints) ? record.viaWaypoints : [])
    ].filter((item) => item?.name && Number.isFinite(Number(item.routeProgress)));
    const nearest = landmarks
      .map((item) => ({ item, delta: Math.abs(Number(item.routeProgress) - target) }))
      .sort((a, b) => a.delta - b.delta)[0];
    if (nearest && nearest.delta <= 0.14) return `${nearest.item.name}附近`;
    return `高德路线约 ${Math.round(target * 100)}% 处`;
  }

  function defaultServiceDetourAllowanceKm(record) {
    if (!record) return 0;
    if (state.detourExplicit) return Math.max(0, Number(state.maxDetourKm || 0));
    const base = Math.max(0, Number(record.baseDistance || record.distance || 0));
    const context = serviceRouteContext(record);
    if (context.serviceAreaPreferred) return Math.max(8, Math.min(20, base * 0.015));
    if (record.multiStop) return Math.max(6, Math.min(16, base * 0.012));
    // City/non-highway service candidates need a small but non-zero allowance;
    // the old zero-kilometre default rejected any POI that was not exactly on
    // the polyline, even when a few kilometres of local road were reasonable.
    return Math.max(3, Math.min(10, base * 0.03 || 4));
  }

  function nextDailyMoment(departureMinutes, durationMinutes, startMinute, endMinute) {
    const earliest = departureMinutes + 25;
    const latest = departureMinutes + durationMinutes;
    for (let day = 0; day <= 1; day += 1) {
      const start = day * 1440 + startMinute;
      const end = day * 1440 + endMinute;
      if (end < earliest || start > latest) continue;
      return Math.max(earliest, start);
    }
    return null;
  }

  function serviceTriggerForRecord(record) {
    // Service prompts are rule-based demo UX, not a claim that total trip time is
    // 2 hours. `record.duration` comes from the high-de driving route (minutes of
    // pure driving). Rest/coffee triggers fire only on long corridors and point at
    // an intermediate rest window, while the title must still show full trip time.
    if (!record || record.servicePlan || Number(record.duration || 0) < 75) return null;
    const departure = state.departureMinutes;
    const duration = Number(record.duration || 0);
    const driveLabel = formatDuration(duration);
    // 天气感知：雨雪/恶劣天气时给一句"优先室内"的提示，让服务建议不只是按时长
    // 触发，也响应沿线天气。weatherFactor=1（晴/阴）时不附加，避免噪音。
    const weather = state.weather;
    const weatherSuffix = weather && Number(weather.weatherFactor) > 1
      ? `当前起点${weather.city || ""}天气${weather.condition}，建议优先选择可室内停靠的服务点。`
      : "";
    const lunch = nextDailyMoment(departure, duration, 11 * 60 + 30, 13 * 60 + 30);
    const dinner = nextDailyMoment(departure, duration, 17 * 60 + 30, 20 * 60);
    const events = [
      ...[lunch, dinner].filter(Number.isFinite).map((targetMinute) => ({ kind: "meal", icon: "utensils", targetMinute })),
      ...(duration >= 130 ? [{ kind: "rest", icon: "armchair", targetMinute: departure + 120 }] : [])
    ].filter((event) => event.targetMinute > departure + 25 && event.targetMinute <= departure + duration)
      .sort((a, b) => a.targetMinute - b.targetMinute);
    const primary = events[0];
    const secondary = events[1];
    if (primary) {
      const progress = Math.max(0.08, Math.min(0.92, (primary.targetMinute - departure) / Math.max(1, duration)));
      const locationLabel = serviceLocationLabel(record, progress);
      const secondaryCopy = secondary
        ? `之后约 ${formatClock(secondary.targetMinute)} 还会进入${secondary.kind === "meal" ? "用餐" : "休息"}窗口。`
        : "";
      if (primary.kind === "meal") {
        return {
          kind: "meal",
          icon: "utensils",
          title: `预计 ${formatClock(primary.targetMinute)} 在${locationLabel}进入用餐时段`,
          text: `主路线纯驾驶约 ${driveLabel}。预计在${locationLabel}可以进行就餐或短暂休息，是否需要？确认后会在该位置附近检索服务并重算 ETA。${secondaryCopy}${weatherSuffix}`,
          targetMinute: primary.targetMinute,
          progress,
          locationLabel
        };
      }
      return {
        kind: "rest",
        icon: "armchair",
        title: `连续驾驶约 2 小时 · ${formatClock(primary.targetMinute)} 在${locationLabel}休息`,
        text: `高德主路线纯驾驶约 ${driveLabel}。预计在${locationLabel}附近短暂休息或喝咖啡，是否需要？这是疲劳驾驶提醒，确认后会按该位置检索顺路服务。${secondaryCopy}${weatherSuffix}`,
        targetMinute: primary.targetMinute,
        progress,
        locationLabel
      };
    }
    if (duration >= 90) {
      const restAfterMinutes = 90;
      const targetMinute = departure + restAfterMinutes;
      const progress = Math.max(0.08, Math.min(0.92, restAfterMinutes / duration));
      const locationLabel = serviceLocationLabel(record, progress);
      return {
        kind: "coffee",
        icon: "coffee",
        title: `全程约 ${driveLabel} · ${formatClock(targetMinute)} 在${locationLabel}短暂停靠`,
        text: `主路线纯驾驶约 ${driveLabel}。预计在${locationLabel}附近可以短暂停靠，是否需要？确认后会在该位置附近查看咖啡或休息建议。${weatherSuffix}`,
        targetMinute,
        progress,
        locationLabel
      };
    }
    return null;
  }

  function updateServiceNudge(record) {
    const nudge = byId("serviceNudge");
    const expand = byId("expandInsight");
    const trigger = serviceTriggerForRecord(record);
    if (!nudge || !trigger) {
      if (nudge) {
        nudge.hidden = true;
        nudge.classList.remove("is-recommended");
      }
      byId("serviceFlow")?.classList.remove("is-recommended");
      if (expand && expand.dataset.nudgeLabel === "1") {
        const label = expand.querySelector("span");
        if (label) label.textContent = "站点详情";
        delete expand.dataset.nudgeLabel;
      }
      return;
    }
    const key = `${state.destinationName}|${record.key}|${trigger.kind}|${Math.round(trigger.targetMinute)}`;
    if (state.serviceSuggestionDismissed.has(key)) {
      nudge.hidden = true;
      nudge.classList.remove("is-recommended");
      return;
    }
    if (!state.serviceSuggestion || state.serviceSuggestion.key !== key) {
      state.serviceSuggestion = Object.assign({ key, recordKey: record.key, accepted: false, loading: false, options: [] }, trigger);
    }
    const suggestion = state.serviceSuggestion;
    nudge.hidden = Boolean(suggestion.accepted);
    nudge.classList.toggle("is-recommended", !suggestion.accepted);
    setText("serviceNudgeTitle", suggestion.title);
    setText("serviceNudgeText", suggestion.text);
    const icon = byId("serviceNudgeIcon");
    if (icon) icon.setAttribute("data-lucide", suggestion.icon);
    if (expand && !suggestion.accepted) {
      const label = expand.querySelector("span");
      if (label) {
        // Right-panel strip: first-time users often miss the service block below.
        label.textContent = "站点·服务";
        expand.dataset.nudgeLabel = "1";
        expand.setAttribute("aria-label", "展开站点详情与非油服务推荐");
      }
    } else if (expand && suggestion.accepted && expand.dataset.nudgeLabel === "1") {
      const label = expand.querySelector("span");
      if (label) label.textContent = "站点详情";
      expand.setAttribute("aria-label", "展开站点详情");
      delete expand.dataset.nudgeLabel;
    }
    refreshIcons();
  }

  function passesServiceRecommendationPrecheck(record, service) {
    // A recommendation should not be a card that is very likely to fail as
    // soon as the user clicks it. First reject a POI whose estimated road
    // detour already exceeds the same long-trip allowance used by execution.
    // When a hard arrival deadline is set, also keep a conservative time
    // buffer. The definitive route/ETA is still computed after click.
    if (!record || !service) return false;
    const inline = Boolean(service.inlineStationId);
    const estimatedRoadKm = inline ? 0 : Math.max(0.6, Number(service.detourKm || 0) * 2);
    const detourAllowanceKm = state.detourExplicit
      ? Math.max(0, Number(state.maxDetourKm || 0))
      : defaultServiceDetourAllowanceKm(record);
    if (!inline && estimatedRoadKm > detourAllowanceKm + 1e-6) return false;
    if (!hasArrivalDeadline()) return true;
    const slackMinutes = Number(state.deadlineMinutes) - Number(record?.arrival);
    if (!Number.isFinite(slackMinutes) || slackMinutes <= 0) return false;
    const corridorKm = inline
      ? 0
      : Math.max(0.6, Number(service?.detourKm || 0) * 3);
    const detourDriveMinutes = inline ? 0 : Math.max(2, Math.ceil(corridorKm / 0.72));
    const dwellMinutes = inline ? Math.max(0, Number(service?.durationMinutes || 0) - 8) : Math.max(0, Number(service?.durationMinutes || 0));
    const energyBufferMinutes = inline ? 0 : 3;
    const conservativeExtraMinutes = detourDriveMinutes + dwellMinutes + energyBufferMinutes;
    return conservativeExtraMinutes + 6 <= slackMinutes;
  }

  async function loadServiceRecommendations(record, options = {}) {
    let suggestion = state.serviceSuggestion;
    if (options.action && record) {
      const kind = options.kind || "meal";
      const progress = Math.max(0.08, Math.min(0.92, Number(options.progress ?? 0.45)));
      suggestion = Object.assign({}, suggestion && suggestion.recordKey === record.key ? suggestion : {}, {
        key: `action-${record.key}-${kind}-${stableHash(options.preferredName || "service")}`,
        recordKey: record.key,
        accepted: true,
        loading: false,
        options: [],
        kind,
        targetMinute: Math.round(state.departureMinutes + Number(record.duration || 0) * progress),
        progress,
        locationLabel: serviceLocationLabel(record, progress)
      });
      state.serviceSuggestion = suggestion;
    }
    if (!record || !suggestion || suggestion.recordKey !== record.key || !state.AMap) return;
    suggestion.accepted = true;
    suggestion.loading = true;
    const requestId = ++state.serviceRequestVersion;
    byId("serviceNudge").hidden = true;
    revealServiceFlow({ attention: true, toast: "请在右侧查看非油服务推荐" });
    renderServiceRecommendations(record);
    const center = pointAtPathProgress(record.path, suggestion.progress);
    if (!center) return;
    const preferredName = String(options.preferredName || "").trim();
    const serviceKind = options.kind || suggestion.kind || "meal";
    let searches = preferredName
      ? [[preferredName, serviceKind], ...(serviceKind === "meal" ? [["餐厅", "meal"], ["咖啡厅", "coffee"]] : serviceKind === "rest" ? [["休息区", "rest"], ["咖啡厅", "coffee"]] : [["咖啡厅", "coffee"], ["便利店", "rest"]])]
      : suggestion.kind === "meal"
        ? [["餐厅", "meal"], ["咖啡厅", "coffee"]]
        : suggestion.kind === "rest"
          ? [["休息区", "rest"], ["咖啡厅", "coffee"]]
          : [["咖啡厅", "coffee"], ["便利店", "rest"]];
    const routeContext = serviceRouteContext(record);
    if (!preferredName && routeContext.serviceAreaPreferred && (serviceKind === "meal" || serviceKind === "rest" || serviceKind === "coffee")) {
      // On a confirmed highway, search service areas first.  For a long
      // corridor whose AMap response omitted road names, this is a deliberate
      // “service-area preferred” fallback, not a claim that every metre is
      // motorway.  It avoids asking a driver to leave the highway for lunch.
      searches = [["服务区", "service-area"], ...searches];
    }
    const results = await searchInBatches(searches.map(([keyword, type]) => () => searchNearby(keyword, center, type)), 2);
    if (requestId !== state.serviceRequestVersion || state.serviceSuggestion?.key !== suggestion.key) return;
    const durationByType = { meal: 20, coffee: 12, rest: 15 };
    const iconByType = { meal: "utensils", coffee: "coffee", rest: "armchair" };
    const energyStops = record.stops?.length ? record.stops : record.station ? [record.station] : [];
    const allCandidates = dedupePois(results.flat())
      .map((poi) => {
        const type = poi.serviceAreaCandidate
          ? serviceKind === "meal" ? "meal" : "rest"
          : poi.type === "meal" || poi.type === "coffee" ? poi.type : "rest";
        const nearestEnergyStop = energyStops.slice().sort((a, b) => distanceKm(a.location, poi.location) - distanceKm(b.location, poi.location))[0];
        const inlineStationId = nearestEnergyStop && distanceKm(nearestEnergyStop.location, poi.location) <= 1.5 ? nearestEnergyStop.id : null;
        const detourKm = Math.max(0.3, nearestPointDistance(poi.location, record.path) * 2 + 0.3);
        const candidateProgress = Number(routeProgress(poi.location, record.path).toFixed(4));
        const candidateLocation = suggestion.locationLabel || serviceLocationLabel(record, candidateProgress);
        const reason = poi.serviceAreaCandidate
          ? `${routeContext.explicitHighway ? "高速服务区候选" : "长途路线服务区候选"} · 预计在${candidateLocation}附近停靠，避免下高速`
          : inlineStationId ? "靠近计划补能站，可与驻留时间并行安排" : `预计在${candidateLocation}附近 · 距主路线约 ${detourKm.toFixed(1)} km，加入后会重算 ETA`;
        return Object.assign({}, poi, {
          id: `service-${poi.id || stableHash(`${poi.name}-${poi.location.join(",")}`)}`,
          serviceType: type,
          icon: iconByType[type],
          durationMinutes: durationByType[type],
          routeProgress: candidateProgress,
          detourKm: Number(detourKm.toFixed(1)),
          inlineStationId,
          targetLocationLabel: candidateLocation,
          highwayServiceArea: Boolean(poi.serviceAreaCandidate),
          reason
        });
      })
      .sort((a, b) => a.detourKm - b.detourKm);
    const exactLocated = preferredName && typeof serviceIntent.matchesPoi === "function"
      ? allCandidates.filter((service) => serviceIntent.matchesPoi(preferredName, service))
      : [];
    // Keep exact brand matches in the candidate window even if the generic
    // restaurant query returned many nearer results.  Matching is performed on
    // the POI name/address, never on the service category alone.
    const candidates = preferredName && exactLocated.length
      ? exactLocated.concat(allCandidates.filter((service) => !exactLocated.includes(service))).slice(0, 8)
      : allCandidates.slice(0, 8);
    const recommended = candidates
      .filter((service) => passesServiceRecommendationPrecheck(record, service))
      .sort((a, b) => {
        if (!preferredName) return a.detourKm - b.detourKm;
        const aExact = typeof serviceIntent.matchesPoi === "function" && serviceIntent.matchesPoi(preferredName, a) ? 0 : 1;
        const bExact = typeof serviceIntent.matchesPoi === "function" && serviceIntent.matchesPoi(preferredName, b) ? 0 : 1;
        return aExact - bExact || a.detourKm - b.detourKm;
      });
    const exactRecommended = preferredName && typeof serviceIntent.matchesPoi === "function"
      ? recommended.filter((service) => serviceIntent.matchesPoi(preferredName, service))
      : [];
    const displayed = preferredName && !exactRecommended.length
      ? recommended.map((service) => Object.assign({}, service, { alternative: true }))
      : exactRecommended.length ? exactRecommended : recommended;
    suggestion.requestedServiceName = preferredName || null;
    suggestion.exactMatchLocated = Boolean(exactLocated.length);
    suggestion.exactMatchFound = Boolean(exactRecommended.length);
    suggestion.filteredOutCount = Math.max(0, candidates.length - recommended.length);
    suggestion.options = displayed.slice(0, 4).map((service) => Object.assign({}, service, {
      reason: hasArrivalDeadline()
        ? `${service.alternative ? "可选替代 · " : ""}${service.reason} · 已通过到达时限预筛`
        : `${service.alternative ? "可选替代 · " : ""}${service.reason}`
    }));
    suggestion.loading = false;
    renderServiceRecommendations(record);
    if (suggestion.options.length) {
      revealServiceFlow({ attention: true, toast: `已在右侧生成 ${suggestion.options.length} 个可加入服务` });
    } else {
      revealServiceFlow({ attention: false });
    }
  }

  function renderServiceRecommendations(record) {
    const container = byId("serviceRecommendations");
    const dwellLabel = byId("serviceDwellTime");
    const flow = byId("serviceFlow");
    if (!container || !record) return;
    const suggestion = state.serviceSuggestion;
    const serviceButton = byId("serviceFeedbackButton");
    if (state.activeServicePlan) {
      flow?.classList.add("is-recommended");
      if (dwellLabel) dwellLabel.textContent = `已加入路线 · 预计额外 ${state.activeServicePlan.extraMinutes || 0} 分钟`;
      const estimated = state.activeServicePlan.routeMode === "estimated-corridor";
      const description = estimated
        ? "已加入行程；当前按高德 POI 与主路线的绕行估算，待路线接口二次核验"
        : "已加入行程，路线与 ETA 已按服务停靠重新计算";
      container.innerHTML = `<div class="service-card selected"><i data-lucide="${state.activeServicePlan.icon || "utensils"}"></i><span><strong>${escapeHtml(state.activeServicePlan.name)}</strong><small>${description}</small></span><span>+${state.activeServicePlan.extraMinutes || 0}分</span></div>`;
      if (serviceButton) { serviceButton.disabled = false; serviceButton.textContent = "模拟完成服务"; }
      setText("serviceStatus", "服务已加入到站计划");
      refreshIcons();
      return;
    }
    if (!suggestion || suggestion.recordKey !== record.key || !suggestion.accepted) {
      flow?.classList.remove("is-recommended");
      if (dwellLabel) dwellLabel.textContent = "系统会在饭点或长时间驾驶前主动提示";
      container.innerHTML = '<div class="service-card"><i data-lucide="sparkles"></i><span><strong>等待服务建议</strong><small>根据预计经过时间和沿线路况触发餐饮、咖啡或休息建议。</small></span></div>';
      if (serviceButton) { serviceButton.disabled = true; serviceButton.textContent = "等待推荐"; }
      setText("serviceStatus", "尚未安排非油服务");
      refreshIcons();
      return;
    }
    if (suggestion.loading) {
      flow?.classList.add("is-recommended");
      if (dwellLabel) dwellLabel.textContent = `正在检索 ${formatClock(suggestion.targetMinute)} 附近服务`;
      container.innerHTML = '<div class="service-card"><i data-lucide="loader-circle"></i><span><strong>正在检索沿线真实 POI</strong><small>仅展示高德返回的餐饮、咖啡和休息候选。</small></span></div>';
      refreshIcons();
      return;
    }
    const options = suggestion.options || [];
    flow?.classList.toggle("is-recommended", options.length > 0);
    const excludedByDeadline = Number(suggestion.filteredOutCount || 0);
    if (dwellLabel) dwellLabel.textContent = `预计 ${formatClock(suggestion.targetMinute)} 在${suggestion.locationLabel || serviceLocationLabel(record, suggestion.progress)}附近经过 · 高德真实 POI`;
    const requestedName = String(suggestion.requestedServiceName || "").trim();
    const hasExact = Boolean(suggestion.exactMatchFound);
    container.innerHTML = options.length
      ? options.map((service) => `<button type="button" class="service-card ${state.selectedService === service.id ? "selected" : ""}" data-service="${escapeHtml(service.id)}"><i data-lucide="${service.icon}"></i><span><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.reason)}</small></span><span>约${service.durationMinutes}分</span></button>`).join("")
      : `<div class="service-card"><i data-lucide="${excludedByDeadline ? "clock-alert" : "map-pin-off"}"></i><span><strong>${requestedName ? (suggestion.exactMatchLocated ? `“${escapeHtml(requestedName)}”当前不可安全加入` : `未找到“${escapeHtml(requestedName)}”`) : (excludedByDeadline ? "当前约束下不建议增加服务停靠" : "附近未检索到合适服务")}</strong><small>${requestedName ? "没有静默替换为其他商家；可调整路线约束后重试。" : excludedByDeadline ? "候选服务会超出当前绕行或到达时间余量，已自动隐藏；可调整约束后重新查看。" : "可继续行驶，系统会在下一个时间窗口再次评估。"}</small></span></div>`;
    if (serviceButton) { serviceButton.disabled = true; serviceButton.textContent = "选择服务后继续"; }
    setText("serviceStatus", options.length
      ? requestedName && !hasExact
        ? `未找到“${requestedName}”；下方为可选替代，点击后才会加入`
        : `${excludedByDeadline ? "已按路线约束完成候选预筛；" : ""}选择服务后，系统将重新计算路线和 ETA`
      : requestedName
        ? `未找到“${requestedName}”，没有自动替换商家`
        : excludedByDeadline ? "为满足当前路线约束，本次不增加服务停靠" : "本次不增加服务停靠");
    refreshIcons();
  }

  async function applyServicePlan(service) {
    setText("serviceStatus", "正在将服务停靠加入真实路线并重算 ETA…");
    const preferredRole = state.selectedRoute;
    const evaluateServiceOnRoute = async (role, record) => {
      if (!record || !service?.location) return { role, record, updated: null, serviceDetourWithinLimit: false, incrementalDetourKm: Infinity, energyStops: [] };
      const energyStops = record.stops?.length ? record.stops : record.station ? [record.station] : [];
      const path = record.path || [];
      const energyWaypoints = energyStops.map((station) => Object.assign({}, station, {
        kind: "energy",
        routeProgress: Number.isFinite(Number(station.routeProgress)) ? Number(station.routeProgress) : routeProgress(station.location, path)
      }));
      // The inline relationship belongs to a specific route's energy stops.
      // A fallback strategy may use different stations, so never silently
      // inherit an inline id that is not present on the fallback route.
      const inlineStationId = energyStops.some((station) => station.id === service.inlineStationId) ? service.inlineStationId : null;
      const isInlineService = Boolean(inlineStationId);
      const serviceWaypoint = Object.assign({}, service, {
        kind: "service",
        durationMinutes: service.durationMinutes,
        routeProgress: Number.isFinite(Number(service.routeProgress)) ? Number(service.routeProgress) : routeProgress(service.location, path)
      });
      const baseWaypoints = isInlineService ? energyWaypoints : energyWaypoints.concat(serviceWaypoint);
      const waypoints = routeStopsWithTripWaypoints(baseWaypoints, true);
      const base = state.baseRouteRecords[role] || state.baseRouteRecords.reliable || record;
      const longTripServiceAllowanceKm = defaultServiceDetourAllowanceKm(record);
      const route = await queryRouteSequence(role, waypoints, { includeTripWaypoints: false });
      const servicePlan = {
        id: service.id,
        name: service.name,
        icon: service.icon,
        serviceType: service.serviceType,
        serviceLabel: service.serviceType === "rest" ? "休息" : "餐饮",
        location: service.location,
        durationMinutes: service.durationMinutes,
        inlineStationId,
        source: "高德真实 POI / 演示服务时长"
      };
      let updated = route && buildValidatedLongTripRecord(role, base, route, waypoints, servicePlan);
      let incrementalDetourKm = route ? Math.max(0, Number(route.distance || 0) - Number(record.distance || 0)) : Infinity;
      let estimatedServiceRoute = false;
      let serviceDetourWithinLimit = isInlineService
        || Boolean(updated?.detourWithinLimit)
        || (!state.detourExplicit && Number.isFinite(incrementalDetourKm) && incrementalDetourKm <= longTripServiceAllowanceKm + 1e-6);
      // The POI itself is real, but a routing provider can occasionally reject
      // a burst of national-road leg requests. For a small, non-explicit
      // detour, retain a clearly-labelled corridor estimate rather than making
      // every restaurant card look broken. Energy is topped up at the final
      // planned stop, so the displayed arrival reserve is still conserved.
      if (!updated && !state.detourExplicit && record.multiStop && Number.isFinite(Number(service.detourKm))) {
        const estimatedRoadKm = Math.max(0.6, Number(service.detourKm) * 2);
        const withinAllowance = estimatedRoadKm <= longTripServiceAllowanceKm + 1e-6;
        const topUpStop = energyStops.at(-1);
        if (withinAllowance && topUpStop) {
          const profile = getEnergyProfile(isFuelActive());
          const topUpAmount = estimatedRoadKm * profile.consumptionPerKm / profile.transferEfficiency;
          const topUpMinutes = longTripChargeMinutes(topUpAmount, topUpStop);
          const detourDriveMinutes = Math.max(2, Math.ceil(estimatedRoadKm / 0.72));
          const extraMinutes = Math.max(0, Number(service.durationMinutes || 0)) + detourDriveMinutes + topUpMinutes;
          const finalPrice = Math.max(0, Number(topUpStop.price || 0));
          const total = Number(record.total || 0) + extraMinutes;
          const arrival = state.departureMinutes + total;
          const lateMinutes = hasArrivalDeadline() ? Math.max(0, Math.ceil(arrival - state.deadlineMinutes)) : 0;
          const updatedStops = (record.stops || []).map((stop, index, allStops) => index === allStops.length - 1
            ? Object.assign({}, stop, {
              energyAmount: Number((Number(stop.energyAmount || 0) + topUpAmount).toFixed(1)),
              chargeMinutes: Number(stop.chargeMinutes || 0) + topUpMinutes,
              energyCost: Number((Number(stop.energyCost || 0) + topUpAmount * finalPrice).toFixed(1))
            })
            : Object.assign({}, stop));
          updated = Object.assign({}, record, {
            key: role,
            candidateKey: role,
            distance: Number((Number(record.distance || 0) + estimatedRoadKm).toFixed(1)),
            duration: Number((Number(record.duration || 0) + detourDriveMinutes).toFixed(1)),
            stops: updatedStops,
            chargeMinutes: Number(record.chargeMinutes || 0) + topUpMinutes,
            energyAmount: Number((Number(record.energyAmount || 0) + topUpAmount).toFixed(1)),
            energyCost: Number((Number(record.energyCost || 0) + topUpAmount * finalPrice).toFixed(1)),
            cost: Number((Number(record.cost || 0) + topUpAmount * finalPrice).toFixed(1)),
            total,
            p90Total: Number(record.p90Total || record.total || 0) + extraMinutes,
            arrival,
            lateMinutes,
            onTime: Math.max(50, Number(record.onTime || 0) - Math.ceil(extraMinutes * 0.45)),
            detour: Number((Number(record.detour || 0) + estimatedRoadKm).toFixed(1)),
            canReachStation: true,
            targetSocMet: true,
            detourWithinLimit: withinAllowance,
            feasible: lateMinutes === 0 && withinAllowance,
            servicePlan: Object.assign({}, servicePlan, { extraMinutes }),
            source: "高德主路线 + 沿线 POI 绕行估算（待二次核验）"
          });
          incrementalDetourKm = estimatedRoadKm;
          serviceDetourWithinLimit = true;
          estimatedServiceRoute = true;
        }
      }
      if (updated) {
        updated.servicePlan = Object.assign({}, updated.servicePlan, {
          inlineStationId,
          incrementalDetourKm: Number.isFinite(incrementalDetourKm) ? Number(incrementalDetourKm.toFixed(1)) : null,
          allowedIncrementalDetourKm: longTripServiceAllowanceKm || null,
          routeMode: estimatedServiceRoute ? "estimated-corridor" : isInlineService ? "inline" : "separate-stop"
        });
        updated.serviceDetourWithinLimit = serviceDetourWithinLimit;
        // For a non-explicit long-trip detour policy, evaluate the restaurant by
        // its added detour beyond the already-verified energy route, not against
        // the full detour budget a second time.
        if (serviceDetourWithinLimit) updated.detourWithinLimit = true;
        updated.feasible = Boolean(updated.canReachStation && updated.targetSocMet && updated.detourWithinLimit && updated.lateMinutes === 0);
      }
      return { role, record, updated, serviceDetourWithinLimit, incrementalDetourKm, energyStops, estimatedServiceRoute };
    };
    const canUse = (candidate) => Boolean(candidate.updated && candidate.updated.canReachStation && candidate.updated.targetSocMet && candidate.serviceDetourWithinLimit && candidate.updated.lateMinutes === 0);
    let candidate = await evaluateServiceOnRoute(preferredRole, state.routeRecords[preferredRole]);
    let switchedToFastest = false;
    // A meal can make the "most reliable" option miss the deadline by a few
    // minutes while the already-computed fastest option still meets every
    // constraint. Try that alternative before rejecting a useful service.
    if (!canUse(candidate) && preferredRole !== "fastest" && state.routeRecords.fastest?.feasible) {
      const fastestCandidate = await evaluateServiceOnRoute("fastest", state.routeRecords.fastest);
      if (canUse(fastestCandidate)) {
        candidate = fastestCandidate;
        switchedToFastest = true;
      }
    }
    const { role, record, updated, serviceDetourWithinLimit, incrementalDetourKm, energyStops, estimatedServiceRoute } = candidate;
    if (!canUse(candidate)) {
      showToast("加入服务后未通过补能或绕行约束，未修改原方案", 3400);
      const failure = !updated ? "服务路线暂未生成" : !updated.canReachStation ? "加入后无法安全抵达后续补能站" : !updated.targetSocMet ? "加入后无法满足到达余量" : !serviceDetourWithinLimit ? `服务额外绕行 ${Number(incrementalDetourKm || 0).toFixed(1)} km，超过允许范围` : `会使到达时间超过约束 ${updated.lateMinutes} 分钟`;
      setText("serviceStatus", `未加入：${failure}`);
      return;
    }
    updated.serviceOnly = energyStops.length === 0;
    updated.directTrip = false;
    updated.requiresStop = energyStops.length > 0;
    updated.displayName = record.displayName;
    updated.isActualFastest = record.isActualFastest;
    updated.isActualStable = record.isActualStable;
    updated.isActualCheapest = record.isActualCheapest;
    updated.recommended = record.recommended;
    if (state.multiStopRouteRecords) {
      state.multiStopRouteRecords[role] = updated;
      state.multiStopRouteRecords = reconcileRouteObjectiveAliases(state.multiStopRouteRecords);
      state.routeRecords = state.multiStopRouteRecords;
    } else {
      state.serviceRouteOverrides[role] = updated;
      calculateRouteRecords();
    }
    state.selectedService = service.id;
    state.activeServicePlan = updated.servicePlan;
    if (state.aiContext) {
      const services = Array.isArray(state.aiContext.services) ? state.aiContext.services : [];
      const label = updated.servicePlan.serviceLabel || "餐饮";
      state.aiContext.services = Array.from(new Set([...services, label]));
    }
    // Keep the service-adjusted option active. Otherwise the normal “best
    // route” auto-selection can immediately switch the details panel back to
    // a different direct alternative and make a successfully added stop look
    // like it disappeared.
    state.selectedRoute = role;
    state.routeSelectionTouched = true;
    if (state.live) {
      drawAmapRoutes();
      fitAmapView();
    }
    renderRouteCards();
    const switchNote = switchedToFastest ? "为满足最晚到达约束，已切换至最快到达方案；" : "";
    const estimateNote = estimatedServiceRoute ? "路线接口暂不可用，当前 ETA 为沿线绕行估算，待二次核验。" : "ETA 已按真实服务停靠重新计算。";
    setAiReply(`已将 ${service.name} 加入行程，${switchNote}${estimateNote}`);
    showToast(`已加入 ${service.name}${switchedToFastest ? "，已切换为最快到达" : ""}${estimatedServiceRoute ? "，等待路线二次核验" : "，ETA 已按真实路线重算"}`, 3400);
    revealServiceFlow({ attention: true });
  }

  async function applyServiceAction(action) {
    const record = state.routeRecords[state.selectedRoute] || state.routeRecords.reliable;
    if (!record) return { ok: false, message: "当前还没有可加入服务的路线" };
    const label = actionServiceLabel(action) || "餐饮";
    // 补能由路线规划器统一安排，洗车也不是当前服务推荐模块的可执行
    // 类型。不要把这两类动作误映射成餐厅搜索，更不能在没有真实候选的
    // 情况下给出“已加入”的假成功。
    if (label === "补能" || label === "洗车") {
      const message = label === "补能"
        ? "补能停靠由当前路线规划统一安排，请调整动力类型或路线偏好"
        : "当前演示暂不支持把洗车作为服务停靠加入行程";
      setText("serviceStatus", message);
      return { ok: false, message };
    }
    const preferredName = String(action?.name || "").trim();
    const kind = label === "休息" ? "rest" : preferredName && /咖啡|星巴克|瑞幸/.test(preferredName) ? "coffee" : "meal";
    const trigger = serviceTriggerForRecord(record);
    await loadServiceRecommendations(record, {
      action: true,
      kind,
      preferredName,
      progress: Number.isFinite(Number(trigger?.progress))
        ? trigger.progress
        : Number.isFinite(Number(record.duration)) && Number(record.duration) > 0 ? Math.min(0.82, Math.max(0.18, 90 / Number(record.duration))) : 0.45
    });
    const options = state.serviceSuggestion?.recordKey === record.key ? (state.serviceSuggestion.options || []) : [];
    if (!options.length) {
      const message = preferredName
        ? `沿当前路线未找到可安全加入的“${preferredName}”，没有自动替换商家`
        : `当前路线没有可安全加入的${label}服务`;
      setText("serviceStatus", message);
      return { ok: false, message };
    }
    const choice = typeof serviceIntent.chooseServiceCandidate === "function"
      ? serviceIntent.chooseServiceCandidate(options, preferredName)
      : { candidate: preferredName ? options.find((service) => String(service.name || "").includes(preferredName)) : options[0] };
    const exact = choice.exact || null;
    // An explicit brand/keyword is a hard semantic preference for this action.
    // Generic alternatives remain visible for an intentional click, but the
    // second-turn action itself must not silently become “天祥餐馆” (or any
    // other unrelated POI).
    if (preferredName && !exact) {
      const message = `未找到“${preferredName}”，未自动替换为其他商家；可在右侧选择替代`;
      setText("serviceStatus", message);
      setAiReply(message);
      return { ok: false, message };
    }
    const candidate = choice.candidate || options[0];
    await applyServicePlan(candidate);
    const succeeded = state.activeServicePlan?.id === candidate.id;
    if (!succeeded) return { ok: false, message: `“${candidate.name}”未通过真实路线复算，没有加入行程` };
    return { ok: true, message: `已加入${candidate.name}` };
  }

  async function applyPostRouteActions(actions) {
    const applied = [];
    const failed = [];
    for (const action of Array.isArray(actions) ? actions : []) {
      if (action.type !== "ADD_SERVICE") continue;
      const result = await applyServiceAction(action);
      (result.ok ? applied : failed).push(action);
      if (!result.ok) showToast(result.message, 3600);
      else state.lastActionSummary = result.message;
    }
    return { applied, failed };
  }

  // 运营页标题原来写死"北京区域补能供需"：用户规划"从上海去杭州"后打开运营视图，
  // 标题仍写北京。从起点名/备注里提取城市 token，提不到就退成"沿线"，不再假设北京。
  const REGION_CITY_PATTERN = /北京|上海|天津|重庆|广州|深圳|杭州|南京|济南|成都|武汉|西安|苏州|长沙|青岛|大连|沈阳|哈尔滨|长春|昆明|厦门|福州|郑州|合肥|南昌|石家庄|太原|呼和浩特|银川|乌鲁木齐|拉萨|西宁|兰州|南宁|海口|贵阳|宁波|无锡|佛山|东莞|烟台|温州|唐山|徐州|潍坊|保定|廊坊|沧州|德州/;
  function originRegionLabel() {
    const source = `${state.originName || ""} ${state.originNote || ""}`;
    const match = source.match(REGION_CITY_PATTERN);
    return match ? `${match[0]}区域` : "沿线";
  }

  function syncOperatorPanelTitle() {
    setText("operatorPanelTitle", `${originRegionLabel()}补能供需`);
  }

  function setOperatorAnalysisStep(step, stateName, label) {
    const card = byId(step === "simulation" ? "operatorSimulationStep" : "operatorFeishuStep");
    const state = byId(step === "simulation" ? "operatorSimulationState" : "operatorFeishuState");
    if (!card || !state) return;
    card.classList.remove("active", "processing", "complete", "error");
    if (stateName === "processing") card.classList.add("processing");
    else if (stateName === "completed") card.classList.add("complete");
    else if (stateName === "error" || stateName === "not-configured") card.classList.add("error");
    else if (step === "simulation") card.classList.add("active");
    state.textContent = label;
  }

  function resetOperatorAnalysisSteps() {
    setOperatorAnalysisStep("simulation", "idle", "待开始");
    setOperatorAnalysisStep("feishu", "idle", "等待仿真结果");
  }

  function parseFeishuAiResult(value) {
    const raw = String(value || "").trim();
    if (!raw) return [];
    // The Feishu field may return one line or multiple lines. Split only before
    // numbered conclusions, so decimal values such as 4.5 are preserved.
    const body = raw.split(/(?:\s*[·；;]\s*)?数据来源：/i)[0].trim();
    return body
      .replace(/\s+(?=\d+\.\s)/g, "\n")
      .split(/\n+/)
      .map((entry) => entry.replace(/^\s*\d+\.\s*/, "").trim().replace(/operationally-effective/gi, "场景有效但仿真收益假设未达标"))
      .filter(Boolean);
  }

  function renderFeishuAiResult(result = state.feishuSync) {
    const empty = byId("feishuAiEmpty");
    const conclusions = byId("feishuAiConclusions");
    const source = byId("feishuAiSource");
    if (!empty || !conclusions) return;
    const status = result?.status;
    const entries = status === "completed" ? parseFeishuAiResult(result.aiResult) : [];
    if (entries.length) {
      empty.hidden = true;
      conclusions.hidden = false;
      conclusions.innerHTML = entries.map((entry, index) => `<article class="feishu-ai-conclusion"><span class="feishu-ai-conclusion-index">${String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(entry)}</p></article>`).join("");
      if (source) source.innerHTML = "<strong>数据来源：</strong>FlowTwin 演示仿真；以上不是企业实时经营结论。";
      return;
    }
    conclusions.hidden = true;
    if (status === "processing" || status === "syncing") {
      empty.hidden = false;
      empty.textContent = "正在等待飞书 AI 返回运营解读……";
      if (source) source.textContent = "仿真结果已生成，AI 正在读取策略记录。";
    } else if (status === "error" || result?.mode === "error") {
      empty.hidden = false;
      empty.textContent = `策略沙盘结果已生成，但飞书 AI 暂时不可用：${result.message || "请检查配置或权限"}`;
      if (source) source.textContent = "策略沙盘结果不受影响；飞书 AI 结果未伪造。";
    } else if (status === "not-configured") {
      empty.hidden = false;
      empty.textContent = "策略沙盘结果已生成，当前未配置飞书 AI；不会用示例文字冒充 AI 结果。";
      if (source) source.textContent = "策略沙盘结果不受影响；飞书 AI 需要完成服务配置后使用。";
    } else {
      empty.hidden = false;
      empty.textContent = "点击“开始智能分析”，先生成策略沙盘结果，再查看 AI 对运营结果的自然语言解读。";
      if (source) source.textContent = "数据来源将在分析完成后明确标注；当前不代表企业实时经营结论。";
    }
  }

  function renderFeishuSyncStatus(result = state.feishuSync) {
    const status = byId("feishuSyncStatus");
    const button = byId("feishuSyncButton");
    if (!status) return;
    const stateName = result?.status === "error" || result?.mode === "error"
      ? "error"
      : result?.status === "completed"
        ? "completed"
        : result?.status === "processing" || result?.status === "syncing"
          ? "processing"
          : "idle";
    status.dataset.state = stateName;
    if (stateName === "completed") {
      const entryCount = parseFeishuAiResult(result.aiResult).length;
      const resultSummary = entryCount ? `已生成 ${entryCount} 条运营解读` : "已返回 AI 策略结果";
      status.innerHTML = `<strong>飞书 AI 已完成</strong> · ${resultSummary}`;
      setOperatorAnalysisStep("feishu", "completed", "已完成");
    } else if (stateName === "processing") {
      status.innerHTML = `<strong>飞书 AI 分析中</strong> · 已同步 ${Number(result.stationCount || 0)} 个站点，等待 AI 字段返回`;
      setOperatorAnalysisStep("feishu", "processing", "分析中");
    } else if (stateName === "error") {
      status.innerHTML = `<strong>飞书同步失败</strong> · ${escapeHtml(result.message || "请检查配置、权限或字段名称")}`;
      setOperatorAnalysisStep("feishu", "error", "暂不可用");
    } else if (result?.status === "not-configured") {
      status.innerHTML = `<strong>本地演示模式</strong> · 未配置飞书多维表格，当前运营结果仍可在本页查看`;
      setOperatorAnalysisStep("feishu", "not-configured", "未配置");
    } else {
      status.innerHTML = `<strong>等待仿真结果</strong> · 点击“开始智能分析”后自动请求飞书 AI`;
      setOperatorAnalysisStep("feishu", "idle", "等待仿真结果");
    }
    renderFeishuAiResult(result);
    if (button) button.disabled = stateName === "processing";
  }

  function resetFeishuSync() {
    state.feishuPollVersion += 1;
    state.feishuSync = null;
    renderFeishuSyncStatus(null);
  }

  function compactFeishuStation(station = {}) {
    if (!station || typeof station !== "object") return null;
    const numberOrUndefined = (value) => {
      const number = Number(value);
      return Number.isFinite(number) ? number : undefined;
    };
    const textOrUndefined = (value, max = 120) => {
      const valueText = String(value ?? "").trim();
      return valueText ? valueText.slice(0, max) : undefined;
    };
    const compact = {
      id: textOrUndefined(station.id, 100),
      name: textOrUndefined(station.name, 120) || "补能站",
      city: textOrUndefined(station.city, 80),
      region: textOrUndefined(station.region, 80),
      type: textOrUndefined(station.type, 40),
      source: textOrUndefined(station.source, 120),
      dataAsOf: textOrUndefined(station.dataAsOf, 80),
      capacity: numberOrUndefined(station.capacity),
      occupancy: numberOrUndefined(station.occupancy),
      arrivals15m: numberOrUndefined(station.arrivals15m ?? station.arrivalRate),
      serviceRate: numberOrUndefined(station.serviceRate),
      p50: numberOrUndefined(station.p50 ?? station.wait),
      p90: numberOrUndefined(station.p90 ?? station.wait),
      wait: numberOrUndefined(station.wait ?? station.p50),
      price: numberOrUndefined(station.price),
      discount: numberOrUndefined(station.discount),
      diversionRate: numberOrUndefined(station.diversionRate),
      roi: numberOrUndefined(station.roi),
      forecastMethod: textOrUndefined(station.forecastMethod, 60),
      forecastSource: textOrUndefined(station.forecastSource, 80),
      forecastDataAsOf: textOrUndefined(station.forecastDataAsOf || station.forecastAsOf, 80),
      forecastSimulation: station.forecastSimulation !== false,
      forecastFreshnessSeconds: numberOrUndefined(station.forecastFreshnessSeconds),
      forecastEnterprisePrior: station.forecastEnterprisePrior || station.enterprisePrior || null,
      forecastArrivalWaitP50: numberOrUndefined(station.forecastArrivalWaitP50 ?? station.p50),
      forecastArrivalWaitP90: numberOrUndefined(station.forecastArrivalWaitP90 ?? station.p90)
    };
    const input = station.forecastInputSnapshot || station.inputSnapshot;
    if (input && typeof input === "object" && !Array.isArray(input)) {
      compact.forecastInputSnapshot = {
        totalPorts: numberOrUndefined(input.totalPorts),
        idlePorts: numberOrUndefined(input.idlePorts),
        availablePorts: numberOrUndefined(input.availablePorts),
        reservedPorts: numberOrUndefined(input.reservedPorts),
        chargingPorts: numberOrUndefined(input.chargingPorts),
        faultPorts: numberOrUndefined(input.faultPorts),
        waitingVehicles: numberOrUndefined(input.waitingVehicles ?? input.queueVehicles),
        queueVehicles: numberOrUndefined(input.queueVehicles),
        reservationQueueAhead: numberOrUndefined(input.reservationQueueAhead),
        averageSessionMinutes: numberOrUndefined(input.averageSessionMinutes),
        dataSource: textOrUndefined(input.dataSource, 100),
        availabilitySource: textOrUndefined(input.availabilitySource, 100),
        queueSource: textOrUndefined(input.queueSource, 100)
      };
    }
    return compact;
  }

  function compactFeishuMetricSnapshot(value = {}) {
    return {
      averageWait: Number.isFinite(Number(value.averageWait)) ? Number(value.averageWait) : undefined,
      p90Wait: Number.isFinite(Number(value.p90Wait)) ? Number(value.p90Wait) : undefined,
      occupancyDispersion: Number.isFinite(Number(value.occupancyDispersion)) ? Number(value.occupancyDispersion) : undefined,
      peakQueue: Number.isFinite(Number(value.peakQueue)) ? Number(value.peakQueue) : undefined
    };
  }

  async function queryServerBaseRoute(key, policy) {
    const params = new URLSearchParams({
      origin: formatRouteCoordinate(state.origin),
      destination: formatRouteCoordinate(state.destination),
      plan: key,
      cartype: isFuelActive() ? "0" : "1"
    });
    try {
      const { route, payload } = await fetchRouteWithRetry(params);
      const path = Array.isArray(route.path) ? route.path.map(parseLocation).filter(Boolean) : [];
      const distanceKm = Number(route.distance);
      const durationMinutes = Number(route.duration);
      // /api/route already normalizes distance to km and duration to minutes;
      // unlike the browser SDK contract, it does not expose meters/seconds.
      if (path.length < 2 || !(distanceKm > 0) || !(durationMinutes > 0)) {
        throw new Error("INVALID_SERVER_ROUTE_RESPONSE");
      }
      return {
        key,
        path,
        distance: distanceKm,
        duration: durationMinutes,
        tolls: Number(route.tolls) || 0,
        highway: route.highway === true,
        routeClass: route.routeClass || (route.highway === true ? "highway" : "unknown"),
        roadNames: Array.isArray(route.roadNames) ? route.roadNames.slice(0, 80) : [],
        policy,
        routeSource: payload.source || route.source || "高德 Web 服务路线规划"
      };
    } catch (error) {
      recordRouteError(`${key}:base`, error);
      return null;
    }
  }

  function compactFeishuImpact(value = {}) {
    return {
      divertedVehicles: Number.isFinite(Number(value.divertedVehicles)) ? Number(value.divertedVehicles) : undefined,
      roi: Number.isFinite(Number(value.roi)) ? Number(value.roi) : undefined,
      scenarioRoi: Number.isFinite(Number(value.scenarioRoi)) ? Number(value.scenarioRoi) : undefined,
      retainedOrders: Number.isFinite(Number(value.retainedOrders)) ? Number(value.retainedOrders) : undefined,
      incrementalOrders: Number.isFinite(Number(value.incrementalOrders)) ? Number(value.incrementalOrders) : undefined,
      platformContribution: Number.isFinite(Number(value.platformContribution)) ? Number(value.platformContribution) : undefined,
      merchantContribution: Number.isFinite(Number(value.merchantContribution)) ? Number(value.merchantContribution) : undefined
    };
  }

  function compactFeishuStrategy(strategy = {}, stations = []) {
    const textOrUndefined = (value, max = 120) => {
      const valueText = String(value ?? "").trim();
      return valueText ? valueText.slice(0, max) : undefined;
    };
    const numberOrUndefined = (value) => {
      const number = Number(value);
      return Number.isFinite(number) ? number : undefined;
    };
    const recommendedBasis = strategy.recommendedBasis && typeof strategy.recommendedBasis === "object"
      ? {
          roi: numberOrUndefined(strategy.recommendedBasis.roi),
          scenarioRoi: numberOrUndefined(strategy.recommendedBasis.scenarioRoi),
          rule: textOrUndefined(strategy.recommendedBasis.rule, 160)
        }
      : undefined;
    return {
      before: compactFeishuMetricSnapshot(strategy.before),
      after: compactFeishuMetricSnapshot(strategy.after),
      impact: compactFeishuImpact(strategy.impact),
      discountAmount: numberOrUndefined(strategy.discountAmount),
      platformCoupon: numberOrUndefined(strategy.platformCoupon),
      recommendedDiscount: numberOrUndefined(strategy.recommendedDiscount),
      recommendedPlatformCoupon: numberOrUndefined(strategy.recommendedPlatformCoupon),
      recommendedBasis,
      targetUser: textOrUndefined(strategy.targetUser, 100),
      targetSegment: textOrUndefined(strategy.targetSegment, 80),
      recommendation: textOrUndefined(strategy.recommendation, 160),
      capacityBound: strategy.capacityBound === true,
      unservedPressure: numberOrUndefined(strategy.unservedPressure),
      sourceStation: compactFeishuStation(strategy.sourceStation),
      targetStation: compactFeishuStation(strategy.targetStation),
      stations
    };
  }

  async function pollFeishuSync(syncId, pollVersion) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1800));
      if (pollVersion !== state.feishuPollVersion) return;
      try {
        const result = await getJson(`/api/feishu/sync/${encodeURIComponent(syncId)}`, 12000);
        state.feishuSync = result;
        renderFeishuSyncStatus(result);
        if (result.status === "completed" || result.status === "error") {
          showToast(result.status === "completed" ? "飞书 AI 策略已返回" : "飞书同步失败，请查看状态提示", 3200);
          return;
        }
      } catch {
        state.feishuSync = { mode: "error", status: "error", message: "暂时无法读取飞书 AI 结果" };
        renderFeishuSyncStatus(state.feishuSync);
        return;
      }
    }
    if (pollVersion === state.feishuPollVersion && state.feishuSync?.status === "processing") {
      renderFeishuSyncStatus({ ...state.feishuSync, message: "AI 仍在处理，可稍后再次点击同步" });
    }
  }

  async function syncFeishuOperatorSnapshot() {
    const button = byId("feishuSyncButton");
    if (!state.stations.length) {
      state.feishuSync = { status: "error", mode: "error", message: "请先完成一次出行规划" };
      renderFeishuSyncStatus(state.feishuSync);
      return;
    }
    const strategy = state.pendingOperatorPayload || {
      before: state.operatorBefore,
      after: state.operatorAfter,
      impact: { roi: Number(state.operatorAfter?.roi || 0) },
      discountAmount: Number(state.operatorAfter?.discount || state.operatorBefore?.discount || 0),
      targetStation: null,
      targetUser: "当前运营场景",
      stations: state.stations
    };
    // Do not send route geometry, POI metadata or long forecast arrays to
    // Feishu. The Bitable adapter only needs the operational fields below;
    // keeping this boundary compact also prevents the AI field from receiving
    // a request that exceeds its context limit.
    const feishuStations = state.stations.map(compactFeishuStation).filter(Boolean);
    const feishuStrategy = compactFeishuStrategy(strategy, feishuStations);
    const runId = `operator-${stableHash(JSON.stringify({
      destination: state.destinationName,
      energyType: state.energyType,
      selectedRoute: state.selectedRoute,
      stations: state.stations.map((station) => [station.id, station.occupancy, station.wait, station.p90]),
      strategy: [strategy.discountAmount, strategy.targetStation?.id, strategy.targetUser]
    }))}`;
    state.feishuPollVersion += 1;
    const pollVersion = state.feishuPollVersion;
    if (button) button.disabled = true;
    state.feishuSync = { status: "syncing", mode: "feishu-bitable", stationCount: state.stations.length };
    renderFeishuSyncStatus(state.feishuSync);
    try {
      const result = await postJson("/api/feishu/sync", {
        runId,
        stations: feishuStations,
        strategy: feishuStrategy,
        source: "FlowTwin 演示仿真",
        dataAsOf: new Date().toISOString()
      }, 30000);
      state.feishuSync = result;
      renderFeishuSyncStatus(result);
      if (result.status === "not-configured") {
        showToast("飞书未配置，当前保留本地演示", 3200);
        return;
      }
      if (result.syncId) {
        showToast("运营快照已同步，正在等待飞书 AI", 2600);
        await pollFeishuSync(result.syncId, pollVersion);
      }
    } catch (error) {
      state.feishuSync = { status: "error", mode: "error", message: error.message || "飞书同步失败" };
      renderFeishuSyncStatus(state.feishuSync);
      showToast("飞书同步失败，未影响本地运营结果", 3600);
    } finally {
      if (button && state.feishuSync?.status !== "processing") button.disabled = false;
    }
  }

  function renderStationSummary() {
    if (!state.stations.length) return;
    ensureOperatorDemoMetadata();
    state.operatorOriginalStations = state.stations.map((station) => Object.assign({}, station));
    state.operatorBefore = computeOperatorSnapshot(state.stations);
    state.operatorAfter = null;
    state.executionState = "before";
    state.paymentState = "authorized";
    state.paymentReceipt = null;
    resetFeishuSync();
    resetOperatorAnalysisSteps();
    closePaymentReceipt();
    syncOperatorPanelTitle();
    renderOperatorMetrics(state.operatorBefore, false);
    resetValidationView();
    loadWeather();
  }

  function calculateEnergyPlan(record, key, isFuel) {
    const direct = directEnergyState(record, isFuel);
    const { profile, currentEnergy, targetEnergy, consumption } = direct;
    const clampSoc = (energy) => Math.max(0, Math.min(100, energy / profile.capacity * 100));
    if (direct.canDirect) {
      return {
        amount: 0,
        unit: profile.unit,
        chargeMinutes: 0,
        arrivalSoc: clampSoc(direct.remainingEnergy),
        targetMet: true,
        canDirect: true,
        requiresStop: false,
        canReachStation: true,
        detourWithinLimit: true,
        firstLegKm: 0,
        reason: "direct"
      };
    }

    const station = record?.station;
    if (!station?.location) {
      return {
        amount: 0,
        unit: profile.unit,
        chargeMinutes: 0,
        arrivalSoc: clampSoc(direct.remainingEnergy),
        targetMet: false,
        canDirect: false,
        requiresStop: true,
        canReachStation: false,
        detourWithinLimit: true,
        firstLegKm: null,
        reason: "no-station"
      };
    }

    const firstLegKm = distanceAlongPathToWaypoint(record.path, station.location);
    if (!Number.isFinite(firstLegKm)) {
      return {
        amount: 0,
        unit: profile.unit,
        chargeMinutes: 0,
        arrivalSoc: clampSoc(direct.remainingEnergy),
        targetMet: false,
        canDirect: false,
        requiresStop: true,
        canReachStation: false,
        detourWithinLimit: Number(record.detour || 0) <= state.maxDetourKm,
        firstLegKm: null,
        reason: "station-not-on-route"
      };
    }

    const safetyReserveEnergy = profile.capacity * profile.safetyReservePercent / 100;
    const firstLegConsumption = firstLegKm * profile.consumptionPerKm;
    const energyAtStation = currentEnergy - firstLegConsumption;
    const canReachStation = energyAtStation >= safetyReserveEnergy - 1e-6;
    const detourWithinLimit = Math.max(0, Number(record.detour) || 0) <= state.maxDetourKm + 1e-6;
    const requested = Math.max(0, (targetEnergy + consumption - currentEnergy) / profile.transferEfficiency);
    const stationFreeCapacity = Math.max(0, profile.capacity - Math.max(0, energyAtStation));
    const maxPurchasable = stationFreeCapacity / profile.transferEfficiency;
    const amount = canReachStation ? Math.min(requested, maxPurchasable) : 0;
    const remainingEnergy = energyAtStation + amount * profile.transferEfficiency - (consumption - firstLegConsumption);
    const targetMet = remainingEnergy >= targetEnergy - 1e-6;
    // Charging/refuelling time is a property of the selected station and
    // vehicle branch, not a knob for making objective cards look different.
    const chargeMinutes = amount ? energyFillMinutes(amount, station, isFuel) : 0;
    return {
      amount,
      unit: profile.unit,
      chargeMinutes,
      arrivalSoc: clampSoc(remainingEnergy),
      targetMet,
      canDirect: false,
      requiresStop: true,
      canReachStation,
      detourWithinLimit,
      firstLegKm,
      arrivalAtStationSoc: clampSoc(energyAtStation),
      maxSafeFirstLegKm: direct.maxSafeFirstLegKm,
      reason: !canReachStation ? "station-unreachable" : !detourWithinLimit ? "detour-limit" : !targetMet ? "target-unreachable" : "charge"
    };
  }

  function selectStation(station, showPanel) {
    if (!station) return;
    // Route cards keep their own stop objects. Prefer the canonical station in
    // state.stations so the forecast evidence returned by /api/forecast is not
    // lost when a card was built from an earlier station snapshot.
    station = state.stations.find((candidate) => String(candidate.id) === String(station.id)) || station;
    state.selectedStation = station;
    const forecastCard = byId("forecastChart")?.closest(".forecast-card");
    if (forecastCard) forecastCard.style.display = "";
    highlightSelectedStation();
    const title = byId("stationTitle");
    const wait = byId("waitValue");
    const subtitle = byId("stationSubtitle");
    const badge = byId("stationState");
    const adviceLabel = byId("energyAdviceLabel");
    const adviceValue = byId("energyAdviceValue");
    if (title) title.textContent = station.name;
    if (wait) wait.innerHTML = `${station.p90} <small>分钟</small>`;
    if (subtitle) subtitle.innerHTML = `额外里程 ${station.detour} km · ${station.type === "加油站" ? "油品服务" : "直流快充"}<span class="source-badge"> · ${station.source} · 演示预测状态</span>`;
    if (badge) {
      badge.innerHTML = `<i data-lucide="${station.status === "forecast-risk" ? "triangle-alert" : "check-circle-2"}"></i>${station.riskLabel}`;
      badge.classList.toggle("risk", station.status === "forecast-risk");
    }
    if (adviceLabel) adviceLabel.textContent = isFuelActive() ? "建议加油" : "建议补能";
    const stationRecord = Object.values(state.routeRecords).find((record) => record.station?.id === station.id);
    if (adviceValue) adviceValue.innerHTML = stationRecord
      ? `${stationRecord.energyAmount} <small>${stationRecord.energyUnit}</small>`
      : isFuelActive() ? "— <small>L</small>" : "— <small>kWh</small>";
    const priceValue = byId("stationPriceValue");
    if (priceValue) priceValue.innerHTML = Number.isFinite(Number(station.price))
      ? `¥${Number(station.price).toFixed(2)} <small>/${station.priceUnit || (isFuelActive() ? "L" : "kWh")}</small>`
       : "— <small>待确认</small>";
    renderReservationAction(station);
    const forecastEvidencePanel = byId("forecastEvidencePanel");
    const forecastEvidenceToggle = byId("forecastEvidenceToggle");
    if (forecastEvidencePanel) forecastEvidencePanel.hidden = true;
    if (forecastEvidenceToggle) {
      forecastEvidenceToggle.setAttribute("aria-expanded", "false");
      const label = forecastEvidenceToggle.querySelector("span");
      if (label) label.textContent = "查看计算依据";
    }
    requestForecast(station);
    refreshIcons();
    if (showPanel !== false) {
      const panel = byId("insightPanel");
      panel.classList.remove("hidden");
      if (window.innerWidth <= 760) {
        state.mobileInsightOpen = true;
        panel.classList.add("mobile-visible");
        byId("routeSheet").style.display = "none";
      }
    }
  }

  function highlightSelectedStation() {
    if (!state.stationMarkerById.size) return;
    state.stationMarkerById.forEach((marker, stationId) => {
      const station = state.stations.find((candidate) => candidate.id === stationId);
      if (!station || !marker.setContent) return;
      marker.setContent(markerContent(station.name, station.status === "forecast-risk", station.type, state.selectedStation && state.selectedStation.id === stationId, station.operatorRole));
    });
    refreshIcons();
  }

  function selectRoute(key) {
    if (state.simulation?.active) return;
    if (!state.routeRecords[key]) return;
    const group = state.routeDisplayGroups.find((candidate) => candidate.keys.includes(key));
    state.selectedRoute = group?.representative || key;
    state.routeSelectionTouched = true;
    $$(".route-option").forEach((button) => button.classList.toggle("selected", button.dataset.route === state.selectedRoute));
    if (state.live) {
      drawAmapRoutes();
    } else {
      renderFallbackRouteVisuals();
    }
    renderRouteCards();
    if (state.live) fitAmapView();
  }

  function setMode(mode) {
    if (state.simulation?.active && mode !== "driver") stopSimulationDriving();
    state.mode = mode;
    const composerDock = byId("aiComposerDock");
    const isDriverMode = mode === "driver";
    if (composerDock) {
      // Hide the driver-only input at the mode boundary. Moving it behind
      // another panel is not enough because the floating dock remains visible.
      if (!isDriverMode && composerDock.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      composerDock.hidden = !isDriverMode;
      composerDock.setAttribute("aria-hidden", String(!isDriverMode));
    }
    $$("[data-mode]").forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    byId("tripPanel").style.display = mode === "driver" ? "" : "none";
    const hideMobileInsight = window.innerWidth <= 760 && !state.mobileInsightOpen;
    byId("insightPanel").classList.toggle("hidden", mode !== "driver" || hideMobileInsight);
    byId("operatorPanel").classList.toggle("visible", mode === "operator");
    byId("validationPanel").classList.toggle("visible", mode === "validation");
    byId("visionPanel")?.classList.toggle("visible", mode === "vision");
    byId("routeSheet").style.display = mode === "driver" && !state.mobileInsightOpen ? "" : "none";
    if (mode === "driver") byId("mapAttribution").textContent = state.live ? "高德地图 · 真实路线与 POI / 演示预测状态" : "固定场景地图 · POI 示意 / 演示预测状态";
    if (mode === "operator") {
      byId("mapAttribution").textContent = "高德地图 · 真实站点 / 演示负载";
      syncOperatorPanelTitle();
      renderOperatorFlow(state.pendingOperatorPayload);
      if (state.map && state.stations.length) state.map.setFitView(state.stationOverlays, false, [90, 380, 220, 330], 11);
    }
    if (mode === "validation") byId("mapAttribution").textContent = "高德地图 · 固定种子验证场景";
    if (mode === "validation" && !state.validationLoaded) loadValidation();
    if (mode === "vision") {
      byId("mapAttribution").textContent = "站内视觉演示 · 内置样例/上传媒体 · 本地 OCR";
      void refreshVisionHealth();
    }
  }

  function planningCompletionMessage() {
    const records = Object.values(state.routeRecords || {});
    const directCount = records.filter((record) => record.directTrip).length;
    const feasibleCount = records.filter((record) => record.feasible).length;
    if (directCount === records.length && records.length) return "当前余量可直达目的地，已取消不必要的补能停靠。";
    if (!feasibleCount && state.multiStopPlanningMeta?.failure) return `未生成虚假的可行路线：${state.multiStopPlanningMeta.failure}`;
    if (!feasibleCount) return "未生成虚假的可行路线：当前余量无法安全抵达符合绕行约束的补能站。";
    if (state.energyPercent <= 12) return `已进入低电量救援模式：先锁定最近的安全可达站，再比较 ${feasibleCount} 条后续路线。`;
    const caveat = state.multiStopPlanningMeta?.searchCaveat ? "候选搜索有界，结果仍需按展示口径理解" : "";
    return `已生成 ${feasibleCount} 条通过首段可达性、${state.arrivalReserveEnabled ? "到达余量" : "车辆安全下限"}和绕行约束校验的方案。${caveat ? ` ${caveat}。` : ""}`;
  }

  function clearPlanForUnresolvedDestination() {
    state.hasPlannedRoute = false;
    state.routeRecords = {};
    state.routeCandidates = {};
    state.baseRouteRecords = {};
    state.multiStopRouteRecords = null;
    state.multiStopPlanningMeta = null;
    state.serviceSuggestion = null;
    state.activeServicePlan = null;
    state.serviceRouteOverrides = {};
    state.reservationOverrides = {};
    state.tripWaypoints = [];
    state.parseAnalysis = null;
    state.stationForecastScenarioKey = null;
    state.stationForecastRequestVersion += 1;
    state.stations = [];
    state.selectedStation = null;
    if (state.live) {
      clearLiveOverlays();
      addAmapEndpoints();
      if (state.map?.setCenter) state.map.setCenter(state.origin);
    } else {
      renderFallbackRouteVisuals();
    }
    setPlanningVisibility(false);
  }

  // 用户点名了出发地却定位不到时的出口。和目的地定位失败同样处理：
  // 报错，而不是退回默认起点后画出一条"起点不对"的真实折线。
  function showUnresolvedOrigin(origin) {
    clearPlanForUnresolvedDestination();
    const message = `未能定位出发地“${origin}”。系统没有改用默认起点${DEFAULT_ORIGIN_NAME}替代，请检查名称后重试。`;
    setAiStatus("出发地未定位", "unresolved");
    setAiReply(message);
    setText("aiReplyMeta", "未生成路线");
    showToast(message, 4600);
  }

  function showUnresolvedDestination(destination, resolution = null) {
    clearPlanForUnresolvedDestination();
    const aiChecked = resolution === "ai-fallback" || resolution === "unresolved";
    const message = destination
      ? aiChecked
        ? `未找到地点“${destination}”。规则未直接识别，AI 复核后也没有得到可确认的驾车地点，请换一个更具体的名称。`
        : `未能定位“${destination}”，或该地点暂不支持驾车路线。系统没有使用默认机场替代，请检查名称后重试。`
      : aiChecked
        ? "未找到地点。规则解析和 AI 复核都没有得到可确认的驾车目的地，请补充一个具体地点后再试。"
        : "没有识别到目的地，因此没有使用默认机场代替。请补充一个可驾车到达的目的地后再试。";
    setAiStatus("目的地未定位", "unresolved");
    setAiReply(message);
    setText("aiReplyMeta", "未生成路线");
    showToast(message, 4600);
  }

  function buildIntentSignature(value, options = {}) {
    return JSON.stringify({
      value: String(value || "").trim(),
      explicitDestination: options.explicitDestination || null,
      destinationLocation: options.destinationLocation || null,
      energyType: state.energyType,
      energyPercent: state.energyPercent,
      departure: state.departureMinutes,
      deadline: state.deadlineEnabled ? state.deadlineMinutes : null,
      reserve: state.arrivalReserveEnabled ? state.minArrivalSoc : null,
      destination: state.hasPlannedRoute ? state.destinationName : null,
      waypointCount: state.tripWaypoints.length,
      serviceCount: state.aiContext?.services?.length || 0
    });
  }

  async function parseIntent(options = {}) {
    const input = byId("intentInput");
    const typedValue = input ? input.value.trim() : "";
    const value = typedValue || DEFAULT_DEMO_INTENT;
    if (state.aiActive) return;
    if (input && !typedValue) input.value = value;
    readManualControls();
    const signature = buildIntentSignature(value, options);
    if (!options.force && state.hasPlannedRoute && signature === state.lastIntentSignature) {
      showToast("出行要求没有变化，已保留当前规划", 2200);
      return;
    }
    clearDestinationCandidates();
    state.hybridFailedBranches = new Set();
    state.aiActive = true;
    renderParseAnalysis(null);
    setComposerSubmitting(true);
    setAiStatus("AI 正在理解", "loading");
    setAiReply("正在把你的自然语言要求拆解为路线约束……");
    try {
      const payload = await postJson("/api/plan", {
        message: value,
        // The text box is authoritative for destination. Do not feed the demo
        // airport back as context, otherwise an uncertain parse can silently
        // fall back to Beijing Daxing International Airport.
        context: {
          origin: "能链北京总部",
          arrivalDeadline: state.deadlineEnabled ? formatClock(state.deadlineMinutes) : null,
          minArrivalSoc: state.arrivalReserveEnabled ? state.minArrivalSoc : null,
          energyType: state.energyType,
          priority: state.priority,
          maxDetourKm: state.maxDetourKm,
          services: state.aiContext?.services || [],
          hasPlannedRoute: state.hasPlannedRoute,
          currentOrigin: state.hasPlannedRoute ? state.originName : null,
          currentDestination: state.hasPlannedRoute ? state.destinationName : null,
          currentServices: state.hasPlannedRoute ? (state.aiContext?.services || []) : [],
          explicitDestination: options.explicitDestination || null,
          destinationLocation: options.destinationLocation || null
        }
      }, 60000);
      setAiStatus("正在确认目的地与意图", "loading");
      setAiReply("已收到出行要求，正在确认目的地、补充停靠与路线偏好……");
      const parsed = payload.parsed || payload.intent || payload.plan || localIntentFallback(value);
      renderParseAnalysis(payload.analysis || payload.parsed?.analysis || payload.intent?.analysis || payload.plan?.analysis);
      if (options.explicitDestination) parsed.destination = options.explicitDestination;
      if (options.destinationLocation) {
        payload.destinationLocation = options.destinationLocation;
        parsed.destinationLocation = options.destinationLocation;
      }
      const requestMode = resolveRequestMode(value, parsed);
      state.lastRequestMode = requestMode;
      const parsedForApply = requestMode === "supplement" && state.hasPlannedRoute
        ? mergeSupplementIntent(parsed, payload, value)
        : parsed;
      const actions = Array.isArray(parsedForApply.actions) && parsedForApply.actions.length
        ? parsedForApply.actions
        : inferLocalActions(value, parsedForApply);
      parsedForApply.actions = actions;
      const payloadForApply = requestMode === "supplement" && state.hasPlannedRoute
        ? Object.assign({}, payload, {
            destinationLocation: parsedForApply.destinationLocation,
            originLocation: parsedForApply.originLocation
          })
        : payload;
      const candidates = payload.destinationCandidates || parsed.destinationCandidates || [];
      // Always pause for a short pick list when the backend flags ambiguity or
      // when several named candidates exist without an exact committed location.
      const needsPick = requestMode !== "supplement" && (
        payload.destinationNeedsPick === true
        || ((!payload.destinationLocation && !options.destinationLocation) && Array.isArray(candidates) && candidates.length >= 2)
      );
      if (needsPick && Array.isArray(candidates) && candidates.length >= 2) {
        setPlanningVisibility(false);
        setAiStatus("请选择目的地", "unresolved");
        setAiReply(`“${parsed.destination || "该地点"}”找到 ${candidates.length} 个可能目的地，请点选一个继续规划。`);
        setText("aiReplyMeta", "目的地待确认");
        showDestinationCandidates(candidates);
        showToast("请先选择一个目的地", 3200);
        return;
      }
      if (requestMode === "new_trip" || actions.some((action) => action.type === "NEW_TRIP" || action.type === "CHANGE_DESTINATION")) {
        // Keep the current plan intact while an ambiguous destination is
        // waiting for the user's pick.  Once the destination is resolved,
        // clear only the previous trip's stops and hard constraints.
        clearSupplementalStopsForNewTrip();
      }
      const applied = applyParsedIntent(parsedForApply, payloadForApply);
      if (!applied.ok) {
        if (applied.originUnresolved) {
          showUnresolvedOrigin(applied.origin);
          return;
        }
        if (Array.isArray(candidates) && candidates.length >= 2) {
          setAiStatus("请选择目的地", "unresolved");
          setAiReply(payload.assistantReply || `“${applied.destination || "该地点"}”有多个匹配结果，请选择一个继续。`);
          setText("aiReplyMeta", "目的地待确认");
          showDestinationCandidates(candidates);
          showToast("请先选择一个目的地候选", 3200);
          return;
        }
        showUnresolvedDestination(applied.destination, payload.destinationResolution);
        return;
      }
      clearDestinationCandidates();
      const preRouteOutcome = await applyPreRouteActions(actions);
      if (requestMode === "new_trip") previewDestinationComputation();
      setAiStatus("正在请求路线与沿线补能站", "loading");
      setAiReply(payload.assistantReply || parsedForApply.assistantReply || "已识别出行约束，正在请求真实路线与沿线补能站……");
      await recomputePlan({ manageButton: false, silent: true });
      setPlanningVisibility(true);
      setAiStatus("正在校验多目标方案", "loading");
      const postRouteOutcome = await applyPostRouteActions(actions);
      const failedActions = preRouteOutcome.failed.concat(postRouteOutcome.failed);
      const actionText = actions.length
        ? `${actionModeLabel(actions, requestMode)}：${actions.filter((action) => !failedActions.includes(action)).map(actionSummary).join("、") || "未完成"}${failedActions.length ? `；${failedActions.map(actionSummary).join("、")}未完成` : ""}`
        : requestMode === "supplement" ? "已保留当前行程并重新计算" : "";
      recordActionJournal(actions, { failed: failedActions, summary: actionText });
      const aiPlanStatus = resolvePlanAiStatus(payload);
      setAiStatus(aiPlanStatus.label, aiPlanStatus.state);
      setAiReply([actionText, planningCompletionMessage()].filter(Boolean).join("。"));
      setText("aiReplyMeta", aiPlanStatus.meta);
      showToast(aiPlanStatus.label || actionText || planningCompletionMessage());
      state.lastIntentSignature = signature;
    } catch (error) {
      const parsed = localIntentFallback(value);
      if (options.explicitDestination) parsed.destination = options.explicitDestination;
      if (options.destinationLocation) parsed.destinationLocation = options.destinationLocation;
      const requestMode = resolveRequestMode(value, parsed);
      state.lastRequestMode = requestMode;
      const parsedForApply = requestMode === "supplement" && state.hasPlannedRoute
        ? mergeSupplementIntent(parsed, {}, value)
        : parsed;
      const actions = inferLocalActions(value, parsedForApply);
      parsedForApply.actions = actions;
      if (requestMode === "new_trip" || actions.some((action) => action.type === "NEW_TRIP" || action.type === "CHANGE_DESTINATION")) {
        clearSupplementalStopsForNewTrip();
      }
      const payloadForApply = options.destinationLocation
        ? { destinationLocation: options.destinationLocation }
        : { destinationLocation: parsedForApply.destinationLocation, originLocation: parsedForApply.originLocation };
      const applied = applyParsedIntent(parsedForApply, payloadForApply);
      if (!applied.ok) {
        if (applied.originUnresolved) showUnresolvedOrigin(applied.origin);
        else showUnresolvedDestination(applied.destination);
        return;
      }
      const preRouteOutcome = await applyPreRouteActions(actions);
      if (requestMode === "new_trip") previewDestinationComputation();
      setAiStatus("规则解析完成", "rules");
      setAiReply("模型连接暂时不可用，已按本地规则保留核心规划能力。");
      setAiStatus("正在请求路线与沿线补能站", "loading");
      await recomputePlan({ manageButton: false, silent: true });
      setPlanningVisibility(true);
      setAiStatus("正在校验多目标方案", "loading");
      const postRouteOutcome = await applyPostRouteActions(actions);
      const failedActions = preRouteOutcome.failed.concat(postRouteOutcome.failed);
      const actionText = actions.length
        ? `${actionModeLabel(actions, requestMode)}：${actions.filter((action) => !failedActions.includes(action)).map(actionSummary).join("、") || "未完成"}${failedActions.length ? `；${failedActions.map(actionSummary).join("、")}未完成` : ""}`
        : requestMode === "supplement" ? "已保留当前行程并重新计算" : "";
      recordActionJournal(actions, { failed: failedActions, summary: actionText });
      setAiStatus("规则解析完成", "rules");
      setAiReply([actionText, planningCompletionMessage()].filter(Boolean).join("。"));
      setText("aiReplyMeta", "规则校验已完成");
      showToast("模型连接失败，已切换本地规则", 3600);
      state.lastIntentSignature = signature;
    } finally {
      state.aiActive = false;
      setComposerSubmitting(false);
    }
  }

  function computeOperatorSnapshot(stations) {
    ensureOperatorDemoMetadata();
    const relevant = stations.filter((station) => station.type === (isFuelActive() ? "加油站" : "充电站"));
    const pool = relevant.length ? relevant : stations;
    const average = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const averageWait = average(pool.map((station) => station.wait));
    const averageOccupancy = average(pool.map((station) => station.occupancy));
    const dispersion = Math.sqrt(average(pool.map((station) => Math.pow(station.occupancy - averageOccupancy, 2))));
    const p90 = pool.length ? Math.max.apply(null, pool.map((station) => Number(station.p90) || 0)) : 0;
    const riskCount = pool.filter((station) => station.status === "forecast-risk").length;
    const routeOnTime = Object.values(state.routeRecords).filter((record) => Number.isFinite(record.onTime));
    return {
      averageWait,
      p90,
      dispersion,
      riskCount,
      peakQueue: Math.max(0, Math.round(pool.reduce((sum, station) => sum + Math.max(0, station.occupancy - 0.48) * 9, 0))),
      // 未运行平台仿真前，不把演示占用率推导成“当前优惠/ROI”。
      discount: null,
      roi: null,
      scenarioRoi: null,
      strategyAvailable: false,
      onTime: routeOnTime.length ? average(routeOnTime.map((record) => record.onTime)) : 89
    };
  }

  function operatorStations() {
    ensureOperatorDemoMetadata();
    const type = isFuelActive() ? "加油站" : "充电站";
    const matching = state.stations.filter((station) => station.type === type);
    return matching.length ? matching : state.stations;
  }

  function operatorExecutableStations(stations = operatorStations()) {
    return stations.filter((station) => {
      const meta = station.operatorMeta || {};
      return meta.partner === true && meta.controllable === true && meta.couponEligible === true && meta.merchantAccepted === true;
    });
  }

  function populateOperatorTargetSelect(preferredId) {
    const select = byId("targetStationSelect");
    if (!select) return;
    const stations = operatorStations();
    const executable = operatorExecutableStations(stations);
    const source = stations.slice().sort((a, b) => b.p90 - a.p90 || b.occupancy - a.occupancy)[0];
    const oldValue = preferredId || select.value;
    const candidates = executable.filter((station) => station.id !== source?.id).slice().sort((a, b) => (a.p90 + a.occupancy * 18) - (b.p90 + b.occupancy * 18));
    select.innerHTML = candidates.length
      ? candidates.map((station) => `<option value="${escapeHtml(station.id)}">${escapeHtml(station.name)} · 负载 ${(station.occupancy * 100).toFixed(0)}% · 平台可调控</option>`).join("")
      : '<option value="">暂无满足平台控制边界的承接站</option>';
    select.disabled = !candidates.length;
    if (candidates.some((station) => station.id === oldValue)) select.value = oldValue;
  }

  function renderOperatorFlow(payload) {
    const pool = operatorStations();
    if (!pool.length) return;
    const executable = operatorExecutableStations(pool);
    const beforePool = (state.operatorOriginalStations.length ? state.operatorOriginalStations : state.stations)
      .filter((station) => station.type === (isFuelActive() ? "加油站" : "充电站"));
    let source = beforePool.slice().sort((a, b) => b.p90 - a.p90 || b.occupancy - a.occupancy)[0] || pool[0];
    const targetId = payload?.execution?.targetStationId || payload?.targetStation?.id || byId("targetStationSelect")?.value;
    const target = executable.find((station) => station.id === targetId) || null;
    const after = new Map((payload?.stations || []).map((station) => [station.id, station]));
    if (payload?.stations?.length) {
      const actualSource = payload.stations
        .filter((station) => beforePool.some((candidate) => candidate.id === station.id))
        .slice()
        .sort((a, b) => Number(a.changedDemand || 0) - Number(b.changedDemand || 0))[0];
      const matchedSource = beforePool.find((station) => station.id === actualSource?.id);
      if (matchedSource && Number(actualSource?.changedDemand || 0) < 0) source = matchedSource;
    }
    const sourceAfter = after.get(source?.id);
    const targetAfter = after.get(target?.id);
    state.stations = state.stations.map((station) => Object.assign({}, station, {
      operatorRole: station.id === source?.id ? "source" : station.id === target?.id ? "target" : null
    }));
    setText("operatorSourceName", source?.name || "高峰站点");
    setText("operatorTargetName", target?.name || "暂无平台可执行承接站");
    const stationMetrics = (before, afterEntry) => afterEntry
      ? `负载 ${(before.occupancy * 100).toFixed(0)}% → ${(afterEntry.occupancy * 100).toFixed(0)}% · 平均排队 ${Math.round(before.wait)} → ${Math.round(afterEntry.wait)} 分钟`
      : before
        ? `负载 ${(before.occupancy * 100).toFixed(0)}% · 预计排队 ${before.p90} 分钟`
        : "暂无站点数据";
    setText("operatorSourceMetrics", stationMetrics(source, sourceAfter));
    setText("operatorTargetMetrics", target ? stationMetrics(target, targetAfter) : "全网 POI 可见 · 未纳入运营执行");
    const flowLabel = !payload
      ? "等待平台边界校验"
      : !payload.execution?.executable
        ? "仅导航 · 未生成策略"
        : payload.insufficientData
          ? "数据不足 · 未生成策略"
          : `平台券 ¥${Number(payload.platformCoupon ?? payload.discountAmount ?? 0).toFixed(0)} · 仿真预计可引导 ${Math.round(payload.impact?.divertedVehicles || 0)} 人`;
    setText("operatorFlowLabel", flowLabel);
    const logic = !payload
      ? "全网站点用于观察与导航；仅对演示平台配置站点计算承接策略"
      : !payload.execution?.executable
        ? "当前没有同时满足合作、可调控、可发券、商家接受的承接站，仅保留导航"
        : payload.insufficientData
          ? "运营字段不完整，未输出优惠、仿真预计可引导或场景 ROI 结论"
          : `依据 ${payload.targetUser || "目标用户"}，在承接容量、平台券成本与场景 ROI 约束下计算`;
    setText("operatorLogicHint", logic);
    if (state.live && state.mode === "operator") renderLiveStationMarkers();
  }

  function renderOperatorMetrics(snapshot, executed) {
    if (!snapshot) return;
    const queue = byId("operatorQueue");
    const discount = byId("operatorDiscount");
    const roi = byId("operatorRoi");
    const queueNote = byId("operatorQueueNote");
    const roiNote = byId("operatorRoiNote");
    const action = byId("operatorAction");
    if (queue) queue.innerHTML = `${snapshot.peakQueue}<span style="font-size:13px;font-family:var(--sans);font-weight:500"> 人</span>`;
    const strategyAvailable = snapshot.strategyAvailable === true;
    if (discount) discount.innerHTML = strategyAvailable && Number.isFinite(Number(snapshot.discount))
      ? `¥${Number(snapshot.discount).toFixed(0)}<span style="font-size:13px;font-family:var(--sans);font-weight:500"> / 单</span>`
      : "—";
    const discountNote = byId("operatorDiscountNote");
    if (discountNote) {
      const recommended = snapshot.recommendedDiscount;
      if (!strategyAvailable) {
        discountNote.textContent = "尚未生成可执行的平台券策略";
      } else if (recommended === null) {
        discountNote.textContent = "没有满足场景 ROI 约束的券档";
      } else if (Math.abs(recommended - snapshot.discount) < 0.5) {
        discountNote.textContent = `与仿真建议一致（场景 ROI ${Number(snapshot.recommendedRoi || 0).toFixed(2)}x）`;
      } else {
        discountNote.textContent = `仿真建议 ¥${recommended}（场景 ROI ${Number(snapshot.recommendedRoi || 0).toFixed(2)}x）`;
      }
    }
    if (roi) {
      if (strategyAvailable && Number.isFinite(Number(snapshot.roi))) {
        roi.textContent = `${Number(snapshot.roi).toFixed(2)}x`;
        roi.style.color = Number(snapshot.roi) >= 1 ? "var(--teal)" : "var(--amber)";
      } else {
        roi.textContent = "—";
        roi.style.color = "";
      }
    }
    if (queueNote) {
      if (!executed) {
        queueNote.textContent = `${snapshot.riskCount} 个站点出现集中到达风险 · 尚未应用沙盘策略`;
      } else {
        const drop = (state.operatorBefore?.peakQueue ?? snapshot.peakQueue) - snapshot.peakQueue;
        queueNote.textContent = drop >= 0.5
          ? `沙盘应用后峰值减少 ${drop.toFixed(0)} 人`
          : drop <= -0.5
            ? `沙盘应用后峰值上升 ${Math.abs(drop).toFixed(0)} 人，需复核承接站容量`
            : "沙盘应用后峰值基本持平";
      }
    }
    if (roiNote) roiNote.textContent = strategyAvailable
      ? "场景仿真结果 · 待真实 A/B 实验验证"
      : "当前没有可执行策略，不生成场景 ROI 或优惠结论";
    if (action && executed && strategyAvailable) {
      const improved = snapshot.p90 <= state.operatorBefore.p90;
      const p90Message = snapshot.p90 < state.operatorBefore.p90
        ? `P90 从 ${state.operatorBefore.p90.toFixed(1)} 分钟降至 ${snapshot.p90.toFixed(1)} 分钟`
        : `P90 保持 ${snapshot.p90.toFixed(1)} 分钟`;
      action.innerHTML = improved
         ? `<strong>策略沙盘结果：</strong>高峰站点仿真预计可引导，${p90Message}。`
         : `<strong>沙盘复盘：</strong>P90 从 ${state.operatorBefore.p90.toFixed(1)} 分钟升至 ${snapshot.p90.toFixed(1)} 分钟，本沙盘建议应撤回并降低优惠强度。`;
    } else if (action) {
      action.innerHTML = strategyAvailable
         ? `<strong>沙盘建议：</strong>依据平台承接容量、人群响应和场景 ROI，比较平台券与推荐引导方案。`
        : `<strong>当前边界：</strong>全网站点可以导航和观察，但只有演示平台配置中可控且接受平台券的站点才能生成运营策略。`;
    }
    populateOperatorTargetSelect(snapshot?.targetStationId);
    renderOperatorFlow(state.pendingOperatorPayload);
  }

  function renderValidationMetrics(snapshot) {
    // Validation KPIs must come only from /api/validate. Operator simulation
    // uses another model and must not overwrite this reproducible experiment.
    return snapshot;
  }

  function resetValidationView() {
    state.validationLoaded = false;
    state.validationPayload = null;
    setText("validationAverage", "—");
    setText("validationP90", "—");
    setText("validationOnTime", "—");
    ["validationAverage", "validationP90", "validationOnTime"].forEach((id) => {
      byId(id)?.classList.remove("good", "bad");
    });
    setText("validationStatusText", "等待运行本次仿真");
    setText("validationStatusMeta", "进入验证流程后，以当前站点输入计算 1,000 次合成行程");
    setText("validationFootText", "尚未运行。结果将在固定种子下由当前站点输入生成。");
    setText("validationSourceBadge", "可复现实验 / 非企业真实经营结论");
    const body = byId("validationTableBody");
    if (body) body.innerHTML = '<tr id="validationEmptyRow"><td colspan="6">尚未运行仿真；点击“验证”后将以当前站点输入计算。</td></tr>';
    const progress = byId("validationProgress");
    if (progress) progress.style.width = "0%";
    const evidenceButton = byId("validationEvidenceButton");
    if (evidenceButton) evidenceButton.disabled = true;
    closeValidationEvidence();
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = displayCopy(value);
  }

  function renderOperatorSimulation(payload) {
    if (!payload?.before || !payload?.after || !payload?.impact) return;
    const before = payload.before;
    const after = payload.after;
    const impact = payload.impact;
    // 改善量常常小于显示精度：17.86 → 17.32 两边都印成 "17.9m/17.3m" 还看得出来，
    // 但 17.96 → 17.95 会变成两个一模一样的 "18.0m"，读起来像是策略毫无作用。
    // 把差值单独写出来，"没有变化"和"变化小到看不见"才分得开。
    const delta = (from, to, unit, digits) => {
      const diff = to - from;
      if (Math.abs(diff) < 0.05) return `${to.toFixed(digits)}${unit}（持平）`;
      return `${to.toFixed(digits)}${unit}（${diff < 0 ? "−" : "+"}${Math.abs(diff).toFixed(digits)}）`;
    };
    setText("beforeQueueValue", `${before.peakQueue.toFixed(1)} 人`);
    setText("afterQueueValue", delta(before.peakQueue, after.peakQueue, " 人", 1));
    setText("beforeP90Value", `${before.p90Wait.toFixed(1)}m`);
    setText("afterP90Value", delta(before.p90Wait, after.p90Wait, "m", 1));
    const strategyAvailable = payload.execution?.executable === true && payload.insufficientData !== true;
    setText("divertedUsersValue", `${strategyAvailable ? Math.round(impact.divertedVehicles || 0) : 0} 人`);
    setText("strategyRoiValue", strategyAvailable && Number.isFinite(Number(impact.scenarioRoi ?? impact.roi))
      ? `${Number(impact.scenarioRoi ?? impact.roi).toFixed(2)}x`
      : "—");
    const afterLabel = document.querySelector("#operatorAfterCompare > span");
    if (afterLabel) afterLabel.textContent = strategyAvailable ? "沙盘预测" : "未应用沙盘策略";
    const snapshot = {
      averageWait: after.averageWait,
      p90: after.p90Wait,
      dispersion: after.occupancyDispersion,
      peakQueue: Math.round(after.peakQueue),
      discount: strategyAvailable ? Number(payload.platformCoupon ?? payload.discountAmount) : null,
      roi: strategyAvailable ? Number(impact.scenarioRoi ?? impact.roi) : null,
      scenarioRoi: strategyAvailable ? Number(impact.scenarioRoi ?? impact.roi) : null,
      strategyAvailable,
      riskCount: payload.stations.filter((station) => station.status === "forecast-risk").length,
      onTime: state.operatorBefore?.onTime || 89,
      // 算法建议跟着快照走，不能在 renderOperatorMetrics 里读
      // state.pendingOperatorPayload——那个变量要到本函数返回之后才赋值，
      // 此刻拿到的是上一轮的结果。
      recommendedDiscount: payload.recommendedDiscount,
      recommendedRoi: Number(payload.recommendedBasis?.roi || 0)
    };
    renderOperatorMetrics(snapshot, false);
    const action = byId("operatorAction");
    if (action) {
      if (!strategyAvailable) {
        const reason = payload.insufficientData
          ? "平台经济字段不完整，无法给出场景 ROI。"
          : "当前没有同时满足合作、可调控、可发券、商家接受的承接站。";
        action.innerHTML = `<strong>未生成可执行沙盘建议：</strong>${reason} 全网站点仍保留导航和补能候选用途。`;
        action.classList.remove("strategy-risk", "strategy-unprofitable");
      } else {
        const risk = payload.recommendation === "risk";
        const unprofitable = payload.recommendation === "operationally-effective";
        const headline = unprofitable ? `<strong>场景有效但场景 ROI 未达标：</strong>` : `<strong>本次沙盘建议：</strong>`;
        const platformContribution = Number(payload.platformContribution ?? impact.platformContribution ?? 0);
        const merchantContribution = Number(payload.merchantContribution ?? impact.merchantContribution ?? 0);
        action.innerHTML = risk
          ? `<strong>策略风险：</strong>当前平台券会增加承接站尾部等待，建议降低券档或更换承接站。场景 ROI ${Number(impact.scenarioRoi ?? impact.roi).toFixed(2)}x。`
          : `${headline}向${payload.targetUser || "目标用户"}提供 ¥${payload.platformCoupon ?? payload.discountAmount} 平台券，仿真预计可引导 ${Math.round(impact.divertedVehicles || 0)} 人（挽回 ${impact.retainedOrders?.toFixed?.(1) ?? "—"} 单，新增 ${Math.round(impact.incrementalOrders || 0)} 单），场景 ROI ${Number(impact.scenarioRoi ?? impact.roi).toFixed(2)}x；仿真收益假设：平台贡献 ¥${platformContribution.toFixed(2)}，商户贡献 ¥${merchantContribution.toFixed(2)}。${payload.recommendedPlatformCoupon != null
            ? `仿真建议 ¥${payload.recommendedPlatformCoupon}（在场景 ROI ≥ 1 的券档中仿真预计可引导最多）。`
            : "当前负载与成本假设下没有满足场景 ROI 约束的券档，建议改用推荐引导或调度。"}${payload.capacityBound
              ? `<br><span class="strategy-note">承接站窗口容量已是瓶颈：仍有约 ${payload.unservedPressure} 人的需求压力无法承接，继续加码平台券不能解决。</span>`
              : ""}`;
        action.classList.toggle("strategy-risk", risk);
        action.classList.toggle("strategy-unprofitable", unprofitable);
      }
    }
    renderOperatorFlow(payload);
    return snapshot;
  }

  function buildOperatorStationPayload() {
    ensureOperatorDemoMetadata();
    return state.stations.map((station) => {
      const meta = station.operatorMeta || {};
      return {
        id: String(station.id || ""),
        name: String(station.name || "补能站"),
        type: station.type,
        address: station.address,
        location: station.location,
        // source 保留高德/固定 POI 来源；dataSource 单独表示运营仿真字段来源。
        source: station.source,
        price: Number(station.price || 0),
        p50: Number(station.p50 || station.wait || 0),
        p90: Number(station.p90 || station.wait || 0),
        wait: Number(station.wait || station.p50 || 0),
        occupancy: Number(station.occupancy || 0),
        capacity: Number(station.capacity || 0) || undefined,
        demand: Number(station.demand || 0) || undefined,
        serviceRate: Number(station.serviceRate || 0) || undefined,
        detour: Number(station.detourKm ?? station.detour ?? 0),
        partner: meta.partner === true,
        controllable: meta.controllable === true,
        couponEligible: meta.couponEligible === true,
        merchantAccepted: meta.merchantAccepted === true,
        windowCapacity: Number(meta.windowCapacity || 0),
        platformCoupon: Number(meta.platformCoupon ?? OPERATOR_DEMO_DEFAULTS.platformCoupon),
        merchantCouponShare: Number(meta.merchantCouponShare ?? OPERATOR_DEMO_DEFAULTS.merchantCouponShare),
        platformTakeRate: Number(meta.platformTakeRate ?? OPERATOR_DEMO_DEFAULTS.platformTakeRate),
        platformVariableCost: Number(meta.platformVariableCost ?? OPERATOR_DEMO_DEFAULTS.platformVariableCost),
        campaignBudget: Number(meta.campaignBudget ?? OPERATOR_DEMO_DEFAULTS.campaignBudget),
        dataSource: String(meta.dataSource || OPERATOR_DEMO_DEFAULTS.dataSource),
        asOf: String(meta.asOf || OPERATOR_DEMO_DEFAULTS.asOf),
        operatorDataLabel: String(meta.label || "演示平台配置（非企业真实字段）"),
        forecastMethod: station.forecastMethod || null,
        forecastSource: station.forecastSource || null,
        forecastDataAsOf: station.forecastDataAsOf || station.forecastAsOf || null,
        forecastFreshnessSeconds: Number.isFinite(Number(station.forecastFreshnessSeconds)) ? Number(station.forecastFreshnessSeconds) : null,
        forecastSimulation: station.forecastSimulation !== false,
        forecastInputSnapshot: station.forecastInputSnapshot || null,
        forecastArrivalWaitP50: Number.isFinite(Number(station.forecastArrivalWaitP50)) ? Number(station.forecastArrivalWaitP50) : Number(station.p50 || 0),
        forecastArrivalWaitP90: Number.isFinite(Number(station.forecastArrivalWaitP90)) ? Number(station.forecastArrivalWaitP90) : Number(station.p90 || 0)
      };
    });
  }

  async function simulateOperatorStrategy() {
    const button = byId("operatorSimulate");
    const discount = Number(byId("discountSlider")?.value || 0);
    const targetUser = byId("targetSegment")?.selectedOptions?.[0]?.textContent || "全部可触达用户";
    // 中文标签给人看，slug 给模型用。只传标签的话，"准时敏感 · 高峰出行"
    // 会被关键词匹配当成"价格敏感"，把最不肯绕路的人算成最肯绕路的人。
    const targetSegment = byId("targetSegment")?.value || "all";
    const targetStationId = byId("targetStationSelect")?.value || null;
    const stations = buildOperatorStationPayload();
    if (button) button.disabled = true;
    // 新一轮试算开始后先清掉旧结果；接口失败时不能继续沿用上一轮
    // 的策略快照，更不能让旧 ROI 看起来像本轮执行结果。
    state.pendingOperatorPayload = null;
    state.pendingOperatorSnapshot = null;
    state.operatorAfter = null;
    resetFeishuSync();
    setOperatorAnalysisStep("simulation", "processing", "计算中");
    try {
      const payload = await postJson("/api/operator/simulate", {
        stations,
        discountAmount: discount,
        platformCoupon: discount,
        merchantCouponShare: OPERATOR_DEMO_DEFAULTS.merchantCouponShare,
        platformTakeRate: OPERATOR_DEMO_DEFAULTS.platformTakeRate,
        platformVariableCost: OPERATOR_DEMO_DEFAULTS.platformVariableCost,
        campaignBudget: OPERATOR_DEMO_DEFAULTS.campaignBudget,
        dataSource: OPERATOR_DEMO_DEFAULTS.dataSource,
        asOf: OPERATOR_DEMO_DEFAULTS.asOf,
        targetUser,
        targetSegment,
        targetStationId
      }, 20000);
      const snapshot = renderOperatorSimulation(payload);
      state.pendingOperatorPayload = payload;
      state.pendingOperatorSnapshot = snapshot;
      renderOperatorFlow(payload);
      setOperatorAnalysisStep("simulation", "completed", "已计算");
      showToast(payload.execution?.executable && !payload.insufficientData
        ? "已根据平台边界、券成本与目标人群完成场景仿真"
        : "已完成站点边界校验，当前未生成可执行运营策略");
    } catch (error) {
      state.pendingOperatorPayload = null;
      state.pendingOperatorSnapshot = null;
      state.operatorAfter = null;
      renderOperatorMetrics(state.operatorBefore || computeOperatorSnapshot(state.stations), false);
      renderOperatorFlow(null);
      setOperatorAnalysisStep("simulation", "error", "计算失败");
      showToast("策略计算失败，请稍后重试", 3600);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function renderValidationPayload(payload) {
    const strategies = payload?.strategies || {};
    const order = ["nearest", "cheapest", "realtime", "flowtwin"];
    const labels = { nearest: "最近站", cheapest: "最低价", realtime: "仅实时状态", flowtwin: "FlowTwin" };
    const body = byId("validationTableBody");
    if (body) body.innerHTML = order.map((key) => {
      const row = strategies[key] || {};
      return `<tr class="${key === "flowtwin" ? "highlight" : ""}"><td>${labels[key]}</td><td>${Number(row.averageWait || 0).toFixed(1)} 分钟</td><td>${Number(row.p90Wait || 0).toFixed(1)} 分钟</td><td>${Number(row.averageStopMinutes || 0).toFixed(1)} 分钟</td><td>${Number(row.p90StopMinutes || 0).toFixed(1)} 分钟</td><td>${Number(row.onTimeRate || 0).toFixed(1)}%</td><td>${Number(row.loadDispersion || 0).toFixed(2)}</td><td>${key === "flowtwin" ? `${Number(row.roi || 0).toFixed(2)}x` : "—"}</td></tr>`;
    }).join("");
    const baseline = strategies.realtime || {};
    const flowtwin = strategies.flowtwin || {};
    const averageImprovement = baseline.averageWait ? (1 - flowtwin.averageWait / baseline.averageWait) * 100 : 0;
    const p90Improvement = baseline.p90Wait ? (1 - flowtwin.p90Wait / baseline.p90Wait) * 100 : 0;
    const onTimeImprovement = Number(flowtwin.onTimeRate || 0) - Number(baseline.onTimeRate || 0);
    const setKpi = (id, text, isGood) => {
      const element = byId(id);
      if (!element) return;
      element.textContent = text;
      element.classList.toggle("good", isGood);
      element.classList.toggle("bad", !isGood);
    };
    setKpi("validationAverage", `${averageImprovement >= 0 ? "−" : "+"}${Math.abs(averageImprovement).toFixed(1)}%`, averageImprovement >= 0);
    setKpi("validationP90", `${p90Improvement >= 0 ? "−" : "+"}${Math.abs(p90Improvement).toFixed(1)}%`, p90Improvement >= 0);
    setKpi("validationOnTime", `${onTimeImprovement >= 0 ? "+" : ""}${onTimeImprovement.toFixed(1)}pp`, onTimeImprovement >= 0);
    setText("validationStatusText", "本次仿真计算完成");
    const modeLabel = payload.inputMode === "current-stations" ? "当前站点输入" : "合成站点输入";
    setText("validationStatusMeta", `${payload.trips?.toLocaleString?.() || payload.trips} 次合成行程 · ${payload.stationCount || 0} 个节点 · 种子 ${payload.seed} · ${modeLabel}`);
    setText("validationFootText", `本次输入：${payload.stationCount || 0} 个${modeLabel} · ${payload.trips?.toLocaleString?.() || payload.trips} 次合成行程 · 固定随机种子 ${payload.seed}。${payload.assumptions || ""}`);
    setText("validationSourceBadge", "可复现实验 / 非企业真实经营结论");
    const progress = byId("validationProgress");
    if (progress) progress.style.width = "100%";
    const evidenceButton = byId("validationEvidenceButton");
    if (evidenceButton) evidenceButton.disabled = false;
    state.validationPayload = payload;
    state.validationLoaded = true;
  }

  function visionText(value, fallback = "—") {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  function renderVisionHealth(payload = {}) {
    const status = byId("visionHealthStatus");
    if (!status) return;
    const serviceConfigured = payload.serviceConfigured ?? payload.configured === true;
    const serviceReachable = payload.serviceReachable ?? payload.localServiceOk;
    const runtimeAvailable = payload.runtimeAvailable;
    const inferenceReady = payload.inferenceReady;
    let stateName = "degraded";
    let label = "视觉服务状态未知 · 仍会安全降级";
    if (!serviceConfigured) {
      label = "本地视觉服务未配置 · 仅提供安全降级";
    } else if (serviceReachable === false) {
      label = "已配置 · 本地推理服务未连接";
    } else if (runtimeAvailable === false) {
      label = "服务已连接 · OCR 运行时不可用";
    } else if (inferenceReady === true) {
      stateName = "ready";
      label = "本地 PaddleOCR 可用";
    } else if (serviceReachable === true) {
      stateName = "warming";
      label = "服务已连接 · 首次识别时加载模型";
    } else if (payload.status === "configured-unchecked") {
      stateName = "checking";
      label = "已配置 · 正在确认推理服务";
    }
    status.dataset.state = stateName;
    status.textContent = label;
  }

  async function refreshVisionHealth() {
    const status = byId("visionHealthStatus");
    if (status) {
      status.dataset.state = "checking";
      status.textContent = "正在检查本地视觉服务…";
    }
    try {
      renderVisionHealth(await getJson("/api/cv/health", 5000));
    } catch {
      renderVisionHealth({ configured: true, serviceConfigured: true, serviceReachable: false, status: "unreachable" });
    }
  }

  function visionInferenceStatus(result = {}) {
    const explicit = String(result.inferenceStatus || "").trim().toLowerCase();
    if (["synthetic", "executed", "error", "not-run"].includes(explicit)) return explicit;
    const mode = String(result.mode || "").trim().toLowerCase();
    if (mode === "synthetic") return "synthetic";
    if (mode.includes("fallback") || mode.includes("inspection") || mode === "service-synthetic") return "not-run";
    if (mode.includes("synthetic")) return "synthetic";
    return "executed";
  }

  function renderVisionResult(result) {
    state.visionResult = result;
    const inferenceStatus = visionInferenceStatus(result);
    const inferenceNotRun = inferenceStatus === "not-run";
    const preview = byId("visionPreviewImage");
    const previewVideo = byId("visionPreviewVideo");
    const empty = byId("visionPreviewEmpty");
    const image = result?.annotatedImage || result?.previewImage;
    const videoSource = result?.previewVideo;
    if (preview && image && !videoSource) {
      preview.src = image;
      preview.hidden = false;
    } else {
      if (preview) { preview.hidden = true; preview.removeAttribute("src"); }
    }
    if (previewVideo && videoSource) {
      previewVideo.src = videoSource;
      previewVideo.hidden = false;
      previewVideo.load();
      void previewVideo.play().catch(() => {});
    } else if (previewVideo) {
      previewVideo.pause();
      previewVideo.hidden = true;
      previewVideo.removeAttribute("src");
      previewVideo.load();
    }
    if (empty) empty.hidden = Boolean(image || videoSource);

    const vehicles = Array.isArray(result?.vehicles) ? result.vehicles : [];
    const parking = Array.isArray(result?.parking) ? result.parking : [];
    const capabilities = result?.capabilities && typeof result.capabilities === "object" ? result.capabilities : {};
    const capability = (name, fallback = "not-run") => String(capabilities[name] || fallback).toLowerCase();
    const capabilityLabel = (name, value) => {
      const status = capability(name, value);
      if (status === "not-run") return "未接入";
      if (status === "unavailable") return "服务不可用";
      if (status === "error") return "失败";
      if (status === "simulated") return "模拟";
      if (status === "synthetic") return "合成演示";
      return null;
    };
    setText("visionVehicleCount", capabilityLabel("vehicleDetection") || `${vehicles.length} 辆`);
    setText("visionIdleSlots", capabilityLabel("parkingDetection") || `${parking.filter((slot) => slot.status === "idle").length} 个`);
    setText("visionQueueCount", capabilityLabel("queueDetection", result?.queueVehicles == null ? "not-run" : "executed") || `${result.queueVehicles} 辆`);
    const arrivalStatus = String(result?.arrivalRecognition?.status || "not-run").toLowerCase();
    setText("visionArrivalState", inferenceStatus === "error" || arrivalStatus === "error"
      ? "推理失败"
      : arrivalStatus === "unavailable"
        ? "模型未就绪"
        : arrivalStatus === "recognized"
          ? inferenceStatus === "synthetic" ? "已识别（合成演示）" : "已识别"
          : arrivalStatus === "unrecognized" ? "未识别" : "未执行");
    setText("visionConfidenceLabel", inferenceStatus === "synthetic" ? "合成演示分数" : "OCR模型分数");
    const confidenceValue = result?.confidence == null ? null : Number(result.confidence);
    setText("visionConfidence", inferenceNotRun || !Number.isFinite(confidenceValue) ? "—" : `${(confidenceValue * 100).toFixed(1)}%`);
    setText("visionSource", visionText(result?.source));
    setText("visionPlate", visionText(result?.arrivalRecognition?.plate, "未识别"));
    setText("visionReceipt", visionText(result?.paymentReceipt?.message, "未生成"));
    setText("visionObservedAt", visionText(result?.observedAt));
    const processingMsValue = result?.processingMs == null ? null : Number(result.processingMs);
    setText("visionProcessingTime", Number.isFinite(processingMsValue) ? `${processingMsValue} ms` : "—");
    const videoMeta = result?.video && typeof result.video === "object" ? result.video : null;
    const sampled = videoMeta?.framesSampled == null ? null : Number(videoMeta.framesSampled);
    const decoded = videoMeta?.framesDecoded == null ? null : Number(videoMeta.framesDecoded);
    const sampleFps = videoMeta?.sampleFps == null ? null : Number(videoMeta.sampleFps);
    const durationSec = videoMeta?.durationSec == null ? null : Number(videoMeta.durationSec);
    setText("visionVideoStats", Number.isFinite(sampled) && Number.isFinite(decoded)
      ? `${sampled}/${decoded} 帧 · ${Number.isFinite(sampleFps) ? sampleFps : "—"} fps · ${Number.isFinite(durationSec) ? durationSec : "—"} 秒`
      : "—");
    const evidence = byId("visionEvidence");
    if (evidence) evidence.innerHTML = (Array.isArray(result?.evidence) && result.evidence.length ? result.evidence : ["暂无可展示的计算依据"]).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    setText("visionBoundary", visionText(result?.dataBoundary, "视觉结果边界待确认"));
    const json = byId("visionJson");
    if (json) {
      const safe = Object.assign({}, result || {});
      delete safe.annotatedImage;
      delete safe.previewImage;
      delete safe.previewVideo;
      json.textContent = JSON.stringify(safe, null, 2);
      json.hidden = !result;
    }
    const status = byId("visionStatus");
    if (status) {
      status.dataset.state = inferenceStatus === "error" || inferenceNotRun ? "degraded" : "ready";
      status.textContent = inferenceStatus === "error"
        ? "视觉推理失败 · 未生成虚构结果"
        : inferenceNotRun
          ? "已检查 · 未执行视觉推理"
          : inferenceStatus === "synthetic"
            ? "合成演示完成 · 结果可追溯"
            : "视觉推理完成 · 结果可追溯";
    }
    if (inferenceStatus === "executed") {
      const health = byId("visionHealthStatus");
      if (health) {
        health.dataset.state = "ready";
        health.textContent = "本次本地 OCR 已实际执行";
      }
    }
  }

  async function readVisionFile(file) {
    if (!file) return null;
    const isImage = /^image\/(png|jpeg|webp)$/i.test(file.type);
    const isVideo = /^video\/(mp4|webm|quicktime|x-matroska)$/i.test(file.type);
    if (!isImage && !isVideo) throw new Error("只支持 PNG、JPEG、WebP 图片或 MP4、WebM、MOV 短视频");
    const maxBytes = isVideo ? 24 * 1024 * 1024 : 4 * 1024 * 1024;
    if (file.size > maxBytes) throw new Error(isVideo ? "视频不能超过 24 MB" : "图片不能超过 4 MB");
    if (isImage) return readVisionBlob(file, file.name || "上传图片");
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读取视频失败"));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(file);
    });
  }

  async function readVisionBlob(blob, label = "图片") {
    const type = String(blob?.type || "").toLowerCase();
    if (!/^image\/(png|jpeg|webp)$/i.test(type)) throw new Error(`${label}不是受支持的图片格式`);
    if (Number(blob?.size || 0) > 4 * 1024 * 1024) {
      throw new Error(label === "内置样例" ? "内置样例图片不能超过 4 MB" : "图片不能超过 4 MB");
    }
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(blob);
    });
  }

  async function readBuiltInVisionSample() {
    const response = await fetch(DEFAULT_VISION_SAMPLE_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("读取内置视觉样例失败");
    return readVisionBlob(await response.blob(), "内置样例");
  }

  async function runVisionAnalysis(mode = "sample") {
    const requestId = ++state.visionRequestVersion;
    const sampleButton = byId("visionSampleButton");
    const uploadButton = byId("visionUploadButton");
    const status = byId("visionStatus");
    [sampleButton, uploadButton].filter(Boolean).forEach((button) => { button.disabled = true; button.setAttribute("aria-busy", "true"); });
    if (status) {
      status.dataset.state = "processing";
      status.textContent = mode === "sample" ? "正在用本地 OCR 识别内置样例…" : "正在准备本地视觉分析…";
    }
    try {
      const body = { mode, seed: "flowtwin-vision-01" };
      if (mode === "sample") {
        body.mode = "upload";
        body.imageData = await readBuiltInVisionSample();
        body.fileName = "default-camera-scene.png";
      } else if (mode === "upload") {
        if (!state.visionFile) throw new Error("请先选择一张图片或短视频");
        const isVideo = /^video\//i.test(state.visionFile.type);
        body.mode = isVideo ? "video" : "upload";
        const dataUrl = await readVisionFile(state.visionFile);
        if (isVideo) body.videoData = dataUrl;
        else body.imageData = dataUrl;
        body.fileName = state.visionFile.name;
      }
      const isVideo = body.mode === "video";
      const result = await postJson("/api/cv/analyze", body, isVideo ? 125000 : body.mode === "upload" ? 65000 : 25000);
      if (requestId !== state.visionRequestVersion) return;
      // Keep the preview in the browser's existing FileReader data URL. The
      // local CV service should not echo the uploaded plate image back in its
      // JSON response, which reduces memory duplication and data retention.
      renderVisionResult(body.mode === "video"
        ? { ...result, previewVideo: body.videoData }
        : body.mode === "upload" ? { ...result, previewImage: body.imageData } : result);
    } catch (error) {
      if (status) { status.dataset.state = "error"; status.textContent = error?.message || "视觉分析失败"; }
      showToast(error?.message || "视觉分析失败", 3200);
    } finally {
      [sampleButton, uploadButton].filter(Boolean).forEach((button) => { button.disabled = button === uploadButton ? !state.visionFile : false; button.removeAttribute("aria-busy"); });
    }
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
  }

  function renderValidationEvidence(payload) {
    if (!payload) return;
    const modeLabel = payload.inputMode === "current-stations" ? "当前路线检索到的站点输入" : "固定合成站点输入";
    const summary = byId("validationEvidenceSummary");
    if (summary) summary.innerHTML = [
      `输入：${modeLabel}`,
      `节点：${payload.stationCount || 0}`,
      `样本：${payload.trips?.toLocaleString?.() || payload.trips} 次行程`,
      `随机种子：${payload.seed}`
    ].map((item) => `<span>${escapeHtml(item)}</span>`).join("");
    const names = new Map(state.stations.map((station) => [String(station.id), station.name]));
    const stationRows = byId("validationEvidenceStationRows");
    if (stationRows) stationRows.innerHTML = (payload.stationTemplates || []).map((station) => `<tr><td title="${escapeHtml(names.get(String(station.id)) || station.id)}">${escapeHtml(names.get(String(station.id)) || station.id)}</td><td>${Number(station.baseWait).toFixed(1)} 分</td><td>¥${Number(station.price).toFixed(2)}</td><td>${Number(station.capacity).toFixed(0)}</td><td>${(Number(station.load) * 100).toFixed(0)}%</td></tr>`).join("") || '<tr><td colspan="5">本次没有可展示的站点输入。</td></tr>';
    const fillList = (id, entries) => {
      const list = byId(id);
      if (list) list.innerHTML = entries.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("");
    };
    fillList("validationEvidenceScenario", Object.values(payload.methodology?.scenarioGeneration || {}));
    fillList("validationEvidenceStrategies", Object.entries(payload.methodology?.strategies || {}).map(([key, value]) => `${key}：${value}`));
    fillList("validationEvidenceFormulas", [
      ...Object.entries(payload.metricDefinitions || {}).map(([key, value]) => `${key}：${value}`),
      ...Object.entries(payload.methodology?.formulas || {}).map(([key, value]) => `${key}：${value}`)
    ]);
    setText("validationEvidenceAssumptions", payload.assumptions || "固定随机种子合成样本，仅用于可复现实验对比。");
  }

  function openValidationEvidence() {
    if (!state.validationPayload) return;
    renderValidationEvidence(state.validationPayload);
    const backdrop = byId("validationEvidenceBackdrop");
    if (backdrop) backdrop.hidden = false;
    refreshIcons();
  }

  function closeValidationEvidence() {
    const backdrop = byId("validationEvidenceBackdrop");
    if (backdrop) backdrop.hidden = true;
  }

  function validationStationInput() {
    // Validation only consumes the following quantitative fields. Sending map
    // markers, addresses and service metadata made a long national route exceed
    // the old request budget and incorrectly look like an unavailable service.
    return state.stations.slice(0, 36).map((station) => ({
      id: String(station.id || ""),
      name: String(station.name || "补能站"),
      type: station.type,
      wait: Number(station.wait || station.p50 || 0),
      p50: Number(station.p50 || station.wait || 0),
      p90: Number(station.p90 || station.wait || 0),
      price: Number(station.price || 0),
      occupancy: Number(station.occupancy || 0),
      capacity: Number(station.capacity || 0) || undefined,
      demand: Number(station.demand || 0) || undefined,
      serviceRate: Number(station.serviceRate || 0) || undefined,
      detour: Number(station.detourKm ?? station.detour ?? 0)
    }));
  }

  async function loadValidation(force = false) {
    if (state.validationLoaded && !force) return;
    setText("validationStatusText", "正在运行策略仿真…");
    setText("validationStatusMeta", "固定随机种子 · 正在以当前站点输入计算 1,000 次合成行程");
    const evidenceButton = byId("validationEvidenceButton");
    if (evidenceButton) evidenceButton.disabled = true;
    const progress = byId("validationProgress");
    if (progress) progress.style.width = "34%";
    try {
      const payload = await postJson("/api/validate", { trips: 1000, seed: 20260719, stations: validationStationInput() }, 30000);
      renderValidationPayload(payload);
    } catch (error) {
      setText("validationStatusText", "仿真服务暂不可用");
      setText("validationStatusMeta", "未生成结果；不会展示示例数字或伪造结论");
      if (progress) progress.style.width = "0%";
    }
  }

  function applyStrategy() {
    const payload = state.pendingOperatorPayload;
    if (!payload?.stations?.length) return false;
    const before = state.operatorBefore || computeOperatorSnapshot(state.stations);
    const executable = payload.execution?.executable === true && payload.insufficientData !== true;
    if (!executable) {
      // 站点边界或经济字段不满足时，不把“仿真响应”写回导航状态，
      // 更不能再用旧版的固定 0.8 / 0.786 / ROI 1.8 兜底制造执行结果。
      state.operatorAfter = Object.assign({}, before, {
        strategyAvailable: false,
        discount: null,
        roi: null,
        scenarioRoi: null,
        noStrategyReason: payload.insufficientData ? "数据不足" : "仅导航"
      });
      renderOperatorMetrics(state.operatorAfter, true);
      renderOperatorFlow(payload);
      return false;
    }
    const byStation = new Map(payload.stations.map((station) => [station.id, station]));
    state.stations = state.stations.map((station) => Object.assign({}, station, byStation.get(station.id) || {}));
    const after = payload.after || {};
    state.operatorAfter = {
      averageWait: Number(after.averageWait ?? before.averageWait),
      p90: Number(after.p90Wait ?? before.p90),
      dispersion: Number(after.occupancyDispersion ?? before.dispersion),
      peakQueue: Number(after.peakQueue ?? before.peakQueue),
      onTime: before.onTime,
      roi: Number(payload.scenarioRoi ?? payload.impact?.scenarioRoi ?? payload.impact?.roi ?? 0),
      scenarioRoi: Number(payload.scenarioRoi ?? payload.impact?.scenarioRoi ?? payload.impact?.roi ?? 0),
      discount: Number(payload.platformCoupon ?? payload.discountAmount ?? 0),
      riskCount: state.stations.filter((station) => station.status === "forecast-risk").length,
      recommendedDiscount: payload.recommendedPlatformCoupon ?? payload.recommendedDiscount,
      recommendedRoi: Number(payload.recommendedBasis?.scenarioRoi ?? payload.recommendedBasis?.roi ?? 0),
      strategyAvailable: true
    };
    Object.values(state.routeRecords).forEach((record) => {
      const updatedStation = state.stations.find((station) => station.id === record.station?.id);
      if (updatedStation) record.station = Object.assign({}, updatedStation, { detour: record.station.detour });
    });
    calculateRouteRecords();
    renderRouteCards();
    if (state.live) renderLiveStationMarkers();
    renderOperatorMetrics(state.operatorAfter, true);
    renderValidationMetrics(state.operatorAfter);
    return true;
  }

  function resetExecution() {
    state.executionState = "before";
    if (state.operatorOriginalStations.length) state.stations = state.operatorOriginalStations.map((station) => Object.assign({}, station));
    Object.values(state.routeRecords).forEach((record) => {
      const originalStation = state.stations.find((station) => station.id === record.station?.id);
      if (originalStation) record.station = Object.assign({}, originalStation, { detour: record.station.detour });
    });
    state.operatorAfter = null;
    state.pendingOperatorPayload = null;
    state.pendingOperatorSnapshot = null;
    resetFeishuSync();
    resetOperatorAnalysisSteps();
    $$(".execution-step").forEach((step) => step.classList.remove("done"));
    const button = byId("approveButton");
    const reset = byId("resetExecution");
    if (button) {
      button.disabled = false;
      button.style.opacity = "1";
      button.style.color = "";
      button.innerHTML = '<i data-lucide="sparkles"></i>开始智能分析';
    }
    if (reset) reset.classList.add("hidden");
    renderOperatorMetrics(state.operatorBefore, false);
    renderValidationMetrics(null);
    calculateRouteRecords();
    renderRouteCards();
    if (state.live) renderLiveStationMarkers();
    refreshIcons();
  }

  async function runExecutionLoop() {
    if (state.executionState === "running") return;
    if (state.executionState === "after") {
      resetExecution();
      return;
    }
    if (!state.pendingOperatorPayload) await simulateOperatorStrategy();
    if (!state.pendingOperatorPayload) return;
    state.executionState = "running";
    const button = byId("approveButton");
    if (button) {
      button.innerHTML = '<i data-lucide="loader-circle"></i>正在生成沙盘结果…';
      button.disabled = true;
      button.style.opacity = "0.72";
      refreshIcons();
    }
    await new Promise((resolve) => window.setTimeout(resolve, 680));
    applyStrategy();
    state.executionState = "after";
    setOperatorAnalysisStep("simulation", "completed", "已完成");
    if (button) {
      button.innerHTML = '<i data-lucide="loader-circle"></i>正在获取 AI 解读…';
      refreshIcons();
    }
    await syncFeishuOperatorSnapshot();
    if (button) {
      button.disabled = false;
      button.style.opacity = "1";
      // The completed state keeps the teal CTA background; keep the label
      // white so it does not disappear into the button color.
      button.style.color = "white";
      button.innerHTML = '<i data-lucide="rotate-ccw"></i>重置分析';
    }
    // The main CTA becomes “重置分析” after completion; keep the legacy
    // secondary reset control hidden so the evaluator sees one clear action.
    byId("resetExecution")?.classList.add("hidden");
    showToast("分析完成：策略沙盘结果与 AI 运营解读已更新");
    refreshIcons();
  }

  function hybridBranchRangeKm(kind) {
    const profile = kind === "fuel" ? ENERGY_PROFILES.hybridFuel : ENERGY_PROFILES.hybridElectric;
    return Math.max(0, Math.floor(profile.capacity * hybridBranchLevel(kind) / 100 / profile.consumptionPerKm));
  }

  function hybridCombinedRangeKm() {
    return hybridBranchRangeKm("electric") + hybridBranchRangeKm("fuel");
  }

  function updateEnergyControls() {
    const isFuel = isFuelActive();
    const hybrid = isHybrid();
    const stateLabel = byId("vehicleEnergyLabel");
    if (stateLabel) stateLabel.textContent = hybrid ? (isFuel ? "混动 · 油量" : "混动 · 电量") : isFuel ? "当前油量" : "当前电量";
    $$('[data-energy-type]').forEach((button) => button.classList.toggle("active", button.dataset.energyType === state.energyType));
    const vehicleIcon = byId("vehicleEnergyIcon");
    const vehiclePercent = byId("vehicleEnergyPercent");
    const vehicleRange = byId("vehicleEnergyRange");
    if (vehicleIcon) vehicleIcon.outerHTML = `<i data-lucide="${isFuel ? "fuel" : "battery-medium"}" id="vehicleEnergyIcon"></i>`;
    if (vehiclePercent) vehiclePercent.textContent = `${Math.round(state.energyPercent)}%`;
    if (vehicleRange) {
      const profile = getEnergyProfile(isFuel);
      const estimatedRange = Math.max(0, Math.floor(profile.capacity * state.energyPercent / 100 / profile.consumptionPerKm));
      vehicleRange.textContent = hybrid
        ? `当前合计约 ${hybridCombinedRangeKm()} km · 满载参考约 ${VEHICLE_RANGE_GUIDANCE.hybridCombinedFullRangeKm} km`
        : `预计可行驶 ${estimatedRange} km`;
    }
    const hybridPanel = byId("hybridLevels");
    if (hybridPanel) hybridPanel.hidden = !hybrid;
    if (hybrid) {
      const electricInput = byId("hybridElectricInput");
      const fuelInput = byId("hybridFuelInput");
      if (electricInput && document.activeElement !== electricInput) electricInput.value = String(Math.round(hybridBranchLevel("electric")));
      if (fuelInput && document.activeElement !== fuelInput) fuelInput.value = String(Math.round(hybridBranchLevel("fuel")));
    }
    syncManualControls();
    refreshIcons();
    updateInsight(state.routeRecords[state.selectedRoute]);
  }

  // Switching the vehicle type has to re-seed the hybrid levels before anything
  // reads `energyPercent`, otherwise the first plan runs on the previous
  // vehicle's tank level interpreted as a battery percentage.
  function adoptEnergyType(type) {
    if (!ENERGY_TYPES.includes(type) || type === state.energyType) return false;
    const previousKind = activeEnergyKind();
    const previousPercent = state.energyPercent;
    if (type === "hybrid") {
      // Carry the level the driver already entered into the matching branch.
      state.hybridLevels[previousKind] = clampPercent(previousPercent, previousKind === "fuel" ? 60 : 35);
      state.energyType = "hybrid";
      state.hybridBranch = previousKind;
      state.hybridBranchTouched = false;
      syncHybridLevels();
    } else {
      state.energyType = type;
      state.energyPercent = clampPercent(state.hybridLevels[type], type === "fuel" ? 60 : 35);
      state.hybridBranchTouched = false;
    }
    state.hybridComparison = null;
    state.reservationOverrides = {};
    state.stationForecastScenarioKey = null;
    return true;
  }

  async function setEnergyType(type, replan) {
    if (!ENERGY_TYPES.includes(type)) return;
    const changed = adoptEnergyType(type);
    state.lastIntentSignature = null;
    state.routeSelectionTouched = false;
    state.selectedRoute = "reliable";
    updateEnergyControls();
    // The selector now lives in the always-visible vehicle card, so it can be
    // clicked before the first plan.  Update the local vehicle state in that
    // case, but do not spend a map/POI request until a route actually exists.
    if (replan !== false && state.hasPlannedRoute && state.live && state.AMap) {
      setMapStatus("正在按动力类型重新检索补能站…");
      await queryStations();
      await replanRoutesViaStations();
      drawAmapRoutes();
      fitAmapView();
      setMapStatus("高德地图已连接 · 真实路线与 POI 已更新", "ready");
      setText("mapAttribution", "高德地图 · 真实路线与 POI / 演示预测状态");
      setText("stationDataNote", activeProvisionalCorridorActive()
        ? "排队、补能服务时长、实时负载和价格为演示模拟数据；高德 POI 以外的路线补能兜底候选仅用于规划演示，需在出发前确认现场设备。"
        : "排队、补能服务时长、实时负载和价格为演示模拟数据；站点名称、坐标和地址来自高德真实 POI。服务区候选的补能设施需现场确认。");
      renderRouteCards();
    } else {
      if (!state.live) {
        // A hybrid can use either network, so the offline sample keeps both.
        const expectedTypes = isHybrid() ? ["加油站", "充电站"] : [isFuelActive() ? "加油站" : "充电站"];
        state.stations = FALLBACK.stations.filter((station) => expectedTypes.includes(station.type)).map(simulateStation);
        const branchPool = stationsForActiveBranch();
        state.routeCandidates = fallbackRoutes();
        state.routeCandidates.fastest.station = branchPool[0] || null;
        state.routeCandidates.reliable.station = branchPool[1] || branchPool[0] || null;
        state.routeCandidates.cheapest.station = branchPool[2] || branchPool[0] || null;
      }
      renderRouteCards();
    }
    if (changed) {
      showToast(type === "hybrid"
        ? "已切换为混动车型：将同时核算油、电两条补能路径"
        : type === "fuel" ? "已切换为燃油补能方案" : "已切换为纯电补能方案");
    }
  }

  async function recomputePlan(options = {}) {
    const manageButton = options.manageButton !== false;
    if (manageButton) setComposerSubmitting(true);
    state.routeSelectionTouched = false;
    state.selectedRoute = "reliable";
    state.multiStopRouteRecords = null;
    state.multiStopPlanningMeta = null;
    state.serviceSuggestion = null;
    state.activeServicePlan = null;
    state.serviceRouteOverrides = {};
    state.reservationOverrides = {};
    if (state.live && state.AMap) {
      const policies = makeDrivingPolicies(state.AMap);
      // Keep the three policy requests slightly staggered. Sending them in one
      // Promise.all burst is more likely to hit the JS SDK's transient request
      // throttle, especially immediately after the map has just initialized.
      const records = [];
      const policyEntries = Object.entries(policies);
      for (let index = 0; index < policyEntries.length; index += 1) {
        const [key, policy] = policyEntries[index];
        records.push([key, await queryDriving(key, policy)]);
        if (index < policyEntries.length - 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 120));
        }
      }
      const liveRecords = Object.fromEntries(records.filter((entry) => entry[1]));
      // 一条真实路线都没有时，不能退到演示折线：那是固定的北京→大兴机场数据，
      // 画在"高德已连接"的地图上就是一条与本次行程无关的虚假路线。
      if (!Object.keys(liveRecords).length) {
        state.routeRecords = {};
        state.baseRouteRecords = {};
        state.routeCandidates = {};
        state.stations = [];
        state.hasPlannedRoute = false;
        clearLiveOverlays();
        renderStationSummary();
        setMapStatus("高德路线服务未返回本次行程的可行路线，未生成方案", "error");
        setText("mapAttribution", "高德地图 · 路线不可用");
        if (manageButton) setComposerSubmitting(false);
        showToast("未生成虚假路线：高德未返回本次行程的可行路线，请稍后重试", 4200);
        return;
      }
      state.routeRecords = fillMissingObjectivesWithRealRoutes(liveRecords, Object.keys(policies));
      state.baseRouteRecords = Object.assign({}, state.routeRecords);
      await queryStations();
      await replanRoutesViaStations();
      drawAmapRoutes();
      fitAmapView();
      setMapStatus("高德地图已连接 · 真实路线与 POI 已更新", "ready");
      setText("mapAttribution", "高德地图 · 真实路线与 POI / 演示预测状态");
      setText("stationDataNote", activeProvisionalCorridorActive()
        ? "排队、补能服务时长、实时负载和价格为演示模拟数据；高德 POI 以外的路线补能兜底候选仅用于规划演示，需在出发前确认现场设备。"
        : "排队、补能服务时长、实时负载和价格为演示模拟数据；站点名称、坐标和地址来自高德真实 POI。服务区候选的补能设施需现场确认。");
    } else {
      prepareFallbackPlan();
      state.hasPlannedRoute = true;
      renderFallbackRouteVisuals();
    }
    state.hasPlannedRoute = true;
    renderRouteCards();
    if (manageButton) setComposerSubmitting(false);
    if (!options.silent) showToast("补能方案已根据当前约束重新计算");
  }

  function makeDrivingPolicies(AMap) {
    return {
      fastest: AMap.DrivingPolicy && AMap.DrivingPolicy.LEAST_TIME !== undefined ? AMap.DrivingPolicy.LEAST_TIME : 0,
      reliable: AMap.DrivingPolicy && AMap.DrivingPolicy.REAL_TRAFFIC !== undefined ? AMap.DrivingPolicy.REAL_TRAFFIC : 4,
      cheapest: AMap.DrivingPolicy && AMap.DrivingPolicy.LEAST_FEE !== undefined ? AMap.DrivingPolicy.LEAST_FEE : 1
    };
  }

  function prepareFallbackPlan() {
    state.routeRecords = fallbackRoutes();
    state.baseRouteRecords = Object.assign({}, state.routeRecords);
    // 混动模式下油、电两张网都要保留，油电对比才有数据可算。
    const expectedTypes = isHybrid() ? ["加油站", "充电站"] : [isFuelActive() ? "加油站" : "充电站"];
    state.stations = FALLBACK.stations.filter((station) => expectedTypes.includes(station.type)).map(simulateStation);
    const branchPool = stationsForActiveBranch();
    state.routeRecords.fastest.station = branchPool[0] || null;
    state.routeRecords.reliable.station = branchPool[1] || branchPool[0] || null;
    state.routeRecords.cheapest.station = branchPool[2] || branchPool[0] || null;
    state.routeCandidates = Object.assign({}, state.routeRecords);
    renderStationSummary();
  }

  async function initLiveMap(AMap) {
    state.AMap = AMap;
    const mapElement = byId("map");
    if (mapElement) mapElement.innerHTML = "";
    state.map = new AMap.Map("map", {
      zoom: 10,
        center: state.origin,
      viewMode: "2D",
      resizeEnable: true,
      zooms: [5, 19],
      mapStyle: "amap://styles/whitesmoke"
    });
    state.live = true;
    state.routeRecords = {};
    state.routeCandidates = {};
    state.baseRouteRecords = {};
    state.multiStopRouteRecords = null;
    state.multiStopPlanningMeta = null;
    state.stations = [];
    addAmapEndpoints();
    fitAmapView();
    setMapStatus("高德地图已连接 · 输入需求后开始 AI 规划", "ready");
    byId("mapAttribution").textContent = "高德地图 · 待规划";
    let resizeTimer;
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (state.map && state.live) {
          state.map.resize();
          if (state.mode === "driver") fitAmapView();
        }
      }, 180);
    });
    window.__FLOWTWIN_READY__ = true;
  }

  function initFallback() {
    state.live = false;
    state.hasPlannedRoute = false;
    state.routeRecords = {};
    state.baseRouteRecords = {};
    state.routeCandidates = {};
    state.multiStopRouteRecords = null;
    state.multiStopPlanningMeta = null;
    state.stations = [];
    renderFallbackMap();
    updateEnergyControls();
    setMapStatus("离线演示模式 · 输入需求后开始规划", "error");
    byId("mapAttribution").textContent = "固定场景地图 · 待规划";
    window.__FLOWTWIN_READY__ = true;
  }

  function begin() {
    refreshIcons();
    initDemoNotice();
    initSettings();
    setDisplayMode("reviewer", { persist: false });
    initFallback();
    renderParseAnalysis(null);
    setPlanningVisibility(false);
    void loadAiHealthStatus();
    fitIntentInput();
    if (window.innerWidth <= 760) byId("insightPanel").classList.add("hidden");
    initModeChoice();
    $$("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
    $$(".route-option").forEach((button) => button.addEventListener("click", () => selectRoute(button.dataset.route)));
    $$('[data-simulation-route]').forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      startSimulationForRoute(button.dataset.simulationRoute);
    }));
    byId("resetView").addEventListener("click", () => {
      selectRoute("reliable");
      if (state.live) fitAmapView();
    });
    byId("closeInsight").addEventListener("click", () => {
      state.mobileInsightOpen = false;
      byId("insightPanel").classList.add("collapsed");
      byId("insightPanel").classList.remove("mobile-visible");
      if (state.mode === "driver") byId("routeSheet").style.display = "";
    });
    byId("closeOperator").addEventListener("click", () => setMode("driver"));
    byId("closeValidation").addEventListener("click", () => setMode("driver"));
    byId("closeVision")?.addEventListener("click", () => setMode("driver"));
    byId("simulationExitButton")?.addEventListener("click", stopSimulationDriving);
    byId("simulationToolboxToggle")?.addEventListener("click", toggleSimulationToolbox);
    byId("simulationNextButton")?.addEventListener("click", () => {
      if (!state.simulation.active) return;
      state.simulation.phaseElapsedMs = Number(state.simulation.phase?.durationMs || 1);
      simulationAdvancePhase();
    });
    byId("simulationSkipStopButton")?.addEventListener("click", skipSimulationEnergyStop);
    byId("simulationScenePrimaryButton")?.addEventListener("click", handleSimulationSceneAction);
    byId("simulationPauseButton")?.addEventListener("click", toggleSimulationPause);
    byId("simulationAutoAdvance")?.addEventListener("change", (event) => setSimulationAutoAdvance(event.target.checked));
    $$('[data-simulation-speed]').forEach((button) => button.addEventListener("click", () => setSimulationSpeed(button.dataset.simulationSpeed)));
    byId("simulationOcrButton")?.addEventListener("click", () => runSimulationOcr(true));
    byId("simulationOcrFallbackButton")?.addEventListener("click", useSimulationOcrFallback);
    byId("simulationReservationEvidenceToggle")?.addEventListener("click", () => {
      if (!state.simulation.active || state.simulation.phase?.type !== "reservation") return;
      state.simulation.reservationEvidenceOpen = !state.simulation.reservationEvidenceOpen;
      renderSimulationReservationEvidence(state.simulation.phase);
      refreshIcons();
    });
    byId("visionSampleButton")?.addEventListener("click", () => runVisionAnalysis("sample"));
    byId("visionUploadButton")?.addEventListener("click", () => runVisionAnalysis("upload"));
    byId("visionFileInput")?.addEventListener("change", (event) => {
      state.visionFile = event.target.files?.[0] || null;
      const button = byId("visionUploadButton");
      if (button) button.disabled = !state.visionFile;
      const status = byId("visionStatus");
      const label = byId("visionUploadLabel");
      if (status && state.visionFile) {
        const kind = /^video\//i.test(state.visionFile.type) ? "视频" : "图片";
        status.dataset.state = "idle";
        status.textContent = `已选择${kind} · ${state.visionFile.name}`;
        if (label) label.textContent = kind === "视频" ? "已选短视频" : "已选车牌照片";
      } else if (label) {
        label.textContent = "上传车牌照片或短视频";
      }
    });
    byId("validationEvidenceButton")?.addEventListener("click", openValidationEvidence);
    byId("closeValidationEvidence")?.addEventListener("click", closeValidationEvidence);
    byId("validationEvidenceBackdrop")?.addEventListener("click", (event) => {
      if (event.target === byId("validationEvidenceBackdrop")) closeValidationEvidence();
    });
    byId("validationRerunButton")?.addEventListener("click", async () => {
      closeValidationEvidence();
      await loadValidation(true);
      showToast("已按相同输入和随机种子重新运行验证");
    });
    byId("intentInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        parseIntent();
      }
    });
    byId("intentInput").addEventListener("input", () => {
      state.lastIntentSignature = null;
      state.manualDeadlineOverride = null;
      state.manualArrivalReserveOverride = null;
      fitIntentInput();
      updateComposerActionLabel();
    });
    byId("parsedAnalysisToggle")?.addEventListener("click", () => {
      const toggle = byId("parsedAnalysisToggle");
      const factorsPanel = byId("parsedAnalysisFactors");
      if (!toggle || !factorsPanel || toggle.hidden) return;
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      factorsPanel.hidden = expanded;
      const label = toggle.querySelector("span");
      if (label) label.textContent = expanded ? "查看依据" : "收起依据";
    });
    byId("forecastEvidenceToggle")?.addEventListener("click", () => {
      const toggle = byId("forecastEvidenceToggle");
      const panel = byId("forecastEvidencePanel");
      if (!toggle || !panel) return;
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      panel.hidden = expanded;
      const label = toggle.querySelector("span");
      if (label) label.textContent = expanded ? "查看计算依据" : "收起计算依据";
    });
    byId("reservationButton")?.addEventListener("click", () => { void simulateReservation(); });
    byId("voiceIntentButton")?.addEventListener("click", () => { toggleVoiceIntent(); });
    byId("composerSubmitButton")?.addEventListener("click", parseIntent);
    byId("destinationCandidates")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-candidate-index]");
      if (!button) return;
      pickDestinationCandidate(button.dataset.candidateIndex);
    });
    $$('[data-energy-type]').forEach((button) => button.addEventListener("click", () => setEnergyType(button.dataset.energyType)));
    [byId("topEnergyPercentInput"), byId("departureTimeInput"), byId("deadlineInput"), byId("minArrivalSocInput")].filter(Boolean).forEach((input) => input.addEventListener("change", () => {
      state.lastIntentSignature = null;
      readManualControls({ markArrivalOverrides: input.id === "deadlineInput" || input.id === "minArrivalSocInput" });
      showToast("出行状态已更新，点击 AI 智能规划后重新计算", 2200);
    }));
    [byId("deadlineInput"), byId("minArrivalSocInput")].filter(Boolean).forEach((input) => input.addEventListener("input", () => {
      state.lastIntentSignature = null;
      readManualControls({ markArrivalOverrides: true });
    }));
    // 混动的两格电/油量直接写进 hybridLevels；当前规划分支那一格同步到
    // energyPercent，另一格只用于油电对比与切换分支后的起始能量。
    [["hybridElectricInput", "electric"], ["hybridFuelInput", "fuel"]].forEach(([id, kind]) => {
      byId(id)?.addEventListener("change", (event) => {
        state.lastIntentSignature = null;
        state.hybridLevels[kind] = clampPercent(event.target.value, kind === "fuel" ? 60 : 35);
        if (activeEnergyKind() === kind) state.energyPercent = state.hybridLevels[kind];
        syncHybridLevels();
        updateEnergyControls();
        renderHybridCompare();
        showToast("混动能量状态已更新，点击 AI 智能规划后重新计算", 2200);
      });
    });
    byId("collapseTrip").addEventListener("click", () => byId("tripPanel").classList.add("collapsed"));
    byId("expandTrip").addEventListener("click", () => byId("tripPanel").classList.remove("collapsed"));
    byId("expandInsight").addEventListener("click", () => {
      byId("insightPanel").classList.remove("collapsed", "hidden");
      if (window.innerWidth <= 760) {
        state.mobileInsightOpen = true;
        byId("insightPanel").classList.add("mobile-visible");
        byId("routeSheet").style.display = "none";
      }
    });
    byId("collapseRoutes").addEventListener("click", () => byId("routeSheet").classList.add("collapsed"));
    byId("expandRoutes").addEventListener("click", () => byId("routeSheet").classList.remove("collapsed"));
    byId("approveButton").addEventListener("click", runExecutionLoop);
    byId("resetExecution").addEventListener("click", resetExecution);
    byId("arrivalPaymentButton")?.addEventListener("click", runArrivalPayment);
    byId("paymentReceiptClose")?.addEventListener("click", closePaymentReceipt);
    byId("paymentReceiptOverlay")?.addEventListener("click", (event) => { if (event.target.id === "paymentReceiptOverlay") closePaymentReceipt(); });
    const discountSlider = byId("discountSlider");
    if (discountSlider) discountSlider.addEventListener("input", () => setText("discountValue", `¥${discountSlider.value}`));
    const operatorSimulate = byId("operatorSimulate");
    if (operatorSimulate) operatorSimulate.addEventListener("click", simulateOperatorStrategy);
    byId("feishuSyncButton")?.addEventListener("click", syncFeishuOperatorSnapshot);
    const services = byId("serviceRecommendations");
    if (services) services.addEventListener("click", async (event) => {
      const card = event.target.closest("[data-service]");
      if (!card) return;
      const option = state.serviceSuggestion?.options?.find((service) => service.id === card.dataset.service);
      if (option) await applyServicePlan(option);
    });
    byId("serviceNudgeAccept")?.addEventListener("click", async () => {
      await loadServiceRecommendations(state.routeRecords[state.selectedRoute]);
    });
    byId("serviceNudgeDismiss")?.addEventListener("click", () => {
      const suggestion = state.serviceSuggestion;
      if (suggestion?.key) state.serviceSuggestionDismissed.add(suggestion.key);
      byId("serviceNudge").hidden = true;
      setText("serviceStatus", "已跳过本次服务建议");
    });
    const serviceFeedbackButton = byId("serviceFeedbackButton");
    if (serviceFeedbackButton) serviceFeedbackButton.addEventListener("click", () => {
      if (!state.selectedService) {
        showToast("请先选择一个推荐服务", 2200);
        return;
      }
      setText("serviceStatus", "服务已完成 · 偏好已用于下一次推荐（演示）");
      serviceFeedbackButton.disabled = true;
      showToast("非油服务订单已完成并回流偏好模型（演示）");
    });

    if (config.mapMode !== "live" || !config.amapKey || !window.AMapLoader || typeof window.AMapLoader.load !== "function") {
      return;
    }
    window._AMapSecurityConfig = { securityJsCode: config.securityJsCode || "" };
    window.AMapLoader.load({
      key: config.amapKey,
      version: "2.0",
      plugins: ["AMap.Driving", "AMap.PlaceSearch", "AMap.Geocoder"]
    }).then((AMap) => initLiveMap(AMap)).catch((error) => {
      console.warn("FlowTwin live map unavailable", error);
      initFallback();
    });
  }

  window.__FLOWTWIN_DEBUG__ = () => ({
    live: state.live,
    mode: state.mode,
    originName: state.originName || null,
    destinationName: state.destinationName || null,
    origin: state.origin,
    destination: state.destination,
    stationCount: state.stations.length,
    displayedMarkerCount: state.stationOverlays.length,
    routeKeys: Object.keys(state.routeRecords),
    selectedRoute: state.selectedRoute,
    selectedStation: state.selectedStation ? state.selectedStation.name : null,
    energyType: state.energyType,
    energyPercent: state.energyPercent,
    energyProfile: getEnergyProfile(isFuelActive()),
    executionState: state.executionState,
    routeErrors: state.routeErrors,
    routes: Object.fromEntries(Object.entries(state.routeRecords).map(([key, record]) => [key, {
      station: record.station?.name || null,
      stationId: record.station?.id || null,
      stationType: record.station?.type || null,
      pathPoints: record.path?.length || 0,
      geometryHash: record.path ? stableHash(record.path.map((point) => `${point[0].toFixed(4)},${point[1].toFixed(4)}`).join("|")) : null,
      // 这条折线到底是不是"本次行程"的折线。两端偏离都应是零点几公里；
      // 一旦出现几十上百公里，说明画出来的是另一段行程的路线。
      pathStartOffsetKm: record.path?.length ? Number(distanceKm(record.path[0], state.origin).toFixed(2)) : null,
      pathEndOffsetKm: record.path?.length ? Number(distanceKm(record.path[record.path.length - 1], state.destination).toFixed(2)) : null,
      policyFallbackFrom: record.policyFallbackFrom || null,
      distance: Number(record.distance?.toFixed ? record.distance.toFixed(2) : record.distance),
      baseDistance: Number(record.baseDistance?.toFixed ? record.baseDistance.toFixed(2) : record.baseDistance),
      detour: record.station?.detour || null,
      closestPathToStationKm: record.station?.location && record.path ? Number(nearestPointDistance(record.station.location, record.path).toFixed(3)) : null,
      arrival: Number.isFinite(record.arrival) ? formatClock(record.arrival) : null,
      totalMinutes: Number.isFinite(record.total) ? Number(record.total.toFixed(2)) : null,
      cost: Number.isFinite(record.cost) ? Number(record.cost.toFixed(2)) : null,
      p90: record.station?.p90 || null,
      // 能量账本。单站方案里 energyAmount 不可能超过 (capacity - 到站电量)/效率，
      // firstLegKm 也必须和站点在路线上的位置对得上；对不上就是补能量算错了。
      multiStop: Boolean(record.multiStop),
      stopCount: record.stopCount || null,
      energyAmount: record.energyAmount,
      firstLegKm: Number.isFinite(record.firstLegKm) ? Number(record.firstLegKm.toFixed(2)) : null,
      arrivalAtStationSoc: record.arrivalAtStationSoc,
      arrivalSoc: record.arrivalSoc,
      energyReason: record.energyReason || null,
      // 排队账本。"总排队 P90" 是卡片上的头条数字，却一直没法核对。分位数不可加，
      // 各站 P90 直接相加会系统性高估、并且停得越多罚得越重；这里把每站的
      // plannedP50/plannedP90 和汇总值一起摊出来，naiveP90Sum 就是旧口径，
      // 两者拉开差距才说明卷积真的生效了（单停时应当相等）。
      p50Wait: record.p50Wait ?? null,
      p90Wait: record.p90Wait ?? null,
      stopWaits: record.stops?.map((stop) => ({ name: stop.name, p50: stop.plannedP50, p90: stop.plannedP90 })) || null,
      naiveP90Sum: record.stops?.length ? Number(record.stops.reduce((sum, stop) => sum + Number(stop.plannedP90 || 0), 0).toFixed(1)) : null,
      feasible: record.feasible
    }])),
    // 选站为什么落空：候选池是空的，还是每个候选都被"够不着 / 绕路太远"筛掉了？
    // 这两种情况对应完全不同的修法，不区分开就只能靠猜。
    maxDetourKm: state.maxDetourKm,
    longTripActive: state.longTripActive,
    provisionalCorridorActive: activeProvisionalCorridorActive(),
    multiStopPlanningMeta: state.multiStopPlanningMeta || null,
    directEnergy: (() => {
      const base = state.baseRouteRecords[state.selectedRoute] || state.baseRouteRecords.reliable;
      if (!base) return null;
      const direct = directEnergyState(base, isFuelActive());
      return {
        canDirect: direct.canDirect,
        maxSafeFirstLegKm: Number(direct.maxSafeFirstLegKm?.toFixed?.(2) ?? direct.maxSafeFirstLegKm),
        baseDistanceKm: Number(Number(base.distance || 0).toFixed(2))
      };
    })(),
    stations: state.stations.map((station) => ({
      id: station.id,
      name: station.name,
      // 服务区兜底候选常常只叫"服务区"，光看 name 没法判断它到底是不是真实地点；
      // 带上地址才核得动。
      address: station.address,
      type: station.type,
      source: station.source,
      p90: station.p90,
      price: station.price,
      occupancy: Number(station.occupancy.toFixed(2)),
      // 单站选站的两道硬门槛，和 chooseStationForRouteExcluding 用的是同一对函数。
      approachKm: Number(estimateStationApproachKm(station).toFixed(2)),
      detourKm: Number(estimateStationDetourKm(station).toFixed(2)),
      progress: Number(routeProgress(station.location, corridorReferenceRoute().path).toFixed(2)),
      // 没有参考路线时是 Infinity，如实报 null，不要被四舍五入成一个数字。
      corridorKm: (() => {
        const offset = nearestPointDistance(station.location, corridorReferenceRoute().path);
        return Number.isFinite(offset) ? Number(offset.toFixed(2)) : null;
      })(),
      location: station.location
    }))
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", begin);
  else begin();
})();
