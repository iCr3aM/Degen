/**
 * 渲染层
 * ===============================================================
 * 与参考项目最大的不同：**骨架只建一次，之后只改文字与 class**。
 *
 * 为什么这次不走「每帧 innerHTML 重建」：
 *   - K 线必须画在 `<canvas>` 上，重建 DOM 会把 canvas 一起扔掉（每帧重新分配像素缓冲）
 *   - 竖屏单列只有十来个会变的数值，逐个 `textContent` 赋值比重建整棵树便宜得多
 *   - 没有重建 ⇒ 不存在「mousedown 与 mouseup 落在不同节点」的问题，点击天然可靠
 *
 * 所有会变的数字都挂在 `refs` 上，`update()` 是唯一的写入口。
 */

import { GAME, COINS, EXCHANGES, SPEEDS, coinOf, exchangeOf, leverageOptionsAt, feeRateOf, HOUR_MS, LOAN, loanAmountAt } from '../core/config.js';
import { fmtDate, fmtHour, fmtMoney, fmtPct, fmtRate } from '../core/format.js';
import { available, chanOf, equity, markPrice, otcOpenFor, otcUnlocked, timeOf, totalUnrealized, unrealizedOf } from '../core/engine.js';
import { isSpot, liquidationPrice, marginRateOf } from '../core/positions.js';
import { isLoaded, rangeOf, candleAt, HOURS_PER_DAY } from '../core/market.js';
import { arrivalCandles, confirmationsOf, congestionLabel, congestionOf } from '../core/congestion.js';
import { anchorAt, anchorsInRange } from '../core/anchors.js';
import { anyHeld, posOf } from '../core/state.js';
import { drawChart } from './chart.js';
import { windowFor, setYPx } from './view.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * 建骨架。返回一个 refs 对象，`update()` 只认这个对象里的字段。
 * @param {HTMLElement} root
 */
export function mount(root) {
  root.textContent = '';

  /* ── 顶栏 ── */
  const dateEl = el('span');
  const top = el('div', 'top');
  const who = el('div', 'who');
  who.append(el('b', null, 'Degen'), dateEl);
  /* 交易所切换器（GDD §7.2）：从 HUD 第三格搬到这里（2026-09-28），做成**双行**小按钮，
     长得和暂停 / 重开一模一样 ⇒ 玩家一眼知道它可点。
     为什么必须双行：390px 屏 `.who` 占 115px、暂停+重开占 90px，只剩 150px；
     单行「Binance 费率 0.04%」在 12px 等宽下要 125px + 内边距 = 141px，换个所或换到 375px 屏必爆。 */
  const exName = el('b');
  const exRate = el('u');
  const exBtn = el('button', 'ic exbtn');
  exBtn.dataset.ex = 'pick';
  exBtn.append(exName, exRate);
  const pauseBtn = el('button', 'ic', '暂停');
  pauseBtn.dataset.pause = '';
  /* 第三枚：`重开` → **`设置`**（Batch 4 · B21）。重开本身搬进设置面板并加二次确认 ——
     顶栏只留「一看就知道点得动」的入口，误触一下就清档的风险从根上消失。
     文案仍是 2 个汉字，`.top .ic` 的 42px 定宽不用改，布局一动不动。 */
  const settingsBtn = el('button', 'ic', '设置');
  settingsBtn.dataset.settings = '';
  const tools = el('div', 'tools');
  tools.append(exBtn, pauseBtn, settingsBtn);
  top.append(who, tools);

  /* ── 账户两格：交易所搬去顶栏后退回两列（2026-09-28），手机上每格从 91px 回到 179px，
        「账户权益 / 可用保证金」不再被 text-overflow 截尾 ── */
  const eqVal = el('b', 'num');
  const eqSub = el('u', 'num');
  const cashVal = el('b', 'num');
  const cashSub = el('u', 'num');
  const hud = el('div', 'hud');
  hud.append(
    cell('账户权益', eqVal, eqSub),
    cell('可用保证金', cashVal, cashSub),
  );

  /* ── 币种条 ── */
  const symbols = el('div', 'symbols');
  const symBtns = new Map();
  for (const c of COINS) {
    const b = el('button', 'sym', c.sym);
    b.dataset.sym = c.sym;
    symbols.append(b);
    symBtns.set(c.sym, b);
  }

  /* ── K 线 ── */
  const canvas = el('canvas');
  const chSym = el('b');
  const chChg = el('span');
  const chartHead = el('div', 'chart-head');
  /* 粒度切换（Batch 3 · B12，拍板「K 线左上角遮罩里加一枚可点小字」）：
     字面是**当前**粒度，点一下切到另一种。做成 `button` 才有点击态，也为触屏留住命中面积。 */
  const modeBtn = el('button', 'chip');
  modeBtn.dataset.mode = 'toggle';
  chartHead.append(chSym, chChg, modeBtn);
  /* K 线**右上角**那一列浮字（两枚都压在画布上、**不占布局高度**）：
       · 在途转账倒计时（P2-A）：只在有转账时显示
       · 锁视野提示（Batch 3 · B14）：只在玩家拖动/缩放之后显示
     放同一列是因为两者会同时出现（转账途中拖 K 线很常见），并排会打架。 */
  const chartEta = el('div', 'chart-eta');
  chartEta.hidden = true;
  const chartLock = el('div', 'chart-lock', '双击回最新');
  chartLock.hidden = true;
  const chartSide = el('div', 'chart-side');
  chartSide.append(chartEta, chartLock);
  const chartWrap = el('div', 'chart-wrap');
  chartWrap.append(canvas, chartHead, chartSide);

  /* ── 持仓条 ──
   ⚠️ **常驻**（2026-09-29）：无持仓时三格填 `--`，不再整条隐藏 ——
    K 线区是全屏唯一的弹性块，持仓条一显一隐会让 K 线高度开仓/平仓时来回跳。 */
  const posSide = el('b', 'num');
  const posPnl = el('b', 'num');
  const posRate = el('b', 'num');
  const posbar = el('div', 'posbar');
  posbar.append(
    mini('持仓', posSide),
    mini('未实现盈亏', posPnl),
    mini('保证金率', posRate),
  );

  /* ── 日志条 ──
     拆成「标签 ＋ 正文」两个节点（P2-C）：锚点时刻在正文前挂一枚 `新闻` 小标签切到**新闻态**，
     不带标签时就是原来那一条普通日志。槽位仍是 24px，固定块合计不变 —— 见 ⑤ 的裁决 ③。 */
  const newsTag = el('i', 'news-tag', '新闻');
  newsTag.hidden = true;
  const logText = el('span');
  const logline = el('div', 'logline');
  logline.append(newsTag, logText);

  /* ── 操作区 ── */
  const fracRow = el('div', 'row');
  fracRow.append(el('span', 'lbl', '金额'));
  const fracBtns = new Map();
  for (const [f, label] of [[0.25, '1/4'], [0.5, '1/2'], [1, '全部']]) {
    const b = el('button', 'opt', label);
    b.dataset.frac = String(f);
    fracRow.append(b);
    fracBtns.set(String(f), b);
  }

  const levRow = el('div', 'row');
  levRow.append(el('span', 'lbl', '杠杆'));
  const levBtns = new Map();               // 值 → 按钮；档位随年份变化，重建时复用

  const spdRow = el('div', 'row');
  spdRow.append(el('span', 'lbl', '速度'));
  const spdBtns = new Map();
  for (const v of SPEEDS) {
    const b = el('button', 'opt', v + 'x');
    b.dataset.speed = String(v);
    spdRow.append(b);
    spdBtns.set(v, b);
  }

  const longBtn = el('button', 'act long', '做多');
  longBtn.dataset.act = 'long';
  const shortBtn = el('button', 'act short', '做空');
  shortBtn.dataset.act = 'short';
  const closeBtn = el('button', 'act flat', '平仓');
  closeBtn.dataset.act = 'close';
  /* 通道切换键（P2-B3 · GDD §15.3）：铺在底行最左。字面是**当前**通道，点一下切到另一种 ——
     与 K 线左上角那枚粒度小字同一约定，全屏只有一套「字面即现状」的切法。
     它是四枚里唯一的**方框**（其余三枚是实心块）：它不是「一次成交」，是「换一条成交路径」。
     未解锁（权益 ≤ $500 万）时 `hidden` —— 一个 $3,000 开局的玩家不该看见自己用不了的东西。
     权益够但当前币还没开通 OTC 时**禁用而不隐藏**（三级状态，见 `update()` 里那段注释）。 */
  const chanBtn = el('button', 'act chan', '盘口');
  chanBtn.dataset.chan = 'toggle';
  const actRow = el('div', 'row');
  actRow.append(chanBtn, longBtn, shortBtn, closeBtn);

  const trade = el('div', 'trade');
  trade.append(fracRow, levRow, spdRow, actRow);

  root.append(top, hud, symbols, chartWrap, posbar, logline, trade);

  return {
    root, dateEl, pauseBtn, settingsBtn,
    exBtn, exName, exRate,
    eqVal, eqSub, cashVal, cashSub,
    symbols, symBtns,
    canvas, chartWrap, chartHead, chSym, chChg, modeBtn, chartEta, chartLock,
    posbar, posSide, posPnl, posRate,
    logline, newsTag, logText,
    fracBtns, levRow, levBtns, spdBtns,
    chanBtn, longBtn, shortBtn, closeBtn,
    _levSignature: '',
  };
}

function cell(label, valueEl, subEl) {
  const c = el('div', 'cell');
  c.append(el('i', null, label), valueEl, subEl);
  return c;
}

function mini(label, valEl) {
  const d = el('div');
  d.append(el('i', null, label), valEl);
  return d;
}

/**
 * 每个币「解锁进度环」的**起点**（Batch 5 · B25）：
 *   起点 = **上一个币的解锁时刻**（BTC 用开盘时刻）⇒ 每个币在属于它的那一段里从 0% 填满到 100%，
 *   读起来就是「下一个就是它，已经走了多少」。起点晚于终点（BTC）时时长取 0，进度直接算满。
 */
const LOCK_PREV = (() => {
  const m = new Map();
  let prev = GAME.start;
  for (const c of COINS) {
    m.set(c.sym, Math.min(prev, c.unlock));
    prev = c.unlock;
  }
  return m;
})();

/* ═════════════════════════ 每帧写入口 ═════════════════════════ */

/**
 * @param {object} refs  `mount()` 的返回值
 * @param {object} s     状态
 * @param {object} view  { chartW, chartH } —— K 线区实测尺寸
 */
export function update(refs, s, view) {
  refs.dateEl.textContent = fmtDate(timeOf(s));

  /* 顶栏按钮。⚠️ B30 的**待决态**（`s.pending`）下也要锁死：时钟已经停了，这时候
     「继续 / 暂停」和「设置」都不该可用 —— 玩家只有一个选择要回答（借，还是收摊）。 */
  const lockedUI = !!s.over || !!s.pending;
  refs.pauseBtn.textContent = s.paused ? '继续' : '暂停';
  refs.pauseBtn.classList.toggle('on', s.paused);
  refs.pauseBtn.disabled = lockedUI;
  refs.settingsBtn.disabled = lockedUI;

  /* 账户三格 */
  const eq = equity(s);
  refs.eqVal.textContent = fmtMoney(eq);
  refs.eqVal.className = 'num ' + (eq >= GAME.cash ? 'up' : 'down');
  /* 副行两个数**都带符号**（Batch 4 · B17）：正绿负红，与持仓盈亏同一口径。
     颜色写在这里而不是 CSS 默认值 —— 见 `style.css` 里 `.hud .cell u.up` 那段注释。 */
  refs.eqSub.textContent = `已实现 ${fmtMoney(s.realized, { sign: true })}`;
  refs.eqSub.className = 'num ' + (s.realized >= 0 ? 'up' : 'down');

  refs.cashVal.textContent = fmtMoney(available(s));
  /* 副行优先级：**有贷款时负债永远最该出现**（B30）—— 它是必须还的一笔钱，
     而「初始 $3,000」是个死常量、零信息量。剩几天按小时差向下取整。 */
  if (s.loan) {
    const left = Math.max(0, Math.ceil((s.loan.dueAt - s.i) / 24));
    refs.cashSub.textContent = `欠 ${fmtMoney(s.loan.owe)} · ${left}d`;
    refs.cashSub.className = 'num down';
  } else if (anyHeld(s)) {
    const u = totalUnrealized(s);
    refs.cashSub.textContent = `未实现 ${fmtMoney(u, { sign: true })}`;
    refs.cashSub.className = 'num ' + (u >= 0 ? 'up' : 'down');
  } else {
    refs.cashSub.textContent = `初始 ${fmtMoney(GAME.cash)}`;
    refs.cashSub.className = 'num mut';
  }

  refs.exName.textContent = exchangeOf(s.ex)?.name ?? '--';
  /* 第二行平时是费率；**有在途转账时临时换成倒计时**（P2-A）——
     顶栏只有 46px 余量（375px 屏），「拥堵 严重」这类词根本放不下，
     所以拥堵状态词只出现在选所弹层里，顶栏这一行只承担倒计时。 */
  refs.exRate.textContent = s.transfer
    ? `→ 剩 ${Math.max(0, s.transfer.arriveAt - s.i)}h`
    : `费率 ${fmtRate(feeRateOf(s.ex), 2)}`;

  /* 币种条：未解锁的币用**边框环**显示解锁进度（Batch 5 · B25）。
     进度由 `--pf` 这个 CSS 变量驱动（`style.css` 的 `.sym.locked` 拿它画锥形渐变环），
     值没变就不写 —— 每帧 4 个按钮的 `setProperty` 会触发样式失效，能省则省。 */
  const now = timeOf(s);
  for (const c of COINS) {
    const b = refs.symBtns.get(c.sym);
    b.classList.toggle('on', s.sym === c.sym);
    b.classList.toggle('held', !!posOf(s, c.sym));
    const locked = now < c.unlock;
    b.disabled = locked;
    b.classList.toggle('locked', locked);
    if (locked) {
      const from = LOCK_PREV.get(c.sym);
      const span = c.unlock - from;
      const p = span > 0 ? Math.min(1, Math.max(0, (now - from) / span)) : 1;
      const key = p.toFixed(4);
      if (b.dataset.pf !== key) {
        b.dataset.pf = key;
        b.style.setProperty('--pf', key);
      }
    }
  }

  /* K 线：持仓条、图表标记、主按钮都只看**当前所选币**的仓位（多仓口径，2026-09-28 拍板） */
  const sym = s.sym;
  const cur = posOf(s, sym);
  const mark = markPrice(s, sym);
  const prev = candle24(sym, s.i);
  refs.chSym.textContent = sym;
  if (mark != null && prev) {
    refs.chChg.textContent = `24h ${fmtPct(mark / prev - 1)}`;
    refs.chChg.className = mark >= prev ? 'up' : 'down';
  } else {
    refs.chChg.textContent = '';
  }

  const win = windowFor(sym, s.i, view.chartW);
  /* 锚点刻度（P2-C · 裁决 ④）：把锚点的**小时序号**换算成视野的**显示单位序号** ——
     日线模式下一根 = 一天，`floor(at / 24)` 才是它所在的槽位。越界的锚点交给 `chart.js` 丢掉
     （`count` 可能大于可用根数，这里的下界会算成负数）。 */
  const hLo = win.mode === '1d' ? (win.right - win.count + 1) * HOURS_PER_DAY : win.right - win.count + 1;
  const hHi = win.mode === '1d' ? win.right * HOURS_PER_DAY + HOURS_PER_DAY - 1 : win.right;
  const anchorMarks = anchorsInRange(hLo, hHi).map(a => ({
    d: win.mode === '1d' ? Math.floor(a.at / HOURS_PER_DAY) : a.at,
  }));
  /* 图上唯一的入口：K 线、量柱、两条水平线都在这一笔里画。
     ⚠️ 返回值必须写回视野 —— 价格轴的平移限位夹在 `drawChart` 里（换算的唯一真源在那边），
        状态记的是**没夹过**的原始位移，不写回就会越夹越离谱。 */
  const effY = drawChart(refs.canvas, {
    candles: win.candles,
    vols: win.vols,
    /* 槽位数（= 视野要的根数）：柱宽按它算、柱子右对齐，币种刚上线时才不会一根撑满屏（B22） */
    slots: win.count,
    /* 历史锚点刻度（P2-C）—— 与最右那根一起交给图上换算槽位 */
    anchors: anchorMarks,
    right: win.right,
    /* 顶部留白 = 左上角遮罩的**实测**高度（Batch 5 · B27）：量不到时由 `chart.js` 退回自己的兜底常量。
       `getBoundingClientRect` 与 `main.js` 那次取 `chartWrap` 尺寸落在同一帧，不额外多一次强制布局。 */
    topInset: refs.chartHead.getBoundingClientRect().height,
    mark,
    entry: cur ? cur.entry : null,
    side: cur ? cur.side : null,
    /* 强平价交给图上的**开仓线左端标签**（Batch 2 · B9）。现货没有强平价 ⇒ 传 null。 */
    liq: cur && !isSpot(cur) ? liquidationPrice(cur) : null,
    cssW: view.chartW,
    cssH: view.chartH,
    yPx: win.yPx,
  });
  if (effY !== win.yPx) setYPx(sym, effY);

  /* 粒度小字（Batch 3 · B12）：字面是当前粒度，点一下切到另一种 */
  refs.modeBtn.textContent = win.mode === '1d' ? '1日' : '1h';
  /* 锁视野提示（Batch 3 · B14）：拖动/缩放之后才出现，双击复位后自己消失 */
  refs.chartLock.hidden = !win.locked;

  /* 在途转账倒计时（K 线右上角）。两个数字与顶栏那行同源，但这里多一个「去哪儿」——
     玩家一眼能确认钱在往哪家所的路上。 */
  if (s.transfer) {
    const to = exchangeOf(s.transfer.to);
    refs.chartEta.hidden = false;
    refs.chartEta.textContent = `${to ? to.name : s.transfer.to} · 剩 ${Math.max(0, s.transfer.arriveAt - s.i)}h`;
  } else {
    refs.chartEta.hidden = true;
  }

  /* 持仓条：只显示当前所选币；**无持仓也常驻**（三格填 `--`），见 mount() 的注释 */
  if (cur) {
    const p = cur;
    const spot = isSpot(p);
    const posMark = markPrice(s, p.sym);
    refs.posSide.textContent = spot ? `${p.sym} 现货` : `${p.sym} ${p.side === 'long' ? '多' : '空'} ${p.lev}x`;
    refs.posSide.className = 'num ' + (p.side === 'long' ? 'side-long' : 'side-short');
    const pnl = unrealizedOf(s, p.sym);
    refs.posPnl.textContent = fmtMoney(pnl, { sign: true });
    refs.posPnl.className = 'num ' + (pnl >= 0 ? 'up' : 'down');
    /* 第三格**只剩保证金率**（Batch 2 · B9，2026-09-29）：原来这里是「保证金率 / 强平价」，
       格宽只有 1/3 屏，两个数一串必然被 `text-overflow` 截掉尾巴（用户实机发现）。
       强平价已搬到 K 线的开仓线左端标签，这一格终于能完整放下一个数。
       现货（1x 做多）没有维持保证金率这一说 —— 只有币价归零才归零本金（GDD §9.1），填 `--`。 */
    if (spot) {
      refs.posRate.textContent = '--';
      refs.posRate.className = 'num mut';
    } else {
      const rate = posMark == null ? 0 : marginRateOf(p, posMark);
      refs.posRate.textContent = fmtRate(rate);
      refs.posRate.className = 'num ' + (rate < 0.05 ? 'down' : 'mut');
    }
  } else {
    for (const n of [refs.posSide, refs.posPnl, refs.posRate]) {
      n.textContent = '--';
      n.className = 'num mut';
    }
  }

  /* 日志条：只显示最近一条。时间用**事件发生那一刻**的 `at`，不是「现在」——
     否则一条发生在 2015-10-01 的爆仓，几天后会被标成今天。
     ⚠️ 前缀**只有时分**（2026-09-29）：完整日期已经在顶栏，这里再写一遍就是重复显示。 */
  /* ⚠️ 兜底文案是 **`—`** 而不是「等待开盘…」（Batch 5 · B24）：那一行是日志的**空态**，
     而此刻行情往往已经在跑了 —— 写「等待开盘」等于声称一件不成立的事。
     新开局的「开盘」日志由 `main.js` 的 `onIntro()` 补上，空态几乎只出现在老存档上。 */
  const last = s.log[0];
  /* **新闻态**（P2-C · 裁决 ③：复用日志条这 24px 槽位，零布局开销）：
     锚点窗口（`[at, at + 24)`）内改播新闻，**但只要有一条比它更新的日志就让位** ——
     否则玩家刚开完仓，自己那一拍反馈会被新闻压掉整整 24 游戏小时。
     新闻是 `s.i` 的纯函数，不存任何「已播过」标志：窗口本身不重叠（锚点稀疏），
     所以同一句新闻在一局里只可能出现一次。 */
  const news = anchorAt(s.i);
  const newsOn = !!news && !(last && last.at > news.at);
  refs.newsTag.hidden = !newsOn;
  if (newsOn) {
    refs.logText.textContent = `[${fmtHour(GAME.start + news.at * HOUR_MS)}] ${news.title}`;
    refs.logline.className = 'logline news';
  } else {
    refs.logText.textContent = last
      ? `[${fmtHour(GAME.start + (last.at ?? s.i) * HOUR_MS)}] ${last.text}`
      : '—';
    refs.logline.className = 'logline ' + (last ? (last.kind === 'bad' ? 'down' : last.kind === 'ok' ? 'up' : 'mut') : 'mut');
  }

  /* 金额档 */
  for (const [k, b] of refs.fracBtns) b.classList.toggle('on', Math.abs(s.sizeFrac - Number(k)) < 1e-9);

  /* 杠杆档：可选档位随「时间 + 所选交易所」变化，签名变了才重建按钮 */
  const opts = leverageOptionsAt(now, s.ex);
  const sig = opts.join(',') + '#' + s.lev;
  if (sig !== refs._levSignature) {
    refs._levSignature = sig;
    refs.levRow.querySelectorAll('.opt').forEach(n => n.remove());
    refs.levBtns.clear();
    for (const v of opts) {
      const b = el('button', 'opt', v + 'x');
      b.dataset.lev = String(v);
      b.classList.toggle('on', v === s.lev);
      refs.levRow.append(b);
      refs.levBtns.set(v, b);
    }
  }

  /* 速度档 */
  for (const [v, b] of refs.spdBtns) b.classList.toggle('on', s.speed === v);

  /* 主按钮可用性：做多/做空看「当前币还没仓位」，平仓看「当前币有仓位」。
     `lockedUI`（结束 / 待借贷决策）下一律不可用 —— 待决态只留遮罩上那两枚按钮。 */
  const canTrade = !lockedUI && !cur && mark != null && isLoaded(sym);
  refs.longBtn.disabled = !canTrade;
  refs.shortBtn.disabled = !canTrade;
  refs.closeBtn.disabled = !cur || lockedUI;

  /* 通道切换键**三级状态**（P2-B 修订 · GDD §15.3）：
       ① 权益 ≤ $500 万 ⇒ `hidden` —— 一个 $3,000 开局的玩家不该看见自己用不了的东西
       ② 权益够、但**当前币**还没开通 OTC ⇒ 可见但禁用（灰框）——
          这一级存在的意义就是「切币时按钮不再忽隐忽现」，所以不能藏
       ③ 两者都满足 ⇒ 可用
     字面与高亮都跟着**生效通道**走 —— 看 `chanOf` 而不是 `s.chan`，
     否则会出现「键藏起来了、单子却还在走 OTC」这种玩家看不见的通道。 */
  const chan = chanOf(s);
  const unlocked = otcUnlocked(s);
  refs.chanBtn.hidden = !unlocked;
  refs.chanBtn.disabled = !(unlocked && otcOpenFor(s));
  refs.chanBtn.textContent = chan === 'otc' ? 'OTC' : '盘口';
  refs.chanBtn.classList.toggle('on', chan === 'otc');
}

/* ───────────────────────── 小工具 ───────────────────────── */

/** 24 小时前的收盘价（用来算涨跌幅） */
function candle24(sym, i) {
  const c = candleAt(sym, i - 24);
  return c ? c.c : null;
}

/**
 * 覆盖全屏的结束遮罩。三种结局：收盘结算（赢）/ 爆仓 / **债务违约**（B30）。
 * ⚠️ 收盘时**若贷款还没到期**，账上那笔钱是借来的 ⇒ 净成绩要减掉 `owe`（借的钱赖不掉）。
 *    这不改 `settled` 的判据（活到 2024 年底就算赢），只是把最终数字说清楚。
 */
export function renderOver(root, s) {
  root.querySelector('.over')?.remove();
  const box = el('div', 'over');
  const reason = s.over.reason;
  const win = reason === 'settled';
  const owed = s.loan ? s.loan.owe : 0;
  const eq = equity(s) - owed;

  const title = reason === 'defaulted' ? '债务违约' : win ? '收盘结算' : '爆仓';
  const body = reason === 'defaulted'
    ? `到期还不上借款，账户清零\n倒在 ${fmtDate(timeOf(s))}`
    : win
      ? `你活到了 ${fmtDate(timeOf(s), false)}\n最终权益 ${fmtMoney(eq)}`
        + (owed ? `\n（已扣未还借款 ${fmtMoney(owed)}）` : '')
      : `保证金归零，账户清零\n倒在 ${fmtDate(timeOf(s))}`;

  box.append(el('b', win ? 'up' : 'down', title), el('p', null, body));
  const btn = el('button', null, '重新开始');
  btn.dataset.restart = '';
  box.append(btn);
  root.append(box);
}

/**
 * 借贷决策遮罩（Batch 5 · B30）—— 归零那一刻出现，**时钟已停**，等玩家二选一。
 * 复用 `.over` 外壳（居中、吃满屏、不透明底）：它不是「可以点外面关掉」的菜单，
 * 是一个必须回答的问题 —— 与开场叙事同一种语气。
 * ⚠️ 这一帧只画一次（`s.paused` 期间不再有 `onFrame`），所以不需要去重重建。
 */
export function renderLoan(root, s) {
  root.querySelector('.over')?.remove();
  const box = el('div', 'over');
  const amount = loanAmountAt(timeOf(s));
  const owe = amount * (1 + LOAN.ratePerDay * LOAN.days);

  box.append(
    el('b', 'down', '账户归零'),
    el('p', null, `借 ${fmtMoney(amount)} ｜ ${LOAN.days} 天后还 ${fmtMoney(owe)}\n这是这一局最后的机会`),
  );
  const take = el('button', null, `借 ${fmtMoney(amount)} 续命`);
  take.dataset.loan = 'take';
  const give = el('button', 'flat', '就此收摊');
  give.dataset.loan = 'give';
  const btns = el('div', 'over-btns');
  btns.append(take, give);
  box.append(btns);
  root.append(box);
}

export function clearOver(root) {
  root.querySelector('.over')?.remove();
}

/* ═════════════════════════ 选所弹层 ═════════════════════════ */

/** 当前打开的弹层容器。同一时刻只允许一个。 */
let picker = null;

/**
 * 打开选所弹层（GDD §7.2）。挂 `#overlay` 而不是 `#app`：
 * `#app` 每帧都在被重写，建在里面会被立刻擦掉（见 index.html 的注释）。
 * 四家全部列出，没开业 / 已归零的置灰 —— 顺带把时间线讲给玩家听。
 *
 * P2-A：弹层是**唯一**放拥堵信息的地方（顶栏只剩 46px 余量）。表头给**状态词**，
 * 每一行给该所的**确认数 ＋ 预估到账小时数** —— 正好是玩家要做决定的地方，不额外占地。
 * @param {object} s
 * @param {HTMLElement} anchor 贴靠的那枚按钮（顶栏的交易所切换器）
 */
export function pickExchange(s, anchor) {
  closePicker();
  const ov = document.getElementById('overlay');
  if (!ov) return;

  const t = timeOf(s);
  const congestion = congestionOf(s);
  const back = el('div', 'pick-back');
  const panel = el('div', 'pick');

  // 表头：只说状态词，不给 0–100 的数字（拍板 ③）
  const label = congestionLabel(congestion);
  const head = el('div', 'pick-head', `拥堵 ${label}`);
  head.classList.add(congestion > 80 ? 'down' : congestion > 50 ? 'gold' : 'mut');
  panel.append(head);

  for (const ex of EXCHANGES) {
    const notYet = t < ex.open;
    const dead = ex.close != null && t >= ex.close;
    const row = el('button', 'pick-row');
    row.dataset.ex = ex.id;
    // 在途时**所有行都不可点**（同时在途只允许一笔）—— 让点不动的按钮先于错误日志表达这件事
    row.disabled = notYet || dead || !!s.transfer;
    row.classList.toggle('on', ex.id === s.ex);

    // 上行：名字 ＋ 费率；下行：这家所自己的事（确认数 / 到账预估 / 为什么不能选）
    const l1 = el('div', 'pick-l1');
    l1.append(el('b', null, ex.name), el('u', null, `费率 ${fmtRate(ex.fee, 2)}`));
    const note = notYet ? '还没开业'
      : dead ? '已归零'
        : s.transfer ? '转账在途'
          : ex.id === s.ex ? '当前所'
            : `${confirmationsOf(ex.id)} 确认 · 预估 ${arrivalCandles(congestion, ex.id)}h`;
    row.append(l1, el('em', 'pick-note', note));

    panel.append(row);
  }

  // 贴在锚点正下方右对齐。弹层是 fixed，所以用视口坐标（#app 居中也不影响）。
  const r = anchor.getBoundingClientRect();
  panel.style.top = Math.round(r.bottom + 4) + 'px';
  panel.style.right = Math.round(document.documentElement.clientWidth - r.right) + 'px';
  // 宽度**不在这里定**（2026-09-29）—— 交给 `style.css` 的 `.pick`：`width:max-content`
  // ＋ `min-width:200px` ＋ `max-width:calc(100vw - 24px)`。JS 只负责定位，
  // 面板会长到刚好放下最长一行，任何机型字体都不会折行。

  back.addEventListener('pointerdown', closePicker);
  ov.append(back, panel);
  ov.hidden = false;
  picker = ov;
}

/**
 * 换所二次确认（Batch 2 · B10，2026-09-29）。
 *
 * 为什么值得多这一步：换所从 P2-A 起是一笔**要等好几根 K 线的链上转账**（2017-12 那种拥堵下是 13 根），
 * 点错一次就是十几个游戏小时白等，而且那期间所有行都不可点（同时在途只允许一笔）。
 * 之前是「点一行就立刻搬走」，现在是「点一行 → 问一句 → 才搬」。
 *
 * 弹层里只放**做决定需要的三样**：拥堵状态词、预估到账小时数、目标所费率。
 * 拥堵数字（0–100）与确认数不在这里 —— 前者在选所弹层里已经用状态词表达过，
 * 后者是上一层的细节（LESS IS MORE）。
 *
 * 宽高都不写死：`left/right: 12px` 撑满（与 `#app` 一样的两侧留白），垂直居中。
 */
export function confirmExchange(s, id) {
  closePicker();
  const ov = document.getElementById('overlay');
  if (!ov) return;

  const ex = exchangeOf(id);
  const congestion = congestionOf(s);
  const back = el('div', 'pick-back');
  const box = el('div', 'confirm');

  box.append(el('h3', null, `切换到 ${ex ? ex.name : id}？`));

  const line = (k, v) => {
    const d = el('div', 'confirm-row');
    d.append(el('i', null, k), el('span', 'num', v));
    return d;
  };
  const rows = el('div', 'confirm-rows');
  rows.append(
    line('拥堵', congestionLabel(congestion)),
    line('预估到账', `${arrivalCandles(congestion, id)} 小时`),
    line('费率', fmtRate(ex ? ex.fee : 0, 2)),
  );
  box.append(rows);

  // 按钮复用操作区那套 `.act`：确认走绿色实心（= 正向动作），取消走中性灰
  const ok = el('button', 'act long', '确认切换');
  ok.dataset.exok = id;
  const no = el('button', 'act flat', '取消');
  no.dataset.exno = '';
  const btns = el('div', 'confirm-btns');
  btns.append(ok, no);
  box.append(btns);

  back.addEventListener('pointerdown', closePicker);
  ov.append(back, box);
  ov.hidden = false;
  picker = ov;
}

export function closePicker() {
  if (!picker) return;
  picker.textContent = '';
  picker.hidden = true;
  picker = null;
}

/* ═════════════════════════ 开场叙事（Batch 4 · B19） ═════════════════════════ */

/**
 * 进游戏前的开场白。`main.js` 只在**新开局**（`load()` 返回 null）调它一次 ——
 * 读档续玩不弹，重开 / 爆仓重开（都走 `wipe` ＋ reload）会重新出现。
 *
 * 两条刻意的选择：
 *   ① **没有暗底**（不像选所 / 设置那样铺 `.pick-back`）—— 它不是「可以点外面关掉的菜单」，
 *      是这一局的入口，必须点「开始交易」才走；
 *   ② 弹窗期间**时钟不启动**（`main.js` 里 `clock.start()` 排在 `onIntro()` 之后），
 *      玩家读完再开盘，不浪费开局那几根 K 线。
 */
export function openIntro() {
  closePicker();
  const ov = document.getElementById('overlay');
  if (!ov) return;

  const box = el('div', 'confirm intro');
  box.append(el('h3', null, 'Degen · 加密交易员'));
  box.append(el('p', null,
    '2013 年 1 月，你带着 $3,000 走进门头沟。\n'
    + '这里没有救世主：行情 24 小时不睡，交易所会说没就没。\n'
    + '从门头沟活到币安，撑到 2024 年底 —— 那就叫赢。'));
  const go = el('button', 'act long', '开始交易');
  go.dataset.intro = '';
  const btns = el('div', 'confirm-btns');
  btns.append(go);
  box.append(btns);

  ov.append(box);
  ov.hidden = false;
  picker = ov;
}

/* ═════════════════════════ 设置面板（Batch 4 · B21） ═════════════════════════ */

/**
 * 设置。顶栏第三枚「重开」改叫「设置」之后点开的就是这里，目前只有两项：
 *   **① 音效开关**（偏好存 `degen_settings`，独立于存档 —— 重开不会把开关一起清掉）
 *   **② 重开本局**（**面板内双重确认**：第一次点变「确认重开」，3 秒不点自动还原）
 *
 * ⚠️ 双重确认的**状态机在 `main.js`**（`onReset` / `cancelReset`），不在这里：
 *    面板是静态 DOM、不参与每帧重绘，把「已武装」这个状态放进渲染层只会两处打架。
 *    这里只负责把按钮画出来（初始文案「重开本局」）。
 * @param {boolean} muted 当前是否静音（由 `sound.js` 持有）
 */
export function openSettings(muted) {
  closePicker();
  const ov = document.getElementById('overlay');
  if (!ov) return;

  const back = el('div', 'pick-back');
  const box = el('div', 'confirm');
  box.append(el('h3', null, '设置'));

  const rows = el('div', 'confirm-rows');
  const sRow = el('div', 'set-row');
  const sBtn = el('button', 'set-btn' + (muted ? '' : ' on'), muted ? '关' : '开');
  sBtn.dataset.snd = 'toggle';
  sRow.append(el('i', null, '音效'), sBtn);
  rows.append(sRow);
  box.append(rows);

  /* 两枚按钮都走 `.act flat`（中性灰）—— 重开是**破坏性**操作，武装后才转红（`.warn`），
     颜色变化的本身就是那一步确认的反馈。文案「重开本局」与「确认重开」都是 4 个字，
     切换时按钮宽度不跳。 */
  const reset = el('button', 'act flat', '重开本局');
  reset.dataset.reset = '';
  const off = el('button', 'act flat', '关闭');
  off.dataset.sclose = '';
  const btns = el('div', 'confirm-btns');
  btns.append(reset, off);
  box.append(btns);

  back.addEventListener('pointerdown', closePicker);
  ov.append(back, box);
  ov.hidden = false;
  picker = ov;
}

/** 首屏加载 / 报错面板（独立于 #app 主结构，挂了也能显示） */
export function renderBoot(text, err) {
  let box = document.querySelector('.boot');
  if (!box) {
    box = el('div', 'boot');
    document.body.append(box);
  }
  box.textContent = '';
  box.append(el('div', null, text));
  if (err) {
    const pre = el('pre', 'err', (err && (err.stack || err.message)) || String(err));
    const btn = el('button', 'ic', '清除存档并重开');
    btn.dataset.wipe = '';
    box.append(pre, btn);
  }
  return box;
}

export function hideBoot() {
  document.querySelector('.boot')?.remove();
}

/** 供调试：某个币的数据区间 */
export function debugRange(sym) {
  const r = rangeOf(sym);
  const coin = coinOf(sym);
  return { sym, range: r, unlock: coin ? coin.unlock : null };
}
