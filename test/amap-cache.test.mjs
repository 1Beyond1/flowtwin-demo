import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AMAP_CACHE_TTLS, createAmapFileCache } from "../lib/amap-cache.mjs";

async function tempRoot() {
  return mkdtemp(join(tmpdir(), "flowtwin-amap-cache-"));
}

test("AMap file cache writes a normalized value and serves a fresh hit", async () => {
  const root = await tempRoot();
  let now = 1_700_000_000_000;
  const cache = createAmapFileCache({ root, now: () => now });
  let calls = 0;
  const first = await cache.getOrLoad("route", "same-route", async () => {
    calls += 1;
    return { distance: 42, path: [[116.1, 39.9]] };
  }, { ttlMs: 10_000 });
  const second = await cache.getOrLoad("route", "same-route", async () => {
    calls += 1;
    return { distance: 99 };
  }, { ttlMs: 10_000 });

  assert.equal(calls, 1);
  assert.equal(first.cache.state, "miss");
  assert.equal(second.cache.state, "hit");
  assert.equal(second.value.distance, 42);
  const files = await (await import("node:fs/promises")).readdir(join(root, "runtime", "cache", "amap"));
  assert.equal(files.length, 1);
  assert.match(await readFile(join(root, "runtime", "cache", "amap", files[0]), "utf8"), /"schema":1/);
  assert.doesNotMatch(await readFile(join(root, "runtime", "cache", "amap", files[0]), "utf8"), /key|token|secret/i);
  assert.equal(AMAP_CACHE_TTLS.route, 60 * 60 * 1000);
});

test("concurrent identical AMap loads are deduplicated", async () => {
  const root = await tempRoot();
  const cache = createAmapFileCache({ root });
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return ["same"];
  };
  const results = await Promise.all([
    cache.getOrLoad("poi", "same-poi", loader),
    cache.getOrLoad("poi", "same-poi", loader),
    cache.getOrLoad("poi", "same-poi", loader)
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((result) => result.value), [["same"], ["same"], ["same"]]);
});

test("expired cache is used only as a labelled stale fallback after upstream failure", async () => {
  const root = await tempRoot();
  let now = 1_700_000_000_000;
  const cache = createAmapFileCache({ root, now: () => now });
  await cache.getOrLoad("geocode", "东方明珠", async () => ({ location: "121.499", name: "东方明珠" }), { ttlMs: 100 });
  now += 101;
  const stale = await cache.getOrLoad("geocode", "东方明珠", async () => {
    throw new Error("upstream down");
  }, { ttlMs: 100, staleIfErrorMs: 1_000 });
  assert.equal(stale.cache.state, "stale");
  assert.equal(stale.value.name, "东方明珠");
  assert.equal(stale.upstreamError.message, "upstream down");
});

test("cache does not hide an upstream failure when the stale window is over", async () => {
  const root = await tempRoot();
  let now = 1_700_000_000_000;
  const cache = createAmapFileCache({ root, now: () => now });
  await cache.getOrLoad("place", "南京", async () => ["old"], { ttlMs: 100 });
  now += 2_000;
  await assert.rejects(
    cache.getOrLoad("place", "南京", async () => { throw new Error("upstream down"); }, { ttlMs: 100, staleIfErrorMs: 100 }),
    /upstream down/
  );
});
