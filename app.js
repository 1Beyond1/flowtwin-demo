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
      }
    ]
  };

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
    baseRouteRecords: {},
    routeOverlays: {},
    stationOverlays: [],
    stations: [],
    selectedStation: null,
    stationMarkerById: new Map(),
    mobileInsightOpen: false,
    requestVersion: 0,
    departureMinutes: 17 * 60 + 40,
    deadlineMinutes: 19 * 60 + 30,
    energyPercent: 22,
    energyType: "electric",
    executionState: "before",
    operatorBefore: null,
    operatorAfter: null,
    operatorOriginalStations: [],
    routeErrors: {}
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const byId = (id) => document.getElementById(id);

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons({ attrs: { "stroke-width": 1.9 } });
    }
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

  function nearestPointDistance(point, path) {
    return Math.min.apply(null, path.map((candidate) => distanceKm(point, candidate)));
  }

  function routeProgress(point, path) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    path.forEach((candidate, index) => {
      const distance = distanceKm(point, candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return path.length <= 1 ? 0 : bestIndex / (path.length - 1);
  }

  function simulateStation(poi, index) {
    const hash = stableHash(`${poi.id || poi.name}-${index}`);
    const occupancy = 0.42 + (hash % 44) / 100;
    const p50 = 4 + (hash % 10);
    const p90 = p50 + 5 + (hash % 11);
    const isRisk = p90 >= 20 || occupancy >= 0.82;
    return Object.assign({}, poi, {
      source: poi.id && !String(poi.id).startsWith("fallback-") ? "高德真实 POI" : "固定场景 POI",
      occupancy,
      p50,
      p90,
      wait: Math.round((p50 + p90) / 2),
      price: (1.18 + (hash % 58) / 100).toFixed(2),
      status: isRisk ? "forecast-risk" : "forecast-ready",
      riskLabel: isRisk ? "高峰风险" : "预测可用",
      detour: (0.3 + (hash % 12) / 10).toFixed(1)
    });
  }

  function normalizePoi(poi, index, type) {
    const location = parseLocation(poi.location);
    if (!location) return null;
    return {
      id: poi.id || `${type}-${index}-${location.join("-")}`,
      name: poi.name || (type === "fuel" ? "综合能源站" : "充电站"),
      address: poi.address || poi.name || "北京补能站点",
      location,
      type: type === "fuel" ? "加油站" : "充电站",
      tel: poi.tel || "",
      distance: Number(poi.distance) || null
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
        <polyline class="fallback-route" points="${routePoints}" />
        <g class="fallback-labels">
          <text x="615" y="210">北京市</text><text x="515" y="320">朝阳区</text><text x="670" y="480">大兴区</text><text x="1110" y="720">机场方向</text>
          <text x="365" y="510">亦庄</text><text x="825" y="590">榆垡</text><text x="1050" y="805">大兴机场</text>
        </g>
        <g class="fallback-pins"><circle cx="625" cy="190" r="10" /><circle cx="815" cy="505" r="10" /><circle cx="960" cy="630" r="10" /></g>
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

  function markerContent(name, risk, type, selected) {
    const iconName = type === "加油站" ? "fuel" : "zap";
    const classes = ["station-marker", risk ? "risk" : "", selected ? "selected" : ""].filter(Boolean).join(" ");
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
      content: markerContent(poi.name, station.status === "forecast-risk", poi.type, state.selectedStation && state.selectedStation.id === station.id),
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
    state.stationOverlays.push(make(state.origin, "origin-marker", "circle-dot", "能链北京总部"));
    state.stationOverlays.push(make(state.destination, "destination-marker", "plane-landing", "北京大兴国际机场"));
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

  async function queryServerRoute(key, station) {
    const params = new URLSearchParams({
      origin: state.origin.join(","),
      destination: state.destination.join(","),
      waypoint: station.location.join(","),
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

  function searchNearby(keyword, center, type) {
    return new Promise((resolve) => {
      if (!state.AMap) return resolve([]);
      const placeSearch = new state.AMap.PlaceSearch({
        pageSize: 20,
        pageIndex: 1,
        city: "北京",
        citylimit: true,
        map: null,
        autoFitView: false
      });
      placeSearch.searchNearBy(keyword, center, 15000, (status, result) => {
        if (status === "complete" && result && result.poiList && Array.isArray(result.poiList.pois)) {
          resolve(result.poiList.pois.map((poi, index) => normalizePoi(poi, index, type)).filter(Boolean));
        } else {
          resolve([]);
        }
      });
    });
  }

  async function queryStations() {
    if (!state.AMap) return;
    const route = state.baseRouteRecords.reliable || state.routeRecords.reliable || { path: FALLBACK.routes.reliable };
    const path = route.path;
    const centers = [path[0], path[Math.floor(path.length / 2)], path[path.length - 1]];
    const requests = [];
    const primaryKeyword = state.energyType === "fuel" ? "加油站" : "充电站";
    const primaryType = state.energyType === "fuel" ? "fuel" : "electric";
    const secondaryKeyword = state.energyType === "fuel" ? "充电站" : "加油站";
    const secondaryType = state.energyType === "fuel" ? "electric" : "fuel";
    centers.forEach((center) => requests.push(searchNearby(primaryKeyword, center, primaryType)));
    requests.push(searchNearby(secondaryKeyword, centers[1], secondaryType));
    const resultSets = await Promise.all(requests);
    const stagedPois = [];
    resultSets.forEach((set) => set.slice(0, 5).forEach((poi) => stagedPois.push(poi)));
    const corridorPois = dedupePois(stagedPois).filter((poi) => nearestPointDistance(poi.location, path) < 22);
    const selected = corridorPois.length >= 9 ? dedupePois(corridorPois).slice(0, 18) : dedupePois(corridorPois.concat(FALLBACK.stations)).slice(0, 18);
    state.stations = selected.map(simulateStation);
    renderStationSummary();
    clearStationOverlays();
    addAmapEndpoints();
    const displayCandidates = state.stations.filter((station) => {
      const awayFromOrigin = distanceKm(station.location, state.origin) > 1.2;
      const awayFromDestination = distanceKm(station.location, state.destination) > 0.8;
      return awayFromOrigin && awayFromDestination;
    });
    const targets = [0.18, 0.43, 0.68, 0.9];
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
    if (!route) return;
    const line = mapElement.querySelector(".fallback-route");
    line.setAttribute("data-route", state.selectedRoute);
    line.setAttribute("points", fallbackSvgPoints(route.path));
  }

  function chooseStationForRoute(routeKey) {
    return chooseStationForRouteExcluding(routeKey, new Set());
  }

  function chooseStationForRouteExcluding(routeKey, excludedIds) {
    const route = state.routeRecords[routeKey] || state.routeRecords.reliable;
    if (!route || !state.stations.length) return state.stations[0] || null;
    const desiredType = state.energyType === "fuel" ? "加油站" : "充电站";
    const candidates = state.stations.filter((station) => station.type === desiredType);
    const awayFromOrigin = candidates.filter((station) => distanceKm(station.location, state.origin) > 1.2);
    const pool = (awayFromOrigin.length ? awayFromOrigin : candidates).length ? (awayFromOrigin.length ? awayFromOrigin : candidates) : state.stations;
    const targetProgress = { fastest: 0.38, reliable: 0.62, cheapest: 0.84 }[routeKey] || 0.62;
    const sorted = pool.slice().sort((a, b) => {
      const routeScore = (station) => {
        const corridor = nearestPointDistance(station.location, route.path);
        const progress = Math.abs(routeProgress(station.location, route.path) - targetProgress);
        if (routeKey === "fastest") return corridor * 1.7 + progress * 5 + station.p50 * 0.18;
        if (routeKey === "cheapest") return corridor * 0.8 + progress * 1.5 + Number(station.price) * 35 + station.p90 * 0.015;
        return corridor * 0.9 + station.p90 * 1.15 + station.occupancy * 5 + progress * 1.5;
      };
      const scoreA = routeScore(a);
      const scoreB = routeScore(b);
      return scoreA - scoreB;
    });
    return sorted.find((station) => !excludedIds.has(station.id)) || sorted[0] || null;
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

  async function replanRoutesViaStations() {
    if (!state.AMap) return;
    const baseRecords = Object.assign({}, state.baseRouteRecords);
    state.routeRecords = Object.assign({}, baseRecords);
    const stationsByRoute = chooseDistinctStations();
    const policies = makeDrivingPolicies(state.AMap);
    const entries = await Promise.all(Object.keys(policies).map(async (key) => {
      const station = stationsByRoute[key];
      const replanned = await queryDriving(key, policies[key], station);
      const base = baseRecords[key];
      if (!replanned || !station || !base) return [key, Object.assign({}, base, { station })];
      const detour = Math.max(0, replanned.distance - base.distance);
      return [key, Object.assign({}, replanned, {
        baseDistance: base.distance,
        baseDuration: base.duration,
        station: Object.assign({}, station, { detour: detour.toFixed(1) })
      })];
    }));
    state.baseRouteRecords = baseRecords;
    state.routeRecords = Object.fromEntries(entries.filter((entry) => entry[1]));
    renderLiveStationMarkers();
  }

  function renderLiveStationMarkers() {
    if (!state.live || !state.map) return;
    clearStationOverlays();
    addAmapEndpoints();
    const plannedIds = new Set(Object.values(state.routeRecords).map((record) => record.station?.id).filter(Boolean));
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
    const base = state.routeRecords.reliable || fallbackRoutes().reliable;
    const desiredType = state.energyType === "fuel" ? "加油站" : "充电站";
    const plannedStation = (key) => state.routeRecords[key]?.station?.type === desiredType ? state.routeRecords[key].station : null;
    const stationFast = plannedStation("fastest") || chooseStationForRoute("fastest") || simulateStation(FALLBACK.stations[0], 0);
    const stationReliable = plannedStation("reliable") || chooseStationForRoute("reliable") || simulateStation(FALLBACK.stations[1], 1);
    const stationCheap = plannedStation("cheapest") || chooseStationForRoute("cheapest") || simulateStation(FALLBACK.stations[2], 2);
    const make = (key, record, station, waitExtra, chargeMinutes, costFactor) => {
      const wait = Math.max(3, station.wait + waitExtra);
      const total = record.duration + wait + chargeMinutes;
      const arrival = state.departureMinutes + total;
      const lateMinutes = Math.max(0, Math.ceil(arrival - state.deadlineMinutes));
      const onTime = Math.max(55, Math.min(99, 98 - lateMinutes * 3 - station.p90 * 0.2));
      const energyAmount = isFuel ? 35 : 18;
      const energyCost = Number(station.price) * energyAmount;
      const routeCost = record.distance * 0.08 * costFactor;
      const serviceCost = chargeMinutes * 0.15;
      const cost = Math.max(20, energyCost + routeCost + serviceCost);
      return Object.assign({}, record, { key, station, wait, total, arrival, lateMinutes, feasible: lateMinutes === 0, onTime, cost });
    };
    const isFuel = state.energyType === "fuel";
    state.routeRecords.fastest = make("fastest", state.routeRecords.fastest || base, stationFast, 0, isFuel ? 4 : 7, isFuel ? 1.65 : 1.08);
    state.routeRecords.reliable = make("reliable", state.routeRecords.reliable || base, stationReliable, 0, isFuel ? 5 : 10, isFuel ? 1.55 : 1.0);
    state.routeRecords.cheapest = make("cheapest", state.routeRecords.cheapest || base, stationCheap, 0, isFuel ? 6 : 13, isFuel ? 1.4 : 0.82);
  }

  function setOptionText(button, record) {
    if (!button || !record) return;
    const strong = button.querySelector(".option-main strong");
    const metrics = button.querySelector(".option-metrics");
    const reason = button.querySelector(".option-reason");
    const stationLine = button.querySelector(".option-station");
    const tag = button.querySelector(".option-tag");
    button.classList.toggle("infeasible", !record.feasible);
    if (strong) strong.textContent = formatClock(record.arrival);
    if (metrics) {
      metrics.innerHTML = `<span>用时 <b>${formatDuration(record.total)}</b></span><span>绕行 <b>${record.station.detour}km</b></span><span>P50 <b>${record.station.p50}分</b></span><span>P90 <b>${record.station.p90}分</b></span><span>成本 <b>¥${Math.round(record.cost)}</b></span><span>准时 <b>${Math.round(record.onTime)}%</b></span>`;
    }
    if (tag) {
      if (!record.feasible) tag.textContent = `超时 ${record.lateMinutes} 分钟`;
      else if (record.key === "reliable") tag.textContent = "推荐";
      else if (record.key === "fastest") tag.textContent = `少 ${Math.max(1, Math.round((state.routeRecords.reliable.arrival - record.arrival)))} 分钟`;
      else tag.textContent = `省 ¥${Math.max(1, Math.round(state.routeRecords.reliable.cost - record.cost))}`;
    }
    if (stationLine) stationLine.textContent = `${state.energyType === "fuel" ? "加油" : "补能"} · ${record.station?.name || "未匹配站点"} · P90 ${record.station?.p90 || "-"} 分钟`;
    if (reason) {
      const reasons = {
        fastest: `最快抵达 · 额外 ${record.station.detour} km · ${record.station.riskLabel}`,
        reliable: record.feasible ? `低尾部风险 · 负载 ${(record.station.occupancy * 100).toFixed(0)}% · ${Math.round(record.onTime)}% 准时` : `低尾部风险，但超过到达时限 ${record.lateMinutes} 分钟`,
        cheapest: record.feasible ? `价格更低 · 绕行 ${record.station.detour} km · 预计节省 ¥${Math.max(1, Math.round(state.routeRecords.reliable.cost - record.cost))}` : `成本较低，但超过到达时限，不建议执行`
      };
      reason.textContent = reasons[record.key];
    }
  }

  function renderRouteCards() {
    calculateRouteRecords();
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
  }

  function renderActiveRouteSummary() {
    const summary = byId("activeRouteSummary");
    const record = state.routeRecords[state.selectedRoute];
    if (!summary || !record || !record.station) return;
    const labels = { fastest: "最快到达", reliable: "最可靠", cheapest: "最低成本" };
    summary.innerHTML = `<span>${labels[state.selectedRoute]}</span><strong>途经 · ${record.station.name}</strong><small>${formatClock(record.arrival)} ${record.feasible ? "到达" : `· 超时 ${record.lateMinutes} 分`}</small>`;
  }

  function updateInsight(record) {
    if (!record || !record.station) return;
    selectStation(record.station, false);
    const reliable = state.routeRecords.reliable || record;
    const evidence = $$(".evidence-row span");
    if (evidence[0]) evidence[0].textContent = `绕行约 ${record.station.detour} km，预计 ${formatClock(record.arrival)} 抵达机场`;
    if (evidence[1]) evidence[1].textContent = `建议补能后保留 ${Math.max(28, 54 - Math.round(record.station.p90 / 3))}% 续航`;
    if (evidence[2]) {
      const difference = Math.round(record.arrival - reliable.arrival);
      const fastest = state.routeRecords.fastest || record;
      evidence[2].textContent = record.key === "reliable" && record.station.p90 <= fastest.station.p90 ? "相较最快方案，等待尾部风险更低" : record.key === "reliable" ? `当前方案 P90 ${record.station.p90} 分钟，优先保证路线稳定` : difference <= 0 ? `相较稳妥方案，预计提前 ${Math.abs(difference)} 分钟` : `相较稳妥方案，预计晚 ${difference} 分钟`;
    }
  }

  function renderStationSummary() {
    if (!state.stations.length) return;
    state.operatorOriginalStations = state.stations.map((station) => Object.assign({}, station));
    state.operatorBefore = computeOperatorSnapshot(state.stations);
    state.operatorAfter = null;
    state.executionState = "before";
    renderOperatorMetrics(state.operatorBefore, false);
    renderValidationMetrics(null);
  }

  function selectStation(station, showPanel) {
    if (!station) return;
    state.selectedStation = station;
    highlightSelectedStation();
    const title = byId("stationTitle");
    const wait = byId("waitValue");
    const subtitle = byId("stationSubtitle");
    const badge = byId("stationState");
    const adviceLabel = byId("energyAdviceLabel");
    const adviceValue = byId("energyAdviceValue");
    if (title) title.textContent = station.name;
    if (wait) wait.innerHTML = `${station.p90} <small>分钟</small>`;
    if (subtitle) subtitle.innerHTML = `额外里程 ${station.detour} km · ${station.type === "加油站" ? "油品服务" : "直流快充"} · <span class="source-badge">${station.source} / 状态演示</span>`;
    if (badge) {
      badge.innerHTML = `<i data-lucide="${station.status === "forecast-risk" ? "triangle-alert" : "check-circle-2"}"></i>${station.riskLabel}`;
      badge.classList.toggle("risk", station.status === "forecast-risk");
    }
    if (adviceLabel) adviceLabel.textContent = state.energyType === "fuel" ? "建议加油" : "建议补能";
    if (adviceValue) adviceValue.innerHTML = state.energyType === "fuel" ? "25 <small>L</small>" : "18 <small>kWh</small>";
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
      marker.setContent(markerContent(station.name, station.status === "forecast-risk", station.type, state.selectedStation && state.selectedStation.id === stationId));
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
    if (mode === "operator") {
      byId("mapAttribution").textContent = "高德地图 · 真实站点 / 演示负载";
      if (state.map && state.stations.length) state.map.setFitView(state.stationOverlays, false, [90, 380, 220, 330], 11);
    }
    if (mode === "validation") byId("mapAttribution").textContent = "高德地图 · 验证场景底图";
  }

  function parseIntent() {
    const input = byId("intentInput");
    const value = input ? input.value.trim() : "";
    const timeMatch = value.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
    const socMatch = value.match(/(\d{1,3})\s*%/);
    if (timeMatch) state.departureMinutes = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
    if (socMatch) state.energyPercent = Math.max(5, Math.min(100, Number(socMatch[1])));
    if (value.includes("加油") || value.includes("燃油") || value.includes("油车")) state.energyType = "fuel";
    const chips = [];
    chips.push(`目的地 · ${value.includes("机场") ? "大兴机场" : "已识别"}`);
    chips.push(`出发 · ${formatClock(state.departureMinutes)}`);
    chips.push(`SOC · ${state.energyPercent}%`);
    chips.push(value.includes("便宜") || value.includes("省") ? "成本优先" : value.includes("快") ? "时间优先" : "准时优先");
    const row = byId("parsedRow");
    if (row) row.innerHTML = chips.map((chip) => `<span class="parsed-chip">${chip}</span>`).join("");
    renderRouteCards();
    updateEnergyControls();
    showToast("已将自然语言约束转成路线筛选条件（本地演示适配器）");
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
    if (action) action.innerHTML = executed ? `<strong>执行结果：</strong>高峰站点已分流，P90 从 ${state.operatorBefore.p90.toFixed(1)} 分钟降至 ${snapshot.p90.toFixed(1)} 分钟。` : `<strong>建议动作：</strong>将 12% 预计到达量引导至低负载站，目标 P90 下降 20%。`;
  }

  function renderValidationMetrics(snapshot) {
    const before = state.operatorBefore;
    const average = byId("validationAverage");
    const p90 = byId("validationP90");
    const onTime = byId("validationOnTime");
    const row = byId("flowTwinValidationRow");
    if (!before || !snapshot) {
      if (average) average.textContent = "−21.4%";
      if (p90) p90.textContent = "−20.0%";
      if (onTime) onTime.textContent = "+8.6pp";
      if (row) row.innerHTML = "<td>FlowTwin</td><td>9.2 分钟</td><td>18.3 分钟</td><td>97.6%</td><td>0.20</td><td>1.8x</td>";
      return;
    }
    const averageImprovement = (1 - snapshot.averageWait / before.averageWait) * 100;
    const p90Improvement = (1 - snapshot.p90 / before.p90) * 100;
    const onTimeImprovement = snapshot.onTime - before.onTime;
    if (average) average.textContent = `−${averageImprovement.toFixed(1)}%`;
    if (p90) p90.textContent = `−${p90Improvement.toFixed(1)}%`;
    if (onTime) onTime.textContent = `+${onTimeImprovement.toFixed(1)}pp`;
    if (row) row.innerHTML = `<td>FlowTwin · 本次执行</td><td>${snapshot.averageWait.toFixed(1)} 分钟</td><td>${snapshot.p90.toFixed(1)} 分钟</td><td>${snapshot.onTime.toFixed(1)}%</td><td>${snapshot.dispersion.toFixed(2)}</td><td>${snapshot.roi.toFixed(1)}x</td>`;
  }

  function applyStrategy() {
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
    $$(".execution-step").forEach((step) => step.classList.remove("done"));
    const button = byId("approveButton");
    const reset = byId("resetExecution");
    if (button) {
      button.disabled = false;
      button.style.opacity = "1";
      button.style.color = "";
      button.innerHTML = '<i data-lucide="send"></i>提交执行审批';
    }
    if (reset) reset.classList.add("hidden");
    renderOperatorMetrics(state.operatorBefore, false);
    renderValidationMetrics(null);
    calculateRouteRecords();
    renderRouteCards();
    if (state.live) renderLiveStationMarkers();
    refreshIcons();
  }

  function runExecutionLoop() {
    if (state.executionState === "running") return;
    if (state.executionState === "after") {
      setMode("validation");
      return;
    }
    state.executionState = "running";
    const button = byId("approveButton");
    const steps = [byId("stepAlert"), byId("stepApprove"), byId("stepPush"), byId("stepReview")];
    steps[0].classList.add("done");
    if (button) {
      button.innerHTML = '<i data-lucide="loader-circle"></i>执行中…';
      button.disabled = true;
      button.style.opacity = "0.72";
      refreshIcons();
    }
    steps.slice(1).forEach((step, index) => {
      window.setTimeout(() => {
        step.classList.add("done");
        if (index === 0) showToast("本地审批任务已创建，正在执行分流策略");
        if (index === 1) showToast("目标车主触达完成，站点负载开始回流");
        if (index === 2) showToast("订单复盘完成：等待 P90 下降 20%，ROI 1.8x");
        if (index === 2 && button) {
          applyStrategy();
          state.executionState = "after";
          button.disabled = false;
          button.style.opacity = "1";
          button.style.color = "var(--teal)";
          button.innerHTML = '<i data-lucide="bar-chart-3"></i>查看验证结果';
          byId("resetExecution").classList.remove("hidden");
          refreshIcons();
        }
      }, (index + 1) * 900);
    });
  }

  function updateEnergyControls() {
    const isFuel = state.energyType === "fuel";
    const typeValue = byId("energyTypeValue");
    const stateLabel = byId("energyStateLabel");
    const stateValue = byId("energyStateValue");
    const toggle = byId("energyToggle");
    if (typeValue) typeValue.textContent = isFuel ? "燃油" : "纯电";
    if (stateLabel) stateLabel.textContent = isFuel ? "当前油量" : "当前电量";
    if (stateValue) stateValue.textContent = `${state.energyPercent}%`;
    if (toggle) toggle.setAttribute("aria-pressed", String(!isFuel));
    updateInsight(state.routeRecords[state.selectedRoute]);
  }

  async function recomputePlan() {
    const button = byId("planButton");
    const label = button ? button.querySelector("span") : null;
    if (button) {
      button.disabled = true;
      if (label) label.textContent = "正在综合路线与站点…";
      button.style.opacity = "0.78";
    }
    state.routeSelectionTouched = false;
    state.selectedRoute = "reliable";
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
    }
    renderRouteCards();
    if (button) {
      button.disabled = false;
      if (label) label.textContent = "生成补能方案";
      button.style.opacity = "1";
    }
    showToast("补能方案已根据当前约束重新计算");
  }

  function makeDrivingPolicies(AMap) {
    return {
      fastest: AMap.DrivingPolicy && AMap.DrivingPolicy.LEAST_TIME !== undefined ? AMap.DrivingPolicy.LEAST_TIME : 0,
      reliable: AMap.DrivingPolicy && AMap.DrivingPolicy.REAL_TRAFFIC !== undefined ? AMap.DrivingPolicy.REAL_TRAFFIC : 4,
      cheapest: AMap.DrivingPolicy && AMap.DrivingPolicy.LEAST_FEE !== undefined ? AMap.DrivingPolicy.LEAST_FEE : 1
    };
  }

  async function initLiveMap(AMap) {
    state.AMap = AMap;
    const mapElement = byId("map");
    if (mapElement) mapElement.innerHTML = "";
    state.map = new AMap.Map("map", {
      zoom: 10,
      center: [(state.origin[0] + state.destination[0]) / 2, (state.origin[1] + state.destination[1]) / 2],
      viewMode: "2D",
      resizeEnable: true,
      zooms: [5, 19],
      mapStyle: "amap://styles/whitesmoke"
    });
    state.live = true;
    const policies = makeDrivingPolicies(AMap);
    setMapStatus("正在请求真实驾车路线…");
    const records = await Promise.all(Object.entries(policies).map(async ([key, policy]) => [key, await queryDriving(key, policy)]));
    const liveRecords = Object.fromEntries(records.filter((entry) => entry[1]));
    state.routeRecords = Object.assign(fallbackRoutes(), liveRecords);
    state.baseRouteRecords = Object.assign({}, state.routeRecords);
    drawAmapRoutes();
    addAmapEndpoints();
    fitAmapView();
    setMapStatus("正在检索沿线真实充能站点…");
    await queryStations();
    setMapStatus("正在将候选站点加入路线…");
    await replanRoutesViaStations();
    calculateRouteRecords();
    drawAmapRoutes();
    fitAmapView();
    renderRouteCards();
    setMapStatus("高德地图已连接 · 路线与站点为真实数据", "ready");
    byId("mapAttribution").textContent = "高德地图 · 真实路线与 POI / 动态状态演示";
    byId("stationDataNote").textContent = "等待、实时负载和价格为演示模拟数据；站点名称、坐标和地址来自高德真实 POI。";
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
    state.routeRecords = fallbackRoutes();
    state.baseRouteRecords = Object.assign({}, state.routeRecords);
    state.stations = FALLBACK.stations.map(simulateStation);
    state.routeRecords.fastest.station = state.stations[0];
    state.routeRecords.reliable.station = state.stations[1];
    state.routeRecords.cheapest.station = state.stations[2];
    renderFallbackMap();
    addFallbackMarkers();
    calculateRouteRecords();
    renderRouteCards();
    updateEnergyControls();
    setMapStatus("离线演示模式 · 未连接高德实时服务", "error");
    byId("stationDataNote").textContent = "等待、实时负载和价格为演示模拟数据；当前使用固定场景站点，联网后自动替换为真实 POI。";
    byId("mapAttribution").textContent = "固定场景地图 · 站点真实示意 / 动态状态演示";
    window.__FLOWTWIN_READY__ = true;
  }

  function begin() {
    refreshIcons();
    initFallback();
    if (window.innerWidth <= 760) byId("insightPanel").classList.add("hidden");
    $$("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
    $$(".route-option").forEach((button) => button.addEventListener("click", () => selectRoute(button.dataset.route)));
    byId("resetView").addEventListener("click", () => {
      selectRoute("reliable");
      if (state.live) fitAmapView();
    });
    byId("closeInsight").addEventListener("click", () => {
      state.mobileInsightOpen = false;
      byId("insightPanel").classList.add("hidden");
      byId("insightPanel").classList.remove("mobile-visible");
      if (state.mode === "driver") byId("routeSheet").style.display = "";
    });
    byId("closeOperator").addEventListener("click", () => setMode("driver"));
    byId("closeValidation").addEventListener("click", () => setMode("driver"));
    byId("parseIntent").addEventListener("click", parseIntent);
    byId("intentInput").addEventListener("keydown", (event) => { if (event.key === "Enter") parseIntent(); });
    byId("planButton").addEventListener("click", recomputePlan);
    byId("energyToggle").addEventListener("click", async () => {
      state.energyType = state.energyType === "electric" ? "fuel" : "electric";
      state.routeSelectionTouched = false;
      state.selectedRoute = "reliable";
      updateEnergyControls();
      if (state.live && state.AMap) {
        setMapStatus("正在按动力类型重新检索补能站…");
        await queryStations();
        await replanRoutesViaStations();
        drawAmapRoutes();
        fitAmapView();
        renderRouteCards();
        setMapStatus("高德地图已连接 · 路线与站点为真实数据", "ready");
      }
      renderRouteCards();
      showToast(state.energyType === "fuel" ? "已切换为燃油补能方案" : "已切换为纯电补能方案");
    });
    byId("approveButton").addEventListener("click", runExecutionLoop);
    byId("resetExecution").addEventListener("click", resetExecution);

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
