'use strict';
/** 回放调度：FIFO + 同会话跳过（插队）+ working<2 上限 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Player } = require('../../src/player');
const adapter = require('../../src/dom-adapter');

const mk = (id, sid) => ({ id, sessionId: sid, text: id, status: 'pending', source: 'intercept', workspacePath: null, sessionTitle: null });

function harness(items) {
  const sent = [];
  const working = new Set();
  const logs = [];
  const queue = {
    pendingItems: () => items.filter(i => i.status === 'pending'),
    pendingSubmits: () => items.filter(i => i.status === 'pending' && i.type !== 'draft'),
    draftItems: () => items.filter(i => i.type === 'draft' && i.status === 'pending'),
    setStatus: (id, st) => { const it = items.find(i => i.id === id); if (it) it.status = st; return true; },
    add: () => ({ added: null }),
    all: () => items,
    counts: () => ({ pending: queue.pendingItems().length, sent: 0, failed: 0 })
  };
  const player = new Player({
    cdp: {}, supervisor: {}, stateMachine: {},
    queue,
    logger: { log: (ev, f) => logs.push((f && f.action) || '') },
    exprs: adapter, hooks: {},
    timing: { startDelayMs: 0, waitConcurrencyMs: 20, blockedMs: 20 }
  });
  player._workingSessions = async () => new Set(working);
  player._replayOne = async (item) => {
    sent.push(item.id);
    item.status = 'sent';
    working.add(item.sessionId);
    return { sent: true, fatal: false };
  };
  return { player, sent, working, logs };
}

test('同会话串行 + 其它会话插队', async () => {
  const items = [mk('a1', 'A'), mk('a2', 'A'), mk('b1', 'B'), mk('b2', 'B')];
  const { player, sent, working } = harness(items);
  setTimeout(() => working.delete('A'), 40);
  setTimeout(() => working.delete('B'), 90);
  await player.replay('test');
  assert.deepEqual(sent, ['a1', 'b1', 'a2', 'b2']);
});

test('working 达到 2 个时等待，降下来再继续', async () => {
  const items = [mk('a1', 'A'), mk('b1', 'B'), mk('c1', 'C')];
  const { player, sent, working, logs } = harness(items);
  // A、B 先完成，之后才轮到 C
  setTimeout(() => working.delete('A'), 40);
  setTimeout(() => working.delete('B'), 60);
  await player.replay('test');
  assert.deepEqual(sent, ['a1', 'b1', 'c1']);
  assert.ok(logs.includes('wait-concurrency'), '出现了并发等待');
});

test('fatal 失败（模型不可用）中止整轮', async () => {
  const items = [mk('a1', 'A'), mk('a2', 'A'), mk('b1', 'B')];
  const { player, logs } = harness(items);
  let calls = 0;
  player._replayOne = async (item) => { calls++; item.status = 'failed'; return { sent: false, fatal: true }; };
  await player.replay('test');
  assert.equal(calls, 1, '第一条 fatal 后不再继续');
  assert.ok(logs.includes('batch-abort'));
});

test('目标会话找不到时中止本条（绝不发进当前会话）', async () => {
  const logs = [];
  const item = { id: 'q1', sessionId: 'sess_x', sessionTitle: '目标会话', text: 'hello', status: 'pending', type: 'submit', workspacePath: null, source: 'intercept' };
  const queue = {
    pendingItems: () => [item], pendingSubmits: () => [item], draftItems: () => [],
    get: id => (id === item.id ? item : null),
    setStatus: (id, st, extra) => { item.status = st; if (extra && extra.error) item.error = extra.error; return true; },
    add: () => ({ added: null }), all: () => [item], counts: () => ({ pending: 1, sent: 0, failed: 0, draft: 0 })
  };
  let inserted = 0, clicked = 0;
  const cdp = {
    evaluate: async (expr) => {
      if (expr.includes('function (sessionId, title)')) return { ok: false, dbg: { candCount: 0 } };
      if (expr.includes('debugDom')) return { title: 'x', count: 0, nodes: [] };
      if (expr.includes('task-item')) return { ok: false };
      return null;
    },
    dispatchClick: async () => { clicked++; },
    insertText: async () => { inserted++; },
    dispatchEnter: async () => {},
    selectAllInFocused: async () => {}, pressBackspace: async () => {}
  };
  const player = new Player({
    cdp, supervisor: {}, stateMachine: {},
    queue, logger: { log: (ev, f) => logs.push((f && f.action) || '') },
    exprs: adapter, hooks: {}, timing: {}
  });
  const r = await player._replayOne(item, 'test');
  assert.equal(r.sent, false);
  assert.equal(item.status, 'failed');
  assert.match(String(item.error), /session-not-found/);
  assert.equal(inserted, 0, '没有往任何输入框注入文字');
  assert.equal(clicked, 0, '没有点击任何会话项');
});

test('条目没记 workspace 时不切工作区（纯 DOM，不做元数据补全）', async () => {
  const calls = [];
  const item = { id: 'q2', sessionId: 'sess_x', sessionTitle: '目标', text: 'hi', status: 'pending', type: 'submit', workspacePath: null };
  const queue = { pendingItems: () => [item], pendingSubmits: () => [item], draftItems: () => [], get: () => item, setStatus: () => true, add: () => ({ added: null }), all: () => [item], counts: () => ({}) };
  const player = new Player({
    cdp: {}, stateMachine: {}, queue,
    supervisor: { openWorkspace: (exe, p2) => calls.push(['open', p2]) },
    logger: { log: () => {} }, exprs: adapter,
    hooks: {
      currentWorkspacePath: () => 'D:\\Coding\\zcode-helper',
      zcodeExePath: () => 'zcode.exe',
      onWorkspaceChange: p2 => calls.push(['change', p2])
    },
    timing: { workspaceOpenMs: 0, workspaceSettleMs: 0 }
  });
  await player._prepareWorkspace(item, {});
  assert.deepEqual(calls, [], '没有 workspacePath → 不切工作区');
});

test('侧边栏收起时先展开（再继续侧栏相关逻辑）', async () => {
  let expanded = false;
  const clicks = [];
  const player = new Player({
    cdp: {
      evaluate: async expr => {
        if (String(expr).includes('desktop-top-logo-sidebar-toggle')) {
          return { expanded, asideW: expanded ? 400 : 6, listW: expanded ? 300 : 0, toggle: { x: 27, y: 31 } };
        }
        return null;
      },
      dispatchClick: async (x, y) => { clicks.push([x, y]); expanded = true; }
    },
    stateMachine: {}, queue: { counts: () => ({}) }, supervisor: {},
    logger: { log: () => {} }, exprs: adapter, hooks: {}, timing: {}
  });
  const ok = await player._ensureSidebar({});
  assert.equal(ok, true, '展开成功');
  assert.deepEqual(clicks, [[27, 31]], '点了一次切换按钮');
  // 已展开时不再点
  const ok2 = await player._ensureSidebar({});
  assert.equal(ok2, true);
  assert.equal(clicks.length, 1, '已展开不重复点击');
});
