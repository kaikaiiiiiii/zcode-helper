'use strict';
/** 队列：去重、状态流转、清空 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Queue } = require('../../src/queue');

const tmp = () => new Queue(fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-q-')));

test('snapshot 同会话同内容去重', () => {
  const q = tmp();
  const a = q.add({ workspacePath: 'D:\\x', sessionId: 's1', source: 'snapshot', text: 'hello' });
  const b = q.add({ workspacePath: 'D:\\x', sessionId: 's1', source: 'snapshot', text: 'hello' });
  assert.ok(a.added);
  assert.equal(b.added, null);
  assert.equal(b.deduped, a.added.id);
  assert.equal(q.pendingItems().length, 1);
});

test('intercept 覆盖同内容的 pending snapshot', () => {
  const q = tmp();
  const snap = q.add({ workspacePath: 'D:\\x', sessionId: 's1', source: 'snapshot', text: 'msg' });
  const cap = q.add({ workspacePath: 'D:\\x', sessionId: 's1', source: 'intercept', text: 'msg' });
  assert.ok(cap.added);
  assert.equal(q.all().length, 1);
  assert.equal(q.all()[0].id, cap.added.id);
  assert.equal(q.get(snap.added.id), null);
});

test('状态单向流转 + failed 可重置', () => {
  const q = tmp();
  const it = q.add({ source: 'intercept', text: 'x', sessionId: 's' }).added;
  assert.equal(q.setStatus(it.id, 'sent'), true);
  assert.equal(q.setStatus(it.id, 'pending'), false, 'sent 不能回 pending');
  const it2 = q.add({ source: 'intercept', text: 'y', sessionId: 's' }).added;
  assert.equal(q.setStatus(it2.id, 'failed', { error: 'boom' }), true);
  assert.equal(q.get(it2.id).error, 'boom');
  assert.equal(q.setStatus(it2.id, 'pending'), true);
  assert.equal(q.get(it2.id).error, null);
});

test('clearSent 只清已发送', () => {
  const q = tmp();
  const a = q.add({ source: 'intercept', text: 'a', sessionId: 's' }).added;
  const b = q.add({ source: 'intercept', text: 'b', sessionId: 's' }).added;
  const c = q.add({ source: 'intercept', text: 'c', sessionId: 's' }).added;
  q.setStatus(a.id, 'sent');
  q.setStatus(b.id, 'failed', { error: 'e' });
  assert.equal(q.clearSent(), 1);
  assert.deepEqual(q.counts(), { pending: 1, sent: 0, failed: 1, draft: 0 });
  assert.equal(q.get(a.id), null);
  assert.ok(q.get(b.id));
  assert.ok(q.get(c.id));
});

test('remove 与 counts', () => {
  const q = tmp();
  const it = q.add({ source: 'intercept', text: 'z', sessionId: 's' }).added;
  assert.equal(q.remove(it.id), true);
  assert.equal(q.remove('nope'), false);
  assert.deepEqual(q.counts(), { pending: 0, sent: 0, failed: 0, draft: 0 });
});

test('消息类型：默认 submit，draft 不进入自动回放', () => {
  const q = tmp();
  const a = q.add({ source: 'intercept', text: 'A', sessionId: 's1' });
  const d = q.add({ source: 'draft', type: 'draft', text: '用户草稿', sessionId: 's1' });
  assert.equal(a.added.type, 'submit', '默认类型是提交');
  assert.equal(d.added.type, 'draft');
  assert.equal(q.pendingItems().length, 2);
  assert.equal(q.pendingSubmits().length, 1, '自动回放只取 submit');
  assert.deepEqual(q.pendingSubmits().map(i => i.id), [a.added.id]);
  assert.equal(q.draftItems().length, 1);
  assert.deepEqual(q.counts(), { pending: 1, sent: 0, failed: 0, draft: 1 });
});

test('草稿不参与 snapshot 去重以外的状态推进（提交后可移除）', () => {
  const q = tmp();
  const d = q.add({ source: 'draft', type: 'draft', text: '草稿', sessionId: 's' }).added;
  assert.equal(q.setStatus(d.id, 'sent'), true);
  assert.equal(q.counts().draft, 0, '状态推进后不再算草稿');
  assert.equal(q.remove(d.id), true);
});


test('附件随条目持久化（路径/粘贴 dataUrl）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-q-'));
  const q = new Queue(dir, 7);
  const atts = [
    { kind: 'image', name: 'a.png', path: 'D:\\project\\a.png', size: 5, mime: 'image/png' },
    { kind: 'image', name: 'pasted.png', path: null, dataUrl: 'data:image/png;base64,AAAA', size: 3, mime: 'image/png' }
  ];
  const { added } = q.add({ workspacePath: 'D:\\p', sessionId: 'sess_1', source: 'intercept', text: '带图', attachments: atts });
  assert.deepEqual(added.attachments, atts);
  const q2 = new Queue(dir, 7);
  const back = q2.get(added.id);
  assert.deepEqual(back.attachments, atts, '重启后附件仍在');
  assert.equal(back.attachments[0].path, 'D:\\project\\a.png');
  assert.equal(q.counts().pending, 1);
});
