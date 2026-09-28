/**
 * 入口：把「状态 / 行情 / 引擎 / 渲染」接起来
 * ===============================================================
 * 职责边界与参考项目一致：
 *   core/*  不知道有 UI 这回事
 *   ui/*    只负责画，以及把点击转成 action
 *   main.js 是唯一把两边连起来的地方（也是唯一允许读时钟的地方）
 */

import { maxLeverageAt } from './core/config.js';
import { createState, heldSyms, pushLog } from './core/state.js';
import { load, save, wipe, disableSave } from './core/save.js';
import { loadManifest, loadCoin, loadLiq, isLoaded } from './core/market.js';
import { createClock, openTrade, closeTrade, switchExchange, timeOf, normalizeLeverage } from './core/engine.js';
import { mount, update, renderOver, clearOver, renderBoot, hideBoot, pickExchange, closePicker } from './ui/render.js';
import { bindActions } from './ui/bind.js';

const root = document.getElementById('app');

let s = load() || createState();
let refs = null;
let clock = null;
let restartArmed = false;
let restartTimer = 0;

/* ───────────────────────────── 启动 ───────────────────────────── */

async function boot() {
  renderBoot('正在读取行情数据包…');
  try {
    await loadManifest();
  } catch (err) {
    renderBoot('行情数据包没找到。\n先在项目目录跑一次 `npm run data` 生成 public/data/。', err);
    return;
  }

  await ensureCoin(s.sym);
  for (const sym of heldSyms(s)) await ensureCoin(sym);   // 多仓：手上每个币的行情都要在
  await ensureLiq();

  refs = mount(root);
  hideBoot();

  // 数据到位后把杠杆夹到当前年份允许的范围内（读档时年份可能已经变了）
  normalizeLeverage(s);

  clock = createClock(s, { onFrame: () => draw() });
  clock.start();
  draw();

  bindActions(document.body, dispatch);
  setInterval(() => save(s), 10000);
  window.addEventListener('beforeunload', () => save(s));
}

/** 保证某个币的数据已加载；失败只记一条日志，不让整个游戏崩掉 */
async function ensureCoin(sym) {
  if (isLoaded(sym)) return;
  try {
    await loadCoin(sym);
  } catch (err) {
    pushLog(s, `${sym} 行情加载失败：${err.message}`, 'bad');
  }
}

/**
 * 日流动性只影响「大额转账反噬自己」这一条 —— 读不到就当成永远不触发脉冲，
 * 转账延迟照常由年代基础值 ＋ 历史锚点算出。所以它失败同样**不致命**，只记一条日志。
 * （不静默：真跑不起来时验收口径④会失败，日志是唯一线索。）
 */
async function ensureLiq() {
  try {
    await loadLiq();
  } catch (err) {
    pushLog(s, `日流动性加载失败：${err.message}`, 'bad');
  }
}

/* ───────────────────────────── 每帧 ───────────────────────────── */

/**
 * 渲染节流到 ~12fps。K 线一秒钟最多走 20 根（20x），12fps 足够把每一根都画出来，
 * 又不会让手机一直满负荷重绘（GDD §19.2 省电）。
 *
 * ⚠️ 本局结束的那一帧**必须**落地，不能被节流吞掉：结束时时钟会把 `paused` 置真，
 *    之后不再有任何 `onFrame`，遮罩就永远画不出来（2026-09-28 实测）。
 *
 * ⚠️ 起手 `lastDraw` 必须是 `-Infinity`，不能是 `0`（P2-A 实测）：
 *    `boot()` 末尾那次 `draw()` 没带 force，若此刻 `performance.now() < 80`
 *    （dev server 命中缓存时很常见），第一帧就被节流吞掉。平时无所谓 —— 一秒钟后
 *    时钟推进会有下一帧；但**读到的存档若是暂停态**，`step()` 因 `s.paused` 永不
 *    产生 `moved`，`onFrame` 一次都不来，界面就永久停在骨架状态（日期、HUD、
 *    K 线、杠杆档全空）。注意 `bindActions` 在 `draw()` 之后才挂，所以此时点击
 *    反而正常 —— 按钮一点就补上第一帧，掩盖了「开局一片空白」这个现象。
 */
let lastDraw = -Infinity;
let overDrawn = false;
function draw(force = false) {
  if (s.over && !overDrawn) force = true;
  const now = performance.now();
  if (!force && now - lastDraw < 80) return;
  lastDraw = now;

  if (!refs) return;
  const rect = refs.chartWrap.getBoundingClientRect();
  const view = { chartW: Math.max(1, Math.round(rect.width)), chartH: Math.max(1, Math.round(rect.height - 2)) };

  try {
    update(refs, s, view);
    if (s.over) { closePicker(); renderOver(root, s); }
    else clearOver(root);
    overDrawn = !!s.over;
  } catch (err) {
    renderBoot('渲染失败', err);
  }
}

/* ───────────────────────────── 点击派发 ───────────────────────────── */

function dispatch(node) {
  const d = node.dataset;

  if (d.sym !== undefined) return onSym(d.sym);
  if (d.ex !== undefined) return onEx(d.ex);
  if (d.frac !== undefined) { s.sizeFrac = Number(d.frac); after(); return; }
  if (d.lev !== undefined) {
    const want = Number(d.lev);
    s.lev = Math.max(1, Math.min(want, maxLeverageAt(timeOf(s), s.ex)));
    after();
    return;
  }
  if (d.speed !== undefined) { s.speed = Number(d.speed); after(); return; }
  if (d.pause !== undefined) { if (!s.over) s.paused = !s.paused; after(); return; }
  if (d.restart !== undefined) return onRestart();
  if (d.wipe !== undefined) return onWipe();

  if (d.act === 'long' || d.act === 'short') {
    const r = openTrade(s, d.act, s.sizeFrac);
    if (!r.ok) pushLog(s, r.why, 'bad');
    after();
    return;
  }
  if (d.act === 'close') {
    const r = closeTrade(s);
    if (!r.ok && r.why !== 'liquidated') pushLog(s, r.why, 'bad');
    after();
    return;
  }
}

/**
 * 选所：顶栏那枚「名称 / 费率」按钮点开弹层，弹层里点某一家才真的换。
 * 换所是**免费且即时**的，失败（没开业 / 已归零 / 还挂着仓）只记一条日志。
 */
function onEx(id) {
  if (id === 'pick') {
    if (!s.over) pickExchange(s, refs.exBtn);
    return;
  }
  closePicker();
  const r = switchExchange(s, id);
  if (!r.ok) pushLog(s, r.why, 'bad');
  after();
}

function onSym(sym) {
  if (s.sym === sym) return;
  s.sym = sym;
  // 切到一个没加载过的币：先重画一次（会显示「无行情数据」），拉到之后再刷新
  after();
  if (!isLoaded(sym)) ensureCoin(sym).then(() => draw(true));
}

function onRestart() {
  if (!restartArmed && !s.over) {
    restartArmed = true;
    refs.restartBtn.textContent = '确认';
    refs.restartBtn.classList.add('warn');
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartArmed = false;
      refs.restartBtn.textContent = '重开';
      refs.restartBtn.classList.remove('warn');
    }, 3000);
    return;
  }
  clearTimeout(restartTimer);
  restartArmed = false;
  doRestart();
}

function doRestart() {
  const keepSym = s.sym;
  const keepSpeed = s.speed;
  s = createState();
  s.sym = keepSym;
  s.speed = keepSpeed;
  disableSave();
  wipe();
  location.reload();
}

function onWipe() {
  disableSave();
  wipe();
  location.reload();
}

function after() {
  save(s);
  draw(true);
}

/* ───────────────────────────── 兜底 ───────────────────────────── */

window.addEventListener('error', e => {
  if (!refs) renderBoot('启动失败', e.error || e.message);
});

boot();
