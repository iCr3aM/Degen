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

/**
 * 记录键 = `命名空间|币种`。**两种页面各用一套视野**（2026-10-01 修）：
 *   交易页传 `''`（缺省）· 历史回顾页传 `'rv'`。
 *
 * ⚠️ 为什么要分家（这是「K 线柱体与现价签错开」的真凶）：原来只按 `sym` 索引 ⇒
 *    回顾页和交易页**共用同一格** —— 在回顾里拖了 BTC 的图，退回交易页时 BTC 的视野
 *    还停在 2018 年那一段；而 `mark`（标记价）永远是**当前**那一根，`chart.js` 把它
 *    `clamp` 到视窗上下沿 ⇒ 现价签写的价位和屏幕上的柱体根本不是一个时刻 ⇒ 看起来「完全错开」。
 *    回顾页的「当前」在 `rv.i` 里、交易页的在 `s.i` 里，两者本来就该各看各的。
 */
const keyOf = (sym, ns) => (ns ? `${ns}|${sym}` : sym);

export function viewOf(sym, ns = '') {
  const key = keyOf(sym, ns);
  let v = views.get(key);
  if (!v) {
    v = { mode: '1h', count: 0, right: 0, yPx: 0, locked: false };   // count 0 = 还没算过，用默认值
    views.set(key, v);
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
function norm(sym, i, cssW, ns = '') {
  const v = viewOf(sym, ns);
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
  const pv = own ? { margin: 0, fut: 0 } : null;
  for (let k = a; k <= z; k++) {
    const cc = candleAt(sym, k);
    if (!cc) continue;
    if (o == null) o = cc.o;
    if (cc.h > h) h = cc.h;
    if (cc.l < l) l = cc.l;
    c = cc.c;
    share += volumeAt(sym, k);
    /* 玩家自己那一份（v17）也按**同一批已过小时**聚合；v20 起两条产品线各聚各的，
       v24 起还要认币（`pvol` 按币分账 —— 别把别的币的成交并进这一根） */
    if (pv) {
      const p = playerVolOf(sym, k);
      if (p.margin) pv.margin += p.margin;
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
 * @returns {{candles:Array, vols:Array<number>, pvols:Array<{margin:number,fut:number}>,
 *            mode:string, count:number, slots:number, locked:boolean, yPx:number, right:number}}
 *   `right` 一并返回（P2-C）：锚点刻度要把「小时序号」换算成视野里的槽位，得知道最右那根是第几根。
 *   `slots` ＝ 本帧**要画的槽位数**（＝ `count`）。
 * @param {boolean} own 是否把**玩家自己的成交额**并进量柱（v20）。交易页传真；
 *   **历史回顾页必须传假** —— 那一屏讲的是市场史，玩家自己这一局的成交不该混进 2013 年的柱子。
 */
export function windowFor(sym, i, cssW, own = true, ns = '') {
  const { v } = norm(sym, i, cssW, ns);
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
      vols.push(bar.share * (liqOf(sym, d) || 0) + (bar.pv ? bar.pv.margin + bar.pv.fut : 0));
      pvols.push(bar.pv);
    }
  } else {
    for (let k = from; k <= right; k++) {
      const c = candleAt(sym, k);
      if (!c) continue;
      candles.push(c);
      /* 包里的份额是「占当日成交额的比例」，乘回当日总量才是可跨天比较的绝对美元量 */
      const share = volumeAt(sym, k);
      /* 市场那一份 ＋ **玩家自己那一份**（v17）—— 玩家砸出的天量从此在图上看得到。
         v24：这一份**只认本币**（`pvol[sym]`）—— 在 BTC 买的量不该出现在 ETH 的柱子上。 */
      const pv = own ? playerVolOf(sym, k) : null;
      vols.push((share > 0 ? share * (liqOf(sym, dayIndexOf(k)) || 0) : 0) + (pv ? pv.margin + pv.fut : 0));
      pvols.push(pv);
    }
  }
  return { candles, vols, pvols, mode: v.mode, count: v.count, slots: v.count, locked: v.locked, yPx: v.yPx, right };
}

/**
 * 单指拖动：水平改「看第几根」，垂直改价格轴。
 *
 * **只有动了时间轴才锁视野**（2026-10-01 修 · 12.4）：
 *   原来无条件 `v.locked = true` ⇒ 只想调一下价格轴（纯垂直拖动）也会把时间轴钉死 ——
 *   视野从此不再跟随当前根，而 `mark` 仍是当前那一根，`chart.js` 只把它 `clamp` 到视窗上下沿
 *   ⇒ 现价签与屏幕上的柱体**不再是同一时刻**，看起来就是「完全错开」。
 *   垂直拖动只改价格轴、一个字都没动时间 ⇒ 没有理由锁它。
 *
 * @param {number} dxPx 手指水平位移（右为正 ⇒ 看更早的行情）
 * @param {number} dyPx 手指垂直位移（下为正）
 * @returns {{ v: object, edge: ''|'new'|'old' }} `edge` ＝ 「这一下被边界夹住了」（2026-10-04）：
 *   `'new'` ＝ 已经顶到当前根（想再往新看没有了）、`'old'` ＝ 已经顶到数据首根。调用方拿它播
 *   触边反馈（`main.js` 的 `edgeFeedback`）；没撞边界就是 `''`。
 */
export function panBy(sym, dxPx, dyPx, i, cssW, ns = '') {
  const { v, start, maxRight } = norm(sym, i, cssW, ns);
  let edge = '';
  if (dxPx) {
    v.locked = true;                                   // 只有沿时间轴拖动才锁（否则拖到一半被时间拽回去）
    const bw = Math.max(1, cssW - PAD_R) / v.count;    // 一像素等于多少根
    const want = (v.right -= dxPx / bw);
    clampRight(v, start, maxRight);
    /* 被夹住 ⇒ 撞边界。`clamp` 只会把值往下压（`v.right` 变小 = 更靠「过去」）或往上顶到
       `maxRight`（＝当前根）⇒ 用夹取前后的差值判方向，不必再算第二遍。 */
    if (v.right !== want) edge = want > v.right ? 'new' : 'old';
  }
  if (dyPx) v.yPx += dyPx;
  return { v, edge };
}

/**
 * 双指捏合：**只缩放 x**（可见根数），`factor < 1` = 放大（根数变少）。
 * 以**右端为锚**（12.7 补充决定 3）：`right` 不动，只是左端跟着缩 —— 少一层状态，
 * 而且「看最新」这个最常用的姿态在缩放时天然稳定。
 *
 * ⚠️ 缩到最细就是 12 根（`MIN_BARS`），**不再换档** —— 细刻度档已于 2026-10-01 移除（ROADMAP §四十）。
 * @returns {{ v: object, edge: ''|'in'|'out' }} `edge` ＝ 这一下被缩放的边界夹住了（2026-10-04），
 *   `'in'` ＝ 已到最细、`'out'` ＝ 已到最宽（或该币数据不足）。
 */
export function zoomBy(sym, factor, i, cssW, ns = '') {
  const { v } = norm(sym, i, cssW, ns);
  /* ⚠️ **不再强制锁视野**（2026-10-01 修）：缩放只是「看近一点」，右端本来就锚在当前根上
     ⇒ 没理由让它冻结。留着 `locked` 原状 —— 玩家先拖到历史里再缩放，锁仍然在（`norm` 会保住位置）；
     玩家本来就是跟随姿态，缩放后继续跟随。原来无条件置真会把这两者都冻住，症状与垂直拖动那条一样。 */
  const want = Math.round(v.count * factor);
  v.count = clamp(want, MIN_BARS, MAX_BARS);
  norm(sym, i, cssW, ns);      // 缩放后按边界再夹一次
  /* 撞边界判据（2026-10-04）：`want` 与最终 `count` 不一致 ⇒ 被 `MIN_BARS` / `MAX_BARS` /
     该币数据长度中的某一条夹住。`'in'` ＝ 已放到最细（12 根）、`'out'` ＝ 已摊到最宽。 */
  let edge = '';
  if (v.count !== want) edge = want > v.count ? 'out' : 'in';
  return { v, edge };
}

/** 双击复位：回到最新根 ＋ 恢复默认根数 ＋ 价格轴归零（**只复位当前币**） */
export function resetView(sym, ns = '') {
  const v = viewOf(sym, ns);
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
export function setMode(sym, mode, i, cssW, ns = '') {
  const v = viewOf(sym, ns);
  if (v.mode === mode) return v;
  /* 右端先统一换算成**小时序号**（两档口径不同），再落到目标档 */
  const hour = v.mode === '1d' ? v.right * HOURS_PER_DAY + HOURS_PER_DAY - 1 : v.right;
  v.right = mode === '1d' ? Math.floor(hour / HOURS_PER_DAY) : Math.min(i, hour);
  v.mode = mode;
  v.count = 0;
  v.yPx = 0;
  norm(sym, i, cssW, ns);
  return v;
}

/**
 * 写回**实际生效的**价格轴平移。限位夹在 `chart.js` 里（换算的唯一真源在那边），
 * 所以这里只负责把结果存下来 —— 见 `drawChart` 的返回值说明。
 */
export function setYPx(sym, yPx, ns = '') {
  viewOf(sym, ns).yPx = yPx;
}