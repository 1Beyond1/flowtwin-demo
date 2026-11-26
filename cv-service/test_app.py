import base64
import json
import os
import socket
import struct
import sys
import threading
import unittest
import zlib
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from app import (  # noqa: E402
    Handler,
    MAX_IMAGE_PIXELS,
    MAX_REQUEST_BYTES,
    OcrBusyError,
    SOCKET_TIMEOUT_SECONDS,
    _env_float,
    _env_int,
    _get_ocr_engine,
    _normalize_ocr_text,
    _plate_candidates,
    analyze,
    runtime_summary,
    upload_metadata,
    upload_video_metadata,
)


def data_url(mime: str, raw: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def make_png_header(width: int, height: int) -> bytes:
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    ihdr_crc = struct.pack(">I", zlib.crc32(b"IHDR" + ihdr_data) & 0xFFFFFFFF)
    ihdr_chunk = struct.pack(">I", len(ihdr_data)) + b"IHDR" + ihdr_data + ihdr_crc
    iend_crc = struct.pack(">I", zlib.crc32(b"IEND") & 0xFFFFFFFF)
    iend_chunk = struct.pack(">I", 0) + b"IEND" + iend_crc
    return b"\x89PNG\r\n\x1a\n" + ihdr_chunk + iend_chunk


def make_jpeg_header(width: int, height: int, *, sof_marker: int = 0xC0) -> bytes:
    # SOI + APP0(JFIF) + SOF(precision=8, height, width, 3 components) + EOI
    app0_payload = b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    app0 = b"\xff\xe0" + struct.pack(">H", len(app0_payload) + 2) + app0_payload
    sof_body = struct.pack(">BHHB", 8, height, width, 3) + b"\x01\x11\x00\x02\x11\x00\x03\x11\x00"
    sof = bytes([0xFF, sof_marker]) + struct.pack(">H", len(sof_body) + 2) + sof_body
    return b"\xff\xd8" + app0 + sof + b"\xff\xd9"


def make_webp_vp8x(width: int, height: int) -> bytes:
    w = width - 1
    h = height - 1
    vp8x_data = b"\x00\x00\x00\x00" + bytes([w & 0xFF, (w >> 8) & 0xFF, (w >> 16) & 0xFF, h & 0xFF, (h >> 8) & 0xFF, (h >> 16) & 0xFF])
    body = b"WEBP" + b"VP8X" + struct.pack("<I", len(vp8x_data)) + vp8x_data
    return b"RIFF" + struct.pack("<I", len(body)) + body


def make_webp_vp8_lossy(width: int, height: int) -> bytes:
    frame_header = b"\x10\x00\x00\x9d\x01\x2a" + struct.pack("<HH", width, height)
    body = b"WEBP" + b"VP8 " + struct.pack("<I", len(frame_header)) + frame_header
    return b"RIFF" + struct.pack("<I", len(body)) + body


def make_webp_vp8l_lossless(width: int, height: int) -> bytes:
    bits = ((width - 1) & 0x3FFF) | (((height - 1) & 0x3FFF) << 14)
    payload = b"\x2f" + struct.pack("<I", bits)
    body = b"WEBP" + b"VP8L" + struct.pack("<I", len(payload)) + payload + b"\x00"
    return b"RIFF" + struct.pack("<I", len(body)) + body


class CvAdapterTests(unittest.TestCase):
    def test_sample_is_explicitly_not_model_inference(self):
        result = analyze({"mode": "sample", "seed": "test-seed"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["inferenceStatus"], "not-run")
        self.assertEqual(result["arrivalRecognition"]["status"], "not-run")

    def test_upload_rejects_mismatched_content(self):
        with self.assertRaisesRegex(ValueError, "IMAGE_CONTENT_INVALID"):
            upload_metadata(data_url("image/png", b"not-a-png"))

    def test_upload_accepts_minimal_valid_signatures(self):
        samples = {
            "image/png": b"\x89PNG\r\n\x1a\n",
            "image/jpeg": b"\xff\xd8\xff\xd9",
            "image/webp": b"RIFF\x00\x00\x00\x00WEBP",
        }
        for mime, raw in samples.items():
            metadata = upload_metadata(data_url(mime, raw))
            self.assertEqual(metadata["mimeType"], mime)

    def test_upload_result_does_not_claim_recognition(self):
        raw = b"\xff\xd8\xff\xd9"
        result = analyze({"mode": "upload", "imageData": data_url("image/jpeg", raw)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["inferenceStatus"], "not-run")
        self.assertEqual(result["paymentReceipt"]["status"], "not-run")
        self.assertIsNone(result["arrivalRecognition"]["plate"])
        self.assertNotIn("FT2026", json_text(result))

    def test_pixel_bomb_is_rejected_before_imdecode(self):
        # 6000 x 6000 = 36,000,000 > MAX_IMAGE_PIXELS (25,000,000)
        bomb_png = make_png_header(6000, 6000)
        self.assertGreater(6000 * 6000, MAX_IMAGE_PIXELS)
        with self.assertRaisesRegex(ValueError, "IMAGE_DIMENSIONS_TOO_LARGE"):
            upload_metadata(data_url("image/png", bomb_png))
        with self.assertRaisesRegex(ValueError, "IMAGE_DIMENSIONS_TOO_LARGE"):
            analyze({"mode": "upload", "imageData": data_url("image/png", bomb_png)})

        # Even when Pillow is unavailable (Image is None), native header parsers
        # reject oversized JPEG (SOF0/SOF2) and WebP (VP8X/VP8/VP8L) BEFORE cv2.imdecode.
        fake_cv2 = mock.MagicMock()
        fake_cv2.imdecode.side_effect = AssertionError("cv2.imdecode must not run on oversized or unverified images")
        bomb_cases = [
            ("image/jpeg", make_jpeg_header(6000, 5000, sof_marker=0xC0)),
            ("image/jpeg", make_jpeg_header(6000, 5000, sof_marker=0xC2)),
            ("image/webp", make_webp_vp8x(6000, 5000)),
            ("image/webp", make_webp_vp8_lossy(6000, 5000)),
            ("image/webp", make_webp_vp8l_lossless(6000, 5000)),
        ]
        with mock.patch.object(app, "Image", None), mock.patch.object(app, "cv2", fake_cv2), mock.patch.object(app, "np", None):
            for mime, payload_bytes in bomb_cases:
                with self.assertRaisesRegex(ValueError, "IMAGE_DIMENSIONS_TOO_LARGE"):
                    upload_metadata(data_url(mime, payload_bytes))
                with self.assertRaisesRegex(ValueError, "IMAGE_DIMENSIONS_TOO_LARGE"):
                    analyze({"mode": "upload", "imageData": data_url(mime, payload_bytes)})
            # Headerless minimal JPEG stub must also not reach cv2.imdecode when Pillow is absent
            stub_result = analyze({"mode": "upload", "imageData": data_url("image/jpeg", b"\xff\xd8\xff\xd9")})
            self.assertEqual(stub_result["mode"], "local-ocr-unavailable")
            self.assertEqual(stub_result["reasonCode"], "OCR_IMAGE_DECODE_FAILED")
            self.assertFalse(stub_result["retryable"])
            fake_cv2.imdecode.assert_not_called()

    def test_upload_decodes_base64_only_once(self):
        raw = b"\xff\xd8\xff\xd9"
        payload = {"mode": "upload", "imageData": data_url("image/jpeg", raw)}
        with mock.patch("app.base64.b64decode", wraps=base64.b64decode) as spy:
            analyze(payload)
            self.assertEqual(spy.call_count, 1)

    def test_video_metadata_accepts_container_signature_without_running_ocr(self):
        raw = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2"
        metadata, returned = upload_video_metadata(data_url("video/mp4", raw))
        self.assertEqual(metadata["mimeType"], "video/mp4")
        self.assertEqual(metadata["bytes"], len(raw))
        self.assertEqual(returned, raw)
        with self.assertRaisesRegex(ValueError, "VIDEO_CONTENT_INVALID"):
            upload_video_metadata(data_url("video/mp4", b"not-a-video"))

    def test_video_decodes_base64_once_and_enforces_resolution_and_timeout(self):
        raw = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2"
        payload = {"mode": "video", "videoData": data_url("video/mp4", raw)}

        # Single base64 decode on video mode
        with mock.patch("app.base64.b64decode", wraps=base64.b64decode) as spy:
            result = analyze(payload)
            self.assertEqual(spy.call_count, 1)
            self.assertEqual(result["mode"], "local-video-ocr-unavailable")

        # Resolution check before decoding frames
        class FakeCv2Oversized:
            CAP_PROP_FPS = 5
            CAP_PROP_FRAME_WIDTH = 3
            CAP_PROP_FRAME_HEIGHT = 4

            class VideoCapture:
                def __init__(self, _path):
                    pass

                def isOpened(self):
                    return True

                def get(self, prop):
                    if prop == 5:
                        return 25.0
                    if prop == 3:
                        return 6000.0
                    if prop == 4:
                        return 5000.0
                    return 0.0

                def release(self):
                    pass

        with mock.patch.object(app, "cv2", FakeCv2Oversized):
            with self.assertRaisesRegex(ValueError, "VIDEO_DIMENSIONS_TOO_LARGE"):
                analyze(payload)

        # Wall-clock timeout check inside video frame loop
        class FakeCv2Slow:
            CAP_PROP_FPS = 5
            CAP_PROP_FRAME_WIDTH = 3
            CAP_PROP_FRAME_HEIGHT = 4

            class VideoCapture:
                def __init__(self, _path):
                    pass

                def isOpened(self):
                    return True

                def get(self, prop):
                    if prop == 5:
                        return 25.0
                    if prop == 3:
                        return 640.0
                    if prop == 4:
                        return 480.0
                    return 0.0

                def read(self):
                    return True, None

                def release(self):
                    pass

        ticks = iter([0.0, 0.0, 999.0, 999.1])
        with mock.patch.object(app, "cv2", FakeCv2Slow), \
             mock.patch.object(app, "VIDEO_WALL_CLOCK_TIMEOUT_SECONDS", 5.0), \
             mock.patch.object(app.time, "perf_counter", side_effect=lambda: next(ticks, 999.9)):
            timed_out = analyze(payload)
            self.assertEqual(timed_out["mode"], "local-video-ocr-unavailable")
            self.assertEqual(timed_out["reasonCode"], "VIDEO_OCR_TIMEOUT")
            self.assertFalse(timed_out["retryable"])
            self.assertTrue(any("VIDEO_OCR_TIMEOUT" in item for item in timed_out["evidence"]))

        with mock.patch.object(app, "_analyze_video", side_effect=RuntimeError("PADDLEOCR_NOT_READY")):
            warming = analyze(payload)
            self.assertEqual(warming["mode"], "local-video-ocr-unavailable")
            self.assertEqual(warming["reasonCode"], "PADDLEOCR_NOT_READY")
            self.assertTrue(warming["retryable"])

    def test_http_handler_enforces_json_content_type_sanitizes_errors_and_sets_timeout(self):
        self.assertGreaterEqual(SOCKET_TIMEOUT_SECONDS, 5.0)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            conn = HTTPConnection("127.0.0.1", port, timeout=5)
            # GET /health -> 200 with runtime summary
            conn.request("GET", "/health")
            res = conn.getresponse()
            health = json.loads(res.read().decode("utf-8"))
            self.assertEqual(res.status, 200)
            self.assertTrue(health["ok"])
            self.assertEqual(health["service"], "flowtwin-cv")
            self.assertIn("ocrAvailable", health["runtime"])

            # Non-JSON Content-Type -> 415
            conn.request("POST", "/analyze", body=b'{"mode":"sample"}', headers={"Content-Type": "text/plain"})
            res = conn.getresponse()
            body = json.loads(res.read().decode("utf-8"))
            self.assertEqual(res.status, 415)
            self.assertEqual(body["error"], "UNSUPPORTED_MEDIA_TYPE")

            # Content-Length: 0 -> 400 INVALID_CONTENT_LENGTH (not 413)
            conn.request("POST", "/analyze", body=b"", headers={"Content-Type": "application/json", "Content-Length": "0"})
            res = conn.getresponse()
            body = json.loads(res.read().decode("utf-8"))
            self.assertEqual(res.status, 400)
            self.assertEqual(body["error"], "INVALID_CONTENT_LENGTH")

            # Missing Content-Length -> 400 INVALID_CONTENT_LENGTH
            with socket.create_connection(("127.0.0.1", port), timeout=5) as raw_sock:
                raw_sock.sendall(b"POST /analyze HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n")
                raw_resp = b""
                while True:
                    chunk = raw_sock.recv(4096)
                    if not chunk:
                        break
                    raw_resp += chunk
            head, _, payload_bytes = raw_resp.partition(b"\r\n\r\n")
            self.assertIn(b" 400 ", head)
            self.assertEqual(json.loads(payload_bytes.decode("utf-8"))["error"], "INVALID_CONTENT_LENGTH")

            # Oversized Content-Length -> 413 REQUEST_TOO_LARGE
            with socket.create_connection(("127.0.0.1", port), timeout=5) as raw_sock:
                oversized = MAX_REQUEST_BYTES + 1
                raw_sock.sendall(
                    f"POST /analyze HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {oversized}\r\nConnection: close\r\n\r\n".encode("ascii")
                )
                raw_resp = b""
                while True:
                    chunk = raw_sock.recv(4096)
                    if not chunk:
                        break
                    raw_resp += chunk
            head, _, payload_bytes = raw_resp.partition(b"\r\n\r\n")
            self.assertIn(b" 413 ", head)
            self.assertEqual(json.loads(payload_bytes.decode("utf-8"))["error"], "REQUEST_TOO_LARGE")

            # Invalid JSON -> 400 with whitelisted error code (no Python internals)
            conn.request("POST", "/analyze", body=b"{broken", headers={"Content-Type": "application/json"})
            res = conn.getresponse()
            body = json.loads(res.read().decode("utf-8"))
            self.assertEqual(res.status, 400)
            self.assertEqual(body["error"], "INVALID_JSON")

            # 429 OCR_BUSY when OCR slot is busy
            with mock.patch.object(app, "analyze", side_effect=OcrBusyError("OCR_BUSY")):
                conn.request("POST", "/analyze", body=b'{"mode":"upload","imageData":"x"}', headers={"Content-Type": "application/json"})
                res = conn.getresponse()
                body = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 429)
                self.assertEqual(body["error"], "OCR_BUSY")

            # Valid JSON -> 200 (also case/whitespace normalized mode)
            conn.request("POST", "/analyze", body=b'{"mode":"  Sample "}', headers={"Content-Type": "application/json"})
            res = conn.getresponse()
            body = json.loads(res.read().decode("utf-8"))
            self.assertEqual(res.status, 200)
            self.assertEqual(body["mode"], "service-synthetic")
            conn.close()
        finally:
            server.shutdown()
            server.server_close()

    def test_jpeg_with_trailing_padding_after_eoi_is_accepted(self):
        padded = make_jpeg_header(640, 480) + b"\x00\x00trailing-exif-pad"
        metadata = upload_metadata(data_url("image/jpeg", padded))
        self.assertEqual(metadata["mimeType"], "image/jpeg")
        self.assertEqual(metadata["dimensions"], [640, 480])

        # Missing EOI entirely must still fail
        no_eoi = make_jpeg_header(640, 480)[:-2] + b"\x00\x00"
        with self.assertRaisesRegex(ValueError, "IMAGE_CONTENT_INVALID"):
            upload_metadata(data_url("image/jpeg", no_eoi))

    def test_get_ocr_engine_preserves_permanent_error_code_and_exposes_init_error(self):
        with mock.patch.object(app, "_OCR_ENGINE", None), \
             mock.patch.object(app, "_OCR_ENGINE_LABEL", ""), \
             mock.patch.object(app, "_OCR_INIT_ERROR", ""), \
             mock.patch.object(app, "_build_ocr_engine", side_effect=RuntimeError("PADDLEOCR_LOCAL_MODEL_DIRS_REQUIRED")):
            with self.assertRaisesRegex(RuntimeError, "PADDLEOCR_LOCAL_MODEL_DIRS_REQUIRED"):
                _get_ocr_engine()
            summary = runtime_summary()
            self.assertEqual(summary.get("ocrInitError"), "PADDLEOCR_LOCAL_MODEL_DIRS_REQUIRED")

    def test_runtime_summary_factors_local_model_dirs_when_local_only_enabled(self):
        with mock.patch.dict(os.environ, {"PADDLEOCR_LOCAL_ONLY": "1", "PADDLEOCR_TEXT_DET_MODEL_DIR": "", "PADDLEOCR_TEXT_REC_MODEL_DIR": ""}), \
             mock.patch.object(app, "paddleocr", object()), \
             mock.patch.object(app, "np", object()), \
             mock.patch.object(app, "cv2", object()):
            summary = runtime_summary()
            self.assertTrue(summary["localOnly"])
            self.assertFalse(summary["localModelDirsReady"])
            self.assertFalse(summary["ocrAvailable"])

    def test_mocked_executed_ocr_flow_returns_plate_and_confidence(self):
        raw_jpeg = make_jpeg_header(800, 600)
        with mock.patch.object(app, "_decode_image", return_value="fake-image"), \
             mock.patch.object(app, "_run_paddle_ocr", return_value=([{"text": "京A·88888", "score": 0.96, "bbox": None}], "PaddleOCR 本地 CPU（mock）")):
            result = analyze({"mode": " UPLOAD ", "imageData": data_url("image/jpeg", raw_jpeg)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["mode"], "local-ocr")
        self.assertEqual(result["inferenceStatus"], "executed")
        self.assertEqual(result["capabilities"]["plateOcr"], "executed")
        self.assertEqual(result["arrivalRecognition"]["status"], "recognized")
        self.assertEqual(result["arrivalRecognition"]["plate"], "京A88888")
        self.assertAlmostEqual(result["confidence"], 0.96)

    def test_safe_env_parsers_tolerate_empty_and_invalid_values(self):
        with mock.patch.dict(os.environ, {"CV_TEST_INT": "", "CV_TEST_FLOAT": "not-a-float"}):
            self.assertEqual(_env_int("CV_TEST_INT", 1600, 640, 2400), 1600)
            self.assertEqual(_env_float("CV_TEST_FLOAT", 15.0, 5.0, 60.0), 15.0)
        with mock.patch.dict(os.environ, {"CV_TEST_INT": "99999", "CV_TEST_FLOAT": "nan"}):
            self.assertEqual(_env_int("CV_TEST_INT", 1600, 640, 2400), 2400)
            self.assertEqual(_env_float("CV_TEST_FLOAT", 15.0, 5.0, 60.0), 15.0)

    def test_plate_text_is_normalized_and_format_checked(self):
        self.assertEqual(_normalize_ocr_text("车牌号：京A·12345"), "京A12345")
        valid, raw = _plate_candidates([{"text": "车牌号：京A·12345", "score": 0.91}])
        self.assertEqual(valid[0]["plate"], "京A12345")
        self.assertEqual(valid[0]["score"], 0.91)
        self.assertEqual(raw[0]["text"], "京A12345")

    def test_invalid_plate_text_is_not_promoted_to_a_result(self):
        valid, _ = _plate_candidates([{"text": "京A1234", "score": 0.99}])
        self.assertEqual(valid, [])

    def test_ocr_init_and_runtime_summary_are_synchronized_under_init_lock(self):
        build_calls = 0
        build_entered = threading.Event()
        release_build = threading.Event()
        summary_result: dict[str, object] = {}

        def fake_build():
            nonlocal build_calls
            build_calls += 1
            build_entered.set()
            release_build.wait(timeout=2.0)
            return object(), "PaddleOCR 本地 CPU（thread-safe）"

        with mock.patch.object(app, "_OCR_ENGINE", None), \
             mock.patch.object(app, "_OCR_ENGINE_LABEL", ""), \
             mock.patch.object(app, "_OCR_INIT_ERROR", "STALE_ERROR"), \
             mock.patch.object(app, "_build_ocr_engine", side_effect=fake_build):
            results: list[tuple[object, str]] = []
            errors: list[Exception] = []

            def worker():
                try:
                    results.append(_get_ocr_engine())
                except Exception as exc:  # pragma: no cover
                    errors.append(exc)

            def reader():
                summary_result["value"] = runtime_summary()

            t1 = threading.Thread(target=worker)
            t2 = threading.Thread(target=worker)
            t1.start()
            self.assertTrue(build_entered.wait(timeout=2.0))
            t2.start()
            t_read = threading.Thread(target=reader)
            t_read.start()
            release_build.set()
            t1.join(timeout=2.0)
            t2.join(timeout=2.0)
            t_read.join(timeout=2.0)

            self.assertEqual(errors, [])
            self.assertEqual(build_calls, 1)
            self.assertEqual(len(results), 2)
            self.assertIs(results[0][0], results[1][0])
            self.assertEqual(results[0][1], "PaddleOCR 本地 CPU（thread-safe）")
            self.assertEqual(results[1][1], "PaddleOCR 本地 CPU（thread-safe）")
            snap = summary_result["value"]
            assert isinstance(snap, dict)
            self.assertTrue(snap["ocrLoaded"])
            self.assertNotIn("ocrInitError", snap)

    def test_analyze_video_holds_ocr_run_lock_once_across_all_frames(self):
        raw = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2"
        payload = {"mode": "video", "videoData": data_url("video/mp4", raw)}

        class FakeFrame:
            shape = (480, 640, 3)

        class FakeCv2MultiFrame:
            CAP_PROP_FPS = 5
            CAP_PROP_FRAME_WIDTH = 3
            CAP_PROP_FRAME_HEIGHT = 4

            class VideoCapture:
                def __init__(self, _path):
                    self.count = 0

                def isOpened(self):
                    return True

                def get(self, prop):
                    if prop == 5:
                        return 2.0
                    if prop == 3:
                        return 640.0
                    if prop == 4:
                        return 480.0
                    return 0.0

                def read(self):
                    if self.count >= 3:
                        return False, None
                    self.count += 1
                    return True, FakeFrame()

                def release(self):
                    pass

        class TrackingSemaphore:
            def __init__(self):
                self.held = False
                self.acquire_calls = 0
                self.release_calls = 0

            def acquire(self, timeout=None):
                self.acquire_calls += 1
                if self.held:
                    return False
                self.held = True
                return True

            def release(self):
                self.release_calls += 1
                self.held = False

        tracker = TrackingSemaphore()
        frame_locked_states: list[bool] = []

        class FakeEngine:
            def predict(self, _img):
                # Lock MUST remain held throughout every sampled frame
                frame_locked_states.append(tracker.held)
                return [{"rec_texts": ["京A12345"], "rec_scores": [0.95]}]

        with mock.patch.object(app, "cv2", FakeCv2MultiFrame), \
             mock.patch.object(app, "_OCR_RUN_LOCK", tracker), \
             mock.patch.object(app, "_resize_image", side_effect=lambda f: f), \
             mock.patch.object(app, "_get_ocr_engine", return_value=(FakeEngine(), "FakeOCR")):
            result = analyze(payload)
            self.assertEqual(result["mode"], "local-video-ocr")
            self.assertEqual(result["arrivalRecognition"]["plate"], "京A12345")
            self.assertEqual(tracker.acquire_calls, 1)
            self.assertEqual(tracker.release_calls, 1)
            self.assertFalse(tracker.held)
            self.assertEqual(frame_locked_states, [True, True, True])

            # When lock is already held, _analyze_video raises OcrBusyError immediately
            tracker.held = True
            with self.assertRaises(OcrBusyError):
                analyze(payload)
            self.assertEqual(tracker.release_calls, 1)

    def test_ocr_init_and_inference_always_execute_on_same_dedicated_thread(self):
        build_tids: list[int] = []
        predict_tids: list[int] = []
        caller_tids: list[int] = []

        class ThreadCheckedEngine:
            def __init__(self, owner_tid: int):
                self.owner_tid = owner_tid

            def predict(self, _img):
                tid = threading.get_ident()
                predict_tids.append(tid)
                if tid != self.owner_tid:
                    raise RuntimeError("std::exception")
                return [{"rec_texts": ["京KBT355"], "rec_scores": [0.99]}]

        def fake_build():
            tid = threading.get_ident()
            build_tids.append(tid)
            return ThreadCheckedEngine(tid), "PaddleOCR 本地 CPU（pinned）"

        with mock.patch.object(app, "_OCR_ENGINE", None), \
             mock.patch.object(app, "_OCR_ENGINE_LABEL", ""), \
             mock.patch.object(app, "_OCR_INIT_ERROR", ""), \
             mock.patch.object(app, "_build_ocr_engine", side_effect=fake_build):
            errors: list[Exception] = []
            results: list[list[dict[str, object]]] = []

            def request_worker():
                caller_tids.append(threading.get_ident())
                try:
                    records, _label = app._run_paddle_ocr("fake-image")
                    results.append(records)
                except Exception as exc:  # pragma: no cover
                    errors.append(exc)

            threads = [threading.Thread(target=request_worker) for _ in range(5)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=5.0)

        self.assertEqual(errors, [])
        self.assertEqual(len(build_tids), 1)
        self.assertEqual(len(predict_tids), 5)
        self.assertEqual(set(predict_tids), {build_tids[0]})
        self.assertNotIn(build_tids[0], caller_tids)
        self.assertTrue(all(rec[0]["text"] == "京KBT355" for rec in results))


def json_text(value):
    return str(value)


if __name__ == "__main__":
    unittest.main()
