# FlowTwin 本地视觉适配器

这是一个可选的本地 CPU 视觉服务，不是路线规划服务的必要依赖。

依赖文件固定了 `paddlepaddle==3.2.0` 与 `paddleocr==3.3.3`。这是有意的：PaddlePaddle 3.3.x 在 CPU 推理路径上存在 PIR/oneDNN 转换错误，不能在部署时使用无版本上限的安装命令。

## 当前真实能力

- 上传一张清晰、近距离的车牌图片；
- 在本地内存中解码和缩放图片；
- 使用 PaddleOCR 本地 CPU 模型执行文字识别；
- 对识别文本进行中国车牌格式校验；
- 返回真实识别结果、模型分数或明确的“未识别”；
- 上传短视频时使用 OpenCV 顺序解码，默认最多处理 15 秒、每秒抽取约 2 帧，并要求同一车牌至少命中 2 个采样帧才判定为稳定识别；
- 不保存图片、不记录请求体、不上传 SiliconFlow 或其他第三方。

视觉页的默认样板图位于 `assets/vision/default-camera-scene.png`。它是 AI 生成的模拟摄像头画面，只用于界面演示，不是企业真实监控数据。

当前**没有声称**已经完成：

- 整车远景中的车牌定位；
- 车辆检测；
- 车位检测；
- 真实摄像头接入；
- 真实支付扣款。

因此，照片模式要求上传清晰的车牌近照；视频模式只是“短视频抽帧 OCR”，不是 RTSP 常驻摄像头服务，也不会把 OCR 结果冒充成车辆/车位检测。整车远景的车牌定位需要后续增加专用轻量检测模型。

## 服务接口

- 默认监听 `127.0.0.1:5099`；
- `GET /health` 查看运行时能力，不返回密钥或模型绝对路径；
- `POST /analyze` 接收 `{ "mode": "upload" | "video", ... }`；没有图片或视频输入时不会生成样例识别结果；
- 上传原图上限为 4 MB；视频上限为 24 MB；JSON 请求上限为 36 MB；最长边默认缩放到 1600 像素；
- 视频上限为 24 MB；默认最多处理 15 秒、每秒抽取约 2 帧；视频只在本地临时文件中解码，处理结束后删除；
- 单进程只允许一个 OCR 推理占用，避免 8G VPS 同时加载或运行多个模型。
- CV HTTP 入口使用单线程 `HTTPServer`，让 PaddleOCR 的模型初始化、推理和释放生命周期整体串行；这不是生产并发方案，而是针对小规格 CPU 节点的稳定性保护。
- Node 主服务对短暂的 429、网关错误和本地 OCR 未就绪响应做有限重试；最终仍保留真实的“未执行/未识别”结果，不把失败伪装成成功。
- 服务响应不回传原图；浏览器使用上传时已有的本地预览，减少图片在服务端响应中的重复留存。

## 本地安装

在服务器或本机准备独立虚拟环境，不要把虚拟环境、模型权重或图片提交到 Git：

```powershell
python -m venv .\cv-service\.venv
& .\cv-service\.venv\Scripts\python.exe -m pip install -r .\cv-service\requirements-optional.txt
```

PaddleOCR 首次准备模型时可以下载权重；面向企业部署时，应把模型权重预置到服务器，并设置：

```text
CV_SERVICE_URL=http://127.0.0.1:5099
PADDLEOCR_LOCAL_ONLY=1
PADDLEOCR_TEXT_DET_MODEL_DIR=C:\path\to\local\det_model
PADDLEOCR_TEXT_REC_MODEL_DIR=C:\path\to\local\rec_model
# If a custom directory name does not equal the Paddle model name, set these too.
PADDLEOCR_TEXT_DET_MODEL_NAME=PP-OCRv4_mobile_det
PADDLEOCR_TEXT_REC_MODEL_NAME=PP-OCRv4_mobile_rec
```

`PADDLEOCR_LOCAL_ONLY=1` 会阻止没有本地模型目录时启动推理，避免运行时偷偷联网下载模型。

### Windows 本地启动说明

项目目录含中文时，Paddle 的底层推理组件在少数 Windows 环境中可能无法稳定读取模型文件。推荐把已预置的模型副本同步到 `%TEMP%\flowtwin-cv-models`（ASCII 路径），再将上述两个 `*_MODEL_DIR` 指向该目录；完整的可直接执行脚本见项目根目录的 `本地启动说明.md`。这不会下载模型，也不会把模型权重提交到 Git。

## 启动与测试

```powershell
& .\cv-service\.venv\Scripts\python.exe .\cv-service\app.py
& .\cv-service\.venv\Scripts\python.exe -m unittest discover -s cv-service -p "test_*.py"
```

Node 主服务只在配置 `CV_SERVICE_URL` 后把**上传图片或短视频**转发给本地服务。视觉页的内置样例也会作为图片上传到本地服务，和用户上传照片使用同一套 PaddleOCR 路径；服务不可用时只展示“未执行/未识别”，不会返回虚构车牌。

视频模式的资源边界：本机 CPU 基准（Windows x86_64，进程限制为 8 个逻辑 CPU，使用 PP-OCRv4 mobile）显示，10 秒、1280×720 视频按 2 FPS 抽取 20 帧约 6.8 秒完成，峰值 RSS 约 637 MB；这是单进程本机测试，不是实际 8C8G VPS 实测。进一步把进程限制为 1 个逻辑 CPU、线程数限制为 1 后，同一视频约 15.8 秒完成，峰值工作集约 609 MB；单张图片在模型热身后约 0.33–1.10 秒完成。由此只能把 1 vCPU/1 GB 视为低频单图片演示的下限，不能承诺视频、多路摄像头、常驻生产或并发服务。当前服务只支持“单路、低频抽帧演示”的容量判断，不能外推到多路摄像头 25/30 FPS 全帧实时 OCR，也不意味着每个站点都需要一台 8C8G 服务器。树莓派 ARM64 不在当前已验证矩阵内，现阶段建议作为摄像头采集/裁剪节点，把低频 ROI 送到已验证的 x86 CPU 服务；若要在树莓派端侧推理，需要另行验证 ARM64 推理引擎和模型。

SiliconFlow 的视觉 API 后续只能作为开发期 A/B 对照，不进入正式运行链路，也不会作为本地 OCR 的自动兜底。
