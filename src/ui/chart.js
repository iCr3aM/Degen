/**
 * K 线绘制（Canvas 2D，GDD §19.1）
 * ===============================================================
 * 只画「最近 N 根 + 一条当前价水平线 + 一条持仓开仓价水平线」。
 * 不画成交量、不画均线、不画指标 —— GDD §3「Less is More」。
 *
 * ⚠️ 坐标全部乘 `dpr` 后再 `ctx.scale(dpr, dpr)`：手机上 devicePixelRatio 是 2~3，
 *    不补这一刀，K 线会糊成一团。
 *
 * ⚠️ **颜色不在这里写死** —— 唯一真源是 `style.css` 的 `:root`（见下方 `theme()`）。
 *    曾经这里硬编码过一份副本，结果改 CSS 变量时 K 线的网格线和轴标签没跟着变。
 */

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

const PAD_R = 52;      // 右侧留给价格标签
const PAD_B = 16;      // 底部留白（右侧价格标签高 18px，贴边会被切掉）

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
 *   candles  Array<{o,h,l,c}>  已按时间升序，最后一个是当前根
 *   mark     number            当前价（画水平线）
 *   entry    number|null       持仓开仓价
 *   side     'long'|'short'|null
 *   liq      number|null       强平价（现货传 null）
 *   cssW/cssH number           容器尺寸（CSS 像素）
 */
export function drawChart(canvas, o) {
  const { candles, mark, entry, side, liq } = o;
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
  // ⚠️ 顶部留白 = 轴标签半高（12px 字垂直居中 ⇒ 上半 6px）＋ 一点余量（2026-09-29）。
  //    原来只留 4px，最上一档标签「$xx.xk」的上半截会被画布切掉（用户实机发现「y 轴最上方被截断」）。
  //    写成 `PAD_B - PAD_TOP` 而不是原来的「底部 16 - 固定 4」：底边仍落在 H-PAD_B，
  //    两侧留白对称，只是把画高让出 6px 给顶端标签。
  const PAD_TOP = 10;
  const plotH = Math.max(1, H - PAD_B - PAD_TOP);
  const top = PAD_TOP;

  if (!candles || !candles.length) {
    ctx.fillStyle = T.MUT;
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('无行情数据', plotW / 2, H / 2);
    return;
  }

  // ── 价格轴范围：只由 K 线本身与当前价决定 ──
  // ⚠️ **开仓价不参与这里**（2026-09-28）：一旦并进来，开仓价离现价越远、K 线被压得越扁。
  //    它改成只把线「夹到画布边缘」（见下方开仓线那一段）。
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) {
    if (c.l < lo) lo = c.l;
    if (c.h > hi) hi = c.h;
  }
  if (Number.isFinite(mark)) { lo = Math.min(lo, mark); hi = Math.max(hi, mark); }
  if (!(hi > lo)) { hi = lo * 1.001 + 1e-9; lo = lo * 0.999 - 1e-9; }
  const padY = (hi - lo) * 0.06;
  lo -= padY; hi += padY;
  const span = hi - lo;
  const yOf = p => top + (hi - p) / span * plotH;

  const n = candles.length;
  const cw = plotW / n;
  const bw = Math.max(1, Math.min(cw - 1, 13));

  // ── 网格线 + 右侧价格标签（三档） ──
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

  // ── K 线本体 ──
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

  // ── 开仓价（金色虚线，画在当前价之前，避免盖住它） ──
  // 开仓价**不在**价格轴范围内（见上），所以线只做一件事：**夹到画布的上沿或下沿**。
  // 开仓价低于现价 ⇒ y 落到下沿；高于现价 ⇒ 落到上沿。价格本身仍写在右端小标签里，贴边不丢信息。
  if (Number.isFinite(entry)) {
    const y = Math.round(clamp(yOf(entry), top, top + plotH)) + .5;
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
    // ⚠️ 标签矩形要**单独**再夹一次（它高 16px）—— 线贴到上/下沿时，不夹就会有一半被画布切掉。
    const tag = (side === 'short' ? '空 ' : '多 ') + axisLabel(entry);
    ctx.font = '12px ui-monospace, monospace';
    const tw = ctx.measureText(tag).width + 6;
    const ty = Math.round(clamp(y, 8, H - 8)) + .5;
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
    if (Number.isFinite(liq)) {
      const ltag = '强 ' + axisLabel(liq);
      const lw = ctx.measureText(ltag).width + 6;
      ctx.fillStyle = T.DOWN;
      ctx.fillRect(0, ty - 8, lw, 16);
      ctx.fillStyle = '#1a0508';
      ctx.textAlign = 'left';
      ctx.fillText(ltag, 3, ty);
    }
  }

  // ── 当前价（实线 + 右端高亮标签） ──
  if (Number.isFinite(mark) && mark >= lo && mark <= hi) {
    const y = Math.round(yOf(mark)) + .5;
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
}
