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
export const SLIP = {
  threshold: 0.10,     // q 低于此值 ⇒ 不触发滑点
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

/**
 * 冲击 = 价格上抬 / 下压的比例。
 * @param {number} q     本次成交名义价值 ÷ 当日流动性
 * @param {number} sigma 日收盘收益率标准差（`sigmaOf` 的结果）
 * @returns {number} 0 ~ `SLIP.hard`
 */
export function impactOf(q, sigma) {
  if (!(q > SLIP.threshold)) return 0;           // 含 NaN / 0 / 负值
  const s = Number.isFinite(sigma) && sigma > 0 ? sigma : SLIP.sigmaDefault;
  const raw = SLIP.A * s * Math.sqrt(Math.min(q, SLIP.cap));
  return Math.max(0, Math.min(SLIP.hard, raw));
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

/**
 * **限价挂单的深度上限**（C8-B2 · ROADMAP §33.3）—— 按偏离度反推「这个价位最多能吃下多少名义」。
 *
 * 把 `impactOf` **反解**：想让成交代价恰为 `d`，需要 `q = (d / (A·σ))²`。
 * 于是本价位当根能成交的名义上限：
 *
 *     Q = hourLiq × clamp( (d / (A·σ))² , SLIP.threshold , SLIP.cap )
 *
 * ⚠️ **下限取 `SLIP.threshold`（2026-09-30 裁决，原为纯 `min`）**：`impactOf` 自带 0.10 的死区
 *    （`q ≤ threshold ⇒ 冲击恒为 0`），于是 `d < 0.632σ` 的**近档**反解出的 `q` 会落进死区、
 *    深度偏保守。但模型那句「q ≤ 0.10 ⇒ 零冲击」本身就在说**市场能免费吃下当根流动量的 10%**
 *    ⇒ 任何档位的深度都不该低于 `threshold × hourLiq`。下限与幂式在 `d = 0.632σ` 处**连续**
 *    （无跳变），也不破红线 A（深度只用来截断成交量，成交价恒 = L）。
 *
 * 为什么是「上限」而不是「概率队列」（弃 §26.5 那个方案）：
 *   真 L2 深度数据已被判死（§24.10），编一套挂单排队的概率模型＝凭空造数据；
 *   而「离中间价越远 ⇒ 盘口那一侧越薄 ⇒ 能吃下的越少」是**同一套平方根定律的必然推论**，
 *   用的仍是现有的 `impactOf` 反函数 —— 没有引入任何新常数。
 *
 * ⚠️ **红线 A · 不双重计价**：挂单是 maker 被动成交，成交价恒 = L，
 *    因此 `Q` **只用来截断成交量**，成交后**不写** `s.flow` 冲击池（价格位移已经体现在 L 本身）。
 *
 * @param {number} d       偏离度 `|L − 中间价| / 中间价`（**挂单时锁定**，不随行情漂移）
 * @param {number} sigma   日收盘收益率标准差（撮合当根的 `dailySigma`）
 * @param {number} hourLiq 当根小时流动性（分母与 `impactFor` 同一处）—— **每根重算**
 * @returns {number} 该价位当根可成交的**名义价值**上限（货币单位，不是币量）
 */
export function depthOf(d, sigma, hourLiq) {
  if (!(hourLiq > 0)) return 0;
  if (!(d > 0)) return 0;
  const s = Number.isFinite(sigma) && sigma > 0 ? sigma : SLIP.sigmaDefault;
  const q = Math.min(Math.max((d / (SLIP.A * s)) ** 2, SLIP.threshold), SLIP.cap);
  return q * hourLiq;
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