[简体中文](README.md) | English

# FlowTwin

> AI-Assisted Integrated Fuel & EV Energy Replenishment Decision Demo · v1.1.1

FlowTwin demonstrates an end-to-end decision pipeline built around the NewLink (NaaS) challenge — from natural-language driver intent to real map routing, arrival-time station queue forecasting, multi-objective recommendation, operator load-balancing simulation, and reproducible strategy validation. On first visit, users choose between **Judge Mode** and **User Mode**, then pick either NewLink HQ or the browser's current geolocation as the trip origin (both can be switched anytime in Settings).

## Interface Preview

### Driver View: Trip Intelligence

Parses natural-language trip requests into structured constraints, combining live AMap routing and arrival-time P50/P90 queue forecasts to compare **Fastest**, **Most Reliable**, and **Lowest Cost** replenishment plans:

![Driver Trip Intelligence Interface](docs/screenshots/driver-trip-intelligence.png)

### Operator View: Regional Supply-Demand & Strategy Console

Translates driver trip demand into station-side diversion and pricing actions, enabling interactive coupon and target-cohort tuning with before/after queue, diversion, and scenario ROI estimates plus Feishu approval workflow integration:

![Operator Regional Supply-Demand and Strategy Console](docs/screenshots/operator-dispatch.png)

### Mobile View: Responsive Layout

Adapts to 360–430 px mobile viewports while preserving natural-language intent input, structured constraints, and an independently scrollable bottom plan drawer:

<p align="center">
  <img src="docs/screenshots/mobile-responsive.png" alt="Mobile Responsive Interface" width="320" />
</p>

## Core Capabilities

- **Natural-language intent parsing & multi-turn actions**: An OpenAI-compatible AI model parses Chinese driver requests into destination, optional latest arrival time / arrival SOC margin, powertrain type (EV/fuel), detour cap, optimization priority, and non-energy service preferences, supporting multi-turn refinements (adding services, inserting waypoints, editing constraints, removing stops, or starting a new trip) with deterministic AMap routing and backend optimization.
- **Judge Mode vs. User Mode**: Switch anytime between Judge Mode (full provenance, calculation rationales, and validation details) and User Mode (streamlined routes, replenishment stops, safety, and service recommendations).
- **Origin selection & version checks**: Pick either NewLink HQ or browser geolocation on first visit (falling back to NewLink HQ when geolocation is unavailable) and switch anytime in Settings. Settings also displays the current version, short commit hash, and build source (via `runtime/build-info.json` when `.git` is absent) with manual GitHub release checks.
- **Optional voice input (STT)**: Browser audio recordings are proxied server-side to an OpenAI-compatible speech-to-text endpoint, feeding straight into text planning by default (or populating the input box only) while keeping API keys server-side.
- **Real AMap routing, geocoding & layered caching**: Live basemaps, nationwide geocoding/place search with selectable candidates, corridor POIs, weather, and driving routes, backed by a server-side file cache (`runtime/cache/amap/`, Git-ignored and blocked from static serving) plus a 5-minute matching-condition browser snapshot.
- **Multi-stop long-distance replenishment**: Plans up to 6 stops on standard routes and up to 12 stops in adaptive extreme-distance mode; prefers AMap Route 2.0 ordered waypoints to verify the full road polyline in a single request and split road mileage/ETA cleanly, falling back to per-segment routing when needed.
- **Arrival-time queue & port-level simulation**: Forecasts station utilization and P50/P90 queue waiting times at estimated arrival time using a unified stop-time ledger (`queue + service + payment/exit buffer`), supporting port-level discrete-event simulation alongside aggregate flow simulation and weather-aware queue adjustments (`weatherFactor`).
- **Multi-objective recommendations & execution loop**: Compares Fastest, Most Reliable, and Lowest-Cost plans with automatic badge merging for identical routes; Judge Mode links forecast → simulated reservation → local OCR → demo receipt → operator review, unlocking one-click transition to Operator Review upon trip completion.
- **Operator load-balancing & reproducible 1,000-trip validation**: Models platform coupons, target cohorts, diversion, queue deltas, and scenario ROI; the Validation tab runs 30 synthetic nodes and 1,000 trips with a fixed seed (default `20260719`) comparing four policies reproducibly.
- **Feishu Bitable + AI Field integration**: Syncs operator snapshots to Feishu Bitable, reads strategy insights back from a Feishu AI field, and tracks approval write-backs alongside optional Feishu robot Webhook notifications.
- **Optional local CV verification (Judge Mode)**: Runs local PaddleOCR license-plate recognition on built-in samples or uploaded images/short videos when the optional local CV service is configured.

### Responsive Layout

Layouts adapt to CSS viewport dimensions with an independently scrolling route drawer and viewport-contained simulation controls, covering desktop (1280×720 to 3840×2160), tablet (768×1024, 1024×768), and mobile (360–430 px, plus DPR 2 spot checks).

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

# Optional local CPU CV adapter (leave blank to disable local OCR)
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

## Data Sources

- **Live external data**: AMap basemaps, POI names/coordinates, geocoding, driving/waypoint routes, and live district weather.
- **Station & operator simulation**: Station occupancy, arrival/service rates, port snapshots, arrival-time queue forecasts, simulated reservations, coupons, and scenario ROI are generated by local simulation models.
- **Reproducible validation benchmark**: 30 synthetic replenishment nodes and 1,000 fixed-seed trips for four-policy comparisons.
- **Optional offline demand prior**: When `runtime/enterprise-demand-prior.json` is privately deployed, a seasonal baseline + HistGradientBoosting residual regression model (holdout WAPE ~17.85%, rolling mean ~13.14%) adjusts simulated arrival intensity and congestion risk.
- **Optional vision pipeline**: Local PaddleOCR runs when configured; uploaded media is processed in memory only and never persisted to disk.

## Demo Walkthrough

1. Enter a nationwide origin and destination without time/SOC constraints to inspect the long-distance replenishment plan.
2. Add a latest arrival time or arrival margin under optional arrival requirements and compare the resulting changes.
3. Submit via the input arrow to view structured constraints, real routes, and deduplicated multi-objective plans.
4. Click "Try multi-turn AI refinement" or type a multi-stop service request (e.g., adding food and coffee stops) to exercise multi-turn AI parsing with rule verification.
5. Inspect arrival-time P50/P90 queue forecasts and test "Simulate Reservation" in station details to see reservation queues affect predicted waiting time.
6. Open **Operator** to tune platform coupons and target cohorts, then click "Start Smart Analysis" to run local diversion simulation and optional Feishu Bitable AI analysis.
7. Open **Validation** to inspect the 1,000-trip four-policy comparison; switch Judge/User mode or check GitHub version in **Settings**.
8. In Judge Mode, open **Vision** to test built-in samples or uploads against the local PaddleOCR pipeline.

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
