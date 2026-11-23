'use strict';
/** 回放时输入框已有内容怎么处理（ZCode 自己按会话保留草稿，helper 不能覆盖） */
const test = require('node:test');
const assert = require('node:assert/strict');
const { decideComposerAction } = require('../../src/player');

test('空输入框 -> clear', () => {
  assert.equal(decideComposerAction('', 'hello'), 'clear');
  assert.equal(decideComposerAction('   \n', 'hello'), 'clear');
  assert.equal(decideComposerAction(null, 'hello'), 'clear');
  assert.equal(decideComposerAction(undefined, 'hello'), 'clear');
});

test('输入框内容就是本条消息 -> submit-existing（不重复输入）', () => {
  assert.equal(decideComposerAction('hello', 'hello'), 'submit-existing');
  assert.equal(decideComposerAction('  hello \n', 'hello'), 'submit-existing');
});

test('输入框里有别的草稿 -> move-draft（存进队列后继续提交）', () => {
  assert.equal(decideComposerAction('我的草稿', 'hello'), 'move-draft');
  assert.equal(decideComposerAction('hello world', 'hello'), 'move-draft');
  assert.equal(decideComposerAction('hello', ''), 'move-draft');
});
