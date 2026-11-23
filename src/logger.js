'use strict';
/**
 * logger.js — 结构化 JSONL 日志（HANDOFF.md §6.5）
 * 每行独立自足可读：{ts, ev, workspacePath, sessionId, ...data}
 * 事件类型：mode-flip / capture / cdp / replay / supervisor / queue / state / app
 * 同时维护内存环形缓冲（面板"最近事件"）与 export 打包（DESIGN.md §7 流程 8）。
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const RECENT_LIMIT = 80;

class Logger extends EventEmitter {
  /**
   * @param {string} userDataDir 默认日志根（%APPDATA%）
   * @param {string|null} logDir 覆盖目录——开发阶段由 main.js 传入仓库 logs/（app.isPackaged=false 时）
   */
  constructor(userDataDir, logDir = null) {
    super();
    this.dir = logDir || path.join(userDataDir, 'logs');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* 目录已存在 */ }
    this.stream = null;
    this.day = '';
    this.recent = [];
  }

  /** 单条日志写入。fields 会并入行对象；必须包含上下文字段时由调用方传入。 */
  log(ev, fields = {}) {
    const ts = Date.now();
    const line = { ts, ev, ...fields };
    // 单条自足：无 workspacePath/sessionId 时显式置 null，便于 VM 复现对齐
    if (!('workspacePath' in line)) line.workspacePath = fields.workspacePath !== undefined ? fields.workspacePath : null;
    if (!('sessionId' in line)) line.sessionId = fields.sessionId !== undefined ? fields.sessionId : null;
    let text;
    try {
      text = JSON.stringify(line);
    } catch (e) {
      text = JSON.stringify({ ts, ev, error: `serialize failed: ${e.message}` });
    }
    try {
      this._streamFor(ts).write(text + '\n');
    } catch { /* 磁盘写失败不致命 */ }
    this.recent.push(line);
    if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT);
    this.emit('log', line);
    return line;
  }

  _streamFor(ts) {
    const d = new Date(ts);
    const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; // 本地日期，便于 VM 复现对齐
    if (day !== this.day || !this.stream) {
      if (this.stream) this.stream.end();
      this.day = day;
      this.file = path.join(this.dir, `zfh-${day}.jsonl`);
      this.stream = fs.createWriteStream(this.file, { flags: 'a' });
      this.stream.on('error', () => { /* 日志写失败不致命（如目录被删） */ });
    }
    return this.stream;
  }

  recentEvents(limit = 20) {
    return this.recent.slice(-limit);
  }

  /** export 动作：日志 + 当前队列 + app 版本 + 状态机轨迹打包成单文件（HANDOFF §6.5） */
  exportBundle(payload) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(this.dir, `export-${stamp}.json`);
    try { this._streamFor(Date.now()); } catch { /* 确保 logFile 有值 */ }
    const bundle = {
      exportedAt: new Date().toISOString(),
      appVersion: payload.appVersion,
      state: payload.state,
      config: payload.config,
      queue: payload.queue,
      recentEvents: this.recent,
      logFile: this.file || null,
      note: 'VM 无 plan 测试与 host 开发之间的复现桥梁；如需完整历史请附带同日 zfh-*.jsonl 文件'
    };
    fs.writeFileSync(file, JSON.stringify(bundle, null, 2));
    return file;
  }

  close() {
    if (this.stream) this.stream.end();
    this.stream = null;
  }
}

module.exports = { Logger };
