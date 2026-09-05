import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString
} from "pdf-lib";

export type PdfRect = [number, number, number, number];
export type TextMarkupSubtype = "Highlight" | "Underline" | "StrikeOut";

interface AnnotationBase {
  page: number;
  color: string;
  author: string;
  contents?: string;
  quote?: string;
  id: string;
}

export interface TextMarkupAnnotation extends AnnotationBase {
  subtype: TextMarkupSubtype;
  rects: PdfRect[];
}

export interface TextNoteAnnotation extends AnnotationBase {
  point: [number, number];
}

export interface PdfAnnotationSummary {
  key: string;
  refKey: string;
  page: number;
  subtype: string;
  contents: string;
  quote: string;
  color: string;
}

const name = (value: string): PDFName => PDFName.of(value);

function colorComponents(hex: string): number[] {
  const normalized = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : "ffd54f";
  return [0, 2, 4].map(index => Number.parseInt(normalized.slice(index, index + 2), 16) / 255);
}

function modifiedDate(): PDFString {
  return PDFString.fromDate(new Date());
}

function addAnnotation(document: PDFDocument, pageNumber: number, values: object): void {
  const page = document.getPage(pageNumber - 1);
  const context = document.context;
  const dictionary = context.obj(values as never);
  const reference = context.register(dictionary);
  const annots = page.node.lookupMaybe(name("Annots"), PDFArray);
  if (annots) annots.push(reference);
  else page.node.set(name("Annots"), context.obj([reference]));
}

function annotationKey(reference: PDFRef | PDFDict, dictionary: PDFDict, page = 0, index = 0): string {
  const named = dictionary.get(name("NM"));
  if (named instanceof PDFString || named instanceof PDFHexString) return named.decodeText();
  return reference instanceof PDFRef ? `${reference.objectNumber}R${reference.generationNumber}` : `direct-${page}-${index}`;
}

function annotationContents(dictionary: PDFDict): string {
  const value = dictionary.get(name("Contents"));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : "";
}

function annotationSubtype(dictionary: PDFDict): string {
  const value = dictionary.get(name("Subtype"));
  return value instanceof PDFName ? value.asString().replace(/^\//, "") : "Unknown";
}

function annotationColor(dictionary: PDFDict): string {
  const value = dictionary.lookupMaybe(name("C"), PDFArray);
  if (!value || value.size() < 3) return "#ffd54f";
  const channels = [0, 1, 2].map(index => {
    const item = value.lookup(index, PDFNumber);
    return Math.max(0, Math.min(255, Math.round(item.asNumber() * 255))).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

function findAnnotation(document: PDFDocument, pageNumber: number, key: string): { array: PDFArray; index: number; dictionary: PDFDict } | null {
  const page = document.getPage(pageNumber - 1);
  const array = page.node.lookupMaybe(name("Annots"), PDFArray);
  if (!array) return null;
  for (let index = 0; index < array.size(); index += 1) {
    const reference = array.get(index);
    if (!(reference instanceof PDFRef) && !(reference instanceof PDFDict)) continue;
    const dictionary = document.context.lookup(reference, PDFDict);
    if (annotationKey(reference, dictionary, pageNumber, index) === key) return { array, index, dictionary };
  }
  return null;
}

export async function writeTextMarkupAnnotation(bytes: ArrayBuffer, annotation: TextMarkupAnnotation): Promise<Uint8Array> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  if (annotation.page < 1 || annotation.page > document.getPageCount()) throw new Error("批注页码超出 PDF 范围");
  if (!annotation.rects.length || annotation.rects.some(rect => !rect.every(Number.isFinite) || rect[2] <= rect[0] || rect[3] <= rect[1])) throw new Error("没有有效的文字选区");
  const xs = annotation.rects.flatMap(rect => [rect[0], rect[2]]);
  const ys = annotation.rects.flatMap(rect => [rect[1], rect[3]]);
  const rectangle: PdfRect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const quadPoints = annotation.rects.flatMap(([left, bottom, right, top]) => [left, top, right, top, left, bottom, right, bottom]);
  addAnnotation(document, annotation.page, {
    Type: name("Annot"),
    Subtype: name(annotation.subtype),
    Rect: rectangle,
    QuadPoints: quadPoints,
    Contents: PDFHexString.fromText(annotation.contents ?? ""),
    AI4DQuote: PDFHexString.fromText(annotation.quote ?? ""),
    T: PDFHexString.fromText(annotation.author),
    M: modifiedDate(),
    NM: PDFString.of(annotation.id),
    C: colorComponents(annotation.color),
    CA: PDFNumber.of(annotation.subtype === "Highlight" ? 0.32 : 1),
    F: PDFNumber.of(4)
  });
  return document.save();
}

export async function writeTextNoteAnnotation(bytes: ArrayBuffer, annotation: TextNoteAnnotation): Promise<Uint8Array> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  if (annotation.page < 1 || annotation.page > document.getPageCount()) throw new Error("批注页码超出 PDF 范围");
  const [x, y] = annotation.point;
  if (![x, y].every(Number.isFinite)) throw new Error("无效的批注位置");
  addAnnotation(document, annotation.page, {
    Type: name("Annot"),
    Subtype: name("Text"),
    Rect: [x, y, x + 22, y + 22],
    Contents: PDFHexString.fromText(annotation.contents ?? ""),
    AI4DQuote: PDFHexString.fromText(annotation.quote ?? ""),
    T: PDFHexString.fromText(annotation.author),
    M: modifiedDate(),
    NM: PDFString.of(annotation.id),
    Name: name("Comment"),
    C: colorComponents(annotation.color),
    Open: false,
    F: PDFNumber.of(4)
  });
  return document.save();
}

export async function readPdfAnnotations(bytes: ArrayBuffer): Promise<PdfAnnotationSummary[]> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const output: PdfAnnotationSummary[] = [];
  for (let pageIndex = 0; pageIndex < document.getPageCount(); pageIndex += 1) {
    const array = document.getPage(pageIndex).node.lookupMaybe(name("Annots"), PDFArray);
    if (!array) continue;
    for (let index = 0; index < array.size(); index += 1) {
      const reference = array.get(index);
      if (!(reference instanceof PDFRef) && !(reference instanceof PDFDict)) continue;
      const dictionary = document.context.lookup(reference, PDFDict);
      const subtype = annotationSubtype(dictionary);
      if (!["Highlight", "Underline", "StrikeOut", "Text"].includes(subtype)) continue;
      output.push({
        key: annotationKey(reference, dictionary, pageIndex + 1, index),
        refKey: reference instanceof PDFRef ? `${reference.objectNumber}R${reference.generationNumber}` : `direct-${pageIndex + 1}-${index}`,
        page: pageIndex + 1,
        subtype,
        contents: annotationContents(dictionary),
        quote: (() => { const text = dictionary.get(name("AI4DQuote")); return text instanceof PDFHexString || text instanceof PDFString ? text.decodeText() : ""; })(),
        color: annotationColor(dictionary)
      });
    }
  }
  return output;
}

export async function updatePdfAnnotationContents(bytes: ArrayBuffer, page: number, key: string, contents: string): Promise<Uint8Array> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const annotation = findAnnotation(document, page, key);
  if (!annotation) throw new Error("找不到这条 PDF 批注");
  annotation.dictionary.set(name("Contents"), PDFHexString.fromText(contents));
  annotation.dictionary.set(name("M"), modifiedDate());
  return document.save();
}

export async function updatePdfAnnotationColor(bytes: ArrayBuffer, page: number, key: string, color: string): Promise<Uint8Array> {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("无效的批注颜色");
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const annotation = findAnnotation(document, page, key);
  if (!annotation) throw new Error("找不到这条 PDF 批注");
  annotation.dictionary.set(name("C"), document.context.obj(colorComponents(color)));
  annotation.dictionary.delete(name("AP"));
  annotation.dictionary.set(name("M"), modifiedDate());
  return document.save();
}

export async function deletePdfAnnotation(bytes: ArrayBuffer, page: number, key: string): Promise<Uint8Array> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const annotation = findAnnotation(document, page, key);
  if (!annotation) throw new Error("找不到这条 PDF 批注");
  annotation.array.remove(annotation.index);
  return document.save();
}
