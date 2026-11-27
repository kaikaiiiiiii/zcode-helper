'use strict';
/* settings.js — 设置窗口（DESIGN.md §6 config.json 字段的全量暴露） */

const FIELDS = ['zcodeExePath', 'defaultWorkspacePath', 'maxWorkingSessions', 'idleGuardSeconds', 'modelRefreshSeconds', 'planProbeSeconds', 'queueArchiveDays', 'fixedModelId'];
const CHECKS = ['autoLaunchZCode', 'panelAlwaysOnTop', 'showOutputSwitch'];

function $(id) { return document.getElementById(id); }

async function load() {
  const cfg = await window.zfh.getConfig();
  for (const f of FIELDS) $(f).value = cfg[f] ?? '';
  for (const c of CHECKS) $(c).checked = !!cfg[c];
}

async function save() {
  const patch = {};
  for (const f of FIELDS) {
    if (f === 'maxWorkingSessions' || f === 'idleGuardSeconds' || f === 'modelRefreshSeconds' || f === 'planProbeSeconds' || f === 'queueArchiveDays') {
      patch[f] = Number(String($(f).value).replace(/[^0-9]/g, '')) || undefined;
    } else if (f === 'fixedModelId') {
      // 模型可用性检测：半角逗号分隔，保存时统一成 ", " 分隔
      patch[f] = $(f).value.split(',').map(s => s.trim()).filter(Boolean).join(', ');
    } else {
      patch[f] = $(f).value.trim();
    }
  }
  for (const c of CHECKS) patch[c] = $(c).checked;
  await window.zfh.setConfig(patch);
  $('saveHint').textContent = '已保存 ✓';
  setTimeout(() => { $('saveHint').textContent = ''; }, 1500);
}

document.getElementById('btnSave').addEventListener('click', save);
document.getElementById('btnCancel').addEventListener('click', () => window.zfh.hideSelf());
document.getElementById('btnExport').addEventListener('click', async () => {
  await window.zfh.exportBundle(); // 主进程负责打开文件夹 + 弹窗告知路径
});
document.getElementById('browseExe').addEventListener('click', async () => {
  const p = await window.zfh.pickPath('exe');
  if (p) $('zcodeExePath').value = p;
});
document.getElementById('browseWs').addEventListener('click', async () => {
  const p = await window.zfh.pickPath('workspace');
  if (p) $('defaultWorkspacePath').value = p;
});
// 覆盖式滚动条：不占布局；静止时半透明，滚动时变亮
function initOverlayScroll() {
  const scroller = document.querySelector('.settings');
  if (!scroller) return;
  const thumb = document.createElement('div');
  thumb.className = 'scroll-thumb';
  document.body.appendChild(thumb);
  let hideTimer = null;
  const render = () => {
    const view = scroller.clientHeight;
    const total = scroller.scrollHeight;
    if (total <= view + 2) { thumb.style.display = 'none'; return; }
    thumb.style.display = 'block';
    const h = Math.max(28, Math.round((view / total) * view));
    const maxTop = view - h;
    const ratio = scroller.scrollTop / Math.max(1, total - view);
    thumb.style.height = h + 'px';
    thumb.style.top = Math.round(ratio * maxTop) + 'px';
  };
  scroller.addEventListener('scroll', () => {
    render();
    thumb.classList.add('active');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => thumb.classList.remove('active'), 700);
  });
  window.addEventListener('resize', render);
  try { new ResizeObserver(render).observe(scroller); } catch { /* ignore */ }
  render();
}
initOverlayScroll();

load();
