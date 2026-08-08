(function (root, factory) {
  const api = factory();
  if (root) root.FlowTwinServiceIntent = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";

  // These are service categories, not concrete user requests.  Keeping them
  // here prevents phrases such as “吃点东西” from being mistaken for a brand
  // named “东西”.
  const GENERIC_NAMES = new Set([
    "饭", "吃饭", "吃点", "吃点东西", "东西", "用餐", "餐饮", "餐厅", "餐馆",
    "咖啡", "咖啡店", "休息", "休息区", "卫生间", "洗车", "补能", "充电", "加油",
    "随便", "随便吃", "任意", "不限"
  ]);
  const SERVICE_SUFFIX = /(?:吃饭|用餐|餐厅就餐|喝咖啡|咖啡|休息|洗车|服务区|补能|充电|加油)$/;
  const KNOWN_BRANDS = /麦当劳|肯德基|星巴克|瑞幸|汉堡王|必胜客|海底捞|老乡鸡|德克士|喜茶|奈雪|全家|便利蜂/;

  function clean(value, max = 80) {
    return String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/^[\s“"'‘’]+|[\s”"'“’]+$/g, "")
      .trim()
      .slice(0, max);
  }

  function comparable(value) {
    return clean(value, 80).replace(/[\s()（）·'"“”‘’\-—_]/g, "").toLowerCase();
  }

  function isConcreteServiceName(value) {
    const text = clean(value);
    if (!text || GENERIC_NAMES.has(text)) return false;
    if (/^(?:吃|喝|去|找|到|在|想|要|安排|附近|路上|中途)/.test(text)) return false;
    return text.length >= 2;
  }

  function normalizeCandidate(value) {
    let text = clean(value, 60)
      .replace(/^(?:去|到|在|找|吃|喝|想去|想吃|想喝|要去|要吃|要喝)\s*/, "")
      .replace(/^(?:个|点|家|一份|一家)\s*/, "")
      .replace(SERVICE_SUFFIX, "")
      .trim();
    return isConcreteServiceName(text) ? text : null;
  }

  function extractServiceKeyword(value) {
    const text = clean(value, 120);
    if (!text) return null;

    // Prefer known brands so surrounding Chinese words never become part of
    // the POI query.  The original matched text is retained for display.
    const known = text.match(KNOWN_BRANDS)?.[0];
    if (known) return known;

    const beforeService = text.match(/(?:去|到|在|找)\s*([^，,。；;!?！？\s]{2,30}?)(?=(?:吃饭|用餐|餐厅就餐|喝咖啡|咖啡|休息|洗车))/);
    const fromPlace = normalizeCandidate(beforeService?.[1]);
    if (fromPlace) return fromPlace;

    const afterVerb = text.match(/(?:吃|喝)\s*(?:个|点|顿|杯|家|一份)?\s*([^，,。；;!?！？\s]{2,24})/);
    const fromVerb = normalizeCandidate(afterVerb?.[1]);
    if (fromVerb) return fromVerb;

    return null;
  }

  function matchesPoi(keyword, poi) {
    const requested = comparable(keyword);
    if (!requested) return true;
    const haystack = comparable(`${poi?.name || ""} ${poi?.address || ""}`);
    return Boolean(haystack && haystack.includes(requested));
  }

  // An explicit request is not allowed to silently fall through to the first
  // generic restaurant.  Alternatives can still be shown, but they require a
  // separate user click and therefore become an explicit choice.
  function chooseServiceCandidate(options, requestedName = "") {
    const list = Array.isArray(options) ? options.filter(Boolean) : [];
    const requested = clean(requestedName);
    if (!requested) return { candidate: list[0] || null, exact: list[0] || null, alternatives: [] };
    const exact = list.find((option) => matchesPoi(requested, option)) || null;
    return {
      candidate: exact,
      exact,
      alternatives: exact ? list.filter((option) => option !== exact) : list
    };
  }

  function serviceSearchType(type) {
    return new Set(["meal", "coffee", "rest"]).has(type) ? type : null;
  }

  return {
    clean,
    isConcreteServiceName,
    extractServiceKeyword,
    matchesPoi,
    chooseServiceCandidate,
    serviceSearchType
  };
});
