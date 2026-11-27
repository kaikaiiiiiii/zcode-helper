'use strict';
/**
 * test/dom/run.js — 在真实 Chromium 里跑 DOM 适配层测试（Electron 主进程）
 *
 * 为什么不用 jsdom：适配层依赖 getBoundingClientRect / getComputedStyle / 真实布局，
 * 用 Electron 渲染进程 + 采集到的真实页面片段才等价于 ZCode 里的实际行为。
 *
 * 运行：node test/dom/launch.js（会以正确的方式拉起 electron）
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const adapter = require('../../src/dom-adapter');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const readFix = f => fs.readFileSync(path.join(FIXTURES, f), 'utf8');

let win = null;
const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`);
};

const js = expr => win.webContents.executeJavaScript(expr, true);
const loadFixture = async file => {
  await win.loadFile(path.join(FIXTURES, file));
  await new Promise(r => setTimeout(r, 80)); // 等一次布局
};

async function openComposer(file) {
  await loadFixture(file);
  await js(`(() => { window.__reports = []; window.zfhReport = function (s) { try { window.__reports.push(JSON.parse(s)); } catch (e) {} }; return true; })()`);
  await js(adapter.bootstrapSource());
}

async function main() {
  win = new BrowserWindow({
    show: false, width: 1200, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  });

  // ---------- composer：无模型 ----------
  await openComposer('composer-no-model.html');

  {
    const r = await js(adapter.probeModelSrc('GLM-5.3-Flash'));
    check('composer(no model): probe -> unavailable',
      !!(r && r.unavailable) && String(r.evidence || '').includes('manage-model'), r);
  }
  {
    const r = await js(adapter.composerRectSrc);
    check('composer(no model): composerRect 可见', !!(r && r.ok && r.w > 10 && r.h > 10), r);
  }
  {
    const v = await js('window.__zfh.version');
    check('composer(no model): bootstrap 注入版本正确', v === adapter.helperVersion, v);
    const snap = await js('window.__zfh.snapshot()');
    check('composer(no model): snapshot 找到 composer', !!(snap && snap.composerFound), snap && snap.composerFound);
  }
  {
    const ok = await js(adapter.setLightBarSrc({ conn: 'on', state: 'wait', waitReason: 'quota', modelOk: true, working: 2, limit: 2, currentWorking: false, pending: 3, drafts: 1, currentPending: '我们一直在讨论的内容中，有哪些内容是矛盾冲突，可能始终没有被真正摆到台面上？' }));
    const lb = await js(`(() => { const el = document.getElementById('zfh-lightbar'); return el ? { text: el.innerText, cap: window.__zfh.capacity } : null; })()`);
    const t = (lb && lb.text) || '';
    check('灯条：行名（工作进程/队列消息）+ 当前会话待发预览',
      ok === true && t.includes('工作进程') && t.includes('2 / 2') && t.includes('队列消息') && t.includes('3（草稿 1）') && t.includes('限额缓冲') && t.includes('矛盾冲突'),
      { text: t.slice(0, 140) });
    check('灯条：不再有「等待」行', !t.includes('等待'), t.slice(0, 120));
    check('灯条：不在灯条里显示模型行', !t.includes('模型'), t.slice(0, 80));
    check('灯条：capacity 回写给滤网', lb && lb.cap && lb.cap.modelOk === true && lb.cap.working === 2 && lb.cap.limit === 2, lb && lb.cap);
  }
  {
    // 套餐已领取但未到生效时间：灯条直接显示几点生效（planEta 来自官方接口）
    await js(adapter.setLightBarSrc({ conn: 'on', state: 'wait', waitReason: 'model', modelOk: false, working: 0, limit: 2, pending: 2, planEta: 3600 }));
    const withEta = await js("document.querySelector('#zfh-lightbar .lb-state').textContent");
    check('灯条：套餐未生效时显示「HH:MM 生效」', /^无可用模型 · \d{2}:\d{2} 生效$/.test(withEta), withEta);
    await js(adapter.setLightBarSrc({ conn: 'on', state: 'wait', waitReason: 'model', modelOk: false, working: 0, limit: 2, pending: 2 }));
    const withoutEta = await js("document.querySelector('#zfh-lightbar .lb-state').textContent");
    check('灯条：没有生效时间时只显示「无可用模型」', withoutEta === '无可用模型', withoutEta);
  }
  {
    // 灯色：绿=正常输出，黄=等待名额，红=输出暂停，灰=助手暂停
    const color = async (payload) => {
      await js(adapter.setLightBarSrc(payload));
      return js(`(() => { const el = document.getElementById('zfh-lightbar'); return { text: el.querySelector('.lb-state').textContent, dot: el.querySelector('.lb-dot').style.background }; })()`);
    };
    const okC = await color({ conn: 'on', state: 'ok', modelOk: true, working: 1, limit: 2, pending: 0 });
    const waitC = await color({ conn: 'on', state: 'wait', modelOk: true, working: 2, limit: 2, pending: 1 });
    const pauseC = await color({ conn: 'on', state: 'output-paused', modelOk: true, working: 0, limit: 2, pending: 1 });
    const helperC = await color({ conn: 'on', state: 'helper-paused', modelOk: true, working: 0, limit: 2, pending: 0 });
    const modelC = await color({ conn: 'on', state: 'wait', waitReason: 'model', modelOk: false, working: 0, limit: 2, pending: 1 });
    check('灯条颜色/文字映射', okC.text === '助手工作中' && /48, 164, 108|#30a46c/i.test(okC.dot) &&
      waitC.text === '限额缓冲' && /245, 165, 36|#f5a524/i.test(waitC.dot) &&
      pauseC.text === '消息阻断' && /229, 72, 77|#e5484d/i.test(pauseC.dot) &&
      helperC.text === '助手已暂停' && /139, 141, 152|#8b8d98/i.test(helperC.dot) &&
      modelC.text === '无可用模型' && /245, 165, 36|#f5a524/i.test(modelC.dot),
      { okC, waitC, pauseC, helperC, modelC });
  }
  {
    const r = await js(`(() => {
      const c = window.__zfh.findComposer();
      if (!c) return { err: 'no-composer' };
      c.focus(); c.textContent = '截获测试';
      window.__zfh.capacity = { modelOk: false, working: 0, limit: 2, currentWorking: false }; // 滤网：模型不可用 → 暂存
      window.__zfh.setMode('recording');
      window.__reports.length = 0;
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      c.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, reports: window.__reports };
    })()`);
    const cap = (r.reports || []).find(x => x.type === 'capture');
    check('composer(no model): 录制态回车 -> 截获 capture',
      r.prevented === true && !!cap && cap.text === '截获测试', r);
  }
  {
    const r = await js(`(() => {
      const c = window.__zfh.findComposer();
      window.__zfh.capacity = { modelOk: false, working: 0, limit: 2, currentWorking: false };
      window.__zfh.setMode('recording');
      window.__reports.length = 0;
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      c.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, reports: window.__reports.length };
    })()`);
    check('composer(no model): 无弹层时 Enter 被拦截（defaultPrevented）', r.prevented === true, r);
  }
  {
    // 消息阻断（outputPaused）：即使模型可用、名额空闲，也要暂存而不是放行
    const r = await js(`(() => {
      const c = window.__zfh.findComposer();
      if (!c) return { err: 'no-composer' };
      c.focus(); c.textContent = '阻断测试';
      window.__zfh.capacity = { modelOk: true, working: 0, limit: 2, currentWorking: false, outputPaused: true };
      window.__zfh.setMode('recording');
      window.__reports.length = 0;
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      c.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, reports: window.__reports };
    })()`);
    const cap = (r.reports || []).find(x => x.type === 'capture');
    check('消息阻断：模型可用也不放行，Enter 被拦截并入队',
      r.prevented === true && !!cap && cap.text === '阻断测试' && cap.holdReason === 'output', r);
  }
  {
    // 附件捕获：change 事件暂存 File → 拦截上报带出原始绝对路径
    await js(`(() => {
      window.zcode = { getPathForFile: f => f.__path || null };
      const host = document.querySelector('.chat-composer-region') || document.body;
      if (!host.querySelector('input[type=file]')) {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.className = 'hidden';
        host.appendChild(inp);
      }
      if (!document.querySelector('[data-composer-file-attachments-row]')) {
        host.insertAdjacentHTML('afterbegin', '<div data-composer-file-attachments-row="true"><div data-testid="v4-attachment-a" data-composer-attachment-kind="image" data-upload-status="ready"><img alt="a.png" src="blob:file:///dead"></div></div>');
        const chip = host.querySelector('[data-testid="v4-attachment-a"]');
        const rm = document.createElement('button');
        rm.setAttribute('data-composer-attachment-remove', 'a');
        rm.addEventListener('click', () => chip.remove());
        chip.appendChild(rm);
      }
      const inp2 = host.querySelector('input[type=file]');
      const f = new File(['hello'], 'a.png', { type: 'image/png' });
      f.__path = 'D:\\\\project\\\\a.png';
      const dt = new DataTransfer(); dt.items.add(f); inp2.files = dt.files;
      inp2.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const r = await js(`(() => {
      const c = window.__zfh.findComposer();
      c.focus(); c.textContent = '带附件';
      window.__zfh.capacity = { modelOk: false, working: 0, limit: 2, currentWorking: false };
      window.__zfh.setMode('recording');
      window.__reports.length = 0;
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      c.dispatchEvent(ev);
      return true;
    })()`);
    await new Promise(res => setTimeout(res, 400));
    const rep = await js('window.__reports.find(x => x.type === "capture")');
    check('附件：捕获时带出原始路径', !!(rep && rep.attachments && rep.attachments[0] && rep.attachments[0].path === 'D:\\project\\a.png' && rep.attachments[0].name === 'a.png' && rep.attachments[0].kind === 'image'), rep && rep.attachments);
    const left = await js("document.querySelectorAll('[data-composer-file-attachments-row] [data-testid^=\"v4-attachment-\"]').length");
    check('附件：入队后从输入框移除', left === 0, left);
  }
  {
    // 文件类附件（压缩包）：名字在 span[title] 上；img 只是 material 图标，不是内容
    await js(`(() => {
      document.querySelectorAll('[data-composer-file-attachments-row] [data-testid^="v4-attachment-"]').forEach(c => c.remove());
      const host = document.querySelector('.chat-composer-region') || document.body;
      let row = host.querySelector('[data-composer-file-attachments-row]');
      if (!row) { row = document.createElement('div'); row.setAttribute('data-composer-file-attachments-row', 'true'); host.insertBefore(row, host.firstChild); }
      row.insertAdjacentHTML('beforeend', '<div data-testid="v4-attachment-z" data-composer-attachment-kind="file" data-upload-status="ready"><div><div><img alt="" src="./material-icons/zip.svg"></div></div><div><span title="a.zip">a.zip</span><span>ZIP</span></div></div>');
      const inp = host.querySelector('input[type=file]');
      const f = new File(['zip'], 'a.zip', { type: 'application/zip' });
      f.__path = 'D:\\\\project\\\\a.zip';
      const dt = new DataTransfer(); dt.items.add(f); inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const raw = await js('window.__zfh.readAttachments().then(a => JSON.stringify(a))');
    const arr = JSON.parse(raw);
    check('附件：压缩包带出原始路径（名字取自 span[title]）',
      !!(arr[0] && arr[0].kind === 'file' && arr[0].name === 'a.zip' && arr[0].path === 'D:\\project\\a.zip'), arr);
  }
  {
    // 解除阻断后，同样条件下应放行
    const r = await js(`(() => {
      const c = window.__zfh.findComposer();
      c.focus(); c.textContent = '放行测试';
      window.__zfh.capacity = { modelOk: true, working: 0, limit: 2, currentWorking: false, outputPaused: false };
      window.__zfh.setMode('recording');
      window.__reports.length = 0;
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      c.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, reports: window.__reports };
    })()`);
    const cap = (r.reports || []).find(x => x.type === 'capture');
    const pass = (r.reports || []).find(x => x.type === 'enter-passthrough');
    // 放行路径不产生任何上报（只有指令弹层才上报 enter-passthrough）
    check('解除消息阻断：模型可用 + 名额空闲 → 放行（不拦截、不入队）', r.prevented === false && !cap && (r.reports || []).length === 0, r);
  }
  {
    // 注入 / 指令弹层后：Enter 应放行给 app
    const frag = readFix('command-list-fragment.html');
    await js(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(frag)})`);
    const openState = await js('window.__zfh.suggestionsOpen()');
    const r = await js(`(() => {
      const c = window.__zfh.findComposer();
      window.__zfh.capacity = { modelOk: false, working: 0, limit: 2, currentWorking: false };
      window.__zfh.setMode('recording');
      window.__reports.length = 0;
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      c.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, reports: window.__reports };
    })()`);
    const pass = (r.reports || []).find(x => x.type === 'enter-passthrough');
    const cap = (r.reports || []).find(x => x.type === 'capture');
    check('composer + 指令弹层: Enter 放行（不截获）',
      openState === true && r.prevented === false && !!pass && !cap, { openState, prevented: r.prevented, hasPass: !!pass, hasCapture: !!cap });
  }

  // ---------- composer：有模型 ----------
  await openComposer('composer-with-model.html');
  {
    const r = await js(adapter.probeModelSrc('GLM-5.3-Flash'));
    check('composer(with model): probe -> available + modelId',
      !!(r && r.unavailable === false && r.modelId === 'GLM-5.3-Flash'), r);
  }
  {
    const v = await js(`(() => { const el = document.querySelector('[data-testid="chat-model-select-trigger"]'); return el ? el.getAttribute('data-model-current-value') : null; })()`);
    check('composer(with model): 触发器带 data-model-current-value', !!v && v.includes('GLM-5.3-Flash'), v);
  }

  {
    // 2026-11-21 实测：陈旧态下可见文本仍是「选择模型」，但 data-model-current-value 已回填 → 必须判可用
    await openComposer('composer-with-model.html');
    const r = await js('(() => {' +
      'const t = document.querySelector("[data-testid=\\"chat-model-select-trigger\\"]");' +
      'const before = window.__zfh.probeModel();' +
      'const value = t.getAttribute("data-model-current-value");' +
      't.textContent = "选择模型";' +
      'const staleText = window.__zfh.probeModel();' +
      't.removeAttribute("data-model-current-value");' +
      'const noValue = window.__zfh.probeModel();' +
      'const b = document.createElement("div");' +
      'b.setAttribute("data-testid", "chat-error-banner");' +
      'b.setAttribute("data-error-code", "ZCODE_RUNTIME_MODEL_UNAVAILABLE");' +
      'b.textContent = "当前使用的模型已不可用";' +
      'document.body.appendChild(b);' +
      'const withBanner = window.__zfh.probeModel();' +
      'return { before, staleText, noValue, withBanner, value };' +
      '})()');
    check('陈旧文本 + 已回填 value -> 判可用', r.staleText.unavailable === false && !!r.staleText.modelId, r.staleText);
    check('value 空 + 无横幅 -> 仍按文本判不可用', r.noValue.unavailable === true, r.noValue);
    check('value 空 + 错误横幅 -> 判不可用', r.withBanner.unavailable === true, r.withBanner);
    // 两层判断：选择模型 + 已确认列表里有白名单模型（capacity.modelOk=true）→ 可用
    const listOk = await js('(() => { document.querySelectorAll(\'[data-testid="chat-error-banner"]\').forEach(e => e.remove()); window.__zfh.capacity = Object.assign({}, window.__zfh.capacity, { modelOk: true }); const t = document.querySelector("[data-testid=\\"chat-model-select-trigger\\"]"); t.textContent = "选择模型"; return window.__zfh.probeModel(); })()');
    check('选择模型 + 已确认列表 → 可用', listOk.unavailable === false, listOk);
    const listNotOk = await js('(() => { window.__zfh.capacity = Object.assign({}, window.__zfh.capacity, { modelOk: false }); return window.__zfh.probeModel(); })()');
    check('选择模型 + 未确认列表 → 不可用', listNotOk.unavailable === true, listNotOk);
    await js('(() => { document.querySelectorAll(\'[data-testid="chat-error-banner"]\').forEach(e => e.remove()); return true; })()');
  }

  {
    // 灯条可拖动 + 八向吸附（角优先）+ 100px 吸附距离
    await js(adapter.setLightBarSrc({ conn: 'on', state: 'ok', modelOk: true, working: 0, limit: 2, pending: 0 }));
    const dragTo = async (x, y) => js('(() => { try {' +
      'const el = document.getElementById("zfh-lightbar");' +
      'const b = el.getBoundingClientRect();' +
      'const ev = (t, cx, cy) => new PointerEvent(t, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 7 });' +
      'el.dispatchEvent(ev("pointerdown", b.left + 20, b.top + 20));' +
      'el.dispatchEvent(ev("pointermove", ' + x + ', ' + y + '));' +
      'el.dispatchEvent(ev("pointerup", ' + x + ', ' + y + '));' +
      'const r = el.getBoundingClientRect();' +
      'let pos = null; try { pos = localStorage.getItem("zfh-lightbar-pos"); } catch (e) {}' +
      'return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), pos: pos };' +
      '} catch (e) { return { err: String(e && e.stack || e) }; } })()');
    const v = await js('({ w: window.innerWidth, h: window.innerHeight })');
    // 拖到左上角附近 -> 角吸附优先于边
    const tl = await dragTo(30, 30);
    check('灯条：靠近角落时优先吸附角', tl.left <= 12 && tl.top <= 12 && /"mode":"corner"/.test(String(tl.pos)) && /"anchor":"tl"/.test(String(tl.pos)), tl);
    // 拖到左边中部 -> 吸附边（离角远）
    const le = await dragTo(30, Math.round(v.h / 2));
    check('灯条：离角远时吸附边', le.left <= 12 && /"mode":"edge"/.test(String(le.pos)) && /"anchor":"left"/.test(String(le.pos)), le);
    // 拖到中间 -> 超过 100px 不吸附，留在原地
    const mid = await dragTo(Math.round(v.w / 2), Math.round(v.h / 2));
    check('灯条：超过吸附距离留在原地', mid.left > 120 && mid.left < v.w - mid.w - 120 && /"mode":"free"/.test(String(mid.pos)), { mid, v });
    // 宽度收窄
    check('灯条：宽度（<=200px）', mid.w <= 200, { w: mid.w });
    // 吸附距离 100px：拖到左边缘 90px 处也应吸附（50px 阈值下不会）
    const near = await dragTo(100, Math.round(v.h / 2));
    check('灯条：100px 内吸附边', near.left <= 12, near);
    // 窗口缩小后灯条必须仍在可视区
    await dragTo(Math.round(v.w / 2), Math.round(v.h / 2));
    win.setSize(640, 480);
    await new Promise(r => setTimeout(r, 500));
    const shrunk = await js('(() => { const el = document.getElementById("zfh-lightbar"); const b = el.getBoundingClientRect(); return { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom), iw: window.innerWidth, ih: window.innerHeight }; })()');
    check('灯条：窗口缩小后仍在可视区', shrunk.left >= 0 && shrunk.top >= 0 && shrunk.right <= shrunk.iw + 1 && shrunk.bottom <= shrunk.ih + 1, shrunk);
    win.setSize(1200, 900);
    await new Promise(r => setTimeout(r, 300));

    // 角吸附后：窗口缩放过程中保持贴角（变大也要跟着贴边）
    await dragTo(30, 30);
    win.setSize(760, 560);
    await new Promise(r => setTimeout(r, 450));
    const smallC = await js('(() => { const el = document.getElementById("zfh-lightbar"); const b = el.getBoundingClientRect(); return { left: Math.round(b.left), top: Math.round(b.top) }; })()');
    win.setSize(1200, 900);
    await new Promise(r => setTimeout(r, 450));
    const bigC = await js('(() => { const el = document.getElementById("zfh-lightbar"); const b = el.getBoundingClientRect(); return { left: Math.round(b.left), top: Math.round(b.top) }; })()');
    check('灯条：缩放窗口时保持角吸附', smallC.left <= 12 && smallC.top <= 12 && bigC.left <= 12 && bigC.top <= 12, { smallC, bigC });
    const c = await js('(() => {' +
      'const el = document.getElementById("zfh-lightbar");' +
      'const b = el.getBoundingClientRect();' +
      'const ev = (t, cx, cy) => new PointerEvent(t, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 8 });' +
      'window.__reports.length = 0;' +
      'el.dispatchEvent(ev("pointerdown", b.left + 20, b.top + 20));' +
      'el.dispatchEvent(ev("pointerup", b.left + 20, b.top + 20));' +
      'return window.__reports.filter(x => x.type === "toggle-panel").length;' +
      '})()');
    check('灯条：点击（无位移）切换面板', c === 1, { reports: c });
  }
  {
    // 录制侧：会话所属工作区来自侧栏 task-item 的 data-task-item-key="<workspace>:<sid>"
    const key = 'D:\\Coding\\Bighub:sess_test';
    const r = await js('(() => {' +
      'const li = document.createElement("li");' +
      'li.setAttribute("data-testid", "task-item-sess_test");' +
      'li.setAttribute("data-task-item-key", ' + JSON.stringify(key) + ');' +
      'document.body.appendChild(li);' +
      'const got = window.__zfh.workspaceOfSession("sess_test");' +
      'li.remove();' +
      'return { got };' +
      '})()');
    check('workspaceOfSession 解析 <workspace>:<sid>', r.got === key.slice(0, key.lastIndexOf(':')), r);
  }

  // ---------- 反馈弹窗 vs 聊天输入框（2026-11-20 回归：弹窗内容曾被当成聊天草稿入队） ----------
  if (fs.existsSync(path.join(FIXTURES, 'composer-with-dialog.html'))) {
    await openComposer('composer-with-dialog.html');
    {
      const r = await js(`(() => {
        const ta = document.querySelector('[role="dialog"] textarea');
        if (ta) ta.focus(); // 模拟弹窗自动聚焦
        const c = window.__zfh.findComposer();
        const inDialog = !!(c && c.closest && c.closest('[role="dialog"],[aria-modal="true"]'));
        if (ta) { ta.value = '反馈模板文字'; }
        const snap = window.__zfh.snapshot();
        return { found: !!c, testid: c && c.getAttribute('data-testid'), inDialog, text: snap.text, composerFound: snap.composerFound };
      })()`);
      check('反馈弹窗: 聚焦弹窗 textarea 也不会被当成 composer',
        r.found && r.testid === 'v4-composer-input' && r.inDialog === false, r);
      check('反馈弹窗: snapshot 不读弹窗内容',
        r.composerFound === true && String(r.text || '').trim() === '', { text: r.text });
    }
    {
      const rect = await js(adapter.composerRectSrc);
      const elRect = await js(`(() => { const c = window.__zfh.findComposer(); if (!c) return null; const r = c.getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height) }; })()`);
      check('反馈弹窗: composerRect 指向聊天输入框',
        !!(rect && rect.ok && elRect && Math.round(rect.y) === elRect.y), { rect, elRect });
    }
    {
      const r = await js(`(() => {
        const ta = document.querySelector('[role="dialog"] textarea');
        window.__zfh.setMode('recording');
        window.__reports.length = 0;
        const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        ta.dispatchEvent(ev);
        return { prevented: ev.defaultPrevented, reports: window.__reports.length };
      })()`);
      check('反馈弹窗: 弹窗内回车不被截获', r.prevented === false && r.reports === 0, r);
    }
  }
  if (fs.existsSync(path.join(FIXTURES, 'dialog-only.html'))) {
    await openComposer('dialog-only.html');
    {
      const r = await js(`(() => { const c = window.__zfh.findComposer(); const s = window.__zfh.snapshot(); return { found: !!c, composerFound: s.composerFound, text: s.text }; })()`);
      check('只有弹窗: 找不到聊天 composer', r.found === false && r.composerFound === false, r);
    }
  }

  // ---------- 侧栏项目收起/展开（工作区守护） ----------
  await openComposer('sidebar-projects.html');
  {
    const r = await js(adapter.expandProjectSrc.replace('__NAME__', JSON.stringify('hide-blog')));
    const now = await js('document.querySelector(\'button[data-testid="virtual-project-toggle"]\').getAttribute("aria-expanded")');
    check('侧栏项目：按名字展开收起的项目', !!(r && r.matched && r.expanded.length === 1 && now === 'true'), { r, now });
  }
  {
    // 先收起，再用一个对不上的名字 → 兜底展开所有收起的
    await js('document.querySelector(\'button[data-testid="virtual-project-toggle"]\').setAttribute("aria-expanded","false")');
    const r = await js(adapter.expandProjectSrc.replace('__NAME__', JSON.stringify('不存在的项目名')));
    check('侧栏项目：名字对不上时展开全部收起的', !!(r && r.fallback && r.expanded.includes('hide-blog') && r.collapsedLeft === 0), r);
  }
  {
    const name = await js('window.__zfh.workspaceNameOf("D:\\\\Coding\\\\Bighub")');
    check('侧栏项目：无 chip 时用路径末段作项目名', name === 'Bighub', name);
  }
  {
    const list = await js(adapter.sessionStatesSrc);
    const hit = (list || []).find(x => x.sid === 'sess_target');
    check('侧栏项目：会话项带标题/项目 id/项目名',
      !!(hit && hit.title === '示例对话' && hit.projectId === 'p-bighub' && hit.projectName === 'Bighub'), hit);
    const byId = await js(adapter.expandProjectSrc.replace('__NAME__', JSON.stringify('p-hideblog')));
    const opened = await js('document.querySelector(\'section[data-project-id="p-hideblog"] button[data-testid="virtual-project-toggle"]\').getAttribute("aria-expanded")');
    check('侧栏项目：按 projectId 展开项目', !!(byId && byId.matched && byId.by === 'id' && opened === 'true'), { byId, opened });
  }

  // ---------- 会话列表 ----------
  await loadFixture('session-list.html');
  {
    const list = await js(adapter.sessionStatesSrc);
    const by = sid => (list || []).find(x => x.sid === sid) || {};
    check('session-list: 解析出 4 个会话', Array.isArray(list) && list.length === 4, list && list.length);
    check('session-list: idle', by('sess_idle_0001').working === false && !by('sess_idle_0001').dot);
    check('session-list: working', by('sess_working_0002').working === true);
    check('session-list: unread 蓝点', by('sess_unread_0003').dot === 'unread');

    check('session-list: error 红点', by('sess_error_0004').dot === 'error');
  }
  {
    const r = await js(adapter.sessionItemRectSrc.replace('__SID__', JSON.stringify('sess_working_0002')));
    check('session-list: 按 sid 取到矩形', !!(r && r.ok && r.h > 0), r);
  }
  {
    const r = await js(adapter.locateSessionSrc
      .replace('__SESSION_ID__', JSON.stringify(''))
      .replace('__SESSION_TITLE__', JSON.stringify('工作中的会话标题')));
    check('session-list: 按标题定位会话', !!(r && r.ok), r && { ok: r.ok, matchedBy: r.matchedBy });
  }
  {
    const r = await js(adapter.chatLoadingSrc);
    check('session-list: 无 chat-loading -> not working', !!(r && r.working === false), r);
  }

  // ---------- 对话区 chat-loading ----------
  await loadFixture('chat-loading.html');
  {
    const r = await js(adapter.chatLoadingSrc);
    check('chat-loading: working + 计时器文本', !!(r && r.working === true && String(r.timer || '').includes('23')), r);
  }

  // ---------- 新建会话（还没有 sidebar 条目） ----------
  await openComposer('sidebar-projects.html');
  await js(`(() => { try {
    const d = document.createElement('div'); d.setAttribute('data-testid', 'chat-empty'); document.body.appendChild(d);
    const b = document.createElement('button'); b.setAttribute('data-testid', 'composer-workspace-trigger'); b.textContent = 'Bighub'; document.body.appendChild(b);
    const sec = [...document.querySelectorAll('section[data-project-name]')].find(x => x.getAttribute('data-project-name') === 'Bighub');
    const btn = document.createElement('button');
    btn.setAttribute('data-testid', 'virtual-project-create-task');
    btn.style.cssText = 'display:block;width:24px;height:24px';
    sec.appendChild(btn);
    return true;
  } catch (e) { return { err: String(e && e.message || e) }; } })()`);
  for (let k = 0; k < 30; k++) { if (await js('!!window.__zfh')) break; await new Promise(res => setTimeout(res, 100)); }
  {
    const safe = async (expr) => { try { return await js(expr); } catch (e) { return { __err: String(e && e.message || e) }; } };
    const info = await safe('(() => { try { return JSON.stringify(window.__zfh.getSessionInfo()); } catch (e) { return "ERR:" + (e && e.message); } })()');
    const infoObj = (typeof info === 'string' && info.trim().startsWith('{')) ? JSON.parse(info) : { __raw: info };
    check('新会话：sessionId 置空、项目名来自顶部 chip',
      !!(infoObj && infoObj.newConversation === true && infoObj.sessionId === null && infoObj.draftProjectName === 'Bighub'), infoObj);
    const open = await safe(adapter.openProjectNewTaskSrc('Bighub'));
    check('新会话：定位到项目的「新建任务」按钮', !!(open && open.ok && typeof open.x === 'number'), open);
    const ready = await safe(adapter.newSessionReadySrc('Bighub'));
    check('新会话：就绪判定 = 空会话 + 项目对上', !!(ready && ready.match && ready.empty), ready);
  }

  await openComposer('composer-with-model.html');
  {
    // 2026-11-23 实测：额度用完时菜单里的模型仍可选，必须先认额度横幅
    await js(`(() => {
      document.body.insertAdjacentHTML('beforeend', '<div data-testid="v4-session-quota-banner" style="display:block;width:400px;height:32px">体验套餐可用额度已用完，请切换到 Coding Plan 订阅或等待额度恢复。</div>');
      return true;
    })()`);
    const r = await js('window.__zfh.probeModel()');
    check('模型：额度横幅在 → 判定不可用（即使菜单仍可选）',
      !!(r && r.unavailable === true && String(r.evidence || '').includes('quota-banner')), r);
    await js(`(() => { document.querySelectorAll('[data-testid="v4-session-quota-banner"]').forEach(e => e.remove()); return true; })()`);
  }

  // ---------- 模型面板：供应商 / 模型列表 / 管理模型 ----------
  await openComposer('model-panel.html');
  {
    const st = await js(adapter.modelTriggerStateSrc);
    check('面板：触发器状态（text/value/haspopup/坐标）',
      !!(st && String(st.text).includes('glm-5.3-flash') && st.haspopup === 'menu' && st.x > 0 && st.visible), st);
    const list = await js(adapter.modelListSrc);
    check('面板：模型列表（名字/选中/禁用/坐标）',
      Array.isArray(list) && list.length === 3
        && !!list[0].testid && list[0].x > 0
        && list.some(m => m.checked === 'true') && list.some(m => m.disabled === true), list && list.map(m => m.text));
    const pick = await js(adapter.modelItemPickSrc('glm-5.3-flash'));
    check('面板：按名字定位模型项', !!(pick && pick.ok && String(pick.text).includes('glm-5.3-flash')), pick);
    const miss = await js(adapter.modelItemPickSrc('kimi-k9'));
    check('面板：名字不存在 -> not-found', !!(miss && miss.ok === false), miss);
    const cur = await js(adapter.modelProviderCurrentSrc);
    check('面板：当前供应商名', cur === 'OpenCode Go (Chat) API', cur);
    const prov = await js(adapter.modelPanelProviderSrc);
    check('面板：供应商触发器坐标', !!(prov && prov.ok && prov.x > 0), prov);
    const providers = await js(adapter.modelProviderListSrc);
    check('面板：供应商列表（2 个 + checked 标记）',
      Array.isArray(providers) && providers.length === 2 && providers[0].checked === 'true' && providers[1].checked === 'false',
      providers && providers.map(p => p.text));
    const manage = await js(adapter.modelPanelManageSrc);
    check('面板：「管理模型」项坐标', !!(manage && manage.ok && manage.x > 0), manage);
  }

  // ---------- 模型面板（3.19.1：popover dialog + role=option + aria-selected） ----------
  await openComposer('model-panel-dialog.html');
  {
    const menu = await js(adapter.modelMenuSrc);
    check('3.19.1 面板：dialog 结构能识别（open + 10 项内）', !!(menu && menu.open && Array.isArray(menu.items) && menu.items.length === 3), menu && { open: menu.open, n: menu.items && menu.items.length });
    const list = await js(adapter.modelListSrc);
    check('3.19.1 面板：模型列表（aria-selected 当作 checked）',
      Array.isArray(list) && list.length === 3 && list.some(m => m.checked === 'true') && list.some(m => m.disabled === true),
      list && list.map(m => [m.text, m.checked, m.disabled]));
    const pick = await js(adapter.modelItemPickSrc('kimi-k3'));
    check('3.19.1 面板：按名字定位（禁用项也能定位，由调用方判断）', !!(pick && pick.ok), pick);
    const providers = await js(adapter.modelProviderListSrc);
    check('3.19.1 面板：供应商列表（checked 取自 aria-selected）',
      Array.isArray(providers) && providers.length === 2 && providers[0].checked === 'true' && providers[1].checked === 'false',
      providers && providers.map(p => [p.text, p.checked]));
    const manage = await js(adapter.modelPanelManageSrc);
    check('3.19.1 面板：「管理模型」按钮（无 testid / 无 role）', !!(manage && manage.ok && manage.x > 0), manage);
    const st = await js(adapter.modelTriggerStateSrc);
    check('3.19.1 面板：触发器 haspopup=dialog 也能读出', !!(st && st.haspopup === 'dialog' && String(st.text).includes('glm-5.3-flash')), st);
  }

  // ---------- 设置页：返回工作区 ----------
  await loadFixture('settings-page.html');
  {
    const back = await js(adapter.settingsBackSrc);
    check('设置页：「返回工作区」按钮', !!(back && back.ok && back.x > 0), back);
  }
  {
    await loadFixture('composer-no-model.html');
    const back = await js(adapter.settingsBackSrc);
    check('设置页：不在设置页时 ok:false', !!(back && back.ok === false), back);
  }

  // ---------- 侧边栏折叠 ----------
  await openComposer('sidebar-projects.html');
  await js(`(() => {
    if (!document.querySelector('aside')) { const a = document.createElement('aside'); a.style.cssText = 'display:block;width:6px;overflow:hidden'; document.body.appendChild(a); }
    if (!document.querySelector('[data-testid="desktop-top-logo-sidebar-toggle"]')) { const b = document.createElement('button'); b.setAttribute('data-testid', 'desktop-top-logo-sidebar-toggle'); b.style.cssText = 'display:block;width:24px;height:24px'; document.body.appendChild(b); }
    const list = document.querySelector('[data-testid="task-list"]');
    if (list) list.style.display = 'none';
    return true;
  })()`);
  {
    const collapsed = await js(adapter.sidebarStateSrc);
    check('侧栏：折叠时 expanded=false（aside 6px）', collapsed.expanded === false, collapsed);
    await js(`(() => { const a = document.querySelector('aside'); a.style.width = '400px'; const l = document.querySelector('[data-testid="task-list"]'); if (l) l.style.display = ''; return true; })()`);
    const expanded = await js(adapter.sidebarStateSrc);
    check('侧栏：展开时 expanded=true', expanded.expanded === true, expanded);
  }

  win.destroy();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

app.whenReady().then(() => main().catch(e => { console.error('DOM-TEST-ERROR:', e); app.exit(1); }));
