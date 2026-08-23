import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const FLOWTWIN_REPOSITORY = "1Beyond1/flowtwin-demo";
export const GITHUB_API_BASE = "https://api.github.com";
export const VERSION_CHECK_CACHE_MS = 15 * 60 * 1000;
export const DEFAULT_GITHUB_TIMEOUT_MS = 5_000;

const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;
const SEMVER_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BUILD_METADATA_PATHS = ["runtime/build-info.json", ".flowtwin-build.json"];

function cleanText(value, maxLength = 256) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

export function normalizeCommit(value) {
  const commit = cleanText(value, 64);
  return commit && COMMIT_PATTERN.test(commit) ? commit.toLowerCase() : null;
}

export function commitsMatch(left, right) {
  const a = normalizeCommit(left);
  const b = normalizeCommit(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function normalizeRepository(value) {
  const repo = cleanText(value, 256);
  if (!repo || !REPOSITORY_PATTERN.test(repo)) return null;
  const [owner, name] = repo.split("/");
  return {
    value: `${owner}/${name}`,
    path: `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  };
}

function buildGithubApiUrl(repo, ...segments) {
  const normalizedRepo = normalizeRepository(repo);
  if (!normalizedRepo) return null;
  const encodedSegments = segments.map((segment) => encodeURIComponent(String(segment)));
  return `${GITHUB_API_BASE}/repos/${normalizedRepo.path}/${encodedSegments.join("/")}`;
}

export function parseVersion(value) {
  const text = cleanText(value, 128);
  const match = text?.match(SEMVER_PATTERN);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
    version: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.length) return -1;
    if (index >= right.length) return 1;
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function buildVersionInfo({
  version,
  commit = null,
  repo = FLOWTWIN_REPOSITORY,
  buildTime = null,
  source = "package.json",
  commitSource = null,
  buildTimeSource = null
} = {}) {
  const normalizedCommit = normalizeCommit(commit);
  return {
    version: String(version ?? "").trim(),
    commit: normalizedCommit,
    repo: repo || FLOWTWIN_REPOSITORY,
    buildTime: cleanText(buildTime, 128),
    source: source || "package.json",
    commitSource: commitSource || (normalizedCommit ? "unknown" : null),
    buildTimeSource: buildTimeSource || null
  };
}

export async function readPackageVersion(root, readFileImpl = readFile) {
  const packageText = await readFileImpl(join(root, "package.json"), "utf8");
  let packageJson;
  try {
    packageJson = JSON.parse(packageText);
  } catch {
    throw new Error("PACKAGE_JSON_INVALID");
  }
  const version = cleanText(packageJson?.version, 128);
  if (!version || !parseVersion(version)) throw new Error("PACKAGE_VERSION_INVALID");
  return version;
}

async function readBuildMetadata(root, readFileImpl = readFile) {
  for (const relativePath of BUILD_METADATA_PATHS) {
    try {
      const text = await readFileImpl(join(root, relativePath), "utf8");
      const value = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      return {
        commit: normalizeCommit(value.commit),
        buildTime: cleanText(value.buildTime, 128)
      };
    } catch {
      // A deployment package may not contain build metadata. Continue to the
      // next source instead of making the version endpoint fail.
    }
  }
  return { commit: null, buildTime: null };
}

async function readGitMetadata(root, execImpl = execFileAsync) {
  try {
    const result = await execImpl(
      "git",
      ["-C", root, "log", "-1", "--format=%H%x00%cI"],
      { timeout: 1_500, windowsHide: true, maxBuffer: 4_096 }
    );
    const output = String(result?.stdout ?? result ?? "").trim();
    const [commitText, ...buildTimeParts] = output.split("\u0000");
    const commit = normalizeCommit(commitText);
    const buildTime = cleanText(buildTimeParts.join("\u0000"), 128);
    return { commit, buildTime };
  } catch {
    return { commit: null, buildTime: null };
  }
}

export async function loadVersionInfo({ root, env = process.env, execImpl = execFileAsync, readFileImpl = readFile } = {}) {
  if (!root) throw new Error("VERSION_ROOT_REQUIRED");
  const version = await readPackageVersion(root, readFileImpl);
  const git = await readGitMetadata(root, execImpl);
  const envCommit = normalizeCommit(env?.FLOWTWIN_COMMIT);
  const envBuildTime = cleanText(env?.FLOWTWIN_BUILD_TIME, 128);
  const metadata = await readBuildMetadata(root, readFileImpl);
  const commit = git.commit || envCommit || metadata.commit;
  const buildTime = envBuildTime || git.buildTime || metadata.buildTime;
  return buildVersionInfo({
    version,
    commit,
    repo: FLOWTWIN_REPOSITORY,
    buildTime,
    source: "package.json",
    commitSource: git.commit ? "git" : envCommit ? "env" : metadata.commit ? "build-metadata" : null,
    buildTimeSource: envBuildTime ? "env" : git.buildTime ? "git" : metadata.buildTime ? "build-metadata" : null
  });
}

function localSnapshot(localVersion) {
  return buildVersionInfo({
    version: localVersion?.version,
    commit: localVersion?.commit,
    repo: localVersion?.repo || FLOWTWIN_REPOSITORY,
    buildTime: localVersion?.buildTime,
    source: localVersion?.source || "package.json",
    commitSource: localVersion?.commitSource,
    buildTimeSource: localVersion?.buildTimeSource
  });
}

function checkedAtIso(value) {
  const timestamp = Number(value);
  return new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString();
}

function unavailableResult(localVersion, reason, checkedAt) {
  return {
    ...localSnapshot(localVersion),
    checked: false,
    status: "unavailable",
    updateAvailable: null,
    isLatest: null,
    relation: null,
    aheadBy: null,
    behindBy: null,
    checkSource: null,
    remote: null,
    remoteVersion: null,
    remoteCommit: null,
    reason,
    message: "暂时无法检查 GitHub 更新，请稍后重试。",
    checkedAt: checkedAtIso(checkedAt),
    cached: false
  };
}

function responseStatus(response) {
  const status = Number(response?.status);
  return Number.isInteger(status) && status >= 100 ? status : 0;
}

function isRateLimited(status) {
  return status === 403 || status === 429;
}

function requestReason(kind, status) {
  if (kind === "timeout") return "GITHUB_TIMEOUT";
  if (kind === "offline") return "GITHUB_OFFLINE";
  if (isRateLimited(status)) return "GITHUB_RATE_LIMITED";
  if (status === 404) return "GITHUB_NOT_FOUND";
  if (status) return `GITHUB_HTTP_${status}`;
  return "GITHUB_INVALID_RESPONSE";
}

async function fetchGithubJson(url, { fetchImpl, timeoutMs }) {
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "FlowTwin-Version-Check"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const status = responseStatus(response);
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { status, data };
  } catch (error) {
    const kind = error?.name === "TimeoutError" || error?.name === "AbortError" || error?.code === "ETIMEDOUT"
      ? "timeout"
      : "offline";
    return { status: 0, data: null, kind };
  }
}

function availableResult(localVersion, {
  remote,
  checkSource,
  updateAvailable,
  checkedAt,
  relation = null,
  aheadBy = null,
  behindBy = null
}) {
  const current = localSnapshot(localVersion);
  return {
    ...current,
    checked: true,
    status: updateAvailable ? "update-available" : "up-to-date",
    updateAvailable,
    isLatest: !updateAvailable,
    relation,
    aheadBy,
    behindBy,
    checkSource,
    remote,
    remoteVersion: remote.version || null,
    remoteCommit: remote.commit || null,
    reason: null,
    message: null,
    checkedAt: checkedAtIso(checkedAt),
    cached: false
  };
}

export async function checkGitHubVersion({
  localVersion,
  repo = FLOWTWIN_REPOSITORY,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
  now = Date.now
} = {}) {
  const checkedAt = typeof now === "function" ? now() : now;
  const current = localSnapshot(localVersion);
  if (!current.version || !parseVersion(current.version)) return unavailableResult(current, "PACKAGE_VERSION_INVALID", checkedAt);
  if (typeof fetchImpl !== "function") return unavailableResult(current, "GITHUB_FETCH_UNAVAILABLE", checkedAt);
  const normalizedRepo = normalizeRepository(repo);
  if (!normalizedRepo) return unavailableResult(current, "GITHUB_REPOSITORY_INVALID", checkedAt);

  const releaseUrl = buildGithubApiUrl(normalizedRepo.value, "releases", "latest");
  const release = await fetchGithubJson(releaseUrl, { fetchImpl, timeoutMs });
  if (release.kind) return unavailableResult(current, requestReason(release.kind, release.status), checkedAt);
  if (release.status === 200) {
    const tag = cleanText(release.data?.tag_name, 128);
    const remoteVersion = parseVersion(tag);
    if (!tag || !remoteVersion) return unavailableResult(current, "GITHUB_RELEASE_VERSION_INVALID", checkedAt);
    const comparison = compareVersions(current.version, remoteVersion.version);
    if (comparison === null) return unavailableResult(current, "PACKAGE_VERSION_INVALID", checkedAt);
    return availableResult(current, {
      checkSource: "github-release",
      updateAvailable: comparison < 0,
      checkedAt,
      remote: {
        type: "release",
        version: remoteVersion.version,
        tag,
        commit: normalizeCommit(release.data?.target_commitish),
        url: cleanText(release.data?.html_url, 512),
        publishedAt: cleanText(release.data?.published_at, 128)
      }
    });
  }
  if (release.status !== 404) return unavailableResult(current, requestReason(null, release.status), checkedAt);

  const mainUrl = buildGithubApiUrl(normalizedRepo.value, "commits", "main");
  const main = await fetchGithubJson(mainUrl, { fetchImpl, timeoutMs });
  if (main.kind) return unavailableResult(current, requestReason(main.kind, main.status), checkedAt);
  if (main.status !== 200) {
    const reason = main.status === 404 ? "GITHUB_REPOSITORY_OR_MAIN_NOT_FOUND" : requestReason(null, main.status);
    return unavailableResult(current, reason, checkedAt);
  }
  const remoteCommit = normalizeCommit(main.data?.sha);
  if (!remoteCommit) return unavailableResult(current, "GITHUB_MAIN_COMMIT_INVALID", checkedAt);
  if (!current.commit) return unavailableResult(current, "LOCAL_COMMIT_UNAVAILABLE", checkedAt);
  if (commitsMatch(current.commit, remoteCommit)) {
    return availableResult(current, {
      checkSource: "github-main",
      updateAvailable: false,
      relation: "identical",
      aheadBy: 0,
      behindBy: 0,
      checkedAt,
      remote: {
        type: "commit",
        version: null,
        commit: remoteCommit,
        relation: "identical",
        url: cleanText(main.data?.html_url, 512),
        publishedAt: null
      }
    });
  }

  const compareUrl = buildGithubApiUrl(
    normalizedRepo.value,
    "compare",
    `${current.commit}...main`
  );
  const compare = await fetchGithubJson(compareUrl, { fetchImpl, timeoutMs });
  if (compare.kind) return unavailableResult(current, requestReason(compare.kind, compare.status), checkedAt);
  if (compare.status !== 200) {
    // The repository and main branch were already resolved above. A 404 here
    // normally means the running build's commit has not been pushed to GitHub,
    // so report that state instead of presenting it as a generic network error.
    const reason = compare.status === 404 ? "LOCAL_COMMIT_NOT_PUBLISHED" : requestReason(null, compare.status);
    return unavailableResult(current, reason, checkedAt);
  }
  const relation = cleanText(compare.data?.status, 32)?.toLowerCase();
  if (!["ahead", "behind", "identical", "diverged"].includes(relation)) {
    return unavailableResult(current, "GITHUB_COMPARE_INVALID", checkedAt);
  }
  const baseCommit = normalizeCommit(compare.data?.base_commit?.sha);
  const headCommit = normalizeCommit(compare.data?.head_commit?.sha);
  if (!baseCommit || !headCommit || !commitsMatch(current.commit, baseCommit) || !commitsMatch(remoteCommit, headCommit)) {
    return unavailableResult(current, "GITHUB_COMPARE_REF_MISMATCH", checkedAt);
  }
  const aheadBy = Number(compare.data?.ahead_by);
  const behindBy = Number(compare.data?.behind_by);
  if (!Number.isInteger(aheadBy) || aheadBy < 0 || !Number.isInteger(behindBy) || behindBy < 0) {
    return unavailableResult(current, "GITHUB_COMPARE_COUNTS_INVALID", checkedAt);
  }
  if (relation === "diverged") return unavailableResult(current, "GITHUB_COMPARE_DIVERGED", checkedAt);
  return availableResult(current, {
    checkSource: "github-main",
    updateAvailable: relation === "ahead",
    relation,
    aheadBy,
    behindBy,
    checkedAt,
    remote: {
        type: "commit",
        version: null,
        commit: remoteCommit,
        relation,
        aheadBy,
        behindBy,
        url: cleanText(main.data?.html_url, 512),
        compareUrl: cleanText(compare.data?.html_url, 512),
        publishedAt: null
      }
  });
}

export function createVersionChecker({
  localVersion,
  repo = FLOWTWIN_REPOSITORY,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_GITHUB_TIMEOUT_MS,
  cacheMs = VERSION_CHECK_CACHE_MS,
  now = Date.now
} = {}) {
  let cache = null;
  let inFlight = null;

  async function check() {
    const currentTime = typeof now === "function" ? now() : now;
    if (cache && currentTime >= cache.checkedAt && currentTime - cache.checkedAt < cacheMs) {
      return { ...cache.value, cached: true };
    }
    if (inFlight) return inFlight;
    inFlight = checkGitHubVersion({ localVersion, repo, fetchImpl, timeoutMs, now: currentTime })
      .then((result) => {
        // Cache only authoritative comparisons. A timeout, rate limit or an
        // unpublished local commit should be retryable immediately after the
        // external condition changes.
        cache = result.checked ? { checkedAt: currentTime, value: result } : null;
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    check,
    clearCache() {
      cache = null;
    }
  };
}

export async function resolveVersionRoute({
  method,
  pathname,
  versionInfo,
  checkVersion
} = {}) {
  if (pathname !== "/api/version" && pathname !== "/api/version/check") return null;
  if (method !== "GET") return { status: 405, body: { error: "METHOD_NOT_ALLOWED" } };
  if (pathname === "/api/version") return { status: 200, body: versionInfo };
  if (typeof checkVersion !== "function") return { status: 503, body: { error: "VERSION_CHECK_UNAVAILABLE" } };
  return { status: 200, body: await checkVersion() };
}
