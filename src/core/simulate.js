/**
 * 细粒度模拟层（S1）—— 把「1 根真实小时 K」展开成 N 根种子化细刻度
 * ===============================================================
 * 纯逻辑、零 DOM、零依赖（除 `config` / `rng`），可 headless 跑。
 *
 * 口径（`细粒度模拟与RNG方案.md` §5，写死勿擅改）：
 *   一根真实小时的 `(O, H, L, C)` 作**硬锚点**，小时内部用**种子化布朗桥 ＋ 两侧归一**生成细路径。
 *   硬要求：`p[0] === O`、`p[N] === C`（**逐位**）、`max(p) === H`、`min(p) === L`（**精确**）。
 *
 * 工程口径（S1 只做 core，不接线、不渲染）：
 *   - **模拟粒度 ≠ 渲染粒度**：这里只负责「怎么生成」，`TICK.perHour` ＝ 120（30 秒）；
 *   - **懒生成 ＋ LRU 缓存**：`(seed, sym, hour, ohlc)` 纯函数 ⇒ 跳到哪算哪、断点续算、多币并行；
 *   - 细 tick **不进存档、不进数据包**。
 *
 * ⚠️ 本项目**本身就是模拟器**：小时内部是模拟出来的这件事只写在注释里，UI 不做任何声明。
 */

import { TICK } from './config.js';
import { rand, hashStr } from './rng.js';

/** 每小时的细刻度数 N（＝ 细路径的段数） */
const N = TICK.perHour;

/** 通道名 —— 分开取数，将来往某一路多取一个数不会打乱其余路（见 `rng.js` 文件头） */
const CH_PATH = hashStr('path');
const CH_VOLUME = hashStr('volume');
const CH_EXTREME = hashStr('extreme');

/** U 型量曲线的噪声幅度（`w = U(x) · (1 + η·z)`，`z ∈ [−1, 1)` ⇒ 恒正） */
const VOL_ETA = 0.35;

/**
 * 均匀数 → 标准正态（Box–Muller，只取 cos 支路）。
 *
 * ⚠️ 用 `1 − u` 而不是 `u`：`u ∈ [0, 1)` ⇒ `1 − u ∈ (0, 1]` ⇒ `log` 恒有定义（`u = 0` 时回 0，不炸）。
 */
function gauss(u1, u2) {
  return Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
}

/* ═════════════════════════ 价格路径（布朗桥 ＋ 两侧归一） ═════════════════════════
 * 为什么这样写能**逐位**命中四个锚点（这是本文件的核心，改动前先读这段）：
 *
 *   ① 端点：把路径写成「开→收直线 a[i] ＋ 偏离 d[i]」，并让 `d` 只来自布朗桥
 *      `d[i] = sqrt(u(1−u)) · 高斯`。布朗桥的方差 `u(1−u)` 在**两端恰为 0**
 *      ⇒ `d[0] = d[N] = 0` ⇒ `p[0] = a[0] = O`、`p[N] = a[N] = C` **结构性成立**（无需事后修补）。
 *      又因为 `a[i]` 落在 O→C 的线段上，所以 `min(O,C) ≤ a[i] ≤ max(O,C)`，天然不越界。
 *
 *   ② 上侧：`p[i] = a[i] + sU·d[i]`（当 `d[i] > 0`）。要 `max(p) === H`，取
 *      `sU = min{ (H − a[i]) / d[i] : d[i] > 0 }`。因 `H ≥ max(O,C) ≥ a[i]`（分子恒 ≥ 0、分母 > 0），
 *      `sU ≥ 0`；且对每个候选 `i` 都有 `sU ≤ (H − a[i])/d[i]` ⇒ `p[i] ≤ H`（**不越上限**）。
 *      取到最小的那个 `i` 上 `p[i] = H` 恰好成立 ⇒ **上极值精确**。
 *   ③ 下侧同理：`sD = min{ (L − a[i]) / d[i] : d[i] < 0 }`（分子 ≤ 0、分母 < 0 ⇒ `sD ≥ 0`），
 *      对每个候选 `i` 都有 `p[i] ≥ L`，取到最小的那个上 `p[i] = L` ⇒ **下极值精确**。
 *   ④ 浮点收尾：算出后**先夹进 [L, H]**（消掉 1 ulp 级别的越界），再**显式赋值**四个锚点
 *      （`p[0]=O` / `p[N]=C` / `p[iU]=H` / `p[iD]=L`）⇒ 断言可以要求**逐位相等**。
 *
 * 副作用：桥的幅度大小（σ_h）在归一中被**约掉** —— 幅度由真实 H/L 决定，所以不需要估 σ_h，
 * 细路径的振幅天然与真实小时一致。
 */

const pathCache = new Map();      // key -> Float64Array(N+1)
const volCache = new Map();       // key -> Float64Array(N)
const CACHE_MAX = 512;

/** 刷新 LRU 顺序并把最旧的一条挤出去 */
function lruSet(cache, key, val) {
  cache.set(key, val);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * 一根小时的**细价格路径**：长度 `N + 1` 的价格点，`p[j]` = 第 j 个刻度上的价。
 * 第 j 个刻度（0-based）＝ `p[j] → p[j+1]` 这一段，即小时内的第 j 个 1/N 区间。
 *
 * @param {number} seed  全局种子（存档 `s.seed`）
 * @param {string} sym   币符号
 * @param {number} hour  绝对小时序号（＝ `s.i` 的语义）
 * @param {{o:number,h:number,l:number,c:number}} ohlc 该小时的**真实**锚点（来自数据包）
 * @returns {Float64Array} 长度 `N + 1`；`[0] === ohlc.o`、`[N] === ohlc.c`、`max === h`、`min === l`
 */
export function pathOf(seed, sym, hour, ohlc) {
  const { o, h, l, c } = ohlc;
  const key = `${sym}|${hour}|${seed}|${o},${h},${l},${c}`;
  const hit = pathCache.get(key);
  if (hit) { pathCache.delete(key); pathCache.set(key, hit); return hit; }

  const symH = hashStr(sym);
  const d = new Float64Array(N + 1);
  const p = new Float64Array(N + 1);

  /* ① 布朗桥：d[0] = d[N] = 0 是结构性的（u(1−u) 在两端为 0） */
  for (let i = 1; i < N; i++) {
    const u = i / N;
    d[i] = Math.sqrt(u * (1 - u)) * gauss(
      rand(seed, symH, hour, i * 2, CH_PATH),
      rand(seed, symH, hour, i * 2 + 1, CH_PATH),
    );
  }

  /* ② 两侧归一：sU / sD 分别是「恰好够到 H / L」的最小放大倍数 */
  let sU = Infinity, sD = Infinity, iU = 0, iD = 0;
  for (let i = 1; i < N; i++) {
    const a = o + (c - o) * (i / N);
    if (d[i] > 0) {
      const s = (h - a) / d[i];
      if (s < sU) { sU = s; iU = i; }
    } else if (d[i] < 0) {
      const s = (l - a) / d[i];
      if (s < sD) { sD = s; iD = i; }
    }
  }
  const up = Number.isFinite(sU), down = Number.isFinite(sD);
  const kU = up ? sU : 0, kD = down ? sD : 0;

  /* ③ 合成 + 夹进 [L, H]（数学上本就不越界，这一步只消 1 ulp 的浮点误差） */
  for (let i = 0; i <= N; i++) {
    let v = o + (c - o) * (i / N) + (d[i] >= 0 ? kU : kD) * d[i];
    if (v < l) v = l; else if (v > h) v = h;
    p[i] = v;
  }

  /* ④ 退化兜底：桥没产生上侧（下侧）偏离时，用 'extreme' 通道挑一根刻度直接钉一个针 */
  if (!up && h > (o > c ? o : c)) p[spikeAt(seed, symH, hour, 1)] = h;
  if (!down && l < (o < c ? o : c)) p[spikeAt(seed, symH, hour, 2)] = l;

  /* ⑤ 显式钉四个锚点 —— 保证断言可以要求逐位相等 */
  p[0] = o;
  p[N] = c;
  if (up) p[iU] = h;
  if (down) p[iD] = l;

  lruSet(pathCache, key, p);
  return p;
}

/** 退化兜底用的针位置：`slot` 1 = 上针、2 = 下针（同一小时两者不会落在一起） */
function spikeAt(seed, symH, hour, slot) {
  return 1 + Math.floor(rand(seed, symH, hour, slot, CH_EXTREME) * (N - 1));
}

/**
 * 一根小时的**细刻度成交量权重**：长度 N，`Σw = 1`（乘上该小时的真实成交额即为各刻度的量）。
 *
 * 口径（方案 §5.3）：**U 型日内曲线 × 种子噪声，再归一**——
 *   `w[i] ∝ U((i+0.5)/N) · (1 + η·z[i])`，`U(x) = 0.5 + 1.5·(2x−1)²`（两端 2、中间 0.5）。
 * U 型量曲线有理论与实证基础（Jain & Joh 1988 / Admati & Pfleiderer 1988）。
 *
 * @returns {Float64Array} 长度 N，全部 > 0、和 ≈ 1（误差 1e-12 量级）
 */
export function weightsOf(seed, sym, hour) {
  const key = `${sym}|${hour}|${seed}`;
  const hit = volCache.get(key);
  if (hit) { volCache.delete(key); volCache.set(key, hit); return hit; }

  const symH = hashStr(sym);
  const w = new Float64Array(N);
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const e = 2 * ((i + 0.5) / N) - 1;                       // −1 … 1
    const u = 0.5 + 1.5 * e * e;                             // U 型：两端 2、中间 0.5
    const z = rand(seed, symH, hour, i, CH_VOLUME) * 2 - 1;   // [−1, 1)
    const v = u * (1 + VOL_ETA * z);
    w[i] = v;
    sum += v;
  }
  for (let i = 0; i < N; i++) w[i] /= sum;

  lruSet(volCache, key, w);
  return w;
}

/** 细刻度数 N（＝ 每小时段数）—— 给渲染层用，避免各处重复读 config */
export const ticksPerHour = () => N;