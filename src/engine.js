'use strict';
/**
 * engine.js — 编排核心（DESIGN.md §2 总体架构）
 * 组装 config/logger/queue/cdp/supervisor/state-machine/interceptor/
 * player/indicator，管理连接循环、模式应用、自动回放触发，并向 UI 层广播状态。
 */
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { Config } = require('./config');
const { Logger } = require('./logger');
const { Queue, STATUS } = require('./queue');
const { CdpClient, listPageTargets, pickMainTarget, pickZCodeTarget } = require('./cdp-client');
const { Supervisor, isPortFree, isPortOpen } = require('./supervisor');
const { StateMachine, CONN } = require('./state-machine');
const { Player, samePath } = require('./player');
const { Interceptor } = require('./interceptor');
const { Indicator } = require('./indicator');
const adapter = require('./dom-adapter');
const { detectZCodePath } = require('./zcode-path');
const { probePlan } = require('./plan-probe');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function tasklistHas(exeName) {
  return new Promise(resolve => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/FO', 'CSV'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(String(stdout).toLowerCase().includes(exeName.toLowerCase()));
    });
  });
}

class Engine extends EventEmitter {
  constructor(userDataDir, { smoke = false, logDir = null, systemIdleSeconds = null } = {}) {
    super();
    this.userDataDir = userDataDir;
    this.smoke = smoke;
    this._noLaunch = smoke; // 冒烟测试绝不触碰现有 ZCode（不持久化配置，见 runSmoke）
    this.config = new Config(userDataDir);
    this.logger = new Logger(userDataDir, logDir);
    this.queue = new Queue(userDataDir, this.config.get('queueArchiveDays'));
    this.stateMachine = new StateMachine(this.logger);
    this.supervisor = new Supervisor(this.logger);
    this.cdp = new CdpClient();

    this._workspacePath = this.config.get('defaultWorkspacePath') || null;
    this.helperPaused = !!this.config.get('helperPaused'); // 暂停助手（暂停记录）→ 滤网全放行
    this.outputPaused = !!this.config.get('outputPaused'); // 暂停输出 → 队列不排空
    this.modelState = 'None';     // 模型可用状态：'None' 或模型名（如 GLM-5.3-Flash）
    this._workingCount = 0;       // 当前 working 会话数（灯条/滤网用）
    this._systemIdleSeconds = systemIdleSeconds; // () => 系统级键鼠空闲秒数（主进程注入）
    this._autoContinueHandled = new Set();        // 已为哪些 sid 的红点插过「继续」
    this._observedWorking = new Map();           // 回放时观察到"sid 正在跑"（5s 内有效，并入 working 计数）
    this._autoContinueTimes = new Map();          // sid → [ts...]（5 分钟内最多 3 条）
    this._idleNoteAt = 0;                         // 防打扰提示限流
    this._modelMenuAt = 0;
    this._modelRefreshAt = 0;
    this.planState = null;            // 最近一次套餐探针结果（null = 还没查过/查不到）
    this._planProbeAt = 0;
    this._planProbeBusy = false;
    this._planTimer = null;
    this._planRefreshArmed = true;    // 到点后只自动刷一次模型列表
    this._modelHoldUntil = 0;         // 模型不可用时的排空冷却（到点才允许再试）
    this._refreshing = false;         // 刷新列表进行中（防重入）
    this._helperOpenedSettings = false; // 模型设置页是否由 helper 打开（成对返回用）
    this._modelMenuOk = null;                     // 菜单核验结果：true/false/null（没读出来）
    this._modelMenuBusy = false;
    this._currentWorking = false; // 当前打开的会话是否在 working
    this._lastEvent = '';         // 灯条"最近"一行
    this._drainPromise = null;    // 排空循环（同一时刻只跑一个）
    this.sessionPort = this.config.get('cdpPort');
    this._connectActive = false;
    this._stopped = false;
    // 模型探针状态（VM 实测修复 #1）：available | unavailable | unknown；正信号需连续 2 次确认（滞后防抖）
    this.probeSignal = 'unknown';
    this._probeAvailableStreak = 0;
    this._probeUnknownStreak = 0;
    this._probeTimer = null;

    // 录制与回放都由用户显式触发（或自动回放条件触发），不再有自动翻模式
    this.interceptor = new Interceptor({ queue: this.queue, logger: this.logger, stateMachine: this.stateMachine, engine: this });
    this.player = new Player({
      cdp: this.cdp,
      supervisor: this.supervisor,
      queue: this.queue,
      logger: this.logger,
      stateMachine: this.stateMachine,
      exprs: adapter,
      hooks: {
        currentWorkspacePath: () => this._workspacePath,
        zcodeExePath: () => this._exePath(),
        onWorkspaceChange: path2 => this._onWorkspaceSwitch(path2),
        onModelUnavailable: () => this._onModelUnavailable(),
        userActive: () => this._userActive(),
        verifyModel: () => this._verifyModelForSend(),
        ensureModel: () => this._ensureModelReady(),
        onSessionBusy: sid => { if (sid) this._observedWorking.set(sid, Date.now()); },
      }
    });
    this.indicator = new Indicator(this.cdp, adapter);

    // 事件接线（模式自动翻转已取消：录制/回放都由用户显式触发，或夜间定点触发）
    this.stateMachine.on('change', () => this._applyMode());
    this.queue.on('change', () => { this._broadcast(); this._applyLightBar(); this._drainTick().catch(() => {}); });
    this.logger.on('log', line => this.emit('log', line));
    this.supervisor.on('zcode-exit', () => {
      // ZCode 退出（含用户手动关闭）→ 断开 → UNCONTROLLED（不自动重启，尊重用户意图）
      this.cdp.close('zcode-exit');
      this.indicator.stop();
      this._stopProbe();
      this.stateMachine.setConnection(CONN.UNCONTROLLED, 'zcode-exit');
    });
    this.cdp.on('disconnected', reason => this._onCdpDown(reason));
    this.cdp.on('binding', payload => this.interceptor.handleReport(payload));
  }

  // ---------- 启动 ----------

  async start() {
    this.logger.log('app', { action: 'start', version: adapter.helperVersion, smoke: this.smoke, userData: this.userDataDir });
    this._startPlanProbe();
    await this._startupConnect();
    this._broadcast();
  }

  /** ZCode.exe 路径：优先用配置；为空时自动探测一次并写回配置 */
  _exePath() {
    const configured = String(this.config.get('zcodeExePath') || '').trim();
    if (configured) return configured;
    const found = detectZCodePath();
    if (found) {
      this.config.set({ zcodeExePath: found });
      this.logger.log('supervisor', { action: 'zcode-path-detected', path: found });
    } else {
      this.logger.log('supervisor', { action: 'zcode-path-missing', note: '没找到 ZCode.exe，请在设置里手动指定' });
    }
    return found;
  }

  /** 启动期连接策略（HANDOFF §7）：ZCode 已带端口 → 接管；在跑但无端口 → UNCONTROLLED；未在跑 → 受控拉起 */
  async _startupConnect() {
    if (this.smoke) { // 冒烟测试绝不碰真实 ZCode：不探测、不接管、不拉起
      this.stateMachine.setConnection(CONN.UNCONTROLLED, 'smoke');
      return;
    }
    const base = this.config.get('cdpPort');
    // 1) 探测已存在的 CDP 实例（9222~9231）
    for (let p = base; p < base + 10; p++) {
      const ok = await isPortOpen(p, '127.0.0.1', 500);
      if (!ok) continue;
      const targets = await listPageTargets(p).catch(() => null);
      if (!targets || !targets.length) continue;
      const zt = pickZCodeTarget(targets);
      if (!zt) {
        // 端口被别的 Electron 应用占着（例如自己开发的应用开了 remote debugging）→ 绝不接管
        this.logger.log('cdp', { action: 'skip-foreign-cdp', port: p, urls: targets.slice(0, 3).map(t => t.url) });
        continue;
      }
      this.sessionPort = p;
      this.logger.log('cdp', { action: 'adopt-existing', port: p, url: zt.url });
      this._connectLoop();
      return;
    }
    // 2) ZCode 在跑但无 CDP → 未受控（面板提示 + 重启按钮，绝不静默拉起第二个实例）
    const zcodeRunning = await tasklistHas('ZCode.exe');
    if (zcodeRunning) {
      this.logger.log('cdp', { action: 'zcode-running-without-cdp', port: base });
      this.stateMachine.setConnection(CONN.UNCONTROLLED, 'zcode-running-without-cdp');
      return;
    }
    // 3) ZCode 未在跑 → 受控拉起（正常路径）
    if (this._noLaunch || !this.config.get('autoLaunchZCode')) {
      this.logger.log('cdp', { action: 'skip-launch', why: 'autoLaunchZCode=false' });
      this.stateMachine.setConnection(CONN.UNCONTROLLED, 'launch-disabled');
      return;
    }
    let port = base;
    while (!(await isPortFree(port)) && port < base + 10) port++;
    this.sessionPort = port;
    this._workspacePath = this.config.get('defaultWorkspacePath') || null;
    try {
      const exe = this._exePath();
      if (!exe) {
        this.logger.log('cdp', { action: 'skip-launch', why: 'no-exe-path' });
        this.stateMachine.setConnection(CONN.UNCONTROLLED, 'no-exe-path');
        return;
      }
      this.supervisor.spawnZCode(exe, port, this._workspacePath);
    } catch (e) {
      this.stateMachine.setConnection(CONN.UNCONTROLLED, `spawn-fail: ${e.message}`);
      return;
    }
    this._connectLoop();
  }

  /** 连接循环：直到连上或 engine.stop()；连上后断线也会自动重入（app 崩溃自愈） */
  _connectLoop() {
    if (this._connectActive || this._stopped) return;
    this._connectActive = true;
    let attempts = 0;
    this.logger.log('cdp', { action: 'connect-loop-start', port: this.sessionPort });
    const loop = async () => {
      while (this._connectActive && !this._stopped) {
        if (this.cdp.connected) { this._connectActive = false; return; }
        attempts++;
        try {
          const targets = await listPageTargets(this.sessionPort);
          const target = pickZCodeTarget(targets);
          if (target) {
            await this.cdp.connect(target);
            await this._onConnected();
            this._connectActive = false;
            return;
          }
        } catch (e) {
          if (attempts === 1 || attempts % 20 === 0) {
            this.logger.log('cdp', { action: 'connect-retry', port: this.sessionPort, attempts, error: e.message });
          }
        }
        await sleep(attempts > 30 ? 5000 : 1500);
      }
    };
    loop();
  }

  async _onConnected() {
    const target = this.cdp.target;
    this.logger.log('cdp', { action: 'connected', port: this.sessionPort, url: target && target.url, title: target && target.title });
    // 双保险：URL 白名单之外，进页面再验一次身份（端口可能被别的 Electron 应用接手）
    let ident = null;
    try {
      ident = await this.cdp.evaluate(`(() => ({
        url: location.href,
        title: document.title,
        hasComposer: !!document.querySelector('[data-testid="v4-composer"],[data-testid="chat-model-select-trigger"],[data-testid="chat-attachment-button"]'),
        hasZcode: typeof window.zcode !== 'undefined'
      }))()`, 3000);
    } catch { ident = null; }
    const looksZCode = !!(ident && (ident.hasComposer || ident.hasZcode
      || /zcode/i.test(String(ident.url || '')) || /zcode/i.test(String(ident.title || ''))));
    if (!looksZCode) {
      this.logger.log('cdp', { action: 'target-rejected', url: ident && ident.url, title: ident && ident.title });
      // 之前可能已经注入过灯条/监听 → 能撤就撤，绝不留在别人应用里
      try { await this.cdp.evaluate('window.__zfhTeardown ? (window.__zfhTeardown(), "torn-down") : "none"', 2000); } catch { /* ignore */ }
      try { this.cdp.close('foreign-target'); } catch { /* ignore */ }
      this.stateMachine.setConnection(CONN.UNCONTROLLED, 'foreign-target');
      return;
    }
    this.stateMachine.setConnection(CONN.CONNECTED, 'cdp-connected');
    try {
      await this.cdp.enableDomains();
      await this.cdp.addBinding('zfhReport');
      await this.cdp.addScriptOnNewDocument(adapter.bootstrapSource());
      await this.cdp.evaluate(adapter.bootstrapSource());
    } catch (e) {
      this.logger.log('cdp', { action: 'inject-fail', error: e.message });
    }
    this.indicator.start();
    // 连上后：按"当前对话框有没有可用模型"决定录制的默认开关（只应用一次，用户手动切过就不动）
    this._startProbe();
    this._applyMode();
    this._broadcast();
  }

  _onCdpDown(reason) {
    this.logger.log('cdp', { action: 'disconnected', reason });
    this.indicator.stop();
    this._stopProbe();
    this.stateMachine.setConnection(CONN.UNCONTROLLED, `cdp-down: ${reason}`);
    if (!this._stopped) this._connectLoop(); // app 刷新/短断自愈；进程真死时 loop 空转无害
  }

  /** 用户切换工作区（回放切组后）：重扫 target，必要时重连重注入 */
  async _onWorkspaceSwitch(workspacePath) {
    this._workspacePath = workspacePath;
    this.logger.log('cdp', { action: 'workspace-switch', workspacePath });
    try {
      const targets = await listPageTargets(this.sessionPort);
      const target = pickZCodeTarget(targets);
      if (target && (!this.cdp.target || target.webSocketDebuggerUrl !== this.cdp.target.webSocketDebuggerUrl)) {
        await this.cdp.connect(target);
        await this._onConnected();
      }
    } catch (e) {
      this.logger.log('cdp', { action: 'workspace-rescan-fail', error: e.message });
      throw e; // 上抛给 player 记 failed
    }
  }

  // ---------- 暂停开关 / 模型探针 / working 数 / 排空 ----------

  /** 暂停助手 = 暂停记录：滤网不拦截，消息直接放行给 ZCode（面板/托盘） */
  setHelperPaused(on) {
    this.helperPaused = !!on;
    this.config.set({ helperPaused: this.helperPaused });
    this.logger.log('state', { kind: 'helper-paused', value: this.helperPaused });
    this._applyMode();
    return this.state();
  }
  toggleHelperPaused() { return this.setHelperPaused(!this.helperPaused); }

  /** 暂停输出 = 队列不排空（新消息照常入队）；恢复后立即尝试排空（面板/托盘） */
  setOutputPaused(on) {
    this.outputPaused = !!on;
    this.config.set({ outputPaused: this.outputPaused });
    this.logger.log('state', { kind: 'output-paused', value: this.outputPaused });
    if (this.outputPaused) this.player.abort();
    else this._drainTick().catch(() => {});
    this._applyMode();
    return this.state();
  }
  toggleOutputPaused() { return this.setOutputPaused(!this.outputPaused); }

  /** 灯条"最近"一行（截获/发送/暂停等瞬时事件） */
  noteEvent(text) {
    this._lastEvent = new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5) + ' ' + text;
    this._applyLightBar();
  }

  /** 模型探针循环：纯 DOM 读，零消耗（DESIGN §4 探针；VM 实测修复 #1 主判定） */
  _startProbe() {
    this._stopProbe();
    this.probeSignal = 'unknown';
    this._probeAvailableStreak = 0;
    this._probeUnknownStreak = 0;
    const interval = Math.max(1000, this.config.get('probeIntervalMs') || 5000);
    this._probeTimer = setInterval(() => this._probeTick(), interval);
    setImmediate(() => this._probeTick());
  }

  _stopProbe() {
    if (this._probeTimer) { clearInterval(this._probeTimer); this._probeTimer = null; }
  }

  /** 套餐探针独立计时器：不跟 CDP 探针绑在一起（ZCode 没开调试端口时也要能判断"何时生效"） */
  _startPlanProbe() {
    this._stopPlanProbe();
    this._planTimer = setInterval(() => { this._maybeProbePlan().catch(() => {}); }, 5000);
    setImmediate(() => { this._maybeProbePlan().catch(() => {}); });
  }

  _stopPlanProbe() {
    if (this._planTimer) { clearInterval(this._planTimer); this._planTimer = null; }
  }

  /** 套餐权益还剩多少秒生效（已生效/无套餐 → null） */
  _planEtaSeconds() {
    const st = this.planState;
    if (!st || !st.ok || !st.active || !st.effectiveAt) return null;
    const now = Math.floor(Date.now() / 1000);
    return st.effectiveAt > now ? st.effectiveAt - now : null;
  }

  /** 权益到点：放开模型冷却，必要时立刻刷新一次模型列表 */
  async _onPlanEffective(why) {
    this._modelHoldUntil = 0;
    this.logger.log('probe', { action: 'plan-effective', why, plan: this.planState && this.planState.name });
    if (this.modelState === 'None' && this.queue.pendingSubmits().length && !this._userActive()) {
      const r = await this._refreshModelList().catch(() => null);
      const still = !r || !r.after || String(r.after.text || '').indexOf('管理模型') >= 0;
      if (still) this._holdModel('no-list');
      else this._modelHoldUntil = 0;
    }
  }

  /**
   * 套餐探针（纯 HTTP，不点界面）：
   *  - 每 planProbeSeconds 秒问一次官方接口，只判断"套餐是否生效/何时生效"；
   *  - 失败完全静默，由 DOM 两层判断继续兜底；
   *  - 到点（effective_at）后主动放开模型冷却并刷新一次列表。
   */
  async _maybeProbePlan() {
    const st0 = this.planState;
    const nowSec = Math.floor(Date.now() / 1000);
    if (st0 && st0.ok && st0.active && st0.effectiveAt && nowSec >= st0.effectiveAt && !st0.effectiveHit) {
      st0.effectiveHit = true;
      await this._onPlanEffective('local-timer');
    }
    const n = Number(this.config.get('planProbeSeconds'));
    if (!n || n <= 0) return;
    if (this._planProbeBusy) return;
    if (Date.now() - this._planProbeAt < n * 1000) return;
    this._planProbeAt = Date.now();
    this._planProbeBusy = true;
    try {
      const st = await probePlan({});
      if (!st || !st.ok) return;   // 静默
      const prev = this.planState;
      st.effectiveHit = !!(prev && prev.effectiveHit && prev.effectiveAt === st.effectiveAt);
      this.planState = st;
      if (!prev || prev.name !== st.name || prev.available !== st.available || prev.effectiveAt !== st.effectiveAt) {
        this.logger.log('probe', {
          action: 'plan-state', plan: st.name, status: st.status,
          available: st.available, effectiveAt: st.effectiveAt, endsAt: st.endsAt
        });
      }
      if (st.available && !st.effectiveHit) {
        st.effectiveHit = true;
        await this._onPlanEffective('http');
      }
      this._applyLightBar();
    } finally {
      this._planProbeBusy = false;
    this._planTimer = null;
    }
  }

  async _probeTick() {
    if (this._stopped || !this.cdp.connected) return;
    try {
      let res = null;
      try {
        res = await this.cdp.evaluate(adapter.probeModelSrc(this.config.get('fixedModelId')), 4000);
      } catch { res = null; }
      this._applyProbe(res);
      // 记录为「不可用」时按设置周期刷新列表（点 管理模型 → 模型设置 → 返回工作区）；
      // 优先级低于防打扰：用户正在操作就不刷新；只在"有积压 + 用户空闲 + 到点"时刷新
      if (this.modelState === 'None' && this.queue.pendingSubmits().length && !this._userActive() && this._refreshDue()) {
        const r = await this._refreshModelList().catch(() => null);
        const still = !r || !r.after || String(r.after.text || '').indexOf('管理模型') >= 0;
        if (still) this._holdModel('no-list');
        else this._modelHoldUntil = 0;
      }
      await this._pollCapacity();
      this._drainTick().catch(() => {});
      this._applyLightBar();
    } catch (e) {
      // 探针循环不能因为一次异常就停摆：限流记录后继续下一轮
      if (!this._probeErrAt || Date.now() - this._probeErrAt > 10000) {
        this._probeErrAt = Date.now();
        this.logger.log('probe', { action: 'tick-error', error: String(e && e.message || e).slice(0, 200) });
      }
    }
  }

  _applyProbe(res) {
    let signal = 'unknown';
    let evidence = null;
    if (res && res.unavailable) { signal = 'unavailable'; evidence = res.evidence; }
    else if (res && res.modelHint) { signal = 'available'; evidence = res.modelHint; }
    if (signal === 'available') this._probeAvailableStreak++; else this._probeAvailableStreak = 0;
    if (signal === 'unknown') this._probeUnknownStreak++; else this._probeUnknownStreak = 0;
    if (signal !== this.probeSignal) {
      this.logger.log('probe', { signal, evidence, workspacePath: this._workspacePath, streak: signal === 'available' ? this._probeAvailableStreak : undefined });
      if (signal === 'unknown' && this._probeUnknownStreak >= 3) {
        this.logger.log('probe', { signal: 'adapter-blind', note: '探针连续未命中任何信号，可能需要更新 dom-adapter' });
      }
    }
    this.probeSignal = signal;
    // 模型可用状态：None 或模型名
    let nextModel = signal === 'available' ? ((res && res.modelId) || evidence || 'None') : 'None';
    // 菜单核验（权威）优先：只要菜单给过结论，就以它为准，直到下一次菜单核验覆盖
    if (this._modelMenuOk !== null) {
      nextModel = this._modelMenuOk ? this._modelCandidates()[0] : 'None';
    }
    if (nextModel !== this.modelState) {
      this.modelState = nextModel;
      this.logger.log('probe', { action: 'model-state', model: this.modelState, signal });
    }
  }

  /** 读 working 数（侧栏 spinner + 当前会话 chat-loading），推给页面滤网与灯条 */
  async _pollCapacity() {
    let working = 0;
    let currentWorking = false;
    let states = [];
    try { states = await this.cdp.evaluate(adapter.sessionStatesSrc, 2500) || []; } catch { states = []; }
    const workingSet = new Set(Array.isArray(states) ? states.filter(x => x && x.working).map(x => x.sid) : []);
    let curSid = null;
    try {
      const snap = await this.cdp.evaluate(adapter.snapshotSrc, 2500);
      curSid = snap && snap.session && snap.session.sessionId || null;
      this._currentSessionId = curSid;
      this._currentSessionTitle = (snap && snap.session && snap.session.sessionTitle) || null;
    } catch { /* ignore */ }
    try {
      const cl = await this.cdp.evaluate(adapter.chatLoadingSrc, 2000);
      currentWorking = !!(cl && cl.working);
    } catch { /* ignore */ }
    // 侧栏对"当前会话"可能只显示未读点，不计 spinner → 用 chat-loading 补上
    if (currentWorking && curSid) workingSet.add(curSid);
    // 回放时观察到"正在跑"的会话也并入（5 秒内有效）
    for (const [sid, ts] of this._observedWorking) {
      if (Date.now() - ts < 5000) workingSet.add(sid); else this._observedWorking.delete(sid);
    }
    working = workingSet.size;
    this._workingCount = working;
    this._currentWorking = currentWorking;
    this._autoContinueFromDots(states);
  }

  /** 系统级键鼠活动判定：用户刚操作过（任意程序）就不自动发消息 / 不弹菜单 */
  _userActive() {
    const guard = Number(this.config.get('idleGuardSeconds'));
    if (!guard || !this._systemIdleSeconds) return false;
    let idle = null;
    try { idle = this._systemIdleSeconds(); } catch { idle = null; }
    if (idle === null || !Number.isFinite(idle)) return false;
    return idle < guard;
  }

  /** 红点 → 在队列最前插入「继续」（同一 session 去重；5 分钟内最多 3 条） */
  _autoContinueFromDots(states) {
    if (!Array.isArray(states) || !states.length) return;
    for (const st of states) {
      if (!st || !st.sid) continue;
      if (st.dot !== 'error') { this._autoContinueHandled.delete(st.sid); continue; }
      if (this._autoContinueHandled.has(st.sid)) continue;
      const pending = this.queue.pendingSubmits();
      if (pending.some(i => i.sessionId === st.sid && String(i.text || '').trim() === '继续')) {
        this._autoContinueHandled.add(st.sid);
        continue;
      }
      const now = Date.now();
      const times = (this._autoContinueTimes.get(st.sid) || []).filter(t => now - t < 5 * 60000);
      if (times.length >= 3) {
        this._autoContinueHandled.add(st.sid);
        this.logger.log('queue', { action: 'auto-continue-limit', sessionId: st.sid, inWindow: times.length });
        continue;
      }
      times.push(now);
      this._autoContinueTimes.set(st.sid, times);
      const keyPath = st.key && st.key.lastIndexOf(':') > 1 ? st.key.slice(0, st.key.lastIndexOf(':')) : null;
      const wsPath = keyPath || this._workspacePath || null;
      const wsName = st.projectName || (wsPath ? String(wsPath).split(/[\\/]+/).filter(Boolean).pop() : null);
      const added = this.queue.addFront({
        workspacePath: wsPath,
        workspaceName: wsName,
        projectId: st.projectId || null,
        sessionId: st.sid,
        sessionTitle: st.title || null,
        source: 'auto',
        text: '继续'
      });
      this._autoContinueHandled.add(st.sid);
      this.logger.log('queue', { action: 'auto-continue', sessionId: st.sid, itemId: added && added.added ? added.added.id : null });
      this.noteEvent('检测到会话出错，已排入「继续」');
    }
  }

  /** 「模型可用性检测」：半角逗号分隔的候选模型名 */
  _modelCandidates() {
    const raw = String(this.config.get('fixedModelId') || '');
    const list = raw.split(',').map(s => s.trim()).filter(Boolean);
    return list.length ? list : ['GLM-5.3-Flash'];
  }

  /** 刷新列表的节奏：modelRefreshSeconds 秒一次（0 = 关闭）；优先级低于防打扰 */
  _refreshDue() {
    const n = Number(this.config.get('modelRefreshSeconds'));
    if (!n || n <= 0) return false;
    return Date.now() - this._modelRefreshAt >= n * 1000;
  }

  /** 读模型触发器状态 */
  async _readModelTrigger() {
    return this.cdp.evaluate(adapter.modelTriggerStateSrc, 2500).catch(() => null);
  }

  /** 打开模型面板 → 读 items → Esc 关闭 */
  async _readModelMenu() {
    const st = await this._readModelTrigger();
    if (!st || !st.visible) return { opened: false, items: [], why: 'no-trigger' };
    await this.cdp.dispatchClick(st.x, st.y);
    await new Promise(r => setTimeout(r, 800));
    const menu = await this.cdp.evaluate(adapter.modelMenuSrc, 3000).catch(() => null);
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
    await new Promise(r => setTimeout(r, 150));
    if (!menu || !menu.open) return { opened: false, items: [], why: 'no-menu' };
    return { opened: true, items: menu.items || [] };
  }

  /** 白名单匹配：按白名单顺序、**完整相等**（区分大小写），跳过禁用项 */
  _matchWhitelist(items) {
    const list = items || [];
    for (const name of this._modelCandidates()) {
      for (const it of list) {
        if (it && it.disabled) continue;
        const tid = String(it.testid || '');
        const id = tid.slice(tid.lastIndexOf(':') + 1);
        const first = String(it.text || '').trim().split(/\s+/)[0];
        if (id === name || first === name) return { name, text: it.text, item: it };
      }
    }
    return null;
  }

  /** 读面板里当前供应商的模型列表 */
  async _readModelList() {
    return this.cdp.evaluate(adapter.modelListSrc, 2500).catch(() => null);
  }

  /** 悬停供应商触发器打开二级菜单，返回供应商列表 */
  async _openProviderMenu() {
    const prov = await this.cdp.evaluate(adapter.modelPanelProviderSrc, 2000).catch(() => null);
    if (!prov || !prov.ok) return null;
    // 先移入附近再移到目标，真实 hover 事件才稳定触发（3.19.1 的 provider 子面板是 hover 弹出）
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: prov.x - 8, y: prov.y, button: 'none' }).catch(() => {});
    await new Promise(r => setTimeout(r, 120));
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: prov.x, y: prov.y, button: 'none' }).catch(() => {});
    await new Promise(r => setTimeout(r, 700));
    let list = await this.cdp.evaluate(adapter.modelProviderListSrc, 2500).catch(() => null);
    if (!list || !list.length) {
      // hover 没触发（动画/时机）→ 用点击兜底
      await this.cdp.dispatchClick(prov.x, prov.y);
      await new Promise(r => setTimeout(r, 800));
      list = await this.cdp.evaluate(adapter.modelProviderListSrc, 2500).catch(() => null);
    }
    return list;
  }

  /** 读面板里当前供应商的模型 */
  async _scanProviderModels(providerText) {
    const list = await this._readModelList();
    return (list || []).map(m => {
      const tid = String(m.testid || '');
      return {
        provider: providerText, providerTid: null,
        name: tid.slice(tid.lastIndexOf(':') + 1),
        text: m.text, testid: tid, checked: m.checked === 'true', disabled: !!m.disabled
      };
    });
  }

  /** 用缓存的最佳匹配直接选模型；命中返回 item，失效返回 null（面板需已打开） */
  async _tryCachedModel(best) {
    if (!best || !best.model) return null;
    const cur = await this.cdp.evaluate(adapter.modelProviderCurrentSrc, 2000).catch(() => null);
    if (!cur || cur !== best.provider) {
      const providers = (await this._openProviderMenu()) || [];
      const prov = providers.find(p => best.providerTid && p.tid === best.providerTid)
        || providers.find(p => p.text === best.provider);
      if (!prov) { this.logger.log('probe', { action: 'model-cache-miss', why: 'provider-gone', best }); return null; }
      if (prov.checked !== 'true') {
        await this.cdp.dispatchClick(prov.x, prov.y);
        await new Promise(r => setTimeout(r, 900));
      }
    }
    const list = (await this._readModelList()) || [];
    const item = list.find(m => String(m.testid || '').split(':').pop() === best.model);
    if (!item) { this.logger.log('probe', { action: 'model-cache-miss', why: 'model-gone', best }); return null; }
    this.logger.log('probe', { action: 'model-cache-hit', provider: best.provider, model: best.model });
    return item;
  }

  /** 扫描所有供应商，收集"供应商 → 模型"全量清单；同时记下原始供应商/模型用于还原 */
  async _scanAllProviders() {
    const originalProvider = await this.cdp.evaluate(adapter.modelProviderCurrentSrc, 2000).catch(() => null);
    const firstList = await this._readModelList() || [];
    const originalModel = (firstList.find(m => m.checked === 'true') || {}).testid
      ? String((firstList.find(m => m.checked === 'true') || {}).testid).split(':').pop()
      : null;
    const providers = (await this._openProviderMenu()) || [];
    const cur = providers.find(p => p.checked === 'true') || null;
    const entries = firstList.map(m => ({
      provider: originalProvider, providerTid: cur && cur.tid,
      name: String(m.testid || '').split(':').pop(), text: m.text,
      testid: m.testid, checked: m.checked === 'true', disabled: !!m.disabled
    }));
    for (const p of providers) {
      if (p.checked === 'true') continue;
      await this.cdp.dispatchClick(p.x, p.y);
      await new Promise(r => setTimeout(r, 900));
      const list = await this._readModelList() || [];
      for (const m of list) {
        entries.push({
          provider: p.text, providerTid: p.tid,
          name: String(m.testid || '').split(':').pop(), text: m.text,
          testid: m.testid, checked: m.checked === 'true', disabled: !!m.disabled
        });
      }
      this.logger.log('probe', { action: 'provider-scan', provider: p.text, models: list.map(m => m.text) });
    }
    return { originalProvider, originalModel, providers, entries };
  }

  /** 切到指定供应商（按 tid），面板需已打开 */
  async _switchProvider(providerTid) {
    if (!providerTid) return false;
    const providers = (await this._openProviderMenu()) || [];
    const t = providers.find(p => p.tid === providerTid);
    if (!t) return false;
    if (t.checked === 'true') return true;
    await this.cdp.dispatchClick(t.x, t.y);
    await new Promise(r => setTimeout(r, 900));
    return true;
  }

  /** 还原到扫描前的「供应商 + 模型」 */
  async _restoreProviderModel(scan) {
    if (!scan) return;
    const providers = (await this._openProviderMenu()) || [];
    const orig = providers.find(p => p.text === scan.originalProvider);
    if (orig) {
      if (orig.checked !== 'true') { await this.cdp.dispatchClick(orig.x, orig.y); await new Promise(r => setTimeout(r, 900)); }
      if (scan.originalModel) {
        const item = await this.cdp.evaluate(adapter.modelItemPickSrc(scan.originalModel), 2000).catch(() => null);
        if (item && item.ok) { await this.cdp.dispatchClick(item.x, item.y); await new Promise(r => setTimeout(r, 600)); }
      }
    }
    this.logger.log('probe', { action: 'provider-restore', provider: scan.originalProvider, model: scan.originalModel });
  }

  /** 全局白名单匹配：按白名单顺序在"全量清单"里找，与供应商遍历顺序无关 */
  _matchWhitelistGlobal(entries) {
    for (const name of this._modelCandidates()) {
      const hit = (entries || []).find(e => !e.disabled && (e.name === name || String(e.text || '').trim().split(/\s+/)[0] === name));
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 刷新模型列表（成对操作）：
   *  - 触发器是「管理模型」：点它 → 进模型设置页 → 点「返回工作区」回到对话；
   *  - 触发器是模型名/「选择模型」：点出面板 → 供应商 → 子菜单「管理模型」→ 设置页 → 返回；
   *  - 只有 helper 自己打开的设置页才会替用户点返回；用户自己开着的一律不动。
   */
  async _refreshModelList() {
    if (this._refreshing) return { ok: false, why: 'busy' };
    this._refreshing = true;
    this._modelRefreshAt = Date.now();
    try {
      const back0 = await this.cdp.evaluate(adapter.settingsBackSrc, 2000).catch(() => null);
      if (back0 && back0.ok) {
        if (!this._helperOpenedSettings) {
          this.logger.log('probe', { action: 'model-refresh', skipped: true, why: 'user-in-settings' });
          return { ok: false, why: 'user-in-settings' };
        }
        await this.cdp.dispatchClick(back0.x, back0.y);
        await new Promise(r => setTimeout(r, 1200));
        this._helperOpenedSettings = false;
        const afterBack = await this._readModelTrigger();
        this.logger.log('probe', { action: 'model-refresh', before: '(settings)', after: afterBack && afterBack.text, back: 'helper' });
        return { ok: true, before: null, after: afterBack };
      }
      const st = await this._readModelTrigger();
      if (!st || !st.visible) return { ok: false, why: 'no-trigger' };
      await this.cdp.dispatchClick(st.x, st.y);
      await new Promise(r => setTimeout(r, 1200));
      let back = await this.cdp.evaluate(adapter.settingsBackSrc, 2500).catch(() => null);
      if (!back || !back.ok) {
        // 面板路径：供应商 → 管理模型 → 设置页
        const prov = await this.cdp.evaluate(adapter.modelPanelProviderSrc, 2500).catch(() => null);
        if (prov && prov.ok) {
          await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: prov.x - 8, y: prov.y, button: 'none' }).catch(() => {});
          await new Promise(r => setTimeout(r, 120));
          await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: prov.x, y: prov.y, button: 'none' }).catch(() => {});
          await new Promise(r => setTimeout(r, 800));
          const mg = await this.cdp.evaluate(adapter.modelPanelManageSrc, 2500).catch(() => null);
          if (mg && mg.ok) {
            await this.cdp.dispatchClick(mg.x, mg.y);
            await new Promise(r => setTimeout(r, 1500));
            back = await this.cdp.evaluate(adapter.settingsBackSrc, 2500).catch(() => null);
          }
        }
      }
      if (back && back.ok) {
        this._helperOpenedSettings = true;
        await this.cdp.dispatchClick(back.x, back.y);
        await new Promise(r => setTimeout(r, 1200));
        this._helperOpenedSettings = false;
      }
      const after = await this._readModelTrigger();
      if (after && after.visible) this._helperOpenedSettings = false;
      this.logger.log('probe', {
        action: 'model-refresh', before: st.text, after: after && after.text,
        enteredSettings: !!(back && back.ok), back: back && back.ok ? 'helper' : 'none'
      });
      return { ok: true, before: st, after };
    } finally {
      this._refreshing = false;
    }
  }

  /** 模型不可用：置状态并开始冷却（避免每秒重试 + 反复切设置页） */
  _holdModel(why) {
    const n = Number(this.config.get('modelRefreshSeconds')) || 60;
    this.modelState = 'None';
    this._modelMenuOk = false;
    this._modelMenuAt = Date.now();
    this._modelHoldUntil = Date.now() + Math.max(30, n) * 1000;
    this.logger.log('probe', { action: 'model-hold', why, holdMs: Math.max(30, n) * 1000 });
    this._applyLightBar();
  }

  /** 发送前确保模型就绪（两层判断）：管理模型→刷新；选择模型→白名单里挑一个；已有快照→直接用 */
  async _ensureModelReady() {
    if (this._modelMenuBusy) return { ok: this._modelMenuOk === true, why: 'busy' };
    // 冷却期内不再重复刷新（否则一次排空会连点三次模型设置页）
    if (Date.now() < this._modelHoldUntil) return { ok: false, why: 'cooling' };
    this._modelMenuBusy = true;
    try {
      let st = await this._readModelTrigger();
      if (!st) return { ok: false, why: 'no-trigger' };
      // 第一层：管理模型 = 没有可用列表 → 刷新一次
      if (st.text.indexOf('管理模型') >= 0) {
        const r = await this._refreshModelList();
        st = (r && r.after) || (await this._readModelTrigger());
        if (!st) return { ok: false, why: 'no-trigger' };
        if (st.text.indexOf('管理模型') >= 0) {
          this._holdModel('no-list');
          return { ok: false, why: 'no-list' };
        }
      }
      // 已经选过（快照）→ 直接用它的名字（value 有值即已选；文案可能是过渡态的混合文本）
      if (st.value) {
        let name = null;
        try { name = decodeURIComponent(st.value).split(':').pop() || null; } catch { name = null; }
        this.modelState = name || st.text;
        this._modelMenuOk = true; this._modelMenuAt = Date.now();
        this._applyLightBar();
        return { ok: true, model: this.modelState, source: 'snapshot' };
      }
      // 第二层：选择模型 → 打开面板 → 当前供应商 → 逐个切换其它供应商找白名单模型
      const st2 = await this._readModelTrigger();
      if (!st2 || !st2.visible) return { ok: false, why: 'no-trigger' };
      await this.cdp.dispatchClick(st2.x, st2.y);
      await new Promise(r => setTimeout(r, 900));
      const opened = await this.cdp.evaluate(adapter.modelMenuSrc, 2500).catch(() => null);
      if (!opened || !opened.open) {
        await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
        this._holdModel('panel-jumped');
        return { ok: false, why: 'no-list' };
      }
      // 先试缓存的最佳匹配（供应商 + 模型名都还在就直接用，不再扫描）
      const best = this.config.get('modelBestMatch');
      if (best && best.model) {
        const cached = await this._tryCachedModel(best);
        if (cached) {
          await this.cdp.dispatchClick(cached.x, cached.y);
          await new Promise(r => setTimeout(r, 700));
          this.modelState = best.model; this._modelMenuOk = true; this._modelMenuAt = Date.now();
          this.logger.log('probe', { action: 'model-state', model: best.model, signal: 'cached', provider: best.provider });
          this._applyLightBar();
          return { ok: true, model: best.model, source: 'cached' };
        }
        // 缓存失效：供应商或该模型不在了 → 清掉，走全量扫描
        this.logger.log('probe', { action: 'model-cache-invalidate', best });
        this.config.set({ modelBestMatch: null });
      }
      // 扫描全部供应商 → 全量清单 → 按白名单顺序全局匹配（与供应商遍历顺序无关）
      const scan = await this._scanAllProviders();
      let pick = this._matchWhitelistGlobal(scan.entries);
      if (!pick) {
        await this._restoreProviderModel(scan);   // 没找到：连模型一起还原
        await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
        await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
        this.logger.log('probe', { action: 'model-no-whitelist', entries: scan.entries.map(e => e.provider + ':' + e.name) });
        this._holdModel('no-whitelist');
        return { ok: false, why: 'no-whitelist' };
      }
      // 切到命中项的供应商，再点该模型
      if (pick.providerTid) await this._switchProvider(pick.providerTid);
      const item = await this.cdp.evaluate(adapter.modelItemPickSrc(pick.name), 2500).catch(() => null);
      if (!item || !item.ok) {
        await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
        await this._restoreProviderModel(scan);
        this._holdModel('pick-failed');
        return { ok: false, why: 'pick-failed' };
      }
      await this.cdp.dispatchClick(item.x, item.y);
      await new Promise(r => setTimeout(r, 700));
      this.modelState = pick.name; this._modelMenuOk = true; this._modelMenuAt = Date.now();
      if (pick.provider && pick.name) {
        this.config.set({ modelBestMatch: { provider: pick.provider, providerTid: pick.providerTid || null, model: pick.name } });
        this.logger.log('probe', { action: 'model-cache-save', provider: pick.provider, model: pick.name });
      }
      this.logger.log('probe', { action: 'model-state', model: pick.name, signal: 'picked', provider: pick.provider });
      this._applyLightBar();
      return { ok: true, model: pick.name, source: 'picked' };
    } finally {
      this._modelMenuBusy = false;
    }
  }

  /** 兼容旧调用：返回布尔（供滤网/灯条用） */
  async _verifyModelForSend() {
    const r = await this._ensureModelReady();
    return !!(r && r.ok);
  }

  /** 防打扰提示：每分钟最多写一条，避免刷屏 */
  _noteIdleSuppressed() {
    const now = Date.now();
    if (now - this._idleNoteAt < 60000) return;
    this._idleNoteAt = now;
    this.logger.log('state', { action: 'idle-suppressed', guardSeconds: this.config.get('idleGuardSeconds') });
    this.noteEvent('你在操作，暂缓自动发送');
  }

  /** 灯条数据（页面滤网的 capacity 也来自这里） */
  _lightBarPayload() {
    const c = this.queue.counts();
    const limit = Number(this.config.get('maxWorkingSessions')) || 2;
    const blocked = this.modelState === 'None' || this._workingCount >= limit;
    const state = this.helperPaused ? 'helper-paused'
      : this.outputPaused ? 'output-paused'
      : (c.pending > 0 && blocked ? 'wait' : 'ok');
    const waitReason = blocked ? (this.modelState === 'None' ? 'model' : 'quota') : null;
    return {
      conn: this.stateMachine.connState === CONN.CONNECTED ? 'on' : 'off',
      helperPaused: this.helperPaused,
      outputPaused: this.outputPaused,
      modelOk: this.modelState !== 'None',
      model: this.modelState,
      working: this._workingCount,
      limit,
      currentWorking: this._currentWorking,
      pending: c.pending,
      drafts: c.draft,
      state,
      waitReason,
      currentPending: this._currentSessionPendingText(),
      planEta: this._planEtaSeconds(),
      last: this._lastEvent
    };
  }

  /** 当前会话下"待发送"的第一条（灯条底部预览用；没有则不显示） */
  _currentSessionPendingText() {
    const sid = this._currentSessionId || null;
    const title = this._currentSessionTitle || null;
    const items = this.queue.pendingSubmits();
    const hit = items.find(i =>
      (sid && i.sessionId === sid) ||
      (!i.sessionId && title && i.sessionTitle && String(i.sessionTitle).trim() === String(title).trim()));
    return hit ? String(hit.text || '') : null;
  }

  _applyLightBar() {
    if (!this.cdp.connected) return;
    try { this.indicator.push(this._lightBarPayload()); } catch { /* ignore */ }
  }

  /** 排空：输出中 + 模型可用 + 有 pending → 交给 player（player 内有并发闸门，会自动等） */
  async _drainTick() {
    if (this._stopped || this.outputPaused) return;
    if (this.stateMachine.connState !== CONN.CONNECTED) return;
    if (!this.queue.pendingSubmits().length) return; // 没有积压就不必打扰用户，也不必记日志
    if (this._userActive()) { this._noteIdleSuppressed(); return; }
    if (Date.now() < this._modelHoldUntil) return;   // 模型不可用：冷却中，别反复刷列表
    if (this._drainPromise || this._drainChecking) return;
    this._drainChecking = true;
    try {
      this._drainPromise = this.player.replay('auto')
        .catch(e => this.logger.log('replay', { action: 'crash', error: e.message }))
        .finally(() => {
          this._drainPromise = null;
          this._applyLightBar();
          this._broadcast();
        });
    } finally {
      this._drainChecking = false;
    }
  }

  // ---------- 模式应用 ----------

  /** 把 helper 侧状态翻译为注入侧模式并落地（判断在 helper，AGENTS.md 硬规则 4） */
  _applyMode() {
    const injectedMode = this._injectedMode();
    if (this.cdp.connected) {
      this.cdp.evaluate(adapter.setModeSrc(injectedMode), 3000).catch(() => { /* 重连后再应用 */ });
      this._applyLightBar();
    }
    this._broadcast();
  }

  _injectedMode() {
    const sm = this.stateMachine;
    if (sm.connState !== CONN.CONNECTED) return 'uncontrolled';
    return this.helperPaused ? 'paused' : 'recording';
  }

  refreshIndicator() {
    this._applyLightBar();
  }

  /** 当前工作区路径（interceptor 记队列上下文用） */
  currentWorkspacePath() {
    return this._workspacePath;
  }

  /** 截获后清空 composer：Ctrl+A → Backspace 真实按键（Lexical 只认这条路径，与回放清空一致） */
  async clearComposerAfterCapture() {
    if (!this.cdp.connected) return false;
    try {
      await this.cdp.evaluate(adapter.composerFocusSrc, 2000);
      for (let attempt = 1; attempt <= 2; attempt++) {
        await this.cdp.selectAllInFocused();
        await this.cdp.pressBackspace();
        await sleep(120);
        const snap = await this.cdp.evaluate(adapter.snapshotSrc, 2000);
        if (!snap || !((snap.text || '').trim())) return true;
      }
      this.logger.log('capture', { action: 'clear-after-capture-fail' });
      return false;
    } catch (e) {
      this.logger.log('capture', { action: 'clear-after-capture-error', error: e.message });
      return false;
    }
  }

  /** 辅助信号：回放失败因模型不可用 → 只记录（队列条目已标 failed，用户可再回放） */
  _onModelUnavailable() {
    this.logger.log('state', { kind: 'model-unavailable', note: '回放失败：模型不可用' });
  }

  // ---------- 对 UI 暴露的操作 ----------

  state() {
    return {
      ...this.stateMachine.snapshot(),
      helperPaused: this.helperPaused,
      outputPaused: this.outputPaused,
      showOutputSwitch: !!this.config.get('showOutputSwitch'),
      modelState: this.modelState,
      working: this._workingCount,
      maxWorking: Number(this.config.get('maxWorkingSessions')) || 2,
      currentWorking: this._currentWorking,
      lastEvent: this._lastEvent,
      probeSignal: this.probeSignal,
      cdpPort: this.sessionPort,
      zcodeRunning: this.supervisor.isRunning,
      workspacePath: this._workspacePath,
      counts: this.queue.counts(),
      injectedMode: this._injectedMode(),
      playerRunning: this.player.isRunning
    };
  }

  recentEvents(limit) {
    return this.logger.recentEvents(limit);
  }

  queueView() {
    try { this.fillQueueWorkspaces(); } catch { /* 补全失败不影响展示 */ }
    return this.queue.all();
  }

  /** 受控重启（用户确认任务完结后点击，HANDOFF §7）：结束 ZCode → 带端口重启 → 自动重连 */
  async restartZCode() {
    this.logger.log('supervisor', { action: 'controlled-restart-requested' });
    this.cdp.close('controlled-restart');
    this.indicator.stop();
    this._stopProbe();
    this.stateMachine.setConnection(CONN.UNCONTROLLED, 'restarting');
    try {
      await this.supervisor.killZCode();
    } catch (e) {
      this.logger.log('supervisor', { action: 'kill-fail', error: e.message });
    }
    let port = this.config.get('cdpPort');
    let n = 0;
    while (!(await isPortFree(port)) && n < 10) { port++; n++; }
    this.sessionPort = port;
    try {
      const exe = this._exePath();
      if (!exe) {
        this.logger.log('supervisor', { action: 'restart-skip', why: 'no-exe-path' });
        this.stateMachine.setConnection(CONN.UNCONTROLLED, 'no-exe-path');
        return this.state();
      }
      this.supervisor.spawnZCode(exe, port, this._workspacePath);
    } catch (e) {
      this.stateMachine.setConnection(CONN.UNCONTROLLED, `restart-spawn-fail: ${e.message}`);
      return this.state();
    }
    this._connectLoop();
    return this.state();
  }

  // 队列操作（面板/队列窗口）
  setQueueStatus(id, status) {
    const ok = this.queue.setStatus(id, status, {});
    if (ok) this.logger.log('queue', { action: 'status', id, status });
    return ok;
  }
  removeQueueItem(id) {
    const ok = this.queue.remove(id);
    if (ok) this.logger.log('queue', { action: 'remove', id });
    return ok;
  }
  resetFailed() {
    const n = this.queue.resetAllFailed();
    this.logger.log('queue', { action: 'reset-all-failed', count: n });
    return n;
  }
  /** 给缺 workspacePath 的条目从会话元数据补全（录制升级前的老条目也能在队列里看到"哪个项目"） */
  fillQueueWorkspaces() {
    let changed = 0;
    for (const it of this.queue.all()) {
      if (!it.workspaceName && it.workspacePath) {
        const segs = String(it.workspacePath).split(/[\\/]+/).filter(Boolean);
        if (segs.length) { it.workspaceName = segs[segs.length - 1]; changed++; }
      }
    }
    if (changed) { this.queue._persist(); this.queue._emit(); this.logger.log('queue', { action: 'workspace-backfill', count: changed }); }
    return changed;
  }

  /** 手动"提交"队列里的一条（用户点击，不受自动回放 FIFO 约束）；期间临时关闭录制，避免自己的回车被截获 */
  async submitQueueItem(id) {
    const item = this.queue.get(id);
    if (!item) return { ok: false, why: 'not-found' };
    if (item.type === 'draft') return { ok: false, why: 'is-draft' };
    if (item.status === 'sent') return { ok: false, why: 'already-sent' };
    if (item.status === 'failed') {
      // 失败项允许手动重发：先回到 pending（"提交"按钮此前被这里挡住，2026-11-21 修复）
      if (!this.queue.setStatus(id, 'pending')) return { ok: false, why: 'cannot-requeue' };
      this.logger.log('queue', { action: 'manual-submit-requeue', id });
    }
    if (this.stateMachine.connState !== CONN.CONNECTED) return { ok: false, why: 'uncontrolled' };
    this.logger.log('queue', { action: 'manual-submit', id });
    let r = { sent: false };
    try { r = await this.player.replayOne(item, 'manual-submit'); }
    catch (e) { r = { sent: false, error: e.message }; }
    this.noteEvent('手动提交：' + String(item.text).slice(0, 16));
    this._applyLightBar();
    this._broadcast();
    return { ok: true, ...r };
  }

  /** 草稿"上屏"：把队列里的草稿放回 ZCode 输入框（成功后从队列移除） */
  async screenDraftItem(id) {
    const item = this.queue.get(id);
    if (!item || item.type !== 'draft') return { ok: false, why: 'not-draft' };
    if (this.stateMachine.connState !== CONN.CONNECTED) return { ok: false, why: 'uncontrolled' };
    const r = await this.player.screenDraft(item, 'manual-screen');
    if (r && r.ok) {
      this.queue.remove(id);
      this.logger.log('queue', { action: 'draft-screened-removed', id });
    }
    this._broadcast();
    return r;
  }

  /** 清空已发送条目（面板/队列窗口按钮） */
  clearSent() {
    const n = this.queue.clearSent();
    this.logger.log('queue', { action: 'clear-sent', count: n });
    return n;
  }

  // 配置
  getConfig() { return this.config.get(); }
  setConfig(patch) {
    const prev = this.config.get();
    const next = this.config.set(patch);
    this.logger.log('app', { action: 'config-update', keys: Object.keys(patch || {}) });
    if (prev.probeIntervalMs !== next.probeIntervalMs) {
      if (this.cdp.connected) this._startProbe(); // 重建探针（周期变更）
    }
    if (prev.maxWorkingSessions !== next.maxWorkingSessions) this._applyLightBar();
    this._applyMode();
    this._drainTick().catch(() => {});
    return next;
  }

  // export（HANDOFF §6.5）
  exportBundle() {
    const file = this.logger.exportBundle({
      appVersion: adapter.helperVersion,
      state: this.state(),
      config: this.config.get(),
      queue: this.queue.all()
    });
    this.logger.log('app', { action: 'export', file });
    return file;
  }

  _broadcast() {
    this.emit('state', this.state());
  }

  stop() {
    this._stopped = true;
    this._connectActive = false;
    this.indicator.stop();
    this._stopProbe();
    this._stopPlanProbe();
    this.cdp.close('helper-quit');
    this.supervisor.dispose();
    this.logger.log('app', { action: 'stop', note: 'helper 退出，保留 ZCode 运行' });
    this.logger.close();
  }
}

module.exports = { Engine };
