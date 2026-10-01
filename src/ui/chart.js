/**
 * K 线绘制（Canvas 2D，GDD §19.1）
 * ===============================================================
 * 画「最近 N 根 K 线 ＋ 底部成交量柱 ＋ 一条当前价水平线 ＋ 一条持仓开仓价水平线」。
 * 不画均线、不画指标、不画图例 —— GDD §3「Less is More」。
 *
 * ⚠️ 坐标全部乘 `dpr` 后再 `ctx.scale(dpr, dpr)`：手机上 devicePixelRatio 是 2~3，
 *    不补这一刀，K 线会糊成一团。
 *
 * ⚠️ **颜色不在这里写死** —— 唯一真源是 `style.css` 的 `:root`（见下方 `theme()`）。
 *    曾经这里硬编码过一份副本，结果改 CSS 变量时 K 线的网格线和轴标签没跟着变。
 *
 * ⚠️ **价格 ↔ 像素的换算只在本文件里做**（`yOf` 是唯一真源）。视野状态（看第几根、缩放、
 *    y 平移）由 `view.js` 持有并传进来，但 **y 平移的限位必须在换算的同一处夹**
 *    —— 所以本函数会把「实际生效的 yPx」返回给调用方写回视野状态，见下方 `yPx` 段。
 *
 * ⚠️ **量柱是叠在 K 线上的展示层**（Batch 4 · B15）：价格区**吃满** `plotH`，量柱贴底、
 *    **半透明盖在 K 线之上**（图层二）。量柱与自己那根 K 线**同宽同色**，所以只会把背景压出一段
 *    「暗一档的柱身」，不会把相邻的 K 线染花；最大柱高另有上限（`VOL_MAX`），
 * 保证它不侵入 K 线的躯干密集区。柱高只服务观感，不参与任何玩法。
 */

import { fmtMoneyShort } from '../core/format.js';

/** 右侧价格标签宽（`view.js` 算单根 K 线宽度时要用同一份，故导出） */
export const PAD_R = 52;
/** 底部留白（右侧价格标签高 18px，贴边会被切掉） */
const PAD_B = 16;
/** 顶部留白的**兜底值**（Batch 5 · B27）：真实值由调用方按左上角遮罩实测高度传进来（`o.topInset`），
 *  遮罩量不到时才退回这里 —— 10px 只是轴标签半高，遮罩有 28px 高，光靠它标签会被压进遮罩底下。 */
const PAD_TOP = 10;
/** 量柱**最大**高度占绘图高度的比例（Batch 4 · B15）—— 纯展示层，只服务观感。
 *  ⚠️ 取 **1/4** 而不是「先定 28% 再由上限兜」：实测这台机型画布高 214px（`plotH ≈ 186`），
 *     28% ⇒ 52px 的色带，比改版前那条约 45px 的量区明显更高、更抢戏；25% ⇒ 47px，
 *     与玩家已经认可的观感基本重合。「纯展示层不超过价格区 1/4」这条原则因此**由比例自己守住**，
 *     上限 `VOL_MAX` 只在超高的画布上才起作用（见下）。 */
const VOL_RATIO = 0.25;
/** 量柱最大高度的下限（px）：矮屏（plotH≈100）也保证柱身有辨识高度，不退化成一条线 */
const VOL_MIN = 20;
/** 量柱最大高度的上限（px）：高屏（`plotH > 256`）不让量区跟着无限长高 —— 纯展示层不该超过价格区 1/4 */
const VOL_MAX = 64;
/** 量柱透明度：盖在 K 线上（Batch 4 · B15）。0.30 下是「压暗的同色带」，
 *  与**不透明**的 K 线天然分两档 —— 同色相也不糊，这正是「不与价格混为一体」的落点。 */
const VOL_ALPHA = 0.30;

/** 画布要用的 CSS 变量名。键名只在本文件里用，值就是 `:root` 里那个变量。 */
const THEME_VARS = {
  UP: '--up',        // 涨
  DOWN: '--down',    // 跌
  MUT: '--mut',      // 次级文字（轴标签、无数据提示）
  FG: '--fg',        // 正文
  GOLD: '--gold',    // 开仓价
  LINE: '--line',    // 网格线
  PV_SPOT: '--pv-spot',   // 量柱里**玩家自己的现货**那一段（v20）
  PV_FUT: '--pv-fut',     // 量柱里**玩家自己的合约**那一段（v20）
};

let themeCache = null;

/** 量柱 P90 的缓存（用户 2026-10-01 拍板）—— `windowFor` 每帧重建 `vols` 数组，
 *  所以不能用数组引用当键，改由调用方给一个「这份视野是谁」的字符串（`o.cacheKey`）。
 *  量柱是**原始成交额**、与价格位移无关，所以同一个键下 P90 恒定。 */
let p90Cache = { key: '', v: 0 };

/**
 * 把 `:root` 的变量读成计算值并缓存。
 * canvas 不认 `var()`，只能读一次字符串。样式表是 `<head>` 里的阻塞 `<link>`，
 * 首帧执行前就已生效，不存在读到空值的情况。
 *
 * ⚠️ 缓存**不再是终身有效**的（B5 起）：设置页可以把涨跌色对调（`<html>.red-up`），
 *    那是 `:root` 上的一次真实变化 ⇒ 切换时必须调一次 `resetTheme()`。
 */
function theme() {
  if (!themeCache) {
    const cs = getComputedStyle(document.documentElement);
    themeCache = {};
    for (const key in THEME_VARS) themeCache[key] = cs.getPropertyValue(THEME_VARS[key]).trim();
  }
  return themeCache;
}

/** 丢弃缓存的颜色，下一次绘制重新从 `:root` 取（涨跌色切换时由 `main.js` 调用） */
export function resetTheme() { themeCache = null; }

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 价格轴的小数位：跟 `format.fmtPrice` 同一套口径，但更短（标签位只有 50px） */
function axisLabel(p) {
  const a = Math.abs(p);
  if (a >= 10000) return (p / 1000).toFixed(1) + 'k';
  if (a >= 1000) return p.toFixed(0);
  if (a >= 100) return p.toFixed(1);
  if (a >= 1) return p.toFixed(2);
  if (a >= 0.01) return p.toFixed(4);
  return p.toFixed(6);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} o
 *   candles  Array<{o,h,l,c}>  视野内的小时线（或日线聚合），已按时间升序，最后一个是当前根
 *   vols     Array<number>     与 `candles` 一一对齐的**绝对美元成交额**（0 = 该根无成交）
 *   pvols    Array<{spot,fut}> 与 `candles` 一一对齐的**玩家自己那一份**（v20）：
 *                              `spot + fut` 恒 ≤ `vols[k]`，只用来把量柱的下半段**换个色**画出来
 *                              （现货 / 合约各一色）—— 不给高度、不改归一化口径。
 *   mark     number            当前价（画水平线）
 *   entry    number|null       持仓开仓价
 *   side     'long'|'short'|null
 *   liq      number|null       强平价（现货传 null）
 *   slots    number            本帧视野的**槽位数**（= `view.js` 的 `count`）。
 *                              ⚠️ 不等于 `candles.length`：币种刚上线时可用根数少于 `count`，
 *                              柱宽必须按槽位算、柱子**右对齐**，否则开局那 1 根 K 线会撑满整屏（B22）。
 *   anchors  Array<{d:number}>  历史锚点刻度（P2-C）：`d` = **显示单位**下的序号，
 *                              `1h` 模式是小时序号、`1d` 模式是天序号。
 *   right    number            视野**最右那根**的显示单位序号 —— 把 `d` 换算成槽位要用它。
 *   cacheKey string            量柱 P90 的缓存键（`sym|mode|right|count`，见 `p90Cache`）。不给就不缓存。
 *   topInset number            顶部留白 = 左上角遮罩的实测高度（B27）。不传则退回 `PAD_TOP`。
 *   cssW/cssH number           容器尺寸（CSS 像素）
 *   yPx      number            价格轴的垂直平移（像素，向下为正；`view.js` 持有）
 * @returns {number} **实际生效的 `yPx`**（被限位夹过）—— 调用方必须写回视野状态，
 *                   否则玩家一直往同一边拖时状态里的值会越滚越大，松手再按就从远处跳回来。
 */
export function drawChart(canvas, o) {
  const { candles, vols, pvols, mark, entry, side, liq, anchors, right } = o;
  const T = theme();
  const dpr = Math.min(3, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1);
  const W = Math.max(1, Math.round(o.cssW));
  const H = Math.max(1, Math.round(o.cssH));

  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const plotW = Math.max(1, W - PAD_R);
  // ⚠️ 顶部留白 = **左上角遮罩的实测高度**（Batch 5 · B27，2026-09-29）。
  //    原来写死 10px（= 轴标签半高 ＋ 余量，Batch 1 · B5 为解决「最上一档标签被切掉」而设），
  //    但遮罩有 ≈28px 高 ⇒ 最上档轴标签、开仓价签、强平价签**整块躺在 72% 不透明的遮罩底下**，
  //    看起来就是「强平价显示不全」。真正的病根是这里，不是画布高度不够。
  const topInset = Number.isFinite(o.topInset) && o.topInset > 0 ? o.topInset : PAD_TOP;
  const plotH = Math.max(1, H - PAD_B - topInset);
  const top = topInset;
  const bot = top + plotH;              // 价格区下沿 = 量柱基线（贴住最下面那根网格线）
  // 价格区**吃满** plotH（Batch 4 · B15，原先是「价格 78% + 量区 22%」上下分栏）；
  // 量柱改成叠在 K 线上的展示层，这里的 volH 是**量柱最大高度**，不再是分栏高度。
  const volH = clamp(Math.round(plotH * VOL_RATIO), VOL_MIN, VOL_MAX);

  if (!candles || !candles.length) {
    ctx.fillStyle = T.MUT;
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('无行情数据', plotW / 2, H / 2);
    return 0;
  }

  // ── 价格轴范围：只由**视野内的 K 线**决定 ──
  // ⚠️ **开仓价与当前价都不参与这里**：并进来以后，它们离 K 线越远、K 线被压得越扁。
  //    开仓价改成只把线「夹到画布边缘」（见下方开仓线那一段）；当前价本来就在某根 K 线里，
  //    且**平移到过去之后必须不再参与**（否则回到 2013 年还在按 2024 的价自动缩放）。
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) {
    if (c.l < lo) lo = c.l;
    if (c.h > hi) hi = c.h;
  }
  if (!(hi > lo)) { hi = lo * 1.001 + 1e-9; lo = lo * 0.999 - 1e-9; }
  const dataLo = lo, dataHi = hi;       // 未加留白的数据极值（y 限位要用）
  const dataRange = hi - lo;
  const padY = dataRange * 0.06;
  lo -= padY; hi += padY;
  const span = hi - lo;

  // ── y 平移 ＋ **严格限位**（Batch 3 · B14，2026-09-29 拍板「严格」） ──
  // 屏幕下移（yPx > 0）＝ 同一价格落到更大的 y ⇒ 窗口整体上移 ⇒ lo/hi 变小。
  // 限位：平移后视野里**至少有一根 K 线完整可见**（不许拖成空屏）。价格窗口高 `span`，
  // 判据是「某根 K 线的 [l, h] 整个落在窗口内」，于是中心的合法区间是
  //   - 上界：窗口上沿贴住数据最高价 ⇒ 只剩最高那根（`cMin`）
  //   - 下界：窗口下沿贴住数据最低价 ⇒ 只剩最低那根（`cMax`）
  // ⚠️ 行程只有 `span - dataRange` ＝ 6% 留白的两倍，也就是价格区高度的约 1/9 ——
  //    **这是「自动适配价格轴 ＋ 不许拖成空屏」两条规则直接推出来的结果**，
  //    不是 bug：轴每帧都按视野内的 K 线重新适配，本来就没有多少可平移的余地。
  //    要更大行程就得放宽判据（比如「允许留白半屏」），届时改这两行即可。
  // `Math.min/max` 排在两边：万一日后 `span ≤ dataRange`（现在不会），区间不反号。
  let shift = 0;
  const wantY = Number.isFinite(o.yPx) ? o.yPx : 0;
  if (wantY !== 0) {
    const center0 = (lo + hi) / 2;
    const cMin = dataHi - span / 2;
    const cMax = dataLo + span / 2;
    shift = clamp(center0 - wantY * (span / plotH), Math.min(cMin, cMax), Math.max(cMin, cMax)) - center0;
    lo += shift; hi += shift;
  }
  const yOf = p => top + (hi - p) / span * plotH;

  // ⚠️ 柱宽按**槽位数**算、柱子**右对齐**（Batch 5 · B22，2026-09-29）。
  //    原来 `cw = plotW / n`（n = 实际根数）：币种刚上线时只有 1~2 根可用 ⇒ 那 1 根会撑满整屏。
  //    改成按 `slots`（= 视野要的根数）算之后，柱宽恒定；前 `slots − n` 个槽位留白，
  //    **最新那一根永远贴住右端**（与现价线贴右端同一口径），日线模式第一天同理。
  const n = candles.length;
  const slots = Math.max(n, Math.round(o.slots || n));
  const cw = plotW / slots;
  const bw = Math.max(1, Math.min(cw - 1, 13));
  const xAt = k => (slots - n + k) * cw + cw / 2;

  // ── 网格线 + 右侧价格标签（三档，只铺在价格区） ──
  ctx.font = '12px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let g = 0; g <= 3; g++) {
    const p = lo + span * (g / 3);
    const y = Math.round(yOf(p)) + .5;
    ctx.strokeStyle = T.LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(plotW, y);
    ctx.stroke();
    ctx.fillStyle = T.MUT;
    ctx.fillText(axisLabel(p), plotW + 6, y);
  }

  // ── K 线本体（图层一） ──
  for (let k = 0; k < n; k++) {
    const c = candles[k];
    const up = c.c >= c.o;
    const col = up ? T.UP : T.DOWN;
    const x = xAt(k);
    const yH = yOf(c.h), yL = yOf(c.l);
    const yO = yOf(c.o), yC = yOf(c.c);

    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + .5, yH);
    ctx.lineTo(Math.round(x) + .5, yL);
    ctx.stroke();

    const yTop = Math.min(yO, yC);
    const hBody = Math.max(1, Math.abs(yC - yO));
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(x - bw / 2), Math.round(yTop), Math.round(bw), Math.round(hBody));
  }

  // ── 成交量柱（图层二：**盖在 K 线之上**，Batch 4 · B15） ──
  // 柱高按**视野内的 P90**归一化（Batch 5 · B29，2026-09-29），不再是最大值：
  //   份额是日内相对量，绝对量跨 7 个数量级，所以必须按视野自适应；
  //   但用 `vmax` 时，视野里只要出现一根极端柱（2017-12 / 2021-04），其余几十根全被压到几像素，
  //   **看不见就等于没有**（量区是纯展示层）。取 P90 之后约 90% 的柱子保留真实相对高低，
  //   超过 P90 的少数巨量柱封顶 —— 仍是最高的那一档，一眼可辨。
  //   ⚠️ 视野内没有极端柱时 `vp90 ≈ vmax` ⇒ **自动退化成改版前的口径**，只在本来就读不出来时才生效。
  // 无成交的根不画（柱高 0）。量区不画网格、不加轴标签 —— LESS IS MORE。
  // ⚠️ 柱宽与柱心的取法与 K 线**完全一致** ⇒ 每根量柱正好盖住它自己那一根 K 线；
  //    同色叠加下 K 线躯干看不出变化，只有背景被压出「暗一档的柱身」。
  const V = vols || [];
  let vmax = 0;
  const nz = [];
  for (const v of V) if (v > 0) { nz.push(v); if (v > vmax) vmax = v; }
  let vscale = vmax;
  if (nz.length >= 10) {
    /* ⚠️ P90 缓存（用户 2026-10-01 拍板）：同视野下每帧重排一次纯属浪费 ——
       键由调用方给（`cacheKey`），命中就直接复用。 */
    const key = o.cacheKey;
    if (key && p90Cache.key === key) {
      vscale = p90Cache.v;
    } else {
      nz.sort((a, b) => a - b);
      vscale = nz[Math.min(nz.length - 1, Math.ceil(0.9 * nz.length) - 1)];   // 最近秩法 P90
      if (key) p90Cache = { key, v: vscale };
    }
  }
  const PV = pvols || [];
  const bx = new Array(n);                       // 每根柱子的左沿与柱宽（两遍画法共用）
  for (let k = 0; k < n; k++) bx[k] = Math.round(xAt(k) - bw / 2);
  if (vscale > 0) {
    ctx.save();
    ctx.globalAlpha = VOL_ALPHA;
    for (let k = 0; k < n; k++) {
      const v = V[k];
      if (!(v > 0)) continue;
      const c = candles[k];
      const r = Math.min(1, v / vscale);
      const h = Math.max(1, Math.round(r * volH));
      ctx.fillStyle = c.c >= c.o ? T.UP : T.DOWN;
      ctx.fillRect(bx[k], bot - h, Math.round(bw), h);
    }
    ctx.restore();
  }

  // ── 玩家自己那一段：**只换色、不改高度**（v20 · 用户 2026-10-01 拍板） ──
  // 高度仍按同一把尺（`vscale` / `volH`）量，所以柱顶一格不动；变的是**下半段**的色相：
  //   现货 = `--pv-spot`、合约 = `--pv-fut`，两段从基线往上叠（现货在下、合约在上）。
  // ⚠️ 为什么原来的玩家量「看不见」（2026-10-01 诊断结论）：柱高按**视野内 P90** 归一化
  //    （B29），一屏 68 根小时线里市场自己的成交额动辄几万到几十亿美元，玩家那一笔被压到
  //    十几像素 —— **不是没接进来，而是被同一根柱子里的市场量淹了**。分色之后即使高度不变，
  //    也能一眼看出「这根里有多少是我的」。
  // ⚠️ 本段用**不透明**（不吃 `VOL_ALPHA`）：量柱本体是 .30 的「压暗同色带」，玩家段若也压暗
  //    就与涨跌色糊在一起。不透明 ≠ 改高度，柱顶仍由 `vols` 决定。
  if (vscale > 0) {
    for (let k = 0; k < n; k++) {
      const p = PV[k];
      if (!p) continue;
      const tot = p.spot + p.fut;
      if (!(tot > 0)) continue;
      const barH = Math.max(1, Math.round(Math.min(1, V[k] / vscale) * volH));
      // 玩家的整段高度（封在柱内 —— `tot ≤ V[k]` 数学上恒成立，这里是浮点兜底）
      const hAll = Math.min(barH, Math.max(1, Math.round(Math.min(1, tot / vscale) * volH)));
      let seg;
      if (p.spot > 0 && p.fut > 0) {
        // 两段都有：按占比切，两段各留 1px 最小可见高度
        const hs = Math.max(1, Math.min(hAll - 1, Math.round(hAll * (p.spot / tot))));
        seg = [[T.PV_SPOT, hs], [T.PV_FUT, hAll - hs]];
      } else {
        seg = [[p.spot > 0 ? T.PV_SPOT : T.PV_FUT, hAll]];
      }
      let y = bot;
      for (const [col, sh] of seg) {
        y -= sh;
        ctx.fillStyle = col;
        ctx.fillRect(bx[k], y, Math.round(bw), sh);
      }
    }
  }

  // ── 历史锚点刻度（P2-C · 裁决 ④：**全部锚点都画在当前币上**） ──
  // 新闻是全市场的（Luna / FTX 这类 `chain: null` 的事件本来就不属于任何一条链），
  // 看哪条 K 线都该看见同一批历史节点 —— 按链过滤反而要多一套规则，收益不抵成本。
  // ⚠️ 必须画在 K 线**之上**：默认密度下柱宽 ≈ 4px、刻度正好落在柱心，画在下面就整条被柱身盖住。
  //    1px 淡色 ＋ 不可交互（移动端没有 hover，不做 tooltip），拖动/缩放照旧不受影响。
  if (anchors && anchors.length && Number.isFinite(right)) {
    ctx.save();
    ctx.strokeStyle = T.MUT;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    for (const a of anchors) {
      const k = n - 1 - (right - a.d);          // 最右那根恒等于 `k = n − 1`
      if (k < 0 || k >= n) continue;            // 视野外的锚点（`slots > n` 时会算到负数）
      const x = Math.round(xAt(k)) + .5;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bot);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── 开仓价（金色虚线，画在当前价之前，避免盖住它） ──
  // 开仓价**不在**价格轴范围内（见上），所以线只做一件事：**夹到价格区的上沿或下沿**。
  // 开仓价低于现价 ⇒ y 落到下沿；高于现价 ⇒ 落到上沿。价格本身仍写在右端小标签里，贴边不丢信息。
  if (Number.isFinite(entry)) {
    const y = Math.round(clamp(yOf(entry), top, bot)) + .5;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = T.GOLD;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(plotW, y);
    ctx.stroke();
    ctx.restore();
    // 右端一枚小标签：方向 + 开仓价。
    // ⚠️ 标签矩形要**单独**再夹一次（它高 16px）—— 线贴到价格区上/下沿时，不夹就会有一半被切掉。
    //    夹取的**下界必须是 `top + 8`**（Batch 5 · B27）：原来写死 `8`，而 `top` 现在等于遮罩高度
    //    （≈28px）⇒ 标签矩形会落到 y ∈ [1,17]、**整块躺在遮罩底下**，这正是「强平价显示不全」的原因。
    const tag = (side === 'short' ? '空 ' : '多 ') + axisLabel(entry);
    ctx.font = '12px ui-monospace, monospace';
    const tw = ctx.measureText(tag).width + 6;
    const ty = Math.round(clamp(y, top + 8, bot - 8)) + .5;
    ctx.fillStyle = T.GOLD;
    ctx.fillRect(plotW - tw, ty - 8, tw, 16);
    ctx.fillStyle = '#1a1405';
    ctx.textAlign = 'left';
    ctx.fillText(tag, plotW - tw + 3, ty);

    // ── 强平价：**贴在开仓线的左端**（Batch 2 · B9，2026-09-29） ──
    // 为什么搬到这里：原来它和保证金率挤在持仓条第三格里，两个数一起被 `text-overflow` 截断。
    // 图上这条开仓线本来就横跨整个画布，**左端是空的** —— 放这儿既不占布局、又天然离 K 线最近。
    // 用 `--down` 红标（在与不在，强平价都是风险信号），与右端金色的开仓价一眼分得开。
    // 它挂的是**开仓线的 y**：强平价在中长仓里通常远在可视区间之外，单独画线只会永远贴在画布边缘。
    //
    // ⚠️ **避开左下角**（Batch 4 · B16）：`style.css` 的 `.chart-side`（锁视野提示 / 在途倒计时）
    //    这一版搬到了 K 线左下角，而强平标签也画在左端 —— 落进那一带就**上移一行**，
    //    两者永远不重叠（浮字是 DOM、标签是画布，后者在下面，重叠就是被吃掉）。
    if (Number.isFinite(liq)) {
      const ltag = '强 ' + axisLabel(liq);
      const lw = ctx.measureText(ltag).width + 6;
      const ly = ty > bot - SIDE_RESERVE ? Math.max(top + 8, ty - SIDE_SHIFT) : ty;
      ctx.fillStyle = T.DOWN;
      ctx.fillRect(0, ly - 8, lw, 16);
      ctx.fillStyle = '#1a0508';
      ctx.textAlign = 'left';
      ctx.fillText(ltag, 3, ly);
    }
  }

  // ── 当前价（实线 + 右端高亮标签） ──
  // **总是画**：平移到过去之后当前价可能整条落在视野之外，那就把它夹到价格区边缘 ——
  // 贴边的标签仍然报着真价，玩家不会「以为没在持仓」。原来是越界就整条消失，反而更容易误读。
  if (Number.isFinite(mark)) {
    const y = Math.round(clamp(yOf(mark), top, bot)) + .5;
    const last = candles[n - 1];
    const col = last && last.c >= last.o ? T.UP : T.DOWN;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(plotW, y);
    ctx.stroke();

    const tag = axisLabel(mark);
    ctx.font = '12px ui-monospace, monospace';
    const tw = Math.max(PAD_R - 4, ctx.measureText(tag).width + 8);
    ctx.fillStyle = col;
    ctx.fillRect(plotW, y - 9, tw, 18);
    ctx.fillStyle = '#04140f';
    ctx.textAlign = 'left';
    ctx.fillText(tag, plotW + 4, y);
  }

  ctx.fillStyle = T.FG;
  return -shift * plotH / span;
}

/** 左下角被 `.chart-side` 浮字占用的高度（px）。强平标签落进这一带就上移一行（Batch 4 · B16）。 */
const SIDE_RESERVE = 56;
/** 避让的位移 = 一个标签高 16 ＋ 一个块内间距 6，恰好整行让开 */
const SIDE_SHIFT = 22;

/* ═════════════════════ 资金曲线（v13 · 方案 §4；区间＋高低点 2026-10-01） ═════════════════════
 * 把 `s.eq`（每个游戏日一个权益点）画成一条折线 ＋ 一条 $1,000 基准虚线。
 *
 * ⚠️ 它**住在本文件**的原因只有一个：K 线那套「读 `:root` 变量（`theme()`）＋ dpr 缩放」
 *    的地基在这里，另起一个模块只会把这两件事抄第二遍。
 * ⚠️ **对数纵轴**：$1,000 → $1,000 万跨四个数量级，线性轴会把前两年压成贴着底边的一条线，
 *    而那正是玩家最需要看清「有没有在慢慢往上爬」的一段。
 * ⚠️ 它是**复盘图**：不画轴、不画网格、不做任何手势 —— 资产页上点它什么也不会发生。
 *    「区间切换」由上方那排 `.opt` 键（`main.js` 分派 `eqrange`）驱动，图上依旧没有手势。
 * ⚠️ **区间高低点**（用户 2026-10-01 拍板，对齐 OKX）：只在**当前所选区间**内取 min/max
 *    并各画一枚点 ＋ 一行小字读数，值走 `fmtMoneyShort`（与 HUD 同一套 K/M/B 后缀）。
 */

/** 纵轴下限（对数值）：权益归零后取 $1e-6 会让 `log10` 变成 −6，白白吃掉半屏纵轴 —— 兜在 $1 上 */
const CURVE_FLOOR = 1;
/** 上下各留的余量比（对数空间），免得最高 / 最低那一点贴着边框 */
const CURVE_PAD_RATIO = 0.06;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} o
 *   `eq`   Array<number>  每游戏日收盘的权益（升序，最后一个 = 今天）
 *   `range` number        只看最近多少个游戏日（`0` / 缺省 = 全部）
 *   `base` number         基准线（开局资金 $1,000）—— 也是「赚了还是亏了」那条分界
 *   `cssW` / `cssH`       画布尺寸（CSS 像素）
 */
export function drawEquityCurve(canvas, o) {
  const T = theme();
  const dpr = Math.min(3, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1);
  const W = Math.max(1, Math.round(o.cssW));
  const H = Math.max(1, Math.round(o.cssH));
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const all = o.eq || [];
  if (!all.length) {
    ctx.fillStyle = T.MUT;
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('暂无记录', W / 2, H / 2);
    return;
  }

  /* 区间切片（用户 2026-10-01 拍板）：`range` > 0 只看尾部 N 个游戏日；点数不够就显示全部。
     ⚠️ 全程一个点（开局当天）也要画出来，所以切片后仍可能只有 1 个点 —— 下面单点分支照旧。 */
  const range = Number(o.range) || 0;
  const from = range > 0 ? Math.max(0, all.length - range) : 0;
  const eq = from > 0 ? all.slice(from) : all;

  const padX = 4;
  const padY = 12;
  const plotW = Math.max(1, W - padX * 2);
  const plotH = Math.max(1, H - padY * 2);

  const lg = v => Math.log10(Math.max(CURVE_FLOOR, v));
  let lo = lg(o.base);
  let hi = lo;
  for (const v of eq) {
    const g = lg(v);
    if (g < lo) lo = g;
    if (g > hi) hi = g;
  }
  /* 全程一条水平线（比如开局第一天）时 `hi === lo` ⇒ 强行撑开 0.1 个数量级，
     否则 `hi - lo` 为 0 会把所有点除成 NaN。 */
  if (hi - lo < 0.1) { const c = (hi + lo) / 2; lo = c - 0.05; hi = c + 0.05; }
  const pad = (hi - lo) * CURVE_PAD_RATIO;
  lo -= pad; hi += pad;
  const yOf = v => padY + plotH * (1 - (lg(v) - lo) / (hi - lo));
  const xOf = k => (eq.length === 1 ? padX + plotW / 2 : padX + plotW * k / (eq.length - 1));

  // ── 基准虚线（$1,000）──
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = T.LINE;
  ctx.lineWidth = 1;
  const yb = Math.round(yOf(o.base)) + .5;
  ctx.beginPath();
  ctx.moveTo(padX, yb);
  ctx.lineTo(W - padX, yb);
  ctx.stroke();
  ctx.restore();

  /* 抽稀（用户 2026-10-01 拍板）：一列像素里塞进多个点时只留**最高 / 最低**两点。
     全景 4,383 点 ÷ 366px ≈ 12 点每像素，逐点 `lineTo` 既费又糊；按 px 分桶取 min/max
     （而不是等距抽样或求平均）⇒ **峰谷一个不丢**，下面「区间高低点」所依赖的极值因此逐位不变。
     ⚠️ 点数不到一列两枚时**原样逐点画** —— 短区间（1周 / 1月）本来就是硬折线，抽稀只会更钝。 */
  const cols = Math.round(plotW);
  const idx = [];
  if (eq.length > cols * 2) {
    for (let c = 0; c < cols; c++) {
      const a = Math.floor(c * eq.length / cols);
      const b = Math.max(a + 1, Math.floor((c + 1) * eq.length / cols));
      let iLo = a, iHi = a;
      for (let k = a + 1; k < b && k < eq.length; k++) {
        if (eq[k] < eq[iLo]) iLo = k;
        if (eq[k] > eq[iHi]) iHi = k;
      }
      if (iLo === iHi) idx.push(a);
      else if (iLo < iHi) idx.push(iLo, iHi);
      else idx.push(iHi, iLo);                     // 桶内按索引升序，折线才不在桶里来回跳
    }
    const tail = eq.length - 1;                    // 今天那一点必须落在折线上
    if (idx[idx.length - 1] !== tail) idx.push(tail);
  } else {
    for (let k = 0; k < eq.length; k++) idx.push(k);
  }

  // ── 权益折线（颜色只说一件事：最后是赚是亏）──
  const last = eq[eq.length - 1];
  ctx.strokeStyle = last >= o.base ? T.UP : T.DOWN;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const n = idx.length;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const x = xOf(i);
    const y = yOf(eq[i]);
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  if (eq.length === 1) { ctx.lineTo(xOf(0) + 1, yOf(last)); }   // 单点：画一小段，别退化成看不见
  ctx.stroke();

  // ── 今天那一点 ──
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fillRect(Math.round(xOf(eq.length - 1)) - 1.5, Math.round(yOf(last)) - 1.5, 3, 3);

  /* ── 区间高低点（用户 2026-10-01 拍板，对齐 OKX）──
     只在**当前所选区间**内取 min/max，各画一枚小圆点 ＋ 一行小字读数。
     ⚠️ 全程一条平线（`iMax === iMin`）时不画 —— 两枚点叠在一起、两个标签压成一团，
        反而比不标更乱；那种情况下「高低点」本来也没有信息量。 */
  if (eq.length >= 2) {
    let iMax = 0, iMin = 0;
    for (let k = 1; k < eq.length; k++) {
      if (eq[k] > eq[iMax]) iMax = k;
      if (eq[k] < eq[iMin]) iMin = k;
    }
    if (iMax !== iMin) {
      const col = ctx.strokeStyle;
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const dot = (k, label, above) => {
        const x = xOf(k), y = yOf(eq[k]);
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(Math.round(x), Math.round(y), 2.5, 0, Math.PI * 2);
        ctx.fill();
        const text = `${label} ${fmtMoneyShort(eq[k])}`;
        const half = ctx.measureText(text).width / 2;
        const tx = clamp(x, padX + half, W - padX - half);
        const ty = clamp(above ? y - 11 : y + 11, 8, H - 7);
        ctx.fillStyle = T.MUT;
        ctx.fillText(text, tx, ty);
      };
      dot(iMax, '高', true);
      dot(iMin, '低', false);
    }
  }
}