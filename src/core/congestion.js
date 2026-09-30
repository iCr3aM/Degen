/**
 * 链上拥堵与转账到账（GDD §6 / §20-11，P2-A）
 * ===============================================================
 * 拥堵指数（0–100）是三个量叠出来的：
 *   ① **年代基础值** —— 年份的纯函数。⚠️ 这是**合成模型**，不是史实数据：
 *      GDD §6.4 只写「根据年份设定」、没给数字，这张表是本项目定的。
 *   ② **历史锚点加成** —— 真实拥堵窗口的抬升。**表在 `anchors.js`**（P2-C 起唯一真相源）：
 *      2017-05 / 2017-12 / 2021-04 三条 ＋ P2-C 补的 2015-07 / 2023-05 / 2024-04 三条。
 *   ③ **玩家脉冲** —— 你自己的大额转账把链挤了，48 游戏小时内线性衰减。这是 P2-A 的全部玩法：
 *      §6.5 那个「利用拥堵套利」在单机里没有对手，所以改成**反噬自己**。
 *
 * ⚠️ ①② 都是 `s.i` 的**纯函数**，不写进存档；只有 ③ 需要存（`s.pulse`）。
 * ⚠️ 到账时间只用**一套**口径：ROADMAP §五 P2-A 的 W 表（史实 Average 的 p50–p75 一侧）。
 *    GDD §6.2 / §6.3 / §6.4 里并存着三套数字，收敛到 §6.4 —— 详见 ROADMAP 的「三个写明不建模的史实」。
 * ⚠️ 拥堵 ↔ 成交额**不相关**（实测倍数 0.58×–1.22×）。日流动性（`market.liqOf`）只做
 *    「多大算大额转账」的分母，**不能**当成拥堵的代理 —— 两者在这个模块里是两个独立的量。
 */

import { GAME, HOUR_MS } from './config.js';
import { dayIndexOf, liqOf } from './market.js';
import { congestionAnchors } from './anchors.js';

const DAY_MS = 24 * HOUR_MS;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ───────────────── ① 年代基础值（合成模型） ───────────────── */

/**
 * 2013 → 2024 逐年基础拥堵。2017 与 2021 抬高是 ICO 狂潮与牛市高峰，
 * 2023–24 抬高是 Ordinals 铭文潮；其余年份只是让曲线平滑。
 * 表外的年份夹到两端（本作时间轴是闭区间 2013–2024，取不到表外，留个兜底而已）。
 */
const YEAR_BASE = [5, 5, 8, 12, 20, 15, 18, 14, 22, 12, 15, 18];

const baseOfYear = y => YEAR_BASE[clamp(y, 2013, 2024) - 2013];

/* ───────────────── ② 历史锚点加成 ───────────────── */

/**
 * 窗口表**不在这里** —— 唯一真相源是 `anchors.js` 的 `ANCHORS`（P2-C），
 * 本模块只消费它的 BTC 子集（`congestionAnchors()`）。原来这三条就地写死在这里，
 * 与锚点表并存两份 ⇒ 改一处漏一处。
 *
 * ⚠️ 2017-12 的 `add` 写 **70** 而不是 60：§6.3 把「ICO 狂潮」与「CryptoKitties」记成两行，
 *    表里是「+60（CryptoKitties 再叠 +10）」⇒ 峰值 = 70。ROADMAP 的落点验算
 *    「2017-12 窗口指数 90 = 基础 20 + 70」也印证这个读法。
 */

/** 窗口内的归一形状：爬升 → 峰值平台 → 回落，取值恒在 [0, 1] */
function anchorShape(elapsedDays, c) {
  if (elapsedDays < 0 || elapsedDays >= c.days) return 0;
  const plateau = c.days - c.ramp - c.fall;
  if (elapsedDays < c.ramp) return elapsedDays / c.ramp;
  if (elapsedDays < c.ramp + plateau) return 1;
  return (c.days - elapsedDays) / c.fall;
}

/** 某一时刻的锚点总加成（分钟级平滑，按小时步进时看不出台阶） */
export function anchorAddAt(t) {
  let sum = 0;
  for (const a of congestionAnchors()) sum += a.congestion.add * anchorShape((t - a.t) / DAY_MS, a.congestion);
  return sum;
}

/* ───────────────── ③ 玩家脉冲 ───────────────── */

/**
 * 单次转账金额 **> 当日 BTC 流动性的 10%** 时触发（分母固定为 BTC，理由见 ROADMAP：
 * BTC 是全期唯一连续在场、且 2013 年唯一有行情的资产，单一真相源玩家不必猜是哪条链）。
 * 加成 **+5 ~ +15** 按超出比例线性：刚到阈值给 +5，超过 3 倍给满 +15，再多也不加。
 */
export const PULSE = {
  thresholdFrac: 0.1,
  min: 5,
  max: 15,
  fullRatio: 3,
  decayHours: 48,
};

/** 当前全部脉冲的瞬时值：每条按「48 小时线性衰减」折算（同时只允许一笔在途，但脉冲可叠加） */
export function pulseOf(s) {
  const list = s.pulse || [];
  let sum = 0;
  for (const p of list) {
    const age = s.i - p.at;
    if (age >= PULSE.decayHours) continue;
    sum += p.add * (1 - age / PULSE.decayHours);
  }
  return sum;
}

/**
 * 记一笔脉冲。**必须在本笔转账的到账根数算完之后再调** —— 口径是「下一次转账更慢」，
 * 本次转账不受自己的脉冲影响（验收口径④）。
 * @returns {number} 实际加上的初始脉冲值；未达阈值 / 流动性未知 ⇒ 0
 */
export function bumpPulse(s, amount) {
  const liq = liqOf('BTC', dayIndexOf(s.i));
  if (!liq) return 0;                                   // 流动性没加载 / 当天无行情 ⇒ 不触发
  const threshold = liq * PULSE.thresholdFrac;
  if (!(amount > threshold)) return 0;

  const ratio = amount / threshold;
  const k = clamp((ratio - 1) / (PULSE.fullRatio - 1), 0, 1);
  const add = PULSE.min + (PULSE.max - PULSE.min) * k;
  s.pulse.push({ add, at: s.i });
  return add;
}

/** 清掉已经衰减到 0 的脉冲（它们对 `pulseOf` 已无贡献，留着只会让存档变大） */
export function decayPulse(s) {
  if (!s.pulse || !s.pulse.length) return;
  s.pulse = s.pulse.filter(p => s.i - p.at < PULSE.decayHours);
}

/* ───────────────── 拥堵指数 ───────────────── */

/** 当前拥堵指数 = clamp(年代基础值 ＋ 锚点加成 ＋ 玩家脉冲, 0, 100) */
export function congestionOf(s) {
  const t = GAME.start + s.i * HOUR_MS;
  const y = new Date(t).getUTCFullYear();
  return clamp(baseOfYear(y) + anchorAddAt(t) + pulseOf(s), 0, 100);
}

/**
 * 状态词（拍板 ③：**只给状态词 ＋ 倒计时，不显示 0–100 数字**）。
 * 分界与 W 表的四档完全对齐，改一处必须改另一处。
 */
export function congestionLabel(c) {
  if (c <= 20) return '空闲';
  if (c <= 50) return '轻度';
  if (c <= 80) return '中度';
  return '严重';
}

/* ───────────────── 到账时间 ───────────────── */

/**
 * 进块等待 W（分钟）。四档、档内线性插值。
 *
 * 为什么分档而不是一条直线：GDD §6.4 给的是**区间**（空闲 10 分钟 / 轻度 30 分钟–2 小时 /
 * 中度 2–6 小时 / 严重 6–20 小时），一条直线的两端对不上任何一档。
 * 档边界取下沿值（21 → 30 分钟、51 → 2 小时、81 → 6 小时），上沿落在 50 / 80 / 100。
 *
 * ⚠️ 20 → 21 有一处 10 → 30 分钟的跳变。换算成到账根数后 `ceil((10+20)/60)` 与
 *    `ceil((30+20)/60)` **都是 1 根**，所以界面上永远看不出来，不必抹平。
 */
const WAIT_BANDS = [
  { lo: 21, hi: 50,  wLo: 30,  wHi: 120 },
  { lo: 51, hi: 80,  wLo: 120, wHi: 360 },
  { lo: 81, hi: 100, wLo: 360, wHi: 1200 },
];

export function blockWaitMinutes(congestion) {
  const c = clamp(congestion, 0, 100);
  if (c <= 20) return 10;
  for (const b of WAIT_BANDS) {
    if (c <= b.hi) {
      const r = clamp((c - b.lo) / (b.hi - b.lo), 0, 1);
      return b.wLo + r * (b.wHi - b.wLo);
    }
  }
  return 1200;                                          // = 20 小时（严重档上沿）
}

/**
 * 目标交易所要求的充值确认数。
 * ⚠️ 它**不是平衡杠杆** —— 每多 1 个确认只多 10 分钟，在 1 根 K 线的粒度下多数时候看不见。
 *    它的价值是弹层里能写出「Bitfinex · 3 个确认」，把玩家推向 BitMEX（1 个确认最快）这个史实偏好。
 */
const CONFIRMATIONS = { mtgox: 2, bitfinex: 3, bitmex: 1, binance: 2 };

export const confirmationsOf = exId => CONFIRMATIONS[exId] ?? 2;

/**
 * **大额转账的额外确认数**（2026-10-01 用户拍板）—— 金额越大，到账越慢。
 * 现实里交易所对大额入金会加确认门槛 / 走人工风控，小额则很快认账；这里用一个金额阶梯近似它。
 *
 * ⚠️ 阈值与档位都是**合成值**（无一手出处，同 `LIQ.fee` 的待遇）：史实检索拿不到「多少钱要几个
 *    确认」这种表，本作只要**方向**对即可。单位 = 美元名义。
 * ⚠️ 只作用于**链上**通道（`arrivalCandles`）；`wire` 的到账天数是固定区间，与金额无关。
 */
const LARGE_STEPS = [
  { from: 1e5, extra: 6 },     // ≥ $100,000 ⇒ +6 个确认（+1 小时）
  { from: 1e4, extra: 2 },     // ≥ $10,000  ⇒ +2 个确认（+20 分钟）
];

/** 这笔金额要多加几个确认（0 = 不加） */
export function extraConfirmations(amount) {
  for (const s of LARGE_STEPS) if (amount >= s.from) return s.extra;
  return 0;
}

/**
 * 到账需要几根 K 线（1 根 K 线 = 1 游戏小时）：`ceil((W + C×10) / 60)`，下限 1 根。
 * @param {number} congestion 拥堵指数
 * @param {string} exId       目标交易所
 * @param {number} amount     本笔金额（美元名义）—— 大额加确认数，见 `extraConfirmations`
 */
export function arrivalCandles(congestion, exId, amount = 0) {
  const minutes = blockWaitMinutes(congestion) + (confirmationsOf(exId) + extraConfirmations(amount)) * 10;
  return Math.max(1, Math.ceil(minutes / 60));
}