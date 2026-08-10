import base64
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app import analyze, upload_metadata  # noqa: E402


def data_url(mime: str, raw: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


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


if __name__ == "__main__":
    unittest.main()
