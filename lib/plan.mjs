import { DEFAULT_ORIGIN } from "./config.mjs";
import { hasAmapServiceKey, requestAmapJson } from "./amap.mjs";
import { AMAP_CACHE_TTLS } from "./amap-cache.mjs";

const MAX_MESSAGE_LENGTH = 1200;
const MAX_CONTEXT_LENGTH = 8000;
const ENERGY_TYPES = new Set(["electric", "fuel", "mixed", "unknown"]);
const PRIORITIES = new Set(["on_time", "fastest", "cheapest", "wait", "balanced"]);
const REQUEST_MODES = new Set(["new_trip", "supplement"]);
const ACTION_TYPES = Object.freeze([
  "ADD_SERVICE",
  "ADD_WAYPOINT",
  "REMOVE_STOP",
  "CHANGE_DESTINATION",
  "UPDATE_CONSTRAINT",
  "NEW_TRIP"
]);
const ACTION_TYPE_SET = new Set(ACTION_TYPES);
const SERVICE_TYPES = new Set(["餐饮", "洗车", "休息", "补能"]);
const CONSTRAINT_TYPES = new Set(["arrivalDeadline", "minArrivalSoc", "maxDetourKm", "energyType", "priority"]);
const FOLLOW_UP_CUE_PATTERN = /中途|途中|路上|顺便|另外|还想|再加|补充|加上|吃饭|吃点|吃个|用餐|午饭|午餐|晚饭|晚餐|早餐|餐厅|咖啡|休息|洗车|加油|充电|补能|少走|不走|尽量|再安排/;
const REFERENCE_CUE_PATTERN = /这(?:里|边|个)|那(?:里|边|个)|它|该站|上一个|下一个|前一个|后一个|刚才|前面|后面|附近|沿线|顺路/;
const SERVICE_MENTION_PATTERN = /吃饭|吃点|吃个|用餐|午饭|午餐|晚饭|晚餐|早餐|餐厅|喝咖啡|咖啡|休息|洗车|充电|加油|补能|麦当劳|肯德基|星巴克|瑞幸|汉堡王|必胜客|海底捞|老乡鸡|德克士|喜茶|奈雪/g;
const SAFE_AI_REASONS = new Set(["not_configured", "network", "quota", "invalid_response"]);
const AMBIGUITY_SCORE_GAP = 18;
const SOFT_CONFIRM_SCORE_GAP = 28;
const CANONICAL_LANDMARKS = new Map([
  ["东方明珠", "上海东方明珠广播电视塔"],
  ["上海东方明珠", "上海东方明珠广播电视塔"],
  ["东方明珠广播电视塔", "上海东方明珠广播电视塔"],
  ["上海东方明珠广播电视塔", "上海东方明珠广播电视塔"],
  // Unqualified "华山风景区" resolves to a same-named park in Jinan; the 西岳
  // qualifier is what pins it to the Shaanxi mountain drivers actually mean.
  ["华山", "西岳华山风景区"],
  ["西岳华山", "西岳华山风景区"],
  ["华山风景区", "西岳华山风景区"],
  ["西岳华山风景区", "西岳华山风景区"],
  ["黄山", "黄山风景区"],
  ["黄山风景区", "黄山风景区"],
  ["泰山", "泰山风景区"],
  ["泰山风景区", "泰山风景区"],
  ["峨眉山", "峨眉山风景区"],
  ["峨眉山风景区", "峨眉山风景区"],
  ["故宫", "故宫博物院"],
  ["故宫博物院", "故宫博物院"],
  ["长城", "八达岭长城"],
  ["八达岭", "八达岭长城"],
  ["八达岭长城", "八达岭长城"],
  ["西湖", "杭州西湖风景名胜区"],
  ["杭州西湖", "杭州西湖风景名胜区"],
  ["杭州西湖风景名胜区", "杭州西湖风景名胜区"],
  ["鼓浪屿", "鼓浪屿"],
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cleanText(value, max = 160) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function canonicalDestination(value) {
  const destination = cleanText(value, 80);
  return CANONICAL_LANDMARKS.get(destination.replace(/\s+/g, "")) || destination || null;
}

function cleanNumber(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, min, max) : null;
}

function timeFromMatch(match) {
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function findTime(text, pattern) {
  return timeFromMatch(text.match(pattern));
}

function normalizeTime(value) {
  const text = cleanText(value, 32);
  if (!text) return null;
  return timeFromMatch(text.match(/(\d{1,2})\s*[:：时点]\s*(\d{2})?/));
}

const AMBIGUOUS_REFERENCE_PATTERN = /^(?:这(?:里|儿)|那(?:里|儿)|此处|彼处|这边|那边|该处|该地方|这个地方|那个地方|它)(?:附近|一带)?$/;
const GENERIC_SERVICE_NAMES = new Set([
  "饭", "吃饭", "吃点东西", "用餐", "餐饮", "餐厅", "咖啡", "咖啡店", "休息", "休息区",
  "卫生间", "洗车", "补能", "充电", "加油", "服务区", "东西", "随便", "随便吃", "任意", "不限"
]);
const KNOWN_SERVICE_NAME_PATTERN = /麦当劳|肯德基|星巴克|瑞幸|汉堡王|必胜客|海底捞|老乡鸡|德克士|喜茶|奈雪|全家|便利蜂/;
// A destination box should also accept a place name on its own. The old
// parser only recognized a place after verbs such as "去" or "前往", which
// made a perfectly valid query like "天津站" look like a request with no
// destination whenever the AI fallback was unavailable.
const STANDALONE_PLACE_SUFFIX_PATTERN = /(?:省|市|自治区|特别行政区|区|县|镇|乡|村|站|机场|大学|学院|学校|广场|景区|公园|医院|码头|塔|馆|园|寺|庙|山|湖|岛|服务区|中心|大厦|街|路|门)$/;
const STANDALONE_NON_PLACE_PATTERN = /帮我|请|想要?|我要|去|到|前往|抵达|那里|这里|这边|那边|附近|途经|经过|路过|顺路|中途|途中|路上|顺便|还想|再加|补充|规划|路线|行程|方案|出发|到达|怎么走|导航|优先|准时|最快|最稳妥|便宜|省钱|等待|电量|油量|充电|加油|补能|休息|吃饭|用餐|咖啡|洗车|设置|取消|重置|更新|分析|开始|停止|看看|试试|你好|谢谢/;

function isAmbiguousReference(value) {
  const text = cleanText(value, 80).replace(/\s+/g, "");
  return !text || AMBIGUOUS_REFERENCE_PATTERN.test(text) || /^(?:这(?:里|儿)|那(?:里|儿)|它)/.test(text);
}

function safeActionPlace(value) {
  const text = cleanText(value, 80);
  return isSafePlace(text) && !isAmbiguousReference(text) ? text : null;
}

function normalizeServiceKind(value) {
  const text = cleanText(value, 40).toLowerCase();
  if (!text) return null;
  if (/洗车|car\s*wash/.test(text)) return "洗车";
  if (/休息|卫生间|厕所|restroom|break/.test(text)) return "休息";
  if (/补能|充电|加油|加气|加氢|fuel|charge|refuel/.test(text)) return "补能";
  if (/餐|饭|吃|喝|咖啡|餐厅|麦当劳|肯德基|星巴克|restaurant|meal|coffee|food/.test(text)) return "餐饮";
  return SERVICE_TYPES.has(value) ? value : null;
}

function normalizeServiceName(value) {
  const text = cleanText(value, 80).replace(/^[\s“"'‘’]+|[\s”"'“’]+$/g, "");
  if (!text || GENERIC_SERVICE_NAMES.has(text)) return null;
  return safeActionPlace(text);
}

function normalizeConstraintType(value) {
  const text = cleanText(value, 40).replace(/[\s_-]/g, "").toLowerCase();
  const aliases = new Map([
    ["arrivaldeadline", "arrivalDeadline"],
    ["deadline", "arrivalDeadline"],
    ["latestarrival", "arrivalDeadline"],
    ["最晚到达", "arrivalDeadline"],
    ["minarrivalsoc", "minArrivalSoc"],
    ["arrivalreserve", "minArrivalSoc"],
    ["reserve", "minArrivalSoc"],
    ["到达电量", "minArrivalSoc"],
    ["maxdetourkm", "maxDetourKm"],
    ["maxdetour", "maxDetourKm"],
    ["detour", "maxDetourKm"],
    ["绕行上限", "maxDetourKm"],
    ["energytype", "energyType"],
    ["energy", "energyType"],
    ["能源类型", "energyType"],
    ["priority", "priority"],
    ["优先级", "priority"]
  ]);
  return aliases.get(text) || (CONSTRAINT_TYPES.has(value) ? value : null);
}

function normalizeConstraintValue(constraint, value) {
  if (value === null) return null;
  if (constraint === "arrivalDeadline") return normalizeTime(value) || undefined;
  if (constraint === "minArrivalSoc") return cleanNumber(value, 5, 100) ?? undefined;
  if (constraint === "maxDetourKm") return cleanNumber(value, 0, 100) ?? undefined;
  if (constraint === "energyType") return ENERGY_TYPES.has(value) ? value : undefined;
  if (constraint === "priority") return PRIORITIES.has(value) ? value : undefined;
  return undefined;
}

function normalizeAction(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const type = cleanText(raw.type || raw.action, 40).toUpperCase().replace(/[\s-]+/g, "_");
  if (!ACTION_TYPE_SET.has(type)) return null;

  if (type === "ADD_SERVICE") {
    const candidateName = raw.name ?? raw.brand ?? raw.query ?? raw.value;
    const location = safeActionPlace(raw.location ?? raw.place);
    const name = normalizeServiceName(candidateName);
    const service = normalizeServiceKind(raw.service ?? raw.serviceType ?? raw.category ?? raw.kind ?? candidateName);
    return service ? {
      type,
      service,
      ...(name ? { name } : {}),
      ...(location ? { location } : {})
    } : null;
  }

  if (type === "ADD_WAYPOINT") {
    const location = safeActionPlace(raw.location ?? raw.waypoint ?? raw.name ?? raw.destination ?? raw.value);
    return location ? { type, location } : null;
  }

  if (type === "REMOVE_STOP") {
    const rawTarget = raw.target ?? raw.service ?? raw.location ?? raw.name ?? raw.value;
    const target = normalizeServiceKind(rawTarget) || safeActionPlace(rawTarget);
    if (!target) return null;
    const name = normalizeServiceName(raw.name ?? raw.brand ?? raw.query);
    return { type, target, ...(name ? { name } : {}) };
  }

  if (type === "CHANGE_DESTINATION") {
    const destination = safeActionPlace(raw.destination ?? raw.location ?? raw.name ?? raw.value);
    return destination ? { type, destination: canonicalDestination(destination) || destination } : null;
  }

  if (type === "UPDATE_CONSTRAINT") {
    const descriptor = raw.constraint && typeof raw.constraint === "object" ? raw.constraint : raw;
    const constraint = normalizeConstraintType(
      typeof raw.constraint === "string" ? raw.constraint : (raw.field ?? raw.key ?? descriptor.name)
    );
    const rawValue = raw.value !== undefined ? raw.value : (raw.nextValue !== undefined ? raw.nextValue : descriptor.value);
    if (!constraint || rawValue === undefined) return null;
    const value = normalizeConstraintValue(constraint, rawValue);
    return value === undefined ? null : { type, constraint, value };
  }

  if (type === "NEW_TRIP") {
    const destination = safeActionPlace(raw.destination ?? raw.location ?? raw.name ?? raw.value);
    if (!destination) return null;
    const origin = safeActionPlace(raw.origin);
    return {
      type,
      ...(origin ? { origin } : {}),
      destination: canonicalDestination(destination) || destination
    };
  }

  return null;
}

function actionKey(action) {
  return [
    action.type,
    action.service || "",
    action.name || "",
    action.location || "",
    action.target || "",
    action.destination || "",
    action.origin || "",
    action.constraint || "",
    action.value === null ? "<null>" : String(action.value ?? "")
  ].join("|");
}

function normalizeActions(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const actions = [];
  for (const value of values) {
    const action = normalizeAction(value);
    if (!action) continue;
    const key = actionKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push(action);
    if (actions.length >= 8) break;
  }
  return actions;
}

function normalizeServices(values) {
  if (!Array.isArray(values)) return [];
  const canonical = values.map((value) => {
    const text = cleanText(value, 30);
    if (/吃饭|吃点|吃个|用餐|午饭|午餐|晚饭|晚餐|早餐|餐厅|咖啡|餐饮|麦当劳|肯德基|星巴克/.test(text)) return "餐饮";
    if (/洗车/.test(text)) return "洗车";
    if (/休息|卫生间/.test(text)) return "休息";
    if (/补能|充电|加油|加气|加氢/.test(text)) return "补能";
    return text;
  }).filter(Boolean);
  return Array.from(new Set(canonical)).slice(0, 6);
}

function findArrivalSoc(text) {
  const match = text.match(/(?:到达|抵达|终点|最后)[^%]{0,50}?(?:至少|要有|保持|保留|不低于|大于|超过|以上|剩余)[^%]{0,12}?(\d{1,3})\s*%/i);
  return cleanNumber(match?.[1], 5, 100);
}

function isConstraintDestination(value) {
  const text = cleanText(value, 80);
  return /^(?:最晚|截止|不晚于|必须在|赶在|前到|之前到|至少|要有|保持|保留|不低于|最多|不超过|不超|允许)\b/.test(text)
    || /(?:\d{1,3}\s*%|\d+(?:\.\d+)?\s*(?:公里|千米|km|KM)|\d{1,2}\s*[:：时点]\s*\d{2})/.test(text);
}

function isServiceDestination(value) {
  const text = cleanText(value, 80);
  return /^(?:吃|用餐|餐饮|餐厅|咖啡|休息|洗车|加油|充电|补能|麦当劳|肯德基|星巴克|瑞幸|汉堡王)/.test(text)
    || /(?:吃饭|用餐|餐厅|咖啡|休息区|洗车)$/.test(text);
}

function normalizeDestinationCandidate(value) {
  return cleanText(value, 80)
    .replace(/^(?:改|换)(?:去|到|成)\s*/, "")
    .replace(/(?:然后|并且|最好|尽量|优先).*/, "")
    .replace(/(?:吃饭|用餐|餐厅就餐|喝咖啡|咖啡|休息|洗车|充电|加油)$/, "")
    .trim();
}

function findStandaloneDestination(text) {
  const rawText = cleanText(text, 80).replace(/[。！？!?]+$/, "").trim();
  if (!rawText || /[\r\n]/.test(rawText)) return null;
  // Keep the first clause so "天津站，优先准时" still resolves the station
  // instead of sending the entire constraint sentence to AMap.
  const firstClause = rawText.split(/[，,；;。]/, 1)[0];
  const candidate = normalizeDestinationCandidate(firstClause);
  if (!candidate || isAmbiguousReference(candidate) || isConstraintDestination(candidate) || isServiceDestination(candidate)) return null;
  const normalized = candidate.replace(/\s+/g, "");
  const isCanonicalLandmark = CANONICAL_LANDMARKS.has(normalized);
  const isLocationSuffix = STANDALONE_PLACE_SUFFIX_PATTERN.test(candidate);
  // Short bare city/landmark names such as "天津" or "南京" are allowed too,
  // but ordinary planning sentences must not be mistaken for places. AMap
  // remains the authority: this only decides whether to start geocoding.
  const isShortPlace = /^[\u4e00-\u9fa5A-Za-z0-9·（）()\-]{2,16}$/.test(candidate)
    && !STANDALONE_NON_PLACE_PATTERN.test(candidate);
  return isCanonicalLandmark || isLocationSuffix || isShortPlace ? candidate : null;
}

function isServiceStopMention(text, index, rawValue) {
  const before = text.slice(0, index);
  return /(?:中途|途中|路上|顺便|还想|再加|补充|加上|安排)[^，。；,;]{0,12}$/.test(before)
    && /(?:吃|喝|用餐|餐厅|咖啡|休息|洗车|服务区|麦当劳|肯德基|星巴克|瑞幸|汉堡王)/.test(rawValue);
}

function findDestination(text) {
  // Prefer the last explicit destination phrase. It lets a user replace the
  // prefilled demo route by appending "去燕郊站" instead of being pinned to
  // the earlier airport wording.
  const matches = [];
  const patterns = [
    /(?:把|将)?目的地\s*(?:改|换)(?:去|到|成)?\s*([^，,。；;\n]{2,40})/g,
    /(?:改|换)(?:去|到|成)\s*([^，,。；;\n]{2,40})/g,
    /(?:前往|去|抵达|目的地(?:是)?|到(?!达))[\s:：]*([^，,。；;\n]{2,40})/g,
    /(?:搜索|搜|查找|查询|定位|导航(?:到|去))[\s:：]*([^，,。；;\n]{2,40})/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      matches.push({ index: match.index || 0, value: match[1] });
    }
  }
  for (const match of matches.sort((left, right) => left.index - right.index).reverse()) {
    const raw = cleanText(match.value || "", 80);
    const direct = normalizeDestinationCandidate(raw);
    // “中途想去吃麦当劳/咖啡” contains the same “去” token as a
    // destination request, but it is a service stop rather than a new trip.
    // Do not turn the meal name into a place to geocode.
    if (!direct || isAmbiguousReference(direct) || isConstraintDestination(raw) || isServiceDestination(direct)) continue;
    if (isServiceStopMention(text, match.index, raw)) continue;
    return direct;
  }
  const knownPlaces = [
    "北京大兴国际机场", "大兴国际机场", "大兴机场", "首都国际机场", "首都机场",
    "北京南站", "北京站", "北京西站", "北京朝阳站", "天津滨海国际机场", "天津机场"
  ];
  const known = knownPlaces
    .map((place) => ({ place, index: text.lastIndexOf(place) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => b.index - a.index)[0];
  return known?.place || findStandaloneDestination(text);
}

function inferRequestMode(text, context = {}, directDestination = null) {
  const hasPlannedRoute = Boolean(context.hasPlannedRoute || context.currentDestination);
  if (!hasPlannedRoute) return "new_trip";
  const explicitReplacement = /(?:把|将)?目的地\s*(?:改|换)|(?:改|换)(?:去|到|成)\s*(?!最晚|截止|不晚于|至少|最多|不超过|不超|允许)|换个目的地|重新(?:规划|安排|出发)|新行程|另一个目的地|目的地(?:改|换)/.test(text);
  if (explicitReplacement) return "new_trip";
  const supplementCue = /中途|途中|路上|顺便|另外|还想|再加|补充|加上|吃饭|吃点|吃个|用餐|午饭|午餐|晚饭|晚餐|早餐|餐厅|咖啡|休息|洗车|加油|充电|补能|少走|不走|尽量|再安排/.test(text);
  // A resolved destination is a replacement request (“我想去南京”). A
  // service-only sentence such as “中途想去吃麦当劳” has already been
  // filtered out by findDestination, so it falls through to supplement.
  if (directDestination) return "new_trip";
  if (supplementCue) return "supplement";
  return "supplement";
}

function findWaypoints(text) {
  const waypoints = [];
  const pattern = /(?:途经|经过|路过|顺路(?:经过|去|到)?|中途经过)\s*([^，,。；;\n]{2,40})/g;
  for (const match of text.matchAll(pattern)) {
    let location = cleanText(match[1], 80)
      .replace(/(?:然后|并且|最好|尽量|优先).*/, "")
      .replace(/(?:去)?(?:吃饭|用餐|餐厅就餐|喝咖啡|咖啡|休息|洗车|充电|加油)$/, "")
      .trim();
    if (!location || isAmbiguousReference(location)) continue;
    const safeLocation = safeActionPlace(location);
    if (safeLocation && !waypoints.some((item) => item === safeLocation)) waypoints.push(safeLocation);
  }
  return waypoints.slice(0, 4);
}

function serviceEvidence(text) {
  const values = [];
  if (/吃饭|吃点|吃个|用餐|午饭|午餐|晚饭|晚餐|早餐|餐饮|餐厅|咖啡|下午茶|茶歇|喝|麦当劳|肯德基|星巴克|瑞幸|汉堡王|必胜客|海底捞|老乡鸡|德克士|喜茶|奈雪/.test(text)) values.push("餐饮");
  if (/洗车/.test(text)) values.push("洗车");
  if (/休息|休息区|卫生间|厕所/.test(text)) values.push("休息");
  if (/补能|充电|加油|加气|加氢/.test(text)) values.push("补能");
  return Array.from(new Set(values));
}

function extractServiceName(text) {
  const known = text.match(KNOWN_SERVICE_NAME_PATTERN)?.[0];
  if (known) return normalizeServiceName(known);

  const meal = text.match(/(?:吃|喝)(?:个|点|顿|杯)?\s*([\u4e00-\u9fa5A-Za-z0-9][^，,。；;!?！？\s]{1,24})/);
  const mealName = normalizeServiceName(meal?.[1]);
  if (mealName) return mealName;

  const place = text.match(/(?:去|到|在)\s*([^，,。；;!?！？]{2,30}?)(?=(?:吃饭|用餐|餐厅就餐|喝咖啡|咖啡|休息|洗车))/);
  return normalizeServiceName(place?.[1]);
}

function extractServiceLocation(text) {
  const place = text.match(/(?:去|到|在)\s*([^，,。；;!?！？]{2,30}?)(?=(?:吃饭|用餐|餐厅就餐|喝咖啡|咖啡|休息|洗车))/);
  return safeActionPlace(place?.[1]);
}

function removalCue(text) {
  return /取消|删(?:掉|除)?|去掉|移除|不要|不需要|不用|别(?:安排|加|要)/.test(text);
}

function destinationChangeCue(text) {
  return /(?:把|将)?目的地\s*(?:改|换)|(?:改|换)(?:去|到|成)\s*(?!最晚|截止|不晚于|至少|最多|不超过|不超|允许)|换个目的地/.test(text);
}

function localRemovalAction(text) {
  if (!removalCue(text)) return null;
  const evidence = serviceEvidence(text);
  if (evidence.length) {
    const name = extractServiceName(text);
    return { type: "REMOVE_STOP", target: evidence[0], ...(name ? { name } : {}) };
  }
  const waypoint = findWaypoints(text)[0];
  return waypoint ? { type: "REMOVE_STOP", target: waypoint } : null;
}

function localActionMatchesText(action, localActions) {
  return localActions.some((local) => {
    if (local.type !== action.type) return false;
    if (action.type === "ADD_SERVICE") {
      if (local.service !== action.service) return false;
      if (local.name && action.name && local.name !== action.name) return false;
      if (local.location && action.location && local.location !== action.location) return false;
      return true;
    }
    if (action.type === "ADD_WAYPOINT") return local.location === action.location;
    if (action.type === "REMOVE_STOP") {
      return local.target === action.target && (!local.name || !action.name || local.name === action.name);
    }
    if (action.type === "CHANGE_DESTINATION" || action.type === "NEW_TRIP") {
      return local.destination === action.destination;
    }
    if (action.type === "UPDATE_CONSTRAINT") {
      return local.constraint === action.constraint && local.value === action.value;
    }
    return false;
  });
}

function validatedActions(modelActions, localActions) {
  const local = normalizeActions(localActions);
  const model = normalizeActions(modelActions);
  const accepted = [];
  for (const action of model) {
    if (!localActionMatchesText(action, local)) continue;
    // Local extraction is authoritative for values that can affect the route.
    // A model may add a concrete label only when that exact label appears in
    // the user's text; it may never supply a new destination or hard value.
    const matchingLocal = local.find((candidate) => candidate.type === action.type);
    if (matchingLocal?.type === "ADD_SERVICE" && matchingLocal.service === action.service) {
      accepted.push({ ...matchingLocal, ...(action.name && !matchingLocal.name ? { name: action.name } : {}) });
    } else {
      accepted.push(action);
    }
  }
  return normalizeActions([...local, ...accepted]);
}

function enrichConcreteServiceActionNames(actions, text) {
  const requestedName = extractServiceName(text);
  const normalized = normalizeActions(actions);
  if (!requestedName) return normalized;
  const service = serviceEvidence(text)[0] || "餐饮";
  const enriched = normalized.map((action) => action.type === "ADD_SERVICE" && action.service === service
    ? { ...action, name: requestedName }
    : action);
  if (!enriched.some((action) => action.type === "ADD_SERVICE" && action.service === service)) {
    enriched.push({ type: "ADD_SERVICE", service, name: requestedName });
  }
  return normalizeActions(enriched);
}

function buildLocalActions(text, context, draft) {
  const hasPlannedRoute = Boolean(context.hasPlannedRoute || context.currentDestination);
  const directDestination = safeActionPlace(draft.directDestination);
  const canApplyToTrip = hasPlannedRoute || Boolean(directDestination);
  const actions = [];

  if (directDestination && canApplyToTrip) {
    const replacement = hasPlannedRoute && destinationChangeCue(text);
    actions.push(replacement
      ? { type: "CHANGE_DESTINATION", destination: directDestination }
      : {
          type: "NEW_TRIP",
          ...(draft.explicitOrigin ? { origin: draft.explicitOrigin } : {}),
          destination: directDestination
        });
  }

  if (canApplyToTrip) {
    for (const location of findWaypoints(text)) actions.push({ type: "ADD_WAYPOINT", location });
  }

  const removal = localRemovalAction(text);
  if (canApplyToTrip && removal) {
    actions.push(removal);
  } else if (canApplyToTrip) {
    const services = serviceEvidence(text);
    const hasAdditionCue = /中途|途中|路上|顺便|还想|再加|补充|加上|安排|需要|想吃|想喝|吃饭|吃点|吃个|用餐|咖啡|洗车|休息|充电|加油|补能/.test(text);
    if (services.length && hasAdditionCue) {
      actions.push({
        type: "ADD_SERVICE",
        service: services[0],
        ...(extractServiceName(text) ? { name: extractServiceName(text) } : {}),
        ...(extractServiceLocation(text) ? { location: extractServiceLocation(text) } : {})
      });
    }
  }

  if (canApplyToTrip && draft.arrivalDeadline && /最晚|截止|不晚于|必须在|赶在|前到|之前到/.test(text)) {
    actions.push({ type: "UPDATE_CONSTRAINT", constraint: "arrivalDeadline", value: draft.arrivalDeadline });
  }
  if (canApplyToTrip && draft.minArrivalSoc !== null && draft.minArrivalSoc !== undefined) {
    actions.push({ type: "UPDATE_CONSTRAINT", constraint: "minArrivalSoc", value: draft.minArrivalSoc });
  }
  if (canApplyToTrip && draft.maxDetourKm !== null && draft.maxDetourKm !== undefined) {
    actions.push({ type: "UPDATE_CONSTRAINT", constraint: "maxDetourKm", value: draft.maxDetourKm });
  }
  if (canApplyToTrip && draft.energyType !== "unknown" && /油电|混动|插混|混合动力|两种|都可以|不限|phev|加油|燃油|油车|汽油|柴油|充电|电车|电动车|电量|SOC/i.test(text)) {
    actions.push({ type: "UPDATE_CONSTRAINT", constraint: "energyType", value: draft.energyType });
  }
  if (canApplyToTrip && draft.priority !== "balanced" && /不能迟到|准时|赶时间|到达时间|不想等|少等|等待|便宜|省钱|低成本|最快|快一点|尽快/.test(text)) {
    actions.push({ type: "UPDATE_CONSTRAINT", constraint: "priority", value: draft.priority });
  }
  return normalizeActions(actions);
}

function servicesWithLocalEvidence(modelServices, localServices, text, actions) {
  const local = normalizeServices(localServices);
  const evidence = new Set(serviceEvidence(text));
  const allowedModel = normalizeServices(modelServices).filter((service) => evidence.has(service));
  const removed = new Set(normalizeActions(actions).filter((action) => action.type === "REMOVE_STOP").map((action) => action.target));
  return Array.from(new Set([...local, ...allowedModel])).filter((service) => !removed.has(service));
}

function findOrigin(text) {
  const match = text.match(/从([^，,。；;\n]{2,40})(?:出发|到|去|前往)/);
  return cleanText(match?.[1] || "", 80) || DEFAULT_ORIGIN.name;
}

function findExplicitOrigin(text) {
  const match = text.match(/从([^，,。；;\n]{2,40})(?:出发|到|去|前往)/);
  return safeActionPlace(match?.[1]);
}

function localParse(message, context = {}) {
  const text = cleanText(message, MAX_MESSAGE_LENGTH);
  const arrivalDeadline = findTime(text, /(?:最晚|截止|不晚于|必须在|赶在|前到|之前到)[^\d]{0,8}(\d{1,2})\s*[:：时点]\s*(\d{2})?/);
  const minArrivalSoc = findArrivalSoc(text);
  const detour = cleanNumber(text.match(/(?:最多|不超过|不超|允许)\s*(\d+(?:\.\d+)?)\s*(?:公里|千米|km|KM)/)?.[1], 0, 100);
  // "混动/插混/PHEV" is the single most common way a user states that both
  // energy paths are available, so it has to reach the same branch as 油电.
  const energyType = /油电|混动|插混|混合动力|两种|都可以|不限|phev|PHEV/.test(text)
    ? "mixed"
    : /加油|燃油|油车|汽油|柴油/.test(text)
      ? "fuel"
      : /充电|电车|电动车|电量|SOC/.test(text)
        ? "electric"
        : "unknown";
  const priority = /不能迟到|准时|赶时间|到达时间/.test(text)
    ? "on_time"
    : /不想等|少等|等待/.test(text)
      ? "wait"
      : /便宜|省钱|低成本/.test(text)
        ? "cheapest"
        : /最快|快一点|尽快/.test(text)
          ? "fastest"
          : "balanced";
  const directDestination = findDestination(text);
  const requestMode = inferRequestMode(text, context, directDestination);
  const destination = directDestination
    || (requestMode === "supplement" ? cleanText(context.currentDestination || context.destination, 80) : null)
    || null;
  const origin = findOrigin(text) || cleanText(context.origin, 80) || DEFAULT_ORIGIN.name;
  const actions = buildLocalActions(text, context, {
    directDestination,
    explicitOrigin: findExplicitOrigin(text),
    arrivalDeadline,
    minArrivalSoc,
    maxDetourKm: detour,
    energyType,
    priority
  });
  const removedServices = new Set(actions.filter((action) => action.type === "REMOVE_STOP").map((action) => action.target));
  const services = serviceEvidence(text).filter((service) => !removedServices.has(service));
  const clarificationNeeded = !destination;
  return normalizePlan({
    origin,
    destination,
    arrivalDeadline,
    // An arrival reserve is opt-in. Do not carry a value from a previous trip
    // into a new natural-language request that did not mention one.
    minArrivalSoc,
    energyType,
    priority,
    maxDetourKm: detour,
    services,
    actions,
    requestMode,
    clarificationNeeded,
    assistantReply: clarificationNeeded ? "请告诉我目的地，我会结合路线、排队/停靠耗时和费用为你安排补能方案。" : "已识别你的出行约束，正在比较路线、排队/停靠耗时和补能成本。",
    aiUsed: false
  });
}

function hasPlannedRoute(context = {}) {
  return Boolean(context.hasPlannedRoute || context.currentDestination || context.destination);
}

function isCompositeServiceRequest(text) {
  const mentions = String(text || "").match(SERVICE_MENTION_PATTERN) || [];
  const serviceKinds = serviceEvidence(text);
  const hasWaypoint = findWaypoints(text).length > 0;
  const sequenceCue = /(?:先|然后|再|同时|并且|之后|之前|一边).{0,24}(?:吃|喝|餐|咖啡|休息|洗车|充电|加油|补能)/.test(text)
    || /(?:吃|喝|餐|咖啡|休息|洗车|充电|加油|补能).{0,24}(?:先|然后|再|同时|并且|之后)/.test(text);
  return serviceKinds.length >= 2 || mentions.length >= 2 || hasWaypoint && serviceKinds.length > 0 || sequenceCue;
}

function shouldUseAiForRequest(text, context, localResult) {
  const planned = hasPlannedRoute(context);
  const explicitDestination = Boolean(findDestination(text));
  const destinationReplacement = planned && destinationChangeCue(text);
  const reference = REFERENCE_CUE_PATTERN.test(text);
  const supplementCue = FOLLOW_UP_CUE_PATTERN.test(text);
  const localMutation = planned && !explicitDestination && localResult.actions.some((action) => [
    "ADD_SERVICE",
    "ADD_WAYPOINT",
    "REMOVE_STOP",
    "UPDATE_CONSTRAINT"
  ].includes(action.type));
  const uncertain = Boolean(localResult.clarificationNeeded)
    || reference
    || destinationReplacement
    || localMutation
    || planned && !explicitDestination && !supplementCue;

  // A short, explicit destination request is already covered by the local
  // parser. Avoid paying for a semantic round-trip when it cannot add a
  // route-affecting fact. Existing-trip replacements still go through AI so
  // the model can distinguish a new trip from a modification of the current
  // one, while local evidence remains authoritative afterwards.
  const simpleNewTrip = localResult.requestMode === "new_trip"
    && explicitDestination
    && !destinationReplacement
    && !reference
    && !isCompositeServiceRequest(text)
    && !localResult.clarificationNeeded;
  if (simpleNewTrip) return false;
  return uncertain || supplementCue || isCompositeServiceRequest(text) || !explicitDestination;
}

function analysisFactor(id, label, status, delta, evidence) {
  return {
    id,
    label,
    status: ["pass", "warn", "fail"].includes(status) ? status : "warn",
    delta: Number(delta) || 0,
    evidence: cleanText(evidence, 160)
  };
}

function aiProviderConfigured(config = {}) {
  const primary = Boolean(config.aiBaseUrl && config.aiApiKey && config.aiModel);
  const backup = Boolean(config.aiBackupBaseUrl && config.aiBackupApiKey && config.aiBackupModel);
  return primary || backup;
}

function safeAiReason({ configured, attempted, failure }) {
  if (!attempted) return null;
  if (!configured || failure?.code === "not_configured") return "not_configured";
  if (!failure) return null;
  if (failure.code === "quota") return "quota";
  if (failure.code === "network" || failure.code === "timeout") return "network";
  return "invalid_response";
}

const INTENT_COMPARISON_FIELDS = [
  ["origin", "起点"],
  ["destination", "终点"],
  ["arrivalDeadline", "到达时间"],
  ["minArrivalSoc", "到达余量"],
  ["energyType", "动力类型"],
  ["priority", "偏好"],
  ["maxDetourKm", "绕行上限"],
  ["services", "服务需求"],
  ["requestMode", "行程类型"],
  ["actions", "本轮动作"]
];

function publicIntentSnapshot(value = {}) {
  const numberOrNull = (input) => input === null || input === undefined || input === ""
    ? null
    : (Number.isFinite(Number(input)) ? Number(input) : null);
  return {
    origin: cleanText(value.origin, 80) || null,
    destination: canonicalDestination(value.destination) || cleanText(value.destination, 80) || null,
    arrivalDeadline: normalizeTime(value.arrivalDeadline),
    minArrivalSoc: numberOrNull(value.minArrivalSoc),
    energyType: ENERGY_TYPES.has(value.energyType) ? value.energyType : null,
    priority: PRIORITIES.has(value.priority) ? value.priority : null,
    maxDetourKm: numberOrNull(value.maxDetourKm),
    services: normalizeServices(value.services),
    requestMode: REQUEST_MODES.has(value.requestMode) ? value.requestMode : null,
    actions: normalizeActions(value.actions),
    clarificationNeeded: Boolean(value.clarificationNeeded)
  };
}

function comparableIntentValue(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function fieldValue(snapshot, field) {
  return publicIntentSnapshot({ [field]: snapshot?.[field] })[field];
}

function buildIntentComparison({
  text,
  localResult,
  aiResult,
  finalPlan,
  safeActions,
  aiRequested,
  aiFailure
} = {}) {
  const rules = publicIntentSnapshot(localResult);
  const model = aiResult ? publicIntentSnapshot(aiResult) : null;
  const final = publicIntentSnapshot(finalPlan);
  const comparedFields = INTENT_COMPARISON_FIELDS.map(([field]) => field);
  const matchingFields = model
    ? comparedFields.filter((field) => comparableIntentValue(rules[field]) === comparableIntentValue(model[field]))
    : [];
  const differences = model
    ? comparedFields
      .filter((field) => !matchingFields.includes(field))
      .map((field) => ({
        field,
        label: INTENT_COMPARISON_FIELDS.find(([name]) => name === field)?.[1] || field,
        rules: fieldValue(rules, field),
        ai: fieldValue(model, field)
      }))
    : [];
  const modelActionKeys = model ? new Set(model.actions.map(actionKey)) : new Set();
  const acceptedActionKeys = new Set((safeActions || []).map(actionKey));
  const rejectedActions = model
    ? model.actions.filter((action) => !acceptedActionKeys.has(actionKey(action)))
    : [];
  const safetyFields = ["destination", "arrivalDeadline", "minArrivalSoc", "energyType", "priority", "maxDetourKm"];
  const safetyChecks = safetyFields.map((field) => {
    const passed = comparableIntentValue(final[field]) === comparableIntentValue(rules[field]);
    return {
      field,
      label: INTENT_COMPARISON_FIELDS.find(([name]) => name === field)?.[1] || field,
      status: passed ? "pass" : "warn",
      evidence: passed ? "最终输入与本地规则一致" : "最终输入与本地规则存在差异，需人工确认"
    };
  });
  const safetyPassed = safetyChecks.every((check) => check.status === "pass");
  let status = "rules-only";
  let statusLabel = "本轮未调用模型 · 本地规则已足够";
  if (aiResult) {
    status = "compared";
    statusLabel = "AI 结果已与本地规则逐字段对比";
  } else if (aiRequested) {
    status = "fallback";
    statusLabel = "模型未返回 · 已使用本地规则降级";
  }
  return {
    originalText: cleanText(text, MAX_MESSAGE_LENGTH),
    status,
    statusLabel,
    rules,
    ai: model,
    final,
    comparedFields,
    fieldLabels: Object.fromEntries(INTENT_COMPARISON_FIELDS),
    agreement: {
      compared: Boolean(model),
      score: model ? Math.round((matchingFields.length / comparedFields.length) * 100) : null,
      matchingFields,
      differences,
      label: model ? `${matchingFields.length}/${comparedFields.length} 个字段一致` : statusLabel
    },
    actions: {
      accepted: (safeActions || []).map((action) => ({ ...action })),
      rejected: rejectedActions.map((action) => ({ ...action })),
      modelActionCount: modelActionKeys.size,
      acceptedActionCount: acceptedActionKeys.size
    },
    safety: {
      status: safetyPassed ? "passed" : "review",
      conclusion: safetyPassed
        ? "最终规划输入已通过本地规则校验；路线、能量、等待和运营数值仍由确定性计算器处理。"
        : "最终规划输入与本地规则存在差异，路线计算前需要人工确认。",
      checks: safetyChecks,
      aiFailureReason: safeAiReason({
        configured: Boolean(aiRequested),
        attempted: Boolean(aiRequested),
        failure: aiFailure
      })
    }
  };
}

function buildAnalysis(text, context, localResult, {
  config = {},
  aiRequested = false,
  aiUsed = false,
  aiFailure = null,
  destinationGeo = null
} = {}) {
  const planned = hasPlannedRoute(context);
  const explicitDestination = Boolean(findDestination(text));
  const services = serviceEvidence(text);
  const compositeService = isCompositeServiceRequest(text);
  const reference = REFERENCE_CUE_PATTERN.test(text);
  const explicitConstraints = localResult.actions.filter((action) => action.type === "UPDATE_CONSTRAINT");
  const factors = [];

  if (explicitDestination) {
    factors.push(analysisFactor("destination-evidence", "目的地证据", "pass", 28, "文本包含可被本地规则提取的明确目的地"));
  } else if (localResult.destination) {
    factors.push(analysisFactor("destination-evidence", "目的地证据", "warn", 14, "本轮未出现新目的地，沿用当前行程目的地"));
  } else {
    factors.push(analysisFactor("destination-evidence", "目的地证据", "fail", -30, "未识别到明确目的地，也没有可沿用的当前行程"));
  }

  if (localResult.requestMode === "new_trip" && explicitDestination) {
    factors.push(analysisFactor("request-mode", "行程类型", "pass", 20, "明确目的地被判定为新行程"));
  } else if (localResult.requestMode === "supplement" && planned && FOLLOW_UP_CUE_PATTERN.test(text)) {
    factors.push(analysisFactor("request-mode", "行程类型", "pass", 14, "检测到已有行程上的补充或修改意图"));
  } else {
    factors.push(analysisFactor("request-mode", "行程类型", "warn", -8, "行程类型缺少足够的本地语义证据"));
  }

  if (explicitConstraints.length) {
    factors.push(analysisFactor("constraint-evidence", "约束证据", "pass", 12, "时间、余量、能源或优先级来自用户明确表述"));
  } else {
    factors.push(analysisFactor("constraint-evidence", "约束证据", "pass", 8, "未检测到新增硬约束，未替用户补默认限制"));
  }

  if (compositeService) {
    factors.push(analysisFactor("service-evidence", "服务拆解", "warn", -6, "同一请求包含多个服务或服务与途经点组合，需要语义模型复核"));
  } else if (services.length === 1) {
    factors.push(analysisFactor("service-evidence", "服务拆解", "pass", 8, "服务类别可由本地关键词直接确认"));
  } else {
    factors.push(analysisFactor("service-evidence", "服务拆解", "pass", 6, "未检测到额外服务停靠要求"));
  }

  if (reference) {
    factors.push(analysisFactor("reference-resolution", "指代消解", "warn", -18, "文本包含这边、那里、上一个站等上下文指代"));
  } else {
    factors.push(analysisFactor("reference-resolution", "指代消解", "pass", 10, "未检测到需要跨轮次回指的表达"));
  }

  if (localResult.clarificationNeeded) {
    factors.push(analysisFactor("route-intent", "路线意图", "fail", -30, "本地规则无法形成可规划的目的地"));
  } else {
    factors.push(analysisFactor("route-intent", "路线意图", "pass", 15, "本地规则已形成可用于后续规划的目的地"));
  }

  const coordinate = parseCoordinate(destinationGeo?.coordinate);
  if (coordinate && !destinationGeo?.needsPick) {
    factors.push(analysisFactor("geographic-match", "地理匹配", "pass", 20, "目的地已有坐标且无需用户在候选中二次选择"));
  } else if (destinationGeo?.needsPick) {
    factors.push(analysisFactor("geographic-match", "地理匹配", "warn", -10, "存在多个地理候选，需要用户确认后再规划"));
  } else {
    factors.push(analysisFactor("geographic-match", "地理匹配", "fail", -25, "当前没有可确认的目的地坐标"));
  }

  const score = clamp(Math.round(factors.reduce((total, factor) => total + factor.delta, 0)), 0, 100);
  const configured = aiProviderConfigured(config);
  return {
    mode: aiRequested ? (aiUsed ? "hybrid" : "rules-fallback") : "rules",
    score,
    level: score >= 75 ? "high" : score >= 50 ? "medium" : "confirm",
    factors,
    ai: {
      configured,
      attempted: Boolean(aiRequested),
      used: Boolean(aiUsed),
      fallback: Boolean(aiRequested && !aiUsed),
      reason: safeAiReason({ configured, attempted: aiRequested, failure: aiFailure })
    }
  };
}

function normalizePlan(raw, { aiUsed = Boolean(raw?.aiUsed) } = {}) {
  const energyType = ENERGY_TYPES.has(raw?.energyType) ? raw.energyType : "unknown";
  const priority = PRIORITIES.has(raw?.priority) ? raw.priority : "balanced";
  const requestMode = REQUEST_MODES.has(raw?.requestMode) ? raw.requestMode : "new_trip";
  const services = normalizeServices(raw?.services);
  const actions = normalizeActions(raw?.actions);
  return {
    origin: cleanText(raw?.origin || DEFAULT_ORIGIN.name, 80) || DEFAULT_ORIGIN.name,
    destination: canonicalDestination(raw?.destination),
    arrivalDeadline: normalizeTime(raw?.arrivalDeadline),
    minArrivalSoc: cleanNumber(raw?.minArrivalSoc, 5, 100),
    energyType,
    priority,
    maxDetourKm: cleanNumber(raw?.maxDetourKm, 0, 100),
    services,
    actions,
    requestMode,
    clarificationNeeded: Boolean(raw?.clarificationNeeded) || !raw?.destination,
    assistantReply: cleanText(raw?.assistantReply, 240) || "已生成补能规划条件。",
    aiUsed,
    parser: aiUsed ? "ai-model" : "local-fallback"
  };
}

function extractJson(content) {
  if (typeof content !== "string") return null;
  const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  return null;
}

function contextForPrompt(context) {
  if (!context || typeof context !== "object") return {};
  // explicitDestination / destinationLocation are used by the destination
  // picker path and must not be stripped before resolvePlace.
  const allowed = ["origin", "destination", "currentOrigin", "currentDestination", "currentServices", "hasPlannedRoute", "arrivalDeadline", "minArrivalSoc", "energyType", "priority", "maxDetourKm", "services", "explicitDestination", "destinationLocation"];
  return Object.fromEntries(allowed.filter((key) => context[key] !== undefined).map((key) => [key, context[key]]));
}

// Never let a provider error body echo a credential into logs or the browser.
function scrubSecrets(text) {
  return String(text || "")
    .replace(/\b(sk|ark|key)-[A-Za-z0-9_-]{6,}/gi, "$1-***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .slice(0, 200);
}

// Map a provider failure onto a stable code so the UI can say *why* the model
// was skipped instead of silently degrading to the local rule parser.
function classifyAiFailure(status, bodyText) {
  const body = String(bodyText || "").toLowerCase();
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || /insufficient|balance|arrears/.test(body)) return "billing";
  if (status === 429 || /quota|rate.?limit|too many/.test(body)) return "quota";
  if (status === 404 || /model.*(not found|not exist|unknown)/.test(body)) return "bad_model";
  if (status >= 500) return "provider_error";
  return "http_error";
}

export const AI_FAILURE_TEXT = {
  not_configured: "未配置 AI 服务，已用本地规则解析",
  auth: "AI 鉴权失败，已用本地规则解析",
  billing: "AI 账户余额不足，已用本地规则解析",
  quota: "AI 配额已用尽，已用本地规则解析",
  bad_model: "AI 模型名不可用，已用本地规则解析",
  provider_error: "AI 服务端异常，已用本地规则解析",
  http_error: "AI 接口返回异常，已用本地规则解析",
  timeout: "AI 响应超时，已用本地规则解析",
  network: "AI 网络不可达，已用本地规则解析",
  bad_json: "AI 未返回合法 JSON，已用本地规则解析"
};

const AI_SYSTEM_PROMPT = "你是 FlowTwin 出行规划解析器。只输出合法 JSON，不要 Markdown，不要解释。字段必须为 origin,destination,arrivalDeadline,minArrivalSoc,energyType,priority,maxDetourKm,services,requestMode,actions,clarificationNeeded,assistantReply。actions 是本轮相对于当前行程的结构化增量数组，只能使用 ADD_SERVICE、ADD_WAYPOINT、REMOVE_STOP、CHANGE_DESTINATION、UPDATE_CONSTRAINT、NEW_TRIP。动作格式：ADD_SERVICE={service,name?,location?}、ADD_WAYPOINT={location}、REMOVE_STOP={target,name?}、CHANGE_DESTINATION={destination}、UPDATE_CONSTRAINT={constraint,value}、NEW_TRIP={origin?,destination}。只提取用户明确说出的增量；保留品牌和地点原文，不要把麦当劳泛化成餐饮名称。没有既有行程时填 new_trip；已有行程且用户只是增加服务、途经点、删除停靠点或更新条件，且没有替换目的地时填 supplement；用户明确说‘我想去南京’、‘重新去南京’等重新开始时填 new_trip；‘把目的地改成杭州’应使用 CHANGE_DESTINATION。当前出发时间和当前油电量由车机顶部控件管理，不要从用户文本解析、不要输出、也不要覆盖它们。只有用户明确说出的时间、到达余量、绕行上限、能源类型或优先级才能生成 UPDATE_CONSTRAINT，禁止凭空增加硬约束。不要计算路线、距离、ETA、站点顺序、坐标或补能方案。补充行程时不要把服务名称当成目的地，destination 可沿用当前目的地。energyType 只能是 electric、fuel、mixed、unknown；priority 只能是 on_time、fastest、cheapest、wait、balanced。缺失字段用 null，无法安全解析的动作填空数组，缺少目的地且没有既有行程时 clarificationNeeded=true。";
const AI_FAILOVER_CODES = new Set([
  "auth",
  "billing",
  "quota",
  "bad_model",
  "provider_error",
  "http_error",
  "timeout",
  "network",
  "bad_json"
]);

async function requestAiProvider(message, context, provider, fetchImpl) {
  if (!provider.apiKey || !provider.baseUrl || !provider.model) {
    return { plan: null, failure: { code: "not_configured", detail: "" }, provider: provider.name };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: AI_SYSTEM_PROMPT
          },
          {
            role: "user",
            content: JSON.stringify({ message: cleanText(message, MAX_MESSAGE_LENGTH), context: contextForPrompt(context) })
          }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      let bodyText = "";
      try { bodyText = await response.text(); } catch {}
      const code = classifyAiFailure(response.status, bodyText);
      return { plan: null, failure: { code, status: response.status, detail: scrubSecrets(bodyText) } };
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { plan: null, failure: { code: "bad_json", detail: "invalid provider response" }, provider: provider.name };
    }
    const content = payload?.choices?.[0]?.message?.content;
    const parsed = extractJson(content);
    if (!parsed) {
      return { plan: null, failure: { code: "bad_json", detail: scrubSecrets(content).slice(0, 120) }, provider: provider.name };
    }
    return { plan: normalizePlan(parsed, { aiUsed: true }), failure: null, provider: provider.name };
  } catch (error) {
    const code = error?.name === "AbortError" || error?.name === "TimeoutError" ? "timeout" : "network";
    return { plan: null, failure: { code, detail: scrubSecrets(error?.message) }, provider: provider.name };
  } finally {
    clearTimeout(timer);
  }
}

async function aiParse(message, context, config, fetchImpl) {
  const providers = [
    {
      name: "primary",
      baseUrl: config.aiBaseUrl,
      apiKey: config.aiApiKey,
      model: config.aiModel
    },
    {
      name: "backup",
      baseUrl: config.aiBackupBaseUrl,
      apiKey: config.aiBackupApiKey,
      model: config.aiBackupModel
    }
  ];
  let lastFailure = { code: "not_configured", detail: "" };
  for (const provider of providers) {
    const result = await requestAiProvider(message, context, provider, fetchImpl);
    if (result.plan) return result;
    if (result.failure?.code !== "not_configured") lastFailure = result.failure;
    // A configured backup is useful for provider outages, quota exhaustion,
    // incompatible response features, and malformed model output. Do not
    // silently turn a successful primary request into a second paid request.
    if (result.failure?.code !== "not_configured" && !AI_FAILOVER_CODES.has(result.failure?.code)) break;
  }
  return { plan: null, failure: lastFailure, provider: null };
}

function parseCoordinate(value) {
  if (Array.isArray(value) && value.length >= 2 && value.every((item) => Number.isFinite(Number(item)))) return [Number(value[0]), Number(value[1])];
  if (typeof value === "string") {
    const parts = value.split(",").map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) return parts;
  }
  return null;
}

function isSafePlace(value) {
  return typeof value === "string" && value.length >= 2 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value) && !/^https?:\/\//i.test(value);
}

function fieldText(value) {
  if (Array.isArray(value)) return cleanText(value.find(Boolean) || "", 80);
  return cleanText(value || "", 80);
}

function coordinateKey(coordinate) {
  if (!coordinate) return "";
  return `${Number(coordinate[0]).toFixed(5)},${Number(coordinate[1]).toFixed(5)}`;
}

function namesDifferALot(left, right) {
  const a = cleanText(left || "", 80);
  const b = cleanText(right || "", 80);
  if (!a || !b || a === b) return false;
  if (a.includes(b) || b.includes(a)) return false;
  return true;
}

export function scorePlaceCandidate(candidate, query) {
  let score = 0;
  const name = cleanText(candidate?.name || "", 80);
  const type = `${candidate?.type || ""} ${candidate?.typecode || ""}`.toLowerCase();
  const level = cleanText(candidate?.level || "", 40);
  const normalizedQuery = cleanText(query || "", 80);

  if (name && normalizedQuery && name.includes(normalizedQuery)) score += 30;
  if (name && normalizedQuery && name === normalizedQuery) score += 25;
  if (name && normalizedQuery && normalizedQuery.includes(name) && name.length >= 2) score += 10;
  if (/风景区|风景名胜区|景区|旅游区/.test(name)) score += 40;
  if (/机场|国际机场/.test(name)) score += 35;
  // Prefer university campuses over same-name metro exits when the user says "大学".
  if (/大学|学院/.test(name)) score += 45;
  if (/火车站|高铁站|汽车站|客运站/.test(name)) score += 30;
  else if (/地铁站|轻轨站|轨交/.test(name) || /地铁|轨道交通/.test(type)) score -= 25;
  else if (/站$/.test(name)) score += 12;
  if (/博物院|博物馆|公园|塔$|寺$|庙$/.test(name)) score += 25;
  if (/风景|名胜|旅游|scenic|tourism|1100|1102/.test(type)) score += 35;
  if (/科教文化|高等院校|学校|1412|141201/.test(type)) score += 40;
  if (/交通|机场|火车站|transport|1500|1501|1502/.test(type) && !/地铁|轨交/.test(type)) score += 30;
  if (candidate?.province && candidate?.city) score += 10;
  if (candidate?.city) score += 5;
  if (candidate?.source === "高德地点检索") score += 5;
  if (level === "兴趣点" || level === "门牌号" || level === "热点商圈") score += 15;
  // Demoting administrative hits keeps "北京南站" off "北京市". But when the
  // driver typed a bare city name, the city *is* the answer — without this
  // waiver "去天津" ranks 天津南站/西站/站 above 天津市 and asks which station.
  const adminCore = name.replace(/(省|市|自治区|特别行政区|区|县)$/, "");
  const queryIsThisAdmin = Boolean(
    normalizedQuery
    && /^(省|市|区县|区|县|直辖市|自治区|特别行政区|开发区)$/.test(level)
    && (normalizedQuery === name || normalizedQuery === adminCore)
  );
  if (queryIsThisAdmin) score += 70;
  else {
    if (level === "省" || level === "市" || level === "区县" || level === "开发区") score -= 40;
    if (/^(省|市|区|县|自治区|特别行政区)$/.test(level)) score -= 20;
  }
  if (level === "道路" || level === "乡镇" || level === "村庄") score -= 25;
  return score;
}

async function fetchGeocodeCandidates(place, config, fetchImpl) {
  const params = new URLSearchParams({ address: place, output: "json" });
  const load = async () => {
    const result = await requestAmapJson("https://restapi.amap.com/v3/geocode/geo", params, { config, fetchImpl, timeoutMs: 10000 });
    const payload = result.payload;
    if (!result.ok || !Array.isArray(payload?.geocodes)) throw new Error(result.error || "AMAP_GEOCODE_FAILED");
    return payload.geocodes.slice(0, 5).map((item) => {
      const coordinate = parseCoordinate(item.location);
      if (!coordinate) return null;
      return {
        coordinate,
        name: fieldText(item.formatted_address || item.address || place),
        city: fieldText(item.city),
        province: fieldText(item.province),
        district: fieldText(item.district),
        level: fieldText(item.level),
        type: fieldText(item.level),
        source: "高德地理编码"
      };
    }).filter(Boolean);
  };
  try {
    if (config?.amapCache) {
      const cached = await config.amapCache.getOrLoad("geocode", params.toString(), load, {
        ttlMs: AMAP_CACHE_TTLS.geocode,
        staleIfErrorMs: 30 * 24 * 60 * 60 * 1000
      });
      return Array.isArray(cached.value) ? cached.value : [];
    }
    return await load();
  } catch {
    return [];
  }
}

async function fetchPlaceCandidates(place, config, fetchImpl) {
  const params = new URLSearchParams({
    keywords: place,
    citylimit: "false",
    offset: "5",
    page: "1",
    extensions: "base"
  });
  const load = async () => {
    const result = await requestAmapJson("https://restapi.amap.com/v3/place/text", params, { config, fetchImpl, timeoutMs: 10000 });
    const payload = result.payload;
    if (!result.ok || !Array.isArray(payload?.pois)) throw new Error(result.error || "AMAP_PLACE_FAILED");
    return payload.pois.slice(0, 5).map((poi) => {
      const coordinate = parseCoordinate(poi.location);
      if (!coordinate) return null;
      return {
        coordinate,
        name: fieldText(poi.name || place),
        city: fieldText(poi.cityname),
        province: fieldText(poi.pname),
        district: fieldText(poi.adname),
        type: fieldText(poi.type),
        typecode: fieldText(poi.typecode),
        level: "",
        source: "高德地点检索"
      };
    }).filter(Boolean);
  };
  try {
    if (config?.amapCache) {
      const cached = await config.amapCache.getOrLoad("place", params.toString(), load, {
        ttlMs: AMAP_CACHE_TTLS.place,
        staleIfErrorMs: 30 * 24 * 60 * 60 * 1000
      });
      return Array.isArray(cached.value) ? cached.value : [];
    }
    return await load();
  } catch {
    return [];
  }
}

function dedupeCandidates(candidates) {
  const byKey = new Map();
  for (const candidate of candidates) {
    const key = `${coordinateKey(candidate.coordinate)}|${candidate.name}`;
    const existing = byKey.get(key);
    // Geocode and POI search routinely return the same place at the same point.
    // Keeping the first hit let the low-scoring POI copy shadow the geocode one,
    // which is how "去天津" ended up ranking 天津南站 above 天津市.
    if (!existing || Number(candidate.score || 0) > Number(existing.score || 0)) byKey.set(key, candidate);
  }
  return Array.from(byKey.values());
}

// "东方明珠广播电视塔(西门)" and "…(东北门)" are the same destination. Comparing
// the bare core keeps a gate list from being presented as a real choice.
function placeCoreName(value) {
  return cleanText(value || "", 80)
    .replace(/\s+/g, "")
    .replace(/[（(][^）)]*[)）]/g, "")
    .replace(/[-—·]\S*$/, "");
}

function isExactPlaceMatch(query, resolvedName) {
  const q = cleanText(query || "", 80).replace(/\s+/g, "");
  const n = cleanText(resolvedName || "", 80).replace(/\s+/g, "");
  if (!q || !n) return false;
  if (q === n) return true;
  // "华山" → "华山风景区" is an accepted expansion of a short landmark query.
  if (q.length >= 2 && n.startsWith(q) && /风景区|风景名胜区|博物院|大学|学院|机场|火车站|高铁站$/.test(n)) return true;
  // "上海东方明珠广播电视塔" → "东方明珠广播电视塔": the driver spelled out a
  // city prefix the POI name omits. Very common in Chinese input, and not
  // ambiguity — asking here makes the stock demo prompt open on a picker.
  if (n.length >= 4 && q.endsWith(n) && q.length - n.length <= 6) return true;
  if (q.length >= 4 && n.endsWith(q) && n.length - q.length <= 6) return true;
  return false;
}

// A geocode hit at province/city/district level answers a city-level query such
// as "天津" outright; there is nothing for the driver to disambiguate.
function isAdministrativeMatch(query, candidate) {
  const level = cleanText(candidate?.level || "", 40);
  if (!/^(省|市|区县|区|县|直辖市)$/.test(level)) return false;
  const q = cleanText(query || "", 80).replace(/\s+/g, "");
  const n = cleanText(candidate?.name || "", 80).replace(/\s+/g, "");
  return Boolean(q && n && (n.startsWith(q) || q.startsWith(n)));
}

function toPublicCandidate(candidate) {
  return {
    name: candidate.name,
    coordinate: candidate.coordinate,
    location: candidate.coordinate,
    city: candidate.city || null,
    district: candidate.district || null,
    score: candidate.score,
    source: candidate.source,
    address: [candidate.city, candidate.district].filter(Boolean).join(" · ") || null
  };
}

export async function resolvePlace(place, config, fetchImpl = fetch) {
  const query = canonicalDestination(place) || cleanText(place, 80);
  if (!isSafePlace(query) || !hasAmapServiceKey(config) || query === DEFAULT_ORIGIN.name) return null;

  const [geoCandidates, placeCandidates] = await Promise.all([
    fetchGeocodeCandidates(query, config, fetchImpl),
    fetchPlaceCandidates(query, config, fetchImpl)
  ]);

  // Score before dedupe so the higher-scoring copy of a duplicated place wins.
  const scored = dedupeCandidates(
    [...placeCandidates, ...geoCandidates].map((candidate) => ({ ...candidate, score: scorePlaceCandidate(candidate, query) }))
  ).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "zh-CN"));

  if (!scored.length) return null;

  const best = scored[0];
  const second = scored[1];
  const uniqueNames = [];
  for (const item of scored) {
    if (!uniqueNames.some((name) => name === item.name)) uniqueNames.push(item.name);
    if (uniqueNames.length >= 3) break;
  }
  const list = scored
    .filter((item, index, arr) => arr.findIndex((other) => other.name === item.name) === index)
    .slice(0, 3)
    .map(toPublicCandidate);

  const exact = isExactPlaceMatch(query, best.name) || isAdministrativeMatch(query, best);
  // Entrances/gates of one venue are not competing destinations.
  const sameVenue = list.length >= 2 && new Set(list.map((item) => placeCoreName(item.name))).size === 1;
  const closeRace = Boolean(second && best.score - second.score < AMBIGUITY_SCORE_GAP && namesDifferALot(best.name, second.name));
  const softMismatch = Boolean(
    list.length >= 2
    && !exact
    && (best.score - (second?.score || 0) < SOFT_CONFIRM_SCORE_GAP || namesDifferALot(best.name, second?.name))
  );
  // Let the driver pick when the top hit is not an exact expansion, or when two
  // hits are too close — e.g. a same-name university campus and metro station.
  const needsPick = !sameVenue && (closeRace || softMismatch);

  return {
    coordinate: best.coordinate,
    source: best.source,
    name: best.name || query,
    city: best.city || null,
    score: best.score,
    needsPick,
    candidates: list.length >= 2 ? list : []
  };
}

export async function parseTripIntent({ message, context = {}, config, fetchImpl = fetch } = {}) {
  const safeMessage = cleanText(message, MAX_MESSAGE_LENGTH);
  const serializedContext = JSON.stringify(contextForPrompt(context));
  const safeContext = serializedContext.length <= MAX_CONTEXT_LENGTH ? JSON.parse(serializedContext) : {};
  // Always establish a local, evidence-bearing parse first. It is both the
  // cost gate and the veto layer for every model response.
  const localResult = localParse(safeMessage, safeContext);
  const aiRequested = shouldUseAiForRequest(safeMessage, safeContext, localResult);
  const { plan: aiResult, failure: aiFailure } = aiRequested
    ? await aiParse(safeMessage, safeContext, config || {}, fetchImpl)
    : { plan: null, failure: null };
  if (aiFailure && aiFailure.code !== "not_configured") {
    // Keep diagnostics stable and opaque. The API already exposes a safe,
    // user-facing fallback label; never echo provider URLs or response bodies.
    console.warn(`[ai] parse failed code=${aiFailure.code}`);
  }
  const safeActions = enrichConcreteServiceActionNames(
    aiResult ? validatedActions(aiResult.actions, localResult.actions) : localResult.actions,
    safeMessage
  );
  const plan = aiResult ? normalizePlan({
    ...aiResult,
    // The explicit route wording is more trustworthy than a stale model/context
    // completion. This also keeps a previous demo destination from leaking into
    // a new request such as "前往燕郊站".
    origin: aiResult.origin || localResult.origin,
    destination: localResult.destination,
    // Hard arrival constraints must be present in the user's wording. A model
    // is allowed to explain trade-offs, but must not invent a deadline or SOC.
    arrivalDeadline: localResult.arrivalDeadline,
    minArrivalSoc: localResult.minArrivalSoc,
    energyType: localResult.energyType,
    priority: localResult.priority,
    // A model must not invent a hard detour cap that the user never asked for.
    // Only the local parser accepts an explicit detour-cap constraint.
    maxDetourKm: localResult.maxDetourKm,
    services: servicesWithLocalEvidence(aiResult.services, localResult.services, safeMessage, safeActions),
    actions: safeActions,
    // Local cues have veto power for an explicit destination or a service-only
    // follow-up. For wording that contains neither, let the model's
    // requestMode classification decide instead of hard-coding every second
    // turn as a supplement.
    requestMode: !safeContext.hasPlannedRoute
      ? "new_trip"
      : findDestination(safeMessage)
        || /(?:把|将)?目的地\s*(?:改|换)|(?:改|换)(?:去|到|成)\s*(?!最晚|截止|不晚于|至少|最多|不超过|不超|允许)|换个目的地|重新(?:规划|安排|出发)|新行程|另一个目的地|目的地(?:改|换)/.test(safeMessage)
        ? "new_trip"
        : /中途|途中|路上|顺便|另外|还想|再加|补充|加上|吃饭|吃点|吃个|用餐|午饭|午餐|晚饭|晚餐|早餐|餐厅|咖啡|休息|洗车|加油|充电|补能|少走|不走|尽量|再安排/.test(safeMessage)
          ? "supplement"
          : (REQUEST_MODES.has(aiResult.requestMode) && !(aiResult.requestMode === "new_trip" && localResult.requestMode === "supplement")
            ? aiResult.requestMode
            : localResult.requestMode),
    clarificationNeeded: !localResult.destination,
    aiUsed: true,
    assistantReply: aiResult.assistantReply === "已生成补能规划条件。"
      ? "已理解你的出行要求，正在结合真实道路、沿线站点与未来排队风险生成方案。"
      : aiResult.assistantReply
  }, { aiUsed: true }) : localResult;

  // A frontend destination picker may pass an already-chosen place name and
  // coordinate. Prefer that over another ambiguous geocode round-trip.
  const explicitDestination = cleanText(safeContext.explicitDestination, 80);
  if (explicitDestination) {
    plan.destination = canonicalDestination(explicitDestination) || explicitDestination;
    plan.clarificationNeeded = false;
  }
  const explicitCoordinate = parseCoordinate(safeContext.destinationLocation);

  const originGeo = plan.origin === DEFAULT_ORIGIN.name
    ? { coordinate: DEFAULT_ORIGIN.coordinate, source: DEFAULT_ORIGIN.source }
    : await resolvePlace(plan.origin, config || {}, fetchImpl);
  let destinationGeo = null;
  if (plan.destination && explicitCoordinate) {
    destinationGeo = {
      coordinate: explicitCoordinate,
      source: "用户选定候选",
      name: plan.destination,
      city: null,
      score: 100
    };
  } else if (plan.destination) {
    destinationGeo = await resolvePlace(plan.destination, config || {}, fetchImpl);
  }
  const analysis = buildAnalysis(safeMessage, safeContext, localResult, {
    config: config || {},
    aiRequested,
    aiUsed: Boolean(aiResult),
    aiFailure,
    destinationGeo
  });
  analysis.comparison = buildIntentComparison({
    text: safeMessage,
    localResult,
    aiResult,
    finalPlan: plan,
    safeActions,
    aiRequested,
    aiFailure
  });
  return {
    ...plan,
    analysis,
    aiFailureCode: aiFailure?.code || null,
    locations: {
      origin: originGeo,
      destination: destinationGeo
    }
  };
}

function sanitizeAnalysis(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const factors = Array.isArray(value.factors)
    ? value.factors.map((factor) => ({
      id: cleanText(factor?.id, 48),
      label: cleanText(factor?.label, 80),
      status: ["pass", "warn", "fail"].includes(factor?.status) ? factor.status : "warn",
      delta: Number.isFinite(Number(factor?.delta)) ? Number(factor.delta) : 0,
      evidence: cleanText(factor?.evidence, 160)
    })).filter((factor) => factor.id && factor.label)
    : [];
  const score = Number.isFinite(Number(value.score)) ? clamp(Number(value.score), 0, 100) : 0;
  const level = ["high", "medium", "confirm"].includes(value.level) ? value.level : "confirm";
  const mode = ["rules", "hybrid", "rules-fallback"].includes(value.mode) ? value.mode : "rules";
  const reason = SAFE_AI_REASONS.has(value.ai?.reason) ? value.ai.reason : null;
  const comparison = value.comparison && typeof value.comparison === "object"
    ? sanitizeIntentComparison(value.comparison)
    : null;
  return {
    mode,
    score,
    level,
    factors,
    ai: {
      configured: Boolean(value.ai?.configured),
      attempted: Boolean(value.ai?.attempted),
      used: Boolean(value.ai?.used),
      fallback: Boolean(value.ai?.fallback),
      reason
    },
    ...(comparison ? { comparison } : {})
  };
}

function sanitizeIntentComparison(value) {
  const allowedStatuses = new Set(["rules-only", "compared", "fallback"]);
  const allowedSafetyStatuses = new Set(["passed", "review"]);
  const safeSnapshot = (snapshot) => snapshot && typeof snapshot === "object"
    ? publicIntentSnapshot(snapshot)
    : null;
  const safeField = (input, field) => fieldValue(safeSnapshot(input), field);
  const safeDifferences = Array.isArray(value.agreement?.differences)
    ? value.agreement.differences.slice(0, INTENT_COMPARISON_FIELDS.length).map((difference) => ({
      field: INTENT_COMPARISON_FIELDS.some(([name]) => name === difference.field) ? difference.field : "unknown",
      label: cleanText(difference.label, 40),
      rules: safeField(value.rules, difference.field),
      ai: safeField(value.ai, difference.field)
    }))
    : [];
  const safeChecks = Array.isArray(value.safety?.checks)
    ? value.safety.checks.slice(0, 8).map((check) => ({
      field: INTENT_COMPARISON_FIELDS.some(([name]) => name === check.field) ? check.field : "unknown",
      label: cleanText(check.label, 40),
      status: check.status === "pass" ? "pass" : "warn",
      evidence: cleanText(check.evidence, 120)
    }))
    : [];
  return {
    originalText: cleanText(value.originalText, MAX_MESSAGE_LENGTH),
    status: allowedStatuses.has(value.status) ? value.status : "rules-only",
    statusLabel: cleanText(value.statusLabel, 120),
    rules: safeSnapshot(value.rules),
    ai: safeSnapshot(value.ai),
    final: safeSnapshot(value.final),
    comparedFields: INTENT_COMPARISON_FIELDS.map(([field]) => field),
    fieldLabels: Object.fromEntries(INTENT_COMPARISON_FIELDS),
    agreement: {
      compared: Boolean(value.agreement?.compared),
      score: Number.isFinite(Number(value.agreement?.score)) ? Number(value.agreement.score) : null,
      matchingFields: Array.isArray(value.agreement?.matchingFields)
        ? value.agreement.matchingFields.filter((field) => INTENT_COMPARISON_FIELDS.some(([name]) => name === field))
        : [],
      differences: safeDifferences,
      label: cleanText(value.agreement?.label, 100)
    },
    actions: {
      accepted: normalizeActions(value.actions?.accepted),
      rejected: normalizeActions(value.actions?.rejected),
      modelActionCount: Math.max(0, Math.min(8, Number(value.actions?.modelActionCount) || 0)),
      acceptedActionCount: Math.max(0, Math.min(8, Number(value.actions?.acceptedActionCount) || 0))
    },
    safety: {
      status: allowedSafetyStatuses.has(value.safety?.status) ? value.safety.status : "review",
      conclusion: cleanText(value.safety?.conclusion, 220),
      checks: safeChecks,
      aiFailureReason: SAFE_AI_REASONS.has(value.safety?.aiFailureReason) ? value.safety.aiFailureReason : null
    }
  };
}

export function formatPlanResponse(result) {
  const { locations = {}, aiFailureCode = null, analysis = null, ...parsed } = result || {};
  const resolvedDestinationName = cleanText(locations.destination?.name || "", 80);
  const candidates = Array.isArray(locations.destination?.candidates)
    ? locations.destination.candidates
    : [];
  const needsPick = Boolean(locations.destination?.needsPick) && candidates.length >= 2;
  const userQuery = cleanText(parsed.destination || "", 80);
  return {
    analysis: sanitizeAnalysis(analysis),
    parsed: {
      ...parsed,
      actions: normalizeActions(parsed.actions),
      // Keep the user-facing pick list from blocking with a half-chosen name.
      destination: needsPick
        ? (userQuery || resolvedDestinationName || null)
        : (resolvedDestinationName || parsed.destination || null),
      assistantReply: needsPick
        ? `“${userQuery || "该地点"}”不完全吻合单一地点，请从下列 ${candidates.length} 个候选中选择后再规划。`
        : parsed.assistantReply
    },
    // Sanitized reason only — never the provider body, status, or credential.
    aiFallbackReason: aiFailureCode ? (AI_FAILURE_TEXT[aiFailureCode] || AI_FAILURE_TEXT.http_error) : null,
    originLocation: locations.origin?.coordinate || null,
    // Do not auto-commit an ambiguous destination; force the driver to pick.
    destinationLocation: needsPick ? null : (locations.destination?.coordinate || null),
    locationSources: {
      origin: locations.origin?.source || null,
      destination: needsPick ? "待用户确认" : (locations.destination?.source || null)
    },
    destinationCandidates: candidates,
    destinationNeedsPick: needsPick
  };
}

export const INTENT_ACTION_TYPES = ACTION_TYPES;
export const planLimits = { MAX_MESSAGE_LENGTH, MAX_CONTEXT_LENGTH };
