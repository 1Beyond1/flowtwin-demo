/**
 * Small, dependency-free multi-objective helpers.
 *
 * Every objective is minimised by default.  Use direction: "max" for a
 * maximisation objective.  Missing/non-finite values are not allowed to
 * dominate a complete candidate; this keeps a partially decorated route from
 * silently winning a Pareto comparison.
 */

function readPath(value, path) {
  return String(path).split(".").reduce((current, key) => current?.[key], value);
}

function objectiveValue(item, objective) {
  if (typeof objective === "function") return objective(item);
  const key = typeof objective === "string" ? objective : objective?.key;
  if (!key) return Number.NaN;
  const accessor = typeof objective?.accessor === "function" ? objective.accessor : null;
  if (accessor) return accessor(item);
  const direct = readPath(item, key);
  if (direct !== undefined) return direct;
  const evaluation = readPath(item, `evaluation.${key}`);
  if (evaluation !== undefined) return evaluation;
  return readPath(item, `metrics.${key}`);
}

function normalizeObjective(objective) {
  if (typeof objective === "string" || typeof objective === "function") {
    return { key: typeof objective === "string" ? objective : "custom", direction: "min", source: objective };
  }
  return {
    ...objective,
    key: objective?.key || "custom",
    direction: objective?.direction === "max" || objective?.maximize === true || objective?.minimize === false ? "max" : "min",
    source: objective
  };
}

function normalizeObjectives(objectives) {
  if (Array.isArray(objectives)) return objectives.map(normalizeObjective);
  if (objectives && typeof objectives === "object") {
    if (objectives.key || objectives.accessor || objectives.direction || objectives.minimize !== undefined || objectives.maximize !== undefined) {
      return [normalizeObjective(objectives)];
    }
    return Object.entries(objectives).map(([key, direction]) => normalizeObjective({
      key,
      direction: direction === "max" || direction === "maximize" ? "max" : "min"
    }));
  }
  return [];
}

function comparable(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Return true when candidate is no worse in every objective and better in at least one. */
export function dominates(candidate, other, objectives = []) {
  const normalized = normalizeObjectives(objectives);
  if (!normalized.length) return false;
  let strictlyBetter = false;
  for (const objective of normalized) {
    const left = comparable(objectiveValue(candidate, objective.source));
    const right = comparable(objectiveValue(other, objective.source));
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (objective.direction === "max") {
      if (left < right) return false;
      if (left > right) strictlyBetter = true;
    } else {
      if (left > right) return false;
      if (left < right) strictlyBetter = true;
    }
  }
  return strictlyBetter;
}

export function isDominated(candidate, candidates = [], objectives = []) {
  const pool = Array.isArray(candidates) ? candidates : [candidates];
  return pool.some((other) => other !== candidate && dominates(other, candidate, objectives));
}

/**
 * Return the true non-dominated front without inventing a quota or requiring
 * different route signatures.  The input order is stable for equal candidates.
 */
export function paretoFront(items = [], objectives = []) {
  const candidates = Array.isArray(items) ? items : [];
  return candidates.filter((candidate, index) => {
    const others = candidates.slice(0, index).concat(candidates.slice(index + 1));
    return !isDominated(candidate, others, objectives);
  });
}

export const nonDominated = paretoFront;
export const selectPareto = paretoFront;
export const selectNonDominated = paretoFront;
export const paretoFilter = paretoFront;
export const getParetoFront = paretoFront;
export const paretoSort = paretoFront;

export function objectiveValues(item, objectives = []) {
  return Object.fromEntries(normalizeObjectives(objectives).map((normalized) => {
    return [normalized.key, comparable(objectiveValue(item, normalized.source))];
  }));
}
