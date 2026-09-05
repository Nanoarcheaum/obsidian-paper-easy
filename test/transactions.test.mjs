import test from 'node:test';
import assert from 'node:assert/strict';
import { AnnotationWrites, KeyedQueue } from '../test-dist/transactions.mjs';

const bytes = value => new TextEncoder().encode(value).buffer;
const text = buffer => new TextDecoder().decode(buffer);
function fixture() {
  const state = { pdf: bytes('original'), note: 'notes', fail: false, saved: new Map(), backups: new Map() };
  const store = {
    async readPdf() { return state.pdf; }, async writePdf(_, value) { state.pdf = value; },
    async readNote() { return state.note; }, async processNote(_, change) { if (state.fail) throw Error('disk full'); state.note = change(state.note); },
    async save(record, backup) { state.saved.set(record.id, structuredClone(record)); if (backup) state.backups.set(record.id, backup); },
    async backup(id) { return state.backups.get(id); }, async records() { return [...state.saved.values()]; }
  };
  return { state, store, writes: new AnnotationWrites(store) };
}

test('serializes rapid writes without losing annotations', async () => {
  const { state, writes } = fixture();
  await Promise.all(['A', 'B', 'C'].map(letter => writes.run('paper.pdf', 'paper.md', async value => new Uint8Array(bytes(text(value) + letter)), note => note + letter)));
  assert.equal(text(state.pdf), 'originalABC'); assert.equal(state.note, 'notesABC');
});
test('recovers a PDF-first interruption exactly once across restart', async () => {
  const { state, store, writes } = fixture(); state.fail = true;
  await assert.rejects(writes.run('paper.pdf', 'paper.md', async () => new Uint8Array(bytes('changed')), () => 'changed note'), /恢复/);
  assert.equal(state.note, 'notes'); assert.equal(text(state.pdf), 'changed');
  await assert.rejects(writes.run('paper.pdf', 'paper.md', async b => new Uint8Array(b), n => n), /未完成/);
  state.fail = false;
  assert.deepEqual(await new AnnotationWrites(store).recover(), { recovered: 1, conflicts: 0 });
  assert.equal(state.note, 'changed note');
  assert.deepEqual(await writes.recover(), { recovered: 0, conflicts: 0 });
});
test('refuses to overwrite a note edited during a failed save', async () => {
  const { state, writes } = fixture(); state.fail = true;
  await assert.rejects(writes.run('paper.pdf', 'paper.md', async () => new Uint8Array(bytes('changed')), () => 'new'));
  state.fail = false; state.note = 'user thought';
  assert.equal((await writes.recover()).conflicts, 1); assert.equal(state.note, 'user thought');
});
test('detects an external PDF change before committing', async () => {
  const { state, writes } = fixture();
  await assert.rejects(writes.run('paper.pdf', 'paper.md', async () => { state.pdf = bytes('external'); return new Uint8Array(bytes('ours')); }, n => n), /其他操作/);
  assert.equal(text(state.pdf), 'external'); assert.equal(state.note, 'notes');
});
test('validates unsafe Markdown before touching PDF or creating backups', async () => {
  const { state, writes } = fixture();
  await assert.rejects(writes.run('paper.pdf', 'paper.md', async () => { throw Error('must not execute'); }, () => { throw Error('unsafe block'); }), /unsafe/);
  assert.equal(text(state.pdf), 'original'); assert.equal(state.saved.size, 0);
});
test('undo restores both files and refuses later edits', async () => {
  const { state, writes } = fixture();
  await writes.run('paper.pdf', 'paper.md', async () => new Uint8Array(bytes('changed')), () => 'new');
  state.note = 'user thought'; await assert.rejects(writes.undo('paper.pdf'), /笔记/);
  state.note = 'new'; await writes.undo('paper.pdf');
  assert.equal(text(state.pdf), 'original'); assert.equal(state.note, 'notes');
});
test('queue survives rejection and allows independent files', async () => {
  const queue = new KeyedQueue();
  await assert.rejects(queue.run('a', async () => { throw Error('fail'); }));
  assert.equal(await queue.run('a', async () => 42), 42);
  assert.equal(await queue.run('b', async () => 7), 7);
});
