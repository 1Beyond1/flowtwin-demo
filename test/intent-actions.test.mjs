import test from "node:test";
import assert from "node:assert/strict";
import { formatPlanResponse, INTENT_ACTION_TYPES, parseTripIntent } from "../lib/plan.mjs";

const currentTrip = {
  hasPlannedRoute: true,
  currentOrigin: "能链北京总部",
  currentDestination: "上海东方明珠广播电视塔",
  currentServices: ["餐饮"]
};

async function parseLocal(message, context = {}) {
  return parseTripIntent({
    message,
    context,
    config: {},
    fetchImpl: async () => { throw new Error("local test should not call a provider"); }
  });
}

function aiResponse(parsed) {
  return async (url) => {
    if (!url.includes("chat/completions")) return new Response(JSON.stringify({ status: "0", geocodes: [] }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(parsed) } }] }), { status: 200 });
  };
}

function aiResponseWithPlace(parsed, place = "南京大学") {
  return async (url) => {
    if (url.includes("chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(parsed) } }] }), { status: 200 });
    }
    if (url.includes("/v3/geocode/geo")) {
      return new Response(JSON.stringify({
        status: "1",
        geocodes: [{ formatted_address: place, location: "118.78,32.06", city: "南京市", district: "鼓楼区" }]
      }), { status: 200 });
    }
    if (url.includes("/v3/place/text")) {
      return new Response(JSON.stringify({
        status: "1",
        pois: [{ name: place, location: "118.78,32.06", cityname: "南京市", adname: "鼓楼区", type: "教育" }]
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "0" }), { status: 200 });
  };
}

async function parseWithAi(message, context, parsed) {
  return parseTripIntent({
    message,
    context,
    config: { aiBaseUrl: "https://example.invalid/v1", aiApiKey: "placeholder", aiModel: "model" },
    fetchImpl: aiResponse(parsed)
  });
}

test("new trips emit NEW_TRIP and do not inherit a stale destination", async () => {
  const result = await parseLocal("从北京去南京");
  assert.equal(result.requestMode, "new_trip");
  assert.equal(result.destination, "南京");
  assert.deepEqual(result.actions, [{ type: "NEW_TRIP", origin: "北京", destination: "南京" }]);
});

test("speech punctuation between a destination cue and place name is tolerated", async () => {
  const result = await parseLocal("我想去。南京大学。");
  assert.equal(result.requestMode, "new_trip");
  assert.equal(result.destination, "南京大学");
  assert.deepEqual(result.actions, [{ type: "NEW_TRIP", destination: "南京大学" }]);
});

test("AI rechecks when the local rule cannot extract a destination", async () => {
  const result = await parseTripIntent({
    message: "导航到那里",
    context: {},
    config: {
      aiBaseUrl: "https://example.invalid/v1",
      aiApiKey: "placeholder",
      aiModel: "model",
      webServiceKey: "placeholder"
    },
    fetchImpl: aiResponseWithPlace({
      destination: "南京大学",
      requestMode: "new_trip",
      actions: [{ type: "NEW_TRIP", destination: "南京大学" }],
      clarificationNeeded: false
    })
  });
  assert.equal(result.destination, "南京大学");
  assert.equal(result.destinationResolution, "ai-fallback");
  assert.deepEqual(result.actions, [{ type: "NEW_TRIP", destination: "南京大学" }]);
  assert.deepEqual(result.locations.destination.coordinate, [118.78, 32.06]);
});

test("unresolved local and AI destination stays unresolved", async () => {
  const result = await parseWithAi("我想去那个地方", {}, {
    destination: null,
    requestMode: "new_trip",
    actions: [],
    clarificationNeeded: true
  });
  assert.equal(result.destination, null);
  assert.equal(result.destinationResolution, "unresolved");
  assert.equal(formatPlanResponse(result).destinationResolution, "unresolved");
});

test("supplement actions preserve concrete service names and waypoint locations", async () => {
  const service = await parseLocal("中途想去吃麦当劳", currentTrip);
  assert.equal(service.requestMode, "supplement");
  assert.equal(service.destination, currentTrip.currentDestination);
  assert.deepEqual(service.actions, [{ type: "ADD_SERVICE", service: "餐饮", name: "麦当劳" }]);

  const waypoint = await parseLocal("途经天津", currentTrip);
  assert.equal(waypoint.requestMode, "supplement");
  assert.deepEqual(waypoint.actions, [{ type: "ADD_WAYPOINT", location: "天津" }]);
});

test("generic meal follow-ups keep the service category without inventing a venue name", async () => {
  const result = await parseLocal("中途想吃点东西", currentTrip);
  assert.equal(result.requestMode, "supplement");
  assert.deepEqual(result.actions, [{ type: "ADD_SERVICE", service: "餐饮" }]);
});

test("AI category output is enriched with the concrete keyword from the user text", async () => {
  const result = await parseWithAi("中途想喝星巴克", currentTrip, {
    destination: currentTrip.currentDestination,
    services: ["餐饮"],
    requestMode: "supplement",
    actions: [{ type: "ADD_SERVICE", service: "餐饮", name: "餐厅" }],
    clarificationNeeded: false
  });
  assert.deepEqual(result.actions, [{ type: "ADD_SERVICE", service: "餐饮", name: "星巴克" }]);
});

test("destination changes, stop removals, and constraint updates have stable action types", async () => {
  const changed = await parseLocal("把目的地改成杭州", currentTrip);
  assert.equal(changed.requestMode, "new_trip");
  assert.deepEqual(changed.actions, [{ type: "CHANGE_DESTINATION", destination: "杭州" }]);

  const removed = await parseLocal("取消餐饮", currentTrip);
  assert.equal(removed.requestMode, "supplement");
  assert.deepEqual(removed.services, []);
  assert.deepEqual(removed.actions, [{ type: "REMOVE_STOP", target: "餐饮" }]);

  const updated = await parseLocal("改成最晚23:00到", currentTrip);
  assert.equal(updated.requestMode, "supplement");
  assert.equal(updated.arrivalDeadline, "23:00");
  assert.deepEqual(updated.actions, [{
    type: "UPDATE_CONSTRAINT",
    constraint: "arrivalDeadline",
    value: "23:00"
  }]);

  const restarted = await parseLocal("重新去南京", currentTrip);
  assert.equal(restarted.requestMode, "new_trip");
  assert.deepEqual(restarted.actions, [{ type: "NEW_TRIP", destination: "南京" }]);
});

test("pronouns and unresolved locations safely degrade to no action", async () => {
  const existing = await parseLocal("去那里", currentTrip);
  assert.equal(existing.destination, currentTrip.currentDestination);
  assert.equal(existing.requestMode, "supplement");
  assert.deepEqual(existing.actions, []);

  const waypoint = await parseLocal("途经那里", currentTrip);
  assert.deepEqual(waypoint.actions, []);

  const newTrip = await parseLocal("去那里");
  assert.equal(newTrip.destination, null);
  assert.equal(newTrip.clarificationNeeded, true);
  assert.deepEqual(newTrip.actions, []);
});

test("AI actions are accepted only when local text evidence supports them", async () => {
  const result = await parseWithAi("中途想去吃麦当劳", currentTrip, {
    destination: "巴黎",
    arrivalDeadline: "08:00",
    minArrivalSoc: 80,
    energyType: "fuel",
    priority: "on_time",
    maxDetourKm: 99,
    services: ["餐饮"],
    requestMode: "new_trip",
    actions: [
      { type: "ADD_SERVICE", service: "餐饮", name: "餐厅" },
      { type: "UPDATE_CONSTRAINT", constraint: "arrivalDeadline", value: "08:00" },
      { type: "CHANGE_DESTINATION", destination: "巴黎" }
    ],
    clarificationNeeded: false
  });

  assert.equal(result.destination, currentTrip.currentDestination);
  assert.equal(result.requestMode, "supplement");
  assert.equal(result.arrivalDeadline, null);
  assert.equal(result.minArrivalSoc, null);
  assert.equal(result.maxDetourKm, null);
  assert.equal(result.energyType, "unknown");
  assert.equal(result.priority, "balanced");
  assert.deepEqual(result.actions, [{ type: "ADD_SERVICE", service: "餐饮", name: "麦当劳" }]);
});

test("a model cannot invent a hard constraint when the user did not state one", async () => {
  const result = await parseWithAi("帮我安排一下", currentTrip, {
    destination: currentTrip.currentDestination,
    arrivalDeadline: "23:00",
    minArrivalSoc: 50,
    actions: [{ type: "UPDATE_CONSTRAINT", constraint: "arrivalDeadline", value: "23:00" }],
    requestMode: "supplement",
    clarificationNeeded: false
  });
  assert.equal(result.arrivalDeadline, null);
  assert.equal(result.minArrivalSoc, null);
  assert.deepEqual(result.actions, []);
});

test("parsed remains backward compatible with an always-present actions array", () => {
  assert.deepEqual(formatPlanResponse({ destination: "南京", assistantReply: "ok" }).parsed.actions, []);
  assert.deepEqual(INTENT_ACTION_TYPES, [
    "ADD_SERVICE",
    "ADD_WAYPOINT",
    "REMOVE_STOP",
    "CHANGE_DESTINATION",
    "UPDATE_CONSTRAINT",
    "NEW_TRIP"
  ]);
});
