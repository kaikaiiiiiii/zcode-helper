'use strict';
/** 套餐探针：解析 billing/balance、挑 key、失败静默 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { probePlan, parseBalance, findApiKey, findDeviceMid } = require('../../src/plan-probe');

const NOW = 1795786423 * 1000; // 2026-11-27 21:33:43 +08:00

const balance = (effectiveAt) => ({
  code: 0,
  msg: '',
  data: {
    server_time: 1795786423,
    plans: [{
      user_plan_id: 'upl_1',
      plan_id: 'zcode-v3-start-plan-1127',
      name: 'ZCODE WEEKEND BUILD',
      status: 'active',
      starts_at: 1795782284,
      ends_at: 1796000400,
      entitlements: [{
        entitlement_id: 'ent-1',
        show_name: 'GLM-5.3-Flash',
        meter: 'model_usage',
        grant_units: 300000000,
        effective_at: effectiveAt
      }]
    }],
    balances: []
  }
});

test('parseBalance：权益未到生效时间 → 不可用但带生效时间', () => {
  const r = parseBalance(balance(1795791600), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.active, true);
  assert.equal(r.available, false);
  assert.equal(r.name, 'ZCODE WEEKEND BUILD');
  assert.equal(r.effectiveAt, 1795791600);
  assert.equal(r.endsAt, 1796000400);
  assert.deepEqual(r.models, ['GLM-5.3-Flash']);
});

test('parseBalance：权益已生效 → 可用', () => {
  const r = parseBalance(balance(1795780000), NOW);
  assert.equal(r.available, true);
});

test('parseBalance：已过期 → 不可用', () => {
  const r = parseBalance(balance(1795780000), (1796000400 + 60) * 1000);
  assert.equal(r.available, false);
  assert.equal(r.active, true, '订阅状态仍是 active，但时间已过');
});

test('parseBalance：没有套餐 → active=false 且不报错', () => {
  const r = parseBalance({ code: 0, data: { plans: [] } }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.active, false);
  assert.equal(r.available, false);
  assert.equal(r.name, null);
});

test('parseBalance：形状不对 → ok:false（调用方静默降级）', () => {
  assert.equal(parseBalance({ code: 0 }, NOW).ok, false);
  assert.equal(parseBalance(null, NOW).ok, false);
});

test('findApiKey：优先 start-plan/coding-plan 的明文 key，跳过 enc: 加密项', () => {
  const cfg = {
    provider: {
      'builtin:bigmodel': { options: { apiKey: 'short' } },
      'builtin:bigmodel-coding-plan': { options: { apiKey: 'enc:v2:os:xxx' } },
      'builtin:bigmodel-start-plan': { options: { apiKey: 'eyJhbGciOi.payload.signature' } }
    }
  };
  assert.equal(findApiKey(cfg), 'eyJhbGciOi.payload.signature');
  assert.equal(findApiKey({ provider: {} }), null);
  assert.equal(findApiKey(null), null);
});

test('findApiKey：JWT 优先于 32 字节普通 key（普通 key 调 billing 会 401）', () => {
  const cfg = {
    provider: {
      'builtin:bigmodel-coding-plan': { enabled: true, options: { apiKey: '0a415dc3187b4c0e9f1d2a3b4c5d6e7f' } },
      'builtin:bigmodel-start-plan': { enabled: true, options: { apiKey: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' } }
    }
  };
  assert.equal(findApiKey(cfg), 'eyJhbGciOiJIUzI1NiJ9.payload.sig');
});

test('findDeviceMid：读 telemetry-state.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-plan-'));
  fs.writeFileSync(path.join(dir, 'telemetry-state.json'), JSON.stringify({ deviceMid: 'mid-123' }));
  assert.equal(findDeviceMid(dir), 'mid-123');
  assert.equal(findDeviceMid(fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-plan-'))), null);
});

test('probePlan：正常响应 → 解析成功（带 deviceMid 头）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-plan-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    provider: { 'builtin:bigmodel-start-plan': { options: { apiKey: 'eyJhbGciOi.payload.signature' } } }
  }));
  fs.writeFileSync(path.join(dir, 'telemetry-state.json'), JSON.stringify({ deviceMid: 'mid-123' }));
  let seen = null;
  const fakeFetch = async (url, opts) => {
    seen = { url, headers: opts.headers };
    return { ok: true, status: 200, json: async () => balance(1795791600) };
  };
  const r = await probePlan({ dir, fetchImpl: fakeFetch, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.available, false);
  assert.equal(r.effectiveAt, 1795791600);
  assert.match(seen.url, /billing\/balance\?app_version=/);
  assert.equal(seen.headers['X-Device-Mid'], 'mid-123');
  assert.match(seen.headers.Authorization, /^Bearer eyJ/);
});

test('probePlan：HTTP 失败 / 没配置 / 异常 → 一律 ok:false（静默）', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-plan-'));
  assert.equal((await probePlan({ dir: empty, fetchImpl: async () => ({ ok: false, status: 401 }) })).ok, false);

  const noKey = fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-plan-'));
  fs.writeFileSync(path.join(noKey, 'config.json'), JSON.stringify({ provider: {} }));
  assert.equal((await probePlan({ dir: noKey, fetchImpl: async () => ({ ok: true, status: 200, json: async () => balance(1) }) })).ok, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-plan-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    provider: { 'builtin:bigmodel-start-plan': { options: { apiKey: 'eyJhbGciOi.payload.signature' } } }
  }));
  const r = await probePlan({ dir, fetchImpl: async () => { throw new Error('boom'); }, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error');
});
