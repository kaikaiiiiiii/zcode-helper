'use strict';
/**
 * dump-composer-dom.js — 抓取 ZCode composer 区域的 DOM 快照（用于比对"无 plan / 有 plan"两种状态）
 *
 * 用途：模型可用性最可靠的信号是 composer 工具栏里的模型选择触发器
 *      （`[data-testid="chat-model-select-trigger"]`：无 plan 时文本为「管理模型」，有 plan 时变成模型名/下拉）。
 *      白天跑一次、晚上 23:00 后再跑一次，比对 logs/dom/composer-*.json 即可确认文案与结构变化。
 *
 * 依赖：ZCode 已带 CDP 端口启动（--remote-debugging-port=9222）。只读，不改页面。
 * 用法：node scripts/dump-composer-dom.js [端口]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 9222;
const OUT_DIR = path.join(__dirname, '..', 'logs', 'dom');

const getJson = url => new Promise((resolve, reject) => {
  const req = http.get(url, { timeout: 3000 }, res => {
    let b = '';
    res.on('data', d => { b += d; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error('timeout')));
});

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
  const evaluate = expr => new Promise(resolve => {
    const id = 1;
    const onMsg = ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', onMsg);
      resolve(m.result && m.result.result ? m.result.result.value : undefined);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });

  const info = await evaluate(`(() => {
    const norm = s => String(s || '').replace(/\\s+/g, ' ').trim();
    const surface = document.querySelector('[class*="chat-composer-input-surface"]');
    const region = document.querySelector('[class*="chat-composer-region"]');
    const form = (surface || region || document).querySelector('form');
    const trigger = document.querySelector('[data-testid="chat-model-select-trigger"]');
    const buttons = [];
    if (form) {
      const btns = form.querySelectorAll('button');
      for (let i = 0; i < btns.length; i++) {
        const b = btns[i];
        const r = b.getBoundingClientRect();
        buttons.push({
          i,
          text: norm(b.textContent).slice(0, 40),
          testid: b.getAttribute('data-testid') || null,
          aria: b.getAttribute('aria-label') || null,
          title: b.getAttribute('title') || null,
          visible: r.width > 5 && r.height > 5
        });
      }
    }
    return {
      capturedAt: new Date().toISOString(),
      url: location.href,
      title: document.title,
      found: { region: !!region, surface: !!surface, form: !!form, modelTrigger: !!trigger },
      modelTrigger: trigger ? {
        text: norm(trigger.textContent),
        html: trigger.outerHTML.slice(0, 1200),
        attrs: Array.from(trigger.attributes).map(a => [a.name, a.value])
      } : null,
      buttons,
      composerHtml: (surface || region) ? (surface || region).outerHTML : null
    };
  })()`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(OUT_DIR, `composer-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(info, null, 1));
  ws.close();

  console.log(`saved: ${file}`);
  console.log(`modelTrigger found=${info.found.modelTrigger} text=${JSON.stringify(info.modelTrigger && info.modelTrigger.text)}`);
  console.log(`buttons: ${info.buttons.map(b => `${b.testid || b.text}`).join(' | ')}`);
  process.exit(0);
}

main().catch(e => { console.log('DUMP-FAIL:', e.message); process.exit(1); });
