import assert from "node:assert/strict";
import test from "node:test";
import {
  createRateLimiter,
  getClientIdentity,
  normalizeClientIp,
  readRateLimitConfig
} from "../lib/rate-limit.mjs";
import { applyRateLimit, rateLimitScopeForRequest } from "../server.mjs";

function makeRequest({ method = "POST", path = "/api/plan", ip = "::ffff:192.0.2.10", headers = {} } = {}) {
  return {
    method,
    url: path,
    headers: { host: "localhost", ...headers },
    socket: { remoteAddress: ip }
  };
}

function makeResponse() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body = "") {
      this.body = String(body);
    }
  };
}

test("rate-limit defaults and environment overrides stay bounded", () => {
  const defaults = readRateLimitConfig({});
  assert.deepEqual(defaults.limits, {
    plan: 30,
    stt: 10,
    map: 180,
    "feishu-sync": 10,
    approve: 20,
    "version-check": 12,
    execution: 6
  });
  assert.equal(defaults.windowMs, 600_000);
  assert.equal(defaults.maxEntries, 10_000);

  const overridden = readRateLimitConfig({
    FLOWTWIN_RATE_LIMIT_PLAN: "4",
    FLOWTWIN_RATE_LIMIT_STT: "3",
    FLOWTWIN_RATE_LIMIT_MAP: "12",
    FLOWTWIN_RATE_LIMIT_FEISHU_SYNC: "2",
    FLOWTWIN_RATE_LIMIT_APPROVE: "5",
    FLOWTWIN_RATE_LIMIT_VERSION_CHECK: "4",
    FLOWTWIN_RATE_LIMIT_EXECUTION: "3",
    FLOWTWIN_RATE_LIMIT_WINDOW_MS: "5000",
    FLOWTWIN_RATE_LIMIT_MAX_CLIENTS: "7"
  });
  assert.deepEqual(overridden, {
    limits: { plan: 4, stt: 3, map: 12, "feishu-sync": 2, approve: 5, "version-check": 4, execution: 3 },
    windowMs: 5000,
    maxEntries: 7
  });
  assert.equal(readRateLimitConfig({ FLOWTWIN_RATE_LIMIT_PLAN: "-1" }).limits.plan, 30);
  assert.equal(readRateLimitConfig({ FLOWTWIN_RATE_LIMIT_MAX_CLIENTS: "999999999" }).maxEntries, 10_000);
});

test("IPv4, mapped IPv6, and compressed IPv6 identities normalize consistently", () => {
  assert.equal(normalizeClientIp("192.0.2.10"), "192.0.2.10");
  assert.equal(normalizeClientIp("::ffff:192.0.2.10"), "192.0.2.10");
  assert.equal(normalizeClientIp("2001:0DB8:0000:0000:0000:0000:0000:0001"), "2001:db8::1");
  assert.equal(normalizeClientIp("[2001:db8::1]"), "2001:db8::1");
  assert.equal(normalizeClientIp("not-an-ip"), null);
  assert.equal(normalizeClientIp("192.0.2.10:443"), null);
});

test("proxy headers are ignored by default and trusted only with the explicit switch", () => {
  const request = makeRequest({
    ip: "::ffff:192.0.2.10",
    headers: {
      "cf-connecting-ip": "2001:0db8:0:0:0:0:0:1",
      "x-forwarded-for": "198.51.100.20",
      "x-real-ip": "203.0.113.30"
    }
  });
  assert.equal(getClientIdentity(request, { trustProxy: false }), "192.0.2.10");
  assert.equal(getClientIdentity(request, { trustProxy: "0" }), "192.0.2.10");
  assert.equal(getClientIdentity(request, { trustProxy: true }), "2001:db8::1");

  const forwardedOnly = makeRequest({
    ip: "192.0.2.10",
    headers: { "cf-connecting-ip": "not-an-ip", "x-forwarded-for": "2001:0db8::2, 198.51.100.20" }
  });
  assert.equal(getClientIdentity(forwardedOnly, { trustProxy: true }), "2001:db8::2");
  const arbitraryOnly = makeRequest({ ip: "192.0.2.10", headers: { "x-real-ip": "203.0.113.30" } });
  assert.equal(getClientIdentity(arbitraryOnly, { trustProxy: true }), "192.0.2.10");
});

test("a scope reaches its threshold, returns a retry window, and recovers", () => {
  let clock = 1_000;
  const limiter = createRateLimiter({
    limits: { plan: { limit: 2, windowMs: 10_000 } },
    maxEntries: 10,
    now: () => clock,
    trustProxy: false
  });
  assert.equal(limiter.check("plan", makeRequest()).allowed, true);
  assert.equal(limiter.check("plan", makeRequest()).allowed, true);
  const blocked = limiter.check("plan", makeRequest());
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, "plan");
  assert.equal(blocked.retryAfterSeconds, 10);
  clock = 11_000;
  assert.equal(limiter.check("plan", makeRequest()).allowed, true);
});

test("map, forecast, and longtrip share one aggregate scope", () => {
  let clock = 0;
  const limiter = createRateLimiter({
    limits: { map: { limit: 2, windowMs: 60_000 } },
    now: () => clock,
    trustProxy: false
  });
  assert.equal(limiter.check("map", makeRequest({ method: "GET", path: "/api/route" })).allowed, true);
  assert.equal(limiter.check("map", makeRequest({ method: "POST", path: "/api/forecast" })).allowed, true);
  assert.equal(limiter.check("map", makeRequest({ method: "POST", path: "/api/longtrip" })).allowed, false);
  clock = 60_000;
  assert.equal(limiter.check("map", makeRequest({ method: "GET", path: "/api/poi" })).allowed, true);
});

test("expired buckets are removed and the client map has a hard capacity", () => {
  let clock = 0;
  const limiter = createRateLimiter({
    limits: { plan: { limit: 100, windowMs: 1_000 } },
    maxEntries: 2,
    now: () => clock,
    trustProxy: false
  });
  limiter.consume("plan", "192.0.2.1");
  limiter.consume("plan", "192.0.2.2");
  assert.equal(limiter.size, 2);
  clock = 1_000;
  assert.equal(limiter.cleanup(), 0);
  limiter.consume("plan", "192.0.2.3");
  limiter.consume("plan", "192.0.2.4");
  limiter.consume("plan", "192.0.2.5");
  assert.equal(limiter.size, 2);
});

test("route gate limits expensive routes, leaves health alone, and skips OPTIONS", () => {
  let clock = 0;
  const limiter = createRateLimiter({
    limits: { plan: { limit: 1, windowMs: 60_000 } },
    now: () => clock,
    trustProxy: false
  });
  const first = makeRequest({ path: "/api/plan" });
  assert.equal(rateLimitScopeForRequest("POST", "/api/plan"), "plan");
  assert.equal(rateLimitScopeForRequest("GET", "/api/route"), "map");
  assert.equal(rateLimitScopeForRequest("POST", "/api/feishu/strategy/rec-1/approve"), "approve");
  assert.equal(rateLimitScopeForRequest("GET", "/api/version/check"), "version-check");
  assert.equal(rateLimitScopeForRequest("POST", "/api/execution"), "execution");
  assert.equal(rateLimitScopeForRequest("GET", "/api/health"), null);
  assert.equal(rateLimitScopeForRequest("GET", "/api/version"), null);

  assert.equal(applyRateLimit(first, makeResponse(), limiter), true);
  // The same request object is not charged twice, even if a handler guard is
  // accidentally reached again during one request lifecycle.
  assert.equal(applyRateLimit(first, makeResponse(), limiter), true);

  const blockedResponse = makeResponse();
  assert.equal(applyRateLimit(makeRequest({ path: "/api/plan" }), blockedResponse, limiter), false);
  assert.equal(blockedResponse.statusCode, 429);
  assert.equal(blockedResponse.headers["Retry-After"], "60");
  assert.deepEqual(JSON.parse(blockedResponse.body), {
    error: "RATE_LIMITED",
    scope: "plan",
    retryAfterSeconds: 60
  });
  assert.equal(blockedResponse.body.includes("192.0.2.10"), false);

  const optionsLimiter = createRateLimiter({ limits: { plan: 1 }, trustProxy: false });
  assert.equal(applyRateLimit(makeRequest({ method: "OPTIONS" }), makeResponse(), optionsLimiter), true);
  assert.equal(applyRateLimit(makeRequest(), makeResponse(), optionsLimiter), true);

  const healthLimiter = createRateLimiter({ limits: { plan: 1 }, trustProxy: false });
  for (let index = 0; index < 20; index += 1) {
    assert.equal(applyRateLimit(makeRequest({ method: "GET", path: "/api/health" }), makeResponse(), healthLimiter), true);
  }
});
