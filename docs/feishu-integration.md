# 飞书多维表格 AI 接入指南

FlowTwin 支持将运营仿真快照写入飞书多维表格（Bitable），读取策略表中配置的飞书 AI 字段结果并写回审批状态。未配置飞书凭据时，运营端本地仿真仍可完整运行。

## 1. 准备工作

1. 在飞书开放平台创建自建应用，获取 `App ID` 与 `App Secret`。
2. 为应用开通多维表格记录读取、创建与更新相关权限（参考[飞书开放平台权限列表](https://open.feishu.cn/document/server-docs/application-scope/scope-list?lang=zh-CN)）。
3. 创建目标 Base，并将该 Base 显式授权给上述应用。
4. 在 Base 中建立两张必需数据表（`站点运营快照`、`运营策略`）与一张可选日志表（`同步记录`）。

## 2. 数据表结构

服务端按字段名称匹配，不依赖列顺序。建议普通业务字段使用「文本 / 数字 / 日期时间」类型。

### 站点运营快照（必需）

字段：`运行批次`、`快照时间`、`站点ID`、`站点名称`、`城市`、`能源类型`、`站点容量`、`当前占用`、`15分钟到达`、`服务率`、`P50等待`、`P90等待`、`价格`、`优惠`、`分流率`、`ROI`、`数据来源`、`数据时点`（`P50等待`/`P90等待` 为排队等待口径）。

### 运营策略（必需）

- 普通字段：`策略ID`、`运行批次`、`拥堵站`、`承接站`、`目标`、`优惠金额`、`预计分流`、`预计等待变化`、`预计ROI`、`策略输入`、`风险说明`、`审批状态`、`创建时间`。
- AI 字段：默认名为 `AI策略`（可通过 `FEISHU_AI_STRATEGY_FIELD` 自定义）。推荐提示词：

```text
你是补能网络运营分析助手，仅依据当前记录中的已有字段给出建议，不编造实时数据。
请输出：
1. 当前最需关注的拥堵站及依据；
2. 是否建议将需求引导至承接站；
3. 建议的优惠力度与适用分群；
4. 预计收益与容量风险；
5. 需要人工复核的边界。
若数据来源标记为仿真估算，请在结论中如实注明。
```

### 同步记录（可选）

字段：`同步ID`、`运行批次`、`同步状态`、`开始时间`、`完成时间`、`写入数量`、`AI状态`、`错误信息`。未配置表 ID 时自动跳过，不影响快照、策略与 AI 字段轮询。

## 3. 环境变量配置

仅在服务端环境变量或被 Git 忽略的 `.env` 中配置，严禁暴露到前端代码或公开仓库：

```env
FEISHU_BASE_URL=https://open.feishu.cn
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_BITABLE_APP_TOKEN=
FEISHU_SNAPSHOT_TABLE_ID=
FEISHU_STRATEGY_TABLE_ID=
FEISHU_SYNC_TABLE_ID=
FEISHU_AI_STRATEGY_FIELD=AI策略
FEISHU_APPROVAL_FIELD=审批状态
```

> 公开部署若不希望匿名访客触发外部多维表格写入，请设置 `FLOWTWIN_PUBLIC_DEMO=1`，或在反向代理层接入身份鉴权。

## 4. 联调与核验接口

- `GET /api/feishu/health`：仅返回布尔配置状态，不返回任何凭据。
- `POST /api/feishu/sync`：写入快照与策略记录，创建异步轮询批次。
- `GET /api/feishu/sync/:syncId`：查询飞书 AI 字段生成状态与结果。
- `POST /api/feishu/strategy/:recordId/approve`：写回审批状态。
