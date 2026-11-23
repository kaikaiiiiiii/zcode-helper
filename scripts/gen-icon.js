'use strict';
/**
 * gen-icon.js — 生成托盘/应用图标（零依赖，手写 PNG 编码）
 * 产物：assets/icon.png（品牌）与 assets/tray-{red,green,yellow,gray}.png（状态色圆点）。
 * 运行：node scripts/gen-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- PNG 编码（RGBA 8bit）----
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- 绘制：抗锯齿实心圆 + 白描边（外圈渐隐）----
function drawDot(size, [r, g, b]) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const R = size * 0.38, edge = size * 0.10;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const i = (y * size + x) * 4;
      if (d < R) {
        rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
      } else if (d < R + edge) {
        const a = 1 - (d - R) / edge;
        rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255; rgba[i + 3] = Math.round(a * 200);
      }
    }
  }
  return rgba;
}

const BRAND = [108, 123, 253]; // #6c7bfd
const targets = [
  ['icon.png', 256, BRAND], // 256x256：electron-builder 生成 Windows ico 需要 >=256
  ['tray-red.png', 32, [229, 72, 77]],
  ['tray-green.png', 32, [48, 164, 108]],
  ['tray-yellow.png', 32, [245, 165, 36]],
  ['tray-gray.png', 32, [139, 141, 152]]
];

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, size, color] of targets) {
  const png = encodePng(size, size, drawDot(size, color));
  fs.writeFileSync(path.join(outDir, name), png);
  console.log(`generated assets/${name} (${size}x${size}, ${png.length} bytes)`);
}
