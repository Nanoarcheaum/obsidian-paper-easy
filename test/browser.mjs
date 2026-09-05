import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readPdfAnnotations } from '../test-dist/pdf-annotations.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PAPER_EASY_PLAYWRIGHT || 'playwright');
const root = resolve('.');
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!path.startsWith(root + '\\') && !path.startsWith(root + '/')) throw Error('outside');
    response.setHeader('Content-Type', ({ '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' })[extname(path)] || 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.statusCode=404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless:true, channel:process.env.PAPER_EASY_BROWSER || undefined });
  const page = await browser.newPage({ viewport:{width:1100,height:800} });
  const errors=[]; page.on('pageerror', error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/test/index.html`);
  await page.waitForFunction(()=>window.fixture?.ready);
  assert.equal(await page.locator('.ai4d-toolbar-row').count(),2);
  assert.equal(await page.locator('.ai4d-markup-action').count(),8);
  const colors=await page.locator('.ai4d-color-swatch').evaluateAll(els=>els.map(el=>getComputedStyle(el).backgroundColor));
  assert.equal(new Set(colors).size,4); assert.ok(colors.every(c=>c!=='rgba(0, 0, 0, 0)'));
  assert.equal(await page.locator('.ai4d-annotation-group').count(),2);
  await page.locator('.ai4d-library-search').fill('证据');
  assert.equal(await page.locator('.ai4d-annotation-hit').count(),1);
  await page.locator('.ai4d-library-search').fill('');
  const coords=await page.evaluate(()=>{const s=window.selectPassage(); return {rects:s.pdfRects, wrong:fixture.plugin.readPdfSelection({path:'wrong.pdf'})};});
  assert.ok(coords.rects.length>0); assert.equal(coords.wrong,null);
  await page.evaluate(()=>{for(let i=0;i<10;i++) fixture.plugin.decoratePdfView(fixture.leaf);});
  assert.equal(await page.locator('.ai4d-pdf-action').count(),4);
  await page.evaluate(()=>{document.querySelector('.view-actions').replaceChildren(); fixture.plugin.decoratePdfView(fixture.leaf);});
  assert.equal(await page.locator('.ai4d-pdf-action').count(),4);
  await page.evaluate(()=>{fixture.plugin.showPdfSelectionTrigger(fixture.selection,{x:170,y:285});});
  await page.locator('.ai4d-selection-toolbar').waitFor({state:'visible'});
  await page.screenshot({path:'test-dist/annotation-ui.png',fullPage:true,animations:'disabled'});
  // Late translation response must not recreate a dismissed UI.
  await page.evaluate(()=>{
    window.__requestUrl=()=>new Promise(resolve=>window.finishTranslation=resolve);
    window.pendingTranslation=fixture.plugin.translateSelection(fixture.pdf,fixture.selection);
    fixture.plugin.dismissTranslationUi();
    window.finishTranslation({status:200,json:{message:{content:'译文'}}});
  });
  await page.evaluate(()=>window.pendingTranslation);
  assert.equal(await page.locator('.ai4d-translation-card').count(),0);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>fixture.plugin.showPdfSelectionTrigger(fixture.selection,{x:1050,y:770}));
  assert.equal(await page.locator('.ai4d-selection-toolbar').evaluate(el=>getComputedStyle(el).animationName),'none');
  const bounds=await page.locator('.ai4d-selection-toolbar').boundingBox(); assert.ok(bounds.x+bounds.width<=1100);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.ai4d-selection-toolbar').count(),0);
  // Exercise the actual plugin -> journal -> pdf-lib -> Markdown integration in memory.
  await page.evaluate(async()=>{
    const pdfBytes=await (await fetch('/test-dist/native-annotations.pdf')).arrayBuffer();
    const note={path:'Physics/Paper/Paper.md',extension:'md',basename:'Paper',stat:{mtime:1}};
    const memory={pdf:pdfBytes,note:'---\npaper: "[[Physics/Paper/Paper.pdf]]"\ntags: [Paper]\n---\n\n## 批注\n',files:new Map()};
    fixture.memory=memory;
    const adapter=fixture.plugin.app.vault.adapter;
    Object.assign(adapter,{
      exists:async path=>memory.files.has(path),mkdir:async path=>memory.files.set(path,{}),
      write:async(path,value)=>memory.files.set(path,{value,mtime:Date.now()}),writeBinary:async(path,value)=>memory.files.set(path,{value,mtime:Date.now()}),
      read:async path=>memory.files.get(path).value,readBinary:async path=>memory.files.get(path).value,stat:async path=>memory.files.get(path),
      remove:async path=>memory.files.delete(path),list:async path=>({files:[...memory.files.keys()].filter(key=>key.startsWith(path+'/'))})
    });
    Object.assign(fixture.plugin.app.vault,{
      getFileByPath:path=>path===note.path?note:path===fixture.pdf.path?fixture.pdf:null,
      getMarkdownFiles:()=>[note],read:async()=>memory.note,readBinary:async()=>memory.pdf,
      modifyBinary:async(_,bytes)=>{memory.pdf=bytes;fixture.pdf.stat.mtime++;},
      process:async(_,transform)=>{memory.note=transform(memory.note);note.stat.mtime++;}
    });
    fixture.plugin.app.metadataCache.getFileCache=()=>({frontmatter:{paper:'[[Physics/Paper/Paper.pdf]]',tags:['Paper']}});
    fixture.plugin.settings.openSideBySide=false;
    await fixture.plugin.createNativeMarkup(fixture.selection,'Highlight','持久译文',true);
  });
  const stored=await page.evaluate(()=>({pdf:Array.from(new Uint8Array(fixture.memory.pdf)),note:fixture.memory.note}));
  const native=(await readPdfAnnotations(new Uint8Array(stored.pdf).buffer)).find(item=>item.key.startsWith('ai4d-translation-') && item.contents==='持久译文');
  assert.ok(native);assert.ok(stored.note.includes('**译文**　持久译文'));
  await page.evaluate(async annotation=>{await fixture.plugin.editNativeAnnotation(fixture.pdf,annotation,'修订译文');},native);
  assert.ok(await page.evaluate(()=>fixture.memory.note.includes('修订译文')));
  native.contents='修订译文';
  await page.evaluate(async annotation=>{await fixture.plugin.deleteNativeAnnotation(fixture.pdf,annotation);},native);
  assert.equal(await page.evaluate(id=>fixture.memory.note.includes(id),native.key),false);
  await page.evaluate(()=>fixture.plugin.writes.undo(fixture.pdf.path));
  assert.equal(await page.evaluate(id=>fixture.memory.note.includes(id),native.key),true);
  await page.evaluate(()=>{fixture.plugin.onunload(); fixture.plugin.disposers.forEach(fn=>fn());});
  assert.equal(await page.locator('.ai4d-pdf-action').count(),0);
  assert.deepEqual(errors,[]);
  console.log('Browser checks passed: menu, colors, search, grouping, coordinates, lifecycle, late response, reduced motion; actual plugin PDF+Markdown translation create/edit/delete/undo integration.');
} finally { await browser?.close(); server.close(); }
