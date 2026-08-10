import test from "node:test";
import assert from "node:assert/strict";
import { buildSyntheticVisionResult, buildUploadFallback, buildVideoFallback, DEFAULT_SYNTHETIC_SCENE_IMAGE, VISION_MAX_IMAGE_BYTES, VISION_MAX_VIDEO_BYTES, localVisionFallback, validateVisionResult, visionHealthSummary } from "../lib/cv.mjs";

test("synthetic vision result is deterministic and exposes the business chain", () => {
  const first = buildSyntheticVisionResult({ seed: "test-seed", observedAt: "2026-08-10T00:00:00.000Z" });
  const second = buildSyntheticVisionResult({ seed: "test-seed", observedAt: "2026-08-10T00:00:00.000Z" });
  assert.deepEqual(first, second);
  assert.equal(first.mode, "synthetic");
  assert.equal(first.inferenceStatus, "synthetic");
  assert.equal(first.vehicles.length, 3);
  assert.equal(first.parking.length, 6);
  assert.equal(first.arrivalRecognition.status, "recognized");
  assert.equal(first.paymentReceipt.status, "simulated");
  assert.equal(first.capabilities.plateOcr, "synthetic");
  assert.equal(first.capabilities.payment, "simulated");
  assert.match(first.dataBoundary, /模拟/);
  assert.equal(first.annotatedImage, DEFAULT_SYNTHETIC_SCENE_IMAGE);
  assert.equal(first.input.sceneImage, DEFAULT_SYNTHETIC_SCENE_IMAGE);
  assert.match(first.dataBoundary, /默认模拟画面/);
});

test("upload fallback validates size and never claims a recognition result", () => {
  const onePixel = "data:image/png;base64,iVBORw0KGgo=";
  const result = buildUploadFallback({ imageData: onePixel, fileName: "scene.png" });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "upload-fallback");
  assert.equal(result.inferenceStatus, "not-run");
  assert.equal(result.arrivalRecognition.status, "not-run");
  assert.equal(result.paymentReceipt.status, "not-run");
  assert.equal(result.capabilities.plateOcr, "not-run");
  assert.match(result.dataBoundary, /未完成视觉推理/);

  const tooLarge = `data:image/png;base64,${"A".repeat(Math.ceil(VISION_MAX_IMAGE_BYTES * 4 / 3) + 10)}`;
  assert.equal(buildUploadFallback({ imageData: tooLarge }).error, "IMAGE_TOO_LARGE");
  assert.equal(buildUploadFallback({ imageData: "data:image/png;base64,AA==" }).error, "IMAGE_CONTENT_INVALID");
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  assert.equal(buildUploadFallback({ imageData: `data:image/jpeg;base64,${jpegHeader}` }).ok, true);
});

test("video fallback validates a bounded container and never claims recognition", () => {
  const mp4Header = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).toString("base64");
  const result = buildVideoFallback({ videoData: `data:video/mp4;base64,${mp4Header}`, fileName: "gate.mp4" });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "video-fallback");
  assert.equal(result.input.kind, "uploaded-video");
  assert.equal(result.arrivalRecognition.status, "not-run");
  assert.equal(result.capabilities.plateOcr, "not-run");
  assert.match(result.dataBoundary, /不能把本结果当作识别结论/);
  const tooLarge = `data:video/mp4;base64,${"A".repeat(Math.ceil(VISION_MAX_VIDEO_BYTES * 4 / 3) + 10)}`;
  assert.equal(buildVideoFallback({ videoData: tooLarge }).error, "VIDEO_TOO_LARGE");
  assert.equal(buildVideoFallback({ videoData: "data:video/mp4;base64,AA==" }).error, "VIDEO_CONTENT_INVALID");
});

test("vision health only reports optional service configuration", () => {
  assert.deepEqual(visionHealthSummary({}), {
    configured: false,
    service: "not-configured",
    fallback: "safe-not-run",
    modelRuntime: "optional; no model weight is bundled"
  });
  assert.equal(visionHealthSummary({ cvServiceUrl: "http://127.0.0.1:5099" }).configured, true);
});

test("vision input never fabricates a sample result without media", () => {
  const missing = localVisionFallback({ mode: "sample", seed: "test-seed" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "SAMPLE_IMAGE_REQUIRED");
  const uploadFallback = localVisionFallback({ mode: "sample", imageData: "data:image/png;base64,iVBORw0KGgo=" });
  assert.equal(uploadFallback.ok, true);
  assert.equal(uploadFallback.inferenceStatus, "not-run");
  assert.equal(uploadFallback.arrivalRecognition.plate, null);
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
  assert.equal(validateVisionResult({ ...valid, inferenceStatus: "not-run" }), true);
  assert.equal(validateVisionResult({ ...valid, inferenceStatus: "error" }), true);
  assert.equal(validateVisionResult({ ...valid, inferenceStatus: "made-up" }), false);
  assert.equal(validateVisionResult({
    ...valid,
    inferenceStatus: "executed",
    mode: "local-ocr",
    arrivalRecognition: { status: "recognized", plate: "京A12345" }
  }), true);
  assert.equal(validateVisionResult({
    ...valid,
    inferenceStatus: "executed",
    mode: "local-ocr",
    arrivalRecognition: { status: "unrecognized", plate: "京A12345" }
  }), false);
  assert.equal(validateVisionResult({
    ...valid,
    inferenceStatus: "executed",
    mode: "local-video-ocr",
    arrivalRecognition: { status: "recognized", plate: "京A12345" }
  }), true);
});
