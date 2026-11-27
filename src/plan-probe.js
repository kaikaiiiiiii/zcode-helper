'use strict';
/**
 * plan-probe.js — 直接问官方接口"套餐现在能不能用、什么时候生效"
 *
 * 灵感来自 zcode-switch（https://github.com/pjpv/zcode-switch）的额度查询：
 *   - 用 ZCode 自己 config.json 里 provider 的明文 apiKey（start-plan / coding-plan）
 *   - 带上 telemetry-state.json 的 deviceMid 调 billing/balance
 *
 * 与 DOM 判断的分工：
 *   - 这里只负责"模型现在能不能用 / 什么时候生效"，纯读、不点界面；
 *   - 真正的发消息、切会话、选模型仍然全部走 DOM。
 *
 * 安全边界：
 *   - 只读 %USERPROFILE%\.zcode\v2\{config,telemetry-state}.json，不写任何文件；
 *   - 凭据只发给 https://zcode.z.ai，不落日志；
 *   - 任何失败都返回 { ok:false }，由调用方静默降级到 DOM 判断。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const BILLING_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance';
const DEFAULT_VERSION = '4.0.0';

/** Windows 构建号（服务端会校验设备指纹；取不到就用 10.0.19045 兜底） */
function osVersion() {
  try {
    const rel = os.release();          // e.g. "10.0.26200"
    return /^\d+\.\d+\.\d+/.test(rel) ? rel : '10.0.19045';
  } catch { return '10.0.19045'; }
}

function dataDir(home) {
  return path.join(home || process.env.USERPROFILE || os.homedir(), '.zcode', 'v2');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 从 config.json 里挑一个明文的套餐 apiKey（加密的 enc: 跳过） */
function findApiKey(config) {
  const providers = config && config.provider;
  if (!providers || typeof providers !== 'object') return null;
  // 打分：start-plan 优先、JWT（eyJ…）优先、enabled 加分；
  // 注意 32 字节的普通 API key 调 billing 会 401，必须挑 JWT
  const score = (id, p, k) => {
    let s = 0;
    if (/start-plan/i.test(id)) s += 4;
    if (k.startsWith('eyJ')) s += 4;
    if (p && p.enabled) s += 1;
    return s;
  };
  let best = null;
  for (const [id, p] of Object.entries(providers)) {
    if (!/start-plan|coding-plan/i.test(id)) continue;
    const k = p && p.options && p.options.apiKey;
    if (typeof k !== 'string' || k.length <= 20 || k.startsWith('enc:')) continue;
    const sc = score(id, p, k);
    if (!best || sc > best.score) best = { key: k, score: sc };
  }
  return best ? best.key : null;
}

function findDeviceMid(dir) {
  const t = readJson(path.join(dir, 'telemetry-state.json'));
  return t && typeof t.deviceMid === 'string' ? t.deviceMid : null;
}

/** 把 billing/balance 的响应压成我们关心的字段 */
function parseBalance(json, nowMs) {
  const data = json && json.data;
  if (!data || !Array.isArray(data.plans)) return { ok: false, reason: 'bad-shape' };
  const plans = data.plans.filter(p => p && typeof p === 'object');
  const active = plans.find(p => p.status === 'active') || null;
  const plan = active || plans[0] || null;
  if (!plan) return { ok: true, available: false, active: false, name: null, status: null, effectiveAt: null, endsAt: null, models: [] };

  const ents = Array.isArray(plan.entitlements) ? plan.entitlements : [];
  const effectiveAts = ents.map(e => Number(e.effective_at)).filter(Number.isFinite);
  const effectiveAt = effectiveAts.length ? Math.min(...effectiveAts) : null;
  const nowSec = Math.floor(nowMs / 1000);
  const endsAt = Number(plan.ends_at) || null;
  const available = !!active
    && (!effectiveAt || nowSec >= effectiveAt)
    && (!endsAt || nowSec < endsAt);

  return {
    ok: true,
    available,
    active: !!active,
    name: plan.name || plan.plan_id || null,
    status: plan.status || null,
    startsAt: Number(plan.starts_at) || null,
    endsAt,
    effectiveAt,
    models: ents.map(e => e.show_name).filter(Boolean),
    serverTime: Number(data.server_time) || null
  };
}

/**
 * 查一次套餐状态。
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] 便于测试注入
 * @param {string} [opts.home]        便于测试注入
 * @param {string} [opts.appVersion]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.now]
 * @returns {Promise<object>} {ok:false} 表示"没查成"，调用方应静默降级
 */
async function probePlan(opts = {}) {
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  try {
    const dir = opts.dir || dataDir(opts.home);
    const config = readJson(path.join(dir, 'config.json'));
    if (!config) return { ok: false, reason: 'no-config' };
    const apiKey = findApiKey(config);
    if (!apiKey) return { ok: false, reason: 'no-key' };
    const mid = findDeviceMid(dir);

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': `ZCode/${opts.appVersion || DEFAULT_VERSION}`,
      'HTTP-Referer': 'https://zcode.z.ai',
      'X-Title': 'Z Code@electron',
      'X-ZCode-App-Version': opts.appVersion || DEFAULT_VERSION,
      'X-Platform': 'win32',
      'X-Release-Channel': 'stable',
      'X-Client-Language': 'zh-CN',
      'X-Client-Timezone': 'Asia/Shanghai',
      'X-Os-Category': 'windows',
      'X-Os-Version': osVersion(),
      'x-request-id': require('crypto').randomUUID()
    };
    if (mid) headers['X-Device-Mid'] = mid;

    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no-fetch' };
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs || 8000) : null;
    let res;
    try {
      res = await fetchImpl(`${BILLING_URL}?app_version=${encodeURIComponent(opts.appVersion || DEFAULT_VERSION)}`, {
        headers,
        signal: ctrl ? ctrl.signal : undefined
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res || !res.ok) return { ok: false, reason: `http-${res && res.status}` };
    const json = await res.json();
    if (!json || (json.code !== undefined && json.code !== 0)) return { ok: false, reason: 'biz-' + (json && json.code) };
    const parsed = parseBalance(json, nowMs);
    return { ...parsed, fetchedAt: nowMs };
  } catch (e) {
    // 静默：不抛、不打日志（调用方只在状态变化时记录套餐名/时间）
    return { ok: false, reason: (e && e.name) === 'AbortError' ? 'timeout' : 'error' };
  }
}

module.exports = { probePlan, parseBalance, findApiKey, findDeviceMid, dataDir, BILLING_URL };
