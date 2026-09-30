/**
 * K 线视野 —— 看哪一段 / 看多密 / 小时还是天 / 价格轴平移了多少
 * ===============================================================
 * **纯 UI 状态**：不进存档、不写 localStorage，刷新即回默认 —— GDD 只要求「这一局」能续，
 * 没要求「你翻到哪一根」也续上。**按币各存一份**（切币不串味）。
 *
 * 单独立一个文件，是因为有三个方向都要碰它：`chart.js` 拿它算单根宽度与量区、
 * `bind.js` 的手势改它、`main.js` 的复位清它。塞进 render.js 会绕成一团。
 *
 * 显示单位随模式走：`1h` 下一根 = 1 小时，`1d` 下一根 = 1 天（24 小时聚合）。
 * `count` / `right` **都按显示单位算**，两套模式的限位因此共用同一段代码。
 *
 * ⚠️ 细刻度档（`1t` ＝ 30 秒）已于 2026-10-01 **整体移除**（ROADMAP §四十）：1x 是「1 秒 1 小时」，
 *    一根 30 秒 K 只活 0.5 秒、一屏每秒整屏滑过一次，**没有任何速度下能看「活的」**；
 *    唯一用途「暂停后放大看针」又不值一个只在捏合里才存在的隐藏档。删档后 K 线只剩 `1h` / `1d`。
 *
 * ⚠️ **视野只改「看」，不改玩法**（12.3）：`s.i` 仍然是「第几根小时 K」，
 *    时钟、资金费率、强平、到账全部照旧按小时走。
 */

import { rangeOf, candleAt, volumeAt, playerVolOf, liqOf, dayIndexOf, HOURS_PER_DAY } from '../core/market.js';
import { PAD_R } from './chart.js';

/** 缩放的硬边界：可见 12 ~ 240 根（12.4） */
const MIN_BARS = 12;
const MAX_BARS = 240;
/** 每根占的宽度（px）—— 与 `chart.js` 算 `bw` 用的是同一个口径 */
const BAR_PX = 5;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 视野记录：`right` 是**浮点**（拖动按像素累积，只在出窗口时取整），其余都是整数 */
const views = new Map();

export function viewOf(sym) {
  let v = views.get(sym);
  if (!v) {
    v = { mode: '1h', count: 0, right: 0, yPx: 0, locked: false };   // count 0 = 还没算过，用默认值
    views.set(sym, v);
  }
  return v;
}

/** 默认可见根数：窄屏 50 根、宽屏 90 根（Batch 1 起的口径，未变） */
export const defaultCount = cssW => clamp(Math.round((cssW - PAD_R) / BAR_PX), 40, 96);

/** 该币数据在**显示单位**下的首末序号 */
function bounds(sym, mode) {
  const r = rangeOf(sym);
  if (!r) return null;
  if (mode === '1d') {
    return { start: Math.floor(r[0] / HOURS_PER_DAY), end: Math.floor((r[1] - 1) / HOURS_PER_DAY) };
  }
  return { start: r[0], end: r[1] - 1 };
}

/**
 * 把记录规整到合法范围，返回本次要用的边界。
 * 三条限制一起夹在这儿（12.4）：右端不许看未来、左端不许早于数据首根、根数在 12~240。
 * ⚠️ 右端的下界是「数据首根 ＋ 根数 − 1」而不是「数据首根」—— 12.4 的规则是
 *    **最左一根** ≥ 数据首根，否则窗口会滑到数据左边，屏幕右半边全是空白。
 */
function norm(sym, i, cssW) {
  const v = viewOf(sym);
  const b = bounds(sym, v.mode);
  const start = b ? b.start : 0;
  const total = b ? b.end - b.start + 1 : MAX_BARS;
  const maxCount = Math.max(MIN_BARS, Math.min(MAX_BARS, total));
  v.count = clamp(Math.round(v.count || defaultCount(cssW)), MIN_BARS, maxCount);

  const cur = v.mode === '1d' ? Math.floor(i / HOURS_PER_DAY) : i;
  const maxRight = b ? Math.min(cur, b.end) : cur;
  if (!v.locked) v.right = maxRight;          // 未锁视野 = 自动跟随当前根（原有行为）
  clampRight(v, start, maxRight);
  return { v, start, maxRight, maxCount };
}

/**
 * 右端夹取：**下界随根数变、上界恒为 `maxRight`**。
 *
 * ⚠️ 上界**不能**写 `Math.max(a, maxRight)`（B22 修的 bug，2026-09-29）：
 *    `a = start + count − 1` 的本意只是「窗口最左一根 ≥ 数据首根」这个**下界**。
 *    币种刚上线时 `start ≈ i` ⇒ `a > maxRight = i`，区间被翻成 `[maxRight, a]`，
 *    `right` 就能一路推到 `start + count − 1` —— 右端越过当前小时，**屏幕上出现未来行情**
 *    （开局 BTC 可右拖偷看 59 小时 ≈ 2.5 天，1d 模式最多 240 天）。
 *    上界钉死 `maxRight` 之后，`a > maxRight` 时区间自动退化成 `[maxRight, maxRight]`。
 */
function clampRight(v, start, maxRight) {
  const a = start + v.count - 1;
  v.right = clamp(v.right, Math.min(a, maxRight), maxRight);
}

/**
 * 第 d 天（自 2013-01-01 起的天序号）的日线；`upto` = 当前小时（进行中的那天只看已过的部分）
 *
 * ⚠️ **量也要一起聚合**（Batch 4 · B15）：份量份额之和只算**已过的小时**，
 *    与 OHLC 完全同一口径 —— 否则当天那根柱高会偷看未来（拿整天真实成交额配半天的价格），
 *    而且看不出「日内抬升」。
 */
function dayBar(sym, d, upto, own = true) {
  const r = rangeOf(sym);
  if (!r) return null;
  const a = Math.max(d * HOURS_PER_DAY, r[0]);
  const z = Math.min(d * HOURS_PER_DAY + HOURS_PER_DAY - 1, upto, r[1] - 1);
  if (a > z) return null;
  let o = null, h = -Infinity, l = Infinity, c = null, share = 0;
  const pv = own ? { spot: 0, fut: 0 } : null;
  for (let k = a; k <= z; k++) {
    const cc = candleAt(sym, k);
    if (!cc) continue;
    if (o == null) o = cc.o;
    if (cc.h > h) h = cc.h;
    if (cc.l < l) l = cc.l;
    c = cc.c;
    share += volumeAt(sym, k);
    /* 玩家自己那一份（v17）也按**同一批已过小时**聚合；v20 起两条产品线各聚各的 */
    if (pv) {
      const p = playerVolOf(k);
      if (p.spot) pv.spot += p.spot;
      if (p.fut) pv.fut += p.fut;
    }
  }
  if (o == null) return null;
  /* 上市首日 / 今天这类**不完整的桶照画**（12.3）：只有几个小时就按几个小时聚合，不补齐。 */
  return { o, h, l, c, share, pv };
}

/**
 * 出一帧要画的 K 线与量柱。这是渲染层唯一的入口，也是**唯一**会写回记录的地方
 * （夹取后的 `right` / `count` 必须落回记录，否则玩家一直往同一边拖时数字会越滚越大）。
 * @returns {{candles:Array, vols:Array<number>, pvols:Array<{spot:number,fut:number}>,
 *            mode:string, count:number, slots:number, locked:boolean, yPx:number, right:number}}
 *   `right` 一并返回（P2-C）：锚点刻度要把「小时序号」换算成视野里的槽位，得知道最右那根是第几根。
 *   `slots` ＝ 本帧**要画的槽位数**（＝ `count`）。
 * @param {boolean} own 是否把**玩家自己的成交额**并进量柱（v20）。交易页传真；
 *   **历史回顾页必须传假** —— 那一屏讲的是市场史，玩家自己这一局的成交不该混进 2013 年的柱子。
 */
export function windowFor(sym, i, cssW, own = true) {
  const { v } = norm(sym, i, cssW);
  const right = Math.round(v.right);
  const from = right - v.count + 1;
  const candles = [];
  const vols = [];
  /* 玩家自己那一份，**按产品线分开**（v20）—— 与 `vols` 一一对齐，`chart.js` 拿它叠一层分色。
     两份之和恒等于 `vols` 里的玩家部分 ⇒ **柱高逐位不变**，只是颜色分开了。 */
  const pvols = [];

  if (v.mode === '1d') {
    for (let d = from; d <= right; d++) {
      const bar = dayBar(sym, d, i, own);
      if (!bar) continue;
      candles.push(bar);
      /* 日线的量 = **已过小时的份额之和** × 当天真实总量（Batch 4 · B15）：
         整天 = 份额和约 1 ⇒ 拿回全量；今天 = 只算已过的那几个小时 ⇒ 柱子随小时推进逐格抬升。 */
      vols.push(bar.share * (liqOf(sym, d) || 0) + (bar.pv ? bar.pv.spot + bar.pv.fut : 0));
      pvols.push(bar.pv);
    }
  } else {
    for (let k = from; k <= right; k++) {
      const c = candleAt(sym, k);
      if (!c) continue;
      candles.push(c);
      /* 包里的份额是「占当日成交额的比例」，乘回当日总量才是可跨天比较的绝对美元量 */
      const share = volumeAt(sym, k);
      /* 市场那一份 ＋ **玩家自己那一份**（v17）—— 玩家砸出的天量从此在图上看得到 */
      const pv = own ? playerVolOf(k) : null;
      vols.push((share > 0 ? share * (liqOf(sym, dayIndexOf(k)) || 0) : 0) + (pv ? pv.spot + pv.fut : 0));
      pvols.push(pv);
    }
  }
  return { candles, vols, pvols, mode: v.mode, count: v.count, slots: v.count, locked: v.locked, yPx: v.yPx, right };
}

/**
 * 单指拖动：水平改「看第几根」，垂直改价格轴。
 * **一旦拖动就锁视野**（12.4）—— 否则拖到一半会被时间推进拽回去。
 * @param {number} dxPx 手指水平位移（右为正 ⇒ 看更早的行情）
 * @param {number} dyPx 手指垂直位移（下为正）
 */
export function panBy(sym, dxPx, dyPx, i, cssW) {
  const { v, start, maxRight } = norm(sym, i, cssW);
  v.locked = true;
  if (dxPx) {
    const bw = Math.max(1, cssW - PAD_R) / v.count;    // 一像素等于多少根
    v.right -= dxPx / bw;
    clampRight(v, start, maxRight);
  }
  if (dyPx) v.yPx += dyPx;
  return v;
}

/**
 * 双指捏合：**只缩放 x**（可见根数），`factor < 1` = 放大（根数变少）。
 * 以**右端为锚**（12.7 补充决定 3）：`right` 不动，只是左端跟着缩 —— 少一层状态，
 * 而且「看最新」这个最常用的姿态在缩放时天然稳定。
 *
 * ⚠️ 缩到最细就是 12 根（`MIN_BARS`），**不再换档** —— 细刻度档已于 2026-10-01 移除（ROADMAP §四十）。
 */
export function zoomBy(sym, factor, i, cssW) {
  const { v } = norm(sym, i, cssW);
  v.locked = true;
  v.count = clamp(Math.round(v.count * factor), MIN_BARS, MAX_BARS);
  norm(sym, i, cssW);      // 缩放后按边界再夹一次（`locked` 已置真 ⇒ 不会抢走玩家选的位置）
  return v;
}

/** 双击复位：回到最新根 ＋ 恢复默认根数 ＋ 价格轴归零（**只复位当前币**） */
export function resetView(sym) {
  const v = viewOf(sym);
  v.count = 0;
  v.yPx = 0;
  v.locked = false;
  return v;
}

/**
 * 切小时线 / 日线（12.3）。三件事一起做：
 *   ① 把 `right` 换算到新的显示单位（同一天里取最后一根所在的那天）
 *   ② 根数回默认 —— **密度不跨粒度沿用**（「60 根小时线」和「60 天」完全是两码事）
 *   ③ 价格轴归零 —— 两种粒度的价格幅度差几个数量级，不归零会整片空白
 */
export function setMode(sym, mode, i, cssW) {
  const v = viewOf(sym);
  if (v.mode === mode) return v;
  /* 右端先统一换算成**小时序号**（两档口径不同），再落到目标档 */
  const hour = v.mode === '1d' ? v.right * HOURS_PER_DAY + HOURS_PER_DAY - 1 : v.right;
  v.right = mode === '1d' ? Math.floor(hour / HOURS_PER_DAY) : Math.min(i, hour);
  v.mode = mode;
  v.count = 0;
  v.yPx = 0;
  norm(sym, i, cssW);
  return v;
}

/**
 * 写回**实际生效的**价格轴平移。限位夹在 `chart.js` 里（换算的唯一真源在那边），
 * 所以这里只负责把结果存下来 —— 见 `drawChart` 的返回值说明。
 */
export function setYPx(sym, yPx) {
  viewOf(sym).yPx = yPx;
}