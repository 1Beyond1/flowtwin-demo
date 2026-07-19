import { DEFAULT_ORIGIN } from "./config.mjs";

const MAX_MESSAGE_LENGTH = 1200;
const MAX_CONTEXT_LENGTH = 8000;
const ENERGY_TYPES = new Set(["electric", "fuel", "mixed", "unknown"]);
const PRIORITIES = new Set(["on_time", "fastest", "cheapest", "wait", "balanced"]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cleanText(value, max = 160) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
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

function findCurrentSoc(text, arrivalSoc) {
  const explicit = text.match(/(?:当前|现在|出发时|现有|剩余)\s*(?:电量|SOC)?.{0,8}?(\d{1,3})\s*%/i);
  if (explicit) return cleanNumber(explicit[1], 5, 100);
  const values = Array.from(text.matchAll(/(\d{1,3})\s*%/g)).map((match) => cleanNumber(match[1], 5, 100)).filter((value) => value !== null);
  if (values.length >= 2) return values[0];
  return arrivalSoc !== null ? null : values[0] ?? null;
}

function findDestination(text) {
  const knownPlaces = [
    "北京大兴国际机场", "大兴国际机场", "大兴机场", "首都国际机场", "首都机场",
    "北京南站", "北京站", "北京西站", "北京朝阳站", "天津滨海国际机场", "天津机场"
  ];
  const known = knownPlaces.find((place) => text.includes(place));
  if (known) return known;
  const match = text.match(/(?:去|到|前往|抵达|目的地(?:是)?)[\\s:：]*([^，,。；;\n]{2,40})/);
  return cleanText(match?.[1] || "", 80).replace(/(，|,|然后|并且|最好).*/, "") || null;
}

function findOrigin(text) {
  const match = text.match(/从([^，,。；;\n]{2,40})(?:出发|到|去|前往)/);
  return cleanText(match?.[1] || "", 80) || DEFAULT_ORIGIN.name;
}

function localParse(message, context = {}) {
  const text = cleanText(message, MAX_MESSAGE_LENGTH);
  const departureTime = findTime(text, /(?:出发|明天|后天|周[一二三四五六日天]|今晚|早上|上午|下午|晚上)?[^\d]{0,8}(\d{1,2})\s*[:：时点]\s*(\d{2})?/);
  const arrivalDeadline = findTime(text, /(?:最晚|截止|不晚于|必须在|赶在|前到|之前到)[^\d]{0,8}(\d{1,2})\s*[:：时点]\s*(\d{2})?/);
  const minArrivalSoc = findArrivalSoc(text);
  const soc = findCurrentSoc(text, minArrivalSoc) ?? cleanNumber(context.soc, 5, 100);
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
    departureTime,
    arrivalDeadline,
    soc,
    minArrivalSoc: minArrivalSoc ?? cleanNumber(context.minArrivalSoc, 5, 100),
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
    destination: cleanText(raw?.destination, 80) || null,
    departureTime: normalizeTime(raw?.departureTime),
    arrivalDeadline: normalizeTime(raw?.arrivalDeadline),
    soc: cleanNumber(raw?.soc, 5, 100),
    minArrivalSoc: cleanNumber(raw?.minArrivalSoc, 5, 100),
    energyType,
    priority,
    maxDetourKm: cleanNumber(raw?.maxDetourKm, 0, 100),
    services,
    clarificationNeeded: Boolean(raw?.clarificationNeeded) || !raw?.destination,
    assistantReply: cleanText(raw?.assistantReply, 240) || "已生成补能规划条件。",
    aiUsed,
    parser: aiUsed ? "doubao-seed-2.0-lite" : "local-fallback"
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
  const allowed = ["origin", "destination", "departureTime", "arrivalDeadline", "soc", "minArrivalSoc", "energyType", "priority", "maxDetourKm", "services"];
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
            content: "你是 FlowTwin 出行规划解析器。只输出合法 JSON，不要 Markdown，不要解释。字段必须为 origin,destination,departureTime,arrivalDeadline,soc,minArrivalSoc,energyType,priority,maxDetourKm,services,clarificationNeeded,assistantReply。soc 是出发时当前电量；minArrivalSoc 是用户要求到达目的地时至少保留的电量，二者不能混淆。energyType 只能是 electric、fuel、mixed、unknown；priority 只能是 on_time、fastest、cheapest、wait、balanced。缺失字段用 null，缺少目的地时 clarificationNeeded=true。"
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
  const params = new URLSearchParams({ address: place, city: "北京", output: "json", key: config.webServiceKey });
  try {
    const response = await fetchImpl(`https://restapi.amap.com/v3/geocode/geo?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const payload = await response.json();
    const location = payload?.geocodes?.[0]?.location;
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
    departureTime: aiResult.departureTime || localResult.departureTime,
    arrivalDeadline: aiResult.arrivalDeadline || localResult.arrivalDeadline,
    soc: localResult.soc ?? aiResult.soc,
    minArrivalSoc: localResult.minArrivalSoc ?? aiResult.minArrivalSoc,
    energyType: aiResult.energyType === "unknown" ? localResult.energyType : aiResult.energyType,
    priority: localResult.priority !== "balanced" ? localResult.priority : aiResult.priority,
    maxDetourKm: aiResult.maxDetourKm ?? localResult.maxDetourKm,
    services: Array.from(new Set([...(aiResult.services || []), ...(localResult.services || [])])),
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
