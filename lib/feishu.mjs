function safeUrl(value) {
  if (!value || value.length > 500) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

export async function executeFeishu({ payload = {}, config = {}, fetchImpl = fetch } = {}) {
  const webhookUrl = safeUrl(config.feishuWebhookUrl);
  if (!webhookUrl) {
    return {
      used: false,
      mode: "local-demo",
      message: "未配置飞书执行 Webhook，本次保留本地执行演示。"
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msg_type: "text",
        content: {
          text: [
            "FlowTwin 供需策略执行通知",
            `目标站点：${String(payload.targetStation || "未指定").slice(0, 100)}`,
            `优惠金额：¥${Number(payload.discountAmount || 0).toFixed(0)} / 单`,
            `目标用户：${String(payload.targetUser || "全部用户").slice(0, 80)}`,
            `预计分流：${Number(payload.divertedVehicles || 0).toFixed(0)} 人`,
            `预计 ROI：${Number(payload.roi || 0).toFixed(2)}x`
          ].join("\n")
        }
      }),
      signal: controller.signal
    });
    if (!response.ok) return { used: false, mode: "error", message: `飞书 Webhook 返回 HTTP ${response.status}` };
    return { used: true, mode: "feishu-webhook", message: "飞书执行通知已发送。" };
  } catch {
    return { used: false, mode: "error", message: "飞书 Webhook 暂时不可用，本次保留本地执行演示。" };
  } finally {
    clearTimeout(timer);
  }
}

