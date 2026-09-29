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

import { GAME, HOUR_MS, EXCHANGES, OTC, SUPPLY_CAP, coinOf, exchangeOf, maxLeverageAt, feeRateOf, fundingPremiumCapAt, LOAN, loanAmountAt, otcPremiumOf } from './config.js';
import { candleAt, closeAt, dayIndexOf, hasCandle, isLoaded, liqOf, loadCoin, volumeAt, HOURS_PER_DAY } from './market.js';
import { arrivalCandles, bumpPulse, congestionLabel, congestionOf, decayPulse } from './congestion.js';
import { SLIP, fillPrice, hourShareK, impactOf, sigmaOf } from './impact.js';
import { SHOCK, addFlow } from './god.js';
import { fmtMoney, fmtRate } from './format.js';
import {
  closePosition, equityOf, isLiquidatable, isSpot, liquidationPrice, openPosition, pnlOf,
  FUNDING, fundingOf, fundingRateOf,
} from './positions.js';
import { cashOf, capturedOf, heldSyms, posOf, pushLog } from './state.js';

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
 * 可用保证金 = 当前所里未被持仓占用的余额。
 * ⚠️ **在途的钱不算**（P2-A 陷阱③）：它躺在链上，不能开仓、也不能再搬一次。
 *    实现上天然成立 —— `cashOf` 只看 `books`，而发起转账时旧所那一格已经清零。
 */
export const available = s => cashOf(s);

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
 * 一次成交的冲击（0 = 不触发）。
 * ⚠️ **取不到当日流动性就不触发** —— 数据还没加载完 / 该币那天还没上线时，不凭空造一个冲击出来。
 *
 * 分母（C2，2026-09-29 拍板）：`liqOf(当天) × hourShareK(该小时份额, 当天份额和, 当天小时数)`。
 * 完整交易日里系数 = 24 × share，其**当日均值恰为 1** ⇒ 一天下来的平均行为与「只用日流动性」
 * **完全一致**（`A` / `threshold` / `cap` 无需重校），只是薄盘时段更痛、活跃时段更轻。
 */
function impactFor(sym, i, notional) {
  const day = dayIndexOf(i);
  const liq = liqOf(sym, day);
  if (!(liq > 0) || !(notional > 0)) return 0;
  const { sum, n } = dayVolShare(sym, day);
  return impactOf(notional / (liq * hourShareK(volumeAt(sym, i), sum, n)), dailySigma(sym, i));
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

/** 日志尾巴：触发了才追加，没触发的一个字符都不加 */
const slipTag = impact => (impact > 0 ? ` ｜ 滑点 ${fmtRate(impact, 2)}` : '');

/**
 * 一次 OTC 成交的溢价（P2-B 修订 · §15.3）。
 * **复用同一个 `dailySigma`** —— 不需要第二套「市场有多慌」的度量，它本来就是现成的。
 * ⚠️ 取「**此刻**」而不是开仓时的：卖出面对的是当时的流动性，不是当初的（§15.3 ⑤）。
 */
const otcPremiumFor = (s, sym) => otcPremiumOf(dailySigma(sym, s.i), timeOf(s));

/**
 * 日志里的价格。只做一件事：抹掉浮点乘法的尾噪 ——
 * `13.078 × 1.006` 会算出 `13.156468000000001` 这种东西，直接贴进 nowrap 的日志条很难看。
 * 取 8 位有效数字（数据包本身就是按 8 位有效数字编码的），所以**未触发滑点时与原来一字不差**。
 */
const showPrice = v => Number(v.toPrecision(8));

/* ───────────────────────────── 交易动作 ───────────────────────────── */

/**
 * 按比例下单。`frac` 是「用掉多少可用保证金」，对应操作区的 1/4 · 1/2 · 全部。
 *
 * 多仓（2026-09-28）：**同一个币只许一条仓位**，不同币可以同时持有（BTC 多 + ETH 空）。
 * 保证金一律从**当前所**的余额里出，各仓位互不担保（逐仓）。
 * @returns {{ok:boolean, why?:string}}
 */
export function openTrade(s, side, frac = 1) {
  if (s.over) return { ok: false, why: '本局已结束' };
  if (posOf(s, s.sym)) return { ok: false, why: `${s.sym} 已有持仓，先平仓` };

  /* 通道（P2-B3 · §15.3）：OTC 是**现货大宗**，没有做空这一说（空头要借币、要维持保证金，
     都不是「私下一口价买现货」能承接的）。 */
  const otc = chanOf(s) === 'otc';
  if (otc && side === 'short') return { ok: false, why: 'OTC 通道只有现货，不能做空' };

  const coin = coinOf(s.sym);
  if (!coin || !isLoaded(s.sym)) return { ok: false, why: '行情还没加载完' };
  if (timeOf(s) < coin.unlock) return { ok: false, why: `${s.sym} 还没上线` };

  const price = markPrice(s, s.sym);
  if (!(price > 0)) return { ok: false, why: '当前没有可成交的价格' };

  // 杠杆上限与费率都取**玩家当前所在的交易所**（GDD §7.1）。OTC 一律 1x（= 现货）
  const lev = otc ? 1 : Math.max(1, Math.min(s.lev, maxLeverageAt(timeOf(s), s.ex)));
  const feeRate = feeRateOf(s.ex);
  const cash = cashOf(s);

  // 保证金 = 可用余额 × frac；开仓费按名义价值另收，所以要让「保证金 + 费 ≤ 余额」
  let margin = cash * Math.max(0.0001, Math.min(1, frac));
  const feeOf = m => m * lev * feeRate;
  if (margin + feeOf(margin) > cash) margin = cash / (1 + lev * feeRate);
  const fee = feeOf(margin);
  if (!(margin > 0) || margin + fee > cash + 1e-9) return { ok: false, why: '可用保证金不足' };

  /* OTC 的门槛（§15.3）：单笔名义 ≥ $100 万。锁定 1x ⇒ 名义 = 保证金。
     ⚠️ 门槛只卡**买入**，不卡平仓 —— 卡平仓会把玩家困在一条「币价跌下来、名义已不足 $100 万」的仓位上。 */
  if (otc && margin < OTC.min) return { ok: false, why: `OTC 单笔最少 ${fmtMoney(OTC.min)}` };

  /* 成交价（P2-B1 / P2-B3）：盘口价 ± 代价 —— 买抬、卖压，**永远对玩家不利**。
     代价有两种，同一时刻只有一种成立：盘口是平方根冲击、OTC 是「基准点差 × 市况倍数」（不吃滑点）。
     ⚠️ 保证金与开仓费都不受它影响（那两项按名义价值算，与成交价无关），
        受影响的是 `size`：买贵了就拿到的币少一点，这才是代价的真实形态。 */
  const cost = otc ? otcPremiumFor(s, s.sym) : impactFor(s.sym, s.i, margin * lev);
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

  s.books[s.ex] = cash - margin - fee;
  /* ⚠️ 开仓费是**玩家真实付出的钱**，必须同时记进「已实现」（Batch 5 · B23）——
     原来只从余额里扣、不写 `realized`，于是 HUD 副行那个数既不等于真实现金变动、
     也不等于已实现盈亏。它只被 `render.js` 读来展示，不参与任何玩法判定。 */
  s.realized -= fee;
  s.lev = lev;

  const pos = openPosition(s.sym, side, fill, margin, lev, feeRate);
  pos.i = s.i;
  pos.ex = s.ex;                    // 仓位挂在哪家所 —— 归零事件据此精确作废（GDD §7.2）
  pos.openFee = fee;
  if (otc) pos.otc = true;          // 只给 OTC 仓位打标（`capturedOf` 见到它就跳过）
  s.positions[s.sym] = pos;

  const tag = otc ? ` ｜ OTC 溢价 ${fmtRate(cost, 2)}` : slipTag(cost);
  pushLog(s, `${side === 'long' ? '做多' : '做空'} ${s.sym} ${lev}x ｜ 保证金 ${fmtMoney(margin)} @ ${showPrice(fill)}${tag}`, side === 'long' ? 'long' : 'short');

  /* 订单冲击（方案 §2.6）：把这次成交代价的**永久部分**（Almgren–Chriss 的 γQ，实证 35%）
     沉淀成行情位移 —— 从此处起价格上/下一个台阶，再按 Bouchaud 幂律慢慢回爬。
     ⚠️ 这不是重复收惩罚：`cost` 是本次成交付出的**全部**代价，这里只把其中一部分留在地上，
        剩下的就是 AC 里的「暂时冲击」（随成交结束而消失，已由成交价本身承担）。
     ⚠️ OTC 不写：私下一口价的大宗交易不落公开盘口（与它不消耗供应量同一口径）。 */
  if (!otc && s.impactOn) {
    const dir = side === 'long' ? 1 : -1;
    if (addFlow(s, s.sym, dir * SHOCK.share * cost * (s.god?.mult ?? 1))) invalidateSigma();
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
  const cost = otc ? otcPremiumFor(s, sym) : impactFor(sym, s.i, pos.size * price);
  const fill = fillPrice(price, pos.side === 'long' ? -1 : 1, cost);

  const r = closePosition(pos, fill, feeRateOf(pos.ex));
  s.books[pos.ex] = (s.books[pos.ex] ?? 0) + r.net;
  s.realized += r.pnl - r.fee;
  const tag = otc ? ` ｜ OTC 溢价 ${fmtRate(cost, 2)}` : slipTag(cost);
  pushLog(s, `平仓 ${sym} ${pos.lev}x ｜ ${r.pnl >= 0 ? '盈利' : '亏损'} ${fmtMoney(r.pnl)}（${why}）${tag}`,
    r.pnl >= 0 ? 'ok' : 'bad');
  delete s.positions[sym];

  /* 订单冲击（方案 §2.6）：**平多 = 卖、平空 = 买**，方向与开仓时相反 —— 与成交价的代价同一口径 */
  if (!otc && s.impactOn) {
    const dir = pos.side === 'long' ? -1 : 1;
    if (addFlow(s, sym, dir * SHOCK.share * cost * (s.god?.mult ?? 1))) invalidateSigma();
  }

  if (checkRuin(s)) return { ok: false, why: s.over.reason };
  return { ok: true };
}

/**
 * 强平单个仓位。触发条件是**当根 K 线的高/低**打穿强平价。
 * 结算按 GDD §10「爆仓 = 破产」：整笔保证金归零，账户其余部分原样保留。
 * ⚠️ 多仓下它**不再直接等于破产** —— 是否收摊由调用方在清点完全部仓位后看总权益决定。
 */
function forceLiquidate(s, pos, atPrice) {
  pushLog(s, `爆仓 ${pos.sym} ${pos.lev}x ｜ 保证金 ${fmtMoney(pos.margin)} 全部损失 @ ${atPrice.toFixed(4)}`, 'bad');
  s.realized -= pos.margin;
  delete s.positions[pos.sym];
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

/* ───────────────────────────── 交易所 ───────────────────────────── */

/**
 * 换所（GDD §7.2）—— P2-A 起**不再是「一键搬钱」**，而是**发起一笔链上转账**。
 * 四条规矩：
 *   ① 钱**离开旧所、等 N 根 K 线才到**（N 由拥堵指数决定，见 `congestion.js`），到账前不能动用
 *   ② **有持仓必须先全部平掉** —— 仓位是挂在这一家所上的，搬不走（多仓也一样，一条都不许留）
 *   ③ **同时只允许一笔在途**（LESS IS MORE）
 *   ④ **人先到、钱后到** —— `s.ex` 立即切到新所（可以看行情、看费率），但 `books[新所]` 要到账才加钱
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

  const amount = cashOf(s);
  if (!(amount > 0)) return { ok: false, why: '当前所没有可划转的余额' };

  // ⚠️ 顺序：**先算到账根数，再记脉冲**。口径是「你推高拥堵 ⇒ 你**下一次**转账更慢」（验收口径④），
  //    本笔转账不能受自己那一脚的影响 —— 否则第一笔在 2013 年就会被自己拖慢，说不通。
  const congestion = congestionOf(s);
  const n = arrivalCandles(congestion, id);
  const from = s.ex;

  s.books[from] = 0;                                   // 钱离开旧所，此后只记在 s.transfer 里
  s.transfer = { amount, from, to: id, departAt: s.i, arriveAt: s.i + n };
  s.ex = id;                                           // 人已经在新所，钱还在路上
  normalizeLeverage(s);                                // 新所的上限可能更低，夹取一次

  const add = bumpPulse(s, amount);                    // > 当日 BTC 流动性的 10% 才算大额
  pushLog(s, `转账 → ${ex.name} ｜ ${fmtMoney(amount)} ｜ 拥堵${congestionLabel(congestion)} · ${n} 小时后到账`
    + (add ? ` ｜ 推高拥堵 +${add.toFixed(1)}` : ''), 'info');
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
  const lost = s.books[ex.id] ?? 0;
  s.books[ex.id] = 0;

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
  if (!s.pending || s.loan) return { ok: false, why: '现在没有可借的额度' };

  const amount = loanAmountAt(timeOf(s));
  const owe = amount * (1 + LOAN.ratePerDay * LOAN.days);
  s.loaned = true;
  s.loan = { amount, owe, dueAt: s.i + LOAN.days * 24 };
  s.books[s.ex] = (s.books[s.ex] ?? 0) + amount;
  s.pending = null;
  s.paused = false;
  pushLog(s, `借款 ${fmtMoney(amount)} ｜ ${LOAN.days} 天后还 ${fmtMoney(owe)}`, 'info');
  return { ok: true };
}

/** 「就此收摊」—— 归零遮罩上的灰键（`data-loan="give"`）。真的结束本局。 */
export function giveUp(s) {
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
      const r = closePosition(pos, fillPrice(price, pos.side === 'long' ? -1 : 1, impact), feeRateOf(pos.ex));
      s.books[pos.ex] = (s.books[pos.ex] ?? 0) + r.net;
      s.realized += r.pnl - r.fee;
    } else {
      s.books[pos.ex] = (s.books[pos.ex] ?? 0) + pos.margin;   // 取不到价：按权益口径退回保证金
    }
    delete s.positions[sym];
  }

  const owe = s.loan.owe;
  const pool = (s.books[s.ex] ?? 0) + (s.transfer ? s.transfer.amount : 0);
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
  s.books[s.ex] = (s.books[s.ex] ?? 0) - rest;
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
    s.books[tr.to] = (s.books[tr.to] ?? 0) + tr.amount;
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

  // ⚠️ 上一步可能已经进了「待借贷」的待决态（B30）：时钟停了，后续的资金费 / 强平都不该再跑。
  if (s.pending) return;

  // 借款到期结算（B30）：排在交易所归零**之后**、资金费**之前** ——
  // 归零已经把该作废的仓位作废了，而到期清仓必须先于资金费（否则会为已经要平的仓位再扣一次）。
  if (settleLoan(s)) return;

  // 资金费率每 8 游戏小时结算一次，只结算合约仓位（现货没有这一项）
  if (s.i % FUNDING.hours === 0 && settleFunding(s)) return;

  liquidateAll(s);
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
 * 资金费率结算（GDD §9.5）。每隔 `FUNDING.hours` 游戏小时，把**每一个合约仓位**
 * 该期应付的名义价值 × 费率从它的保证金里扣掉（应收则加回去）。
 *
 * 溢价指数是**合成的** —— 口径与理由见 `positions.js` 的 `FUNDING` 注释：
 * 数据包里每个币只有一条真小时线，拿不到「合约价 vs 现货价」两条线，
 * 故以「近 8 根真实涨跌幅 ÷ 近 30 天的典型波动」当溢价（Batch 4 · B18），
 * 上限按年代走（2013–2018 → 0.5%、2019–2021 → 0.3%、2022 起 → 0.1%）。
 *
 * @returns {boolean} 是否因结算后总权益归零而结束本局
 */
function settleFunding(s) {
  const syms = heldSyms(s);
  if (!syms.length) return false;

  const cap = fundingPremiumCapAt(timeOf(s));      // 溢价上限按年代，同一时刻所有币一样

  let net = 0;              // > 0 = 玩家整体支出
  let gross = 0;            // 参与结算的名义价值之和（用来把净额折算回一个综合费率）
  for (const sym of syms) {
    const pos = s.positions[sym];
    if (isSpot(pos)) continue;                       // 现货不参与资金费率

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
    net += fee;
    gross += pos.size * mark;
  }

  if (net !== 0 && gross > 0) {
    // 各币各看各的动量，费率并不相同 —— 日志只报一个**按名义价值加权的综合费率**，
    // 它恰好能自洽地解释那个净额，不会出现「费率写 +0.01% 却收钱」这种读不通的情况。
    const rate = net / gross;
    /* 文案（Batch 4 · B18，2026-09-29 拍板）：金额一律是**玩家视角的总收益**，
       「收益 +$0.03」= 拿到 U、「收益 −$0.05」= 付出 U ——
       正负号本身就是方向，不再写「支出 / 收入」四个字（日志条一行 nowrap，多两个汉字就挤爆）。 */
    pushLog(s, `资金费率 ${fmtRate(Math.abs(rate), 4)} ｜ 收益 ${fmtMoney(-net, { sign: true })}`,
      net > 0 ? 'bad' : 'ok');
  }

  return checkRuin(s);
}

/**
 * 逐仓强平：每个仓位各自用**当根 K 线的高低点**判定（见文件头注释）。
 * 现货仓位（1x 做多）跳过 —— 它只有币价归零才归零本金，不因 0.5% 维持线被强平（GDD §9.1）。
 * @returns {boolean} 是否因此结束了本局
 */
function liquidateAll(s) {
  for (const sym of heldSyms(s)) {
    const pos = s.positions[sym];
    if (isSpot(pos)) continue;

    const c = candleAt(sym, s.i);
    if (!c) continue;

    const liq = liquidationPrice(pos);
    const hit = pos.side === 'long' ? c.l <= liq : c.h >= liq;
    // 强平价一定是「可达」的：多头被砸到 liq（≤ 当根低点），空头被拉到 liq（≥ 当根高点）
    // 兜底：即便没打穿强平价，保证金率也可能已经趴在维持线上（例如极端跳空或刚扣完资金费）
    const mark = pos.side === 'long' ? c.l : c.h;
    if (hit || isLiquidatable(pos, mark)) {
      forceLiquidate(s, pos, liq);
      if (checkRuin(s)) return true;
    }
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

/** 当前可用杠杆档位随「时间 + 所选交易所」变化，切换币种 / 换所 / 走时间后都要夹取一次 */
export function normalizeLeverage(s) {
  const max = maxLeverageAt(timeOf(s), s.ex);
  if (s.lev > max) s.lev = max;
  if (s.lev < 1) s.lev = 1;
}

/** 某个币此刻能不能交易（已解锁 + 数据已加载） */
export function tradable(s, sym) {
  const coin = coinOf(sym);
  if (!coin) return false;
  if (timeOf(s) < coin.unlock) return false;
  if (!hasCandle(sym, s.i)) return false;
  return true;
}
