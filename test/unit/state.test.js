'use strict';
/** 滤网模型：暂停助手（入）/ 暂停输出（出）/ 排空条件 / 灯条数据 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../../src/engine');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const make = () => {
  const e = new Engine(fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-engine-')), { smoke: true });
  e.replays = [];
  e.aborted = 0;
  e.player = {
    replay: async (reason) => { e.replays.push(reason); await sleep(10); },
    replayOne: async () => ({ sent: true }),
    screenDraft: async () => ({ ok: true }),
    abort() { e.aborted++; },
    isRunning: false
  };
  e.stateMachine.setConnection('CONNECTED', 'test');
  return e;
};

test('暂停助手：注入模式切 paused，并持久化', () => {
  const e = make();
  assert.equal(e.helperPaused, false);
  e.setHelperPaused(true);
  assert.equal(e.helperPaused, true);
  assert.equal(e.config.get('helperPaused'), true);
  assert.equal(e._injectedMode(), 'paused');
  e.setHelperPaused(false);
  assert.equal(e._injectedMode(), 'recording');
  e.logger.close();
});

test('暂停输出：不排空；恢复后立即排空', async () => {
  const e = make();
  e.modelState = 'GLM-5.3-Flash';
  e.setOutputPaused(true);                 // 先暂停，再入队
  e.queue.add({ sessionId: 's1', source: 'intercept', text: 'A' });
  await sleep(40);
  assert.equal(e.replays.length, 0, '暂停期间不排空');
  e.setOutputPaused(false);
  await sleep(60);
  assert.deepEqual(e.replays, ['auto'], '恢复后立即排空一次');
  e.logger.close();
});

test('排空条件：模型可用 + 有 pending', async () => {
  const e = make();
  e.modelState = 'GLM-5.3-Flash';
  e.queue.add({ sessionId: 's1', source: 'intercept', text: 'A' });
  e._drainTick();
  await sleep(40);
  assert.deepEqual(e.replays, ['auto']);
  e._drainTick(); // 已在跑/已跑完，再 tick 一次不应重复叠加
  await sleep(40);
  assert.ok(e.replays.length >= 1);
  e.logger.close();
});

test('模型不可用时冷却排空；冷却到期后允许重试', async () => {
  const e = make();
  e._holdModel('test');            // 先进入冷却，再加入队列（add 会触发一次 _drainTick）
  assert.equal(e.modelState, 'None');
  e.queue.add({ sessionId: 's1', source: 'intercept', text: 'A' });
  assert.ok(e._modelHoldUntil > Date.now(), '进入冷却');
  e._drainTick();
  await sleep(40);
  assert.equal(e.replays.length, 0, '冷却中不排空');
  e._modelHoldUntil = 0;           // 冷却到期
  e.modelState = 'glm-5.3-flash';
  e._drainTick();
  await sleep(40);
  assert.equal(e.replays.length, 1, '到期后重试');
  e.logger.close();
});

test('草稿不参与排空', async () => {
  const e = make();
  e.modelState = 'GLM-5.3-Flash';
  e.queue.add({ sessionId: 's1', source: 'draft', type: 'draft', text: 'D' });
  e._drainTick();
  await sleep(40);
  assert.equal(e.replays.length, 0, '只有草稿时没有可排空条目');
  e.logger.close();
});

test('手动提交不受暂停限制，且不改暂停状态', async () => {
  const e = make();
  const a = e.queue.add({ sessionId: 's1', source: 'intercept', text: 'A' }).added;
  e.setHelperPaused(true);
  e.setOutputPaused(true);
  const r = await e.submitQueueItem(a.id);
  assert.equal(r.ok, true);
  assert.equal(e.helperPaused, true, '暂停助手状态保持');
  assert.equal(e.outputPaused, true, '暂停输出状态保持');
  e.logger.close();
});

test('草稿上屏：成功后从队列移除', async () => {
  const e = make();
  const d = e.queue.add({ sessionId: 's1', source: 'draft', type: 'draft', text: '草稿' }).added;
  const r = await e.screenDraftItem(d.id);
  assert.equal(r.ok, true);
  assert.equal(e.queue.get(d.id), null);
  e.logger.close();
});

test('失败项可手动提交；草稿不能走提交', async () => {
  const e = make();
  const a = e.queue.add({ sessionId: 's1', source: 'intercept', text: 'A' }).added;
  e.queue.setStatus(a.id, 'failed', { error: 'model-unavailable' });
  assert.equal((await e.submitQueueItem(a.id)).ok, true);
  assert.equal(e.queue.get(a.id).error, null);
  const d = e.queue.add({ sessionId: 's1', source: 'draft', type: 'draft', text: 'D' }).added;
  const r = await e.submitQueueItem(d.id);
  assert.equal(r.ok, false);
  assert.equal(r.why, 'is-draft');
  e.logger.close();
});

test('灯条：状态与等待原因（模型 / 名额 / 暂停）', () => {
  const e = make();
  e.modelState = 'None';
  assert.equal(e._lightBarPayload().state, 'ok', '无积压时绿灯');
  e.queue.add({ sessionId: 's1', source: 'intercept', text: 'A' });
  assert.equal(e._lightBarPayload().state, 'wait', '有积压且模型不可用 → 黄灯');
  assert.equal(e._lightBarPayload().waitReason, 'model');
  e.modelState = 'GLM-5.3-Flash';
  e._workingCount = 2;
  assert.equal(e._lightBarPayload().state, 'wait', '名额满 → 黄灯');
  assert.equal(e._lightBarPayload().waitReason, 'quota');
  e._workingCount = 1;
  assert.equal(e._lightBarPayload().state, 'ok');
  assert.equal(e._lightBarPayload().waitReason, null);
  e.setOutputPaused(true);
  assert.equal(e._lightBarPayload().state, 'output-paused', '输出暂停 → 红灯');
  assert.equal(e._lightBarPayload().waitReason, null);
  e.setOutputPaused(false);
  e.setHelperPaused(true);
  assert.equal(e._lightBarPayload().state, 'helper-paused', '助手暂停 → 灰灯');
  e.logger.close();
});

test('noteEvent 更新灯条最近事件', () => {
  const e = make();
  e.noteEvent('已入队「继续」');
  assert.match(e.state().lastEvent, /已入队「继续」/);
  assert.match(e._lightBarPayload().last, /已入队「继续」/);
  e.logger.close();
});

test('防打扰：系统空闲不足 N 秒视为"用户在用"，闸门关上', () => {
  const e = new Engine(fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-engine-')), { smoke: true, systemIdleSeconds: () => 2 });
  e.config.set({ idleGuardSeconds: 5 });
  assert.equal(e._userActive(), true, '空闲 2s < 5s → 用户在用');
  assert.equal(e.config.set({ idleGuardSeconds: 1 }).idleGuardSeconds, 1);
  assert.equal(e._userActive(), false, '空闲 2s ≥ 1s → 可以自动操作');
  e.config.set({ idleGuardSeconds: 0 });
  assert.equal(e._userActive(), false, '0 = 关闭闸门');
  e.logger.close();
});

test('红点 → 队列最前插入「继续」，同 session 不重复', () => {
  const e = make();
  e.config.set({ idleGuardSeconds: 0 });
  const states = [{ sid: 's1', dot: 'error', working: false, key: 'D:\\Coding\\proj:s1' }];
  e._autoContinueFromDots(states);
  assert.equal(e.queue.pendingSubmits().length, 1);
  assert.equal(e.queue.pendingSubmits()[0].text, '继续');
  assert.equal(e.queue.pendingSubmits()[0].sessionId, 's1');
  assert.equal(e.queue.pendingSubmits()[0].workspaceName, 'proj');
  e._autoContinueFromDots(states); // 红点还在 → 不再插
  assert.equal(e.queue.pendingSubmits().length, 1);
  const first = e.queue.pendingSubmits()[0];
  e.queue.setStatus(first.id, 'sent');          // 第一条已发出
  e._autoContinueFromDots(states);              // 红点仍在 → 不重复
  assert.equal(e.queue.pendingSubmits().length, 0, '红点未消失前不重复插');
  e._autoContinueFromDots([{ sid: 's1', dot: 'unread' }]); // 红点消失 → 复位
  e._autoContinueFromDots(states);
  assert.equal(e.queue.pendingSubmits().length, 1, '红点消失后再出现 → 允许再插一条');
  e.logger.close();
});

test('红点触发的「继续」插到队列最前（优先于普通待发）', () => {
  const e = make();
  e.config.set({ idleGuardSeconds: 0 });
  e.queue.add({ sessionId: 's2', source: 'intercept', text: '普通消息' });
  e._autoContinueFromDots([{ sid: 's1', dot: 'error' }]);
  const list = e.queue.pendingSubmits();
  assert.equal(list[0].text, '继续');
  assert.equal(list[1].text, '普通消息');
  e.logger.close();
});

test('刷新列表节奏：modelRefreshSeconds（0 = 关闭）', () => {
  const e = make();
  e.config.set({ modelRefreshSeconds: 60 });
  e._modelRefreshAt = Date.now() - 30 * 1000;
  assert.equal(e._refreshDue(), false, '30s < 60s 不刷新');
  e._modelRefreshAt = Date.now() - 61 * 1000;
  assert.equal(e._refreshDue(), true, '61s ≥ 60s 该刷新');
  e.config.set({ modelRefreshSeconds: 0 });
  e._modelRefreshAt = 0;
  assert.equal(e._refreshDue(), false, '0 = 关闭');
  e.logger.close();
});


test('白名单匹配：按顺序、完整相等（区分大小写）、跳过禁用项', () => {
  const e = make();
  e.config.set({ fixedModelId: 'glm-5.3-flash,GLM-5.3-Flash' });
  const items = [
    { testid: 'chat-model-select-item-custom:p:GLM-5.3', text: 'GLM-5.3', disabled: false },
    { testid: 'chat-model-select-item-custom:p:GLM-5.3-Flash', text: 'GLM-5.3-Flash 视觉', disabled: false },
    { testid: 'chat-model-select-item-custom:p:glm-5.3-flash', text: 'glm-5.3-flash 视觉', disabled: false },
    { testid: 'chat-model-select-item-custom:p:deepseek-v4-pro', text: 'deepseek-v4-pro', disabled: false }
  ];
  const pick = e._matchWhitelist(items);
  assert.equal(pick && pick.name, 'glm-5.3-flash', '白名单第一项优先，且大小写敏感');
  e.config.set({ fixedModelId: 'GLM-5.3-Flash,glm-5.3-flash' });
  assert.equal(e._matchWhitelist(items).name, 'GLM-5.3-Flash', '换顺序就选另一个大小写');
  e.config.set({ fixedModelId: 'kimi-k3' });
  assert.equal(e._matchWhitelist(items), null, '白名单里没有 → null');
  const disabled = items.map(i => ({ ...i, disabled: i.testid.endsWith('glm-5.3-flash') }));
  e.config.set({ fixedModelId: 'glm-5.3-flash' });
  assert.equal(e._matchWhitelist(disabled), null, '禁用项不算');
  e.logger.close();
});



test('模型可用性检测：半角逗号分隔，空值回退默认', () => {
  const e = make();
  assert.deepEqual(e._modelCandidates(), ['GLM-5.3-Flash'], '默认单模型');
  e.config.set({ fixedModelId: 'GLM-5.3-Flash, GLM-4.6 ,, Qwen3' });
  assert.deepEqual(e._modelCandidates(), ['GLM-5.3-Flash', 'GLM-4.6', 'Qwen3'], '去空白、忽略空项');
  e.config.set({ fixedModelId: '   ' });
  assert.deepEqual(e._modelCandidates(), ['GLM-5.3-Flash'], '全空 → 默认');
  e.logger.close();
});

test('全局匹配按白名单顺序（与供应商顺序无关）', () => {
  const e = make();
  e.config.set({ fixedModelId: 'glm-5.3-flash,GLM-5.3-Flash' });
  const entries = [
    { provider: 'Zhupu', providerTid: 'p:zhupu', name: 'GLM-5.3-Flash', text: 'GLM-5.3-Flash 视觉', disabled: false },
    { provider: 'OpenCode', providerTid: 'p:oc', name: 'glm-5.3-flash', text: 'glm-5.3-flash 视觉', disabled: false }
  ];
  const hit = e._matchWhitelistGlobal(entries);
  assert.equal(hit.name, 'glm-5.3-flash', '白名单第一项优先');
  assert.equal(hit.provider, 'OpenCode', '命中项带着供应商');
  e.config.set({ fixedModelId: 'GLM-5.3-Flash' });
  assert.equal(e._matchWhitelistGlobal(entries).provider, 'Zhupu', '换白名单顺序就选 Zhupu');
  e.config.set({ fixedModelId: 'kimi-k3' });
  assert.equal(e._matchWhitelistGlobal(entries), null, '没有命中 → null');
  e.logger.close();
});

test('最佳模型缓存：命中不扫描；供应商/模型消失才算失效', async () => {
  const e = make();
  const adapter = require('../../src/dom-adapter');
  const clicks = [];
  let provider = 'OpenCode Go (Chat) API';
  let models = [{ testid: 'chat-model-select-item-custom:oc:glm-5.3-flash', text: 'glm-5.3-flash 视觉', checked: 'true' }];
  let providers = [{ tid: 'p:oc', text: 'OpenCode Go (Chat) API', checked: 'true', x: 1, y: 2 }];
  e.cdp = {
    evaluate: async (expr) => {
      if (expr === adapter.modelProviderCurrentSrc) return provider;
      if (expr === adapter.modelListSrc) return models;
      if (expr === adapter.modelProviderListSrc) return providers;
      if (expr === adapter.modelPanelProviderSrc) return { ok: true, x: 1, y: 2 };
      return null;
    },
    dispatchClick: async () => { clicks.push(1); },
    send: async () => {}
  };
  const best = { provider: 'OpenCode Go (Chat) API', providerTid: 'p:oc', model: 'glm-5.3-flash' };
  const hit = await e._tryCachedModel(best);
  assert.equal(hit && hit.testid, models[0].testid, '命中缓存');
  assert.equal(clicks.length, 0, '供应商已是当前 → 不额外点击');
  models = [{ testid: 'chat-model-select-item-custom:oc:kimi-k3', text: 'kimi-k3 视觉', checked: 'true' }];
  assert.equal(await e._tryCachedModel(best), null, '模型不在了 → 失效');
  provider = 'DeepSeek API';
  providers = [{ tid: 'p:ds', text: 'DeepSeek API', checked: 'true', x: 1, y: 2 }];
  assert.equal(await e._tryCachedModel(best), null, '供应商不在了 → 失效');
  e.logger.close();
});

test('最佳模型缓存：写入/读取/清空', () => {
  const e = make();
  assert.equal(e.config.get('modelBestMatch'), null);
  e.config.set({ modelBestMatch: { provider: 'OpenCode Go (Chat) API', providerTid: 'p:oc', model: 'glm-5.3-flash' } });
  const got = e.config.get('modelBestMatch');
  assert.equal(got.provider, 'OpenCode Go (Chat) API');
  assert.equal(got.model, 'glm-5.3-flash');
  e.config.set({ modelBestMatch: null });
  assert.equal(e.config.get('modelBestMatch'), null);
  e.logger.close();
});

test('扫描所有供应商：收集全量清单并按白名单顺序全局匹配', async () => {
  const e = make();
  const adapter = require('../../src/dom-adapter');
  e.config.set({ fixedModelId: 'glm-5.3-flash,deepseek-v4-pro' });
  let provider = 'OpenCode Go (Chat) API';
  const lists = {
    'OpenCode Go (Chat) API': [
      { testid: 'chat-model-select-item-custom:opencode-go-chat:glm-5.3-flash', text: 'glm-5.3-flash 视觉', checked: 'true' },
      { testid: 'chat-model-select-item-custom:opencode-go-chat:kimi-k3', text: 'kimi-k3 视觉', checked: 'false' }
    ],
    'DeepSeek API': [
      { testid: 'chat-model-select-item-custom:deepseek:deepseek-flash', text: 'deepseek-flash 视觉', checked: 'true' },
      { testid: 'chat-model-select-item-custom:deepseek:deepseek-v4-pro', text: 'deepseek-v4-pro', checked: 'false' }
    ]
  };
  const providers = [
    { tid: 'p:oc', text: 'OpenCode Go (Chat) API', checked: 'true', x: 1, y: 1 },
    { tid: 'p:ds', text: 'DeepSeek API', checked: 'false', x: 2, y: 2 }
  ];
  e.cdp = {
    evaluate: async (expr) => {
      if (expr === adapter.modelProviderCurrentSrc) return provider;
      if (expr === adapter.modelListSrc) return lists[provider].map(m => ({ ...m }));
      if (expr === adapter.modelProviderListSrc) return providers.map(p => ({ ...p, checked: p.text === provider ? 'true' : 'false' }));
      if (expr === adapter.modelPanelProviderSrc) return { ok: true, x: 1, y: 1 };
      return null;
    },
    send: async () => {},
    dispatchClick: async (x, y) => {
      const p = providers.find(p => p.x === x && p.y === y);
      if (p) provider = p.text;
    }
  };
  const scan = await e._scanAllProviders();
  assert.equal(scan.originalProvider, 'OpenCode Go (Chat) API');
  assert.equal(scan.originalModel, 'glm-5.3-flash');
  assert.equal(scan.entries.length, 4, '两个供应商共 4 个模型');
  const hit = e._matchWhitelistGlobal(scan.entries);
  assert.equal(hit.provider, 'OpenCode Go (Chat) API', '白名单第一项命中当前供应商');
  assert.equal(hit.name, 'glm-5.3-flash');
  e.config.set({ fixedModelId: 'deepseek-v4-pro,glm-5.3-flash' });
  const hit2 = e._matchWhitelistGlobal(scan.entries);
  assert.equal(hit2.provider, 'DeepSeek API', '换白名单顺序 → 命中另一个供应商');
  e.logger.close();
});
