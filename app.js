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

  // 必须和 lib/config.mjs 的 DEFAULT_ORIGIN.name 一致：后端用这个名字判断
  // "用户没说起点"，前端用它判断"这个起点是默认值，不是用户要求的"。
  const DEFAULT_ORIGIN_NAME = "能链北京总部";
  // 标准正态的 90 分位，用于在 p50/p90 和标准差之间换算。与 lib/longtrip.mjs
  // 的同名常量保持一致，两边算的是同一条路线的同一个 P90。
  const Z90 = 1.2816;

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
    aiActive: false,
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
    weather: null
  };

  // The first-run example intentionally leaves arrival time and reserve open.
  // Those are optional controls: pinning them in a static demo sentence makes
  // the experience depend on the viewer's local clock and can turn a useful
  // meal recommendation into an artificial "late" failure.
  const DEFAULT_DEMO_INTENT = "从能链北京总部前往上海东方明珠广播电视塔，优先准时";

  const ENERGY_PROFILES = {
    electric: { capacity: 82, consumptionPerKm: 0.18, transferEfficiency: 0.92, safetyReservePercent: 2, unit: "kWh" },
    fuel: { capacity: 55, consumptionPerKm: 0.075, transferEfficiency: 0.95, safetyReservePercent: 3, unit: "L" },
    // A plug-in hybrid is not a BEV with a tank bolted on: its pack is roughly a
    // quarter the size and its engine runs in a more efficient regime. Reusing
    // the pure-EV profile would overstate its electric range about fourfold and
    // make every 油电 comparison meaningless.
    hybridElectric: { capacity: 20, consumptionPerKm: 0.165, transferEfficiency: 0.92, safetyReservePercent: 2, unit: "kWh" },
    hybridFuel: { capacity: 50, consumptionPerKm: 0.056, transferEfficiency: 0.95, safetyReservePercent: 3, unit: "L" }
  };

  const ENERGY_TYPES = ["electric", "fuel", "hybrid"];

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

  // 首屏"本次更新"公告：打开页面时先展示一次更新内容，关掉即进入 demo。
  function initUpdateNotice() {
    const backdrop = byId("updateNoticeBackdrop");
    const confirm = byId("updateNoticeConfirm");
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
    }, { once: false });
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
    const maxHeight = 64;
    input.style.height = "auto";
    const next = Math.min(Math.max(input.scrollHeight, 42), maxHeight);
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
      ? (/前往|去|到/.test(current) ? current.replace(/(前往|去|到)\s*[^，,。；;]*?/, `$1${name}`) : `${current}，目的地定为${name}`)
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
    button.title = voiceIntent.active ? "停止录音" : "语音输入";
    const icon = button.querySelector("i, svg");
    if (icon && icon.tagName === "I") icon.setAttribute("data-lucide", voiceIntent.active ? "square" : "mic");
    refreshIcons();
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
        showToast("未配置语音识别", 3200);
        return;
      }
      if (!response.ok) throw new Error(payload.error || `HTTP_${response.status}`);
      const text = String(payload.text || payload.transcript || payload.result || "").trim();
      if (!text) {
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
      showToast("语音已写入输入框，请确认后点「开始 AI 智能规划」", 3400);
    } catch (error) {
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
    if (!message) clearDestinationCandidates();
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
      energyType: /混动|插混|混合动力|油电/.test(value)
        ? "hybrid"
        : value.includes("加油") || value.includes("燃油") || value.includes("油车") ? "fuel" : state.energyType,
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
    try {
      const payload = await postJson("/api/forecast", {
        stations: [station],
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
  function corridorReferenceRoute() {
    return state.baseRouteRecords.reliable
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
    state.stationOverlays.push(make(state.origin, "origin-marker", "circle-dot", hasResolvedTrip ? (state.originName || DEFAULT_ORIGIN_NAME) : "起点"));
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
        const record = status === "complete" && result && result.routes && result.routes.length
          ? extractDrivingRoute(result.routes[0], key, policy)
          : null;
        if (record) {
          if (station) record.station = station;
          delete state.routeErrors[`${key}:${station ? "waypoint" : "base"}`];
          resolve(record);
        } else {
          state.routeErrors[`${key}:${station ? "waypoint" : "base"}`] = {
            // status 为 complete 却没有 record，说明响应本身退化（无折线或零里程）。
            status: status === "complete" ? "degenerate" : status,
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
    const profile = getEnergyProfile(isFuelActive());
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
    const route = corridorReferenceRoute();
    const path = route.path;
    const centers = stationSearchCenters(path, route.distance);
    // A hybrid can refuel or recharge, so both networks are searched and the
    // per-branch filters downstream decide which candidates each plan may use.
    const networks = isHybrid()
      ? [{ keyword: "充电站", type: "electric" }, { keyword: "加油站", type: "fuel" }]
      : [isFuelActive() ? { keyword: "加油站", type: "fuel" } : { keyword: "充电站", type: "electric" }];
    const stationTasks = centers.flatMap((center) => {
      const tasks = networks.map((network) => () => searchNearby(network.keyword, center, network.type));
      // Many cross-province motorway points have no POI explicitly named
      // “充电站”. A real 高德服务区 is a truthful fallback candidate; its
      // availability is explicitly labelled as needing on-site confirmation.
      if (networks.some((network) => network.type === "electric")) tasks.push(() => searchNearby("服务区", center, "service-area"));
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
    // 混动要同时保留油、电两张网。直接截断会让排在后面的那张网被整体切掉，
    // 所以按站点类型交替取样，再统一放宽上限。
    const selected = takeBalancedByType(dedupePois(corridorPois), isHybrid() ? 48 : 36);
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

  // 界面上凡是要说"绕行上限是多少"的地方，都必须说这条路线真正被校验时用的那个
  // 数：城际行程放宽后仍然写 state.maxDetourKm，就是在用一个没生效的约束解释结果。
  function activeDetourLimitKm(record) {
    const limit = Number(record?.detourLimitKm);
    return Number.isFinite(limit) ? Number(limit.toFixed(1)) : state.maxDetourKm;
  }

  function buildValidatedLongTripRecord(key, baseRoute, route, waypoints, servicePlan = null) {
    const profile = getEnergyProfile(isFuelActive());
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
    let waitVariance = 0;
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
      // 分位数不可加。各站 P90 直接相加，等于假定这一路每个补能点都同时踩中
      // 各自最差的那 10%——四站独立发生的概率是万分之一，而卡片上印的
      // "总等待 P90" 正是这个数。按独立性卷积：由每站 p50/p90 反解标准差，
      // 方差相加后再还原成 P90；只停一次时退化为该站原始 P90。
      const sigma = Math.max(0, (plannedP90 - plannedP50) / Z90);
      waitVariance += sigma * sigma;
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
    const p90Wait = p50Wait + Z90 * Math.sqrt(waitVariance);
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
    const planningStations = stationsForActiveBranch(state.provisionalCorridorActive
      ? state.stations.filter((station) => station.provisionalCorridor)
      : state.stations);
    try {
      const proposal = await postJson("/api/longtrip", {
        distanceKm: base.distance,
        durationMinutes: base.duration,
        stations: planningStations,
        energyType: backendEnergyTypeKey(),
        soc: state.energyPercent,
        minArrivalSoc: effectiveArrivalReserveSoc(getEnergyProfile(isFuelActive())),
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
    // 兜底候选是按能源网络生成的。混动切换分支后，另一条网络还没有兜底点，
    // 这里必须按当前分支判断是否已注入，否则燃油分支会拿到 0 个可用候选。
    const branchStationType = activeStationType();
    if (!base?.path?.length || !Number.isFinite(Number(base.distance))
      || state.stations.some((station) => station.provisionalCorridor && station.type === branchStationType)) return 0;
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
    let desiredProgress = Math.max(28, Math.min(totalDistanceKm - maxFinalLeg, initialSafeRange * 0.7));
    while (totalDistanceKm - previousProgress > maxFinalLeg && generated.length < 6) {
      const reachableLimit = previousProgress === 0 ? initialSafeRange : fullSafeRange;
      const progressKm = Math.min(desiredProgress, totalDistanceKm - maxFinalLeg);
      const location = pointAtPathProgress(base.path, progressKm / totalDistanceKm);
      if (!location || progressKm <= previousProgress + 5) break;
      const sequence = generated.length + 1;
      const candidate = simulateStation({
        id: `provisional-${activeEnergyKind()}-${Math.round(progressKm)}-${sequence}`,
        name: `沿线补能候选点 ${sequence}`,
        address: "路线补能兜底候选 · 请在出发前确认现场设备",
        location,
        type: branchStationType,
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
        maxStops: proposal.maxStops || 6,
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
      const wait = hasStop ? Math.max(3, Number(station?.wait) || 5) : 0;
      const total = route.duration + wait + (hasStop ? energyPlan.chargeMinutes : 0);
      const arrival = state.departureMinutes + total;
      const lateMinutes = hasArrivalDeadline() ? Math.max(0, Math.ceil(arrival - state.deadlineMinutes)) : 0;
      const onTime = Math.max(55, Math.min(99, 98 - lateMinutes * 3 - (Number(station?.p90) || 10) * 0.2));
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
      make("fastest", candidates.fastest || base, candidates.fastest?.station),
      make("reliable", candidates.reliable || base, candidates.reliable?.station),
      make("cheapest", candidates.cheapest || base, candidates.cheapest?.station)
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
    const serviceName = record.servicePlan?.name || "";
    if (metrics) {
      metrics.innerHTML = record.directTrip
        ? `<span>用时 <b>${formatDuration(record.total)}</b></span><span>直达 <b>无需补能</b></span><span>到达 <b>${record.arrivalSoc}%</b></span><span>成本 <b>¥${Math.round(record.cost)}</b></span>`
        : record.serviceOnly
          ? `<span>用时 <b>${formatDuration(record.total)}</b></span><span>服务 <b>${serviceName || "已加入"}</b></span><span>到达 <b>${record.arrivalSoc}%</b></span><span>${state.deadlineEnabled ? "准时" : "安全余量"} <b>${state.deadlineEnabled ? `${Math.round(record.onTime)}%` : `${record.targetArrivalSoc}%`}</b></span>`
        : record.multiStop
            ? `<span>用时 <b>${formatDuration(record.total)}</b></span><span>补能 <b>${record.stopCount} 次</b></span>${serviceName ? `<span>服务 <b>${serviceName}</b></span>` : ""}<span>绕行 <b>${Number(record.detour || 0).toFixed(1)}km</b></span><span>P90 <b>${record.p90Wait}分</b></span><span>费用 <b>¥${Math.round(record.cost)}</b></span><span>${state.deadlineEnabled ? "准时" : "安全余量"} <b>${state.deadlineEnabled ? `${Math.round(record.onTime)}%` : `${record.targetArrivalSoc}%`}</b></span>`
            : `<span>用时 <b>${formatDuration(record.total)}</b></span>${serviceName ? `<span>服务 <b>${serviceName}</b></span>` : ""}<span>绕行 <b>${Number(record.detour || 0).toFixed(1)}km</b></span><span>P50 <b>${record.station?.p50 ?? "—"}分</b></span><span>P90 <b>${record.station?.p90 ?? "—"}分</b></span><span>成本 <b>¥${Math.round(record.cost)}</b></span><span>${state.deadlineEnabled ? "准时" : "安全余量"} <b>${state.deadlineEnabled ? `${Math.round(record.onTime)}%` : `${record.targetArrivalSoc}%`}</b></span>`;
    }
    if (tag) {
      if (record.directTrip) tag.textContent = "无需补能";
      else if (record.serviceOnly) tag.textContent = "服务已加入";
      else if (record.servicePlan) tag.textContent = "含服务";
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
    if (stationLine) stationLine.textContent = record.directTrip
      ? `无需${isFuelActive() ? "加油" : "补能"} · 直达 ${state.destinationName} · 到达 ${record.arrivalSoc}%`
      : record.serviceOnly
        ? `服务停靠 · ${serviceName || "沿线服务"} · ETA 已按真实路线重算`
      : record.multiStop
        ? `连续${isFuelActive() ? "加油" : "补能"} ${record.stopCount} 次${serviceName ? ` · 含 ${serviceName}` : ""} · ${record.stops.map((stop) => stop.name).join(" → ")} · 到达 ${record.arrivalSoc}%${unconfirmedEquipment(record.stops || [])}`
      : !record.canReachStation
        ? (record.planningFailure || `当前余量不足以安全抵达候选${isFuelActive() ? "加油站" : "充电站"} · 不建议执行`)
        : `${isFuelActive() ? "加油" : "补能"} ${record.energyAmount}${record.energyUnit} · ${record.station?.name || "未匹配站点"}${serviceName ? ` · 含 ${serviceName}` : ""} · 到达 ${record.arrivalSoc}%${unconfirmedEquipment([record.station])}`;
    if (reason) {
      // 该策略的高德查询没返回独立路线，这里复用的是本次行程另一条真实路线。
      // 必须说出来，否则三张卡片看着像三条不同的路线。
      const policyNote = record.policyFallbackFrom
        ? `（高德未返回该策略的独立路线，此处沿用"${{ fastest: "最快到达", reliable: "最稳妥", cheapest: "最低成本" }[record.policyFallbackFrom] || record.policyFallbackFrom}"的真实路线）`
        : "";
      const withNote = (text) => (policyNote ? `${text}${policyNote}` : text);
      if (record.directTrip) {
        reason.textContent = withNote(`当前${isFuelActive() ? "油量" : "电量"}可满足${arrivalReserveDescription(record)}，不引入额外补能停靠。`);
        return;
      }
      if (record.serviceOnly) {
        reason.textContent = withNote(`已加入 ${serviceName || "沿线服务"} · 预计额外 ${record.servicePlan?.extraMinutes || 0} 分钟 · 到达余量 ${record.arrivalSoc}%。`);
        return;
      }
      if (record.multiStop) {
        if (!record.feasible) {
          reason.textContent = withNote(record.key === "cheapest"
            ? `高德低费用道路可将通行费降至 ¥${Math.round(record.roadTolls || 0)}，但预计晚到 ${record.lateMinutes} 分钟，不建议在当前时限下执行。`
            : `该补能策略未同时满足时限、到达余量或绕行约束，已保留为风险备选。`);
          return;
        }
        const summaries = {
          fastest: `高德时间优先道路 + 典型等待与补能时长最短；总等待 P50 ${record.p50Wait} 分钟。`,
          reliable: `采用错峰预约模拟，P90 等待降至 ${record.p90Wait} 分钟；为此增加 ${record.reservationMinutes || 0} 分钟到站协调时间。`,
          cheapest: record.tariffAwarePricing
            ? `当前时限下保留同一安全道路走廊，补能采用低价时段/优惠价模拟；费用 ¥${Math.round(record.cost)} = 补能 ¥${Math.round(record.energyCost || 0)} + 高德通行费 ¥${Math.round(record.roadTolls || 0)}。`
            : `费用 ¥${Math.round(record.cost)} = 补能 ¥${Math.round(record.energyCost || 0)} + 高德通行费 ¥${Math.round(record.roadTolls || 0)}；优先在较低模拟站价处补能。`
        };
        const baseReason = summaries[record.key] || `已逐段核验 ${record.stopCount} 次${isFuelActive() ? "加油" : "补能"}：总等待 P90 ${record.p90Wait} 分钟。`;
        reason.textContent = withNote(serviceName ? `${baseReason} 已含服务停靠 ${serviceName}。` : baseReason);
        return;
      }
      if (!record.canReachStation) {
        reason.textContent = withNote(record.planningFailure || "候选站首段路程超出当前安全可达距离，已拦截该方案。");
        return;
      }
      if (!record.detourWithinLimit) {
        // 城际行程放宽后的上限和用户看到的 8 km 不是一回事，要报实际用的那个，
        // 否则"超过 ≤8 km 约束"会去解释一条按 25 km 校验过的路线。
        reason.textContent = withNote(`实际绕行 ${Number(record.detour || 0).toFixed(1)} km，超过“绕行≤${activeDetourLimitKm(record)} km”约束。`);
        return;
      }
      const reasons = {
        fastest: `最终 ETA 最早 · 额外 ${record.station.detour} km · ${record.station.riskLabel}`,
        reliable: record.isActualCheapest ? `总成本最低 ¥${Math.round(record.cost)} · P90 ${record.station.p90} 分钟 · ${Math.round(record.onTime)}% 准时` : record.stableCollision ? `路线与站点的可解释备选 · P90 ${record.station.p90} 分钟 · ${Math.round(record.onTime)}% 准时` : record.feasible ? `P90 ${record.station.p90} 分钟 · 负载 ${(record.station.occupancy * 100).toFixed(0)}% · ${Math.round(record.onTime)}% 准时` : `风险备选，但超过到达时限 ${record.lateMinutes} 分钟`,
        cheapest: record.costBackup ? `路线与站点的可解释备选 · 绕行 ${record.station.detour} km · P90 ${record.station.p90} 分钟` : record.feasible ? `总成本最低 · 绕行 ${record.station.detour} km · 预计节省 ¥${Math.max(1, Math.round(state.routeRecords.fastest.cost - record.cost))}` : `成本备选，但超过到达时限，不建议执行`
      };
      reason.textContent = withNote(reasons[record.key]);
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
    renderHybridCompare();
    updateInsight(state.routeRecords[state.selectedRoute]);
    syncArrivalPayment();
  }

  // 混动车的两条补能路径必须放在同一条已核验路线上比较，否则"省钱"只是
  // 两次独立优化的副产品。这里对同一条路线分别核算电、油两侧的全程能耗
  // 成本、需要的补能次数与补能耗时，再按统一的时间价值折算给出建议。
  const HYBRID_TIME_VALUE_PER_HOUR = 60;
  // 与 lib/longtrip.mjs 的 MAX_STOPS 保持一致。
  const HYBRID_MAX_STOPS = 6;

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
      // 超过多站规划器自身的 6 站上限时，这条路径实际上是排不出路线的，
      // 不能因为"每公里更便宜"就把它推荐出去。
      exceedsStopCap: stops > HYBRID_MAX_STOPS,
      available: firstStopReachable && (stops === 0 || (pool.length > 0 && stops <= HYBRID_MAX_STOPS)),
      // 不可用原因要分清，否则面板会写"未检索到充电站"而池子里明明有 24 个。
      unavailableReason: !firstStopReachable && stops > 0
        ? "first-stop-unreachable"
        : stops > HYBRID_MAX_STOPS
          ? "stop-cap-exceeded"
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
    const stopText = branch.exceedsStopCap
      ? `需补能 ${branch.stops} 次 · 超过 ${HYBRID_MAX_STOPS} 站规划上限`
      : !branch.available
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
      // 不可用原因分四种，措辞必须和实际情况对得上：站数超上限、沿线确实没站、
      // 当前电量到不了最近的站、以及规划器实测排不出线（站直线够得着但路况够不着）。
      // 一律写成"未检索到可用"会把 24 个充电站说没了。
      const reason = loser.unavailableReason;
      const loserExplain = reason === "stop-cap-exceeded" || loser.exceedsStopCap
        ? `${loser.label}需补能 ${loser.stops} 次，超过 ${HYBRID_MAX_STOPS} 站规划上限`
        : reason === "no-station"
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
        ? `高德主路线已核验；按沿线候选分配 ${record.stopCount} 次${isFuelActive() ? "加油" : "补能"}：首段 ${record.firstLegKm?.toFixed(1) || "—"} km，到达 ${state.destinationName} 预计余量 ${record.arrivalSoc}%。`
        : `已逐段核验 ${record.stopCount} 次${isFuelActive() ? "加油" : "补能"}：首段 ${record.firstLegKm?.toFixed(1) || "—"} km，到达 ${state.destinationName} 预计余量 ${record.arrivalSoc}%。`;
      if (evidence[1]) evidence[1].textContent = `建议累计${isFuelActive() ? "加油" : "补能"} ${record.energyAmount} ${record.energyUnit}，总等待 P50 ${record.p50Wait} 分 / P90 ${record.p90Wait} 分。`;
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
    if (subtitle) subtitle.innerHTML = `当前${isFuelActive() ? "油量" : "电量"}可直达 ${state.destinationName} · <span class="source-badge">真实路线 / 能耗模型计算</span>`;
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
    const mealMoment = [lunch, dinner].filter(Number.isFinite).sort((a, b) => a - b)[0];
    if (Number.isFinite(mealMoment)) {
      return {
        kind: "meal",
        icon: "utensils",
        title: `预计 ${formatClock(mealMoment)} 接近用餐时段`,
        text: `主路线纯驾驶约 ${driveLabel}。是否在该时刻附近安排简餐或咖啡？确认后会把服务停靠加入路线并重算 ETA。${weatherSuffix}`,
        targetMinute: mealMoment,
        progress: Math.max(0.08, Math.min(0.92, (mealMoment - departure) / Math.max(1, duration)))
      };
    }
    if (duration >= 130) {
      // Suggest resting after ~2h on-road, not “trip total = 2 hours”.
      const restAfterMinutes = 120;
      const targetMinute = departure + restAfterMinutes;
      return {
        kind: "rest",
        icon: "armchair",
        title: `全程约 ${driveLabel} · 建议 ${formatClock(targetMinute)} 途中休息`,
        text: `这是高德主路线纯驾驶时长（约 ${driveLabel}），不是把全程算成 2 小时。系统建议在出发后约 2 小时处短暂休息或咖啡，并优先找顺路服务点。${weatherSuffix}`,
        targetMinute,
        progress: Math.max(0.08, Math.min(0.92, restAfterMinutes / duration))
      };
    }
    if (duration >= 90) {
      const restAfterMinutes = 90;
      const targetMinute = departure + restAfterMinutes;
      return {
        kind: "coffee",
        icon: "coffee",
        title: `全程约 ${driveLabel} · 建议 ${formatClock(targetMinute)} 短暂停靠`,
        text: `主路线纯驾驶约 ${driveLabel}。是否在出发后约 1.5 小时查看沿线咖啡或休息建议？${weatherSuffix}`,
        targetMinute,
        progress: Math.max(0.08, Math.min(0.92, restAfterMinutes / duration))
      };
    }
    return null;
  }

  function updateServiceNudge(record) {
    const nudge = byId("serviceNudge");
    const expand = byId("expandInsight");
    const trigger = serviceTriggerForRecord(record);
    if (!nudge || !trigger) {
      if (nudge) nudge.hidden = true;
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
    const base = state.baseRouteRecords[record.key] || state.baseRouteRecords.reliable || record;
    const detourAllowanceKm = state.detourExplicit
      ? Math.max(0, Number(state.maxDetourKm || 0))
      : record.multiStop
        ? Math.max(6, Math.min(16, Number(record.baseDistance || base.distance || 0) * 0.012))
        : 0;
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

  async function loadServiceRecommendations(record) {
    const suggestion = state.serviceSuggestion;
    if (!record || !suggestion || suggestion.recordKey !== record.key || !state.AMap) return;
    suggestion.accepted = true;
    suggestion.loading = true;
    const requestId = ++state.serviceRequestVersion;
    byId("serviceNudge").hidden = true;
    revealServiceFlow({ attention: true, toast: "请在右侧查看非油服务推荐" });
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
    const candidates = dedupePois(results.flat())
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
      .slice(0, 8);
    const recommended = candidates.filter((service) => passesServiceRecommendationPrecheck(record, service));
    suggestion.filteredOutCount = Math.max(0, candidates.length - recommended.length);
    suggestion.options = recommended.slice(0, 4).map((service) => Object.assign({}, service, {
      reason: hasArrivalDeadline()
        ? `${service.reason} · 已通过到达时限预筛`
        : service.reason
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
    const excludedByDeadline = Number(suggestion.filteredOutCount || 0);
    if (dwellLabel) dwellLabel.textContent = `预计 ${formatClock(suggestion.targetMinute)} 经过 · 高德真实 POI`;
    container.innerHTML = options.length
      ? options.map((service) => `<button type="button" class="service-card ${state.selectedService === service.id ? "selected" : ""}" data-service="${escapeHtml(service.id)}"><i data-lucide="${service.icon}"></i><span><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.reason)}</small></span><span>约${service.durationMinutes}分</span></button>`).join("")
      : `<div class="service-card"><i data-lucide="${excludedByDeadline ? "clock-alert" : "map-pin-off"}"></i><span><strong>${excludedByDeadline ? "当前约束下不建议增加服务停靠" : "附近未检索到合适服务"}</strong><small>${excludedByDeadline ? "候选服务会超出当前绕行或到达时间余量，已自动隐藏；可调整约束后重新查看。" : "可继续行驶，系统会在下一个时间窗口再次评估。"}</small></span></div>`;
    if (serviceButton) { serviceButton.disabled = true; serviceButton.textContent = "选择服务后继续"; }
    setText("serviceStatus", options.length ? `${excludedByDeadline ? "已按路线约束完成候选预筛；" : ""}选择服务后，系统将重新计算路线和 ETA` : excludedByDeadline ? "为满足当前路线约束，本次不增加服务停靠" : "本次不增加服务停靠");
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
    revealServiceFlow({ attention: true });
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
      .map((entry) => entry.replace(/^\s*\d+\.\s*/, "").trim().replace(/operationally-effective/gi, "运营有效但未达到盈利目标"))
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
      empty.textContent = `本地分流仿真已完成，但飞书 AI 暂时不可用：${result.message || "请检查配置或权限"}`;
      if (source) source.textContent = "本地仿真结果不受影响；飞书 AI 结果未伪造。";
    } else if (status === "not-configured") {
      empty.hidden = false;
      empty.textContent = "本地分流仿真已完成，当前未配置飞书 AI；不会用示例文字冒充 AI 结果。";
      if (source) source.textContent = "本地仿真结果不受影响；飞书 AI 需要完成服务配置后使用。";
    } else {
      empty.hidden = false;
      empty.textContent = "点击“开始智能分析”，先完成分流仿真，再查看 AI 对运营结果的自然语言解读。";
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
        stations: state.stations,
        strategy,
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
    if (adviceLabel) adviceLabel.textContent = isFuelActive() ? "建议加油" : "建议补能";
    const stationRecord = Object.values(state.routeRecords).find((record) => record.station?.id === station.id);
    if (adviceValue) adviceValue.innerHTML = stationRecord
      ? `${stationRecord.energyAmount} <small>${stationRecord.energyUnit}</small>`
      : isFuelActive() ? "— <small>L</small>" : "— <small>kWh</small>";
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
      syncOperatorPanelTitle();
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

  // 用户点名了出发地却定位不到时的出口。和目的地定位失败同样处理：
  // 报错，而不是退回默认起点后画出一条"起点不对"的真实折线。
  function showUnresolvedOrigin(origin) {
    clearPlanForUnresolvedDestination();
    const message = `未能定位出发地“${origin}”。系统没有改用默认起点${DEFAULT_ORIGIN_NAME}替代，请检查名称后重试。`;
    setAiStatus("出发地未定位", "unresolved");
    setAiReply(message);
    setText("aiReplyMeta", "未生成路线");
    setText("planHint", "请修改出发地后再次 AI 智能规划；未定位时不会改用默认起点。");
    showToast(message, 4600);
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

  async function parseIntent(options = {}) {
    const input = byId("intentInput");
    const typedValue = input ? input.value.trim() : "";
    const value = typedValue || DEFAULT_DEMO_INTENT;
    if (state.aiActive) return;
    if (input && !typedValue) input.value = value;
    clearDestinationCandidates();
    readManualControls();
    state.hybridFailedBranches = new Set();
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
          services: state.aiContext?.services || [],
          explicitDestination: options.explicitDestination || null,
          destinationLocation: options.destinationLocation || null
        }
      }, 60000);
      const parsed = payload.parsed || payload.intent || payload.plan || localIntentFallback(value);
      if (options.explicitDestination) parsed.destination = options.explicitDestination;
      if (options.destinationLocation) {
        payload.destinationLocation = options.destinationLocation;
        parsed.destinationLocation = options.destinationLocation;
      }
      const candidates = payload.destinationCandidates || parsed.destinationCandidates || [];
      // Always pause for a short pick list when the backend flags ambiguity or
      // when several named candidates exist without an exact committed location.
      const needsPick = payload.destinationNeedsPick === true
        || ((!payload.destinationLocation && !options.destinationLocation) && Array.isArray(candidates) && candidates.length >= 2);
      if (needsPick && Array.isArray(candidates) && candidates.length >= 2) {
        setPlanningVisibility(false);
        setAiStatus("请选择目的地", "unresolved");
        setAiReply(`“${parsed.destination || "该地点"}”找到 ${candidates.length} 个可能目的地，请点选一个继续规划。`);
        setText("aiReplyMeta", "目的地待确认");
        setText("planHint", "地点不完全吻合时，请先从列表选择准确目的地。");
        showDestinationCandidates(candidates);
        showToast("请先选择一个目的地", 3200);
        return;
      }
      const applied = applyParsedIntent(parsed, payload);
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
        showUnresolvedDestination(applied.destination);
        return;
      }
      clearDestinationCandidates();
      setAiReply(payload.assistantReply || parsed.assistantReply || "已识别出行约束，正在计算真实路线和补能站。 ");
      if (label) label.textContent = "正在比较路线与站点…";
      await recomputePlan({ manageButton: false, silent: true });
      setPlanningVisibility(true);
      // The backend reports *why* the model was skipped (quota / auth / timeout…).
      // Showing that beats a generic "AI 暂不可用" that hides a days-old outage.
      const fallbackReason = payload.aiFallbackReason || "AI 暂不可用，已用本地规则完成规划";
      // aiUsed lives under `parsed`; reading it off the root made this check
      // always-false, so a failed model still reported "AI 已完成规划".
      const usedAi = payload.parsed?.aiUsed !== false;
      setAiStatus(usedAi ? "AI 大模型已完成规划" : "本地规则规划完成", usedAi ? "ready" : "fallback");
      setAiReply(planningCompletionMessage());
      setText("aiReplyMeta", usedAi ? "规划已完成" : fallbackReason);
      showToast(usedAi ? planningCompletionMessage() : fallbackReason);
    } catch (error) {
      const parsed = localIntentFallback(value);
      if (options.explicitDestination) parsed.destination = options.explicitDestination;
      if (options.destinationLocation) parsed.destinationLocation = options.destinationLocation;
      const applied = applyParsedIntent(parsed, options.destinationLocation ? { destinationLocation: options.destinationLocation } : {});
      if (!applied.ok) {
        if (applied.originUnresolved) showUnresolvedOrigin(applied.origin);
        else showUnresolvedDestination(applied.destination);
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
    const relevant = stations.filter((station) => station.type === (isFuelActive() ? "加油站" : "充电站"));
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
    const type = isFuelActive() ? "加油站" : "充电站";
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
      .filter((station) => station.type === (isFuelActive() ? "加油站" : "充电站"));
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
    // recommendedDiscount 现在可能是 null（没有任何券值能不亏本）。原来的
    // `|| payload.discountAmount` 会把用户自己填的数字回显成"建议值"，
    // 变成一句假装是建议的同义反复。
    const suggestion = payload?.recommendedDiscount != null
      ? `建议 ¥${payload.recommendedDiscount}`
      : "当前结构下无盈亏平衡券值";
    const flowLabel = payload ? `¥${payload.discountAmount}（${suggestion}）· 分流 ${Math.round(payload.impact?.divertedVehicles || 0)} 人` : "算法推荐承接站";
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
    // 这张卡片原来标着"建议分流优惠"，印的却是滑杆当前值——把用户自己刚设的
    // 数字当成算法的建议回显给用户，两者差一倍也看不出来（用户设 ¥12、算法建
    // 议 ¥3，卡片上都写 ¥12）。标签已改成"当前优惠档位"，算法的建议放进注脚，
    // 不一致时才有得比。
    const discountNote = byId("operatorDiscountNote");
    if (discountNote) {
      const recommended = snapshot.recommendedDiscount;
      if (recommended === undefined) {
        discountNote.textContent = "仅对高峰时段目标用户触发";
      } else if (recommended === null) {
        discountNote.textContent = "无盈亏平衡券值，建议改用调度";
      } else if (Math.abs(recommended - snapshot.discount) < 0.5) {
        discountNote.textContent = `与算法建议一致（ROI ${Number(snapshot.recommendedRoi || 0).toFixed(2)}x）`;
      } else {
        discountNote.textContent = `算法建议 ¥${recommended}（ROI ${Number(snapshot.recommendedRoi || 0).toFixed(2)}x）`;
      }
    }
    // ROI 的颜色以前写死在 HTML 的 style 里，永远是"好结果"的青色——
    // 0.2x（每花一块钱只换回两毛毛利）和 1.8x 长得一模一样。
    if (roi) {
      roi.textContent = `${snapshot.roi.toFixed(1)}x`;
      roi.style.color = snapshot.roi >= 1 ? "var(--teal)" : "var(--amber)";
    }
    // Math.max(1, ...) 会把"没降"和"反而升了"都说成"减少 1 人"——一个永远
    // 报喜的数字。按真实差值说，降了多少说多少，没降就直说。
    if (queueNote) {
      if (!executed) {
        queueNote.textContent = `${snapshot.riskCount} 个站点出现集中到达风险`;
      } else {
        const drop = (state.operatorBefore?.peakQueue ?? snapshot.peakQueue) - snapshot.peakQueue;
        queueNote.textContent = drop >= 0.5
          ? `执行后峰值减少 ${drop.toFixed(0)} 人`
          : drop <= -0.5
            ? `执行后峰值上升 ${Math.abs(drop).toFixed(0)} 人，需复核承接站容量`
            : "执行后峰值基本持平";
      }
    }
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
      const risk = payload.recommendation === "risk";
      // 模型分三档，界面原来只认 risk，于是"缓解了拥堵但这一单是亏的"
      // （operationally-effective）和真正划算的方案长得一模一样。ROI 就写在
      // 正文里，却没有任何一处提示它已经低于 1——这正是运营最需要看到的信号。
      const unprofitable = payload.recommendation === "operationally-effective";
      const headline = unprofitable
        ? `<strong>运营有效但不盈利：</strong>`
        : `<strong>本次策略：</strong>`;
      action.innerHTML = risk
        ? `<strong>策略风险：</strong>当前优惠会增加目标站点尾部等待，建议降低优惠或更换目标站点。ROI ${impact.roi.toFixed(2)}x。`
        // 推荐值的口径已经不是"最低有效优惠"，而是"ROI≥1 的档位里分流最多的
        // 那一档"；没有这样的档位时要直说，不能拿用户填的数字冒充建议。
        : `${headline}向${payload.targetUser || "目标用户"}发放 ¥${payload.discountAmount} 优惠，预计分流 ${Math.round(impact.divertedVehicles)} 人（其中挽回流失 ${impact.retainedOrders?.toFixed?.(1) ?? "—"} 单），新增 ${Math.round(impact.incrementalOrders)} 单，ROI ${impact.roi.toFixed(2)}x${unprofitable ? "（优惠成本高于新增毛利，缓解拥堵要自己贴钱）" : ""}。${payload.recommendedDiscount != null
          ? `算法建议 ¥${payload.recommendedDiscount}（不亏本前提下分流最多，ROI ${Number(payload.recommendedBasis?.roi || 0).toFixed(2)}x）。`
          : "当前负载与毛利结构下没有任何券值能做到不亏本，建议改为调度或换承接站点。"}${payload.capacityBound
            // 加价也解决不了的那部分：承接站已经没有空位了，再高的券只是多花钱。
            ? `<br><span class="strategy-note">承接站空余容量已是瓶颈：拥堵侧还有约 ${payload.unservedPressure} 人的压力无处承接，继续加码优惠无法缓解，需增开站点或跨区调度。</span>`
            : ""}`;
      action.classList.toggle("strategy-risk", risk);
      action.classList.toggle("strategy-unprofitable", unprofitable);
    }
    renderOperatorFlow(payload);
    return snapshot;
  }

  async function simulateOperatorStrategy() {
    const button = byId("operatorSimulate");
    const discount = Number(byId("discountSlider")?.value || 0);
    const targetUser = byId("targetSegment")?.selectedOptions?.[0]?.textContent || "全部可触达用户";
    // 中文标签给人看，slug 给模型用。只传标签的话，"准时敏感 · 高峰出行"
    // 会被关键词匹配当成"价格敏感"，把最不肯绕路的人算成最肯绕路的人。
    const targetSegment = byId("targetSegment")?.value || "all";
    const targetStationId = byId("targetStationSelect")?.value || null;
    if (button) button.disabled = true;
    resetFeishuSync();
    setOperatorAnalysisStep("simulation", "processing", "计算中");
    try {
      const payload = await postJson("/api/operator/simulate", {
        stations: state.stations,
        discountAmount: discount,
        targetUser,
        targetSegment,
        targetStationId
      }, 20000);
      const snapshot = renderOperatorSimulation(payload);
      state.pendingOperatorPayload = payload;
      state.pendingOperatorSnapshot = snapshot;
      renderOperatorFlow(payload);
      setOperatorAnalysisStep("simulation", "completed", "已计算");
      showToast("已根据优惠和目标人群重新计算供需响应");
    } catch (error) {
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
        riskCount: state.stations.filter((station) => station.status === "forecast-risk").length,
        recommendedDiscount: payload.recommendedDiscount,
        recommendedRoi: Number(payload.recommendedBasis?.roi || 0)
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
      button.innerHTML = '<i data-lucide="loader-circle"></i>正在计算分流…';
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
      button.style.color = "var(--teal)";
      button.innerHTML = '<i data-lucide="rotate-ccw"></i>重置分析';
    }
    // The main CTA becomes “重置分析” after completion; keep the legacy
    // secondary reset control hidden so the evaluator sees one clear action.
    byId("resetExecution")?.classList.add("hidden");
    showToast("分析完成：仿真结果与 AI 运营解读已更新");
    refreshIcons();
  }

  function hybridBranchRangeKm(kind) {
    const profile = kind === "fuel" ? ENERGY_PROFILES.hybridFuel : ENERGY_PROFILES.hybridElectric;
    return Math.max(0, Math.floor(profile.capacity * hybridBranchLevel(kind) / 100 / profile.consumptionPerKm));
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
        ? `纯电 ${hybridBranchRangeKm("electric")} km · 燃油 ${hybridBranchRangeKm("fuel")} km`
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
    return true;
  }

  async function setEnergyType(type, replan) {
    if (!ENERGY_TYPES.includes(type)) return;
    const changed = adoptEnergyType(type);
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
        if (button && manageButton) {
          button.disabled = false;
          if (label) label.textContent = "重新尝试 AI 规划";
          button.style.opacity = "1";
        }
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
    initUpdateNotice();
    initFallback();
    setPlanningVisibility(false);
    fitIntentInput();
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
    byId("intentInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        parseIntent();
      }
    });
    byId("intentInput").addEventListener("input", () => {
      state.manualDeadlineOverride = null;
      state.manualArrivalReserveOverride = null;
      fitIntentInput();
    });
    byId("voiceIntentButton")?.addEventListener("click", () => { toggleVoiceIntent(); });
    byId("destinationCandidates")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-candidate-index]");
      if (!button) return;
      pickDestinationCandidate(button.dataset.candidateIndex);
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
    // 混动的两格电/油量直接写进 hybridLevels；当前规划分支那一格同步到
    // energyPercent，另一格只用于油电对比与切换分支后的起始能量。
    [["hybridElectricInput", "electric"], ["hybridFuelInput", "fuel"]].forEach(([id, kind]) => {
      byId(id)?.addEventListener("change", (event) => {
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
      // 等待账本。"总等待 P90" 是卡片上的头条数字，却一直没法核对。分位数不可加，
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
    provisionalCorridorActive: state.provisionalCorridorActive,
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
