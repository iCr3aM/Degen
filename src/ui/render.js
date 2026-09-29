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
import { fmtCap, fmtDate, fmtHour, fmtLogPrice, fmtMoney, fmtMoneyShort, fmtPct, fmtQty, fmtRate, moneyTierHeld } from '../core/format.js';
import { available, chanOf, equity, futuresAvailable, markPrice, otcOpenFor, otcUnlocked, timeOf, totalUnrealized, unrealizedOf } from '../core/engine.js';
import { canLiquidate, isSpot, liquidationPrice, marginRateOf, safetyOf } from '../core/positions.js';
import { isLoaded, rangeOf, candleAt, rawCloseAt, supplyAt, HOURS_PER_DAY } from '../core/market.js';
import { arrivalCandles, confirmationsOf, congestionLabel, congestionOf } from '../core/congestion.js';
import { anchorAt, anchorsInRange, anchorOfAt } from '../core/anchors.js';
import { RV_SPEEDS } from '../core/review.js';
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
 * 游戏图标（本轮 ①）—— 与 `index.html` 的 favicon **同一副图案**：深底 ＋ 一根绿烛。
 *
 * 为什么内联 SVG 而不是一张 png：进游戏前那一屏必须是一个「完整的开机画面」，
 * 多一个外部资产就多一条会走丢的路径（favicon 本来就是 `data:` URI 一把梭）。
 * ⚠️ 颜色**不写死**：底色 / 烛色交给 `style.css` 的 `.menu-logo .bg` / `.menu-logo .c`
 *    （与 `chart.js` 从 CSS 变量取色同一条口径 —— 主题改一处，图标跟着变）。
 */
function logoEl() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'menu-logo');
  const rect = (x, y, w, h, c) => {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', x);
    r.setAttribute('y', y);
    r.setAttribute('width', w);
    r.setAttribute('height', h);
    r.setAttribute('class', c);
    return r;
  };
  // 深底 ＋ 影线（30,12,4,40）＋ 实体（24,20,16,24）—— 与 favicon 逐字相同
  svg.append(rect(0, 0, 64, 64, 'bg'), rect(30, 12, 4, 40, 'c'), rect(24, 20, 16, 24, 'c'));
  return svg;
}

/* ── 金额后缀的**迟滞**（⑥ · 方案 §20.3.3）──────────────────────────────
   活值每帧重算，纯门槛会在 `1e5 / 1e6 / 1e9` 边界上逐帧闪（`$999,999.9` ↔ `$1.0M`）——
   所以**升档立刻**、**降档要跌破上一档下沿的 90%** 才回落（判据在 `format.moneyTierHeld`，纯函数）。
   ⚠️ 记忆挂在模块级 `Map`（键 = 槽位），**不进存档** —— 与 `picker` / `tab` 是同一类 UI 态。
   ⚠️ 日志串**不走这里**：`pushLog` 之后文本已冻结，结构上不可能抖（方案 §20.3.3）。
   ⚠️ 死区内的固有代价：同一个数两种显示取决于「之前到过哪」—— 这是消抖的必付成本。 */
const slotTier = new Map();

function moneySlot(key, n, { sign = false } = {}) {
  if (!Number.isFinite(n)) return '--';
  const t = moneyTierHeld(slotTier.get(key), Math.abs(n));
  slotTier.set(key, t);
  return fmtMoneyShort(n, { sign, minTier: t });
}

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
  /* 币种右边两枚**次要读数**（本轮 ⑤）：市值 ＝ 流通量 × 标记价；流通 ＝ 该币的流通数量。
     都用 `<i>`（同 `.hud .cell i` / `.confirm-row i` 的用法：斜体复位、默认次要色）。
     ⚠️ **必须在同一行**：`.chart-head` 的实测高度就是 K 线的绘图上沿（`topInset`），
        多一行等于白白吃掉十几个像素的可画区。窄屏放不下时由 CSS 先压缩这两枚（省略号）。 */
  const chMcap = el('i');
  const chSupp = el('i');
  const chChg = el('span');
  const chartHead = el('div', 'chart-head');
  /* 粒度切换（Batch 3 · B12，拍板「K 线左上角遮罩里加一枚可点小字」）：
     字面是**当前**粒度，点一下切到另一种。做成 `button` 才有点击态，也为触屏留住命中面积。 */
  const modeBtn = el('button', 'chip');
  modeBtn.dataset.mode = 'toggle';
  chartHead.append(chSym, chMcap, chSupp, chChg, modeBtn);
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
     不带标签时就是原来那一条普通日志。槽位仍是 24px，固定块合计不变 —— 见 ⑤ 的裁决 ③。
     ⚠️ **整条可点**（⑤ · 方案 §20.2.1）：点开日志浮层看全 30 条 ——
        这一行只放得下一句被截尾的话，回看在浮层里做（`openLog`）。 */
  const newsTag = el('i', 'news-tag', '新闻');
  newsTag.hidden = true;
  /* 时间与正文**拆成两格**（2026-09-29 用户要求）：时间写 `00:00`（不套方括号）、**恒为次要灰**；
     正文按 `kind` 上色（`bad` 红 / `ok` 绿 / 其余灰）—— 与浮层 `.log-row` 是同一副样子。
     原来整行共用一个 class，时间会被正文的颜色一起染掉（爆仓那条连时间都是红的）。 */
  const logTime = el('u', 'num');
  const logText = el('span');
  const logline = el('div', 'logline');
  logline.dataset.log = '';
  logline.append(newsTag, logTime, logText);

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

  /* ── 回顾页（需求 4 ·《主菜单与历史回顾模式方案》§3）──
     去功能清单（方案 §3.1）：**没有**操作区 / HUD / 持仓条 / 交易所键 / 底部 Tab / 各种遮罩。
     顶上只留三样：日期（可点开年份跳转）、速度档（回顾专属 1x/10x/100x）、暂停 / 退出。
     ⚠️ 顶栏与 Tab 是**三页常驻**的（建在 `.page` 之外），所以进回顾时要靠 `#app.rv`
        把这两块藏掉（见 `showPage`）—— 不然回顾页会同时出现两套顶栏。
     ⚠️ 币种条与 K 线**各有自己一套节点**（不复用交易页那些）：两页的可见性互斥，
        复用同一份节点会让「隐藏页量尺寸为 0」那个坑复发（见 `draw()`）。 */
  const rvDate = el('button', 'ic rv-date');
  rvDate.dataset.review = 'years';
  const rvSpdBtns = new Map();
  const rvSpdBox = el('div', 'rv-spd');
  for (const v of RV_SPEEDS) {
    const b = el('button', 'opt', v + 'x');
    b.dataset.review = 'spd:' + v;
    rvSpdBox.append(b);
    rvSpdBtns.set(v, b);
  }
  const rvPause = el('button', 'ic', '暂停');
  rvPause.dataset.review = 'pause';
  const rvExit = el('button', 'ic', '退出');
  rvExit.dataset.review = 'exit';
  const rvTools = el('div', 'tools');
  rvTools.append(rvSpdBox, rvPause, rvExit);
  const rvTop = el('div', 'top rv-top');
  rvTop.append(rvDate, rvTools);

  /* 「自动跳过」开关（本轮 ②）—— 它取代了原来节点卡上那枚**不可逆**的「跳过全部」按钮。
     两条设计取舍：
       ① **放常驻顶栏下面单独一行**，不塞进 `rvTools`：rvTop 实测 336px（日期 90 ＋ 间隙 8
          ＋ rvTools 238），容器 366px 只剩 30px，第四枚塞不下 —— 硬塞会把日期挤到截尾。
          单开一行约 40px，从 K 线区扣（回顾页 K 线约 600px，扣得起）。
       ② **是一枚开关，不是一次动作**（`.ic` ＋ `.on` 那副样子，与「暂停」同一档）：
          开着 = 全程纯巡航（不弹卡也不减速），关掉立刻回到按节点减速 —— 随时可逆。 */
  const rvAuto = el('button', 'ic rv-auto', '自动跳过');
  rvAuto.dataset.review = 'all';
  const rvBar = el('div', 'rv-bar');
  rvBar.append(rvAuto);

  const rvSymbols = el('div', 'symbols');
  const rvSymBtns = new Map();
  for (const c of COINS) {
    const b = el('button', 'sym', c.sym);
    b.dataset.review = 'sym:' + c.sym;
    rvSymbols.append(b);
    rvSymBtns.set(c.sym, b);
  }

  const rvCanvas = el('canvas');
  const rvSym = el('b');
  const rvMcap = el('i');
  const rvSupp = el('i');
  const rvChg = el('span');
  const rvModeBtn = el('button', 'chip');
  rvModeBtn.dataset.mode = 'toggle';
  const rvHead = el('div', 'chart-head');
  rvHead.append(rvSym, rvMcap, rvSupp, rvChg, rvModeBtn);
  const rvWrap = el('div', 'chart-wrap');
  rvWrap.append(rvCanvas, rvHead);

  /* 日志栏**加长**（方案 §3.6）：回顾页没有操作区 / HUD / 持仓条，省下的高度全给它 ——
     固定几行常驻、超出就在面板内滚（与日志浮层同一套 `.log-row`，两个入口一副样子）。 */
  const rvLogs = el('div', 'rv-logs');

  const reviewPage = el('div', 'page review-page');
  reviewPage.append(rvTop, rvBar, rvSymbols, rvWrap, rvLogs);

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
  const pages = new Map([
    ['trade', tradePage], ['assets', assetsPage], ['settings', settingsPage],
    /* 回顾页也进这张表 —— `showPage` 的可见性开关只认它（方案 §3.2） */
    ['review', reviewPage],
  ]);

  root.append(top, tradePage, assetsPage, settingsPage, reviewPage, tabs);

  return {
    root, dateEl, titleEl, pauseBtn,
    exBtn, exName, exRate,
    eqVal, eqSub, cashVal, cashSub,
    symbols, symBtns,
    canvas, chartWrap, chartHead, chSym, chMcap, chSupp, chChg, modeBtn, chartEta, chartLock,
    posbar, posSide, posPnl, posRate,
    logline, newsTag, logTime, logText,
    fracBtns, levRow, levBtns, spdBtns, tradeModeBtn,
    chanBtn, buyBtn, sellBtn, longBtn, shortBtn, closeBtn,
    pages, tabBtns, asTotal, asNote, asList,
    sndBtn, impBtn, hintBtn,
    /* 回顾页（需求 4 · 方案 §3） */
    rvTop, rvBar, rvAuto, rvDate, rvPauseBtn: rvPause, rvSpdBtns, rvSymBtns,
    rvWrap, rvCanvas, rvHead, rvSym, rvMcap, rvSupp, rvChg, rvModeBtn, rvLogs,
    _levSignature: '',
    _posListSig: null,
    _rvLogSig: '',
  };
}

/**
 * 切页 —— **可见性的唯一写入口**（`.page.on` ＋ Tab 高亮一起翻）。
 *
 * ⚠️ 它由 `main.js` 的 `draw()` 在**量 K 线尺寸之前**调用，而不是放在 `update()` 里：
 *    隐藏的 `.trade-page` 是 `display:none`，量出来是 0×0 —— 先切页、再量，尺寸才是真的。
 * @param {object} refs `mount()` 的返回值
 * @param {'trade'|'assets'|'settings'|'review'} name
 */
export function showPage(refs, name) {
  for (const [k, n] of refs.pages) n.classList.toggle('on', k === name);
  for (const [k, b] of refs.tabBtns) b.classList.toggle('on', k === name);
  /* 回顾页要把**三页常驻**的顶栏与 Tab 藏掉（`.page` 之外的节点，靠 `#app.rv` 这个开关）——
     不藏的话回顾页会顶着两套顶栏（一套交易页的交易所键、一套回顾自己的）。 */
  refs.root.classList.toggle('rv', name === 'review');
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
  refs.eqVal.textContent = moneySlot('eq', eq);
  refs.eqVal.className = 'num ' + (eq >= GAME.cash ? 'up' : 'down');
  /* 副行两个数**都带符号**（Batch 4 · B17）：正绿负红，与持仓盈亏同一口径。
     颜色写在这里而不是 CSS 默认值 —— 见 `style.css` 里 `.hud .cell u.up` 那段注释。 */
  refs.eqSub.textContent = `已实现 ${moneySlot('realized', s.realized, { sign: true })}`;
  refs.eqSub.className = 'num ' + (s.realized >= 0 ? 'up' : 'down');

  refs.cashVal.textContent = moneySlot('cash', available(s));
  /* 副行优先级：**有贷款时负债永远最该出现**（B30）—— 它是必须还的一笔钱，
     而「初始 $3,000」是个死常量、零信息量。剩几天按小时差向下取整。 */
  if (s.loan) {
    const left = Math.max(0, Math.ceil((s.loan.dueAt - s.i) / 24));
    refs.cashSub.textContent = `欠 ${moneySlot('owe', s.loan.owe)} · ${left}d`;
    refs.cashSub.className = 'num down';
  } else if (anyHeld(s)) {
    const u = totalUnrealized(s);
    refs.cashSub.textContent = `未实现 ${moneySlot('unreal', u, { sign: true })}`;
    refs.cashSub.className = 'num ' + (u >= 0 ? 'up' : 'down');
  } else {
    refs.cashSub.textContent = `初始 ${fmtMoney(GAME.cash)}`;
    refs.cashSub.className = 'num mut';
  }

  refs.exName.textContent = exchangeOf(s.ex)?.name ?? '--';
  /* 上帝模式的**常驻标识**（本轮 ④）：改过资金 / 跳过日期之后，玩家得随时看得出「这一局不干净」。
     一个金色的「Degen」比任何一次性提示都持久，而且不额外占地（它本来就是顶栏标题）。
     ⚠️ 写 `className` 而不是 `classList.toggle`：标题只有这一种着色，没有第二种状态要叠。 */
  refs.titleEl.className = s.god ? 'gold' : '';
  /* 第二行平时是费率；**有在途转账时临时换成倒计时**（P2-A）——
     顶栏只有 46px 余量（375px 屏），「拥堵 严重」这类词根本放不下，
     所以拥堵状态词只出现在选所弹层里，顶栏这一行只承担倒计时。
     ⚠️ 费率**着色**（本轮 ④）：四家所差 5 倍（Mt.Gox 0.20% ↔ Binance 0.04%），
        而这一行是全屏唯一显示它的地方 —— 不区分就等于把成本藏起来了。
        两档门槛直接落在真实数据上（≥0.20% 红 / ≥0.10% 金 / 其余留 mut 灰），
        与 `.pick-head` 的拥堵状态词同一套「两档门槛」写法，不引入新体系。
        ⚠️ 必须写成 `.top .ic.exbtn u.<色>` 这一级：`.top .ic.exbtn u`（0,3,1）压过全局
           `.gold`（0,1,0），直接挂类名会被 mut 灰吃掉（详见 `style.css` 那两条）。 */
  if (s.transfer) {
    refs.exRate.textContent = `→ 剩 ${Math.max(0, s.transfer.arriveAt - s.i)}h`;
    refs.exRate.className = '';
  } else {
    const fr = feeRateOf(s.ex);
    refs.exRate.textContent = `费率 ${fmtRate(fr, 2)}`;
    refs.exRate.className = fr >= 0.002 ? 'down' : fr >= 0.001 ? 'gold' : '';
  }

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
    refs.posPnl.textContent = moneySlot('pospnl', pnl, { sign: true });
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
      /* **三档颜色**（本轮 ⑥ · 用户拍板「像 OKX 一样」）—— 判据不是 `rate` 的绝对值，
         而是**按本仓自己的杠杆归一化的安全垫** `safetyOf`：
           开仓那一刻 = 1（满垫）、触及维持保证金率 = 0（该强平了）。
         ⚠️ 用绝对值会全错：100x 刚开出来时 `rate` 就是 1%，任何「< 5% 转红」的阈值都会
            让所有高杠杆仓位常年贴在红区，颜色不再携带任何信息。
         分档（与 `main.js` 那声预警同一个判据，不各写一份）：
           `> 0.5` 绿 · 安全 ｜ `0.2 ~ 0.5` 金 · 注意 ｜ `≤ 0.2` 红 · 危险 */
      const safe = safetyOf(p, posMark ?? 0);
      refs.posRate.className = 'num ' + (safe <= 0.2 ? 'down' : safe <= 0.5 ? 'gold' : 'up');
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
  /* ⚠️ 颜色只上在**正文**那一格（`refs.logText`）：时间恒为 `--mut`（颜色落点是 CSS 的
     `.logline > u`）。改这里就要连 CSS 一起看，两处是一件事。 */
  refs.logTime.hidden = !newsOn && !last;
  if (newsOn) {
    refs.logTime.textContent = fmtHour(GAME.start + news.at * HOUR_MS);
    refs.logText.textContent = `${news.title}${newsMove(news)}`;
    refs.logText.className = '';
    refs.logline.className = 'logline news';
  } else {
    refs.logTime.textContent = last ? fmtHour(GAME.start + (last.at ?? s.i) * HOUR_MS) : '';
    refs.logText.textContent = last ? last.text : '—';
    refs.logText.className = last ? (last.kind === 'bad' ? 'down' : last.kind === 'ok' ? 'up' : 'mut') : 'mut';
    refs.logline.className = 'logline';
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
        /* ≥50x 打一道风险色（本轮 ④）：杠杆是这一屏唯一「一眼看不出代价」的旋钮 ——
           50x 与 3x 的表面长得一模一样，而强平距离差了十几倍。
           一个红字只是提示，不改变任何行为；选中态仍走 accent
           （`.opt.risk` 写在 `.opt.on` **之前**，同优先级靠源码顺序让 `.on` 胜出）。 */
        b.classList.toggle('risk', v >= 50);
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
       同向那一枚禁掉（同一个币只许一条仓位，让它点出「已有持仓」的错误日志没有意义）。

     ⚠️ **暂停闸门**（本轮 ④）：暂停时**所有会动钱的操作**都画成禁用（`.act:disabled` 的 .45）——
       原来暂停只由 `main.js` 的分派层拦下并回一条日志 ⇒ 按钮**看起来仍然是能按的**，
       玩家的第一反应是「点了没反应」，而不是「现在是暂停」。画灰才是诚实的状态。
       ⚠️ 只禁**下单 / 平仓 / 换所 / 切通道**这四类（用户拍板）；杠杆档 / 金额档 / 切模式 /
          切币 / 切页 / 日志浮层 / 设置 / 上帝面板**照常可用**，所以这里一个字都不碰它们。
       ⚠️ `view.guide` 豁免：新手引导期间 `s.paused` 恒为真，而第 4 步正高亮着「买入」教玩家怎么用 ——
          把那一枚画成灰与引导自相矛盾（详见 `main.js` 里 `view.guide` 那段注释）。 */
  const frozen = s.paused && !view.guide;
  const tradable = !lockedUI && !frozen && mark != null && isLoaded(sym);
  const dir = cur ? cur.side : null;
  refs.longBtn.disabled = !(tradable && !cur);
  refs.shortBtn.disabled = !(tradable && !cur);
  refs.closeBtn.disabled = !cur || lockedUI || frozen;
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

  /* 换所键（顶栏那枚双行按钮）**同样吃暂停闸门**（本轮 ④）：换所是一笔要等好几根 K 线的
     链上转账，属于「会动钱」四类之一 —— 暂停时它必须也点不动，否则玩家会以为只有下单被拦。 */
  refs.exBtn.disabled = frozen;

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
  refs.chanBtn.disabled = !(unlocked && otcOpenFor(s)) || frozen;
  refs.chanBtn.textContent = chan === 'otc' ? 'OTC' : '盘口';
  refs.chanBtn.classList.toggle('on', chan === 'otc');

  /* 资产页（§6.2 ①②④ 的 v0）：总资产 ＋ 持仓列表。切到别的页就不写 —— 那是隐藏 DOM，
     而且这个列表是**重建**出来的，白建一遍不如不建。 */
  if (view.tab === 'assets') {
    refs.asTotal.textContent = moneySlot('eq', eq);
    refs.asTotal.className = 'num ' + (eq >= GAME.cash ? 'up' : 'down');
    refs.asNote.textContent = `已实现 ${moneySlot('realized', s.realized, { sign: true })}`;
    refs.asNote.className = 'num ' + (s.realized >= 0 ? 'up' : 'down');
    const listSig = posListSignature(s);
    if (listSig !== refs._posListSig) {
      refs._posListSig = listSig;
      buildPosList(refs.asList, s);
    }
  }
}

/**
 * K 线的**选项装配 ＋ 一次绘制**（需求 4 · 方案 §3.2 那个「唯一要碰交易页渲染的地方」）。
 *
 * 抽出来的唯一理由：回顾页要画**同一副 K 线**（同一份 `chart.js` / `view.js`），
 * 两处各写一份选项迟早会走样。**输出逐位相同** —— 这是纯抽取，没改任何取值。
 *
 * @param {object} o
 *   `canvas` / `head` 两个节点（回顾页各有一套，所以由调用方传进来）；
 *   `sym` / `i` 看哪个币的第几根；`view` 本帧尺寸；`mark` 标记价；
 *   `cur` 当前仓位（**回顾页恒传 null** —— 回顾没有持仓）；`seed` 细刻度种子；`liqTick` 致命一针
 * @returns {object} `windowFor` 的返回值（`mode` / `count` / `locked` / `right` / `liqSlot` 都要用）
 */
function chartOpts({ canvas, head, sym, i, view, mark, cur, seed, liqTick = null }) {
  const win = windowFor(sym, i, view.chartW, seed, liqTick);
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
  const effY = drawChart(canvas, {
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
       `getBoundingClientRect` 与 `main.js` 那次取尺寸落在同一帧，不额外多一次强制布局。 */
    topInset: head.getBoundingClientRect().height,
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
  return win;
}

/**
 * 币种右边那两枚读数（**市值 / 流通**，本轮 ⑤）—— 交易页与回顾页**共用同一份算法**。
 * 取不到（清单里没有这个币 / 行情还没加载）就返回空串：那一格自己消失，**不留 `--`**。
 *
 * ⚠️ 市值用 `mark`（**含**价格位移）：它是「这个币此刻值多少」的读数，必须与屏幕上那根现价一致。
 * ⚠️ 流通量走 `supplyAt` 的**线性插值**（`manifest.circulating` 是逐年几个锚点，不是逐日序列）。
 */
function capText(sym, i, mark) {
  const sup = supplyAt(sym, i);
  if (sup == null || mark == null || !(mark > 0)) return { mcap: '', supp: '' };
  return { mcap: `市值 ${fmtCap(sup * mark)}`, supp: `流通 ${fmtQty(sup)}` };
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
  const cap = capText(sym, s.i, mark);
  refs.chMcap.textContent = cap.mcap;
  refs.chSupp.textContent = cap.supp;
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
  const win = chartOpts({
    canvas: refs.canvas, head: refs.chartHead, sym, i: s.i, view, mark, cur, seed: s.seed, liqTick,
  });

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
    return `${sym}:${p.side}:${p.lev}:${isSpot(p) ? 's' : 'f'}:${p.entry}:${unrealizedOf(s, sym).toFixed(2)}`;
  }).join('|');
}

/**
 * 按**普通现货 / 杠杆现货 / 合约**三组列出全部持仓（§6.2 ④；本轮 ⑦ 由两组拆成三组）——
 * 用途是**跨币复盘**：一行一个币，「方向 ＋ 杠杆 ＋ 开仓价」在左、未实现盈亏在右。
 *
 * ⚠️ 现货为什么再拆一刀（用户 2026-09-29 拍板）：**普通现货（1x）与杠杆现货的风险不是一回事** ——
 *    前者只有币价归零才归零本金（`canLiquidate` 为假，永远没有强平线），后者借了钱 / 币、
 *    有维持保证金、会被强平。混在一组里，「哪些仓会被强平」这个最重要的问题一眼看不出来。
 * ⚠️ 与交易页那条持仓条不是重复（§14.7）：那条只看当前币、承担「风险仪表」的职责。
 * ⚠️ **开仓价**本轮加进来（用户拍板）：跨币复盘时「这笔单是贵还是便宜」必须能就地看出来，
 *    否则只有盈亏数字，换个币就不知道成本在哪。格式化走 `fmtLogPrice` —— 与日志串同一口径。
 */
function buildPosList(box, s) {
  box.textContent = '';
  const cash = [];   // 普通现货：1x
  const sLev = [];   // 杠杆现货：借来的钱 / 币，有强平线
  const fut = [];    // 合约
  for (const sym of heldSyms(s)) {
    const p = s.positions[sym];
    if (!isSpot(p)) fut.push(sym);
    else if (p.lev > 1) sLev.push(sym);
    else cash.push(sym);
  }

  if (!cash.length && !sLev.length && !fut.length) {
    box.append(el('div', 'pcard prow mut', '暂无持仓'));
    return;
  }

  for (const [label, syms] of [['普通现货', cash], ['杠杆现货', sLev], ['合约', fut]]) {
    if (!syms.length) continue;
    box.append(el('h4', null, label));
    const card = el('div', 'pcard');
    for (const sym of syms) {
      const p = s.positions[sym];
      const pnl = unrealizedOf(s, sym);
      /* 方向字面与交易页持仓条一一对应（v9 · §15.6 N4）：现货写「买入 / 卖出」、合约写「多 / 空」。 */
      const dirText = isSpot(p)
        ? `${p.side === 'long' ? '买入' : '卖出'} ${p.lev}x`
        : `${p.side === 'long' ? '多' : '空'} ${p.lev}x`;
      const row = el('div', 'prow');
      row.append(
        el('b', null, sym),
        el('span', 'mut', `${dirText} · 开仓 ${fmtLogPrice(p.entry)}`),
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

/**
 * 日志浮层（⑤ · 方案 §20.2.1，2026-09-29）：把日志条那一行**撑开**成 30 条。
 *
 * 为什么不常驻：日志条那 24px 是固定块的账（§20.1.2），撑开就得从 K 线区扣；
 * 而「回看历史」是**偶尔**的动作 ⇒ 复用 `#overlay` 那一套（与选所 / 二次确认同一个容器）。
 *
 * 三条拍板（§20.4）：
 *   ① 列 **30 条**（`LOG_MAX` 是 60，取一半足够回看一局的重要节点）；
 *   ② **点暗底关闭**，不给关闭按钮（多一枚按钮 = 多一处要读的字）；
 *   ③ 正文**允许折行** —— 这正是它存在的理由（日志条那句被截尾的话在这里要读全）。
 * ⚠️ 只读 `s.log`，不写任何状态 ⇒ 与时间推进、存档都无关。
 */
export function openLog(s, onClose) {
  closePicker();
  const ov = document.getElementById('overlay');
  if (!ov) return;

  const back = el('div', 'pick-back');
  const box = el('div', 'logs');
  box.append(el('h3', null, '日志'));

  const list = el('div', 'log-list');
  for (const e of s.log.slice(0, 30)) {
    const row = el('div', 'log-row ' + (e.kind === 'bad' ? 'down' : e.kind === 'ok' ? 'up' : 'mut'));
    row.append(el('u', null, fmtHour(GAME.start + (e.at ?? s.i) * HOUR_MS)), el('span', null, e.text));
    list.append(row);
  }
  if (!list.childElementCount) list.append(el('div', 'log-row mut', '—'));
  box.append(list);

  /* ⚠️ 关闭走**回调**而不是直接 `closePicker`（2026-09-29 需求 2）：`closePicker` 被选所 /
     二次确认 / 切页多处共用，不能在它里面恢复时钟（关个选所弹层就解除暂停是错的）。
     只有日志浮层这个入口知道要「关了就 1x 续跑」。 */
  back.addEventListener('pointerdown', () => { closePicker(); if (onClose) onClose(); });
  ov.append(back, box);
  ov.hidden = false;
  picker = ov;
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

  /* 整屏暗底（本轮 ①）—— 与主菜单同一块 `.menu-back`：开场白与主菜单是**连着的两屏**，
     中间不该出现「一屏有暗底、下一屏没有」的跳变。盒子本身仍是居中的 `.confirm`。 */
  const back = el('div', 'menu-back');
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

  ov.append(back, box);
  ov.hidden = false;
  picker = ov;
}

/**
 * 主菜单（需求 4 ·《主菜单与历史回顾模式方案》§2，2026-09-29）。`boot()` 走完**一律先弹它**，
 * 三个入口决定后续：开始游戏 / 继续游戏（仅在有档时出现）/ 历史回顾。
 *
 * ⚠️ **整屏**（本轮 ① · 用户拍板）：铺满全屏的暗底 ＋ 居中一列（图标 / 标题 / 副标题 / 三入口）。
 *    之前它沿用 `.confirm`（`left/right:12px` 的一张小卡、且不铺暗底）—— 那副样子读起来像
 *    「页面中间弹了个提示」，不像**开机画面**。现在背后那层 `.menu-back` 把这个游戏彻底盖住。
 *    但它**仍然不是「点外面能关掉的菜单」**：`.menu-back` 不带 `pointerdown` 回调，点了不会关。
 * ⚠️ 弹窗期间时钟不启动（`main.js` 的 `clock.start()` 排在 `onMenu` 之后）。
 * ⚠️ 「继续游戏」在**没有存档**时整枚不出现（LESS IS MORE：没有的选项不显示）；
 *    「开始游戏」在有档时会先变「确认重开」（双重确认的状态机在 `main.js`，理由同 `onReset`）。
 */
export function openMenu({ canContinue = false } = {}) {
  closePicker();
  const ov = document.getElementById('overlay');
  if (!ov) return;

  const back = el('div', 'menu-back');
  const box = el('div', 'menu-box');
  /* 图标在最上面（本轮 ①）：与 favicon 同一副图案，内联 SVG（见 `logoEl`）。 */
  box.append(logoEl());
  box.append(el('h3', null, 'Degen · 加密交易员'));
  box.append(el('p', null,
    '2013 年 1 月 → 2024 年 12 月。\n'
    + '行情就是真实历史，没人替你兜底。'));

  const btns = el('div', 'menu-btns');
  const start = el('button', 'act long', '开始游戏');
  start.dataset.menu = 'start';
  btns.append(start);
  if (canContinue) {
    const cont = el('button', 'act flat', '继续游戏');
    cont.dataset.menu = 'continue';
    btns.append(cont);
  }
  const review = el('button', 'act chan', '历史回顾');
  review.dataset.menu = 'review';
  btns.append(review);
  box.append(btns);

  ov.append(back, box);
  ov.hidden = false;
  picker = ov;
}

/* ═════════════════════════ 新手分步引导（本轮 ④） ═════════════════════════ */

/**
 * 一步引导：把**目标控件**用主色框圈出来（框外整片压暗），底下给一句话 ＋ 一枚「下一步」。
 *
 * 三条刻意的选择：
 *   ① **不用 `.pick-back` 暗底、改用环形阴影**：盒子本身透明，`box-shadow` 半径开到 9999px，
 *      于是框外全暗、框内全亮 —— 一个元素同时做到「暗底 ＋ 挖洞」；
 *   ② 整个 `#overlay` 照旧铺满全屏、吃点击 ⇒ 引导期间底下那些键点不到，
 *      玩家只能按「下一步」往前走（也就不会误开一个弹层把引导挤掉）；
 *   ③ 目标由调用方给**节点**（`main.js` 从 `refs` 里取），这里只量它的外接矩形。
 *
 * ⚠️ 位置**只量一次**：引导期间游戏是暂停的（`main.js` 起手就 `s.paused = true`），
 *    界面尺寸不会变，不需要每帧跟着目标重算。
 * @param {Element} target 要圈出来的控件
 * @param {string} text 一句话说明（含「第 N / M 步」前缀由调用方拼好）
 * @param {boolean} isLast 末步 ⇒ 按钮文案换成「开始交易」
 */
export function openGuide(target, text, isLast) {
  closePicker();
  const ov = document.getElementById('overlay');
  if (!ov || !target) return;

  const ring = el('div', 'guide-ring');
  const r = target.getBoundingClientRect();
  ring.style.left = `${r.left}px`;
  ring.style.top = `${r.top}px`;
  ring.style.width = `${r.width}px`;
  ring.style.height = `${r.height}px`;

  const box = el('div', 'guide-box');
  box.append(el('p', 'guide-text', text));
  const btns = el('div', 'confirm-btns');
  const btn = el('button', 'act long', isLast ? '开始交易' : '下一步');
  btn.dataset.guide = 'next';
  btns.append(btn);
  box.append(btns);

  ov.append(ring, box);
  ov.hidden = false;
  picker = ov;
}

/* ═════════════════════════ 历史回顾（需求 4 · 方案 §3） ═════════════════════════ */

/**
 * 回顾页每帧写入口（需求 4 ·《主菜单与历史回顾模式方案》§3）。
 *
 * ⚠️ 它与 `update()` 是**两条渲染线**：回顾态下 `.trade-page` 是 `display:none`，
 *    交易页那些块一个字都不该被写。
 * ⚠️ **只读**：不碰 `s`、不写存档、不判破产 —— 状态全在 `main.js` 的 `rv`（模块级变量）里。
 * ⚠️ 回顾**没有持仓**，所以 `chartOpts` 的 `cur` 恒传 `null`（图上不画开仓线 / 强平线）。
 * @param {object} rv `{ i, sym, speed, paused, log }`
 */
export function renderReview(refs, rv, view) {
  const now = GAME.start + rv.i * HOUR_MS;
  refs.rvDate.textContent = fmtDate(now, false);
  refs.rvPauseBtn.textContent = rv.paused ? '继续' : '暂停';
  refs.rvPauseBtn.classList.toggle('on', rv.paused);
  /* 「自动跳过」开关态（本轮 ②）—— 文案不变，只靠 `.on` 那一圈主色表达开 / 关
     （与「暂停」同一套写法：那枚也是文案在变、高亮表示「生效中」）。 */
  refs.rvAuto.classList.toggle('on', rv.auto);
  for (const [v, b] of refs.rvSpdBtns) b.classList.toggle('on', rv.speed === v);

  /* 币种条：**可切**（拍板 2）—— 但那个币此刻还没上线就点不动（与交易页同一条口径）。
     回顾不画解锁进度环（那是「离解锁还有多久」的玩法表达，回顾里没有意义）。 */
  for (const c of COINS) {
    const b = refs.rvSymBtns.get(c.sym);
    b.classList.toggle('on', rv.sym === c.sym);
    b.disabled = now < c.unlock;
  }

  const sym = rv.sym;
  const mark = isLoaded(sym) ? (candleAt(sym, rv.i)?.c ?? null) : null;
  const prev = candle24(sym, rv.i);
  refs.rvSym.textContent = sym;
  const cap = capText(sym, rv.i, mark);   // 市值 / 流通：与交易页同一份读数（本轮 ⑤）
  refs.rvMcap.textContent = cap.mcap;
  refs.rvSupp.textContent = cap.supp;
  if (mark != null && prev) {
    refs.rvChg.textContent = `24h ${fmtPct(mark / prev - 1)}`;
    refs.rvChg.className = mark >= prev ? 'up' : 'down';
  } else {
    refs.rvChg.textContent = '';
  }

  const win = chartOpts({
    canvas: refs.rvCanvas, head: refs.rvHead, sym, i: rv.i, view, mark, cur: null, seed: GAME.seed,
  });
  refs.rvModeBtn.textContent = win.mode === '1d' ? '1日' : win.mode === '1t' ? '30秒' : '1h';

  /* 回顾日志（加长的那一栏）：只在**最新一条**变化时重建（与资产页那个列表同一套签名写法）。
     倒序铺 —— 最新在上，与交易页日志条同向。
     ⚠️ 时间前缀只写**日期**（本轮 ⑧ · 用户拍板）：回顾跨度是 12 年，时分没有任何信息量；
        交易页那条日志写时分是因为它讲的是「今天几小时前」，两者口径本来就不同。 */
  /* ⚠️ 签名里必须带上**条数**（本轮 ③）：跳年份会先把日志清空再补一条「跳到 X 年」，
     若只认「末条的 `at|text`」，玩家从某年跳回**同一年**时末条文案完全一样、签名不变 ⇒
     面板不重建，清空这一步就被静默吞掉了。带上长度，清空本身就是一个新签名。 */
  const top = rv.log[rv.log.length - 1];
  const sig = `${rv.log.length}|${top ? top.at : ''}|${top ? top.text : ''}`;
  if (sig !== refs._rvLogSig) {
    refs._rvLogSig = sig;
    refs.rvLogs.textContent = '';
    for (let k = rv.log.length - 1; k >= 0; k--) {
      const e = rv.log[k];
      const row = el('div', 'log-row ' + (e.kind === 'bad' ? 'down' : e.kind === 'ok' ? 'up' : 'mut'));
      row.append(el('u', null, fmtDate(GAME.start + e.at * HOUR_MS, false)), el('span', null, e.text));
      refs.rvLogs.append(row);
    }
    if (!refs.rvLogs.childElementCount) refs.rvLogs.append(el('div', 'log-row mut', '—'));
  }
}

/**
 * 节点卡（方案 §3.5）—— 命中关键节点时暂停 ＋ 弹出的一张史实卡。
 * 复用 `.confirm` 那副弹层骨架；**不给暗底**（无 `.pick-back`）：它不是「点外面能关掉的菜单」，
 * 必须在两枚按钮里选一个才走 —— 与主菜单 / 开场叙事同一条。
 *
 * 两枚：**继续**（恢复巡航）/ **跳过**（本节点不再弹）。
 * ⚠️ 原来还有第三枚「跳过全部」（一键压到纯巡航）—— 本轮 ② 把它**挪去顶栏做成常驻开关**
 *    （`rv-bar` 的「自动跳过」）：那枚按钮一旦点过就`rv.seen` 永久填满、**不可逆**，
 *    玩家想回头重看这个节点已经不可能了；开关则可以随时关回去。
 */
export function openNodeCard(node) {
  closePicker();
  const ov = document.getElementById('overlay');
  if (!ov) return;

  const box = el('div', 'confirm nodecard');
  /* 标题行带上**这件事讲的币**（本轮 ⑨）：图上已经切到那个币了，卡面说清楚是哪张图 ——
     否则「SOL 回到 $120」这类标题在 BTC 的语境里会让人以为图没切过去。 */
  const when = fmtDate(GAME.start + node.at * HOUR_MS, false);
  box.append(el('h3', null, node.sym ? `${when} · ${node.sym}` : when));
  box.append(el('p', null, node.note ? `${node.title}\n${node.note}` : node.title));

  const go = el('button', 'act long', '继续');
  go.dataset.review = 'go';
  const skip = el('button', 'act flat', '跳过');
  skip.dataset.review = 'skip';
  const btns = el('div', 'confirm-btns');
  btns.append(go, skip);
  box.append(btns);

  ov.append(box);
  ov.hidden = false;
  picker = ov;
}

/**
 * 年份跳转（方案 §3.3 的「可切日期」；§9.3 的交互形态在此定为**年份小格**）。
 * 12 年 × 一格，跳过去落在那一年的 1 月 1 日 00:00 —— 日粒度是回顾能表达的最细跨度。
 */
export function openYearPick(curYear) {
  closePicker();
  const ov = document.getElementById('overlay');
  if (!ov) return;

  const back = el('div', 'pick-back');
  const box = el('div', 'confirm');
  box.append(el('h3', null, '跳到年份'));
  const grid = el('div', 'year-grid');
  for (let y = 2013; y <= 2024; y++) {
    const b = el('button', 'opt', String(y));
    b.dataset.review = 'year:' + y;
    if (y === curYear) b.classList.add('on');
    grid.append(b);
  }
  box.append(grid);

  back.addEventListener('pointerdown', closePicker);
  ov.append(back, box);
  ov.hidden = false;
  picker = ov;
}

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
