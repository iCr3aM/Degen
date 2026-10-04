/**
 * 历史压力位（ROADMAP §六十四，2026-10-02 用户拍板）
 * ===============================================================
 * 「不可见的订单簿模拟」的第三块 —— 前两块是 `god.js` 的位移层与 `impact.js` 的 L1 瞬时深度池：
 *   · `s.flow` 管「你这一笔砸出多大的坑」，逐根幂律衰减；
 *   · `POOL`    管「这一小时你还剩多少深度可吃」，按小时指数回补；
 *   · 本模块    管「前面那 30 天里哪些价位真的堆着货」—— 推价撞上去要被**吸收**掉一部分。
 *
 * 三条口径（用户 2026-10-02 三项裁决）：
 *   ① **只算不画**：不画线、不进面板、不存档，只影响玩家自己那笔位移的手感；
 *   ② 口径 = **成交量密集区 ＋ 摆动高低点**，两者按同一量纲加权堆进同一个价格直方图；
 *   ③ 回看窗口 = **近 30 天（720 根）** —— 与 `SLIP.window` 的 σ 窗口同尺度。
 *
 * ⚠️ **只吃原始行情**（`market.rawCloseAt` / `volumeAt`，不含任何价格位移）。
 *    改成含位移的话，「压力位」会把玩家自己砸出来的台阶也算成历史阻力，
 *    而且 `markPrice` 依赖 `factorFor` ⇒ 互相引用成环。用原始数据同时换来一条更好的性质：
 *    本模块是 `(sym, i)` 的**纯函数**，同一根 K 线上算多少次、在哪个槽里算，结果都一样。
 * ⚠️ **无前视**：只扫 `j ∈ [i − window, i)`，**不含**第 i 根自己（与新闻锚点同一条纪律）。
 * ⚠️ 红线 B 依旧：不改数据包、不加后端、不进存档 —— 全部现算。
 *
 * 分层与 `impact.js` 完全一致：`levelsFrom` / `absorbOf` 是**纯函数**（不碰状态、不碰 DOM、
 * 不读时钟，断言可以只喂两个数组），`levelsOf` 是唯一那个读数据包的薄适配层。
 */

import { rawCloseAt, volumeAt } from './market.js';

/**
 * 模型常数。**全部是合成取值**（史实检索拿不到「压力位吸收多少」这种表，同 `LIQ.fee` 的待遇）——
 * 只要方向对、量级可读即可，不追求一手出处。
 * ⚠️ 不导出（2026-10-04 审计 R23）：仅本模块内部用。
 */
const LEVELS = {
  window: 720,      // 回看根数 = 30 天（与 SLIP.window 同尺度）
  minBars: 60,      // 有效样本少于这个数 ⇒ 一条位都不给（开局头两天没有「历史」可言）
  bins: 36,         // 价格直方图的格数（对数刻度）
  swingK: 2,        // 摆动点的判定半径：左右各 k 根都比它低（高）才算
  swingW: 3,        // 摆动点的权重 = **该根自己成交量的 3 倍**（与成交量项同量纲）
  maxLevels: 6,     // 最多保留几条位（按权重降序；局部极大值本来就有限，这是硬兜底）
  width: 0.012,     // 相隔不到 1.2% 的位并成一条（免得给出几条挤在一起的「同一个位」）
  absorb: 0.55,     // 撞上时**最多**吸收掉的位移比例（保底还剩 45% 推得动，永不锁死）
};

/**
 * **历史压力位**（纯核心）—— 从一段时间序列里堆出价位直方图，取峰。
 *
 * 两个来源按同一量纲相加：
 *   - **成交量密集区**：每根按自己的成交量份额落进它所在的价格格（volume profile 的思路）；
 *   - **摆动高低点**：半径 `swingK` 内的局部极值，按 `swingW` 根平均量计入。
 *     为什么摆动点也要算：成交量最密的地方未必是「位」——前高 / 前低这类**价格结构**上的
 *     转折点常常落在量很薄的格子里，只有把它单独加一笔，那一格才会成为局部极大值。
 *
 * ⚠️ 刻意**不做**「成交量加权平均价」那种单点输出：压力位是**一组带权重的价位**，
 *    不是一条线。吸收量按权重和算，见 `absorbOf`。
 *
 * @param {number[]} closes 时间升序的收盘价（原始值，不含位移）；缺失 / 未上线用 `0` 或负数占位
 * @param {number[]} vols   与 `closes` 等长的成交量份额（0~1，见 `market.volumeAt`）
 * @returns {{p:number,w:number}[]} 按权重降序的位（`w` 已归一到 0~1，最重那条 = 1）；样本不足 ⇒ `[]`
 * ⚠️ 不导出（2026-10-04 审计 R23）：仅本模块 `levelCacheFor` 用，外部一律走缓存版。
 */
function levelsFrom(closes, vols) {
  const n = closes.length;

  /* ① 有效样本 ＋ 对数价格范围（对数刻度：$0.5 → $2 与 $5,000 → $20,000 该是同一格宽） */
  let lo = Infinity, hi = -Infinity, cnt = 0;
  for (let j = 0; j < n; j++) {
    const p = closes[j];
    if (!(p > 0)) continue;
    const l = Math.log(p);
    if (l < lo) lo = l;
    if (l > hi) hi = l;
    cnt++;
  }
  if (cnt < LEVELS.minBars) return [];
  const span = hi - lo;
  if (!(span > 0)) return [];                    // 价格一动没动 ⇒ 分不出「位」

  const step = span / LEVELS.bins;
  const binOf = p => Math.min(LEVELS.bins - 1, Math.max(0, Math.floor((Math.log(p) - lo) / step)));
  const w = new Array(LEVELS.bins).fill(0);

  /* ② 成交量密集区 */
  for (let j = 0; j < n; j++) {
    const p = closes[j];
    if (!(p > 0)) continue;
    w[binOf(p)] += vols[j] || 0;
  }

  /* ③ 摆动高低点 —— 权重按**该根自己**的量放大 `swingW` 倍，而不是按窗口平均量。
     为什么必须是「自己的量」：按平均量计的话，一个来回震荡的区间里**几乎每根都是摆动点**，
     几十根叠起来能超过整段窗口的成交量总和 ⇒ 成交量密集区被自己的噪声盖掉（断言 ① 实测就是这个）。
     按自己的量计有两个好性质：摆动项的总量恒 ≤ `swingW ×` 全窗口成交量（不会反客为主）；
     而且量越大的转折点越重，量近乎为零的「转折」自然无足轻重。 */
  const k = LEVELS.swingK;
  for (let j = k; j < n - k; j++) {
    const c = closes[j];
    if (!(c > 0)) continue;
    let isHigh = true, isLow = true;
    for (let d = 1; d <= k; d++) {
      const a = closes[j - d], b = closes[j + d];
      if (!(a > 0) || !(b > 0)) { isHigh = false; isLow = false; break; }   // 挨着洞 ⇒ 不算转折点
      if (!(c > a) || !(c > b)) isHigh = false;
      if (!(c < a) || !(c < b)) isLow = false;
    }
    if (isHigh || isLow) w[binOf(c)] += LEVELS.swingW * (vols[j] || 0);
  }

  /* ④ 取局部极大值（平台取右端，保证确定性），按权重降序；相隔不到 `width` 的并进更重的那条 */
  let argmax = 0;
  const peaks = [];
  for (let b = 0; b < LEVELS.bins; b++) {
    if (w[b] > w[argmax]) argmax = b;
    if (!(w[b] > 0)) continue;
    const left = b === 0 ? -Infinity : w[b - 1];
    const right = b === LEVELS.bins - 1 ? -Infinity : w[b + 1];
    if (w[b] >= left && w[b] > right) peaks.push(b);
  }
  if (!peaks.length) peaks.push(argmax);         // 整条直方图是平的（处处相等）⇒ 退回最高的那格
  peaks.sort((a, b) => w[b] - w[a]);

  const top = w[argmax] || 1;
  const out = [];
  for (const b of peaks) {
    const p = Math.exp(lo + (b + 0.5) * step);
    const hit = out.find(o => Math.abs(o.p - p) / p < LEVELS.width);
    if (hit) { hit.w = Math.min(1, hit.w + w[b] / top); continue; }   // 并进更重的那条
    if (out.length >= LEVELS.maxLevels) break;
    out.push({ p, w: Math.min(1, w[b] / top) });
  }
  return out;
}

/**
 * **吸收系数**（纯核心）—— 这一笔位移被沿途的压力位吃掉多少。
 *
 * 被扫到的位 = 落在 `(现价, 成交后价]` 这一段里的那些（卖单镜像：`[成交后价, 现价)`）。
 * 权重和越大吸得越狠，上限 `LEVELS.absorb`。
 *
 * 两个刻意留下的性质：
 *   - **撞穿之后就没有阻力了** —— 位一旦落到现价下方，下一次推价就扫不到它。
 *     价格「破了就上去了」，不需要额外的「突破」状态机，也不用记任何状态；
 *   - **永远推得动** —— 吸收上限 0.55 ⇒ 保底还剩 45% 的位移，不会出现「撞上就完全卡死」。
 *
 * @param {{p:number,w:number}[]} levels `levelsFrom` 的输出
 * @param {number} p      成交**前**的价（标记价，含玩家已造成的位移）
 * @param {number} dir    **+1 = 买**（推高）、**−1 = 卖**（压低）
 * @param {number} impact 本笔的原始冲击（`permImpactOf` 的结果，恒 ≥ 0）
 * @returns {number} 0.45 ~ 1 的乘数；没扫到位 / 参数不可用 ⇒ **恰好 1**（乘法恒等，逐位不变）
 */
export function absorbOf(levels, p, dir, impact) {
  if (!(impact > 0) || !(p > 0) || !dir || !levels || !levels.length) return 1;
  const target = p * (1 + dir * impact);
  const lo = Math.min(p, target);
  const hi = Math.max(p, target);
  let sum = 0;
  for (const L of levels) if (L.p > lo && L.p <= hi) sum += L.w;
  if (!(sum > 0)) return 1;
  return 1 - LEVELS.absorb * Math.min(1, sum);
}

/**
 * 某个币**此刻**的历史压力位 —— 唯一的薄适配层：把近 `window` 根原始行情读成两个数组，
 * 交给纯核心 `levelsFrom`。
 *
 * ⚠️ 只在**成交那一刻**调用（一笔一次，约 720×2 次读取），不进任何每帧路径 ——
 *    与「不画线」是同一条考虑：它不该出现在热路径上。
 * @returns {{p:number,w:number}[]} 未加载 / 样本不足 ⇒ `[]`
 */
export function levelsOf(sym, i) {
  /* ⚠️ **不夹 0** —— 与 `engine.dailySigma` 同一条口径：BTC 的数据左端是 −2304（2012-09-27 起的
     96 天真实小时线回溯段，游戏开局那一屏 K 线上画的就是它），夹 0 会让「前面 30 天有哪些位」
     在开盘头一个月里凭空少掉一截。窗口外的根由 `rawCloseAt` 返回 null ⇒ 当**洞**处理，
     所以还没上线 / 开局前的币（如 SOL 解锁头几十根）自然被 `minBars` 挡成「无位」。 */
  const from = i - LEVELS.window;
  const closes = new Array(LEVELS.window);
  const vols = new Array(LEVELS.window);
  for (let j = 0; j < LEVELS.window; j++) {
    closes[j] = rawCloseAt(sym, from + j) || 0;
    vols[j] = volumeAt(sym, from + j);
  }
  return levelsFrom(closes, vols);
}
