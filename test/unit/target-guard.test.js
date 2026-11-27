'use strict';
/** 目标校验：9222 端口可能被别的 Electron 应用占用，绝不能往别人页面注入 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isZCodeTarget, pickZCodeTarget } = require('../../src/cdp-client');
const { Engine } = require('../../src/engine');

const ZCODE_PAGE = {
  type: 'page',
  title: 'ZCode',
  url: 'file:///C:/Users/x/scoop/apps/zcode/4.0.0/resources/app.asar/out/renderer/index.html?restoreSession=true'
};
const FOREIGN_PAGE = {
  type: 'page',
  title: '驿传 yichuan',
  url: 'file:///C:/dev/yichuan/dist/index.html'
};

test('isZCodeTarget：认得出 ZCode，认不出别的 Electron 应用', () => {
  assert.equal(isZCodeTarget(ZCODE_PAGE), true);
  assert.equal(isZCodeTarget(FOREIGN_PAGE), false);
  assert.equal(isZCodeTarget({ type: 'page', title: 'ZCode Helper', url: 'file:///C:/x/index.html' }), true, '标题含 zcode 也算');
  assert.equal(isZCodeTarget(null), false);
});

test('pickZCodeTarget：混在一起时只挑 ZCode；没有就返回 null（绝不回落）', () => {
  assert.equal(pickZCodeTarget([FOREIGN_PAGE]) && pickZCodeTarget([FOREIGN_PAGE]).title, null, '外来应用 → null');
  assert.equal(pickZCodeTarget([]), null);
  const picked = pickZCodeTarget([FOREIGN_PAGE, ZCODE_PAGE]);
  assert.equal(picked && picked.url, ZCODE_PAGE.url);
});

test('_onConnected：连上后发现不是 ZCode → 不注入、断开、置为未受控', async () => {
  const e = new Engine(fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-tg-')), { smoke: true });
  const calls = { injected: 0, closed: 0, torn: 0 };
  const logs = [];
  e.logger.log = (ev, o) => logs.push([ev, o]);
  e.cdp = {
    connected: true,
    target: FOREIGN_PAGE,
    evaluate: async (expr) => {
      if (/teardown/i.test(String(expr))) { calls.torn++; return 'torn-down'; }
      return { url: FOREIGN_PAGE.url, title: FOREIGN_PAGE.title, hasComposer: false, hasZcode: false };
    },
    enableDomains: async () => {},
    addBinding: async () => {},
    addScriptOnNewDocument: async () => { calls.injected++; },
    close: () => { calls.closed++; },
    send: async () => {}
  };
  await e._onConnected();
  assert.equal(calls.injected, 0, '绝不能注入');
  assert.equal(calls.closed, 1, '必须断开');
  assert.equal(calls.torn, 1, '尝试撤掉已注入的灯条');
  assert.equal(e.stateMachine.connState, 'UNCONTROLLED');
  assert.ok(logs.some(([ev, o]) => ev === 'cdp' && o.action === 'target-rejected'), '要留日志');
  e.logger.close();
});
