import { PDFDocument, StandardFonts } from 'pdf-lib';
import { writeFile } from 'node:fs/promises';
import { writeTextMarkupAnnotation, writeTextNoteAnnotation } from '../test-dist/pdf-annotations.mjs';
const doc=await PDFDocument.create();const page=doc.addPage([600,420]);const font=await doc.embedFont(StandardFonts.Helvetica);
page.drawText('Paper-easy / Native annotation rendering check',{x:40,y:375,size:18,font});
const labels=['Highlight: preserve the selected evidence.','Underline: keep the claim easy to find.','StrikeOut: mark a claim for reconsideration.'];
for(let i=0;i<labels.length;i++) page.drawText(labels[i],{x:50,y:310-i*70,size:15,font});
let bytes=await doc.save();
for(const [i,subtype] of ['Highlight','Underline','StrikeOut'].entries()) {
  bytes=await writeTextMarkupAnnotation(bytes.slice().buffer,{page:1,rects:[[48,307-i*70,450,326-i*70]],subtype,color:['#ffd54f','#65b6e3','#ef767a'][i],author:'Paper-easy test',contents:'Persistent comment',quote:labels[i],id:`ai4d-${subtype.toLowerCase()}-fixture`});
}
bytes=await writeTextNoteAnnotation(bytes.slice().buffer,{page:1,point:[465,307],color:'#75c49a',author:'Paper-easy test',contents:'译文持久保存 / Persistent translation',id:'ai4d-translation-fixture'});
await writeFile('test-dist/native-annotations.pdf',bytes);
