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
  /** 初始资金 $3,000 **USD（美元法币，不是 USDT）** —— 两格账本的口径见方案 §2 */
  cash: 3000,
  /** 开局资金放在哪家交易所（GDD §7.2：2013 年只有 Mt.Gox 一个选择） */
  ex: 'mtgox',
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
   * 默认下单模式（U1 · ROADMAP §21.4）—— `'spot'`（现货）或 `'fut'`（合约）。
   * 开局默认 **`'spot'`**：玩家不动操作区那枚「模式」键时，「1x 做多」就是现货 ——
   * 与改动前的自动判定（`side === 'long' && lev === 1`）**逐位相同**，开局观感一字不变。
   * ⚠️ 这里只是**默认值**；真实生效的模式存在 `s.mode` 里（入存档，玩家可随时切换）。
   */
  mode: 'spot',
};

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
     它是**数据回溯起点**，不是「游戏里能交易的时刻」：游戏照样 2013-01-01 开盘、照样 $3,000 起步。
     为什么要这一段：`GAME.start` 那一刻图上只有 1 根 K 线（左半边全空）、`24h 涨跌幅` 无参照、
     `σ_30日` 只能走兜底 3%。补 **96 天**（2,304 根，见下）刚好填满一屏 1d 视野（`view.defaultCount` 上限 96）。
     ⚠️ 这一段**不是日线插值**，是 Bitstamp 同一接口、同一 `btcusd` 交易对的**真小时线**
     （实测可回溯到 2011-08-19 00:00；这里只取到 2012-09-27，够用又不冗余）。 */
  { sym: 'BTC',  name: '比特币',  unlock: Date.UTC(2012, 8, 27, 0),  otc: Date.UTC(2013, 0, 1),  src: { bitstamp: 'btcusd', bitfinex: 'tBTCUSD', binance: 'BTCUSDT',  binanceus: null } },
  { sym: 'DOGE', name: '狗狗币',  unlock: Date.UTC(2014, 0, 21, 22), otc: Date.UTC(2018, 0, 1),  src: { bitstamp: null,     bitfinex: null,      binance: 'DOGEUSDT', binanceus: null },
    cdd: [{ file: 'Poloniex_DOGEUSDT_1h.csv', quote: 'USDT' }, { file: 'Poloniex_DOGEBTC_1h.csv', quote: 'BTC' }] },
  { sym: 'XRP',  name: '瑞波币',  unlock: Date.UTC(2014, 7, 14, 3),  otc: Date.UTC(2018, 0, 1),  src: { bitstamp: 'xrpusd', bitfinex: null,      binance: 'XRPUSDT',  binanceus: null },
    cdd: [{ file: 'Poloniex_XRPUSDT_1h.csv', quote: 'USDT' }, { file: 'Poloniex_XRPBTC_1h.csv', quote: 'BTC' }] },
  { sym: 'ETH',  name: '以太坊',  unlock: Date.UTC(2015, 7, 8, 6),   otc: Date.UTC(2016, 5, 1),  src: { bitstamp: 'ethusd', bitfinex: null,      binance: 'ETHUSDT',  binanceus: null },
    cdd: [{ file: 'Poloniex_ETHUSDT_1h.csv', quote: 'USDT' }] },
  { sym: 'SOL',  name: 'Solana',  unlock: Date.UTC(2020, 7, 11, 6),  otc: Date.UTC(2021, 0, 1),  src: { bitstamp: null,     bitfinex: null,      binance: 'SOLUSDT',  binanceus: 'SOLUSD' } },
];

/** 按符号取币种定义 */
export const coinOf = sym => COINS.find(c => c.sym === sym) || null;

/**
 * 四家交易所（GDD §7.1 / §7.2）—— 全是**史实里的真名**，玩家一眼能对上当年的新闻。
 *
 * 每家字段：
 *   - `open` / `close`：开业与归零时刻（`close: null` = 活到现在）。
 *     `close` 不只是「不能再用」的标记，还是**归零事件**的触发点（见 `engine.advanceOneHour`）：
 *     到点那一刻，该所余额清零、挂在该所的持仓一并作废。Mt.Gox 的 2014-02-25 就是本作最重的一记闷棍。
 *   - `spotSteps`：**现货融资**（margin）的杠杆上限阶梯，升序取「最后一个 `from <= t`」。
 *   - `futSteps` ：**合约**（线性 USDT 本位永续）的杠杆上限阶梯；**`null` ＝ 该所永不提供合约**。
 *   - `fees`     ：**吃单费率的两张年代阶梯**（`spot` / `fut`），升序取「最后一个 `from <= t`」，
 *                  `null` ＝ 该所那个时刻还没有这类产品。开仓与平仓各收一次（单边、不区分 Maker/Taker）。
 *   - `hack`     ：**被盗削减**事件（B21 · 可选）—— `{ at, cut }`：到点把该所**两格余额各 ×(1 − cut)**，
 *                  **不动持仓、不动其他所**（与 `close` 的整所归零是两回事）。
 *   - `halts`    ：**停机维护**窗口（B24 · 可选）—— `[{ from, to }]`：窗口内**只平不开**
 *                  （判据走 `haltedAt()`，别在调用处自己比时刻）。
 *
 * ⚠️ **现货与合约是两回事，费率也必须是两张表**（v12 · 方案 §11.0 偏离①）：
 *    改动前每家只有一个 `fee`，于是 BitMEX 的 **0.05%（衍生品）** 与 Binance 的 **0.04%（合约）**
 *    被当成了现货费率套用到全部场景 —— 四个数字里三个偏离史实（§11.0 偏离②）。
 *    史实出处见方案 §11.9，**不要凭记忆改这些数字**。
 *
 * ⚠️ **两张表是两回事**（v9 · 方案 §15，2026-09-29 拍板）：史实上「现货融资上限」与「合约上限」
 *    从来不是同一个数 —— Bitfinex 现货 3.3x / 合约 100x，BitMEX 没有现货 / 合约 100x。
 *    改动前它们被混成一张 `steps`，于是 2013 年在 Mt.Gox 也能看到 100x 这种笑话。
 *
 * 史实出处（2026-09-29 二次核实，勿再凭记忆改动）：
 *   Mt.Gox   2014-02-25 停止一切交易（本项目以这天为归零点），此前**仅现货 1x、无融资**
 *   Bitfinex 现货 2013 年上线即 3.3x（＝初始保证金 30%）；2020-01-30 → 5x；2021-02-17 → 10x（官方公告）。
 *            合约 **2019-09-02** 才上线（`BTCF0/USDt0`：USDT 抵押、逐仓、最高 100x）
 *   BitMEX   没有现货（本作把它的现货抽象为 1x）；合约 **2016-05-13** `XBTUSD` 永续上线才给到 100x
 *            （2015-10 的 100x 属于季度交割合约，本作实现的是线性 USDT 本位永续，故挂在永续上线日）
 *   Binance  2017-07-14 上线，起初仅现货 1x；2019-07-11 保证金交易上线（3:1），2019-11-19 放到 5x。
 *            合约 **2019-09-13** 上线（BTCUSDT 永续，首日 20x）→ 2019-10-18 起 125x → 2021-07-19 起限 20x
 *
 * ⚠️ **所有合约上线日都在 USDT 发行（2014-11）之后** ⇒ 「合约保证金必须 USDT」堵不死玩家的路（§15.2）。
 */
export const EXCHANGES = [
  {
    id: 'mtgox', name: 'Mt.Gox',
    open: Date.UTC(2013, 0, 1), close: Date.UTC(2014, 1, 25),
    spotSteps: [{ from: Date.UTC(2013, 0, 1), max: 1 }],
    futSteps: null,
    /* 史实：小户 **0.60% 起**，按最近 720 小时（30 天）滚动成交量阶梯递减、最低 0.25%；
       **买卖双方都收**（本作只有单笔市价成交，记单边一次）。 */
    fees: { spot: [{ from: Date.UTC(2013, 0, 1), v: 0.006 }], fut: null },
  },
  {
    id: 'bitfinex', name: 'Bitfinex',
    open: Date.UTC(2013, 0, 1), close: null,
    spotSteps: [
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
       没有独立的合约费率档 ⇒ **沿用现货 taker 0.20%**（§11.2，是史实而非近似）。 */
    fees: {
      spot: [{ from: Date.UTC(2013, 0, 1), v: 0.002 }],
      fut: [{ from: Date.UTC(2019, 8, 2), v: 0.002 }],
    },
  },
  {
    id: 'bitmex', name: 'BitMEX',
    open: Date.UTC(2014, 0, 1), close: null,
    spotSteps: [{ from: Date.UTC(2014, 0, 1), max: 1 }],
    futSteps: [{ from: Date.UTC(2016, 4, 13), max: 100 }],
    /* 史实（B24 · 2026-09-30 联网复核修正）：2020-03-13「黑色星期四」BitMEX 因 DDoS / 技术故障
       停机，实测窗口 **02:16–03:00 UTC（约 44 分钟）**，恰好在最需要平仓的暴跌里 ——
       这段时间**只平不开**。（当天 12:56–13:21 还有一次短暂 DDoS，量级很小，本作不实现。）
       ⚠️ 本作的时刻一律是**整点**（`s.i` 就是小时序号，停机/恢复日志用 `===` 判等），
          所以窗口取整到 **02:00–03:00** —— 44 分钟无法在小时网格上表达。 */
    halts: [{ from: Date.UTC(2020, 2, 13, 2), to: Date.UTC(2020, 2, 13, 3) }],
    /* 现货 0.05% flat（该所现货市场一直很小）。
       衍生品 **Taker 0.075% / Maker −0.025%（返佣）** —— 2016-05 XBTUSD 永续上线起的经典档位；
       现代降到 base 0.05%/0.05% ⇒ **2021-01 起 0.05%**（⚠️ 切换时刻为近似，方案 §11.2）。
       ⚠️ 0.075% 那一段的实际起点是永续上线日（`futSteps` 首档 2016-05-13），阶梯写 2014-01
          只为与方案 §11.2 的表述一致 —— 取不到合约的年份，这条阶梯根本不会被查到。 */
    fees: {
      spot: [{ from: Date.UTC(2014, 0, 1), v: 0.0005 }],
      fut: [
        { from: Date.UTC(2014, 0, 1),  v: 0.00075 },
        { from: Date.UTC(2021, 0, 1),  v: 0.0005 },
      ],
    },
  },
  {
    id: 'binance', name: 'Binance',
    open: Date.UTC(2017, 6, 14), close: null,
    spotSteps: [
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
    /* 现货 **0.10% maker / 0.10% taker**（2017-07 上线即此价；BNB 抵扣属「持平台币」玩法，不做）。
       合约 USDT-M 永续 **Maker 0.02% / Taker 0.04%** ⇒ 合约上线日 2019-09-13 起 0.04%。 */
    fees: {
      spot: [{ from: Date.UTC(2017, 6, 14), v: 0.001 }],
      fut: [{ from: Date.UTC(2019, 8, 13), v: 0.0004 }],
    },
  },
];

/** 按 id 取交易所定义 */
export const exchangeOf = id => EXCHANGES.find(e => e.id === id) || null;

/** 这家所此刻是否**停机维护**（B24）—— 窗口内只平不开。没配 `halts` 的所恒 `false` */
export const haltedAt = (t, exId) =>
  !!exchangeOf(exId)?.halts?.some(h => t >= h.from && t < h.to);

/** 取某家交易所某一类的杠杆阶梯（`kind`：`'spot'` 现货融资 / `'fut'` 合约）；该所不提供时为 `null` */
export const stepsOf = (ex, kind = 'spot') => (kind === 'fut' ? ex.futSteps : ex.spotSteps);

/**
 * 某家交易所**此刻**提不提供该类杠杆（v9 · §15.3 N3）—— 判据 = 阶梯存在且首档已生效。
 * UI 用它决定那枚「现货 / 合约」模式键出不出现（＝「没有的选项不显示」）。
 */
export function hasLeverageKindAt(t, exId, kind = 'spot') {
  const ex = exchangeOf(exId);
  if (!ex) return false;
  const steps = stepsOf(ex, kind);
  return !!steps && steps.length > 0 && steps[0].from <= t;
}

/** 某一时刻、某家交易所、某一类的最高杠杆（该所不提供这一类时返回 1） */
export function maxLeverageAt(t, exId, kind = 'spot') {
  const ex = exchangeOf(exId);
  if (!ex) return 1;
  const steps = stepsOf(ex, kind);
  if (!steps) return 1;
  let max = 1;
  for (const s of steps) { if (s.from <= t) max = s.max; else break; }
  return max;
}

/**
 * 某家交易所**此刻**开没开**融资**（借 U 买入 / 借币卖出）—— v10 · 现货做空的**史实判据**。
 *
 * 判据只有一条：**现货表的上限 > 1**。上限 1 就是「用自己的钱买币」，交易所不做出借方；
 * 有 3x / 5x 才说明它真的把钱借给你 —— 而**做空必须先借到币**，借不到就没有现货空单。
 *   - 借不到 ⇒ Mt.Gox（全期）、BitMEX 现货、Binance 2017-07～2019-07-11
 *   - 借得到 ⇒ Bitfinex（2013 起 3.3x）、Binance（2019-07-11 起 3x）
 *
 * ⚠️ **与合约无关**：合约做空是保证金交易，不需要借币，照旧只按 `futSteps` 判。
 */
export const hasFinancingAt = (t, exId) => maxLeverageAt(t, exId, 'spot') > 1;

/**
 * 可选杠杆档位：从 1 到当前上限，取这几个常用值（GDD §18.1 的杠杆选择器）。
 * ⚠️ **`125` 必须在表里**：它是 Binance 合约的史实上限（§15.1），
 *    而 `100` 是 BitMEX / Bitfinex 的上限 —— 少了 125，「上限补进」那条虽然也能凑出这一格，
 *    但 125 与 100 之间就没有任何可选的中间档，档位表的语义会变得含糊。
 */
const LEV_LADDER = [1, 2, 3, 5, 10, 20, 50, 100, 125];

/** 某一时刻、某家交易所、某一类可选的杠杆档位（1 与上限必在列表内） */
export function leverageOptionsAt(t, exId, kind = 'spot') {
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
 *   - **现货保证金（`margin`）**：Bitfinex 史实的 **15%（权益口径）**（CFTC Docket 16-19 原文
 *     `equity … fell below 15% → forcibly liquidated`）；本项目把它**统一套到所有 margin 仓**
 *     （含 Binance 2019-07 起的保证金交易）并声明为近似 —— Binance 自家是另一套分档，不另立一张表
 *
 * ⚠️ **工具性质由仓位自己决定**（`positions.instrumentOf`）：`spot` 表 + `lev > 1` ⇒ `margin`、
 *    `fut` 表 ⇒ `perp`。2016-05-13 之前世界上没有永续（BitMEX XBTUSD 是人类第一个），
 *    所以那年头的「杠杆」全是借钱买币 —— 这一条正是 B26 与 B18 共用同一次改动的理由。
 *
 * ⚠️ **数值口径**：Binance 四档来自 2026-09-29 检索（方案 §12.10 出处）；15% 来自 CFTC 原文；
 *    **清算费 0.5% 无一手出处**（检索到 0.5% 与 1.25–2.5% 两说）⇒ GDD 声明为合成值。
 */
export const MARGIN = {
  /** 现货保证金的维持保证金率（权益口径）—— CFTC Docket 16-19 史实 */
  maint: 0.15,
  /**
   * **借贷日息**（B26）—— 史实只有「用户间 P2P 按市场利率计息」这个形态（Bitfinex 的
   * Margin Funding Provider），**具体数值是合成值**：按年代收敛，早年借贷市场薄、利率高，
   * 近年廉价。形态取自真实机制，数字需在 GDD 声明为合成。
   */
  daily: [
    { from: Date.UTC(2013, 0, 1),  v: 0.0003 },   // 2013–2016：0.03% / 日
    { from: Date.UTC(2017, 0, 1),  v: 0.0005 },   // 2017–2019：0.05% / 日
    { from: Date.UTC(2020, 0, 1),  v: 0.0002 },   // 2020 起   ：0.02% / 日
  ],
};

/** 强平清算费（B20）—— 触发强平那一刻，从**残余权益**里先扣掉 `名义 × 本值`，抵剩下的才返还。 */
export const LIQ = { fee: 0.005 };

/**
 * **单笔最小名义**（2026-09-30 裁决，单位：美元）—— 低于它的开仓 / 挂单直接拒绝。
 *
 * 为什么必须有这一条：`openTrade` / `placeOrder` 只把保证金**夹到可用余额**，没有下限 ——
 * 于是一格余额剩 `1e-16`（浮点残值：平仓找零、归零后的碎屑）时也能建出一张
 * 「名义 1e-16 的持仓 / 挂单」，持仓条与资产页就多出一条点不掉也平不掉的幽灵行
 * （长局抽检实测 7 处尘埃仓、1 处尘埃挂单）。
 * ⚠️ 门槛取 **$1**：比本作任何一笔正常下单小三个数量级（开局 $3,000），
 *    只用来砍掉「数值上等于 0」的东西，不参与任何平衡。
 */
export const MIN_NOTIONAL = 1;

/**
 * Binance 永续的维持保证金率四档（名义价值越大越严）。
 * 尾档 `>= $500 万` 取 5%；真正的 1 亿以上 10–15% 不实现（本作资金量级到不了）。
 */
const BINANCE_MARGIN_TIERS = [
  { upTo: 5e4,       rate: 0.004 },
  { upTo: 2.5e5,     rate: 0.005 },
  { upTo: 1e6,       rate: 0.01 },
  { upTo: 5e6,       rate: 0.025 },
  { upTo: Infinity,  rate: 0.05 },
];

/**
 * 该所 / 该工具 / 该名义档的维持保证金率（B18 + B26）。
 * @param {string} exId 交易所 id
 * @param {number} notional 名义价值 —— 只有 Binance 永续按它分档
 * @param {'perp'|'margin'} kind 工具性质（`positions.instrumentOf` 提供）
 * @returns {number} 比率；缺省回落到 `GAME.maintRate`（0.5%）
 */
export function maintRateAt(exId, notional, kind = 'perp') {
  if (kind === 'margin') return MARGIN.maint;
  if (exId !== 'binance') return GAME.maintRate;
  const n = Number.isFinite(notional) && notional > 0 ? notional : 0;
  for (const t of BINANCE_MARGIN_TIERS) if (n < t.upTo) return t.rate;
  return GAME.maintRate;
}

/** 该时刻的**借贷日息**（B26）—— 升序取「最后一个 `from <= t`」 */
export function marginDailyRateAt(t) {
  let v = MARGIN.daily[0].v;
  for (const s of MARGIN.daily) { if (s.from <= t) v = s.v; else break; }
  return v;
}

/**
 * 某家交易所**某一时刻、某一类**的吃单费率（v12 · 方案 §11.3）。
 *
 * @param {string} exId 交易所 id
 * @param {number} t    时刻（毫秒）—— 费率是**年代阶梯**，同一家所不同年份可能不同
 * @param {'spot'|'fut'} kind 现货 / 合约。**调用方必须传对**：一笔单走哪一张表由那笔单自己的
 *   性质决定（现货仓走 `spot`、合约仓走 `fut`，判据 `positions.isSpot`），不是由玩家此刻站在哪个页面决定。
 *
 * 回落链：该类的阶梯取不到 ⇒ **回落到现货**（Bitfinex 的「合约」本就没有独立费率档）；
 * 现货也取不到（该所那时还没开业）⇒ **0**（不收钱，而不是崩）。`fut: null` 同理回落到现货。
 */
export function feeRateOf(exId, t, kind = 'spot') {
  const ex = exchangeOf(exId);
  if (!ex) return 0;
  const at = (ladder) => {
    if (!ladder) return null;
    let v = null;
    for (const s of ladder) { if (s.from <= t) v = s.v; else break; }
    return v;
  };
  const fut = kind === 'fut' ? at(ex.fees.fut) : null;
  const v = fut != null ? fut : at(ex.fees.spot);
  return v != null ? v : 0;
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
 * ⚠️ **不实现「改搬 BTC」**（B17）：本作账本是美元/USDT 记价，搬币在模型上等价于「电汇 ＋ 两次现货费」。
 * ⚠️ **不模拟 Mt.Gox 那 22 个月的电汇积压**（B15）：那等于本局结束；退化为固定定额费 ＋ 数天到账。
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
 * 三处消费：① 发起转账时搬哪一格（`engine.switchExchange`）② 借款打哪一格（`takeLoan`）
 * ③ 上帝模式「填入资金」填哪一格（`main.js`）。
 * ⚠️ 开局那 $3,000 是 USD（`GAME.cash`），所以 2013 年**两格账本只用得上第一格** ——
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

/**
 * 场外配资（Batch 5 · B30，2026-09-29）—— **资产归零时**可以借一次的救命钱。
 *
 * 三条口径（用户拍板，勿擅改）：
 *   - **只给 1 次**：第二次归零就是真结束，GDD §10「唯一失败条件」没有失效
 *   - **额度与身家脱钩**：按年代递增的定额。原提议「按峰值 25%」被否掉
 *     （「假设有人到达过千万美元，真的可能借那么多吗？」）—— 那是配资，不是救命钱
 *   - **日息 0.1% × 180 天单利**：`owe` 在借款那一刻就算好写在遮罩上，是一个确定的数，
 *     而不是一条要玩家自己推的曲线（复利折算成日息 0.0995% 对玩法毫无影响，LESS IS MORE）
 */
export const LOAN = {
  ratePerDay: 0.001,   // 日息 0.1%（单利）
  days: 180,           // 期限 180 天（= 4320 游戏小时）
  warnLead: 7 * 24,    // 到期前 7 天给第一条预警（第二条是 24 小时，写在引擎里）
};

/** 借款额度按年代三档 —— 刚爆仓的人借不到大钱，代价只与年代有关、与你的损失无关 */
export function loanAmountAt(t) {
  if (t < Date.UTC(2017, 0, 1)) return 1000;
  if (t < Date.UTC(2022, 0, 1)) return 2000;
  return 5000;
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
 *    BTC 14.3% × 2013 年的 1061 万枚 ≈ 152 万枚，按当年 $13 算就是 $1,975 万，而玩家开局只有 $3,000。
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
 * OTC（场外交易 / 大宗交易，P2-B3 · GDD §15.3）—— 大额单子的**逃生门**：
 * 对手方私下一口价成交，**不吃滑点**，代价是一笔溢价。
 *
 * 形态（2026-09-29 拍板，勿擅改）：**只有现货 1x** —— 不做杠杆、不做空。
 *   ① 现实里 OTC 就是现货大宗撮合，没有「OTC 永续」这种东西；
 *   ② 若 OTC 能上 100x，它就是「无滑点 ＋ 高杠杆」的纯优解，§14.3 那套滑点对大户直接失效。
 *   ⇒ 仓位打 `spot` 标（`positions.isSpot` 读的就是它），**零新增仓位类型**。
 *
 * ⚠️ `unlock` / `min` 两个门槛是 GDD §15.3 的原值，**暂不改**：真机跑一局后按实测资产曲线复校。
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
 * ⚠️ `multCap = 40` 与 `max = 8%` 是**两道不同的闸**：前者夹倍数、后者夹价格。
 *    落到各年代：2020+ 最多 0.15% × 40 = **6%**（危机期实测 3%–6%）；2016-2019 与 2013-2015
 *    被 `max` 兜在 **8%**（2013-12 那种 σ 12.3% 的癫狂期正好顶到这里）。
 */
export const OTC = {
  unlock: 5e6,      // 权益 > $500 万 才解锁（§15.3）
  min: 1e6,         // 单笔名义下限 $100 万（§15.3）
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
  max: 0.08,        // 溢价硬上限 8%（任何年代、任何市况）
};

/** OTC 常态点差 `base(t)` —— 几何插值，两端锚定（同 §15.2 日流动性的写法） */
export function otcBaseAt(t) {
  const a = OTC.base;
  if (t <= a[0].t) return a[0].v;
  for (let k = 1; k < a.length; k++) {
    if (t < a[k].t) {
      const f = (t - a[k - 1].t) / (a[k].t - a[k - 1].t);
      return a[k - 1].v * Math.pow(a[k].v / a[k - 1].v, f);   // 几何插值
    }
  }
  return a[a.length - 1].v;
}

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
 * @returns {number} `base(t)` ~ `OTC.max`
 */
export function otcPremiumOf(sigma, t) {
  const base = otcBaseAt(t);
  const s = Number.isFinite(sigma) && sigma > 0 ? sigma : otcSigmaRefAt(t);
  const mult = Math.min(OTC.multCap, Math.max(1, Math.pow(s / otcSigmaRefAt(t), OTC.p)));
  return Math.min(OTC.max, Math.max(base, base * mult));
}
