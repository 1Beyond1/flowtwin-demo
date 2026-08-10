import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

function splitValues(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstLocalValue(text, names) {
  for (const name of names) {
    const value = readLocalValue(text, name);
    if (value) return value.trim();
  }
  return "";
}

export async function loadConfig({ env = process.env, root = process.cwd() } = {}) {
  let localText = "";
  try {
    localText = await readFile(join(root, "config.local.js"), "utf8");
  } catch {}

  const primaryWebServiceKey = env.AMAP_WEB_SERVICE_KEY_PRIMARY?.trim()
    || env.AMAP_WEB_SERVICE_KEY?.trim()
    || firstLocalValue(localText, ["webServiceKeyPrimary", "webServiceKey"]);
  const backupWebServiceKeys = [
    ...splitValues(env.AMAP_WEB_SERVICE_KEYS_BACKUP),
    ...splitValues(env.AMAP_WEB_SERVICE_KEY_BACKUP),
    ...splitValues(firstLocalValue(localText, ["webServiceKeyBackup", "webServiceKeysBackup"]))
  ];
  const amapServiceKeys = Array.from(new Set([primaryWebServiceKey, ...backupWebServiceKeys].filter(Boolean)));
  const config = {
    // Environment variables remain the production source of truth. A quoted
    // local port is useful for side-by-side development demos without putting
    // secrets or process-manager settings into source control.
    port: Number(env.PORT || readLocalValue(localText, "port") || 4182),
    amapKey: env.AMAP_JS_KEY?.trim() || readLocalValue(localText, "amapKey"),
    securityJsCode: env.AMAP_SECURITY_JS_CODE?.trim() || readLocalValue(localText, "securityJsCode"),
    webServiceKey: primaryWebServiceKey,
    webServiceKeyBackup: backupWebServiceKeys[0] || "",
    amapServiceKeys,
    feishuWebhookUrl: env.FEISHU_WEBHOOK_URL?.trim() || readLocalValue(localText, "feishuWebhookUrl"),
    feishuBaseUrl: env.FEISHU_BASE_URL?.trim() || readLocalValue(localText, "feishuBaseUrl") || "https://open.feishu.cn",
    feishuAppId: env.FEISHU_APP_ID?.trim() || readLocalValue(localText, "feishuAppId"),
    feishuAppSecret: env.FEISHU_APP_SECRET?.trim() || readLocalValue(localText, "feishuAppSecret"),
    feishuAppToken: env.FEISHU_BITABLE_APP_TOKEN?.trim() || env.FEISHU_APP_TOKEN?.trim() || readLocalValue(localText, "feishuAppToken"),
    feishuSnapshotTableId: env.FEISHU_SNAPSHOT_TABLE_ID?.trim() || readLocalValue(localText, "feishuSnapshotTableId"),
    feishuStrategyTableId: env.FEISHU_STRATEGY_TABLE_ID?.trim() || readLocalValue(localText, "feishuStrategyTableId"),
    feishuSyncTableId: env.FEISHU_SYNC_TABLE_ID?.trim() || readLocalValue(localText, "feishuSyncTableId"),
    feishuAiStrategyField: env.FEISHU_AI_STRATEGY_FIELD?.trim() || readLocalValue(localText, "feishuAiStrategyField") || "AI策略",
    feishuApprovalField: env.FEISHU_APPROVAL_FIELD?.trim() || readLocalValue(localText, "feishuApprovalField") || "审批状态",
    aiBaseUrl: firstValue(env, localText, AI_KEYS.baseUrl),
    aiApiKey: firstValue(env, localText, AI_KEYS.apiKey),
    aiModel: firstValue(env, localText, AI_KEYS.model),
    aiBackupBaseUrl: firstValue(env, localText, AI_BACKUP_KEYS.baseUrl),
    aiBackupApiKey: firstValue(env, localText, AI_BACKUP_KEYS.apiKey),
    aiBackupModel: firstValue(env, localText, AI_BACKUP_KEYS.model),
    sttApiKey: firstValue(env, localText, STT_KEYS.apiKey),
    sttBaseUrl: firstValue(env, localText, STT_KEYS.baseUrl) || DEFAULT_STT_BASE_URL,
    sttModel: firstValue(env, localText, STT_KEYS.model) || DEFAULT_STT_MODEL,
    // Optional local CV adapter. The Node demo remains runnable without it.
    cvServiceUrl: env.CV_SERVICE_URL?.trim() || readLocalValue(localText, "cvServiceUrl")
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
