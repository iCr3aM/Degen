/**
 * 持仓数学 —— 线性 USDT 本位永续（GDD §9.2 / §10）
 * ===============================================================
 * 本文件是纯函数集合：**不碰状态、不碰 DOM、不读时钟**。
 * 「开仓 / 平仓 / 爆仓」这三个动作对状态的影响写在 `engine.js` 里，
 * 这里只回答「给了这些数，盈亏是多少、保证金率是多少、强平价在哪」。
 *
 * 口径（逐仓）：
 *   保证金 margin（USDT，玩家投入的自有资金）
 *   名义价值 notional = margin × 杠杆
 *   仓位数量 size     = notional / 开仓价
 *   未实现盈亏 uPnL   = (现价 − 开仓价) × size        （做空取反）
 *   仓位权益 equity   = margin + uPnL               （归零即损失全部保证金）
 *   保证金率 = equity / notional                     （≤ 维持保证金率 0.5% 时强平）
 *
 * ⇒ 爆仓所需逆向波动 = 1/杠杆 − 0.5%，与 GDD §10 的表逐行一致（5x→19.5%、100x→0.5%）。
 */

import { GAME } from './config.js';

/**
 * 开仓。
 * @param {'long'|'short'} side
 * @param {number} price  开仓价
 * @param {number} margin 保证金
 * @param {number} lev    杠杆
 * @param {number} feeRate 费率（开仓按名义价值收一次）
 * @param {boolean} spot 是否现货（U1 · ROADMAP §21.4）—— 由调用方按 `s.mode` / 通道算好传进来，
 *   开仓那一刻**定死**在仓位上（`isSpot` 读的就是它）。见 `engine.openTrade()` 里的表达式。
 */
export function openPosition(sym, side, price, margin, lev, feeRate, spot = false) {
  const notional = margin * lev;
  return {
    sym,
    side,
    lev,
    spot,                 // 现货标记（U1）：一旦开仓就固定，不再随 `s.mode` 变
    margin,
    entry: price,
    size: notional / price,
    notional,
    openFee: notional * feeRate,
    i: 0,                 // 开仓时的 K 线序号，由调用方填（仅用于展示「持仓 N 小时」）
  };
}

/** 未实现盈亏 */
export function pnlOf(pos, price) {
  if (!pos) return 0;
  const dir = pos.side === 'long' ? 1 : -1;
  return (price - pos.entry) * pos.size * dir;
}

/** 仓位权益 = 保证金 + 未实现盈亏 */
export function equityOf(pos, price) {
  return pos.margin + pnlOf(pos, price);
}

/** 保证金率 = 仓位权益 / 名义价值 */
export function marginRateOf(pos, price) {
  return equityOf(pos, price) / pos.notional;
}

/** 该仓位当前是否已触发强平 */
export function isLiquidatable(pos, price) {
  return marginRateOf(pos, price) <= GAME.maintRate;
}

/**
 * 强平价 —— 让「保证金率 = 维持保证金率」成立的那个价格。
 * 由 margin + dir×(P − entry)×size = maintRate × notional 解出：
 *   P = entry + dir × (maintRate × notional − margin) / size
 * 数值上等于「逆向波动 1/杠杆 − 0.5%」后的价格，与 GDD §10 一致。
 */
export function liquidationPrice(pos) {
  const dir = pos.side === 'long' ? 1 : -1;
  return pos.entry + dir * (GAME.maintRate * pos.notional - pos.margin) / pos.size;
}

/**
 * 平仓结算。
 * @returns {{ proceeds: number, fee: number, pnl: number, net: number }}
 *   `net` = 返还给现金的净额 = 保证金 + 未实现盈亏 − 平仓手续费
 */
export function closePosition(pos, price, feeRate) {
  const pnl = pnlOf(pos, price);
  const notionalNow = pos.size * price;
  const fee = notionalNow * feeRate;
  const net = pos.margin + pnl - fee;
  return { proceeds: pos.margin + pnl, fee, pnl, net };
}

/* ───────────────────────── 现货 / 合约（GDD §9.1） ───────────────────────── */

/**
 * 现货判定（U1 · 2026-09-29 改判，ROADMAP §21.4）—— **读仓位自己的 `spot` 标记**。
 *
 * ⚠️ 它不再由 `side / lev` 推出来。开仓那一刻由 `engine.openTrade()` 按 `s.mode` 算好写进仓位，
 *    之后**固定不变** —— 玩家中途切换模式不会改变已有仓位的性质（那才符合直觉）。
 *    `'spot'` 模式下的 1x 做多 ⇒ 现货；`'fut'` 模式下的 1x 做多 ⇒ 合约（也付资金费）；
 *    做空与任何 ≥2x **恒为合约**；OTC 通道**恒为现货**。
 *   - 现货：只有币价归零才归零本金，**不因 0.5% 维持保证金率被强平** —— 所以引擎要跳过它
 *   - 合约：走维持保证金率那一套
 */
export const isSpot = pos => !!(pos && pos.spot);

/* ───────────────────────── 资金费率（GDD §9.5） ───────────────────────── */

/**
 * 资金费率参数。
 *
 * ⚠️ **溢价指数是合成的**（2026-09-28 拍板，2026-09-29 Batch 4 · B18 改口径）：
 *    数据包里每个币只有**一条真小时线**，拿不到「合约价 vs 现货价」两条线，
 *    所以真实溢价指数在数据上根本算不出来。本作的替代口径是
 *    **波动率归一化动量**：把近 `window` 根的涨跌幅除以「同期典型波动」，再乘年代化上限 ——
 *    价格连续上涨 ⇒ 永续贵于现货 ⇒ 正溢价 ⇒ 多头付空头，方向与真实市场一致。
 *    它是由真实成交价推出来的合成量，不是编造的价格。
 */
export const FUNDING = {
  window: 8,            // 溢价指数取近 8 根（= 一个结算周期）的涨跌幅
  hours: 8,             // 每 8 游戏小时结算一次
  base: 0.0001,         // 基础利率 0.01%（史实 BitMEX 基准，也是 92% 时间的常态值）
  cap: 0.0005,          // 官方公式里那个 clamp 的上下限 ±0.05%
  sigmaWindow: 720,     // σ 的窗口：720 根 = 30 天
  sigmaK: 3,            // 几个「8 小时标准差」算顶格（≈ 3σ 事件，常态下几乎碰不到）
  sigmaDefault: 0.006,  // 样本不足（新币头几天）时的兜底 σ：0.6% / 小时
  premiumCap: 0.001,    // 溢价上限的**兜底值**；真实取值按年代走 `config.fundingPremiumCapAt`
};

/**
 * 溢价指数 = 年代上限 × clamp(动量 / (k · σ√8), −1, +1)（Batch 4 · B18）。
 *
 * 为什么必须归一化：旧口径直接把 **8 小时涨跌幅**夹到 ±0.1%，而真实 8h 涨跌幅常远超 0.1%
 * ⇒ 溢价几乎永远顶格 ⇒ 费率被钉死在 ±0.05%/8h（年化 54.75%，恒定不变）。
 * 现实是 **92–93% 的时间贴在 0.01%/8h（年化 10.95%）**，只有极端行情才偏离。
 * 除以「同期典型波动」之后，常态下 |z| ≪ 1 ⇒ 溢价趋近 0 ⇒ 官方公式自动退化成 0.01%；
 * 只有 |z| > 3 的行情才把费率推向年代上限。
 *
 * @param {number} roc   近一个结算周期的涨跌幅
 * @param {number} sigma 近 30 天的**小时**收益标准差（`engine.hourlySigma` 提供）
 * @param {number} cap   该年代的溢价上限（`config.fundingPremiumCapAt` 提供）
 */
export function premiumOf(roc, sigma, cap = FUNDING.premiumCap) {
  if (!Number.isFinite(roc)) return 0;
  const s = Number.isFinite(sigma) && sigma > 0 ? sigma : FUNDING.sigmaDefault;
  const scale = FUNDING.sigmaK * s * Math.sqrt(FUNDING.window);   // √8 = 一个结算周期的典型波动
  if (!(scale > 0)) return 0;
  const z = Math.max(-1, Math.min(1, roc / scale));
  return cap * z;
}

/**
 * 资金费率 = 溢价指数 + clamp(基础利率 − 溢价指数, ±0.05%)（GDD §9.5 原式，与 BitMEX / Binance /
 * Hyperliquid 官方式同形）。
 *
 * 平盘时就是基础利率 0.01%（多头付空头）；只有极端行情把溢价推上去，费率才离开那一点。
 * 取值上界由 `cap` 决定：溢价顶格 +0.5%（2016–2018 年代）时，clamp 项取到 −0.05%，费率 ≈ +0.45%。
 */
export function fundingRateOf(roc, sigma, cap = FUNDING.premiumCap) {
  const p = premiumOf(roc, sigma, cap);
  const adj = Math.max(-FUNDING.cap, Math.min(FUNDING.cap, FUNDING.base - p));
  return p + adj;
}

/**
 * 该仓位这一次应付的资金费。
 * @returns {number} **正数 = 应付出**（从保证金里扣），负数 = 应收（加进保证金）
 *   多头 × 正费率 ⇒ 应付；空头 × 正费率 ⇒ 应收。
 */
export function fundingOf(pos, mark, rate) {
  const dir = pos.side === 'long' ? 1 : -1;
  return pos.size * mark * rate * dir;
}

