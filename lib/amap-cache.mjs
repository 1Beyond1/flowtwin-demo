import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// This cache stores only normalized route/POI/geocode results.  It never stores
// the upstream query URL (which contains the AMap key) or any request headers.
// The cache is deliberately file-backed so a process restart does not turn a
// repeated demo click into another burst of Web Service requests.
export const AMAP_CACHE_TTLS = Object.freeze({
  route: 10 * 60 * 1000,
  poi: 24 * 60 * 60 * 1000,
  geocode: 30 * 24 * 60 * 60 * 1000,
  place: 7 * 24 * 60 * 60 * 1000,
  regeo: 7 * 24 * 60 * 60 * 1000,
  weather: 10 * 60 * 1000
});

const CACHE_SCHEMA = 1;
const DEFAULT_STALE_IF_ERROR_MS = 7 * 24 * 60 * 60 * 1000;

function currentTime(now) {
  const value = typeof now === "function" ? now() : now;
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function cleanPart(value) {
  if (typeof value === "string") return value.trim().slice(0, 20_000);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value).slice(0, 20_000);
  }
}

function cacheHash(kind, key) {
  return createHash("sha256")
    .update(`${kind}\u0000${key}`)
    .digest("hex");
}

function safeKind(value) {
  const text = String(value || "unknown").replace(/[^a-z0-9_-]/gi, "-").slice(0, 40);
  return text || "unknown";
}

function metadata(state, entry, now) {
  return {
    state,
    cachedAt: entry?.createdAt ? new Date(entry.createdAt).toISOString() : null,
    expiresAt: entry?.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
    ageMs: entry?.createdAt ? Math.max(0, now - entry.createdAt) : null
  };
}

async function readEntry(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || parsed.schema !== CACHE_SCHEMA || !Number.isFinite(parsed.createdAt)
      || !Number.isFinite(parsed.expiresAt) || !Object.hasOwn(parsed, "value")) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeEntry(file, entry) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(entry), { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, file);
    } catch (error) {
      // Windows does not replace an existing destination with rename().  A
      // concurrent writer has already produced an equally valid value in that
      // case; replace it only after the temp file is complete.
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      await rm(file, { force: true });
      await rename(temporary, file);
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function createAmapFileCache({
  root,
  now = Date.now,
  staleIfErrorMs = DEFAULT_STALE_IF_ERROR_MS
} = {}) {
  if (!root) throw new Error("AMAP_CACHE_ROOT_REQUIRED");
  const directory = join(root, "runtime", "cache", "amap");
  const inFlight = new Map();
  const counters = { hit: 0, miss: 0, stale: 0, write: 0, readError: 0 };

  function fileFor(kind, keyParts) {
    const normalizedKind = safeKind(kind);
    const key = Array.isArray(keyParts)
      ? keyParts.map(cleanPart).join("\u0001")
      : cleanPart(keyParts);
    const hash = cacheHash(normalizedKind, key);
    return join(directory, `${normalizedKind}-${hash}.json`);
  }

  async function getOrLoad(kind, keyParts, loader, options = {}) {
    if (typeof loader !== "function") throw new TypeError("AMAP_CACHE_LOADER_REQUIRED");
    const file = fileFor(kind, keyParts);
    const ttlMs = Number.isFinite(Number(options.ttlMs))
      ? Math.max(1, Number(options.ttlMs))
      : AMAP_CACHE_TTLS[kind] || AMAP_CACHE_TTLS.route;
    const staleWindow = Number.isFinite(Number(options.staleIfErrorMs))
      ? Math.max(0, Number(options.staleIfErrorMs))
      : staleIfErrorMs;
    const nowMs = currentTime(now);
    const cached = await readEntry(file);
    if (cached && cached.expiresAt > nowMs) {
      counters.hit += 1;
      return { value: cached.value, cache: metadata("hit", cached, nowMs) };
    }

    const flightKey = file;
    const existing = inFlight.get(flightKey);
    if (existing) return existing;

    const operation = (async () => {
      counters.miss += 1;
      try {
        const value = await loader();
        if (value === undefined) throw new Error("AMAP_CACHE_EMPTY_RESULT");
        const createdAt = currentTime(now);
        const entry = {
          schema: CACHE_SCHEMA,
          kind: safeKind(kind),
          createdAt,
          expiresAt: createdAt + ttlMs,
          value
        };
        try {
          await mkdir(directory, { recursive: true });
          await writeEntry(file, entry);
          counters.write += 1;
        } catch {
          // A read-only deployment must not turn a successful upstream query
          // into a failed route. It simply loses the disk-cache benefit.
        }
        return { value, cache: metadata("miss", entry, createdAt) };
      } catch (error) {
        const staleNow = currentTime(now);
        if (cached && staleWindow > 0 && staleNow - cached.expiresAt <= staleWindow) {
          counters.stale += 1;
          return {
            value: cached.value,
            cache: metadata("stale", cached, staleNow),
            upstreamError: error
          };
        }
        throw error;
      }
    })();
    inFlight.set(flightKey, operation);
    try {
      return await operation;
    } finally {
      inFlight.delete(flightKey);
    }
  }

  async function read(kind, keyParts, options = {}) {
    const file = fileFor(kind, keyParts);
    const nowMs = currentTime(now);
    const cached = await readEntry(file);
    if (!cached) return null;
    if (cached.expiresAt > nowMs) {
      counters.hit += 1;
      return { value: cached.value, cache: metadata("hit", cached, nowMs) };
    }
    const staleWindow = Number.isFinite(Number(options.staleIfErrorMs))
      ? Math.max(0, Number(options.staleIfErrorMs))
      : staleIfErrorMs;
    if (staleWindow > 0 && nowMs - cached.expiresAt <= staleWindow) {
      counters.stale += 1;
      return { value: cached.value, cache: metadata("stale", cached, nowMs) };
    }
    return null;
  }

  return {
    directory,
    getOrLoad,
    read,
    getStats() {
      return { ...counters };
    }
  };
}
