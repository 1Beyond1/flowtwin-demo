简体中文 | [English](README.en.md)

# 能流智枢 FlowTwin

> AI 油电一体化补能协同决策 Demo · v1.1.1

FlowTwin 面向能链命题，展示从车主自然语言需求到真实地图路线、补能站预测、多目标推荐、运营分流和实验验证的完整链路；首次访问可选择评委模式或用户模式，随后可选择能链总部或浏览器当前位置作为本次起点，设置页也可随时切换。

## 界面预览

### 车主端：行程补能智算（Trip Intelligence）

自然语言意图解析为结构化约束，结合高德真实路线与站点到站时刻 P50/P90 排队预测，生成「最快到达 / 最可靠 / 最低成本」多目标补能方案对比：

![车主端行程补能智算界面](docs/screenshots/driver-trip-intelligence.png)

### 运营端：区域供需与策略台（Operator Intelligence）

将车主侧出行意图转化为站点侧的引流与定价策略，支持调整单笔优惠与目标用户分群、对比策略前后排队与分流响应，并串联飞书审批执行闭环：

![运营端区域供需与策略台界面](docs/screenshots/operator-dispatch.png)

### 移动端：响应式适配（Mobile Responsive）

针对 360–430 px 手机视口自适应排布，保留完整的自然语言输入、结构化约束与可独立滚动的底部多方案抽屉：

<p align="center">
  <img src="docs/screenshots/mobile-responsive.png" alt="移动端响应式适配界面" width="320" />
</p>

## 核心能力

- **自然语言意图解析与多轮规划**：AI 模型将中文需求解析为目的地、最晚到达时间/到达余量、油电类型、绕行上限、优先级与沿途服务偏好，支持多轮追加服务、增加途经点、修改约束、删除停靠点或发起新行程；路线与优化由高德及后端确定性算法完成。
- **双展示模式与起点选择**：支持「评委模式」（展示数据来源、计算依据与运营验证信息）与「用户模式」（聚焦路线、补能、安全与服务建议）一键切换；首次访问可选择能链总部或浏览器当前定位作为起点（定位不可用时自动回退至能链总部），并可在设置页随时切换与重算。
- **版本信息与可选语音输入**：设置页显示当前版本、短 commit 与构建来源，支持手动检查 GitHub 更新；支持可选语音输入，浏览器录音由服务端代理转发至配置的语音转写接口，支持自动进入规划流程或仅填充输入框，密钥仅保留在服务端。
- **高德真实地图与多级缓存**：集成高德底图、全国地理编码/地点检索、沿线补能 POI、实况天气与驾车路线；模糊短地名提供候选列表供点选。服务端将路线、POI、地理编码与天气结果缓存于 `runtime/cache/amap/`（Git 忽略且不对外暴露）；浏览器额外保留 5 分钟同条件方案快照以加速刷新复用。
- **长途连续补能与多途经点核验**：常规路线支持最多 6 站规划，超长途自适应模式单次最多核验 12 站；优先使用高德路线 2.0 有序多途经点一次核验整条道路折线并按途经点拆分真实里程与 ETA，超限时自动回退逐段路线查询。地图界面分阶段展示路线骨架、候选提取、到站压力、多站组合与逐段安全核验。
- **到站时刻排队与端口级仿真**：按预计到站时刻生成站点占用率与 P50/P90 排队预测，采用统一停靠账本（`排队 + 补能服务时长 + 支付驶离缓冲`）评估路线 ETA 与可行性；具备端口状态输入时启用端口级离散事件仿真（区分可用/预约/充电中/故障枪位与预约队列），否则使用聚合流量仿真，并结合高德实时雨雪天气通过 `weatherFactor` 动态修正排队压力。
- **多目标推荐与执行闭环**：围绕最快到达、最稳妥与最低成本三个目标对比驾驶、排队、服务、绕行与费用权衡，相同路线自动合并目标标签去重。评委模式串联「预测 → 模拟预约 → 本地 OCR → 演示结算 → 运营复盘」完整决策链，支持模拟驾驶与跳过单站演示，到达终点后一键进入运营复盘。
- **运营分流沙盘与 1,000 次策略验证**：运营端围绕平台券、目标用户分群与流量引导计算容量约束、分流响应、排队变化与场景 ROI；验证页使用固定随机种子（默认 `20260719`）对 30 个合成节点、1,000 次行程对比四类策略，结果完全可复现。
- **飞书多维表格 AI 联动**：支持将演示运营快照写入飞书多维表格，读取多维表格 AI 字段返回的策略解读并回写审批状态，独立追踪本地沙盘与飞书 AI 状态；同时保留飞书机器人 Webhook 通知适配器。
- **轻量本地视觉验证（评委模式）**：接入可选本地 PaddleOCR 服务后，可对内置样例、上传照片或短视频执行车牌识别。

### 响应式适配

页面按 CSS 视口自适应排布，路线抽屉具备独立滚动区，平板与移动端自动区分地图与操作区并保持模拟驾驶工具箱在视口内。布局已覆盖 1280×720 至 3840×2160 桌面分辨率、768×1024 / 1024×768 平板及 360–430 px 手机视口（含 DPR 2 抽检）。

## 架构

```text
浏览器
  ├─ 高德 JS API：地图和 POI
  └─ Node.js 后端
      ├─ /api/health                       服务健康与 AI/CV/企业先验配置状态（不返回密钥）
      ├─ /api/contracts                    API 契约描述
      ├─ /api/plan                         AI 意图解析 + 地点解析（地理编码/POI 评分 + 候选）
      ├─ /api/stt                          语音转写代理（可选，密钥仅服务端）
      ├─ /api/route                        高德经站路线代理
      ├─ /api/poi                          高德沿线周边/文本 POI 检索代理
      ├─ /api/forecast                     到站时刻排队仿真预测（聚合/端口级，含天气因子）
      ├─ /api/weather                      高德实况天气（regeo→adcode→天气，文件缓存）
      ├─ /api/longtrip                     多站补能组合规划
      ├─ /api/operator/simulate            定价与分流仿真
      ├─ /api/validate                     1,000 次策略实验
      ├─ /api/cv/health                    可选本地视觉服务状态（不返回密钥）
      ├─ /api/cv/analyze                   内置样例/上传图片或视频的视觉分析适配器
      ├─ /api/feishu/sync                  写入飞书多维表格并创建分析批次
      ├─ /api/feishu/sync/:id              读取飞书 AI 字段结果
      ├─ /api/feishu/strategy/:id/approve  审批并写回飞书策略状态
      ├─ /api/feishu/health                只返回配置状态，不返回密钥
      └─ /api/execution                    飞书 Webhook 通知适配器（可选）
```

`/api/version` 返回当前版本，`/api/version/check` 用于设置页手动检查 GitHub 更新。主备 AI 均通过 OpenAI-compatible 接口调用，路线由高德计算，预测、策略与验证由后端算法完成。

## 本地运行

要求 Node.js 20+，无第三方运行时依赖。

1. 将 `config.example.js` 复制为 `config.local.js`，或使用环境变量配置服务。
2. 启动：

```powershell
npm start
```

3. 打开终端输出的本地地址（默认 <http://127.0.0.1:4182/>）。

### 环境变量

以下均为**占位示例**，请换成你自己的服务地址、Key 与模型名。主 AI 需兼容 OpenAI 风格的 `POST {AI_BASE_URL}/chat/completions`；备用 AI 使用同样的协议，只有主接口失败时才调用。语音转写需兼容 `POST {STT_BASE_URL}/audio/transcriptions`（multipart：`file` + `model`）。

```env
# 高德
AMAP_JS_KEY=your_amap_web_js_key
AMAP_SECURITY_JS_CODE=your_amap_security_js_code
AMAP_WEB_SERVICE_KEY_PRIMARY=your_primary_amap_web_service_key
AMAP_WEB_SERVICE_KEY_BACKUP=your_backup_amap_web_service_key

# 意图解析（任意 OpenAI-compatible 接口）
AI_BASE_URL=https://your-ai-gateway.example.com/v1
AI_API_KEY=your_ai_api_key
AI_MODEL=your_chat_model_name

# 可选备用 AI：仅主接口失败时启用
AI_BACKUP_BASE_URL=https://your-backup-ai-gateway.example.com/v1
AI_BACKUP_API_KEY=your_backup_ai_api_key
AI_BACKUP_MODEL=your_backup_chat_model_name

# 可选：语音转写（任意兼容 /audio/transcriptions 的网关）
# 也可用 SILICONFLOW_API_KEY / SILICONFLOW_BASE_URL / SILICONFLOW_STT_MODEL 作为别名
STT_API_KEY=your_stt_api_key
STT_BASE_URL=https://your-stt-gateway.example.com/v1
STT_MODEL=your_speech_to_text_model

# 可选：本地 CPU 视觉适配器（留空时关闭本地 OCR）
CV_SERVICE_URL=

# 可选：飞书
FEISHU_WEBHOOK_URL=

# 可选：飞书多维表格 + AI 字段
FEISHU_BASE_URL=https://open.feishu.cn
FEISHU_APP_ID=your_feishu_app_id
FEISHU_APP_SECRET=your_feishu_app_secret
FEISHU_BITABLE_APP_TOKEN=your_feishu_bitable_app_token
FEISHU_SNAPSHOT_TABLE_ID=your_snapshot_table_id
FEISHU_STRATEGY_TABLE_ID=your_strategy_table_id
FEISHU_SYNC_TABLE_ID=your_optional_sync_table_id
FEISHU_AI_STRATEGY_FIELD=AI策略
FEISHU_APPROVAL_FIELD=审批状态

PORT=4182
```

`config.local.js` 中对应字段为 `aiBaseUrl` / `aiApiKey` / `aiModel`、可选的 `aiBackupBaseUrl` / `aiBackupApiKey` / `aiBackupModel`、`sttApiKey` / `sttBaseUrl` / `sttModel`、可选的 `cvServiceUrl`、`feishuAppId` / `feishuAppSecret` / `feishuAppToken` 等，含义相同，仍用你自己的值覆盖示例。备用 AI 只有在主接口失败时才会请求，主接口成功时不会额外消耗备用额度；两套 Key 都只在服务端读取。

浏览器当前位置需要用户主动授权，并且只在 `https://` 或 `localhost` 等安全上下文中可用。高德 JS Key 可用时，系统会把浏览器坐标转换为高德坐标并反向解析附近地址；解析失败不影响坐标规划，但页面会明确显示“地址未解析”。

公开 Demo 建议设置 `FLOWTWIN_PUBLIC_DEMO=1`：路线、预测、运营仿真和视觉验证仍可使用，但飞书多维表格写入、飞书结果读取、策略写回和 Webhook 执行通知会降级为本地演示，避免匿名访问触发外部写操作。若需要在线展示飞书 AI，应在 VPS 侧先放到 Cloudflare Access 或其他后台鉴权之后，再关闭这个开关。`/api/cv/analyze`、运营仿真、1,000 次验证和飞书状态轮询均有独立的按客户端 IP 限流；可通过 `FLOWTWIN_RATE_LIMIT_*` 调整，默认十分钟窗口。

### 可选视觉服务

Node 主服务不依赖 Python、OpenCV 或 Paddle。如需启用本地 PaddleOCR 车牌识别，可按 [`cv-service/README.md`](cv-service/README.md) 启动 `127.0.0.1:5099` 并在配置中设置 `CV_SERVICE_URL`。仓库不包含模型权重；上传图片仅在请求内存中处理，校验 PNG/JPEG/WebP 文件头。

高德文件缓存默认 TTL：路线 60 分钟、POI 24 小时、地点解析 7 天、地理编码 30 天、天气 10 分钟（上游不可用时在容忍窗口内回退缓存）。高德 Web Service Key 按主备顺序读取，仅在配额超限、限流、临时 HTTP 或网络错误时切换备用 Key。

### 可选企业需求先验

公开仓库仅包含先验加载、匹配、回退与测试代码，不含原始数据集或导出先验。私有部署时可将离线导出的 `enterprise-demand-prior.json` 放置于：

```text
runtime/enterprise-demand-prior.json
```

可通过 `GET /api/health` 查看加载状态；文件存在且站点匹配时预测来源标记为 `enterprise-prior+simulation`，否则自动回退至 `simulation`。详细部署说明见 [`docs/企业需求先验本地部署.md`](docs/企业需求先验本地部署.md)，端口状态与预约队列口径见 [`docs/站点状态与预约队列演示口径.md`](docs/站点状态与预约队列演示口径.md)。

### 飞书多维表格字段

启用同步前，在同一个 Base 中创建三张表：`站点运营快照`、`运营策略`、`同步记录`（`同步记录` 表可选）。代码默认使用中文字段名：

- `站点运营快照`：运行批次、快照时间、站点ID、站点名称、城市、能源类型、站点容量、当前占用、15分钟到达、服务率、`P50等待`、`P90等待`、价格、优惠、分流率、ROI、数据来源、数据时点（其中“等待”指排队口径）。
- `运营策略`：策略ID、运行批次、拥堵站、承接站、目标、优惠金额、预计分流、`预计等待变化`、预计ROI、策略输入、风险说明、审批状态、创建时间，以及名为 `AI策略` 的 AI 字段。
- `同步记录`：同步ID、运行批次、同步状态、开始时间、完成时间、写入数量、AI状态、错误信息。

完整的建表、权限、AI 字段提示词和联调顺序见 [`docs/飞书多维表格AI接入配置.md`](docs/飞书多维表格AI接入配置.md)。

所有服务端密钥只从环境变量或被 Git 忽略的 `config.local.js` 读取，不会返回浏览器或写入日志（`/runtime-config.js` 仅暴露 `amapKey`、`securityJsCode`、`mapMode` 与 `sttEnabled`）。

## 数据来源说明

- **实时外部数据**：高德地图底图、POI 名称与坐标、地理编码、驾车与多途经点路线、起点区县实况天气。
- **站点与运营仿真**：站点占用率、到达率/服务率、端口快照、到站时刻排队预测、模拟预约、优惠与场景 ROI 由本地仿真模型生成。
- **可复现实验集**：30 个合成补能节点与 1,000 次固定种子行程，用于四类策略对比。
- **可选离线需求先验**：私有部署 `runtime/enterprise-demand-prior.json` 后，以“季节性基线 + HistGradientBoosting 残差回归”（留出集 WAPE ~17.85%，滚动验证均值 ~13.14%）调节到达强度与繁忙风险。
- **可选视觉链路**：配置本地 PaddleOCR 服务后执行车牌识别，原始上传媒体仅在内存中处理，不落盘保存。

## 演示流程

1. 输入一个全国范围的起点和目的地，观察不设最晚时间和到达余量时的长途补能方案。
2. 在“到达要求（可选）”中手动填写最晚时间或到达余量，重新规划并比较约束带来的变化。
3. 点击输入框右侧的提交箭头，观察结构化约束、真实路线和按三个目标计算、去重后的可行补能方案自动更新。
4. 在已有路线基础上点击左侧“体验多轮 AI 补充”，或输入“中途想先吃麦当劳，然后再找个咖啡店”，触发多轮 AI 语义解析与规则复核；输入全新目的地时创建新行程。
5. 查看推荐站点按预计到站时刻计算的 P50/P90 预测与服务建议；在电站详情点击“模拟预约”观察预约队列对等待预测的影响。
6. 进入“运营”，调整平台券与目标用户，重新计算推荐分流和场景响应。
7. 点击“开始智能分析”，运行本地分流仿真，并在配置飞书多维表格后读取 AI 字段返回的策略解读。
8. 进入“验证”，查看四种策略在 1,000 次合成行程中的对比结果；在设置页切换评委/用户模式或检查 GitHub 版本。
9. 在评委模式进入“视觉”，使用内置样例或上传图片/短视频测试本地 OCR 识别链路。

## 检查

```powershell
npm run check
npm test
```

## VPS 部署

1. 上传源码（不要上传 `config.local.js` / `.env`）。
2. 在服务器用**既有**环境变量或私密配置注入密钥（保留线上已有配置，不要用开发机 `config.local.js` 覆盖）。
3. `npm run check && npm test && npm start`（或按现有 PM2/systemd 重启）。
4. Nginx / Caddy 继续反向代理到 `PORT`；域名与证书不必改。

### 版本标识

部署包通常不携带 `.git`，因此发布时应在 release 目录写入不含密钥的 `runtime/build-info.json`，或在 systemd 环境中设置 `FLOWTWIN_COMMIT` 与 `FLOWTWIN_BUILD_TIME`。推荐使用当前发布 commit 生成：

```json
{
  "commit": "<发布到服务器的完整 commit>",
  "buildTime": "<UTC ISO 8601 时间>"
}
```

`runtime/` 已被 Git 忽略且不会被静态文件路由公开。设置页的“短 commit”与发布 commit 前 7 位对应，未配置元数据时自动提示缺少提交标识。

高德 JS Key 应设置域名白名单和调用配额。

飞书应用凭据、Bitable App Token 和 Web Service Key 只放在服务器环境变量或被 Git 忽略的 `config.local.js` 中。线上部署时保留现有私密配置，只替换源码；不要把本机配置文件、日志或密钥备份一起上传。

## License

项目代码由项目作者版权所有，采用 [MIT License](LICENSE)。高德地图、第三方 API、模型服务和其他外部资源不包含在本许可证授权范围内。
