/**
 * 音效（Batch 4 · B20；T-1 · 2026-10-01 扩到 16 种）
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
 *
 * ── T-1 的两个结构性改动 ──────────────────────────────────────────
 *   ④ **主总线**：`osc → gain → 压缩器 → 主增益 → destination`。50x 下多声会叠在一起互相盖住，
 *      压缩器把它们压到同一条响度线上（照搬 aggr.trade 用 Tone.js 默认挂的那条思路，但零依赖）。
 *   ⑤ **两类音**：**事件音**（爆仓 / 新闻 / 灾难 / 到账…，由日志驱动，**永不节流**）
 *      与**行情音**（`tickUp` / `tickDown` / `surge` / `spike`，由 K 线驱动，**同种音 120ms 节流**）。
 *      行情音另受一个**独立开关**管（它是环境音，吵了可以只关它，事件音照响）。
 */

const KEY = 'degen_settings';

/** 同一种行情音两响之间的最小间隔（**墙钟**毫秒，与游戏速度无关）。
 *  50x 下 1 真实秒 = 50 游戏小时，不节流就是机关枪 —— 这是三条闸里的第二条。 */
const MARKET_GAP = 120;

/* ───────────────────────── 偏好（两个开关） ─────────────────────────
 * ⚠️ **`degen_settings` 存的是 JSON**（T-1 起）。老版本存的是**裸字符串** `'mute'` / `'on'`，
 *    读到非 JSON 必须按老格式解，否则老用户的静音设置会被吃掉（迁移见 `readPrefs`）。 */
function readPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { mute: false, market: true };
    if (raw === 'mute') return { mute: true, market: true };    // 老格式：静音
    if (raw === 'on') return { mute: false, market: true };      // 老格式：开声
    const o = JSON.parse(raw);
    return { mute: !!o.mute, market: o.market !== false };
  } catch { return { mute: false, market: true }; }
}

const prefs = readPrefs();

function writePrefs() {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* 隐私模式：本次会话内有效即可 */ }
}

export const isMuted = () => prefs.mute;

export function setMuted(v) {
  prefs.mute = !!v;
  writePrefs();
  if (prefs.mute && ac && ac.state === 'running') {
    // 立刻静音：挂起上下文比逐个停振荡器干净，恢复时也不会有一串残音排队
    try { ac.suspend(); } catch { /* 忽略 */ }
  }
}

/** 行情音开关（默认开）。它只管 `tickUp/tickDown/surge/spike` —— 事件音不受它影响。 */
export const isMarketOn = () => prefs.market;

export function setMarketOn(v) {
  prefs.market = !!v;
  writePrefs();
}

/* ───────────────────────── 音频上下文 ＋ 主总线 ───────────────────────── */

let ac = null;
let bus = null;          // { comp }：主总线压缩器；与 `ac` 同生命周期

/** 取（必要时新建并唤醒）音频上下文；静音或不可用时返回 null */
function audio() {
  if (prefs.mute) return null;
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
 * 主总线的入口节点。**懒建、与上下文同生命周期**。
 *
 * 参数照搬 aggr.trade 那条思路（它用 Tone.js 默认挂的压缩器 / 限幅器）：
 * `threshold −18dB / knee 12 / ratio 6 / attack 3ms / release 180ms`，主增益 0.9。
 * 收益：十几声叠在一起时不糊、不爆，整体响度一致。**不引入任何依赖、不引入音频文件。**
 */
function busOf(a) {
  if (!bus) {
    const comp = a.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    const master = a.createGain();
    master.gain.value = 0.9;
    comp.connect(master).connect(a.destination);
    bus = { comp };
  }
  return bus.comp;
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
  osc.connect(g).connect(busOf(a));
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/* ───────────────────────── 行情音（4 声） ─────────────────────────
 * 由**真实 K 线**驱动（判据在 `main.js` 的 `soundFromTick`），不是逐笔成交流 ——
 * 本作没有其他市场参与者，`.bin` 里只有 OHLC ＋ 1 字节成交量份额。
 *
 * 三道闸（§2.5）：
 *   ① 优先级（`spike` > `surge` > `tick`）—— 在 `main.js` 里按帧判，同一帧同币只发一声；
 *   ② **节流窗** —— 在本文件里，同种音 120ms 内不重发（**只作用于行情音**）；
 *   ③ 发声范围（当前币 ＋ 持仓币）—— 在 `main.js` 里过滤。
 * ⚠️ 事件音**不节流**：爆仓 / 新闻 / 灾难被吞掉是不可接受的。 */

const lastAt = new Map();          // 音种 -> 上次发声的 performance.now()

/** 同种行情音是否已过节流窗（过了就记一笔并放行） */
function gate(kind) {
  if (!prefs.market) return false;
  const now = performance.now();
  if (now - (lastAt.get(kind) ?? -1e9) < MARKET_GAP) return false;
  lastAt.set(kind, now);
  return true;
}

/** 币价涨（当根收盘涨幅超阈值）：与 `open`（523→784 两度）同一基频族，但更短更轻 */
export const tickUp = () => { if (gate('tickUp')) tone({ f: 740, to: 988, dur: 0.06, type: 'triangle', gain: 0.035 }); };

/** 币价跌：与 `tickUp` 同基频反向 —— 听感上是一对 */
export const tickDown = () => { if (gate('tickDown')) tone({ f: 740, to: 555, dur: 0.06, type: 'triangle', gain: 0.035 }); };

/** 成交量异常放大：一记低频闷响（与 `pulse` 110→55 区分：更短、起音更高） */
export const surge = () => { if (gate('surge')) tone({ f: 150, to: 90, dur: 0.18, type: 'sine', gain: 0.05 }); };

/** 长插针（振幅超阈值）：一记尖锐的「针」，高频短促。
 *  ⚠️ 它是**插针**的声，不是「别人被爆仓」的声 —— 本作没有对手盘仓位数据（GDD 里有诚实声明）。 */
export const spike = () => { if (gate('spike')) tone({ f: 1760, to: 880, dur: 0.07, type: 'triangle', gain: 0.03 }); };

/* ───────────────────────── 事件音（8 声 · 不节流） ───────────────────────── */

/** 开局（开场弹窗的「开始交易」）：两声上行，正式开盘的那一下 */
export const begin = () => { tone({ f: 392, dur: 0.12, type: 'sine', gain: 0.05 }); tone({ f: 587, dur: 0.16, type: 'sine', gain: 0.05, at: 0.1 }); };

/** 通用轻点：所有按钮的默认反馈，短到几乎只是一声「嗒」 */
export const tap = () => tone({ f: 1200, dur: 0.025, type: 'triangle', gain: 0.02 });

/** 开仓：上行两度 */
export const open = () => { tone({ f: 523, dur: 0.09, type: 'triangle', gain: 0.05 }); tone({ f: 784, dur: 0.1, type: 'triangle', gain: 0.05, at: 0.07 }); };

/** 平仓：下行两度 */
export const close = () => { tone({ f: 784, dur: 0.09, type: 'triangle', gain: 0.05 }); tone({ f: 523, dur: 0.1, type: 'triangle', gain: 0.05, at: 0.07 }); };

/** 限价挂单**被动成交**（C8-B2）：比 `open` 更「远」—— 不是玩家亲手点的 */
export const fill = () => tone({ f: 660, to: 880, dur: 0.12, type: 'sine', gain: 0.045 });

/** 新闻 / 锚点播报：两声**定音**音铃（与 `notice` 的一声滑音上行区分） */
export const news = () => { tone({ f: 880, dur: 0.11, type: 'sine', gain: 0.045 }); tone({ f: 1174, dur: 0.2, type: 'sine', gain: 0.045, at: 0.12 }); };

/** 交易所灾难（Mt.Gox 归零 / Bitfinex 被盗削减）：比 `liq` 更闷更慢 —— 听感是「塌方」而非「被打穿」 */
export const crash = () => { tone({ f: 196, to: 98, dur: 0.5, type: 'sawtooth', gain: 0.06 }); tone({ f: 392, to: 196, dur: 0.32, type: 'triangle', gain: 0.05 }); };

/** 中性提示：币种上线 / 交易所开张 / BitMEX 恢复 / 转账到账 / **买 U 成功** —— 一声短上行 */
export const notice = () => tone({ f: 520, to: 780, dur: 0.09, type: 'triangle', gain: 0.04 });

/** 归一化安全垫跌破 0.2（红区），也复用给 BitMEX 停机维护 / 借款到期预警：两声低鸣，像警报 */
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