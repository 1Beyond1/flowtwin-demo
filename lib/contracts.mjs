export const API_CONTRACTS = {
  "/api/plan": {
    method: "POST",
    request: {
      message: "string，必填，1-1200 字符",
      context: "object，可选；可携带上一轮 parsed 字段"
    },
    response: {
      parsed: "object；origin,destination,departureTime,arrivalDeadline,soc,energyType,priority,maxDetourKm,services,clarificationNeeded,assistantReply,aiUsed,parser",
      originLocation: "[lng,lat] | null；默认能链北京总部或高德地理编码结果",
      destinationLocation: "[lng,lat] | null；高德地理编码结果",
      locationSources: "object；起终点坐标来源"
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
      targetUser: "string，最多 64 字符"
    },
    response: {
      before: "object；totalDemand,averageWait,p90Wait,averageOccupancy,occupancyDispersion,peakQueue",
      after: "object；同 before",
      stations: "array；保留 id,name,type,location,address 等前端字段，并增加需求/等待变化",
      impact: "object；divertedVehicles,incrementalOrders,acceptedOrders,discountCost,incrementalGrossProfit,roi,switchRate",
      assumptions: "object；仿真假设与优惠响应参数"
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
  }
};

