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
 *   - ⚠️ **模拟粒度 ≠ 渲染粒度**：主图默认仍画 1 小时聚合，只有玩家主动放大才展开细 K
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
 *   SOL 2021-01（2020-08 才上线，2021 年机构台普遍覆盖主流山寨）
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
 */
export const COINS = [
  { sym: 'BTC',  name: '比特币',  unlock: Date.UTC(2013, 0, 1, 0),  otc: Date.UTC(2013, 0, 1),  src: { bitstamp: 'btcusd', bitfinex: 'tBTCUSD', binance: 'BTCUSDT',  binanceus: null } },
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
 * 供应量上限（P2-B2 · GDD §15.1 / §15.4）—— 玩家买入后**最多能锁走多少枚**。
 *
 * ⚠️ 这里是**绝对枚数**，不是「流通量的百分之几」—— 所以实现它**不需要任何流通量序列**
 *    （2026-09-29 核对 §15.1 那段表后确认，本项目因此不发额外网络请求、不加数据产物）。
 *
 * ⚠️ **如实说明**：按真实值落地后，这个上限在整局里**够不着** ——
 *    BTC 300 万枚，2013 年按 $13 算就是 $3,900 万，而玩家开局只有 $3,000。
 *    它的作用是「一条真实的背景约束」，不是平衡旋钮：正常玩法里看不到它生效。
 *
 * 只有**多头方向**消耗它（空头并没有把币从市场里拿走），且 OTC 买入不计入
 * （§15.3：对手方私下一口价，不从市场拿走流通量）。
 */
export const SUPPLY_CAP = {
  BTC: 3e6,      // 300 万枚
  ETH: 1e7,      // 1000 万枚
  XRP: 2e10,     // 200 亿枚
  DOGE: 5e10,    // 500 亿枚
  SOL: 5e7,      // 5000 万枚
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
