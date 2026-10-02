/**
 * 交易与时间引擎（GDD §4 / §9 / §10 / §11）
 * ===============================================================
 * 这里只有三件事：**推进时间**、**改状态**、**判破产**。不碰 DOM，不读 `Date.now()`
 * （时钟从 `main.js` 注入，这样无头测试才能复现「50x 跑完 12 年」这类断言）。
 *
 * 时间的真相源只有一个：`s.i`（第几根小时 K 线）。
 * K 线推进 = 真实秒 × 倍速 ÷ 1 秒/根（GDD §11：1x 下 1 游戏小时 = 1 真实秒）。
 *
 * ⚠️ 爆仓判定必须用**当根 K 线的高低价**，不能用收盘价。
 *    收盘价只在整点变一次，用收盘价判爆仓会把「一根针」整个吞掉 ——
 *    而 100x 下 0.5% 的逆向波动正是被针扎出来的，那才是这个游戏的核心体验（GDD §14）。
 */

import { GAME, HOUR_MS, COINS, EXCHANGES, LIQ, MIN_NOTIONAL, minNotionalAt, OTC, SUPPLY_SHARE, FLOAT, USDT_LIVE, coinOf, exchangeOf, hasFinancingAt, hasLeverageKindAt, isChallenge, maxLeverageAt, feeRateOf, marginDailyRateAt, railAt, railFeeOf, cashCurAt, loanAmountAt, otcPremiumOf, usdtPriceAt, haltedAt } from './config.js';
import { candleAt, closeAt, dayIndexOf, hasCandle, isLoaded, liqOf, loadCoin, rangeOf, rawCloseAt, supplyAt, volumeAt, HOURS_PER_DAY } from './market.js';
import { newsStartAt, resultNewsStartAt, warnAnchorAt } from './anchors.js';
import { arrivalCandles, bumpPulse, congestionOf, decayPulse, extraConfirmations } from './congestion.js';
import { SLIP, bookFills, fillPrice, hourShareK, impactOf, permImpactOf, POOL, poolRefill, sigmaOf } from './impact.js';
import { HEAT, NPC, SHOCK, addFlow, playerFactor, shockParamsOf } from './god.js';
import { absorbOf, levelsOf } from './levels.js';
import { fmtDate, fmtLogPrice, fmtMoney, fmtMoneyShort, fmtPct, fmtQty, fmtRate } from './format.js';
import {
  closePosition, equityOf, isLiquidatable, isSpot, liquidationPrice, maintRateOf, openPosition, pnlOf,
  reduceFraction, reducePosition,
  FUNDING, FR, fundingOf, canLiquidate, paysFunding, paysInterest, shockKindOf,
} from './positions.js';
import { blankBook, bookOf, cashOf, capturedOf, credit, debit, ensureBook, heldSyms, posOf, pushLog, spendableOf } from './state.js';
import { pathOf } from './simulate.js';
import { hashStr, rand } from './rng.js';
import { addCareer, thinEq } from './careers.js';

/** 交易所归零前多少毫秒给一条预警日志（7 天） */
const WARN_LEAD = 7 * 24 * HOUR_MS;

/* ── 逐步强平（2026-10-01 拍板 · Binance 口径） ──
 * 触发时**只平一档**，把剩余仓位的保证金率拉回 `PARTIAL_TARGET` 倍维持线，而不是整条打掉。
 * 参考：Binance 逐仓合约到维持线时下 IOC 单平掉一部分，直到保证金率回到 100% 之上；
 * Bybit 则是减到「维持保证金率回到 90%」。本作取「1.5 倍维持线」—— 留一点垫子，
 * 让玩家在暴跌里不是一次被打死，而是**被削一刀后还有翻本的机会**（GDD §10 的核心体验）。 */
const PARTIAL_TARGET = 1.5;

/** 同一根 K 线内最多连打几档（缓跌穿线 → 部分强平把强平价推远 → 继续跌 → 再穿）。 */
const PARTIAL_STEPS = 6;

/** OTC 通道**自动回退**时那句日志（§15.3）—— 文案单独提出来，因为它的「已播过」闩锁就是比对这句话（见 `advanceOneHour`） */
const OTC_OFF = '场外通道关闭 ｜ 已自动切回盘口';

/** 一局结束的原因 */
export const OVER = {
  LIQUIDATED: 'liquidated',   // 爆仓，保证金全部损失且账户清零
  SETTLED: 'settled',         // 活到 2024-12-31 收盘
  /* 2026-10-01 新增：玩家在归零遮罩上主动点「就此收摊」—— 这不叫爆仓，档案里要分开记。 */
  GAVEUP: 'gaveup',
  /* ⚠️ `DEFAULTED`（债务违约）已于 2026-10-01 随「救济金不用还」一起删除（用户拍板）。 */
};

/**
 * **暂停下单的锁**（§73.8）—— 暂停时下过一单之后，到「走满 1 游戏小时」之前一律为真。
 *
 * `s.lockI` 记的是下单那一刻的 `s.i`；时钟推进到 `s.i > s.lockI` 时由 `advanceOneHour` 解开。
 * 分派层（`main.js`）与渲染层（`render.js`）读**同一个**判据 —— 按钮画灰与真的点不动必须同源。
 */
export const pauseLocked = s => s.lockI >= 0 && s.i <= s.lockI;

/** 当前游戏时刻（ms） */
export const timeOf = s => GAME.start + s.i * HOUR_MS;

/* ───────────────────────────── 派生量 ───────────────────────────── */

/** 某个币当前的标记价（用收盘价） */
export function markPrice(s, sym = s.sym) {
  return closeAt(sym, s.i);
}

/** 某个币的持仓的未实现盈亏 */
export function unrealizedOf(s, sym) {
  const pos = posOf(s, sym);
  if (!pos) return 0;
  const p = markPrice(s, sym);
  return p == null ? 0 : pnlOf(pos, p);
}

/** 全部持仓的未实现盈亏之和（HUD 第二格的副行用这个） */
export function totalUnrealized(s) {
  let sum = 0;
  for (const sym of heldSyms(s)) sum += unrealizedOf(s, sym);
  return sum;
}

/**
 * 账户权益 = 当前所的余额 ＋ **在途的链上转账** ＋ **所有仓位权益之和**（逐仓：每个仓位的保证金 + 各自的未实现盈亏）。
 * 空仓时就是当前所的余额。破产始终看这个总数（GDD §10）—— 单个仓位爆仓只损失它自己的保证金。
 *
 * ⚠️ **在途资金必须算进来**（P2-A 陷阱①）：换所后 `books` 是空的，漏掉这一项会让权益显示 $0.00，
 *    并且被 `isBankrupt` 直接误判成破产、本局当场结束。它不是「隐藏资产」，是**可见但不可用**。
 * ⚠️ **USDT 按面值 $1 计入**（v13 · 方案 §2.2）：溢价已经在「买 U」那一刻结清（`usdtPriceAt`），
 *    这里再按市价重估就是把同一笔钱计两次价。副作用是好的：破产判定不会因为 U 脱锚而提前触发。
 */
export function equity(s) {
  let sum = cashOf(s);
  if (s.transfer) sum += s.transfer.amount;
  for (const sym of heldSyms(s)) {
    const pos = s.positions[sym];
    const p = markPrice(s, sym);
    sum += p == null ? pos.margin : equityOf(pos, p);
  }
  return sum;
}

/**
 * 可用保证金 = 当前所里未被持仓占用的余额（**两格之和**）。
 * ⚠️ **在途的钱不算**（P2-A 陷阱③）：它躺在链上，不能开仓、也不能再搬一次。
 *    实现上天然成立 —— `cashOf` 只看 `books`，而发起转账时旧所那一格已经清零。
 * ⚠️ v13 起它是**总口径**（HUD 那格「可用保证金」显示的就是这个数）；某一种订单**真正**
 *    能动用多少由 `spendableOf(s, mustUsdt)` 回答（合约只认 USDT）—— 别拿这个去开合约。
 */
export const available = s => cashOf(s);

/* ───────────────────── 资金曲线采样（v13 · 方案 §4） ───────────────────── */

/**
 * 每**游戏日**记一个权益点（`s.eq`，资产页那张折线图的唯一数据源）。
 *
 * ⚠️ `s.eq.length` 本身就是「下一个该记的日子」：一天只推一个点，第 0 天推完长度变 1，
 *    第 1 天就轮到下标 1 …… 不需要另存一份「上次记到哪天」的状态。
 * ⚠️ **下标要减掉 `s.day0`**（v21 · 年代开局）：`s.i` 是**全程**小时序号，而 `s.eq` 记的是
 *    **本局**第几个游戏日。2021 年开局时 `floor(s.i / 24)` 已经是 2922 —— 不减原点的话，
 *    开新局第一帧就会往 `s.eq` 里灌 2922 个假平点，曲线整条被压扁。
 * ⚠️ **补记循环**：一帧在 50x 下连跑 50 根小时线、跨天很正常；上帝模式「跳日期」更是逐小时重放。
 *    同一根小时线落在已记过的那天就不动，跨过了几天就用当前权益补齐 ——
 *    曲线宁可多一小段平线，也不能留洞。
 */
export function sampleEquity(s) {
  const day = Math.floor(s.i / 24) - s.day0;
  while (s.eq.length <= day) s.eq.push(equity(s));
}

/* ───────────────────────── 下单通道（P2-B3 · GDD §15.3） ───────────────────────── */

/** OTC 是否已解锁（§15.3：权益 > $500 万）—— UI 用它决定那枚切换键显不显示 */
export const otcUnlocked = s => equity(s) > OTC.unlock;

/**
 * 当前币**此刻**能不能走 OTC（P2-B 修订 · §15.3）。
 * OTC 台不是币一上线就做它的：早期只有 BTC（`#bitcoin-otc` 2010 年就在做），
 * ETH 要等到 2016 的 ICO 潮，XRP/DOGE 要等到 2018，SOL 更晚 —— 时刻表在 `config.COINS[].otc`。
 */
export const otcOpenFor = (s, sym = s.sym) => {
  const coin = coinOf(sym);
  return !!coin && timeOf(s) >= coin.otc;
};

/**
 * 当前**生效**的通道：`'book'`（盘口）或 `'otc'`（场外大宗）。
 *
 * ⚠️ OTC 只在「玩家选了它」**且「仍然解锁」**时成立 —— 权益掉回门槛下就自动退回盘口。
 *    否则会出现最别扭的一种状态：切换键已经藏起来了（不满足解锁条件），
 *    而 `s.chan` 还留着 `'otc'`，玩家接着下的每一单都在走一条看不见的通道。
 * ⚠️ 同理还有**第二个**回退条件（P2-B 修订）：当前币还没开通 OTC ⇒ 也退回盘口。
 *    换币时若还留着 `'otc'`，玩家会在一个「这个币根本没有的通道」里下单。
 */
export const chanOf = s => (s.chan === 'otc' && otcUnlocked(s) && otcOpenFor(s) ? 'otc' : 'book');

/**
 * 某币**此刻**的供应量闸门（枚）—— 「允许锁走的占比 × 当年真实流通量」（§15.1 / §15.4）。
 *
 * ⚠️ 2026-09-30 起流通量取的是**真实序列**（`market.supplyAt`，读 `index.json` 的 `circulating`，
 *    逐年锚点线性插值），不再是 `config` 里那个固定的枚数 —— 那个数的分母是总供应量，
 *    与 K 线头部显示的流通量是两套口径（详见 `config.SUPPLY_SHARE` 的注释）。
 * ⚠️ 取不到流通量（清单里没这个币 / `manifest` 还没加载）⇒ 返回 `Infinity`（**不设闸门**）：
 *    宁可漏放一条背景约束，也不能因为一个数据缺格把所有买入都拒掉。
 */
export function supplyCapOf(sym, i) {
  const share = SUPPLY_SHARE[sym];
  const circ = supplyAt(sym, i);
  return share != null && circ > 0 ? share * circ : Infinity;
}

/**
 * 账户权益归零即破产（GDD §1.3）。
 *
 * ⚠️ 容差不是可选项：`margin = cash / (1 + lev×feeRate)` 之后再减 `margin + fee`，
 *    浮点残渣会留下 ~1e-13 的「现金」，于是「已经归零」的账户永远过不了 `<= 0` 这一关，
 *    游戏既不结束、也不弹结算遮罩，只是卡在 $0.00 上继续走时间（2026-09-28 实测）。
 */
const isBankrupt = s => equity(s) <= 1e-9;

/* ───────────────────────────── 滑点（P2-B1） ───────────────────────────── */

/* σ 的缓存：键 = 币，值 = { day, v } —— 同一天内不必重扫 30 个日收盘。
   装的是「日收益 σ」（滑点的 σ_30日），也是 NPC 热度里位移标准化的分母（§73.5）。 */
const daySigmaCache = new Map();

/**
 * 近 30 天「日收盘收益率」的总体标准差 —— 滑点式里的 σ_30日（GDD §14.3）。
 *
 * 第 d 天的日收盘 = 那一天**最后一根小时 K**（`d × 24 + 23`）的收盘价。
 * 取 [day−31, day−1] 共 31 个日收盘 ⇒ 30 个日收益 —— **不含今天**：今天还没走完，
 * 把半截行情算进「日均波动」会让 σ 随当天走势抖（与 `hourlySigma` 的按天缓存同一取舍）。
 *
 * ⚠️ 起点**不夹到 0**（2026-09-30）：BTC 有 2012 回溯段（`config.COINS` 的 `unlock` 早于
 *    `GAME.start`），开局前 30 天因此吃的是**真实日波动**而不是兜底 3%；`day` 为负时
 *    `closeAt` 给的仍是回溯段里的真值（数据区间的左端是 −2304）。其余币的数据晚于 0，
 *    取到的是越界 `null`，`sigmaOf` 按「洞」跳过 ⇒ 行为与夹取时**逐位相同**。
 *
 * ⚠️ T-1 起**导出**给 UI 层：行情音的阈值 θ = `k × 本值 / √24`（用波动率归一化，
 *    否则 2013 的 BTC 会疯狂触发、2023 几乎不触发）。逻辑层不变，只是接线层要读它。
 */
export function dailySigma(sym, i) {
  const day = dayIndexOf(i);
  const hit = daySigmaCache.get(sym);
  if (hit && hit.day === day) return hit.v;

  const closes = [];
  for (let d = day - SLIP.window - 1; d < day; d++) {
    closes.push(closeAt(sym, d * HOURS_PER_DAY + HOURS_PER_DAY - 1));
  }
  const v = sigmaOf(closes);
  daySigmaCache.set(sym, { day, v });
  return v;
}

/**
 * **玩家持仓占可交易浮筹的比例**（`0 ~ 1`）—— 「持仓影响市场」那份唯一的占比（`config.FLOAT`）。
 *
 *   分子 = `capturedOf`（**现货实物多头**的枚数）
 *   分母 = 当年真实流通量 × `FLOAT.frac`（可交易浮筹）
 *
 * ⚠️ 取不到流通量（该币不在清单里 / `manifest` 未加载 / 该币此刻还没上线）⇒ 返回 0、**不折减**：
 *    宁可漏放这条约束，也不能因为一个数据缺格就把所有单子都按「已经买光了」处理。
 */
function floatShareOf(s, sym, i) {
  const held = capturedOf(s, sym);
  if (!(held > 0)) return 0;
  const circ = supplyAt(sym, i);
  if (!(circ > 0)) return 0;
  return Math.min(1, held / (circ * FLOAT.frac));
}

/**
 * 该小时的**基准深度分母** ＝ `liqOf(当天) × hourShareK(该小时份额, …) × 持仓折减`
 * —— **不含**瞬时深度池（池容量要拿它当基数 ⇒ 不能在它里面自洽引用，见 `poolFactorOf`）。
 * 口径与改动前的 `hourLiqOf` 逐字相同。
 *
 * 分母口径（C2，2026-09-29 拍板）：完整交易日里系数 = 24 × share，其**当日均值恰为 1**
 * ⇒ 一天下来的平均行为与「只用日流动性」**完全一致**（`A` / `threshold` / `cap` 无需重校），
 * 只是薄盘时段更痛、活跃时段更轻。
 *
 * **持仓折减**（v18 · 2026-10-01 拍板）：`max(FLOAT.depthFloor, 1 − share)` —— 你囤走的浮筹越多，
 * 市场能承接的深度越薄，同一笔单子的 `q` 越大、滑点越痛。下夹 `FLOAT.depthFloor` 是为了在
 * `share → 1` 时不把分母压到 0（否则 `q` 无穷大，滑点与拆单笔数都会失控）。
 *
 * @returns {number} 分母；取不到当日流动性时返回 0
 */
function hourLiqBase(s, sym, i) {
  const day = dayIndexOf(i);
  const liq = liqOf(sym, day);
  if (!(liq > 0)) return 0;
  const { sum, n } = dayVolShare(sym, day);
  const shrink = Math.max(FLOAT.depthFloor, 1 - floatShareOf(s, sym, i));
  return liq * hourShareK(volumeAt(sym, i), sum, n) * shrink;
}

/**
 * 某币此刻**尚未回补的已消耗深度**（美元名义额）—— 纯派生，不改状态。
 * `e = i − at` 按回补曲线折掉一部分；`e ≤ 0`（同一根 K 线内连点）⇒ 一分不回补。
 */
function poolConsumedAt(s, sym, i) {
  const p = s.pool && s.pool[sym];
  if (!p || !(p.v > 0)) return 0;
  const e = i - p.at;
  return e > 0 ? p.v * poolRefill(e) : p.v;
}

/**
 * **瞬时深度池**对分母的乘数（L1 · 2026-10-01 用户拍板「落地 L1」）—— `max(POOL.floor, 1 − v ÷ 容量)`。
 *
 * 病根：改动前 `hourLiqBase` 只随小时 / 年代 / 持仓变，每笔都按**满盘口**现算 ⇒ 边际难度恒定，
 * 「不停买入」也吃不光。池子把「这一小时已经被吃掉多少」也记上，吃得越狠、后续越薄。
 * 空池 ⇒ 返回**恰好 1**（`base × 1 ≡ base`，IEEE754 精确）⇒ 未消耗路径与改动前**逐位相同**。
 * @param {number} base 该小时基准深度（`hourLiqBase`，恒 > 0）
 */
function poolFactorOf(s, sym, i, base) {
  const consumed = poolConsumedAt(s, sym, i);
  if (!(consumed > 0)) return 1;
  return Math.max(POOL.floor, 1 - consumed / (POOL.capK * base));
}

/**
 * 把这一笔**吃掉的深度**记进池子（L1）—— 与 `addFlow` 同级，在成交落账之后调用。
 * 先按 `poolConsumedAt` 把旧值折到此刻（回补），再累加本笔 ⇒ 池子永远只有 `{v, at}` 一条。
 *
 * ⚠️ **不调 `invalidateSigma()`**：池子只改后续成交的分母（代价 / 笔数），不动价格 ⇒ σ 不受影响。
 * ⚠️ OTC 由调用点过滤（私下一口价不落公开盘口 —— 与「不写冲击池 / 不记量柱」同一先例）。
 */
function consumePool(s, sym, notional) {
  if (!(notional > 0)) return;
  if (!s.pool) s.pool = {};
  s.pool[sym] = { v: poolConsumedAt(s, sym, s.i) + notional, at: s.i };
}

/**
 * 该小时的流动性分母 ＝ `hourLiqBase × 瞬时深度池乘数`。
 *
 * ⚠️ 抽成独立函数是因为 **C8-B1 数子单笔数也要用它**（`q = 名义 ÷ 本值`）——
 *    笔数与滑点必须共用同一处口径，否则两者会各说各话。
 * ⚠️ 只有**滑点 / 笔数**走它；**量柱显示不走**（历史成交量不该被玩家改写，那里直接读 `liqOf`）。
 * @returns {number} 分母；取不到当日流动性时返回 0
 */
function hourLiqOf(s, sym, i) {
  const base = hourLiqBase(s, sym, i);
  if (!(base > 0)) return 0;
  return base * poolFactorOf(s, sym, i, base);
}

/**
 * 一次成交的冲击（0 = 不触发）。
 * ⚠️ **取不到当日流动性就不触发** —— 数据还没加载完 / 该币那天还没上线时，不凭空造一个冲击出来。
 */
function impactFor(s, sym, i, notional) {
  const liq = hourLiqOf(s, sym, i);
  if (!(liq > 0) || !(notional > 0)) return 0;
  return impactOf(notional / liq, dailySigma(sym, i));
}

/**
 * 一次成交的**行情位移量**（0 = 不触发）—— 与 `impactFor` 同形，但走**无死区**的 `permImpactOf`。
 *
 * ⚠️ 为什么必须另开一个入口（这是「大额买入不影响 K 线」的病根）：`impactFor` 走 `impactOf`，
 *    它带 `threshold = 10%` 的**代价**死区 —— 单笔不到当日流动量的 10% 就返回 0。那个 0 若被
 *    拿去当永久位移，`god.addFlow(…, 0)` 当场早退，`s.flow` 里**一个字节都写不进去**。实测
 *    2015 年后 BTC 单小时要 ≥ $8.5 万、2021 年要 ≥ $1.76 亿才触发 ⇒ 玩家的单子在图上毫无痕迹。
 *    位移是**市场影响**（任何成交都有），代价是**收费**（小额免收），两件事不该共用一条死区。
 */
function permImpactFor(s, sym, i, notional) {
  const liq = hourLiqOf(s, sym, i);
  if (!(liq > 0) || !(notional > 0)) return 0;
  return permImpactOf(notional / liq, dailySigma(sym, i));
}

/**
 * 这一笔成交**实际能推动多少价** —— 原始冲击先被沿途的**历史压力位**吸掉一部分
 * （ROADMAP §六十四，2026-10-02 用户拍板「接入行情、不画线」）。
 *
 * 被扫到的位 = 落在 `(现价, 成交后价]` 这一段里的那些（卖单镜像）。撞上去推不动，
 * 就是「那个价位真的堆着货」；权重和越大吸得越狠，上限 `LEVELS.absorb`。
 *
 * ⚠️ **只吸位移，不吸代价**（红线 A · 不双重计价）：`impactFor` 那条线一个字节都不动 ——
 *    这一笔该付多少滑点照付，这里只决定**成交之后价格停在哪**。
 * ⚠️ 现价取**标记价**（含玩家已造成的位移）而不是原始收盘：压力位是「相对当前价」的位置，
 *    玩家把价推上去之后再撞的应该是上面那一条。撞穿后位落到现价下方 ⇒ 自然不再被扫到。
 * ⚠️ 没扫到位时返回**恰好 `impact`**（乘 1，IEEE754 精确）⇒ 开局头两天、无行情、
 *    或价格在两条位之间的那些情况，与改动前**逐位相同**。
 */
function absorbedImpact(s, sym, dir, impact) {
  if (!(impact > 0)) return impact;
  const p = markPrice(s, sym);
  if (!(p > 0)) return impact;
  return impact * absorbOf(levelsOf(sym, s.i), p, dir, impact);
}

/**
 * 写一笔**行情位移** —— 开仓 / 平仓 / 强平 / 部分强平**四处共用**（改一处等于改四处）。
 *
 * 与改动前逐字相同的部分：`dir × SHOCK.share × permImpactFor(…)`、以及
 * 「`addFlow` 返真才 `invalidateSigma()`」。新增的只有中间那道历史压力位吸收。
 * ⚠️ OTC 由各调用点自己在 `!otc` 分支里过滤（私下一口价不落公开盘口 —— 既有先例）。
 * @param {number} give **回吐比例**（2026-10-02）：开仓 / 加仓传 1（满额），**平仓 / 强平 /
 *   部分强平传 `SHOCK.closeGive`** —— 往返不再等量抵消，台阶永久留下 65%（见 `god.js`）。
 * @param {'spot'|'fut'} [kind] **这一笔的产品线**（§73.6）—— 决定这笔台阶的衰减形态
 *   （现货 perm 高、回补慢；合约 perm 低、回补快）。缺省按合约。
 * @param {boolean} [player] 是不是**玩家自己的成交**（缺省是）。只有玩家的成交才给「热度」加料
 *   （§73.5 的 k3 项）—— NPC 自己写的那些不该再喂热度，否则热度会自激。
 */
function pushFlow(s, sym, dir, notional, give = 1, kind = 'fut', player = true) {
  const v = dir * give * SHOCK.share * absorbedImpact(s, sym, dir, permImpactFor(s, sym, s.i, notional));
  if (addFlow(s, sym, v, shockParamsOf(kind))) invalidateSigma();
  if (player && notional > 0) mktOf(s, sym).pv += notional;
}

/* ───────────────────── NPC 情绪 / 踩踏级联（§73.5 · 2026-10-02） ─────────────────────
   起因：`pushFlow` 原来的调用者只有玩家自己的仓 ⇒ 市场上物理上**不存在踩踏**。
   这一层给每个币补一组「NPC 净持仓 ＋ 情绪热度」：热度由**近 24h 的价格收益**与玩家自己的成交
   一起烧起来，反过来驱动 NPC 顺势建仓，跌破强平线时再触发踩踏级联（一条反向下台阶）。 */

/** 热度只读给 UI（缺格时返回中性 `HEAT.base` —— 与 `mktOf` 的初值一致）。 */
export const heatOf = (s, sym) => (s.mkt && s.mkt[sym] ? s.mkt[sym].heat : HEAT.base);

/**
 * **回顾页**的热度读数 —— 与实盘同一套方程，但只吃**原始历史行情**。
 *
 * 为什么回顾页可以「零耦合」：回顾那一屏 `factorFor ≡ 1`（见 `main.js` 的 factor 注入），
 * 显示的本来就是原始 K 线 ⇒ 热度是 `(sym, i)` 的**纯函数**，与存档无关，可以整条预计算后按索引取。
 * ⚠️ 游标只前进（`j` 从上次处续算），回看历史时直接查 `arr`，不重跑。
 */
const rvHeat = new Map();

export function reviewHeatOf(sym, i) {
  const r = rangeOf(sym);
  if (!r || i < r[0] || !isLoaded(sym)) return HEAT.base;
  const upto = Math.min(i, r[1] - 1);
  let c = rvHeat.get(sym);
  if (!c) { c = { a: r[0], j: r[0] - 1, h: HEAT.base, arr: [] }; rvHeat.set(sym, c); }
  for (let j = c.j + 1; j <= upto; j++) {
    const sig = dailySigma(sym, j);
    const p1 = rawCloseAt(sym, j);
    const p0 = rawCloseAt(sym, j - HEAT.window);
    const x = sig > 0 && p1 > 0 && p0 > 0 ? (p1 / p0 - 1) / sig : 0;
    c.h = clamp01(c.h + HEAT.k1 * x - HEAT.k2 * (c.h - HEAT.base));
    c.arr.push(c.h);
    c.j = j;
  }
  return c.arr[upto - c.a] ?? HEAT.base;
}

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 某个币的 NPC 情绪 / 持仓格子（懒建）：
 *   `heat` ∈ [0,1]，0.5 中性；`npcLong` / `npcShort` 是 NPC 净持仓**名义价值**（USD）；
 *   `npcLongAvg` / `npcShortAvg` 是平均入场价（算踩踏强平线用）；
 *   `npcDrift` 是散户净持仓造成的**有界价位偏移**台阶表 `{ at: [], v: [] }`（见 `god.npcDriftAt`）；
 *   `pv` 是**玩家本小时**的成交名义（每根 K 线结算一次，见 `tickMarket`）。
 */
function mktOf(s, sym) {
  if (!s.mkt) s.mkt = {};
  return s.mkt[sym] || (s.mkt[sym] = {
    heat: HEAT.base, npcLong: 0, npcShort: 0, npcLongAvg: 0, npcShortAvg: 0, npcDrift: null, pv: 0,
  });
}

/**
 * **现货不参与级联**（§73.6）—— 玩家这一单给热度加料的倍率。
 * 现货（含 OTC）是实物换手，没有杠杆盘、也就没有「散户追高被强平」那一环 ⇒ 倍率 0；
 * 合约 / 杠杆按 `min(lev/5, 3)` 放大（5x 起跳，15x 及更高级顶格 3 倍）。
 */
function cascadeMulOf(s) {
  const otc = chanOf(s) === 'otc';
  const lev = otc ? 1 : Math.max(1, s.lev);
  return shockKindOf(spotOf(s, otc), lev) === 'spot' ? 0 : Math.min(lev / 5, 3);
}

/**
 * NPC 顺势建仓：把某一侧净持仓朝 `target` 靠 `NPC.speed`。
 *
 * ⚠️ **不再 `pushFlow`**（2026-10-02 审计修，用户拍板）。原来每小时把建仓增量写进冲击池：
 *    旧实现的归并会把它按权重 1 重新计时（`decay(e≤1) = 1`）⇒ 恒定单向流量让残存值**线性发散**
 *    （实测 400 小时后 0.754，早就顶死 `riseMax` +20%，12 年里 99% 的时间被钉在夹子上），
 *    同时把玩家自己的 8 笔历史一笔笔挤出去。
 *    现在只更新持仓，价位偏移由 `syncNpcDrift` 依据**净持仓大小**重算 —— 有界、不累积。
 * ⚠️ **残尾要归零**（2026-10-02 审计修，`NPC.floor`）：`speed` 是「朝靶心靠 15%」的渐近式，
 *    净持仓永远只是**趋近** 0 而不等于 0（每小时 ×0.85）⇒ 一个 $1 的残尾 + 早年的低均价
 *    就能让 `stampede` 判出「亏 8%」白送一次强平（实测 12 年 663 次里绝大多数是这种幽灵）。
 *    低于 `floor` 的残尾直接清成 0 —— 残尾本身对价格没有可观测影响，留着只有副作用。
 * @param {number} price 这一刻的标记价（摊平均价用）
 * @param {number} floor 残尾归零阈值（名义额，调用侧给 `日流动性 × NPC.floor`）
 */
function stepNpc(s, sym, side, target, price, floor) {
  const m = mktOf(s, sym);
  const long = side === 'long';
  const key = long ? 'npcLong' : 'npcShort';
  const avgKey = long ? 'npcLongAvg' : 'npcShortAvg';
  const cur = m[key];
  const next = cur + (Math.max(0, target) - cur) * NPC.speed;
  if (next < floor) {                                                                // 残尾 ⇒ 直接清零
    if (cur !== 0) { m[key] = 0; m[avgKey] = 0; }
    return;
  }
  const delta = next - cur;
  if (!(Math.abs(delta) > 1e-9)) return;
  m[key] = next;
  if (delta > 0 && price > 0) m[avgKey] = (m[avgKey] * cur + price * delta) / next;   // 加仓 ⇒ 摊平均价
}

/**
 * 把散户**净持仓**折算成一根**有界**的价位偏移台阶（`s.mkt[sym].npcDrift`）。
 *
 * 口径与玩家侧同一把尺子：`q = |净持仓| ÷ 日流动性`，偏移 = `±permImpactOf(q, σ)`。
 * 稳态下 `q ≤ NPC.mom/2 = 7.5%`（靶心封顶）⇒ 偏移 `≤ 0.548σ`：2024 年 σ≈3.5% ⇒ ±1.9%，
 * 2013 年 σ≈16% ⇒ ±9%。**不累积、清仓即归零**。
 * ⚠️ 实测极值 `|npcDrift| = 15.7%`（2013-04-20，σ=16.5%）：那一天正好落在流动性骤降的
 *    年份形状谷底，而持仓按 `speed=0.15` 只每小时衰减 15% ⇒ `q` 短暂冲到 0.228（越过稳态上界）。
 *    仍远低于 `riseMax=20%` 的夹子（全程顶夹时间 0.000%），属可接受的历史极端。
 *
 * ⚠️ 分母用**日流动性**、不是逐小时深度（2026-10-02 审计修）：`hourLiqBase` 是「日流动性 ×
 *    该小时占比(×24) × 收缩」，占比逐小时在 0.3~3 之间摆动 ⇒ 同一笔净持仓的折算偏移**逐小时跳变**，
 *    显示的价位偏移变成一根跟着量能形状抖的噪声。`npcDrift` 是**存量**的仓位折算，该用日尺子 ——
 *    一天之内恒定，与靶心 `target` 的口径也才对得上。
 *
 * ⚠️ 存成**台阶表** `{ at: [], v: [] }`（与 `s.overhang` 同范式，见 `god.stepValueAt`）：
 *    `at` 之前的 K 线一律不受影响。**只在偏移真的变了（差 ≥ `NPC.driftEps`）时才落一级**
 *    —— 旧实现每小时无条件把 `npcDrift` 重盖成 `at = s.i`（NEXT-STEPS §九 根因 ②）⇒
 *    上一根 K 线每小时自己变一次（「已画出的根又恢复了」）。表长度 = 级数、不是游戏小时数。
 */
function syncNpcDrift(s, sym, i, sig) {
  const m = mktOf(s, sym);
  const net = m.npcLong - m.npcShort;
  const liqDay = liqOf(sym, dayIndexOf(i));
  const q = liqDay > 0 ? Math.abs(net) / liqDay : 0;
  const v = net === 0 ? 0 : Math.sign(net) * permImpactOf(q, sig);
  const tab = m.npcDrift || (m.npcDrift = { at: [], v: [] });
  const n = tab.at.length;
  if (n && Math.abs(v - tab.v[n - 1]) < NPC.driftEps) return;   // 变得看不见：不落级、不动历史
  tab.at.push(i); tab.v.push(v);
}

/**
 * **踩踏级联**（§73.5 第 4 步）：散户整条仓**浮亏到强平线**（距入场价 `1/lev − 维持保证金率`）⇒
 * 整条被动卖出（一根大阴线），并把热度再压一档。空头镜像（逼空）。
 *
 * 强平线口径与玩家侧同一把尺子：距入场价 `1/lev − 维持保证金率`（= `1/10 − 2%` = **8%**）。
 *
 * ⚠️ **入口条件只有「亏 8%」这一条**（2026-10-02 审计修，用户拍板）。原来还前置了
 *    `m.heat < HEAT.panic`，但那与 `target = mom × (heat − 0.5)` 直接矛盾：热度低于 0.25 时
 *    靶心已经为负 ⇒ 散户的**多仓早就被清成 0** ⇒ 多头分支**结构上永远不可达**，
 *    ROADMAP §73.10 那条「heat 高位时单笔砸 −3% → 触发级联」的验收根本跑不出来。
 *    现在只要价格真的跌穿 8%，无论热度在哪一档，整条多仓都会被强平 —— 这才是「强平线」的意思。
 * ⚠️ 平仓那笔用 `give = 1`（全额反向）—— NPC 建仓时写的是正冲击、且已经衰减了一部分，
 *    此刻的全额反向会**净剩一笔向下的位移**，那正是 §73.4 说的「过冲」的来源。
 * ⚠️ **按模式门控**（§73.6 · 2026-10-02 审计修）：级联的燃料是**杠杆盘**，实物现货换手没有被
 *    强制平仓的对手方 ⇒ `cascadeMulOf` 为 0（真现货 1x）时整条不跑。改动前它在现货模式也会
 *    把 NPC 当杠杆仓强平，与「现货不参与级联」的口径直接矛盾。
 */
function stampede(s, sym, m, price) {
  if (cascadeMulOf(s) <= 0 || !(price > 0)) return;
  const drop = 1 / NPC.lev - NPC.maint;              // 距入场价多远爆（0.08 = 8%）
  if (m.npcLong > 0 && m.npcLongAvg > 0 && price < m.npcLongAvg * (1 - drop)) {
    const amt = m.npcLong;
    m.npcLong = 0; m.npcLongAvg = 0;
    m.heat = clamp01(m.heat - HEAT.panicDrop);
    pushFlow(s, sym, -1, amt, 1, 'fut', false);
  }
  if (m.npcShort > 0 && m.npcShortAvg > 0 && price > m.npcShortAvg * (1 + drop)) {
    const amt = m.npcShort;
    m.npcShort = 0; m.npcShortAvg = 0;
    m.heat = clamp01(m.heat + HEAT.panicDrop);       // 空头踩踏 = 逼空 ⇒ 热度反而上冲
    pushFlow(s, sym, 1, amt, 1, 'fut', false);
  }
}

/**
 * 每根小时 K 线跑一次的市场情绪刻度（§73.5）—— 在 `advanceOneHour` 里、基础行情算完之后调用。
 *
 * ① 读**近 `HEAT.window` 小时的价格收益**（按日 σ 标准化）② 更新热度（收益 **被成交量有向放大** − 均值回复）
 * ③ NPC 顺势建仓（正反馈）④ 踩踏级联（仅杠杆模式）。
 * ⚠️ 只对**当前币**跑（`s.sym`）：玩家只在这个币上下单，其余币的 NPC 状态冻结 ——
 *    省掉「每个币每小时各跑一次」的整表开销，也不影响玩法（持仓的其它币走行情本身）。
 */
export function tickMarket(s, sym) {
  const m = mktOf(s, sym);
  const i = s.i;
  /* ① 价格项 `x` = **近 24h 收益 ÷ 日σ**（2026-10-02 拍板，取代原来的「本根累积位移 ÷ σ」）。
     ⚠️ 两条口径都很关键：
        · **窗口收益**而非单根位移 —— 位移是脉冲（平时恒 0），热度会被钉死在中性、玩家不动手就不跳；
          换窗口后 `x ≈ N(0, 1)`，热度才是一条连续的情绪曲线（`k1` 随之从 0.12 降到 0.02）。
        · 价格走 **`playerFactor`（剔除 NPC 自己那层偏移）** —— 玩家的成交要算进去，
          否则「拉盘 → 散户追高」这条玩法消失（§73.10 验收要求「单笔砸 −3%」有效）；
          NPC 自己的连续偏移必须剔除，否则自激（旧实现在 12 年里把价格钉死在 +20% 夹子上）。 */
  const sig = dailySigma(sym, i);
  const p1 = heatPriceAt(s, sym, i);
  const p0 = heatPriceAt(s, sym, i - HEAT.window);
  const x = sig > 0 && p1 > 0 && p0 > 0 ? (p1 / p0 - 1) / sig : 0;
  /* ② 热度：收益（**被成交量有向放大**）− 均值回复。⚠️ 这里的读全在 ③④ 写流之前。
     ⚠️ 成交量进的是**放大器**而不是加数（2026-10-02 审计修）：`pv` 是无符号的成交名义，
        写成加数时一笔巨额**卖单**会把热度往上顶 ⇒ 砸盘被读成极度贪婪、散户反手做多、位移反向
        （实测 15x 砸掉当日量 100% ⇒ 位移 +13.2%）。现在它只放大 `k1·x` 的**方向**：
        砸盘放大的是「变冷」、追高放大的是「变热」，量级再大也不翻转符号。
     ⚠️ `cascadeMulOf` 仍是模式权重：现货实物换手（无杠杆盘）⇒ 0，玩家的现货量不给热度加料（§73.6）。 */
  const liq = hourLiqBase(s, sym, i);
  const pv = liq > 0 ? m.pv / liq : 0;
  m.heat = clamp01(m.heat + HEAT.k1 * x * (1 + HEAT.k3 * Math.min(pv, 1) * cascadeMulOf(s))
    - HEAT.k2 * (m.heat - HEAT.base));
  m.pv = 0;
  /* ③ NPC 顺势建仓：热度高于中性 ⇒ 净多头，低于中性 ⇒ 净空头。取不到深度就不建（不凭空造量）。
     ⚠️ 靶心与残尾阈值都用**日流动性**（与 `syncNpcDrift` 同一把尺子）：用逐小时深度时，
        冷门小时（占比 1/24）的靶心被压小、热门小时又被放大 ⇒ 散户仓位跟着小时形状剧烈抖动。 */
  const liqDay = liqOf(sym, dayIndexOf(i));
  if (liqDay > 0) {
    const target = NPC.mom * (m.heat - HEAT.base) * liqDay;
    const price = markPrice(s, sym);
    const floor = liqDay * NPC.floor;
    stepNpc(s, sym, 'long', target, price, floor);
    stepNpc(s, sym, 'short', -target, price, floor);
  }
  syncNpcDrift(s, sym, i, sig);
  /* ④ 踩踏级联。 */
  stampede(s, sym, m, markPrice(s, sym));
}

/**
 * 热度用的价格读数 —— **原始历史行情 × 玩家自己的位移系数**（`god.playerFactor`），不含 NPC 那层。
 * 取不到原始收盘价（未上线 / 越界）时返回 0，调用方按「无价格项」处理。
 */
function heatPriceAt(s, sym, i) {
  const raw = rawCloseAt(sym, i);
  return raw == null ? 0 : raw * playerFactor(s, sym, i);
}

/**
 * 重算并写下**持仓抛压折价**（`s.overhang[sym]`，v18 · 2026-10-01 拍板）—— 每次现货实物多头
 * 增减（开 / 加仓、平仓、强平、部分强平、交易所归零）之后调用，外加每日按流通量退坡重算。
 *
 * 写的是**台阶表** `{ at: [], v: [], scar: [] }`（三条平行数组，按 `at` 升序，**只许追加**；
 * 见 `god.stepValueAt`）：`v` = 该级台阶的价格折价（恒 ≤ 0）＝ **持仓折价 ＋ 疤痕**，
 * `v = −FLOAT.overhangMax × share + scar`。
 *
 * ⚠️ **疤痕 `scar`**（v25 · 2026-10-02）—— 卖出只释放一部分，其余永久留下：
 *    折算与 `s.flow` 的 `SHOCK.closeGive` **同一个比例**（买→卖往返不再等量抵消）。
 *    起因是实测缺陷：平掉一条 $50M 现货多头后，`overhang` 整条消失 ⇒ 释放的 −1.71% 折价
 *    远大于平仓那一笔只回吐 −1.21% 的冲击 ⇒ **卖出之后价格反而比持仓时更高**（实测 +0.49%），
 *    「买→立刻平」成了白赚一档的套利。现在卖出只释放 `give`（= `closeGive`），
 *    其余 `1 − give` 压成 `scar` 永久留在场上（与「订单造成的 K 线永久保留」同一哲学）。
 *
 * ⚠️ `scar` 只在 `give > 0`（真实成交：平仓 / 强平 / 部分强平）时才累积：
 *    · 加仓 / 买回（折价幅度**变大**）不产生疤痕；
 *    · **按日重算**（`give = 0`）也不产生 —— 流通量逐年增长让同一份持仓的占比自然退坡，
 *      那是「稀释」不是「卖出」，不该留疤。
 *
 * ⚠️ **归零也要追加一级 `v = 0` 的台阶，绝不删整条表**（2026-10-02 修，NEXT-STEPS §九 根因 ①）：
 *    旧实现把新值写成**单条** `{ v, at: s.i, scar }` 覆盖旧值 ⇒ `[旧 at, 新 at)` 整段历史
 *    一起丢掉折价；`share = 0` 时更是直接 `delete` ⇒ 早于此刻的根全部「恢复原价」。
 *    这正是玩家反馈的「已经画出来的 K 线过几个小时又恢复了」。现在**只追加、绝不重盖**：
 *    `at` 恒等于写入那一刻的 `s.i`，任何 `j < at` 的根取值永不受影响。
 *    值没变时一个字节都不写 —— 否则每点一次都会刷存档，还会连带把 σ 缓存白冲一遍。
 *
 * ⚠️ 它是**逐根台阶**（`at` 之前的 K 线不受影响）⇒ 必须 `invalidateSigma()`，与 `s.flow` 同一条纪律。
 * ⚠️ 与 `s.flow` **方向可能相反**（买入把价抬上去、占比上升把价压下来）：两者相加后才是最终位移，
 *    净效果靠实测标定，别默认它们会互相抵消（见 ROADMAP §四十六）。
 * @param {number} give **释放比例**（v25）：真实成交那一侧传 `SHOCK.closeGive`（平仓 / 强平 /
 *   部分强平），其余（开仓 / 加仓 / 按日重算 / 交易所归零）传缺省 `0` = 全额释放、不留疤。
 */
function refreshOverhang(s, sym, give = 0) {
  if (!s.overhang) s.overhang = {};
  const prevTab = s.overhang[sym];
  const n = prevTab ? prevTab.at.length : 0;
  /* 上一级台阶拆成两块：`scar` = 卖出留下的永久疤痕，`v − scar` = 那一级的持仓折价 */
  const prevScar = n ? prevTab.scar[n - 1] : 0;
  const prevHold = n ? prevTab.v[n - 1] - prevScar : 0;

  const share = floatShareOf(s, sym, s.i);
  const hold = share > 0 ? -FLOAT.overhangMax * share : 0;

  let scar = prevScar;
  if (give > 0) {
    const drop = hold - prevHold;          // > 0 ⇒ 折价幅度在变薄（卖出 / 减仓）
    if (drop > 0) scar -= drop * (1 - give);
  }

  const v = hold + scar;
  if (n === 0 && v === 0) return;                                 // 本来就没折价：不建表、不动 σ
  if (n && prevTab.v[n - 1] === v && prevScar === scar) return;   // 值没变：不写、不动 σ
  const tab = prevTab || (s.overhang[sym] = { at: [], v: [], scar: [] });
  tab.at.push(s.i); tab.v.push(v); tab.scar.push(scar);
  invalidateSigma();
}

/**
 * 把一笔成交的**名义额**记到当根 K 线的量柱账上（`s.pvol`，v17 · 2026-10-01）。
 *
 * ⚠️ 只写量：滑点分母走 `liqOf`、价格位移走 `s.flow`，两条都不看这里 —— 它不参与任何玩法判定。
 * ⚠️ 口径（用户 2026-10-01 拍板）：名义额（含杠杆）／开仓＋平仓＋强平都算／**OTC 不算**
 *    （私下一口价不落公开盘口，与「不写冲击池」同一先例）—— OTC 的过滤放在调用点。
 * ⚠️ v19 起**按所分账**（`pvol[i][exId]`）：成交量阶梯手续费算的是「你在**这家所**近 30 天做了多少」，
 *    跨所搬钱后要重新攒量 —— 与真实交易所的 VIP 档按所计算一致。
 * ⚠️ v20 起再按**产品线**分账（`pvol[sym][i][exId][kind]`，`kind` = `'spot'` / `'fut'`）：
 *    现货与合约是两张费率表（`config.fees.spot` / `fut`），30 天量当然也得各算各的 ——
 *    混在一起会出现「靠现货刷量把合约费率刷低」这种现实里不存在的事。
 *    量柱读的是**当前币 × 全所 × 两条产品线的 `u` 之和**。
 * ⚠️ v24（2026-10-02）**最外层补 `sym`**：`s.i` 是全币种共用的小时序号，只按它记账会让
 *     「在 BTC 买的这一笔」同时出现在 ETH / XRP / DOGE / SOL 的同一根量柱上（用户反馈的 K 线污染）。
 *     形状与 `s.flow[sym]` / `s.pool[sym]` / `s.overhang[sym]` 三条对齐 —— 玩家留下的痕迹一律以币为作用域。
 * @param {string} sym 这一笔成交的币种（量柱按它隔离；费率阶梯那一路反过来跨币汇总，见 `vol30Of`）
 */
function addPlayerVol(s, sym, notional, exId, kind) {
  if (!(notional > 0) || !exId || !sym) return;
  if (!s.pvol) s.pvol = {};
  const bySym = s.pvol[sym] || (s.pvol[sym] = {});
  const cell = bySym[s.i] || (bySym[s.i] = {});
  const byKind = cell[exId] || (cell[exId] = {});
  const e = byKind[kind] || (byKind[kind] = { u: 0, b: 0 });
  e.u += notional;
  /* BTC 等值另一格（Mt.Gox 的档位是**按 BTC 枚数**分的）。取不到 BTC 价就只留美元那一格。 */
  const bp = closeAt('BTC', s.i);
  if (bp > 0) e.b += notional / bp;
}

/**
 * 某家交易所**某条产品线、近 30 天（720 根）**的成交量 —— 成交量阶梯手续费的分档依据
 * （v19 · 2026-10-01；v20 加 `kind` 维度）。
 *
 * 与真实交易所的「30 天滚动成交量」同口径：**含窗口两端、按小时求和**，
 * 且**跨币汇总** —— VIP 档算的是「你在**这家所**做了多少」，不分币对（BTC 的量与 ETH 的量一起进档）。
 * 复杂度 O(币数 × 720)、与局长度无关（只扫窗口，不扫全程）。
 * ⚠️ `kind` 默认 `'spot'` 只为「旧调用点忘改也能跑」兜底，四个调用点全都显式传。
 * @param {'spot'|'fut'} kind 这一单自己的产品线（与 `feeRateOf` 的 `kind` 同源）
 * @returns {{u:number,b:number}} 两个口径的合计（美元名义额 / BTC 等值）
 */
export function vol30Of(s, exId, i, kind = 'spot') {
  let u = 0, b = 0;
  if (!s.pvol) return { u, b };
  const from = Math.max(0, i - 30 * HOURS_PER_DAY + 1);
  /* v24：`pvol` 最外层是币种 ⇒ 这一层必须**遍历所有币**（费率档按所算、不分币对）。 */
  for (const sym in s.pvol) {
    const bySym = s.pvol[sym];
    if (!bySym) continue;
    for (let k = from; k <= i; k++) {
      const cell = bySym[k];
      const e = cell && cell[exId] && cell[exId][kind];
      if (!e) continue;
      u += e.u; b += e.b;
    }
  }
  return { u, b };
}

/* 日内份额的缓存：键 = `sym|day`，值 = { sum, n }（当天**已上线**小时的份额和与小时数）。
   ⚠️ 与两个 σ 缓存不同，它**只依赖原始成交额**、不受价格位移影响，所以 `invalidateSigma()`
      不清它；但**只在 `sum > 0` 时入缓存** —— 数据尚未加载完时会全读成 0，那不能留下。 */
const dayVolCache = new Map();

function dayVolShare(sym, day) {
  const key = `${sym}|${day}`;
  const hit = dayVolCache.get(key);
  if (hit) return hit;
  let sum = 0, n = 0;
  const from = day * HOURS_PER_DAY;
  for (let k = from; k < from + HOURS_PER_DAY; k++) {
    if (!hasCandle(sym, k)) continue;      // 该币当天还没上线的小时不参与
    sum += volumeAt(sym, k);
    n++;
  }
  const out = { sum, n };
  if (sum > 0) dayVolCache.set(key, out);
  return out;
}

/**
 * 日志尾巴：触发了才追加，没触发的一个字符都不加。
 * C8-B1（2026-09-29）：触发时再带上「这笔单相当于拆成几笔」——
 * 它只改这一行字，**成交价一个字节都没动**（红线 A · 不双重计价）。
 */
const slipTag = (impact, count = 1) =>
  impact > 0 ? `｜滑点 ${fmtRate(impact, 2)}${count > 1 ? ` · ${count} 笔` : ''}` : '';

/**
 * 一次 OTC 成交的溢价（P2-B 修订 · §15.3）。
 * **复用同一个 `dailySigma`** —— 不需要第二套「市场有多慌」的度量，它本来就是现成的。
 * ⚠️ 取「**此刻**」而不是开仓时的：卖出面对的是当时的流动性，不是当初的（§15.3 ⑤）。
 * ⚠️ v19 起多一个 `notional`：大宗台的报价随**单笔规模**变宽（`OTC.sizeP` / `sizeCap`）。
 */
const otcPremiumFor = (s, sym, notional) => otcPremiumOf(dailySigma(sym, s.i), timeOf(s), notional);

/**
 * 日志里的价格走 `fmtLogPrice`（本轮 ②）—— `≥ $1` 固定 1 位小数、`< $1` 保留有效数字。
 * 原来这里有个 `showPrice`（取 8 位有效数字抹浮点尾噪），已随本轮删除：`toFixed` 本来就不带尾噪。
 */

/* ───────────────────────────── 交易动作 ───────────────────────────── */

/**
 * 这笔开仓是不是**现货**（U1 · ROADMAP §21.4；v9 · §15.6 N2/N4 改判）——
 * 开仓那一刻算一次，写进仓位后**固定不变**。
 *
 * 规则（两件事，与 `side` / `lev` 无关）：
 *   - **OTC 通道恒为现货**（§15.3：私下一口价买现货，与模式无关）；
 *   - 否则**只看模式**：`'spot'` ⇒ 现货、`'fut'` ⇒ 合约。
 *
 * ⚠️ 改动前它还要附加「1x 做多」这两个条件（`s.mode === 'spot' && side === 'long' && lev === 1`），
 *    §15.6 N2 起**现货也带杠杆与做空** ⇒ 那两条整条作废 ——
 *    Bitfinex 2013 年开的 3.3x 空单从此是**现货融资**（不付资金费、但照样有强平线），不是合约。
 */
const spotOf = (s, otc) => !!otc || s.mode !== 'fut';

/** 本单走哪张杠杆表（§15.1 的两张表）：合约走 `'fut'`，其余一律走 `'spot'`（现货融资）。
 *  ⚠️ 导出给 `main.js` 那枚杠杆键用（§15.6）—— 两处各写一遍迟早会不一致。 */
export const levKind = s => (s.mode === 'fut' ? 'fut' : 'spot');

/**
 * 同币加仓的**兼容性闸门**（v13 · B4 / 方案 §5.2）—— `openTrade` 在**下单那一刻**过这道闸。
 *
 * 四项各给一句明确文案，不静默失败：
 *   · 反方向 ⇒ 引导玩家自己「先平仓」（不替他反手：反手是一笔新仓，该由他决定）
 *   · 性质不同（现货 / 合约）⇒ 两张杠杆表、两种费率，混在一条仓里算不出强平价
 *   · 通道不同（盘口 / OTC）⇒ 成交价口径不同，且 OTC 恒 1x
 *   · 杠杆不同 ⇒ 加权均价对两种杠杆没有意义（D4 已拍板）
 *
 * @returns {string|null} 拒绝理由；`null` = 放行
 */
function posGate(s, sym, side, spotOrder, otc, lev) {
  const prev = posOf(s, sym);
  if (!prev) return null;
  if (prev.side !== side) return `${sym} 已有${prev.side === 'long' ? '多' : '空'}单 ｜ 反手请先平仓`;
  if (isSpot(prev) !== spotOrder) return `${sym} 已有${isSpot(prev) ? '现货' : '合约'}仓 ｜ 加仓请先切回同一模式`;
  if (!!prev.otc !== otc) return `${sym} 已有${prev.otc ? 'OTC' : '盘口'}仓 ｜ 加仓请先切回同一通道`;
  if (prev.lev !== lev) return `${sym} 已持 ${prev.lev}x ｜ 加仓必须同杠杆 ｜ 先平仓再重开`;
  return null;
}

/**
 * **落账**：新开一条仓位，或并进同币已有仓位（v13 · B4 / 方案 §5.1）。
 *
 * `entry` 走 **`size` 加权平均**：
 *     entry = (entry×size + fill×addSize) / (size + addSize)
 * ⇒ 强平价、未实现盈亏、资金费全都自动落在「一条加权后的仓位」上，不需要任何额外分支。
 *
 * ⚠️ **运算顺序一字不改**：这段自 v13 起逐字同源 —— 别为了「顺手」改它的写法。
 * ⚠️ `openFee` **累加**（各收各的，不重算）：平仓时要报「本回合两笔之和」（见 `closeTrade`）。
 * ⚠️ `mix` **两格各自累加**：平仓按合计比例退回，等价于两笔各按原比例退。
 * ⚠️ `pos.i` 不更新：它是「这条仓位什么时候开的」，加仓不改出生时刻。
 */
function applyFill(s, { sym, side, fill, margin, notional, lev, feeRate, spot, fee, mix, otc = false }) {
  const prev = posOf(s, sym);
  let pos = prev;
  if (pos) {
    const addSize = notional / fill;
    pos.entry = (pos.entry * pos.size + fill * addSize) / (pos.size + addSize);
    pos.size += addSize;
    pos.notional += notional;
    pos.margin += margin;
    pos.openFee += fee;
    pos.mix = { usd: pos.mix.usd + mix.usd, usdt: pos.mix.usdt + mix.usdt };
  } else {
    pos = openPosition(sym, side, fill, margin, lev, feeRate, spot);
    pos.i = s.i;
    pos.ex = s.ex;                    // 仓位挂在哪家所 —— 归零事件据此精确作废（GDD §7.2）
    pos.openFee = fee;
    pos.mix = mix;                    // 保证金的两格构成（v13）—— 平仓原路退回
    if (otc) pos.otc = true;          // 只给 OTC 仓位打标（`capturedOf` 见到它就跳过）
    s.positions[sym] = pos;
  }
  return pos;
}

/**
 * **下单校验**（§73.9 · 2026-10-02）—— 纯判据，**一个字节的状态都不改**。
 *
 * `openTrade` 与渲染层的 `canOpenAt` 读的是**同一个函数**：按钮该不该置灰、这一下点下去会不会
 * 失败，两处不可能各算一遍（与 `hasFinancingAt` 三处同源同一纪律）。
 * 所以凡是「这一单开不出来」的判据都必须落在这里，落账（`debit` / `applyFill`）一律留在 `openTrade`。
 *
 * @param {number} frac 「用掉多少可用保证金」—— 操作区那 1/4 · 1/2 · 全部。
 * @returns {{ok:false, why:string}
 *   | {ok:true, lev:number, kind:'spot'|'fut', feeRate:number, mustUsdt:boolean, prev:object|null,
 *      otc:boolean, isSpotOrder:boolean, margin:number, fee:number, notional:number, cost:number, fill:number}}
 */
function openCheck(s, side, frac = 1) {
  if (s.over) return { ok: false, why: '本局已结束' };

  /* 停机维护（B24）：窗口内**只平不开** —— 平仓是逃生通道，不许被维护挡住（2020-03-13 那种暴跌里
     真被挡住的玩家就是这么绝望的，但本作不打算把「无法平仓」也一起复刻成必然爆仓）。
     ⚠️ 只拦开仓，`closeTrade` 一个字都不动。 */
  if (haltedAt(timeOf(s), s.ex)) {
    return { ok: false, why: `${exchangeOf(s.ex)?.name ?? s.ex} 维护中 ｜ 暂时不能开仓` };
  }

  /* 通道（P2-B3 · §15.3）：OTC 是**现货大宗**，没有做空这一说（空头要借币、要维持保证金，
     都不是「私下一口价买现货」能承接的）。 */
  const otc = chanOf(s) === 'otc';
  if (otc && side === 'short') return { ok: false, why: 'OTC 通道只有现货，不能做空' };

  /* 现货做空要先**借到币**（v10 · 史实口径）：该所此刻没有融资市场就借不到 ⇒ 空单无从谈起。
     判据是 `hasFinancingAt`（＝现货表上限 > 1）—— Mt.Gox / BitMEX 现货 / 2019-07 前的 Binance
     只有 1x，也就是「用自己的钱买币」，没有任何出借方。
     ⚠️ 只拦**开仓**：已在场的仓位照常持有，平仓也不受影响（否则旧档里那张空单会被关在里面）。
     ⚠️ 也**因此**根除了「1x 现货空单没有强平线」：那种仓位从源头就开不出来了。 */
  if (side === 'short' && spotOf(s, otc) && !hasFinancingAt(timeOf(s), s.ex)) {
    return { ok: false, why: '现货做空 暂不可用 ｜ 该所此刻没有融资业务' };
  }

  const coin = coinOf(s.sym);
  if (!coin || !isLoaded(s.sym)) return { ok: false, why: '行情还没加载完' };
  if (timeOf(s) < coin.unlock) return { ok: false, why: `${s.sym} 还没上线` };

  const price = markPrice(s, s.sym);
  if (!(price > 0)) return { ok: false, why: '当前没有可成交的价格' };

  // 杠杆上限与费率都取**玩家当前所在的交易所**（GDD §7.1）。OTC 一律 1x（= 现货）
  const lev = otc ? 1 : Math.max(1, Math.min(s.lev, maxLeverageAt(timeOf(s), s.ex, levKind(s))));
  /* 费率是**两张表**（v12 · 方案 §11.3）：这一单走 `spot` 还是 `fut` 由**它自己的性质**定
     （`spotOf` 只看模式 / OTC），与玩家此刻翻到哪一页无关 —— 否则切个页面就能换费率。 */
  const isSpotOrder = spotOf(s, otc);
  /* ⚠️ `kind` 一处算好、三处共用（费率 / 30 天量 / 记量柱）—— v20 起这三者必须同源，
     否则会出现「按合约费率收钱、却把量记到现货账上」这种自相矛盾。 */
  const kind = isSpotOrder ? 'spot' : 'fut';
  /* 费率带上这家所**近 30 天、这一条产品线**的成交量（v19 · 阶梯手续费）：巨鲸买单便宜、散户落在首档。
     ⚠️ 取的是**本笔之前**的量 —— 这一笔自己不该把自己打进下一档。 */
  const feeRate = feeRateOf(s.ex, timeOf(s), kind, vol30Of(s, s.ex, s.i, kind));
  /* 这一单能动用多少钱（v13 · 方案 §9.2 ②）：**合约只认 USDT**（USDT 本位永续，
     保证金必须是 U），现货 / OTC 是两格之和（扣的时候先扣 U、不足补美元）。
     所以 2013 年那 $1,000 美元可以买现货，但要玩合约得先在资产页「买 U」。 */
  const mustUsdt = !isSpotOrder;
  const cash = spendableOf(s, mustUsdt);

  /* ── 同币加仓的兼容性闸门（v13 · B4 / 方案 §5.2）──
     这一单若与已有仓位冲突，**必须在动账之前**拒绝（下面一旦 `debit`，钱就已经扣了）。
     四项判据集中在 `posGate` 里（与渲染层同源，三处不各算一遍）。 */
  const prev = posOf(s, s.sym);
  const gate = posGate(s, s.sym, side, isSpotOrder, otc, lev);
  if (gate) return { ok: false, why: gate };

  // 保证金 = 可用余额 × frac；开仓费按名义价值另收，所以要让「保证金 + 费 ≤ 余额」
  let margin = cash * Math.max(0.0001, Math.min(1, frac));
  const feeOf = m => m * lev * feeRate;
  if (margin + feeOf(margin) > cash) margin = cash / (1 + lev * feeRate);
  const fee = feeOf(margin);
  if (!(margin > 0) || margin + fee > cash + 1e-9) {
    return { ok: false, why: mustUsdt ? '合约保证金必须是 USDT ｜ 先在资产页把美元换成 U' : '可用保证金不足' };
  }
  /* 单笔最小名义（2026-09-30 建闸 · 2026-10-01 丙案改按「所 × 产品 × 年代」取值）：
     余额只剩浮点残值时上面那条**拦不住**（`margin > 0` 恒真），会建出一张点不掉的幽灵持仓。
     `MIN_NOTIONAL`（$1）降级为**浮点保底**，真实门槛走 `config.minNotionalAt` ——
     产品口径与费率**同源**（都用这一单自己的 `isSpotOrder`），所以切页面换不出不同的门槛。 */
  const minNotional = Math.max(MIN_NOTIONAL, minNotionalAt(s.ex, timeOf(s), isSpotOrder ? 'spot' : 'fut'));
  if (!(margin * lev >= minNotional)) {
    return { ok: false, why: `下单金额太小 ｜ 单笔名义需 ≥ ${fmtMoneyShort(minNotional)}` };
  }

  /* OTC 的门槛（§15.3）：单笔名义 ≥ $100 万。锁定 1x ⇒ 名义 = 保证金。
     ⚠️ 门槛只卡**买入**，不卡平仓 —— 卡平仓会把玩家困在一条「币价跌下来、名义已不足 $100 万」的仓位上。 */
  if (otc && margin < OTC.min) return { ok: false, why: `OTC 单笔最少 ${fmtMoney(OTC.min)}` };

  /* 成交价（P2-B1 / P2-B3）：盘口价 ± 代价 —— 买抬、卖压，**永远对玩家不利**。
     代价有两种，同一时刻只有一种成立：盘口是平方根冲击、OTC 是「基准点差 × 市况倍数」（不吃滑点）。
     ⚠️ 保证金与开仓费都不受它影响（那两项按名义价值算，与成交价无关），
        受影响的是 `size`：买贵了就拿到的币少一点，这才是代价的真实形态。 */
  const notional = margin * lev;
  const cost = otc ? otcPremiumFor(s, s.sym, notional) : impactFor(s, s.sym, s.i, notional);
  const fill = fillPrice(price, side === 'long' ? 1 : -1, cost);

  /* 供应量上限（P2-B2 · §15.1 / §15.4）：买入会从市场里锁走一部分币，锁走的枚数不得越界。
     ⚠️ 校验必须排在**动账之前** —— 下面那几行一旦执行，钱已经扣了，这时再拒绝就没法干净地退回。
     ⚠️ 只有多头方向消耗供应量（空头没把币拿走）；**OTC 买入不算**（对手方私下一口价，
        不从市场拿走流通量），所以这里直接跳过 —— 落点就是下面那句 `pos.otc = true`。
     闸门 = 占比 × 当年真实流通量（`supplyCapOf`），整局不会触发 ⇒ **不为它新增终局**（GDD §16 只有两种收场）。 */
  const cap = supplyCapOf(s.sym, s.i);
  if (!otc && side === 'long' && capturedOf(s, s.sym) + margin * lev / fill > cap) {
    return { ok: false, why: `${s.sym} 已触及供应量上限，无法继续买入` };
  }

  return { ok: true, lev, kind, feeRate, mustUsdt, prev, otc, isSpotOrder, margin, fee, notional, cost, fill };
}

/**
 * 渲染层用的**纯判据**（§73.9）：这一单此刻开不开得出来 —— 与 `openTrade` 同源，只是不落账。
 * 金额档 `1/4` `1/2` `全仓` 的置灰就读它。
 */
export const canOpenAt = (s, side, frac = 1) => openCheck(s, side, frac).ok;

/**
 * 按比例下单（落账）。`frac` 是「用掉多少可用保证金」，对应操作区的 1/4 · 1/2 · 全部。
 *
 * 多仓（2026-09-28）：**同一个币只许一条仓位**，不同币可以同时持有（BTC 多 + ETH 空）。
 * 保证金一律从**当前所**的余额里出，各仓位互不担保（逐仓）。
 *
 * **同币加仓（v13 · B4 / 方案 §5）**：同一枚币已有仓位时，同向的这一单**并进那条仓位**
 * （不新开第二条、不引入仓位槽 —— 「每币一条」这条不变量撑着 `posOf` / 持仓条 / 强平线 / 存档）。
 * 兼容性判据集中在 `openCheck` 里，反手一律拒绝、由玩家自己决定先平哪一边。
 * @returns {{ok:boolean, why?:string}}
 */
export function openTrade(s, side, frac = 1) {
  const c = openCheck(s, side, frac);
  if (!c.ok) return { ok: false, why: c.why };
  const { lev, kind, feeRate, mustUsdt, prev, otc, isSpotOrder, margin, fee, notional, cost, fill } = c;

  /* 扣账（v13）：`debit` **先扣 USDT、不足补 USD**（合约只认 USDT），并返回两格各扣了多少 ——
     那个 `mix` 就是「原路退回」的凭据，平仓时按同比例还回两格（见 `state.credit`）。
     ⚠️ 校验已在上面的 `margin + fee > cash` 拦过一次，这里返回 `null` 属兜底（理论不可达）。 */
  const mix = debit(s, margin + fee, mustUsdt);
  if (!mix) return { ok: false, why: mustUsdt ? '合约保证金必须是 USDT ｜ 先在资产页把美元换成 U' : '可用保证金不足' };
  /* ⚠️ 开仓费是**玩家真实付出的钱**，必须同时记进「已实现」（Batch 5 · B23）——
     原来只从余额里扣、不写 `realized`，于是 HUD 副行那个数既不等于真实现金变动、
     也不等于已实现盈亏。它只被 `render.js` 读来展示，不参与任何玩法判定。 */
  s.realized -= fee;
  s.lev = lev;

  const spot = isSpotOrder;
  /* ── 落账（新开 or 并进已有仓位）── */
  const pos = applyFill(s, {
    sym: s.sym, side, fill, margin, notional, lev, feeRate, spot, fee, mix, otc,
  });

  /* 笔数（C8-B1）：同一份代价，报出它相当于拆成了几笔。OTC 是私下一口价、不吃滑点 ⇒ 不报。 */
  const fills = otc ? 1 : bookFills(notional / hourLiqOf(s, s.sym, s.i), cost);
  const tag = otc ? `｜OTC 溢价 ${fmtRate(cost, 2)}` : slipTag(cost, fills);
  /* 字面跟着模式走（v9 · §15.6 N4「没有的选项不显示」的同一条口径）：现货模式的操作键是
     **买入 / 卖出**，日志若还写「做多 / 做空」，就与玩家刚按下的那枚键对不上了。 */
  const verb = spot ? (side === 'long' ? '买入' : '卖出') : (side === 'long' ? '做多' : '做空');
  /* 手续费必须**写进日志**（本轮 ② · 用户拍板）：它已经真的从余额里扣掉了（上面那两行），
     玩家却只看到「保证金 $1,000.0」——账对不上。`fee` 就是本笔按名义价值收的那一次。
     ★ 加仓（B4）：字面换成「加仓 ＋ 追加保证金」，并补一个**加权后的均价** ——
       否则玩家只能看到「这笔按 $13.5 成的」，看不到自己整条仓位现在的成本在哪。 */
  const qty = notional / fill;                 // 本次成交拿到的币量（加仓时是这一笔的量）
  /* 三类表述（用户 2026-10-01，两轮拍板）：
     · **普通现货**（现货 1x）：**不写 `1x`** —— 它没有「倍数」这回事，写了反而与前两类混同；
       币量**提到最前** ⇒「买入 N 枚 SYM｜花费 $X」，正文就不再重复币量；
     · **杠杆现货 / 合约**：带倍数，正文报「保证金 ＋ 名义」（币量不参与结算，玩家也不看它）。 */
  const plainSpot = spot && lev === 1;
  const head = plainSpot
    ? `${prev ? '加仓' : verb} ${fmtQty(qty)} 枚 ${s.sym}`
    : (prev ? `加仓 ${s.sym} ${lev}x` : `${verb} ${s.sym} ${lev}x`);
  const line = plainSpot
    ? `${prev ? '追加' : '花费'} ${fmtMoneyShort(margin)}`
    : `${prev ? '追加保证金' : '保证金'} ${fmtMoneyShort(margin)} · 名义 ${fmtMoneyShort(notional)}`;
  const avg = prev ? `｜均价 ${fmtLogPrice(pos.entry)}` : '';
  pushLog(s, `${head}｜${line} @ ${fmtLogPrice(fill)}${avg}｜手续费 ${fmtMoneyShort(fee)}${tag}`,
    side === 'long' ? 'long' : 'short');

  /* 订单冲击（方案 §2.6）：把这一笔的行情位移（`permImpactFor`，**无阈值死区**）沉淀成台阶
     —— 从此处起价格上/下一个台阶，再按 §73.3 的三段曲线（永久 ＋ 慢幂律 ＋ 快回）缓慢修复。
     ⚠️ 位移量走 `permImpactFor` 而**不是** `cost`：`cost` 带 10% 死区（成交代价用了它），
        拿它做位移会让小额单写进 0、池子里毫无痕迹 —— 见 `permImpactFor` 的注释。
     ⚠️ `SHOCK.share` 已由用户 2026-10-01 标定为 1：整笔位移都留在场上。
     ⚠️ **开仓 / 加仓按满额写**（`pushFlow` 的 `give` 缺省 1）；只有平仓那一侧才回吐
        `SHOCK.closeGive`（2026-10-02）—— 不对称只挂在「回吐」上。
     ⚠️ OTC 不写：私下一口价的大宗交易不落公开盘口（与它不消耗供应量同一口径）。
     ⚠️ 与上帝模式**无关**（2026-09-29 瘦身）：原来这里乘过一个「冲击倍率」`s.god.mult`，
        已删除 —— 上帝模式不再有任何价格能力。
     ⚠️ **永远是开的**（2026-10-01 用户拍板）：设置页那枚「订单冲击」开关已删除，`s.impactOn`
        字段一并删掉 —— 它不再是选项，而是基础玩法的一部分。 */
  if (!otc) {
    const dir = side === 'long' ? 1 : -1;
    pushFlow(s, s.sym, dir, notional, 1, shockKindOf(isSpotOrder, lev));
    /* 玩家自己的成交量（v17 · 2026-10-01）：这一笔从此在量柱上看得见，
       也进这家所**这条产品线**的 30 天量（v19 按所 / v20 按产品线 / v24 按币） */
    addPlayerVol(s, s.sym, notional, s.ex, kind);
    /* 瞬时深度池（L1 · 2026-10-01）：这一笔吃掉的深度从池子里扣 —— 连点买入的边际难度递增。
       与上面 `addFlow` 同步过滤 OTC（此处就在 `!otc` 分支内）。 */
    consumePool(s, s.sym, notional);
  }
  /* 持仓抛压折价（v18 · 2026-10-01）：这一单若**加厚了现货实物多头**，市场对你的忌惮随之变重。
     合约 / OTC 不改变 `capturedOf` ⇒ 值没变时函数内部自己会跳过（不写、不冲 σ 缓存）。 */
  refreshOverhang(s, s.sym);
  /* 交易统计（v21）—— 只喂 M2 的「交易档案」与 M3 的「称号」，不参与任何判定。
     ⚠️ 记在**成功落账之后**：被闸门拦下 / 资金不足 / 低于最小名义的那些单不算一笔。 */
  s.stat.open += 1;
  if (spot) s.stat.spot += 1; else s.stat.fut += 1;
  if (lev > s.stat.maxLev) s.stat.maxLev = lev;
  s.stat.syms[s.sym] = true;
  return { ok: true };
}

/**
 * 平仓 —— 平掉**当前所选币**的仓位（与持仓条只显示当前币同一口径）。
 * 多仓下想平另一个币：先切到那个币的 Tab，再点平仓。
 */
export function closeTrade(s, why = '手动') {
  const sym = s.sym;
  const pos = posOf(s, sym);
  if (!pos) return { ok: false, why: `${sym} 没有持仓` };

  const price = markPrice(s, sym);
  if (!(price > 0)) return { ok: false, why: '当前没有可成交的价格' };

  /* OTC 通道**只平现货**（1x 做多）—— 杠杆仓一律走盘口（§15.3 的通道语义）。
     反过来没有任何限制：**盘口可以平任何仓位**，包括 OTC 买来的现货 ——
     所以 OTC 买入的仓位永远不会「只能用它自己的通道才能出手」。 */
  const otc = chanOf(s) === 'otc';
  if (otc && !isSpot(pos)) return { ok: false, why: 'OTC 只能平现货，杠杆仓请走盘口' };

  /* 成交价（P2-B1 / P2-B3）：**平多是卖、平空是买**，所以方向与开仓时相反 ——
     代价永远对玩家不利：卖掉打点折、买回抬点价。本次成交名义 = 整条仓位（一次性平完）。 */
  const notional = pos.size * price;
  const cost = otc ? otcPremiumFor(s, sym, notional) : impactFor(s, sym, s.i, notional);
  const fill = fillPrice(price, pos.side === 'long' ? -1 : 1, cost);

  /* 平仓费走**开仓时那张表**（v12 · §11.3）：判据是仓位自己的 `isSpot`，
     不是玩家此刻的模式 —— 现货仓平仓不该按合约费率收，反之亦然。 */
  const pk = isSpot(pos) ? 'spot' : 'fut';       // 仓位自己的产品线（v20）：费率与 30 天量同源
  /* 冲击形态品种（§73.6）与上面那条**产品线**不是一回事：现货保证金杠杆走现货通道、按现货费率，
     但它是「有杠杆盘」的合成盘，冲击形态与级联都按合约那一档 —— 见 `shockKindOf`。 */
  const sk = shockKindOf(isSpot(pos), pos.lev);
  const r = closePosition(pos, fill, feeRateOf(pos.ex, timeOf(s), pk, vol30Of(s, pos.ex, s.i, pk)));
  /* 平仓款**按 `pos.mix` 同比例退回两格**（v13 · 方案 §9.2 ③）——
     2013 年用美元开的仓，平掉回的还是美元：否则 Mt.Gox 会凭空空降一笔 USDT。 */
  credit(s, pos.ex, r.net, pos.mix);
  s.realized += r.pnl - r.fee;
  /* 交易统计（v21）：按**回合净额**（毛盈亏 − 开仓费 − 平仓费）分胜负 —— 与日志里报的
     「净额」同一口径，所以玩家看到的「盈利」与档案里的「盈利笔数」对得上。 */
  if (r.pnl - (pos.openFee ?? 0) - r.fee > 0) s.stat.win += 1; else s.stat.loss += 1;
  const fills = otc ? 1 : bookFills(notional / hourLiqOf(s, sym, s.i), cost);   // 笔数（C8-B1，同开仓口径）
  /* 玩家自己的成交量（v17 · 2026-10-01）：平仓同样是成交 ⇒ 记进当根 K 线的量柱。
     OTC 不落公开盘口（与「不写冲击池」同一先例）⇒ 不计。 */
  if (!otc) addPlayerVol(s, sym, notional, pos.ex, pk);
  const tag = otc ? `｜OTC 溢价 ${fmtRate(cost, 2)}` : slipTag(cost, fills);
  /* 盈亏 ＋ 手续费（本轮 ② · 用户拍板）：
     - **回合净额** = 毛盈亏 − 开仓费 − 平仓费。开仓费在开仓那一刻已经从余额扣过一次
       （`s.realized -= fee`），这里若只报毛盈亏，玩家看到的「盈利」会比自己钱包里多出来的钱大。
     - **手续费**报的是**本回合两笔之和**（开 ＋ 平），与「净额 = 毛额 − 这条手续费」对得上。
     ⚠️ `s.realized` 本来就是净口径（开仓扣一次、这里再加 `pnl − fee`），这两行只是把显示补齐，
        账目一个字没动。 */
  const fees = (pos.openFee ?? 0) + r.fee;
  const net = r.pnl - fees;
  /* 盈亏串前那枚 ▲/▼ 是**色盲第二通道**（B6-c · §7.6 的第四处）：日志正文本来就整段按
     `ok` / `bad` 上色，红绿色盲读不出「盈利」与「亏损」的色差 —— 符号是同一件事的形状版。
     它是纯文本（core 不认识 UI，不挂 `.sign` 伪元素），与「盈利 / 亏损」两个字面并存。 */
  pushLog(s, `平仓 ${sym} ${pos.lev}x｜${net >= 0 ? '盈利 ▲' : '亏损 ▼'} ${fmtMoneyShort(net)} · ${why}｜手续费 ${fmtMoneyShort(fees)}${tag}`,
    net >= 0 ? 'ok' : 'bad');
  delete s.positions[sym];

  /* 订单冲击：平仓写一笔**方向相反**的台阶（用户 2026-10-01 拍板），但**只回吐
     `SHOCK.closeGive`**（2026-10-02 拍板）。
     公式与 `openTrade` 同一个：位移量 = `SHOCK.share × 本笔行情位移量`（`permImpactFor`，**无阈值死区**），
     方向取**持仓方向的反面** —— 平多 = 卖出 ⇒ 打压（−1），平空 = 买回 ⇒ 推高（+1）。
     ⚠️ 为什么不再写满额：等量反向会让**往返净值恒等于 0** ⇒ 右侧最新价永远回到原始路径 ⇒
        玩家长单/短线做完一圈，图上一点痕迹都不剩（用户 2026-10-02 反馈的「完全没有记忆」）。
        文献里 metaorder 的冲击在成交结束后按 `t^(−0.3)` 极慢衰减、交易者自己的反向操作抹不掉
        市场已形成的新参考价 ⇒ 平仓只回吐 35%，**一次完整往返净留开仓冲击的 55.25%**。
     ⚠️ 它**不是**早先那个 A2「回填」（`giveBack`：平仓时反向写回开仓残存值的一半，已删除）——
        那个会把开仓留下的台阶主动推回去，与「台阶永久保留」冲突；这里写的仍是**平仓这一笔自己**
        该有的冲击，只是按 `closeGive` 折了一档。
     ⚠️ 与开仓同口径：OTC 不写（私下一口价不落公开盘口，与它不计量柱同一个先例）；
        写完必须 `invalidateSigma()` —— 平仓从此**会**改动它之后的 K 线。 */
  if (!otc) {
    const dir = pos.side === 'long' ? -1 : 1;
    pushFlow(s, sym, dir, notional, SHOCK.closeGive, sk);
    consumePool(s, sym, notional);        // 瞬时深度池（L1）：平仓同样是真实成交 ⇒ 也吃深度
  }
  /* 持仓抛压折价（v18 · 2026-10-01）：这一条仓位没了（`delete` 在上面）⇒ 折价随之释放。
     ⚠️ **只释放 `SHOCK.closeGive`**（v25 · 2026-10-02）：与上面那一笔回吐同一个比例，
        否则折价一次性归零会让「卖出之后比持仓时更贵」（见 `refreshOverhang` 的疤痕注释）。
     走上一步的**只有现货实物多头** —— 平掉一张合约仓时 `capturedOf` 本来就没变，函数内部会跳过。 */
  refreshOverhang(s, sym, SHOCK.closeGive);

  if (checkRuin(s)) return { ok: false, why: s.over.reason };
  return { ok: true };
}

/**
 * 强平单个仓位。触发条件是**当根 K 线的高/低**打穿强平价。
 *
 * **结算口径（B20 · 2026-09-30 拍板「甲案」）**：不再是「保证金全部损失」，而是
 *   残余权益 = `维持保证金率 × 名义`（＝触发那一刻账上还剩的那一点）
 *   清算费   = `名义 × LIQ.fee`（0.5%，**合成值**，无一手出处 ⇒ GDD 声明）
 *   **返还** = `max(0, 残余权益 − 清算费)`，按 `pos.mix` 比例打回该所账本
 * ⇒ 默认档（0.5% 维持线）下两者相等、返还为 0，**与 v13 逐位相同**；
 *   只有 B18 的高名义档（1% / 2.5%）与 margin 的 15% 档才会真的退还一点。
 * 账户其余部分原样保留 —— 多仓下它**不再直接等于破产**，是否收摊由调用方看总权益决定。
 * ⚠️ 返还**不产生负债**：清算费最多把残余权益吃到 0，绝不会向玩家追缴。
 * @param {number} atPrice 成交价（S3 起 ＝ **第一次穿越强平价那一 tick 的价**，不再是强平价本身）
 */
function forceLiquidate(s, pos, atPrice) {
  const remain = maintRateOf(pos) * pos.notional;     // 触发时的残余权益（＝维持保证金那一格）
  const back = Math.max(0, remain - pos.notional * LIQ.fee);
  const notional = pos.size * atPrice;                // 实际成交名义（强平价上的那笔量）
  /* 玩家自己的成交量（v17 · 2026-10-01）：强平也是一笔真实成交 ⇒ 记进当根 K 线的量柱。
     取 `size × atPrice`，与 `closeTrade` 同口径；产品线取**仓位自己**的那条（v20）。 */
  addPlayerVol(s, pos.sym, notional, pos.ex, isSpot(pos) ? 'spot' : 'fut');
  /* 订单冲击（2026-10-01 拍板）：强平同样是**卖出 / 买回**，写一笔与开仓方向相反的台阶 ——
     与 `closeTrade` 完全同一公式、同一方向（平多打压 −1、平空推高 +1），且同样**只回吐
     `SHOCK.closeGive`**（2026-10-02）：强平是「被动平仓」，若按满额反向写，玩家爆一次仓就能把
     自己此前所有买入留下的台阶一次性抹平。
     ⚠️ 强平多发生在**急跌那根**，这笔反向冲击会让兵败如山倒的 K 线更陡一档，是刻意的。 */
  {
    const dir = pos.side === 'long' ? -1 : 1;
    pushFlow(s, pos.sym, dir, notional, SHOCK.closeGive, shockKindOf(isSpot(pos), pos.lev));
    consumePool(s, pos.sym, notional);    // 瞬时深度池（L1）：强平也是真实成交 ⇒ 也吃深度
  }

  /* 串形与开仓 / 平仓对齐（2026-09-29）：`｜` 两侧不留白、金额走 `fmtMoneyShort`、
     价格走 `fmtLogPrice`（本轮 ② —— 原来这里是 `showPrice`，现在统一 ≥$1 一位小数）。
     ⚠️ 返还 > 0 时不能再说「全部损失」（B20）：那一格日志条是一行 nowrap，字数要省，
        所以只在真的有退款时才多带一段。 */
  pushLog(s, back > 1e-9
    ? `爆仓 ${pos.sym} ${pos.lev}x｜保证金 ${fmtMoneyShort(pos.margin)}｜退回 ${fmtMoneyShort(back)} @ ${fmtLogPrice(atPrice)}`
    : `爆仓 ${pos.sym} ${pos.lev}x｜保证金 ${fmtMoneyShort(pos.margin)} 全部损失 @ ${fmtLogPrice(atPrice)}`,
    'bad');

  if (back > 1e-9) credit(s, pos.ex, back, pos.mix);   // 退回**当初开仓那家所**（原路：按 mix 比例分两格）
  s.realized -= pos.margin - back;                     // 真实现金变动 = 丢掉保证金、收回退款
  s.stat.liq += 1;                                     // 统计（v21）：逐步强平与整条强平都各算一笔
  delete s.positions[pos.sym];
  refreshOverhang(s, pos.sym, SHOCK.closeGive);   // v25：爆掉的现货实物多头同 `closeGive` 比例释放折价
}

/**
 * 把这一局写进**交易档案**（M2 · 2026-10-01）。
 *
 * ⚠️ **幂等**：由 `endGame` 用 `!s.over` 把门 —— 本局只写一条。`rewindTo`（上帝跳日期）
 *    会把 `s.over` 清回 `null`，所以「结束 → 回退 → 再结束」会各写一条，这是对的：
 *    那是两次不同的结局，档案本来就该各记一笔。
 * ⚠️ 记录是**自洽的**（把展示要用的数都摊平存进去）—— 档案页因此不必回头翻那一局的存档，
 *    而存档在重开时已经没了。
 */
function recordCareer(s, reason) {
  let peak = equity(s);
  for (const v of s.eq) if (v > peak) peak = v;
  addCareer({
    scen: s.scen,
    reason,
    start: GAME.start + s.day0 * 24 * HOUR_MS,
    end: timeOf(s),
    days: Math.max(1, Math.round((s.i - s.day0 * 24) / 24)),
    cash0: s.cash0,
    final: equity(s),
    peak,
    realized: s.realized,
    open: s.stat.open, win: s.stat.win, loss: s.stat.loss, liq: s.stat.liq,
    spot: s.stat.spot, fut: s.stat.fut, maxLev: s.stat.maxLev,
    move: s.stat.move, god: s.stat.god, loan: s.stat.loan,
    syms: Object.keys(s.stat.syms),
    /* M4：抽稀后的资金曲线（首尾必留）—— 分享卡拿它画那条线。 */
    eq: thinEq(s.eq),
  });
}

function endGame(s, reason) {
  /* 交易档案（M2）：**本局只写一条** —— `s.over` 空着的时候才写，写完它才有值。 */
  if (!s.over) recordCareer(s, reason);
  s.over = { reason, at: s.i };
  s.paused = true;
  /* 结算文案的日期跟着**本局自己的终点**走（§73.7）：挑战局 2–4 个月就收摊，
     再写死「2024-12-31」会与玩家刚经历的那一个月完全对不上。 */
  const text = reason === OVER.SETTLED
    ? `活到了 ${fmtDate(GAME.start + (s.endI - 1) * HOUR_MS, false)}，结算`
    : reason === OVER.GAVEUP ? '就此收摊 ｜ 本局结束'
    : '账户归零，游戏结束';
  pushLog(s, text, reason === OVER.SETTLED ? 'ok' : 'bad');
  return { ok: false, why: reason };
}

/**
 * 「归零」的**唯一出口**（Batch 5 · B30）—— 原来有 4 处各自 `isBankrupt → endGame`，
 * 现在全部走这里。收成一个口的好处不只是少写几遍：**这条规则以后只会有一个地方要改**。
 *
 * 归零时若本局**还没领过救济金**，不结束本局，而是进「待决态」：时钟停住、弹出遮罩，
 * 等玩家回答「领，还是收摊」。`s.pending` 期间 `s.paused` 为真，时钟自然不再推进。
 *
 * ⚠️ 5 条调用路径（`closeTrade` / `collapseExchange` / `applyHackCut` / `settleFunding` / `liquidateAll`）
 *    一个都不能漏，否则会出现「该结束却没结束」或「该弹遮罩却直接结束」。
 * @returns {boolean} 本局是否就此结束
 */
function checkRuin(s) {
  if (!isBankrupt(s)) return false;

  /* 上帝模式：归零**不结束本局**（方案 §2.5）—— 时钟照走，玩家自己在面板里「填入资金」。
     ⚠️ 提示只写一次（`s.godRuined`），否则每根 K 线都会刷一条一模一样的日志。 */
  if (s.god) {
    if (!s.godRuined) {
      s.godRuined = true;
      pushLog(s, '上帝模式 ｜ 账户归零，不结束本局', 'bad');
    }
    return false;
  }

  /* 挑战模式（年代开局）**不发救济金**（用户 2026-10-01 拍板）—— 归零即终局。
     理由：年代与本金都是玩家自己挑的，再发一笔 $1,000 等于把挑战抹平 ——
     「10u 战神」那一局领一次就是**暴赚 100 倍**，破产反倒成了正收益。
     ⚠️ 必须排在 `s.loaned` 之前：挑战局连遮罩都不弹，直接结束。 */
  if (isChallenge(s.scen)) {
    endGame(s, OVER.LIQUIDATED);
    return true;
  }

  if (!s.loaned) {
    s.pending = 'loan';
    s.paused = true;
    pushLog(s, `账户归零 ｜ 可领 ${fmtMoney(loanAmountAt())} 救济金`, 'bad');
    return false;
  }
  endGame(s, OVER.LIQUIDATED);
  return true;
}

/* ───────────────────────── 买 U（v13 · 方案 §3） ───────────────────────── */

/**
 * 买入 USDT —— **当前所内的 USD → USDT 兑换**（方案 §3.1）。
 *
 * 三条口径：
 *   - **同所内兑换、不过链**：它不产生矿工费、不吃拥堵，秒到账（跨所搬 U 是另一回事，走 rail）；
 *   - **价格走 `usdtPriceAt`**（1 USDT 值多少美元）：纯锚点插值、**双向** ——
 *     大多时候 $1 附近，危机时能买到 0.88（折价，捡便宜），挤兑时 1.05（溢价，吃亏）。
 *     ⚠️ 溢价是**真实史实**，不是惩罚机制；它也是 `equity` 里 USDT 按面值 $1 计的原因
 *        （溢价的账只在**这一刻**结一次，之后不再按市价重估）。
 *   - **只做买入，不做卖出**（LESS IS MORE）：跨所搬 U 已经给了出口，再开一条卖 U
 *     只是把同一件事做两遍。
 *
 * @param {number} frac 用掉多少**美元那一格**（沿用操作区那套 1/4 · 1/2 · 全部）
 * @returns {{ok:boolean, why?:string}}
 */
export function buyUsdt(s, frac = 1) {
  if (s.over) return { ok: false, why: '本局已结束' };
  const t = timeOf(s);
  if (t < USDT_LIVE) return { ok: false, why: '这个年代还没有 USDT' };

  const b = ensureBook(s);
  const usd = b.usd * Math.max(0.0001, Math.min(1, frac));
  if (!(usd > 0)) return { ok: false, why: '当前所没有美元可兑换' };

  const price = usdtPriceAt(t);        // 1 USDT = $price
  const got = usd / price;             // 花掉的美元买到了多少 U
  b.usd -= usd;
  b.usdt += got;
  /* 日志把**汇率**写出来（而不是只报两个金额）：玩家要能看出这一笔是赚了还是亏了 ——
     0.900 时买 U 是捡便宜、1.050 时是挨宰，那正是这个机制的全部意义。 */
  pushLog(s, `买入 USDT ${fmtMoney(got)}｜1 USDT = $${price.toFixed(3)}｜花费 ${fmtMoney(usd)}`, 'info');
  return { ok: true };
}

/* ───────────────────────────── 交易所 ───────────────────────────── */

/**
 * 一次跨所划转的「方案」：走哪条通道、手续费多少、多少根 K 线到账（v12 · 方案 §11.4 / §11.6）。
 *
 * ⚠️ 抽成独立导出是因为**换所确认弹层要显示同一组数** —— 两处各算一遍迟早不一致
 *    （弹层写「3 小时到账」、真扣的却是电汇的 5 天，那是玩家最不能接受的一类 bug）。
 * ⚠️ 纯函数、不读时钟、不写状态：`s.i` / `s.seed` 都在存档里 ⇒ 弹层每帧重算都是同一个数。
 *
 * @param {object} s    当前状态（只读 `s.i` / `s.seed` / `s.ex`）
 * @param {string} toId 目标交易所 id
 * @returns {{rail:object, fee:number, n:number}} 通道定义、手续费、到账所需小时数
 */
export function transferPlan(s, toId) {
  const rail = railAt(timeOf(s));
  const fee = railFeeOf(rail, timeOf(s));
  const from = s.ex;
  /* 金额 = **该格的全部余额**（本作不给玩家填金额）—— 链上到账时间按它分档加确认数
     （`extraConfirmations`），所以这里必须与实际搬走的那一笔同口径：弹层预估与实际到账
     才会是同一组数（`switchExchange` 搬走的正是 `bookOf(s, from)[cur]`）。 */
  const amount = bookOf(s, from)[cashCurAt(timeOf(s))] ?? 0;
  /* `wire` 走**银行电汇**：到账时间由 `hours` 这个固定区间给（不吃拥堵）——
     链堵不堵与银行慢不慢是两件事（方案 §11.6），所以既不调 `arrivalCandles` 也不 `bumpPulse`，
     更不看金额。具体小时数用 `rand` 抽（可复现）：同一份档、同一时刻、同一对交易所，永远同一个数。 */
  const n = rail.hours
    ? rail.hours[0] + Math.floor(rand(s.seed, hashStr(from), s.i, 0, hashStr(toId)) * (rail.hours[1] - rail.hours[0] + 1))
    : arrivalCandles(congestionOf(s), toId, amount);
  /* `extra` = 这笔金额额外加的确认数（`arrivalCandles` 已把它计入 `n`）—— 单独返回给弹层，
     好在「预估到账」那一行下面**只在大额时**补一行说明（小额不加行，不动既有排版）。 */
  const extra = rail.hours ? 0 : extraConfirmations(amount);
  return { rail, fee, n, extra };
}

/**
 * 换所（GDD §7.2）—— P2-A 起**不再是「一键搬钱」**，而是**发起一笔划转**。
 * 五条规矩（第⑤条为 v12 新增）：
 *   ① 钱**离开旧所、等 N 根 K 线才到**（N 由拥堵指数决定，见 `congestion.js`），到账前不能动用
 *   ② **有持仓必须先全部平掉** —— 仓位是挂在这一家所上的，搬不走（多仓也一样，一条都不许留）
 *   ③ **同时只允许一笔在途**（LESS IS MORE）
 *   ④ **人先到、钱后到** —— `s.ex` 立即切到新所（可以看行情、看费率），但 `books[新所]` 要到账才加钱
 *   ⑤ **走哪条通道与手续费由年份自动判定**（v12 · 方案 §11.4），手续费**发起时立即扣**
 *
 * ⚠️ 第⑤条的年代划分（`TRANSFER_RAILS`）：2013-01～2014-11-19 是**银行电汇**（不来链上、
 *    固定 $20 定额费、2–10 天到账、**不吃拥堵**）；2014-11-20 起依次是 Omni / ERC-20 / TRC-20
 *    链上通道（矿工费或 gas，随年代浮动，吃拥堵）。**不给玩家选**（B14 拍板 · LESS IS MORE）：
 *    那四段是「当年就是这么搬钱的」，不是一个可挑的选项。
 *
 * @returns {{ok:boolean, why?:string}}
 */
export function switchExchange(s, id) {
  if (s.over) return { ok: false, why: '本局已结束' };
  if (id === s.ex) return { ok: true };

  const ex = exchangeOf(id);
  if (!ex) return { ok: false, why: '没有这家交易所' };

  const t = timeOf(s);
  if (t < ex.open) return { ok: false, why: `${ex.name} 还没开业` };
  if (ex.close != null && t >= ex.close) return { ok: false, why: `${ex.name} 已经归零` };
  if (heldSyms(s).length) return { ok: false, why: '有持仓，先全部平仓再换所' };
  if (s.transfer) return { ok: false, why: '上一笔转账还没到账' };

  const from = s.ex;
  /* 搬的是**哪一格的钱**由年代定（v13 · 方案 §2.3）：电汇时代搬美元、链上时代搬 U。
     ⚠️ 它和「走哪条通道」是**同一件事的两种说法**（`cashCurAt` 与 `TRANSFER_RAILS` 的分界点
        是同一个 2014-11-20），所以不给玩家选（LESS IS MORE）—— 那年头手上根本没有 U。
     ⚠️ 另一格的钱**留在原所、仍归玩家**（按所分账）：搬不走的不是丢了，回头再换回来就是。 */
  const cur = cashCurAt(t);
  const amount = bookOf(s, from)[cur] ?? 0;
  if (!(amount > 0)) {
    return { ok: false, why: cur === 'usdt' ? '这个年代搬钱走稳定币 ｜ 先在资产页把美元换成 U' : '当前所没有可划转的余额' };
  }

  /* 通道、手续费、到账根数三件一起算（v12 · 方案 §11.4）：走哪条 rail 由**此刻的年份**自动判定。
     手续费**发起时立即扣**（B14 拍板）—— 所以余额不够付这笔费就搬不动，而不是「到了再扣」。
     ⚠️ 必须排在 `bumpPulse` **之前**：口径是「你推高拥堵 ⇒ 你**下一次**转账更慢」（验收口径④），
        本笔转账不能受自己那一脚的影响 —— 否则第一笔在 2013 年就会被自己拖慢，说不通。 */
  const { rail, fee, n } = transferPlan(s, id);
  if (amount <= fee) return { ok: false, why: `余额不足以支付 ${rail.label} 手续费 ${fmtMoneyShort(fee)}` };

  const send = amount - fee;                           // 实际到账的金额（手续费在路上就被收走了）
  s.books[from][cur] = 0;                              // 那一格离开旧所，此后只记在 s.transfer 里
  s.transfer = { amount: send, fee, rail: rail.id, cur, from, to: id, departAt: s.i, arriveAt: s.i + n };
  s.realized -= fee;                                   // 手续费是玩家真实付出的钱，与开/平仓费同一口径
  s.ex = id;                                           // 人已经在新所，钱还在路上
  normalizeLeverage(s);                                // 新所的上限可能更低，夹取一次

  /* 只有**走链**的转账才推高拥堵 —— 银行电汇与链无关，`hours != null` 的就是 wire。 */
  const add = rail.hours ? 0 : bumpPulse(s, send);     // > 当日 BTC 流动性的 10% 才算大额
  const eta = rail.hours ? `${Math.round(n / 24)} 天后到账` : `${n} 小时后到账`;
  pushLog(s, `转账 → ${ex.name}｜${fmtMoneyShort(send)}｜${rail.label} · ${eta}｜手续费 ${fmtMoneyShort(fee)}`
    + (add ? `｜推高拥堵 +${add.toFixed(1)}` : ''), 'info');
  s.stat.move += 1;                                    // 统计（v21）：称号「搬家达人」读它
  return { ok: true };
}

/**
 * 交易所归零。到点那一刻所内余额清零，**挂在该所的仓位全部作废**（保证金全损）。
 * 多仓下只作废 `pos.ex` 等于这家所的那些 —— 挂在别处的仓位不受牵连（虽然换所要求先全平，
 * 所以正常情况下不可能有仓位挂在别处，这个判据是最后一道防线）。
 *
 * ⚠️ **在途的转账不受影响**（P2-A 陷阱②）：那笔钱已经离开 `books`、正躺在链上。
 *    实现上无需额外处理 —— 但**这个效果是刻意的**：Mt.Gox 归零前一根发起转账仍然救得回来，
 *    既是对「提前跑」的奖励，也避免「我都点跑了还被吞」的挫败感。
 * @returns {boolean} 是否因此结束了本局
 */
function collapseExchange(s, ex) {
  const book = bookOf(s, ex.id);
  const lost = book.usd + book.usdt;                   // 两格一起归零（v13）—— 它就是这么倒的
  s.books[ex.id] = blankBook();

  let margin = 0;
  for (const sym of heldSyms(s)) {
    const pos = s.positions[sym];
    if (pos.ex !== ex.id) continue;
    margin += pos.margin;
    delete s.positions[sym];
    refreshOverhang(s, sym);        // v18：被这家所一起带走的现货实物多头，折价随之归零
  }
  if (margin) s.realized -= margin;

  const hit = lost + margin;
  pushLog(s, hit > 0 ? `${ex.name} 归零 ｜ 损失 ${fmtMoney(hit)}` : `${ex.name} 归零`,
    hit > 0 ? 'bad' : 'info');

  return checkRuin(s);
}

/**
 * 交易所**被盗削减**（B21）—— 到点把该所两格余额各 ×(1 − `cut`)，**持仓与其他所一概不动**。
 *
 * 与 `collapseExchange` 的区别是刻意的：那是「整所归零、仓位作废」，这是「**损失社会化**」——
 * 2016-08-02 的 Bitfinex 正是这么处理的（全体账户按 36.067% 普损分摊），
 * 玩家若在那家所有仓位，仓位还在、只是现金少了一截；挂在别处的钱一分不动。
 * @returns {boolean} 是否因此结束了本局
 */
function applyHackCut(s, ex) {
  /* ⚠️ 必须是 `ensureBook`：`bookOf` 在「这所还没去过」时返回**冻结的** `ZERO_BOOK`，
     下面那两行 ×= 会直接抛 `TypeError: Cannot assign to read only property`。
     只要玩家在 2016-08-02 之前没去过 Bitfinex（例如 Mt.Gox 归零后直接搬去 BitMEX），
     到点整个游戏就崩 —— 2026-10-01 平衡性模拟里实测复现。 */
  const book = ensureBook(s, ex.id);
  const lost = (book.usd + book.usdt) * ex.hack.cut;
  book.usd *= 1 - ex.hack.cut;
  book.usdt *= 1 - ex.hack.cut;
  s.realized -= lost;

  pushLog(s, lost > 0
    ? `${ex.name} 被盗 ｜ 普损 ${fmtRate(ex.hack.cut, 3)} 损失 ${fmtMoney(lost)}`
    : `${ex.name} 被盗 ｜ 普损 ${fmtRate(ex.hack.cut, 3)}`,
    lost > 0 ? 'bad' : 'info');

  return checkRuin(s);
}

/* ───────────────────────────── 救济金（B30） ───────────────────────────── */

/**
 * 领下那笔救济金 —— 归零遮罩上的绿键（`data-loan="take"`）。
 * **不用还**（用户 2026-10-01 拍板：原来那套「日息 0.1% × 180 天、到期自动清仓还款、
 * 还不上即债务违约」整体移除）—— 现在就是一笔一次性的救命钱，直接进账。
 * 只允许在**待决态**里调用一次：`s.loaned` 一旦置真，本局再没有第二次机会。
 */
export function takeLoan(s) {
  /* ⚠️ 判**值**不判真值（v11 · ③）：`'warn'`（破产预警遮罩）也是个非空的 `pending`，
     只判 `!s.pending` 的话，一个「预警遮罩」能被领成一笔救命钱。 */
  if (s.pending !== 'loan' || s.loaned) return { ok: false, why: '现在没有可领的救济金' };

  const amount = loanAmountAt();
  s.loaned = true;
  s.stat.loan += 1;                                    // 统计（v21）：称号「续命者」读它
  /* 救济金打**这个年代的那一格**（v13 · 方案 §9.2 ④）：2013–2014 给的是美元，
     2014-11 之后给的是 U —— 与跨所通道同一把尺子。 */
  const cur = cashCurAt(timeOf(s));
  ensureBook(s)[cur] += amount;
  s.pending = null;
  s.paused = false;
  /* ⚠️ 速度归 1x（2026-10-02 审计修）：与 `main.js` 的 `onWarn` / `onLoan` 后的续跑口径一致 ——
     原来只把 `paused` 放开，玩家若在 50x 下被爆仓、点「领取救济金」，会在**自己没反应过来**时
     又连飞几十个游戏小时。救命钱到账这一刻必须让玩家重新握回速度盘。 */
  s.speed = 1;
  pushLog(s, `领取救济金 ${fmtMoney(amount)} ｜ 无需偿还`, 'info');
  return { ok: true };
}

/** 「就此收摊」—— 归零遮罩上的灰键（`data-loan="give"`）。真的结束本局。
 *  ⚠️ 只认 `'loan'`（v11 · ③）：预警遮罩不该有任何一条能结束本局的路。 */
export function giveUp(s) {
  if (s.pending !== 'loan') return { ok: false, why: '现在没有要放弃的东西' };
  s.pending = null;
  /* ⚠️ 走 `GAVEUP` 不走 `LIQUIDATED`（v21）：玩家是**主动收摊**，不是被打爆的 ——
     交易档案里这两种结局必须分得开（一个是「我认输」，一个是「市场把我打穿了」）。 */
  endGame(s, OVER.GAVEUP);
  return { ok: false, why: OVER.GAVEUP };
}

/* ───────────────────────────── 时间推进 ───────────────────────────── */

/**
 * 前进一根小时 K 线。
 * 顺序很关键：**先结算资金费 → 再看新高/新低判爆仓 → 最后才看收盘** ——
 * 同一根里先发生的多半是坏消息（资金费在整点先扣，价格随这一根走）。
 * 多仓下每个仓位各自判定；**单仓爆仓不等于本局结束**，总权益归零才结束（GDD §10）。
 */
export function advanceOneHour(s) {
  /* ⚠️ `s.pending`（B30 待领救济金决策）也必须挡住：时钟那边虽然会因 `s.paused` 停下，
     但**同一次 `step()` 的 while 循环**里 `paused` 是刚被置上的，循环不会自己知道。
     没有这一行，`s.i += 1` 会继续跑，玩家在遮罩上犹豫的那一拍就白白流走几十个小时。 */
  if (s.over || s.pending) return;
  s.i += 1;

  /* 本局终点（§73.7）：经典全程 = `GAME.candles`（与改动前逐位相同），挑战局 = `s.endI`。 */
  if (s.i >= s.endI) {
    s.i = s.endI - 1;
    endGame(s, OVER.SETTLED);
    return;
  }

  /* 暂停下单的锁**解开**（§73.8）：走满 1 游戏小时即可再下一笔。 */
  if (s.lockI >= 0 && s.i > s.lockI) s.lockI = -1;

  // ── P2-A：在途转账到账 ＋ 玩家脉冲衰减 ──
  // ⚠️ **到账检查必须排在交易所归零之前**：钱已经在链上，不归任何一家所管。若排在归零之后，
  //    「归零那一刻正好到账」的钱会落进一个已经清零的账本、反而活下来，那是个漏洞。
  if (s.transfer && s.i >= s.transfer.arriveAt) {
    const tr = s.transfer;
    /* 进**当初搬的那一格**（v13 · 方案 §9.2 ①）：2013 年电汇搬的是美元，2014-11 后链上搬的是 U。
       少了这一条，Mt.Gox 会凭空到账一笔 2013 年根本不存在的 USDT。 */
    ensureBook(s, tr.to)[tr.cur] += tr.amount;
    s.transfer = null;
    const to = exchangeOf(tr.to);
    pushLog(s, `到账 ${to ? to.name : tr.to} ｜ ${fmtMoney(tr.amount)}`, 'ok');
  }
  decayPulse(s);

  /* 持仓抛压折价**按日重算**（v19 · 2026-10-01）：流通量逐年增长 ⇒ **同样的持仓占比在缩小**，
     折价该跟着退坡。只在**跨日那一根**刷新（每 24 根一次），不逐根刷 —— 逐根会把 σ 缓存冲烂。
     ⚠️ 台阶只影响 `at` 之后的 K 线 ⇒ 按日刷新**不会**重标定历史（与 `s.flow` 逐根约束同一纪律）。 */
  if (s.i % HOURS_PER_DAY === 0) for (const sym of heldSyms(s)) refreshOverhang(s, sym);

  // 交易所归零（目前只有 Mt.Gox 2014-02-25）：提前 7 天预警，到点余额清零、该所仓位作废。
  // 预警只在「玩家此刻就待在那家所」时出现 —— 已经搬走的人不需要被吓一跳。
  const t = timeOf(s);
  for (const ex of EXCHANGES) {
    if (ex.close == null) continue;
    if (t === ex.close - WARN_LEAD && s.ex === ex.id) {
      pushLog(s, `${ex.name} 提现异常，7 天后将停止一切交易`, 'bad');
    }
    if (t === ex.close && collapseExchange(s, ex)) return;
  }

  // 被盗削减（B21 · Bitfinex 2016-08-02）：只削该所余额，不归零、不作废仓位。
  for (const ex of EXCHANGES) {
    if (ex.hack && t === ex.hack.at && applyHackCut(s, ex)) return;
  }

  /* ═══════════ 历史时刻入日志（本轮 · 用户 2026-09-30 拍板「新闻也要写入日志串」）═══════════
     下面三类都是**一局内只说一次**的历史时刻，一律用 `===` 判等（同 Mt.Gox 归零预警的写法），
     天然只命中一次，不需要任何「已播过」状态位。
     ⚠️ 顺序即日志条的**先后**：`pushLog` 把最新的插在队首，同一个小时里最后写的那句才是
        日志条上显示的那句。新闻放在最前 —— 它是个 24 小时的「填充态」，该让位给同一小时里
        更具体的事件（与 P2-C「新闻让位于更新的日志」同一条口径）。 */
  const news = newsStartAt(s.i);
  if (news) pushLog(s, news.title, 'news');
  /* **第二条 · 结果**（2026-10-01 拍板）：第一条只讲事件、不带数字；数字全部由这里给，
     且**必然在它真的发生之后 1 小时**才播（判定与窗口口径见 `anchors.resultNewsStartAt`）。
     ⚠️ 同一个小时里两条都命中时，后 push 的结果条压在事件条上面 —— 那是对的：
        「结果」永远比「起因」更值得占着日志条那一行。 */
  const rnews = resultNewsStartAt(s.i);
  if (rnews) pushLog(s, rnews.rt, 'news');

  for (const ex of EXCHANGES) {
    /* 开张：只报「开局之后才开」的所 —— Mt.Gox / Bitfinex 在 2013-01-01 就在，
       `s.i` 那根永远不会等于 0（`advanceOneHour` 先自增），开局界面因此天然干净。 */
    if (ex.open > GAME.start && t === ex.open) pushLog(s, `${ex.name} 上线 ｜ 可在此交易`, 'ok');
    // 停机维护（B24 · BitMEX 2020-03-13）：窗口内**只平不开**
    for (const h of ex.halts || []) {
      if (t === h.from) pushLog(s, `${ex.name} 停机维护 ｜ 只能平仓，不能开仓`, 'bad');
      if (t === h.to) pushLog(s, `${ex.name} 恢复交易`, 'ok');
    }
    /* 杠杆阶梯：**首档 > 1x** 才叫「这类杠杆上线」（1x 就是纯现货，不是杠杆，不播）；
       其后每一档都是「上限调整」。Mt.Gox / BitMEX / Binance 的现货首档是 1x ⇒ 只在开张时取到。 */
    for (const [steps, label] of [[ex.spotSteps, '现货'], [ex.futSteps, '合约']]) {
      if (!steps) continue;
      steps.forEach((st, k) => {
        if (t !== st.from) return;
        if (k > 0) pushLog(s, `${ex.name} ${label}杠杆上限调整为 ${st.max}x`, 'info');
        else if (st.max > 1) pushLog(s, `${ex.name} ${label}杠杆上线 ｜ 最高 ${st.max}x`, 'ok');
      });
    }
  }

  // 币种上线（BTC 的 `unlock` 是回溯段、**早于开局**，索引为负 ⇒ 永不命中）
  for (const c of COINS) {
    if (Math.round((c.unlock - GAME.start) / HOUR_MS) === s.i) {
      pushLog(s, `${c.name} ${c.sym} 上线 ｜ 可交易`, 'ok');
    }
  }

  // Tether 上线（2014-11-20）：资产页那块「买 U」从这一根 K 线起才存在
  if (t === USDT_LIVE) pushLog(s, 'USDT 上线 ｜ 资产页可买入', 'ok');

  /* 通道自动回退（§15.3）：玩家选了 OTC，但权益跌破门槛 / 换到了还没开通 OTC 的币时，
     `chanOf` 会**悄悄**退回盘口。它是个**持久状态**（不是某一根的时刻），没有 `===` 可判，
     所以用 `s.otcOff` 闩锁 —— **一次跌落只报一条**（用户 2026-09-30 明确「重复的都要消除」）。
     ⚠️ 为什么不是「日志里已经有这句话」那种闩锁：那句话会被 60 条新日志顶出 `s.log`，
        条件仍成立时会再报一次 —— 正是用户要求消除的那种重复。
     ⚠️ 回到「OTC 可用」或「玩家自己切回盘口」时**解除闩锁**，这样下一次真的跌落还能再报一次。 */
  if (s.chan === 'otc' && chanOf(s) === 'book') {
    if (!s.otcOff) { s.otcOff = true; pushLog(s, OTC_OFF, 'bad'); }
  } else if (s.otcOff) {
    s.otcOff = false;
  }

  /* 破产预警（v11 · ③）：会**直接弄死人**（交易所归零）或**重创杠杆仓**（大级别崩盘）的历史事件，
     提前 7 天（`anchors.WARN_LEAD_HOURS`）弹遮罩 ＋ 暂停，给玩家挪仓 / 降杠杆的准备时间。
     ⚠️ **只有新手提示开着才打断**（`s.hintOn`）—— 老手在开场选了「我是老手」，自己扛。
        但 Mt.Gox 那条**交易所级**预警日志不受它管（就在上面那个循环里，只在「你此刻就待在那家所」
        时才出现）—— 所以老手不是完全没有提示，只是没有那记强制暂停。
     ⚠️ **不写日志**：遮罩本身就是那条提醒；再 push 一条，Mt.Gox 那一格就会同时出现两条同义警告，
        违反「同一事件描述一局内最多一次」。`warnAnchorAt` 用 `===` 判等，天然只命中一次。 */
  if (s.hintOn) {
    const a = warnAnchorAt(s.i);
    if (a) {
      s.warnAt = a.at;
      s.pending = 'warn';
      s.paused = true;
    }
  }

  // ⚠️ 上一步可能已经进了「待领救济金」或「破产预警」的待决态：时钟停了，后续的资金费 / 强平都不该再跑。
  if (s.pending) return;

  /* NPC 情绪 / 踩踏级联（§73.5）：基础行情（这一根的 K 线）算完之后跑一次 ——
     它自己会往 `s.flow` 写 NPC 的成交，所以必须排在资金费 / 强平之前、玩家的流之后。 */
  tickMarket(s, s.sym);

  // 持仓成本每 8 游戏小时结算一次（B26：永续扣资金费、现货保证金扣借贷利息，现货 1x 不扣）
  if (s.i % FUNDING.hours === 0 && settleFunding(s)) return;

  liquidateAll(s);

  /* 资金曲线采样（v13 · 方案 §4）排在**最后**：这一小时该结的资金费、该爆的仓都已经落账，
     此刻记下的才是「这一天真正剩下的钱」。上面几条 `return`（待决态 / 资金费爆仓）
     会跳过它 —— 无所谓，下一天照样采样，`sampleEquity` 的补记循环不会留下洞。 */
  sampleEquity(s);
}

/**
 * **回到过去**（2026-09-30 裁决）—— 保留资金、清空持仓，把时钟落到第 `to` 根小时 K。
 *
 * 是 `advanceOneHour` 的**反向操作**，但两者口径**故意不同**：
 *   向前 = 逐小时重放（持仓必须真的走过那段时间）
 *   向后 = 直接落点（时间倒流）
 *
 * ⚠️ **为什么向后不重放**：目标时刻的行情、杠杆阶梯、费率、流动性、币是否已上线**全是 `s.i` 的纯函数**
 *    （`config.*At(t)` 一族），而所有**累积型**状态（持仓 / 在途转账 / 救济金 / 资金曲线 /
 *    日志 / 冲击池 / 待决遮罩）在这里已经全部清空 ⇒ 重放没有任何东西可产出。
 *    反过来，重放**有害**：Mt.Gox 归零（2014-02-25）、Bitfinex 被盗削减（2016-08-02）这些事件会在
 *    重放途中把「保留的资金」吃掉 —— 那笔钱本来是在**跳转之后**才放的。
 *
 * **资金口径**：跳转前**所有交易所两格之和**（各所原样相加，**不做任何折算**），全部落到跳转后的
 * 「当前所」。负格**逐所逐格**归零（与「填入资金」`main.js:onGodCash` 同一口径；不能先加后夹，
 * 否则一所的负账会吃掉别所的正余额）。USDT 在 2014-11 之前
 * 并不存在，但这里**不折叠**成美元 —— 少一条规则，且与「权益里两格面值 1:1」一致。
 *
 * ⚠️ 当前所 / 当前币在目标时刻还不存在时，回落到当时可用的那一家 / 第一个已上线的币 ——
 *    否则会出现「2013 年在 Binance 交易 SOL」这种穿越。
 *
 * @param {number} to 目标小时序号（调用方负责夹到 `[0, GAME.candles - 1]`）
 * @returns {number} 跳转后账上的现金总额（给调用方记日志用）
 */
export function rewindTo(s, to) {
  const t = GAME.start + to * HOUR_MS;

  /* ① 保留资金：各所两格合计 —— ⚠️ 负格**逐所逐格**归零之后再相加。
        不能先加后夹：某一所的一格负账（平仓亏损超额，见 `credit`）会吃掉**别的所**的正余额，
        而那笔负账本来就已经被抹掉了 —— 等于顺手罚了玩家一笔他没欠的钱。 */
  let usd = 0, usdt = 0;
  for (const b of Object.values(s.books)) {
    usd += Math.max(0, b.usd);
    usdt += Math.max(0, b.usdt);
  }

  /* ② 清空**进度**，只留 UI 偏好（币 / 页 / 速度 / 模式 / 杠杆 / 通道 / 音效 / 新手提示 / `god`） */
  s.positions = {};
  s.transfer = null;
  s.pulse = [];
  s.flow = {};
  s.mkt = {};           // NPC 情绪 / 持仓（v26 · §73.5）同样是「进度」⇒ 回退时一并抹掉
  s.pool = {};          // 瞬时深度池（v23）同样是「进度」⇒ 回退时一并抹掉（与 s.flow 同口径）
  s.pvol = {};          // 玩家自己的成交量（v17）也是「进度」，回退时一并抹掉 —— 与 s.flow 同口径
  /* 持仓抛压折价（v18 / v25 疤痕）同样是「进度」⇒ 一并抹掉。⚠️ 漏掉它会让**没有持仓**的价格
     仍被一条永久疤痕压着（`refreshOverhang` 的按日重算只遍历 `heldSyms`，永远洗不掉它）。 */
  s.overhang = {};
  s.realized = 0;
  /* 交易统计（v21）也属于「进度」⇒ 一并清空。唯独 `god`（是否开过上帝模式）留着 ——
     它是「这一局不干净」的**永久标记**，回退一百次也不该被洗白。 */
  s.stat = { open: 0, win: 0, loss: 0, liq: 0, spot: 0, fut: 0, maxLev: 1, syms: {}, move: 0, god: s.stat.god, loan: 0 };
  s.eq = [];
  s.loaned = false;
  s.pending = null;
  s.warnAt = null;
  s.otcOff = false;
  s.godRuined = false;
  s.over = null;
  s.paused = false;
  s.log = [];

  /* ③ 时钟落到那一刻 —— **不重放**，见函数头 */
  s.i = to;

  /* ④ 当前所 / 当前币在那一刻还不存在 ⇒ 回落到当时可用的（判据与 `EXCHANGES[].open / close` 同源） */
  const exs = EXCHANGES.filter(x => t >= x.open && (x.close == null || t < x.close));
  if (exs.length && !exs.some(x => x.id === s.ex)) s.ex = exs[0].id;
  const syms = COINS.filter(c => c.unlock <= t);
  if (syms.length && !syms.some(c => c.sym === s.sym)) s.sym = syms[0].sym;
  normalizeLeverage(s);

  /* ⑤ 资金落到当前所（两格原样）＋ 给资金曲线补一个起点，免得资产页那张图空着 */
  s.books = { [s.ex]: { usd, usdt } };
  sampleEquity(s);

  return usd + usdt;
}

/* ───────────────────────── 资金费率与强平 ───────────────────────── */

/**
 * 让 σ 缓存失效（订单冲击 · 方案 §2.6）。
 *
 * ⚠️ **这是必须的，不是保险**：价格位移的系数是**逐根**的（一笔单只影响它之后的行情、还按幂律回爬），
 *    所以它**不是**一个能从收益率里约掉的全局常数 —— 相邻收益率、σ_30日、滑点、以及 NPC 热度里
 *    那个「位移 ÷ σ」的标准化分母**全都会变**。不在写完 `s.flow` 之后清一次，就会算出
 *    「价格在动、波动率不动」这种不自洽的滑点。
 */
export function invalidateSigma() {
  daySigmaCache.clear();
}

/**
 * 每 8 游戏小时一次的**持仓成本结算**（GDD §9.5）—— B26 起分成**两条互斥的路**：
 *
 *   - **永续（perp）**：资金费率 —— **拥挤成本**（§73.6）：应付的名义价值 × 费率从保证金里扣
 *     （应收则加回去）。费率 = `clamp(FR.k × 持仓名义 ÷ 小时基准深度 × dir, ±FR.max)`，
 *     口径与理由见 `positions.js` 的 `FR` 注释 —— 仓越大越贵，不再由行情动量决定。
 *   - **现货保证金（margin）**：借贷利息 —— `名义 × 日息 × (8/24)`。史实里 Bitfinex 的
 *     「杠杆」是用户间 P2P 借美元/借 BTC（出借方叫 Margin Funding Provider），按市场利率计息；
 *     日息**按年代取值**（`config.MARGIN.daily`）且**数字是合成值** ⇒ GDD 声明。
 *     2016-05-13 之前世界上没有永续，那时的杠杆仓全落进这一支。
 *
 * ⚠️ **两条路各写一条日志**（标签不同、不能合并成一条）：`paysInterest` 与 `paysFunding` 互斥，
 *    同时持有两种仓位时玩家需要分别看到两笔成本的费率。现货 1x 两样都不付。
 * @returns {boolean} 是否因结算后总权益归零而结束本局
 */
function settleFunding(s) {
  const syms = heldSyms(s);
  if (!syms.length) return false;

  const t = timeOf(s);
  const daily = marginDailyRateAt(t);              // 借贷日息按年代，同一时刻所有所一样

  let fed = 0, grossP = 0;   // 永续：净支出（> 0 = 玩家付出）/ 参与结算的名义和
  let ied = 0, grossM = 0;   // 现货保证金：应付利息 / 借来的名义和
  for (const sym of syms) {
    const pos = s.positions[sym];

    /* ── 现货保证金：借贷利息（B26）── */
    if (paysInterest(pos)) {
      const fee = pos.notional * daily * (FUNDING.hours / 24);
      pos.margin -= fee;
      s.realized -= fee;
      ied += fee;
      grossM += pos.notional;
      continue;
    }

    if (!paysFunding(pos)) continue;                 // 现货 1x：两样都不付
    const mark = markPrice(s, sym);
    if (!(mark > 0)) continue;

    /* 拥挤成本（§73.6 · 2026-10-02）：费率绑在**玩家持仓名义相对小时基准深度**上 ——
       仓越大越贵，多头拥挤时多头付、空头拥挤时空头付。取不到深度就不收费（数据缺口不凭空造钱）。 */
    const liq = hourLiqBase(s, sym, s.i);
    if (!(liq > 0)) continue;
    const dir = pos.side === 'long' ? 1 : -1;
    const rate = Math.max(-FR.max, Math.min(FR.max, FR.k * (pos.size * mark / liq) * dir));

    const fee = fundingOf(pos, mark, rate);
    pos.margin -= fee;
    /* ⚠️ 同一笔钱也要记进「已实现」（Batch 5 · B23）：原来只从保证金里扣，
       于是 HUD 副行那个数漏掉了资金费这一项支出（或收入）。 */
    s.realized -= fee;
    fed += fee;
    grossP += pos.size * mark;
  }

  /* 各币各看各的动量，费率并不相同 —— 日志只报一个**按名义价值加权的综合费率**，
     它恰好能自洽地解释那个净额，不会出现「费率写 +0.01% 却收钱」这种读不通的情况。
     文案（Batch 4 · B18，2026-09-29 拍板）：金额一律是**玩家视角的总收益**，
     「收益 +$0.03」= 拿到 U、「收益 −$0.05」= 付出 U ——
     正负号本身就是方向，不再写「支出 / 收入」四个字（日志条一行 nowrap，多两个汉字就挤爆）。 */
  if (grossP > 0 && fed !== 0) {
    const rate = fed / grossP;
    pushLog(s, `资金费率 ${fmtRate(Math.abs(rate), 4)} ｜ 收益 ${fmtMoney(-fed, { sign: true })}`,
      fed > 0 ? 'bad' : 'ok');
  }
  if (grossM > 0 && ied !== 0) {
    const rate = ied / grossM;
    pushLog(s, `借贷利息 ${fmtRate(Math.abs(rate), 4)} ｜ 收益 ${fmtMoney(-ied, { sign: true })}`,
      'bad');
  }

  return checkRuin(s);
}

/**
 * 逐仓强平：每个仓位各自用**当根 K 线的高低点**判定（见文件头注释）。
 * 现货仓位跳过 —— 只有币价归零才归零本金，不因维持保证金率被强平（GDD §9.1）。
 * ⚠️ v9（§15.3 N5）：判据从「是不是现货」换成 `canLiquidate` —— 现货从 §15.6 起**也带杠杆**，
 *    而「借来的钱要还」⇒ **现货杠杆仓照样强平**，只有现货 1x 才是那个无强平的特例。
 * ⚠️ B18/B26：维持线本身也不再是常数 —— `maintRateOf(pos)` 按「所 × 工具 × 名义档」取
 *    （Binance 永续四档、现货保证金恒 15%），所以早期 3.3x 杠杆仓会明显比现在更容易爆。
 * ⚠️ **2026-10-01 起不再是「一穿线就整条打掉」**：触线只走**部分强平**一档（`partialLiquidate`），
 *    只有权益真跌到 ≤ 0（或剩余不足最小名义）才整条 `forceLiquidate`。见 `PARTIAL_TARGET`。
 * @returns {boolean} 是否因此结束了本局
 */
function liquidateAll(s) {
  for (const sym of heldSyms(s)) {
    const pos0 = s.positions[sym];
    if (!pos0 || !canLiquidate(pos0)) continue;

    const c = candleAt(sym, s.i);
    if (!c) continue;

    /* 便宜的闸：**当根高低点**没打穿强平价、保证金率也没趴在维持线上 ⇒ 这一小时不必建细路径。
       （`pathOf` 是 121 个点的布朗桥，每根 K 线每个仓位都白建一次太浪费。） */
    const long0 = pos0.side === 'long';
    const liq0 = liquidationPrice(pos0);
    if (!(long0 ? c.l <= liq0 : c.h >= liq0) && !isLiquidatable(pos0, long0 ? c.l : c.h)) continue;

    /* S3（ROADMAP §19.6.3）：爆仓落在**哪一 tick、什么价**由细路径决定。
       为什么这不会多爆仓：`simulate.pathOf` 保证 `min(p) ≡ L`、`max(p) ≡ H`（S1 红线 1）
       ⇒「细路径穿越强平价」与「当根 l/h 穿越」**互为充要**。 */
    const p = pathOf(s.seed, sym, s.i, c);
    const last = p.length - 1;             // ＝ 该小时的 tick 段数 N
    let from = 0;                          // 这一轮从路径的第几段开始找穿越

    /* 逐步强平（2026-10-01 拍板）：同一根 K 线里可能被打**不止一档** ——
       缓跌穿线 ⇒ 部分强平把强平价推远 ⇒ 继续跌 ⇒ 再穿。`PARTIAL_STEPS` 既是安全闸，
       也符合交易所「一次只降到目标档」的收敛过程。 */
    for (let step = 0; step < PARTIAL_STEPS; step++) {
      const pos = s.positions[sym];
      if (!pos || !canLiquidate(pos)) break;

      const liq = liquidationPrice(pos);
      const long = pos.side === 'long';
      let at = liq;
      let hit = false;
      for (let j = from; j <= last; j++) {
        if (long ? p[j] <= liq : p[j] >= liq) { at = p[j]; from = j + 1; hit = true; break; }
      }
      if (!hit) {
        /* 兜底：路径并未穿越，但保证金率可能已经趴在维持线上（极端跳空 / 刚扣完资金费）。
           ⚠️ 这时成交价仍按 `liq` 记 —— 与改前逐位相同。 */
        if (!isLiquidatable(pos, long ? c.l : c.h)) break;
        at = liq;
        from = last + 1;
      }

      const frac = reduceFraction(pos, at, PARTIAL_TARGET);
      /* 没有可留的部分（权益已 ≤ 0），或剩下的不足最小名义（会留下尘埃仓）⇒ 整条打掉 */
      if (!(frac < 1) || pos.notional * (1 - frac) < MIN_NOTIONAL) {
        forceLiquidate(s, pos, at);
        if (checkRuin(s)) return true;
        break;
      }

      partialLiquidate(s, pos, frac, at);
      if (from > last) break;              // 路径已走完，这一小时内不会再被打
    }
  }
  return false;
}

/**
 * **部分强平**：（2026-10-01 拍板 · 见 `PARTIAL_TARGET`）—— 把仓位按 `frac` 缩掉一档，
 * 剩余部分继续持有。残余权益全部留在仓位里（见 `reducePosition`），于是强平价被推远。
 *
 * 与 `forceLiquidate` 共用全部副产物口径：**量柱**（真实成交 ⇒ 计入）、**订单冲击**
 * （平多打压 −1 / 平空推高 +1，同一公式、同样只回吐 `SHOCK.closeGive`）、**抛压折价刷新**。
 * 唯一的差别是：现金一分不动，只剩一笔已实现亏损记进 `s.realized`。
 */
function partialLiquidate(s, pos, frac, atPrice) {
  const r = reducePosition(pos, frac, atPrice);
  const notional = r.closedNotional;
  addPlayerVol(s, pos.sym, notional, pos.ex, isSpot(pos) ? 'spot' : 'fut');
  {
    const dir = pos.side === 'long' ? -1 : 1;
    pushFlow(s, pos.sym, dir, notional, SHOCK.closeGive, shockKindOf(isSpot(pos), pos.lev));
    consumePool(s, pos.sym, notional);    // 瞬时深度池（L1）：部分强平也是真实成交 ⇒ 也吃深度
  }
  s.realized += r.pnl;                     // 亏损已实现（钱还押在仓位里，见 `reducePosition`）
  s.positions[pos.sym] = r.pos;
  pushLog(s, `部分强平 ${pos.sym} ${pos.lev}x｜平掉 ${fmtRate(frac, 1)}｜保证金 ${fmtMoneyShort(pos.margin)} → ${fmtMoneyShort(r.pos.margin)} @ ${fmtLogPrice(atPrice)}`, 'bad');
  refreshOverhang(s, pos.sym, SHOCK.closeGive);   // v25：部分强平也是卖出 ⇒ 折价同比例释放
}

/**
 * 时钟。真实秒 → 游戏小时。
 *
 * ⚠️ **用 `setInterval` 而不是 `requestAnimationFrame` 推时间**（2026-09-28 实测后改的）：
 *    rAF 只在页面「可见且要被合成」时才跑 —— 切到后台、锁屏、以及部分 WebView
 *    （GDD §2.1 的目标宿主「微信 WebView」就在此列）里会被冻住，时间整个停摆。
 *    定时器则至少保持 1 秒一次的心跳。
 *
 *    两者都不影响精度：每次都用 `performance.now()` 的真实间隔去补，
 *    所以后台掉到 1 秒一跳时，50x 依然会是「一秒走 50 小时」，而不是慢 50 倍。
 *    `dt` 只封顶 1 秒 —— 封太久会漏掉时间，封太松又会在切回前台时一次性快进一大段。
 *
 *    渲染**不再跟着时钟走**：只有真的推进过才回调一次 `onFrame`，
 *    暂停或本局结束时不再重绘（GDD §2.2「按需刷新，暂停时停止渲染」）。
 *
 * ⚠️ **分层豁免**（2026-10-02 审计）：本文件在 `core/`，而 `setInterval` / `performance.now()`
 *    是**宿主**（浏览器 / Node）的 API —— 严格的「`core/` 不许碰宿主」在这里开一个口子，
 *    判定为**豁免**而不是搬走：
 *      ① 时钟就是「谁在推进 `s.i`」，而 `advanceOneHour` 就在本文件 —— 搬进 `main.js` 会把
 *         「一点时间前进 ＝ 一次状态转移」这条唯一真相源劈成两半；
 *      ② 这两个 API 在浏览器和 Node 里**都存在**（离线断言照样能跑），
 *         与 `careers.js` 那种「Node 里根本没有 `localStorage`」的性质不同。
 *    （`careers.js` 的 `localStorage` 同样判为豁免，理由是它自带 `try/catch` ＋ 内存兜底。）
 *
 * @param {object} s 状态
 * @param {object} cb { onFrame(s) }
 */
export function createClock(s, cb) {
  let timer = 0;
  let last = 0;
  let acc = 0;                       // 累积的「不足一根」的游戏小时

  function step() {
    const now = performance.now();
    const dt = last ? Math.min(1, (now - last) / 1000) : 0;
    last = now;

    let moved = false;
    if (!s.paused && !s.over) {
      acc += dt * s.speed;           // 1x ⇒ 1 秒 = 1 小时 ⇒ acc 每小时 +1
      let guard = 0;
      while (acc >= 1 && guard++ < 400) {
        acc -= 1;
        advanceOneHour(s);
        moved = true;
        /* `s.paused` 也要退出（B30）：借贷待决 / 本局结束都会在 `advanceOneHour` **内部**
           把 `paused` 置真。只判 `s.over` 的话，循环会带着 `paused` 继续转 ——
           那几十上百小时就这么在玩家还没回答遮罩之前悄悄走掉了。*/
        if (s.over || s.paused) { acc = 0; break; }
      }
    }

    // 推进过就重画（本局结束那一拍也算，遮罩要在这一拍画出来）
    if (moved && cb.onFrame) cb.onFrame(s);
  }

  return {
    start() { if (!timer) { last = 0; timer = setInterval(step, 50); } },
    stop() { if (timer) { clearInterval(timer); timer = 0; } },
    /** 供 UI 显示「这一根走到哪儿了」 */
    progress() { return acc; },
  };
}

/* ───────────────────────────── 便捷查询 ───────────────────────────── */

/**
 * 当前可用杠杆档位随「时间 ＋ 所选交易所 ＋ 模式」变化，
 * 切换币种 / 换所 / 走时间 / 切模式后都要夹取一次。
 *
 * ⚠️ v9（§15.6 N3）：**该所此刻没有合约时，模式强制退回现货** —— 否则玩家会带着 `'fut'`
 *    停在一家根本不提供合约的交易所上：模式键已经藏起来了，单子却还在按合约口径下。
 * ⚠️ 夹取必须用**当前模式那一张表**（§15.1）：从 125x 的合约切回现货，杠杆必须掉到现货上限。
 */
export function normalizeLeverage(s) {
  if (!futuresAvailable(s)) s.mode = 'spot';
  const max = maxLeverageAt(timeOf(s), s.ex, levKind(s));
  if (s.lev > max) s.lev = max;
  if (s.lev < 1) s.lev = 1;
}

/**
 * 当前所**此刻**有没有合约（v9 · §15.3 N3）—— UI 用它决定那枚「现货 / 合约」模式键出不出现。
 * 判据 = 该所 `futSteps` 非 `null` **且**首档已生效（`config.hasLeverageKindAt`）。
 */
export const futuresAvailable = s => hasLeverageKindAt(timeOf(s), s.ex, 'fut');
