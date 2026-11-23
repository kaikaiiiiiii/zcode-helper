'use strict';
/** 工作区守护：侧栏项目收起时先展开，再定位会话 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Player } = require('../../src/player');
const adapter = require('../../src/dom-adapter');

/** 假 CDP：按表达式内容分派，记录调用 */
function cdpStub({ rects = [], expand = null }) {
  const calls = { rect: 0, expand: 0 };
  const queue = rects.slice();
  return {
    calls,
    evaluate: async (expr) => {
      if (expr.includes('data-testid="task-item-')) {
        calls.rect++;
        const r = queue.length > 1 ? queue.shift() : queue[0];
        return r;
      }
      if (expr.includes('expandProject')) {
        calls.expand++;
        return expand;
      }
      return null;
    }
  };
}

function makePlayer(cdp, logs) {
  return new Player({
    cdp,
    supervisor: {},
    stateMachine: {},
    queue: { add: () => ({ added: null }) },
    logger: { log: (ev, f) => logs.push(f) },
    exprs: adapter,
    hooks: { currentWorkspacePath: () => null },
    timing: { startDelayMs: 0, waitConcurrencyMs: 10, blockedMs: 10 }
  });
}

test('会话已在侧栏可见时不展开项目', async () => {
  const logs = [];
  const cdp = cdpStub({ rects: [{ ok: true, x: 1, y: 2, w: 10, h: 10 }] });
  const p = makePlayer(cdp, logs);
  const vis = await p._ensureSessionVisible({ sessionId: 's1', workspaceName: 'Bighub' }, {});
  assert.equal(vis, true);
  assert.equal(cdp.calls.expand, 0);
});

test('项目收起导致会话不可见 → 展开后重新定位', async () => {
  const logs = [];
  const cdp = cdpStub({
    rects: [{ ok: false, why: 'not-found' }, { ok: true, x: 1, y: 2, w: 10, h: 10 }],
    expand: { matched: true, expanded: ['Bighub'], collapsedLeft: 0 }
  });
  const p = makePlayer(cdp, logs);
  const vis = await p._ensureSessionVisible({ sessionId: 's1', workspaceName: 'Bighub' }, {});
  assert.equal(vis, true);
  assert.equal(cdp.calls.expand, 1);
  const rec = logs.find(l => l.action === 'expand-project');
  assert.ok(rec, '记录了 expand-project');
  assert.equal(rec.project, 'Bighub');
});

test('项目名缺失时用 workspacePath 末段展开', async () => {
  const logs = [];
  const cdp = cdpStub({
    rects: [{ ok: false, why: 'not-found' }, { ok: true, x: 1, y: 2, w: 10, h: 10 }],
    expand: { matched: false, fallback: true, expanded: ['x'], collapsedLeft: 0 }
  });
  const p = makePlayer(cdp, logs);
  const vis = await p._ensureSessionVisible({ sessionId: 's1', workspacePath: 'D:\\Coding\\miscJar' }, {});
  assert.equal(vis, true);
  const rec = logs.find(l => l.action === 'expand-project');
  assert.equal(rec.project, 'miscJar');
});

test('展开后仍不可见 → 返回 false 并记录原因', async () => {
  const logs = [];
  const cdp = cdpStub({
    rects: [{ ok: false, why: 'not-found' }],
    expand: { matched: true, expanded: ['Bighub'], collapsedLeft: 0 }
  });
  const p = makePlayer(cdp, logs);
  const vis = await p._ensureSessionVisible({ sessionId: 's1', workspaceName: 'Bighub' }, {});
  assert.equal(vis, false);
  const rec = logs.find(l => l.action === 'session-not-visible');
  assert.ok(rec, '记录了 session-not-visible');
});
