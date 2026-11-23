import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CONTENT_SECURITY_POLICY,
  createRequestHandler,
  isTransientVisionResult,
  parseRequestUrl,
  SECURITY_HEADERS,
  validatePostRequestSecurity
} from "../server.mjs";
import { createRateLimiter } from "../lib/rate-limit.mjs";
import { approveFeishuStrategy, clearFeishuCaches } from "../lib/feishu-bitable.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// WHATWG Fetch blocks requests to these ports (undici throws `Error: bad port`).
// Windows ephemeral port allocation can occasionally assign 5060/5061/6000/etc.,
// so retry listen(0) if we land on one.
const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080
]);

async function withServer(overrides, run) {
  const limiter = overrides.rateLimiter || createRateLimiter({
    limits: {
      plan: 100, stt: 100, map: 100, cv: 100, operator: 100, validate: 100,
      "feishu-sync": 100, "feishu-status": 100, approve: 100, "version-check": 100, execution: 100
    },
    trustProxy: false
  });
  let server;
  let port;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = createServer(createRequestHandler({ ...overrides, rateLimiter: limiter }));
    await new Promise((resolve) => candidate.listen(0, "127.0.0.1", resolve));
    const boundPort = candidate.address().port;
    if (!FETCH_BAD_PORTS.has(boundPort)) {
      server = candidate;
      port = boundPort;
      break;
    }
    await new Promise((resolve) => candidate.close(resolve));
  }
  if (!server) throw new Error("FAILED_TO_BIND_SAFE_TEST_PORT");
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await run({ baseUrl, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("SECURITY_HEADERS include hardened CSP directives and are returned on HTML and API responses", async () => {
  assert.match(SECURITY_HEADERS["Content-Security-Policy"], /object-src 'none'/);
  assert.match(SECURITY_HEADERS["Content-Security-Policy"], /base-uri 'self'/);
  assert.match(SECURITY_HEADERS["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.equal(SECURITY_HEADERS["Content-Security-Policy"], CONTENT_SECURITY_POLICY);

  await withServer({ config: {} }, async ({ baseUrl }) => {
    const html = await fetch(`${baseUrl}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
    assert.equal(html.headers.get("x-content-type-options"), "nosniff");

    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.match(health.headers.get("content-security-policy") || "", /object-src 'none'/);
  });
});

test("JSON POST endpoints enforce Content-Type application/json and same-origin CSRF checks", async () => {
  await withServer({ config: {} }, async ({ baseUrl, port }) => {
    // Missing or text/plain Content-Type -> 415
    const plainRes = await fetch(`${baseUrl}/api/forecast`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ stations: [] })
    });
    assert.equal(plainRes.status, 415);
    assert.equal((await plainRes.json()).error, "UNSUPPORTED_MEDIA_TYPE");

    // Cross-site Origin -> 403
    const evilOrigin = await fetch(`${baseUrl}/api/forecast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example"
      },
      body: JSON.stringify({ stations: [] })
    });
    assert.equal(evilOrigin.status, 403);
    assert.equal((await evilOrigin.json()).error, "CSRF_FORBIDDEN");

    // Cross-site Sec-Fetch-Site -> 403
    const crossSite = await fetch(`${baseUrl}/api/forecast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "cross-site"
      },
      body: JSON.stringify({ stations: [] })
    });
    assert.equal(crossSite.status, 403);

    // Same-origin JSON POST -> 200
    const sameOrigin = await fetch(`${baseUrl}/api/forecast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Origin: `http://127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin"
      },
      body: JSON.stringify({ stations: [] })
    });
    assert.equal(sameOrigin.status, 200);
  });

  // Reverse-proxy HTTPS origin with matching Host passes CSRF check
  const proxyOk = validatePostRequestSecurity(
    {
      headers: {
        host: "demo.example.com",
        origin: "https://demo.example.com",
        "x-forwarded-proto": "https",
        "content-type": "application/json"
      }
    },
    new URL("http://demo.example.com/api/forecast")
  );
  assert.equal(proxyOk.ok, true);

  // Explicit default ports (:80 for HTTP, :443 for HTTPS) are accepted when scheme matches,
  // and rejected when port/scheme do not match.
  const parsedPort80 = parseRequestUrl({ url: "/api/forecast", headers: { host: "demo.example.com:80" } });
  assert.equal(parsedPort80.pathname, "/api/forecast");
  assert.equal(
    validatePostRequestSecurity(
      { headers: { host: "demo.example.com:80", origin: "http://demo.example.com", "content-type": "application/json" } },
      parsedPort80
    ).ok,
    true
  );

  const parsedPort443 = parseRequestUrl({ url: "/api/forecast", headers: { host: "demo.example.com:443" } });
  assert.equal(parsedPort443.pathname, "/api/forecast");
  assert.equal(
    validatePostRequestSecurity(
      {
        headers: {
          host: "demo.example.com:443",
          origin: "https://demo.example.com",
          "x-forwarded-proto": "https",
          "content-type": "application/json"
        }
      },
      parsedPort443
    ).ok,
    true
  );
  assert.equal(
    validatePostRequestSecurity(
      { headers: { host: "demo.example.com:443", origin: "http://demo.example.com", "content-type": "application/json" } },
      parsedPort443
    ).status,
    403
  );
  assert.equal(
    validatePostRequestSecurity(
      { headers: { host: "demo.example.com:80", origin: "https://demo.example.com", "content-type": "application/json" } },
      parsedPort80
    ).status,
    403
  );
  assert.equal(
    validatePostRequestSecurity(
      {
        headers: {
          host: "demo.example.com:8080",
          origin: "https://demo.example.com",
          "content-type": "application/json"
        }
      },
      parseRequestUrl({ url: "/api/forecast", headers: { host: "demo.example.com:8080" } })
    ).status,
    403
  );
});

test("invalid percent-encoding and malformed Host return HTTP 400 rather than 500", async () => {
  await withServer({ config: {} }, async ({ baseUrl }) => {
    const badUri = await fetch(`${baseUrl}/api/feishu/sync/%E0%A4%A`);
    assert.equal(badUri.status, 400);
    assert.equal((await badUri.json()).error, "INVALID_URI_ENCODING");
  });

  // Direct handler invocation with malformed Host header
  const handler = createRequestHandler({ config: {} });
  let statusCode = null;
  let bodyText = "";
  await handler(
    {
      method: "GET",
      url: "/api/health",
      headers: { host: "bad host:invalid" },
      socket: { remoteAddress: "127.0.0.1" }
    },
    {
      writeHead(code) { statusCode = code; },
      end(data = "") { bodyText = String(data); }
    }
  );
  assert.equal(statusCode, 400);
  assert.equal(JSON.parse(bodyText).error, "INVALID_REQUEST_URL");
});

test("Feishu strategy approval validates record ID format and status enum whitelist", async () => {
  clearFeishuCaches();
  const invalidId = await approveFeishuStrategy({ strategyRecordId: "../escape", status: "已确认", config: {} });
  assert.equal(invalidId.code, "INVALID_STRATEGY_RECORD_ID");

  const emptyId = await approveFeishuStrategy({ strategyRecordId: "   ", status: "已确认", config: {} });
  assert.equal(emptyId.code, "INVALID_STRATEGY_RECORD_ID");

  const invalidStatus = await approveFeishuStrategy({ strategyRecordId: "rec_12345", status: "任意注入状态", config: {} });
  assert.equal(invalidStatus.code, "INVALID_APPROVAL_STATUS");

  await withServer({ config: {} }, async ({ baseUrl }) => {
    const badIdRes = await fetch(`${baseUrl}/api/feishu/strategy/rec%20invalid/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "已确认" })
    });
    assert.equal(badIdRes.status, 400);
    assert.equal((await badIdRes.json()).code, "INVALID_STRATEGY_RECORD_ID");

    const badStatusRes = await fetch(`${baseUrl}/api/feishu/strategy/rec_valid_1/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "非法状态" })
    });
    assert.equal(badStatusRes.status, 400);
    assert.equal((await badStatusRes.json()).code, "INVALID_APPROVAL_STATUS");
  });
});

test("CV proxy checks body before locking slot and only retries transient video warmup failures", async () => {
  const baseVideoUnavailable = {
    ok: true,
    mode: "local-video-ocr-unavailable",
    inferenceStatus: "not-run",
    source: "本地视觉服务 · 视频 OCR 未就绪",
    vehicles: [],
    parking: [],
    arrivalRecognition: { status: "unavailable", plate: null, confidence: null },
    paymentReceipt: { status: "not-run", receiptId: null, amount: null, message: "未执行任何支付动作" },
    dataBoundary: "未执行"
  };
  assert.equal(
    isTransientVisionResult({ ...baseVideoUnavailable, reasonCode: "PADDLEOCR_NOT_READY", retryable: true }),
    true
  );
  assert.equal(
    isTransientVisionResult({ ...baseVideoUnavailable, evidence: ["本地运行条件：PADDLEOCR_NOT_READY"] }),
    true
  );
  assert.equal(
    isTransientVisionResult({ ...baseVideoUnavailable, reasonCode: "VIDEO_OCR_TIMEOUT", retryable: false }),
    false
  );
  assert.equal(
    isTransientVisionResult({ ...baseVideoUnavailable, reasonCode: "VIDEO_DECODE_FAILED", retryable: false }),
    false
  );
  assert.equal(
    isTransientVisionResult({ ...baseVideoUnavailable, reasonCode: "VIDEO_DECODER_UNAVAILABLE", retryable: false }),
    false
  );
  assert.equal(isTransientVisionResult(baseVideoUnavailable), false);
  assert.equal(
    isTransientVisionResult({ ...baseVideoUnavailable, mode: "local-ocr-unavailable", reasonCode: "OCR_IMAGE_DECODE_FAILED", retryable: false }),
    false
  );

  await withServer({ config: {} }, async ({ baseUrl }) => {
    const invalidJson = await fetch(`${baseUrl}/api/cv/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad-json"
    });
    assert.equal(invalidJson.status, 400);

    // Subsequent valid request is not blocked by cvInFlight leak
    const followUp = await fetch(`${baseUrl}/api/cv/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "sample" })
    });
    assert.equal(followUp.status, 400);
    assert.equal((await followUp.json()).error, "SAMPLE_IMAGE_REQUIRED");
  });
});

test("weather API preserves 0 degree temperature and POI API falls back to province for municipalities", async () => {
  const requestedUrls = [];
  const mockFetch = async (url) => {
    const href = String(url);
    requestedUrls.push(href);
    if (href.includes("/v3/geocode/regeo")) {
      return new Response(JSON.stringify({
        status: "1",
        regeocode: { addressComponent: { adcode: "110105", city: [], province: "北京市" } }
      }), { status: 200 });
    }
    if (href.includes("/v3/weather/weatherInfo")) {
      return new Response(JSON.stringify({
        status: "1",
        lives: [{ city: "朝阳区", weather: "晴", temperature: "0", humidity: "40", winddirection: "北", windpower: "3" }]
      }), { status: 200 });
    }
    if (href.includes("/v5/place/around")) {
      return new Response(JSON.stringify({ status: "1", pois: [] }), { status: 200 });
    }
    if (href.includes("/v3/place/text")) {
      return new Response(JSON.stringify({
        status: "1",
        pois: [{ id: "bj-1", name: "北京充电站", address: "朝阳路", location: "116.491,39.951" }]
      }), { status: 200 });
    }
    throw new Error(`unexpected URL ${href}`);
  };

  await withServer({
    config: { amapServiceKeys: ["test-key"], webServiceKey: "test-key" },
    fetchImpl: mockFetch
  }, async ({ baseUrl }) => {
    const weatherRes = await fetch(`${baseUrl}/api/weather?location=116.491,39.951`);
    assert.equal(weatherRes.status, 200);
    const weatherData = await weatherRes.json();
    assert.equal(weatherData.temperature, 0);

    const poiRes = await fetch(`${baseUrl}/api/poi?location=116.491,39.951&type=electric`);
    assert.equal(poiRes.status, 200);
    const poiData = await poiRes.json();
    assert.equal(poiData.pois.length, 1);
    assert.equal(poiData.source, "高德城市文本 POI");
    assert.ok(requestedUrls.some((href) => href.includes("/v3/place/text") && decodeURIComponent(href).includes("city=北京市")));
  });
});

test("STT endpoint passes rawText tags to polishTranscriptText and rejects CSRF", async () => {
  let llmCalled = false;
  const mockFetch = async (url) => {
    const href = String(url);
    if (href.includes("/audio/transcriptions")) {
      return new Response(JSON.stringify({ text: "<|zh|><|NEUTRAL|>去华山吧" }), { status: 200 });
    }
    if (href.includes("/chat/completions")) {
      llmCalled = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: "前往华山" } }] }), { status: 200 });
    }
    throw new Error(`unexpected URL ${href}`);
  };

  await withServer({
    config: {
      sttApiKey: "stt-key",
      sttBaseUrl: "https://stt.example.com/v1",
      sttModel: "sensevoice",
      aiBaseUrl: "https://ai.example.com/v1",
      aiApiKey: "ai-key",
      aiModel: "chat-model"
    },
    fetchImpl: mockFetch
  }, async ({ baseUrl }) => {
    const csrfBlocked = await fetch(`${baseUrl}/api/stt`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm", Origin: "https://evil.example" },
      body: Buffer.from("fake-audio")
    });
    assert.equal(csrfBlocked.status, 403);

    const okRes = await fetch(`${baseUrl}/api/stt`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm" },
      body: Buffer.from("fake-audio")
    });
    assert.equal(okRes.status, 200);
    const data = await okRes.json();
    assert.equal(llmCalled, true);
    assert.equal(data.text, "前往华山");
    assert.equal(data.rawText, "<|zh|><|NEUTRAL|>去华山吧");
  });
});

test("index.html and app.js harden DOM XSS, payment receipt modal placement, and lucide script attributes", async () => {
  const html = await readFile(`${repoRoot}/index.html`, "utf8");
  const appJs = await readFile(`${repoRoot}/app.js`, "utf8");

  // #paymentReceiptOverlay must not sit inside permanently hidden #demoNoticeBackdrop
  const demoBackdropMatch = html.match(/<div class="demo-notice-backdrop hidden" id="demoNoticeBackdrop">[\s\S]*?<\/div>\s*<div class="payment-receipt-overlay" id="paymentReceiptOverlay"/);
  assert.ok(demoBackdropMatch, "paymentReceiptOverlay should be a sibling outside demoNoticeBackdrop");

  // lucide external CDN script must include SRI + crossorigin + referrerpolicy
  const lucideTag = html.match(/<script[^>]*unpkg\.com\/lucide@0\.468\.0[^>]*><\/script>/)?.[0] || "";
  assert.match(lucideTag, /integrity="sha384-[A-Za-z0-9+/=]+"/);
  assert.match(lucideTag, /crossorigin="anonymous"/);
  assert.match(lucideTag, /referrerpolicy="no-referrer"/);

  // app.js must not pass raw <b> HTML into setText("paymentReceiptStation", ...)
  assert.equal(appJs.includes('setText("paymentReceiptStation", `车牌 <b>'), false);
  // Key previously-unescaped XSS sinks now use escapeHtml, while textContent uses rawServiceName
  assert.equal(appJs.includes('title="${title}"'), false);
  assert.equal(appJs.includes("可直达 ${state.destinationName}<span"), false);
  assert.equal(appJs.includes("途经 · ${record.station.name}"), false);
  assert.equal(appJs.includes("向${payload.targetUser"), false);
  assert.equal(appJs.includes("const rawServiceName = record.servicePlan?.name || \"\";"), true);
  assert.equal(appJs.includes("const safeServiceName = escapeHtml(rawServiceName);"), true);
  assert.equal(appJs.includes("服务停靠 · ${rawServiceName"), true);
  assert.equal(appJs.includes("已加入 ${rawServiceName"), true);
});
