'use strict';
/**
 * cdp-client.js — CDP 连接与 JSON-RPC 封装（DESIGN.md §5）
 * 复用探索期已验证的裸 WebSocket 方案（HANDOFF §3）：GET /json 列 targets →
 * WebSocket 连 webSocketDebuggerUrl → Runtime.evaluate / Input.insertText / Input.dispatchKeyEvent。
 * Electron 45 主进程 Node ≥22 自带全局 WebSocket，零第三方依赖。
 * 断线检测：socket 关闭 / 心跳失败 → 'disconnected' 事件（3s 内上报状态机，DESIGN §5 cdp-client）。
 */
const http = require('http');
const { EventEmitter } = require('events');

function httpGetJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`bad json: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** 探测 CDP 端口并返回 page 型 targets；不可用抛错 */
async function listPageTargets(port) {
  const targets = await httpGetJson(`http://127.0.0.1:${port}/json`);
  return targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
}

/**
 * 这个 target 是不是 ZCode？——只看 URL / 标题。
 * 场景：9222 端口可能被别的 Electron 应用占用（它们也开 index.html），绝不能往人家页面里注入。
 */
function isZCodeTarget(t) {
  if (!t) return false;
  const url = String(t.url || '').toLowerCase();
  const title = String(t.title || '').toLowerCase();
  if (url.includes('zcode') || title.includes('zcode')) return true;
  // ZCode 4.x：file:///…/apps/zcode/<ver>/resources/app.asar/out/renderer/index.html
  return url.includes('app.asar/out/renderer');
}

/** 只挑 ZCode 的页面；一个都没有就返回 null（绝不回落到"随便哪个页面"） */
function pickZCodeTarget(targets) {
  const pages = (targets || []).filter(t => t && (!t.type || t.type === 'page'));
  const zcode = pages.filter(isZCodeTarget);
  if (!zcode.length) return null;
  return zcode.find(t => String(t.url || '').includes('index.html')) || zcode[0];
}

/** 挑主窗口 target：优先 file://…/index.html（ZCode 桌面端加载形态），否则第一个 page */
function pickMainTarget(pageTargets) {
  const idx = pageTargets.findIndex(t => (t.url || '').includes('index.html'));
  return idx >= 0 ? pageTargets[idx] : pageTargets[0];
}

class CdpClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.target = null;
    this._nextId = 1;
    this._pending = new Map(); // id → {resolve, reject, timer}
    this._handlers = new Map(); // event name → Set(handler)
    this._watchdog = null;
    this.connected = false;
  }

  /** 连接到指定 target（调用方先用 listPageTargets/pickMainTarget 选好） */
  async connect(target) {
    this.close('reconnect'); // 幂等
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      let settled = false;
      const failTimer = setTimeout(() => {
        if (!settled) { settled = true; try { ws.close(); } catch { /* ignore */ } reject(new Error('ws handshake timeout')); }
      }, 5000);
      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(failTimer);
        this.ws = ws;
        this.target = target;
        this.connected = true;
        this._bindSocket(ws);
        this._startWatchdog();
        this.emit('connected', target);
        resolve(target);
      });
      ws.addEventListener('error', e => {
        if (!settled) { settled = true; clearTimeout(failTimer); reject(new Error(`ws error: ${e.message || 'unknown'}`)); }
      });
    });
    return target;
  }

  _bindSocket(ws) {
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== undefined) {
        const p = this._pending.get(msg.id);
        if (p) {
          this._pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(`${msg.error.message || msg.error.code}`));
          else p.resolve(msg.result);
        }
        return;
      }
      if (msg.method) {
        const hs = this._handlers.get(msg.method);
        if (hs) for (const h of hs) { try { h(msg.params); } catch { /* handler 自身容错 */ } }
        this.emit('cdp-event', msg);
      }
    });
    ws.addEventListener('close', () => this._onDown('socket close'));
    ws.addEventListener('error', () => { /* close 事件随后会到；此处不重复处理 */ });
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._watchdog = setInterval(async () => {
      try {
        await this.send('Runtime.evaluate', { expression: '1', returnByValue: true }, 3000);
      } catch (e) {
        this._onDown(`watchdog fail: ${e.message}`);
      }
    }, 5000);
  }

  _stopWatchdog() {
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
  }

  _onDown(reason) {
    if (!this.connected) return;
    this.connected = false;
    this._stopWatchdog();
    // 拒绝所有在途请求
    for (const p of this._pending.values()) { clearTimeout(p.timer); p.reject(new Error('cdp disconnected')); }
    this._pending.clear();
    try { this.ws && this.ws.close(); } catch { /* ignore */ }
    this.ws = null;
    this.emit('disconnected', reason);
  }

  /** 主动断开（幂等，不触发 disconnected 语义由调用方决定） */
  close(reason) {
    this._stopWatchdog();
    this.connected = false;
    for (const p of this._pending.values()) { clearTimeout(p.timer); p.reject(new Error(`closed: ${reason || 'local'}`)); }
    this._pending.clear();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.target = null;
  }

  /** 注册 CDP 协议事件（Runtime.bindingCalled 等）。注意：不能叫 on()，否则会覆盖 EventEmitter.on，
   *  engine 侧 on('binding')/on('disconnected') 就收不到本类 emit 的事件。 */
  onCdpEvent(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    return () => this._handlers.get(event)?.delete(handler);
  }

  /** JSON-RPC 调用 */
  send(method, params = {}, timeoutMs = 10000) {
    if (!this.ws || !this.connected) return Promise.reject(new Error('cdp not connected'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // ---- 高层封装（HANDOFF §3 已验证手段）----

  /** Runtime.evaluate，返回 returnByValue 的 result.value */
  async evaluate(expression, timeoutMs = 5000) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    }, timeoutMs);
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate exception';
      throw new Error(desc.split('\n')[0]);
    }
    return r.result ? r.result.value : undefined;
  }

  /** 真实输入管道注入文本（React 可收到事件，HANDOFF §3） */
  insertText(text) {
    return this.send('Input.insertText', { text });
  }

  /** 派发真实键盘事件（Enter = keyDown + keyUp，HANDOFF §3） */
  dispatchEnter() {
    const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    return this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: '\r' })
      .then(() => this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }));
  }

  /** 在焦点编辑器内全选（Ctrl+A 真实按键；Lexical 等自绘编辑器只认真实输入管道） */
  async selectAllInFocused() {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'Control', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'Control', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 });
  }

  /** 真实 Backspace 按键（配合 selectAllInFocused 清空编辑器） */
  async pressBackspace() {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  }

  /** 派发真实鼠标点击（聚焦 composer 用） */
  dispatchClick(x, y) {
    const opts = { x, y, button: 'left', clickCount: 1 };
    return this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...opts })
      .then(() => this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...opts }));
  }

  /** 注册渲染进程→helper 的 binding（Runtime.addBinding + bindingCalled 事件） */
  async addBinding(name) {
    await this.send('Runtime.addBinding', { name });
    return this.onCdpEvent('Runtime.bindingCalled', params => {
      if (params.name !== name) return;
      let payload = null;
      try { payload = JSON.parse(params.payload); } catch { payload = { raw: params.payload }; }
      this.emit('binding', payload, params);
    });
  }

  /** 新文档创建时自动注入（页面刷新/跳转后拦截与圆点不丢） */
  addScriptOnNewDocument(source) {
    return this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  enableDomains() {
    return Promise.all([this.send('Runtime.enable'), this.send('Page.enable')]);
  }
}

module.exports = { CdpClient, listPageTargets, pickMainTarget, pickZCodeTarget, isZCodeTarget, httpGetJson };
