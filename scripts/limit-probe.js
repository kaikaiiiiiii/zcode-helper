'use strict';
/**
 * limit-probe.js — 被动记录：用户操作 + 页面反馈（找"并发上限"的异常信号）
 *
 * 只读：不点击、不输入、不改页面状态，只在页面里装一个 MutationObserver + 事件监听，
 * 每秒把新增的 DOM 变化 / 点击 / 按键 拉回本地写 JSONL；遇到疑似错误文案自动截图。
 *
 * 用法：
 *   node scripts/limit-probe.js --minutes 60
 * 产物：
 *   logs/limit-probe-<stamp>.jsonl
 *   logs/limit-probe-shots-<stamp>/*.png
 */
const fs = require('fs');
const path = require('path');
const { CdpClient, listPageTargets, pickMainTarget } = require('../src/cdp-client');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'logs');
const argOf = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const MINUTES = Number(argOf('minutes', 60));
const INTERVAL = Number(argOf('interval', 1000));
const STATE_EVERY = 5; // 每 5 秒记一次状态
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const FILE = path.join(OUT_DIR, `limit-probe-${stamp}.jsonl`);
const SHOT_DIR = path.join(OUT_DIR, `limit-probe-shots-${stamp}`);
const SUSPECT = /不可用|上限|限制|额度|频繁|稍后|重试|失败|错误|超出|达到|并发|quota|limit|too many|rate|error|unavailab/i;

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = fs.createWriteStream(FILE, { flags: 'a' });
const write = rec => out.write(JSON.stringify(rec) + '\n');

const OBSERVER = `(() => {
  // 重新注入时先停掉旧实例（否则旧的 observer/监听器会重复上报、且不带新过滤）
  if (window.__limitProbe) { try { window.__limitProbe.stop && window.__limitProbe.stop(); } catch (e) { /* ignore */ } }
  const buf = [];
  const now = () => Date.now();
  const txt = n => (n && (n.nodeType === 3 ? n.textContent : n.textContent) || '').replace(/\\s+/g, ' ').trim();
  const push = rec => { rec.t = now(); buf.push(rec); if (buf.length > 4000) buf.splice(0, buf.length - 4000); };
  const desc = el => {
    if (!el || el.nodeType !== 1) return null;
    return (el.tagName || '').toLowerCase() +
      (el.getAttribute && el.getAttribute('data-testid') ? '[' + el.getAttribute('data-testid') + ']' : '') +
      (el.getAttribute && el.getAttribute('data-error-code') ? '{' + el.getAttribute('data-error-code') + '}' : '');
  };
  // DOM 变化：只记"新增节点/文本变化"里有意义的（长度 >= 2）
  // 忽略 helper 自己的灯条 / 计时器：它们每秒重绘，会把日志淹掉
  const noisy = el => {
    try {
      if (!el) return true;
      if (el.nodeType !== 1) el = el.parentElement;
      if (!el || !el.closest) return false;
      return !!(el.closest('#zfh-lightbar') || el.closest('[data-testid="chat-loading"]') || el.closest('[data-testid="chat-loading-slot"]'));
    } catch (e) { return false; }
  };
  const mo = new MutationObserver(list => {
    for (const m of list) {
      if (noisy(m.target)) continue;
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (noisy(n)) continue;
          const s = txt(n);
          if (s && s.length >= 2) push({ kind: 'add', target: desc(m.target), text: s.slice(0, 240) });
          if (n.nodeType === 1) {
            const code = n.getAttribute && n.getAttribute('data-error-code');
            if (code) push({ kind: 'error-code', code, text: s.slice(0, 240), html: (n.outerHTML || '').slice(0, 500) });
            const tid = n.getAttribute && n.getAttribute('data-testid');
            if (tid && /error|banner|alert|toast|limit|quota/i.test(tid)) push({ kind: 'banner-node', tid, text: s.slice(0, 240), html: (n.outerHTML || '').slice(0, 500) });
          }
        }
      } else if (m.type === 'characterData') {
        const s = txt(m.target);
        if (s && s.length >= 2) push({ kind: 'text', target: desc(m.target.parentElement), text: s.slice(0, 240) });
      } else if (m.type === 'attributes') {
        const el = m.target;
        if (el && el.getAttribute && (el.getAttribute('data-error-code') || /error|banner|toast/i.test(el.getAttribute('data-testid') || ''))) {
          push({ kind: 'attr', target: desc(el), attr: m.attributeName, value: String(el.getAttribute(m.attributeName)).slice(0, 120), text: txt(el).slice(0, 240) });
        }
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-error-code', 'data-testid', 'aria-expanded', 'data-state'] });

  // 用户操作：点击目标 / Enter
  const onClick = e => {
    let el = e.target, chain = [];
    for (let i = 0; i < 4 && el && el.getAttribute; i++, el = el.parentElement) {
      const d = desc(el); if (d) chain.push(d);
      const tid = el.getAttribute('data-testid');
      if (tid) break;
    }
    push({ kind: 'click', path: chain.join(' < '), text: (e.target && (e.target.getAttribute && (e.target.getAttribute('aria-label') || '')) || '').slice(0, 80) });
  };
  const onKey = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const c = document.querySelector('.chat-composer-region');
      const t = c ? (c.innerText || '').replace(/\\s+/g, ' ').trim() : '';
      push({ kind: 'enter', composerText: t.slice(0, 240) });
    }
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  window.__limitProbe = {
    alive: true,
    buf,
    drain() { const a = buf.slice(); buf.length = 0; return a; },
    stop() { mo.disconnect(); document.removeEventListener('click', onClick, true); document.removeEventListener('keydown', onKey, true); this.alive = false; }
  };
  return { started: true };
})()`;

const STATE = `(() => {
  const vis = el => { try { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden'; } catch (e) { return false; } };
  const txt = el => (el && el.textContent || '').replace(/\\s+/g, ' ').trim();
  const snap = (window.__zfh && window.__zfh.snapshot) ? window.__zfh.snapshot() : null;
  const sessions = [...document.querySelectorAll('li[data-testid^="task-item-"]')].map(li => {
    const d = li.querySelector('[data-unread-indicator],[data-error-indicator]');
    return {
      sid: (li.getAttribute('data-testid') || '').replace('task-item-', ''),
      key: li.getAttribute('data-task-item-key'),
      working: !!li.querySelector('.animate-spin'),
      dot: d ? (d.hasAttribute('data-error-indicator') ? 'error' : 'unread') : null
    };
  });
  const loading = document.querySelector('[data-testid="chat-loading"]');
  const banners = [...document.querySelectorAll('[data-testid="chat-error-banner"], [role="alert"], [role="status"]')]
    .filter(vis).map(el => ({ tid: el.getAttribute('data-testid'), code: el.getAttribute('data-error-code'), text: txt(el).slice(0, 240) }));
  return {
    active: (snap && snap.session) || null,
    loading: loading && vis(loading) ? { timer: txt(loading.querySelector('.tabular-nums') || loading).slice(0, 40) } : null,
    working: sessions.filter(s => s.working).map(s => s.sid),
    sessions: sessions.map(s => ({ sid: s.sid, w: s.working ? 1 : 0, dot: s.dot })),
    banners,
    title: document.title
  };
})()`;

let cdp = null;
let shots = 0;
async function connect() {
  const targets = await listPageTargets(9222);
  const target = pickMainTarget(targets);
  const c = new CdpClient();
  await c.connect(target);
  cdp = c;
  write({ kind: 'connect', target: { url: target.url, title: target.title }, version: (await c.evaluate('(window.__zfh||{}).version || null').catch(() => null)) });
  return c;
}

async function shot(tag) {
  try {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (!r || !r.data) return null;
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = path.join(SHOT_DIR, `${String(++shots).padStart(3, '0')}-${tag}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    return path.relative(ROOT, f);
  } catch (e) { return null; }
}

(async () => {
  await connect();
  const cfgPath = path.join(process.env.APPDATA || '', 'zcode-helper', 'config.json');
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* ignore */ }
  write({ kind: 'start', at: new Date().toISOString(), file: path.basename(FILE), maxWorkingSessions: cfg && cfg.maxWorkingSessions, probeIntervalMs: cfg && cfg.probeIntervalMs });
  await cdp.evaluate(OBSERVER);

  const endsAt = Date.now() + MINUTES * 60000;
  let tick = 0;
  let prevSig = '';
  while (Date.now() < endsAt) {
    tick++;
    try {
      const entries = await cdp.evaluate('window.__limitProbe ? window.__limitProbe.drain() : "missing"', 5000);
      if (entries === 'missing') {
        // 页面导航（切工作区可能重载）会丢掉注入的 observer → 立即重装
        write({ kind: 'reinject' });
        try { await cdp.evaluate(OBSERVER); } catch (e) { write({ kind: 'error', error: 'reinject: ' + (e && e.message) }); }
      } else if (Array.isArray(entries) && entries.length) {
        for (const e of entries) {
          write({ kind: 'ev', ...e });
          if (e.text && SUSPECT.test(e.text)) {
            const f = await shot('suspect');
            if (f) write({ kind: 'shot', file: f, reason: e.kind });
          }
        }
      }
      if (tick % STATE_EVERY === 0) {
        const st = await cdp.evaluate(STATE, 5000);
        const sig = JSON.stringify({ w: st.working, b: st.banners && st.banners.map(b => b.code + '|' + b.text), l: st.loading && st.loading.timer });
        const rec = { kind: 'state', ...st, changed: sig !== prevSig };
        if (sig === prevSig) delete rec.sessions; // 会话列表没变就不重复落盘
        write(rec);
        if (sig !== prevSig && st.banners && st.banners.length) {
          const f = await shot('banner');
          if (f) write({ kind: 'shot', file: f, reason: 'banner-state' });
        }
        prevSig = sig;
      }
    } catch (e) {
      write({ kind: 'error', error: String(e && e.message || e) });
      try { await new Promise(r => setTimeout(r, 1500)); await cdp.close('probe-reconnect'); } catch { /* ignore */ }
      try { await connect(); await cdp.evaluate(OBSERVER); } catch { /* 下一轮再试 */ }
    }
    await new Promise(r => setTimeout(r, INTERVAL));
  }
  write({ kind: 'end', at: new Date().toISOString(), ticks: tick });
  out.end();
  try { cdp.close('probe-done'); } catch { /* ignore */ }
  console.log('probe file:', FILE);
  process.exit(0);
})().catch(e => { console.error('probe failed:', e.message); try { out.end(); } catch { /* ignore */ } process.exit(1); });
