/**
 * 上帝模式 ＋ 订单冲击 —— 价格位移层
 * ===============================================================
 * 两套位移，**相乘**叠加，且只在**一个地方**生效：`market.candleAt`。
 * （markPrice / 权益 / 强平价 / 资金费 / K 线图 / HUD 涨跌幅全部经由它 ⇒ 下游一行都不用改。）
 *
 *   ① 手动设价 `s.god.scale[sym]` —— **全局永久**乘数，上帝面板的「砸盘」档位写它
 *   ② 订单冲击 `s.flow[sym]`       —— **逐根**衰减（Bouchaud 幂律），开/平仓时按成交代价的永久占比写入
 *
 * ⚠️ 为什么②必须是**逐根**系数、不能写成「当前时刻的全局常数」：
 *    一笔单只影响它**之后**的行情（`j < at` ⇒ 系数 1），这才对得上「价格从那一根开始下台阶、
 *    再按幂律慢慢爬回」。写成全局常数会让历史 K 线跟着一起缩放（图像像被重新标定过），
 *    而且**收益率不变 ⇒ σ_30日不变**，与「冲击真的发生了」直接矛盾。
 *
 * ⚠️ 逐根系数的代价必须记住：相邻收益率会变 ⇒ σ_30日会变 ⇒ 滑点与资金费率连带变。
 *    所以 `engine.invalidateSigma()` 必须在**每次写 `s.flow` 之后**调用，
 *    否则会算出「价格在动、波动率不动」的不自洽滑点。
 */

/** 冲击模型的常数（实证取值，见方案文档 §2.6） */
export const SHOCK = {
  /**
   * 永久冲击占比。Almgren–Chriss 把总冲击拆成「暂时（会恢复）＋ 永久（留下）」两块，
   * 实证里永久占 30–40%。**不是重复收惩罚**：`impactOf` 是成交瞬间付出的全部代价，
   * 这里只把其中的这部分沉淀成行情位移，剩下的就是 AC 里的暂时冲击。
   */
  share: 0.35,
  /** Bouchaud propagator 的幂律指数 β ≈ 0.3（衰减极慢：100 小时后仍有 25%） */
  beta: 0.3,
};

/** 衰减因子：`e` = 距写入时刻经过的**游戏小时数**。前 1 小时不衰减，之后按 e^(−β) 慢慢回爬 */
export function decay(e) {
  if (!(e > 1)) return 1;          // e ≤ 1（含 0 与负数）一律视为「刚开始」，不衰减
  return Math.pow(e, -SHOCK.beta);
}

/** 某个币在**第 j 根**上残存的订单冲击量（0 = 没有冲击、j 早于写入时刻） */
export function residualAt(s, sym, j) {
  const p = s.flow && s.flow[sym];
  if (!p || !p.v || j < p.at) return 0;
  return p.v * decay(j - p.at);
}

/**
 * 把一笔成交的永久冲击写进池子。
 *
 * ⚠️ **先把旧冲击按当前时刻归并，再累加**（`v = 残存 + delta`）——
 *    这样「重置衰减计时」是无害的：池里存的已经是它此刻的真实值，衰减曲线连续。
 *    注意这仍是**单池模型**：多笔单会合并成一条曲线，做不到逐单 propagator 叠加
 *    （那要存全部历史成交，与「存档不膨胀」冲突）。首版接受，实机后复校。
 * @returns {boolean} 是否真的写进去了（Δ 为 0 时不写，避免无意义地刷存档）
 */
export function addFlow(s, sym, delta) {
  if (!Number.isFinite(delta) || delta === 0) return false;
  const v = residualAt(s, sym, s.i) + delta;
  s.flow[sym] = { v, at: s.i };
  return true;
}

/**
 * 第 j 根的**价格位移系数** —— `market.candleAt` 唯一要乘的那个数。
 * 未开上帝模式、也没有任何冲击时恒等于 1（⇒ 与数据包逐位相同）。
 */
export function factorFor(s, sym, j) {
  const g = s.god;
  let f = (g && g.scale && g.scale[sym]) || 1;
  if (f <= 0) f = 1;

  const r = residualAt(s, sym, j);
  /* 冲击把价格压到 0 以下是没意义的：夹在 −99%，再保一个极小的正下限 */
  if (r) f *= 1 + Math.max(-0.99, r);

  return f > 1e-9 ? f : 1e-9;
}

/* ───────────────────────── 上帝面板用的小工具 ───────────────────────── */

/** 开启上帝模式（幂等：已开过就只补缺失的键） */
export function enableGod(s) {
  s.god = {
    mult: s.god?.mult ?? 1,
    scale: s.god?.scale ?? {},
    lastFill: s.god?.lastFill ?? 100000,
  };
  return s.god;
}

/**
 * 手动设价：把**当前币**的行情整体乘以一个系数（`k = -0.3` ⇒ 砸 30%）。
 * ⚠️ 是**永久**的，只有「复位」能还原；与订单冲击（会自己回爬）不同。
 */
export function setScale(s, sym, k) {
  if (!s.god) return;
  const next = 1 + k;
  if (!(next > 0.01)) return;
  s.god.scale[sym] = next;
}

/** 复位全部手动设价（订单冲击池**不动** —— 那是已发生的历史） */
export function clearScale(s) {
  if (s.god) s.god.scale = {};
}