简体中文 | [English](README.en.md)

# 能流智枢 · FlowTwin

[![CI](https://github.com/1Beyond1/flowtwin-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/1Beyond1/flowtwin-demo/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-22a06b.svg)](LICENSE)

> **AI 油电一体化补能协同决策工作台** — 从车主自然语言行程需求出发，串联多站续航规划、到站时刻 P50/P90 排队仿真、多目标补能对比、运营分流调度与可复现蒙特卡洛验证的全栈参考实现。

---

## 界面预览

### 车主端：行程补能智算（Trip Intelligence）

自然语言意图解析为结构化约束，结合真实地图路由（或内置离线走廊沙盒）与到站时刻 P50/P90 排队预测，生成「最快到达 / 最稳妥 / 最低成本」多目标补能方案对比：

![车主端行程补能智算界面](docs/screenshots/driver-trip-intelligence.png)

### 运营端：区域供需与策略台（Operator Intelligence）

将出行需求转化为站点侧的引流与定价策略，支持调整单笔优惠与目标分群、实时对比策略前后排队与场景 ROI，并可选对接飞书多维表格 AI 审批闭环：

![运营端区域供需与策略台界面](docs/screenshots/operator-dispatch.png)

### 移动端：响应式适配（Mobile Responsive）

针对 375–430 px 手机视口自适应排布，完整保留动力切换、出发时间、自然语言输入、结构化约束与可独立滚动的多方案抽屉：

<p align="center">
  <img src="docs/screenshots/mobile-responsive.png" alt="移动端响应式适配界面" width="320" />
</p>

---

## 核心特性

- **零密钥开箱可用（离线全链路 + 实况无缝升级）**：未配置外部 API Key 时自动启用内置 30+ 全国城市/枢纽离线坐标库、本地规则意图解析、本地内联 SVG 图标与离线走廊沙盒，车主规划、多站长途、模拟驾驶、运营调度与 1,000 次验证全链路可跑通；接入高德、OpenAI 兼容 LLM、语音转写与飞书后自动切换为实况模式。
- **自然语言意图解析与多轮规划**：支持中英文/中文自然语言解析目的地、到达时间/余量、油/电/混动动力类型、绕行上限、优先级与沿途餐饮/休息服务偏好，支持多轮追加停靠、修改约束与发起新行程；支持云端语音转写及浏览器原生语音识别降级。
- **长途连续补能与多途经点核验**：常规路线支持最多 6 站，极端长途自适应模式最多 12 站；联网模式优先调用高德路线 2.0 多途经点一次核验整条道路折线，服务端自带多级文件缓存（`runtime/cache/amap/`）。
- **到站时刻排队与端口级仿真**：按预计到站时刻计算站点占用率与 P50/P90 排队等待，采用统一停靠账本（`排队 + 补能服务时长 + 支付驶离缓冲`）；具备端口状态输入时启用端口级离散事件仿真并区分预约锁定与前置预约队列，同时融合实况天气因子动态修正排队压力。
- **运营分流沙盘与 1,000 次策略验证**：运营端基于合作站点容量与券窗口计算分流率、排队变化与场景 ROI；验证页以固定随机种子（默认 `20260719`）对 30 个合成节点执行 1,000 次行程实验，复现对比四种策略。
- **可选扩展能力**：支持飞书多维表格快照同步与 AI 字段策略解读、可选本地 CPU PaddleOCR 车牌识别服务（`cv-service/`）、以及私有离线需求先验加载（`runtime/enterprise-demand-prior.json`）。

---

## 系统架构

```text
浏览器（原生 HTML/CSS/JS，零构建、本地内联图标、按需加载高德 JS API）
  └─ Node.js 后端（零第三方运行时依赖）
      ├─ /api/health                       健康状态与外部依赖配置摘要（不返回密钥）
      ├─ /api/contracts                    API 路由契约说明
      ├─ /api/plan                         意图解析（AI/本地规则）+ 地点解析（高德/离线坐标库）
      ├─ /api/stt                          可选语音转写代理
      ├─ /api/route · /api/poi · /api/weather  高德路线、沿线 POI 与实况天气代理（带文件缓存）
      ├─ /api/forecast                     到站时刻排队仿真（端口级 / 聚合，支持天气因子）
      ├─ /api/longtrip                     多站连续补能组合规划
      ├─ /api/operator/simulate            优惠定价与分流仿真
      ├─ /api/validate                     1,000 次固定种子策略对比实验
      ├─ /api/cv/health · /api/cv/analyze  可选本地 CPU PaddleOCR 适配器
      ├─ /api/feishu/* · /api/execution    可选飞书多维表格 AI 联动与 Webhook 适配器
      └─ /api/version · /api/version/check 版本元数据与手动更新检查
```

---

## 快速开始

### 1. 本地直接启动（零外部依赖，开箱可试）

要求 **Node.js 20+**（推荐 22 LTS）：

```bash
npm start
```

打开 <http://127.0.0.1:4182/> 即可直接体验离线全链路；如需接入高德、AI 模型或飞书，可复制 [`.env.example`](.env.example) 为 `.env` 并填入对应 Key 后重启。

### 2. Docker Compose 一键启动

```bash
# 启动主服务
docker compose up --build

# 同时启用可选本地 CPU 视觉服务（PaddleOCR）
docker compose --profile cv up --build
```

---

## 运行测试

```bash
# Node.js 语法检查与全量单元测试
npm run check
npm test

# Python 视觉适配器标准库测试（无需安装 Paddle/OpenCV）
python -m compileall -q cv-service
python -m unittest discover -s cv-service -p "test_*.py" -v
```

---

## 延伸文档

- [架构与算法说明](docs/architecture.md)
- [部署、缓存与环境变量指南](docs/deployment.md)
- [飞书多维表格 AI 接入指南](docs/feishu-integration.md)
- [可选本地视觉服务说明](docs/vision-service.md)
- [CV 服务运行说明](cv-service/README.md)

## 许可证

项目源码基于 [MIT License](LICENSE) 开源。外部地图、第三方模型与开放平台服务不包含在本许可证范围内。
