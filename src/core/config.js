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
  /**
   * 初始资金 $1,000 **USD（美元法币，不是 USDT）** —— 两格账本的口径见方案 §2。
   *
   * ⚠️ **平衡性实测（2026-10-01）**：开局资金是**纯缩放旋钮**，不是难度旋钮 ——
   *    12 种玩法 × 5 档本金全时间线跑下来，归零率 / 归零时点 / 回撤曲线与它**完全无关**，
   *    终值近似严格成正比（本金 ×10 ⇒ 终值 ×9.63，规模惩罚约 4%，来自 `FLOAT` 抛压折价
   *    与 `SHOCK` 订单冲击）。唯一的非比例项是 $20 电汇（$1000 时占 2.0%）。
   *    ⇒ 取 $1,000 是**叙事与节奏**的选择（「我只有一千块」），不是平衡的选择。
   */
  cash: 1000,
  /** 开局资金放在哪家交易所（GDD §7.2）—— 本作全程只做杠杆与合约，开局站在 Bitfinex */
  ex: 'bitfinex',
  /**
   * 维持保证金率的**兜底值** 0.5%（B18 起不再是「全所恒定值」）——
   * 真实取值按「所 × 工具 × 名义档」走 `maintRateAt()`，这里只服务
   * 「没有分档表的所」与「非 Binance 永续」这两条缺省路径。
   */
  maintRate: 0.005,
  /**
   * 全局随机种子（S0 · 细粒度模拟的地基）—— 本局**所有**随机数的唯一源头。
   * 现在取**常量**：同一份档、同一时刻、同一币种永远生成同一条 tick 流（可复现 / 可回放 / 可断点续算）。
   * ⚠️ 肉鸽化的「种子局 / 每日挑战」（每局随机 / 按日期固定）在 **S4** 做，届时改由玩家输入或日期派生。
   */
  seed: 1,

  /**
   * 默认下单模式（U1 · ROADMAP §21.4）—— `'margin'`（杠杆）或 `'fut'`（合约）。
   * 开局默认 **`'margin'`**：玩家不动操作区那枚「模式」键时，走的是**杠杆通道**。
   * ⚠️ 本作**没有现货这个概念**：「杠杆」只是最低 1x 的一档（1x 多头不计息、不参与强平；
   *    1x 空头借了全额币 ⇒ 照常计息、照常有强平线），真正的分野是 `margin`（借贷口径）
   *    与 `fut`（永续口径）两条产品线。
   * ⚠️ 这里只是**默认值**；真实生效的模式存在 `s.mode` 里（入存档，玩家可随时切换）。
   */
  mode: 'margin',
};

/* ══════════════ 年代开局（挑战模式 · M1 · 2026-10-01 用户拍板「6 局全要」） ══════════════
 *
 * 「在同一套真实行情里，**换个年代重新开始**」—— 不改任何机制，只换三个起点：
 *   ① 从哪一年开始（`at`）② 开局多少钱（`cash`）③ 开局站在哪家所（`ex`）。
 *
 * ⚠️ **为什么这么便宜**：`s.i` 是全项目**唯一的时间真相源** —— 日期、行情、币种解锁、锚点、
 *    手续费、杠杆上限、OTC 开放、最小下单额全是 `timeOf(s)` 的纯函数。所以年代开局
 *    不需要「快进重放」，只需要把 `s.i` 的起点设成那一年的序号，其余一切自动对上。
 *
 * ⚠️ **三处必须跟着动的派生量**（漏一处就会画错图，见 ROADMAP §五十六）：
 *    ① `state.cash0` —— 资金曲线基准线、HUD 涨跌着色的分界（原来是硬编码的 `GAME.cash`）
 *    ② `state.day0` —— `sampleEquity` 的下标原点（否则 2021 开局第一帧就塞 2922 个假平点）
 *    ③ 开局所必须在那一年**活着**（`EXCHANGES[].open / close`），且开局那格钱走 `cashCurAt`
 *
 * `challenge: true` ⇒ **挑战模式**（除「经典全程」外的全部年代局）：
 *    归零**不发救济金**（用户 2026-10-01 拍板）—— 年代局的本金与年代都是玩家自己挑的，
 *    再发一笔 $1,000 等于把挑战抹平（$10 开局尤其荒唐：救济金是爆赚 100 倍）。
 *    判定收口在 `engine.checkRuin`，别在别处另判。
 *
 * `from` / `to` 只是**显示用的年月**，不是时间数据 —— 真正的起点是 `at`、真正的终点是 `end`。
 * 全部起点都落在 UTC 零点（`GAME.start` 也是），所以 `s.i` 起点必为整数。
 *
 * ⚠️ **v26（§73.7 · 2026-10-02 用户拍板）**：挑战局不再陪跑到 2024-12 —— 时长收到 **2–4 个月**，
 *    「要的就是快速来一把的感觉」。`end` 是**排他上界**（＝最后一根 K 线之后那一小时的序号），
 *    结算点落在该局主题事件**之后**。经典全程的 `end` 就是 `GAME.end`，与改动前**逐位相同**。
 * ⚠️ `end` 与 `at` 一样走 `Date.UTC`，且必须落在**整点**上（`scenarioEndIndex` 直接做除法）。
 */
export const SCENARIOS = [
  {
    id: 'classic', name: '经典全程', from: '2013-01', to: '2024-12',
    at: Date.UTC(2013, 0, 1), end: Date.UTC(2025, 0, 1),
    cash: 1000, ex: 'bitfinex', challenge: false,
    blurb: '从 Bitfinex 开盘走到币安收盘，12 年全程。',
  },
  {
    id: 'winter', name: '冰封寒冬', from: '2015-01', to: '2015-04',
    at: Date.UTC(2015, 0, 1), end: Date.UTC(2015, 4, 1),
    cash: 1000, ex: 'bitfinex', challenge: true,
    blurb: '行情冰封、信心尽失，你带着 $1,000 从头再来。',
  },
  {
    id: 'ico', name: 'ICO 狂潮', from: '2017-09', to: '2017-12',
    at: Date.UTC(2017, 8, 1), end: Date.UTC(2018, 0, 1),
    cash: 1000, ex: 'bitfinex', challenge: true,
    blurb: '2017 年 ICO 狂潮，Bitfinex 上只有 3.3x —— 但泡沫管够。',
  },
  {
    id: 'pre312', name: '312 前夜', from: '2020-02', to: '2020-04',
    at: Date.UTC(2020, 1, 20), end: Date.UTC(2020, 4, 1),
    cash: 1000, ex: 'bitmex', challenge: true,
    blurb: '距离「黑色星期四」还有 21 天，BitMEX 的 100x 合约就在手边。',
  },
  {
    id: 'degen', name: '10U 战神', from: '2021-01', to: '2021-04',
    at: Date.UTC(2021, 0, 1), end: Date.UTC(2021, 4, 1),
    cash: 10, ex: 'binance', challenge: true,
    blurb: '牛市顶点，兜里只有 $10。',
  },
  {
    id: 'luna', name: 'LUNA 归零周', from: '2022-05', to: '2022-07',
    at: Date.UTC(2022, 4, 1), end: Date.UTC(2022, 7, 1),
    cash: 1000, ex: 'binance', challenge: true,
    blurb: 'UST 脱锚前 8 天。',
  },
];

/** 默认局（无档直开、旧档回落）—— 未指定年代时一律回落到它 */
export const DEFAULT_SCENARIO = SCENARIOS[0].id;

/** 按 id 取年代定义；取不到（含 `undefined` / 已删除的 id）**回落到经典全程**，不抛错 */
export const scenarioOf = id => SCENARIOS.find(x => x.id === id) || SCENARIOS[0];

/** 这一局是不是挑战模式（＝除经典全程外的年代局）—— 见上面 `challenge` 那段 */
export const isChallenge = id => scenarioOf(id).challenge;

/** 年代开局的第一根小时 K 序号（`s.i` 的起点）—— 起点全落在 UTC 零点，必为整数 */
export const scenarioStartIndex = id => Math.round((scenarioOf(id).at - GAME.start) / HOUR_MS);

/**
 * 本局的**终点**小时序号（`s.i` 的排他上界，§73.7）—— 走到它即结算，最后一根是 `endI − 1`。
 * 经典全程 = `GAME.candles`（与改动前逐位相同）；挑战局 = 各主题事件之后 2–4 个月。
 */
export const scenarioEndIndex = id => Math.round((scenarioOf(id).end - GAME.start) / HOUR_MS);

/**
 * 速度档（GDD §11）—— 2026-09-29 由 `1/2/5/10/20/50` 收窄为 **`1/5/10/50`**：
 *   - `2x` 与 `1x` 只差一倍，「稍快一点」1x→5x 已覆盖 ⇒ 删
 *   - `20x` 在 50x 就位后从「最快」退成「次快」，与 10x 同属「快进」⇒ 删
 * 留下的四档各司其职：1x 盯盘（定义性锚点：1 游戏小时 ＝ 1 真实秒）/ 5x 读盘上限（0.2 秒每根）/
 * 10x 中速（一天 2.4 秒，实战最常用）/ 50x 唯一快进（全程约 35 分钟）。
 *
 * ⚠️ **唯一真源**：`render.js` 用它画按钮。
 *    本轮起存档**不做兼容**（版本不符直接丢弃重开），所以不再需要「校正旧档里已删档位」那一步。
 */
export const SPEEDS = [1, 5, 10, 50];

/**
 * 细粒度刻度（S1 · 细粒度模拟）—— **每 1 根真实小时 K 展开成多少根细刻度**。
 *
 * 主干选 **30 秒 ⇒ 120 根**（`ROADMAP.MD` §19.4 / `细粒度模拟与RNG方案.md` §7）：
 *   - 12 年 ≈ 1,261 万根 tick —— 懒生成 ＋ 缓存扛得住；1 秒（3.78 亿）不现实，不做
 *   - ⚠️ **细刻度只用来定「爆仓落在哪一 tick、什么价」**（`engine.js` 的 S3 口径），
 *     **不再有对应的显示档** —— 30 秒档已于 2026-10-01 整体移除（`ROADMAP.MD` §四十）
 *   - ⚠️ **`s.i` 语义不变**（仍是绝对小时序号）⇒ 锚点 / 资金费 / 借贷 / 存档全部零改动；
 *     tick 只是「小时内部的采样放大」，**不进存档、不进数据包**（`public/data/*.bin` 仍每根 17 字节）
 *   - ⚠️ **不改 `SPEEDS`**：1x 仍是「1 游戏小时 ＝ 1 真实秒」，时间推进与观察粒度**解耦**
 *
 * 唯一消费者：`simulate.js`（`TICK.perHour` ＝ 细路径的段数 N）。
 */
export const TICK = {
  /** 每根小时 K 内的细刻度数（120 ⇒ 30 秒） */
  perHour: 120,
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
 * `otc` = 该币**首次能走场外大宗（OTC）**的时刻（P2-B 修订 · GDD §15.3）——
 * 与 `unlock` 是两件独立的事：币早上线、OTC 台却要等很多年才做到它。
 *   BTC 2013-01（`#bitcoin-otc` 2010 年就在做、Genesis 2013 建台 ⇒ 开盘即有，不设等待）
 *   ETH 2016-06（Circle 原话「2016 Ethereum gets interesting」，ICO 潮年中）
 *   XRP / DOGE 2018-01（Circle Trade 2018 覆盖 36 种）
 *   SOL 2021-01（2020-03 主网上线、2020-08 上线币安，2021 年机构台普遍覆盖主流山寨）
 * ⚠️ 这四档是**史料推断的近似锚点**，没有一手的「X 币首次在 OTC 台成交」记录。
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
 * `votes` 是**只投票、不定成交量**的额外小时源（`[{ exch, pair }]`，目前只有 Bitfinex）。
 *   ⚠️ 它排在**整条优先级链的最末**（Kraken 之后），所以：
 *     ① 永远不会成为该小时的「主源」⇒ **成交量口径与 `liq.bin` 逐位不变**；
 *     ② 只在「该小时已经 ≥3 家报价」时才真正改变结果（`medoid` 取中位），
 *        恰好 2 家时按优先级取前者 ⇒ 与加它之前逐位一致。
 *   存在的理由：ETH 2015-08→2017-08 那两年只有 Poloniex ＋ Kraken 两家，
 *   恰好 2 票时 `medoid` 恒取 Poloniex、Kraken 那票等于白投 —— Bitfinex 的
 *   `tETHUSD`（2016-03-09 起）补上第三票，这两年才谈得上「投票」。
 *   ⚠️ Bitfinex 的配对名有个坑：**DOGE 是 `tDOGE:USD`**（带冒号），不是 `tDOGEUSD`。
 * **日线插值与平线补齐已整块删除**：五个币全部有真小时线，脚本不再造任何一根 K 线。
 *
 * 实测起点（2026-09-28 逐文件复测，全部零成本、无需 key）：
 *   BTC  Bitstamp `btcusd`        2013-01-01 00:00（全程 105,192 根，无缺口）
 *   DOGE Poloniex `DOGE/BTC` 1h   2014-01-21 22:00（×BTC/USD 换算）
 *   XRP  Poloniex `XRP/BTC`  1h   2014-08-14 03:00（×BTC/USD 换算）
 *   ETH  Poloniex `ETH/USDT` 1h   2015-08-08 06:00（美元直盘，不换算）
 *   SOL  Binance  `SOLUSDT`       2020-08-11 06:00（缺的 20 小时由 Binance.US `SOLUSD` 补齐）
 *
 * ⚠️ 表里的交易所名 ＝ **本项目实际取到第一根小时线的那一家**（数据源顺序见上），
 *    不等于该币在现实里首次上线的交易所 —— 本作不为「首发所」建模，只按能拿到的真小时线铺。
 */
export const COINS = [
  /* ⚠️ BTC 的 `unlock` **早于 `GAME.start`**（2026-09-30 定的回溯段）——
     它是**数据回溯起点**，不是「游戏里能交易的时刻」：游戏照样 2013-01-01 开盘、照样 $1,000 起步。
     为什么要这一段：`GAME.start` 那一刻图上只有 1 根 K 线（左半边全空）、`24h 涨跌幅` 无参照、
     `σ_30日` 只能走兜底 3%。补 **96 天**（2,304 根，见下）刚好填满一屏 1d 视野（`view.defaultCount` 上限 96）。
     ⚠️ 这一段**不是日线插值**，是 Bitstamp 同一接口、同一 `btcusd` 交易对的**真小时线**
     （实测可回溯到 2011-08-19 00:00；这里只取到 2012-09-27，够用又不冗余）。 */
  { sym: 'BTC',  name: '比特币',  unlock: Date.UTC(2012, 8, 27, 0),  otc: Date.UTC(2013, 0, 1),  src: { bitstamp: 'btcusd', bitfinex: 'tBTCUSD', binance: 'BTCUSDT',  binanceus: null } },
  { sym: 'DOGE', name: '狗狗币',  unlock: Date.UTC(2014, 0, 21, 22), otc: Date.UTC(2018, 0, 1),  src: { bitstamp: null,     bitfinex: null,      binance: 'DOGEUSDT', binanceus: null },
    cdd: [{ file: 'Poloniex_DOGEUSDT_1h.csv', quote: 'USDT' }, { file: 'Poloniex_DOGEBTC_1h.csv', quote: 'BTC' }],
    votes: [{ exch: 'bitfinex', pair: 'tDOGE:USD' }] },
  { sym: 'XRP',  name: '瑞波币',  unlock: Date.UTC(2014, 7, 14, 3),  otc: Date.UTC(2018, 0, 1),  src: { bitstamp: 'xrpusd', bitfinex: null,      binance: 'XRPUSDT',  binanceus: null },
    cdd: [{ file: 'Poloniex_XRPUSDT_1h.csv', quote: 'USDT' }, { file: 'Poloniex_XRPBTC_1h.csv', quote: 'BTC' }],
    votes: [{ exch: 'bitfinex', pair: 'tXRPUSD' }] },
  { sym: 'ETH',  name: '以太坊',  unlock: Date.UTC(2015, 7, 8, 6),   otc: Date.UTC(2016, 5, 1),  src: { bitstamp: 'ethusd', bitfinex: null,      binance: 'ETHUSDT',  binanceus: null },
    cdd: [{ file: 'Poloniex_ETHUSDT_1h.csv', quote: 'USDT' }],
    votes: [{ exch: 'bitfinex', pair: 'tETHUSD' }] },
  { sym: 'SOL',  name: '索拉纳',  unlock: Date.UTC(2020, 7, 11, 6),  otc: Date.UTC(2021, 0, 1),  src: { bitstamp: null,     bitfinex: null,      binance: 'SOLUSDT',  binanceus: 'SOLUSD' },
    votes: [{ exch: 'bitfinex', pair: 'tSOLUSD' }] },
];

/** 按符号取币种定义 */
export const coinOf = sym => COINS.find(c => c.sym === sym) || null;

/**
 * 三家交易所（GDD §7.1 / §7.2）—— 全是**史实里的真名**，玩家一眼能对上当年的新闻。
 *
 * ⚠️ **Mt.Gox 已从本作移除**（2026-10-03 用户拍板「全程只做杠杆与合约」）——
 *    它当年只做现货 1x、没有融资也没有合约，与「全程杠杆 / 合约」的定位不符。
 *    开局所随之改为 **Bitfinex**（同为 2013-01-01 开业，经典全程无空档）。
 *
 * 每家字段：
 *   - `open` / `close`：开业与归零时刻（`close: null` = 活到现在）。
 *     `close` 不只是「不能再用」的标记，还是**归零事件**的触发点（见 `engine.advanceOneHour`）：
 *     到点那一刻，该所余额清零、挂在该所的持仓一并作废。
 *   - `marginSteps`：**杠杆**（借贷口径）的杠杆上限阶梯，升序取「最后一个 `from <= t`」。
 *   - `futSteps` ：**合约**（线性 USDT 本位永续）的杠杆上限阶梯；**`null` ＝ 该所永不提供合约**。
 *   - `fees`     ：**吃单费率的两张年代阶梯**（`margin` / `fut`），升序取「最后一个 `from <= t`」，
 *                  `null` ＝ 该所那个时刻还没有这类产品。开仓与平仓各收一次（单边、不区分 Maker/Taker）。
 *   - `hack`     ：**被盗削减**事件（B21 · 可选）—— `{ at, cut }`：到点把该所**两格余额各 ×(1 − cut)**，
 *                  **不动持仓、不动其他所**（与 `close` 的整所归零是两回事）。
 *   - `halts`    ：**停机维护**窗口（B24 · 可选）—— `[{ from, to }]`：窗口内**只平不开**
 *                  （判据走 `haltedAt()`，别在调用处自己比时刻）。
 *   - `dev`      ：**本所价偏移**（缺口 10 · 2026-10-03 拍板）—— `{ basis, amp, cap }`：
 *                  本所价 = 基准价 × (1 + 基差 + 噪声)，夹在 `±cap`。口径与取值依据见 `god.exDevOf`。
 *
 * ⚠️ **杠杆与合约是两回事，费率也必须是两张表**（v12 · 方案 §11.0 偏离①）：
 *    改动前每家只有一个 `fee`，于是 BitMEX 的 **0.05%（衍生品）** 与 Binance 的 **0.04%（合约）**
 *    被当成了统一费率套用到全部场景 —— 四个数字里三个偏离史实（§11.0 偏离②）。
 *    史实出处见方案 §11.9，**不要凭记忆改这些数字**。
 *
 * ⚠️ **两张表是两回事**（v9 · 方案 §15，2026-09-29 拍板）：史实上「杠杆上限」与「合约上限」
 *    从来不是同一个数 —— Bitfinex 杠杆 3.3x / 合约 100x，BitMEX 没有杠杆 / 合约 100x。
 *
 * 史实出处（2026-09-29 二次核实，勿再凭记忆改动）：
 *   Bitfinex 杠杆 2013 年上线即 3.3x（＝初始保证金 30%）；2020-01-30 → 5x；2021-02-17 → 10x（官方公告）。
 *            合约 **2019-09-02** 才上线（`BTCF0/USDt0`：USDT 抵押、逐仓、最高 100x）
 *   BitMEX   没有杠杆（本作把它的杠杆抽象为 1x）；合约 **2016-05-13** `XBTUSD` 永续上线才给到 100x
 *            （2015-10 的 100x 属于季度交割合约，本作实现的是线性 USDT 本位永续，故挂在永续上线日）
 *   Binance  2017-07-14 上线，起初仅 1x；2019-07-11 保证金交易上线（3:1），2019-11-19 放到 5x。
 *            合约 **2019-09-13** 上线（BTCUSDT 永续，首日 20x）→ 2019-10-18 起 125x → 2021-07-19 起限 20x
 *
 * ⚠️ **所有合约上线日都在 USDT 发行（2014-11）之后** ⇒ 「合约保证金必须 USDT」堵不死玩家的路（§15.2）。
 */
export const EXCHANGES = [
  {
    id: 'bitfinex', name: 'Bitfinex',
    open: Date.UTC(2013, 0, 1), close: null,
    marginSteps: [
      { from: Date.UTC(2013, 0, 1),  max: 3.3 },
      { from: Date.UTC(2020, 0, 30), max: 5 },
      { from: Date.UTC(2021, 1, 17), max: 10 },
    ],
    futSteps: [{ from: Date.UTC(2019, 8, 2), max: 100 }],
    /* 史实（B21）：2016-08-02 发现被盗 119,756 BTC，随后对**全体账户**做 36.067% 的普损分摊
       （社会化的损失 —— 不是只扣被偷的那几个人）。本作把它抽象为「当天该所两格余额各打 63.933 折」：
       不动持仓、不动其他所，也不提前预警（那天的玩家确实无从预知）。 */
    hack: { at: Date.UTC(2016, 7, 2), cut: 0.36067 },
    /* 史实：Maker 0.10% / **Taker 0.20%** —— 本作只有市价吃单 ⇒ 取 0.20%。
       「合约」侧：Bitfinex 的杠杆史实上是**保证金交易**（trading fee ＋ 借币利息），
       没有独立的合约费率档 ⇒ **沿用杠杆 taker 0.20%**（§11.2，是史实而非近似）。 */
    fees: {
      margin: [{ from: Date.UTC(2013, 0, 1), v: 0.002 }],
      fut: [{ from: Date.UTC(2019, 8, 2), v: 0.002 }],
    },
    dev: { basis: 0.001, amp: 0.0013, cap: 0.008 },
  },
  {
    id: 'bitmex', name: 'BitMEX',
    open: Date.UTC(2014, 0, 1), close: null,
    marginSteps: [{ from: Date.UTC(2014, 0, 1), max: 1 }],
    futSteps: [{ from: Date.UTC(2016, 4, 13), max: 100 }],
    /* 史实（B24 · 2026-09-30 联网复核修正）：2020-03-13「黑色星期四」BitMEX 因 DDoS / 技术故障
       停机，实测窗口 **02:16–03:00 UTC（约 44 分钟）**，恰好在最需要平仓的暴跌里 ——
       这段时间**只平不开**。（当天 12:56–13:21 还有一次短暂 DDoS，量级很小，本作不实现。）
       ⚠️ 本作的时刻一律是**整点**（`s.i` 就是小时序号，停机/恢复日志用 `===` 判等），
          所以窗口取整到 **02:00–03:00** —— 44 分钟无法在小时网格上表达。 */
    halts: [{ from: Date.UTC(2020, 2, 13, 2), to: Date.UTC(2020, 2, 13, 3) }],
    /* 杠杆 0.05% flat（该所杠杆市场一直很小）。
       衍生品 **Taker 0.075% / Maker −0.025%（返佣）** —— 2016-05 XBTUSD 永续上线起的经典档位；
       现代降到 base 0.05%/0.05% ⇒ **2021-01 起 0.05%**（⚠️ 切换时刻为近似，方案 §11.2）。
       ⚠️ 0.075% 那一段的实际起点是永续上线日（`futSteps` 首档 2016-05-13），阶梯写 2014-01
          只为与方案 §11.2 的表述一致 —— 取不到合约的年份，这条阶梯根本不会被查到。 */
    fees: {
      margin: [{ from: Date.UTC(2014, 0, 1), v: 0.0005 }],
      fut: [
        { from: Date.UTC(2014, 0, 1),  v: 0.00075 },
        { from: Date.UTC(2021, 0, 1),  v: 0.0005 },
      ],
    },
    dev: { basis: 0, amp: 0.0005, cap: 0.003 },
  },
  {
    id: 'binance', name: 'Binance',
    open: Date.UTC(2017, 6, 14), close: null,
    marginSteps: [
      { from: Date.UTC(2017, 6, 14),  max: 1 },
      { from: Date.UTC(2019, 6, 11),  max: 3 },
      { from: Date.UTC(2019, 10, 19), max: 5 },
    ],
    /* ⚠️ 合约上线日 **2019-09-13**（BTCUSDT 永续首日），不是 09-01 —— 09-01 是「合约平台发布」。
       首日只有 **20x**，**2019-10-18** 才放到 125x；2021-07-19 起限回 20x。 */
    futSteps: [
      { from: Date.UTC(2019, 8, 13), max: 20 },
      { from: Date.UTC(2019, 9, 18), max: 125 },
      { from: Date.UTC(2021, 6, 19), max: 20 },
    ],
    /* 杠杆 **0.10% maker / 0.10% taker**（2017-07 上线即此价；BNB 抵扣属「持平台币」玩法，不做）。
       合约 USDT-M 永续 **Maker 0.02% / Taker 0.04%** ⇒ 合约上线日 2019-09-13 起 0.04%。 */
    fees: {
      margin: [{ from: Date.UTC(2017, 6, 14), v: 0.001 }],
      fut: [{ from: Date.UTC(2019, 8, 13), v: 0.0004 }],
    },
    dev: { basis: 0, amp: 0.0003, cap: 0.002 },
  },
];

/** 按 id 取交易所定义 */
export const exchangeOf = id => EXCHANGES.find(e => e.id === id) || null;

/** 这家所此刻是否**停机维护**（B24）—— 窗口内只平不开。没配 `halts` 的所恒 `false` */
export const haltedAt = (t, exId) =>
  !!exchangeOf(exId)?.halts?.some(h => t >= h.from && t < h.to);

/**
 * **价格保护带**（③ · 2026-10-03 拍板）—— 极端行情里**只允许平仓**的窗口。
 *
 * ⚠️ 现实口径（这是本作**唯一**带价格涨跌幅的闸门）：加密**没有 A 股那种涨跌停**；
 *    Binance 永续的 `PERCENT_PRICE` 过滤器（**2019-09-13** 随 BTCUSDT 永续首日生效）限制的也只是
 *    「单笔委托价相对标记价的偏离」，不是停牌。BitMEX / Bitfinex 在 2013–2016 **没有任何熔断**。
 *    ⇒ 本闸**只从 Binance 永续开始**、且**只做「只允许平仓」**（不做拒单、不改成交价）：
 *    真实交易所遇到极端波动是「用户可以跑、不能加」——那正是 2020-03-12 那种行情里唯一合理的姿态。
 *
 * 触发判据（在 `engine.js` 里按原始行情算，见 `bandBreachAt`）：
 *   单小时原始收益率 `|rawClose(i) / rawClose(i−1) − 1| ≥ max(k × σ_30日, floor)`
 *   ⇒ `k = 2.5`（现货/永续的极端单小时跳变常年在 2–3σ 以上）、`floor = 3%`（薄盘年代 σ 很小时兜底，
 *   避免「σ = 0.5% ⇒ 1.25% 就停开仓」这种把窄幅震荡误判成极端行情）。
 *
 * ⚠️ 用 **`rawCloseAt`（原始行情）** 而非玩家位移后的价：玩家自己砸出来的插针不该触发交易所风控。
 * ⚠️ **锁定 `hours = 2`**：从触发那根 K 线**收线之后**起算，覆盖接下来 2 小时（见 `priceBandAt`）。
 * ⚠️ 全程只影响**开仓**：`closeTrade` 一个字都不动（与 `haltedAt` 同纪律）。
 */
export const BAND = {
  ex: 'binance',                 // 仅 Binance（永续上线即带 PERCENT_PRICE）
  from: Date.UTC(2019, 8, 13),   // 2019-09-13 = Binance BTCUSDT 永续首日
  k: 2.5,                        // σ 倍数
  floor: 0.03,                   // 绝对下限 3%/小时
  hours: 2,                      // 锁定时长（小时）
};

/** 取某家交易所某一类的杠杆阶梯（`kind`：`'margin'` 杠杆 / `'fut'` 合约）；该所不提供时为 `null`
 *  ⚠️ 不导出（2026-10-02 审计）：它只服务本文件的 `maxLeverageAt` / `hasLeverageKindAt`
 *     与 `leverageOptionsAt` —— 对外那几件事都由它们转述，别再开一个裸阶梯的入口。 */
const stepsOf = (ex, kind = 'margin') => (kind === 'fut' ? ex.futSteps : ex.marginSteps);

/**
 * 某家交易所**此刻**提不提供该类杠杆（v9 · §15.3 N3）—— 判据 = 阶梯存在且首档已生效。
 * UI 用它决定那枚「杠杆 / 合约」模式键出不出现（＝「没有的选项不显示」）。
 */
export function hasLeverageKindAt(t, exId, kind = 'margin') {
  const ex = exchangeOf(exId);
  if (!ex) return false;
  const steps = stepsOf(ex, kind);
  return !!steps && steps.length > 0 && steps[0].from <= t;
}

/** 某一时刻、某家交易所、某一类的最高杠杆（该所不提供这一类时返回 1） */
export function maxLeverageAt(t, exId, kind = 'margin') {
  const ex = exchangeOf(exId);
  if (!ex) return 1;
  const steps = stepsOf(ex, kind);
  if (!steps) return 1;
  let max = 1;
  for (const s of steps) { if (s.from <= t) max = s.max; else break; }
  return max;
}

/**
 * 某家交易所**此刻**开没开**融资**（借 U 买入 / 借币卖出）—— v10 · 杠杆做空的**史实判据**。
 *
 * 判据只有一条：**杠杆表的上限 > 1**。上限 1 就是「用自己的钱买币」，交易所不做出借方；
 * 有 3x / 5x 才说明它真的把钱借给你 —— 而**做空必须先借到币**，借不到就没有杠杆空单。
 *   - 借不到 ⇒ BitMEX 杠杆、Binance 2017-07～2019-07-11
 *   - 借得到 ⇒ Bitfinex（2013 起 3.3x）、Binance（2019-07-11 起 3x）
 *
 * ⚠️ **与合约无关**：合约做空是保证金交易，不需要借币，照旧只按 `futSteps` 判。
 */
export const hasFinancingAt = (t, exId) => maxLeverageAt(t, exId, 'margin') > 1;

/**
 * 可选杠杆档位：从 1 到当前上限，取这几个常用值（GDD §18.1 的杠杆选择器）。
 * ⚠️ **`125` 必须在表里**：它是 Binance 合约的史实上限（§15.1），
 *    而 `100` 是 BitMEX / Bitfinex 的上限 —— 少了 125，「上限补进」那条虽然也能凑出这一格，
 *    但 125 与 100 之间就没有任何可选的中间档，档位表的语义会变得含糊。
 */
const LEV_LADDER = [1, 2, 3, 5, 10, 20, 50, 100, 125];

/** 某一时刻、某家交易所、某一类可选的杠杆档位（1 与上限必在列表内） */
export function leverageOptionsAt(t, exId, kind = 'margin') {
  const max = maxLeverageAt(t, exId, kind);
  const out = LEV_LADDER.filter(v => v <= max);
  if (!out.includes(max)) out.push(max);   // 上限不是整数档时直接补进来（Bitfinex 史实 3.3x）
  if (!out.includes(1)) out.unshift(1);
  return out;
}

/* ══════════════ 维持保证金率 · 借贷日息 · 强平清算费（B18 / B26 / B20 · 2026-09-30） ══════════════
 *
 * 改动前这里是**一个全局常量** `GAME.maintRate = 0.5%` —— 四家所、两种工具、任何名义量级共用同一个数。
 * 史实上这三件事都不成立（方案 §12.1① / §12.3① 的 🔴 条目），本轮按「所 × 工具 × 名义档」重排：
 *
 *   - **永续（`perp`）**：Binance 真实四档（越小越松、越大越严）；BitMEX / Bitfinex / 其余恒 0.5%
 *   - **杠杆（`margin`）**：Bitfinex 史实的 **15%（权益口径）**（CFTC Docket 16-19 原文
 *     `equity … fell below 15% → forcibly liquidated`）；
 *     **Binance 杠杆另立一张表**（2026-10-03 发布前审计修）：它不吃名义分档，而吃**保证金水平**
 *     阈值（逐仓 3x ≤ 1.18 / 5x ≤ 1.15 / 10x ≤ 1.05），换算成维持率 ≈ 9–12%（见
 *     `BINANCE_MARGIN_LEV_TIERS`）—— 此前「一家所的分档套给所有所」是审计发现的偏差项
 *
 * ⚠️ **工具性质由仓位自己决定**（`positions.instrumentOf`）：有借入（`lev > 1` 或**任何空头**）
 *    ⇒ `margin`、其余 ⇒ `perp`。2016-05-13 之前世界上没有永续（BitMEX XBTUSD 是人类第一个），
 *    所以那年头的「杠杆」全是借钱买币 —— 这一条正是 B26 与 B18 共用同一次改动的理由。
 *
 * ⚠️ **数值口径**：Binance 四档来自 2026-09-29 检索（方案 §12.10 出处）；15% 来自 CFTC 原文；
 *    **清算费 0.5% 无一手出处**（检索到 0.5% 与 1.25–2.5% 两说）⇒ GDD 声明为合成值。
 */
export const MARGIN = {
  /** 杠杆仓的维持保证金率（权益口径）—— CFTC Docket 16-19 史实 */
  maint: 0.15,
  /**
   * **借贷日息**（B26 · 2026-10-03 拆两档）—— 史实只有「用户间 P2P 按市场利率计息」这个形态
   * （Bitfinex 的 Margin Funding Provider），**具体数值是合成值**：按年代收敛，早年借贷市场薄、
   * 利率高，近年廉价。形态取自真实机制，数字需在 GDD 声明为合成。
   *
   * ⚠️ **必须分「借标价币」与「借标的币」两条**：多头借钱（USD / USDT）、空头借币（BTC…），
   *    这是**两个独立的市场**（两条 funding book）。标的币的池子小、出借方少，但利率**远低**于
   *    标价币 —— 现实中「借币做空」的日息常是「借 USDT」的 1/5～1/10（Bitfinex 早年 USD 档
   *    万分之几到千分之一、BTC 档低一个数量级）。合并成一条曲线会把空头的成本口径整个算错。
   * ⚠️ 数字是**合成值**（形态取自真实机制，量级对齐上述区间）⇒ GDD 声明为合成。
   */
  daily: {
    /** 借**标价币**（多头：USD / USDT）—— 日息 */
    quote: [
      { from: Date.UTC(2013, 0, 1), v: 0.0005 },   // 2013–2016：0.05% / 日
      { from: Date.UTC(2017, 0, 1), v: 0.0010 },   // 2017–2019：0.10% / 日（牛市借贷需求旺）
      { from: Date.UTC(2020, 0, 1), v: 0.0003 },   // 2020 起   ：0.03% / 日（稳定币供给泛滥）
    ],
    /** 借**标的币**（空头：BTC / ETH …）—— 日息，**恒为标价币那一档的 1/5～1/10** */
    coin: [
      { from: Date.UTC(2013, 0, 1), v: 0.00006 },  // 2013–2016：0.006% / 日（≈ 1/8）
      { from: Date.UTC(2017, 0, 1), v: 0.00020 },  // 2017–2019：0.02%  / 日（≈ 1/5，牛市同涨）
      { from: Date.UTC(2020, 0, 1), v: 0.00005 },  // 2020 起   ：0.005% / 日（≈ 1/6）
    ],
  },
  /**
   * **借贷额度上限** ＝ 该币**当日全市场流动性**（`liqOf`）× 本值。
   *
   * 现实里没有「硬额度」这回事 —— 能借多少由 funding book 的**深度**决定（Bitfinex 的资金市场
   * 是逐档撮合的订单簿，借满就要往上吃更贵的利率）。本作用一条**与滑点门槛同尺**的上限来近似
   * 那层深度：`SLIP.threshold = 10%` 也是「当日全市场成交额 × 10%」—— 于是「单笔大到开始被收
   * 滑点」与「借到额度上限」落在同一个量级，两把尺子不会互相打架。
   * ⚠️ 只卡**开仓**（与 `haltedAt` 同纪律），平仓永远放行。
   */
  quota: 0.10,
};

/** 强平清算费（B20）—— 触发强平那一刻，从**残余权益**里先扣掉 `名义 × 本值`，抵剩下的才返还。 */
export const LIQ = { fee: 0.005 };

/**
 * **单笔最小名义**（2026-09-30 裁决，单位：美元）—— 低于它的开仓直接拒绝。
 *
 * 为什么必须有这一条：`openTrade` 只把保证金**夹到可用余额**，没有下限 ——
 * 于是一格余额剩 `1e-16`（浮点残值：平仓找零、归零后的碎屑）时也能建出一张
 * 「名义 1e-16 的持仓」，持仓条与资产页就多出一条点不掉也平不掉的幽灵行
 * （长局抽检实测 7 处尘埃仓）。
 * ⚠️ 门槛取 **$1**：比本作任何一笔正常下单小三个数量级（开局 $1,000），
 *    只用来砍掉「数值上等于 0」的东西，不参与任何平衡。
 *
 * ⚠️ **2026-10-01 起它降级为「浮点保底」**：真实门槛改由下面的 `minNotionalAt()` 按
 *    「所 × 产品 × 年代」给出（丙案）。两者取大 —— 本值仍兜住所有表里查不到的格子。
 */
export const MIN_NOTIONAL = 1;

/**
 * 各所 / 各产品的**单笔最小名义**（丙案 · 2026-10-01 拍板，单位：美元）——
 * 与 `EXCHANGES[].fees` 同一套「升序取最后一个 `from <= t`」读法。
 *
 * 史实核对（2026-10-01，web.archive.org 历史快照 ＋ 官方接口元数据；**未证实处已在注释里标明**）：
 *   - **Bitfinex**：官方 FAQ 原文只说各交易对最小单「定期调整、与其价值相称」，
 *     目标约 **$10–25 等值**（具体数值出自二手文献 Brauneis et al. 2018）⇒ 取**保守下沿 $10**。
 *     永续（2019-09-02 起）**无史料** ⇒ 沿用杠杆的 $10。
 *   - **BitMEX**：`XBTUSD` 永续 **1 张 = 1 USD 名义**、`lotSize = 1` ⇒ 最小 **$1**（一手接口元数据）。
 *     杠杆（本作把 BitMEX 的杠杆抽象为 1x）无史料 ⇒ 同样 $1。
 *   - **Binance 杠杆**：`MIN_NOTIONAL` 2021 快照 = **$10**、2024 快照 = **$5**（一手字段）。
 *     ⚠️ 它的**引入确切日期不可考**（只能由快照反推约 2019）⇒ 首档直接挂**开业日 2017-07-14**，
 *     宁可保守（早年也按 $10 卡）。早年真实的最小名义按 BTC 计价（0.001 BTC）、随币价浮动，
 *     本作**不做「按币价浮动的门槛」**。
 *   - **Binance 合约**：交易对不同则 $5–10，取**下沿 $5**；`BTCUSDT` / `ETHUSDT` 于
 *     **2023-11-02** 上调至 **$20**（官方公告）。
 *
 * ⚠️ 这些数相对本作资金量级（开局 $1,000 → 中后期百万）小三个数量级，
 *    **只影响「极小单被拒」这一件事**，不参与任何平衡。
 */
const MIN_NOTIONAL_STEPS = {
  bitfinex: {
    margin: [{ from: Date.UTC(2013, 0, 1), v: 10 }],
    fut: [{ from: Date.UTC(2019, 8, 2), v: 10 }],
  },
  bitmex: {
    margin: [{ from: Date.UTC(2016, 4, 13), v: 1 }],
    fut: [{ from: Date.UTC(2016, 4, 13), v: 1 }],
  },
  binance: {
    margin: [{ from: Date.UTC(2017, 6, 14), v: 10 }, { from: Date.UTC(2024, 0, 1), v: 5 }],
    fut: [{ from: Date.UTC(2019, 8, 13), v: 5 }, { from: Date.UTC(2023, 10, 2), v: 20 }],
  },
};

/**
 * 某家交易所**某一时刻、某一类**的单笔最小名义（丙案 · 2026-10-01）。
 *
 * 回落链：该所 / 该产品的阶梯取不到（含 `fut: null`、该所那时还没开业）⇒ 返回 `MIN_NOTIONAL`（$1），
 * 由调用方 `Math.max` 兜住 —— 与 `feeRateOf` 的回落风格一致，**不返回 0**（返回 0 等于取消这道闸）。
 *
 * @param {string} exId 交易所 id
 * @param {number} t    时刻（毫秒）—— 门槛是**年代阶梯**，同一家所不同年份可能不同
 * @param {'margin'|'fut'} kind 产品。**判据与费率同源**：由这一单**自己的性质**决定
 *   （`engine.openTrade` 的 `isMarginOrder`），不是由玩家此刻站在哪个页面决定。
 * @returns {number} ≥ `MIN_NOTIONAL` 的正数
 */
export function minNotionalAt(exId, t, kind = 'margin') {
  const ladder = MIN_NOTIONAL_STEPS[exId]?.[kind === 'fut' ? 'fut' : 'margin'];
  if (!ladder) return MIN_NOTIONAL;
  let v = null;
  for (const s of ladder) { if (s.from <= t) v = s.v; else break; }
  return v != null ? Math.max(MIN_NOTIONAL, v) : MIN_NOTIONAL;
}

/**
 * Binance 永续的**杠杆 / 保证金阶梯**（名义价值越大、维持保证金率越严、可开杠杆越低）。
 *
 * ⚠️ 2026-10-03（⑥）**由 5 档补全为真实 BTCUSDT 全表**：此前顶部压成「≥$500 万一律 5%」一桶，
 *    于是巨鲸在 `$100M` 名义上照样能开 10x（现实只有 3x）—— 这正是「给巨鲸发无限杠杆」那条 bug。
 *    现在 `rate`（维持保证金率）与 `maxLev`（本档最高杠杆）**同表并列**，不写第二个常数。
 *
 * | 名义（USDT） | 最高杠杆 | 维持保证金率 |
 * |---|---|---|
 * | 0 – 50,000 | 125x | 0.40% |
 * | 50,000 – 250,000 | 100x | 0.50% |
 * | 250,000 – 1,000,000 | 50x | 1.00% |
 * | 1,000,000 – 5,000,000 | 20x | 2.50% |
 * | 5,000,000 – 20,000,000 | 10x | 5.00% |
 * | 20,000,000 – 50,000,000 | 5x | 10.00% |
 * | 50,000,000 – 100,000,000 | 4x | 12.50% |
 * | 100,000,000 – 200,000,000 | 3x | 15.00% |
 * | 200,000,000 – 300,000,000 | 2x | 25.00% |
 * | > 300,000,000 | 1x | 50.00% |
 *
 * 出处：Binance 官方杠杆及保证金阶梯（2021 版与 2026 年现行表一致，见方案 §14.4 调研）。
 * ⚠️ 前四档与改动前**逐位相同**；`≥ $5M` 那一段的维持保证金率由统一的 5% 细化为 5/10/12.5/15/25/50%
 *    ⇒ 巨鲸会**更早**被强平（更真实，也是本轮有意的手感变化）。
 */
const BINANCE_MARGIN_TIERS = [
  { upTo: 5e4,       rate: 0.004,  maxLev: 125 },
  { upTo: 2.5e5,     rate: 0.005,  maxLev: 100 },
  { upTo: 1e6,       rate: 0.01,   maxLev: 50  },
  { upTo: 5e6,       rate: 0.025,  maxLev: 20  },
  { upTo: 2e7,       rate: 0.05,   maxLev: 10  },
  { upTo: 5e7,       rate: 0.10,   maxLev: 5   },
  { upTo: 1e8,       rate: 0.125,  maxLev: 4   },
  { upTo: 2e8,       rate: 0.15,   maxLev: 3   },
  { upTo: 3e8,       rate: 0.25,   maxLev: 2   },
  { upTo: Infinity,  rate: 0.50,   maxLev: 1   },
];

/**
 * Binance **杠杆（现货杠杆）** 的强平口径 —— 与上面的永续分档**不是一套东西**（2026-10-03 发布前审计）。
 *
 * 永续吃「**名义价值分档**」的维持率；现货杠杆吃的是**保证金水平**阈值
 * `Maint. Level = 资产 ÷ (负债 ＋ 利息)`，逐仓模式下按杠杆给不同的水位线：
 *   3x ⇒ ≤ 1.18、5x ⇒ ≤ 1.15、10x ⇒ ≤ 1.05（Binance 官方口径，本作杠杆最高只到 5x）。
 * 换算到本作的「维持率 = 仓位权益 ÷ 名义」（同 `positions.js` 文件头口径），做多一侧：
 *   `m = (1 − 1/杠杆) × (L − 1)`  ⇒ 2x→9%、3x→12%、4x→11.25%、5x→12%
 *   （对应逆向波动 −41% / −21.3% / −13.75% / −8%，随杠杆单调收紧）。
 *
 * ⚠️ **对照 Bitfinex 史实的 15%**（CFTC Docket 16-19）：同一杠杆下 Binance 杠杆的维持线更低、
 *    **强平更晚**（3x：−21.3% vs 本作此前统一套 Bitfinex 的 −18.3%）—— 这正是本表要修掉的偏差。
 * ⚠️ 它是**做多一侧**的等效值：做空（借币）的保证金水平算式不同，机构上会得到偏高的维持率；
 *    本作沿用 `positions.js` 既有的「多空同一维持率」简化，不为此再分叉。
 * ⚠️ `lev ≤ 1` 退回 `MARGIN.maint`：Binance 杠杆最低 3x，本作早年把 `max: 1` 当占位档，
 *    那时的 1x 空头仍按 Bitfinex 口径走。
 */
const BINANCE_MARGIN_LEV_TIERS = [
  { upToLev: 3,  ml: 1.18 },
  { upToLev: 5,  ml: 1.15 },
  { upToLev: 10, ml: 1.05 },
];

function binanceMarginMaint(lev) {
  if (!Number.isFinite(lev) || lev <= 1) return MARGIN.maint;
  let ml = 1.05;
  for (const t of BINANCE_MARGIN_LEV_TIERS) if (lev <= t.upToLev) { ml = t.ml; break; }
  return Math.max(0, (1 - 1 / lev) * (ml - 1));
}

/**
 * 该所 / 该工具 / 该档的维持保证金率（B18 + B26）。
 * @param {string} exId 交易所 id
 * @param {number} notional 名义价值 —— 只有 Binance 永续按它分档
 * @param {'perp'|'margin'} kind 工具性质（`positions.instrumentOf` 提供）
 * @param {number} lev 杠杆 —— 只有 Binance 杠杆按它换保证金水平阈值（见上表）
 * @returns {number} 比率；缺省回落到 `GAME.maintRate`（0.5%）
 */
export function maintRateAt(exId, notional, kind = 'perp', lev = 0) {
  if (kind === 'margin') return exId === 'binance' ? binanceMarginMaint(lev) : MARGIN.maint;
  if (exId !== 'binance') return GAME.maintRate;
  const n = Number.isFinite(notional) && notional > 0 ? notional : 0;
  for (const t of BINANCE_MARGIN_TIERS) if (n < t.upTo) return t.rate;
  return GAME.maintRate;
}

/**
 * 该所 / 该工具 / 该名义档允许的**最高杠杆**（⑥ 名义阶梯杠杆封顶 · 2026-10-03）。
 *
 * 与 `maintRateAt` **同一张表**（`BINANCE_MARGIN_TIERS`）：名义越大、可开的杠杆越低。
 * 只有 **Binance 永续**吃这张表 —— 其余所、以及**杠杆（`margin`）**一律返回 `Infinity`（不设限，
 * 那些产品的杠杆已由 `EXCHANGES[].marginSteps` / 各自的保证金水平口径封住）。
 *
 * ⚠️ 这是「**下单那一刻**按结果名义判档」用的判据（`engine.openCheck`），**不是**选择器的过滤器 ——
 *    选杠杆时还没有名义，真实交易所也是让用户先选倍数、再按名义拒绝超档的单。
 *
 * @param {number} notional 结果名义（本单名义 ＋ 已有仓位按现价的名义）
 * @returns {number} 该档允许的最高杠杆；不设限时 `Infinity`
 */
export function notionalMaxLevAt(exId, notional, kind = 'perp') {
  if (kind === 'margin' || exId !== 'binance') return Infinity;
  const n = Number.isFinite(notional) && notional > 0 ? notional : 0;
  for (const t of BINANCE_MARGIN_TIERS) if (n < t.upTo) return t.maxLev;
  return 1;
}

/**
 * 该时刻、该币种的**借贷日息**（B26 · 2026-10-03 拆两档）—— 升序取「最后一个 `from <= t`」。
 * @param {number} t   时刻（毫秒）
 * @param {'quote'|'coin'} cur 借的是**标价币**还是**标的币** —— 判据见 `positions.borrowCurOf`
 *   （多头借美元 / U ⇒ `'quote'`；空头借币 ⇒ `'coin'`）。缺省 `'quote'`，与旧调用点逐位兼容。
 */
export function marginDailyRateAt(t, cur = 'quote') {
  const ladder = cur === 'coin' ? MARGIN.daily.coin : MARGIN.daily.quote;
  let v = ladder[0].v;
  for (const s of ladder) { if (s.from <= t) v = s.v; else break; }
  return v;
}

/**
 * **成交量阶梯手续费**（v19 · 2026-10-01 用户拍板）——
 * 真实交易所都按**近 30 天滚动成交量**给费率打折：量越大、费越低。改动前四家全是**一档价**，
 * 于是「巨鲸」和「散户」付同样的费率 —— 本轮把这条史实补上（巨鲸规模才看得见，散户落在首档）。
 *
 * 分档口径（`unit`）：
 *   - `usd` —— 三家按**美元名义额**分档（Binance 的 VIP、Bitfinex / BitMEX 的 30 天成交量）
 *
 * 表形与 `BINANCE_MARGIN_TIERS` 同构：升序，取**第一个 `vol <= upTo`** 的档；超出末档取末档。
 * `null` ⇒ 该类不吃阶梯（`feeRateOf` 按既有回落链处理）。
 *
 * ⚠️ 表里的数是**绝对费率**，但 `feeRateOf` 真正返回的是「**相对首档的折扣比** × 当时的基准费率」——
 *    这样 BitMEX 合约 2021-01 那次基准下调（0.075% → 0.05%）会**自动**传导到全部档位，
 *    不必为每个年代各写一张阶梯。首档恒等于基准（折扣 = 1）⇒ 小额散户的费率**逐位不变**。
 *
 * ⚠️ **史实可靠性**（勿凭记忆改动）：Bitfinex 2013–2018 的档表**无一手存档**，BitMEX / Binance
 *    的档表来自**现行档位** ⇒ 这三家是「按当代档位取形、幅度为近似」（GDD §11.3 已声明）。
 */
const FEE_TIERS = {
  bitfinex: {
    unit: 'usd',
    /* Taker 0.20% 起、随 30 天量降到 0.055%（Maker 侧同样递减，本作只有市价单 ⇒ 只取 taker）。 */
    margin: [
      { upTo: 5e5,      v: 0.002   },
      { upTo: 1.5e6,    v: 0.0018  },
      { upTo: 3e6,      v: 0.0016  },
      { upTo: 6e6,      v: 0.0014  },
      { upTo: 1e7,      v: 0.0012  },
      { upTo: 2e7,      v: 0.001   },
      { upTo: 5e7,      v: 0.0008  },
      { upTo: Infinity, v: 0.00055 },
    ],
    fut: null,          // 与费率同一条回落链：合约沿用杠杆档（史实上本就是同一张表）
  },
  bitmex: {
    unit: 'usd',
    margin: null,       // 杠杆 0.05% flat —— 该所杠杆市场一直很小，史实无阶梯
    fut: [
      { upTo: 1e6,      v: 0.00075 },   // 经典期基准（2021-01 起基准降到 0.05%，折扣比不变）
      { upTo: 5e6,      v: 0.0005  },
      { upTo: 1e7,      v: 0.0004  },
      { upTo: Infinity, v: 0.00035 },
    ],
  },
  binance: {
    unit: 'usd',
    margin: [
      { upTo: 2e7,      v: 0.001   },   // VIP0–2：吃单一律 0.100%
      { upTo: 5e7,      v: 0.0006  },   // VIP3
      { upTo: 1.5e8,    v: 0.00031 },   // VIP4–5
      { upTo: Infinity, v: 0.00023 },   // VIP6–9
    ],
    fut: [
      { upTo: 5e6,      v: 0.0004  },   // VIP0–1
      { upTo: 2e7,      v: 0.00035 },   // VIP2
      { upTo: 5e7,      v: 0.00032 },   // VIP3
      { upTo: 1.5e8,    v: 0.00027 },   // VIP4–5
      { upTo: Infinity, v: 0.00017 },   // VIP6–9
    ],
  },
};

/** 该所 / 该类别的阶梯表；该类没有 ⇒ 回落到杠杆那类（与费率本身的回落链同向） */
function tierTableOf(exId, kind) {
  const t = FEE_TIERS[exId];
  if (!t) return null;
  return (kind === 'fut' ? (t.fut || t.margin) : t.margin) || null;
}

/**
 * 某家交易所**某一时刻、某一类**的吃单费率（v12 · 方案 §11.3；v19 起带成交量阶梯）。
 *
 * @param {string} exId 交易所 id
 * @param {number} t    时刻（毫秒）—— 费率是**年代阶梯**，同一家所不同年份可能不同
 * @param {'margin'|'fut'} kind 杠杆 / 合约。**调用方必须传对**：一笔单走哪一张表由那笔单自己的
 *   性质决定（杠杆仓走 `margin`、合约仓走 `fut`，判据 `positions.isMargin`），不是由玩家此刻站在哪个页面决定。
 * @param {{u:number,b:number}|number|null} vol 该所**近 30 天**的成交量（`engine.vol30Of` 的返回）：
 *   传对象时按该所自己的 `unit` 取（`btc` → `b`，`usd` → `u`）；传数字时直接当那个口径用。
 *   不传 / 传 0 ⇒ 落在首档（无折扣）。
 *
 * 回落链：该类的阶梯取不到 ⇒ **回落到杠杆**（Bitfinex 的「合约」本就没有独立费率档）；
 * 杠杆也取不到（该所那时还没开业）⇒ **0**（不收钱，而不是崩）。`fut: null` 同理回落到杠杆。
 */
export function feeRateOf(exId, t, kind = 'margin', vol = null) {
  const ex = exchangeOf(exId);
  if (!ex) return 0;
  const at = (ladder) => {
    if (!ladder) return null;
    let v = null;
    for (const s of ladder) { if (s.from <= t) v = s.v; else break; }
    return v;
  };
  const fut = kind === 'fut' ? at(ex.fees.fut) : null;
  const base = fut != null ? fut : at(ex.fees.margin);
  if (base == null) return 0;

  /* 成交量阶梯（v19）：返回「折扣比 × 基准」。首档恒等于基准 ⇒ 小额散户**逐位不变**。 */
  const tiers = tierTableOf(exId, kind);
  if (!tiers) return base;
  const q = typeof vol === 'number' ? vol
    : (vol ? (FEE_TIERS[exId].unit === 'btc' ? (vol.b || 0) : (vol.u || 0)) : 0);
  let hit = tiers[tiers.length - 1].v;
  for (const x of tiers) if (q <= x.upTo) { hit = x.v; break; }
  return base * (hit / tiers[0].v);
}

/* ══════════════ 跨所转账的**通道（rail）**（v12 · 方案 §11.4） ══════════════
 *
 * 史实上「把钱从 A 所搬到 B 所」在不同年代走的路完全不同 —— 四段，由**转账时刻的年份自动判定**
 * （B14 拍板：不给玩家选，LESS IS MORE）：
 *
 *   | 年代 | rail | 本质 | 到账 |
 *   |---|---|---|---|
 *   | 2013-01 ～ 2014-11-19 | `wire`  银行电汇 | 走**银行**，与链无关 | 数天（72–240h） |
 *   | 2014-11-20 ～ 2017-09-10 | `omni`  Omni Layer | USDT 在 **BTC 链**上，成本 = BTC 矿工费 | 数小时（吃拥堵） |
 *   | 2017-09-11 ～ 2019-03 | `erc20` ERC-20 | 以太坊 gas | 数分钟–数小时（吃拥堵） |
 *   | 2019-04 起 | `trc20` TRC-20 | Tron 带宽 ＋ Energy | 数分钟（吃拥堵） |
 *
 * ⚠️ **`fee` 是「链上费 ＋ 交易所提现固定费」合并后的一个数**（方案 §11.4 的 LESS IS MORE 建议）：
 *    真实世界里 Binance 的 TRC-20 提现是 1 USDT、ERC-20 是 5–20 USDT，那**是另一层**；
 *    这里合并显示，但本注释就是「它其实是两层」的存档处 —— 将来别误以为只有链上费。
 * ⚠️ **`wire` 不吃拥堵**（方案 §11.6）：链堵不堵与银行慢不慢是两件事，用同一个 `congestionOf`
 *    会串味。它的「慢」由 `hours` 这个固定区间自己给，不接 `arrivalCandles`。
 * ⚠️ **不实现「改搬 BTC」**（B17）：本作账本是美元/USDT 记价，搬币在模型上等价于「电汇 ＋ 两次杠杆费」。
 * ⚠️ **不模拟 Mt.Gox 那 22 个月的电汇积压**（B15，该所已从本作移除）：那等于本局结束；退化为固定定额费 ＋ 数天到账。
 */
export const TRANSFER_RAILS = [
  {
    id: 'wire', label: '银行电汇', from: Date.UTC(2013, 0, 1),
    hours: [72, 240],                                            // 固定小时区间（不吃拥堵）
    fees: [{ from: Date.UTC(2013, 0, 1), v: 20 }],               // 固定美元定额（§11.4 建议 $20）
  },
  {
    id: 'omni', label: 'Omni Layer', from: Date.UTC(2014, 10, 20),
    hours: null,                                                 // null ⇒ 交给 arrivalCandles（吃拥堵）
    /* BTC 矿工费：2014–2016 常年 $0.01–0.50；2017 上半年随行情抬升（2017-12 的 $30–56 峰值落在下一段）。 */
    fees: [
      { from: Date.UTC(2014, 10, 20), v: 0.3 },
      { from: Date.UTC(2017, 0, 1),   v: 2 },
    ],
  },
  {
    id: 'erc20', label: 'ERC-20', from: Date.UTC(2017, 8, 11),
    hours: null,
    /* 以太坊 gas：上线即 $3，2017-12 牛市峰值 $30，2018 熊市回落到 $2。
       ⚠️ **这张表到 2019-03 为止** —— 2019-04 起年代已切到 TRC-20（下表 `from`），
          之后再往这里加档位是**死代码**（`railAt` 永远不会返回 erc20）。
          史实上 2021–2022 的 ERC-20 确实飙到 $30–50，但本作「一条年代一条通道」，
          那几年就认 TRC-20 的价（LESS IS MORE，且 2019 年后大家也确实都在用 TRC-20）。 */
    fees: [
      { from: Date.UTC(2017, 8, 11),  v: 3 },
      { from: Date.UTC(2017, 11, 1),  v: 30 },                   // 2017-12 牛市峰值
      { from: Date.UTC(2018, 5, 1),   v: 2 },
    ],
  },
  {
    id: 'trc20', label: 'TRC-20', from: Date.UTC(2019, 3, 1),
    hours: null,
    /* Tron 带宽补贴下 2019 年近免费（含交易所那 1 USDT 提现费，合起来就是 $1）；
       2022 年 Energy 单价近乎翻倍、2023–2025 约 13 TRX ≈ $3.90 ⇒ $4。
       ⚠️ 这一档**一路管到本作收盘（2024-12）**，是四段里唯一没有后继者的。 */
    fees: [
      { from: Date.UTC(2019, 3, 1),  v: 1 },
      { from: Date.UTC(2023, 0, 1),  v: 4 },
    ],
  },
];

/** 某一时刻走哪条通道 —— 升序取「最后一个 `from <= t`」；2013-01 之前回落到电汇（理论不可达） */
export function railAt(t) {
  let out = TRANSFER_RAILS[0];
  for (const r of TRANSFER_RAILS) { if (r.from <= t) out = r; else break; }
  return out;
}

/** 某条通道**某一时刻**的转账手续费（同样按年代阶梯取值） */
export function railFeeOf(rail, t) {
  let v = 0;
  for (const s of rail.fees) { if (s.from <= t) v = s.v; else break; }
  return v;
}

/** USDT 诞生的时刻（Tether 在 Omni Layer 上发币、交易所开始收 U）—— **两格账本的分界线**。
 *  它同时是：① `cashCurAt` 的分界 ② `TRANSFER_RAILS.omni.from` ③ 资产页「买 U」卡片的出现时刻。
 *  三处共用一个常量，免得哪天改了一个漏掉另两个。 */
export const USDT_LIVE = Date.UTC(2014, 10, 20);

/**
 * **这个年代的钱是哪一种**（v13 · 方案 §2.3）：`'usd'`（美元法币）或 `'usdt'`（稳定币）。
 *
 * 分界点与上表的 `omni` 同一个数 —— **2014-11-20**（Tether 在 Omni Layer 上发币、
 * 交易所开始收 U 的那一年）。这不是两条规则，是同一件事的两种说法：
 * 「2014-11 之前搬钱走银行电汇」⇔「2014-11 之前手上是美元」。
 *
 * 三处消费：① 发起转账时搬哪一格（`engine.switchExchange`）② 救济金打哪一格（`takeLoan`）
 * ③ 上帝模式「填入资金」填哪一格（`main.js`）。
 * ⚠️ 开局那 $1,000 是 USD（`GAME.cash`），所以 2013 年**两格账本只用得上第一格** ——
 *    这正是史实：那年没有 U，入金、结算、搬家全是美元。
 */
export const cashCurAt = t => (t < USDT_LIVE ? 'usd' : 'usdt');

/**
 * USDT 的**美元价格**锚点表（v13 · 方案 §3.2）—— 「1 USDT 值多少美元」。
 *
 * ⚠️ **不是编的**：逐条来自 2026-09-30 的史实检索（出处见方案 §3.3），数值全是**美元计价**口径。
 *    两处最要紧的取法写在方案里：**危机都写成「尖峰」**（锚点成对：前一天 1.000 / 当天冲击 /
 *    次日回锚，线性插值后天然是日内 V 形），**不加 σ 放大**（恐慌已经写在锚点里，再乘一次
 *    就是对同一事件双重计价 —— 与「价格上不叠加人工涨跌幅」那条红线同源）。
 * ⚠️ **双向**：可折价也可溢价（2017-04 的 0.900、2018-10 的 0.880 就是**买 U 捡便宜**），
 *    与 OTC 溢价「恒定对玩家不利」**刻意不同** —— 用户要的是「真实」。
 * ⚠️ **不采用**的数字（检索时逐条排除）：2015-02 的 $0.57（无深度、报价失真）、
 *    中文媒体的「溢价 14.29%」（那是场外人民币 OTC 口径）、CoinCodex 2018-07 的 $1.51
 *    （未能证实为真实可成交价）。
 */
export const USDT_ANCHORS = [
  [USDT_LIVE, 1.000],                 // Omni 版上线（几无真实成交，按锚定价）
  [Date.UTC(2016, 0, 1), 0.990],      // 常态偏折
  [Date.UTC(2017, 0, 1), 1.000],
  [Date.UTC(2017, 3, 20), 0.900],     // Wells Fargo 断供银行通道、超额增发质疑
  [Date.UTC(2017, 5, 1), 1.000],      // 回锚
  [Date.UTC(2017, 11, 20), 1.050],    // 大牛市避险买盘
  [Date.UTC(2018, 0, 15), 1.000],     // 回锚
  [Date.UTC(2018, 9, 14), 1.000],
  [Date.UTC(2018, 9, 15), 0.880],     // Bitfinex / Tether 信任危机（当日即回锚）
  [Date.UTC(2018, 9, 16), 0.980],     // 快速回锚的第一天
  [Date.UTC(2018, 11, 1), 1.000],     // 回锚
  [Date.UTC(2019, 3, 26), 0.960],     // NYAG 起诉 Bitfinex 挪用储备（低点 $0.957）
  [Date.UTC(2019, 5, 1), 1.000],      // 回锚
  [Date.UTC(2020, 2, 11), 1.000],
  [Date.UTC(2020, 2, 12), 1.050],     // 新冠暴跌、流动性挤兑、抢 U（Bitstamp $1.03–1.06）
  [Date.UTC(2020, 2, 20), 1.000],     // 回锚
  [Date.UTC(2021, 4, 18), 1.000],
  [Date.UTC(2021, 4, 19), 1.050],     // 中国监管收紧 ＋ 519 崩盘（Bitstamp 高点 $1.0999）
  [Date.UTC(2021, 5, 1), 1.000],      // 回锚
  [Date.UTC(2022, 4, 11), 1.000],
  [Date.UTC(2022, 4, 12), 0.945],     // Terra / UST 崩盘拖累（低点 $0.9410）
  [Date.UTC(2022, 5, 1), 1.000],      // 回锚
  [Date.UTC(2022, 10, 9), 0.960],     // FTX 崩盘、Alameda 疑似抛 U
  [Date.UTC(2022, 10, 20), 1.010],    // 短暂回稳偏溢价
  [Date.UTC(2023, 0, 1), 1.000],      // 回锚
  [Date.UTC(2023, 7, 31), 0.998],     // Kaiko：8 月持续小幅折价（赎回费与门槛）
  [Date.UTC(2024, 11, 31), 1.000],    // 常态（全年 $0.9981–$1.0022）
];

/**
 * 某一时刻「1 USDT 值多少美元」—— **纯锚点线性插值**（两头夹住：早于首锚取首值、晚于末锚取末值）。
 *
 * ⚠️ 与「升序取最后一个 `from <= t`」那套**阶梯**不同：这里必须**插值**，
 *    否则危机就成了一条永远踩不到的水平线（单日冲击的锚点对只在插值下才成形）。
 */
export function usdtPriceAt(t) {
  const a = USDT_ANCHORS;
  if (t <= a[0][0]) return a[0][1];
  for (let i = 1; i < a.length; i++) {
    if (t < a[i][0]) {
      const [t0, v0] = a[i - 1];
      const [t1, v1] = a[i];
      return v0 + (v1 - v0) * (t - t0) / (t1 - t0);
    }
  }
  return a[a.length - 1][1];
}

/** 数据包目录（public 下的静态资源，打包时原样拷贝到 dist/data/） */
export const DATA_DIR = 'data';

/**
 * 救济金（原场外配资 Batch 5 · B30，2026-10-01 用户拍板改版）—— **资产归零时**只能领一次的救命钱。
 *
 * 口径（用户拍板，勿擅改）：
 *   - **只给 1 次**：第二次归零就是真结束，GDD §10「唯一失败条件」没有失效
 *   - **不用还**：领取即到账 —— 没有利息、没有到期日、没有违约，`s.loan` 那一整条已删除
 *     （原「日息 0.1% × 180 天单利 ＋ 到期自动清仓」由用户 2026-10-01 拍板整体移除）
 *   - **额度与身家脱钩**：定额。原提议「按峰值 25%」被否掉
 *     （「假设有人到达过千万美元，真的可能借那么多吗？」）—— 那是配资，不是救命钱
 *   - **金额只与你的损失无关**：刚爆仓的人领不到大钱
 *
 * ⚠️ **定额 $1,000，不再分年代**（2026-10-01 平衡性实测后拍板）。
 *    原先按 2013-2016 / 2017-2021 / 2022+ 给 $1,000 / $2,000 / $5,000 —— 开局资金降到
 *    $1,000 之后，那组数变成「救济金 ÷ 开局资金 = 1x / 2x / 5x」，2017 年以后破产
 *    反而净赚一笔，破产从惩罚变成重开按键。改成**固定 $1,000** 后语义变干净：
 *    **破产 = 回到起点**（钱回到开局水平，白掉的是这几年时间）。
 *
 *    实测（15 次破产全部领救济金 → 换所 → 全仓杠杆死拿）：2014 破产领 $1,000 走到 2024 收盘是
 *    **$138.8K**，2016 破产是 **$183.8K** —— 翻盘能力充足，但相对「没破产」的终值仍损失 87–99%，
 *    惩罚没有失效。
 *
 *    唯一的例外是**币种**：2014-11-20 之后打的是 U，之前打的是美元
 *    （与跨所通道同一把尺子，见 `takeLoan`）—— 那一格由 `cashCurAt` 判，与这里的金额无关。
 *
 * ⚠️ 入参 `t` 已于 2026-10-02 审计删除：金额改成固定值之后它就再没被用过，
 *    留着只会让调用方以为「不同年代领的钱不一样」而把 `timeOf(s)` 传进来。
 */
export function loanAmountAt() {
  return 1000;
}

/**
 * 供应量闸门（P2-B2 · GDD §15.1 / §15.4）—— 玩家买入后**最多能锁走当年流通量的百分之几**。
 *
 * ⚠️ 口径（2026-09-30 修正，用户拍板）：这里是**占比**；闸门本身 =
 *    `占比 × 该币此刻的真实流通量`（`market.supplyAt(sym, i)`，读 `index.json` 的 `circulating`
 *    逐年锚点线性插值 —— 数据已在内存里，**不发任何额外请求**）。
 *
 *    改之前这里写的是**固定枚数**（300 万 / 1000 万 / 200 亿 / 5000 万 / 500 亿），
 *    那个数的分母其实是**总供应量**（21M / 120M / 100B / 580M / ~166B），
 *    与玩家在 K 线头部看到的**真实流通量**是两套口径 —— 比值随年份在 **8%–610%** 之间漂
 *    （BTC 2013 低 3.5 倍、ETH 2015 低 7 倍，而 DOGE / SOL 在上线当年反而高 2.6–6 倍）。
 *    现在改成对**当年真实流通量**取同一批占比，于是「300 万枚」这个量级在 2024 年仍成立
 *    （14.3% × 1980 万 ≈ 283 万枚）。
 *
 * ⚠️ **如实说明**：按真实口径落地后，闸门整局仍然**够不着** ——
 *    BTC 14.3% × 2013 年的 1061 万枚 ≈ 152 万枚，按当年 $13 算就是 $1,975 万，而玩家开局只有 $1,000。
 *    它的作用是「一条真实的背景约束」，不是平衡旋钮：正常玩法里看不到它生效。
 *
 * 只有**多头方向**消耗它（空头并没有把币从市场里拿走），且 OTC 买入不计入
 * （§15.3：对手方私下一口价，不从市场拿走流通量）。
 */
export const SUPPLY_SHARE = {
  BTC: 0.143,
  ETH: 0.083,
  XRP: 0.20,
  SOL: 0.086,
  DOGE: 0.30,
};

/**
 * **持仓对市场的影响**（2026-10-01 用户拍板）—— 让「囤币」真的挤占流通盘，而不是只做一道闸门。
 *
 * 背景：在这之前，玩家持 150 万枚 BTC 时市场深度、流动性与 K 线行为**与一枚都没持有时逐位相同**
 * —— `capturedOf` 只被 §15.1 的买入闸门读过一眼，价格与分母两条通路都看不见持仓。
 *
 * 下面两个通道共用同一个**占比**：
 *   `share = 杠杆多头枚数 ÷ (当年真实流通量 × frac)`，夹在 [0, 1]
 *   ① **深度折减**：`share` 越大 ⇒ 可交易浮筹越薄 ⇒ 你自己后续买卖的滑点越大（`hourLiqOf` 的分母）
 *   ② **抛压折价**：`share` 越大 ⇒ 市场越忌惮你随时砸盘 ⇒ 价格被压一个持续的折价（`god.factorFor`）
 *
 * ⚠️ `frac`（可交易浮筹占流通量的比例）是**合成常数**，无一手出处 —— 它的锚是
 *    「交易所托管规模约占供应量 10–20%」这个量级（同 `YEAR_BASE` / `LIQ.fee` 的待遇，GDD 须声明）。
 *    为什么不能直接拿**流通量**当分母：绝大多数币长期躺在冷钱包里、根本不在市场上，
 *    用总流通量会让占比永远小得看不见（BTC 上限 14.3% ⇒ 折减至多 14%，毫无手感）。
 *
 * ⚠️ 分母是**可交易浮筹**、不是「日流动性」：两者是不同的量（前者是「能卖的存量」，
 *    后者是「每天成交的量」）。日流动性已经在滑点公式里当分母了，别再拿它算占比（见 ROADMAP §六）。
 */
export const FLOAT = {
  frac: 0.15,          // 可交易浮筹 ÷ 流通量
  depthFloor: 0.10,    // 深度折减下限：买光浮筹时深度仍存 10%（不允许归零 ⇒ 防除零与无穷冲击）
  overhangMax: 0.20,   // 抛压折价上限：share = 1 时价格被压 20%
};

/**
 * **对抗性流动性**（提案 B · NEXT-STEPS §五 · 2026-10-02 用户拍板「先做档 1 / k=4 / 下夹 25%」）——
 * 你的仓位相对市场越大，做市商越会**撤深度**。
 *
 * ⚠️ **不是**「交易所猎杀你的止损」—— 那条查无实据（§5.4 明令：GDD / ROADMAP 文案也不许写）。
 *    这里建模的是**有实据**的那一半：流动性撤退（SEC 2010-05-06 E-Mini 买方深度 100,000 张 →
 *    约 1,000 张，<1%）、危机后深度恢复慢（NY Fed 2015-08：闪崩后最长约一周）、
 *    以及机构风控对「大仓」的定义（Riskdata 卖速档 5/10/15/20% ADV；QuantEngines 8% ADV·5 天）。
 *
 * 触发量 `exposure = 玩家该币持仓名义 ÷ hourLiqBase`（**与资金费 `FR` 同一个分母**，§5.3 红线：
 * 不另立第二把尺子、不新开第二个池、不写第二条点差公式）。它进的是 `hourLiqBase` 里**已有的
 * 那个折减位置** —— 与 `FLOAT` 的浮筹折减**相乘、同处**。
 *
 * 与 `FLOAT` 的分工（§5.3）：`FLOAT` 是「**杠杆多头**枚数 ÷ 浮筹」（囤货，**存量**）；
 * 这里是「**杠杆盘**名义 ÷ 小时流动性」（瞬时压力）。两者口径不同，必须都留。
 *
 * 分档（§5.1）：
 *   · 档 0 `exposure < t1`      —— 无反应（常态，乘数**恰好 1** ⇒ 与改动前逐位相同）。
 *   · 档 1 `t1 ≤ exposure < t2` —— 深度按 `1 − k·(exposure − t1)` 收缩（下夹 `floor`）；
 *                                 OTC 点差按 `1 ÷ 深度乘数` 等比例放大；瞬时深度池的容量随基数
 *                                 一起缩小（池容量本就以 `hourLiqBase` 为基数，**不用另改**）。
 *   · 档 2 `exposure ≥ t2`      —— 在档 1 之上，向玩家的**强平方向**施加一笔有向位移（缺口 6-B）：
 *                                 位移 = `permImpactOf(pushK × (exposure − t2), σ)`，方向 = 持仓逆向
 *                                 （多 ⇒ 下压、空 ⇒ 上抬）。它**折进 `s.mkt[sym].npcDrift` 同一张台阶表**
 *                                 （见 `engine.syncNpcDrift`），不新开第二套价格通道。
 *                                 ⚠️ 只在**当前持仓存在且 `exposure ≥ t2`** 时生效（疤痕不算）；
 *                                    平仓即释放（下一级台阶把推价回落）。
 *                                 ⚠️ **不是**「猎杀止损」，§5.4 红线：文案不许写那一句。
 *   · 档 3 `exposure ≥ t3` **且** `d ≤ dRefSig·σ`（缺口 15 · 2026-10-03）——「**强平簇吸引**」：
 *                                 档 2 的幅度乘一个**距离感知**倍率 `advAimAmp`（离强平线越近越大，
 *                                 `d ≥ dRef` 时恰为 1），再夹在 `aimCap × σ`（唯一破 σ 的地方）。
 *                                 ⚠️ **两个诱因缺一不可** —— 只有大仓、或只有贴近强平线，都不触发
 *                                    （§5.4 不做凭空针对）。见 `ADV.t3` / `dRefSig` / `kAim` / `aimCap`。
 *
 * ⚠️ **公式是 `1 − k·(exposure − t1)`，不是 `1 − k·exposure`**：后者在 `exposure = t1` 那一瞬间
 *    深度会凭空掉 12%（`1 − 4×3%`）—— 一条不连续的口子。写成相对 `t1` ⇒ 档 1 入口处乘数**恰好 1**，
 *    与档 0 逐位接上。
 * ⚠️ **下夹 `floor` 与 `FLOAT.depthFloor` 同一理由**：深度不许归零，否则 `q → ∞`，滑点与拆单笔数
 *    一起失控。
 * ⚠️ `k = 4` 的实测含义：`exposure` 5% ⇒ 深度 −8%；8% ⇒ −20%；≥21.75% ⇒ 顶在 −75%（深度剩 25%）。
 *    取值理由：SEC 那个 <1% 是**全市场危机**的极端值，单个大户撤退应当显著但不到崩盘级。
 */
export const ADV = {
  t1: 0.03,        // 档 1 入口：持仓名义 = 本小时基准深度的 3%
  t2: 0.08,        // 档 2 入口（机构「大仓」5–20% ADV 的中位，§5.1）
  /**
   * **档 3 入口**（缺口 15 · 2026-10-03 用户拍板 = **`0.20`**）—— 「强平簇吸引」的规模门槛。
   *
   * 锚：Riskdata 流动性白皮书把机构「大仓」的卖速约束**预置为 5% / 10% / 15% / 20% ADV**
   * （用户可在四档里选）⇒ 本作三档正好取这张表的**下界 / 中位 / 上界**：
   * 档 1 `0.03` · 档 2 `0.08` · 档 3 `0.20`。**同一张表、同一把尺子**，不新立刻度（§5.3）。
   */
  t3: 0.20,
  k: 4,            // 收缩斜率（用户 2026-10-02 拍板）
  floor: 0.25,     // 深度乘数下限（用户 2026-10-02 拍板）
  halfHours: 168,  // 撤走的深度**恢复半衰期** = 1 周（NY Fed 2015-08）
  /**
   * **档 2 推价的力度系数**（缺口 6-B · 2026-10-03 用户拍板 = **`1.0`**）——
   * `q_adv = pushK × (exposure − t2)`，位移幅度 = `permImpactOf(q_adv, σ)`（**没有**阈值死区）。
   * 取 `1.0` ＝ 「超出 `t2` 的那部分 exposure **整份**折算成订单流量」—— 与玩家自己砸同样名义
   * 时用的是**同一把尺子**（`permImpactOf` 的 `q` 口径），不重标、不新立第二条公式。
   * ⚠️ `permImpactOf` 内部已被 `SLIP.cap = 0.25` 夹住 ⇒ 推价幅度上界 = `A×σ×√0.25 = σ`
   *    （2024 年 σ≈3.5% ⇒ ≤3.5%），再被 `SHOCK.hard` / `riseMax·fallMax` 兜一层。
   */
  pushK: 1.0,
  /**
   * **档 2 推价的缓入缓出半衰期**（游戏小时 · 2026-10-03 用户拍板 = **`6`**）。
   *
   * 病根（用户实测「画门」）：`advPushOf` 原来是个**瞬时开关** —— 玩家一平仓 / 一减仓它就返回 0，
   * 下一小时 `syncNpcDrift` 落的那级台阶立刻把推价**整段抹掉**（实测 −6.03% → +3.2%，单步 +10.7%），
   * K 线上就是一根把整屏压扁的「门」；反复开平 ⇒ 反复画门。真实盘口回补是**渐近**的
   * （Avellaneda–Stoikov 的库存回补；2025-10-10 崩盘里做市商 35 分钟才恢复九成），不是开关。
   * 故把推价做成一阶低通：每小时朝目标值靠 `1 − 0.5^(1/本值)` —— `6h` ⇒ 单小时只走 **10.9%**，
   * 平仓后推价按 `0.5^(t/6)` 缓慢释放（`t = 42h` 时残存 ≈ 0.8%，肉眼已看不出）。
   *
   * ⚠️ 与 `halfHours = 168`（**深度**恢复）**不是同一把尺子**，别混用：那是「撤走的流动性一周才回来」，
   *    拿它当推价的缓动会变成一条一周长的斜坡。两者互不影响（一个管成交代价、一个管价格位移）。
   */
  pushHalf: 6,
  /**
   * **档 3 · 强平簇吸引的距离参数**（缺口 15 · 2026-10-03 用户拍板）—— 缺口 15 的「猎物属性」。
   *
   * 病根：档 1 只让成交**变贵**、档 2 的推价又是个**与距离无关**的常数（只看 `exposure`）⇒
   * 「你的强平线周围正在发生什么」在模型里完全不存在，玩家的大仓没有「被围猎」的体感。
   *
   * 现实机制（可写的那一半，§5.4）：强平簇是**确定的被迫流**，价到那里就有一批单必须成交
   * ⇒ 它构成流动性的**结构性吸引子**；10/10 崩盘实测级联期清算速度是常态的 **87 倍**
   * （$6.93B / 40 分钟）、BTC 单日 −14.3%（≈ 3 倍 σ_30日）。
   * ⚠️ **不写**「算法/交易所故意扎针扫止损」—— 那条只有厂商营销口径，无一手实证（§5.4 明令）。
   *
   * 形态（`engine.advAimAmp`，**只在档 2 的同一个 `advPushOf` 里**乘一个因子，不新开通道）：
   *
   *     d   = |现价 − 强平价| ÷ 现价          （到强平线的相对距离）
   *     amp = 1 + kAim · clamp(1 − d ÷ dRef, 0, 1)      d ≥ dRef ⇒ 1；d = 0 ⇒ 1 + kAim
   *     推价 = min(档 2 推价 × amp, aimCap × σ)
   *
   * ⚠️ **诱因必须两个都满足**：`exposure ≥ t3` **且** `d ≤ dRef`。只有大仓、或只有贴近强平线，
   *    都不触发 —— 否则「小仓贴近强平线」会被无端加速（§5.4 不做凭空针对）。
   * ⚠️ **可逃**（平衡的关键）：减仓（`exposure` 掉回 `t3` 以下 ⇒ `amp` 归 1）或补保证金
   *    （强平线远离 ⇒ `d` 变大 ⇒ `amp` 回落）都能退出，且 `pushHalf = 6h` 的低通留出预警窗口。
   * ⚠️ **有界**：`amp ≤ 1 + kAim`、外层再夹 `aimCap × σ` ⇒ 正反馈（近 ⇒ 加速 ⇒ 更近）不会失控，
   *    也顶不到 `SHOCK.riseMax / fallMax`。
   *
   * ── 两个参数 ──────────────────────────────────────────────
   * 加速的**起始距离**（用户 2026-10-03 拍板 = **`3`**，单位是 σ_30日）—— `dRef = 3σ ≈ 10.5%`。
   *
   * 为什么用 σ 当距离单位、而不是拍一个绝对百分比：
   *   ① σ_30日 是本作**已有**的波动尺子（滑点 / OTC 溢价的分母，`dailySigma`）⇒ 不新立刻度；
   *   ② 实盘热力图工具识别强平簇本就按波动距离（Veles：以 ATR-20 的 0.35 倍内推建簇）；
   *   ③ 它对得上保证金：强平距离 ≈ 1/杠杆 ⇒ 5× ≈19.6% / 10× ≈9.5% / 25× ≈3.5%
   *      ⇒ `3σ ≈ 10.5%` **恰好覆盖 10× 及以上的全部档位**（即「杠杆盘」这一族的共同威胁半径），
   *      而 5× 那类低杠杆大仓**完全不受影响**（`d > dRef` ⇒ `amp ≡ 1`）—— 不扰民。
   */
  dRefSig: 3,
  /**
   * **贴近强平线时的推价倍率增量**（用户 2026-10-03 拍板 = **`1.0`**）—— `amp ∈ [1, 2]`。
   *
   * 取 1.0 ＝ 强平线**上**时把档 2 的推价**翻倍**（但仍被 `aimCap` 夹住）。
   * ⚠️ 现实里级联的过冲远不止 2 倍（10/10：−14.3% vs σ_30日≈3.5% ⇒ ≈3σ）；这里**故意收敛**，
   *    因为 §5.1 明令「门槛与力度太狠 ⇒ 大仓必死 ⇒ 反玩法」，会砍掉整条重仓策略线。
   */
  kAim: 1.0,
  /**
   * **档 3 推价的硬上界**（用户 2026-10-03 拍板 = **`1.5`**，即 `1.5 × σ_30日`）。
   *
   * ⚠️ 这是本文件里**唯一**一处允许推价突破 `σ` 的地方 —— 档 2 的推价仍恒 `≤ σ`
   *    （`permImpactOf` 的 `SLIP.cap = 0.25` 夹住）。理由：把「强平簇吸引」与「档 2 的常规推价」
   *    分成**两个可分辨的量级**，否则档 3 在 `exposure ≥ 33%` 段与档 2 逐位相同（档 2 已饱和）。
   * 取值 `1.5` 的落点（σ = 3.5% ⇒ ≤ 5.25%）：5× 不受影响、10× 几乎不受影响（`amp ≈ 1.10`）、
   * **25× 及以上才真正被威胁** —— 惩罚的恰好是现实中最危险的那一档。
   * ⚠️ 改这个数要先想清楚「大仓 + 高杠杆 = 必爆」会不会毁掉玩法（§5.1）。
   */
  aimCap: 1.5,
  /**
   * 预警日志门槛：深度乘数首次跌到本值以下（即**降幅 ≥ 10%**，对应 `exposure ≈ 5.5%`）时播报一条。
   * ⚠️ 不能用「进入档 1」当门槛：档 1 入口处的降幅**恰好是 0%**，日志会写成「深度下降 0%」这句废话。
   */
  warnMul: 0.9,
};

/**
 * OTC（场外交易 / 大宗交易，P2-B3 · GDD §15.3）—— 大额单子的**逃生门**：
 * 对手方私下一口价成交，**不吃滑点**，代价是一笔溢价。
 *
 * 形态（2026-10-03 用户拍板改判）：**大宗通道、跟随当前模式** —— 走 OTC 时不再强制 1x，
 *   而是**沿用玩家当前的 `s.mode`**（杠杆 / 合约），但杠杆**封顶 `OTC.levMax = 5`**、
 *   且**允许做空**（机构间的大宗撮合本就是双向的）。
 *   ① 现实里 OTC 台做的就是「大宗撮合」，机构借贷口径的杠杆上限约 5x（见 `levMax`）；
 *   ② 若 OTC 能跟着合约上 100x，它就成了「无滑点 ＋ 高杠杆」的纯优解，§14.3 那套滑点对大户直接失效
 *      —— 封顶 5x 正是为了堵住这一条。
 *   ⇒ 仓位的 `margin` 标记由 `s.mode` 决定（`engine.marginOf`），与普通单走同一套性质。
 *      ⚠️ 「1x」仍算杠杆通道的最低档（本作没有现货概念）：多头不计息、不参与强平；
 *         空头借币 ⇒ 照常计息、照常有强平线。
 *
 * ⚠️ `unlock` / `min` 两个门槛（2026-10-02 · 调研①拍板）**已由绝对美元常量改为年代表**
 *    （`OTC.unlock` / `OTC.min` ＋ `otcUnlockAt(t)` / `otcMinAt(t)`）——
 *    GDD §15.3 的原值（$5M / $1M）在 2013 年的新流动性锚下等于 8.9 / 1.8 天全市场成交量，
 *    早期 OTC 成了死内容。2020 端仍回到 $5M / $25 万的量级，现代端手感不变。见 `OTC` 注释。
 *
 * ── 溢价（P2-B 修订 · 史实化，2026-09-29）────────────────────────────────
 * 原先是**固定 1%**。查证后的史实是：OTC 溢价**既随年代收敛、又随市况炸开** ——
 *   ① 常态是**双向点差**，机构台 $1M–$10M 档约 0.10%–0.20%（弱来源，仅取量级）；
 *      越早期场子越薄、做市商越少 ⇒ 点差越宽（2013 的 BTC 场外远贵于 2020）
 *   ② 危机期做市商撤退 ⇒ 点差炸开（2020-03-12 Coinbase vs Binance 最大价差 $1,000–1,200）；
 *      中国 USDT/CNY 场外溢价在 2017 牛市 >+5%、2020-03-12 后一度 +8%、2021-05-19 **+5.67%**
 * 于是改成 **`基准点差(年代)` × `市况倍数(σ_30日)`**：
 *
 *     base(t)  = 几何插值，两端锚定（同一写法见 §15.2 的日流动性）
 *     mult     = clamp( (σ_30日 ÷ σ_基准)^p , 1, multCap )
 *     溢价     = clamp( base × mult , base , max )
 *
 * ⚠️ `σ_基准` **必须按年代分档**：2013 年的 BTC 天天 3% 波动、2020 年只有 2.9%，
 *    不归一的话 `mult` 度量的是「绝对波动」而不是「相对自己那个年代有多慌」，
 *    早期会被判成「永远在危机中」。三档取自**实测**（2026-09-29 从 BTC.bin 量出）：
 *    σ_30日 的年代中位数 = 2013-2015 **3.33%** / 2016-2019 **3.44%** / 2020-2024 **2.89%**
 * ⚠️ `p = 4`：实测危机期 σ 约为常态的 2–3 倍，而危机点差约为常态的 20–40 倍
 *    ⇒ p ≈ log(30) / log(2.5) ≈ 3.7，取整 4。
 * ⚠️ `multCap = 40` / `sizeCap = 4` / `max = 8%` 是**三道不同的闸**：前两道夹倍数、最后一道夹价格。
 *    v19 起规模倍数（≤ `sizeCap` = 4×，见 `otcPremiumOf`）也叠进来 ⇒ 最贵一档 = `base` × 40 × 4
 *    = `base` × 160，而三段 `base` 最低也有 0.15% ⇒ 三个年代的中高市况单**一律被兜在 `max = 8%`**
 *    （2013-12 那种 σ 12.3% 的癫狂期同样顶在这里，看不出年代差）。
 *    `base` / `multCap` 的差别只在中低市况 ＋ 中小单那一段还看得见。
 */
export const OTC = {
  /**
   * **单笔下限 `min(t)`** 与**解锁门槛 `unlock(t)`** —— 年代表（2026-10-02 调研①拍板，
   * 与 `base` / `sigmaRef` 同一写法：几何插值 / 步骤函数）。
   *
   * 病根：这两个数原来是**绝对美元常量**（`$1M` / `$5M`）。而流动性锚改逐年之后（§6.1），
   * 2013 的 BTC 只有 **$564.5K/天** ⇒ 一笔 $1M 的 OTC 单 = **1.8 天全市场成交量**，
   * 现实里 2013 年**不存在**能承接这个量的台（机构 OTC 台是 2018 年 Coinbase Prime 之后的事）；
   * 要攒到 $5M 权益才解锁 = 8.9 天全市场成交量 ⇒ **2013–2014 的 OTC 是死内容**。
   * 连带的第二个病：`otcPremiumOf` 的规模倍率以 `notional ÷ OTC.min` 为基准 ⇒ 2013 年一笔
   * 天量 $1M 单只拿到最窄的 ×1 —— 「大宗越大越贵」这条在早期整体失效。
   *
   * 现实锚（本轮检索）：
   *   · 2020 前后机构台单笔下限 **$50K**（Kraken OTC / Coinbase Prime / Binance OTC）、
   *     **$100K**（Cumberland）、**≈$200K**（Galaxy / Wintermute）⇒ 取 **$250K**（区间上沿）；
   *   · 早期小台（BitcoinVN，2014 成立）公开下限 **$10K** ⇒ 2013 取 **$10K**。
   *   · `unlock = min × 20` 这条比例**恰好让 2020 端回到原来的 $5M** ⇒ 现代端手感一字不变。
   */
  min: [
    { t: Date.UTC(2013, 0, 1), v: 1e4 },      // $1 万：对齐早期小台（BitcoinVN 2014 公开下限）
    { t: Date.UTC(2016, 0, 1), v: 1e5 },      // $10 万：以太 ICO 潮、机构开始进场
    { t: Date.UTC(2020, 0, 1), v: 25e4 },     // $25 万：Cumberland / Galaxy 区间上沿，此后不再变
  ],
  unlock: [
    { t: Date.UTC(2013, 0, 1), v: 2e5 },      // $20 万 ＝ min × 20
    { t: Date.UTC(2016, 0, 1), v: 2e6 },      // $200 万
    { t: Date.UTC(2020, 0, 1), v: 5e6 },      // $500 万（与改动前逐位相同）
  ],
  base: [           // 基准点差（常态点差）—— 几何插值的锚点，按年代收敛
    { t: Date.UTC(2013, 0, 1), v: 0.0050 },   // 0.50%：早期场子薄、做市商少
    { t: Date.UTC(2016, 0, 1), v: 0.0030 },   // 0.30%
    { t: Date.UTC(2020, 0, 1), v: 0.0015 },   // 0.15%：机构化之后，2020 起不再降
  ],
  sigmaRef: [       // σ_基准（该年代的「常态波动」）—— 步骤函数，取实测年代中位数
    { t: Date.UTC(2013, 0, 1), v: 0.0333 },
    { t: Date.UTC(2016, 0, 1), v: 0.0344 },
    { t: Date.UTC(2020, 0, 1), v: 0.0289 },
  ],
  p: 4,             // 市况倍数的指数
  multCap: 40,      // 市况倍数上限
  sizeP: 0.5,       // 规模倍数的指数（v19）：平方根律，与 §14.3 滑点同形
  sizeCap: 4,       // 规模倍数上限（v19）：本笔名义 = 16 × min 时顶格
  max: 0.08,        // 溢价硬上限 8%（任何年代、任何市况）
  /* 大宗通道的**杠杆封顶**（2026-10-03 拍板）—— OTC 跟随当前模式，但机构借贷口径约 5x：
     现实里机构间的场外融资（prime brokerage / margin lending）上限约 5–10x，取保守的 5x。
     ⚠️ 它是**第二道上限**：与 `leverageOptionsAt(t, exId, kind)` 的当场上限取小值。 */
  levMax: 5,
};

/** 几何插值（两端锚定，同 §15.2 日流动性的写法）—— `base` / `min` / `unlock` 三张表共用一处口径 */
function geomAt(a, t) {
  if (t <= a[0].t) return a[0].v;
  for (let k = 1; k < a.length; k++) {
    if (t < a[k].t) {
      const f = (t - a[k - 1].t) / (a[k].t - a[k - 1].t);
      return a[k - 1].v * Math.pow(a[k].v / a[k - 1].v, f);   // 几何插值
    }
  }
  return a[a.length - 1].v;
}

/** OTC 常态点差 `base(t)` */
export const otcBaseAt = t => geomAt(OTC.base, t);

/** OTC 单笔下限 `min(t)`（2026-10-02 · 调研①）—— 早期台子门槛低，2020 起定格 $25 万 */
export const otcMinAt = t => geomAt(OTC.min, t);

/** OTC 解锁门槛 `unlock(t)`（2026-10-02 · 调研①）—— 恒为 `min × 20`，2020 端 = $500 万（与改动前相同） */
export const otcUnlockAt = t => geomAt(OTC.unlock, t);

/** 该年代的 σ_基准 —— 步骤函数，升序取「最后一个 `t <= 时刻`」 */
export function otcSigmaRefAt(t) {
  let v = OTC.sigmaRef[0].v;
  for (const s of OTC.sigmaRef) { if (s.t <= t) v = s.v; else break; }
  return v;
}

/**
 * 一次 OTC 成交的溢价（买上抬 / 卖下压的幅度）。
 * @param {number} sigma 该币当前的 σ_30日（`impact.sigmaOf` 的结果，与滑点同一个数）
 * @param {number} t     游戏时刻（ms）
 * @param {number} notional 本笔成交的名义额（v19）—— 大宗越大越贵
 * @returns {number} `base(t)` ~ `OTC.max`
 *
 * ⚠️ **规模倍数（v19 · 2026-10-01 用户拍板）**：现实里大宗台的报价随**单笔规模**变宽 ——
 *    同样一个基准点差，`min` 那一档的单与 16 倍于它的单拿到的价不一样。
 *    倍率取**平方根律**（`sqrt(名义 ÷ min(t))`，与 §14.3 滑点同形），上限 `sizeCap = 4` ——
 *    即本笔名义 ≥ 16 × `min(t)` 之后不再变宽；恰好等于 `min(t)` 的单倍率为 1。
 *
 * ⚠️ **基准是 `min(t)` 而不是常量**（2026-10-02 · 调研①）：门槛改年代表之后，这个倍率自动
 *    变成「**相对当年代**的大宗程度」—— 2013 年一笔 $1M 的单会拿到接近顶格的宽度（它当年是天量），
 *    而在 2020 年 $1M 只是 4 × min、宽度温和。改动前用绝对常量 ⇒ 早期的天量单反而最便宜。
 */
export function otcPremiumOf(sigma, t, notional) {
  const min = otcMinAt(t);
  const n = Number.isFinite(notional) && notional > 0 ? notional : min;
  const base = otcBaseAt(t);
  const s = Number.isFinite(sigma) && sigma > 0 ? sigma : otcSigmaRefAt(t);
  const mult = Math.min(OTC.multCap, Math.max(1, Math.pow(s / otcSigmaRefAt(t), OTC.p)));
  const size = Math.min(OTC.sizeCap, Math.max(1, Math.pow(Math.max(n, min) / min, OTC.sizeP)));
  return Math.min(OTC.max, Math.max(base, base * mult * size));
}
