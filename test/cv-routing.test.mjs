import test from "node:test";
import assert from "node:assert/strict";
import { buildSyntheticVisionResult, validateVisionResult } from "../lib/cv.mjs";
import { isCompletedVisionInference, isRetryableVisionStatus, isTransientVisionResult } from "../server.mjs";

test("CV routing only treats completed inference as a successful upstream response", () => {
  const synthetic = buildSyntheticVisionResult({ seed: "cv-routing", observedAt: "2026-08-15T00:00:00.000Z" });
  assert.equal(validateVisionResult(synthetic), true);
  assert.equal(isCompletedVisionInference(synthetic), true);

  const unavailable = {
    ...synthetic,
    mode: "local-ocr-unavailable",
    inferenceStatus: "not-run",
    arrivalRecognition: { status: "unavailable", plate: null, confidence: null },
    paymentReceipt: { status: "not-run", receiptId: null, amount: null, message: "未执行任何支付动作", source: "fallback" }
  };
  assert.equal(validateVisionResult(unavailable), true);
  assert.equal(isCompletedVisionInference(unavailable), false);
  assert.equal(isTransientVisionResult(unavailable), true);

  const transientError = { ...unavailable, mode: "local-ocr-error", inferenceStatus: "error" };
  assert.equal(validateVisionResult(transientError), true);
  assert.equal(isTransientVisionResult(transientError), true);
});

test("CV retry statuses are limited to transient upstream failures", () => {
  assert.equal(isRetryableVisionStatus(429), true);
  assert.equal(isRetryableVisionStatus(503), true);
  assert.equal(isRetryableVisionStatus(400), false);
  assert.equal(isRetryableVisionStatus(500), false);
});
