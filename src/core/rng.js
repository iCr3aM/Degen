/**
 * 确定性随机数 —— RNG 种子系统（S0 · 细粒度模拟的地基）
 * ===============================================================
 * 纯函数集合：**不碰状态、不碰 DOM、不读时钟**（与 `impact.js` / `positions.js` 同一分层）。
 *
 * 为什么必须是**无状态（counter-based）**：
 *   细粒度模拟要在「任意时刻、任意币种、任意刻度」上现取随机数，而且必须**可复现** ——
 *   同一份存档、同一时刻、同一币种，永远生成同一条 tick 流。
 *   流式 PRNG（一直 `next()`）做不到：断点续算要重放、多币种会顺序耦合、跳日期要重跑。
 *   哈希式则可以「**跳到哪算哪**」：`rand(seed, sym, hour, tick, chan)` 是纯函数。
 *
 * 取数口径（写死，勿擅改）：
 *   `seed(sym, hour, tick, chan) = splitmix64( seed·FNV ⊕ hash(sym)<<32 ⊕ hour·K1 ⊕ tick·K2 ⊕ hash(chan) )`
 *   → 取低 32 位 → `mulberry32` → `[0, 1)`
 *
 * ⚠️ **`chan`（通道）是刻意分开的**：行情路径 / 成交量 / 极值位置 / 事件 四套随机数**互不污染**，
 *    将来往某一套里多取一个数，**不会**打乱其余三套已经固定的序列。
 * ⚠️ 本文件里的 `hashStr` 是**唯一**的字符串→uint32 口径，下游不许各自再写一个。
 */

const MASK64 = 0xffffffffffffffffn;
/** splitmix64 的黄金比步长 */
const PHI = 0x9e3779b97f4a7c15n;
const MIX1 = 0xbf58476d1ce4e5b9n;
const MIX2 = 0x94d049bb133111ebn;

/** FNV-1a 64 位素数 —— 用来把「全局种子」摊开 */
const FNV64 = 0x100000001b3n;
/** 小时 / 刻度的乘法常数（互质的大奇数，避免不同刻度落到同一条轨道上） */
const K_HOUR = 0x9e3779b1n;
const K_TICK = 0xc2b2ae3dn;

/**
 * splitmix64 —— 64 位双射混合器（BigInt 版）。
 * 双射的意义：**不同的输入必得不同的输出**，相邻种子不会相关（这正是流式 PRNG 用近邻种子时的经典坑）。
 * @param {bigint} x
 * @returns {bigint} 落在 64 位内
 */
export function splitmix64(x) {
  x = (x + PHI) & MASK64;
  x = ((x ^ (x >> 30n)) * MIX1) & MASK64;
  x = ((x ^ (x >> 27n)) * MIX2) & MASK64;
  return (x ^ (x >> 31n)) & MASK64;
}

/**
 * mulberry32 —— 取**一个** `[0, 1)` 的值。
 *
 * ⚠️ 这里刻意写成「取一次」而不是「返回一个流」：无状态的用法就是
 *    「拿一个 32 位种子 → 换一个随机数」，**不保留任何内部状态**。
 *    要一串数就多调几次 `rand(...)`（每次换 `tick`），而不是推进某个流。
 * @param {number} a 32 位种子
 */
export function mulberry32(a) {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * 字符串 → uint32（FNV-1a 32 位）—— 币符号 / 通道名 都走它。
 * **全项目唯一口径**，不许在别处再实现一遍。
 */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 无状态取一个 `[0, 1)` —— **可复现的地基**。
 *
 * 同 `(seed, symHash, hour, tick, chanHash)` ⇒ 永远同一个数；
 * 五者任一不同 ⇒ 换一条独立的流（碰撞概率 2⁻³² 量级）。
 *
 * @param {number} seed     全局种子（存档 `s.seed`）
 * @param {number} symHash  币符号的 `hashStr`
 * @param {number} hour     绝对小时序号（= `s.i` 的语义；**不是** tick 序号）
 * @param {number} tick     该小时内的第几根细刻度（0 ≤ tick < 每小时刻度数）
 * @param {number} chanHash 通道名的 `hashStr`（'path' / 'volume' / 'extreme' / 'event' …）
 * @returns {number} `[0, 1)`
 */
export function rand(seed, symHash, hour, tick, chanHash) {
  const h = splitmix64(
    (BigInt(seed >>> 0) * FNV64) ^
    (BigInt(symHash >>> 0) << 32n) ^
    (BigInt(hour) * K_HOUR) ^
    (BigInt(tick) * K_TICK) ^
    BigInt(chanHash >>> 0),
  );
  return mulberry32(Number(h & 0xffffffffn));
}