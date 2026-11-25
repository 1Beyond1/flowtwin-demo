"""Optional local CPU vision adapter for FlowTwin.

The production-facing path is deliberately local: uploaded images are decoded
in memory, passed to a single PaddleOCR CPU instance, and discarded after the
request.  Short uploaded videos are decoded in a temporary file that is removed
immediately after processing.  The Node demo can still run without this
optional process and keeps its clearly labelled synthetic mode as a fallback.

This adapter currently promises two bounded real capabilities: OCR for a clear
license-plate image and OCR over sampled frames from a short uploaded video.
Vehicle detection, parking-space detection, real camera streaming and payment
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
import struct
import threading
import tempfile
import time
from io import BytesIO
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, min(value, maximum))


def _env_float(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    if not math.isfinite(value):
        return default
    return max(minimum, min(value, maximum))


MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_VIDEO_BYTES = 24 * 1024 * 1024
MAX_REQUEST_BYTES = 36 * 1024 * 1024
MAX_IMAGE_PIXELS = 25_000_000
MAX_IMAGE_SIDE = _env_int("CV_MAX_IMAGE_SIDE", 1600, 640, 2400)
OCR_WAIT_SECONDS = _env_float("CV_OCR_WAIT_SECONDS", 30.0, 1.0, 120.0)
SOCKET_TIMEOUT_SECONDS = _env_float("CV_SOCKET_TIMEOUT_SECONDS", 15.0, 5.0, 60.0)
VIDEO_WALL_CLOCK_TIMEOUT_SECONDS = _env_float("CV_VIDEO_TIMEOUT_SECONDS", 60.0, 5.0, 120.0)
OCR_CONCURRENCY = 1
IMAGE_RE = re.compile(r"^data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$", re.I)
VIDEO_RE = re.compile(r"^data:video/(mp4|webm|quicktime|x-matroska);base64,([A-Za-z0-9+/=]+)$", re.I)
PLATE_RE = re.compile(
    r"([京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼港澳台][A-Z][A-Z0-9]{5,6})"
)
PLATE_PREFIXES = set("京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼港澳台")
VIDEO_MAX_SECONDS = _env_float("CV_VIDEO_MAX_SECONDS", 15.0, 3.0, 30.0)
VIDEO_SAMPLE_FPS = _env_float("CV_VIDEO_SAMPLE_FPS", 2.0, 0.5, 4.0)
VIDEO_MIN_STABLE_HITS = _env_int("CV_VIDEO_MIN_STABLE_HITS", 2, 1, 5)

SAFE_CLIENT_ERROR_CODES = frozenset({
    "REQUEST_TOO_LARGE",
    "INVALID_CONTENT_LENGTH",
    "INVALID_JSON_OBJECT",
    "INVALID_JSON",
    "UNSUPPORTED_CV_MODE",
    "UNSUPPORTED_MEDIA_TYPE",
    "IMAGE_DATA_URL_REQUIRED",
    "IMAGE_BASE64_INVALID",
    "IMAGE_EMPTY",
    "IMAGE_TOO_LARGE",
    "IMAGE_CONTENT_INVALID",
    "IMAGE_DIMENSIONS_TOO_LARGE",
    "VIDEO_DATA_URL_REQUIRED",
    "VIDEO_BASE64_INVALID",
    "VIDEO_EMPTY",
    "VIDEO_TOO_LARGE",
    "VIDEO_CONTENT_INVALID",
    "VIDEO_DIMENSIONS_TOO_LARGE",
    "OCR_BUSY",
})

SAFE_RUNTIME_ERROR_CODES = frozenset({
    "VIDEO_DECODER_UNAVAILABLE",
    "VIDEO_DECODE_FAILED",
    "VIDEO_OCR_TIMEOUT",
    "VIDEO_OCR_FAILED",
    "OCR_NUMPY_UNAVAILABLE",
    "OCR_IMAGE_DECODE_FAILED",
    "OCR_IMAGE_DECODER_UNAVAILABLE",
    "PADDLEOCR_RUNTIME_UNAVAILABLE",
    "PADDLEOCR_CLASS_UNAVAILABLE",
    "PADDLEOCR_LOCAL_MODEL_DIRS_REQUIRED",
    "PADDLEOCR_INFERENCE_METHOD_UNAVAILABLE",
    "PADDLEOCR_NOT_READY",
})

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
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
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


def _safe_client_error(exc: Exception) -> str:
    code = str(exc).strip()
    return code if code in SAFE_CLIENT_ERROR_CODES else "INVALID_REQUEST"


def _safe_runtime_error(exc: Exception) -> str:
    code = str(exc).split(":", 1)[0].strip()
    return code if code in SAFE_RUNTIME_ERROR_CODES else "LOCAL_OCR_UNAVAILABLE"


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
    local_only = _env_bool("PADDLEOCR_LOCAL_ONLY", False)
    local_dirs_ready = _local_model_dirs_ready()
    deps_available = paddleocr is not None and np is not None and (cv2 is not None or Image is not None)
    ocr_available = deps_available and (local_dirs_ready if local_only else True)
    with _OCR_INIT_LOCK:
        ocr_loaded = _OCR_ENGINE is not None
        ocr_init_error = _OCR_INIT_ERROR
    summary: dict[str, Any] = {
        "opencv": cv2 is not None,
        "pillow": Image is not None,
        "numpy": np is not None,
        "paddle": paddle is not None,
        "paddleocr": paddleocr is not None,
        "ocrEngine": "PaddleOCR",
        "ocrAvailable": ocr_available,
        "ocrLoaded": ocr_loaded,
        "localOnly": local_only,
        "localModelDirsConfigured": bool(det_dir and rec_dir),
        "localModelDirsReady": local_dirs_ready,
        "modelWeightsBundled": False,
        "device": "cpu",
        "maxImageSide": MAX_IMAGE_SIDE,
        "maxImagePixels": MAX_IMAGE_PIXELS,
        "ocrConcurrency": OCR_CONCURRENCY,
        "videoSupport": cv2 is not None,
        "videoMaxSeconds": VIDEO_MAX_SECONDS,
        "videoSampleFps": VIDEO_SAMPLE_FPS,
        "videoMinStableHits": VIDEO_MIN_STABLE_HITS,
    }
    if ocr_init_error:
        summary["ocrInitError"] = ocr_init_error
    return summary


def _png_header_dimensions(raw: bytes) -> tuple[int, int] | None:
    if len(raw) >= 24 and raw[:8] == b"\x89PNG\r\n\x1a\n" and raw[12:16] == b"IHDR":
        width, height = struct.unpack(">II", raw[16:24])
        return int(width), int(height)
    return None


_JPEG_SOF_MARKERS = frozenset({
    0xC0, 0xC1, 0xC2, 0xC3,
    0xC5, 0xC6, 0xC7,
    0xC9, 0xCA, 0xCB,
    0xCD, 0xCE, 0xCF,
})


def _jpeg_header_dimensions(raw: bytes) -> tuple[int, int] | None:
    if len(raw) < 4 or raw[:2] != b"\xff\xd8":
        return None
    pos = 2
    total = len(raw)
    while pos < total:
        while pos < total and raw[pos] != 0xFF:
            pos += 1
        while pos < total and raw[pos] == 0xFF:
            pos += 1
        if pos >= total:
            break
        marker = raw[pos]
        pos += 1
        if marker in (0xD9, 0xDA):  # EOI or SOS (scan data follows)
            break
        if marker == 0x00 or marker == 0x01 or (0xD0 <= marker <= 0xD8):
            continue
        if pos + 2 > total:
            break
        seg_len = struct.unpack(">H", raw[pos:pos + 2])[0]
        if seg_len < 2 or pos + seg_len > total:
            break
        if marker in _JPEG_SOF_MARKERS and seg_len >= 7:
            height, width = struct.unpack(">HH", raw[pos + 3:pos + 7])
            return int(width), int(height)
        pos += seg_len
    return None


def _webp_header_dimensions(raw: bytes) -> tuple[int, int] | None:
    if len(raw) < 16 or raw[:4] != b"RIFF" or raw[8:12] != b"WEBP":
        return None
    pos = 12
    total = len(raw)
    max_width = 0
    max_height = 0
    found = False
    chunks_seen = 0
    while pos + 8 <= total and chunks_seen < 64:
        chunks_seen += 1
        chunk_type = raw[pos:pos + 4]
        chunk_size = struct.unpack("<I", raw[pos + 4:pos + 8])[0]
        data = pos + 8
        dims: tuple[int, int] | None = None
        if chunk_type == b"VP8X" and chunk_size >= 10 and data + 10 <= total:
            width = 1 + (raw[data + 4] | (raw[data + 5] << 8) | (raw[data + 6] << 16))
            height = 1 + (raw[data + 7] | (raw[data + 8] << 8) | (raw[data + 9] << 16))
            dims = (int(width), int(height))
        elif chunk_type == b"VP8 " and chunk_size >= 10 and data + 10 <= total:
            if raw[data + 3:data + 6] == b"\x9d\x01\x2a":
                w_raw, h_raw = struct.unpack("<HH", raw[data + 6:data + 10])
                dims = (int(w_raw & 0x3FFF), int(h_raw & 0x3FFF))
        elif chunk_type == b"VP8L" and chunk_size >= 5 and data + 5 <= total:
            if raw[data] == 0x2F:
                bits = struct.unpack("<I", raw[data + 1:data + 5])[0]
                width = (bits & 0x3FFF) + 1
                height = ((bits >> 14) & 0x3FFF) + 1
                dims = (int(width), int(height))
        if dims is not None:
            if dims[0] <= 0 or dims[1] <= 0:
                return dims
            found = True
            max_width = max(max_width, dims[0])
            max_height = max(max_height, dims[1])
        next_pos = data + chunk_size + (chunk_size & 1)
        if next_pos <= pos:
            break
        pos = next_pos
    return (max_width, max_height) if found else None


def _header_dimensions(raw: bytes) -> tuple[int, int] | None:
    return (
        _png_header_dimensions(raw)
        or _jpeg_header_dimensions(raw)
        or _webp_header_dimensions(raw)
    )


def _inspect_image_dimensions(raw: bytes, *, require_valid: bool = False) -> list[int] | None:
    header_dims = _header_dimensions(raw)
    if header_dims is not None:
        width, height = header_dims
        if width <= 0 or height <= 0:
            raise ValueError("IMAGE_CONTENT_INVALID")
        if width * height > MAX_IMAGE_PIXELS:
            raise ValueError("IMAGE_DIMENSIONS_TOO_LARGE")

    if Image is not None:
        bomb_error = getattr(Image, "DecompressionBombError", ())
        try:
            with Image.open(BytesIO(raw)) as image:
                width, height = int(image.width), int(image.height)
                if width <= 0 or height <= 0:
                    raise ValueError("IMAGE_CONTENT_INVALID")
                if width * height > MAX_IMAGE_PIXELS:
                    raise ValueError("IMAGE_DIMENSIONS_TOO_LARGE")
                return [width, height]
        except bomb_error as exc:
            raise ValueError("IMAGE_DIMENSIONS_TOO_LARGE") from exc
        except ValueError:
            raise
        except Exception as exc:
            if require_valid:
                raise RuntimeError("OCR_IMAGE_DECODE_FAILED") from exc
            return [header_dims[0], header_dims[1]] if header_dims is not None else None

    if header_dims is not None:
        return [header_dims[0], header_dims[1]]
    if require_valid:
        raise RuntimeError("OCR_IMAGE_DECODE_FAILED")
    return None


def _parse_upload_image(image_data: str) -> tuple[dict[str, Any], bytes]:
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
        and b"\xff\xd9" in raw[max(2, len(raw) - 64):]
    ) or (
        mime_type == "image/webp"
        and len(raw) >= 12
        and raw[:4] == b"RIFF"
        and raw[8:12] == b"WEBP"
    )
    if not signature_ok:
        raise ValueError("IMAGE_CONTENT_INVALID")
    dimensions = _inspect_image_dimensions(raw, require_valid=False)
    metadata = {
        "mimeType": mime_type,
        "bytes": len(raw),
        "dimensions": dimensions,
        "sha256Prefix": hashlib.sha256(raw).hexdigest()[:12],
    }
    return metadata, raw


def upload_metadata(image_data: str) -> dict[str, Any]:
    metadata, _raw = _parse_upload_image(image_data)
    return metadata


def upload_video_metadata(video_data: str) -> tuple[dict[str, Any], bytes]:
    match = VIDEO_RE.match(str(video_data or ""))
    if not match:
        raise ValueError("VIDEO_DATA_URL_REQUIRED")
    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("VIDEO_BASE64_INVALID") from exc
    if not raw:
        raise ValueError("VIDEO_EMPTY")
    if len(raw) > MAX_VIDEO_BYTES:
        raise ValueError("VIDEO_TOO_LARGE")
    subtype = match.group(1).lower()
    mime_type = f"video/{subtype}"
    header = raw[:64]
    signature_ok = (
        subtype in {"mp4", "quicktime"} and b"ftyp" in header
    ) or (
        subtype in {"webm", "x-matroska"} and raw[:4] == b"\x1a\x45\xdf\xa3"
    )
    if not signature_ok:
        raise ValueError("VIDEO_CONTENT_INVALID")
    return {
        "mimeType": mime_type,
        "bytes": len(raw),
        "sha256Prefix": hashlib.sha256(raw).hexdigest()[:12],
    }, raw


def _decode_image(raw: bytes) -> Any:
    # Enforce pixel limit via native PNG/JPEG/WebP header parsing and/or PIL
    # BEFORE cv2.imdecode or numpy checks so a compressed pixel bomb or
    # headerless payload cannot bypass pre-decode validation.
    _inspect_image_dimensions(raw, require_valid=True)
    if np is None:
        raise RuntimeError("OCR_NUMPY_UNAVAILABLE")
    if cv2 is not None:
        image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is not None:
            height, width = image.shape[:2]
            if int(width) * int(height) > MAX_IMAGE_PIXELS:
                raise ValueError("IMAGE_DIMENSIONS_TOO_LARGE")
            return _resize_image(image)
    if Image is not None:
        bomb_error = getattr(Image, "DecompressionBombError", ())
        try:
            with Image.open(BytesIO(raw)) as source:
                if int(source.width) * int(source.height) > MAX_IMAGE_PIXELS:
                    raise ValueError("IMAGE_DIMENSIONS_TOO_LARGE")
                rgb = source.convert("RGB")
                if max(rgb.size) > MAX_IMAGE_SIDE:
                    scale = MAX_IMAGE_SIDE / max(rgb.size)
                    rgb = rgb.resize((max(1, round(rgb.width * scale)), max(1, round(rgb.height * scale))))
                return np.asarray(rgb)
        except bomb_error as exc:
            raise ValueError("IMAGE_DIMENSIONS_TOO_LARGE") from exc
        except ValueError:
            raise
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
        modern["text_detection_model_name"] = (
            os.environ.get("PADDLEOCR_TEXT_DET_MODEL_NAME", "").strip()
            or Path(det_dir).name
        )
        modern["text_detection_model_dir"] = det_dir
    if rec_dir:
        modern["text_recognition_model_name"] = (
            os.environ.get("PADDLEOCR_TEXT_REC_MODEL_NAME", "").strip()
            or Path(rec_dir).name
        )
        modern["text_recognition_model_dir"] = rec_dir

    try:
        return factory(**modern), "PaddleOCR 本地 CPU（3.x API）"
    except TypeError:
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
    with _OCR_INIT_LOCK:
        if _OCR_ENGINE is not None:
            return _OCR_ENGINE, _OCR_ENGINE_LABEL
        try:
            engine, label = _build_ocr_engine()
            _OCR_ENGINE_LABEL = label
            _OCR_INIT_ERROR = ""
            _OCR_ENGINE = engine
            return engine, label
        except Exception as exc:  # pragma: no cover - depends on local model setup
            code = _safe_runtime_error(exc)
            _OCR_INIT_ERROR = code
            raise RuntimeError(code) from exc


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


def _run_paddle_ocr(image: Any, *, locked: bool = False) -> tuple[list[dict[str, Any]], str]:
    engine, label = _get_ocr_engine()
    if not locked and not _OCR_RUN_LOCK.acquire(timeout=OCR_WAIT_SECONDS):
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
        if not locked:
            _OCR_RUN_LOCK.release()


def _video_candidate_summary(temporal: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    candidates = []
    for plate, item in temporal.items():
        scores = [score for score in item.get("scores", []) if score is not None]
        candidates.append({
            "plate": plate,
            "hits": int(item.get("hits", 0)),
            "maxScore": max(scores) if scores else None,
            "timesSec": [round(float(value), 2) for value in item.get("times", [])[:6]],
        })
    return sorted(
        candidates,
        key=lambda item: (int(item.get("hits", 0)), _number(item.get("maxScore")) or -1),
        reverse=True,
    )[:8]


def _analyze_video(metadata: dict[str, Any], raw: bytes) -> dict[str, Any]:
    if cv2 is None:
        raise RuntimeError("VIDEO_DECODER_UNAVAILABLE")

    started = time.perf_counter()
    temp_path = None
    capture = None
    temporal: dict[str, dict[str, Any]] = {}
    observations: list[dict[str, Any]] = []
    frames_decoded = 0
    frames_sampled = 0
    fps = 0.0
    frame_width = None
    frame_height = None
    try:
        suffix = ".webm" if metadata["mimeType"] in {"video/webm", "video/x-matroska"} else ".mp4"
        with tempfile.NamedTemporaryFile(prefix="flowtwin-cv-", suffix=suffix, delete=False) as handle:
            handle.write(raw)
            handle.flush()
            temp_path = handle.name

        capture = cv2.VideoCapture(temp_path)
        if not capture.isOpened():
            raise RuntimeError("VIDEO_DECODE_FAILED")
        fps = _number(capture.get(cv2.CAP_PROP_FPS)) or 25.0
        fps = max(1.0, min(fps, 120.0))
        frame_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0) or None
        frame_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0) or None
        if frame_width and frame_height and frame_width * frame_height > MAX_IMAGE_PIXELS:
            raise ValueError("VIDEO_DIMENSIONS_TOO_LARGE")
        sample_every = max(1, int(round(fps / VIDEO_SAMPLE_FPS)))
        max_decode_frames = max(1, int(math.ceil(VIDEO_MAX_SECONDS * fps)))

        if not _OCR_RUN_LOCK.acquire(timeout=OCR_WAIT_SECONDS):
            raise OcrBusyError("OCR_BUSY")
        try:
            while frames_decoded < max_decode_frames:
                if time.perf_counter() - started > VIDEO_WALL_CLOCK_TIMEOUT_SECONDS:
                    raise RuntimeError("VIDEO_OCR_TIMEOUT")
                ok, frame = capture.read()
                if not ok:
                    break
                if frame is not None and hasattr(frame, "shape") and len(frame.shape) >= 2:
                    h, w = int(frame.shape[0]), int(frame.shape[1])
                    if h * w > MAX_IMAGE_PIXELS:
                        raise ValueError("VIDEO_DIMENSIONS_TOO_LARGE")
                frame_index = frames_decoded
                frames_decoded += 1
                if frame_index % sample_every != 0:
                    continue
                frames_sampled += 1
                records, _engine_label = _run_paddle_ocr(_resize_image(frame), locked=True)
                valid, _raw_candidates = _plate_candidates(records)
                if not valid:
                    continue
                best = max(valid, key=lambda item: _number(item.get("score")) or -1)
                plate = str(best.get("plate") or "").strip()
                if not plate:
                    continue
                score = _number(best.get("score"))
                time_sec = frame_index / fps
                item = temporal.setdefault(plate, {"hits": 0, "scores": [], "times": []})
                item["hits"] += 1
                if score is not None:
                    item["scores"].append(score)
                item["times"].append(time_sec)
                if len(observations) < 24:
                    observations.append({
                        "timeSec": round(time_sec, 2),
                        "plate": plate,
                        "score": score,
                    })
        finally:
            _OCR_RUN_LOCK.release()

        candidates = _video_candidate_summary(temporal)
        stable = [candidate for candidate in candidates if candidate["hits"] >= VIDEO_MIN_STABLE_HITS]
        selected = stable[0] if stable else None
        ocr_score = _number(selected.get("maxScore")) if selected else None
        recognition_status = "recognized" if selected else "unrecognized"
        return {
            "ok": True,
            "mode": "local-video-ocr",
            "inferenceStatus": "executed",
            "source": "本地视觉服务 · PaddleOCR 视频抽帧车牌 OCR",
            "engine": "PaddleOCR 本地 CPU",
            "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "processingMs": round((time.perf_counter() - started) * 1000, 2),
            "input": {"kind": "uploaded-video", **metadata},
            "video": {
                "durationSec": round(min(frames_decoded / fps, VIDEO_MAX_SECONDS), 2),
                "fps": round(fps, 2),
                "dimensions": [frame_width, frame_height] if frame_width and frame_height else None,
                "framesDecoded": frames_decoded,
                "framesSampled": frames_sampled,
                "sampleFps": VIDEO_SAMPLE_FPS,
                "maxDurationSec": VIDEO_MAX_SECONDS,
                "stableHitsRequired": VIDEO_MIN_STABLE_HITS,
                "observations": observations,
            },
            "capabilities": {
                "plateOcr": "executed",
                "vehicleDetection": "not-run",
                "parkingDetection": "not-run",
                "payment": "not-run",
            },
            "vehicles": [],
            "parking": [],
            "queueVehicles": None,
            "arrivalRecognition": {
                "status": recognition_status,
                "plate": selected["plate"] if selected else None,
                "confidence": ocr_score,
                "confidenceType": "paddleocr-rec-score-temporal" if ocr_score is not None else None,
                "event": "视频抽帧车牌 OCR 识别" if selected else "视频抽帧未找到稳定车牌",
                "source": "paddleocr",
                "candidates": candidates,
                "formatCheck": "passed" if selected else "not-passed",
            },
            "paymentReceipt": {
                "status": "not-run",
                "receiptId": None,
                "amount": None,
                "message": "未执行任何支付动作",
                "source": "local-video-ocr",
            },
            "confidence": ocr_score,
            "confidenceType": "paddleocr-rec-score-temporal" if ocr_score is not None else None,
            "evidence": [
                "视频仅在本地临时文件中解码，处理结束后删除",
                "按固定采样频率抽帧，连续命中同一车牌后才判定为稳定识别",
                "识别结果经过中国车牌格式校验",
                "本次未执行车辆检测、车位检测或支付",
            ],
            "dataBoundary": "本次仅支持短视频抽帧车牌 OCR；未执行实时摄像头、车辆检测、车位检测或真实支付",
        }
    except (OcrBusyError, ValueError, RuntimeError):
        raise
    except Exception as exc:
        raise RuntimeError("VIDEO_OCR_FAILED") from exc
    finally:
        if capture is not None:
            capture.release()
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


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
    mode = str(payload.get("mode") or "").strip().lower()
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
    if mode == "video":
        video_data = str(payload.get("videoData") or "")
        metadata, raw = upload_video_metadata(video_data)
        try:
            return _analyze_video(metadata, raw)
        except (OcrBusyError, ValueError):
            raise
        except RuntimeError as exc:
            reason_code = _safe_runtime_error(exc)
            return {
                "ok": True,
                "mode": "local-video-ocr-unavailable",
                "inferenceStatus": "not-run",
                "reasonCode": reason_code,
                "retryable": reason_code == "PADDLEOCR_NOT_READY",
                "source": "本地视觉服务 · 视频 OCR 未就绪",
                "engine": "PaddleOCR 本地 CPU",
                "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "processingMs": round((time.perf_counter() - started) * 1000, 2),
                "input": {"kind": "uploaded-video", **metadata},
                "video": {"maxDurationSec": VIDEO_MAX_SECONDS, "sampleFps": VIDEO_SAMPLE_FPS},
                "capabilities": {"plateOcr": "not-run", "vehicleDetection": "not-run", "parkingDetection": "not-run", "payment": "not-run"},
                "vehicles": [],
                "parking": [],
                "queueVehicles": None,
                "arrivalRecognition": {"status": "unavailable", "plate": None, "confidence": None, "event": "未执行：视频解码或本地模型未就绪", "source": "local-video-ocr"},
                "paymentReceipt": {"status": "not-run", "receiptId": None, "amount": None, "message": "未执行任何支付动作", "source": "local-video-ocr"},
                "confidence": None,
                "confidenceType": None,
                "evidence": [
                    "视频格式已通过校验，但本次没有完成视频抽帧 OCR",
                    f"本地运行条件：{reason_code}",
                    "未返回车牌号，也未生成支付结果",
                ],
                "dataBoundary": "本次视频未完成视觉推理，不能把结果当作识别结论",
            }
    if mode != "upload":
        raise ValueError("UNSUPPORTED_CV_MODE")

    image_data = str(payload.get("imageData") or "")
    metadata, raw = _parse_upload_image(image_data)
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
    except (OcrBusyError, ValueError):
        raise
    except RuntimeError as exc:
        reason_code = _safe_runtime_error(exc)
        result.update({
            "mode": "local-ocr-unavailable",
            "reasonCode": reason_code,
            "retryable": reason_code == "PADDLEOCR_NOT_READY",
            "source": "本地视觉服务 · PaddleOCR 未就绪",
            "engine": "PaddleOCR 本地 CPU",
            "processingMs": round((time.perf_counter() - started) * 1000, 2),
            "arrivalRecognition": {"status": "unavailable", "plate": None, "confidence": None, "event": "未执行：本地模型未就绪", "source": "local-ocr"},
            "evidence": [
                "图片格式和内容已通过校验",
                "本次没有完成 PaddleOCR 推理，因此没有返回车牌号",
                f"本地运行条件：{reason_code}",
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
    timeout = SOCKET_TIMEOUT_SECONDS

    def setup(self) -> None:
        self.timeout = SOCKET_TIMEOUT_SECONDS
        if getattr(self, "connection", None) is not None and hasattr(self.connection, "settimeout"):
            self.connection.settimeout(SOCKET_TIMEOUT_SECONDS)
        super().setup()

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
        content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._send(415, {"ok": False, "error": "UNSUPPORTED_MEDIA_TYPE"})
            return
        try:
            raw_length = (self.headers.get("Content-Length") or "").strip()
            if not raw_length or not raw_length.isdigit():
                raise ValueError("INVALID_CONTENT_LENGTH")
            length = int(raw_length)
            if length <= 0:
                raise ValueError("INVALID_CONTENT_LENGTH")
            if length > MAX_REQUEST_BYTES:
                raise ValueError("REQUEST_TOO_LARGE")
            raw_body = self.rfile.read(length)
            try:
                body = json.loads(raw_body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError("INVALID_JSON") from exc
            if not isinstance(body, dict):
                raise ValueError("INVALID_JSON_OBJECT")
            self._send(200, analyze(body))
        except OcrBusyError:
            self._send(429, {"ok": False, "error": "OCR_BUSY", "retryAfterSeconds": 2})
        except ValueError as exc:
            code = _safe_client_error(exc)
            status = 413 if code == "REQUEST_TOO_LARGE" else 400
            self._send(status, {"ok": False, "error": code})
        except Exception:
            self._send(500, {"ok": False, "error": "CV_INTERNAL_ERROR"})

    def log_message(self, _format, *_args: Any) -> None:
        # Do not log request bodies, file names or possible identifying data.
        return


def main() -> None:
    host = (os.environ.get("CV_HOST") or "").strip() or "127.0.0.1"
    port = _env_int("CV_PORT", 5099, 1, 65535)
    # Use ThreadingHTTPServer so GET /health stays responsive during slow video
    # OCR while _OCR_INIT_LOCK and _OCR_RUN_LOCK keep PaddleOCR strictly
    # single-flight (OCR_CONCURRENCY=1).
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
