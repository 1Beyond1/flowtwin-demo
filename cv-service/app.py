"""Optional local CPU CV adapter for FlowTwin.

This process is intentionally independent from the Node route planner.  It
accepts JSON only, does not persist images, and returns a labelled fallback if
OpenCV/Paddle dependencies or model weights are unavailable.  The built-in
Node synthetic mode remains the recommended no-install demo path.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_REQUEST_BYTES = 8 * 1024 * 1024
IMAGE_RE = re.compile(r"^data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$", re.I)

try:  # Optional. Do not make the adapter unstartable without these packages.
    import cv2  # type: ignore
except Exception:  # pragma: no cover - environment dependent
    cv2 = None

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


def runtime_summary() -> dict[str, Any]:
    return {
        "opencv": cv2 is not None,
        "pillow": Image is not None,
        "paddle": paddle is not None,
        "paddleocr": paddleocr is not None,
        "modelWeightsBundled": False,
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
            from io import BytesIO
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


def analyze(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    mode = str(payload.get("mode") or "sample")
    if mode == "sample":
        return {
            "ok": True,
            "mode": "service-synthetic",
            "inferenceStatus": "not-run",
            "source": "可选本地 CV 服务 · 合成演示",
            "engine": "OpenCV/Paddle 可插拔适配器（当前无模型权重）",
            "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "processingMs": round((time.perf_counter() - started) * 1000, 2),
            "input": {"kind": "built-in-synthetic", "seed": str(payload.get("seed") or "flowtwin-vision-01")},
            "vehicles": [],
            "parking": [],
            "queueVehicles": None,
            "arrivalRecognition": {"status": "not-run", "plate": None, "confidence": None, "event": "未执行"},
            "paymentReceipt": {"status": "not-run", "receiptId": None, "amount": None, "message": "本服务未执行真实支付"},
            "confidence": None,
            "evidence": ["服务已启动，但未配置检测模型权重", "未把空结果包装成车辆识别成功"],
            "dataBoundary": "本地 CV 服务当前仅验证适配器可用性，不代表真实摄像头识别",
        }
    if mode == "upload":
        metadata = upload_metadata(payload.get("imageData", ""))
        return {
            "ok": True,
            "mode": "service-upload-inspection",
            "inferenceStatus": "not-run",
            "source": "可选本地 CV 服务 · 上传图片元数据检查",
            "engine": "OpenCV/Paddle 适配层（未加载模型权重）",
            "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "processingMs": round((time.perf_counter() - started) * 1000, 2),
            "input": {"kind": "uploaded-image", **metadata},
            "vehicles": [],
            "parking": [],
            "queueVehicles": None,
            "arrivalRecognition": {"status": "not-run", "plate": None, "confidence": None, "event": "未执行"},
            "paymentReceipt": {"status": "not-run", "receiptId": None, "amount": None, "message": "本服务未执行真实支付"},
            "confidence": None,
            "evidence": ["只检查图片格式、大小和尺寸", "未启用 PP-Vehicle 或 PaddleOCR 权重", "原图只在请求内存中处理，不落盘"],
            "dataBoundary": "上传图片已接收但未完成视觉推理，不能当作识别结论",
        }
    raise ValueError("UNSUPPORTED_CV_MODE")


class Handler(BaseHTTPRequestHandler):
    server_version = "FlowTwinCV/0.1"

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
        except ValueError as exc:
            self._send(400, {"ok": False, "error": str(exc)})
        except Exception:
            self._send(500, {"ok": False, "error": "CV_INTERNAL_ERROR"})

    def log_message(self, _format: str, *_args: Any) -> None:
        # Do not log request bodies, file names or possible identifying data.
        return


def main() -> None:
    host = os.environ.get("CV_HOST", "127.0.0.1")
    port = int(os.environ.get("CV_PORT", "5099"))
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
