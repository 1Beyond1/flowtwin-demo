# FlowTwin 本地视觉适配器

这是一个可选的本地 CPU 视觉服务，不是路线规划服务的必要依赖。

依赖文件固定了 `paddlepaddle==3.2.0` 与 `paddleocr==3.3.3`。这是有意的：PaddlePaddle 3.3.x 在 CPU 推理路径上存在 PIR/oneDNN 转换错误，不能在部署时使用无版本上限的安装命令。

## 当前真实能力

- 上传一张清晰、近距离的车牌图片；
- 在本地内存中解码和缩放图片；
- 使用 PaddleOCR 本地 CPU 模型执行文字识别；
- 对识别文本进行中国车牌格式校验；
- 返回真实识别结果、模型分数或明确的“未识别”；
- 不保存图片、不记录请求体、不上传 SiliconFlow 或其他第三方。

当前**没有声称**已经完成：

- 整车远景中的车牌定位；
- 车辆检测；
- 车位检测；
- 真实摄像头接入；
- 真实支付扣款。

因此，第一版界面要求上传清晰的车牌近照。整车图片的车牌检测需要后续再增加专用轻量检测模型，不能用 OCR 结果冒充检测能力。

## 服务接口

- 默认监听 `127.0.0.1:5099`；
- `GET /health` 查看运行时能力，不返回密钥或模型绝对路径；
- `POST /analyze` 接收 `{ "mode": "sample" | "upload", ... }`；
- 上传原图上限为 4 MB；JSON 请求上限为 8 MB；最长边默认缩放到 1600 像素；
- 单进程只允许一个 OCR 推理占用，避免 8G VPS 同时加载或运行多个模型。
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
```

`PADDLEOCR_LOCAL_ONLY=1` 会阻止没有本地模型目录时启动推理，避免运行时偷偷联网下载模型。

## 启动与测试

```powershell
& .\cv-service\.venv\Scripts\python.exe .\cv-service\app.py
& .\cv-service\.venv\Scripts\python.exe -m unittest discover -s cv-service -p "test_*.py"
```

Node 主服务只在配置 `CV_SERVICE_URL` 后把**上传图片**转发给本地服务。内置合成画面仍由 Node 固定种子生成，不调用 OCR。

SiliconFlow 的视觉 API 后续只能作为开发期 A/B 对照，不进入正式运行链路，也不会作为本地 OCR 的自动兜底。
