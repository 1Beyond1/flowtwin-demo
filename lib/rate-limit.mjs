import { isIP } from "node:net";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_ENTRIES = 100_000;
const MAX_LIMIT = 1_000_000;
const MAX_TRUST_PROXY_HOPS = 10;

export const DEFAULT_RATE_LIMITS = Object.freeze({
  plan: 30,
  stt: 10,
  map: 180,
  cv: 6,
  operator: 12,
  validate: 4,
  "feishu-sync": 10,
  "feishu-status": 60,
  approve: 20,
  "version-check": 12,
  execution: 6
});

const RATE_LIMIT_ENV_NAMES = Object.freeze({
  plan: "FLOWTWIN_RATE_LIMIT_PLAN",
  stt: "FLOWTWIN_RATE_LIMIT_STT",
  map: "FLOWTWIN_RATE_LIMIT_MAP",
  cv: "FLOWTWIN_RATE_LIMIT_CV",
  operator: "FLOWTWIN_RATE_LIMIT_OPERATOR",
  validate: "FLOWTWIN_RATE_LIMIT_VALIDATE",
  "feishu-sync": "FLOWTWIN_RATE_LIMIT_FEISHU_SYNC",
  "feishu-status": "FLOWTWIN_RATE_LIMIT_FEISHU_STATUS",
  approve: "FLOWTWIN_RATE_LIMIT_APPROVE",
  "version-check": "FLOWTWIN_RATE_LIMIT_VERSION_CHECK",
  execution: "FLOWTWIN_RATE_LIMIT_EXECUTION"
});

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) return fallback;
  return number;
}

export function readRateLimitConfig(env = process.env) {
  const source = env && typeof env === "object" ? env : {};
  const windowMs = boundedInteger(source.FLOWTWIN_RATE_LIMIT_WINDOW_MS, TEN_MINUTES_MS, 1_000, MAX_WINDOW_MS);
  const maxEntries = boundedInteger(source.FLOWTWIN_RATE_LIMIT_MAX_CLIENTS, DEFAULT_MAX_ENTRIES, 1, MAX_ENTRIES);
  const limits = Object.fromEntries(Object.entries(DEFAULT_RATE_LIMITS).map(([scope, fallback]) => [
    scope,
    boundedInteger(source[RATE_LIMIT_ENV_NAMES[scope]], fallback, 1, MAX_LIMIT)
  ]));
  return { windowMs, maxEntries, limits };
}

function parseIpv4(value) {
  const parts = String(value).split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;
  return octets;
}

function parseIpv6Part(value) {
  if (!value) return [];
  const parts = value.split(":");
  const words = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.includes(".")) {
      if (index !== parts.length - 1) return null;
      const octets = parseIpv4(part);
      if (!octets) return null;
      words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    } else {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      words.push(Number.parseInt(part, 16));
    }
  }
  return words;
}

function formatIpv6(words) {
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < words.length;) {
    if (words[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < words.length && words[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart < 0) return words.map((word) => word.toString(16)).join(":");
  const left = words.slice(0, bestStart).map((word) => word.toString(16)).join(":");
  const right = words.slice(bestStart + bestLength).map((word) => word.toString(16)).join(":");
  return `${left}::${right}`;
}

function parseIpv6Words(value) {
  const zoneLess = String(value).split("%", 1)[0];
  if (isIP(zoneLess) !== 6) return null;
  const sections = zoneLess.split("::");
  if (sections.length > 2) return null;
  const hasCompression = sections.length === 2;
  const left = parseIpv6Part(sections[0]);
  const right = hasCompression ? parseIpv6Part(sections[1]) : [];
  if (!left || !right) return null;
  const zeroCount = hasCompression ? 8 - left.length - right.length : 0;
  if (hasCompression ? zeroCount < 1 : left.length !== 8) return null;
  const words = hasCompression
    ? [...left, ...Array(zeroCount).fill(0), ...right]
    : left;
  return words.length === 8 ? words : null;
}

function normalizeIpv6(value) {
  const words = parseIpv6Words(value);
  if (!words) return null;
  // Treat IPv4-mapped IPv6 addresses and their plain IPv4 spelling as one
  // client. Node commonly reports the mapped form for a local IPv4 peer.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  }
  return formatIpv6(words);
}

export function normalizeClientIp(value) {
  let text = String(value ?? "").trim();
  if (!text) return null;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const withoutZone = text.split("%", 1)[0];
  const version = isIP(withoutZone);
  if (version === 4) return parseIpv4(withoutZone)?.join(".") || null;
  if (version === 6) return normalizeIpv6(withoutZone);
  return null;
}

/**
 * Only loopback or private/internal network peers are accepted as trusted
 * reverse proxies unless explicitly allow-listed. This prevents direct public
 * clients from spoofing forwarding headers even when FLOWTWIN_TRUST_PROXY is on.
 */
export function isTrustedProxyPeer(value, extraTrustedProxies = null) {
  const ip = normalizeClientIp(value);
  if (!ip) return false;
  if (extraTrustedProxies) {
    for (const candidate of extraTrustedProxies) {
      if (normalizeClientIp(candidate) === ip) return true;
    }
  }
  const version = isIP(ip);
  if (version === 4) {
    const octets = parseIpv4(ip);
    if (!octets) return false;
    const [a, b] = octets;
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 RFC 1918
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC 1918
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC 1918
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT / internal proxy
    return false;
  }
  if (version === 6) {
    const words = parseIpv6Words(ip);
    if (!words) return false;
    if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true; // ::1 loopback
    if ((words[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((words[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }
  return false;
}

export function parseTrustProxyMode(value) {
  if (value === true) return { mode: "hops", hops: 1 };
  if (value === false || value === null || value === undefined) return { mode: "off", hops: 0 };
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 1) {
      return { mode: "hops", hops: Math.min(value, MAX_TRUST_PROXY_HOPS) };
    }
    return { mode: "off", hops: 0 };
  }
  const text = String(value).trim().toLowerCase();
  if (!text || ["0", "false", "off", "no"].includes(text)) return { mode: "off", hops: 0 };
  if (text === "cloudflare" || text === "cf") return { mode: "cloudflare", hops: 1 };
  if (text === "true") return { mode: "hops", hops: 1 };
  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    if (hops >= 1) return { mode: "hops", hops: Math.min(hops, MAX_TRUST_PROXY_HOPS) };
  }
  return { mode: "off", hops: 0 };
}

function requestHeader(request, name) {
  const headers = request?.headers;
  if (!headers || typeof headers !== "object") return "";
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value.join(",") : String(value ?? "");
  }
  return "";
}

function forwardedIpFromRight(value, hops) {
  if (!hops || hops < 1) return null;
  const parts = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < hops) return null;
  return normalizeClientIp(parts[parts.length - hops]);
}

export function getClientIdentity(request, {
  trustProxy = process.env.FLOWTWIN_TRUST_PROXY,
  trustedProxies = null
} = {}) {
  const direct = normalizeClientIp(request?.socket?.remoteAddress || request?.connection?.remoteAddress) || "unknown";
  const parsedMode = parseTrustProxyMode(trustProxy);
  if (parsedMode.mode === "off") return direct;
  if (!isTrustedProxyPeer(direct, trustedProxies)) return direct;

  if (parsedMode.mode === "cloudflare") {
    return normalizeClientIp(requestHeader(request, "cf-connecting-ip")) || direct;
  }
  // In standard reverse-proxy hop mode, never trust client-spoofable
  // CF-Connecting-IP or the leftmost X-Forwarded-For entry. Extract the
  // trusted-proxy-appended client address from the right by hop count.
  return forwardedIpFromRight(requestHeader(request, "x-forwarded-for"), parsedMode.hops) || direct;
}

function normalizeScopeConfig(value, defaultWindowMs) {
  if (Number.isFinite(Number(value))) {
    return {
      limit: boundedInteger(value, 1, 1, MAX_LIMIT),
      windowMs: defaultWindowMs
    };
  }
  const limit = boundedInteger(value?.limit, 1, 1, MAX_LIMIT);
  const windowMs = boundedInteger(value?.windowMs, defaultWindowMs, 1_000, MAX_WINDOW_MS);
  return { limit, windowMs };
}

export function createRateLimiter(options = {}) {
  const envConfig = readRateLimitConfig(options.env || process.env);
  const windowMs = boundedInteger(options.windowMs, envConfig.windowMs, 1_000, MAX_WINDOW_MS);
  const maxEntries = boundedInteger(options.maxEntries, envConfig.maxEntries, 1, MAX_ENTRIES);
  const configuredLimits = options.limits || envConfig.limits;
  const scopeConfigs = new Map(Object.entries(configuredLimits || {}).map(([scope, value]) => [
    scope,
    normalizeScopeConfig(value, windowMs)
  ]));
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const trustProxy = options.trustProxy ?? options.env?.FLOWTWIN_TRUST_PROXY ?? process.env.FLOWTWIN_TRUST_PROXY;
  const trustedProxies = options.trustedProxies || null;
  const entries = new Map();
  const seenRequests = new WeakMap();
  const cleanupIntervalMs = Math.min(windowMs, 30_000);
  let lastCleanupAt = Number.NEGATIVE_INFINITY;

  function cleanup(at = now()) {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= at) entries.delete(key);
    }
    lastCleanupAt = at;
    return entries.size;
  }

  function evictOldest() {
    const oldestKey = entries.keys().next().value;
    if (oldestKey !== undefined) entries.delete(oldestKey);
  }

  function touchEntry(key, entry) {
    // Re-insert at the Map tail so oldest-accessed entries stay at the head for O(1) LRU eviction.
    entries.delete(key);
    entries.set(key, entry);
  }

  function consume(scope, identity, at = now()) {
    const scopeConfig = scopeConfigs.get(scope);
    if (!scopeConfig) return { allowed: true, scope, remaining: null, retryAfterSeconds: 0 };
    if (at - lastCleanupAt >= cleanupIntervalMs || at < lastCleanupAt) {
      cleanup(at);
    }
    const client = String(identity || "unknown");
    const key = `${scope}\u0000${client}`;
    let entry = entries.get(key);
    if (entry && entry.resetAt <= at) {
      entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (entries.size >= maxEntries && at !== lastCleanupAt) cleanup(at);
      if (entries.size >= maxEntries) evictOldest();
      entry = { count: 0, resetAt: at + scopeConfig.windowMs, lastSeenAt: at };
    }
    entry.lastSeenAt = at;
    if (entry.count >= scopeConfig.limit) {
      touchEntry(key, entry);
      return {
        allowed: false,
        scope,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - at) / 1000))
      };
    }
    entry.count += 1;
    touchEntry(key, entry);
    return {
      allowed: true,
      scope,
      remaining: Math.max(0, scopeConfig.limit - entry.count),
      retryAfterSeconds: 0
    };
  }

  function check(scope, request, at = now()) {
    if (request && (typeof request === "object" || typeof request === "function")) {
      const previous = seenRequests.get(request);
      if (previous) return previous;
      const result = consume(scope, getClientIdentity(request, { trustProxy, trustedProxies }), at);
      seenRequests.set(request, result);
      return result;
    }
    return consume(scope, getClientIdentity(request, { trustProxy, trustedProxies }), at);
  }

  return {
    check,
    consume,
    cleanup,
    get size() { return entries.size; },
    get configs() { return new Map(scopeConfigs); },
    maxEntries
  };
}
