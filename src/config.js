'use strict';
/**
 * config.js — 配置读写（DESIGN.md §6）
 * 存放于 userData 目录（%APPDATA%\zcode-helper\config.json）。
 * 文档未提及的取舍：值缺失/非法时静默回退默认值；set() 时深合并并落盘。
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // ZCode 可执行文件路径（用户环境实测：scoop 安装位置）
  zcodeExePath: '',   // 留空 = 启动时自动探测（src/zcode-path.js）
  // helper 启动时拉起 ZCode 打开的默认工作区；空 = 不带工作区参数
  defaultWorkspacePath: '',
  // CDP 端口（启动前探测占用，被占则顺延并只记住本次会话选择）
  cdpPort: 9222,
  // 模式时间表：activeFrom~activeTo 之间为 PLAYING（免费 plan 生效时段），其余 RECORDING。
  // activeTo <= activeFrom 视为跨午夜（如 23:00 → 06:00）。默认 23:00~23:59（DESIGN §6）。
  // 时间表降级为兜底：探针（modeSource='probe'，VM 实测修复 #1）命中信号时优先；探针失配（unknown）才用时间表。
  modeSchedule: { activeFrom: '23:00', activeTo: '23:59' },
  // 模式判定来源：probe（默认，DOM 探测模型可用性）| schedule（仅时间表）
  modeSource: 'probe',
  // 模型探针/容量刷新周期（毫秒，1000~60000）
  probeIntervalMs: 1000,
  // 免费 plan 固定模型，写死；未来新 plan 改配置（AGENTS.md 硬规则 5）
  fixedModelId: 'GLM-5.3-Flash',
  // 并发上限：ZCode 免费套餐同时只允许 2 个会话工作；working >= 该值时滤网暂存（设置面板可调）
  maxWorkingSessions: 2,
  // 防打扰：系统级键鼠空闲不足 N 秒时，不做自动发送、也不弹模型菜单（0 = 关闭）
  idleGuardSeconds: 5,
  // 模型记录为"不可用"时，每隔多少秒刷新一次模型列表（点 管理模型 → 模型设置 → 返回工作区）；0 = 关闭
  modelRefreshSeconds: 60,
  // 套餐状态检查周期（秒）：直接问官方接口，判断"模型何时可用"；0 = 关闭。要比 ZCode 自己的周期长
  planProbeSeconds: 180,
  // 上次匹配成功的最佳模型（供应商 + 模型名）；发消息时先试它，失效再重新扫描
  modelBestMatch: null,
  // 暂停助手（暂停记录）：true = 滤网不拦截，消息直接放行给 ZCode（面板/托盘切换）
  helperPaused: false,
  // 暂停输出：true = 队列不排空（面板/托盘切换）
  outputPaused: false,
  // 面板是否显示「输出暂停」小开关（debug 功能；关掉后面板更干净）
  showOutputSwitch: true,
  // helper 启动时若 ZCode 未运行，是否自动受控拉起（正常路径；smoke 测试时关掉）
  autoLaunchZCode: true,
  // 面板窗口置顶（默认关：正常可被其它程序盖住）
  panelAlwaysOnTop: false,
  // sent 条目滚动归档保留天数（DESIGN §9 ⚠️7 天）
  queueArchiveDays: 7,
  // 辅助开关：一次性给现有 ZCode 快捷方式补端口参数（HANDOFF §7，仅辅助）
  patchShortcut: false
};

function parseHhMm(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return fallback;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

class Config {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'config.json');
    this.data = this._load();
  }

  _load() {
    const merged = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const k of Object.keys(DEFAULTS)) {
        if (!(k in raw)) continue;
        const v = raw[k];
        if (k === 'modeSchedule') {
          merged[k] = {
            activeFrom: parseHhMm(v && v.activeFrom, merged[k].activeFrom),
            activeTo: parseHhMm(v && v.activeTo, merged[k].activeTo)
          };
        } else if (k === 'modeSource') {
          merged[k] = (v === 'schedule' || v === 'probe') ? v : merged[k];
        } else if (k === 'probeIntervalMs') {
          merged[k] = clampInt(v, 1000, 60000, merged[k]);
        } else if (k === 'maxWorkingSessions') {
          merged[k] = clampInt(v, 1, 20, merged[k]);
        } else if (k === 'idleGuardSeconds') {
          merged[k] = clampInt(v, 0, 60, merged[k]);
        } else if (k === 'modelRefreshSeconds' || k === 'modelRecoverCheckSeconds') {
          merged[k === 'modelRecoverCheckSeconds' ? 'modelRefreshSeconds' : k] = clampInt(v, 0, 3600, merged.modelRefreshSeconds || 60);
        } else if (k === 'planProbeSeconds') {
          merged[k] = clampInt(v, 0, 3600, merged.planProbeSeconds !== undefined ? merged.planProbeSeconds : 180);
        } else if (k === 'queueArchiveDays') {
          merged[k] = clampInt(v, 1, 365, merged[k]);
        } else if (k === 'modelBestMatch') {
          merged[k] = (v && typeof v === 'object' && v.provider && v.model)
            ? { provider: String(v.provider), providerTid: v.providerTid ? String(v.providerTid) : null, model: String(v.model) }
            : null;
        } else if (k === 'cdpPort') {
          merged[k] = clampInt(v, 1024, 65535, merged[k]);
        } else if (typeof DEFAULTS[k] === 'boolean') {
          merged[k] = !!v;
        } else {
          merged[k] = typeof v === 'string' ? v : merged[k];
        }
      }
    } catch {
      // 文件不存在/损坏 → 全默认
    }
    return merged;
  }

  get(key) {
    return key ? this.data[key] : { ...this.data };
  }

  set(patch) {
    // 只接受 DEFAULTS 里已知的键，类型归一后合并
    const next = JSON.parse(JSON.stringify(this.data));
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in patch)) continue;
      const v = patch[k];
      if (k === 'modeSchedule' && v && typeof v === 'object') {
        next[k] = {
          activeFrom: parseHhMm(v.activeFrom, next[k].activeFrom),
          activeTo: parseHhMm(v.activeTo, next[k].activeTo)
        };
      } else if (k === 'modeSource') {
        next[k] = (v === 'schedule' || v === 'probe') ? v : next[k];
      } else if (k === 'probeIntervalMs') {
        next[k] = clampInt(v, 1000, 60000, next[k]);
      } else if (k === 'maxWorkingSessions') {
        next[k] = clampInt(v, 1, 20, next[k]);
      } else if (k === 'idleGuardSeconds') {
        next[k] = clampInt(v, 0, 60, next[k]);
      } else if (k === 'modelRefreshSeconds' || k === 'modelRecoverCheckSeconds') {
        next[k === 'modelRecoverCheckSeconds' ? 'modelRefreshSeconds' : k] = clampInt(v, 0, 3600, next[k] !== undefined ? next[k] : 60);
      } else if (k === 'planProbeSeconds') {
        next[k] = clampInt(v, 0, 3600, next[k] !== undefined ? next[k] : 180);
      } else if (k === 'queueArchiveDays') {
        next[k] = clampInt(v, 1, 365, next[k]);
      } else if (k === 'modelBestMatch') {
        next[k] = (v && typeof v === 'object' && v.provider && v.model)
          ? { provider: String(v.provider), providerTid: v.providerTid ? String(v.providerTid) : null, model: String(v.model) }
          : null;
      } else if (k === 'cdpPort') {
        next[k] = clampInt(v, 1024, 65535, next[k]);
      } else if (typeof DEFAULTS[k] === 'boolean') {
        next[k] = !!v;
      } else if (typeof v === 'string') {
        next[k] = v;
      }
    }
    this.data = next;
    this.save();
    return { ...this.data };
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { Config, DEFAULTS };
