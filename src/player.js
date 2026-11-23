'use strict';
/**
 * player.js — 回放编排（DESIGN.md §5 player / §7 流程 6-7；VM 实测修复 #2/#4/#5）
 * 队列按 workspacePath 分组 → second-instance 打开工作区 →（尽力）定位会话并真实鼠标点击切换 →
 * 聚焦 composer → 清空（暂存内容先"抢救"入队）→ Input.insertText → 真实 Enter → 校验清空 → 标记 sent。
 * 回放开始时 engine 会把注入模式临时切为 playing（拦截放行，否则回放的 Enter 会被自己截获——VM 实测 #2）。
 * 单条失败标记 failed 并中止本轮回放；模型不可用 → 上报 engine 翻回 RECORDING（DESIGN §4 辅助信号）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Player {
  /**
   * @param deps { cdp, supervisor, queue, logger, stateMachine, exprs, hooks }
   *   hooks: { onWorkspaceChange(path) async, onModelUnavailable(), currentWorkspacePath(), zcodeExePath() }
   */
  constructor(deps) {
    this.cdp = deps.cdp;
    this.supervisor = deps.supervisor;
    this.queue = deps.queue;
    this.logger = deps.logger;
    this.stateMachine = deps.stateMachine;
    this.exprs = deps.exprs;
    this.hooks = deps.hooks;
    this.running = false;
    this.abortRequested = false;
    // 轮询/启动延迟（测试可注入更短的值）
    this.timing = { startDelayMs: 300, waitConcurrencyMs: 2000, blockedMs: 3000, ...(deps.timing || {}) };
  }

  get isRunning() { return this.running; }

  abort() {
    if (this.running) this.abortRequested = true;
  }

  /** 手动提交单条（队列窗口"提交"按钮）：不跑调度循环 */
  async replayOne(item, reason) {
    this.logger.log('replay', { action: 'batch-start', reason, total: 1 });
    try { return await this._replayOne(item, reason); }
    finally { this.logger.log('replay', { action: 'batch-end', reason }); }
  }

  /** 草稿"上屏"：切到所属会话 → 清空输入框 → 注入草稿文本（不回车）；成功后 engine 从队列移除 */
  async screenDraft(item, reason) {
    const ctx = { id: item.id, sessionId: item.sessionId, sessionTitle: item.sessionTitle || null, reason };
    try {
      await this._prepareWorkspace(item, ctx);
      if (item.sessionId || item.sessionTitle) await this._switchSession(item, ctx);
      const clr = await this._clearComposer();
      if (!clr.ok) throw new Error(`composer pre-clear failed (${clr.why})`);
      await this.cdp.evaluate(this.exprs.composerFocusSrc, 2000).catch(() => {});
      await this.cdp.insertText(item.text);
      await sleep(150);
      const snap = await this.cdp.evaluate(this.exprs.snapshotSrc, 3000).catch(() => null);
      if (!snap || !((snap.text || '').trim())) throw new Error('insert failed: 草稿没有进输入框');
      this.logger.log('replay', { ...ctx, action: 'draft-screened', text: item.text });
      return { ok: true };
    } catch (e) {
      this.logger.log('replay', { ...ctx, action: 'draft-screen-fail', error: e.message });
      return { ok: false, error: e.message };
    }
  }

  /**
   * 回放调度（FIFO + 两条限制）：
   *  1) 全局最多 2 个 session 同时工作（>=2 就不再发，等有会话结束）；
   *  2) 同一 session 的上一条还在跑，就跳过它、先发后面其它会话的消息（后者事实上"插队"）。
   * 循环直到队列没有 pending 或被 abort；记录/回放状态由 engine 负责翻转。
   */
  async replay(reason) {
    if (this.running) return { started: false, why: 'already-running' };
    if (!this.queue.pendingSubmits().length) return { started: false, why: 'empty' };
    this.running = true;
    this.abortRequested = false;
    await sleep(this.timing.startDelayMs); // 给注入侧 setMode('playing') 留出生效时间（拦截放行）
    this.logger.log('replay', { action: 'batch-start', reason, total: this.queue.pendingItems().length });
    try {
      while (!this.abortRequested) {
        // 防打扰：用户刚在任意程序里动过键鼠 → 整批暂停（发送会切工作区/会话，不能打扰）
        if (this.hooks.userActive && this.hooks.userActive()) {
          this.logger.log('replay', { action: 'idle-paused', reason });
          return { started: true, stopped: 'user-active' };
        }
        const pending = this.queue.pendingSubmits();
        if (!pending.length) break;
        const ctx = { reason };
        const working = await this._workingSessions(ctx);
        if (working.size >= 2) {
          this.logger.log('replay', { action: 'wait-concurrency', working: Array.from(working) });
          await sleep(this.timing.waitConcurrencyMs);
          continue;
        }
        let sentAny = false;
        let fatal = false;
        for (const item of pending) {
          if (this.abortRequested) break;
          if (working.size >= 2) break;
          // 该会话的上一条还在跑：跳过，先处理后面其它会话的（插队）
          if (item.sessionId && working.has(item.sessionId)) continue;
          // 防打扰：每个条目前都查一次（用户可能刚开始打字）
          if (this.hooks.userActive && this.hooks.userActive()) {
            this.logger.log('replay', { action: 'idle-paused', itemId: item.id });
            return { started: sentAny, stopped: 'user-active' };
          }
          const r = await this._replayOne(item, reason);
          if (r && r.sent) {
            sentAny = true;
            if (item.sessionId) working.add(item.sessionId);
          }
          if (r && r.busy && item.sessionId) working.add(item.sessionId);
          if (r && r.fatal) { fatal = true; break; }
        }
        if (fatal) {
          this.logger.log('replay', { action: 'batch-abort', reason: 'fatal-failure' });
          break;
        }
        if (!sentAny && !this.abortRequested) await sleep(this.timing.blockedMs); // 全被阻塞：等一轮再消点
      }
    } finally {
      this.running = false;
      this.logger.log('replay', { action: 'batch-end', reason });
    }
    return { started: true };
  }

  /** 切工作区（second-instance 转发路径）；随后 engine 钩子负责重扫 target/重绑注入 */
  /** 切到条目所属工作区：优先用条目记录的路径，没有则从会话元数据补全（跨 workspace 回放） */
  async _prepareWorkspace(item, ctx) {
    const wsPath = item.workspacePath;
    if (wsPath) {
      try { await this._ensureWorkspace(wsPath); }
      catch (e) { throw new Error(`workspace switch failed: ${e.message}`); }
    }
  }

  async _ensureWorkspace(workspaceKey) {
    if (workspaceKey === '__current__') return;
    const current = this.hooks.currentWorkspacePath();
    if (current && samePath(current, workspaceKey)) return;
    const exe = this.hooks.zcodeExePath();
    this.supervisor.openWorkspace(exe, workspaceKey);
    await sleep((this.timing && this.timing.workspaceOpenMs) || 1500);
    await this.hooks.onWorkspaceChange(workspaceKey); // 重扫 targets、必要时重连、重注入
    await sleep((this.timing && this.timing.workspaceSettleMs) || 800);
  }

  /** 目标会话必须先在侧栏可见：项目被"收起"时其会话 li 会从 DOM 里消失 → 先展开项目再找 */
  /** 侧边栏被折叠时先展开（收起后侧栏宽度只剩几像素，会话/项目都点不到） */
  async _ensureSidebar(ctx) {
    const st = await this.cdp.evaluate(this.exprs.sidebarStateSrc, 2000).catch(() => null);
    if (!st || st.expanded || !st.toggle) return !!(st && st.expanded);
    this.logger.log('replay', { ...ctx, action: 'sidebar-expand', asideW: st.asideW, listW: st.listW });
    await this.cdp.dispatchClick(st.toggle.x, st.toggle.y);
    await sleep(600);
    const again = await this.cdp.evaluate(this.exprs.sidebarStateSrc, 2000).catch(() => null);
    if (again && !again.expanded && again.toggle) {
      await this.cdp.dispatchClick(again.toggle.x, again.toggle.y);
      await sleep(600);
    }
    const final = await this.cdp.evaluate(this.exprs.sidebarStateSrc, 2000).catch(() => null);
    return !!(final && final.expanded);
  }

  async _ensureSessionVisible(item, ctx) {
    await this._ensureSidebar(ctx);
    const sid = item.sessionId;
    if (!sid) return true;
    const rect = async () => this.cdp.evaluate(
      this.exprs.sessionItemRectSrc.replace('__SID__', JSON.stringify(sid)), 3000).catch(() => null);
    let r = await rect();
    if (r && r.ok) return true;
    // 优先用 projectId 精确定位（section[data-project-id]），其次项目名，最后路径末段
    const name = item.projectId
      || item.workspaceName
      || (item.workspacePath ? String(item.workspacePath).split(/[\\/]+/).filter(Boolean).pop() : '');
    const ex = await this.cdp.evaluate(
      this.exprs.expandProjectSrc.replace('__NAME__', JSON.stringify(name)), 4000).catch(() => null);
    if (ex && ex.expanded && ex.expanded.length) {
      this.logger.log('replay', {
        ...ctx, action: 'expand-project', project: name || null,
        expanded: ex.expanded, matched: !!ex.matched, fallback: !!ex.fallback
      });
      await sleep(500);
      r = await rect();
    }
    if (r && r.ok) return true;
    this.logger.log('replay', { ...ctx, action: 'session-not-visible', project: name || null, why: (r && r.why) || 'not-found' });
    return false;
  }

  /** 按 sid 精确点击会话列表项（切会话/消点用） */
  async _clickSessionItem(sid) {
    if (!sid) return false;
    const r = await this.cdp.evaluate(
      this.exprs.sessionItemRectSrc.replace('__SID__', JSON.stringify(sid)), 3000).catch(() => null);
    if (!r || !r.ok) return false;
    await this.cdp.dispatchClick(Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2));
    return true;
  }

  /**
   * 当前打开的会话是否在工作：直接读 chat-loading（最可靠，实测侧栏可能只显示未读点）。
   * 返回 true/false/null（页面无信号）。
   */
  async _currentSessionWorking() {
    const cl = await this.cdp.evaluate(this.exprs.chatLoadingSrc, 2000).catch(() => null);
    if (!cl) return null;
    return !!cl.working;
  }

  /** 判断某个 sid 是否在工作：当前会话读 chat-loading；其它会话只看侧栏 spinner（不再点会话消点） */
  async _sessionWorking(sid) {
    if (!sid) return null;
    const snap = await this.cdp.evaluate(this.exprs.snapshotSrc, 2000).catch(() => null);
    const current = (snap && snap.session && snap.session.sessionId) || null;
    if (sid === current) return this._currentSessionWorking();
    const list = await this.cdp.evaluate(this.exprs.sessionStatesSrc, 2500).catch(() => null);
    const it = (list || []).find(x => x.sid === sid);
    if (!it) return null;
    return !!it.working;
  }

  /**
   * 工作中会话集合（并发闸门用）——与灯条「工作进程」同源：
   *   侧栏 spinner 计 working；当前打开的会话额外读 chat-loading（侧栏可能只显示未读点）。
   * 不再"点会话消点"：那会抢用户窗口，而且会把带未读点的会话误算成 working（2026-11-21 实测卡死）。
   */
  async _workingSessions() {
    const list = await this.cdp.evaluate(this.exprs.sessionStatesSrc, 3000).catch(() => null);
    const working = new Set((list || []).filter(x => x && x.working).map(x => x.sid));
    const snap = await this.cdp.evaluate(this.exprs.snapshotSrc, 2500).catch(() => null);
    const current = (snap && snap.session && snap.session.sessionId) || null;
    if (current) {
      const cl = await this.cdp.evaluate(this.exprs.chatLoadingSrc, 2000).catch(() => null);
      if (cl && cl.working) working.add(current);
      else working.delete(current); // 侧栏 spinner 可能残留
    }
    return working;
  }


  /** 发送后确认该会话确实开跑了（防止"下一条同会话消息"在真正开跑前就被放行） */
  /** 发送后 3 秒内是否新出现"模型不可用/额度"横幅；出现即视为本条失败 */
  async _detectBlockingBanner(before, ctx) {
    const sig = b => ((b && b.quota) || '') + '|' + ((b && b.model) || '');
    const beforeSig = sig(before);
    for (let i = 0; i < 4; i++) {
      await sleep(700);
      const now = await this.cdp.evaluate(this.exprs.quotaBannerSrc, 2000).catch(() => null);
      if (!now) continue;
      if (sig(now) === beforeSig) continue;
      const text = now.model || now.quota || '';
      if (!text) continue;
      return 'model-unavailable: ' + String(text).replace(/\s+/g, ' ').slice(0, 80);
    }
    return null;
  }

  async _confirmStarted(sid, ctx) {
    if (!sid) return;
    for (let i = 0; i < 15; i++) {
      await sleep(1500);
      const w = await this._sessionWorking(sid, ctx);
      if (w === true) { this.logger.log('replay', { ...ctx, action: 'session-started', sid }); return; }
      if (w === null) return;
    }
    this.logger.log('replay', { ...ctx, action: 'session-not-started', sid, note: '20s 内未见 working（秒回或被拦）' });
  }

  /** 定位并真实点击切换会话；切换后用容器 data-session-id / 标题验证，失败重试一次 */
  /** 在条目记录的项目下新建会话并等到它就绪（空会话 + 项目 chip 对上） */
  async _openNewSession(item, ctx) {
    await this._ensureSidebar(ctx);
    // 「选择项目」= 任务分区（不属于任何工程），走任务分区的「新建任务」
    const name = item.draftProjectName || item.workspaceName || '选择项目';
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.cdp.evaluate(this.exprs.openProjectNewTaskSrc(name), 3000).catch(() => null);
      this.logger.log('replay', { ...ctx, action: 'new-session-open', attempt: attempt + 1, result: r && { ok: r.ok, why: r.why } });
      if (r && r.expanded) { await sleep(400); continue; }
      if (r && r.ok) {
        await this.cdp.dispatchClick(r.x, r.y);
        // 等空会话就绪
        for (let i = 0; i < 40; i++) {
          await sleep(150);
          const st = await this.cdp.evaluate(this.exprs.newSessionReadySrc(name), 2500).catch(() => null);
          if (st && st.empty && (st.match || name === '选择项目' || !name)) {
            this.logger.log('replay', { ...ctx, action: 'new-session-ready', project: name, sid: st.sid });
            return true;
          }
        }
        this.logger.log('replay', { ...ctx, action: 'new-session-not-ready', project: name });
      }
      await sleep(300);
    }
    return false;
  }

  /** 把条目里的附件塞回输入框（隐藏 file input + CDP setFileInputFiles），等全部 ready */
  async _attachFiles(item, ctx) {
    const all = (item.attachments || []).filter(Boolean);
    if (!all.length) return true;
    // 拿不到原始路径/字节 = 还原不了：明确失败，绝不静默少发附件
    const unresolved = all.filter(a => !a.path && !a.dataUrl);
    if (unresolved.length) {
      const names = unresolved.map(a => a.name || '未命名附件').join('、');
      this.logger.log('replay', { ...ctx, action: 'attachment-unresolved', names });
      throw new Error(`attachment-unresolved: 附件「${names}」没有原始路径，无法还原（消息未提交）`);
    }
    const list = all;
    const cur = await this.cdp.evaluate(this.exprs.attachmentsStateSrc, 2000).catch(() => null);
    if (cur && cur.total >= list.length) return true; // 已经在了（重试场景）
    const files = [];
    for (const a of list) {
      if (a.path) { files.push(a.path); continue; }
      const p = this._materializeDataUrl(a);
      if (p) files.push(p);
    }
    if (!files.length) return true;
    await this.cdp.send('DOM.enable', {});
    const doc = await this.cdp.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await this.cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId, selector: '[data-testid="v4-composer"] input[type=file]'
    });
    if (!nodeId) throw new Error('attachment-input-missing: 找不到 composer 的 file input');
    await this.cdp.send('DOM.setFileInputFiles', { files, nodeId }, 60000);
    this.logger.log('replay', { ...ctx, action: 'attachments-attached', count: files.length, paths: files.map(f => f.slice(0, 120)) });
    for (let i = 0; i < 120; i++) {
      await sleep(100);
      const st = await this.cdp.evaluate(this.exprs.attachmentsStateSrc, 2000).catch(() => null);
      if (st && st.ready >= files.length) return true;
    }
    throw new Error('attachment-upload-timeout: 附件没有就绪（未提交）');
  }

  /** data URL → 临时文件（粘贴类附件回放用） */
  _materializeDataUrl(a) {
    try {
      const m = /^data:([^;]+);base64,(.*)$/.exec(a.dataUrl || '');
      if (!m) return null;
      const ext = (m[1].split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
      const dir = path.join(os.tmpdir(), 'zcode-helper-attach');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, (a.name || 'pasted') .replace(/[^\w.\-]/g, '_') + '-' + Date.now() + '.' + ext);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      return file;
    } catch (e) {
      this.logger.log('replay', { action: 'attachment-materialize-fail', error: e.message });
      return null;
    }
  }

  async _switchSession(item, ctx) {
    // 0) 侧边栏可能被折叠：先展开，否则所有基于矩形/点击的侧栏操作都做不了
    await this._ensureSidebar(ctx);
    const targetSid = item.sessionId || null;
    const targetTitle = item.sessionTitle || null;
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    // 0) 目标会话可能因为"项目被收起"而不在 DOM 里 → 先展开项目再点
    if (targetSid) await this._ensureSessionVisible(item, ctx);
    // 0.1) 优先按 sid 精确点击（实测 li[data-testid="task-item-<sid>"]，最可靠）
    if (targetSid) {
      const r = await this.cdp.evaluate(
        this.exprs.sessionItemRectSrc.replace('__SID__', JSON.stringify(targetSid)), 3000).catch(() => null);
      if (r && r.ok) {
        await this.cdp.dispatchClick(Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2));
        await sleep(700);
        const after = await this.cdp.evaluate(this.exprs.snapshotSrc, 3000).catch(() => null);
        const newSid = (after && after.session && after.session.sessionId) || null;
        if (newSid === targetSid) {
          this.logger.log('replay', { ...ctx, action: 'session-switch', attempt: 0, matchedBy: 'exact-sid', verified: true, newSid });
          return true;
        }
        this.logger.log('replay', { ...ctx, action: 'session-switch-unverified', attempt: 0, matchedBy: 'exact-sid', newSid });
      }
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const loc = await this.cdp.evaluate(
        this.exprs.locateSessionSrc
          .replace('__SESSION_ID__', JSON.stringify(targetSid || ''))
          .replace('__SESSION_TITLE__', JSON.stringify(targetTitle || '')), 4000);
      if (loc && loc.ok) {
        await this.cdp.dispatchClick(Math.round(loc.x + loc.w / 2), Math.round(loc.y + loc.h / 2));
        await sleep(700);
        const after = await this.cdp.evaluate(this.exprs.snapshotSrc, 3000).catch(() => null);
        const newSid = (after && after.session && after.session.sessionId) || null;
        const newTitle = (after && after.session && after.session.sessionTitle) || null;
        let verified = false;
        if (targetSid) verified = newSid === targetSid;
        else if (targetTitle) verified = !!newTitle && norm(newTitle) === norm(targetTitle);
        // 页面对不上目标 → 不能发（发错会话比失败更糟）；只有"页面根本没暴露会话身份"时才信任定位结果
        const canRead = !!(after && ((after.session && (after.session.sessionId || after.session.sessionTitle)) || false));
        if (verified || !canRead) {
          this.logger.log('replay', { ...ctx, action: 'session-switch', attempt, matchedBy: loc.matchedBy, verified, newSid, newTitle });
          return true;
        }
        this.logger.log('replay', { ...ctx, action: 'session-switch-unverified', attempt, matchedBy: loc.matchedBy, newSid, newTitle, dbg: loc.dbg });
        // 未验证成功 → 进入第二次尝试（重新定位点击）；若两次都未验证则乐观放行并打 note
        item.note = 'session-switch-unverified → proceeding optimistically';
      } else {
        const dump = await this.cdp.evaluate(this.exprs.debugDomSrc, 4000).catch(() => null);
        this.logger.log('replay', {
          ...ctx, action: 'session-locate-failed', attempt, note: 'abort: target session not in sidebar',
          dbg: loc && loc.dbg ? loc.dbg : null,
          domDebug: dump ? { title: dump.title, count: dump.count, nodes: (dump.nodes || []).slice(0, 40) } : null
        });
        return false; // 目标不在侧栏（可能在别的 workspace/未渲染）→ 中止，绝不发进当前会话
      }
    }
    item.note = 'session-switch-unverified → abort';
    return false; // 两次点击都没对上目标会话 → 中止，绝不发进别的会话
  }

  /** 聚焦 + 清空 composer：真实按键 Ctrl+A → Backspace（Lexical 只认真实输入管道），注入侧 execCommand 兜底 */
  async _clearComposer() {
    const rect = await this.cdp.evaluate(this.exprs.composerRectSrc, 3000);
    if (rect && rect.ok) {
      await this.cdp.dispatchClick(Math.round(rect.x + rect.w / 2), Math.round(rect.y + rect.h / 2));
      // 切完会话后真实点击未必落到 composer（页面可能还在渲染）：再显式 focus 一次，
      // 否则后面的 Ctrl+A/注入都会作用在别的元素上（15:28 误标 sent 的根因）
      await this.cdp.evaluate(this.exprs.composerFocusSrc, 2000).catch(() => {});
    } else {
      await this.cdp.evaluate(this.exprs.composerFocusSrc, 3000);
    }
    await sleep(120);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const snap = await this.cdp.evaluate(this.exprs.snapshotSrc, 3000).catch(() => null);
      if (snap && snap.composerFound && !((snap.text || '').trim())) return { ok: true };
      await this.cdp.selectAllInFocused();
      await sleep(80);
      await this.cdp.pressBackspace();
      await sleep(150);
      this.logger.log('replay', { action: 'clear-attempt', attempt });
    }
    // 兜底：注入侧 execCommand + 原生 setter（对非 Lexical 的编辑器有效）
    const clr = await this.cdp.evaluate(this.exprs.clearComposerSrc, 3000).catch(() => null);
    const snap = await this.cdp.evaluate(this.exprs.snapshotSrc, 3000).catch(() => null);
    if (snap && snap.composerFound && !((snap.text || '').trim())) {
      this.logger.log('replay', { action: 'clear-fallback-ok', clearedBy: clr && clr.ok ? 'execCommand' : 'unknown' });
      return { ok: true };
    }
    return { ok: false, why: `not emptied after ctrl+a+backspace x3 and execCommand fallback (text: ${((snap && snap.text) || '').slice(0, 30)})` };
  }

  /** 单条回放：切工作区 → 抢救 → 切会话 → 抢救 → 清空 → 注入 → Enter → 校验
   *  返回 {sent, fatal}：fatal = 模型不可用，整轮回放应停止 */
  async _replayOne(item, reason) {
    const ctx = { id: item.id, workspacePath: item.workspacePath, sessionId: item.sessionId, sessionTitle: item.sessionTitle || null };
    let injected = false;
    try {
      // 0.5) 工作区：新建会话靠侧栏项目定位（全局可见），不需要也不应该切工作区
      if (!item.newSession) await this._prepareWorkspace(item, ctx);
      // 1) 新建会话的第一条消息：没有 sidebar 条目，去对应项目点「新建任务」现开一个
      if (item.newSession) {
        const opened = await this._openNewSession(item, ctx);
        if (!opened) {
          throw new Error(`new-session-open-failed: 项目「${item.draftProjectName || item.workspaceName || '未知'}」里没能开出新会话`);
        }
      } else if (item.sessionId || item.sessionTitle) {
        const switched = await this._switchSession(item, ctx);
        if (!switched) {
          throw new Error(`session-not-found: 找不到目标会话「${item.sessionTitle || item.sessionId}」，已取消发送（消息仍在队列）`);
        }
      }
      // 1.5) 上屏前的条件检查（都在"已切到目标会话"之后做）：
      //      a) 目标会话是否已经在跑（chat-loading）→ 不打断，留在队列等名额
      const cl = await this.cdp.evaluate(this.exprs.chatLoadingSrc, 2000).catch(() => null);
      if (cl && cl.working) {
        this.logger.log('replay', { ...ctx, action: 'session-busy-skip', timer: cl.timer || null });
        if (this.hooks.onSessionBusy) this.hooks.onSessionBusy(item.sessionId);
        return { sent: false, busy: true };
      }
      //      b) 模型就绪（两层判断：管理模型→刷新列表；选择模型→白名单挑一个；已有快照→直接用）
      if (this.hooks.ensureModel) {
        const m = await this.hooks.ensureModel();
        if (!m || !m.ok) {
          this.logger.log('replay', { ...ctx, action: 'model-unavailable-skip', why: m && m.why });
          return { sent: false, fatal: true };
        }
      }
      // 2) ZCode 自己会按会话保留输入框草稿（localStorage），helper 不能覆盖不是本条的草稿：
      //    - 输入框为空           → 注入本条（先清一次，防御性）
      //    - 内容正好就是本条消息 → 不再重复输入，直接回车提交
      //    - 有别的草稿           → 跳过本条（标 failed，草稿原样保留，用户处理后再重发）
      const cur = await this.cdp.evaluate(this.exprs.snapshotSrc, 3000).catch(() => null);
      const existing = ((cur && cur.text) || '').trim();
      const action = decideComposerAction(existing, item.text);
      if (action === 'move-draft') {
        // 草稿是用户尚未完成的意图：先原样存进队列末尾（type=draft，不自动发送），再清空输入框提交本条。
        // 不还原回对话框：本条提交后工程可能已变化，草稿留在框里会让用户误判状态。
        const curSession = (cur && cur.session) || {};
        const moved = this.queue.add({
          workspacePath: item.workspacePath || this.hooks.currentWorkspacePath(),
          workspaceName: curSession.workspaceName || item.workspaceName || null,
          sessionId: curSession.sessionId || item.sessionId || null,
          sessionTitle: curSession.sessionTitle || item.sessionTitle || null,
          source: 'draft',
          type: 'draft',
          text: existing
        });
        this.logger.log('replay', {
          ...ctx, action: 'draft-moved-to-queue',
          draftId: moved.added && moved.added.id, sessionId: curSession.sessionId || null, text: existing
        });
      }
      if (action === 'submit-existing') {
        if (item.attachments && item.attachments.length) await this._attachFiles(item, ctx);
        injected = true;
        this.logger.log('replay', { ...ctx, action: 'submit-existing-draft', text: item.text });
        await this.cdp.evaluate(this.exprs.composerFocusSrc, 2000).catch(() => {});
      } else {
        // 3) 清空（VM 实测修复 #4：不清空会追加；本机实测：Lexical 需真实按键）
        const clr = await this._clearComposer();
        if (!clr.ok) {
          throw new Error(`composer pre-clear failed (${clr.why})`);
        }
        // 3.5) 还原附件（路径优先；粘贴类用 data URL 落临时文件）
        if (item.attachments && item.attachments.length) await this._attachFiles(item, ctx);
        // 4) 注入（等价用户亲手输入，HANDOFF §3）
        await this.cdp.evaluate(this.exprs.composerFocusSrc, 2000).catch(() => {});
        await this.cdp.insertText(item.text);
        await sleep(150);
        let typed = await this.cdp.evaluate(this.exprs.snapshotSrc, 3000).catch(() => null);
        if (!typed || !((typed.text || '').trim())) {
          // 文字没进 composer：重新点击 + 再注一次（否则空按回车会被下面的"已清空"校验误判为 sent）
          this.logger.log('replay', { ...ctx, action: 'insert-retry' });
          const r2 = await this.cdp.evaluate(this.exprs.composerRectSrc, 3000).catch(() => null);
          if (r2 && r2.ok) await this.cdp.dispatchClick(Math.round(r2.x + r2.w / 2), Math.round(r2.y + r2.h / 2));
          await this.cdp.evaluate(this.exprs.composerFocusSrc, 2000).catch(() => {});
          await sleep(200);
          await this.cdp.insertText(item.text);
          await sleep(150);
          typed = await this.cdp.evaluate(this.exprs.snapshotSrc, 3000).catch(() => null);
        }
        if (!typed || !((typed.text || '').trim())) {
          throw new Error('insert failed: 文字没有进输入框（未提交，不能标记 sent）');
        }
        injected = true;
      }
      // 5.5) 提交前最后一道闸：输入框此刻所属的会话必须仍是目标会话
      //      （切过去之后用户可能又点了别的会话；发错会话比不发更糟）
      if (item.sessionId) {
        const guard = await this.cdp.evaluate(this.exprs.snapshotSrc, 3000).catch(() => null);
        const nowSid = (guard && guard.session && guard.session.sessionId) || null;
        if (nowSid && nowSid !== item.sessionId) {
          throw new Error(`session-mismatch: 提交前打开的会话是 ${nowSid}，不是 ${item.sessionId}（已取消发送）`);
        }
        if (!nowSid) this.logger.log('replay', { ...ctx, action: 'guard-session-unknown' });
      }
      // 发送前记下横幅状态：只有"这次发送后新出现的"横幅才算本条失败
      const bannersBefore = await this.cdp.evaluate(this.exprs.quotaBannerSrc, 2000).catch(() => null);
      await this.cdp.evaluate(this.exprs.beginInjectSrc, 1500).catch(() => {});
      await this.cdp.dispatchEnter();
      // 6) 校验清空（DESIGN §7 流程 6）
      await sleep(900);
      const after = await this.cdp.evaluate(this.exprs.snapshotSrc, 3000);
      const cleared = after && after.composerFound && !((after.text || '').trim());
      if (!cleared) {
        const modelErr = await this.cdp.evaluate(this.exprs.errorProbeSrc, 3000).catch(() => false);
        if (modelErr) {
          this.queue.setStatus(item.id, 'failed', { error: 'model-unavailable' });
          this.logger.log('replay', { ...ctx, action: 'fail', error: 'model-unavailable', text: item.text });
          this.hooks.onModelUnavailable();
          if (injected) await this._dropLeftover(ctx);
          return { sent: false, fatal: true }; // 模型不可用：整轮停止
        }
        throw new Error(`composer not cleared after submit (text remains: ${((after && after.text) || '').slice(0, 40)})`);
      }
      // 发送后出现"模型不可用/额度用完"横幅 → 这条其实没发成功，标 failed 并停批
      const blocked = await this._detectBlockingBanner(bannersBefore, ctx);
      if (blocked) {
        this.queue.setStatus(item.id, 'failed', { error: blocked });
        this.logger.log('replay', { ...ctx, action: 'send-blocked', error: blocked });
        if (this.hooks.onModelUnavailable) this.hooks.onModelUnavailable();
        return { sent: false, fatal: true };
      }
      this.queue.setStatus(item.id, 'sent');
      this.logger.log('replay', { ...ctx, action: 'sent', text: item.text, reason });
      // 7) 确认该会话真的开跑（否则同会话的下一条会被误放行）
      await this._confirmStarted(item.sessionId, ctx);
      return { sent: true, fatal: false };
    } catch (e) {
      this.queue.setStatus(item.id, 'failed', { error: e.message });
      this.logger.log('replay', { ...ctx, action: 'fail', error: e.message, text: item.text });
      if (injected) await this._dropLeftover(ctx);
      return { sent: false, fatal: false };
    }
  }

  /** 回放失败后清掉 composer 里残留的**本轮注入文本**（条目里已保存全文，不丢内容）。
   *  只在本轮确实注入过时才调用：输入框里的 ZCode 草稿不属于回放，不能被清掉。 */
  async _dropLeftover(ctx) {
    const r = await this._clearComposer().catch(() => null);
    this.logger.log('replay', { ...ctx, action: 'post-fail-clear', ok: !!(r && r.ok) });
  }

}

/** 输入框已有内容时怎么发（ZCode 自己保留按会话草稿，helper 不能覆盖）： */
function decideComposerAction(existing, text) {
  const e = String(existing || '').trim();
  const t = String(text || '').trim();
  if (!e) return 'clear';                 // 空输入框 → 正常注入
  if (e === t) return 'submit-existing';  // 就是这条消息 → 直接回车提交
  return 'move-draft';                    // 用户别的草稿 → 先存进队列末尾（type=draft），再清空继续提交
}

function samePath(a, b) {
  const norm = p => String(p).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

module.exports = { Player, samePath, decideComposerAction };
