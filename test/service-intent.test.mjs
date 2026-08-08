import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildPoiSearchRequest } from "../server.mjs";

async function loadBrowserServiceIntent() {
  const source = await readFile(new URL("../service-intent.js", import.meta.url), "utf8");
  const context = { window: {}, console };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "service-intent.js" });
  return context.window.FlowTwinServiceIntent;
}

test("frontend intent helper keeps concrete brands and leaves generic meal requests unnamed", async () => {
  const intent = await loadBrowserServiceIntent();
  assert.equal(intent.extractServiceKeyword("中途想去吃麦当劳"), "麦当劳");
  assert.equal(intent.extractServiceKeyword("中途想喝星巴克"), "星巴克");
  assert.equal(intent.extractServiceKeyword("中途想吃烤鱼"), "烤鱼");
  assert.equal(intent.extractServiceKeyword("中途想吃点东西"), null);
});

test("frontend service choice never silently replaces an explicit brand", async () => {
  const intent = await loadBrowserServiceIntent();
  const unrelated = { name: "天祥餐馆", address: "沿线服务区" };
  const exact = { name: "麦当劳（上海某店）", address: "上海市" };

  assert.equal(intent.matchesPoi("麦当劳", unrelated), false);
  assert.equal(intent.matchesPoi("麦当劳", exact), true);
  assert.equal(intent.chooseServiceCandidate([unrelated], "麦当劳").candidate, null);
  assert.deepEqual(intent.chooseServiceCandidate([unrelated], "麦当劳").alternatives, [unrelated]);
  assert.equal(intent.chooseServiceCandidate([exact, unrelated], "麦当劳").candidate, exact);
  assert.equal(intent.chooseServiceCandidate([unrelated], "").candidate, unrelated);
});

test("server-side AMap POI search receives the explicit service keyword", () => {
  const request = buildPoiSearchRequest({
    location: "121.499700,31.239700",
    type: "meal",
    keyword: "麦当劳"
  });
  assert.equal(request.type, "meal");
  assert.equal(request.keyword, "麦当劳");
  assert.equal(request.params.get("keywords"), "麦当劳");

  const generic = buildPoiSearchRequest({
    location: "121.499700,31.239700",
    type: "meal"
  });
  assert.equal(generic.keyword, "餐厅");
  assert.equal(generic.params.get("keywords"), "餐厅");
});
