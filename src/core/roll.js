/**
 * HUD 数字滚动的**纯逻辑**（2026-10-05）
 * ===============================================================
 * ⚠️ 为什么单独放 `core` 而不是留在 `render.js`：`render.js` 顶层就碰 DOM，Node 里 import 不了
 *    —— 而「滚动到底有没有真的发生」必须能在 `tools/sim-audit.mjs` 里**按行为**断言。
 *    以前那条审计只对 `render.js` 源码打一条 `/speed > 1/` 正则，是**假绿**：源码里写着滚动，
 *    运行时却因为阈值不对而从不滚动，照样「通过」。把数学与决策提成纯函数后，审计能真的跑它。
 */

/** 一次补间的时长（ms）。 */
export const ROLL_MS = 220;

/**
 * 「这一格多久没被更新 = 值已陈旧，直接写、别滚」的阈值（ms）。
 *
 * ⚠️ **必须 > 1000**。驱动只有 `engine.createClock` 的 `onFrame`，而它**只在推进过一小时**时才回调
 *    （见 `engine.js` 的 `step()`）。1x 的口径是「1 实秒 = 1 游戏小时」，所以相邻两次回调间隔约
 *    **1000ms**。阈值若小于 1000（旧值 480），1x 下每一拍都被判成「陈旧」⇒ 永远走直接写、
 *    从不补间 —— 这正是用户 2026-10-05 反馈的「1 倍速只有闪烁、看不出滚动」的根因。
 *
 * 取 1500：容得下 1x 的 1000ms 间隔（留 500ms 余量，避免定时器抖动把某一拍误判成陈旧），
 * 又能拦住「切页 / 切回」这种隔了数秒的陈旧值（那时确实该直接写，别从很远的地方爬过来）。
 */
export const ROLL_STALE = 1500;

/** easeOutCubic —— 起步快、收尾稳。 */
export function easeOutCubic(p) {
  const q = 1 - p;
  return 1 - q * q * q;
}

/**
 * 补间采样：`p ∈ [0,1]` ⇒ `[from, to]`。
 * `p = 0` 得 `from`，`p = 1` 得 `to`，中间是**严格的中间值**（不是端点）—— 审计靠这条证明
 * 「确有中间帧」，而不是「只有起止两帧的闪烁」。
 */
export function rollSample(from, to, p) {
  const t = p <= 0 ? 0 : p >= 1 ? 1 : p;
  return from + (to - from) * easeOutCubic(t);
}

/**
 * 这一拍该**滚**（true）还是**直接写**（false）？
 *
 * 直接写的四种情形：目标没变（`sameTarget`）/ 值已陈旧（`sinceLastMs > ROLL_STALE`）/
 * 快进人群（`speed > 1`，一小时里塞很多帧，滚动反而糊成一团）/ 动效档关（`fx < 1`）。
 * 其余（典型：1x 且间隔约 1000ms）都该滚 —— 这条就是上面那个 bug 的回归断言。
 */
export function shouldRoll({ speed = 1, fx = 2, sameTarget = false, sinceLastMs = 0 } = {}) {
  if (sameTarget) return false;
  if (sinceLastMs > ROLL_STALE) return false;
  if (speed > 1) return false;
  if (fx < 1) return false;
  return true;
}
