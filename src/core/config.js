/**
 * 全局常量 —— **运行时与抓数脚本共用的唯一真相源**
 * ===============================================================
 * 为什么放在 `src/core/` 而不是 `tools/`：`tools/fetch-data.mjs` 需要知道
 * 「每个币种在游戏里什么时候解锁、数据从哪来」，而游戏运行时需要知道
 * 「每个币种什么时候解锁」。这两件事必须是**同一份表** —— 否则抓数脚本按 A 口径切数据、
 * 游戏按 B 口径解锁，就会出现「解锁了但没数据」的黑洞（GDD §8.2）。
 *
 * ⚠️ 本文件必须保持**纯 ESM + 零依赖 + 不碰任何浏览器/Node API**，
 *    否则 Node 侧 import 会炸。
 */

/** 一小时 = 3600 秒；整个时间轴的唯一刻度（GDD §11） */
export const HOUR_MS = 3600e3;

/** 时间轴与初始条件（GDD §1.4 / §11） */
export const GAME = {
  /** 开盘：2013-01-01 00:00 UTC */
  start: Date.UTC(2013, 0, 1),
  /** 收盘：2024-12-31 23:00 UTC 为最后一根 K 线，所以排他上界是 2025-01-01 00:00 UTC */
  end: Date.UTC(2025, 0, 1),
  /** 12 年 = 4383 天 = 105,192 根小时 K */
  candles: (Date.UTC(2025, 0, 1) - Date.UTC(2013, 0, 1)) / HOUR_MS,
  /** 初始资金 $3,000 USDT */
  cash: 3000,
  /** 开局资金放在哪家交易所（GDD §7.2：2013 年只有 Mt.Gox 一个选择） */
  ex: 'mtgox',
  /** 维持保证金率 0.5%（GDD §9.2） */
  maintRate: 0.005,
};

/**
 * 5 个核心币种（GDD §8.1 / §8.2）—— LTC / BNB / ADA / DOT / AVAX 已彻底删除
 *
 * `unlock` = 游戏内解锁时刻 = 该币数据包的第一根 K 线。两者共用同一个数：
 * 数据包从 `unlock` 那一刻开始逐小时铺满，游戏在 `unlock` 之前根本不显示这个币。
 *
 * ⚠️ `unlock` 不是「预期上线日」，而是**实测出来的「第一根真实小时 K 线」所在整点**
 *    （2026-09-28 逐个读原始 CSV / 归档确认）。抓数脚本会用同一口径复验一遍：
 *    若实测起点晚于这里写的值，脚本会裁掉前面的空档、以实测值写进 `index.json`，
 *    并打一条警告 —— 那时**这个文件要跟着改**。两边一旦不一致，就会出现
 *    GDD §8.2 警告的「解锁了但没数据」黑洞（游戏侧读这里，数据侧读 index.json）。
 *
 * `src` 是**官方 API** 的数据源标识，按可信度/粒度排序取用（抓数脚本按这个顺序依次补洞）：
 *   - `bitstamp`：Bitstamp v2 OHLC，小时线，USD 本位（BTC 全程 2013-01 起）
 *   - `bitfinex`：Bitfinex v2 candles，小时线，USD 本位
 *   - `binance` ：Binance v3 klines，小时线，从各币上币日起
 *   - `binanceus`：Binance.US v3 klines，接口同形但是**另一家交易所**。只当补洞源，
 *                 目前仅 SOL 用 —— Binance 自家缺的那 20 个小时它有
 * `cdd` 是**归档 CSV**（CryptoDataDownload）的补充源，用来填官方 API 给不出的早期年份：
 *   - `quote: 'USDT'`：美元/稳定币计价的小时线 CSV，直接铺
 *   - `quote: 'BTC'` ：BTC 计价的小时线 CSV，脚本乘以同一时刻的 BTC/USD 换回美元
 * **日线插值与平线补齐已整块删除**：五个币全部有真小时线，脚本不再造任何一根 K 线。
 *
 * 实测起点（2026-09-28 逐文件复测，全部零成本、无需 key）：
 *   BTC  Bitstamp `btcusd`        2013-01-01 00:00（全程 105,192 根，无缺口）
 *   DOGE Poloniex `DOGE/BTC` 1h   2014-01-21 22:00（×BTC/USD 换算）
 *   XRP  Poloniex `XRP/BTC`  1h   2014-08-14 03:00（×BTC/USD 换算）
 *   ETH  Poloniex `ETH/USDT` 1h   2015-08-08 06:00（美元直盘，不换算）
 *   SOL  Binance  `SOLUSDT`       2020-08-11 06:00（缺的 20 小时由 Binance.US `SOLUSD` 补齐）
 */
export const COINS = [
  { sym: 'BTC',  name: '比特币',  unlock: Date.UTC(2013, 0, 1, 0),  src: { bitstamp: 'btcusd', bitfinex: 'tBTCUSD', binance: 'BTCUSDT',  binanceus: null } },
  { sym: 'DOGE', name: '狗狗币',  unlock: Date.UTC(2014, 0, 21, 22), src: { bitstamp: null,     bitfinex: null,      binance: 'DOGEUSDT', binanceus: null },
    cdd: [{ file: 'Poloniex_DOGEUSDT_1h.csv', quote: 'USDT' }, { file: 'Poloniex_DOGEBTC_1h.csv', quote: 'BTC' }] },
  { sym: 'XRP',  name: '瑞波币',  unlock: Date.UTC(2014, 7, 14, 3),  src: { bitstamp: 'xrpusd', bitfinex: null,      binance: 'XRPUSDT',  binanceus: null },
    cdd: [{ file: 'Poloniex_XRPUSDT_1h.csv', quote: 'USDT' }, { file: 'Poloniex_XRPBTC_1h.csv', quote: 'BTC' }] },
  { sym: 'ETH',  name: '以太坊',  unlock: Date.UTC(2015, 7, 8, 6),   src: { bitstamp: 'ethusd', bitfinex: null,      binance: 'ETHUSDT',  binanceus: null },
    cdd: [{ file: 'Poloniex_ETHUSDT_1h.csv', quote: 'USDT' }] },
  { sym: 'SOL',  name: 'Solana',  unlock: Date.UTC(2020, 7, 11, 6),  src: { bitstamp: null,     bitfinex: null,      binance: 'SOLUSDT',  binanceus: 'SOLUSD' } },
];

/** 按符号取币种定义 */
export const coinOf = sym => COINS.find(c => c.sym === sym) || null;

/**
 * 四家交易所（GDD §7.1 / §7.2）—— 全是**史实里的真名**，玩家一眼能对上当年的新闻。
 *
 * 每家三个字段：
 *   - `open` / `close`：开业与归零时刻（`close: null` = 活到现在）。
 *     `close` 不只是「不能再用」的标记，还是**归零事件**的触发点（见 `engine.advanceOneHour`）：
 *     到点那一刻，该所余额清零、挂在该所的持仓一并作废。Mt.Gox 的 2014-02-25 就是本作最重的一记闷棍。
 *   - `steps`：杠杆上限阶梯，升序取「最后一个 `from <= t`」。**上限只随所选交易所**，不再按年份。
 *   - `fee`  ：吃单费率（单边），开仓与平仓各收一次。
 *
 * 史实出处（2026-09-28 核实，勿再凭记忆改动）：
 *   Mt.Gox   2014-02-25 停止一切交易（本项目以这天为归零点），此前仅现货 1x
 *   Bitfinex 2013 年上线即 3.3x；2020-01-30 → 5x；2021-02-17 → 10x（均为官方公告）
 *   BitMEX   2014 年 3x；**2016-05-13 XBTUSD 永续上线才给到 100x**
 *            （2015-10 的 100x 属于季度交割合约，本作实现的是线性 USDT 本位永续，故挂在永续上线日）
 *   Binance  2017-07-14 上线，起初仅现货；2019-09-01 起提供 20x
 */
export const EXCHANGES = [
  {
    id: 'mtgox', name: 'Mt.Gox',
    open: Date.UTC(2013, 0, 1), close: Date.UTC(2014, 1, 25),
    steps: [{ from: Date.UTC(2013, 0, 1), max: 1 }],
    fee: 0.002,
  },
  {
    id: 'bitfinex', name: 'Bitfinex',
    open: Date.UTC(2013, 0, 1), close: null,
    steps: [
      { from: Date.UTC(2013, 0, 1),  max: 3.3 },
      { from: Date.UTC(2020, 0, 30), max: 5 },
      { from: Date.UTC(2021, 1, 17), max: 10 },
    ],
    fee: 0.001,
  },
  {
    id: 'bitmex', name: 'BitMEX',
    open: Date.UTC(2014, 0, 1), close: null,
    steps: [
      { from: Date.UTC(2014, 0, 1),  max: 3 },
      { from: Date.UTC(2016, 4, 13), max: 100 },
    ],
    fee: 0.0005,
  },
  {
    id: 'binance', name: 'Binance',
    open: Date.UTC(2017, 6, 14), close: null,
    steps: [
      { from: Date.UTC(2017, 6, 14), max: 1 },
      { from: Date.UTC(2019, 8, 1),  max: 20 },
    ],
    fee: 0.0004,
  },
];

/** 按 id 取交易所定义 */
export const exchangeOf = id => EXCHANGES.find(e => e.id === id) || null;

/** 某一时刻**可以选**的交易所（已开业且未归零） */
export function exchangesAt(t) {
  return EXCHANGES.filter(e => e.open <= t && (e.close == null || t < e.close));
}

/** 某一时刻、某家交易所的最高杠杆 */
export function maxLeverageAt(t, exId) {
  const ex = exchangeOf(exId);
  if (!ex) return 1;
  let max = 1;
  for (const s of ex.steps) { if (s.from <= t) max = s.max; else break; }
  return max;
}

/** 可选杠杆档位：从 1 到当前上限，取这几个常用值（GDD §18.1 的杠杆选择器） */
const LEV_LADDER = [1, 2, 3, 5, 10, 20, 50, 100];

/** 某一时刻、某家交易所可选的杠杆档位（1 与上限必在列表内） */
export function leverageOptionsAt(t, exId) {
  const max = maxLeverageAt(t, exId);
  const out = LEV_LADDER.filter(v => v <= max);
  if (!out.includes(max)) out.push(max);   // 上限不是整数档时直接补进来（Bitfinex 史实 3.3x）
  if (!out.includes(1)) out.unshift(1);
  return out;
}

/** 某家交易所的费率 */
export const feeRateOf = exId => {
  const ex = exchangeOf(exId);
  return ex ? ex.fee : 0.002;
};

/** 数据包目录（public 下的静态资源，打包时原样拷贝到 dist/data/） */
export const DATA_DIR = 'data';

/**
 * 资金费率的**年代化溢价上限**（Batch 4 · B18，2026-09-29）。
 *
 * 史实依据：真实资金费率不是常数，不同年代的「癫狂程度」差一个数量级 ——
 *   - **2013 ~ 2018**：BitMEX 早期（XBTUSD 2016-05 上线）费率经常 >0.2%/8h（年化 >200%），
 *     2017 年 12 月那种行情里更是天天顶格 ⇒ 上限取 **0.5%/8h**
 *   - **2019 ~ 2021**：DeFi 夏季的高费率年代，狂热但比早期收敛 ⇒ **0.3%/8h**
 *   - **2022 起**：现代常态，92–93% 的时间贴在 0.01%/8h ⇒ **0.1%/8h**
 *
 * ⚠️ 它夹的是**溢价指数**（`positions.premiumOf`），不是最终费率；
 *    最终费率 = 溢价 + clamp(0.01% − 溢价, ±0.05%)，所以上界比这里略低一点（如 0.5% → 0.45%）。
 */
export function fundingPremiumCapAt(t) {
  if (t < Date.UTC(2019, 0, 1)) return 0.005;
  if (t < Date.UTC(2022, 0, 1)) return 0.003;
  return 0.001;
}
