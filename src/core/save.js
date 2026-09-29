/**
 * 存档（GDD §19.1：localStorage，键名 `degen_save`）
 * ===============================================================
 * 只存**关键状态**，绝不存行情 —— K 线来自预置数据包，任何时候都能重新读出来。
 *
 * ⚠️ **本轮不做存档兼容**（2026-09-29 用户拍板）：版本对不上就直接**丢弃、重开新局**，
 *    原来那条 `migrate()` 迁移链已整条删除（少一层要维护的冗余代码；正式版以后再补）。
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

/** 读档：没有档、解析失败、或**版本不符**，一律返回 `null`（= 新开一局） */
export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || s.v !== STATE_VERSION) return null;
    return s;
  } catch {
    return null;
  }
}

export function wipe() {
  try { localStorage.removeItem(KEY); } catch { /* 没有就当作已删 */ }
}
