'use strict';
/**
 * capture-model-panel.js — 等"回到对话页"后，点一次模型触发器，记录它到底是
 *   ① 弹出模型选择面板（[role=menu]，列出可用模型），还是
 *   ② 直接跳到「模型设置」页（出现 settings-back-button）。
 * 之后继续只读采样（每 15s），记录每个 session 的触发器文本/菜单状态，验证"快照按会话保存"。
 *
 * 用法：node scripts/capture-model-panel.js --seconds 15 --minutes 40
 * 产物：logs/model-panel-<stamp>.jsonl
 */
const fs = require('fs');
const path = require('path');
const { CdpClient, listPageTargets, pickMainTarget } = require('../src/cdp-client');

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SEC = Number(argOf('seconds', 15));
const MIN = Number(argOf('minutes', 40));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const FILE = path.join(__dirname, '..', 'logs', `model-panel-${stamp}.jsonl`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const readState = cdp => cdp.evaluate(`(() => {
  const norm = s => String(s || '').replace(/\\s+/g, ' ').trim();
  const t = document.querySelector('[data-testid="chat-model-select-trigger"]');
  const banners = [...document.querySelectorAll('[data-testid="chat-error-banner"], [data-testid="v4-session-quota-banner"]')]
    .map(b => ({ tid: b.getAttribute('data-testid'), code: b.getAttribute('data-error-code'), text: norm(b.innerText).slice(0, 120) }));
  return {
    t: Date.now(),
    inSettings: !!document.querySelector('[data-testid="settings-back-button"]'),
    composer: !!document.querySelector('[data-testid="v4-composer"]'),
    chatEmpty: !!document.querySelector('[data-testid="chat-empty"]'),
    menuOpen: !!document.querySelector('[role="menu"]'),
    trigger: t ? { text: norm(t.innerText).slice(0, 40), value: t.getAttribute('data-model-current-value'), haspopup: t.getAttribute('aria-haspopup'), rect: (() => { const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width) }; })() } : null,
    sid: (() => { try { return window.__zfh.snapshot().session.sessionId; } catch (e) { return null; } })(),
    banners
  };
})()`);

const dumpMenu = cdp => cdp.evaluate(`(() => {
  const norm = s => String(s || '').replace(/\\s+/g, ' ').trim();
  const menu = document.querySelector('[role="menu"], [data-radix-menu-content]');
  const items = [...document.querySelectorAll('[data-testid^="chat-model-select-item-"], [role="menuitemradio"], [role="menuitem"]')].map(el => ({
    testid: el.getAttribute('data-testid'), role: el.getAttribute('role'),
    text: norm(el.innerText).slice(0, 80),
    checked: el.getAttribute('aria-checked'),
    disabled: el.getAttribute('aria-disabled') || el.getAttribute('data-disabled') || el.disabled === true
  }));
  return { found: !!menu, items, html: menu ? menu.outerHTML.slice(0, 8000) : null };
})()`);

(async () => {
  const cdp = new CdpClient();
  await cdp.connect(pickMainTarget(await listPageTargets(9222)));
  const endAt = Date.now() + MIN * 60000;
  let capturedFor = null;   // 已对哪个 trigger 状态采过菜单
  let lastCaptureAt = 0;    // 上次点击时间
  let lastResult = null;    // 'jumped-to-settings' 时允许过几分钟再试（用户可能刚配好供应商）
  let n = 0;
  while (Date.now() < endAt) {
    const st = await readState(cdp).catch(() => null);
    if (!st) { await sleep(5000); continue; }
    const key = `${st.sid}|${st.trigger && st.trigger.text}|${(st.banners || []).map(b => b.code || b.tid).join(',')}`;
    const line = { sample: ++n, at: new Date().toISOString(), state: st, action: null };
    // 回到对话页、还没采过这个状态 → 点一次触发器
    const retry = lastResult === 'jumped-to-settings' && Date.now() - lastCaptureAt > 120000;
    if (!st.inSettings && st.composer && st.trigger && !st.menuOpen && (capturedFor !== key || retry)) {
      capturedFor = key;
      lastCaptureAt = Date.now();
      await cdp.dispatchClick(st.trigger.rect.x, st.trigger.rect.y).catch(() => {});
      await sleep(900);
      const after = await readState(cdp).catch(() => null);
      const menu = after && after.menuOpen ? await dumpMenu(cdp).catch(() => null) : null;
      line.action = 'click-trigger';
      line.after = after;
      line.menu = menu;
      // 跳到设置页 or 弹出面板
      line.result = after && after.inSettings ? 'jumped-to-settings' : (menu && menu.found ? 'opened-panel' : 'nothing');
      lastResult = line.result;
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
      await sleep(300);
      fs.appendFileSync(FILE, JSON.stringify(line) + '\n');
      const items = (menu && menu.items || []).map(i => `${i.text}${i.disabled ? '[禁用]' : ''}${i.checked === 'true' ? '[已选]' : ''}`).join(' | ');
      console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] click sid=${st.sid} trig=${st.trigger.text} → ${line.result} items=${(menu && menu.items || []).length} ${items.slice(0, 220)}`);
    } else {
      fs.appendFileSync(FILE, JSON.stringify(line) + '\n');
      const b = (st.banners || []).map(x => `${x.tid}${x.code ? '/' + x.code : ''}`).join(',');
      console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] sid=${st.sid} trig=${st.trigger ? st.trigger.text : '-'} settings=${st.inSettings} banners=${b || '-'}`);
    }
    await sleep(SEC * 1000);
  }
  console.log('[done]', FILE);
  cdp.close('done');
})().catch(e => { console.log('ERR', e && e.message || e); process.exit(1); });
