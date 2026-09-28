/**
 * 滑点 —— 平方根定律冲击模型（GDD §14.3，P2-B1 落地）
 * ===============================================================
 * 纯函数集合：**不碰状态、不碰 DOM、不读时钟**（与 `positions.js` 同一分层）。
 *
 * 口径（2026-09-29 拍板，勿擅改）：
 *   q      = 本次成交名义价值 ÷ 该币**当日**流动性（`market.liqOf`，与 K 线量柱同源）
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
};

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