import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName } from "pdf-lib";
import {
  deletePdfAnnotation,
  readPdfAnnotations,
  updatePdfAnnotationContents,
  updatePdfAnnotationColor,
  writeTextMarkupAnnotation,
  writeTextNoteAnnotation
} from "../test-dist/pdf-annotations.mjs";

async function blankPdf() {
  const document = await PDFDocument.create();
  document.addPage([600, 800]);
  const bytes = await document.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test("writes standard highlight and text annotations into a PDF", async () => {
  const highlighted = await writeTextMarkupAnnotation(await blankPdf(), {
    page: 1,
    rects: [[72, 700, 260, 716]],
    subtype: "Highlight",
    color: "#ffd54f",
    author: "Tester",
    contents: "Evidence",
    id: "ai4d-highlight-test"
  });
  const noted = await writeTextNoteAnnotation(highlighted.buffer.slice(highlighted.byteOffset, highlighted.byteOffset + highlighted.byteLength), {
    page: 1,
    point: [270, 716],
    color: "#65b6e3",
    author: "Tester",
    contents: "Review this claim",
    id: "ai4d-comment-test"
  });
  const document = await PDFDocument.load(noted);
  const annotations = document.getPage(0).node.Annots().asArray();
  assert.equal(annotations.length, 2);
  const subtypes = annotations.map(reference => document.context.lookup(reference).get(PDFName.of("Subtype")).asString());
  assert.deepEqual(subtypes, ["/Highlight", "/Text"]);

  const listed = await readPdfAnnotations(noted.buffer.slice(noted.byteOffset, noted.byteOffset + noted.byteLength));
  assert.equal(listed.length, 2);
  assert.equal(listed[0].key, "ai4d-highlight-test");
  const edited = await updatePdfAnnotationContents(
    noted.buffer.slice(noted.byteOffset, noted.byteOffset + noted.byteLength),
    1,
    "ai4d-highlight-test",
    "Updated evidence"
  );
  assert.equal((await readPdfAnnotations(edited.buffer.slice(edited.byteOffset, edited.byteOffset + edited.byteLength)))[0].contents, "Updated evidence");
  const deleted = await deletePdfAnnotation(edited.buffer.slice(edited.byteOffset, edited.byteOffset + edited.byteLength), 1, "ai4d-comment-test");
  assert.equal((await readPdfAnnotations(deleted.buffer.slice(deleted.byteOffset, deleted.byteOffset + deleted.byteLength))).length, 1);
});

test("all markup kinds retain identity through recolor, reject invalid geometry", async () => {
  for (const subtype of ['Highlight', 'Underline', 'StrikeOut']) {
    const marked = await writeTextMarkupAnnotation(await blankPdf(), {page:1, rects:[[72,700,260,716]], subtype, color:'#ffd54f', author:'test', contents:'译文', id:`ai4d-${subtype}`});
    const recolored = await updatePdfAnnotationColor(marked.slice().buffer, 1, `ai4d-${subtype}`, '#65b6e3');
    const [annotation] = await readPdfAnnotations(recolored.slice().buffer);
    assert.equal(annotation.subtype, subtype); assert.equal(annotation.color, '#65b6e3'); assert.equal(annotation.contents, '译文');
  }
  await assert.rejects(writeTextMarkupAnnotation(await blankPdf(), {page:1, rects:[[0,0,NaN,10]], subtype:'Highlight', color:'#ffd54f', author:'test', id:'bad'}), /有效/);
});

test("reads and deletes direct annotation dictionaries from external PDFs", async () => {
  const doc = await PDFDocument.create(); const page = doc.addPage();
  page.node.set(PDFName.of('Annots'), doc.context.obj([{Type:'Annot',Subtype:'Highlight',Rect:[10,10,60,30],C:[1,1,0]}]));
  const bytes = await doc.save(); const [annotation] = await readPdfAnnotations(bytes.slice().buffer);
  assert.equal(annotation.key,'direct-1-0');
  const deleted = await deletePdfAnnotation(bytes.slice().buffer,1,annotation.key);
  assert.equal((await readPdfAnnotations(deleted.slice().buffer)).length,0);
});
