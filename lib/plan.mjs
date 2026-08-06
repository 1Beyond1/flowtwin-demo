import { DEFAULT_ORIGIN } from "./config.mjs";
import { hasAmapServiceKey, requestAmapJson } from "./amap.mjs";

const MAX_MESSAGE_LENGTH = 1200;
const MAX_CONTEXT_LENGTH = 8000;
const ENERGY_TYPES = new Set(["electric", "fuel", "mixed", "unknown"]);
const PRIORITIES = new Set(["on_time", "fastest", "cheapest", "wait", "balanced"]);
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

function normalizeServices(values) {
  if (!Array.isArray(values)) return [];
  const canonical = values.map((value) => {
    const text = cleanText(value, 30);
    if (/吃饭|餐厅|咖啡|餐饮/.test(text)) return "餐饮";
    if (/洗车/.test(text)) return "洗车";
    if (/休息|卫生间/.test(text)) return "休息";
    return text;
  }).filter(Boolean);
  return Array.from(new Set(canonical)).slice(0, 6);
}

function findArrivalSoc(text) {
  const match = text.match(/(?:到达|抵达|终点|最后)[^%]{0,50}?(?:至少|要有|保持|保留|不低于|大于|超过|以上|剩余)[^%]{0,12}?(\d{1,3})\s*%/i);
  return cleanNumber(match?.[1], 5, 100);
}

function findDestination(text) {
  // Prefer the last explicit destination phrase. It lets a user replace the
  // prefilled demo route by appending "去燕郊站" instead of being pinned to
  // the earlier airport wording.
  const directMatches = Array.from(text.matchAll(/(?:前往|去|抵达|目的地(?:是)?|到(?!达))[\s:：]*([^，,。；;\n]{2,40})/g));
  const direct = cleanText(directMatches.at(-1)?.[1] || "", 80).replace(/(，|,|然后|并且|最好).*/, "");
  if (direct) return direct;
  const knownPlaces = [
    "北京大兴国际机场", "大兴国际机场", "大兴机场", "首都国际机场", "首都机场",
    "北京南站", "北京站", "北京西站", "北京朝阳站", "天津滨海国际机场", "天津机场"
  ];
  const known = knownPlaces
    .map((place) => ({ place, index: text.lastIndexOf(place) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => b.index - a.index)[0];
  return known?.place || null;
}

function findOrigin(text) {
  const match = text.match(/从([^，,。；;\n]{2,40})(?:出发|到|去|前往)/);
  return cleanText(match?.[1] || "", 80) || DEFAULT_ORIGIN.name;
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
  const services = [
    ["餐饮", /吃饭|餐饮|餐厅|咖啡/],
    ["洗车", /洗车/],
    ["休息", /休息|休息区|卫生间/]
  ].filter(([, matcher]) => matcher.test(text)).map(([name]) => name);
  const destination = findDestination(text) || cleanText(context.destination, 80) || null;
  const origin = findOrigin(text) || cleanText(context.origin, 80) || DEFAULT_ORIGIN.name;
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
    clarificationNeeded,
    assistantReply: clarificationNeeded ? "请告诉我目的地，我会结合路线、等待和费用为你安排补能方案。" : "已识别你的出行约束，正在比较路线、站点等待和补能成本。",
    aiUsed: false
  });
}

function normalizePlan(raw, { aiUsed = Boolean(raw?.aiUsed) } = {}) {
  const energyType = ENERGY_TYPES.has(raw?.energyType) ? raw.energyType : "unknown";
  const priority = PRIORITIES.has(raw?.priority) ? raw.priority : "balanced";
  const services = normalizeServices(raw?.services);
  return {
    origin: cleanText(raw?.origin || DEFAULT_ORIGIN.name, 80) || DEFAULT_ORIGIN.name,
    destination: canonicalDestination(raw?.destination),
    arrivalDeadline: normalizeTime(raw?.arrivalDeadline),
    minArrivalSoc: cleanNumber(raw?.minArrivalSoc, 5, 100),
    energyType,
    priority,
    maxDetourKm: cleanNumber(raw?.maxDetourKm, 0, 100),
    services,
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
  const allowed = ["origin", "destination", "arrivalDeadline", "minArrivalSoc", "energyType", "priority", "maxDetourKm", "services", "explicitDestination", "destinationLocation"];
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

async function aiParse(message, context, config, fetchImpl) {
  if (!config.aiApiKey || !config.aiBaseUrl || !config.aiModel) {
    return { plan: null, failure: { code: "not_configured", detail: "" } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(`${config.aiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.aiApiKey}`
      },
      body: JSON.stringify({
        model: config.aiModel,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "你是 FlowTwin 出行规划解析器。只输出合法 JSON，不要 Markdown，不要解释。字段必须为 origin,destination,arrivalDeadline,minArrivalSoc,energyType,priority,maxDetourKm,services,clarificationNeeded,assistantReply。当前出发时间和当前油电量由车机顶部控件管理，不要从用户文本解析、不要输出、也不要覆盖它们。minArrivalSoc 是用户要求到达目的地时至少保留的油电量。energyType 只能是 electric、fuel、mixed、unknown，混动/插电混动/油电两用车填 mixed；priority 只能是 on_time、fastest、cheapest、wait、balanced。缺失字段用 null，缺少目的地时 clarificationNeeded=true。"
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
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const parsed = extractJson(content);
    if (!parsed) {
      return { plan: null, failure: { code: "bad_json", detail: scrubSecrets(content).slice(0, 120) } };
    }
    return { plan: normalizePlan(parsed, { aiUsed: true }), failure: null };
  } catch (error) {
    const code = error?.name === "AbortError" || error?.name === "TimeoutError" ? "timeout" : "network";
    return { plan: null, failure: { code, detail: scrubSecrets(error?.message) } };
  } finally {
    clearTimeout(timer);
  }
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
  try {
    const result = await requestAmapJson("https://restapi.amap.com/v3/geocode/geo", params, { config, fetchImpl, timeoutMs: 10000 });
    const payload = result.payload;
    if (!result.ok || !Array.isArray(payload?.geocodes)) return [];
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
  try {
    const result = await requestAmapJson("https://restapi.amap.com/v3/place/text", params, { config, fetchImpl, timeoutMs: 10000 });
    const payload = result.payload;
    if (!result.ok || !Array.isArray(payload?.pois)) return [];
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
  // hits are too close — e.g. "南京工业大学" campus vs metro station.
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
  const { plan: aiResult, failure: aiFailure } = await aiParse(safeMessage, safeContext, config || {}, fetchImpl);
  if (aiFailure && aiFailure.code !== "not_configured") {
    // Server-side only, already scrubbed of credentials. Without this an expired
    // quota looks identical to a healthy fallback and can go unnoticed for days.
    console.warn(`[ai] parse failed code=${aiFailure.code}${aiFailure.status ? ` status=${aiFailure.status}` : ""} detail=${aiFailure.detail || "-"}`);
  }
  const localResult = localParse(safeMessage, safeContext);
  const plan = aiResult ? normalizePlan({
    ...aiResult,
    // The explicit route wording is more trustworthy than a stale model/context
    // completion. This also keeps a previous demo destination from leaking into
    // a new request such as "前往燕郊站".
    origin: aiResult.origin || localResult.origin,
    destination: localResult.destination || aiResult.destination,
    // Hard arrival constraints must be present in the user's wording. A model
    // is allowed to explain trade-offs, but must not invent a deadline or SOC.
    arrivalDeadline: localResult.arrivalDeadline,
    minArrivalSoc: localResult.minArrivalSoc,
    energyType: aiResult.energyType === "unknown" ? localResult.energyType : aiResult.energyType,
    priority: localResult.priority !== "balanced" ? localResult.priority : aiResult.priority,
    // A model must not invent a hard detour cap that the user never asked for.
    // Only the local parser accepts an explicit detour-cap constraint.
    maxDetourKm: localResult.maxDetourKm,
    services: Array.from(new Set([...(aiResult.services || []), ...(localResult.services || [])])),
    clarificationNeeded: !(localResult.destination || aiResult.destination),
    aiUsed: true,
    assistantReply: aiResult.assistantReply === "已生成补能规划条件。"
      ? "已理解你的出行要求，正在结合真实道路、沿线站点与未来等待风险生成方案。"
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
  return {
    ...plan,
    aiFailureCode: aiFailure?.code || null,
    locations: {
      origin: originGeo,
      destination: destinationGeo
    }
  };
}

export function formatPlanResponse(result) {
  const { locations = {}, aiFailureCode = null, ...parsed } = result || {};
  const resolvedDestinationName = cleanText(locations.destination?.name || "", 80);
  const candidates = Array.isArray(locations.destination?.candidates)
    ? locations.destination.candidates
    : [];
  const needsPick = Boolean(locations.destination?.needsPick) && candidates.length >= 2;
  const userQuery = cleanText(parsed.destination || "", 80);
  return {
    parsed: {
      ...parsed,
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

export const planLimits = { MAX_MESSAGE_LENGTH, MAX_CONTEXT_LENGTH };
