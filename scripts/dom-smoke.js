'use strict';
/**
 * dom-smoke.js — 对着**正在运行的 ZCode** 逐个跑 DOM 适配层表达式，检查它们是否还返回预期形状。
 *
 * 用途：ZCode 升级后第一时间确认哪些选择器漂移了（单元测试跑的是静态 fixture，抓不到真实 DOM 的变化）。
 *
 *   node scripts/dom-smoke.js                 # 只读检查（不点击、不弹面板）
 *   node scripts/dom-smoke.js --panel         # 额外：打开模型面板读列表/供应商后 Esc 关闭
 *   node scripts/dom-smoke.js --port 9222
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 */
const { CdpClient, listPageTargets, pickMainTarget } = require('../src/cdp-client');
const adapter = require('../src/dom-adapter');

const args = process.argv.slice(2);
const PORT = Number((args.indexOf('--port') >= 0 ? args[args.indexOf('--port') + 1] : 0) || 9222);
const WITH_PANEL = args.includes('--panel');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail === undefined ? '' : '  :: ' + trunc(detail)}`);
}
const trunc = v => {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  s = s === undefined ? 'undefined' : s;
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
};

(async () => {
  const cdp = new CdpClient();
  const targets = await listPageTargets(PORT).catch(e => { console.error('CDP 连接失败：', e.message); process.exit(2); });
  const target = pickMainTarget(targets);
  if (!target) { console.error('没找到可用的页面 target'); process.exit(2); }
  await cdp.connect(target);
  const ev = (expr = '', timeout = 3000) => cdp.evaluate(expr, timeout).catch(e => ({ __error: e.message }));
  /** 表达式可能是函数(名字) => src，也可能是含 __NAME__ 的字符串 */
  const named = (v, name) => (typeof v === 'function' ? v(name) : String(v).replace(/__NAME__/g, JSON.stringify(name)));

  // ---------- 只读 ----------
  {
    const r = await ev(adapter.composerRectSrc);
    check('composerRectSrc 输入框可见', r && r.ok && r.w > 10 && r.h > 10, r);
  }
  {
    const r = await ev(adapter.snapshotSrc);
    const hasComposer = r && (r.composerFound === true || (r.composer && typeof r.composer.text === 'string') || typeof r.text === 'string');
    check('snapshotSrc 能读出输入框', !!hasComposer, r && { keys: Object.keys(r), composerFound: r.composerFound, sid: r.session && r.session.sessionId });
  }
  {
    const r = await ev(adapter.sessionStatesSrc);
    check('sessionStatesSrc 会话列表', Array.isArray(r) && r.length > 0 && r.every(x => 'sid' in x || 'sessionId' in x), Array.isArray(r) ? { n: r.length, first: r[0] } : r);
  }
  {
    const r = await ev(adapter.attachmentsStateSrc);
    check('attachmentsStateSrc 附件行', r && (typeof r.total === 'number' || typeof r.count === 'number'), r);
  }
  {
    const r = await ev(adapter.chatLoadingSrc);
    check('chatLoadingSrc 在跑判定', r && typeof r.working === 'boolean', r);
  }
  {
    const r = await ev(adapter.workspaceStateSrc);
    check('workspaceStateSrc 可执行（新会话时字段为 null 属正常）', r && typeof r === 'object' && ('sessionId' in r), r);
  }
  {
    const r = await ev(named(adapter.expandProjectSrc, '\u0000nope'));
    check('expandProjectSrc 可执行（不存在的项目应返回 matched:false）', r && typeof r === 'object', r && { matched: r.matched, expanded: r.expanded });
  }
  {
    const r = await ev(named(adapter.newSessionReadySrc, '\u0000nope'));
    check('newSessionReadySrc 可执行（不存在项目应不匹配）', r && (r.ready === false || r.match === false), r);
  }
  {
    const r = await ev(named(adapter.openProjectNewTaskSrc, '\u0000nope'));
    check('openProjectNewTaskSrc 可执行', r && typeof r === 'object', r && { ok: r.ok, why: r.why });
  }
  {
    const r = await ev(adapter.sidebarStateSrc);
    check('sidebarStateSrc 侧栏状态', r && typeof r.expanded === 'boolean', r);
  }
  {
    const r = await ev(adapter.modelTriggerStateSrc);
    check('modelTriggerStateSrc 模型触发器', r && typeof r.text === 'string', r);
  }
  {
    const r = await ev(adapter.modelTriggerRectSrc);
    check('modelTriggerRectSrc 触发器坐标', r && r.ok && typeof r.x === 'number' && typeof r.y === 'number', r);
  }
  {
    const r = await ev(adapter.quotaBannerSrc);
    check('quotaBannerSrc 额度/模型横幅', r && typeof r === 'object', r);
  }
  {
    const r = await ev(adapter.probeModelSrc('glm-5.3-flash'));
    check('probeModelSrc 可用性判定', r && ('unavailable' in r), r);
  }
  {
    const r = await ev(adapter.settingsBackSrc);
    check('settingsBackSrc 返回工作区按钮（当前在对话页时 ok:false 属正常）', r && ('ok' in r), r);
  }

  // ---------- 需要弹面板（可逆：Esc 关闭） ----------
  if (WITH_PANEL) {
    const trig = await ev(adapter.modelTriggerStateSrc);
    if (trig && trig.visible && !trig.haspopup) {
      // 触发器是「管理模型」（没有列表）：点它会跳设置页，不是面板 → 跳过面板检查
      check('模型面板：跳过（当前是「管理模型」，没有列表）', true, { text: trig.text });
    } else {
    const rect = await ev(adapter.modelTriggerRectSrc);
    if (!rect || !rect.ok) {
      check('模型面板：打开', false, rect);
    } else {
      await cdp.dispatchClick(Math.round(rect.x), Math.round(rect.y));
      await sleep(900);
      const menu = await ev(adapter.modelMenuSrc);
      check('模型面板：打开', !!(menu && menu.open), menu && { open: menu.open, items: menu.items && menu.items.length });
      const list = await ev(adapter.modelListSrc);
      check('modelListSrc 模型列表', Array.isArray(list) && (list.length === 0 || 'testid' in list[0]), Array.isArray(list) ? list.map(m => m.text) : list);
      if (list && list.length) {
        const pick = await ev(adapter.modelItemPickSrc(String(list[0].testid || '').split(':').pop()));
        check('modelItemPickSrc 能定位模型项', pick && pick.ok, pick);
      } else {
        check('modelItemPickSrc 能定位模型项', false, '列表为空，跳过');
      }
      const providers = await ev(adapter.modelProviderListSrc);
      const hasProvider = providers && providers.length > 0;
      check('modelProviderListSrc 供应商列表（需悬停，空属正常）', Array.isArray(providers), hasProvider ? providers.map(p => p.text) : providers);
      const prov = await ev(adapter.modelPanelProviderSrc);
      if (prov && prov.ok) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: prov.x - 8, y: prov.y, button: 'none' }).catch(() => {});
        await sleep(120);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: prov.x, y: prov.y, button: 'none' }).catch(() => {});
        await sleep(900);
        let providers2 = await ev(adapter.modelProviderListSrc);
        if (!Array.isArray(providers2) || !providers2.length) {
          await cdp.dispatchClick(prov.x, prov.y);   // hover 没触发 → 点击兜底
          await sleep(900);
          providers2 = await ev(adapter.modelProviderListSrc);
        }
        check('modelProviderListSrc 悬停/点击后能读到供应商', Array.isArray(providers2) && providers2.length > 0, providers2 && providers2.map(p => p.text));
        const manage = await ev(adapter.modelPanelManageSrc);
        check('modelPanelManageSrc 管理模型项', manage && ('ok' in manage), manage);
      } else {
        check('modelPanelProviderSrc 供应商触发器', false, prov);
      }
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
    }
    }
  }

  // 兜底（无论是否跑面板检查）：确保不把用户的界面留在设置页
  {
    const back = await ev(adapter.settingsBackSrc);
    if (back && back.ok) {
      await cdp.dispatchClick(back.x, back.y);
      await sleep(1200);
      check('设置页兜底返回', true, {});
    }
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log('  - ' + f.name);
  }
  cdp.close('dom-smoke');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('SMOKE-ERROR:', e.stack || e.message); process.exit(2); });
