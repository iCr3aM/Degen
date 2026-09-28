/**
 * 存档（GDD §19.1：localStorage，键名 `degen_save`）
 * ===============================================================
 * 只存**关键状态**，绝不存行情 —— K 线来自预置数据包，任何时候都能重新读出来。
 *
 * ⚠️ 一个闸门：`disabled`。删档时必须先关闸，否则 `beforeunload` 会把刚删掉的档原样写回来。
 */

import { STATE_VERSION } from './state.js';

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
 */
function migrate(s) {
  if (s.v === 3) {
    s.transfer = null;
    s.pulse = [];
    s.v = 4;
  }
  return s.v === STATE_VERSION ? s : null;
}

export function wipe() {
  try { localStorage.removeItem(KEY); } catch { /* 没有就当作已删 */ }
}
