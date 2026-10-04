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
 *    64×64 视图里柱宽 14 / 间隙 5 / 左右各留 6，影线宽 4 且水平居中于实体，实体圆角 2。
 *    外接框固定为 x 6–58 / y 6–56（中心 32,31）—— 改内部比例可以，改外框就要重算 SAFE_SCALE。
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
/* [x, y, w, h, 颜色, 圆角半径]：影线不圆角，实体 2（64 视图内的 2px 圆角 —— 更精致，48px 下也不糊）。 */
const RECTS = [
  [11, 27, 4, 29, DOWN, 0], [6, 34, 14, 15, DOWN, 2],    // 左：跌烛
  [30, 14, 4, 32, UP, 0],   [25, 21, 14, 18, UP, 2],     // 中：涨烛
  [49, 6, 4, 30, UP, 0],    [44, 10, 14, 19, UP, 2],     // 右：涨烛（实体最高）
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
  for (const [rx, ry, rw, rh, col, r] of RECTS) {
    if (!inRect(x, y, rx, ry, rw, rh, r)) continue;
    c = col;
  }
  return c;
}

/* 圆角矩形命中测试：先做轴对齐外框快速剔除，再把点夹到「圆角圆心矩形」上比距离。
   圆心落在核心区内的点距离为 0（必中），只有四个角按圆弧判定。 */
function inRect(x, y, X, Y, W, H, r) {
  if (x < X || x >= X + W || y < Y || y >= Y + H) return false;
  if (!r) return true;
  const cx = Math.min(Math.max(x, X + r), X + W - r);
  const cy = Math.min(Math.max(y, Y + r), Y + H - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
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

/* T11（2026-10-04 审计）：这个脚本**无条件覆盖** `public/icon-*.png` —— 图案或编码一旦改坏，
   产物会静默变烂（透明 / 错色 / 尺寸不符），要到真机「添加到主屏」才看得出来。
   故写盘前先验**产物本身**（不是验输入参数）：
     ① PNG 签名 / 首个块是 IHDR / IHDR 里的宽高、位深、颜色类型；
     ② 几何一致性：alpha 必须**全 255**（maskable 不允许透明圆角），且底色 / 涨色 / 跌色三色都出现过。
   任一不过就抛错、**不覆盖**已有图标。 */
function assertPng(size, buf, px) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error(`icon-${size}.png 签名不符`);
  if (buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error(`icon-${size}.png 首个块不是 IHDR`);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const depth = buf[24], color = buf[25];
  if (w !== size || h !== size) throw new Error(`icon-${size}.png 尺寸 ${w}×${h} ≠ ${size}`);
  if (depth !== 8 || color !== 6) throw new Error(`icon-${size}.png 位深/色型 ${depth}/${color} ≠ 8/6(RGBA)`);
  const seen = new Set();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] !== 255) throw new Error(`icon-${size}.png 第 ${i / 4} 个像素非不透明 —— maskable 不允许`);
    seen.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
  }
  for (const [rgb, name] of [[BG, '底色'], [UP, '涨色'], [DOWN, '跌色']]) {
    if (!seen.has(rgb.join(','))) throw new Error(`icon-${size}.png 缺少${name}像素 —— 图案没画上？`);
  }
}

for (const size of [192, 512]) {
  const px = raster(size);
  const buf = png(size, px);
  assertPng(size, buf, px);
  writeFileSync(join(OUT, `icon-${size}.png`), buf);
  console.log(`public/icon-${size}.png  ${buf.length} bytes`);
}
