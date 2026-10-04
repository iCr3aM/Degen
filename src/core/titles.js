/**
 * 称号与徽章（M3 · 2026-10-01；2026-10-04 扩为**三轴**；2026-10-05 深度扩充词表）
 * ===============================================================
 * 输入是 `core/careers.js` 的**一条档案记录**，输出「主称号 ＋ 风格称号 ＋ 徽章」：
 *
 *     titleOf(rec)   →  '币圈锦鲤'                （主称号：**结局 × 倍数**，一局一枚）
 *     styleOf(rec)   →  '不死鸟'                  （风格称号：**怎么打的**，一局一枚，永不为空）
 *     badgesOf(rec)  →  ['杠杆党', '钻石手', …]   （徽章：0–N 枚的细节标签）
 *
 * 档案页（`render.js` 的 `careerRow`）与分享图（M4 `ui/shareCard.js`）**共用这里** ⇒
 * 同一局在哪儿看都是同一套称号，不会两处各写一份判断（LESS IS MORE 的硬要求）。
 *
 * ── 词表规模（2026-10-05 用户拍板「称号越多越好」）────────────────
 * 主称号 **20 枚**（活着 13 ＋ 破产 7）／风格称号 **22 枚**／徽章 **29 枚**，合计 **71 枚**标签。
 * 扩充的依据是**同类游戏的通行做法**（联网调研 2026-10-05）：
 *   · 增量 / 经营游戏（Frosty Farms、Vending Empire、Idle Cash Clicker）用**金额里程碑阶梯**
 *     给称号（Backyard DIY Farmer → … → Legendary Uptime Land Farmer；Soda Apprentice → Vending God），
 *     所以「活着」那一轴按**倍数阶梯**加密到 13 档（2026-10-05 再补「万倍传奇 / 亿倍传奇」）；
 *   · 交易竞技 / 模拟盘（WallStreetClash）用**圈内黑话**做阶梯（Paper Hands → Bag Holder →
 *     Diamond Hands → Tendy Titan），所以沿用并加密「钻石手 / 币圈锦鲤 / 百倍战神」这一脉；
 *   · roguelite（Crownseeker、Abyssal）在收尾时按**本局表现**给**单一评级**（Legendary Relic Hunter
 *     → Wanderer），与「一局一枚主称号」同构；
 *   · A 股 / 币圈的**资金量级分级**（纳米户 → 散户 → 大户 → 游资 → 庄家；韭菜 / 巨鲸）给了
 *     「破产档按曾经冲到多高」这一思路 —— 终值没有信息量，**峰顶倍数**才是故事。
 *
 * ── 为什么有「风格称号」这一轴（2026-10-04 用户拍板）────────────────
 * 主称号**只由结局 × 倍数决定** —— 两个都结算在 1.2b 的玩家，
 * 不管一个是「爆仓 88 次硬扛到结算」、另一个是「一路 1x 稳稳拿到结算」，称号**一模一样**，
 * 看不出「怎么打的」。补一轴**纯行为**的风格称号：结局说「打成什么样」，
 * 风格说「你是哪种玩家」，徽章补细节。三轴合起来，任何一局都至少有**两枚**称号。
 *
 * ⚠️ 风格称号**主体是行为**，但**破产结局会让两枚「暗示活下来」的说法失效**
 *    （2026-10-05 用户实测修）：「不死鸟」「向死而生」说的都是「挺过来了」，
 *    而爆仓 / 归零认输的账户是清零的 ⇒ 那两种结局改说「爆仓常客」「续命无果」。
 *    这是**唯一**让结局影响风格轴的地方，判据集中在 `bustOf`（一处定义，两轴共用）。
 *
 * ⚠️ **纯函数**：不给 `s` 打点、不读 localStorage、不改 `STATE_VERSION`，重算一百遍也不变。
 * ⚠️ 判据全部落在 M1 已打点的 `s.stat` 上（`open/fut/margin/maxLev/win/loss/liq/syms/move/loan/god`）＋
 *    档案里已摊平的 `days/peak/final/realized/start/end/reason/eq` ——
 *    **绝不为了称号再往状态里塞新字段**（`maxDdOf` 走 `eq` 现算最大回撤，不加字段）。
 */

import { OVER } from './engine.js';
/* 只取 `SCENARIOS` 算「本局名义时长」—— `config.js` 是**零依赖叶子模块**，不会成环。 */
import { SCENARIOS } from './config.js';

/* ── 312 那根针的绝对时刻（2020-03-12T00:00:00Z）──
 * `rec.start` / `rec.end` 都是**绝对 ms**，可直接比；此处直接写 UTC 时刻字面量，
 * 不从 `GAME` 取 —— 这枚常量是**史实日期**，与游戏时间轴配置无关。 */
const CRASH_312 = Date.UTC(2020, 2, 12);

/** 「某个值 ÷ 本金」的同一把尺子（`multOf` / 峰顶倍数共用）—— 本金 ≤ 0 时返回 0。 */
const multAt = (v, cash0) => (cash0 > 0 ? v / cash0 : 0);

/** 倍数（`final / cash0`）—— 档案页与主称号共用同一口径 */
export const multOf = rec => multAt(rec.final, rec.cash0);

/**
 * 最大回撤（`eq` 曲线上「从历史最高点跌下来的最深幅度」）—— 0~1；**样本太稀时返回 `null`**。
 *
 * ⚠️ 不新增字段：`rec.eq` 是档案里已有的抽稀净值曲线（`careers.js` 的 `thinEq`，≤128 点）。
 * ⚠️ 少于 8 个点 ⇒ `null`（**不下判断**）：曲线点太少时任何回撤数都是噪声，
 *    宁可让「深度回撤 / 教科书曲线」这两枚徽章不出现，也不给一个假的极端值。
 * ⚠️ 峰值从 0 起步：`peak > 0` 才计入，账户清零那一段（peak 已 ≤0）不参与。
 */
export function maxDdOf(rec) {
  const eq = Array.isArray(rec.eq) ? rec.eq : null;
  if (!eq || eq.length < 8) return null;
  let peak = -Infinity, mdd = 0;
  for (const v of eq) {
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    if (peak > 0) {
      const d = (peak - v) / peak;
      if (d > mdd) mdd = d;
    }
  }
  return mdd;
}

/* ══════════════ 按本局时长归一（2026-10-05 用户拍板） ══════════════
 *
 * **为什么需要**：挑战局（年代开局）只有 **2–4 个月**（`SCENARIOS`），而称号的档位是照
 * 「经典全程 12 年」定的 —— 4 个月里根本跑不出「终值 100 倍」，于是所有挑战局**全部塌到最低档**
 * （结算一律「陪跑的」、破产一律「归零者」），六种玩法在称号上一模一样，看不出差别。
 *
 * **口径**：一套阈值，按本局**名义时长**缩放 —— 不新增局别专属词表（档案页 / 海报
 *    共用的仍是同一份 71 枚标签）。`rec.scen` 查 `SCENARIOS` 的 `end − at`。
 * ⚠️ 用**本局名义时长**而不是 `rec.days`（实际存活天数）：后者会让「开局 3 天就爆仓」的局
 *    把标尺压到最短，凭空抬高称号 —— 爆仓早晚不该改写「这一局是什么玩法」。
 * ⚠️ 查不到的年月（老档案 / 将来新增局）一律回落到基准局 ⇒ **与改动前逐位相同**。
 *
 * **标量 `k = clamp(√(本局天数 ÷ 基准局天数), 0.15, 1)`**：
 *   · 经典全程 4383 天 ⇒ k = 1 ⇒ 所有阈值**一字不动**（向后兼容的锚）；
 *   · 取**平方根**而非线性：对数收益的**离散度 ∝ √t**（随机游走），4 个月能跑出的「数量级」
 *     按 √t 缩 —— 线性缩会把 2 个月的档位全压到 1.0x 附近，反而又失去分辨力；
 *   · 下限 0.15：最短的「312 前夜」只有 71 天（√ ≈ 0.127），抬到 0.15 免得档位过于贴身。
 */
const SCEN_DAYS = new Map(SCENARIOS.map(sc => [sc.id, (sc.end - sc.at) / 86400000]));
const BENCH_DAYS = SCEN_DAYS.get(SCENARIOS[0].id);

/** 本局时长的归一标量 `k ∈ [0.15, 1]`（导出供离线审计复算）。 */
export function durKOf(rec) {
  const total = SCEN_DAYS.get(rec && rec.scen) || BENCH_DAYS;
  return Math.min(1, Math.max(0.15, Math.sqrt(total / BENCH_DAYS)));
}

/** **倍数**档的归一：在**对数轴**上按 k 缩（`thr^k`）—— 经典局 k = 1 ⇒ 原值。 */
const mThr = (thr, k) => (k >= 1 ? thr : Math.pow(thr, k));

/**
 * **次数 / 天数**档的归一：线性缩（次数随时间线性累积）—— 但保留一个**短局可辨识的地板**
 * `floor`，否则「2 个月里换所 0 次」也会因为 10 × 0.15 = 1.5 而误判成「逐利游牧」。
 */
const cThr = (thr, k, floor) => (k >= 1 ? thr : Math.max(floor, Math.round(thr * k)));

/**
 * 这一局是不是**破产收场** —— 「结局轴」的第一分叉。
 *
 * `OVER.SETTLED` 是唯一的「活着到收盘」；另两种结局（`LIQUIDATED` 被打穿 / `GAVEUP` 归零后认输）
 * 都发生在 `engine.isBankrupt` 判定为真之后 ⇒ **账户清零**。所以：
 *   · 破产档的称号**不许说任何「活下来了」的话**（「不死鸟」「向死而生」在破产局里都是假话）；
 *   · 破产档看的是**峰顶倍数**（曾经多高），而不是终值（终值必 ≤ 0，没有信息量）。
 *
 * ⚠️ 判据只认 `reason`（档案里的权威结局字段），不看 `final`：老档案 / 边界值都不会误判 ——
 *    `SETTLED` 的终值必为正（否则早被 `isBankrupt` 拦下了），两者等价但 `reason` 更直白。
 */
export const bustOf = rec => rec.reason !== OVER.SETTLED;

/**
 * 结局的显示名 —— 键就是 `engine.OVER` 的那三个值。
 * ⚠️ 档案页（`render.js` 的 `careerRow`）与生涯海报（`ui/shareCard.js`）**共用这里**：
 *    同一局在哪儿看都写同一个词（与 `titleOf` 同一条 LESS IS MORE 的理由）。
 * ⚠️ 配色**不在这里** —— 档案页要的是 CSS 类名、海报要的是 canvas 色值，
 *    同一条语义在两处的写法本来就不同，硬凑一张表反而两处都得绕。
 */
export const OVER_LABEL = {
  [OVER.LIQUIDATED]: '爆仓',
  [OVER.SETTLED]: '结算',
  [OVER.GAVEUP]: '收摊',
};

/**
 * 主称号 —— **结局 × 倍数 × 金额**。混合风格：低档写实（陪跑 / 活下来），高档用梗（钻石手 / 千倍传奇）。
 *
 * 第一分叉是**破产还是活着**（`bustOf`）：
 *   · **破产**（7 档）—— 终值必 ≤ 0，没有信息量，「曾经冲到多高」才是故事，按**峰顶倍数**分
 *     （6 档，2026-10-05 在 `登月坠落` 之上再补一档 `功亏一篑`：≥1000x 仍被打爆是**最痛的功亏一篑**）；
 *     另有一档**欠钱**（`final < 0`，穿仓 / 借贷爆掉倒欠）单独置顶，那是「连本金之外都赔进去了」。
 *   · **活着**（13 档）—— 按终值倍数分。倍数就是**金额**的同一把尺子（`cash0` 各局不同，
 *     倍数才是跨局可比的量纲；绝对值会变成「经典局天然赢 10U 局」的假差别）。
 *     末三档为**千倍传奇 / 万倍传奇 / 亿倍传奇**（2026-10-05 用户拍板补足长尾，避免 1e6 也叫「千倍」）。
 *
 * ⚠️ 破产档**不看 `reason` 分「被打穿 / 主动认输」**：两种结局的账户都是清零的，
 *    差别（爆仓 ⇄ 收摊）由 `OVER_LABEL` 在档案页 / 海报上单列。称号说的是**财务事实**。
 *
 * ⚠️ 档位阈值**按本局时长归一**（`durKOf` / `mThr`）：经典局 k = 1 ⇒ 阈值与上一版逐位相同；
 *    2–4 个月的挑战局按 `thr^k` 下移（如 k ≈ 0.16 时 100x → 2.1x、10x → 1.5x）。
 *
 * ⚠️ 字数上限 **4 字**（海报主称号是 96px 大字，超过 4 字会挤掉旁边的风格称号）—— 新增档位必须遵守。
 */
export function titleOf(rec) {
  const k = durKOf(rec);
  if (bustOf(rec)) {
    /* 欠钱置顶：`final < 0` 是**比归零更糟**的结局（借贷 / 穿仓倒欠），单独一枚。 */
    if (rec.final < 0) return '负债累累';
    const mPeak = multAt(rec.peak, rec.cash0);
    if (mPeak >= mThr(1000, k)) return '功亏一篑';
    if (mPeak >= mThr(100, k)) return '登月坠落';
    if (mPeak >= mThr(20, k)) return '黄粱一梦';
    if (mPeak >= mThr(5, k)) return '高台跳水';
    if (mPeak >= mThr(2, k)) return '纸上富贵';
    return '归零者';
  }
  const m = multOf(rec);
  if (m < 1) return '陪跑的';
  if (m < 1.5) return '活下来的';
  if (m < mThr(2, k)) return '保本的';
  if (m < mThr(3, k)) return '小赚一笔';
  if (m < mThr(5, k)) return '翻倍的人';
  if (m < mThr(10, k)) return '小富即安';
  if (m < mThr(20, k)) return '钻石手';
  if (m < mThr(50, k)) return '滚雪球';
  if (m < mThr(100, k)) return '币圈锦鲤';
  if (m < mThr(1000, k)) return '百倍战神';
  if (m < mThr(1e4, k)) return '千倍传奇';
  if (m < mThr(1e8, k)) return '万倍传奇';
  return '亿倍传奇';
}

/**
 * 风格称号 —— **纯行为**（与盈亏无关），一局一枚，**永不为空**（末档 `else` 兜底）。
 * ⚠️ **但破产结局会让两档「暗示活下来」的说法失效**（`bustOf`）：见下方表格里带 ✱ 的两行。
 *
 * 顺序＝**优先级**（`if` 链，先命中先返回）。排在前面的更「独特」：先认出少数派
 * （一单没开的看客 / 反复爆仓的 / 极限杠杆的梭哈战神 / 借钱加码的孤注一掷 / 满世界搬家的游牧…），
 * 再落到「用什么工具、打得多快、胜率如何」这些大众特征，最后是**兜底**「稳健交易员」。
 *
 * | 风格称号 | 判据 | 说的是 |
 * | --- | --- | --- |
 * | 空仓看客 | `open === 0` | 一单都没开 |
 * | 不死鸟 | `liq ≥ c10` 且**活到结算** | 反复爆仓又爬起来 |
 * | ✱ 爆仓常客 | `liq ≥ c10` 且**破产** | 反复爆仓，终究没挺到最后 |
 * | 梭哈战神 | `maxLev ≥ 100` | 动辄百倍杠杆 |
 * | 孤注一掷 | `maxLev ≥ 20` 且开仓 ≤ `c3` | 高杠杆 ＋ 出手极少 |
 * | 逐利游牧 | `move ≥ c10` | 满世界换所 |
 * | 向死而生 | `loan ≥ 1` 且**活到结算** | 领过救济金续命 |
 * | ✱ 续命无果 | `loan ≥ 1` 且**破产** | 领了救济金也没能续住 |
 * | 认栽跑路 | **收摊**收场、几乎没开过仓、没领救济金 | 试了两把就放弃 |
 * | 永动机 | 开仓 ≥ `c100` 且**日均 ≥ 5 单** | 手根本停不下来 |
 * | 高频猎手 | 开仓 ≥ `c100` | 开仓极频繁 |
 * | 日内快枪手 | 开仓 ≥ `c30` 且**日均 ≥ 1 单** | 一天不止一单 |
 * | 单币信徒 | `syms.length === 1` | 只玩一个币 |
 * | 全能多面手 | `syms.length ≥ 5` | 多币种铺开 |
 * | 合约狂人 | 开仓 ≥ `c3` 且合约占 ≥ 60% | 偏爱合约 |
 * | 杠杆老兵 | 开仓 ≥ `c3` 且杠杆占 ≥ 60% | 偏爱杠杆 |
 * | 佛系囤币 | 从不用杠杆、日均 ≤ 0.01 单、走过 ≥ `c365` | 买了就躺 |
 * | 长线猎手 | 走过 ≥ `c180` 天且**日均开仓 ≤ 0.02** | 低频、拿得久 |
 * | 铁头娃 | `maxLev ≥ 10`、**一次没爆**、开仓 ≤ `c5`、活到结算 | 高杠杆却次次躲过强平 |
 * | 割肉客 | 平仓 ≥ `c10` 且胜率 ≤ 30% | 十单九割 |
 * | 常胜将军 | 平仓 ≥ `c15` 且胜率 ≥ 75% | 出手少有失手 |
 * | 稳健交易员（兜底） | 其余 | 工具 / 频率都均衡 |
 *
 * ⚠️ 上表的**次数 / 天数**档按本局时长归一（`cThr`，简写 `c10 = cThr(10,k,3)` 等）：
 *    `c10 = cThr(10,k,3)`、`c100 = cThr(100,k,30)`、`c30 = cThr(30,k,10)`、
 *    `c3 = cThr(3,k,2)`、`c5 = cThr(5,k,3)`、`c365 = cThr(365,k,60)`、`c180 = cThr(180,k,30)`、
 *    `c15 = cThr(15,k,8)`。
 *    ⚠️ **不归一**的几档：`open === 0`（绝对）、`maxLev`（单笔杠杆与时长无关）、
 *    `syms`（能开几个币取决于该年代**解锁了哪些**，不是时长）、`loan ≥ 1`（救济金一局一次）。
 *
 * ⚠️ 与徽章的边界：徽章是「细节标签」（可 0 枚、可多枚），风格称号是「一句话人设」（恒 1 枚）——
 *    两者判据可以相邻但**用词不同**，避免同一页出现两个一模一样的词。
 */
export function styleOf(rec) {
  const open = rec.open || 0;
  const fut = rec.fut || 0;
  const margin = rec.margin || 0;
  const liq = rec.liq || 0;
  const days = Math.max(1, rec.days || 0);
  const syms = Array.isArray(rec.syms) ? rec.syms.length : 0;
  const bust = bustOf(rec);
  const closed = (rec.win || 0) + (rec.loss || 0);
  const k = durKOf(rec);            // 本局时长归一标量（经典局 = 1 ⇒ 阈值全等于下表原值）
  const rate = open / days;         // 日均开仓（节奏类判据共用）

  if (open === 0) return '空仓看客';
  /* ⚠️ 破产结局：**不许说任何「活下来了」的话** —— `liq ≥ 10` 不再是「不死鸟」、
     `loan ≥ 1` 不再是「向死而生」（两枚说的都是「挺过来了」，而这一局没挺过来）。 */
  if (liq >= cThr(10, k, 3)) return bust ? '爆仓常客' : '不死鸟';
  if ((rec.maxLev || 0) >= 100) return '梭哈战神';        // 单笔杠杆：与时长无关，不归一
  if ((rec.maxLev || 0) >= 20 && open <= cThr(3, k, 2)) return '孤注一掷';
  if ((rec.move || 0) >= cThr(10, k, 3)) return '逐利游牧';
  if ((rec.loan || 0) >= 1) return bust ? '续命无果' : '向死而生';
  /* 收摊（GAVEUP）＋ 几乎没开过仓 ＋ 没领过救济金 ⇒ 「试了两把就放弃」。
     ⚠️ 必须排在 `loan` 之后：领过救济金的收摊归「续命无果」，那才是它的故事。 */
  if (bust && rec.reason === OVER.GAVEUP && open <= cThr(5, k, 3)) return '认栽跑路';
  if (open >= cThr(100, k, 30) && rate >= 5) return '永动机';
  if (open >= cThr(100, k, 30)) return '高频猎手';
  if (open >= cThr(30, k, 10) && rate >= 1) return '日内快枪手';
  if (syms === 1) return '单币信徒';
  if (syms >= 5) return '全能多面手';
  if (fut >= cThr(3, k, 2) && fut * 10 >= open * 6) return '合约狂人';
  if (margin >= cThr(3, k, 2) && margin * 10 >= open * 6) return '杠杆老兵';
  /* 佛系囤币：**从没用过杠杆**（`maxLev ≤ 1`）＋ 出手极稀 ＋ 拿得够久 ⇒ 买了就躺。 */
  if ((rec.maxLev || 0) <= 1 && open >= 1 && rate <= 0.01 && days >= cThr(365, k, 60)) return '佛系囤币';
  if (days >= cThr(180, k, 30) && rate <= 0.02) return '长线猎手';
  /* 铁头娃：高杠杆却**一次没爆过**，且活到结算 —— 「头铁但运气（或纪律）好」。
     ⚠️ 放在工具类之后：它说的是「杠杆用得多又没出事」，不是「用什么工具」。 */
  if ((rec.maxLev || 0) >= 10 && liq === 0 && !bust && open <= cThr(5, k, 3)) return '铁头娃';
  if (closed >= cThr(10, k, 5) && (rec.win || 0) / closed <= 0.3) return '割肉客';
  if (closed >= cThr(15, k, 8) && (rec.win || 0) / closed >= 0.75) return '常胜将军';
  return '稳健交易员';
}

/**
 * 徽章 —— **29 枚**，按固定顺序排列（顺序＝档案页与海报上从左到右的次序）。
 *
 * 分组（**每一组内互斥**，避免一行里冒出两枚意思相近的标签 —— LESS IS MORE 的硬要求）：
 *   · **工具**：躺平大师 / 躺平 / 现货党 / 杠杆党（四选一）
 *   · **杠杆烈度**：百倍玩家 / 杠杆赌徒（二选一）
 *   · **分散度**：单一信仰 / 五币全通（二选一）
 *   · **爆仓**：爆仓之王 / 九死一生 / 爆仓机器（三选一）
 *   · **时长**：长跑选手 / 三年老将 / 一年老兵（三选一，阶梯）
 *   · **交易量**：千次开仓 / 交易狂魔（二选一，阶梯）
 *   · **节奏**：闪电爆仓 / 闪电战（二选一）
 *   · **曲线形态**：过山车 / 深度回撤 / 教科书曲线（三选一）
 *   · **现金流**：负债离场 / 给交易所打工 / 落袋为安（三选一）
 *   · **行为**：搬家达人 / 续命者 / 上帝之手（各自独立，最多 3 枚）
 *   · **胜率**：神枪手
 *   · **历史时刻**：危机幸存者
 *
 * ⚠️ **不是每局都有徽章**（一局平淡到没有任何极端特征的局＝0 枚）—— 那是**对的**：
 *    徽章是「这一局长什么样」的**快照**，不是任务。风格称号那一轴保证**任何一局都有人设**。
 * ⚠️ 「九死一生」= 爆仓 ≥ 50 次**却活到结算**（不是被打爆的）；「爆仓之王」= ≥ 100 次。
 * ⚠️ **分组互斥 ⇒ 单局最多 14 枚**（海报只有两行，见 `sim-audit` §12）——
 *    新增徽章时**必须**并入某个互斥组，不许再挂一条独立 `if` 把上限顶破。
 */
export function badgesOf(rec) {
  const out = [];
  const symCount = Array.isArray(rec.syms) ? rec.syms.length : 0;
  const cash0 = rec.cash0 || 0;
  const closed = (rec.win || 0) + (rec.loss || 0);
  const k = durKOf(rec);
  const mdd = maxDdOf(rec);

  /* 工具（四选一）：一单没开（久躺另算） / 全程没用杠杆 / 只用过杠杆（没用合约）。 */
  if (rec.open === 0) out.push((rec.days || 0) >= cThr(365, k, 60) ? '躺平大师' : '躺平');
  else if ((rec.maxLev || 0) <= 1) out.push('现货党');
  else if (rec.fut === 0) out.push('杠杆党');

  /* 杠杆烈度（二选一） */
  if (rec.maxLev >= 100) out.push('百倍玩家');
  else if (rec.maxLev >= 20) out.push('杠杆赌徒');

  /* 分散度（二选一） */
  if (symCount === 1) out.push('单一信仰');
  else if (symCount >= 5) out.push('五币全通');

  /* 爆仓（三选一，按次数阶梯）：≥100 是「爆仓之王」，≥50 且活下来是「九死一生」，否则 ≥20 是「爆仓机器」。 */
  if (rec.liq >= 100) out.push('爆仓之王');
  else if (rec.liq >= 50 && rec.reason !== OVER.LIQUIDATED) out.push('九死一生');
  else if (rec.liq >= 20) out.push('爆仓机器');

  /* 时长（三选一，阶梯）：够 10 年才叫「长跑选手」。 */
  if (rec.days >= 3650) out.push('长跑选手');
  else if (rec.days >= 1095) out.push('三年老将');
  else if (rec.days >= 365) out.push('一年老兵');

  /* 交易量（二选一，阶梯） */
  if (rec.open >= 1000) out.push('千次开仓');
  else if (rec.open >= 200) out.push('交易狂魔');

  /* 节奏（二选一）：一个月内就结束 —— 如果是**爆掉**的，说法更狠。 */
  if (rec.open > 0 && rec.days <= 30) out.push(bustOf(rec) ? '闪电爆仓' : '闪电战');

  /* 曲线形态（三选一）：先认「大起又大落」，再看「一路深坑」与「一路平滑」。 */
  if (rec.reason !== OVER.LIQUIDATED && cash0 > 0 && rec.peak >= cash0 * 5 && rec.final <= rec.peak * 0.3) {
    out.push('过山车');
  } else if (mdd != null && mdd >= 0.8) {
    out.push('深度回撤');
  } else if (mdd != null && mdd <= 0.2 && (rec.days || 0) >= cThr(365, k, 60)) {
    out.push('教科书曲线');
  }

  /* 现金流（三选一）：欠钱 > 白干 > 落袋。 */
  if (rec.final < 0) out.push('负债离场');
  else if (rec.reason !== OVER.LIQUIDATED && rec.open >= 50 && rec.final < cash0) out.push('给交易所打工');
  else if (rec.reason !== OVER.LIQUIDATED && rec.realized > 0) out.push('落袋为安');

  /* 行为（各自独立，最多 3 枚） */
  if (rec.move >= 10) out.push('搬家达人');
  if (rec.loan >= 1) out.push('续命者');
  if (rec.god) out.push('上帝之手');

  /* 胜率：样本够（≥ 15 笔平仓）且胜率 ≥ 60%。 */
  if (closed >= 15 && rec.win / closed >= 0.6) out.push('神枪手');

  /* 危机幸存者：**开在 312 之前、收在 312 之后**（真跨过那根针），且不是被打爆的。
   * ⚠️ `start < CRASH_312` 这一半不能省 —— 否则 2021 / 2022 开局的年代局
   *    「终局天然晚于 312」会白捡这枚徽章。 */
  if (rec.start < CRASH_312 && rec.end >= CRASH_312 && rec.reason !== OVER.LIQUIDATED) {
    out.push('危机幸存者');
  }
  return out;
}
