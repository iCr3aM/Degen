/**
 * 订单冲击 —— 价格位移层
 * ===============================================================
 * 位移只在**一个地方**生效：`market.candleAt`。
 * （markPrice / 权益 / 强平价 / 资金费 / K 线图 / HUD 涨跌幅全部经由它 ⇒ 下游一行都不用改。）
 *
 *   订单冲击 `s.flow[sym]` —— **逐根**衰减（Bouchaud 幂律），开 / 平仓时按成交代价的永久占比写入。
 *   C1（2026-09-29）起是**逐笔列表**（`[{v, at}, …]`，≤ `SHOCK.listMax` 笔），残存值按笔叠加。
 *
 * ⚠️ 上帝模式（`s.god`）**没有任何价格能力**（2026-09-29 瘦身）：它只剩「跳日期 ＋ 填资金 ＋ 归零不退出」，
 *    与普通模式的差别**仅此三条**。原来那两套价格能力已整体删除 ——
 *      ① `s.god.scale` 手动设价（全局永久乘数）
 *      ② `s.god.mult` 冲击倍率（把 `SHOCK.share` 乘上 ×10 / ×100）
 *    玩家看到的「平仓后价格弹得比原价还高」「K 线缓升后平仓暴涨」全都出自这两条：
 *    位移唯一真正的来源就是**订单冲击**，而它按拟线性的平方根定律封顶（单笔收益 ≤ 10.5%）。
 *
 * ⚠️ 为什么位移必须是**逐根**系数、不能写成「当前时刻的全局常数」：
 *    一笔单只影响它**之后**的行情（`j < at` ⇒ 系数 1），这才对得上「价格从那一根开始下台阶、
 *    再按幂律慢慢爬回」。写成全局常数会让历史 K 线跟着一起缩放（图像像被重新标定过），
 *    而且**收益率不变 ⇒ σ_30日不变**，与「冲击真的发生了」直接矛盾。
 *
 * ⚠️ 逐根系数的代价必须记住：相邻收益率会变 ⇒ σ_30日会变 ⇒ 滑点与资金费率连带变。
 *    所以 `engine.invalidateSigma()` 必须在**每次写 `s.flow` 之后**调用，
 *    否则会算出「价格在动、波动率不动」的不自洽滑点。
 */

/** 冲击模型的常数（实证取值，见方案文档 §2.6 / §27.4-B1） */
export const SHOCK = {
  /**
   * 永久冲击占比。Almgren–Chriss 把总冲击拆成「暂时（会恢复）＋ 永久（留下）」两块，
   * 实证里永久占 30–40%。**不是重复收惩罚**：`impactOf` 是成交瞬间付出的全部代价，
   * 这里只把其中的这部分沉淀成行情位移，剩下的就是 AC 里的暂时冲击。
   */
  share: 0.35,
  /** Bouchaud propagator 的幂律指数 β ≈ 0.3（衰减极慢：100 小时后仍有 25%） */
  beta: 0.3,
  /**
   * 冲击池的**笔数上限**（C1，2026-09-29 拍板）。超出时把**最旧的那几笔**按「此刻的残存值」
   * 归并成一项 —— 它们的衰减最狠、残存最小，归并误差可忽略，而列表长度由此有了硬上界。
   * 8 笔足够覆盖「一次分 1/4 · 1/2 · 全平」这类连续操作，不至于把更早的痕迹抹掉。
   */
  listMax: 8,
  /**
   * 价格位移的**上侧硬夹**（B1，2026-09-29 拍板）：残存冲击最多把价格抬高 50%。
   *
   * ⚠️ 下侧本来就有天然边界 —— 价格不可能掉到 0 以下（夹在 −99%），**上侧原来完全没有**。
   *    池子里多笔同向冲击会叠加，`f = 1 + r` 可以一路涨上去（这正是「K 线缓升后平仓暴涨」的放大器之一）。
   * ⚠️ 50% 不是随手取的数：按 §27.5 的实测盘口深度，永久冲击做到 +50% 需要吃掉几乎整条盘口的挂单，
   *    现实里那已经是「一次性把深度扫空」的级别；再往上就不是这个模型该负责的事了。
   */
  riseMax: 0.5,
  /**
   * 平仓时的**返还款比例**（A2，2026-09-29 拍板）：只把「开仓方向当前残存的那部分」回填一半。
   *
   * ⚠️ 为什么是「按残存值」而不是「按开仓时的原值」：原值口径下，先写的那笔衰减得多、
   *    后写的反向笔衰减得少，两者不等 ⇒ 净值可能**翻到另一侧**（「平仓后弹得比原价还高」的过冲）。
   *    按**此刻残存值**取一半，新写的反向笔幅度 ≤ 同向残存值 ⇒ **过冲在数学上不可能发生**。
   * ⚠️ 为什么打对折而不是全额：实证里单笔 metaorder 的冲击**弛豫到峰值的约 2/3、约 1/3 永久留下**；
   *    而现实中反向成交要靠 TWAP 摊开好几天 —— **一笔市价平仓推不回全部**。见方案 §27.5 / §27.6.1。
   */
  giveBack: 0.5,
};

/** 衰减因子：`e` = 距写入时刻经过的**游戏小时数**。前 1 小时不衰减，之后按 e^(−β) 慢慢回爬 */
export function decay(e) {
  if (!(e > 1)) return 1;          // e ≤ 1（含 0 与负数）一律视为「刚开始」，不衰减
  return Math.pow(e, -SHOCK.beta);
}

/**
 * 某个币在**第 j 根**上残存的订单冲击量（0 = 没有冲击、j 早于写入时刻）。
 *
 * C1（2026-09-29）：池子由「单池」改成**逐笔的 propagator 列表** ——
 *   `residual(j) = Σ v_k × decay(j − at_k)`，这才是 Bouchaud 的叠加式。
 *   单池模型的毛病：分 10 笔买进去，第 2 笔会把第 1 笔的衰减进度**吃掉**
 *   （一笔 1 小时前的单和一笔 100 小时前的单被合并成「刚刚发生的一笔」）。
 */
export function residualAt(s, sym, j) {
  const list = s.flow && s.flow[sym];
  if (!list || !list.length) return 0;
  let v = 0;
  for (const p of list) {
    if (!p.v || j < p.at) continue;
    v += p.v * decay(j - p.at);
  }
  return v;
}

/**
 * 只统计**某个方向**（`dir` = +1 买 / −1 卖）在**第 j 根**还残存多少冲击 —— A2 返还款的基数。
 * 与 `residualAt` 同一个算法，只是先把反向的那些笔滤掉；返回值是**幅度**（恒 ≥ 0），
 * 不是带符号的值 —— 调用方只在「相反方向」上用它（`addFlow(-dir * back)`）。
 */
export function residualOfSide(s, sym, j, dir) {
  const list = s.flow && s.flow[sym];
  if (!list || !list.length) return 0;
  let v = 0;
  for (const p of list) {
    if (!p.v || j < p.at || p.v * dir <= 0) continue;
    v += p.v * decay(j - p.at);
  }
  return dir * v;
}

/**
 * 把一笔成交的永久冲击**追加**进池子（不再与旧值归并 —— 见 `residualAt`）。
 *
 * 超过 `SHOCK.listMax` 笔时，把最旧的那些按「此刻的残存值」压成一项（`collapse`）：
 * 它们在 `j = s.i` 处的值**精确守恒**，之后按「从此刻起算」的曲线衰减（略慢于真值，
 * 但都是残存最小的那几笔，误差可忽略），换来列表长度的硬上界。
 * @returns {boolean} 是否真的写进去了（Δ 为 0 时不写，避免无意义地刷存档）
 */
export function addFlow(s, sym, delta) {
  if (!Number.isFinite(delta) || delta === 0) return false;
  if (!s.flow) s.flow = {};
  const list = s.flow[sym] || (s.flow[sym] = []);
  list.push({ v: delta, at: s.i });
  if (list.length > SHOCK.listMax) collapse(list, s.i);
  return true;
}

/** 把最旧的若干笔压成一项（只在超出上限时调用；`now` = 当前的 `s.i`） */
function collapse(list, now) {
  const cut = list.length - (SHOCK.listMax - 1);
  let v = 0;
  for (let k = 0; k < cut; k++) {
    const p = list[k];
    if (now >= p.at) v += p.v * decay(now - p.at);
  }
  if (v === 0) list.splice(0, cut);
  else list.splice(0, cut, { v, at: now });
}

/**
 * 第 j 根的**价格位移系数** —— `market.candleAt` 唯一要乘的那个数。
 * 没有任何冲击时恒等于 1（⇒ 与数据包逐位相同）。
 *
 * **两侧同时夹**（B1，2026-09-29）：下侧 −99%（价格不能为负），上侧 `SHOCK.riseMax`。
 */
export function factorFor(s, sym, j) {
  const r = residualAt(s, sym, j);
  if (!r) return 1;

  const f = 1 + Math.min(SHOCK.riseMax, Math.max(-0.99, r));
  return f > 1e-9 ? f : 1e-9;
}

/* ───────────────────────── 上帝面板用的小工具 ───────────────────────── */

/**
 * 开启上帝模式（幂等：已开过就只补缺失的键）。
 * ⚠️ 只有「上次填的资金」这一个字段 —— 价格相关的键（`scale` / `mult`）已随 2026-09-29 的瘦身删除。
 */
export function enableGod(s) {
  s.god = { lastFill: s.god?.lastFill ?? 100000 };
  return s.god;
}