import { Buffer } from "node:buffer";

// The visual module is deliberately contract-first.  A model runtime is an
// optional adapter; the core Demo must still be runnable on a CPU-only VPS.
export const VISION_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/i;

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

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
  }[character]));
}

function svgDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function syntheticSvg(vehicles, parking) {
  const slots = parking.map((slot, index) => {
    const x = 72 + (index % 4) * 196;
    const y = index < 4 ? 190 : 355;
    const fill = slot.status === "occupied" ? "#dbe7ff" : "#e5f5ef";
    const stroke = slot.status === "occupied" ? "#4a7df0" : "#178f7e";
    return `<g><rect x="${x}" y="${y}" width="152" height="112" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="3" stroke-dasharray="8 6"/><text x="${x + 12}" y="${y + 27}" fill="#596163" font-size="15" font-family="Arial, sans-serif">${escapeXml(slot.id)} · ${slot.status === "occupied" ? "占用" : "空闲"}</text></g>`;
  }).join("");
  const cars = vehicles.map((vehicle) => {
    const [x, y, width, height] = vehicle.bbox;
    return `<g><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="13" fill="#202729" stroke="#ffffff" stroke-width="4"/><rect x="${x + 14}" y="${y + 18}" width="${width - 28}" height="${height * 0.26}" rx="5" fill="#b8c7cc" opacity=".88"/><rect x="${x + width * .33}" y="${y + height - 20}" width="${width * .34}" height="10" rx="3" fill="#ffffff"/><rect x="${x + 8}" y="${y - 27}" width="${Math.min(164, width + 80)}" height="22" rx="11" fill="#ffffff" stroke="#4a7df0" stroke-width="2"/><text x="${x + 18}" y="${y - 12}" fill="#1b2425" font-size="13" font-family="Arial, sans-serif">${escapeXml(vehicle.plate)} · ${(vehicle.confidence * 100).toFixed(0)}%</text></g>`;
  }).join("");
  return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#f2f5f2"/><path d="M0 126H960M0 320H960M0 492H960" stroke="#d3ded9" stroke-width="2"/><path d="M40 0V540M240 0V540M480 0V540M720 0V540M920 0V540" stroke="#dfe7e2" stroke-width="1"/><rect x="26" y="26" width="908" height="72" rx="16" fill="#ffffff" opacity=".96"/><text x="52" y="57" fill="#1b2425" font-size="22" font-weight="700" font-family="Arial, sans-serif">FlowTwin · 站内到站识别演示</text><text x="52" y="82" fill="#667170" font-size="13" font-family="Arial, sans-serif">合成站内画面 / 不接入真实摄像头 / 不执行真实扣款</text>${slots}${cars}<rect x="680" y="438" width="238" height="58" rx="12" fill="#ffffff" stroke="#d2ddd8"/><text x="700" y="463" fill="#178f7e" font-size="14" font-weight="700" font-family="Arial, sans-serif">到站事件已识别</text><text x="700" y="484" fill="#667170" font-size="12" font-family="Arial, sans-serif">车牌：虚构演示 · FT2026</text></svg>`);
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
    source: "FlowTwin 合成站内画面",
    engine: "合成演示适配器",
    observedAt,
    processingMs: 18,
    input: { kind: "built-in-synthetic", seed },
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
      "车辆框、车位状态和车牌均来自固定种子合成画面",
      "到站识别仅用于演示状态流转，不接入真实摄像头",
      "支付结果是模拟收据，不会访问支付渠道"
    ],
    dataBoundary: "合成演示结果，不代表能链实时站内数据",
    annotatedImage: syntheticSvg(vehicles, parking)
  };
}

function parseImageDataUrl(value) {
  const match = String(value || "").match(IMAGE_DATA_URL);
  if (!match) return { error: "IMAGE_DATA_URL_REQUIRED" };
  let bytes;
  try { bytes = Buffer.from(match[2], "base64"); } catch { return { error: "IMAGE_BASE64_INVALID" }; }
  if (!bytes.length) return { error: "IMAGE_EMPTY" };
  if (bytes.length > VISION_MAX_IMAGE_BYTES) return { error: "IMAGE_TOO_LARGE", maxBytes: VISION_MAX_IMAGE_BYTES };
  return { mimeType: `image/${match[1].toLowerCase() === "jpg" ? "jpeg" : match[1].toLowerCase()}`, bytes };
}

export function buildUploadFallback({ imageData, fileName = "上传图片" } = {}) {
  const parsed = parseImageDataUrl(imageData);
  if (parsed.error) return { ok: false, error: parsed.error, maxBytes: parsed.maxBytes };
  return {
    ok: true,
    mode: "upload-fallback",
    source: "本地上传 · 未启用视觉推理模型",
    engine: "安全降级适配器",
    observedAt: new Date().toISOString(),
    processingMs: 1,
    input: { kind: "uploaded-image", fileName: String(fileName).slice(0, 120), bytes: parsed.bytes.length, mimeType: parsed.mimeType },
    vehicles: [],
    parking: [],
    queueVehicles: null,
    arrivalRecognition: { status: "not-run", plate: null, confidence: null, event: "未执行", source: "fallback" },
    paymentReceipt: { status: "not-run", receiptId: null, amount: null, message: "未执行任何支付动作", source: "fallback" },
    confidence: null,
    evidence: ["当前运行环境未配置 OpenCV/Paddle 推理服务", "未保存或上传原始图片", "请使用内置合成画面查看完整演示"],
    dataBoundary: "上传图片未完成视觉推理，不能把本结果当作识别结论",
    previewImage: `data:${parsed.mimeType};base64,${parsed.bytes.toString("base64")}`
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
  if (value.evidence !== undefined && !Array.isArray(value.evidence)) return false;
  if (value.confidence !== null && value.confidence !== undefined
    && !(typeof value.confidence === "string"
      || (Number.isFinite(Number(value.confidence)) && Number(value.confidence) >= 0 && Number(value.confidence) <= 1))) return false;
  return true;
}

export function visionHealthSummary(config = {}) {
  return {
    configured: Boolean(config.cvServiceUrl),
    service: config.cvServiceUrl ? "optional-local-service" : "not-configured",
    fallback: "synthetic-demo",
    modelRuntime: "optional; no model weight is bundled"
  };
}

export function localVisionFallback(body = {}) {
  if (String(body.mode || "sample") === "upload") return buildUploadFallback(body);
  return buildSyntheticVisionResult({ seed: String(body.seed || "flowtwin-vision-01") });
}
