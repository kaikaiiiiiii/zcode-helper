'use strict';
/* capability-check.js — 验证 Electron 主进程 Node 能力（node:sqlite / 全局 WebSocket），打印后退出 */
try {
  console.log('node:', process.versions.node);
  console.log('electron:', process.versions.electron);
  console.log('WebSocket:', typeof WebSocket);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (id INTEGER)');
  db.prepare('INSERT INTO t (id) VALUES (?)').run(42);
  const row = db.prepare('SELECT id FROM t').get();
  console.log('node:sqlite:', row.id === 42 ? 'OK' : 'BAD');
  db.close();
} catch (e) {
  console.log('CAPABILITY-FAIL:', e.message);
}
process.exit(0);
