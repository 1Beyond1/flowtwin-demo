# 视觉 CPU 基准与部署边界

更新时间：2026-08-15

这份记录用于约束方案和答辩中的硬件表述。它回答的是“当前本地 OCR 服务在 CPU 上能跑到什么程度”，不是对企业生产环境性能的承诺。

## 1. 测试条件

- 操作系统：Windows x86_64
- Python：3.12.13
- PaddlePaddle：3.2.0，`cuda_compiled=False`，运行设备为 `cpu`
- PaddleOCR：3.3.3
- 模型：PP-OCRv4 mobile detection + recognition，本地模型目录，不联网下载
- 进程限制：绑定 8 个逻辑 CPU，`OMP_NUM_THREADS=8`、`MKL_NUM_THREADS=8`
- OCR 并发：1。服务当前只保留一个推理槽位，避免多个模型/请求同时挤占内存

这相当于对“8 个 CPU 线程、单进程”的约束模拟，但不是把本机硬件伪装成真实 8 核 8 GB VPS。实际 VPS 还要重新核对 CPU 型号、内存、系统库、磁盘和其他服务占用。

## 2. 实测结果

| 输入 | 冷启动 | 模型已加载后的耗时 | 峰值 RSS | 结果 |
|---|---:|---:|---:|---|
| 清晰车牌近照 `cv-service/output/local-ocr-smoke.png` | 约 1.09 s | 约 0.16–0.19 s | 约 582 MB | 完成车牌 OCR；这是测试样图 |
| 默认监控样板图 `assets/vision/default-camera-scene.png` | 约 0.67 s | 约 0.48–0.54 s | 约 657 MB | 完成车牌 OCR；图片为 AI 生成演示素材 |
| 本地 1280×720、10 秒演示视频 | 含模型初始化约 6.8 s | 20 帧，2 FPS 抽帧 | 约 637 MB | 抽帧 OCR 执行成功 |

视频测试中，车牌主体字符大多可以读出，但省份字符在不同帧之间出现波动。这说明 CPU 和抽帧链路跑通了，不等于远景、低照度、运动模糊场景下已经具备稳定识别准确率。

## 3. 能得出的结论

1. **无需 GPU这一点在当前 OCR 路径上成立。** 本机使用 CPU 版 PaddlePaddle 完成了图片和短视频抽帧推理。
2. **可以支持“单进程、低频演示”的 8 GB 级 x86 CPU 节点。** 本次峰值内存低于 1 GB，但这只是本机基准，不能直接写成“实际 8C8G VPS 已验证”。
3. **不能把结论扩展成每个站点都配 8C8G。** 生产架构更合理的做法是摄像头侧做 ROI/抽帧，站点或区域共用一个 CPU 视觉服务，并通过队列限制并发。
4. **不能把当前视频结果写成实时多路视觉。** 当前服务默认最多处理 15 秒、约 2 FPS 抽帧，且 OCR 槽位为单并发；多路 RTSP、25/30 FPS 全帧处理仍需单独的边缘节点、专用检测模型和压测。

## 4. 树莓派边界

当前没有树莓派实机，不能声称“复制环境后即可直接运行”。PaddlePaddle 官方 Linux pip 安装说明当前以 x86_64/AMD64 作为默认处理器架构前提；PaddleOCR 的 CPU 安装文档也没有把树莓派 ARM64 列为本项目已验证路径。若要落到树莓派，建议分两步：

1. 第一阶段把树莓派定位为摄像头采集、裁剪和低频上传节点，OCR 继续放在已验证的 x86 CPU 服务上；
2. 第二阶段再评估导出到 ONNX Runtime、Paddle Lite 或其他 ARM64 推理后端，并在具体树莓派型号上实测延迟、内存和稳定性。

参考：

- [PaddleOCR 安装说明](https://www.paddleocr.ai/main/en/version3.x/installation.html)
- [PaddlePaddle Linux pip 安装说明](https://github.com/PaddlePaddle/docs/blob/develop/docs/install/pip/linux-pip_en.md)
- [PaddleOCR OCR 推理参数与 CPU 说明](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/OCR.html)

## 5. 方案中的推荐口径

推荐写成：

> 我们在本机以 CPU-only、8 个逻辑 CPU 约束完成了本地 PaddleOCR 图片和短视频抽帧基准，结果支持单进程、低频演示放在 8 GB 级 x86 CPU 节点的容量判断。该结果不是实际 VPS 压测，也不代表每个站点都需要一台 8C8G 服务器；树莓派 ARM64 仍需单独适配和验证。

不建议写成：

- “8 核 8 GB VPS 已经验证可以稳定承载生产流量”；
- “每个加油站只要部署一台 8C8G 服务器”；
- “树莓派可以直接运行当前 PaddleOCR 环境”；
- “当前短视频测试已经证明多路实时车牌识别”。
