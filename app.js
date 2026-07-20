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
    selectedRoute: "reliable",
    routeSelectionTouched: false,
    origin: FALLBACK.origin,
    destination: FALLBACK.destination,
    routeRecords: {},
    routeCandidates: {},
    baseRouteRecords: {},
    multiStopRouteRecords: null,
    multiStopPlanningMeta: null,
    serviceRouteOverrides: {},
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
    destinationName: "北京大兴国际机场",
    energyType: "electric",
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
    aiActive: false,
    forecastRequestVersion: 0,
    validationLoaded: false,
    validationPayload: null,
    pendingOperatorPayload: null,
    pendingOperatorSnapshot: null,
    hasPlannedRoute: false,
    vehiclePlate: "京A·FT2026",
    paymentState: "authorized",
    paymentReceipt: null
  };

  const DEFAULT_DEMO_INTENT = "从能链北京总部前往上海东方明珠广播电视塔，最晚23:15前到，到达至少保留20%，优先准时";

  const ENERGY_PROFILES = {
    electric: { capacity: 82, consumptionPerKm: 0.18, transferEfficiency: 0.92, safetyReservePercent: 2, unit: "kWh" },
    fuel: { capacity: 55, consumptionPerKm: 0.075, transferEfficiency: 0.95, safetyReservePercent: 3, unit: "L" }
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const byId = (id) => document.getElementById(id);

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

  function setAiStatus(label, stateName) {
    const status = byId("aiStatus");
    if (!status) return;
    const text = byId("aiStatusText");
    if (text) text.textContent = label;
    status.dataset.status = stateName || "idle";
    const meta = byId("aiModelLabel");
    const metaByState = {
      idle: "等待出行需求",
      loading: "正在理解需求并调用路线工具",
      ready: "自然语言规划已完成",
      fallback: "本地规则已完成规划",
      unresolved: "等待有效目的地"
    };
    if (meta) meta.textContent = metaByState[stateName] || "AI 能力已接入";
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
  }

  function setPlanningVisibility(hasPlan) {
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
      if (hasPlan) routeSheet.classList.remove("collapsed");
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
    $$('[data-mode]').filter((button) => button.dataset.mode !== "driver").forEach((button) => {
      button.disabled = !hasPlan;
      button.title = hasPlan ? "" : "完成一次 AI 规划后可用";
    });
    if (!hasPlan) {
      setAiReply("");
      setAiStatus("AI 大模型已接入", "idle");
      setText("planHint", "输入自然语言需求，或直接点击体验预设行程。支持全国可驾车目的地。");
    } else {
      setText("planHint", "可修改上方需求或顶部出行状态，再次生成路线与补能方案。");
    }
  }

  function extractDestinationFromInput(value) {
    const text = String(value || "").trim();
    const directMatches = Array.from(text.matchAll(/(?:前往|去|抵达|目的地(?:是)?|到(?!达))\s*([^，,。；;\n]{2,40})/g));
    const direct = String(directMatches.at(-1)?.[1] || "").trim().replace(/(?:然后|并且|最好).*$/, "");
    if (direct) return direct;
    const knownPlaces = ["上海东方明珠广播电视塔", "东方明珠广播电视塔", "东方明珠", "北京大兴国际机场", "大兴国际机场", "大兴机场", "首都国际机场", "首都机场", "北京南站", "北京西站", "北京站", "北京朝阳站", "天津滨海国际机场", "上海虹桥站", "上海浦东国际机场", "广州南站", "深圳北站"];
    return knownPlaces
      .map((place) => ({ place, index: text.lastIndexOf(place) }))
      .filter((item) => item.index >= 0)
      .sort((a, b) => b.index - a.index)[0]?.place || null;
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
      energyType: value.includes("加油") || value.includes("燃油") || value.includes("油车") ? "fuel" : state.energyType,
      priority: value.includes("便宜") || value.includes("省") ? "cost" : value.includes("快") ? "time" : "reliable",
      maxDetourKm: detourMatch ? Math.max(0, Math.min(50, Number(detourMatch[1]))) : null,
      services: ["餐饮", "休息"].filter((service) => value.includes(service)),
      clarificationNeeded: !destination
    };
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
      return `<circle class="forecast-point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"><title>+${points[index].minute || 0} 分钟 · P90 ${value.toFixed(1)} 分钟</title></circle>`;
    }).join("");
    const status = byId("forecastStatus");
    if (status) status.textContent = `模型预测 · ${points.length * 5 - 5} 分钟`;
    const meta = byId("forecastMeta");
    if (meta) {
      const text = meta.querySelector("span") || meta;
      text.textContent = `${entry.model || payload?.model || "可解释队列近似"} · ${entry.explanation || "基于当前负载和到达/服务率估计"}`;
    }
  }

  async function requestForecast(station) {
    if (!station) return;
    const requestId = ++state.forecastRequestVersion;
    const status = byId("forecastStatus");
    if (status) status.textContent = "正在计算…";
    try {
      const payload = await postJson("/api/forecast", {
        stations: [station],
        scenario: { departureMinutes: state.departureMinutes, energyType: state.energyType }
      }, 20000);
      if (requestId === state.forecastRequestVersion && state.selectedStation?.id === station.id) renderForecast(station, payload);
    } catch (error) {
      if (status) status.textContent = "本地演示预测";
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
    if (["electric", "fuel"].includes(parsed.energyType)) state.energyType = parsed.energyType;
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

  function getEnergyProfile(isFuel) {
    return isFuel ? ENERGY_PROFILES.fuel : ENERGY_PROFILES.electric;
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
    const value = Number(record?.targetArrivalSoc ?? 0);
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

  function simulateStation(poi, index) {
    const hash = stableHash(`${poi.id || poi.name}-${index}`);
    const occupancy = 0.42 + (hash % 44) / 100;
    const p50 = 4 + (hash % 10);
    const p90 = p50 + 5 + (hash % 11);
    const isRisk = p90 >= 20 || occupancy >= 0.82;
    return Object.assign({}, poi, {
      source: poi.sourceLabel || (poi.id && !String(poi.id).startsWith("fallback-") ? "高德真实 POI" : "固定场景 POI"),
      occupancy,
      p50,
      p90,
      wait: Math.round((p50 + p90) / 2),
      price: (1.18 + (hash % 58) / 100).toFixed(2),
      // 高德 POI 不提供充电桩额定功率或油枪流速；以下是固定种子的
      // 演示估算，用于比较不同补能方案的时长，页面会明确标识其边界。
      estimatedChargePowerKw: 75 + (hash % 11) * 15,
      estimatedRefuelRateLpm: Number((6 + (hash % 7) * 0.8).toFixed(1)),
      status: isRisk ? "forecast-risk" : "forecast-ready",
      riskLabel: isRisk ? "高峰风险" : "预测可用",
      detour: (0.3 + (hash % 12) / 10).toFixed(1)
    });
  }

  function normalizePoi(poi, index, type) {
    const location = parseLocation(poi.location);
    if (!location) return null;
    const serviceArea = type === "service-area";
    return {
      id: poi.id || `${type}-${index}-${location.join("-")}`,
      name: poi.name || (type === "fuel" ? "综合能源站" : serviceArea ? "高速服务区" : "充电站"),
      address: poi.address || poi.name || "沿线补能站点",
      location,
      type: type === "fuel" ? "加油站" : "充电站",
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

  function extractDrivingRoute(route, key, policy) {
    const rawPath = route.path || (route.steps || []).flatMap((step) => step.path || []);
    const path = rawPath.map(parseLocation).filter(Boolean);
    return {
      key,
      path: path.length > 1 ? path : FALLBACK.routes[key] || FALLBACK.routes.reliable,
      distance: Number(route.distance) > 0 ? Number(route.distance) / 1000 : routeDistance(FALLBACK.routes[key] || FALLBACK.routes.reliable),
      duration: Number(route.time) > 0 ? Number(route.time) / 60 : 80,
      tolls: Number(route.tolls) || 0,
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

  function addAmapEndpoints() {
    if (!state.map || !state.AMap) return;
    const AMap = state.AMap;
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
    const hasResolvedTrip = state.hasPlannedRoute || Boolean(state.baseRouteRecords.reliable);
    state.stationOverlays.push(make(state.origin, "origin-marker", "circle-dot", hasResolvedTrip ? "能链北京总部" : "起点"));
    if (hasResolvedTrip) state.stationOverlays.push(make(state.destination, "destination-marker", "map-pin", state.destinationName));
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

  function queryDriving(key, policy, station) {
    if (station?.location) return queryServerRoute(key, station);
    return new Promise((resolve) => {
      if (!state.AMap) return resolve(null);
      const driving = new state.AMap.Driving({ policy, ferry: 1, map: null, panel: false });
      const done = (status, result) => {
        if (status === "complete" && result && result.routes && result.routes.length) {
          const record = extractDrivingRoute(result.routes[0], key, policy);
          if (station) record.station = station;
          delete state.routeErrors[`${key}:${station ? "waypoint" : "base"}`];
          resolve(record);
        } else {
          state.routeErrors[`${key}:${station ? "waypoint" : "base"}`] = {
            status,
            info: result && (result.info || result.message || result.type) || "unknown",
            result: result ? JSON.stringify(result).slice(0, 500) : null
          };
          resolve(null);
        }
      };
      driving.search(state.origin, state.destination, done);
    });
  }

  function formatRouteCoordinate(point) {
    const longitude = Number(point?.[0]);
    const latitude = Number(point?.[1]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return "";
    return `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
  }

  async function queryServerRoute(key, station) {
    const params = new URLSearchParams({
      origin: formatRouteCoordinate(state.origin),
      destination: formatRouteCoordinate(state.destination),
      waypoint: formatRouteCoordinate(station.location),
      plan: key,
      cartype: state.energyType === "fuel" ? "0" : "1"
    });
    try {
      const response = await fetch(`/api/route?${params}`, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const payload = await response.json();
      const route = payload.route;
      if (!route || !Array.isArray(route.path) || route.path.length < 2) throw new Error("INVALID_ROUTE_RESPONSE");
      delete state.routeErrors[`${key}:waypoint`];
      return Object.assign({}, route, { key, station: Object.assign({}, station, { source: station.source }), routeSource: payload.source });
    } catch (error) {
      state.routeErrors[`${key}:waypoint`] = { status: "error", info: error.message };
      return null;
    }
  }

  async function searchNearby(keyword, center, type) {
    const location = Array.isArray(center) ? center.join(",") : "";
    const serverType = type === "fuel" ? "fuel" : type === "electric" ? "electric" : type === "service-area" ? "service" : null;
    if (location && serverType) {
      try {
        const response = await fetch(`/api/poi?${new URLSearchParams({ location, type: serverType })}`, { headers: { Accept: "application/json" } });
        if (response.ok) {
          const payload = await response.json();
          const pois = Array.isArray(payload.pois) ? payload.pois : [];
          if (pois.length) return pois.map((poi, index) => normalizePoi(poi, index, type)).filter(Boolean);
        }
      } catch {
        // Fall through to the JS map SDK. A failed POI lookup must not turn a
        // valid map/routing session into a fake result.
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

  function pointAtPathProgress(path, progress) {
    if (!Array.isArray(path) || !path.length) return null;
    if (path.length === 1) return path[0];
    const target = Math.max(0, Math.min(1, Number(progress) || 0));
    const lengths = [];
    let total = 0;
    for (let index = 1; index < path.length; index += 1) {
      total += distanceKm(path[index - 1], path[index]);
      lengths.push(total);
    }
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
    const profile = getEnergyProfile(state.energyType === "fuel");
    const fullRange = profile.capacity / profile.consumptionPerKm;
    const spacingKm = Math.max(55, Math.min(120, Math.round(fullRange * 0.45)));
    const routeDistanceKm = Math.max(0, Number(totalDistanceKm) || routeDistance(path));
    const count = Math.max(3, Math.min(12, Math.ceil(routeDistanceKm / spacingKm) + 1));
    return Array.from({ length: count }, (_, index) => pointAtPathProgress(path, index / Math.max(1, count - 1))).filter(Boolean);
  }

  async function searchInBatches(tasks, batchSize = 4) {
    const results = [];
    for (let index = 0; index < tasks.length; index += batchSize) {
      const batch = tasks.slice(index, index + batchSize);
      const settled = await Promise.all(batch.map((task) => task()));
      results.push(...settled);
    }
    return results;
  }

  async function queryStations() {
    if (!state.AMap) return;
    state.provisionalCorridorActive = false;
    const route = state.baseRouteRecords.reliable || state.routeRecords.reliable || { path: FALLBACK.routes.reliable };
    const path = route.path;
    const centers = stationSearchCenters(path, route.distance);
    const primaryKeyword = state.energyType === "fuel" ? "加油站" : "充电站";
    const primaryType = state.energyType === "fuel" ? "fuel" : "electric";
    const stationTasks = centers.flatMap((center) => {
      const tasks = [() => searchNearby(primaryKeyword, center, primaryType)];
      // Many cross-province motorway points have no POI explicitly named
      // “充电站”. A real 高德服务区 is a truthful fallback candidate; its
      // availability is explicitly labelled as needing on-site confirmation.
      if (primaryType === "electric") tasks.push(() => searchNearby("服务区", center, "service-area"));
      return tasks;
    });
    const resultSets = await searchInBatches(stationTasks);
    // Keep a small, even sample from every point along the route rather than
    // filling the candidate pool with the first cities near the origin. This
    // matters for cross-province itineraries where the last third otherwise
    // never reaches the long-trip planner.
    const stagedPois = [];
    resultSets.forEach((set) => dedupePois(set).slice(0, 3).forEach((poi) => stagedPois.push(poi)));
    const corridorPois = dedupePois(stagedPois).filter((poi) => nearestPointDistance(poi.location, path) < 22);
    const selected = dedupePois(corridorPois).slice(0, 36);
    state.stations = selected.map((poi, index) => {
      const station = simulateStation(poi, index);
      const progress = routeProgress(station.location, path);
      const corridorKm = nearestPointDistance(station.location, path);
      return Object.assign(station, {
        routeProgress: Number(progress.toFixed(4)),
        progressKm: Number((progress * (Number(route.distance) || routeDistance(path))).toFixed(1)),
        corridorKm: Number(corridorKm.toFixed(1)),
        detourKm: Number(Math.max(0.4, corridorKm * 2 + 0.3).toFixed(1)),
        detour: Number(Math.max(0.4, corridorKm * 2 + 0.3).toFixed(1)).toString()
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

  function chooseStationForRouteExcluding(routeKey, excludedIds) {
    const route = state.routeRecords[routeKey] || state.routeRecords.reliable;
    if (!route || !state.stations.length) return null;
    const direct = directEnergyState(state.baseRouteRecords[routeKey] || route, state.energyType === "fuel");
    if (direct.canDirect) return null;
    const desiredType = state.energyType === "fuel" ? "加油站" : "充电站";
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
        if (routeKey === "cheapest") return corridor * 0.8 + progress * 1.5 + Number(station.price) * 35 + station.p90 * 0.015 + rescueBias;
        return corridor * 0.9 + station.p90 * 1.15 + station.occupancy * 5 + progress * 1.5 + rescueBias;
      };
      const scoreA = routeScore(a);
      const scoreB = routeScore(b);
      return scoreA - scoreB;
    });
    return sorted[0] || null;
  }

  function chooseDistinctStations() {
    const selected = {};
    const used = new Set();
    ["fastest", "reliable"].forEach((key) => {
      const station = chooseStationForRouteExcluding(key, used);
      if (station) {
        selected[key] = station;
        used.add(station.id);
      }
    });
    const cheapest = chooseStationForRouteExcluding("cheapest", new Set());
    if (cheapest) selected.cheapest = cheapest;
    return selected;
  }

  async function queryServerLeg(key, origin, destination) {
    const params = new URLSearchParams({
      origin: formatRouteCoordinate(origin),
      destination: formatRouteCoordinate(destination),
      plan: key,
      cartype: state.energyType === "fuel" ? "0" : "1"
    });
    let lastError = null;
    // Long trips require several independent road requests. AMap can return a
    // transient 502 when several legs arrive at once, so retry once before
    // treating a POI as unroutable. This never converts a failed request into
    // a route; only a complete, valid response is accepted.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`/api/route?${params}`, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const payload = await response.json();
        const route = payload.route;
        if (!route || !Array.isArray(route.path) || route.path.length < 2) throw new Error("INVALID_ROUTE_RESPONSE");
        return route;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 220));
      }
    }
    state.routeErrors[`${key}:long-trip`] = { status: "error", info: lastError?.message || "ROUTE_UNAVAILABLE" };
    return null;
  }

  async function queryRouteSequence(key, stops) {
    const locations = [state.origin].concat(stops.map((station) => station.location), [state.destination]);
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
      distance: legs.reduce((sum, leg) => sum + Number(leg.distance || 0), 0),
      duration: legs.reduce((sum, leg) => sum + Number(leg.duration || 0), 0),
      tolls: legs.reduce((sum, leg) => sum + Number(leg.tolls || 0), 0),
      source: "高德逐段路线核验"
    };
  }

  function longTripChargeMinutes(amount, station) {
    if (amount <= 1e-6) return 0;
    if (state.energyType === "fuel") {
      const rate = Math.max(3, Math.min(16, Number(station?.estimatedRefuelRateLpm) || 8));
      return Math.max(4, Math.ceil(amount / rate + 2));
    }
    const power = Math.max(50, Math.min(300, Number(station?.estimatedChargePowerKw) || 110));
    return Math.max(4, Math.ceil(amount / power * 60 + 3));
  }

  function effectiveLongTripDetourLimit(baseRoute) {
    if (state.detourExplicit) return state.maxDetourKm;
    const baseDistanceKm = Math.max(0, Number(baseRoute?.distance || 0));
    // Eight kilometres is appropriate for an urban or explicitly constrained
    // trip. A cross-province route needs a small proportional allowance for
    // joining motorway service areas; cap it at 30 km and surface the actual
    // value in the route evidence.
    return Math.max(state.maxDetourKm, Math.min(30, baseDistanceKm * 0.015));
  }

  function buildValidatedLongTripRecord(key, baseRoute, route, waypoints, servicePlan = null) {
    const profile = getEnergyProfile(state.energyType === "fuel");
    const targetArrivalSoc = effectiveArrivalReserveSoc(profile);
    const targetEnergy = profile.capacity * targetArrivalSoc / 100;
    const safetyEnergy = profile.capacity * profile.safetyReservePercent / 100;
    // The reliable option uses a simulated slot-reservation / staggered-arrival
    // policy. It trades a small coordination overhead for a lower P90 queue
    // risk; the current route may still share the same safe road corridor.
    const reservationMinutesPerStop = key === "reliable" ? 4 : 0;
    const legs = route.legs || [];
    if (legs.length !== waypoints.length + 1) return null;
    let energy = profile.capacity * state.energyPercent / 100;
    let totalAmount = 0;
    let chargeMinutes = 0;
    let p50Wait = 0;
    let p90Wait = 0;
    let energyCost = 0;
    let elapsedMinutes = 0;
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
      const station = waypoint;
      const canReachStation = energy >= safetyEnergy - 1e-6;
      const nextEnergyIndex = waypoints.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.kind !== "service");
      const endLegIndex = nextEnergyIndex < 0 ? legs.length : nextEnergyIndex + 1;
      const travelToNextEnergyOrDestination = legs.slice(index + 1, endLegIndex).reduce((sum, leg) => sum + Number(leg.distance || 0), 0);
      const neededAfterStop = travelToNextEnergyOrDestination * profile.consumptionPerKm + (nextEnergyIndex < 0 ? targetEnergy : safetyEnergy);
      const capacityAvailable = Math.max(0, profile.capacity - Math.max(0, energy));
      const requestedAmount = Math.max(0, (neededAfterStop - energy) / profile.transferEfficiency);
      let amount = canReachStation ? Math.min(requestedAmount, capacityAvailable / profile.transferEfficiency) : 0;
      // When the current station is cheaper than every downstream stop, buy
      // more here (within capacity) and avoid the later, higher simulated
      // price. This is the energy-side part of the lowest-cost strategy.
      const laterEnergyStops = waypoints.slice(index + 1).filter((candidate) => candidate.kind !== "service");
      const currentPrice = Math.max(0, Number(station.price || 0));
      const laterLowestPrice = Math.min(...laterEnergyStops.map((candidate) => Math.max(0, Number(candidate.price || 0))), Infinity);
      if (key === "cheapest" && laterEnergyStops.length && currentPrice > 0 && currentPrice < laterLowestPrice) {
        amount = Math.max(amount, capacityAvailable / profile.transferEfficiency);
      }
      const targetMetAtStop = energy + amount * profile.transferEfficiency >= neededAfterStop - 1e-6;
      const arrivalSoc = Math.max(0, Math.min(100, energy / profile.capacity * 100));
      energy += amount * profile.transferEfficiency;
      const stationChargeMinutes = longTripChargeMinutes(amount, station);
      totalAmount += amount;
      chargeMinutes += stationChargeMinutes;
      const rawP50 = Math.max(0, Number(station.p50 || station.wait || 0));
      const rawP90 = Math.max(0, Number(station.p90 || station.wait || 0));
      const plannedP50 = key === "reliable" ? rawP50 * 0.68 : rawP50;
      const plannedP90 = key === "reliable" ? rawP90 * 0.58 : rawP90;
      p50Wait += plannedP50;
      p90Wait += plannedP90;
      energyCost += amount * Math.max(0, Number(station.price || 0));
      stops.push(Object.assign({}, station, {
        sequence: index + 1,
        legDistanceKm: Number(legDistance.toFixed(1)),
        arrivalSoc: Number(arrivalSoc.toFixed(1)),
        targetSoc: Number((energy / profile.capacity * 100).toFixed(1)),
        energyAmount: Number(amount.toFixed(1)),
        chargeMinutes: stationChargeMinutes,
        arrivalMinute: Math.round(state.departureMinutes + elapsedMinutes),
        canReachStation,
        targetMetAtStop,
        energyCost: Number((amount * currentPrice).toFixed(1)),
        plannedP50: Number(plannedP50.toFixed(1)),
        plannedP90: Number(plannedP90.toFixed(1))
      }));
      elapsedMinutes += plannedP50 + stationChargeMinutes + reservationMinutesPerStop;
      if (!canReachStation || !targetMetAtStop) break;
    }
    const finalLeg = Number(legs.at(-1)?.distance || 0);
    energy -= finalLeg * profile.consumptionPerKm;
    const arrivalSoc = Math.max(0, Math.min(100, energy / profile.capacity * 100));
    const detour = Math.max(0, Number(route.distance || 0) - Number(baseRoute?.distance || 0));
    const detourLimitKm = effectiveLongTripDetourLimit(baseRoute);
    const detourWithinLimit = detour <= detourLimitKm + 1e-6;
    const energyWaypointCount = waypoints.filter((waypoint) => waypoint.kind !== "service").length;
    const canReachAllStops = stops.length === energyWaypointCount && stops.every((stop) => stop.canReachStation && stop.targetMetAtStop);
    const targetSocMet = energy >= targetEnergy - 1e-6;
    const wait = Math.round(p50Wait);
    const serviceMinutes = Math.max(0, Number(servicePlan?.durationMinutes || 0));
    const overlapMinutes = servicePlan?.inlineStationId
      ? Math.min(serviceMinutes, Math.max(0, (stops.find((stop) => stop.id === servicePlan.inlineStationId)?.chargeMinutes || 0) + (stops.find((stop) => stop.id === servicePlan.inlineStationId)?.p50 || 0)))
      : 0;
    const serviceExtraMinutes = Math.max(0, serviceMinutes - overlapMinutes);
    const reservationMinutes = reservationMinutesPerStop * stops.length;
    const total = Number(route.duration || 0) + wait + chargeMinutes + reservationMinutes + serviceExtraMinutes;
    const p90Total = Number(route.duration || 0) + Math.round(p90Wait) + chargeMinutes + reservationMinutes + serviceExtraMinutes;
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
      station: stops[0] || null,
      stops,
      stopCount: stops.length,
      multiStop: stops.length > 1,
      servicePlan: servicePlan ? Object.assign({}, servicePlan, { extraMinutes: Math.round(serviceExtraMinutes) }) : null,
      wait,
      p50Wait: Math.round(p50Wait),
      p90Wait: Math.round(p90Wait),
      chargeMinutes,
      reservationMinutes,
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
      strategyReservation: key === "reliable"
    });
  }

  async function requestLongTripPlans() {
    const base = state.baseRouteRecords.reliable || state.routeRecords.reliable;
    if (!base || !Number.isFinite(Number(base.distance))) return null;
    // Once route verification has proved that public POI coverage is too sparse,
    // plan only with the explicit corridor anchors. Mixing the original sparse
    // POIs back in can repeatedly select an unverified urban station instead.
    const planningStations = state.provisionalCorridorActive
      ? state.stations.filter((station) => station.provisionalCorridor)
      : state.stations;
    try {
      const proposal = await postJson("/api/longtrip", {
        distanceKm: base.distance,
        durationMinutes: base.duration,
        stations: planningStations,
        energyType: state.energyType,
        soc: state.energyPercent,
        minArrivalSoc: effectiveArrivalReserveSoc(getEnergyProfile(state.energyType === "fuel")),
        maxStops: 6,
        maxDetourKm: effectiveLongTripDetourLimit(base)
      }, 20000);
      return proposal;
    } catch {
      return null;
    }
  }

  function injectProvisionalCorridorStations() {
    const base = state.baseRouteRecords.reliable || state.routeRecords.reliable;
    if (!base?.path?.length || !Number.isFinite(Number(base.distance)) || state.stations.some((station) => station.provisionalCorridor)) return 0;
    const profile = getEnergyProfile(state.energyType === "fuel");
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
    let desiredProgress = Math.max(28, Math.min(totalDistanceKm - maxFinalLeg, initialSafeRange * 0.7));
    while (totalDistanceKm - previousProgress > maxFinalLeg && generated.length < 6) {
      const reachableLimit = previousProgress === 0 ? initialSafeRange : fullSafeRange;
      const progressKm = Math.min(desiredProgress, totalDistanceKm - maxFinalLeg);
      const location = pointAtPathProgress(base.path, progressKm / totalDistanceKm);
      if (!location || progressKm <= previousProgress + 5) break;
      const sequence = generated.length + 1;
      const candidate = simulateStation({
        id: `provisional-${state.energyType}-${Math.round(progressKm)}-${sequence}`,
        name: `沿线补能候选点 ${sequence}`,
        address: "路线补能兜底候选 · 请在出发前确认现场设备",
        location,
        type: state.energyType === "fuel" ? "加油站" : "充电站",
        sourceLabel: "路线补能兜底候选 · 演示，需确认"
      }, 900 + sequence);
      generated.push(Object.assign(candidate, {
        provisionalCorridor: true,
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

  function decorateLongTripRecord(role, record, extra = {}) {
    const names = { fastest: "最快到达", reliable: "最稳妥", cheapest: "最低成本" };
    return Object.assign({}, record, { key: role, candidateKey: role, displayName: names[role] }, extra);
  }

  async function replanLongTripRoutes() {
    let proposal = await requestLongTripPlans();
    // AMap can return no publicly indexed charger for a long motorway section.
    // Rather than declare that six charges cannot cover the distance, introduce
    // explicitly-labelled provisional corridor anchors and run the same energy
    // and real-road checks again. These anchors are never presented as a real
    // station or real-time availability signal.
    if (proposal?.reason === "NO_FEASIBLE_SEQUENCE" && injectProvisionalCorridorStations()) {
      proposal = await requestLongTripPlans();
    }
    // The long-trip evaluator deliberately includes a zero-stop candidate
    // when the destination is already reachable. Do not discard that direct
    // result and then manufacture a 0 kWh station visit from an overflow
    // candidate; let the normal direct-route branch render “无需补能”.
    if (Array.isArray(proposal?.plans) && proposal.plans.some((plan) => Number(plan.stopCount || 0) === 0)) return false;
    const plans = Array.isArray(proposal?.plans) ? proposal.plans.filter((plan) => Number(plan.stopCount || 0) >= 1) : [];
    if (!plans.length) {
      if (proposal?.reason) {
        state.multiStopPlanningMeta = {
          candidatesConsidered: proposal.candidatesConsidered || 0,
          maxStops: proposal.maxStops || 6,
          reason: proposal.reason,
          failure: proposal.reason === "NO_FEASIBLE_SEQUENCE"
            ? `已检索 ${proposal.candidatesConsidered || 0} 个沿线真实补能站；在到达余量和绕行约束下，最多 ${proposal.maxStops || 6} 次补能仍无法形成安全全程方案。`
            : "多站补能候选未能完成计算。"
        };
        return "no-feasible-sequence";
      }
      return false;
    }
    const roles = ["fastest", "reliable", "cheapest"];
    const plansByObjective = proposal?.plansByObjective && typeof proposal.plansByObjective === "object" ? proposal.plansByObjective : {};
    const validated = {};
    const routedBackup = {};
    for (let index = 0; index < roles.length; index += 1) {
      const role = roles[index];
      // Candidate estimates are screened again with the actual road geometry.
      // A station sequence that works on a corridor approximation may fail on
      // a particular road policy, so try the objective's plan first and then
      // safe alternatives instead of declaring the whole trip impossible.
      const candidates = [
        plansByObjective[role],
        plans.find((candidate) => candidate.objective === role),
        plans[index],
        ...plans,
        ...Object.values(plansByObjective)
      ].filter(Boolean);
      const seen = new Set();
      for (const plan of candidates) {
        const signature = (plan.stops || []).map((stop) => stop.id).join("|") || "direct";
        if (seen.has(signature)) continue;
        seen.add(signature);
        const stops = (plan.stops || []).map((stop) => state.stations.find((station) => String(station.id) === String(stop.id))).filter(Boolean);
        if (stops.length !== plan.stopCount) continue;
        const base = state.baseRouteRecords[role] || state.baseRouteRecords.reliable;
        // A generated corridor anchor can lie on a motorway centre line and
        // therefore cannot always be used as a road-routing endpoint. Its
        // energy sequence is still calculated from the verified AMap main
        // route, but it is explicitly marked as a provisional stop rather
        // than being presented as a real charging facility.
        const route = state.provisionalCorridorActive && stops.every((station) => station.provisionalCorridor)
          ? buildProvisionalCorridorRoute(role, base, plan, stops)
          : await queryRouteSequence(role, stops);
        const record = route && buildValidatedLongTripRecord(role, base, route, stops.map((station) => Object.assign({}, station, { kind: "energy" })));
        if (record && !routedBackup[role]) routedBackup[role] = record;
        if (record?.feasible) {
          validated[role] = record;
          break;
        }
      }
    }
    const available = Object.values(validated).filter((record) => record.feasible);
    if (!available.length) {
      // Some city-search POIs look feasible in corridor distance but fail once
      // their actual motorway approach is routed. Treat that exactly like an
      // empty corridor: add explicitly-labelled planning anchors and retry
      // before reporting that the long trip has no safe route.
      if (!state.provisionalCorridorActive && injectProvisionalCorridorStations()) {
        return replanLongTripRoutes();
      }
      state.multiStopPlanningMeta = {
        candidatesConsidered: proposal.candidatesConsidered || 0,
        maxStops: proposal.maxStops || 6,
        reason: "ROUTE_VERIFICATION_FAILED",
        failure: "多站候选未通过逐段真实路线核验，系统未将其展示为可执行方案。"
      };
      return "verification-failed";
    }
    let fastest = validated.fastest || available.slice().sort((a, b) => a.arrival - b.arrival || a.chargeMinutes - b.chargeMinutes || a.p50Wait - b.p50Wait || a.cost - b.cost)[0];
    let reliable = validated.reliable || available.slice().sort((a, b) => a.p90Total - b.p90Total || b.arrivalSoc - a.arrivalSoc || a.p90Wait - b.p90Wait || a.arrival - b.arrival)[0];
    const replayStrategy = (record, strategy) => {
      if (!record?.stops?.length) return null;
      const base = state.baseRouteRecords[strategy] || state.baseRouteRecords.reliable;
      const waypoints = record.stops.map((station) => Object.assign({}, station, { kind: "energy" }));
      return buildValidatedLongTripRecord(strategy, base, record, waypoints);
    };
    // If only one road corridor survives verification, keep its verified
    // geometry but make the operational strategies genuinely different.
    if (fastest?.strategyReservation) {
      const replay = replayStrategy(fastest, "fastest");
      if (replay?.feasible) fastest = replay;
    }
    if (!reliable?.strategyReservation) {
      const replay = replayStrategy(reliable || fastest, "reliable");
      if (replay?.feasible) reliable = replay;
    }
    // The least-fee road can honestly be a backup: on long national journeys
    // it may avoid tolls but violate the user's arrival deadline. Keep that
    // trade-off visible instead of cloning the highway route into this card.
    let cheapest = validated.cheapest || routedBackup.cheapest || available.slice().sort((a, b) => a.cost - b.cost || a.roadTolls - b.roadTolls || a.arrival - b.arrival)[0];
    // If the low-fee road fails the deadline or maps back to the same motorway
    // corridor, preserve the safe road but model the remaining cost lever:
    // tariff-aware charging / station coupon. It is explicitly an estimate,
    // not a claim that the displayed POI has a live public price feed.
    if (!cheapest || cheapest === fastest || Number(cheapest.cost) >= Number(fastest.cost) - 0.01) {
      const tariffFactor = 0.88;
      const discountedEnergyCost = Number((Number(fastest.energyCost || 0) * tariffFactor).toFixed(1));
      cheapest = Object.assign({}, fastest, {
        key: "cheapest",
        candidateKey: "cheapest",
        stops: (fastest.stops || []).map((stop) => Object.assign({}, stop, { energyCost: Number((Number(stop.energyCost || 0) * tariffFactor).toFixed(1)) })),
        energyCost: discountedEnergyCost,
        cost: Number((discountedEnergyCost + Number(fastest.roadTolls || 0)).toFixed(1)),
        tariffAwarePricing: true
      });
    }
    const preferred = ["cost", "cheapest"].includes(state.priority) ? "cheapest" : ["time", "fastest"].includes(state.priority) ? "fastest" : "reliable";
    state.multiStopRouteRecords = {
      fastest: decorateLongTripRecord("fastest", fastest, { isActualFastest: true, isActualStable: fastest === reliable, isActualCheapest: fastest === cheapest, recommended: preferred === "fastest" }),
      reliable: decorateLongTripRecord("reliable", reliable, { isActualFastest: reliable === fastest, isActualStable: true, isActualCheapest: reliable === cheapest, recommended: preferred === "reliable" }),
      cheapest: decorateLongTripRecord("cheapest", cheapest, { isActualFastest: cheapest === fastest, isActualStable: cheapest === reliable, isActualCheapest: true, recommended: preferred === "cheapest", costBackup: !cheapest.feasible })
    };
    state.multiStopPlanningMeta = {
      candidatesConsidered: proposal.candidatesConsidered,
      maxStops: proposal.maxStops,
      uniqueStopPlans: new Set(Object.values(plansByObjective).map((plan) => (plan?.stops || []).map((stop) => stop.id).join("|"))).size
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
      const direct = calculateEnergyPlan(Object.assign({}, base, { station: null }), key, state.energyType === "fuel");
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
        const energy = calculateEnergyPlan(candidate, key, state.energyType === "fuel");
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
    const route = state.baseRouteRecords.reliable || state.routeRecords.reliable || { path: FALLBACK.routes.reliable };
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
      state.routeRecords = state.multiStopRouteRecords;
      const preferred = Object.entries(state.routeRecords).find(([, record]) => record.recommended)?.[0] || "reliable";
      state.recommendedRoute = preferred;
      return;
    }
    const candidates = Object.keys(state.routeCandidates || {}).length ? state.routeCandidates : state.routeRecords;
    const base = candidates.reliable || fallbackRoutes().reliable;
    const isFuel = state.energyType === "fuel";
    const make = (candidateKey, record, station, costFactor) => {
      const route = Object.assign({}, record || base, { station: station || null });
      const energyPlan = calculateEnergyPlan(route, candidateKey, isFuel);
      const hasStop = energyPlan.requiresStop && energyPlan.canReachStation;
      const wait = hasStop ? Math.max(3, Number(station?.wait) || 5) : 0;
      const total = route.duration + wait + (hasStop ? energyPlan.chargeMinutes : 0);
      const arrival = state.departureMinutes + total;
      const lateMinutes = hasArrivalDeadline() ? Math.max(0, Math.ceil(arrival - state.deadlineMinutes)) : 0;
      const onTime = Math.max(55, Math.min(99, 98 - lateMinutes * 3 - (Number(station?.p90) || 10) * 0.2));
      const energyCost = hasStop ? Number(station?.price) * energyPlan.amount : 0;
      const routeCost = route.distance * 0.08 * costFactor;
      const serviceCost = energyPlan.chargeMinutes * 0.15;
      const cost = Math.max(20, energyCost + routeCost + serviceCost);
      return Object.assign({}, route, {
        key: candidateKey,
        candidateKey,
        station: station || null,
        wait,
        total,
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
      make("fastest", candidates.fastest || base, candidates.fastest?.station, isFuel ? 1.65 : 1.08),
      make("reliable", candidates.reliable || base, candidates.reliable?.station, isFuel ? 1.55 : 1.0),
      make("cheapest", candidates.cheapest || base, candidates.cheapest?.station, isFuel ? 1.4 : 0.82)
    ];
    const feasibleFirst = (a, b) => Number(b.feasible) - Number(a.feasible);
    const sortFast = (a, b) => feasibleFirst(a, b) || a.arrival - b.arrival || a.cost - b.cost;
    const sortStable = (a, b) => feasibleFirst(a, b) || (a.station?.p90 || 0) - (b.station?.p90 || 0) || b.onTime - a.onTime || a.arrival - b.arrival;
    const sortCheap = (a, b) => feasibleFirst(a, b) || a.cost - b.cost || a.arrival - b.arrival;
    const actualFastest = raw.slice().sort(sortFast)[0];
    const actualStable = raw.slice().sort(sortStable)[0];
    const actualCheap = raw.slice().sort(sortCheap)[0];
    const used = new Set();
    const take = (preferred, sorter) => {
      const available = raw.filter((record) => !used.has(record.candidateKey));
      const choice = (available.includes(preferred) ? preferred : available.slice().sort(sorter)[0]) || preferred;
      used.add(choice.candidateKey);
      return choice;
    };
    const fastest = take(actualFastest, sortFast);
    const stableCollision = actualStable.candidateKey === fastest.candidateKey;
    const stable = take(actualStable, sortStable);
    const cheapCollision = actualCheap.candidateKey === fastest.candidateKey || actualCheap.candidateKey === stable.candidateKey;
    const cheap = take(actualCheap, sortCheap);
    const fastestIsStable = actualStable.candidateKey === fastest.candidateKey;
    const fastestIsCheap = actualCheap.candidateKey === fastest.candidateKey;
    const stableIsCheap = actualCheap.candidateKey === stable.candidateKey;
    const decorate = (role, record, displayName, extra) => Object.assign({}, record, { key: role, displayName }, extra || {});
    state.routeRecords = {
      fastest: decorate("fastest", fastest, fastestIsStable && fastestIsCheap ? "全优方案" : fastestIsStable ? "最快且最稳" : fastestIsCheap ? "最快且最省" : "最快到达", { isActualFastest: true, isActualStable: fastestIsStable, isActualCheapest: fastestIsCheap }),
      reliable: decorate("reliable", stable, stableCollision && stableIsCheap ? "最低成本" : stableCollision ? "路线备选" : stableIsCheap ? "最稳且最省" : "最稳妥", { isActualFastest: false, isActualStable: !stableCollision, isActualCheapest: stableIsCheap, stableCollision }),
      cheapest: decorate("cheapest", cheap, cheapCollision ? "路线备选" : "最低成本", { isActualFastest: false, isActualStable: false, isActualCheapest: !cheapCollision, costBackup: cheapCollision })
    };
    Object.entries(state.serviceRouteOverrides || {}).forEach(([role, override]) => {
      if (!state.routeRecords[role]) return;
      state.routeRecords[role] = Object.assign({}, state.routeRecords[role], override, {
        key: role,
        candidateKey: role,
        displayName: state.routeRecords[role].displayName
      });
    });
    const roleForCandidate = (candidateKey) => Object.entries(state.routeRecords).find(([, record]) => record.candidateKey === candidateKey)?.[0] || "reliable";
    const preferredRole = ["cost", "cheapest"].includes(state.priority)
      ? roleForCandidate(actualCheap.candidateKey)
      : ["time", "fastest"].includes(state.priority)
        ? roleForCandidate(actualFastest.candidateKey)
        : roleForCandidate(actualStable.candidateKey);
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
    if (name) name.textContent = record.displayName || { fastest: "最快到达", reliable: "最稳妥", cheapest: "最低成本" }[record.key];
    if (strong) strong.textContent = formatClock(record.arrival);
    if (metrics) {
      metrics.innerHTML = record.directTrip
        ? `<span>用时 <b>${formatDuration(record.total)}</b></span><span>直达 <b>无需补能</b></span><span>到达 <b>${record.arrivalSoc}%</b></span><span>成本 <b>¥${Math.round(record.cost)}</b></span>`
        : record.serviceOnly
          ? `<span>用时 <b>${formatDuration(record.total)}</b></span><span>服务 <b>${record.servicePlan?.name || "已加入"}</b></span><span>到达 <b>${record.arrivalSoc}%</b></span><span>${state.deadlineEnabled ? "准时" : "安全余量"} <b>${state.deadlineEnabled ? `${Math.round(record.onTime)}%` : `${record.targetArrivalSoc}%`}</b></span>`
        : record.multiStop
            ? `<span>用时 <b>${formatDuration(record.total)}</b></span><span>补能 <b>${record.stopCount} 次</b></span><span>绕行 <b>${Number(record.detour || 0).toFixed(1)}km</b></span><span>P90 <b>${record.p90Wait}分</b></span><span>费用 <b>¥${Math.round(record.cost)}</b></span><span>${state.deadlineEnabled ? "准时" : "安全余量"} <b>${state.deadlineEnabled ? `${Math.round(record.onTime)}%` : `${record.targetArrivalSoc}%`}</b></span>`
            : `<span>用时 <b>${formatDuration(record.total)}</b></span><span>绕行 <b>${Number(record.detour || 0).toFixed(1)}km</b></span><span>P50 <b>${record.station?.p50 ?? "—"}分</b></span><span>P90 <b>${record.station?.p90 ?? "—"}分</b></span><span>成本 <b>¥${Math.round(record.cost)}</b></span><span>${state.deadlineEnabled ? "准时" : "安全余量"} <b>${state.deadlineEnabled ? `${Math.round(record.onTime)}%` : `${record.targetArrivalSoc}%`}</b></span>`;
    }
    if (tag) {
      if (record.directTrip) tag.textContent = "无需补能";
      else if (record.serviceOnly) tag.textContent = "服务已加入";
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
    if (stationLine) stationLine.textContent = record.directTrip
      ? `无需${state.energyType === "fuel" ? "加油" : "补能"} · 直达 ${state.destinationName} · 到达 ${record.arrivalSoc}%`
      : record.serviceOnly
        ? `服务停靠 · ${record.servicePlan?.name || "沿线服务"} · ETA 已按真实路线重算`
      : record.multiStop
        ? `连续${state.energyType === "fuel" ? "加油" : "补能"} ${record.stopCount} 次 · ${record.stops.map((stop) => stop.name).join(" → ")} · 到达 ${record.arrivalSoc}%`
      : !record.canReachStation
        ? (record.planningFailure || `当前余量不足以安全抵达候选${state.energyType === "fuel" ? "加油站" : "充电站"} · 不建议执行`)
        : `${state.energyType === "fuel" ? "加油" : "补能"} ${record.energyAmount}${record.energyUnit} · ${record.station?.name || "未匹配站点"} · 到达 ${record.arrivalSoc}%`;
    if (reason) {
      if (record.directTrip) {
        reason.textContent = `当前${state.energyType === "fuel" ? "油量" : "电量"}可满足${arrivalReserveDescription(record)}，不引入额外补能停靠。`;
        return;
      }
      if (record.serviceOnly) {
        reason.textContent = `已加入 ${record.servicePlan?.name || "沿线服务"} · 预计额外 ${record.servicePlan?.extraMinutes || 0} 分钟 · 到达余量 ${record.arrivalSoc}%。`;
        return;
      }
      if (record.multiStop) {
        if (!record.feasible) {
          reason.textContent = record.key === "cheapest"
            ? `高德低费用道路可将通行费降至 ¥${Math.round(record.roadTolls || 0)}，但预计晚到 ${record.lateMinutes} 分钟，不建议在当前时限下执行。`
            : `该补能策略未同时满足时限、到达余量或绕行约束，已保留为风险备选。`;
          return;
        }
        const summaries = {
          fastest: `高德时间优先道路 + 典型等待与补能时长最短；总等待 P50 ${record.p50Wait} 分钟。`,
          reliable: `采用错峰预约模拟，P90 等待降至 ${record.p90Wait} 分钟；为此增加 ${record.reservationMinutes || 0} 分钟到站协调时间。`,
          cheapest: record.tariffAwarePricing
            ? `当前时限下保留同一安全道路走廊，补能采用低价时段/优惠价模拟；费用 ¥${Math.round(record.cost)} = 补能 ¥${Math.round(record.energyCost || 0)} + 高德通行费 ¥${Math.round(record.roadTolls || 0)}。`
            : `费用 ¥${Math.round(record.cost)} = 补能 ¥${Math.round(record.energyCost || 0)} + 高德通行费 ¥${Math.round(record.roadTolls || 0)}；优先在较低模拟站价处补能。`
        };
        reason.textContent = summaries[record.key] || `已逐段核验 ${record.stopCount} 次${state.energyType === "fuel" ? "加油" : "补能"}：总等待 P90 ${record.p90Wait} 分钟。`;
        return;
      }
      if (!record.canReachStation) {
        reason.textContent = record.planningFailure || "候选站首段路程超出当前安全可达距离，已拦截该方案。";
        return;
      }
      if (!record.detourWithinLimit) {
        reason.textContent = `实际绕行 ${Number(record.detour || 0).toFixed(1)} km，超过“绕行≤${state.maxDetourKm} km”约束。`;
        return;
      }
      const reasons = {
        fastest: `最终 ETA 最早 · 额外 ${record.station.detour} km · ${record.station.riskLabel}`,
        reliable: record.isActualCheapest ? `总成本最低 ¥${Math.round(record.cost)} · P90 ${record.station.p90} 分钟 · ${Math.round(record.onTime)}% 准时` : record.stableCollision ? `路线与站点的可解释备选 · P90 ${record.station.p90} 分钟 · ${Math.round(record.onTime)}% 准时` : record.feasible ? `P90 ${record.station.p90} 分钟 · 负载 ${(record.station.occupancy * 100).toFixed(0)}% · ${Math.round(record.onTime)}% 准时` : `风险备选，但超过到达时限 ${record.lateMinutes} 分钟`,
        cheapest: record.costBackup ? `路线与站点的可解释备选 · 绕行 ${record.station.detour} km · P90 ${record.station.p90} 分钟` : record.feasible ? `总成本最低 · 绕行 ${record.station.detour} km · 预计节省 ¥${Math.max(1, Math.round(state.routeRecords.fastest.cost - record.cost))}` : `成本备选，但超过到达时限，不建议执行`
      };
      reason.textContent = reasons[record.key];
    }
  }

  function renderRouteCards() {
    calculateRouteRecords();
    if (!state.routeSelectionTouched) state.selectedRoute = state.recommendedRoute || "reliable";
    const current = state.routeRecords[state.selectedRoute];
    if (!state.routeSelectionTouched && !current?.feasible) {
      const fallback = Object.values(state.routeRecords).filter((record) => record.feasible).sort((a, b) => a.arrival - b.arrival)[0];
      if (fallback) state.selectedRoute = fallback.key;
    }
    $$(".route-option").forEach((button) => setOptionText(button, state.routeRecords[button.dataset.route]));
    $$(".route-option").forEach((button) => button.classList.toggle("selected", button.dataset.route === state.selectedRoute));
    const feasibleCount = Object.values(state.routeRecords).filter((record) => record.feasible).length;
    const heading = $(".sheet-heading h2");
    if (heading) heading.textContent = feasibleCount === 3 ? "3 条可行方案" : `${feasibleCount} 条可行 · ${3 - feasibleCount} 条备用`;
    renderActiveRouteSummary();
    updateInsight(state.routeRecords[state.selectedRoute]);
    syncArrivalPayment();
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
    state.paymentReceipt = {
      stationId: target.station.id,
      stationName: target.station.name,
      amount: target.amount,
      createdAt: Date.now()
    };
    syncArrivalPayment();
    showToast(`车牌 ${state.vehiclePlate} 已在 ${target.station.name} 完成识别，模拟扣款 ¥${target.amount.toFixed(1)}`, 4200);
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
      summary.innerHTML = `<span>${record.displayName || "推荐方案"}</span><strong>连续补能 ${record.stopCount} 次</strong><small>${formatClock(record.arrival)} 到达 · 余量 ${record.arrivalSoc}%</small>`;
      return;
    }
    if (!record.station) {
      const title = record.planningFailure ? "未生成虚假的长途补能路线" : "未找到安全可达补能站";
      const hint = record.planningFailure || `请提高当前${state.energyType === "fuel" ? "油量" : "电量"}或放宽绕行约束`;
      summary.innerHTML = `<span>${record.displayName || "方案不可执行"}</span><strong>${title}</strong><small>${escapeHtml(hint)}</small>`;
      return;
    }
    summary.innerHTML = `<span>${record.displayName || "推荐方案"}</span><strong>途经 · ${record.station.name}</strong><small>${formatClock(record.arrival)} ${record.feasible ? "到达" : `· 超时 ${record.lateMinutes} 分`}</small>`;
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
    timeline.innerHTML = `<div class="stop-timeline-head"><strong>分段补能账本</strong><span>${verificationNote}</span></div>${record.stops.map((stop) => `<div class="stop-timeline-item"><b>${stop.sequence}</b><div><strong title="${escapeHtml(stop.name)}">${escapeHtml(stop.name)}</strong><small>到站 ${stop.arrivalSoc}% → 补至 ${stop.targetSoc}% · ${stop.legDistanceKm} km${stop.provisionalCorridor ? " · 设备待确认" : ""}</small></div><span>+${stop.energyAmount}${record.energyUnit}</span></div>`).join("")}`;
  }

  function updateInsight(record) {
    if (!record) return;
    if (record.directTrip) {
      renderStopTimeline(null);
      renderDirectTripInsight(record);
      updateServiceNudge(record);
      return;
    }
    if (record.serviceOnly) {
      renderStopTimeline(null);
      renderServiceOnlyInsight(record);
      updateServiceNudge(null);
      return;
    }
    if (!record.station) {
      renderStopTimeline(null);
      renderNoStationInsight(record);
      updateServiceNudge(null);
      return;
    }
    selectStation(record.station, false);
    renderStopTimeline(record);
    const reliable = Object.values(state.routeRecords).find((candidate) => candidate.isActualStable) || state.routeRecords.reliable || record;
    const evidence = $$(".evidence-row span");
    if (record.multiStop) {
      const hasProvisional = record.stops.some((stop) => stop.provisionalCorridor);
      if (evidence[0]) evidence[0].textContent = hasProvisional
        ? `高德主路线已核验；按沿线候选分配 ${record.stopCount} 次${state.energyType === "fuel" ? "加油" : "补能"}：首段 ${record.firstLegKm?.toFixed(1) || "—"} km，到达 ${state.destinationName} 预计余量 ${record.arrivalSoc}%。`
        : `已逐段核验 ${record.stopCount} 次${state.energyType === "fuel" ? "加油" : "补能"}：首段 ${record.firstLegKm?.toFixed(1) || "—"} km，到达 ${state.destinationName} 预计余量 ${record.arrivalSoc}%。`;
      if (evidence[1]) evidence[1].textContent = `建议累计${state.energyType === "fuel" ? "加油" : "补能"} ${record.energyAmount} ${record.energyUnit}，总等待 P50 ${record.p50Wait} 分 / P90 ${record.p90Wait} 分。`;
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
      if (record.isActualStable && record.isActualFastest) evidence[2].textContent = "该方案同时拥有最早 ETA 与最低 P90 等待风险";
      else if (record.isActualStable) evidence[2].textContent = `该方案 P90 ${record.station.p90} 分钟，在可行方案中尾部等待风险最低`;
      else if (record.isActualFastest) evidence[2].textContent = `相较低风险方案，预计提前 ${Math.max(0, Math.abs(difference))} 分钟`;
      else if (record.isActualCheapest) evidence[2].textContent = `该方案总成本最低，仍满足当前到达约束`;
      else evidence[2].textContent = `这是成本与风险的可解释备选方案，预计 ${formatClock(record.arrival)} 抵达`;
    }
    renderServiceRecommendations(record);
    updateServiceNudge(record);
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
    if (subtitle) subtitle.innerHTML = `当前${state.energyType === "fuel" ? "油量" : "电量"}可直达 ${state.destinationName} · <span class="source-badge">真实路线 / 能耗模型计算</span>`;
    setInsightBadge("直达可行", false);
    const wait = byId("waitValue");
    if (wait) wait.innerHTML = `0 <small>分钟</small>`;
    setText("energyAdviceLabel", "到达余量");
    const advice = byId("energyAdviceValue");
    if (advice) advice.innerHTML = `${record.arrivalSoc} <small>%</small>`;
    const forecastCard = byId("forecastChart")?.closest(".forecast-card");
    if (forecastCard) forecastCard.style.display = "none";
    const evidence = $$(".evidence-row span");
    if (evidence[0]) evidence[0].textContent = `直达 ${state.destinationName}，不经过补能站，也不增加绕行。`;
    if (evidence[1]) evidence[1].textContent = `预计到达剩余 ${record.arrivalSoc}%（${arrivalReserveDescription(record)}）。`;
    if (evidence[2]) evidence[2].textContent = `基于真实路线里程与 ${state.energyType === "fuel" ? "油耗" : "能耗"}参数计算，当前无需补能。`;
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
    if (subtitle) subtitle.innerHTML = `已加入预计 ${record.servicePlan?.durationMinutes || 0} 分钟的服务停靠 · <span class="source-badge">${record.servicePlan?.source || "高德真实 POI / 演示服务时长"}</span>`;
    setInsightBadge("服务已加入", false);
    const wait = byId("waitValue");
    if (wait) wait.innerHTML = `${record.servicePlan?.extraMinutes || 0} <small>额外分钟</small>`;
    setText("energyAdviceLabel", "到达余量");
    const advice = byId("energyAdviceValue");
    if (advice) advice.innerHTML = `${record.arrivalSoc} <small>%</small>`;
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
    if (subtitle) subtitle.innerHTML = `${record.planningFailure || "当前约束下没有通过首段可达性校验的站点"} · <span class="source-badge">已阻止生成虚假可行方案</span>`;
    setInsightBadge("需调整出行条件", true);
    const wait = byId("waitValue");
    if (wait) wait.innerHTML = `— <small>分钟</small>`;
    setText("energyAdviceLabel", "安全可达");
    const advice = byId("energyAdviceValue");
    if (advice) advice.innerHTML = `不足 <small>请先补能</small>`;
    const forecastCard = byId("forecastChart")?.closest(".forecast-card");
    if (forecastCard) forecastCard.style.display = "none";
    const evidence = $$(".evidence-row span");
    if (hasLongTripFailure) {
      if (evidence[0]) evidence[0].textContent = record.planningFailure;
      if (evidence[1]) evidence[1].textContent = `系统最多支持连续补能 ${state.multiStopPlanningMeta?.maxStops || 6} 次，未用默认目的地或单站路线冒充结果。`;
      if (evidence[2]) evidence[2].textContent = `已同时检查逐段安全余量、${arrivalReserveDescription(record)}与绕行上限（≤${state.maxDetourKm} km）。`;
    } else {
      if (evidence[0]) evidence[0].textContent = "未通过“起点→补能站”安全可达性校验，因此未生成途经站路线。";
      if (evidence[1]) evidence[1].textContent = `当前${arrivalReserveDescription(record)}，请提高起始余量或选择更近站点。`;
      if (evidence[2]) evidence[2].textContent = `已同时检查首段可达性与绕行上限（≤${state.maxDetourKm} km）。`;
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
    if (!record || record.servicePlan || Number(record.duration || 0) < 75) return null;
    const departure = state.departureMinutes;
    const duration = Number(record.duration || 0);
    const lunch = nextDailyMoment(departure, duration, 11 * 60 + 30, 13 * 60 + 30);
    const dinner = nextDailyMoment(departure, duration, 17 * 60 + 30, 20 * 60);
    const mealMoment = [lunch, dinner].filter(Number.isFinite).sort((a, b) => a - b)[0];
    if (Number.isFinite(mealMoment)) {
      return { kind: "meal", icon: "utensils", title: `预计 ${formatClock(mealMoment)} 接近用餐时段`, text: "是否在路线附近安排简餐或咖啡？确认后会把服务停靠加入路线并重算 ETA。", targetMinute: mealMoment, progress: Math.max(0.08, Math.min(0.92, (mealMoment - departure) / Math.max(1, duration))) };
    }
    if (duration >= 130) {
      const targetMinute = departure + 120;
      return { kind: "rest", icon: "armchair", title: `预计 ${formatClock(targetMinute)} 连续驾驶约 2 小时`, text: "是否安排短暂休息或咖啡？系统会优先找顺路服务点。", targetMinute, progress: Math.max(0.08, Math.min(0.92, 120 / duration)) };
    }
    if (duration >= 90) {
      const targetMinute = departure + 90;
      return { kind: "coffee", icon: "coffee", title: `预计 ${formatClock(targetMinute)} 可安排短暂停靠`, text: "是否查看沿线咖啡或休息建议？", targetMinute, progress: Math.max(0.08, Math.min(0.92, 90 / duration)) };
    }
    return null;
  }

  function updateServiceNudge(record) {
    const nudge = byId("serviceNudge");
    const trigger = serviceTriggerForRecord(record);
    if (!nudge || !trigger) {
      if (nudge) nudge.hidden = true;
      return;
    }
    const key = `${state.destinationName}|${record.key}|${trigger.kind}|${Math.round(trigger.targetMinute)}`;
    if (state.serviceSuggestionDismissed.has(key)) {
      nudge.hidden = true;
      return;
    }
    if (!state.serviceSuggestion || state.serviceSuggestion.key !== key) {
      state.serviceSuggestion = Object.assign({ key, recordKey: record.key, accepted: false, loading: false, options: [] }, trigger);
    }
    const suggestion = state.serviceSuggestion;
    nudge.hidden = Boolean(suggestion.accepted);
    setText("serviceNudgeTitle", suggestion.title);
    setText("serviceNudgeText", suggestion.text);
    const icon = byId("serviceNudgeIcon");
    if (icon) icon.setAttribute("data-lucide", suggestion.icon);
    refreshIcons();
  }

  async function loadServiceRecommendations(record) {
    const suggestion = state.serviceSuggestion;
    if (!record || !suggestion || suggestion.recordKey !== record.key || !state.AMap) return;
    suggestion.accepted = true;
    suggestion.loading = true;
    const requestId = ++state.serviceRequestVersion;
    byId("serviceNudge").hidden = true;
    renderServiceRecommendations(record);
    const center = pointAtPathProgress(record.path, suggestion.progress);
    if (!center) return;
    const searches = suggestion.kind === "meal"
      ? [["餐厅", "meal"], ["咖啡厅", "coffee"]]
      : suggestion.kind === "rest"
        ? [["休息区", "rest"], ["咖啡厅", "coffee"]]
        : [["咖啡厅", "coffee"], ["便利店", "rest"]];
    const results = await searchInBatches(searches.map(([keyword, type]) => () => searchNearby(keyword, center, type)), 2);
    if (requestId !== state.serviceRequestVersion || state.serviceSuggestion?.key !== suggestion.key) return;
    const durationByType = { meal: 20, coffee: 12, rest: 15 };
    const iconByType = { meal: "utensils", coffee: "coffee", rest: "armchair" };
    const energyStops = record.stops?.length ? record.stops : record.station ? [record.station] : [];
    suggestion.options = dedupePois(results.flat())
      .map((poi) => {
        const type = poi.type === "meal" || poi.type === "coffee" ? poi.type : "rest";
        const nearestEnergyStop = energyStops.slice().sort((a, b) => distanceKm(a.location, poi.location) - distanceKm(b.location, poi.location))[0];
        const inlineStationId = nearestEnergyStop && distanceKm(nearestEnergyStop.location, poi.location) <= 1.5 ? nearestEnergyStop.id : null;
        const detourKm = Math.max(0.3, nearestPointDistance(poi.location, record.path) * 2 + 0.3);
        return Object.assign({}, poi, {
          id: `service-${poi.id || stableHash(`${poi.name}-${poi.location.join(",")}`)}`,
          serviceType: type,
          icon: iconByType[type],
          durationMinutes: durationByType[type],
          routeProgress: Number(routeProgress(poi.location, record.path).toFixed(4)),
          detourKm: Number(detourKm.toFixed(1)),
          inlineStationId,
          reason: inlineStationId ? "靠近计划补能站，可与驻留时间并行安排" : `距主路线约 ${detourKm.toFixed(1)} km，加入后会重算 ETA`
        });
      })
      .sort((a, b) => a.detourKm - b.detourKm)
      .slice(0, 4);
    suggestion.loading = false;
    renderServiceRecommendations(record);
  }

  function renderServiceRecommendations(record) {
    const container = byId("serviceRecommendations");
    const dwellLabel = byId("serviceDwellTime");
    if (!container || !record) return;
    const suggestion = state.serviceSuggestion;
    const serviceButton = byId("serviceFeedbackButton");
    if (state.activeServicePlan) {
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
      if (dwellLabel) dwellLabel.textContent = "系统会在饭点或长时间驾驶前主动提示";
      container.innerHTML = '<div class="service-card"><i data-lucide="sparkles"></i><span><strong>等待服务建议</strong><small>根据预计经过时间和沿线路况触发餐饮、咖啡或休息建议。</small></span></div>';
      if (serviceButton) { serviceButton.disabled = true; serviceButton.textContent = "等待推荐"; }
      setText("serviceStatus", "尚未安排非油服务");
      refreshIcons();
      return;
    }
    if (suggestion.loading) {
      if (dwellLabel) dwellLabel.textContent = `正在检索 ${formatClock(suggestion.targetMinute)} 附近服务`;
      container.innerHTML = '<div class="service-card"><i data-lucide="loader-circle"></i><span><strong>正在检索沿线真实 POI</strong><small>仅展示高德返回的餐饮、咖啡和休息候选。</small></span></div>';
      refreshIcons();
      return;
    }
    const options = suggestion.options || [];
    if (dwellLabel) dwellLabel.textContent = `预计 ${formatClock(suggestion.targetMinute)} 经过 · 高德真实 POI`;
    container.innerHTML = options.length
      ? options.map((service) => `<button type="button" class="service-card ${state.selectedService === service.id ? "selected" : ""}" data-service="${escapeHtml(service.id)}"><i data-lucide="${service.icon}"></i><span><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.reason)}</small></span><span>约${service.durationMinutes}分</span></button>`).join("")
      : '<div class="service-card"><i data-lucide="map-pin-off"></i><span><strong>附近未检索到合适服务</strong><small>可继续行驶，系统会在下一个时间窗口再次评估。</small></span></div>';
    if (serviceButton) { serviceButton.disabled = true; serviceButton.textContent = "选择服务后继续"; }
    setText("serviceStatus", options.length ? "选择服务后，系统将重新计算路线和 ETA" : "本次不增加服务停靠");
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
      const waypoints = (isInlineService ? energyWaypoints : energyWaypoints.concat(serviceWaypoint))
        .sort((a, b) => a.routeProgress - b.routeProgress);
      const base = state.baseRouteRecords[role] || state.baseRouteRecords.reliable || record;
      const longTripServiceAllowanceKm = !state.detourExplicit && record.multiStop
        ? Math.max(6, Math.min(16, Number(record.baseDistance || base.distance || 0) * 0.012))
        : 0;
      const route = await queryRouteSequence(role, waypoints);
      const servicePlan = {
        id: service.id,
        name: service.name,
        icon: service.icon,
        serviceType: service.serviceType,
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
        || (!state.detourExplicit && record.multiStop && incrementalDetourKm <= longTripServiceAllowanceKm + 1e-6);
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
          const profile = getEnergyProfile(state.energyType === "fuel");
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
      state.routeRecords = state.multiStopRouteRecords;
    } else {
      state.serviceRouteOverrides[role] = updated;
      state.routeRecords[role] = updated;
    }
    state.selectedService = service.id;
    state.activeServicePlan = updated.servicePlan;
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
  }

  function renderStationSummary() {
    if (!state.stations.length) return;
    state.operatorOriginalStations = state.stations.map((station) => Object.assign({}, station));
    state.operatorBefore = computeOperatorSnapshot(state.stations);
    state.operatorAfter = null;
    state.executionState = "before";
    state.paymentState = "authorized";
    state.paymentReceipt = null;
    renderOperatorMetrics(state.operatorBefore, false);
    resetValidationView();
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
    const chargeMinutes = !amount ? 0 : isFuel
      ? (key === "fastest" ? 4 : key === "reliable" ? 5 : 6)
      : Math.max(4, Math.ceil(amount / (key === "fastest" ? 160 : key === "reliable" ? 120 : 90) * 60 + 3));
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
    if (subtitle) subtitle.innerHTML = `额外里程 ${station.detour} km · ${station.type === "加油站" ? "油品服务" : "直流快充"} · <span class="source-badge">${station.source} · 演示预测状态</span>`;
    if (badge) {
      badge.innerHTML = `<i data-lucide="${station.status === "forecast-risk" ? "triangle-alert" : "check-circle-2"}"></i>${station.riskLabel}`;
      badge.classList.toggle("risk", station.status === "forecast-risk");
    }
    if (adviceLabel) adviceLabel.textContent = state.energyType === "fuel" ? "建议加油" : "建议补能";
    const stationRecord = Object.values(state.routeRecords).find((record) => record.station?.id === station.id);
    if (adviceValue) adviceValue.innerHTML = stationRecord
      ? `${stationRecord.energyAmount} <small>${stationRecord.energyUnit}</small>`
      : state.energyType === "fuel" ? "— <small>L</small>" : "— <small>kWh</small>";
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
    if (!state.routeRecords[key]) return;
    state.selectedRoute = key;
    state.routeSelectionTouched = true;
    $$(".route-option").forEach((button) => button.classList.toggle("selected", button.dataset.route === key));
    if (state.live) {
      drawAmapRoutes();
    } else {
      renderFallbackRouteVisuals();
    }
    renderRouteCards();
    if (state.live) fitAmapView();
  }

  function setMode(mode) {
    state.mode = mode;
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
    byId("routeSheet").style.display = mode === "driver" && !state.mobileInsightOpen ? "" : "none";
    if (mode === "driver") byId("mapAttribution").textContent = state.live ? "高德地图 · 真实路线与 POI / 演示预测状态" : "固定场景地图 · POI 示意 / 演示预测状态";
    if (mode === "operator") {
      byId("mapAttribution").textContent = "高德地图 · 真实站点 / 演示负载";
      renderOperatorFlow(state.pendingOperatorPayload);
      if (state.map && state.stations.length) state.map.setFitView(state.stationOverlays, false, [90, 380, 220, 330], 11);
    }
    if (mode === "validation") byId("mapAttribution").textContent = "高德地图 · 固定种子验证场景";
    if (mode === "validation" && !state.validationLoaded) loadValidation();
  }

  function planningCompletionMessage() {
    const records = Object.values(state.routeRecords || {});
    const directCount = records.filter((record) => record.directTrip).length;
    const feasibleCount = records.filter((record) => record.feasible).length;
    if (directCount === records.length && records.length) return "当前余量可直达目的地，已取消不必要的补能停靠。";
    if (!feasibleCount && state.multiStopPlanningMeta?.failure) return `未生成虚假的可行路线：${state.multiStopPlanningMeta.failure}`;
    if (!feasibleCount) return "未生成虚假的可行路线：当前余量无法安全抵达符合绕行约束的补能站。";
    if (state.energyPercent <= 12) return `已进入低电量救援模式：先锁定最近的安全可达站，再比较 ${feasibleCount} 条后续路线。`;
    return `已生成 ${feasibleCount} 条通过首段可达性、${state.arrivalReserveEnabled ? "到达余量" : "车辆安全下限"}和绕行约束校验的方案。`;
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

  function showUnresolvedDestination(destination) {
    clearPlanForUnresolvedDestination();
    const message = destination
      ? `未能定位“${destination}”，或该地点暂不支持驾车路线。系统没有使用默认机场替代，请检查名称后重试。`
      : "没有识别到目的地，因此没有使用默认机场代替。请补充一个可驾车到达的目的地后再试。";
    setAiStatus("目的地未定位", "unresolved");
    setAiReply(message);
    setText("aiReplyMeta", "未生成路线");
    setText("planHint", "请修改目的地后再次 AI 智能规划；未定位时不会生成默认机场路线。");
    showToast(message, 4600);
  }

  async function parseIntent() {
    const input = byId("intentInput");
    const typedValue = input ? input.value.trim() : "";
    const value = typedValue || DEFAULT_DEMO_INTENT;
    if (state.aiActive) return;
    if (input && !typedValue) input.value = value;
    readManualControls();
    state.aiActive = true;
    const button = byId("planButton");
    const label = button?.querySelector("span");
    if (button) button.disabled = true;
    if (label) label.textContent = "正在理解出行需求…";
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
          services: state.aiContext?.services || []
        }
      }, 60000);
      const parsed = payload.parsed || payload.intent || payload.plan || localIntentFallback(value);
      const applied = applyParsedIntent(parsed, payload);
      if (!applied.ok) {
        showUnresolvedDestination(applied.destination);
        return;
      }
      setAiReply(payload.assistantReply || parsed.assistantReply || "已识别出行约束，正在计算真实路线和补能站。 ");
      if (label) label.textContent = "正在比较路线与站点…";
      await recomputePlan({ manageButton: false, silent: true });
      setPlanningVisibility(true);
      setAiStatus(payload.aiUsed === false ? "本地规则规划完成" : "AI 大模型已完成规划", payload.aiUsed === false ? "fallback" : "ready");
      setAiReply(planningCompletionMessage());
      setText("aiReplyMeta", "规划已完成");
      showToast(payload.aiUsed === false ? "AI 暂不可用，已用本地规则完成规划" : planningCompletionMessage());
    } catch (error) {
      const parsed = localIntentFallback(value);
      const applied = applyParsedIntent(parsed, {});
      if (!applied.ok) {
        showUnresolvedDestination(applied.destination);
        return;
      }
      setAiStatus("本地降级", "fallback");
      setAiReply("模型连接暂时不可用，已按本地规则保留核心规划能力。");
      if (label) label.textContent = "正在比较路线与站点…";
      await recomputePlan({ manageButton: false, silent: true });
      setPlanningVisibility(true);
      setAiReply(planningCompletionMessage());
      setText("aiReplyMeta", "规划已完成");
      showToast("模型连接失败，已切换本地规则", 3600);
    } finally {
      state.aiActive = false;
      if (button) button.disabled = false;
      if (label) label.textContent = state.hasPlannedRoute ? "再次 AI 智能规划" : "开始 AI 智能规划";
    }
  }

  function computeOperatorSnapshot(stations) {
    const relevant = stations.filter((station) => station.type === (state.energyType === "fuel" ? "加油站" : "充电站"));
    const pool = relevant.length ? relevant : stations;
    const average = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const averageWait = average(pool.map((station) => station.wait));
    const averageOccupancy = average(pool.map((station) => station.occupancy));
    const dispersion = Math.sqrt(average(pool.map((station) => Math.pow(station.occupancy - averageOccupancy, 2))));
    const p90 = Math.max.apply(null, pool.map((station) => station.p90));
    const riskCount = pool.filter((station) => station.status === "forecast-risk").length;
    const routeOnTime = Object.values(state.routeRecords).filter((record) => Number.isFinite(record.onTime));
    return {
      averageWait,
      p90,
      dispersion,
      riskCount,
      peakQueue: Math.max(18, Math.round(pool.reduce((sum, station) => sum + Math.max(0, station.occupancy - 0.48) * 9, 7))),
      discount: Math.max(4, Math.min(8, riskCount + 4)),
      roi: 1.35 + Math.min(0.65, riskCount * 0.08),
      onTime: routeOnTime.length ? average(routeOnTime.map((record) => record.onTime)) : 89
    };
  }

  function operatorStations() {
    const type = state.energyType === "fuel" ? "加油站" : "充电站";
    const matching = state.stations.filter((station) => station.type === type);
    return matching.length ? matching : state.stations;
  }

  function populateOperatorTargetSelect(preferredId) {
    const select = byId("targetStationSelect");
    if (!select) return;
    const stations = operatorStations();
    const source = stations.slice().sort((a, b) => b.p90 - a.p90 || b.occupancy - a.occupancy)[0];
    const oldValue = preferredId || select.value;
    const candidates = stations.filter((station) => station.id !== source?.id).slice().sort((a, b) => (a.p90 + a.occupancy * 18) - (b.p90 + b.occupancy * 18));
    select.innerHTML = candidates.map((station) => `<option value="${station.id}">${station.name} · 负载 ${(station.occupancy * 100).toFixed(0)}%</option>`).join("");
    if (candidates.some((station) => station.id === oldValue)) select.value = oldValue;
  }

  function renderOperatorFlow(payload) {
    const pool = operatorStations();
    if (!pool.length) return;
    const beforePool = (state.operatorOriginalStations.length ? state.operatorOriginalStations : state.stations)
      .filter((station) => station.type === (state.energyType === "fuel" ? "加油站" : "充电站"));
    let source = beforePool.slice().sort((a, b) => b.p90 - a.p90 || b.occupancy - a.occupancy)[0] || pool[0];
    const targetId = payload?.targetStation?.id || byId("targetStationSelect")?.value;
    const target = pool.find((station) => station.id === targetId) || pool.filter((station) => station.id !== source?.id).slice().sort((a, b) => (a.p90 + a.occupancy * 18) - (b.p90 + b.occupancy * 18))[0] || source;
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
    setText("operatorTargetName", target?.name || "承接站点");
    const stationMetrics = (before, afterEntry) => afterEntry
      ? `负载 ${(before.occupancy * 100).toFixed(0)}% → ${(afterEntry.occupancy * 100).toFixed(0)}% · 平均等待 ${Math.round(before.wait)} → ${Math.round(afterEntry.wait)} 分钟`
      : `负载 ${(before.occupancy * 100).toFixed(0)}% · P90 ${before.p90} 分钟`;
    setText("operatorSourceMetrics", stationMetrics(source, sourceAfter));
    setText("operatorTargetMetrics", stationMetrics(target, targetAfter));
    const flowLabel = payload ? `¥${payload.discountAmount}（建议 ≥¥${payload.recommendedDiscount || payload.discountAmount}）· 分流 ${Math.round(payload.impact?.divertedVehicles || 0)} 人` : "算法推荐承接站";
    setText("operatorFlowLabel", flowLabel);
    const logic = payload
      ? `依据 ${payload.targetUser}，在承接容量、绕行和 ROI 约束下重新计算`
      : "依据拥堵、空余容量、绕行与人群敏感度计算";
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
    if (discount) discount.innerHTML = `¥${snapshot.discount}<span style="font-size:13px;font-family:var(--sans);font-weight:500"> / 单</span>`;
    if (roi) roi.textContent = `${snapshot.roi.toFixed(1)}x`;
    if (queueNote) queueNote.textContent = executed ? `执行后峰值减少 ${Math.max(1, state.operatorBefore.peakQueue - snapshot.peakQueue)} 人` : `${snapshot.riskCount} 个站点出现集中到达风险`;
    if (roiNote) roiNote.textContent = executed ? "订单回流已写入本次演示复盘" : "演示模拟：新增订单毛利 / 优惠成本";
    if (action && executed) {
      const improved = snapshot.p90 <= state.operatorBefore.p90;
      const p90Message = snapshot.p90 < state.operatorBefore.p90
        ? `P90 从 ${state.operatorBefore.p90.toFixed(1)} 分钟降至 ${snapshot.p90.toFixed(1)} 分钟`
        : `P90 保持 ${snapshot.p90.toFixed(1)} 分钟`;
      action.innerHTML = improved
        ? `<strong>执行结果：</strong>高峰站点已分流，${p90Message}。`
        : `<strong>执行复盘：</strong>P90 从 ${state.operatorBefore.p90.toFixed(1)} 分钟升至 ${snapshot.p90.toFixed(1)} 分钟，本策略应撤回并降低优惠强度。`;
    } else if (action) {
      action.innerHTML = `<strong>建议动作：</strong>根据目标站点承载力和用户敏感度动态计算分流优惠。`;
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
    setText("validationSourceBadge", "可复现实验 / 非真实经营 KPI");
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
    if (element) element.textContent = value;
  }

  function renderOperatorSimulation(payload) {
    if (!payload?.before || !payload?.after || !payload?.impact) return;
    const before = payload.before;
    const after = payload.after;
    const impact = payload.impact;
    setText("beforeQueueValue", `${Math.round(before.peakQueue)} 人`);
    setText("afterQueueValue", `${Math.round(after.peakQueue)} 人`);
    setText("beforeP90Value", `${before.p90Wait.toFixed(1)}m`);
    setText("afterP90Value", `${after.p90Wait.toFixed(1)}m`);
    setText("divertedUsersValue", `${Math.round(impact.divertedVehicles)} 人`);
    setText("strategyRoiValue", `${impact.roi.toFixed(2)}x`);
    const snapshot = {
      averageWait: after.averageWait,
      p90: after.p90Wait,
      dispersion: after.occupancyDispersion,
      peakQueue: Math.round(after.peakQueue),
      discount: payload.discountAmount,
      roi: impact.roi,
      riskCount: payload.stations.filter((station) => station.status === "forecast-risk").length,
      onTime: state.operatorBefore?.onTime || 89
    };
    renderOperatorMetrics(snapshot, false);
    const action = byId("operatorAction");
    if (action) {
      const risk = payload.recommendation === "risk";
      action.innerHTML = risk
        ? `<strong>策略风险：</strong>当前优惠会增加目标站点尾部等待，建议降低优惠或更换目标站点。ROI ${impact.roi.toFixed(2)}x。`
        : `<strong>本次策略：</strong>向${payload.targetUser || "目标用户"}发放 ¥${payload.discountAmount} 优惠，预计分流 ${Math.round(impact.divertedVehicles)} 人，新增 ${Math.round(impact.incrementalOrders)} 单，ROI ${impact.roi.toFixed(2)}x。算法估计最低有效优惠为 ¥${payload.recommendedDiscount || payload.discountAmount}。`;
      action.classList.toggle("strategy-risk", risk);
    }
    renderOperatorFlow(payload);
    return snapshot;
  }

  async function simulateOperatorStrategy() {
    const button = byId("operatorSimulate");
    const discount = Number(byId("discountSlider")?.value || 0);
    const targetUser = byId("targetSegment")?.selectedOptions?.[0]?.textContent || "全部可触达用户";
    const targetStationId = byId("targetStationSelect")?.value || null;
    if (button) button.disabled = true;
    try {
      const payload = await postJson("/api/operator/simulate", {
        stations: state.stations,
        discountAmount: discount,
        targetUser,
        targetStationId
      }, 20000);
      const snapshot = renderOperatorSimulation(payload);
      state.pendingOperatorPayload = payload;
      state.pendingOperatorSnapshot = snapshot;
      renderOperatorFlow(payload);
      showToast("已根据优惠和目标人群重新计算供需响应");
    } catch (error) {
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
      return `<tr class="${key === "flowtwin" ? "highlight" : ""}"><td>${labels[key]}</td><td>${Number(row.averageWait || 0).toFixed(1)} 分钟</td><td>${Number(row.p90Wait || 0).toFixed(1)} 分钟</td><td>${Number(row.onTimeRate || 0).toFixed(1)}%</td><td>${Number(row.loadDispersion || 0).toFixed(2)}</td><td>${key === "flowtwin" ? `${Number(row.roi || 0).toFixed(2)}x` : "—"}</td></tr>`;
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
    setText("validationSourceBadge", "可复现实验 / 非真实经营 KPI");
    const progress = byId("validationProgress");
    if (progress) progress.style.width = "100%";
    const evidenceButton = byId("validationEvidenceButton");
    if (evidenceButton) evidenceButton.disabled = false;
    state.validationPayload = payload;
    state.validationLoaded = true;
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
    if (state.pendingOperatorPayload?.stations?.length) {
      const payload = state.pendingOperatorPayload;
      const before = state.operatorBefore || computeOperatorSnapshot(state.stations);
      const byStation = new Map(payload.stations.map((station) => [station.id, station]));
      state.stations = state.stations.map((station) => Object.assign({}, station, byStation.get(station.id) || {}));
      const after = payload.after || {};
      state.operatorAfter = {
        averageWait: Number(after.averageWait || before.averageWait),
        p90: Number(after.p90Wait || before.p90),
        dispersion: Number(after.occupancyDispersion || before.dispersion),
        peakQueue: Number(after.peakQueue || before.peakQueue),
        onTime: before.onTime,
        roi: Number(payload.impact?.roi || 0),
        discount: Number(payload.discountAmount || 0),
        riskCount: state.stations.filter((station) => station.status === "forecast-risk").length
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
      return;
    }
    const before = state.operatorBefore || computeOperatorSnapshot(state.stations);
    const ranked = state.stations.slice().sort((a, b) => b.p90 - a.p90);
    const affectedIds = new Set(ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 3))).map((station) => station.id));
    state.stations = state.stations.map((station) => {
      if (!affectedIds.has(station.id)) return Object.assign({}, station, { occupancy: Math.min(0.92, station.occupancy + 0.025) });
      const p90 = Math.max(5, Math.round(station.p90 * 0.8));
      const occupancy = Math.max(0.35, station.occupancy - 0.14);
      return Object.assign({}, station, {
        p90,
        wait: Math.max(3, Math.round(station.wait * 0.8)),
        occupancy,
        status: p90 >= 20 || occupancy >= 0.82 ? "forecast-risk" : "forecast-ready",
        riskLabel: p90 >= 20 || occupancy >= 0.82 ? "高峰风险" : "分流后可用"
      });
    });
    const computed = computeOperatorSnapshot(state.stations);
    state.operatorAfter = Object.assign({}, computed, {
      averageWait: before.averageWait * 0.786,
      p90: before.p90 * 0.8,
      dispersion: before.dispersion * 0.84,
      peakQueue: Math.max(10, Math.round(before.peakQueue * 0.77)),
      onTime: Math.min(99, before.onTime + 8.6),
      roi: 1.8
    });
    Object.values(state.routeRecords).forEach((record) => {
      const updatedStation = state.stations.find((station) => station.id === record.station?.id);
      if (updatedStation) record.station = Object.assign({}, updatedStation, { detour: record.station.detour });
    });
    calculateRouteRecords();
    renderRouteCards();
    if (state.live) renderLiveStationMarkers();
    renderOperatorMetrics(state.operatorAfter, true);
    renderValidationMetrics(state.operatorAfter);
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
    $$(".execution-step").forEach((step) => step.classList.remove("done"));
    const button = byId("approveButton");
    const reset = byId("resetExecution");
    if (button) {
      button.disabled = false;
      button.style.opacity = "1";
      button.style.color = "";
      button.innerHTML = '<i data-lucide="play"></i>运行分流仿真';
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
      button.innerHTML = '<i data-lucide="loader-circle"></i>正在模拟分流…';
      button.disabled = true;
      button.style.opacity = "0.72";
      refreshIcons();
    }
    window.setTimeout(() => {
      applyStrategy();
      state.executionState = "after";
      if (button) {
        button.disabled = false;
        button.style.opacity = "1";
        button.style.color = "var(--teal)";
        button.innerHTML = '<i data-lucide="rotate-ccw"></i>重置分流仿真';
      }
      byId("resetExecution").classList.remove("hidden");
      showToast("分流仿真完成：地图与站点指标已更新");
      refreshIcons();
    }, 680);
  }

  function updateEnergyControls() {
    const isFuel = state.energyType === "fuel";
    const stateLabel = byId("vehicleEnergyLabel");
    if (stateLabel) stateLabel.textContent = isFuel ? "当前油量" : "当前电量";
    $$('[data-energy-type]').forEach((button) => button.classList.toggle("active", button.dataset.energyType === state.energyType));
    const vehicleIcon = byId("vehicleEnergyIcon");
    const vehiclePercent = byId("vehicleEnergyPercent");
    const vehicleRange = byId("vehicleEnergyRange");
    if (vehicleIcon) vehicleIcon.outerHTML = `<i data-lucide="${isFuel ? "fuel" : "battery-medium"}" id="vehicleEnergyIcon"></i>`;
    if (vehiclePercent) vehiclePercent.textContent = `${Math.round(state.energyPercent)}%`;
    if (vehicleRange) {
      const profile = getEnergyProfile(isFuel);
      const estimatedRange = Math.max(0, Math.floor(profile.capacity * state.energyPercent / 100 / profile.consumptionPerKm));
      vehicleRange.textContent = `预计可行驶 ${estimatedRange} km`;
    }
    syncManualControls();
    refreshIcons();
    updateInsight(state.routeRecords[state.selectedRoute]);
  }

  async function setEnergyType(type, replan) {
    if (!['electric', 'fuel'].includes(type)) return;
    const changed = state.energyType !== type;
    state.energyType = type;
    state.routeSelectionTouched = false;
    state.selectedRoute = "reliable";
    updateEnergyControls();
    if (replan !== false && state.live && state.AMap) {
      setMapStatus("正在按动力类型重新检索补能站…");
      await queryStations();
      await replanRoutesViaStations();
      drawAmapRoutes();
      fitAmapView();
      setMapStatus("高德地图已连接 · 真实路线与 POI 已更新", "ready");
      setText("mapAttribution", "高德地图 · 真实路线与 POI / 演示预测状态");
      setText("stationDataNote", state.provisionalCorridorActive
        ? "等待、实时负载和价格为演示模拟数据；高德 POI 以外的路线补能兜底候选仅用于规划演示，需在出发前确认现场设备。"
        : "等待、实时负载和价格为演示模拟数据；站点名称、坐标和地址来自高德真实 POI。服务区候选的补能设施需现场确认。");
      renderRouteCards();
    } else {
      if (!state.live) {
        const expectedType = type === "fuel" ? "加油站" : "充电站";
        state.stations = FALLBACK.stations.filter((station) => station.type === expectedType).map(simulateStation);
        state.routeCandidates = fallbackRoutes();
        state.routeCandidates.fastest.station = state.stations[0] || null;
        state.routeCandidates.reliable.station = state.stations[1] || state.stations[0] || null;
        state.routeCandidates.cheapest.station = state.stations[2] || state.stations[0] || null;
      }
      renderRouteCards();
    }
    if (changed) showToast(type === "fuel" ? "已切换为燃油补能方案" : "已切换为纯电补能方案");
  }

  async function recomputePlan(options = {}) {
    const manageButton = options.manageButton !== false;
    const button = byId("planButton");
    const label = button ? button.querySelector("span") : null;
    if (button && manageButton) {
      button.disabled = true;
      if (label) label.textContent = "正在综合路线与站点…";
      button.style.opacity = "0.78";
    }
    state.routeSelectionTouched = false;
    state.selectedRoute = "reliable";
    state.multiStopRouteRecords = null;
    state.multiStopPlanningMeta = null;
    state.serviceSuggestion = null;
    state.activeServicePlan = null;
    state.serviceRouteOverrides = {};
    if (state.live && state.AMap) {
      const policies = makeDrivingPolicies(state.AMap);
      const records = await Promise.all(Object.entries(policies).map(async ([key, policy]) => [key, await queryDriving(key, policy)]));
      const liveRecords = Object.fromEntries(records.filter((entry) => entry[1]));
      state.routeRecords = Object.assign(fallbackRoutes(), liveRecords);
      state.baseRouteRecords = Object.assign({}, state.routeRecords);
      await queryStations();
      await replanRoutesViaStations();
      drawAmapRoutes();
      fitAmapView();
      setMapStatus("高德地图已连接 · 真实路线与 POI 已更新", "ready");
      setText("mapAttribution", "高德地图 · 真实路线与 POI / 演示预测状态");
      setText("stationDataNote", state.provisionalCorridorActive
        ? "等待、实时负载和价格为演示模拟数据；高德 POI 以外的路线补能兜底候选仅用于规划演示，需在出发前确认现场设备。"
        : "等待、实时负载和价格为演示模拟数据；站点名称、坐标和地址来自高德真实 POI。服务区候选的补能设施需现场确认。");
    } else {
      prepareFallbackPlan();
      state.hasPlannedRoute = true;
      renderFallbackRouteVisuals();
    }
    state.hasPlannedRoute = true;
    renderRouteCards();
    if (button && manageButton) {
      button.disabled = false;
      if (label) label.textContent = state.hasPlannedRoute ? "再次 AI 智能规划" : "开始 AI 智能规划";
      button.style.opacity = "1";
    }
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
    const expectedType = state.energyType === "fuel" ? "加油站" : "充电站";
    state.stations = FALLBACK.stations.filter((station) => station.type === expectedType).map(simulateStation);
    state.routeRecords.fastest.station = state.stations[0] || null;
    state.routeRecords.reliable.station = state.stations[1] || state.stations[0] || null;
    state.routeRecords.cheapest.station = state.stations[2] || state.stations[0] || null;
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
    initFallback();
    setPlanningVisibility(false);
    if (window.innerWidth <= 760) byId("insightPanel").classList.add("hidden");
    $$("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
    $$(".route-option").forEach((button) => button.addEventListener("click", () => selectRoute(button.dataset.route)));
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
    byId("intentInput").addEventListener("keydown", (event) => { if (event.key === "Enter") parseIntent(); });
    byId("intentInput").addEventListener("input", () => {
      state.manualDeadlineOverride = null;
      state.manualArrivalReserveOverride = null;
    });
    byId("planButton").addEventListener("click", parseIntent);
    $$('[data-energy-type]').forEach((button) => button.addEventListener("click", () => setEnergyType(button.dataset.energyType)));
    [byId("topEnergyPercentInput"), byId("departureTimeInput"), byId("deadlineInput"), byId("minArrivalSocInput")].filter(Boolean).forEach((input) => input.addEventListener("change", () => {
      readManualControls({ markArrivalOverrides: input.id === "deadlineInput" || input.id === "minArrivalSocInput" });
      showToast("出行状态已更新，点击 AI 智能规划后重新计算", 2200);
    }));
    [byId("deadlineInput"), byId("minArrivalSocInput")].filter(Boolean).forEach((input) => input.addEventListener("input", () => {
      readManualControls({ markArrivalOverrides: true });
    }));
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
    const discountSlider = byId("discountSlider");
    if (discountSlider) discountSlider.addEventListener("input", () => setText("discountValue", `¥${discountSlider.value}`));
    const operatorSimulate = byId("operatorSimulate");
    if (operatorSimulate) operatorSimulate.addEventListener("click", simulateOperatorStrategy);
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
    stationCount: state.stations.length,
    displayedMarkerCount: state.stationOverlays.length,
    routeKeys: Object.keys(state.routeRecords),
    selectedRoute: state.selectedRoute,
    selectedStation: state.selectedStation ? state.selectedStation.name : null,
    energyType: state.energyType,
    executionState: state.executionState,
    routeErrors: state.routeErrors,
    routes: Object.fromEntries(Object.entries(state.routeRecords).map(([key, record]) => [key, {
      station: record.station?.name || null,
      stationId: record.station?.id || null,
      stationType: record.station?.type || null,
      pathPoints: record.path?.length || 0,
      geometryHash: record.path ? stableHash(record.path.map((point) => `${point[0].toFixed(4)},${point[1].toFixed(4)}`).join("|")) : null,
      distance: Number(record.distance?.toFixed ? record.distance.toFixed(2) : record.distance),
      baseDistance: Number(record.baseDistance?.toFixed ? record.baseDistance.toFixed(2) : record.baseDistance),
      detour: record.station?.detour || null,
      closestPathToStationKm: record.station?.location && record.path ? Number(nearestPointDistance(record.station.location, record.path).toFixed(3)) : null,
      arrival: Number.isFinite(record.arrival) ? formatClock(record.arrival) : null,
      totalMinutes: Number.isFinite(record.total) ? Number(record.total.toFixed(2)) : null,
      cost: Number.isFinite(record.cost) ? Number(record.cost.toFixed(2)) : null,
      p90: record.station?.p90 || null,
      feasible: record.feasible
    }])),
    stations: state.stations.map((station) => ({
      id: station.id,
      name: station.name,
      type: station.type,
      source: station.source,
      p90: station.p90,
      price: station.price,
      occupancy: Number(station.occupancy.toFixed(2)),
      progress: Number(routeProgress(station.location, (state.baseRouteRecords.reliable || state.routeRecords.reliable || { path: FALLBACK.routes.reliable }).path).toFixed(2)),
      corridorKm: Number(nearestPointDistance(station.location, (state.baseRouteRecords.reliable || state.routeRecords.reliable || { path: FALLBACK.routes.reliable }).path).toFixed(2)),
      location: station.location
    }))
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", begin);
  else begin();
})();
