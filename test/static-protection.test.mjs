import test from "node:test";
import assert from "node:assert/strict";
import { isBlockedStaticRequest } from "../server.mjs";

test("static serving keeps internal code, runtime data, and configuration private", () => {
  for (const path of [
    "config.local.js",
    "config.local.js.bak-20260816",
    ".env",
    ".env.production",
    "runtime/enterprise-demand-prior.json",
    "data/raw-orders.csv",
    "cv-service/app.py",
    "lib/forecast.mjs",
    "test/backend.test.mjs",
    "docs/算法与数据边界.md",
    "node_modules/pkg/index.js",
    "cv-service\\app.py",
    "../config.local.js"
  ]) assert.equal(isBlockedStaticRequest(path), true, path);

  for (const path of ["index.html", "app.js", "assets/vision/default-camera-scene.png", "images/demo.png"]) {
    assert.equal(isBlockedStaticRequest(path), false, path);
  }
});
