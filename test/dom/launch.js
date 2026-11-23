'use strict';
/**
 * test/dom/launch.js — 以干净环境拉起 Electron 跑 DOM 测试
 *
 * 直接 `electron test/dom/run.js` 在设置了 ELECTRON_RUN_AS_NODE 的终端里会把 electron 当 node 跑；
 * 这里显式清掉该变量，保证跨终端都能跑。
 */
const { spawn } = require('child_process');
const path = require('path');

const electronPath = require('electron'); // 从普通 node 进程 require 得到二进制路径
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [path.join(__dirname, 'run.js')], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code === null ? 1 : code));
child.on('error', err => { console.error('failed to launch electron:', err.message); process.exit(1); });
