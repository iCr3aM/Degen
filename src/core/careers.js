/**
 * 交易档案（M2 · 2026-10-01）
 * ===============================================================
 * 玩家**每结束一局**就留一条记录 —— 年代 / 结局 / 存活天数 / 本金与终值 / 交易统计。
 * 主菜单「交易档案」那一页读的就是这里。
 *
 * ⚠️ 存**独立的 localStorage 键**（`degen_careers`），**不进存档**（`degen_save`）——
 *    与 `degen_settings` / `degen_colors` / `degen_next_scen` 同一口径：
 *    存档描述「正在玩的这一局」，档案描述「玩过的所有局」。两件事不能混 ——
 *    重开会清掉存档，但档案必须留着。
 *
 * ⚠️ 容器自带版本号（`v`）：形状一变就**丢整份重来**（与 `save.js` 不做迁移同一条规矩）。
 *    只留**最近 `MAX` 条**（新的在前）—— 攒够就砍尾巴，localStorage 有配额。
 *
 * ⚠️ **纯 ESM ＋ 零依赖**，但 `localStorage` 在 Node（离线断言）与隐私模式下取不到 ——
 *    所有访问都走 `read()/write()` 两个带 try/catch 的包装，取不到就退回**模块级内存数组**
 *    （本次会话内有效即可，与 `sound.js` 隐私模式那条注释同一个意思）。
 */

const KEY = 'degen_careers';
const V = 2;                 // v1 → v2（M4 · 2026-10-01）：记录里多了抽稀后的资金曲线 `eq`
const MAX = 50;

/** 资金曲线在档案里保留多少个点（M4 分享卡要画它）——
 *  一局最多 ~4380 个游戏日，整条存进 localStorage 会让 50 条记录顶到配额；
 *  抽稀到 128 点足够画出一张 1080px 宽的卡片，体积也可忽略。 */
export const EQ_PTS = 128;

/** localStorage 不可用时的兜底（Node / 隐私模式）—— 与已写入的那份镜像，读不出就走它 */
let mem = [];

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw != null) {
      const box = JSON.parse(raw);
      if (box && box.v === V && Array.isArray(box.list)) return box.list;
      return [];                    // 版本不符 / 形状坏了：与存档同一条规矩 —— 丢弃
    }
    return mem;                     // 从没写过（或写不进去）：看内存里那份
  } catch {
    return mem;                     // Node / 隐私模式
  }
}

function write(list) {
  mem = list;
  try { localStorage.setItem(KEY, JSON.stringify({ v: V, list })); } catch { /* 隐私模式：内存里有效即可 */ }
}

/** 全部记录（**新的在前**）—— 读不出来就是空数组，绝不抛错 */
export const loadCareers = () => read();

/**
 * 追加一条记录（新的在最前面，超出 `MAX` 砍尾巴）。
 * `id` 由这里统一盖时间戳 —— 调用方（`engine.endGame`）不必自己造。
 * @returns {object} 刚写进去的那一条（带上 `id`）
 */
export function addCareer(rec) {
  const entry = { id: Date.now(), ...rec };
  write([entry, ...read()].slice(0, MAX));
  return entry;
}

/**
 * 资金曲线抽稀（M4）—— **等距取点，首尾必留**。
 * `s.eq` 是「本局第几个游戏日」的权益序列（升序），最长 ~4380 点；
 * 这里把它压到 `n` 点存进档案，供分享卡画线。点数不足 `n` 时原样返回（不插值、不造假点）。
 * @param {number[]} eq
 * @param {number} [n]
 * @returns {number[]}
 */
export function thinEq(eq, n = EQ_PTS) {
  if (!Array.isArray(eq) || !eq.length) return [];
  if (eq.length <= n || n < 2) return eq.slice();
  const out = [];
  for (let k = 0; k < n; k++) out.push(eq[Math.round((k * (eq.length - 1)) / (n - 1))]);
  return out;
}