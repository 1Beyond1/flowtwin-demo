import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAiBaseUrl } from "../lib/config.mjs";
import { formatPlanResponse, parseTripIntent, scorePlaceCandidate } from "../lib/plan.mjs";
import { forecastStations, waitToP90, p90ToWait } from "../lib/forecast.mjs";
import { simulateOperator } from "../lib/operator.mjs";
import { validateStrategies, createScenarios } from "../lib/validate.mjs";
import { executeFeishu } from "../lib/feishu.mjs";
import { evaluateDirectTrip, evaluateStationStop, getEnergyProfile, isFuelEnergyType } from "../lib/energy.mjs";
import { buildLongTripPlans } from "../lib/longtrip.mjs";
import { cleanTranscriptText, polishTranscriptText } from "../lib/stt.mjs";

const stations = [
  { id: "a", name: "A站", type: "充电站", occupancy: 0.78, wait: 16, capacity: 20, demand: 14, serviceRate: 4, price: 1.55 },
  { id: "b", name: "B站", type: "充电站", occupancy: 0.42, wait: 6, capacity: 24, demand: 8, serviceRate: 5, price: 1.22 },
  { id: "c", name: "C站", type: "充电站", occupancy: 0.56, wait: 9, capacity: 18, demand: 10, serviceRate: 4, price: 1.35 }
];

test("AI base URL rejects unsafe protocols and credentials", () => {
  assert.equal(normalizeAiBaseUrl("file:///tmp/key"), "");
  assert.equal(normalizeAiBaseUrl("https://user:pass@example.com/v1"), "");
  assert.equal(normalizeAiBaseUrl("https://ark.cn-beijing.volces.com/api/coding/v3"), "https://ark.cn-beijing.volces.com/api/coding/v3");
});

test("plan parser uses strict AI JSON and returns locations without exposing secrets", async () => {
  const calls = [];
  const result = await parseTripIntent({
    message: "从公司去大兴机场，最晚19:30前到，到达至少保留60%，最多绕行5公里，最好附近能吃饭",
    config: { aiBaseUrl: "https://example.com/v1", aiApiKey: "test-secret", aiModel: "test-model", webServiceKey: "geo-secret" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          origin: "能链北京总部", destination: "大兴机场", arrivalDeadline: null,
          minArrivalSoc: 60, energyType: "electric", priority: "on_time", maxDetourKm: 5, services: ["餐饮"],
          clarificationNeeded: false, assistantReply: "已识别"
        }) } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "1", geocodes: [{ location: "116.410000,39.509000" }] }), { status: 200 });
    }
  });
  assert.equal(result.aiUsed, true);
  assert.equal(result.destination, "大兴机场");
  assert.equal(result.minArrivalSoc, 60);
  assert.deepEqual(result.locations.origin.coordinate, [116.491, 39.951]);
  assert.deepEqual(result.locations.destination.coordinate, [116.41, 39.509]);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-secret");
  assert.equal(calls[0].options.body.includes("departureTime"), false);
  assert.equal(calls[0].options.body.includes('"soc"'), false);
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
});

test("plan parser fails over from the primary AI provider to the backup", async () => {
  const calls = [];
  const result = await parseTripIntent({
    message: "中途想去吃麦当劳，然后再喝咖啡",
    context: { hasPlannedRoute: true, currentDestination: "南京" },
    config: {
      aiBaseUrl: "https://primary.example/v1",
      aiApiKey: "primary-secret",
      aiModel: "primary-model",
      aiBackupBaseUrl: "https://backup.example/v1",
      aiBackupApiKey: "backup-secret",
      aiBackupModel: "backup-model"
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith("https://primary.example")) return new Response("upstream unavailable", { status: 503 });
      if (url.startsWith("https://backup.example")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          origin: "北京", destination: "南京", arrivalDeadline: null,
          minArrivalSoc: null, energyType: "unknown", priority: "on_time", maxDetourKm: null,
          services: [], clarificationNeeded: false, assistantReply: "已识别"
        }) } }] }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    }
  });
  assert.equal(result.aiUsed, true);
  assert.equal(result.destination, "南京");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, "Bearer primary-secret");
  assert.equal(calls[1].options.headers.Authorization, "Bearer backup-secret");
  assert.equal(JSON.stringify(result).includes("primary-secret"), false);
  assert.equal(JSON.stringify(result).includes("backup-secret"), false);
});

test("plan parser leaves current time and energy to the client controls", async () => {
  const result = await parseTripIntent({
    message: "18:30去大兴机场，电量22%，不能迟到",
    config: { aiBaseUrl: "https://example.com/v1", aiApiKey: "test-secret", aiModel: "test-model" },
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(result.aiUsed, false);
  assert.equal(result.destination, "大兴机场");
  assert.equal(Object.hasOwn(result, "departureTime"), false);
  assert.equal(Object.hasOwn(result, "soc"), false);
});

test("simple explicit new trips stay local and do not call AI", async () => {
  const calls = [];
  const result = await parseTripIntent({
    message: "从能链北京总部去南京，优先准时",
    config: {
      aiBaseUrl: "https://primary.example/v1",
      aiApiKey: "primary-secret",
      aiModel: "primary-model",
      aiBackupBaseUrl: "https://backup.example/v1",
      aiBackupApiKey: "backup-secret",
      aiBackupModel: "backup-model"
    },
    fetchImpl: async (url) => {
      calls.push(String(url));
      throw new Error("AI must not be called for a simple new trip");
    }
  });
  assert.equal(result.aiUsed, false);
  assert.equal(result.analysis.mode, "rules");
  assert.deepEqual(result.analysis.ai, {
    configured: true,
    attempted: false,
    used: false,
    fallback: false,
    reason: null
  });
  assert.equal(calls.length, 0);
  assert.ok(result.analysis.score > 0);
  assert.ok(result.analysis.factors.every((factor) => ["pass", "warn", "fail"].includes(factor.status)));
  assert.ok(result.analysis.factors.every((factor) => Object.keys(factor).sort().join(",") === "delta,evidence,id,label,status"));
  assert.equal(result.analysis.comparison.status, "rules-only");
  assert.equal(result.analysis.comparison.safety.status, "passed");
  assert.equal(result.analysis.comparison.ai, null);
  assert.equal(formatPlanResponse(result).analysis.mode, "rules");
});

test("a bare place query resolves through AMap without requiring a destination verb", async () => {
  const messages = ["天津站", "搜天津站"];
  for (const message of messages) {
    const result = await parseTripIntent({
      message,
      config: { webServiceKey: "geo-key" },
      fetchImpl: async (url) => {
        const href = String(url);
        if (href.includes("place/text")) {
          return new Response(JSON.stringify({
            status: "1",
            pois: [
              { name: "天津站", location: "117.2200,39.1400", type: "交通设施服务;火车站", typecode: "150200", pname: "天津市", cityname: "天津市", adname: "和平区" },
              { name: "天津西站", location: "117.1700,39.1700", type: "交通设施服务;火车站", typecode: "150200", pname: "天津市", cityname: "天津市", adname: "红桥区" }
            ]
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          status: "1",
          geocodes: [{ formatted_address: "天津站", province: "天津市", city: "天津市", district: "和平区", level: "门牌号", location: "117.2200,39.1400" }]
        }), { status: 200 });
      }
    });
    assert.equal(result.aiUsed, false);
    assert.equal(result.destination, "天津站");
    assert.equal(result.clarificationNeeded, false);
    assert.deepEqual(result.locations.destination.coordinate, [117.22, 39.14]);
    assert.equal(result.locations.destination.needsPick, false);
  }
});

test("multi-turn composite service requests call AI after local parsing", async () => {
  const calls = [];
  const result = await parseTripIntent({
    message: "中途想去吃麦当劳，然后再喝咖啡",
    context: { hasPlannedRoute: true, currentDestination: "上海东方明珠广播电视塔" },
    config: { aiBaseUrl: "https://primary.example/v1", aiApiKey: "primary-secret", aiModel: "primary-model" },
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (!String(url).includes("chat/completions")) throw new Error("unexpected lookup");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        origin: null,
        destination: "上海东方明珠广播电视塔",
        arrivalDeadline: null,
        minArrivalSoc: null,
        energyType: "unknown",
        priority: "balanced",
        maxDetourKm: null,
        services: ["餐饮"],
        requestMode: "supplement",
        actions: [{ type: "ADD_SERVICE", service: "餐饮", name: "麦当劳" }],
        clarificationNeeded: false,
        assistantReply: "已补充服务停靠"
      }) } }] }), { status: 200 });
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(result.analysis.mode, "hybrid");
  assert.equal(result.analysis.ai.attempted, true);
  assert.equal(result.analysis.ai.used, true);
  assert.equal(result.analysis.ai.reason, null);
  assert.equal(result.analysis.comparison.status, "compared");
  assert.equal(result.analysis.comparison.agreement.compared, true);
  assert.equal(result.analysis.comparison.safety.status, "passed");
  assert.equal(result.requestMode, "supplement");
  assert.deepEqual(result.services, ["餐饮"]);
});

test("existing-trip destination modifications still enter AI", async () => {
  let callCount = 0;
  const result = await parseTripIntent({
    message: "把目的地改成南京",
    context: { hasPlannedRoute: true, currentDestination: "上海东方明珠广播电视塔" },
    config: { aiBaseUrl: "https://primary.example/v1", aiApiKey: "primary-secret", aiModel: "primary-model" },
    fetchImpl: async (url) => {
      if (!String(url).includes("chat/completions")) throw new Error("unexpected lookup");
      callCount += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        origin: null,
        destination: "南京",
        arrivalDeadline: null,
        minArrivalSoc: null,
        energyType: "unknown",
        priority: "balanced",
        maxDetourKm: null,
        services: [],
        requestMode: "new_trip",
        actions: [{ type: "CHANGE_DESTINATION", destination: "南京" }],
        clarificationNeeded: false,
        assistantReply: "已更换目的地"
      }) } }] }), { status: 200 });
    }
  });
  assert.equal(callCount, 1);
  assert.equal(result.analysis.mode, "hybrid");
  assert.equal(result.requestMode, "new_trip");
  assert.equal(result.destination, "南京");
});

test("AI failure falls back without exposing provider details in analysis", async () => {
  const result = await parseTripIntent({
    message: "中途想去那里吃饭",
    context: { hasPlannedRoute: true, currentDestination: "上海东方明珠广播电视塔" },
    config: { aiBaseUrl: "https://primary.example/v1", aiApiKey: "primary-secret", aiModel: "primary-model" },
    fetchImpl: async (url) => {
      if (String(url).includes("chat/completions")) return new Response(JSON.stringify({ error: { message: "quota exceeded at https://provider.example" } }), { status: 429 });
      throw new Error("unexpected lookup");
    }
  });
  const publicResult = formatPlanResponse(result);
  assert.equal(result.aiUsed, false);
  assert.equal(result.aiFailureCode, "quota");
  assert.equal(publicResult.analysis.mode, "rules-fallback");
  assert.equal(publicResult.analysis.ai.configured, true);
  assert.equal(publicResult.analysis.ai.attempted, true);
  assert.equal(publicResult.analysis.ai.fallback, true);
  assert.equal(publicResult.analysis.ai.reason, "quota");
  assert.equal(publicResult.analysis.comparison.status, "fallback");
  assert.equal(publicResult.analysis.comparison.safety.status, "passed");
  assert.equal(JSON.stringify(publicResult.analysis).includes("primary.example"), false);
  assert.equal(JSON.stringify(publicResult.analysis).includes("quota exceeded"), false);
  assert.equal(JSON.stringify(publicResult.analysis).includes("https://"), false);
});

test("confidence analysis is deterministic for identical local evidence", async () => {
  const input = {
    message: "从能链北京总部去南京，最晚19:30前到，到达至少保留40%，优先准时",
    config: {},
    fetchImpl: async () => { throw new Error("offline"); }
  };
  const first = await parseTripIntent(input);
  const second = await parseTripIntent(input);
  assert.deepEqual(first.analysis, second.analysis);
  assert.equal(first.analysis.mode, "rules");
  assert.equal(first.analysis.ai.attempted, false);
});

test("plan parser keeps parsing the destination arrival reserve", async () => {
  const result = await parseTripIntent({
    message: "现在电量22%，去北京南站，到达目的地时电量要有80%以上",
    context: { destination: "北京南站", minArrivalSoc: 20 },
    config: {},
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(result.minArrivalSoc, 80);
});

test("plan parser leaves deadline and arrival reserve unset when the user did not request them", async () => {
  const result = await parseTripIntent({
    message: "从能链北京总部去北京南站，尽量省钱",
    context: { arrivalDeadline: "19:30", minArrivalSoc: 40 },
    config: {},
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(result.arrivalDeadline, null);
  assert.equal(result.minArrivalSoc, null);
});

test("plan parser treats a service follow-up as a supplement to the current trip", async () => {
  const result = await parseTripIntent({
    message: "中途想去吃麦当劳",
    context: {
      hasPlannedRoute: true,
      currentDestination: "上海东方明珠广播电视塔"
    },
    config: {},
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(result.requestMode, "supplement");
  assert.equal(result.destination, "上海东方明珠广播电视塔");
  assert.deepEqual(result.services, ["餐饮"]);
  assert.deepEqual(result.analysis.ai, {
    configured: false,
    attempted: true,
    used: false,
    fallback: true,
    reason: "not_configured"
  });
});

test("plan parser treats an explicit new destination as a new trip", async () => {
  const result = await parseTripIntent({
    message: "我想去南京",
    context: {
      hasPlannedRoute: true,
      currentDestination: "上海东方明珠广播电视塔"
    },
    config: {},
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(result.requestMode, "new_trip");
  assert.equal(result.destination, "南京");
});

test("an explicit new destination wins over a stale airport completion", async () => {
  const result = await parseTripIntent({
    message: "从能链北京总部前往燕郊站，到达至少保留30%",
    context: { destination: "北京大兴国际机场" },
    config: { aiBaseUrl: "https://example.com/v1", aiApiKey: "test-secret", aiModel: "test-model" },
    fetchImpl: async (url) => {
      if (url.includes("chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          origin: "能链北京总部", destination: "北京大兴国际机场", arrivalDeadline: null,
          minArrivalSoc: 20, energyType: "electric", priority: "on_time", maxDetourKm: null, services: [], clarificationNeeded: false
        }) } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "0", geocodes: [] }), { status: 200 });
    }
  });
  assert.equal(result.destination, "燕郊站");
  assert.equal(result.clarificationNeeded, false);
  assert.equal(result.locations.destination, null);
  assert.equal(result.analysis.factors.find((factor) => factor.id === "geographic-match")?.status, "fail");
});

test("national geocoding accepts a destination outside Beijing", async () => {
  const result = await parseTripIntent({
    message: "从能链北京总部前往燕郊站",
    config: { webServiceKey: "geo-key" },
    fetchImpl: async () => new Response(JSON.stringify({
      status: "1",
      geocodes: [{ province: "河北省", city: "廊坊市", district: "三河市", location: "116.814,39.999" }]
    }), { status: 200 })
  });
  assert.equal(result.destination, "燕郊站");
  assert.deepEqual(result.locations.destination.coordinate, [116.814, 39.999]);
  assert.equal(result.analysis.factors.find((factor) => factor.id === "geographic-match")?.status, "pass");
});

test("geographic ambiguity is surfaced as a confirmation factor", async () => {
  const result = await parseTripIntent({
    message: "从能链北京总部前往测试地点",
    config: { webServiceKey: "geo-key" },
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("place/text")) {
        return new Response(JSON.stringify({
          status: "1",
          pois: [
            { name: "测试地点甲", location: "120.1000,30.1000", type: "风景名胜", typecode: "110200", pname: "浙江省", cityname: "杭州市" },
            { name: "测试地点乙", location: "120.2000,30.2000", type: "风景名胜", typecode: "110200", pname: "浙江省", cityname: "杭州市" }
          ]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "1", geocodes: [] }), { status: 200 });
    }
  });
  assert.equal(result.locations.destination.needsPick, true);
  assert.equal(result.analysis.factors.find((factor) => factor.id === "geographic-match")?.status, "warn");
});

test("ambiguous 东方明珠 is canonicalized to the Shanghai landmark before geocoding", async () => {
  const requestedUrls = [];
  const result = await parseTripIntent({
    message: "从能链北京总部前往东方明珠，最晚23:00前到",
    config: { webServiceKey: "geo-key" },
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      return new Response(JSON.stringify({
        status: "1",
        geocodes: [{ province: "上海市", city: "上海市", district: "浦东新区", location: "121.4997,31.2397", formatted_address: "上海东方明珠广播电视塔", level: "兴趣点" }],
        pois: []
      }), { status: 200 });
    }
  });
  assert.equal(result.destination, "上海东方明珠广播电视塔");
  assert.ok(requestedUrls.some((url) => /geocode%2Fgeo|geocode\/geo/.test(url) || url.includes("geocode")));
  assert.ok(requestedUrls.some((url) => decodeURIComponent(url).includes("上海东方明珠广播电视塔")));
  assert.deepEqual(result.locations.destination.coordinate, [121.4997, 31.2397]);
});

test("the stock 东方明珠 prompt resolves an exact landmark instead of opening a redundant picker", async () => {
  const result = await parseTripIntent({
    message: "从能链北京总部前往上海东方明珠广播电视塔，优先准时",
    config: { webServiceKey: "geo-key" },
    fetchImpl: async (url) => {
      if (String(url).includes("place/text")) {
        return new Response(JSON.stringify({
          status: "1",
          pois: [
            { name: "东方明珠广播电视塔", location: "121.499718,31.239703", type: "风景名胜", typecode: "110200", pname: "上海市", cityname: "上海市", adname: "浦东新区" },
            { name: "上海东方明珠广播电视塔有限公司", location: "121.499764,31.239910", type: "公司企业", typecode: "120000", pname: "上海市", cityname: "上海市", adname: "浦东新区" }
          ]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: "1",
        geocodes: [{ formatted_address: "东方明珠广播电视塔", province: "上海市", city: "上海市", district: "浦东新区", location: "121.499718,31.239703", level: "兴趣点" }]
      }), { status: 200 });
    }
  });
  assert.equal(result.locations.destination.needsPick, false);
  assert.deepEqual(result.locations.destination.coordinate, [121.499718, 31.239703]);
  const publicResult = formatPlanResponse(result);
  assert.deepEqual(publicResult.destinationLocation, [121.499718, 31.239703]);
  assert.equal(publicResult.destinationNeedsPick, false);
});

test("华山 is canonicalized to 西岳华山风景区 (not the same-named Jinan park) and prefers scenic POI", async () => {
  const requestedUrls = [];
  const result = await parseTripIntent({
    message: "从能链北京总部前往华山，优先准时",
    config: { webServiceKey: "geo-key" },
    fetchImpl: async (url) => {
      const href = String(url);
      requestedUrls.push(href);
      if (href.includes("place/text")) {
        return new Response(JSON.stringify({
          status: "1",
          pois: [{
            name: "华山风景区",
            location: "110.0905,34.4820",
            type: "风景名胜;风景名胜;风景名胜",
            typecode: "110200",
            pname: "陕西省",
            cityname: "渭南市",
            adname: "华阴市"
          }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: "1",
        geocodes: [{
          formatted_address: "上海市静安区华山路",
          province: "上海市",
          city: "上海市",
          district: "静安区",
          level: "道路",
          location: "121.4400,31.2200"
        }]
      }), { status: 200 });
    }
  });
  assert.equal(result.destination, "西岳华山风景区");
  assert.ok(requestedUrls.some((url) => decodeURIComponent(url).includes("西岳华山风景区")));
  assert.deepEqual(result.locations.destination.coordinate, [110.0905, 34.482]);
  assert.equal(result.locations.destination.source, "高德地点检索");
});

test("a bare city query resolves to the city, not a same-prefix station", async () => {
  const result = await parseTripIntent({
    message: "从能链北京总部去天津",
    config: { webServiceKey: "geo-key" },
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("place/text")) {
        return new Response(JSON.stringify({
          status: "1",
          pois: [
            // Same place, same point as the geocode hit below. Scored low here,
            // so dedupe must not let this copy shadow the administrative one.
            { name: "天津市", location: "117.201509,39.085318", typecode: "190102", pname: "天津市", cityname: "天津市" },
            { name: "天津站", location: "117.2200,39.1400", typecode: "150200", pname: "天津市", cityname: "天津市" },
            { name: "天津西站", location: "117.1700,39.1700", typecode: "150200", pname: "天津市", cityname: "天津市" },
            { name: "天津南站", location: "117.1000,39.0300", typecode: "150200", pname: "天津市", cityname: "天津市" }
          ]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: "1",
        geocodes: [{ formatted_address: "天津市", province: "天津市", city: "天津市", level: "省", location: "117.201509,39.085318" }]
      }), { status: 200 });
    }
  });
  assert.equal(result.locations.destination.name, "天津市");
  assert.equal(result.locations.destination.needsPick, false);
});

test("plan response reports why the model was skipped instead of failing silently", async () => {
  const result = await parseTripIntent({
    message: "中途想去那里吃饭",
    context: { hasPlannedRoute: true, currentDestination: "上海东方明珠广播电视塔" },
    config: { aiBaseUrl: "https://ai.example.com/v1", aiApiKey: "test-key", aiModel: "m" },
    fetchImpl: async (url) => {
      if (String(url).includes("chat/completions")) {
        return new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 });
      }
      return new Response(JSON.stringify({ status: "1", geocodes: [], pois: [] }), { status: 200 });
    }
  });
  assert.equal(result.aiUsed, false);
  assert.equal(result.aiFailureCode, "quota");
  const response = formatPlanResponse(result);
  assert.equal(response.aiFallbackReason, "AI 配额已用尽，已用本地规则解析");
  assert.equal(response.analysis.ai.reason, "quota");
});

test("place scoring prefers scenic names over bare admin roads", () => {
  const scenic = scorePlaceCandidate({
    name: "华山风景区",
    type: "风景名胜",
    typecode: "110200",
    province: "陕西省",
    city: "渭南市",
    source: "高德地点检索"
  }, "华山风景区");
  const road = scorePlaceCandidate({
    name: "华山路",
    type: "道路",
    level: "道路",
    province: "上海市",
    city: "上海市",
    source: "高德地理编码"
  }, "华山风景区");
  assert.ok(scenic > road);
});

test("place scoring prefers a university campus over a same-name metro station", () => {
  const campus = scorePlaceCandidate({
    name: "示例大学",
    type: "科教文化服务;学校;高等院校",
    typecode: "141201",
    province: "江苏省",
    city: "南京市",
    source: "高德地点检索"
  }, "示例大学");
  const metro = scorePlaceCandidate({
    name: "示例大学(地铁站)",
    type: "交通设施服务;地铁站;地铁站",
    typecode: "150500",
    province: "江苏省",
    city: "南京市",
    source: "高德地点检索"
  }, "示例大学");
  assert.ok(campus > metro);
});

test("plan response exposes parsed and destinationLocation contract", () => {
  const response = formatPlanResponse({
    origin: "能链北京总部",
    destination: "大兴机场",
    aiUsed: false,
    locations: { origin: { coordinate: [116.491, 39.951], source: "默认" }, destination: { coordinate: [116.41, 39.509], source: "高德" } }
  });
  assert.equal(response.parsed.destination, "大兴机场");
  assert.deepEqual(response.destinationLocation, [116.41, 39.509]);
  assert.equal(response.locationSources.destination, "高德");
  assert.deepEqual(response.destinationCandidates, []);
});

test("formatPlanResponse includes destination candidates when resolvePlace is ambiguous", () => {
  const response = formatPlanResponse({
    origin: "能链北京总部",
    destination: "测试地点",
    aiUsed: false,
    locations: {
      destination: {
        coordinate: [120, 30],
        source: "高德地点检索",
        name: "测试风景区",
        candidates: [
          { name: "测试风景区", coordinate: [120, 30], city: "杭州市", score: 80, source: "高德地点检索" },
          { name: "测试路", coordinate: [121, 31], city: "上海市", score: 70, source: "高德地理编码" }
        ]
      }
    }
  });
  assert.equal(response.parsed.destination, "测试风景区");
  assert.equal(response.destinationCandidates.length, 2);
  assert.equal(response.destinationCandidates[0].name, "测试风景区");
});

test("STT base URL validation matches AI base URL safety and public runtime never leaks keys", () => {
  assert.equal(normalizeAiBaseUrl("https://api.siliconflow.cn/v1"), "https://api.siliconflow.cn/v1");
  assert.equal(normalizeAiBaseUrl("https://user:pass@api.siliconflow.cn/v1"), "");
  assert.equal(normalizeAiBaseUrl("file:///tmp/stt"), "");
  const sample = { sttApiKey: "stt-secret-should-not-leak", sttBaseUrl: "https://api.siliconflow.cn/v1" };
  const publicRuntime = {
    amapKey: "public-js-key",
    securityJsCode: "public-security",
    mapMode: "live",
    sttEnabled: Boolean(sample.sttApiKey)
  };
  assert.equal(publicRuntime.sttEnabled, true);
  assert.equal(JSON.stringify(publicRuntime).includes("stt-secret"), false);
  assert.equal(Object.hasOwn(publicRuntime, "sttApiKey"), false);
});

test("cleanTranscriptText strips SenseVoice emotion and language tags", () => {
  assert.equal(
    cleanTranscriptText("<|zh|><|NEUTRAL|><|Speech|>从能链北京总部前往华山，优先准时"),
    "从能链北京总部前往华山，优先准时"
  );
  assert.equal(cleanTranscriptText("去上海东方明珠"), "去上海东方明珠");
  assert.equal(cleanTranscriptText("我想去。南京大学。"), "我想去 南京大学。");
  assert.equal(cleanTranscriptText("<|en|><|HAPPY|>hello"), "hello");
});

test("polishTranscriptText uses AI when tags remain noisy and fails open without AI", async () => {
  const plain = await polishTranscriptText("去北京南站", {}, async () => {
    throw new Error("should not call");
  });
  assert.equal(plain, "去北京南站");

  const polished = await polishTranscriptText(
    "<|zh|><|NEUTRAL|>从公司去华山吧嗯优先准时",
    { aiBaseUrl: "https://example.com/v1", aiApiKey: "k", aiModel: "m" },
    async () => new Response(JSON.stringify({
      choices: [{ message: { content: "从公司前往华山，优先准时" } }]
    }), { status: 200 })
  );
  assert.equal(polished, "从公司前往华山，优先准时");

  const fallback = await polishTranscriptText(
    "<|zh|><|SAD|>去华山",
    { aiBaseUrl: "https://example.com/v1", aiApiKey: "k", aiModel: "m" },
    async () => { throw new Error("offline"); }
  );
  assert.equal(fallback, "去华山");
});

test("explicit destination coordinate from picker skips re-geocoding", async () => {
  let fetchCount = 0;
  const result = await parseTripIntent({
    message: "从能链北京总部前往华山",
    context: {
      explicitDestination: "华山风景区",
      destinationLocation: [110.09, 34.48]
    },
    config: { webServiceKey: "geo-key" },
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ status: "1", geocodes: [], pois: [] }), { status: 200 });
    }
  });
  assert.equal(result.destination, "西岳华山风景区");
  assert.deepEqual(result.locations.destination.coordinate, [110.09, 34.48]);
  assert.equal(result.locations.destination.source, "用户选定候选");
  assert.equal(fetchCount, 0);
});

test("forecast is deterministic and produces 0..30 minute points", () => {
  const first = forecastStations(stations, { demandFactor: 1.1 });
  const second = forecastStations(stations, { demandFactor: 1.1 });
  assert.deepEqual(first, second);
  assert.deepEqual(first.stations[0].forecast.map((point) => point.minute), [0, 5, 10, 15, 20, 25, 30]);
  assert.ok(first.stations[0].forecast.every((point) => point.occupancy >= 0.05 && point.occupancy <= 0.99));
});

test("forecast weatherFactor raises wait monotonically and defaults to no effect", () => {
  // weatherFactor 来自高德实况：雨雪天抬高到达率，P50/P90 应随之上升。
  // 缺省为 1，不接天气时预测与原来完全一致。
  const calm = forecastStations(stations, { weatherFactor: 1 });
  const rainy = forecastStations(stations, { weatherFactor: 1.2 });
  const calmP90 = calm.stations[0].forecast.map((p) => p.p90);
  const rainyP90 = rainy.stations[0].forecast.map((p) => p.p90);
  // 30 分钟末点：雨天必须明显高于晴天
  assert.ok(rainyP90.at(-1) > calmP90.at(-1), `rain did not raise P90: ${calmP90.at(-1)} -> ${rainyP90.at(-1)}`);
  // weatherFactor=1 时场景里也如实回显
  assert.equal(calm.scenario.weatherFactor, 1);
  assert.equal(rainy.scenario.weatherFactor, 1.2);
});

test("forecast and operator share one wait→P90 relationship", () => {
  // 预测页按 p90 = wait*k + b 生成，运营页要把前端送回来的 p90 反解成 wait。
  // 曾经预测端写 1.68、运营端写 1.65，于是运营模型拿 1.65 去解 1.68 生成的数，
  // 同一个站点在两个页面上挂着两条不同的分布。这个往返必须是恒等的。
  for (const wait of [0, 3.5, 12, 47.25]) {
    assert.ok(Math.abs(p90ToWait(waitToP90(wait)) - wait) < 1e-9, `round-trip broke at ${wait}`);
  }
  // 预测端产出的 p90 必须能被运营端原样还原成它自己的 wait。容差 0.1 是
  // 两处 toFixed(1) 的量化误差之和：wait 自身 ±0.05，p90 的 ±0.05 反解时
  // 放大成 ±0.05/1.65。系数一旦再次分叉，误差是 5% 量级，远超这个门槛。
  const [forecasted] = forecastStations(stations, {}).stations;
  for (const point of forecasted.forecast) {
    assert.ok(Math.abs(p90ToWait(point.p90) - point.wait) < 0.1, `forecast p90 ${point.p90} does not invert to wait ${point.wait}`);
  }
});

test("forecast explanation only claims what the model actually computes", () => {
  const [entry] = forecastStations(stations, {}).stations;
  // "每 5 分钟到达率"曾经把画图的取样间隔当成速率单位，读数直接差 5 倍
  assert.ok(!/每 ?5 ?分钟/.test(entry.explanation), entry.explanation);
  assert.match(entry.explanation, /辆\/分钟/);
});

test("operator simulation changes with discount and calculates impact", () => {
  const low = simulateOperator({ stations, discountAmount: 0, targetStationId: "b", targetUser: "价格敏感用户" });
  const high = simulateOperator({ stations, discountAmount: 10, targetStationId: "b", targetUser: "价格敏感用户" });
  assert.ok(high.impact.divertedVehicles > low.impact.divertedVehicles);
  assert.ok(high.impact.discountCost > 0);
  assert.notEqual(high.after.averageWait, high.before.averageWait);
  assert.equal(high.stations.length, 3);
});

test("operator simulation defaults to the lowest-load receiving station", () => {
  const result = simulateOperator({ stations, discountAmount: 6 });
  assert.equal(result.targetStation.id, "b");
});

test("validation runs at least 1000 seeded trips for all strategies", () => {
  const result = validateStrategies({ seed: 42, trips: 1000, stations });
  assert.equal(result.trips, 1000);
  assert.equal(result.inputMode, "current-stations");
  assert.equal(result.stationCount, 3);
  assert.equal(result.stationTemplates.length, 3);
  assert.ok(result.methodology.formulas.queue.includes("基础排队"));
  assert.deepEqual(Object.keys(result.strategies), ["nearest", "cheapest", "realtime", "flowtwin"]);
  for (const summary of Object.values(result.strategies)) {
    assert.equal(summary.trips, 1000);
    assert.ok(Number.isFinite(summary.averageWait));
    assert.ok(Number.isFinite(summary.p90Wait));
    assert.ok(Number.isFinite(summary.averageStopMinutes));
    assert.ok(summary.averageStopMinutes >= summary.averageWait);
    assert.ok(summary.onTimeRate >= 0 && summary.onTimeRate <= 100);
  }
  // FlowTwin 的目标函数是准点率和负载均衡，不是最小化平均等待。以前这里断言
  // 它在四项指标上全面碾压 realtime，能过是因为它能读到尾部风险的真值；改成
  // 带误差的预测之后，3 站夹具上它会拿几秒钟平均等待去换准点率——这是策略的
  // 真实取舍，断言应该盯着它真正承诺的东西。
  assert.ok(result.strategies.flowtwin.onTimeRate >= result.strategies.realtime.onTimeRate);
  // 负载离散度是观测结果，不应被测试写成 FlowTwin 必然优于基线的承诺；
  // 本实验只要求它可计算、量纲稳定，页面展示真实结果而不是替它背书。
  assert.ok(Number.isFinite(result.strategies.flowtwin.loadDispersion));
  assert.ok(result.strategies.flowtwin.loadDispersion >= 0);
  assert.ok(result.strategies.flowtwin.p90Wait <= result.strategies.nearest.p90Wait);
  assert.ok(result.strategies.flowtwin.p90Wait <= result.strategies.cheapest.p90Wait);
  // 让出去的平均等待必须是"几秒钟"量级，不能借着准点率把等待放飞
  assert.ok(result.strategies.flowtwin.averageWait <= result.strategies.realtime.averageWait * 1.02);
});

test("validation load dispersion is scale-free and ROI responds to the scenario", () => {
  // loadDispersion 曾经是利用率的标准差，随行程数线性放大：同一套站点跑 1000
  // 次是 4.34，跑 8000 次是 34.6，用户改一下样本量就以为负载均衡崩了。
  const dispersions = [1000, 4000, 10000].map((trips) => validateStrategies({ seed: 42, trips }).strategies.flowtwin.loadDispersion);
  for (const value of dispersions) assert.ok(Math.abs(value - dispersions[0]) < 0.1, `dispersion drifted with sample size: ${dispersions.join(", ")}`);

  // ROI 曾经恒等于 mean(margin)/4.5——券没进选站逻辑，毛利按每一单全额计，
  // 换种子只在 3.1~3.3 之间晃。真实的 ROI 必须随场景变化，也必须能亏。
  const rois = [1, 42, 777, 20260719].map((seed) => validateStrategies({ seed, trips: 1000 }).strategies.flowtwin.roi);
  assert.ok(Math.max(...rois) - Math.min(...rois) > 0.3, `ROI barely moved across seeds: ${rois.join(", ")}`);
  for (const strategy of ["nearest", "cheapest", "realtime"]) {
    assert.equal(validateStrategies({ seed: 42, trips: 1000 }).strategies[strategy].roi, 0);
  }
});

test("validation gives FlowTwin only a noisy tail forecast, not the realised value", () => {
  const [scenario] = createScenarios(42, 1);
  for (const station of scenario.stations) {
    assert.ok(Number.isFinite(station.tail) && Number.isFinite(station.tailEstimate));
    // 预测值必须落在真值的 0.7~1.3 倍内，且不能恒等于真值
    assert.ok(station.tailEstimate >= station.tail * 0.7 - 1e-9);
    assert.ok(station.tailEstimate <= station.tail * 1.3 + 1e-9);
  }
  assert.ok(scenario.stations.some((station) => Math.abs(station.tailEstimate - station.tail) > 1e-6));
});

test("Feishu execution stays local without a webhook", async () => {
  const result = await executeFeishu({ payload: { targetStation: "B站" }, config: {} });
  assert.equal(result.used, false);
  assert.equal(result.mode, "local-demo");
});

test("energy model skips charging when a full EV can meet the destination reserve directly", () => {
  const result = evaluateDirectTrip({ energyType: "electric", soc: 100, minArrivalSoc: 20, distanceKm: 55 });
  assert.equal(result.canDirect, true);
  assert.equal(result.needsCharge, false);
  assert.ok(result.arrivalSoc > 80);
});

test("energy model rejects a low-SOC EV station that cannot be reached with the safety reserve", () => {
  const result = evaluateStationStop({
    energyType: "electric", soc: 5, minArrivalSoc: 20,
    firstLegKm: 25, totalDistanceKm: 60, detourKm: 3, maxDetourKm: 8
  });
  assert.equal(result.canReachStation, false);
  assert.equal(result.feasible, false);
  assert.equal(result.amount, 0);
});

test("energy model charges at a reachable station and honours the requested arrival reserve", () => {
  const result = evaluateStationStop({
    energyType: "electric", soc: 5, minArrivalSoc: 80,
    firstLegKm: 8, totalDistanceKm: 55, detourKm: 2, maxDetourKm: 8
  });
  assert.equal(result.canReachStation, true);
  assert.equal(result.targetMet, true);
  assert.equal(result.feasible, true);
  assert.ok(result.amount > 70);
  assert.ok(result.arrivalSoc >= 80);
});

test("energy model rejects otherwise reachable stations that violate the detour cap", () => {
  const result = evaluateStationStop({
    energyType: "fuel", soc: 15, minArrivalSoc: 20,
    firstLegKm: 10, totalDistanceKm: 100, detourKm: 9, maxDetourKm: 5
  });
  assert.equal(result.canReachStation, true);
  assert.equal(result.detourWithinLimit, false);
  assert.equal(result.feasible, false);
});

test("long-trip planner generates a safe multi-stop EV sequence", () => {
  const result = buildLongTripPlans({
    distanceKm: 900,
    durationMinutes: 600,
    energyType: "electric",
    soc: 45,
    minArrivalSoc: 30,
    maxStops: 3,
    maxDetourKm: 8,
    stations: [
      { id: "s1", name: "第一补能站", progressKm: 230, detourKm: 1.4, p50: 5, p90: 12, price: 1.32 },
      { id: "s2", name: "第二补能站", progressKm: 470, detourKm: 1.8, p50: 7, p90: 14, price: 1.18 },
      { id: "s3", name: "第三补能站", progressKm: 710, detourKm: 1.6, p50: 4, p90: 10, price: 1.26 }
    ]
  });
  assert.ok(result.plans.length >= 1);
  assert.ok(result.plans.every((plan) => plan.arrivalSoc >= 20));
  assert.ok(result.plans.some((plan) => plan.stopCount >= 3));
  const longPlan = result.plans.find((plan) => plan.stopCount >= 3);
  assert.ok(longPlan.stops.every((stop) => stop.amount > 0 && stop.arrivalSoc >= 2));
});

test("long-trip planner exposes distinct fastest, reliable and cheapest objectives", () => {
  const result = buildLongTripPlans({
    distanceKm: 620,
    durationMinutes: 440,
    energyType: "electric",
    soc: 50,
    minArrivalSoc: 40,
    maxStops: 3,
    maxDetourKm: 8,
    stations: [
      // 快充站的 p90 原本是 28：那是按"各站 P90 直接相加"设计的数字，两站
      // 加起来 56 分钟足以盖过它 250kW 的充电优势。改成按独立性卷积之后，
      // 两站 28 只合成 41 分钟，快充方案在 P90 上反而胜出，这一档就不再存在
      // "快 vs 稳"的取舍了。把尾部风险提到 40 分钟，取舍才真实成立：
      // 快充方案 P50 早到 41 分钟，P90 晚到 12 分钟。
      { id: "fast-a", progressKm: 200, detourKm: 1, p50: 2, p90: 40, price: 1.9, estimatedChargePowerKw: 250 },
      { id: "safe-a", progressKm: 205, detourKm: 1, p50: 7, p90: 8, price: 1.6, estimatedChargePowerKw: 100 },
      { id: "cheap-a", progressKm: 210, detourKm: 1, p50: 10, p90: 12, price: 0.65, estimatedChargePowerKw: 75 },
      { id: "fast-b", progressKm: 420, detourKm: 1, p50: 2, p90: 40, price: 1.9, estimatedChargePowerKw: 250 },
      { id: "safe-b", progressKm: 425, detourKm: 1, p50: 7, p90: 8, price: 1.6, estimatedChargePowerKw: 100 },
      { id: "cheap-b", progressKm: 430, detourKm: 1, p50: 10, p90: 12, price: 0.65, estimatedChargePowerKw: 75 }
    ]
  });
  const { fastest, reliable, cheapest } = result.plansByObjective;
  assert.deepEqual(fastest.stops.map((stop) => stop.id), ["fast-a", "fast-b"]);
  assert.deepEqual(reliable.stops.map((stop) => stop.id), ["safe-a", "safe-b"]);
  assert.deepEqual(cheapest.stops.map((stop) => stop.id), ["cheap-a", "cheap-b"]);
  assert.ok(fastest.totalMinutesP50 < reliable.totalMinutesP50);
  assert.ok(reliable.totalMinutesP90 < fastest.totalMinutesP90);
  assert.ok(cheapest.energyCost < reliable.energyCost);
  // 两个同样 P90=40 的站点合成的总等待，必须明显小于 80——分位数不可加
  assert.ok(fastest.p90WaitMinutes < 70, `P90 waits were summed, not convolved: ${fastest.p90WaitMinutes}`);
  // 只停一次时必须退化为该站自己的 P90，不能因为换了算法就漂移
  const single = buildLongTripPlans({
    distanceKm: 300, durationMinutes: 210, energyType: "electric", soc: 40, minArrivalSoc: 20, maxStops: 1, maxDetourKm: 8,
    stations: [{ id: "only", progressKm: 150, detourKm: 1, p50: 9, p90: 31, price: 1.5, estimatedChargePowerKw: 120 }]
  });
  assert.equal(single.plansByObjective.fastest.p90WaitMinutes, 31);
});

test("long-trip planner keeps a short trip as a direct route", () => {
  const result = buildLongTripPlans({
    distanceKm: 80,
    durationMinutes: 70,
    energyType: "electric",
    soc: 80,
    minArrivalSoc: 20,
    maxStops: 3,
    stations: []
  });
  assert.equal(result.plans[0].stopCount, 0);
  assert.equal(result.plans[0].totalAmount, 0);
  assert.ok(result.plans[0].arrivalSoc >= 20);
});

test("long-trip planner accounts for every leg of a three-stop national EV trip", () => {
  const result = buildLongTripPlans({
    distanceKm: 900,
    durationMinutes: 600,
    energyType: "electric",
    soc: 45,
    minArrivalSoc: 30,
    maxStops: 3,
    maxDetourKm: 8,
    stations: [
      { id: "north-hebei", name: "冀北补能站", progressKm: 230, detourKm: 1.4, p50: 5, p90: 12, price: 1.32 },
      { id: "central-shandong", name: "鲁中补能站", progressKm: 470, detourKm: 1.8, p50: 7, p90: 14, price: 1.18 },
      { id: "south-jiangsu", name: "苏北补能站", progressKm: 710, detourKm: 1.6, p50: 4, p90: 10, price: 1.26 }
    ]
  });
  const threeStopPlan = result.plans.find((plan) => plan.stopCount === 3);

  assert.ok(threeStopPlan, "the corridor should require and return a three-stop option");
  assert.deepEqual(threeStopPlan.stops.map((stop) => stop.id), ["north-hebei", "central-shandong", "south-jiangsu"]);
  assert.equal(threeStopPlan.legs.length, 4, "three charging stops create four driving legs");
  assert.equal(threeStopPlan.legs.reduce((sum, distance) => sum + distance, 0), threeStopPlan.totalDistanceKm);
  assert.ok(threeStopPlan.stops.every((stop) => stop.arrivalSoc >= 2 && stop.targetSoc > stop.arrivalSoc));
  assert.ok(threeStopPlan.totalDetourKm <= 8);
  assert.ok(threeStopPlan.arrivalSoc >= threeStopPlan.targetArrivalSoc);
});

test("long-trip planner supports a six-stop national EV corridor", () => {
  const result = buildLongTripPlans({
    distanceKm: 2700,
    durationMinutes: 1715,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    maxStops: 6,
    maxDetourKm: 8,
    stations: [
      { id: "s1", name: "第一站", progressKm: 150, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s2", name: "第二站", progressKm: 600, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s3", name: "第三站", progressKm: 1050, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s4", name: "第四站", progressKm: 1500, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s5", name: "第五站", progressKm: 1950, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s6", name: "第六站", progressKm: 2400, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 }
    ]
  });
  const sixStopPlan = result.plans.find((plan) => plan.stopCount === 6);
  assert.ok(sixStopPlan, "the public planner should support six charging stops");
  assert.equal(sixStopPlan.legs.length, 7);
  assert.ok(sixStopPlan.arrivalSoc >= sixStopPlan.targetArrivalSoc);
});

test("long-trip planner supports multi-stop fuel routing under the same six-stop cap", () => {
  const result = buildLongTripPlans({
    distanceKm: 1200,
    durationMinutes: 780,
    energyType: "fuel",
    soc: 22,
    minArrivalSoc: 20,
    maxStops: 6,
    maxDetourKm: 18,
    stations: [
      { id: "fuel-1", name: "第一综合能源站", progressKm: 100, detourKm: 0.5, p50: 4, p90: 8, price: 7.4 },
      { id: "fuel-2", name: "第二综合能源站", progressKm: 500, detourKm: 0.5, p50: 4, p90: 8, price: 7.4 },
      { id: "fuel-3", name: "第三综合能源站", progressKm: 900, detourKm: 0.5, p50: 4, p90: 8, price: 7.4 }
    ]
  });
  const multiStopPlan = result.plans.find((plan) => plan.stopCount >= 3);
  assert.ok(multiStopPlan, "fuel mode should create a multi-stop route instead of reporting a false cap failure");
  assert.equal(multiStopPlan.unit, "L");
  assert.ok(multiStopPlan.arrivalSoc >= multiStopPlan.targetArrivalSoc);
});

test("long-trip planner returns an explicit no-solution result when a corridor needs more than six stops", () => {
  const result = buildLongTripPlans({
    distanceKm: 2300,
    durationMinutes: 1440,
    energyType: "electric",
    soc: 40,
    minArrivalSoc: 20,
    maxStops: 99,
    maxDetourKm: 8,
    stations: [
      { id: "s1", name: "第一站", progressKm: 150, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s2", name: "第二站", progressKm: 450, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s3", name: "第三站", progressKm: 750, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s4", name: "第四站", progressKm: 1050, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s5", name: "第五站", progressKm: 1350, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s6", name: "第六站", progressKm: 1650, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 },
      { id: "s7", name: "第七站", progressKm: 1950, detourKm: 0.5, p50: 4, p90: 8, price: 1.2 }
    ]
  });

  assert.equal(result.maxStops, 6, "the public planner must not silently exceed its six-stop cap");
  assert.deepEqual(result.plans, []);
  assert.equal(result.reason, "NO_FEASIBLE_SEQUENCE");
  assert.equal(result.candidatesConsidered, 7);
});

test("a hybrid is planned as two independent single-tank problems, not as a BEV with a tank", () => {
  assert.equal(isFuelEnergyType("hybridFuel"), true);
  assert.equal(isFuelEnergyType("hybridElectric"), false);
  const hybridElectric = getEnergyProfile("hybridElectric");
  const bev = getEnergyProfile("electric");
  // 插混的电池只有纯电车的四分之一左右。若沿用纯电 profile，首段安全里程会
  // 被高估约四倍，规划器就会把够不到的站点当成可达站点。
  assert.ok(hybridElectric.capacity < bev.capacity / 3);
  assert.equal(hybridElectric.unit, "kWh");
  assert.equal(getEnergyProfile("hybridFuel").unit, "L");
});

test("hybrid branches plan the same corridor on their own physics and refuelling units", () => {
  const corridor = {
    distanceKm: 300,
    durationMinutes: 210,
    minArrivalSoc: 20,
    maxStops: 6,
    maxDetourKm: 18,
    stations: [60, 120, 180, 240].map((progressKm, index) => ({
      id: `hybrid-${index + 1}`,
      name: `第${index + 1}综合能源站`,
      progressKm,
      detourKm: 0.5,
      p50: 4,
      p90: 8,
      price: 5
    }))
  };
  // 两侧起始电量/油量不同是常态。这里刻意让油箱也不足以直达，
  // 否则燃油分支停 0 次，补能速率的断言就变成空跑。
  const fuel = buildLongTripPlans({ ...corridor, energyType: "hybridFuel", soc: 12 });
  const electric = buildLongTripPlans({ ...corridor, energyType: "hybridElectric", soc: 60 });
  const fuelPlan = fuel.plans[0];
  const electricPlan = electric.plans[0];
  assert.ok(fuelPlan && electricPlan, "both hybrid branches must produce a feasible plan on this corridor");
  assert.equal(fuelPlan.unit, "L");
  assert.equal(electricPlan.unit, "kWh");
  // 20 kWh 的电池跑 900 km 必须比 50 L 的油箱停得更多，这正是油电对比的依据。
  assert.ok(electricPlan.stopCount > fuelPlan.stopCount);
  assert.ok(fuelPlan.arrivalSoc >= fuelPlan.targetArrivalSoc);
  assert.ok(electricPlan.arrivalSoc >= electricPlan.targetArrivalSoc);
  // 加油按 L/min，充电按 kW；两条分支不能共用同一个补能速率字段。
  fuelPlan.stops.forEach((stop) => {
    assert.equal(stop.estimatedChargePowerKw, null);
    assert.ok(Number(stop.estimatedRefuelRateLpm) > 0);
  });
  electricPlan.stops.forEach((stop) => {
    assert.equal(stop.estimatedRefuelRateLpm, null);
    assert.ok(Number(stop.estimatedChargePowerKw) > 0);
  });
});
