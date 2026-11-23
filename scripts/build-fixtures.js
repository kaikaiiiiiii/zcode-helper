'use strict';
/**
 * build-fixtures.js — 从 logs/dom 里采集到的真实 DOM 快照生成测试夹具
 *
 * 用法：node scripts/build-fixtures.js
 * 产物：test/fixtures/*.html
 *
 * 为什么需要：helper 的很多功能依赖 ZCode 的界面元素（composer、会话列表状态位、
 * 指令弹层、chat-loading）。ZCode 升级会让这些结构漂移，测试夹具是"升级后立刻发现问题"的防线。
 * 采集方法：ZCode 带 CDP 端口启动后跑 scripts/dump-composer-dom.js / capture-session-status.js，
 * 把 logs/dom/*.json 拿回来，再跑本脚本重新生成夹具（旧夹具可先删掉）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOM_DIR = path.join(ROOT, 'logs', 'dom');
const OUT_DIR = path.join(ROOT, 'test', 'fixtures');

const BASE_CSS = `
  html, body { margin: 0; padding: 0; width: 1200px; font: 14px/1.4 -apple-system, "Segoe UI", sans-serif; }
  [contenteditable="true"], [contenteditable=""], textarea { display: block; min-height: 64px; width: 640px; border: 1px solid #ccc; padding: 6px; }
  button { display: inline-flex; align-items: center; height: 28px; padding: 0 8px; }
  [role="option"] { display: block; height: 32px; }
  li { display: block; height: 32px; }
  ul { margin: 0; padding: 0; list-style: none; }
`;

function page(title, bodyHtml, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>${BASE_CSS}${extraHead}</style></head>
<body>${bodyHtml}</body></html>`;
}

function readJson(name) {
  const p = path.join(DOM_DIR, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const results = [];

// 1) composer：无 plan（"管理模型"）/ 有 plan（模型名 + data-model-current-value）
const noModel = readJson('composer-2026-11-19T07-37-43.json');
const withModel = readJson('composer-2026-11-19T21-30-18.json');
if (noModel && noModel.composerHtml) {
  fs.writeFileSync(path.join(OUT_DIR, 'composer-no-model.html'),
    page('composer no model', `<div id="conversation" class="relative flex h-full min-h-0 flex-col"><div class="chat-composer-region z-20 w-full shrink-0">${noModel.composerHtml}</div></div>`));
  results.push('composer-no-model.html');
}
if (withModel && withModel.composerHtml) {
  fs.writeFileSync(path.join(OUT_DIR, 'composer-with-model.html'),
    page('composer with model', `<div id="conversation" class="relative flex h-full min-h-0 flex-col"><div class="chat-composer-region z-20 w-full shrink-0">${withModel.composerHtml}</div></div>`));
  results.push('composer-with-model.html');
}

// 1b) 反馈弹窗（[role=dialog] + textarea）：回归"弹窗内容被当成聊天草稿入队"的 bug
const dlgFiles = fs.existsSync(DOM_DIR) ? fs.readdirSync(DOM_DIR).filter(f => f.startsWith('feedback-dialog-')).sort() : [];
const dlg = dlgFiles.length ? readJson(dlgFiles[dlgFiles.length - 1]) : null;
if (dlg && dlg.html) {
  if (withModel && withModel.composerHtml) {
    fs.writeFileSync(path.join(OUT_DIR, 'composer-with-dialog.html'),
      page('composer with feedback dialog',
        `<div id="conversation" class="relative flex h-full min-h-0 flex-col"><div class="chat-composer-region z-20 w-full shrink-0">${withModel.composerHtml}</div></div>${dlg.html}`));
    results.push('composer-with-dialog.html');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'dialog-only.html'), page('dialog only', dlg.html));
  results.push('dialog-only.html');
}

// 2) 会话列表：用真实字段 + 四种状态位的真实标记（工作/未读/错误取自采集，空闲为空 span）
const workingDump = readJson('session-working-20261120-060111.json');
const workingStatus = workingDump && (workingDump.items.find(i => i.state === 'working') || {}).statusHtml;
const WORKING_HTML = workingStatus || '<div class="relative flex size-4 shrink-0 items-center justify-center"><span aria-hidden="true" class="flex size-4 items-center justify-center transition-opacity animate-spin"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="lucide lucide-loader-circle size-4 text-foreground-subtle"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span></div>';
const IDLE_HTML = '<div class="relative flex size-4 shrink-0 items-center justify-center"><span aria-hidden="true" class="flex size-4 items-center justify-center transition-opacity"></span></div>';
const UNREAD_HTML = '<div class="relative flex size-4 shrink-0 items-center justify-center"><span aria-hidden="true" class="flex size-4 items-center justify-center transition-opacity"><span data-unread-indicator="true" class="size-[7px] rounded-full bg-icon-blue"></span></span></div>';
const ERROR_HTML = '<div class="relative flex size-4 shrink-0 items-center justify-center"><span aria-hidden="true" class="flex size-4 items-center justify-center transition-opacity"><span data-error-indicator="true" class="h-1.5 w-1.5 rounded-full bg-destructive"></span></span></div>';

const sessions = [
  { sid: 'sess_idle_0001', title: '空闲会话标题', status: IDLE_HTML },
  { sid: 'sess_working_0002', title: '工作中的会话标题', status: WORKING_HTML },
  { sid: 'sess_unread_0003', title: '有未读结果的会话标题', status: UNREAD_HTML },
  { sid: 'sess_error_0004', title: '出错中断的会话标题', status: ERROR_HTML }
];

const li = s => `<li data-testid="task-item-${s.sid}" data-task-item-key="D:\\Coding\\demo:${s.sid}" draggable="true" tabindex="0"
  class="group/task-item flex cursor-pointer gap-2 rounded-lg pl-2.5 pr-1 py-1 transition" data-state="closed">
  ${s.status}
  <span class="min-w-0 flex-1 truncate text-ui-base">${s.title}</span>
  <span class="text-ui-caption text-foreground-subtle">刚刚</span>
</li>`;

fs.writeFileSync(path.join(OUT_DIR, 'session-list.html'),
  page('session list', `<aside><ul>${sessions.map(li).join('\n')}</ul></aside>`));
results.push('session-list.html');

// 3) / 指令弹层（注入到 composer 页面使用）
const cmd = readJson('command-list-20261120-070824.json');
if (cmd && cmd.cands && cmd.cands[0] && cmd.cands[0].html) {
  fs.writeFileSync(path.join(OUT_DIR, 'command-list-fragment.html'), cmd.cands[0].html);
  results.push('command-list-fragment.html');
}

// 4) 对话区"工作中 + 计时器"
fs.writeFileSync(path.join(OUT_DIR, 'chat-loading.html'), page('chat loading', `
<div id="conversation" class="relative flex h-full min-h-0 flex-col">
  <div data-zcode-chat-loading-slot="true" class="min-h-5">
    <div role="status" aria-label="加载中..." data-zcode-chat-loading-animate="true" data-testid="chat-loading"
         class="inline-flex w-fit items-center gap-2">
      <span data-chat-loading-icon="true" class="flex size-4 shrink-0 items-center justify-center"><svg viewBox="0 0 20 20" class="size-5"></svg></span>
      <span class="animated-gradient-text text-ui-base">工作中</span>
      <span aria-hidden="true" class="font-mono text-ui-caption tabular-nums text-foreground-subtle">1 分 23 秒</span>
    </div>
  </div>
</div>`));
results.push('chat-loading.html');

console.log('fixtures written to test/fixtures:');
results.forEach(r => console.log('  -', r));
