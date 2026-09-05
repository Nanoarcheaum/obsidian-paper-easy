import test from 'node:test';
import assert from 'node:assert/strict';
import { vaultWriteStore } from '../test-dist/write-store.mjs';
import { AnnotationWrites } from '../test-dist/transactions.mjs';

function fixture() {
  const files=new Map(); let tick=0;
  const state={pdf:new Uint8Array([1]).buffer,note:'note',failMarker:false};
  const adapter={
    exists:async path=>files.has(path), mkdir:async path=>files.set(path,{folder:true}),
    write:async(path,value)=>{if(state.failMarker && path.endsWith('.complete')) throw Error('disk'); files.set(path,{value,mtime:++tick});},
    writeBinary:async(path,value)=>files.set(path,{value,mtime:++tick}),
    read:async path=>files.get(path).value, readBinary:async path=>files.get(path).value,
    stat:async path=>files.get(path), remove:async path=>files.delete(path),
    list:async dir=>({files:[...files.keys()].filter(path=>path.startsWith(dir+'/'))})
  };
  const app={vault:{adapter,getFileByPath:path=>({path}),readBinary:async()=>state.pdf,modifyBinary:async(_,bytes)=>{state.pdf=bytes;},read:async()=>state.note,process:async(_,transform)=>{state.note=transform(state.note);}}};
  const store=vaultWriteStore(app,'plugins/paper/recovery');
  return {state,files,store,writes:new AnnotationWrites(store)};
}

test('durable store never overwrites write-ahead JSON; failed completion marker can recover', async()=>{
  const {state,files,store,writes}=fixture();state.failMarker=true;
  await assert.rejects(writes.run('A.pdf','A.md',async()=>new Uint8Array([2]),()=> 'new note'),/恢复/);
  const path=[...files.keys()].find(path=>path.endsWith('.json'));
  const original=files.get(path).value;
  assert.equal(JSON.parse(original).status,'pending');
  state.failMarker=false;
  assert.equal((await new AnnotationWrites(store).recover()).recovered,1);
  assert.equal(files.get(path).value,original);
  assert.equal((await store.records())[0].status,'complete');
});
test('keeps three completed PDF backups and rejects malformed record paths',async()=>{
  const {files,store,writes}=fixture();
  for(let i=2;i<7;i++) await writes.run('A.pdf','A.md',async()=>new Uint8Array([i]),()=>String(i));
  assert.equal((await store.records()).length,3);
  assert.equal([...files.keys()].filter(path=>path.endsWith('.pdf')).length,3);
  const path=[...files.keys()].find(path=>path.endsWith('.json'));
  const record=JSON.parse(files.get(path).value); record.pdfPath='../outside.pdf';
  files.get(path).value=JSON.stringify(record);
  await assert.rejects(store.records(),/损坏/);
});
