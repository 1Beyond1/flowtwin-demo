[简体中文](README.md) | English

# FlowTwin

> AI-Assisted Integrated Fuel & EV Energy Replenishment Decision Demo · v1.1.1

FlowTwin demonstrates an end-to-end decision pipeline built around the NewLink (NaaS) challenge — from natural-language driver intent to real map routing, arrival-time station queue forecasting, multi-objective recommendation, operator load-balancing simulation, and reproducible strategy validation. On first visit, users choose between **Judge Mode** and **User Mode**, then pick either NewLink HQ or the browser's current geolocation as the trip origin (both can be switched anytime in Settings).

## Core Capabilities

- **Natural-language intent parsing & multi-turn actions**: An OpenAI-compatible AI model parses Chinese driver requests into destination, optional latest arrival time / arrival SOC margin, powertrain type (EV/fuel), detour cap, optimization priority, and non-energy service preferences. Supports multi-turn actions (adding services, inserting waypoints, editing constraints, removing stops, or starting a new trip). AI only handles intent understanding and explanations — routing and optimization remain deterministic via AMap and backend algorithms, without carrying prior-trip defaults forward as hard constraints.
- **Judge Mode vs. User Mode**: Judge Mode surfaces data boundaries, calculation rationales, and operator validation details; User Mode hides implementation internals and keeps routes, replenishment stops, safety, and service recommendations concise.
- **Origin selection with honest fallback**: After choosing a display mode, first-time visitors pick either NewLink HQ or browser geolocation. If geolocation is denied, times out, or reverse geocoding fails, the origin falls back to NewLink HQ without fabricating coordinates. Changing the origin in Settings prompts replanning for existing trips.
- **Version & build provenance**: Settings displays the current version, short commit hash, and build source, and supports manually checking GitHub for updates. Release packages without `.git` preserve commit metadata via private `runtime/build-info.json` without false update claims when offline or rate-limited.
- **Optional voice input (STT)**: Browser audio recordings are proxied server-side to a configured OpenAI-compatible speech-to-text endpoint with optional cleanup of emotion/language tags. Transcriptions feed straight into the text planning pipeline by default (or can be set in Settings to populate the input box only). API keys never leave the server.
- **Real AMap routing, geocoding, and corridor POIs**: AMap supplies live basemaps, nationwide geocoding/place search, corridor replenishment POIs, and driving routes. Ambiguous short place names present selectable destination candidates. Judge Mode explicitly labels whether results came from live AMap calls, route cache hits, or fixed fallback scenarios.
- **Multi-stop long-distance replenishment**: Standard trips plan up to 6 stops; extreme long-distance routes enter an adaptive mode verifying up to 12 stops per run. When public POI coverage is sparse, corridor candidates are explicitly labeled as demo candidates requiring confirmation rather than masquerading as verified chargers.
- **Server-side AMap file cache**: Route, POI, geocoding, reverse-geocoding, and weather responses are cached under `runtime/cache/amap/` (Git-ignored and blocked from static serving). Stale cache entries are served only when upstream requests fail within a short grace window, and are explicitly tagged as stale fallback.
- **5-minute browser plan snapshot**: Refreshing the page reuses completed POI extraction and segment-by-segment safety verification only when route, powertrain, energy state, safety margin, detour limit, priority, arrival constraint, service stops, and pressure snapshot all match; any change triggers recomputation. Snapshots never store keys, OCR media, or recognition results.
- **Ordered multi-waypoint verification**: Multi-stop long-distance plans prefer AMap Route 2.0 ordered waypoints to verify the full road polyline in one request and split true road mileage by waypoint order, falling back to per-segment routing only on failure or waypoint-limit overflow.
- **Arrival-time queue & port-level simulation**: Forecasts station utilization and P50/P90 queue waiting times at estimated arrival time using a unified stop-time ledger (`queue + replenishment service + payment/exit buffer`). Supports port-level discrete-event simulation (total, available, reserved, charging/faulted ports, waiting arrivals, and reservation queue) derived from demo occupancy/capacity inputs, falling back to aggregate flow simulation when port state is absent. Live AMap rain/snow conditions adjust simulated queues via `weatherFactor`. Forecasts are FlowTwin demo simulations, not live NaaS production telemetry.
- **Multi-objective driver recommendations**: Computes Fastest, Safest, and Lowest-Cost plans, explaining trade-offs across driving, queueing, service, payment/exit, detour, and cost. Identical routes merge objective badges rather than fabricating three artificially distinct plans.
- **Judge Mode decision chain & execution loop**: Displays whether AI was invoked, map data provenance, enterprise demand prior / simulation source, and unified safety constraints, plus a closed loop from forecast → reservation → local OCR → demo billing → operator review. Rule-handled simple requests offer an optional "Try multi-turn AI refinement" button that only pre-fills an example prompt until explicitly submitted. Simulated driving unlocks "Enter Operator Review" only after arriving at the destination, tracking local OCR, preset fallback, demo billing, and skipped stops separately.
- **Operator load-balancing & ROI simulation**: Models platform coupons, recommendation diversion, and traffic guidance on designated actionable demo stations, estimating capacity effects, diversion, queue deltas, and scenario ROI (scenario estimates pending real A/B testing).
- **Reproducible 1,000-trip validation**: Runs 30 synthetic nodes and 1,000 trips with a fixed random seed (default `20260719`) comparing four policies with deterministic, reproducible outputs.
- **Feishu Bitable + AI Field integration**: Syncs operator snapshots to Feishu Bitable and reads strategy insights back from a Feishu AI field while tracking "local simulation completed" and "Feishu AI returned" as separate states (never masking empty/failed AI calls with canned text). Legacy Feishu robot Webhook notifications remain available as an optional adapter.
- **Lightweight local CV verification (Judge Mode)**: Runs local PaddleOCR on built-in AI-generated camera samples or uploaded images/short videos when the optional local CV service is running; vehicle detection, bay occupancy, and visual queue detection are explicitly marked as not integrated.

### Responsive Layout & Viewport Checks

Layouts adapt to CSS viewport dimensions with an independently scrolling route drawer and viewport-contained simulation controls. Checked across common desktop, tablet, and mobile CSS viewports (1280×720, 1440×900, 1920×1080, 2560×1440, 3840×2160, 768×1024, 1024×768, 800×600, and 360–430 px mobile widths, plus DPR 2 spot checks).

## Architecture

```text
Browser
  ├─ AMap JS API: basemap & POI display
  └─ Node.js Backend
      ├─ /api/health                       Service health & AI/CV/enterprise-prior status (no secrets)
      ├─ /api/contracts                    API contract schema
      ├─ /api/plan                         AI intent parsing + place resolution (geocoding/POI scoring + candidates)
      ├─ /api/stt                          Speech-to-text proxy (optional, server-side key only)
      ├─ /api/route                        AMap driving & waypoint route proxy
      ├─ /api/poi                          AMap corridor around/text POI search proxy
      ├─ /api/forecast                     Arrival-time queue simulation (aggregate/port-level, weather-aware)
      ├─ /api/weather                      Live AMap weather (regeo → adcode → weather, file-cached)
      ├─ /api/longtrip                     Multi-stop long-distance replenishment planner
      ├─ /api/operator/simulate            Coupon pricing & traffic diversion simulation
      ├─ /api/validate                     1,000-trip policy comparison experiment
      ├─ /api/cv/health                    Optional local CV service health (no secrets)
      ├─ /api/cv/analyze                   Vision analysis adapter for built-in samples / uploads
      ├─ /api/feishu/sync                  Write snapshots to Feishu Bitable & start AI batch
      ├─ /api/feishu/sync/:id              Poll Feishu AI field results
      ├─ /api/feishu/strategy/:id/approve  Approve & write back strategy status in Feishu Bitable
      ├─ /api/feishu/health                Configuration status only (no secrets)
      └─ /api/execution                    Optional Feishu Webhook notification adapter
```

`/api/version` returns the current version and `/api/version/check` powers manual GitHub update checks in Settings. Both primary and backup AI providers use OpenAI-compatible endpoints.

## Running Locally

Requires **Node.js 20+** with zero third-party runtime dependencies.

1. Copy `config.example.js` to `config.local.js`, or configure services via environment variables (see `.env.example`).
2. Start the server:

```powershell
npm start
```

3. Open the printed local URL (default <http://127.0.0.1:4182/>).

### Environment Variables

All values below are **placeholders** — replace them with your own endpoints, keys, and models. Primary and backup AI require OpenAI-compatible `POST {AI_BASE_URL}/chat/completions` (backup is called only if primary fails). STT requires `POST {STT_BASE_URL}/audio/transcriptions` (multipart: `file` + `model`).

```env
# AMap
AMAP_JS_KEY=your_amap_web_js_key
AMAP_SECURITY_JS_CODE=your_amap_security_js_code
AMAP_WEB_SERVICE_KEY_PRIMARY=your_primary_amap_web_service_key
AMAP_WEB_SERVICE_KEY_BACKUP=your_backup_amap_web_service_key

# Intent parsing (any OpenAI-compatible endpoint)
AI_BASE_URL=https://your-ai-gateway.example.com/v1
AI_API_KEY=your_ai_api_key
AI_MODEL=your_chat_model_name

# Optional backup AI: invoked only when primary fails
AI_BACKUP_BASE_URL=https://your-backup-ai-gateway.example.com/v1
AI_BACKUP_API_KEY=your_backup_ai_api_key
AI_BACKUP_MODEL=your_backup_chat_model_name

# Optional speech-to-text (any /audio/transcriptions-compatible gateway)
# Aliases: SILICONFLOW_API_KEY / SILICONFLOW_BASE_URL / SILICONFLOW_STT_MODEL
STT_API_KEY=your_stt_api_key
STT_BASE_URL=https://your-stt-gateway.example.com/v1
STT_MODEL=your_speech_to_text_model

# Optional local CPU CV adapter; leave blank to keep vision unexecuted without fabricating OCR
CV_SERVICE_URL=

# Optional Feishu Webhook
FEISHU_WEBHOOK_URL=

# Optional Feishu Bitable + AI Field
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

Corresponding keys in `config.local.js` (`aiBaseUrl`, `aiApiKey`, `aiModel`, `aiBackupBaseUrl`, `sttApiKey`, `cvServiceUrl`, `feishuAppId`, etc.) work identically and stay strictly server-side.

Browser geolocation requires user permission and a secure context (`https://` or `localhost`).

For public deployments, set `FLOWTWIN_PUBLIC_DEMO=1`: routing, forecasting, operator simulation, and CV verification remain usable, while outbound Feishu Bitable writes/reads, strategy write-backs, and Webhook notifications downgrade to local demo mode. Per-IP rate limits apply to endpoints such as `/api/cv/analyze`, operator simulation, validation, and Feishu status polling and can be tuned via `FLOWTWIN_RATE_LIMIT_*` (default 10-minute window).

### Optional Local Vision Service

The main Node.js service has no Python, OpenCV, or Paddle dependencies. Built-in samples and uploaded images/short videos run through PaddleOCR only when the optional local CV service is started (see [`cv-service/README.md`](cv-service/README.md), default `127.0.0.1:5099`) and `CV_SERVICE_URL` is configured. No model weights are stored in this public repository.

Default AMap file-cache TTLs: routes 60 min, POIs 24 h, place resolution 7 days, geocoding 30 days, weather 10 min. Backup AMap Web Service keys are tried only on quota/rate-limit, transient HTTP, or network errors.

### Optional Enterprise Demand Prior

This public repository contains only loader, matching, fallback, and test code — no raw enterprise datasets, intermediate training artifacts, or exported priors. Private deployments may place an offline-exported prior at:

```text
runtime/enterprise-demand-prior.json
```

Check `GET /api/health` to verify load status. When loaded and matched, forecasts are labeled `enterprise-prior+simulation`; otherwise they automatically fall back to `simulation`. See [`docs/企业需求先验本地部署.md`](docs/企业需求先验本地部署.md) (in Chinese) for boundaries and deployment steps, and [`docs/站点状态与预约队列演示口径.md`](docs/站点状态与预约队列演示口径.md) (in Chinese) for port-state and reservation-queue conventions.

### Feishu Bitable Schema

Create three tables in the same Feishu Base: `站点运营快照` (station snapshots), `运营策略` (operator strategies, including an AI field named `AI策略`), and optional `同步记录` (sync logs). Full table setup, permissions, and AI prompt details are documented in [`docs/飞书多维表格AI接入配置.md`](docs/飞书多维表格AI接入配置.md) (in Chinese).

All server secrets are read exclusively from environment variables or Git-ignored `config.local.js` and are never logged or exposed to the browser (`/runtime-config.js` exposes only `amapKey`, `securityJsCode`, `mapMode`, and the boolean `sttEnabled`).

## Data Boundaries

- **Real data**: AMap basemaps, POI names/coordinates, geocoding, driving/waypoint routes, and live district weather.
- **Demo simulation**: Station occupancy, arrival/service rates, pricing, port snapshots, arrival-time queue forecasts, coupons, orders, and ROI. Simulated reservations modify only the current session's demo queue and never create real bookings.
- **Synthetic validation**: 30 synthetic replenishment nodes and 1,000 fixed-seed trips for reproducible strategy comparisons.
- **Offline enterprise prior (optional)**: A desensitized city × energy-type × hour demand prior ("seasonal baseline + HistGradientBoosting residual regression"; holdout WAPE ~17.85%, rolling validation mean WAPE ~13.14%) that adjusts simulated arrival intensity and congestion risk when `runtime/enterprise-demand-prior.json` is privately deployed; omitted from the public repository.
- **Vision demo**: Built-in samples are AI-generated simulated camera frames. Local PaddleOCR runs when configured; vehicle detection, bay detection, real camera feeds, and real payments are not executed, and no raw plates, faces, or videos are stored.

## Demo Walkthrough

1. Enter a nationwide origin and destination without time/SOC constraints to inspect the long-distance replenishment plan.
2. Add a latest arrival time or arrival margin under optional arrival requirements and compare the resulting changes.
3. Submit via the input arrow to view structured constraints, real routes, and deduplicated multi-objective plans (clear destination queries use deterministic rules first to avoid unnecessary AI token usage).
4. Click "Try multi-turn AI refinement" or type a multi-stop service request (e.g., adding food and coffee stops) to exercise multi-turn AI parsing with rule verification.
5. Inspect arrival-time P50/P90 queue forecasts and test "Simulate Reservation" in station details to see reservation queues affect predicted waiting time.
6. Open **Operator** to tune platform coupons and target cohorts, then click "Start Smart Analysis" to run local diversion simulation and optional Feishu Bitable AI analysis.
7. Open **Validation** to inspect the 1,000-trip four-policy comparison; switch Judge/User mode or check GitHub version in **Settings**.
8. In Judge Mode, open **Vision** to test built-in samples or uploads against local PaddleOCR (or observe explicit unexecuted/unrecognized boundaries when CV is unconfigured).

## Verification

```powershell
npm run check
npm test
```

## VPS Deployment

1. Upload source files (never upload `config.local.js` or `.env`).
2. Inject secrets via existing server environment variables or server-side private config (preserve existing production config).
3. Run `npm run check && npm test && npm start` (or restart via PM2/systemd).
4. Reverse-proxy Nginx / Caddy to `PORT`.

### Build Provenance Metadata

Release bundles without `.git` should include a secret-free `runtime/build-info.json` (or set `FLOWTWIN_COMMIT` and `FLOWTWIN_BUILD_TIME` in systemd):

```json
{
  "commit": "<full release commit SHA>",
  "buildTime": "<UTC ISO 8601 timestamp>"
}
```

`runtime/` is Git-ignored and blocked from static serving.

## License

Project source code is licensed under the [MIT License](LICENSE). AMap services, third-party APIs, model services, and external assets are outside the scope of this license.
