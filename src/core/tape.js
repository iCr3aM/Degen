/**
 * ═══════════════════ 逐笔成交采样（tape · 2026-10-07 用户拍板） ═══════════════════
 *
 * 浮窗「成交」页的数据源：把**当前小时**的真实成交量拆成一笔笔打印（价格 / 数量 / 金额 / 方向）。
 *
 * ⚠️ **红线：零状态**。本模块是纯函数，不写 `s` 的任何字段（不进存档、内存现算）——
 *    同一个 `(sym, 小时, progress)` 每帧重算都是**逐位同一条**，切页回来不闪变。
 *
 * 建模（三个文献/实测锚，2026-10-07 联网审计）：
 *  ① **单笔名义幂律 α ≈ 1.5**（「half-cubic law」：Gabaix, Gopikrishnan, Plerou & Stanley,
 *     2003, *Nature* 423 及其 NBER 版——个股单笔成交量 P(q>x) ∝ x^−1.5；加密市场同构：
 *     Cong et al.《Crypto Wash Trading》引用同一指数）。Pareto 逆变换采样 `x = u^(−1/1.5)`。
 *     量级锚：Binance BTCUSDT 永续 2021-01–2024-10 单笔**均值 $9,441**、日均 154 万笔
 *     （≈1,070 笔/分钟，Kim & Hansen 2026, arXiv:2607.09426）。
 *  ② **方向偏斜锚定 taker 买卖比**：中性买方份额 ≈ **0.499**（同一 Binance 实测）；
 *     收益每 +1% 买方份额 ≈ +0.007（Coinglass 实测：+1.06% 日 taker 比 1.0313 ⇔ 买方份额
 *     0.5077；−2.4% 日 0.9399 ⇔ 0.4843 —— 两点连线斜率 ≈ 0.007/1%）。夹到 [0.35, 0.65]。
 *  ③ **总量守恒**：小时成交额 = `engine.hourLiqRaw`（与滑点 / 深度 / 级联阈值**同一把尺子**，
 *     不新开第二个成交量口径）；逐笔份额归一 ⇒ 窗口内名义之和 ≈ 小时量 × 窗宽。
 *
 * ⚠️ **采样声明**：真实 BTC 永续每小时 ≈ 6.4 万笔；本作每小时采样 **96 笔**（K）——
 *    展示的是小时流的**代表性采样**（幂律重尾使「大单」自然出现在样本里），页头已注明。
 * ⚠️ **时间轴**：引擎只有小时粒度，没有亚小时时钟 ⇒ 用「累计成交量占比 ≈ 时间占比」
 *    （泊松到达下无偏）构造 `t = c_j × 3600s`。展示窗 = 最近 `WIN = 15%` 的量
 *    （真实 tape 同为滚动窗）；`progress` 是本小时已走的量占比（main.js 时钟给）。
 * ⚠️ **价格**：以当前标记价（`lastPrice`，含位移层）为锚 ＋ ±2bp 抖动 —— 亚小时的真实价格
 *    路径不可重构，抖动只作视觉分离，量级远小于小时 σ（不与任何机制耦合）。
 */
import { hourLiqRaw, lastPrice } from './engine.js';
import { rawCloseAt } from './market.js';

/** 每小时采样笔数（代表性采样，见模块头注） */
const K = 96;
/** 展示窗宽（占小时量的比例）——真实 tape 也是滚动窗 */
const WIN = 0.15;
/** 单笔价格抖动半宽（±2bp）—— 只作视觉分离，不与机制耦合 */
const JITTER = 0.0002;

/** mulberry32（32 位 PRNG，纯函数——足够 tape 采样，不碰加密需求） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 币种符号的稳定散列（只作 PRNG 种子分离用，不是度量） */
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * 当前小时的逐笔采样。
 * @param {object} s 游戏状态（只读）
 * @param {string} sym 币种
 * @param {number} progress 本小时已走的量占比 ∈ [0,1)（main.js 时钟 `progress()`；未知传 0）
 * @param {number} [n=24] 最多返回的笔数（最新在前）
 * @returns {object|null} `{ vol, pBuy, prints:[{t,price,qty,usd,side}] }`；行情不可用 ⇒ null
 *   `t` = 小时内时刻「分:秒」字符串；`side` > 0 买（taker 吃卖盘 ⇒ 主动买）。
 */
export function tapeOf(s, sym, progress, n = 24) {
  const vol = hourLiqRaw(s, sym, s.i);
  if (!(vol > 0)) return null;
  const mark = lastPrice(s, sym);
  if (!(mark > 0)) return null;
  /* ② 方向偏斜：读**已收盘** K 线（s.i − 1 对 s.i − 2）的收益 —— 不前视本根 */
  const c1 = rawCloseAt(sym, s.i - 1), c0 = rawCloseAt(sym, s.i - 2);
  const pBuy = (c0 > 0 && c1 > 0)
    ? Math.min(0.65, Math.max(0.35, 0.5 + 0.7 * (c1 / c0 - 1)))
    : 0.5;
  /* ① 每小时一条确定的采样流：seed = 币散列 ⊕ 小时索引 */
  const rnd = mulberry32((hashStr(sym) ^ Math.imul(s.i + 1, 2654435761)) >>> 0);
  const prints = [];
  let cum = 0, wsum = 0;
  const w = [];
  for (let j = 0; j < K; j++) { const x = Math.pow(Math.max(rnd(), 1e-9), -1 / 1.5); w.push(x); wsum += x; }
  for (let j = 0; j < K; j++) {
    cum += w[j] / wsum;                                   // 累计量占比（≈ 时间占比）
    const side = rnd() < pBuy ? 1 : -1;
    const price = mark * (1 + (rnd() - 0.5) * JITTER * 2);
    const usd = (w[j] / wsum) * vol;
    /* 展示窗：(max(0, u−WIN), u] —— u = progress。小时刚开始时窗内本来就只有头几笔 */
    if (cum <= Math.max(0, progress - WIN) || cum > progress) continue;
    const sec = Math.min(3599, Math.round(cum * 3600));
    prints.push({
      t: `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`,
      price, qty: usd / price, usd, side,
    });
  }
  prints.reverse();                                        // 最新在前（真实 tape 的读法）
  return { vol, pBuy, prints: prints.slice(0, n) };
}

/**
 * 近 **24 小时**的成交记录（2026-10-07 用户拍板「成交保留 24 小时的记录」）。
 *
 * 当前小时照旧走 `tapeOf`（滚动窗明细）；**已收盘**的前 23 小时各压成一行「逐时汇总」——
 * 收价 = `rawCloseAt`（原始行情，不含位移，与 K 线同一读数）、量额 = `hourLiqRaw`
 * （与滑点 / 深度**同一把尺子**）、方向 = 该根 K 线自身的涨跌（taker 偏斜式子的读数：
 * 涨 ⇒ 买占过半 ⇒ 走买色）。`qty = vol ÷ close`（币数量），与明细行同列。
 *
 * 为什么不逐笔保留 24h：96 笔 × 24 = 2304 行会把 `floatBody` 每帧重建（80ms 节流）的
 * DOM 预算打死；逐时 23 行 ＋ 明细 ≤24 行 ≈ 40 行，与订单簿页同量级。明细行本来就是
 * **代表性采样**（K=96），「逐时汇总 ＋ 本小时明细」是同一口径下信息密度最高的切法。
 *
 * ⚠️ **仍是零状态纯函数**：历史小时从数据包现算（`rawCloseAt` / `volumeAt`），不写 `s`、
 * 不进存档 —— 切币 / 切页回来逐位一致，24 小时之前的「记录」天然不占内存。
 * @param {object} s 游戏状态（只读）
 * @param {string} sym 币种
 * @param {number} progress 本小时已走的量占比 ∈ [0,1)
 * @param {number} [n=24] 明细最多返回的笔数
 * @returns {object|null} `tapeOf` 的结果 ＋ `hours:[{h, close, qty, usd, side}]`（h **升序**，
 *   未上线 / 无量的历史小时跳过）；行情不可用 ⇒ null
 */
export function tape24h(s, sym, progress, n = 24) {
  const cur = tapeOf(s, sym, progress, n);
  if (!cur) return null;
  const hours = [];
  for (let back = 23; back >= 1; back--) {
    const h = s.i - back;
    const close = rawCloseAt(sym, h), prev = rawCloseAt(sym, h - 1);
    if (!(close > 0)) continue;                            // 未上线 / 数据洞
    const vol = hourLiqRaw(s, sym, h);
    if (!(vol > 0)) continue;                              // 无量的小时（上线当天等）
    hours.push({ h, close, qty: vol / close, usd: vol, side: prev > 0 && close < prev ? -1 : 1 });
  }
  return { ...cur, hours };
}
