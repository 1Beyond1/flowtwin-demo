import test from "node:test";
import assert from "node:assert/strict";
import { buildSyntheticVisionResult, buildUploadFallback, VISION_MAX_IMAGE_BYTES, validateVisionResult, visionHealthSummary } from "../lib/cv.mjs";

test("synthetic vision result is deterministic and exposes the business chain", () => {
  const first = buildSyntheticVisionResult({ seed: "test-seed", observedAt: "2026-08-10T00:00:00.000Z" });
  const second = buildSyntheticVisionResult({ seed: "test-seed", observedAt: "2026-08-10T00:00:00.000Z" });
  assert.deepEqual(first, second);
  assert.equal(first.mode, "synthetic");
  assert.equal(first.vehicles.length, 3);
  assert.equal(first.parking.length, 6);
  assert.equal(first.arrivalRecognition.status, "recognized");
  assert.equal(first.paymentReceipt.status, "simulated");
  assert.match(first.dataBoundary, /合成/);
  assert.match(first.annotatedImage, /^data:image\/svg\+xml/);
});

test("upload fallback validates size and never claims a recognition result", () => {
  const onePixel = "data:image/png;base64,iVBORw0KGgo=";
  const result = buildUploadFallback({ imageData: onePixel, fileName: "scene.png" });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "upload-fallback");
  assert.equal(result.arrivalRecognition.status, "not-run");
  assert.equal(result.paymentReceipt.status, "not-run");
  assert.match(result.dataBoundary, /未完成视觉推理/);

  const tooLarge = `data:image/png;base64,${"A".repeat(Math.ceil(VISION_MAX_IMAGE_BYTES * 4 / 3) + 10)}`;
  assert.equal(buildUploadFallback({ imageData: tooLarge }).error, "IMAGE_TOO_LARGE");
});

test("vision health only reports optional service configuration", () => {
  assert.deepEqual(visionHealthSummary({}), {
    configured: false,
    service: "not-configured",
    fallback: "synthetic-demo",
    modelRuntime: "optional; no model weight is bundled"
  });
  assert.equal(visionHealthSummary({ cvServiceUrl: "http://127.0.0.1:5099" }).configured, true);
});

test("vision upstream validation rejects a partial success payload", () => {
  const valid = buildSyntheticVisionResult({ seed: "schema-test", observedAt: "2026-08-10T00:00:00.000Z" });
  assert.equal(validateVisionResult(valid), true);
  assert.equal(validateVisionResult({ ok: true, mode: "synthetic", source: "fake" }), false);
  assert.equal(validateVisionResult({
    ...valid,
    paymentReceipt: { status: "simulated", message: 123 }
  }), false);
  assert.equal(validateVisionResult({
    ...valid,
    dataBoundary: ""
  }), false);
});
