const RETRYABLE_INFOCODES = new Set(["10003", "10004", "10010"]);

function cleanKey(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function getAmapServiceKeys(config = {}) {
  const values = [
    ...(Array.isArray(config.amapServiceKeys) ? config.amapServiceKeys : []),
    config.webServiceKey,
    config.webServiceKeyBackup
  ].map(cleanKey).filter(Boolean);
  return Array.from(new Set(values));
}

export function hasAmapServiceKey(config = {}) {
  return getAmapServiceKeys(config).length > 0;
}

function retryable({ responseStatus, payload, error }) {
  if (error) return true;
  if (responseStatus === 429 || responseStatus >= 500) return true;
  return RETRYABLE_INFOCODES.has(String(payload?.infocode || ""));
}

function endpointWithKey(endpoint, params, key) {
  const url = new URL(endpoint);
  const search = new URLSearchParams(params);
  search.set("key", key);
  url.search = search.toString();
  return url.toString();
}

/**
 * Request an AMap Web Service endpoint without exposing the key to callers.
 * The first configured key is primary. A later key is only attempted for a
 * quota/rate-limit, transient HTTP, or network failure; bad parameters and
 * platform/IP binding errors are returned immediately instead of being hidden
 * by a key rotation.
 */
export async function requestAmapJson(endpoint, params, {
  config = {},
  fetchImpl = fetch,
  timeoutMs = 10000,
  headers = { "User-Agent": "FlowTwin-Demo/1.0" }
} = {}) {
  const keys = getAmapServiceKeys(config);
  if (!keys.length) return { ok: false, payload: null, error: "AMAP_WEB_SERVICE_KEY_MISSING", attempts: 0 };

  let last = { ok: false, payload: null, error: "AMAP_UPSTREAM_UNAVAILABLE", attempts: 0 };
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    try {
      const response = await fetchImpl(endpointWithKey(endpoint, params, key), {
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
      const payload = await response.json().catch(() => null);
      const success = Boolean(response.ok && payload?.status === "1");
      last = {
        ok: success,
        payload,
        error: success ? null : payload?.info || "AMAP_REQUEST_FAILED",
        infocode: payload?.infocode || null,
        attempts: index + 1
      };
      if (success || !retryable({ responseStatus: response.status, payload })) return last;
    } catch (error) {
      last = {
        ok: false,
        payload: null,
        error: error?.name === "TimeoutError" ? "AMAP_TIMEOUT" : "AMAP_UPSTREAM_UNAVAILABLE",
        infocode: null,
        attempts: index + 1
      };
      if (index === keys.length - 1) return last;
    }
  }
  return last;
}
