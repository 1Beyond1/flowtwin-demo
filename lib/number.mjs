/**
 * Safe numeric parsing helpers that never coerce null, undefined, empty
 * strings, booleans, or objects into zero (unlike bare Number(null) === 0).
 */

export function parseOptionalNumber(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "object") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function clampOptionalNumber(value, fallback, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  const parsed = parseOptionalNumber(value);
  if (parsed === null) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
