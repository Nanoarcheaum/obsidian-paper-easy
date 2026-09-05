export interface PdfCandidate { path: string; absolutePath?: string; attachmentKey?: string; parentKey?: string; }
export interface AttachmentIdentity { key: string; parentItem?: string; path?: string; filename?: string; }

function normalized(path: string): string {
  const slash = path.replace(/\\/g, "/").replace(/\/+$/, "");
  // Windows paths are case-insensitive; preserve case on other platforms.
  return /^[a-z]:\//i.test(slash) ? slash.toLowerCase() : slash;
}

export function matchZoteroAttachment(attachment: AttachmentIdentity, candidates: PdfCandidate[]): PdfCandidate | null {
  const keyed = candidates.filter(item => item.attachmentKey === attachment.key);
  if (keyed.length) return keyed.length === 1 ? keyed[0]! : null;
  const compatible = (item: PdfCandidate) => (!item.attachmentKey || item.attachmentKey === attachment.key)
    && (!item.parentKey || item.parentKey === attachment.parentItem);
  const path = attachment.path;
  if (path && !path.startsWith("storage:")) {
    const relative = path.startsWith("attachments:") ? path.slice("attachments:".length) : null;
    const exact = candidates.filter(item => compatible(item) && (relative !== null
      ? normalized(item.path) === normalized(relative)
      : normalized(item.absolutePath ?? item.path) === normalized(path)));
    // A known path is authoritative. Never fall back to a different same-named PDF.
    return exact.length === 1 ? exact[0]! : null;
  }
  const filename = attachment.filename || path?.replace(/^storage:/, "").split(/[\\/]/).at(-1);
  if (!filename) return null;
  const named = candidates.filter(item => item.path.split("/").at(-1) === filename);
  return named.length === 1 && compatible(named[0]!) ? named[0]! : null;
}

export function verifyWriteResult(result: unknown, keys: string[]): void {
  const response = result as { successful?: Record<string, { key?: string }>; unchanged?: Record<string, string>; failed?: Record<string, { message?: string }> };
  for (const [index, key] of keys.entries()) {
    if (response?.successful?.[index]?.key === key || response?.unchanged?.[index] === key) continue;
    throw new Error(`Zotero 条目 ${key} 未确认保存：${response?.failed?.[index]?.message ?? "响应不完整"}。关联进度已保留，可重试。`);
  }
}
