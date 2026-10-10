/**
 * 架空行情生成器 · 校准工具（2026-10-10 · 架空模式 P2）
 * ==========================================================================
 * 只读 `public/data/*.bin` ＋ `index.json`，实测真实历史统计量，输出一张**参数表**，
 * 供人工复核后**硬编码**进 `src/core/ficgen.js`（并注明出处）。
 *
 * 用法：`node tools/calib-fic.mjs`（不写任何文件 —— 输出打到 stdout，人工抄进 ficgen.js）
 *
 * ⚠️ 本文件是**工具**、不是产品代码：不进 `npm run build`。
 *
 * 产出量（一一对应 ficgen 的魔数）：
 *   ① 各币小时对数收益的**年化波动**（全期 ＋ 分年代）
 *   ② 峰度 ＋ |r| 上尾的 **Hill 尾部指数**（→ Student-t 的 ν）
 *   ③ 单根**插针**频率与幅度分布（→ 跳跃强度 λ 与双指数参数）
 *   ④ BTC 的 **GARCH(1,1) 自相关**粗估 α（β 取 0.98 − α）
 *   ⑤ 山寨对 BTC 因子的 **β 载荷**与残差 σ
 *   ⑥ `liq.bin` 的**日流动性年代增长曲线**（→ liqOf 生成）
 *   ⑦ 各币 12 年**最大回撤**（→ 体制波动比）
 *   ⑧ BTC **牛/熊段长度**（30 日动量定号 → Markov 段长）
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA = path.join(ROOT, 'public', 'data');
const HOUR_MS = 3600e3;
const HOURS_PER_YEAR = 24 * 365.25;

const mf = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));

/** 解一个币的包 → { start, count, horizons, closes } */
function loadCoin(sym) {
  const meta = mf.coins[sym];
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(DATA, meta.file)));
  const count = meta.count, scale = meta.scale;
  const n = count * 4;
  const ints = new Int32Array(raw.buffer, raw.byteOffset, n);
  const closes = new Float64Array(count);
  const highs = new Float64Array(count);
  const lows = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const k = i * 4;
    const o = ints[k] / scale;
    highs[i] = o + ints[k + 1] / scale;
    lows[i] = o + ints[k + 2] / scale;
    closes[i] = o + ints[k + 3] / scale;
  }
  return { start: meta.start, count, closes, highs, lows };
}

/** 小时对数收益（跳过非正值） */
function logReturns(closes) {
  const r = new Float64Array(closes.length);
  for (let i = 1; i < closes.length; i++) {
    r[i] = (closes[i] > 0 && closes[i - 1] > 0) ? Math.log(closes[i] / closes[i - 1]) : 0;
  }
  return r;
}

const mean = a => { let s = 0; for (const v of a) s += v; return s / a.length; };
const std = (a, m = mean(a)) => Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
function kurt(a, m = mean(a), sd = std(a, m)) {
  let s = 0; for (const v of a) { const z = (v - m) / sd; s += z * z * z * z; }
  return s / a.length;
}
function median(a) { const b = Float64Array.from(a).sort(); const n = b.length; return n % 2 ? b[(n - 1) >> 1] : (b[n / 2 - 1] + b[n / 2]) / 2; }
function quantile(a, q) { const b = Float64Array.from(a).sort(); const p = (b.length - 1) * q; const lo = Math.floor(p); const hi = Math.ceil(p); return b[lo] + (b[hi] - b[lo]) * (p - lo); }

/** Hill 尾部指数（对 |r| 上尾 k 个的最大似然） */
function hill(a, frac = 0.02) {
  const b = Float64Array.from(a, Math.abs).filter(v => v > 0).sort();
  const k = Math.max(20, Math.floor(b.length * frac));
  const tail = b.slice(b.length - k);
  const xk = tail[0];
  let s = 0; for (const v of tail) s += Math.log(v / xk);
  return s > 0 ? k / s : NaN;   // ξ = 1/α（尾部指数）；α = 1/ξ
}

/** GARCH(1,1) 的 α 粗估：corr(r²_t, r²_{t-1})（ARCH 效应强度） */
function archAcf1(r) {
  const n = r.length;
  const a = new Float64Array(n - 1), b = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) { a[i - 1] = r[i] * r[i]; b[i - 1] = r[i - 1] * r[i - 1]; }
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(da * db);
}

/** 插针：单根 |r| > k × 当日滚动 σ 的根，统计频率与超出幅度 */
function spikes(r, k = 6, win = 168) {
  const n = r.length;
  let hits = 0, sumAmp = 0, mx = 0;
  const amps = [];
  for (let i = win; i < n; i++) {
    let s = 0; for (let j = i - win; j < i; j++) s += r[j] * r[j];
    const sd = Math.sqrt(s / win);
    const a = Math.abs(r[i]);
    if (sd > 0 && a > k * sd) { hits++; amps.push(a); sumAmp += a; if (a > mx) mx = a; }
  }
  return { freq: hits / Math.max(1, n - win), meanAmp: hits ? sumAmp / hits : 0, maxAmp: mx, p99Amp: amps.length ? quantile(amps, 0.99) : 0 };
}

/** 最大回撤（基于收盘） */
function maxDrawdown(closes) {
  let peak = -Infinity, mdd = 0;
  for (const c of closes) { if (c > peak) peak = c; const dd = 1 - c / peak; if (dd > mdd) mdd = dd; }
  return mdd;
}

/** 牛/熊段长度：30 日动量定号，跑長度统计 */
function regimeRuns(closes) {
  const D = 24 * 30;
  let sign = 0, run = 0, bull = 0, bear = 0;
  const bulls = [], bears = [];
  for (let i = D; i < closes.length; i++) {
    const mom = closes[i] / closes[i - D] - 1;
    const sg = mom >= 0 ? 1 : -1;
    if (sg === sign) run++;
    else { if (sign === 1) { bulls.push(run); bull += run; } else if (sign === -1) { bears.push(run); bear += run; } sign = sg; run = 1; }
  }
  return { nBull: bulls.length, nBear: bears.length, medBullDays: bull / Math.max(1, bulls.length) / 24, medBearDays: bear / Math.max(1, bears.length) / 24 };
}

const SYMS = Object.keys(mf.coins);
const coins = {}, rets = {};
for (const sym of SYMS) {
  coins[sym] = loadCoin(sym);
  rets[sym] = logReturns(coins[sym].closes);
}

console.log('═══ 架空行情生成器校准（基于 public/data 实测）═══\n');

console.log('── ① 小时对数收益 · 年化波动 / 峰度 / 尾部（ν）/ 插针 / 最大回撤 ──');
console.log('sym    annVol%   kurt   tailα(ν~)  spikeFreq%  spikeMean%  spikeMax%  maxDD%');
for (const sym of SYMS) {
  const r = Array.from(rets[sym]).slice(1);
  const sd = std(r);
  const ku = kurt(r);
  const xi = hill(r);
  const alphaTail = 1 / xi;                 // 尾部指数 α（Pareto）；Student-t 的 ν ≈ α
  const sp = spikes(rets[sym]);
  const mdd = maxDrawdown(coins[sym].closes);
  console.log(
    `${sym.padEnd(6)} ${(sd * Math.sqrt(HOURS_PER_YEAR) * 100).toFixed(0).padStart(6)}  ` +
    `${ku.toFixed(1).padStart(5)}  ${alphaTail.toFixed(2).padStart(8)}  ` +
    `${(sp.freq * 100).toFixed(3).padStart(9)}  ${(sp.meanAmp * 100).toFixed(2).padStart(9)}  ` +
    `${(sp.maxAmp * 100).toFixed(1).padStart(8)}  ${(mdd * 100).toFixed(1).padStart(6)}`
  );
}

console.log('\n── ② BTC 分年代年化波动（每 2 年一格）──');
{
  const c = coins.BTC, r = rets.BTC;
  const startMs = c.start;
  let lo = 0;
  for (let y = 0; y < 12; y += 2) {
    const tLo = Date.UTC(2013 + y, 0, 1), tHi = Date.UTC(2015 + y, 0, 1);
    const iLo = Math.max(1, Math.round((tLo - startMs) / HOUR_MS));
    const iHi = Math.min(r.length, Math.round((tHi - startMs) / HOUR_MS));
    const seg = Array.from(r.slice(iLo, iHi));
    console.log(`  ${2013 + y}-${2014 + y}: annVol ${(std(seg) * Math.sqrt(HOURS_PER_YEAR) * 100).toFixed(0)}%`);
    void lo;
  }
}

console.log('\n── ③ BTC GARCH(1,1)：ARCH(1) 自相关 → α；β = 0.98 − α ──');
{
  const acf = archAcf1(rets.BTC);
  const alpha = Math.max(0.03, Math.min(0.15, acf));
  console.log(`  ARCH(1) acf = ${acf.toFixed(4)}  ⇒ α ≈ ${alpha.toFixed(3)}, β ≈ ${(0.98 - alpha).toFixed(3)}`);
}

console.log('\n── ④ 山寨对 BTC 因子的 β 载荷 与 残差年化波动 ──');
{
  // 把 BTC 收益摊到「全局小时序号」
  const btc = coins.BTC, rb = rets.BTC;
  const g0 = Math.round((btc.start - mf.start) / HOUR_MS);
  const btcByH = new Float64Array(g0 + rb.length).fill(NaN);
  for (let i = 0; i < rb.length; i++) btcByH[g0 + i] = rb[i];
  console.log('sym    beta    R²      residAnnVol%');
  for (const sym of SYMS) {
    if (sym === 'BTC') { console.log(`  BTC   1.000   1.000    0.0`); continue; }
    const c = coins[sym], r = rets[sym];
    const a0 = Math.round((c.start - mf.start) / HOUR_MS);
    const X = [], Y = [];
    for (let i = 1; i < r.length; i++) {
      const bf = btcByH[a0 + i];
      if (Number.isFinite(bf)) { X.push(bf); Y.push(r[i]); }
    }
    const mx = mean(X), my = mean(Y);
    let cov = 0, vx = 0;
    for (let i = 0; i < X.length; i++) { cov += (X[i] - mx) * (Y[i] - my); vx += (X[i] - mx) * (X[i] - mx); }
    const beta = cov / vx;
    const resid = Y.map((y, i) => y - beta * X[i]);
    const mres = mean(resid);
    const r2 = 1 - resid.reduce((s, v) => s + (v - mres) * (v - mres), 0) / Y.reduce((s, v) => s + (v - my) * (v - my), 0);
    console.log(`  ${sym.padEnd(5)} ${beta.toFixed(2).padStart(5)}  ${r2.toFixed(3)}   ${(std(resid) * Math.sqrt(HOURS_PER_YEAR) * 100).toFixed(0)}`);
  }
}

console.log('\n── ④b 近年代（2021–2024）年化波动 与 对 BTC 的 β（供 v3 调参）──');
{
  const btc = coins.BTC, rb = rets.BTC;
  const g0 = Math.round((btc.start - mf.start) / HOUR_MS);
  const btcByH = new Float64Array(g0 + rb.length).fill(NaN);
  for (let i = 0; i < rb.length; i++) btcByH[g0 + i] = rb[i];
  const tLo = Date.UTC(2021, 0, 1), tHi = Date.UTC(2025, 0, 1);
  const win = (startMs, r) => {
    const a = Math.max(1, Math.round((tLo - startMs) / HOUR_MS));
    const b = Math.min(r.length, Math.round((tHi - startMs) / HOUR_MS));
    return a < b ? r.slice(a, b) : null;
  };
  const bseg = win(btc.start, rb);
  const bvol = std(Array.from(bseg)) * Math.sqrt(HOURS_PER_YEAR);
  console.log(`  BTC 近年代年化波动 = ${(bvol * 100).toFixed(0)}%`);
  console.log('sym    annVol%   ratio(vs BTC)  beta(2021-24)  idio=√(ratio²−β²)');
  for (const sym of SYMS) {
    const c = coins[sym], r = rets[sym];
    const seg = win(c.start, r);
    if (!seg) { console.log(`  ${sym.padEnd(5)} (no data)`); continue; }
    const vol = std(Array.from(seg)) * Math.sqrt(HOURS_PER_YEAR);
    const ratio = vol / bvol;
    let beta = 1, idio = 0;
    if (sym !== 'BTC') {
      const a0 = Math.round((c.start - mf.start) / HOUR_MS);
      const X = [], Y = [];
      for (let i = 1; i < r.length; i++) {
        const t = c.start + i * HOUR_MS;
        if (t < tLo || t >= tHi) continue;
        const bf = btcByH[a0 + i];
        if (Number.isFinite(bf)) { X.push(bf); Y.push(r[i]); }
      }
      const mx = mean(X), my = mean(Y);
      let cov = 0, vx = 0;
      for (let i = 0; i < X.length; i++) { cov += (X[i] - mx) * (Y[i] - my); vx += (X[i] - mx) * (X[i] - mx); }
      beta = cov / vx;
      idio = Math.sqrt(Math.max(0, ratio * ratio - beta * beta));
    }
    console.log(`  ${sym.padEnd(5)} ${(vol * 100).toFixed(0).padStart(6)}   ${ratio.toFixed(2).padStart(9)}     ${beta.toFixed(2).padStart(8)}      ${idio.toFixed(3)}`);
  }
}

console.log('\n── ④c 长期成长载荷 growthLoad（各币上线→2024-12 的真实涨幅 ÷ BTC 同期涨幅）──');
{
  /* 用途：**长期水平**不能沿用小时 β（那是短周期联动），要单独取「上线至今的涨幅比」。
     BTC 归一化到 1；山寨普遍 <1（长期跑输 BTC），SOL 例外。 */
  const btc = coins.BTC, rb = rets.BTC;
  const b0 = Math.round((btc.start - mf.start) / HOUR_MS);
  const btcAt = idx => {                       // idx = 全局小时序号
    const k = idx - b0;
    return (k >= 0 && k < btc.closes.length) ? btc.closes[k] : NaN;
  };
  const g = mf.start;                         // 清单起点 = 游戏起点（2013-01-01）
  console.log('sym    first→last 真实涨幅   同期 BTC 涨幅   growthLoad');
  for (const sym of SYMS) {
    const c = coins[sym];
    const gS = c.start, gE = c.start + (c.count - 1) * HOUR_MS;
    const lc = Math.log(c.closes[c.count - 1] / c.closes[0]);
    const lb = Math.log(btcAt(Math.round((gE - g) / HOUR_MS)) / btcAt(Math.round((gS - g) / HOUR_MS)));
    const load = sym === 'BTC' ? 1 : lc / lb;
    console.log(`  ${sym.padEnd(5)} ×${(Math.exp(lc)).toExponential(2).padStart(9)}  ×${(Math.exp(lb)).toExponential(2).padStart(9)}   ${load.toFixed(2)}`);
  }
}

console.log('\n── ⑤ 日流动性年代增长曲线（BTC 每日 中位/分位，美元/天）──');
{
  const meta = mf.liq;
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(DATA, meta.file)));
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const days = meta.days, n = meta.order.indexOf('BTC');
  console.log('  year    p25        median        p75');
  for (let y = 2013; y <= 2024; y++) {
    const dLo = Math.round((Date.UTC(y, 0, 1) - meta.start) / 86400e3) + meta.preDays;
    const dHi = Math.round((Date.UTC(y + 1, 0, 1) - meta.start) / 86400e3) + meta.preDays;
    const seg = [];
    for (let d = Math.max(0, dLo); d < Math.min(days, dHi); d++) { const v = f[n * days + d]; if (v > 0) seg.push(v); }
    if (!seg.length) { console.log(`  ${y}   (no data)`); continue; }
    console.log(`  ${y}   ${quantile(seg, 0.25).toExponential(2).padStart(10)}  ${median(seg).toExponential(2).padStart(12)}  ${quantile(seg, 0.75).toExponential(2).padStart(12)}`);
  }
}

console.log('\n── ⑤b 各币日流动性（2021–2024 中位，美元/天）与相对 BTC 份额 ──');
{
  const meta = mf.liq;
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(DATA, meta.file)));
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const days = meta.days;
  const med = {};
  for (const sym of meta.order) {
    const n = meta.order.indexOf(sym);
    const dLo = Math.round((Date.UTC(2021, 0, 1) - meta.start) / 86400e3) + meta.preDays;
    const dHi = Math.round((Date.UTC(2025, 0, 1) - meta.start) / 86400e3) + meta.preDays;
    const seg = [];
    for (let d = Math.max(0, dLo); d < Math.min(days, dHi); d++) { const v = f[n * days + d]; if (v > 0) seg.push(v); }
    med[sym] = seg.length ? median(seg) : 0;
  }
  for (const sym of meta.order) console.log(`  ${sym.padEnd(5)} ${med[sym].toExponential(2).padStart(11)}   share=${(med[sym] / med.BTC).toFixed(2)}×BTC`);
}

console.log('\n── ⑥ BTC 牛/熊段长度（30 日动量定号）──');
{
  const rr = regimeRuns(coins.BTC.closes);
  console.log(`  段数：牛 ${rr.nBull} / 熊 ${rr.nBear}；中位段长：牛 ${rr.medBullDays.toFixed(0)} 天 / 熊 ${rr.medBearDays.toFixed(0)} 天`);
}

console.log('\n════════════════════════════════════════════');
console.log('以上数字人工复核后硬编码进 src/core/ficgen.js（注明出处与日期）。');