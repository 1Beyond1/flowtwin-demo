import { randomBytes } from "node:crypto";
import { parseOptionalNumber } from "./number.mjs";

const DEFAULT_DRIVER_PLATE = "京A·FT2026";
const MAX_RECENT_REDEMPTIONS = 20;

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizePlate(value) {
  return String(value || DEFAULT_DRIVER_PLATE)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 24) || DEFAULT_DRIVER_PLATE;
}

function generateId(prefix) {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

function generateShortCode() {
  return `FT-${randomBytes(2).toString("hex").toUpperCase()}`;
}

function publicClaim(claim) {
  return {
    claimId: claim.claimId,
    couponId: claim.couponId,
    stationId: claim.stationId,
    stationName: claim.stationName,
    discountAmount: claim.discountAmount,
    voucherCode: claim.voucherCode,
    driverPlate: claim.driverPlate,
    status: claim.status,
    claimedAt: claim.claimedAt,
    redeemedAt: claim.redeemedAt
  };
}

function publicCampaign(campaign) {
  return {
    couponId: campaign.couponId,
    code: campaign.code,
    stationId: campaign.stationId,
    stationName: campaign.stationName,
    discountAmount: campaign.discountAmount,
    maxRedemptions: campaign.maxRedemptions,
    remainingCount: campaign.remainingCount,
    claimedCount: campaign.claimedCount,
    redeemedCount: campaign.redeemedCount,
    totalDiscountRedeemed: Number(campaign.totalDiscountRedeemed.toFixed(2)),
    targetSegment: campaign.targetSegment,
    sourceScenarioRoi: campaign.sourceScenarioRoi,
    sourceDivertedVehicles: campaign.sourceDivertedVehicles,
    status: campaign.status,
    createdAt: campaign.createdAt,
    expiresAt: campaign.expiresAt,
    recentRedemptions: campaign.recentRedemptions.map((entry) => ({ ...entry }))
  };
}

/**
 * In-memory live coupon lifecycle store (issue -> list -> claim -> redeem -> reset)
 * for demonstrating operator-to-driver diversion incentives end-to-end.
 */
export function createCouponStore({
  maxCampaigns = 200,
  ttlMs = 24 * 60 * 60 * 1000,
  now = () => Date.now()
} = {}) {
  const safeMaxCampaigns = Math.max(1, Math.min(5000, Math.round(Number(maxCampaigns) || 200)));
  const safeTtlMs = Math.max(1000, Number(ttlMs) || 24 * 60 * 60 * 1000);
  const campaigns = new Map();

  function pruneExpired() {
    const current = now();
    for (const [couponId, campaign] of campaigns) {
      if (campaign.expiresAt <= current) campaigns.delete(couponId);
    }
  }

  function buildSummary() {
    let activeCampaigns = 0;
    let totalIssuedQuota = 0;
    let claimedCount = 0;
    let redeemedCount = 0;
    let totalDiscountRedeemed = 0;
    for (const campaign of campaigns.values()) {
      if (campaign.status === "active") activeCampaigns += 1;
      totalIssuedQuota += campaign.maxRedemptions;
      claimedCount += campaign.claimedCount;
      redeemedCount += campaign.redeemedCount;
      totalDiscountRedeemed += campaign.totalDiscountRedeemed;
    }
    return {
      activeCampaigns,
      totalIssuedQuota,
      claimedCount,
      redeemedCount,
      redemptionRate: claimedCount > 0 ? Number((redeemedCount / claimedCount).toFixed(3)) : 0,
      totalDiscountRedeemed: Number(totalDiscountRedeemed.toFixed(2))
    };
  }

  function findLatestActiveByStation(stationId) {
    const target = cleanText(stationId, 120);
    if (!target) return null;
    const list = Array.from(campaigns.values());
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const candidate = list[index];
      if (candidate.stationId === target && candidate.status === "active") return candidate;
    }
    return null;
  }

  function issue(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw httpError(400, "INVALID_COUPON_INPUT");
    }
    const stationId = cleanText(input.stationId, 120);
    const stationName = cleanText(input.stationName, 120);
    const discountParsed = parseOptionalNumber(input.discountAmount);
    if (!stationId || !stationName || discountParsed === null || discountParsed < 1 || discountParsed > 100) {
      throw httpError(400, "INVALID_COUPON_INPUT");
    }
    let maxRedemptions = 30;
    if (input.maxRedemptions !== undefined && input.maxRedemptions !== null && input.maxRedemptions !== "") {
      const parsedMax = parseOptionalNumber(input.maxRedemptions);
      if (parsedMax === null || parsedMax < 1 || parsedMax > 500) {
        throw httpError(400, "INVALID_COUPON_INPUT");
      }
      maxRedemptions = Math.round(parsedMax);
    }

    const targetSegment = cleanText(input.targetSegment, 48) || "all";
    const parsedRoi = parseOptionalNumber(input.sourceScenarioRoi);
    const parsedDiverted = parseOptionalNumber(input.sourceDivertedVehicles);

    pruneExpired();
    for (const existing of campaigns.values()) {
      if (existing.stationId === stationId && existing.status === "active") {
        existing.status = "superseded";
      }
    }
    while (campaigns.size >= safeMaxCampaigns) {
      const oldestKey = campaigns.keys().next().value;
      if (oldestKey === undefined) break;
      campaigns.delete(oldestKey);
    }

    const current = now();
    const campaign = {
      couponId: generateId("cpn"),
      code: generateShortCode(),
      stationId,
      stationName,
      discountAmount: Number(discountParsed.toFixed(1)),
      maxRedemptions,
      remainingCount: maxRedemptions,
      claimedCount: 0,
      redeemedCount: 0,
      totalDiscountRedeemed: 0,
      targetSegment,
      sourceScenarioRoi: parsedRoi !== null ? Number(parsedRoi.toFixed(3)) : null,
      sourceDivertedVehicles: parsedDiverted !== null ? Number(parsedDiverted.toFixed(2)) : null,
      status: "active",
      createdAt: current,
      expiresAt: current + safeTtlMs,
      claimSeq: 0,
      claimsById: new Map(),
      claimsByPlate: new Map(),
      recentRedemptions: []
    };
    campaigns.set(campaign.couponId, campaign);

    return {
      ok: true,
      campaign: publicCampaign(campaign),
      summary: buildSummary()
    };
  }

  function list({ stationId, status } = {}) {
    pruneExpired();
    const filterStation = stationId !== undefined && stationId !== null && String(stationId).trim() !== ""
      ? cleanText(stationId, 120)
      : null;
    const filterStatus = status !== undefined && status !== null && String(status).trim() !== ""
      ? cleanText(status, 32)
      : null;

    const results = [];
    const values = Array.from(campaigns.values());
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const campaign = values[index];
      if (filterStation && campaign.stationId !== filterStation) continue;
      if (filterStatus && campaign.status !== filterStatus) continue;
      results.push(publicCampaign(campaign));
    }
    return {
      campaigns: results,
      summary: buildSummary()
    };
  }

  function claim(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw httpError(404, "COUPON_NOT_FOUND");
    }
    pruneExpired();
    const requestedCouponId = cleanText(input.couponId, 80);
    let campaign = null;
    if (requestedCouponId) {
      const found = campaigns.get(requestedCouponId);
      if (found && found.status === "active") campaign = found;
    } else if (input.stationId) {
      campaign = findLatestActiveByStation(input.stationId);
    }
    if (!campaign) {
      throw httpError(404, "COUPON_NOT_FOUND");
    }

    const driverPlate = sanitizePlate(input.driverPlate);
    const existing = campaign.claimsByPlate.get(driverPlate);
    if (existing) {
      return {
        ok: true,
        idempotent: true,
        claim: publicClaim(existing),
        campaign: publicCampaign(campaign),
        summary: buildSummary()
      };
    }

    if (campaign.remainingCount <= 0) {
      throw httpError(409, "COUPON_EXHAUSTED");
    }

    campaign.claimSeq += 1;
    const seq = String(campaign.claimSeq).padStart(3, "0");
    const newClaim = {
      claimId: generateId("clm"),
      couponId: campaign.couponId,
      stationId: campaign.stationId,
      stationName: campaign.stationName,
      discountAmount: campaign.discountAmount,
      voucherCode: `${campaign.code}-${seq}`,
      driverPlate,
      status: "claimed",
      claimedAt: now(),
      redeemedAt: null,
      redemption: null
    };
    campaign.claimsById.set(newClaim.claimId, newClaim);
    campaign.claimsByPlate.set(driverPlate, newClaim);
    campaign.remainingCount -= 1;
    campaign.claimedCount += 1;

    return {
      ok: true,
      idempotent: false,
      claim: publicClaim(newClaim),
      campaign: publicCampaign(campaign),
      summary: buildSummary()
    };
  }

  function redeem(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw httpError(400, "INVALID_REDEEM_INPUT");
    }
    let parsedGross;
    if (input.grossAmount !== undefined) {
      const numeric = parseOptionalNumber(input.grossAmount);
      if (numeric === null || numeric < 0 || numeric > 10000) {
        throw httpError(400, "INVALID_REDEEM_INPUT");
      }
      parsedGross = numeric;
    }

    pruneExpired();
    const driverPlate = sanitizePlate(input.driverPlate);
    const requestedClaimId = cleanText(input.claimId, 80);
    const requestedCouponId = cleanText(input.couponId, 80);
    const requestedStationId = cleanText(input.stationId, 120);

    let matchedCampaign = null;
    let matchedClaim = null;

    if (requestedClaimId) {
      for (const candidate of campaigns.values()) {
        const found = candidate.claimsById.get(requestedClaimId);
        if (found) {
          matchedCampaign = candidate;
          matchedClaim = found;
          break;
        }
      }
    } else if (requestedCouponId) {
      const candidate = campaigns.get(requestedCouponId);
      if (candidate) {
        const found = candidate.claimsByPlate.get(driverPlate);
        if (found) {
          matchedCampaign = candidate;
          matchedClaim = found;
        }
      }
    } else if (requestedStationId) {
      const values = Array.from(campaigns.values());
      for (let index = values.length - 1; index >= 0; index -= 1) {
        const candidate = values[index];
        if (candidate.stationId !== requestedStationId) continue;
        const found = candidate.claimsByPlate.get(driverPlate);
        if (found) {
          matchedCampaign = candidate;
          matchedClaim = found;
          if (candidate.status === "active") break;
        }
      }
    }

    if (!matchedCampaign || !matchedClaim) {
      throw httpError(404, "CLAIM_NOT_FOUND");
    }

    if (matchedClaim.status === "redeemed" && matchedClaim.redemption) {
      return {
        ok: true,
        idempotent: true,
        redemption: { ...matchedClaim.redemption },
        campaign: publicCampaign(matchedCampaign),
        summary: buildSummary()
      };
    }

    const grossAmount = Number((parsedGross !== undefined ? parsedGross : matchedCampaign.discountAmount).toFixed(2));
    const discountApplied = Number(Math.min(grossAmount, matchedCampaign.discountAmount).toFixed(2));
    const netPaid = Number(Math.max(0, grossAmount - discountApplied).toFixed(2));
    const redeemedAt = now();

    const redemption = {
      claimId: matchedClaim.claimId,
      couponId: matchedCampaign.couponId,
      voucherCode: matchedClaim.voucherCode,
      stationId: matchedCampaign.stationId,
      stationName: matchedCampaign.stationName,
      driverPlate: matchedClaim.driverPlate,
      grossAmount,
      discountApplied,
      netPaid,
      redeemedAt
    };

    matchedClaim.status = "redeemed";
    matchedClaim.redeemedAt = redeemedAt;
    matchedClaim.redemption = redemption;
    matchedCampaign.redeemedCount += 1;
    matchedCampaign.totalDiscountRedeemed = Number((matchedCampaign.totalDiscountRedeemed + discountApplied).toFixed(2));
    matchedCampaign.recentRedemptions.unshift(redemption);
    if (matchedCampaign.recentRedemptions.length > MAX_RECENT_REDEMPTIONS) {
      matchedCampaign.recentRedemptions.length = MAX_RECENT_REDEMPTIONS;
    }

    return {
      ok: true,
      idempotent: false,
      redemption: { ...redemption },
      campaign: publicCampaign(matchedCampaign),
      summary: buildSummary()
    };
  }

  function reset() {
    const cleared = campaigns.size;
    campaigns.clear();
    return {
      ok: true,
      cleared,
      summary: buildSummary()
    };
  }

  return {
    issue,
    list,
    claim,
    redeem,
    reset
  };
}
