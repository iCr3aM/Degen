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

/** 新闻在日志条上停留的游戏小时数。1 游戏日 —— 再长就会盖掉玩家自己的操作反馈。 */
export const NEWS_HOURS = 24;

/**
 * 锚点表。字段：
 *   `t`           UTC 时间戳（**日**粒度：时分秒一律为 0）
 *   `title`       新闻文案 —— 日志条只有一行且会 `text-overflow`，**越短越好**
 *   `chain`       `'btc' | 'eth' | null`；`null` ＝ 全市场事件（Luna / FTX）
 *   `congestion`  非空 ⇒ 该窗口给**链上转账**的抬升值；取值落在 GDD §6.4 的「+30 至 +60，3–10 天」内
 *
 * ⚠️ **只有 `chain === 'btc'` 且 `congestion` 非空的项会进拥堵**（见 `congestionAnchors`）：
 *    P2-A 的链上转账口径定死为 **BTC 链**（脉冲分母 = `liqOf('BTC', …)`，单一真相源），
 *    把 2016-09 的 ETH DoS 算进 BTC 的到账时间在因果上是错的 —— 如实留白比编一个数好。
 */
export const ANCHORS = [
  { t: Date.UTC(2013, 2, 16),  title: '塞浦路斯银行危机，BTC 冲上 $260',      chain: 'btc',  congestion: null },
  { t: Date.UTC(2013, 10, 18), title: '美国听证会放行，BTC 单日翻倍',         chain: 'btc',  congestion: null },
  { t: Date.UTC(2014, 1, 25),  title: 'Mt.Gox 被盗 85 万枚 BTC，停摆',        chain: 'btc',  congestion: null },
  { t: Date.UTC(2015, 6, 7),   title: 'BTC 链被灌垃圾交易，转账排队数小时',    chain: 'btc',  congestion: { add: 40, days: 10, ramp: 2,   fall: 4 } },
  { t: Date.UTC(2016, 5, 17),  title: 'The DAO 被盗，以太坊分叉出 ETC',        chain: 'eth',  congestion: null },
  { t: Date.UTC(2016, 6, 9),   title: '比特币减半：区块奖励 25 → 12.5',        chain: 'btc',  congestion: null },
  { t: Date.UTC(2016, 8, 22),  title: '以太坊遭 DoS 攻击，区块处理变慢',        chain: 'eth',  congestion: null },
  { t: Date.UTC(2017, 4, 1),   title: 'BTC 破 $2,000，链上首次大拥堵',         chain: 'btc',  congestion: { add: 40, days: 10, ramp: 2,   fall: 4 } },
  { t: Date.UTC(2017, 7, 1),   title: '扩容硬分叉，1:1 空投 BCH',              chain: 'btc',  congestion: null },
  { t: Date.UTC(2017, 11, 1), title: 'ICO 狂潮 ＋ 加密猫把链堵死',            chain: 'btc',  congestion: { add: 70, days: 10, ramp: 2,   fall: 4 } },
  { t: Date.UTC(2018, 11, 15), title: '泡沫破裂：BTC 跌到 $3,129',            chain: 'btc',  congestion: null },
  { t: Date.UTC(2020, 2, 12),  title: '新冠崩盘，BTC 单日腰斩',                chain: 'btc',  congestion: null },
  { t: Date.UTC(2020, 4, 11),  title: '比特币减半：区块奖励 12.5 → 6.25',      chain: 'btc',  congestion: null },
  { t: Date.UTC(2021, 3, 1),   title: '牛市高峰，BTC 破 $64,000',              chain: 'btc',  congestion: { add: 45, days: 7,  ramp: 1.5, fall: 2.5 } },
  { t: Date.UTC(2021, 10, 10), title: '双顶：BTC 创 $69,000 新高',             chain: 'btc',  congestion: null },
  { t: Date.UTC(2022, 4, 9),   title: 'Luna 崩盘，$80 一路归零',               chain: null,   congestion: null },
  { t: Date.UTC(2022, 10, 11), title: 'FTX 破产，BTC 跌到 $15,500',            chain: null,   congestion: null },
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
 * 窗口 = `[at, at + NEWS_HOURS)`；锚点稀疏 ⇒ 至多命中一条，线性扫绰绰有余。
 * @returns {object|null} 命中的锚点（含 `at`），没命中返回 null
 */
export function anchorAt(i) {
  for (const a of ENTRIES) if (i >= a.at && i < a.at + NEWS_HOURS) return a;
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