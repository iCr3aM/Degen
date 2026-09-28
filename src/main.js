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
import { createClock, chanOf, openTrade, closeTrade, otcUnlocked, switchExchange, timeOf, normalizeLeverage, markPrice, takeLoan, giveUp } from './core/engine.js';
import { marginRateOf, isSpot } from './core/positions.js';
import {
  mount, update, renderOver, renderLoan, clearOver, renderBoot, hideBoot,
  pickExchange, confirmExchange, closePicker, openIntro, openSettings,
} from './ui/render.js';
import { bindActions, bindChart } from './ui/bind.js';
import { panBy, zoomBy, resetView, setMode, viewOf } from './ui/view.js';
import * as snd from './ui/sound.js';

const root = document.getElementById('app');

/* ⚠️ `load()` 返回 null 就是**全新一局** —— 开场叙事弹窗只在这一次出现（Batch 4 · B19）。
   读档续玩（哪怕是暂停在 2015 年的档）不该再看一遍开场白。 */
const saved = load();
let s = saved || createState();
const isNewGame = !saved;

let refs = null;
let clock = null;
/* 设置面板里「重开本局」的**双重确认**状态机（Batch 4 · B21）。
   面板是静态 DOM、不参与每帧重绘，所以武装状态只能放在这里 —— 见 `render.openSettings` 的注释。 */
let resetNode = null;
let resetArmed = false;
let resetTimer = 0;

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
  draw();

  bindActions(document.body, dispatch);
  /* K 线手势（Batch 3 · B13/B14）：三个回调都只动**视野**（`view.js`），
     不碰 `s`、不写存档，唯一副作用是立刻重画一帧（拖动不能被 80ms 节流吞掉）。
     复位只在**当前币**上生效；每帧的限位（`chart.js` 里夹）会把越界的视野拉回来。
     ⚠️ 拖动（pan / zoom）刻意**不出声** —— 手指划一下就响，比没声音还吵。 */
  bindChart(refs.canvas, {
    pan: (dx, dy) => { panBy(s.sym, dx, dy, s.i, chartW()); draw(true); },
    zoom: f => { zoomBy(s.sym, f, s.i, chartW()); draw(true); },
    reset: () => { snd.tap(); resetView(s.sym); draw(true); },
  });
  setInterval(() => save(s), 10000);
  window.addEventListener('beforeunload', () => save(s));

  /* 开场叙事（Batch 4 · B19）：**只在新开局弹一次**。
     ⚠️ 弹窗期间**时钟不启动** —— 玩家点「开始交易」（`onIntro`）才真正开盘，
        否则读完三行字回来，行情已经自己走了几十根。 */
  if (isNewGame) openIntro();
  else clock.start();
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

/** K 线区的 CSS 宽度。手势换算「一像素 = 多少根」要用**同一份**，所以单独留一个入口 */
const chartW = () => Math.max(1, Math.round(refs.chartWrap.getBoundingClientRect().width));

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
/* ⚠️ 起手取 `!!s.over`：读档读到一个**已经结束**的档时，不该在开屏第一帧补响一声爆仓 / 结算。 */
let overDrawn = !!s.over;
/* 借贷遮罩（B30）画过没 —— 与 `overDrawn` 同一个理由：`checkRuin` 把 `s.paused` 置真之后
   不会再有任何 `onFrame`，那一帧若被 80ms 节流吞掉，遮罩就永远出不来。 */
let loanDrawn = !!s.pending;

/**
 * 把「刚刚发生的事」翻译成声音（Batch 4 · B20）。
 *
 * 为什么放在渲染层而不是逻辑层：`core/*` 是纯逻辑、零浏览器 API（GDD 的分层约束），
 * 不能在里面 `new AudioContext()`。UI 这边只需要看**日志头一条变没变** —— 逻辑层本来
 * 就把所有值得知道的事都写进日志了，不需要为音效再加一条专用通道。
 *
 * 分工（避免同一件事响两声）：
 *   - 玩家点出来的动作：`dispatch` 里直接发声（开仓 / 平仓 / 轻点）
 *   - 时间推出来的事件：这里按日志文案认
 *   - 结束画面：`draw()` 里按 `s.over.reason` 认
 */
let lastLogKey = null;
const warnedSyms = new Set();
const FUNDING_TAG = '资金费率';

function soundFromTick(s) {
  const last = s.log[0];
  if (last) {
    const key = `${last.at}|${last.text}`;
    if (lastLogKey === null) lastLogKey = key;      // 首帧只记锚点，不补响历史事件
    else if (key !== lastLogKey) {
      lastLogKey = key;
      if (last.text.startsWith(FUNDING_TAG)) (last.kind === 'ok' ? snd.fundUp : snd.fundDown)();
      else if (last.text.includes('推高拥堵')) snd.pulse();
    }
  }

  /* 保证金率跌破 5%：**进入**那一刻响一次，回到安全区后重置（不然每帧都在响）。
     与持仓条第三格同一个判据（`rate < 0.05` 转红），现货没有维持保证金率这一说，跳过。 */
  for (const sym of heldSyms(s)) {
    const pos = s.positions[sym];
    if (isSpot(pos)) { warnedSyms.delete(sym); continue; }
    const mark = markPrice(s, sym);
    const rate = mark == null ? 1 : marginRateOf(pos, mark);
    if (rate < 0.05) {
      if (!warnedSyms.has(sym)) { warnedSyms.add(sym); snd.warn(); }
    } else {
      warnedSyms.delete(sym);
    }
  }
}

function draw(force = false) {
  if ((s.over && !overDrawn) || (s.pending && !loanDrawn)) force = true;
  const now = performance.now();
  if (!force && now - lastDraw < 80) return;
  lastDraw = now;

  if (!refs) return;
  const rect = refs.chartWrap.getBoundingClientRect();
  const view = { chartW: Math.max(1, Math.round(rect.width)), chartH: Math.max(1, Math.round(rect.height - 2)) };

  try {
    update(refs, s, view);
    if (s.over) {
      closePicker();
      renderOver(root, s);
      // 结束音只响一次（`overDrawn` 是「这一局结束的画面画过了没」）
      if (!overDrawn) (s.over.reason === 'settled' ? snd.settle : snd.liq)();
    } else if (s.pending === 'loan') {
      /* 归零待决（B30）：遮罩替掉正常界面，时钟已停。
         不给它配音效 —— 「账户归零」那条日志已经响过 warn 了（`soundFromTick`）。 */
      closePicker();
      renderLoan(root, s);
    } else {
      clearOver(root);
      soundFromTick(s);
    }
    overDrawn = !!s.over;
    loanDrawn = !!s.pending;
  } catch (err) {
    renderBoot('渲染失败', err);
  }
}

/* ───────────────────────────── 点击派发 ───────────────────────────── */

function dispatch(node) {
  const d = node.dataset;

  /* 通用轻点反馈（Batch 4 · B20）—— 除了**成交 / 重开**这两类有专属音的动作，其余键都响这一声。
     逻辑：一次点击最多响一次，任何时刻都不会叠。 */
  if (d.act !== 'long' && d.act !== 'short' && d.act !== 'close' && d.reset === undefined) snd.tap();

  if (d.intro !== undefined) return onIntro();
  if (d.loan !== undefined) return onLoan(d.loan);
  if (d.settings !== undefined) return onSettings();
  if (d.snd !== undefined) return onSoundToggle(node);
  if (d.reset !== undefined) return onReset(node);
  if (d.sclose !== undefined) return onCloseSettings();

  if (d.sym !== undefined) return onSym(d.sym);
  if (d.chan !== undefined) return onChan();
  if (d.ex !== undefined) return onEx(d.ex);
  /* 换所二次确认的两个出口（Batch 2 · B10）—— 确认键自带目标所 id，所以不需要额外的「待确认」状态。 */
  if (d.exok !== undefined) {
    closePicker();
    const r = switchExchange(s, d.exok);
    if (!r.ok) pushLog(s, r.why, 'bad');
    after();
    return;
  }
  if (d.exno !== undefined) { closePicker(); after(); return; }
  if (d.frac !== undefined) { s.sizeFrac = Number(d.frac); after(); return; }
  if (d.lev !== undefined) {
    /* OTC 通道只有现货 ⇒ 杠杆被锁在 1x。这里只给一条日志、**不改 s.lev** ——
       他切回盘口时那个杠杆还在，不必重新点一遍（Batch 5 的 `数据不擅自改` 口径）。 */
    if (chanOf(s) === 'otc') { pushLog(s, 'OTC 通道只有现货，杠杆固定 1x', 'info'); after(); return; }
    const want = Number(d.lev);
    s.lev = Math.max(1, Math.min(want, maxLeverageAt(timeOf(s), s.ex)));
    after();
    return;
  }
  if (d.speed !== undefined) { s.speed = Number(d.speed); after(); return; }
  /* 粒度切换（Batch 3 · B12）：小字上写的是**当前**粒度，点一下切到另一种。
     只动视野，不动玩法 —— `s.i` 永远还是「第几根小时 K」。 */
  if (d.mode !== undefined) {
    setMode(s.sym, viewOf(s.sym).mode === '1d' ? '1h' : '1d', s.i, chartW());
    after();
    return;
  }
  if (d.pause !== undefined) { if (!s.over) s.paused = !s.paused; after(); return; }
  /* 结束遮罩上的「重新开始」：本局都已经结束了，没有必要再问一遍（Batch 4 起彻底直通）。 */
  if (d.restart !== undefined) return doRestart();
  if (d.wipe !== undefined) return onWipe();

  if (d.act === 'long' || d.act === 'short') {
    const r = openTrade(s, d.act, s.sizeFrac);
    if (!r.ok) pushLog(s, r.why, 'bad');
    else snd.open();
    after();
    return;
  }
  if (d.act === 'close') {
    const r = closeTrade(s);
    if (!r.ok && r.why !== 'liquidated') { pushLog(s, r.why, 'bad'); snd.tap(); }
    else snd.close();
    after();
    return;
  }
}

/**
 * 选所：顶栏那枚「名称 / 费率」按钮点开弹层（`data-ex="pick"`），
 * 弹层里点某一家（`data-ex=交易所 id`）**不立刻搬** —— 先弹二次确认（Batch 2 · B10），
 * 确认按钮带 `data-exok=交易所 id`，取消带 `data-exno`。
 *
 * 为什么分成三段：换所是一笔要等好几根 K 线的链上转账，点错一次代价是整个等待周期白费。
 * 失败（没开业 / 已归零 / 还挂着仓）由 `switchExchange` 判，只记一条日志。
 */
function onEx(id) {
  // 结束 / 待借贷决策（B30）时换所没有意义：待决态下只该回答遮罩上那个问题
  if (s.over || s.pending) { closePicker(); return; }
  if (id === 'pick') {
    pickExchange(s, refs.exBtn);
    return;
  }
  // 点「当前所」这一行：本来就无事可做，直接收掉弹层，不必问一句再切到自己
  if (id === s.ex) { closePicker(); return; }
  confirmExchange(s, id);
}

function onSym(sym) {
  if (s.sym === sym) return;
  s.sym = sym;
  // 切到一个没加载过的币：先重画一次（会显示「无行情数据」），拉到之后再刷新
  after();
  if (!isLoaded(sym)) ensureCoin(sym).then(() => draw(true));
}

/**
 * 通道切换（P2-B3 · GDD §15.3）—— 盘口 ⇄ OTC。
 * ⚠️ 解锁判据统一走 `otcUnlocked`（引擎里那份），这里不另算一遍：两处各写一遍迟早会不一致。
 */
function onChan() {
  if (!otcUnlocked(s)) return;
  s.chan = chanOf(s) === 'otc' ? 'book' : 'otc';
  /* 切到 OTC 就把杠杆归 1：OTC 只有现货，让操作区当场显示 1x 比事后再拒绝更直白。
     切回盘口**不还原**原来的杠杆 —— 那需要多存一个字段，而 `1x` 是个安全的默认值。 */
  if (s.chan === 'otc') s.lev = 1;
  after();
}

/* ── 开场叙事（Batch 4 · B19）─────────────────────────────────────
   弹窗期间时钟是停的（见 `boot`），点「开始交易」才真正开盘并放一声起手音。 */
function onIntro() {
  closePicker();
  /* 开局写一条**真实发生的事**（Batch 5 · B24）：日志条原来是写死的「等待开盘…」兜底，
     可此刻行情其实已经在跑 —— 文案与实况自相矛盾。这条日志把空态填掉，
     时间戳取 `s.i = 0`（`pushLog` 自己取），语义正确。读档续玩不补（与开场弹窗同一判据）。 */
  pushLog(s, '开盘 · 2013 年 1 月，门头沟', 'info');
  clock.start();
  snd.begin();
  after();
}

/** 借贷遮罩上的两枚按钮（Batch 5 · B30）：借 → `takeLoan`；收摊 → `giveUp`（真的结束本局） */
function onLoan(what) {
  if (what === 'take') {
    const r = takeLoan(s);
    if (!r.ok) pushLog(s, r.why, 'bad');
  } else {
    giveUp(s);
  }
  after();
}

/* ── 设置面板（Batch 4 · B21）─────────────────────────────────────
   顶栏第三枚按钮由「重开」改为「设置」：重开挪进面板，且必须**双重确认** ——
   它是全屏唯一会毁掉整局的操作，用一个 42px 的小按钮一键完成太危险。
   ⚠️ 面板是**静态 DOM**（不参与每帧重绘），所以「已武装」这个状态只能存在这里，
      不能写进 `refs` —— 一重绘就被抹掉。 */
function onSettings() {
  if (s.over || s.pending) return;
  cancelReset();
  openSettings(snd.isMuted());
}

/** 音效开关：先落盘再改按钮外观，静音时**不响**（否则关掉它还会「嗒」一下） */
function onSoundToggle(node) {
  const muted = !snd.isMuted();
  snd.setMuted(muted);
  node.textContent = muted ? '关' : '开';
  node.classList.toggle('on', !muted);
  if (!muted) snd.tap();
}

function onCloseSettings() {
  cancelReset();
  closePicker();
  after();
}

/** 重开：第一次点击只「武装」并把按钮变红，3 秒内再点一次才真重开 */
function onReset(node) {
  if (!resetArmed) {
    resetArmed = true;
    resetNode = node;
    node.textContent = '确认重开';
    node.classList.add('warn');
    clearTimeout(resetTimer);
    resetTimer = setTimeout(cancelReset, 3000);
    return;
  }
  doRestart();
}

/** 撤销武装：超时、关闭面板、切去别处都要把按钮还原，免得下次点开还是红的 */
function cancelReset() {
  clearTimeout(resetTimer);
  resetArmed = false;
  if (resetNode) {
    resetNode.textContent = '重开本局';
    resetNode.classList.remove('warn');
    resetNode = null;
  }
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
