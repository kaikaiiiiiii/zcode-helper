'use strict';
/**
 * readme-shots.js — 生成 README 用的界面截图（panel / queue）
 * 运行：npx electron scripts/readme-shots.js
 * 产物：docs/images/panel.png、docs/images/queue.png（2x）
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const UI = path.join(ROOT, 'ui');
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.disableHardwareAcceleration();

const STATE = {
  connState: 'CONNECTED',
  cdpPort: 9222,
  helperPaused: false,
  outputPaused: false,
  showOutputSwitch: true,
  modelState: 'GLM-5.3-Flash',
  working: 2,
  maxWorking: 2,
  currentWorking: false,
  counts: { pending: 2, draft: 1, sent: 12, failed: 0 }
};

const EVENTS = [
  { ts: Date.now() - 1000, ev: 'capture', accepted: true, holdReason: 'quota' },
  { ts: Date.now() - 2500, ev: 'replay', action: 'wait-concurrency' },
  { ts: Date.now() - 4000, ev: 'capture', accepted: true, holdReason: 'quota' },
  { ts: Date.now() - 4000, ev: 'capture', accepted: true, action: null, text: '继续' },
  { ts: Date.now() - 9000, ev: 'replay', action: 'sent', text: '继续，不要改 Readme 了。' },
  { ts: Date.now() - 15000, ev: 'state', kind: 'output-paused', value: false },
  { ts: Date.now() - 22000, ev: 'probe', action: 'model-state', model: 'GLM-5.3-Flash' },
  { ts: Date.now() - 30000, ev: 'cdp', action: 'connected', port: 9222 }
];

const ITEMS = [
  {
    id: 'q_20261121_182201_4f5a', ts: Date.now() - 60000, status: 'pending', type: 'submit',
    workspacePath: 'D:\\Coding\\Bighub', sessionId: 'sess_aa98c7b3-db2f-451d-aec4-4b5d63545b42',
    sessionTitle: '阅读文档实现 app 与 relay 并记录决策', source: 'intercept', holdReason: 'quota', error: null,
    text: '继续。\n注意保持现有的模块边界，不要为了通过测试去改接口签名。'
  },
  {
    id: 'q_20261121_182233_9c1d', ts: Date.now() - 30000, status: 'pending', type: 'draft',
    workspacePath: 'D:\\Coding\\miscJar', sessionId: 'session_c607e7d0708b66666159c209cc2a67da',
    sessionTitle: '阅读项目总结现状准备接手', source: 'draft', holdReason: null, error: null,
    text: '（这是被暂存的草稿，不会自动发送，可在队列里点「上屏」放回输入框）'
  },
  {
    id: 'q_20261121_181607_2c02', ts: Date.now() - 600000, status: 'sent', type: 'submit',
    workspacePath: 'D:\\Coding\\hash2cdn', sessionId: 'sess_4c4a414f-effe-4249-8440-51a513b81333',
    sessionTitle: '项目功能总结与介绍', source: 'intercept', holdReason: 'model', error: null,
    text: '把构建脚本里的硬编码路径改成相对路径。'
  }
];

async function shot(win, file) {
  await sleep(600);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  console.log('saved', file, img.getSize());
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  process.env.ZFH_SHOTS = JSON.stringify({ state: STATE, events: EVENTS, items: ITEMS });
  // 一次进程只拍一个窗口（同一进程连续 destroy/new 会 ERR_FAILED）
  const which = process.argv.includes('--queue') ? 'queue' : 'panel';
  const isQueue = which === 'queue';
  const win = new BrowserWindow({
    width: isQueue ? 660 : 380, height: isQueue ? 470 : 430, show: false, frame: false, useContentSize: true,
    backgroundColor: '#1b1b1f',
    webPreferences: { preload: path.join(__dirname, 'readme-shots-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  await win.loadFile(path.join(UI, isQueue ? 'queue.html' : 'panel.html'));
  if (!isQueue) {
    // 截图用：事件区不撑满窗口，按内容高度裁窗口，避免大片空白
    await win.webContents.insertCSS('html, body { height: auto !important; } .panel { height: auto !important; } .events { flex: none !important; max-height: 212px !important; }');
    await sleep(150);
    const h = await win.webContents.executeJavaScript('Math.ceil(document.body.scrollHeight)');
    if (h && h > 200) { win.setContentSize(380, h); await sleep(200); }
  }
  await shot(win, isQueue ? 'queue.png' : 'panel.png');
  win.destroy();
  app.quit();
}

app.whenReady().then(main).catch(e => { console.error(e); app.exit(1); });
