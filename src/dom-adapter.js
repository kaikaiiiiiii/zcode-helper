'use strict';
/**
 * dom-adapter.js — helper 侧的 DOM 表达式集中出处（DESIGN.md §5 dom-adapter）
 * 注入侧实现在 inject/bootstrap.js（window.__zfh）。本文件只维护"发给 CDP 的表达式"。
 * 选择器随 ZCode 升级漂移时：改 bootstrap.js 的探测函数 + 本文件的候选表达式，其它模块不动。
 * 失配策略：表达式返回 null/false → 上层报"适配层需更新"并记录 dom-debug 证据，不静默失效。
 */
const { bootstrapSource } = require('./inject/bootstrap');

const HELPER_VERSION = '0.5.36';

module.exports = {
  bootstrapSource: () => bootstrapSource(HELPER_VERSION),
  helperVersion: HELPER_VERSION,

  /** 注入侧快照：composer 全文 + 会话信息（player 用） */
  snapshotSrc: `(() => { try { return window.__zfh ? window.__zfh.snapshot() : null; } catch (e) { return null; } })()`,

  /** 引导脚本确保执行（幂等，window.__zfh 判重）；返回版本号或 null */
  ensureBootstrapSrc: `(() => { try { if (window.__zfh) return window.__zfh.version; return 'not-injected'; } catch (e) { return null; } })()`,

  /** 模式切换：recording | playing | paused（回放期间 helper 会临时切 playing 以放行 Enter/按钮） */
  setModeSrc: mode => `(() => { try { return window.__zfh ? window.__zfh.setMode(${JSON.stringify(mode)}) : null; } catch (e) { return null; } })()`,

  /** 灯条：实时状态（连接/工作中/待发/模型/等待原因/最近事件）全部走这一个入口 */
  setLightBarSrc: payload =>
    `(() => { try { if (!window.__zfh || !window.__zfh.setLightBar) return false; window.__zfh.setLightBar(${JSON.stringify(payload)}); return true; } catch (e) { return false; } })()`,

  /** 注入标记：让页面把紧接着的那一次 Enter 当成 helper 注入（不被自己的滤网截获） */
  beginInjectSrc: `(() => { try { if (!window.__zfh) return false; window.__zfh.injectingUntil = Date.now() + 1500; return true; } catch (e) { return false; } })()`,

  /** composer 矩形（真实点击聚焦用）；统一走注入侧的 findComposer（避免与弹窗 textarea 混淆） */
  composerRectSrc: `(() => { try {
    if (!window.__zfh || typeof window.__zfh.findComposer !== 'function') return { ok: false, why: 'no-bootstrap' };
    var c = window.__zfh.findComposer();
    if (!c) return { ok: false, why: 'composer-not-found' };
    var r = c.getBoundingClientRect();
    return { ok: r.width > 10 && r.height > 10, x: r.x, y: r.y, w: r.width, h: r.height };
  } catch (e) { return { ok: false, why: String(e && e.message || e).slice(0, 60) }; } })()`,

  /** DOM 聚焦 composer（真实点击失败的退化路径）；同样走 findComposer */
  composerFocusSrc: `(() => { try {
    if (!window.__zfh || typeof window.__zfh.findComposer !== 'function') return false;
    var c = window.__zfh.findComposer();
    if (!c) return false;
    c.focus();
    return true;
  } catch (e) { return false; } })()`,

  /**
   * 清空 composer（VM 实测修复 #3/#4）。注入侧走 execCommand + 原生 setter 兜底。
   * 返回 {ok, text}；ok=false 时带 why。
   */
  clearComposerSrc: `(() => { try { if (!window.__zfh || !window.__zfh.clearComposer) return { ok: false, why: 'no-api' }; return window.__zfh.clearComposer(); } catch (e) { return { ok: false, why: String(e && e.message || e).slice(0, 80) }; } })()`,

  /**
   * 定位会话（本机实测修订：排除聊天正文误匹配，会话项候选优先 task-item）。
   * 关键约束：候选必须位于会话主容器 [data-session-id] 之外（本会话正文文本可能恰好包含目标标题——实测踩过）。
   * 候选优先级：data-session-id 精确（未来列表项若暴露 id）→ [class*="task-item"]（实测真实类名）→ 其余列表项标签。
   * 只返回矩形 + 过程计数（失配时可诊断），由 player 用真实鼠标点击切换。
   */
  locateSessionSrc: `(function (sessionId, title) { try {
    function vis(el) { var r = el.getBoundingClientRect(); return r.width > 10 && r.height > 10; }
    function norm(s) { return String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase(); }
    function inConversation(el) {
      var c = document.querySelector('[data-session-id]');
      return !!(c && c.contains(el));
    }
    var dbg = { candCount: 0, checked: 0, skippedVis: 0, skippedLen: 0, skippedScope: 0, firstMatched: null };
    var i, el, r;
    if (sessionId) {
      var nodes = document.querySelectorAll('[data-session-id]');
      for (i = 0; i < nodes.length; i++) {
        el = nodes[i];
        if (inConversation(el) || !vis(el)) continue; // 主容器自身不算列表项
        if (el.getAttribute('data-session-id') === sessionId) {
          r = el.getBoundingClientRect();
          dbg.firstMatched = { tag: el.tagName, matchedBy: 'id' };
          return { ok: true, matchedBy: 'id', x: r.x, y: r.y, w: r.width, h: r.height, dbg: dbg };
        }
      }
    }
    var target = norm(title);
    if (target && target.length >= 2) {
      var sels = [
        '[class*="task-item" i]',  // 本机实测：侧栏会话项真实类名
        '[role="option"],[role="listitem"],[role="menuitem"],[role="treeitem"],li,a'
      ];
      for (var s = 0; s < sels.length; s++) {
        var cands = document.querySelectorAll(sels[s]);
        if (s === 0) dbg.candCount = cands.length;
        for (i = 0; i < cands.length; i++) {
          el = cands[i];
          if (!vis(el)) { dbg.skippedVis++; continue; }
          if (inConversation(el)) { dbg.skippedScope++; continue; } // 排除聊天正文
          var txt = norm(el.textContent);
          if (!txt || txt.length > 120) { dbg.skippedLen++; continue; }
          dbg.checked++;
          if (txt === target || txt.indexOf(target) >= 0) {
            r = el.getBoundingClientRect();
            dbg.firstMatched = { tag: el.tagName, cls: String(el.className || '').slice(0, 60), txt: txt.slice(0, 60), matchedBy: s === 0 ? 'title:task-item' : 'title:generic' };
            return { ok: true, matchedBy: dbg.firstMatched.matchedBy, x: r.x, y: r.y, w: r.width, h: r.height, dbg: dbg };
          }
        }
      }
    }
    return { ok: false, dbg: dbg };
  } catch (e) { return { ok: false, threw: String(e && e.message || e).slice(0, 80) }; } })(__SESSION_ID__, __SESSION_TITLE__)`,

  /** DOM 结构诊断（选择器失配时的证据；VM 测试回传后更新适配层） */
  debugDomSrc: `(() => { try { return window.__zfh && window.__zfh.debugDom ? window.__zfh.debugDom() : null; } catch (e) { return null; } })()`,

  /**
   * 全部会话的工作状态（回放并发闸门用）。实测结构（logs/dom/session-working-*.json）：
   *   li[data-testid="task-item-<sid>"] 的状态位 div.relative.flex.size-4
   *     工作中：span.animate-spin > svg.lucide-loader-circle
   *     未读蓝点：span[data-unread-indicator][class*=bg-icon-blue]
   *     出错红点：span[data-error-indicator][class*=bg-destructive]
   * 注意：点只是"疑似结束"，可能仍在工作（实测蓝点底下还在跑），需要消点确认。
   */
  /** 在指定项目里点「新建任务」：返回按钮坐标（项目收着就先展开） */
  openProjectNewTaskSrc: name => `(() => {
    var want = String(${JSON.stringify(name)} || '').trim();
    var norm = function (x) { return String(x || '').replace(/\\s+/g, ' ').trim(); };
    // 「选择项目」/ 空 = 任务分区（不属于任何工程）
    if (!want || want === '选择项目') {
      var taskSec = document.querySelector('section[data-testid="conversation-section"]');
      if (!taskSec) return { ok: false, why: 'no-task-section' };
      var taskBtn = taskSec.querySelector('[data-testid="virtual-project-new-task"]');
      if (!taskBtn) return { ok: false, why: 'no-task-create-btn' };
      try { taskBtn.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
      var tr = taskBtn.getBoundingClientRect();
      if (!tr.width || !tr.height) return { ok: false, why: 'task-btn-hidden' };
      return { ok: true, kind: 'task', x: Math.round(tr.x + tr.width / 2), y: Math.round(tr.y + tr.height / 2) };
    }
    var secs = [].slice.call(document.querySelectorAll('section[data-project-name]'));
    var sec = null;
    for (var i = 0; i < secs.length; i++) {
      if (norm(secs[i].getAttribute('data-project-name')).toLowerCase() === want.toLowerCase()) { sec = secs[i]; break; }
    }
    if (!sec) return { ok: false, why: 'project-not-found', names: secs.map(function (s) { return s.getAttribute('data-project-name'); }) };
    if (sec.getAttribute('data-state') === 'closed') {
      var t = sec.querySelector('[data-testid="virtual-project-toggle"]');
      if (t) t.click();
      return { ok: false, why: 'expanded-now', expanded: true };
    }
    var btn = sec.querySelector('[data-testid="virtual-project-create-task"]');
    if (!btn) return { ok: false, why: 'no-create-btn' };
    try { btn.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    var r = btn.getBoundingClientRect();
    if (!r.width || !r.height) return { ok: false, why: 'create-btn-hidden' };
    return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`,

  /** 新建会话是否已经就绪（空会话 + 项目 chip 对上） */
  newSessionReadySrc: name => `(() => {
    var want = String(${JSON.stringify(name)} || '').trim();
    var norm = function (x) { return String(x || '').replace(/\\s+/g, ' ').trim(); };
    var empty = !!document.querySelector('[data-testid="chat-empty"]');
    var chip = document.querySelector('[data-testid="composer-workspace-trigger"]');
    var cur = chip ? norm(chip.textContent) : '';
    return { empty: empty, chip: cur, match: !!want && cur.toLowerCase() === want.toLowerCase(), sid: (function () { try { return window.__zfh.snapshot().session.sessionId; } catch (e) { return null; } })() };
  })()`,

  /** 模型触发器状态：文本 / data-model-current-value / aria-haspopup */
  modelTriggerStateSrc: `(() => {
    var t = document.querySelector('[data-testid="chat-model-select-trigger"]');
    if (!t) return null;
    var r = t.getBoundingClientRect();
    return {
      text: String(t.innerText || '').replace(/\\s+/g, ' ').trim(),
      value: t.getAttribute('data-model-current-value') || null,
      haspopup: t.getAttribute('aria-haspopup') || null,
      visible: r.width > 0 && r.height > 0,
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)
    };
  })()`,

  /** 在已打开的模型面板里点某项（按模型名完整匹配 testid 尾段 / 文本首词） */
  modelItemPickSrc: name => `(() => {
    var want = String(${JSON.stringify(name)} || '');
    var items = [].slice.call(document.querySelectorAll('[data-testid^="chat-model-select-item-"]'));
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var tid = el.getAttribute('data-testid') || '';
      var id = tid.slice(tid.lastIndexOf(':') + 1);
      var txt = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
      var first = txt.split(' ')[0];
      if (id === want || first === want) {
        var r = el.getBoundingClientRect();
        if (!r.width || !r.height) return { ok: false, why: 'hidden' };
        return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: txt };
      }
    }
    return { ok: false, why: 'not-found' };
  })()`,

  /** 侧边栏是否展开（折叠时 aside 宽度只剩几像素，任务列表不可见）+ 切换按钮坐标 */
  sidebarStateSrc: `(() => {
    var t = document.querySelector('[data-testid="desktop-top-logo-sidebar-toggle"]');
    var aside = document.querySelector('aside');
    var list = document.querySelector('[data-testid="task-list"]');
    var asideW = aside ? aside.getBoundingClientRect().width : 0;
    var listW = list ? list.getBoundingClientRect().width : 0;
    var r = t ? t.getBoundingClientRect() : null;
    return {
      expanded: asideW > 100 || listW > 40,
      asideW: Math.round(asideW),
      listW: Math.round(listW),
      toggle: r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null
    };
  })()`,

  /** 模型面板里的供应商项（点它展开子菜单，里面有「管理模型」） */
  modelPanelProviderSrc: `(() => {
    var p = document.querySelector('[data-testid="composer-provider-trigger"]');
    if (!p) return { ok: false };
    var r = p.getBoundingClientRect();
    if (!r.width || !r.height) return { ok: false, why: 'hidden' };
    return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`,

  /** 面板里当前供应商的模型列表：[{testid,text,checked,disabled,x,y}] */
  modelListSrc: `(() => {
    var els = [].slice.call(document.querySelectorAll('[data-testid^="chat-model-select-item-"]'));
    return els.map(function (el) {
      var r = el.getBoundingClientRect();
      return {
        testid: el.getAttribute('data-testid'),
        text: String(el.innerText || '').replace(/\\s+/g, ' ').trim(),
        checked: el.getAttribute('aria-checked') || el.getAttribute('aria-selected'),
        disabled: el.getAttribute('aria-disabled') === 'true' || el.getAttribute('data-disabled') === 'true' || el.disabled === true,
        x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width)
      };
    }).filter(function (i) { return i.w > 0; });
  })()`,

  /** 面板里当前供应商的名字（供应商触发器文本） */
  modelProviderCurrentSrc: `(() => {
    var p = document.querySelector('[data-testid="composer-provider-trigger"]');
    return p ? String(p.innerText || '').replace(/\\s+/g, ' ').trim() : null;
  })()`,

  /** 供应商二级菜单里的供应商列表：[{tid,text,checked,x,y}]（含「管理模型」项时 text='管理模型'） */
  modelProviderListSrc: `(() => {
    var els = [].slice.call(document.querySelectorAll('[data-testid^="chat-model-select-group-registry-provider:"]'));
    return els.map(function (el) {
      var r = el.getBoundingClientRect();
      return {
        tid: el.getAttribute('data-testid'),
        text: String(el.innerText || '').replace(/\\s+/g, ' ').trim(),
        checked: el.getAttribute('aria-checked') || el.getAttribute('aria-selected'),
        x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width)
      };
    }).filter(function (i) { return i.w > 0; });
  })()`,

  /** 模型面板（或子菜单）里的「管理模型」项：3.19.1 是 provider-panel 内的 button，无 testid/role */
  modelPanelManageSrc: `(() => {
    var scopes = [].slice.call(document.querySelectorAll('[data-testid="composer-provider-panel"], [role="menu"], [role="dialog"]'));
    for (var i = 0; i < scopes.length; i++) {
      var els = [].slice.call(scopes[i].querySelectorAll('button, [role="menuitem"], [role="option"]'));
      for (var j = 0; j < els.length; j++) {
        if (String(els[j].innerText || '').replace(/\\s+/g, ' ').trim() === '管理模型') {
          var r = els[j].getBoundingClientRect();
          if (r.width && r.height) return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
      }
    }
    return { ok: false };
  })()`,

  /** 模型设置页的「返回工作区」按钮 */
  settingsBackSrc: `(() => {
    var b = document.querySelector('[data-testid="settings-back-button"]');
    if (!b) return { ok: false };
    var r = b.getBoundingClientRect();
    if (!r.width || !r.height) return { ok: false, why: 'hidden' };
    return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`,

  /** 额度/模型不可用的横幅（无 data-error-code 的那种也要认） */
  quotaBannerSrc: `(() => {
    var q = document.querySelector('[data-testid="v4-session-quota-banner"]');
    var m = document.querySelector('[data-testid="chat-error-banner"][data-error-code="ZCODE_RUNTIME_MODEL_UNAVAILABLE"]');
    var norm = function (x) { return String(x || '').replace(/\\s+/g, ' ').trim(); };
    return {
      quota: q ? norm(q.textContent).slice(0, 120) : null,
      model: m ? norm(m.textContent).slice(0, 120) : null
    };
  })()`,

  /** 输入框里的附件（总数 + 已就绪数） */
  attachmentsStateSrc: `(() => {
    var row = document.querySelector('[data-composer-file-attachments-row]');
    var chips = row ? [].slice.call(row.querySelectorAll('[data-testid^="v4-attachment-"]')) : [];
    return { total: chips.length, ready: chips.filter(function (c) { return c.getAttribute('data-upload-status') === 'ready'; }).length };
  })()`,

  sessionStatesSrc: `(() => { try {
    var out = [];
    var lis = document.querySelectorAll('li[data-testid^="task-item-"]');
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i];
      var st = li.querySelector('div.relative.flex.size-4');
      if (!st) continue;
      var dotEl = st.querySelector('[data-unread-indicator],[data-error-indicator]');
      out.push({
        sid: (li.getAttribute('data-testid') || '').replace('task-item-', ''),
      key: li.getAttribute('data-task-item-key') || null,
      title: (() => { const t = li.querySelector('[data-task-title-copy]'); return t ? t.textContent.trim().slice(0, 60) : null; })(),
      projectId: (() => { const s = li.closest('section[data-project-id]'); return s ? s.getAttribute('data-project-id') : null; })(),
      projectName: (() => { const s = li.closest('section[data-project-id]'); return s ? s.getAttribute('data-project-name') : null; })(),
        title: (li.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        working: !!st.querySelector('.animate-spin'),
        dot: dotEl ? (dotEl.hasAttribute('data-unread-indicator') ? 'unread' : 'error') : null,
        visible: li.getBoundingClientRect().height > 3
      });
    }
    return out;
  } catch (e) { return null; } })()`,

  /**
   * 当前打开会话是否仍在工作（比 sidebar 精确：实测侧栏可能只显示未读点、实际还在跑）。
   * 只看结构标记，不看 icon 与文案：加载位容器 + chat-loading 节点 + 计时器文本。
   */
  chatLoadingSrc: `(() => { try {
    var el = document.querySelector('[data-testid="chat-loading"]');
    if (!el) return { working: false };
    var t = el.querySelector('.tabular-nums');
    return { working: true, timer: t ? (t.textContent || '').trim() : null, aria: el.getAttribute('aria-label') };
  } catch (e) { return { working: false }; } })()`,

  /** 当前"地面真相"：打开的是哪个会话、属于哪个项目（侧栏项目收起时 li 不在 DOM 里，只能靠记录的名字展开） */
  workspaceStateSrc: `(() => { try {
    var info = window.__zfh.snapshot();
    var s = (info && info.session) || {};
    var sid = s.sessionId || null;
    var li = sid ? document.querySelector('[data-testid="task-item-' + sid + '"]') : null;
    var key = li ? li.getAttribute('data-task-item-key') : null;
    var wsKey = null;
    if (key) { var i = key.lastIndexOf(':'); wsKey = i > 1 ? key.slice(0, i) : null; }
    return {
      sessionId: sid,
      title: s.sessionTitle || null,
      workspaceKey: wsKey,
      workspaceName: window.__zfh.workspaceNameOf(wsKey)
    };
  } catch (e) { return { error: String(e && e.message || e).slice(0, 80) }; } })()`,

  /** 展开侧栏项目（name 传项目显示名；找不到同名则展开所有收起的） */
  expandProjectSrc: `(function (name) {
    try { return window.__zfh.expandProject(name); }
    catch (e) { return { error: String(e && e.message || e).slice(0, 80) }; }
  })(__NAME__)`,


  /** 模型选择器触发器矩形（点开菜单用真实鼠标点击） */
  modelTriggerRectSrc: `(() => { try {
    var t = document.querySelector('[data-testid="chat-model-select-trigger"]');
    if (!t) return { ok: false, why: 'no-trigger' };
    var b = t.getBoundingClientRect();
    if (b.width < 5 || b.height < 5) return { ok: false, why: 'invisible' };
    return { ok: true, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  } catch (e) { return { ok: false, why: String(e && e.message || e).slice(0, 60) }; } })()`,

  /** 模型菜单内容（打开后读）：目标模型是否在列表里、是否被禁用 */
  modelMenuSrc: `(() => { try {
    var norm = function (s) { return String(s || '').replace(/\\s+/g, ' ').trim(); };
    var menu = document.querySelector('[data-testid="composer-model-panel"], [role="menu"], [data-radix-menu-content]');
    if (!menu) return { open: false };
    var items = [].slice.call(menu.querySelectorAll('[data-testid^="chat-model-select-item-"], [role="menuitemradio"], [role="option"]')).map(function (el) {
      return {
        testid: el.getAttribute('data-testid'),
        text: norm(el.innerText).slice(0, 80),
        checked: el.getAttribute('aria-checked') || el.getAttribute('aria-selected'),
        disabled: el.getAttribute('aria-disabled') === 'true' || el.getAttribute('data-disabled') === 'true' || el.disabled === true
      };
    });
    var hints = [];
    var all = menu.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var t = norm(all[i].innerText);
      if (!t || t.length > 120) continue;
      if (/升级|套餐|不可用|暂无|没有|购买|开通|订阅/.test(t) && hints.indexOf(t) < 0) hints.push(t);
    }
    return { open: true, items: items, hints: hints.slice(0, 8), text: norm(menu.innerText).slice(0, 300) };
  } catch (e) { return { open: false, error: String(e && e.message || e).slice(0, 60) }; } })()`,

  sessionItemRectSrc: `(function (sid) { try {
    var el = sid ? document.querySelector('li[data-testid="task-item-' + sid + '"]') : null;
    if (!el) return { ok: false, why: 'not-found' };
    var r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) return { ok: false, why: 'invisible' };
    return { ok: true, x: r.x, y: r.y, w: r.width, h: r.height };
  } catch (e) { return { ok: false, why: String(e && e.message || e).slice(0, 60) }; } })(__SID__)`,

  /**
   * 模型可用性探针（VM 实测修复 #1：主判定信号）。
   * 负信号 = 无模型横幅文案命中（立即确认）；正信号 = 模型名出现在小元素（连续 2 次才确认，滞后防抖）。
   * fixedModelId 由 engine 传入。
   */
  probeModelSrc: fixedModelId => `(() => { try { if (!window.__zfh || !window.__zfh.probeModel) return { noApi: true }; return window.__zfh.probeModel(${JSON.stringify(fixedModelId || '')}); } catch (e) { return { error: String(e && e.message || e).slice(0, 80) }; } })()`,

  /** 模型不可用报错探测（player 失败后调用；候选文案：VM 实测原文 + 英文） */
  errorProbeSrc: `(() => { try {
    if (window.__zfh && window.__zfh.probeModel) {
      var r = window.__zfh.probeModel('');
      if (r && r.unavailable) return true;
    }
    var pats = /无可用模型|没有可用模型|请开通编程套餐|no available model/i;
    var nodes = document.querySelectorAll('[role="alert"],[role="status"],[class*="error" i],[class*="warn" i]');
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].textContent || '').trim();
      if (t && pats.test(t) && nodes[i].offsetWidth > 0) return true;
    }
    return false;
  } catch (e) { return false; } })()`
};
