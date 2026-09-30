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
 * ⚠️ 锚点是 `s.i` 的**纯函数**（同 P2-A 拥堵的 ①②）：不进存档、不升 `STATE_VERSION`。
 */

import { GAME, HOUR_MS } from './config.js';
import { rawCloseAt, HOURS_PER_DAY } from './market.js';
import { fmtPct } from './format.js';

/** 新闻在日志条上停留的游戏小时数。1 游戏日 —— 再长就会盖掉玩家自己的操作反馈。 */
export const NEWS_HOURS = 24;

/**
 * 新闻的**播报延迟**（游戏小时 · 口径 D，2026-09-29 拍板）。
 *
 * ⚠️ 为什么必须有它：新闻条的涨跌幅报的是**事件当天的极端值**，而这个数要等当天 24 根走完才算得出来。
 *    把新闻挂在 `at` 那一刻，等于在事件当天早上就把「当天最深跌 39%」提前告诉玩家 —— 那是**前视**。
 *    **事情发生了才会报道**：窗口整体后移一天。
 * ⚠️ 只有**新闻**后移。K 线标记（`anchorsInRange`）与链上拥堵（`congestionAnchors`）仍锚在 `at`：
 *    那两处要的是「事情发生在哪里」（标记画在事件那天、链就是那天堵的），不是「什么时候被报道」。
 */
export const NEWS_DELAY = 24;

/**
 * 锚点表。字段：
 *   `t`           UTC 时间戳（**日**粒度：时分秒一律为 0）
 *   `title`       新闻文案 —— 日志条只有一行且会 `text-overflow`，**越短越好**
 *   `chain`       `'btc' | 'eth' | null`；`null` ＝ 全市场事件（Luna / FTX）
 *   `congestion`  非空 ⇒ 该窗口给**链上转账**的抬升值；取值落在 GDD §6.4 的「+30 至 +60，3–10 天」内
 *   `warn`        真 ⇒ 该事件会**直接弄死人 / 重创杠杆仓**，提前 7 天弹遮罩 ＋ 暂停（v11 · ③）
 *
 * ⚠️ **只有 `chain === 'btc'` 且 `congestion` 非空的项会进拥堵**（见 `congestionAnchors`）：
 *    P2-A 的链上转账口径定死为 **BTC 链**（脉冲分母 = `liqOf('BTC', …)`，单一真相源），
 *    把 2016-09 的 ETH DoS 算进 BTC 的到账时间在因果上是错的 —— 如实留白比编一个数好。
 */
export const ANCHORS = [
  { t: Date.UTC(2013, 2, 16),  title: '塞浦路斯银行危机，BTC 冲上 $260',      chain: 'btc',  congestion: null },
  { t: Date.UTC(2013, 10, 18), title: '美国听证会放行，BTC 单日翻倍',         chain: 'btc',  congestion: null },
  { t: Date.UTC(2014, 1, 25),  title: 'Mt.Gox 被盗 85 万枚 BTC，停摆',        chain: 'btc',  congestion: null, warn: true },
  { t: Date.UTC(2015, 6, 7),   title: 'BTC 链被灌垃圾交易，转账排队数小时',    chain: 'btc',  congestion: { add: 40, days: 10, ramp: 2,   fall: 4 } },
  { t: Date.UTC(2016, 5, 17),  title: 'The DAO 被盗，以太坊分叉出 ETC',        chain: 'eth',  congestion: null, warn: true },
  { t: Date.UTC(2016, 6, 9),   title: '比特币减半：区块奖励 25 → 12.5',        chain: 'btc',  congestion: null },
  { t: Date.UTC(2016, 8, 22),  title: '以太坊遭 DoS 攻击，区块处理变慢',        chain: 'eth',  congestion: null },
  { t: Date.UTC(2017, 4, 1),   title: 'BTC 破 $2,000，链上首次大拥堵',         chain: 'btc',  congestion: { add: 40, days: 10, ramp: 2,   fall: 4 } },
  { t: Date.UTC(2017, 7, 1),   title: '扩容硬分叉，1:1 空投 BCH',              chain: 'btc',  congestion: null },
  { t: Date.UTC(2017, 11, 1), title: 'ICO 狂潮 ＋ 加密猫把链堵死',            chain: 'btc',  congestion: { add: 70, days: 10, ramp: 2,   fall: 4 } },
  { t: Date.UTC(2018, 11, 15), title: '泡沫破裂：BTC 跌到 $3,129',            chain: 'btc',  congestion: null, warn: true },
  { t: Date.UTC(2020, 2, 12),  title: '新冠崩盘，BTC 单日腰斩',                chain: 'btc',  congestion: null, warn: true },
  { t: Date.UTC(2020, 4, 11),  title: '比特币减半：区块奖励 12.5 → 6.25',      chain: 'btc',  congestion: null },
  { t: Date.UTC(2021, 3, 1),   title: '牛市高峰，BTC 破 $64,000',              chain: 'btc',  congestion: { add: 45, days: 7,  ramp: 1.5, fall: 2.5 } },
  { t: Date.UTC(2021, 10, 10), title: '双顶：BTC 创 $69,000 新高',             chain: 'btc',  congestion: null },
  { t: Date.UTC(2022, 4, 9),   title: 'Luna 崩盘，$80 一路归零',               chain: null,   congestion: null, warn: true },
  { t: Date.UTC(2022, 10, 11), title: 'FTX 破产，BTC 跌到 $15,500',            chain: null,   congestion: null, warn: true },
  { t: Date.UTC(2023, 4, 7),   title: 'Ordinals 铭文潮，手续费暴涨',           chain: 'btc',  congestion: { add: 40, days: 14, ramp: 2,   fall: 4 } },
  { t: Date.UTC(2024, 0, 10),  title: '现货 ETF 获批，BTC 重回 $45,000',      chain: 'btc',  congestion: null },
  { t: Date.UTC(2024, 3, 20),  title: '减半 ＋ Runes 上线，手续费暴涨',         chain: 'btc',  congestion: { add: 45, days: 7,  ramp: 2,   fall: 4 } },
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

/**
 * 第 `i` 根 K 线是否落在某条锚点的**新闻窗口**内（新闻用）。
 * 窗口 = `[at + NEWS_DELAY, at + NEWS_DELAY + NEWS_HOURS)` —— 后移一天，见 `NEWS_DELAY`。
 * 锚点稀疏 ⇒ 至多命中一条，线性扫绰绰有余。
 * @returns {object|null} 命中的锚点（含 `at`），没命中返回 null
 */
export function anchorAt(i) {
  for (const a of ENTRIES) {
    const from = a.at + NEWS_DELAY;
    if (i >= from && i < from + NEWS_HOURS) return a;
  }
  return null;
}

/**
 * 第 `i` 根 K 线是不是某条锚点新闻的**窗口起点**（= `at + NEWS_DELAY`）——
 * 引擎在**这一刻**把新闻写进 `s.log`（`engine.advanceOneHour`），窗口其余 23 根不再写。
 * ⚠️ 用 `===` 判等 ⇒ 天然**只命中一次**，不需要「已播过」状态位（同 `warnAnchorAt`）。
 * @returns {object|null} 命中的锚点（含 `at`），没命中返回 null
 */
export function newsStartAt(i) {
  for (const a of ENTRIES) if (i === a.at + NEWS_DELAY) return a;
  return null;
}

/**
 * 新闻条的「当天涨跌幅」后缀（P2-C）。
 *
 * **方向随收盘走** —— 当天收红就报最高涨（「单日翻倍」是 +40%，而不是「最深 −0.2%」），
 * 收绿就报最深跌（Mt.Gox / 新冠崩盘那几条才显示得出 −19% / −39%）。
 * 只报「最深跌」会把上涨类锚点全报成近乎零的噪声（实测 20 条里近一半与标题相反）。
 *
 * ⚠️ **无前视**：这个数要等当天 24 根全部走完才存在，所以新闻整段后移一天（`NEWS_DELAY`）。
 * ⚠️ 走 `rawCloseAt`（不含价格位移）：那是玩家自己的单，与「历史上发生了什么」无关。
 * 取不到（该币此刻还没上线 / 行情未加载）时整段省略 —— 不报一个半截的数。
 */
export function newsMove(news) {
  const sym = news.chain === 'eth' ? 'ETH' : 'BTC';
  const base = rawCloseAt(sym, news.at - 1);
  if (!(base > 0)) return '';

  let hi = -Infinity;
  let lo = Infinity;
  let last = 0;
  for (let k = 0; k < HOURS_PER_DAY; k++) {
    const c = rawCloseAt(sym, news.at + k);
    if (!(c > 0)) return '';
    const r = c / base - 1;
    if (r > hi) hi = r;
    if (r < lo) lo = r;
    last = r;
  }
  return ` ｜ ${sym} ${fmtPct(last >= 0 ? hi : lo, 1)}`;
}

/** 新闻的完整正文 —— **写入 `s.log` 的那一句就是日志条上显示的那一句**（同一份真源，两处共用） */
export const newsTextOf = news => `${news.title}${newsMove(news)}`;

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
 * 预警锚点 —— `warn: true` 的那 6 条：会**直接弄死人**（交易所归零，目前只有 Mt.Gox）
 * 或**重创杠杆仓**（大级别崩盘）的事件。新手提示开着时，各自在 `at − 7 天` 弹一次遮罩 ＋ 暂停。
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