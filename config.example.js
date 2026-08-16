window.FLOWTWIN_CONFIG = {
  // Set true for a public read-only demo: external Feishu/Webhook writes are disabled.
  publicDemo: false,
  amapKey: "YOUR_AMAP_WEB_JS_KEY",
  securityJsCode: "YOUR_AMAP_SECURITY_JS_CODE",
  webServiceKey: "YOUR_AMAP_WEB_SERVICE_KEY_PRIMARY",
  webServiceKeyBackup: "YOUR_AMAP_WEB_SERVICE_KEY_BACKUP",
  // OpenAI-compatible chat: POST {aiBaseUrl}/chat/completions
  aiBaseUrl: "https://your-ai-gateway.example.com/v1",
  aiApiKey: "YOUR_AI_API_KEY",
  aiModel: "YOUR_CHAT_MODEL_NAME",
  // Optional fallback: used only when the primary AI request fails.
  aiBackupBaseUrl: "https://your-backup-ai-gateway.example.com/v1",
  aiBackupApiKey: "YOUR_BACKUP_AI_API_KEY",
  aiBackupModel: "YOUR_BACKUP_CHAT_MODEL_NAME",
  // Optional STT: POST {sttBaseUrl}/audio/transcriptions
  sttApiKey: "YOUR_STT_API_KEY",
  sttBaseUrl: "https://your-stt-gateway.example.com/v1",
  sttModel: "YOUR_SPEECH_TO_TEXT_MODEL",
  // Optional local CV adapter; blank uses the labelled synthetic demo.
  cvServiceUrl: "",
  feishuWebhookUrl: "",
  // Optional Feishu Bitable + AI field integration. Credentials stay server-side.
  feishuBaseUrl: "https://open.feishu.cn",
  feishuAppId: "YOUR_FEISHU_APP_ID",
  feishuAppSecret: "YOUR_FEISHU_APP_SECRET",
  feishuAppToken: "YOUR_FEISHU_BITABLE_APP_TOKEN",
  feishuSnapshotTableId: "YOUR_FEISHU_SNAPSHOT_TABLE_ID",
  feishuStrategyTableId: "YOUR_FEISHU_STRATEGY_TABLE_ID",
  feishuSyncTableId: "YOUR_FEISHU_SYNC_TABLE_ID",
  feishuAiStrategyField: "AI策略",
  feishuApprovalField: "审批状态",
  mapMode: "live"
};
