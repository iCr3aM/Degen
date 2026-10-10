/**
 * 交易与时间引擎（GDD §4 / §9 / §10 / §11）
 * ===============================================================
 * 这里只有三件事：**推进时间**、**改状态**、**判破产**。不碰 DOM，不读 `Date.now()`
 * （时钟从 `main.js` 注入，这样无头测试才能复现「50x 跑完 12 年」这类断言）。
 *
 * 时间的真相源只有一个：`s.i`（第几根小时 K 线）。
 * K 线推进 = 真实秒 × 倍速 ÷ 1 秒/根（GDD §11：1x 下 1 游戏小时 = 1 真实秒）。
 *
 * ⚠️ 强平判定必须用**当根 K 线的高低价**，不能用收盘价。
 *    收盘价只在整点变一次，用收盘价判强平会把「一根针」整个吞掉 ——
 *    而 100x 下 0.5% 的逆向波动正是被针扎出来的，那才是这个游戏的核心体验（GDD §14）。
 */

import { GAME, HOUR_MS, COINS, EXCHANGES, EXREV, LIQ, MARGIN, MIN_NOTIONAL, minNotionalAt, notionalMaxLevAt, openNeedAt, OTC, SUPPLY_SHARE, FLOAT, ADV, USDT_LIVE, BAND, coinOf, exchangeOf, hasFinancingAt, hasLeverageKindAt, isChallenge, maxLeverageAt, feeRateOf, marginDailyRateAt, railAt, railFeeOf, cashCurAt, loanAmountAt, otcPremiumOf, otcMinAt, otcUnlockAt, usdtPriceAt, haltedAt } from './config.js';
import { candleAt, closeAt, dayIndexOf, hasCandle, isLoaded, liqOf, loadCoin, rangeOf, rawCandleAt, rawCloseAt, supplyAt, volumeAt, HOURS_PER_DAY } from './market.js';
import { newsStartAt, resultNewsStartAt, warnAnchorAt } from './anchors.js';
import { arrivalCandles, bumpPulse, congestionOf, decayPulse, extraConfirmations } from './congestion.js';
import { SLIP, baseLadder, fillPrice, hourShareK, impactOf, LADDER, permImpactOf, POOL, poolRefill, sigmaOf, walkBook } from './impact.js';
import { CDRI, CONTAGION, FNG, HEAT, INV, NPC, OI, SHOCK, MANIP_GOD_CAP, MANIP_MIN, MANIP_NEWS_CD, MANIP_NEWS_Q, MANIP_NEWS_RANGE, MANIP_PIN, MANIP_SPOOF_NUDGE, addFlow, amtOf, etfFlowAt, etfNewsAt, exDevOf, instSeedOf, manipTplsOf, npcLevOf, playerFactor, sbBiasTargetOf, sbOf, shockAccForgetFile, shockParamsOf, whaleFlowAt, whaleNewsAt } from './god.js';
import { absorbOf, levelsOf, WALL_K } from './levels.js';
import { fmtDate, fmtLogPrice, fmtMoney, fmtMoneyShort, fmtPct, fmtQty, fmtRate } from './format.js';
import {
  equityOf, isLiquidatable, isMargin, liquidationPrice, maintRateOf, marginRateOf, openPosition, pnlOf,
  reduceFraction, reducePosition,
  FUNDING, FR, INSURE, CPOOL, fundingOf, premiumIndexOf, fundingRateOf, canLiquidate, paysFunding, paysInterest, borrowedOf, borrowCurOf, shockKindOf,
  bankruptcyFillPrice, effLevOf,
} from './positions.js';
import { blankBook, bookOf, cashOf, capturedOf, credit, debit, ensureBook, heldSyms, posOf, pushLog, spendableOf, usdtHeldOf } from './state.js';
import { pathOf } from './simulate.js';
import { hashStr, rand, randFast } from './rng.js';
import { addCareer, thinEq } from './careers.js';
/* 结束本局时要把**本槽的档**清掉（2026-10-04 用户拍板）—— 已结束的局不许再被「读取存档」捞回来。
   与 `careers.js` 同一条分层豁免：两者都是「跨局/落盘」的事，收在 core 里比让 UI 反向记住更干净。 */
import { saveSlotOf, wipe } from './save.js';

/** 交易所归零前多少毫秒给一条预警日志（7 天） */
const WARN_LEAD = 7 * 24 * HOUR_MS;

/**
 * 交易日志里的**倍数标签**（2026-10-05）—— 读**实际杠杆**（`effLevOf`）而不是开仓冻结的 `pos.lev`。
 *
 * ⚠️ 为什么：滚仓抽走保证金后仓位真的更杠杆化了（保证金↓ ⇒ 杠杆↑），日志若还写开仓倍数，
 *    就会与持仓条 / 资产页 / 调整保证金弹窗（都已改读实际杠杆）**自相矛盾** —— 玩家会看到
 *    「持仓条写 5x、平仓日志写 1x」。整数不显小数、非整数保留 1 位，与 `render.js` 同一套格式化。
 * ⚠️ virgin 仓 `effLevOf` snap 回 `pos.lev` ⇒ 未调整过保证金的仓位日志**一字不变**。
 */
const lvTagOf = pos => `${Math.round(effLevOf(pos) * 10) / 10}x`;

/* ── 逐步强平（2026-10-01 拍板 · 2026-10-03 对齐 Binance） ──
 * 触发时**只平一档**，把剩余仓位的保证金率拉回 `PARTIAL_TARGET` 倍维持线，而不是整条打掉。
 * 参考：Binance 逐仓合约到维持线时下 IOC 单平掉一部分，直到保证金率回到维持线**之上**；
 * Bybit 则是减到「维持保证金率回到 90%」。真实交易所留的垫子很薄（刚过线一点点就停手），
 * 本作原来取「1.5 倍维持线」—— 一刀砍掉 **1/3**，比交易所狠得多（用户审计：强制减仓不符合现实）。
 *
 * 2026-10-03 拍板收到 **1.1**（用户圈定区间 1.05–1.1，取上沿）：每档只削
 * `1 − 1/1.1 ≈ 1/11`（9.09%），与 Binance「削到刚过维持线就停」同一量级；
 * 取上沿而不是 1.05 的理由是**触发间距**——1.05 时每刀只把强平线推远 `5% × 维持线`（≈0.025% 价格），
 * 同一根 K 线会反复触发、日志刷屏；1.1 给 10% × 维持线（约 0.05% 价格）的垫子，
 * 在「像交易所」与「不刷屏」之间取平衡。
 * ⚠️ 垫子薄了 ⇒ 同样的暴跌里**档数变多**，故 `PARTIAL_STEPS` 同步上调以保住每小时的保护力度。 */
const PARTIAL_TARGET = 1.1;

/**
 * 同一根 K 线内最多连打几档（缓跌穿线 → 部分强平把强平价推远 → 继续跌 → 再穿）。
 *
 * ⚠️ **必须跟着 `PARTIAL_TARGET` 一起调**：每小时最多削掉的仓位比例 =
 * `1 − (1 − frac)^PARTIAL_STEPS`，而 `frac = 1 − 1/PARTIAL_TARGET`。
 *   原档（1.5 / 6）：`(2/3)^6 = 0.0878` ⇒ 每小时最多削 **91.2%**；
 *   新档取 **26**：`(1/1.1)^26 = 0.0840` ⇒ 每小时最多削 **91.6%** —— 与改动前**等量**。
 * 若只改 `PARTIAL_TARGET` 而不动本值，每小时保护力度会从 91% 掉到 44%，玩家更容易「挂着不被爆」。
 * ⚠️ 它只是**安全闸**（防一根 K 线里无限循环）：真正的终止条件仍是「路径走完」或权益 ≤ 0。
 */
const PARTIAL_STEPS = 26;

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

/* ═══════════════════ 三价体系：index / mark / last（2026-10-03 拍板） ═══════════════════
 * 现实口径（Binance 官方）：强平与未实现盈亏走**标记价 mark**，已实现盈亏走**最新价 last**，
 * 而 `mark ≈ 指数价 index ＋ 基差的平滑`（`Mark = Median(P1, P2, Last)`）。这正是
 * 「一笔插针不该把全场爆掉」的机制来源 —— 也是 mark price 存在的**全部**理由。
 *
 * 本作的病（2026-10-03 审计 §14.1 A1）：全局只有一个价（= 收盘价），于是
 *   ① 未实现盈亏 / 保证金率 / 安全垫读**收盘价**，强平判据却读**当根高低点 ＋ 121 点布朗桥**
 *      ⇒ 一根影线已经把你爆了，显示屏上「安全垫」还是健康的；
 *   ② 玩家自己的推价（`advPush` / `npcDrift`）也乘进了高低点
 *      ⇒ **你砸盘砸出的插针把你自己的仓打掉**。
 *
 * 三价的分工（拍板）：
 *   · `indexPrice` = **原始行情**（`rawCloseAt`，不含任何位移）—— 那根「现货锚」；
 *   · `lastPrice`  = 数据包 × 位移（`closeAt`）—— **实际成交价** / K 线 / 已实现盈亏；
 *   · `markPrice`  = `index + EMA(last − index)`，基差半衰期 = `ADV.pushHalf`（同族缓动）——
 *                    **未实现盈亏 / 保证金率 / 强平 / 资金费**只读它。
 * ⇒ 位移里的**瞬时**部分（自己砸出的插针、NPC 级联脉冲）被低通滤掉；**持续**部分（真实行情移动、
 *    有量支撑的位移）数小时内收敛进 mark。指数那一层永远即时 —— 真行情砸下来照样立刻爆你。
 */

/** 标记价基差的半衰期（小时）—— 复用档 2 推价的缓动常数，两者同族 */
const MARK_HALF = ADV.pushHalf;
/** 一阶低通系数 `α = 1 − 0.5^(1/半衰期)`（与 `stepAdvPush` 同一个式子） */
const MARK_ALPHA = 1 - Math.pow(0.5, 1 / MARK_HALF);

/** **指数价** —— 原始行情收盘，不含任何位移。取不到（未上线 / 越界）返回 null。
 *  ⚠️ 不导出（2026-10-04 审计 R6）：仅 `markPrice` / `advanceMarkBias` 用；外部一律走 `markPrice`。 */
function indexPrice(s, sym = s.sym) {
  return rawCloseAt(sym, s.i);
}

/** **最新价** —— 数据包 × 位移（玩家 + NPC）。成交 / 平仓 / K 线 / 已实现盈亏读它。
 *  ⚠️ 它就是改动前的 `markPrice`（口径**逐位不变**），只是名字改成了它本来的身份。 */
export function lastPrice(s, sym = s.sym) {
  return closeAt(sym, s.i);
}

/* ── 上帝浮窗 · 只读快照（2026-10-07 用户拍板「浮窗：清算热力图 / 巨鲸 / 深度」；同日加第 4 页订单簿） ── */
/**
 * 上帝浮窗**全部数字**都从这一个出口出 —— 纯派生：不写 `s`、不碰 DOM、不读时钟，
 * render 只管画，engine 是唯一的事实来源（审计 9u 逐位锚定）。
 *
 *   · `liqs`  清算热力图：NPC 六档 ＋ 做市盘每侧的**强平价位** —— 与 `flushSlot` **同一个公式**
 *             （long = 均价 × (1 − drop)、short = 均价 × (1 + drop)，`drop = 1/lev − GAME.maintRate`，
 *              lev 过 `npcLevOf` 年代封顶）；名义为 0 的侧不列，`w` = 占全部 NPC 名义的比（条宽用）。
 *   · `tiers` 巨鲸：六档明细（杠杆 / 权重 / 双侧名义与均价）＋ 做市盘行 ＋ `heat` / `mood` 读数。
 *   · `depth` 深度：日流动性、本小时基准深度、瞬时深度池（已消耗 / 容量 `POOL.capK × 基准`）、
 *             滑点死区线（`SLIP.threshold × liqDay`）与单笔饱和线（`SLIP.cap × liqDay`）。
 *   · `book`  订单簿：**NPC 限价单离散簿**（`s.lob`，2026-10-08 三批拍板⑦）＋ 压力位墙
 *             （`bookForWatch`，普通局浮窗也读这一份）。
 */

/**
 * **盘口步长**（1-2-5×10ⁿ 可读网格）—— 订单簿页显示与 NPC 挂单落格**共用同一把尺子**：
 * ×1 档单格 ≈ 0.2%（BTC@108k→200 · ETH@3.9k→10 · XRP@2.3→0.005 · DOGE@0.16→0.0002）。
 * ⚠️ 2026-10-08 三批起从 render.js 上收到 engine：`lobTick` 要把挂单**吸附**到步长格上
 *（真实交易所的限价单都钉在 tick 网格），显示与状态必须同源，不许各算各的。
 */
export function niceStepOf(p) {
  const raw = p * 2e-3;
  const e = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / e;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * e;
}

/**
 * **NPC 限价单离散簿**（2026-10-08 三批拍板⑦「限价单系统，只给 NPC 加入」）——
 * 一本**行为级**的挂单账：每小时每币生成真实的离散限价单（近场指数 ＋ 远场幂律 ＋
 * 整数关口加成），按距离随时间撤单，被行情吃穿的档**跳价回填**（做市商把墙补得更厚）。
 *
 * 为什么这样做（拍板口径 R1「行为级离散簿」）：
 *   · **近场指数** λ(δ) ∝ e^(−kδ)：做市商报价簇随价距指数衰减（近场致密）；
 *     δ 以盘口步长格计（`niceStepOf`）。⚠️ A-S 的 λ(δ)=A·e^(−kδ) 本义是**成交强度**
 *     不是挂单密度（2026-10-10 调研澄清）——这里只借「贴盘密集」的形状，不外推到远场。
 *   · **远场幂律（账本剖面）**：价值单价距走**截断幂律** ρ(δ) ∝ δ^(−farMu)
 *     on [farD0, 400] 格 —— Bouchaud-Mézard-Potters 2002 实测账本密度剖面 µ≈0.6
 *     （Lillo 2006 澄清：µ=0.6 是「账本存储密度」，Zovko-Farmer 2002 的 1.5 是
 *     「单笔挂单价距」，两者是不同的量；账本剖面才是渲染订单簿该对的口径）。
 *     累计深度 D(δ) ∝ δ^0.4 ⇒ ±10% 累计深度 ≈ ±0.1% 的 6 倍、**同数量级**——
 *     「越远越接近零」在真实 LOB 里不存在（Binance 现货实测 ±0.1%≈$7-8M / ±1%≈$20M，
 *     CoinGlass：Binance 合约 ±1% 双边 $236M，比值吻合 δ^0.4）。
 *   · **大小**：对数正态（近场）/ Pareto 重尾（远场与位聚集单）—— 单笔大小与挂单距离
 *     **近独立**（Mike & Farmer 2008 实测；Lillo 2006 的解释：耐心的大资金挂得更远，
 *     宏观上已由「远场=大单」的分布重叠表达，不再显式耦合）。
 *   · **整数关口**：落格后若是 5/10 倍格（人类整数价）名义 ×1.5~3
 *     （Urquhart 2017 / Hu et al. 2019 的 round-number 聚集；3~10× 是实践值非实证）。
 *   · **支撑 / 压力位聚集**（2026-10-10 · 用户拍板「人人都想低买高卖」）：历史压力位
 *     （`levelsOf` 的量价密集区 ＋ 摆动高低点）是全市场公认的挂单磁铁 —— 每小时每侧对
 *     本侧每一条在册位钉一笔大单（×位权重），同价合并几小时就堆出肉眼可见的墙。
 *     CoinGlass 清算热力图的「磁吸区」同构：显著价位上的聚集强度远超背景。
 *   · **撤单**：寿命 = `life0 × (1 + δ/δc)` —— **远场单活得久**（2026-10-10 反转旧口径）：
 *     远处的价值单是耐心单（Krause et al. 2021 两 regime：近场「流动性垫」密集短命、
 *     远场稀疏但长寿命单恒在），账本剖面的幂律正是「持续挂单 ＋ 长寿命」积累出来的。
 *     抖动用**价签哈希**（无随机数）。
 *   · **买侧不对称** ×1.6：加密市场的买盘深度系统性偏厚（历史上「抄底墙」）。
 *   · **吃穿回填**：就地同格补回被吃量的一部分（期望≈中性游走）；残量低于**最小名义
 *     下限** ⇒ 整档退场 —— 做市商不会留碎渣（2026-10-10 尘埃闸，见 `LOB.minRel`）。
 *
 * ⚠️ **与成本模型的关系（红线 A · 不双重计价）**：连续曲线（`baseLadder` / `walkBook`）
 *    **原样保留**，仍是玩家吃单成本与「总量基线」—— 簿的总名义被治理器（`lobTick` 内的
 *    `sMul`）锚在 `LOB.capQ × 本小时基准深度` 附近，但**不进任何代价计算**；深度旋钮
 *    / 审计口径逐位不变。簿只负责**显示**（`bookForWatch`）＋ **tape 播报**（大档被吃穿
 *    时按主动方向进 `s.feed`，见下）。
 * ⚠️ **tape 双层的自洽口径**：M2 的事件流播的是 NPC **主动决策单**（建/减/护/爆 —— 吃的是
 *    连续层）；本簿播的是**被动挂单被行情吃穿**（吃的是挂单层）。同一小时两边都有 prints
 *    不是重复计数 —— 在本作的本体论里它们是**两批不同的订单**（就像真实 tape 里
 *    taker 单与被扫掉的 maker 挂单本就是两回事）。每小时每币上限 `LOB.feedMax` 条。
 * ⚠️ **随机数**：走 `randFast`（32 位轻量通道，chan='lob'）—— 不污染行情/决策通道，
 *    也不把全周期重放拖进 BigInt 的性能坑；撤单抖动用价签哈希（零随机数）。
 *    同一存档同一时刻 ⇒ 同一本簿（`rewindTo` 清空后重放逐位复现）。
 */
/* ⚠️ 2026-10-08（M4a · 用户报「数量变动太快、像量化、100k → 几千」）—— 队列化改造：
   病根三条（离线实测确认）：① 整格 `splice` 吃穿 ⇒ 该侧质量瞬间归零、下一小时又被治理器
   批量重生成（`sMul` 夹到 4×）⇒ 30× 摆动；② 回填**跳到更远一格** ⇒ 贴中档消失、下一小时再重生成；
   ③ 近场每小时仅 2~18 笔 × `sizeSig 1.2` ⇒ 单笔就是几千~十万的量级跳。
   修法：吃穿改**部分消费**（余量留原价）＋ 回填**就地同格**＋ `sMul` 夹口 0.25~4→0.2~2 ＋
   近场笔数 8→20（泊松噪声 ÷√2.5）＋ `sizeSig` 1.2→0.6（去掉十万级个例）＋ 关口加成 3~10→1.5~3。
   终值（离线 720h 实测）：单侧总量 CV 52.5%→39.4%、逐小时单侧变动中位 4.5%、
   **同一价格档**跨小时变动中位 2.8%（P90 45.5%）、簿总深/日量 93.6%→37.7%。
⚠️ 2026-10-10（用户报「调了 ×8 深度 ×3 密度，远处挂单仍出现数量 <1」＋「人人都想低买高卖，
   远处支撑/压力位应该特别多挂单」）—— 远场重构（联网调研定口径，见头注）：
   病根三条（离线 240h 实测，`tools/tmp-lob-audit.mjs`）：① 吃穿回填的 15% 不补路径复利缩水
   ⇒ 远区积满残渣（2014 普通局 10–30% 远区 72 笔里 45 笔 qty<1，最小 $68），且离散残渣
   **盖住**空桶本该显示的潜在基线；② 远场帕累托 α=1.8（密度 ∝ δ^-2.8）＋ 每小时仅 0.3 笔
   ⇒ 比账本剖面经验口径薄一个数量级以上，70% 外**整片为 0**；③ 寿命公式 `life0/(1+δ/δc)`
   让远场单死得比近场**快** —— 与「远处价值单=耐心单」恰好相反，积累不起来。
   修法：远场改**账本剖面截断幂律** ρ∝δ^-0.6（`farMu`）＋ 每小时 1 笔（`farP`）＋ 寿命反转
   `life0×(1+δ/δc)` ＋ 支撑/压力位聚集单（`levelQ`）＋ 最小名义下限（`minRel`，尘埃闸）。
   治理器 `sMul` 自动把总深锚回 `capQ`，近场相应收窄 —— 总盘不变、形状重分配。 */
export const LOB = {
  /* 一侧总深上限（q = 名义 ÷ **当日成交量**）—— 这是治理器 `sMul` 的**设定点**，
     校准到「簿总深（双边）≈ 日成交量 30~40%」（Donier & Bouchaud 2015 口径）。
     实测（离线 `tools/tmp-m4-sim.mjs` · BTC 720h · 2026-10-08 M4a 终值）：0.056 ⇒ 双边 37.7%。
     ⚠️ 只有当 `sMul` 夹口 0.2~2 **不触底**时它才是设定点（见 `lobTick` 治理器注）。 */
  capQ: 0.056,
  /* 2026-10-09 改：`near` 20→70、`kNear` 0.16→0.04（近场铺得更平更远）。
     病根（用户报「×20 远处挂单为 0」）：旧近场 k≈0.16/格 ⇒ 价距中位仅 13 格（±2%），
     簿真实 reach 只到 ±16%；而 ×20 一屏 ±67% ⇒ 视野外**必然**是 0。
     改后价距中位 ~30 格、reach ~28%，每一档口径都落在簿的真实 reach 内。
     ⚠️ 铺平会同步抬高总深；单笔大小 `nearQ` 按笔数反比缩回去（近场单更多更小），
     并放开治理器夹口下限（见 `lobTick`）⇒ 总深仍锚 `capQ`（≈日成交量 30~40%）。 */
  near: 70,            // 每小时每侧新生成的近场单数（× 沙盒旋钮 × 治理器）
  kNear: 0.04,         // 近场指数衰减 k（每格；格 ≈ 0.2% 价距）—— 只管近场 mm 簇，不外推远场
  farP: 1.0,           // 每小时每侧远场价值单**笔数**基准（× 密度旋钮；小数 = 概率尾数）—— 0.30→1.0（2026-10-10：远场是持续存在的价值单流，不是稀客）
  farD0: 15,           // 远场价距下限（格，≈±3%）
  farMu: 0.6,          // 远场账本剖面指数 ρ(δ)∝δ^-µ（BMP 2002 / Lillo 2006；旧 farA=1.8 是单笔口径且过薄，退役）
  /* 极远整数关口单（2026-10-10 · 用户拍板「6 万 BTC 挂 12 万真实存在」）：幂律截断 ±80%
     是**显示可达性**边界，不是物理边界 —— 真实极远单是「期权式」赌极端波动：稀疏、长寿、
     高度集中在整数关口（round number effect：12.0 万整常见、11.37 万几乎总空）。
     距离 400~farXMax 格均匀 ＋ 吸附 10 格大关口（gateMax ×3 自动放大）；
     玩家看不见也不会被吃 —— 账本真实感 ＋ 将来清算图/磁吸位功能的原料。 */
  farX: 0.05,          // 极远关口单每小时每侧笔数基准（× 密度旋钮；小数 = 概率尾数）
  farXMax: 1200,       // 极远距离上限（格，±240%）—— 寿命筛的 d 退场线与此同源（旧 400）
  sizeSig: 0.6,        // 挂单大小对数正态 σ（1.2→0.6：去掉十万级个例）
  nearQ: 0.00009,      // 近场单中位大小（q 单位）—— 0.0015→0.00042（M4a）→ 0.00009（2026-10-09 铺平后按笔数反比缩）
  farQ: 0.00084,       // 远场单 Pareto 尺度（q 单位）—— 0.015→0.0039（M4a）→ 0.00084（2026-10-09 随 nearQ 同比例缩，保持 9.3× 近场比值）
  levelQ: 0.0005,      // 支撑/压力位聚集单中位大小（q 单位）×(0.5 + 位权重)（2026-10-10 新增）
  life0: 14,           // 撤单基线寿命（小时）—— 近场（δ≪δc）≈ 14h 不变
  lifeDist: 200,       // δc（格）—— 寿命 = life0 **×**(1+δ/δc)（2026-10-10 反转：远场单活得久，账本幂律靠积累）
  gateMin: 1.5, gateMax: 3,  // 整数关口加成区间（3~10 → 1.5~3：不再造 10× 巨档）
  /* **最小名义下限**（2026-10-10 尘埃闸 · 用户拍板「全市场的订单薄不该出现数量 <1 的挂单」）：
     任何挂单（生成 / 回填残量）名义 < `max(该档价格, minRel × 深度尺子)` ⇒ **不挂 / 整档退场**。
     `该档价格` 那一项保证 qty = 名义 ÷ 价格 **恒 ≥ 1**（早期年代价格/流动性比极高时自动接管）；
     `minRel × 深度尺子` 是市场比例项（Binance 最小名义 $5 是单所散户盘口，全市场聚合口径
     的最小可见档大三个数量级）。随深度旋钮同倍放大（市场 ×8 ⇒ 最小单 ×8）。 */
  minRel: 2.5e-5,
  bidEdge: 1.6,        // 买侧深度不对称（×1.2~2 的中值）
  refillP: 0.85,       // 吃穿后回填概率
  /* 回填改为**期望刚好补平**被吃掉的那一份（2026-10-08 M4a v2）：原口径补 0.63× 吃掉量 ⇒
     每被扫一次档位净减 ~22%，连续被扫十几小时就衰减到「几千」（用户报的 100k→几千），
     再被新生补上时又弹回十万级 ⇒ 1.6e25% 那种离群。现在 `refillP × 中位倍数` = 0.85×1.15
     ≈ 0.98 ⇒ 期望 `left ≈ 0.99 × o.n`：**同价档走中性游走**、不再系统性衰减，簿稳、尾也干净。
     与真实盘口「被扫后同价补单、补得回原量级」一致；真要不补（15%）时档位自然变老被寿命筛清掉。 */
  refillMin: 0.95, refillMax: 1.35,
  /* 吃穿的消费比例区间（M4a，见 `lobTick` ①）：本根 K 线**刚碰到**那一档（在极值处）⇒ 0.35，
     **价格远远扫过**那一档（在贴中一侧）⇒ 0.85 —— 越靠中、被吃掉的越多。 */
  eatMin: 0.35, eatMax: 0.85,
  maxQ: 0.02,          // 单档名义硬顶（q 单位）—— 防回填连乘把一格吹到天上去
  maxSide: 400,        // 单侧最大档数（防泄漏硬顶，超出裁最远）
  feedMax: 4,          // 每小时每币进 tape 的吃穿事件上限
};

const CH_LOB = hashStr('lob');   // randFast 的通道号（与行情/决策通道隔离）
const CH_LOBF = hashStr('lobf'); // 回填/远场子通道

/** 挂单条目：`{ p, n, t }` —— 绝对价格（限价单钉死不动）、美元名义、出生小时。
 *  同价合并（同格多单求和 ⇒ 数组按价格升序（asks）/降序（bids）且价格唯一）；
 *  ⚠️ 合并时 `t` 刷成**最新**出生小时 —— 格里还活着的是新单，寿命筛只该杀
 *  「最后一笔补单也老化了」的格子（否则热门贴中格会因为最老贡献者的年龄被整格团灭）。 */
const lobPut = (arr, p, n, t, desc) => {
  if (!(p > 0) || !(n > 0)) return;
  let lo = 0, hi = arr.length - 1, hit = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; const c = desc ? arr[mid].p > p : arr[mid].p < p; if (c) lo = mid + 1; else { hit = mid; hi = mid - 1; } }
  const e = arr[hit];
  if (e && e.p === p) { e.n += n; if (t > e.t) e.t = t; }
  else arr.splice(hit < 0 ? arr.length : hit, 0, { p, n, t });
};

/** 价签哈希（撤单抖动用，零随机数）—— 同价同抖动、跨小时稳定。 */
const lobHash = p => (Math.imul(Math.round(p * 1e6) | 0, 2654435761) >>> 0) / 4294967296;

/* 远场**截断幂律**取样器（2026-10-10）：账本剖面 ρ(δ) ∝ δ^(−farMu) on [farD0, 400] 格的
   反变换采样 —— 冷启动与 `lobTick` ③ 共用（逐位同分布）。旧帕累托 α=1.8（密度 ∝ δ^-2.8）
   比该剖面在远端薄 1~2 个数量级，正是「70% 外整片为 0」的生成侧根因。 */
const LOB_FAR_POW = 1 - LOB.farMu;
const LOB_FAR_LO = Math.pow(LOB.farD0, LOB_FAR_POW);
const LOB_FAR_HI = Math.pow(400, LOB_FAR_POW);
const lobFarDist = u => Math.min(400, Math.pow(LOB_FAR_LO + u * 0.999 * (LOB_FAR_HI - LOB_FAR_LO), 1 / LOB_FAR_POW));

/** 挂单**入账收尾**（近场 / 远场共用；2026-10-10 抽出）：整数关口加成 ＋ **尘埃闸** ＋ `lobPut`。
 *  · `pRaw` 未吸附价 —— 吸附到步长网格 `kk = round(pRaw/step)` 后落格（限价单钉在 tick 网格）；
 *  · 尘埃闸：加成后名义 < `max(落格价, minRel × base)` ⇒ **不挂**（`base` = 深度尺子）——
 *    「全市场的订单薄不该出现数量 <1 的挂单」（用户 2026-10-10 拍板），`落格价` 那一项
 *    保证 qty 恒 ≥ 1，`minRel × base` 保证最小档随市场规模走。
 *  · `exact` = **钉在精确价**（支撑/压力位聚集单用，不吸附 —— 位本身就是磁铁）。 */
const lobPlace = (arr, pRaw, step, n, t, desc, base, exact = false) => {
  const kk = Math.round(pRaw / step);
  const p = exact ? pRaw : kk * step;
  const nG = n * (kk % 10 === 0 ? LOB.gateMax : kk % 5 === 0 ? (LOB.gateMin + LOB.gateMax) / 2 : 1);
  if (!(nG >= Math.max(p, LOB.minRel * base))) return;
  lobPut(arr, p, nG, t, desc);
};

/** 支撑 / 压力位**聚集单**的一笔（2026-10-10 · 用户拍板「人人都想低买高卖，远处支撑位/压力位
 *  应该特别多挂单」）：历史压力位（`levelsOf`：量价密集区 ＋ 摆动高低点）是全市场公认的挂单
 *  磁铁 —— 对本侧每条在册位钉一笔大单（×位权重），**落最近格点**：同格位几小时就堆出肉眼
 *  可见的墙，与近场/远场单同格也自然合并。CoinGlass 清算热力图的「磁吸区」同构。
 *  ⚠️ 不钉精确价（2026-10-10 审计）：`exact=true` 会让聚集单价 = 墙行价 = `L.p`（同一浮点数
 *  在视图里出现两次，违反 9v③「同侧严格升降序」契约）—— 落格后与墙行价至多差半格，
 *  「位上有墙」的视觉不变。位在 1~400 格外 / 方向不符 ⇒ 跳过。
 *  `li` = 位在 `levelsOf` 数组里的序号（随机通道分量）；
 *  通道号 `3000 + li×4 + (side<0 ? 0 : 2)`（＋1 为大小）—— 与近场（≤1612）/ 远场（2000+）不重叠。 */
const lobLevelPut = (arr, L, li, price, step, side, scale, sMul, base, t, sy, seed, h) => {
  const dL = Math.abs(L.p / price - 1) / (step / price);
  if (!(dL >= 1) || dL > 400 || !(side < 0 ? L.p < price : L.p > price)) return;
  const u = randFast(seed, sy, h, 3000 + li * 4 + (side < 0 ? 0 : 2), CH_LOB);
  const n = Math.min(LOB.maxQ, LOB.levelQ * Math.pow(1 - u * 0.999, -1 / 1.8) * (0.5 + L.w) * scale * sMul) * base;
  lobPlace(arr, L.p, step, n, t, side < 0, base);
};

/**
 * 限价簿的**深度尺子**（2026-10-08 M4a）—— 锚在**日流动性**、不是逐小时深度。
 *
 * 病根：原实现锚 `hourLiqBase`（含 `hourShareK` 的日内形态，0.3~3 倍摆动）⇒ 目标质量逐小时
 * 跳变，正是用户报的「变动太快、像量化」。真实盘口**日内深度远比成交量平稳**（成交量有 U 形、
 * 挂单深度没有同等幅度）⇒ 锚日尺子既更贴现实、也**平滑一个数量级**。
 * 仍保留两条市场级折减：对抗性撤深度（`advDepthMul`）与上帝深度旋钮（`godLiqMulOf`）——
 * 两者都是「市场整体变大/变小」，簿该跟着变（与 M4b 的全套放大同源）。
 * ⚠️ 导出（2026-10-10 审计）：治理器设定点 = `capQ × 本函数` —— 离线断言 9af③ 的分母
 * 必须用**同一把尺子**（`hourLiqOf` 含日内形态 0.3~3× 摆动，拿它当分母会把比值虚高
 * 一个数量级：DOGE 实测 33×「超标」其实是分母被日内谷底砸小，锚本身是好的）。 */
export function lobScaleOf(s, sym, i) {
  const dayLiq = liqOf(sym, dayIndexOf(i));
  if (!(dayLiq > 0)) return 0;
  const raw = hourLiqRaw(s, sym, i);
  const adv = advDepthMul(s, sym, i, raw);
  const gm = godLiqMulOf(s, sym);
  const a = adv === 1 ? dayLiq : dayLiq * adv;
  return gm === 1 ? a : a * gm;
}

/**
 * 该币的限价簿（惰性访问）—— 没有就**冷启动**：把过去 24 小时的生成器各跑一遍
 *（出生小时回填到 i−23..i，撤单只按寿命筛一次），簿一开局就是「活过一天」的形状，
 * 不存在空簿突变的尴尬帧。`rewindTo` 清空 `s.lob` 后第一次读到这里 ⇒ 逐位可复现。
 */
function lobOf(s, sym) {
  if (!s.lob) s.lob = {};
  let b = s.lob[sym];
  if (b) return b;
  const price = lastPrice(s, sym);
  if (!(price > 0)) return null;
  b = { i: s.i, bids: [], asks: [] };
  s.lob[sym] = b;
  const scale0 = lobScaleOf(s, sym, s.i);   // 深度尺子 = 日流动性（不是逐小时，见 `lobScaleOf`）
  if (!(scale0 > 0)) return b;
  const lobMul = sbOf(s).lob;              // 挂单密度旋钮（沙盒）：0 = 连冷启动都不生成 ⇒ 簿恒空回落连续合成
  if (lobMul <= 0) return b;
  const step = niceStepOf(price);
  const sy = hashStr(sym);
  for (let k = 24; k >= 1; k--) {          // 回填出生小时：i−23..i（同 lobTick 的生成分布）
    const h = s.i - k;
    const lv = levelsOf(sym, h);           // 该小时的在册压力位（聚集单用；无前视，levelsOf 自身只扫历史）
    for (const side of [-1, 1]) {
      const arr = side < 0 ? b.bids : b.asks;
      const scale = side < 0 ? LOB.bidEdge : 1;
      const nNear = 2 + Math.floor(randFast(s.seed, sy, h, 1, CH_LOB) * LOB.near * 2);
      for (let j = 0; j < nNear; j++) {
        const u1 = randFast(s.seed, sy, h, 10 + j * 3, CH_LOB);
        const d = Math.max(1, Math.min(400, -Math.log(1 - u1 * 0.999) / LOB.kNear));
        const z = Math.sqrt(-2 * Math.log(1 - randFast(s.seed, sy, h, 11 + j * 3, CH_LOB) * 0.999)) * Math.cos(6.283185307 * randFast(s.seed, sy, h, 12 + j * 3, CH_LOB));
        const n = Math.min(LOB.maxQ, LOB.nearQ * Math.exp(LOB.sizeSig * z - LOB.sizeSig * LOB.sizeSig / 2) * scale) * scale0;
        lobPlace(arr, price * (1 + side * d * step / price), step, n, h, side < 0, scale0);
      }
      /* 远场价值单 —— **与 `lobTick` ③ 逐位同分布**（同 `h` 小时、同通道号）。
         ⚠️ 原实现此处**漏了这一支**（注释却自称「同 lobTick 的生成分布」）⇒ 冷启动簿没有长尾；
         而 `rewindTo` 清空 `s.lob` ⇒ 每次上帝重开本局拿到的都是「无尾簿」，远处一片 0
         （用户 2026-10-09 报「远处挂单为 0」的数据侧根因之一）。 */
      const farRate = LOB.farP * lobMul;
      const nFar = Math.floor(farRate) + (randFast(s.seed, sy, h, 2050 + (side < 0 ? 0 : 1), CH_LOB) < farRate % 1 ? 1 : 0);
      for (let j = 0; j < nFar; j++) {
        const u1 = randFast(s.seed, sy, h, 2000 + j * 4 + (side < 0 ? 0 : 2), CH_LOB);
        const u2 = randFast(s.seed, sy, h, 2000 + j * 4 + 1 + (side < 0 ? 0 : 2), CH_LOB);
        const nf = Math.min(LOB.maxQ, LOB.farQ * Math.pow(1 - u2 * 0.999, -1 / 1.8) * scale) * scale0;
        lobPlace(arr, price * (1 + side * lobFarDist(u1) * step / price), step, nf, h, side < 0, scale0);
      }
      /* 支撑 / 压力位聚集单 —— 同 `lobTick` ③ 逐位同分布（冷启动也要有墙）。 */
      for (let li = 0; li < lv.length; li++) {
        lobLevelPut(arr, lv[li], li, price, step, side, scale, 1, scale0, h, sy, s.seed, h);
      }
      /* 极远整数关口单 —— 同 `lobTick` ③d 逐位同分布、同 4000 段通道（冷启动也要有）。 */
      const farXRate = LOB.farX * lobMul;
      if (randFast(s.seed, sy, h, 4010 + (side < 0 ? 0 : 1), CH_LOB) < farXRate) {
        const u1 = randFast(s.seed, sy, h, 4000 + (side < 0 ? 0 : 2), CH_LOB);
        const u2 = randFast(s.seed, sy, h, 4001 + (side < 0 ? 0 : 2), CH_LOB);
        const dX = 400 + u1 * (LOB.farXMax - 400);
        const kkX = Math.round(price * (1 + side * dX * step / price) / step);
        const nx = Math.min(LOB.maxQ, LOB.farQ * Math.pow(1 - u2 * 0.999, -1 / 1.8) * scale) * scale0;
        lobPlace(arr, Math.round(kkX / 10) * 10 * step, step, nx, h, side < 0, scale0);
      }
    }
  }
  /* 冷启动收尾：按寿命筛一次（出生最早的那批可能有该死的）—— 与 lobTick ② 同一公式 */
  for (const arr of [b.bids, b.asks]) {
    const isBid = arr === b.bids;
    for (let j = arr.length - 1; j >= 0; j--) {
      const o = arr[j];
      const d = Math.abs(o.p / price - 1) / (step / price);
      const life = LOB.life0 * (1 + d / LOB.lifeDist) * (0.6 + 0.8 * lobHash(o.p));
      /* stale 清理（2026-10-10）：价格已**越过**这一档 ⇒ 退场 —— 跳空穿过的老单吃不到
         （① 只吃本根 K 线触及的档），赖到寿命尽会违反 9v③「严格分居中价两侧」契约。
         真实盘口同理：限价单被穿过 = 成交或撤，不会留在簿上。 */
      const stale = isBid ? o.p >= price : o.p <= price;
      if (stale || s.i - o.t > life || d > LOB.farXMax) arr.splice(j, 1);
    }
  }
  return b;
}

/**
 * 限价簿的**小时刻度**（`tickMarket` / `npcOtherTick` 末尾调用，每币每小时一次）：
 *   ① 吃穿 —— 本根 K 线的高低价扫过的档：部分消费、余量留原价，就地补回被吃量的一部分；
 *      残量低于**尘埃闸**（`LOB.minRel`）⇒ 整档退场（2026-10-10）；
 *   ② 撤单 —— 寿命 = `life0 × (1 + δ/δc) × 价签抖动`，远场单活得久（2026-10-10 反转）；
 *   ③ 生成 —— 近场指数 ＋ 远场账本剖面幂律 ＋ 支撑/压力位聚集 ＋ 关口加成 ＋ 尘埃闸，
 *      名义经**治理器**（`sMul` = 目标深 ÷ 现存深，夹 0.05~2）锚在
 *      `LOB.capQ × 本小时基准深度` 附近。
 */
function lobTick(s, sym) {
  const price = lastPrice(s, sym);
  if (!(price > 0) || !isLoaded(sym)) return;
  const b = lobOf(s, sym);
  if (b.i === s.i) return;                 // 同根重入（切币回来重画）幂等
  b.i = s.i;
  const base = lobScaleOf(s, sym, s.i);   // 深度尺子 = 日流动性（见 `lobScaleOf`），不再是逐小时
  if (!(base > 0)) return;
  const step = niceStepOf(price);
  const c = candleAt(sym, s.i);
  if (!c) return;
  const hi = c.h, lo = c.l;
  const sy = hashStr(sym);
  const eaten = [];
  /* ① 吃穿 —— **部分消费**（2026-10-08 M4a，见 `LOB` 头注）：
     凡价格落进本根 `[lo, hi]` 的档，只按「离贴中有多近」吃掉一部分，**余量留在原价上**；
     再按 `refillP` 就地补回被吃量的一部分（0.6~1.2×）。整格不再消失 ⇒ 该侧质量不再归零、
     治理器 `sMul` 不再被迫拉到 4× 批量重生成 —— 「100k → 几千」那种 30× 摆动就此消失。
     · `u` = 本档离**本根极值**的归一距离（0 = 贴中，刚被碰到；1 = 最深，被吃穿）
     · 消费比例 `cf` 由 `u` 线性插值：贴中 `eatMin`（0.35）→ 最深 `eatMax`（0.85） */
  const span = Math.max(hi - lo, step);
  for (const side of [-1, 1]) {
    const arr = side < 0 ? b.bids : b.asks;
    let i0 = 0;
    while (i0 < arr.length && (side < 0 ? arr[i0].p >= lo : arr[i0].p <= hi)) i0++;
    const swept = arr.splice(0, i0);       // asks 升序 = 从贴中被吃；bids 降序同
    for (const o of swept) {
      const u = Math.max(0, Math.min(1, side < 0 ? (hi - o.p) / span : (o.p - lo) / span));
      const cf = LOB.eatMin + (LOB.eatMax - LOB.eatMin) * (1 - u);
      const eatenN = o.n * cf;
      const pk = (Math.round(o.p * 1e6) | 0) + 7;
      const back = randFast(s.seed, sy, s.i, pk, CH_LOBF) < LOB.refillP
        ? eatenN * (LOB.refillMin + randFast(s.seed, sy, s.i, pk + 6, CH_LOBF) * (LOB.refillMax - LOB.refillMin))
        : 0;
      /* 余量 ＋ 就地在**原价**补回（`t` 刷成本小时 = 补的是新单，寿命筛按新单算）。
         ⚠️ 只补**仍在正确一侧**的档（`stale` 闸，2026-10-08 M4a v2）：价格已**越过**这一档
         （买档跑到现价上方 / 卖档跑到现价下方）⇒ 残量不该留（那一档已被吃掉、只剩「越过去」的
         空价签）—— 留着会同时违反「簿两侧严格分居中价」这条 UI 契约（审计 9v③）。
         ⚠️ **尘埃闸**（2026-10-10）：残量 < `max(本档价, minRel × base)` ⇒ **整档退场**。
         病根（离线实测）：15% 不补路径 × 0.35~0.85 消费比复利缩水 —— 反复被扫的档收敛到
         几十美元的残渣（2014 局实测最小 $68、qty 0.089），且离散残渣**盖住**渲染空桶本该
         显示的潜在基线（`latentOf`）—— 用户报「远处挂单数量 <1」的直接来源。做市商不会
         留碎渣：撤掉重挂。 */
      const left = o.n - eatenN + back;
      const stale = side < 0 ? o.p >= price : o.p <= price;
      if (left >= Math.max(o.p, LOB.minRel * base) && !stale) lobPut(arr, o.p, Math.min(LOB.maxQ * base, left), left > o.n - eatenN ? s.i : o.t, side < 0);
      if (eatenN > 0) eaten.push({ side, p: o.p, n: eatenN, t: o.t });
    }
  }
  /* ①′ 大档被吃 ⇒ 进 tape（主动方向：吃掉卖档 = 主动买 ▲；吃掉买档 = 主动卖 ▼），
     名义阈内取最大的 `feedMax` 条 —— volatile 小时也不许刷屏（FEED_CAP 是全币共享的）。 */
  eaten.sort((a, z) => z.n - a.n);
  let fed = 0;
  for (const e of eaten) {
    if (fed >= LOB.feedMax) break;
    if (feedTier(e.n, godScale(s, sym, liqOf(sym, dayIndexOf(s.i)))) < 0) continue;
    feedPush(s, sym, e.side < 0 ? 1 : 0, e.p, e.n);
    fed++;
  }
  /* ② 撤单 ＋ ③ 生成（一起过，避免两趟扫描） */
  for (const side of [-1, 1]) {
    const arr = side < 0 ? b.bids : b.asks;
    for (let j = arr.length - 1; j >= 0; j--) {
      const o = arr[j];
      const d = Math.abs(o.p / price - 1) / (step / price);
      /* 寿命 = `life0 × (1 + δ/δc)`（2026-10-10 反转旧式 `life0/(1+δ/δc)`）：远场价值单是
         耐心单，活得比近场 mm 报价久 —— 账本剖面的幂律正是「持续挂单 × 长寿命」积累出来的
         （Krause et al. 2021 两 regime；旧式让远场死得比近场快，长尾永远积累不起来）。 */
      const life = LOB.life0 * (1 + d / LOB.lifeDist) * (0.6 + 0.8 * lobHash(o.p));
      /* stale 清理（2026-10-10）：价格已**越过**这一档 ⇒ 退场 —— 跳空穿过的老单吃不到
         （① 只吃本根 K 线触及的档），赖到寿命尽会违反 9v③「严格分居中价两侧」契约。
         真实盘口同理：限价单被穿过 = 成交或撤，不会留在簿上。 */
      const stale = side < 0 ? o.p >= price : o.p <= price;
      if (stale || s.i - o.t > life || d > LOB.farXMax) arr.splice(j, 1);
    }
    let mass = 0;
    for (const o of arr) mass += o.n;
    /* 治理器夹口（2026-10-08 M4a v2）：0.25~4 → 0.5~2 → **0.2~2**。
       实测（离线 720h）单侧质量 ÷ 日流动性 = 0.44、远超目标 0.0675 ⇒ 减到 0.5 也被**下限夹住**、
       治理器形同虚设、总深完全由生成量决定（67%≫35%）。下限放到 0.2 后 sMul 收敛到 ~0.37、
       夹口**不再触底** ⇒ `capQ` 重新成为真正的设定点（实测总深落到 35~40%），且自动补偿
       生成量的后续微调（M4b 起深度倍数联动也靠它保持自洽）。上限 2 不变（突发扫穿后的补生成本身
       就是摆动源，不许再拉大）。
       2026-10-09：近场铺平后每小时生成笔数 ~3.5×（`near` 20→70）⇒ 下限 0.2 又会被顶住、
       深度冲破锚；下限放到 0.05 让治理器重新握住 `capQ`（铺平带来的增深由 `sMul` 自动折回）。 */
    /* ⚠️ 目标随侧走（× `scale`）：治理器按**每侧自己的**现存质量收敛 ⇒ 若两侧共用同一个目标，
       它会自动把两侧质量抹平、把买侧不对称（`bidEdge`）一起抹掉（实测比值从 1.6 掉到 1.24）。
       目标乘上同一 `scale`，两侧各收敛到「自己的目标」 ⇒ `bidEdge` 保留。 */
    const scale = side < 0 ? LOB.bidEdge : 1;
    const target = LOB.capQ * base * scale;
    const sMul = Math.max(0.05, Math.min(2, target / (mass + target * 0.1)));
    const lobMul = sbOf(s).lob;            // 挂单密度旋钮（沙盒 · 2026-10-08 三批）：0 = 不再挂新单
    if (lobMul > 0) {
      /* ③a 近场：做市商报价流（对数均匀距离 ＋ 对数正态大小），draw 不变，落单改走
         `lobPlace` —— 尘埃闸把 < max(档价, minRel×base) 的碎单直接吞掉。 */
      const nNear = Math.max(1, Math.round((2 + Math.floor(randFast(s.seed, sy, s.i, side < 0 ? 31 : 32, CH_LOB) * LOB.near * 2)) * lobMul));
      for (let j = 0; j < nNear; j++) {
        const u1 = randFast(s.seed, sy, s.i, 40 + j * 3 + (side < 0 ? 300 : 0), CH_LOB);
        const d = Math.max(1, Math.min(400, -Math.log(1 - u1 * 0.999) / LOB.kNear));
        const z = Math.sqrt(-2 * Math.log(1 - randFast(s.seed, sy, s.i, 41 + j * 3 + (side < 0 ? 300 : 0), CH_LOB) * 0.999)) * Math.cos(6.283185307 * randFast(s.seed, sy, s.i, 42 + j * 3 + (side < 0 ? 300 : 0), CH_LOB));
        const n = Math.min(LOB.maxQ, LOB.nearQ * Math.exp(LOB.sizeSig * z - LOB.sizeSig * LOB.sizeSig / 2) * scale * sMul) * base;
        lobPlace(arr, price * (1 + side * d * step / price), step, n, s.i, side < 0, base);
      }
      /* ③b 远场价值单 —— 笔数制：每小时 `farP × lobMul` 笔/侧（小数 = 概率尾数，与冷启动
         `lobOf` 逐位同分布、同 2000/2050 通道）。距离走**截断幂律** `lobFarDist`
         （账本剖面 ρ∝δ^-0.6，Bouchaud-Mézard-Potters 2002；旧帕累托 α=1.8 密度 ∝δ^-2.8
         让 70% 外整片空 —— 「远处挂单为 0」的另一根因）。 */
      const farRate = LOB.farP * lobMul;
      const nFar = Math.floor(farRate) + (randFast(s.seed, sy, s.i, 2050 + (side < 0 ? 0 : 1), CH_LOB) < farRate % 1 ? 1 : 0);
      for (let j = 0; j < nFar; j++) {
        const u1 = randFast(s.seed, sy, s.i, 2000 + j * 4 + (side < 0 ? 0 : 2), CH_LOB);
        const u2 = randFast(s.seed, sy, s.i, 2000 + j * 4 + 1 + (side < 0 ? 0 : 2), CH_LOB);
        const nf = Math.min(LOB.maxQ, LOB.farQ * Math.pow(1 - u2 * 0.999, -1 / 1.8) * scale * sMul) * base;
        lobPlace(arr, price * (1 + side * lobFarDist(u1) * step / price), step, nf, s.i, side < 0, base);
      }
      /* ③c 支撑 / 压力位聚集单 —— 「人人都想低买高卖」：对本侧每条在册位钉一笔价值单
         （`lobLevelPut`：精确价落格、大小 ×(0.5+位权重)、同价自然合并成墙、尘埃闸兜底）。
         就算默认 1 倍也特别多 —— 位的数量不乘 lobMul，只乘深度治理 sMul。 */
      const lv = levelsOf(sym, s.i);
      for (let li = 0; li < lv.length; li++) {
        lobLevelPut(arr, lv[li], li, price, step, side, scale, sMul, base, s.i, sy, s.seed, s.i);
      }
      /* ③d 极远整数关口单 —— 见 `LOB.farX` 注（用户拍板「6 万 BTC 挂 12 万真实存在」）：
         距离 400~farXMax 格均匀，落格后**吸附 10 格大关口**（lobPlace 的 `kk%10===0`
         自动吃 gateMax ×3 —— 关口单大，与 round number 同语义）；大小与远场同分布
         （帕累托尾自然出大单）。与冷启动逐位同分布、同 4000 段通道。 */
      const farXRate = LOB.farX * lobMul;
      if (randFast(s.seed, sy, s.i, 4010 + (side < 0 ? 0 : 1), CH_LOB) < farXRate) {
        const u1 = randFast(s.seed, sy, s.i, 4000 + (side < 0 ? 0 : 2), CH_LOB);
        const u2 = randFast(s.seed, sy, s.i, 4001 + (side < 0 ? 0 : 2), CH_LOB);
        const dX = 400 + u1 * (LOB.farXMax - 400);
        const kkX = Math.round(price * (1 + side * dX * step / price) / step);
        const nx = Math.min(LOB.maxQ, LOB.farQ * Math.pow(1 - u2 * 0.999, -1 / 1.8) * scale * sMul) * base;
        lobPlace(arr, Math.round(kkX / 10) * 10 * step, step, nx, s.i, side < 0, base);
      }
    }
    if (arr.length > LOB.maxSide) arr.splice(LOB.maxSide);   // 裁最远（两端已按远近排序）
  }
}

/**
 * 订单簿**视图**（浮窗第 4 页）—— **直接读 NPC 限价簿**（`s.lob`，2026-10-08 三批拍板⑦）：
 * 每一行就是一笔真实挂单（同价已合并），墙（`levelsOf` 压力位）照插格间。
 * ⚠️ 簿为空（沙盒旋钮 0 / 尚未冷启动）⇒ 回落**旧连续曲线合成**（基础 18 档，
 *    2026-10-07 形态逐位保留）—— 旋钮归零即回到拍板前的盘口。
 * ⚠️ 与 `walkFillFor` 仍是**两把分开的尺子**（拍板口径）：玩家成本走连续曲线（审计 9v），
 *    这页显示的是「谁把单挂在哪」—— 行为层的事实，不掺代价。
 * @returns {object|null} 行情不可用 ⇒ `null`（UI 显示「盘口暂不可用」）
 */
function bookForWatch(s, sym, price) {
  const liq = hourLiqOf(s, sym, s.i);
  if (!(liq > 0) || !(price > 0)) return null;
  const sigma = dailySigma(sym, s.i);
  const cap = godCapOf(s);
  const wallsOf = (dir) => {
    const rows = [];
    const lobArr = b && (dir > 0 ? b.asks : b.bids);
    for (const L of levelsOf(sym, s.i)) {
      if (!(L.w > 0) || (dir > 0 ? L.p <= price : L.p >= price)) continue;
      /* 巧合防御（2026-10-10）：位价恰在 tick 格点上时，该位的**聚集单**（落格 = L.p）与
         墙行同价 —— 视图同一价格出现两行，违反 9v③「同侧严格升降序」。聚集单已经占住了
         这个价（真实单比合成墙更硬），墙行让位。 */
      if (lobArr && lobArr.some(o => o.p === L.p)) continue;
      rows.push({ price: L.p, d: Math.abs(L.p / price - 1), notional: L.w * WALL_K * liq, wall: true, w: L.w });
    }
    return rows;
  };
  const b = lobOf(s, sym);
  if (b && (b.asks.length || b.bids.length)) {
    const asks = b.asks.map(o => ({ price: o.p, d: o.p / price - 1, notional: o.n, wall: false })).concat(wallsOf(1));
    const bids = b.bids.map(o => ({ price: o.p, d: o.p / price - 1, notional: o.n, wall: false })).concat(wallsOf(-1));
    asks.sort((a, z) => a.price - z.price);
    bids.sort((a, z) => z.price - a.price);
    return { mid: price, sigma, cap, liq, lob: true, asks, bids };
  }
  const side = (dir) => {
    const rows = [];
    for (const r of baseLadder(sigma, cap)) rows.push({ price: dir > 0 ? price * (1 + r.d) : price * (1 - r.d), d: r.d, notional: r.nq * liq, wall: false });
    rows.push(...wallsOf(dir));
    rows.sort((a, b) => a.d - b.d);
    return rows;
  };
  return { mid: price, sigma, cap, liq, asks: side(1), bids: side(-1) };
}

/**
 * **潜在流动性基线**（订单簿空格的「做市商底仓」· 纯函数 · 2026-10-09 用户拍板「任何地方都不许 0」）
 * —— 连续冲击曲线的**解析母函数**在价距带 `[pLo, pHi]` 上的名义积分：
 *   `D(q) = 2σ·q^1.5/√h`（`baseLadder` 档距公式的连续形式，h = cap/18）⇒ 反解
 *   `q(D) = (D·√h / 2σ)^(2/3)`，带宽 [D0,D1] 上的 q 差 × 当小时流动性 = 这一带的底仓名义。
 *
 * 现实口径（2026-10-09 联网调研）：
 *   · **任何价距恒 > 0** —— Krause et al. 2021（arXiv:2106.11691）的两 regime：近场「流动性垫」
 *     密集短命、远场**稀疏但长寿命单恒在**；Avellaneda-Stoikov 成交强度 λ(δ)=A·e^(−kδ) 恒正；
 *     Potters & Bouchaud 2002 限价价距幂律重尾（µ≈0.6~1.5，参与者专在远处挂单等大波动）。
 *     「远处挂单为 0」在真实 LOB 里不存在 —— 空的只是**离散大单**，底仓（做市商长梯 ＋ 散单云）永远在。
 *   · **买侧随价距增厚**（side<0）：抄底墙 / 成本聚集（Hu et al. 2019、Urquhart 2017）——
 *     价格越低、支撑越密，×(1 + D/3%)，×7 封顶（盖过冲击曲线密度的缓降 ⇒ 每桶非降）。
 *   · **卖侧随价距缓降但不真空**（side>0）：×(1 − D/20% × 0.6)，0.4 形状地板 —— 突破前高后
 *     上方卖单变薄（Glassnode 2026-10：85K 卖墙吃穿后其余卖单主动撤出 → 轧空加速冲高；
 *     2024-11 首破 80K 同款：上方无历史成本区 ＋ 130K 空头爆仓 ⇒ 快速价格发现），
 *     但做市商 ladder 恒在 ⇒ 永不为 0（叠上密度缓降，远档绝对值更薄）。
 *
 * ⚠️ 只进**显示与买卖比**（render 空格填充用），与 `walkFillFor` 成本仍两把尺子（红线 A 不破）。
 * @param {number} side −1 买侧 / +1 卖侧
 * @returns {number} 名义（美元，> 0）
 */
export function latentOf(sigma, cap, liq, price, pLo, pHi, side) {
  const sg = Number.isFinite(sigma) && sigma > 0 ? sigma : SLIP.sigmaDefault;
  const h = (Number.isFinite(cap) && cap > 0 ? cap : SLIP.cap) / LADDER.levels;
  if (!(liq > 0) || !(price > 0) || !(pHi > pLo)) return 0;
  const qOf = D => Math.pow(D * Math.sqrt(h) / (2 * sg), 2 / 3);
  /* 距离带取 min/max：买桶（pHi 贴中、pLo 远）与卖桶（pLo 贴中）的方向相反，
     直接按价格序做差会让买侧恒负 ⇒ 恒 0（2026-10-09 专项脚本抓到的）。 */
  const D0 = Math.min(Math.abs(pLo / price - 1), Math.abs(pHi / price - 1));
  const D1 = Math.max(Math.abs(pLo / price - 1), Math.abs(pHi / price - 1));
  const q = qOf(D1) - qOf(D0);
  if (!(q > 0)) return 0;
  const D = (D0 + D1) / 2;
  /* 方向形状（叠加在冲击曲线密度 D^(-1/3) 缓降之上 —— 要让买侧**每桶**非降，梯度须盖过它）：
     · 买侧：×(1 + min(6, D/3%)) —— 支撑聚集（抄底墙/成本区，Hu·Urquhart），越深越厚；
     · 卖侧：×(1 − min(0.6, D/20% × 0.6)) —— 上方缓降（突破前高后卖单变薄，Glassnode 85K 撤单
       实录、2024-11 首破 80K 轧空），0.4 地板 ⇒ 永不真空。 */
  const shape = side < 0 ? 1 + Math.min(6, D / 0.03) : 1 - Math.min(0.6, D / 0.2 * 0.6);
  return q * liq * shape;
}

/**
 * 上帝模式「新闻源与事件」总闸（2026-10-09 · 用户拍板把「新闻源」扩成「新闻源与事件」）：
 * `true` ⇒ 真实历史的**全部事件注入**一起熄火 ——
 *   ① 4 条新闻播报（事件条 / 结果条 / 巨鲸披露 / ETF 月报）；
 *   ② `extFlow`（巨鲸 / ETF 有向买盘）；
 *   ③ 交易所停机（BitMEX 2020-03-13：播报 ＋「只平不开」限制）；
 *   ④ 交易所被盗削减（Bitfinex 2016-08-02 普损）与归零（`close`，当前档无此配置，防御性同闸）；
 *   ⑤ 破产预警遮罩（`warnAnchorAt`）与 K 线上的历史锚点刻度（render 侧）。
 * 普通局 / 挑战局无 `s.god` ⇒ 恒 false，全部事件照常 —— 口径与真实历史逐位一致。
 * ⚠️ 只关「事件注入」这一层：**底价仍是真实历史 K 线**（崩盘本身就在数据里，本作从不人为制造涨跌幅）；
 *    市场自身行为（护盘 / 爆仓潮 / 极端行情保护带）不是历史事件，不在此闸内。
 */
export function eventsOff(s) {
  return !!(s.god && s.god.noRealNews);
}

export function godWatchOf(s, sym = s.sym) {
  const m = mktOf(s, sym);
  const t = timeOf(s);
  /* 档名带**生效杠杆**（2026-10-07 用户拍板「3 倍和 100 倍强平价一样？」的口径修正）：
     2016-05-13（BitMEX 100x 上线）之前年代封顶把所有档夹到 3x，旧名却仍写基准值 ——
     名字说 100x、强平价却按 3x 算，才是真正的 bug。封顶时显示「基准→生效」。 */
  const rows = m.npc.map((g, k) => {
    const base = NPC.ladder[k].lev, eff = npcLevOf(t, base);
    return { g, name: eff < base ? `${base}x→${eff}x` : `${base}x`, lev: eff };
  })
    .concat(m.mm ? [{ g: m.mm, name: '做市', lev: npcLevOf(t, NPC.mm.lev) }] : []);
  let total = 0;
  for (const r of rows) total += (r.g.long || 0) + (r.g.short || 0);
  const liqs = [], tiers = [];
  for (const r of rows) {
    const { g } = r;
    tiers.push({ name: r.name, lev: r.lev, long: g.long || 0, longAvg: g.longAvg || 0, short: g.short || 0, shortAvg: g.shortAvg || 0 });
    const drop = 1 / r.lev - GAME.maintRate;
    if (g.long > 0 && g.longAvg > 0) liqs.push({ side: 'long', name: r.name, price: g.longAvg * (1 - drop), notional: g.long, w: total > 0 ? g.long / total : 0 });
    if (g.short > 0 && g.shortAvg > 0) liqs.push({ side: 'short', name: r.name, price: g.shortAvg * (1 + drop), notional: g.short, w: total > 0 ? g.short / total : 0 });
  }
  const liqDay = liqOf(sym, dayIndexOf(s.i)) || 0;
  const base = hourLiqBase(s, sym, s.i);
  const rawBase = hourLiqRaw(s, sym, s.i);   // 未折减分母（ADV 口径）—— 深度页「深度乘数」读数用
  const price = lastPrice(s, sym);
  /* 深度旋钮（2026-10-08）：深度页的 `liqDay / dead / sat` 三行读数**同步 ×mul** 保持页面自洽
     —— `hourBase` / `poolCap` 已随 `hourLiqBase` 自带旋钮，这三行走的是 `liqOf`（原始日流动性）
     不跟着走就会两套口径；`×1` 走 IEEE 精确恒等 ⇒ 普通局逐位不变。 */
  const liqMul = godLiqMulOf(s, sym);
  /* 同价聚合（2026-10-08 热力图改版 · 用户拍板 A）：六档共用一条均价 ＋ 同一倍率 ⇒ 同价
     强平线逐位相等，六根条叠同一价位纯属冗余 ⇒ 按「侧|价」合并（名义累加、`w` 累加、
     档名 join）——`sp` 梯度改版后各档均价本已离散，这只在「恰好同价」时兜底（如早年
     全 3x 且个别档均价趋同）。巨鲸页 `tiers` 不聚合（逐档明细是那一页的本职）。 */
  const byKey = new Map();
  const liqsMerged = [];
  for (const l of liqs) {
    const t = byKey.get(`${l.side}|${l.price}`);
    if (t) { t.notional += l.notional; t.w += l.w; t.name += `+${l.name}`; }
    else { byKey.set(`${l.side}|${l.price}`, l); liqsMerged.push(l); }
  }
  return {
    price, heat: m.heat || 0,
    /* 情绪读数 = 恐惧贪婪指数（0–100 · 日频轨，`settleFng` 写入；2026-10-08 起 `npcBuild`
       的散户接盘层也读它触发 —— 不再是纯显示）。旧字段 `mood` 从未被任何写路径赋值 ⇒ 恒 0
       （2026-10-07 用户抓到的「情绪恒为 0%」）。未结算过任何一天的格子（fngDay 缺）⇒ 中性 50。 */
    fng: Number.isFinite(m.fng) ? m.fng : 50,
    liqs: liqsMerged, tiers,
    book: bookForWatch(s, sym, price),
    /* 深度乘数 / 池回补（2026-10-08 · 深度页加两行读数 · 用户拍板）：depthMul = 对抗性
       折减残值（已折进上面的「本时深度」，这行让玩家看清折了多少）；refillPct = 深度池
       在途消耗的回补进度 `1 − poolRefill(e)`，无在途消耗 ⇒ 1（满）。纯派生，不写状态。 */
    depth: {
      liqDay: liqDay * liqMul, hourBase: base,
      poolUsed: poolConsumedAt(s, sym, s.i), poolCap: POOL.capK * base,
      dead: liqDay * liqMul * SLIP.threshold, sat: liqDay * liqMul * SLIP.cap,
      depthMul: rawBase > 0 ? advDepthMul(s, sym, s.i, rawBase) : 1,
      refillPct: (s.pool && s.pool[sym] && s.pool[sym].v > 0)
        ? Math.max(0, 1 - poolConsumedAt(s, sym, s.i) / s.pool[sym].v) : 1,
    },
  };
}

/**
 * 某个币当前的**标记价基差**（EMA 后的 `last − index`）；旧存档没有这个键 ⇒ 0。
 *
 * ⚠️ **口径注（④ · 2026-10-03 调研结论）—— 这个「基差」不是期现基差，别拿它对标现实。**
 *    它 = `EMA(last − rawClose)`，而 `last − rawClose` 是**位移层**（玩家冲击 ＋ NPC 漂移）里
 *    还没来得及被低通滤掉的那部分 ⇒ 它是一个**订单流位移的平滑量（伪基差）**：量级随
 *    「你自己砸了多少」走，而不是随「永续与现货的价差」走。
 *    真实的**期现基差 / 年化基差 / 期限结构**需要**同一时刻的两个工具价**（现货 vs 永续、
 *    当月 vs 次月），本作的行情包只有**一条价序列**，造不出第二只工具 ⇒ **本轮不做**：
 *    先得有数据源，其次才是模型；现在硬写一条「基差」只会是一条读不通的数（GDD 声明为合成）。
 *    本键存在的**唯一**目的是「别让玩家的插针立刻打爆自己」（三价体系，见上面的段落），别无他用。
 *  ⚠️ 不导出（2026-10-04 审计 R6）：仅 `markPrice` / `advanceMarkBias` 用。
 */
function markBiasOf(s, sym) {
  const b = s.mkb && s.mkb[sym];
  return Number.isFinite(b) ? b : 0;
}

/** **标记价** = 指数价 ＋ 平滑后的基差 —— 未实现盈亏 / 保证金率 / 强平 / 资金费读它。 */
export function markPrice(s, sym = s.sym) {
  const idx = indexPrice(s, sym);
  return idx == null ? null : idx + markBiasOf(s, sym);
}

/**
 * 每小时把标记价基差推进一格（一阶低通）—— **唯一的写口径**，只许从时钟的写路径调用。
 *
 *     `bias ← bias + ((last − index) − bias) × α`
 *
 * ⚠️ 它必须排在 `liquidateAll` **之后**（见 `advanceOneHour`）：这一小时的基差要等本小时的强平
 *    都判完才入账 ⇒ mark 在**当根**完全不含玩家自己刚砸出来的位移 —— 这正是
 *    「你自己的插针不再把自己打爆」的落点。
 */
function advanceMarkBias(s, sym) {
  const idx = rawCloseAt(sym, s.i);
  if (idx == null) return;
  const last = closeAt(sym, s.i);
  if (last == null) return;
  if (!s.mkb) s.mkb = {};
  const prev = markBiasOf(s, sym);
  s.mkb[sym] = prev + ((last - idx) - prev) * MARK_ALPHA;
}

/**
 * 某个币在**某家交易所**的**最新价本所价**（缺口 10 · 2026-10-03 拍板）—— **成交 / 平仓**读它。
 *
 *     exPrice = lastPrice × exDevOf(所, 币, 小时)
 *
 * `exDevOf`（`god.js`）= **长期基差 ＋ 小噪声**：Bitfinex +0.1%，其余 ≈0；
 * 再叠一层逐小时白噪声（幅度按所压在一次往返手续费之内 ⇒ 不可套利）。
 *
 * ⚠️ **口径（拍板）**：成交 / 平仓**一律读本仓所在所（`pos.ex`）的本所价** —— 与估值同一家所，
 *    消除「在便宜的所成交、按贵的所估值」的白赚口子（价格口径的差异见 `exMarkPrice`）。
 * ⚠️ 默认 `exId = s.ex`（当前所在所）；**平仓必须显式传 `pos.ex`**。
 */
export function exPrice(s, sym, exId = s.ex) {
  const p = lastPrice(s, sym);
  return p == null ? null : p * exDevOf(exId, sym, s.i, s.seed, s);
}

/**
 * 某个币在**某家交易所**的**标记价本所价** —— **估值 / 保证金率 / 强平 / 资金费**读它。
 * 与 `exPrice` 只差价格口径（mark vs last）；`exDevOf` 那一层完全相同。
 */
export function exMarkPrice(s, sym, exId = s.ex) {
  const p = markPrice(s, sym);
  return p == null ? null : p * exDevOf(exId, sym, s.i, s.seed, s);
}

/** 某个币的持仓的未实现盈亏（按**本仓所在所**的**标记价** —— 三价体系 · 2026-10-03） */
export function unrealizedOf(s, sym) {
  const pos = posOf(s, sym);
  if (!pos) return 0;
  const p = exMarkPrice(s, sym, pos.ex);
  return p == null ? 0 : pnlOf(pos, p);
}

/** 全部持仓的未实现盈亏之和（HUD 第二格的副行用这个） */
export function totalUnrealized(s) {
  let sum = 0;
  for (const sym of heldSyms(s)) sum += unrealizedOf(s, sym);
  return sum;
}

/**
 * 账户权益 = 当前所余额的**市值** ＋ **在途的链上转账**（市值）＋ **所有仓位权益之和**
 * （逐仓：每个仓位的保证金 + 各自的未实现盈亏）。空仓时就是当前所的余额。破产始终看这个总数
 * （GDD §10）—— 单个仓位被强平只损失它自己的保证金。
 *
 * ⚠️ **在途资金必须算进来**（P2-A 陷阱①）：换所后 `books` 是空的，漏掉这一项会让权益显示 $0.00，
 *    并且被 `isBankrupt` 直接误判成破产、本局当场结束。它不是「隐藏资产」，是**可见但不可用**。
 * ⚠️ **USDT 按**市值**计入**（缺口 2 · 2026-10-08 用户拍板）：现金两格走 `cashMtmOf`
 *    （`usd + usdt × usdtPriceAt`），在途的 USDT 同样按那一刻的汇率折成美元。
 *    ⇒ 持有 U 穿越脱锚会真实地看到权益缩水、回锚时又涨回来（史实：2014–2024 的 U 脱锚
 *      全部在数天内回锚，没有一次是永久的）。
 *    ⚠️ 这**推翻**了旧注释那句「破产判定不会因为 U 脱锚而提前触发」—— 现在会的，那是用户拍板
 *      要的口径（脱锚确实让「手上的钱」变少）；量级很窄（见 `ruinFloorOf` 的注释）。
 * ⚠️ **仓位按它自己那家所的本所价估值**（缺口 10 · 2026-10-03）：玩家换所之后旧仓照旧按 `pos.ex` ⇒
 *    权益不会因为「人在哪家所」而跳。
 */
export function equity(s) {
  let sum = cashMtmOf(s);
  if (s.transfer) sum += s.transfer.amount * (s.transfer.cur === 'usdt' ? usdtPriceAt(timeOf(s)) : 1);
  for (const sym of heldSyms(s)) {
    const pos = s.positions[sym];
    const p = exMarkPrice(s, sym, pos.ex);
    sum += p == null ? pos.margin : equityOf(pos, p);
  }
  return sum;
}

/**
 * 当前所账本的**市值**（美元）—— 「持有期市值重估」（缺口 2 · 2026-10-08 用户拍板）。
 *
 * ⚠️ 与 `state.cashOf`（**面值** = `usd + usdt`）**刻意分成两个口径**，别再合并：
 *    · **面值** = 「这一单能用多少钱」—— `debit` / `spendableOf` / 最小名义闸门按面值
 *      （交易所的最小名义与保证金是 **U 计价**的，U 脱锚不妨碍下单）；
 *    · **市值**（本函数）= 「手上的钱值多少美元」—— 权益 / HUD / 资产曲线 / 结算页。
 *    合成一个式子会长出「显示 $88、却能花 $100」的自相矛盾。
 * ⚠️ 范围**只到现金两格（含在途 USDT，见 `usdtHeldOf`）**：仓位保证金与浮盈浮亏仍按 U 面值
 *    （`equityOf`）—— 保证金率本身就是 U 计价的，把仓位也按 U 的美元价重估会让它与强平判定打架。
 * ⚠️ 汇率变动的那笔价差由 `markUsdt` 每小时结进 `s.realized` ⇒ HUD 不变量
 *    （`realized + unrealized = 权益 − 本金`）继续成立。
 */
export function cashMtmOf(s, ex = s.ex) {
  const b = bookOf(s, ex);
  return b.usd + b.usdt * usdtPriceAt(timeOf(s));
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

/* ───────────────── 持有期市值重估的小时结账（缺口 2 · 2026-10-08） ───────────────── */

/**
 * 把「手上的 U 随汇率变动产生的美元价差」结进 `s.realized` —— 每小时一次，`advanceOneHour` 里调。
 *
 * ⚠️ **为什么必须结账**：`equity` 现在按 `usdtPriceAt` 重估现金（市值口径），而汇率变动与玩家的
 *    任何一笔成交都无关 —— 不落进 `s.realized`，权益就动了而「已实现盈亏」不动，那条
 *    `realized + unrealized = 权益 − 本金` 的不变量当场破（P0-1 同源口径）。
 *    ⚠️ 这也正是「折价买 U 不再瞬间获利」的落点：换汇那一刻按**当根**汇率进出（`buyUsdt` 用
 *       `usdtPriceAt(t)`），价差为 0；只有在折价期**持有**到回锚，才在这一条里逐小时兑现
 *       —— 与史实一致（USDT 2014–2024 从未永久脱锚，折价是「买便宜 U 换回锚」的套利窗口）。
 * ⚠️ 价差恒取 `p(i) − p(i − 1)`：绝不夹取、绝不放大 —— 它必须**逐位等于**权益在同一根上的变动量，
 *    否则不变量又破了（这条纪律优先于「手感好看」）。
 * ⚠️ 数量取**结账那一刻**的持仓（`usdtHeldOf`）：本根之内后续的下单 / 平仓都按当根汇率进出，
 *    各自不产生价差，所以先结账、后跑本根的行情与成交。
 * @param {object} s
 * @param {number} i 已经自增后的当前小时序号（`s.i`）
 */
export function markUsdt(s, i) {
  const p0 = usdtPriceAt(GAME.start + (i - 1) * HOUR_MS);
  const p1 = usdtPriceAt(GAME.start + i * HOUR_MS);
  if (p0 === p1) return;                        // 常态（$1.000 平段）⇒ 一分钱都不动，零开销
  const qty = usdtHeldOf(s);
  if (!(qty > 0)) return;
  s.realized += qty * (p1 - p0);
}

/* ───────────────────────── 下单通道（P2-B3 · GDD §15.3） ───────────────────────── */

/**
 * OTC 是否已解锁（§15.3）—— UI 用它决定那枚切换键显不显示。
 * ⚠️ 门槛是 **`unlock(t)` 的函数**（2026-10-02 · 调研①）：绝对美元常量在 2013 年等于
 *    8.9 天全市场成交量，早期等于永不满足 ⇒ 改为按年代（2020 端仍为 $500 万，与改动前相同）。
 */
export const otcUnlocked = s => equity(s) > otcUnlockAt(timeOf(s));

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
 * 玩家对**当前币**选择的通道（2026-10-05 · 逐币记忆）—— `'book'` / `'otc'`。
 *
 * 查表顺序：`s.chanBy[s.sym]`（逐币偏好，玩家的选择）→ `s.chan`（兜底默认：新局初值，
 * 兼旧存档的迁移值）→ `'book'`。**任何一步都不改状态** —— 这是一个纯读函数，
 * 渲染每帧都会调它。
 */
export const chanChoiceOf = s => {
  const v = s.chanBy ? s.chanBy[s.sym] : undefined;
  if (v === 'otc' || v === 'book') return v;
  return s.chan === 'otc' ? 'otc' : 'book';
};

/**
 * 当前**生效**的通道：`'book'`（盘口）或 `'otc'`（场外大宗）。
 *
 * ⚠️ OTC 只在「玩家选了它」**且「仍然解锁」**时成立 —— 权益掉回门槛下就自动退回盘口。
 *    否则会出现最别扭的一种状态：切换键已经藏起来了（不满足解锁条件），
 *    而玩家选着的还是 `'otc'`，接着下的每一单都在走一条看不见的通道。
 * ⚠️ 同理还有**第二个**回退条件（P2-B 修订）：当前币还没开通 OTC ⇒ 也退回盘口。
 *    换币时若还留着 `'otc'`，玩家会在一个「这个币根本没有的通道」里下单。
 * ⚠️ 2026-10-05：判断依据从 `s.chan` 改为 `chanChoiceOf(s)`（逐币偏好）。回退**只影响生效值**，
 *    不动玩家存下来的选择 —— 门槛恢复 / 换回有 OTC 的币时自动恢复该通道（见 `advance` 的闩锁那段）。
 */
export const chanOf = s => (chanChoiceOf(s) === 'otc' && otcUnlocked(s) && otcOpenFor(s) ? 'otc' : 'book');

/**
 * 记下玩家对**当前币**的通道选择（2026-10-05 逐币记忆）—— 写进 `s.chanBy[s.sym]`，懒建。
 *
 * 这是通道选择的**唯一写入口**（`main.onChan` 调它）。放在引擎里而不是 DOM 侧，是为了让
 * Node 审计（`tools/sim-audit.mjs`）能对这条**真实生产路径**做断言，而不是去测一份复制品。
 * @param {'book'|'otc'} chan 认不出来的值一律当 `'book'`
 * @returns {'book'|'otc'} 落库的值
 */
export function setChanChoice(s, chan) {
  if (!s.chanBy) s.chanBy = {};        // 旧档没有这个键 ⇒ 首次选择时才建（不进 SHAPE，不升版本号）
  const v = chan === 'otc' ? 'otc' : 'book';
  s.chanBy[s.sym] = v;
  return v;
}

/**
 * 某币**此刻**的供应量闸门（枚）—— 「允许锁走的占比 × 当年真实流通量」（§15.1 / §15.4）。
 *
 * ⚠️ 2026-09-30 起流通量取的是**真实序列**（`market.supplyAt`，读 `index.json` 的 `circulating`，
 *    逐年锚点线性插值），不再是 `config` 里那个固定的枚数 —— 那个数的分母是总供应量，
 *    与 K 线头部显示的流通量是两套口径（详见 `config.SUPPLY_SHARE` 的注释）。
 * ⚠️ 取不到流通量（清单里没这个币 / `manifest` 还没加载）⇒ 返回 `Infinity`（**不设闸门**）：
 *    宁可漏放一条背景约束，也不能因为一个数据缺格把所有买入都拒掉。
 *  ⚠️ 不导出（2026-10-04 审计 R6）：仅 `openCheck` 用。
 */
function supplyCapOf(sym, i) {
  const share = SUPPLY_SHARE[sym];
  const circ = supplyAt(sym, i);
  return share != null && circ > 0 ? share * circ : Infinity;
}

/**
 * **实质归零的门槛**（2026-10-05 用户拍板「改成与 `openCheck` 同源」）——
 * 「在本所，把**杠杆 / 合约两条通道**里各自的上限杠杆都用上，开**最小一单**需要多少可用余额」，
 * 取两条通道中**更低**的那条：只要够得着一条，玩家就还能继续玩。
 *
 *     门槛 = min over kind ∈ {margin, fut} of  openNeedAt(本所, 此刻, kind, 该通道上限杠杆)
 *
 * ⚠️ **旧式（`最小名义 ÷ 最高杠杆`）在四处与 `openCheck` 的真实闸门不一致**，各自留下一条
 *    「开不出一单、却也不算归零」的死区（时钟照走、本局永不结束 —— 用户报的正是这类阻塞）：
 *    ① **漏了开仓费**：真实闸门除「`保证金 × 杠杆 ≥ 最小名义`」还有「`保证金 + 费 ≤ 可用余额`」，
 *       反解出来是 `最小名义 × (1/杠杆 + 费率)`，比旧式多一项 `最小名义 × 费率`
 *       （Bitfinex 2013 ⇒ 门槛从 $3.0303 抬到 $3.0506，缺口 $0.02）；
 *    ② **只按杠杆通道算**：Binance 永续最小名义 $5、125x ⇒ 门槛 $0.04 —— 手握 $0.05 的玩家
 *       本来还能做合约，旧式却按 $3.05 判他归零（**误判结束**，比死区更严重）；
 *    ③ **用该通道上限杠杆，而不是玩家当前所设的杠杆**（见下条）；
 *    ④ **该所当时根本没这条通道**时旧式仍按它算了一个门槛（`minNotionalAt` 回落 $1）。
 *
 * ⚠️ **为什么取「该通道的上限杠杆」而不是玩家此刻设的杠杆**（2026-10-05 二次拍板）：
 *    杠杆选择器就在交易页上，玩家**随时可以**把杠杆拉高 ⇒ 拿当前杠杆当门槛，会把一个
 *    「拉到 3x 就还能继续玩」的玩家（美国 1x / $5）当场误判归零。门槛只在
 *    「**任何杠杆都开不出一单**」时才该判死。代价是「1x 下按钮置灰、要玩家自己拉杠杆」
 *    这种**软阻塞** —— 比误判结束轻得多，且玩家一眼能看到杠杆键。
 *
 * ⚠️ **只算资金闸门，不算行情闸门**：停机维护（`haltedAt`）、极端行情保护带（`BAND`）、
 *    币没上线、取不到价 —— 这些都是**会过去的**临时状态，拿它们判归零等于「一次停机就炸号」。
 *    所以这里只反解资金那两条，与 `openCheck` 里那几条并行存在、互不替代。
 *
 * ⚠️ **这个门槛是 U 计价的最小名义反解出来的，而比它的是 `equity`（市值口径）** ——
 *    缺口 2（2026-10-08）把 `equity` 改成按 `usdtPriceAt` 重估现金之后，两边不再严格同口径：
 *    U 折价（如 2018-10-15 的 0.88）会让手全押在 U 上的玩家市值缩水 ⇒ 门槛附近（数美分宽的
 *    一条窄带）可能被**判归零**。这是用户拍板要的口径（脱锚确实让「手上的钱」变少），
 *    而不是漏洞：门槛量级（<$1）上的差别最多几美分，且史实里 U 的脱锚都在数天内回锚。
 * ⚠️ 两条通道都取不到（理论上不会）⇒ 退回 `MIN_NOTIONAL`，不制造离谱阈值。
 * ⚠️ **导出**（2026-10-05）：审计要拿它复算「门槛 == 真·开得出一单的门槛（死区宽度 = 0）」。
 */
export const ruinFloorOf = s => {
  const t = timeOf(s);
  let floor = Infinity;
  for (const kind of ['margin', 'fut']) {
    /* 该所此刻不提供这条通道 ⇒ 它压根不是一个选项，跳过（旧式在这里会凭空造一个 $1 门槛）。 */
    if (!hasLeverageKindAt(t, s.ex, kind)) continue;
    const need = openNeedAt(s.ex, t, kind, maxLeverageAt(t, s.ex, kind), vol30Of(s, s.ex, s.i, kind));
    if (need < floor) floor = need;
  }
  return Number.isFinite(floor) ? floor : MIN_NOTIONAL;
};

/**
 * 账户**实质归零**即破产（GDD §1.3）—— 判据 = 「本所两条通道、任何杠杆都开不出一单」。
 */
const isBankrupt = s => equity(s) < ruinFloorOf(s);

/**
 * 这一次「开不出一单」该怎么说（2026-10-05）—— 遮罩标题 / 日志 / 结算页**共用同一条判据**：
 *   · 权益 ≤ 0 ⇒ 「账户归零」（真的清零 / 穿仓倒欠）；
 *   · 权益 > 0 但低于 `ruinFloorOf` ⇒ 「无力开仓」（还有钱，只是连该所最小一单都凑不出）。
 *
 * ⚠️ 只在 `checkRuin` 判真之后调用 ⇒ 不会出现「明明还有得玩却说无力」。
 * ⚠️ 与 `isBankrupt` 同一把尺子（都用 `equity`），所以这两句话在边界上不会互相打架。
 */
export const ruinLabelOf = s => (equity(s) <= 0 ? '账户归零' : '无力开仓');

/* ───────────────────────────── 滑点（P2-B1） ───────────────────────────── */

/* σ 的缓存：键 = 币，值 = { day, v } —— 同一天内不必重扫 30 个日收盘。
   装的是「日收益 σ」（滑点的 σ_30日），也是 NPC 热度里位移标准化的分母（§73.5）。

   ⚠️ **为什么写位移不用刷这份缓存**（2026-10-08 · 跳时间卡死第三刀，此前每次 `invalidateSigma()`
      都整表清空 ⇒ 每次重算 39 个日收盘读全部冷扫，实测占跳全程的 ~60%）：
      条目 `{day, v}` 在 day D 内的某小时 i₀ 创建，窗口只读 **d×24+23（d < D）** 的已收盘日收盘，
      最新一根 = `D×24−1`；而位移写入恒 `at = 写入那一刻的 s.i ≥ D×24 > D×24−1`（god.js 的
      「逐根台阶」硬纪律：`j < at` 的根一律不受影响）⇒ **创建条目时全部输入已冻结、之后的任何
      写入都影响不到它们**。时间只前进 ⇒ 重算值与缓存值逐位相同，清空是纯浪费。
      唯一的例外是**跳时间重置**（`rewindTo`，2026-10-08 三批起向前/向后统一走它）：
      `s.i` 落点、位移池清零，同日条目可能带旧值命中
      ⇒ 那里仍要 `invalidateSigma()`（仅此一处）。 */
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

/* σ 的**短窗**缓存（缺口 18 的波动率项用）—— 与 `daySigmaCache` 同形、同一条失效纪律。 */
const daySigmaFastCache = new Map();

/**
 * 近 `HEAT.volWindow` 天「日收盘收益率」的总体标准差 —— 热度方程里**波动率项**的**分子**
 * （缺口 18 · 2026-10-02 用户拍板 `kVol = 0.02`，口径与依据见 `god.HEAT.kVol` / `volWindow`）。
 *
 * ⚠️ **它是「另一个时间尺度上的同一个量」，不是第二个度量**：估计量（`sigmaOf` 的总体标准差）、
 *    「日收盘」的定义（`d × 24 + 23` 那一根的收盘）**都与 `dailySigma` 逐字相同**，
 *    只有窗口不同（`HEAT.volWindow` = 7 天 vs `SLIP.window` = 30 天）⇒ 两者之比就是
 *    F&G「当前波动率 vs 近月均值」的那条**偏离**。
 * ⚠️ **为什么不复用 `dailySigma`**：那个是 `σ_30日`，同时是滑点 / OTC 溢价的**分母** ——
 *    改它的窗口会连带改成交代价。两把尺子必须各留一份缓存。
 * ⚠️ 与 `dailySigma` 同一条纪律：它读 `closeAt`（**含位移**）⇒ 只有跳时间重置（`rewindTo`）
 *    才需要失效 —— 正常推进里窗口全是已冻结的历史日收盘（见 `daySigmaCache` 头注）。
 */
function dailySigmaFast(sym, i) {
  const day = dayIndexOf(i);
  const hit = daySigmaFastCache.get(sym);
  if (hit && hit.day === day) return hit.v;

  const closes = [];
  for (let d = day - HEAT.volWindow - 1; d < day; d++) {
    closes.push(closeAt(sym, d * HOURS_PER_DAY + HOURS_PER_DAY - 1));
  }
  const v = sigmaOf(closes);
  daySigmaFastCache.set(sym, { day, v });
  return v;
}

/* σ 的**原始行情版**（2026-10-04 · 缺口「画门」根因修）—— 与 `dailySigma` **逐字同估计量 /
   同窗口**（`sigmaOf` 总体标准差、30 个日收益、`d×24+23` 的日收盘），唯一差别是读 `rawCloseAt`
   （**不含任何位移**）。专供 NPC 层把「净持仓」折成价位偏移（`syncNpcDrift` / `stepAdvPush`）。

   ⚠️ **为什么必须另开一份**（实测病根）：`dailySigma` 读 `closeAt`（**含位移**），而 `npcDrift`
      的位移又拿 `dailySigma` 当 σ ⇒ **自反馈环**：位移↑ ⇒ σ↑ ⇒ 位移↑。12 年实测把 σ 从原始
      行情的年化 **0.51** 顶到 **4.50**（×9）、`npcDrift` 顶到 **±30%**、显示价 **20.2%** 的时间被
      钉死在 `riseMax=+20%` 夹子上（另有 2.5% 钉在 `−45%`）—— 这正是玩家看到的**「画门」**
      （阶梯跳变 + 平顶 + 与原始行情脱钩的方波）。用**不含位移**的 σ 折算，这条环路断开。
   ⚠️ **不需要 `invalidateSigma()`**：它不读任何位移 ⇒ 位移变了它也不变（这正是目的）。 */
const daySigmaRawCache = new Map();
function rawDailySigma(sym, i) {
  const day = dayIndexOf(i);
  const hit = daySigmaRawCache.get(sym);
  if (hit && hit.day === day) return hit.v;

  const closes = [];
  for (let d = day - SLIP.window - 1; d < day; d++) {
    closes.push(rawCloseAt(sym, d * HOURS_PER_DAY + HOURS_PER_DAY - 1));
  }
  const v = sigmaOf(closes);
  daySigmaRawCache.set(sym, { day, v });
  return v;
}

/* σ 的**原始行情版短窗**（P1-8 · 2026-10-04 审计）—— 与 `dailySigmaFast` 逐字同估计量 / 同窗口
   （`sigmaOf` 总体标准差、`HEAT.volWindow` 天、`d×24+23` 日收盘），唯一差别是读 `rawCloseAt`
   （**不含位移**）。F&G 的波动率子项是「短窗 σ ÷ 长窗 σ 的偏离」—— 两个 σ 必须**同源**：
   长窗那一路已按 P1-7 改成 `rawDailySigma`（因为分子 `heatPriceAt` / `rawCloseAt` 读原始行情），
   短窗若仍读 `closeAt`（含位移）就成了「原始 ÷ 位移」的杂配。
   ⚠️ **不需要 `invalidateSigma()`**：同 `rawDailySigma`，它不读任何位移 ⇒ 位移变了它也不变。 */
const daySigmaRawFastCache = new Map();
function rawDailySigmaFast(sym, i) {
  const day = dayIndexOf(i);
  const hit = daySigmaRawFastCache.get(sym);
  if (hit && hit.day === day) return hit.v;

  const closes = [];
  for (let d = day - HEAT.volWindow - 1; d < day; d++) {
    closes.push(rawCloseAt(sym, d * HOURS_PER_DAY + HOURS_PER_DAY - 1));
  }
  const v = sigmaOf(closes);
  daySigmaRawFastCache.set(sym, { day, v });
  return v;
}

/**
 * **玩家持仓占可交易浮筹的比例**（`0 ~ 1`）—— 「持仓影响市场」那份唯一的占比（`config.FLOAT`）。
 *
 *   分子 = `capturedOf`（**杠杆多头**的枚数；F3 起含 OTC 多头 —— 见 `state.capturedOf`）
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
 * 该小时的**基准深度分母（未含对抗性折减）** ＝ `liqOf(当天) × hourShareK(该小时份额, …) × 浮筹折减`
 * —— **不含**瞬时深度池（池容量要拿它当基数 ⇒ 不能在它里面自洽引用，见 `poolFactorOf`），
 * 也**不含**对抗性折减（那是 `hourLiqBase` 再乘一层，见 `advDepthMul`）。
 * 口径与改动前的 `hourLiqOf` 逐字相同。
 *
 * 分母口径（C2，2026-09-29 拍板）：完整交易日里系数 = 24 × share，其**当日均值恰为 1**
 * ⇒ 一天下来的平均行为与「只用日流动性」**完全一致**（`A` / `threshold` / `cap` 无需重校），
 * 只是薄盘时段更痛、活跃时段更轻。
 *
 * **浮筹折减**（v18 · 2026-10-01 拍板）：`max(FLOAT.depthFloor, 1 − share)` —— 你囤走的浮筹越多，
 * 市场能承接的深度越薄，同一笔单子的 `q` 越大、滑点越痛。下夹 `FLOAT.depthFloor` 是为了在
 * `share → 1` 时不把分母压到 0（否则 `q` 无穷大，滑点与拆单笔数都会失控）。
 *
 * ⚠️ **为什么把「未折减」这一层单独拆出来**（2026-10-02 · `ADV`）：对抗性流动性的触发量是
 *    `exposure = 持仓名义 ÷ 本值`。若拿**折减后**的 `hourLiqBase` 当分母，「深度变薄 ⇒ exposure
 *    变大 ⇒ 更薄」当场自激 —— §5.3 那条「不新开第二把尺子」的红线要求分母是同一条，
 *    但必须是它**折减之前**的形态。
 *
 * @returns {number} 分母；取不到当日流动性时返回 0
 */
export function hourLiqRaw(s, sym, i) {
  const day = dayIndexOf(i);
  const liq = liqOf(sym, day);
  if (!(liq > 0)) return 0;
  const { sum, n } = dayVolShare(sym, day);
  const shrink = Math.max(FLOAT.depthFloor, 1 - floatShareOf(s, sym, i));
  return liq * hourShareK(volumeAt(sym, i), sum, n) * shrink;
}

/* ───────────────── 对抗性流动性（提案 B 档 1 · NEXT-STEPS §五 · 2026-10-02）─────────────────
   做市商看到「你的仓位相对这个小时的深度太大」就**撤深度**（不是猎杀止损，§5.4）。
   四样东西共用**一个** `exposure`、**一个**深度乘数：
     ① `hourLiqBase` 的折减（滑点 / 拆单笔数 / 瞬时深度池容量**全部连带**）
        ⚠️ v30 起**资金费不再走这条深度分母**（改由 `longShareOf` 的多空比驱动）⇒ 不再连带。
     ② OTC 点差放大（`otcPremiumFor`，`1 ÷ 深度乘数`）
     ⚠️ ② 只覆盖**玩家侧**那半（`advSpreadMul`）。**市场级**那半（踩踏 / 逼空期间放大）是
        另一个乘数 `heatSpreadMul`（缺口 11 · 2026-10-02 拍板），与 ② 相乘喂给同一个
        `otcPremiumFor`。两者读的是**不同**的输入（玩家仓位 vs 市场热度），不得合并。
     ③ 预警日志（`advTick`，深度乘数首次 ≤ `ADV.warnMul` 时播一条，带闩锁）
     ④ **档 2 有向推价**（缺口 6-B · 2026-10-03）：`exposure ≥ ADV.t2` 时，向玩家持仓的**逆向**
        施加一笔位移 `permImpactOf(pushK × (exposure − t2), σ)`，**折进 `s.mkt[sym].npcDrift`
        同一张台阶表**（不新开第二条价格通道）。它走的是**当前**持仓（`advCurExposureOf`，疤痕不算）。

   ⚠️ **口径**：`exposure` 只算**杠杆盘**（合约 / 杠杆 > 1）的名义 —— 杠杆 1x 是**实物**，
      它走的是 `FLOAT` 那条「浮筹折减」通道（§5.3），两处不能重复计。
   ⚠️ **撤走的深度要一周才回来**（`ADV.halfHours`）：只按当前持仓算的话，玩家一平仓深度立刻复原，
      「撤流动性」就变成一句空话。所以留一条 `s.adv[sym] = { v, at }` 的**峰值台阶**：
     有效 exposure = `max(当前 exposure, 峰值 × 0.5^(经过小时 ÷ 168))`。
   ⚠️ **读路径绝不写状态**：`advDepthMul` / `advSpreadMul` 只读 `s.adv`；台阶的写入与预警日志
      全部收在**每小时一次**的 `advTick` 里。否则 `openCheck` / `closeCheck`（`render.js` 每帧都调）
      会变成「渲染即改存档」—— 那正是位移层那条硬纪律要防的东西。 */

/** 峰值台阶在 `i` 时刻的残值（纯读；`i ≤ at` 时不衰减）—— 与 `s.pool` 的 `poolRefill` 同形。 */
function advPeakOf(s, sym, i) {
  const a = s.adv && s.adv[sym];
  if (!a || !(a.v > 0)) return 0;
  const e = i - a.at;
  return e > 0 ? a.v * Math.pow(0.5, e / ADV.halfHours) : a.v;
}

/**
 * 玩家此刻在该币的**当前**杠杆名义 ÷ 折减前基准深度 —— **不含**峰值疤痕（`s.adv`）。
 *
 * ⚠️ 档 1 与档 2 的判据**故意不同**：档 1（撤深度）走 `advExposureOf`（含疤痕 —— 撤走的深度
 *    一周才回来），档 2（推价）走**本函数**（只看当前持仓 —— 平仓即停止施压，§5.1「疤痕不算」）。
 * ⚠️ 只算**杠杆盘**（合约 / 杠杆 > 1）：杠杆 1x 是实物，走 `FLOAT` 那条浮筹折减（§5.3）。
 */
function advCurExposureOf(s, sym, raw) {
  if (!(raw > 0)) return 0;
  const pos = s.positions[sym];
  if (!pos || (isMargin(pos) && pos.lev === 1)) return 0;
  const mark = lastPrice(s, sym);
  /* M4b（2026-10-08 拍板②）：分母过 `gm` —— 市场整体放大 ⇒ 你相对市场的体量按同一倍数缩小。
     否则「把市场调大 4 倍，ADV 仍认为你占了 4 倍体量」⇒ 撤深度 / OTC 点差与你刚拨的旋钮互相打
     （旋钮本意就是「我的单子只推动 1/gm」）。**玩家名义额是绝对值、不过闸**（红线 A）。
     ⚠️ 本函数是 `exposure` 的**唯一**入口 ⇒ `advDepthMul` / `advSpreadMul` / `advPushOf` /
        `advAimAmp` / 浮窗深度页全部同源跟随，没有第二条尺子。`gm === 1` ⇒ 逐位不变。 */
  const d = godScale(s, sym, raw);
  return mark > 0 ? pos.size * mark / d : 0;
}

/**
 * 该币此刻的**有效 exposure** ＝ `max(当前持仓名义 ÷ 折减前基准深度, 峰值台阶残值)`。
 * 分母由调用方传入（它刚算过 `hourLiqRaw`，别重算一遍）。
 */
function advExposureOf(s, sym, i, raw) {
  const cur = advCurExposureOf(s, sym, raw);
  const peak = advPeakOf(s, sym, i);
  return cur > peak ? cur : peak;
}

/**
 * **档 2 · 有向推价**（缺口 6-B · 2026-10-03 用户拍板 `pushK = 1.0`）—— 返回一笔**带符号**的
 * 价格位移（多 ⇒ 负、空 ⇒ 正），折进 `s.mkt[sym].npcDrift` 同一张台阶表（见 `syncNpcDrift`）。
 *
 * 口径（§5.1 档 2 / §5.5）：
 *   · **只在当前持仓存在且 `exposure ≥ ADV.t2`** 时生效（疤痕不算 ⇒ 平仓即释放）；
 *   · `q = ADV.pushK × (exposure − t2)`，幅度 = `permImpactOf(q, σ)` —— 与玩家自己砸同样名义时
 *     **同一把尺子**（`permImpactOf` 的 `q` 口径），不新立第二条公式；
 *   · 方向恒为玩家持仓的**逆向**（做市商吃下对手盘后，其库存回补的压力把价格往回推 ——
 *     Brunnermeier & Pedersen 2005 的掠夺方向；§5.4 已明令文案不许写成「猎杀止损」）。
 *
 * **档 3 · 强平簇吸引**（缺口 15 · 2026-10-03 用户拍板）：在档 2 之上，把幅度乘一个**距离感知**
 * 的倍率 `advAimAmp`（离强平线越近越大，`d ≥ dRef` 时恰为 1），再夹在 `ADV.aimCap × σ`。
 *
 * ⚠️ **不是新通道**：位移最终只经 `factorFor` 一处生效（与 `npcDrift` 同源），且是**有界**的 ——
 *    档 2 被 `SLIP.cap` 夹住 ⇒ `≤ σ`；档 3 再过一道 `aimCap·σ`（`≤ 1.5σ`）⇒ 不累积、不顶夹子。
 */
function advPushOf(s, sym, i, sig) {
  const pos = s.positions[sym];
  if (!pos) return 0;
  const e = advCurExposureOf(s, sym, hourLiqRaw(s, sym, i));
  if (!(e >= ADV.t2)) return 0;
  const base = permImpactOf(ADV.pushK * (e - ADV.t2), sig);
  if (!(base > 0)) return 0;
  /* 档 3 · **强平簇吸引**（缺口 15 · 2026-10-03 用户拍板）：同一个 `base` 乘一个**距离感知**的
     倍率，再夹在 `aimCap × σ`。不新开通道、不新开分母 —— 只在档 2 这一条式子上多一个因子。 */
  const mag = Math.min(base * advAimAmp(s, sym, e, sig), ADV.aimCap * sig);
  if (!(mag > 0)) return 0;
  return pos.side === 'long' ? -mag : mag;
}

/**
 * **档 3 的距离感知倍率**（缺口 15 · 2026-10-03）—— `amp ∈ [1, 1 + ADV.kAim]`。
 *
 *     d   = |现价 − 强平价| ÷ 现价        （到强平线的相对距离）
 *     amp = 1 + kAim · clamp(1 − d ÷ (dRefSig·σ), 0, 1)
 *
 * 诱因**两个都要满足**（§5.4：不做凭空针对）：`exposure ≥ ADV.t3` **且** `d ≤ dRef`。
 * 缺任一条 ⇒ 返回**恰好 1**（乘上去逐位等于档 2，零回归）。
 *
 * ⚠️ 只在**有强平线的活仓**上算：`canLiquidate(pos)` 为假（杠杆 1x 实物多头）⇒ 返回 1
 *    —— 与 `advCurExposureOf` 的口径一致（实物盘本来就不进 `exposure`，这里也不该进）。
 * ⚠️ **只读**：不写任何状态（本函数会被 `advTick` 与 `tickMarket` 两条每小时的路径调用）。
 */
function advAimAmp(s, sym, e, sig) {
  if (!(e >= ADV.t3) || !(ADV.kAim > 0) || !(sig > 0)) return 1;
  const pos = s.positions[sym];
  if (!pos || !canLiquidate(pos)) return 1;
  const mark = lastPrice(s, sym);
  const lp = liquidationPrice(pos);
  if (!(mark > 0) || !Number.isFinite(lp)) return 1;
  const ref = ADV.dRefSig * sig;
  if (!(ref > 0)) return 1;
  const d = Math.abs(mark - lp) / mark;
  if (!(d < ref)) return 1;
  return 1 + ADV.kAim * (1 - d / ref);
}

/**
 * **档 2 推价的缓入缓出**（2026-10-03 用户拍板 `ADV.pushHalf = 6h`）—— 把 `advPushOf` 那个
 * **瞬时开关**换成一阶低通，返回本小时该用的推价（并把新值写回 `m.advPush`）：
 *
 *     m.advPush += (advPushOf(…) − m.advPush) × (1 − 0.5^(1 / ADV.pushHalf))
 *
 * 病根（用户实测「画门」＋「反复画门」）：推价原来**平仓即归零**，下一小时 `syncNpcDrift` 落的
 * 那级台阶把 −6.03% 一步放到 +3.2%（单步 **+10.7%**，`market.candleAt` 又把它压进同一根 ⇒
 * 单根振幅 13.6%）。真实盘口是被**库存回补**一点点吃回来的（Avellaneda–Stoikov），不是开关；
 * 缓动之后单小时只走 **10.9%**，同一场景的单步只剩约 0.7%。
 *
 * ⚠️ **只在每小时一次的写路径上调用**（`syncNpcDrift`；`tickMarket` 跑当前币、`advTick` 跑其余
 *    持有 / 疤痕币，两处对同一个币每小时各只跑一次）—— 本函数**改状态**，挂到每帧都跑的读路径上
 *    会变成「渲染即改存档」。
 * ⚠️ **残尾归零**（`NPC.driftEps`）：`0.5^(t/6)` 渐近但永远到不了 0，留着只会让台阶表多出
 *    「值已看不出来、却还在缓慢变化」的噪声级。
 * ⚠️ 平滑的是**推价**，不是 `npcDrift` 整体：NPC 散户净持仓那一份该多快就多快（它是**存量**折算，
 *    本来就连续）；被平滑的只有「撤深度 ⇒ 逼库存回补」这条**会突然消失**的项。
 */
function stepAdvPush(s, sym, i, sig) {
  const m = mktOf(s, sym);
  const cur = Number.isFinite(m.advPush) ? m.advPush : 0;   // 旧存档没有这个键 ⇒ 视作 0
  const target = advPushOf(s, sym, i, sig);
  const a = 1 - Math.pow(0.5, 1 / ADV.pushHalf);
  let next = cur + (target - cur) * a;
  if (Math.abs(next) < NPC.driftEps) next = 0;
  m.advPush = next;
  return next;
}

/**
 * 深度乘数 ∈ `[ADV.floor, 1]` —— **档 0 恰好返回 1**（`hourLiqBase` 里 `mul === 1` 早退 ⇒ 逐位不变）。
 */
function advDepthMul(s, sym, i, raw) {
  const e = advExposureOf(s, sym, i, raw);
  if (!(e > ADV.t1)) return 1;
  return Math.max(ADV.floor, 1 - ADV.k * (e - ADV.t1));
}

/**
 * OTC 点差放大倍数（`1 ÷ 深度乘数`）—— 盘口越薄、大宗报价越宽。档 0 时**恰好 1**。
 *
 * ⚠️ **口径注 · 为什么这里只读玩家自己的仓位**（缺口 11 · 2026-10-02 用户拍板
 *    「**只补市场级，玩家侧不做**」，完整审计见 NEXT-STEPS §8.8）。
 *
 *    审计事实：本函数的分母是 `advExposureOf` ＝ **玩家自己**的杠杆名义 ÷ 基准深度。
 *    于是「NPC 级联 / 极端热度」期间 —— 市场正在踩踏 —— 点差**完全不变**（玩家没动仓 ⇒ `mul === 1`）。
 *    这确实是缺口，但**玩家侧的订单流失衡不该在这里补**，三条理由：
 *      ① 「玩家把点差推宽」**已经有三层在计价**：`s.flow`（永久台阶，逐笔列出不过期）＋
 *         本函数（撤深度 ⇒ `1/d` 放大）＋ `impactOf`（成交代价，含 threshold 死区）。
 *         再加一条「玩家自己的订单流失衡 ⇒ 点差」＝**同一件事的第三次计价**；
 *      ② 玩家成交是**点状**的（一笔单只在那根 K 线上失衡），而点差是**状态量**（挂在那里等你成交）
 *         ⇒ 拿点状的量去驱状态量，只能靠一条人为的「记忆」通道，那条通道必然又变成 `npcDrift`
 *         式的自激（本作既有审计已修过一次同款病根）；
 *      ③ 本作**没有**全市场订单簿失衡的数据源（数据包只有 OHLC ＋ 逐小时成交份额字节，
 *         见 `market.js`）⇒ 玩家侧那条要成立，只能硬编一张表，违反「不新开第二个度量」的红线。
 *
 *    ⇒ 结论：**玩家侧不做**。要补的是**市场级** —— 即 `advSpreadMul` 之外，另加一个
 *       「级联 / 极端热度期间放大 OTC 点差」的乘数（文献依据：2025-10-10 崩盘，BTC 永续点差
 *       0.02bps → 26.43bps、盘口深度 −98.3%，做市商 35 分钟恢复九成 ⇒ 放大必须**短时、有界、
 *       随级联衰减**）。**该乘数尚未实现**，幅度与源待用户拍板（NEXT-STEPS §8.8）。
 */
function advSpreadMul(s, sym) {
  const raw = hourLiqRaw(s, sym, s.i);
  if (!(raw > 0)) return 1;
  const d = advDepthMul(s, sym, s.i, raw);
  return d >= 1 ? 1 : 1 / d;
}

/**
 * 对抗性流动性的**每小时落账**（由 `advanceOneHour` 调用）：
 *   ① 把本小时的有效 exposure 抬进峰值台阶（**只抬不降** —— 降靠 `advPeakOf` 的半衰期）；
 *   ② 深度乘数首次跌到 `ADV.warnMul` 以下时播一条预警日志（带闩锁）；
 *   ③ **档 2 有向推价**（缺口 6-B）：对本小时遍历到的每个币跑一次 `syncNpcDrift`，把
 *      `advPushOf` 叠进该币的 `npcDrift` 台阶表；进入档 2 播一条预警（闩锁 `s.advWarn2`）。
 *
 * ⚠️ 为什么必须**每小时单独跑一次**（而不是挂在读路径上）：
 *    ① 读路径是**纯函数**（`openCheck` / `closeCheck` 每帧都被 `render.js` 调到），在它里面写状态
 *       等于「渲染即改存档」；
 *    ② 玩家平掉那条仓之后，**再没有任何代码会去读那条币的分母** —— 峰值台阶若靠读路径刷新，
 *       就永远停在最后那个值上，「撤走的深度一周才回来」也就无从谈起（虽然这条对结果恰好无害，
 *       但语义上说不通，且会让「清仓后深度不恢复」变成一个没人能解释的行为）。
 *
 * ⚠️ 闩锁口径与 `s.otcOff` **同一先例**：退回档 0（`exposure ≤ t1`）才解除，中途不重复播报 ——
 *    满足「一局内同一事件描述最多出现一次」的那条规矩（阈值以上的连续区间算**一件**事）。
 */
function advTick(s) {
  if (!s.adv) s.adv = {};
  const syms = new Set(heldSyms(s));
  for (const k in s.adv) syms.add(k);   // 已平掉但疤痕还在的币也要继续衰减
  let drop = 0, maxE = 0, pushMax = 0, aimMax = 1, aimPushMax = 0;
  for (const sym of syms) {
    const raw = hourLiqRaw(s, sym, s.i);
    if (!(raw > 0)) continue;
    const e = advExposureOf(s, sym, s.i, raw);
    if (e > 0) {
      if (e > advPeakOf(s, sym, s.i)) s.adv[sym] = { v: e, at: s.i };
      if (e > maxE) maxE = e;
    }
    const d = 1 - advDepthMul(s, sym, s.i, raw);
    if (d > drop) drop = d;
    /* 缺口 6-B（2026-10-03）：档 2 的**有向推价**折进 `npcDrift` 台阶表。
       ⚠️ **跳过当前币 `s.sym`**：它刚在 `tickMarket` 里调过一次（且那一次早于踩踏级联，
          是本作既有的口径）—— 再调一次会在「本小时恰好踩踏」时用**清算后**的 `npcNet`
          多落一级、改变既有行为。跳过 ⇒ 当前币语义一字不动。
       ⚠️ 其余**持有币 / 疤痕币**必须在这里补：`tickMarket` 只跑当前币，而「拿着大仓去看别的币」
          时那个大仓同样要被推价；**平仓之后**这一步会写回 0 把推价释放（否则它会永远粘住）。 */
    /* ⚠️ 2026-10-04：σ 改读**原始行情**（`rawDailySigma`）。这里折的是**价位偏移**
       （推价 / 净持仓），拿「含位移」的 σ 当尺子就是自反馈环（见 `rawDailySigma` 表头）。
       同源改动：`tickMarket` 的 `syncNpcDrift` 那一处、以及下面 `advAimAmp` 的距离参考。 */
    const sig = rawDailySigma(sym, s.i);
    if (sym !== s.sym) syncNpcDrift(s, sym, s.i, sig);   // 内含 `stepAdvPush`（缓动后）的写
    /* 报警读的必须是**缓动之后**实际生效的推价（`m.advPush`），不是那个瞬时目标值：
       `s.sym` 的缓动刚在 `tickMarket` 里走过，其余币刚在上面这一行走过 ⇒ 两者都是本小时的值。
       ⚠️ 这里**只能读**，不能再调一次 `stepAdvPush` —— 那会让同一个币一小时走两格。 */
    const mk = s.mkt && s.mkt[sym];
    const p = mk && Number.isFinite(mk.advPush) ? Math.abs(mk.advPush) : 0;
    if (p > pushMax) pushMax = p;
    /* 缺口 15 · 档 3（强平簇吸引）的预警取样：`advAimAmp` 用**当前** exposure，与 `advPushOf`
       同一支口径（疤痕不算）。`> 1` 即「本小时有活仓正处在强平线附近」⇒ 该播就播。 */
    const aim = advAimAmp(s, sym, advCurExposureOf(s, sym, raw), sig);
    if (aim > aimMax) { aimMax = aim; aimPushMax = Math.max(aimPushMax, p); }
  }
  if (drop >= 1 - ADV.warnMul) {
    if (!s.advWarn) {
      s.advWarn = true;
      pushLog(s, `多家交易所盘口变薄 ｜ 深度较常态下降 ${Math.round(drop * 100)}%`, 'bad', 'mkt');
    }
  } else if (maxE <= ADV.t1) {
    s.advWarn = false;
  }
  /* 缺口 6-B：档 2 推价的预警（§5.2 硬要求 —— 被打之前必须看得见）。口径与 `s.advWarn` 同一先例：
     进入档 2 播一条，退回档 0 才解除 —— 中间（档 1 区间）不重复播。§5.4：不写「猎杀止损」。 */
  if (pushMax > 0) {
    if (!s.advWarn2) {
      s.advWarn2 = true;
      pushLog(s, `盘口承接力不足 ｜ 大额持仓出现额外 ${fmtRate(pushMax, 1)} 不利偏移`, 'bad', 'mkt');
    }
  } else if (maxE <= ADV.t1) {
    s.advWarn2 = false;
  }
  /* 缺口 15 · 档 3（强平簇吸引）的预警（§5.2 硬要求 —— 被打之前必须看得见；§5.4：不写「猎杀止损」）。
     口径与 `s.advWarn` / `s.advWarn2` 同一先例：进档 3 播一条、退回档 0 才解除，中间不重复播。
     ⚠️ 文案只描述**市场结构**（价格在向你的强平簇靠）、**不描述意图** ——
        「算法故意扎针扫止损」无一手实证，§5.4 明令不许写。 */
  if (aimMax > 1) {
    if (!s.advWarn3) {
      s.advWarn3 = true;
      pushLog(s, `价格正逼近你的强平线 ｜ 大额持仓引来额外 ${fmtRate(aimPushMax, 1)} 不利偏移`, 'bad', 'mkt');
    }
  } else if (maxE <= ADV.t1) {
    s.advWarn3 = false;
  }
}

/**
 * **上帝深度旋钮**（2026-10-08 用户拍板）—— 拉盘后订单簿「越拉越薄」的现实化出路：
 * 价格被推离史实越远，做市盘 / 挂单方越有理由跟上来 ⇒ 深度分母按**位移偏离史实的倍数**
 * 放大。闸门只加在 `hourLiqBase` 末尾一处 ⇒ 撮合 / 走簿 / 浮窗订单簿 / 压力位墙自动同源
 * （看到的深度 ＝ 撞上的深度，审计 9v 的恒等式不被破坏）。
 *
 *   · `'auto'`（缺省）＝ `clamp(1, 8, lastPrice ÷ indexPrice)` —— 价移比，自动跟随玩家把盘拉了多远；
 *   · 手动档 `1|2|4|8` ＝ 操盘台里拍死一个倍数（覆盖自动）。
 *
 * ⚠️ 只在上帝局生效：`s.god` 为空 ⇒ **恰好返回 1**（乘法恒等）—— 普通 / 挑战局逐位不变（审计红线）。
 * ⚠️ `s.god` 不进存档（会话级，`save.js` 落盘剔除）⇒ 旋钮同为会话级，读档回普通局自然归位。
 * ⚠️ 自动档分子 `lastPrice`（含位移）、分母 `indexPrice`（原始收盘）—— 与「偏离史实」的定义严格
 *    一致；任一价取不到（未上线 / 越界）⇒ 退回 1。自阻尼：位移↑ ⇒ mul↑ ⇒ 分母↑ ⇒ 后续位移↓。
 * @returns {number} 深度倍率，恒 ≥ 1（旋钮只把市场变大，不把市场变小）
 * ⚠️ 唯一的外部读数方：render.js 的量柱市场份（拍板④）—— 同一函数同一口径，不许各算各的。
 */
export function godLiqMulOf(s, sym = s.sym) {
  if (!s.god) return 1;
  const m = s.god.liqMul;
  if (m != null && m !== 'auto') {
    const n = Number(m);
    return Number.isFinite(n) && n > 1 ? Math.min(8, n) : 1;
  }
  const idx = indexPrice(s, sym), last = lastPrice(s, sym);
  if (!(idx > 0) || !(last > 0)) return 1;
  return Math.min(8, Math.max(1, last / idx));
}

/**
 * **市场放大**（M4b · 2026-10-08 拍板②「深度倍数 = 全套市场放大」）—— 把「市场规模」类的
 * 基数（当日流动性、近 24h 成交额…）乘上上帝深度旋钮。
 *
 * 病根：旋钮原来只乘在 `hourLiqBase` 一处 ⇒ 玩家把市场调大 8 倍后，**分母**变大了（自己的单子
 * 推动力变小），但 OI / 散户仓位 / 巨鲸页 / 爆仓阈值 / 量柱 / 基金池**全还是原来那么小** ⇒
 * 两套规模口径打架（「市场 8 倍大，OI 却一动不动」）。
 *
 * 修法：凡「市场规模」进入**除式分母**或**读数分子**的地方一律过这里 —— 一处函数、同一个 `gm`。
 * 与之配套的是**玩家自己的仓位不放大**（红线 A · 不双重计价）：玩家的名义额是**绝对值**，
 * 市场变大 ⇒ 他相对市场的体量**自动**缩小，这正是「×8 ⇒ 我的单子只推动 1/8」的语义。
 *
 * ⚠️ `gm === 1`（非上帝局 / 旋钮未动）⇒ **早退返回原值** ⇒ 与改动前逐位相同（审计红线）。
 * @param {object} s 状态
 * @param {string} sym 币种
 * @param {number} v 「市场规模」类基数
 * @returns {number} 放大后的基数（`gm === 1` 时恒等于 `v`）
 */
function godScale(s, sym, v) {
  const gm = godLiqMulOf(s, sym);
  return gm === 1 ? v : v * gm;
}

/**
 * **爆仓潮 / ADL 阈值的市场放大系数**（M4c · 2026-10-08 拍板⑤⑥）＝ `godLiqMulOf × sbOf.npc`：
 *   · `godLiqMulOf`（M4b）：市场规模整体放大 ⇒ 强平额同倍放大 —— 阈值不跟着抬，
 *     「把市场调大 ×8」就等于把爆仓潮频率也调大 8 倍（用户实测的「很频繁」）；
 *   · `sbOf.npc`：沙盒「散户规模」把六档靶心直接放大多少倍，强平额就放大多少倍。
 * ⚠️ 默认（普通 / 挑战局，或沙盒全默认）⇒ `1 × 1` ⇒ **恰好 1**（IEEE 恒等）⇒ 逐位不变。
 * ⚠️ **不含** `heat` / `mood` / `shock`：那三个改的是市场的**行为**（涨跌的方向与剧烈度），
 *    不是**规模** —— 它们带来的日志变密由冷却（`NPC.liqEventCd`）兜住，不在这里重复计价。
 */
function liqEventScaleOf(s, sym) {
  return godLiqMulOf(s, sym) * sbOf(s).npc;
}

/**
 * 该小时的**基准深度分母** ＝ `hourLiqRaw × 对抗性深度乘数 × 上帝深度旋钮`
 * —— **不含**瞬时深度池（池容量要拿它当基数 ⇒ 不能在它里面自洽引用，见 `poolFactorOf`）。
 * ⚠️ 上帝旋钮乘在**末尾**（2026-10-08）：`×1` 走 IEEE 精确恒等 ⇒ 普通局逐位不变。
 */
function hourLiqBase(s, sym, i) {
  const raw = hourLiqRaw(s, sym, i);
  if (!(raw > 0)) return 0;
  const mul = advDepthMul(s, sym, i, raw);
  const base = mul === 1 ? raw : raw * mul;
  const gm = godLiqMulOf(s, sym);
  return gm === 1 ? base : base * gm;
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
 * 操盘深度的 `q` 封顶（2026-10-07 用户拍板「两者都做」）：普通局 = `SLIP.cap`（0.25），
 * 上帝局放宽到 `MANIP_GOD_CAP`（1.0 ⇒ 单笔位移上限从 σ 提到 2σ）。**只传玩家侧**入口 ——
 * NPC 侧三条合成通道（`rawPermImpactFor` / `syncNpcDrift` / `stepAdvPush`）一律缺省，
 * 市场物理不因上帝变猛（红线 A · 不双重计价）。
 */
const godCapOf = s => (s.god ? MANIP_GOD_CAP : SLIP.cap);

/**
 * 一次成交的**行情位移量**（0 = 不触发）—— 与代价入口同形，但走**无死区**的 `permImpactOf`。
 *
 * ⚠️ 为什么必须另开一个入口（这是「大额买入不影响 K 线」的病根）：代价曲线（`impactOf` /
 *    现在的 `walkBook` 走簿）带 `threshold = 10%` 的**代价**死区 —— 单笔不到当日流动量的 10% 就返回 0。那个 0 若被
 *    拿去当永久位移，`god.addFlow(…, 0)` 当场早退，`s.flow` 里**一个字节都写不进去**。实测
 *    2015 年后 BTC 单小时要 ≥ $8.5 万、2021 年要 ≥ $1.76 亿才触发 ⇒ 玩家的单子在图上毫无痕迹。
 *    位移是**市场影响**（任何成交都有），代价是**收费**（小额免收），两件事不该共用一条死区。
 */
function permImpactFor(s, sym, i, notional) {
  const liq = hourLiqOf(s, sym, i);
  if (!(liq > 0) || !(notional > 0)) return 0;
  return permImpactOf(notional / liq, dailySigma(sym, i), godCapOf(s));
}

/**
 * **玩家侧走簿撮合**（2026-10-07 拍板「滑点改成真走簿逐档撮合」）—— 一次市价单吃簿的全程：
 *   · `cost`  加权平均滑点 —— `walkBook` 把 `impactOf(q, σ, cap)` 那条代价曲线摊开成 18 档
 *             逐档吃（审计 9v：对连续式 ≤1%）；顶格饱和 / 死区 / `hard` 上夹与 `impactOf` 同口径；
 *   · `n`     吃满用了几档（成交日志的「 · N 笔」）；
 *   · `eaten` 本笔**吃掉的墙** `[{p, w, frac}]` —— 供 `pushFlow → absorbedImpact` 做**精确耦合**
 *     （吃掉多少，位移吸收就折掉多少）。判定是**二值**的：本笔的触及距离
 *     `reach = 3σ√q_eff` ≥ 墙距 ⇒ 整条吃掉（`frac = 1`），否则不碰。
 *
 * ⚠️ 分母 / σ / cap 与位移入口（`permImpactFor`）**同一套来源**（`hourLiqOf` / `dailySigma` / `godCapOf`）——
 *    走簿不是第二套物理，只是同一条代价曲线的离散形态。
 * ⚠️ NPC 三通道（`rawPermImpactFor` / `syncNpcDrift` / `stepAdvPush`）不经过这里，
 *    市场物理零漂移（审计 9v 源码锚）。
 */
export function walkFillFor(s, sym, i, notional, dir, price) {
  const liq = hourLiqOf(s, sym, i);
  if (!(liq > 0) || !(notional > 0)) return { cost: 0, n: 1, eaten: [], q: 0, sigma: 0, cap: SLIP.cap, reach: 0 };
  const q = notional / liq;
  const sigma = dailySigma(sym, i);
  const cap = godCapOf(s);
  const r = walkBook({ sigma, cap, q });
  const eaten = [];
  if (price > 0 && r.reach > 0) {
    for (const L of levelsOf(sym, i)) {
      if (!(L.w > 0)) continue;
      const d = dir > 0 ? L.p / price - 1 : 1 - L.p / price;
      if (d > 0 && d <= r.reach) eaten.push({ p: L.p, w: L.w, frac: 1 });
    }
  }
  return { cost: r.impact, n: r.n, eaten, q, sigma, cap, reach: r.reach };
}

/**
 * **NPC 侧专用的行情位移** —— 与 `permImpactFor` 逐字同形，唯一差别是把 σ 换成
 * `rawDailySigma`（**不含任何位移**）。专供 `pushNpcShock`（级联 / 止损波那一条有界瞬时通道）。
 *
 * ⚠️ **为什么 NPC 侧必须用原始 σ**（2026-10-04 实测病根 · 用户拍板「基础要贴近现实」）：
 *    `permImpactFor` 读的 `dailySigma` 走 `closeAt`（**含位移**），而 NPC 级联本身就在制造位移
 *    ⇒ 又一条自反馈环：级联↑ ⇒ σ↑ ⇒ 级联位移↑。实测无玩家一局的**显示 σ** 被顶到原始行情的
 *    **1.8–2.4×**（BTC 0.51→0.89、ETH 0.68→1.63、SOL 0.95→2.28）—— 现实数据本身已含真实崩盘，
 *    引擎再叠一层自己的爆仓冲击，就是**波动率重复计算**。改用原始 σ 折算，这条环断开，
 *    级联的**频率 / 次数 / 方向**一字不改，只把每一步的**位移幅度**按真实行情量级归一。
 * ⚠️ 玩家自己的成交（`pushFlow`）仍走含位移的 `dailySigma` —— 那反映「当前市场有多脆」，
 *    是玩家**能感知**的对抗性反馈，不属于本处要断的自激环。
 */
function rawPermImpactFor(s, sym, i, notional) {
  const liq = hourLiqOf(s, sym, i);
  if (!(liq > 0) || !(notional > 0)) return 0;
  return permImpactOf(notional / liq, rawDailySigma(sym, i));
}

/**
 * 这一笔成交**实际能推动多少价** —— 原始冲击先被沿途的**历史压力位**吸掉一部分
 * （ROADMAP §六十四，2026-10-02 用户拍板「接入行情、不画线」）。
 *
 * 被扫到的位 = 落在 `(现价, 成交后价]` 这一段里的那些（卖单镜像）。撞上去推不动，
 * 就是「那个价位真的堆着货」；权重和越大吸得越狠，上限 `LEVELS.absorb`。
 *
 * ⚠️ **只吸位移，不吸代价**（红线 A · 不双重计价）：走簿代价（`walkFillFor` 的 `cost`）一个字节
 *    不受这里影响 —— 这一笔该付多少滑点照付，这里只决定**成交之后价格停在哪**。
 * ⚠️ 现价取**标记价**（含玩家已造成的位移）而不是原始收盘：压力位是「相对当前价」的位置，
 *    玩家把价推上去之后再撞的应该是上面那一条。撞穿后位落到现价下方 ⇒ 自然不再被扫到。
 * ⚠️ 没扫到位时返回**恰好 `impact`**（乘 1，IEEE754 精确）⇒ 开局头两天、无行情、
 *    或价格在两条位之间的那些情况，与改动前**逐位相同**。
 */
function absorbedImpact(s, sym, dir, impact, eaten = null) {
  if (!(impact > 0)) return impact;
  const p = lastPrice(s, sym);
  if (!(p > 0)) return impact;
  return impact * absorbOf(levelsOf(sym, s.i), p, dir, impact, eaten);
}

/**
 * 写一笔**行情位移** —— 开仓 / 平仓 / 强平 / 部分强平**四处共用**（改一处等于改四处）。
 *
 * 与改动前逐字相同的部分：`dir × SHOCK.share × permImpactFor(…)`、以及
 * 「`addFlow` 返真才写池子」（Δ 为 0 不写）。新增的只有中间那道历史压力位吸收。
 * ⚠️ 写完**不**刷 σ 缓存（2026-10-08，见 `daySigmaCache` 头注）—— 位移只影响 `at` 之后的根，
 *    σ 窗口里的日收盘全是已冻结的历史 ⇒ 刷了也是白刷。
 * ⚠️ OTC 由各调用点自己在 `!otc` 分支里过滤（私下一口价不落公开盘口 —— 既有先例）。
 * @param {number} give **回吐比例**（2026-10-02）：开仓 / 加仓传 1（满额），**平仓 / 强平 /
 *   部分强平传 `SHOCK.closeGive`** —— 往返不再等量抵消，台阶永久留下 65%（见 `god.js`）。
 * @param {'margin'|'fut'} [kind] **这一笔的产品线**（§73.6）—— 决定这笔台阶的衰减形态
 *   （1x 实物 perm 高、回补慢；有杠杆盘回补快）。缺省按合约。
 * @param {boolean} [player] 是不是**玩家自己的成交**（缺省是）。只有玩家的成交才给「热度」加料
 *   （§73.5 的 k3 项）—— NPC 自己写的那些不该再喂热度，否则热度会自激。
 * @param {Array<{p:number,w:number,frac:number}>} [eaten] 本笔走簿**吃掉的墙**
 *   （`walkFillFor` 的产出，缺省 null）—— 传给 `absorbedImpact` 做**精确耦合**；NPC 路径
 *   不传 ⇒ `absorbOf` 走缺省，逐位等于改动前（市场物理零漂移）。
 */
function pushFlow(s, sym, dir, notional, give = 1, kind = 'fut', player = true, eaten = null) {
  /* 沙盒「冲击强度」（2026-10-05）：整笔位移乘一枚倍率 —— 默认 1 ⇒ **逐位等于改动前**。
     它同时作用于玩家成交与 NPC 强平（都走这里），所以是「这个市场有多容易被推动」的总闸。 */
  const v = sbOf(s).shock * dir * give * SHOCK.share * absorbedImpact(s, sym, dir, permImpactFor(s, sym, s.i, notional), eaten);
  /* ② **做市库存动态**（2026-10-03 拍板）：本笔相对**本小时基准深度**的占比越大 ⇒ 做市商吃下的
     库存越多 ⇒ 回补越急（`betaFast` 越快）。口径见 `god.INV`：
       `betaFast = 基准 × (1 + kInv × min(q, qCap))`，`q = 本笔名义 ÷ hourLiqRaw`
     ⇒ `q = 0`（小额单 / 深度取不到）时倍率恰为 1，逐位等于改动前；`q ≥ qCap` 时到上界 2×。
     分母用的就是**滑点 / 对抗性流动性那同一把尺子**（`hourLiqRaw`，折减前的基准深度）⇒ 不新开刻度。
     M4b：再叠一道 `gm`（市场规模）—— 市场放大 ⇒ 这笔单子相对做市的库存压力按比例缩小。
     `gm === 1` ⇒ 逐位不变。 */
  const raw = godScale(s, sym, hourLiqRaw(s, sym, s.i));
  const q = raw > 0 ? notional / raw : 0;
  const invMul = 1 + INV.kInv * Math.min(q, INV.qCap);
  /* ⚠️ 写完**不**调 `invalidateSigma()`（2026-10-08）：`addFlow` 恒 `at = s.i`，只影响它之后的
     根，而 σ 缓存窗口里的日收盘全部早于创建时刻 ⇒ 缓存永不因这一笔而过时（见 daySigmaCache
     的头注证明）。每次级联 ~4.5h 刷一次整缓存曾是跳时间卡死的大头（39 读 × 冷扫）。 */
  addFlow(s, sym, v, shockParamsOf(kind, invMul));
  /* ⚠️ P1-2（2026-10-04 审计）：`pv` 只记**当前币** `s.sym` 的玩家成交。
     病根：结算（`m.pv` 读进热度后清零）只在 `tickMarket(s, s.sym)` 里发生，而写入这里是
     任何 `pos.sym` —— 玩家在 ETH 界面时一条**非当前币**（BTC）的仓位被强平 / ADL
     （`pushFlow(pos.sym, …, player=true)`，见 `liquidateAll` / `adlPlayerReduce`）会往
     `mkt[BTC].pv` 里加一笔，而 BTC 没被 tick ⇒ 那笔 `pv` **永不结算**、一直挂着，
     直到某次切回 BTC 才被 tickMarket 读进热度 ⇒ 事隔几小时的一记**凭空热度尖峰**。
     `s.sym` 之外一律不记（`pv` 的口径就是「本小时**当前币**的玩家成交」）。 */
  if (player && notional > 0 && sym === s.sym) mktOf(s, sym).pv += notional;
}

/* ───────────────────── NPC 情绪 / 踩踏级联（§73.5 · 2026-10-02） ─────────────────────
   起因：`pushFlow` 原来的调用者只有玩家自己的仓 ⇒ 市场上物理上**不存在踩踏**。
   这一层给每个币补一组「NPC 净持仓 ＋ 情绪热度」：热度由**近 24h 的价格收益**与玩家自己的成交
   一起烧起来，反过来驱动 NPC 顺势建仓，跌破强平线时再触发踩踏级联（一条反向下台阶）。 */

/** 热度只读给 UI（缺格时返回中性 `HEAT.base` —— 与 `mktOf` 的初值一致）。
 *  ⚠️ 不导出（2026-10-04 审计 R6）：仅引擎内 `stepAdvPush` 用；UI 走 `fngOf`（见 render.js）。 */
const heatOf = (s, sym) => (s.mkt && s.mkt[sym] ? s.mkt[sym].heat : HEAT.base);

/* ── 恐惧贪婪指数（**显示轨** · 2026-10-04 用户拍板「显示轨解耦」）────────────────
   详见 `god.FNG` 的常量注释：`heat` 是逐小时的**玩法引擎**（记忆 ≈ 14h，注定几天内横跳），
   本条是**每日 1 次**的慢速**只读**读数 —— 两条轨互不影响，`heat` 一个字不改。
   ⚠️ 它是 `(sym, day)` 的纯函数（只吃行情 ＋ `liqOf`）；实盘轨另叠一层日频低通状态。 */

/** 五档（由低到高）—— 与 `god.FNG.bands` 的边界一一对应。 */
const FNG_BANDS = ['xfear', 'fear', 'mid', 'greed', 'xgreed'];

/** 档名 → 下标。**兼容旧三档存档**（`'panic'` / `'greedy'` 是 2026-10-04 改五档前写的），
 *  未知值一律当中性 —— 与 `mktOf` 补默认键同一条口径，**不升 `STATE_VERSION`**。 */
function fngBandIdx(band) {
  const i = FNG_BANDS.indexOf(band);
  if (i >= 0) return i;
  return band === 'panic' ? 0 : band === 'greedy' ? 4 : 2;
}

/** 迟滞分档：`prev` 上一档（五档名或旧三档名），`v` 是 0–100 的指数值。
 *  越界进档走边界本身、退回要跌破「边界 − exit」—— 一次跨多档也逐档判定。 */
function fngBandStep(prev, v) {
  const B = FNG.bands.b, EXIT = FNG.bands.exit;
  let i = fngBandIdx(prev);
  while (i < 4 && v >= B[i]) i++;
  while (i > 0 && v <= B[i - 1] - EXIT) i--;
  return FNG_BANDS[i];
}

/**
 * 某一天 `d` 的 F&G **原始读数**（0–100）—— 三个子因子等权，贪婪为正。
 * ⚠️ P1-7（2026-10-04 审计）：归一化用的 σ 一律走**原始行情版**（`rawDailySigma` /
 *    `rawDailySigmaFast`）。病根：分子 `priceAt` 读的是**原始行情**（`heatPriceAt` /
 *    `rawCloseAt`），分母原来却读 `dailySigma`（**含位移**）—— 位移把 σ 抬高，于是
 *    `z = 收益 ÷ σ` 被系统性压小，「玩家拉盘 ⇒ 贪婪读数不动」⇒ 显示轨与它读的行情不同源。
 *    两处都换成不含位移的 σ 后，整条 `fngRawWith` 只吃原始行情（与回顾轨完全一致）。
 * @param {(i:number)=>number} priceAt 价格读数（实盘走 `heatPriceAt`、回顾页走 `rawCloseAt`）
 * @param {number} d 天序号 —— 读的是**第 `d` 天的最后一根小时**（`d×24+23`，已收盘的那一天；
 *   调用方负责只传已走完的日子，见 `tickMarket` / `rvFngAt` 的去前视注）。
 */
function fngRawWith(priceAt, sym, d) {
  const H = HOURS_PER_DAY;
  const i1 = d * H + (H - 1);          // 这一天（已收盘）的最后一根小时
  /* ① 动量 25%：30 天收益的 z 分位（`σ_30日 × √30` 归一，夹 ±2σ 后折算到 ±1）。 */
  const sig = rawDailySigma(sym, i1);
  const p1 = priceAt(i1);
  const p0 = priceAt(i1 - FNG.window * H);
  const z = sig > 0 && p1 > 0 && p0 > 0 ? (p1 / p0 - 1) / (sig * Math.sqrt(FNG.window)) : 0;
  const mom = Math.max(-1, Math.min(1, z / 2));
  /* ② 波动率 25%：`σ_短 ÷ σ_30日` 的**偏离**，越高越恐惧 ⇒ 取负（与 `HEAT.kVol` 同一支口径）。 */
  const sigFast = rawDailySigmaFast(sym, i1);
  const dev = sig > 0 && sigFast > 0 ? Math.max(-1, Math.min(1, sigFast / sig - 1)) : 0;
  const vol = -dev;
  /* ③ 成交量 25%：当日额 vs 近 30 日均额（`liqOf` 就是全市场**日成交额**锚），
        再乘**趋势方向** —— 放量上涨 ⇒ 贪婪，放量下跌 ⇒ 恐惧。
        ⚠️ 方向取**30 天收益的符号**（与 ① 同一个 `p0`），**不是当日涨跌**（2026-10-04 实测定标）：
        用当日符号时 `dir` 每天翻一次，成交量项变成 ±33 分的日频噪声 ⇒
        指数在 25 / 75 之间反复横穿（实测「极端对翻」8.8 次/年，真实指数只有 0.58 次/年）。
        改成趋势符号后「放量」只在趋势内确认方向，噪声源消失。 */
  const today = liqOf(sym, d);
  let sum = 0, n = 0;
  for (let k = d - FNG.voluWindow; k < d; k++) {
    const q = liqOf(sym, k);
    if (q > 0) { sum += q; n++; }
  }
  const avg = n > 0 ? sum / n : 0;
  const dir = p1 > 0 && p0 > 0 ? Math.sign(p1 - p0) : 0;
  const vr = today > 0 && avg > 0 ? Math.max(-1, Math.min(1, today / avg - 1)) : 0;
  const volu = dir * vr;
  const m = (mom + vol + volu) / 3;                    // 三因子等权（各已归一到 ±1）
  return Math.max(0, Math.min(100, FNG.center + FNG.sens * m));
}

/** 实盘轨（0–1 显示用；旧档缺格 ⇒ 中性 `0.5`，与 `heatOf` 同一约定）。 */
export const fngOf = (s, sym) => {
  const m = s.mkt && s.mkt[sym];
  return m && Number.isFinite(m.fng) ? m.fng / 100 : 0.5;
};

/** 实盘轨的**迟滞档**（五档：`'xfear' | 'fear' | 'mid' | 'greed' | 'xgreed'`）—— 供 UI 文字与着色。 */
export const fngBandOf = (s, sym) => (s.mkt && s.mkt[sym] && s.mkt[sym].fngBand) || 'mid';

/**
 * **回顾页**的恐惧贪婪读数 —— 与实盘同一套方程 ＋ 同一条日频低通，但只吃**原始历史行情**。
 * **纯函数纪律**：`(sym, i)` 的纯函数，游标只前进、回看查前缀数组（同 `reviewDrawdownOf`）。
 */
const rvFng = new Map();

function rvFngAt(sym, i) {
  const r = rangeOf(sym);
  if (!r || !isLoaded(sym) || i < r[0]) return null;
  const upto = Math.min(i, r[1] - 1);
  let c = rvFng.get(sym);
  if (!c || c.n !== r[1] - r[0]) {
    c = { a: dayIndexOf(r[0]), n: r[1] - r[0], d: dayIndexOf(r[0]) - 1, v: null, band: 'mid', arr: [], bands: [] };
    rvFng.set(sym, c);
  }
  const day = dayIndexOf(upto);
  /* ⚠️ P1-6b（2026-10-04 审计）：只结算**已收盘**的天 —— `fngRawWith(…, d)` 读的是第 `d` 天
     最后一根小时（`d×24+23`），若 `d` 是**进行中**的当天，那根还在未来 ⇒ 前视。
     判据：`upto` 恰在当天的最后一小时 ⇒ 当天算收盘（`settled = day`）；否则最后能结算的是
     `day − 1`。查表下标 `k = day − c.a` 不变 —— 当天未收盘时该下标落在 `arr` 之外，自然返回
     `null`（UI 按「今天还没有读数」处理），与低通/分档的既有口径不冲突。 */
  const settled = (upto % HOURS_PER_DAY) === HOURS_PER_DAY - 1 ? day : day - 1;
  while (c.d < settled) {
    c.d += 1;
    const raw = fngRawWith(j => rawCloseAt(sym, j), sym, c.d);
    c.v = c.v == null ? raw : c.v + FNG.alpha * (raw - c.v);
    c.band = fngBandStep(c.band, c.v);
    c.arr.push(c.v); c.bands.push(c.band);
  }
  const k = day - c.a;
  return k < 0 || k >= c.arr.length ? null : { v: c.arr[k], band: c.bands[k] };
}

export function reviewFngOf(sym, i) {
  const r = rvFngAt(sym, i);
  return r ? r.v / 100 : 0.5;
}

export function reviewFngBandOf(sym, i) {
  const r = rvFngAt(sym, i);
  return r ? r.band : 'mid';
}

/* ── 回顾页的**真实历史指标**（里程碑 B · 2026-10-04）─────────────────────────────
   背景：持仓量 / 多空比 / 资金费率的历史在 2018 年之前**根本拿不到**（数据源从那时才起），
   回顾页不能拿它们当「历史读数」。改展示三样**只吃原始行情**就能算出来的真东西：
   24h 年化波动率、距历史高 / 低回撤、24h 绝对美元成交额。
   三者都是 `(sym, i)` 的**纯函数**：不碰 `s`、不写存档、不判破产。 */

/**
 * 近 24h 小时收益的**年化滚动波动率**。
 *
 * 口径：用 `[i−24, i]` 共 25 个收盘算 24 个对数收益 `ln(c_k / c_{k−1})`，取**总体标准差**
 * （与 `sigmaOf` / `dailySigma` 同一估计量，不是样本标准差），再乘 `√(24×365)` 年化。
 * ⚠️ 读 `rawCloseAt`（**不含位移**）：回顾页画的就是原始行情，与 `reviewDrawdownOf` 同一条口径。
 * ⚠️ 窗口不满（上线头 24 小时）⇒ `NaN`，UI 层按 `--` 处理。
 */
export function reviewVolOf(sym, i) {
  const r = rangeOf(sym);
  if (!r || !isLoaded(sym) || i < r[0] + HOURS_PER_DAY || !hasCandle(sym, i)) return NaN;
  let n = 0, s = 0, s2 = 0;
  for (let k = i - HOURS_PER_DAY; k <= i; k++) {
    const c0 = rawCloseAt(sym, k - 1);
    const c1 = rawCloseAt(sym, k);
    if (!(c0 > 0) || !(c1 > 0)) continue;
    const x = Math.log(c1 / c0);
    n++; s += x; s2 += x * x;
  }
  if (n < 2) return NaN;
  const mean = s / n;
  return Math.sqrt(Math.max(0, s2 / n - mean * mean)) * Math.sqrt(24 * 365);
}

/**
 * **距历史高 / 低**的回撤（截至第 `i` 根）：`{ hi, lo }`
 *   `hi` = 现价 / 历史最高 − 1（≤ 0，从没跌过就是 0）；
 *   `lo` = 现价 / 历史最低 − 1（≥ 0，正好在最低点就是 0）。
 *   「历史最高 / 最低」取 `[r[0], i]` 区间内**原始** K 线的 `h` / `l` 极值。
 *
 * ⚠️ 与 `rvFng` 同一套游标缓存：**逐根累积**，游标只前进（回看历史直接查前缀数组）。
 *    `hi` / `lo` 是**前缀极值**（单调），故存成两条 `Float64Array` 而不是整段数组 ——
 *    回跳时按索引读到的仍是「那一刻为止」的极值。
 */
const rvDD = new Map();

export function reviewDrawdownOf(sym, i) {
  const r = rangeOf(sym);
  if (!r || !isLoaded(sym) || i < r[0]) return null;
  const upto = Math.min(i, r[1] - 1);
  const n = r[1] - r[0];
  let c = rvDD.get(sym);
  if (!c || c.n !== n) {
    c = { a: r[0], n, j: r[0] - 1, hi: new Float64Array(n), lo: new Float64Array(n) };
    rvDD.set(sym, c);
  }
  let mx = c.j >= r[0] ? c.hi[c.j - c.a] : -Infinity;
  let mn = c.j >= r[0] ? c.lo[c.j - c.a] : Infinity;
  for (let j = c.j + 1; j <= upto; j++) {
    const k = rawCandleAt(sym, j);
    if (k) {
      if (k.h > mx) mx = k.h;
      if (k.l < mn) mn = k.l;
    }
    c.hi[j - c.a] = mx;
    c.lo[j - c.a] = mn;
    c.j = j;
  }
  const close = rawCloseAt(sym, upto);
  const H = c.hi[upto - c.a], L = c.lo[upto - c.a];
  if (!(close > 0) || !(H > 0) || !(L > 0)) return null;
  return { hi: close / H - 1, lo: close / L - 1 };
}

/**
 * **近 24h 绝对美元成交额**（全市场口径）＝ 逐小时 `volumeAt × liqOf(当天)` 求和。
 *
 * 口径依据 `market.volumeAt` 的注释：小时成交量份额 `∈ [0,1]` ＝ 该小时占**当日**成交额的比重
 * ⇒ 本小时美元额 = 份额 × 当日流动性锚；跨日求和时**每一小时各取自己那天的锚**，不做近似。
 * ⚠️ `liqOf` 的锚本身就是**全市场**（CoinLore AVG.Volume × 刷量折扣），故这一格与 K 线一样
 *    代表「所有交易所合起来」的成交额，而不是单一所。
 * ⚠️ 取不到成交量（未上线 / 越界）⇒ 该小时跳过；24 小时全为 0 ⇒ `NaN`，UI 层按 `--` 处理。
 */
export function reviewVolUsdOf(sym, i) {
  const r = rangeOf(sym);
  if (!r || !isLoaded(sym) || !hasCandle(sym, i)) return NaN;
  let usd = 0;
  for (let k = i - HOURS_PER_DAY + 1; k <= i; k++) {
    if (!hasCandle(sym, k)) continue;
    const liq = liqOf(sym, dayIndexOf(k));
    if (!(liq > 0)) continue;
    usd += volumeAt(sym, k) * liq;
  }
  return usd > 0 ? usd : NaN;
}

/**
 * **非散户簿基础仓**（F2 · 2026-10-04）＝ `OI.bookTurn × 近 24h 美元成交额` —— 常年在线的
 * 做市 / 对冲 / 套利库存。**纯派生**（只读 `reviewVolUsdOf`），进 `openInterestOf`、
 * **不进**多空比、不参与级联。理由与标定见 `god.OI`。
 * @returns {number} 名义额（USD）；成交额取不到（未上线 / 越界）⇒ 0
 */
function baseBookOiOf(s, sym) {
  const v = reviewVolUsdOf(sym, s.i);
  /* M4b：市场规模过 `gm` —— 市场放大 ⇒ 常年在线的做市 / 对冲库存按同一倍数放大（OI 读数
     与「巨鲸页」口径才一致）。`gm === 1` ⇒ 逐位不变。 */
  return godScale(s, sym, Number.isFinite(v) && v > 0 ? OI.bookTurn * v : 0);
}

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * **已存在各币 `heat` 的算术均值**（排除 `sym` 自身）—— 新格子 `heat` 的起手值。
 * 没有任何已存在的币时退回 `HEAT.base`（⇒ 开局那唯一一个格子的口径逐位不变）。
 * @param {object} s 状态
 * @param {string} sym 即将建格的币（尚未在 `s.mkt` 里，排除是**防御性**的）
 * @returns {number} 0–1
 */
function meanHeatOf(s, sym) {
  let sum = 0, n = 0;
  for (const k in s.mkt) {
    if (k === sym) continue;
    const o = s.mkt[k];
    if (o && Number.isFinite(o.heat)) { sum += o.heat; n++; }
  }
  return n ? clamp01(sum / n) : HEAT.base;
}

/**
 * 某个币的 NPC 情绪 / 持仓格子（懒建）：
 *   `heat` ∈ [0,1]，0.5 中性；
 *   `npc`（**v28 · §4.2**）＝ **6 档杠杆阶梯** —— 每档 `{ long, longAvg, short, shortAvg,
 *         longStopped, shortStopped }`（净持仓**名义价值** USD ＋ 平均入场价 ＋ 止损已触发标志）。
 *         ⚠️ 档序与 `NPC.ladder` **逐位对应** —— `stampede` 按下标读 `lev`。
 *   `mm`（**缺口 6-A · 2026-10-03**）＝ **做市盘队列**（同形的一个格子，**不进阶梯**）——
 *         它的净持仓恒为趋势盘 6 档净持仓的 `−NPC.mm.absorb` 倍，杠杆单值 `NPC.mm.lev`。
 *         旧存档没有这个键 ⇒ `undefined`，调用侧一律用 `m.mm &&` 守卫（见 `npcNet` / `stampede`），
 *         首次 `tickMarket` 由 `mktOf` 补上 ⇒ **不必升 `STATE_VERSION`**。
 *   `npcDrift` 是散户净持仓造成的**有界价位偏移**台阶表 `{ at: [], v: [] }`（见 `god.npcDriftAt`）；
 *   `npcShock`（**v28**）是 NPC 级联**逐笔被动平仓**的冲击台阶表 `{ at: [], v: [] }` —— 独立的
 *         **有界瞬时**通道（`0.5^(e / NPC.shockHalf)` 指数衰减），**不写 `s.flow`**（见 `pushNpcShock`）；
 *   `npcFund`（**v30** · 缺口 3）是**对手方池**（USD）—— 玩家永续资金费的对手方账户（见 `settleFunding`）；
 *   `advPush`（**2026-10-03**）是**档 2 推价的缓动状态**（`ADV.pushHalf` 半衰期的一阶低通，见
 *         `stepAdvPush`）—— 旧存档没有这个键 ⇒ 读取侧一律用 `Number.isFinite` 守卫，为空即视作 0
 *         （等价于改动前的「瞬时推价」初值）⇒ **不必升 `STATE_VERSION`**；
 *   `pv` 是**玩家本小时**的成交名义（每根 K 线结算一次，见 `tickMarket`）。
 */
function mktOf(s, sym) {
  if (!s.mkt) s.mkt = {};
  return s.mkt[sym] || (s.mkt[sym] = {
    /* ⚠️ **新格子的热度不取中性 0.5，而取「已存在各币的情绪均值」**（2026-10-05 G2 自洽审计修）。
       病根：`crossHeat` 只能把偏差推给**已在 `s.mkt` 里**的币 —— 玩家「砸崩 BTC，再**第一次**
       切到 ETH」时 ETH 的格子还不存在，推不进去；等 `tickMarket('ETH')` 把它懒建出来，
       若按 `HEAT.base` 起手，则 ETH 恰好**什么都没发生** —— 正是 `crossHeat` 表头点名要避免的
       那种失真（现实的单一加密因子下，新币一上市就与大盘同呼吸）。
       修法：起手值 = 已有各币 `heat` 的算术均值（没有任何已有币时退回 `HEAT.base`，即开局 BTC 的
       口径逐位不变）。⚠️ **只在建格那一刻取一次**，之后仍由 `crossHeat` / 情绪更新正常演进。 */
    heat: meanHeatOf(s, sym),
    npc: NPC.ladder.map(() => ({
      long: 0, longAvg: 0, short: 0, shortAvg: 0,
      longStopped: false, shortStopped: false,      // 亏损侧止损带（`NPC.stopFrac`）
      longTp: false, shortTp: false,                // G1 · 盈利侧止盈带（`NPC.tpFrac`）
    })),
    mm: {
      long: 0, longAvg: 0, short: 0, shortAvg: 0,
      longStopped: false, shortStopped: false, longTp: false, shortTp: false,
    },
    npcDrift: null, npcShock: null, npcFund: 0, advPush: 0, pv: 0,
    /* 恐惧贪婪**显示轨**（2026-10-04）：旧档缺这三个键 ⇒ 由 `fngDay === null` 触发首次结算
       （首日直接吸附到原始读数），行为自洽 ⇒ **不升 `STATE_VERSION`**（同 `m.heat` 先例）。
       深跌护盘三层的新键（2026-10-08）：旧档缺键由 `??` / `>= 0` 防御读兜住（`dipPrev ?? 0`、
       `dipRes >= 0` 不成立 ⇒ 按满仓播种），同样**不升 `STATE_VERSION`**。 */
    fng: 50, fngDay: null, fngBand: 'mid',
    dipRes: null, dipPrev: 0, dipGone: false,     // 机构储备存量 / 上一根回撤 / 耗尽已报旗
  });
}

/** 六档**趋势盘**净持仓之和（`long − short`，名义 USD）—— 做市盘靶心的输入（见 `tickMarket` ③）。 */
function trendNet(m) {
  let net = 0;
  for (const g of m.npc) net += g.long - g.short;
  return net;
}

/**
 * **NPC 总**净持仓之和（趋势盘六档 ＋ 做市盘，`long − short`，名义 USD）—— `syncNpcDrift` 的口径。
 *
 * ⚠️ 缺口 6-A（2026-10-03）起这一条**必须含做市盘**：做市盘恒在趋势盘对面 ⇒ 它的 `−absorb` 正好把
 *    净敞口折成 `(1 − absorb)` 倍。旧存档没有 `m.mm` ⇒ 跳过（等价于改动前的行为，不炸）。
 */
function npcNet(m) {
  let net = trendNet(m);
  if (m.mm) net += m.mm.long - m.mm.short;
  return net;
}

/**
 * 某币**此刻的持仓量（OI）**（缺口 4 · 2026-10-02 用户拍板）—— `Σ(long + short)`。
 *
 * ⚠️ 口径：NPC 六档阶梯 ＋ 做市盘 ＋ **非散户簿基础仓**（F2 · 2026-10-04，见 `god.OI`）
 *    ＋ **玩家在该币的持仓名义**（`size × 现价`）＋ **对手方的镜像名义**（1:1 · 2026-10-03 拍板，见下）。
 *    这才是「市场上所有未平仓头寸」的现实定义 —— 只看 NPC 会漏掉自己那一份，
 *    而且玩家开一单把 OI 推高、读数却不动的观感很假。
 * ⚠️ **纯读**：不调 `mktOf`（那是懒初始化、只在写路径可达），缺失就只算 NPC 部分 ——
 *    `render` 每帧都会调它，绝不能顺手在 `s.mkt` 上建条目。
 * @returns {number} 名义额（USD），无数据时 0
 */
export function openInterestOf(s, sym) {
  const m = s.mkt && s.mkt[sym];
  let oi = 0;
  if (m && m.npc) for (const g of m.npc) oi += g.long + g.short;
  if (m && m.mm) oi += m.mm.long + m.mm.short;      // 缺口 6-A：做市盘也计入 OI
  oi += baseBookOiOf(s, sym);                       // F2（2026-10-04）：非散户簿基础仓（见 `god.OI`）
  /* 玩家 ＋ **其对手方**（1:1 配对 · 2026-10-03 拍板）：用户审计指出「玩家做空，那必然有人做多」——
     OI 的定义是「市场上所有未平仓头寸」，一张合约**两侧各算一次**。原来只加玩家这一侧（`pn`），
     巨鲸 $45B 的仓在读数上「没有对手方」；补上镜像的 `pn` 之后，巨鲸开一单 OI 涨两倍名义，
     与真实交易所（OI 随成交双向增长）一致。 */
  const pn = positionNotionalOf(s, sym);
  oi += pn + pn;
  return Number.isFinite(oi) && oi > 0 ? oi : 0;
}

/**
 * 某币**全市场多空比**（缺口 19 · 2026-10-02）—— 多头名义占比，区间 `0 ~ 1`。
 *
 * ⚠️ 口径 = **NPC 六档 ＋ 做市盘 ＋ 玩家该币名义**（**不含**对手方镜像）。它现在只剩**一个**用途：
 *    **资金费的拥挤度输入**（`settleFunding`）——「玩家自己的仓越大 ⇒ 对偏斜贡献越大 ⇒ 仓越大越贵」
 *    这条设计诉求（§73.6）要求玩家留在分母里。
 * ⚠️ **展示侧不再用它**（2026-10-03 拍板）：见 `retailLongShareOf`（散户子集口径）。
 * ⚠️ 两侧之和为 0（没有任何仓位）⇒ 返回 `null`，不是 0.5。
 * ⚠️ 纯读，同 `openInterestOf`（绝不调 `mktOf`）。
 * ⚠️ 不导出（2026-10-04 审计 R6）：仅 `fundingOf` / `settleFunding` 用。
 */
function longShareOf(s, sym) {
  const m = s.mkt && s.mkt[sym];
  let L = 0, S = 0;
  if (m && m.npc) for (const g of m.npc) { L += g.long; S += g.short; }
  if (m && m.mm) { L += m.mm.long; S += m.mm.short; }   // 缺口 6-A：做市盘两边同时在场 ⇒ 多空比更均衡
  const pos = s.positions[sym];
  const n = positionNotionalOf(s, sym);
  if (n > 0) { if (pos.side === 'long') L += n; else S += n; }
  const tot = L + S;
  return Number.isFinite(tot) && tot > 0 ? L / tot : null;
}

/**
 * **预测下一期资金费率 ＋ 距结算的小时数**（2026-10-03 · NEXT-STEPS §14.1 A3-d）—— 纯读，只给 UI。
 *
 * ⚠️ 结算落在 `s.i % FUNDING.hours === 0` 的那些整点（见 `advanceOneHour`）⇒ 剩余小时数
 *    `= FUNDING.hours − (s.i % FUNDING.hours)`（**刚结完那一刻是 8、不是 0**）。
 * ⚠️ 这是**按当前失衡外推**的估计值（与 Binance 界面那个「预计资金费率」同性质）：它每小时随
 *    `longShareOf` 变 ⇒ 结算那一刻的实收/实付可能与此不同。费率口径与 `settleFunding` **同源**
 *    （`fundingRateOf(premiumIndexOf(share))`），不另算一份。
 * @returns {{ rate:number, hours:number }|null} 两侧都没有仓位（分不出多空比）时 `null`
 */
export function fundingForecastOf(s, sym = s.sym) {
  const share = longShareOf(s, sym);
  if (share == null) return null;
  return {
    rate: fundingRateOf(premiumIndexOf(share)),
    hours: FUNDING.hours - (s.i % FUNDING.hours),
  };
}

/**
 * 某币**散户多空比**（2026-10-03 拍板 · 展示口径）—— 散户（NPC 趋势盘六档 ＋ 做市盘）的
 * 多头名义占比，区间 `0 ~ 1`。
 *
 * ⚠️ **为什么把玩家与对手方排除在外**（用户审计「多空数据是否正确」）：
 *    CoinGlass 的官方口径是 —— **全体**持仓的名义多空**恒为 1:1**（每一张多单都对应一张空单），
 *    拿全市场当分母，读数永远 50/50、零信息量；只有**子集**口径（如 Binance「大户持仓多空比」
 *    取前 20% 账户）才会偏离。本作同理：玩家 $45B 的巨鲸仓一旦计入，读数直接被顶成 **100/0**
 *    （实测 `longShare = 1.0000`）—— 那是「分母里只剩我自己」，不是市场信息。
 *    加上 1:1 对手方镜像后，全市场口径**必然**回到 50/50，更没有展示价值 ⇒ 展示改用散户子集。
 * ⚠️ 与 `openInterestOf` **口径不同**（那边含玩家与对手方，是「全市场未平仓名义」）：
 *    OI 是总量、多空比是散户子集 —— 两者本就该是两个数，不再共用分母。
 * ⚠️ 两侧之和为 0（散户还没建仓）⇒ 返回 `null`（展示 `--`）。纯读，不调 `mktOf`。
 */
export function retailLongShareOf(s, sym) {
  const m = s.mkt && s.mkt[sym];
  let L = 0, S = 0;
  if (m && m.npc) for (const g of m.npc) { L += g.long; S += g.short; }
  if (m && m.mm) { L += m.mm.long; S += m.mm.short; }
  const tot = L + S;
  return Number.isFinite(tot) && tot > 0 ? L / tot : null;
}

/** 玩家在某币的持仓名义（`size × 现价`）—— OI / 多空比共用的那一段，纯读。 */
function positionNotionalOf(s, sym) {
  const pos = s.positions && s.positions[sym];
  if (!pos || !(pos.size > 0)) return 0;
  const p = lastPrice(s, sym);
  return p > 0 ? pos.size * p : 0;
}

/** 把一个原始量按 `[lo, hi]` 线性归一化到 0–100、两端夹住（非有限值一律给中性 50）。 */
const cdriNorm = (x, lo, hi) => (Number.isFinite(x) ? Math.max(0, Math.min(100, (x - lo) / (hi - lo) * 100)) : 50);

/**
 * **隐藏基准：CDRI 衍生品风险读数**（2026-10-04）—— **纯读、不在任何 UI 出现、不参与任何玩法判定**。
 *
 * 目的（用户原话）：「先放入游戏内，但不加入游戏内显示，用于测试我们的游戏基准是否接近现实」。
 * 口径对齐 Coinglass 官方 CDRI（定义与来源见 `god.CDRI` 的表头注释）。**7 项输入 → 本作 5 项**：
 *
 *   | Coinglass 输入 | 本作取值 | 说明 |
 *   |---|---|---|
 *   | Total OI | `openInterestOf(s,sym) ÷ reviewVolUsdOf(sym,s.i)` | 用**换手倍数**替代「绝对量＋变化率」：本作 OI 在早期年代不可比 |
 *   | Funding Rate | `|fundingForecastOf(s,sym).rate| ÷ FR.max` | `rate` 可能为 `null` ⇒ 按中性 50 处理 |
 *   | Average Leverage | NPC 六档 ＋ 做市盘 ＋ 玩家，**名义加权平均** | `Σ名义 ÷ Σ(名义/杠杆)`；杠杆过 `npcLevOf` 年代封顶 |
 *   | Long/Short Imbalance | `|retailLongShareOf(s,sym) − 0.5| ÷ 0.5` | `null`（散户未建仓）⇒ 中性 50 |
 *   | Implied Volatility | **❌ 本作无期权 ⇒ 用已实现波动率代理**（`dailySigma` 年化 ×√365） | 拿不到 σ 再退 `reviewVolOf` 兜底 |
 *   | 24h Liquidation Volume | **❌ 不进复合读数**（引擎没有 24h 清算台账，加了要动存档）⇒ 由 `tools/bench-cdri.mjs` 独立测 |
 *   | Volume Heat Change | **✅ 已含在 oi 项**的成交额分母里 | 换手倍数本身就是「相对成交量」的热度 |
 *
 * 五项各自归一化到 0–100 后按 `CDRI.w` 加权；任一输入取不到时按**中性 50** 计入（不抽掉权重，
 * 免得「少一项 ⇒ 总分裂」；`parts` 里用 `ok:false` 标出来供校准脚本区分）。
 *
 * ⚠️ **纯读纪律**：只调既存的只读导出（`openInterestOf` / `fundingForecastOf` / `retailLongShareOf`
 *    / `dailySigma` / `reviewVolOf` / `reviewVolUsdOf` / `lastPrice` / `npcLevOf`），**绝不**调
 *    `mktOf`（那是懒初始化、只在写路径可达）⇒ 不会给 `s` / `s.mkt[sym]` 新增任何需持久化的字段
 *    （不升 `STATE_VERSION`）。
 *
 * @param {object} s 局状态
 * @param {string} [sym] 币种（缺省当前币）
 * @returns {{ v:number, band:'low'|'mid'|'high'|'extreme',
 *             parts:Record<'oi'|'fund'|'lev'|'ls'|'vol',{raw:number,score:number,ok:boolean}> }}
 */
export function cdriOf(s, sym = s.sym) {
  const t = timeOf(s);
  const parts = {};

  /* ① OI ÷ 24h 美元成交额（换手倍数）—— 成交额取不到（未上线 / 越界）⇒ 中性。 */
  {
    const oi = openInterestOf(s, sym);
    const vol24 = reviewVolUsdOf(sym, s.i);
    const raw = oi > 0 && vol24 > 0 ? oi / vol24 : NaN;
    parts.oi = { raw, score: cdriNorm(raw, CDRI.ref.oi.lo, CDRI.ref.oi.hi), ok: Number.isFinite(raw) };
  }

  /* ② |资金费率| ÷ 上限（0.75%/8h）—— `fundingForecastOf` 可能 null（分不出多空比）⇒ 中性。 */
  {
    const fc = fundingForecastOf(s, sym);
    const raw = fc ? Math.abs(fc.rate) / FR.max : NaN;
    parts.fund = { raw, score: cdriNorm(raw, CDRI.ref.fund.lo, CDRI.ref.fund.hi), ok: !!fc };
  }

  /* ③ 名义加权平均杠杆 = Σ名义 ÷ Σ(名义/杠杆)。四个来源的口径**必须**与写侧同源：
        · NPC 六档 —— 名义 `long+short`、杠杆过 `npcLevOf`（年代封顶，不直读 `.lev`）；
        · 做市盘 —— `NPC.mm.lev`（3x，不参与封顶）；
        · 玩家该币仓位 —— `pos.lev`（开仓时已由 `openCheck` 钳过，含 OTC 的 `OTC.levMax` 封顶）。
      ⚠️ 一律**不读** `s.lev`（那是「下次下单想用的杠杆」，与已持仓的杠杆可能不同）。
      ⚠️ **R3（2026-10-04 审计）**：这里原来**又**按「当前通道」把 `pos.lev` 钳一次 `OTC.levMax`
         —— 与注释「开仓已钳」重复，且**中途切通道会改写历史仓位的杠杆口径**（同一张仓在
         otc / book 两个通道下算出不同的 CDRI）。杠杆在**开仓那一刻锁定**（`openCheck` 已按当时
         通道钳好并存进 `pos.lev`）⇒ 这里**直接读 `pos.lev`**，不再重估。
      没有任何仓位（Σ名义 = 0）⇒ 中性 50。 */
  {
    let num = 0, den = 0;
    const m = s.mkt && s.mkt[sym];
    if (m && m.npc) for (let k = 0; k < m.npc.length; k++) {
      const g = m.npc[k];
      const n = g.long + g.short;
      const lv = NPC.ladder[k] ? npcLevOf(t, NPC.ladder[k].lev) : 1;
      if (n > 0 && lv > 0) { num += n; den += n / lv; }
    }
    if (m && m.mm) {
      const n = m.mm.long + m.mm.short;
      if (n > 0 && NPC.mm.lev > 0) { num += n; den += n / NPC.mm.lev; }
    }
    const pos = s.positions && s.positions[sym];
    if (pos && pos.size > 0 && pos.lev > 0) {
      const n = positionNotionalOf(s, sym);
      const lv = Math.max(1, pos.lev);      // 已持仓的杠杆按开仓时锁定的值读（R3），不按当通道重估
      if (n > 0) { num += n; den += n / lv; }
    }
    const raw = den > 0 ? num / den : NaN;
    parts.lev = { raw, score: cdriNorm(raw, CDRI.ref.lev.lo, CDRI.ref.lev.hi), ok: Number.isFinite(raw) };
  }

  /* ④ 散户多空偏离：`|share − 0.5| ÷ 0.5`，方向越拥挤越危险。`null`（散户未建仓）⇒ 中性。 */
  {
    const sh = retailLongShareOf(s, sym);
    const raw = sh == null ? NaN : Math.abs(sh - 0.5) / 0.5;
    parts.ls = { raw, score: cdriNorm(raw, CDRI.ref.ls.lo, CDRI.ref.ls.hi), ok: Number.isFinite(raw) };
  }

  /* ⑤ 已实现波动率（IV 代理）：`dailySigma` 是**日**σ ⇒ ×√365 年化。
        ⚠️ 本作**没有期权**，这是代理而非隐含波动率（见函数头）。`dailySigma` 拿不到
        （理论上不会 —— `sigmaOf` 有兜底）再用 `reviewVolOf`（已是年化）兜底。 */
  {
    const sig = dailySigma(sym, s.i);
    let ann = Number.isFinite(sig) && sig > 0 ? sig * Math.sqrt(365) : NaN;
    if (!Number.isFinite(ann)) { const rv = reviewVolOf(sym, s.i); if (Number.isFinite(rv)) ann = rv; }
    parts.vol = { raw: ann, score: cdriNorm(ann, CDRI.ref.vol.lo, CDRI.ref.vol.hi), ok: Number.isFinite(ann) };
  }

  /* 加权求和（权重再归一一次，防手改失配）＋ 四档。 */
  const w = CDRI.w;
  let acc = 0, wsum = 0;
  for (const k of ['oi', 'fund', 'lev', 'ls', 'vol']) { acc += w[k] * parts[k].score; wsum += w[k]; }
  const v = Math.max(0, Math.min(100, wsum > 0 ? acc / wsum : 0));
  const [b0, b1, b2] = CDRI.bands;
  const band = v < b0 ? 'low' : v < b1 ? 'mid' : v < b2 ? 'high' : 'extreme';
  return { v, band, parts };
}

/**
 * **玩家这一单给热度加料的倍率**（§73.6）—— 杠杆 1x（含 OTC 1x）是实物换手，没有杠杆盘、
 * 也就没有「散户追高被强平」那一环 ⇒ 倍率 0；合约 / 杠杆 > 1 按 `min(lev/5, 3)` 放大
 * （5x 起跳，15x 及更高级顶格 3 倍）。
 * ⚠️ 2026-10-07 起它**不再**门控 `stampede`（市场级联与玩家形态解耦，用户拍板，见那边头注）
 *    —— 只剩这一处逐笔用途：实物玩家的单不给级联热度加料。
 */
function cascadeMulOf(s) {
  const otc = chanOf(s) === 'otc';
  /* OTC 跟随模式但杠杆封顶（2026-10-03）：与 `openCheck` 同一口径。 */
  const lev = otc ? Math.max(1, Math.min(s.lev, OTC.levMax)) : Math.max(1, s.lev);
  return shockKindOf(marginOf(s, otc), lev) === 'coin' ? 0 : Math.min(lev / 5, 3);
}

/**
 * **NPC 减仓的已实现盈亏**（方案 A ② · 2026-10-05）—— 成本名义口径，**正 = 赚**。
 *
 * NPC 账本的 `long/short` 是**成本名义**（`均价 × 数量`，从不按价重估）⇒ 减 `mag` 那一刻：
 *   · 多头：`mag × (现价 / 均价 − 1)`；
 *   · 空头：`mag × (1 − 现价 / 均价)`。
 * 正 = NPC 赚（对手方池付出）、负 = NPC 亏（池收入）—— 与 `settlePool` **同一符号约定**。
 * （推导见 `adlProfitRate` 的成本名义一列，两者是同一口径的连续 / 离散版。）
 * @param {boolean} long 是否多头档
 * @param {number} mag 减仓的**正**名义额（不是增量 `delta`，`delta` 减仓时为负）
 * @param {number} avg 该侧均价
 * @param {number} price 现价
 */
function npcRealised(long, mag, avg, price) {
  if (!(mag > 0) || !(avg > 0) || !(price > 0)) return 0;
  return long ? mag * (price / avg - 1) : mag * (1 - price / avg);
}

/* ───────────────────────── 大单事件流（aggr 式日志 tab） ─────────────────────────
 * 2026-10-08 · 用户拍板⑤（对齐 aggr.trade 的 Trades + Liquidations 双流观感）：
 *   会话级 tape，只记**市场**的合约大单 —— NPC 六档建仓/减仓、护盘/巨鲸/ETF 买入、
 *   止损/止盈减仓、强平（含玩家自己被强平：现实里 forceOrder 是全市场可见的事实流）；
 *   玩家自己的主动开/平不进 tape（主日志已有，重复两遍只会吵）。
 * 六型：0 开多 ▲ / 1 开空 ▼ / 2 平多 △ / 3 平空 ▽ / 4 爆多 💥 / 5 爆空 💥（配色见 render.js）。
 * 分档按「当日流动性比例」五档（用户拍板；2026-10-09 补 1%）：0.1% / 0.5% / 1% / 2% / 5%
 * —— 跨年代自适应（2013 年的 $1m 与 2024 年的 $1m 不是一回事），低于 0.1% 不上日志；
 * 浮窗页 4 底部那排过滤档与 `FEED_STEPS` **一一对应**（选中第 i 档 ⇒ 只留 `t ≥ i` 的行）。
 * ⚠️ **不进存档**（save.js `EPHEMERAL`）、`rewindTo` 清空、**保留窗口 ＋ 总量硬顶**（见 `FEED_DAYS`
 *    与 `FEED_CAP`）—— tape 是「最近发生的事」，不是账本，不参与任何玩法判定。 */
export const FEED_CAP = 1200;
/**
 * tape 的**保留窗口**（2026-10-09 用户拍板「保留 3 日或更多日内的开平爆仓数据，超出显示数量
 * 则截断」）：按**游戏时龄**裁剪 —— `FEED_DAYS`（3 个游戏日 = 72h）内的开/平/爆仓都留，
 * 更老的截掉；显示层本来就有 maxRows 截断（装框恒定）。旧口径 `FEED_CAP = 240` 只按条数
 * 环形覆盖 —— NPC 大单风暴几小时就把玩家三天前的开/平记录冲掉，5% 深档常年空、列表看着
 * 在「跳动」。总量硬顶 1200 条（72h × 常态喂入量 ＋ 风暴余量）兜住内存；两条同时生效。
 */
export const FEED_DAYS = 3;
/** 分档阈值（名义 ÷ 当日流动性）—— 与浮窗日志页底部过滤档同序、同源（单一事实）。 */
export const FEED_STEPS = [0.001, 0.005, 0.01, 0.02, 0.05];
/** 名义额 ÷ 当日流动性 → 档位（0..4，从浅到深）；低于 0.1% ⇒ −1（不上日志）。 */
export function feedTier(notional, liqDay) {
  if (!(liqDay > 0) || !(notional > 0)) return -1;
  const r = notional / liqDay;
  for (let i = FEED_STEPS.length - 1; i >= 0; i--) if (r >= FEED_STEPS[i]) return i;
  return -1;
}
/**
 * **tape 大单事件流**（喂入口）：k = 六型（0 开多…5 爆空）、`minTier` 强制档位（玩家强平传 0）。
 * ⚠️ 导出给审计 9aq 直调（与 `exRevSweep` 同一先例）—— 保留窗口的行为断言需要喂任意时龄的条目。
 */
export function feedPush(s, sym, k, price, notional, minTier = -1) {
  if (!(price > 0) || !(notional > 0)) return;
  /* M4b：档位阈值同样过 `gm` —— 市场放大 ⇒ 同一笔名义的「分量」按比例缩水（与 `lobTick` 里
     那条取值同源）。`gm === 1` ⇒ 逐位不变。
     ⚠️ `minTier`（2026-10-09）：**玩家自己的强平**（k=4/5 传 0）无论名义多小都强制上 tape
        —— 它是「你的仓被市场看到」的那条事实流；低于 0.1% 日流动性的小仓在深市年代
        （2024 BTC ≈ $30M 阈值）永远够不着阈值 ⇒ 按旧口径玩家的爆仓在日志页根本不出现
        （用户拍板「日志（爆仓）应该显示玩家的仓位」）。其余调用缺省 −1 ⇒ 行为逐位不变。 */
  let tier = feedTier(notional, godScale(s, sym, liqOf(sym, dayIndexOf(s.i))));
  if (tier < minTier) tier = minTier;
  if (tier < 0) return;
  if (!s.feed) s.feed = [];                        // 旧档 / 回退后惰性补建（不升存档版）
  s.feed.push({ i: s.i, sym, k, p: price, n: notional, t: tier });
  /* 保留窗口 ＋ 总量硬顶（2026-10-09 用户拍板）：3 日（72h）内的开/平/爆都留，超龄截掉；
     极端风暴下再由 FEED_CAP 兜底。只在超限时才扫（常态零开销）。 */
  if (s.feed.length > FEED_CAP || s.feed[0].i < s.i - FEED_DAYS * 24) {
    const floor = s.i - FEED_DAYS * 24;
    if (s.feed[0].i < floor) s.feed = s.feed.filter(r => r.i >= floor);
    if (s.feed.length > FEED_CAP) s.feed.splice(0, s.feed.length - FEED_CAP);
  }
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
 * @param {object} slot 该档该币的格子（`{ long, longAvg, short, shortAvg, … }`，`§4.2` 的一档）
 * @param {number} price 这一刻的标记价（摊平均价用）
 * @param {number} floor 残尾归零阈值（名义额，调用侧给 `日流动性 × NPC.floor × 该档权重`）
 * @param {number} [speed] 每小时朝靶心靠的比例（缺省 `NPC.speed`；做市盘传 `NPC.mm.speed`）
 * @param {object} [fS] 大单事件流上下文（游戏状态）—— 传了才往 `s.feed` 发**开/平单**事件
 *   （趋势盘六档传，做市盘不传：做市是对手盘流动性、不是方向性合约单，上了 tape 只会是噪声）；
 * @param {string} [fSym] 事件流的币种（与 `fS` 成对）
 * @returns {number} 本次**减仓**（含残尾清零）的已实现盈亏（正 = NPC 赚）—— 供调用方入对手方池；
 *   没有减仓（纯加仓 / 无变化）时返回 0。方案 A ②：NPC 减仓也要结算，否则「无玩家时」池无收入流。
 */
function stepNpc(slot, side, target, price, floor, speed = NPC.speed, fS = null, fSym = '') {
  const long = side === 'long';
  const key = long ? 'long' : 'short';
  const avgKey = long ? 'longAvg' : 'shortAvg';
  const stopKey = long ? 'longStopped' : 'shortStopped';
  const tpKey = long ? 'longTp' : 'shortTp';
  const cur = slot[key];
  const next = cur + (Math.max(0, target) - cur) * speed;
  if (next < floor) {                                                                // 残尾 ⇒ 直接清零
    /* ⚠️ 连**止损 / 止盈标志**一起清（v28 / G1）：这一档该侧已经空了，下一轮建仓是**新的仓**，
       必须能重新触发止损 / 止盈 —— 否则「上一轮止过损 / 止过盈」会一直压着新仓不让它触发。 */
    if (cur !== 0) {
      /* 残尾清零同样是**减仓**（把 `cur` 平掉）⇒ 它的已实现盈亏也要入池（方案 A ②）——
         不结算就等于让一小笔钱消失。量级 < `floor`（本就微小），但口径要闭合。 */
      const realised = npcRealised(long, cur, slot[avgKey], price);
      slot[key] = 0; slot[avgKey] = 0; slot[stopKey] = false; slot[tpKey] = false;
      if (fS) feedPush(fS, fSym, long ? 2 : 3, price, cur);   // tape：残尾清零 = 平多/平空（档位阈值过滤小单）
      return realised;
    }
    return 0;
  }
  const delta = next - cur;
  if (!(Math.abs(delta) > 1e-9)) return 0;
  /* **减仓**（`delta < 0`）⇒ 已实现盈亏入池；**加仓**（`delta > 0`）只摊均价，不结算（方案 A ②）。 */
  const realised = delta < 0 ? npcRealised(long, -delta, slot[avgKey], price) : 0;
  if (fS) feedPush(fS, fSym, long ? (delta > 0 ? 0 : 2) : (delta > 0 ? 1 : 3), price, Math.abs(delta));
  slot[key] = next;
  if (delta > 0 && price > 0) slot[avgKey] = (slot[avgKey] * cur + price * delta) / next;   // 加仓 ⇒ 摊平均价
  return realised;
}

/** 沙盒「世界偏向」台阶的落级门槛（位移量）：0.05% —— 比显示精度还细，够挡浮点抖动。 */
const SB_BIAS_EPS = 0.0005;

/**
 * 把沙盒「世界偏向」（`mood × SB_MOOD_PUSH`，见 `god.SB_MOOD_PUSH`）落一级台阶。
 *
 * ⚠️ **只在写路径调用**（`tickMarket` 每小时一次）—— 与 `syncNpcDrift` 同一纪律：
 *    `at` 只许等于写入那一刻的 `s.i`，改预设**不回头重标定历史**。
 * ⚠️ 无 `s.god` / `mood = 0` ⇒ 恒等：不建表、不落级，`factorFor` 里那一项恒 0。
 * @returns {void}
 */
function syncSbBias(s) {
  if (!s.god) return;
  const v = sbBiasTargetOf(s);
  if (!Number.isFinite(v)) return;
  const tab = s.god.sbBias || (v === 0 ? null : (s.god.sbBias = { at: [], v: [] }));
  if (!tab) return;
  const n = tab.at.length;
  if (n && Math.abs(v - tab.v[n - 1]) < SB_BIAS_EPS) return;
  tab.at.push(s.i); tab.v.push(v);
}

/**
 * 把散户**净持仓**折算成一根**有界**的价位偏移台阶（`s.mkt[sym].npcDrift`）。
 *
 * 口径与玩家侧同一把尺子：`q = |净持仓| ÷ 日流动性`，偏移 = `±permImpactOf(q, σ)`。
 * 稳态下 `q ≤ NPC.mom/2 = 7.5%`（靶心封顶）⇒ 偏移 `≤ 0.548σ`：2024 年 σ≈3.5% ⇒ ±1.9%，
 * 2013 年 σ≈16% ⇒ ±9%。**不累积、清仓即归零**。
 *
 * ⚠️ **`σ` 一律是 `rawDailySigma`（2026-10-04 修 · 画门根因）**，不是 `dailySigma`：
 *    后者读 `closeAt`（含位移），而本函数的输出**又是**位移 ⇒ 拿它当 σ 就是自反馈环。
 *    实测（修前）：σ 被自己的位移从年化 0.51 顶到 4.50（×9）、`npcDrift` 到 **±30%**、
 *    显示价 **20.2%** 的时间钉死 +20% 夹子 —— 「画门」；改成原始行情 σ 后这条环路断开。
 *    ⇒ 上面那两行「σ≈3.5% / 16%」的估算**现在才真正成立**（修前那个 σ 是虚高的）。
 * ⚠️ `NPC.driftCap = 10%` 是**兜底**（历史极端 / 将来调参），正常年份碰不到。
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
  const net = npcNet(m);
  /* M4b：与 `npcBuild` 同一个 `gm` —— 分子（净持仓）已随市场放大，分母不同源就会把净持仓的
     价位偏移整体放大 `gm` 倍（手动档就不再是「纯缩放」）。`gm === 1` ⇒ 逐位不变。 */
  const liqDay = godScale(s, sym, liqOf(sym, dayIndexOf(i)));
  const q = liqDay > 0 ? Math.abs(net) / liqDay : 0;
  /* 缺口 6-B（2026-10-03）：同一张台阶表里再叠一层**档 2 有向推价**（玩家持仓逆向）——
     与 NPC 净持仓偏移**相加**后落一级，共用同一条「差 ≥ `NPC.driftEps` 才落级」的纪律。
     ⚠️ 推价走 `stepAdvPush`（**缓入缓出**，`ADV.pushHalf = 6h`）：平仓 / 退出档 2 时目标值归 0，
        但推价按半衰期**渐近释放**，不是「下一根瞬间弹回去」—— 那正是玩家实测的「画门」。
     ⚠️ `stepAdvPush` **改状态**，故本函数只能从每小时的写路径调用（`tickMarket` / `advTick`），
        不得挂到 `render` 每帧都碰的读路径上。 */
  /* ⚠️ 2026-10-04（F1）：净持仓这一层合成位移乘 `NPC.synthGive`（真实数据已含散户的价位影响
     ⇒ 不再重复叠加全额）。`stepAdvPush`（玩家驱动的对抗性推价）**不折** —— 见 `NPC.synthGive`。 */
  const raw = (net === 0 ? 0 : Math.sign(net) * NPC.synthGive * permImpactOf(q, sig)) + stepAdvPush(s, sym, i, sig);
  /* 硬上界（2026-10-04 · 「画门」根因修的第二道闸）：见 `god.NPC.driftCap`。
     第一道闸是本函数拿到的 `sig` 已改为 `rawDailySigma`（不含位移）；本夹只是兜底历史极端。 */
  const v = Math.max(-NPC.driftCap, Math.min(NPC.driftCap, raw));
  /* 非有限值守卫（2026-10-02 审计修 · 风险 R2）：NaN / Infinity 落进台阶表后，`JSON.stringify`
     写成 `null`、读回 `NaN`，整条价格曲线会跟着变 NaN。上游目前都被夹在有限区间，这里是兜底。 */
  if (!Number.isFinite(v)) return;
  const tab = m.npcDrift || (m.npcDrift = { at: [], v: [] });
  const n = tab.at.length;
  if (n && Math.abs(v - tab.v[n - 1]) < NPC.driftEps) return;   // 变得看不见：不落级、不动历史
  tab.at.push(i); tab.v.push(v);
}

/**
 * NPC 级联的一笔冲击 —— 写进 `s.mkt[sym].npcShock`（**不写 `s.flow`**，见 `god.NPC.shockHalf`）。
 *
 * 为什么必须另开一条通道（2026-10-02 审计修，用户拍板「独立有界瞬时通道」）：级联原来和玩家共用
 * `pushFlow` ⇒ 每一笔都留下 `SHOCK_MODE.fut.perm = 0.18` 的永久台阶，而 `decay` 的慢分量按
 * `t^−0.3` 衰减、**积分发散** ⇒ 12 年里级联 2000+ 次，位移单向累积把报价顶死在 `riseMax` 夹子上
 * （实测全程 **97.67%** 的时间顶夹；旧单档模型也有同源性 **+16.7%** 的系统偏置）。
 * 本通道按 `0.5^(e / NPC.shockHalf)` 指数衰减 ⇒ 残存值上界 = 每小时注入量 × `1/(1−2^−1/24)` ≈ ×34，
 * **天然有界**；级联在图上仍是「砸一波、再修复」，但不再累积。
 *
 * ⚠️ 与 `s.flow` 同一套**硬纪律**（见 `god.js` 头注）：`at` 只许等于写入那一刻的 `s.i`、只许追加。
 * ⚠️ **同一根小时内同向（乃至反向）的几笔直接相加** —— 它们共享同一个 `at` 与同一条衰减核，
 *    逐笔求和与合并求和**逐位等价**，省掉级联时（最多 12 笔/小时）的重复条目。
 * @param {number} notional 该笔被动平仓的名义额（USD）
 */
function pushNpcShock(s, sym, m, dir, notional) {
  /* ⚠️ 2026-10-04（F1）：位移量 ① 改走 `rawPermImpactFor`（原始 σ，**不含位移**）——断开
     「级联↑⇒σ↑⇒级联位移↑」的自反馈环；② 再乘 `NPC.synthGive` ——真实数据已含真实清算潮的
     价位影响，避免重复计算。级联的**频率/次数/方向**不变，只改每一步的**幅度**。
     理由见 `rawPermImpactFor` 与 `god.NPC.synthGive`。 */
  /* G4 · 方向不对称（2026-10-05）：聚合强平长期以多头为主（62–85%）、熊市羊群更强
     （Gemayel & Preda 2024）⇒ 向下的级联冲击 × `NPC.downAsym`（向上不变）。
     ⚠️ 只放大**级联这一条通道**的幅度，不动玩家侧的成交代价 / 位移（红线 A · 不双重计价）。 */
  const amp = dir < 0 ? NPC.downAsym : 1;
  /* 沙盒（2026-10-05）：级联这一条通道的幅度也吃 `冲击强度`（`sb.shock`）——
     ⚠️ 只乘**级联通道**，与 `pushFlow`（玩家侧）各乘各的，不双重计价（红线 A）。 */
  const v = sbOf(s).shock * dir * amp * SHOCK.share * NPC.synthGive * absorbedImpact(s, sym, dir, rawPermImpactFor(s, sym, s.i, notional));
  if (!Number.isFinite(v) || v === 0) return;
  const tab = m.npcShock || (m.npcShock = { at: [], v: [] });
  const n = tab.at.length;
  if (n && tab.at[n - 1] === s.i) tab.v[n - 1] += v;
  else { tab.at.push(s.i); tab.v.push(v); }
  shockAccForgetFile(tab);                          // 窗口和的惰性累加器已过时 ⇒ 下次读数冷启动重扫
  /* ⚠️ 不刷 σ 缓存（2026-10-08，见 `daySigmaCache` 头注）：级联台阶 `at = s.i` 只影响它之后的
     根，σ 窗口里的日收盘全是已冻结的历史 —— 以前每次级联刷一遍是跳时间卡死的大头。 */
}

/**
 * **保险基金的播种水位**（v30 · 第 6 批 · 缺口 5；2026-10-03 ADL 审计重标定）——
 * `当日流动性 × INSURE.seed`，只决定**播种那一刻**的起始水位。
 *
 * ⚠️ 用**当日流动性**而非绝对美元：一局的量级从 2013（数十万）跨到 2025（数十亿），
 *    写死绝对值会在某一端完全失真（同 `INSURE.seed` 的注释）。这里取的是**调用那一刻**
 *    的当日流动性 ⇒ 上帝模式跨年代回退（`rewindTo` 把 `s.fund` 清回 `null`）后重播，
 *    起始水位跟着回到那个年代的市场规模，不会把后期的量级带回早期。
 * ⚠️ **它不是每小时滚动的基准**，也不参与任何触发判定：自 2026-10-03 起它**只用于播种**
 *    （`seedFund`）—— ADL 的触发已改由级联烈度给（见 `stampede`），故本值不影响 ADL 频率。
 */
function fundBaseOf(s, sym) {
  /* M4b：基金水位与市场同源缩放（散户账面 PnL 已随市场放大 ⇒ 兜底水位也得跟着）。 */
  const liq = godScale(s, sym, liqOf(sym, dayIndexOf(s.i)));
  return liq > 0 ? liq * INSURE.seed : 0;
}

/**
 * **保险基金的惰性播种**（v30 · 第 6 批 · 缺口 5）—— 首次推进时把空池填到**当日基准**。
 *
 * ⚠️ 只在 `s.fund` **还不是有限数**时播种：`createState` 给的是 `null`，上帝模式的
 *    「跳日期」回退（`rewindTo`）也把它清回 `null` ⇒ 一局里至多重播一次，读路径不受影响。
 */
function seedFund(s, sym) {
  if (Number.isFinite(s.fund)) return;
  s.fund = fundBaseOf(s, sym);
}

/* ── 交易所收入的回流管道（2026-10-09 审计「资金回流」§二）─────────────────────
 * 单一出口原则：所有玩家侧费用先落 `s.exRev` 一本账（`exCharge`），每小时 sweep 一次
 * 分流（`exRevSweep`）—— a → 保险基金（入流封顶）、b → 护盘储备（capRes 封顶）、
 * 其余 = 运营利润不落账。守恒靠封顶，不靠记流水账。
 * ⚠️ 全部收入源都是玩家/上帝侧动作 ⇒ 无玩家模拟 `exRev` 恒 0 ⇒ sweep no-op ⇒ NPC 世界
 *    逐位不变（无玩家自洽由构造保证，见 `config.EXREV` 头注）。比例与排除项也在那里。 */

/** 一笔交易所收入落账（懒建：老存档无 `exRev` 键，与 `s.adv`/`s.intWin` 同一先例，不升存档版）。 */
function exCharge(s, amt) {
  if (!(amt > 0)) return;
  s.exRev = (Number.isFinite(s.exRev) ? s.exRev : 0) + amt;
}

/**
 * 保险基金的**软上限**—— Σ 各币「当日流动性 × INSURE.seed」（与 `fundBaseOf` 同一把尺子），
 * 随年代自动缩放（2013 与 2025 量级差三个数量级，写死绝对值必失真）。只统计已进过市场的币
 * （`s.mkt` 有格的）：没碰过的币连基准都还没意义。
 */
function fundSoftCapOf(s) {
  let cap = 0;
  for (const sym of Object.keys(s.mkt)) cap += fundBaseOf(s, sym);
  return cap;
}

/**
 * **每小时分流**（`advanceOneHour` 每根调一次，排在 NPC 刻度之前 ⇒ 本根护盘就能用到回补）：
 *   · `a = rev × EXREV.fundShare` → `s.fund`：**入流封顶**（`min(fund + a, max(fund, cap))`）——
 *     存量不动（强平盈余等既有入池路径不在此列），只拦「回流管道」这一路的无限累积；
 *   · `b = rev × EXREV.dipShare` → 护盘储备：按当日流动性比例摊到各币（`godScale` 同源，
 *     与 `npcBuild` 的 liqDay 同一把尺子）、`capRes = liqDay × instSeedOf(sym, t)` 封顶，
 *     **叠加**在 `instFlow` 涓流之上（`dipBuyOf` 是 9z 审计逐位锚定的纯函数，不动）；
 *     `dipRes` 未播种（null）的币跳过——留给 `dipBuyOf` 首次满仓播种，不改变播种语义；
 *   · 其余 `1 − a − b` = 运营利润，不落任何账（现实锚：交易所留存）。
 * 两处封顶溢出都**耗散**（审计 §二：守恒靠封顶，不靠记流水账）。
 * ⚠️ 导出给审计 9an 直调（与 `dipBuyOf` 同一先例）—— 差分测「每小时分流」的逐位口径，
 *    免得端到端测被护盘买压的市场反馈污染（回补会真的变成买盘）。 */
export function exRevSweep(s) {
  const rev = Number.isFinite(s.exRev) ? s.exRev : 0;
  s.exRev = 0;
  if (!(rev > 0)) return;
  if (Number.isFinite(s.fund)) {
    const a = rev * EXREV.fundShare;
    s.fund = Math.min(s.fund + a, Math.max(s.fund, fundSoftCapOf(s)));
  }
  const b = rev * EXREV.dipShare;
  const t = timeOf(s);
  let tot = 0;
  const days = {};
  for (const sym of Object.keys(s.mkt)) {
    const liq = godScale(s, sym, liqOf(sym, dayIndexOf(s.i)));
    if (liq > 0) { days[sym] = liq; tot += liq; }
  }
  if (tot > 0) {
    for (const sym of Object.keys(days)) {
      const m = s.mkt[sym];
      if (!m || !Number.isFinite(m.dipRes)) continue;
      const capRes = days[sym] * instSeedOf(sym, t);
      /* 与基金同一「存量不动」口径：只拦回补这一路，已有存量（若因改表高于 capRes）不在此缩——
         dipBuyOf 自己的 filled = min(capRes, …) 才是存量的收口（9z 逐位锚定，不动）。 */
      m.dipRes = Math.min(m.dipRes + b * days[sym] / tot, Math.max(m.dipRes, capRes));
    }
  }
}

/**
 * **对手方池的上限**（方案 A · 2026-10-05）—— 当日流动性 × `CPOOL.capFrac`。
 * 与 `fundBaseOf` 复用**同一把尺子**（`liqOf` + `CPOOL.capFrac`）：随年代自动缩放，
 * 2013 与 2025 同一条线。流动性取不到（0）⇒ 上限 0（池不吸收，全部溢出进基金）。
 */
function poolCapOf(s, sym) {
  /* M4b：对手方池的上限与市场同源缩放（NPC 的已实现盈亏已随市场放大 ⇒ 池容量也得跟着）。 */
  const liq = godScale(s, sym, liqOf(sym, dayIndexOf(s.i)));
  return liq > 0 ? liq * CPOOL.capFrac : 0;
}

/**
 * **对手方池结算**（方案 A · 2026-10-05）—— 把一笔**已实现盈亏**记进逐币对手方池 `m.npcFund`。
 *
 * 取代改动前「玩家平仓盈亏凭空造钱 / 销毁」的缺口（`closeTrade` 里只有 `credit` 没有配对扣款）。
 * 口径：
 *   `realized > 0`（被结算一方**赚**）⇒ 池付出 ⇒ `npcFund −= realized`；
 *   `realized < 0`（赚的负数，即**亏**）⇒ 池收入 ⇒ `npcFund −= realized`（增加）。
 *   ⇒ 玩家毛盈亏 `pnl` 与 NPC 减仓已实现盈亏**同一符号约定**，故共用本函数。
 *
 * 两条边界：
 *   · **池被抽干**（`npcFund < 0`）：
 *       - `backstop = true`（**玩家**）⇒ 缺口由保险基金 `s.fund` 补回 0 —— 现实里交易所
 *         永远足额结算**用户**盈亏，兜底是 SAFU 的责任；打折会与日志「盈利 $X」自相矛盾。
 *         `s.fund` 因此可为负 —— 语义 = 交易所层面的穿仓欠账（现有设计）。
 *       - `backstop = false`（**NPC**）⇒ **只在池子付得起的范围内兑付**（池恒 ≥ 0，不动基金）。
 *         为什么 NPC 不吃基金兜底：NPC 账本是**净持仓**，在长牛里常年净多 ⇒ 它的已实现盈利
 *         没有一个**真实对手方**（对手方在模型之外），若拿基金兜就是让基金成为无限对手方 ——
 *         实测 12 年把基金从 `+$3.9e7` 抽到 `−$9.2e9`（结构性失血，§7 红灯）。基金的职责是
 *         SAFU（保护**用户**），不负责给模拟的 NPC 内部盈亏兜底。
 *   · **池顶到上限** ⇒ 溢出转入保险基金，池不无限膨胀。
 *
 * ⚠️ **手续费与保证金退回都不进池**：只有**毛盈亏**参与 —— 费用归交易所、保证金是玩家自己的抵押品。
 * ⚠️ **强平盈亏不走这里**（仍走 `fundSettle` → `s.fund`），避免同一笔钱两边都记。
 * @param {number} realized 被结算一方的已实现盈亏（正 = 赚）
 * @param {boolean} [backstop] `true`（缺省）= 池抽干时由保险基金足额兜底（**玩家**）；
 *   `false` = 只在池余额内兑付（**NPC**，不碰基金）。
 */
function settlePool(s, sym, realized, backstop = true) {
  if (!Number.isFinite(realized) || realized === 0) return;
  const m = mktOf(s, sym);
  const before = Number.isFinite(m.npcFund) ? m.npcFund : 0;
  m.npcFund = before - realized;
  if (m.npcFund < 0) {
    if (backstop) { s.fund += m.npcFund; m.npcFund = 0; }   // 玩家：SAFU 足额兑付
    else m.npcFund = 0;                                     // NPC：池子付得起多少就付多少
  }
  const cap = poolCapOf(s, sym);
  if (m.npcFund > cap) { s.fund += m.npcFund - cap; m.npcFund = cap; }     // 顶到上限 ⇒ 溢出进基金
}

/** **玩家已实现盈亏入池**（方案 A ①）—— `settlePool` 的语义化入口，供 `closeTrade` 调用。 */
function settlePlayerPnl(s, sym, pnl) {
  settlePool(s, sym, pnl, true);   // 玩家：抽干时由保险基金足额兜底（SAFU）
}

/**
 * **强平盈余结算**（v30 · 第 6 批 · 缺口 5 ① ②）—— 某档 NPC 在 `price` 被强制平仓时，
 * 把「隐含保证金 − 实际亏损」记进保险基金 `s.fund`。
 *
 * 口径（＝现实「强平价 vs 破产价」的差额）：
 *   `loss    = notional × dir × (1 − price/avg)`   （dir = +1 多头 / −1 空头）
 *   `margin  = notional ÷ lev`                     （入场时交的保证金）
 *   `surplus = margin − loss`
 * 在**强平线**处 `price = avg×(1 − drop)`、`drop = 1/lev − maint` ⇒ 代入得
 * `surplus = notional × maint`（＝现实里强平盈余恰为维持保证金那一档）；
 * 价格**越过破产价**（`price < avg×(1 − 1/lev)` 的多头）时 `surplus < 0` ⇒ 穿仓，由池吸收（②）。
 *
 * ⚠️ **S4（2026-10-05）· 成交价夹到「破产价 ± `INSURE.gap`」**：`stampede` 传进来的是**本小时
 *    收盘价**，而价格常在一根小时内直接跳过破产价 ⇒ 那一段跳空被全额记成穿仓（100x 档破产价
 *    离强平线仅 0.5%，一根 −20% 阴线 = 19× 保证金的假穿仓）。真实强平在破产价附近成交，
 *    故这里把记账用的成交价收口到破产价再让 `gap` 的滑价（详见 `positions.INSURE`）。
 *    ⇒ 每一笔穿仓被限死在 `gap × 保证金`，基金不再结构性失血。
 *    ⚠️ 只改**记账价**：调用方的价格冲击（`pushNpcShock`）仍用真实市价，不受影响。
 * @param {number} dir +1 = 多头档、−1 = 空头档
 */
function fundSettle(s, notional, avg, lev, dir, price) {
  if (!(notional > 0) || !(avg > 0) || !(lev > 0)) return;
  /* S4：记账用的成交价夹到「破产价 ± `gap`」（`positions.bankruptcyFillPrice`）——
     多头不许记到它以下、空头不许记到它以上，于是穿仓被收口到 `gap × 保证金`，
     不再是无界的小时跳空。 */
  const loss = notional * dir * (1 - bankruptcyFillPrice(avg, lev, dir, price) / avg);
  s.fund += notional / lev - loss;                  // 正 = 盈余入池；负 = 穿仓掏池
}

/**
 * **ADL 收割的「浮盈率」** —— 一个仓位的未实现盈亏 ÷ **队列里记的那个名义基数**。
 *
 * ⚠️ ADL 队列里两种档位的名义基数**不是同一个东西**（2026-10-05 审计修 · 基数不配套）：
 *   - **NPC 档**（`g.long` / `g.short`）是**成本名义**（建仓时的 `均价 × 数量`，从不按价重估）
 *     ⇒ 浮盈 ＝ 成本名义 × `rate`；
 *   - **玩家档**（`ppos.size * price`）是**现价名义**（`数量 × 现价`）
 *     ⇒ 浮盈 ＝ 现价名义 × `rate`。
 * 两种基数下 `rate` 的表达式**互为倒数关系**，用同一个式子会有一半情形被低估 `ratio` 倍：
 *
 *   | 基数     | 多头        | 空头          |
 *   |----------|-------------|---------------|
 *   | 成本名义 | `ratio − 1` | `1 − 1/ratio` |
 *   | 现价名义 | `1 − 1/ratio` | `ratio − 1` |
 *
 * （`ratio` 的取法两侧一致：多头 `现价 ÷ 均价`、空头 `均价 ÷ 现价`，`ratio > 1` 即浮盈。）
 * @param {number} ratio 浮盈倍数（> 1 才有效，否则返回 0）
 * @param {boolean} long 是否多头
 * @param {boolean} costBasis true = 名义基数是**成本名义**（NPC 档）；false = **现价名义**（玩家档）
 * @returns {number} 浮盈率（≥ 0）
 */
export function adlProfitRate(ratio, long, costBasis) {
  if (!(ratio > 1)) return 0;
  if (costBasis) return long ? ratio - 1 : 1 - 1 / ratio;
  return long ? 1 - 1 / ratio : ratio - 1;
}

/**
 * **ADL 自动减仓**（v30 · 第 6 批 · 缺口 5 ③）—— 级联烈度达标（爆仓潮）时，按 ADL 队列
 * 强减**盈利的仓位**（**NPC 六档 ＋ 玩家自己**），直到补齐缺口。
 *
 * 队列口径（[Hypercall](https://docs.hypercall.xyz/docs/reference/auto-deleveraging/)）：
 * `ADL index = (mark ÷ entry) × (notional ÷ accountValue)`，其中 `accountValue ≈ margin = notional ÷ lev`
 * ⇒ `index = (mark ÷ entry) × lev`。**盈利越高、杠杆越高，越先被减**（其反直觉之处正是现实特征：
 * ADL 砍的是**赢家**，不是输家 —— 连 Hyperliquid 在 2025-10-10 都触发了两年来的首次 ADL）。
 *
 * ⚠️ **玩家自 2026-10-03 起也在队列里**（用户审计：「ADL 只该显示玩家自己的减仓」）——
 *    原来只遍历 `m.npc`，玩家**永不被 ADL**，那就等于给巨鲸开了一张免死金牌；
 *    而现实里按名义排序时，巨鲸恰恰排在最前面。
 * ⚠️ **只有玩家的那一笔播日志**：NPC 档的减仓静默（玩家看不到、也无法据此决策），
 *    但它的**价格冲击照常写**（`pushNpcShock`）—— 那才是玩家能感知到的部分。
 * ⚠️ NPC 被减的档写 `pushNpcShock`（平多 ⇒ 卖出 −1、平空 ⇒ 买回 +1），与「止损 / 强平」走同一条
 *    有界瞬时通道。**不给 `panicDrop`**：ADL 是被迫去杠杆，不是新的恐慌来源
 *    （与止损波同一先例，避免同一波下跌被计两次热度跳变）。
 * ⚠️ **收割的是「浮盈」而不是「名义」**（2026-10-03 ADL 审计 · R3）—— 现实 ADL 把赢家的仓位
 *    按**破产价**强平，「赢家拿不到从破产价到市价的那一段浮盈」，那一段被拿去填洞。
 *    本作落成一句可算的话：某仓浮盈率 `rate`（＝ `adlProfitRate(ratio, long, 基数)`，**按基数分两套**）、
 *    浮盈 `pnl = 名义 × rate`，本次从它身上收走 `take = min(pnl, 剩余缺口)`
 *    ⇒ 需平掉的名义 `cut = take ÷ rate`，平仓按**开仓价**结算（那一段浮盈归零）⇒ `s.fund += take`。
 *    于是「缺口补多少」＝「收走多少浮盈」，**基金一分不多、一分不少**。
 *    ⚠️ 2026-10-05 审计修：旧实现一律用 `rate = 1 − 1/ratio` —— 只对「玩家多头 / NPC 空头」正确，
 *       对「玩家空头 / NPC 多头」会把浮盈**低估 `ratio` 倍**（两档的基数一个是现价名义、一个是
 *       成本名义，表达式本该互为倒数）。现由 `adlProfitRate` 在入队时按基数算好存进 `it.rate`。
 * ⚠️ 旧实现把 `cut` 的名义额直接当缺口填（`s.fund` 根本不动，浮盈全额还给玩家）——
 *    基金永远填不满，只能靠 `s.fund = 0` 硬清零 ⇒ 一小时后必然再触发（间隔中位 1 小时）。
 *
 * ⚠️ **现实 ADL 触发率 <0.1% 的强平** —— 本作只在**级联烈度达标**（单小时强平额 ≥
 *    当日流动性 × `NPC.liqEventFrac`，即「爆仓潮」成立）时才走这里，十余年个位数次
 *    （2025-10-10 那场 $19B 崩盘是 Hyperliquid 两年多来的首次 ADL）。
 * @param {number} need 需要补回的缺口（USD）＝ **本小时级联造成的净穿仓额**（见 `stampede`）
 */
function adl(s, sym, m, price, need) {
  if (!(need > 0) || !(price > 0)) return;
  const q = [];
  for (let k = 0; k < m.npc.length; k++) {
    const g = m.npc[k];
    /* 缺口 17：ADL 排序用的杠杆也走年代封顶 —— 与 `stampede` 的强平线同源 */
    const lev = npcLevOf(timeOf(s), NPC.ladder[k].lev);
    if (g.long > 0 && g.longAvg > 0 && price > g.longAvg) {
      const ratio = price / g.longAvg;
      /* NPC 档的 `notional` 是**成本名义** ⇒ `rate` 走 costBasis = true（见 `adlProfitRate`） */
      q.push({ k, long: true, ratio, lev, notional: g.long, rate: adlProfitRate(ratio, true, true) });
    }
    if (g.short > 0 && g.shortAvg > 0 && price < g.shortAvg) {
      const ratio = g.shortAvg / price;
      q.push({ k, long: false, ratio, lev, notional: g.short, rate: adlProfitRate(ratio, false, true) });
    }
  }
  /* **玩家自己也在队列里**（2026-10-03 拍板）：ADL 砍的正是**赢家**，而按 `ratio × lev` 排序时
     「仓位大 ＋ 杠杆高 ＋ 浮盈多」天然排在队伍最前面 —— 巨鲸是第一个被减的，不是被豁免的
     （Hyperliquid 2025-10-10 的两年首次 ADL 就是这么发生的）。队列口径与 NPC 逐位相同。
     ⚠️ 只收**盈利中**的仓位（`ratio > 1`）：ADL 从不砍输家，输家那条路是强平。 */
  const ppos = s.positions[sym];
  if (ppos && ppos.size > 0 && ppos.entry > 0) {
    const lng = ppos.side === 'long';
    const ratio = lng ? price / ppos.entry : ppos.entry / price;
    if (ratio > 1) {
      /* 玩家档的 `notional` 是**现价名义**（`数量 × 现价`）⇒ `rate` 走 costBasis = false；
         ⚠️ 排序杠杆用**实际杠杆** `effLevOf`（滚仓减保证金后 `pos.lev` 已不是真实倍数），
         与 NPC 档「用年代封顶后的真实杠杆」同一纪律。 */
      q.push({
        player: true, long: lng, ratio, lev: effLevOf(ppos), notional: ppos.size * price,
        rate: adlProfitRate(ratio, lng, false),
      });
    }
  }
  q.sort((a, b) => (b.ratio * b.lev) - (a.ratio * a.lev));      // ADL index 降序
  let done = 0;
  for (const it of q) {
    if (done >= need) break;
    const rate = it.rate;                           // 入队时按基数算好（成本 / 现价两套，见 `adlProfitRate`）
    if (!(rate > 0)) continue;
    const pnl = it.notional * rate;                 // 该仓的全部浮盈
    const take = Math.min(pnl, need - done);        // 本次从它身上收走的浮盈（＝补上的缺口）
    /* `actual` = **实际**收走的浮盈。NPC 恒等于 `take`；玩家那一侧会因「残余闸」整条平掉
       （F2 · 2026-10-04）⇒ 实收可能大于 `take`（多收的是那条仓位剩余部分的浮盈）。
       两件事都必须用 `actual`，否则基金少进一笔、缺口也补不满。 */
    let actual = take;
    if (it.player) {
      /* 玩家的那一份走 `adlPlayerReduce`（**按比例退回保证金、浮盈被收走**）；`ppos` 是本函数
         开头取的那一份，队列里至多命中一次 ⇒ 不存在「对象已被换掉」的问题。 */
      actual = adlPlayerReduce(s, ppos, take, price);
    } else {
      const g = m.npc[it.k];
      const cut = take / rate;                      // 要让浮盈收走 `take`，需平掉的名义（≤ it.notional）
      pushNpcShock(s, sym, m, it.long ? -1 : 1, cut);
      if (it.long) {
        g.long -= cut;
        if (g.long <= 0) { g.long = 0; g.longAvg = 0; g.longStopped = false; g.longTp = false; }
      } else {
        g.short -= cut;
        if (g.short <= 0) { g.short = 0; g.shortAvg = 0; g.shortStopped = false; g.shortTp = false; }
      }
      /* ⚠️ **不再 `pushLog`**（2026-10-03 拍板）：NPC 档的减仓是市场内部对手盘的调整 ——
         玩家看不到、也无法据此做任何决策，播出来只会把日志刷满（用户：「ADL 不该显示别人的」）。
         价格冲击（`pushNpcShock`）照常保留：它才是玩家**能感知**到的那一部分。 */
    }
    s.fund += actual;                               // 收走的浮盈进池 ⇒ 基金一分不多、一分不少
    done += actual;
  }
}

/**
 * **玩家被 ADL 减仓**（2026-10-03 拍板 · 会计守恒重写）—— 从玩家的**盈利**仓位里收走
 * `take` 美元的浮盈，并按比例把那一块**保证金退回**当初开仓那家所。
 *
 * **口径（R3）**：平仓按**开仓价**结算 —— 被收走的那一块，玩家拿回自己的保证金，
 * 但**拿不到浮盈**（那正是 `take`，已由 `adl()` 记进保险基金）。现实中 ADL 把赢家
 * 按**对手方破产价**强平，「赢家拿不到破产价到市价的那一段」；本作用「按开仓价结算」
 * 作等价简化（`take` 就是这个差）。
 *
 * ⚠️ **与 `partialLiquidate` 的分工是镜像的**：那是**亏损**侧的强平（保证金留在仓位里当垫子、
 *    现金一分不动）；这是**盈利**侧的被动减仓 ⇒ 钱必须真的回到玩家账上，否则
 *    「被 ADL 砍了却看不到钱」。
 * ⚠️ **不再走 `reducePosition`**（旧实现的 bug）：那个函数把已平部分的盈亏**加进剩余保证金**
 *    （强平口径），而这里钱要退回现金 ⇒ 必须**按比例缩保证金**。旧实现两边都做
 *    （既 `credit(pos.margin × f + pnl)`、又让 `reducePosition` 把 `pnl` 留在仓位里）
 *    ⇒ 每笔 ADL 凭空多给玩家 `margin × f`（权益泄漏）。新写法：`margin × f` 退回现金、
 *    剩余 `margin × (1 − f)` 留在仓位，**权益变动恰为 −take**（浮盈被收走），逐分守恒。
 * ⚠️ **不收清算费**：ADL 既没有穿仓、也没有动用保险基金，只是一次强制撮合平仓；
 *    现实 ADL 同样只收普通手续费（本作手续费在开/平仓时已计，不在这里补刀）。
 * ⚠️ 价格冲击 / 量柱 / 抛压折价与其它三处平仓**同一套口径**（开仓 / 平仓 / 强平 / 部分强平）：
 *    ADL 是把仓位**砸到市场上**的卖出（或买回），不是账面冲销 —— 所以它写 `s.flow`；
 *    NPC 那一侧才走有界瞬时通道 `pushNpcShock`（它没有真实账户、不该留永久台阶）。
 *
 * ⚠️ **残余闸（F2 · 2026-10-04 用户拍板）**：若按 `take` 缩完之后剩下的那块**按现价的名义**
 *    不足「本所 × 本产品 × 年代」的最小名义（`closeCheck` 的 `f < 1` 闸用的同一条尺子），
 *    就**整条平掉**（`f = 1`）—— 交易所不会留一条连最小单都分批卖不出去的仓位。
 *    ⚠️ 整条平掉时**多收的那部分浮盈（`pnl × (1 − f)`）必须也进保险基金**：否则它既不在玩家账上、
 *       也不在基金里，凭空蒸发。办法是让本函数**返回实际收走的浮盈**，由 `adl()` 用它记账
 *       （`s.fund += actual` / `done += actual`）—— 这正是「基金一分不多、一分不少」这条纪律的延伸。
 *
 * ⚠️ **不写 `s.realized`（2026-10-04 审计再确认）**：ADL 按**开仓价**结算 ⇒ 玩家拿回自己的
 *    保证金（成本基础），被收走的那一块浮盈**本来就没「实现」过**（它只在 `unrealizedOf` 里）。
 *    所以 `realized` 变动恒为 0。若在这里写 `s.realized -= take`，会破坏 HUD 依赖的那条不变量
 *    `已实现 ＋ 未实现 ＝ 权益 − 开局本金`（代数已验证）；此处「什么都不写」才是对的。
 * @param {number} take 要从这笔仓位收走的浮盈（USD，> 0 且 ≤ 该仓全部浮盈）
 * @returns {number} **实际**收走的浮盈（未触发残余闸时 ＝ `take`；触发时 ＝ 该仓全部浮盈 `pnl`）
 */
function adlPlayerReduce(s, pos, take, price) {
  const mark = pos.size * price;
  const dir = pos.side === 'long' ? 1 : -1;
  const pnl = pos.size * (price - pos.entry) * dir;    // 该仓全部浮盈（调用侧保证 > 0）
  let f = pnl > 0 ? Math.max(0, Math.min(1, take / pnl)) : 1;
  /* 残余闸（F2）：剩下的那块按现价的名义不足最小名义 ⇒ 整条平掉，不留分批也卖不掉的尘埃仓。 */
  if (f < 1) {
    const minClose = Math.max(MIN_NOTIONAL, minNotionalAt(pos.ex, timeOf(s), isMargin(pos) ? 'margin' : 'fut', pos.sym));
    if (pos.size * (1 - f) * price < minClose) f = 1;
  }
  const closedSize = pos.size * f;
  const notional = closedSize * price;                 // 砸到市场上的那笔名义（真实成交口径）
  addPlayerVol(s, pos.sym, notional, pos.ex, isMargin(pos) ? 'margin' : 'fut');
  /* ⚠️ **ADL 不计入 `stat.liq` / `liqNotional`**（2026-10-07 用户拍板 · 回退 2026-10-06 的补计）。
     业界口径：ADL 与 liquidation 是**两套机制**，交易所把它们分成两种订单类型上报 ——
     Binance 用户数据流：`autoclose-` = 强平单、`adl_autoclose` = ADL 自动减仓单；
     且 ADL 触发的条件（保险基金撑不住）与「保证金不足」完全无关，减的还是**盈利**仓位。
     ⇒ 混进「强平」会让海报 / 档案的「强平 N 次」偏大，也让统计与 Coinglass 口径对不上。
     日志照旧打 `'liq'` 芯片（`LOG_TAGS.liq` = 「被强制平仓」，ADL 确实是被动强制的减仓）。 */
  {
    const d = pos.side === 'long' ? -1 : 1;
    pushFlow(s, pos.sym, d, notional, SHOCK.closeGive, shockKindOf(isMargin(pos), pos.lev));
    consumePool(s, pos.sym, notional);
  }
  credit(s, pos.ex, pos.margin * f, { usd: pos.mix.usd * f, usdt: pos.mix.usdt * f });
  if (f >= 1) delete s.positions[pos.sym];
  else {
    s.positions[pos.sym] = {
      ...pos,
      margin: pos.margin * (1 - f),
      size: pos.size - closedSize,
      notional: pos.notional * (1 - f),
    };
  }
  refreshOverhang(s, pos.sym, SHOCK.closeGive);
  pushLog(s, `ADL 自动平仓 ${pos.sym} ${lvTagOf(pos)}｜平仓 ${fmtMoneyShort(notional)} @ ${fmtLogPrice(price)}`, 'bad', 'liq');
  return pnl * f;                                      // 实际收走的浮盈（触发残余闸时 ＝ 全部浮盈）
}

/**
 * **踩踏级联**（§73.5 第 4 步 ＋ NEXT-STEPS §4.2/§4.3）：散户的**六档杠杆阶梯**各自按自己的
 * 强平线（距入场价 `1/lev − GAME.maintRate`）被击穿 ⇒ 该档被动卖出（一根阴线），并把热度再压一档。
 * 空头镜像（逼空）。改动前只有**一条** 8% 的线（`NPC.lev = 10` / `maint = 2%`）——要么不炸、
 * 要么一起炸；现在六条线（**32.8 / 19.5 / 9.5 / 4.5 / 1.5 / 0.5%**）逐级击穿，级联成为**台阶**。
 *
 * **止损带**（§4.3 · 2026-10-02 用户拍板）：每档在**强平线 × `NPC.stopFrac`（0.6）**处先走一波
 * **自愿止损** —— 平掉该档 50% 名义，剩余 50% 硬扛到强平线 ⇒ 六级台阶变 **12 级小台阶**
 * （现实里「一部分人止损、一部分人硬扛到爆」）。三条纪律：
 *   · **按档缩放**：3x 档的止损线 ≠ 20x 档的止损线，否则低杠杆档永远走不到自己的强平线；
 *   · **一次性**：触发后该档该侧落 `longStopped / shortStopped` 标志，不再反复减半
 *     （否则价格一直低于止损线时会逐小时再减半，把剩余 50% 提前磨光、「剩余扛到强平线」不成立）；
 *     价格**回升出带**或**残尾归零**时复位该标志（下一轮是新仓）。
 *   · **止损波只写 `npcShock`、不给 `HEAT.panicDrop`**（强平潮是被迫的恐慌、止损是自愿的 ⇒
 *     避免同一波下跌被计两次热度跳变）。
 *
 * ⚠️ **入口条件只有「价格真的穿过那条线」这一条**（2026-10-02 审计修，用户拍板）。原来还前置了
 *    `m.heat < HEAT.panic`，但那与 `target = mom × (heat − 0.5)` 直接矛盾：热度低于 0.25 时
 *    靶心已经为负 ⇒ 散户的**多仓早就被清成 0** ⇒ 多头分支**结构上永远不可达**，
 *    ROADMAP §73.10 那条「heat 高位时单笔砸 −3% → 触发级联」的验收根本跑不出来。
 *    现在只要价格真的跌穿，无论热度在哪一档，那一档的仓位都会被强平 —— 这才是「强平线」的意思。
 * ⚠️ **平仓冲击走独立有界通道 `npcShock`（`pushNpcShock`），不写 `s.flow`**（2026-10-02 审计修，
 *    用户拍板）：全额反向（`give = 1`）在一根内是一笔向下的位移、级联在图上「砸一波再修复」，
 *    但不再像写 `s.flow` 那样留下 40% 的永久台阶、无界累积（那会把报价顶死在 `riseMax`）。
 *    详见 `pushNpcShock` 与 `god.NPC.shockHalf`。
 * ⚠️ **按模式门控已拆除**（2026-10-07 用户拍板「不仅上帝模式，就算普通模式也需要能够让玩家
 *    查看爆仓潮」）：级联是 **NPC 杠杆盘自己的生态** —— 玩家当前停在实物 1x（`cascadeMulOf`
 *    为 0）也拦不住市场自己爆仓。原来 `cascadeMulOf(s) <= 0` 整条早退（2026-10-02 引入），
 *    后果是「没开过杠杆单的玩家永远看不到爆仓潮」—— 玩家的 UI 形态不该泄漏进市场物理。
 *    `cascadeMulOf` 只剩一处调用：玩家单的热度加料权重（`tickMarket`）；冲击形态由
 *    `shockKindOf`（`cascadeMulOf` 的内部实现，也被各 `pushFlow` 直接引用）独立承担。
 *
 * ⚠️ **v30（第 6 批）在两处强平分支上各挂了一笔账**（自愿止损波**不挂**，见下）：
 *    · **缺口 16**：`liqNotional`（只含强平）→ `s.stat.liqNotional`；达阈值播「爆仓潮」日志。
 *      ⚠️ §17.3（2026-10-04）：累计字段同时收纳**玩家自身强平**（`forceLiquidate` / `partialLiquidate`），
 *         但这里的「爆仓潮」阈值仍只用本小时的 **NPC 侧**名义。
 *    · **缺口 5 ①②**：`fundSettle` —— 强平盈余入保险基金 / 穿仓掏池。
 *    两处都**只挂在「跌破强平线」这一支**：自愿止损不是「爆仓」、也没有强平盈余可言。
 *
 * ⚠️ **缺口 6-A（2026-10-03）起做市盘也走同一条逐档逻辑**（`NPC.mm.lev` = 3x）——
 *    抽成 `flushSlot` 只为一处复用，**行为逐位不变**：杠杆由调用侧传入，不新开第二套公式。
 *    现实里做市商仓位低、回补快，只有极端行情（−32.8%）才被击穿，故它是罕见事件。
 */
function stampede(s, sym, m, price) {
  if (!(price > 0)) return;
  const fund0 = s.fund;                             // 本小时级联**之前**的基金（量出这次穿仓了多少）
  let liqNotional = 0;                              // 本小时被**强平**的名义（缺口 16 口径：不含止损波）
  /* ⚠️ 每档判定价**逐档重读** `lastPrice`（2026-10-08 · 无玩家自洽审计修）：
     循环内止损波 / 强平会 `pushNpcShock` 写出 `at = s.i` 的同根条目，`closeAt(s.i)` 当根即变
     （DECAY[0] = 1 全额计入）。旧实现全档共用调用点那一个 `price`：越靠后的档（100x → 做市，
     恰好最脆弱）看到的越是**没被踩踏过**的价格 —— 实测（2021-06 BTC）：50x 止损波同根砸
     −0.75%，显示收盘 37447 已穿 100x 强平线 37585，但 100x 按推前价 37728 判定存活、
     拖到下一根才清算 ⇒ 热力图出现「击穿一整根仍未清算」。逐档重读 ⇒ 每档按**自己被判定
     那一刻**的价格判定，级联在本根内向后真实传导（下跌 → 止损 → 砸盘 → 更高杠杆档强平）。
     ⚠️ **已知残差（有意保留）**：本档自己的止损波 / 强平推价发生在本档判定**之后**，
        可能把收盘推穿自己剩余半仓的线 —— 该半仓下一根清算（实测 48h 窗口 1/48 小时，
        因果叙事自洽：「止损波把价砸穿了我的强平线，下一根保证金电话到了」）。
        多趟扫描到不动点可完全闭合，但会把同根级联幅度放大约 2 倍 ⇒ 隐性重标定全部
        按单趟语义调校的数值（SHOCK.share / 爆仓潮频率 / ADL 锚点），故不采。
     `price` 参数退化为入口守卫（npcOtherTick / tickMarket 的调用点不用改）。 */
  for (let k = 0; k < m.npc.length; k++) {
    /* 缺口 17：强平线读**年代封顶后**的杠杆（2016-05-13 前全市场最高只有 3.33x） */
    liqNotional += flushSlot(s, sym, m, m.npc[k], npcLevOf(timeOf(s), NPC.ladder[k].lev), lastPrice(s, sym));
  }
  if (m.mm) liqNotional += flushSlot(s, sym, m, m.mm, NPC.mm.lev, lastPrice(s, sym), true);
  /* 缺口 16：把本小时被强平的名义记进统计；达到「当日流动性 × NPC.liqEventFrac」播一条事件日志。
     ⚠️ 只含**强平潮**，不含上面的自愿止损波 —— 对齐 Coinglass 的公告口径。 */
  if (liqNotional > 0) {
    s.stat.liqNotional += liqNotional;
    const liqDay = liqOf(sym, dayIndexOf(s.i));
    /* M4c：阈值随**市场规模**同源放大（`gm × sb.npc`）—— 旋钮把市场 / 散户盘调大多少倍，
       「爆仓潮」的门槛就抬多少倍 ⇒ 频率不随玩家的规模设置漂移。默认 ⇒ ×1 逐位不变。 */
    const thr = liqDay > 0 ? liqDay * NPC.liqEventFrac * liqEventScaleOf(s, sym) : 0;
    if (thr > 0 && liqNotional >= thr) {
      /* M4c · 日志冷却：同一币 `NPC.liqEventCd` 小时内只播一条。**只压日志**（`adl` 照旧），
         免得日志策略反过来改写「十余年 8 次」的 ADL 标定。旧档没有 `m.liqEventAt` ⇒ 视作
         「从没播过」（`-Infinity`），首条必出。 */
      const last = Number.isFinite(m.liqEventAt) ? m.liqEventAt : -Infinity;
      if (s.i - last >= NPC.liqEventCd) {
        m.liqEventAt = s.i;
        /* 补 `@ 价格`（2026-10-03 用户要求）：只报金额时玩家看不出这一波砸在什么价位上，
           也就无法把「爆仓潮」与 K 线上那根长阴对上号。
           ⚠️ 价格与下面的 ADL 都读**级联后的最终价**（2026-10-08）：逐档重读判定价后，
              本根内的止损波 / 强平已经把 `closeAt(s.i)` 推走了 —— 日志报的 `@ 价格` 要和
              K 线上那根长阴的收盘对得上，就得用推完之后的那一个。 */
        pushLog(s, `爆仓潮 ${sym} ｜ ${fmtMoneyShort(liqNotional)} @ ${fmtLogPrice(lastPrice(s, sym))}`, 'bad', 'mkt');
      }
      /* 缺口 5 ③（2026-10-03 ADL 审计重标定）—— **ADL 的触发就是「爆仓潮」成立的那一刻**，
         触发闸门与上面这条日志**共用同一个常数**（`NPC.liqEventFrac`，以及 M4c 加的市场放大项）。
         ⚠️ **为什么不用「基金水位」当触发**（旧实现，实测 5556 次）：基金在这套市场模型里
            **结构性失血** —— 12 年强平盈余 $165M vs 穿仓 $39.6B（1:240），基金自 2016 年起
            永久为负 ⇒「跌破触发线」要么退化成「永久处于线下 ⇒ 每根都触发」，要么
            「跨零后永不恢复 ⇒ 再触发不了」（实测只剩 2013/2016 共 4 次，2016 之后 8 年挂零）。
            改用**级联烈度**（本小时强平额 ÷ 当日流动性）后与基金水位解耦，实测 12 年 8 次，
            落在真实大崩盘日期上。
         ⚠️ **缺口按「本小时穿仓额」结算**（`need = 级联前的基金 − 级联后的基金`，只取正）
            —— 现实 ADL 补的正是**这一次**破产仓位填不上的那一块，不是「把整个基金补回水位」。
            若按「基准 − 基金」当缺口（旧实现），$39B 的长期欠账会让每一次 ADL 都收光全市场
            浮盈，属于把历史欠账算在单次崩盘头上。基金若本小时是**净盈余**则 `need ≤ 0`，
            `adl` 直接早退（该崩盘的穿仓已被盈余抵掉，无洞可补）。
         ⚠️ 浮盈**如实入池**（`adl` 内 `s.fund += take`）—— 不再有旧实现那句 `s.fund = 0`
            硬清零（它把缺口「抹掉」而不是「填上」，下一根必然再触发）。 */
      adl(s, sym, m, lastPrice(s, sym), Math.max(0, fund0 - s.fund));
    }
  }
}

/**
 * **一个持仓格子的逐档击穿**（趋势盘六档与做市盘**共用**这一条，缺口 6-A 抽出）——
 *   ① 多头：先自愿止损（平 50%、一次性），跌破强平线则全平并复位；空头镜像（逼空 ⇒ 热度上冲）。
 *      **G1（2026-10-05）**：盈利侧再加一条**止盈带**（`NPC.tpFrac`，比止损带更近）—— 处置效应
 *      （Odean 1998：盈利单卖出率 ≈ 亏损单 1.5×）⇒ 涨势里散户「见好就收」，不再只加不减。
 *   ② 返回本格本小时被**强平**的名义额（不含自愿止损波）—— 缺口 16 的「爆仓潮」只认这一笔。
 *
 * ⚠️ 杠杆由调用侧传入（趋势盘 `NPC.ladder[k].lev`、做市盘 `NPC.mm.lev`）⇒ 强平线 / 止损带
 *    仍是「`1/lev − 维持保证金率` 与本值 × `NPC.stopFrac`」这**一套**公式，没有第二条。
 * ⚠️ `quiet`（2026-10-08 tape）：做市盘传 `true` —— 做市是对手盘流动性、不是方向性合约单，
 *    它的止损/止盈/强平不上「大单日志」（趋势盘六档照发：爆多/爆空/平多/平空都是市场事实）。
 */
function flushSlot(s, sym, m, g, lev, price, quiet = false) {
  const maint = GAME.maintRate;                     // 0.5% 基准档（与玩家侧 `GAME.maintRate` 同源）
  const drop = 1 / lev - maint;                     // 该档距入场价多远爆
  const stop = drop * NPC.stopFrac;                 // 止损带：强平线 × 0.6
  const take = drop * NPC.tpFrac;                   // G1 · 止盈带（0.4 < 0.6 ⇒ 盈利侧比亏损侧更急）
  let liqNotional = 0;
  /* 方案 A ②：自愿**止损 / 止盈**的已实现盈亏累加，函数末尾一次性入池。
     ⚠️ 两个**强平**分支不在此列 —— 它们仍走 `fundSettle` → `s.fund`（避免同一笔钱两边都记）。 */
  let realised = 0;
  /* 多头：先自愿止损（平 50%、一次性），跌破强平线则全平并复位。 */
  if (g.long > 0 && g.longAvg > 0) {
    if (price < g.longAvg * (1 - drop)) {
      pushNpcShock(s, sym, m, -1, g.long);
      m.heat = clamp01(m.heat - HEAT.panicDrop);
      liqNotional += g.long;                        // 缺口 16：只认这一笔（强平潮）
      if (!quiet) feedPush(s, sym, 4, price, g.long);   // tape：爆多 💥（粉色，render.js 配色）
      fundSettle(s, g.long, g.longAvg, lev, 1, price);   // 缺口 5 ①②：盈余入池 / 穿仓掏池
      g.long = 0; g.longAvg = 0; g.longStopped = false; g.longTp = false;
    } else {
      /* 亏损侧止损带（平 50%、一次性）。 */
      if (!g.longStopped && price < g.longAvg * (1 - stop)) {
        const cut = g.long * 0.5;
        pushNpcShock(s, sym, m, -1, cut);
        g.long -= cut;
        g.longStopped = true;
        if (!quiet) feedPush(s, sym, 2, price, cut);   // tape：止损减仓 = 平多 △
        realised += npcRealised(true, cut, g.longAvg, price);   // 方案 A ②：止损已实现盈亏入池
      } else if (g.longStopped && price >= g.longAvg * (1 - stop)) {
        g.longStopped = false;                      // 回升出带 ⇒ 下一轮可再触发
      }
      /* G1 · 盈利侧止盈带（平 50%、一次性）—— 处置效应：见 `NPC.tpFrac`。 */
      if (!g.longTp && price > g.longAvg * (1 + take)) {
        const cut = g.long * 0.5;
        pushNpcShock(s, sym, m, -1, cut);           // 卖出兑现 ⇒ 向下
        g.long -= cut;
        g.longTp = true;
        if (!quiet) feedPush(s, sym, 2, price, cut);   // tape：止盈减仓 = 平多 △
        realised += npcRealised(true, cut, g.longAvg, price);   // 方案 A ②：止盈已实现盈亏入池
      } else if (g.longTp && price <= g.longAvg * (1 + take)) {
        g.longTp = false;                           // 回落出带 ⇒ 下一轮可再触发
      }
    }
  }
  /* 空头镜像：逼空 ⇒ 热度反而上冲。 */
  if (g.short > 0 && g.shortAvg > 0) {
    if (price > g.shortAvg * (1 + drop)) {
      pushNpcShock(s, sym, m, 1, g.short);
      m.heat = clamp01(m.heat + HEAT.panicDrop);
      liqNotional += g.short;
      if (!quiet) feedPush(s, sym, 5, price, g.short);   // tape：爆空 💥（橙色，render.js 配色）
      fundSettle(s, g.short, g.shortAvg, lev, -1, price);
      g.short = 0; g.shortAvg = 0; g.shortStopped = false; g.shortTp = false;
    } else {
      /* 亏损侧止损带（平 50%、一次性）。 */
      if (!g.shortStopped && price > g.shortAvg * (1 + stop)) {
        const cut = g.short * 0.5;
        pushNpcShock(s, sym, m, 1, cut);
        g.short -= cut;
        g.shortStopped = true;
        if (!quiet) feedPush(s, sym, 3, price, cut);   // tape：止损减仓 = 平空 ▽
        realised += npcRealised(false, cut, g.shortAvg, price);   // 方案 A ②：止损已实现盈亏入池
      } else if (g.shortStopped && price <= g.shortAvg * (1 + stop)) {
        g.shortStopped = false;                     // 回落出带 ⇒ 下一轮可再触发
      }
      /* G1 · 盈利侧止盈带（平 50%、一次性）—— 处置效应：见 `NPC.tpFrac`。 */
      if (!g.shortTp && price < g.shortAvg * (1 - take)) {
        const cut = g.short * 0.5;
        pushNpcShock(s, sym, m, 1, cut);            // 买回平空兑现 ⇒ 向上
        g.short -= cut;
        g.shortTp = true;
        if (!quiet) feedPush(s, sym, 3, price, cut);   // tape：止盈减仓 = 平空 ▽
        realised += npcRealised(false, cut, g.shortAvg, price);   // 方案 A ②：止盈已实现盈亏入池
      } else if (g.shortTp && price >= g.shortAvg * (1 - take)) {
        g.shortTp = false;                          // 回升出带 ⇒ 下一轮可再触发
      }
    }
  }
  /* 方案 A ②：本档自愿止损 / 止盈的已实现盈亏一次性入池（强平那两支已在上面各走各的）。 */
  settlePool(s, sym, realised, false);   // NPC：只在池余额内兑付（不碰保险基金）
  return liqNotional;
}

/**
 * **G2 · 跨币危机共振**（2026-10-05）—— 把当前币的情绪偏差传导给邻币，并被邻币市场均值回拉。
 *
 * 为什么需要（见 `god.CONTAGION` 的设计依据）：`tickMarket` 每小时只跑当前币，其余币的
 * `m.heat` 默认**冻结**。若不显式传导，「砸崩 BTC 再切 ETH」会发现 ETH 什么都没发生 ——
 * 与现实里「单一加密因子解释 ~80% 方差、熊市相关性 > 0.9」完全相反。
 *
 * 口径（**只动合成的情绪层，不碰任何真实 OHLC**）：
 *   ① **外溢**：本币 `|heat − base| > stressRef` 时，按 `sev` 强度把 `(本币 heat − 邻币 heat)`
 *      的一部分推给每个邻币 ⇒ 崩盘数小时内邻币一起被拖出中性带；
 *   ② **回读**：本币再朝「邻币 heat 均值」的偏差回拉 `read` 比例 —— 邻币全中性时该项恒为 0
 *      （`Σ(heat − base) = 0`），不会凭空制造偏差，只让共振**双向收敛**。
 * ⚠️ 邻币 `heat` 变了 ⇒ 玩家切过去时 NPC 建仓靶心（`mom × (heat − base) × liqDay`）随之偏离
 *    ⇒「级联更容易触发」自然涌现，不需要单独改任何强平线公式。
 * @param {object} m 当前币的 mkt 格子（`heat` 已被本小时的情绪更新写定）
 */
function crossHeat(s, sym, m) {
  if (!s.mkt) return;
  /* 沙盒（2026-10-05）：跨币共振强度 `sb.res` 同时放大**外溢**与**回读**两个比例
     （语义是「邻币被拖着走多快」）—— 两个比例同乘一个倍率，不会制造出「只传染不收」的偏差。 */
  const sb = sbOf(s);
  const dev = m.heat - HEAT.base;
  const span = HEAT.base - CONTAGION.stressRef;
  const sev = span > 0 ? Math.min(1, Math.max(0, (Math.abs(dev) - CONTAGION.stressRef) / span)) : 0;
  if (sev > 0) {
    const push = CONTAGION.push * sev * sb.res;
    for (const k in s.mkt) {
      if (k === sym) continue;
      const o = s.mkt[k];
      if (!o || !Number.isFinite(o.heat)) continue;
      o.heat = clamp01(o.heat + push * (m.heat - o.heat));
    }
  }
  let sum = 0, cnt = 0;
  for (const k in s.mkt) {
    if (k === sym) continue;
    const o = s.mkt[k];
    if (o && Number.isFinite(o.heat)) { sum += o.heat - HEAT.base; cnt++; }
  }
  if (cnt) m.heat = clamp01(m.heat + CONTAGION.read * sb.res * (sum / cnt));
}

/**
 * **深跌护盘强度**（`NPC.dip` · 2026-10-07 用户拍板「特别低的价格肯定是有人护盘的」）：
 * 当前标记价（`lastPrice` —— 护盘读的是**盘面实际可见的价**，含位移层 ⇒ 玩家砸出来的跌幅
 * 真实触发护盘）相对近 24 根**已收盘** K 线高点（`candleAt` 含位移、不前视本根）的回撤深度
 * `dd` → 抄底盘强度 ∈ [0, `NPC.dip.cap`]，线性 ramp。
 * 高点 / 现价任一无效 ⇒ 0；`dd ≤ ref` ⇒ 0（浅跌与旧档**逐位同轨**）。
 * 自稳定性：护盘买盘推价回升 ⇒ 回撤收窄 ⇒ 护盘减弱 —— 负反馈，不自激发散。
 *
 * ⚠️ **滑窗缓存**（2026-10-08 · 上帝模式跳时间卡死修复）：旧版每小时×8 币×24 次 `candleAt`
 *    ≈192 次对象分配，全程 10 万+ 小时就是千万级 —— 跳时间肉眼可见地卡。改为每币缓存
 *    「近 24 根已收盘 K 线高点」的 `Float64Array(24)`：窗口只随 `s.i` 右移一根 ⇒ 热路径
 *    **一次** `candleAt` ＋ `copyWithin` 左移补尾；冷路径（新局 / 跨多根跳变 / 回退后）直扫
 *    24 根填窗，**逐位同旧版**。正确性根基与 σ 缓存同一条：位移四分量全是「逐根台阶表、
 *    `j ≥ at` 生效」⇒ **已收盘 K 线的高点不可变**，缓存值永不腐烂；`rewindTo` 里显式
 *    `resetDipCache()` 双保险（拨小 `s.i` 后连续性检查本就会冷启动）。
 */
let dipCache = null;               // { s, per: Map<sym, { i, buf: Float64Array(24) }> } —— buf[23] 最新
export function resetDipCache() { dipCache = null; }

export function dipOf(s, sym) {
  const cur = lastPrice(s, sym);
  if (!(cur > 0)) return 0;
  let e = dipCache && dipCache.s === s ? dipCache.per.get(sym) : undefined;
  if (!e || !(e.i === s.i || e.i === s.i - 1)) {
    /* 冷路径：直扫 24 根填窗（缺根补 0 —— 与旧版「无效 K 不参与 max」逐位同轨）。 */
    const buf = new Float64Array(24);
    for (let back = 1; back <= 24; back++) {
      const c = candleAt(sym, s.i - back);
      buf[24 - back] = c ? c.h : 0;
    }
    if (!dipCache || dipCache.s !== s) dipCache = { s, per: new Map() };
    dipCache.per.set(sym, e = { i: s.i, buf });
  } else if (e.i === s.i - 1) {
    /* 热路径：窗口整体右移一根 —— 丢最老、补最新，只需一次 `candleAt`。 */
    const c = candleAt(sym, s.i - 1);
    e.buf.copyWithin(0, 1);
    e.buf[23] = c ? c.h : 0;
    e.i = s.i;
  }
  let hi = 0;
  for (let k = 0; k < 24; k++) if (e.buf[k] > hi) hi = e.buf[k];
  if (!(hi > 0)) return 0;
  const dd = 1 - cur / hi;
  if (dd <= NPC.dip.ref) return 0;
  return Math.min(NPC.dip.cap, NPC.dip.cap * (dd - NPC.dip.ref) / (NPC.dip.full - NPC.dip.ref));
}

/**
 * 深跌护盘的**三层买盘合成**（纯函数 · 审计 9z 逐位锚定）—— `npcBuild` 每小时调一次，
 * 输入（日流动性 / 本根回撤 / 机构储备存量 / 恐惧贪婪读数）全由调用方给，这里零状态。
 *
 *   · **机构层**：先按 `instFlow` 涓流回补（封顶 `seed × liqDay`），再按需取用
 *     `min(储备, liqDay × dip × instRate)` —— 储备可耗尽（LFG 锚），耗尽后每小时只剩涓流盘；
 *   · **散户层**：`fng < retailFng`（极度恐惧区）才接盘，强度 = `retailCap × (1 − fng / retailFng)`
 *     —— 越恐越接，但上限小（实证散户深跌净卖出）；fng 缺失 / 中性 ⇒ 0；
 *   · `resAfter` 回写给调用方落账；`gone` = 储备本根见底（日志「机构护盘储备耗尽」的判据）。
 * @param {number} liqDay 日流动性（$）
 * @param {number} dip `dipOf` 的本根回撤强度 ∈ [0, cap]
 * @param {number|null} res 机构储备存量（旧档 / 新格子 ⇒ null，按满仓播种）
 * @param {number} fng 恐惧贪婪读数（0–100，`settleFng` 写入）
 * @param {number} [seed] 储备上限（× 日流动性）—— 由调用方给 `instSeedOf(sym, t)`（**按币 × 年代**）。
 *   缺省 `seedBase.BTC` 只作兜底（审计 / 直调），引擎侧**必须显式传**。
 * @param {number} [rate] 回撤期的取用系数（× `liqDay × dip`）。缺省 `NPC.dip.instRate`。
 * @returns {{ instBuy:number, retailBuy:number, dipBuy:number, resAfter:number, gone:boolean }}
 */
export function dipBuyOf(liqDay, dip, res, fng, seed = NPC.dip.seedBase.BTC, rate = NPC.dip.instRate) {
  const capRes = liqDay * seed;
  /* ⚠️ 播种判定必须用 `Number.isFinite`：`null >= 0` 在 JS 里是 **true**（null 关系比较转 0），
     裸写 `res >= 0` 会让新格子（null）永远播不上种、储备从 0 起步（9z 审计抓到的真 bug）。 */
  const filled = Math.min(capRes, (Number.isFinite(res) ? res : capRes) + liqDay * NPC.dip.instFlow);
  const instBuy = Math.min(filled, liqDay * dip * rate);
  const resAfter = filled - instBuy;
  const fv = Number.isFinite(fng) ? fng : 50;
  const retailBuy = fv < NPC.dip.retailFng
    ? liqDay * NPC.dip.retailCap * (1 - fv / NPC.dip.retailFng) : 0;
  return { instBuy, retailBuy, dipBuy: instBuy + retailBuy, resAfter, gone: resAfter <= 0 };
}

/**
 * NPC 仓位刻度（tickMarket ③ ＋ ③′ 的抽身）：顺势靶心 ＋ **双侧背景仓**（`NPC.base`）＋ 做市盘镜像。
 *
 * ⚠️ 双侧基底的构造（2026-10-07）：`long 靶心 = base×w×liqDay + max(0, t×w)`、
 *    `short 靶心 = base×w×liqDay + max(0, −t×w)` ⇒ **净敞口 = t×w 与无基底逐位相同**
 *    （两侧都是线性收敛、且基底 > 0 使 `max(0,·)` 永不夹到 0），变的只有总名义（OI 地板）。
 * ⚠️ 深跌护盘（`NPC.dip` · 2026-10-08 **三层**）：`dipBuy` **只加长侧**（方向性买盘，短侧不动）——
 *    净敞口恒等式对**基底**部分仍成立，护盘是有意的方向性偏移（不进恒等式）。
 *    只给生效杠杆 ≤ 10x 的档（与基底同一判据：50x/100x 止损带太窄，接刀会持续摩擦止损线）。
 *    三层合成走 `dipBuyOf`（纯函数，审计 9z 逐位锚定）：机构储备（可耗尽＋涓流回补）＋
 *    散户极恐接盘（`settleFng` 的 fng < 22 触发）。
 * ⚠️ 基底只给**生效杠杆 ≤ 10x** 的档（`npcLevOf` 年代封顶后的值）：50x/100x 的止损带太窄，
 *    常驻基底会在止损线上持续摩擦（见 `NPC.base` 注）。
 * ⚠️ 方案 A ②：减仓的已实现盈亏累加后一次性入池（`settlePool` 只在池余额内兑付）。
 */
function npcBuild(s, sym, m, i) {
  /* M4b（2026-10-08 拍板②）：散户盘的**规模**（靶心 / 基底 / 残尾阈值 / 护盘储备）与深度分母
     共用同一个 `gm` —— 市场整体放大时，散户的仓位簿 / 巨鲸页 / OI 读数必须一起放大，
     否则「市场 8 倍大，OI 却一动不动」。玩家自己的仓位**不过这道闸**（绝对值，见 `godScale`）。
     `gm === 1` ⇒ 逐位不变。 */
  const liqDay = godScale(s, sym, liqOf(sym, dayIndexOf(i)));
  if (!(liqDay > 0)) return;
  /* ⚠️ **不是**整本簿都严格 ×`gm`：`extFlow`（巨鲸 / ETF 的**真实美元额**）不过闸 —— 它是外部
     披露的历史事实，与「市场规模旋钮」无关（诚实读数：2020 年无 ETF / 巨鲸流 ⇒ 簿严格 ×8.00；
     2021 年有巨鲸流 ⇒ ×7.36）。这是**有意**的口径差，不是漏改。 */
  const target = sbOf(s).npc * NPC.mom * (m.heat - HEAT.base) * liqDay;
  const price = lastPrice(s, sym);
  const t = timeOf(s);                 // 机构护盘的年代系数要读它（`instSeedOf`）
  /* 深跌护盘三层（2026-10-08）：本根回撤 `dip` 与上一根 `dipPrev` 的差给**做市相位**——
     回撤加深 ⇒ 撤单（×mmCut，承接缩）、收窄 ⇒ 回补（×mmBoost）、平时 ×1 与旧档同轨。
     倍率按回撤深度线性插值（缺口 8）：`cutT` = 0（刚进跌区）→ 1（最深），最深那一根才取满
     `mmCut`（−97%）/ `mmBoost` —— 免得把 2025-10-10 的极端读数摊到每一根「回撤还在加深」的小时上。
     `dip === 0` 时复位 `dipGone`（episode 结束，下一轮深跌还能再报一次「储备耗尽」）。 */
  const dip = dipOf(s, sym);
  const dipPrev = m.dipPrev ?? 0;
  m.dipPrev = dip;
  if (dip === 0) m.dipGone = false;
  /* 储备上限按**币 × 年代**给（缺口 3）：`instSeedOf` 是 `timeOf(s)` 的纯函数 ⇒ 不升存档版。 */
  const d3 = dipBuyOf(liqDay, dip, m.dipRes, m.fng, instSeedOf(sym, t));
  m.dipRes = d3.resAfter;
  if (dip > 0 && d3.gone && !m.dipGone) {
    m.dipGone = true;
    pushLog(s, `机构护盘储备耗尽 ${sym} ｜ 护盘只剩涓流盘`, 'bad', 'mkt');
  }
  const dipBuy = d3.dipBuy;
  const cutT = dip / NPC.dip.cap;
  const mmMul = dip > 0 && dip >= dipPrev ? 1 + (NPC.dip.mmCut - 1) * cutT
    : (dipPrev > 0 && dip < dipPrev ? 1 + (NPC.dip.mmBoost - 1) * cutT : 1);
  /* 外部有向买盘（缺口 4 巨鲸/机构 ＋ 缺口 5 现货 ETF）—— 两者都是**公开披露的真实美元额**，
     摊到执行窗口/当月交易日 ⇒ 美元/天。与 `dipBuy` 同址注入靶心：**买加上长侧、卖加上短侧**
     （与护盘同一范式：方向性偏移，不进「净敞口 = t×w」那条恒等式）。
     ⚠️ 只给生效杠杆 ≤ 10x 的档（与基底/护盘同一判据：50x/100x 接单会持续摩擦止损线）。
     ⚠️ 位移仍走既有链路（`npcNet` → `syncNpcDrift` × `NPC.synthGive`）—— 真实行情已含涨幅，
        这一层只让「玩家此刻在跟谁对着干」在盘口可见，不写 `s.flow`、零新状态（不升存档版）。 */
  const dayIdx = dayIndexOf(i);
  /* ⚠️ 上帝模式「新闻源与事件」（2026-10-08 起，2026-10-09 扩容，`s.god.noRealNews` 默认 true）
     ⇒ `extFlow` 归零：巨鲸 / ETF 的**有向买盘**不再注入靶心，价格只随玩家操作走。
     普通局 / 挑战局无 `s.god` ⇒ 逐位不变。 */
  const extFlow = eventsOff(s) ? 0 : (whaleFlowAt(sym, dayIdx) + etfFlowAt(sym, dayIdx));
  let npcRealisedSum = 0;
  for (let k = 0; k < NPC.ladder.length; k++) {
    const w = NPC.ladder[k].w;
    const floor = liqDay * NPC.floor * w;
    const low = npcLevOf(t, NPC.ladder[k].lev) <= 10;
    const b = low ? liqDay * NPC.base * w : 0;
    /* 动量＋基底走**档位速度**（`sp`，2026-10-08 热力图改版 · 用户拍板 B）：高杠杆人群换手快
       ⇒ 均价贴现价，低杠杆慢 ⇒ 均价留在历史价位 —— 真实清算热力图「堆积带」的成因。 */
    npcRealisedSum += stepNpc(m.npc[k], 'long', b + Math.max(0, target * w), price, floor, NPC.ladder[k].sp, s, sym);
    npcRealisedSum += stepNpc(m.npc[k], 'short', b + Math.max(0, -target * w), price, floor, NPC.ladder[k].sp, s, sym);
    /* 护盘 / 外部买盘：**当根全量入仓**（不走趋近，2026-10-08 拆分时定的口径）——急购就是
       砸市价单（对照 2025-10-10 实测锚：深度真空 35 分钟恢复九成，分钟级），原「并入靶心
       按 speed 渐近」要 19h 才到位九成，反而失真；且拆两次趋近会引入 `0.15/sp` 的稳态
       放大（低档 ×3.75），破坏总敞口守恒。方向性偏移（买加长侧、卖加短侧，同缺口 4/5
       拍板），摊均价与 `stepNpc` 加仓分支**同一会计**；事件结束后由上面的趋近调用把
       靶心外的余量自然平掉（减仓 ⇒ 已实现盈亏照常入池）。 */
    if (low) {
      const buy = (dipBuy + Math.max(0, extFlow)) * w;
      const sell = Math.max(0, -extFlow) * w;
      if (buy > 0) {
        const c = m.npc[k].long || 0;
        m.npc[k].long = c + buy;
        m.npc[k].longAvg = ((m.npc[k].longAvg || 0) * c + price * buy) / (c + buy);
        feedPush(s, sym, 0, price, buy);            // tape：护盘/巨鲸/ETF 急购 = 开多（当根全量，往往是大单）
      }
      if (sell > 0) {
        const c = m.npc[k].short || 0;
        m.npc[k].short = c + sell;
        m.npc[k].shortAvg = ((m.npc[k].shortAvg || 0) * c + price * sell) / (c + sell);
        feedPush(s, sym, 1, price, sell);           // tape：巨鲸/ETF 抛售 = 开空
      }
    }
  }
  /* ③′ **做市盘**（缺口 6-A）：站到趋势盘**对面**；靶心取趋势盘六档的**实际净持仓**。
     ⚠️ 残尾阈值不乘权重（单个格子）；`speed` 用 `NPC.mm.speed`（更快）。
     ⚠️ 深跌相位乘子 `mmMul`（2026-10-08）：先撤单后回补 —— 靶心缩/放 ⇒ `stepNpc` 逐小时
        把镜像仓推离/推回，涌现出「深度真空 → V 型回补」的节奏，不加新状态。 */
  if (m.mm) {
    const targetMM = -NPC.mm.absorb * mmMul * trendNet(m);
    const floorMM = liqDay * NPC.floor;
    npcRealisedSum += stepNpc(m.mm, 'long', targetMM, price, floorMM, NPC.mm.speed);
    npcRealisedSum += stepNpc(m.mm, 'short', -targetMM, price, floorMM, NPC.mm.speed);
  }
  settlePool(s, sym, npcRealisedSum, false);
}

/**
 * **其余已加载币**的 NPC 刻度（2026-10-07 · 用户拍板「确认各币种数据自洽、一直有人在多空」）。
 *
 * 病根：`tickMarket` 只跑当前币 ⇒ 其余币的 NPC 六档**永远是空的** —— 切到 ETH 看「巨鲸」页
 * 只会得到「NPC 各档暂无持仓」，且「砸崩 BTC → 切 ETH」时 ETH 的散户盘毫无反应（G2 的
 * `crossHeat` 把邻币 heat 推过去了，却没有任何东西**读**它建仓）。
 *
 * ⚠️ 每小时对**所有已加载**（`market.isLoaded`）、非当前币的格子跑一遍 `npcBuild` ＋
 *    `syncNpcDrift` ＋ `stampede`（与 `tickMarket` ③→sync→④ 同序）—— 强平线有人站岗、
 *    级联在任何币上都可能发生，浮窗「巨鲸 / 热力」页在**每个币**上都是活数据。
 * ⚠️ `syncNpcDrift` **跳过持有 / 疤痕币**（`heldSyms` ∪ `s.adv`）—— 它们由 `advTick` 负责推价，
 *    这里再调一次就是一小时走两格（`stepAdvPush` 的缓动会被双步进，见 `advTick` 内注）。
 * ⚠️ `m.heat` 仍按 G2 口径冻结（只有 `crossHeat` 的外溢会动它）—— 靶心读冻结热度是**有意的**：
 *    背景人群不会因为玩家没盯着就消失。
 * ⚠️ 成本：每币 ≈ 7 格 × 2 侧的线性趋近 ＋ 一次级联扫描，纯算术（不走簿、不建单），
 *    8 币全程 < 1µs 量级 —— 50x 速度下每秒 50 次也无感。
 */
function npcOtherTick(s) {
  if (!s.mkt) s.mkt = {};
  const adv = s.adv || {};
  /* ⚠️ **跳过「此刻还没上线」的币**（2026-10-10 用户报「XRP 还没上线却出现 XRP 的新闻」）：
     `prefetchAllCoins` 会把 8 币全下下来 ⇒ `isLoaded` 恒真，旧写法会给未上市币也建格
     （`mktOf` 无 unlock 闸）⇒ `s.mkt` 在 2013 年就躺着 XRP/ETH/SOL 的格子，向下游
     （`autoNewsSym` 抽币、`crossHeat` 共振、`meanHeatOf` 起手值）泄漏「未来币」。
     闸门与 `rewindTo` / 下单路径同源（`timeOf(s) >= c.unlock`）。 */
  const t = timeOf(s);
  for (const c of COINS) {
    const sym = c.sym;
    if (sym === s.sym || !isLoaded(sym) || t < c.unlock) continue;
    const m = mktOf(s, sym);
    settleFng(s, sym, m, s.i);   // 散户接盘层读 fng ⇒ 其他币也要先日频结算（与 tickMarket 同相位）
    npcBuild(s, sym, m, s.i);
    if (!(heldSyms(s).includes(sym) || adv[sym])) syncNpcDrift(s, sym, s.i, rawDailySigma(sym, s.i));
    stampede(s, sym, m, lastPrice(s, sym));
    lobTick(s, sym);   // NPC 限价簿刻度（2026-10-08 三批⑦）—— 其余币也要有活盘口（无玩家自洽）
  }
}

/**
 * 每根小时 K 线跑一次的市场情绪刻度（§73.5）—— 在 `advanceOneHour` 里、基础行情算完之后调用。
 *
 * ① 读**近 `HEAT.window` 小时的价格收益**（按日 σ 标准化）② 更新热度（收益 **被成交量有向放大** − 均值回复）
 * ③ NPC 顺势建仓（正反馈）③′ **做市盘**建到趋势盘对面（缺口 6-A）④ 踩踏级联（仅杠杆模式）。
 * ⚠️ 只对**当前币**跑（`s.sym`）——但 2026-10-07 起「其余币冻结」只对**行情/K 线**成立：
 *    NPC 仓位（③/③′ 抽身为 `npcBuild`）由 `npcOtherTick` 对**所有已加载币**每小时刻度，
 *    强平线 / 级联在任何币上都是活数据（`advanceOneHour` 里紧跟本函数之后调用）。
 *    G2 例外：其余币的 `m.heat` 仍被 `crossHeat` 跨币耦合（外溢），不是完全冻结。
 */
export function tickMarket(s, sym) {
  const m = mktOf(s, sym);
  const i = s.i;
  /* 沙盒「世界偏向」台阶（2026-10-08 · 见 `god.SB_MOOD_PUSH`）：每小时把 `mood` 的目标位移落一级，
     供 `factorFor` 从本根起读取 —— 排在一切价格读数之前（本根 K 线就已含它）。 */
  syncSbBias(s);
  seedFund(s, sym);   // v30 · 缺口 5：保险基金**惰性播种**（开局日流动性 × INSURE.seed，只播一次）
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
  /* ①′ **波动率项**（缺口 18 · 2026-10-02 用户拍板 `kVol = 0.02`）—— F&G 的波动率子指标口径：
     「当前波动率 vs 近月基线」的**偏离**，`σ_短` 高 ⇒ **恐惧**（推向 0）⇒ 符号为**负**。
     ⚠️ 与上面那条价格项**不是同一个量**：价格项看的是「涨跌了多少」（带方向），本项看的是
        「最近有多颠」（不带方向、只推离中性）—— 一次横盘巨震会让本项压低热度、价格项却近乎 0。
     ⚠️ 夹到 `±1` 是防止「一周内 σ 翻十倍」这类极端比值把热度一杆子打到底；
        再乘 `kVol = 0.02`（与 `k1` 等权）⇒ 它单独最多贡献 ±0.02/小时，量级与价格项同档。 */
  const sigFast = dailySigmaFast(sym, i);
  const volDev = sig > 0 && sigFast > 0
    ? Math.max(-1, Math.min(1, sigFast / sig - 1)) : 0;
  /* ② 热度：收益（**被成交量有向放大**）− 波动率偏离 − 均值回复。⚠️ 这里的读全在 ③④ 写流之前。
     ⚠️ 成交量进的是**放大器**而不是加数（2026-10-02 审计修）：`pv` 是无符号的成交名义，
        写成加数时一笔巨额**卖单**会把热度往上顶 ⇒ 砸盘被读成极度贪婪、散户反手做多、位移反向
        （实测 15x 砸掉当日量 100% ⇒ 位移 +13.2%）。现在它只放大 `k1·x` 的**方向**：
        砸盘放大的是「变冷」、追高放大的是「变热」，量级再大也不翻转符号。
     ⚠️ `cascadeMulOf` 仍是模式权重：实物换手（杠杆 1x / 无杠杆盘）⇒ 0，玩家的量不给热度加料（§73.6）。 */
  const liq = hourLiqBase(s, sym, i);
  const pv = liq > 0 ? m.pv / liq : 0;
  /* 沙盒（2026-10-05）：`情绪强度 sb.heat` 放大**驱动项**（价格项 ＋ 波动率项），
     `情绪偏向 sb.mood` 平移**回复靶心**（中性 → 偏贪婪 / 偏恐惧）——
     火箭牛市 / 深度熊市预设的方向性正是靠 `mood` 给的（单靠倍率无法表达牛熊）。 */
  const sb = sbOf(s);
  const heatTgt = clamp01(HEAT.base + sb.mood);
  m.heat = clamp01(m.heat + sb.heat * (HEAT.k1 * x * (1 + HEAT.k3 * Math.min(pv, 1) * cascadeMulOf(s))
    - HEAT.kVol * volDev)
    - HEAT.k2 * (m.heat - heatTgt));
  m.pv = 0;
  /* ⚠️ P1-2（2026-10-04 审计）：**其余币的 `pv` 也要清**。
     病根：玩家在 BTC 砸了一笔后**切走**去 ETH，则下一小时只有 ETH 被 tick、BTC 的那笔 `pv`
     一直挂着；等几小时后切回 BTC 才被上面那行读进热度 ⇒ 一笔**迟到几小时的热度尖峰**。
     `pv` 的口径是「本小时」⇒ 跨过这一根就该归零（哪怕那一小时该加的料因切走而错过，
     也比在图上看不到的时段里攒一句「凭空情绪」干净）。 */
  for (const k in s.mkt) if (k !== sym && s.mkt[k] && s.mkt[k].pv) s.mkt[k].pv = 0;
  /* ②′ G2 · 跨币危机共振（2026-10-05）—— 一币情绪崩 ⇒ 邻币被拖着走（见 `crossHeat`）。 */
  crossHeat(s, sym, m);
  /* ③ NPC 顺势建仓：热度高于中性 ⇒ 净多头，低于中性 ⇒ 净空头。取不到深度就不建（不凭空造量）。
     ⚠️ 靶心与残尾阈值都用**日流动性**（与 `syncNpcDrift` 同一把尺子）：用逐小时深度时，
        冷门小时（占比 1/24）的靶心被压小、热门小时又被放大 ⇒ 散户仓位跟着小时形状剧烈抖动。
     ⚠️ **按档分配**（§4.2）：同一个靶心按 `NPC.ladder[k].w` 分给六档，`Σw = 1` ⇒
        六档名义之和 == 改动前的单值（**总敞口守恒**），只是摊到了六条不同的强平线上。
        残尾阈值同理按档缩放（`× w`）—— 否则低权重的 100x 尾巴会被同一个绝对阈值整条抹掉。 */
  /* ②″ 恐惧贪婪日频结算（2026-10-08 从原 ⑤ **前移**）：`npcBuild` 的散户接盘层要读 `m.fng`，
     放在 ③ 之前 ⇒ 当前币与其他币（`npcOtherTick` 同序）相位一致。 */
  settleFng(s, sym, m, i);
  npcBuild(s, sym, m, i);
  /* ⚠️ 2026-10-04：这里传的是**原始行情 σ**（`rawDailySigma`），不是上面那个给热度用的
     `sig`（`dailySigma`，含位移）。理由见 `rawDailySigma` 表头 —— 净持仓折价位、以及推价的
     距离参考，都必须用不含自身位移的 σ，否则「位移↑ ⇒ σ↑ ⇒ 位移↑」自激（画门根因）。 */
  syncNpcDrift(s, sym, i, rawDailySigma(sym, i));
  /* ④ 踩踏级联。 */
  stampede(s, sym, m, lastPrice(s, sym));
  /* ⑤ NPC 限价簿刻度（2026-10-08 三批⑦）：吃穿 / 撤单 / 生成 —— 每币每小时一次。
     ⚠️ 放在**最后**：本根的全部位移流都已写完，`candleAt` 的高低价才是终值。 */
  lobTick(s, sym);
}

/**
 * 恐惧贪婪**显示轨**的日频结算（2026-10-08 从 `tickMarket` ⑤ 抽身）：每个新的一天把当日
 * 原始读数经一阶低通写进 `m.fng`（0–100）。⚠️ 2026-10-08 起它**不再只是显示轨**：
 * `npcBuild` 的散户接盘层（`NPC.dip.retailFng`）读它触发 —— 与 `heat` 仍然解耦（各用各的口径）。
 * ⚠️ P1-6（2026-10-04 审计）：只结算**已经收盘**的那一天（`day − 1`）。
 *    病根：`fngRawWith(…, day)` 读的是**当天最后一根小时**（`day×24+23`）—— 而这里是在
 *    当天**第一根**（`m.fngDay !== day` 恰好在这一根成立）就把整个当天的收盘行情读进来
 *    ⇒ 前视。改成传 `day − 1`（刚收盘的那一天）；`day < 1` 时（本局头一天还没走完）不结算，
 *    保持中性 50，等第二天再起算。
 * ⚠️ 调用点：`tickMarket`（当前币，②″ 位）＋ `npcOtherTick`（其他已加载币，npcBuild 之前）
 *    —— 两处都先于 `npcBuild` ⇒ 散户层读到的 fng 相位全币一致。
 */
function settleFng(s, sym, m, i) {
  const day = dayIndexOf(i);
  if (m.fngDay !== day && day >= 1) {
    const raw = fngRawWith(j => heatPriceAt(s, sym, j), sym, day - 1);
    m.fng = m.fngDay == null ? raw : m.fng + FNG.alpha * (raw - m.fng);
    m.fngDay = day;
    m.fngBand = fngBandStep(m.fngBand, m.fng);
  }
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
 * 重算并写下**持仓抛压折价**（`s.overhang[sym]`，v18 · 2026-10-01 拍板）—— 每次杠杆通道多头
 * 增减（开 / 加仓、平仓、强平、部分强平、交易所归零）之后调用，外加每日按流通量退坡重算。
 *
 * 写的是**台阶表** `{ at: [], v: [], scar: [] }`（三条平行数组，按 `at` 升序，**只许追加**；
 * 见 `god.stepValueAt`）：`v` = 该级台阶的价格折价（恒 ≤ 0）＝ **持仓折价 ＋ 疤痕**，
 * `v = −FLOAT.overhangMax × share + scar`。
 *
 * ⚠️ **疤痕 `scar`**（v25 · 2026-10-02）—— 卖出只释放一部分，其余永久留下：
 *    折算与 `s.flow` 的 `SHOCK.closeGive` **同一个比例**（买→卖往返不再等量抵消）。
 *    起因是实测缺陷：平掉一条 $50M 杠杆多头后，`overhang` 整条消失 ⇒ 释放的 −1.71% 折价
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
  /* 非有限值守卫（2026-10-02 审计修 · 风险 R2）：NaN / Infinity 一旦落进台阶表，`JSON.stringify`
     写成 `null`、读回 `NaN`，整条价格曲线随之变 NaN。读旧的 `scar` / `v` 时先自愈，否则会一路带毒。 */
  const prevScar = n && Number.isFinite(prevTab.scar[n - 1]) ? prevTab.scar[n - 1] : 0;
  const prevHold = n && Number.isFinite(prevTab.v[n - 1]) ? prevTab.v[n - 1] - prevScar : 0;

  const share = floatShareOf(s, sym, s.i);
  const hold = share > 0 ? -FLOAT.overhangMax * share : 0;

  let scar = prevScar;
  if (give > 0) {
    const drop = hold - prevHold;          // > 0 ⇒ 折价幅度在变薄（卖出 / 减仓）
    if (drop > 0) scar -= drop * (1 - give);
  }
  /* 下夹 `−FLOAT.overhangMax`（2026-10-02 审计修 · 风险 R1）：`scar` 只减不增，
     反复「开满 → 全平」往返会让残值线性下探 ⇒ `factorFor` 被钉死在 `SHOCK.fallMax`（−45%）。
     折价的物理上限就是「持仓占满浮筹」那一档（`hold` 的最小值 = `−overhangMax`），疤痕不该超过它。 */
  if (scar < -FLOAT.overhangMax) scar = -FLOAT.overhangMax;

  const v = hold + scar;
  if (!Number.isFinite(v)) return;                     // 同 R2 守卫：宁可不落这一级，也不写毒值
  if (n === 0 && v === 0) return;                                 // 本来就没折价：不建表
  if (n && prevTab.v[n - 1] === v && prevScar === scar) return;   // 值没变：不写
  const tab = prevTab || (s.overhang[sym] = { at: [], v: [], scar: [] });
  tab.at.push(s.i); tab.v.push(v); tab.scar.push(scar);
  /* ⚠️ 不刷 σ 缓存（2026-10-08，见 `daySigmaCache` 头注）：台阶 `at = s.i` 只影响它之后的根。 */
}

/**
 * 把一笔成交的**名义额**记到当根 K 线的量柱账上（`s.pvol`，v17 · 2026-10-01）。
 *
 * ⚠️ 只写量：滑点分母走 `liqOf`、价格位移走 `s.flow`，两条都不看这里 —— 它不参与任何玩法判定。
 * ⚠️ 口径（用户 2026-10-01 拍板）：名义额（含杠杆）／开仓＋平仓＋强平都算／**OTC 不算**
 *    （私下一口价不落公开盘口，与「不写冲击池」同一先例）—— OTC 的过滤放在调用点。
 * ⚠️ v19 起**按所分账**（`pvol[i][exId]`）：成交量阶梯手续费算的是「你在**这家所**近 30 天做了多少」，
 *    跨所搬钱后要重新攒量 —— 与真实交易所的 VIP 档按所计算一致。
 * ⚠️ v20 起再按**产品线**分账（`pvol[sym][i][exId][kind]`，`kind` = `'margin'` / `'fut'`）：
 *    杠杆与合约是两张费率表（`config.fees.margin` / `fut`），30 天量当然也得各算各的 ——
 *    混在一起会出现「靠杠杆刷量把合约费率刷低」这种现实里不存在的事。
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
  /* BTC 等值另一格（量化记录用）。取不到 BTC 价就只留美元那一格。 */
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
 * ⚠️ `kind` 默认 `'margin'` 只为「旧调用点忘改也能跑」兜底，四个调用点全都显式传。
 * @param {'margin'|'fut'} kind 这一单自己的产品线（与 `feeRateOf` 的 `kind` 同源）
 * @returns {{u:number,b:number}} 两个口径的合计（美元名义额 / BTC 等值）
 */
export function vol30Of(s, exId, i, kind = 'margin') {
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
 * **市场级** OTC 点差放大 —— 「级联 / 极端热度」期间大宗报价变宽
 * （缺口 11 · 2026-10-02 用户拍板「**只补市场级，玩家侧不做**」· `HEAT.kSpread = 3`，
 *  完整审计见 NEXT-STEPS §8.8.2 / §8.9.4）。
 *
 * ⚠️ **与 `advSpreadMul` 的分工**（缺一不可，两者相乘）：
 *    · `advSpreadMul` 读的是**玩家自己**的仓位 —— 「你的仓相对这个小时的深度太大」；
 *    · 本函数读的是**市场自己**的热度 —— 「市场正在踩踏 / 逼空」。
 *    原来只有前者 ⇒ 市场级踩踏期间点差**完全不变**（玩家没动仓 ⇒ `mul === 1`）——
 *    这正是缺口 11 里**真正**要补的那一半。
 *
 * ⚠️ **两端都触发，不是只贪**：文献（2025-10-10 崩盘：BTC 永续点差 0.02bps → **26.43bps**、
 *    盘口深度 **−98.3%**）记的是**崩盘**；而崩盘在本作里把热度压向 `HEAT.panic`
 *    （`stampede` 的 `m.heat -= HEAT.panicDrop`）。若只按 `heat > HEAT.greed` 触发，
 *    **恰恰崩盘不触发** ⇒ 等于没补上这个缺口。故按「离中性 `HEAT.base` 多远」取两端：
 *    贪婪侧到 1、恐慌侧到 0（`panic` / `greed` 对称地落在 `base = 0.5` 两侧）。
 *
 * ⚠️ **短时、有界**（两条文献约束）：热度逐小时更新、`k2 = 0.05` 的均值回复 ⇒ 放大随热度
 *    回落迅速消解（做市商 35 分钟恢复九成流动性），**不是** `advPeakOf` 那种周级台阶；
 *    上限 `1 + HEAT.kSpread = 4`，且常态（`heat ∈ [panic, greed]`）**恰好 1** ⇒ 与改动前逐位相同。
 */
function heatSpreadMul(s, sym) {
  const h = heatOf(s, sym);
  const t = h >= HEAT.greed
    ? (h - HEAT.greed) / (1 - HEAT.greed)
    : h <= HEAT.panic ? (HEAT.panic - h) / HEAT.panic : 0;
  return t > 0 ? 1 + HEAT.kSpread * t : 1;
}

/**
 * 一次 OTC 成交的溢价（P2-B 修订 · §15.3）。
 * **复用同一个 `dailySigma`** —— 不需要第二套「市场有多慌」的度量，它本来就是现成的。
 * ⚠️ 取「**此刻**」而不是开仓时的：卖出面对的是当时的流动性，不是当初的（§15.3 ⑤）。
 * ⚠️ v19 起多一个 `notional`：大宗台的报价随**单笔规模**变宽（`OTC.sizeP` / `sizeCap`）。
 * ⚠️ 本轮（2026-10-02）起多一个**市场级**乘数：`advSpreadMul`（玩家自己的仓）× `heatSpreadMul`
 *    （市场级踩踏）—— 两个来源相乘，常态下**都恰好 1** ⇒ 与改动前逐位相同。
 *    ⚠️ 不升 `STATE_VERSION`：本项**不新增任何存档字段**（`heat` 本来就在 `s.mkt[sym]` 里）。
 */
const otcPremiumFor = (s, sym, notional) => {
  const p = otcPremiumOf(dailySigma(sym, s.i), timeOf(s), notional);
  const mul = advSpreadMul(s, sym) * heatSpreadMul(s, sym);
  /* ⚠️ 放大之后再夹一次 `OTC.max`：那个 8% 是「任何年代、任何市况」的硬顶（`config.OTC`），
     放大不该在它上面开第二个口子。常态下 `mul === 1` ⇒ 与改动前逐位相同。 */
  return mul === 1 ? p : Math.min(OTC.max, p * mul);
};

/**
 * 日志里的价格走 `fmtLogPrice`（本轮 ②）—— `≥ $1` 固定 1 位小数、`< $1` 保留有效数字。
 * 原来这里有个 `showPrice`（取 8 位有效数字抹浮点尾噪），已随本轮删除：`toFixed` 本来就不带尾噪。
 */

/* ───────────────────────────── 交易动作 ───────────────────────────── */

/**
 * 这笔开仓是不是走**杠杆通道**（U1 · ROADMAP §21.4；v9 · §15.6 N2/N4 改判）——
 * 开仓那一刻算一次，写进仓位后**固定不变**。
 *
 * 规则（与 `side` / `lev` 无关）：**只看模式** —— `s.mode !== 'fut'` ⇒ 杠杆通道、`'fut'` ⇒ 合约。
 * ⚠️ **OTC 跟随模式**（2026-10-03 改判）：走 OTC 时不再强制 1x，而是沿用玩家当前模式
 *    （杠杆 / 合约），只是杠杆封顶 `OTC.levMax`、且允许做空。故这里不再有 `!!otc ||` 那一支。
 * ⚠️ 本作没有现货概念 —— 杠杆通道的最低档就是 1x（**1x 多头**无借入 ⇒ 不计息、不参与强平；
 *    1x 空头借了全额币，照常计息、照常有强平线。口径见 `positions.borrowedOf`）。
 */
const marginOf = (s, otc) => s.mode !== 'fut';

/** 本单走哪张杠杆表（§15.1 的两张表）：合约走 `'fut'`，其余一律走 `'margin'`（杠杆借贷）。
 *  ⚠️ 导出给 `main.js` 那枚杠杆键用（§15.6）—— 两处各写一遍迟早会不一致。 */
export const levKind = s => (s.mode === 'fut' ? 'fut' : 'margin');

/**
 * 同币加仓的**兼容性闸门**（v13 · B4 / 方案 §5.2）—— `openTrade` 在**下单那一刻**过这道闸。
 *
 * 四项各给一句明确文案，不静默失败：
 *   · 反方向 ⇒ 引导玩家自己「先平仓」（不替他反手：反手是一笔新仓，该由他决定）
 *   · 性质不同（杠杆 / 合约）⇒ 两张杠杆表、两种费率，混在一条仓里算不出强平价
 *   · 通道不同（盘口 / OTC）⇒ 成交价口径不同
 *   · 杠杆不同 ⇒ 加权均价对两种杠杆没有意义（D4 已拍板）
 *
 * ⚠️ **唯一例外（2026-10-03 二次拍板 · ⑥ 静默降杠杆）**：`tierCapped` 且 `lev ≤ prev.lev` 时放行。
 *    这是「加仓把名义顶进更低档 ⇒ 杠杆被档位顶下来」的情形 —— 玩家没主动改杠杆，是交易所口径
 *    把有效杠杆调低了（真实 Binance 亦然）。此时并仓会顺带把 `pos.lev` 更新到钳位后的值
 *    （见 `applyFill`），让「已持 Nx」的显示与加仓后的真实杠杆一致。
 *    升杠杆加仓（`lev > prev.lev`）仍拒绝 —— 那才是 D4 要挡的「两种杠杆混算」。
 *
 * @param {boolean} tierCapped 本单的降杠杆是否由 ⑥ 档位封顶造成
 * @returns {string|null} 拒绝理由；`null` = 放行
 */
function posGate(s, sym, side, marginOrder, otc, lev, tierCapped = false) {
  const prev = posOf(s, sym);
  if (!prev) return null;
  if (prev.side !== side) return `${sym} 已有${prev.side === 'long' ? '多' : '空'}单 ｜ 反手请先平仓`;
  if (isMargin(prev) !== marginOrder) return `${sym} 已有${isMargin(prev) ? '杠杆' : '合约'}仓 ｜ 加仓请先切回同一模式`;
  if (!!prev.otc !== otc) return `${sym} 已有${prev.otc ? 'OTC' : '盘口'}仓 ｜ 加仓请先切回同一通道`;
  if (prev.lev !== lev && !(tierCapped && lev <= prev.lev)) {
    return `${sym} 已持 ${prev.lev}x ｜ 加仓必须同杠杆 ｜ 先平仓再重开`;
  }
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
 * ⚠️ `retier`（⑥ 静默降杠杆）：本单的降杠杆是被名义档位顶住的 ⇒ 并仓时把 `pos.lev` 更新到钳位后的
 *    值，让「已持 Nx」的显示与加仓后的真实杠杆一致。只在**并进已有仓位**时生效（新开那条在
 *    `openPosition` 里就已经拿到钳位后的 `lev`）。永远发生在 perp 上（见 `openCheck` 的 ⑥ 段）。
 */
function applyFill(s, { sym, side, fill, margin, notional, lev, feeRate, marginMode, fee, mix, otc = false, retier = false }) {
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
    if (retier) pos.lev = lev;
  } else {
    pos = openPosition(sym, side, fill, margin, lev, feeRate, marginMode);
    pos.i = s.i;
    pos.ex = s.ex;                    // 仓位挂在哪家所 —— 归零事件据此精确作废（GDD §7.2）
    pos.openFee = fee;
    pos.mix = mix;                    // 保证金的两格构成（v13）—— 平仓原路退回
    if (otc) pos.otc = true;          // 只给 OTC 仓位打标（通道守卫 / 不写盘口冲击用；F3 起 `capturedOf` 仍计入）
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
 *   | {ok:true, lev:number, kind:'margin'|'fut', feeRate:number, mustUsdt:boolean, prev:object|null,
 *      otc:boolean, isMarginOrder:boolean, margin:number, fee:number, notional:number, cost:number, fill:number}}
 */
/* ── ③ 价格保护带（BAND · 2026-10-03）—— 判据与锁定窗口都是 `(sym, i)` 的**纯函数** ──
   不存状态、不写存档：触发与否只由**原始行情**决定 ⇒ 读路径可以随便调（`openCheck` 每帧都在调）。 */

/** 第 `i` 根小时是否**触发了价格保护带**（单小时原始收益 ≥ `max(kσ, floor)`）。 */
function bandBreachAt(sym, i) {
  if (GAME.start + i * HOUR_MS < BAND.from) return false;   // 这家所那时还没这规矩
  const c1 = rawCloseAt(sym, i), c0 = rawCloseAt(sym, i - 1);
  if (!(c1 > 0) || !(c0 > 0)) return false;                 // 行情没加载 / 该币还没上线
  const lim = Math.max(BAND.k * dailySigma(sym, i), BAND.floor);
  return Math.abs(c1 / c0 - 1) >= lim;
}

/**
 * 此刻是否处于**只允许平仓**的窗口 —— 触发那根 K 线**收线之后**起算，覆盖接下来 `BAND.hours` 根。
 * （`i` 触发的行情在 `i` 这根里已经走完 ⇒ 要锁的是 `i+1 … i+hours`。）
 */
function priceBandAt(sym, i) {
  for (let k = 1; k <= BAND.hours; k++) if (bandBreachAt(sym, i - k)) return true;
  return false;
}

function openCheck(s, side, frac = 1) {
  if (s.over) return { ok: false, why: '本局已结束' };

  /* 停机维护（B24）：窗口内**只平不开** —— 平仓是逃生通道，不许被维护挡住（2020-03-13 那种暴跌里
     真被挡住的玩家就是这么绝望的，但本作不打算把「无法平仓」也一起复刻成必然爆仓）。
     ⚠️ 只拦开仓，`closeTrade` 一个字都不动。
     ⚠️ 受「新闻源与事件」总闸（2026-10-09 `eventsOff`）：停机本身是一条史实利空事件 ——
        上帝关事件 ⇒ 不播也不限（沙盒里不存在「所坏了」）。 */
  if (!eventsOff(s) && haltedAt(timeOf(s), s.ex)) {
    return { ok: false, why: `${exchangeOf(s.ex)?.name ?? s.ex} 停机维护 ｜ 暂时不能开仓` };
  }

  /* 通道（P2-B3 · §15.3；2026-10-03 改版）：OTC 是**大宗通道**，跟随玩家当前的 `s.mode`
     （杠杆 / 合约都可走），且**允许做空** —— 它只是一口价的大宗撮合，与盘口同一条产品线。 */
  const otc = chanOf(s) === 'otc';

  /* 杠杆做空要先**借到币**（v10 · 史实口径）：该所此刻没有融资市场就借不到 ⇒ 空单无从谈起。
     判据是 `hasFinancingAt`（＝杠杆表上限 > 1）—— BitMEX / 2019-07 前的 Binance 只有 1x，
     也就是「用自己的钱买币」，没有任何出借方。
     ⚠️ 只拦**开仓**：已在场的仓位照常持有，平仓也不受影响（否则旧档里那张空单会被关在里面）。
     ⚠️ 至于有融资的所里把杠杆调到 **1x 的空单**（如 Bitfinex 3.3x 档下）：它借了全额币 ⇒
        `canLiquidate` / `paysInterest` 按**借入量**判定 ⇒ 照常有强平线、照样付借贷利息（2026-10-03）。 */
  if (side === 'short' && marginOf(s, otc) && !hasFinancingAt(timeOf(s), s.ex)) {
    return { ok: false, why: '杠杆做空 暂不可用 ｜ 该所此刻没有融资业务' };
  }

  const coin = coinOf(s.sym);
  if (!coin || !isLoaded(s.sym)) return { ok: false, why: '行情还没加载完' };
  if (timeOf(s) < coin.unlock) return { ok: false, why: `${s.sym} 还没上线` };

  const price = exPrice(s, s.sym, s.ex);   // 缺口 10：按**当前所在所**的本所价成交
  if (!(price > 0)) return { ok: false, why: '当前没有可成交的价格' };

  /* 杠杆上限与费率都取**玩家当前所在的交易所**（GDD §7.1）。2026-10-03：OTC 不再是「锁定 1x、只做多的通道」，
     而是**大宗通道跟随模式** —— 杠杆 = 玩家设的值，同时受「该所此刻的上限」与 `OTC.levMax` 双重封顶
     （大宗私下一口价，杠杆给不到盘口那么高）。非 OTC 不受第二条限制。 */
  let lev = Math.max(1, Math.min(s.lev, maxLeverageAt(timeOf(s), s.ex, levKind(s)), otc ? OTC.levMax : Infinity));
  /* 费率是**两张表**（v12 · 方案 §11.3）：这一单走 `margin` 还是 `fut` 由**它自己的性质**定
     （`marginOf` 只看模式），与玩家此刻翻到哪一页无关 —— 否则切个页面就能换费率。 */
  const isMarginOrder = marginOf(s, otc);
  /* ⚠️ `kind` 一处算好、三处共用（费率 / 30 天量 / 记量柱）—— v20 起这三者必须同源，
     否则会出现「按合约费率收钱、却把量记到杠杆账上」这种自相矛盾。 */
  const kind = isMarginOrder ? 'margin' : 'fut';
  /* ③ 价格保护带（BAND · 2026-10-03 拍板）：极端行情窗口里 **只允许平仓**。
     ⚠️ 只对 **Binance 永续**生效（2019-09-13 起）：其余所在那之前**没有任何熔断**（史实），
        这条闸不是「所有所的通用风控」—— 所以判据里必须带 `s.ex` 与 `kind` 两个条件。
     ⚠️ 判据走**原始行情**（`bandBreachAt`），玩家自己砸出来的插针不触发。
     ⚠️ 只拦开仓；`closeTrade` 一个字都不动（逃生通道，与 `haltedAt` 同纪律）。
     文案与停机维护**分开**：那是「所坏了」，这是「行情太野」—— 两句话读起来必须不一样。 */
  if (!isMarginOrder && s.ex === BAND.ex && priceBandAt(s.sym, s.i)) {
    return { ok: false, why: '极端行情 ｜ 只允许平仓' };
  }
  /* 费率带上这家所**近 30 天、这一条产品线**的成交量（v19 · 阶梯手续费）：巨鲸买单便宜、散户落在首档。
     ⚠️ 取的是**本笔之前**的量 —— 这一笔自己不该把自己打进下一档。 */
  const feeRate = feeRateOf(s.ex, timeOf(s), kind, vol30Of(s, s.ex, s.i, kind));
  /* 这一单能动用多少钱（v13 · 方案 §9.2 ②）：**合约只认 USDT**（USDT 本位永续，
     保证金必须是 U），杠杆 / OTC 是两格之和（扣的时候先扣 U、不足补美元）。
     所以 2013 年那 $1,000 美元可以开杠杆，但要玩合约得先在资产页「买 U」。 */
  const mustUsdt = !isMarginOrder;
  const cash = spendableOf(s, mustUsdt);

  /* ── ⑥ 名义阶梯杠杆封顶 · **静默降杠杆**（2026-10-03 用户二次拍板）──
     Binance 永续按**结果名义**判档：名义越大、可开的杠杆越低（真实 BTCUSDT 阶梯，与维持保证金率
     同一张表 `config.notionalMaxLevAt`）。判据 = 「本单名义 ＋ 已有仓位按**现价**的名义」⇒
     加仓与价格漂移都会被重判。
     ⚠️ 口径（用户 2026-10-03 二次拍板）：超档**静默把杠杆钳到档位上限**，**不拒绝** ——
        拒绝会让玩家「无法下单、还要先平仓再下单」（真实交易所在持仓跨越档位时也是自动调低有效杠杆）。
        `openTrade` 会把这个钳位写一条日志告知玩家，`s.lev` 也随之落到钳位后的值。
     ⚠️ 钳位只降不升，且只对 **Binance 永续**生效（`margin` / 其余所在 `notionalMaxLevAt` 返回 `Infinity`）。
     ⚠️ 保证金算式（与下面同源、抽出复用）：钳位要先知道「按所选杠杆算出的名义」才能判档。 */
  const marginAtLev = lv => {
    const m0 = cash * Math.max(0.0001, Math.min(1, frac));
    return m0 + m0 * lv * feeRate > cash ? cash / (1 + lv * feeRate) : m0;
  };
  const heldNotional = positionNotionalOf(s, s.sym);
  const tierCapLev = notionalMaxLevAt(s.ex, heldNotional + marginAtLev(lev) * lev, kind);
  const tierCapped = lev > tierCapLev + 1e-9;
  if (tierCapped) lev = tierCapLev;

  /* ── 同币加仓的兼容性闸门（v13 · B4 / 方案 §5.2）──
     这一单若与已有仓位冲突，**必须在动账之前**拒绝（下面一旦 `debit`，钱就已经扣了）。
     四项判据集中在 `posGate` 里（与渲染层同源，三处不各算一遍）。
     ⚠️ 2026-10-03 二次拍板：`tierCapped`（降杠杆是被档位顶住的）时**放宽**那条「加仓必须同杠杆」——
        否则持 20x 的仓一旦被行情顶超档，玩家就再也加不进去（只能先平仓），这正是 ⑥ 要拆的墙。
        升杠杆加仓仍然拒绝（两种杠杆混在一条仓里算不出强平价，D4 原判据不动）。 */
  const prev = posOf(s, s.sym);
  const gate = posGate(s, s.sym, side, isMarginOrder, otc, lev, tierCapped);
  if (gate) return { ok: false, why: gate };

  // 保证金 = 可用余额 × frac；开仓费按名义价值另收，所以要让「保证金 + 费 ≤ 余额」
  const margin = marginAtLev(lev);
  const fee = margin * lev * feeRate;
  if (!(margin > 0) || margin + fee > cash + 1e-9) {
    return { ok: false, why: mustUsdt ? '合约保证金必须是 USDT ｜ 先在资产页把美元换成 U' : '可用保证金不足' };
  }
  /* 单笔最小名义（2026-09-30 建闸 · 2026-10-01 丙案改按「所 × 产品 × 年代」取值；
     2026-10-05 再补**交易对**这一维 —— Binance 合约 2023-11-02 起 BTC 100 / ETH 20 / 其余 5）：
     余额只剩浮点残值时上面那条**拦不住**（`margin > 0` 恒真），会建出一张点不掉的幽灵持仓。
     `MIN_NOTIONAL`（$1）降级为**浮点保底**，真实门槛走 `config.minNotionalAt` ——
     产品口径与费率**同源**（都用这一单自己的 `isMarginOrder`），所以切页面换不出不同的门槛。 */
  const minNotional = Math.max(MIN_NOTIONAL, minNotionalAt(s.ex, timeOf(s), isMarginOrder ? 'margin' : 'fut', s.sym));
  if (!(margin * lev >= minNotional)) {
    return { ok: false, why: `下单金额太小 ｜ 单笔名义需 ≥ ${fmtMoneyShort(minNotional)}` };
  }

  /* OTC 的门槛（§15.3）：单笔名义 ≥ 当年门槛。2026-10-03 起 OTC 带杠杆 ⇒ 按**名义**（`margin × lev`）
     比对，否则「把杠杆拉高、保证金压到门槛以下」就能绕开大宗通道的最低规模。
     ⚠️ 门槛逐年化（`otcMinAt`，2013 $1 万 → 2016 $10 万 → 2020 $25 万）：绝对常量在早期量纲失焦
        —— $1M 在 2013 ≈ 当日 3.3% 成交量、且当年现实中根本没有机构 OTC 台 ⇒ 会把早期 OTC 变成死内容。
     ⚠️ 门槛只卡**开仓**，不卡平仓 —— 卡平仓会把玩家困在一条「币价跌下来、名义已不足门槛」的仓位上。 */
  const otcMin = otcMinAt(timeOf(s));
  if (otc && margin * lev < otcMin) return { ok: false, why: `OTC 单笔最少 ${fmtMoneyShort(otcMin)}` };

  /* 成交价（P2-B1 / P2-B3）：盘口价 ± 代价 —— 买抬、卖压，**永远对玩家不利**。
     代价有两种，同一时刻只有一种成立：盘口是**走簿逐档撮合**（18 档吃簿，2026-10-07 拍板、
     2026-10-08 浮窗扩容同升 18）、
     OTC 是「基准点差 × 市况倍数」（不吃滑点）。
     ⚠️ 保证金与开仓费都不受它影响（那两项按名义价值算，与成交价无关），
        受影响的是 `size`：买贵了就拿到的币少一点，这才是代价的真实形态。 */
  const notional = margin * lev;
  const dir = side === 'long' ? 1 : -1;
  /* ⚠️ `canOpenAt` 每帧都进这里 ⇒ 走簿必须轻：18 档循环 ＋ `levelsOf` 单槽缓存（levels.js）。 */
  const walk = otc ? null : walkFillFor(s, s.sym, s.i, notional, dir, price);
  const cost = otc ? otcPremiumFor(s, s.sym, notional) : walk.cost;
  const fill = fillPrice(price, dir, cost);

  /* 借贷额度上限（B26 · 2026-10-03 拍板）：能借多少由资金市场的**深度**决定 ——
     `当日全市场流动性 × MARGIN.quota`（与滑点门槛同一把尺子，见 `config.MARGIN.quota` 注释）。
     判的是**结果仓位**的借入量（已有仓 ＋ 这一单），且**只卡开仓**、不卡平仓（同 `haltedAt` 纪律）。
     ⚠️ 只有**杠杆单**才有借入（合约不借钱、只付资金费）⇒ 非杠杆单整条跳过。
     ⚠️ 取不到当日流动性（该币还没上线 / 数据缺格）⇒ `liqOf` 返回 `null` ⇒ **放行**：宁可漏放这条约束，
        也不能因为一个数据缺格就把所有单子按「额度已满」处理（与 `floatShareOf` 同一纪律）。
     ⚠️ **OTC 通道整条豁免**（用户 2026-10-03 拍板）：这条闸的尺子是「**盘口**流动性 × 10%」，
        而 OTC 是**场外撮合、根本不吃盘口深度** —— 拿盘口口径去卡它自相矛盾。当初拍板的实证
        （审计 `9f`）是：BTC 2013 的 OTC 最低单 $17K > 当日可借额度 $14K（**当时的锚**）⇒ 玩家会
        同时看到「最少 $17K」与「最多借 $14K」两句互相打架的提示，1x 做空与 4x 以上做多在 2013
        走 OTC 是**死结**。
        ⚠️ 2026-10-04 修正 BTC 早期年锚后，那个**具体数值的死结已不再存在**（2013 额度抬到 ~$2M
        量级）；但豁免照旧成立 —— 依据是「两把尺子不同」（盘口 vs 场外），不是当初那个数值。
        OTC 自己的规模约束是**入场门槛（权益 > 20 万）＋ `otcMinAt` 最低单**，已经够用。
        ⇒ 代价：OTC 通道不再受额度上限约束（拿自有资金 × 杠杆封顶，不是无界）。 */
  if (isMarginOrder && !otc) {
    const liqToday = liqOf(s.sym, dayIndexOf(s.i));
    const borrowCap = liqToday > 0 ? liqToday * MARGIN.quota : Infinity;
    const addBorrowed = side === 'short' ? notional : notional * (1 - 1 / lev);
    if (borrowedOf(prev) + addBorrowed > borrowCap) {
      return { ok: false, why: `借贷额度不足 ｜ ${s.sym} 当日可借约 ${fmtMoneyShort(borrowCap)}` };
    }
    /* 做空供应量上限（§9.5 重启 · 2026-10-09 用户拍板「硬拒＋费率飙升」）：做空必须**借到真币**
       才能卖，借出的币是真实流通量的一部分 —— 借币池 = `supplyAt × MARGIN.shortShare`（1%）。
       只卡**空头**这一支（多头借的是美元、不占币量；合约空头是合成敞口不借真币），取不到
       流通量 ⇒ 放行（与上面同一纪律）。费率端的飙升由 `marginRateMulOf` 的 jump 段承接。 */
    if (side === 'short') {
      const supDay = supplyAt(s.sym, dayIndexOf(s.i));
      if (supDay > 0) {
        const supplyCap = supDay * MARGIN.shortShare * price;
        if (borrowedOf(prev) + addBorrowed > supplyCap) {
          return { ok: false, why: `做空供应量不足 ｜ 全市场可借 ≈ ${fmtQty(supDay * MARGIN.shortShare)} 枚（流通量 1%）` };
        }
      }
    }
  }

  /* 供应量上限（P2-B2 · §15.1 / §15.4）：买入会从市场里锁走一部分币，锁走的枚数不得越界。
     ⚠️ 校验必须排在**动账之前** —— 下面那几行一旦执行，钱已经扣了，这时再拒绝就没法干净地退回。
     ⚠️ 只有多头方向消耗供应量（空头没把币拿走）；**OTC 买入同样消耗**（2026-10-04 · F3）：
        场外单也从卖方钱包划走真实代币 ⇒ 一样受流通量上限约束。旧口径整条豁免 OTC，等于
        允许「一口气买超过流通量且市场零反应」—— 与用户审计指令直接冲突。
     闸门 = 占比 × 当年真实流通量（`supplyCapOf`），整局不会触发 ⇒ **不为它新增终局**（GDD §16 只有两种收场）。
     ⚠️ P1-3（2026-10-04 审计）：**只对 `isMarginOrder` 的多头生效**，与 `capturedOf` 的口径对齐。
        病根：闸门原来只看 `side === 'long'`，`fut` 多单也计入 —— 可 `capturedOf`（state.js）
        **恒不认 `fut`**（合约是衍生品、实物一枚没动，v18 既有拍板）⇒ 两边自相矛盾：
        闸门会拦一张超过流通量的合约多单，却拦不住「连续多张合约多单叠加超量」
        （因为分母里的 `capturedOf` 永远停在 0）。按 `isMarginOrder` 收口后，
        合约多单**整条不进这道闸门**（它本来就不挤占实物流通盘），杠杆 / OTC 多头照旧。 */
    const cap = supplyCapOf(s.sym, s.i);
    if (side === 'long' && isMarginOrder && capturedOf(s, s.sym) + margin * lev / fill > cap) {
      return { ok: false, why: `${s.sym} 已触及供应量上限，无法继续买入` };
    }

  return { ok: true, lev, kind, feeRate, mustUsdt, prev, otc, isMarginOrder, margin, fee, notional, cost, fill, walk, tierCapped };
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
  const { lev, kind, feeRate, mustUsdt, prev, otc, isMarginOrder, margin, fee, notional, cost, fill, walk, tierCapped } = c;

  /* 扣账（v13）：`debit` **先扣 USDT、不足补 USD**（合约只认 USDT），并返回两格各扣了多少 ——
     那个 `mix` 就是「原路退回」的凭据，平仓时按同比例还回两格（见 `state.credit`）。
     ⚠️ 校验已在上面的 `margin + fee > cash` 拦过一次，这里返回 `null` 属兜底（理论不可达）。 */
  const mix = debit(s, margin + fee, mustUsdt);
  if (!mix) return { ok: false, why: mustUsdt ? '合约保证金必须是 USDT ｜ 先在资产页把美元换成 U' : '可用保证金不足' };
  /* ⚠️ 开仓费是**玩家真实付出的钱**，必须同时记进「已实现」（Batch 5 · B23）——
     原来只从余额里扣、不写 `realized`，于是 HUD 副行那个数既不等于真实现金变动、
     也不等于已实现盈亏。它只被 `render.js` 读来展示，不参与任何玩法判定。 */
  s.realized -= fee;
  exCharge(s, fee);                     // 手续费进交易所收入账（回流管道 · config.EXREV）
  if (otc) exCharge(s, notional * cost / (1 + (side === 'long' ? 1 : -1) * cost));   // OTC 溢价 = 柜台收入（点差对名义的加成，精确式见 config.EXREV 注）
  s.lev = lev;

  const marginMode = isMarginOrder;
  /* ── 落账（新开 or 并进已有仓位）── */
  const pos = applyFill(s, {
    sym: s.sym, side, fill, margin, notional, lev, feeRate, marginMode, fee, mix, otc, retier: tierCapped,
  });

  /* 笔数（C8-B1）：走簿实际吃满用了几档（`walkFillFor` 的 `n`）。OTC 是私下一口价、不吃滑点 ⇒ 不报。 */
  const fills = otc ? 1 : walk.n;
  const tag = otc ? `｜OTC 溢价 ${fmtRate(cost, 2)}` : slipTag(cost, fills);
  /* 字面跟着模式走（v9 · §15.6 N4「没有的选项不显示」的同一条口径）：杠杆模式的操作键是
     **买入 / 卖出**，日志若还写「做多 / 做空」，就与玩家刚按下的那枚键对不上了。 */
  const verb = marginMode ? (side === 'long' ? '买入' : '卖出') : (side === 'long' ? '做多' : '做空');
  /* 手续费必须**写进日志**（本轮 ② · 用户拍板）：它已经真的从余额里扣掉了（上面那两行），
     玩家却只看到「保证金 $1,000.0」——账对不上。`fee` 就是本笔按名义价值收的那一次。
     ★ 加仓（B4）：字面换成「加仓 ＋ 追加保证金」，并补一个**加权后的均价** ——
       否则玩家只能看到「这笔按 $13.5 成的」，看不到自己整条仓位现在的成本在哪。 */
  const qty = notional / fill;                 // 本次成交拿到的币量（加仓时是这一笔的量）
  /* 三类表述（用户 2026-10-01，两轮拍板）：
     · **杠杆 1x**：**不写 `1x`** —— 它是最低档、没有「倍数」可言，写了反而与前两类混同；
       币量**提到最前** ⇒「买入 N 枚 SYM｜花费 $X」，正文就不再重复币量；
     · **带杠杆 / 合约**：带倍数，正文报「保证金 ＋ 名义」（币量不参与结算，玩家也不看它）。 */
  const plainMargin = marginMode && lev === 1;
  const head = plainMargin
    ? `${prev ? '加仓' : verb} ${fmtQty(qty)} 枚 ${s.sym}`
    : (prev ? `加仓 ${s.sym} ${lev}x` : `${verb} ${s.sym} ${lev}x`);
  const line = plainMargin
    ? `${prev ? '追加' : '花费'} ${fmtMoneyShort(margin)}`
    : `${prev ? '追加保证金' : '保证金'} ${fmtMoneyShort(margin)} · 名义 ${fmtMoneyShort(notional)}`;
  const avg = prev ? `｜均价 ${fmtLogPrice(pos.entry)}` : '';
  /* ⑥ 静默降杠杆的告知（2026-10-03 二次拍板）：玩家按了 125x、这一单实际只有 5x —— 不写一句
     就成了「静默改参数」。只在真被档位顶住时出现，与 `head` 里的 `${lev}x` 相互印证。 */
  const tiertag = tierCapped ? `｜杠杆受名义档位限制 已降至 ${lev}x` : '';
  pushLog(s, `${head}｜${line} @ ${fmtLogPrice(fill)}${avg}｜手续费 ${fmtMoneyShort(fee)}${tag}${tiertag}`,
    side === 'long' ? 'long' : 'short', 'trade');

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
    /* 第 8 参 `walk.eaten`：本笔走簿吃掉的墙 —— 位移吸收按剩余权重折减（精确耦合）。
       加仓的 `dir` 与上面 openCheck 里那一个同值，就地重算（开仓之后价格已动，不缓存旧值）。 */
    pushFlow(s, s.sym, dir, notional, 1, shockKindOf(isMarginOrder, lev), true, walk.eaten);
    /* 玩家自己的成交量（v17 · 2026-10-01）：这一笔从此在量柱上看得见，
       也进这家所**这条产品线**的 30 天量（v19 按所 / v20 按产品线 / v24 按币） */
    addPlayerVol(s, s.sym, notional, s.ex, kind);
    /* 瞬时深度池（L1 · 2026-10-01）：这一笔吃掉的深度从池子里扣 —— 连点买入的边际难度递增。
       与上面 `addFlow` 同步过滤 OTC（此处就在 `!otc` 分支内）。 */
    consumePool(s, s.sym, notional);
  }
  /* 持仓抛压折价（v18 · 2026-10-01）：这一单若**加厚了杠杆实物多头**，市场对你的忌惮随之变重。
     合约 / OTC 不改变 `capturedOf` ⇒ 值没变时函数内部自己会跳过（不写、不冲 σ 缓存）。 */
  refreshOverhang(s, s.sym);
  /* 交易统计（v21）—— 只喂 M2 的「交易档案」与 M3 的「称号」，不参与任何判定。
     ⚠️ 记在**成功落账之后**：被闸门拦下 / 资金不足 / 低于最小名义的那些单不算一笔。 */
  s.stat.open += 1;
  if (prev) s.stat.addOn += 1;            // v32：对**已有仓位追加**那一笔（滚仓「持续加仓」那一半）
  if (otc) s.stat.otc += 1;               // v32：走 OTC 通道成交（盘口 / OTC 是两条路）—— 称号「场外玩家」
  if (marginMode) s.stat.margin += 1; else s.stat.fut += 1;
  if (lev > s.stat.maxLev) s.stat.maxLev = lev;
  s.stat.syms[s.sym] = true;

  /* ⚠️ R2（2026-10-05 审计修 · 死区缺口）：开仓**已经落账**（上面全做完了），此处只行使
     「归零判定」的副作用，返回值必须是 **`ok: true`**（与 `closeTrade` 末尾同一条口径）。
     为什么要在这里判：开仓费 ＋ 滑点是**当场**从余额里扣掉的真钱，若玩家恰好停在门槛上
     下单，这一笔之后权益就掉到 `ruinFloorOf` 之下 —— 不在这里判，就会出现「钱已不够开下一单、
     却还能继续操作」的小时级死区（要等下一根 K 线才由时钟兜住）。
     破产的收场照旧交给时钟那一步（`advanceOneHour` 会再次 `checkRuin`），这里只是**提前**一档。 */
  checkRuin(s);
  return { ok: true };
}

/**
 * **平仓校验** —— 纯判据，**一个字节的状态都不改**（与 `openCheck` 完全对称）。
 *
 * `closeTrade` 与渲染层的 `canCloseAt` 读的是**同一个函数**：金额档该不该置灰、
 * 这一下点下去会不会失败，两处不可能各算一遍（与 `hasFinancingAt` 三处同源同一纪律）。
 *
 * @param {number} frac **平掉仓位的比例**（0–1）—— 操作区那 1/4 · 1/2 · 全部。
 *   `1` = 全平（2026-10-02 之前唯一的行为）。
 * @returns {{ok:false, why:string}
 *   | {ok:true, pos:object, otc:boolean, f:number, pk:'margin'|'fut', feeRate:number,
 *      closeSize:number, notional:number, cost:number, fill:number}}
 */
function closeCheck(s, frac = 1) {
  /* 2026-10-05 审计修：与 `openCheck` / `adjustCheck` 对称地补上「本局已结束」守卫 ——
     原先只有这一处漏了，`s.over` 后玩家仍能点出一个 `ok:true` 的平仓判据（金额档不会置灰）。 */
  if (s.over) return { ok: false, why: '本局已结束' };
  const sym = s.sym;
  const pos = posOf(s, sym);
  if (!pos) return { ok: false, why: `${sym} 没有持仓` };

  const price = exPrice(s, sym, pos.ex);   // 缺口 10：按**本仓所在所**的本所价平仓（与开仓同源）
  if (!(price > 0)) return { ok: false, why: '当前没有可成交的价格' };

  /* 通道（§15.3；2026-10-03 改版）：OTC 是**大宗通道**，与盘口同一条产品线，什么仓位都能平 ——
     通道只决定「这一笔成交走哪条路」（溢价 / 冲击形态），不再限制可平的仓位类型。 */
  const otc = chanOf(s) === 'otc';

  const f = Math.max(1e-6, Math.min(1, frac));
  /* 平仓费走**开仓时那张表**（v12 · §11.3）：判据是仓位自己的 `isMargin`，
     不是玩家此刻的模式 —— 杠杆仓平仓不该按合约费率收，反之亦然。 */
  const pk = isMargin(pos) ? 'margin' : 'fut';   // 仓位自己的产品线（v20）：费率与 30 天量同源
  const feeRate = feeRateOf(pos.ex, timeOf(s), pk, vol30Of(s, pos.ex, s.i, pk));
  const closeSize = pos.size * f;
  const notional = closeSize * price;

  /* **最小平仓金额**（2026-10-02 用户拍板）：只卡**分批**（`f < 1`），全平永不设门槛 ——
     门槛卡住全平会把玩家困在一条小仓位上，与 OTC 那条「门槛只卡买入、不卡平仓」同一理由。
     ⚠️ 没有这一条，`1/4` → `1/4` → … 能无限切下去（仓位几何缩小、永不归零）：既留下尘埃仓，
        也把「分批卖出」变成一条刷手续费的通道。门槛与开仓**同源**（所 × 产品 × 交易对 × 年代）。 */
  if (f < 1) {
    const minClose = Math.max(MIN_NOTIONAL, minNotionalAt(pos.ex, timeOf(s), pk, pos.sym));
    if (notional < minClose) {
      return { ok: false, why: `单笔平仓金额太小 ｜ 至少 ${fmtMoneyShort(minClose)}（或点「全部」）` };
    }
  }

  /* 成交价（P2-B1 / P2-B3）：**平多是卖、平空是买**，所以方向与开仓时相反 ——
     代价永远对玩家不利：卖掉打点折、买回抬点价。盘口侧走**走簿逐档撮合**（与开仓同源）。 */
  const dir = pos.side === 'long' ? -1 : 1;
  const walk = otc ? null : walkFillFor(s, sym, s.i, notional, dir, price);
  const cost = otc ? otcPremiumFor(s, sym, notional) : walk.cost;
  const fill = fillPrice(price, dir, cost);

  return { ok: true, pos, otc, f, pk, feeRate, closeSize, notional, cost, fill, walk };
}

/** 渲染层用的**纯判据**：这一笔平得出来吗 —— 与 `closeTrade` 同源（金额档的置灰读它）。 */
export const canCloseAt = (s, frac = 1) => closeCheck(s, frac).ok;

/* ───────────────────────── 逐仓 · 调整保证金（OKX 式 · 2026-10-04 用户拍板） ───────────────────────── */

/**
 * **调整保证金的上下限**（纯读，不改状态）—— 弹层里的预设金额与置灰判据读它。
 *
 * 史实（用户 2026-10-04 拍板「就像 OKX 那样」，已核过一手）：
 *   - **增加 / 减少保证金是逐仓的标配**，早于 Binance —— BitMEX（2014 成立、逐仓自始）持仓上就有
 *     `Add Margin`；OKX 逐仓持仓旁可**增加 / 减少**保证金（区间为交易账户余额的一定比例）；
 *     Binance 逐仓合约亦有 Adjust Margin。**全仓模式没有这个按钮**（用账户总额整体担保）。
 *   - 本作从 v13 起就是逐仓（每仓独立 `pos.margin`）⇒ 天然兼容，**不需要新状态字段**、不升存档版本。
 *   - 现实约束：加受**可用余额**限制；减不能把保证金率压到**维持线**以下（否则是自己推向强平）。
 *
 * @returns {null | { pos:object, price:number, mustUsdt:boolean, add:number, reduce:number }}
 *   `add` = 此刻最多能加多少（2026-10-09 超额抵押解锁：只受可用余额约束，可越过名义）；
 *   `reduce` = 此刻最多能减多少（都 ≥ 0）
 */
export function marginCapsOf(s, sym) {
  const pos = posOf(s, sym);
  if (!pos) return null;
  /* ⚠️ 2026-10-05 审计修（口径分叉）：这里原来读 `exPrice`（**最新价**，含玩家自己刚砸出的位移），
     而下方注释与全作其余估值口径都要求「与强平判据同源」—— 强平 / 持仓条 / 未实现盈亏 /
     资金费一律读**标记价**（`exMarkPrice`）。两价不同 ⇒ 同一个仓位在**弹层**与**持仓条**会显示
     不同的保证金率，且「可减保证金」上限按 last 算 ⇒ 玩家能把自己减到比预期更贴强平线的位置。
     改读标记价后三处同源（`render` 的持仓条 / 弹层 / `liquidateAll`）。 */
  const price = exMarkPrice(s, sym, pos.ex);
  if (!(price > 0)) return null;
  const mustUsdt = !isMargin(pos);                 // 合约（perp）只认 USDT；杠杆是两格之和
  /* **超额抵押解锁**（2026-10-09 用户拍板，推翻 2026-10-05 的「1x 封顶」）—— 保证金可以**超过名义**
     （保证金率 > 100%）：现实中这是合法态（Aave 超额抵押 120–150%、Bybit IM Rate ≥ 100% 只是
     「不能再加仓」），本作语义也已自洽 —— `margin > notional` ⇒ `borrowedOf = 0`（停息、无强平线、
     `instrumentOf` 翻 perp），`effLevOf` 显示 < 1x 的真实值。`add` 因此只受**可用余额**约束。
     （旧拍板依据「Binance 杠杆档位下限 1x」—— 那是**杠杆档位选择器**的下限，不是逐仓保证金的
     天花板；往逐仓里继续塞钱不是「负杠杆档」，是超额抵押。） */
  const add = Math.max(0, spendableOf(s, mustUsdt));
  /* 减的下限：减完后**权益**（保证金 ＋ 未实现盈亏）仍要撑在维持线的 `PARTIAL_TARGET` 倍之上
     —— 与部分强平同一个目标倍数，留一道垫子，不许玩家把仓位减到「下一秒就爆」。
     权益口径与强平判据同源（`equityOf` / `maintRateOf`）⇒ 浮亏时能抽回的钱自然更少。 */
  const floorEquity = PARTIAL_TARGET * maintRateOf(pos) * pos.notional;
  const reduce = Math.max(0, Math.min(pos.margin, equityOf(pos, price) - floorEquity));
  return { pos, price, mustUsdt, add, reduce };
}

/**
 * **「调整保证金」的步进基数** = 本仓**开仓保证金**（= 名义价值 ÷ 杠杆）。
 *
 * 2026-10-05 用户拍板：交易页 ± 与弹层预设都以此为基数（每次 25% / 50% / 100%）。
 * ⚠️ 为什么**不**用「可用余额 / 可减上限」当基数：那个数**每点一次就缩水**（加完余额变少、减完权益变少），
 *    于是步长越点越小、永远到不了上限 —— 用户原话「只能一点一点加（分子太小）」。
 *    开仓保证金在仓位存续期内**恒定**（`adjustMargin` 明确不动 `notional` / `lev`），步长因此恒定，
 *    且与仓位规模成比例：任何杠杆下每次 ≈ 变动 `0.25 / 杠杆` 的保证金率（10x ⇒ 约 +2.5 个百分点）。
 * ⚠️ 部分强平会**等比例**削掉 `notional` ⇒ 基数随之缩小，仍与「剩下的仓位」成比例，符合预期。
 * @returns {number} 基数量（USDT）；无仓位 / 数据异常返回 0
 */
export function marginBaseOf(s, sym) {
  const pos = posOf(s, sym);
  if (!pos || !(pos.lev > 0)) return 0;
  return pos.notional / pos.lev;
}

/**
 * 一次调整要动的**金额** = 开仓保证金 × `frac`，并夹在 `[0, cap]` 之内（`cap` 是该方向的可调上限）。
 * 交易页 ± 传 `frac = 0.25`；弹层预设传 `0.25 / 0.5 / 1`。**两个入口共用这一处口径**，不分家。
 * @param {boolean} add true = 增加（用 `caps.add`）、false = 减少（用 `caps.reduce`）
 */
export function marginStepOf(s, sym, frac, add) {
  const c = marginCapsOf(s, sym);
  if (!c) return 0;
  const cap = add ? c.add : c.reduce;
  return Math.max(0, Math.min(marginBaseOf(s, sym) * frac, cap));
}

/**
 * **调整保证金校验** —— 纯判据，一个字节的状态都不改（与 `openCheck` / `closeCheck` 同纪律）。
 * @param {number} delta 正 = 增加、负 = 减少（USDT 计价）
 * @returns {{ok:false, why:string} | {ok:true, pos:object, add:boolean, amount:number, mustUsdt:boolean}}
 */
function adjustCheck(s, sym, delta) {
  if (s.over) return { ok: false, why: '本局已结束' };
  const c = marginCapsOf(s, sym);
  if (!c) return { ok: false, why: `${sym} 没有可调整的持仓` };
  const amount = Math.abs(delta);
  if (!(amount > 1e-9)) return { ok: false, why: '调整金额为 0' };
  if (delta > 0) {
    /* 超额抵押解锁（2026-10-09 用户拍板）：保证金可超过名义（保证金率 > 100%），上限只有
       可用余额 —— 不再有「1x 封顶」分支。`c.add` 已是 spendable，超了就给准话。 */
    if (amount > c.add + 1e-9) {
      return { ok: false, why: c.mustUsdt ? '合约保证金必须是 USDT ｜ 先在资产页把美元换成 U' : '可用余额不足' };
    }
    return { ok: true, pos: c.pos, add: true, amount, mustUsdt: c.mustUsdt };
  }
  if (!(c.reduce > 1e-9)) return { ok: false, why: '保证金率接近维持线 ｜ 不能再减' };
  if (amount > c.reduce + 1e-9) return { ok: false, why: `最多可减 ${fmtMoneyShort(c.reduce)}` };
  if (amount > c.pos.margin - 1e-9) return { ok: false, why: '保证金不能减到 0' };
  return { ok: true, pos: c.pos, add: false, amount, mustUsdt: c.mustUsdt };
}

/** 渲染层用的**纯判据**：这一笔保证金调得动吗（弹层里的预设键读它置灰）。 */
export const canAdjustMargin = (s, sym, delta) => adjustCheck(s, sym, delta).ok;

/**
 * **落账**：增加 / 减少某一条**逐仓**的保证金（OKX 式）。
 *
 *   · 增加：`debit` 从可用余额扣一块进 `pos.margin` ⇒ 名义 / 数量**不动**、保证金率上升、强平价推远。
 *   · 减少：把一块保证金退回可用余额 ⇒ 名义 / 数量不动、保证金率下降、强平价靠近。
 *   - 两者都**不改 `notional` / `size` / `entry`** —— 调整保证金不是加减仓，只挪垫子。
 *   - `pos.mix` 同步维护（加：并进扣款的两格构成；减：按 `amount / margin` 的比例退回两格）——
 *     `closeTrade` / `forceLiquidate` 都靠它「原路退回」，不维护就会把美元的仓位退成 U。
 *   - **不写 `s.lockI`、不推行情冲击**（纯资金腾挪、无成交）⇒ 与「下单一小时锁」无关。
 */
export function adjustMargin(s, sym, delta) {
  const c = adjustCheck(s, sym, delta);
  if (!c.ok) return { ok: false, why: c.why };
  const { pos, add, amount, mustUsdt } = c;
  /* ⚠️ 2026-10-05 审计修（口径分叉续）：改读**标记价** —— 与 `marginCapsOf`（弹层可减上限）、
     持仓条、强平判据同源。原来读 `exPrice`（最新价）⇒ 弹层按标记价显示「保证金率 X%」，
     点下去写出的日志却按最新价报另一个数（且 `mgCut` 统计的「浮盈中提取」判据同样偏了一档）。
     调保证金不动行情价 ⇒ 前后同一个价，读哪一个都自洽，但必须与估值口径一致。 */
  const price = exMarkPrice(s, sym, pos.ex);
  if (add) {
    const paid = debit(s, amount, mustUsdt);
    if (!paid) return { ok: false, why: mustUsdt ? '合约保证金必须是 USDT ｜ 先在资产页把美元换成 U' : '可用余额不足' };
    pos.margin += amount;
    pos.mix = { usd: pos.mix.usd + paid.usd, usdt: pos.mix.usdt + paid.usdt };
    s.stat.mgUp += 1;                                    // 统计（v32）：增加保证金次数
  } else {
    /* 滚仓（v32 严格口径）：只有**浮盈中**减保证金才算「提取浮盈」——亏钱时减只是止损，不计。
       `pnlOf` 与保证金无关（只看成交价 / 均价 / 数量），所以放在改动之前判定即可。 */
    if (price > 0 && pnlOf(pos, price) > 0) s.stat.mgCut += 1;
    /* 按「减掉的比例」等比例抽一块，原路退回两格 —— 与平仓 `credit` 同一口径。 */
    const ratio = amount / pos.margin;
    const back = { usd: pos.mix.usd * ratio, usdt: pos.mix.usdt * ratio };
    credit(s, pos.ex, amount, back);
    pos.margin -= amount;
    pos.mix = { usd: pos.mix.usd - back.usd, usdt: pos.mix.usdt - back.usdt };
    s.stat.mgDown += 1;                                  // 统计（v32）：减少保证金次数
  }
  pushLog(s, `${add ? '增加' : '减少'}保证金 ${sym}｜${fmtMoneyShort(amount)}｜保证金率 ${fmtRate(marginRateOf(pos, price))}`, 'info', 'trade');

  /* ⚠️ R2（2026-10-05 审计修 · 死区缺口）：调保证金是**纯资金腾挪、无成交** ⇒ 总量口径下
     权益不变（钱只是从「可用余额」挪进「保证金」或反过来），正常路径下这里**判不出破产**
     —— 留这一行是为了堵住边角：减少保证金走 `credit`（可能落到 `pos.ex` 那一本账），
     若仓位不在当前所，这笔钱不会进 `cashOf(s)`，权益当场少一截。不留这一行就是一条小时级死区。
     与 `closeTrade` 末尾同一条口径：返回值必须是 **`ok: true`**。 */
  checkRuin(s);
  return { ok: true };
}

/**
 * 平仓 / **减仓** —— 平掉**当前所选币**仓位的 `frac` 比例（2026-10-02 用户拍板：可分批卖出）。
 * 多仓下想平另一个币：先切到那个币的 Tab，再点平仓。
 *
 * ⚠️ **分摊口径**（`frac < 1`）：保证金 / 数量 / 名义 / 开仓费 / 两格构成（`pos.mix`）
 *     **一律按比例收走**，等价于「把这条仓位切成几份，只结算其中一份」。
 *     ⚠️ **不复用 `reducePosition`**：那是给**部分强平**用的（保证金不退、留在仓位里当垫子、
 *        强平价被推远），语义与「玩家主动离场、把钱拿出来」正好相反。
 * ⚠️ `pos.entry` 不动：按比例平仓不改变剩余那部分的加权均价。
 * ⚠️ 一批一批地减，每一笔各记一次胜负 —— 日志里报的仍是**这一笔自己的回合净额**。
 */
export function closeTrade(s, why = '手动', frac = 1) {
  const c = closeCheck(s, frac);
  if (!c.ok) return { ok: false, why: c.why };
  const { pos, otc, f, pk, feeRate, closeSize, notional, cost, fill, walk } = c;
  const sym = pos.sym;

  /* 这一笔自己的结算（比例口径）：
       毛盈亏 = (成交价 − 均价) × 本笔数量 × 方向
       平仓费 = 本笔名义（按成交价）× 费率
       返还   = 本笔保证金 + 毛盈亏 − 平仓费 */
  const sign = pos.side === 'long' ? 1 : -1;
  const pnl = (fill - pos.entry) * closeSize * sign;
  const fee = closeSize * fill * feeRate;
  const backMargin = pos.margin * f;
  const net = backMargin + pnl - fee;
  /* 平仓款**按 `pos.mix` 同比例退回两格**（v13 · 方案 §9.2 ③）——
     2013 年用美元开的仓，平掉回的还是美元：否则那家所会凭空空降一笔 USDT。 */
  credit(s, pos.ex, net, { usd: pos.mix.usd * f, usdt: pos.mix.usdt * f });
  /* **对手方结算**（方案 A · 2026-10-05）：玩家这一笔的**毛盈亏**由对手方池承担 ——
     `pnl > 0` ⇒ 池付出；`pnl < 0` ⇒ 池收入。取代改动前「credit 凭空造钱 / 亏损凭空销毁」。
     ⚠️ 只结算**毛盈亏**：手续费归交易所、保证金退回是玩家自己的抵押品，都不进池。 */
  settlePlayerPnl(s, sym, pnl);
  s.realized += pnl - fee;
  exCharge(s, fee);                     // 平仓手续费进交易所收入账（回流管道 · config.EXREV）
  if (otc) exCharge(s, notional * cost);   // OTC 溢价 = 柜台收入（`closeCheck` 的 notional 已是中间价口径 ⇒ 精确式恰为名义 × 点差）
  /* 交易统计（v21）：按**本笔回合净额**（毛盈亏 − 本笔分摊的开仓费 − 平仓费）分胜负 ——
     与日志里报的「净额」同一口径，所以玩家看到的「盈利」与档案里的「盈利笔数」对得上。
     ⚠️ 开仓费也要**按同一比例分摊**（全平时 `f = 1`，与旧口径逐位相同）。 */
  const openFee = (pos.openFee ?? 0) * f;
  if (pnl - openFee - fee > 0) s.stat.win += 1; else s.stat.loss += 1;
  if (otc) s.stat.otc += 1;               // v32：OTC 通道平仓 / 减仓同样计一笔 —— 称号「场外玩家」
  if (f < 1) s.stat.part += 1;            // v32：**分批**平仓（`frac < 1`）—— 称号「分批离场」
  const fills = otc ? 1 : walk.n;   // 笔数（C8-B1）：走簿实际吃满用了几档（同开仓口径）
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
  const fees = openFee + fee;
  const netRound = pnl - fees;
  /* 盈亏串前那枚 ▲/▼ 是**色盲第二通道**（B6-c · §7.6 的第四处）：日志正文本来就整段按
     `ok` / `bad` 上色，红绿色盲读不出「盈利」与「亏损」的色差 —— 符号是同一件事的形状版。
     它是纯文本（core 不认识 UI，不挂 `.sign` 伪元素），与「盈利 / 亏损」两个字面并存。 */
  const verdict = `${netRound >= 0 ? '盈利 ▲' : '亏损 ▼'} ${fmtMoneyShort(netRound)} · ${why}｜手续费 ${fmtMoneyShort(fees)}${tag}`;
  if (f >= 1) {
    pushLog(s, `平仓 ${sym} ${lvTagOf(pos)}｜${verdict}`, netRound >= 0 ? 'ok' : 'bad', 'trade');
    delete s.positions[sym];
  } else {
    /* 分批平仓那一条把**平仓的比例**写在脸上（`25%` / `50%`）—— 否则玩家分不清
       「刚才是卖了一半」还是「整条没了」。
       ⚠️ 2026-10-05 审计修：杠杆标记改走 `lvTagOf(pos)`（＝**实际杠杆** `effLevOf`），与全平分支
          （上面一行）、ADL（`adlPlayerReduce`）、部分强平（`liquidateAll`）四处同源 —— 原来这里读
          开仓冻结的 `pos.lev`，滚仓减保证金后同一条仓位在「分批」与「全平」会报出两个不同的倍数。 */
    pushLog(s, `平仓 ${sym} ${lvTagOf(pos)} ${Math.round(f * 100)}%｜${verdict}`, netRound >= 0 ? 'ok' : 'bad', 'trade');
    pos.size -= closeSize;
    pos.margin -= backMargin;
    pos.notional *= (1 - f);
    pos.openFee -= openFee;
    pos.mix = { usd: pos.mix.usd * (1 - f), usdt: pos.mix.usdt * (1 - f) };
  }

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
        写完必须 `invalidateSigma()` —— 平仓从此**会**改动它之后的 K 线。
     ⚠️ 分批减仓时，这一笔写的仍是**本笔名义**该有的位移（冲击按成交额走，不按仓位的比例）。 */
  if (!otc) {
    const d = pos.side === 'long' ? -1 : 1;
    /* 第 8 参 `walk.eaten`：平仓这一笔走簿吃掉的墙 —— 与开仓同一条精确耦合（2026-10-07）。 */
    pushFlow(s, sym, d, notional, SHOCK.closeGive, shockKindOf(isMargin(pos), pos.lev), true, walk.eaten);
    consumePool(s, sym, notional);        // 瞬时深度池（L1）：平仓同样是真实成交 ⇒ 也吃深度
  }
  /* 持仓抛压折价（v18 · 2026-10-01）：这一条仓位没了（`delete` 在上面）⇒ 折价随之释放。
     ⚠️ **只释放 `SHOCK.closeGive`**（v25 · 2026-10-02）：与上面那一笔回吐同一个比例，
        否则折价一次性归零会让「卖出之后比持仓时更贵」（见 `refreshOverhang` 的疤痕注释）。
     走上一步的**只有杠杆实物多头** —— 平掉一张合约仓时 `capturedOf` 本来就没变，函数内部会跳过。 */
  refreshOverhang(s, sym, SHOCK.closeGive);

  /* ⚠️ R1（2026-10-04 审计）：**平仓本身已经落账**（上面 `credit` / `pushLog` 全做完了），
     此处只行使「归零判定」的副作用（`checkRuin` 会写 `s.pending` 或 `s.over`）——
     返回值必须是 **`ok: true`**。原来把 `checkRuin` 的返回值当成平仓结果，于是「平仓成功
     ＋ 紧接破产」会被 UI 当成平仓**失败**报一条 `bad`（`main.js` 的 `if (!r.ok ...)`）。
     破产的收场交给时钟那一步（`advanceOneHour` 会再次 `checkRuin`），与这里不冲突。 */
  checkRuin(s);
  return { ok: true };
}

/**
 * 强平单个仓位。触发条件是**当根 K 线的高/低**打穿强平价。
 *
 * **结算口径（B20 · 2026-09-30 拍板「甲案」；2026-10-05 修正残余权益来源）**：不再是「保证金全部损失」，而是
 *   残余权益 = **触发价上的真实权益** `equityOf(pos, atPrice) = 保证金 + 未实现盈亏`（夹到 ≥ 0）
 *   清算费   = `名义 × feeRate`（**按工具分档**，2026-10-05：永续 0.5% / 杠杆 1.25% ⇒ 见 `config.LIQ`）
 *   **返还** = `max(0, 残余权益 − 清算费)`，按 `pos.mix` 比例打回该所账本
 * ⇒ 永续默认档（0.5% 维持线）下两者相等、返还为 0，**与 v13 逐位相同**；
 *   永续的高名义档（1% / 2.5%）与杠杆的 15% 档才会真的退还一点。
 * 账户其余部分原样保留 —— 多仓下它**不再直接等于破产**，是否收摊由调用方看总权益决定。
 * ⚠️ 返还**不产生负债**：清算费最多把残余权益吃到 0，绝不会向玩家追缴。
 *
 * ⚠️ **2026-10-05 修（凭空退款）**：残余权益原来写 `maintRateOf(pos) × notional`（「维持那一格」），
 *   它在**正常档**与真实权益恒等：`equityOf(pos, liquidationPrice(pos)) ≡ maintRateOf(pos) × notional`
 *   （把 `liquidationPrice` 的公式代进去展开即得）⇒ 触线即平时两种写法**逐位等价**。
 *   但一旦真实权益 ≤ 0（保证金被资金费抽干 / 跳空越过强平价 / `frac == 1` 的强打路径），
 *   「维持那一格」仍是个**正数** ⇒ 旧式会凭空退一笔钱给玩家、并给保险基金加一笔幻影钱
 *   （杠杆仓 `maint = 15%`、`LIQ.feeMargin = 1.25%` ⇒ 最多凭空退 ≈13.75% 名义）。
 *   改用真实权益后：权益 ≤ 0 ⇒ 残余 0 ⇒ 退款 0、保险基金不进幻影钱，穿仓缺口作坏账。
 * @param {number} atPrice 成交价（S3 起 ＝ **第一次穿越强平价那一 tick 的价**，不再是强平价本身）
 */
function forceLiquidate(s, pos, atPrice) {
  /* 残余权益 = 触发价上的**真实权益**（保证金 ＋ 未实现盈亏），不是「维持保证金那一格」——
     见本函数头注「2026-10-05 修（凭空退款）」。夹到 ≥ 0：负权益不得变成退款。 */
  const remain = Math.max(0, equityOf(pos, atPrice));
  /* 清算费按工具分档（2026-10-05 深度审计）：杠杆（有借入）1.25% / 永续 0.5% —— 见 config.LIQ。 */
  const feeRate = borrowedOf(pos) > 0 ? LIQ.feeMargin : LIQ.fee;
  const back = Math.max(0, remain - pos.notional * feeRate);
  /* 保险基金（v30 · 缺口 5 · 三级瀑布 ①）：这笔强平的**盈余**进池。
     口径：`盈余 = 残余权益 − 清算费`（若还没吃完）—— 即清算费中扣掉返还的那一份。
     ⚠️ `remain − back` = `min(remain, notional × feeRate)`：永续默认档（0.5% 维持线）下
        `remain = notional × 0.5%` 恰好等于清算费 ⇒ 全额进池、返还为 0（与变动前逐位相同）；
        永续高名义档（1% / 2.5%）与杠杆（15% 维持线）才有返还，那部分不进池。 */
  seedFund(s, pos.sym);
  s.fund += remain - back;
  const notional = pos.size * atPrice;                // 实际成交名义（强平价上的那笔量）
  /* 玩家自己的成交量（v17 · 2026-10-01）：强平也是一笔真实成交 ⇒ 记进当根 K 线的量柱。
     取 `size × atPrice`，与 `closeTrade` 同口径；产品线取**仓位自己**的那条（v20）。 */
  addPlayerVol(s, pos.sym, notional, pos.ex, isMargin(pos) ? 'margin' : 'fut');
  /* 订单冲击（2026-10-01 拍板）：强平同样是**卖出 / 买回**，写一笔与开仓方向相反的台阶 ——
     与 `closeTrade` 完全同一公式、同一方向（平多打压 −1、平空推高 +1），且同样**只回吐
     `SHOCK.closeGive`**（2026-10-02）：强平是「被动平仓」，若按满额反向写，玩家爆一次仓就能把
     自己此前所有买入留下的台阶一次性抹平。
     ⚠️ 强平多发生在**急跌那根**，这笔反向冲击会让兵败如山倒的 K 线更陡一档，是刻意的。 */
  {
    const dir = pos.side === 'long' ? -1 : 1;
    pushFlow(s, pos.sym, dir, notional, SHOCK.closeGive, shockKindOf(isMargin(pos), pos.lev));
    consumePool(s, pos.sym, notional);    // 瞬时深度池（L1）：强平也是真实成交 ⇒ 也吃深度
  }

  /* 串形与开仓 / 平仓对齐（2026-09-29）：`｜` 两侧不留白、金额走 `fmtMoneyShort`、
     价格走 `fmtLogPrice`（本轮 ② —— 原来这里是 `showPrice`，现在统一 ≥$1 一位小数）。
     ⚠️ 返还 > 0 时不能再说「全部损失」（B20）：那一格日志条是一行 nowrap，字数要省，
        所以只在真的有退款时才多带一段。
     ⚠️ 正文用「强平」而不是「爆仓」—— 这与标签 `'liq'`（`state.js` 映射为「强平」）一致：
        这里平掉的是**单笔仓位**（可发生多次、含部分强平 / ADL），「爆仓」只指账户归零的结局。 */
  pushLog(s, back > 1e-9
    ? `强平 ${pos.sym} ${lvTagOf(pos)}｜保证金 ${fmtMoneyShort(pos.margin)}｜退回 ${fmtMoneyShort(back)} @ ${fmtLogPrice(atPrice)}`
    : `强平 ${pos.sym} ${lvTagOf(pos)}｜保证金 ${fmtMoneyShort(pos.margin)} 全部损失 @ ${fmtLogPrice(atPrice)}`,
    'bad', 'liq');

  if (back > 1e-9) credit(s, pos.ex, back, pos.mix);   // 退回**当初开仓那家所**（原路：按 mix 比例分两格）
  /* 真实现金变动 = 丢掉保证金、收回退款。
     ⚠️ 保证金被资金费抽成**负值**时（`pos.margin < 0`），这里等于给 `s.realized` **加回**一小笔：
        那笔钱在 `settleFunding` 里已经逐小时从 `s.realized` 扣过（`s.realized -= fee`），
        但仓位根本没有那么多钱可扣 ⇒ 这里是**把多扣的那部分还原**，让 `s.realized` 与
        「开仓扣保证金 ＋ 逐小时费用 ＋ 退回」这条真实现金流**对得上**。不是凭空加分。 */
  s.realized -= pos.margin - back;
  /* 统计（2026-10-07 用户拍板 · 口径改为「强平事件」）：**同一笔仓位一局最多记 1 次**。
     部分强平早就把它记过的话（`pos.liqCounted`），整条打掉这一次不再重复计数 ——
     否则「缓跌十几档 → 最后整条爆掉」会变成十几笔，见 `state.js` 的 `stat.liq`。 */
  if (!pos.liqCounted) s.stat.liq += 1;
  /* §17.3（2026-10-04 审计收口）：玩家**自己**被强平的名义也计入 `liqNotional` —— 原来只统计 NPC 侧，
     于是「24h 清算强度」在玩家爆仓的时刻反而漏掉了他那一笔（口径不完整）。强平潮的**事件阈值**仍只看
     NPC 侧（`stampede` 里那个局部量），因为「爆仓潮」是市场级事件、不该被玩家单人引爆。 */
  s.stat.liqNotional += notional;
  /* tape（2026-10-08）：玩家自己被强平也是全市场可见的事实流（现实里 forceOrder 对所有人推送）
     ⇒ 照发爆多/爆空；玩家**主动**开/平则不进 tape（主日志已有）。
     2026-10-09：传 `minTier = 0` ⇒ 无论名义多小都上 tape（小仓在深市年代够不着 0.1% 阈值）。 */
  feedPush(s, pos.sym, pos.side === 'long' ? 4 : 5, atPrice, notional, 0);
  delete s.positions[pos.sym];
  refreshOverhang(s, pos.sym, SHOCK.closeGive);   // v25：爆掉的杠杆实物多头同 `closeGive` 比例释放折价
}

/**
 * 把「当前这一局」摊平成**一条档案记录**（M2 · 2026-10-01；2026-10-05 抽出为独立导出）。
 *
 * ⚠️ **为什么抽成导出**：结局弹窗（`render.js` 的 `renderOver`）要据此给**分档评语**
 *    （`titles.epitaphOf`），它与写进档案的那一条**必须是同一份数** ——
 *    两处各算一遍（尤其 `peak` 那条 `s.eq` 扫描）迟早漂。
 * ⚠️ 记录是**自洽的**（把展示要用的数都摊平存进去）—— 档案页因此不必回头翻那一局的存档，
 *    而存档在重开时已经没了。
 */
export function careerOf(s, reason) {
  let peak = equity(s);
  for (const v of s.eq) if (v > peak) peak = v;
  return {
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
    margin: s.stat.margin, fut: s.stat.fut, maxLev: s.stat.maxLev,
    move: s.stat.move, god: s.stat.god, loan: s.stat.loan,
    /* v32：滚仓 / 通道 / 分批三组行为信号（`titles.js` 的「滚仓玩家 / 滚仓狂人 / 场外玩家 / 分批离场」读它）。 */
    addOn: s.stat.addOn, mgUp: s.stat.mgUp, mgDown: s.stat.mgDown, mgCut: s.stat.mgCut,
    otc: s.stat.otc, part: s.stat.part,
    syms: Object.keys(s.stat.syms),
    /* M4：抽稀后的资金曲线（首尾必留）—— 分享卡拿它画那条线。 */
    eq: thinEq(s.eq),
  };
}

/**
 * **结算平仓**（2026-10-06 用户拍板）—— 走到终点 / 主动收摊时，把**所有**未平仓按标记价一并平掉。
 *
 * 为什么要这一步（用户原话：「游戏结束是否应该算平仓？如果玩家不操作直到时间结束，
 * 那么海报没有显示平仓次数」）：
 *   · 改动前 `endGame` 三条路径**都不动持仓**，而 `final`（`equity`）**把未平仓按标记价折算进去**
 *     ⇒ 那笔仓位「钱进了终值、却从没被平掉」：海报印「开仓 1 笔 · 平仓 0 笔」，统计里凭空消失。
 *   · 现实对齐：本作是**有时间终点的比赛**（`s.endI`）—— 交割合约到期按**结算价**强制平仓，
 *     交易比赛 / 模拟赛也在收官时**一律平掉所有持仓定榜**（永续那种「永远挂着」不是这个场景）。
 *
 * 口径（**刻意与玩家手动 `closeTrade` 不同**）：
 *   · 成交价取**标记价**（`exMarkPrice`，与 `equity` 同一个价）⇒ `final` 只会比改动前少一笔平仓费，
 *     不再引入滑点 / 冲击（局已结束，砸自己的盘口没有意义）；
 *   · **不计** `part` / `otc`（这不是玩家主动的分批 / 通道成交）；**要计** `win` / `loss`
 *     —— 这一回合确实以盈亏收尾，计上它，海报的「平仓 M 笔 / 胜率」才与「开仓 N 笔」自洽；
 *   · 平仓费照收（与手动平仓同一张表 `feeRateOf`）。
 *
 * ⚠️ 必须在 `recordCareer` **之前**调用：档案里的 `final` / `win` / `loss` 要吃到这一步的结果。
 * @param {string} why 日志前缀用的中文动作名（`结算平仓` / `收摊平仓`）
 * @returns {number} 实际平掉的仓位数
 */
function settleCloseAll(s, why) {
  let n = 0;
  for (const sym of heldSyms(s)) {
    const pos = s.positions[sym];
    if (!pos) continue;
    const p = exMarkPrice(s, sym, pos.ex);
    /* 取不到标记价时说不了盈亏 —— 按均价结算（零盈亏、零费），与 `equity` 取不到价时退回保证金的兜底同源。 */
    const fill = p == null ? pos.entry : p;
    const sign = pos.side === 'long' ? 1 : -1;
    const pnl = (fill - pos.entry) * pos.size * sign;
    const pk = isMargin(pos) ? 'margin' : 'fut';
    const fee = p == null ? 0
      : pos.size * fill * feeRateOf(pos.ex, timeOf(s), pk, vol30Of(s, pos.ex, s.i, pk));
    credit(s, pos.ex, pos.margin + pnl - fee, { usd: pos.mix.usd, usdt: pos.mix.usdt });
    settlePlayerPnl(s, sym, pnl);
    s.realized += pnl - fee;
    /* 胜负口径与 `closeTrade` 逐字一致：回合净额（毛盈亏 − 开仓费 − 平仓费）> 0 记胜。 */
    const netRound = pnl - (pos.openFee ?? 0) - fee;
    if (netRound > 0) s.stat.win += 1; else s.stat.loss += 1;
    pushLog(s, `${why} ${sym} ${lvTagOf(pos)}｜${netRound >= 0 ? '盈利 ▲' : '亏损 ▼'} ${fmtMoneyShort(netRound)}`,
      netRound >= 0 ? 'ok' : 'bad', 'trade');
    delete s.positions[sym];
    n += 1;
  }
  return n;
}

/**
 * 把这一局写进**交易档案**（M2 · 2026-10-01）。
 *
 * ⚠️ **幂等**：由 `endGame` 用 `!s.over` 把门 —— 本局只写一条。`rewindTo`（上帝跳日期）
 *    会把 `s.over` 清回 `null`，所以「结束 → 回退 → 再结束」会各写一条，这是对的：
 *    那是两次不同的结局，档案本来就该各记一笔。
 */
function recordCareer(s, reason) {
  addCareer(careerOf(s, reason));
}

function endGame(s, reason) {
  /* **结算平仓**（2026-10-06 用户拍板）：把还没平的仓位按标记价一并平掉 —— 见 `settleCloseAll`。
     ⚠️ 必须排在 `recordCareer` **之前**：档案的 `final` / `win` / `loss` 要吃到这一步的结果。
     ⚠️ 三条结局都走这一步（`SETTLED` 走到终点、`GAVEUP` 主动收摊、`LIQUIDATED` 爆仓后可能残留的
        尘埃仓）—— 对 `LIQUIDATED` 而言持仓多半已被强平打光，这里是个空循环，无害。 */
  settleCloseAll(s, reason === OVER.GAVEUP ? '收摊平仓' : '结算平仓');
  /* 交易档案（M2）：**本局只写一条** —— `s.over` 空着的时候才写，写完它才有值。 */
  if (!s.over) recordCareer(s, reason);
  s.over = { reason, at: s.i };
  s.paused = true;
  /* 清掉本局所在的槽（2026-10-04 用户拍板 · 用户原话「打完之后应该清除存档」）：
     已结束的局**不许**再被主菜单「读取存档」捞回来续玩。只清**这一局落在的那个槽**
     （普通 / 挑战各一半），另半边的档一个字不动。
     ⚠️ 这里**不能**用 `disableSave()`：`rewindTo`（上帝跳日期）会把 `s.over` 清回 null，
        那时 `save()` 必须能重新落盘；写侧那条「`s.over` 非空即跳过」的闸（`save.js`）才是正解。 */
  wipe(saveSlotOf(s.scen));
  /* 结算文案的日期跟着**本局自己的终点**走（§73.7）：挑战局 2–4 个月就收摊，
     再写死「2024-12-31」会与玩家刚经历的那一个月完全对不上。 */
  const text = reason === OVER.SETTLED
    ? `活到了 ${fmtDate(GAME.start + (s.endI - 1) * HOUR_MS, false)}，结算`
    : reason === OVER.GAVEUP ? '就此收摊 ｜ 本局结束'
    : `${ruinLabelOf(s)}，游戏结束`;
  pushLog(s, text, reason === OVER.SETTLED ? 'ok' : 'bad');
  return { ok: false, why: reason };
}

/**
 * 上帝模式「填入资金」的**记账部分** —— 把 `amount` **设定**为当前币种那一格的余额
 * （不是往上加，见方案 §2.3），并顺手清掉归零时留下的负账本。
 *
 * ⚠️ 为什么要清负账本（2026-09-30 裁决）：逐仓的浮亏与「1x 杠杆空单」的亏损是**无上限**
 *    写进账本的（`credit` 允许负额，见 `closeTrade`），普通玩法由 `isBankrupt` 终局接住，
 *    而上帝模式「归零不退出」会把它原样留在资产页（长局抽检实测最坏 −$74 万一格）。
 *    不清的话，玩家补完钱会发现净值仍是负的，且那一格**永远还不清**。
 *
 * ⚠️ 手动填入（面板那枚「填入」）与**自动补满**（`checkRuin` 的无限资金）**共用这一份** ——
 *    两边各写一遍这套记账必然漂移。
 */
export function godFillCash(s, amount) {
  for (const b of Object.values(s.books)) {
    if (b.usd < 0) b.usd = 0;
    if (b.usdt < 0) b.usdt = 0;
  }
  ensureBook(s)[cashCurAt(timeOf(s))] = amount;
  s.god.lastFill = amount;
  s.godRuined = false;        // 补上钱之后，下一次归零要能再提示一遍
}

/* ── 上帝操盘台（2026-10-07 用户拍板「上帝模式可以操纵市场，但要真实化」）────────────
 * 三枚动作全部走**既有市场物理**，没有「直接设价」通道（2026-09-29 删掉的 `scale`/`mult`
 * 不复活）—— 这就是「真实化」的落点：操纵服从市场物理，花钱、看深度、被硬夹。
 * 常数（`MANIP_MIN` / `MANIP_SPOOF_NUDGE`）在 `god.js`，动作在这里 —— 只有 engine 摸得到
 * `pushFlow` / 流动性 / 账本 / 热度这些内部件。
 * ⚠️ 调用点（main.js）负责 `s.god` 非空兜底；这里再拦一道（状态机不靠 DOM）。
 * ⚠️ 全部是**当前小时**的一次性动作：不新增任何逐小时状态、不升 `STATE_VERSION`。
 */

/**
 * 操盘台**预览**：吃单 `notional`（方向 `dir`）的预计位移 ＋ 预计花费 —— **与实际写值同式同参**：
 *   位移 = `sbOf.shock × dir × SHOCK.share × absorbedImpact(permImpactFor(…))`（`pushFlow` 同式，
 *   含压力位吸收 —— 同一时刻同一单，预览即实值）；花费 = 手续费 ＋ 冲击成本（`impactOf` 同式）。
 * ⚠️ 操盘台**不走走簿**（2026-10-07 拍板范围外）：上帝吃单是「搬动市场」的上帝视角动作，
 *    不是一笔挂在盘口上的市价单 —— 代价仍走连续式 `impactOf`。
 * 纯读：一个字节都不写（压力位 / 深度 / σ 都只读）。
 * @returns {{impact:number, cost:number, feeRate:number, sat:boolean}} `sat` = 本笔 `q` 已顶到深度上限
 */
export function manipPreview(s, sym, dir, notional) {
  const impact = sbOf(s).shock * dir * SHOCK.share * absorbedImpact(s, sym, dir, permImpactFor(s, sym, s.i, notional));
  const cap = godCapOf(s);
  const liq = hourLiqOf(s, sym, s.i);
  const q = liq > 0 ? notional / liq : 0;
  const feeRate = feeRateOf(s.ex, timeOf(s), 'fut', vol30Of(s, s.ex, s.i, 'fut'));
  /* `sat`：本笔 `q` 已顶到深度上限 ⇒ 再加钱位移不再涨（预览据此提示「深度不足」）。
     位移/花费两路传同一个 `cap`（普通 0.25 / 上帝 1.0）—— 与实际写值同式同参。 */
  return { impact, feeRate, cost: notional * (feeRate + impactOf(q, dailySigma(sym, s.i), cap)), sat: q >= cap };
}

/**
 * 操盘台「**吃单**」—— 一次真实的单向大单（真实 P&D 的推动阶段；实测平均 8 分钟拉完，
 * 小于本作一根小时线 ⇒ 单小时一次推完比「摊开 N 小时」更贴现实）。
 *
 * ⚠️ **不持仓**：纯花钱挪价 —— `pushFlow(…, give=1, 'fut', player=true)` 满额写位移
 *    （喂热度、吃硬夹、按幂律回吐，与真实成交完全同一条管线）；代价（双边中的一边手续费
 *    ＋ 冲击成本）从账本扣（`debit` 两格通道，与交易同一把尺子）。
 * @param {number} dir +1 拉 / −1 砸
 * @returns {{ok:true, impact:number, cost:number}|{ok:false, why:string}}
 */
export function godManipPush(s, sym, dir, notional) {
  if (!s.god) return { ok: false, why: '非上帝模式' };
  if (dir !== 1 && dir !== -1) return { ok: false, why: '方向非法' };
  if (!(Number.isFinite(notional) && notional >= MANIP_MIN)) {
    return { ok: false, why: `名义额至少 ${MANIP_MIN}` };
  }
  const p = manipPreview(s, sym, dir, notional);
  /* 「无限资金」开着 ⇒ 钱不够就**先补满再扣**（2026-10-07 用户报「按钮无效」的根因：
     操盘台的 `debit` 完全没理 `s.god.inf`，开着无限照样报资金不足）。
     补款额取 `max(lastFill, cost)` —— 账上可能填过比 lastFill 更大的数，往小补等于倒扣；
     `godFillCash` 会顺带把 lastFill 抬到补款额：无限资金下「补满目标」本就只是下限，无妨。 */
  if (!debit(s, p.cost)) {
    if (!(s.god.inf && s.god.lastFill > 0)) return { ok: false, why: '资金不足（吃单要付手续费＋冲击成本）' };
    godFillCash(s, Math.max(s.god.lastFill, p.cost));
    debit(s, p.cost);           // 补款额 ≥ cost ⇒ 必成功
  }
  pushFlow(s, sym, dir, notional, 1, 'fut', true);
  exCharge(s, notional * p.feeRate);   // 手续费部分进交易所收入账（冲击成本是价移不是收入 · config.EXREV）
  s.god.lastPush = notional;  // 面板记忆：下次打开操盘台预填这一笔（`god` 不进存档 ⇒ 会话级）
  return { ok: true, impact: p.impact, cost: p.cost };
}

/**
 * 操盘台「**洗售**」—— 等额对敲刷假量：**位移恒 0**（真实洗售「放量不推价」；引擎侧连
 * `s.flow` 都不写 —— 写两笔等额反向再归并成 0 纯属噪音），代价是**双边**手续费。
 * 收益是三样「假象」：量柱爆量（`addPlayerVol`，顺带费率阶梯 —— 现实刷量党的收益来源）、
 * 假量喂热度（`m.pv`，走既有 `HEAT.k3` —— 假量引散户跟风）。
 * @returns {{ok:true, fee:number}|{ok:false, why:string}}
 */
export function godManipWash(s, sym, notional) {
  if (!s.god) return { ok: false, why: '非上帝模式' };
  if (!(Number.isFinite(notional) && notional >= MANIP_MIN)) {
    return { ok: false, why: `名义额至少 ${MANIP_MIN}` };
  }
  const feeRate = feeRateOf(s.ex, timeOf(s), 'fut', vol30Of(s, s.ex, s.i, 'fut'));
  const fee = notional * feeRate * 2;
  /* 「无限资金」同吃单：钱不够先补满再扣（补款额 ≥ fee ⇒ 必成功），语义见 `godManipPush`。 */
  if (!debit(s, fee)) {
    if (!(s.god.inf && s.god.lastFill > 0)) return { ok: false, why: '资金不足（洗售要付双边手续费）' };
    godFillCash(s, Math.max(s.god.lastFill, fee));
    debit(s, fee);
  }
  addPlayerVol(s, sym, notional, s.ex, 'fut');
  exCharge(s, fee);                    // 洗售双边手续费全额进交易所收入账（回流管道 · config.EXREV）
  s.god.lastWash = notional;  // 面板记忆：同 `lastPush`（洗售框自己记自己的）
  /* 与 `pushFlow` 的 P1-2 同一条口径：假量只喂**当前币**的热度（`m.pv` 的结算在 tickMarket）。 */
  if (sym === s.sym) mktOf(s, sym).pv += notional;
  return { ok: true, fee };
}

/**
 * 操盘台「**幌骗**」—— 零成交、零手续费、零位移：只给该币热度一脚偏置
 * （真实幌骗「挂大假单伪造供需，成交前撤单」；游戏无订单簿 ⇒ 情绪层是最贴的代理）。
 * 消散不靠新状态：`HEAT.k2` 的均值回复把这一脚按热度自身记忆（≈14h）拉回靶心。
 * @param {number} dir +1 拉情绪 / −1 砸情绪
 * @returns {{ok:true}|{ok:false, why:string}}
 */
export function godManipSpoof(s, sym, dir) {
  if (!s.god) return { ok: false, why: '非上帝模式' };
  if (dir !== 1 && dir !== -1) return { ok: false, why: '方向非法' };
  const m = mktOf(s, sym);
  m.heat = clamp01(m.heat + dir * MANIP_SPOOF_NUDGE);
  return { ok: true };
}

/**
 * 操盘台「**拉盘 / 砸盘**」—— 一键组合拳（2026-10-08 用户拍板「晃骗＋洗售合并为拉盘与
 * 砸盘的按钮操作，贴合口径」）：按真实 P&D 的一条龙顺序依次执行 ——
 *   ① 幌骗挪情绪（免费，先造势）→ ② 洗售造量（小额双边费把热度放大器喂饱）→ ③ 吃单推价（大头）。
 *
 * 洗售配比 = `min(N, 本时深度)`（拍板）：热度放大器 `k3·min(pv,1)` 在假量 ≥ 本时实际深度
 * （`hourLiqBase`，含上帝深度旋钮 —— 与热度结算 `tickMarket` 同一条口径）时饱和，
 * 配到饱和即止 —— 多洗纯浪费双边费；吃单小就等额对敲（真实对敲即 1:1）。
 * 早期流动性低（深度 < `MANIP_MIN`）时取下限，保证洗售闸放行。
 *
 * ⚠️ 资金**预检**（`cashOf` 与 `debit` 同一面值口径）：总花费 = 吃单 cost ＋ 洗售双边费，
 *    不够（且非无限资金）就**一步都不动** —— 避免「造势钱花了、推动没钱」的半拉子状态。
 *    三步各自的内部闸再拦一道（预检过 ⇒ 理论不可达，兜底而已）。
 */
export function godManipPump(s, sym, dir, notional) {
  if (!s.god) return { ok: false, why: '非上帝模式' };
  if (dir !== 1 && dir !== -1) return { ok: false, why: '方向非法' };
  if (!(Number.isFinite(notional) && notional >= MANIP_MIN)) {
    return { ok: false, why: `名义额至少 ${MANIP_MIN}` };
  }
  const p = manipPreview(s, sym, dir, notional);
  const wash = Math.max(MANIP_MIN, Math.min(notional, hourLiqBase(s, sym, s.i)));
  const washFee = wash * feeRateOf(s.ex, timeOf(s), 'fut', vol30Of(s, s.ex, s.i, 'fut')) * 2;
  const total = p.cost + washFee;
  if (cashOf(s) + 1e-9 < total) {
    if (!(s.god.inf && s.god.lastFill > 0)) return { ok: false, why: '资金不足（拉盘 = 吃单花费 ＋ 洗售双边费）' };
    godFillCash(s, Math.max(s.god.lastFill, total));
  }
  godManipSpoof(s, sym, dir);   // ① 造势（免费）
  const ws = godManipWash(s, sym, wash);   // ② 造量
  const pu = godManipPush(s, sym, dir, notional);   // ③ 推动
  if (!pu.ok) return pu;
  return { ok: true, impact: pu.impact, cost: pu.cost + (ws.ok ? ws.fee : 0), wash: ws.ok ? wash : 0 };
}

/**
 * 操盘台「**扫单**」（2026-10-09 用户拍板「一键吃单开关」）—— 一口吃掉当前 NPC 簿某一侧的
 * **全部离散挂单**：真实巨鲸的「扫货」（market sweep / 吃穿盘口 —— 挂单被逐档吃掉、价格跳档）。
 *
 * 口径：
 *   · 名义 = `s.lob` 该侧离散单名义**求和**（含同格合并单；不含墙 —— 墙是 `levelsOf` 的
 *     历史价位标记，属于「隐含流动性」，不是可被吃掉的真实挂单）；
 *   · 执行走 `godManipPush` 全套物理（手续费进 `exRev` 回流管道、冲击进 `pushFlow`、
 *     热度喂饱、硬夹照吃）—— 扫单不是「直接改簿」，是**一笔吃穿全部挂单的市价单**；
 *   · 成功后**清空该侧离散单**（被吃掉了）—— `lobTick` 治理器下一根会照常回补新单（真实盘口
 *     被扫后做市商回填），所以「自动扫单」每根都有单可吃、形成持续买/卖压；
 *   · 簇空 / 未生成 ⇒ 返回 why（自动模式下 harmless no-op，开关不自动停 —— 下一根有新单）。
 * @param {number} dir +1 吃卖盘（拉）/ −1 吃买盘（砸）
 * @returns {{ok:true, ate:number, impact:number, cost:number}|{ok:false, why:string}}
 */
export function godEatBook(s, sym, dir) {
  if (!s.god) return { ok: false, why: '非上帝模式' };
  if (dir !== 1 && dir !== -1) return { ok: false, why: '方向非法' };
  const b = lobOf(s, sym);
  if (!b) return { ok: false, why: '订单簿尚未生成' };
  const arr = dir > 0 ? b.asks : b.bids;
  const sum = arr.reduce((a, r) => a + r.n, 0);
  if (!(sum > 0)) return { ok: false, why: '该侧没有挂单' };
  /* 浅簿专述（审查 Minor 2）：单侧合计够不到 `MANIP_MIN` 时，「名义额至少 1000」会让人
     困惑（明明是引擎自己算的名义）—— 给一句贴场景的准话。 */
  if (sum < MANIP_MIN) return { ok: false, why: `该侧挂单合计 ${fmtMoneyShort(sum)}，扫单至少 ${MANIP_MIN}` };
  const p = godManipPush(s, sym, dir, sum);
  if (!p.ok) return p;
  arr.length = 0;                     // 被扫空：离散单全部移除（做市商下一根回填）
  return { ok: true, ate: sum, impact: p.impact, cost: p.cost };
}

/**
 * 操盘台「**目标价**」（2026-10-09 用户拍板「目标涨幅档」）—— 把「拉/砸到 ±X%」翻译成名义额：
 * 数值**二分反解** `manipPreview` 本体（同式同参 —— 预览、实值、反解共用同一条冲击曲线），
 * 求出「瞬时位移 ≥ X%」所需名义，然后走 `godManipPush` 全套物理一次性推完。
 *
 * 口径：
 *   · 目标 = **相对当前价**再动 X%（叠加语义 —— 现有 `s.flow` 台阶不动，只算这一笔的增量）；
 *   · `manipPreview.impact` 随名义**单调**且在 `q ≥ cap` 处饱和 ⇒ 二分必收敛；饱和后仍达不到
 *     目标（深度太小 / σ 太小）时如实返回 `sat: true`（UI 提示「深度不足 · 已推到饱和」）——
 *     与拉盘预览的 `sat` 同一条口径，不假装推到了；
 *   · 名义上界探测从「本时深度 × 2」起每轮 ×4（早期小深度年代也能够到）。
 * @param {number} dir +1 拉 / −1 砸
 * @param {number} pct 目标幅度（0.01 = 1%）
 * @returns {{ok:true, n:number, impact:number, cost:number, sat:boolean}|{ok:false, why:string}}
 */
export function godTargetPush(s, sym, dir, pct) {
  if (!s.god) return { ok: false, why: '非上帝模式' };
  if (dir !== 1 && dir !== -1) return { ok: false, why: '方向非法' };
  const d = Math.min(0.25, Math.max(0.002, Math.abs(pct)));
  const cap = godCapOf(s);
  const liq = hourLiqOf(s, sym, s.i);
  const satN = liq > 0 ? cap * liq : Infinity;   // 饱和名义：q = cap 处 impact 顶死
  let lo = MANIP_MIN;
  let hi = Math.max(MANIP_MIN * 2, hourLiqBase(s, sym, s.i) * 2);
  if (hi > satN) hi = satN;
  for (let g = 0; g < 10 && hi < satN && manipPreview(s, sym, dir, hi).impact < d; g++) {
    hi = Math.min(satN, hi * 4);   // 审查 Important 1：撞到饱和名义就停探测 —— 超推部分纯烧手续费
  }
  for (let k = 0; k < 22; k++) {
    const mid = (lo + hi) / 2;
    if (manipPreview(s, sym, dir, mid).impact < d) lo = mid; else hi = mid;
  }
  const pv = manipPreview(s, sym, dir, hi);
  const r = godManipPush(s, sym, dir, hi);
  if (!r.ok) return r;
  return { ok: true, n: hi, impact: pv.impact, cost: pv.cost, sat: pv.impact < d * 0.999 };
}

/** 自动扫单的**伺服**（`advanceOneHour` 每根调，排在插针伺服之后）：`s.god.eat` 非空 ⇒
 *  每根把 `e.sym` 该侧簿吃光（方向随开关）。簿空 harmless no-op（下一根做市商回填）。
 *  费用照走 `godManipPush` → `exRev` 回流管道；无限资金开着则自动补款（同吃单）。 */
export function godEatTick(s) {
  const e = s.god && s.god.eat;
  if (!e) return;
  godEatBook(s, e.sym, e.dir);
}

/**
 * 自动新闻的**币种抽取**（2026-10-10 用户拍板「随机币种 ＋ 币种权重」）——
 * 权重 = 各已加载币**当日流动性**的**平方根**，叠加 5% 地板：
 *
 *   · **平方根平滑**：线性口径下 BTC 2021 的日流动性是 DOGE 的几十倍 ⇒ 小币几乎永不上新闻。
 *     `sqrt` 把 50:1 压到约 7:1 —— 仍是「大币常上头条」（现实口径：媒体覆盖率与市值/活跃度
 *     正相关，BTC/ETH 常年占绝大多数版面），但小币也有露脸机会（山寨币新闻确实是少数但存在）。
 *   · **5% 地板**：任何已加载币至少占 `0.05/n` 权重 ⇒ 刚上市的小币不会被完全饿死。
 *   · **只抽「此刻已上线」的币**（`c.unlock <= timeOf(s)` 且行情已加载）—— `s.mkt` 里可能
 *     残留**未上线**的币格子（`npcOtherTick` 对已加载币建格，而 `prefetchAllCoins` 会把 8 币
 *     全下下来 ⇒ 2013 年就有 XRP 格子）。不过滤就会播「XRP 还没上线却上新闻」的穿帮快讯
 *     （2026-10-10 用户报）。未上市币连行情都没有，播它读不出数。
 *   · 流动性取不到（交易日缺口 / 全 0）⇒ **等权兜底**（宁可平均，不因一个缺格把新闻卡死）。
 *   · 确定性：走 `randFast` 通道 `'autoNS'` ⇒ 同种子同小时同结果，断点续跑可复现。
 * ⚠️ 导出给审计 9as 直调（与 `exRevSweep` / `feedPush` 同一先例）—— 权重分布要能单独测。
 * @returns {string} 币符号（保证是「此刻已上线」的币；无币时退回 `s.sym`）
 */
export function autoNewsSym(s) {
  const t = timeOf(s);
  const syms = Object.keys(s.mkt || {}).filter(sym => {
    const c = coinOf(sym);
    return !!c && t >= c.unlock && isLoaded(sym);
  });
  if (!syms.length) return s.sym;
  if (syms.length === 1) return syms[0];
  const n = syms.length;
  const day = dayIndexOf(s.i);
  const w = syms.map(sym => {
    const liq = liqOf(sym, day);
    return liq > 0 ? Math.sqrt(liq) : 0;
  });
  const tot = w.reduce((a, b) => a + b, 0);
  const FLOOR = 0.05;
  const ww = tot > 0 ? w.map(x => FLOOR / n + (1 - FLOOR) * (x / tot)) : w.map(() => 1 / n);
  let r = randFast(s.seed, hashStr('autoNS'), s.i, 0, hashStr('news'));
  for (let i = 0; i < n; i++) { r -= ww[i]; if (r <= 0) return syms[i]; }
  return syms[n - 1];
}

/**
 * **自动化伺服**（2026-10-09 用户拍板「自动新闻三开关 ＋ 自动造量 ＋ 自动拉盘」）——
 * `advanceOneHour` 每根调一次（排在扫单伺服之后、NPC 刻度之前），三个子开关独立：
 *
 *   · **自动新闻**（`s.god.autoNews`）：0 = 好坏混合 / 1 = 纯利好 / −1 = 纯利空。
 *     到点（`s.god.autoNewsAt`）**按币种权重随机抽一个币**（`autoNewsSym`，见其头注）、
 *     随机取一条**当年代过门控**的模板播报（走 `godFakeNews` 全套：热度脚 ＋ 小额跟风 ＋ 播报），
 *     下次时刻 = 本根 ＋ **12~36h 随机**（`randFast` 确定性 —— 断点续跑可复现），
 *     天然大于 `MANIP_NEWS_CD`(8h) 冷却。
 *   · **自动拉盘**（`s.god.autoPump` = ±1）：每根一次组合拳（幌骗→洗售→吃单），
 *     名义 = `min(lastPush ?? 下限×10, 本时深度)`（与手动行同源，但**每根封顶在深度** ——
 *     真实 P&D 的 pump 阶段是连续数小时推，不是一小时跳完；见函数内注）。
 *   · **自动造量**（`s.god.autoWash`）：每根一次洗售，名义 = `min(lastWash ?? 下限×10, 本时深度)`
 *     （与组合拳的洗售配比同一条口径——喂饱热度放大器即止，多洗纯烧费）。
 *
 * **互斥裁决**（引擎层单点，UI 置灰与之同步）：
 *   插针伺服中（`s.god.pin`）全部跳过；自动拉盘开着 ⇒ 自动造量跳过（组合拳内已含洗售，
 *   双开等于同根双倍洗售费）；扫单（`s.god.eat`）与拉盘可并存（扫的是簿、推的是价，物理不重复）。
 * @returns {void}
 */
export function godAutoTick(s) {
  const g = s.god;
  if (!g) return;
  if (!g.pin && g.autoPump) {
    const sym = g.autoPumpSym ?? s.sym;
    /* ⚠️ **每根名义封顶在「本时深度」**（2026-10-10 性能 ＋ 口径修）：`lastPush` 是上一次
       手动「拉到 / 砸到」二分反解出来的名义（可能极大），直接每根照推会让价格一小时一跳、
       把级联风暴打成常态 —— 实测 2013 局 autoPump 把 `advanceOneHour` 从 0.04ms 拉到
       0.73ms/根，**且与名义额无关**（1e4 与 1e6 同价）⇒ 成本全在「推完之后的市场连锁反应」
       （级联 / 强平 / 热度重算），不在推这一笔本身（`godManipPump` 只 0.05ms）。
       封顶后 = 「一小时最多吃掉一小时的深度」：物理上再多也吃不下（与组合拳的洗售配比
       `min(N, 本时深度)` 同一条尺子），位移回到连续档、级联回到偶发。深度旋钮 ×N 会同比
       抬高这个上限（`hourLiqBase` 已含旋钮）。 */
    const n = Math.max(MANIP_MIN, Math.min(g.lastPush ?? MANIP_MIN * 10, hourLiqBase(s, sym, s.i)));
    godManipPump(s, sym, g.autoPump, n);
  }
  if (!g.pin && !g.autoPump && g.autoWash) {
    const deep = hourLiqBase(s, g.autoWashSym ?? s.sym, s.i);
    godManipWash(s, g.autoWashSym ?? s.sym, Math.max(MANIP_MIN, Math.min(g.lastWash ?? MANIP_MIN * 10, deep)));
  }
  /* ⚠️ `typeof === 'number'` 而不是真值判断（2026-10-10 测试抓到的真 bug）：`autoNews = 0`
     是**合法的「好坏混合」档**，用 `if (g.autoNews && …)` 会把 0 当「关」⇒ 混合档永不触发；
     用类型判断顺带挡住 UI 误传的 `false` / `undefined`（关闭态一律写 `null` 或 `delete`）。 */
  if (typeof g.autoNews === 'number' && (g.autoNewsAt ?? 0) <= s.i) {
    /* 币种按权重随机抽（2026-10-10）—— 抽到哪个币，新闻就播哪个币（%S 与读数都跟着它）。 */
    const sym = autoNewsSym(s);
    const dir = g.autoNews === 0 ? (randFast(s.seed, hashStr(sym), s.i, 0, 7) > 0.5 ? 1 : -1) : g.autoNews;
    godFakeNews(s, sym, dir);
    g.autoNewsAt = s.i + 12 + Math.floor(randFast(s.seed, hashStr('autoN'), s.i, 0, 11) * 25);   // 12~36h
  }
}

/* ── 插针剧本（2026-10-08 三批拍板③「插针剧本」）─────────────────────────────
 * 一键「吃穿最大的强平簇再回位」：真实庄家的猎杀剧本（hunt liquidations）。**没有「直接设价」
 * 通道** —— 推进完全复用操盘台的吃单物理（`godManipPush`：付手续费 ＋ 冲击成本、吃深度、
 * 被硬夹、可被 NPC 逆流顶住），每小时伺服一笔；状态机挂在 `s.god.pin`（`god` 不进存档
 * ⇒ 会话级，不升 `STATE_VERSION`），由 `advanceOneHour` 在本根成形前驱动（位移进本根 K 线，
 * `flushSlot` 用含位移的 `lastPrice` 判强平 ⇒ 推到位的那一根 NPC 真的爆）。
 * 簇检测与强平判定**逐位同源**：`godWatchOf.liqs` 的 price 就是 `flushSlot` 的
 * `longAvg×(1−drop)` / `shortAvg×(1+drop)` —— 针尖吃穿哪一簇，哪一簇就真的爆。 */

/**
 * 插针**启动**：找 `dir` 侧名义最大的强平簇（砸针 = 下方多头簇，拉针 = 上方空头簇），
 * 记下针尖（簇价越过 `MANIP_PIN.overshoot`）、锚定价（启动价）与名义额预算（本时深度 ×
 * `MANIP_PIN.maxN`），交给 `godPinTick` 逐小时伺服。
 * @param {number} dir −1 砸针（猎杀多头）/ +1 拉针（猎杀空头）
 * @returns {{ok:true, tip:number, cluster:number}|{ok:false, why:string}}
 */
export function godPinStart(s, sym, dir) {
  if (!s.god) return { ok: false, why: '非上帝模式' };
  if (dir !== 1 && dir !== -1) return { ok: false, why: '方向非法' };
  if (s.god.pin) return { ok: false, why: '插针进行中（先停）' };
  const cur = lastPrice(s, sym);
  const side = dir < 0 ? 'long' : 'short';
  let best = null;
  for (const l of godWatchOf(s, sym).liqs) {
    if (l.side !== side) continue;
    /* 只吃「前方」的簇：价格已经越过它的强平线的那一簇早该爆掉了（上一小时的 flushSlot
       已经处理），留着只会挑中一个身后不存在的目标。 */
    if (dir < 0 ? !(l.price < cur) : !(l.price > cur)) continue;
    if (!best || l.notional > best.notional) best = l;
  }
  if (!best) return { ok: false, why: dir < 0 ? '下方没有强平簇' : '上方没有强平簇' };
  const base = hourLiqBase(s, sym, s.i);
  if (!(base >= MANIP_MIN * 10)) return { ok: false, why: '本时深度不足' };
  s.god.pin = {
    sym, dir,
    tip: best.price * (1 + dir * MANIP_PIN.overshoot),
    anchor: cur,
    n: 0, h: 0, back: false,
  };
  return { ok: true, tip: s.god.pin.tip, cluster: best.notional };
}

/**
 * 插针**伺服**（`advanceOneHour` 每小时调用，排在本根 K 线成形之前）：
 *   · 推进段：每根朝 `pin.dir` 吃 `本时深度 × qStep`，价格越过针尖转回位段；
 *   · 回位段：反向吃到启动价 ±`backTol` 为止（长针的「针」就留在走过的这几根 K 线上）；
 *   · 预算 / 时长 / 资金任一越界 ⇒ 收场并播报（状态机自清，不留半死不活的挂起态）。
 * 爆仓潮本身**不在这里播报** —— `flushSlot` 的「爆仓潮」日志 ＋ tape k=4/k=5 就是那一声，
 * 这里再播就是「同一事件描述一局内出现两次」。 */
export function godPinTick(s) {
  const pin = s.god && s.god.pin;
  if (!pin) return;
  pin.h += 1;
  const cur = lastPrice(s, pin.sym);
  if (!pin.back && (pin.dir < 0 ? cur <= pin.tip : cur >= pin.tip)) {
    pin.back = true;
    pushLog(s, `插针 ｜ 已吃穿簇价，回位中`, 'sys');
  }
  const done = pin.back && Math.abs(cur / pin.anchor - 1) <= MANIP_PIN.backTol;
  if (done) {
    s.god.pin = null;
    pushLog(s, `插针 ｜ 回位完成 ${fmtLogPrice(cur)}`, 'ok');
    return;
  }
  const base = hourLiqBase(s, pin.sym, s.i);
  const q = Math.max(MANIP_MIN, MANIP_PIN.qStep * base);
  const r = godManipPush(s, pin.sym, pin.back ? -pin.dir : pin.dir, q);
  if (!r.ok) {
    s.god.pin = null;
    pushLog(s, `插针中止 ｜ ${r.why}`, 'bad');
    return;
  }
  pin.n += q;
  /* 预算上限与 q **同源取当前本时深度**（2026-10-09 修）：深度旋钮自动档随价移放大深度
     （×1~×8），预算若冻结在启动时刻，同样的 maxN=8 会在几根内被烧穿 —— 用户报
     「拉针动辄预算用尽」的主因。maxN × base ≈ 23 根推进余量的设计意图不变。
     两个上限**分开播报**：名义预算用尽 ≠ 时长用尽（旧版都报「预算用尽」，误导排查）。 */
  if (pin.n > MANIP_PIN.maxN * base) {
    s.god.pin = null;
    pushLog(s, `插针中止 ｜ 预算用尽，已停止`, 'bad');
    return;
  }
  if (pin.h > MANIP_PIN.maxH) {
    s.god.pin = null;
    pushLog(s, `插针中止 ｜ 时长用尽，已停止`, 'bad');
  }
}

/**
 * 插针**手动停止**（面板「停」）—— 状态机自清，已推进的部分不回滚（那些是真实花掉的钱
 * ＋ 真实发生的位移，与操盘台同一口径）。
 * @returns {{ok:true}|{ok:false, why:string}}
 */
export function godPinStop(s) {
  if (!s.god) return { ok: false, why: '非上帝模式' };
  if (!s.god.pin) return { ok: false, why: '没有进行中的插针' };
  s.god.pin = null;
  return { ok: true };
}

/* ═══════════ 新闻文案 · 数值绑定（2026-10-09 用户拍板「新闻里的数必须符合游戏实际数值」）═══════════
 * 病根：真实新闻的结果条（`anchors.rt`）与假新闻模板（`god.MANIP_NEWS`）里的数字都是**写死的史实**，
 * 与游戏内行情脱节 —— 玩家在上帝 / 普通 / 挑战局把某币拉涨 100%，新闻却仍报一个固定值。
 * 修法：模板改用**占位符**，数值一律从**此刻的 `s`** 现算（同一个 `newsVars` 出口，与操盘台读数同源）。
 *
 * ⚠️ **纯派生**：只读 `s`、不写 `s`、不碰 DOM、**不读 `Math.random` / `Date.now`** —— 否则破坏
 *    重放确定性（审计会咬）。所有取值**逐位来自 `closeAt`/`rawCloseAt`/`liqOf`/`fundingForecastOf`**。
 * ⚠️ 未上线币 / 缺 `s.mkt` / `rawCloseAt` 为 null **一律兜底**（`'--'` / `'—'`），绝不抛错。
 * ⚠️ 红线 A（不双重计价）一致：玩家自己的名义额不过 `gm` 闸；但 `%A` 是**市场**当日成交额，
 *    属「市场规模」类 ⇒ 与 `hourLiqBase` 同源，要过 `godLiqMulOf`。
 */

/**
 * 新闻模板占位符字典。键就是模板里要写的 `%X`；值一律是**此刻 `s` 的派生字符串**。
 *
 * | 键  | 含义 | 取值 |
 * |-----|------|------|
 * | `%S` | 币符号 | `sym` |
 * | `%L` | 现价 | `closeAt(sym, s.i)` → `fmtLogPrice`（含玩家 + NPC 位移） |
 * | `%C` / `%c` | 24h 涨跌幅（有符号 / 无符号） | `closeAt(i)/closeAt(i−24)−1` |
 * | `%M` / `%m` | 本次操盘位移（有符号 / 无符号） | `closeAt(i)/rawCloseAt(i)−1`（上帝局非零） |
 * | `%H` | 热度 | `s.mkt[sym].heat`（0–1 → 百分数） |
 * | `%A` | 当日成交额 | `liqOf(sym, dayIndexOf(i)) × godLiqMulOf` → `amtOf`（X 亿 / X 万） |
 * | `%R` | 预计资金费率 | `fundingForecastOf(s, sym).rate` → `fmtRate(·, 3)`；无 ⇒ `—` |
 * | `%V` | 触发阈值（仅真实结果条） | `lvl` ⇒ 价位 `r.v`；`mv` ⇒ 幅度 `r.pct` |
 * | `%D` | 事件隐含幅度（仅真实结果条，无符号） | `lvl` ⇒ `|r.v ÷ 事件前一日收盘 − 1|`；`mv` ⇒ `r.pct` |
 *
 * @param {object} s 状态
 * @param {string} sym 币符号（模板里 `%S` 的取值）
 * @param {{r?:object, at?:number}} [ctx] 真实结果条的规格与锚点时刻（假新闻不需要）
 * @returns {Record<string,string>} 占位符 → 字符串
 */
export function newsVars(s, sym, ctx = {}) {
  const r = ctx.r || null;
  const v = { '%S': sym };

  /* 现价（含位移）—— 与 `lastPrice` 同一口径 */
  const last = closeAt(sym, s.i);
  v['%L'] = Number.isFinite(last) ? fmtLogPrice(last) : '--';

  /* 24 小时涨跌幅 */
  const prev24 = closeAt(sym, s.i - 24);
  const chg = (Number.isFinite(last) && Number.isFinite(prev24) && prev24 > 0) ? last / prev24 - 1 : null;
  v['%C'] = chg == null ? '--' : fmtPct(chg);
  v['%c'] = chg == null ? '--' : fmtRate(Math.abs(chg));

  /* 本次操盘位移 = 位移后 ÷ 原始史实价（普通 / 挑战局恒 0 ⇒ `closeAt === rawCloseAt`） */
  const raw = rawCloseAt(sym, s.i);
  const disp = (Number.isFinite(raw) && raw > 0 && Number.isFinite(last)) ? last / raw - 1 : null;
  v['%M'] = disp == null ? '--' : fmtPct(disp);
  v['%m'] = disp == null ? '--' : fmtRate(Math.abs(disp));

  /* 热度（不吃 `mktOf` 的懒建副作用 —— 缺格直接兜底） */
  const m = s.mkt && s.mkt[sym];
  v['%H'] = m && Number.isFinite(m.heat) ? fmtRate(m.heat, 0) : '--';

  /* 当日成交额（市场规模类 ⇒ 过 `gm`，与 `hourLiqBase` 同源；非上帝局 `gm === 1` 逐位不变） */
  const liqDay = liqOf(sym, dayIndexOf(s.i));
  v['%A'] = liqDay > 0 ? amtOf(liqDay * godLiqMulOf(s, sym)) : '--';

  /* 预计资金费率（有符号；无合约 / 分不出多空比 ⇒ `—`） */
  const ff = fundingForecastOf(s, sym);
  v['%R'] = ff ? fmtRate(ff.rate, 3) : '—';

  /* 真实结果条的触发阈值与隐含幅度（假新闻不带 `ctx.r` ⇒ 保持兜底） */
  v['%V'] = '--';
  v['%D'] = '--';
  if (r && r.sym) {
    if (r.k === 'lvl') {
      v['%V'] = fmtLogPrice(r.v);
      const pc = closeAt(r.sym, (Number.isFinite(ctx.at) ? ctx.at : s.i) - 1);
      if (Number.isFinite(pc) && pc > 0) v['%D'] = fmtRate(Math.abs(r.v / pc - 1), 0);
    } else if (r.k === 'mv') {
      v['%V'] = fmtRate(r.pct, 0);
      v['%D'] = fmtRate(r.pct, 0);
    }
  }
  return v;
}

/**
 * 用 `newsVars` 的字典填模板里的占位符。**单遍** `replace`（不递归展开，避免值里含 `%` 时被二次解析）；
 * 字典里没有的占位符**原样保留**（`%v` 这类不存在的不会被吞掉），`tpl` 非字符串则原样返回。
 */
export function fillNews(tpl, vars) {
  if (typeof tpl !== 'string' || !vars) return tpl;
  return tpl.replace(/%[SLCMHARVDcmd]/g, mm => (vars[mm] == null ? mm : vars[mm]));
}

/**
 * 操盘台「**假消息**」—— 真实操纵三件套之一（SEC/CFTC 起诉书里的标准动作）。游戏内三件套：
 *   ① 热度一脚（`MANIP_NEWS_RANGE`，比幌骗大 —— 新闻是全市场广播，不是盘口假单）；
 *   ② 一笔小额真实吃单（`MANIP_NEWS_Q × 本时深度`，走 `pushFlow` 全额物理 —— 「信的人
 *      真的去买」；代价照付，无限资金同吃单先补后扣）；
 *   ③ 日志播报（`news` 金底芯片，与史实新闻同族；模板见 `god.MANIP_NEWS`）。
 * 确定性：**幅度**走 `randFast` 通道 `'news'`（同一存档同一小时同一条 —— 重放不漂移）。
 * ⚠️ **选条**改为逐方向**轮换计数**（`s.god.newsN`，2026-10-08 用户报「会重复显示新闻」）：
 *    每按一次取下一条、取满一整轮才回第一条 ⇒ 连按 16 次不重样；计数是会话级、不落盘。
 *    2026-10-09 起选条前先过**年代门控**（`manipTplsOf`）：早期年代只从「当时可能存在」的
 *    模板里轮换 —— 2013 年不会播「现货 ETF 净流入」这类穿帮快讯（`god.MANIP_NEWS` 头注）。
 * ⚠️ **冷却**（`MANIP_NEWS_CD`）：距上次成功注入不足 `MANIP_NEWS_CD` 小时就拒绝 ——
 *    公告连发既不真实也会刷屏（面板两枚按钮由 `render.js` 现算置灰）。
 * @param {number} dir +1 利好 / −1 利空
 * @returns {{ok:true, cost:number}|{ok:false, why:string}}
 */
export function godFakeNews(s, sym, dir) {
  if (!s.god) return { ok: false, why: '非上帝模式' };
  if (dir !== 1 && dir !== -1) return { ok: false, why: '方向非法' };
  /* 上线闸（2026-10-10 用户报「XRP 还没上线却出现 XRP 的新闻」）：手动 / 自动新闻都必须
     落在**已上线**的币上（与下单路径 `openOrder` 的门槛同源）。 */
  const coin = coinOf(sym);
  if (!coin || timeOf(s) < coin.unlock) return { ok: false, why: `${sym} 还没上线` };
  /* 冷却闸：`newsAt` 未写过 ⇒ `−Infinity` ⇒ 恒可发（旧局 / 首次点击逐位不变）。 */
  const last = Number.isFinite(s.god.newsAt) ? s.god.newsAt : -Infinity;
  const cd = s.i - last;
  if (cd < MANIP_NEWS_CD) return { ok: false, why: `冷却中（还需 ${MANIP_NEWS_CD - cd} 小时）` };
  const r1 = randFast(s.seed, hashStr(sym), s.i, 0, hashStr('news'));
  const key = dir > 0 ? 'good' : 'bad';
  /* 年代门控（2026-10-09 审计「假新闻年代口径」）：选条前按此刻过滤 —— 2013 年不会出现
     「现货 ETF 净流入」这类穿帮快讯；轮换计数在过滤后子序列上取模（跨年代边界跳条可接受）。 */
  const tpls = manipTplsOf(key, timeOf(s));
  const nudge = (MANIP_NEWS_RANGE.min + r1 * (MANIP_NEWS_RANGE.max - MANIP_NEWS_RANGE.min)) * dir;
  const notional = Math.max(MANIP_MIN, MANIP_NEWS_Q * hourLiqBase(s, sym, s.i));
  const p = manipPreview(s, sym, dir, notional);
  if (!debit(s, p.cost)) {
    if (!(s.god.inf && s.god.lastFill > 0)) return { ok: false, why: '资金不足（跟风单要付手续费＋冲击成本）' };
    godFillCash(s, Math.max(s.god.lastFill, p.cost));
    debit(s, p.cost);
  }
  pushFlow(s, sym, dir, notional, 1, 'fut', true);
  exCharge(s, notional * p.feeRate);   // 跟风单的手续费部分进交易所收入账（同 godManipPush · config.EXREV）
  mktOf(s, sym).heat = clamp01(mktOf(s, sym).heat + nudge);
  /* 轮换选条：取第 n 条、n+1 存档（坏值 / 缺键回 0）。 */
  if (!s.god.newsN) s.god.newsN = { good: 0, bad: 0 };
  const n = Number.isFinite(s.god.newsN[key]) ? s.god.newsN[key] : 0;
  s.god.newsN[key] = n + 1;
  s.god.newsAt = s.i;
  pushLog(s, fillNews(tpls[n % tpls.length], newsVars(s, sym)), dir > 0 ? 'ok' : 'bad', 'news');
  return { ok: true, cost: p.cost };
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
  /* ⚠️ 幂等闸（2026-10-05 审计修）：同一个小时里可能被**多次**调用（`settleFunding` 末尾、
     强平循环里、`liquidateAll` 末尾兜底）—— 本局一旦进了待决态（`pending`，时钟已停）或已收场，
     就直接返回，不再重复播报 / 重复结算（否则会出现两条一模一样的「可领救济金」日志）。 */
  if (s.pending || s.over) return false;
  if (!isBankrupt(s)) return false;

  /* 上帝模式：归零**不结束本局**（方案 §2.5）—— 时钟照走，玩家自己在面板里「填入资金」。
     ⚠️ 提示只写一次（`s.godRuined`），否则每根 K 线都会刷一条一模一样的日志。
     ⚠️「无限资金」（2026-10-07 用户拍板）开着就**当场补满**、不走上面那条提示 ——
        补满后余额 > 0 ⇒ 下一小时的 `isBankrupt` 自然为假，不会连刷。
        `lastFill ≤ 0`（玩家自己填过 0）时补满等于没补 ⇒ 退回普通提示，免得每小时刷一条。 */
  if (s.god) {
    if (s.god.inf && s.god.lastFill > 0) {
      godFillCash(s, s.god.lastFill);
      pushLog(s, `上帝模式 ｜ 无限资金，已补满 ${fmtMoney(s.god.lastFill)}`, 'ok');
      return false;
    }
    if (!s.godRuined) {
      s.godRuined = true;
      pushLog(s, '上帝模式 ｜ 账户归零，不结束本局', 'bad');
    }
    return false;
  }

  /* 挑战模式（年代开局）**不发救济金**（用户 2026-10-01 拍板）—— 归零即终局。
     理由：年代与本金都是玩家自己挑的，再发一笔 $1,000 等于把挑战抹平 ——
     「10U 战神」那一局领一次就是**暴赚 100 倍**，破产反倒成了正收益。
     ⚠️ 必须排在 `s.loaned` 之前：挑战局连遮罩都不弹，直接结束。 */
  if (isChallenge(s.scen)) {
    endGame(s, OVER.LIQUIDATED);
    return true;
  }

  if (!s.loaned) {
    s.pending = 'loan';
    s.paused = true;
    pushLog(s, `${ruinLabelOf(s)} ｜ 可领 ${fmtMoney(loanAmountAt())} 救济金`, 'bad');
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
 *     ⚠️ **换汇这一刻不结账**（缺口 2 · 2026-10-08）：按当根汇率进出 ⇒ 价差为 0，账目天然守恒。
 *        折价买入的收益要靠**持有到回锚**才能兑现（`markUsdt` 逐小时结），溢价买入的亏损同理
 *        —— 这是史实里那笔套利真正需要承担的风险（旧实现买入即锁定收益，不需要持有、无风险）。
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
  /* ⚠️ 这里**不再**结 `s.realized`（P0-1 那一行已于缺口 2 删除）：`equity` 现在按市值重估现金
     ⇒ 换汇当下的价差天然为 0（花 $80 换来的 U 立刻只值 $80），折价/溢价的盈亏改由
     `markUsdt` 在**持有期**逐小时结账。于是「靠折价买 U 把权益抬回门槛之上」那条规避破产的
     路依然堵着，而「买便宜 U 换回锚」这笔真实套利**必须承担持有风险**才算数。 */
  /* 日志把**汇率**写出来（而不是只报两个金额）：玩家要能看出这一笔是赚了还是亏了 ——
     0.900 时买 U 是捡便宜、1.050 时是挨宰，那正是这个机制的全部意义。 */
  pushLog(s, `买入 USDT ${fmtMoney(got)}｜1 USDT = $${price.toFixed(3)}｜花费 ${fmtMoney(usd)}`, 'info', 'trade');

  /* ⚠️ R2（2026-10-05 审计修 · 死区缺口）—— **缺口 2（2026-10-08）后它从「修缺口」降级为「保险」**：
     市值口径下换汇本身不产生价差（花 $100 换来的 U 立刻只值 $100），所以买 U **不再**当场改变权益，
     当初那个「溢价买入 ⇒ 掉到 `ruinFloorOf` 之下却不判」的时级死区已随 `equity` 的重估消失。
     仍然保留这一判：`buyUsdt` 是玩家主动动账的入口之一，将来任何口径再变，都不该在这里重新长出死区
     —— 代价只是一次 `equity` 比较，返回值口径同 `closeTrade` 末尾（买 U 已落账 ⇒ `ok: true`）。 */
  checkRuin(s);
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
 * ⚠️ 第⑤条的年代划分（`TRANSFER_RAILS`）：2013-01～2014-10-05 是**银行电汇**（不来链上、
 *    固定 $20 定额费、2–10 天到账、**不吃拥堵**）；2014-10-06 起依次是 Omni / ERC-20 / TRC-20
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
  if (heldSyms(s).length) return { ok: false, why: '有持仓 ｜ 先平仓再换所' };
  if (s.transfer) return { ok: false, why: '上一笔转账还没到账' };

  const from = s.ex;
  /* 搬的是**哪一格的钱**由年代定（v13 · 方案 §2.3）：电汇时代搬美元、链上时代搬 U。
     ⚠️ 它和「走哪条通道」是**同一件事的两种说法**（`cashCurAt` 与 `TRANSFER_RAILS` 的分界点
        是同一个 2014-10-06），所以不给玩家选（LESS IS MORE）—— 那年头手上根本没有 U。
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
  exCharge(s, fee);                                    // 转账费进交易所收入账（回流管道 · config.EXREV）
  s.ex = id;                                           // 人已经在新所，钱还在路上
  normalizeLeverage(s);                                // 新所的上限可能更低，夹取一次

  /* 只有**走链**的转账才推高拥堵 —— 银行电汇与链无关，`hours != null` 的就是 wire。 */
  const add = rail.hours ? 0 : bumpPulse(s, send);     // > 当日 BTC 流动性的 10% 才算大额
  const eta = rail.hours ? `${Math.round(n / 24)} 天后到账` : `${n} 小时后到账`;
  pushLog(s, `转账 → ${ex.name}｜${fmtMoneyShort(send)}｜${rail.label} · ${eta}｜手续费 ${fmtMoneyShort(fee)}`
    + (add ? `｜推高拥堵 +${add.toFixed(1)}` : ''), 'info', 'trade');
  s.stat.move += 1;                                    // 统计（v21）：称号「搬家达人」读它

  /* ⚠️ R2（2026-10-05 审计修 · 死区缺口）：换所**当场**就动了权益 —— 手续费立刻扣掉（上行
     `s.realized -= fee`），且 `s.ex` 已经切到新所（`equity` 只算**当前所**的账）⇒ 权益当场变。
     玩家若把余额搬到只剩手续费那么多，转账后新所可用余额接近 0 ⇒ 掉到 `ruinFloorOf` 之下。
     不在这里判，就有「钱已经不够开下一单、却还能继续操作」的小时级死区。
     ⚠️ 与 `closeTrade` 末尾同一条口径：返回值必须是 **`ok: true`**（转账已经发起）。
     ⚠️ 这里**不会**把「钱留在旧所」的那种换所误判 —— 门槛看的是**新所**此刻开最小一单要多少，
        正是玩家真正要面对的那个数（旧所那笔钱要等下一笔转账才搬得回来）。 */
  checkRuin(s);
  return { ok: true };
}

/**
 * 交易所归零。到点那一刻所内余额清零，**挂在该所的仓位全部作废**（保证金全损）。
 * 多仓下只作废 `pos.ex` 等于这家所的那些 —— 挂在别处的仓位不受牵连（虽然换所要求先全平，
 * 所以正常情况下不可能有仓位挂在别处，这个判据是最后一道防线）。
 *
 * ⚠️ **在途的转账不受影响**（P2-A 陷阱②）：那笔钱已经离开 `books`、正躺在链上。
 *    实现上无需额外处理 —— 但**这个效果是刻意的**：交易所归零前一根发起转账仍然救得回来，
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
    /* 统计（2026-10-06 用户拍板 · 补漏）：这家所把仓位一起带走了 —— 这一回合以**全损**收尾，
       原来不记任何一笔 ⇒ 仓位在统计里凭空蒸发。记一笔 `loss`（与「平仓」口径对齐：
       开仓计过一笔、终结就该计一笔），它让海报的「平仓 M 笔 / 胜率」与「开仓 N 笔」自洽。 */
    s.stat.loss += 1;
    refreshOverhang(s, sym);        // v18：被这家所一起带走的杠杆实物多头，折价随之归零
  }
  if (margin) s.realized -= margin;

  const hit = lost + margin;
  pushLog(s, hit > 0 ? `${ex.name} 归零 ｜ 损失 ${fmtMoney(hit)}` : `${ex.name} 归零`,
    hit > 0 ? 'bad' : 'info', 'mkt');

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
     只要玩家在 2016-08-02 之前没去过 Bitfinex（例如某家所归零后直接搬去 BitMEX），
     到点整个游戏就崩 —— 2026-10-01 平衡性模拟里实测复现。 */
  const book = ensureBook(s, ex.id);
  const lost = (book.usd + book.usdt) * ex.hack.cut;
  book.usd *= 1 - ex.hack.cut;
  book.usdt *= 1 - ex.hack.cut;
  s.realized -= lost;

  pushLog(s, lost > 0
    ? `${ex.name} 被盗 ｜ 普损 ${fmtRate(ex.hack.cut, 3)} 损失 ${fmtMoney(lost)}`
    : `${ex.name} 被盗 ｜ 普损 ${fmtRate(ex.hack.cut, 3)}`,
    lost > 0 ? 'bad' : 'info', 'mkt');

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
  pushLog(s, `领取救济金 ${fmtMoney(amount)} ｜ 不用还`, 'info', 'trade');
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
 * 顺序很关键：**先结算资金费 → 再看新高/新低判强平 → 最后才看收盘** ——
 * 同一根里先发生的多半是坏消息（资金费在整点先扣，价格随这一根走）。
 * 多仓下每个仓位各自判定；**单仓强平不等于本局结束**，总权益归零（爆仓）才结束（GDD §10）。
 */
export function advanceOneHour(s) {
  /* ⚠️ `s.pending`（B30 待领救济金决策）也必须挡住：时钟那边虽然会因 `s.paused` 停下，
     但**同一次 `step()` 的 while 循环**里 `paused` 是刚被置上的，循环不会自己知道。
     没有这一行，`s.i += 1` 会继续跑，玩家在遮罩上犹豫的那一拍就白白流走几十个小时。 */
  if (s.over || s.pending || (s.god && s.god.ended)) return;
  s.i += 1;

  /* 本局终点（§73.7）：经典全程 = `GAME.candles`（与改动前逐位相同），挑战局 = `s.endI`。
     ⚠️ **上帝模式不结算**（2026-10-09 用户拍板「不结算 / 不档案 / 不海报」）：走到终点只把
        `s.god.ended` 立起来 ＋ 时钟停住（`s.paused`），**不调 `endGame`** ⇒ 不 `settleCloseAll` /
        不 `recordCareer` / 不 `wipe`，`s.over` 保持 `null`。`main.js` 见 `s.god.ended` 弹「返回主菜单」
        遮罩；交易 / 资产 / 设置三页仍可看（只读），任何「继续」都被拦回该遮罩。 */
  if (s.i >= s.endI) {
    s.i = s.endI - 1;
    if (s.god) {
      s.god.ended = true;
      s.paused = true;
      pushLog(s, '上帝模式 ｜ 已走完全程，返回主菜单', 'info', 'mkt');
      return;
    }
    endGame(s, OVER.SETTLED);
    return;
  }

  /* 持有期市值重估的小时结账（缺口 2 · 2026-10-08）：把本根汇率变动对「手上 U」的美元价差
     先结进 `s.realized`，本根之内后续的行情与成交再跑 —— 顺序见 `markUsdt` 的注释。 */
  markUsdt(s, s.i);

  /* 暂停下单的锁**解开**（§73.8）：走满 1 游戏小时即可再下一笔。 */
  if (s.lockI >= 0 && s.i > s.lockI) s.lockI = -1;

  // ── P2-A：在途转账到账 ＋ 玩家脉冲衰减 ──
  // ⚠️ **到账检查必须排在交易所归零之前**：钱已经在链上，不归任何一家所管。若排在归零之后，
  //    「归零那一刻正好到账」的钱会落进一个已经清零的账本、反而活下来，那是个漏洞。
  if (s.transfer && s.i >= s.transfer.arriveAt) {
    const tr = s.transfer;
    /* 进**当初搬的那一格**（v13 · 方案 §9.2 ①）：2013 年电汇搬的是美元，2014-11 后链上搬的是 U。
       少了这一条，那家所会凭空到账一笔 2013 年根本不存在的 USDT。 */
    ensureBook(s, tr.to)[tr.cur] += tr.amount;
    s.transfer = null;
    const to = exchangeOf(tr.to);
    pushLog(s, `到账 ${to ? to.name : tr.to} ｜ ${fmtMoney(tr.amount)}`, 'ok', 'trade');
  }
  decayPulse(s);

  /* 持仓抛压折价**按日重算**（v19 · 2026-10-01）：流通量逐年增长 ⇒ **同样的持仓占比在缩小**，
     折价该跟着退坡。只在**跨日那一根**刷新（每 24 根一次），不逐根刷 —— 逐根会把 σ 缓存冲烂。
     ⚠️ 台阶只影响 `at` 之后的 K 线 ⇒ 按日刷新**不会**重标定历史（与 `s.flow` 逐根约束同一纪律）。 */
  if (s.i % HOURS_PER_DAY === 0) for (const sym of heldSyms(s)) refreshOverhang(s, sym);

  // 交易所归零（由 `EXCHANGES[].close` 触发）：提前 7 天预警，到点余额清零、该所仓位作废。
  // 预警只在「玩家此刻就待在那家所」时出现 —— 已经搬走的人不需要被吓一跳。
  // ⚠️ 上帝模式「新闻源与事件」关（`eventsOff`，2026-10-09）⇒ 整段跳过（当前档 `close` 全 null，
  //    本路径本就是死代码 —— 同闸是防御性的：将来补史实闭所日时，上帝关事件也不会被归零吞钱）。
  const t = timeOf(s);
  if (!eventsOff(s)) for (const ex of EXCHANGES) {
    if (ex.close == null) continue;
    if (t === ex.close - WARN_LEAD && s.ex === ex.id) {
      pushLog(s, `${ex.name} 提现异常，7 天后将停止一切交易`, 'bad', 'mkt');
    }
    if (t === ex.close && collapseExchange(s, ex)) return;
  }

  // 被盗削减（B21 · Bitfinex 2016-08-02）：只削该所余额，不归零、不作废仓位。
  // ⚠️ 同受「新闻源与事件」总闸（2026-10-09）：史实普损也是一笔真实的利空事件注入。
  if (!eventsOff(s)) for (const ex of EXCHANGES) {
    if (ex.hack && t === ex.hack.at && applyHackCut(s, ex)) return;
  }

  /* ═══════════ 历史时刻入日志（本轮 · 用户 2026-09-30 拍板「新闻也要写入日志串」）═══════════
     下面三类都是**一局内只说一次**的历史时刻，一律用 `===` 判等（同交易所归零预警的写法），
     天然只命中一次，不需要任何「已播过」状态位。
     ⚠️ 顺序即日志条的**先后**：`pushLog` 把最新的插在队首，同一个小时里最后写的那句才是
        日志条上显示的那句。新闻放在最前 —— 它是个 24 小时的「填充态」，该让位给同一小时里
        更具体的事件（与 P2-C「新闻让位于更新的日志」同一条口径）。 */
  /* ⚠️ 上帝模式「新闻源与事件」（2026-10-08 起，2026-10-09 扩容，`s.god.noRealNews` 默认 true）
     ⇒ 下面 4 条真实新闻的日志**一律不播**，配合 `extFlow` 归零一起让价格与播报都只随玩家操作走。
     普通局 / 挑战局无 `s.god` ⇒ 闸门不生效，逐位不变。 */
  if (!eventsOff(s)) {
    const news = newsStartAt(s.i);
    if (news) pushLog(s, news.title, 'news');
    /* **第二条 · 结果**（2026-10-01 拍板）：第一条只讲事件、不带数字；数字全部由这里给，
       且**必然在它真的发生之后 1 小时**才播（判定与窗口口径见 `anchors.resultNewsStartAt`）。
       ⚠️ 同一个小时里两条都命中时，后 push 的结果条压在事件条上面 —— 那是对的：
          「结果」永远比「起因」更值得占着日志条那一行。 */
    const rnews = resultNewsStartAt(s);
    if (rnews) pushLog(s, fillNews(rnews.rt, newsVars(s, rnews.r.sym || s.sym, { r: rnews.r, at: rnews.at })), 'news');

    /* **外部买盘的两条披露播报**（缺口 4 / 缺口 5 · 2026-10-08）：
       · 巨鲸/机构：命中披露日那根小时播一条（买卖都含），摊平窗口与靶心注入同一个表（`whaleFlowAt`）；
       · 现货 ETF：每月 1 日播上月 BTC/ETH 净额（月初才拿得到月报）。
       两者都用 `===` / 日号判等，一局内天然只说一次，不需要状态位。 */
    const wnews = whaleNewsAt(s.i);
    if (wnews) pushLog(s, wnews, 'news', 'mkt');
    const enews = etfNewsAt(s.i);
    if (enews) pushLog(s, enews, 'news', 'mkt');
  }

  for (const ex of EXCHANGES) {
    /* 开张：只报「开局之后才开」的所 —— Bitfinex 在 2013-01-01 就在，
       `s.i` 那根永远不会等于 0（`advanceOneHour` 先自增），开局界面因此天然干净。 */
    if (ex.open > GAME.start && t === ex.open) pushLog(s, `${ex.name} 上线 ｜ 可在此交易`, 'ok');
    // 停机维护（B24 · BitMEX 2020-03-13）：窗口内**只平不开**。
    // ⚠️ 受「新闻源与事件」总闸（2026-10-09）：停机是一条史实利空事件 ⇒ 上帝关事件时不播不限。
    if (!eventsOff(s)) for (const h of ex.halts || []) {
      if (t === h.from) pushLog(s, `${ex.name} 停机维护 ｜ 只能平仓，不能开仓`, 'bad', 'mkt');
      if (t === h.to) pushLog(s, `${ex.name} 恢复交易`, 'ok');
    }
    /* 杠杆阶梯：**首档 > 1x** 才叫「这类杠杆上线」（1x 是最低档、不算上线，不播）；
       其后每一档都是「上限调整」。BitMEX / Binance 的杠杆首档是 1x ⇒ 只在开张时取到。 */
    for (const [steps, label] of [[ex.marginSteps, '杠杆'], [ex.futSteps, '合约']]) {
      if (!steps) continue;
      steps.forEach((st, k) => {
        if (t !== st.from) return;
        if (k > 0) pushLog(s, `${ex.name} ${label}上限调整为 ${st.max}x`, 'info');
        else if (st.max > 1) pushLog(s, `${ex.name} ${label}上线 ｜ 最高 ${st.max}x`, 'ok');
      });
    }
  }

  // 币种上线（BTC 的 `unlock` 是回溯段、**早于开局**，索引为负 ⇒ 永不命中）
  for (const c of COINS) {
    if (Math.round((c.unlock - GAME.start) / HOUR_MS) === s.i) {
      pushLog(s, `${c.name} ${c.sym} 上线 ｜ 可交易`, 'ok');
    }
  }

  // Tether 上线（2014-10-06）：资产页那块「买 U」从这一根 K 线起才存在
  if (t === USDT_LIVE) pushLog(s, 'USDT 上线 ｜ 资产页可买入', 'ok');

  /* 通道自动回退（§15.3）：玩家选了 OTC，但权益跌破门槛 / 换到了还没开通 OTC 的币时，
     `chanOf` 会**悄悄**退回盘口。它是个**持久状态**（不是某一根的时刻），没有 `===` 可判，
     所以用 `s.otcOff` 闩锁 —— **一次跌落只报一条**（用户 2026-09-30 明确「重复的都要消除」）。
     ⚠️ 为什么不是「日志里已经有这句话」那种闩锁：那句话会被 60 条新日志顶出 `s.log`，
        条件仍成立时会再报一次 —— 正是用户要求消除的那种重复。
     ⚠️ 回到「OTC 可用」或「玩家自己切回盘口」时**解除闩锁**，这样下一次真的跌落还能再报一次。 */
  if (chanChoiceOf(s) === 'otc' && chanOf(s) === 'book') {
    if (!s.otcOff) { s.otcOff = true; pushLog(s, OTC_OFF, 'bad', 'mkt'); }
    /* ⚠️ 2026-10-05（逐币记忆）：这里**不再**把玩家的选择复位成 `'book'`。
       旧实现（2026-10-04 F4）会把全局 `s.chan` 复位成盘口，本意是清掉「选了 OTC 却生效盘口」的残留态；
       但它复位的是一份**全局**状态 ⇒ 「BTC 选 OTC → 切到还没开通 OTC 的币 → 切回 BTC」时
       玩家的选择被那次复位抹掉，回到 BTC 也不再记得 OTC（玩家实测反馈的正是这条）。
       现在「选择」按币存在 `chanBy` 里（`chanChoiceOf` 读它），回退**只影响此刻生效值**：
       换到开通了 OTC 的币、或权益涨回门槛之上，`chanOf` 自动恢复 OTC；玩家自己切回盘口则由
       `onChan` 改写偏好。闩锁仍只负责「一次跌落报一条」，与选择互不干扰。 */
  } else if (s.otcOff) {
    s.otcOff = false;
  }

  /* 破产预警（v11 · ③）：会**直接弄死人**（交易所归零）或**重创杠杆仓**（大级别崩盘）的历史事件，
     提前 7 天（`anchors.WARN_LEAD_HOURS`）弹遮罩 ＋ 暂停，给玩家挪仓 / 降杠杆的准备时间。
     ⚠️ **只有新手提示开着才打断**（`s.hintOn`）—— 老手在开场选了「我是老手」，自己扛。
        但那条**交易所级**预警日志不受它管（就在上面那个循环里，只在「你此刻就待在那家所」
        时才出现）—— 所以老手不是完全没有提示，只是没有那记强制暂停。
     ⚠️ 上帝模式「新闻源与事件」关（`eventsOff`，2026-10-09）⇒ 预警也是一条史实利空事件的
        播报，一并熄火（上帝有无限资金 ＋ 可重开，不需要这记保护）。
     ⚠️ **不写日志**：遮罩本身就是那条提醒；再 push 一条，那一格就会同时出现两条同义警告，
        违反「同一事件描述一局内最多一次」。`warnAnchorAt` 用 `===` 判等，天然只命中一次。 */
  if (s.hintOn && !eventsOff(s)) {
    const a = warnAnchorAt(s.i);
    if (a) {
      s.warnAt = a.at;
      s.pending = 'warn';
      s.paused = true;
    }
  }

  // ⚠️ 上一步可能已经进了「待领救济金」或「破产预警」的待决态：时钟停了，后续的资金费 / 强平都不该再跑。
  if (s.pending) return;

  /* 交易所收入分流（2026-10-09 回流管道 · config.EXREV）：上一小时攒下的手续费此刻落进
     保险基金 / 护盘储备 —— 排在本根 NPC 刻度之前，这一根的护盘就能用到回补。 */
  exRevSweep(s);

  /* 插针剧本伺服（2026-10-08 三批拍板③）：排在本根成形之前 —— `godManipPush` 写的位移
     进本根 K 线，随后 `liquidateAll` 的 `flushSlot` 用含位移的 `lastPrice` 判强平
     ⇒ 推到位的那一根，NPC 的强平簇真的爆。待决态（上面 return）时钟停走 ⇒ 伺服自然暂停。 */
  godPinTick(s);

  /* 自动扫单伺服（2026-10-09 用户拍板「一键吃单开关」）：`s.god.eat` 开着 ⇒ 每根吃光该侧簿
     —— 排在本根成形之前，位移进本根 K 线（与插针同一时序纪律）。 */
  godEatTick(s);

  /* 自动化伺服（2026-10-09 拍板：自动新闻三开关 ＋ 自动造量 ＋ 自动拉盘）—— 同一时序纪律，
     互斥裁决在引擎单点（见 `godAutoTick` 头注）。 */
  godAutoTick(s);

  /* NPC 情绪 / 踩踏级联（§73.5）：基础行情（这一根的 K 线）算完之后跑一次 ——
     它自己会往 `s.flow` 写 NPC 的成交，所以必须排在资金费 / 强平之前、玩家的流之后。 */
  tickMarket(s, s.sym);

  /* 其余已加载币的 NPC 刻度（2026-10-07）：紧跟 `tickMarket` —— `crossHeat` 刚把当前币的情绪
     外溢给邻币，邻币的建仓靶心这一拍就能读到（「砸崩 BTC → ETH 散户盘跟着撤」的落点）。
     排在 `advTick` 之前：持有 / 疤痕币的 `syncNpcDrift` 仍由 `advTick` 独家负责（不双步进）。 */
  npcOtherTick(s);

  /* 对抗性流动性（提案 B 档 1）：把本小时的 exposure 抬进峰值台阶 ＋ 该播预警就播。
     排在 `tickMarket` 之后 —— 玩家的 `pv` 刚被清掉、持仓也刚跟着这一根的行情更新过。 */
  advTick(s);

  /* ③ 价格保护带预警（BAND）：极端行情把 Binance 永续闸到「只允许平仓」，**进闸那一刻**播一条。
     判据是**上升沿**（`priceBandAt(i) && !priceBandAt(i−1)`）—— 纯函数、不需要闩锁字段：
     锁定区间内后续各根的前一根也为真 ⇒ 自动不重复播（一个区间只有一条）。
     ⚠️ 只在玩家**此刻就待在 Binance** 时播（与「交易所级预警」同一先例）：你不在这儿，这条与你无关。 */
  if (s.ex === BAND.ex && priceBandAt(s.sym, s.i) && !priceBandAt(s.sym, s.i - 1)) {
    pushLog(s, `${exchangeOf(s.ex)?.name ?? s.ex} 合约 ｜ 极端行情 只允许平仓 ${BAND.hours} 小时`, 'bad', 'mkt');
  }

  /* 持仓成本**每小时**结算一次（2026-10-03 改版 · B26）：
     永续资金费仍只在 8h 整点扣（`settleFunding` 内部按相位分流），
     杠杆保证金则**逐小时**扣借贷利息（持仓不足 8 小时也照付，堵掉「短炒免息」那个漏洞）。
     1x 多头无借入 ⇒ 两样都不扣。 */
  if (settleFunding(s)) return;
  /* ⚠️ 2026-10-05 审计修：结算可能已把本局推入**待决态**（`pending='loan'`，时钟已停）——
     此时 `settleFunding` 返回的是 `false`（`checkRuin` 对「进待决」的返回就是 false），
     所以必须单独看 `s.pending` 再停一次手，否则会继续往下写基差与资金曲线（P1-4 的完整版）。 */
  if (s.pending) return;

  /* ⚠️ P1-4（2026-10-04 审计）：接住返回值 —— 强平把玩家打到破产（`checkRuin`）时本局已结束
     （或进了「待领救济金」的待决态），必须**立刻停手**。
     病根：这里原来忽略返回值，破产/待决后仍往下跑 `advanceMarkBias` 与 `sampleEquity`
     ⇒ 会往一个已经结束 / 停在遮罩上的状态里继续写基差台阶与资金曲线采样（脏写）。 */
  if (liquidateAll(s)) return;
  if (s.pending) return;

  /* 标记价基差推进（三价体系 · 2026-10-03）：排在 `liquidateAll` **之后** ——
     这一小时的基差要等本小时的强平都判完才入账 ⇒ mark 在**当根**完全不含玩家自己刚砸出来的
     位移（这正是「自己的插针不再把自己打爆」的落点）；下一根起它才按半衰期缓缓收敛。
     ⚠️ **五个币逐个小时都推**（不是只推持仓币）：没有位移时基差要能自然衰减回 0 ——
        只推持仓币的话，平仓那一刻基差会**冻住**，下次再持有同一个币时那笔旧基差会诈尸。
        `closeAt` / `rawCloseAt` 未加载时返回 null，`advanceMarkBias` 会自己跳过。 */
  for (const c of COINS) advanceMarkBias(s, c.sym);

  /* 资金曲线采样（v13 · 方案 §4）排在**最后**：这一小时该结的资金费、该爆的仓都已经落账，
     此刻记下的才是「这一天真正剩下的钱」。上面几条 `return`（待决态 / 资金费爆仓）
     会跳过它 —— 无所谓，下一天照样采样，`sampleEquity` 的补记循环不会留下洞。 */
  sampleEquity(s);
}

/**
 * **跳时间落点**（2026-09-30 裁决「回到过去」；2026-10-08 三批起向前/向后统一走它）——
 * 保留资金、清空持仓，把时钟落到第 `to` 根小时 K。方向无关。
 *
 * 普通局向前仍逐小时重放（玩家持仓要真的走过那段时间）；**上帝局**跳时间不再重放
 * （`main.js` 的 `godJump` → `godReset`）：重放产出为零、只有卡顿，落点 ＋ 冷启动累积
 * 与年代开局同一套语义。
 *
 * ⚠️ **为什么不重放**：目标时刻的行情、杠杆阶梯、费率、流动性、币是否已上线**全是 `s.i` 的纯函数**
 *    （`config.*At(t)` 一族），而所有**累积型**状态（持仓 / 在途转账 / 救济金 / 资金曲线 /
 *    日志 / 冲击池 / 待决遮罩）在这里已经全部清空 ⇒ 重放没有任何东西可产出。
 *    反过来，重放**有害**：Bitfinex 被盗削减（2016-08-02）这类事件会在
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
  s.mkb = {};           // 标记价基差（三价体系 · 2026-10-03）：同样依赖本局的位移史 ⇒ 一并抹掉
  s.pool = {};          // 瞬时深度池（v23）同样是「进度」⇒ 回退时一并抹掉（与 s.flow 同口径）
  s.adv = {};           // 对抗性流动性峰值台阶（v29）同样是「进度」⇒ 回退时一并抹掉
  s.advWarn = false;    // 预警闩锁也一并复原（否则回退后再进档 1 就永远不再提醒）
  s.advWarn2 = false;   // 档 2 推价预警闩锁，同上
  s.advWarn3 = false;   // 档 3 强平簇吸引预警闩锁（缺口 15），同上
  s.intWin = { ied: 0, grossM: 0 };   // 借贷利息的 8h 窗口累计（持仓已清空 ⇒ 窗口归零）
  /* 保险基金（v30 · 缺口 5）也是「进度」⇒ 回退时抹成 `null`，让它按**跳转后那一天**的
     流动性重新播种（写死绝对值会在跨年代回退时失真）。 */
  s.fund = null;
  /* 交易所收入累计（2026-10-09 回流管道）同属「进度」⇒ 清零：回退之后的手续费不该背着的
     「未来」收入（时间线已换，谁收的费都算不清）。 */
  s.exRev = 0;
  s.pvol = {};          // 玩家自己的成交量（v17）也是「进度」，回退时一并抹掉 —— 与 s.flow 同口径
  /* 持仓抛压折价（v18 / v25 疤痕）同样是「进度」⇒ 一并抹掉。⚠️ 漏掉它会让**没有持仓**的价格
     仍被一条永久疤痕压着（`refreshOverhang` 的按日重算只遍历 `heldSyms`，永远洗不掉它）。 */
  s.overhang = {};
  s.realized = 0;
  /* 交易统计（v21）也属于「进度」⇒ 一并清空。唯独 `god`（是否开过上帝模式）留着 ——
     它是「这一局不干净」的**永久标记**，回退一百次也不该被洗白。 */
  s.stat = { open: 0, win: 0, loss: 0, liq: 0, margin: 0, fut: 0, maxLev: 1, syms: {}, move: 0, god: s.stat.god, loan: 0, addOn: 0, mgUp: 0, mgDown: 0, mgCut: 0, otc: 0, part: 0, liqNotional: 0 };
  s.eq = [];
  s.loaned = false;
  s.pending = null;
  s.warnAt = null;
  s.otcOff = false;
  s.godRuined = false;
  /* 插针状态机（2026-10-08）：目标价是「跳转前世界」的读数 ⇒ 跳时间一律作废；
     沙盒「世界偏向」台阶（2026-10-08）同理 —— 台阶的 `at` 是跳转前的小时序号，留着会落进未来，
     `stepValueAt` 在跳到那根之前读不到 ⇒ 世界偏向会「迟到」。清空后在下一根按当前旋钮重落。 */
  if (s.god) {
    s.god.pin = null;
    s.god.eat = null;   // 自动扫单（2026-10-09）同样作废 —— 跳转后的世界要玩家重新拍板方向
    s.god.autoNewsAt = null;   // 自动新闻的「下次时刻」是跳转前读数 ⇒ 重排（开关本身保留）
    s.god.sbBias = null;
    /* 假消息冷却与轮换计数（2026-10-08）也是「跳转前世界」的读数 ⇒ 一并作废，
       否则跳时间后冷却可能落在未来（按钮永远灰着）。 */
    s.god.newsAt = null;
    s.god.newsN = null;
    /* 上帝终局旗标（2026-10-09）同样作废 —— 回退到终点之前的世界就得能继续跑，
       与上面 `s.over = null` 是同一件事（`ended` 是上帝局的「软结束」）。 */
    s.god.ended = false;
  }
  s.over = null;
  s.paused = false;
  /* ⚠️ P0-2（2026-10-04 审计）：`s.lockI` 也要清掉。
     病根：下单一小时锁（§73.8）的判据是 `s.lockI >= 0 && s.i <= s.lockI`（见 `pauseLocked`），
     而**唯一的解锁点**是 `advanceOneHour` 里「时钟走过那一刻」。
     回退如果只是把 `s.i` 拨小、却留着刚才那一笔留下的 `lockI`，玩家就会**卡在锁上**：
     拨回到 `lockI` 之前（或拨到同小时）后必须一直点继续走满到超过旧 `lockI` 才能再下单 ——
     而回退后 `s.positions = {}` 早已清空，这笔锁已无任何对应物，纯属残留陷阱。 */
  s.lockI = -1;
  s.log = [];
  s.feed = [];          // 大单日志（2026-10-08 tape）：会话级、「最近发生的事」⇒ 跳时间/回退一律清空重攒
  s.lob = {};           // NPC 限价簿（2026-10-08 三批⑦）：可由种子逐位复现 ⇒ 清空后在落点冷启动重长

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

  /* ⚠️ P1-9（2026-10-04 审计）：清空 `s.flow` 之后必须让 σ 缓存失效。
     价格位移是**逐根**的、σ 的分子分母都读 `closeAt`（含位移）⇒ 把冲击池清成 `{}` 会让
     实际位移归零，而缓存里还留着「带位移」的旧 σ —— 不回退这一步，回退后头几帧的
     σ / 滑点 / NPC 热度全按**已经不存在的位移史**算，自相矛盾。 */
  invalidateSigma();
  /* dipOf 滑窗缓存同样立在「已收盘 K 线不可变」上 —— 回退动了 `s.i` 与冲击池，
     整表作废最稳（拨小 `s.i` 后连续性检查本就会冷启动，这里是显式双保险）。 */
  resetDipCache();

  return usd + usdt;
}

/* ───────────────────────── 资金费率与强平 ───────────────────────── */

/**
 * 让 σ 缓存失效 —— **2026-10-08 起只服务回退**（`rewindTo` 一处调用）。
 *
 * ⚠️ 正常推进（开仓 / 平仓 / 强平 / 级联 / 持仓折价落台阶）**不再**调这里：位移写入恒
 *    `at = s.i`、只影响它之后的根，而 σ 缓存窗口里的日收盘在条目创建时全部已冻结
 *    ⇒ 重算值与缓存值逐位相同，刷了是纯浪费（证明见 `daySigmaCache` 头注；
 *    以前每次级联 ~4.5h 刷一遍、39 个日收盘读全部冷扫，是跳时间卡死的大头）。
 * ⚠️ 回退必须清：`s.i` 跳回、`s.flow` / `s.overhang` / NPC 台阶整池清零，**同一天**的旧条目
 *    会带着「回退前位移史」的值命中缓存 —— 那才是真正的脏读。
 */
export function invalidateSigma() {
  daySigmaCache.clear();
  daySigmaFastCache.clear();     // 短窗 σ 与 σ_30日 同源（都读 `closeAt`）⇒ 一起清
}

/**
 * **借贷利率的利用率乘数**（S3 · 2026-10-05）—— 基准日息（`config.MARGIN.daily`）之上那一层浮动。
 *
 * 现实里 Bitfinex 的借贷利率是用户间 P2P 撮合的 FRR：池子越满越贵，崩盘时出借方抽贷会飙到
 * 年化 50%+（见 `config.MARGIN.util` 的注释）。本函数复刻这条形态，**不改基准曲线本身**：
 *
 *   压力   = |heat − 0.5| / 0.5                     （情绪两端都抽贷）
 *   供给   = 1 − supplyPull × 压力                  （恐慌中可借池缩水，下限 0.2）
 *   利用率 = clamp((base + 玩家借入 ÷ 额度) ÷ 供给, 0, 1)
 *   乘数   = 1 + kRate × (利用率 − base) ÷ (1 − base)，夹在 [1, 1 + kRate]
 *
 * **做空供应利用率 jump 段**（§9.5 重启 · 2026-10-09 用户拍板「硬拒＋费率飙升」）：
 *   `useSup = 空头借币 ÷ (流通量 × shortShare)` —— 越过 `util.kink`（80%，Aave kink 同型）
 *   后再叠 `util.jump × (useSup − kink) ÷ (1 − kink)`；借满整个借币池时乘数 25×，
 *   借币日息 2017 档恰好到 **0.5%/日**（GDD 原设极值）、2020 档 0.125%/日 ≈ 46% APR
 *   （对齐 2021-05 借贷挤兑实录）。只对**杠杆空头**计（多头借的是美元、不占币量）。
 *
 * ⇒ 常态（压力 0、玩家不借）乘数**恰为 1** ⇒ 与改动前逐位相同（老档读档后的利息也不变）。
 * ⚠️ **只读、纯函数**：不写状态、不新增字段 ⇒ 不升 `STATE_VERSION`。
 * @param {object} s   本局状态
 * @param {string} sym 币符号（借入与该币的当日流动性都按币取）
 * @returns {number} ≥ 1 的乘数
 */
export function marginRateMulOf(s, sym) {
  const U = MARGIN.util;
  const poolCap = (liqOf(sym, dayIndexOf(s.i)) ?? 0) * MARGIN.quota;
  const pos = s.positions && s.positions[sym];
  const use = poolCap > 0 ? borrowedOf(pos) / poolCap : 0;
  const stress = Math.min(1, Math.abs(heatOf(s, sym) - HEAT.base) / HEAT.base);
  const supply = Math.max(0.2, 1 - U.supplyPull * stress);
  const util = Math.max(0, Math.min(1, (U.base + use) / supply));
  const dev = Math.max(0, (util - U.base) / (1 - U.base));
  let mul = 1 + U.kRate * dev;
  /* 做空供应利用率 jump 段（§9.5 重启 · 2026-10-09）：只对**杠杆空头**计 —— 它借的是真实
     流通量的币；多头借的是美元（quote 池，不占币量）、合约空头是合成敞口。借满借币池
     （useSup → 1）时再叠 `jump` ⇒ 乘数 25×、借币日息到 GDD 原设 0.5%/日 极值。 */
  if (pos && pos.side === 'short' && isMargin(pos)) {
    const supDay = supplyAt(sym, dayIndexOf(s.i));
    if (supDay > 0) {
      const useSup = borrowedOf(pos) / (supDay * MARGIN.shortShare * lastPrice(s, sym));
      if (useSup > U.kink) mul += U.jump * Math.min(1, (useSup - U.kink) / (1 - U.kink));
    }
  }
  return mul;
}

/**
 * 每 8 游戏小时一次的**持仓成本结算**（GDD §9.5）—— B26 起分成**两条互斥的路**：
 *
 *   - **永续（perp）**：资金费率 —— **拥挤成本**（§73.6）：应付的名义价值 × 费率从保证金里扣
 *     （应收则加回去）。费率走 BitMEX / Binance 的**两段式**（2026-10-03 真实化 · §14.1 A3）：
 *
 *         P = FR.k × clamp((多空占比 − 0.5) ÷ 0.5, ±1)        ← 溢价指数代理（见 `FR` 口径注）
 *         F = clamp( P + clamp(FR.interest − P, ±FR.clamp), ±FR.max )
 *
 *     **不含 `dir`**：方向只在 `fundingOf` 里出现一次（v30 · 缺口 3 修掉原来的双重 `dir` bug）。
 *     费率由**全市场多空失衡**（`longShareOf`，含玩家自己的名义）驱动，玩家可真收可付；
 *     「仓位越大越贵 / 越赚」自动保持，不再由行情动量决定。口径见 `positions.js` 的 `FR` 注释。
 *   - **杠杆（margin）**：借贷利息 —— **按小时**计息（2026-10-03 拍板）：`借入量 × 日息 ÷ 24`。
 *     史实里 Bitfinex 的「杠杆」是用户间 P2P 借美元/借 BTC（出借方叫 Margin Funding Provider），
 *     **按小时计息、不足 1 小时记满 1 小时**（平台再抽 15% 手续费，本作不建模那一层）。多头借的是
 *     美元（`名义 − 保证金`）、空头借的是币（**全额名义**）—— 见 `borrowedOf`；两条 funding book
 *     的利率各走一条曲线（`config.MARGIN.daily.quote` / `.coin`，见 `borrowCurOf`）。
 *     ⚠️ 改动前是「每 8 小时扣一次 `借入 × 日息 × 8/24`」，于是**开仓不足 8 小时就平仓 ⇒ 一分利息
 *     不付**（漏洞）。改成逐小时扣之后持仓 1 小时也照付，但**日志仍只在 8 小时整点播一次**
 *     （把这 8 小时的累计一起报，避免 24 条/日刷屏）—— 窗口累计见下面的 `s.intWin`。
 *     日息**按年代取值**且**数字是合成值** ⇒ GDD 声明。2016-05-13 之前世界上没有永续，
 *     那时的杠杆仓全落进这一支。
 *
 * ⚠️ **两条路各写一条日志**（标签不同、不能合并成一条）：`paysInterest` 与 `paysFunding` 互斥，
 *    同时持有两种仓位时玩家需要分别看到两笔成本的费率。1x **多头**（无借入）两样都不付；
 *    1x **空头**借了全额 ⇒ 付借贷利息。
 * @returns {boolean} 是否因结算后总权益归零而结束本局
 */
function settleFunding(s) {
  const syms = heldSyms(s);

  const t = timeOf(s);
  /* 永续资金费仍只在这 8 小时整点上结；**借贷利息每根小时都结**（见下面的注释）——
     `settleFunding` 因此改为**每小时**被调用，两个分支各自按自己的相位走。 */
  const isFundingHour = s.i % FUNDING.hours === 0;

  /* 借贷利息的 **8 小时窗口累计**（只影响那条日志，不影响落账 —— 利息本身逐小时已扣进 `margin`）。
     ⚠️ 旧存档没有这个键 ⇒ 懒建（与 `s.adv` 同一先例，**不升 `STATE_VERSION`**）。 */
  if (!s.intWin) s.intWin = { ied: 0, grossM: 0 };

  let fed = 0, grossP = 0;   // 永续：净支出（> 0 = 玩家付出）/ 参与结算的名义和
  let ied = 0, grossM = 0;   // 杠杆保证金：本小时的应付利息 / 借来的名义和
  for (const sym of syms) {
    const pos = s.positions[sym];

    /* ── 杠杆保证金：借贷利息（B26）—— 按**借入量**、**按小时**计息（2026-10-03）──
       多头借美元（名义 − 保证金）、空头借币（全额）。1x 多头借入为 0 ⇒ 落不进来。
       利率按**借的币种**取（多头走 quote、空头走 coin —— 两条独立 funding book，见 `borrowCurOf`）。 */
    if (paysInterest(pos)) {
      const borrowed = borrowedOf(pos);
      /* S3：利率 = 基准日息 × 利用率乘数（池子越满 / 越恐慌越贵，见 `marginRateMulOf`）。 */
      const fee = borrowed * marginDailyRateAt(t, borrowCurOf(pos)) * marginRateMulOf(s, sym) / 24;
      pos.margin -= fee;
      s.realized -= fee;
      exCharge(s, fee);                      // 借贷利息进交易所收入账（回流管道 · config.EXREV；现实 SAFU 的资金来源之一）
      ied += fee;
      grossM += borrowed;                            // 报出去的费率口径见下面窗口累计处
      continue;
    }

    if (!isFundingHour) continue;                    // 永续资金费只在 8h 整点结

    /* **全市场多空失衡**驱动的资金费（v30 · 第 6 批 · 缺口 3）—— 真实资金费是**多空之间的
       点对点转移**（拥挤方付、另一侧收），交易所只当中介。费率**不含方向**（`dir` 只在
       `fundingOf` 里出现一次）⇒ 玩家可真收可付；玩家自己的名义已经在 `longShareOf` 里
       ⇒「仓越大越贵 / 越赚」自动保持，不必再加第二项。
       ⚠️ 2026-10-03 真实化（§14.1 A3）：失衡先换成**溢价指数代理 P**，再经
          `F = clamp(P + clamp(I − P, ±0.05%), ±0.75%)` 得到费率 —— 中性带内恒为 0.01%/8h。 */
    const share = longShareOf(s, sym);
    if (share == null) continue;                     // 没有任何仓位 ⇒ 无多空比可言，不收费
    const rate = fundingRateOf(premiumIndexOf(share));

    const m = mktOf(s, sym);
    /* **G3 · NPC 也付费率**（2026-10-05）—— 资金费是**全市场多空的点对点转移**，`npcFund` 是
       对手方池，NPC 侧的净头寸当然也走同一条费率：`N = Σlong − Σshort`（名义），净额 `rate × N`
       进 / 出池。⇒「负费率逼空」不再只作用于玩家，池被真实的市场净额补给、不会被玩家单方面抽干
       （改动前只有玩家缴费入池 ⇒ 长局里池结构性失血，`funding` 那条日志的池读数长期贴 0）。
       ⚠️ 符号与玩家那一支同源：`rate > 0`（多头拥挤）⇒ 净多头付费入池、净空头掏池；池余额恒 ≥ 0。
       ⚠️ 本项**不依赖玩家自己那一刻持的是什么工具**：永续资金费是全市场机制 —— 玩家即便持的是
          杠杆仓（`!paysFunding`，自己不参与），散户那一侧的净头寸照样按同一条费率进出对手方池。
          ⇒ 必须落在 `paysFunding` 这个 `continue` **之前**，否则池只会在「玩家恰好开着永续仓」时才被补给。 */
    const npcN = npcNet(m);
    if (npcN !== 0) m.npcFund = Math.max(0, (m.npcFund || 0) + rate * npcN);

    if (!paysFunding(pos)) continue;                 // 1x 多头 / 杠杆仓：自己不付资金费（改付借贷利息）
    const mark = exMarkPrice(s, sym, pos.ex);       // 三价：资金费按**本仓所在所**的标记价（Binance 口径）
    if (!(mark > 0)) continue;

    let fee = fundingOf(pos, mark, rate);
    /* **对手方池**（`s.mkt[sym].npcFund` · 缺口 3）：玩家付出 ⇒ 入池；玩家收取 ⇒ 从池出。
       ⚠️ 池**只付得起它有的部分**（＝偿付上限）：付不起就按余额打折 —— 池余额恒 ≥ 0，
          这正是「对手方不足以覆盖」时真实平台的处境。 */
    if (fee > 0) m.npcFund += fee;
    else if (fee < 0) {
      const paid = Math.min(-fee, m.npcFund > 0 ? m.npcFund : 0);
      m.npcFund -= paid;
      fee = -paid;                                   // 实际只收到 `paid`
    }

    pos.margin -= fee;
    /* ⚠️ 同一笔钱也要记进「已实现」（Batch 5 · B23）：原来只从保证金里扣，
       于是 HUD 副行那个数漏掉了资金费这一项支出（或收入）。 */
    s.realized -= fee;
    fed += fee;
    grossP += pos.size * mark;
  }

  /* 各币各看各自的**多空失衡**，费率并不相同 —— 日志只报一个**按名义价值加权的综合费率**，
     它恰好能自洽地解释那个净额，不会出现「费率写 +0.01% 却收钱」这种读不通的情况。
     ⚠️ 末段「对手方池」是**当前币**（`s.sym`）的余额（缺口 3）—— 池按币分账，
        写一个跨币合计反而对不上账，所以只报玩家正在看的那个币。
     文案（Batch 4 · B18，2026-09-29 拍板）：金额一律是**玩家视角的总收益**，
     「收益 +$0.03」= 拿到 U、「收益 −$0.05」= 付出 U ——
     正负号本身就是方向，不再写「支出 / 收入」四个字（日志条一行 nowrap，多两个汉字就挤爆）。 */
  /* 借贷利息：逐小时的钱**已经在上面落账**，这里只做 **窗口累计 ＋ 8 小时整点播报**
     （24 小时最多一条，不刷屏）。
     `ied` 是**窗口内 Σ利息**（逐小时累加），`grossM` 取**本小时**的借入名义当**代表值**
     ⇒ `rate = Σ利息 ÷ 借入` 是**这个窗口的有效费率**（借入不变、满 8 小时时逐位等于改动前的
     `日息 × 8/24`；持仓不满一个窗口时也如实反映）。
     ⚠️ **R2（2026-10-04 审计）· 这是近似，不是精确值**：`ied` 按小时累加、`grossM` 却只取
        最后一小时 ⇒ 若**借入量在窗口内变化**（中途加仓 / 减仓 / 改杠杆），报出的费率会偏向
        最后那一小时的规模（此时 `收益` 金额仍逐位正确，只有这条「费率」是近似）。
        之所以**不改成「Σ借入」的严格时间加权**：那会把满窗口时的读数从「8 小时等效费率」
        变成「小时费率」，**整体缩小 8 倍** —— 那是一次玩家可见的口径变更，需单独拍板，
        不属于本次只读审计的机械修范围。
     ⚠️ 无持仓的那几小时 `grossM = 0` ⇒ **不动窗口**（把已累计的留着，等边界一起播）。 */
  if (grossM > 0 && ied !== 0) {
    s.intWin.ied += ied;
    s.intWin.grossM = grossM;
  }
  if (isFundingHour && s.intWin.grossM > 0 && s.intWin.ied !== 0) {
    const rate = s.intWin.ied / s.intWin.grossM;
    pushLog(s, `借贷利息 ${fmtRate(Math.abs(rate), 4)} ｜ 收益 ${fmtMoney(-s.intWin.ied, { sign: true })}`,
      'bad', 'cost');
    s.intWin.ied = 0;
    s.intWin.grossM = 0;
  }
  if (grossP > 0 && fed !== 0) {
    const rate = fed / grossP;
    const pool = s.mkt && s.mkt[s.sym] ? s.mkt[s.sym].npcFund : 0;
    pushLog(s, `资金费率 ${fmtRate(Math.abs(rate), 4)} ｜ 收益 ${fmtMoney(-fed, { sign: true })} ｜ 对手方池 ${fmtMoneyShort(pool)}`,
      fed > 0 ? 'bad' : 'ok', 'cost');
  }

  /* 无持仓时不判破产 —— 与改动前的早退逐位等价（那时 `syms` 为空直接 `return false`）。 */
  return syms.length ? checkRuin(s) : false;
}

/**
 * 逐仓强平：每个仓位各自用**当根 K 线的高低点**判定（见文件头注释）。
 * 无借入的仓位跳过 —— **1x 多头**只有币价归零才归零本金，不因维持保证金率被强平（GDD §9.1）。
 * ⚠️ v9（§15.3 N5）：判据从「是不是杠杆 1x」换成 `canLiquidate` —— 杠杆从 §15.6 起**也带倍数**。
 * ⚠️ 2026-10-03：判据再收窄成 `borrowedOf > 0` —— **1x 空头借了全额币，也进这一支强平**。
 * ⚠️ B18/B26：维持线本身也不再是常数 —— `maintRateOf(pos)` 按「所 × 工具 × 名义档」取
 *    （Binance 永续四档、杠杆保证金恒 15%），所以早期 3.3x 杠杆仓会明显比现在更容易爆。
 * ⚠️ **2026-10-01 起不再是「一穿线就整条打掉」**：触线只走**部分强平**一档（`partialLiquidate`），
 *    只有权益真跌到 ≤ 0（或剩余不足最小名义）才整条 `forceLiquidate`。见 `PARTIAL_TARGET`。
 * @returns {boolean} 是否因此结束了本局
 */
function liquidateAll(s) {
  for (const sym of heldSyms(s)) {
    const pos0 = s.positions[sym];
    if (!pos0 || !canLiquidate(pos0)) continue;

    /* 三价体系（2026-10-03 拍板）：强平判据走**标记价 K 线** ——
       日内高低取**原始行情**（`rawCandleAt`，不含任何位移），整体平移**平滑后的基差**
       （`markBiasOf`），再乘**本仓所在所**的本所价偏移（缺口 10）。
       ⇒ ① 玩家自己砸出来的插针（位移那一层）根本不进高低点 ⇒ 不再「自己把自己打爆」；
          ② 与未实现盈亏 / 保证金率（都读 mark）同源 ⇒ 不再「显示健康却被爆」。 */
    const raw = rawCandleAt(sym, s.i);
    if (!raw) continue;
    const bias = markBiasOf(s, sym);
    const dv = exDevOf(pos0.ex, sym, s.i, s.seed, s);
    const c = {
      o: (raw.o + bias) * dv,
      h: (raw.h + bias) * dv,
      l: (raw.l + bias) * dv,
      c: (raw.c + bias) * dv,
    };

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
      /* 没有可留的部分（权益已 ≤ 0），或剩下的不足最小名义（会留下尘埃仓）⇒ 整条打掉。
         ⚠️ P1-5（2026-10-04 审计）：尘埃闸的尺子改用**现价名义** `pos.size·(1−frac)·at`。
         病根：这里原来用**开仓名义** `pos.notional·(1−frac)`，而 `adlPlayerReduce` 与
         `closeCheck` 的尘埃闸都用**现价名义** ⇒ 同一笔「剩余仓位」在两处会得出不同结论
         （暴涨后开仓名义远小于现价名义 ⇒ 强平这一路会把一个现价早已远超最小名义的残仓
         误判成尘埃、整条打掉）。三处统一到现价名义，阈值仍是 `MIN_NOTIONAL`（不升，
         免得动到与 `ruinFloorOf` 的耦合）。 */
      if (!(frac < 1) || pos.size * (1 - frac) * at < MIN_NOTIONAL) {
        forceLiquidate(s, pos, at);
        if (checkRuin(s)) return true;
        break;
      }

      partialLiquidate(s, pos, frac, at);
      if (from > last) break;              // 路径已走完，这一小时内不会再被打
    }
  }
  /* ⚠️ 2026-10-05 审计修（僵尸仓出口 · 结构性漏洞）：末尾**无条件**判一次破产。
     旧实现只有走到 `forceLiquidate` 那一支才 `checkRuin` ⇒ 若所有仓位都 `!canLiquidate`
     （或压根没有持仓）就**永远不会**在这里做归零判定，留下「权益为负、本局不结束」的口子
     （用户 2026-10-05 实测：滚仓抽干 1x 多头的保证金后，`borrowedOf` 低估借入 ⇒ 仓位不可强平）。
     ⚠️ `checkRuin` 自身已幂等（`pending` / `over` 直接返回）⇒ 与循环内那次不冲突、不重复播报。 */
  return checkRuin(s);
}

/**
 * **部分强平**：（2026-10-01 拍板 · 见 `PARTIAL_TARGET`）—— 把仓位按 `frac` 缩掉一档，
 * 剩余部分继续持有。残余权益全部留在仓位里（见 `reducePosition`），于是强平价被推远。
 *
 * 与 `forceLiquidate` 共用全部副产物口径：**量柱**（真实成交 ⇒ 计入）、**订单冲击**
 * （平多打压 −1 / 平空推高 +1，同一公式、同样只回吐 `SHOCK.closeGive`）、**抛压折价刷新**、
 * **清算费**（2026-10-07 补齐 —— 按已平名义收费、从残仓保证金里扣）。
 *
 * ⚠️ 与 `forceLiquidate` 唯一的差别是**现金不动**：平掉的那一档不结算到账本，亏损记进
 *    `s.realized`、钱仍押在仓位里（见 `reducePosition`）——「坚决不还给玩家」正是这个机制救人的原因。
 */
function partialLiquidate(s, pos, frac, atPrice) {
  const r = reducePosition(pos, frac, atPrice);
  const notional = r.closedNotional;
  addPlayerVol(s, pos.sym, notional, pos.ex, isMargin(pos) ? 'margin' : 'fut');
  {
    const dir = pos.side === 'long' ? -1 : 1;
    pushFlow(s, pos.sym, dir, notional, SHOCK.closeGive, shockKindOf(isMargin(pos), pos.lev));
    consumePool(s, pos.sym, notional);    // 瞬时深度池（L1）：部分强平也是真实成交 ⇒ 也吃深度
  }
  s.realized += r.pnl;                     // 亏损已实现（钱还押在仓位里，见 `reducePosition`）
  /* 统计（2026-10-07 用户拍板 · 口径改为「强平事件」）—— 见 `state.js` 的 `stat.liq`：
     **同一笔仓位无论被打多少档，一局之内只记 1 次**（第一次打就记，之后每一档都不再计）。
     现实依据：交易所一次爆仓会连下十几张 IOC 单，而聚合口径把它当**同一次强平**报出去
     （Binance 官方文档：每个交易对每 1000ms 只推送其中最大的一笔清算单）。
     ⚠️ `liqNotional` 仍是**逐档累计**的成交名义 —— 那是美元口径，与笔数无关，别一起改。 */
  if (!pos.liqCounted) s.stat.liq += 1;
  r.pos.liqCounted = true;                 // 落在这笔仓位身上 ⇒ `{...pos}` 会一路带着它
  s.stat.liqNotional += notional;          // §17.3（2026-10-04）：部分强平的成交名义同口径计入（与 `forceLiquidate` 一致）
  feedPush(s, pos.sym, pos.side === 'long' ? 4 : 5, atPrice, notional, 0);   // tape：部分强平同发爆多/爆空（minTier 0：玩家自己的仓，小名义也上）
  /* 清算费（2026-10-07 用户拍板 · 补漏）：**部分强平同样按「已平名义」收费**。
     现实里交易所对部分强平也照收 liquidation fee（与整条强平同一张费率表）；旧实现只有
     `forceLiquidate` 扣费 ⇒ 「被削十几档」这条最惨的路反而一分不罚（实测累计 0.2%~0.5% 原始名义）。
     口径与 `forceLiquidate` 逐字对齐：
       · 费率走 `borrowedOf` 分档（永续 0.5% / 杠杆 1.25%，见 `config.LIQ`）；
       · 只从**这一笔仓位的保证金**里扣、**扣到 0 为止** —— 绝不向玩家追缴、不产生负债
         （同 `forceLiquidate` 那句「清算费最多把残余权益吃到 0」）；
       · 「没退回去的那份」进保险基金 —— 与 `forceLiquidate` 的 `s.fund += remain − back` 同一语义。
     ⚠️ 保底：保证金被扣低后**强平价会被重新算近**（`liquidationPrice`），这正是「罚了要更早爆」的
        真实后果，不要再去补偿它。 */
  const fee = notional * (borrowedOf(pos) > 0 ? LIQ.feeMargin : LIQ.fee);
  const paid = Math.min(r.pos.margin, fee);
  if (paid > 0) {
    seedFund(s, pos.sym);
    r.pos.margin -= paid;
    s.realized -= paid;
    s.fund += paid;
  }
  s.positions[pos.sym] = r.pos;
  pushLog(s, `部分强平 ${pos.sym} ${lvTagOf(pos)}｜平仓 ${fmtRate(frac, 1)}｜保证金 ${fmtMoneyShort(pos.margin)} → ${fmtMoneyShort(r.pos.margin)} @ ${fmtLogPrice(atPrice)}`, 'bad', 'liq');
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
 * ⚠️ v9（§15.6 N3）：**该所此刻没有合约时，模式强制退回杠杆** —— 否则玩家会带着 `'fut'`
 *    停在一家根本不提供合约的交易所上：模式键已经藏起来了，单子却还在按合约口径下。
 * ⚠️ 夹取必须用**当前模式那一张表**（§15.1）：从 125x 的合约切回杠杆，杠杆必须掉到杠杆上限。
 */
export function normalizeLeverage(s) {
  if (!futuresAvailable(s)) s.mode = 'margin';
  const max = maxLeverageAt(timeOf(s), s.ex, levKind(s));
  if (s.lev > max) s.lev = max;
  if (s.lev < 1) s.lev = 1;
}

/**
 * 当前所**此刻**有没有合约（v9 · §15.3 N3）—— UI 用它决定那枚「杠杆 / 合约」模式键出不出现。
 * 判据 = 该所 `futSteps` 非 `null` **且**首档已生效（`config.hasLeverageKindAt`）。
 */
export const futuresAvailable = s => hasLeverageKindAt(timeOf(s), s.ex, 'fut');
