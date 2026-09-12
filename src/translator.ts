import { requestUrl } from "obsidian";

export interface TranslationConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  targetLanguage: string;
}

const cache = new Map<string, string>();

function isOllamaEndpoint(endpoint: string): boolean {
  return /(?:localhost|127\.0\.0\.1):11434/i.test(endpoint) || /\/api\/(?:chat|generate)$/i.test(endpoint);
}

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
  const cacheKey = JSON.stringify(["translate", text, config.endpoint, config.model, config.targetLanguage, config.apiKey]);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const messages = [
    { role: "system", content: `你是严谨的学术翻译。将用户提供的论文原文翻译为${config.targetLanguage}。保留术语、公式、引文标号与段落结构，不增加解释，只输出译文。` },
    { role: "user", content: text }
  ];
  const configured = config.endpoint.trim().replace(/\/+$/, "");
  const isOllama = isOllamaEndpoint(configured);
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

export function normalizeFormulaMarkdown(value: string): string {
  let formula = value.trim();
  const fence = formula.match(/^```(?:markdown|md|latex|tex)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i);
  if (fence) formula = fence[1]!.trim();
  formula = formula.replace(/^\s*(?:LaTeX|Markdown)\s*[:：]\s*/i, "").trim();
  const display = formula.match(/^\\\[([\s\S]*)\\\]$/);
  if (display) formula = `$$\n${display[1]!.trim()}\n$$`;
  const inline = formula.match(/^\\\(([\s\S]*)\\\)$/);
  if (inline) formula = `$${inline[1]!.trim()}$`;
  if (!/^\${1,2}[\s\S]*\${1,2}$/.test(formula)) formula = `$$\n${formula}\n$$`;
  return formula;
}

export async function convertFormulaToMarkdown(text: string, config: TranslationConfig): Promise<string> {
  if (!config.endpoint.trim() || !config.model.trim()) throw new Error("请先在插件设置中填写 Ollama 接口和模型");
  if (!isOllamaEndpoint(config.endpoint.trim())) throw new Error("公式转写使用 Ollama，请先把翻译服务切换为 Ollama 本地");
  if (!text.trim()) throw new Error("请先选择需要转写的公式");
  if (text.length > 3000) throw new Error("公式选区过长，请缩短后重试");
  const cacheKey = JSON.stringify(["formula", text, config.endpoint, config.model]);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const messages = [
    { role: "system", content: "你是数学公式 OCR 校对器。把用户提供的 PDF 文字层公式还原为 Obsidian Markdown 可渲染的 LaTeX。行内公式用 $...$，独立公式用 $$ 换行 ... 换行 $$。修复上下标、希腊字母、分式、根式、矩阵和运算符。不得求解、解释或翻译含义，不得输出代码围栏，只输出一个完整公式。" },
    { role: "user", content: text }
  ];
  const configured = config.endpoint.trim().replace(/\/+$/, "");
  const endpoint = configured.replace(/\/(?:v1\/chat\/completions|api\/(?:chat|generate))$/i, "") + "/api/chat";
  const response = await withTimeout(requestUrl({
    url: endpoint,
    method: "POST",
    contentType: "application/json",
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    body: JSON.stringify({ model: config.model.trim(), stream: false, think: false, keep_alive: "30m", messages,
      options: { temperature: 0, num_ctx: 4096, num_predict: 768 } }),
    throw: false
  }), 90000);
  let json: { error?: { message?: string } | string; done_reason?: string; message?: { content?: string } } = {};
  try { json = response.json; } catch { /* Error pages may be HTML, not JSON. */ }
  if (response.status < 200 || response.status >= 300) {
    const detail = (typeof json.error === "object" ? json.error?.message : json.error) ?? response.text;
    throw new Error(`Ollama 接口返回 HTTP ${response.status}${detail ? `：${String(detail).slice(0, 160)}` : ""}`);
  }
  if (json.done_reason === "length") throw new Error("公式被模型截断，请缩短选区后重试");
  if (typeof json.message?.content !== "string" || !json.message.content.trim()) throw new Error("Ollama 没有返回可用公式");
  const markdown = normalizeFormulaMarkdown(json.message.content);
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, markdown);
  return markdown;
}
