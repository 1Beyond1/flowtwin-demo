export const API_CONTRACTS = {
  "/api/plan": {
    method: "POST",
    request: {
      message: "string，必填，1-1200 字符",
      context: "object，可选；可携带上一轮 parsed 字段"
    },
    response: {
      analysis: "object；mode=local|ai|local-fallback，score=0-100，level=high|medium|low，factors={id,label,status,delta,evidence}[]，ai={requested,used,fallback}",
      parsed: "object；origin,destination,departureTime,arrivalDeadline,soc,energyType,priority,maxDetourKm,services,clarificationNeeded,assistantReply,aiUsed,parser",
      originLocation: "[lng,lat] | null；默认能链北京总部或高德地理编码/地点检索结果",
      destinationLocation: "[lng,lat] | null；高德地理编码或地点检索结果",
      locationSources: "object；起终点坐标来源",
      destinationCandidates: "array；歧义或不完全吻合时最多 3 个候选 {name,coordinate,city,score,source,address}，多数请求为空数组",
      destinationNeedsPick: "boolean；true 时前端应展示候选列表，destinationLocation 为 null"
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
      stations: "station[]；兼容当前前端 id,name,type,location,occupancy,wait,p50,p90,price,detour",
      scenario: "object，可选；demandFactor,trafficFactor"
    },
    response: {
      horizonMinutes: "number，固定 30",
      intervalMinutes: "number，固定 5",
      stations: "array；每站包含 baseline 与 forecast[0,5,...,30]，点含 occupancy,wait,p50,p90,arrivalRate,serviceRate,risk",
      model: "string；可解释预测口径"
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
      before: "object；totalDemand,averageWait,p90Wait(需求加权 90 分位站点等待),averageOccupancy,occupancyDispersion,peakQueue",
      after: "object；同 before",
      stations: "array；保留 id,name,type,location,address 等前端字段，并增加需求/等待变化",
      impact: "object；divertedVehicles,incrementalOrders,retainedOrders(挽回的流失需求),newVolumeGrossProfit,retainedGrossProfit,acceptedOrders,discountCost,incrementalGrossProfit,roi,switchRate",
      recommendedDiscount: "number 或 null；ROI≥1 的档位中分流量最大者，无盈利档位时为 null",
      recommendedBasis: "object；diverted,roi,meetsDesiredDiversion,rule——推荐值的依据，null 推荐时说明原因",
      desiredDiversion: "number；按拥堵侧压力算出的期望分流量",
      diversionCeiling: "number；承接站空余容量决定的分流物理上限",
      capacityBound: "boolean；true 表示期望分流量已超过承接站容量，加大优惠也无法缓解",
      unservedPressure: "number；capacityBound 时无处承接的压力人数",
      assumptions: "object；仿真假设、人群响应参数（userSegment/userSegmentMatched）与 ROI/等待/P90 口径说明"
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
      strategies: "object；nearest,cheapest,realtime,flowtwin 四策略指标",
      metricDefinitions: "object；各指标定义",
      assumptions: "string；数据边界"
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
      status: "processing | completed | error",
      aiStatus: "processing | completed | error",
      aiResult: "string | null；来自配置的飞书 AI 字段",
      source: "string"
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
      syncTableConfigured: "boolean"
    }
  }
};
