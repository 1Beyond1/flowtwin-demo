# 可选本地视觉服务说明（CV Service）

Node.js 主服务不依赖 Python、OpenCV 或 PaddlePaddle。需要启用本地车牌 OCR 时，可独立运行 `cv-service/app.py`（默认监听 `127.0.0.1:5099`）并在主服务环境变量中设置 `CV_SERVICE_URL`。

## 1. 能力与安全边界

- **输入支持**：内置样板图（`assets/vision/default-camera-scene.jpg`）、用户上传图片（PNG/JPEG/WebP，单图上限 4 MB，Base64 请求体上限 8 MB）与短视频（默认最长 15 秒、约 2 FPS 受限抽帧）。
- **隐私与文件安全**：图片完全在内存中解码并校验真实魔数与像素尺寸上限，不持久化落盘；短视频经由临时文件解码后立即删除；不向第三方云端上传图像。
- **单槽并发控制**：服务采用 `ThreadingHTTPServer` 保证 `/health` 随时响应，同时用单并发推理锁防止多路 OCR 请求撑爆内存，超并发返回 `429 OCR_BUSY`。
- **结果状态枚举（`inferenceStatus`）**：
  - `executed`：本地 PaddleOCR 实际完成推理并返回结构化车牌结果；
  - `not-run`：视觉服务未启用或依赖/模型目录未就绪（返回明确原因码，不伪造车牌）；
  - `synthetic`：仅用于显式合成测试路径。

## 2. 启动与测试

标准库单元测试（无需安装 Paddle/OpenCV）：

```bash
python -m compileall -q cv-service
python -m unittest discover -s cv-service -p "test_*.py" -v
```

完整运行与依赖安装步骤见 [`cv-service/README.md`](../cv-service/README.md)；容器化方式可使用 `docker compose --profile cv up --build`。

## 3. CPU 实测基准参考

在 x86_64 CPU（Python 3.12、PaddlePaddle 3.2 CPU、PaddleOCR 3.3 PP-OCRv4 mobile 本地模型目录、单并发）约束下的本机参考表现：

| 配置约束 | 清晰近照 OCR（热态） | 站内样板图 OCR（热态） | 10 秒 720p 视频（2 FPS） | 峰值内存（RSS） |
| --- | ---: | ---: | ---: | ---: |
| 8 CPU 线程 | ~0.18 s | ~0.50 s | ~6.8 s（含初始化） | ~650 MB |
| 1 CPU 线程 | ~0.33 s | ~1.10 s | ~15.8 s | ~645 MB |

- 单进程低频图片 OCR 可在纯 CPU 节点运行，无需 GPU；
- 视频抽帧与多路实时摄像头接入需按并发做独立压测，不建议在 1 vCPU / 1 GB 规格上承载视频流。
