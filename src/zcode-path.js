'use strict';
/**
 * zcode-path.js — 在用户机器上自动找 ZCode.exe
 *
 * 配置项 `zcodeExePath` 为空时（新安装的默认状态）按下面的候选顺序探测；
 * 找到就写回配置，找不到就保持为空（面板会提示"未受控"，用户可手动在设置里选）。
 *
 * 只在 Windows 上有意义；其它平台返回空字符串。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 候选路径（按优先级）：官方安装器 → Program Files → Scoop → 旧版 AppData 安装 */
function candidates() {
  if (process.platform !== 'win32') return [];
  const out = [];
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  if (localAppData) out.push(path.join(localAppData, 'Programs', 'ZCode', 'ZCode.exe'));
  if (programFiles) out.push(path.join(programFiles, 'ZCode', 'ZCode.exe'));
  if (programFilesX86) out.push(path.join(programFilesX86, 'ZCode', 'ZCode.exe'));
  try { out.push(path.join(os.homedir(), 'scoop', 'apps', 'zcode', 'current', 'ZCode.exe')); } catch { /* ignore */ }
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'ZCode', 'ZCode.exe'));
  return out;
}

/** 返回第一个存在的候选路径；都不存在返回 '' */
function detectZCodePath() {
  for (const p of candidates()) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch { /* 权限问题等：跳过 */ }
  }
  return '';
}

module.exports = { candidates, detectZCodePath };
