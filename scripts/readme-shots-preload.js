'use strict';
/** README 截图：给 panel / queue 提供假数据（preload 在页面脚本之前注入 window.zfh） */
const { contextBridge } = require('electron');
const data = JSON.parse(process.env.ZFH_SHOTS || '{}');

contextBridge.exposeInMainWorld('zfh', {
  getState: async () => data.state || {},
  getRecent: async () => data.events || [],
  onState: () => {},
  onLog: () => {},
  toggleHelperPaused: () => {},
  toggleOutputPaused: () => {},
  openWindow: () => {},
  hideSelf: () => {},
  restartZCode: async () => {},
  getQueue: async () => data.items || [],
  queueAction: () => {},
  resetFailed: () => {},
  clearSent: () => {},
  exportBundle: async () => '',
  getConfig: async () => ({}),
  setConfig: async () => ({}),
  pickPath: async () => null
});
