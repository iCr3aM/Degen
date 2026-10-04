/**
 * 称号与徽章（M3 · 2026-10-01；2026-10-04 扩为**三轴**）
 * ===============================================================
 * 输入是 `core/careers.js` 的**一条档案记录**，输出「主称号 ＋ 风格称号 ＋ 徽章」：
 *
 *     titleOf(rec)   →  '百倍战神'                （主称号：**结局 × 倍数**，一局一枚）
 *     styleOf(rec)   →  '不死鸟'                  （风格称号：**怎么打的**，一局一枚，永不为空）
 *     badgesOf(rec)  →  ['杠杆党', '钻石手', …]   （徽章：0–N 枚的细节标签）
 *
 * 档案页（`render.js` 的 `careerRow`）与分享图（M4 `ui/shareCard.js`）**共用这里** ⇒
 * 同一局在哪儿看都是同一套称号，不会两处各写一份判断（LESS IS MORE 的硬要求）。
 *
 * ── 为什么加「风格称号」（2026-10-04 用户拍板）────────────────────
 * 原来只有「主称号」一轴，而它**只由结局 × 倍数决定** —— 两个都结算在 1.2b 的玩家，
 * 不管一个是「爆仓 88 次硬扛到结算」、另一个是「一路 1x 稳稳拿到结算」，称号**一模一样**，
 * 看不出「怎么打的」。补一轴**纯行为**的风格称号（与结局无关）：结局说「打成什么样」，
 * 风格说「你是哪种玩家」，徽章补细节。三轴合起来，任何一局都至少有**两枚**称号。
 *
 * ⚠️ **纯函数**：不给 `s` 打点、不读 localStorage、不改 `STATE_VERSION`，重算一百遍也不变。
 * ⚠️ 判据全部落在 M1 已打点的 `s.stat` 上（`open/fut/margin/maxLev/win/loss/liq/syms/move/loan/god`）＋
 *    档案里已摊平的 `days/peak/final/realized/start/end/reason` ——
 *    绝不为了称号再往状态里塞新字段。
 */

import { OVER } from './engine.js';

/* ── 312 那根针的绝对时刻（2020-03-12T00:00:00Z）──
 * `rec.start` / `rec.end` 都是**绝对 ms**，可直接比；此处写 UTC 时刻而非 import `GAME`，
 * 免去「为一个日期把 config 也拉进来」的耦合。 */
const CRASH_312 = Date.UTC(2020, 2, 12);

/** 倍数（`final / cash0`）—— 档案页与主称号共用同一口径 */
export const multOf = rec => (rec.cash0 > 0 ? rec.final / rec.cash0 : 0);

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
 * 主称号 —— **结局 × 倍数**。混合风格：低档写实（陪跑 / 活下来），高档用梗（钻石手 / 百倍战神）。
 * ⚠️ 结算那条链的**末档用 `else` 兜底** —— 倍数再离谱也一定落到「百倍战神」，绝不返回空串。
 */
export function titleOf(rec) {
  if (rec.reason === OVER.LIQUIDATED) return '归零者';
  if (rec.reason === OVER.GAVEUP) return '收摊的人';
  const m = multOf(rec);
  if (m < 1) return '陪跑的';
  if (m < 2) return '活下来的';
  if (m < 5) return '翻倍的人';
  if (m < 20) return '钻石手';
  if (m < 100) return '币圈锦鲤';
  return '百倍战神';
}

/**
 * 风格称号 —— **纯行为**（与结局、盈亏无关），一局一枚，**永不为空**（末档 `else` 兜底）。
 *
 * 顺序＝**优先级**（`if` 链，先命中先返回）。排在前面的更「独特」：先认出少数派
 * （一单没开的看客 / 反复爆仓的不死鸟 / 极限杠杆的梭哈战神 / 满世界搬家的游牧…），
 * 再落到「用什么工具、打得多快」这些大众特征，最后是**兜底**「稳健交易员」。
 *
 * | 风格称号 | 判据 | 说的是 |
 * | --- | --- | --- |
 * | 空仓看客 | `open === 0` | 一单都没开 |
 * | 不死鸟 | `liq ≥ 10` | 反复爆仓又爬起来 |
 * | 梭哈战神 | `maxLev ≥ 100` | 动辄百倍杠杆 |
 * | 逐利游牧 | `move ≥ 10` | 满世界换所 |
 * | 向死而生 | `loan ≥ 1` | 领过救济金续命 |
 * | 高频猎手 | `open ≥ 100` | 开仓极频繁 |
 * | 单币信徒 | `syms.length === 1` | 只玩一个币 |
 * | 全能多面手 | `syms.length ≥ 5` | 多币种铺开 |
 * | 合约狂人 | 开仓 ≥ 3 且合约占 ≥ 60% | 偏爱合约 |
 * | 杠杆老兵 | 开仓 ≥ 3 且杠杆占 ≥ 60% | 偏爱杠杆 |
 * | 长线猎手 | 走过 ≥ 180 天且**日均开仓 ≤ 0.02** | 低频、拿得久 |
 * | 稳健交易员（兜底） | 其余 | 工具 / 频率都均衡 |
 *
 * ⚠️ **判据互斥且闭合**：前四档是「少数派身份」，互不重叠；「单币 / 多币」与
 *    「合约 / 杠杆」各自成对；`长线猎手` 用 `日均 ≤ 0.02`（约 50 天一笔）识别「低频」。
 *    任何一条记录都会落到上面某一行，**不存在返回空串的输入**（审计里穷举矩阵验证）。
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

  if (open === 0) return '空仓看客';
  if (liq >= 10) return '不死鸟';
  if ((rec.maxLev || 0) >= 100) return '梭哈战神';
  if ((rec.move || 0) >= 10) return '逐利游牧';
  if ((rec.loan || 0) >= 1) return '向死而生';
  if (open >= 100) return '高频猎手';
  if (syms === 1) return '单币信徒';
  if (syms >= 5) return '全能多面手';
  if (fut >= 3 && fut * 10 >= open * 6) return '合约狂人';
  if (margin >= 3 && margin * 10 >= open * 6) return '杠杆老兵';
  if (days >= 180 && open / days <= 0.02) return '长线猎手';
  return '稳健交易员';
}

/**
 * 徽章 —— **20 枚**，按固定顺序排列（顺序＝档案页与海报上从左到右的次序）。
 *
 * 分组（每一组内**互斥**，避免一行里冒出两枚意思相近的标签 —— LESS IS MORE 的硬要求）：
 *   · **工具**：躺平 / 现货党 / 杠杆党（三选一）
 *   · **杠杆烈度**：百倍玩家 / 杠杆赌徒（二选一）
 *   · **分散度**：单一信仰 / 五币全通（二选一）
 *   · **爆仓**：九死一生 / 爆仓机器（二选一）
 *   · **行为**：搬家达人 / 续命者 / 上帝之手 / 危机幸存者 / 交易狂魔 / 闪电战 / 长跑选手
 *   · **曲线**：过山车 / 落袋为安 / 给交易所打工
 *   · **胜率**：神枪手
 *
 * ⚠️ **不是每局都有徽章**（一局平淡到没有任何极端特征的局＝0 枚）—— 那是**对的**：
 *    徽章是「这一局长什么样」的**快照**，不是任务。风格称号那一轴保证**任何一局都有人设**。
 * ⚠️ 「九死一生」= 爆仓 ≥ 50 次**却活到结算**（不是被打爆的）；否则 >= 20 次落「爆仓机器」。
 */
export function badgesOf(rec) {
  const out = [];
  const symCount = Array.isArray(rec.syms) ? rec.syms.length : 0;
  const cash0 = rec.cash0 || 0;
  const closed = (rec.win || 0) + (rec.loss || 0);

  /* 工具（三选一）：一单没开 / 全程没用杠杆 / 只用过杠杆（没用合约）。 */
  if (rec.open === 0) out.push('躺平');
  else if ((rec.maxLev || 0) <= 1) out.push('现货党');
  else if (rec.fut === 0) out.push('杠杆党');

  /* 杠杆烈度（二选一） */
  if (rec.maxLev >= 100) out.push('百倍玩家');
  else if (rec.maxLev >= 20) out.push('杠杆赌徒');

  /* 分散度（二选一） */
  if (symCount === 1) out.push('单一信仰');
  else if (symCount >= 5) out.push('五币全通');

  /* 爆仓（二选一）：爆到 50 次还活下来是「九死一生」，否则 20 次起是「爆仓机器」。 */
  if (rec.liq >= 50 && rec.reason !== OVER.LIQUIDATED) out.push('九死一生');
  else if (rec.liq >= 20) out.push('爆仓机器');

  /* 行为 */
  if (rec.move >= 10) out.push('搬家达人');
  if (rec.loan >= 1) out.push('续命者');
  if (rec.god) out.push('上帝之手');
  if (rec.open >= 200) out.push('交易狂魔');
  if (rec.open > 0 && rec.days <= 30) out.push('闪电战');
  if (rec.days >= 3650) out.push('长跑选手');

  /* 曲线（净值形态）：先认「大起大落」，再看「落袋」与「白干」。 */
  if (rec.reason !== OVER.LIQUIDATED && cash0 > 0 && rec.peak >= cash0 * 5 && rec.final <= rec.peak * 0.3) {
    out.push('过山车');
  }
  if (rec.reason !== OVER.LIQUIDATED && rec.realized > 0) out.push('落袋为安');
  if (rec.reason !== OVER.LIQUIDATED && rec.open >= 50 && rec.final < cash0) out.push('给交易所打工');

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