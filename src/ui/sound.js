/**
 * 音效（Batch 4 · B20）
 * ===============================================================
 * **零音频文件**：全部用 Web Audio 的振荡器现场合成。两条硬约束都指向这条路 ——
 * 项目「无第三方运行时依赖」＋ 手机首包体积预算（GDD §19.2）：一段 0.1 秒的波形
 * 比任何一个 mp3 都小，也不用多一个要上传、要缓存、要解码的二进制资源。
 *
 * 三条规矩：
 *   ① **开关存独立的 localStorage 键**（`degen_settings`）—— 不进存档，否则重开会把开关一起清掉；
 *   ② **懒建 AudioContext**：浏览器要求首次用户手势之后才允许出声，所以第一个声音
 *      必然来自一次点击（本作的开局按钮「开始交易」正好是这一下）；
 *   ③ **任何异常都不许往上冒**：浏览器不支持 / 上下文被挂起时静默变成「没声音」，
 *      绝不阻断玩法，也绝不把错误抛进主循环。
 *
 * 音色取向：短促、干脆、不刺耳。上涨用上行音程、下跌用下行音程 —— 不用听歌词也知道方向。
 */

const KEY = 'degen_settings';

let ac = null;
let muted = readMuted();

function readMuted() {
  try { return localStorage.getItem(KEY) === 'mute'; } catch { return false; }
}

function writeMuted() {
  try { localStorage.setItem(KEY, muted ? 'mute' : 'on'); } catch { /* 隐私模式：本次会话内有效即可 */ }
}

export const isMuted = () => muted;

export function setMuted(v) {
  muted = !!v;
  writeMuted();
  if (muted && ac && ac.state === 'running') {
    // 立刻静音：挂起上下文比逐个停振荡器干净，恢复时也不会有一串残音排队
    try { ac.suspend(); } catch { /* 忽略 */ }
  }
}

/** 取（必要时新建并唤醒）音频上下文；静音或不可用时返回 null */
function audio() {
  if (muted) return null;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!ac) ac = new Ctor();
    if (ac.state === 'suspended') ac.resume();
    return ac;
  } catch {
    return null;
  }
}

/**
 * 一枚短音。`to` 给频率滑到哪（不给就是不滑，走固定音高）。
 * 包络两端都用 `exponentialRampToValueAtTime`：指数衰减听起来才像「敲一下」，
 * 线性衰减会拖出一条尾巴。⚠️ 指数斜坡的目标值**不能是 0**（规范里是非法值），所以写 0.0001。
 */
function tone({ f, to = 0, dur = 0.08, type = 'triangle', gain = 0.05, at = 0 }) {
  const a = audio();
  if (!a) return;
  const t0 = a.currentTime + at;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(30, to), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/* ───────────────────────── 触发点清单 ───────────────────────── */

/** 开局（开场弹窗的「开始交易」）：两声上行，正式开盘的那一下 */
export const begin = () => { tone({ f: 392, dur: 0.12, type: 'sine', gain: 0.05 }); tone({ f: 587, dur: 0.16, type: 'sine', gain: 0.05, at: 0.1 }); };

/** 通用轻点：所有按钮的默认反馈，短到几乎只是一声「嗒」 */
export const tap = () => tone({ f: 1200, dur: 0.025, type: 'triangle', gain: 0.02 });

/** 开仓：上行两度 */
export const open = () => { tone({ f: 523, dur: 0.09, type: 'triangle', gain: 0.05 }); tone({ f: 784, dur: 0.1, type: 'triangle', gain: 0.05, at: 0.07 }); };

/** 平仓：下行两度 */
export const close = () => { tone({ f: 784, dur: 0.09, type: 'triangle', gain: 0.05 }); tone({ f: 523, dur: 0.1, type: 'triangle', gain: 0.05, at: 0.07 }); };

/** 资金费到账（收入）：清亮的上行 */
export const fundUp = () => tone({ f: 880, to: 1320, dur: 0.13, type: 'sine', gain: 0.05 });

/** 资金费支出：闷一点的下行 */
export const fundDown = () => tone({ f: 440, to: 300, dur: 0.13, type: 'sine', gain: 0.05 });

/** 保证金率跌破 5%：两声低鸣，像警报 */
export const warn = () => { tone({ f: 233, dur: 0.1, type: 'square', gain: 0.035 }); tone({ f: 233, dur: 0.1, type: 'square', gain: 0.035, at: 0.16 }); };

/** 拥堵脉冲（大额转账推高了全网拥堵）：一记低频闷响 */
export const pulse = () => tone({ f: 110, to: 55, dur: 0.34, type: 'sine', gain: 0.07 });

/** 爆仓：一路下坠，全游戏最重的一声 */
export const liq = () => { tone({ f: 320, to: 60, dur: 0.55, type: 'sawtooth', gain: 0.07 }); tone({ f: 160, to: 40, dur: 0.7, type: 'sine', gain: 0.07 }); };

/** 收盘结算（活到 2024-12-31）：三声上行，收尾要亮 */
export const settle = () => {
  tone({ f: 523, dur: 0.14, type: 'sine', gain: 0.05 });
  tone({ f: 659, dur: 0.14, type: 'sine', gain: 0.05, at: 0.13 });
  tone({ f: 784, dur: 0.28, type: 'sine', gain: 0.05, at: 0.26 });
};