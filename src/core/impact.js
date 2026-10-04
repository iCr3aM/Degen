/**
 * 滑点 —— 平方根定律冲击模型（GDD §14.3，P2-B1 落地）
 * ===============================================================
 * 纯函数集合：**不碰状态、不碰 DOM、不读时钟**（与 `positions.js` 同一分层）。
 *
 * 口径（2026-09-29 拍板，勿擅改）：
 *   q      = 本次成交名义价值 ÷ 该币**当时**的流动性（`market.liqOf` 的日值 × 日内份额系数）
 *   q ≤ 阈值 ⇒ 不触发（小额单子按盘口价成交，冲击记为零）
 *   impact = clamp( A × σ_30日 × sqrt(min(q, cap)), 0, hard )
 *   买（开多 / 平空）⇒ 成交价 = 盘口价 × (1 + impact)
 *   卖（开空 / 平多）⇒ 成交价 = 盘口价 × (1 − impact)
 *
 * 为什么指数是 0.5：冲击随规模**次线性**增长是市场微观结构的经验规律（平方根定律）——
 * 线性模型让大单的代价离谱地高，常数模型又让大户完全无视深度，平方根是两者之间唯一有实据的取法。
 *
 * ⚠️ `hard` 是**数学天花板**，不是平衡旋钮：GDD §14.3 原稿那个 30% 上限在真实流动性下偏高
 *    10–18 倍，真正起作用的是 `cap`（吃掉当日流动量 1/4 之后不再更差）与 σ 的量级；
 *    `hard` 只兜住极端年份的尾巴，不负责平衡。
 */
/**
 * ⚠️ **口径注 · `threshold` 死区在现代年会让大单零滑点**（F2 · 2026-10-03 发布前审计，用户拍板
 *    「**保持 ＋ 写口径注**」，完整见 `.trae/documents/发布前审计-下单模拟-数值取证.md` §3）。
 *
 * 死区 = 「单笔名义 ≥ 当日**全市场**成交额的 10% 才收滑点」，而锚点是全市场口径（§8.3 已结案）⇒
 * 门槛随流动性水涨船高。**实测值以 `tools/sim-audit.mjs` §8b 为准**（该节逐年打印，可复现）：
 * BTC 口径 2013-09 $0.6M → 2018-01 $175.8M → 2021-04 $1223.1M → 2024-07 $699.2M；
 * 其余四币门槛按其自身流动性同比例平移。⇒ 2018 年后连 $100M 的单都记零。
 * ⚠️ **R12（2026-10-04 审计）**：原文写「2018 起 = $220M / $1,081M / $865M」，与 §8b 的
 *    实测量级对不上（照 `LIQ_MKT × 0.3 × 10%` 复核后逐位更正为上面这组）。
 *
 * 为什么**保持**：
 *   ① 按平方根律，$10M 在 2021 的真实冲击仅 ≈0.09%（≈ $8.7K）—— **量级可忽略**，记 0 不等于失真；
 *   ② 死区是**刻意**的护栏：它只属于「代价」侧，`permImpactOf`（行情位移）**没有**这条死区
 *      ⇒ 大单在 K 线上照样留下位移，只是不被额外收费（两件事本就不该共用一条死区）；
 *   ③ 本作不模拟微观盘口（红线），把分母换成「单所深度」要新开一个度量。
 * ⚠️ 早年（2013 / 2016）门槛低，大单**照常触发** —— 死区并非全局失效，只是随年代后移。
 */
export const SLIP = {
  threshold: 0.10,     // q 低于此值 ⇒ 不触发滑点（口径注见上：现代年大单零滑点是有意为之）
  cap: 0.25,           // sqrt 的自变量上限：吃掉当日流动量的 1/4 之后不再更差
  A: 2,                // 瞬时市价单惩罚系数
  hard: 0.30,          // impact 的硬上限
  window: 30,          // σ 的窗口：近 30 天的日收盘收益率
  sigmaDefault: 0.03,  // 样本不足时的兜底 σ：3% / 天
  shareFloor: 1 / 255, // 日内份额的下限 ＝ 数据包能表达的最小非零份额（见 `hourShareK`）
};

/**
 * **日内流动性的份额系数**（C2，2026-09-29 拍板）—— 把「日流动性」摊到**小时**。
 *
 * 分母 ＝ `liqOf(sym, 当天) × hourShareK(share, sum, n)`：
 *   - `share` 该小时占当日成交额的份额（1 字节/根，数据现成）
 *   - `sum`   当天**已上线**各小时的份额之和（一个完整交易日 ≈ 1）
 *   - `n`     当天**已上线**的小时数（一个完整交易日 = 24）
 *
 * 为什么是 `share ÷ sum × n` 而不是直接用 `share`：
 *   一个完整交易日里 `n = 24`、`sum ≈ 1` ⇒ 系数 = **24 × share**，其**当日均值恰为 1**
 *   ⇒ 一天下来的平均行为与「只用日流动性」**完全一致**，`A` / `threshold` / `cap` 全都无需重校；
 *   而 `÷ sum × n` 让**币种上线当天**（不足 24 小时，`sum` 仍是 1）不会被误放大 24/n 倍。
 *
 * 效果：**凌晨薄盘时段同样的单冲击更大、正午活跃时段更小** —— 这才是 C2 要的真实度。
 * 该小时无成交（`share = 0`）时回落到 `shareFloor`，最多把 `q` 放大 ~10 倍，**再被 `cap` 夹住**。
 *
 * @returns {number} ≥ `shareFloor ÷ sum × n` 的正系数；`sum` / `n` 不可用时退回 1（= 只用日流动性）
 */
export function hourShareK(share, sum, n) {
  if (!(sum > 0) || !(n > 0)) return 1;
  const s = Number.isFinite(share) && share > SLIP.shareFloor ? share : SLIP.shareFloor;
  return (s / sum) * n;
}

/**
 * 日收盘收益率的**总体标准差**（不是样本标准差，与 `engine.hourlySigma` 同口径）。
 *
 * ⚠️ **口径注 · 为什么 σ 不做日内聚集**（缺口 9 · 2026-10-02 用户拍板「**不做 ＋ 写口径注**」，
 *    完整审计见 NEXT-STEPS §8.8）。真实加密市场的波动率**确有**日内形态（Hansen et al. 2021
 *    `arXiv:2109.12142`：Coinbase Pro / Binance / Uniswap 三源实测 hour-of-day 系统性形态；
 *    Alexander et al. 2021 `arXiv:2107.00298`：U 形峰值落 00:00 / 16:00 UTC），
 *    本作**也确实没有**给它做相位 —— 但这是**刻意的**，三条理由：
 *      ① 玩家在图上看到的日内波动聚集**已由真实小时线提供**：数据包存的就是 Bitfinex / Binance
 *         的 `interval=1h` 真 K 线（见 `tools/fetch-data.mjs` 头注）⇒ 模型层再加一层是**重复**；
 *      ② 成本侧的日内相位**已由 `hourShareK` 承担**（薄时段深度小 ⇒ `q` 大 ⇒ 冲击大），
 *         而 `impact ∝ σ ÷ √hourShareK`：若再给 σ 一条**同相位**的 U 形，两者在公式里按
 *         `H^(α−0.5)` **互相抵消**（文献里 σ 的日内振幅小于成交量的 ⇒ α 偏小）⇒ 净效果是二阶的；
 *      ③ 数据包**只有**逐小时份额字节、**没有** σ 的逐小时信息 ⇒ 要做只能新增一张硬编码
 *         「UTC 小时 → σ 系数」表 ＋ 一场重标定，违反「不新开第二个度量」的红线。
 *    ⇒ 结论：**不做**。别因为「文献说真实波动率有 U 形」就回来加 —— 那条 U 形已经在别处了。
 * @param {number[]} closes 按时间升序的日收盘价；洞 / 未上线（非正数）一律跳过
 * @returns {number} 有效收益不足 2 个时退回 `SLIP.sigmaDefault`
 */
export function sigmaOf(closes) {
  let n = 0, sum = 0, sum2 = 0, prev = 0;
  for (const c of closes) {
    if (!(c > 0)) { prev = 0; continue; }        // 洞：断开，不跨洞算收益
    if (prev > 0) { const r = c / prev - 1; n++; sum += r; sum2 += r * r; }
    prev = c;
  }
  if (n < 2) return SLIP.sigmaDefault;

  const mean = sum / n;
  const va = Math.max(0, sum2 / n - mean * mean);
  return Math.sqrt(va);
}

/** 冲击的核心式 `A × σ × sqrt(min(q, cap))` ＋ `hard` 上夹。两个入口共用，保证同形。 */
function impactCore(q, sigma) {
  const s = Number.isFinite(sigma) && sigma > 0 ? sigma : SLIP.sigmaDefault;
  const raw = SLIP.A * s * Math.sqrt(Math.min(q, SLIP.cap));
  return Math.max(0, Math.min(SLIP.hard, raw));
}

/**
 * **成交代价**用的冲击 = 价格上抬 / 下压的比例（买单变贵、卖单变便宜的那一份）。
 *
 * ⚠️ `q ≤ threshold`（当日流动量的 10%）⇒ **记为零**：小额单子按盘口价成交，不额外收代价。
 *    这条死区**只属于「代价」**，别拿去算行情位移 —— 见下面的 `permImpactOf`。
 * @param {number} q     本次成交名义价值 ÷ 当日流动性
 * @param {number} sigma 日收盘收益率标准差（`sigmaOf` 的结果）
 * @returns {number} 0 ~ `SLIP.hard`
 */
export function impactOf(q, sigma) {
  if (!(q > SLIP.threshold)) return 0;           // 含 NaN / 0 / 负值
  return impactCore(q, sigma);
}

/**
 * **行情位移**用的冲击 —— 与 `impactOf` 同形，但**没有阈值死区**（用户 2026-10-01 拍板）。
 *
 * 为什么必须分开（这是「大额买入不影响 K 线」的病根）：
 *   `threshold` 是**代价模型**的护栏（小额单不该被收滑点），但 `engine` 把 **同一个 0**
 *   又拿去当永久位移的幅度 ⇒ `god.addFlow(…, 0)` 当场早退，`s.flow` 里**一个字节都没写**。
 *   实测：2015 年后 BTC 单小时要 ≥ $8.5 万、2021 年要 ≥ $1.76 亿才触发 ⇒ 玩家的单子
 *   在图上完全不留痕迹。位移是**市场影响**（任何成交都有），代价是**收费**（小额免收），
 *   两件事本来就不该共用一条死区。
 *
 * ⚠️ 与 `impactOf` 一起构成「红线 A · 不双重计价」的两半：`impactOf` 只决定**这次成交付多贵**
 *    （`fillPrice`），`permImpactOf` 只决定**成交之后价格停在哪**（`SHOCK.share ×` 它）。
 */
export function permImpactOf(q, sigma) {
  if (!(q > 0)) return 0;                        // 含 NaN / 0 / 负值
  return impactCore(q, sigma);
}

/**
 * 成交价 —— 永远对玩家不利（买抬、卖压）。
 * @param {number} price  盘口价（标记价）
 * @param {number} dir    **+1 = 买**（开多 / 平空）、**−1 = 卖**（开空 / 平多）
 * @param {number} impact
 */
export function fillPrice(price, dir, impact) {
  return dir > 0 ? price * (1 + impact) : price * (1 - impact);
}

/* ──────────────────── 合成盘口（C8-B1 · ROADMAP §二十六） ──────────────────── */

/**
 * 子单切分的两个常数（C8-B1 · 2026-09-29 拍板「按名义份额摊」）。
 *
 * 真 L2 深度数据已被判死（`ROADMAP.MD` §24.10）⇒ 盘口**只能在内存里现算**
 * （红线 B：不改数据包、不加后端、不进存档）。
 *
 * ⚠️ **红线 A · 不双重计价**：这两个常数**只决定「报几笔」**，绝不参与任何价格计算 ——
 *    成交价仍然只由 `impactOf` ＋ `fillPrice` 一处算出，拆解结果不回头再改一次价。
 */
export const BOOK = {
  sliceShare: 0.03,   // 一张子单不超过「当时流动性」的 3%
  maxTranches: 8,     // 一张市价单最多报成几笔
};

/**
 * 这张市价单**相当于**被拆成了几笔。
 *
 * 为什么不用「代价 ÷ 一个 tick」来数：滑点的自变量是 `q = 名义 ÷ 当时流动性`，而 q 的可用区间
 * 被 `SLIP.threshold`（10%）与 `SLIP.cap`（25%）夹成一条窄带 ⇒ 按代价数出来的笔数
 * **恒等于上限**（实测最小冲击 1.27% ÷ 1bp = 127 档，永远顶格），那只是噪声而不是颗粒度。
 * 按名义份额数才有区分度：q = 0.10 ⇒ 4 笔、0.15 ⇒ 5 笔、0.24 ⇒ 8 笔。
 *
 * @param {number} q    本次成交名义 ÷ 当时流动性（分母与 `impactFor` 同一处，见 `hourShareK`）
 * @param {number} cost 本次成交的代价（`impactOf` 的结果）—— 为 0 时没有笔数可报
 * @returns {number} 1 ~ `BOOK.maxTranches`
 */
export function bookFills(q, cost) {
  if (!(cost > 0) || !(q > 0)) return 1;
  return Math.min(BOOK.maxTranches, Math.ceil(q / BOOK.sliceShare));
}

/* ──────────────────── 瞬时深度池（L1 · ROADMAP §六十二） ──────────────────── */

/**
 * **瞬时深度池** —— 补上「不停买入会把盘口吃光」这一维。
 *
 * 改动前：每笔单都按**满盘口**现算（`engine.hourLiqBase` 只随小时 / 年代 / 持仓变）
 * ⇒ **边际难度恒定**：第 100 笔和第 1 笔一样便宜，连续买入吃不光。
 * 这里加一池：成交吃掉的名义额 `v`（美元）从池中扣，按游戏小时**回补**，
 * 分母乘 `max(floor, 1 − v ÷ 容量)` —— 吃得越狠，接下来能承接的越薄。
 *
 * 容量口径：`capK × 该小时的基准深度`。基准深度（`hourLiqBase`）＝ 日流动性 × 日内份额系数，
 * 其**当日均值 ≈ 当日流动性**（C2 口径）⇒ 容量 ≈ `capK × 日流动性`，与文献
 * 「早间盘口 ≈ 当日成交额的 30–40%」同量级（`capK` 取该区间下沿）。
 *
 * 回补口径：指数衰减，**半衰期 4 游戏小时** —— 锚来自崩盘特征时间尺度 ≈4h（SD 2.5h）：
 * 做市商把被扫掉的挂单补回来，量级与价格修复同一尺度。1x 下 1 游戏小时 = 1 真实秒，
 * 所以「连点几下把池子吃空、停手几秒慢慢长回来」正是想要的手感；50x 下几小时一帧即过，池子几乎恒满。
 *
 * ⚠️ 与 `SLIP` 的关系：它**只改分母**（`q = 名义 ÷ 分母`），不改价格 —— 价格位移的唯一来源是 `s.flow`。
 *    所以写完池子**不**用 `invalidateSigma()`（σ 只由价格算）。
 * ⚠️ 上限是**两级的**：池子把分母压到 `floor` 后就到底；`q` 再大也被 `SLIP.cap` 夹住
 *    ⇒ 把小额单推进滑点区是它的目的，不会把大额单的代价推爆。
 */
export const POOL = {
  capK: 0.30,      // 池容量 ＝ capK × 该小时基准深度（≈ 日流动性的 30%，文献下沿）
  floor: 0.15,     // 吃光后分母仍存 15%（＝至多 ×6.7，防除零与无穷冲击）
  halfLife: 4,     // 回补半衰期（游戏小时）：e 小时后再点，只剩 2^(−e/4) 的消耗量
};

/**
 * **回补因子** —— `e` = 距上次消耗经过的游戏小时数，返回「已消耗量还剩多少」（1 → 0）。
 * @param {number} e 小时数；`≤ 0`（含同根内连点）⇒ 1（一分不回补）
 */
export function poolRefill(e) {
  if (!(e > 0)) return 1;
  return Math.pow(0.5, e / POOL.halfLife);
}
