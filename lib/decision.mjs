/**
 * Small, dependency-free multi-objective helpers.
 *
 * Every objective is minimised by default.  Use direction: "max" for a
 * maximisation objective.  Missing/non-finite values are not allowed to
 * dominate a complete candidate; this keeps a partially decorated route from
 * silently winning a Pareto comparison.
 */

function readSegments(value, segments) {
  let current = value;
  for (let index = 0; index < segments.length; index += 1) {
    if (current == null) return undefined;
    current = current[segments[index]];
  }
  return current;
}

function compileObjective(objective) {
  if (typeof objective === "function") {
    return {
      key: "custom",
      direction: "min",
      sign: 1,
      extract: (item) => comparable(objective(item))
    };
  }
  const key = typeof objective === "string" ? objective : objective?.key;
  const direction = typeof objective === "object" && objective !== null
    && (objective.direction === "max" || objective.maximize === true || objective.minimize === false)
    ? "max"
    : "min";
  const sign = direction === "max" ? -1 : 1;
  if (!key) {
    return { key: "custom", direction, sign, extract: () => Number.NaN };
  }
  const accessor = typeof objective?.accessor === "function" ? objective.accessor : null;
  if (accessor) {
    return { key, direction, sign, extract: (item) => comparable(accessor(item)) };
  }
  const directSegments = String(key).split(".");
  if (directSegments.length === 1) {
    const field = directSegments[0];
    return {
      key,
      direction,
      sign,
      extract(item) {
        if (item == null) return Number.NaN;
        const direct = item[field];
        if (direct !== undefined) return comparable(direct);
        const evalValue = item.evaluation?.[field];
        if (evalValue !== undefined) return comparable(evalValue);
        return comparable(item.metrics?.[field]);
      }
    };
  }
  const evalSegments = ["evaluation", ...directSegments];
  const metricSegments = ["metrics", ...directSegments];
  return {
    key,
    direction,
    sign,
    extract(item) {
      const direct = readSegments(item, directSegments);
      if (direct !== undefined) return comparable(direct);
      const evalValue = readSegments(item, evalSegments);
      if (evalValue !== undefined) return comparable(evalValue);
      return comparable(readSegments(item, metricSegments));
    }
  };
}

function compileObjectives(objectives) {
  if (Array.isArray(objectives)) return objectives.map(compileObjective);
  if (objectives && typeof objectives === "object") {
    if (objectives.key || objectives.accessor || objectives.direction || objectives.minimize !== undefined || objectives.maximize !== undefined) {
      return [compileObjective(objectives)];
    }
    return Object.entries(objectives).map(([key, direction]) => compileObjective({
      key,
      direction: direction === "max" || direction === "maximize" ? "max" : "min"
    }));
  }
  return [];
}

function comparable(value) {
  if (value === null || value === undefined || typeof value === "boolean") return Number.NaN;
  if (typeof value === "string" && value.trim() === "") return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function vectorDominates(left, right, dimensions) {
  let strictlyBetter = false;
  for (let d = 0; d < dimensions; d += 1) {
    const l = left[d];
    const r = right[d];
    if (l > r) return false;
    if (l < r) strictlyBetter = true;
  }
  return strictlyBetter;
}

function vectorsEqual(left, right, dimensions) {
  for (let d = 0; d < dimensions; d += 1) {
    if (left[d] !== right[d]) return false;
  }
  return true;
}

/** Return true when candidate is no worse in every objective and better in at least one. */
export function dominates(candidate, other, objectives = []) {
  const compiled = compileObjectives(objectives);
  if (!compiled.length) return false;
  let strictlyBetter = false;
  for (let index = 0; index < compiled.length; index += 1) {
    const objective = compiled[index];
    const left = objective.extract(candidate);
    const right = objective.extract(other);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    const scaledLeft = left * objective.sign;
    const scaledRight = right * objective.sign;
    if (scaledLeft > scaledRight) return false;
    if (scaledLeft < scaledRight) strictlyBetter = true;
  }
  return strictlyBetter;
}

export function isDominated(candidate, candidates = [], objectives = []) {
  const pool = Array.isArray(candidates) ? candidates : [candidates];
  const compiled = compileObjectives(objectives);
  const dimensions = compiled.length;
  if (!dimensions || !pool.length) return false;
  const target = new Array(dimensions);
  for (let d = 0; d < dimensions; d += 1) {
    const value = compiled[d].extract(candidate);
    if (!Number.isFinite(value)) return false;
    target[d] = value * compiled[d].sign;
  }
  for (let index = 0; index < pool.length; index += 1) {
    const other = pool[index];
    if (other === candidate) continue;
    let strictlyBetter = false;
    let comparableOther = true;
    for (let d = 0; d < dimensions; d += 1) {
      const value = compiled[d].extract(other);
      if (!Number.isFinite(value)) {
        comparableOther = false;
        break;
      }
      const scaled = value * compiled[d].sign;
      if (scaled > target[d]) {
        comparableOther = false;
        break;
      }
      if (scaled < target[d]) strictlyBetter = true;
    }
    if (comparableOther && strictlyBetter) return true;
  }
  return false;
}

/**
 * Return the true non-dominated front without inventing a quota or requiring
 * different route signatures.  The input order is stable for equal candidates.
 *
 * Pre-extracts every objective vector once, sorts valid candidates
 * lexicographically so no later candidate can dominate an earlier one, and
 * maintains only unique non-dominated frontier vectors.
 */
export function paretoFront(items = [], objectives = []) {
  const candidates = Array.isArray(items) ? items : [];
  const count = candidates.length;
  if (count <= 1) return candidates.slice();
  const compiled = compileObjectives(objectives);
  const dimensions = compiled.length;
  if (!dimensions) return candidates.slice();

  const kept = new Uint8Array(count);
  const validIndices = [];
  const vectors = new Array(count);

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates[index];
    const vector = new Float64Array(dimensions);
    let allFinite = true;
    for (let d = 0; d < dimensions; d += 1) {
      const value = compiled[d].extract(candidate);
      if (!Number.isFinite(value)) {
        allFinite = false;
        break;
      }
      vector[d] = value * compiled[d].sign;
    }
    if (!allFinite) {
      // Incomplete candidates neither dominate nor are dominated.
      kept[index] = 1;
    } else {
      vectors[index] = vector;
      validIndices.push(index);
    }
  }

  validIndices.sort((leftIdx, rightIdx) => {
    const left = vectors[leftIdx];
    const right = vectors[rightIdx];
    for (let d = 0; d < dimensions; d += 1) {
      if (left[d] !== right[d]) return left[d] - right[d];
    }
    return leftIdx - rightIdx;
  });

  if (dimensions === 1) {
    if (validIndices.length) {
      const bestValue = vectors[validIndices[0]][0];
      for (let i = 0; i < validIndices.length; i += 1) {
        const idx = validIndices[i];
        if (vectors[idx][0] === bestValue) kept[idx] = 1;
        else break;
      }
    }
  } else if (dimensions === 2) {
    let bestSecond = Number.POSITIVE_INFINITY;
    let lastFirst = Number.NaN;
    let lastSecond = Number.NaN;
    for (let i = 0; i < validIndices.length; i += 1) {
      const idx = validIndices[i];
      const vec = vectors[idx];
      const sameAsLast = vec[0] === lastFirst && vec[1] === lastSecond;
      if (sameAsLast || vec[1] < bestSecond) {
        kept[idx] = 1;
        if (vec[1] < bestSecond) bestSecond = vec[1];
        lastFirst = vec[0];
        lastSecond = vec[1];
      }
    }
  } else {
    const frontVectors = [];
    for (let i = 0; i < validIndices.length; i += 1) {
      const idx = validIndices[i];
      const vec = vectors[idx];
      let dominated = false;
      let duplicate = false;
      for (let f = 0; f < frontVectors.length; f += 1) {
        const front = frontVectors[f];
        if (vectorDominates(front, vec, dimensions)) {
          dominated = true;
          break;
        }
        if (vectorsEqual(front, vec, dimensions)) {
          duplicate = true;
        }
      }
      if (!dominated) {
        kept[idx] = 1;
        if (!duplicate) frontVectors.push(vec);
      }
    }
  }

  const result = [];
  for (let index = 0; index < count; index += 1) {
    if (kept[index]) result.push(candidates[index]);
  }
  return result;
}

export const nonDominated = paretoFront;
export const selectPareto = paretoFront;
export const selectNonDominated = paretoFront;
export const paretoFilter = paretoFront;
export const getParetoFront = paretoFront;
export const paretoSort = paretoFront;

export function objectiveValues(item, objectives = []) {
  return Object.fromEntries(compileObjectives(objectives).map((compiled) => {
    return [compiled.key, compiled.extract(item)];
  }));
}
