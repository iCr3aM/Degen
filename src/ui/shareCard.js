/**
 * 分享卡（M4 · 2026-10-01）
 * ===============================================================
 * 把**一条档案记录**（`core/careers.js`）画成一张 **1080×1350** 的竖版 PNG
 * （朋友圈 / 推特的竖图尺寸）。纯 canvas，不碰 DOM 布局。
 *
 * ⚠️ **称号 / 徽章直接复用 `core/titles.js`** ⇒ 卡片上的称号与档案页**永远同一枚**，
 *    不会两处各写一份判断。
 * ⚠️ **配色全部来自 `chart.js` 的 `theme()`**（与 K 线同一源）⇒ 设置页把涨跌色对调时，
 *    卡片跟着翻，不会出现「游戏里绿涨、卡片里红涨」。
 * ⚠️ 曲线是**档案里那条抽稀过的 `eq`**（`thinEq` 压到 128 点），不是重新读存档。
 *
 * 导出的三级兜底（与 PWA 安装同一条降级口径）：
 *   ① `navigator.canShare({ files })` → `navigator.share()`（原生分享面板）
 *   ② 退化为 `<a download>` 直接下载
 *   ③ iOS 老 Safari 没有 `download` ⇒ 新窗口打开，长按保存
 */

import { scenarioOf } from '../core/config.js';
import { fmtDate, fmtMoneyShort } from '../core/format.js';
import { badgesOf, multOf, titleOf } from '../core/titles.js';
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

/** 画一张卡（返回 `<canvas>`；只在这里碰 DOM，供测试与导出共用） */
export function drawCard(rec) {
  const t = theme();
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');

  /* 底 */
  ctx.fillStyle = t.BG || '#0d0f12';
  ctx.fillRect(0, 0, W, H);

  /* 头部：DEGEN ＋ 副题 */
  ctx.textBaseline = 'alphabetic';
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

  /* 局名 */
  ctx.fillStyle = t.MUT || '#8f9aa6';
  ctx.font = `400 32px ${SANS}`;
  ctx.fillText(scenarioOf(rec.scen).name, P, 236);

  /* 主称号 */
  ctx.fillStyle = t.FG || '#dbe4f0';
  ctx.font = `700 96px ${SANS}`;
  ctx.fillText(titleOf(rec), P, 352);

  /* 徽章（0–7 枚，一行；放不下就自然超出，档案本身也极少满配） */
  let bx = P;
  const by = 400, bh = 52;
  ctx.font = `500 26px ${SANS}`;
  for (const b of badgesOf(rec)) {
    const bw = ctx.measureText(b).width + 44;
    roundRect(ctx, bx, by, bw, bh, 12);
    ctx.strokeStyle = t.LINE || '#232b34';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = t.MUT || '#8f9aa6';
    ctx.textBaseline = 'middle';
    ctx.fillText(b, bx + 22, by + bh / 2 + 1);
    ctx.textBaseline = 'alphabetic';
    bx += bw + 14;
  }

  /* 曲线 */
  const cx = P, cy = 536, cw = W - 2 * P, chh = 470;
  const tone = rec.final >= rec.cash0 ? (t.UP || '#00d18f') : (t.DOWN || '#ff5b6a');
  const eq = Array.isArray(rec.eq) ? rec.eq : [];
  if (eq.length >= 2) {
    drawCurve(ctx, cx, cy, cw, chh, eq, rec.cash0, tone, t);
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
  ctx.fillText(fmtMoneyShort(rec.final), P, 1142);
  const m = multOf(rec);
  ctx.font = `700 46px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.fillText(`×${m.toFixed(m < 10 ? 2 : 1)}`, W - P, 1142);
  ctx.textAlign = 'left';

  /* 起止 ＋ 天数 */
  ctx.fillStyle = t.MUT2 || '#6b7480';
  ctx.font = `400 28px ${SANS}`;
  ctx.fillText(`${fmtDate(rec.start, false)} → ${fmtDate(rec.end, false)} · ${rec.days} 天`, P, 1206);

  /* 水印 */
  ctx.textAlign = 'center';
  ctx.fillStyle = t.MUT2 || '#6b7480';
  ctx.font = `400 26px ${SANS}`;
  ctx.fillText('icr3am.com/degen', W / 2, 1300);
  ctx.textAlign = 'left';

  return cv;
}

/**
 * 生成并导出分享卡。
 * @param {object} rec 档案记录
 * @returns {Promise<'shared'|'downloaded'|'opened'|'failed'>}
 */
export async function shareCareer(rec) {
  let blob;
  try {
    const cv = drawCard(rec);
    blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  } catch {
    return 'failed';
  }
  if (!blob) return 'failed';

  const name = `degen-${rec.scen}-${rec.id}.png`;

  /* ① 原生分享面板（带文件）—— `File` 不存在的老浏览器直接跳过 */
  if (typeof File === 'function' && navigator.canShare && navigator.share) {
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Degen · 交易生涯' });
        return 'shared';
      } catch (e) {
        /* 用户取消（AbortError）也当成功：面板确实弹过，不是代码坏 */
        if (e && e.name === 'AbortError') return 'shared';
        /* 其余错误（含权限）落到下载 */
      }
    }
  }

  const url = URL.createObjectURL(blob);

  /* ② 直接下载 */
  if ('download' in HTMLAnchorElement.prototype) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'downloaded';
  }

  /* ③ iOS 老 Safari：没有 `download` ⇒ 新窗口打开，长按保存 */
  window.open(url, '_blank');
  return 'opened';
}