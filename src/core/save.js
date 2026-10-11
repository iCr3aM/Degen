/**
 * 存档（GDD §19.1：localStorage）—— **四个槽**（2026-10-10 用户拍板 · 架空模式 P1）
 * ===============================================================
 * 只存**关键状态**，绝不存行情 —— K 线来自预置数据包（或架空生成器），任何时候都能重新读出来。
 *
 * ⚠️ **四个键**：`degen_save_normal` / `degen_save_challenge` / `degen_save_godhist` / `degen_save_godfic`
 *    —— 四局可以**同时存在**，互不覆盖。槽位由 `saveSlotOf(s)` 推导（上帝局看 `s.world`，
 *    其余看 `s.scen`），**不新增额外持久字段**。
 *    为什么不做「挑战多槽」：挑战是「速通」，同一时间只该有一局在打（LESS IS MORE）。
 *
 * ⚠️ **本轮不做存档兼容**（2026-09-29 用户拍板）：版本对不上就直接**丢弃、重开新局**。
 *
 * ⚠️ 一个闸门：`disabled`。删档时必须先关闸，否则 `beforeunload` 会把刚删掉的档原样写回来。
 *
 * ⚠️ **上帝状态进存档**（2026-10-10 翻转 2026-10-07 的「一次性游戏」裁决）：`s.god` 正常落盘 ——
 *    上帝模式已升级为一等公民模式（有自己的槽），读档回来仍在上帝局里。
 *    ⚠️ 旧档（2026-10-07 ~ 2026-10-10 期间落盘的）里没有 `s.god` ⇒ 天然读成普通局，**不升版**。
 *    「这局用过上帝」另有 `s.stat.god`（统计布尔）作证，结算 / 生涯档案认得出它。
 */

import { STATE_VERSION } from './state.js';
import { isChallenge } from './config.js';

/** 不落盘的**会话级**键：归零补满的提示闩锁（无实害：`inf` 开启时归零本就自动补满）
    ＋ 24h/7d 强平台账（2026-10-11：读数窗「最近 7 天」，读档重攒）。
    ⚠️ `feed`（大单 tape）**已移出**本名单（2026-10-11 用户拍板「日志持续保留直到顶掉」
    ⇒ 必须跨读档成立；走 `lob` 先例不进 SHAPE —— 旧档缺键不判废，不升版）。 */
const EPHEMERAL = ['godRuined', 'liq24', 'oiHist'];

const KEY_OF = {
  normal: 'degen_save_normal',
  challenge: 'degen_save_challenge',
  godHist: 'degen_save_godhist',
  godFic: 'degen_save_godfic',
};

/** 四个槽的键名（顺序即菜单里的展示顺序） */
export const SAVE_SLOTS = ['normal', 'challenge', 'godHist', 'godFic'];

/** 槽位的显示名（「读取存档」里那几行；挑战槽在菜单里另用年代名覆盖，见 `main.menuSlots`） */
const SLOT_NAME = { normal: '普通模式', challenge: '挑战模式', godHist: '上帝·史实', godFic: '上帝·架空' };
export const slotName = slot => SLOT_NAME[slot] || SLOT_NAME.normal;

/** **世界属性**（2026-10-10）：`'hist'` = 真实历史数据包；`'fic'` = 架空生成器。
 *  ⚠️ 缺格一律兜底 `'hist'`（旧档 / 普通局 / 挑战局全都没有这个字段）。 */
export const worldOf = s => (s && s.world === 'fic' ? 'fic' : 'hist');

/** 一局属于哪个槽 —— 上帝局看 `s.world`，其余看 `s.scen`；不新增持久字段。
 *  ⚠️ 名字刻意不叫 `slotOf`：`state.js` 已经有一个同名的 `slotOf(s, cur, ex)`（读**账本**里
 *     某个币种那格的余额），是两件毫不相干的事 —— 同名会让两边读起来互相误导。 */
export const saveSlotOf = s =>
  s && s.god ? (worldOf(s) === 'fic' ? 'godFic' : 'godHist')
    : (isChallenge(s && s.scen) ? 'challenge' : 'normal');

let disabled = false;

/** 关掉写盘（删档流程用），关掉之后 `save()` 变成空操作 */
export function disableSave() { disabled = true; }

export function save(s) {
  if (disabled) return false;
  /* 已结束的局**不落盘**（2026-10-04 用户拍板 · 「打完之后应该清除存档」）：
     `engine.endGame` 已经 `wipe` 掉本槽，若这里再把 `s.over` 写回去，那条档就复活了。
     `rewindTo`（上帝跳日期）把 `s.over` 清回 null 之后，写盘自然恢复。 */
  if (s.over) return false;
  try {
    /* **浅拷贝后剔除会话级键**再落盘 —— 顶层整对消失，嵌套的 `stat.god`（统计布尔，
       「这局用过上帝」的作证）原样保留。不深拷贝：JSON.stringify 只读，浅拷贝够用。 */
    const flat = { ...s };
    for (const k of EPHEMERAL) delete flat[k];
    localStorage.setItem(KEY_OF[saveSlotOf(s)], JSON.stringify(flat));
    return true;
  } catch {
    return false;               // 隐私模式 / 配额满：玩得下去，只是不落盘
  }
}

/**
 * 容器形状（正式版 · 存档健壮性）：**这 12 个字段**缺了就会在开机首帧抛异常 ——
 *   对象型（`obj`）：`books` 账本、`positions` 持仓（`heldSyms` 迭代它）、`flow` 订单冲击、
 *     `overhang` 持仓抛压折价、`pool` 瞬时深度池、`adv` 逐币推进状态、`mkt` NPC 情绪/持仓、
 *     `pvol` 玩家成交额、`stat` 交易统计；
 *   数组型（`arr`）：`pulse` 拥堵脉冲、`log` 日志（`pushLog` 用 `unshift`）、`eq` 资金曲线。
 *
 * ⚠️ **R16（2026-10-04 审计）**：原文只列了 8 键，与实际的 12 键对不上（已补齐）。
 * ⚠️ **`mkb`（标记价基差）刻意不进白名单**：它是后加的字段，旧档普遍没有 —— 若并入，
 *    所有旧档都会被 `shaped` 判不合格而**丢弃重开**（等同强制作废玩家存档）。
 *    读侧已用 `s.mkb &&` / `markBiasOf` 做缺格兜底（缺格⇒基差 0），所以这里是**故意**不列的。
 *
 * 版本号对得上、字段却被改坏（手动编辑 / 半截写入）的档**同样按「丢弃重开」处理**，
 * 总好过让玩家卡在一个「界面可见、却完全点不动、也没有任何提示」的死局里。
 */
const SHAPE = { books: 'obj', positions: 'obj', flow: 'obj', overhang: 'obj', pool: 'obj', adv: 'obj', mkt: 'obj', pvol: 'obj', stat: 'obj', pulse: 'arr', log: 'arr', eq: 'arr' };

function shaped(s) {
  if (typeof s.i !== 'number' || typeof s.sym !== 'string') return false;
  for (const k in SHAPE) {
    const v = s[k];
    if (SHAPE[k] === 'arr' ? !Array.isArray(v) : (typeof v !== 'object' || v === null || Array.isArray(v))) return false;
  }
  return true;
}

/** 读**一个槽**：没有档、解析失败、**版本不符**、字段形状不对、或**已结束**，一律返回 `null`
 *  ⚠️ `s.over` 非空 = 这局早就打完了（2026-10-04 用户拍板）—— 一并当成「没有档」，
 *     连旧版本残留的那份「已结束档」也读不出来（写侧那道闸管不到历史遗留的档）。 */
function parse(slot) {
  try {
    const raw = localStorage.getItem(KEY_OF[slot] || KEY_OF.normal);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object' || s.v !== STATE_VERSION || !shaped(s) || s.over) return null;
    /* 旧档兼容（2026-10-10 上帝状态改为进存档）：历史版本落过 `godRuined` 的档剥掉它
       （`s.god` 自本轮起**保留** —— 上帝已是一等公民模式）；`world` 缺格归一化成 `'hist'`。 */
    delete s.godRuined;
    s.world = worldOf(s);
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