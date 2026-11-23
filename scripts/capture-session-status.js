'use strict';
/**
 * capture-session-status.js — 采样会话列表里的"工作状态图标"（working 转圈 / 完成绿点）
 *
 * 背景：ZCode 会话列表每项左侧有个 16x16 状态位
 *   `li > div.relative.flex.size-4.shrink-0.items-center.justify-center`
 *   空闲时内部是空的 <span>；会话工作中/完成时里面会出现图标。
 * 本脚本按固定间隔采样，一发现非空（状态出现）就落盘快照，并在状态变化时再落一份，
 * 便于比对"工作态"与"空闲态"的 DOM 差异（可与其它空闲会话对比，不依赖时间前后）。
 *
 * 用法：node scripts/capture-session-status.js [端口] [最长分钟]
 * 产物：logs/dom/session-status-<时间>.json
 * 退出码：0 = 抓到状态变化；2 = 超时未见到状态；1 = 出错
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 9222;
const MAX_MIN = Number(process.argv[3]) || 25;
const OUT_DIR = path.join(__dirname, '..', 'logs', 'dom');
const INTERVAL_MS = 3000;

const getJson = url => new Promise((resolve, reject) => {
  const req = http.get(url, { timeout: 3000 }, res => {
    let b = '';
    res.on('data', d => { b += d; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error('timeout')));
});

const SAMPLE_EXPR = `(() => {
  const norm = s => String(s || '').replace(/\\s+/g, ' ').trim();
  const items = [];
  const lis = document.querySelectorAll('li');
  let i = 0;
  for (const li of lis) {
    const st = li.querySelector('div.relative.flex.size-4.shrink-0.items-center.justify-center');
    if (!st) continue;
    const r = st.getBoundingClientRect();
    const inner = st.innerHTML || '';
    const desc = [];
    st.querySelectorAll('*').forEach(el => {
      const c = getComputedStyle(el);
      const cls = el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || '');
      desc.push({
        tag: el.tagName,
        cls: String(cls).slice(0, 160),
        anim: c.animationName + ' ' + c.animationDuration,
        bg: c.backgroundColor,
        fill: c.fill,
        color: c.color,
        opacity: c.opacity,
        html: el.outerHTML.slice(0, 600)
      });
    });
    // 空闲态 = 只有一个空的 <span>（无 svg / 无文本 / 无着色块）；工作态或绿点会有内容
    const styled = Array.from(st.querySelectorAll('*')).some(el => {
      const c = getComputedStyle(el);
      return el.tagName === 'SVG' || el.tagName === 'IMG'
        || (c.backgroundColor && c.backgroundColor !== 'rgba(0, 0, 0, 0)')
        || (c.backgroundImage && c.backgroundImage !== 'none');
    });
    const empty = !styled && norm(st.textContent) === '' && !st.querySelector('svg,img');
    items.push({
      i: i++,
      title: norm(li.textContent).slice(0, 60),
      y: Math.round(r.y),
      visible: r.width > 3 && r.height > 3,
      empty,
      working: !!st.querySelector('.animate-spin'),
      sessionId: (li.getAttribute('data-testid') || '').replace('task-item-', '') || null,
      taskKey: li.getAttribute('data-task-item-key') || null,
      html: inner,
      desc,
      liAttrs: Array.from(li.attributes).map(a => [a.name, String(a.value).slice(0, 120)]),
      liHtml: (st.children.length ? li.outerHTML.slice(0, 6000) : null)
    });
  }
  return { capturedAt: new Date().toISOString(), url: location.href, items };
})()`;

function signature(item) {
  if (item.empty) return 'idle';
  const anims = item.desc.map(d => d.anim).filter(a => a && !a.startsWith('none')).join(',');
  const bgs = item.desc.map(d => d.bg + '|' + d.fill).join(',');
  return (item.html || '').length + ':' + anims + ':' + bgs;
}

async function main() {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`);
  const target = targets.find(t => t.type === 'page' && (t.url || '').includes('index.html'))
    || targets.find(t => t.type === 'page');
  if (!target) throw new Error('没有 page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const evaluate = expr => new Promise(resolve => {
    const id = nextId++;
    pending.set(id, m => resolve(m.result && m.result.result ? m.result.result.value : undefined));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const deadline = Date.now() + MAX_MIN * 60_000;
  const localStamp = () => {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  };
  const localTime = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  let prevSigs = null;
  let nonIdleSeen = false;
  let sawWorking = false;
  let savedCount = 0;

  while (Date.now() < deadline) {
    let sample = null;
    try { sample = await evaluate(SAMPLE_EXPR); } catch { /* 页面瞬时切换，继续 */ }
    if (sample && sample.items.length) {
      const sigs = sample.items.map(it => `${it.sessionId || it.title}=${signature(it)}`).join(' || ');
      const nonIdle = sample.items.filter(it => !it.empty);
      const working = sample.items.filter(it => it.working);
      if (working.length) sawWorking = true;
      const changed = sigs !== prevSigs;
      if (changed && (nonIdle.length || sawWorking)) {
        const file = path.join(OUT_DIR, `session-status-${localStamp()}.json`);
        fs.writeFileSync(file, JSON.stringify(sample, null, 1));
        savedCount++;
        nonIdleSeen = true;
        console.log(`[${localTime()}] changed: working=${working.length} nonIdle=${nonIdle.length}`);
        for (const it of nonIdle) {
          console.log(`  #${it.i} "${it.title}" working=${it.working} sid=${it.sessionId}`);
          console.log(`      html=${it.html.replace(/\s+/g, ' ').slice(0, 240)}`);
        }
        console.log(`  saved ${path.basename(file)}`);
      }
      if (sawWorking && !working.length && savedCount >= 2) {
        console.log(`[${localTime()}] 工作态结束（已捕获 working 与完成态），收工`);
        break;
      }
      if (savedCount >= 8) { console.log(`[${localTime()}] 已收集 ${savedCount} 份，收工`); break; }
      prevSigs = sigs;
    }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }

  ws.close();
  if (!nonIdleSeen) { console.log('TIMEOUT: 整个采样期没有出现任何状态图标'); process.exit(2); }
  console.log(`done: saved ${savedCount} snapshot(s) in ${OUT_DIR}`);
  process.exit(0);
}

main().catch(e => { console.log('CAPTURE-FAIL:', e.message); process.exit(1); });
