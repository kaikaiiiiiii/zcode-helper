'use strict';
/**
 * scheduler.js — 模式时间表（DESIGN.md §4 主方案）
 * 免费 plan 生效时刻固定（默认 23:00），到点翻 PLAYING，失效时刻翻回 RECORDING。
 * activeTo <= activeFrom 视为跨午夜（如 23:00→06:00，凌晨仍算 PLAYING）。
 * 轮询间隔 15s，边界秒级误差可接受；engine 在启动/连接时主动 check() 一次。
 */
class Scheduler {
  /**
   * @param {import('./config').Config} config
   * @param {(mode: string, reason: string) => void} flip 由 engine 提供：翻转入口（含去重）
   */
  constructor(config, flip) {
    this.config = config;
    this.flip = flip;
    this.timer = null;
    this.lastExpected = null;
  }

  /** 计算此刻按时间表应处的模式 */
  expectedMode(now = new Date()) {
    const { activeFrom, activeTo } = this.config.get('modeSchedule');
    const minutes = now.getHours() * 60 + now.getMinutes();
    const [fh, fm] = activeFrom.split(':').map(Number);
    const [th, tm] = activeTo.split(':').map(Number);
    const from = fh * 60 + fm;
    const to = th * 60 + tm;
    if (to > from) return minutes >= from && minutes < to ? 'PLAYING' : 'RECORDING';
    // 跨午夜：PLAYING 区间为 [from, 24:00) ∪ [0, to)
    if (minutes >= from || minutes < to) return 'PLAYING';
    return 'RECORDING';
  }

  /** 立即核对一次；返回是否发生翻转 */
  check() {
    const expected = this.expectedMode();
    const changed = this.lastExpected !== null && expected !== this.lastExpected;
    this.lastExpected = expected;
    if (changed) this.flip(expected, `schedule ${this.config.get('modeSchedule').activeFrom}~${this.config.get('modeSchedule').activeTo}`);
    return changed;
  }

  start() {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), 15_000);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

module.exports = { Scheduler };
