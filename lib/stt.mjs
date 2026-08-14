/**
 * SenseVoice and similar models often embed language/emotion/event tags
 * in the raw transcript, e.g. "<|zh|><|NEUTRAL|><|Speech|>去华山".
 * FlowTwin only wants clean travel intent text for the input box.
 */

const SENSEVOICE_TAG = /<\|[^|>]*\|>/g;
const FULLWIDTH_TAG = /＜\|[^|>]*\|＞/g;
const BRACKET_EMOTION = /\[(?:NEUTRAL|HAPPY|SAD|ANGRY|FEARFUL|DISGUSTED|SURPRISED|EMO_UNKNOWN|BGM|Speech|Applause|Laughter)\]/gi;
// Speech-to-text occasionally inserts a sentence mark between a destination
// cue and the place name (for example: “我想去。南京大学。”). Keep the
// punctuation at the end of the utterance, but turn this internal false
// boundary into whitespace so the intent parser can still see one phrase.
const INTERNAL_DESTINATION_BOUNDARY = /((?:前往|去|抵达|目的地(?:是)?|到(?!达)|导航(?:到|去)))\s*[。！？!?]+\s*/g;

export function cleanTranscriptText(raw) {
  let text = String(raw ?? "");
  text = text
    .replace(SENSEVOICE_TAG, " ")
    .replace(FULLWIDTH_TAG, " ")
    .replace(BRACKET_EMOTION, " ");
  // Drop emoji / pictographs that sometimes ride along with rich ASR output.
  text = Array.from(text).filter((ch) => {
    const code = ch.codePointAt(0);
    if (code == null) return false;
    // Basic Multilingual Plane controls and DEL
    if (code <= 0x1f || code === 0x7f) return false;
    // Common zero-width chars
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) return false;
    // Extended pictographic ranges (emoji)
    if (code >= 0x1f300 && code <= 0x1faff) return false;
    if (code >= 0x2600 && code <= 0x27bf) return false;
    return true;
  }).join("");
  text = text
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(INTERNAL_DESTINATION_BOUNDARY, "$1 ")
    .trim();
  return text;
}

/**
 * Optional second pass: ask the already-configured OpenAI-compatible model to
 * turn noisy ASR into a single clean Chinese travel sentence. Fail-open to the
 * deterministic cleaner so voice still works without AI.
 */
export async function polishTranscriptText(text, config, fetchImpl = fetch) {
  const cleaned = cleanTranscriptText(text);
  if (!cleaned) return "";
  if (!config?.aiApiKey || !config?.aiBaseUrl || !config?.aiModel) return cleaned;

  const original = String(text ?? "");
  const hasTags = SENSEVOICE_TAG.test(original) || FULLWIDTH_TAG.test(original);
  const hasWeird = /[<>|]/.test(cleaned);
  // Short plain clips do not need an LLM round-trip.
  if (!hasTags && !hasWeird && cleaned.length < 80) return cleaned;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetchImpl(`${config.aiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.aiApiKey}`
      },
      body: JSON.stringify({
        model: config.aiModel,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "你是出行语音输入清理器。把 ASR 原文整理成一句干净的中文出行需求，只保留地点、时间、油电量、绕行、优先级等规划相关信息。删除情感标签、语言标签、表情符号、语气词填充和模型特殊标记（如 <|NEUTRAL|>、<|zh|>）。不要解释，不要加引号，不要编造原文没有的目的地。若几乎无可识别内容，返回空字符串。"
          },
          {
            role: "user",
            content: cleaned.slice(0, 800)
          }
        ]
      }),
      signal: controller.signal
    });
    if (!response.ok) return cleaned;
    const payload = await response.json();
    const polished = cleanTranscriptText(payload?.choices?.[0]?.message?.content || "");
    if (!polished) return cleaned;
    // Guard against model inventing a much longer different route.
    if (polished.length > cleaned.length * 2 + 20) return cleaned;
    return polished;
  } catch {
    return cleaned;
  } finally {
    clearTimeout(timer);
  }
}
