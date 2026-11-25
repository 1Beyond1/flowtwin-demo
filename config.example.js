window.FLOWTWIN_CONFIG = {
  // Set true for a public read-only demo: external Feishu/Webhook writes are disabled.
  publicDemo: false,
  // Optional AMap keys; leave blank for offline zero-key planning mode.
  amapKey: "",
  securityJsCode: "",
  webServiceKey: "",
  webServiceKeyBackup: "",
  // Optional default origin override (defaults to 北京国贸 CBD [116.461, 39.909]).
  defaultOriginName: "",
  defaultOriginLng: "",
  defaultOriginLat: "",
  // Optional OpenAI-compatible chat: POST {aiBaseUrl}/chat/completions
  aiBaseUrl: "",
  aiApiKey: "",
  aiModel: "",
  // Optional fallback: used only when the primary AI request fails.
  aiBackupBaseUrl: "",
  aiBackupApiKey: "",
  aiBackupModel: "",
  // Optional STT: POST {sttBaseUrl}/audio/transcriptions
  sttApiKey: "",
  sttBaseUrl: "",
  sttModel: "",
  // Optional local CV adapter (e.g. "http://127.0.0.1:5099"); blank uses safe fallback.
  cvServiceUrl: "",
  feishuWebhookUrl: "",
  // Optional Feishu Bitable + AI field integration. Credentials stay server-side.
  feishuBaseUrl: "https://open.feishu.cn",
  feishuAppId: "",
  feishuAppSecret: "",
  feishuAppToken: "",
  feishuSnapshotTableId: "",
  feishuStrategyTableId: "",
  feishuSyncTableId: "",
  feishuAiStrategyField: "AI策略",
  feishuApprovalField: "审批状态",
  mapMode: "fallback"
};
