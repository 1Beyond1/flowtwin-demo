import { createHash } from "node:crypto";

// This cache stores only derived planning results.  It is intentionally kept
// in memory: AMap route/POI responses already have the persistent file cache,
// while a planning result must never outlive a server restart and be mistaken
// for a fresh operational decision.
export const LONG_TRIP_PLAN_CACHE_TTL_MS = 30 * 60 * 1000;
export const LONG_TRIP_PLAN_CACHE_MAX_ENTRIES = 120;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
      const normalized = canonical(value[key]);
      return normalized === undefined ? [] : [[key, normalized]];
    }));
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  return undefined;
}

function fiveMinuteBucket(value) {
  const minute = Number(value);
  if (!Number.isFinite(minute)) return value;
  // The queue model is sampled in five-minute slots.  Keeping that same
  // cadence here lets a user repeat the same demo request without starting a
  // new combinatorial search because the wall clock ticked by one minute.
  return Math.floor(minute / 5) * 5;
}

function decisionNumber(value, precision = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Number(numeric.toFixed(precision));
}

function cacheStationSnapshot(station) {
  const normalized = canonical(station);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return normalized;
  // Keep only variables that can alter the station sequence or its total
  // time/cost.  A forecast response also carries calculated P50/P90, display
  // labels and audit timestamps. Feeding those derived values back into the
  // cache key would make an unchanged station miss again on every refresh.
  const copy = {};
  const exactFields = [
    "id", "name", "type", "location", "address", "source", "stationSource",
    "progressKm", "routeProgress", "detourKm", "detour", "price",
    "estimatedChargePowerKw", "estimatedRefuelRateLpm", "paymentExitMinutes",
    "arrivalOffsetMinutes", "totalPorts", "idlePorts", "availablePorts",
    "reservedPorts", "chargingPorts", "faultPorts", "waitingVehicles",
    "queueVehicles", "reservationQueueAhead", "estimatedReleaseMinutes",
    "averageSessionMinutes", "provisionalCorridor", "serviceAreaCandidate"
  ];
  exactFields.forEach((key) => {
    if (normalized[key] !== undefined) copy[key] = normalized[key];
  });
  // Input feeds can contain fractional/continuously refreshed aggregate
  // values. Keep meaningful station-pressure changes in the key, while
  // ignoring sub-minute simulation noise that is below the UI's minute-level
  // explanation and cannot justify rerunning a 12,000-candidate search.
  [["occupancy", 2], ["capacity", 0], ["arrivalRate", 1], ["serviceRate", 1], ["trend", 3], ["enterpriseDemandFactor", 3]]
    .forEach(([key, precision]) => {
      const value = decisionNumber(normalized[key], precision);
      if (value !== undefined) copy[key] = value;
    });
  const hasPortState = ["totalPorts", "idlePorts", "availablePorts", "reservedPorts", "chargingPorts", "faultPorts"]
    .some((key) => Number.isFinite(Number(normalized[key])))
    || Array.isArray(normalized.estimatedReleaseMinutes);
  // A legacy/third-party station without port telemetry has no stronger queue
  // signal than its supplied wait percentiles, so those values must remain
  // cache-invalidating.  For a port snapshot they are regenerated server-side
  // from the physical state above and therefore are intentionally excluded.
  if (!hasPortState) {
    ["wait", "p50", "p90"].forEach((key) => {
      const value = decisionNumber(normalized[key], 1);
      if (value !== undefined) copy[key] = value;
    });
  }
  if (normalized.enterprisePrior && typeof normalized.enterprisePrior === "object" && !Array.isArray(normalized.enterprisePrior)) {
    const prior = normalized.enterprisePrior;
    copy.enterprisePrior = {
      matched: prior.matched === true,
      city: prior.city,
      energyType: prior.energyType,
      demandFactor: decisionNumber(prior.demandFactor, 3),
      meanServiceMinutes: decisionNumber(prior.meanServiceMinutes, 1),
      modelVersion: prior.modelVersion
    };
  }
  return copy;
}

export function projectLongTripPlanningInput(input) {
  const normalized = canonical(input);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return normalized;
  const projection = { ...normalized };
  if (Object.prototype.hasOwnProperty.call(projection, "departureMinutes")) {
    projection.departureMinutes = fiveMinuteBucket(projection.departureMinutes);
  }
  if (Array.isArray(projection.stations)) {
    projection.stations = projection.stations.map(cacheStationSnapshot);
  }
  return projection;
}

function cacheKey(input) {
  return createHash("sha256").update(JSON.stringify(projectLongTripPlanningInput(input))).digest("hex");
}

export function createLongTripPlanCache({
  now = Date.now,
  ttlMs = LONG_TRIP_PLAN_CACHE_TTL_MS,
  maxEntries = LONG_TRIP_PLAN_CACHE_MAX_ENTRIES
} = {}) {
  const entries = new Map();
  const inFlight = new Map();
  const counters = { hit: 0, miss: 0, evicted: 0 };

  const currentTime = () => Number(now());
  const purge = (time = currentTime()) => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= time) entries.delete(key);
    }
    while (entries.size > Math.max(1, Number(maxEntries) || 1)) {
      entries.delete(entries.keys().next().value);
      counters.evicted += 1;
    }
  };

  return {
    async getOrLoad(input, loader) {
      if (typeof loader !== "function") throw new TypeError("LONG_TRIP_CACHE_LOADER_REQUIRED");
      const key = cacheKey(input);
      const time = currentTime();
      purge(time);
      const existing = entries.get(key);
      if (existing && existing.expiresAt > time) {
        counters.hit += 1;
        return { value: existing.value, cache: { state: "hit", expiresAt: new Date(existing.expiresAt).toISOString() } };
      }
      const pending = inFlight.get(key);
      if (pending) return pending;
      const operation = Promise.resolve().then(async () => {
        counters.miss += 1;
        const value = await loader();
        const createdAt = currentTime();
        entries.set(key, { value, expiresAt: createdAt + Math.max(1, Number(ttlMs) || 1) });
        purge(createdAt);
        return { value, cache: { state: "miss", expiresAt: new Date(createdAt + Math.max(1, Number(ttlMs) || 1)).toISOString() } };
      });
      inFlight.set(key, operation);
      try {
        return await operation;
      } finally {
        inFlight.delete(key);
      }
    },
    getStats() {
      purge();
      return { ...counters, entries: entries.size, ttlMs: Math.max(1, Number(ttlMs) || 1) };
    }
  };
}
