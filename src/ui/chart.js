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
 *    保证它不侵入 K 线的躯干密集区。柱高只服务观感，不参与任何玩法。
 */

/** 右侧价格标签宽（`view.js` 算单根 K 线宽度时要用同一份，故导出） */
export const PAD_R = 52;
/** 底部留白（右侧价格标签高 18px，贴边会被切掉） */
const PAD_B = 16;
/** 顶部留白 = 轴标签半高 ＋ 一点余量（Batch 1 · B5，2026-09-29） */
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
};

let themeCache = null;

/**
 * 把 `:root` 的变量读成计算值并缓存。
 * canvas 不认 `var()`，只能读一次字符串；运行时没有换肤，所以缓存终身有效。
 * 样式表是 `<head>` 里的阻塞 `<link>`，首帧执行前就已生效，不存在读到空值的情况。
 */
function theme() {
  if (!themeCache) {
    const cs = getComputedStyle(document.documentElement);
    themeCache = {};
    for (const key in THEME_VARS) themeCache[key] = cs.getPropertyValue(THEME_VARS[key]).trim();
  }
  return themeCache;
}

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
 *   mark     number            当前价（画水平线）
 *   entry    number|null       持仓开仓价
 *   side     'long'|'short'|null
 *   liq      number|null       强平价（现货传 null）
 *   cssW/cssH number           容器尺寸（CSS 像素）
 *   yPx      number            价格轴的垂直平移（像素，向下为正；`view.js` 持有）
 * @returns {number} **实际生效的 `yPx`**（被限位夹过）—— 调用方必须写回视野状态，
 *                   否则玩家一直往同一边拖时状态里的值会越滚越大，松手再按就从远处跳回来。
 */
export function drawChart(canvas, o) {
  const { candles, vols, mark, entry, side, liq } = o;
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
  // ⚠️ 顶部留白 = 轴标签半高（12px 字垂直居中 ⇒ 上半 6px）＋ 一点余量（Batch 1 · B5，2026-09-29）。
  //    原来只留 4px，最上一档标签「$xx.xk」的上半截会被画布切掉（用户实机发现「y 轴最上方被截断」）。
  const plotH = Math.max(1, H - PAD_B - PAD_TOP);
  const top = PAD_TOP;
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

  const n = candles.length;
  const cw = plotW / n;
  const bw = Math.max(1, Math.min(cw - 1, 13));

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
    const x = k * cw + cw / 2;
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
  // 高度按**视野内最大值自适应**：份额是日内相对量，绝对量跨 7 个数量级
  // （2013 与 2024 差百万倍），固定标尺会让早年的柱子整片看不见。
  // 无成交的根不画（柱高 0）。量区不画网格、不加轴标签 —— LESS IS MORE。
  // ⚠️ 柱宽与柱心的取法与 K 线**完全一致** ⇒ 每根量柱正好盖住它自己那一根 K 线；
  //    同色叠加下 K 线躯干看不出变化，只有背景被压出「暗一档的柱身」。
  const V = vols || [];
  let vmax = 0;
  for (const v of V) if (v > vmax) vmax = v;
  if (vmax > 0) {
    ctx.save();
    ctx.globalAlpha = VOL_ALPHA;
    for (let k = 0; k < n; k++) {
      const v = V[k];
      if (!(v > 0)) continue;
      const c = candles[k];
      const h = Math.max(1, Math.round(v / vmax * volH));
      ctx.fillStyle = c.c >= c.o ? T.UP : T.DOWN;
      const x = k * cw + cw / 2;
      ctx.fillRect(Math.round(x - bw / 2), bot - h, Math.round(bw), h);
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
    const tag = (side === 'short' ? '空 ' : '多 ') + axisLabel(entry);
    ctx.font = '12px ui-monospace, monospace';
    const tw = ctx.measureText(tag).width + 6;
    const ty = Math.round(clamp(y, 8, bot - 8)) + .5;
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
      const ly = ty > bot - SIDE_RESERVE ? Math.max(8, ty - SIDE_SHIFT) : ty;
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