import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_PORT = 4182;
const DEFAULT_HOST = "127.0.0.1";
const MAX_DOTENV_BYTES = 256 * 1024;
const FORBIDDEN_ENV_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const PLACEHOLDER_PATTERNS = [
  /^replace_with_/i,
  /^YOUR_[A-Z0-9_]*$/i
];

export function isPlaceholderValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (/(?:^|\/\/[^/?#]*?)(?:^|[.])example\.com(?:[:/?#]|$)/i.test(text)) return true;
  return false;
}

function cleanConfigValue(value) {
  const text = String(value ?? "").trim();
  if (!text || isPlaceholderValue(text)) return "";
  return text;
}

function isCloudMetadataHostname(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) return false;
  return host === "metadata"
    || host === "metadata.google.internal"
    || host === "metadata.goog"
    || host === "instance-data"
    || /(?:^|\.)metadata(?:\.|$)/i.test(host);
}

function isPrivateOrInternalHostname(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) return false;
  // Explicitly block cloud instance metadata endpoints before matching
  // single-label or .internal service names.
  if (isCloudMetadataHostname(host)) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "host.docker.internal") return true;
  // Single-label Docker/internal service names (e.g. cv-service, ollama)
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) return true;
  // Private internal DNS suffixes
  if (/\.(?:internal|local|lan|svc|svc\.cluster\.local)$/.test(host)) return true;
  // RFC1918 / loopback IPv4 addresses
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.every((octet) => octet >= 0 && octet <= 255)) {
      const [a, b] = octets;
      if (a === 127 || a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
    }
  }
  return false;
}

function parseFiniteCoordinate(value, min, max) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function parseHost(value, fallback = DEFAULT_HOST) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 128 || /[\s/\\@\u0000-\u001f\u007f]/.test(text)) return fallback;
  return text;
}

const AI_KEYS = {
  baseUrl: ["AI_BASE_URL", "aiBaseUrl"],
  apiKey: ["AI_API_KEY", "aiApiKey"],
  model: ["AI_MODEL", "aiModel"]
};

const AI_BACKUP_KEYS = {
  baseUrl: ["AI_BACKUP_BASE_URL", "aiBackupBaseUrl"],
  apiKey: ["AI_BACKUP_API_KEY", "aiBackupApiKey"],
  model: ["AI_BACKUP_MODEL", "aiBackupModel"]
};

const STT_KEYS = {
  apiKey: ["SILICONFLOW_API_KEY", "STT_API_KEY", "sttApiKey"],
  baseUrl: ["SILICONFLOW_BASE_URL", "STT_BASE_URL", "sttBaseUrl"],
  model: ["SILICONFLOW_STT_MODEL", "STT_MODEL", "sttModel"]
};

const DEFAULT_STT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_STT_MODEL = "FunAudioLLM/SenseVoiceSmall";

/**
 * Strip JS single-line and multi-line comments outside string literals so URLs
 * like "https://example.com" inside quotes remain intact while commented-out
 * config properties are ignored.
 */
export function stripJsComments(source) {
  const text = String(source || "").replace(/^\uFEFF/, "");
  let output = "";
  let inQuote = null;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const next = text[index + 1];
    if (inQuote) {
      output += ch;
      if (ch === "\\" && index + 1 < text.length) {
        output += next;
        index += 1;
      } else if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inQuote = ch;
      output += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index += 1;
      if (index < text.length) output += text[index];
      continue;
    }
    if (ch === "/" && next === "*") {
      index += 2;
      while (index + 1 < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      if (index + 1 < text.length) index += 1;
      output += " ";
      continue;
    }
    output += ch;
  }
  return output;
}

function unescapeQuoted(value, quote) {
  return String(value || "").replace(/\\(.)/g, (_, escaped) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    if (escaped === "\\" || escaped === quote) return escaped;
    return `\\${escaped}`;
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readLocalValue(strippedText, name) {
  if (!strippedText || !name) return "";
  const escapedName = escapeRegExp(name);
  const pattern = new RegExp(
    `(?:^|[{,\\s])(?:["'])?${escapedName}(?:["'])?\\s*:\\s*(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|(true|false)(?=\\s*(?:[,}\\r\\n;]|$))|(-?\\d+(?:\\.\\d+)?)(?=\\s*(?:[,}\\r\\n;]|$)))`
  );
  const match = strippedText.match(pattern);
  if (!match) return "";
  if (match[1] !== undefined) return unescapeQuoted(match[1], '"');
  if (match[2] !== undefined) return unescapeQuoted(match[2], "'");
  if (match[3] !== undefined) return match[3];
  if (match[4] !== undefined) return match[4];
  return "";
}

export function parseDotEnv(content) {
  const result = {};
  const text = String(content || "").replace(/^\uFEFF/, "").slice(0, MAX_DOTENV_BYTES);
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const equalsIndex = withoutExport.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = withoutExport.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || FORBIDDEN_ENV_KEYS.has(key)) continue;
    const rawValue = withoutExport.slice(equalsIndex + 1).trim();
    let value = "";
    if (!rawValue) {
      value = "";
    } else if (rawValue[0] === '"' || rawValue[0] === "'") {
      const quote = rawValue[0];
      let end = -1;
      for (let index = 1; index < rawValue.length; index += 1) {
        if (quote === '"' && rawValue[index] === "\\" && index + 1 < rawValue.length) {
          index += 1;
          continue;
        }
        if (rawValue[index] === quote) {
          end = index;
          break;
        }
      }
      const inner = end >= 0 ? rawValue.slice(1, end) : rawValue.slice(1);
      value = quote === '"' ? unescapeQuoted(inner, '"') : inner;
    } else {
      value = rawValue.replace(/\s+#.*$/, "").trim();
    }
    result[key] = value;
  }
  return result;
}

function mergeEnv(env, dotEnv) {
  const merged = { ...dotEnv };
  if (env && typeof env === "object") {
    for (const [key, value] of Object.entries(env)) {
      if (FORBIDDEN_ENV_KEYS.has(key)) continue;
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

function parsePort(value, fallback = DEFAULT_PORT) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text || !/^\d{1,5}$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

function localConfigName(name) {
  if (name === "SILICONFLOW_API_KEY" || name === "STT_API_KEY") return "sttApiKey";
  if (name === "SILICONFLOW_BASE_URL" || name === "STT_BASE_URL") return "sttBaseUrl";
  if (name === "SILICONFLOW_STT_MODEL" || name === "STT_MODEL") return "sttModel";
  // Keep the historical AI_* -> lowercase local-key mapping used by config.local.js.
  if (name.startsWith("AI_")) return name.replace(/^AI_/, "").toLowerCase();
  return name;
}

function firstValue(env, text, names) {
  for (const name of names) {
    if (typeof env[name] === "string") {
      const cleaned = cleanConfigValue(env[name]);
      if (cleaned) return cleaned;
    }
    const localValue = cleanConfigValue(readLocalValue(text, localConfigName(name)));
    if (localValue) return localValue;
  }
  return "";
}

function splitValues(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((item) => cleanConfigValue(item))
    .filter(Boolean);
}

function readBooleanValue(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function firstLocalValue(text, names) {
  for (const name of names) {
    const value = cleanConfigValue(readLocalValue(text, name));
    if (value) return value;
  }
  return "";
}

function extractRateLimitEnv(env) {
  const result = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (key === "FLOWTWIN_TRUST_PROXY" || key.startsWith("FLOWTWIN_RATE_LIMIT_")) {
      result[key] = value;
    }
  }
  return result;
}

export function resolveDefaultOrigin(env = {}, localText = "") {
  const rawName = cleanConfigValue(env.FLOWTWIN_DEFAULT_ORIGIN_NAME)
    || cleanConfigValue(readLocalValue(localText, "defaultOriginName"));
  const safeName = rawName.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
  const name = safeName || DEFAULT_ORIGIN.name;
  const rawLng = env.FLOWTWIN_DEFAULT_ORIGIN_LNG ?? readLocalValue(localText, "defaultOriginLng");
  const rawLat = env.FLOWTWIN_DEFAULT_ORIGIN_LAT ?? readLocalValue(localText, "defaultOriginLat");
  const lng = parseFiniteCoordinate(rawLng, -180, 180);
  const lat = parseFiniteCoordinate(rawLat, -90, 90);
  const coordinate = lng !== null && lat !== null ? [lng, lat] : [...DEFAULT_ORIGIN.coordinate];
  return {
    name,
    address: name,
    coordinate,
    source: DEFAULT_ORIGIN.source
  };
}

export async function loadConfig({ env = process.env, root = process.cwd() } = {}) {
  let dotEnv = {};
  try {
    const dotEnvText = await readFile(join(root, ".env"), "utf8");
    dotEnv = parseDotEnv(dotEnvText);
  } catch {}
  const effectiveEnv = mergeEnv(env, dotEnv);

  let localText = "";
  try {
    localText = stripJsComments(await readFile(join(root, "config.local.js"), "utf8"));
  } catch {}

  const primaryWebServiceKey = cleanConfigValue(effectiveEnv.AMAP_WEB_SERVICE_KEY_PRIMARY)
    || cleanConfigValue(effectiveEnv.AMAP_WEB_SERVICE_KEY)
    || firstLocalValue(localText, ["webServiceKeyPrimary", "webServiceKey"]);
  const backupWebServiceKeys = [
    ...splitValues(effectiveEnv.AMAP_WEB_SERVICE_KEYS_BACKUP),
    ...splitValues(effectiveEnv.AMAP_WEB_SERVICE_KEY_BACKUP),
    ...splitValues(firstLocalValue(localText, ["webServiceKeyBackup", "webServiceKeysBackup"]))
  ];
  const amapServiceKeys = Array.from(new Set([primaryWebServiceKey, ...backupWebServiceKeys].filter(Boolean)));
  const rawEnvPort = typeof effectiveEnv.PORT === "string" ? effectiveEnv.PORT.trim() : effectiveEnv.PORT;
  const hasEnvPort = rawEnvPort !== undefined && rawEnvPort !== null && String(rawEnvPort).trim() !== "";
  const port = hasEnvPort
    ? parsePort(rawEnvPort, DEFAULT_PORT)
    : parsePort(readLocalValue(localText, "port"), DEFAULT_PORT);
  const host = parseHost(effectiveEnv.HOST || readLocalValue(localText, "host"), DEFAULT_HOST);
  const defaultOrigin = resolveDefaultOrigin(effectiveEnv, localText);
  const rawPublicDemo = typeof effectiveEnv.FLOWTWIN_PUBLIC_DEMO === "string" && effectiveEnv.FLOWTWIN_PUBLIC_DEMO.trim()
    ? effectiveEnv.FLOWTWIN_PUBLIC_DEMO
    : readLocalValue(localText, "publicDemo");
  const rawReasoningEffort = firstValue(effectiveEnv, localText, ["AI_REASONING_EFFORT", "aiReasoningEffort"]).toLowerCase();
  const aiReasoningEffort = ["low", "medium", "high"].includes(rawReasoningEffort) ? rawReasoningEffort : "";
  const rawTimeoutText = firstValue(effectiveEnv, localText, ["AI_TIMEOUT_MS", "aiTimeoutMs"]);
  const parsedTimeout = rawTimeoutText ? Number(rawTimeoutText) : 20000;
  const aiTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout >= 5000 && parsedTimeout <= 90000
    ? Math.round(parsedTimeout)
    : 20000;
  const config = {
    // Environment variables remain the production source of truth. Optional
    // .env and config.local.js values fill in unset keys for local demos.
    host,
    port,
    defaultOrigin,
    // Public deployments can deliberately run as a read-only demo. This
    // disables outbound Feishu/Webhook writes while keeping local simulation.
    publicDemo: readBooleanValue(rawPublicDemo),
    trustProxy: effectiveEnv.FLOWTWIN_TRUST_PROXY?.trim() || readLocalValue(localText, "trustProxy") || "",
    amapKey: cleanConfigValue(effectiveEnv.AMAP_JS_KEY) || cleanConfigValue(readLocalValue(localText, "amapKey")),
    securityJsCode: cleanConfigValue(effectiveEnv.AMAP_SECURITY_JS_CODE) || cleanConfigValue(readLocalValue(localText, "securityJsCode")),
    webServiceKey: primaryWebServiceKey,
    webServiceKeyBackup: backupWebServiceKeys[0] || "",
    amapServiceKeys,
    feishuWebhookUrl: cleanConfigValue(effectiveEnv.FEISHU_WEBHOOK_URL) || cleanConfigValue(readLocalValue(localText, "feishuWebhookUrl")),
    feishuBaseUrl: cleanConfigValue(effectiveEnv.FEISHU_BASE_URL) || cleanConfigValue(readLocalValue(localText, "feishuBaseUrl")) || "https://open.feishu.cn",
    feishuAppId: cleanConfigValue(effectiveEnv.FEISHU_APP_ID) || cleanConfigValue(readLocalValue(localText, "feishuAppId")),
    feishuAppSecret: cleanConfigValue(effectiveEnv.FEISHU_APP_SECRET) || cleanConfigValue(readLocalValue(localText, "feishuAppSecret")),
    feishuAppToken: cleanConfigValue(effectiveEnv.FEISHU_BITABLE_APP_TOKEN) || cleanConfigValue(effectiveEnv.FEISHU_APP_TOKEN) || cleanConfigValue(readLocalValue(localText, "feishuAppToken")),
    feishuSnapshotTableId: cleanConfigValue(effectiveEnv.FEISHU_SNAPSHOT_TABLE_ID) || cleanConfigValue(readLocalValue(localText, "feishuSnapshotTableId")),
    feishuStrategyTableId: cleanConfigValue(effectiveEnv.FEISHU_STRATEGY_TABLE_ID) || cleanConfigValue(readLocalValue(localText, "feishuStrategyTableId")),
    feishuSyncTableId: cleanConfigValue(effectiveEnv.FEISHU_SYNC_TABLE_ID) || cleanConfigValue(readLocalValue(localText, "feishuSyncTableId")),
    feishuAiStrategyField: cleanConfigValue(effectiveEnv.FEISHU_AI_STRATEGY_FIELD) || cleanConfigValue(readLocalValue(localText, "feishuAiStrategyField")) || "AI策略",
    feishuApprovalField: cleanConfigValue(effectiveEnv.FEISHU_APPROVAL_FIELD) || cleanConfigValue(readLocalValue(localText, "feishuApprovalField")) || "审批状态",
    aiBaseUrl: firstValue(effectiveEnv, localText, AI_KEYS.baseUrl),
    aiApiKey: firstValue(effectiveEnv, localText, AI_KEYS.apiKey),
    aiModel: firstValue(effectiveEnv, localText, AI_KEYS.model),
    aiReasoningEffort,
    aiTimeoutMs,
    aiBackupBaseUrl: firstValue(effectiveEnv, localText, AI_BACKUP_KEYS.baseUrl),
    aiBackupApiKey: firstValue(effectiveEnv, localText, AI_BACKUP_KEYS.apiKey),
    aiBackupModel: firstValue(effectiveEnv, localText, AI_BACKUP_KEYS.model),
    sttApiKey: firstValue(effectiveEnv, localText, STT_KEYS.apiKey),
    sttBaseUrl: firstValue(effectiveEnv, localText, STT_KEYS.baseUrl) || DEFAULT_STT_BASE_URL,
    sttModel: firstValue(effectiveEnv, localText, STT_KEYS.model) || DEFAULT_STT_MODEL,
    // Optional local CV adapter. The Node demo remains runnable without it.
    cvServiceUrl: cleanConfigValue(effectiveEnv.CV_SERVICE_URL) || cleanConfigValue(readLocalValue(localText, "cvServiceUrl")),
    rateLimitEnv: extractRateLimitEnv(effectiveEnv)
  };

  return {
    ...config,
    aiBaseUrl: normalizeAiBaseUrl(config.aiBaseUrl),
    aiModel: config.aiModel,
    aiBackupBaseUrl: normalizeAiBaseUrl(config.aiBackupBaseUrl),
    aiBackupModel: config.aiBackupModel,
    sttBaseUrl: normalizeAiBaseUrl(config.sttBaseUrl) || DEFAULT_STT_BASE_URL,
    sttModel: config.sttModel || DEFAULT_STT_MODEL,
    cvServiceUrl: normalizeAiBaseUrl(config.cvServiceUrl)
  };
}

export function normalizeAiBaseUrl(value) {
  const cleaned = cleanConfigValue(value);
  if (!cleaned || cleaned.length > 300) return "";
  try {
    const url = new URL(cleaned);
    const hostname = url.hostname.toLowerCase();
    if (hostname === "example.com" || hostname.endsWith(".example.com") || isCloudMetadataHostname(hostname)) return "";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isPrivateOrInternalHostname(hostname))) return "";
    if (url.username || url.password || url.search || url.hash) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export const DEFAULT_ORIGIN = Object.freeze({
  name: "北京国贸 CBD",
  address: "北京国贸 CBD",
  coordinate: Object.freeze([116.461, 39.909]),
  source: "演示默认起点"
});
