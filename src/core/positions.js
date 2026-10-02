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
 * 这一笔订单 / 仓位的**冲击形态品种**（§73.6）—— 决定走 `SHOCK_MODE.spot` 还是 `fut` 那一套
 * `perm` / `betaFast`，也决定它参不参与 NPC 级联。
 *
 * 三档的唯一分界是「**有没有杠杆盘**」，不是「走不走现货模式」：
 *   - 真现货 1x（`spot && lev ≤ 1`）⇒ `'spot'`（实物换手、无杠杆盘 ⇒ 痕迹久、不级联）；
 *   - 合约（`mode='fut'`）与**现货保证金杠杆**（`spot && lev > 1`）⇒ `'fut'`（合成盘、有杠杆盘）。
 *
 * ⚠️ 与 `isSpot` / `instrumentOf` **不是同一件事**：那两个回答「是不是现货通道 / 什么工具」，
 *    这里回答「它的冲击长什么样」。现货模式带杠杆（Bitfinex 2013 的 margin）是现货通道，
 *    却属于杠杆盘 —— 这正是用户要的「现货 / 合约 / 杠杆三个手感不同」的那第三档。
 */
export const shockKindOf = (spot, lev) => (spot && lev <= 1 ? 'spot' : 'fut');

/**
 * 维持线最多吃掉初始保证金的**一半**（＝爆仓前至少留一半垫子）。
 *
 * ⚠️ **为什么必须有这一条**（2026-10-02 审计修）：杠杆阶梯（`spotSteps` / `futSteps`）与
 *    Binance 的维持档（`BINANCE_MARGIN_TIERS`）是两张**互不知道对方**的表。名义额一大，
 *    维持档就会追平甚至超过 `1/杠杆` —— 实测两个格子：
 *      · Binance 永续 20x、名义 ≥ $500 万 ⇒ 维持 5% = 1/20 ⇒ `强平价 ≡ 开仓价`，**开仓即强平**
 *      · Binance 永续 125x（2019-10 ~ 2021-07）、名义 $25 万 ~ $100 万 ⇒ 维持 1% > 1/125
 *    这两处旧行为都是「刚点下去就爆」，玩家只会以为界面坏了。
 * ⚠️ 只在**退化格**里生效：正常格必满足 `maint < 1/lev`（如 BitMEX 100x 的 0.5% < 1%），
 *    这一支逐位不碰 ⇒ 现有玩法与离线断言零影响。
 */
const MAINT_MAX_SHARE = 0.5;

/**
 * 该仓位此刻的**维持保证金率**（B18）—— 按「所 × 工具 × 名义档」取。
 * 只依赖仓位自己的字段（`ex` / `notional` / `spot` / `lev`），**不需要外部时刻**。
 */
export function maintRateOf(pos) {
  const m = maintRateAt(pos.ex, pos.notional, instrumentOf(pos));
  const open = 1 / pos.lev;                       // 开仓时的保证金率
  return m < open ? m : open * MAINT_MAX_SHARE;   // 退化格：见 MAINT_MAX_SHARE
}

/**
 * 这个仓位要不要付**借贷利息**（B26）—— 只有现货保证金要。
 * 与 `paysFunding` 互斥，两者合起来覆盖全部可强平的仓位。
 */
export const paysInterest = pos => instrumentOf(pos) === 'margin';

/* ───────────────────────── 资金费率（GDD §9.5） ───────────────────────── */

/** 持仓成本（永续资金费 / 现货保证金利息）的**结算周期**：每 8 游戏小时一次。 */
export const FUNDING = {
  hours: 8,
};

/**
 * **资金费率参数**（§73.6 · 2026-10-02 拍板；v30 · 第 6 批重定口径）—— 由「玩家自己的拥挤成本」
 * 改为「**全市场多空失衡**」。
 *
 * 旧口径（2026-10-02 早）把费率绑在**玩家持仓名义相对小时基准深度**上，并写成
 * `rate = clamp(FR.k × (名义 ÷ hourLiqBase) × dir, ±FR.max)`，而 `fundingOf` 又乘一次 `dir`
 * ⇒ 两次 `dir` 相消 ⇒ `fee = FR.k × (size×mark)² ÷ liq ≥ 0`，**玩家无论做多做空都只付不收**
 * （`fundingOf` 文档里「应收」那一支是死代码）。钱扣完即凭空消失，没有对手方。
 *
 * 新口径（真实永续的定义，见 Coinglass「Funding rate」/ tlap.io「Who pays whom」）：
 * 资金费是**多空之间的点对点转移**，交易所只当中介；**拥挤方付、另一侧收**。故费率只由
 * **全市场多空失衡**驱动，不含方向：
 *
 *     rate = clamp(FR.k × clamp((longShare − 0.5) ÷ 0.5, −1, 1), ±FR.max)
 *     fundingOf(pos, mark, rate) = size × mark × rate × dir     ← `dir` 只出现这一次
 *
 * `longShare` 取 `engine.longShareOf`（**NPC 六档 ＋ 玩家该币名义**，单一分母）⇒ 玩家自己的仓
 * 越大，对偏斜的贡献越大 ⇒「仓越大越贵 / 越赚」**自动保持**，无需再加第二项（§73.6 的诉求）。
 *
 * ⚠️ **量级**（用户 2026-10-02 拍板 `k = max = 0.003`）：完全失衡（一侧占全）⇒ 0.3%/8h
 *    （＝旧口径的极端档）；常态偏斜归一化约 0.1–0.3 ⇒ 0.03–0.09%/8h，落在现实
 *    「常态 0.01%、默认上限 0.05%」的上沿，手感与旧档连续。
 */
export const FR = { k: 0.003, max: 0.003 };

/**
 * **保险基金的播种比例**（v30 · 第 6 批 · 缺口 5）—— 见 `state.js` 的 `s.fund` 与
 * `engine.stampede` 的三级瀑布。
 *
 * ⚠️ **播种口径**：开局日的日流动性 × 本值。现实 Binance SAFU ≈ $1B，相对全网 OI
 *    （[Kineticalpha](https://www.kineticalpha.com/research/offshore-perps) 记 Binance 占 BTC 期货 OI 约 29–30%）
 *    量级在 **1–2%**；用流动性比例可随年代自动缩放（2013 与 2025 差三个数量级）。
 * ⚠️ 计提侧**不再另设比例** —— 强平盈余就是「隐含保证金 − 实际亏损」，在强平线处恰等于
 *    `名义 × GAME.maintRate`（0.5%），由 `stampede` 现算，不写第二个常数（一处口径）。
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

