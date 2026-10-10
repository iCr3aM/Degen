/**
 * 架空世界线 · 蒙特卡洛矩阵工具（2026-10-10 · 架空模式 P2 复盘）
 * ==========================================================================
 * 对 N 个随机种子各生成一条世界线，统计**每年各币价格的分位区间**（p5/p25/p50/p75/p95）、
 * 全期最大回撤分布、终值涨跌分布 —— 回答「架空走势长什么样、价格落在哪些区间」。
 *
 * 用法：`node tools/mc-fic.mjs [N]`（默认 N=200；只读、不写文件）
 * ⚠️ 工具、不是产品代码：不进 `npm run build`。
 */

import { generateWorld, closesOf, FIC_COIN_PARAMS } from '../src/core/ficgen.js';
import { GAME, HOUR_MS, COINS } from '../src/core/config.js';

const N = Math.max(1, Number(process.argv[2] || 200));
const SYMS = COINS.map(c => c.sym);
const YEARS = [];
for (let y = 2013; y <= 2033; y++) YEARS.push(y);

/** 某个币「某年 1 月 1 日」在它自己序列里的下标（负数 = 该年尚未上线） */
function yearIndex(sym, y) {
  const c = COINS.find(x => x.sym === sym);
  const g0 = Math.max(0, Math.round((c.unlock - GAME.start) / HOUR_MS));
  return Math.round((Date.UTC(y, 0, 1) - GAME.start) / HOUR_MS) - g0;
}

function pct(arr, q) {
  if (!arr.length) return NaN;
  const b = Float64Array.from(arr).sort();
  const p = (b.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return b[lo] + (b[hi] - b[lo]) * (p - lo);
}

const price = {}, dd = {}, ret = {}, dead = {};
for (const s of SYMS) { price[s] = {}; for (const y of YEARS) price[s][y] = []; dd[s] = []; ret[s] = []; dead[s] = 0; }

const t0 = Date.now();
for (let k = 0; k < N; k++) {
  const seed = (Math.imul(k + 1, 2654435761) >>> 0) || 1;
  const w = generateWorld(seed);
  for (const s of SYMS) {
    const cl = closesOf(w, s);
    for (const y of YEARS) { const i = yearIndex(s, y); if (i >= 0 && i < cl.length) price[s][y].push(cl[i]); }
    let peak = -Infinity, mdd = 0;
    for (const v of cl) { if (v > peak) peak = v; const d = 1 - v / peak; if (d > mdd) mdd = d; }
    dd[s].push(mdd);
    ret[s].push(cl[cl.length - 1] / cl[0] - 1);
    if (cl[cl.length - 1] < cl[0] * 0.01) dead[s]++;      // 终值 < 起点 1% ⇒ 「实质归零」
  }
  if ((k + 1) % 50 === 0) process.stderr.write(`  ... ${k + 1}/${N}\n`);
}
const ms = Date.now() - t0;

const fN = (v) => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 1 ? v.toFixed(2) : v.toPrecision(3));

console.log(`\n═══ 架空世界线矩阵（N=${N} 条种子，${(ms / 1000).toFixed(1)}s）═══\n`);

/* ── BTC 逐年分位矩阵（美元）── */
console.log('【BTC】逐年价格分位（美元）');
console.log('year     p5         p25        p50        p75        p95');
for (const y of YEARS) {
  const a = price.BTC[y];
  if (!a.length) continue;
  console.log(`${y}  ${fN(pct(a, .05)).padStart(10)} ${fN(pct(a, .25)).padStart(10)} ${fN(pct(a, .5)).padStart(10)} ${fN(pct(a, .75)).padStart(10)} ${fN(pct(a, .95)).padStart(10)}`);
}

/* ── 各币：上线首年 / 2024 / 2033 分位 ── */
for (const s of SYMS) {
  if (s === 'BTC') continue;
  const first = YEARS.find(y => price[s][y].length > 0);
  const a24 = price[s][2024], a33 = price[s][2033], a0 = price[s][first];
  console.log(`\n【${s}】上线 ${first}（起点量级锚 ${FIC_COIN_PARAMS[s] ? FIC_COIN_PARAMS[s].genesis : '-'}）`);
  const row = (label, a) => a && a.length
    ? console.log(`${label.padEnd(6)} p5=${fN(pct(a, .05))}  p25=${fN(pct(a, .25))}  p50=${fN(pct(a, .5))}  p75=${fN(pct(a, .75))}  p95=${fN(pct(a, .95))}`)
    : null;
  row(`${first}`, a0); row('2024', a24); row('2033', a33);
}

/* ── 终值与回撤分布 ── */
console.log('\n【终值（2033 ÷ 起点）与全期最大回撤】');
console.log('sym    终值倍数 p5/p50/p95     最大回撤 p5/p50/p95      终值<起点1%');
for (const s of SYMS) {
  const mult = ret[s].map(v => 1 + v);
  console.log(`${s.padEnd(5)} ${fN(pct(mult, .05)).padStart(7)} /${fN(pct(mult, .5)).padStart(9)} /${fN(pct(mult, .95)).padStart(9)}   ` +
    `${(pct(dd[s], .05) * 100).toFixed(0).padStart(4)}% /${(pct(dd[s], .5) * 100).toFixed(0).padStart(4)}% /${(pct(dd[s], .95) * 100).toFixed(0).padStart(4)}%    ` +
    `${(dead[s] / N * 100).toFixed(1)}%`);
}

/* ── BTC 牛熊段比例（从价格序列反推：连续 30 日动量定号）── */
console.log('\n【BTC 牛/熊时间占比（30 日动量定号，跨种子平均）】');
{
  const K = Math.min(N, 60);
  let bTot = 0, sTot = 0;
  for (let k = 0; k < K; k++) {
    const w = generateWorld((Math.imul(k + 1, 2654435761) >>> 0) || 1);
    const cl = closesOf(w, 'BTC');
    const D = 24 * 30;
    for (let i = D; i < cl.length; i++) { if (cl[i] >= cl[i - D]) bTot++; else sTot++; }
  }
  const n = bTot + sTot;
  console.log(`  牛 ${(bTot / n * 100).toFixed(1)}%  :  熊 ${(sTot / n * 100).toFixed(1)}%   （样本 ${K} 条）`);
}
console.log('');