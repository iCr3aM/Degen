/**
 * 存档（GDD §19.1：localStorage，键名 `degen_save`）
 * ===============================================================
 * 只存**关键状态**，绝不存行情 —— K 线来自预置数据包，任何时候都能重新读出来。
 *
 * ⚠️ 一个闸门：`disabled`。删档时必须先关闸，否则 `beforeunload` 会把刚删掉的档原样写回来。
 */

import { STATE_VERSION } from './state.js';
import { SPEEDS } from './config.js';

const KEY = 'degen_save';
let disabled = false;

/** 关掉写盘（删档流程用），关掉之后 `save()` 变成空操作 */
export function disableSave() { disabled = true; }

export function save(s) {
  if (disabled) return false;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;               // 隐私模式 / 配额满：玩得下去，只是不落盘
  }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s) return null;
    return migrate(s);
  } catch {
    return null;
  }
}

/**
 * 版本迁移。**只往后补字段，不改判据**。
 *
 * v3 → v4（P2-A）：新增 `transfer` / `pulse`。旧档没有这两个字段，补上默认值即可，
 * 玩法不受影响（旧档的 `s.ex` 已经是某一家所，且 `books` 里那一格就是全部余额）——
 * 所以**旧档不必作废**。再往前的版本没有迁移路径，直接丢弃重开。
 *
 * v4 → v5（Batch 5 · B30）：新增 `loaned` / `loan` / `pending`。同样是补默认值即可 ——
 * 旧档没借过钱（`loaned: false`）、没有在贷、没有待决。
 *
 * v5 → v6（P2-B3 · OTC）：新增 `chan`。旧档没有通道这个概念，一律补 `'book'`（盘口）——
 * 语义上正好是「旧档一直以来的行为」，玩法不受影响，所以**同样不作废旧档**。
 *
 * v6 → v7（上帝模式 ＋ 订单冲击）：新增 `impactOn` / `flow` / `godRuined` / `god`。
 * `impactOn` 补 `true`（= 全局默认），`god` 补 `null`（旧档当然没开过上帝模式）。
 * ⚠️ 这是**玩法口径变更**（老档升级后，玩家下单会开始推动行情），不是纯补字段 ——
 *    但它与「新开一局」的行为一致，且 `flow` 从空开始，所以仍然**不作废旧档**。
 *
 * v7 → v8（C1 · 冲击池多笔叠加）：`flow[sym]` 由单池 `{v, at}` 改成**逐笔列表** `[{v, at}, …]`。
 * 旧档每个币最多只有一笔，**包成单元素列表**即可 —— 语义与「它一直就是列表里唯一那项」完全一致
 * （`residualAt` 求和时那一项就是全部），所以同样**不作废旧档**。
 *
 * ⚠️ **不改版本号也要校正的字段**：`speed`。2026-09-29 速度档收窄为 `1/5/10/50`，
 * 旧档若停在已删掉的 `2x` / `20x` 上，`render.js` 会「一排按钮全不亮，时钟却在飞跑」。
 * 这属于取值域收窄，不是结构变更，所以**不升版本**，直接在末尾夹一次。
 */
function migrate(s) {
  if (s.v === 3) {
    s.transfer = null;
    s.pulse = [];
    s.v = 4;
  }
  if (s.v === 4) {
    s.loaned = false;
    s.loan = null;
    s.pending = null;
    s.v = 5;
  }
  if (s.v === 5) {
    s.chan = 'book';
    s.v = 6;
  }
  if (s.v === 6) {
    s.impactOn = true;
    s.flow = {};
    s.godRuined = false;
    s.god = null;
    s.v = 7;
  }
  if (s.v === 7) {
    const flow = s.flow && typeof s.flow === 'object' ? s.flow : {};
    for (const sym of Object.keys(flow)) {
      const p = flow[sym];
      flow[sym] = Array.isArray(p) ? p : (p ? [p] : []);
    }
    s.flow = flow;
    s.v = 8;
  }
  if (s.v !== STATE_VERSION) return null;
  /* 取值域校正：不在档位表里的速度一律回落到 1x */
  if (!SPEEDS.includes(s.speed)) s.speed = 1;
  return s;
}

export function wipe() {
  try { localStorage.removeItem(KEY); } catch { /* 没有就当作已删 */ }
}
