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
 * @param {boolean} marginMode 是否走**杠杆通道**（U1 · ROADMAP §21.4）—— 由调用方按 `s.mode` / 通道算好传进来，
 *   开仓那一刻**定死**在仓位上（`isMargin` 读的就是它）。见 `engine.openTrade()` 里的表达式。
 */
export function openPosition(sym, side, price, margin, lev, feeRate, marginMode = false) {
  const notional = margin * lev;
  return {
    sym,
    side,
    lev,
    isMargin: marginMode,   // 杠杆通道标记（U1）：一旦开仓就固定，不再随 `s.mode` 变
    margin,                 // 数值保证金（USDT）—— 别与上面的布尔标记混为一谈
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
 * ⚠️ 不可强平的仓位（1x 多头，无借入）恒返回 `1`：它没有维持线这一说，也就永远不进入注意 / 危险区。
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
 * ⚠️ B18 起 `maintRate` 由 `maintRateOf(pos)` 给（Binance 永续按名义分档；Binance 杠杆按杠杆档换
 *    保证金水平；其余 margin 恒 15% —— 见 `config.maintRateAt`）。
 */
export function liquidationPrice(pos) {
  const dir = pos.side === 'long' ? 1 : -1;
  return pos.entry + dir * (maintRateOf(pos) * pos.notional - pos.margin) / pos.size;
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
 * 触发强平时 `保证金率 ≤ 维持保证金率` ⇒ `frac ≥ 1 − 1/target`
 * （2026-10-03 起默认 1.1 倍 ⇒ **至少平 1/11**，见 `engine.PARTIAL_TARGET`）；
 * 只有在权益已经跌到 ≤ 0 时才取到 1（那时必须全平，不能留一个负保证金率的口子）。
 *
 * @param {number} target 目标倍数（binance 官方式：拉到维持线的若干倍即止）
 */
export function reduceFraction(pos, price, target = 1.1) {
  const goal = target * maintRateOf(pos);
  if (!(goal > 0)) return 1;
  const f = 1 - marginRateOf(pos, price) / goal;
  return Math.max(0, Math.min(1, f));
}

/* ───────────────────────── 杠杆 / 合约（GDD §9.1） ───────────────────────── */

/**
 * 杠杆通道判定（U1 · 2026-09-29 改判，ROADMAP §21.4；v9 · §15.6 再改）—— **读仓位自己的 `isMargin` 标记**。
 *
 * ⚠️ 它不再由 `side / lev` 推出来。开仓那一刻由 `engine.openTrade()` 按 `s.mode` 算好写进仓位，
 *    之后**固定不变** —— 玩家中途切换模式不会改变已有仓位的性质（那才符合直觉）。
 *    `'margin'` 模式下的任何单 ⇒ 杠杆通道；`'fut'` 模式下的任何单 ⇒ 合约通道。
 *    ⚠️ **本作没有现货概念**：1x 仍是杠杆通道的最低档。1x **多头**没有借入 ⇒ 不计息、不参与强平；
 *       1x **空头**做空必须借币、借的是全额 ⇒ 照常计息、照常有强平线（见 `borrowedOf`）。
 *
 * ⚠️ **v9 起它只回答一个问题：「这笔单是怎么开的」**。改动前它同时承担着两件事
 *    （不付资金费 ＋ 不被强平），而杠杆通道从 §15.6 起**也带杠杆**了 ——
 *    于是「是杠杆单」不再等价于「不会被强平」，那两件事各自拆成了下面两个更窄的判据。
 */
export const isMargin = pos => !!(pos && pos.isMargin);

/**
 * 这一笔**借了多少**（2026-10-03 用户拍板 · 「按借入量统一口径」）—— 同一个量同时决定
 * 「要不要计息」与「能不能被强平」，两件事从此只有一个根因：**借了钱 / 币就要还**。
 *
 * 史实口径（Bitfinex 借贷）：
 *   - **多头**借的是美元：借入 = `名义 − 保证金`（1x ⇒ 0，等于现货买入、不付息）
 *   - **空头**借的是币：做空必须**借币卖出** ⇒ 借入 = **全额名义**（1x 空头照样付借币息、照样有强平线）
 *
 * ⚠️ 它**不需要存字段**：`借入 ÷ 名义` 在这个仓位的一生里是常数 —— 部分强平让两者同比例缩小，
 *    利息只减 `margin`、不动 `notional` ⇒ 由 `notional` / `lev` / `side` 现算即可，与仓位同步衰老。
 * ⚠️ 合约（非 `isMargin`）借入恒 0：它不借钱，只付资金费。
 */
export const borrowedOf = pos => {
  if (!isMargin(pos)) return 0;
  if (pos.side === 'short') return pos.notional;
  return pos.notional * (1 - 1 / pos.lev);
};

/**
 * 这一笔借的是**哪一种币**（B26 · 2026-10-03 拆档）—— 决定走 `MARGIN.daily` 的哪一条利率曲线。
 *
 *   - **多头**借**标价币**（USD / USDT，买币要付钱）⇒ `'quote'`
 *   - **空头**借**标的币**（做空必须先借币卖出）⇒ `'coin'`
 *
 * 史实里这是**两个独立市场**（两条 funding book）：标价币池子大、需求旺 ⇒ 利率高；
 * 标的币池小、出借方少 ⇒ 利率低一个数量级。合成一条曲线会把空头的成本算成多头的 5–10 倍。
 * ⚠️ 它只回答「借哪个币种」；**要不要计息**仍由 `borrowedOf > 0` 决定（1x 多头借入为 0，本条不参与）。
 */
export const borrowCurOf = pos => (pos.side === 'short' ? 'coin' : 'quote');

/**
 * 这个仓位要不要参与**资金费率**结算（v9 · §15.3 N5）—— **只有永续要**。
 * 杠杆融资（margin）不吃资金费，改为**借贷利息**（B26 · 见 `paysInterest`），
 * 两者在引擎里是同一次结算的两个分支，不是同一笔钱。
 */
export const paysFunding = pos => !isMargin(pos);

/**
 * 这个仓位会不会被**强平**（v9 · §15.3 N5）—— 引擎的强平循环拿它当判据。
 *   - 合约：恒可（走维持保证金率那一套）
 *   - 杠杆：**有借入才可** —— 借来的钱 / 币要还，所以要维持保证金（见 `borrowedOf`）
 *   - 1x 多头：借入为 0，只有币价归零才归零本金，不因维持线被强平（GDD §9.1）
 *   - 1x 空头：借了全额币 ⇒ **可强平**（币价涨到约 +85% 时维持线触底）
 * ⚠️ 2026-10-03 起判据从 `lev > 1` 换成 `borrowedOf > 0`：把「1x 空头」也纳进来（史实如此）。
 */
export const canLiquidate = pos => !isMargin(pos) || borrowedOf(pos) > 0;

/* ───────────── 工具性质与维持保证金率（B18 / B26 · 2026-09-30） ───────────── */

/**
 * 这条仓位**是什么工具**（B26）—— 史实上「借钱买币」与「永续合约」是两种东西：
 *
 *   - `'margin'`：**杠杆借贷** —— 有借入的仓（`borrowedOf > 0`，即 `lev > 1` 或**任何空头**；
 *     Bitfinex 2013-04 起 3.3x、Binance 2019-07-11 起 3x）。借来的钱 / 币要还，按**借贷日息**计息，
 *     维持线按所取：Bitfinex 走史实的 **15%（权益口径）**，Binance 走保证金水平换算的 **9–12%**。
 *   - `'perp'`：**线性 USDT 本位永续** —— `fut` 表的任何仓位。吃 8 小时资金费、维持线 0.5% 起。
 *
 * ⚠️ 2016-05-13 之前世界上**没有永续**（BitMEX 的 XBTUSD 是人类第一个）——
 *    那年头的「杠杆」全是借钱买币，所以早期仓位一律落进 `'margin'` 这一支。
 * ⚠️ 它**只用来选维持线 / 计息口径**（`maintRateOf` / `paysInterest`）—— 判据是「有没有借入」，
 *    所以 **1x 多头**（借入 0）落进 `'perp'` 那一支，但它**不可强平**，维持线根本不参与判定。
 * ⚠️ 与 `engine.levKind(s)`（`'margin'` / `'fut'`，回答「走哪张杠杆表」）**不是**同一条分界了 ——
 *    前者按 `s.mode`，这里按借入量。1x 空头走杠杆表、也按杠杆口径计息，两边一致。
 */
export const instrumentOf = pos => (borrowedOf(pos) > 0 ? 'margin' : 'perp');

/**
 * 这一笔订单 / 仓位的**冲击形态品种**（§73.6）—— 决定走 `SHOCK_MODE.coin` 还是 `fut` 那一套
 * `perm` / `betaFast`，也决定它参不参与 NPC 级联。
 *
 * 两档的唯一分界是「**有没有杠杆盘**」，不是「走不走杠杆模式」：
 *   - 杠杆 1x（`isMargin && lev ≤ 1`）⇒ `'coin'`（实物换手、无杠杆盘 ⇒ 痕迹久、不级联）；
 *   - 合约（`mode='fut'`）与**杠杆 > 1**（`isMargin && lev > 1`）⇒ `'fut'`（合成盘、有杠杆盘）。
 *
 * ⚠️ 与 `isMargin` / `instrumentOf` **不是同一件事**：那两个回答「是不是杠杆通道 / 什么工具」，
 *    这里回答「它的冲击长什么样」。杠杆 1x 是实物换手，杠杆 > 1 才是合成盘 —— 这正是模型要的
 *    「1x 与带杠杆两个手感不同」的分界。
 */
export const shockKindOf = (isMargin, lev) => (isMargin && lev <= 1 ? 'coin' : 'fut');

/**
 * 维持线最多吃掉初始保证金的**一半**（＝爆仓前至少留一半垫子）。
 *
 * ⚠️ **为什么必须有这一条**（2026-10-02 审计修）：杠杆阶梯（`marginSteps` / `futSteps`）与
 *    Binance 的维持档（`BINANCE_MARGIN_TIERS`）是两张**互不知道对方**的表。名义额一大，
 *    维持档就会追平甚至超过 `1/杠杆` —— 实测两个格子：
 *      · Binance 永续 20x、名义 ≥ $500 万 ⇒ 维持 5% = 1/20 ⇒ `强平价 ≡ 开仓价`，**开仓即强平**
 *      · Binance 永续 125x（2019-10 ~ 2021-07）、名义 $25 万 ~ $100 万 ⇒ 维持 1% > 1/125
 *    这两处旧行为都是「刚点下去就爆」，玩家只会以为界面坏了。
 * ⚠️ 只在**退化格**里生效：正常格必满足 `maint < 1/lev`（如 BitMEX 100x 的 0.5% < 1%），
 *    这一支逐位不碰 ⇒ 现有玩法与离线断言零影响。
 *
 * ⚠️ `0.5` 是**设计取值**（未找到文献出处）—— 出处就是上面那两个退化格，取「留一半垫子」
 *    这个整数比例是为了好解释、好记；它只在退化格里兜底，不参与任何正常格的定价。
 */
const MAINT_MAX_SHARE = 0.5;

/**
 * 该仓位此刻的**维持保证金率**（B18）—— 按「所 × 工具 × 名义档」取。
 * 只依赖仓位自己的字段（`ex` / `notional` / `margin` / `lev`），**不需要外部时刻**。
 */
export function maintRateOf(pos) {
  const m = maintRateAt(pos.ex, pos.notional, instrumentOf(pos), pos.lev);
  const open = 1 / pos.lev;                       // 开仓时的保证金率
  return m < open ? m : open * MAINT_MAX_SHARE;   // 退化格：见 MAINT_MAX_SHARE
}

/**
 * 这个仓位要不要付**借贷利息**（B26）—— **有借入就要**（见 `borrowedOf`）：
 * 杠杆 > 1 的多头（借美元）、以及**任何空头**（借币，含 1x 空头）。
 * 与 `paysFunding` 互斥，两者合起来覆盖全部可强平的仓位。
 * ⚠️ 2026-10-03 起判据从 `lev > 1` 换成 `borrowedOf > 0`（与 `canLiquidate` 同源）。
 */
export const paysInterest = pos => borrowedOf(pos) > 0;

/* ───────────────────────── 资金费率（GDD §9.5） ───────────────────────── */

/**
 * 持仓成本（永续资金费 / 杠杆借贷利息）的**结算周期**：每 8 游戏小时一次。
 *
 * ⚠️ **8h 不是一刀切偷懒**（2026-10-03 调研）：BitMEX（2016-05-13 人类第一个永续）与
 *    Binance 的 BTCUSDT 都是 8h（00 / 08 / 16 UTC）。本作三所里只有这两家有永续
 *    （Bitfinex 是借贷所，没有永续）⇒ 8h 对本作**本来就是对的**。
 *    （Hyperliquid / dYdX 的 1h、Binance 少数高波动对 2023 后转 4h/1h —— 这些所本作没有。）
 */
export const FUNDING = {
  hours: 8,
};

/**
 * **资金费率参数**（§73.6 · 2026-10-02 定口径；**2026-10-03 真实化** —— NEXT-STEPS §14.1 A3）——
 * 采用 BitMEX / Binance / Hyperliquid 通用的**两段式**：
 *
 *     P（溢价指数）→  F = clamp( P + clamp(I − P, ±FR.clamp), ±FR.max )
 *
 *   - `interest` I = **0.01% / 8h**（＝ 0.03% / 日，年化 10.95%）。BitMEX 2016 立规时的常量
 *     （`I = (Q − B) ÷ T = (0.06% − 0.03%) ÷ 3`），Binance 沿用同一档；本作对全部永续所统一取它。
 *   - `clamp` = **0.05%** —— 夹的是 **`(I − P)`**、**不是费率本身**（最容易被抄错的一点）。
 *     ⇒ 中性带 `P ∈ [−0.04%, +0.06%]` 内费率**恒等于 I**。这正是 BitMEX 实测 78%、
 *       Binance 92% 的时间里费率恰好 0.01%、且费率长期偏正的原因。
 *     BoB 的推导：`F = 0.01%` 当且仅当 `P ∈ [−0.04%, 0.06%]`；带外则以斜率 1 跟随 P。
 *   - `max` = **0.75% / 8h** —— Binance BTCUSDT 的长期默认上限（现行 ≥30x 合约口径为
 *     「±0.75 × 维持保证金率」，量级同档）。原来的 0.3% 偏低，且叠上 clamp 后「完全失衡」
 *     也只有 0.25% ⇒ 上限形同虚设。
 *
 * ⚠️ **`k` = 本作的「P 代理」系数**（用户 2026-10-03 拍板「沿用多空失衡当 P」）：
 *
 *     P = k × skew,   skew = clamp((longShare − 0.5) ÷ 0.5, ±1)
 *
 *     **为什么 P 不是价格**：真实 P 是「永续价 − 现货指数」的区间加权均价，而本作数据包
 *     只有 OHLC（没有期现基差源）。①三价体系虽给了 `markBias`，但它是**游戏尺度**的位移
 *     （NPC 趋势盘的 `npcDrift` 可达 1%+）⇒ 拿它当 P 会**长期顶死 cap**、费率失真；
 *     多空失衡的量级恰好落在现实区间（常态 0.01%/8h、极端 0.25%/8h）⇒ 用它当溢价代理。
 *     ⇒ 本条是**口径注**，不是「忘了做 premium index」。
 * ⚠️ **量级后果**（用户 2026-10-03 拍板「按现实，不补偿」）：叠上 clamp 后，小溢价一律回到
 *     0.01%/8h、大溢价被减 0.05% ⇒ 持仓成本比旧口径（0.03–0.09%/8h）**显著变低** ——
 *     这就是现实（真实费率绝大多数时间恰为 0.01%）。`k` 保持 0.003 不动。
 */
export const FR = { k: 0.003, interest: 0.0001, clamp: 0.0005, max: 0.0075 };

/**
 * **全市场多空占比 → 溢价指数代理 P**（`skew` 归一化到 ±1，再乘 `FR.k`）。
 * @param {number} share `longShareOf` 的结果（0 ~ 1）
 * @returns {number} `−FR.k ~ +FR.k`
 */
export function premiumIndexOf(share) {
  const skew = Math.max(-1, Math.min(1, (share - 0.5) / 0.5));
  return FR.k * skew;
}

/**
 * **溢价指数 → 真实资金费率**（纯函数 · BitMEX / Binance 口径）。
 *
 *     `F = clamp( P + clamp(I − P, ±FR.clamp), ±FR.max )`
 *
 * 形状：中性带内**恒等于 I**；带外以斜率 1 跟随 P；两端撞 cap。
 * 例（P 为 0.3% 的完全失衡）：`I − P = −0.29%` → 夹到 `−0.05%` → `F = 0.25%`。
 * @param {number} p 溢价指数
 * @returns {number} 该期资金费率（正 = 多头付、空头收）
 */
export function fundingRateOf(p) {
  const x = Number.isFinite(p) ? p : 0;
  const corr = Math.max(-FR.clamp, Math.min(FR.clamp, FR.interest - x));
  return Math.max(-FR.max, Math.min(FR.max, x + corr));
}

/**
 * **保险基金的标定参数**（v30 · 第 6 批 · 缺口 5；2026-10-03 ADL 审计重标定）——
 * 见 `state.js` 的 `s.fund` 与 `engine.stampede` 的三级瀑布。
 *
 * ⚠️ **`seed` 只决定基金的播种水位** —— 开局（或上帝模式跨年代回退后重播）那一刻的
 *    `当日流动性 × 本值`。现实 SAFU ≈ 全网 OI 的 1–2%（[Kineticalpha](https://www.kineticalpha.com/research/offshore-perps)
 *    记 Binance 占 BTC 期货 OI 约 29–30%）；用流动性比例可随年代自动缩放
 *    （2013 与 2025 差三个数量级），写死绝对值会在某一端失真。
 *
 * ⚠️ **本值不再是 ADL 的触发线**（2026-10-03 拍板）：实测证明基金在这套市场模型里
 *    **结构性失血**（12 年强平盈余 $165M vs 穿仓 $39.6B，1:240），任何以「基金水位」为判据的
 *    触发都会退化成「永久处于线下 ⇒ 每根都触发」（旧实现实测 5556 次）或「跨零后永不再触发」
 *    （改穿越式后只剩 2013/2016 共 4 次）。故 ADL 的触发改由**级联烈度**给：
 *    见 `god.NPC.liqEventFrac`（单小时强平额 ÷ 当日流动性 ≥ 7.5%）。
 *
 * ⚠️ 计提侧**不另设比例** —— 强平盈余就是「隐含保证金 − 实际亏损」，在强平线处恰等于
 *    `名义 × GAME.maintRate`（0.5%），由 `stampede` 现算，不写第二个常数（一处口径）。
 *
 * @property {number} seed      基金初始水位 = 当日流动性 × 本值（滚动，2013 与 2025 同一条尺子）
 */
export const INSURE = { seed: 0.02 };

/**
 * 该仓位这一次应付的资金费。
 * @returns {number} **正数 = 应付出**（从保证金里扣），负数 = 应收（加进保证金）
 *   多头 × 正费率 ⇒ 应付；空头 × 正费率 ⇒ 应收。
 */
export function fundingOf(pos, mark, rate) {
  const dir = pos.side === 'long' ? 1 : -1;
  return pos.size * mark * rate * dir;
}

