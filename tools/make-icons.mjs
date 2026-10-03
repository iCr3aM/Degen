#!/usr/bin/env node
/**
 * 一次性脚本：把游戏图标（深底 ＋ 三根迷你 K 线）光栅化成 PWA 要的两张 PNG。
 *
 * 为什么手写 PNG 编码：项目零运行时依赖（devDependencies 只有 vite），
 * 不想为一个「生成两张图」的活引入 sharp / canvas 这类原生增强包。
 * 这里只用 Node 自带的 `zlib`：IHDR / IDAT / IEND ＋ CRC32，RGBA8、filter 0 —— 够用可控。
 *
 * 用法：node tools/make-icons.mjs
 * 产物：public/icon-192.png、public/icon-512.png
 *
 * ⚠️ 几何必须与 `index.html` 的 favicon、`src/ui/render.js` 的 logoEl() **逐字一致**：
 *    64×64 视图里柱宽 14 / 间隙 5 / 左右各留 6，影线宽 4 且水平居中于实体。
 * ⚠️ `icon-512.png` 同时被 manifest 声明为 `maskable` —— 安卓按自己的形状裁切
 *    （圆 / 水滴 / 方），只保证**中心 80% 的圆**内可见。所以图案整体缩到 70% 居中，
 *    外接圆正好落在安全圆内；底色**满幅**铺开（maskable 不允许透明圆角）。
 * ⚠️ 改图案请三处同步：这里、favicon、logoEl()。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/* ── 图案（64×64 视图；与 favicon / logoEl 同一组矩形）─────────────────── */
const BG = [0x0a, 0x0f, 0x1a];   // 与 favicon 的深底同色（这里是 PNG，只能硬编码）
const UP = [0x00, 0xd1, 0x8f];
const DOWN = [0xff, 0x5b, 0x6a];
const RECTS = [
  [11, 26, 4, 30, DOWN], [6, 33, 14, 16, DOWN],   // 左：跌烛
  [30, 12, 4, 34, UP], [25, 20, 14, 18, UP],      // 中：涨烛
  [49, 6, 4, 30, UP], [44, 11, 14, 16, UP],       // 右：涨烛（更高）
];
/* 图案外接圆（半对角线）在 64 视图里约 36.1 ⇒ 缩到 70% 后约 25.3 < 安全圆半径 25.6。*/
const SAFE_SCALE = 0.7;

function colorAt(u, v) {
  // u,v ∈ [0,64)：先做「缩到 70% 居中」的逆变换，再命中测试（后画的压在前面的上面）。
  // ⚠️ 缩放中心是**图案外接框的中心**（x 6–58 → 32、y 6–56 → **31**，不是 32）——
  //    按 32 居中会让整幅图案在画布上偏上约 2.3%（512 版约 11px）。
  const x = (u - 32) / SAFE_SCALE + 32;
  const y = (v - 32) / SAFE_SCALE + 31;
  let c = BG;
  for (const [rx, ry, rw, rh, col] of RECTS) {
    if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) c = col;
  }
  return c;
}

/* ── 光栅化：每像素 4×4 超采样，边缘不出现锯齿 ──────────────────────────── */
const SS = 4;
function raster(size) {
  const px = Buffer.alloc(size * size * 4);
  const n = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt(
            (x + (sx + 0.5) / SS) * 64 / size,
            (y + (sy + 0.5) / SS) * 64 / size,
          );
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = (y * size + x) * 4;
      px[o] = Math.round(r / n);
      px[o + 1] = Math.round(g / n);
      px[o + 2] = Math.round(b / n);
      px[o + 3] = 255;
    }
  }
  return px;
}

/* ── 极简 PNG 编码 ──────────────────────────────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // 位深
  ihdr[9] = 6;    // 颜色类型：RGBA
  // [10] 压缩 / [11] filter / [12] 隔行 均为 0（默认值）
  const stride = size * 4 + 1;         // 每行前置 1 字节 filter
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;               // filter 0 = None
    px.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const buf = png(size, raster(size));
  writeFileSync(join(OUT, `icon-${size}.png`), buf);
  console.log(`public/icon-${size}.png  ${buf.length} bytes`);
}
