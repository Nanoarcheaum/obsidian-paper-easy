import { requestUrl } from "obsidian";

export interface TranslationConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  targetLanguage: string;
}

const cache = new Map<string, string>();

export async function withTimeout<T>(request: PromiseLike<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(request), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("翻译等待超时，请检查模型是否运行，或缩短选段后重试。")), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function translateText(text: string, config: TranslationConfig): Promise<string> {
  if (!config.endpoint.trim() || !config.model.trim()) throw new Error("请先在插件设置中填写翻译接口和模型");
  if (!text.trim()) throw new Error("请先选择需要翻译的文字");
  if (text.length > 6000) throw new Error("选段较长，请分成较短段落翻译，以免译文被截断。");
  const cacheKey = JSON.stringify([text, config.endpoint, config.model, config.targetLanguage, config.apiKey]);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const messages = [
    { role: "system", content: `你是严谨的学术翻译。将用户提供的论文原文翻译为${config.targetLanguage}。保留术语、公式、引文标号与段落结构，不增加解释，只输出译文。` },
    { role: "user", content: text }
  ];
  const configured = config.endpoint.trim().replace(/\/+$/, "");
  const isOllama = /(?:localhost|127\.0\.0\.1):11434/i.test(configured) || /\/api\/(?:chat|generate)$/i.test(configured);
  const endpoint = isOllama
    ? configured.replace(/\/(?:v1\/chat\/completions|api\/(?:chat|generate))$/i, "") + "/api/chat"
    : configured;
  const response = await withTimeout(requestUrl({
    url: endpoint,
    method: "POST",
    contentType: "application/json",
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    body: JSON.stringify(isOllama
      ? { model: config.model.trim(), stream: false, think: false, keep_alive: "30m", messages, options: { temperature: 0.1, num_ctx: 4096, num_predict: 1536 } }
      : { model: config.model.trim(), temperature: 0.1, messages }),
    throw: false
  }), 90000);
  let json: { error?: { message?: string } | string; done_reason?: string; message?: { content?: string }; choices?: Array<{ finish_reason?: string; message?: { content?: string } }> } = {};
  try { json = response.json; } catch { /* Error pages may be HTML, not JSON. */ }
  if (response.status < 200 || response.status >= 300) {
    const detail = (typeof json.error === "object" ? json.error?.message : json.error) ?? response.text;
    throw new Error(`翻译接口返回 HTTP ${response.status}${detail ? `：${String(detail).slice(0, 160)}` : ""}`);
  }
  const translated = isOllama ? json.message?.content : json.choices?.[0]?.message?.content;
  if (json.done_reason === "length" || json.choices?.[0]?.finish_reason === "length") throw new Error("译文被模型截断，请缩短选段后重试。");
  if (typeof translated !== "string" || !translated.trim()) throw new Error("翻译接口没有返回可用文本");
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, translated.trim());
  return translated.trim();
}
