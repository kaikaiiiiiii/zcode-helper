'use strict';
/**
 * capture-model-menu.js — 采集"模型选择器菜单"快照（判断模型可用性的权威信号）。
 *
 * 背景（2026-11-21 实测）：
 *  - 界面上的模型名会"陈旧"：恢复可用后仍显示「选择模型」，套餐过期后也可能仍显示旧模型名；
 *  - 模型选择器的 data-model-current-value 也不一定及时——真正权威的是**点开菜单后的列表**；
 *  - 菜单结构： [role="menu"] → [data-testid="composer-provider-trigger"] +
 *    [data-testid="chat-model-select-item-<provider%3Amodel>"]（menuitemradio，aria-checked）。
 *
 * 用法：
 *   node scripts/capture-model-menu.js                # 采集一次，写到 logs/dom/model-menu-<ts>.json
 *   node scripts/capture-model-menu.js --watch 60     # 每 60 秒轮询，probe 翻转/横幅出现时采集一次后退出
 *   node scripts/capture-model-menu.js --watch 60 --deadline-min 45   # 最迟 45 分钟后强制采集一次
 *
 * 说明：会真实点开模型菜单（约 1-2 秒），采集后 Esc 关闭，不做任何选择。
 */
const fs = require('fs');
const path = require('path');
const { CdpClient, listPageTargets, pickMainTarget } = require('../src/cdp-client');

const PORT = Number(process.env.ZFH_CDP_PORT || 9222);
const OUT_DIR = path.join(__dirname, '..', 'logs', 'dom');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readState(cdp) {
  return cdp.evaluate(`(() => {
    const norm = s => String(s || '').replace(/\\s+/g, ' ').trim();
    const t = document.querySelector('[data-testid="chat-model-select-trigger"]');
    const b = document.querySelector('[data-testid="chat-error-banner"][data-error-code="ZCODE_RUNTIME_MODEL_UNAVAILABLE"]');
    return {
      ts: Date.now(),
      trigger: t ? {
        innerText: norm(t.innerText), textContent: norm(t.textContent),
        value: t.getAttribute('data-model-current-value'), aria: t.getAttribute('aria-label')
      } : null,
      banner: b ? { code: b.getAttribute('data-error-code'), text: norm(b.innerText).slice(0, 200) } : null,
      probe: window.__zfh && window.__zfh.probeModel ? window.__zfh.probeModel() : null,
      session: window.__zfh && window.__zfh.snapshot ? window.__zfh.snapshot().session : null
    };
  })()`);
}

async function dumpMenu(cdp) {
  return cdp.evaluate(`(() => {
    const norm = s => String(s || '').replace(/\\s+/g, ' ').trim();
    const menu = document.querySelector('[role="menu"], [data-radix-menu-content]');
    const wrapper = menu && menu.closest('[data-radix-popper-content-wrapper]');
    const items = Array.from(document.querySelectorAll('[data-testid^="chat-model-select-item-"], [role="menuitemradio"], [role="menuitem"]')).map(el => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        role: el.getAttribute('role'),
        testid: el.getAttribute('data-testid'),
        text: norm(el.innerText).slice(0, 120),
        checked: el.getAttribute('aria-checked'),
        disabled: el.getAttribute('aria-disabled') || el.getAttribute('data-disabled') || el.disabled === true,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      };
    });
    // 菜单区域内所有可见文本（含"升级/套餐/不可用/暂无"等提示）
    const texts = [];
    if (menu) {
      Array.from(menu.querySelectorAll('*')).forEach(el => {
        const t = norm(el.innerText);
        if (!t || t.length > 120) return;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 8) return;
        if (texts.some(x => x.text === t)) return;
        texts.push({ text: t, y: Math.round(r.y), cls: String(el.className || '').slice(0, 60) });
      });
    }
    return {
      menuFound: !!menu,
      menuHtml: menu ? menu.outerHTML.slice(0, 20000) : null,
      wrapperTransform: wrapper ? getComputedStyle(wrapper).transform : null,
      items,
      texts: texts.slice(0, 40),
      emptyHints: texts.map(t => t.text).filter(t => /升级|套餐|不可用|暂无|没有|购买|开通|订阅/.test(t))
    };
  })()`);
}

async function capture(cdp, tag) {
  const before = await readState(cdp);
  const rect = await cdp.evaluate(`(() => {
    const t = document.querySelector('[data-testid="chat-model-select-trigger"]');
    if (!t) return null;
    const b = t.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  })()`);
  let menu = null;
  if (rect) {
    await cdp.dispatchClick(rect.x, rect.y);
    await sleep(900);
    menu = await dumpMenu(cdp);
    await cdp.evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
    await sleep(300);
    menu.transient = await readState(cdp);
  }
  const file = path.join(OUT_DIR, `model-menu-${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ tag, capturedAt: new Date().toISOString(), before, menu }, null, 1));
  return { file, before, menu };
}

function summarize(r) {
  const b = r.before || {};
  console.log(`[capture] ${r.file}`);
  console.log('  trigger:', JSON.stringify(b.trigger));
  console.log('  banner :', JSON.stringify(b.banner));
  console.log('  probe  :', JSON.stringify(b.probe));
  if (r.menu) {
    console.log('  menu   : found=', r.menu.menuFound, 'items=', (r.menu.items || []).length, 'hints=', JSON.stringify(r.menu.emptyHints));
    (r.menu.items || []).forEach(i => console.log(`    - ${i.testid || i.role} | ${i.text} | checked=${i.checked} disabled=${i.disabled}`));
  }
}

(async () => {
  const args = process.argv.slice(2);
  const watchIdx = args.indexOf('--watch');
  const watchSec = watchIdx >= 0 ? Number(args[watchIdx + 1] || 60) : 0;
  const dlIdx = args.indexOf('--deadline-min');
  const deadlineMin = dlIdx >= 0 ? Number(args[dlIdx + 1] || 45) : 0;

  const cdp = new CdpClient();
  await cdp.connect(pickMainTarget(await listPageTargets(PORT)));
  if (!watchSec) {
    const r = await capture(cdp, 'single');
    summarize(r);
    cdp.close('done');
    return;
  }
  console.log(`[watch] 每 ${watchSec}s 检查一次${deadlineMin ? `，最迟 ${deadlineMin} 分钟后强制采集` : ''}`);
  const started = Date.now();
  let last = null;
  while (true) {
    let st;
    try { st = await readState(cdp); } catch (e) { console.log('[watch] read fail:', e.message); break; }
    const flipped = !!(st && ((st.probe && st.probe.unavailable) || st.banner));
    const same = last && st && last.trigger && st.trigger && last.trigger.value === st.trigger.value && last.trigger.innerText === st.trigger.innerText;
    console.log(`[watch ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] value=${st && st.trigger ? st.trigger.value : '-'} text=${st && st.trigger ? st.trigger.innerText : '-'} probe=${st && st.probe ? st.probe.unavailable : '-'} banner=${!!(st && st.banner)}`);
    last = st;
    if (flipped) {
      console.log('[watch] 检测到不可用信号，开始采集菜单…');
      const r = await capture(cdp, 'unavailable');
      summarize(r);
      break;
    }
    if (deadlineMin && Date.now() - started > deadlineMin * 60000) {
      console.log('[watch] 到达截止时间，强制采集一次…');
      const r = await capture(cdp, 'deadline');
      summarize(r);
      break;
    }
    await sleep(watchSec * 1000);
  }
  cdp.close('done');
})().catch(e => { console.log('ERR', e && e.message || e); process.exit(1); });
