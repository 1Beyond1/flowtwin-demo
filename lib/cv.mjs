import { Buffer } from "node:buffer";

// The visual module is deliberately contract-first.  A model runtime is an
// optional adapter; the core Demo must still be runnable on a CPU-only VPS.
export const VISION_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const VISION_MAX_VIDEO_BYTES = 24 * 1024 * 1024;

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/i;
const VIDEO_DATA_URL = /^data:video\/(mp4|webm|quicktime|x-matroska);base64,([A-Za-z0-9+/=]+)$/i;
export const DEFAULT_SYNTHETIC_SCENE_IMAGE = "/assets/vision/default-camera-scene.png";

function hashSeed(value) {
  let hash = 2166136261;
  for (const character of String(value || "flowtwin-vision")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seeded(seed) {
  let state = hashSeed(seed) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function createSyntheticParking(random) {
  return Array.from({ length: 6 }, (_, index) => ({
    id: `P-${String(index + 1).padStart(2, "0")}`,
    status: index === 1 || index === 4 ? "occupied" : "idle",
    confidence: Number((0.91 + random() * 0.07).toFixed(3)),
    source: "synthetic"
  }));
}

export function buildSyntheticVisionResult({ seed = "flowtwin-vision-01", observedAt = new Date().toISOString() } = {}) {
  const random = seeded(seed);
  const parking = createSyntheticParking(random);
  const vehicles = [
    { id: "vehicle-01", bbox: [122, 222, 100, 70], plate: "虚构·FT2026", confidence: Number((0.92 + random() * 0.06).toFixed(3)), source: "synthetic" },
    { id: "vehicle-02", bbox: [512, 222, 100, 70], plate: "虚构·FT2036", confidence: Number((0.9 + random() * 0.07).toFixed(3)), source: "synthetic" },
    { id: "vehicle-03", bbox: [312, 387, 100, 70], plate: "虚构·FT2046", confidence: Number((0.89 + random() * 0.08).toFixed(3)), source: "synthetic" }
  ];
  const queueVehicles = 2;
  const recognitionConfidence = Number((vehicles[0].confidence * 0.62 + 0.38 * 0.96).toFixed(3));
  return {
    ok: true,
    mode: "synthetic",
    inferenceStatus: "synthetic",
    source: "FlowTwin 默认模拟摄像头画面",
    engine: "合成演示适配器",
    observedAt,
    processingMs: 18,
    input: { kind: "built-in-synthetic", seed, sceneImage: DEFAULT_SYNTHETIC_SCENE_IMAGE },
    capabilities: {
      plateOcr: "synthetic",
      vehicleDetection: "synthetic",
      parkingDetection: "synthetic",
      payment: "simulated"
    },
    vehicles,
    parking,
    queueVehicles,
    arrivalRecognition: {
      status: "recognized",
      plate: vehicles[0].plate,
      confidence: recognitionConfidence,
      event: "到站识别（演示）",
      source: "synthetic"
    },
    paymentReceipt: {
      status: "simulated",
      receiptId: `DEMO-${hashSeed(seed).toString(16).toUpperCase()}`,
      amount: null,
      message: "仅生成演示收据，不执行真实扣款",
      source: "synthetic"
    },
    confidence: recognitionConfidence,
    evidence: [
      "画面是项目内置的 AI 生成模拟摄像头样板图，不是企业真实监控画面",
      "车辆、车位和到站状态仍由固定随机种子生成，仅用于演示状态流转",
      "支付结果是模拟收据，不会访问支付渠道"
    ],
    dataBoundary: "默认模拟画面和固定种子结果，不代表能链实时站内数据",
    annotatedImage: DEFAULT_SYNTHETIC_SCENE_IMAGE
  };
}

function parseImageDataUrl(value) {
  const match = String(value || "").match(IMAGE_DATA_URL);
  if (!match) return { error: "IMAGE_DATA_URL_REQUIRED" };
  let bytes;
  try { bytes = Buffer.from(match[2], "base64"); } catch { return { error: "IMAGE_BASE64_INVALID" }; }
  if (!bytes.length) return { error: "IMAGE_EMPTY" };
  if (bytes.length > VISION_MAX_IMAGE_BYTES) return { error: "IMAGE_TOO_LARGE", maxBytes: VISION_MAX_IMAGE_BYTES };
  const mimeType = `image/${match[1].toLowerCase() === "jpg" ? "jpeg" : match[1].toLowerCase()}`;
  const hasSignature = mimeType === "image/png"
    ? bytes.length >= 8 && Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).equals(bytes.subarray(0, 8))
    : mimeType === "image/jpeg"
      ? bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
      : bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!hasSignature) return { error: "IMAGE_CONTENT_INVALID", mimeType };
  return { mimeType, bytes };
}

function parseVideoDataUrl(value) {
  const match = String(value || "").match(VIDEO_DATA_URL);
  if (!match) return { error: "VIDEO_DATA_URL_REQUIRED" };
  let bytes;
  try { bytes = Buffer.from(match[2], "base64"); } catch { return { error: "VIDEO_BASE64_INVALID" }; }
  if (!bytes.length) return { error: "VIDEO_EMPTY" };
  if (bytes.length > VISION_MAX_VIDEO_BYTES) return { error: "VIDEO_TOO_LARGE", maxBytes: VISION_MAX_VIDEO_BYTES };
  const subtype = match[1].toLowerCase();
  const mimeType = `video/${subtype}`;
  const header = bytes.subarray(0, 64);
  const hasSignature = (subtype === "mp4" || subtype === "quicktime")
    ? header.includes(Buffer.from("ftyp"))
    : bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!hasSignature) return { error: "VIDEO_CONTENT_INVALID", mimeType };
  return { mimeType, bytes };
}

export function buildUploadFallback({ imageData, fileName = "上传图片" } = {}) {
  const parsed = parseImageDataUrl(imageData);
  if (parsed.error) return { ok: false, error: parsed.error, maxBytes: parsed.maxBytes };
  return {
    ok: true,
    mode: "upload-fallback",
    inferenceStatus: "not-run",
    source: "本地上传 · 未启用视觉推理模型",
    engine: "安全降级适配器",
    observedAt: new Date().toISOString(),
    processingMs: 1,
    input: { kind: "uploaded-image", fileName: String(fileName).slice(0, 120), bytes: parsed.bytes.length, mimeType: parsed.mimeType },
    capabilities: {
      plateOcr: "not-run",
      vehicleDetection: "not-run",
      parkingDetection: "not-run",
      payment: "not-run"
    },
    vehicles: [],
    parking: [],
    queueVehicles: null,
    arrivalRecognition: { status: "not-run", plate: null, confidence: null, event: "未执行", source: "fallback" },
    paymentReceipt: { status: "not-run", receiptId: null, amount: null, message: "未执行任何支付动作", source: "fallback" },
    confidence: null,
    evidence: ["当前运行环境未配置 OpenCV/Paddle 推理服务", "未保存或上传原始图片", "本次不会输出车牌号或其他视觉识别结论"],
    dataBoundary: "上传图片未完成视觉推理，不能把本结果当作识别结论"
  };
}

export function buildVideoFallback({ videoData, fileName = "上传视频" } = {}) {
  const parsed = parseVideoDataUrl(videoData);
  if (parsed.error) return { ok: false, error: parsed.error, maxBytes: parsed.maxBytes };
  return {
    ok: true,
    mode: "video-fallback",
    inferenceStatus: "not-run",
    source: "本地上传 · 未启用视频视觉推理",
    engine: "安全降级适配器",
    observedAt: new Date().toISOString(),
    processingMs: 1,
    input: { kind: "uploaded-video", fileName: String(fileName).slice(0, 120), bytes: parsed.bytes.length, mimeType: parsed.mimeType },
    video: { maxDurationSec: 15, sampleFps: 2 },
    capabilities: { plateOcr: "not-run", vehicleDetection: "not-run", parkingDetection: "not-run", payment: "not-run" },
    vehicles: [],
    parking: [],
    queueVehicles: null,
    arrivalRecognition: { status: "not-run", plate: null, confidence: null, event: "未执行", source: "fallback" },
    paymentReceipt: { status: "not-run", receiptId: null, amount: null, message: "未执行任何支付动作", source: "fallback" },
    confidence: null,
    evidence: ["视频格式已通过校验，但当前环境未配置本地视频视觉推理服务", "未返回车牌号或支付结果"],
    dataBoundary: "上传视频未完成视觉推理，不能把本结果当作识别结论"
  };
}

export function validateVisionResult(value) {
  if (!value || typeof value !== "object" || value.ok !== true) return false;
  if (typeof value.mode !== "string" || !value.mode.trim()) return false;
  if (typeof value.source !== "string" || !value.source.trim()) return false;
  if (!Array.isArray(value.vehicles) || !Array.isArray(value.parking)) return false;
  if (!value.arrivalRecognition || typeof value.arrivalRecognition !== "object"
    || typeof value.arrivalRecognition.status !== "string") return false;
  if (!value.paymentReceipt || typeof value.paymentReceipt !== "object"
    || typeof value.paymentReceipt.status !== "string"
    || typeof value.paymentReceipt.message !== "string") return false;
  if (typeof value.dataBoundary !== "string" || !value.dataBoundary.trim()) return false;
  if (value.inferenceStatus !== undefined
    && !["synthetic", "executed", "error", "not-run"].includes(String(value.inferenceStatus))) return false;
  if (value.evidence !== undefined && !Array.isArray(value.evidence)) return false;
  if (value.confidence !== null && value.confidence !== undefined
    && !(typeof value.confidence === "string"
      || (Number.isFinite(Number(value.confidence)) && Number(value.confidence) >= 0 && Number(value.confidence) <= 1))) return false;
  const recognitionStatus = String(value.arrivalRecognition.status || "").toLowerCase();
  const plate = value.arrivalRecognition.plate;
  if (recognitionStatus === "recognized" && (typeof plate !== "string" || !plate.trim())) return false;
  if (["unrecognized", "unavailable", "error", "not-run"].includes(recognitionStatus) && plate != null) return false;
  if (value.inferenceStatus === "executed" && !["local-ocr", "local-ocr-error", "local-ocr-unavailable", "local-video-ocr"].includes(value.mode)) return false;
  if (value.inferenceStatus === "synthetic" && value.mode !== "synthetic") return false;
  return true;
}

export function visionHealthSummary(config = {}) {
  return {
    configured: Boolean(config.cvServiceUrl),
    service: config.cvServiceUrl ? "optional-local-service" : "not-configured",
    fallback: "safe-not-run",
    modelRuntime: "optional; no model weight is bundled"
  };
}

export function localVisionFallback(body = {}) {
  const mode = String(body.mode || "").trim().toLowerCase();
  if (mode === "video") return buildVideoFallback(body);
  if (mode === "upload") return buildUploadFallback(body);
  if (mode === "sample" && body.imageData) return buildUploadFallback(body);
  return {
    ok: false,
    error: mode === "sample" ? "SAMPLE_IMAGE_REQUIRED" : "VISION_MODE_REQUIRED",
    message: "视觉分析必须提交图片或视频；不会在缺少输入时生成虚构识别结果"
  };
}
