/**
 * 存档（GDD §19.1：localStorage）—— **普通模式 / 挑战模式各一个槽**（2026-10-01 拍板）
 * ===============================================================
 * 只存**关键状态**，绝不存行情 —— K 线来自预置数据包，任何时候都能重新读出来。
 *
 * ⚠️ **两个键，不是一局一处字段**（用户 2026-10-01）：
 *    `degen_save_normal` / `degen_save_challenge` —— 一局普通、一局挑战可以**同时存在**，
 *    互不覆盖。槽位由 `s.scen` 推导（`saveSlotOf`），**不新增任何持久字段**。
 *    为什么不做「挑战多槽」：挑战是「速通」，同一时间只该有一局在打；新开一局挑战覆盖旧的挑战档，
 *    与「重开本局」同一语义（LESS IS MORE）。
 *
 * ⚠️ **本轮不做存档兼容**（2026-09-29 用户拍板）：版本对不上就直接**丢弃、重开新局**，
 *    原来那条 `migrate()` 迁移链已整条删除（少一层要维护的冗余代码；正式版以后再补）。
 *
 * ⚠️ 一个闸门：`disabled`。删档时必须先关闸，否则 `beforeunload` 会把刚删掉的档原样写回来。
 */

import { STATE_VERSION } from './state.js';
import { isChallenge } from './config.js';

const KEY_OF = {
  normal: 'degen_save_normal',
  challenge: 'degen_save_challenge',
};

/** 两个槽的键名（顺序即菜单里的展示顺序：普通在前、挑战在后） */
export const SAVE_SLOTS = ['normal', 'challenge'];

/** 槽位的显示名（菜单「读取存档」里那两行） */
export const slotName = slot => (slot === 'challenge' ? '挑战模式' : '普通模式');

/** 一局属于哪个槽 —— 只由 `s.scen` 是不是挑战局决定，不新增持久字段。
 *  ⚠️ 名字刻意不叫 `slotOf`：`state.js` 已经有一个同名的 `slotOf(s, cur, ex)`（读**账本**里
 *     某个币种那格的余额），是两件毫不相干的事 —— 同名会让两边读起来互相误导。 */
export const saveSlotOf = scenId => (isChallenge(scenId) ? 'challenge' : 'normal');

let disabled = false;

/** 关掉写盘（删档流程用），关掉之后 `save()` 变成空操作 */
export function disableSave() { disabled = true; }

export function save(s) {
  if (disabled) return false;
  try {
    localStorage.setItem(KEY_OF[saveSlotOf(s.scen)], JSON.stringify(s));
    return true;
  } catch {
    return false;               // 隐私模式 / 配额满：玩得下去，只是不落盘
  }
}

/**
 * 容器形状（正式版 · 存档健壮性）：这几个字段**缺了就会在开机首帧抛异常** ——
 *   `heldSyms` 迭代 `s.positions`、`pushLog` 用 `s.log.unshift`、
 *   资金曲线用 `s.eq`、拥堵脉冲用 `s.pulse`、订单冲击用 `s.flow`、持仓抛压折价用 `s.overhang`、
 *   瞬时深度池用 `s.pool`、账本用 `s.books`。
 * 版本号对得上、字段却被改坏（手动编辑 / 半截写入）的档**同样按「丢弃重开」处理**，
 * 总好过让玩家卡在一个「界面可见、却完全点不动、也没有任何提示」的死局里。
 */
const SHAPE = { books: 'obj', positions: 'obj', flow: 'obj', overhang: 'obj', pool: 'obj', pvol: 'obj', stat: 'obj', pulse: 'arr', log: 'arr', eq: 'arr' };

function shaped(s) {
  if (typeof s.i !== 'number' || typeof s.sym !== 'string') return false;
  for (const k in SHAPE) {
    const v = s[k];
    if (SHAPE[k] === 'arr' ? !Array.isArray(v) : (typeof v !== 'object' || v === null || Array.isArray(v))) return false;
  }
  return true;
}

/** 读**一个槽**：没有档、解析失败、**版本不符**、或字段形状不对，一律返回 `null` */
function parse(slot) {
  try {
    const raw = localStorage.getItem(KEY_OF[slot] || KEY_OF.normal);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object' || s.v !== STATE_VERSION || !shaped(s)) return null;
    return s;
  } catch {
    return null;
  }
}

/** 读指定槽的档（`null` = 这个槽没有可用的档） */
export const loadSlot = slot => parse(slot);

/** 这个槽有没有可用的档（主菜单据此决定「读取存档」列出哪几行） */
export const hasSave = slot => !!parse(slot);

/** 开机缺省读哪一槽：**先普通、再挑战** —— 两个都有时以普通为准（它才是「主线」） */
export function load() {
  return parse('normal') || parse('challenge');
}

/** 删掉**一个槽**的档（只动这一个 —— 另半边的存档不受影响） */
export function wipe(slot) {
  try { localStorage.removeItem(KEY_OF[slot] || KEY_OF.normal); } catch { /* 没有就当作已删 */ }
}