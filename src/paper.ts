export interface PaperRecord {
  notePath: string;
  pdfPath: string;
  title: string;
  authors: string[];
  year: string;
  status: string;
  modified: number;
}

export interface PaperBlock {
  id: string;
  notePath: string;
  paperTitle: string;
  page: number;
  quote: string;
  translation: string;
  comment: string;
}

export interface PaperAnnotationIndex {
  id: string;
  type: "quote" | "figure" | "highlight" | "underline" | "strikeout" | "comment";
  page: number;
  text: string;
  notePath: string;
  pdfPath: string;
  paperTitle: string;
}

export const safeStem = (name: string): string =>
  name.replace(/\.pdf$/i, "").replace(/[\\/:*?\"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim() || "Untitled paper";

export const yamlString = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;

export function buildPaperNote(pdfPath: string, title: string): string {
  return `---
ai4d-type: paper
title: ${yamlString(title)}
authors: []
year: ""
doi: ""
status: unread
paper: ${yamlString(`[[${pdfPath}]]`)}
tags:
  - Paper
created: ${new Date().toISOString()}
---
# ${title}

> [!paper]+ 论文
> [[${pdfPath}|打开 PDF]] · [[${pdfPath}#page=1|从第 1 页开始阅读]]

## 摘要


## 我的理解


## 批注

<!-- Paper-easy 会把论文摘录追加到这里。每个块都可在其他笔记中引用。 -->

## 延伸问题

`;
}

export function buildAnnotation(
  pdfPath: string,
  page: number,
  quote: string,
  comment: string,
  id: string,
  translation = ""
): string {
  const cleanQuote = quote.trim().replace(/\r?\n+/g, "\n> ");
  const note = comment.trim().replace(/\r?\n+/g, "\n> ");
  const translated = translation.trim().replace(/\r?\n+/g, "\n> ");
  return `
> ${cleanQuote || "（未填写原文）"}
${translated ? `>\n> **译文**　${translated}\n` : ""}${note ? `>\n> **我的批注**　${note}\n` : ""}>
> *[[${pdfPath}#page=${page}|↗ 第 ${page} 页]]*

^${id}
`;
}

export function buildFigureAnnotation(
  pdfPath: string,
  imagePath: string,
  page: number,
  id: string
): string {
  return `
> ![[${imagePath}]]
>
> *[[${pdfPath}#page=${page}|↗ 第 ${page} 页]]*

^${id}
`;
}

export function buildMarkupAnnotation(
  pdfPath: string,
  page: number,
  text: string,
  kind: "highlight" | "underline" | "strikeout" | "comment",
  comment: string,
  id: string
): string {
  return buildAnnotation(pdfPath, page, text || "（页面批注）", comment, id);
}

export function parsePaperLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/\[\[([^\]|]+\.pdf)(?:\|[^\]]+)?\]\]/i);
  return match?.[1] ? match[1].replace(/\\/g, "/").replace(/^\/+/, "") : null;
}

interface BlockSpan { id: string; start: number; end: number; body: string; page: number; }

/** Only a contiguous quotation (or the exact old figure/quote format) owns an ID. */
function blockSpans(content: string): BlockSpan[] {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length; }
  const plain = (i: number) => (lines[i] ?? '').replace(/\r?\n$/, '');
  const spans: BlockSpan[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(plain(i))) fenced = !fenced;
    if (fenced) continue;
    const match = plain(i).match(/^\^(ai4d-[a-z0-9-]+)\s*$/i);
    if (!match) continue;
    let last = i - 1;
    while (last >= 0 && !plain(last).trim()) last--;
    let start = last;
    if (/^>/.test(plain(last))) {
      while (start > 0 && /^>/.test(plain(start - 1))) start--;
    } else if (/^\*\[\[.+\.pdf#page=\d+\|.+\]\]\*$/.test(plain(last))) {
      start--;
      while (start >= 0 && !plain(start).trim()) start--;
      if (/^>/.test(plain(start))) { while (start > 0 && /^>/.test(plain(start - 1))) start--; }
      else if (!/^!\[\[.+\.(png|jpe?g|webp)\]\]$/i.test(plain(start))) continue;
    } else continue;
    const body = content.slice(offsets[start], offsets[i]);
    const page = body.match(/\.pdf#page=(\d+)/i)?.[1] ?? body.match(/第 (\d+) 页/)?.[1];
    // A second ID/header inside the candidate means user content cannot be safely bounded.
    if (!page || /^>\s*\^ai4d-/m.test(body)) continue;
    spans.push({ id: match[1]!, start: offsets[start]!, end: offsets[i]! + lines[i]!.length, body, page: Number(page) });
  }
  return spans;
}

function blockType(id: string): PaperAnnotationIndex['type'] {
  return id.startsWith('ai4d-fig-') ? 'figure' : (id.match(/^ai4d-(highlight|underline|strikeout|comment)-/)?.[1] as PaperAnnotationIndex['type'] ?? 'quote');
}

export function parsePaperBlocks(content: string, notePath: string, paperTitle: string): PaperBlock[] {
  return blockSpans(content).map(span => {
    const parts = { quote: [] as string[], translation: [] as string[], comment: [] as string[] };
    let section: keyof typeof parts = 'quote';
    for (const raw of span.body.split(/\r?\n/)) {
      let line = raw.replace(/^> ?/, '').trim();
      if (!line || /^\[!paper-/.test(line) || /\.pdf#page=\d+\|/.test(line)) continue;
      if (/^\*\*译文\*\*/.test(line)) { section = 'translation'; line = line.replace(/^\*\*译文\*\*\s*/, ''); }
      else if (/^\*\*(我的批注|批注)\*\*/.test(line)) { section = 'comment'; line = line.replace(/^\*\*(我的批注|批注)\*\*\s*/, ''); }
      parts[section].push(line);
    }
    return { id: span.id, notePath, paperTitle, page: span.page, quote: parts.quote.join(' '), translation: parts.translation.join(' '), comment: parts.comment.join(' ') };
  });
}

export function annotationEmbed(block: Pick<PaperBlock, 'notePath' | 'id'>): string {
  return `![[${block.notePath}#^${block.id}]]`;
}

export function parseAnnotationIndex(content: string, notePath: string, pdfPath: string, paperTitle: string): PaperAnnotationIndex[] {
  return parsePaperBlocks(content, notePath, paperTitle).map(block => ({
    id: block.id, type: blockType(block.id), page: block.page,
    text: [block.quote, block.translation, block.comment].filter(Boolean).join(' — '), notePath, pdfPath, paperTitle
  }));
}

function uniqueSpan(content: string, id: string): BlockSpan | undefined {
  const spans = blockSpans(content).filter(span => span.id === id);
  const markers = content.split(/\r?\n/).filter(line => line.trim() === `^${id}`);
  if (spans.length !== 1 || markers.length !== 1) {
    if (markers.length) throw new Error('来源块被手动修改或 ID 重复，未修改笔记。请先检查对应块。');
    return undefined;
  }
  return spans[0];
}

export function removeMarkupBlock(content: string, id: string): string {
  const span = uniqueSpan(content, id);
  if (!span) return content;
  return content.slice(0, span.start) + content.slice(span.end);
}

export function updateMarkupBlockComment(content: string, id: string, comment: string): string {
  const span = uniqueSpan(content, id);
  if (!span) return content;
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = span.body.trimEnd().split(/\r?\n/);
  // Older callouts place their comment after the link; new quotes place it before the link.
  const start = lines.findIndex(line => /^> \*\*(我的批注|批注|译文)\*\*/.test(line));
  let label = id.startsWith('ai4d-translation-') ? '译文' : '我的批注';
  if (start >= 0) {
    label = lines[start]!.match(/\*\*(.+?)\*\*/)?.[1] ?? label;
    let end = start + 1;
    while (end < lines.length && !/\.pdf#page=\d+\|/.test(lines[end]!) && !/^> \*\*/.test(lines[end]!)) end++;
    lines.splice(start, end - start);
  }
  const link = lines.findIndex(line => /\.pdf#page=\d+\|/.test(line));
  if (link < 0) throw new Error('来源链接已修改，未覆盖笔记。');
  if (comment.trim()) lines.splice(link, 0, `> **${label}**　${comment.trim().replace(/\r?\n/g, eol + '> ')}`, '>');
  const replacement = lines.join(eol).trimEnd() + eol + eol + `^${id}` + eol;
  return content.slice(0, span.start) + replacement + content.slice(span.end);
}

export function appendPaperBlock(content: string, block: string, id: string): string {
  if (content.split(/\r?\n/).some(line => line.trim() === `^${id}`)) return content;
  const position = content.indexOf('## 延伸问题');
  return position >= 0 ? `${content.slice(0, position).trimEnd()}\n\n${block.trim()}\n\n${content.slice(position)}` : `${content.trimEnd()}\n\n${block.trim()}\n`;
}

/** Explicit, opt-in repair of old block boundaries, preserving all existing IDs. */
export function repairBlockReferences(content: string): string {
  let output = content;
  for (const span of blockSpans(content).reverse()) {
    if (!/^\*\[\[/m.test(span.body)) continue;
    const body = span.body.trimEnd().split(/\r?\n/).map(line => line.startsWith('>') ? line : line.trim() ? `> ${line}` : '>').join('\n');
    output = output.slice(0, span.start) + body + `\n\n^${span.id}\n` + output.slice(span.end);
  }
  return output;
}

export function paperTags(tags: unknown): string[] {
  const values = Array.isArray(tags) ? tags.map(String) : typeof tags === 'string' ? tags.split(/[\s,]+/).filter(Boolean) : [];
  return [...values.filter(tag => tag.replace(/^#/, '').toLowerCase() !== 'paper'), 'Paper'];
}
