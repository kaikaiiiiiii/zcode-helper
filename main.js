'use strict';
/**
 * main.js — Electron 主进程入口
 * 窗口：浮窗式状态面板（小窗、可置顶、关闭到托盘）、设置窗口、队列查看窗口（均按需创建）。
 * 托盘：状态色图标 + 常用操作菜单（右下角托盘区，DESIGN §7 退出流程 / §8 面板）。
 * 引擎：src/engine.js（录制/回放/受控启动，全部经 CDP）。
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, shell, powerMonitor } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { Engine } = require('./src/engine'); // 纯 Node 模块，顶层引入安全
const adapter = require('./src/dom-adapter');

const IS_SMOKE = process.argv.includes('--smoke');
const IS_DEBUG = process.argv.includes('--debug'); // --debug 保留默认菜单（含 DevTools）；交付形态无菜单
const ASSETS = path.join(__dirname, 'assets');

app.setName('ZCode Helper');

/**
 * 改名迁移：%APPDATA%\zcode-freeplan-helper、%APPDATA%\zcode-helper → %APPDATA%\ZCode Helper
 * 只搬配置/队列/日志，目标已存在则不覆盖；迁移失败不影响启动。
 */
function migrateUserData() {
  try {
    const newDir = app.getPath('userData');
    // 从新到旧：zcode-helper 更近，优先它的配置，避免被更早的目录覆盖
    for (const legacy of ['zcode-helper', 'zcode-freeplan-helper']) {
      const oldDir = path.join(app.getPath('appData'), legacy);
      if (path.resolve(oldDir) === path.resolve(newDir)) continue;
      if (!fs.existsSync(oldDir)) continue;
      fs.mkdirSync(newDir, { recursive: true });
      for (const name of ['config.json', 'queue.jsonl']) {
        const from = path.join(oldDir, name);
        const to = path.join(newDir, name);
        if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
      }
      const oldLogs = path.join(oldDir, 'logs');
      const newLogs = path.join(newDir, 'logs');
      if (fs.existsSync(oldLogs) && !fs.existsSync(newLogs)) fs.cpSync(oldLogs, newLogs, { recursive: true });
    }
  } catch { /* 迁移失败：按全新安装处理 */ }
}
migrateUserData();
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
if (!IS_DEBUG) Menu.setApplicationMenu(null);

// 开发测试阶段（源码运行，app.isPackaged=false）日志落代码库 logs/；打包后自动回到 userData（2026-11-19 用户决定）
const DEV_LOG_DIR = app.isPackaged ? null : path.join(__dirname, 'logs');

let engine = null;
let panelWin = null;
let settingsWin = null;
let queueWin = null;
let tray = null;
let quitting = false;

// ---------- 窗口 ----------

function broadcast(channel, payload) {
  for (const w of [panelWin, settingsWin, queueWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function loadPage(win, file) {
  win.loadFile(path.join(__dirname, 'ui', file));
}

function createPanel() {
  if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); return panelWin; }
  panelWin = new BrowserWindow({
    width: 380,
    height: 520,
    title: 'ZCode Helper',
    alwaysOnTop: engine ? engine.config.get('panelAlwaysOnTop') : true,
    skipTaskbar: true, // 浮窗形态：常驻托盘，不占任务栏
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    icon: stateIconPath('brand'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loadPage(panelWin, 'panel.html');
  panelWin.on('close', e => {
    // 关闭到托盘（DESIGN §8 最小化到托盘），真正退出走托盘菜单
    if (!quitting) {
      e.preventDefault();
      panelWin.hide();
    }
  });
  return panelWin;
}

function createSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return settingsWin; }
  settingsWin = new BrowserWindow({
    width: 460,
    height: 700,
    title: '设置 — ZCode Helper',
    parent: panelWin || undefined,
    show: false,
    resizable: false,
    maximizable: false,
    icon: stateIconPath('brand'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loadPage(settingsWin, 'settings.html');
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('close', e => {
    if (!quitting) { e.preventDefault(); settingsWin.hide(); }
  });
  return settingsWin;
}

function createQueue() {
  if (queueWin && !queueWin.isDestroyed()) { queueWin.show(); queueWin.focus(); return queueWin; }
  queueWin = new BrowserWindow({
    width: 640,
    height: 520,
    title: '队列 — ZCode Helper',
    show: false,
    icon: stateIconPath('brand'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loadPage(queueWin, 'queue.html');
  queueWin.once('ready-to-show', () => queueWin.show());
  queueWin.on('close', e => {
    if (!quitting) { e.preventDefault(); queueWin.hide(); }
  });
  return queueWin;
}

function showOrOpen(name) {
  if (name === 'panel') createPanel();
  else if (name === 'settings') createSettings();
  else if (name === 'queue') createQueue();
}

/** 导出诊断包：写文件 + 打开所在文件夹 + 弹窗告知路径（入口在设置窗口） */
async function doExport(parent) {
  if (!engine) return null;
  const file = engine.exportBundle();
  try { shell.showItemInFolder(file); } catch { /* 打开文件夹失败不影响导出 */ }
  try {
    const win = parent && !parent.isDestroyed() ? parent : (BrowserWindow.getFocusedWindow() || null);
    const opts = {
      type: 'info',
      title: '诊断包已导出',
      message: file,
      detail: '已打开所在文件夹。把整个文件发给开发侧即可复现问题。',
      buttons: ['好']
    };
    await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
  } catch { /* ignore */ }
  return file;
}

// ---------- 托盘 ----------

function stateIconPath(state) {
  // assets/tray-<color>.png 由 scripts/gen-icon.js 生成
  const map = { ok: 'tray-green.png', waiting: 'tray-yellow.png', 'output-paused': 'tray-red.png', 'helper-paused': 'tray-gray.png', uncontrolled: 'tray-gray.png', brand: 'icon.png' };
  const file = map[state] || 'tray-gray.png';
  const p = path.join(ASSETS, file);
  return fs.existsSync(p) ? p : path.join(ASSETS, 'icon.png');
}

function trayStateOf(st) {
  if (!st || st.connState !== 'CONNECTED') return 'uncontrolled';
  if (st.helperPaused) return 'helper-paused';
  if (st.outputPaused) return 'output-paused';
  if (st.counts && (st.counts.pending > 0 || st.counts.failed > 0)) return 'waiting';
  return 'ok';
}

function createTray() {
  if (!fs.existsSync(stateIconPath('brand'))) return; // 图标未生成（首次开发期），托盘静默缺失
  tray = new Tray(stateIconPath('brand'));
  tray.setToolTip('ZCode Helper');
  tray.on('click', () => {
    // 左键：切换面板显示/隐藏
    if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) panelWin.hide();
    else showOrOpen('panel');
  });
  rebuildTrayMenu({ counts: { pending: 0, sent: 0, failed: 0, draft: 0 }, connState: 'UNCONTROLLED', helperPaused: false, outputPaused: false, modelState: 'None' });
}

function rebuildTrayMenu(st) {
  if (!tray) return;
  const state = trayStateOf(st);
  tray.setImage(stateIconPath(state));
  const stateLabel = { ok: '🟢 输出中', waiting: '🟡 等待名额', 'output-paused': '🔴 输出已暂停', 'helper-paused': '⏸ 助手已暂停', uncontrolled: '⚪ 未受控' }[state];
  tray.setToolTip(`ZCode Helper — ${stateLabel}（工作中 ${st && typeof st.working === 'number' ? st.working : 0}/${st && st.maxWorking ? st.maxWorking : 2} · 待发 ${st && st.counts ? st.counts.pending : 0}）`);

  const controlled = !!(st && st.connState === 'CONNECTED');
  const template = [
    { label: '显示面板', click: () => showOrOpen('panel') },
    { label: st && st.helperPaused ? '启动 ZCode 助手' : '暂停 ZCode 助手', click: () => engine && engine.toggleHelperPaused() },
    { label: st && st.outputPaused ? '继续输出' : '暂停输出', click: () => engine && engine.toggleOutputPaused() },
    { label: `查看队列(${st && st.counts ? ((st.counts.pending || 0) + (st.counts.draft || 0)) : 0})`, click: () => showOrOpen('queue') }
  ];
  // 已受控时不需要"重启受控 ZCode"
  if (!controlled) template.push({ label: '重启受控 ZCode', click: () => engine && engine.restartZCode() });
  template.push(
    { type: 'separator' },
    { label: '设置', click: () => showOrOpen('settings') },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------

function registerIpc() {
  const h = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
    if (!engine) return { ok: false, why: 'engine-not-ready' };
    return Promise.resolve(fn(...args)).catch(err => ({ ok: false, why: err.message }));
  });

  h('zfh:getState', () => engine.state());
  h('zfh:getRecent', (limit) => engine.recentEvents(limit || 20));
  h('zfh:getQueue', () => engine.queueView());
  h('zfh:queueAction', ({ id, action }) => {
    if (action === 'remove') return engine.removeQueueItem(id);
    if (action === 'requeue') return engine.setQueueStatus(id, 'pending');
    if (action === 'submit') return engine.submitQueueItem(id);
    if (action === 'screen') return engine.screenDraftItem(id);
    return false;
  });
  h('zfh:resetFailed', () => engine.resetFailed());
  h('zfh:clearSent', () => engine.clearSent());
  h('zfh:toggleHelperPaused', () => engine.toggleHelperPaused());
  h('zfh:toggleOutputPaused', () => engine.toggleOutputPaused());
  h('zfh:restartZCode', () => engine.restartZCode());
  h('zfh:getConfig', () => engine.getConfig());
  h('zfh:setConfig', patch => {
    const next = engine.setConfig(patch);
    if (panelWin && !panelWin.isDestroyed()) panelWin.setAlwaysOnTop(next.panelAlwaysOnTop);
    return next;
  });
  h('zfh:pickPath', async kind => {
    const r = await dialog.showOpenDialog(settingsWin || panelWin, kind === 'exe'
      ? { title: '选择 ZCode.exe', properties: ['openFile'], filters: [{ name: '可执行文件', extensions: ['exe'] }] }
      : { title: '选择默认工作区目录', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('zfh:exportBundle', () => doExport());
  h('zfh:openWindow', name => { showOrOpen(name); return true; });
  ipcMain.on('zfh:hide-self', e => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.hide();
  });
}

// ---------- 冒烟测试（--smoke：绝不触碰现有 ZCode） ----------

async function runSmoke() {
  const checks = [];
  const check = (name, ok, extra) => {
    checks.push({ name, ok, extra });
    console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`);
  };
  try {
    // 冒烟用临时 userData：不碰真实队列/配置/日志（可重复跑，结果与现场状态无关）
    const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-smoke-'));
    engine = new Engine(smokeDir, { smoke: true, logDir: path.join(smokeDir, 'logs') });
    // 1) 配置读写
    const cfg = engine.getConfig();
    check('config.defaults', cfg.cdpPort === 9222 && cfg.fixedModelId === 'GLM-5.3-Flash', cfg.modeSchedule);
    const cfg2 = engine.setConfig({ probeIntervalMs: 3000, modeSchedule: { activeFrom: '23:00', activeTo: '06:00' } });
    check('config.set', cfg2.probeIntervalMs === 3000 && cfg2.modeSchedule.activeTo === '06:00');
    engine.setConfig({ probeIntervalMs: 5000, modeSchedule: { activeFrom: '23:00', activeTo: '23:59' } });
    // 2) 队列增删/去重/状态推进
    const q = engine.queue;
    const a = q.add({ workspacePath: 'D:\\x', source: 'intercept', text: 'hello' });
    const b = q.add({ workspacePath: 'D:\\x', source: 'snapshot', text: 'hello' });
    check('queue.snapshot-dedup', a.added && b.deduped === a.added.id);
    const c = q.add({ workspacePath: 'D:\\x', source: 'intercept', text: 'world' });
    check('queue.add-second', !!c.added);
    check('queue.status-flow', q.setStatus(c.added.id, 'sent') && !q.setStatus(c.added.id, 'pending'));
    check('queue.counts', q.counts().pending === 1 && q.counts().sent === 1, q.counts());
    q.remove(a.added.id); q.remove(c.added.id);
    // 3) 时间表（含跨午夜）
    const { Scheduler } = require('./src/scheduler');
    const sch = new Scheduler(engine.config, () => {});
    const mk = hm => { const [H, M] = hm.split(':').map(Number); const d = new Date(); d.setHours(H, M, 0, 0); return d; };
    engine.config.data.modeSchedule = { activeFrom: '23:00', activeTo: '23:59' };
    check('schedule.in-window', sch.expectedMode(mk('23:30')) === 'PLAYING');
    check('schedule.out-window', sch.expectedMode(mk('12:00')) === 'RECORDING');
    engine.config.data.modeSchedule = { activeFrom: '23:00', activeTo: '06:00' };
    check('schedule.midnight-cross', sch.expectedMode(mk('02:00')) === 'PLAYING' && sch.expectedMode(mk('12:00')) === 'RECORDING');
    engine.config.data.modeSchedule = { activeFrom: '23:00', activeTo: '23:59' };
    // 4) 注入脚本源可用（含 VM 修复新增的探针/清空/会话定位）
    const bs = adapter.bootstrapSource();
    check('bootstrap.source', bs.includes('zfhReport') && bs.includes('probeModel') && bs.includes('clearComposer') && bs.includes('debugDom') && adapter.snapshotSrc.includes('__zfh'));
    // 5) 引擎启动（smoke 不拉起 ZCode → 未受控，不触碰现有 ZCode）
    await engine.start();
    await new Promise(r => setTimeout(r, 1200));
    const st = engine.state();
    check('engine.state-uncontrolled', st.connState === 'UNCONTROLLED', { reason: st.lastReason, port: st.cdpPort });
    engine.stop();
    check('engine.stop', true);
    // 清理临时目录（引擎已 stop，日志流已关闭）
    try { fs.rmSync(smokeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  } catch (e) {
    check('smoke.unexpected', false, e.stack || e.message);
  }
  console.log(`[smoke] done: ${checks.filter(c => c.ok).length}/${checks.length} passed`);
  app.exit(checks.every(c => c.ok) ? 0 : 1);
}

// ---------- 生命周期 ----------

app.whenReady().then(async () => {
  registerIpc();
  if (IS_SMOKE) { await runSmoke(); return; }
  engine = new Engine(app.getPath('userData'), {
    logDir: DEV_LOG_DIR,
    // 系统级键鼠空闲秒数（含其它程序里的操作），防打扰闸门用
    systemIdleSeconds: () => powerMonitor.getSystemIdleTime()
  });
  engine.on('state', st => { broadcast('zfh:state', st); rebuildTrayMenu(st); });
  engine.on('log', line => broadcast('zfh:log', line));
  createPanel();
  createTray();
  // 测试钩子：ZFH_OPEN_ALL=1 启动即打开全部窗口（验收设置/队列界面用；队列延迟置顶便于验收）
  if (process.env.ZFH_OPEN_ALL === '1') { showOrOpen('settings'); setTimeout(() => showOrOpen('queue'), 800); }
  engine.start().catch(e => {
    if (engine) engine.logger.log('app', { action: 'start-fail', error: e.message });
  });
});

app.on('second-instance', () => showOrOpen('panel'));
app.on('before-quit', () => {
  quitting = true;
  if (engine) { try { engine.stop(); } catch { /* ignore */ } }
});
app.on('window-all-closed', () => {
  // 托盘常驻：不随窗口关闭退出（面板隐藏、设置/队列关闭均不退出）
  if (quitting) app.quit();
});
