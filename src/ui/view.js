/**
 * K 线视野 —— 看哪一段 / 看多密 / 小时还是天 / 价格轴平移了多少
 * ===============================================================
 * **纯 UI 状态**：不进存档、不写 localStorage，刷新即回默认 —— GDD 只要求「这一局」能续，
 * 没要求「你翻到哪一根」也续上。**按币各存一份**（切币不串味）。
 *
 * 单独立一个文件，是因为有三个方向都要碰它：`chart.js` 拿它算单根宽度与量区、
 * `bind.js` 的手势改它、`main.js` 的复位清它。塞进 render.js 会绕成一团。
 *
 * 显示单位随模式走：`1h` 下一根 = 1 小时，`1d` 下一根 = 1 天（24 小时聚合），
 * `1t` 下一根 = 1 tick（30 秒）—— 一根真实小时 K 摊成 `TICK.perHour` 根细刻度（S2 · ROADMAP §19.6）。
 * `count` / `right` **都按显示单位算**，三套模式的限位因此共用同一段代码。
 *
 * ⚠️ **视野只改「看」，不改玩法**（12.3）：`s.i` 仍然是「第几根小时 K」，
 *    时钟、资金费率、强平、到账全部照旧按小时走。
 */

import { TICK } from '../core/config.js';
import { rangeOf, candleAt, volumeAt, liqOf, dayIndexOf, HOURS_PER_DAY } from '../core/market.js';
import { pathOf, weightsOf } from '../core/simulate.js';
import { PAD_R } from './chart.js';

/** 缩放的硬边界：可见 12 ~ 240 根（12.4） */
const MIN_BARS = 12;
const MAX_BARS = 240;
/** 每根占的宽度（px）—— 与 `chart.js` 算 `bw` 用的是同一个口径 */
const BAR_PX = 5;
/** 一根真实小时 K 摊成多少根细刻度 —— 唯一真源在 `config.TICK`（S1） */
const N = TICK.perHour;
/** 细刻度档最多可见多少 tick ＝ **12 小时**（＝ `1h` 最细那 12 根的同一跨度 ⇒ 捏合换档无跳变） */
const FINE_MAX = 12 * N;
/** 细刻度档里一根至少占几像素 —— 桶聚合的槽位上限由它推出（ROADMAP §19.6.2） */
const TICK_SLOT_PX = 1.5;

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
  /* 细刻度档：一根小时 K 摊成 `N` 根 tick，序号 = `hour × N + j`（`j ∈ [0, N−1]`） */
  if (mode === '1t') return { start: r[0] * N, end: r[1] * N - 1 };
  return { start: r[0], end: r[1] - 1 };
}

/**
 * 把记录规整到合法范围，返回本次要用的边界。
 * 三条限制一起夹在这儿（12.4）：右端不许看未来、左端不许早于数据首根、根数在 12~240
 * （细刻度档上界放宽到 `FINE_MAX` ＝ 1440）。
 * ⚠️ 右端的下界是「数据首根 ＋ 根数 − 1」而不是「数据首根」—— 12.4 的规则是
 *    **最左一根** ≥ 数据首根，否则窗口会滑到数据左边，屏幕右半边全是空白。
 */
function norm(sym, i, cssW) {
  const v = viewOf(sym);
  const fine = v.mode === '1t';
  const b = bounds(sym, v.mode);
  const start = b ? b.start : 0;
  const total = b ? b.end - b.start + 1 : MAX_BARS;
  const maxCount = Math.max(MIN_BARS, Math.min(fine ? FINE_MAX : MAX_BARS, total));
  /* 默认根数：两个粗档一样（40~96 根），细刻度档取上界（1440 tick ＝ 12 小时）——
     双击复位因此天然「在 1t 下保留档位、退回最粗」，不需要在 `resetView` 里另写一支 */
  v.count = clamp(Math.round(v.count || (fine ? FINE_MAX : defaultCount(cssW))), MIN_BARS, maxCount);

  const cur = v.mode === '1d' ? Math.floor(i / HOURS_PER_DAY)
    : fine ? i * N + N - 1          // 细刻度档的「当前」＝ 当前小时的**最后一 tick**（与 1h 档同口径）
      : i;
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
function dayBar(sym, d, upto) {
  const r = rangeOf(sym);
  if (!r) return null;
  const a = Math.max(d * HOURS_PER_DAY, r[0]);
  const z = Math.min(d * HOURS_PER_DAY + HOURS_PER_DAY - 1, upto, r[1] - 1);
  if (a > z) return null;
  let o = null, h = -Infinity, l = Infinity, c = null, share = 0;
  for (let k = a; k <= z; k++) {
    const cc = candleAt(sym, k);
    if (!cc) continue;
    if (o == null) o = cc.o;
    if (cc.h > h) h = cc.h;
    if (cc.l < l) l = cc.l;
    c = cc.c;
    share += volumeAt(sym, k);
  }
  if (o == null) return null;
  /* 上市首日 / 今天这类**不完整的桶照画**（12.3）：只有几个小时就按几个小时聚合，不补齐。 */
  return { o, h, l, c, share };
}

/**
 * 出一帧要画的 K 线与量柱。这是渲染层唯一的入口，也是**唯一**会写回记录的地方
 * （夹取后的 `right` / `count` 必须落回记录，否则玩家一直往同一边拖时数字会越滚越大）。
 * @param {number} [seed] 全局种子（`s.seed`）—— 只有细刻度档要用它生成细路径
 * @param {number|null} [liqTick] 「致命那一针」的**全局 tick 序号**（S3-附）；不相关时传 null
 * @returns {{candles:Array, vols:Array<number>, mode:string, count:number, slots:number,
 *            locked:boolean, yPx:number, right:number, liqSlot:number|null}}
 *   `right` 一并返回（P2-C）：锚点刻度要把「小时序号」换算成视野里的槽位，得知道最右那根是第几根。
 *   `slots` ＝ 本帧**要画的槽位数**：粗档下就是 `count`，细刻度档下是**聚合后的桶数**（= `candles.length`）。
 */
export function windowFor(sym, i, cssW, seed, liqTick) {
  const { v } = norm(sym, i, cssW);
  const right = Math.round(v.right);
  const from = right - v.count + 1;
  const candles = [];
  const vols = [];

  if (v.mode === '1t') return fineWindow(sym, v, cssW, from, right, seed, liqTick);

  if (v.mode === '1d') {
    for (let d = from; d <= right; d++) {
      const bar = dayBar(sym, d, i);
      if (!bar) continue;
      candles.push(bar);
      /* 日线的量 = **已过小时的份额之和** × 当天真实总量（Batch 4 · B15）：
         整天 = 份额和约 1 ⇒ 拿回全量；今天 = 只算已过的那几个小时 ⇒ 柱子随小时推进逐格抬升。 */
      vols.push(bar.share * (liqOf(sym, d) || 0));
    }
  } else {
    for (let k = from; k <= right; k++) {
      const c = candleAt(sym, k);
      if (!c) continue;
      candles.push(c);
      /* 包里的份额是「占当日成交额的比例」，乘回当日总量才是可跨天比较的绝对美元量 */
      const share = volumeAt(sym, k);
      vols.push(share > 0 ? share * (liqOf(sym, dayIndexOf(k)) || 0) : 0);
    }
  }
  return { candles, vols, mode: v.mode, count: v.count, slots: v.count, locked: v.locked, yPx: v.yPx, right, liqSlot: null };
}

/**
 * 细刻度档（`1t`）的一屏：把 `[from, right]` 这段 tick 按「一根至少占 `TICK_SLOT_PX` 像素」**分桶聚合**。
 *
 * 为什么必须聚合：`1t` 最粗可见 `FINE_MAX` ＝ 1440 tick，而一屏只有 ≈320px —— 逐根画会糊成一片。
 * 桶 OHLC ＝ `{ o: 桶首 tick 的开, c: 桶末 tick 的收, h: 桶内 max, l: 桶内 min }`，
 * 量 ＝ 桶内 tick 权重之和 × 该小时绝对成交额（与 `1h` 档同源的口径，可跨天比较）。
 *
 * ⚠️ **桶不破锚点**：`simulate.pathOf` 保证 `max ≡ H`、`min ≡ L`（S1 红线 1），且桶**不跨小时**
 *    ⇒ 含针那一桶的 `h` / `l` 与真实小时**逐位相同**（验收 2）。
 * ⚠️ tick 蜡烛的定义：`pathOf` 给的是 `N + 1` 个**价格点**，第 j 根 tick ＝ 线段 `p[j] → p[j+1]`
 *    （30 秒内没有更细的真实结构，不编造）。
 */
function fineWindow(sym, v, cssW, from, right, seed, liqTick) {
  /* 槽位上限按像素算：375px 屏 ⇒ (375−52)/1.5 ≈ 215 槽；`bucket` = 每桶最多几根 tick */
  const slotMax = clamp(Math.floor((cssW - PAD_R) / TICK_SLOT_PX), MIN_BARS, MAX_BARS);
  const bucket = Math.max(1, Math.ceil(v.count / slotMax));

  const candles = [];
  const vols = [];
  let liqK = -1;               // 「致命那一针」所在的桶（= 它在 `candles` 里的下标）
  let t = from;
  /* 相邻 tick 绝大多数落在同一小时里 ⇒ 只在该小时变化时取一次路径与量权重（LRU 命中，几乎零成本） */
  let lastHour = -1, path = null, w = null, dayLiq = 0;

  while (t <= right) {
    const hh = Math.floor(t / N);
    const t0 = t;
    /* **桶不跨小时** —— 小时边界处强制切桶。缺了这一刀，「含针那一桶」可能同时盖住相邻小时的
       tick，它的 `h` 就成了两小时里的更高价 ⇒ 针被抹平。切在小时边界上还顺带保证：
       小时的首桶必从该小时第 0 根 tick 起（`o` ≡ 小时 `o`）、末桶必到第 `N−1` 根（`c` ≡ 小时 `c`）。 */
    const tEnd = Math.min(t0 + bucket - 1, hh * N + N - 1, right);

    if (hh !== lastHour) {
      lastHour = hh;
      const cc = candleAt(sym, hh);
      path = cc ? pathOf(seed, sym, hh, cc) : null;
      w = cc ? weightsOf(seed, sym, hh) : null;
      dayLiq = liqOf(sym, dayIndexOf(hh)) || 0;
    }

    let o = 0, h = -Infinity, l = Infinity, c = 0, vol = 0, any = false;
    for (; t <= tEnd; t++) {
      if (!path) continue;                     // 数据空档（未上线 / 缺根）—— 整桶跳过，与粗档同口径
      const j = t - hh * N;
      const a = path[j], z = path[j + 1];
      if (!any) { o = a; any = true; }
      if (a > h) h = a;
      if (a < l) l = a;
      if (z > h) h = z;
      if (z < l) l = z;
      c = z;
      vol += w[j] * dayLiq;
    }
    if (!any) continue;                        // `t` 已被内层循环推到 `tEnd + 1`，不会卡住
    if (liqTick != null && liqTick >= t0 && liqTick <= tEnd) liqK = candles.length;
    candles.push({ o, h, l, c });
    vols.push(vol);
  }

  /* 槽位数 = 桶数（`chart.js` 的右对齐因此恒为空操作）；「致命那一针」的槽位就是它所在桶的下标 */
  return { candles, vols, mode: v.mode, count: v.count, slots: candles.length, locked: v.locked, yPx: v.yPx, right, liqSlot: liqK >= 0 ? liqK : null };
}

/** 视野是否被玩家锁住（锁住 = 不再自动跟随当前根，双击才回最新） */
export const isLocked = sym => viewOf(sym).locked;

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
 * ⚠️ **两处换档**（S2）：`1h` 缩到最细（12 根）还要继续放大 ⇒ 展开细刻度档 `1t`；
 *    反向（`1t` 跨度 > 12 小时）⇒ 退回 `1h`。两档在边界**同跨度**（12 小时 ⇄ `FINE_MAX` tick）
 *    ⇒ 捏合过程无缝、不会「跳一下」。
 */
export function zoomBy(sym, factor, i, cssW) {
  const { v } = norm(sym, i, cssW);
  v.locked = true;
  const want = v.count * factor;

  if (v.mode === '1h' && want < MIN_BARS) {
    /* `right` 换算到「那一小时的**最后一 tick**」—— 与自动跟随的落点是同一个刻度 */
    v.mode = '1t';
    v.right = Math.round(v.right) * N + N - 1;
    v.count = clamp(Math.round(want * N), MIN_BARS, FINE_MAX);
  } else if (v.mode === '1t' && want > FINE_MAX) {
    v.mode = '1h';
    v.right = Math.floor(v.right / N);
    v.count = clamp(Math.round(want / N), MIN_BARS, MAX_BARS);
  } else {
    v.count = clamp(Math.round(want), MIN_BARS, v.mode === '1t' ? FINE_MAX : MAX_BARS);
  }
  norm(sym, i, cssW);      // 换档后按**新档**的边界再夹一次（`locked` 已置真 ⇒ 不会抢走玩家选的位置）
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
  /* 右端先统一换算成**小时序号**（三档口径各不同），再落到目标档。
     ⚠️ 落到 `1t` 时必须乘回 `N` 并取该小时**最后一 tick**（与 `zoomBy` 的换档落点是同一刻度）——
        少了这一步，`right` 会以「小时数」冒充「tick 序号」，被 `norm` 夹到数据最左端。 */
  const hour = v.mode === '1d' ? v.right * HOURS_PER_DAY + HOURS_PER_DAY - 1
    : v.mode === '1t' ? Math.floor(v.right / N)
      : v.right;
  v.right = mode === '1d' ? Math.floor(hour / HOURS_PER_DAY)
    : mode === '1t' ? Math.min(i, hour) * N + N - 1
      : Math.min(i, hour);
  v.mode = mode;
  v.count = 0;
  v.yPx = 0;
  norm(sym, i, cssW);
  return v;
}

/* ═════════════════ 速度 → 粒度（v11 · ④ 第一步） ═════════════════
 * 口径（2026-09-29 拍板）：**速度定粒度，时间推进口径完全不动** ——
 *   1x → 细刻度 `1t` / 5x·10x → 小时 `1h` / 50x → 日线 `1d`
 * 390px 视口实测「一屏真实秒数」：12 / 13.6 / 6.8 / 32.6 s，四档滚动速度平滑
 * （细刻度 1440 tick ＝ 12 小时，与 1h 最细那 12 根同跨度 ⇒ 换档无跳变）。
 *
 * ⚠️ **时间仍是 1 游戏小时/真实秒 × 速度**（`s.i` 语义一行没改）：粒度只是「看」的窗口。
 *    ⇒ 1x 的细刻度档是「看针」用的（一屏 12 秒滚完），不是常态；要看大势就按 5x/10x。
 * ⚠️ 手动捏合 / 粒度小字仍可在**本档内**临时改档（`zoomBy`），**下次点速度再被拉回来** ——
 *    这就是「手动捏合在该档内临时生效」这条拍板语义。
 */
const SPEED_MODE = new Map([[1, '1t'], [5, '1h'], [10, '1h'], [50, '1d']]);

/** 该速度档的**规范粒度**（表里没有的速度退回 `1h`，理论上不会发生） */
export const modeForSpeed = speed => SPEED_MODE.get(speed) || '1h';

/** 按速度把某币的粒度**强制**同步过去（切速 / 切币 / 开局 / 读档 / 回到 1x 时调用） */
export function syncModeToSpeed(sym, speed, i, cssW) {
  return setMode(sym, modeForSpeed(speed), i, cssW);
}

/**
 * 写回**实际生效的**价格轴平移。限位夹在 `chart.js` 里（换算的唯一真源在那边），
 * 所以这里只负责把结果存下来 —— 见 `drawChart` 的返回值说明。
 */
export function setYPx(sym, yPx) {
  viewOf(sym).yPx = yPx;
}