/**
 * 本地 headless 点击链路校验（2026-10-09）
 * ===============================================================
 * 用 Playwright 起**本地构建**（`vite preview`，只打 localhost），把游戏内所有动作键
 * （`data-*`）逐一点一遍，**捕获任何页面异常 / console error** —— 验证「按钮 → bind 派发 →
 * main.dispatch 认领 → 处理器」这条运行链路无 BUG。
 *
 * ⚠️ 与 `sim-audit.mjs` 的分工：那个是**纯 Node、无 DOM** 的源码/数值锚（跑得飞快、进 CI）；
 *    这个是**真浏览器**的运行链路冒烟 —— 补上静态审计测不到的一类：`pointerdown` 派发、
 *    handler 内部分支真的执行时会不会 throw（`nt[F] is not iterable` 那种就属于这类）。
 * ⚠️ 不截图、不碰线上：只 `goto` 本地 `http://localhost:<port>/`。
 *
 * 用法：`node tools/smoke-click.mjs`（会自动 build 一次，再起 preview）。
 * 退出码：0 = 全过；1 = 有页面异常 / console error。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4399;
const BASE = `http://localhost:${PORT}/`;

/* 逐屏动作序列。每项 = [说明, CSS 选择器]；选择器可能命中多个（如各档按钮），
   `nth` 指定点第几个（默认第一个）。点了不存在 / 被禁用的元素只记 warn、不算失败 ——
   冒烟的目的是「点到的都别炸」，不是「每颗按钮都必须此刻可用」。 */
const STEPS = [
  /* ⚠️ 一上来先「开始交易」把**全新一局**开出来：fresh context 没有档 ⇒ 直接
     `startNewGame` ＋ reload ⇒ 回来就弹**开场白**（菜单那种 boot 不弹）。这样
     `[data-intro]` 那两枚键（我是新手 / 我是老手）才进得了链路。 */
  ['主菜单 · 开始交易（开新局 + reload）', '[data-menu="start"]', 0, 1, 4000],
  ['开场「我是新手」', '[data-intro="new"]'],
  ['底部 Tab · 资产', '[data-tab="assets"]'],
  ['底部 Tab · 设置', '[data-tab="settings"]'],
  ['设置 · 音量中档', '[data-vol="2"]'],
  ['设置 · 动效全开', '[data-fx="2"]'],
  ['设置 · 涨跌色', '[data-colors]'],
  ['设置 · 新手提示', '[data-hint]'],
  ['设置 · 行情音', '[data-market]'],
  /* ⚠️ 开关类点**两次**（开→关→开）：只点一次会把浮窗关掉，后面 `[data-gofloat]` 圆钮就
     整颗不存在、浮窗那一整段链路会被静默跳过（2026-10-09 实测）。 */
  ['设置 · 市场浮窗开关 ×2', '[data-mktfloat]', 0, 2],
  ['设置 · 震动自检', '[data-vibtest]'],
  ['底部 Tab · 交易', '[data-tab="trade"]'],
  ['切币种', '[data-sym]', 1],
  ['倍速档', '[data-speed]', 1],
  ['杠杆/合约段控', '[data-mode2]', 1],
  ['开仓比例档', '[data-frac]', 1],
  ['做多', '[data-act="long"]'],
  ['杠杆档位', '[data-lev]', 2],
  ['保证金 − 步进', '[data-mg="subcur:0.25"]'],
  ['保证金 ＋ 步进', '[data-mg="addcur:0.25"]'],
  ['平仓', '[data-act="close"]'],
  ['盘口/OTC 切换', '[data-chan]'],
  ['粒度小字', '[data-mode]'],
  ['暂停', '[data-pause]'],
  ['继续', '[data-pause]'],
  ['打开日志浮层', '[data-log]'],
  /* 日志浮层**没有关闭按钮**（2026-10-09 读源码确认）：点暗底 `.pick-back` 关（`openLog` 里
     `back.addEventListener('pointerdown', closePicker)`）—— 原来写 `[data-sclose]` 是错的。 */
  ['关日志浮层（点暗底）', '.pick-back'],
  ['资产 · 曲线区间', '[data-eqrange="30"]'],
  ['资产 · 买 U 档', '[data-buyu="0.5"]'],
  ['回主菜单', '[data-home]'],
  ['主菜单 · 读取存档', '[data-menu="load"]'],
  ['存档弹窗 · 返回', '[data-menuback]'],
  ['主菜单 · 挑战模式', '[data-menu="scen"]'],
  ['挑战弹窗 · 返回', '[data-menuback]'],
  ['主菜单 · 交易档案', '[data-menu="careers"]'],
  ['档案 · 返回', '[data-careers="exit"]'],
  ['主菜单 · 开始交易', '[data-menu="start"]'],
  /* 上帝：主菜单图标连点 5 次（入口是连点，不是按钮） */
  ['上帝入口 · 连点 ×5', '[data-god="logo"]', 0, 5],
  ['上帝 · 页签 资金·时间', '[data-godtab="0"]'],
  ['上帝 · 页签 沙盒', '[data-godtab="1"]'],
  ['上帝 · 页签 操盘', '[data-godtab="2"]'],
  ['上帝 · 加钱', '[data-godcash]'],
  ['上帝 · 信息', '[data-godinf]'],
  ['上帝 · 年档', '[data-godyear]', 1],
  ['上帝 · 月档', '[data-godmon]', 1],
  ['上帝 · 深度档', '[data-godliq]', 1],
  ['上帝 · 拉盘组合拳', '[data-godpump="1"]'],
  ['上帝 · 插针', '[data-godpin="1"]'],
  ['上帝 · 假消息', '[data-godnews="1"]'],
  ['上帝 · 真实新闻开关', '[data-godreal]'],
  ['上帝 · 强平叠加', '[data-godliqov]'],
  ['上帝 · 世界预设', '[data-sbpreset]'],
  ['上帝 · 随机种子', '[data-sbroll]'],
  ['上帝 · 应用种子', '[data-sbseed]'],
  ['上帝 · 浮窗开关 ×2', '[data-godfloat]', 0, 2],
  ['上帝 · 透明档', '[data-godalpha]'],
  ['关上帝面板', '[data-sclose]'],
  /* 浮窗（上帝局）：圆钮 → 五页 → 订单档位 → 关 */
  ['浮窗圆钮', '[data-gofloat]', 0, 1, 260, true],
  ['浮窗页 · 订单', '[data-goftab="3"]'],
  ['订单档 ×8', '[data-gofstep="8"]'],
  ['订单档 ×1', '[data-gofstep="1"]'],
  ['浮窗页 · 日志', '[data-goftab="4"]'],
  ['日志过滤档 · 5%', '[data-goffilt="4"]'],
  ['日志过滤档 · 0.1%', '[data-goffilt="0"]'],
  ['浮窗页 · 热力', '[data-goftab="0"]'],
  ['浮窗页 · 巨鲸', '[data-goftab="1"]'],
  ['浮窗页 · 深度', '[data-goftab="2"]'],
  ['浮窗关闭', '[data-gofclose]'],
  /* 重开本局—— 设置页那枚是 `data-reset`（`onReset` **双重确认**：第一次点只「武装」、
     再点才真重开 → `doRestart`）。⚠️ 上帝局重开 = 重开上帝模式（投上帝信箱 ＋ reload），
     这正是用户报 `nt[F] is not iterable` 的那条链路。`wait` 给足，等 reload ＋ 行情重新 fetch。
     ⚠️ `data-restart` 是**结束遮罩**上那枚「重新开始」（无确认、直通 `doRestart`）—— 两枚键别混。 */
  ['底部 Tab · 设置（为「重开本局」）', '[data-tab="settings"]'],
  ['重开本局（双重确认，触发 reload）', '[data-reset]', 0, 2, 4000],
  /* reload 回来应是**上帝局**（信箱生效）⇒ 顶栏标题 `data-god="tap"` 一点就开面板。
     ⚠️ 菜单 logo（`data-god="logo"`）此刻不在屏上 —— 回主菜单才点得到。 */
  ['重开后 · 顶栏标题开面板', '[data-god="tap"]'],
  ['重开后 · 上帝面板仍可开（沙盒页签）', '[data-godtab="1"]'],
  ['回主菜单（为再测入口）', '[data-home]'],
  ['上帝入口 · 连点 ×5', '[data-god="logo"]', 0, 5],
  ['上帝 · 含泪收摊(wipe)', '[data-wipe]'],
];

/* 点完某一步之后要**断言 DOM 事实**的探针（不只是「没抛异常」）。
   键 = 那一步的说明；值是 `[在页面里求值的表达式, 失败时印的话]`，表达式**为真 = 通过**。 */
const PROBES = {
  '主菜单 · 交易档案': [
    [`!document.querySelector('.god-chip') && !document.querySelector('.god-float')`,
      '档案页上仍有浮窗残留（圆钮 / 面板应被摘掉）'],
    [`!document.querySelector('.menu-box')`, '档案页上主菜单没收掉'],
  ],
  /* ⚠️ 不要在新局开局断言「没有浮窗」—— 普通局的**市场浮窗**默认就是开的（`mktFloatOn`），
     那枚圆钮本来就该在。真正的不变量是**主菜单在时**一颗浮窗都不许留（用户原话
     「进入主菜单所有状态都要清空，不能出现残留」）。 */
  '回主菜单': [
    [`!!document.querySelector('.menu-box')`, '回主菜单后菜单没弹出来'],
    [`!document.querySelector('.god-chip') && !document.querySelector('.god-float')`,
      '主菜单在屏上却还挂着浮窗圆钮 / 面板（状态没清空）'],
  ],
  /* 上帝面板真开出来的证据：`openGod` 的容器是 `.confirm.godp` —— 它存在 = 那一长串
     页签 / 旋钮 / 操盘台 DOM 全建完了 = 没有在中途被抛炸掉（P0「点 degen 无弹窗」）。 */
  '上帝 · 加钱': [
    [`!!document.querySelector('.godp') && document.querySelectorAll('.godp .set-btn').length >= 20`,
      '上帝面板不在屏上 / 只建了半截（`openGod` 中途抛了？）'],
  ],
  /* ── 订单簿：口径自适应 ＋ 装框恒定（用户两条抱怨的自动化锚）─────────────────
     `浮窗页 · 订单` 时 `bookStep` 还是 ×1 ⇒ 记下当前行数；之后切 ×8 / 切回 ×1
     都必须**行数一模一样**（每侧固定 VIEW 行 ⇒ 不跳动），但**价格跨度必须变**（口径真变了）。
     行数一样 = 装框不跳；跨度变 = 档位不是摆设。 */
  '浮窗页 · 订单': [
    [`(window.__gbN = document.querySelectorAll('.gb-row').length) > 0
       && (window.__gbSpan1 = window.__gbSpan = (() => {
         const p = [...document.querySelectorAll('.gb-row > i')].map(n => parseFloat(n.textContent.replace(/[^0-9.]/g, '')));
         return Math.max(...p) - Math.min(...p);
       })()) > 0`,
      '订单页一行都没渲染 / 价格跨度算不出来'],
  ],
  '订单档 ×8': [
    [`(() => {
       const rows = [...document.querySelectorAll('.gb-row')];
       const p = rows.map(r => parseFloat(r.querySelector('i').textContent.replace(/[^0-9.]/g, '')));
       /* 有货行 = 量条宽度非 0（空档必须 width 0 = 不画条）。*/
       const nz = rows.filter(r => { const u = r.querySelector('u'); return u && u.style.width !== '0%' && u.style.width !== '0px'; }).length;
       window.__gbNz = nz;
       return rows.length === window.__gbN
         && Math.max(...p) - Math.min(...p) > window.__gbSpan1 * 3
         && nz / rows.length >= 0.5;
     })()`,
      '×8：行数变了（装框跳动）／跨度没放大（档位形同虚设）／远处大面积空行（铺平失效）'],
  ],
  '订单档 ×1': [
    [`document.querySelectorAll('.gb-row').length === window.__gbN`,
      '切回 ×1 行数变了（装框跳动）'],
  ],
  /* ── 日志过滤档（2026-10-09 用户拍板⑥）：五档（0.1% / 0.5% / 1% / 2% / 5% 当日流动性）——
     点 5% 后**第 5 档高亮**（`logFilt` 写进去、下一帧重画跟随），切回 0.1% 高亮跟随。 */
  '日志过滤档 · 5%': [
    [`(() => {
       const steps = [...document.querySelectorAll('[data-goffilt]')];
       const on = document.querySelector('[data-goffilt].on');
       return steps.length === 5 && !!on && on.dataset.goffilt === '4';
     })()`,
      '日志过滤档不是五档 / 点了 5% 高亮没落到第 5 档（goffilt 链路断了？）'],
  ],
  '日志过滤档 · 0.1%': [
    [`(() => {
       const on = document.querySelector('[data-goffilt].on');
       return !!on && on.dataset.goffilt === '0';
     })()`,
      '切回 0.1% 后高亮没跟随'],
  ],
  '上帝 · 含泪收摊(wipe)': [
    [`true`, '占位（boot 面板只在加载失败时出现）'],
  ],
};

function startServer() {
  /* `vite preview` 起的是**已构建产物**（dist）——与审计/线上同源；`--strictPort` 保证端口确定。 */
  const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: process.cwd(),      // 从项目根跑（`node tools/smoke-click.mjs`）
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

async function waitServer(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

const server = startServer();
let code = 0;
try {
  if (!await waitServer()) throw new Error('preview 服务未在 20s 内起来');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  /* 把「异常 → 当时在点哪一颗键」绑起来：mark 由每步开头写入，捕获时一并快照。 */
  const ctx = { at: '（启动阶段）' };
  const shot = (kind, e) => {
    const stack = (e && e.stack ? String(e.stack) : '').split('\n').slice(0, 6).join('\n      ');
    errors.push({ at: ctx.at, kind, msg: e && e.message ? e.message : String(e), stack });
  };
  page.on('pageerror', e => shot('pageerror', e));
  page.on('console', m => { if (m.type() === 'error') shot('console.error', { message: m.text() }); });

  /* headless 没有 `navigator.vibrate` ⇒ `render.js` 的 `vibSupported()` 为假、**整行不建**
     （设计如此），于是 `[data-vibtest]` 永远点不到、那两段链路静默漏测。补一枚桩：
     只让那一行建出来、按钮点得到，`sound.js` 里的 `buzzTest` 仍是空转（不影响其他断言）。 */
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'vibrate', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 1, configurable: true });
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#app', { timeout: 10000 });
  await sleep(1500);   // 等行情数据 fetch 完 + 首帧渲染

  let clicked = 0, missed = 0;
  const missedLabels = [];
  const probes = [];
  for (const [label, sel, nth = 0, repeat = 1, wait = 140, up = false] of STEPS) {
    ctx.at = label;
    /* 用真实 `pointerdown` **程序化派发**（而不是 `page.click`）：① 不受可见性/遮挡影响 ——
       隐藏页上的键也能点到，把分派链路走全；② 与真机一致走 bind.js 的 PRIMARY_EVENT
       （`pointerdown`）通道。`el.click()` 不行：`[data-god="logo"]` 是 `<svg>`，没有 `.click()`。 */
    const r = await page.evaluate(({ sel, nth, repeat, up }) => {
      const els = document.querySelectorAll(sel);
      const el = els[nth];
      if (!el) return { ok: false, n: els.length };
      const opt = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: 0, clientY: 0, detail: 0 };
      const mk = t => (typeof PointerEvent === 'function' ? new PointerEvent(t, opt) : new MouseEvent(t, opt));
      for (let i = 0; i < repeat; i++) {
        el.dispatchEvent(mk('pointerdown'));
        /* 浮窗圆钮（`data-gofloat`）是**拖拽 / 点按二合一**：点按的判定在 `pointerup`
           （位移 < 6px 才展开），只发 `pointerdown` 它永远不会展开。 */
        if (up) el.dispatchEvent(mk('pointerup'));
      }
      return { ok: true, n: els.length };
    }, { sel, nth, repeat, up: !!up });
    if (r.ok) clicked++; else { missed++; missedLabels.push(label); }
    await sleep(wait);
    /* DOM 事实探针（比「没抛异常」更强的一层）：只在这一步**点到了**时才断言 ——
       键不在屏上时断言必然误报。 */
    if (r.ok && PROBES[label]) {
      for (const [expr, msg] of PROBES[label]) {
        let ok2 = false;
        try { ok2 = await page.evaluate(`(() => (${expr}))()`); } catch (e) { ok2 = false; }
        if (!ok2) probes.push(`[${label}] ${msg}`);
      }
    }
    /* reload（重开本局 / 换档）会把 `#app` 整个换掉：等它回来，否则后面几步全打空。 */
    if (wait > 1000) {
      try { await page.waitForSelector('#app', { timeout: 15000 }); await sleep(1200); } catch { /* 兜底 */ }
    }
  }
  /* 收尾再等一拍 —— 有些异常是 handler 里的 rAF / 定时器抛的，晚于点击那一刻。 */
  await sleep(800);

  await browser.close();

  /* 失败判据：只认**页面异常 / console.error** —— 那是真正的 BUG。
     点不到（`missed`）只是「此刻这颗键不在屏上」，记一条信息、不算失败。 */
  console.log(`\n点了 ${clicked} 次 · 跳过 ${missed} 次（键不在屏上）`);
  if (missedLabels.length) console.log('  跳过：' + missedLabels.join(' / '));
  if (probes.length) {
    console.log(`\n✗ ${probes.length} 条 DOM 探针未通过：`);
    for (const p of probes) console.log('  ' + p);
    code = 1;
  } else {
    console.log('✓ DOM 探针全通过（浮窗不残留 / 上帝面板真开出来 / 订单簿装框恒定）');
  }
  if (errors.length) {
    const seen = new Set();
    const uniq = [];
    for (const e of errors) {
      const key = `${e.kind}:${e.msg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(e);
    }
    console.log(`\n✗ 捕获 ${uniq.length} 类异常（共 ${errors.length} 次）：`);
    for (const e of uniq) {
      console.log(`  [${e.at}] ${e.kind}: ${e.msg}`);
      if (e.stack) console.log(`      ${e.stack}`);
    }
    code = 1;
  } else {
    console.log('✓ 运行链路无页面异常 / console.error');
  }
} catch (e) {
  console.error('✗ 冒烟脚本自身失败：', e.message);
  code = 1;
} finally {
  server.kill();
}
process.exit(code);