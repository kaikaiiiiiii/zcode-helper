'use strict';
/** dom-adapter：表达式可用性、占位符替换、关键选择器回归（ZCode 升级的第一道防线） */
const test = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../../src/dom-adapter');
const pkg = require('../../package.json');

const EXPR_KEYS = [
  'snapshotSrc', 'ensureBootstrapSrc', 'composerRectSrc', 'composerFocusSrc',
  'clearComposerSrc', 'sessionStatesSrc', 'chatLoadingSrc', 'debugDomSrc',
  'errorProbeSrc'
];
const FN_KEYS = ['setModeSrc', 'setLightBarSrc', 'beginInjectSrc', 'locateSessionSrc', 'probeModelSrc', 'sessionItemRectSrc'];

test('注入版本与 package.json 一致', () => {
  assert.equal(adapter.helperVersion, pkg.version, 'helperVersion 必须与 package.json 同步');
});

test('所有表达式非空且可解析', () => {
  for (const k of EXPR_KEYS) {
    const src = adapter[k];
    assert.equal(typeof src, 'string', `${k} 应为字符串`);
    assert.ok(src.length > 20, `${k} 不应为空`);
    assert.doesNotThrow(() => new Function('return (' + src + ')'), `${k} 必须能被解析`);
  }
});

test('参数化表达式：替换后参数不加引号、可解析', () => {
  const sid = 'sess_ABC-123';
  const title = '标题 with "quotes"';
  const locate = adapter.locateSessionSrc
    .replace('__SESSION_ID__', JSON.stringify(sid))
    .replace('__SESSION_TITLE__', JSON.stringify(title));
  assert.ok(!locate.includes("'__SESSION_ID__'"), '占位符必须被替换');
  assert.ok(locate.includes(`})(${JSON.stringify(sid)}, ${JSON.stringify(title)})`),
    '替换后的参数必须是裸 JSON 字面量（历史 bug：被塞进单引号里导致永远匹配不到）');
  assert.doesNotThrow(() => new Function('return (' + locate + ')'));

  const rect = adapter.sessionItemRectSrc.replace('__SID__', JSON.stringify(sid));
  assert.ok(rect.endsWith(`})(${JSON.stringify(sid)})`), 'sid 占位符替换正确');
  assert.doesNotThrow(() => new Function('return (' + rect + ')'));
});

test('函数式表达式生成合法 JS', () => {
  assert.doesNotThrow(() => new Function('return (' + adapter.setModeSrc('recording') + ')'));
  assert.doesNotThrow(() => new Function('return (' + adapter.setLightBarSrc({ conn: 'on', working: 2, limit: 2, pending: 3, model: 'GLM-5.3-Flash' }) + ')'));
  assert.doesNotThrow(() => new Function('return (' + adapter.probeModelSrc('GLM-5.3-Flash') + ')'));
});

test('关键选择器回归（ZCode 升级后这些变了就要改适配层）', () => {
  const bs = adapter.bootstrapSource();
  // 模型选择触发器：最强的模型可用性判据
  assert.match(bs, /chat-model-select-trigger/);
  assert.match(bs, /data-model-current-value/);
  // / 指令弹层：回车必须放行
  assert.match(bs, /prompt-suggestion-option-/);
  assert.match(bs, /enter-passthrough/);
  // composer：contenteditable + composer 容器
  assert.match(bs, /contenteditable/);
  // 发送按钮
  assert.match(bs, /v4-composer-send/);
  // 会话状态位 / chat-loading（helper 侧表达式）
  assert.match(adapter.sessionStatesSrc, /task-item-/);
  assert.match(adapter.sessionStatesSrc, /animate-spin/);
  assert.match(adapter.sessionStatesSrc, /data-unread-indicator/);
  assert.match(adapter.sessionStatesSrc, /data-error-indicator/);
  assert.match(adapter.chatLoadingSrc, /chat-loading/);
  assert.match(adapter.chatLoadingSrc, /tabular-nums/);
});
