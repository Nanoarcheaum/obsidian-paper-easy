import test from "node:test";
import assert from "node:assert/strict";
import {
  appendPaperBlock,
  repairBlockReferences,
  paperTags,
  annotationEmbed,
  buildAnnotation,
  buildFigureAnnotation,
  buildMarkupAnnotation,
  buildPaperNote,
  parseAnnotationIndex,
  parsePaperBlocks,
  parsePaperLink,
  removeMarkupBlock,
  safeStem,
  updateMarkupBlockComment
} from "../test-dist/paper.mjs";

test("builds a portable companion note", () => {
  const note = buildPaperNote("Papers/A Paper.pdf", 'A "Paper"');
  assert.match(note, /ai4d-type: paper/);
  assert.match(note, /tags:\n  - Paper/);
  assert.match(note, /paper: "\[\[Papers\/A Paper\.pdf\]\]"/);
  assert.match(note, /\[\[Papers\/A Paper\.pdf#page=1\|从第 1 页开始阅读\]\]/);
});

test("builds searchable native markup companion blocks", () => {
  const markdown = buildMarkupAnnotation("Papers/A Paper.pdf", 4, "Selected evidence", "underline", "Check the proof.", "ai4d-underline-test");
  assert.doesNotMatch(markdown, /\[!paper-/);
  assert.match(markdown, /> Selected evidence/);
  assert.match(markdown, /\[\[Papers\/A Paper\.pdf#page=4\|↗ 第 4 页\]\]/);
  assert.match(markdown, /\*\*我的批注\*\*　Check the proof\./);
  const updated = updateMarkupBlockComment(markdown, "ai4d-underline-test", "Revised note.");
  assert.doesNotMatch(updated, /Check the proof/);
  assert.match(updated, /\*\*我的批注\*\*　Revised note\./);
  const indexed = parseAnnotationIndex(updated, "Papers/A Paper.md", "Papers/A Paper.pdf", "A Paper");
  assert.equal(indexed[0].type, "underline");
  assert.equal(indexed[0].page, 4);
  assert.match(indexed[0].text, /Selected evidence/);
  assert.equal(removeMarkupBlock(`before\n${updated}\nafter`, "ai4d-underline-test"), "before\n\n\nafter");
});

test("builds a visible figure annotation with a source jump", () => {
  const markdown = buildFigureAnnotation(
    "Papers/A Paper.pdf",
    "Papers/figures/figure-p7.png",
    7,
    "ai4d-fig-test"
  );
  assert.match(markdown, /!\[\[Papers\/figures\/figure-p7\.png\]\]/);
  assert.match(markdown, /\[\[Papers\/A Paper\.pdf#page=7\|↗ 第 7 页\]\]/);
  assert.match(markdown, /\^ai4d-fig-test/);
  const indexed = parseAnnotationIndex(markdown, "Papers/A Paper.md", "Papers/A Paper.pdf", "A Paper");
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0].type, "figure");
  assert.equal(indexed[0].page, 7);
});

test("round-trips an annotation into an embeddable block", () => {
  const markdown = buildAnnotation("Papers/A Paper.pdf", 12, "First line\nSecond line", "Important", "ai4d-test-1", "第一行，第二行");
  assert.doesNotMatch(markdown, /\[!paper-quote\]/);
  assert.match(markdown, /> First line\n> Second line/);
  assert.match(markdown, /\*\[\[Papers\/A Paper\.pdf#page=12\|↗ 第 12 页\]\]\*/);
  const blocks = parsePaperBlocks(markdown, "Papers/A Paper.md", "A Paper");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].page, 12);
  assert.equal(blocks[0].quote, "First line Second line");
  assert.equal(blocks[0].translation, "第一行，第二行");
  assert.equal(blocks[0].comment, "Important");
  assert.equal(annotationEmbed(blocks[0]), "![[Papers/A Paper.md#^ai4d-test-1]]");
  const indexed = parseAnnotationIndex(markdown, "Papers/A Paper.md", "Papers/A Paper.pdf", "A Paper");
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0].type, "quote");
});

test("normalizes linked PDF paths and safe import names", () => {
  assert.equal(parsePaperLink("[[Papers\\Paper.pdf|PDF]]"), "Papers/Paper.pdf");
  assert.equal(safeStem('A: risky? "title".pdf'), "A- risky- -title-");
});


test("never deletes surrounding user content or a prefix-matching ID", () => {
  const a = buildMarkupAnnotation('A.pdf', 1, 'first', 'highlight', '', 'ai4d-highlight-first');
  const b = buildMarkupAnnotation('A.pdf', 2, 'second', 'highlight', '', 'ai4d-highlight-second');
  const before = 'intro\n\n\n' + a + '\nmy handwritten thought\n\n';
  const content = before + b + '\n\n\nending';
  const deleted = removeMarkupBlock(content, 'ai4d-highlight-second');
  assert.ok(deleted.startsWith(before)); assert.ok(deleted.endsWith('\n\n\nending'));
  assert.equal(removeMarkupBlock(content, 'ai4d-highlight-sec'), content);
  const damaged = a + '\nmy thought\n\n^ai4d-highlight-broken\n';
  assert.throws(() => removeMarkupBlock(damaged, 'ai4d-highlight-broken'), /手动修改/);
  assert.throws(() => removeMarkupBlock(a + a, 'ai4d-highlight-first'), /重复/);
});

test("full-text index includes late text, translation, comments and all block types", () => {
  const quote = buildAnnotation('A.pdf', 1, 'x'.repeat(600) + ' tail-token', 'comment-token', 'ai4d-test', 'translation-token');
  const image = buildFigureAnnotation('A.pdf', 'figures/chart.png', 2, 'ai4d-fig-test');
  const native = buildMarkupAnnotation('A.pdf', 3, 'evidence', 'comment', 'native-token', 'ai4d-comment-test');
  const index = parseAnnotationIndex(quote + image + native, 'A.md', 'A.pdf', 'A');
  assert.equal(index.length, 3);
  for (const token of ['tail-token', 'comment-token', 'translation-token']) assert.ok(index[0].text.includes(token));
  assert.ok(index[2].text.includes('native-token'));
  assert.equal(parsePaperBlocks(quote + image + native, 'A.md', 'A').length, 3);
});

test("legacy CRLF blocks remain searchable and opt-in repair keeps IDs", () => {
  const legacy = '> [!paper-quote]+ 摘录 · 第 7 页\n> Old evidence\n> [[A.pdf#page=7|↗ 打开原文第 7 页]]\n\n^ai4d-old\n';
  const light = '> New evidence\n\n*[[A.pdf#page=3|↗ 第 3 页]]*\n\n^ai4d-light\n';
  assert.equal(parsePaperBlocks(legacy.replaceAll('\n', '\r\n'), 'A.md', 'A')[0].quote, 'Old evidence');
  const repaired = repairBlockReferences(light);
  assert.match(repaired, /> \*\[\[A.pdf/); assert.match(repaired, /\^ai4d-light/);
  assert.equal(repairBlockReferences(repaired), repaired);
});

test("new complete quote has one structured block before the ID, including image and link", () => {
  for (const value of [buildAnnotation('A.pdf', 1, 'text', '', 'ai4d-a'), buildFigureAnnotation('A.pdf', 'figure.png', 1, 'ai4d-fig-a')]) {
    const lines = value.trim().split('\n');
    assert.ok(lines.slice(0, -2).every(line => line.startsWith('>')));
    assert.equal(lines.at(-2), ''); assert.match(lines.at(-1), /^\^ai4d-/);
  }
});

test("append is idempotent and tag strings survive", () => {
  const block = buildAnnotation('A.pdf', 1, 'text', '', 'ai4d-a');
  const once = appendPaperBlock('notes', block, 'ai4d-a');
  assert.equal(appendPaperBlock(once, block, 'ai4d-a'), once);
  assert.deepEqual(paperTags('Physics, #Paper reviewed'), ['Physics', 'reviewed', 'Paper']);
});
