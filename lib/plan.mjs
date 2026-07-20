import { DEFAULT_ORIGIN } from "./config.mjs";

const MAX_MESSAGE_LENGTH = 1200;
const MAX_CONTEXT_LENGTH = 8000;
const ENERGY_TYPES = new Set(["electric", "fuel", "mixed", "unknown"]);
const PRIORITIES = new Set(["on_time", "fastest", "cheapest", "wait", "balanced"]);
const CANONICAL_LANDMARKS = new Map([
  ["东方明珠", "上海东方明珠广播电视塔"],
  ["上海东方明珠", "上海东方明珠广播电视塔"],
  ["东方明珠广播电视塔", "上海东方明珠广播电视塔"],
  ["上海东方明珠广播电视塔", "上海东方明珠广播电视塔"]
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
  const energyType = /油电|两种|都可以|不限/.test(text)
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
  const allowed = ["origin", "destination", "arrivalDeadline", "minArrivalSoc", "energyType", "priority", "maxDetourKm", "services"];
  return Object.fromEntries(allowed.filter((key) => context[key] !== undefined).map((key) => [key, context[key]]));
}

async function aiParse(message, context, config, fetchImpl) {
  if (!config.aiApiKey || !config.aiBaseUrl || !config.aiModel) return null;
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
            content: "你是 FlowTwin 出行规划解析器。只输出合法 JSON，不要 Markdown，不要解释。字段必须为 origin,destination,arrivalDeadline,minArrivalSoc,energyType,priority,maxDetourKm,services,clarificationNeeded,assistantReply。当前出发时间和当前油电量由车机顶部控件管理，不要从用户文本解析、不要输出、也不要覆盖它们。minArrivalSoc 是用户要求到达目的地时至少保留的油电量。energyType 只能是 electric、fuel、mixed、unknown；priority 只能是 on_time、fastest、cheapest、wait、balanced。缺失字段用 null，缺少目的地时 clarificationNeeded=true。"
          },
          {
            role: "user",
            content: JSON.stringify({ message: cleanText(message, MAX_MESSAGE_LENGTH), context: contextForPrompt(context) })
          }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const parsed = extractJson(content);
    return parsed ? normalizePlan(parsed, { aiUsed: true }) : null;
  } catch {
    return null;
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

async function geocode(place, config, fetchImpl) {
  if (!isSafePlace(place) || !config.webServiceKey || place === DEFAULT_ORIGIN.name) return null;
  const params = new URLSearchParams({ address: place, output: "json", key: config.webServiceKey });
  try {
    const response = await fetchImpl(`https://restapi.amap.com/v3/geocode/geo?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const payload = await response.json();
    const geocode = payload?.geocodes?.[0];
    const location = geocode?.location;
    const coordinate = parseCoordinate(location);
    return coordinate ? { coordinate, source: "高德地理编码" } : null;
  } catch {
    return null;
  }
}

export async function parseTripIntent({ message, context = {}, config, fetchImpl = fetch } = {}) {
  const safeMessage = cleanText(message, MAX_MESSAGE_LENGTH);
  const serializedContext = JSON.stringify(contextForPrompt(context));
  const safeContext = serializedContext.length <= MAX_CONTEXT_LENGTH ? JSON.parse(serializedContext) : {};
  const aiResult = await aiParse(safeMessage, safeContext, config || {}, fetchImpl);
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
    // Only the local parser accepts an explicit “最多绕行 N 公里” constraint.
    maxDetourKm: localResult.maxDetourKm,
    services: Array.from(new Set([...(aiResult.services || []), ...(localResult.services || [])])),
    clarificationNeeded: !(localResult.destination || aiResult.destination),
    aiUsed: true,
    assistantReply: aiResult.assistantReply === "已生成补能规划条件。"
      ? "已理解你的出行要求，正在结合真实道路、沿线站点与未来等待风险生成方案。"
      : aiResult.assistantReply
  }, { aiUsed: true }) : localResult;
  const originGeo = plan.origin === DEFAULT_ORIGIN.name ? { coordinate: DEFAULT_ORIGIN.coordinate, source: DEFAULT_ORIGIN.source } : await geocode(plan.origin, config || {}, fetchImpl);
  const destinationGeo = plan.destination ? await geocode(plan.destination, config || {}, fetchImpl) : null;
  return {
    ...plan,
    locations: {
      origin: originGeo,
      destination: destinationGeo
    }
  };
}

export function formatPlanResponse(result) {
  const { locations = {}, ...parsed } = result || {};
  return {
    parsed,
    originLocation: locations.origin?.coordinate || null,
    destinationLocation: locations.destination?.coordinate || null,
    locationSources: {
      origin: locations.origin?.source || null,
      destination: locations.destination?.source || null
    }
  };
}

export const planLimits = { MAX_MESSAGE_LENGTH, MAX_CONTEXT_LENGTH };
