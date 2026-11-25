# FlowTwin 部署、缓存与配置指南

本文档涵盖本地运行、Docker 容器部署、服务端缓存机制、反向代理限流配置及可选离线需求先验加载方式。

## 1. 启动方式

### 本地 Node.js 启动（零外部运行时依赖）

要求 **Node.js 20+**（推荐 Node 22 LTS）：

```bash
npm start
```

默认监听 `http://127.0.0.1:4182/`。不配置任何外部 API Key 时即可以离线走廊沙盒模式体验完整功能（含路线规划、多站补能、排队预测、模拟驾驶、运营调度与 1,000 次验证）。

### Docker Compose 启动

```bash
# 仅启动主服务（默认绑定宿主机 127.0.0.1:4182；如需对外暴露可显式设置 BIND_HOST=0.0.0.0）
docker compose up --build

# 如需同时启动可选本地 CPU 视觉服务（PaddleOCR），请同时传入容器网络地址 CV_SERVICE_URL
CV_SERVICE_URL=http://cv-service:5099 docker compose --profile cv up --build
```

容器默认以非 root 用户（`10001:10001`）运行，并设置 `HOST=0.0.0.0`、`HEALTHCHECK` 探测 `/api/health`。宿主机端口映射默认收口到 `${BIND_HOST:-127.0.0.1}:${PORT:-4182}:4182`。

## 2. 关键环境变量

完整清单见 [`.env.example`](../.env.example)。未使用的可选项保持留空即可（请勿保留占位文本）。

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `HOST` / `PORT` / `BIND_HOST` | 监听地址、端口与 Docker Compose 宿主机绑定地址（容器内设 `HOST=0.0.0.0`） | `127.0.0.1` / `4182` / `127.0.0.1` |
| `FLOWTWIN_DEFAULT_ORIGIN_NAME` / `_LNG` / `_LAT` | 默认起点名称与经纬度 | `北京国贸 CBD` (`116.461, 39.909`) |
| `AMAP_JS_KEY` / `AMAP_SECURITY_JS_CODE` | 高德 Web JS API Key 与安全密钥 | 空（启用离线矢量底图） |
| `AMAP_WEB_SERVICE_KEY_PRIMARY` / `_BACKUP` | 高德 Web Service 主备 Key（配额/限流自动切备） | 空（启用离线坐标库） |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | OpenAI 兼容意图解析模型（可配 `AI_BACKUP_*`） | 空（启用本地规则解析） |
| `STT_API_KEY` / `STT_BASE_URL` / `STT_MODEL` | 可选语音转写网关（`/audio/transcriptions`） | 空（浏览器原生识别降级） |
| `CV_SERVICE_URL` | 可选本地视觉服务地址（本地 `http://127.0.0.1:5099`，Compose `--profile cv` 用 `http://cv-service:5099`） | 空（禁用远程 OCR 请求） |
| `FLOWTWIN_PUBLIC_DEMO` | 设为 `1` 时禁止匿名触发飞书外写与 Webhook | `0` |
| `FLOWTWIN_TRUST_PROXY` | `0`（直连 IP）/ 整数跳数 `N`（右起第 N 跳 XFF）/ `cloudflare` | `0` |
| `FLOWTWIN_RATE_LIMIT_*` | 限流窗口与分接口阈值 | 10 分钟窗口 |
| `FLOWTWIN_REPO` | 设置页检查更新对应的 GitHub `owner/repo` | `1Beyond1/flowtwin-demo` |

## 3. 地图与方案多级缓存

服务端在 `runtime/cache/amap/` 下维护文件级标准化缓存（Git 忽略且被静态文件路由禁止访问），缓存键按请求类型与完整参数的 SHA-256 生成，不落盘任何 API Key 或鉴权头。

| 数据类型 | 正常有效期 | 上游不可用时的旧缓存回退窗口 |
| --- | ---: | --- |
| 驾车与多途经点路线 | 60 分钟 | 2 小时（标注旧缓存） |
| 周边 POI | 24 小时 | 7 天 |
| 地点文本检索 | 7 天 | 30 天 |
| 地理编码 / 逆地理编码 | 30 天 / 7 天 | 30 天 |
| 实况天气 | 10 分钟 | 2 小时 |
| 浏览器完整方案快照 | 5 分钟（单份） | 任一条件（含天气/预约）变化立即重算 |

- 同一时刻完全相同的上游请求在进程内自动去重，避免并发重复扣减配额；
- 多实例生产部署建议替换为 Redis 等共享缓存，并按业务需要缩短路线 TTL。

## 4. 可选离线需求先验

服务启动时会尝试加载 `runtime/enterprise-demand-prior.json`（不纳入公开仓库）。

- 文件存在且站点坐标匹配成功时，预测来源标记为 `enterprise-prior+simulation`，按油/电类型与预计到站小时调节到达强度；
- 文件缺失或站点未匹配时，自动回退为 `simulation`；
- 可通过 `GET /api/health` 查看 `dependencies.enterprisePrior` 加载摘要。

## 5. 发布版本元数据

部署包不包含 `.git` 目录时，可设置 `FLOWTWIN_COMMIT` 与 `FLOWTWIN_BUILD_TIME` 环境变量，或在发布目录生成 `runtime/build-info.json`：

```json
{
  "commit": "<完整 40 位发布 commit SHA>",
  "buildTime": "<UTC ISO 8601 时间>"
}
```
