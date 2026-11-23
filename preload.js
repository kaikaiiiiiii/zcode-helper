'use strict';
/**
 * preload.js — 渲染进程安全桥（contextIsolation 开启，nodeIntegration 关闭）
 * 仅暴露 zfh.* API：状态查询/订阅 + 操作转发，全部走 ipcRenderer.invoke。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zfh', {
  // 查询
  getState: () => ipcRenderer.invoke('zfh:getState'),
  getRecent: (limit) => ipcRenderer.invoke('zfh:getRecent', limit),
  getQueue: () => ipcRenderer.invoke('zfh:getQueue'),
  getConfig: () => ipcRenderer.invoke('zfh:getConfig'),
  // 操作
  queueAction: (id, action) => ipcRenderer.invoke('zfh:queueAction', { id, action }),
  resetFailed: () => ipcRenderer.invoke('zfh:resetFailed'),
  clearSent: () => ipcRenderer.invoke('zfh:clearSent'),
  toggleHelperPaused: () => ipcRenderer.invoke('zfh:toggleHelperPaused'),
  toggleOutputPaused: () => ipcRenderer.invoke('zfh:toggleOutputPaused'),
  restartZCode: () => ipcRenderer.invoke('zfh:restartZCode'),
  setConfig: (patch) => ipcRenderer.invoke('zfh:setConfig', patch),
  pickPath: (kind) => ipcRenderer.invoke('zfh:pickPath', kind),
  exportBundle: () => ipcRenderer.invoke('zfh:exportBundle'),
  openWindow: (name) => ipcRenderer.invoke('zfh:openWindow', name),
  hideSelf: () => ipcRenderer.send('zfh:hide-self'),
  // 订阅推送
  onState: (cb) => ipcRenderer.on('zfh:state', (_e, st) => cb(st)),
  onLog: (cb) => ipcRenderer.on('zfh:log', (_e, line) => cb(line))
});
