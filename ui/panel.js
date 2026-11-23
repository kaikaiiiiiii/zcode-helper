'use strict';
/* panel.js — 浮窗面板：按钮 + 输出暂停小开关（实时状态在 ZCode 内的灯条里展示） */

let lastState = null;

function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function render(st) {
  lastState = st;
  const controlled = st.connState === 'CONNECTED';

  const dot = document.getElementById('dot');
  const label = document.getElementById('statusLabel');
  const badge = document.getElementById('connBadge');
  const banner = document.getElementById('banner');

  dot.style.background = controlled && !st.helperPaused ? 'var(--green)' : 'var(--gray)';
  label.textContent = !controlled ? '未受控' : (st.helperPaused ? '暂停连接' : '已连接');
  badge.textContent = controlled ? `CDP ${st.cdpPort}` : '未受控';
  badge.className = 'badge ' + (controlled ? 'ok' : 'bad');
  banner.classList.toggle('show', !controlled);

  // 输出暂停：debug 级开关（小 switch，在 CDP 徽标左侧）
  const sw = document.getElementById('swOutput');
  sw.setAttribute('aria-checked', st.outputPaused ? 'true' : 'false');
  document.getElementById('swOutputWrap').classList.toggle('hide', st.showOutputSwitch === false);

  // 按钮：暂停/启动助手、设置、查看队列、重启受控 ZCode（受控时置灰）
  document.getElementById('btnHelper').textContent = st.helperPaused ? '启动 ZCode 助手' : '暂停 ZCode 助手';
  const c = st.counts || { pending: 0, sent: 0, failed: 0, draft: 0 };
  // 只统计待处理：提交(pending) + 草稿；已发送/失败不计数
  const qn = (c.pending || 0) + (c.draft || 0);
  document.getElementById('btnQueue').textContent = `查看队列(${qn})`;

  const btnRestart = document.getElementById('btnRestart');
  btnRestart.disabled = controlled;
}

function renderEvents(lines) {
  const box = document.getElementById('events');
  if (!lines || !lines.length) { box.innerHTML = '<div class="ev">暂无事件</div>'; return; }
  box.innerHTML = lines.slice(-30).reverse().map(line => {
    const cls = line.ev === 'capture' || line.ev === 'replay' ? 'ev hl' : 'ev';
    const brief = JSON.stringify({ ev: line.ev, ...pick(line) });
    return `<div class="${cls}"><span class="t">${fmtTime(line.ts)}</span>${escapeHtml(brief)}</div>`;
  }).join('');
}

function pick(line) {
  const keep = ['to', 'reason', 'action', 'accepted', 'why', 'error', 'itemId', 'status', 'port', 'workspacePath'];
  const out = {};
  for (const k of keep) if (line[k] !== undefined && line[k] !== null) out[k] = String(line[k]).slice(0, 60);
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// ---- 事件绑定（按钮不加 tooltip） ----
document.getElementById('btnHelper').addEventListener('click', () => window.zfh.toggleHelperPaused());
document.getElementById('swOutput').addEventListener('click', () => window.zfh.toggleOutputPaused());
document.getElementById('btnQueue').addEventListener('click', () => window.zfh.openWindow('queue'));
document.getElementById('btnSettings').addEventListener('click', () => window.zfh.openWindow('settings'));
document.getElementById('btnRestart').addEventListener('click', async () => {
  const btn = document.getElementById('btnRestart');
  btn.disabled = true;
  btn.textContent = '重启中…（ZCode 会话已持久，可恢复）';
  await window.zfh.restartZCode();
});

// ---- 初始拉取 + 订阅 ----
window.zfh.onState(st => render(st));
window.zfh.onLog(() => {
  window.zfh.getRecent(30).then(renderEvents);
});
(async () => {
  render(await window.zfh.getState());
  renderEvents(await window.zfh.getRecent(30));
})();
