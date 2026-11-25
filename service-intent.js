(function (root, factory) {
  const api = factory();
  if (root) root.FlowTwinServiceIntent = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";

  // These are service categories, not concrete user requests. Keeping them
  // here prevents phrases such as “吃点东西” or “吃午饭” from being mistaken
  // for a brand name.
  const GENERIC_NAMES = new Set([
    "饭", "吃饭", "吃点", "吃点东西", "东西", "用餐", "餐饮", "餐厅", "餐馆",
    "早饭", "早餐", "午饭", "午餐", "晚饭", "晚餐", "夜宵", "快餐", "奶茶",
    "便利店", "服务区", "小吃", "简餐",
    "咖啡", "咖啡店", "休息", "休息区", "卫生间", "洗车", "补能", "充电", "加油",
    "随便", "随便吃", "任意", "不限"
  ]);
  const SERVICE_SUFFIX = /(?:吃饭|用餐|餐厅就餐|喝咖啡|咖啡店|咖啡|休息区|休息|洗车|服务区|补能|充电|加油)$/;
  const KNOWN_BRANDS_SOURCE = "麦当劳|肯德基|星巴克|瑞幸|汉堡王|必胜客|海底捞|老乡鸡|德克士|喜茶|奈雪|全家|便利蜂";
  const KNOWN_BRANDS_GLOBAL = new RegExp(KNOWN_BRANDS_SOURCE, "g");
  const PLACE_OR_CORRIDOR_RE = /(?:火车站|高铁站|地铁站|客运站|汽车站|南站|北站|东站|西站|站|机场|航站楼|高速|高速上|高速公路|国道|省道|服务区|收费站|西湖|东湖|南湖|北湖|太湖|公园|景区|风景区|广场|大道|大街|公路|大桥|隧道|路口|立交|环路|新区|市区|市中心|码头|港口|大学|医院|科技园|产业园|CBD)$/i;
  const CORRIDOR_EXACT_NAMES = new Set([
    "高速", "高速上", "高速公路", "服务区", "沿途", "沿线", "路上", "途中", "中途",
    "市区", "市中心", "城里", "城外", "附近", "周边", "前面", "前方", "出口", "入口"
  ]);
  const TRAILING_CLAUSE_SPLIT = /(?:顺便|然后|并且|另外|尽量|还要|以及|或者|不要|不想|不去|别去|别吃|别喝|再(?=[去找到在吃喝买来安排顺便])).*$/;
  const CLAUSE_SPLIT_RE = /[，,。；;!?！？]+|(?:顺便|然后|并且|另外|以及|或者|再(?=[去找到在吃喝买来安排]))/;
  const NEGATED_BRAND_RE = new RegExp(
    `(?:不想|不要|不去|别去|别吃|别喝|不吃|不喝|免去|避免|取消|移除|删掉)\\s*(?:去吃|去喝|去买|去|到|在|找|吃|喝|买|来)?\\s*(?:个|点|顿|杯|份|碗|家|一份)?\\s*(?:${KNOWN_BRANDS_SOURCE})(?:\\s*(?:和|与|及|跟|或|或者|以及|、|/)\\s*(?:去吃|去喝|去买|去|到|在|找|吃|喝|买|来)?\\s*(?:${KNOWN_BRANDS_SOURCE}))*`,
    "g"
  );
  const NEGATED_CLAUSE_RE = /(?:不想|不要|不去|别去|别吃|别喝|不吃|不喝|免去|避免|取消|移除|删掉)\s*(?:去吃|去喝|去买|去逛|去|到|在|找|吃|喝|买|来)?\s*(?:个|点|顿|杯|份|碗|家|一份)?\s*[^，,。；;!?！？\s]{1,18}?(?=(?:去(?:吃|喝|买|找)|(?:到|在|找)?(?:吃|喝|买)|顺便|然后|并且|另外|改|换|想|要|[，,。；;!?！？]|$))/g;
  const AFTER_VERB_GLOBAL = /(?:吃|喝)\s*(?:个|点|顿|杯|份|碗|盘|家|一份)?\s*([^，,。；;!?！？\s吃喝]{2,24}?)(?=(?:吃|喝|和|与|及|跟|顺便|然后|并且|另外|尽量|还要|以及|或者|不要|不想|不去|再(?=[去找到在吃喝买来安排])|[，,。；;!?！？\s]|$))/g;

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

  function isPlaceOrCorridorNoun(value, context = null) {
    const text = clean(value, 60);
    if (!text) return false;
    if (CORRIDOR_EXACT_NAMES.has(text)) return true;
    if (PLACE_OR_CORRIDOR_RE.test(text)) return true;
    if (context && typeof context === "object") {
      const target = comparable(text);
      if (target) {
        const originComp = comparable(context.origin);
        const destComp = comparable(context.destination);
        if ((originComp && (target === originComp || originComp.includes(target)))
          || (destComp && (target === destComp || destComp.includes(target)))) {
          return true;
        }
      }
    }
    return false;
  }

  function isConcreteServiceName(value) {
    const text = clean(value);
    if (!text || GENERIC_NAMES.has(text)) return false;
    if (CORRIDOR_EXACT_NAMES.has(text)) return false;
    if (/^(?:吃|喝|去|找|到|在|想|要|不|别|安排|附近|路上|中途|顺便|然后)/.test(text)) return false;
    return text.length >= 2;
  }

  function normalizeCandidate(value) {
    let text = clean(value, 60)
      .replace(TRAILING_CLAUSE_SPLIT, "")
      .replace(/^(?:先|再|去|到|在|找|吃|喝|想去|想吃|想喝|要去|要吃|要喝)\s*/, "")
      .replace(/^(?:个|点|顿|杯|份|碗|盘|家|一份|一家)\s*/, "")
      .replace(SERVICE_SUFFIX, "")
      .trim();
    return isConcreteServiceName(text) ? text : null;
  }

  function stripNegatedMentions(text) {
    return String(text || "")
      .replace(NEGATED_BRAND_RE, " ")
      .replace(NEGATED_CLAUSE_RE, " ");
  }

  function extractFromClause(clause, context = null) {
    const text = clean(clause, 120);
    if (!text) return [];

    const candidates = [];
    const pushCandidate = (keyword, index) => {
      if (!keyword) return;
      candidates.push({ keyword, index: Number.isFinite(index) ? index : text.length });
    };

    for (const match of text.matchAll(KNOWN_BRANDS_GLOBAL)) {
      pushCandidate(match[0], match.index);
    }

    const beforeService = text.match(/(?:去|到|在|找)\s*([^，,。；;!?！？\s]{2,30}?)(?=(?:吃饭|用餐|餐厅就餐|喝咖啡|咖啡店|咖啡|休息区|休息|洗车))/);
    const rawPlace = beforeService?.[1];
    if (rawPlace && !isPlaceOrCorridorNoun(rawPlace, context)) {
      const fromPlace = normalizeCandidate(rawPlace);
      if (fromPlace && !isPlaceOrCorridorNoun(fromPlace, context)) {
        pushCandidate(fromPlace, beforeService.index);
      }
    }

    for (const match of text.matchAll(AFTER_VERB_GLOBAL)) {
      const fromVerb = normalizeCandidate(match[1]);
      if (fromVerb && !isPlaceOrCorridorNoun(fromVerb, context)) {
        pushCandidate(fromVerb, match.index);
      }
    }

    candidates.sort((a, b) => a.index - b.index);
    const seen = new Set();
    const result = [];
    for (const item of candidates) {
      if (seen.has(item.keyword)) continue;
      seen.add(item.keyword);
      result.push(item.keyword);
    }
    return result;
  }

  function extractServiceKeywords(value, context = null) {
    const text = clean(value, 240);
    if (!text) return [];
    const positive = stripNegatedMentions(text);
    const clauses = positive.split(CLAUSE_SPLIT_RE).map((item) => item.trim()).filter(Boolean);
    const seen = new Set();
    const keywords = [];
    for (const clause of clauses) {
      for (const keyword of extractFromClause(clause, context)) {
        if (!seen.has(keyword)) {
          seen.add(keyword);
          keywords.push(keyword);
        }
      }
    }
    return keywords;
  }

  function extractServiceKeyword(value, context = null) {
    return extractServiceKeywords(value, context)[0] || null;
  }

  function matchesPoi(keyword, poi) {
    const requested = comparable(keyword);
    if (!requested) return true;
    const haystack = comparable(`${poi?.name || ""} ${poi?.address || ""}`);
    return Boolean(haystack && haystack.includes(requested));
  }

  // An explicit request is not allowed to silently fall through to the first
  // generic restaurant. Alternatives can still be shown, but they require a
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
    extractServiceKeywords,
    matchesPoi,
    chooseServiceCandidate,
    serviceSearchType
  };
});
