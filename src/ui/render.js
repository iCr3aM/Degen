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

import { GAME, COINS, EXCHANGES, SPEEDS, coinOf, exchangeOf, hasFinancingAt, leverageOptionsAt, feeRateOf, HOUR_MS, LOAN, loanAmountAt } from '../core/config.js';
import { fmtDate, fmtHour, fmtMoney, fmtPct, fmtRate } from '../core/format.js';
import { available, chanOf, equity, futuresAvailable, markPrice, otcOpenFor, otcUnlocked, timeOf, totalUnrealized, unrealizedOf } from '../core/engine.js';
import { canLiquidate, isSpot, liquidationPrice, marginRateOf } from '../core/positions.js';
import { isLoaded, rangeOf, candleAt, rawCloseAt, HOURS_PER_DAY } from '../core/market.js';
import { arrivalCandles, confirmationsOf, congestionLabel, congestionOf } from '../core/congestion.js';
import { anchorAt, anchorsInRange, anchorOfAt } from '../core/anchors.js';
import { anyHeld, heldSyms, posOf } from '../core/state.js';
import { ticksPerHour } from '../core/simulate.js';
import { drawChart } from './chart.js';
import { windowFor, setYPx } from './view.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * 新闻条尾部的**真实涨跌幅**（P2-C ①·补 ＋ 口径 D，2026-09-29 拍板）：**事件当天**的极端值，
 * **从数据包现算**。
 *
 * 口径（用户拍板 D）：当日（`[at, at + 24)`）相对**前一日收盘**的**最高 / 最深**涨跌幅，
 * **方向随收盘走** —— 当天收红就报最高涨（「单日翻倍」是 +40%，而不是「最深 −0.2%」），
 * 收绿就报最深跌（Mt.Gox / 新冠崩盘那几条才显示得出 −19% / −39%）。
 * 只报「最深跌」会把上涨类锚点全报成近乎零的噪声（实测 20 条里近一半与标题相反）。
 *
 * ⚠️ **无前视**：这个数要等当天 24 根全部走完才存在，所以新闻整段后移一天（`anchors.NEWS_DELAY`）。
 * ⚠️ 走 `rawCloseAt`（不含价格位移）：那是玩家自己的单，与「历史上发生了什么」无关。
 * 取不到（该币此刻还没上线 / 行情未加载）时整段省略 —— 不报一个半截的数。
 */
function newsMove(news) {
  const sym = news.chain === 'eth' ? 'ETH' : 'BTC';
  const base = rawCloseAt(sym, news.at - 1);
  if (!(base > 0)) return '';

  let hi = -Infinity;
  let lo = Infinity;
  let last = 0;
  for (let k = 0; k < HOURS_PER_DAY; k++) {
    const c = rawCloseAt(sym, news.at + k);
    if (!(c > 0)) return '';
    const r = c / base - 1;
    if (r > hi) hi = r;
    if (r < lo) lo = r;
    last = r;
  }
  return ` ｜ ${sym} ${fmtPct(last >= 0 ? hi : lo, 1)}`;
}

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
  /* 顶栏标题**同时是上帝模式的隐藏入口**（连点 5 次 · 方案 §2.1）。
     它挂 `data-god` 不为别的：`bind.js` 只派发带 `data-*` 的元素，没有它就无从接住连点。
     连点计数与超时状态机在 `main.js`（与「重开本局」的双重确认同一个理由 —— 这里是静态 DOM）。 */
  const titleEl = el('b', null, 'Degen');
  titleEl.dataset.god = 'tap';
  who.append(titleEl, dateEl);
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
  /* 第三枚「设置」**已撤**（A6 · 方案 §6.2，2026-09-29）：设置不是「下单」也不是「盯盘」，
     语义上属**设置** ⇒ 整体搬去设置页（`.settings-page`）。顶栏只剩「交易所 / 暂停」两枚，
     加上 `.who` 一共四样，**三页常驻**（§6.2）。 */
  const tools = el('div', 'tools');
  tools.append(exBtn, pauseBtn);
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
  /* 模式键（U1 · ROADMAP §21.4；v9 · §15.6 N3 加条件）：铺在**「金额」行末尾**
     （用户裁决 —— 不新增行，保住 431px 固定块）。
     与通道键 / 粒度小字同一约定：**字面即现状**（显示「现货」就是现货模式）。
     ⚠️ v9 起它决定的是**整张杠杆表 ＋ 整行动作键的字面**（现货＝买入/卖出、合约＝做多/做空/平仓），
        不再是「只影响 1x 做多」那一个小开关。
     ⚠️ 该所此刻**没有合约**时整枚不出现（`futuresAvailable`）——「没有的选项不显示」。 */
  const tradeModeBtn = el('button', 'opt', '现货');
  tradeModeBtn.dataset.mode2 = 'toggle';
  fracRow.append(tradeModeBtn);

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
  /* 现货模式那两枚（v9 · §15.3 N4）：借 U 买入＝多、借币卖出＝空。
     ⚠️ 「卖出」**同时是平多**（现货模式没有独立的「平仓」键）—— 反向那一枚自己承担平仓：
        手上没有仓位时它是开仓，持有反向仓时它是平仓（分派逻辑见 `main.js` 的 `d.buy` / `d.sell`）。
     ⚠️ 与 做多/做空/平仓 **互斥显示**：模式一变，这五枚里只留三枚（「没有的选项不显示」）。
        两组在 DOM 里的顺序已经排好，隐藏一组不会打乱剩下那组的次序。 */
  const buyBtn = el('button', 'act long', '买入');
  buyBtn.dataset.buy = '';
  const sellBtn = el('button', 'act short', '卖出');
  sellBtn.dataset.sell = '';
  /* 通道切换键（P2-B3 · GDD §15.3）：铺在底行最左。字面是**当前**通道，点一下切到另一种 ——
     与 K 线左上角那枚粒度小字同一约定，全屏只有一套「字面即现状」的切法。
     它是四枚里唯一的**方框**（其余三枚是实心块）：它不是「一次成交」，是「换一条成交路径」。
     未解锁（权益 ≤ $500 万）时 `hidden` —— 一个 $3,000 开局的玩家不该看见自己用不了的东西。
     权益够但当前币还没开通 OTC 时**禁用而不隐藏**（三级状态，见 `update()` 里那段注释）。 */
  const chanBtn = el('button', 'act chan', '盘口');
  chanBtn.dataset.chan = 'toggle';
  const actRow = el('div', 'row');
  actRow.append(chanBtn, buyBtn, sellBtn, longBtn, shortBtn, closeBtn);

  const trade = el('div', 'trade');
  trade.append(fracRow, levRow, spdRow, actRow);

  /* ══════════════ 三页框架（A6 · 方案 §6）══════════════
     三页只切**可见性**（`.page.on`），骨架仍然只建一次 —— 与全屏「只改文字与 class」同一条规矩。
     顶栏建在三个 `.page` **之外** ⇒ 它天然三页常驻（§6.2）。
     ⚠️ 隐藏页是 `display:none`，量出来的尺寸是 0：所以 K 线只在交易页画（见 `syncChart`），
        且**可见性必须在量尺寸之前落**（`main.js` 的 `draw()` 先调 `showPage`）。 */
  const tradePage = el('div', 'page trade-page');
  tradePage.append(hud, symbols, chartWrap, posbar, logline, trade);

  /* ── 资产页 v0（§6.2 的 ① 与 ④；② 曲线 / ③ 买U 属 Step 2）──
     先落「现有数据就能算的两样」：**总资产**（复用 `equity`）＋ **持仓列表**（现货 / 合约分组）。
     ⚠️ 与交易页那条持仓条**不是重复**（§14.7）：那条只看当前币、是开仓后的风险仪表；
        这里是**跨币复盘**。 */
  const asTotal = el('b', 'num');
  const asNote = el('u', 'num');
  const asBox = el('div', 'hud one');
  asBox.append(cell('总资产', asTotal, asNote));
  const asList = el('div', 'plist');
  const assetsPage = el('div', 'page assets-page');
  assetsPage.append(asBox, asList);

  /* ── 设置页（原设置弹层那三件，原封不动搬成页 · §6.2）──
     ⚠️ 两个开关的文案 / 高亮**每帧由 `update()` 从状态与偏好同步**，不在这里手改节点：
        页是静态 DOM，`onSoundToggle` 再手改一遍就会两处打架（从前弹层不参与重绘，才允许手改）。
     ⚠️ 「重开本局」的双重确认状态机仍在 `main.js`（`onReset` / `cancelReset`），理由同前。 */
  const sndBtn = el('button', 'set-btn on', '开');
  sndBtn.dataset.snd = 'toggle';
  const impBtn = el('button', 'set-btn on', '开');
  impBtn.dataset.impact = 'toggle';
  const hintBtn = el('button', 'set-btn on', '开');
  hintBtn.dataset.hint = 'toggle';
  const setCard = el('div', 'set-card');
  const sndRow = el('div', 'set-row');
  sndRow.append(el('i', null, '音效'), sndBtn);
  const impRow = el('div', 'set-row');
  impRow.append(el('i', null, '订单冲击'), impBtn);
  /* 新手提示（v11 · ③）：管破产预警遮罩这类**引导**内容（开局叙事不受它管）。 */
  const hintRow = el('div', 'set-row');
  hintRow.append(el('i', null, '新手提示'), hintBtn);
  setCard.append(sndRow, impRow, hintRow);
  const resetBtn = el('button', 'act flat', '重开本局');
  resetBtn.dataset.reset = '';
  /* 按钮必须包在 `.row` 里：`.act` 自己带 `flex: 1`，直接放进纵向 flex 的 `.page` 会被拉满整屏 */
  const resetRow = el('div', 'row');
  resetRow.append(resetBtn);
  const settingsPage = el('div', 'page settings-page');
  settingsPage.append(setCard, resetRow);

  /* ── 底部 Tab（44px · §6.1）──
     ⚠️ 这 44px **全部从 K 线区扣**：固定块合计 431 → 475px，K 线区 405 → 361px（390×844）。
        实机若觉得挤，先把 Tab 降到 40px —— **不动 HUD / 持仓条**。 */
  const tabs = el('div', 'tabs');
  const tabBtns = new Map();
  for (const [k, label] of [['trade', '交易'], ['assets', '资产'], ['settings', '设置']]) {
    const b = el('button', 'tab', label);
    b.dataset.tab = k;
    tabs.append(b);
    tabBtns.set(k, b);
  }
  const pages = new Map([['trade', tradePage], ['assets', assetsPage], ['settings', settingsPage]]);

  root.append(top, tradePage, assetsPage, settingsPage, tabs);

  return {
    root, dateEl, pauseBtn,
    exBtn, exName, exRate,
    eqVal, eqSub, cashVal, cashSub,
    symbols, symBtns,
    canvas, chartWrap, chartHead, chSym, chChg, modeBtn, chartEta, chartLock,
    posbar, posSide, posPnl, posRate,
    logline, newsTag, logText,
    fracBtns, levRow, levBtns, spdBtns, tradeModeBtn,
    chanBtn, buyBtn, sellBtn, longBtn, shortBtn, closeBtn,
    pages, tabBtns, asTotal, asNote, asList,
    sndBtn, impBtn, hintBtn,
    _levSignature: '',
    _posListSig: null,
  };
}

/**
 * 切页 —— **可见性的唯一写入口**（`.page.on` ＋ Tab 高亮一起翻）。
 *
 * ⚠️ 它由 `main.js` 的 `draw()` 在**量 K 线尺寸之前**调用，而不是放在 `update()` 里：
 *    隐藏的 `.trade-page` 是 `display:none`，量出来是 0×0 —— 先切页、再量，尺寸才是真的。
 * @param {object} refs `mount()` 的返回值
 * @param {'trade'|'assets'|'settings'} name
 */
export function showPage(refs, name) {
  for (const [k, n] of refs.pages) n.classList.toggle('on', k === name);
  for (const [k, b] of refs.tabBtns) b.classList.toggle('on', k === name);
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
 * @param {object} view  `{ chartW, chartH, tab, muted }` —— K 线区实测尺寸 ＋ 当前页 ＋ 是否静音
 *   （后两项由 `main.js` 注入：它们一个是界面位置、一个是浏览器偏好，都不属于 `core` 的状态）
 */
export function update(refs, s, view) {
  const onTrade = view.tab === 'trade';

  refs.dateEl.textContent = fmtDate(timeOf(s));

  /* 顶栏按钮。⚠️ B30 的**待决态**（`s.pending`）下也要锁死：时钟已经停了，这时候
     「继续 / 暂停」和切页都不该可用 —— 玩家只有一个选择要回答（借，还是收摊）。
     ⚠️ 切页在 `main.js` 的 `onTab` 里也拦了一道（状态机不能只靠 DOM 兜底）。 */
  const lockedUI = !!s.over || !!s.pending;
  refs.pauseBtn.textContent = s.paused ? '继续' : '暂停';
  refs.pauseBtn.classList.toggle('on', s.paused);
  refs.pauseBtn.disabled = lockedUI;

  /* 设置页那三个开关（静态 DOM，不重建）：文案与高亮**只从这里写**。
     `view.muted` 由 `main.js` 注入（音效偏好归 `sound.js` 管，不是主状态）。 */
  refs.sndBtn.textContent = view.muted ? '关' : '开';
  refs.sndBtn.classList.toggle('on', !view.muted);
  refs.impBtn.textContent = s.impactOn ? '开' : '关';
  refs.impBtn.classList.toggle('on', s.impactOn);
  refs.hintBtn.textContent = s.hintOn ? '开' : '关';
  refs.hintBtn.classList.toggle('on', s.hintOn);

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
  /* ⚠️ **K 线只在交易页画**（A6 · 方案 §6.2）：另两页没有 K 线，`.trade-page` 是 `display:none`，
     量出来的画布尺寸是 0×0。不跳过的话 `windowFor(dw≈1)` 会算出畸形视野，还会把夹取后的
     `yPx` 反写回 `view.js`（污染那一段的真实位移）。 */
  if (onTrade) syncChart(refs, s, view, sym, cur, mark);

  /* 持仓条：只显示当前所选币；**无持仓也常驻**（三格填 `--`），见 mount() 的注释 */
  if (cur) {
    const p = cur;
    const posMark = markPrice(s, p.sym);
    refs.posSide.textContent = isSpot(p)
      /* 字面（v9 · §15.6 N4）：现货写「买入 / 卖出 Nx」—— 与操作区那两枚键一一对应。
         原来这里笼统写「现货」两个字，是因为现货恒为 1x 做多；§15.6 N2 起现货**也带杠杆、
         也能做空**，光写「现货」就说不清方向与倍数了。 */
      ? `${p.sym} ${p.side === 'long' ? '买入' : '卖出'} ${p.lev}x`
      : `${p.sym} ${p.side === 'long' ? '多' : '空'} ${p.lev}x`;
    refs.posSide.className = 'num ' + (p.side === 'long' ? 'side-long' : 'side-short');
    const pnl = unrealizedOf(s, p.sym);
    refs.posPnl.textContent = fmtMoney(pnl, { sign: true });
    refs.posPnl.className = 'num ' + (pnl >= 0 ? 'up' : 'down');
    /* 第三格**只剩保证金率**（Batch 2 · B9，2026-09-29）：原来这里是「保证金率 / 强平价」，
       格宽只有 1/3 屏，两个数一串必然被 `text-overflow` 截掉尾巴（用户实机发现）。
       强平价已搬到 K 线的开仓线左端标签，这一格终于能完整放下一个数。
       现货 **1x** 没有维持保证金率这一说 —— 只有币价归零才归零本金（GDD §9.1），填 `--`。
       ⚠️ v9（§15.3 N5）：判据从「是不是现货」换成 `canLiquidate` —— 现货**杠杆**仓照样有强平线。 */
    if (!canLiquidate(p)) {
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
    refs.logText.textContent = `[${fmtHour(GAME.start + news.at * HOUR_MS)}] ${news.title}${newsMove(news)}`;
    refs.logline.className = 'logline news';
  } else {
    refs.logText.textContent = last
      ? `[${fmtHour(GAME.start + (last.at ?? s.i) * HOUR_MS)}] ${last.text}`
      : '—';
    refs.logline.className = 'logline ' + (last ? (last.kind === 'bad' ? 'down' : last.kind === 'ok' ? 'up' : 'mut') : 'mut');
  }

  /* 金额档 */
  for (const [k, b] of refs.fracBtns) b.classList.toggle('on', Math.abs(s.sizeFrac - Number(k)) < 1e-9);

  /* 模式键（U1 · §21.4；v9 · §15.6 N3）：字面是**当前**模式。`合约` 时走 `.on` ——
     与通道键同一约定：偏离默认态（现货）才高亮，让玩家一眼看见「我这一单是合约」。
     ⚠️ **该所此刻没有合约时整枚不出现**，且一切按现货处理。
        `s.mode` 的回退在 `engine.normalizeLeverage` 里做 —— 渲染层**只读不写**状态。 */
  const futAvail = futuresAvailable(s);
  const fut = futAvail && s.mode !== 'spot';
  refs.tradeModeBtn.hidden = !futAvail;
  refs.tradeModeBtn.textContent = fut ? '合约' : '现货';
  refs.tradeModeBtn.classList.toggle('on', fut);

  /* 该所此刻开没开**融资**（v10）—— 一个数决定两件事：「卖出」能不能开空、杠杆行是不是置灰。
     ⚠️ 只查**现货表**，与当前模式无关 —— 合约做空是保证金交易，不需要借币。 */
  const canLev = hasFinancingAt(now, s.ex);

  /* 动作行（v9 · §15.3 N4）：「没有的选项不显示」——
     现货三枚（盘口 / 买入 / 卖出）、合约四枚（盘口 / 做多 / 做空 / 平仓），两组互斥。 */
  const spotMode = !fut;
  refs.buyBtn.hidden = !spotMode;
  refs.sellBtn.hidden = !spotMode;
  refs.longBtn.hidden = spotMode;
  refs.shortBtn.hidden = spotMode;
  refs.closeBtn.hidden = spotMode;

  /* 杠杆档：可选档位随「时间 ＋ 所选交易所 ＋ 模式」变化，签名变了才重建按钮。
     ⚠️ v9：两张表的上限不同（§15.1），切模式必须换一张 —— 所以 `kind` 要进签名。 */
  const kind = fut ? 'fut' : 'spot';
  const opts = leverageOptionsAt(now, s.ex, kind);
  /* 「有、但此刻点不动」的一行（v10 · ②）：现货模式下该所没有融资 ⇒ 可选档只剩一个 `1x`。
     **保留可见**（换所时不再忽隐忽现、K 线高度不跳），但整行走 `.off`（更暗 ＋ 虚线），
     点一下由 `main.js` 给一条「暂不可用 ｜ 为什么」。
     ⚠️ 用 `aria-disabled` 而不是 `disabled` —— 后者会连 `pointerdown` 一起吞掉，点了零反馈。 */
  const levOff = kind === 'spot' && !canLev;
  const sig = kind + ':' + opts.join(',') + '#' + s.lev + (levOff ? '!' : '');
  if (sig !== refs._levSignature) {
    refs._levSignature = sig;
    refs.levRow.querySelectorAll('.opt').forEach(n => n.remove());
    refs.levBtns.clear();
    for (const v of opts) {
      const b = el('button', 'opt', v + 'x');
      b.dataset.lev = String(v);
      if (levOff) {
        /* 置灰时**不给 `.on`** —— 蓝底 ＋ 虚线会长成第三种没有定义过的样子 */
        b.classList.add('off');
        b.setAttribute('aria-disabled', 'true');
      } else {
        b.classList.toggle('on', v === s.lev);
      }
      refs.levRow.append(b);
      refs.levBtns.set(v, b);
    }
  }

  /* 速度档 */
  for (const [v, b] of refs.spdBtns) b.classList.toggle('on', s.speed === v);

  /* 主按钮可用性。
     ⚠️ `lockedUI`（结束 / 待借贷决策）下一律不可用 —— 待决态只留遮罩上那两枚按钮。
     · 合约模式：做多 / 做空看「当前币还没仓位」，平仓看「当前币有仓位」（现状不变）
     · 现货模式（v9）：买入 / 卖出 **手上有仓位时也照样可用** —— 反向那一枚就是平仓；
       同向那一枚禁掉（同一个币只许一条仓位，让它点出「已有持仓」的错误日志没有意义）。 */
  const tradable = !lockedUI && mark != null && isLoaded(sym);
  const dir = cur ? cur.side : null;
  refs.longBtn.disabled = !(tradable && !cur);
  refs.shortBtn.disabled = !(tradable && !cur);
  refs.closeBtn.disabled = !cur || lockedUI;
  refs.buyBtn.disabled = !(tradable && dir !== 'long');
  /* 「卖出」＝开现货空单（要借币，v10）：该所没有融资时**空仓不许开空**。
     但手上若已经压着一张空单（只可能是旧档），「卖出」仍是它唯一的出口 ⇒ 必须能点，
     所以只挡「开空」这一种：`dir === null && !canLev`。
     ⚠️ 这种「点不动」同样走 `aria-disabled` ＋ `.off`（理由同杠杆行），点一下给一条解释。 */
  const sellOff = !dir && !canLev;
  refs.sellBtn.disabled = !(tradable && dir !== 'short' && !sellOff);
  refs.sellBtn.classList.toggle('off', sellOff);
  if (sellOff) refs.sellBtn.setAttribute('aria-disabled', 'true');
  else refs.sellBtn.removeAttribute('aria-disabled');

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

  /* 资产页（§6.2 ①②④ 的 v0）：总资产 ＋ 持仓列表。切到别的页就不写 —— 那是隐藏 DOM，
     而且这个列表是**重建**出来的，白建一遍不如不建。 */
  if (view.tab === 'assets') {
    refs.asTotal.textContent = fmtMoney(eq);
    refs.asTotal.className = 'num ' + (eq >= GAME.cash ? 'up' : 'down');
    refs.asNote.textContent = `已实现 ${fmtMoney(s.realized, { sign: true })}`;
    refs.asNote.className = 'num ' + (s.realized >= 0 ? 'up' : 'down');
    const listSig = posListSignature(s);
    if (listSig !== refs._posListSig) {
      refs._posListSig = listSig;
      buildPosList(refs.asList, s);
    }
  }
}

/**
 * K 线的**全部**绘制与浮字（从 `update()` 里整块抽出来，2026-09-29）—— 唯一理由：
 * 它只在交易页做（见 `update()` 里那段注释）。抽出来比在里面嵌一层 `if` 更好读，
 * 也避免了整个 `update()` 被推进一级缩进。
 * @param {number|null} mark 当前币标记价（`update()` 已经取过，不重复取）
 * @param {object|null} cur  当前币仓位
 */
function syncChart(refs, s, view, sym, cur, mark) {
  const prev = candle24(sym, s.i);
  refs.chSym.textContent = sym;
  if (mark != null && prev) {
    refs.chChg.textContent = `24h ${fmtPct(mark / prev - 1)}`;
    refs.chChg.className = mark >= prev ? 'up' : 'down';
  } else {
    refs.chChg.textContent = '';
  }

  /* 「致命那一针」（S3-附）：`view.liq` 是 `main.js` 的一句短记忆，只在它属于当前币时才算数 ——
     换算成**全局 tick 序号**（`hour × N + k`）交给视野，视野再按桶折算成槽位交给画布。
     只在细刻度档画（`view.js` 对粗档一律返回 `liqSlot: null`）。 */
  const liqTick = view.liq && view.liq.sym === sym
    ? view.liq.hour * ticksPerHour() + view.liq.k
    : null;
  const win = windowFor(sym, s.i, view.chartW, s.seed, liqTick);
  /* 锚点刻度（P2-C · 裁决 ④）：把锚点的**小时序号**换算成视野的**显示单位序号** ——
     日线模式下一根 = 一天，`floor(at / 24)` 才是它所在的槽位。越界的锚点交给 `chart.js` 丢掉
     （`count` 可能大于可用根数，这里的下界会算成负数）。
     ⚠️ **细刻度档不画锚点**（ROADMAP §19.6.6 ③）：锚点是小时级历史节点，2 ~ 12 小时的窗口里没有意义，
        而且省掉了「小时序号 → 桶槽位」这一层换算。 */
  let anchorMarks = [];
  if (win.mode !== '1t') {
    const hLo = win.mode === '1d' ? (win.right - win.count + 1) * HOURS_PER_DAY : win.right - win.count + 1;
    const hHi = win.mode === '1d' ? win.right * HOURS_PER_DAY + HOURS_PER_DAY - 1 : win.right;
    anchorMarks = anchorsInRange(hLo, hHi).map(a => ({
      d: win.mode === '1d' ? Math.floor(a.at / HOURS_PER_DAY) : a.at,
    }));
  }
  /* 图上唯一的入口：K 线、量柱、两条水平线都在这一笔里画。
     ⚠️ 返回值必须写回视野 —— 价格轴的平移限位夹在 `drawChart` 里（换算的唯一真源在那边），
        状态记的是**没夹过**的原始位移，不写回就会越夹越离谱。 */
  const effY = drawChart(refs.canvas, {
    candles: win.candles,
    vols: win.vols,
    /* 槽位数（= 视野要的根数）：柱宽按它算、柱子右对齐，币种刚上线时才不会一根撑满屏（B22）。
       细刻度档下它是**聚合后的桶数**（`win.count` 是 tick 数，不能直接当槽位用）。 */
    slots: win.slots,
    /* 历史锚点刻度（P2-C）—— 与最右那根一起交给图上换算槽位 */
    anchors: anchorMarks,
    right: win.right,
    /* 「致命那一针」（S3-附）：槽位号由 `view.js` 折算好；粗档恒为 null */
    liqSlot: win.liqSlot,
    /* 顶部留白 = 左上角遮罩的**实测**高度（Batch 5 · B27）：量不到时由 `chart.js` 退回自己的兜底常量。
       `getBoundingClientRect` 与 `main.js` 那次取 `chartWrap` 尺寸落在同一帧，不额外多一次强制布局。 */
    topInset: refs.chartHead.getBoundingClientRect().height,
    mark,
    entry: cur ? cur.entry : null,
    side: cur ? cur.side : null,
    /* 强平价交给图上的**开仓线左端标签**（Batch 2 · B9）。现货 1x 没有强平价 ⇒ 传 null。 */
    liq: cur && canLiquidate(cur) ? liquidationPrice(cur) : null,
    cssW: view.chartW,
    cssH: view.chartH,
    yPx: win.yPx,
  });
  if (effY !== win.yPx) setYPx(sym, effY);

  /* 粒度小字（Batch 3 · B12）：字面是当前粒度，点一下切到另一种（`main.js` 里定的目标档） */
  refs.modeBtn.textContent = win.mode === '1d' ? '1日' : win.mode === '1t' ? '30秒' : '1h';
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
}

/* ═════════════════════════ 资产页 · 持仓列表 ═════════════════════════ */

/**
 * 持仓列表的**签名** —— 列表是**重建**的，只在签名变化时重建（与杠杆档同一套写法）。
 * 签名里带上格式化后的盈亏，所以价格一动（在资产页点「继续」时会）数字跟着走。
 */
function posListSignature(s) {
  return heldSyms(s).map(sym => {
    const p = s.positions[sym];
    return `${sym}:${p.side}:${p.lev}:${isSpot(p) ? 's' : 'f'}:${unrealizedOf(s, sym).toFixed(2)}`;
  }).join('|');
}

/**
 * 按**现货 / 合约**分组列出全部持仓（§6.2 ④）—— 用途是**跨币复盘**：
 * 一行一个币，「方向 ＋ 杠杆」在左、未实现盈亏在右。
 * ⚠️ 与交易页那条持仓条不是重复（§14.7）：那条只看当前币、承担「风险仪表」的职责。
 * ⚠️ 组内写「方向 ＋ 倍数」：合约写 `多 20x` / `空 5x`，现货写 `买入 3.3x` / `卖出 2x`
 *    （v9 · §15.6 N4 —— 现货从 §15.6 起也带杠杆、也能做空，不再恒为「1x 做多」）。
 */
function buildPosList(box, s) {
  box.textContent = '';
  const spot = [];
  const fut = [];
  for (const sym of heldSyms(s)) (isSpot(s.positions[sym]) ? spot : fut).push(sym);

  if (!spot.length && !fut.length) {
    box.append(el('div', 'pcard prow mut', '暂无持仓'));
    return;
  }

  for (const [label, syms] of [['现货', spot], ['合约', fut]]) {
    if (!syms.length) continue;
    box.append(el('h4', null, label));
    const card = el('div', 'pcard');
    for (const sym of syms) {
      const p = s.positions[sym];
      const pnl = unrealizedOf(s, sym);
      const row = el('div', 'prow');
      row.append(
        el('b', null, sym),
        el('span', 'mut', isSpot(p)
          ? `${p.side === 'long' ? '买入' : '卖出'} ${p.lev}x`
          : `${p.side === 'long' ? '多' : '空'} ${p.lev}x`),
        el('b', 'num ' + (pnl >= 0 ? 'up' : 'down'), fmtMoney(pnl, { sign: true })),
      );
      card.append(row);
    }
    box.append(card);
  }
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

/**
 * 破产预警遮罩（v11 · ③）—— 会直接弄死人 / 重创杠杆仓的历史事件，提前 7 天出现，**时钟已停**。
 * 复用 `.over` 外壳（与借贷遮罩同一种语气：必须回答，不能点外面关掉）。
 *
 * ⚠️ **只陈述事实，不给行动建议**（拍板）：怎么应对是玩家的决策 —— 面板只说「7 天后有这么件事」。
 *    所以这里只有一条 `title`（来自锚点表，不额外写文案）＋ 一枚「知道了」。
 * ⚠️ 文案取自 `s.warnAt` 反查的锚点：`anchors.js` **不存 note**，所以能说的就是事件标题本身。
 * ⚠️ 这一帧只画一次（`s.paused` 期间不再有 `onFrame`），不需要去重重建。
 */
export function renderWarn(root, s) {
  root.querySelector('.over')?.remove();
  const box = el('div', 'over');
  const a = anchorOfAt(s.warnAt);
  const title = a ? a.title : '历史事件';

  box.append(
    el('b', 'down', '破产预警'),
    el('p', null, `${title}\n将在 7 天后发生`),
  );
  const ok = el('button', null, '知道了');
  ok.dataset.warn = '';
  const btns = el('div', 'over-btns');
  btns.append(ok);
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
 *      是这一局的入口，必须在两枚按钮里选一个才走；
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
  /* 两枚入口（v11 · ③）：**叙事对两者完全一致** —— 世界观不分新手老手，差别只在 `s.hintOn`。
     「新手」开提示（破产预警遮罩这类引导），「老手」关它。按钮**不写**「跳过 / 已了解」那种字眼，
     因为老手关掉的只是提示，不是叙事本身。 */
  const nw = el('button', 'act long', '我是新手');
  nw.dataset.intro = 'new';
  const vet = el('button', 'act flat', '我是老手');
  vet.dataset.intro = 'old';
  const btns = el('div', 'confirm-btns');
  btns.append(nw, vet);
  box.append(btns);

  ov.append(box);
  ov.hidden = false;
  picker = ov;
}

/* ═════════════════════════ 设置（Batch 4 · B21 → A6 改页） ═════════════════════════ */

/**
 * 设置原先是**弹层**（`openSettings`），A6（方案 §6.2，2026-09-29）起整体搬成**设置页**：
 *   **① 音效开关**（偏好存 `degen_settings`，独立于存档 —— 重开不会把开关一起清掉）
 *   **② 订单冲击开关**（方案 §2.7）—— 它是**玩法开关**，所以读的是状态 `s.impactOn`，不是偏好存档
 *   **③ 重开本局**（**页内双重确认**：第一次点变「确认重开」，3 秒不点自动还原）
 *
 * ⚠️ 三件东西的 DOM 都在 `mount()` 里一次建好（页是常驻骨架，不像弹层每次现建），
 *    两个开关的文案 / 高亮由 `update()` 每帧从状态同步。
 * ⚠️ 双重确认的**状态机仍在 `main.js`**（`onReset` / `cancelReset`）：页是静态 DOM、
 *    不参与每帧重绘，把「已武装」这个状态放进渲染层只会两处打架。
 * ⚠️ 这个页**没有「关闭」出口** —— 底部 Tab 就是出口（切回交易 / 资产）。
 */

/* ═════════════════════════ 上帝模式面板（隐藏入口 · 方案 §2） ═════════════════════════ */

/**
 * 上帝面板。入口是**连点顶栏「Degen」5 次**（计数与超时状态机在 `main.js`，
 * 与「重开本局」的双重确认同一个理由：这里是静态 DOM、不参与每帧重绘）。
 *
 * **只剩三件事**（2026-09-29 瘦身）：填入资金 / 跳到日期 / 关闭上帝模式。
 * ⚠️ 上帝模式与普通模式的全部差别就是这三条 ＋ `engine.checkRuin` 的归零不退出 ——
 *    原来那两套价格能力（「冲击倍率」`s.god.mult`、「手动砸盘 / 复位」`s.god.scale`）
 *    已整体删除：普通模式里看不到的暴涨暴跌全都出自它们，与「上帝模式只负责选时间、填资金」这条口径相悖。
 *
 * ⚠️ **日期框用原生 `<input type="date">`** —— 引第三方控件不值当，原生在手机上直接弹系统日期轮。
 *    但「跳到」不是改个数字：`main.js` 会拿 `advanceOneHour` **逐小时重放**过去，
 *    否则 Mt.Gox 归零、币解锁、借款到期这些事件会被整段跳过（等于白送一条命）。
 * ⚠️ **输入框不能挂 `data-*`**：`bind.js` 拦的是 `[data-*]` 的 `pointerdown` 并会 `preventDefault`，
 *    挂上去就打不了字了。所以值由动作处理函数从同一个面板里按类名读
 *    （`god-cash` / `god-date` —— 两个框都带 `god-in` 做样式，但**各有一个唯一类**，
 *     否则 `querySelector('.god-in')` 永远只能拿到排在前面的那个资金框）。
 */
export function openGod(s) {
  closePicker();
  const ov = document.getElementById('overlay');
  if (!ov) return;

  const back = el('div', 'pick-back');
  const box = el('div', 'confirm godp');
  box.append(el('h3', null, '上帝模式'));

  const rows = el('div', 'confirm-rows');

  /* ① 填入资金 —— 输入框**预填上次填的数**，于是归零之后点一下就补回来，不必再加第二枚按钮 */
  const cRow = el('div', 'set-row');
  const cashIn = el('input', 'god-in god-cash');
  cashIn.type = 'number';
  cashIn.inputMode = 'decimal';
  cashIn.min = '0';
  cashIn.step = '1000';
  cashIn.value = String(s.god.lastFill);
  const cBtn = el('button', 'set-btn on', '填入');
  cBtn.dataset.godcash = '';
  cRow.append(el('i', null, '资金'), cashIn, cBtn);
  rows.append(cRow);

  /* ② 跳到日期 —— **只许向前**（向后跳会让「未来开的仓」凭空出现在历史里） */
  const dRow = el('div', 'set-row');
  const dateIn = el('input', 'god-in god-date');
  dateIn.type = 'date';
  dateIn.min = '2013-01-01';
  dateIn.max = '2024-12-31';
  dateIn.value = fmtDate(timeOf(s), false);
  const dBtn = el('button', 'set-btn on', '跳到');
  dBtn.dataset.goddate = '';
  dRow.append(el('i', null, '日期'), dateIn, dBtn);
  rows.append(dRow);

  box.append(rows);

  const off = el('button', 'act flat', '关闭上帝模式');
  off.dataset.godoff = '';
  const close = el('button', 'act flat', '关闭');
  close.dataset.sclose = '';
  const btns = el('div', 'confirm-btns');
  btns.append(off, close);
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
