/**
 * 入口：把「状态 / 行情 / 引擎 / 渲染」接起来
 * ===============================================================
 * 职责边界与参考项目一致：
 *   core/*  不知道有 UI 这回事
 *   ui/*    只负责画，以及把点击转成 action
 *   main.js 是唯一把两边连起来的地方（也是唯一允许读时钟的地方）
 */

import { GAME, COINS, HOUR_MS, cashCurAt, hasFinancingAt, maxLeverageAt } from './core/config.js';
import { createState, ensureBook, heldSyms, posOf, pushLog } from './core/state.js';
import { load, save, wipe, disableSave } from './core/save.js';
import { loadManifest, loadCoin, loadLiq, isLoaded, bindFactorSource, closeAt, candleAt, volumeAt } from './core/market.js';
import { createClock, chanOf, futuresAvailable, levKind, openTrade, closeTrade, otcUnlocked, otcOpenFor, switchExchange, timeOf, normalizeLeverage, markPrice, takeLoan, giveUp, advanceOneHour, bindLiquidateHook, buyUsdt, sampleEquity, placeOrder, cancelOrder, rewindTo, dailySigma } from './core/engine.js';
import { anchorAt } from './core/anchors.js';
import { RV_NODES, nodeAt, nextNodeAt, speedAt } from './core/review.js';
import { enableGod, factorFor } from './core/god.js';
import { fmtDate, fmtMoney } from './core/format.js';
import { canLiquidate, safetyOf } from './core/positions.js';
import {
  mount, update, renderOver, renderLoan, renderWarn, clearOver, renderBoot, hideBoot,
  pickExchange, confirmExchange, closePicker, openIntro, openMenu, openGod, showPage, openLog,
  renderReview, openNodeCard, openYearPick, openGuide, openOrder,
} from './ui/render.js';
import { bindActions, bindChart } from './ui/bind.js';
import { panBy, zoomBy, resetView, setMode, viewOf } from './ui/view.js';
import { resetTheme } from './ui/chart.js';
import * as snd from './ui/sound.js';

const root = document.getElementById('app');

/* ⚠️ `load()` 返回 null 就是**全新一局** —— 开场叙事弹窗只在这一次出现（Batch 4 · B19）。
   读档续玩（哪怕是暂停在 2015 年的档）不该再看一遍开场白。 */
const saved = load();
let s = saved || createState();
const isNewGame = !saved;

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

/* ── 历史回顾模式（需求 4 ·《主菜单与历史回顾模式方案》§3）─────────────────
   `rv` 非 null 就是「正处在回顾态」。**模块级变量、不进 `s`、不进存档**
   （与 `tab` / `godTaps` / `liqMark` 同一口径）：重开一局走 `location.reload()`，它自然归零 ——
   `STATE_VERSION` 因此**不动**（仍 11，方案 §6）。
   ⚠️ 回顾**有自己的一支时钟**（下面那三行 `rvTimer/rvLast/rvAcc`）：不能复用 `createClock` ——
      它闭包捕获 `s`，读的是 `s.paused` / `s.speed` / `s.over`，而回顾态一条都不该碰。
   `rv` = `{ i, sym, speed, paused, seen:Set<number>, log:Array }` */
let rv = null;
let rvTimer = 0;
let rvLast = 0;
let rvAcc = 0;

/* 上帝模式的隐藏入口（方案 §2.1）：**1.5 秒内连点顶栏「Degen」5 次**。
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

/* 「致命那一针」的一句短记忆（S3-附 · ROADMAP §19.6.3）：`{ sym, hour, k }`，**只记最近一次、覆盖式**。
   ⚠️ **不进存档**（拍板口径）：`save()` 是整对象序列化，写进 `s` 就等于落盘；它只活在渲染进程里，
      重开本局走 `location.reload()`，这个变量自然归零。由 `engine` 的注入式回调喂进来。 */
let liqMark = null;

/* 当前页（A6 · 方案 §6.3）—— `'trade'|'assets'|'settings'`。
   ⚠️ **模块级变量，不进 `s`**（§9 B6 拍板）：它和 `godTaps` / `resetArmed` 一样只是**界面位置**，
      与 `view.js` 的「看哪一段」同一口径 —— 进存档只会污染状态位，重开一局还得记得清。 */
let tab = 'trade';

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

/** 六步：交易所 → 币种条 → 行情区 → 下单区 → 持仓条 → 底部 Tab。目标从 `refs` 现取（不缓存节点）。 */
const GUIDE = [
  { at: () => refs.exBtn, text: '交易所。点它换所 —— 搬钱要等链上确认，路上还可能被拥堵拖住。' },
  { at: () => refs.symbols, text: '币种条。五个币按真实上线时间逐个解锁，点一下切换行情。' },
  { at: () => refs.chartWrap, text: '行情区。捏合放大能看到 30 秒级的细刻度，拖动可以回看历史。' },
  { at: () => refs.buyBtn, text: '下单区。先选金额与杠杆，再按「买入 / 做多」开仓。' },
  { at: () => refs.posbar, text: '持仓条。开仓后这里显示方向、未实现盈亏与保证金率。' },
  { at: () => refs.tabBtns.get('trade'), text: '底部三个页：交易 / 资产 / 设置。随时切回来看盘。' },
];

/* ───────────────────────────── 启动 ───────────────────────────── */

async function boot() {
  /* 涨跌色偏好**最先落**（B5）：`:root.red-up` 一挂上，连开机那句话的颜色都是对的 ——
     放到 `mount()` 之后也行，但那样第一次开机画面会闪一下默认色。 */
  applyRedUp(redUp);
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

  /* 价格位移层（方案 §2.6）：**唯一收口**在 `market.candleAt`。
     注入一个**逐根**系数，markPrice / 权益 / 强平价 / 资金费 / K 线图 / HUD 涨跌幅全部自动跟上。
     ⚠️ 难度在于它**不能**写成「一个全局常数」：一笔单只影响它之后的行情（`j < at ⇒ 1`），
        所以历史 K 线不会被重新标定，收益率会真的变 ⇒ σ 会变（见 `engine.invalidateSigma`）。
     ⚠️ 没有上帝位移也没有冲击池时 `factorFor` 恒返回 1，`candleAt` 走原路径 —— **逐位相同**。 */
  bindFactorSource((sym, j) => factorFor(s, sym, j));

  /* 「致命那一针」（S3-附）：同上 —— core 不认识 UI，由这里接线。爆仓发生时记下那一段 tick，
     渲染层在**细刻度档**把它折算成槽位画一枚浅红竖线（粗档不画）。 */
  bindLiquidateHook((sym, hour, k) => { liqMark = { sym, hour, k }; });

  refs = mount(root);
  hideBoot();

  // 数据到位后把杠杆夹到当前年份允许的范围内（读档时年份可能已经变了）
  normalizeLeverage(s);
  /* 资金曲线（v13 · 方案 §4）的**第 0 天**：采样写在小时间隔里（`advanceOneHour`），
     不先在开盘这一刻补一个点，玩家头 24 个游戏小时打开资产页会看到一张空图。 */
  sampleEquity(s);

  /* 新闻窗口内**强制一帧**（P2-C）：一次 `step()` 在 50x 下最多能推进 50 个游戏小时，
     而渲染被节流到 80ms —— 不强制就会「窗口整个落在两帧之间」，玩家一次都看不到。
     新闻是 `s.i` 的纯函数，所以这里只做一件事：窗口里别让节流把这一帧吞掉。 */
  clock = createClock(s, { onFrame: () => draw(!!anchorAt(s.i)) });
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
  /* 回顾页那块 K 线的同一套手势（方案 §3.2「复用 `simulate.js` / `view.js`」）——
     唯一区别是它推的是 `rv.i` 而不是 `s.i`（回顾的「当前」在 `rv` 里）。 */
  bindChart(refs.rvCanvas, {
    pan: (dx, dy) => { if (!rv) return; panBy(rv.sym, dx, dy, rv.i, chartW()); draw(true); },
    zoom: f => { if (!rv) return; zoomBy(rv.sym, f, rv.i, chartW()); draw(true); },
    reset: () => { if (!rv) return; snd.tap(); resetView(rv.sym); draw(true); },
  });
  setInterval(() => save(s), 10000);
  window.addEventListener('beforeunload', () => save(s));

  /* 主菜单（需求 4 · 方案 §2）：**一律先弹它**，三个入口决定后续走向 ——
       开始游戏 → （有档先二次确认）开新局 → 开场叙事
       继续游戏 → 直接 `clock.start()`（读档续玩，不弹开场白）
       历史回顾 → 只读回顾模式
     ⚠️ 菜单期间**时钟不启动**（与开场叙事同一条）：玩家选完才真正开盘，
        否则停在这一屏时行情已经自己走了几十根。
     ⚠️ 「继续游戏」只在**这一局确实读到档**时出现（`isNewGame` 的反面）。 */
  openMenu({ canContinue: !isNewGame });
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

/** K 线区的 CSS 宽度。手势换算「一像素 = 多少根」要用**同一份**，所以单独留一个入口。
 *  ⚠️ 回顾页有自己那一块 K 线区（`rvWrap`）—— 两者可见性互斥，量哪个由 `rv` 决定。 */
const chartW = () => {
  const node = rv ? refs.rvWrap : refs.chartWrap;
  return Math.max(1, Math.round(node.getBoundingClientRect().width));
};

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
 *    K 线、杠杆档全空）。注意 `bindActions` 在 `draw()` 之后才挂，所以此时点击
 *    反而正常 —— 按钮一点就补上第一帧，掩盖了「开局一片空白」这个现象。
 */
let lastDraw = -Infinity;
/* ⚠️ 起手取 `!!s.over`：读档读到一个**已经结束**的档时，不该在开屏第一帧补响一声爆仓 / 结算。 */
let overDrawn = !!s.over;
/* **待决遮罩**（借贷 `'loan'` / 破产预警 `'warn'`）画过没 —— 与 `overDrawn` 同一个理由：置真
   `s.paused` 的那一拍之后不会再有 `onFrame`，那一帧若被 80ms 节流吞掉，遮罩就永远出不来。
   ⚠️ 变量按**真值**记（两种遮罩共用），具体画哪一个仍按 `s.pending` 的**值**分派。 */
let pendingDrawn = !!s.pending;

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
 * ⚠️ 判据的坑（§2.3 点名的那个）：`text.includes('归零')` 会**同时命中「账户归零 ｜ 可借 …」**
 *    （`engine.js` 破产待决），那是玩家破产、不是交易所灾难。所以必须匹配 `${ex.name} 归零`
 *    这个形态（**前面有一个空格**）—— 交易所塌方的日志正是这么写的。
 * ⚠️ `限价成交失败 …` 也带「限价成交」四个字，`fill` 必须排掉它。
 * ⚠️ 「上线」用的是 `'上线 ｜'`（带上分隔符）—— 裸「上线」会命中「XRP 还没上线」那条失败日志。
 *
 * **资金费 / 借贷利息不再出声**（T-1 删除项）：它每 8 小时结算一次，50x 下一局上千次，
 * 而玩家的决策早就在下单时做完了 —— 结算照旧写日志，只是沉默。
 */
function eventSound(last) {
  const text = last.text;
  if (text.includes('推高拥堵')) return snd.pulse();
  if (last.kind === 'news') return snd.news();
  if (text.includes('被盗削减') || / 归零/.test(text)) return snd.crash();
  if (text.includes('限价成交') && !text.includes('失败')) return snd.fill();
  if (text.includes('上线 ｜') || text.includes('恢复交易') || text.startsWith('到账')) return snd.notice();
  if (text.includes('停机维护') || text.includes('借款还剩') || text.includes('借款明天到期')) return snd.warn();
}

/**
 * 行情音（T-1 · §2.2 ②）—— **不入日志**，直接读 K 线，每帧一次。
 * 为什么不能写日志：50x 下一局会灌出几万条，把日志条和浮层一起冲垮。
 *
 * 三道闸（§2.5）：① 优先级 `spike` > `surge` > `tick`（同一帧同币只发一声）
 * ② 同种音节流窗（在 `sound.js` 里，墙钟 120ms）③ 范围 ＝ **当前币 ＋ 持仓币**。
 *
 * ⚠️ 只判**当前那一根**，不补算被跳过的小时：标签页被挂起再切回来时 `s.i` 可能一次跳几百根，
 *    逐根补算会瞬间炸出一串音。首帧只记锚点（同 `lastLogKey` 那套）。
 * ⚠️ **取不到价就闭嘴**：`candleAt` / `closeAt` 在该币**首根真小时线之前**返回 `null`
 *    （只有 BTC 有 2012 回溯段）。拿不齐「当根 ＋ 前一根」就直接跳过 ——
 *    不许用兜底价算涨跌幅，那会凭空造出一个行情音。
 */
function marketSounds(s) {
  if (lastMarketI === null) { lastMarketI = s.i; return; }   // 首帧只记锚点
  if (s.i === lastMarketI || s.i <= 0) return;
  lastMarketI = s.i;

  for (const sym of new Set([s.sym, ...heldSyms(s)])) {
    const cur = candleAt(sym, s.i);
    const prev = closeAt(sym, s.i - 1);
    if (!cur || !(prev > 0) || !(cur.c > 0)) continue;
    const sigma = dailySigma(sym, s.i);
    if (!(sigma > 0)) continue;
    const unit = sigma / Math.sqrt(24);

    /* ① **插针优先**（§2.2）：一根大阴线既跌又插针，不该叠两声 ——
       插针更紧急，因为强平看的是**最低价**（`l`），不是收盘价。 */
    if ((cur.h - cur.l) / cur.c >= K_AMP * unit) { snd.spike(); continue; }
    /* 成交量那一项不用 θ：直接比**当日均值**（份额 ≥ 3/24），与量柱标尺的既有口径一致 */
    if (volumeAt(sym, s.i) >= 3 / 24) { snd.surge(); continue; }
    const d = cur.c / prev - 1;
    if (d >= K_SIGMA * unit) snd.tickUp();
    else if (d <= -K_SIGMA * unit) snd.tickDown();
  }
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
     ⚠️ 不可强平的仓位（现货 1x）没有维持保证金率这一说，跳过 —— 判据统一走 `canLiquidate`
        （v9 · §15.4：现货带杠杆后 1x 以外也能强平，`isSpot` 已经不回答这个问题）。 */
  for (const sym of heldSyms(s)) {
    const pos = s.positions[sym];
    if (!canLiquidate(pos)) { warnedSyms.delete(sym); continue; }
    const mark = markPrice(s, sym);
    const safe = mark == null ? 1 : safetyOf(pos, mark);
    if (safe <= 0.2) {
      if (!warnedSyms.has(sym)) { warnedSyms.add(sym); snd.warn(); }
    } else {
      warnedSyms.delete(sym);
    }
  }

  marketSounds(s);
}

function draw(force = false) {
  /* 回顾态没有「结束 / 待决遮罩」这回事（回顾不判破产、也没有账户）⇒ 那两个强制帧的判据只在正常玩法下算 */
  if (!rv && ((s.over && !overDrawn) || (s.pending && !pendingDrawn))) force = true;
  const now = performance.now();
  if (!force && now - lastDraw < 80) return;
  lastDraw = now;

  if (!refs) return;
  /* ⚠️ **先切页，再量尺寸**（A6 · 方案 §6）：隐藏的 `.trade-page` 是 `display:none`，
     量出来是 0×0；顺序反了的话第一帧拿到的是上一页的尺寸（切回交易页就会画成一张空图，
     而且暂停态下**不会再有任何一帧**把它救回来）。 */
  showPage(refs, rv ? 'review' : tab);
  /* 回顾页量的是它自己那块 K 线区（两页的 DOM 各有一套，方案 §3.2） */
  const rect = (rv ? refs.rvWrap : refs.chartWrap).getBoundingClientRect();
  /* `liq`：「致命那一针」的短记忆（S3-附）—— 渲染层只在它属于当前币、且视野处在细刻度档时才画。
     回顾没有爆仓这回事 ⇒ 恒 null。 */
  const view = {
    chartW: Math.max(1, Math.round(rect.width)),
    chartH: Math.max(1, Math.round(rect.height - 2)),
    liq: rv ? null : liqMark,
    /* 当前页：K 线只在交易页画（另两页没有 K 线） */
    tab,
    /* 音效偏好归 `sound.js` 管，不进主状态 —— 设置页那两个开关的文案由渲染层每帧从这里取 */
    muted: snd.isMuted(),
    marketSound: snd.isMarketOn(),
    /* 涨跌色偏好（B5）：同上，归那个独立 localStorage 键管 */
    redUp,
    /* 新手分步引导正在走（本轮 ①/F）—— 引导期间 `s.paused` 恒为真，但**界面不该装成「暂停」**：
       它正高亮着「买入」按钮教玩家怎么用，把那一枚画成禁用灰会自相矛盾 ⇒ 渲染层靠这个豁免。
       （与 `tab` 同一类：纯界面状态，不进 `s`。） */
    guide: guideStep != null,
  };

  try {
    /* 回顾态走**另一条渲染线**：它只读 `rv`（模块级），一个字都不写 `s`，也绝不碰那几张遮罩 */
    if (rv) { renderReview(refs, rv, view); return; }
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

  /* 通用轻点反馈（Batch 4 · B20）—— 除了**成交 / 重开**这两类有专属音的动作，其余键都响这一声。
     逻辑：一次点击最多响一次，任何时刻都不会叠。 */
  if (d.act !== 'long' && d.act !== 'short' && d.act !== 'close'
    && d.buy === undefined && d.sell === undefined && d.reset === undefined
    && d.intro === undefined && d.order === undefined) snd.tap();   // 开场两枚键已有专属的起手音（`snd.begin`），不叠轻点声

  /* ── 暂停闸门（本轮 ① · 操作逻辑审计）──────────────────────────────────
     **暂停时必须被拦住的只有「会动钱」的动作**：下单（`buy`/`sell`/`long`/`short`）、
     平仓（`close`）、换所（`ex` 弹层 ＋ `exok` 二次确认）、盘口 ⇄ OTC 切换（`chan`）、
     **买 U（`buyu`）**。
     其余一律**照常可用**（用户 2026-09-29 拍板）：杠杆档 / 金额档 / 现货合约 / 切币 /
     粒度 / 切页 / 日志浮层 / 设置页（音效·新手提示·重开）/ 上帝面板 / 暂停键本身。
     理由：那些只改「下一单的参数」，此时既没有行情在走、也没有一笔单会成交 ——
     拦它们只会让玩家以为界面坏了。

     ⚠️ **不能**写成 dispatch 顶部的 `if (s.paused) return`：`onTab` 是「切页即暂停」，
        一刀切会把设置页的音效 / 订单冲击 / 重开、以及三页常驻的暂停键一起冻死。
     ⚠️ 回顾态走自己的 `rv.paused`，且那一屏不碰账户 ⇒ 这里只在正常玩法下生效（`!rv`）。
     ⚠️ 给一条日志而不是静默吞掉：玩家按了键没反应时，「为什么」比「没反应」重要。 */
  if (!rv && s.paused && (d.buy !== undefined || d.sell !== undefined
    || d.act === 'long' || d.act === 'short' || d.act === 'close'
    || d.ex !== undefined || d.exok !== undefined || d.chan !== undefined || d.buyu !== undefined
    /* 挂单同样是「会动钱」：挂下去就把保证金冻结走，撤单则把钱退回来（C8-B2 · §33.5）。 */
    || d.order !== undefined)) {
    pushLog(s, '已暂停 ｜ 先点顶栏「继续」再进行交易', 'info');
    after();
    return;
  }

  /* 新手分步引导的「下一步」（本轮 ④）：只在引导期间存在，值固定 `'next'`。
     ⚠️ 它**不能**被上面那条暂停闸门拦下 —— 引导期间 `s.paused` 恒为真，而它正是走完引导的唯一出口。 */
  if (d.guide !== undefined) return nextGuide();

  /* 主菜单三入口（需求 4 · 方案 §2）：`start` / `continue` / `review`。 */
  if (d.menu !== undefined) return onMenu(d.menu, node);
  /* 回顾页的全部动作（需求 4 · 方案 §3）：值即子命令，见 `onReview`。 */
  if (d.review !== undefined) return onReview(d.review);
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
  if (d.snd !== undefined) return onSoundToggle();
  if (d.market !== undefined) return onMarketToggle();
  if (d.colors !== undefined) return onColorToggle();
  if (d.reset !== undefined) return onReset(node);
  if (d.sclose !== undefined) return onClosePanel();

  /* ── 上帝模式 ＋ 订单冲击（隐藏入口 · 方案 §2）──
     `god` 是标题上的连点入口，「订单冲击」开关在**设置页**里，其余三枚在上帝面板里（`data-god*`）。
     ⚠️ 上帝模式**只有「跳日期 / 填资金 / 关掉」三件事**（2026-09-29 瘦身）：原来那两套价格能力
        （倍率 `godmult`、手动砸盘 `godscale` / 复位 `godreset`）已整体删除。 */
  if (d.god !== undefined) return onGodTap();
  if (d.impact !== undefined) return onImpactToggle();
  if (d.godcash !== undefined || d.godyear !== undefined || d.godmon !== undefined
    || d.godday !== undefined || d.godgo !== undefined || d.godoff !== undefined) {
    /* 这几枚只可能出现在上帝面板里，而面板只在 `s.god` 非空时打开。这一行是**状态机不靠 DOM 兜底**：
       万一面板被别的路径留下来（比如读到一份 `god: null` 的档），这里不能抛异常。 */
    if (!s.god) return;
    if (d.godcash !== undefined) return onGodCash(node);
    if (d.godyear !== undefined) return onGodPick('y', Number(d.godyear));
    if (d.godmon !== undefined) return onGodPick('m', Number(d.godmon));
    if (d.godday !== undefined) return onGodPick('d', Number(d.godday));
    if (d.godgo !== undefined) return onGodGo();
    return onGodOff();
  }

  if (d.sym !== undefined) return onSym(d.sym);
  if (d.chan !== undefined) return onChan();
  /* 限价挂单（C8-B2 · §33.5 ①）：值即子命令 —— `toggle`（二态键）或 `方向:偏离档`（浮层八枚）。 */
  if (d.order !== undefined) return onOrder(d.order);
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
    if (!r.ok) { pushLog(s, r.why, 'bad'); snd.tap(); } else snd.notice();
    after();
    return;
  }
  if (d.lev !== undefined) {
    /* OTC 通道只有现货 ⇒ 杠杆被锁在 1x。这里只给一条日志、**不改 s.lev** ——
       他切回盘口时那个杠杆还在，不必重新点一遍（Batch 5 的 `数据不擅自改` 口径）。 */
    if (chanOf(s) === 'otc') { pushLog(s, 'OTC 通道只有现货，杠杆固定 1x', 'info'); after(); return; }
    /* 该所此刻没有融资 ⇒ 杠杆行是**置灰不可点**的（v10 · ②）。它挂的是 `aria-disabled` 而不是
       `disabled`，正是为了能让这一下走到这里 —— 给一句「暂不可用 ｜ 为什么」，而不是毫无反应。
       判据与渲染层、与 `engine.openTrade` 同源（`hasFinancingAt`），三处不各算一遍。 */
    if (levKind(s) === 'spot' && !hasFinancingAt(timeOf(s), s.ex)) {
      pushLog(s, '杠杆 暂不可用 ｜ 该所此刻没有融资业务', 'info');
      after();
      return;
    }
    const want = Number(d.lev);
    /* 上限取**本单走的那张表**（§15.1）—— 现货档位与合约档位是两套数，不能拿一张去夹另一张。 */
    s.lev = Math.max(1, Math.min(want, maxLeverageAt(timeOf(s), s.ex, levKind(s))));
    after();
    return;
  }
  if (d.speed !== undefined) { s.speed = Number(d.speed); after(); return; }
  /* 模式切换（U1 · ROADMAP §21.4；v9 · §15.6 N3）：现货 ⇄ 合约。它决定的是**整张杠杆表**
     与**整行动作键的字面**（现货＝买入/卖出、合约＝做多/做空/平仓），见 `engine.spotOf` / `levKind`。
     ⚠️ `data-mode2`（操作区那枚模式键），不是 `data-mode`（那是 K 线粒度小字）。
     ⚠️ 该所此刻**没有合约**时这枚键根本不显示，但**状态机不靠 DOM 兜底**（同 `onChan`）：
        少了这一行，`s.mode` 就会切到一张不存在的杠杆表上。 */
  if (d.mode2 !== undefined) {
    if (!futuresAvailable(s)) return;
    s.mode = s.mode === 'spot' ? 'fut' : 'spot';
    /* 切模式后重新夹取杠杆：两张表的上限不同（如 Binance 现货 3x / 合约 125x），
       不夹的话从合约切回现货会带着一个现货拿不到的档位（`engine.normalizeLeverage` 顺带兜住模式）。 */
    normalizeLeverage(s);
    after();
    return;
  }
  /* 粒度切换（Batch 3 · B12）：小字上写的是**当前**粒度，点一下切到另一种。
     ⚠️ **非 1h 的一律切回 1h**（S2）：细刻度档（`1t`）没有自己的按钮 —— 它靠**放大**进入
        （`view.zoomBy`），退出有两条路：缩回小时档，或点这枚小字直接回 1h。
     只动视野，不动玩法 —— `s.i` 永远还是「第几根小时 K」。 */
  if (d.mode !== undefined) {
    /* ⚠️ 回顾页那枚粒度小字走 `rv.i` / `rv.sym` —— 回顾的「现在」不在 `s` 里（方案 §3.3）。 */
    if (rv) {
      setMode(rv.sym, viewOf(rv.sym).mode === '1h' ? '1d' : '1h', rv.i, chartW());
      draw(true);
      return;
    }
    setMode(s.sym, viewOf(s.sym).mode === '1h' ? '1d' : '1h', s.i, chartW());
    after();
    return;
  }
  if (d.pause !== undefined) { if (!s.over) s.paused = !s.paused; after(); return; }
  /* 结束遮罩上的「重新开始」：本局都已经结束了，没有必要再问一遍（Batch 4 起彻底直通）。 */
  if (d.restart !== undefined) return doRestart();
  if (d.wipe !== undefined) return onWipe();

  /* 现货模式那两枚动作键（v9 · §15.3 N4）：**买入＝借 U 做多、卖出＝借币做空**。
     ⚠️ 反向那一枚**自己承担平仓**（现货模式没有独立的「平仓」键）：
          空仓 ⇒ 开仓；**同向 ⇒ 加仓**（v13 · B4，`openTrade` 内部并进那条仓位）；
          反向 ⇒ 平掉它。
     ⚠️ 合约模式下这两枚不显示，同样挡一次 —— 否则会从一个不该存在的入口开出一张合约单。 */
  if (d.buy !== undefined || d.sell !== undefined) {
    if (s.mode === 'fut' && futuresAvailable(s)) return;
    const side = d.buy !== undefined ? 'long' : 'short';
    const pos = posOf(s, s.sym);
    /* ⚠️ **融资判据必须排在「有没有仓位」之后**（2026-09-29 修 bug）：手上压着一张多仓时，
       「卖出」是**平多**，平仓不需要借币 ⇒ 与融资无关。原来这条写在 `posOf` **之前**，
       于是在 Mt.Gox（现货只有 1x、无融资）买进现货之后**再也卖不出去**，还误报
       「现货做空 暂不可用 ｜ 该所此刻没有融资业务」——那是开空才需要的条件。
       现在只拦「**空仓开空**」这一种，判据与渲染层 `sellOff = !dir && !canLev` 完全一致。
       `engine.openTrade` 那边本来就是对的（先 `posOf` 再判融资），这里补的是主入口。 */
    if (!pos && side === 'short' && levKind(s) === 'spot' && !hasFinancingAt(timeOf(s), s.ex)) {
      pushLog(s, '现货做空 暂不可用 ｜ 该所此刻没有融资业务', 'info');
      after();
      return;
    }
    if (!pos || pos.side === side) {
      const r = openTrade(s, side, s.sizeFrac);
      if (!r.ok) pushLog(s, r.why, 'bad');
      else snd.open();
    } else {
      /* `why` 写玩家按下的那枚键：平多＝卖出（卖出手上的币）、平空＝买回（买回借出的币） */
      const r = closeTrade(s, side === 'long' ? '买回' : '卖出');
      if (!r.ok && r.why !== 'liquidated') { pushLog(s, r.why, 'bad'); snd.tap(); }
      else snd.close();
    }
    after();
    return;
  }
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
 * ⚠️ `otcOpenFor` 也要挡（P2-B 修订）：禁用态的键本来点不出事件，但**状态机不能只靠 DOM 兜底** ——
 *    少了这一行，一旦那个币还没开通 OTC，`s.chan` 会留下一个 `chanOf` 永远不认的 `'otc'`。
 */
function onChan() {
  if (!otcUnlocked(s) || !otcOpenFor(s)) return;
  s.chan = chanOf(s) === 'otc' ? 'book' : 'otc';
  /* 切到 OTC 就把杠杆归 1：OTC 只有现货，让操作区当场显示 1x 比事后再拒绝更直白。
     切回盘口**不还原**原来的杠杆 —— 那需要多存一个字段，而 `1x` 是个安全的默认值。 */
  if (s.chan === 'otc') s.lev = 1;
  after();
}

/* ── 限价挂单（C8-B2 · ROADMAP §33.5 ①）────────────────────────────────
   一枚二态键走两个值，加上浮层那八枚「方向:偏离档」：
     · `toggle`（操作区的键）：当前币**有**挂单 ⇒ 撤单；**没有** ⇒ 打开浮层选方向与档位。
     · `long:0.01` / `short:0.10`（浮层）：直接落一张单。
   ⚠️ 音效在这一支里**自己发**（`dispatch` 顶部的轻点声已把 `order` 排除，理由同买入/卖出）：
      撤单是「收回来」走 `close` 音，落单走 `open` 音，其余（开/关浮层、失败）落 `tap` 音。 */
function onOrder(v) {
  if (v === 'toggle') {
    if (s.orders[s.sym]) {
      const r = cancelOrder(s, s.sym);
      if (!r.ok) { pushLog(s, r.why, 'bad'); snd.tap(); } else snd.close();
      after();
      return;
    }
    snd.tap();
    openOrder(s, refs.orderBtn);
    return;
  }
  /* 浮层里那八枚：`方向:偏离档`（如 `long:0.05`） */
  const [side, dev] = String(v).split(':');
  const r = placeOrder(s, side, Number(dev));
  if (!r.ok) { pushLog(s, r.why, 'bad'); snd.tap(); } else snd.open();
  closePicker();
  after();
}

/* ── 上帝模式 ＋ 订单冲击（隐藏入口 · 方案 §2）─────────────────────
   一个隐藏入口（连点标题）、一个玩法开关（设置面板）、一张面板（资金 / 跳日期 / 关闭）。
   ⚠️ 面板是**静态 DOM**，所以「填入」要从它内部读输入框的值 —— 输入框不能挂 `data-*`
      （`bind.js` 会 `preventDefault` 掉 `pointerdown`，挂上去就打不了字）。
      ⚠️ 跳日期那三排档位是**按钮**、不是输入框，照旧走 `data-godyear` / `godmon` / `godday`。 */

/** 连点计数：**1.5 秒内 5 次**才触发；间隔超时就重新从 1 数起 */
function onGodTap() {
  const now = performance.now();
  godTaps = now - godTapAt > GOD_TAP_MS ? 1 : godTaps + 1;
  godTapAt = now;
  if (godTaps < GOD_TAPS) return;
  godTaps = 0;
  /* 本局已结束 / 正停在借贷遮罩上：时间不再前进，开这张面板没有意义（而且 `s.over` 下评论区那些
     动作本来就被别处挡掉了，这里先拦一次更干净）。 */
  if (s.over || s.pending) return;
  enableGod(s);
  godSel = null;                        // 重新打开 ⇒ 选择器回到「当前日期」起手
  showGod();
  after();
}

/** 面板的统一出口 —— 每次都把暂存的选择器带上，点年 / 月 / 日之后才不会跳回「当前日期」 */
const showGod = () => openGod(s, godSel);

/**
 * 订单冲击开关（方案 §2.7）—— **玩法开关**，落在主状态 `s.impactOn`（不是 `degen_settings`）。
 * ⚠️ 关掉只是「不再产生新的冲击」，**已落地的行情位移不还原**（那是已发生的历史）。
 * ⚠️ 与音效开关同理：按钮外观由 `update()` 同步，不在这里手改节点。
 */
function onImpactToggle() {
  s.impactOn = !s.impactOn;
  after();
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
  /* 归零后的**负账本一并清零**（2026-09-30 裁决）：逐仓的浮亏与「1x 现货空单」的亏损是
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
 *        （Mt.Gox 归零、币解锁、杠杆阶梯、借款到期、强平、资金费、转账到账），
 *        而且玩家的持仓必须**真的走过**这段时间。
 * 向后 ⇒ 倒放没有定义（行情与事件都是单向累积的），改走 `godRewind`：
 *        保留资金、清空持仓与挂单，直接把时钟落到那一刻。
 *
 * @param {number} target 目标小时序号（未夹取）
 * @param {string} label  日志里的日期文案（`fmtDate` 的结果）
 */
function godJump(target, label) {
  const to = Math.min(Math.max(target, 0), GAME.candles - 1);
  if (to === s.i) {
    pushLog(s, `已经在这一刻：${label}`, 'info');
    showGod();
    after();
    return;
  }
  if (to < s.i) return godRewind(to, label);

  /* 同步循环 ⇒ `createClock` 的 `setInterval` 不可能插进来。三种情况都要停：
       ① 到目标日期  ② 到 2024-12-31 收盘（`s.over`）
       ③ **中途账户归零、弹出借贷遮罩**（`s.pending`）—— 少了第三个判据这里会**死循环**：
          `advanceOneHour` 在 `pending` 下会立刻 return（`s.i` 永远不前进），
          而 `!s.over` 一直为真，浏览器就卡死了（2026-09-29 离线断言逮到）。
     ⚠️ 时长实测：2013-01 → 2024-12 全程 10.5 万小时 ≈ 0.4 秒（长局抽检 2026-09-30），
        所以这里不需要分片或进度提示。 */
  while (s.i < to && !s.over && !s.pending) advanceOneHour(s);
  /* 停在借贷遮罩上时**不要**再开上帝面板 —— `draw()` 刚把遮罩铺上，压一张面板上去只会打架 */
  if (!s.over && !s.pending) showGod();
  after();
}

/**
 * **回到过去**（2026-09-30 裁决）—— 保留资金、清空持仓与挂单。
 *
 * 状态变换整块在 `engine.rewindTo`（core 侧，可离线断言）；这里只做 UI 该做的三件事：
 * 记一条日志、重开面板、必要时把回落到的币的行情拉进来。
 */
function godRewind(to, label) {
  const cash = rewindTo(s, to);
  pushLog(s, `回到 ${label} ｜ 资金已保留（${fmtMoney(cash)}），持仓与挂单已清空`, 'ok');
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

/* ── 主菜单（需求 4 · 方案 §2）────────────────────────────────────
   三个入口。菜单期间时钟是停的（见 `boot`），选完才真正开盘。

   · `continue`：读档续玩 —— 直接开盘，**不弹开场白**（世界观只在开新局时讲一遍）。
   · `start`   ：无档 ⇒ 直接转开场叙事；**有档 ⇒ 先「武装」**（按钮变红，3 秒内再点一次才重开），
                 走既有 `onWipe()`（`disableSave` ＋ `wipe` ＋ reload）——**不新写重开逻辑**。
   · `review`  ：只读回顾模式（`enterReview`）。 */
function onMenu(kind, node) {
  if (kind === 'continue') {
    closePicker();
    clock.start();
    after();
    return;
  }
  if (kind === 'review') return enterReview();
  /* kind === 'start' */
  if (isNewGame) {                 // 无档：直接进开场叙事（新手 / 老手）
    closePicker();
    openIntro();
    return;
  }
  /* 有档：双重确认（与设置页那套 `onReset` 同一手法，状态各自独立） */
  if (!menuArmed) {
    menuArmed = true;
    menuNode = node;
    node.textContent = '确认重开';
    node.classList.add('warn');
    clearTimeout(menuTimer);
    menuTimer = setTimeout(cancelMenuArm, 3000);
    return;
  }
  cancelMenuArm();
  onWipe();                        // disableSave ＋ wipe ＋ reload ⇒ 回来后是无档的新局
}

/** 撤销主菜单的武装：超时或重开前都要还原按钮，免得下次开局还是红的 */
function cancelMenuArm() {
  clearTimeout(menuTimer);
  menuArmed = false;
  if (menuNode) {
    menuNode.textContent = '开始游戏';
    menuNode.classList.remove('warn');
    menuNode = null;
  }
}

/* ── 历史回顾（需求 4 · 方案 §3）────────────────────────────────────
   独立回顾页 ＋ 复用 `market.js` / `chart.js`（拍板 4）。这一整块与 `s` **零耦合**：
   不写状态、不写存档、不判破产，退出后回到主菜单，玩家那一局一根 K 线都没动过。 */

/** 进回顾：从 2013-01-01 00:00 起，100x 巡航 */
function enterReview() {
  closePicker();
  clock.stop();                                  // 双保险：主菜单期间它本来就没启动
  rv = { i: 0, sym: 'BTC', speed: 100, paused: false, seen: new Set(), log: [], auto: false };
  rvAcc = 0;
  resetView('BTC');                              // 视野回默认（上次回顾留下的姿势不带到这一次）
  pushRv('开盘 · 2013 年 1 月，门头沟', 'info', 0);
  syncRvMode();                                  // ⑧：起手就是 1 日线（巡航段看日线才看得完 12 年）
  rvStart();
  draw(true);
  if (!isLoaded('BTC')) ensureCoin('BTC').then(() => draw(true));
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
 * ⚠️ `setMode` 幂等（档位没变直接 return），所以每一拍都调一次是**零成本**的；
 *    也正因为这样，「卡一关掉、速度回到 100x」会自动切回日线，不必另写一支。
 * ⚠️ 判据走 `rvSeen()`（本轮 ②）：开关打开时全部算「已过」⇒ 全程 100x ＋ 日线。
 */
function syncRvMode() {
  if (!rv) return;
  setMode(rv.sym, speedAt(rv.i, rvSeen()) > 24 ? '1d' : '1h', rv.i, chartW());
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
      resetView(sym);
      if (!isLoaded(sym)) ensureCoin(sym).then(() => draw(true));
    }
  }
  syncRvMode();
}

/** 退出回顾：停掉那支专属时钟，回主菜单（方案 §2：退出后回到主菜单） */
function exitReview() {
  rvStop();
  rv = null;
  rvAcc = 0;
  draw(true);                                    // `rv` 归 nil ⇒ `showPage` 自动切回交易页
  openMenu({ canContinue: !isNewGame });
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
      reviewFocus(node);        // ⑨：事件讲的是别的币就先切过去 —— 针在它自己的图上
      pushRv(node.title, 'ok', node.at);
      openNodeCard(node);
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
    syncRvMode();                                  // 开 ⇒ 全程日线；关 ⇒ 回到按节点减速
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
  resetView(rv.sym);                               // 跳完视野跟到新的「当前」
  rv.log.length = 0;                               // ③ 清空（就地清，别换数组 —— 渲染层持有的就是它）
  pushRv(`跳到 ${y} 年`, 'info', rv.i);
  syncRvMode();                                    // ⑧：跳回巡航段 ⇒ 粒度跟着回日线
  draw(true);
}

/** 回顾里切币（拍板 2：可切币）—— 那个币此刻还没上线就点不动 */
function switchRvSym(sym) {
  if (rv.sym === sym) return;
  const c = COINS.find(x => x.sym === sym);
  if (c && GAME.start + rv.i * HOUR_MS < c.unlock) return;
  rv.sym = sym;
  resetView(sym);
  syncRvMode();                                    // ⑧：切币不改变速度，但档位要按新币的边界重新夹一次
  draw(true);
  if (!isLoaded(sym)) ensureCoin(sym).then(() => draw(true));
}

/* ── 开场叙事（Batch 4 · B19）─────────────────────────────────────
   弹窗期间时钟是停的（见 `boot`），点了「我是新手 / 我是老手」才真正开盘并放一声起手音。
   `kind`（v11 · ③）只决定 `s.hintOn`：新手 ⇒ 开提示，老手 ⇒ 关提示；叙事文案两者一致。 */
function onIntro(kind) {
  closePicker();
  s.hintOn = kind !== 'old';
  /* 开局写一条**真实发生的事**（Batch 5 · B24）：日志条原来是写死的「等待开盘…」兜底，
     可此刻行情其实已经在跑 —— 文案与实况自相矛盾。这条日志把空态填掉，
     时间戳取 `s.i = 0`（`pushLog` 自己取），语义正确。读档续玩不补（与开场弹窗同一判据）。 */
  pushLog(s, '开盘 · 2013 年 1 月，门头沟', 'info');
  clock.start();
  snd.begin();
  /* 新手 ＋ 新局 ⇒ 接一段分步引导（本轮 ④）。⚠️ 排在 `clock.start()` 之后、`after()` 之前：
     引导自己会把时钟压回暂停，`after()` 顺手把「暂停」也落盘（关掉标签页再回来仍是暂停态）。 */
  if (isNewGame && s.hintOn) startGuide();
  after();
}

/* ── 新手分步引导（本轮 ④）—— 六步走完就开盘 ──────────────────────
   `showGuide` / `nextGuide` 都不调 `after()`：引导是 `#overlay` 上的一层，
   与每帧重绘无关；`s.paused` 只在开（`startGuide`）与收（`endGuide`）各写一次。 */

function startGuide() {
  guideStep = 0;
  s.paused = true;         // 读字的时候行情不该跑
  s.speed = 1;
  showGuide();
}

/** 画当前这一步。目标取不到（理论不可达）就**直接收摊**，不让玩家卡在一步空引导上。 */
function showGuide() {
  const st = GUIDE[guideStep];
  const target = st && st.at();
  if (!target) { endGuide(); return; }
  openGuide(target, `第 ${guideStep + 1} / ${GUIDE.length} 步 · ${st.text}`, guideStep === GUIDE.length - 1);
}

/** 「下一步」：走完最后一步 ⇒ 收摊开盘 */
function nextGuide() {
  if (guideStep == null) return;
  guideStep++;
  if (guideStep >= GUIDE.length) { endGuide(); return; }
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
 *   - 结束 / 借贷待决时不许切页（与顶栏那两枚按钮的 `lockedUI` 同一条判据；遮罩本来就盖住了 Tab 条）
 * ⚠️ 离开设置页要撤销「重开本局」的武装态：那个按钮是静态 DOM，不还原的话切回来它还是红的，
 *    一点就真重开（`cancelReset` 是超时 / 关面板 / 切页三条路共用的还原口）。
 * ⚠️ 暂停闸门（`dispatch` 顶部那条）仍然管用：切回交易页后**只有这一瞬间**是自动运行的，
 *    玩家随时可以点顶栏「暂停」把下单 / 换所挡住。
 */
function onTab(name) {
  if (s.over || s.pending) return;
  if (name === tab) return;
  if (tab === 'settings') cancelReset();
  tab = name;
  s.paused = name !== 'trade';   // 切回交易页 ⇒ 自动续跑
  s.speed = 1;                   // ⚠️ 写进主状态（会落盘）：切一次页就丢掉 50x 的选择，这是拍板语义
  closePicker();
  after();
}

/**
 * 音效开关：先落盘再重画，静音时**不响**（否则关掉它还会「嗒」一下）。
 * ⚠️ 按钮的文案 / 高亮**不在这里手改**：设置页是常驻骨架，`update()` 每帧从 `view.muted`
 *    同步（`after()` 会强制画一帧，所以反馈仍是即时的）。
 */
function onSoundToggle() {
  const muted = !snd.isMuted();
  snd.setMuted(muted);
  if (!muted) snd.tap();
  after();
}

/**
 * 行情音开关（T-1 · P9）—— 与音效开关同一个写法。
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
   纯**显示偏好**，所以与音效同一个存法：**独立 localStorage 键**（`degen_colors`），
   不进存档 —— 「重开本局」不该把玩家的习惯一起清掉。
   ⚠️ 不复用音效那个 `degen_settings`：那格里存的是一个裸字符串（'mute' / 'on'），
      塞不进第二个值；各存各的键就不会互相覆盖。
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

/** 涨跌色开关 —— 同音效：只翻偏好，按钮外观由 `update()` 每帧从 `view.redUp` 同步。 */
function onColorToggle() {
  applyRedUp(!redUp);
  snd.tap();
  after();
}

/**
 * 新手提示开关（v11 · ③）—— 与音效开关同一个写法：只翻状态，按钮外观由 `update()` 每帧同步。
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

/* 开盘前（`refs` 还没挂上）的异步失败同样兜到开机面板：`boot()` 里那一串 `await`
   （读清单 / 懒加载行情 / 流动性）任一被拒，都不该变成一个白屏。 */
window.addEventListener('unhandledrejection', e => {
  if (!refs) renderBoot('启动失败', e.reason);
});

boot().catch(err => renderBoot('启动失败', err));
