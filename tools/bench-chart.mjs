/**
 * K 线单帧成本基准（2026-10-04）
 * ===============================================================
 * 目的：把「手机上手势掉帧」拆成**可量的数**，不靠推理。
 *
 * 量两组东西：
 *   - `windowFor()` —— 出这一帧要画的 K 线与量柱（计算层，纯 JS）
 *   - `drawChart()` —— 把这一帧画进画布（JS 侧的绘制调用，不含浏览器真正光栅化）
 * 四种组合：`1h` / `1d` × 可见 65 根 / 240 根（后两者对应「缩放后看大幅波动」的那种视野）。
 * 每帧都**挪一格视野**（`right` 变化）⇒ 量柱 P95 缓存全部落空 ⇒ 量的是最坏的拖动工况。
 *
 * ⚠️ canvas 用**打桩**（no-op 2D context）：这里量不到浏览器的布局 / 光栅化 / 合成成本 ——
 *    那一层只有真机（或 DevTools 节流）才有。所以本脚本的结论只用来回答一个问题：
 *    **计算层是不是瓶颈**。是 ⇒ 优化算法；否 ⇒ 瓶颈在 DOM / 布局那一侧。
 *
 * ⚠️ `globalThis` 上的浏览器桩必须在 `import` 之前设好（`chart.js` 的 `theme()` 会读
 *    `getComputedStyle`，`market.js` 会用 `fetch` / `DecompressionStream` 读本地数据包）。
 *
 * 运行：node tools/bench-chart.mjs
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ── 浏览器桩 ───────────────────────────────────────────────────────── */
globalThis.document = { documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#3ba55d' });
globalThis.devicePixelRatio = 2;

/* T11（2026-10-04 审计）：原来用 `process.cwd()` —— 从仓库根之外的目录运行（如 `node tools/…`
   的上级目录）就找不到数据包、报「读不到 data/…」。改成**相对本文件**定位仓库根，与运行目录无关。 */
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
/* ⚠️ 运行时的 `DATA_DIR` 是 `data`（Vite 把 `public/` 当站点根）⇒ 磁盘上真实路径要多一层
   `public/`。两处都试，谁存在读谁。 */
globalThis.fetch = async url => {
  const rel = String(url).replace(/^\.\//, '');
  for (const p of [path.join(ROOT, rel), path.join(ROOT, 'public', rel)]) {
    try { return new Response(await readFile(p)); } catch { /* 换下一个 */ }
  }
  throw new Error(`基准脚本读不到 ${rel}`);
};

/* no-op 2D context：任何方法都是空函数，任何被赋值的属性（fillStyle / font…）照常存下 */
const ctx = new Proxy({}, {
  get(t, k) {
    if (k === 'measureText') return () => ({ width: 24 });
    const v = t[k];
    if (v !== undefined) return v;
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; },
});
const canvas = { width: 0, height: 0, getContext: () => ctx };

/* ── 真实模块（桩设好之后再加载） ─────────────────────────────────────── */
const { loadCoin, loadLiq, rangeOf } = await import('../src/core/market.js');
const { windowFor, viewOf } = await import('../src/ui/view.js');
const { drawChart } = await import('../src/ui/chart.js');

const SYM = 'BTC';
const CSS_W = 375;      // 手机窄屏
const CSS_H = 214;      // 实测画布高（plotH ≈ 186）

await loadCoin(SYM);
await loadLiq();
const r = rangeOf(SYM);
const i = r[1] - 1;                     // 当前根放在数据末端

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];

/**
 * @param {'1h'|'1d'} mode
 * @param {number} count 可见根数
 */
function bench(mode, count, n = 600) {
  const v = viewOf(SYM, '');
  v.mode = mode;
  v.count = count;
  v.locked = true;                      // 锁视野 ⇒ `norm` 不再自动跟随当前根，`right` 由本脚本摆

  const curRight = mode === '1d' ? Math.floor(i / 24) : i;

  const makeOpts = k => {
    v.right = curRight - (k % 40);      // 每帧挪一格 ⇒ P95 缓存落空 = 最坏拖动工况
    const win = windowFor(SYM, i, CSS_W, true, '');
    return {
      candles: win.candles, vols: win.vols, pvols: win.pvols,
      slots: win.slots, anchors: [], right: win.right,
      cacheKey: `${SYM}|${win.mode}|${win.right}|${win.count}`,
      topInset: 28, levels: null,
      mark: win.candles.length ? win.candles[win.candles.length - 1].c : null,
      entry: null, side: null, liq: null,
      cssW: CSS_W, cssH: CSS_H, yPx: win.yPx,
    };
  };

  for (let k = 0; k < 60; k++) { makeOpts(k); drawChart(canvas, makeOpts(k)); }   // 预热

  const tw = [], td = [];
  for (let k = 0; k < n; k++) {
    const t0 = performance.now();
    const o = makeOpts(k);
    const t1 = performance.now();
    drawChart(canvas, o);
    const t2 = performance.now();
    tw.push(t1 - t0);
    td.push(t2 - t1);
  }
  tw.sort((a, b) => a - b); td.sort((a, b) => a - b);
  const w = windowFor(SYM, i, CSS_W, true, '');
  return {
    bars: w.candles.length,
    w50: pct(tw, 0.5), w99: pct(tw, 0.99),
    d50: pct(td, 0.5), d99: pct(td, 0.99),
  };
}

const rows = [];
for (const mode of ['1h', '1d']) {
  for (const count of [65, 240]) rows.push([mode, count, bench(mode, count)]);
}

const f = x => x.toFixed(3).padStart(7);
console.log('\n  BTC · 375×214 · 每帧挪一格视野（缓存全落空）·  单位 ms\n');
console.log('  模式  可见根数  实际K线   windowFor(p50/p99)   drawChart(p50/p99)   合计 p50/p99');
console.log('  ' + '-'.repeat(76));
for (const [mode, count, m] of rows) {
  const t50 = m.w50 + m.d50, t99 = m.w99 + m.d99;
  console.log(`  ${mode.padEnd(6)}${String(count).padStart(6)}${String(m.bars).padStart(9)}`
    + `   ${f(m.w50)} /${f(m.w99)}   ${f(m.d50)} /${f(m.d99)}   ${f(t50)} /${f(t99)}`);
}
console.log('\n  ⚠️ 不含浏览器布局 / 光栅化 / 合成 —— 只回答「计算层是不是瓶颈」。');
console.log('     60fps 的预算是 16.7ms/帧。\n');
