'use strict';
/**
 * supervisor.js — ZCode 进程管理（DESIGN.md §5）
 * 职责：受控 spawn（带 CDP 端口）、进程退出检测、受控重启、second-instance 打开工作区。
 * 取舍（HANDOFF §7）：helper 启动时 ZCode 未在运行 → 自动受控拉起；此后 ZCode 退出不再自动拉起
 * （用户主动关闭应被尊重），统一进入 UNCONTROLLED 由面板按钮驱动。
 */
const { spawn } = require('child_process');
const net = require('net');
const { EventEmitter } = require('events');

/** 端口是否空闲（启动前探测；被占则由 engine 顺延） */
function isPortFree(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/** TCP 端口是否有服务在听（ZCode 已存在时快速判 CDP 可达性） */
function isPortOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    const fail = () => { sock.destroy(); resolve(false); };
    sock.once('timeout', fail);
    sock.once('error', fail);
    sock.connect(port, host);
  });
}

class Supervisor extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.child = null;
    this.zcodeExePath = null;
    this._ownedStart = false; // 本轮 ZCode 是否由 helper 拉起
  }

  get isRunning() {
    return !!(this.child && this.child.exitCode === null && !this.child.killed);
  }

  /**
   * 受控启动：ZCode.exe --remote-debugging-port=9222 --remote-allow-origins=* [工作区路径]
   * 返回实际使用的端口（调用方探测占用后传入）。
   */
  spawnZCode(exePath, port, workspacePath) {
    if (this.isRunning) return { port, alreadyRunning: true };
    this.zcodeExePath = exePath;
    const args = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'];
    if (workspacePath) args.push(workspacePath);
    try {
      // detached + unref：让 ZCode 不随 helper 退出而被一起杀掉（"退出但保留 ZCode"）
      this.child = spawn(exePath, args, { stdio: 'ignore', windowsHide: true, detached: true });
      this.child.unref();
    } catch (e) {
      this.logger.log('supervisor', { action: 'spawn-fail', error: e.message, exePath });
      throw e;
    }
    this._ownedStart = true;
    this.logger.log('supervisor', { action: 'spawn', pid: this.child.pid, port, workspacePath: workspacePath || null });
    this.child.once('exit', (code, signal) => {
      this.logger.log('supervisor', { action: 'exit', pid: this.child ? this.child.pid : null, code, signal, owned: this._ownedStart });
      this.child = null;
      this._ownedStart = false;
      this.emit('zcode-exit', { code, signal });
    });
    this.emit('spawned', { pid: this.child.pid, port });
    return { port, alreadyRunning: false };
  }

  /**
   * second-instance 打开工作区（回放切工作区用）：不带端口参数——
   * 单实例锁下第二个进程只转发工作区路径（HANDOFF §7）。
   */
  openWorkspace(exePath, workspacePath) {
    try {
      const child = spawn(exePath, [workspacePath], { stdio: 'ignore', windowsHide: true });
      this.logger.log('supervisor', { action: 'open-workspace', workspacePath });
      child.once('exit', () => { /* 转发进程随即退出，属正常 */ });
      return true;
    } catch (e) {
      this.logger.log('supervisor', { action: 'open-workspace-fail', workspacePath, error: e.message });
      return false;
    }
  }

  /** 结束 ZCode：优先结束 helper 持有的 child，否则按进程名兜底 */
  killZCode() {
    return new Promise(resolve => {
      if (this.isRunning) {
        const pid = this.child.pid;
        this.child.once('exit', () => resolve(true));
        try { this.child.kill(); } catch { /* exit 事件兜底 */ }
        // 3s 未退则强制
        setTimeout(() => {
          try {
            if (this.child && this.child.exitCode === null) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
          } catch { /* ignore */ }
        }, 3000);
        this.logger.log('supervisor', { action: 'kill', pid });
        return;
      }
      // 外部启动的 ZCode：按映像名结束（用户已点【重启受控 ZCode】确认任务完结）
      const tk = spawn('taskkill', ['/IM', 'ZCode.exe', '/F', '/T'], { windowsHide: true });
      tk.on('close', code => {
        this.logger.log('supervisor', { action: 'kill-external', taskkillExit: code });
        resolve(code === 0);
      });
      tk.on('error', () => resolve(false));
    });
  }

  dispose() {
    // helper 退出默认保留 ZCode 运行（HANDOFF §7 / DESIGN §7 流程 8）
    this.child = null;
  }
}

module.exports = { Supervisor, isPortFree, isPortOpen };
