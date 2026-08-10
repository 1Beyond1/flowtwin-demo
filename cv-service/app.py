"""Optional local CPU vision adapter for FlowTwin.

The production-facing path is deliberately local: uploaded images are decoded
in memory, passed to a single PaddleOCR CPU instance, and discarded after the
request.  The Node demo can still run without this optional process and keeps
its clearly labelled synthetic mode as a fallback.

This adapter currently promises one real capability only: OCR for a clear
license-plate image.  Vehicle detection, parking-space detection and payment
are not inferred from an OCR result and remain explicitly unexecuted.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import os
import re
import threading
import time
from io import BytesIO
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable

MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_IMAGE_SIDE = max(640, min(int(os.environ.get("CV_MAX_IMAGE_SIDE", "1600")), 2400))
OCR_WAIT_SECONDS = max(1.0, min(float(os.environ.get("CV_OCR_WAIT_SECONDS", "30")), 120.0))
OCR_CONCURRENCY = 1
IMAGE_RE = re.compile(r"^data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$", re.I)
PLATE_RE = re.compile(
    r"([京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼港澳台][A-Z][A-Z0-9]{5,6})"
)
PLATE_PREFIXES = set("京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼港澳台")

try:  # Optional. The adapter remains importable without CV dependencies.
    import cv2  # type: ignore
except Exception:  # pragma: no cover - environment dependent
    cv2 = None

try:
    import numpy as np  # type: ignore
except Exception:  # pragma: no cover - environment dependent
    np = None

try:
    from PIL import Image  # type: ignore
except Exception:  # pragma: no cover - environment dependent
    Image = None

try:
    import paddle  # type: ignore
except Exception:  # pragma: no cover - environment dependent
    paddle = None

try:
    import paddleocr  # type: ignore
except Exception:  # pragma: no cover - environment dependent
    paddleocr = None


class OcrBusyError(ValueError):
    """Raised when the bounded local OCR slot is occupied."""


_OCR_ENGINE: Any = None
_OCR_ENGINE_LABEL = ""
_OCR_INIT_ERROR = ""
_OCR_INIT_LOCK = threading.Lock()
_OCR_RUN_LOCK = threading.BoundedSemaphore(OCR_CONCURRENCY)


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _configured_model_dirs() -> tuple[str, str]:
    det = os.environ.get("PADDLEOCR_TEXT_DET_MODEL_DIR", "").strip()
    rec = os.environ.get("PADDLEOCR_TEXT_REC_MODEL_DIR", "").strip()
    return det, rec


def _local_model_dirs_ready() -> bool:
    det, rec = _configured_model_dirs()
    return bool(det and rec and Path(det).is_dir() and Path(rec).is_dir())


def runtime_summary() -> dict[str, Any]:
    det_dir, rec_dir = _configured_model_dirs()
    return {
        "opencv": cv2 is not None,
        "pillow": Image is not None,
        "numpy": np is not None,
        "paddle": paddle is not None,
        "paddleocr": paddleocr is not None,
        "ocrEngine": "PaddleOCR",
        "ocrAvailable": paddleocr is not None and np is not None and (cv2 is not None or Image is not None),
        "ocrLoaded": _OCR_ENGINE is not None,
        "localModelDirsConfigured": bool(det_dir and rec_dir),
        "localModelDirsReady": _local_model_dirs_ready(),
        "modelWeightsBundled": False,
        "device": "cpu",
        "maxImageSide": MAX_IMAGE_SIDE,
        "ocrConcurrency": OCR_CONCURRENCY,
    }


def upload_metadata(image_data: str) -> dict[str, Any]:
    match = IMAGE_RE.match(str(image_data or ""))
    if not match:
        raise ValueError("IMAGE_DATA_URL_REQUIRED")
    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("IMAGE_BASE64_INVALID") from exc
    if not raw:
        raise ValueError("IMAGE_EMPTY")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("IMAGE_TOO_LARGE")
    mime_type = f"image/{'jpeg' if match.group(1).lower() == 'jpg' else match.group(1).lower()}"
    signature_ok = (
        mime_type == "image/png"
        and raw[:8] == b"\x89PNG\r\n\x1a\n"
    ) or (
        mime_type == "image/jpeg"
        and len(raw) >= 4
        and raw[:3] == b"\xff\xd8\xff"
        and raw[-2:] == b"\xff\xd9"
    ) or (
        mime_type == "image/webp"
        and len(raw) >= 12
        and raw[:4] == b"RIFF"
        and raw[8:12] == b"WEBP"
    )
    if not signature_ok:
        raise ValueError("IMAGE_CONTENT_INVALID")
    dimensions = None
    if Image is not None:
        try:
            with Image.open(BytesIO(raw)) as image:
                dimensions = [int(image.width), int(image.height)]
        except Exception:
            dimensions = None
    return {
        "mimeType": mime_type,
        "bytes": len(raw),
        "dimensions": dimensions,
        "sha256Prefix": hashlib.sha256(raw).hexdigest()[:12],
    }


def _decode_image(raw: bytes) -> Any:
    if np is None:
        raise RuntimeError("OCR_NUMPY_UNAVAILABLE")
    if cv2 is not None:
        image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is not None:
            return _resize_image(image)
    if Image is not None:
        try:
            with Image.open(BytesIO(raw)) as source:
                rgb = source.convert("RGB")
                if max(rgb.size) > MAX_IMAGE_SIDE:
                    scale = MAX_IMAGE_SIDE / max(rgb.size)
                    rgb = rgb.resize((max(1, round(rgb.width * scale)), max(1, round(rgb.height * scale))))
                return np.asarray(rgb)
        except Exception as exc:
            raise RuntimeError("OCR_IMAGE_DECODE_FAILED") from exc
    raise RuntimeError("OCR_IMAGE_DECODER_UNAVAILABLE")


def _resize_image(image: Any) -> Any:
    height, width = image.shape[:2]
    longest = max(int(height), int(width))
    if longest <= MAX_IMAGE_SIDE:
        return image
    scale = MAX_IMAGE_SIDE / longest
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    if cv2 is not None:
        return cv2.resize(image, size, interpolation=cv2.INTER_AREA)
    return image


def _build_ocr_engine() -> tuple[Any, str]:
    if paddleocr is None or np is None or (cv2 is None and Image is None):
        raise RuntimeError("PADDLEOCR_RUNTIME_UNAVAILABLE")
    factory = getattr(paddleocr, "PaddleOCR", None)
    if factory is None:
        raise RuntimeError("PADDLEOCR_CLASS_UNAVAILABLE")

    language = os.environ.get("PADDLEOCR_LANG", "ch").strip() or "ch"
    det_dir, rec_dir = _configured_model_dirs()
    if _env_bool("PADDLEOCR_LOCAL_ONLY", False) and not _local_model_dirs_ready():
        raise RuntimeError("PADDLEOCR_LOCAL_MODEL_DIRS_REQUIRED")

    modern = {
        "lang": language,
        "device": "cpu",
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
    }
    # The default PaddleOCR 3.x language profile is PP-OCRv6 medium. For a
    # local enterprise service, prefer the smaller PP-OCRv4 mobile pair unless
    # an operator explicitly supplies pre-staged model directories.
    if not det_dir and not rec_dir:
        modern["ocr_version"] = os.environ.get("PADDLEOCR_VERSION", "PP-OCRv4").strip() or "PP-OCRv4"
    if det_dir:
        modern["text_detection_model_dir"] = det_dir
    if rec_dir:
        modern["text_recognition_model_dir"] = rec_dir

    try:
        return factory(**modern), "PaddleOCR 本地 CPU（3.x API）"
    except TypeError:
        # PaddleOCR 2.x uses the older constructor names. Keep this fallback
        # so the adapter can be tested on a prepared enterprise image without
        # tying the project to one minor release.
        legacy = {
            "lang": language,
            "use_angle_cls": True,
            "use_gpu": False,
            "show_log": False,
        }
        if det_dir:
            legacy["det_model_dir"] = det_dir
        if rec_dir:
            legacy["rec_model_dir"] = rec_dir
        return factory(**legacy), "PaddleOCR 本地 CPU（2.x API）"


def _get_ocr_engine() -> tuple[Any, str]:
    global _OCR_ENGINE, _OCR_ENGINE_LABEL, _OCR_INIT_ERROR
    if _OCR_ENGINE is not None:
        return _OCR_ENGINE, _OCR_ENGINE_LABEL
    with _OCR_INIT_LOCK:
        if _OCR_ENGINE is not None:
            return _OCR_ENGINE, _OCR_ENGINE_LABEL
        try:
            _OCR_ENGINE, _OCR_ENGINE_LABEL = _build_ocr_engine()
            _OCR_INIT_ERROR = ""
        except Exception as exc:  # pragma: no cover - depends on local model setup
            _OCR_INIT_ERROR = str(exc).split(":", 1)[0] or "PADDLEOCR_INIT_FAILED"
            raise RuntimeError("PADDLEOCR_NOT_READY") from exc
    return _OCR_ENGINE, _OCR_ENGINE_LABEL


def _json_value(value: Any) -> Any:
    if isinstance(value, (dict, list, tuple, str, int, float, bool)) or value is None:
        if isinstance(value, str):
            try:
                return json.loads(value)
            except Exception:
                return value
        return value
    for name in ("json", "to_json"):
        try:
            candidate = getattr(value, name)
            candidate = candidate() if callable(candidate) else candidate
            if isinstance(candidate, str):
                return json.loads(candidate)
            if isinstance(candidate, (dict, list, tuple)):
                return candidate
        except Exception:
            continue
    return None


def _number(value: Any) -> float | None:
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _sequence(value: Any) -> list[Any]:
    if isinstance(value, (list, tuple)):
        return list(value)
    if np is not None and isinstance(value, np.ndarray):
        return value.tolist()
    return []


def _collect_ocr_records(node: Any, records: list[dict[str, Any]]) -> None:
    """Normalize PaddleOCR 2.x lists and 3.x result JSON into text records."""
    node = _json_value(node)
    if isinstance(node, dict):
        texts = node.get("rec_texts")
        scores = node.get("rec_scores")
        if scores is None:
            scores = node.get("rec_score")
        boxes = node.get("rec_boxes")
        if boxes is None:
            boxes = node.get("rec_polys")
        if boxes is None:
            boxes = node.get("dt_polys")
        if isinstance(texts, (list, tuple)):
            score_list = _sequence(scores)
            box_list = _sequence(boxes)
            for index, text in enumerate(texts):
                records.append({
                    "text": str(text or ""),
                    "score": _number(score_list[index]) if index < len(score_list) else None,
                    "bbox": box_list[index] if index < len(box_list) else None,
                })
        elif isinstance(node.get("text"), str):
            records.append({"text": node["text"], "score": _number(node.get("score")), "bbox": node.get("bbox")})
        for key in ("result", "results", "ocr_result", "data"):
            if key in node:
                _collect_ocr_records(node[key], records)
        return

    if isinstance(node, (list, tuple)):
        # PaddleOCR 2.x: [box, (text, score)]
        if len(node) == 2 and isinstance(node[1], (list, tuple)) and node[1]:
            text = node[1][0] if len(node[1]) > 0 else ""
            score = node[1][1] if len(node[1]) > 1 else None
            if isinstance(text, str):
                records.append({"text": text, "score": _number(score), "bbox": node[0]})
                return
        for item in node:
            _collect_ocr_records(item, records)


def _ocr_records(raw_result: Any) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    _collect_ocr_records(raw_result, records)
    deduped: list[dict[str, Any]] = []
    seen: set[tuple[str, float | None]] = set()
    for record in records:
        text = str(record.get("text") or "").strip()
        if not text:
            continue
        score = record.get("score")
        key = (text, score if isinstance(score, float) else None)
        if key in seen:
            continue
        seen.add(key)
        deduped.append({"text": text, "score": score, "bbox": record.get("bbox")})
    return deduped


def _normalize_ocr_text(value: Any) -> str:
    text = str(value or "").upper()
    text = text.replace("车牌号", "").replace("车牌", "")
    text = re.sub(r"[\s·•．。\-—_:：|丨/\\]+", "", text)
    return re.sub(r"[^京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼港澳台A-Z0-9]", "", text)


def _plate_candidates(records: Iterable[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    valid: list[dict[str, Any]] = []
    raw: list[dict[str, Any]] = []
    for record in records:
        normalized = _normalize_ocr_text(record.get("text"))
        if not normalized:
            continue
        score = record.get("score")
        raw.append({"text": normalized, "score": score})
        matches = list(PLATE_RE.finditer(normalized))
        for match in matches:
            plate = match.group(1)
            if plate[0] not in PLATE_PREFIXES:
                continue
            valid.append({"plate": plate, "score": score, "text": normalized})
    unique: dict[str, dict[str, Any]] = {}
    for item in valid:
        current = unique.get(item["plate"])
        current_score = _number(current.get("score")) if current else None
        item_score = _number(item.get("score"))
        if current is None or (item_score is not None and (current_score is None or item_score > current_score)):
            unique[item["plate"]] = item
    return list(unique.values()), raw[:8]


def _run_paddle_ocr(image: Any) -> tuple[list[dict[str, Any]], str]:
    engine, label = _get_ocr_engine()
    if not _OCR_RUN_LOCK.acquire(timeout=OCR_WAIT_SECONDS):
        raise OcrBusyError("OCR_BUSY")
    try:
        if hasattr(engine, "predict"):
            result = engine.predict(image)
        elif hasattr(engine, "ocr"):
            result = engine.ocr(image, cls=True)
        else:
            raise RuntimeError("PADDLEOCR_INFERENCE_METHOD_UNAVAILABLE")
        if not isinstance(result, (list, tuple)):
            result = list(result) if result is not None else []
        return _ocr_records(result), label
    finally:
        _OCR_RUN_LOCK.release()


def _base_upload_result(metadata: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "mode": "local-ocr",
        "inferenceStatus": "not-run",
        "source": "本地视觉服务 · PaddleOCR",
        "engine": "PaddleOCR 本地 CPU",
        "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "processingMs": 0,
        "input": {"kind": "uploaded-image", **metadata},
        "capabilities": {
            "plateOcr": "not-run",
            "vehicleDetection": "not-run",
            "parkingDetection": "not-run",
            "payment": "not-run",
        },
        "vehicles": [],
        "parking": [],
        "queueVehicles": None,
        "arrivalRecognition": {"status": "unavailable", "plate": None, "confidence": None, "event": "未执行", "source": "local-ocr"},
        "paymentReceipt": {"status": "not-run", "receiptId": None, "amount": None, "message": "未执行任何支付动作", "source": "local-ocr"},
        "confidence": None,
        "confidenceType": None,
        "evidence": [],
        "dataBoundary": "本次视觉链路只负责本地车牌 OCR；未执行车辆检测、车位检测或真实支付",
    }


def analyze(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    mode = str(payload.get("mode") or "sample")
    if mode == "sample":
        return {
            "ok": True,
            "mode": "service-synthetic",
            "inferenceStatus": "not-run",
            "source": "可选本地 CV 服务 · 合成演示",
            "engine": "PaddleOCR 可插拔适配器（样例未执行推理）",
            "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "processingMs": round((time.perf_counter() - started) * 1000, 2),
            "input": {"kind": "built-in-synthetic", "seed": str(payload.get("seed") or "flowtwin-vision-01")},
            "capabilities": {"plateOcr": "not-run", "vehicleDetection": "not-run", "parkingDetection": "not-run", "payment": "not-run"},
            "vehicles": [],
            "parking": [],
            "queueVehicles": None,
            "arrivalRecognition": {"status": "not-run", "plate": None, "confidence": None, "event": "未执行"},
            "paymentReceipt": {"status": "not-run", "receiptId": None, "amount": None, "message": "本服务未执行真实支付"},
            "confidence": None,
            "evidence": ["样例请求不执行模型推理", "完整合成演示由 Node 主服务提供"],
            "dataBoundary": "本地 CV 服务样例未执行视觉推理",
        }
    if mode != "upload":
        raise ValueError("UNSUPPORTED_CV_MODE")

    image_data = str(payload.get("imageData") or "")
    metadata = upload_metadata(image_data)
    match = IMAGE_RE.match(image_data)
    assert match is not None
    raw = base64.b64decode(match.group(2))
    result = _base_upload_result(metadata)
    try:
        image = _decode_image(raw)
        records, engine_label = _run_paddle_ocr(image)
        valid, raw_candidates = _plate_candidates(records)
        selected = max(valid, key=lambda item: _number(item.get("score")) or -1) if valid else None
        ocr_score = _number(selected.get("score")) if selected else None
        result.update({
            "inferenceStatus": "executed",
            "source": "本地视觉服务 · PaddleOCR 车牌 OCR",
            "engine": engine_label,
            "processingMs": round((time.perf_counter() - started) * 1000, 2),
            "capabilities": {"plateOcr": "executed", "vehicleDetection": "not-run", "parkingDetection": "not-run", "payment": "not-run"},
            "confidence": ocr_score,
            "confidenceType": "paddleocr-rec-score" if ocr_score is not None else None,
            "arrivalRecognition": {
                "status": "recognized" if selected else "unrecognized",
                "plate": selected["plate"] if selected else None,
                "confidence": ocr_score,
                "confidenceType": "paddleocr-rec-score" if ocr_score is not None else None,
                "event": "本地车牌 OCR 识别" if selected else "本地 OCR 未找到符合格式的车牌",
                "source": "paddleocr",
                "candidates": raw_candidates,
                "formatCheck": "passed" if selected else "not-passed",
            },
            "evidence": [
                "图片仅在本地内存中解码和推理，未上传第三方、未落盘",
                "识别结果经过中国车牌格式校验",
                "模型分数来自 PaddleOCR；不是人为设定的置信度",
                "本次未执行车辆检测、车位检测或支付",
            ],
        })
        return result
    except OcrBusyError:
        raise
    except RuntimeError as exc:
        result.update({
            "mode": "local-ocr-unavailable",
            "source": "本地视觉服务 · PaddleOCR 未就绪",
            "engine": "PaddleOCR 本地 CPU",
            "processingMs": round((time.perf_counter() - started) * 1000, 2),
            "arrivalRecognition": {"status": "unavailable", "plate": None, "confidence": None, "event": "未执行：本地模型未就绪", "source": "local-ocr"},
            "evidence": [
                "图片格式和内容已通过校验",
                "本次没有完成 PaddleOCR 推理，因此没有返回车牌号",
                f"本地运行条件：{str(exc).split(':', 1)[0]}",
            ],
        })
        return result
    except Exception:
        result.update({
            "mode": "local-ocr-error",
            "inferenceStatus": "error",
            "source": "本地视觉服务 · OCR 执行失败",
            "processingMs": round((time.perf_counter() - started) * 1000, 2),
            "arrivalRecognition": {"status": "error", "plate": None, "confidence": None, "event": "OCR 执行失败，未返回车牌", "source": "local-ocr"},
            "evidence": ["本地 OCR 执行异常，已阻止输出虚构车牌", "请检查模型权重、依赖和输入图片质量"],
        })
        return result


class Handler(BaseHTTPRequestHandler):
    server_version = "FlowTwinCV/0.2"

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {"ok": True, "service": "flowtwin-cv", "runtime": runtime_summary()})
            return
        self._send(404, {"error": "NOT_FOUND"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/analyze":
            self._send(404, {"error": "NOT_FOUND"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("REQUEST_TOO_LARGE")
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(body, dict):
                raise ValueError("INVALID_JSON_OBJECT")
            self._send(200, analyze(body))
        except OcrBusyError as exc:
            self._send(429, {"ok": False, "error": str(exc), "retryAfterSeconds": 2})
        except ValueError as exc:
            self._send(400, {"ok": False, "error": str(exc)})
        except Exception:
            self._send(500, {"ok": False, "error": "CV_INTERNAL_ERROR"})

    def log_message(self, _format, *_args: Any) -> None:
        # Do not log request bodies, file names or possible identifying data.
        return


def main() -> None:
    host = os.environ.get("CV_HOST", "127.0.0.1")
    port = int(os.environ.get("CV_PORT", "5099"))
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
