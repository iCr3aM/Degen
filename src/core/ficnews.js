/**
 * 架空世界新闻生成器（2026-10-10 · 架空模式 P3 · 组合式词库）
 * ===============================================================
 * 用户原话：「架空世界新闻**越丰富越好**，这样才有随机感，而且确保每一局都不太一样」。
 *
 * ── 口径（三条硬约束）────────────────────────────────────────────
 *   ① **纯函数**：`(ficSeed, i)` 决定一切 —— 与行情生成器同源，读档重算逐位一致，
 *      不写进存档、不需要「已播过」状态位。
 *   ② **不注入涨跌幅**（项目红线）：模板只允许 `%S`（币符号）`%L`（现价）`%A`（当日成交额）
 *      `%R`（资金费率）`%H`（市场热度）这些**事实性**占位符，**永不含** `%C`/`%c`（涨跌幅）
 *      或任何方向断言。
 *      ⚠️ 2026-10-10 用户拍板「**架空新闻可以有相关数值展示**、假消息只做叙事」——
 *      数值展示**收敛到本模块**（约 70% 的快讯带一段读数）；上帝假消息（`god.MANIP_NEWS`）
 *      已拆掉全部数值占位符，两边就此分工明确、不再重叠。
 *   ③ 词库是**组合式**的：`句子族 × 主体 × 动作 × 对象 × 收尾 × 数值尾`，组合空间上万 ⇒
 *      每一局的快讯序列都不同、局内也极少重样。
 *
 * ⚠️ 与史实新闻的区别：史实新闻是「提前 7 天知情」的锚点（`anchors.js`），架空新闻只是**快讯流**
 *    ＋ 大事件播报，**不做 7 天预警遮罩**（spec §5.2）—— 架空保持流畅。
 * ⚠️ 改词库不影响存档：快讯由 `(seed, i)` 现算；但若将来改到与行情一致性相关的内容，
 *    请一并评估是否要升 `ficgen.FIC_VER`。
 */

import { COINS, GAME, HOUR_MS } from './config.js';

/* ── 确定性 RNG（与 ficgen 同一族的哈希，坐标决定取值、与访问顺序无关）── */
function h32(x) {
  x = x | 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}
function rnd(seed, a, b, c) {
  let x = h32(Math.imul(seed | 0, 0x9e3779b1) ^ (a | 0));
  x = h32(x ^ Math.imul(b | 0, 0x85ebca77));
  x = h32(x ^ Math.imul(c | 0, 0xc2b2ae3d));
  return x / 4294967296;
}
const pick = (arr, seed, i, stream) => arr[Math.floor(rnd(seed, 0x91, i, stream) * arr.length) % arr.length];

/* ── 词库（三个句子族，列多但都是「一块砖」，拼出的句子读得通）──────────────── */

/** 族 1：交易所 / 机构的**产品与运营**动作 */
const ORG = ['某头部交易所', '一家离岸交易所', '某衍生品平台', '一家做市商', '某大型资管', '一家主权基金',
  '某矿业集团', '一家托管机构', '某支付公司', '一家量化基金', '某公链基金会', '某自营交易台'];
const ACT_EX = ['上线', '下架', '暂停提币', '恢复提币', '新增', '调整', '关闭', '重启', '扩容', '拆分'];
const MKT = ['现货交易', '永续合约', '期权市场', '杠杆额度', '跨链桥服务', '主网节点', '流动性池',
  '稳定币储备', '托管服务', '链上清算', '预言机喂价', '质押协议'];

/** 族 2：巨鲸 / 大户的**持仓与转账**动作 */
const WHALE = ['一个巨鲸地址', '某早期矿工', '一家链上基金', '一个休眠钱包', '某做市账户', '一个机构金库'];
const ACT_WH = ['增持', '减持', '转入', '转出', '质押', '解锁', '清仓', '补齐'];
const ASSET = ['现货仓位', '多头头寸', '稳定币储备', '山寨币仓位', '链上抵押品', '协议治理代币'];

/** 族 3：监管 / 政策的**制度面**动向 */
const REG = ['某国央行', '某监管机构', '某国财政部', '某证券监管局', '某国议会', '某地区立法机构'];
const ACT_REG = ['出台', '收紧', '放松', '调查', '叫停', '推进', '通过', '否决', '拟议', '征询'];
const POLICY = ['加密监管指引', '交易所牌照制度', '稳定币储备规则', '税收框架', '反洗钱要求',
  '现货 ETF 审批', '挖矿用电政策', '跨境资金申报'];

/** 收尾句（情绪 / 观察，**不含任何绝对值断言**） */
const TAIL = ['，市场情绪转为观望', '，社区反应不一', '，短期或加剧波动', '，资金面暂未明显变化',
  '，分析师看法分歧', '，链上数据出现异动', '，机构仍在观望', '，衍生品持仓上升',
  '，交易所间价差扩大', '，做市深度收窄', '，资金在离场观望', '，热度明显升温'];

/** 句子族装配器：任选一族 → 拼出 `主体＋动作＋对象＋收尾` */
function assemble(seed, i) {
  const famN = Math.floor(rnd(seed, 0x91, i, 1) * 3) % 3;
  if (famN === 0) return `${pick(ORG, seed, i, 11)}${pick(ACT_EX, seed, i, 12)}${pick(MKT, seed, i, 13)}${pick(TAIL, seed, i, 14)}`;
  if (famN === 1) return `${pick(WHALE, seed, i, 21)}${pick(ACT_WH, seed, i, 22)}${pick(ASSET, seed, i, 23)}${pick(TAIL, seed, i, 24)}`;
  return `${pick(REG, seed, i, 31)}${pick(ACT_REG, seed, i, 32)}${pick(REG_POLICY(), seed, i, 33)}${pick(TAIL, seed, i, 34)}`;
}
/* 政策表写成函数只是为了让「长表」与其它族同形（无副作用）。 */
const REG_POLICY = () => POLICY;

/** 快讯节奏（2026-10-11 二次收敛 · 用户拍板「参考**普通模式**的新闻频率」）——
 *
 *  基准怎么来的（实测，非估算）：跑满史实全程 105192 根，用引擎的 `pushLog` 去重口径
 *  （同一句连续重复只留一条）数**玩家实际看到**的新闻条数 ⇒ **74 条 / 12.01 年 ≈ 6.2 条/年**，
 *  换算 50x（`acc += dt × speed` ⇒ 1 真实秒 = 50 游戏小时）= **每 28.4 真实秒一条**。
 *  ⚠️ 上一版 `1/200`（每 200 游戏小时一条 ≈ 37 条/年）比普通模式**密约 6 倍** —— 用户报
 *     「仍需再次收敛」正是这条：架空世界没有史实锚点 / 巨鲸 / ETF，快讯就是它全部的新闻流，
 *     密度应当**对齐普通模式**，而不是自成一套更密的节奏。
 *  现口径 = 每 **60 游戏日**（1440h）一条 ⇒ 6.08 条/年、50x 下 ≈ **每 28.8 真实秒一条**
 *  （与普通模式的 28.4 秒一致）；1x 下 ≈ 24 分钟一条。
 *  ⚠️ 20 年全程 ≈ 122 条 —— 与普通模式全 12 年 74 条同一量级（架空多 8 年，同比约 122）。 */
const CADENCE_HOURS = 1440;
const CADENCE = 1 / CADENCE_HOURS;

/**
 * 第 `i` 根小时的**架空快讯**（没有就是 `null`）。
 *
 * @param {number} seed 世界线种子（`s.ficSeed`）
 * @param {number} i 绝对小时序号
 * @returns {{sym:string, tpl:string}|null} `tpl` 是**未填充**的模板（`%S/%L/%A/%R`），
 *   由引擎的 `fillNews(newsVars(...))` 在播报那一刻填进真值。
 */
export function ficNewsAt(seed, i) {
  const sd = (seed >>> 0) || 1;
  if (rnd(sd, 0x91, i, 0) >= CADENCE) return null;

  /* 只从**此刻已上线**的币里抽（BTC 的 unlock 早于开局 ⇒ 恒在列） */
  const t = GAME.start + i * HOUR_MS;
  let listed = COINS.filter(c => c.unlock <= t);
  if (!listed.length) listed = [COINS[0]];
  const sym = listed[Math.floor(rnd(sd, 0x91, i, 2) * listed.length) % listed.length].sym;

  let tpl = `【%S 快讯】${assemble(sd, i)}`;
  /* **数值展示**（2026-10-10 用户拍板「架空新闻可以有相关数值展示」）—— 约 70% 的快讯带一段
     事实性读数：现价 / 当日成交额 / 资金费率 / 市场热度。这些值由引擎在**播报那一刻**填真值
     （`fillNews` + `newsVars`），不是编的；**仍不含涨跌幅**（`%C/%c` 一律不用 —— 项目红线）。 */
  const roll = rnd(sd, 0x91, i, 3);
  if (roll < 0.28) tpl += `，现价 %L`;
  else if (roll < 0.45) tpl += `，当日成交额 %A`;
  else if (roll < 0.58) tpl += `，资金费率 %R`;
  else if (roll < 0.70) tpl += `，市场热度 %H`;
  return { sym, tpl };
}

/* ═══════════════ 自检 / 验收辅助（仅测试用）═══════════════ */

/** 连续取 `n` 根的快讯（`null` 跳过）—— 供 sim-audit 统计丰富度与重复率 */
export function ficNewsSample(seed, i0, n) {
  const out = [];
  for (let k = 0; k < n; k++) { const v = ficNewsAt(seed, i0 + k); if (v) out.push(v); }
  return out;
}

/** 词库规模（组合空间的下界，供验收断言） */
export const FICNEWS_COMBOS =
  ORG.length * ACT_EX.length * MKT.length * TAIL.length
  + WHALE.length * ACT_WH.length * ASSET.length * TAIL.length
  + REG.length * ACT_REG.length * POLICY.length * TAIL.length;