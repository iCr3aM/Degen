/**
 * 入口：把「状态 / 行情 / 引擎 / 渲染」接起来
 * ===============================================================
 * 职责边界与参考项目一致：
 *   core/*  不知道有 UI 这回事
 *   ui/*    只负责画，以及把点击转成 action
 *   main.js 是唯一把两边连起来的地方（也是唯一允许读时钟的地方）
 */

import { GAME, COINS, DEFAULT_SCENARIO, HOUR_MS, OTC, cashCurAt, exchangeOf, hasFinancingAt, isChallenge, maxLeverageAt, scenarioOf, scenarioStartIndex } from './core/config.js';
import { anyHeld, createState, ensureBook, heldSyms, posOf, pushLog } from './core/state.js';
import { SAVE_SLOTS, disableSave, hasSave, load, loadSlot, save, saveSlotOf, slotName, wipe } from './core/save.js';
import { loadManifest, loadCoin, loadLiq, isLoaded, bindFactorSource, bindPlayerVolSource, closeAt, candleAt, volumeAt } from './core/market.js';
import { createClock, chanOf, setChanChoice, equity, exMarkPrice, futuresAvailable, levKind, openTrade, closeTrade, otcUnlocked, otcOpenFor, switchExchange, timeOf, normalizeLeverage, markPrice, takeLoan, giveUp, advanceOneHour, buyUsdt, sampleEquity, rewindTo, dailySigma, pauseLocked, adjustMargin, marginCapsOf, marginStepOf } from './core/engine.js';
import { anchorAt } from './core/anchors.js';
import { RV_NODES, nodeAt, nextNodeAt, speedAt } from './core/review.js';
import { loadCareers, removeCareer } from './core/careers.js';
import { SB_DEFAULT, SB_KEYS, SB_PRESETS, enableGod, factorFor, sbOf } from './core/god.js';
import { fmtDate, fmtMoney, fmtMoneyShort } from './core/format.js';
import { canLiquidate, safetyOf } from './core/positions.js';
import {
  mount, update, renderOver, renderLoan, renderWarn, clearOver, renderBoot, hideBoot,
  pickExchange, confirmExchange, closePicker, openIntro, openMenu, openGod, showPage, openLog,
  renderReview, openNodeCard, openYearPick, openGuide, renderCareers, openPoster,
  isStandalone, toggleInstallGuide, menuRemoveInstall, closeMenuDlg, openSavePick, openScenPick,
  openAbout, redrawChart, openMarginDlg,
} from './ui/render.js';
import { bindActions, bindChart } from './ui/bind.js';
import { panBy, zoomBy, resetView, setMode, viewOf } from './ui/view.js';
import { resetTheme } from './ui/chart.js';
import { canSharePoster, posterName, posterURL, savePoster, sharePoster } from './ui/shareCard.js';
import * as snd from './ui/sound.js';

const root = document.getElementById('app');

/* ── 年代开局（M1 · 2026-10-01）──────────────────────────────────────
   「下一局开哪个年代」的**一次性信箱**：玩家在主菜单挑完 → 写进 localStorage → reload →
   开机第一件事读出来并清掉。为什么必须是独立键而不是存档字段：存档里那一份描述的是**正在玩的
   这一局**，而这里要传的是**下一局**——写进 `degen_save` 等于把两件事混成一个字段。
   ⚠️ 与 `degen_settings` / `degen_colors` 同一口径（浏览器偏好走独立键，不进存档）。
   ⚠️ 这一块**必须排在下面 `takePendingScen()` 那次调用之前**：`SCEN_KEY` 是 `const`，
      函数虽然会被提升，键名却还在暂时性死区里（照原样写在「启动」段会当场抛 TDZ）。 */
const SCEN_KEY = 'degen_next_scen';

/** 读走信箱里的年代 id（读到就清）—— 没有 / 读不动（隐私模式）一律 `null` = 经典全程 */
function takePendingScen() {
  try {
    const v = localStorage.getItem(SCEN_KEY);
    if (v !== null) localStorage.removeItem(SCEN_KEY);
    return v || null;
  } catch { return null; }
}

/** 把年代 id 投进信箱，等下一次 `location.reload()` 消费 */
function stashScen(id) {
  try { localStorage.setItem(SCEN_KEY, id); } catch { /* 隐私模式：存不下就退回经典全程 */ }
}

/* ── 存档槽信箱（2026-10-01 用户拍板：普通 / 挑战各一槽）──────────────
   「下一趟开机读哪一个槽」的一次性信箱，与上面 `SCEN_KEY` 同一副骨架。
   ⚠️ 为什么不能只靠 `load()`：`load()` 缺省「先普通、再挑战」，玩家在挑战局里点
      「开始游戏」想开一局普通时，reload 回来 `load()` 又会把挑战档捞回来 —— 必须有
      一个明确的「这一趟读哪个槽」把它压过。读优先于 `load()`，消费即清。 */
const SLOT_KEY = 'degen_next_slot';

function takePendingSlot() {
  try {
    const v = localStorage.getItem(SLOT_KEY);
    if (v !== null) localStorage.removeItem(SLOT_KEY);
    return v || null;
  } catch { return null; }
}

function stashSlot(slot) {
  try { localStorage.setItem(SLOT_KEY, slot); } catch { /* 隐私模式：存不下就退回 load() */ }
}

/* 这一趟开机是**开新局**（信箱里有年代）还是**读档**（信箱里有槽 / 缺省读）：
   ⚠️ 有年代信箱 ⇒ 一律开新局，**不读档** —— 否则「挑战档还在时想开一局普通」会被它捞回去。
   ⚠️ `loadSlot(slot)` / `load()` 返回 null 就是**全新一局** —— 开场叙事弹窗只在这一次出现
      （Batch 4 · B19）。读档续玩（哪怕是暂停在 2015 年的档）不该再看一遍开场白。
   ⚠️ 走 reload 而不是原地重建 `s`（M1）：`createClock(s)` 闭包捕获的是**开局那一份** `s`，
      原地换对象会让时钟继续推那份旧状态 —— 重开 / 删档本来也一直是 reload，同一条路。 */
const pendingScen = takePendingScen();
const pendingSlot = takePendingSlot();
const saved = pendingScen ? null : (pendingSlot ? loadSlot(pendingSlot) : load());
let s = saved || createState(pendingScen || DEFAULT_SCENARIO);
const isNewGame = !saved;
/* 刚在主菜单挑完年代（或点「开始游戏」）⇒ 这一趟开机**跳过主菜单**，直接进开场白
   （否则会弹回菜单，等于白点）。 */
const fromScenarioPick = isNewGame && !!pendingScen;
/* 刚在主菜单挑了一个**别的**槽（「读取存档 → 挑战 / 普通」）⇒ 这一趟开机也跳过主菜单。
   ⚠️ 与 `fromScenarioPick` 同一条理由：玩家上一步才点的「读取存档 → 挑战」，reload 回来
      又把菜单弹在他脸上，等于白点一次（2026-10-02 审计修）。
   ⚠️ `!!saved` 是必须的：信箱里有槽、但那一槽其实是空的（`loadSlot` 返回 null）时
      走的还是「全新一局」那条路，那时仍该看到菜单。 */
const fromSlotPick = !!pendingSlot && !!saved;

let refs = null;
let clock = null;
/* 设置页里「重开本局」的**双重确认**状态机（Batch 4 · B21）。
   面板是静态 DOM、不参与每帧重绘，所以武装状态只能放在这里 —— 见 `render.js` 的设置页那段注释。 */
let resetNode = null;
let resetArmed = false;
let resetTimer = 0;

/* 主菜单里「开始游戏」的**双重确认**（需求 4 · 方案 §2）：有档时第一次点只「武装」并把按钮变红，
   3 秒内再点一次才真重开。与上面那套是**同一手法**，但状态各自独立（菜单先于设置页存在）。 */
let menuNode = null;
let menuArmed = false;
let menuTimer = 0;
/* 武装时那枚键的**还原函数**（M1）—— 「开始游戏」是纯文字键（还原 `textContent`），
   而年代卡是 `b` ＋ `u` ＋ `span` 三行结构（只换 `b` 那一行）。这套差异收在 `armMenu` 里，
   `cancelMenuArm` 只管调用，不关心按钮长什么样。 */
let menuArmUndo = null;

/* ── PWA（2026-10-01）────────────────────────────────────────────────
   `installEvt`：浏览器交出来的 `beforeinstallprompt` 事件，抓到后**拦下自带横幅**
   （`preventDefault`），改由主菜单里那枚「安装应用」触发（LESS IS MORE：入口收在一处）。
   它**只用一次**：`prompt()` 过就废了，浏览器若还想让玩家装会再发一次事件。
   ⚠️ 这枚事件**只是快路，不是唯一的路**：iOS Safari 与多数国产内核压根不发它，而那些机器
      一样能把游戏装到桌面（走浏览器自带的「安装应用 / 添加到主屏幕」）。所以菜单里那枚
      按钮**不再等它**（见 `render.js` 的 `openMenu`），点了没事件就摊开图文 —— 详见 `onInstall`。 */
let installEvt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvt = e;                  // 菜单里的按钮常驻，不用现补
});

/* 装完（含玩家在浏览器自带的横幅里装的）就把入口收掉 —— 该做的事做完了。
   此时菜单多半还在屏上，留着按钮 ＋ 图文只会让人再走一遍已经走完的流程。 */
window.addEventListener('appinstalled', () => {
  installEvt = null;
  menuRemoveInstall();
});

/* Service Worker（2026-10-01 重做，目标：**上传后手机下一次打开就是新版**）
   ===============================================================
   ⚠️ **只生产环境注册** —— dev 下 vite 自己的模块热更与 SW 缓存打架。
   ⚠️ **脚本 URL 带构建指纹**（`sw.js?v=<BUILD_ID>`）：浏览器判断「要不要更新 SW」靠的是
      **脚本字节比对**，而大多数发版我们根本没改 `sw.js` —— 那就永远不更新，玩家卡在旧策略上。
      换一个 query 就足以让它当成新脚本，立刻装载（`sw.js` 里 `skipWaiting` ＋ `clients.claim`）。
   ⚠️ **装完自动刷一次**：SW 的固有行为 —— 新 SW 接管的那一刻，当前这一屏**仍是旧 JS 渲染的**，
      不主动刷新就等于「上传后要手动开两次」。
      只在**本来就已经被旧 SW 控制**时才刷（`controlled`），首次安装不刷 —— 免得开局白闪一下。
      策略见 `public/sw.js`：`/data/` 走 stale-while-revalidate，其余同源请求 network-first ＋ `no-store`。 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const controlled = !!navigator.serviceWorker.controller;   // ⚠️ 必须在 register 之前取，装完它就非空了
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled || reloaded) return;   // 首次安装 / 已经刷过：不重复
    reloaded = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js?v=${__BUILD_ID__}`).catch(() => {});
  });
}

/* ── 历史回顾模式（需求 4 ·《主菜单与历史回顾模式方案》§3）─────────────────
   `rv` 非 null 就是「正处在回顾态」。**模块级变量、不进 `s`、不进存档**
   （与 `tab` / `godTaps` 同一口径）：重开一局走 `location.reload()`，它自然归零 ——
   `STATE_VERSION` 因此**不动**（仍 11，方案 §6）。
   ⚠️ 回顾**有自己的一支时钟**（下面那三行 `rvTimer/rvLast/rvAcc`）：不能复用 `createClock` ——
      它闭包捕获 `s`，读的是 `s.paused` / `s.speed` / `s.over`，而回顾态一条都不该碰。
   `rv` = `{ i, sym, speed, paused, seen:Set<number>, log:Array }` */
let rv = null;
let rvTimer = 0;
let rvLast = 0;
let rvAcc = 0;

/**
 * 回顾页的**视野命名空间**（2026-10-01 修）。回顾与交易页各有自己的「当前根」
 * （回顾 = `rv.i`、交易页 = `s.i`），视野必须分家 —— 否则在回顾里拖过 BTC 的图，
 * 退回交易页时 BTC 的视野还停在若干年前那一段，而现价签总是当前那一根 ⇒
 * 「柱体与现价签完全错开」。见 `ui/view.js` 的 `keyOf`。
 */
const RV_NS = 'rv';

/* ── 交易档案页（M2 · 2026-10-01）──────────────────────────────────
   `arch` 真 = 正处在档案页。与 `rv` 同一口径：**模块级变量、不进 `s`、不进存档**。
   档案页是**纯只读**的一屏（读 `loadCareers()` 铺列表），没有自己的时钟 —— 进页时把
   主时钟停住即可（与主菜单期间同一条：停在菜单上时行情不该自己走）。 */
let arch = false;

/* 生涯海报的**当前那一张**（M5 · 2026-10-02）：`{ rec, name, url }` 或 `null`。
   ⚠️ 与 `arch` 同一个口径：纯界面状态（预览层里那张图），**不进 `s`、不进存档**。
      `url` 是 **data URL**（PNG），预览、保存、分享三处共用同一串 —— 没有 blob URL
      要回收，`closePoster` 只把引用放掉（见 `ui/shareCard.js::posterURL` 的注释）。 */
let poster = null;

/* 上帝模式的隐藏入口（方案 §2.1）：**1.5 秒内连点顶栏「Degen」5 次**解锁；
   ⚠️ **解锁之后不用再连点** —— `s.god` 非空即「这一局已经开了」，单击标题直接重开面板（2026-10-01）。
   与上面那套双重确认同一个理由 —— 顶栏是静态 DOM、不参与每帧重绘，武装状态只能放在这里。
   ⚠️ 计数**不写进 `s`**：它是个纯手势状态，进存档只会污染状态位（重开一局还得记得清）。 */
const GOD_TAPS = 5;
const GOD_TAP_MS = 1500;
let godTaps = 0;
let godTapAt = 0;

/* 上帝面板日期选择器的**暂存目标**（2026-09-30）—— `{y,m,d}` 或 `null`（= 跟随当前游戏日期）。
   ⚠️ 点「年 / 月 / 日」只改它、**不碰 `s`**；只有点「跳到」才真正动状态（`godJump`）。
      少了这层暂存，在 2 月与 3 月之间来回点就会每一下都触发一次「回到过去」的状态重置。
   ⚠️ 与 `godTaps` 同一个口径：纯界面状态，**不进 `s`**。 */
let godSel = null;

/* 上帝面板当前页（2026-10-05 分页）—— `0` = 资金·时间、`1` = 沙盒。
   ⚠️ 与 `godSel` 同一个口径：纯界面状态，**不进 `s`**；每次重新打开面板归零（L1306/L1320）。 */
let godPage = 0;

/* 当前页（A6 · 方案 §6.3）—— `'trade'|'assets'|'settings'`。
   ⚠️ **模块级变量，不进 `s`**（§9 B6 拍板）：它和 `godTaps` / `resetArmed` 一样只是**界面位置**，
      与 `view.js` 的「看哪一段」同一口径 —— 进存档只会污染状态位，重开一局还得记得清。 */
let tab = 'trade';

/* 资产页资金曲线的**区间**（用户 2026-10-01 拍板）—— 值是「最近多少个游戏日」，`0` = 全部。
   ⚠️ 与 `tab` 同一个口径：纯界面状态，**不进 `s`、不进存档**（重开一局由 `location.reload()` 归零）。 */
let eqRange = 0;

/* 存档脏标记（用户 2026-10-01 拍板）：`after()`（每次玩家动作）已经即时落盘，那个 10 秒定时器
   只是给「时间自己走」兜底 —— 没有推进过就没什么可存，跳过那一次全量 `JSON.stringify` ＋ 写盘。 */
let dirty = false;

/* 「打开日志浮层之前是不是暂停态」（本轮 ①）—— 日志浮层**结束即暂停**，关掉时若不记住原状态，
   就会把玩家的手动暂停静默解除。与上面那些同一个口径：纯界面状态，**不进 `s`**。 */
let logWasPaused = false;

/* ── 新手分步引导（本轮 ④）──────────────────────────────────────
   形态（用户 2026-09-29 拍板）：**高亮目标 ＋ 一句话**，逐步前进（`openGuide` 负责画）。
   ⚠️ 状态是**模块级变量**（`null` = 没在引导），不进 `s`、不进存档 —— 与 `tab` / `rv` /
      `logWasPaused` 同一口径，`STATE_VERSION` 因此**不动**（11）。
   ⚠️ 只在**新局 ＋ 开场选了「我是新手」**（`isNewGame && s.hintOn`）时启动一次：
      读档续玩、或选了「我是老手」，都不弹。
   ⚠️ 引导期间**暂停**（`s.paused = true`）：读字的时候行情不该跑，而遮罩本来就吃掉了
      底下所有点击 —— 玩家除了「下一步」什么也做不了，让它跑纯属白走 K 线。 */
let guideStep = null;
/** 本次引导**实际会走**的步骤（从 `GUIDE` 里筛掉目标当下画不出来的那些）—— 见 `guideSteps()`。 */
let guideList = [];

/** 九步：交易所 → 账户两格 → 币种条 → 行情区 → 热度/OI/多空比 → 下单区 → 持仓条 → 底部 Tab → 通道。
 *  目标从 `refs` 现取（不缓存节点）；步骤序号与「N / M」由 `showGuide` 按**筛过的**表现算，
 *  增减步骤**只改这张表**即可。
 *  ⚠️ 每条文案控制在 ~28 字内：卡片只有一两行位置，再长会被撑高、挤到翻面或越界。 */
const GUIDE = [
  { at: () => refs.exBtn, text: '交易所。点它换所 —— 搬钱要等确认到账，路上还可能被拖上几天。' },
  { at: () => refs.eqVal.closest('.hud'), text: '账户两格：权益＝现金＋保证金＋浮盈；可用保证金能开新仓。' },
  { at: () => refs.symbols, text: '币种条。五个币按真实上线时间逐个解锁，点一下切换行情。' },
  { at: () => refs.chartWrap, text: '行情区。拖动回看、捏合缩放、双击复位；左上角那枚是 K 线粒度。' },
  { at: () => refs.heatChip, text: '左下角：热度＝市场情绪，OI＝该币未平仓名义，多空比＝多头占比。' },
  { at: () => refs.buyBtn, text: '下单区。先选金额与杠杆，再按「买入 / 做多」；上方那枚键切杠杆 / 合约。' },
  { at: () => refs.posbar, text: '持仓条三格：币种＋方向＋杠杆 / 未实现盈亏 / 保证金率（离强平还有多远，1x 多头为 --）。' },
  { at: () => refs.tabBtns.get('trade'), text: '底部三个页：交易 / 资产 / 设置。随时切回来看盘。' },
  { at: () => refs.chanBtn, text: '两条通道：盘口吃滑点；OTC 大宗一口价，单笔有门槛、杠杆封顶 5x。' },
];

/* ── 桌面端连续自适应（用户 2026-10-01 拍板 · 方案 B）────────────────────────────
   把 `--ui` 那段斜坡交给 JS：**1180px 下恰好 1.15**（与旧桌面档逐位一致），
   900–1180px 之间线性爬到 1.15，再宽继续放大、1385px 起封顶 1.35。
   ⚠️ CSS 写不出这种斜坡（media query 只有离散档），所以必须走 JS。
   ⚠️ **只动 ≥900px**：窄于 900px 时 `removeProperty` 把 `--ui` 还给样式表那条
      `:root { --ui: 1 }` ⇒ 手机段与平板段逐位不变（T-1 那条回归红线）。
   ⚠️ 写的是 `<html>` 的**内联样式**：既盖住样式表，也让 `#overlay` 里的弹层跟着缩放
      （弹层是 `body` 的子节点，不在 `#app` 内）。 */
const UI_CAP = 1.35;
let uiLast = null;

function applyUi() {
  const el = document.documentElement;
  const w = el.clientWidth;
  if (w < 900) {
    /* 手机段 / 平板段：把控制权还给 CSS（只在「从桌面缩回来」时做一次） */
    if (uiLast !== null) { el.style.removeProperty('--ui'); uiLast = null; draw(true); }
    return;
  }
  const q = Math.round(Math.max(1, Math.min(UI_CAP, (1.15 * w) / 1180)) * 1000) / 1000;
  if (q === uiLast) return;
  uiLast = q;
  el.style.setProperty('--ui', String(q));
  draw(true);   // 字号变了 ⇒ 立刻重画一帧（canvas 的 CSS 尺寸与像素缓冲要重新对齐）
}

/* ───────────────────────────── 启动 ───────────────────────────── */

async function boot() {
  /* 涨跌色偏好**最先落**（B5）：`:root.red-up` 一挂上，连开机那句话的颜色都是对的 ——
     放到 `mount()` 之后也行，但那样第一次开机画面会闪一下默认色。动效档同理（同一刻落）。 */
  applyRedUp(redUp);
  applyFx(fx);
  /* ⚠️ **点击接线必须最先挂**（2026-10-02 审计修）：下面 `loadManifest()` 失败会**提前 return**，
     而 `mount()` / `bindActions()` 原来都排在它后面 —— 于是「行情数据加载失败」那张面板上
     唯一的一枚「清除存档并重开」成了死键（玩家最后一条自救出口被 return 吞掉）。
     ⚠️ 此刻屏上只有 boot 面板，它上面挂了动作的键只有 `data-wipe` → `onWipe()`，
        而 `onWipe` 不读 `refs` / `clock`（只 disableSave ＋ 清两槽 ＋ reload），提前挂是安全的。 */
  bindActions(document.body, dispatch);
  renderBoot('正在读取行情数据包…');
  try {
    await loadManifest();
  } catch (err) {
    renderBoot('行情数据加载失败。\n请检查网络连接后刷新页面重试。', err);
    return;
  }

  await ensureCoin(s.sym);
  for (const sym of heldSyms(s)) await ensureCoin(sym);   // 多仓：手上每个币的行情都要在
  await ensureLiq();
  preloadUpcoming();     // 读档若正好停在某币解锁前不久，先把它的数据拉下来（不 await，别挡首帧）

  /* 价格位移层（方案 §2.6）：**唯一收口**在 `market.candleAt`。
     注入一个**逐根**系数，markPrice / 权益 / 强平价 / 资金费 / K 线图 / HUD 涨跌幅全部自动跟上。
     ⚠️ 难度在于它**不能**写成「一个全局常数」：一笔单只影响它之后的行情（`j < at ⇒ 1`），
        所以历史 K 线不会被重新标定，收益率会真的变 ⇒ σ 会变（见 `engine.invalidateSigma`）。
     ⚠️ 没有上帝位移也没有冲击池时 `factorFor` 恒返回 1，`candleAt` 走原路径 —— **逐位相同**。
     ⚠️ **回顾态恒返回 1**（ROADMAP §六十五，2026-10-02 修）：注入的这个闭包读的是**运行时**的 `rv`，
        回顾页开着时价格位移必须整条摘掉 —— 否则「你在 2015 年砸的那一笔」会把 2015 年的历史 K 线
        顶出一个台阶。这与量柱那一路的 `own: false`（`view.js`）是同一条口径：那一屏讲的是市场史，
        玩家这一局的痕迹不该混进去（量柱这一路早就挡住了，这里原来漏了）。
        顺带：回顾页画的历史压力位用的是**原始**价位，位移不摘掉的话线会画在已位移的 K 线上、位置对不上。 */
  bindFactorSource((sym, j) => (rv ? 1 : factorFor(s, sym, j)));

  /* 玩家自己的成交量（v17 · 2026-10-01）：同样走**注入**，让 `view.windowFor` 不必认识 `s`。
     没成交的小时恒返回 0 ⇒ 量柱与「只有数据包份额」的那一版**逐位相同**（离线断言靠这条）。 */
  /* ⚠️ v19 起 `pvol[i]` 是**按所分账**的对象（`{ exId: … }`），v20 起再按**产品线**分账
     （`pvol[i][exId][kind] = { u, b }`），v24（2026-10-02）**最外层再套一层币种**
     （`pvol[sym][i][exId][kind]`）。量柱要的是**当前这个币 × 全所 × 两条产品线各自合计的 `u`**
     —— 杠杆一段、合约一段，画布上分色叠画；两段之和与 v19 的单一数字**逐位相同**。
     ⚠️ `sym` 这一层是必须的：`s.i` 是全币种共用的小时序号，不按币隔离的话
        「你在 BTC 买的这一笔」会在 ETH / XRP / DOGE / SOL 的同一根柱子上一起冒出来。 */
  bindPlayerVolSource((sym, i) => {
    const bySym = s.pvol && s.pvol[sym];
    const cell = bySym && bySym[i];
    if (!cell) return null;
    let margin = 0, fut = 0;
    for (const id in cell) {
      const byKind = cell[id];
      if (byKind.margin) margin += byKind.margin.u;
      if (byKind.fut) fut += byKind.fut.u;
    }
    return (margin || fut) ? { margin, fut } : null;
  });

  refs = mount(root);
  hideBoot();
  /* 桌面自适应的第一笔（用户 2026-10-01 拍板）：必须在**首次 `draw()` 之前**落，
     否则第一帧量到的是默认 `--ui: 1` 的尺寸。 */
  applyUi();

  // 数据到位后把杠杆夹到当前年份允许的范围内（读档时年份可能已经变了）
  normalizeLeverage(s);
  /* 资金曲线（v13 · 方案 §4）的**第 0 天**：采样写在小时间隔里（`advanceOneHour`），
     不先在开盘这一刻补一个点，玩家头 24 个游戏小时打开资产页会看到一张空图。 */
  sampleEquity(s);

  /* 新闻窗口内**强制一帧**（P2-C）：一次 `step()` 在 50x 下最多能推进 50 个游戏小时，
     而渲染被节流到 80ms —— 不强制就会「窗口整个落在两帧之间」，玩家一次都看不到。
     新闻是 `s.i` 的纯函数，所以这里只做一件事：窗口里别让节流把这一帧吞掉。 */
  clock = createClock(s, { onFrame: () => { dirty = true; preloadUpcoming(); draw(!!anchorAt(s.i)); } });
  draw();
  /* 全量预热（2026-10-05）：首帧已出，后台把剩下的币种行情拉完 —— 切币不再等网络。 */
  prefetchAllCoins();

  /* ⚠️ `bindActions` 已提前到本函数开头（见那里的注释）—— 这里不再挂第二遍，
     否则同一个 `pointerdown` 会被派发两次（下单 / 平仓这类动作会真的做两笔）。 */
  /* K 线手势（Batch 3 · B13/B14）：三个回调都只动**视野**（`view.js`），
     不碰 `s`、不写存档，唯一副作用是把重画排到下一帧（`queueDraw` 合并，拖动不能被 80ms 节流吞掉）。
     复位只在**当前币**上生效；每帧的限位（`chart.js` 里夹）会把越界的视野拉回来。
     ⚠️ 拖动（pan / zoom）本身刻意**不出声** —— 手指划一下就响，比没声音还吵；
        只有**撞到边界那一下**才给反馈（`edgeFeedback`：一记轻震 ＋ 画布回弹，见下）。 */
  bindChart(refs.canvas, {
    pan: (dx, dy) => { edgeFeedback(refs.canvas, panBy(s.sym, dx, dy, s.i, chartW()).edge); queueDraw(); },
    zoom: f => { edgeFeedback(refs.canvas, zoomBy(s.sym, f, s.i, chartW()).edge); queueDraw(); },
    reset: () => { snd.tap(); resetView(s.sym); queueDraw(); },
  });
  /* 回顾页那块 K 线的同一套手势（方案 §3.2「复用 `simulate.js` / `view.js`」）——
     唯一区别是它推的是 `rv.i` 而不是 `s.i`（回顾的「当前」在 `rv` 里）。 */
  bindChart(refs.rvCanvas, {
    pan: (dx, dy) => { if (!rv) return; edgeFeedback(refs.rvCanvas, panBy(rv.sym, dx, dy, rv.i, chartW(), RV_NS).edge); queueDraw(); },
    zoom: f => { if (!rv) return; edgeFeedback(refs.rvCanvas, zoomBy(rv.sym, f, rv.i, chartW(), RV_NS).edge); queueDraw(); },
    reset: () => { if (!rv) return; snd.tap(); resetView(rv.sym, RV_NS); queueDraw(); },
  });
  /* 存档：玩家每次动作走 `after()` 即时落盘；这个定时器只给「时间自己走」兜底 ——
     `dirty` 由 `onFrame`（推进过才回调）置真，没动过就跳过这次全量序列化与写盘。 */
  setInterval(() => { if (dirty) { save(s); dirty = false; } }, 10000);
  window.addEventListener('beforeunload', () => save(s));
  /* 桌面自适应的第二笔：窗口被拖动/旋屏/分屏时重算 `--ui`（内部自带去重，
     数值没变就什么都不做，所以这个监听不会让 resize 变成重绘风暴）。 */
  window.addEventListener('resize', applyUi);

  /* 主菜单（需求 4 · 方案 §2）：**一律先弹它**，五枚入口决定后续走向 ——
       读取存档 → 弹一层，列出有档的槽（名称 / 日期 / 金额），点了续玩
       开始游戏 → 开一局新的经典全程（已有普通档先二次确认）
       挑战模式 → 弹一层，列出五张年代卡
       历史回顾 / 交易档案 / 安装应用 → 各走各的
     ⚠️ 菜单期间**时钟不启动**（与开场叙事同一条）：玩家选完才真正开盘，
        否则停在这一屏时行情已经自己走了几十根。
     ⚠️ **刚挑完年代的那一趟跳过菜单**（`fromScenarioPick`）：玩家上一步才点的「10U 战神」，
        再把菜单弹回来等于让他白点一次。⚠️ **挑战局不走开场白**（2026-10-01 用户拍板：
        挑战默认老手、没有新手/老手按钮）—— 直接开盘。
     ⚠️ 菜单**只吃一个布尔**（`canLoad`，2026-10-02）：两段摊开的列表已收进弹窗，
        菜单不再需要那份槽位清单 —— 真正的清单在**点「读取存档」那一刻**才现算。 */
  if (fromScenarioPick) {
    if (isChallenge(s.scen)) beginGame();
    else openIntro(s.scen);
  } else if (fromSlotPick) {
    /* 跨槽读档：**跳过菜单直接续玩**加载进来的那一局 —— 走法与 `onSlot` 的同槽分支一字不差
       （落回交易页 ＋ 恢复运行），只是这里没有「待决态」以外的状态要碰。
       ⚠️ 不补开局日志：那是「新开一局」才有的东西，续玩补一条会与存档里的时间线打架。
       ⚠️ 待决 / 已结束的档**保持暂停**：恢复交给遮罩上那两枚按钮（与 `onSlot` 同一条）。 */
    tab = 'trade';
    if (!s.over && !s.pending) {
      s.paused = false;
      s.speed = 1;
      clock.start();
    }
    after();
  } else openMenu({ canLoad: menuSlots().length > 0 });
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

/**
 * 新币行情**提前预载**（2026-10-01 用户拍板）。
 *
 * 币种解锁是 `s.i` 的纯函数（见 `engine.advanceOneHour`），但行情是**懒加载**的
 * （`market.loadCoin` 只在「当前币 / 持仓币 / 玩家手动切过去」时才下载）。两件事一错开，
 * 就会出现「Tab 已经亮了、点进去 K 线却是空白」—— 要等一次网络往返才出图。
 *
 * 这里在**距解锁还有 / 刚过去 `PRELOAD_HOURS` 游戏小时**时就把数据拉下来（`ensureCoin` 自带
 * 「已加载就跳过」与并发去重，重复调用无害）。首屏仍只下当前币 —— 只有走到临界点才动手。
 *
 * ⚠️ **窗口是前后对称的**（2026-10-02 审计修）：原来只认 `at > s.i`（还没解锁），于是一个
 *    「读档正好落在某币上线之后几百小时」的档，那个币的 Tab 已经能点、包却一个字节都没下
 *    —— 进去是一张空白图。往前那 30 游戏日补的正是这一段。
 */
const PRELOAD_HOURS = 720;                 // 30 游戏日：1x 下提前 30 小时，50x 下约 14 秒

function preloadUpcoming() {
  for (const c of COINS) {
    const at = Math.round((c.unlock - GAME.start) / HOUR_MS);
    if (Math.abs(at - s.i) <= PRELOAD_HOURS && !isLoaded(c.sym)) ensureCoin(c.sym);
  }
}

/**
 * **全量预热**（2026-10-05 用户拍板「其他币种的 K 线图应该提前加载」）——首帧画完之后，
 * 在**后台**把剩余币种的行情包全下下来，之后切币零等待。
 *
 * ⚠️ 放在**首帧之后**、且走 `requestIdleCallback`（不支持则退回 `setTimeout`）：整包 ~4.4MB，
 *    绝不能挡住第一屏；玩家的当前币已经由 `ensureCoin(s.sym)` 在首帧前保证到位。
 * ⚠️ 与 `preloadUpcoming` **不冲突**（`ensureCoin` 自带「已加载即跳过」与并发去重）：
 *    后者是「快解锁了才提前拉」的精准窗，这里是「反正就 4MB，一次拉完」的兜底。
 * ⚠️ PWA 侧另有 SW 安装时的整包预缓存（`sw.js` 的 `precacheData`）—— 两条路互为补充：
 *    SW 管**离线可用**，这里管**本次会话切币丝滑**。
 */
function prefetchAllCoins() {
  const go = () => { for (const c of COINS) if (!isLoaded(c.sym)) ensureCoin(c.sym); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 3000 });
  else setTimeout(go, 0);
}

/* ───────────────────────────── 每帧 ───────────────────────────── */

/* K 线区宽度的缓存（2026-10-04 手势性能修）：`draw()` 每帧本来就要量一次并写进 `view.chartW`，
   这里把它留下来给手势复用。原因：`panBy` / `zoomBy` 的每次 `pointermove` 都要这个宽度，
   逐次调 `getBoundingClientRect()` 会**强制一次同步布局**，与上一帧的 DOM 写入交替
   ⇒ 布局抖动（layout thrash），正是手机上拖动卡顿的主因之一。
   缓存只在**量到真实可见宽度**时刷新（见 `draw()`），旋屏 / 切页都各有一帧 `draw(true)`，不会长期陈旧。 */
let chartWCache = 0;      // 交易页那块 K 线区
let rvChartWCache = 0;    // 回顾页那块 K 线区
/* 高度缓存（2026-10-04）：手势快路（`draw(force, true)`）**不量 `getBoundingClientRect`**，
   尺寸只能取上一次量到的值 —— 见 `draw()` 里那段「手势快路」。 */
let chartHCache = 0;
let rvChartHCache = 0;

/** K 线区的 CSS 宽度。手势换算「一像素 = 多少根」要用**同一份**，所以单独留一个入口。
 *  ⚠️ 回顾页有自己那一块 K 线区（`rvWrap`）—— 两者可见性互斥，量哪个由 `rv` 决定。 */
const chartW = () => {
  const cached = rv ? rvChartWCache : chartWCache;
  if (cached > 0) return cached;
  const node = rv ? refs.rvWrap : refs.chartWrap;
  return Math.max(1, Math.round(node.getBoundingClientRect().width));
};

/* K 线触边回弹（2026-10-04 用户拍板「边界震动 ＋ 视觉回弹」）：
   拖到数据尽头 / 缩到极限那一下给一记轻触觉，并让画布朝受限方向轻轻顶一下再弹回 ——
   手感上的「到底了」。`view.js` 的 `panBy` / `zoomBy` 返回的 `edge`（'' / 'new' / 'old' / 'in' / 'out'）
   就是这个信号。两条纪律：
     ① **只有撞边界那一下**才有反馈 —— pan / zoom 过程本身仍不出声（沿用「划一下就响太吵」的旧判据）；
     ② **节流 280ms**：手指贴着边界继续划时，每次 `pointermove` 都会报 edge，不能每帧都震、都重播动画。
   离开边界（edge 为空）时把节流计时归零 ⇒ 松手再撞一次还能响。 */
const EDGE_GAP = 280;
const edgeAt = new WeakMap();

/** 画布回弹动画：拖动 → 朝拖动方向平移几像素（`--bump-x`）；缩放 → 轻微缩一下。 */
function bumpChart(canvas, edge) {
  const cls = edge === 'in' || edge === 'out' ? 'bump-z' : 'bump-x';
  if (cls === 'bump-x') canvas.style.setProperty('--bump-x', edge === 'old' ? '6px' : '-6px');
  /* 先摘 class 并强制一次重排 —— 否则贴着边界连撞时，浏览器认为 class 没变、不重播动画。 */
  canvas.classList.remove(cls);
  void canvas.offsetWidth;
  canvas.classList.add(cls);
  canvas.addEventListener('animationend', () => canvas.classList.remove(cls), { once: true });
}

/** 把一次手势的 `edge` 变成反馈（触觉 ＋ 视觉）。`canvas` 作节流键 —— 交易页与回顾页各一块画布。 */
function edgeFeedback(canvas, edge) {
  if (!edge) { edgeAt.set(canvas, 0); return; }
  const now = performance.now();
  if (now - (edgeAt.get(canvas) || 0) < EDGE_GAP) return;
  edgeAt.set(canvas, now);
  snd.buzz('light');
  bumpChart(canvas, edge);
}

/* K 线首帧画入（2026-10-05 用户拍板「仅首次进页」）：整个会话只播一次 —— 首次进交易页时给画布
   挂 `.chart-in`，CSS 用 `clip-path` 从左往右把 K 线擦出来（一次性，与 `.bump-*` 同族：不挂基类
   `transition`，动画自己弹回）。`chartIntroDone` 在**首次尝试时就置真**（不论档位），所以它绝不会
   在之后的切页 / 旋屏里重播；`fx < 2` 时连类都不挂（`.fx-off` 的 0.01ms 规则也会兜住）。 */
let chartIntroDone = false;
function playChartIntro(canvas) {
  if (!canvas) return;
  canvas.classList.add('chart-in');
  canvas.addEventListener('animationend', () => canvas.classList.remove('chart-in'), { once: true });
}

/**
 * 渲染节流到 ~12fps。K 线一秒钟最多走 50 根（50x），12fps 足够把每一根都画出来，
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
 *    K 线、杠杆档全空）。注意 `bindActions` 在 `boot()` 开头就挂好了（2026-10-02 审计起），
 *    所以此时点击反而正常 —— 按钮一点就走 `after()` 强制补上第一帧，掩盖了「开局一片空白」这个现象。
 */
let lastDraw = -Infinity;
/* ⚠️ 起手取 `!!s.over`：读档读到一个**已经结束**的档时，不该在开屏第一帧补响一声爆仓 / 结算。 */
let overDrawn = !!s.over;
/* **待决遮罩**（借贷 `'loan'` / 破产预警 `'warn'`）画过没 —— 与 `overDrawn` 同一个理由：置真
   `s.paused` 的那一拍之后不会再有 `onFrame`，那一帧若被 80ms 节流吞掉，遮罩就永远出不来。
   ⚠️ 变量按**真值**记（两种遮罩共用），具体画哪一个仍按 `s.pending` 的**值**分派。 */
let pendingDrawn = !!s.pending;

/* **手势重绘合并 ＋ 只重画 K 线**（2026-10-04 性能修，两刀一起下）
 *
 * 病根有两层，原先只治了第一层：
 *   ① 频率：pan / zoom 的**每个** `pointermove` 都直接 `draw(true)`。手机触控采样可达 120Hz，
 *      一次拖动 = 每秒上百次重绘。改用 `requestAnimationFrame` 合并 ⇒ 一帧最多一次。
 *   ② **单帧成本**：`draw(true)` 会跑**整屏** `update()`（几百处 DOM 遍历）**外加强制一次
 *      `getBoundingClientRect`**（同步布局）。合并之后仍有 60 帧/秒 × 这份成本 —— 手机上单帧
 *      压不进 16ms，于是「缩放 / 拖动」照样掉帧（用户 2026-10-04 复现并纠正了上一版判断）。
 *
 * 所以手势帧改走 `draw(true, true)` = **只重画 K 线**：页面上除 K 线之外没有任何东西会因手势而变
 * （视野只活在 `view.js` 里），整屏 `update()` 是纯粹白跑的。整屏那一帧交给 `scheduleFullDraw()`
 * 在**手势停下来 180ms 后**补一次（兜底：万一有哪一格浮字被快路漏掉，松手后立刻归位）。
 * 时钟在走时 `onFrame` 本来就会按 80ms 节流跑整屏帧，界面不会因为快路而长期陈旧。
 *
 * 视野状态仍由 `view.js` 在每个事件里**同步**累积 ⇒ 合并既不丢位移、也不丢手感。 */
let drawQueued = false;
let fullDrawTimer = 0;
function queueDraw() {
  /* 兜底整屏帧：每次手势事件都往后推 180ms，只有真正停下来才会跑到 */
  clearTimeout(fullDrawTimer);
  fullDrawTimer = setTimeout(() => { fullDrawTimer = 0; draw(true); }, 180);
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(true, true); });
}

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

/* 行情音的两条阈值参数（T-1 · §2.2 ②）—— 都按**波动率归一化**，否则 2013 的 BTC
   （日波动 5–8%）会疯狂触发、2023（~2%）几乎不触发。`k` 是**起点值**，
   按 §5 的实测触发频率回调（目标：1x ≤ 每分钟 1 声、50x ≤ 每 2 秒 1 声）。 */
const K_SIGMA = 3;      // 收盘涨跌幅：θ = k × σ_30日 / √24（约 P95 量级）
const K_AMP = 6;        // 长插针振幅：θ₂ = k₂ × σ_30日 / √24（约 3 倍常态小时振幅）
/** 上一根判定过的 K 线序号 —— 只判**当前那一根**，不补算被跳过的小时 */
let lastMarketI = null;

/**
 * 事件音：按日志头一条的**文案**认（§2.3）—— 每一类都已经写进日志了，零结构改动。
 *
 * ⚠️ 判据的坑（§2.3 点名的那个）：`text.includes('归零')` 会**同时命中「账户归零 ｜ 可领 …」**
 *    （`engine.js` 破产待决），那是玩家破产、不是交易所灾难。所以必须匹配 `${ex.name} 归零`
 *    这个形态（**前面有一个空格**）—— 交易所塌方的日志正是这么写的。
 * ⚠️ 「上线」用的是 `'上线 ｜'`（带上分隔符）—— 裸「上线」会命中「XRP 还没上线」那条失败日志。
 *
 * **资金费 / 借贷利息不再出声**（T-1 删除项）：它每 8 小时结算一次，50x 下一局上千次，
 * 而玩家的决策早就在下单时做完了 —— 结算照旧写日志，只是沉默。
 *
 * T-2（2026-10-01）：每条事件音**并挂一次震动** —— 手机揣在兜里时声音听不见，
 * 震动才是「出事了」的那条通道。分级与音色一致：塌方 / 警报走 `heavy`，其余走 `light`。
 */
function eventSound(last) {
  const text = last.text;
  /* **爆仓潮**（NPC 强平级联）—— 排在**最前**：本作最剧烈的市场事件（十余年个位数次），
     用一串随机下坠的潮音（L3）而不是一声 tick；重力感交 `heavy` 震动。 */
  if (text.includes('爆仓潮')) { snd.liqWave(); return snd.buzz('heavy'); }
  if (text.includes('推高拥堵')) { snd.pulse(); return snd.buzz('light'); }
  if (last.kind === 'news') { snd.news(); return snd.buzz('light'); }
  if (text.includes('被盗削减') || / 归零/.test(text)) { snd.crash(); return snd.buzz('heavy'); }
  if (text.includes('上线 ｜') || text.includes('恢复交易') || text.startsWith('到账')) { snd.notice(); return snd.buzz('light'); }
  if (text.includes('停机维护')) { snd.warn(); return snd.buzz('heavy'); }
}

/**
 * 行情音（L1–L5 · 2026-10-04 重做）—— **不入日志**，直接读 K 线，每帧一次。
 * 为什么不能写日志：50x 下一局会灌出几万条，把日志条和浮层一起冲垮。
 *
 * **一帧最多一声**：先把这一帧跨过的每一根、每一个币各自算出一个 0..1 的强度，
 * 再挑「最强的那一下」交给 `sound.js`（那里按 方向 × 强度 合成音簇，见 `marketMove`）。
 * 这样 50x 下不会把几十根一起炸成机关枪 —— 听到的永远是这一帧里最值得听的那一根。
 *
 * ⚠️ 只倒着扫**最近 240 根**：标签页被挂起再切回来时 `s.i` 可能一次跳几百根，
 *    逐根补算会瞬间炸出一串音（与旧版同一条纪律），240 根已覆盖任何一帧的真实推进。
 * ⚠️ **取不到价就跳过**：`candleAt` / `closeAt` 在该币**首根真小时线之前**返回 `null`
 *    （只有 BTC 有 2012 回溯段）。拿不齐「当根 ＋ 前一根」就直接跳过 ——
 *    不许用兜底价算涨跌幅，那会凭空造出一个行情音。
 * ⚠️ 发声范围 = **当前币 ＋ 持仓币**（三道闸的第 ③ 条）。
 */
function marketSounds(s) {
  if (lastMarketI === null) { lastMarketI = s.i; return; }   // 首帧只记锚点
  if (s.i === lastMarketI || s.i <= 0) return;
  const from = lastMarketI + 1;
  const to = s.i;
  lastMarketI = s.i;

  const lo = Math.max(from, to - 239, 1);
  let best = null;                 // { inten, dir, hot, spike }
  for (const sym of new Set([s.sym, ...heldSyms(s)])) {
    const sigma = dailySigma(sym, to);
    if (!(sigma > 0)) continue;
    const unit = sigma / Math.sqrt(24);
    for (let k = lo; k <= to; k++) {
      const cur = candleAt(sym, k);
      const prev = closeAt(sym, k - 1);
      if (!cur || !(prev > 0) || !(cur.c > 0)) continue;
      /* L1 强度：位移对**该币自己的**常态小时波动归一化，再并上量能份额 —— 同一个 0..1 刻度。
         `K_SIGMA` 是「显著」的起点，取它的 2.5 倍当满格：常态波动不发声，异动才响
         （否则 2013 的 BTC 日波动 5~8%，会每根都响）。量能那一项沿用旧阈值 3/24 当满格。 */
      const moveI = Math.min(1, Math.abs(cur.c / prev - 1) / (K_SIGMA * unit * 2.5));
      const volI = Math.min(1, volumeAt(sym, k) / (3 / 24));
      const inten = Math.max(moveI, volI * 0.9);
      if (inten < 0.15) continue;
      if (!best || inten > best.inten) {
        best = {
          inten,
          dir: cur.c >= prev ? 1 : -1,
          hot: volI >= 1,
          spike: (cur.h - cur.l) / cur.c >= K_AMP * unit,
        };
      }
    }
  }
  if (!best) return;
  /* ① **插针优先**（§2.2）：一根大阴线既跌又插针，不该叠两声 ——
     插针更紧急，因为强平看的是**最低价**（`l`），不是收盘价。 */
  if (best.spike) { snd.spike(best.inten); return; }
  /* ② 上行不再特殊处理（2026-10-04 用户拍板删 `openWave`）：那一侧与下跌走**同一个**
     `marketMove`（一记短促打击，音高 / 响度 / 亮度随强度）—— 见 `sound.js` 的 L3 注释。 */
  snd.marketMove(best.dir, best.inten, best.hot);
}

function soundFromTick(s) {
  const last = s.log[0];
  if (last) {
    const key = `${last.at}|${last.text}`;
    if (lastLogKey === null) lastLogKey = key;      // 首帧只记锚点，不补响历史事件
    else if (key !== lastLogKey) {
      lastLogKey = key;
      eventSound(last);
    }
  }

  /* 安全垫跌破 **0.2（红区）**：**进入**那一刻响一次，回到注意区之上后重置（不然每帧都在响）。
     与持仓条第三格**同一个判据**（本轮 ⑥ 起两边都走 `safetyOf`，不再各写一个阈值）——
     原来是拿保证金率绝对值卡 `< 5%`，那会让 100x 仓位一开出来就响（它开出来就只有 1%）。
     ⚠️ 不可强平的仓位（1x 多头，无借入）没有维持保证金率这一说，跳过 —— 判据统一走 `canLiquidate`
        （v9 · §15.4：`isMargin` 已经不回答这个问题；2026-10-03 起判据 = 有没有借入，
        所以 1x 空头也算可强平）。 */
  for (const sym of heldSyms(s)) {
    const pos = s.positions[sym];
    if (!canLiquidate(pos)) { warnedSyms.delete(sym); continue; }
    const mark = exMarkPrice(s, sym, pos.ex);   // 三价：预警阈值按**本仓所在所**的标记价（与保证金率同源）
    const safe = mark == null ? 1 : safetyOf(pos, mark);
    if (safe <= 0.2) {
      if (!warnedSyms.has(sym)) { warnedSyms.add(sym); snd.warn(); snd.buzz('heavy'); }
    } else {
      warnedSyms.delete(sym);
    }
  }

  marketSounds(s);
}

/**
 * 组装一帧要交给渲染层的界面状态（`update()` / `renderReview()` / `redrawChart()` 共用）。
 * `cssW` / `cssH` = K 线区的 CSS 尺寸（全量帧实测，手势快路取缓存）。
 */
function buildView(cssW, cssH) {
  return {
    chartW: cssW,
    chartH: cssH,
    /* 当前页：K 线只在交易页画（另两页没有 K 线） */
    tab,
    /* 资产页资金曲线的区间（`0` = 全部）—— 纯界面状态，与 `redUp` 同一类 */
    eqRange,
    /* 音频 / 震动 / 动效偏好归各自那份浏览器存档管，不进主状态 ——
       设置页那些档位的高亮由渲染层每帧从这里取。 */
    vol: snd.getVol(),
    marketSound: snd.isMarketOn(),
    vib: snd.getVib(),
    fx,
    /* 涨跌色偏好（B5）：同上，归那个独立 localStorage 键管 */
    redUp,
    /* 新手分步引导正在走（本轮 ①/F）—— 引导期间 `s.paused` 恒为真，但**界面不该装成「暂停」**：
       它正高亮着「买入」按钮教玩家怎么用，把那一枚画成禁用灰会自相矛盾 ⇒ 渲染层靠这个豁免。
       （与 `tab` 同一类：纯界面状态，不进 `s`。） */
    guide: guideStep != null,
  };
}

function draw(force = false, chartOnly = false) {
  /* 回顾态没有「结束 / 待决遮罩」这回事（回顾不判破产、也没有账户）⇒ 那两个强制帧的判据只在正常玩法下算 */
  if (!rv && !chartOnly && ((s.over && !overDrawn) || (s.pending && !pendingDrawn))) force = true;
  const now = performance.now();
  if (!force && now - lastDraw < 80) return;
  lastDraw = now;

  if (!refs) return;
  /* ── 手势快路（2026-10-04）：**只重画 K 线** ─────────────────────────────
     拖动 / 捏合只改 `view.js` 里的视野，页面结构一个字都不变 ⇒ 不切页、**不量尺寸**、
     不跑整屏 `update()`。不量尺寸是关键：`getBoundingClientRect` 会**强制一次同步布局**，
     与上一帧的 DOM 写入交替就是布局抖动（layout thrash）—— 手机上掉帧的主因。
     ⚠️ 尺寸只能取缓存；**一次都没量到过**（首帧即手势 / 切页后第一帧被合并吞掉）就退回全量帧，
        否则会按 1×1 的畸形尺寸画出一张空图。
     ⚠️ 快路只动 K 线区（画布 ＋ 它那几枚浮字）—— 这就是「手势期间会变的东西」的全部；
        其余界面由 `scheduleFullDraw()` / 时钟 `onFrame` 的整屏帧负责。 */
  if (chartOnly) {
    const cssW = rv ? rvChartWCache : chartWCache;
    const cssH = rv ? rvChartHCache : chartHCache;
    if (!(cssW > 1) || !(cssH > 1)) { draw(true); return; }
    try {
      redrawChart(refs, s, rv, buildView(cssW, cssH));
    } catch (err) {
      renderBoot('渲染失败', err);
    }
    return;
  }
  /* ⚠️ **先切页，再量尺寸**（A6 · 方案 §6）：隐藏的 `.trade-page` 是 `display:none`，
     量出来是 0×0；顺序反了的话第一帧拿到的是上一页的尺寸（切回交易页就会画成一张空图，
     而且暂停态下**不会再有任何一帧**把它救回来）。 */
  showPage(refs, rv ? 'review' : arch ? 'careers' : tab);
  /* K 线首帧画入：整个会话只尝试一次（见 `playChartIntro`）。 */
  if (!rv && !arch && tab === 'trade' && !chartIntroDone) {
    chartIntroDone = true;
    if (fx === 2) playChartIntro(refs.canvas);
  }
  /* 档案页是**纯只读**的一屏（没有 K 线、不量尺寸）⇒ 铺完列表就地返回。
     ⚠️ 铺列表放在 `showPage` 之后：`.careers-list` 所在的那页此刻才刚被点亮。
     ⚠️ **进来先 `clearOver`**（2026-10-02 修）：与下面 `rv` 分支同一条 —— 本局已结束时也能
        从结算遮罩「回主菜单」再进档案页，那时 `#app` 里还挂着那张 `position:fixed` 的 `.over`；
        这一支**在 `try` 之前就 return 了**，落不到最后那个 `else` 的 `clearOver` 上 ——
        原来那句 `if (s.over && !arch)` 里的 `!arch` 因此管不到这里（是一处死守卫）。 */
  if (arch) { clearOver(root); renderCareers(refs, loadCareers()); return; }
  /* 回顾页量的是它自己那块 K 线区（两页的 DOM 各有一套，方案 §3.2） */
  const rect = (rv ? refs.rvWrap : refs.chartWrap).getBoundingClientRect();
  const view = buildView(
    Math.max(1, Math.round(rect.width)),
    Math.max(1, Math.round(rect.height - 2)),
  );
  /* 刷新宽 / 高缓存（手势快路复用，见 `chartW` 与 `draw(force, chartOnly)`）：
     只在**真的量到可见尺寸**时写 —— 隐藏页量出来是 0 / 1px，写进去会把后续手势的
     「一像素 = 多少根」钉死成畸形值（高度则会让快路照畸形尺寸画出一张空图）。 */
  if (rect.width > 1 && rect.height > 1) {
    if (rv) { rvChartWCache = view.chartW; rvChartHCache = view.chartH; }
    else { chartWCache = view.chartW; chartHCache = view.chartH; }
  }

  try {
    /* 回顾态走**另一条渲染线**：它只读 `rv`（模块级），一个字都不写 `s`，也绝不碰那几张遮罩。
       ⚠️ 进来先 `clearOver`（2026-10-02 审计修）：本局已结束时也能从结算遮罩「回主菜单」再进回顾，
          那时 `#app` 里还挂着那张 `.over` —— 它是 `position:fixed`，不摘掉会直接盖住整页回顾。 */
    if (rv) { clearOver(root); renderReview(refs, rv, view); return; }
    update(refs, s, view);
    /* ⚠️ 这里**不再需要** `&& !arch`（2026-10-02 修）：档案页在上面就 `return` 了，
       走不到这一行 —— 该防的那件事改成在它自己那一支里 `clearOver`（见上）。
       原来那句 `!arch` 是一处**永远为真**的死守卫，只会让人以为档案页的覆盖问题已解决。 */
    if (s.over) {
      closePicker();
      renderOver(root, s);
      // 结束音只响一次（`overDrawn` 是「这一局结束的画面画过了没」）；震动与它同拍
      if (!overDrawn) {
        const settled = s.over.reason === 'settled';
        (settled ? snd.settle : snd.liq)();
        snd.buzz(settled ? 'light' : 'heavy');
      }
    } else if (s.pending === 'loan') {
      /* 归零待决（B30）：遮罩替掉正常界面，时钟已停。
         不给它配音效 —— 「账户归零」那条日志已经响过 warn 了（`soundFromTick`）。 */
      closePicker();
      renderLoan(root, s);
    } else if (s.pending === 'warn') {
      /* 破产预警（v11 · ③）：同上，遮罩替掉界面、时钟已停。也不配音效（它不写日志，
         而「打断」这件事由暂停本身完成，够显眼了）。 */
      closePicker();
      renderWarn(root, s);
    } else {
      clearOver(root);
      soundFromTick(s);
    }
    overDrawn = !!s.over;
    pendingDrawn = !!s.pending;
  } catch (err) {
    renderBoot('渲染失败', err);
  }
}

/* ───────────────────────────── 点击派发 ───────────────────────────── */

function dispatch(node) {
  const d = node.dataset;

  /* 通用反馈（Batch 4 · B20；2026-10-03 分区）—— 除了**成交 / 重开**这两类有专属反馈的动作，
     其余键都响一声 ＋ 震一下：**一次点击最多响一次、震一次**，任何时刻都不会叠。
     ⚠️ 2026-10-03 起**触感也挂在这里** —— 原来震动只在 7 处事件上触发，而玩家日常的
        「切页 / 切币 / 点档位 / 换所」全都走的是这一行，摸不到任何反馈，手机的震动像坏了一样
        （用户 Android 实机反馈）。这是那件事的首要修法，见 `sound.js` 震动段注释。
     ⚠️ 音色按动作分档（切页 `tab` / 选中类 `pick` / 其余 `tap`）；震动同理（`pick` 比 `light` 略重）。
        `buzz()` 内部有去抖与等级让路，同一次点击的声与震不会互相打断。 */
  if (d.act !== 'long' && d.act !== 'short' && d.act !== 'close'
    && d.buy === undefined && d.sell === undefined && d.reset === undefined
    && d.intro === undefined
    /* `exok`（换所二次确认的「确认」）**自带**成功 / 失败分档音（`pick` / `deny`，见下），
       不必再叠一层通用点按声 —— 否则一次点击会响两声。 */
    && d.exok === undefined) {   // 开场两枚键已有专属的起手音（`snd.begin`），不叠轻点声
    if (d.tab !== undefined) { snd.tab(); snd.buzz('pick'); }
    else if (d.sym !== undefined || d.lev !== undefined || d.mode2 !== undefined
      || d.mode !== undefined || d.chan !== undefined || d.ex !== undefined) { snd.pick(); snd.buzz('pick'); }
    else { snd.tap(); snd.buzz('light'); }
  }

  /* ── 暂停闸门（本轮 ① · 操作逻辑审计）──────────────────────────────────
     **暂停时必须被拦住的只有「会动钱」的动作**：下单（`buy`/`sell`/`long`/`short`）、
     平仓（`close`）、换所（`ex` 弹层 ＋ `exok` 二次确认）、盘口 ⇄ OTC 切换（`chan`）。
     其余一律**照常可用**（用户 2026-09-29 拍板）：杠杆档 / 金额档 / 杠杆合约 / 切币 /
     粒度 / 切页 / 日志浮层 / 设置页（音量·行情音·震动·动效·新手提示·重开）/ 上帝面板 / 暂停键本身。
     理由：那些只改「下一单的参数」，此时既没有行情在走、也没有一笔单会成交 ——
     拦它们只会让玩家以为界面坏了。
     2026-10-04 补 · 用户拍板：**买 U（`buyu`）从这张拦截表里移出**。它是**纯换汇** ——
     `engine.buyUsdt` 只把当前所的美元按 `usdtPriceAt(now)` 换成 USDT，**不写 `s.lockI`、
     不产生任何市场冲击**（价格是时间的纯函数，玩家换多少次都套不出价差）⇒ 暂停与下单一小时锁
     对它都没有防作弊意义，拦下来只会让资产页那排键在暂停时无故变灰。

     ⚠️ **下面这个 `if` 只兜两个「没有 disabled 按钮可挡」的入口**（`exok` / `chan`，
        外加 `ex` 弹层本身）。`buy`/`sell`/`long`/`short`/`close` 这五枚是**真按钮**，
        暂停时已由渲染层的 `frozen`（`s.paused && !view.guide`）**真禁用**，
        点都点不出来 ⇒ 这里再拦一遍纯属重复。
     ⚠️ **也正因如此不能把它们塞进这个 `if`**（P1-18 · 2026-10-04 审计）：引导期间
        `s.paused` 恒为真，而**第 6 步**正高亮「买入」教玩家下单 —— 渲染层用 `view.guide` 开了豁免，
        这里若一刀切按 `s.paused` 拦，就会把引导的那一下也拦死。两层的口径必须一致。
     ⚠️ **不能**写成 dispatch 顶部的 `if (s.paused) return`：`onTab` 是「切页即暂停」，
        一刀切会把设置页的音效 / 订单冲击 / 重开、以及三页常驻的暂停键一起冻死。
     ⚠️ 回顾态走自己的 `rv.paused`，且那一屏不碰账户 ⇒ 这里只在正常玩法下生效（`!rv`）。
     ⚠️ 给一条日志而不是静默吞掉：玩家按了键没反应时，「为什么」比「没反应」重要。 */
  if (!rv && s.paused && (d.ex !== undefined || d.exok !== undefined
    || d.chan !== undefined)) {
    pushLog(s, '已暂停 ｜ 先点顶栏「继续」再进行交易', 'info');
    after();
    return;
  }

  /* **下单一小时锁**（§73.8 · 2026-10-02 用户拍板）：暂停允许下单，但一笔成交后 `s.lockI = s.i`，
     必须点「继续」走满 1 游戏小时（`s.i > s.lockI`）才能再动钱 —— 封堵
     「疯狂点 继续/暂停 把同一根 K 线的行情切成多笔成交」。判据 `pauseLocked` 与渲染层置灰同源。
     ⚠️ 与上面那条分开：上面那条讲「已暂停，先继续」，这条讲「刚成交过，等一小时」。
     ⚠️ **买 U 不进这条**（2026-10-04）：它不写 `s.lockI`、无市场冲击，不存在「切碎同一根 K 线」的问题。 */
  if (!rv && pauseLocked(s) && (d.buy !== undefined || d.sell !== undefined
    || d.act === 'long' || d.act === 'short' || d.act === 'close'
    || d.ex !== undefined || d.exok !== undefined || d.chan !== undefined)) {
    pushLog(s, '刚成交 ｜ 走满 1 小时后再交易', 'info');
    after();
    return;
  }

  /* 新手分步引导的「下一步」（本轮 ④）：只在引导期间存在，值固定 `'next'`。
     ⚠️ 它**不能**被上面那条暂停闸门拦下 —— 引导期间 `s.paused` 恒为真，而它正是走完引导的唯一出口。 */
  if (d.guide !== undefined) return nextGuide();

  /* 「行情还在路上」（2026-10-02 审计修 · 用户拍板）：切币后数据包要一次网络往返才到货，
     这期间 `markPrice` 是 `null`、下单 / 平仓都算不出价。渲染层因此把这几枚画成 `.off`
     （**可点**）而不是 `disabled` —— 这一行就是那一份「为什么」。
     ⚠️ 不与上面的暂停闸门合并：那条讲的是「时间停了」，这条讲的是「这只币的数据还没到」。 */
  if (!isLoaded(s.sym) && (d.buy !== undefined || d.sell !== undefined
    || d.act === 'long' || d.act === 'short' || d.act === 'close')) {
    pushLog(s, `${s.sym} 行情加载中 ｜ 稍等片刻再下单`, 'info');
    after();
    return;
  }

  /* 逐仓「调整保证金」（2026-10-04 用户拍板 · OKX 式）：资产页持仓行那枚「调整」入口 ＋ 弹层预设键。
     ⚠️ 它**不吃暂停闸门、也不吃下单一小时锁** —— 加 / 减保证金只是账户内的资金腾挪（不改数量、
        不产生任何市场冲击、不写 `s.lockI`），拦它没有防作弊意义（与「买 U」同一口径）。 */
  if (d.mg !== undefined) return onMarginAdjust(s, d.mg);

  /* 主菜单入口（需求 4 · 方案 §2）：`load` / `start` / `scen` / `review` / `careers` / `install`。 */
  if (d.menu !== undefined) return onMenu(d.menu, node);
  /* 「读取存档」弹窗里那两行（2026-10-01 用户拍板；2026-10-02 由摊开改为弹出）：
     值是槽位键（`normal` / `challenge`）。 */
  if (d.slot !== undefined) return onSlot(d.slot);
  /* 年代开局（M1）：主菜单「挑战模式」里那五张卡，值是年代 id，见 `onScenario`。 */
  if (d.scen !== undefined) return onScenario(d.scen, node);
  /* 主菜单弹窗的「返回」（2026-10-02）：只摘掉那一层，背后那屏主菜单原样留着 ——
     ⚠️ 不能用 `closePicker()`，它清的是整个 `#overlay`（菜单也在里面）。 */
  if (d.menuback !== undefined) return closeMenuDlg();
  /* 回顾页的全部动作（需求 4 · 方案 §3）：值即子命令，见 `onReview`。 */
  if (d.review !== undefined) return onReview(d.review);
  /* 交易档案页（M2 / M5）：`exit` 返回；`poster:<id>` 生成海报摊进预览层；
     `del:<id>` 删一条（**武装式双重确认**，见 `armDelete`）；
     `psave` / `pshare` 是**预览层里**那两枚键（同挂 `careers`，不改 `bind.js` 的动作表）。 */
  if (d.careers === 'exit') return exitCareers();
  if (d.careers === 'psave') return onPosterSave(node);
  if (d.careers === 'pshare') return onPosterShare(node);
  if (typeof d.careers === 'string') {
    if (d.careers.startsWith('poster:')) return onPoster(d.careers.slice(7), node);
    if (d.careers.startsWith('del:')) return onDeleteCareer(d.careers.slice(4), node);
  }
  /* 开场的两枚入口（v11 · ③）：`d.intro` 是 `'new'`（我是新手）或 `'old'`（我是老手）——
     它只决定 `s.hintOn`，叙事文案两者一样。 */
  if (d.intro !== undefined) return onIntro(d.intro);
  if (d.loan !== undefined) return onLoan(d.loan);
  /* 破产预警遮罩（v11 · ③）：只有一枚「知道了」。它与 `loan` 是**两回事** —— 所以按值分派，
     `s.pending` 的判真值只用来「锁 UI」，绝不用来选遮罩。 */
  if (d.warn !== undefined) return onWarn();
  if (d.hint !== undefined) return onHintToggle();
  /* 日志浮层（v11 · ⑤ · 方案 §20.2.1）：点日志条**整条**打开，回看最近 30 条（含被截尾的全句）。
     ⚠️ 它是**唯一会碰时钟的浮层**：打开即**暂停 ＋ 归 1x**，关掉以 1x 续跑（用户 2026-09-29 拍板，
        理由见 `onLogOpen`）—— 选所 / 二次确认那些走 `closePicker()`，一行都不动速度。 */
  if (d.log !== undefined) return onLogOpen();
  /* A6：底部 Tab 切页（`data-tab="trade|assets|settings"`）。
     ⚠️ 原来的 `data-settings`（顶栏那枚「设置」）已随 A6 撤掉 —— 设置整体成了一个页。 */
  if (d.tab !== undefined) return onTab(d.tab);
  /* 资产页资金曲线的区间档（用户 2026-10-01 拍板）：只改一个纯 UI 变量 ＋ 重画一帧。
     ⚠️ 走 `after()` 是**沿用 `onColorToggle` 的先例**（同为纯显示偏好）—— 它顺手落一次盘，
        代价可忽略，换来的是「所有分派出口长得一样」。 */
  if (d.eqrange !== undefined) { eqRange = Number(d.eqrange); after(); return; }
  if (d.vol !== undefined) return onVol(Number(d.vol));
  if (d.market !== undefined) return onMarketToggle();
  if (d.vib !== undefined) return onVib(Number(d.vib));
  if (d.vibtest !== undefined) return onVibTest();
  if (d.fx !== undefined) return onFx(Number(d.fx));
  if (d.colors !== undefined) return onColorToggle();
  if (d.reset !== undefined) return onReset(node);
  /* 设置页「返回主菜单」（2026-10-01 用户要求）：停钟 ＋ 弹菜单，本局状态一个字不动。 */
  if (d.home !== undefined) return onHome();
  if (d.sclose !== undefined) return onClosePanel();

  /* ── 上帝模式（隐藏入口 · 方案 §2）──
     `god` 是标题上的连点入口，其余几枚在上帝面板里（`data-god*`）。
     ⚠️ 上帝模式**只有「跳日期 / 填资金 / 关掉」三件事**（2026-09-29 瘦身）：原来那两套价格能力
        （倍率 `godmult`、手动砸盘 `godscale` / 复位 `godreset`）已整体删除。
     ⚠️ 设置页那枚「订单冲击」开关已于 2026-10-01 随 `s.impactOn` 字段一起删除 —— 冲击永远是开的。 */
  if (d.god !== undefined) return onGodTap();
  if (d.godcash !== undefined || d.godyear !== undefined || d.godmon !== undefined
    || d.godday !== undefined || d.godgo !== undefined || d.godoff !== undefined
    || d.godtab !== undefined) {
    /* 这几枚只可能出现在上帝面板里，而面板只在 `s.god` 非空时打开。这一行是**状态机不靠 DOM 兜底**：
       万一面板被别的路径留下来（比如读到一份 `god: null` 的档），这里不能抛异常。 */
    if (!s.god) return;
    if (d.godtab !== undefined) return onGodTab(node);
    if (d.godcash !== undefined) return onGodCash(node);
    if (d.godyear !== undefined) return onGodPick('y', Number(d.godyear));
    if (d.godmon !== undefined) return onGodPick('m', Number(d.godmon));
    if (d.godday !== undefined) return onGodPick('d', Number(d.godday));
    if (d.godgo !== undefined) return onGodGo();
    return onGodOff();
  }
  /* ── 上帝沙盒（2026-10-05）── 与上面几枚同一处境：只出现在上帝面板里，
     同样以 `s.god` 非空兜底（状态机不靠 DOM）。 */
  if (d.sb !== undefined || d.sbpreset !== undefined || d.sbseed !== undefined || d.sbroll !== undefined) {
    if (!s.god) return;
    /* ⚠️ 旧档兜底：`s.god.sb` 只在 `enableGod` 里创建，而 `STATE_VERSION` 未随新增字段升版
       ⇒ 存在「v31、god 已开、但没有 sb」的档。读侧 `sbOf` 有兜底，写侧（`onSb` /
       `onSbPreset`）直接写 `s.god.sb[key]` 会抛 TypeError ⇒ 在这里补一份恒等默认。 */
    if (!s.god.sb) s.god.sb = { ...SB_DEFAULT };
    if (d.sb !== undefined) return onSb(d.sb);
    if (d.sbpreset !== undefined) return onSbPreset(d.sbpreset);
    if (d.sbseed !== undefined) return onSbSeed(node);
    return onSbRoll();
  }

  if (d.sym !== undefined) return onSym(d.sym);
  if (d.chan !== undefined) return onChan();
  if (d.ex !== undefined) return onEx(d.ex);
  /* 换所二次确认的两个出口（Batch 2 · B10）—— 确认键自带目标所 id，所以不需要额外的「待确认」状态。 */
  if (d.exok !== undefined) {
    closePicker();
    const r = switchExchange(s, d.exok);
    if (!r.ok) { pushLog(s, r.why, 'bad'); snd.deny(); snd.buzz('light'); }
    else { snd.pick(); snd.buzz('pick'); }
    after();
    return;
  }
  if (d.exno !== undefined) { closePicker(); after(); return; }
  if (d.frac !== undefined) { s.sizeFrac = Number(d.frac); after(); return; }
  /* 买 U（v13 · 方案 §3）：一枚键走两个值 —— 金额档（`0.25` / `0.5` / `1`）写进 `s.sizeFrac`，
     `go` 才真的兑换。**与操作区的金额档共用同一个状态**：它本来就是同一个概念
     （「用掉我手上多少钱」），再开一个只服务买 U 的比例，玩家得记两处高亮，反而更糊涂。 */
  if (d.buyu !== undefined) {
    if (d.buyu !== 'go') { s.sizeFrac = Number(d.buyu); after(); return; }
    const r = buyUsdt(s, s.sizeFrac);
    /* 成功时 `buyUsdt` 内部已经写了日志（含成交价与花费），这里**只补失败原因**，
       否则会多出一条空串日志。 */
    /* 买 U 是一次**真实的主动操作**，值得一声反馈 —— 原来借用 `fundUp`，
       那个音在 T-1 随「资金费不再出声」一起删了，改接 `notice`（中性短上行）。 */
    if (!r.ok) { pushLog(s, r.why, 'bad'); snd.deny(); snd.buzz('light'); } else snd.notice();
    after();
    return;
  }
  if (d.lev !== undefined) {
    /* 该所此刻没有融资 ⇒ 杠杆行是**置灰不可点**的（v10 · ②）。它挂的是 `aria-disabled` 而不是
       `disabled`，正是为了能让这一下走到这里 —— 给一句「暂不可用 ｜ 为什么」，而不是毫无反应。
       判据与渲染层、与 `engine.openTrade` 同源（`hasFinancingAt`），三处不各算一遍。 */
    if (levKind(s) === 'margin' && !hasFinancingAt(timeOf(s), s.ex)) {
      pushLog(s, '杠杆 暂不可用 ｜ 该所此刻没有融资业务（只能 1x 做多）', 'info');
      snd.deny(); snd.buzz('light');   // 按得动却没反应最难受：给一声「不行」＋ 一记触感
      after();
      return;
    }
    const want = Number(d.lev);
    /* **持仓时杠杆被锁死**（2026-10-02 用户拍板）：同一枚币只能有一条仓位，而加仓必须同杠杆
       （`posGate`）⇒ 持仓期间改杠杆只会得到一张「按得动、下不出去」的表。
       渲染层已经把其余档位画成灰（`.opt:disabled`），这一行是**状态机不靠 DOM 兜底**。
       文案与 `posGate` 逐字一致，两处指的是同一件事。 */
    const held = posOf(s, s.sym);
    if (held && want !== held.lev) {
      pushLog(s, `${s.sym} 已持 ${held.lev}x ｜ 加仓必须同杠杆 ｜ 先平仓再重开`, 'info');
      snd.deny(); snd.buzz('light');   // 同上：这是一次被拒的选档，不该无声
      after();
      return;
    }
    /* 上限取**本单走的那张表**（§15.1）—— 杠杆档位与合约档位是两套数，不能拿一张去夹另一张。
       ⚠️ OTC 通道跟随模式（杠杆表），但再叠一道 `OTC.levMax`（5x）封顶 —— 与 `engine.openCheck`
          同源，否则界面会显示一个下不出单的档位。 */
    const cap = Math.min(maxLeverageAt(timeOf(s), s.ex, levKind(s)), chanOf(s) === 'otc' ? OTC.levMax : Infinity);
    s.lev = Math.max(1, Math.min(want, cap));
    after();
    return;
  }
  if (d.speed !== undefined) { s.speed = Number(d.speed); after(); return; }
  /* 模式切换（U1 · ROADMAP §21.4；v9 · §15.6 N3；2026-10-04 改为操作区顶部「工具」行里的**两枚显式档**）：
     `杠杆` / `合约` 各挂一个值（`data-mode2="margin"` / `"fut"`）。它决定的是**整张杠杆表**
     与**整行动作键的字面**（杠杆＝买入/卖出、合约＝做多/做空/平仓），见 `engine.marginOf` / `levKind`。
     ⚠️ `data-mode2`（「工具」行），不是 `data-mode`（那是 K 线粒度小字）。
     ⚠️ 该所此刻**没有合约**时「合约」那一枚根本不出现（整行隐藏），但**状态机不靠 DOM 兜底**
        （同 `onChan`）：少了下面那行护栏，`s.mode` 就会切到一张不存在的杠杆表上。 */
  if (d.mode2 !== undefined) {
    const want = d.mode2 === 'fut' ? 'fut' : 'margin';
    if (want === 'fut' && !futuresAvailable(s)) return;
    if (s.mode === want) return;              // 点的是**已经选中**的那一枚：不动，也就不必回话
    /* **任何持仓都不许切模式**（2026-10-02 拍板；2026-10-04 修**只锁当前币**的漏洞）：
       原来这里判的是 `posOf(s, s.sym)` —— 只认**当前这个币**。于是「持着 BTC 合约仓、切到 ETH
       看盘」时这一枚又变回可点，能把 `s.mode` 翻回杠杆，而 BTC 那条合约仓还挂着 ——
       与「杠杆仓与合约仓不能并存」（`posGate`）直接打架，UI 与真实仓位就此对不上。
       改成 `anyHeld(s)`：**只要手上还有任何一条仓位**，两个方向一律锁死，先全部平仓再切。
       ⚠️ 渲染层把**另一枚**画成 `.off`（灰、点线、仍可点）⇒ 这里必须回话，否则点了零反馈
          （用户既定口径：不可用要**说明原因**；这条日志就是那句话）。 */
    if (anyHeld(s)) {
      pushLog(s, '有持仓 ｜ 先全部平仓再切换杠杆 / 合约', 'info');
      after();
      return;
    }
    s.mode = want;
    /* 切模式后重新夹取杠杆：两张表的上限不同（如 Binance 杠杆 5x / 合约 125x），
       不夹的话从合约切回杠杆会带着一个杠杆拿不到的档位（`engine.normalizeLeverage` 顺带兜住模式）。 */
    normalizeLeverage(s);
    after();
    return;
  }
  /* 粒度切换（Batch 3 · B12）：小字上写的是**当前**粒度，点一下切到另一种 —— `1h ⇄ 1d`。
     ⚠️ 细刻度档（`1t` ＝ 30 秒）已于 2026-10-01 整体移除（ROADMAP §四十）⇒ 这里只有两档。
     只动视野，不动玩法 —— `s.i` 永远还是「第几根小时 K」。 */
  if (d.mode !== undefined) {
    /* ⚠️ 回顾页那枚粒度小字走 `rv.i` / `rv.sym` —— 回顾的「现在」不在 `s` 里（方案 §3.3）。 */
    if (rv) {
      setMode(rv.sym, viewOf(rv.sym, RV_NS).mode === '1h' ? '1d' : '1h', rv.i, chartW(), RV_NS);
      draw(true);
      return;
    }
    setMode(s.sym, viewOf(s.sym).mode === '1h' ? '1d' : '1h', s.i, chartW());
    after();
    return;
  }
  if (d.pause !== undefined) {
    if (!s.over) {
      const was = s.paused;
      s.paused = !s.paused;
      /* 从暂停点「继续」⇒ 速度强制回到 1x（§73.8 · 2026-10-02 用户拍板）：
         否则玩家会把 100x 停在暂停前，一「继续」就瞬间冲过锁定的那一小时。 */
      if (was && !s.paused) s.speed = 1;
    }
    after();
    return;
  }
  /* 结束遮罩上的「重新开始」：本局都已经结束了，没有必要再问一遍（Batch 4 起彻底直通）。 */
  if (d.restart !== undefined) return doRestart();
  if (d.wipe !== undefined) return onWipe();

  /* 杠杆模式那两枚动作键（v9 · §15.3 N4）：**买入＝借 U 做多、卖出＝借币做空**。
     ⚠️ 反向那一枚**自己承担平仓**（杠杆模式没有独立的「平仓」键）：
          空仓 ⇒ 开仓；**同向 ⇒ 加仓**（v13 · B4，`openTrade` 内部并进那条仓位）；
          反向 ⇒ 平掉它。
     ⚠️ 合约模式下这两枚不显示，同样挡一次 —— 否则会从一个不该存在的入口开出一张合约单。 */
  if (d.buy !== undefined || d.sell !== undefined) {
    if (s.mode === 'fut' && futuresAvailable(s)) return;
    const side = d.buy !== undefined ? 'long' : 'short';
    const pos = posOf(s, s.sym);
    /* ⚠️ **融资判据必须排在「有没有仓位」之后**（2026-09-29 修 bug）：手上压着一张多仓时，
       「卖出」是**平多**，平仓不需要借币 ⇒ 与融资无关。原来这条写在 `posOf` **之前**，
       于是在一个只有 1x、无融资的所里买进之后**再也卖不出去**，还误报
       「杠杆做空 暂不可用 ｜ 该所此刻没有融资业务」——那是开空才需要的条件。
       现在只拦「**空仓开空**」这一种，判据与渲染层的 `needLev = !dir && !canLev` 完全一致
       （渲染层对这种情况**保留可点**、只画灰 ⇒ 这条分支才真的能被触发，P1-16/17 · 2026-10-04 审计）。
       `engine.openTrade` 那边本来就是对的（先 `posOf` 再判融资），这里补的是主入口。 */
    if (!pos && side === 'short' && levKind(s) === 'margin' && !hasFinancingAt(timeOf(s), s.ex)) {
      pushLog(s, '杠杆做空 暂不可用 ｜ 该所此刻没有融资业务（借不到币）', 'info');
      snd.deny(); snd.buzz('light');
      after();
      return;
    }
    if (!pos || pos.side === side) {
      const r = openTrade(s, side, s.sizeFrac);
      if (!r.ok) { pushLog(s, r.why, 'bad'); snd.deny(); snd.buzz('light'); }
      else { s.lockI = s.i; snd.open(); snd.buzz('light'); }
    } else {
      /* `why` 写玩家按下的那枚键：平多＝卖出（卖出手上的币）、平空＝买回（买回借出的币）。
         ⚠️ 第三参 = **平掉多少**（2026-10-02 用户拍板）：金额档那 1/4 · 1/2 · 全部现在
            对「开仓」与「平仓」是同一个含义 —— 分批卖出 / 分批减仓从此走同一枚 `s.sizeFrac`。 */
      const r = closeTrade(s, side === 'long' ? '买回' : '卖出', s.sizeFrac);
      if (!r.ok && r.why !== 'liquidated') { pushLog(s, r.why, 'bad'); snd.deny(); snd.buzz('light'); }
      else { s.lockI = s.i; snd.close(); snd.buzz('light'); }
    }
    after();
    return;
  }
  if (d.act === 'long' || d.act === 'short') {
    const r = openTrade(s, d.act, s.sizeFrac);
    if (!r.ok) { pushLog(s, r.why, 'bad'); snd.deny(); snd.buzz('light'); }
    else { s.lockI = s.i; snd.open(); snd.buzz('light'); }
    after();
    return;
  }
  if (d.act === 'close') {
    /* 合约模式的「平仓」同样吃金额档（2026-10-02 用户拍板）：与杠杆「卖出」是一条路径 ——
       点 1/4 就减掉四分之一，点「全部」才是原来那个一键全平。 */
    const r = closeTrade(s, '手动', s.sizeFrac);
    if (!r.ok && r.why !== 'liquidated') { pushLog(s, r.why, 'bad'); snd.deny(); snd.buzz('light'); }
    else { s.lockI = s.i; snd.close(); snd.buzz('light'); }
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
  // 结束 / 待领救济金决策（B30）时换所没有意义：待决态下只该回答遮罩上那个问题
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
 * ⚠️ `otcOpenFor` 也要挡（P2-B 修订）：禁用态的键本来点不出事件，但**状态机不能只靠 DOM 兜底** ——
 *    少了这一行，一旦那个币还没开通 OTC，就会在一条「这个币根本没有的通道」里落一笔选择。
 *    （2026-10-05 起选择存在 `s.chanBy[s.sym]`，不再是全局 `s.chan`。）
 */
function onChan() {
  if (!otcUnlocked(s) || !otcOpenFor(s)) return;
  /* ⚠️ **持仓期间也可切换**（2026-10-04 · F4 · 用户拍板「放宽」）：旧实现在这里用
     `posOf` 守卫把持仓期间的切换整条挡掉，遇到「OTC 仓位 ＋ 权益跌破解锁线」时形成死结。
     现在放开 —— 跨通道**加仓**仍由 `posGate` 拦（提示先切回同一通道），
     「切回盘口 / 平仓」这条路不再被堵死。 */
  /* 2026-10-05 用户拍板「只记通道 per 币种」：选择写进**逐币**表（懒建 —— 旧档没有这个键，
     塞进 `save.js` 的 `SHAPE` 会让老档被判不合格而丢弃，见 `state.js` 的 `chanBy` 注释）。
     换币不再互相覆盖：「BTC 选 OTC → 切到 ETH → 切回 BTC」记得 BTC 是 OTC。
     写入走 `engine.setChanChoice`（唯一写入口，Node 审计据此断言这条真实路径）。 */
  setChanChoice(s, chanOf(s) === 'otc' ? 'book' : 'otc');
  /* 切到 OTC 就把杠杆夹到 `OTC.levMax`（5x）：大宗通道跟随模式，但机构借贷口径封顶 5x ——
     超过封顶的档位在操作区当场置灰（`render` 与这里同源），比事后再拒绝更直白。
     切回盘口**不还原**原来的杠杆 —— 那需要多存一个字段，而封顶值是个安全的默认。 */
  if (s.chanBy[s.sym] === 'otc' && s.lev > OTC.levMax) s.lev = OTC.levMax;
  after();
}

/* ── 逐仓「调整保证金」（2026-10-04 用户拍板 · OKX 式）──────────────────
   两个入口共用这一处分派，值走 `<cmd>:<sym 或 frac>:<frac>`：
     · `open`  开弹层（资产页持仓行那枚「调整」）
     · `add:<sym>:<frac>` / `sub:<sym>:<frac>`  弹层里的预设键（加 / 减）
     · `addcur:<frac>` / `subcur:<frac>`  **交易页「保证金率」格内的 − / + 步进**
       —— 不写 `<sym>`：那一格是常驻 DOM（挂载时还不知道玩家会切到哪个币），
          币种当场取 `s.sym`（`render.js` 那两枚键的 `data-mg` 就这么写的）。
   ⚠️ 金额**点的时候现算**（`marginStepOf` / `marginCapsOf`），不信任按钮上那个旧数字 —— 余额与上下限随时在变。
   ⚠️ 每次动的量 = **开仓保证金（名义 ÷ 杠杆）× frac**（`engine.marginStepOf`，2026-10-05 用户拍板）。
      旧口径「可用上限 × frac」每点一次基数就缩水 ⇒ 越点越小、永远到不了顶（用户反馈「只能一点一点加」）；
      换成恒定的开仓保证金后，同样点 4 次 25% 就恰好动掉一个开仓保证金的量，且与杠杆无关地一致。
   ⚠️ 弹层的键（`add` / `sub`）每次动完**重开一次弹层**，让「保证金 / 保证金率 / 强平价」
      与预设金额落到最新值；框内步进（`cur`）**不弹层** —— 它要的就是「原地即时看数」。
   ⚠️ 上限为 0 时**先说人话**（别让 `adjustCheck` 回一句「调整金额为 0」，那会让人以为键坏了）。 */
function onMarginAdjust(s, val) {
  const [cmd, a, b] = String(val).split(':');
  if (cmd === 'close') { closePicker(); return; }
  if (cmd === 'open') { openMarginDlg(s, a); return; }
  const cur = cmd === 'addcur' || cmd === 'subcur';
  if (cmd !== 'add' && cmd !== 'sub' && !cur) return;
  const add = cmd === 'add' || cmd === 'addcur';
  const sym = cur ? s.sym : a;
  const frac = Number(cur ? a : b);
  const caps = marginCapsOf(s, sym);
  if (!caps) { if (!cur) closePicker(); return; }  // 仓位已经没了：关掉弹层
  const cap = add ? caps.add : caps.reduce;
  if (!(cap > 1e-9)) {                             // 零上限：给一句准话
    /* 加保证金撞上 1x 封顶（2026-10-05）要单独说 —— 这时既不是余额不够、也不是币种不对，
       说「可用余额不足」会让玩家以为充钱就能继续加（其实充了也加不了）。 */
    pushLog(s, add
      ? (!(caps.headroom > 1e-9)
        ? '实际杠杆已到 1x ｜ 保证金不能再加'
        : (caps.mustUsdt ? '合约保证金必须是 USDT ｜ 先在资产页把美元换成 U' : '可用余额不足'))
      : '保证金率接近维持线 ｜ 不能再减', 'bad');
    after();
    return;
  }
  const delta = (add ? 1 : -1) * marginStepOf(s, sym, frac, add);
  const r = adjustMargin(s, sym, delta);
  if (!r.ok) pushLog(s, r.why, 'bad');
  after();                                         // 重画（HUD / 持仓条 / 资产页）＋ 存盘
  if (!cur) openMarginDlg(s, sym);                 // 弹层里的键：动完重开一次
}

/* ── 上帝模式 ＋ 订单冲击（隐藏入口 · 方案 §2）─────────────────────
   一个隐藏入口（连点标题）、一个玩法开关（设置面板）、一张面板（资金 / 跳日期 / 关闭）。
   ⚠️ 面板是**静态 DOM**，所以「填入」要从它内部读输入框的值 —— 输入框不能挂 `data-*`
      （`bind.js` 会 `preventDefault` 掉 `pointerdown`，挂上去就打不了字）。
      ⚠️ 跳日期那三排档位是**按钮**、不是输入框，照旧走 `data-godyear` / `godmon` / `godday`。 */

/**
 * 标题点击。两条路径（2026-10-01）：
 *   · **已解锁**（`s.god` 非空）⇒ 单击直接重开面板，不必再连点；
 *   · **未解锁** ⇒ 走连点计数：**1.5 秒内 5 次**才触发，间隔超时就从 1 数起。
 * 关掉上帝模式（`onGodOff` 把 `s.god` 置空）等于回到未解锁 ⇒ 下次仍要连点 5 次，
 * 「隐藏入口」这层语义因此没有被削弱。
 */
function onGodTap() {
  /* ⚠️ **挑战模式没有上帝模式**（2026-10-01 用户拍板）：挑战是「速通」，填资金 / 跳日期都会
     把难度归零。连点入口直接吞掉，连计数都不起 —— 免得玩家点了五次以为坏了。
     与「新手提示整行不出现」同一条口径：挑战局是**有限制**的，限制在状态机里拦，不靠 UI。 */
  if (isChallenge(s.scen)) return;
  if (s.god) {
    /* 与下面那条同一个理由：本局已结束 / 正停在救济金遮罩上，时间不再前进，开面板没有意义 */
    if (s.over || s.pending) return;
    godSel = null;                      // 重新打开 ⇒ 选择器回到「当前日期」起手
    godPage = 0;                        // 页签同样回到第 1 页
    showGod();
    after();
    return;
  }
  const now = performance.now();
  godTaps = now - godTapAt > GOD_TAP_MS ? 1 : godTaps + 1;
  godTapAt = now;
  if (godTaps < GOD_TAPS) return;
  godTaps = 0;
  /* 本局已结束 / 正停在救济金遮罩上：时间不再前进，开这张面板没有意义（而且 `s.over` 下评论区那些
     动作本来就被别处挡掉了，这里先拦一次更干净）。 */
  if (s.over || s.pending) return;
  enableGod(s);
  godSel = null;                        // 重新打开 ⇒ 选择器回到「当前日期」起手
  godPage = 0;                          // 页签同样回到第 1 页
  showGod();
  after();
}

/** 面板的统一出口 —— 每次都把暂存的选择器 ＋ 当前页带上，点年 / 月 / 日或切页之后才不会跳回去 */
const showGod = () => openGod(s, godSel, godPage);

/**
 * 上帝面板页签（`data-godtab="0|1"`，2026-10-05 分页）—— 只改界面页码，**不碰 `s`**。
 * ⚠️ 与 `godSel` 同一处境：面板是静态 DOM、不参与每帧重绘 ⇒ 切页必须重开一次本层。
 *    `godSel` 原样保留，所以从沙盒页切回日期页时，「目标」仍停在玩家之前点的日子。
 */
function onGodTab(node) {
  godPage = Number(node.dataset.godtab) || 0;
  showGod();
}

/**
 * 面板里那枚「填入」：**直接设定当前交易所的余额**（方案 §2.3），不是在原余额上加。
 *
 * ⚠️ v13 起要填的是**这个年代的那一格**（方案 §9.2 ④）：2014-11-20 之前填美元、之后填 U
 *    —— 与「搬钱走哪条通道」同一把尺子。否则在 2013 年填 100 万，玩家手上会多出一笔
 *    那一年根本不存在的 USDT，合约也就能在 2013 年开出来了（史实上要等到 2014-11 之后）。
 */
function onGodCash(node) {
  const v = readGodInput(node, '.god-cash');
  const num = Number(v);
  if (v === null || v.trim() === '' || !Number.isFinite(num) || num < 0) {
    pushLog(s, '填入资金：请输入 ≥ 0 的数', 'bad');
    after();
    return;
  }
  /* 归零后的**负账本一并清零**（2026-09-30 裁决）：逐仓的浮亏与「1x 杠杆空单」的亏损是
     **无上限**写进账本的（`credit` 允许负额，见 `engine.closeTrade`），普通玩法由 `isBankrupt`
     终局接住，而上帝模式「归零不退出」会把它原样留在资产页（长局抽检实测最坏 −$74 万一格）。
     不清的话，玩家补完钱会发现净值仍是负的，且那一格**永远还不清**。 */
  for (const b of Object.values(s.books)) {
    if (b.usd < 0) b.usd = 0;
    if (b.usdt < 0) b.usdt = 0;
  }
  ensureBook(s)[cashCurAt(timeOf(s))] = num;
  s.god.lastFill = num;
  s.godRuined = false;                 // 补上钱之后，下一次归零要能再提示一遍
  pushLog(s, `上帝模式 ｜ 资金已填入 ${fmtMoney(num)}`, 'ok');
  showGod();                           // 重开面板：输入框预填值跟着 `lastFill` 走
  after();
}

/**
 * 日期选择器：改**一个**分量，其余不动（`k` = `'y'` / `'m'` / `'d'`）。
 * ⚠️ 日要夹到该月实际天数：选中 1/31 再点 2 月 ⇒ 落到 2/28（闰年 2/29），不往 3 月进位。
 * ⚠️ 这里**只改暂存值 ＋ 重开面板**，一帧 `s` 都不碰 —— 真正跳转在 `onGodGo`。
 */
function onGodPick(k, v) {
  const now = new Date(timeOf(s));
  const b = godSel ?? { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
  const next = { ...b, [k]: v };
  /* `Date.UTC(y, m, 0)` = 该月最后一天的 00:00 —— 拿它取「这个月有几天」 */
  const dim = new Date(Date.UTC(next.y, next.m, 0)).getUTCDate();
  godSel = { y: next.y, m: next.m, d: Math.min(next.d, dim) };
  showGod();
}

/** 「跳到」：把暂存的年月日折成小时序号，交给 `godJump`。 */
function onGodGo() {
  const now = new Date(timeOf(s));
  const sel = godSel ?? { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
  godSel = null;
  const at = Date.UTC(sel.y, sel.m - 1, sel.d);
  godJump(Math.round((at - GAME.start) / HOUR_MS), fmtDate(at, false));
}

/**
 * 跳日期 —— **向前 = 时间自然流过；向后 = 回到过去**（2026-09-30 裁决）。
 *
 * 向前 ⇒ 逐小时重放（`advanceOneHour`）：不能只改 `s.i`，那等于把这段时间里的事件白送
 *        （交易所灾难、币解锁、杠杆阶梯、强平、资金费、转账到账），
 *        而且玩家的持仓必须**真的走过**这段时间。
 * 向后 ⇒ 倒放没有定义（行情与事件都是单向累积的），改走 `godRewind`：
 *        保留资金、清空持仓，直接把时钟落到那一刻。
 *
 * @param {number} target 目标小时序号（未夹取）
 * @param {string} label  日志里的日期文案（`fmtDate` 的结果）
 */
function godJump(target, label) {
  /* 年代开局（M1）：**跳不到本局开局之前** —— `day0` / `cash0` 都是按开局那一天定的，
     时钟落回 2013 年之后，资金曲线与涨跌着色的基准全部错位（M1 之前不存在这种目标，
     因为开局恒在全程第 0 根）。这里明说一句而不是静默夹取：玩家选的日期与真正跳到的日期
     对不上，比跳不动更难查。 */
  const floor = scenarioStartIndex(s.scen);
  if (target < floor) {
    pushLog(s, `本局自 ${fmtDate(scenarioOf(s.scen).at, false)} 起 ｜ 跳不到更早`, 'info');
    showGod();
    after();
    return;
  }
  const to = Math.min(Math.max(target, floor), s.endI - 1);
  if (to === s.i) {
    pushLog(s, `已经在这一刻：${label}`, 'info');
    showGod();
    after();
    return;
  }
  if (to < s.i) return godRewind(to, label);

  /* 同步循环 ⇒ `createClock` 的 `setInterval` 不可能插进来。三种情况都要停：
       ① 到目标日期  ② 到 2024-12-31 收盘（`s.over`）
       ③ **中途账户归零、弹出救济金遮罩**（`s.pending`）—— 少了第三个判据这里会**死循环**：
          `advanceOneHour` 在 `pending` 下会立刻 return（`s.i` 永远不前进），
          而 `!s.over` 一直为真，浏览器就卡死了（2026-09-29 离线断言逮到）。
     ⚠️ 时长实测：2013-01 → 2024-12 全程 10.5 万小时 ≈ 0.4 秒（长局抽检 2026-09-30），
        所以这里不需要分片或进度提示。 */
  while (s.i < to && !s.over && !s.pending) advanceOneHour(s);
  /* 停在救济金遮罩上时**不要**再开上帝面板 —— `draw()` 刚把遮罩铺上，压一张面板上去只会打架 */
  if (!s.over && !s.pending) showGod();
  after();
}

/**
 * **回到过去**（2026-09-30 裁决）—— 保留资金、清空持仓。
 *
 * 状态变换整块在 `engine.rewindTo`（core 侧，可离线断言）；这里只做 UI 该做的三件事：
 * 记一条日志、重开面板、必要时把回落到的币的行情拉进来。
 */
function godRewind(to, label) {
  const cash = rewindTo(s, to);
  pushLog(s, `回到 ${label} ｜ 资金已保留（${fmtMoney(cash)}），持仓已清空`, 'ok');
  showGod();
  after();
  /* 回落到的币可能还没加载过 —— 与 `onSym` 同一手法：先重画，拉到之后再刷新 */
  if (!isLoaded(s.sym)) ensureCoin(s.sym).then(() => draw(true));
}

/**
 * 「关闭上帝模式」：退出 `s.god`（⇒ 停止归零保护）。
 * ⚠️ **行情位移不还原**：订单冲击池 `s.flow` 留着（那是已发生的历史）。
 *    上帝模式本来也不再持有任何价格状态（2026-09-29 瘦身），所以关掉只是关掉保护。
 */
function onGodOff() {
  s.god = null;
  godSel = null;                       // 关掉 => 选择器的暂存目标一并丢掉
  pushLog(s, '上帝模式已关闭 ｜ 订单冲击保留', 'info');
  closePicker();
  after();
}

/** 上帝面板里输入框的值 —— 输入框没有动作键，只能从同一个面板里按类名找（两个框各有一个唯一类） */
const readGodInput = (node, sel) => node.closest('.godp')?.querySelector(sel)?.value ?? null;

/* ── 上帝沙盒（2026-10-05 用户拍板「让上帝模式成为独特的沙盒游乐场」）────────────
   5 枚旋钮 ＋ 4 组预设 ＋ 种子，全走 `s.god.sb`（种子例外，见 `onSbSeed`）。
   ⚠️ 只作用在合成层，**不碰真实 OHLC** —— 无论怎么调，行情仍是那段真实历史（见 `god.js` 头注）。 */

/** 旋钮档位（`data-sb="heat:1.5"` / `"mood:-0.15"`）—— 写单枚旋钮。 */
function onSb(cmd) {
  const [key, raw] = String(cmd).split(':');
  if (!SB_KEYS.includes(key)) return;
  const v = Number(raw);
  if (!Number.isFinite(v)) return;
  /* 倍率类非负（负方向没有意义）；`mood` 是偏移量，天然可负。口径与 `sbOf` 一致。 */
  s.god.sb[key] = key === 'mood' ? v : Math.max(0, v);
  showGod();                           // 重开面板：刷新选中态
  after();
}

/** 世界预设（`data-sbpreset="bull"`）—— 5 枚旋钮一次性替换。 */
function onSbPreset(id) {
  const p = SB_PRESETS.find(x => x.id === id);
  if (!p) return;
  /* 逐键写入而不是整体替换 `s.god.sb` —— 与 `enableGod` 的「只补缺失的键」同一规矩：
     预设只覆盖它声明的那 5 枚，将来 `sb` 上若多出别的键，不被抹掉。 */
  for (const k of SB_KEYS) s.god.sb[k] = Number.isFinite(p.sb[k]) ? p.sb[k] : SB_DEFAULT[k];
  pushLog(s, `沙盒 ｜ 已切换到「${p.name}」`, 'ok');
  showGod();
  after();
}

/** 种子「应用」（输入框 `.god-seed`）—— 写的是**存档本体 `s.seed`**，不是 `s.god.sb`。
    ⚠️ 归一成 uint32（`rng.rand` 按 `seed >>> 0` 取数）。 */
function onSbSeed(node) {
  const v = readGodInput(node, '.god-seed');
  const num = Number(v);
  if (v === null || v.trim() === '' || !Number.isFinite(num)) {
    pushLog(s, '种子：请输入一个数', 'bad');
    after();
    return;
  }
  s.seed = num >>> 0;
  pushLog(s, `沙盒 ｜ 种子已换为 ${s.seed}`, 'info');
  showGod();
  after();
}

/** 种子「随机」—— 换一条随机数流（跨所价差 / 事件时刻 / 强平细路径）。 */
function onSbRoll() {
  s.seed = (Math.random() * 0x100000000) >>> 0;
  pushLog(s, `沙盒 ｜ 种子已换为 ${s.seed}`, 'info');
  showGod();
  after();
}

/* ── 主菜单（需求 4 · 方案 §2；存档拆两槽 2026-10-01；改弹窗 2026-10-02）────────
   菜单期间时钟是停的（见 `boot`），选完才真正开盘。

   · `load`    ：弹一层「读取存档」（`openSavePick`），列出有档的槽，见 `onSlot`。
   · `start`   ：开一局新的**经典全程**；已有普通档 ⇒ 先「武装」（按钮变红，3 秒内再点一次才重开）。
   · `scen`    ：弹一层「挑战模式」（`openScenPick`）—— 它本身不开局，见 `onScenario`。
   · `review`  ：只读回顾模式（`enterReview`）。
   · `careers` ：交易档案页（M2 · 2026-10-01）—— 见 `enterCareers()`。
   · `install` ：PWA 安装（2026-10-01）—— 见 `onInstall()`。
   · `about`   ：游戏说明弹窗（2026-10-02 用户要求）—— 见 `openAbout()`。

   ⚠️ 2026-10-02（用户要求）：`load` / `scen` 从「在按钮列下面摊开一段列表」改成「弹一层」。
      摊开会把菜单按钮推上推下，同一枚键在不同状态下落在不同位置 —— 手指记忆失效。 */
function onMenu(kind, node) {
  if (kind === 'load') { openSavePick(menuSlots()); return; }
  if (kind === 'review') return enterReview();
  if (kind === 'careers') return enterCareers();
  if (kind === 'install') return onInstall();
  if (kind === 'about') { openAbout(); return; }
  if (kind === 'scen') { openScenPick(); return; }
  /* kind === 'start'：开一局新的经典全程（普通槽）。已有普通档才需要二次确认。 */
  if (hasSave('normal')) {
    if (!armedOn(node)) { armMenu(node); return; }
    cancelMenuArm();
  }
  startNewGame(DEFAULT_SCENARIO);
}

/**
 * 主菜单「读取存档」列哪些行（2026-10-01 用户拍板）——
 * **真有档的槽** ∪ **当前这一局所在的槽**（后者是为了给「回到菜单又接着玩」一个入口）。
 * 顺序取自 `SAVE_SLOTS`（普通在前、挑战在后）。
 * ⚠️ 全新一局（`isNewGame`）时 `s.scen` 只是个缺省值，**不算当前槽** —— 否则会在没有档的
 *    情况下凭空列出「普通模式」这一行。
 *
 * 每行三样（2026-10-02 用户要求）：**名称 / 时间 / 金额**。
 *   · 名称：普通槽写「普通模式」；挑战槽写**那一局到底是哪个年代**（如「10U 战神」）——
 *     「挑战模式」四个字认不出手里这一局是哪一局。
 *   · 时间：存档停在哪一天（`fmtDate(…, false)`，到天；小时太细，顶栏已经有）。
 *   · 金额：见 `slotMoney()`。
 * ⚠️ 现算而不是开机时算一次：玩家可能刚从设置页回菜单（`onHome` 会先落盘），
 *    那时候手上这个槽的进度才是最新的。代价只是几次 `JSON.parse`，可忽略。
 */
function menuSlots() {
  const cur = saveSlotOf(s.scen);
  /* 第二项：**当前这一局的槽**（给「回菜单又接着玩」留一个入口）—— 但全新一局且**还没落盘**时
     不算（`!isNewGame` 或该槽已有档），否则会在没有任何档的情况下凭空列出「普通模式」。
     ⚠️ **本局已结束（`s.over`）时不再列出**（2026-10-04 用户拍板）：`engine.endGame` 已经清掉
        本槽的档，这里若还按 `k === cur && !isNewGame` 把内存里那份「已打完的局」列出来，
        玩家点一下又会回到结算遮罩 —— 那正是本次要堵的路。 */
  return SAVE_SLOTS
    .filter(k => hasSave(k) || (k === cur && !isNewGame && !s.over))
    .map(key => {
      /* 当前这一局的槽读**内存里那份** `s`（比盘上那份多一次 `boot` 里的权益采样），
         另一个槽只能读盘。 */
      const sv = key === cur ? s : loadSlot(key);
      return {
        key,
        name: key === 'challenge' ? scenarioOf(sv.scen).name : slotName(key),
        date: fmtDate(timeOf(sv), false),
        money: slotMoney(sv),
      };
    });
}

/**
 * 存档行那笔「金额」= **总资产**（2026-10-02 用户拍板：用实时权益口径）。
 *
 * 该槽的持仓币行情**都已经在内存里**时，直接 `equity()` 现算 —— 与 HUD 那格「总资产」
 * 同源同口径，玩家在那局里看到多少，这一行就是多少。
 * 没加载（另一个槽握着本趟没读的那些币）则退回存档里**资金曲线的末点**：那个数是玩家
 * 上次关档时资产页曲线的终点，量级对得上，而且不必为了看一行字再下一次行情包。
 * ⚠️ 这里是**只读**的：`equity()` 只算不写，不会污染另一个槽的状态。
 * @returns {string} 已格式化好的金额（`$12.3k` 这类），算不出来给 `—`
 */
function slotMoney(sv) {
  const v = heldSyms(sv).every(isLoaded)
    ? equity(sv)
    : (sv.eq && sv.eq.length ? sv.eq[sv.eq.length - 1] : null);
  return Number.isFinite(v) ? fmtMoneyShort(v) : '—';
}

/**
 * 重开 / 换档 / 清档前的**同步遮罩 ＋ reload**（2026-10-05）。
 *
 * ⚠️ 为什么必须遮：`location.reload()` 在**新文档提交之前**，浏览器一直显示**旧文档**（上一局的
 *    canvas 画面）—— 弱网 / 冷启动时这段空窗可达几百毫秒，玩家看到的就是「旧状态残留一小会」。
 *    先在本页 `renderBoot` 铺一层全屏遮罩，它会在导航空窗期把旧画面盖住；新文档那边再由
 *    `index.html` 的静态 `.boot` 无缝接力（见那里的注释）。
 * ⚠️ 用 `rAF → setTimeout` 而不是直接 `reload()`：插入 DOM 是同步的，但**绘制**要等本任务让出；
 *    直接 reload 会在这一帧重绘之前就发起导航，遮罩可能一帧都没画出来。
 */
function maskReload() {
  try { renderBoot('正在重新载入…'); } catch { /* 遮罩失败不该挡着 reload */ }
  requestAnimationFrame(() => setTimeout(() => location.reload(), 0));
}

/**
 * 开一局新的（经典全程 / 某张年代卡共用）—— 投年代信箱 ＋ 清掉该槽的档 ＋ reload。
 * ⚠️ 清的是**这一局将要占用的那个槽**（`saveSlotOf(scenId)`），另半边的档一个字不动 ——
 *    这正是「普通 / 挑战各一槽、互不覆盖」的落点。`disableSave` 必须在 `wipe` 之前：
 *    否则 reload 的 `beforeunload` 会把刚删掉的档原样写回来。
 */
function startNewGame(scenId) {
  closePicker();
  stashScen(scenId);
  disableSave();
  wipe(saveSlotOf(scenId));
  maskReload();
}

/** 挑一个存档槽（主菜单「读取存档」那两行，`data-slot`）。 */
function onSlot(slot) {
  closePicker();
  /* 点的就是当前这一局 ⇒ 直接开盘续跑，不必绕一趟 reload。
     ⚠️ 顺手 `paused = false` ＋ `speed = 1`：与 `onTab` 的「切回交易页 ⇒ 自动续跑」同一条口径 ——
        玩家可能是从设置页回菜单再进来的（那时 `paused` 被置真），不这样点一下会「开盘了却不动」。 */
  if (saveSlotOf(s.scen) === slot && hasSave(slot)) {
    tab = 'trade';
    /* ⚠️ **待决态不许续跑**（2026-10-02 审计修）：自动存档可能正好落在「刚爆仓、还没决定领不领
       救济金」那一拍（`s.pending` 与 `s.paused` 在 `engine` 里同时被置真，随后被落盘）。
       原来这里无条件 `paused = false` ＋ `clock.start()` 会让时钟**空转** —— `advanceOneHour`
       开首那条 `if (s.over || s.pending) return;` 一步都不走，但每 50ms 一次的 `step()` 仍把
       `moved` 刷成真、`onFrame` 不停重画重存。保持暂停，恢复交给遮罩上那两枚按钮。 */
    if (!s.over && !s.pending) {
      s.paused = false;
      s.speed = 1;
      clock.start();
    }
    after();
    return;
  }
  /* 换一槽：投信箱后 reload（新一槽的档由开机那趟读进 `s`）。
     ⚠️ 不调 `disableSave` —— 当前这一局的进度要照常落回**它自己的槽**。 */
  stashSlot(slot);
  maskReload();
}

/**
 * 设置页那枚「返回主菜单」（2026-10-01 用户要求）—— 停钟 ＋ 弹菜单，**本局状态一个字不动**
 * （与 `exitReview` / `exitCareers` 同一走法：菜单期间时钟本来就该停）。
 * ⚠️ **本局结束后也给这个出口**（2026-10-02 审计修）：原来这里有一条 `if (s.over) return`，
 *    理由是「回菜单只会看到一屏无处可去的界面」—— 但菜单里开始游戏 / 挑战 / 历史回顾 /
 *    交易档案都还在，唯独「读取存档」会把人送回结算遮罩（那是真相，不是陷阱）。
 *    结算遮罩因此多了一枚「回主菜单」（`render.renderOver`）。
 */
function onHome() {
  closePicker();
  clock.stop();
  after();                       // 先落一次盘：菜单里「读取存档」靠这份档才列得出当前这一局
  openMenu({ canLoad: menuSlots().length > 0 });
}

/**
 * 挑一个年代局开局（M1 · 2026-10-01）—— 主菜单「挑战模式」里那五张卡（`data-scen`）。
 *
 * 与「开始游戏」共用同一套状态机：已有挑战档 ⇒ 先「武装」这张卡（3 秒内再点一次才真重开），
 * 确认后走 `startNewGame()`（投信箱 ＋ 清挑战槽 ＋ reload）。
 *
 * ⚠️ 卡片颜色只标到 `challenge` 的那些（非挑战的经典全程不在列表里，这里再挡一次，
 *    免得将来有人把 classic 也加进列表后出现「点了开始、却又被当成重开」的怪状态）。
 */
function onScenario(id, node) {
  if (!scenarioOf(id).challenge) return;
  if (hasSave('challenge')) {
    if (!armedOn(node)) { armMenu(node); return; }
    cancelMenuArm();
  }
  startNewGame(id);
}

/** 这一枚键是不是**就是**当前被武装的那一枚。
 *  ⚠️ 菜单里现在有 6 枚键共用这套武装状态（开始游戏 ＋ 5 张年代卡）。只判 `menuArmed` 的话，
 *     玩家先点「开始游戏」再点某张年代卡，那一下会**直接当成确认重开** —— 连点两枚不同的键
 *     却触发了一次删档。 */
const armedOn = node => menuArmed && menuNode === node;

/** 武装一枚菜单键（「开始游戏」或某张年代卡）—— 变红 ＋ 改文案，3 秒无后续自动还原 */
function armMenu(node) {
  /* 改点别的一枚 ⇒ 先把上一枚的红色收回去（否则菜单上会同时亮着两枚「确认重开」） */
  if (menuArmUndo) { menuArmUndo(); menuArmUndo = null; }
  menuArmed = true;
  menuNode = node;
  /* 年代卡是多行结构：只换 `b` 那一行，别把 `u` / `span` 一并抹掉 */
  const head = node.querySelector('b');
  if (head) {
    const old = head.textContent;
    head.textContent = '确认重开？';
    node.classList.add('warn');
    menuArmUndo = () => { head.textContent = old; node.classList.remove('warn'); };
  } else {
    const old = node.textContent;
    node.textContent = '确认重开';
    node.classList.add('warn');
    menuArmUndo = () => { node.textContent = old; node.classList.remove('warn'); };
  }
  clearTimeout(menuTimer);
  menuTimer = setTimeout(cancelMenuArm, 3000);
}

/** iOS Safari 从不发 `beforeinstallprompt`（它走「分享 → 添加到主屏幕」）——
 *  ⚠️ 必须排掉 `CriOS / FxiOS / EdgiOS`：那是 iOS 上的**其它**浏览器，引导的话术不一样。 */
function isIosSafari() {
  const ua = navigator.userAgent || '';
  return isIos() && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

/** 是不是 iOS / iPadOS 设备。
 *  ⚠️ iPadOS 13 起 UA 自称 `MacIntel`（与真 Mac 一模一样），只认 `iPad` 会漏掉整个 iPad 线 ——
 *    所以补一条「MacIntel ＋ 多点触控」，那是 iPad 唯一与 Mac 的分野。 */
function isIos() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** 内置 WebView 的应用名（装不了的那一类环境），不是就返回 null。
 *  ⚠️ 这些内核的共同点是**没有「安装应用 / 添加到主屏幕」这一项** —— 引导必须先把玩家赶到浏览器，
 *     否则就是让人去菜单里找一个不存在的按钮（这正是「点了完全没反应」的现场）。
 *  ⚠️ 只认「应用里的 WebView」标志，**不认浏览器**：`MQQBrowser`（QQ 浏览器）是独立浏览器、
 *     装得了，别误伤；`QQ/` 才是 QQ 里那个 WebView。 */
function inAppName() {
  const ua = navigator.userAgent || '';
  if (/MicroMessenger/i.test(ua)) return '微信';
  if (/QQ\//i.test(ua)) return 'QQ';
  if (/aweme|BytedanceWebview|Douyin/i.test(ua)) return '抖音';
  if (/XiaoHongShu|xhsc/i.test(ua)) return '小红书';
  if (/AlipayClient/i.test(ua)) return '支付宝';
  if (/Weibo/i.test(ua)) return '微博';
  return null;
}

/** 当前这台机器的安装环境。`render.js` 的 `installSteps()` 按它挑那唯一一条走得通的路。
 *  `native` ＝ 浏览器是否真的交出过一键安装通道（`beforeinstallprompt`）。 */
function installEnv() {
  const app = inAppName();
  if (app) return { kind: 'inapp', app, native: false };
  if (isIos()) return { kind: isIosSafari() ? 'ios' : 'ios-other', native: false };
  return {
    kind: /Android/i.test(navigator.userAgent || '') ? 'android' : 'desktop',
    native: !!installEvt,
  };
}

/**
 * PWA 安装（2026-10-01）
 * ===============================================================
 * 玩家的目的只有一个：**把游戏存到桌面**。原生安装弹窗只是最快的那条路，不是唯一那条 ——
 * 这是照着 `我创造的完美球员` 那套「保存至手机桌面」抄的：它一直好使，靠的**不是**原生弹窗
 * （那边同样有 `prompt()` 静默失效的时候），而是「弹窗没成 → 立刻摊开图文，玩家照着自己点，
 * 一样拿到桌面图标」。拿到图标才算完，弹窗只是最省事的那条捷径。
 *
 * 这里前后踩过三个坑，都记着免得再踩：
 * ⚠️ 坑 ①（老代码）：`evt.prompt()` 的 Promise 与 `evt.userChoice` 一个都没接 —— 静默失败时
 *    界面上零反馈；`installEvt` 又已置空，再点走 `if (!evt) return`。
 * ⚠️ 坑 ②：为了让按钮不变成死键，曾在 `prompt()` **之前**就调 `menuRemoveInstall()` ——
 *    按钮先没了，弹窗依然不出现，成了「一按就消失，什么也没发生」，比原来更糟。
 *    ⇒ **入口的摘除只挂在「真的装上了」上**（`accepted` / `appinstalled`），绝不提前摘。
 * ⚠️ 坑 ③：Chrome 拒绝弹窗时 `prompt()` 返回的 Promise **既不 resolve 也不 reject**（实测，
 *    一直 pending）。所以「等回调再决定显示什么」＝ 永远静默 —— **不能把图文押在回调上**。
 *    ⇒ 现在就摊开图文，不等回调：弹窗若真出现，它是浏览器自己的界面、盖在本页之上，身后
 *      这份图文不冲突 —— 装成 → `appinstalled` 把它收掉；取消 → 它正好是接下来要看的。
 *
 * ⚠️ `beforeinstallprompt` **只能 `prompt()` 一次**：消费掉之后这个事件就废了。浏览器若还想
 *    让玩家装会**重发一次事件**（上面的监听接住即可，按钮是常驻的不必重挂）。
 * ⚠️ 老版 Chrome 的 `prompt()` 返回 `undefined`，结果只在 `evt.userChoice` 上；新版两者都返回
 *    `Promise<{outcome}>` —— 所以优先用 `prompt()` 的返回值，退到 `userChoice`。
 *
 * ── 2026-10-01 二次重做（线上实测后）──────────────────────────────
 * ⚠️ 坑 ④（真正让线上「完全不起作用」的那一条）：**文案不能一视同仁**。旧版对谁都说
 *    「打开浏览器菜单 ⋮ → 选『安装应用』」，而在微信 / QQ / 抖音这些**内置 WebView** 里
 *    菜单里**没有这一项** —— 玩家照着走就是死路，「点了没反应」由此而来。
 *    ⇒ 现在 `installEnv()` 先判环境，`toggleInstallGuide()` 只给那台机器上真存在的那条路；
 *      内置 WebView 直接明说「这里装不了，先换浏览器」。
 * ⚠️ 坑 ⑤：旧版点一次就把按钮**换成**图文，玩家再也回不到菜单。现在按钮常驻，
 *    图文是它下面可开可关的一段（`toggleInstallGuide` 返回 true＝展开 / false＝收起）。
 * ⚠️ 收起时**不消费** `installEvt` —— 收起来只是先不看，那枚事件还要留着给真正想装的那一下。
 */
function onInstall() {
  if (isStandalone()) return;          // 已经在桌面上跑（菜单本不该给出这枚按钮）

  /* 先摊图文（坑 ③），再试着弹原生框 —— 两者不互斥：真装上了 `appinstalled` 会收走图文。 */
  if (!toggleInstallGuide(installEnv())) return;   // 这次是「收起」：到此为止

  const evt = installEvt;
  installEvt = null;                   // 同一个事件 prompt 不了第二次

  if (!evt) return;                    // 这台机器没有原生通道（iOS / 国产内核）—— 图文就是那条路
  try {
    const p = evt.prompt();
    /* 老版 Chrome 的 `prompt()` 返回 `undefined`，结果只在 `evt.userChoice` 上；新版两者都返回 Promise */
    const res = (p && typeof p.then === 'function') ? p : evt.userChoice;
    if (res && typeof res.then === 'function') {
      res.then(c => { if (c && c.outcome === 'accepted') menuRemoveInstall(); })
        .catch(() => {});              // 失败无所谓：图文已经在屏上
    }
  } catch { /* 同步抛（被拦下）：同上，图文兜着 */ }
}

/** 撤销主菜单的武装：超时或重开前都要还原按钮，免得下次开局还是红的 */
function cancelMenuArm() {
  clearTimeout(menuTimer);
  menuArmed = false;
  /* ⚠️ 还原交给武装时记下的那个闭包（M1）：原来是**硬编码**写回「开始游戏」的文案 ——
     年代卡复用这套状态机之后，那一句会把整张卡的标题改成「开始游戏」。 */
  if (menuArmUndo) { menuArmUndo(); menuArmUndo = null; }
  menuNode = null;
}

/* ── 历史回顾（需求 4 · 方案 §3）────────────────────────────────────
   独立回顾页 ＋ 复用 `market.js` / `chart.js`（拍板 4）。这一整块与 `s` **零耦合**：
   不写状态、不写存档、不判破产，退出后回到主菜单，玩家那一局一根 K 线都没动过。 */

/** 进回顾：从 2013-01-01 00:00 起，100x 巡航 */
function enterReview() {
  closePicker();
  clock.stop();                                  // 双保险：主菜单期间它本来就没启动
  rv = { i: 0, sym: 'BTC', speed: 100, paused: false, seen: new Set(), log: [], auto: false, autoMode: null };
  rvAcc = 0;
  resetView('BTC', RV_NS);                       // 视野回默认（上次回顾留下的姿势不带到这一次）
  pushRv('开盘 · 2013 年 1 月，Bitfinex', 'info', 0);
  syncRvMode(true);                              // ⑧：起手就是 1 日线（巡航段看日线才看得完 12 年）
  rvStart();
  draw(true);
  /* **五个币全部预载**（2026-10-02 审计修 · 用户拍板）：回顾可以随时切币、也可以跳到任意年份，
     而行情是懒加载的（`market.loadCoin`）⇒ 原来只有 BTC 一路被拉下来，切到别的币先是**一张空白图**，
     网络往返回来才长出 K 线。五个包合计约 1 MB（gzip 后更小），一次拉全比每次切都在等要好。
     ⚠️ 只在**当前正在看的那个币**到货时补一帧 —— 否则五次到货会白画四帧。 */
  for (const c of COINS) {
    if (isLoaded(c.sym)) continue;
    ensureCoin(c.sym).then(() => { if (rv && rv.sym === c.sym) draw(true); });
  }
}

/**
 * 回顾里「哪些节点算已经过」—— **开关打开时全部算过**（纯巡航：不弹卡、也不减速）。
 *
 * ⚠️ 为什么是「换一份集合」而不是像原来那样把 `rv.seen` 一次性填满（本轮 ②）：
 *    旧的「跳过全部」按钮**不可逆** —— 点过之后 `rv.seen` 被永久污染，想回头看不到了。
 *    用户要的是**开关**，开关就必须能关回去，所以 `rv.seen` 一个字都不动，
 *    只让读它的三处（`speedAt` / `nextNodeAt` / 命中判据）改用这个函数取。
 */
const RV_ALL = new Set(RV_NODES.map(n => n.at));
const rvSeen = () => (rv && rv.auto ? RV_ALL : rv.seen);

/**
 * 回顾的粒度**自动跟随巡航速度**（本轮 ⑧ · 用户拍板 —— 比「事件前手动切 1h」少一次操作）：
 *   - 巡航段（离下一个节点 > 1 游戏日 ⇒ `100x`）⇒ **1 日线**（12 年才看得完，一根一天）；
 *   - 进入节点前的减速区（`≤ 1 日` ⇒ `10x` / `1x`）⇒ **自动切回 1 小时线** ——
 *     等史实卡弹出来时，玩家看到的已经是一根根小时 K，针就在眼前。
 * ⚠️ 判据走 `rvSeen()`（本轮 ②）：开关打开时全部算「已过」⇒ 全程 100x ＋ 日线。
 *
 * ⚠️ **`force` 与「区间记账」**（2026-10-01 修）：`rvStep` 每一拍（50ms）都会调到这里，
 *    原来无条件 `setMode` ⇒ 玩家在回顾里点那枚粒度小字（`1日` / `1h`），
 *    下一拍就被按回自动档 ⇒ 表现为「点小时线立刻被打回日线」。
 *    现在按 `rv.autoMode` 记住**上一次自动落下的档**：
 *      - `force`（进回顾 / 切币 / 跳年 / 开关自动）⇒ 一定落一次；
 *      - 非 `force`（`rvStep` 那条自动路径）⇒ **只在自动档自己变了**（巡航区 ⇄ 减速区）时落，
 *        同一区间内玩家的手选档因此能留住。
 */
function syncRvMode(force = false) {
  if (!rv) return;
  const want = speedAt(rv.i, rvSeen()) > 24 ? '1d' : '1h';
  if (!force && rv.autoMode === want) return;
  rv.autoMode = want;
  setMode(rv.sym, want, rv.i, chartW(), RV_NS);
}

/**
 * 把回顾切到**这个事件讲的币**上（本轮 ⑨ · 用户拍板「其他币种事件自动切到那个币看针」）。
 * 节点表里 `sym` 缺省是 `BTC`，所以每个节点都会调一次 —— 上一个节点若是 ETH，
 * 下一个 BTC 节点会自动切回来，不会出现「卡面说 BTC、图上是 ETH」。
 * ⚠️ 币还没上线就原地不动（节点日期都晚于该币 `unlock`，这条只是状态机不靠数据兜底）。
 */
function reviewFocus(node) {
  const sym = node.sym || 'BTC';
  if (rv.sym !== sym) {
    const c = COINS.find(x => x.sym === sym);
    if (c && GAME.start + rv.i * HOUR_MS >= c.unlock) {
      rv.sym = sym;
      resetView(sym, RV_NS);
      if (!isLoaded(sym)) ensureCoin(sym).then(() => draw(true));
    }
  }
  syncRvMode(true);                              // 换币 ⇒ 新币的视野是新开的，按新币重新落一次档
}

/**
 * 节点卡的**弹卡时序**（2026-10-02 审计修 · 用户拍板）—— 原来直接在 `rvStep` 里
 * `reviewFocus(node)` 紧接 `openNodeCard(node)`，切币是同步的、**行情是异步的**：
 * 卡弹出来那一刻图上还是 BTC（或一张空白），等玩家点「继续」的几百毫秒数据才到货 ——
 * 观感就是「在 BTC 的 K 线弹出 ETH 的新闻，点了继续才切过去」。
 *
 * 现在把顺序倒过来，并且等数据：
 *   ① `reviewFocus` 同步切到事件讲的币（图立刻跟着切，币种条也高亮过去）；
 *   ② 先 `draw` 一帧 —— 卡还没弹，玩家已经看见图切过去了；
 *   ③ 该币行情没到货就 await（`enterReview` 已经预载五个币，正常路径这里一秒都等不到）；
 *   ④ 数据到位后补一帧、再弹卡。
 *
 * ⚠️ `await` 期间玩家仍可能按到东西（例如上一张卡的「继续」），所以放行前用
 *    「仍停在同一个节点、且仍处于暂停」把这一趟作废掉 —— 否则会弹出一张已经过时的卡。
 */
async function openNodeWhenReady(node) {
  reviewFocus(node);
  draw(true);
  const sym = rv.sym;
  if (!isLoaded(sym)) await ensureCoin(sym);
  if (!rv || !rv.paused || nodeAt(rv.i) !== node) return;
  draw(true);
  openNodeCard(node);
}

/** 退出回顾：停掉那支专属时钟，回主菜单（方案 §2：退出后回到主菜单） */
function exitReview() {
  rvStop();
  rv = null;
  rvAcc = 0;
  /* 退出整屏页一律落回**交易页**：菜单可能是在设置页上打开的（`onHome`），
     不归位的话「回顾 → 退出」会停在一屏没头没尾的设置页上。 */
  tab = 'trade';
  draw(true);                                    // `rv` 归 nil ⇒ `showPage` 按 `tab` 切回交易页
  openMenu({ canLoad: menuSlots().length > 0 });
}

/* ── 交易档案页（M2 · 2026-10-01）────────────────────────────────
   与回顾模式同一副骨架：进页把主时钟停住（纯只读，行情不该继续走），退出回主菜单。
   ⚠️ **不进存档、不写 `s`** —— 档案是跨局的独立 localStorage 键（`core/careers.js`），
      在 `draw()` 那一支里现读现铺。 */

/** 进档案页：主菜单点「交易档案」 */
function enterCareers() {
  closePicker();
  clock.stop();                                  // 双保险：主菜单期间它本来就没启动
  arch = true;
  draw(true);
}

/** 退出档案页：回主菜单（与 `exitReview` 一字不差的走法） */
function exitCareers() {
  cancelDeleteArm();                             // 停在「确认删除」上就走人：把那枚键恢复原样
  arch = false;
  tab = 'trade';                                 // 与 `exitReview` 同一条：退出整屏页落回交易页
  draw(true);                                    // `arch` 归 falsy ⇒ `showPage` 按 `tab` 切回交易页
  openMenu({ canLoad: menuSlots().length > 0 });
}

/* ── 生涯海报（M5 · 2026-10-02）────────────────────────────────────
   原来是「点一下直接下载 / 弹原生分享面板」，**没有预览**；现在改成参考项目
   （`我创造的完美球员`）那条路：先画好 → 摊在预览层里看一眼 → 再决定保存 / 分享。
   ⚠️ 反馈只落在那枚键自己身上（失败 1.6 秒后恢复）：档案页是整屏页、**没有日志栏**，
      `pushLog` 玩家根本看不见；再起一套 toast 又是新 UI（LESS IS MORE）。
   ⚠️ 出图走**同步的 `toDataURL`**（见 `ui/shareCard.js`）⇒ 要不到「生成中…」那一帧，
      不假装有：只在失败时把那枚键改成「失败」，1.6 秒后还原。 */

/** 放掉当前那张海报的引用（关掉预览层 / 换一张时都走它）—— data URL 无需回收 */
function closePoster() {
  poster = null;
}

/** 「生成海报」：按 id 取回那一条生涯 → 画成 PNG（data URL）→ 摊开预览层 */
function onPoster(id, node) {
  const rec = loadCareers().find(r => String(r.id) === id);
  if (!rec) return;
  const label = node.textContent;
  const url = posterURL(rec);                     // canvas 取不到 / toDataURL 抛错 ⇒ null
  if (!url) {
    node.textContent = '失败';
    setTimeout(() => { if (node.isConnected) node.textContent = label; }, 1600);
    return;
  }
  closePoster();                                  // 上一张还开着的话先放掉
  poster = { rec, name: posterName(rec), url };
  openPoster(url, { onClose: closePoster, canShare: canSharePoster() });
}

/** 预览层「保存图片」—— 下载 / 新窗口长按保存（两级兜底都在 `ui/shareCard.js` 里） */
async function onPosterSave(node) {
  if (!poster) return;
  const label = node.textContent;
  node.disabled = true;
  node.textContent = '保存中…';
  let st = 'failed';
  try { st = await savePoster(poster.url, poster.name); } catch { /* 落到失败 */ }
  node.textContent = st === 'downloaded' ? '已保存' : st === 'opened' ? '长按保存' : '失败';
  setTimeout(() => {
    if (node.isConnected) { node.textContent = label; node.disabled = false; }
  }, 1600);
}

/** 预览层「分享」—— 只有这台机器真有原生分享面板时那枚键才画出来（见 `render.openPoster`） */
async function onPosterShare(node) {
  if (!poster) return;
  const label = node.textContent;
  node.disabled = true;
  node.textContent = '分享中…';
  let st = 'failed';
  try { st = await sharePoster(poster.url, poster.name); } catch { /* 落到失败 */ }
  node.textContent = st === 'shared' ? '已分享' : '失败';
  setTimeout(() => {
    if (node.isConnected) { node.textContent = label; node.disabled = false; }
  }, 1600);
}

/* ── 档案删除的武装（M5 · 2026-10-02）──────────────────────────────
   用户要求的「双重确认」。**不复用主菜单那套 `armMenu`**：它写死「确认重开」，
   且它的 undo 会去改 `b` 子节点（档案行那枚是纯按钮，没有 `b`）。骨架照抄：
   点一次只改文案 ＋ 变红，3 秒无后续自动还原；点第二下才真删。
   ⚠️ 与主菜单那套同一个理由放在模块级 —— 档案列表是重建的，武装状态不能挂在节点上。 */
let delArmed = false;
let delNode = null;
let delUndo = null;
let delTimer = 0;

/** 这一枚键是不是**就是**当前被武装的那一枚（同 `armedOn`：换一条点 = 重新武装，不是确认） */
const delArmedOn = node => delArmed && delNode === node;

function armDelete(node) {
  if (delUndo) { delUndo(); delUndo = null; }     // 改点另一条 ⇒ 先把上一条的红字收回去
  delArmed = true;
  delNode = node;
  const old = node.textContent;
  /* ⚠️ 文案是「确认」而不是「确认删除」（2026-10-05 修）：两者同为 2 个汉字 ⇒ 与原来的
     「删除」**等宽**，武装前后行内零位移 —— 头行那 6 个元素才不会被挤到折行（见 `style.css`
     的 `.career-head`）。语义靠变红的 `.warn` 承担，不靠多两个字。 */
  node.textContent = '确认';
  node.classList.add('warn');
  delUndo = () => { node.textContent = old; node.classList.remove('warn'); };
  clearTimeout(delTimer);
  delTimer = setTimeout(cancelDeleteArm, 3000);
}

function cancelDeleteArm() {
  clearTimeout(delTimer);
  delArmed = false;
  if (delUndo) { delUndo(); delUndo = null; }
  delNode = null;
}

/** 删掉一条档案 —— 第二下才真删；删完 `draw()` 一帧，列表按新签名重建 */
function onDeleteCareer(id, node) {
  if (!delArmedOn(node)) { armDelete(node); return; }
  cancelDeleteArm();
  if (!removeCareer(id)) return;
  draw(true);
}

/** 回顾日志（**加长那一栏**的内容源）：节点史实 ＋ 里程碑，只装回顾自己的东西 */
function pushRv(text, kind = 'info', at = rv.i) {
  const head = rv.log[rv.log.length - 1];
  if (head && head.at === at && head.text === text) return;
  rv.log.push({ at, text, kind });
  if (rv.log.length > 60) rv.log.shift();
}

/** 这一段路里有没有「新币上线」—— 那是时间轴上最实在的里程碑 */
function milestoneBetween(a, b) {
  for (const c of COINS) {
    const at = Math.round((c.unlock - GAME.start) / HOUR_MS);
    if (at > a && at <= b) pushRv(`${c.sym} 上线`, 'info', at);
  }
}

function rvStart() { if (!rvTimer) { rvLast = 0; rvTimer = setInterval(rvStep, 50); } }
function rvStop() { if (rvTimer) { clearInterval(rvTimer); rvTimer = 0; } }

/**
 * 回顾的时钟 —— 与 `engine.createClock` **同一套写法**（`setInterval` ＋ 真实间隔补时 ＋
 * `dt` 封顶 1 秒），只是它推的是 `rv.i` 而不是 `s.i`。
 *
 * 两条回顾专有的规则：
 *   ① **减速曲线**：真正推进的档位 = `min(玩家选的档, speedAt(i))` ⇒ 节点前自动慢下来；
 *   ② **一步不许跨过节点**：100x 下一拍（50ms）要推进约 5 根，直接 `i + 1` 会从 `at − 1`
 *      跳到 `at + 3`，节点卡永远弹不出来。每走一步都夹在「下一个未跳过的节点」上。
 */
function rvStep() {
  if (!rv) { rvStop(); return; }
  const now = performance.now();
  const dt = rvLast ? Math.min(1, (now - rvLast) / 1000) : 0;
  rvLast = now;
  if (rv.paused) return;

  rvAcc += dt * Math.min(rv.speed, speedAt(rv.i, rvSeen()));
  let moved = false;
  let guard = 0;
  while (rvAcc >= 1 && guard++ < 400) {
    rvAcc -= 1;
    const next = nextNodeAt(rv.i, rvSeen());
    const prevI = rv.i;
    rv.i = next ? Math.min(rv.i + 1, next.at) : rv.i + 1;
    moved = true;
    milestoneBetween(prevI, rv.i);

    /* 走到 2024-12-31 收盘：停住（回顾到此为止，没有结算画面） */
    if (rv.i >= GAME.candles - 1) {
      rv.i = GAME.candles - 1;
      rv.paused = true;
      rvAcc = 0;
      pushRv('回顾结束 · 2024 年 12 月', 'ok', rv.i);
      break;
    }
    /* 命中一个**没跳过的**节点：暂停 ＋ 弹史实卡（方案 §3.5）
       ⚠️ 判据走 `rvSeen()`（本轮 ②）：顶部开关打开时它恒为「已过」⇒ 不弹卡、不减速，
          节点标题因此也不进日志 —— 这正是「纯巡航」该有的样子。 */
    const node = nodeAt(rv.i);
    if (node && !rvSeen().has(node.at)) {
      rv.paused = true;
      rvAcc = 0;
      pushRv(node.title, 'ok', node.at);
      openNodeWhenReady(node);   // ⑨：先切到事件讲的币、等它的行情到位，再弹卡
      break;
    }
  }
  if (moved) { syncRvMode(); draw(true); }
}

/** 回顾页的全部动作（`data-review` 的值即子命令） */
function onReview(kind) {
  if (!rv) return;                                 // 状态机不靠 DOM 兜底
  if (kind === 'exit') return exitReview();
  if (kind === 'pause') {
    /* 已到 2024-12-31 收盘：只准停、不准再放行 —— 否则 `rvStep` 一拍后又把它按回去，按钮标签闪一帧 */
    if (rv.paused && rv.i >= GAME.candles - 1) return;
    rv.paused = !rv.paused; rvAcc = 0; draw(true); return;
  }
  /* 节点卡两枚：继续 / 跳过这一个（方案 §3.5；**「跳过全部」本轮 ② 已撤**，
     改成顶部那枚可反复开合的开关 —— 一次性跳过是不可逆的，玩家想回头看不到） */
  if (kind === 'go') { closePicker(); rv.paused = false; syncRvMode(); draw(true); return; }
  if (kind === 'skip') {
    const n = nodeAt(rv.i);
    if (n) rv.seen.add(n.at);                      // 「跳过」**只影响本节点**（验收 ④）
    closePicker();
    rv.paused = false;
    syncRvMode();
    draw(true);
    return;
  }
  /* 「自动跳过」开关（本轮 ② · 用户拍板）：开 ⇒ 之后所有节点的史实卡都不弹（纯巡航）；
     关 ⇒ 立刻恢复逐条弹。**可逆**，因为它不动 `rv.seen`（见 `rvSeen`）。
     ⚠️ 卡片开着时顶栏被 `#overlay` 吃掉点击，所以这里只可能在「没有卡」的时候被按到 ——
        也因此不需要顺手放行任何东西。 */
  if (kind === 'all') {
    rv.auto = !rv.auto;
    rvAcc = 0;
    syncRvMode(true);                              // 开 ⇒ 全程日线；关 ⇒ 回到按节点减速
    draw(true);
    return;
  }
  if (kind.startsWith('spd:')) { rv.speed = Number(kind.slice(4)); rvAcc = 0; draw(true); return; }
  if (kind === 'years') { openYearPick(new Date(GAME.start + rv.i * HOUR_MS).getUTCFullYear()); return; }
  if (kind.startsWith('year:')) return jumpYear(Number(kind.slice(5)));
  if (kind.startsWith('sym:')) return switchRvSym(kind.slice(4));
}

/**
 * 跳到某一年的 1 月 1 日 00:00；路上错过的节点不补弹（回顾是「看」，不是「打卡」）。
 *
 * ⚠️ **跳转即清空日志**（本轮 ③ · 用户拍板）。为什么是「跳转」而不是「每一拍」：
 *    自动推进的日志是**时间线的连续记录**，清它等于把故事擦掉；而跳转是**非线性**的 ——
 *    2013 年那几行留在面板里，会让人把旧线索读成当下的线索。所以规则是
 *    「**玩家显式换时间 ⇒ 清空并重新起一行**」，自动推进、暂停、切币、改速度一律不动日志。
 *    （同一条口径也适用于 `enterReview`：它本来就 `log: []` 起手。）
 */
function jumpYear(y) {
  closePicker();
  const at = Math.round((Date.UTC(y, 0, 1) - GAME.start) / HOUR_MS);
  rv.i = Math.max(0, Math.min(at, GAME.candles - 1));
  rvAcc = 0;
  resetView(rv.sym, RV_NS);                        // 跳完视野跟到新的「当前」
  rv.log.length = 0;                               // ③ 清空（就地清，别换数组 —— 渲染层持有的就是它）
  pushRv(`跳到 ${y} 年`, 'info', rv.i);
  syncRvMode(true);                                // ⑧：跳回巡航段 ⇒ 粒度跟着回日线
  draw(true);
}

/** 回顾里切币（拍板 2：可切币）—— 那个币此刻还没上线就点不动 */
function switchRvSym(sym) {
  if (rv.sym === sym) return;
  const c = COINS.find(x => x.sym === sym);
  if (c && GAME.start + rv.i * HOUR_MS < c.unlock) return;
  rv.sym = sym;
  resetView(sym, RV_NS);
  syncRvMode(true);                                // ⑧：切币不改变速度，但档位要按新币的边界重新夹一次
  draw(true);
  if (!isLoaded(sym)) ensureCoin(sym).then(() => draw(true));
}

/* ── 开场叙事（Batch 4 · B19）─────────────────────────────────────
   弹窗期间时钟是停的（见 `boot`），点了「我是新手 / 我是老手」才真正开盘并放一声起手音。
   `kind`（v11 · ③）只决定 `s.hintOn`：新手 ⇒ 开提示，老手 ⇒ 关提示；叙事文案两者一致。
   ⚠️ **挑战局不走这里**（2026-10-01 用户拍板：挑战恒为老手）—— 由 `boot` 直接 `beginGame()`。 */
function onIntro(kind) {
  s.hintOn = kind !== 'old';
  beginGame();
}

/**
 * 真正开盘（开场弹窗确认后 / 挑战局跳过弹窗时共用）—— 收弹层、写开局日志、起钟、起手音。
 *
 * 开局写一条**真实发生的事**（Batch 5 · B24）：日志条原来是写死的「等待开盘…」兜底，
 * 可此刻行情其实已经在跑 —— 文案与实况自相矛盾。这条日志把空态填掉，
 * 时间戳取 `s.i = 0`（`pushLog` 自己取），语义正确。读档续玩不补（与开场弹窗同一判据）。
 * ⚠️ 年月与交易所必须跟着**本局年代**走（M1）：2021 年的局里写「2013 年 1 月，Bitfinex」，
 *    就是在第一行日志上自相矛盾。
 */
function beginGame() {
  closePicker();
  pushLog(s, openLogText(), 'info');
  clock.start();
  snd.begin();
  /* 新手 ＋ 新局 ⇒ 接一段分步引导（本轮 ④）。⚠️ 排在 `clock.start()` 之后、`after()` 之前：
     引导自己会把时钟压回暂停，`after()` 顺手把「暂停」也落盘（关掉标签页再回来仍是暂停态）。
     ⚠️ 挑战局的 `s.hintOn` 恒为假（`createState`），这里天然不会起引导。 */
  if (isNewGame && s.hintOn) startGuide();
  after();
}

/** 开局那条日志的文字（M1）：经典全程沿用旧文案，其余年代按 `SCENARIOS[].at / ex` 现拼。 */
function openLogText() {
  const sc = scenarioOf(s.scen);
  if (sc.id === 'classic') return '开盘 · 2013 年 1 月，Bitfinex';
  const at = new Date(sc.at);
  return `开盘 · ${at.getUTCFullYear()} 年 ${at.getUTCMonth() + 1} 月，${exchangeOf(sc.ex).name}`;
}

/* ── 新手分步引导（本轮 ④）—— 走完就开盘 ──────────────────────
   `showGuide` / `nextGuide` 都不调 `after()`：引导是 `#overlay` 上的一层，
   与每帧重绘无关；`s.paused` 只在开（`startGuide`）与收（`endGuide`）各写一次。 */

function startGuide() {
  guideStep = 0;
  guideList = guideSteps();
  s.paused = true;         // 读字的时候行情不该跑
  s.speed = 1;
  showGuide();
}

/**
 * 本次引导**真的画得出来**的步骤：节点取得到、且此刻**有尺寸**（不是 `hidden` / `display:none`）。
 *
 * ⚠️ 为什么要筛：`GUIDE` 里那一步「两条通道」的目标是通道键，而它在权益没到当年解锁线时是
 *    `hidden`（`render.js` 的 `chanBtn`，2013 年要 $20 万才露头）—— 开局 $1,000 的经典局根本看不见它。
 *    不筛的话 `openGuide` 量到的是一个 0×0 的矩形，高亮环缩进左上角、卡片指着空气。
 * ⚠️ 序号「N / M」也按筛完的表算 —— 玩家看到的步数必须就是真实步数。
 */
function guideSteps() {
  return GUIDE.filter(st => {
    const t = st.at();
    if (!t) return false;
    const r = t.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

/** 画当前这一步。目标取不到（理论不可达）就**直接收摊**，不让玩家卡在一步空引导上。 */
function showGuide() {
  const st = guideList[guideStep];
  const target = st && st.at();
  if (!target) { endGuide(); return; }
  openGuide(target, `第 ${guideStep + 1} / ${guideList.length} 步 · ${st.text}`, guideStep === guideList.length - 1);
}

/** 「下一步」：走完最后一步 ⇒ 收摊开盘 */
function nextGuide() {
  if (guideStep == null) return;
  guideStep++;
  if (guideStep >= guideList.length) { endGuide(); return; }
  showGuide();
}

/** 收摊：**开盘 ＋ 1x**（与「切回交易页自动续跑」同一条口径，玩家不必再点一次「继续」） */
function endGuide() {
  guideStep = null;
  closePicker();
  s.paused = false;
  s.speed = 1;
  after();
}

/** 救济金遮罩上的两枚按钮（Batch 5 · B30）：领 → `takeLoan`；收摊 → `giveUp`（真的结束本局） */
function onLoan(what) {
  if (what === 'take') {
    const r = takeLoan(s);
    if (!r.ok) pushLog(s, r.why, 'bad');
  } else {
    giveUp(s);
  }
  after();
}

/**
 * 破产预警遮罩上的唯一一枚「知道了」（v11 · ③）。
 *
 * ⚠️ 点完**时钟仍然停着**（`s.paused` 保持真），并把速度压回 1x —— 预警的全部意义就是
 *    「让玩家有准备」；若在这里自动接着跑，尤其玩家原本开着 50x（7 个游戏日 ≈ 3 真实秒），
 *    等于白提醒一场。恢复由玩家自己点顶栏那枚「继续」—— 与「切页即暂停 ＋ 速度归 1x」同一口径。
 */
function onWarn() {
  s.pending = null;
  s.warnAt = null;
  s.paused = true;
  s.speed = 1;
  after();
}

/**
 * 打开日志浮层（⑤ · 方案 §20.2.1）。
 * ⚠️ 结束 / 待决时不弹（同 `onEx`）：那一刻遮罩已经替掉了界面，回看日志没有意义。
 * ⚠️ **打开即暂停 ＋ 速度归 1x，关闭后以 1x 续跑**（2026-09-29 用户拍板）：日志是给眼睛读的，
 *    50x 下开着面板读 30 条，行情早跑掉几十个游戏日。
 *    恢复走 `openLog` 传下去的回调 —— **只有日志这一个浮层会碰时钟**；
 *    选所 / 换所二次确认那些走 `closePicker()`，一行都不动速度。
 * ⚠️ **暂停态要记忆**（本轮 ① 修 bug）：玩家自己点过暂停、再打开日志回看，关掉后必须
 *    **仍然暂停**。原来 `onLogClose` 无条件 `s.paused = false`，等于把玩家的手动暂停静默解除。
 */
function onLogOpen() {
  if (s.over || s.pending) return;
  logWasPaused = s.paused;
  s.paused = true;
  s.speed = 1;
  openLog(s, onLogClose);
  after();
}

/** 日志浮层关闭后：**以 1x 续跑**（不恢复原来那一档 —— 与「切页即暂停 ＋ 速度归 1x」同一口径），
 *  但**打开前若是暂停态就保持暂停**（本轮 ①）。 */
function onLogClose() {
  if (s.over || s.pending) return;
  s.paused = logWasPaused;
  s.speed = 1;
  after();
}

/* ── 底部 Tab · 设置页（A6 · 方案 §6.3）─────────────────────────────
   设置从「顶栏一枚按钮 ＋ 弹层」改成**第三个页**；重开本局仍在页内，且必须**双重确认** ——
   它是全屏唯一会毁掉整局的操作，一键完成太危险。
   ⚠️ 页是**静态 DOM**（不参与每帧重绘），所以「已武装」这个状态只能存在这里，
      不能写进 `refs` —— 一重绘就被抹掉。 */

/**
 * 切页。口径（§6.3 已拍板；本轮 ⑦ 追加一条）：
 *   - 离开交易页（去资产 / 设置）⇒ **暂停 ＋ 速度归 1x**（P2：不留「切到设置页时间还在跑」的例外）
 *   - **切回交易页 ⇒ 自动 1x 续跑**（用户 2026-09-29 拍板）：去别的页只是看一眼，
 *     回来就该接着玩，不必再点一次「继续」。原来那条「切回仍然暂停」的手感是多余的。
 *   - 结束 / 救济金待决时不许切页（与顶栏那两枚按钮的 `lockedUI` 同一条判据；遮罩本来就盖住了 Tab 条）
 * ⚠️ 离开设置页要撤销「重开本局」的武装态：那个按钮是静态 DOM，不还原的话切回来它还是红的，
 *    一点就真重开（`cancelReset` 是超时 / 关面板 / 切页三条路共用的还原口）。
 * ⚠️ 暂停闸门（`dispatch` 顶部那条）仍然管用：切回交易页后**只有这一瞬间**是自动运行的，
 *    玩家随时可以点顶栏「暂停」把下单 / 换所挡住。
 */
function onTab(name) {
  if (s.over || s.pending) return;
  if (name === tab) return;
  runTabSwitch(name);
}

/* ── Tab 切页的 View Transition（m5 · 2026-10-05）────────────────────────
   把「旧页 → 新页」交给 **View Transition API** 做交叉淡化（`style.css` 给 `.page.on` 挂了
   `view-transition-name: page`，只淡这一块、不位移 —— 位移会让 K 线区尺寸不稳）。
   四条纪律：
     ① **只在动效档 = 全（`fx === 2`）且系统未开「减弱动态效果」时启用** —— 关档时连 API 都不调，
        退化路径就是原来的 `pageIn` 淡入（`.page.on` 的基类动画）；
     ② **同一时刻只跑一个过渡**（`vtBusy`）：连点 Tab 时后来者直接走同步分支，不做排队；
     ③ 状态写入（`tab` / `paused` / `speed` / `after()`）**整体搬进回调** —— View Transition 会先
        拍下「旧帧」、再执行回调，这正好满足 `draw()` 那条硬顺序：**先切页、再量尺寸**
        （隐藏页量出来是 0×0，顺序反了会画出一张空图）；
     ④ **`.vt` 一旦挂上就常驻、不摘**（修「切页闪一下」）—— 见 `runTabSwitch` 里那段说明；
        只有走到退化分支（动效档调低）时才摘掉它。
   ⚠️ `<html>.vt` 让 CSS 把 `pageIn` 关掉 —— 否则新页会在动画起点（opacity 0）被采样成空帧。
      `finished` 在「被跳过 / 被中止」时也会 settle，`finally` 里只清 `vtBusy`。 */
let vtBusy = false;

function vtEnabled() {
  if (fx !== 2 || vtBusy) return false;
  if (typeof document.startViewTransition !== 'function') return false;
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false; } catch { /* 拿不到媒体查询：当作未开启 */ }
  return true;
}

function runTabSwitch(name) {
  const root = document.documentElement;
  const go = () => {
    if (tab === 'settings') cancelReset();
    tab = name;
    s.paused = name !== 'trade';   // 切回交易页 ⇒ 自动续跑
    s.speed = 1;                   // ⚠️ 写进主状态（会落盘）：切一次页就丢掉 50x 的选择，这是拍板语义
    closePicker();
    after();
  };
  /* 退化分支：先把上一轮 VT 留下的 `.vt` 摘掉（仅当没有过渡在跑），让 pageIn 淡入照常播。 */
  if (!vtEnabled()) { if (!vtBusy) root.classList.remove('vt'); go(); return; }
  root.classList.add('vt');
  vtBusy = true;
  const t = document.startViewTransition(go);
  /* ⚠️ 收尾**只**清 `vtBusy`，**不摘 `.vt`** —— 这是修「切页闪一下」的关键。
     摘掉 `.vt` 会让新页 `.page.on` 的 `animation-name` 由 `none` 变回 `pageIn`，浏览器据此把它当成
     **动画重新开始**（从 opacity:0 再淡入一次），与刚结束的交叉淡化叠成两段式闪一下（用户反馈的现象）。
     让 `.vt` 常驻：之后每次切页都走 VT，pageIn 本就不该参与；等动效档被调低、走上面那条退化分支时再摘。
     `style.css` 把抑制写成 `#app:not(.rv) > .page.on`，所以回顾 / 档案两条整屏页仍保留自己的淡入。 */
  t.finished.finally(() => { vtBusy = false; });
}

/**
 * 音量档（T-2 · 2026-10-01，**取代**原来的「音效」开关键）：0 关 / 1 小 / 2 中 / 3 大。
 * 存进 `sound.js` 的 `degen_settings`（独立键，不进存档）；切到「关」那一刻不响（否则关掉还「嗒」一下）。
 * ⚠️ 档位高亮**不在这里手改**：设置页是常驻骨架，`update()` 每帧从 `view.vol` 同步
 *    （`after()` 会强制画一帧，所以反馈仍是即时的）。
 */
function onVol(v) {
  snd.setVol(v);
  if (v) snd.tap();
  after();
}

/**
 * 震动档（T-2）：0 关 / 1 弱 / 2 强，默认**强**。独立于音量 —— 关声也照样震。
 * 只在触屏设备上会建出这一行控件（见 `render.js`），这里不额外兜底。
 */
function onVib(v) {
  snd.setVib(v);
  if (v) snd.buzz('light');   // 当场试一下力度，玩家不用猜「弱」到底多弱
  after();
}

/**
 * 震动自检（2026-10-03）：**无视档位**直接震一条加长模式。
 * 为什么单独一枚键：档位再调都是几十毫秒，玩家在手机上摸不着时，分不清是「档位关着」、
 * 「马达不响」还是「这个浏览器根本不支持」。这枚键走一条加长三连震，一按就知道硬件响不响；
 * 顺便留一条日志，把「摸不着」最常见的两个原因直接说给玩家听。
 */
function onVibTest() {
  snd.buzzTest();
  pushLog(s, '震动自检 ｜ 没反应？多半是系统关了「触摸振动」，或浏览器不支持', 'info');
  after();
}

/**
 * 行情音开关（T-1 · P9）—— 与音量档同一个写法（独立键 ＋ 渲染层每帧同步高亮）。
 * 它**只管行情音**（涨 / 跌 / 放量 / 插针）：那是环境音，50x 下吵了可以只关它，
 * 事件音（爆仓 / 新闻 / 灾难 / 到账）照响 —— 那些被吞掉是不可接受的。
 */
function onMarketToggle() {
  const on = !snd.isMarketOn();
  snd.setMarketOn(on);
  if (on) snd.tap();
  after();
}

/* ── 涨跌色方向（B5 · 用户 2026-09-30 拍板）──────────────────────────────
   纯**显示偏好**，所以与音量 / 震动同一个存法：**独立 localStorage 键**（`degen_colors`），
   不进存档 —— 「重开本局」不该把玩家的习惯一起清掉。
   ⚠️ 不复用音频那个 `degen_settings`：那里的形状是音频自己的 `{ vol, market, vib }`，
      掺一个颜色进来会让两件事的迁移互相牵连（`readPrefs` 要认老格式），各存各的键最省心。
   实现只有两件事：① 在 `<html>` 上挂 / 摘 `.red-up`（`:root.red-up` 负责对调两枚语义色，
   全站颜色都从变量派生 ⇒ 一处切换、处处生效）；② 让 K 线的颜色缓存失效
   —— canvas 不认 `var()`，它是读一次就缓存的（`chart.theme()`）。
   默认**绿涨红跌**（国际惯例）；`true` = 已切到红涨绿跌。 */
const COLOR_KEY = 'degen_colors';
let redUp = (() => { try { return localStorage.getItem(COLOR_KEY) === 'red-up'; } catch { return false; } })();

function applyRedUp(v) {
  redUp = !!v;
  document.documentElement.classList.toggle('red-up', redUp);
  try { localStorage.setItem(COLOR_KEY, redUp ? 'red-up' : 'green-up'); } catch { /* 隐私模式：本次会话内有效即可 */ }
  resetTheme();
}

/** 涨跌色开关 —— 同音量：只翻偏好，按钮外观由 `update()` 每帧从 `view.redUp` 同步。 */
function onColorToggle() {
  applyRedUp(!redUp);
  snd.tap();
  after();
}

/* ── 动效强度（T-2 · 2026-10-01）──────────────────────────────────────
   纯**显示偏好**，与涨跌色同一个存法：独立 localStorage 键（`degen_fx`），不进存档
   —— 「重开本局」不该把玩家的习惯一起清掉。
   三档（0 关 / 1 减弱 / 2 全）挂在 `<html>` 的类上，由 `style.css` 的 `.fx-off` / `.fx-low`
   去压 transition / animation —— 压制规则只有一份（与 `prefers-reduced-motion` 那条同源）。
   默认「全」；系统若开了「减弱动态效果」，默认就落到「关」（玩家仍可到设置里改回来）。 */
const FX_KEY = 'degen_fx';
const FX_DEFAULT = (() => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 2; } catch { return 2; }
})();
let fx = (() => {
  try {
    const v = Number(localStorage.getItem(FX_KEY));
    return Number.isInteger(v) && v >= 0 && v <= 2 ? v : FX_DEFAULT;
  } catch { return FX_DEFAULT; }
})();

function applyFx(v) {
  fx = v;
  const r = document.documentElement;
  r.classList.toggle('fx-off', fx === 0);
  r.classList.toggle('fx-low', fx === 1);
  try { localStorage.setItem(FX_KEY, String(fx)); } catch { /* 隐私模式：本次会话内有效即可 */ }
}

/** 动效档 —— 同音量：只翻偏好，档位高亮由 `update()` 每帧从 `view.fx` 同步。 */
function onFx(v) {
  applyFx(v);
  snd.tap();
  after();
}

/**
 * 新手提示开关（v11 · ③）—— 与音量档同一个写法：只翻状态，按钮外观由 `update()` 每帧同步。
 * 它管**引导类**内容（破产预警遮罩等），**不管**开场叙事 —— 那个新老手都要看一遍。
 */
function onHintToggle() {
  s.hintOn = !s.hintOn;
  after();
}

function onClosePanel() {
  /* ⚠️ 现在只剩**上帝面板**用 `data-sclose`（设置已改成页，出口是底部 Tab）。
     顺手撤销重开的武装态：上帝面板在任意页都能开（连点标题），多这一句不亏。 */
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
  /* ⚠️ 「重开本局」＝ **重开这一局的那个年代**（M1）＋ **只清这一局落在的那个槽**（2026-10-01）。
     走 `startNewGame()` 这条统一的路（投年代信箱 ＋ 清对应槽 ＋ reload），另半边的档一个字不动。
     原来「经典全程重开完先回菜单」那条分叉一并取消：一是那条路上 reload 后 `load()` 缺省
     会掉进**挑战档**（普通槽刚被清空），反而把玩家带到另一局去；二是「重开本局」本来就该
     直接开这一局新的（开场白或直接开盘），弹回菜单等于让玩家再点一次。 */
  startNewGame(s.scen);
}

/** 开机面板上那枚「清除存档并重开」（`render.js` 的 `renderBoot`）—— 两个槽一起清。 */
function onWipe() {
  disableSave();
  for (const slot of SAVE_SLOTS) wipe(slot);
  maskReload();
}

function after() {
  save(s);
  dirty = false;      // 刚落过盘，10 秒定时器这一轮不必再存
  draw(true);
}

/* ───────────────────────────── 兜底 ───────────────────────────── */

window.addEventListener('error', e => {
  if (!refs) renderBoot('启动失败', e.error || e.message);
});

/* 开盘前（`refs` 还没挂上）的异步失败同样兜到开机面板：`boot()` 里那一串 `await`
   （读清单 / 懒加载行情 / 流动性）任一被拒，都不该变成一个白屏。 */
window.addEventListener('unhandledrejection', e => {
  if (!refs) renderBoot('启动失败', e.reason);
});

boot().catch(err => renderBoot('启动失败', err));
