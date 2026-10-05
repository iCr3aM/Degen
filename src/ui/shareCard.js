/**
 * 生涯海报（M4 建 · M5 · 2026-10-02 由「分享」改为「生成海报」）
 * ===============================================================
 * 把**一条档案记录**（`core/careers.js`）画成一张 **1080×1620** 的竖版 PNG
 * （2:3，朋友圈 / 推特的竖图尺寸）。纯 canvas，不碰 DOM 布局。
 *
 * ⚠️ **称号 / 徽章 / 结局名直接复用 `core/titles.js`** ⇒ 卡片上的字与档案页**永远同一套**，
 *    不会两处各写一份判断。
 * ⚠️ **配色全部来自 `chart.js` 的 `theme()`**（与 K 线同一源）⇒ 设置页把涨跌色对调时，
 *    卡片跟着翻，不会出现「游戏里绿涨、卡片里红涨」。
 * ⚠️ 曲线是**档案里那条抽稀过的 `eq`**（`thinEq` 压到 128 点），不是重新读存档。
 *
 * ── 2026-10-02 改法的理由（参考项目 `我创造的完美球员`）──────────────
 * 原来是「点一下直接下载 / 弹原生分享面板」，**没有任何预览**：玩家不知道会画成什么样，
 * 也不知道下没下下来。那边那条路是「先画好 → 摊开给人看 → 再决定存不存」——
 * 这里照做，但把「画」与「导」**拆成两个导出**，让预览层（`render.openPoster`）与
 * 保存 / 分享各拿各的东西：
 *
 *     posterURL(rec)           →  string | null       data URL（PNG），三处共用同一份像素
 *     posterName(rec)          →  文件名
 *     savePoster(url, name)    →  'downloaded' | 'opened' | 'failed'
 *     sharePoster(url, name)   →  'shared' | 'unsupported' | 'failed'
 *
 * ⚠️ **全链走 data URL，不走 `toBlob`**（2026-10-02 修 · 用户反馈「海报图片图裂了」）——
 *    `toBlob` 在部分设备（尤以旧安卓 WebView）回调不来 / 抛错，预览就是一张裂图。
 *    data URL 是同步拿到的，没有回调可失约；只有「原生分享要 File」与「老 iOS 新窗口
 *    兜底」两处才现转一次 Blob（`dataURLToBlob`）。详见 `posterURL` 的注释。
 */

import { scenarioOf } from '../core/config.js';
import { fmtDate, fmtMoneyShort } from '../core/format.js';
import { badgesOf, epitaphOf, multShown, overLabelOf, styleOf, titleOf } from '../core/titles.js';
import { OVER } from '../core/engine.js';
import { theme, trimFlatStart } from './chart.js';

const W = 1080;
/* ⚠️ 2026-10-05：1350 → **1620**（4:5 → 2:3）。用户要求「文案完整显示 ＋ 再加几行内容」——
   旧高度放不下「已实现盈亏 / 明细 / 足迹」与折成两行的完整评语。 */
const H = 1620;
const P = 84;                                   // 左右留白

const SANS = '-apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** `#rrggbb` → `rgba(r,g,b,a)`；解析不出来就原样返回（不改色，只是不加透明度） */
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** 圆角矩形路径（不依赖 `ctx.roundRect`，老浏览器也能跑） */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 把字号降到这一串能塞进 `maxW` 为止（**只降字号、不截断**）—— 返回时 `ctx.font` 就是那一档 */
function fitFont(ctx, text, size, maxW, family, weight = 700) {
  let s = size;
  for (;;) {
    ctx.font = `${weight} ${s}px ${family}`;
    if (s <= 20 || ctx.measureText(String(text)).width <= maxW) return s;
    s -= 2;
  }
}

/**
 * 按宽度把一串中文折行（**逐字断行，不丢字**）。
 * ⚠️ 尽量在最近的空格处断（免得把「强平 88 次」拆成「强平 8」/「8 次」）；找不到合适空格就按字断。
 * ⚠️ 返回数组，调用方自己决定行距。调用前需先设好 `ctx.font`（本函数按当前字号量宽）。
 */
function wrapText(ctx, text, maxW) {
  const s = String(text);
  const out = [];
  let cur = '';
  for (const ch of s) {
    if (cur && ctx.measureText(cur + ch).width > maxW) {
      const sp = cur.lastIndexOf(' ');
      if (sp > cur.length * 0.5) { out.push(cur.slice(0, sp)); cur = cur.slice(sp + 1) + ch; }
      else { out.push(cur); cur = ch; }
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 徽章在给定字号下会折**几行**（只量不画）—— 用来挑一档能塞进版面行数上限的字号。
 * 折行规则与 `drawCard` 里的绘制循环**逐字一致**（否则「量出来的行数」与「画出来的行数」会漂）。
 */
function badgeRowCount(ctx, badges, size, maxW) {
  ctx.font = `500 ${size}px ${SANS}`;
  let rows = 1, bx = 0;
  for (const b of badges) {
    const bw = ctx.measureText(b).width + 44;
    if (bx > 0 && bx + bw > maxW) { rows++; bx = 0; }
    bx += bw + 14;
  }
  return rows;
}

/**
 * 资金曲线：**基准线（本金）虚线 ＋ 权益折线 ＋ 渐隐填充**。
 * `lo/hi` 把基准线与整条曲线一起框进去 ⇒ 本金线永远在视野内。
 */
function drawCurve(ctx, x, y, w, h, eq, base, tone, t) {
  let lo = base, hi = base;
  for (const v of eq) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < 1e-9) hi = lo + 1;
  const pad = (hi - lo) * 0.12;
  lo -= pad; hi += pad;

  const X = i => x + (i / (eq.length - 1)) * w;
  const Y = v => y + h - ((v - lo) / (hi - lo)) * h;

  /* 基准线（本金）—— 与资产页同一条语义：越过它才是赚 */
  ctx.save();
  ctx.setLineDash([12, 12]);
  ctx.strokeStyle = t.LINE || '#232b34';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, Y(base));
  ctx.lineTo(x + w, Y(base));
  ctx.stroke();
  ctx.restore();

  /* 渐隐填充 */
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, hexA(tone, 0.22));
  grad.addColorStop(1, hexA(tone, 0));
  ctx.beginPath();
  ctx.moveTo(X(0), Y(eq[0]));
  for (let i = 1; i < eq.length; i++) ctx.lineTo(X(i), Y(eq[i]));
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  /* 折线 */
  ctx.beginPath();
  ctx.moveTo(X(0), Y(eq[0]));
  for (let i = 1; i < eq.length; i++) ctx.lineTo(X(i), Y(eq[i]));
  ctx.strokeStyle = tone;
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

/**
 * 画一张卡（返回 `<canvas>`；只在这里碰 DOM）。
 *
 * **版面（从上到下）**：
 *   ① DEGEN ＋ 副题 / ② 局名 ＋ **结局** / ③ **主称号 ＋ 风格称号** / ④ 徽章（自动折行）
 *   ⑤ **账本四项（四行）**（本金 · 峰值 · 已实现盈亏 · 最高杠杆，标签靠左、数值靠右）＋ **交易币种**一整行
 *   ⑥ 资金曲线（高度自适应）/ ⑦ 终值 ＋ 倍数 / ⑧ 起止 ＋ 天数
 *   ⑨ **结局评语**（全版，最多折两行）/ ⑩ **交易明细**（两行）/ ⑪ **行为足迹**（可选）/ ⑫ 水印
 * ⚠️ ⑤ 与 ⑨ 是 2026-10-02 补的（用户圈定「必要内容」）：原来只有曲线和终值，
 *    看不出**怎么结束的 / 本钱多少 / 打得怎么样**。
 * ⚠️ 2026-10-05（用户拍板「文案要完整显示 ＋ 再多加几行」，卡高 1350 → **1620**）：
 *    · 结局评语改用 `epitaphOf(rec)` **全版**（不再取 `short` 丢补白句），只降字号 / 折行、绝不截断；
 *    · 账本 3 格 → **4 格**（补「已实现盈亏」）；
 *    · 新增**交易明细**（开仓 / 胜负 / 胜率 / 强平 ＋ 杠杆 / 合约产品线）与**行为足迹**
 *      （加仓 / 保证金增减 / OTC / 分批 / 换所，**全 0 则整行不画**）；
 *    · 底部各块的纵坐标**从画布底往上一格一格排**（不再写死），徽章折到 3 行也不会与底部撞车。
 */
export function drawCard(rec) {
  const t = theme();
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  const cw = W - 2 * P;

  /* 底 */
  ctx.fillStyle = t.BG || '#0d0f12';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  /* 头部：DEGEN ＋ 副题 */
  ctx.fillStyle = t.FG || '#dbe4f0';
  ctx.font = `700 38px ${SANS}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '10px';
  ctx.fillText('DEGEN', P, 122);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.fillStyle = t.MUT || '#8f9aa6';
  ctx.font = `400 28px ${SANS}`;
  ctx.textAlign = 'right';
  ctx.fillText('加密交易员', W - P, 120);
  ctx.textAlign = 'left';

  /* 细线 */
  ctx.strokeStyle = t.LINE || '#232b34';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(P, 156);
  ctx.lineTo(W - P, 156);
  ctx.stroke();

  /* 涨跌色在这一张卡上只算一次：终值与曲线共用 */
  const tone = rec.final >= rec.cash0 ? (t.UP || '#00d18f') : (t.DOWN || '#ff5b6a');

  /* 局名（左）＋ 结局（右）—— 结局原来只隐含在称号里，现在显式写出来 */
  ctx.fillStyle = t.MUT || '#8f9aa6';
  ctx.font = `400 32px ${SANS}`;
  ctx.fillText(scenarioOf(rec.scen).name, P, 236);
  ctx.textAlign = 'right';
  ctx.fillStyle = rec.reason === OVER.LIQUIDATED ? (t.DOWN || '#ff5b6a')
    : rec.reason === OVER.SETTLED ? (t.UP || '#00d18f') : (t.MUT2 || '#6b7480');
  ctx.font = `500 30px ${SANS}`;
  ctx.fillText(overLabelOf(rec), W - P, 236);
  ctx.textAlign = 'left';

  /* 主称号 ＋ 风格称号（2026-10-04 · 用户拍板「主称号 ＋ 风格称号 ＋ 徽章池」）——
     主称号大字（**结局 × 倍数**，答「打成什么样」），风格称号小字**并列其后**
     （纯行为判定，答「你是哪种玩家」），中间一枚「·」。
     ⚠️ 两枚都走 `core/titles.js` ⇒ 与档案页同一套字（LESS IS MORE）。 */
  const main = titleOf(rec);
  ctx.fillStyle = t.FG || '#dbe4f0';
  ctx.font = `700 96px ${SANS}`;
  ctx.fillText(main, P, 352);
  const mainW = ctx.measureText(main).width;
  ctx.fillStyle = t.MUT || '#8f9aa6';
  /* 自适应降字号：主称号最长 4 字、风格称号最长 5 字，正常都放得下；
     万一放不下**只降风格称号的字号**（主称号是主角，不缩）。 */
  fitFont(ctx, '· ' + styleOf(rec), 40, Math.max(96, cw - mainW - 56), SANS, 500);
  ctx.fillText('· ' + styleOf(rec), P + mainW + 32, 352);

  /* 徽章 —— 按宽度**自动折行**。
     ⚠️ 2026-10-05 修溢出 bug：旧版把折行**硬上限设成两行**，第 3 行起不再折行、直接画出画布右缘。
        现在改成「先按 26→24→22→20 挑一档能塞进 **≤3 行**的字号，再照实际宽度折行」，
        折行不设硬上限 ⇒ 徽章再多也不会溢出。
     ⚠️ 分隔线与下面几块的位置**跟着最后一行徽章走**。 */
  const badges = badgesOf(rec);
  let bSize = 20;
  for (const s of [26, 24, 22, 20]) { bSize = s; if (badgeRowCount(ctx, badges, s, cw) <= 3) break; }
  let bx = P, by = 400;
  const bh = 46, gapX = 14, gapY = 8;
  ctx.font = `500 ${bSize}px ${SANS}`;
  for (const b of badges) {
    const bw = ctx.measureText(b).width + 44;
    if (bx > P && bx + bw > W - P) { bx = P; by += bh + gapY; }
    roundRect(ctx, bx, by, bw, bh, 12);
    ctx.strokeStyle = t.LINE || '#232b34';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = t.MUT || '#8f9aa6';
    ctx.textBaseline = 'middle';
    ctx.fillText(b, bx + 22, by + bh / 2 + 1);
    ctx.textBaseline = 'alphabetic';
    bx += bw + gapX;
  }
  /* 分隔线顶点：徽章底 ＋ 40，且不低于旧版的 500（一行徽章时版面不动）。 */
  const sepY = Math.max(500, by + bh + 40);

  /* 分隔线 */
  ctx.strokeStyle = t.LINE || '#232b34';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(P, sepY);
  ctx.lineTo(W - P, sepY);
  ctx.stroke();

  /* 账本四项（2026-10-05 用户拍板：由「一行四格」改**四行**）——
     标签左对齐到 `P`、数值右对齐到 `W - P`，四行等距，左右两边各自钉死在版心边缘。
     ⚠️ 旧版是一行四格、各格左对齐，格宽只有 `cw / 4 = 228px`：本金印 `$1,000.0` 就有约 211px，
        紧贴右边「峰值」的标签（用户实测报的正是这一处）⇒ 数值再长都会与邻格相撞。
     ⚠️ 四行纵坐标**全部相对 `sepY`**（`sepY + 62 + k × 48`）—— 徽章折行、分隔线下移时整段跟着走，
        行数恒定 4 ⇒ 块高不随内容变化，下游 `ySym` / 曲线高度也不跳。 */
  const ledger = [
    ['本金', fmtMoneyShort(rec.cash0)],
    ['峰值', fmtMoneyShort(rec.peak)],
    /* 已实现盈亏（2026-10-05 用户圈定）—— `s.realized` 是**已平仓回合净额**累计，
       与「峰值」（含浮盈）不同：这一个才是真正落袋的数。老档案没有该字段时按 0 处理。 */
    ['已实现盈亏', fmtMoneyShort(rec.realized || 0)],
    /* ⚠️ 2026-10-05 审计修：**一单没开就别报「1x」** —— `s.stat.maxLev` 初值就是 1（见 `state.js`），
       空仓局会把它原样带出来，海报上出现一个玩家从没用过的杠杆。与同页「交易币种」的空态写法
       （`'—'`）保持一致；开过仓（哪怕只开过 1x）才如实显示。 */
    ['最高杠杆', rec.open > 0 ? `${rec.maxLev}x` : '—'],
  ];
  const LBL_SIZE = 26, ROW_DY = 48, rowY0 = sepY + 62;
  /* 四项**共用同一档字号**（取四项里最小的那一档）—— 免得一行大字、一行小字，看着参差。
     可用宽度按**最宽的标签**（「已实现盈亏」）扣，四行都按这一档排 ⇒ 字号不随内容变。 */
  let lblMaxW = 0;
  ctx.font = `400 ${LBL_SIZE}px ${SANS}`;
  for (const [label] of ledger) lblMaxW = Math.max(lblMaxW, ctx.measureText(label).width);
  let vSize = 44;
  for (const [, value] of ledger) {
    const s = fitFont(ctx, value, 44, cw - lblMaxW - 40, MONO, 700);
    if (s < vSize) vSize = s;
  }
  ledger.forEach(([label, value], k) => {
    const y = rowY0 + k * ROW_DY;
    ctx.textAlign = 'left';
    ctx.fillStyle = t.MUT2 || '#6b7480';
    ctx.font = `400 ${LBL_SIZE}px ${SANS}`;
    ctx.fillText(label, P, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = t.FG || '#dbe4f0';
    ctx.font = `700 ${vSize}px ${MONO}`;
    ctx.fillText(value, W - P, y);
  });
  ctx.textAlign = 'left';

  /* 交易币种 —— 单独一整行（名字可能很长，右对齐 ＋ 自适应降字号，不截断） */
  const symTxt = Array.isArray(rec.syms) && rec.syms.length ? rec.syms.join(' · ') : '—';
  const ySym = rowY0 + (ledger.length - 1) * ROW_DY + 54;
  ctx.fillStyle = t.MUT2 || '#6b7480';
  ctx.font = `400 26px ${SANS}`;
  ctx.fillText('交易币种', P, ySym);
  ctx.textAlign = 'right';
  ctx.fillStyle = t.FG || '#dbe4f0';
  fitFont(ctx, symTxt, 30, cw - 200, SANS, 500);
  ctx.fillText(symTxt, W - P, ySym);
  ctx.textAlign = 'left';

  /* ── 底部区块：**从画布底往上一格一格排** ────────────────────────────────
     自上而下：终值＋倍数 → 起止 → 结局评语（≤2 行）→ 交易明细（2 行）→ 行为足迹（可选）→ 水印。
     先把下半段的高度算出来，再据此定曲线的可用高度（全部相对 `H`，不再写死坐标）。 */
  const EPI_DY = 40;

  /* 行为足迹（可选）—— 全是 0 就整行不画（不留一行空行）。 */
  const marks = [];
  if ((rec.addOn || 0) >= 1) marks.push(`加仓 ${rec.addOn}`);
  if ((rec.mgUp || 0) >= 1) marks.push(`加保证金 ${rec.mgUp}`);
  if ((rec.mgDown || 0) >= 1) marks.push(`减保证金 ${rec.mgDown}`);
  if ((rec.otc || 0) >= 1) marks.push(`OTC ${rec.otc}`);
  if ((rec.part || 0) >= 1) marks.push(`分批 ${rec.part}`);
  if ((rec.move || 0) >= 1) marks.push(`换所 ${rec.move}`);
  const markTxt = marks.join(' · ');

  /* 交易明细（两行）：第一行胜负与强平，第二行产品线（杠杆 / 合约）。
     ⚠️ `rec.liq` 是**强平笔数**（单笔被强制平仓，可多次）；「爆仓」只指账户归零的结局，别混用。
     ⚠️ 胜率口径与 `titles.js` 一致：`closed = win + loss`，`win / closed`；一回合没平过就给「—」。 */
  const closed = (rec.win || 0) + (rec.loss || 0);
  const rate = closed > 0 ? Math.round(((rec.win || 0) / closed) * 100) : null;
  const statB = `杠杆下单 ${rec.margin || 0} 笔 · 合约下单 ${rec.fut || 0} 笔`;
  /* 明细第一行按段上色（2026-10-05 用户圈定「胜/负/胜率加绿红」）：
     `cls` 为 `up`/`down` 的段走涨跌色，其余段保持次要灰。`statA` 直接由各段拼出
     （不另写一遍整串）⇒ 量字号用的串与画出来的串**永远逐字相同**，不会两处漂字。
     ⚠️ 补「平仓 M 笔」（2026-10-05 审计修）：`open` 是**开仓笔数**、`win + loss` 是**平仓笔数**，
        两者本就不相等（部分仓位到收盘还没平，且加仓会多记开仓笔）。原来只印
        「开仓 N · 胜 a · 负 b」，玩家会以为 a+b 该等于 N —— 补上 `M = a+b` 把两个口径摆明。 */
  const segsA = [
    [`开仓 ${rec.open || 0} 笔 · `, null],
    [`平仓 ${closed} 笔 · `, null],
    [`胜 ${rec.win || 0}`, 'up'],
    [' · ', null],
    [`负 ${rec.loss || 0}`, 'down'],
    [` · 胜率 ${rate == null ? '—' : rate + '%'}`, rate == null ? null : (rate >= 50 ? 'up' : 'down')],
    [` · 强平 ${rec.liq || 0} 次`, null],
  ];
  const statA = segsA.map(([txt]) => txt).join('');

  /* 结局评语 —— **全版**（`epitaphOf(rec)`，含补白句），与弹窗 / 档案页同一句话。
     ⚠️ 只降字号 / 折行、**绝不截断**；最多折两行（最长组合约 60 余字，22px 两行必放得下）。 */
  const ep = epitaphOf(rec);
  let epSize = 28, epLines = [];
  for (const s of [28, 26, 24, 22]) {
    ctx.font = `400 ${s}px ${SANS}`;
    epSize = s;
    epLines = wrapText(ctx, ep, cw);
    if (epLines.length <= 2) break;
  }

  /* 明细两行 / 足迹一行也自适应降字号（只降不截断），三行共用同一档字号。 */
  let sSize = fitFont(ctx, statA, 26, cw, SANS, 400);
  sSize = Math.min(sSize, fitFont(ctx, statB, 26, cw, SANS, 400));
  if (markTxt) sSize = Math.min(sSize, fitFont(ctx, markTxt, 26, cw, SANS, 400));

  /* 排基线（自下而上）：水印钉在底，往上依次是足迹 / 明细二 / 明细一 / 评语 / 起止 / 终值。 */
  const wmY = H - 46;
  const markY = H - 92;
  const statBY = markY - (markTxt ? 46 : 0);
  const statAY = statBY - 44;
  const epiLast = statAY - 56;
  const epiFirst = epiLast - (epLines.length - 1) * EPI_DY;
  const rangeY = epiFirst - 56;
  const finalY = rangeY - 58;

  /* 曲线：从「交易币种」那行下面起，到「终值」上方留白为止 —— 高度自适应（徽章多折一行就矮一点）。
     ⚠️ 开头的**观望期平线**先裁掉（2026-10-05 用户拍板「只有钱有变化之后才有曲线」）——
        与资产页共用 `chart.trimFlatStart`，同一局在哪儿看都是同一段曲线。 */
  const cy = ySym + 86;
  const chh = Math.max(150, Math.min(460, finalY - 46 - cy));
  const eq = trimFlatStart(Array.isArray(rec.eq) ? rec.eq : []);
  if (eq.length >= 2) {
    drawCurve(ctx, P, cy, cw, chh, eq, rec.cash0, tone, t);
  } else {
    ctx.fillStyle = t.MUT2 || '#6b7480';
    ctx.font = `400 28px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.fillText('本局没有留下资金曲线', W / 2, cy + chh / 2);
    ctx.textAlign = 'left';
  }

  /* 终值 ＋ 倍数 */
  ctx.fillStyle = tone;
  ctx.font = `700 68px ${MONO}`;
  ctx.fillText(fmtMoneyShort(rec.final), P, finalY);
  /* ⚠️ 倍数（2026-10-05 审计修）：破产局终值 ≤ 0，`final / cash0` 印出来是 `×0.00` ——
     改报**峰顶倍数**并加「峰值」前缀（与档案页共用 `multShown`，同一局两处口径一致）。 */
  const mv = multShown(rec);
  ctx.font = `700 46px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.fillText((mv.peak ? '峰值 ' : '') + `×${mv.v.toFixed(mv.v < 10 ? 2 : 1)}`, W - P, finalY);
  ctx.textAlign = 'left';

  /* 起止 ＋ 天数 */
  ctx.fillStyle = t.MUT2 || '#6b7480';
  ctx.font = `400 28px ${SANS}`;
  ctx.fillText(`${fmtDate(rec.start, false)} → ${fmtDate(rec.end, false)} · ${rec.days} 天`, P, rangeY);

  /* 结局评语（全版，≤2 行） */
  ctx.fillStyle = t.MUT || '#8f9aa6';
  ctx.font = `400 ${epSize}px ${SANS}`;
  epLines.forEach((ln, k) => ctx.fillText(ln, P, epiFirst + k * EPI_DY));

  /* 交易明细（两行）—— 第一行逐段上色（胜 / 负 / 胜率走涨跌色，其余次要灰），
     第二行仍是次要灰。⚠️ 逐段推进 `sx`（按 `measureText` 累加），字号统一走 `sSize`
     （与第二行同档，两行不会一大一小）。 */
  ctx.font = `400 ${sSize}px ${SANS}`;
  let sx = P;
  for (const [txt, cls] of segsA) {
    ctx.fillStyle = cls === 'up' ? (t.UP || '#00d18f')
      : cls === 'down' ? (t.DOWN || '#ff5b6a') : (t.MUT2 || '#6b7480');
    ctx.fillText(txt, sx, statAY);
    sx += ctx.measureText(txt).width;
  }
  ctx.fillStyle = t.MUT2 || '#6b7480';
  ctx.fillText(statB, P, statBY);

  /* 行为足迹（可选） */
  if (markTxt) ctx.fillText(markTxt, P, markY);

  /* 水印 */
  ctx.textAlign = 'center';
  ctx.font = `400 26px ${SANS}`;
  ctx.fillText('icr3am.com/degen', W / 2, wmY);
  ctx.textAlign = 'left';

  return cv;
}

/** 这张图存下来的文件名 */
export const posterName = rec => `degen-${rec.scen}-${rec.id}.png`;

/**
 * 生成海报（PNG 的 **data URL**）—— 预览层与保存 / 分享**共用同一份像素**，不重复画。
 *
 * ⚠️ **走 `toDataURL` 而不是 `toBlob`**（2026-10-02 修 · 用户反馈「海报图片图裂了」）。
 *    参考项目 `Man in the Mirror` 在 `js/ui.js::downloadPoster` 上留了同一句结论：
 *    「同步 data: URI 锚点下载，跨平台（含 Android WebView）可靠；避免 `toBlob` 在部分设备
 *      回调不来 / 抛错导致下载无反应（**旧安卓裂图**同类问题）」。
 *    本作原来是 `toBlob` → `URL.createObjectURL` → `<img src>`：在那类设备上就是一张裂图。
 *    换成 data URL 之后，预览与下载共用同一个串，**blob URL 的生命周期管理整块消失**。
 * @returns {string|null} canvas 取不到 / `toDataURL` 抛错都给 `null`（调用方只管报错）
 */
export function posterURL(rec) {
  try { return drawCard(rec).toDataURL('image/png'); } catch { return null; }
}

/** data URL → Blob（只有「原生分享要 File」与「老 iOS 新窗口兜底」两处需要它） */
function dataURLToBlob(url) {
  const i = String(url || '').indexOf(',');
  if (i < 0) return null;
  try {
    const bin = atob(String(url).slice(i + 1));
    const u8 = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
    return new Blob([u8], { type: 'image/png' });
  } catch { return null; }
}

/** 这台机器有没有**原生分享面板**（没有就干脆不画那枚「分享」键，见 `render.openPoster`） */
export const canSharePoster = () => typeof File === 'function'
  && typeof navigator.canShare === 'function' && typeof navigator.share === 'function';

/**
 * 保存海报 —— 与 PWA 安装同一套两级兜底：
 *   ① `<a download>` 直接下载（`data:` 锚点，跨平台最可靠，见 `posterURL`）；
 *   ② iOS 老 Safari 没有 `download` ⇒ 新窗口打开，长按保存。
 * ⚠️ **不回退到「分享」**：预览层里那枚「分享」就在旁边，两条路各管各的（LESS IS MORE）。
 * ⚠️ ② 这一支要**先换回 blob URL**：Chrome 起禁止顶层导航到 `data:` URL（地址栏只认 blob/http），
 *    所以「靠 data URL 保底」这一手**只对下载锚点成立**，对新窗口不成立。
 * @returns {Promise<'downloaded'|'opened'|'failed'>}
 */
export async function savePoster(url, name) {
  if (!url) return 'failed';

  if ('download' in HTMLAnchorElement.prototype) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return 'downloaded';
  }

  const blob = dataURLToBlob(url);
  const u = blob ? URL.createObjectURL(blob) : url;
  const win = window.open(u, '_blank');
  if (!win) { if (blob) URL.revokeObjectURL(u); return 'failed'; }   // 被拦截：算失败，别把 URL 漏在那
  if (blob) setTimeout(() => URL.revokeObjectURL(u), 60000);          // 留一分钟，够长按保存
  return 'opened';
}

/**
 * 用原生分享面板发出去（微信 / 相册 / 推特…都走系统那一张表）。
 * ⚠️ 入参是 `posterURL` 那串 **data URL**：原生分享要的是 `File`，在这里现转一次
 *    （`dataURLToBlob` 是同一份像素的另一种包装，不重画）。
 * @returns {Promise<'shared'|'unsupported'|'failed'>}
 */
export async function sharePoster(url, name) {
  if (!url) return 'failed';
  if (!canSharePoster()) return 'unsupported';
  const blob = dataURLToBlob(url);
  if (!blob) return 'failed';
  const file = new File([blob], name, { type: 'image/png' });
  if (!navigator.canShare({ files: [file] })) return 'unsupported';
  try {
    await navigator.share({ files: [file], title: 'Degen · 交易生涯' });
    return 'shared';
  } catch (e) {
    /* 用户自己取消（AbortError）也当成功：面板确实弹过，不是代码坏 */
    if (e && e.name === 'AbortError') return 'shared';
    return 'failed';
  }
}
