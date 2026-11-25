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
  for (const phrase of [
    "中途想吃早饭",
    "中途吃个早餐",
    "顺便吃午饭",
    "路上吃午餐",
    "中途吃顿晚饭",
    "安排一下晚餐",
    "晚上想吃夜宵",
    "随便吃点快餐",
    "想喝杯奶茶",
    "顺便找个便利店",
    "进服务区休息",
    "吃点小吃",
    "吃份简餐"
  ]) {
    assert.equal(intent.extractServiceKeyword(phrase), null, `expected generic phrase "${phrase}" to stay unnamed`);
  }
});

test("frontend intent helper stops at trailing clauses and ignores negated brand mentions", async () => {
  const intent = await loadBrowserServiceIntent();
  assert.equal(intent.extractServiceKeyword("中途想吃烤鱼顺便喝咖啡"), "烤鱼");
  assert.equal(intent.extractServiceKeyword("中途想吃烤鱼然后去休息"), "烤鱼");
  assert.equal(intent.extractServiceKeyword("中途想吃牛肉面再喝杯奶茶"), "牛肉面");
  assert.equal(intent.extractServiceKeyword("不想吃麦当劳"), null);
  assert.equal(intent.extractServiceKeyword("不要星巴克"), null);
  assert.equal(intent.extractServiceKeyword("不去肯德基"), null);
  assert.equal(intent.extractServiceKeyword("不想吃麦当劳，想喝星巴克"), "星巴克");
  assert.equal(intent.extractServiceKeyword("不去肯德基，中途想吃烤鱼"), "烤鱼");
  assert.deepEqual(
    Array.from(intent.extractServiceKeywords("中途想先吃麦当劳，然后再去喝星巴克")),
    ["麦当劳", "星巴克"]
  );
  assert.deepEqual(
    Array.from(intent.extractServiceKeywords("中途想吃烤鱼顺便喝瑞幸")),
    ["烤鱼", "瑞幸"]
  );
  assert.deepEqual(
    Array.from(intent.extractServiceKeywords("不想吃麦当劳，中途先吃烤鱼再喝瑞幸")),
    ["烤鱼", "瑞幸"]
  );
  // Coordinated brand negation should strip all negated brands, not leak the second one.
  assert.deepEqual(
    Array.from(intent.extractServiceKeywords("不要去麦当劳和肯德基，去星巴克")),
    ["星巴克"]
  );
  // Unpunctuated negation clause should stop before a positive service action.
  assert.deepEqual(
    Array.from(intent.extractServiceKeywords("不想排队去吃麦当劳")),
    ["麦当劳"]
  );
  // Destination/corridor nouns before a generic meal/coffee verb must not become brand names.
  assert.deepEqual(Array.from(intent.extractServiceKeywords("去北京南站吃饭")), []);
  assert.deepEqual(Array.from(intent.extractServiceKeywords("去杭州西湖喝咖啡")), []);
  assert.deepEqual(Array.from(intent.extractServiceKeywords("到高速服务区吃饭")), []);
  // Known brand match must merge with after-verb unknown brands instead of returning early.
  assert.deepEqual(
    Array.from(intent.extractServiceKeywords("顺便吃麦当劳喝霸王茶姬")),
    ["麦当劳", "霸王茶姬"]
  );
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
