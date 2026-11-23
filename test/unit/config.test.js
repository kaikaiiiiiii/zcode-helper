'use strict';
/** 配置层：默认值、校验、持久化 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Config } = require('../../src/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-cfg-'));

test('默认值：端口、固定模型、并发上限、两个暂停开关', () => {
  const c = new Config(tmp());
  assert.equal(c.get('cdpPort'), 9222);
  assert.equal(c.get('fixedModelId'), 'GLM-5.3-Flash');
  assert.equal(c.get('maxWorkingSessions'), 2);
  assert.equal(c.get('helperPaused'), false);
  assert.equal(c.get('outputPaused'), false);
  assert.equal(c.get('showOutputSwitch'), true);
});

test('数值区间钳制', () => {
  const c = new Config(tmp());
  assert.equal(c.set({ probeIntervalMs: 10 }).probeIntervalMs, 1000);
  assert.equal(c.set({ probeIntervalMs: 999999 }).probeIntervalMs, 60000);
});

test('并发上限钳制在 1~20', () => {
  const c = new Config(tmp());
  assert.equal(c.set({ maxWorkingSessions: 0 }).maxWorkingSessions, 1);
  assert.equal(c.set({ maxWorkingSessions: 99 }).maxWorkingSessions, 20);
  assert.equal(c.set({ maxWorkingSessions: 3 }).maxWorkingSessions, 3);
});

test('未知键被忽略', () => {
  const c = new Config(tmp());
  c.set({ notAKey: 1 });
  assert.equal('notAKey' in c.get(), false);
});

test('落盘后可重新读回', () => {
  const dir = tmp();
  new Config(dir).set({ helperPaused: true, cdpPort: 9333 });
  const again = new Config(dir);
  assert.equal(again.get('helperPaused'), true);
  assert.equal(again.get('cdpPort'), 9333);
});

test('文件损坏时回退默认值', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken json');
  const c = new Config(dir);
  assert.equal(c.get('cdpPort'), 9222);
});

test('防打扰秒数：默认 5，钳制 0~60', () => {
  const c = new Config(tmp());
  assert.equal(c.get('idleGuardSeconds'), 5);
  assert.equal(c.set({ idleGuardSeconds: -1 }).idleGuardSeconds, 0);
  assert.equal(c.set({ idleGuardSeconds: 999 }).idleGuardSeconds, 60);
  assert.equal(c.set({ idleGuardSeconds: 12 }).idleGuardSeconds, 12);
});

test('自动探测 ZCode.exe：候选列表有序，找不到返回空串', () => {
  const { candidates, detectZCodePath } = require('../../src/zcode-path');
  const list = candidates();
  assert.ok(Array.isArray(list));
  if (process.platform === 'win32') {
    assert.ok(list.length >= 3, '至少包含 LocalAppData / Program Files / Scoop 三类候选');
    assert.ok(list.every(p => /\.exe$/i.test(p)), '候选都是 .exe');
  }
  const found = detectZCodePath();
  assert.equal(typeof found, 'string');
  if (found) assert.ok(fs.existsSync(found), '返回的路径必须真实存在');
});
