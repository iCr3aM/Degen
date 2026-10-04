/**
 * 生涯海报（M4 建 · M5 · 2026-10-02 由「分享」改为「生成海报」）
 * ===============================================================
 * 把**一条档案记录**（`core/careers.js`）画成一张 **1080×1350** 的竖版 PNG
 * （朋友圈 / 推特的竖图尺寸）。纯 canvas，不碰 DOM 布局。
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
import { OVER_LABEL, badgesOf, epitaphOf, multOf, styleOf, titleOf } from '../core/titles.js';
import { OVER } from '../core/engine.js';
import { theme } from './chart.js';

const W = 1080;
const H = 1350;
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
 *   ⑤ **账本三格**（本金 · 峰值 · 最高杠杆）＋ **交易币种**一整行
 *   ⑥ 资金曲线 / ⑦ 终值 ＋ 倍数 / ⑧ 起止 ＋ 天数 / ⑨ **结局评语** / ⑩ **交易统计** / ⑪ 水印
 * ⚠️ ⑤ 与 ⑨ 是 2026-10-02 补的（用户圈定「必要内容」）：原来只有曲线和终值，
 *    看不出**怎么结束的 / 本钱多少 / 打得怎么样**。
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
  ctx.fillText(OVER_LABEL[rec.reason] || '结束', W - P, 236);
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

  /* 徽章 —— 按宽度**自动折行**（最多 2 行；池子扩到 20 枚后一行放不下）。
     ⚠️ 分隔线与下面几块的位置**跟着最后一行徽章走**（徽章只有一行时版面与旧版逐位一致）。 */
  let bx = P, by = 400, row = 0;
  const bh = 46, gapX = 14, gapY = 8, ROW_MAX = 2;
  ctx.font = `500 26px ${SANS}`;
  for (const b of badgesOf(rec)) {
    const bw = ctx.measureText(b).width + 44;
    if (bx + bw > W - P && row < ROW_MAX - 1) { bx = P; by += bh + gapY; row++; }
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

  /* 账本三格 —— 标签在上（小字灰）、数值在下（等宽大字）。
     ⚠️ 三段纵坐标**全部相对 `sepY`**（`+56 / +112 / +182`）—— 徽章折行、分隔线下移时整段跟着走。 */
  const colW = cw / 3;
  const yLbl = sepY + 56, yVal = sepY + 112, ySym = sepY + 182;
  const ledger = [
    ['本金', fmtMoneyShort(rec.cash0)],
    ['峰值', fmtMoneyShort(rec.peak)],
    ['最高杠杆', `${rec.maxLev}x`],
  ];
  ledger.forEach(([label, value], k) => {
    const x = P + k * colW;
    ctx.fillStyle = t.MUT2 || '#6b7480';
    ctx.font = `400 26px ${SANS}`;
    ctx.fillText(label, x, yLbl);
    ctx.fillStyle = t.FG || '#dbe4f0';
    fitFont(ctx, value, 46, colW - 16, MONO, 700);
    ctx.fillText(value, x, yVal);
  });

  /* 交易币种 —— 单独一整行（名字可能很长，右对齐 ＋ 自适应降字号，不截断） */
  const symTxt = Array.isArray(rec.syms) && rec.syms.length ? rec.syms.join(' · ') : '—';
  ctx.fillStyle = t.MUT2 || '#6b7480';
  ctx.font = `400 26px ${SANS}`;
  ctx.fillText('交易币种', P, ySym);
  ctx.textAlign = 'right';
  ctx.fillStyle = t.FG || '#dbe4f0';
  fitFont(ctx, symTxt, 30, cw - 200, SANS, 500);
  ctx.fillText(symTxt, W - P, ySym);
  ctx.textAlign = 'left';

  /* 曲线 */
  const cy = sepY + 240, chh = 290;
  const eq = Array.isArray(rec.eq) ? rec.eq : [];
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
  ctx.fillText(fmtMoneyShort(rec.final), P, 1140);
  const m = multOf(rec);
  ctx.font = `700 46px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.fillText(`×${m.toFixed(m < 10 ? 2 : 1)}`, W - P, 1140);
  ctx.textAlign = 'left';

  /* 起止 ＋ 天数 */
  ctx.fillStyle = t.MUT2 || '#6b7480';
  ctx.font = `400 28px ${SANS}`;
  ctx.fillText(`${fmtDate(rec.start, false)} → ${fmtDate(rec.end, false)} · ${rec.days} 天`, P, 1196);

  /* 结局评语（2026-10-05 用户拍板）—— 与弹窗 / 档案页**同一句话**（`titles.epitaphOf`）。
     ⚠️ 取 `short`（只档位句）：补白句会让这一行放不下，而海报是单行版面。
     ⚠️ `fitFont` 只降字号、不截断 ⇒ 无论多长都不会溢出画布（档位句最长约 33 字，降不到 20px 以下）。 */
  const ep = epitaphOf(rec, { short: true });
  ctx.fillStyle = t.MUT || '#8f9aa6';
  fitFont(ctx, ep, 28, cw, SANS, 400);
  ctx.fillText(ep, P, 1244);

  /* 交易统计 —— 一局打得怎么样，一行说完。
     ⚠️ `fitFont` 只改 `ctx.font`、不还原（它把 `ctx` 留在最后一档字号上）⇒ 这里必须**显式重设字号**，
        否则本行会继承上一行评语被压缩后的字号（评语越长、统计越小）。 */
  ctx.font = `400 28px ${SANS}`;
  ctx.fillText(`开仓 ${rec.open} 笔 · 胜 ${rec.win} · 负 ${rec.loss} · 爆仓 ${rec.liq}`, P, 1294);

  /* 水印 */
  ctx.textAlign = 'center';
  ctx.font = `400 26px ${SANS}`;
  ctx.fillText('icr3am.com/degen', W / 2, 1338);
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
