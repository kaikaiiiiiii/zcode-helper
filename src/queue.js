'use strict';
/**
 * queue.js — pending 队列存储（DESIGN.md §6 数据模型）
 * JSONL 逐行追加于 userData/queue.jsonl；条目状态单向推进 pending → sent / failed；
 * failed 允许手动重置为 pending。snapshot 条目与 intercept 条目按 (会话范围, 内容) 去重（HANDOFF §5b）。
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const STATUS = { PENDING: 'pending', SENT: 'sent', FAILED: 'failed' };

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function makeId(ts) {
  const d = new Date(ts);
  const rand = Math.random().toString(16).slice(2, 6);
  return `q_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${rand}`;
}

class Queue extends EventEmitter {
  constructor(userDataDir, archiveDays) {
    super();
    this.file = path.join(userDataDir, 'queue.jsonl');
    this.archiveDays = archiveDays || 7;
    this.items = [];
    this._load();
  }

  _load() {
    this.items = [];
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n');
      const cutoff = Date.now() - this.archiveDays * 86400_000;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const it = JSON.parse(line);
          if (it.status === STATUS.SENT && it.sentAt && it.sentAt < cutoff) continue; // 滚动归档
          if (!STATUS[it.status?.toUpperCase()]) continue;
          if (!it.type) it.type = it.source === 'draft' ? 'draft' : 'submit'; // 兼容旧条目
          this.items.push(it);
        } catch { /* 跳过损坏行 */ }
      }
    } catch { /* 文件不存在 → 空队列 */ }
    this._persist();
  }

  _persist() {
    try {
      fs.writeFileSync(this.file, this.items.map(i => JSON.stringify(i)).join('\n') + '\n');
    } catch { /* 写失败不中断运行 */ }
  }

  _emit() {
    this.emit('change', this.counts());
  }

  /** 回放定位用的"会话范围"键：sessionId 已知用 sessionId，否则退回 workspacePath（HANDOFF §5b 细节 3） */
  _scopeOf(item) {
    return item.sessionId || `ws:${item.workspacePath}`;
  }

  /**
   * 新增条目。type：'submit'（提交，会自动回放）| 'draft'（草稿，只保存不自动发送）。
   * source=snapshot 时与既有 pending 条目按 (范围, 全文) 去重（历史兼容）；
   * source=intercept 时清掉同范围同内容的 pending snapshot。
   * sessionTitle：录制时尽力捕获的当前会话标题（回放切会话依据，弱依赖，VM 实测修复 #5）。
   * 返回 {added, deduped}
   */
  add({ ts, workspacePath, workspaceName, projectId, sessionId, sessionTitle, newSession, draftProjectName, source, text, type, holdReason, attachments }) {
    const now = ts || Date.now();
    const scope = sessionId || `ws:${workspacePath}`;
    if (source === 'snapshot') {
      const dup = this.items.find(i =>
        i.status === STATUS.PENDING && this._scopeOf(i) === scope && i.text === text);
      if (dup) return { added: null, deduped: dup.id };
    } else if (source === 'intercept') {
      // 截获优先：同范围同内容的 pending snapshot 让位（内容一致，快照无独立价值）
      let removed = false;
      this.items = this.items.filter(i => {
        if (i.status === STATUS.PENDING && i.source === 'snapshot' &&
            this._scopeOf(i) === scope && i.text === text) { removed = true; return false; }
        return true;
      });
      if (removed) this._persist();
    }
    const item = {
      id: makeId(now),
      ts: now,
      workspacePath: workspacePath || null,
      workspaceName: workspaceName || null,   // 项目显示名：侧栏项目收起时靠它展开
      projectId: projectId || null,           // 项目 id（section[data-project-id]，优先用它定位项目）
      sessionId: sessionId || null,
      sessionTitle: sessionTitle || null,
      newSession: !!newSession,            // 新建会话的第一条消息：没有 sidebar 条目，回放时现开一个
      draftProjectName: draftProjectName || null,
      attachments: Array.isArray(attachments) && attachments.length ? attachments : null,
      source,
      type: type === 'draft' ? 'draft' : 'submit',
      holdReason: holdReason || null,   // 'model' | 'quota' | null（暂存原因，用于队列展示）
      text,
      status: STATUS.PENDING,
      sentAt: null,
      error: null,
      note: null
    };
    this.items.push(item);
    this._persist();
    this._emit();
    return { added: item, deduped: null };
  }

  /** 插到队列最前（红点触发的自动「继续」：中断任务优先于普通待发） */
  addFront({ ts, workspacePath, workspaceName, projectId, sessionId, sessionTitle, source, text, holdReason, attachments }) {
    const now = ts || Date.now();
    const item = {
      id: makeId(now), ts: now,
      workspacePath: workspacePath || null,
      workspaceName: workspaceName || null,
      projectId: projectId || null,
      sessionId: sessionId || null,
      sessionTitle: sessionTitle || null,
      attachments: Array.isArray(attachments) && attachments.length ? attachments : null,
      source: source || 'auto',
      type: 'submit',
      holdReason: holdReason || null,
      text,
      status: STATUS.PENDING,
      sentAt: null,
      error: null,
      note: null
    };
    this.items.unshift(item);
    this._persist();
    this._emit();
    return { added: item, deduped: null };
  }

  get(id) { return this.items.find(i => i.id === id) || null; }

  /** 状态单向推进；failed → pending 允许（手动重发）。非法流转返回 false。 */
  setStatus(id, status, extra = {}) {
    const it = this.get(id);
    if (!it) return false;
    const allowed =
      (it.status === STATUS.PENDING && (status === STATUS.SENT || status === STATUS.FAILED)) ||
      (it.status === STATUS.FAILED && status === STATUS.PENDING);
    if (!allowed) return false;
    it.status = status;
    it.sentAt = status === STATUS.SENT ? Date.now() : it.sentAt;
    it.error = status === STATUS.FAILED ? (extra.error || 'unknown') : null;
    if (extra.note !== undefined) it.note = extra.note;
    if (status === STATUS.PENDING) { it.sentAt = null; it.error = null; }
    this._persist();
    this._emit();
    return true;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter(i => i.id !== id);
    if (this.items.length !== before) { this._persist(); this._emit(); return true; }
    return false;
  }

  /** failed 全部重置为 pending（手动重发前便捷操作） */
  resetAllFailed() {
    let n = 0;
    for (const it of this.items) {
      if (it.status === STATUS.FAILED) { it.status = STATUS.PENDING; it.error = null; n++; }
    }
    if (n) { this._persist(); this._emit(); }
    return n;
  }

  /** 清空已发送条目（pending/failed 保留） */
  clearSent() {
    const before = this.items.length;
    this.items = this.items.filter(i => i.status !== STATUS.SENT);
    const n = before - this.items.length;
    if (n) { this._persist(); this._emit(); }
    return n;
  }

  pendingItems() { return this.items.filter(i => i.status === STATUS.PENDING); }

  /** 可自动回放的条目：pending 且类型为 submit（草稿类永不自动发送） */
  pendingSubmits() { return this.items.filter(i => i.status === STATUS.PENDING && i.type !== 'draft'); }

  /** 草稿类条目（只保存，等用户手动"上屏"） */
  draftItems() { return this.items.filter(i => i.type === 'draft' && i.status === STATUS.PENDING); }
  counts() {
    const c = { pending: 0, sent: 0, failed: 0, draft: 0 };
    for (const i of this.items) {
      if (i.type === 'draft' && i.status === STATUS.PENDING) c.draft++;
      else c[i.status] = (c[i.status] || 0) + 1;
    }
    return c;
  }
  all() { return this.items.slice().reverse(); } // 新的在前（查看列表）
}

module.exports = { Queue, STATUS };
