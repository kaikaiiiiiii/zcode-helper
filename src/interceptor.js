'use strict';
/**
 * interceptor.js — 录制态接管的管理侧（注入侧在 inject/bootstrap.js）
 * helper 侧职责（AGENTS.md 硬规则 4）：模式判断在 helper —— 收到注入侧 capture 上报后，
 * 再核对当前状态机（RECORDING + 非 500ms 静默窗）才入队；翻转竞态在此挡掉。
 * 截获入队后：日志 capture（全文）、队列计数广播、圆点徽标刷新（HANDOFF §5b 细节 4）。
 */
class Interceptor {
  constructor({ queue, logger, stateMachine, engine }) {
    this.queue = queue;
    this.logger = logger;
    this.stateMachine = stateMachine;
    this.engine = engine; // 用于 currentWorkspacePath 与 indicator 刷新
  }

  /** CDP binding 上报入口（engine 转发 binding payload） */
  handleReport(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'capture') return this._onCapture(payload);
    if (payload.type === 'mode-ack') {
      this.logger.log('cdp', { action: 'mode-ack', mode: payload.mode });
      return;
    }
    if (payload.type === 'boot') {
      this.logger.log('cdp', { action: 'inject-boot', version: payload.version });
      return;
    }
    if (payload.type === 'enter-passthrough') {
      // 指令/建议列表开着时的回车：放行给 app 选择指令，不入队
      this.logger.log('capture', { action: 'enter-passthrough', reason: payload.reason || null, accepted: false });
      return;
    }
  }

  _onCapture(payload) {
    const sm = this.stateMachine;
    const pageSession = payload.session || {};
    const workspacePath = pageSession.workspacePath || this.engine.currentWorkspacePath();
    const workspaceName = pageSession.workspaceName || null;
    const projectId = pageSession.projectId || null;
    const sessionId = pageSession.sessionId || null;
    const sessionTitle = pageSession.sessionTitle || null;
    const newSession = !!pageSession.newConversation;
    const draftProjectName = pageSession.draftProjectName || null;
    const text = (payload.text || '').trim();
    if (!text) return;
    // helper 侧终审：连接 + 滤网开启（暂停助手期间不记录，但页面通常已直接放行）
    if (sm.connState !== 'CONNECTED') {
      this.logger.log('capture', { workspacePath, sessionId, text, accepted: false, why: 'uncontrolled' });
      return;
    }
    if (this.engine.helperPaused) {
      this.logger.log('capture', { workspacePath, sessionId, text, accepted: false, why: 'helper-paused' });
      return;
    }
    if (sm.inSilenceWindow()) {
      this.logger.log('capture', { workspacePath, sessionId, text, accepted: false, why: 'silence-window' });
      return;
    }
    const attachments = Array.isArray(payload.attachments) ? payload.attachments.filter(Boolean) : [];
    const { added } = this.queue.add({
      workspacePath, workspaceName, projectId, sessionId, sessionTitle,
      newSession, draftProjectName,
      source: 'intercept',
      holdReason: payload.holdReason || null,
      attachments,
      text
    });
    if (added) {
      this.logger.log('capture', {
        workspacePath, sessionId, newSession, draftProjectName, text, accepted: true, itemId: added.id, holdReason: payload.holdReason || null,
        attachments: attachments.map(a => ({ kind: a.kind, name: a.name, path: a.path, size: a.size, hasDataUrl: !!a.dataUrl, tooLarge: !!a.tooLarge }))
      });
      try { this.engine.noteEvent('已入队「' + text.slice(0, 16) + '」'); } catch { /* ignore */ }
      this.engine.refreshIndicator();
      // 截获后清空输入框：Lexical 只认真实输入管道（与回放清空同一路径），页面内 execCommand 无效
      this.engine.clearComposerAfterCapture().catch(() => { /* 内部已记日志 */ });
    }
  }
}

module.exports = { Interceptor };
