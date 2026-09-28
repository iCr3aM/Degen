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

import { GAME, HOUR_MS, EXCHANGES, coinOf, exchangeOf, maxLeverageAt, feeRateOf } from './config.js';
import { candleAt, closeAt, hasCandle, isLoaded, loadCoin } from './market.js';
import { arrivalCandles, bumpPulse, congestionLabel, congestionOf, decayPulse } from './congestion.js';
import { fmtMoney, fmtRate } from './format.js';
import {
  closePosition, equityOf, isLiquidatable, isSpot, liquidationPrice, openPosition, pnlOf,
  FUNDING, fundingOf, fundingRateOf,
} from './positions.js';
import { cashOf, heldSyms, posOf, pushLog } from './state.js';

/** 交易所归零前多少毫秒给一条预警日志（7 天） */
const WARN_LEAD = 7 * 24 * HOUR_MS;

/** 一局结束的原因 */
export const OVER = {
  LIQUIDATED: 'liquidated',   // 爆仓，保证金全部损失且账户清零
  SETTLED: 'settled',         // 活到 2024-12-31 收盘
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

/**
 * 账户权益归零即破产（GDD §1.3）。
 *
 * ⚠️ 容差不是可选项：`margin = cash / (1 + lev×feeRate)` 之后再减 `margin + fee`，
 *    浮点残渣会留下 ~1e-13 的「现金」，于是「已经归零」的账户永远过不了 `<= 0` 这一关，
 *    游戏既不结束、也不弹结算遮罩，只是卡在 $0.00 上继续走时间（2026-09-28 实测）。
 */
const isBankrupt = s => equity(s) <= 1e-9;

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

  const coin = coinOf(s.sym);
  if (!coin || !isLoaded(s.sym)) return { ok: false, why: '行情还没加载完' };
  if (timeOf(s) < coin.unlock) return { ok: false, why: `${s.sym} 还没上线` };

  const price = markPrice(s, s.sym);
  if (!(price > 0)) return { ok: false, why: '当前没有可成交的价格' };

  // 杠杆上限与费率都取**玩家当前所在的交易所**（GDD §7.1）
  const lev = Math.max(1, Math.min(s.lev, maxLeverageAt(timeOf(s), s.ex)));
  const feeRate = feeRateOf(s.ex);
  const cash = cashOf(s);

  // 保证金 = 可用余额 × frac；开仓费按名义价值另收，所以要让「保证金 + 费 ≤ 余额」
  let margin = cash * Math.max(0.0001, Math.min(1, frac));
  const feeOf = m => m * lev * feeRate;
  if (margin + feeOf(margin) > cash) margin = cash / (1 + lev * feeRate);
  const fee = feeOf(margin);
  if (!(margin > 0) || margin + fee > cash + 1e-9) return { ok: false, why: '可用保证金不足' };

  s.books[s.ex] = cash - margin - fee;
  s.lev = lev;

  const pos = openPosition(s.sym, side, price, margin, lev, feeRate);
  pos.i = s.i;
  pos.ex = s.ex;                    // 仓位挂在哪家所 —— 归零事件据此精确作废（GDD §7.2）
  pos.openFee = fee;
  s.positions[s.sym] = pos;

  pushLog(s, `${side === 'long' ? '做多' : '做空'} ${s.sym} ${lev}x ｜ 保证金 ${fmtMoney(margin)} @ ${price}`, side === 'long' ? 'long' : 'short');
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

  const r = closePosition(pos, price, feeRateOf(pos.ex));
  s.books[pos.ex] = (s.books[pos.ex] ?? 0) + r.net;
  s.realized += r.pnl - r.fee;
  pushLog(s, `平仓 ${sym} ${pos.lev}x ｜ ${r.pnl >= 0 ? '盈利' : '亏损'} ${fmtMoney(r.pnl)}（${why}）`,
    r.pnl >= 0 ? 'ok' : 'bad');
  delete s.positions[sym];

  if (isBankrupt(s)) return endGame(s, OVER.LIQUIDATED);
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
  pushLog(s, reason === OVER.LIQUIDATED ? '账户归零，游戏结束' : '活到了 2024-12-31，结算', reason === OVER.LIQUIDATED ? 'bad' : 'ok');
  return { ok: false, why: reason };
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

  if (isBankrupt(s)) { endGame(s, OVER.LIQUIDATED); return true; }
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
  if (s.over) return;
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

  // 资金费率每 8 游戏小时结算一次，只结算合约仓位（现货没有这一项）
  if (s.i % FUNDING.hours === 0 && settleFunding(s)) return;

  liquidateAll(s);
}

/* ───────────────────────── 资金费率与强平 ───────────────────────── */

/**
 * 资金费率结算（GDD §9.5）。每隔 `FUNDING.hours` 游戏小时，把**每一个合约仓位**
 * 该期应付的名义价值 × 费率从它的保证金里扣掉（应收则加回去）。
 *
 * 溢价指数是**合成的** —— 口径与理由见 `positions.js` 的 `FUNDING` 注释：
 * 数据包里每个币只有一条真小时线，拿不到「合约价 vs 现货价」两条线，
 * 故以近 8 根的真实涨跌幅归一化后当溢价。
 *
 * @returns {boolean} 是否因结算后总权益归零而结束本局
 */
function settleFunding(s) {
  const syms = heldSyms(s);
  if (!syms.length) return false;

  let net = 0;              // > 0 = 玩家整体支出
  let gross = 0;            // 参与结算的名义价值之和（用来把净额折算回一个综合费率）
  for (const sym of syms) {
    const pos = s.positions[sym];
    if (isSpot(pos)) continue;                       // 现货不参与资金费率

    const mark = markPrice(s, sym);
    if (!(mark > 0)) continue;

    const prev = closeAt(sym, s.i - FUNDING.window);
    const rate = prev > 0 ? fundingRateOf(mark / prev - 1) : fundingRateOf(0);

    const fee = fundingOf(pos, mark, rate);
    pos.margin -= fee;
    net += fee;
    gross += pos.size * mark;
  }

  if (net !== 0 && gross > 0) {
    // 各币各看各的动量，费率并不相同 —— 日志只报一个**按名义价值加权的综合费率**，
    // 它恰好能自洽地解释那个净额，不会出现「费率写 +0.01% 却收钱」这种读不通的情况。
    const rate = net / gross;
    // 文案（Batch 2 · B8，2026-09-29 拍板）：**只写带符号的金额**，不再写「支出 / 收入」四个字 ——
    // 「−$0.05」已经同时表达了方向和数额，多两个汉字只是把日志条挤爆（日志条一行 nowrap + 省略号）。
    // 符号取自玩家视角：`net > 0` = 应付 ⇒ 金额取负。
    pushLog(s, `资金费率 ${fmtRate(Math.abs(rate), 4)} ｜ ${fmtMoney(-net, { sign: true })}`,
      net > 0 ? 'bad' : 'ok');
  }

  if (isBankrupt(s)) { endGame(s, OVER.LIQUIDATED); return true; }
  return false;
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
      if (isBankrupt(s)) { endGame(s, OVER.LIQUIDATED); return true; }
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
        if (s.over) { acc = 0; break; }
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
