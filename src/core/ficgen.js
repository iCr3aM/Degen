/**
 * 架空行情生成器（2026-10-10 · 架空模式 P2 · 方案 A）
 * ===============================================================
 * 「上帝·架空」世界线的**唯一真相源** —— 从 2013-01-01 起，五个币的全部小时 K 线由它合成，
 * 可一路铺到 **2033-12-31**。同一 `(seed, FIC_VER)` 永远生成**逐位一致**的世界线 ⇒
 * 存档**不存 K 线**（读档重算），`rewindTo` 天然安全。
 *
 * ── 数学骨架（文献 → 工程映射，spec §4.1）────────────────────────────
 *   收益分布     Student-t 创新（ν≈3）           Mandelbrot 1963 / Fama 1965 / Cont 2001
 *   波动聚集     GARCH(1,1)，α+β=0.98            Engle 1982 / Bollerslev 1986 / Katsiampa 2017
 *   杠杆效应     不对称项 ≈ 0（加密弱且常反号）   Takaishi 2021
 *   牛熊体制     Markov 两体制（期望逗留 1.75 年）Hamilton 1989；**不硬编码减半日历**
 *   插针/崩盘    Kou 双指数跳跃                   Merton 1976 / Kou 2002 / Johansen 2004
 *   多币种       共同加密因子 ＋ β 载荷           IMF WP 2023/163《The Crypto Cycle》
 *   量价同源     隐藏强度同时缩放 σ 与量均值      Clark 1973；EJF 2025（完整 MDH 在加密不成立）
 *
 * ── 参数从哪来（tools/calib-fic.mjs 实测 public/data/*.bin，2026-10-10）────
 *   年化波动 	   BTC 92% / ETH 188% / XRP 455% / DOGE 227% / SOL 132%
 *   年代波动曲线   BTC 146/65/109/73/76/48%（2013–14 … 2023–24）→ `volScale(year)` 拟合
 *   峰度/尾部       峰度 20–3150、Hill 尾部指数 <1（小时线非平稳 ⇒ 取文献 ν≈3 为上界估计）
 *   GARCH          ARCH(1) acf=0.46（被体制非平稳抬高）⇒ 取文献标准 α+β=0.98
 *   插针           BTC 频率 0.274%/根、均值 5.85%、极值 34.7% → 跳跃 λ 与幅度
 *   山寨 β         对 BTC 回归：ETH 0.81 / XRP 0.83 / DOGE 1.00 / SOL 1.28（**非** spec 臆测的 1.5–3）
 *   日流动性       年代增长曲线（BTC 2013 6.6e6 → 2021 1.3e10 → 2024 8.6e9 美元/天）＋ 份额
 *   最大回撤       84.9%–96.8%（12 年）→ 体制波动比与段长
 *
 * ⚠️ **改本文件任何参数必须把 `FIC_VER` +1** —— 旧架空档 `ficVer` 不符即提示重开，
 *    与 `STATE_VERSION` 同一条纪律。
 * ⚠️ 本模块**纯 ESM + 零外部依赖**（除 config），可在 Node 侧直接 import 做断言。
 */

import { COINS, GAME, HOUR_MS, ficEndIndex } from './config.js';

/** 生成器版本号 —— **改参数必须 +1**（见文件头）
 *  v2（2026-10-10）：中位世界线抬到史实量级、回撤收浅（`bullDrift`/`bearDrift`/饱和项）。
 *  v3（2026-10-11 · 用户复盘「山寨回撤太深、低位抬到约中位一半」）：
 *    ① 长期成长由**随机累积**改为**确定性潜力线** `T(i)` ＋ **有界牛熊周期偏移** `off(i)`
 *       （各世界差在路径、不差在终点）⇒ 2024 的 p5 由「中位的 3%」抬到「约中位的一半」；
 *    ② 逐币 `volRatio`/`beta` 改用**近年代（2021–2024）**实测（全期值与 `volScale` 年代项重复计价，
 *       把山寨回撤推到 −99%）⇒ 山寨回撤明显收浅。
 *  v4（2026-10-11 · 用户拍板「把潜力线加回一个有界的随机乘子，但低点不要太低」）：
 *    潜力线之上叠一枚**世界价格档** `uWorld`（低/中/高，档内按 seed 随机，±0.30 有界）——
 *    世界整体价位 ×e^u；玩家在上帝面板（**仅架空**）三枚按钮里选，选后从头开一局。
 *    旧架空档（FIC_VER ≤ 3）读档时提示重开。 */
export const FIC_VER = 4;

/* 终点 `ficEndIndex()` 与 `FIC_END` 的唯一真源在 `config.js`（2026-10-10 · 架空 P2）——
   这里只**透传**，免得两处 2034-01-01 走岔。 */
export { ficEndIndex, FIC_END } from './config.js';

const HOURS_PER_YEAR = 24 * 365.25;

/* ── 全局参数（出处见文件头；2026-10-10 实测）────────────────────────── */
const P = {
  baseAnnVol: 0.92,      // BTC 基准年化波动（实测全期）
  alpha: 0.10,           // GARCH(1,1) α（文献标准，α+β=0.98）
  beta: 0.88,            // GARCH(1,1) β
  nu: 3.0,               // Student-t 自由度（文献 ν≈3–4，实测尾部更厚 ⇒ 取下沿）
  jumpP: 0.0027,         // 每小时跳跃概率（实测 BTC 插针频率 0.274%）
  jumpMean: 0.0585,      // 跳跃幅度均值（实测 5.85%）
  jumpDownP: 0.50,       // 跳跃向下的比例（上下更均衡 —— v2 调参，原 0.52）
  regimeVolBull: 0.85,   // 牛市波动乘子
  regimeVolBear: 1.0,    // 熊市波动乘子（v2：原 1.35 → 1.15 → 1.0，收两档让回撤变浅）
  bullMeanYears: 2.2,    // 牛市期望逗留
  bearMeanYears: 0.75,   // 熊市期望逗留（熊更短，回撤收浅）
  regimeMinYears: 0.2,   // 体制最短逗留
  /* ── v3（2026-10-11 · 用户复盘：「山寨回撤太深」「低位抬到约中位一半」）────────────
     把「长期成长」从**随机累积**改成**确定性潜力线** `T(i)`（所有世界共用一条），
     牛熊改成**有界的周期偏移**（围绕潜力线上下摆动）。于是各世界差在「路径」
     （哪年牛、哪年熊、插针分布、波动聚集），**不差在终点** ⇒ 低位被抬起来、
     深回撤也被收浅；同时 `T(i)` 与 `off(i)` 都是 `i` 的确定性函数，纯函数性不变。
     ⚠️ 旧参数 `bullDrift` / `bearDrift` 由此退役（它们的职责一分为二：`targetDrift` 管终点、
     `bullOff`/`bearOff` 管周期）。 */
  targetDrift: 1.12,     // 潜力线年化对数增速（乘 `growthScale(y)` 与 `sat`；v3 按「2024 中位 ≈ $93K」定标）
  bullOff: 0.35,         // 牛市周期偏移（对数）—— 牛市中价格高于潜力线
  bearOff: -0.25,        // 熊市周期偏移（对数）—— 熊浅，回撤因此收浅
  offSmoothDays: 45,     // 周期偏移的 EMA 平滑窗口（天）—— 避免牛熊切换处出现台阶
  /* **潜力线饱和**（v2 引入）：成长随价格递减 —— 市场越成熟、市值越大越难翻倍。
     形式 `1/(1+(P/Psat)^k)`，早期 P≪Psat ⇒ sat≈1（不影响 2013 起步段），逼近 Psat 后收敛 ⇒ 软上限。 */
  satPrice: 400000,      // 饱和价位（美元）
  satExp: 2.0,           // 饱和陡度
  /* **世界价格档**（2026-10-11 · 用户拍板）：潜力线之上再叠一枚**有界随机乘子** ——
     每个世界在「低 / 中 / 高」三档区间里各抽一个对数偏移 `u`（仍由 seed 决定 ⇒ 纯函数性不变），
     世界整体价位 = `e^u`（上线价与 2024-12 锚**一起**缩放，形状不变）。
     ⚠️ 区间**刻意收紧**（±0.30 ≈ ×0.74～×1.35）：用户要求「低点不要太低」——
     叠加原本的 OU 偏离后，低位仍在「中位的一半」量级，不会退回「中位的 3%」。 */
  tierU: { low: [-0.30, -0.10], mid: [-0.10, 0.10], high: [0.10, 0.30] },
  defaultTier: 'mid',    // 未指定档位时的默认（如从上帝卡直接开一局）
  /* 对数价格向**潜力线**回归的速率（OU）—— 它决定「路径偏离的幅度」：
     半衰期越短 ⇒ 价格越贴潜力线 ⇒ 分布越窄（低位抬高、回撤收浅）。
     v3：0.75 → 0.50 年（配合有界周期偏移，把 2024 的 p5 抬到约中位的一半）。 */
  revertHalfYears: 0.50,
};

/* ── 逐币参数（v3：波动/β 用**近年代 2021–2024**，长期水平用**真实首末价**，见 calib-fic.mjs）────
 * ① `volRatio`/`beta`/`idio` 取近年代实测（全期值与 `volScale(y)` 年代项重复计价，会把山寨回撤推到 −99%）：
 *    实测 2021–2024 年化波动 BTC 64% / DOGE 147% / XRP 106% / ETH 80% / SOL 126%；
 *    β：ETH 1.07 / XRP 1.00 / DOGE 1.17 / SOL 1.28；`idio = √(volRatio² − β²)`。
 * ② `genesis`/`last2024` 是数据包里的**真实首末收盘**（`public/data/index.json` 的 `first`/`last`）——
 *    潜力线据此**定标**：每个币上线价锚在真实首价、2024-12-31 锚在真实末价（中位世界 ≈ 史实量级），
 *    两端之间的**形状**由市场潜力线 `T(i)` 与各币的长期成长载荷 `L` 决定（L 在运行时反解）。
 *    ⚠️ 长期水平**不能**沿用小时 β（那是短周期联动）：真实数据里山寨自上线起的对数涨幅**高于** BTC 同期
 *       （ETH 1.21× / XRP 1.16× / DOGE 1.08× / SOL 2.01×），故 L 单独反解，与 `beta` 各管一段。
 * ③ `scale` = 物化编码的整数缩放（10 的幂，与真实包同口径）。 */
const COIN_PARAMS = {
  BTC:  { volRatio: 1.00, beta: 1.00, idio: 0.000, genesis: 12.20,    last2024: 93576,   scale: 1e2 },
  ETH:  { volRatio: 1.26, beta: 1.07, idio: 0.669, genesis: 3.00,     last2024: 3337.78, scale: 1e2 },
  XRP:  { volRatio: 1.66, beta: 1.00, idio: 1.319, genesis: 0.0053754, last2024: 2.0836, scale: 1e4 },
  DOGE: { volRatio: 2.31, beta: 1.17, idio: 1.991, genesis: 0.00188943, last2024: 0.316, scale: 1e6 },
  SOL:  { volRatio: 1.98, beta: 1.28, idio: 1.510, genesis: 2.9515,   last2024: 189.31,  scale: 1e2 },
};

/* 日流动性年代曲线（BTC 美元/天，实测中位；2025 起为平滑外推 —— 架空世界的合理延展） */
const LIQ_YEARS = [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034];
const LIQ_BTC = [6.6e6, 2.04e7, 2.39e7, 3.73e7, 2.41e8, 1.52e9, 3.52e9, 6.42e9, 1.31e10, 6.32e9, 2.95e9, 8.60e9, 9.5e9, 1.05e10, 1.15e10, 1.25e10, 1.35e10, 1.45e10, 1.55e10, 1.65e10, 1.75e10, 1.85e10];
/* 各币流动性份额（2021–2024 实测中位 ÷ BTC） */
const LIQ_SHARE = { BTC: 1.0, ETH: 0.50, XRP: 0.05, DOGE: 0.02, SOL: 0.05 };

/* ═══════════════ 确定性 RNG（无状态哈希 —— 随机数只依赖坐标，不依赖访问顺序）═══════════════ */

function h32(x) {
  x = x | 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** 均匀 [0,1)：坐标 (seed, a, b, c) 唯一决定 —— 与生成顺序无关 */
function rnd(seed, a, b, c) {
  let x = h32(Math.imul(seed | 0, 0x9e3779b1) ^ (a | 0));
  x = h32(x ^ Math.imul(b | 0, 0x85ebca77));
  x = h32(x ^ Math.imul(c | 0, 0xc2b2ae3d));
  return x / 4294967296;
}

/** 标准正态（Box–Muller） */
function norm(seed, a, b, s) {
  const u1 = Math.max(1e-12, rnd(seed, a, b, s));
  const u2 = rnd(seed, a, b, s ^ 0x9e37);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Student-t(ν) 的**单位方差**实现 —— 正态 ÷ √(χ²_ν/ν)，χ² 由 ν 个标准正态平方和**真实抽样**。
 *  ⚠️ 不用 Wilson–Hilferty 近似：它偶发返回 ~0 的 χ² ⇒ t 值天文数字 ⇒ 价格爆炸（实测踩过）。
 *  ⚠️ 末尾再除以 √(ν/(ν−2)) 把方差归一到 1：GARCH 的平稳条件 `α·E[z²]+β<1` 依赖 `E[z²]=1`。 */
function tDraw(seed, a, b, s, nu) {
  const z = norm(seed, a, b, s);
  const k = Math.round(nu);
  let chi2 = 0;
  for (let j = 0; j < k; j++) { const v = norm(seed, a, b, s + 101 * (j + 1)); chi2 += v * v; }
  return z / Math.sqrt(Math.max(1e-9, chi2 / k)) / Math.sqrt(k / (k - 2));
}

/* ═══════════════ 年代曲线（体制漂移 / 波动 / 流动性）═══════════════ */

/** 第 i 根的**浮点年份**（2013.0 起） */
const yearOf = i => 2013 + i / HOURS_PER_YEAR;

/** 波动成熟度：实测 BTC 年化 146→48% 的下降趋势（2026-10-10 拟合），2033 后回落到 40% 地板 */
const volScale = y => Math.max(0.40, 1.55 * Math.exp(-0.09 * (y - 2013)));

/** 漂移成熟度：市场越成熟、期望收益越低（2033 后 30% 地板） */
const growthScale = y => Math.max(0.30, Math.exp(-0.05 * (y - 2013)));

/** 日流动性年代曲线（BTC）—— 线性插值 + 端点夹取 */
function liqCurveBTC(dayIndex) {
  const y = 2013 + dayIndex / 365.25;
  if (y <= LIQ_YEARS[0]) return LIQ_BTC[0];
  const last = LIQ_YEARS.length - 1;
  if (y >= LIQ_YEARS[last]) return LIQ_BTC[last];
  const k = Math.floor(y - LIQ_YEARS[0]);
  const t = y - LIQ_YEARS[0] - k;
  return LIQ_BTC[k] + (LIQ_BTC[k + 1] - LIQ_BTC[k]) * t;
}

/* ═══════════════ 体制链（Markov 两体制）═══════════════ */

/** 由 seed 抽一条覆盖 [0, endI) 的体制段序列 —— **非对称两态 Markov**：
 *  牛市期望逗留 2.2 年、熊市 0.9 年 ⇒ 牛熊时间占比 ≈ 71% : 29%（贴合「牛长熊短」的经验事实）。 */
function buildRegimes(seed, endI) {
  const segs = [];
  const minH = P.regimeMinYears * HOURS_PER_YEAR;
  const meanH = [P.bullMeanYears * HOURS_PER_YEAR, P.bearMeanYears * HOURS_PER_YEAR];
  let i = 0;
  let regime = rnd(seed, 0x52, 0, 0) < 0.71 ? 0 : 1;   // 0 = 牛、1 = 熊
  let k = 0;
  while (i < endI) {
    const u = Math.max(1e-9, rnd(seed, 0x52, 1, k));
    const dur = Math.max(minH, -meanH[regime] * Math.log(u));
    const end = Math.min(endI, Math.round(i + dur));
    segs.push({ start: i, end, regime });
    i = end;
    regime = 1 - regime;
    k++;
  }
  return segs;
}

/* ═══════════════ 主生成 ═══════════════ */

/**
 * 生成一整条架空世界线（纯函数）。
 * @param {number} seed uint32 世界线种子（`s.ficSeed`）
 * @returns {{ series: Map<string,{ints:Int32Array,vol:Uint8Array}>, coins: Object, liq: {buf:Float32Array,meta:Object} }}
 *   `coins` / `liq.meta` 的形状与 `public/data/index.json` 的 `coins` / `liq` **逐字段对齐**，
 *   直接覆写 `manifest` 后，`market.js` 的 `rangeOf` / `decodeAt` / `liqOf` 全部照旧工作。
 */
export function generateWorld(seed, tier = P.defaultTier) {
  const endI = ficEndIndex();
  const regimes = buildRegimes(seed, endI);

  /* **世界价格档**（低/中/高）—— 在该档区间里按 seed 抽一个对数偏移，全世界价位整体 ×e^u。
     ⚠️ 它只缩放水平、不动形状：上线价与 2024-12 锚一起走，OU / 周期偏移 / 波动全部不变。 */
  const tierKey = P.tierU[tier] ? tier : P.defaultTier;
  const [ulo, uhi] = P.tierU[tierKey];
  const tierIdx = Object.keys(P.tierU).indexOf(tierKey);
  const uWorld = ulo + (uhi - ulo) * rnd(seed, 0xab, tierIdx + 1, 5);

  /* 逐根体制数组（0 牛 / 1 熊）—— 两条生成回路共用，避免共享指针被推到头 */
  const regimeArr = new Uint8Array(endI);
  for (const seg of regimes) regimeArr.fill(seg.regime, seg.start, seg.end);

  /* 全局确定性噪声：BTC 因子与各币特异项都由 (seed, coinIdx, i, stream) 唯一决定 */
  const btcIdx = COINS.findIndex(c => c.sym === 'BTC');
  const longVar = Math.pow(P.baseAnnVol / Math.sqrt(HOURS_PER_YEAR), 2);
  const omega = longVar * (1 - P.alpha - P.beta);
  /** 对数价格回归速率（每小时）—— 半衰期 `revertHalfYears` 年 */
  const kappa = Math.log(2) / (P.revertHalfYears * HOURS_PER_YEAR);

  /* ═══════════════ ① 世界潜力线 T(i)（确定性 · 所有世界共用）═══════════════ */

  /** 对数潜力线：从幼稚价起步，按 `targetDrift × growthScale(y) × sat` 逐年收敛（见 `P.satPrice` 注） */
  const Tarr = new Float64Array(endI);
  {
    let T = Math.log(COIN_PARAMS.BTC.genesis);
    for (let i = 0; i < endI; i++) {
      const sat = 1 / (1 + Math.pow(Math.exp(T) / P.satPrice, P.satExp));
      T += P.targetDrift * growthScale(yearOf(i)) / HOURS_PER_YEAR * sat;
      Tarr[i] = T;
    }
  }

  /* ═══════════════ ② 牛熊周期偏移 off(i)（有界 · 时序由种子定）═══════════════
   * 牛熊不再是「长期水平差」（那会把世界的终点拉开），而是**围绕潜力线的上下摆动**：
   * 牛市段 +`bullOff`、熊市段 +`bearOff`（负），并在段的边界做 EMA 平滑（避免台阶）。
   * 起点归零 ⇒ 每个世界都从 $13 那一根开盘。 */
  const offArr = new Float64Array(endI);
  {
    const a = 1 - Math.exp(-1 / (P.offSmoothDays * 24));
    const raw0 = regimeArr[0] === 0 ? P.bullOff : P.bearOff;
    let s = raw0;
    for (let i = 0; i < endI; i++) {
      s += ((regimeArr[i] === 0 ? P.bullOff : P.bearOff) - s) * a;
      offArr[i] = s - raw0;
    }
  }

  /* ═══════════════ ③ BTC 因子（**纯 innovation**，不含任何漂移）═══════════════ */
  let s2f = longVar, eps2f = longVar;
  const fac = new Float64Array(endI);
  for (let i = 0; i < endI; i++) {
    s2f = omega + P.alpha * eps2f + P.beta * s2f;
    /* 防爆护栏：t(3) 尾部极厚，GARCH 状态偶发被顶到极端值后要能**衰减回来**；夹在合理倍数内。 */
    if (s2f > longVar * 40) s2f = longVar * 40;
    if (s2f < longVar * 0.05) s2f = longVar * 0.05;
    const z = tDraw(seed, btcIdx, i, 11, P.nu);
    const eps = Math.sqrt(s2f) * z;
    eps2f = eps * eps;
    const reg = regimeArr[i];
    const volM = (reg === 0 ? P.regimeVolBull : P.regimeVolBear) * volScale(yearOf(i));
    let jump = 0;
    if (rnd(seed, btcIdx, i, 23) < P.jumpP) {
      const down = rnd(seed, btcIdx, i, 29) < P.jumpDownP;
      const amp = -Math.log(Math.max(1e-9, rnd(seed, btcIdx, i, 31))) * P.jumpMean;
      jump = (down ? -1 : 1) * amp;
    }
    /* 单根 ±60% 上限（现实里最极端的插针也在其内）—— 纯护栏，正常时段不触发 */
    const rr = volM * eps + jump;
    fac[i] = rr > 0.6 ? 0.6 : rr < -0.6 ? -0.6 : rr;
  }

  /* 逐币生成 OHLC ＋ 成交量 */
  const series = new Map();
  const coins = {};
  const liqDays = Math.floor(endI / 24) + 1;
  const liqOrder = COINS.map(c => c.sym);
  const liqBuf = new Float32Array(liqDays * liqOrder.length);

  for (const coin of COINS) {
    const pi = COINS.indexOf(coin);
    const par = COIN_PARAMS[coin.sym];
    /* 世界线从 2013-01-01 起；币的上线晚于它 ⇒ 从 unlock 那根开始铺（与真实包同口径） */
    const g0 = Math.max(0, Math.round((coin.unlock - GAME.start) / HOUR_MS));
    const start = GAME.start + g0 * HOUR_MS;
    const count = endI - g0;
    const ints = new Int32Array(count * 4);
    const vol = new Uint8Array(count);

    let lnP = Math.log(par.genesis) + uWorld;   // 世界价格档：上线价整体 ×e^u（锚与形状一起走）
    const Tg = Tarr[g0] + offArr[g0];        // 该币**上线那一刻**的潜力线（周期偏移在此归零）
    /* **长期成长载荷 L**：把市场潜力线的增量按比例搬到本币，使得「2024-12-31 的靶心 = 真实末价」。
       两端锚定 ⇒ 中位世界在上市那年与 2024 年末都落在真实量级上，中间是市场潜力线的形状。 */
    const Y24 = Math.round((Date.UTC(2024, 11, 31, 23) - GAME.start) / HOUR_MS);
    const L = Math.log(par.last2024 / par.genesis) / Math.max(1e-6, (Tarr[Math.min(Y24, endI - 1)] + offArr[Math.min(Y24, endI - 1)]) - Tg);
    /* ⚠️ 币的 GARCH 状态是**基准方差单位**（与 BTC 同尺度）—— 币的相对波动由 `idio` 系数承载。 */
    let s2c = longVar;
    let eps2c = longVar;
    /* 成交量：日历日内先攒原始强度，日末归一化成份额（与真实包同口径） */
    const dayRaw = new Float64Array(24);
    let dayId = -1, dayFill = 0, dayStartK = 0;
    /* 隐藏强度（对数正态 AR(1)，均值≈1）—— 量价同源 */
    let logAct = 0;

    for (let k = 0; k < count; k++) {
      const i = g0 + k;
      const reg = regimeArr[i];
      const volM = (reg === 0 ? P.regimeVolBull : P.regimeVolBear) * volScale(yearOf(i));

      /* 该币的**潜力靶心**：上线价 × L·(市场潜力线 ＋ 周期偏移) 的增量（L 见上方注释）
         ＋ 世界价格档偏移 `uWorld`（低/中/高 —— 整体水平，不动形状） */
      const target = Math.log(par.genesis) + uWorld + L * ((Tarr[i] + offArr[i]) - Tg);

      let idio = 0;
      if (par.idio > 0) {
        s2c = omega + P.alpha * eps2c + P.beta * s2c;
        if (s2c > longVar * 40) s2c = longVar * 40;
        if (s2c < longVar * 0.05) s2c = longVar * 0.05;
        const zc = tDraw(seed, pi, i, 41, P.nu);
        const ec = Math.sqrt(s2c) * zc;
        eps2c = ec * ec;
        idio = par.idio * volM * ec;
      }
      let jumpC = 0;
      if (rnd(seed, pi, i, 53) < P.jumpP) {
        const down = rnd(seed, pi, i, 59) < P.jumpDownP;
        const amp = -Math.log(Math.max(1e-9, rnd(seed, pi, i, 61))) * P.jumpMean * par.volRatio;
        jumpC = (down ? -1 : 1) * amp;
      }
      /* 该币收益 = **潜力线的前向增量（feed-forward）** ＋ **向靶心的 OU 纠偏** ＋ β·市场 innovation
         ＋ 自身特异项 ＋ 自身跳跃。
         ⚠️ 前向增量不能省：只靠 OU 追一条**在增长**的靶心会留下系统性滞后（实测 −30%，
            `E[dev] = −(d靶心/dt)/κ`）—— 加上前向项后价格零滞后地贴着潜力线走。 */
      const j = i + 1 < endI ? i + 1 : i;
      const dTgt = L * ((Tarr[j] + offArr[j]) - (Tarr[i] + offArr[i]));
      const rcRaw = dTgt + kappa * (target - lnP) + par.beta * fac[i] + idio + jumpC;
      const rc = rcRaw > 0.7 ? 0.7 : rcRaw < -0.7 ? -0.7 : rcRaw;

      /* 隐藏强度：AR(1)，与「本小时的绝对收益」同向（量价同源） */
      logAct = 0.82 * logAct + 0.30 * norm(seed, pi, i, 71);
      const act = Math.min(6, Math.exp(logAct));

      const o = Math.exp(lnP);
      const lnNext = lnP + rc;
      /* 价格地板 = 2 个编码量子（保证编码非零）／天花板 = 1.8e9 ÷ scale（保证 Int32 不溢出）。
         ⚠️ 天花板是**编码护栏**，不是价格模型的一部分 —— 只在极端世界线的尾部生效。 */
      const floor = 2 / par.scale;
      const capLog = Math.log(1.8e9 / par.scale);
      const lnClamped = Math.max(Math.log(floor), Math.min(capLog, lnNext));
      const c = Math.exp(lnClamped);
      /* 小时内影线：由 σ·act 抽一段外扩路径（含插针带宽） */
      const sigH = Math.sqrt(s2c) * volM * act;
      const wu = sigH * Math.abs(norm(seed, pi, i, 83)) * 0.9;
      const wd = sigH * Math.abs(norm(seed, pi, i, 89)) * 0.9;
      const up = Math.max(o, c), dn = Math.min(o, c);
      const h = up * Math.exp(wu);
      const l = dn * Math.exp(-wd);
      lnP = lnClamped;

      const sc = par.scale;
      const base = k * 4;
      /* 编码护栏：夹进 Int32 安全区，防止极端世界线把整数溢出成负数（现实价位不会触及） */
      const enc = v => { const n = Math.round(v * sc); return n > 2147483000 ? 2147483000 : n < -2147483000 ? -2147483000 : n; };
      ints[base] = enc(o);
      ints[base + 1] = enc(h - o);
      ints[base + 2] = enc(l - o);
      ints[base + 3] = enc(c - o);

      /* 原始量强度：隐藏强度 × 日内 U 形 × 年代增长 × 随机扰动 */
      const hourOfDay = ((i % 24) + 24) % 24;
      const u = 0.7 + 0.6 * Math.cos((2 * Math.PI * (hourOfDay - 15)) / 24);
      const grow = liqCurveBTC(Math.floor(i / 24)) / liqCurveBTC(0);
      const raw = act * u * Math.pow(grow, 0.5) * Math.exp(0.5 * norm(seed, pi, i, 97));
      const d = Math.floor(i / 24);
      if (d !== dayId) {
        flushDay(vol, dayRaw, dayFill, dayStartK);
        dayId = d; dayFill = 0; dayStartK = k;
      }
      dayRaw[dayFill++] = raw;
    }
    flushDay(vol, dayRaw, dayFill, dayStartK);

    series.set(coin.sym, { ints, vol });
    coins[coin.sym] = { name: coin.name, file: null, start, count, scale: par.scale, vol: true };
  }

  /* 日流动性：年代曲线 × 币种份额 × 逐日扰动 */
  for (let n = 0; n < liqOrder.length; n++) {
    const sym = liqOrder[n];
    const share = LIQ_SHARE[sym] ?? 0.05;
    for (let d = 0; d < liqDays; d++) {
      const base = liqCurveBTC(d) * share;
      const jitter = Math.exp(0.35 * norm(seed, 0x77 + n, d, 101));
      const v = base * jitter;
      const num = Math.min(2.1e9, Math.max(0, v));
      liqBuf[n * liqDays + d] = num;
    }
  }

  return {
    series,
    coins,
    liq: { buf: liqBuf, meta: { file: null, days: liqDays, preDays: 0, order: liqOrder } },
  };
}

/** 把一个日历日的原始量强度归一化成份额（0–255）写进 `vol`（`baseK` = 该日第一根在 `vol` 里的下标）*/
function flushDay(vol, dayRaw, fill, baseK) {
  if (fill <= 0) return;
  let sum = 0;
  for (let j = 0; j < fill; j++) sum += dayRaw[j];
  if (sum <= 0) return;
  for (let j = 0; j < fill; j++) {
    vol[baseK + j] = Math.min(255, Math.round((dayRaw[j] / sum) * 255));
  }
}

/* ═══════════════ 自检（仅测试用）═══════════════ */

/** 生成序列的收盘价数组（测试对照用）—— 与 ficgen 的解码口径一致 */
export function closesOf(res, sym) {
  const rec = res.series.get(sym);
  if (!rec) return [];
  const sc = res.coins[sym].scale;
  const out = [];
  for (let k = 0; k < rec.ints.length / 4; k++) {
    const o = rec.ints[k * 4] / sc;
    out.push(o + rec.ints[k * 4 + 3] / sc);
  }
  return out;
}

export const FIC_PARAMS = P;
export const FIC_COIN_PARAMS = COIN_PARAMS;