/**
 * 入口：把「状态 / 行情 / 引擎 / 渲染」接起来
 * ===============================================================
 * 职责边界与参考项目一致：
 *   core/*  不知道有 UI 这回事
 *   ui/*    只负责画，以及把点击转成 action
 *   main.js 是唯一把两边连起来的地方（也是唯一允许读时钟的地方）
 */

import { GAME, HOUR_MS, hasFinancingAt, maxLeverageAt } from './core/config.js';
import { createState, heldSyms, posOf, pushLog } from './core/state.js';
import { load, save, wipe, disableSave } from './core/save.js';
import { loadManifest, loadCoin, loadLiq, isLoaded, bindFactorSource } from './core/market.js';
import { createClock, chanOf, futuresAvailable, levKind, openTrade, closeTrade, otcUnlocked, otcOpenFor, switchExchange, timeOf, normalizeLeverage, markPrice, takeLoan, giveUp, advanceOneHour, bindLiquidateHook } from './core/engine.js';
import { anchorAt } from './core/anchors.js';
import { enableGod, factorFor } from './core/god.js';
import { fmtMoney } from './core/format.js';
import { canLiquidate, marginRateOf } from './core/positions.js';
import {
  mount, update, renderOver, renderLoan, renderWarn, clearOver, renderBoot, hideBoot,
  pickExchange, confirmExchange, closePicker, openIntro, openGod, showPage,
} from './ui/render.js';
import { bindActions, bindChart } from './ui/bind.js';
import { panBy, zoomBy, resetView, setMode, syncModeToSpeed, viewOf } from './ui/view.js';
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

/* 上帝模式的隐藏入口（方案 §2.1）：**1.5 秒内连点顶栏「Degen」5 次**。
   与上面那套双重确认同一个理由 —— 顶栏是静态 DOM、不参与每帧重绘，武装状态只能放在这里。
   ⚠️ 计数**不写进 `s`**：它是个纯手势状态，进存档只会污染状态位（重开一局还得记得清）。 */
const GOD_TAPS = 5;
const GOD_TAP_MS = 1500;
let godTaps = 0;
let godTapAt = 0;

/* 「致命那一针」的一句短记忆（S3-附 · ROADMAP §19.6.3）：`{ sym, hour, k }`，**只记最近一次、覆盖式**。
   ⚠️ **不进存档**（拍板口径）：`save()` 是整对象序列化，写进 `s` 就等于落盘；它只活在渲染进程里，
      重开本局走 `location.reload()`，这个变量自然归零。由 `engine` 的注入式回调喂进来。 */
let liqMark = null;

/* 当前页（A6 · 方案 §6.3）—— `'trade'|'assets'|'settings'`。
   ⚠️ **模块级变量，不进 `s`**（§9 B6 拍板）：它和 `godTaps` / `resetArmed` 一样只是**界面位置**，
      与 `view.js` 的「看哪一段」同一口径 —— 进存档只会污染状态位，重开一局还得记得清。 */
let tab = 'trade';

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
  /* 速度 → 粒度（v11 · ④ 第一步）：读档时速度可能是 50x，开局这里先同步一次，
     否则「存量档停在 1h ＋ 50x 速度」会与「速度定粒度」的口径不一致。 */
  syncModeToSpeed(s.sym, s.speed, s.i, chartW());

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
     与持仓条第三格同一个判据（`rate < 0.05` 转红）。
     ⚠️ 不可强平的仓位（现货 1x）没有维持保证金率这一说，跳过 —— 判据统一走 `canLiquidate`
        （v9 · §15.4：现货带杠杆后 1x 以外也能强平，`isSpot` 已经不回答这个问题）。 */
  for (const sym of heldSyms(s)) {
    const pos = s.positions[sym];
    if (!canLiquidate(pos)) { warnedSyms.delete(sym); continue; }
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
  if ((s.over && !overDrawn) || (s.pending && !pendingDrawn)) force = true;
  const now = performance.now();
  if (!force && now - lastDraw < 80) return;
  lastDraw = now;

  if (!refs) return;
  /* ⚠️ **先切页，再量尺寸**（A6 · 方案 §6）：隐藏的 `.trade-page` 是 `display:none`，
     量出来是 0×0；顺序反了的话第一帧拿到的是上一页的尺寸（切回交易页就会画成一张空图，
     而且暂停态下**不会再有任何一帧**把它救回来）。 */
  showPage(refs, tab);
  const rect = refs.chartWrap.getBoundingClientRect();
  /* `liq`：「致命那一针」的短记忆（S3-附）—— 渲染层只在它属于当前币、且视野处在细刻度档时才画 */
  const view = {
    chartW: Math.max(1, Math.round(rect.width)),
    chartH: Math.max(1, Math.round(rect.height - 2)),
    /* 当前显示粒度（v11 · ④）：顶栏时间**跟着粒度走** —— 日线档只到日期。
       与 K 线共用 `view.js` 那一份记录，不另存一份状态。 */
    mode: viewOf(s.sym).mode,
    liq: liqMark,
    /* 当前页：K 线只在交易页画（另两页没有 K 线） */
    tab,
    /* 音效偏好归 `sound.js` 管，不进主状态 —— 设置页那个开关的文案由渲染层每帧从这里取 */
    muted: snd.isMuted(),
  };

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
    && d.intro === undefined) snd.tap();   // 开场两枚键已有专属的起手音（`snd.begin`），不叠轻点声

  /* 开场的两枚入口（v11 · ③）：`d.intro` 是 `'new'`（我是新手）或 `'old'`（我是老手）——
     它只决定 `s.hintOn`，叙事文案两者一样。 */
  if (d.intro !== undefined) return onIntro(d.intro);
  if (d.loan !== undefined) return onLoan(d.loan);
  /* 破产预警遮罩（v11 · ③）：只有一枚「知道了」。它与 `loan` 是**两回事** —— 所以按值分派，
     `s.pending` 的判真值只用来「锁 UI」，绝不用来选遮罩。 */
  if (d.warn !== undefined) return onWarn();
  if (d.hint !== undefined) return onHintToggle();
  /* A6：底部 Tab 切页（`data-tab="trade|assets|settings"`）。
     ⚠️ 原来的 `data-settings`（顶栏那枚「设置」）已随 A6 撤掉 —— 设置整体成了一个页。 */
  if (d.tab !== undefined) return onTab(d.tab);
  if (d.snd !== undefined) return onSoundToggle();
  if (d.reset !== undefined) return onReset(node);
  if (d.sclose !== undefined) return onClosePanel();

  /* ── 上帝模式 ＋ 订单冲击（隐藏入口 · 方案 §2）──
     `god` 是标题上的连点入口，「订单冲击」开关在**设置页**里，其余三枚在上帝面板里（`data-god*`）。
     ⚠️ 上帝模式**只有「跳日期 / 填资金 / 关掉」三件事**（2026-09-29 瘦身）：原来那两套价格能力
        （倍率 `godmult`、手动砸盘 `godscale` / 复位 `godreset`）已整体删除。 */
  if (d.god !== undefined) return onGodTap();
  if (d.impact !== undefined) return onImpactToggle();
  if (d.godcash !== undefined || d.goddate !== undefined || d.godoff !== undefined) {
    /* 这几枚只可能出现在上帝面板里，而面板只在 `s.god` 非空时打开。这一行是**状态机不靠 DOM 兜底**：
       万一面板被别的路径留下来（比如读到一份 `god: null` 的档），这里不能抛异常。 */
    if (!s.god) return;
    if (d.godcash !== undefined) return onGodCash(node);
    if (d.goddate !== undefined) return onGodDate(node);
    return onGodOff();
  }

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
  /* 速度（v11 · ④ 第一步）：**速度定粒度** —— 换速度就把当前币的显示粒度强制同步过去
     （1x → 细刻度 / 5x·10x → 小时 / 50x → 日线）。手动捏合只在本档内临时生效。 */
  if (d.speed !== undefined) {
    s.speed = Number(d.speed);
    syncModeToSpeed(s.sym, s.speed, s.i, chartW());
    after();
    return;
  }
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
          空仓 ⇒ 开仓；持有反向仓 ⇒ 平掉它；持有同向仓 ⇒ 什么都不做。
        同向那一格在渲染层本来就是禁用的，这里再挡一次是「状态机不靠 DOM 兜底」（同 `onChan`）。
     ⚠️ 合约模式下这两枚不显示，同样挡一次 —— 否则会从一个不该存在的入口开出一张合约单。 */
  if (d.buy !== undefined || d.sell !== undefined) {
    if (s.mode === 'fut' && futuresAvailable(s)) return;
    const side = d.buy !== undefined ? 'long' : 'short';
    /* 现货做空要先借到币（v10）：与 `engine.openTrade` 同一条判据，这里先拦一次只为把日志
       降成 `info`（引擎那一份是 `bad`）—— 规则本身仍只在 core，UI 不另算一遍。 */
    if (side === 'short' && levKind(s) === 'spot' && !hasFinancingAt(timeOf(s), s.ex)) {
      pushLog(s, '现货做空 暂不可用 ｜ 该所此刻没有融资业务', 'info');
      after();
      return;
    }
    const pos = posOf(s, s.sym);
    if (!pos) {
      const r = openTrade(s, side, s.sizeFrac);
      if (!r.ok) pushLog(s, r.why, 'bad');
      else snd.open();
    } else if (pos.side !== side) {
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
  /* 粒度是**按币各存一份**的 ⇒ 刚切过来的币多半还停在默认 `1h`；这里按当前速度同步一次，
     否则 50x 下切个币就会退回到「一小时一根」，与「速度定粒度」的口径不一致。 */
  syncModeToSpeed(sym, s.speed, s.i, chartW());
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

/* ── 上帝模式 ＋ 订单冲击（隐藏入口 · 方案 §2）─────────────────────
   一个隐藏入口（连点标题）、一个玩法开关（设置面板）、一张面板（倍率 / 资金 / 日期 / 砸盘）。
   ⚠️ 面板是**静态 DOM**，所以「填入 / 跳到」要从它内部读输入框的值 —— 输入框不能挂 `data-*`
      （`bind.js` 会 `preventDefault` 掉 `pointerdown`，挂上去就打不了字）。 */

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
  openGod(s);
  after();
}

/**
 * 订单冲击开关（方案 §2.7）—— **玩法开关**，落在主状态 `s.impactOn`（不是 `degen_settings`）。
 * ⚠️ 关掉只是「不再产生新的冲击」，**已落地的行情位移不还原**（那是已发生的历史）。
 * ⚠️ 与音效开关同理：按钮外观由 `update()` 同步，不在这里手改节点。
 */
function onImpactToggle() {
  s.impactOn = !s.impactOn;
  after();
}

/** 面板里那枚「填入」：**直接设定当前交易所的余额**（方案 §2.3），不是在原余额上加 */
function onGodCash(node) {
  const v = readGodInput(node, '.god-cash');
  const num = Number(v);
  if (v === null || v.trim() === '' || !Number.isFinite(num) || num < 0) {
    pushLog(s, '填入资金：请输入 ≥ 0 的数', 'bad');
    after();
    return;
  }
  s.books[s.ex] = num;
  s.god.lastFill = num;
  s.godRuined = false;                 // 补上钱之后，下一次归零要能再提示一遍
  pushLog(s, `上帝模式 ｜ 资金已填入 ${fmtMoney(num)}`, 'ok');
  openGod(s);                          // 重开面板：输入框预填值跟着 `lastFill` 走
  after();
}

/**
 * 面板里那枚「跳到」：把时间推到某个日期（方案 §2.4）。
 *
 * ⚠️ **逐小时重放，不能只改 `s.i`**：那等于把跳过这段时间里的所有事件白送 ——
 *    Mt.Gox 2014-02-25 归零、币解锁、杠杆阶梯升级、借款到期、强平、资金费、转账到账。
 *    复用现成的 `advanceOneHour` 就零新增事件逻辑。
 * ⚠️ **只许向前**：向后跳会让「未来开的仓」凭空出现在历史里。
 */
function onGodDate(node) {
  const v = readGodInput(node, '.god-date');
  const m = v && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) {
    pushLog(s, '跳到日期：请选择一个日期', 'bad');
    after();
    return;
  }
  const target = Math.min(
    Math.max((Date.UTC(+m[1], +m[2] - 1, +m[3]) - GAME.start) / HOUR_MS, s.i),
    GAME.candles - 1,
  );
  if (target <= s.i) {
    pushLog(s, '跳到日期：只能向前跳', 'bad');
    after();
    return;
  }
  /* 同步循环 ⇒ `createClock` 的 `setInterval` 不可能插进来。三种情况都要停：
       ① 到目标日期  ② 到 2024-12-31 收盘（`s.over`）
       ③ **中途账户归零、弹出借贷遮罩**（`s.pending`）—— 少了第三个判据这里会**死循环**：
          `advanceOneHour` 在 `pending` 下会立刻 return（`s.i` 永远不前进），
          而 `!s.over` 一直为真，浏览器就卡死了（2026-09-29 离线断言逮到）。 */
  while (s.i < target && !s.over && !s.pending) advanceOneHour(s);
  /* 停在借贷遮罩上时**不要**再开上帝面板 —— `draw()` 刚把遮罩铺上，压一张面板上去只会打架 */
  if (!s.over && !s.pending) openGod(s);
  after();
}

/**
 * 「关闭上帝模式」：退出 `s.god`（⇒ 停止归零保护）。
 * ⚠️ **行情位移不还原**：订单冲击池 `s.flow` 留着（那是已发生的历史）。
 *    上帝模式本来也不再持有任何价格状态（2026-09-29 瘦身），所以关掉只是关掉保护。
 */
function onGodOff() {
  s.god = null;
  pushLog(s, '上帝模式已关闭 ｜ 订单冲击保留', 'info');
  closePicker();
  after();
}

/** 上帝面板里输入框的值 —— 输入框没有动作键，只能从同一个面板里按类名找（两个框各有一个唯一类） */
const readGodInput = (node, sel) => node.closest('.godp')?.querySelector(sel)?.value ?? null;

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
  /* 速度被压回 1x ⇒ 粒度也跟着回到细刻度档（v11 · ④：速度定粒度） */
  syncModeToSpeed(s.sym, s.speed, s.i, chartW());
  after();
}

/* ── 底部 Tab · 设置页（A6 · 方案 §6.3）─────────────────────────────
   设置从「顶栏一枚按钮 ＋ 弹层」改成**第三个页**；重开本局仍在页内，且必须**双重确认** ——
   它是全屏唯一会毁掉整局的操作，一键完成太危险。
   ⚠️ 页是**静态 DOM**（不参与每帧重绘），所以「已武装」这个状态只能存在这里，
      不能写进 `refs` —— 一重绘就被抹掉。 */

/**
 * 切页。口径（§6.3 已拍板）：
 *   - **切页即暂停 ＋ 速度归 1x**，包括切到**设置页**（P2：不留「切到设置页时间还在跑」的例外）
 *   - 切回交易页**仍然暂停** —— 恢复入口始终是顶栏那枚「暂停」，它在三页都常驻
 *   - 结束 / 借贷待决时不许切页（与顶栏那两枚按钮的 `lockedUI` 同一条判据；遮罩本来就盖住了 Tab 条）
 * ⚠️ 离开设置页要撤销「重开本局」的武装态：那个按钮是静态 DOM，不还原的话切回来它还是红的，
 *    一点就真重开（`cancelReset` 是超时 / 关面板 / 切页三条路共用的还原口）。
 */
function onTab(name) {
  if (s.over || s.pending) return;
  if (name === tab) return;
  if (tab === 'settings') cancelReset();
  tab = name;
  s.paused = true;      // 切页即暂停
  s.speed = 1;          // ⚠️ 写进主状态（会落盘）：切一次页就丢掉 50x 的选择，这是拍板语义
  syncModeToSpeed(s.sym, s.speed, s.i, chartW());   // 速度定粒度（v11 · ④）—— 回 1x 就回细刻度
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

boot();
