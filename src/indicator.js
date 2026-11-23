'use strict';
/**
 * indicator.js — ZCode 内「灯条」注入（右侧常显小面板：实时状态都在这里）
 * 连接时持久注入（addScriptOnNewDocument）+ 定期重保（DOM 重建后自愈）。
 * 页面侧渲染见 src/inject/bootstrap.js 的 ZFH.setLightBar。
 */
class Indicator {
  constructor(cdp, domAdapter) {
    this.cdp = cdp;
    this.adapter = domAdapter;
    this.timer = null;
    this.last = null;
  }

  /** 连接建立后调用：首次刷新 + 周期重保（10s，幂等） */
  start() {
    this.stop();
    this.push(this.last);
    this.timer = setInterval(() => this.push(this.last), 10_000);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 推送灯条状态（payload 见 engine._lightBarPayload） */
  async push(payload) {
    if (!payload) return;
    this.last = payload;
    if (!this.cdp.connected) return;
    try {
      await this.cdp.evaluate(this.adapter.setLightBarSrc(payload), 3000);
    } catch { /* 重连后由 start()/push() 再刷 */ }
  }
}

module.exports = { Indicator };
