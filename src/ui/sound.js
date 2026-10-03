/**
 * 音效（Batch 4 · B20；T-1 · 2026-10-01 扩到 16 种）
 * ===============================================================
 * **零音频文件**：全部用 Web Audio 的振荡器现场合成。两条硬约束都指向这条路 ——
 * 项目「无第三方运行时依赖」＋ 手机首包体积预算（GDD §19.2）：一段 0.1 秒的波形
 * 比任何一个 mp3 都小，也不用多一个要上传、要缓存、要解码的二进制资源。
 *
 * 三条规矩：
 *   ① **偏好存独立的 localStorage 键**（`degen_settings`）—— 不进存档，否则重开会把偏好一起清掉；
 *   ② **懒建 AudioContext**：浏览器要求首次用户手势之后才允许出声，所以第一个声音
 *      必然来自一次点击（本作的开局按钮「开始交易」正好是这一下）；
 *   ③ **任何异常都不许往上冒**：浏览器不支持 / 上下文被挂起时静默变成「没声音」，
 *      绝不阻断玩法，也绝不把错误抛进主循环。
 *
 * 音色取向：短促、干脆、不刺耳。上涨用上行音程、下跌用下行音程 —— 不用听歌词也知道方向。
 *
 * ── T-1 的结构性改动 ──────────────────────────────────────────────
 *   ④ **主总线**：`osc → gain → 限幅器 → 主增益 → destination`。50x 下多声会叠在一起互相盖住，
 *      限幅器把它们压到同一条响度线下（照搬 aggr.trade 用 Tone.js 默认挂的那条思路，但零依赖）。
 *   ⑤ **两类音**：**事件音**（爆仓 / 新闻 / 灾难 / 到账…，由日志驱动，**永不节流**）
 *      与**行情音**（`marketMove` / `spike`，由 K 线驱动，**120ms 节流**）。
 *
 * ── T-2（2026-10-01 拍板）的三个可设置项 ──────────────────────────
 *   ⑥ **音量四档**（关 / 小 / 中 / 大）取代原来的「音效」开关键 —— 总闸就是它，关档＝静音。
 *   ⑦ **震动三档**（关 / 弱 / 强，默认**强**）：`navigator.vibrate`，移动端专属，与音量互不隶属。
 *   ⑧ **响度整体上调**：单音 gain 统一乘 `TONE_GAIN`，限幅器阈值抬到 −8dB —— 修「声音太小」。
 *      详见 `TONE_GAIN` 与 `busOf()` 的注释（旧参数把大半单音压在压缩拐点区往下削）。
 *
 * ── 沉浸层（2026-10-04 拍板，对标 aggr.trade / Bookmap 的订单流听感） ────
 *   ⑨ **行情音重做为 L1–L5**（见下方「行情音」一段）：强度分级 / 势头连击 / 空间化，
 *      外加两种**事件潮**（`liqWave` 爆仓潮 / `openWave` 开仓潮）。零音频文件、零依赖不变，
 *      也**不新增任何设置项** —— 全部挂在既有的「行情音」开关（`prefs.market`）下。
 */

const KEY = 'degen_settings';

/** 同一种行情音两响之间的最小间隔（**墙钟**毫秒，与游戏速度无关）。
 *  50x 下 1 真实秒 = 50 游戏小时，不节流就是机关枪 —— 这是三条闸里的第二条。 */
const MARKET_GAP = 120;

/* ───────────────────── 偏好（音量档 / 行情音 / 震动） ─────────────────────
 * ⚠️ **`degen_settings` 存的是 JSON**（T-1 起）。老版本存的是**裸字符串** `'mute'` / `'on'`，
 *    JSON 时代又只有 `{ mute, market }` 两个布尔 —— 两者都要能读（迁移见 `readPrefs`），
 *    否则老用户的静音设置会被吃掉。 */

/** 音量四档（2026-10-01 拍板，**取代**原来的「音效」开关键）—— 值即主增益倍率。
 *  「关」＝静音：它不再需要单独一个开关，一个档位就是总闸。 */
export const VOLUMES = [0, 0.55, 1, 1.7];   // 关 / 小 / 中 / 大
const DEFAULT_VOL = 2;                      // 默认「中」
const DEFAULT_VIB = 2;                      // 震动默认**强**（用户 2026-10-01 拍板）

/** 档位下标守卫：不是合法下标就落回默认档（存档 / localStorage 里的脏值不许把 UI 弄崩） */
const idx = (v, n, d) => (Number.isInteger(v) && v >= 0 && v < n ? v : d);

function readPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { vol: DEFAULT_VOL, market: true, vib: DEFAULT_VIB };
    if (raw === 'mute') return { vol: 0, market: true, vib: DEFAULT_VIB };              // 老格式：静音 ⇒ 音量关
    if (raw === 'on') return { vol: DEFAULT_VOL, market: true, vib: DEFAULT_VIB };       // 老格式：开声
    const o = JSON.parse(raw);
    return {
      vol: o.mute ? 0 : idx(o.vol, VOLUMES.length, DEFAULT_VOL),   // `mute: true` ⇒ 音量关
      market: o.market !== false,
      vib: idx(o.vib, 3, DEFAULT_VIB),
    };
  } catch { return { vol: DEFAULT_VOL, market: true, vib: DEFAULT_VIB }; }
}

const prefs = readPrefs();

function writePrefs() {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* 隐私模式：本次会话内有效即可 */ }
}

/** 当前音量档（0–3）。`0` ＝ 静音 —— 全模块只认这一个「关」。 */
export const getVol = () => prefs.vol;

export function setVol(v) {
  prefs.vol = idx(v, VOLUMES.length, DEFAULT_VOL);
  writePrefs();
  applyMaster();
  if (!prefs.vol && ac && ac.state === 'running') {
    // 立刻静音：挂起上下文比逐个停振荡器干净，恢复时也不会有一串残音排队
    try { ac.suspend(); } catch { /* 忽略 */ }
  }
}

/** 行情音开关（默认开）。它只管 `marketMove` / `spike` / `liqWave` / `openWave` —— 事件音不受它影响。 */
export const isMarketOn = () => prefs.market;

export function setMarketOn(v) {
  prefs.market = !!v;
  writePrefs();
}

/* ───────────────────────── 震动（移动端专属 · 2026-10-01） ─────────────────────────
 * 与音量**互不隶属**：关掉声音照样可以震，反之亦然（真实手机就是这么用的）。
 * 只用 `navigator.vibrate`，**零依赖、零资源**；不支持 / 被拒绝时静默跳过。
 *
 * ⚠️ 2026-10-03 修「Android 上摸不出来」（用户实机反馈）——三个真因：
 *   ① **绝大多数操作根本不震**：原来只有 7 处会震（日志事件 / 预警 / 结算 / 开平仓），
 *      而玩家日常的「切页 / 切币 / 点档位 / 换所」全都只走 `snd.tap()`。修法是把触感并进
 *      `main.dispatch()` 的通用反馈（见那里的 `buzz` 调用）。
 *   ② **弱档只有 12ms**：多数 Android 马达的有效最短时长在 20–40ms，12ms 常被驱动截断
 *      ⇒ 摸不着。全部提到 ≥ 25ms。
 *   ③ **连续 `navigator.vibrate()` 会互相取消**（新调用打断上一次的模式），而事件音 / 预警
 *      常在同一秒里连发。修法：`buzz()` 里加一层**去抖 ＋ 等级让路**（见下）。 */

/** 这台机器会不会真的震 —— 有 `navigator.vibrate` ＋ 有触点或粗指针。
 *  ⚠️ 2026-10-03：判定由「`pointer: coarse`」放宽到「`maxTouchPoints > 0` 或粗指针」——
 *     Android 开了「桌面版网站」、接了鼠标、或部分浏览器报错时，`pointer: coarse` 会变 false，
 *     原来会让设置页**整行消失**，玩家以为振动坏了（`buzz` 其实还在跑）。
 *     桌面浏览器没有马达 ⇒ 仍然不建这一行（桌面的 `maxTouchPoints` 通常是 0）。 */
export function vibSupported() {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
    if (Number(navigator.maxTouchPoints) > 0) return true;
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch { return false; }
}

/* 等级 × 力度 → 震动模式（毫秒）。
 *   `light` = 点一下（通用点按 / 开关）　`pick` = 选中（切页 / 切币 / 换所 / 选档）　`heavy` = 出事（爆仓 / 灾难 / 预警）。
 * ⚠️ 时长一律 ≥ 25ms —— 更短的模式在多数 Android 马达上会被截断到摸不出（文件头 ②）。
 * ⚠️ 强档用「三下（起-停-起）」：一次长震与一次短震在口袋里分不出来，三下才是可辨的。 */
const VIB = {
  light: [0, [25], [18, 50, 18]],
  pick: [0, [35], [24, 55, 24]],
  heavy: [0, [60], [50, 60, 50]],
};
const VIB_RANK = { light: 0, pick: 1, heavy: 2 };

/* 「试一下」用的一条加长模式（**不走档位**）：玩家点它就能确认硬件到底响不响 ——
   档位再调也都是几十毫秒，试不出来时很难分清是「关着」还是「手机不震」。 */
const VIB_TEST = [80, 60, 80, 60, 120];

const VIB_GAP = 60;        // 同一等级两震之间的最小间隔（墙钟毫秒，与 `MARKET_GAP` 同一口径）
let vibLastAt = 0;         // 上次真正下发的时刻
let vibLastKind = '';      // 上次下发的等级
let vibBusyUntil = 0;      // 上一次模式播完的时刻（在这之前只准更高等级打断）

export const getVib = () => prefs.vib;

export function setVib(v) {
  prefs.vib = idx(v, 3, DEFAULT_VIB);
  writePrefs();
}

/** 「试一下」：无视档位、无视音量，直接震一条加长模式（它就是用来确认硬件的）。 */
export function buzzTest() {
  try { if (navigator.vibrate) navigator.vibrate(VIB_TEST.slice()); } catch { /* 忽略 */ }
}

/** 震一下。`kind` = `'light'`（默认）/ `'pick'` / `'heavy'`。
 *  两条让路规则（文件头 ③）：① 上一次还在震时，只有**更高等级**能打断它；
 *  ② 同一等级连发按 `VIB_GAP` 去抖（连点 20 下不该震 20 下）。 */
export function buzz(kind = 'light') {
  if (!prefs.vib) return;
  const k = VIB[kind] === undefined ? 'light' : kind;
  const pat = VIB[k][prefs.vib];
  if (!pat) return;
  const now = performance.now();
  const rank = VIB_RANK[k];
  if (now < vibBusyUntil && rank <= (VIB_RANK[vibLastKind] ?? -1)) return;
  if (k === vibLastKind && now - vibLastAt < VIB_GAP) return;
  try {
    if (navigator.vibrate) navigator.vibrate(pat);
  } catch { /* 忽略：有的浏览器在无用户手势时会抛 */ }
  vibLastAt = now;
  vibLastKind = k;
  vibBusyUntil = now + pat.reduce((a, b) => a + b, 0);
}

/* ───────────────────────── 音频上下文 ＋ 主总线 ───────────────────────── */

let ac = null;
let bus = null;          // { comp, master }：主总线限幅器 ＋ 主增益；与 `ac` 同生命周期

/** 取（必要时新建并唤醒）音频上下文；音量关档或不可用时返回 null */
function audio() {
  if (!prefs.vol) return null;             // 音量关 = 总闸拉下
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
 * `osc → gain → comp → master → destination`。两条参数是为「响度」调的（T-2）：
 *   · `comp` 是**限幅器**（threshold −8 / knee 6 / ratio 12 / release 0.25s）——
 *     旧参数（−18 / 12 / 6）的拐点区在 [−30, −18]dB，而单音峰值正好落在那里被 6:1 往下压，
 *     等于每一声都被削一刀；抬到 −8 之后常态单音**不进压缩**，只有 50x 叠声时才限幅。
 *   · `master` 增益 = 当前音量档（`VOLUMES[prefs.vol]`）—— 档位切换只动这一个节点。
 */
function busOf(a) {
  if (!bus) {
    const comp = a.createDynamicsCompressor();
    comp.threshold.value = -8;
    comp.knee.value = 6;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    const master = a.createGain();
    master.gain.value = VOLUMES[prefs.vol];
    comp.connect(master).connect(a.destination);
    bus = { comp, master };
  }
  return bus.comp;
}

/** 音量档变了：把新倍率写进主增益（总线还没建就什么都不用做，建的时候会读现值）。 */
function applyMaster() {
  if (bus) bus.master.gain.value = VOLUMES[prefs.vol];
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 音序子总线（L3/L4 专用，2026-10-04）：自己的增益 ＋ 独立限幅器，再汇入主总线。
 *  一串潮音有 8~20 粒、彼此紧邻，若直接进主总线会把同时段的行情音/事件音顶到限幅里变闷。
 *  先在这里压到 0.6 并限幅，主总线那一层就只负责「总响度」。 */
let seqGain = null;
function seqOf(a) {
  if (!seqGain) {
    const g = a.createGain();
    g.gain.value = 0.6;
    const comp = a.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 8;
    comp.ratio.value = 8;
    comp.attack.value = 0.002;
    comp.release.value = 0.2;
    g.connect(comp).connect(busOf(a));
    seqGain = g;
  }
  return seqGain;
}

/**
 * 单音的整体响度倍数（T-2 修「声音太小」）。
 * 旧的 `gain`（0.02 点按 ～ 0.07 爆仓）换算成峰值只有 **−34dB ～ −23dB**，
 * 再叠上压缩器往下压与 0.9 的主增益，最终输出常有 −30dB —— 手机外放几乎听不见。
 * 统一乘 3.2（约 +10dB）把常态单音推回限幅器阈值之下、主增益之上，
 * 由**音量档**决定最终大小，而不是由每个音自己的常量凑。
 */
const TONE_GAIN = 3.2;

/**
 * 一枚短音。`to` 给频率滑到哪（不给就是不滑，走固定音高）。
 * 包络两端都用 `exponentialRampToValueAtTime`：指数衰减听起来才像「敲一下」，
 * 线性衰减会拖出一条尾巴。⚠️ 指数斜坡的目标值**不能是 0**（规范里是非法值），所以写 0.0001。
 *
 * @param {number} pan  L5 空间化：−1 全左 ～ +1 全右（0 = 居中，默认）。
 * @param {boolean} seq 走音序子总线（L3/L4 的潮音）而不是直连主总线。
 */
function tone({ f, to = 0, dur = 0.08, type = 'triangle', gain = 0.05, at = 0, pan = 0, seq = false }) {
  const a = audio();
  if (!a) return;
  const t0 = a.currentTime + at;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(30, to), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain * TONE_GAIN, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  /* L5 空间化（2026-10-04）：涨 / 买偏左耳、跌 / 卖偏右耳。耳朵比图早两秒分辨出方向 ——
     这是订单流听感里最便宜的一刀（TickPro 的「买左卖右」）。不支持的老浏览器静默跳过，
     单声道照响，绝不因为一个可选节点把整条发声链抛掉。 */
  let tail = g;
  if (pan && typeof a.createStereoPanner === 'function') {
    const p = a.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    g.connect(p);
    tail = p;
  }
  tail.connect(seq ? seqOf(a) : busOf(a));
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/* ───────────────────────── 行情音（L1–L5 · 2026-10-04 重做） ─────────────────────────
 * 由**真实 K 线**驱动（判据在 `main.js` 的 `marketSounds`），不是逐笔成交流。
 *
 *   L1 **强度分级**：`i ∈ 0..1` 驱动**音数 / 音程跨度 / 响度 / 音色亮度**；`i < 0.15` 不发声
 *      （把「噪音」挡在外面 —— 每一根小波动都响就是噪音，不是信息）。
 *   L2 **势头连击**：同向连击踩着五声音阶（`PENTA`）逐级上行，换向清零并给一记低音「换挡」。
 *   L5 **空间化**：涨 / 买偏左耳、跌 / 卖偏右耳（见 `tone` 的 `pan`）。
 *   `spike`（长插针）仍单列：它比涨跌更紧急 —— 强平看的是最低价 `l`，不是收盘价。
 *
 * ⚠️ 三道闸不变：① 优先级 —— 在 `main.js` 里按帧判，同一帧**全体**只发一声；
 *    ② **节流窗** —— 在本文件里，`MARKET_GAP` 内不重发（**只作用于行情音**）；
 *    ③ 发声范围（当前币 ＋ 持仓币）—— 在 `main.js` 里过滤。
 * ⚠️ 事件音**不节流**：爆仓 / 新闻 / 灾难被吞掉是不可接受的。
 *
 * 音色取向仍是「短促、干脆、不刺耳」，只是从「一种行情一个固定音效」升级成
 * 「一个**连续量**（方向 × 强度）映射到一簇参数」—— 这是 aggr.trade 那种「听得出这一笔有多重」
 * 的落点（响度 ∝ 规模），而不是给每种行情各录一个采样。 */

const lastAt = new Map();          // 音种 -> 上次发声的 performance.now()

/** 行情音节流窗是否已过（过了就记一笔并放行）。`gap` 可放宽给「潮」用。 */
function gate(kind, gap = MARKET_GAP) {
  if (!prefs.market) return false;
  const now = performance.now();
  if (now - (lastAt.get(kind) ?? -1e9) < gap) return false;
  lastAt.set(kind, now);
  return true;
}

/** 十二平均律：一个半音的频率比 */
const SEMI = 2 ** (1 / 12);
/** 大调五声音阶（半音偏移）。五声比七声「干净」，连击叠起来也不会糊成一团。 */
const PENTA = [0, 2, 4, 7, 9];
/** 第 `n` 级（可跨八度）的五声音阶频率：`base` × 2^(半音 / 12)。 */
const pentaFreq = (base, n) => base * 2 ** ((PENTA[((n % 5) + 5) % 5] + 12 * Math.floor(n / 5)) / 12);

/* L2 的连击状态：同向一步步往上爬，换向就清零重来。 */
let combo = 0;        // 同向连击数
let lastDir = 0;      // 上一次的方向（0 = 还没响过）

/**
 * 行情音（L1 ＋ L2 ＋ L5）。`main.js` 每帧**至多调一次**（它已把一帧跨过的所有根、所有币
 * 压成一个「最强的那一下」）。
 * @param {1|-1} dir 方向（涨 / 跌）
 * @param {number} i  强度 0..1（< 0.15 不发声）
 * @param {boolean} hot 是否「量能异常」（份额 ≥ 3/24）—— 追加一记低频闷响
 */
export function marketMove(dir, i, hot = false) {
  if (!prefs.market) return;
  if (!(i >= 0.15)) { combo = 0; return; }
  if (!gate('market')) return;
  const up = dir > 0;
  if (up !== (lastDir > 0)) {
    /* L2 换向：清零 ＋ 一记低音「换挡」—— 玩家不看屏也能听出「这一波掉头了」。 */
    combo = 0;
    tone({ f: up ? 150 : 190, to: up ? 230 : 128, dur: 0.12, type: 'sine', gain: 0.03, pan: up ? -0.45 : 0.45 });
  }
  lastDir = dir;
  const step = combo++;
  const pan = up ? -0.5 : 0.5;
  const base = up ? 494 : 622;                    // 上行基音偏低、下行偏高 —— 两条曲线分开音区
  const notes = 1 + Math.round(i * 2);            // 弱 1 声 / 中 2 声 / 强 3 声
  const span = 1 + Math.round(i * 3);             // 连击的跨度也随强度拉开
  for (let k = 0; k < notes; k++) {
    tone({
      f: pentaFreq(base, step + k * span),
      dur: 0.05 + 0.03 * i,
      type: i > 0.6 ? 'sawtooth' : 'triangle',    // 越强越亮
      gain: ((0.028 + 0.03 * i) / notes) * 1.6,
      at: k * 0.045,
      pan,
    });
  }
  if (hot) tone({ f: 160, to: 90, dur: 0.16, type: 'sine', gain: 0.04, pan });
}

/** 长插针（振幅超阈值）：一记尖锐的「针」，高频短促，强度决定落点高低。 */
export const spike = (i = 0.5) => {
  if (!gate('market')) return;
  combo = 0;
  lastDir = 0;
  tone({ f: 1700 + 500 * clamp(i, 0, 1), to: 880, dur: 0.07, type: 'triangle', gain: 0.03 });
};

/* ── L3 / L4：事件潮（爆仓潮 / 开仓潮）────────────────────────────────────
 * 现实里的强平不是「一声钟」，是一串爆豆子 —— 间隔 30~90ms **随机**才是那个听感
 * （Bookmap 的 Market Pulse 就是这个隐喻：越密 = 越近、越响 = 越重）。
 * ⚠️ 走**独立子总线**（`seqOf`）：粒多且彼此叠，先在自己那一层压一档再汇入主总线。
 * ⚠️ 节流窗比行情音长得多：潮是**一件事**，不该每帧重来一遍。 */

const WAVE_GAP = 2500;        // 两次「潮」之间的最小间隔（墙钟毫秒）

/** 一串短音：`dir` = ±1（+ 开仓上行 / − 爆仓下坠），`n` 粒、起点频率落在 `[f0, f1)`。 */
function grains({ n, dir, f0, f1, at0 = 0.1, gain = 0.028, pan = 0 }) {
  let t = at0;
  for (let k = 0; k < n; k++) {
    const f = f0 + Math.random() * (f1 - f0);
    tone({
      f,
      to: dir > 0 ? f * 1.7 : f * 0.5,
      dur: 0.05,
      type: 'triangle',
      gain,
      at: t,
      pan,
      seq: true,
    });
    t += 0.03 + Math.random() * 0.06;             // 30~90ms 随机
  }
}

/** L3 爆仓潮：低频下坠打头 ＋ 一串随机下坠的短音（粒数 / 密度随烈度）。 */
export function liqWave(power = 0.75) {
  if (!gate('wave', WAVE_GAP)) return;
  const p = clamp(power, 0, 1);
  tone({ f: 420, to: 70, dur: 0.5, type: 'sawtooth', gain: 0.06, pan: 0.35, seq: true });
  grains({ n: 8 + Math.round(12 * p), dir: -1, f0: 620, f1: 1240, gain: 0.024 + 0.012 * p, pan: 0.4 });
}

/** L4 开仓潮：L3 的镜像 —— 上行打头 ＋ 一串落在**偏高音区**的上行短音。 */
export function openWave(power = 0.7) {
  if (!gate('wave', WAVE_GAP)) return;
  const p = clamp(power, 0, 1);
  tone({ f: 300, to: 760, dur: 0.28, type: 'triangle', gain: 0.045, pan: -0.35, seq: true });
  grains({ n: 8 + Math.round(12 * p), dir: 1, f0: 900, f1: 1700, gain: 0.02 + 0.012 * p, pan: -0.4 });
}

/* ───────────────────────── 事件音（8 声 · 不节流） ───────────────────────── */

/** 开局（开场弹窗的「开始交易」）：两声上行，正式开盘的那一下 */
export const begin = () => { tone({ f: 392, dur: 0.12, type: 'sine', gain: 0.05 }); tone({ f: 587, dur: 0.16, type: 'sine', gain: 0.05, at: 0.1 }); };

/** 通用轻点：所有按钮的默认反馈，短到几乎只是一声「嗒」 */
export const tap = () => tone({ f: 1200, dur: 0.025, type: 'triangle', gain: 0.02 });

/** 切页（交易 / 资产 / 设置）：一记更闷更短的声，与「点按」区分开 —— 玩家不看屏也知道换页了。 */
export const tab = () => tone({ f: 660, dur: 0.03, type: 'sine', gain: 0.03 });

/** 选中（切币 / 换所 / 选杠杆档 / 切粒度）：轻微上行二音，听感是「咔哒一下换到位」。 */
export const pick = () => {
  tone({ f: 880, dur: 0.035, type: 'triangle', gain: 0.03 });
  tone({ f: 1174, dur: 0.05, type: 'triangle', gain: 0.028, at: 0.03 });
};

/** 被拒（开仓失败 / 条件不满足）：一记短促下行 —— 原来失败也走 `tap`，**与成功同声**，分不出对错。 */
export const deny = () => tone({ f: 220, to: 165, dur: 0.12, type: 'square', gain: 0.03 });

/** 开仓：上行两度 */
export const open = () => { tone({ f: 523, dur: 0.09, type: 'triangle', gain: 0.05 }); tone({ f: 784, dur: 0.1, type: 'triangle', gain: 0.05, at: 0.07 }); };

/** 平仓：下行两度 */
export const close = () => { tone({ f: 784, dur: 0.09, type: 'triangle', gain: 0.05 }); tone({ f: 523, dur: 0.1, type: 'triangle', gain: 0.05, at: 0.07 }); };

/** 新闻 / 锚点播报：两声**定音**音铃（与 `notice` 的一声滑音上行区分） */
export const news = () => { tone({ f: 880, dur: 0.11, type: 'sine', gain: 0.045 }); tone({ f: 1174, dur: 0.2, type: 'sine', gain: 0.045, at: 0.12 }); };

/** 交易所灾难（交易所归零 / Bitfinex 被盗削减）：比 `liq` 更闷更慢 —— 听感是「塌方」而非「被打穿」 */
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