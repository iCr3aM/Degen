/**
 * 真实实体注册表（2026-10-11 · 新闻真实化）
 * ===============================================================
 * 新闻里那些**抽象机构名**（某头部交易所 / 一家做市商 / 某国央行 / 某上市公司…）统一收口到这里，
 * 换成**可核验的真实机构名 ＋ 首次可用时间**。两条新闻管道共用：
 *   · 架空快讯 `src/core/ficnews.js`（`%X/%T/%Z…` 占位符）
 *   · 上帝消息 `src/core/god.js` 的 `GOD_NEWS`（同占位符）
 * 解析在**引擎发射层**（`engine.fillNewsEnts`）按 `timeOf(s)` 做时间门控 —— 模板只写「这类实体」，
 * 具体是谁由「此刻这个 kind 的可用池」抽签决定。
 *
 * ── 三条硬约束 ────────────────────────────────────────────────
 *  ① **纯数据 ＋ 无状态**：时间用 `Date.UTC` 毫秒（与 `godNewsTplsOf` 的 `from` 同源），
 *     抽签是坐标式（`randFast(seed, hash(kind), i, tick, …)`）⇒ 同档同小时同 salt **逐位一致**。
 *  ② **搭配正确靠「kind 即能力」保证**：占位符按**能力域**划分（交易所只进交易所槽、科技公司
 *     只在 `corp`/`pay`/`inst` 槽），所以「苹果公司上线永续合约」在**结构上不可能**出现。
 *     新增实体时必须先想清楚它属于哪个 kind、以及该 kind 的动作词对它是否都成立。
 *  ③ **匿名者不进表**：巨鲸地址 / 休眠钱包 / 匿名知情人现实里本就匿名，也无法跨条同一化 ⇒
 *     它们留在 `ficnews` 的匿名词表里，不进本表、不进「立场账本」。
 *
 * ⚠️ `from` = **首次可用时间**（该机构在加密语境里真实存在的起点），`to` = **退场时间**（可选）——
 *    已破产 / 被查 / 更名的（Mt.Gox 2014-02、BTC-e 2017-07、OKCoin→OKX 2017、FTX 2022-11、
 *    Alameda 2022-11）给了 `to`，退场后不再出现在新闻里。
 * ⚠️ 本表**只增不改语义**：改 `from`/`to` 等于改历史口径，请连同审计 §12h 一起过。
 */

/* ══════════════ 数据结构 ══════════════ */

import { randFast, hashStr } from './rng.js';

/** 年-月 → `Date.UTC` 毫秒（月从 1 起，与中文习惯一致） */
const YM = (y, m) => Date.UTC(y, m - 1, 1);

/**
 * kind → 占位符字母。字母均在 `engine.fillNews` 的正则白名单内，且与既有占位符
 * （`S L C M H A R V D c m d`）不冲突。
 * ⚠️ 大小写敏感（`%C` ≠ `%c`）：本表一律大写。
 */
export const KIND_PH = {
  exch: '%X',    // 交易所（产品 / 运营 / 费率）
  mm: '%F',      // 做市商（报价 / 流动性）
  etf: '%T',     // 现货 ETF 发行方（申请 / 获批 / 上市）
  inst: '%I',    // 机构 / 资管 / 主权基金（披露持仓 / 配置）
  corp: '%O',    // 上市公司（纳入资产负债表 / 买入）
  pay: '%P',     // 支付 / 券商（支持交易 / 结算）
  gov: '%G',     // 国家 / 地区（法定采用 / 国家储备）
  reg: '%Z',     // 监管机构（政策 / 执法）
  miner: '%N',   // 矿业（算力 / 持仓）
  stable: '%B',  // 稳定币发行方（发行 / 销毁 / 冻结 / 储备证明）
  infra: '%K',   // 基础设施服务（托管 / 链上数据 / 钱包 / 节点）
};

/** 占位符 → kind（`resolveEnts` / 新闻管道按占位符反查 kind 用） */
export const PH_KIND = Object.fromEntries(Object.entries(KIND_PH).map(([k, p]) => [p, k]));

/**
 * 实体表。`kind` = 能力域；`from` / `to` = 首可用 / 退场（`to` 缺省 = 仍活跃）。
 * 每条都是**可核验**的真实机构（来源见提交说明 / 计划文档）。
 */
export const ENTITIES = [
  /* ── 交易所（19；含退场：Mt.Gox / BTC-e / OKCoin 更名 / FTX）── */
  { kind: 'exch', name: 'Mt.Gox', from: YM(2010, 7), to: YM(2014, 3) },
  { kind: 'exch', name: 'Bitstamp', from: YM(2011, 8) },
  { kind: 'exch', name: 'Kraken', from: YM(2011, 7) },
  { kind: 'exch', name: 'BTC-e', from: YM(2011, 7), to: YM(2017, 8) },
  { kind: 'exch', name: 'Bitfinex', from: YM(2012, 1) },
  { kind: 'exch', name: 'Coinbase', from: YM(2012, 6) },
  { kind: 'exch', name: 'CEX.IO', from: YM(2013, 1) },
  { kind: 'exch', name: 'OKCoin', from: YM(2013, 1), to: YM(2017, 1) },
  { kind: 'exch', name: '火币', from: YM(2013, 1) },
  { kind: 'exch', name: 'BitMEX', from: YM(2014, 1) },
  { kind: 'exch', name: 'Bittrex', from: YM(2014, 1) },
  { kind: 'exch', name: 'Poloniex', from: YM(2014, 1) },
  { kind: 'exch', name: 'Gemini', from: YM(2015, 10) },
  { kind: 'exch', name: 'Deribit', from: YM(2016, 1) },
  { kind: 'exch', name: 'OKX', from: YM(2017, 1) },
  { kind: 'exch', name: 'Binance', from: YM(2017, 7) },
  { kind: 'exch', name: 'KuCoin', from: YM(2017, 9) },
  { kind: 'exch', name: 'Bybit', from: YM(2018, 3) },
  { kind: 'exch', name: 'Bitget', from: YM(2018, 7) },
  { kind: 'exch', name: 'FTX', from: YM(2019, 5), to: YM(2022, 12) },

  /* ── 做市商（11；Alameda 随 FTX 退场）── */
  { kind: 'mm', name: 'GSR', from: YM(2013, 1) },
  { kind: 'mm', name: 'Cumberland', from: YM(2014, 1) },
  { kind: 'mm', name: 'B2C2', from: YM(2015, 1) },
  { kind: 'mm', name: 'Amber Group', from: YM(2017, 1) },
  { kind: 'mm', name: 'Wintermute', from: YM(2017, 1) },
  { kind: 'mm', name: 'Alameda Research', from: YM(2017, 1), to: YM(2022, 12) },
  { kind: 'mm', name: 'QCP Capital', from: YM(2017, 1) },
  { kind: 'mm', name: 'Keyrock', from: YM(2017, 1) },
  { kind: 'mm', name: 'Galaxy Digital', from: YM(2018, 1) },
  { kind: 'mm', name: 'Auros', from: YM(2019, 1) },
  { kind: 'mm', name: 'Jump Crypto', from: YM(2021, 1) },

  /* ── 现货 ETF 发行方（7；Vanguard 明确拒绝、**不入池**，只在专句里以「拒绝」出现）── */
  { kind: 'etf', name: 'Grayscale', from: YM(2013, 9) },
  { kind: 'etf', name: 'VanEck', from: YM(2017, 1) },
  { kind: 'etf', name: 'ProShares', from: YM(2021, 10) },
  { kind: 'etf', name: 'BlackRock', from: YM(2023, 6) },
  { kind: 'etf', name: 'Fidelity', from: YM(2024, 1) },
  { kind: 'etf', name: 'ARK Invest', from: YM(2024, 1) },
  { kind: 'etf', name: 'Bitwise', from: YM(2024, 1) },

  /* ── 机构 / 资管 / 主权基金（12）——动作域 = 披露持仓 / 配置 / 调仓 ── */
  { kind: 'inst', name: 'Grayscale', from: YM(2013, 9) },
  { kind: 'inst', name: 'Galaxy Digital', from: YM(2018, 1) },
  { kind: 'inst', name: '新加坡淡马锡', from: YM(2021, 1) },
  { kind: 'inst', name: '摩根大通', from: YM(2021, 1) },
  { kind: 'inst', name: '高盛', from: YM(2021, 3) },
  { kind: 'inst', name: '摩根士丹利', from: YM(2021, 3) },
  { kind: 'inst', name: '桥水基金', from: YM(2021, 5) },
  { kind: 'inst', name: 'BlackRock', from: YM(2023, 6) },
  { kind: 'inst', name: 'Fidelity', from: YM(2024, 1) },
  { kind: 'inst', name: '挪威主权基金', from: YM(2024, 1) },
  { kind: 'inst', name: '阿布扎比 Mubadala', from: YM(2024, 1) },
  { kind: 'inst', name: 'ARK Invest', from: YM(2024, 1) },

  /* ── 上市公司（8）——动作域 = 纳入资产负债表 / 买入 ── */
  { kind: 'corp', name: 'MicroStrategy', from: YM(2020, 8) },
  { kind: 'corp', name: 'Block', from: YM(2020, 10) },
  { kind: 'corp', name: 'Tesla', from: YM(2021, 2) },
  { kind: 'corp', name: '美图', from: YM(2021, 3) },
  { kind: 'corp', name: 'Nexon', from: YM(2021, 4) },
  { kind: 'corp', name: '博雅互动', from: YM(2023, 11) },
  { kind: 'corp', name: 'Metaplanet', from: YM(2024, 4) },
  { kind: 'corp', name: 'Semler Scientific', from: YM(2024, 5) },

  /* ── 支付 / 券商（7）——动作域 = 支持交易 / 结算 ── */
  { kind: 'pay', name: 'Cash App', from: YM(2018, 1) },
  { kind: 'pay', name: 'Robinhood', from: YM(2018, 1) },
  { kind: 'pay', name: 'PayPal', from: YM(2020, 10) },
  { kind: 'pay', name: 'Interactive Brokers', from: YM(2021, 1) },
  { kind: 'pay', name: 'Mastercard', from: YM(2021, 2) },
  { kind: 'pay', name: 'Visa', from: YM(2021, 3) },
  { kind: 'pay', name: 'Stripe', from: YM(2022, 4) },

  /* ── 国家 / 地区（6）——动作域 = 法定采用 / 国家储备 ── */
  { kind: 'gov', name: '瑞士楚格州', from: YM(2016, 1) },
  { kind: 'gov', name: '马耳他', from: YM(2018, 7) },
  { kind: 'gov', name: '不丹', from: YM(2019, 1) },
  { kind: 'gov', name: '萨尔瓦多', from: YM(2021, 9) },
  { kind: 'gov', name: '乌克兰', from: YM(2021, 9) },
  { kind: 'gov', name: '中非共和国', from: YM(2022, 4) },

  /* ── 监管机构（13）── */
  { kind: 'reg', name: '美国 SEC', from: YM(2013, 1) },
  { kind: 'reg', name: 'FinCEN', from: YM(2013, 1) },
  { kind: 'reg', name: '中国央行', from: YM(2013, 12) },
  { kind: 'reg', name: '美国 CFTC', from: YM(2015, 1) },
  { kind: 'reg', name: '日本 FSA', from: YM(2017, 4) },
  { kind: 'reg', name: '美国财政部 OFAC', from: YM(2018, 1) },
  { kind: 'reg', name: '新加坡 MAS', from: YM(2020, 1) },
  { kind: 'reg', name: '英国 FCA', from: YM(2020, 1) },
  { kind: 'reg', name: '尼日利亚央行', from: YM(2021, 2) },
  { kind: 'reg', name: '韩国 FSC', from: YM(2021, 3) },
  { kind: 'reg', name: '土耳其央行', from: YM(2021, 4) },
  { kind: 'reg', name: '欧盟 MiCA', from: YM(2023, 6) },
  { kind: 'reg', name: '香港证监会', from: YM(2023, 6) },

  /* ── 矿业（8）── */
  { kind: 'miner', name: '比特大陆', from: YM(2013, 1) },
  { kind: 'miner', name: '嘉楠科技', from: YM(2013, 1) },
  { kind: 'miner', name: 'Marathon', from: YM(2017, 1) },
  { kind: 'miner', name: 'Riot', from: YM(2017, 1) },
  { kind: 'miner', name: 'Hut 8', from: YM(2017, 1) },
  { kind: 'miner', name: 'Bitfarms', from: YM(2017, 1) },
  { kind: 'miner', name: 'Core Scientific', from: YM(2017, 1) },
  { kind: 'miner', name: 'Foundry USA', from: YM(2019, 1) },

  /* ── 稳定币发行方（4）——动作域 = 发行 / 销毁 / 冻结 / 储备证明 ──
     ⚠️ 与 `infra` 分家：`BitPay` / `Chainalysis` 这类**支付与数据分析**公司不会「铸造稳定币」，
        分家后「Chainalysis 发行稳定币」结构上不可能出现。 */
  { kind: 'stable', name: 'Tether', from: YM(2014, 10) },
  { kind: 'stable', name: 'Paxos', from: YM(2018, 1) },
  { kind: 'stable', name: 'Circle', from: YM(2018, 9) },
  { kind: 'stable', name: 'Binance USD', from: YM(2019, 9), to: YM(2023, 3) },

  /* ── 基础设施服务（6）：支付 / 托管 / 链上数据 ── */
  { kind: 'infra', name: 'BitPay', from: YM(2013, 1) },
  { kind: 'infra', name: 'Chainalysis', from: YM(2014, 1) },
  { kind: 'infra', name: 'Blockstream', from: YM(2014, 1) },
  { kind: 'infra', name: 'ConsenSys', from: YM(2014, 10) },
  { kind: 'infra', name: 'Coinbase Custody', from: YM(2018, 1) },
  { kind: 'infra', name: 'Fireblocks', from: YM(2018, 1) },
  { kind: 'infra', name: 'Glassnode', from: YM(2018, 1) },
];

/** 预分组：kind → 全部成员（保持表内顺序，便于抽样） */
const BY_KIND = {};
for (const e of ENTITIES) (BY_KIND[e.kind] || (BY_KIND[e.kind] = [])).push(e);

/** 某 kind 的成员总数（与时间无关；`FICNEWS_COMBOS` 估算组合空间用） */
export const countOf = kind => (BY_KIND[kind] || []).length;

/* ══════════════════ 架空自由池（2026-10-11 · 用户拍板） ══════════════════

   用户口径：「公司、国家、实体也不需要和现实的一样 —— 我们是架空世界（可以出现苹果公司、
   英伟达公司等等）」。⇒ **架空局**（`s.world === 'fic'`，见 `save.worldOf`）不走上面那张
   真实注册表的**时间门**，改用**自由池**：实体不设现实身份与首现日期（架空世界本就没有这条
   时间线）；但**槽仍要对**（见下「按槽分档」）—— 与史实世界的分界只在「谁/何时」，不在
   「哪类实体做哪类事」。

   ⚠️ 自由池**按槽分档**（2026-10-11 用户拍板「改为按槽分档」）：某个 kind 槽可用名字 =
      该 kind 的**全部真实实体名**（忽略 `from`/`to`）∪ 该槽名下的 `FIC_EXTRA`。
      所以架空局里既有 Coinbase / 美国 SEC 这样的真实名，也有苹果 / 英伟达这样的巨头名，
      **还有国家 / 地区与央行 / 国际组织** —— 且 2013 年就能出现（架空世界本就没有这条时间线）。
   ⚠️ **放宽的是「谁」，不是「哪类实体做哪类事」**：产品／概念仍按现实日期门控（永续合约
      2016-05-13、现货 ETF 2024-01-11…见 `ficnews.FAMS` 的 `objs`）；槽也仍然对
      （公司不进国家槽、国家不进交易所槽）—— 所以「麦当劳 撤回加密法案」「日本 上线永续合约」
      都不会出现，「苹果公司 纳入资产负债表」照旧可以。
   ⚠️ 不写进上面的 `ENTITIES`：那张表是**史实口径的唯一真相源**，自由池是**派生**出来的。
   ⚠️ **本表只放"名字"**：不要放与 `ENTITIES` 同义/近形的别名（曾在草稿里出现 `摩根大通公司`
      ／`摩根士丹利国际`／`贝莱德集团`，与表内 `摩根大通`／`摩根士丹利`／`BlackRock` 撞义甚至
      互为子串 —— 已删）。
   ⚠️ 中英文名字**允许互为子串**（`日本` ⊂ `日本 FSA`、`韩国` ⊂ `韩国银行`、`挪威` ⊂
      `挪威主权基金`…）—— 这在**抽签**上无害（各自是独立实体），只在 `literalEnts` 的字面
      扫描里会同时命中长短两个；那里用**最长命中抑制**抹掉短名（见 `literalEnts`）。 */
/* 分组 —— 每组的归属槽（kind）见下面的 `FIC_KIND_OF`。
   ⚠️ 名字可以跨组、跨槽复用（如 `蚂蚁集团` 既像上市公司又像支付机构）——
      具体进哪些槽由 `FIC_KIND_OF` 决定，**不是**"名字写在哪一组就只能进哪个槽"。 */
const FIC_TECHS = [
  '苹果公司', '英伟达', '谷歌', '微软', 'Meta', '亚马逊', '三星', '索尼', '台积电',
  '英特尔', '高通', '甲骨文', '字节跳动', '腾讯', '阿里巴巴', '小米', '华为', '京东',
  '美团', '百度', '网易',
];
const FIC_BRANDS = [
  '沃尔玛', '星巴克', '耐克', '迪士尼', '可口可乐', '麦当劳', '丰田汽车', '大众汽车', '波音',
  '壳牌', '辉瑞', '强生',
];
const FIC_FINS = ['蚂蚁集团', '软银', '红杉资本', '伯克希尔'];
/* 国家 / 地区（用户 2026-10-11：「不止公司名，国家名称也可以有」）——
   ⚠️ 这些是**池内名字**，不代表"现实中该国承认/储备 BTC"；架空局里可搭国家槽的动作。
      史实局一概不用（那边只有 `ENTITIES` 的 6 个 gov ＋ 时间门控）。 */
const FIC_COUNTRIES = [
  '美国', '中国', '日本', '德国', '法国', '英国', '韩国', '印度', '俄罗斯', '巴西',
  '加拿大', '澳大利亚', '新加坡', '瑞士', '阿联酋', '沙特阿拉伯', '意大利', '西班牙',
  '荷兰', '瑞典', '挪威', '波兰', '墨西哥', '阿根廷', '印尼', '越南', '泰国', '菲律宾',
  '马来西亚', '土耳其', '南非', '埃及', '以色列', '爱尔兰', '葡萄牙', '希腊', '奥地利',
  '比利时', '丹麦', '芬兰', '新西兰', '智利',
];
const FIC_CBANKS = ['美联储', '欧洲央行', '日本央行', '英国央行', '印度央行', '韩国银行'];
const FIC_ORGS = ['国际货币基金组织', '世界银行', '国际清算银行'];

/** 自由池**全体名字**（并集、保序）—— 供审计 / 字面扫描 / 展示用；**不是**某个槽的池 */
export const FIC_EXTRA = [
  ...FIC_TECHS, ...FIC_BRANDS, ...FIC_FINS, ...FIC_COUNTRIES, ...FIC_CBANKS, ...FIC_ORGS,
];

/**
 * **各组能进哪些槽**（2026-10-11 用户拍板「改为按槽分档」）——
 * 名字不限现实，但**槽要对**：公司只进公司类槽（`%O/%P/%I/%K`）、国家只进国家槽（`%G`）、
 * 央行 / 国际组织只进监管类槽（`%Z`，国际组织另可进 `%I`）。
 * ⇒ 架空局里「麦当劳 撤回加密法案」「日本 上线永续合约」都**不会**再出现；
 *    而「苹果公司 将 BTC 纳入资产负债表」「日本 宣布国家储备」照旧可以。
 * ⚠️ 这就是史实局的「kind 即能力」在架空局的**放宽版**：放宽的是「谁」（不设时间门、
 *    不设现实身份），**没有**放宽「哪类实体能做哪类事」。
 */
const FIC_KIND_OF = [
  [FIC_TECHS,     ['corp', 'pay', 'inst', 'infra']],   // 科技巨头：上市公司 / 支付券商 / 机构资管 / 基建服务
  [FIC_BRANDS,    ['corp', 'pay']],                    // 传统巨头 / 消费品牌：上市公司 / 支付券商
  [FIC_FINS,      ['corp', 'pay', 'inst', 'etf']],     // 金融 / 控股：再加 ETF 发行方
  [FIC_COUNTRIES, ['gov']],                            // 国家 / 地区：只进国家槽
  [FIC_CBANKS,    ['reg']],                            // 央行：只进监管槽
  [FIC_ORGS,      ['reg', 'inst']],                    // 国际组织：监管槽 ＋ 机构槽
];

/**
 * **按槽分档的自由池**：kind → 该槽可用的全部名字 =
 *   该 kind 的**真实实体名**（忽略 `from`/`to`，架空局没有这条时间线）∪ 该槽名下的 `FIC_EXTRA`。
 * ⚠️ 抽签按坐标做（`randFast(seed, hash(kind), i, …)`）⇒ 池的**顺序与长度**变了，同一个
 *    `(seed, i, salt)` 抽到的名字也会变 —— 但架空快讯本就是 `(ficSeed, i)` 现算、不进存档，
 *    所以这只影响「读档重算与存档期是否一致」的**外观**，不影响任何状态。改本表请连同
 *    `sim-audit` §12h 的架空自由池断言一起过。
 */
const FIC_KIND_POOL = (() => {
  const m = {};
  for (const e of ENTITIES) {                       // ① 真实实体：忽略时间门，按 kind 归位
    const arr = m[e.kind] || (m[e.kind] = []);
    if (!arr.includes(e.name)) arr.push(e.name);
  }
  for (const [names, kinds] of FIC_KIND_OF) {       // ② 追加各组名字到它名下的槽
    for (const k of kinds) {
      const arr = m[k] || (m[k] = []);
      for (const n of names) if (!arr.includes(n)) arr.push(n);
    }
  }
  return m;
})();

/** 架空局某槽此刻可用的实体名（忽略 `from`/`to`，**仍按槽分档**；`time` 仅为对齐签名） */
export function ficPoolOf(kind, _time) { return FIC_KIND_POOL[kind] || []; }

/** 自由池**全体名字**（并集、去重）—— 供审计 / 字面扫描 / 展示用 */
const FIC_POOL = (() => {
  const seen = new Set(), out = [];
  for (const a of Object.values(FIC_KIND_POOL)) for (const n of a) if (!seen.has(n)) { seen.add(n); out.push(n); }
  return out;
})();
export function ficPool(_time) { return FIC_POOL; }

/** 某槽的自由池规模（`FICNEWS_COMBOS` 估算组合空间用） */
export const ficCountOf = kind => ficPoolOf(kind).length;

/**
 * **宏观关键词**（2026-10-11）—— 不是机构，但同样会「打架」的新闻主体，立场账本把它们
 * 当**一等实体键**看待。现在只有一枚：「现货 ETF」—— 真实月报说「净流入」、消息说
 * 「单日净流出」就是自相矛盾，而这两条都没有机构占位符（主体是 ETF 这个整体）。
 */
export const MACRO_KEYS = ['现货 ETF'];

/** 模板里出现的占位符（去重、保序） */
export function phsIn(tpl) {
  const out = [];
  for (const m of String(tpl).matchAll(/%[A-Z]/g)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}

/** 模板里出现的 kind（去重、保序）——只有本表认识的占位符才算 */
export function kindsIn(tpl) {
  return phsIn(tpl).map(p => PH_KIND[p]).filter(Boolean);
}

/**
 * 某 kind 在 `time` 时刻**可用**的实体名数组（`from ≤ time < to`；无 `to` = 恒可用）。
 * @param {string} kind
 * @param {number} time `Date.UTC` 毫秒
 * @returns {string[]}
 */
export function entitiesOf(kind, time) {
  const arr = BY_KIND[kind] || [];
  const out = [];
  for (const e of arr) if (time >= e.from && (e.to == null || time < e.to)) out.push(e.name);
  return out;
}

/**
 * 模板在 `time` 时刻**能不能用**：它占用的每个 kind 都必须有非空可用池。
 * 空池（例如 2013 年早期的 `etf`）⇒ 该模板从候选池剔除，不会出现「解析不出实体」的半截句。
 * @param {{free?:boolean}} [o] `free:true`（架空局）⇒ 改判自由池（忽略时间门，仍按槽分档）。
 */
export function tplUsable(tpl, time, o = {}) {
  for (const k of kindsIn(tpl)) {
    if (!(o.free ? ficPoolOf(k, time) : entitiesOf(k, time)).length) return false;
  }
  return true;
}

/* ══════════════ 确定性解析 ══════════════ */

/**
 * 把模板里的实体占位符解析成**真实名称**（按 `time` 门控、按坐标抽签）。
 * ⚠️ 只解析模板里**实际出现**的占位符 —— 未出现的 kind 不取数，避免污染随机流。
 * ⚠️ `salt` 供「立场账本」冲突时重抽（见 `engine`）：同 salt 逐位一致、换 salt 换一个实体。
 * @param {string} tpl
 * @param {number} time `Date.UTC` 毫秒
 * @param {number} seed 随机种子（架空局传 `s.ficSeed`、上帝局传 `s.seed`）
 * @param {number} i 绝对小时序号
 * @param {number} [salt] 重抽盐（默认 0）
 * @param {{free?:boolean}} [o] `free:true`（架空局）⇒ 任意 kind 占位符都从**自由池**抽
 * @returns {Record<string,string>} 占位符 → 名称（池空时该占位符不产出 ⇒ `fillNews` 会原样保留，
 *   但调用方须先用 `tplUsable` 挡掉空池模板）
 */
export function resolveEnts(tpl, time, seed, i, salt = 0, o = {}) {
  const out = {};
  let k = 0;
  for (const ph of phsIn(tpl)) {
    const kind = PH_KIND[ph];
    if (!kind) continue;                        // 非实体占位符（%S/%L…）跳过
    const pool = o.free ? ficPoolOf(kind, time) : entitiesOf(kind, time);
    if (!pool.length) continue;
    const r = randFast(
      seed >>> 0, hashStr(kind), i | 0,
      Math.imul(salt | 0, 0x9e37) + (++k),      // 同 salt 固定；换 salt 换轨道
      hashStr('newsent'),
    );
    out[ph] = pool[Math.floor(r * pool.length) % pool.length];
  }
  return out;
}

/* ══════════════ 立场账本（防「打架」） ══════════════
   用户口径（2026-10-11 拍板）：记录每个实体**最近一次被提及的方向**；两条叙事型管道
   （架空快讯 / 上帝消息）发射前互查 —— 同一实体在窗口内**不得反向**。
   例：架空快讯说「某实体利好」，随后的消息不得说它利空（反之亦然）。
   ⚠️ 账本挂 `s.newsStance`（顶层）：上帝·架空局里两条管道**同局共存**（`save.js` 的 `godFic` 槽），
      所以必须跨管道共享、随存档持久（**不列 EPHEMERAL**）、`rewindTo` 清空。**不升 STATE_VERSION**。
   ⚠️ 匿名实体（巨鲸地址 / 休眠钱包）不进表、不进账本。
   ⚠️ 中性（`dir === 0`）不写账、不判冲突 —— 只有明确方向才会「打架」。 */

/** 冲突窗口（游戏小时）：90 日 —— 覆盖架空快讯 60 日节奏与 `AUTO_NEWS_GAP`（40~80 日） */
export const STANCE_WINDOW_H = 2160;

/**
 * 此刻若对 `name` 发 `dir` 方向的新闻，是否与账本冲突。
 * @param {object} s 状态
 * @param {string} name 实体名
 * @param {number} dir ＋1 / −1 / 0（0 = 中性 ⇒ 恒不冲突）
 * @returns {boolean}
 */
export function stanceConflict(s, name, dir) {
  if (!dir) return false;
  const e = s.newsStance && s.newsStance[name];
  if (!e || !e.dir) return false;
  return e.dir !== dir && (s.i - e.at) <= STANCE_WINDOW_H;
}

/** 记一笔方向（中性不记）。读侧懒建，兼容旧档。 */
export function putStance(s, name, dir, sym = null) {
  if (!dir) return;
  if (!s.newsStance) s.newsStance = {};
  s.newsStance[name] = { dir, at: s.i, sym };
}

/** 模板里成对出现的占位符与名称（供调用方逐名判冲突） */
export function entsOfTpl(tpl, time, seed, i, salt = 0, o = {}) {
  const map = resolveEnts(tpl, time, seed, i, salt, o);
  return Object.keys(map).map(ph => ({ ph, name: map[ph] }));
}

/** 实体名 → 该实体的 kind（判「中性 vs 有向」时可能要用；表内无此名返回 null） */
export function kindOfName(name) {
  for (const e of ENTITIES) if (e.name === name) return e.kind;
  return null;
}

/* ── 字面名扫描（2026-10-11）─────────────────────────────────────────────
   有几条消息模板把真实当事方**写死在句子里**（`Mt.Gox 暂停提现` / `FTX 交易所轰然倒塌` /
   `Coinbase 登陆公开证券市场`…），不走占位符 ⇒ `entsOfTpl` 看不见它们，立场账本也就拦不住
   「真新闻说 Coinbase 利空、消息却报它利好」。`literalEnts` 把这些字面名捞出来，
   与占位符解析结果**并集**后再判冲突。
   ⚠️ 拉丁名按**词边界**匹配（`Block` 不能命中 `Blockstream`、`Meta` 不能命中 `Metaplanet`）；
      中文名直接 `includes`（表内已核对无互为子串者）。 */

/** 拉丁 / 数字 / 点 视作「词内字符」——用于给 ASCII 实体名卡边界 */
const WORDY = /[A-Za-z0-9.]/;

/** `tpl` 是否字面含有实体名 `n`（ASCII 名卡词边界；中文名直接包含） */
function hasName(tpl, n) {
  const ascii = /^[\x00-\x7F]+$/.test(n);
  let pos = tpl.indexOf(n);
  while (pos >= 0) {
    if (!ascii) return true;
    const before = pos > 0 ? tpl[pos - 1] : '';
    const after = tpl[pos + n.length] || '';
    if (!WORDY.test(before) && !WORDY.test(after)) return true;
    pos = tpl.indexOf(n, pos + 1);
  }
  return false;
}

/**
 * 模板正文里**字面出现**的实体名（真实注册表 ∪ 自由池 ∪ 宏观关键词）。去重、保序。
 * ⚠️ 只用于「立场账本」比对，不参与正文填充 —— 这些名字本来就已经写在句子里了。
 * ⚠️ **最长命中抑制**：中文没有词边界，`日本` 与 `日本 FSA` 会同时命中 ⇒ 只留长的那一个
 *    （`日本` 是 `日本 FSA` 的子串 ⇒ 抹掉）。否则一句「日本 FSA 出台…」会同时给 `日本`
 *    记一笔账，日后拦掉无关的消息。拉丁名已由 `hasName` 的词边界挡住（`Block` ≠ `Blockstream`）。
 */
export function literalEnts(tpl) {
  const t = String(tpl);
  const raw = [];
  for (const e of ENTITIES) if (hasName(t, e.name) && !raw.includes(e.name)) raw.push(e.name);
  for (const n of FIC_EXTRA) if (hasName(t, n) && !raw.includes(n)) raw.push(n);
  for (const k of MACRO_KEYS) if (t.includes(k) && !raw.includes(k)) raw.push(k);
  return raw.filter(n => !raw.some(m => m !== n && m.includes(n)));
}
