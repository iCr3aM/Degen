/**
 * 真实实体注册表（2026-10-11 · 新闻真实化）
 * ===============================================================
 * 新闻里那些**抽象机构名**（某头部交易所 / 一家做市商 / 某国央行 / 某上市公司…）统一收口到这里，
 * 换成**可核验的真实机构名 ＋ 首次可用时间**。两条新闻管道共用：
 *   · 架空快讯 `src/core/ficnews.js`（`%X/%T/%Z…` 占位符）
 *   · 上帝假消息 `src/core/god.js` 的 `MANIP_NEWS`（同占位符）
 * 解析在**引擎发射层**（`engine.fillNewsEnts`）按 `timeOf(s)` 做时间门控 —— 模板只写「这类实体」，
 * 具体是谁由「此刻这个 kind 的可用池」抽签决定。
 *
 * ── 三条硬约束 ────────────────────────────────────────────────
 *  ① **纯数据 ＋ 无状态**：时间用 `Date.UTC` 毫秒（与 `manipTplsOf` 的 `from` 同源），
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
 */
export function tplUsable(tpl, time) {
  for (const k of kindsIn(tpl)) if (!entitiesOf(k, time).length) return false;
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
 * @returns {Record<string,string>} 占位符 → 名称（池空时该占位符不产出 ⇒ `fillNews` 会原样保留，
 *   但调用方须先用 `tplUsable` 挡掉空池模板）
 */
export function resolveEnts(tpl, time, seed, i, salt = 0) {
  const out = {};
  let k = 0;
  for (const ph of phsIn(tpl)) {
    const kind = PH_KIND[ph];
    if (!kind) continue;                        // 非实体占位符（%S/%L…）跳过
    const pool = entitiesOf(kind, time);
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
   （架空快讯 / 上帝假消息）发射前互查 —— 同一实体在窗口内**不得反向**。
   例：架空快讯说「某实体利好」，随后的假消息不得说它利空（反之亦然）。
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
export function entsOfTpl(tpl, time, seed, i, salt = 0) {
  const map = resolveEnts(tpl, time, seed, i, salt);
  return Object.keys(map).map(ph => ({ ph, name: map[ph] }));
}

/** 实体名 → 该实体的 kind（判「中性 vs 有向」时可能要用；表内无此名返回 null） */
export function kindOfName(name) {
  for (const e of ENTITIES) if (e.name === name) return e.kind;
  return null;
}
