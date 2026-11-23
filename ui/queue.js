'use strict';
/* queue.js — 队列查看窗口（DESIGN.md §8）：内容/会话/状态/失败原因，可手动重发 failed */

let filter = 'all';

function $(id) { return document.getElementById(id); }
function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''; }

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** 附件预览：路径/图片直接交给 Chromium 渲染（文件不存在时它自己显示破图，不做额外判断） */
function attSrc(a) {
  if (a.dataUrl) return a.dataUrl;
  if (!a.path) return null;
  try { return new URL('file:///' + String(a.path).replace(/\\/g, '/')).href; } catch { return null; }
}
function renderAttachments(it) {
  const list = Array.isArray(it.attachments) ? it.attachments.filter(Boolean) : [];
  if (!list.length) return '';
  return '<div class="qatts">' + list.map(a => {
    const src = attSrc(a);
    const label = esc(a.name || a.path || '附件');
    if (a.kind === 'video' || /\.(mp4|mov|webm|mkv)$/i.test(a.name || '')) {
      return src ? `<video class="qatt" src="${esc(src)}" preload="metadata" muted></video>` : `<div class="qatt file" title="${label}">视频</div>`;
    }
    if (a.kind === 'image' || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name || '')) {
      return src ? `<img class="qatt" src="${esc(src)}" alt="${label}" title="${label}" />` : `<div class="qatt file" title="${label}">图片</div>`;
    }
    return `<div class="qatt file" title="${label}">附件</div>`;
  }).join('') + '</div>';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

async function render() {
  const items = await window.zfh.getQueue();
  const shown = items.filter(i => {
    if (filter === 'all') return true;
    if (filter === 'draft') return i.type === 'draft';
    if (filter === 'pending') return i.status === 'pending' && i.type !== 'draft';
    return i.status === filter && i.type !== 'draft';
  });
  const box = $('list');
  if (!shown.length) {
    box.innerHTML = '<div class="empty">没有符合条件的条目</div>';
    return;
  }
  box.innerHTML = shown.map(it => `
    <div class="qitem">
      <div class="meta">
        <span class="tag ${it.type === 'draft' ? 'draft' : 'submit'}">${it.type === 'draft' ? '草稿' : '提交'}</span>
        ${it.newSession ? '<span class="tag wait">新会话</span>' : ''}
        ${it.holdReason ? `<span class="tag wait">${it.holdReason === 'model' ? '等待模型' : it.holdReason === 'output' ? '消息阻断' : '等待名额'}</span>` : ''}
        <span class="tag ${esc(it.status)}">${esc(it.status)}</span>
        <span class="mono">${esc(it.id)}</span>
        <span>${fmtTime(it.ts)}</span>
        <span>来源 ${esc(it.source)}</span>
        <span title="${esc(it.workspacePath || '')}">项目：<b>${esc(it.draftProjectName || baseName(it.workspacePath) || '未知')}</b></span>
        <span title="${esc(it.sessionId || '')}">对话：<b>${esc(it.sessionTitle || it.sessionId || '未知')}</b></span>
      </div>
      ${renderAttachments(it)}
      <div class="text">${esc(it.text)}</div>
      ${it.error ? `<div class="err">失败原因：${esc(it.error)}</div>` : ''}
      ${it.note ? `<div class="note">备注：${esc(it.note)}</div>` : ''}
      <div class="foot">
        <span class="mono hint">${it.sentAt ? '发送于 ' + fmtTime(it.sentAt) : ''}</span>
        <span>
          ${it.type === 'draft'
            ? (it.status === 'pending' ? `<button data-a="screen" data-id="${esc(it.id)}">上屏</button>` : '')
            : (it.status !== 'sent' ? `<button data-a="submit" data-id="${esc(it.id)}">提交</button>` : '')}
          ${it.status !== 'sent' ? `<button data-a="remove" data-id="${esc(it.id)}">删除</button>` : ''}
        </span>
      </div>
    </div>`).join('');
}

$('list').addEventListener('click', async e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const { a, id } = btn.dataset;
  if (a === 'requeue') await window.zfh.queueAction(id, 'requeue');
  if (a === 'submit') await window.zfh.queueAction(id, 'submit');
  if (a === 'screen') await window.zfh.queueAction(id, 'screen');
  if (a === 'remove') await window.zfh.queueAction(id, 'remove');
  render();
});

document.querySelector('.filters').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  filter = btn.dataset.f;
  document.querySelectorAll('.filters button').forEach(b => b.classList.toggle('on', b === btn));
  render();
});

$('btnResetFailed').addEventListener('click', async () => { await window.zfh.resetFailed(); render(); });
$('btnClearSent').addEventListener('click', async () => { await window.zfh.clearSent(); render(); });
$('btnExport').addEventListener('click', async () => {
  const file = await window.zfh.exportBundle();
  alert('已导出：' + file);
});

window.zfh.onState(() => render());
render();
