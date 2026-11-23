'use strict';
/**
 * capture-model-transition.js — 定时"点开模型菜单"采样，记录 可用 → 陈旧 → 不可用 的全过程。
 * 用途：免费期结束前后，回答"界面还显示模型时菜单里到底有没有可选项"。
 * 产物：logs/model-transition-<stamp>.jsonl（每行一次采样）
 * 用法：node scripts/capture-model-transition.js --seconds 30 --minutes 20
 */
const fs = require('fs');
const path = require('path');
const { CdpClient, listPageTargets, pickMainTarget } = require('../src/cdp-client');

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SEC = Number(argOf('seconds', 30));
const MIN = Number(argOf('minutes', 20));
const NO_CLICK = process.argv.includes('--no-click'); // 只读：不点菜单，避免观察行为本身刷新状态
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const FILE = path.join(__dirname, '..', 'logs', `model-transition-${stamp}.jsonl`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const readState = cdp => cdp.evaluate(`(() => {
  const norm = s => String(s || '').replace(/\\s+/g, ' ').trim();
  const t = document.querySelector('[data-testid="chat-model-select-trigger"]');
  const banners = [...document.querySelectorAll('[data-testid="chat-error-banner"], [data-testid="v4-session-quota-banner"], [role="alert"]')]
    .map(b => ({ tid: b.getAttribute('data-testid'), code: b.getAttribute('data-error-code'), text: norm(b.innerText).slice(0, 160) }));
  let loading = null;
  try { const c = window.__zfh && window.__zfh.chatLoading ? window.__zfh.chatLoading() : null; loading = c; } catch (e) {}
  const cl = document.querySelector('[data-testid="chat-loading"]');
  return {
    t: Date.now(),
    trigger: t ? { text: norm(t.innerText).slice(0, 60), value: t.getAttribute('data-model-current-value'), aria: t.getAttribute('aria-label') } : null,
    banners,
    chatLoading: cl ? norm(cl.innerText).slice(0, 40) : null,
    probe: window.__zfh && window.__zfh.probeModel ? window.__zfh.probeModel() : null
  };
})()`);

const dumpMenu = cdp => cdp.evaluate(`(() => {
  const norm = s => String(s || '').replace(/\\s+/g, ' ').trim();
  const menu = document.querySelector('[role="menu"], [data-radix-menu-content]');
  if (!menu) return { found: false };
  const items = [...document.querySelectorAll('[data-testid^="chat-model-select-item-"], [role="menuitemradio"], [role="menuitem"]')].map(el => {
    const r = el.getBoundingClientRect();
    return {
      testid: el.getAttribute('data-testid'), role: el.getAttribute('role'),
      text: norm(el.innerText).slice(0, 80),
      checked: el.getAttribute('aria-checked'),
      disabled: el.getAttribute('aria-disabled') || el.getAttribute('data-disabled') || el.disabled === true,
      visible: r.width > 0 && r.height > 0
    };
  });
  const texts = [];
  for (const el of menu.querySelectorAll('*')) {
    const t = norm(el.innerText);
    if (!t || t.length > 100) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 8) continue;
    if (texts.some(x => x.text === t)) continue;
    texts.push({ text: t, cls: String(el.className || '').slice(0, 50) });
  }
  return {
    found: true, items, texts: texts.slice(0, 30),
    hints: texts.map(x => x.text).filter(t => /升级|套餐|不可用|暂无|没有|购买|开通|订阅|额度|限制/.test(t)),
    html: menu.outerHTML.slice(0, 6000)
  };
})()`);

(async () => {
  const cdp = new CdpClient();
  await cdp.connect(pickMainTarget(await listPageTargets(9222)));
  const endAt = Date.now() + MIN * 60000;
  let n = 0;
  while (Date.now() < endAt) {
    const before = await readState(cdp).catch(() => null);
    let menu = { found: false };
    const rect = await cdp.evaluate(`(() => { const t = document.querySelector('[data-testid="chat-model-select-trigger"]'); if (!t) return null; const b = t.getBoundingClientRect(); return b.width ? { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) } : null; })()`).catch(() => null);
    if (rect && !NO_CLICK) {
      await cdp.dispatchClick(rect.x, rect.y).catch(() => {});
      await sleep(900);
      menu = await dumpMenu(cdp).catch(() => ({ found: false }));
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
      await sleep(250);
    }
    const line = { sample: ++n, at: new Date().toISOString(), before, menu };
    fs.appendFileSync(FILE, JSON.stringify(line) + '\n');
    const items = (menu.items || []).map(i => `${i.text}${i.disabled ? '[禁用]' : ''}${i.visible === false ? '[不可见]' : ''}`).join(' | ');
    console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] trig=${before && before.trigger ? before.trigger.text : '-'} probe=${before && before.probe ? before.probe.unavailable : '-'} banners=${before ? before.banners.length : '-'} items=${(menu.items || []).length} hints=${JSON.stringify(menu.hints || [])}`);
    if (items) console.log('   ' + items.slice(0, 300));
    await sleep(SEC * 1000);
  }
  console.log('[done]', FILE);
  cdp.close('done');
})().catch(e => { console.log('ERR', e && e.message || e); process.exit(1); });
