# Changelog

本文档记录 `FlowTwin（能流智枢）` 的主要版本变更，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本规范。

## [1.1.2] - 2026-11-26

### Added
- **车主与运营双向协同闭环**：新增错峰出发窗口优化、多车型补能费用账本、运营端 Pareto ROI 补贴曲线、分流券领券核销与视觉队列标注回流接口。
- **AI 出行助手增强**：支持 `AI_REASONING_EFFORT`、`AI_TIMEOUT_MS` 主备模型配置与出行领域提示词安全防护。
- **品牌与在线 Demo**：归档新版品牌 Logo 并在中英文 `README` 顶部展示，同步部署至 `https://demo.2222444.xyz/`。

### Fixed
- **CV 视觉服务稳定性**：将 Python PaddleOCR 服务初始化与推理固定至单一常驻工作线程，彻底修复多线程并发下的偶发推理失败。
- **全端红队收口**：完成桌面端、移动端与后端 API 三轮红队审计与公网 HTTPS 实测回归。
