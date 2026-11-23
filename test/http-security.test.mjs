import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CONTENT_SECURITY_POLICY,
  createRequestHandler,
  isTransientVisionResult,
  SECURITY_HEADERS,
  validatePostRequestSecurity
} from "../server.mjs";
import { createRateLimiter } from "../lib/rate-limit.mjs";
import { approveFeishuStrategy, clearFeishuCaches } from "../lib/feishu-bitable.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function withServer(overrides, run) {
  const limiter = overrides.rateLimiter || createRateLimiter({
    limits: {
      plan: 100, stt: 100, map: 100, cv: 100, operator: 100, validate: 100,
      "feishu-sync": 100, "feishu-status": 100, approve: 100, "version-check": 100, execution: 100
    },
    trustProxy: false
  });
  const server = createServer(createRequestHandler({ ...overrides, rateLimiter: limiter }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
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

test("CV proxy checks body before locking slot and treats local-video-ocr-unavailable as transient", async () => {
  const videoUnavailable = {
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
  assert.equal(isTransientVisionResult(videoUnavailable), true);

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
  // Key previously-unescaped XSS sinks now use escapeHtml
  assert.equal(appJs.includes('title="${title}"'), false);
  assert.equal(appJs.includes("可直达 ${state.destinationName}<span"), false);
  assert.equal(appJs.includes("途经 · ${record.station.name}"), false);
  assert.equal(appJs.includes("向${payload.targetUser"), false);
});
