/**
 * 称号与徽章（M3 · 2026-10-01）
 * ===============================================================
 * 输入是 `core/careers.js` 的**一条档案记录**，输出「主称号 ＋ 徽章」：
 *
 *     titleOf(rec)   →  '百倍战神'                （一局一枚）
 *     badgesOf(rec)  →  ['现货党', '钻石手', …]   （0–10 枚）
 *
 * 档案页（`render.js` 的 `careerRow`）与分享图（M4 `ui/shareCard.js`）**共用这里** ⇒
 * 同一局在哪儿看都是同一枚称号，不会两处各写一份判断（LESS IS MORE 的硬要求）。
 *
 * ⚠️ **纯函数**：不给 `s` 打点、不读 localStorage、不改 `STATE_VERSION`，重算一百遍也不变。
 * ⚠️ 判据全部落在 M1 已打点的 `s.stat` 上（`open/fut/maxLev/syms/move/loan/god`）——
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
 * 徽章 —— 10 枚，按固定顺序排列。
 * ⚠️ 成对的判据（躺平/现货党、百倍玩家/杠杆赌徒、单一信仰/五币全通）用 `else if` **互斥**，
 *    避免一行里冒出两枚意思相近的标签（LESS IS MORE）。
 */
export function badgesOf(rec) {
  const out = [];
  const symCount = Array.isArray(rec.syms) ? rec.syms.length : 0;

  if (rec.open === 0) out.push('躺平');
  else if (rec.fut === 0) out.push('现货党');

  if (rec.maxLev >= 100) out.push('百倍玩家');
  else if (rec.maxLev >= 20) out.push('杠杆赌徒');

  if (symCount === 1) out.push('单一信仰');
  else if (symCount >= 5) out.push('五币全通');

  if (rec.move >= 10) out.push('搬家达人');
  if (rec.loan >= 1) out.push('续命者');
  if (rec.god) out.push('上帝之手');

  /* 危机幸存者：**开在 312 之前、收在 312 之后**（真跨过那根针），且不是被打爆的。
   * ⚠️ `start < CRASH_312` 这一半不能省 —— 否则 2021 / 2022 开局的年代局
   *    「终局天然晚于 312」会白捡这枚徽章。 */
  if (rec.start < CRASH_312 && rec.end >= CRASH_312 && rec.reason !== OVER.LIQUIDATED) {
    out.push('危机幸存者');
  }
  return out;
}