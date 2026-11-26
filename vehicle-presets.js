(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.FlowTwinVehiclePresets = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";

  const VALID_PRESET_ENERGY_TYPES = new Set(["electric", "fuel", "hybrid"]);

  // Built-in vehicle presets. The three defaults (ev-standard, fuel-sedan,
  // hybrid-commuter) match lib/energy.mjs and app.js ENERGY_PROFILES to the
  // exact decimal so default trip math stays 100% backward compatible.
  const BUILTIN_VEHICLE_PRESETS = Object.freeze([
    Object.freeze({
      id: "ev-standard",
      name: "标准长续航纯电",
      energyType: "electric",
      builtin: true,
      capacity: 108,
      consumptionPerKm: 0.18,
      consumptionPer100Km: 18,
      peakPowerKw: 180,
      transferEfficiency: 0.92,
      safetyReservePercent: 2,
      unit: "kWh",
      nominalFullRangeKm: 600
    }),
    Object.freeze({
      id: "ev-800v-fast",
      name: "800V 超充轿跑",
      energyType: "electric",
      builtin: true,
      capacity: 100,
      consumptionPerKm: 0.162,
      consumptionPer100Km: 16.2,
      peakPowerKw: 320,
      transferEfficiency: 0.92,
      safetyReservePercent: 2,
      unit: "kWh",
      nominalFullRangeKm: 617
    }),
    Object.freeze({
      id: "ev-urban-compact",
      name: "城市紧凑纯电",
      energyType: "electric",
      builtin: true,
      capacity: 60,
      consumptionPerKm: 0.138,
      consumptionPer100Km: 13.8,
      peakPowerKw: 95,
      transferEfficiency: 0.92,
      safetyReservePercent: 2,
      unit: "kWh",
      nominalFullRangeKm: 435
    }),
    Object.freeze({
      id: "ev-long-suv",
      name: "大电池纯电 SUV",
      energyType: "electric",
      builtin: true,
      capacity: 116,
      consumptionPerKm: 0.215,
      consumptionPer100Km: 21.5,
      peakPowerKw: 220,
      transferEfficiency: 0.92,
      safetyReservePercent: 2,
      unit: "kWh",
      nominalFullRangeKm: 540
    }),
    Object.freeze({
      id: "fuel-sedan",
      name: "标准燃油轿车",
      energyType: "fuel",
      builtin: true,
      capacity: 55,
      consumptionPerKm: 0.075,
      consumptionPer100Km: 7.5,
      peakPowerKw: null,
      transferEfficiency: 0.95,
      safetyReservePercent: 3,
      unit: "L",
      nominalFullRangeKm: 733
    }),
    Object.freeze({
      id: "fuel-suv",
      name: "中大型燃油 SUV",
      energyType: "fuel",
      builtin: true,
      capacity: 68,
      consumptionPerKm: 0.096,
      consumptionPer100Km: 9.6,
      peakPowerKw: null,
      transferEfficiency: 0.95,
      safetyReservePercent: 3,
      unit: "L",
      nominalFullRangeKm: 708
    }),
    Object.freeze({
      id: "hybrid-commuter",
      name: "插电混动通勤版",
      energyType: "hybrid",
      builtin: true,
      capacity: 20,
      consumptionPerKm: 0.165,
      consumptionPer100Km: 16.5,
      peakPowerKw: 60,
      transferEfficiency: 0.92,
      safetyReservePercent: 2,
      unit: "kWh",
      nominalFullRangeKm: 121,
      fuelCapacity: 60,
      fuelConsumptionPerKm: 0.056,
      fuelConsumptionPer100Km: 5.6,
      fuelTransferEfficiency: 0.95,
      fuelSafetyReservePercent: 3,
      fuelUnit: "L",
      fuelNominalFullRangeKm: 1071,
      combinedFullRangeKm: 1192
    }),
    Object.freeze({
      id: "hybrid-erev-suv",
      name: "增程混动 SUV",
      energyType: "hybrid",
      builtin: true,
      capacity: 42,
      consumptionPerKm: 0.192,
      consumptionPer100Km: 19.2,
      peakPowerKw: 120,
      transferEfficiency: 0.92,
      safetyReservePercent: 2,
      unit: "kWh",
      nominalFullRangeKm: 219,
      fuelCapacity: 65,
      fuelConsumptionPerKm: 0.068,
      fuelConsumptionPer100Km: 6.8,
      fuelTransferEfficiency: 0.95,
      fuelSafetyReservePercent: 3,
      fuelUnit: "L",
      fuelNominalFullRangeKm: 956,
      combinedFullRangeKm: 1175
    })
  ]);

  const BUILTIN_IDS = new Set(BUILTIN_VEHICLE_PRESETS.map((item) => item.id));

  const DEFAULT_PRESET_BY_ENERGY = Object.freeze({
    electric: "ev-standard",
    fuel: "fuel-sedan",
    hybrid: "hybrid-commuter",
    hybridElectric: "hybrid-commuter",
    hybridFuel: "hybrid-commuter"
  });

  function parseFinite(value) {
    if (value === null || value === undefined || typeof value === "boolean" || typeof value === "object") return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function cleanName(value, maxLen) {
    return String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, maxLen);
  }

  function normalizeEnergyGroup(energyType) {
    if (energyType === "hybridElectric" || energyType === "hybridFuel" || energyType === "hybrid") return "hybrid";
    if (energyType === "fuel") return "fuel";
    if (energyType === "electric") return "electric";
    return null;
  }

  function isFuelEnergyType(energyType) {
    return energyType === "fuel" || energyType === "hybridFuel";
  }

  function getPresetById(id, customPresets = []) {
    const key = String(id ?? "").trim();
    if (!key) return null;
    const builtin = BUILTIN_VEHICLE_PRESETS.find((item) => item.id === key);
    if (builtin) return builtin;
    if (Array.isArray(customPresets)) {
      const found = customPresets.find((item) => item && typeof item === "object" && String(item.id || "") === key);
      if (found) return found;
    }
    return null;
  }

  function getPresetsForEnergyType(energyType, customPresets = []) {
    const group = normalizeEnergyGroup(energyType);
    const customList = Array.isArray(customPresets)
      ? customPresets.filter((item) => item && typeof item === "object" && VALID_PRESET_ENERGY_TYPES.has(item.energyType))
      : [];
    const combined = [...BUILTIN_VEHICLE_PRESETS, ...customList];
    if (!group) return combined;
    return combined.filter((item) => item.energyType === group);
  }

  function sanitizeCustomPreset(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const name = cleanName(raw.name, 40);
    if (!name) return null;

    const energyType = String(raw.energyType || "").trim();
    if (!VALID_PRESET_ENERGY_TYPES.has(energyType)) return null;

    const capacity = parseFinite(raw.capacity);
    if (capacity === null || capacity < 10 || capacity > 200) return null;

    let consumptionPerKm = null;
    let consumptionPer100Km = null;
    const hasPer100 = raw.consumptionPer100Km !== undefined && raw.consumptionPer100Km !== null && raw.consumptionPer100Km !== "";
    const hasPerKm = raw.consumptionPerKm !== undefined && raw.consumptionPerKm !== null && raw.consumptionPerKm !== "";
    if (hasPer100) {
      const per100 = parseFinite(raw.consumptionPer100Km);
      if (per100 === null || per100 < 3 || per100 > 40) return null;
      consumptionPer100Km = Number(per100.toFixed(2));
      consumptionPerKm = Number((per100 / 100).toFixed(4));
    } else if (hasPerKm) {
      const perKm = parseFinite(raw.consumptionPerKm);
      if (perKm === null || perKm < 0.03 || perKm > 0.4) return null;
      consumptionPerKm = Number(perKm.toFixed(4));
      consumptionPer100Km = Number((perKm * 100).toFixed(2));
    } else {
      return null;
    }

    let peakPowerKw = null;
    if (energyType === "electric" || energyType === "hybrid") {
      if (raw.peakPowerKw !== undefined && raw.peakPowerKw !== null && raw.peakPowerKw !== "") {
        const power = parseFinite(raw.peakPowerKw);
        if (power === null || power < 30 || power > 600) return null;
        peakPowerKw = Math.round(power);
      } else {
        peakPowerKw = energyType === "hybrid" ? 60 : 180;
      }
    }

    const rawId = cleanName(raw.id, 48).replace(/[^A-Za-z0-9_-]/g, "");
    const safeId = rawId && !BUILTIN_IDS.has(rawId)
      ? rawId
      : `custom-${energyType}-${Math.round(capacity)}-${Math.round(consumptionPer100Km * 10)}`;

    const roundedCapacity = Number(capacity.toFixed(1));
    const nominalFullRangeKm = Math.round(roundedCapacity / consumptionPerKm);

    if (energyType === "fuel") {
      return {
        id: safeId,
        name,
        energyType,
        builtin: false,
        custom: true,
        capacity: roundedCapacity,
        consumptionPerKm,
        consumptionPer100Km,
        peakPowerKw: null,
        transferEfficiency: 0.95,
        safetyReservePercent: 3,
        unit: "L",
        nominalFullRangeKm
      };
    }

    if (energyType === "hybrid") {
      let fuelCapacity = 60;
      if (raw.fuelCapacity !== undefined && raw.fuelCapacity !== null && raw.fuelCapacity !== "") {
        const fc = parseFinite(raw.fuelCapacity);
        if (fc === null || fc < 10 || fc > 200) return null;
        fuelCapacity = Number(fc.toFixed(1));
      }
      let fuelConsumptionPerKm = 0.056;
      let fuelConsumptionPer100Km = 5.6;
      if (raw.fuelConsumptionPer100Km !== undefined && raw.fuelConsumptionPer100Km !== null && raw.fuelConsumptionPer100Km !== "") {
        const f100 = parseFinite(raw.fuelConsumptionPer100Km);
        if (f100 === null || f100 < 3 || f100 > 40) return null;
        fuelConsumptionPer100Km = Number(f100.toFixed(2));
        fuelConsumptionPerKm = Number((f100 / 100).toFixed(4));
      } else if (raw.fuelConsumptionPerKm !== undefined && raw.fuelConsumptionPerKm !== null && raw.fuelConsumptionPerKm !== "") {
        const fkm = parseFinite(raw.fuelConsumptionPerKm);
        if (fkm === null || fkm < 0.03 || fkm > 0.4) return null;
        fuelConsumptionPerKm = Number(fkm.toFixed(4));
        fuelConsumptionPer100Km = Number((fkm * 100).toFixed(2));
      }
      const fuelNominalFullRangeKm = Math.round(fuelCapacity / fuelConsumptionPerKm);
      return {
        id: safeId,
        name,
        energyType,
        builtin: false,
        custom: true,
        capacity: roundedCapacity,
        consumptionPerKm,
        consumptionPer100Km,
        peakPowerKw,
        transferEfficiency: 0.92,
        safetyReservePercent: 2,
        unit: "kWh",
        nominalFullRangeKm,
        fuelCapacity,
        fuelConsumptionPerKm,
        fuelConsumptionPer100Km,
        fuelTransferEfficiency: 0.95,
        fuelSafetyReservePercent: 3,
        fuelUnit: "L",
        fuelNominalFullRangeKm,
        combinedFullRangeKm: nominalFullRangeKm + fuelNominalFullRangeKm
      };
    }

    return {
      id: safeId,
      name,
      energyType: "electric",
      builtin: false,
      custom: true,
      capacity: roundedCapacity,
      consumptionPerKm,
      consumptionPer100Km,
      peakPowerKw,
      transferEfficiency: 0.92,
      safetyReservePercent: 2,
      unit: "kWh",
      nominalFullRangeKm
    };
  }

  function presetToEnergyProfiles(preset) {
    const baseEv = BUILTIN_VEHICLE_PRESETS[0];
    const baseFuel = BUILTIN_VEHICLE_PRESETS[4];
    const baseHybrid = BUILTIN_VEHICLE_PRESETS[6];

    const profiles = {
      electric: {
        capacity: baseEv.capacity,
        consumptionPerKm: baseEv.consumptionPerKm,
        transferEfficiency: baseEv.transferEfficiency,
        safetyReservePercent: baseEv.safetyReservePercent,
        unit: "kWh",
        nominalFullRangeKm: baseEv.nominalFullRangeKm,
        peakPowerKw: baseEv.peakPowerKw
      },
      fuel: {
        capacity: baseFuel.capacity,
        consumptionPerKm: baseFuel.consumptionPerKm,
        transferEfficiency: baseFuel.transferEfficiency,
        safetyReservePercent: baseFuel.safetyReservePercent,
        unit: "L",
        nominalFullRangeKm: baseFuel.nominalFullRangeKm
      },
      hybridElectric: {
        capacity: baseHybrid.capacity,
        consumptionPerKm: baseHybrid.consumptionPerKm,
        transferEfficiency: baseHybrid.transferEfficiency,
        safetyReservePercent: baseHybrid.safetyReservePercent,
        unit: "kWh",
        nominalFullRangeKm: baseHybrid.nominalFullRangeKm,
        peakPowerKw: baseHybrid.peakPowerKw
      },
      hybridFuel: {
        capacity: baseHybrid.fuelCapacity,
        consumptionPerKm: baseHybrid.fuelConsumptionPerKm,
        transferEfficiency: baseHybrid.fuelTransferEfficiency,
        safetyReservePercent: baseHybrid.fuelSafetyReservePercent,
        unit: "L",
        nominalFullRangeKm: baseHybrid.fuelNominalFullRangeKm
      }
    };

    if (!preset || typeof preset !== "object") return profiles;

    if (preset.energyType === "electric") {
      const capacity = parseFinite(preset.capacity) ?? baseEv.capacity;
      const consumptionPerKm = parseFinite(preset.consumptionPerKm) ?? baseEv.consumptionPerKm;
      profiles.electric = {
        capacity,
        consumptionPerKm,
        transferEfficiency: parseFinite(preset.transferEfficiency) ?? 0.92,
        safetyReservePercent: parseFinite(preset.safetyReservePercent) ?? 2,
        unit: "kWh",
        nominalFullRangeKm: Math.round(capacity / consumptionPerKm),
        peakPowerKw: parseFinite(preset.peakPowerKw) ?? 180
      };
    } else if (preset.energyType === "fuel") {
      const capacity = parseFinite(preset.capacity) ?? baseFuel.capacity;
      const consumptionPerKm = parseFinite(preset.consumptionPerKm) ?? baseFuel.consumptionPerKm;
      profiles.fuel = {
        capacity,
        consumptionPerKm,
        transferEfficiency: parseFinite(preset.transferEfficiency) ?? 0.95,
        safetyReservePercent: parseFinite(preset.safetyReservePercent) ?? 3,
        unit: "L",
        nominalFullRangeKm: Math.round(capacity / consumptionPerKm)
      };
    } else if (preset.energyType === "hybrid") {
      const evCapacity = parseFinite(preset.capacity) ?? baseHybrid.capacity;
      const evConsumption = parseFinite(preset.consumptionPerKm) ?? baseHybrid.consumptionPerKm;
      const fuelCapacity = parseFinite(preset.fuelCapacity) ?? baseHybrid.fuelCapacity;
      const fuelConsumption = parseFinite(preset.fuelConsumptionPerKm) ?? baseHybrid.fuelConsumptionPerKm;
      profiles.hybridElectric = {
        capacity: evCapacity,
        consumptionPerKm: evConsumption,
        transferEfficiency: parseFinite(preset.transferEfficiency) ?? 0.92,
        safetyReservePercent: parseFinite(preset.safetyReservePercent) ?? 2,
        unit: "kWh",
        nominalFullRangeKm: Math.round(evCapacity / evConsumption),
        peakPowerKw: parseFinite(preset.peakPowerKw) ?? 60
      };
      profiles.hybridFuel = {
        capacity: fuelCapacity,
        consumptionPerKm: fuelConsumption,
        transferEfficiency: parseFinite(preset.fuelTransferEfficiency) ?? 0.95,
        safetyReservePercent: parseFinite(preset.fuelSafetyReservePercent) ?? 3,
        unit: "L",
        nominalFullRangeKm: Math.round(fuelCapacity / fuelConsumption)
      };
    }
    return profiles;
  }

  // Piecewise SOC charging curve factors relative to vehicle peak DC power.
  // Above 80% SOC lithium-ion CV phase tapers steeply.
  const CHARGE_CURVE_BANDS = [
    { start: 0, end: 10, factor: 0.78 },
    { start: 10, end: 60, factor: 0.88 },
    { start: 60, end: 80, factor: 0.68 },
    { start: 80, end: 90, factor: 0.38 },
    { start: 90, end: 100, factor: 0.20 }
  ];

  function estimateFastChargeMinutes({
    energyKwh = 0,
    peakPowerKw = 180,
    fromSoc = 20,
    toSoc = 80
  } = {}) {
    const kwh = Math.max(0, parseFinite(energyKwh) ?? 0);
    if (kwh <= 0) return 0;
    const power = Math.max(30, Math.min(600, parseFinite(peakPowerKw) ?? 180));
    const startSoc = Math.max(0, Math.min(100, parseFinite(fromSoc) ?? 20));
    const endSoc = Math.max(startSoc, Math.min(100, parseFinite(toSoc) ?? 80));
    const span = endSoc - startSoc;
    if (span <= 0) {
      return Number(((kwh / (power * 0.78)) * 60).toFixed(1));
    }
    let minutes = 0;
    for (const band of CHARGE_CURVE_BANDS) {
      const overlapStart = Math.max(startSoc, band.start);
      const overlapEnd = Math.min(endSoc, band.end);
      if (overlapEnd <= overlapStart) continue;
      const bandKwh = kwh * ((overlapEnd - overlapStart) / span);
      minutes += (bandKwh / (power * band.factor)) * 60;
    }
    return Number(minutes.toFixed(1));
  }

  function computeTripCostBreakdown({
    energyType = "electric",
    energyNeeded = 0,
    unitPrice,
    touMultiplier = 1,
    peakTouMultiplier = 1.38,
    tolls = 0,
    couponDiscount = 0,
    distanceKm = 0
  } = {}) {
    const fuelMode = isFuelEnergyType(energyType);
    const units = Math.max(0, parseFinite(energyNeeded) ?? 0);
    const parsedPrice = parseFinite(unitPrice);
    const baseUnitPrice = Number((parsedPrice !== null && parsedPrice > 0 ? parsedPrice : (fuelMode ? 7.85 : 1.45)).toFixed(2));
    const effectiveTou = fuelMode ? 1 : Math.max(0.1, parseFinite(touMultiplier) ?? 1);
    const peakTou = fuelMode ? 1 : Math.max(effectiveTou, parseFinite(peakTouMultiplier) ?? 1.38);

    const effectiveUnitPrice = Number((baseUnitPrice * effectiveTou).toFixed(2));
    const peakUnitPrice = Number((baseUnitPrice * peakTou).toFixed(2));
    const grossEnergyCost = Number((units * effectiveUnitPrice).toFixed(2));
    const peakEnergyCost = Number((units * peakUnitPrice).toFixed(2));
    const touSavings = Number(Math.max(0, peakEnergyCost - grossEnergyCost).toFixed(2));

    const appliedCoupon = Number(Math.min(grossEnergyCost, Math.max(0, parseFinite(couponDiscount) ?? 0)).toFixed(2));
    const netEnergyCost = Number(Math.max(0, grossEnergyCost - appliedCoupon).toFixed(2));
    const tollsCost = Number(Math.max(0, parseFinite(tolls) ?? 0).toFixed(2));
    const grossTotalCost = Number((grossEnergyCost + tollsCost).toFixed(2));
    const totalCost = Number((netEnergyCost + tollsCost).toFixed(2));
    const totalSavings = Number((touSavings + appliedCoupon).toFixed(2));
    const dist = Math.max(0, parseFinite(distanceKm) ?? 0);
    const costPerKm = dist > 0 ? Number((totalCost / dist).toFixed(2)) : 0;

    return {
      energyType,
      unit: fuelMode ? "L" : "kWh",
      energyNeeded: Number(units.toFixed(2)),
      baseUnitPrice,
      touMultiplier: Number(effectiveTou.toFixed(2)),
      effectiveUnitPrice,
      grossEnergyCost,
      peakEnergyCost,
      touSavings,
      couponDiscount: appliedCoupon,
      netEnergyCost,
      tolls: tollsCost,
      grossTotalCost,
      totalCost,
      totalSavings,
      distanceKm: Number(dist.toFixed(1)),
      costPerKm
    };
  }

  function nonNegative(value) {
    const parsed = parseFinite(value);
    return parsed !== null && parsed > 0 ? parsed : 0;
  }

  function summarizeLedger(entries = []) {
    const list = Array.isArray(entries) ? entries.filter((item) => item && typeof item === "object") : [];
    let totalDistanceKm = 0;
    let totalEnergyCost = 0;
    let totalTolls = 0;
    let totalCost = 0;
    let totalCouponSavings = 0;
    let totalTouSavings = 0;
    let totalSavings = 0;
    let totalWaitSavedMinutes = 0;

    for (const entry of list) {
      const dist = nonNegative(entry.distanceKm);
      const energyCost = nonNegative(entry.netEnergyCost ?? entry.energyCost);
      const tolls = nonNegative(entry.tolls);
      const entryTotal = entry.totalCost !== undefined ? nonNegative(entry.totalCost) : energyCost + tolls;
      const coupon = nonNegative(entry.couponDiscount ?? entry.couponSavings);
      const tou = nonNegative(entry.touSavings);
      const entrySavings = entry.totalSavings !== undefined ? nonNegative(entry.totalSavings) : coupon + tou;
      const waitSaved = nonNegative(entry.waitSavedMinutes);

      totalDistanceKm += dist;
      totalEnergyCost += energyCost;
      totalTolls += tolls;
      totalCost += entryTotal;
      totalCouponSavings += coupon;
      totalTouSavings += tou;
      totalSavings += entrySavings;
      totalWaitSavedMinutes += waitSaved;
    }

    const tripCount = list.length;
    return {
      tripCount,
      totalDistanceKm: Number(totalDistanceKm.toFixed(1)),
      totalEnergyCost: Number(totalEnergyCost.toFixed(2)),
      totalTolls: Number(totalTolls.toFixed(2)),
      totalCost: Number(totalCost.toFixed(2)),
      totalCouponSavings: Number(totalCouponSavings.toFixed(2)),
      totalTouSavings: Number(totalTouSavings.toFixed(2)),
      totalSavings: Number(totalSavings.toFixed(2)),
      totalWaitSavedMinutes: Number(totalWaitSavedMinutes.toFixed(1)),
      averageCostPerTrip: tripCount > 0 ? Number((totalCost / tripCount).toFixed(2)) : 0,
      averageCostPerKm: totalDistanceKm > 0 ? Number((totalCost / totalDistanceKm).toFixed(2)) : 0
    };
  }

  function csvEscape(value) {
    let raw = value === null || value === undefined ? "" : String(value);
    // Neutralize leading spreadsheet formula characters (including after leading
    // whitespace, NBSP, BOM, or control characters) and leading tab/CR/LF before
    // normalizing line breaks.
    if (/^[\s\uFEFF\u00A0\u0000-\u001f]*[=+\-@]|^[\t\r\n]/.test(raw)) {
      raw = "'" + raw;
    }
    const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (/[",\n]/.test(normalized)) {
      return '"' + normalized.replace(/"/g, '""') + '"';
    }
    return normalized;
  }

  function exportLedgerToCsv(entries = []) {
    const list = Array.isArray(entries) ? entries.filter((item) => item && typeof item === "object") : [];
    const headers = [
      "时间",
      "车型",
      "能源类型",
      "起点",
      "终点",
      "补能站",
      "里程(km)",
      "补能量",
      "电/油费(元)",
      "过路费(元)",
      "优惠券抵扣(元)",
      "分时节省(元)",
      "净支出(元)",
      "节省等待(分)"
    ];
    const rows = [headers.map(csvEscape).join(",")];
    for (const entry of list) {
      const energyCost = nonNegative(entry.netEnergyCost ?? entry.energyCost);
      const tolls = nonNegative(entry.tolls);
      const netTotal = entry.totalCost !== undefined ? nonNegative(entry.totalCost) : energyCost + tolls;
      const cells = [
        entry.timestamp || entry.createdAt || "",
        entry.vehicleName || entry.presetName || "",
        entry.energyType || "",
        entry.origin || "",
        entry.destination || "",
        entry.stationName || "",
        nonNegative(entry.distanceKm).toFixed(1),
        nonNegative(entry.energyNeeded).toFixed(2),
        energyCost.toFixed(2),
        tolls.toFixed(2),
        nonNegative(entry.couponDiscount ?? entry.couponSavings).toFixed(2),
        nonNegative(entry.touSavings).toFixed(2),
        netTotal.toFixed(2),
        nonNegative(entry.waitSavedMinutes).toFixed(1)
      ];
      rows.push(cells.map(csvEscape).join(","));
    }
    return "\uFEFF" + rows.join("\r\n");
  }

  return {
    BUILTIN_VEHICLE_PRESETS,
    DEFAULT_PRESET_BY_ENERGY,
    getPresetById,
    getPresetsForEnergyType,
    sanitizeCustomPreset,
    presetToEnergyProfiles,
    estimateFastChargeMinutes,
    computeTripCostBreakdown,
    summarizeLedger,
    exportLedgerToCsv
  };
});
