'use strict';
/**
 * state-machine.js — 连接状态与模式状态（DESIGN.md §3/§4）
 * 连接态：UNCONTROLLED ⇄ CONNECTED；模式：RECORDING ⇄ PLAYING（时间表/辅助信号驱动，判断全在 helper 侧）；
 * 回放进行中是 CONNECTED 下的子状态 REPLAYING。
 * 翻转记录 lastFlipTs，供 500ms 静默窗（DESIGN §9）使用。
 */
const { EventEmitter } = require('events');

const CONN = { UNCONTROLLED: 'UNCONTROLLED', CONNECTED: 'CONNECTED' };
const MODE = { RECORDING: 'RECORDING', PLAYING: 'PLAYING' };

class StateMachine extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connState = CONN.UNCONTROLLED;
    this.mode = MODE.RECORDING;
    this.replaying = false;
    this.lastFlipTs = 0;
    this.lastReason = null;
  }

  snapshot() {
    return {
      connState: this.connState,
      mode: this.mode,
      replaying: this.replaying,
      lastFlipTs: this.lastFlipTs,
      lastReason: this.lastReason
    };
  }

  _emitChange(reason) {
    this.emit('change', this.snapshot(), reason);
  }

  setConnection(state, reason) {
    if (this.connState === state) {
      // 状态未变也要更新原因（面板需要知道为什么处于未受控）
      if (reason) this.lastReason = reason;
      return;
    }
    this.connState = state;
    this.lastReason = reason || null;
    this.logger.log('state', { kind: 'conn', value: state, reason: reason || null });
    this._emitChange(reason);
  }

  setMode(mode, reason) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.lastFlipTs = Date.now();
    this.lastReason = reason || null;
    this.logger.log('mode-flip', { to: mode, reason: reason || null });
    this._emitChange(reason);
  }

  /** 翻转静默窗：翻转后 500ms 内的截获/回放动作直接放行，不拦截不回放（DESIGN §9） */
  inSilenceWindow(now = Date.now(), windowMs = 500) {
    return this.lastFlipTs > 0 && now - this.lastFlipTs < windowMs;
  }

  setReplaying(v, reason) {
    if (this.replaying === !!v) return;
    this.replaying = !!v;
    this.logger.log('state', { kind: 'replaying', value: this.replaying, reason: reason || null });
    this._emitChange(reason);
  }

  /** 判定当前模式下 UI/注入侧语义：recording | playing | uncontrolled */
  injectedMode() {
    if (this.connState !== CONN.CONNECTED) return 'uncontrolled';
    return this.mode === MODE.PLAYING ? 'playing' : 'recording';
  }
}

module.exports = { StateMachine, CONN, MODE };
