import { readFile } from "node:fs/promises";
import { join } from "node:path";

const AI_KEYS = {
  baseUrl: ["AI_BASE_URL", "aiBaseUrl"],
  apiKey: ["AI_API_KEY", "aiApiKey"],
  model: ["AI_MODEL", "aiModel"]
};

const STT_KEYS = {
  apiKey: ["SILICONFLOW_API_KEY", "STT_API_KEY", "sttApiKey"],
  baseUrl: ["SILICONFLOW_BASE_URL", "STT_BASE_URL", "sttBaseUrl"],
  model: ["SILICONFLOW_STT_MODEL", "STT_MODEL", "sttModel"]
};

const DEFAULT_STT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_STT_MODEL = "FunAudioLLM/SenseVoiceSmall";

function readLocalValue(text, name) {
  const match = text.match(new RegExp(`${name}\\s*:\\s*["']([^"']*)["']`));
  return match?.[1] || "";
}

function localConfigName(name) {
  if (name === "SILICONFLOW_API_KEY" || name === "STT_API_KEY") return "sttApiKey";
  if (name === "SILICONFLOW_BASE_URL" || name === "STT_BASE_URL") return "sttBaseUrl";
  if (name === "SILICONFLOW_STT_MODEL" || name === "STT_MODEL") return "sttModel";
  // Keep the historical AI_* → lowercase local-key mapping used by config.local.js.
  if (name.startsWith("AI_")) return name.replace(/^AI_/, "").toLowerCase();
  return name;
}

function firstValue(env, text, names) {
  for (const name of names) {
    if (typeof env[name] === "string" && env[name].trim()) return env[name].trim();
    const localValue = readLocalValue(text, localConfigName(name));
    if (localValue) return localValue.trim();
  }
  return "";
}

export async function loadConfig({ env = process.env, root = process.cwd() } = {}) {
  let localText = "";
  try {
    localText = await readFile(join(root, "config.local.js"), "utf8");
  } catch {}

  const config = {
    // Environment variables remain the production source of truth. A quoted
    // local port is useful for side-by-side development demos without putting
    // secrets or process-manager settings into source control.
    port: Number(env.PORT || readLocalValue(localText, "port") || 4182),
    amapKey: env.AMAP_JS_KEY?.trim() || readLocalValue(localText, "amapKey"),
    securityJsCode: env.AMAP_SECURITY_JS_CODE?.trim() || readLocalValue(localText, "securityJsCode"),
    webServiceKey: env.AMAP_WEB_SERVICE_KEY?.trim() || readLocalValue(localText, "webServiceKey"),
    feishuWebhookUrl: env.FEISHU_WEBHOOK_URL?.trim() || readLocalValue(localText, "feishuWebhookUrl"),
    aiBaseUrl: firstValue(env, localText, AI_KEYS.baseUrl),
    aiApiKey: firstValue(env, localText, AI_KEYS.apiKey),
    aiModel: firstValue(env, localText, AI_KEYS.model),
    sttApiKey: firstValue(env, localText, STT_KEYS.apiKey),
    sttBaseUrl: firstValue(env, localText, STT_KEYS.baseUrl) || DEFAULT_STT_BASE_URL,
    sttModel: firstValue(env, localText, STT_KEYS.model) || DEFAULT_STT_MODEL
  };

  return {
    ...config,
    aiBaseUrl: normalizeAiBaseUrl(config.aiBaseUrl),
    aiModel: config.aiModel,
    sttBaseUrl: normalizeAiBaseUrl(config.sttBaseUrl) || DEFAULT_STT_BASE_URL,
    sttModel: config.sttModel || DEFAULT_STT_MODEL
  };
}

export function normalizeAiBaseUrl(value) {
  if (!value || value.length > 300) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return "";
    if (url.username || url.password || url.search || url.hash) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export const DEFAULT_ORIGIN = {
  name: "能链北京总部",
  address: "能链北京总部",
  coordinate: [116.491, 39.951],
  source: "演示默认起点"
};
