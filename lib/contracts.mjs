export const API_CONTRACTS = {
  "/api/health": {
    method: "GET",
    response: {
      ok: "boolean",
      service: "string",
      dependencies: "object；amapConfigured, ai, feishu, cv, enterprisePrior 配置与运行态摘要",
      amapCache: "object | null；本地 AMap 磁盘缓存统计",
      longTripPlanCache: "object；长途方案内存缓存统计"
    }
  },
  "/api/contracts": {
    method: "GET",
    response: {
      contracts: "object；返回当前服务端所有公开 HTTP API 的契约描述"
    }
  },
  "/api/version": {
    method: "GET",
    response: {
      version: "string；package.json 版本号",
      commit: "string | null；构建提交哈希",
      repo: "string；默认或 FLOWTWIN_REPO 覆盖的 GitHub 仓库",
      buildTime: "string | null；构建时间"
    }
  },
  "/api/version/check": {
    method: "GET",
    response: {
      checked: "boolean",
      status: "up-to-date | update-available | unavailable",
      updateAvailable: "boolean | null",
      remoteVersion: "string | null",
      remoteCommit: "string | null",
      cached: "boolean"
    }
  },
  "/api/plan": {
    method: "POST",
    request: {
      message: "string，必填，1-1200 字符",
      context: "object，可选；可携带上一轮 parsed 字段，也可传入 originLocation（用户明确授权后的浏览器定位坐标）"
    },
    response: {
      analysis: "object；mode=rules|hybrid|rules-fallback，score=0-100，level=high|medium|confirm，factors={id,label,status,delta,evidence}[]，ai={configured,attempted,used,fallback,reason}",
      parsed: "object；origin,destination,arrivalDeadline,minArrivalSoc,energyType,priority,maxDetourKm,services,actions,requestMode,clarificationNeeded,assistantReply,aiUsed,parser",
      mapConfigured: "boolean；服务端是否已配置高德 Web 服务密钥",
      originLocation: "[lng,lat] | null；默认起点（北京国贸 CBD）、用户浏览器定位、高德地理编码/地点检索或离线坐标库结果",
      destinationLocation: "[lng,lat] | null；高德地理编码/地点检索或离线坐标库结果",
      destinationSource: "\"amap\" | \"offline-gazetteer\" | null；目的地坐标来源类型",
      locationSources: "object；起终点坐标来源文案",
      locationMeta: "object；起终点规范名称、城市与行政区",
      destinationCandidates: "array；歧义或不完全吻合时最多 3 个候选 {name,coordinate,city,score,source,address}，多数请求为空数组",
      destinationNeedsPick: "boolean；true 时前端应展示候选列表，destinationLocation 为 null",
      destinationResolution: "rule | ai-fallback | unresolved"
    }
  },
  "/api/route": {
    method: "GET",
    request: {
      origin: "string，必填；经度,纬度",
      destination: "string，必填；经度,纬度",
      waypoint: "string，可选；单个途经点坐标",
      waypoints: "string，可选；分号分隔的最多 16 个途经点坐标",
      plan: "fastest | reliable | cheapest，默认 reliable",
      cartype: "0（燃油）| 1（纯电）| 2（插混/混动），默认 1"
    },
    response: {
      route: "object；path, distance(km), duration(min), tolls, highway, roadNames, policy, source",
      alternatives: "number",
      source: "string",
      cache: "object；state=hit|miss|stale|bypass"
    }
  },
  "/api/poi": {
    method: "GET",
    request: {
      location: "string，必填；经度,纬度",
      type: "fuel | electric | service | meal | coffee | rest，默认 electric",
      keyword: "string，可选；仅用于餐饮/咖啡/休息类服务检索"
    },
    response: {
      pois: "array；{id,name,address,location,tel,distance}",
      source: "string",
      kind: "string",
      cache: "object"
    }
  },
  "/api/weather": {
    method: "GET",
    request: {
      location: "string，必填；经度,纬度"
    },
    response: {
      adcode: "string",
      city: "string | null",
      condition: "string",
      temperature: "number | null",
      weatherFactor: "number；恶劣天气排队放大因子",
      severe: "boolean",
      source: "string",
      cache: "object"
    }
  },
  "/api/stt": {
    method: "POST",
    request: {
      body: "audio/* 原始二进制，或 multipart/form-data 的 file/audio 字段；服务端转发至语音识别，密钥不回传浏览器"
    },
    response: {
      text: "string；清理后的识别文本（已去情感/语言标签，可选 AI 润色）",
      rawText: "string，可选；上游原始转写（含标签时才会返回）",
      error: "STT_NOT_CONFIGURED | AUDIO_BODY_REQUIRED | AUDIO_FILE_REQUIRED | STT_EMPTY_AUDIO | STT_UPSTREAM_ERROR | STT_RATE_LIMITED | STT_EMPTY_TRANSCRIPT"
    }
  },
  "/api/forecast": {
    method: "POST",
    request: {
      stations: "station[]，最多 60 个；兼容 id,name,type,location,occupancy,wait,p50,p90,price,detour 及可选端口级字段",
      scenario: "object，可选；departureMinutes, demandFactor(0.5-2), trafficFactor(0.7-1.5), weatherFactor(0.8-1.5), horizonMinutes(5-240，默认 30), intervalMinutes(1-60，默认 5), arrivalOffsetMinutes, arrivalOffsets"
    },
    response: {
      horizonMinutes: "number，默认 30（可配置 5-240）",
      intervalMinutes: "number，默认 5（可配置 1-60）",
      method: "port-discrete-event | aggregate-flow-simulation",
      stations: "array；每站包含 baseline 与 forecast 时间序列，点含 occupancy,wait,p50,p90,arrivalRate,serviceRate,risk,confidence；wait/p50/p90 均指排队，不含补能服务",
      model: "string；可解释预测口径；路线 ETA 另行叠加补能服务时长和支付驶离缓冲",
      source: "simulation | enterprise-prior+simulation；企业先验只表示城市×油电类型×小时离线需求，不代表具体 POI 实时经营数据",
      confidence: "simulation-only | enterprise-prior+simulation",
      enterprisePrior: "object|null；匹配城市、能源类型、需求倍率、匹配距离、模型版本和置信度依据"
    }
  },
  "/api/longtrip": {
    method: "POST",
    request: {
      stations: "station[]，必填；普通模式最多 40 个，adaptiveMaxStops=true 时最多 72 个",
      distanceKm: "number，必填，0-6000",
      durationMinutes: "number，可选",
      energyType: "electric | fuel | hybridElectric | hybridFuel",
      soc: "number，0-100",
      minArrivalSoc: "number，0-100",
      maxStops: "number；普通上限 6，adaptiveMaxStops=true 上限 12",
      adaptiveMaxStops: "boolean，可选",
      maxDetourKm: "number，可选",
      departureMinutes: "number | HH:MM，可选",
      deadlineOffsetMinutes: "number，可选",
      useForecast: "boolean，可选"
    },
    response: {
      plans: "array；按 fastest / reliable / cheapest 选出的可行方案",
      plansByObjective: "object；{fastest, reliable, cheapest}",
      paretoPlans: "array；非支配 Pareto 前沿方案",
      reason: "string | null；无可行方案时说明原因",
      cache: "object；state=hit|miss"
    }
  },
  "/api/operator/simulate": {
    method: "POST",
    request: {
      stations: "station[]；兼容当前前端 station 对象",
      discountAmount: "number，0-100；也兼容 discount",
      targetStationId: "string；也兼容 targetStation 字符串或对象",
      targetUser: "string，最多 64 字符；人群的中文标签，仅在没有 targetSegment 时用关键词匹配",
      targetSegment: "string，可选；固定人群 id（price-sensitive/time-sensitive/low-soc/all），优先于 targetUser 的文本匹配"
    },
    response: {
      before: "object；totalDemand,averageWait,p90Wait(需求加权 90 分位站点排队),averageOccupancy,occupancyDispersion,peakQueue",
      after: "object；同 before",
      stations: "array；保留 id,name,type,location,address 等前端字段，并增加需求/排队变化",
      impact: "object；divertedVehicles,incrementalOrders,retainedOrders(挽回的流失需求),newVolumeGrossProfit,retainedGrossProfit,acceptedOrders,discountCost,incrementalGrossProfit,roi,switchRate",
      recommendedDiscount: "number 或 null；ROI≥1 的档位中分流量最大者，无盈利档位时为 null",
      recommendedBasis: "object；diverted,roi,meetsDesiredDiversion,rule——推荐值的依据，null 推荐时说明原因",
      desiredDiversion: "number；按拥堵侧压力算出的期望分流量",
      diversionCeiling: "number；承接站空余容量决定的分流物理上限",
      capacityBound: "boolean；true 表示期望分流量已超过承接站容量，加大优惠也无法缓解",
      unservedPressure: "number；capacityBound 时无处承接的压力人数",
      assumptions: "object；仿真假设、人群响应参数（userSegment/userSegmentMatched）与 ROI/排队/P90 口径说明"
    }
  },
  "/api/validate": {
    method: "POST",
    request: {
      stations: "station[]，可选；直接传当前前端 state.stations 作为样本基线",
      seed: "number，可选；默认 20260719",
      trips: "number，可选；最少 1000，最多 10000"
    },
    response: {
      trips: "number；实际仿真次数",
      inputMode: "current-stations | synthetic-stations",
      strategies: "object；nearest,cheapest,realtime,flowtwin 四策略指标；每项含 averageWait/p90Wait（排队）以及 averageStopMinutes/p90StopMinutes（完整补能停靠）",
      metricDefinitions: "object；各指标定义",
      assumptions: "string；数据边界"
    }
  },
  "/api/cv/health": {
    method: "GET",
    response: {
      configured: "boolean",
      serviceReachable: "boolean | null",
      runtimeAvailable: "boolean | null",
      modelLoaded: "boolean | null",
      inferenceReady: "boolean | null",
      status: "not-configured | unreachable | runtime-unavailable | warming | ready"
    }
  },
  "/api/cv/analyze": {
    method: "POST",
    request: {
      mode: "upload | video | sample（均会归一化为小写去空白）",
      imageData: "string，data:image/*;base64,...（upload/sample）",
      videoData: "string，data:video/*;base64,...（video）"
    },
    response: {
      ok: "boolean",
      mode: "string",
      inferenceStatus: "executed | synthetic | not-run | error",
      arrivalRecognition: "object；status, plate, confidence",
      paymentReceipt: "object；status, message",
      dataBoundary: "string"
    }
  },
  "/api/execution": {
    method: "POST",
    request: {
      runId: "string，可选；也兼容 executionId / idempotencyKey，用于幂等去重（含并发在途请求）",
      targetStation: "string",
      discountAmount: "number",
      targetUser: "string",
      divertedVehicles: "number",
      roi: "number"
    },
    response: {
      used: "boolean",
      mode: "feishu-webhook | local-demo | error",
      idempotent: "boolean，可选；命中缓存或并发在途去重时为 true",
      message: "string"
    }
  },
  "/api/feishu/sync": {
    method: "POST",
    request: {
      runId: "string，可选；同一运行批次重复提交会幂等复用",
      stations: "station[]；当前运营快照，最多 40 个",
      strategy: "object；/api/operator/simulate 返回的策略结果",
      source: "string，可选；默认 FlowTwin 演示仿真",
      dataAsOf: "string，可选；数据时点"
    },
    response: {
      status: "syncing | processing | not-configured | error",
      syncId: "string；后续用于查询 AI 结果",
      runId: "string",
      source: "string；当前演示明确标记为仿真数据"
    }
  },
  "/api/feishu/sync/:syncId": {
    method: "GET",
    response: {
      status: "syncing | processing | completed | error",
      aiStatus: "processing | completed | error",
      aiResult: "string | null；来自配置的飞书 AI 字段",
      source: "string"
    }
  },
  "/api/feishu/strategy/:strategyRecordId/approve": {
    method: "POST",
    request: {
      status: "待确认 | 已确认 | 已执行 | 已拒绝 | 已驳回 | 已取消，默认 已确认"
    },
    response: {
      used: "boolean",
      mode: "feishu-bitable | local-demo | error",
      status: "string",
      message: "string"
    }
  },
  "/api/feishu/health": {
    method: "GET",
    response: {
      configured: "boolean",
      appConfigured: "boolean",
      bitableConfigured: "boolean",
      snapshotTableConfigured: "boolean",
      strategyTableConfigured: "boolean",
      syncTableConfigured: "boolean",
      publicWriteEnabled: "boolean"
    }
  }
};
