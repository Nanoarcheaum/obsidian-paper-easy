import test from 'node:test';
import assert from 'node:assert/strict';
import { matchZoteroAttachment, verifyWriteResult } from '../test-dist/zotero-matching.mjs';
import { convertFormulaToMarkdown, normalizeFormulaMarkdown, translateText, withTimeout } from '../test-dist/translator.mjs';
import { ZoteroLocalClient } from '../test-dist/zotero.mjs';

test('Zotero resolves identity and full paths, refuses ambiguous filenames and foreign paths', () => {
  const candidates = [{ path: 'Math/Paper.pdf', absolutePath: 'E:/Vault/Math/Paper.pdf' }, { path: 'Physics/Paper.pdf', absolutePath: 'E:/Vault/Physics/Paper.pdf', attachmentKey: 'KEY12345' }];
  assert.equal(matchZoteroAttachment({ key: 'UNKNOWN', filename: 'Paper.pdf' }, candidates), null);
  assert.equal(matchZoteroAttachment({ key: 'UNKNOWN', path: 'E:/Outside/Paper.pdf' }, candidates), null);
  assert.equal(matchZoteroAttachment({ key: 'KEY12345' }, candidates), candidates[1]);
  assert.equal(matchZoteroAttachment({ key: 'UNKNOWN', path: 'e:\\vault\\math\\paper.pdf' }, candidates), candidates[0]);
  assert.equal(matchZoteroAttachment({ key: 'UNKNOWN', path: 'attachments:Math/Paper.pdf' }, candidates), candidates[0]);
});
test('HTTP 200 alone cannot mark a partial Zotero write as complete', () => {
  assert.throws(() => verifyWriteResult({ successful: { 0: { key: 'PARENT' } }, failed: { 1: { message: 'bad path' } } }, ['PARENT', 'ATTACH']), /bad path/);
  verifyWriteResult({ successful: { 0: { key: 'PARENT' } }, unchanged: { 1: 'ATTACH' } }, ['PARENT', 'ATTACH']);
});
test('Ollama uses native chat, preserves model and caches identical passages', async () => {
  let count = 0;
  globalThis.__requestUrl = async request => {
    count++; assert.equal(request.url, 'http://localhost:11434/api/chat');
    const body = JSON.parse(request.body); assert.equal(body.model, 'my-model'); assert.equal(body.think, false);
    assert.equal(body.messages[1].content, 'A selected sentence');
    return { status: 200, json: { message: { content: ' 一句选段 ' } } };
  };
  const config = { endpoint: 'http://localhost:11434/v1/chat/completions', model: 'my-model', targetLanguage: '中文', apiKey: '' };
  assert.equal(await translateText('A selected sentence', config), '一句选段');
  assert.equal(await translateText('A selected sentence', config), '一句选段'); assert.equal(count, 1);
});
test('translation handles non-JSON error pages and bounded wait', async () => {
  globalThis.__requestUrl = async () => ({ status: 404, get json() { throw Error('not JSON'); }, text: '<html>not found</html>' });
  await assert.rejects(translateText('other passage', { endpoint: 'http://localhost:11434/api/chat', model: 'm', targetLanguage: 'zh', apiKey: '' }), /HTTP 404/);
  await assert.rejects(withTimeout(new Promise(() => {}), 10), /超时/);
});
test('Ollama converts selected formula into normalized Obsidian Markdown', async () => {
  let count = 0;
  globalThis.__requestUrl = async request => {
    count++;
    const body = JSON.parse(request.body);
    assert.equal(request.url, 'http://localhost:11434/api/chat');
    assert.equal(body.think, false);
    assert.equal(body.options.temperature, 0);
    assert.equal(body.messages[1].content, 'E = mc 2');
    return { status: 200, json: { message: { content: '```latex\n\\[E = mc^2\\]\n```' } } };
  };
  const config = { endpoint: 'http://localhost:11434/api/chat', model: 'qwen3:14b', targetLanguage: '中文', apiKey: '' };
  assert.equal(await convertFormulaToMarkdown('E = mc 2', config), '$$\nE = mc^2\n$$');
  assert.equal(await convertFormulaToMarkdown('E = mc 2', config), '$$\nE = mc^2\n$$');
  assert.equal(count, 1);
  assert.equal(normalizeFormulaMarkdown('\\(x_1+x_2\\)'), '$x_1+x_2$');
  assert.equal(normalizeFormulaMarkdown('x^2+y^2=z^2'), '$$\nx^2+y^2=z^2\n$$');
  await assert.rejects(convertFormulaToMarkdown('x', { ...config, endpoint: 'https://api.example.com/v1/chat/completions' }), /Ollama/);
});
test('Zotero retries only missing attachment using persisted keys', async () => {
  const pending = { parentKey: 'ABCD2345', attachmentKey: 'EFGH2345' };
  let posts = 0;
  globalThis.__requestUrl = async request => {
    if (request.url.endsWith('limit=1')) return { headers: { 'zotero-server-id': 'server', 'x-zotero-version': '10' } };
    if (request.method === 'POST') { const payload = JSON.parse(request.body); assert.equal(payload.length, 1); assert.equal(payload[0].key, pending.attachmentKey); posts++; return { status: 200, json: { successful: { 0: { key: pending.attachmentKey } } } }; }
    if (request.url.endsWith(pending.parentKey)) return { status: 200, json: { data: { key: pending.parentKey, itemType: 'journalArticle' } } };
    return { status: 404 };
  };
  const client = new ZoteroLocalClient('http://localhost/api', 'key', async () => {});
  assert.deepEqual(await client.createLinkedPaper({ title: 'Paper', authors: [], year: '', doi: '', pdfPath: 'E:/paper.pdf', pending, savePending: async value => assert.deepEqual(value, pending) }), pending);
  assert.equal(posts, 1);
});
