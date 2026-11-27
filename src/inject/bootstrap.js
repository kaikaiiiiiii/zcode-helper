'use strict';
/**
 * inject/bootstrap.js — 注入 ZCode 渲染进程的引导脚本（dom-adapter 的注入侧实现）
 *
 * 职责（DESIGN.md §5）：composer/提交按钮/会话信息探测、录制态 Enter+提交按钮接管、
 * composer 清空（React 受控组件兼容）、快照数据读取、模型可用性探针、DOM 结构诊断、状态圆点。
 * 所有 DOM 选择器集中在本文件 —— ZCode 升级漂移时只改这里。
 * 每个探测函数按"候选选择器 + 可见性探测"编写，失败返回 null/false 而不是静默错选。
 *
 * 注入方式（HANDOFF §3 已验证）：Runtime.evaluate 首次执行 + Page.addScriptToEvaluateOnNewDocument 持久化。
 * 与 helper 的通信：Runtime.addBinding('zfhReport') → window.zfhReport(JSON 字符串) → bindingCalled 事件。
 *
 * 注意：本文件导出的是"源码字符串"。内部代码避免模板字符串/反引号，全部用单引号拼接，便于外层包裹。
 */

function bootstrapSource(version) {
  return `
(function () {
  // 热升级：同版本幂等跳过；版本不同 → 冻结旧实例（旧闭包监听器读旧对象的 mode，置为
  // 'uncontrolled' 后永久失活且无法再变——helper 只写 window.__zfh 即新对象），再整体重建。
  // 这样 helper 重连/重启后 evaluate 新版源码即可完成升级，无需页面导航。
  if (window.__zfh) {
    if (window.__zfh.version === ${JSON.stringify(version)}) return;
    try {
      window.__zfh.mode = 'uncontrolled';
      window.__zfh.upgradedAt = Date.now();
      if (typeof window.__zfh.setIndicator === 'function') window.__zfh.setIndicator('uncontrolled', 0);
      // 旧版本灯条元素可能带着旧样式/旧事件：升级时删掉，交给新实例重建
      var oldBar = document.getElementById('zfh-lightbar');
      if (oldBar && oldBar.parentNode) oldBar.parentNode.removeChild(oldBar);
    } catch (e) { /* 旧实例冻结失败也继续重建 */ }
  }
  var ZFH = {
    version: ${JSON.stringify(version)},
    mode: 'uncontrolled', // recording | playing | paused | uncontrolled（helper 是唯一写者；回放期间 helper 会临时切 playing）
    pendingCount: 0
  };
  window.__zfh = ZFH;

  // ---------- 工具 ----------
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    return r.width > 10 && r.height > 10;
  }
  function normText(s) { return String(s || '').replace(/\\s+/g, ' ').trim(); }
  function report(payload) {
    try {
      payload.t = Date.now();
      payload.mode = ZFH.mode;
      if (typeof window.zfhReport === 'function') window.zfhReport(JSON.stringify(payload));
    } catch (e) { /* 上报失败静默：helper 侧有心跳/重连兜底 */ }
  }

  // ---------- composer 探测（候选选择器，随 app 升级在此增删） ----------
  // 聊天输入区（实测 .chat-composer-region）：用来把聊天输入框和弹窗里的 textarea 区分开。
  // 2026-11-20 实测 bug：反馈弹窗 [role=dialog] 里的 textarea 会自动聚焦，旧逻辑"聚焦者优先"把弹窗
  // 内容当成聊天草稿入队了 —— 所以必须先锚定聊天区域，且回退路径排除弹窗控件。
  function composerRegion() {
    return document.querySelector('[class*="chat-composer-region"]');
  }
  function inDialog(el) {
    return !!(el && el.closest && el.closest('[role="dialog"],[aria-modal="true"]'));
  }
  function findComposer() {
    var i;
    var region = composerRegion();
    if (region) {
      var inner = region.querySelector('[data-testid="v4-composer-input"],[data-lexical-editor="true"],textarea[placeholder],[contenteditable="true"],[role="textbox"]');
      if (inner && isVisible(inner)) return inner;
      return null; // 区域在但编辑器不可见（切换中）→ 视为没有输入框
    }
    // 回退（未知版本）：旧启发式，排除弹窗里的输入控件
    var cands = [];
    var tas = document.querySelectorAll('textarea[placeholder]');
    for (i = 0; i < tas.length; i++) { if (!inDialog(tas[i])) cands.push(tas[i]); }
    var ces = document.querySelectorAll('[contenteditable="true"],[contenteditable=""]');
    for (i = 0; i < ces.length; i++) { if (ces[i].tagName !== 'TEXTAREA' && !inDialog(ces[i])) cands.push(ces[i]); }
    var boxes = document.querySelectorAll('[role="textbox"]');
    for (i = 0; i < boxes.length; i++) { if (!inDialog(boxes[i])) cands.push(boxes[i]); }
    var visible = [];
    for (i = 0; i < cands.length; i++) {
      if (cands[i].offsetParent !== undefined && isVisible(cands[i]) && visible.indexOf(cands[i]) < 0) visible.push(cands[i]);
    }
    if (!visible.length) return null;
    for (i = 0; i < visible.length; i++) {
      if (visible[i] === document.activeElement || visible[i].contains(document.activeElement)) return visible[i];
    }
    var best = visible[0], bestTop = -1;
    for (i = 0; i < visible.length; i++) {
      var top = visible[i].getBoundingClientRect().top;
      if (top > bestTop) { bestTop = top; best = visible[i]; }
    }
    return best;
  }
  function composerText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA') return el.value || '';
    return el.innerText || el.textContent || '';
  }
  function isComposerEmpty(el) {
    var t = (composerText(el) || '').trim();
    if (t) return false;
    if (el && el.tagName !== 'TEXTAREA') {
      // contenteditable 里可能只剩占位 <p><br></p> 之类
      var ph = el.querySelector('[data-placeholder], .placeholder');
      if (ph && ph.textContent && ph.textContent.trim()) return false;
      return (el.textContent || '').trim() === '';
    }
    return true;
  }

  // ---------- composer 清空（VM 实测修复 #3/#4） ----------
  // React 受控组件：直接赋值 + input 事件会被状态回滚。主路径走 execCommand('delete')（真实编辑管道，
  // React/Draft 类编辑器都能收到）；兜底用"原生 value setter + input 事件"（React onChange 才认）。
  function clearComposer(c) {
    try {
      c.focus();
      if (c.tagName === 'TEXTAREA') {
        c.select();
      } else {
        var r = document.createRange();
        r.selectNodeContents(c);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
      document.execCommand('delete', false, null);
    } catch (e) { /* 走兜底 */ }
    try {
      if (!isComposerEmpty(c)) {
        if (c.tagName === 'TEXTAREA') {
          var desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
          if (desc && desc.set) { desc.set.call(c, ''); c.dispatchEvent(new Event('input', { bubbles: true })); }
          else { c.value = ''; }
        } else {
          c.textContent = '';
          c.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
        }
      }
    } catch (e2) { /* 尽力 */ }
    return isComposerEmpty(c);
  }
  ZFH.clearComposer = function () {
    var c = findComposer();
    if (!c) return { ok: false, why: 'composer-not-found' };
    var ok = clearComposer(c);
    return { ok: ok, text: composerText(c) };
  };

  // 暴露给测试：指令/建议弹层是否打开、当前 composer 元素（供 DOM 夹具测试复用同一套探测逻辑）
  ZFH.suggestionsOpen = suggestionsOpen;
  ZFH.findComposer = findComposer;

  // ---------- 提交按钮探测 ----------
  // 候选：type=submit / aria-label 含 send(发送) / testid 含 send；探测可见。
  function findSendButton() {
    var sels = [
      'button[data-testid="v4-composer-send"]', // 实测真实 testid
      'button[type="submit"]',
      'button[aria-label*="send" i]', '[role="button"][aria-label*="send" i]',
      'button[aria-label*="发送"]', '[role="button"][aria-label*="发送"]',
      'button[data-testid*="send" i]', '[data-testid*="send" i][role="button"]'
    ];
    var region = composerRegion(); // 只认聊天输入区里的发送按钮，避免误拦截弹窗的提交按钮
    for (var i = 0; i < sels.length; i++) {
      var els = (region || document).querySelectorAll(sels[i]);
      for (var j = els.length - 1; j >= 0; j--) {
        if (!isVisible(els[j])) continue;
        if (region && !region.contains(els[j])) continue;
        return els[j];
      }
    }
    return null;
  }

  // ---------- 会话信息探测（本机实测修订：会话容器带真实 data-session-id=sess_xxx） ----------
  // 优先级：显式 data 属性 → 会话容器 [data-session-id]（本机实测存在，与 db.sqlite session.id 同格式）
  // → 列表活动项文本 → 主区标题 → document.title 兜底。全部弱依赖。
  // 会话所属工作区：实测侧栏 li[data-testid="task-item-<sid>"][data-task-item-key="<workspace>:<sid>"]
  function workspaceOfSession(sid) {
    try {
      var el = sid ? document.querySelector('[data-testid="task-item-' + sid + '"]') : null;
      if (!el) return null;
      var key = el.getAttribute('data-task-item-key');
      if (!key) return null;
      var i = key.lastIndexOf(':');
      return i > 1 ? key.slice(0, i) : null; // i>1 跳过盘符 "D:"
    } catch (e) { return null; }
  }

  /** 项目显示名：composer 的工作区 chip（**当前打开的项目**，只对"当前会话"有意义） */
  function currentProjectName() {
    try {
      var chip = document.querySelector('[data-testid="composer-workspace-trigger"]');
      return chip ? normText(chip.textContent) : ''; // 模板字符串：normText 已做空白归一
    } catch (e) { return ''; }
  }

  /** 路径 → 项目名（末段）。侧栏"项目"可以收起，收起后该项目的会话 li 会从 DOM 消失，
   *  所以队列条目要单独记下项目名，回放时靠它先把项目展开。 */
  function workspaceNameOf(path) {
    if (!path) return null;
    var segs = String(path).split(/[\\\\/]+/).filter(Boolean);
    return segs.length ? segs[segs.length - 1] : null;
  }

  /** 展开侧栏里的项目（收起状态下会话 li 不在 DOM 里，必须先展开才能定位会话）。
   *  传 projectId 或项目名：优先按 data-project-id 精确定位，其次按名字；
   *  找不到则退化为"展开所有收起的项目"。 */
  function expandProject(key) {
    var out = { matched: false, fallback: false, by: null, expanded: [], collapsedLeft: 0 };
    var toggles = [].slice.call(document.querySelectorAll('button[data-testid="virtual-project-toggle"]'));
    var want = key ? String(key).trim() : '';
    var hit = null;
    if (want) {
      // 1) projectId 精确匹配（section[data-project-id] 里的 toggle）
      var sec = document.querySelector('section[data-project-id="' + want.replace(/"/g, '\\"') + '"]');
      if (sec) { hit = sec.querySelector('button[data-testid="virtual-project-toggle"]'); if (hit) out.by = 'id'; }
      // 2) 项目名匹配
      if (!hit) {
        var lw = want.toLowerCase();
        for (var i = 0; i < toggles.length; i++) {
          if (normText(toggles[i].textContent).toLowerCase() === lw) { hit = toggles[i]; out.by = 'name'; break; }
        }
      }
    }
    if (hit) {
      out.matched = true;
      if (hit.getAttribute('aria-expanded') === 'false') {
        hit.click();
        out.expanded.push((hit.textContent || '').trim());
      }
    } else if (want) {
      out.fallback = true; // 名字对不上（项目被改名？）：把收起的都展开，再按 sid 找
      for (var j = 0; j < toggles.length; j++) {
        if (toggles[j].getAttribute('aria-expanded') === 'false') {
          toggles[j].click();
          out.expanded.push((toggles[j].textContent || '').trim());
        }
      }
    }
    out.collapsedLeft = toggles.filter(function (t) { return t.getAttribute('aria-expanded') === 'false'; }).length;
    return out;
  }

  function getSessionInfo() {
    var out = { sessionId: null, sessionTitle: null, titleSource: null };
    var i, j, nodes, t;
    var el = document.querySelector('[data-active-session-id]');
    if (el) out.sessionId = el.getAttribute('data-active-session-id');
    if (!out.sessionId) {
      var act = document.querySelector('[aria-current="true"][data-session-id], [aria-current="page"][data-session-id], .active[data-session-id], .selected[data-session-id]');
      if (act) out.sessionId = act.getAttribute('data-session-id');
    }
    if (!out.sessionId) {
      // 会话容器（本机实测：主内容区大容器带 data-session-id；取可见面积最大的）
      nodes = document.querySelectorAll('[data-session-id]');
      var best = null, bestArea = 0;
      for (i = 0; i < nodes.length; i++) {
        if (!isVisible(nodes[i])) continue;
        var rr = nodes[i].getBoundingClientRect();
        var area = rr.width * rr.height;
        if (area > bestArea) { bestArea = area; best = nodes[i]; }
      }
      if (best) out.sessionId = best.getAttribute('data-session-id');
    }
    var sels = ['[data-active-session-title]', '[aria-current="true"]', '[aria-current="page"]', '.active', '.selected', '[data-state="active"]'];
    for (i = 0; i < sels.length && !out.sessionTitle; i++) {
      nodes = document.querySelectorAll(sels[i]);
      for (j = 0; j < nodes.length; j++) {
        t = normText(nodes[j].textContent);
        if (t && t.length <= 80 && isVisible(nodes[j])) { out.sessionTitle = t; out.titleSource = sels[i]; break; }
      }
    }
    if (!out.sessionTitle) {
      nodes = document.querySelectorAll('header h1, header h2, main h1, main h2, [class*="session-title" i], [class*="chat-title" i]');
      for (i = 0; i < nodes.length; i++) {
        t = normText(nodes[i].textContent);
        if (t && t.length <= 80 && isVisible(nodes[i])) { out.sessionTitle = t; out.titleSource = 'heading'; break; }
      }
    }
    try {
      var dt = normText((document.title || '').replace(/\\s*[-\\u2013\\u2014|]\\s*ZCode\\s*$/i, ''));
      if (dt) {
        out.docTitle = dt;
        // 本机实测 docTitle 恒为 "ZCode"（无会话名），跳过这种过泛兜底
        if (!out.sessionTitle && dt.length <= 80 && dt.toLowerCase() !== 'zcode') { out.sessionTitle = dt; out.titleSource = 'doc-title'; }
      }
    } catch (e) { /* ignore */ }
    // 新建会话（还没有 sidebar 条目）：sessionId 无意义，项目来自 composer 顶部的项目 chip
    if (document.querySelector('[data-testid="chat-empty"]')) {
      out.newConversation = true;
      var wsTrigger = document.querySelector('[data-testid="composer-workspace-trigger"]');
      var wsName = wsTrigger ? normText(wsTrigger.textContent) : '';
      out.draftProjectName = wsName || null;
      out.sessionId = null;
      out.sessionTitle = null;
      out.workspaceName = (wsName && wsName !== '选择项目') ? wsName : null;
      out.projectId = null;
      var sec2 = wsName ? [].slice.call(document.querySelectorAll('section[data-project-name]')).filter(function (s) { return normText(s.getAttribute('data-project-name')) === wsName; })[0] : null;
      if (sec2) {
        out.projectId = sec2.getAttribute('data-project-id');
        var li2 = sec2.querySelector('li[data-task-item-key]');
        if (li2) {
          var k2 = li2.getAttribute('data-task-item-key');
          var i2 = k2.lastIndexOf(':');
          if (i2 > 1) out.workspacePath = k2.slice(0, i2);
        }
      }
      out.workspacePath = out.workspacePath || null;
      return out;
    }
    // 项目信息全部来自 DOM：li 所在的 section[data-project-id] 带 id / name / host
    var li = out.sessionId ? document.querySelector('[data-testid="task-item-' + out.sessionId + '"]') : null;
    var sec = li && li.closest ? li.closest('section[data-project-id]') : null;
    out.projectId = sec ? sec.getAttribute('data-project-id') : null;
    out.workspacePath = workspaceOfSession(out.sessionId);
    out.workspaceName = (sec && sec.getAttribute('data-project-name')) || currentProjectName() || workspaceNameOf(out.workspacePath);
    return out;
  }

  // ---------- 指令/建议弹层探测（/ 命令列表、@ 引用等，实测见 logs/dom/command-list-*.json） ----------
  // 弹层：div[role="listbox"][aria-label="命令与能力"]，选项 button[role="option"][data-testid="prompt-suggestion-option-…"]
  // 弹层打开时 Enter 是"选中指令"，必须放行给 app，不能当提交截获。
  function suggestionsOpen() {
    var lb = document.querySelector('[role="listbox"][aria-label="命令与能力"]');
    if (lb && isVisible(lb)) return true;
    var opt = document.querySelector('[data-testid^="prompt-suggestion-option-"]');
    if (opt && isVisible(opt)) return true;
    return false;
  }

  // ---------- 滤网（入）：模型不可用 / 满载时暂存，其余一律放行 ----------
  // 放行 = 不 preventDefault，ZCode 原生发送（零延迟、零风险）。
  // 判定用 helper 每 2s 推送的 ZFH.capacity（同步读，不能 await）。
  function shouldHold() {
    if (ZFH.helperPaused) return false;         // 暂停助手：不记录，直接放行
    var cap = ZFH.capacity || {};
    if (cap.outputPaused) return true;          // 消息阻断：一律暂存（不输出）
    if (cap.modelOk === false) return true;     // 模型不可用 → 暂存（等模型）
    var limit = cap.limit || 2;
    if (cap.currentWorking) return false;       // 本会话已在工作 → ZCode 自己排队
    return (cap.working || 0) >= limit;         // 满载 → 暂存（等名额）
  }
  function holdReason() {
    var cap = ZFH.capacity || {};
    if (cap.outputPaused) return 'output';
    return cap.modelOk === false ? 'model' : 'quota';
  }
  // 注入侧 Enter（回放/排空）带 1.5s 标记：放行一次，避免被自己截获
  function isInjected() {
    if (ZFH.injectingUntil && Date.now() < ZFH.injectingUntil) { ZFH.injectingUntil = 0; return true; }
    return false;
  }
  // ---- 附件（路径优先；粘贴类无路径 → data URL 兜底）----
  ZFH.fileStash = [];
  function stashFiles(files) {
    if (!files || !files.length) return;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      ZFH.fileStash.push({ f: f, name: f.name || null, size: f.size || 0, type: f.type || null, t: Date.now() });
    }
    if (ZFH.fileStash.length > 20) ZFH.fileStash = ZFH.fileStash.slice(-20);
  }
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.tagName === 'INPUT' && t.type === 'file' && t.files) stashFiles(t.files);
  }, true);
  document.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) stashFiles(e.dataTransfer.files);
  }, true);
  document.addEventListener('paste', function (e) {
    if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length) stashFiles(e.clipboardData.files);
  }, true);

  /** File → 原始绝对路径（ZCode 页面暴露了 Electron 的 getPathForFile） */
  function pathOfFile(f) {
    try {
      if (window.zcode && typeof window.zcode.getPathForFile === 'function') {
        var p2 = window.zcode.getPathForFile(f);
        return p2 || null;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /** 读当前输入框里的附件：{kind,name,path,size,mime}；无路径（粘贴）→ 读成 data URL */
  /** 附件卡片上的文件名：图片取 img[alt]，文件取第一个带 title 的 span（如「a.zip」） */
  function attachmentName(chip, kind, img) {
    if (kind === 'image' && img && img.getAttribute('alt')) return img.getAttribute('alt');
    var titled = chip.querySelector('span[title]');
    if (titled && titled.getAttribute('title')) return titled.getAttribute('title').trim();
    var spans = chip.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
      var t = String(spans[i].textContent || '').trim();
      if (t && /\.[a-z0-9]{1,8}$/i.test(t)) return t;
    }
    return null;
  }

  /** 读当前输入框里的附件：{kind,name,path,size,mime}；无路径（粘贴）→ 读成 data URL */
  ZFH.readAttachments = function () {
    var row = document.querySelector('[data-composer-file-attachments-row]');
    if (!row) return Promise.resolve([]);
    var chips = [].slice.call(row.querySelectorAll('[data-testid^="v4-attachment-"]'));
    return Promise.all(chips.map(function (chip) {
      var kind = chip.getAttribute('data-composer-attachment-kind') || 'file';
      var img = chip.querySelector('img');
      var vid = chip.querySelector('video');
      var name = attachmentName(chip, kind, img);
      // 只有图片缩略图 / 视频才是真内容；文件类型的 img 是 material 图标，不能当内容
      var src = null;
      if (kind === 'image' && img && img.getAttribute('alt')) src = img.getAttribute('src');
      else if (kind === 'video' && vid) src = vid.getAttribute('src');
      var hit = null;
      for (var i = ZFH.fileStash.length - 1; i >= 0; i--) {
        var st = ZFH.fileStash[i];
        if (name && st.name === name) { hit = st; break; }
      }
      var out2 = {
        kind: kind,
        name: name || (hit && hit.name) || null,
        path: hit ? pathOfFile(hit.f) : null,
        size: hit ? hit.size : null,
        mime: hit ? hit.type : null
      };
      if (out2.path) return Promise.resolve(out2);
      if (!src || src.indexOf('blob:') !== 0) {
        out2.unresolved = true;   // 没有原始文件对象、也没有 blob：无法还原（回放时明确报错）
        return Promise.resolve(out2);
      }
      // 粘贴类：没有原始文件，把字节转成 data URL 存进队列
      return fetch(src).then(function (r) {
        var len = Number(r.headers.get('content-length') || 0);
        if (len > 20 * 1024 * 1024) { out2.tooLarge = true; out2.size = len; return out2; }
        return r.blob().then(function (b) {
          return new Promise(function (res2) {
            var fr = new FileReader();
            fr.onload = function () {
              out2.dataUrl = String(fr.result || '');
              out2.size = b.size;
              out2.mime = b.type || out2.mime;
              if (!out2.name) out2.name = 'pasted-' + Date.now() + '.' + ((b.type || '').split('/')[1] || 'bin');
              res2(out2);
            };
            fr.onerror = function () { out2.unresolved = true; res2(out2); };
            fr.readAsDataURL(b);
          });
        });
      }).catch(function () { out2.unresolved = true; return out2; });
    }));
  };

  /** 清掉输入框里的所有附件（截获入队后调用） */
  ZFH.clearAttachments = function () {
    var btns = [].slice.call(document.querySelectorAll('button[data-composer-attachment-remove]'));
    for (var i = 0; i < btns.length; i++) { try { btns[i].click(); } catch (e) { /* ignore */ } }
    return btns.length;
  };

  function interceptSubmit(reason) {
    var c = findComposer();
    if (!c || isComposerEmpty(c)) return;
    var text = composerText(c);
    var info = getSessionInfo();
    var reason2 = reason;
    ZFH.readAttachments().then(function (atts) {
      report({ type: 'capture', text: text, reason: reason2, holdReason: holdReason(), session: info, attachments: atts || [] });
      if (atts && atts.length) ZFH.clearAttachments();
    });
    // 清空交给 helper 用 CDP 真实按键做（页面内 execCommand 对 Lexical 无效，实测内容会留着）
  }
  function onKeyDown(e) {
    if (ZFH.disabled) return;
    if (ZFH.mode !== 'recording') return;
    if (isInjected()) return;
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.isComposing || e.keyCode === 229) return; // 中文输入法组合键不拦截
    var c = findComposer();
    if (!c) return;
    if (!(e.target === c || c.contains(e.target))) return;
    // 指令/建议列表开着：这个 Enter 是"选中指令"，放行给 app（不截获、不清空）
    if (suggestionsOpen()) {
      report({ type: 'enter-passthrough', reason: 'suggestions-open' });
      return;
    }
    if (!shouldHold()) return;                   // 滤网放行：交给 ZCode 原生发送
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
    interceptSubmit('enter');
  }
  function onClickCapture(e) {
    if (ZFH.disabled) return;
    if (ZFH.mode !== 'recording') return;
    if (isInjected()) return;
    var btn = findSendButton();
    if (!btn) return;
    if (!(e.target === btn || btn.contains(e.target))) return;
    var c = findComposer();
    if (!c) return;
    if (!shouldHold()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
    interceptSubmit('button');
  }
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('click', onClickCapture, true);

  /** 误注入到别的应用时用：撤掉灯条、摘掉监听，之后所有钩子都是空操作 */
  ZFH.teardown = function () {
    ZFH.disabled = true;
    try { window.removeEventListener('keydown', onKeyDown, true); } catch (e) {}
    try { window.removeEventListener('click', onClickCapture, true); } catch (e) {}
    try { var el = document.getElementById('zfh-lightbar'); if (el) el.remove(); } catch (e) {}
  };
  window.__zfhTeardown = ZFH.teardown;

  // ---------- 快照读取（helper 周期调用；变化判定在 helper 侧） ----------
  function snapshot() {
    var c = findComposer();
    return {
      text: c ? composerText(c) : null,
      composerFound: !!c,
      session: getSessionInfo(),
      mode: ZFH.mode
    };
  }
  ZFH.snapshot = snapshot;
  ZFH.getSessionInfo = getSessionInfo;
  ZFH.workspaceOfSession = workspaceOfSession;
  ZFH.workspaceNameOf = workspaceNameOf;
  ZFH.currentProjectName = currentProjectName;
  ZFH.expandProject = expandProject;

  // ---------- 模式切换（helper 唯一写者） ----------
  ZFH.setMode = function (mode) {
    if (ZFH.mode === mode) return ZFH.mode;
    ZFH.mode = mode;
    ZFH.lastModeFlip = Date.now();
    report({ type: 'mode-ack', mode: mode });
    return ZFH.mode;
  };

  // ---------- 模型可用性探针（VM 实测修复 #1：主判定信号，纯 DOM 读零消耗） ----------
  // 负信号：无模型横幅文案（VM 实测原文，HANDOFF §2）；正信号：模型名出现在选择器/按钮等小元素。
  // 聊天正文不会命中：正信号只扫小文本（<=60 字符）的 button/[class*=model]/aria-label 候选。
  var NEG_PHRASES = ['无可用模型', '没有可用模型', '请开通编程套餐', '配置自定义模型', 'no available model'];
  var MODEL_TOKENS = ['GLM-', 'DeepSeek', 'Kimi', 'Qwen', 'Claude', 'GPT-', 'MiniMax', 'Doubao', 'doubao', 'Hunyuan', 'hunyuan', 'Gemini', 'gemini', 'Ernie', 'ernie'];
  ZFH.probeModel = function (fixedModelId) {
    var i, j, el, t, nodes;
    // 2026-11-23 实测（免费期结束）：额度用完时先出现"额度已用完，请切换到 Coding Plan"横幅，
    // 但**模型菜单里的模型仍然可选、不置灰**，约 3 分钟后 ZCode 才自己翻成「管理模型」+ 报错横幅。
    // 所以这条无 data-error-code 的横幅必须单独认，否则中间 3 分钟会误判"可用"。
    var quota = document.querySelector('[data-testid="v4-session-quota-banner"]');
    if (quota && isVisible(quota)) {
      var qt = normText(quota.textContent);
      if (/额度已用完|切换到 Coding Plan|暂无可用|额度不足|wait for quota/i.test(qt)) {
        return { unavailable: true, evidence: 'quota-banner: ' + qt.slice(0, 60) };
      }
    }
    // 最强信号：composer 工具栏的模型选择触发器（实测 data-testid="chat-model-select-trigger"）。
    // 实测两态（logs/dom/composer-*.json 有完整快照）：
    //   无 plan：文本「管理模型」，无 data-model-current-value / aria-haspopup
    //   有 plan：文本「GLM-5.3-Flash最高」，带 data-model-current-value="custom:account%3A...:GLM-5.3-Flash"、
    //            aria-haspopup="menu"、data-state="closed"（下拉菜单触发器）
    var trigger = document.querySelector('[data-testid="chat-model-select-trigger"]');
    if (trigger) {
      var tt = normText(trigger.textContent);
      var cur = trigger.getAttribute('data-model-current-value');
      // 2026-11-21 实测：模型恢复可用、会话残留旧态时，可见文本仍是「选择模型」，
      // 但重新选中后 data-model-current-value 已回填 —— 文本不可信，value 优先。
      if (cur) {
        var modelId = null;
        try { modelId = decodeURIComponent(cur).split(':').pop() || null; } catch (e) { modelId = null; }
        return { unavailable: false, modelHint: (tt || cur).slice(0, 60), modelId: modelId, source: 'model-current-value' };
      }
      if (tt) {
        for (j = 0; j < NEG_PHRASES.length; j++) {
          if (tt.indexOf(NEG_PHRASES[j]) >= 0) return { unavailable: true, evidence: tt.slice(0, 60) };
        }
        // 第一层：管理模型 = 没有可用列表
        if (tt.indexOf('管理模型') >= 0 || tt.indexOf('添加模型') >= 0) {
          return { unavailable: true, evidence: 'manage-model' };
        }
        // 第二层：选择模型 = 有列表但本会话没选；列表里有没有白名单模型由 helper 核验后写回 capacity.modelOk
        if (tt.indexOf('选择模型') >= 0) {
          var listOk = ZFH.capacity && ZFH.capacity.modelOk === true;
          return listOk
            ? { unavailable: false, modelHint: tt.slice(0, 60), modelId: null, source: 'model-trigger-list-ok' }
            : { unavailable: true, evidence: 'select-model' };
        }
      }
      // value 为空 + ZCode 的"模型不可用"错误横幅：陈旧残留态的强信号
      var stale = document.querySelector('[data-testid="chat-error-banner"][data-error-code="ZCODE_RUNTIME_MODEL_UNAVAILABLE"]');
      if (stale && isVisible(stale)) return { unavailable: true, evidence: 'error-banner:model-unavailable' };
      if (tt) return { unavailable: false, modelHint: tt.slice(0, 60), modelId: null, source: 'model-trigger' };
      // 没有可用触发器文本：只认错误横幅
      var stale2 = document.querySelector('[data-testid="chat-error-banner"][data-error-code="ZCODE_RUNTIME_MODEL_UNAVAILABLE"]');
      if (stale2 && isVisible(stale2)) return { unavailable: true, evidence: 'error-banner:model-unavailable' };
    }
    var negSels = '[role="alert"],[role="status"],[class*="error" i],[class*="warn" i],[class*="banner" i],[class*="empty" i],[class*="notice" i]';
    nodes = document.querySelectorAll(negSels);
    for (i = 0; i < nodes.length; i++) {
      el = nodes[i];
      if (!isVisible(el)) continue;
      t = normText(el.textContent);
      if (!t || t.length > 200) continue;
      for (j = 0; j < NEG_PHRASES.length; j++) {
        if (t.indexOf(NEG_PHRASES[j]) >= 0) return { unavailable: true, evidence: t.slice(0, 100) };
      }
    }
    var posSels = 'button,[role="button"],[class*="model" i],[aria-label*="model" i],[aria-label*="模型"]';
    nodes = document.querySelectorAll(posSels);
    for (i = 0; i < nodes.length; i++) {
      el = nodes[i];
      if (!isVisible(el)) continue;
      t = normText(el.textContent);
      if (!t || t.length > 60) continue;
      var hit = !!fixedModelId && t.indexOf(fixedModelId) >= 0;
      if (!hit) {
        for (j = 0; j < MODEL_TOKENS.length; j++) { if (t.indexOf(MODEL_TOKENS[j]) >= 0) { hit = true; break; } }
      }
      if (hit) return { unavailable: false, modelHint: t.slice(0, 60) };
    }
    return { unavailable: false, modelHint: null };
  };

  // ---------- DOM 结构诊断（选择器失配时的证据采集，供 VM 测试回传适配层更新） ----------
  ZFH.debugDom = function () {
    var out = [];
    var sels = '[role="option"],[role="listitem"],[role="menuitem"],[role="treeitem"],[data-session-id],aside li,nav li,nav a,[class*="session" i],[class*="conversation" i],[class*="chat-item" i]';
    var nodes = document.querySelectorAll(sels);
    for (var i = 0; i < nodes.length && out.length < 60; i++) {
      var el = nodes[i];
      var r = el.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) continue;
      out.push({
        tag: el.tagName,
        id: el.id || undefined,
        cls: (typeof el.className === 'string' && el.className) ? el.className.slice(0, 80) : undefined,
        role: el.getAttribute('role') || undefined,
        sid: el.getAttribute('data-session-id') || undefined,
        text: normText(el.textContent).slice(0, 60),
        x: Math.round(r.x), y: Math.round(r.y)
      });
    }
    return { title: document.title, count: out.length, nodes: out };
  };

  // ---------- 灯条（ZCode 内右侧常显小面板：所有实时状态都在这里） ----------
  var LB = { ok: '#30a46c', wait: '#f5a524', paused: '#8b8d98', off: '#e5484d' };
  var LB_TEXT = { ok: '助手工作中', wait: '限额缓冲', 'output-paused': '消息阻断', 'helper-paused': '助手已暂停' };
  var LB_COLOR = { ok: LB.ok, wait: LB.wait, 'output-paused': LB.off, 'helper-paused': LB.paused };
  var DOCK_MARGIN = 10;
  var DOCK_SNAP = 100;

  function escHtml(t) {
    return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function barPos() {
    try { return JSON.parse(localStorage.getItem('zfh-lightbar-pos') || 'null'); } catch (e) { return null; }
  }
  function clampBar(el, x, y) {
    var w = el.offsetWidth || 144;
    var h = el.offsetHeight || 96;
    var maxX = Math.max(8, window.innerWidth - w - 8);
    var maxY = Math.max(8, window.innerHeight - h - 8);
    return { x: Math.max(8, Math.min(maxX, x)), y: Math.max(8, Math.min(maxY, y)) };
  }
  function applyBarPos(el, p) {
    if (!p || typeof p.x !== 'number') {
      // 旧版本存的是 {side, top} 之类的格式：视为未保存，顺手清掉，避免反复走错分支
      try { if (p) localStorage.removeItem('zfh-lightbar-pos'); } catch (e) { /* ignore */ }
      el.style.left = 'auto'; el.style.right = '10px'; el.style.top = '50%'; el.style.transform = 'translateY(-50%)';
      return;
    }
    el.style.transform = 'none';
    el.style.right = 'auto';
    el.style.left = Math.round(p.x) + 'px';
    el.style.top = Math.round(p.y) + 'px';
  }
  /** 锚点名 → 目标坐标（边锚点只固定一个轴，另一轴传 null 表示保持当前值） */
  function anchorPos(el, anchor) {
    var W = window.innerWidth, H = window.innerHeight;
    var w = el.offsetWidth || 144, h = el.offsetHeight || 96, m = DOCK_MARGIN;
    switch (anchor) {
      case 'tl': return { x: m, y: m };
      case 'tr': return { x: W - w - m, y: m };
      case 'bl': return { x: m, y: H - h - m };
      case 'br': return { x: W - w - m, y: H - h - m };
      case 'left': return { x: m, y: null };
      case 'right': return { x: W - w - m, y: null };
      case 'top': return { x: null, y: m };
      case 'bottom': return { x: null, y: H - h - m };
      default: return null;
    }
  }
  /** 八向吸附：四角优先，其次四边；距离阈值 100px，超过则留在原地 */
  function dockBar(el) {
    var r = el.getBoundingClientRect();
    var W = window.innerWidth, H = window.innerHeight, w = r.width, h = r.height, m = DOCK_MARGIN;
    var corners = [
      { a: 'tl', x: m, y: m },
      { a: 'tr', x: W - w - m, y: m },
      { a: 'bl', x: m, y: H - h - m },
      { a: 'br', x: W - w - m, y: H - h - m }
    ];
    var edges = [
      { a: 'left', x: m, y: r.top },
      { a: 'right', x: W - w - m, y: r.top },
      { a: 'top', x: r.left, y: m },
      { a: 'bottom', x: r.left, y: H - h - m }
    ];
    function nearest(list) {
      var best = null, bd = Infinity;
      for (var i = 0; i < list.length; i++) {
        var d = Math.hypot(list[i].x - r.left, list[i].y - r.top);
        if (d < bd) { bd = d; best = list[i]; }
      }
      return { d: bd, p: best };
    }
    var c = nearest(corners), e = nearest(edges);
    var mode, anchor, pos;
    if (c.d <= DOCK_SNAP) { mode = 'corner'; anchor = c.p.a; pos = clampBar(el, c.p.x, c.p.y); }
    else if (e.d <= DOCK_SNAP) { mode = 'edge'; anchor = e.p.a; pos = clampBar(el, e.p.x, e.p.y); }
    else { mode = 'free'; anchor = null; pos = clampBar(el, r.left, r.top); }
    applyBarPos(el, pos);
    try {
      localStorage.setItem('zfh-lightbar-pos', JSON.stringify({ mode: mode, anchor: anchor, x: Math.round(pos.x), y: Math.round(pos.y) }));
    } catch (e2) { /* ignore */ }
  }

  function ensureLightBar() {
    var el = document.getElementById('zfh-lightbar');
    if (el && document.body.contains(el)) {
      if (el.getAttribute('data-zfh-ver') === ZFH.version) return el;
      el.parentNode.removeChild(el); // 旧构建留下的灯条（样式/事件可能不同）：删掉重建
      el = null;
    }
    el = document.createElement('div');
    el.id = 'zfh-lightbar';
    el.setAttribute('data-zfh-ver', ZFH.version);
    el.style.cssText = 'position:fixed;z-index:2147483647;right:10px;top:50%;transform:translateY(-50%);' +
      'box-sizing:border-box;width:184px;padding:9px 11px;border-radius:12px;background:rgba(28,28,32,.92);color:#f2f2f5;' +
      'font:12px/1.55 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);' +
      'border:1px solid rgba(255,255,255,.08);user-select:none;cursor:pointer;';
    el.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">' +
        '<span class="lb-dot" style="width:8px;height:8px;border-radius:50%;display:inline-block;background:#8b8d98;"></span>' +
        '<span class="lb-state">输出中</span></div>' +
      '<div class="lb-rows"></div>' +
      '<div class="lb-pending" style="display:none;gap:5px;margin-top:6px;opacity:.72;font-size:11px;line-height:1.45;">' +
        '<span style="flex:none;">⏳</span>' +
        '<span class="lb-pending-text" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;"></span>' +
      '</div>';
    el.title = 'zcode-helper';
    el.style.cursor = 'grab';

    // 拖动 + 八向吸附：pointerup 时按距离吸附，位置存 localStorage
    var drag = null;
    var startLeft = 0, startTop = 0;
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var r = el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
      startLeft = r.left; startTop = r.top;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件可能失败 */ }
      el.style.cursor = 'grabbing';
      e.preventDefault();
    });
    el.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var left = e.clientX - drag.dx;
      var top = e.clientY - drag.dy;
      if (Math.abs(left - startLeft) > 3 || Math.abs(top - startTop) > 3) drag.moved = true;
      if (!drag.moved) return;
      el.style.transform = 'none';
      el.style.right = 'auto';
      el.style.left = Math.round(left) + 'px';
      el.style.top = Math.round(top) + 'px';
    });
    el.addEventListener('pointerup', function (e) {
      if (!drag) return;
      var moved = drag.moved;
      drag = null;
      el.style.cursor = 'grab';
      try { el.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (moved) dockBar(el);
      else report({ type: 'toggle-panel' });
    });
    window.addEventListener('resize', function () {
      if (drag) return;
      var p = barPos();
      var r = el.getBoundingClientRect();
      // 已吸附（角/边）→ 按锚点重算，窗口变大也继续贴边；free 只夹回可视区
      if (p && p.anchor && (p.mode === 'corner' || p.mode === 'edge')) {
        var t = anchorPos(el, p.anchor);
        if (t) { applyBarPos(el, clampBar(el, t.x == null ? r.left : t.x, t.y == null ? r.top : t.y)); return; }
      }
      var c = clampBar(el, r.left, r.top);
      if (Math.abs(c.x - r.left) > 1 || Math.abs(c.y - r.top) > 1) applyBarPos(el, c);
    });
    document.body.appendChild(el);
    applyBarPos(el, barPos());
    return el;
  }

  function lbRow(k, v, color) {
    return '<div style="display:flex;justify-content:space-between;gap:8px;line-height:1.7;">' +
      '<span style="opacity:.55;flex:none;">' + escHtml(k) + '</span>' +
      '<span style="' + (color ? 'color:' + color + ';' : '') + 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(v) + '</span></div>';
  }

  ZFH.setLightBar = function (p) {
    if (ZFH.disabled) return;
    p = p || {};
    ZFH.capacity = {
      modelOk: p.modelOk,
      working: p.working || 0,
      limit: p.limit || 2,
      currentWorking: !!p.currentWorking,
      outputPaused: !!p.outputPaused
    };
    var el = ensureLightBar();
    // 灯条只存在于受控（CDP 已连接）时：未连接 = 不存在，没有"未受控"灰色状态
    var st = p.state || (p.helperPaused ? 'helper-paused' : (p.outputPaused ? 'output-paused' : ((p.working || 0) >= (p.limit || 2) ? 'wait' : 'ok')));
    var stateText = (st === 'wait' && p.waitReason === 'model') ? '无可用模型' : (LB_TEXT[st] || '助手工作中');
    // 套餐已领取但未到生效时间：直接显示几点生效（来自官方接口的 effective_at）
    if (st === 'wait' && p.waitReason === 'model' && p.planEta > 0) {
      var eta = new Date(Date.now() + p.planEta * 1000);
      var hhmm = ('0' + eta.getHours()).slice(-2) + ':' + ('0' + eta.getMinutes()).slice(-2);
      stateText = '无可用模型 · ' + hhmm + ' 生效';
    }
    el.querySelector('.lb-dot').style.background = LB_COLOR[st] || LB.paused;
    el.querySelector('.lb-state').textContent = stateText;
    var w = p.working || 0, limit = p.limit || 2;
    var rows = '';
    rows += lbRow('工作进程', w + ' / ' + limit, w >= limit ? LB.wait : '');
    rows += lbRow('队列消息', String(p.pending || 0) + (p.drafts ? '（草稿 ' + p.drafts + '）' : ''));
    el.querySelector('.lb-rows').innerHTML = rows;
    var pend = el.querySelector('.lb-pending');
    if (p.currentPending) {
      pend.style.display = 'flex';
      pend.querySelector('.lb-pending-text').textContent = p.currentPending;
    } else {
      pend.style.display = 'none';
    }
    el.style.display = p.conn === 'off' ? 'none' : 'block';
    // 防御：任何原因导致跑到可视区外（窗口缩小/切换显示器）→ 立即夹回
    var rr = el.getBoundingClientRect();
    if (rr.width > 0 && (rr.right > window.innerWidth + 1 || rr.bottom > window.innerHeight + 1 || rr.left < -1 || rr.top < -1)) {
      applyBarPos(el, clampBar(el, rr.left, rr.top));
    }
  };
  // 兼容旧调用（升级冻结/冒烟）
  ZFH.setIndicator = function () { /* 已由灯条取代 */ };

  report({ type: 'boot', version: ZFH.version });
})();
`.trim();
}

module.exports = { bootstrapSource };
