'use strict';
/**
 * snapshot-dom.js — 给当前这版 ZCode 存一份 DOM 快照（升级前跑一次，出问题能对照）
 *
 *   node scripts/snapshot-dom.js --tag 3.19.1
 *
 * 产物：logs/dom/snap-<tag>-<时间戳>.json
 * 内容：关键区域 outerHTML + 会话列表摘要 + 适配层各表达式的实际返回。
 * 注意：会点开模型面板、进一次模型设置页再返回（成对操作，不会把界面留在设置页）。
 */
const fs = require('fs');
const path = require('path');
const { CdpClient, listPageTargets, pickMainTarget } = require('../src/cdp-client');
const adapter = require('../src/dom-adapter');

const args = process.argv.slice(2);
const tag = (args.indexOf('--tag') >= 0 ? args[args.indexOf('--tag') + 1] : '') || 'unknown';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT_DIR = path.join(__dirname, '..', 'logs', 'dom');
const CAP = 400 * 1024; // 单段 HTML 上限

const clip = s => (typeof s === 'string' && s.length > CAP ? s.slice(0, CAP) + '\n<!-- truncated -->' : s);

(async () => {
  const cdp = new CdpClient();
  await cdp.connect(pickMainTarget(await listPageTargets(9222)));
  const ev = (expr, ms = 4000) => cdp.evaluate(expr, ms).catch(e => ({ __error: e.message }));
  const snap = { tag, capturedAt: new Date().toISOString(), parts: {}, adapter: {} };

  // ---------- 基础 ----------
  snap.parts.meta = await ev(`(() => ({
    url: location.href, title: document.title,
    ua: navigator.userAgent,
    zcodeVersion: (window.zcode && (window.zcode.version || window.zcode.appVersion)) || null
  }))()`);

  // ---------- 输入框 / 侧栏 ----------
  snap.parts.composer = clip(await ev(`(() => {
    const el = document.querySelector('[data-testid="v4-composer"]') || document.querySelector('.chat-composer-region');
    return el ? el.outerHTML : null;
  })()`));
  snap.parts.sidebar = clip(await ev(`(() => {
    const el = document.querySelector('aside');
    return el ? el.outerHTML : null;
  })()`));
  snap.parts.sessions = await ev(`(() => [].slice.call(document.querySelectorAll('li[data-testid^="task-item-"]')).map(el => ({
    tid: el.getAttribute('data-testid'),
    key: el.getAttribute('data-task-item-key'),
    title: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60)
  })).slice(0, 40))()`);

  // ---------- 模型面板（打开 → 取 HTML → 供应商子面板 → Esc） ----------
  const trig = await ev(adapter.modelTriggerRectSrc);
  if (trig && trig.ok) {
    await cdp.dispatchClick(trig.x, trig.y);
    await sleep(900);
    snap.parts.modelPanel = clip(await ev(`(() => {
      const el = document.querySelector('[data-testid="composer-model-panel"], [role="menu"]');
      return el ? el.outerHTML : null;
    })()`));
    const prov = await ev(adapter.modelPanelProviderSrc);
    if (prov && prov.ok) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: prov.x - 8, y: prov.y, button: 'none' }).catch(() => {});
      await sleep(120);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: prov.x, y: prov.y, button: 'none' }).catch(() => {});
      await sleep(800);
      snap.parts.providerPanel = clip(await ev(`(() => {
        const el = document.querySelector('[data-testid="composer-provider-panel"]');
        if (el) return el.outerHTML;
        const menus = [].slice.call(document.querySelectorAll('[role="menu"]'));
        return menus.length > 1 ? menus[1].outerHTML : (menus[0] ? menus[0].outerHTML : null);
      })()`));
      // 顺手进一次模型设置页（成对返回）
      const mg = await ev(adapter.modelPanelManageSrc);
      if (mg && mg.ok) {
        await cdp.dispatchClick(mg.x, mg.y);
        await sleep(1500);
        snap.parts.settingsPage = clip(await ev(`(() => {
          const el = document.querySelector('main') || document.body;
          return el ? el.outerHTML : null;
        })()`));
        snap.parts.settingsBack = await ev(adapter.settingsBackSrc);
        const back = await ev(adapter.settingsBackSrc);
        if (back && back.ok) { await cdp.dispatchClick(back.x, back.y); await sleep(1200); }
      }
    }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
  }

  // ---------- 适配层表达式实际返回 ----------
  snap.adapter.probeModel = await ev(adapter.probeModelSrc('glm-5.3-flash'));
  snap.adapter.sidebarState = await ev(adapter.sidebarStateSrc);
  snap.adapter.sessionStates = await ev(adapter.sessionStatesSrc);
  snap.adapter.attachments = await ev(adapter.attachmentsStateSrc);
  snap.adapter.chatLoading = await ev(adapter.chatLoadingSrc);
  snap.adapter.workspaceState = await ev(adapter.workspaceStateSrc);
  snap.adapter.modelTriggerState = await ev(adapter.modelTriggerStateSrc);
  snap.adapter.quotaBanner = await ev(adapter.quotaBannerSrc);
  snap.adapter.snapshot = await ev(adapter.snapshotSrc);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `snap-${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(snap, null, 1));
  const size = (fs.statSync(file).size / 1024).toFixed(0);
  console.log('saved', file, `${size} KB`);
  console.log('parts:', Object.keys(snap.parts).filter(k => snap.parts[k]).join(', '));
  cdp.close('snapshot');
  process.exit(0);
})().catch(e => { console.error('SNAPSHOT-ERROR:', e.stack || e.message); process.exit(1); });
