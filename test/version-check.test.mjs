import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildVersionInfo,
  checkGitHubVersion,
  commitsMatch,
  compareVersions,
  createVersionChecker,
  loadVersionInfo,
  resolveVersionRoute
} from "../lib/version.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const localVersion = buildVersionInfo({
  version: "1.1.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  buildTime: "2026-08-08T00:00:00.000Z",
  commitSource: "git",
  buildTimeSource: "git"
});

function githubResponse(body, status = 200) {
  return new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("version comparisons accept release tags and follow semver precedence", () => {
  assert.equal(compareVersions("1.1.0", "v1.2.0"), -1);
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
  assert.equal(compareVersions("1.2.0-beta.2", "1.2.0-beta.10"), -1);
  assert.equal(compareVersions("1.2.0", "not-a-version"), null);
  assert.equal(commitsMatch("0123456789abcdef0123456789abcdef01234567", "0123456789abcdef"), true);
  assert.equal(commitsMatch("0123456789abcdef0123456789abcdef01234567", "fedcba9876543210"), false);
});

test("local version truth comes from package.json and deployment metadata can use env fallbacks", async () => {
  const info = await loadVersionInfo({
    root: repoRoot,
    env: {
      FLOWTWIN_COMMIT: "abcdef0123456789abcdef0123456789abcdef01",
      FLOWTWIN_BUILD_TIME: "2026-08-08T01:02:03.000Z"
    },
    execImpl: async () => {
      throw new Error("no .git in deployment package");
    }
  });
  assert.equal(info.version, "1.1.0");
  assert.equal(info.commit, "abcdef0123456789abcdef0123456789abcdef01");
  assert.equal(info.commitSource, "env");
  assert.equal(info.buildTime, "2026-08-08T01:02:03.000Z");
  assert.equal(info.buildTimeSource, "env");
  assert.equal(info.source, "package.json");
  assert.equal(info.repo, "1Beyond1/flowtwin-demo");
});

test("release is preferred and a newer release is reported as an available update", async () => {
  const calls = [];
  const result = await checkGitHubVersion({
    localVersion,
    now: Date.parse("2026-08-08T02:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return githubResponse({
        tag_name: "v1.2.0",
        target_commitish: "main",
        html_url: "https://github.com/1Beyond1/flowtwin-demo/releases/tag/v1.2.0",
        published_at: "2026-08-07T00:00:00Z"
      });
    }
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /releases\/latest$/);
  assert.equal(Object.hasOwn(calls[0].options.headers, "Authorization"), false);
  assert.equal(result.checked, true);
  assert.equal(result.status, "update-available");
  assert.equal(result.updateAvailable, true);
  assert.equal(result.checkSource, "github-release");
  assert.equal(result.remoteVersion, "1.2.0");
  assert.equal(result.remote.type, "release");
});

test("when there is no release, main commit is compared", async () => {
  const calls = [];
  const result = await checkGitHubVersion({
    localVersion,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return calls.length === 1
        ? githubResponse(null, 404)
        : githubResponse({
          sha: "0123456789abcdef0123456789abcdef01234567",
          html_url: "https://github.com/1Beyond1/flowtwin-demo/commit/0123456789abcdef0123456789abcdef01234567"
        });
    }
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /releases\/latest$/);
  assert.match(calls[1], /commits\/main$/);
  assert.equal(result.checked, true);
  assert.equal(result.status, "up-to-date");
  assert.equal(result.updateAvailable, false);
  assert.equal(result.checkSource, "github-main");
  assert.equal(result.remoteCommit, localVersion.commit);
});

test("GitHub timeout degrades to unknown, never to an old-version result", async () => {
  const result = await checkGitHubVersion({
    localVersion,
    fetchImpl: async () => {
      throw Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    }
  });
  assert.equal(result.checked, false);
  assert.equal(result.status, "unavailable");
  assert.equal(result.updateAvailable, null);
  assert.equal(result.isLatest, null);
  assert.equal(result.reason, "GITHUB_TIMEOUT");
});

test("GitHub rate limits are explicit and do not trigger a false update result", async () => {
  let calls = 0;
  const result = await checkGitHubVersion({
    localVersion,
    fetchImpl: async () => {
      calls += 1;
      return githubResponse({ message: "API rate limit exceeded" }, 403);
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.checked, false);
  assert.equal(result.status, "unavailable");
  assert.equal(result.updateAvailable, null);
  assert.equal(result.reason, "GITHUB_RATE_LIMITED");
});

test("version checks cache successful and degraded results for fifteen minutes", async () => {
  let now = Date.parse("2026-08-08T03:00:00.000Z");
  let calls = 0;
  const checker = createVersionChecker({
    localVersion,
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return githubResponse({ tag_name: "v1.1.0", html_url: "https://github.com/1Beyond1/flowtwin-demo/releases/tag/v1.1.0" });
    }
  });

  const first = await checker.check();
  const second = await checker.check();
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);

  now += 15 * 60 * 1000 + 1;
  const third = await checker.check();
  assert.equal(third.cached, false);
  assert.equal(calls, 2);
});

test("version routes expose metadata and keep update checks behind an explicit GET route", async () => {
  let checkCalls = 0;
  const checked = { ...localVersion, checked: true, status: "up-to-date", updateAvailable: false };
  const metadataRoute = await resolveVersionRoute({
    method: "GET",
    pathname: "/api/version",
    versionInfo: localVersion,
    checkVersion: async () => {
      checkCalls += 1;
      return checked;
    }
  });
  assert.equal(metadataRoute.status, 200);
  assert.equal(metadataRoute.body.version, "1.1.0");
  assert.equal(checkCalls, 0);

  const checkRoute = await resolveVersionRoute({
    method: "GET",
    pathname: "/api/version/check",
    versionInfo: localVersion,
    checkVersion: async () => {
      checkCalls += 1;
      return checked;
    }
  });
  assert.equal(checkRoute.status, 200);
  assert.equal(checkRoute.body.status, "up-to-date");
  assert.equal(checkCalls, 1);

  const methodRoute = await resolveVersionRoute({
    method: "POST",
    pathname: "/api/version/check",
    versionInfo: localVersion,
    checkVersion: async () => checked
  });
  assert.equal(methodRoute.status, 405);
  assert.equal(await resolveVersionRoute({ pathname: "/api/other", versionInfo: localVersion }), null);
});
