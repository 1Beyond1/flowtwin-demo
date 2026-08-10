# FlowTwin 可选本地视觉适配器

这是一个可选的本地 HTTP 适配器，不是路线规划服务的必要依赖。

## 默认行为

- Node 主服务默认不需要启动它；内置合成画面可以直接演示。
- 服务默认监听 `127.0.0.1:5099`。
- `GET /health` 查看 Python 运行时能力。
- `POST /analyze` 接收 `{ "mode": "sample" | "upload", ... }`。
- 上传原图上限为 4 MB；由于 Data URL 会膨胀，JSON 请求上限为 8 MB，避免浏览器、Node 和 Python 适配器各自使用不同边界。
- 上传图片会校验 PNG/JPEG/WebP 文件头，不会仅凭 MIME 类型接受任意字节。
- 没有模型权重时，只返回明确标注的适配器检查结果，不伪装为检测成功。
- 不保存上传图片，不记录请求体，不执行支付。

## 启动

```powershell
python .\cv-service\app.py
```

然后在本地私密配置中设置：

```text
CV_SERVICE_URL=http://127.0.0.1:5099
```

不要把该配置写入 Git，也不要把模型权重、虚拟环境或上传图片放进仓库。

运行适配器回归测试（只使用 Python 标准库）：

```powershell
python -m compileall -q cv-service
python -m unittest discover -s cv-service -p "test_*.py"
```

## 可选依赖

`requirements-optional.txt` 只提供 OpenCV/Pillow/Paddle 的适配方向。安装失败时保留 Node 内置合成模式，不应阻塞 FlowTwin 主服务。
