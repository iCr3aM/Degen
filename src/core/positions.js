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
 */
export function openPosition(sym, side, price, margin, lev, feeRate) {
  const notional = margin * lev;
  return {
    sym,
    side,
    lev,
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
 * 现货判定：**1x 做多就是现货**（2026-09-28 拍板「由杠杆自动区分」）。
 *   - 现货：只有币价归零才归零本金，**不因 0.5% 维持保证金率被强平** —— 所以引擎要跳过它
 *   - 合约：做空、或任何 ≥2x 的仓位，走维持保证金率那一套
 * 这样不用多一行「模式」切换：Mt.Gox 全程只有 1x，玩家在门头沟做多天然就是现货。
 * 要注意方向与杠杆两个条件都得满足：1x 做空是合约（有强平），2x 做多也是合约。
 */
export const isSpot = pos => pos.side === 'long' && pos.lev === 1;

/* ───────────────────────── 资金费率（GDD §9.5） ───────────────────────── */

/**
 * 资金费率参数。
 *
 * ⚠️ **溢价指数是合成的**（2026-09-28 拍板）：数据包里每个币只有**一条真小时线**，
 *    拿不到「合约价 vs 现货价」两条线，所以真实溢价指数在数据上根本算不出来。
 *    本作的替代口径：把「近 `window` 根的真实涨跌幅」归一化后当作溢价指数 ——
 *    价格连续上涨 ⇒ 永续贵于现货 ⇒ 正溢价 ⇒ 多头付空头，方向与真实市场一致。
 *    它是**由真实成交价推出来的合成量**，不是编造的价格。
 */
export const FUNDING = {
  window: 8,          // 溢价指数取近 8 根（= 一个结算周期）的涨跌幅
  hours: 8,           // 每 8 游戏小时结算一次
  base: 0.0001,       // 基础利率 0.01%（史实 BitMEX 基准）
  cap: 0.0005,        // clamp 上下限 ±0.05%
  premiumCap: 0.001,  // 合成溢价指数的上限 ±0.1%
};

/** 溢价指数：近一个周期的涨跌幅，夹到 ±0.1% */
export function premiumOf(roc) {
  if (!Number.isFinite(roc)) return 0;
  return Math.max(-FUNDING.premiumCap, Math.min(FUNDING.premiumCap, roc));
}

/**
 * 资金费率 = 溢价指数 + clamp(基础利率 − 溢价指数, ±0.05%)（GDD §9.5 原式）。
 * 取值落在 **±0.05%** 之间：平盘时就是基础利率 0.01%（多头付空头），
 * 连续上涨顶到 +0.05%，连续下跌顶到 −0.05%（空头付多头）。
 */
export function fundingRateOf(roc) {
  const p = premiumOf(roc);
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

