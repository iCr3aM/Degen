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
 *   保证金率 = equity / notional                     （≤ 维持保证金率时强平）
 *
 * ⇒ 爆仓所需逆向波动 = 1/杠杆 − 维持保证金率，与 GDD §10 的表逐行一致（5x→19.5%、100x→0.5%）。
 * ⚠️ **维持保证金率不再是全局常数**（B18 · 2026-09-30）：按「所 × 工具 × 名义档」取，
 *    见 `maintRateOf()`；GDD §10 那张表描述的是 BitMEX / Bitfinex 永续那一档（0.5%）。
 */

import { maintRateAt } from './config.js';

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
  return marginRateOf(pos, price) <= maintRateOf(pos);
}

/**
 * **归一化的安全垫**（本轮 ⑥ · 用户 2026-09-29 拍板）—— 开仓那一刻 = `1`、触及维持保证金率 = `0`。
 *
 *   `safetyOf = (保证金率 − 维持保证金率) ÷ (1/杠杆 − 维持保证金率)`
 *
 * 为什么不用 `marginRateOf` 的绝对值做 UI 判据：**分子分母都随杠杆缩放**，
 * 100x 刚开出来时保证金率就是 1%（离强平只剩一半垫子），而 3x 刚开出来是 33%。
 * 拿一个固定阈值（如 5%）去卡，高杠杆仓位会**常年贴在红区**，颜色就不带信息了。
 * 归一化之后「同一个 `safetyOf` 在任何杠杆下含义相同」：0.5 = 垫子用掉一半。
 *
 * ⚠️ 不可强平的仓位（现货 1x）恒返回 `1`：它没有维持线这一说，也就永远不进入注意 / 危险区。
 */
export function safetyOf(pos, price) {
  if (!canLiquidate(pos)) return 1;
  const open = 1 / pos.lev;
  const limit = maintRateOf(pos);
  const span = open - limit;
  if (!(span > 0)) return 0;
  return (marginRateOf(pos, price) - limit) / span;
}

/**
 * 强平价 —— 让「保证金率 = 维持保证金率」成立的那个价格。
 * 由 margin + dir×(P − entry)×size = maintRate × notional 解出：
 *   P = entry + dir × (maintRate × notional − margin) / size
 * 数值上等于「逆向波动 1/杠杆 − 维持保证金率」后的价格，与 GDD §10 一致。
 * ⚠️ B18 起 `maintRate` 由 `maintRateOf(pos)` 给（Binance 按名义分档、margin 恒 15%）。
 */
export function liquidationPrice(pos) {
  const dir = pos.side === 'long' ? 1 : -1;
  return pos.entry + dir * (maintRateOf(pos) * pos.notional - pos.margin) / pos.size;
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

/* ───────────────────────── 逐步强平（Binance 口径 · 2026-10-01 拍板） ───────────────────────── */

/**
 * 把仓位**缩掉一块**（部分强平）—— 返回新仓位 ＋ 这一块的已实现盈亏。
 *
 * ⚠️ **关键在「保证金不按比例缩」**：
 *   强平掉 `frac` 之后，那一块的**保证金没有被退回现金**，而是**留在仓位里**给剩下的小仓位
 *   当垫子（真实交易所的部分强平就是这个效果 —— 它要的是「降杠杆」，不是「结算离场」）。
 *   于是：
 *     剩余保证金 = 原保证金 ＋ 已平部分的实际盈亏（强平时必为负）
 *     剩余数量   = 原数量 × (1 − frac)
 *     剩余名义   = 原名义 × (1 − frac)
 *   ⇒ 剩余仓位的**保证金率 = 原保证金率 ÷ (1 − frac)**，按 `frac` 的比例被抬回去，
 *     强平价随之被**推远**。这正是「逐步强平」能救人的原因。
 *   （若保证金也按比例缩，由 `liquidationPrice` 的公式可证强平价**原地不动** —— 白平。）
 *
 * ⚠️ 这一步**不动现金**：总权益 `margin + uPnL` 前后逐位相等，变的是「这笔权益有多少记在
 *    仓位保证金里」。已平部分那笔亏损由调用方记进 `s.realized`（它已经「实现」了，
 *    只是钱还押在仓位里）—— 这样「已实现盈亏」的累计值才始终等于这笔仓位的真实现金变动。
 *
 * @param {number} frac 平掉的比例（0–1）
 * @returns {{ pos: object, pnl: number, closedNotional: number }}
 *   `pnl` = 已平部分的已实现盈亏（强平时为负）；`closedNotional` = 已平部分按现价的名义额
 */
export function reducePosition(pos, frac, price) {
  const f = Math.max(0, Math.min(1, frac));
  const dir = pos.side === 'long' ? 1 : -1;
  const closedSize = pos.size * f;
  const pnl = (price - pos.entry) * closedSize * dir;
  return {
    pos: { ...pos, margin: pos.margin + pnl, size: pos.size - closedSize, notional: pos.notional * (1 - f) },
    pnl,
    closedNotional: closedSize * price,
  };
}

/**
 * 要让**保证金率回到 `target` 倍维持线**，这一笔该平掉多大比例（1 ＝ 全平）。
 *
 * 由 `保证金率' = 保证金率 ÷ (1 − frac)`（见 `reducePosition`）反解：
 *   `frac = 1 − 保证金率 ÷ (target × 维持保证金率)`
 *
 * 触发强平时 `保证金率 ≤ 维持保证金率` ⇒ `frac ≥ 1 − 1/target`（默认 1.5 倍 ⇒ **至少平 1/3**）；
 * 只有在权益已经跌到 ≤ 0 时才取到 1（那时必须全平，不能留一个负保证金率的口子）。
 *
 * @param {number} target 目标倍数（binance 官方式：拉到维持线的若干倍即止）
 */
export function reduceFraction(pos, price, target = 1.5) {
  const goal = target * maintRateOf(pos);
  if (!(goal > 0)) return 1;
  const f = 1 - marginRateOf(pos, price) / goal;
  return Math.max(0, Math.min(1, f));
}

/* ───────────────────────── 现货 / 合约（GDD §9.1） ───────────────────────── */

/**
 * 现货判定（U1 · 2026-09-29 改判，ROADMAP §21.4；v9 · §15.6 再改）—— **读仓位自己的 `spot` 标记**。
 *
 * ⚠️ 它不再由 `side / lev` 推出来。开仓那一刻由 `engine.openTrade()` 按 `s.mode` 算好写进仓位，
 *    之后**固定不变** —— 玩家中途切换模式不会改变已有仓位的性质（那才符合直觉）。
 *    `'spot'` 模式下的任何单 ⇒ 现货；`'fut'` 模式下的任何单 ⇒ 合约；OTC 通道**恒为现货**。
 *
 * ⚠️ **v9 起它只回答一个问题：「这笔单是怎么开的」**。改动前它同时承担着两件事
 *    （不付资金费 ＋ 不被强平），而现货从 §15.6 起**也带杠杆**了 ——
 *    于是「是现货」不再等价于「不会被强平」，那两件事各自拆成了下面两个更窄的判据。
 */
export const isSpot = pos => !!(pos && pos.spot);

/**
 * 这个仓位要不要参与**资金费率**结算（v9 · §15.3 N5）—— **只有永续要**。
 * 现货融资（margin）不吃资金费，改为**借贷利息**（B26 · 见 `paysInterest`），
 * 两者在引擎里是同一次结算的两个分支，不是同一笔钱。
 */
export const paysFunding = pos => !isSpot(pos);

/**
 * 这个仓位会不会被**强平**（v9 · §15.3 N5）—— 引擎的强平循环拿它当判据。
 *   - 合约：恒可（走维持保证金率那一套）
 *   - 现货：**只有带杠杆（`lev > 1`）才可** —— 借来的钱要还，所以要维持保证金
 *   - 现货 1x：只有币价归零才归零本金，不因维持线被强平（GDD §9.1）
 */
export const canLiquidate = pos => !isSpot(pos) || pos.lev > 1;

/* ───────────── 工具性质与维持保证金率（B18 / B26 · 2026-09-30） ───────────── */

/**
 * 这条仓位**是什么工具**（B26）—— 史实上「借钱买币」与「永续合约」是两种东西：
 *
 *   - `'margin'`：**现货保证金借贷** —— `spot` 表 + `lev > 1`（Bitfinex 2013-04 起 3.3x、
 *     Binance 2019-07-11 起 3x）。借来的钱 / 币要还，按**借贷日息**计息，
 *     维持线走 Bitfinex 史实的 **15%（权益口径）**。
 *   - `'perp'`：**线性 USDT 本位永续** —— `fut` 表的任何仓位。吃 8 小时资金费、维持线 0.5% 起。
 *
 * ⚠️ 2016-05-13 之前世界上**没有永续**（BitMEX 的 XBTUSD 是人类第一个）——
 *    那年头的「杠杆」全是借钱买币，所以早期仓位一律落进 `'margin'` 这一支。
 * ⚠️ 与 `engine.levKind(s)`（`'spot'` / `'fut'`，回答「走哪张杠杆表」）是**同一条分界**，
 *    这里回答的是「它是什么工具」—— 两个问题答案一一对应，所以不需要另立一张年代表。
 */
export const instrumentOf = pos => (isSpot(pos) && pos.lev > 1 ? 'margin' : 'perp');

/**
 * 该仓位此刻的**维持保证金率**（B18）—— 按「所 × 工具 × 名义档」取。
 * 只依赖仓位自己的字段（`ex` / `notional` / `spot` / `lev`），**不需要外部时刻**。
 */
export const maintRateOf = pos => maintRateAt(pos.ex, pos.notional, instrumentOf(pos));

/**
 * 这个仓位要不要付**借贷利息**（B26）—— 只有现货保证金要。
 * 与 `paysFunding` 互斥，两者合起来覆盖全部可强平的仓位。
 */
export const paysInterest = pos => instrumentOf(pos) === 'margin';

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

