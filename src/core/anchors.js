/**
 * 历史锚点表（P2-C · GDD §12.1 / §12.2）
 * ===============================================================
 * **一张表 ＋ 三个消费者**（P2-C 拍板 ②）：新闻（`render.js`）、K 线标记（`chart.js`）、
 * 拥堵加成（`congestion.js`）。表只有这一份 —— 消费者各取所需，绝不各存一份。
 *
 * ⚠️ **锚点不产生任何人工涨跌幅**（P2-C 拍板 B）：GDD §14.2 原稿那张「事件驱动波动 ±%」表已作废。
 *    游戏行情就是真实历史小时线（2014-02 的 $900 → $400、2020-03-12 的单日 −50% 本来就在
 *    数据包里），再叠一层人工幅度＝**双重计算**，还会污染 σ_30日 / 滑点 / OTC 溢价这些实测口径。
 *    所以本文件里**没有任何价格字段** —— 锚点只回答「什么时候、发生了什么事、哪条链堵了」。
 *
 * ⚠️ **缺口 2「新闻驱动订单流」就此结案**（2026-10-02 用户拍板「**维持红线，不碰价格**」，
 *    审计见 NEXT-STEPS §8.9.3）：拟解的「新闻命中时往 `s.flow` 注入一笔人工冲击」与上面这条
 *    红线**直接冲突** —— 真实小时线里已经含有那次行情，注入＝**双重计算**，还会污染
 *    σ_30日 / 滑点 / OTC 溢价。故**不做**：新闻只走 `pushLog`（`render.js`）＋ 既有的
 *    `HEAT` 通道（行情本身就会推动热度）。别因为「新闻应该有冲击」就回来加 —— 冲击已经在数据里。
 *
 * ⚠️ 锚点是 `s.i` 的**纯函数**（同 P2-A 拥堵的 ①②）：不进存档、不升 `STATE_VERSION`。
 */

import { GAME, HOUR_MS } from './config.js';
import { candleAt, closeAt } from './market.js';

/** 新闻在日志条上停留的游戏小时数。1 游戏日 —— 再长就会盖掉玩家自己的操作反馈。 */
export const NEWS_HOURS = 24;

/**
 * 新闻的**播报延迟**（游戏小时）—— **1**，「事情发生之后 1 小时就播报」（用户 2026-09-30 拍板）。
 *
 * ⚠️ **只报事件、不报数字**（同上拍板）：第一条的 `title` 一个价格都不带，所以不存在「要等当天
 *    走完才成立」的那个数（`newsTextOf` / `newsMove` 已整块删除）。数字全部落在**第二条**。
 * ⚠️ 只有**新闻**后移。K 线标记（`anchorsInRange`）与链上拥堵（`congestionAnchors`）仍锚在 `at`：
 *    那两处要的是「事情发生在哪里」（标记画在事件那天、链就是那天堵的），不是「什么时候被报道」。
 * ⚠️ 锚点是**日粒度**（`t` 一律 UTC 零点）⇒ 第一条播报时刻默认是**事件当天 01:00 UTC**。
 *    个别事件真实发生在当天傍晚的（2024-01 ETF 获批 = 20:30 UTC），用 `h` 把播报挪到那之后。
 */
export const NEWS_DELAY = 1;

/**
 * 锚点表。字段：
 *   `t`           UTC 时间戳（**日**粒度：时分秒一律为 0）
 *   `h`           **播报小时偏移**（可选，缺省 0）—— 事件真实发生时刻与 UTC 零点差得远时才填，
 *                 只挪新闻，不挪 K 线标记与拥堵（那两处要的是「事情发生在哪一天」）
 *   `title`       **第一条 · 事件**文案：只讲发生了什么，**一个价格数字都不许有**
 *   `rt`          **第二条 · 结果**文案（`r` 为空时无此项）
 *   `r`           **第二条的触发规格**（可选；空 ⇒ 这条只出一条新闻）：
 *                   `{ k:'lvl', sym, dir: 1|-1, v, w }`  首次上/下穿价位 `v`，窗口 `w` 天
 *                   `{ k:'mv',  sym, dir: 1|-1, pct, w }` 首次相对**事件日前一日收盘**涨/跌达 `pct`（0.30 = 三成）
 *                   `{ k:'cong', w }`                     拥堵爬满（`at + w 天`）
 *   `chain`       `'btc' | 'eth' | null`；`null` ＝ 全市场事件（Luna / FTX）
 *   `congestion`  非空 ⇒ 该窗口给**链上转账**的抬升值 `{ add, days, ramp, fall }`。
 *                 实测区间：`add` 40–70（2017-12 的 70 见 `congestion.js` 的 §6.3 说明）、`days` 7–14。
 *                 ⚠️ GDD §6.4 写的是「+30 至 +60，3–10 天」—— 那是**设计初值**，本表按史实校准后有两处
 *                    突破（70 与 14 天），P1-14（2026-10-04 审计）已把这条注文改成实测区间，别再拿旧数去对。
 *   `warn`        真 ⇒ 该事件会**直接弄死人 / 重创杠杆仓**，提前 7 天弹遮罩 ＋ 暂停（v11 · ③）
 *
 * ⚠️ **数字一律不进第一条**（2026-10-01 拍板）：标题里那些「冲上 $260」「单日腰斩」原先会**预知**——
 *    锚点是日粒度 ⇒ 01:00 就播了，而那个数要等到当天走完才成立。现在拆成两条：
 *    **第一条只讲事件（无数字）**，**第二条在它真的发生后 1 小时才播**，数字就是触发阈值本身。
 *    于是「新闻里的数」与「图上的数」永远一致，且**必然发生在之后**。
 * ⚠️ **判定走 `market.candleAt()`（含玩家位移）⇒ 天然动态**：玩家把价推上去，结果新闻提前；
 *    把价压住，它就不出现（宁可不报，不报假数）。窗口 `w` 内没触发 ⇒ 该条静默作废。
 *
 * ⚠️ **只有 `chain === 'btc'` 且 `congestion` 非空的项会进拥堵**（见 `congestionAnchors`）：
 *    P2-A 的链上转账口径定死为 **BTC 链**（脉冲分母 = `liqOf('BTC', …)`，单一真相源），
 *    把 2016-09 的 ETH DoS 算进 BTC 的到账时间在因果上是错的 —— 如实留白比编一个数好。
 */
export const ANCHORS = [
  { t: Date.UTC(2013, 3, 10),  title: '塞浦路斯要对存款征税，资金开始寻找银行之外的去处',
    rt: 'BTC 冲上 $250，四个月涨了近 20 倍',   r: { k: 'lvl', sym: 'BTC', dir: 1, v: 250, w: 30 },   chain: 'btc',  congestion: null },
  { t: Date.UTC(2013, 10, 18), title: '美国参议院听证会：虚拟货币「合法且可监管」',
    rt: 'BTC 站上 $900，两周涨了近一倍',       r: { k: 'lvl', sym: 'BTC', dir: 1, v: 900, w: 30 },   chain: 'btc',  congestion: null },
  { t: Date.UTC(2014, 1, 25),  title: '当时全球最大的交易所停机，85 万枚 BTC 蒸发',
    rt: 'BTC 跌破 $400',                      r: { k: 'lvl', sym: 'BTC', dir: -1, v: 400, w: 30 },  chain: 'btc',  congestion: null, warn: true },
  { t: Date.UTC(2015, 6, 7),   title: '有人用大量小额交易把区块塞满，内存池爆掉',
    rt: '一笔转账要等几十个块才确认',           r: { k: 'cong', w: 2 },                              chain: 'btc',  congestion: { add: 40, days: 10, ramp: 2,   fall: 4 } },
  { t: Date.UTC(2016, 5, 17),  title: '360 万枚 ETH 被转走，社区开始讨论硬分叉',
    rt: 'ETH 跌破 $15',                       r: { k: 'lvl', sym: 'ETH', dir: -1, v: 15, w: 14 },  chain: 'eth',  congestion: null, warn: true },
  { t: Date.UTC(2016, 6, 9),   title: '比特币区块奖励减半：25 → 12.5',           chain: 'btc',  congestion: null },
  { t: Date.UTC(2016, 8, 18),  title: '攻击者用廉价交易塞满区块，出块与确认变慢', chain: 'eth',  congestion: null },
  { t: Date.UTC(2017, 4, 20),  title: '牛市资金涌入，BTC 链上首次大拥堵',
    rt: 'BTC 站上 $2,000',                    r: { k: 'lvl', sym: 'BTC', dir: 1, v: 2000, w: 7 },  chain: 'btc',  congestion: { add: 40, days: 10, ramp: 2,   fall: 4 } },
  { t: Date.UTC(2017, 7, 1),   title: '扩容谈崩，比特币现金从主链分叉出来',
    rt: 'BTC 站上 $3,000',                    r: { k: 'lvl', sym: 'BTC', dir: 1, v: 3000, w: 30 }, chain: 'btc',  congestion: null },
  { t: Date.UTC(2017, 11, 1), title: '一只虚拟猫把以太坊堵到瘫痪，ICO 把资金推向 BTC',
    rt: 'BTC 冲上 $19,000，刷新历史高点',      r: { k: 'lvl', sym: 'BTC', dir: 1, v: 19000, w: 30 }, chain: 'btc',  congestion: { add: 70, days: 10, ramp: 2,   fall: 4 } },
  { t: Date.UTC(2018, 11, 15), title: '上一轮泡沫彻底破裂，一年把牛市全部还了回去',
    rt: 'BTC 跌破 $3,200',                    r: { k: 'lvl', sym: 'BTC', dir: -1, v: 3200, w: 14 }, chain: 'btc',  congestion: null, warn: true },
  { t: Date.UTC(2020, 2, 12),  title: '全球资产一起被抛售换现金',
    rt: 'BTC 单日跌去三成',                    r: { k: 'mv', sym: 'BTC', dir: -1, pct: 0.30, w: 3 }, chain: 'btc',  congestion: null, warn: true },
  { t: Date.UTC(2020, 4, 11),  title: '第三次减半：区块奖励 12.5 → 6.25',        chain: 'btc',  congestion: null },
  { t: Date.UTC(2021, 3, 14),  title: 'Coinbase 上市，传统资金第一次大规模进场',
    rt: 'BTC 突破 $64,000',                   r: { k: 'lvl', sym: 'BTC', dir: 1, v: 64000, w: 7 }, chain: 'btc',  congestion: { add: 45, days: 7,  ramp: 1.5, fall: 2.5 } },
  { t: Date.UTC(2021, 10, 10), title: '通胀与 ETF 预期把资金推向 BTC',
    rt: 'BTC 创下 $69,000 的历史新高',         r: { k: 'lvl', sym: 'BTC', dir: 1, v: 69000, w: 14 }, chain: 'btc',  congestion: null },
  { t: Date.UTC(2022, 4, 9),   title: '算法稳定币 UST 脱锚，LUNA 几天内归零',
    rt: 'BTC 跌破 $30,000',                   r: { k: 'lvl', sym: 'BTC', dir: -1, v: 30000, w: 14 }, chain: null,  congestion: null, warn: true },
  { t: Date.UTC(2022, 10, 11), title: '曾经的第二大交易所一周内挤兑破产',
    rt: 'BTC 跌破 $16,000',                   r: { k: 'lvl', sym: 'BTC', dir: -1, v: 16000, w: 21 }, chain: null,  congestion: null, warn: true },
  { t: Date.UTC(2023, 4, 7),   title: '把图片刻进区块的玩法突然流行，手续费暴涨',
    rt: '内存池再次排满，转账要等几十个块',      r: { k: 'cong', w: 2 },                              chain: 'btc',  congestion: { add: 40, days: 14, ramp: 2,   fall: 4 } },
  { t: Date.UTC(2024, 0, 10),  h: 20,
    title: '美国证监会放行 11 只现货 ETF',
    rt: 'BTC 重回 $47,000 上方',               r: { k: 'lvl', sym: 'BTC', dir: 1, v: 47000, w: 7 }, chain: 'btc',  congestion: null },
  { t: Date.UTC(2024, 3, 20),  title: '第四次减半：奖励降到 3.125；同日 Runes 上线',
    rt: 'BTC 减半后回落一成',                  r: { k: 'mv', sym: 'BTC', dir: -1, pct: 0.10, w: 21 }, chain: 'btc', congestion: { add: 45, days: 7,  ramp: 2,   fall: 4 } },
];

/**
 * 把时间戳换算成「第几根 K 线」（`s.i` 刻度）并按时间排序 —— 只算这一次，之后全是查表。
 * 锚点一律是 UTC 零点的整数倍小时，`Math.round` 只是防浮点毛刺。
 */
const ENTRIES = ANCHORS
  .map(a => ({ ...a, at: Math.round((a.t - GAME.start) / HOUR_MS) }))
  .sort((a, b) => a.at - b.at);

/** 全部锚点（已带 `at` 字段，供 K 线标记用） */
export const allAnchors = () => ENTRIES;

/** 第一条新闻的**基准时刻** = `at + h`；`K线标记 / 拥堵 / 预警`仍用 `at`，只有新闻走这个 */
const newsBaseOf = a => a.at + (a.h || 0);

/** 第一条新闻的播报时刻（含 `NEWS_DELAY`） */
const newsStartOf = a => newsBaseOf(a) + NEWS_DELAY;

/**
 * 第 `i` 根 K 线是否落在某条锚点的**新闻窗口**内（新闻用）。
 * 窗口 = `[newsStartOf(a), newsStartOf(a) + NEWS_HOURS)` —— 事件后 1 小时开始，见 `NEWS_DELAY`。
 * ⚠️ **只看第一条**：第二条的窗口长度由 `r.w` 决定，不在这个函数的职责里。
 * 锚点稀疏 ⇒ 至多命中一条，线性扫绰绰有余。
 * @returns {object|null} 命中的锚点（含 `at`），没命中返回 null
 */
export function anchorAt(i) {
  for (const a of ENTRIES) {
    const from = newsStartOf(a);
    if (i >= from && i < from + NEWS_HOURS) return a;
  }
  return null;
}

/**
 * 第 `i` 根 K 线是不是某条锚点**第一条新闻**的播报时刻（= `newsStartOf`）——
 * 引擎在**这一刻**把事件新闻写进 `s.log`（`engine.advanceOneHour`），窗口其余 23 根不再写。
 * ⚠️ 用 `===` 判等 ⇒ 天然**只命中一次**，不需要「已播过」状态位（同 `warnAnchorAt`）。
 * @returns {object|null} 命中的锚点（含 `at`），没命中返回 null
 */
export function newsStartAt(i) {
  for (const a of ENTRIES) if (i === newsStartOf(a)) return a;
  return null;
}

/* ═══════════════════════ 第二条 · 结果新闻（2026-10-01 拍板） ═══════════════════════ */

/**
 * 某条结果规格在 `k` 这一根上**是否成立**。
 * ⚠️ 价格一律走 `candleAt` / `closeAt`（**含玩家位移**）—— 这就是「动态」的来源：
 *    玩家把价推上去，判定跟着变；把价压住，它就永远不成立。
 * ⚠️ 币还没上线（`candleAt` 返回 null）一律当作**不成立**，绝不抛错。
 * @param {object} a 锚点（`mv` 要用它的 `at` 去取「事件日前一日收盘」）
 * @param {object} r 结果规格
 * @param {number} k 小时序号
 */
function hitAt(a, r, k) {
  if (r.k === 'cong') return false;           // 拥堵型不走价格，由 `congStartOf` 直接给时刻
  const c = candleAt(r.sym, k);
  if (!c) return false;
  if (r.k === 'lvl') return r.dir > 0 ? c.h >= r.v : c.l <= r.v;
  const pc = closeAt(r.sym, newsBaseOf(a) - 1);
  if (!pc) return false;
  return r.dir > 0 ? c.h / pc - 1 >= r.pct : c.l / pc - 1 <= -r.pct;
}

/** 拥堵型结果的播报时刻：拥堵**爬满**那一刻（`at + ramp 天 + NEWS_DELAY`） */
const congStartOf = (a, r) => a.at + r.w * 24 + NEWS_DELAY;

/**
 * 第 `i` 根 K 线是不是某条锚点**第二条 · 结果新闻**的播报时刻。
 *
 * 三条口径（缺一不可）：
 *   ① **在事情之后** —— 从「第一条播完那一小时」起扫，命中那根再 `+1h` 播 ⇒ 与第一条至少错开 **2 小时**
 *      （用户 2026-10-01 拍板：「不该次日，互联网新闻有时效性」，也不该两条同时）
 *   ② **动态** —— 判定走位移后价格（`hitAt`），玩家改写行情就会改写这条新闻的时点或有无
 *   ③ **不报假数** —— 窗口 `w` 内始终没触发 ⇒ 返回 null，这条结果新闻**静默不出现**
 *
 * ⚠️ 锚点稀疏：窗口外的锚点在头两行就 `continue` 掉了，只有窗口内的那几天才真扫（≤ 720 根）。
 * ⚠️ 扫描是**纯函数**（不缓存、不落状态）：上帝模式倒带回到过去时，判定自然跟着重算。
 * @returns {object|null} 命中的锚点（含 `rt`），没命中返回 null
 */
export function resultNewsStartAt(i) {
  for (const a of ENTRIES) {
    const r = a.r;
    if (!r || !a.rt) continue;
    if (r.k === 'cong') { if (i === congStartOf(a, r)) return a; continue; }
    const from = newsStartOf(a) + 1;          // ① 至少等第一条播完
    const to = newsStartOf(a) + r.w * 24;
    if (i < from + 1 || i > to + 1) continue; // 播报时刻 = 命中根 + 1
    /* 取**窗口内第一次**命中：价格在窗口里反复穿越同一价位（如 $64,000 上上下下）也只会播一条 */
    let first = -1;
    for (let k = from; k <= to; k++) if (hitAt(a, r, k)) { first = k; break; }
    if (first >= 0 && first + 1 === i) return a;
  }
  return null;
}

/**
 * 小时序号落在 `[lo, hi]` 内的锚点（K 线标记用）。
 * ⚠️ 入参是**小时序号**，不是视野里的数组下标 —— 日线模式下由调用方先换算（见 `render.js`）。
 */
export function anchorsInRange(lo, hi) {
  return ENTRIES.filter(a => a.at >= lo && a.at <= hi);
}

/** 进拥堵的那几条 —— `congestion.js` 唯一消费的子集（BTC 链 ＋ 有抬升值） */
export const congestionAnchors = () => ENTRIES.filter(a => a.congestion && a.chain === 'btc');

/* ═══════════════════════ 破产预警（v11 · ③） ═══════════════════════ */

/**
 * 预警锚点 —— `warn: true` 的那 6 条：会**重创杠杆仓**（大级别崩盘 / 交易所灾难）的事件。
 * 新手提示开着时，各自在 `at − 7 天` 弹一次遮罩 ＋ 暂停。
 *
 * ⚠️ 这是**范围**（哪些事值得打断玩家），不是**幅度** —— 与 P2-C 那条红线一致：
 *    锚点从不产生人工涨跌幅，崩盘本身就在真实小时线里。
 */
const WARN_ENTRIES = ENTRIES.filter(a => a.warn);

/** 预警提前量（**小时**）—— 与 `engine.js` 的 `WARN_LEAD`（毫秒）同为 7 天，这里换算成 `s.i` 的刻度 */
export const WARN_LEAD_HOURS = 7 * 24;

/**
 * 第 `i` 根 K 线是不是某条预警锚点的**预告时刻**（= `at − 7 天`）。
 * ⚠️ 用 `===` 判等 ⇒ 天然**只命中一次**，不需要额外的「已提醒过」状态位。
 * 锚点稀疏，线性扫绰绰有余。
 * @returns {object|null} 命中的锚点（含 `at`），没命中返回 null
 */
export function warnAnchorAt(i) {
  for (const a of WARN_ENTRIES) if (i === a.at - WARN_LEAD_HOURS) return a;
  return null;
}

/** 按 `at` 反查锚点 —— 渲染层拿 `s.warnAt` 取文案用（O(20)，每帧一次也无所谓） */
export const anchorOfAt = at => ENTRIES.find(a => a.at === at) || null;