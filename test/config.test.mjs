import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, parseDotEnv, stripJsComments } from "../lib/config.mjs";

async function withTempRoot(run) {
  const dir = await mkdtemp(join(tmpdir(), "flowtwin-config-test-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("stripJsComments removes line and block comments without corrupting URLs in quotes", () => {
  const source = `window.FLOWTWIN_CONFIG = {
    // publicDemo: true,
    /* amapKey: "commented-out",
       port: 9999, */
    publicDemo: false, // trailing comment
    aiBaseUrl: "https://example.com/v1", // keep https:// intact
    feishuBaseUrl: 'https://open.feishu.cn'
  };`;
  const stripped = stripJsComments(source);
  assert.equal(stripped.includes("commented-out"), false);
  assert.equal(stripped.includes("9999"), false);
  assert.match(stripped, /"https:\/\/example\.com\/v1"/);
  assert.match(stripped, /'https:\/\/open\.feishu\.cn'/);
});

test("loadConfig parses unquoted boolean publicDemo, numeric port, and ignores commented values", async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, "config.local.js"), `window.FLOWTWIN_CONFIG = {
      // publicDemo: false,
      /* amapKey: "wrong-key",
         port: 9999, */
      publicDemo: true,
      port: 4321,
      amapKey: "real-js-key",
      aiBaseUrl: "https://ai.example.com/v1", // inline comment
      aiApiKey: "real-ai-key",
      aiModel: "demo-model"
    };`, "utf8");

    const loaded = await loadConfig({ env: {}, root });
    assert.equal(loaded.publicDemo, true);
    assert.equal(loaded.port, 4321);
    assert.equal(loaded.amapKey, "real-js-key");
    assert.equal(loaded.aiBaseUrl, "https://ai.example.com/v1");
    assert.equal(loaded.aiApiKey, "real-ai-key");
    assert.equal(loaded.aiModel, "demo-model");
  });
});

test("loadConfig loads optional .env while keeping process env higher priority than .env and config.local.js", async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, ".env"), [
      "# comment line",
      "PORT=4400",
      "FLOWTWIN_PUBLIC_DEMO=1",
      "AMAP_JS_KEY=from-dotenv",
      'AI_BASE_URL="https://dotenv.example.com/v1"',
      "AI_MODEL=dotenv-model # trailing comment",
      "export FLOWTWIN_TRUST_PROXY=cloudflare"
    ].join("\n"), "utf8");
    await writeFile(join(root, "config.local.js"), `window.FLOWTWIN_CONFIG = {
      port: 4300,
      publicDemo: false,
      amapKey: "from-local-js",
      aiModel: "local-js-model",
      aiApiKey: "local-js-secret"
    };`, "utf8");

    const fromDotEnv = await loadConfig({ env: {}, root });
    assert.equal(fromDotEnv.port, 4400);
    assert.equal(fromDotEnv.publicDemo, true);
    assert.equal(fromDotEnv.amapKey, "from-dotenv");
    assert.equal(fromDotEnv.aiBaseUrl, "https://dotenv.example.com/v1");
    assert.equal(fromDotEnv.aiModel, "dotenv-model");
    assert.equal(fromDotEnv.aiApiKey, "local-js-secret");
    assert.equal(fromDotEnv.trustProxy, "cloudflare");

    const overridden = await loadConfig({
      env: { PORT: "4555", AMAP_JS_KEY: "from-env", FLOWTWIN_PUBLIC_DEMO: "0" },
      root
    });
    assert.equal(overridden.port, 4555);
    assert.equal(overridden.amapKey, "from-env");
    assert.equal(overridden.publicDemo, false);
    assert.equal(overridden.aiModel, "dotenv-model");
  });
});

test("loadConfig safely falls back to port 4182 when PORT is invalid", async () => {
  await withTempRoot(async (root) => {
    for (const invalidPort of ["not-a-number", "0", "-42", "70000", "4182.5", "4182abc", "NaN"]) {
      const loaded = await loadConfig({ env: { PORT: invalidPort }, root });
      assert.equal(loaded.port, 4182, `expected 4182 fallback for PORT=${invalidPort}`);
    }
    await writeFile(join(root, "config.local.js"), `window.FLOWTWIN_CONFIG = { port: 99999 };`, "utf8");
    const badLocalPort = await loadConfig({ env: {}, root });
    assert.equal(badLocalPort.port, 4182);
  });
});

test("parseDotEnv ignores prototype pollution keys and malformed lines", () => {
  const parsed = parseDotEnv("__proto__=evil\nconstructor=evil\nVALID_KEY='hello # not comment'\nBAD-KEY=1\n");
  assert.equal(parsed.VALID_KEY, "hello # not comment");
  assert.equal(Object.hasOwn(parsed, "__proto__"), false);
  assert.equal(Object.hasOwn(parsed, "constructor"), false);
  assert.equal(Object.hasOwn(parsed, "BAD-KEY"), false);
});
