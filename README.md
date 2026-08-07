# 能流智枢 FlowTwin

> AI 油电一体化补能协同决策 Demo

FlowTwin 面向能链命题，展示从车主自然语言需求到真实地图路线、补能站预测、多目标推荐、运营定价分流和实验验证的完整链路。

## 核心能力

- AI 模型将中文需求解析为目的地、可选的最晚到达时间/到达余量、油电类型、绕行上限、优先级和服务偏好；不会把上一趟行程的默认值当作新用户的硬约束。
- 支持可选语音输入：浏览器录音后由服务端转发到你配置的语音转写接口，并可清理常见情感/语言标签；密钥不会下发到浏览器。
- 高德地图提供真实底图、全国地理编码/地点检索、沿线补能 POI 和驾车路线；短地名会优先规范化常见景区，不完全吻合时给出目的地候选列表供点选。
- 支持长途连续补能，最多规划 6 次补能；当公开 POI 覆盖不足时，会给出明确标注“演示，需确认”的沿线候选，而不会伪装成真实充电设施。
- 后端生成未来 0–30 分钟、每 5 分钟一档的站点占用率与 P50/P90 等待预测；雨雪天气按高德实况抬高峰值等待（`weatherFactor`），不接天气时与原预测完全一致。
- 车主端比较最快、最可靠和最低成本三种路线，并解释时间、等待、绕行和费用权衡；长途非油服务提示会标明「主路线纯驾驶时长」与「途中休息建议」，避免误解为全程仅 2 小时。
- 运营端根据优惠金额和目标用户动态计算分流量、等待、优惠成本、增量毛利和 ROI。
- 验证页使用固定随机种子（默认 `20260719`）运行 30 个合成节点、1,000 次行程，对比四类策略；结果由算法实际计算，同一输入可复现。
- 运营端支持将当前演示快照写入飞书多维表格，并读取多维表格 AI 字段返回的运营策略；未配置时明确显示本地演示模式。旧版飞书机器人 Webhook 仍作为轻量通知适配器保留。

## 架构

```text
浏览器
  ├─ 高德 JS API：地图和 POI
  └─ Node.js 后端
      ├─ /api/plan              AI 意图解析 + 地点解析（地理编码/POI 评分 + 候选）
      ├─ /api/stt               语音转写代理（可选，密钥仅服务端）
      ├─ /api/route             高德经站路线代理
      ├─ /api/forecast          未来 30 分钟预测（含天气因子）
      ├─ /api/weather           高德实况天气（regeo→adcode→天气，按区县缓存）
      ├─ /api/longtrip          多站补能组合规划
      ├─ /api/operator/simulate 定价与分流仿真
      ├─ /api/validate          1,000 次策略实验
      ├─ /api/feishu/sync       写入飞书多维表格并创建分析批次
      ├─ /api/feishu/sync/:id   读取飞书 AI 字段结果
      ├─ /api/feishu/health     只返回配置状态，不返回密钥
      └─ /api/execution         飞书 Webhook 通知适配器（可选）
```

模型只负责理解意图和生成解释，不直接伪造地图路线或经营指标。路线由高德计算，预测、策略和验证由后端算法计算。

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

`config.local.js` 中对应字段为 `aiBaseUrl` / `aiApiKey` / `aiModel`、可选的 `aiBackupBaseUrl` / `aiBackupApiKey` / `aiBackupModel`、`sttApiKey` / `sttBaseUrl` / `sttModel`、`feishuAppId` / `feishuAppSecret` / `feishuAppToken` 等，含义相同，仍用你自己的值覆盖示例。备用 AI 只有在主接口失败时才会请求，主接口成功时不会额外消耗备用额度；两套 Key 都只在服务端读取。

高德 Web Service Key 按主用、备用顺序读取。只有配额超限、请求过频、临时 HTTP 错误或网络错误时才尝试备用 Key；参数错误、平台不匹配、域名/IP 白名单错误不会被自动轮换掩盖。浏览器只加载一套 JS Key，JS Key 和安全密钥需要在高德控制台绑定正式域名。

### 飞书多维表格字段

启用同步前，在同一个 Base 中创建三张表：`站点运营快照`、`运营策略`、`同步记录`。代码默认使用中文字段名，字段名和 AI 字段需要与下表一致；`同步记录`表为可选，缺少时不影响快照和策略表同步。

- `站点运营快照`：运行批次、快照时间、站点ID、站点名称、城市、能源类型、站点容量、当前占用、15分钟到达、服务率、P50等待、P90等待、价格、优惠、分流率、ROI、数据来源、数据时点。
- `运营策略`：策略ID、运行批次、拥堵站、承接站、目标、优惠金额、预计分流、预计等待变化、预计ROI、策略输入、风险说明、审批状态、创建时间，以及一个名为 `AI策略` 的 AI 字段。
- `同步记录`：同步ID、运行批次、同步状态、开始时间、完成时间、写入数量、AI状态、错误信息。

`AI策略` 只根据当前记录字段分析，不生成不存在的实时经营数据。页面会明确显示“FlowTwin 演示仿真”和同步时间。

完整的建表、权限、AI 字段提示词和联调顺序见 [`docs/飞书多维表格AI接入配置.md`](docs/飞书多维表格AI接入配置.md)。

所有服务端密钥只从环境变量或被 Git 忽略的 `config.local.js` 读取，不会返回浏览器，也不会写入日志。`/runtime-config.js` 仅暴露 `amapKey`、`securityJsCode`、`mapMode` 以及可选的 `sttEnabled` 布尔值，从不下发 STT/AI/Web Service Key。

## 数据边界

- 真实数据：高德地图底图、POI 名称与坐标、地理编码、道路和经站路线、起点区县实况天气。
- 高德主路线可以真实核验；若出现“沿线补能兜底候选”，其站点设备信息尚未确认，页面会明确标注为演示候选。
- 演示仿真：站点实时占用率、到达率、服务率、价格、等待预测、优惠、订单和 ROI。
- 实验数据：30 个合成补能节点、1,000 次固定种子行程，用于可复现的方案比较。
- 企业数据：入围后可将仿真字段替换为能链提供的脱敏交易和站点流量数据。

## 演示流程

1. 输入：“从能链北京总部前往上海东方明珠广播电视塔，优先准时”，观察不设最晚时间和到达余量时的全国长途补能方案。
2. 在“到达要求（可选）”中手动填写最晚时间或到达余量，重新规划并比较约束带来的变化。
3. 点击 AI 按钮，观察结构化约束、真实路线和三种补能方案自动更新。
4. 查看推荐站点未来 30 分钟 P50/P90 预测和到站服务建议；接受非油服务后右侧会锚定「非油服务智能推荐」。
5. 进入“运营”，调整优惠与目标用户，重新计算供需响应。
6. 点击“同步至飞书 AI”，查看快照写入多维表格并等待 AI 字段返回运营策略；飞书未配置时保留本地结果。
7. 进入“验证”，查看四种策略在 1,000 次合成行程中的实际计算结果。

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

高德 JS Key 应设置域名白名单和调用配额。

飞书应用凭据、Bitable App Token 和 Web Service Key 只放在服务器环境变量或被 Git 忽略的 `config.local.js` 中。线上部署时保留现有私密配置，只替换源码；不要把本机配置文件、日志或密钥备份一起上传。

## License

项目代码由 `1Beyond1` 版权所有，采用 MIT License。高德地图、第三方 API、模型服务和其他外部资源不包含在本许可证授权范围内。
