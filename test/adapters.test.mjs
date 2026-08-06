import assert from "node:assert/strict";
import test from "node:test";
import { requestAmapJson } from "../lib/amap.mjs";
import {
  clearFeishuCaches,
  feishuConfigSummary,
  getFeishuSyncStatus,
  startFeishuSync
} from "../lib/feishu-bitable.mjs";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("AMap rotates to the backup service key only after a quota response", async () => {
  const urls = [];
  let calls = 0;
  const result = await requestAmapJson(
    "https://restapi.amap.com/v3/geocode/geo",
    new URLSearchParams({ address: "上海" }),
    {
      config: { amapServiceKeys: ["primary-key", "backup-key"] },
      fetchImpl: async (url) => {
        urls.push(String(url));
        calls += 1;
        return calls === 1
          ? response({ status: "0", info: "OVER_LIMIT", infocode: "10004" })
          : response({ status: "1", geocodes: [] });
      }
    }
  );
  assert.equal(result.ok, true);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /key=primary-key/);
  assert.match(urls[1], /key=backup-key/);
});

test("AMap does not hide a platform binding error by rotating keys", async () => {
  let calls = 0;
  const result = await requestAmapJson(
    "https://restapi.amap.com/v3/geocode/geo",
    new URLSearchParams({ address: "上海" }),
    {
      config: { amapServiceKeys: ["primary-key", "backup-key"] },
      fetchImpl: async () => {
        calls += 1;
        return response({ status: "0", info: "USERKEY_PLAT_NOMATCH", infocode: "10009" });
      }
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.infocode, "10009");
  assert.equal(calls, 1);
});

test("Feishu Bitable sync writes snapshots and reads the AI field", async () => {
  clearFeishuCaches();
  const config = {
    feishuBaseUrl: "https://open.feishu.cn",
    feishuAppId: "app-id",
    feishuAppSecret: "fake-app-secret",
    feishuAppToken: "base-token",
    feishuSnapshotTableId: "tbl-snapshot",
    feishuStrategyTableId: "tbl-strategy",
    feishuAiStrategyField: "AI策略"
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("tenant_access_token")) return response({ code: 0, tenant_access_token: "tenant-token", expire: 7200 });
    if (String(url).includes("batch_create")) return response({ code: 0, data: { records: [{ record_id: "snapshot-1" }] } });
    if (options.method === "POST") return response({ code: 0, data: { record: { record_id: "strategy-1" } } });
    return response({ code: 0, data: { record: { fields: { "AI策略": "建议将高峰需求引导至承接站，并保留容量边界。" } } } });
  };
  const started = await startFeishuSync({
    config,
    fetchImpl,
    payload: {
      runId: "run-test-1",
      source: "FlowTwin 演示仿真",
      stations: [{ id: "station-1", name: "示例站", type: "充电站", occupancy: 0.72, p50: 8, p90: 16, price: 1.4 }],
      strategy: { targetUser: "价格敏感用户", discountAmount: 4, impact: { divertedVehicles: 3, roi: 1.2 }, targetStation: { name: "承接站" } }
    }
  });
  assert.equal(started.used, true);
  assert.equal(started.status, "processing");
  assert.equal(started.source, "FlowTwin 演示仿真");
  assert.ok(calls.some((call) => call.url.includes("batch_create")));
  assert.ok(calls.every((call) => !call.url.includes("fake-app-secret")));

  const status = await getFeishuSyncStatus({ syncId: started.syncId, config, fetchImpl });
  assert.equal(status.status, "completed");
  assert.match(status.aiResult, /引导至承接站/);
});

test("Feishu remains an explicit local demo when credentials are absent", async () => {
  clearFeishuCaches();
  const summary = feishuConfigSummary({});
  assert.equal(summary.configured, false);
  const result = await startFeishuSync({ config: {}, payload: { stations: [] } });
  assert.equal(result.mode, "local-demo");
  assert.equal(result.status, "not-configured");
});
