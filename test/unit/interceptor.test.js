'use strict';
/** 截获上报的 helper 侧终审：只接受录制态、非回放、非静默窗 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Queue } = require('../../src/queue');
const { Interceptor } = require('../../src/interceptor');

function make(sm) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-int-'));
  const queue = new Queue(dir);
  const logs = [];
  const engine = { currentWorkspacePath: () => 'D:\\proj', refreshIndicator() {}, clearComposerAfterCapture: async () => true };
  const interceptor = new Interceptor({
    queue, engine,
    logger: { log: (ev, f) => logs.push({ ev, ...f }) },
    stateMachine: sm
  });
  return { queue, interceptor, logs, engine };
}

const baseSM = () => ({
  connState: 'CONNECTED', mode: 'RECORDING', replaying: false,
  inSilenceWindow: () => false
});

test('录制态截获 -> 入队（source=intercept，带会话与工作区）', () => {
  const { queue, interceptor, logs } = make(baseSM());
  interceptor.handleReport({ type: 'capture', text: '  hello  ', session: { sessionId: 's1', sessionTitle: 'title' } });
  const item = queue.all()[0];
  assert.equal(item.text, 'hello', '文本 trim');
  assert.equal(item.source, 'intercept');
  assert.equal(item.sessionId, 's1');
  assert.equal(item.workspacePath, 'D:\\proj');
  assert.ok(logs.some(l => l.accepted === true));
});

test('暂停助手时拒绝截获（页面通常已直接放行）', () => {
  const { queue, interceptor, logs, engine } = make(baseSM());
  engine.helperPaused = true;
  interceptor.handleReport({ type: 'capture', text: 'x', session: {} });
  assert.equal(queue.all().length, 0);
  assert.ok(logs.some(l => l.accepted === false && /helper-paused/.test(l.why)));
});

test('未受控拒绝截获', () => {
  const sm = { ...baseSM(), connState: 'UNCONTROLLED' };
  const { queue, interceptor, logs } = make(sm);
  interceptor.handleReport({ type: 'capture', text: 'x', session: {} });
  assert.equal(queue.all().length, 0);
  assert.ok(logs.some(l => l.why === 'uncontrolled'));
});

test('静默窗内拒绝截获', () => {
  const sm = { ...baseSM(), inSilenceWindow: () => true };
  const { queue, interceptor } = make(sm);
  interceptor.handleReport({ type: 'capture', text: 'x', session: {} });
  assert.equal(queue.all().length, 0);
});

test('指令弹层回车（enter-passthrough）只记日志不入队', () => {
  const { queue, interceptor, logs } = make(baseSM());
  interceptor.handleReport({ type: 'enter-passthrough', reason: 'suggestions-open' });
  assert.equal(queue.all().length, 0);
  assert.ok(logs.some(l => l.action === 'enter-passthrough' && l.accepted === false));
});

test('空文本不上报入队', () => {
  const { queue, interceptor } = make(baseSM());
  interceptor.handleReport({ type: 'capture', text: '   ', session: {} });
  assert.equal(queue.all().length, 0);
});

test('页面报来的工作区优先于 engine 缓存（跨 workspace 录制）', async () => {
  const { interceptor, queue } = make(baseSM());
  interceptor.handleReport({ type: 'capture', text: 'hi', session: { sessionId: 's9', sessionTitle: 't9', workspacePath: 'D:\\Coding\\Bighub' } });
  const item = queue.all().find(i => i.sessionId === 's9');
  assert.equal(item.workspacePath, 'D:\\Coding\\Bighub');
});
