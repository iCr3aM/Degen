/**
 * 交易与时间引擎（GDD §4 / §9 / §10 / §11）
 * ===============================================================
 * 这里只有三件事：**推进时间**、**改状态**、**判破产**。不碰 DOM，不读 `Date.now()`
 * （时钟从 `main.js` 注入，这样无头测试才能复现「20x 跑完 12 年」这类断言）。
 *
 * 时间的真相源只有一个：`s.i`（第几根小时 K 线）。
 * K 线推进 = 真实秒 × 倍速 ÷ 1 秒/根（GDD §11：1x 下 1 游戏小时 = 1 真实秒）。
 *
 * ⚠️ 爆仓判定必须用**当根 K 线的高低价**，不能用收盘价。
 *    收盘价只在整点变一次，用收盘价判爆仓会把「一根针」整个吞掉 ——
 *    而 100x 下 0.5% 的逆向波动正是被针扎出来的，那才是这个游戏的核心体验（GDD §14）。
 */

import { GAME, HOUR_MS, EXCHANGES, LIQ, OTC, SUPPLY_CAP, USDT_LIVE, coinOf, exchangeOf, hasFinancingAt, hasLeverageKindAt, maxLeverageAt, feeRateOf, marginDailyRateAt, railAt, railFeeOf, cashCurAt, fundingPremiumCapAt, LOAN, loanAmountAt, otcPremiumOf, usdtPriceAt } from './config.js';
import { candleAt, closeAt, dayIndexOf, hasCandle, isLoaded, liqOf, loadCoin, volumeAt, HOURS_PER_DAY } from './market.js';
import { warnAnchorAt } from './anchors.js';
import { arrivalCandles, bumpPulse, congestionOf, decayPulse } from './congestion.js';
import { SLIP, bookFills, fillPrice, hourShareK, impactOf, sigmaOf } from './impact.js';
import { SHOCK, addFlow, residualOfSide } from './god.js';
import { fmtLogPrice, fmtMoney, fmtMoneyShort, fmtRate } from './format.js';
import {
  closePosition, equityOf, isLiquidatable, isSpot, liquidationPrice, maintRateOf, openPosition, pnlOf,
  FUNDING, fundingOf, fundingRateOf, canLiquidate, paysFunding, paysInterest,
} from './positions.js';
import { blankBook, bookOf, cashOf, capturedOf, credit, debit, ensureBook, heldSyms, posOf, pushLog, spendableOf } from './state.js';
import { pathOf } from './simulate.js';
import { hashStr, rand } from './rng.js';

/** 交易所归零前多少毫秒给一条预警日志（7 天） */
const WARN_LEAD = 7 * 24 * HOUR_MS;

/** 一局结束的原因 */
export const OVER = {
  LIQUIDATED: 'liquidated',   // 爆仓，保证金全部损失且账户清零
  SETTLED: 'settled',         // 活到 2024-12-31 收盘
  DEFAULTED: 'defaulted',     // 借款到期还不上（B30）：债务违约
};

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
 * ⚠️ **补记循环**：一帧在 50x 下连跑 50 根小时线、跨天很正常；上帝模式「跳日期」更是逐小时重放。
 *    同一根小时线落在已记过的那天就不动，跨过了几天就用当前权益补齐 ——
 *    曲线宁可多一小段平线，也不能留洞。
 */
export function sampleEquity(s) {
  const day = Math.floor(s.i / 24);
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
 * 账户权益归零即破产（GDD §1.3）。
 *
 * ⚠️ 容差不是可选项：`margin = cash / (1 + lev×feeRate)` 之后再减 `margin + fee`，
 *    浮点残渣会留下 ~1e-13 的「现金」，于是「已经归零」的账户永远过不了 `<= 0` 这一关，
 *    游戏既不结束、也不弹结算遮罩，只是卡在 $0.00 上继续走时间（2026-09-28 实测）。
 */
const isBankrupt = s => equity(s) <= 1e-9;

/* ───────────────────────────── 滑点（P2-B1） ───────────────────────────── */

/* σ 的缓存：键 = 币，值 = { day, v }。与资金费率那个 `sigmaCache` 同一个理由 ——
   同一天内不必重扫 30 个日收盘。
   ⚠️ **必须与 `sigmaCache` 分开**：那个装的是「小时收益 σ」（资金费率的归一化分母），
   这个装的是「日收益 σ」（滑点的 σ_30日）—— 共用一个 Map 会串味。 */
const daySigmaCache = new Map();

/**
 * 近 30 天「日收盘收益率」的总体标准差 —— 滑点式里的 σ_30日（GDD §14.3）。
 *
 * 第 d 天的日收盘 = 那一天**最后一根小时 K**（`d × 24 + 23`）的收盘价。
 * 取 [day−31, day−1] 共 31 个日收盘 ⇒ 30 个日收益 —— **不含今天**：今天还没走完，
 * 把半截行情算进「日均波动」会让 σ 随当天走势抖（与 `hourlySigma` 的按天缓存同一取舍）。
 */
function dailySigma(sym, i) {
  const day = dayIndexOf(i);
  const hit = daySigmaCache.get(sym);
  if (hit && hit.day === day) return hit.v;

  const closes = [];
  for (let d = Math.max(0, day - SLIP.window - 1); d < day; d++) {
    closes.push(closeAt(sym, d * HOURS_PER_DAY + HOURS_PER_DAY - 1));
  }
  const v = sigmaOf(closes);
  daySigmaCache.set(sym, { day, v });
  return v;
}

/**
 * 该小时的流动性分母 ＝ `liqOf(当天) × hourShareK(该小时份额, 当天份额和, 当天小时数)`。
 *
 * 分母口径（C2，2026-09-29 拍板）：完整交易日里系数 = 24 × share，其**当日均值恰为 1**
 * ⇒ 一天下来的平均行为与「只用日流动性」**完全一致**（`A` / `threshold` / `cap` 无需重校），
 * 只是薄盘时段更痛、活跃时段更轻。
 *
 * ⚠️ 抽成独立函数是因为 **C8-B1 数子单笔数也要用它**（`q = 名义 ÷ 本值`）——
 *    笔数与滑点必须共用同一处口径，否则两者会各说各话。
 * @returns {number} 分母；取不到当日流动性时返回 0
 */
function hourLiqOf(sym, i) {
  const day = dayIndexOf(i);
  const liq = liqOf(sym, day);
  if (!(liq > 0)) return 0;
  const { sum, n } = dayVolShare(sym, day);
  return liq * hourShareK(volumeAt(sym, i), sum, n);
}

/**
 * 一次成交的冲击（0 = 不触发）。
 * ⚠️ **取不到当日流动性就不触发** —— 数据还没加载完 / 该币那天还没上线时，不凭空造一个冲击出来。
 */
function impactFor(sym, i, notional) {
  const liq = hourLiqOf(sym, i);
  if (!(liq > 0) || !(notional > 0)) return 0;
  return impactOf(notional / liq, dailySigma(sym, i));
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
 */
const otcPremiumFor = (s, sym) => otcPremiumOf(dailySigma(sym, s.i), timeOf(s));

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
 * 按比例下单。`frac` 是「用掉多少可用保证金」，对应操作区的 1/4 · 1/2 · 全部。
 *
 * 多仓（2026-09-28）：**同一个币只许一条仓位**，不同币可以同时持有（BTC 多 + ETH 空）。
 * 保证金一律从**当前所**的余额里出，各仓位互不担保（逐仓）。
 *
 * **同币加仓（v13 · B4 / 方案 §5）**：同一枚币已有仓位时，同向的这一单**并进那条仓位**
 * （不新开第二条、不引入仓位槽 —— 「每币一条」这条不变量撑着 `posOf` / 持仓条 / 强平线 / 存档）。
 * 兼容性判据集中在下面 `prev` 那一段，反手一律拒绝、由玩家自己决定先平哪一边。
 * @returns {{ok:boolean, why?:string}}
 */
export function openTrade(s, side, frac = 1) {
  if (s.over) return { ok: false, why: '本局已结束' };

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
  const feeRate = feeRateOf(s.ex, timeOf(s), isSpotOrder ? 'spot' : 'fut');
  /* 这一单能动用多少钱（v13 · 方案 §9.2 ②）：**合约只认 USDT**（USDT 本位永续，
     保证金必须是 U），现货 / OTC 是两格之和（扣的时候先扣 U、不足补美元）。
     所以 2013 年那 $3,000 美元可以买现货，但要玩合约得先在资产页「买 U」。 */
  const mustUsdt = !isSpotOrder;
  const cash = spendableOf(s, mustUsdt);

  /* ── 同币加仓的兼容性闸门（v13 · B4 / 方案 §5.2）──
     这一单若与已有仓位冲突，**必须在动账之前**拒绝（下面一旦 `debit`，钱就已经扣了）。
     四项各给一句明确文案，不静默失败：
       · 反方向 ⇒ 引导玩家自己「先平仓」（不替他反手：反手是一笔新仓，该由他决定）
       · 性质不同（现货 / 合约）⇒ 两张杠杆表、两种费率，混在一条仓里算不出强平价
       · 通道不同（盘口 / OTC）⇒ 成交价口径不同，且 OTC 恒 1x
       · 杠杆不同 ⇒ 加权均价对两种杠杆没有意义（D4 已拍板） */
  const prev = posOf(s, s.sym);
  if (prev) {
    if (prev.side !== side) return { ok: false, why: `${s.sym} 已有${prev.side === 'long' ? '多' : '空'}单 ｜ 反手请先平仓` };
    if (isSpot(prev) !== isSpotOrder) return { ok: false, why: `${s.sym} 已有${isSpot(prev) ? '现货' : '合约'}仓 ｜ 加仓请先切回同一模式` };
    if (!!prev.otc !== otc) return { ok: false, why: `${s.sym} 已有${prev.otc ? 'OTC' : '盘口'}仓 ｜ 加仓请先切回同一通道` };
    if (prev.lev !== lev) return { ok: false, why: `${s.sym} 已持 ${prev.lev}x ｜ 加仓必须同杠杆 ｜ 先平仓再重开` };
  }

  // 保证金 = 可用余额 × frac；开仓费按名义价值另收，所以要让「保证金 + 费 ≤ 余额」
  let margin = cash * Math.max(0.0001, Math.min(1, frac));
  const feeOf = m => m * lev * feeRate;
  if (margin + feeOf(margin) > cash) margin = cash / (1 + lev * feeRate);
  const fee = feeOf(margin);
  if (!(margin > 0) || margin + fee > cash + 1e-9) {
    return { ok: false, why: mustUsdt ? '合约保证金必须是 USDT ｜ 先在资产页把美元换成 U' : '可用保证金不足' };
  }

  /* OTC 的门槛（§15.3）：单笔名义 ≥ $100 万。锁定 1x ⇒ 名义 = 保证金。
     ⚠️ 门槛只卡**买入**，不卡平仓 —— 卡平仓会把玩家困在一条「币价跌下来、名义已不足 $100 万」的仓位上。 */
  if (otc && margin < OTC.min) return { ok: false, why: `OTC 单笔最少 ${fmtMoney(OTC.min)}` };

  /* 成交价（P2-B1 / P2-B3）：盘口价 ± 代价 —— 买抬、卖压，**永远对玩家不利**。
     代价有两种，同一时刻只有一种成立：盘口是平方根冲击、OTC 是「基准点差 × 市况倍数」（不吃滑点）。
     ⚠️ 保证金与开仓费都不受它影响（那两项按名义价值算，与成交价无关），
        受影响的是 `size`：买贵了就拿到的币少一点，这才是代价的真实形态。 */
  const notional = margin * lev;
  const cost = otc ? otcPremiumFor(s, s.sym) : impactFor(s.sym, s.i, notional);
  const fill = fillPrice(price, side === 'long' ? 1 : -1, cost);

  /* 供应量上限（P2-B2 · §15.1 / §15.4）：买入会从市场里锁走一部分币，锁走的枚数不得越界。
     ⚠️ 校验必须排在**动账之前** —— 下面那几行一旦执行，钱已经扣了，这时再拒绝就没法干净地退回。
     ⚠️ 只有多头方向消耗供应量（空头没把币拿走）；**OTC 买入不算**（对手方私下一口价，
        不从市场拿走流通量），所以这里直接跳过 —— 落点就是下面那句 `pos.otc = true`。
     按真实上限落地后这条整局都不会触发，所以**不为它新增终局**（GDD §16 只有两种收场）。 */
  const cap = SUPPLY_CAP[s.sym];
  if (!otc && side === 'long' && cap != null && capturedOf(s, s.sym) + margin * lev / fill > cap) {
    return { ok: false, why: `${s.sym} 已触及供应量上限，无法继续买入` };
  }

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
  /* ── 落账：新开 or 并进已有仓位（v13 · B4 / 方案 §5.1）──
     合并式只动 5 个字段，`entry` 走 **`size` 加权平均**：
         entry = (entry×size + fill×addSize) / (size + addSize)
     ⇒ 强平价、未实现盈亏、资金费全都自动落在「一条加权后的仓位」上，不需要任何额外分支。
     ⚠️ `openFee` **累加**（各收各的，不重算）：平仓时要报「本回合两笔之和」（见 `closeTrade`）。
     ⚠️ `mix` **两格各自累加**：平仓按合计比例退回，等价于两笔各按原比例退。
     ⚠️ `pos.i` 不更新：它是「这条仓位什么时候开的」，加仓不改出生时刻。 */
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
    pos = openPosition(s.sym, side, fill, margin, lev, feeRate, spot);
    pos.i = s.i;
    pos.ex = s.ex;                    // 仓位挂在哪家所 —— 归零事件据此精确作废（GDD §7.2）
    pos.openFee = fee;
    pos.mix = mix;                    // 保证金的两格构成（v13）—— 平仓原路退回
    if (otc) pos.otc = true;          // 只给 OTC 仓位打标（`capturedOf` 见到它就跳过）
    s.positions[s.sym] = pos;
  }

  /* 累计消耗（U2 · ROADMAP §21.4）：这笔买入从市场里拿走了多少枚，**只增不减**、平仓不退还。
     ⚠️ 与 `capturedOf`（瞬时口径，进 `SUPPLY_CAP` 校验）**并存互不影响**；OTC 不算（不消耗流通量）。 */
  if (!otc && side === 'long') s.consumed[s.sym] = (s.consumed[s.sym] ?? 0) + margin * lev / fill;

  /* 笔数（C8-B1）：同一份代价，报出它相当于拆成了几笔。OTC 是私下一口价、不吃滑点 ⇒ 不报。 */
  const fills = otc ? 1 : bookFills(notional / hourLiqOf(s.sym, s.i), cost);
  const tag = otc ? `｜OTC 溢价 ${fmtRate(cost, 2)}` : slipTag(cost, fills);
  /* 字面跟着模式走（v9 · §15.6 N4「没有的选项不显示」的同一条口径）：现货模式的操作键是
     **买入 / 卖出**，日志若还写「做多 / 做空」，就与玩家刚按下的那枚键对不上了。 */
  const verb = spot ? (side === 'long' ? '买入' : '卖出') : (side === 'long' ? '做多' : '做空');
  /* 手续费必须**写进日志**（本轮 ② · 用户拍板）：它已经真的从余额里扣掉了（上面那两行），
     玩家却只看到「保证金 $3,000.0」——账对不上。`fee` 就是本笔按名义价值收的那一次。
     ★ 加仓（B4）：字面换成「加仓 ＋ 追加保证金」，并补一个**加权后的均价** ——
       否则玩家只能看到「这笔按 $13.5 成的」，看不到自己整条仓位现在的成本在哪。 */
  const head = prev ? `加仓 ${s.sym} ${lev}x` : `${verb} ${s.sym} ${lev}x`;
  const line = prev ? `追加保证金 ${fmtMoneyShort(margin)}` : `保证金 ${fmtMoneyShort(margin)}`;
  const avg = prev ? `｜均价 ${fmtLogPrice(pos.entry)}` : '';
  pushLog(s, `${head}｜${line} @ ${fmtLogPrice(fill)}${avg}｜手续费 ${fmtMoneyShort(fee)}${tag}`,
    side === 'long' ? 'long' : 'short');

  /* 订单冲击（方案 §2.6）：把这次成交代价的**永久部分**（Almgren–Chriss 的 γQ，实证 35%）
     沉淀成行情位移 —— 从此处起价格上/下一个台阶，再按 Bouchaud 幂律慢慢回爬。
     ⚠️ 这不是重复收惩罚：`cost` 是本次成交付出的**全部**代价，这里只把其中一部分留在地上，
        剩下的就是 AC 里的「暂时冲击」（随成交结束而消失，已由成交价本身承担）。
     ⚠️ OTC 不写：私下一口价的大宗交易不落公开盘口（与它不消耗供应量同一口径）。
     ⚠️ 与上帝模式**无关**（2026-09-29 瘦身）：原来这里乘过一个「冲击倍率」`s.god.mult`，
        已删除 —— 上帝模式不再有任何价格能力。 */
  if (!otc && s.impactOn) {
    const dir = side === 'long' ? 1 : -1;
    if (addFlow(s, s.sym, dir * SHOCK.share * cost)) invalidateSigma();
  }
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
  const cost = otc ? otcPremiumFor(s, sym) : impactFor(sym, s.i, notional);
  const fill = fillPrice(price, pos.side === 'long' ? -1 : 1, cost);

  /* 平仓费走**开仓时那张表**（v12 · §11.3）：判据是仓位自己的 `isSpot`，
     不是玩家此刻的模式 —— 现货仓平仓不该按合约费率收，反之亦然。 */
  const r = closePosition(pos, fill, feeRateOf(pos.ex, timeOf(s), isSpot(pos) ? 'spot' : 'fut'));
  /* 平仓款**按 `pos.mix` 同比例退回两格**（v13 · 方案 §9.2 ③）——
     2013 年用美元开的仓，平掉回的还是美元：否则 Mt.Gox 会凭空空降一笔 USDT。 */
  credit(s, pos.ex, r.net, pos.mix);
  s.realized += r.pnl - r.fee;
  const fills = otc ? 1 : bookFills(notional / hourLiqOf(sym, s.i), cost);   // 笔数（C8-B1，同开仓口径）
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

  /* 订单冲击（方案 §2.6 ＋ **A2**，2026-09-29 拍板）：**平多 = 卖、平空 = 买**，方向与开仓时相反。
     A2 口径 = 「返还款打对折」：基数是**开仓方向此刻的残存值** `R`（不是开仓时的原值），写回 `−giveBack·R`。
     ⇒ 砸出的坑只回填一半；且新写的反向笔幅度 ≤ 同向残存值 ⇒ **过冲在数学上不可能发生**
        （原来那种「弹得比原价还高」正是「先写的衰减多、后写的衰减少」这条不对称造成的）。 */
  if (!otc && s.impactOn) {
    const dir = pos.side === 'long' ? 1 : -1;
    const back = SHOCK.giveBack * residualOfSide(s, sym, s.i, dir);
    if (addFlow(s, sym, -dir * back)) invalidateSigma();
  }

  if (checkRuin(s)) return { ok: false, why: s.over.reason };
  return { ok: true };
}

/**
 * 「致命那一针」的对外出口（S3-附 · ROADMAP §19.6.3）—— 由 `main.js` 注入，
 * core 不认识 UI（与 `market.bindFactorSource` 同一套路）；不注入时零开销。
 * ⚠️ 报出去的是**一瞬的事实**（币 / 小时 / 那一段 tick），要不要记、记多久由 UI 决定 ——
 *    它**不写 `s`**：`save()` 是整对象序列化，写进状态就等于落盘。
 */
let onLiquidate = null;
export function bindLiquidateHook(fn) { onLiquidate = fn || null; }

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
 * @param {number} k       那一 tick 在该小时细路径里的**段号**（`0 … N−1`）—— 只给「图上标致命针」用
 */
function forceLiquidate(s, pos, atPrice, k) {
  const remain = maintRateOf(pos) * pos.notional;     // 触发时的残余权益（＝维持保证金那一格）
  const back = Math.max(0, remain - pos.notional * LIQ.fee);

  /* 串形与开仓 / 平仓对齐（2026-09-29）：`｜` 两侧不留白、金额走 `fmtMoneyShort`、
     价格走 `fmtLogPrice`（本轮 ② —— 原来这里是 `showPrice`，现在统一 ≥$1 一位小数）。
     ⚠️ 返还 > 0 时不能再说「全部损失」（B20）：那一格日志条是一行 nowrap，字数要省，
        所以只在真的有退款时才多带一段。 */
  pushLog(s, back > 1e-9
    ? `爆仓 ${pos.sym} ${pos.lev}x｜保证金 ${fmtMoneyShort(pos.margin)} ｜退回 ${fmtMoneyShort(back)} @ ${fmtLogPrice(atPrice)}`
    : `爆仓 ${pos.sym} ${pos.lev}x｜保证金 ${fmtMoneyShort(pos.margin)} 全部损失 @ ${fmtLogPrice(atPrice)}`,
    'bad');

  if (back > 1e-9) credit(s, pos.ex, back, pos.mix);   // 退回**当初开仓那家所**（原路：按 mix 比例分两格）
  s.realized -= pos.margin - back;                     // 真实现金变动 = 丢掉保证金、收回退款
  delete s.positions[pos.sym];
  if (onLiquidate) onLiquidate(pos.sym, s.i, k);
}

function endGame(s, reason) {
  s.over = { reason, at: s.i };
  s.paused = true;
  const text = reason === OVER.SETTLED ? '活到了 2024-12-31，结算'
    : reason === OVER.DEFAULTED ? '借款到期还不上，债务违约'
      : '账户归零，游戏结束';
  pushLog(s, text, reason === OVER.SETTLED ? 'ok' : 'bad');
  return { ok: false, why: reason };
}

/**
 * 「归零」的**唯一出口**（Batch 5 · B30）—— 原来有 4 处各自 `isBankrupt → endGame`，
 * 现在全部走这里。收成一个口的好处不只是少写几遍：**这条规则以后只会有一个地方要改**。
 *
 * 归零时若本局**还没借过**，不结束本局，而是进「待决态」：时钟停住、弹出借贷遮罩，
 * 等玩家回答「借，还是收摊」。`s.pending` 期间 `s.paused` 为真，时钟自然不再推进。
 *
 * ⚠️ 4 条调用路径（`closeTrade` / `collapseExchange` / `settleFunding` / `liquidateAll`）
 *    一个都不能漏，否则会出现「该结束却没结束」或「该弹借贷却直接结束」。
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

  if (!s.loaned) {
    s.pending = 'loan';
    s.paused = true;
    pushLog(s, `账户归零 ｜ 可借 ${fmtMoney(loanAmountAt(timeOf(s)))} 续命`, 'bad');
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
  /* `wire` 走**银行电汇**：到账时间由 `hours` 这个固定区间给（不吃拥堵）——
     链堵不堵与银行慢不慢是两件事（方案 §11.6），所以既不调 `arrivalCandles` 也不 `bumpPulse`。
     具体小时数用 `rand` 抽（可复现）：同一份档、同一时刻、同一对交易所，永远同一个数。 */
  const n = rail.hours
    ? rail.hours[0] + Math.floor(rand(s.seed, hashStr(from), s.i, 0, hashStr(toId)) * (rail.hours[1] - rail.hours[0] + 1))
    : arrivalCandles(congestionOf(s), toId);
  return { rail, fee, n };
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
  }
  if (margin) s.realized -= margin;

  const hit = lost + margin;
  pushLog(s, hit > 0 ? `${ex.name} 归零 ｜ 损失 ${fmtMoney(hit)}` : `${ex.name} 归零`,
    hit > 0 ? 'bad' : 'info');

  return checkRuin(s);
}

/* ───────────────────────────── 场外配资（B30） ───────────────────────────── */

/**
 * 借下那笔救命钱 —— 归零遮罩上的绿键（`data-loan="take"`）。
 * 只允许在**待决态**里调用一次：`s.loaned` 一旦置真，本局再没有第二次机会。
 */
export function takeLoan(s) {
  /* ⚠️ 判**值**不判真值（v11 · ③）：`'warn'`（破产预警遮罩）也是个非空的 `pending`，
     只判 `!s.pending` 的话，一个「预警遮罩」能被借成一笔救命钱。 */
  if (s.pending !== 'loan' || s.loan) return { ok: false, why: '现在没有可借的额度' };

  const amount = loanAmountAt(timeOf(s));
  const owe = amount * (1 + LOAN.ratePerDay * LOAN.days);
  s.loaned = true;
  s.loan = { amount, owe, dueAt: s.i + LOAN.days * 24 };
  /* 借款打**这个年代的那一格**（v13 · 方案 §9.2 ④）：2013–2014 借到的是美元，
     2014-11 之后借到的是 U —— 与跨所通道同一把尺子。 */
  const cur = cashCurAt(timeOf(s));
  ensureBook(s)[cur] += amount;
  s.pending = null;
  s.paused = false;
  pushLog(s, `借款 ${fmtMoney(amount)} ｜ ${LOAN.days} 天后还 ${fmtMoney(owe)}`, 'info');
  return { ok: true };
}

/** 「就此收摊」—— 归零遮罩上的灰键（`data-loan="give"`）。真的结束本局。
 *  ⚠️ 只认 `'loan'`（v11 · ③）：预警遮罩不该有任何一条能结束本局的路。 */
export function giveUp(s) {
  if (s.pending !== 'loan') return { ok: false, why: '现在没有要放弃的东西' };
  s.pending = null;
  endGame(s, OVER.LIQUIDATED);
  return { ok: false, why: OVER.LIQUIDATED };
}

/**
 * 借款到期结算（Batch 5 · B30）。两条预警 ＋ 一次清算：
 *
 *   ① **自动清仓**：按期价把**全部**仓位平掉结成现金（含现货，收平仓费，与手动平仓同口径）——
 *      只从现金扣的话，钱全在仓位里的玩家会莫名其妙违约；给一枚「还款」按钮又要占操作区的格子
 *      （与本轮「压缩纵向空间」方向相反）。
 *   ② 可还池 = 当前所余额 ＋ 平仓所得 ＋ **在途转账**（不够时先从在途扣，扣完取消那笔转账）。
 *   ③ 池 ≥ `owe` ⇒ 扣款结清，**只有利息**进「已实现」（本金进出互相抵消，见 B23 的口径）；
 *      池 < `owe` ⇒ 债务违约，本局结束。
 *
 * @returns {boolean} 是否因违约结束了本局
 */
function settleLoan(s) {
  if (!s.loan) return false;

  // 两条预警（仿 Mt.Gox 归零的 `WARN_LEAD` 写法，用 `===` 保证只触发一次）
  if (s.i === s.loan.dueAt - LOAN.warnLead) {
    pushLog(s, `借款还剩 7 天 ｜ 需还 ${fmtMoney(s.loan.owe)}`, 'bad');
  }
  if (s.i === s.loan.dueAt - 24) {
    pushLog(s, `借款明天到期 ｜ 需还 ${fmtMoney(s.loan.owe)}`, 'bad');
  }
  if (s.i < s.loan.dueAt) return false;

  for (const sym of heldSyms(s)) {
    const pos = s.positions[sym];
    const price = markPrice(s, sym);
    if (price > 0) {
      /* 到期自动清仓与**手动平仓同口径**（含滑点，P2-B1）—— 一笔 $100 万的仓位
         不该因为「是系统帮我平的」就白捡一个更好的成交价。这一条不单独写日志，
         下面那条「还款 · 借款结清」已经概括了整件事。 */
      const impact = impactFor(sym, s.i, pos.size * price);
      const r = closePosition(pos, fillPrice(price, pos.side === 'long' ? -1 : 1, impact), feeRateOf(pos.ex, timeOf(s), isSpot(pos) ? 'spot' : 'fut'));
      credit(s, pos.ex, r.net, pos.mix);
      s.realized += r.pnl - r.fee;
    } else {
      credit(s, pos.ex, pos.margin, pos.mix);                  // 取不到价：按权益口径退回保证金
    }
    delete s.positions[sym];
  }

  const owe = s.loan.owe;
  const pool = cashOf(s) + (s.transfer ? s.transfer.amount : 0);
  if (pool + 1e-9 < owe) {
    endGame(s, OVER.DEFAULTED);
    return true;
  }

  // 先在途、后账本（在途那笔钱本来就不能动用，先扣它最自然）
  let rest = owe;
  if (s.transfer) {
    const use = Math.min(s.transfer.amount, rest);
    s.transfer.amount -= use;
    rest -= use;
    if (s.transfer.amount <= 1e-9) s.transfer = null;
  }
  /* 还款与扣保证金同一口径：**先扣 USDT、不足补美元**。池子在上面已校验 ≥ `owe`
     （`pool` = 两格之和 ＋ 在途），而在途那段刚被扣掉 ⇒ 两格之和必 ≥ `rest`，扣得干净。
     兜底（理论不可达）：直接把美元那格减成负数，交给 `isBankrupt` 接住 —— 与原实现同效。 */
  if (!debit(s, rest)) ensureBook(s).usd -= rest;
  s.realized -= owe - s.loan.amount;      // 只有利息是成本
  pushLog(s, `还款 ${fmtMoney(owe)} ｜ 借款结清`, 'ok');
  s.loan = null;
  return false;
}

/* ───────────────────────────── 时间推进 ───────────────────────────── */

/**
 * 前进一根小时 K 线。
 * 顺序很关键：**先结算资金费 → 再看新高/新低判爆仓 → 最后才看收盘** ——
 * 同一根里先发生的多半是坏消息（资金费在整点先扣，价格随这一根走）。
 * 多仓下每个仓位各自判定；**单仓爆仓不等于本局结束**，总权益归零才结束（GDD §10）。
 */
export function advanceOneHour(s) {
  /* ⚠️ `s.pending`（B30 待借贷决策）也必须挡住：时钟那边虽然会因 `s.paused` 停下，
     但**同一次 `step()` 的 while 循环**里 `paused` 是刚被置上的，循环不会自己知道。
     没有这一行，`s.i += 1` 会继续跑，玩家在遮罩上犹豫的那一拍就白白流走几十个小时。 */
  if (s.over || s.pending) return;
  s.i += 1;

  if (s.i >= GAME.candles) {
    s.i = GAME.candles - 1;
    endGame(s, OVER.SETTLED);
    return;
  }

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

  // ⚠️ 上一步可能已经进了「待借贷」或「破产预警」的待决态：时钟停了，后续的资金费 / 强平都不该再跑。
  if (s.pending) return;

  // 借款到期结算（B30）：排在交易所归零**之后**、资金费**之前** ——
  // 归零已经把该作废的仓位作废了，而到期清仓必须先于资金费（否则会为已经要平的仓位再扣一次）。
  if (settleLoan(s)) return;

  // 持仓成本每 8 游戏小时结算一次（B26：永续扣资金费、现货保证金扣借贷利息，现货 1x 不扣）
  if (s.i % FUNDING.hours === 0 && settleFunding(s)) return;

  liquidateAll(s);

  /* 资金曲线采样（v13 · 方案 §4）排在**最后**：这一小时该结的资金费、该爆的仓都已经落账，
     此刻记下的才是「这一天真正剩下的钱」。上面几条 `return`（待决态 / 借款到期 / 资金费爆仓）
     会跳过它 —— 无所谓，下一天照样采样，`sampleEquity` 的补记循环不会留下洞。 */
  sampleEquity(s);
}

/* ───────────────────────── 资金费率与强平 ───────────────────────── */

/* σ 的缓存：键 = 币，值 = { day, v }。结算每 8 游戏小时来一次，50x 下每秒 6 次 ——
   不按天缓存的话，每次都要重扫 720 根 K 线。同一天内窗口滑动带来的偏差可以忽略
   （σ 是 30 天的统计量，一天的位移改变不了它多少）。 */
const sigmaCache = new Map();

/**
 * 让两个 σ 缓存全部失效（订单冲击 · 方案 §2.6）。
 *
 * ⚠️ **这是必须的，不是保险**：价格位移的系数是**逐根**的（一笔单只影响它之后的行情、还按幂律回爬），
 *    所以它**不是**一个能从收益率里约掉的全局常数 —— 相邻收益率、σ_30日、资金费率、滑点全都会变。
 *    不在写完 `s.flow` 之后清一次，就会算出「价格在动、波动率不动」这种不自洽的滑点与资金费。
 */
export function invalidateSigma() {
  daySigmaCache.clear();
  sigmaCache.clear();
}

/**
 * 近 30 天（`FUNDING.sigmaWindow` 根）的**小时收益标准差** —— 溢价归一化的分母（Batch 4 · B18）。
 * 用「相邻收盘价的变化率」的总体标准差（不是样本标准差），样本不足时退回 `FUNDING.sigmaDefault`。
 * @returns {number} σ ≥ `FUNDING.sigmaDefault` 的下限，保证分母永远不为 0
 */
function hourlySigma(sym, i) {
  const day = Math.floor(i / HOURS_PER_DAY);
  const hit = sigmaCache.get(sym);
  if (hit && hit.day === day) return hit.v;

  const from = Math.max(0, i - FUNDING.sigmaWindow + 1);
  let n = 0, sum = 0, sum2 = 0, prev = 0;
  for (let k = from; k <= i; k++) {
    const c = closeAt(sym, k);
    if (!(c > 0)) { prev = 0; continue; }        // 洞/未上线：断开，不跨洞算收益
    if (prev > 0) { const r = c / prev - 1; n++; sum += r; sum2 += r * r; }
    prev = c;
  }
  let v = FUNDING.sigmaDefault;
  if (n > 1) {
    const mean = sum / n;
    const va = Math.max(0, sum2 / n - mean * mean);
    v = Math.max(FUNDING.sigmaDefault, Math.sqrt(va));
  }
  sigmaCache.set(sym, { day, v });
  return v;
}

/**
 * 每 8 游戏小时一次的**持仓成本结算**（GDD §9.5）—— B26 起分成**两条互斥的路**：
 *
 *   - **永续（perp）**：资金费率 —— 应付的名义价值 × 费率从保证金里扣（应收则加回去）。
 *     溢价指数是**合成的**，口径与理由见 `positions.js` 的 `FUNDING` 注释（数据包里每个币只有
 *     一条真小时线，拿不到「合约价 vs 现货价」两条线），上限按年代走
 *     （2013–2018 → 0.5%、2019–2021 → 0.3%、2022 起 → 0.1%）。
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
  const cap = fundingPremiumCapAt(t);              // 溢价上限按年代，同一时刻所有币一样
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

    const prev = closeAt(sym, s.i - FUNDING.window);
    const sigma = hourlySigma(sym, s.i);
    const rate = prev > 0 ? fundingRateOf(mark / prev - 1, sigma, cap) : fundingRateOf(0, sigma, cap);

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
 * @returns {boolean} 是否因此结束了本局
 */
function liquidateAll(s) {
  for (const sym of heldSyms(s)) {
    const pos = s.positions[sym];
    if (!canLiquidate(pos)) continue;

    const c = candleAt(sym, s.i);
    if (!c) continue;

    const liq = liquidationPrice(pos);
    const long = pos.side === 'long';
    const hit = long ? c.l <= liq : c.h >= liq;
    // 强平价一定是「可达」的：多头被砸到 liq（≤ 当根低点），空头被拉到 liq（≥ 当根高点）
    // 兜底：即便没打穿强平价，保证金率也可能已经趴在维持线上（例如极端跳空或刚扣完资金费）
    const mark = long ? c.l : c.h;
    if (!hit && !isLiquidatable(pos, mark)) continue;

    /* S3（ROADMAP §19.6.3）：爆仓落在**哪一 tick、什么价**由细路径决定。
       为什么这不会多爆仓：`simulate.pathOf` 保证 `min(p) ≡ L`、`max(p) ≡ H`（S1 红线 1）
       ⇒「细路径穿越强平价」与「当根 l/h 穿越」**互为充要**，上面 `hit` 的判据一个字没改 ——
       变的只是**时点与成交价**（改前是直接拿 `liq` 当成交价写日志）。
       ⚠️ 兜底命中（路径并未穿越）时取该小时路径**极值所在的那一段**，成交价仍按 `liq` 记
          （与改前逐位相同），只是给「图上标致命针」配一支有意义的刻度。 */
    const p = pathOf(s.seed, sym, s.i, c);
    const last = p.length - 1;             // ＝ 该小时的 tick 段数 N
    let k = 0, at = liq;
    if (hit) {
      /* 全路径取「**第一个**穿越强平价的点」—— `p` 覆盖 `[0, N]`，段号因此夹到 `N−1` */
      for (let j = 0; j <= last; j++) {
        if (long ? p[j] <= liq : p[j] >= liq) { k = Math.min(j, last - 1); at = p[j]; break; }
      }
    } else {
      let ext = long ? Infinity : -Infinity;
      for (let j = 0; j <= last; j++) {
        if (long ? p[j] < ext : p[j] > ext) { ext = p[j]; k = Math.min(j, last - 1); }
      }
    }
    forceLiquidate(s, pos, at, k);
    if (checkRuin(s)) return true;
  }
  return false;
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
 *    所以后台掉到 1 秒一跳时，20x 依然会是「一秒走 20 小时」，而不是慢 20 倍。
 *    `dt` 只封顶 1 秒 —— 封太久会漏掉时间，封太松又会在切回前台时一次性快进一大段。
 *
 *    渲染**不再跟着时钟走**：只有真的推进过才回调一次 `onFrame`，
 *    暂停或本局结束时不再重绘（GDD §2.2「按需刷新，暂停时停止渲染」）。
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

/** 某个币此刻能不能交易（已解锁 + 数据已加载） */
export function tradable(s, sym) {
  const coin = coinOf(sym);
  if (!coin) return false;
  if (timeOf(s) < coin.unlock) return false;
  if (!hasCandle(sym, s.i)) return false;
  return true;
}
