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

import { GAME, COINS, EXCHANGES, SCENARIOS, SPEEDS, USDT_LIVE, OTC, exchangeOf, haltedAt, hasFinancingAt, isChallenge, leverageOptionsAt, feeRateOf, HOUR_MS, loanAmountAt, scenarioOf, usdtPriceAt } from '../core/config.js';
import { fmtCap, fmtDate, fmtHour, fmtLogPrice, fmtMoney, fmtMoneyShort, fmtPct, fmtQty, fmtRate, moneyTierHeld } from '../core/format.js';
import { available, canCloseAt, canOpenAt, chanOf, equity, exMarkPrice, futuresAvailable, heatOf, lastPrice, openInterestOf, otcOpenFor, otcUnlocked, pauseLocked, retailLongShareOf, reviewDrawdownOf, reviewHeatOf, reviewVolOf, reviewVolUsdOf, timeOf, totalUnrealized, transferPlan, unrealizedOf, vol30Of, OVER } from '../core/engine.js';
import { HEAT } from '../core/god.js';
import { canLiquidate, isMargin, liquidationPrice, marginRateOf, safetyOf } from '../core/positions.js';
import { isLoaded, candleAt, supplyAt, HOURS_PER_DAY } from '../core/market.js';
import { levelsOf } from '../core/levels.js';
import { confirmationsOf, congestionLabel, congestionOf } from '../core/congestion.js';
import { NEWS_HOURS, anchorsInRange, anchorOfAt } from '../core/anchors.js';
import { RV_SPEEDS } from '../core/review.js';
import { LOG_TAGS, LOG_TAG_DEFAULT, anyHeld, heldSyms, posOf, slotOf } from '../core/state.js';
import { OVER_LABEL, badgesOf, multOf, titleOf } from '../core/titles.js';
import { drawChart, drawEquityCurve } from './chart.js';
import { windowFor, setYPx } from './view.js';
import { vibSupported } from './sound.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * 游戏图标（本轮 ① 重绘）—— 与 `index.html` 的 favicon **同一副图案**：
 * 深底 ＋ 三根迷你 K 线（左红右绿、逐根抬高的上升构图）。
 *
 * 为什么内联 SVG 而不是一张 png：进游戏前那一屏必须是一个「完整的开机画面」，
 * 多一个外部资产就多一条会走丢的路径（favicon 本来就是 `data:` URI 一把梭）。
 * ⚠️ 颜色**不写死**：底色 / 涨烛 / 跌烛交给 `style.css` 的 `.menu-logo .bg` /
 *    `.menu-logo .u` / `.menu-logo .d`（与 `chart.js` 从 CSS 变量取色同一条口径 ——
 *    主题改一处，图标跟着变）。
 * ⚠️ 改图案必须**三处同步**：这里、`index.html` 的 favicon、`tools/make-icons.mjs`
 *    生成的 `public/icon-192/512.png` —— 几何写死成同一组矩形。
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
  // 三根蜡烛的几何（viewBox 64×64）—— 与 favicon / `tools/make-icons.mjs` 逐字相同：
  //   柱宽 14、间隙 5、左右各留 6；影线宽 4、水平居中于实体。
  //   左红右绿，实体顶沿 33 → 20 → 11 逐根抬高，读作一条上升趋势。
  const candles = [
    // [影线 x,y,w,h]    [实体 x,y,w,h]    类别（涨/跌）
    [[11, 26, 4, 30], [6, 33, 14, 16], 'd'],
    [[30, 12, 4, 34], [25, 20, 14, 18], 'u'],
    [[49, 6, 4, 30], [44, 11, 14, 16], 'u'],
  ];
  svg.append(rect(0, 0, 64, 64, 'bg'));
  for (const [wick, body, cls] of candles) {
    svg.append(rect(...wick, cls), rect(...body, cls));
  }
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

/** **只在值真变了才写**（用户 2026-10-01 拍板的热路径减写）—— 逐帧无条件给
 *  `textContent` / `className` 赋值会让浏览器白白做一次样式失效与比对；日志条 / 持仓条 /
 *  顶栏这几处虽然每帧重算，但绝大多数帧的值是同一个。读 `textContent` / `className` 不触发布局。 */
const setText = (n, v) => { if (n.textContent !== v) n.textContent = v; };
const setCls = (n, v) => { if (n.className !== v) n.className = v; };

/** 重挂一个动画类，让那条 CSS 动画重播一遍（沿用总资产闪烁的既有做法，2026-10-03 提成函数）。
 *  `remove` 之后必须**强制一次样式重算**，否则同一帧内 `add` 回去浏览器会认为「没变过」。 */
function replay(n, cls) {
  n.classList.remove(cls);
  void n.offsetWidth;
  n.classList.add(cls);
}

/** 换值闪一下（`.flash`）：持仓条 / 总资产那一套。 */
const flash = n => replay(n, 'flash');

/**
 * 日志条显示几行（2026-10-03 用户拍板 **2**）—— 见 `logline` 的构建处。
 * ⚠️ 恒定行数（不是「有内容才长高」）：变高会带着 K 线区／下方内容一起跳。
 */
const LOG_ROWS = 2;

/**
 * 一条日志该用哪枚类别芯片。
 *
 * ⚠️ 老存档的条目没有 `tag`（那批数据写在 `LOG_TAGS` 存在之前）⇒ 按 `LOG_TAG_DEFAULT` 回退，
 *    所以两处渲染都**必须**走这个函数，不能直接读 `e.tag`。
 * ⚠️ **新闻会衰老**（P2-C 既有口径）：超过 `NEWS_HOURS` 就不该再顶着金底标签 —— 降级成 `sys`。
 */
function tagOf(e, nowI) {
  const t = e.tag || LOG_TAG_DEFAULT[e.kind] || 'sys';
  if (t === 'news' && nowI >= (e.at ?? nowI) + NEWS_HOURS) return 'sys';
  return t;
}

/** 正文颜色：只认 `kind`（`ok` 绿 / `bad` 红 / 其余灰）；`news` 的提亮交给 CSS 的 `.lg-row.news` */
const kindClsOf = kind => (kind === 'bad' ? 'down' : kind === 'ok' ? 'up' : 'mut');

/** 左上角遮罩（`.chart-head`）的**实测高度**缓存（用户 2026-10-01 拍板）—— 它只随容器宽度
 *  （换行）与文案总长变，逐帧 `getBoundingClientRect` 会白白强制一次布局。
 *  ⚠️ 键用「宽度 ＋ 文案总长」而不是数组引用：`sym` / 市值那几段每帧重建字符串，但**长度**
 *     几乎恒定（金额走 K/M/B 档位，宽度有界），所以命中率极高。 */
let headInsetKey = '';
let headInsetH = 0;
function headInset(head, chartW) {
  const key = `${chartW}|${head.textContent.length}`;
  if (key !== headInsetKey) {
    headInsetKey = key;
    headInsetH = head.getBoundingClientRect().height;
  }
  return headInsetH;
}

/** 左下角浮字底（`.chart-heat`）的**实测高度**缓存（2026-10-04 用户拍板「K 线底部腾一行」）——
 *  与 `headInset` 同一条思路：它只随容器宽度与文案总长变，逐帧量会白白强制一次布局。
 *  ⚠️ 它的高度在 `white-space: nowrap` ＋ 固定内边距下几乎是常数（一行 ≈ 22px），但**仍要实测**：
 *     字号走 `--ui` 缩放、`OI 12.3M` 与 `多空 62/38` 谁长谁短都不该让我写死一个像素值。
 *  ⚠️ 量的是 **chip** 而不是整条 `.chart-side`：后者还叠着两枚条件浮字（锁视野 / 在途倒计时），
 *     让它们参与留白就会「浮字一出现 K 线就跳」。恒在最底、恒占一行的只有 chip 这一块。 */
let footInsetKey = '';
let footInsetH = 0;
function footInset(chip, chartW) {
  const key = `${chartW}|${chip.textContent.length}`;
  if (key !== footInsetKey) {
    footInsetKey = key;
    footInsetH = chip.getBoundingClientRect().height;
  }
  return footInsetH;
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
  /* 顶栏标题**同时是上帝模式的隐藏入口**（方案 §2.1）：连点 5 次解锁；
     解锁之后（`s.god` 非空）**单击即可重开面板**（2026-10-01）。
     它挂 `data-god` 不为别的：`bind.js` 只派发带 `data-*` 的元素，没有它就无从接住点击。
     计数与超时状态机在 `main.js`（与「重开本局」的双重确认同一个理由 —— 这里是静态 DOM）。 */
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
  /* 市场热度（§73.5）＋ 派生量两枚（缺口 4 / 19）—— **一行三格**，格间一条细分隔线：
       [热度条] 恐慌 ｜ OI 12.3M ｜ 多空 62/38
     ⚠️ 一行而不是三行（2026-10-03 拍板）：原先热度 / OI / 多空各占一行，白吃掉 K 线
        左下角两行高。压成一行是把可画区还给 K 线；代价是 OI 去掉 `$` 前缀、
        `散户多空` 简写为 `多空` —— 只有这样才在 390px 屏上塞得下。
     ⚠️ 放左下角这一列（那时常空着），**不占** `.chart-head` 那一行的宽度 ——
        头部五行字在 390px 屏上已经排满，再插一枚会把粒度小字挤掉。
     ⚠️ 不多开面板（LESS IS MORE）：三格读数就挂在热度这一格里，共用同一块浮字底。 */
  const heatBar = el('i');
  const heatTxt = el('u');
  const heatRow = el('div', 'row');
  heatRow.append(heatBar, heatTxt);
  const oiTxt = el('u');
  const lsTxt = el('u');
  const heatChip = el('div', 'chart-heat');
  heatChip.append(heatRow, oiTxt, lsTxt);
  const chartSide = el('div', 'chart-side');
  chartSide.append(heatChip, chartEta, chartLock);
  const chartWrap = el('div', 'chart-wrap');
  chartWrap.append(canvas, chartHead, chartSide);

  /* ── 持仓条 ──
   ⚠️ **常驻**（2026-09-29）：无持仓时各格填 `--`，不再整条隐藏 ——
    K 线区是全屏唯一的弹性块，持仓条一显一隐会让 K 线高度开仓/平仓时来回跳。
   ⚠️ **三格**（2026-10-04 用户拍板删掉第四格「资金费 Nh后 / 费率」）：那一格报的是
    全市场读数、与本仓无关，且倒计时每根小时线都在变 ⇒ 信息量不抵它占掉的 1/4 屏宽。
    A3-d（2026-10-03）加的是它，本次连同 `setFundingCell` 一起删干净。 */
  const posSide = el('b', 'num');
  const posPnl = el('b', 'num');
  const posRate = el('b', 'num');
  const posbar = el('div', 'posbar');
  posbar.append(
    mini('持仓', posSide),
    mini('未实现盈亏', posPnl),
    mini('保证金率', posRate),
  );

  /* ── 日志条（**两行** · 2026-10-03 用户拍板）──
     ⚠️ 由「一行只放最新一条」改成**恒定两行**（24px → 48px）。起因：级联那一小时里
        「资金费率 → 爆仓潮 → ADL → 爆仓」四条连发，前面几条被顶掉、根本看不见。
        两行是**恒定**高度（不是有内容才长高）—— 变高会带着 K 线区一起跳。
     ⚠️ 每行拆成「类别芯片 ＋ 时间 ＋ 正文」三格（与浮层 `.log-row` 同一副样子）：
        · 芯片按 `tag` 取色（`LOG_TAGS` 六类），回答「这是哪一类事件」；
        · 正文按 `kind` 上色（`bad` 红 / `ok` 绿 / 其余灰），回答「这一笔是好是坏」。
        原来整行共用一个 class，时间会被正文的颜色一起染掉（爆仓那条连时间都是红的）。
     ⚠️ 类别为 `mkt`（全市场级：爆仓潮 / 归零 / 停机…）的那一行额外加 `alert`
        —— 2px 左边框 ＋ 淡红底，整屏扫一眼就能抓住。
     ⚠️ **整条可点**（⑤ · 方案 §20.2.1）：点开日志浮层看全 30 条 ——
        两行也只放得下被截尾的两句，回看在浮层里做（`openLog`）。 */
  const logRows = [];
  const logline = el('div', 'logline');
  logline.dataset.log = '';
  for (let r = 0; r < LOG_ROWS; r++) {
    const tag = el('i', 'log-tag');
    const time = el('u', 'num');
    const text = el('span');
    const row = el('div', 'lg-row');
    row.append(tag, time, text);
    logline.append(row);
    logRows.push({ row, tag, time, text });
  }

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
     与通道键 / 粒度小字同一约定：**字面即现状**（显示「杠杆」就是杠杆模式）。
     ⚠️ v9 起它决定的是**整张杠杆表 ＋ 整行动作键的字面**（杠杆＝买入/卖出、合约＝做多/做空/平仓），
        不再是「只影响 1x 做多」那一个小开关。
     ⚠️ 该所此刻**没有合约**时整枚不出现（`futuresAvailable`）——「没有的选项不显示」。 */
  const tradeModeBtn = el('button', 'opt', '杠杆');
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
  /* 杠杆模式那两枚（v9 · §15.3 N4）：借 U 买入＝多、借币卖出＝空。
     ⚠️ 「卖出」**同时是平多**（杠杆模式没有独立的「平仓」键）—— 反向那一枚自己承担平仓：
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
     未解锁（权益 ≤ $500 万）时 `hidden` —— 一个 $1,000 开局的玩家不该看见自己用不了的东西。
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

  /* ── 资产页（§6.2 ①②③④ 全部落地 · v13）──
     四块自上而下：**两格余额 → 资金曲线 → 买 U → 持仓列表**。
     ⚠️ 与交易页那条持仓条**不是重复**（§14.7）：那条只看当前币、是开仓后的风险仪表；
        这里是**跨币复盘**。 */
  /* ① 两格余额（v13 · 方案 §6）：美元 / 稳定币**分列两格** ＋ 一行合计。
     分列是要紧的 —— 「游戏内的 USDT 要和美元区分开」正是这一批的起点，而这个格
     是玩家唯一能一眼看清「我手上是哪种钱」的地方。 */
  /* ⑤ 账本抬头（方案 §6 D3）：**账是按所分的**（`books[ex]`），所以「上面这两个数是哪家所的」
     必须写在脸上，否则两格余额是悬空的。交易所切换键仍留在顶栏（不在这里放第二枚）——
     这一行是**只读摘要**。 */
  const asExName = el('b');
  const asExNote = el('u', 'num');
  const asHead = el('div', 'as-head');
  asHead.append(asExName, asExNote);
  const asUsd = el('b', 'num');
  const asUsdSub = el('u', 'num');
  const asUsdt = el('b', 'num');
  const asUsdtSub = el('u', 'num');
  const asSlots = el('div', 'hud');
  asSlots.append(
    cell('美元 USD', asUsd, asUsdSub),
    cell('稳定币 USDT', asUsdt, asUsdtSub),
  );
  const asTotal = el('b', 'num');
  const asNote = el('u', 'num');
  const asBox = el('div', 'hud one');
  asBox.append(cell('总资产', asTotal, asNote));
  /* 明细拆解（用户 2026-10-01 拍板 · 选项 A）：**不改任何口径**，只把「钱去哪了」摊开 ——
     总资产 = 现金 ＋ 持仓保证金 ＋ 未实现盈亏 ＋ 在途。这里给后两项（现金与浮盈
     已在上面两格与持仓条里）：已占用保证金 / 在途转账。
     两行都常驻（$0.00 也写出来）—— 条件显隐会让资产页随开平仓上下跳。 */
  const asBusy = el('b', 'num');
  const asOnway = el('b', 'num');
  const breakRow = (label, valEl) => {
    const r = el('div', 'eq-break-row');
    r.append(el('i', null, label), valEl);
    return r;
  };
  const asBreak = el('div', 'eq-break');
  asBreak.append(
    breakRow('已占用保证金', asBusy),
    breakRow('在途转账', asOnway),
  );
  /* ② 资金曲线（方案 §4；区间切换 ＋ 高低点 = 用户 2026-10-01 拍板）：`<canvas>` 高 110px。
     上方一排区间档（`eqrange`，`main.js` 分派），值 = 最近多少个游戏日、`0` = 全部。
     ⚠️ 与 K 线同一个坑：它是 canvas，容器一隐藏就量成 0 ⇒ 只在资产页可见时画。 */
  const eqRangeBtns = new Map();
  const eqRangeRow = el('div', 'row');
  for (const [v, label] of [['7', '1周'], ['30', '1月'], ['90', '3月'], ['365', '1年'], ['0', '全部']]) {
    const b = el('button', 'opt', label);
    b.dataset.eqrange = v;
    eqRangeRow.append(b);
    eqRangeBtns.set(v, b);
  }
  const asCurve = el('canvas', 'curve');
  const asCurveBox = el('div', 'curve-box');
  asCurveBox.append(eqRangeRow, asCurve);
  /* ③ 买 U（方案 §3.1）：价格 ＋ 金额档 ＋ 一枚「买入」。2014-11-20 之前整块不存在
     （那年头没有 U）—— 与「没有的选项不显示」同一条口径。 */
  const uPrice = el('i');
  const uHead = el('div', 'set-row');
  uHead.append(el('i', null, '买 U'), uPrice);
  const uFracBtns = new Map();
  const uFracRow = el('div', 'row');
  uFracRow.append(el('span', 'lbl', '金额'));
  for (const [f, label] of [[0.25, '1/4'], [0.5, '1/2'], [1, '全部']]) {
    const b = el('button', 'opt', label);
    b.dataset.buyu = String(f);
    uFracRow.append(b);
    uFracBtns.set(String(f), b);
  }
  const uBuyBtn = el('button', 'act flat', '买入');
  uBuyBtn.dataset.buyu = 'go';
  uFracRow.append(uBuyBtn);
  const uCard = el('div', 'set-card');
  uCard.append(uHead, uFracRow);
  const asList = el('div', 'plist');
  const assetsPage = el('div', 'page assets-page');
  assetsPage.append(asHead, asSlots, asBox, asBreak, asCurveBox, uCard, asList);

  /* ── 设置页（原设置弹层那几件，原封不动搬成页 · §6.2）──
     ⚠️ 所有偏好控件的文案 / 高亮**每帧由 `update()` 从状态与偏好同步**，不在这里手改节点：
        页是静态 DOM，处理器再手改一遍就会两处打架（从前弹层不参与重绘，才允许手改）。
     ⚠️ 「重开本局」的双重确认状态机仍在 `main.js`（`onReset` / `cancelReset`），理由同前。

     T-2（2026-10-01）：原来那枚「音效」开关键换成**三排档位组** ＋ 两个老开关 ——
       · 音量（关 / 小 / 中 / 大）—— 它**取代**音效开关，一个档位就是总闸，「关」＝静音；
       · 震动（关 / 弱 / 强）—— 只在触屏设备建这一行（`vibSupported()` 为假 ⇒ 整行不存在）；
       · 动效（关 / 减弱 / 全）。
     「行情音」是**另一件事**（它只管 K 线驱动的那一簇环境音：强度分级的涨跌音 ＋ 插针 ＋
     爆仓潮 / 开仓潮；事件音照响），与音量并存。 */

  /** 一排档位组：标签 ＋ 若干并排的 `.set-btn`（当前档挂 `.on`）。返回 `map`（值 → 按钮）供 `update()` 同步。 */
  const segRow = (label, key, items) => {
    const row = el('div', 'set-row');
    row.append(el('i', null, label));
    const seg = el('div', 'set-seg');
    const map = new Map();
    for (const [v, text] of items) {
      const b = el('button', 'set-btn', text);
      b.dataset[key] = v;
      seg.append(b);
      map.set(v, b);
    }
    row.append(seg);
    return { row, map };
  };

  const { row: volRow, map: volBtns } = segRow('音量', 'vol', [['0', '关'], ['1', '小'], ['2', '中'], ['3', '大']]);
  /* 行情音（T-1 · P9）：与音量**分开**的音频开关 —— 它只管 K 线驱动的那一簇环境音
     （涨跌音簇 / 插针 / 爆仓潮 / 开仓潮，50x 下吵了可以只关它），事件音照响。默认开。 */
  const mktBtn = el('button', 'set-btn on', '开');
  mktBtn.dataset.market = 'toggle';
  const mktRow = el('div', 'set-row');
  mktRow.append(el('i', null, '行情音'), mktBtn);
  /* 震动（T-2）：桌面浏览器即便有 `navigator.vibrate` 也是空转 ⇒ 不支持就**整行不建**。 */
  const { row: vibRow, map: vibBtns } = vibSupported()
    ? segRow('震动', 'vib', [['0', '关'], ['1', '弱'], ['2', '强']])
    : { row: null, map: new Map() };
  /* 震动「试一下」（2026-10-03 用户实机反馈「手机上感觉不到震动」）：
     档位那三枚都是几十毫秒的模式，玩家摸不着时分不清是「档位关着」还是「手机不震」。
     这枚键走一条**加长三连震**（`sound.js` 的 `buzzTest`），一按就能确认硬件到底响不响。 */
  if (vibRow) {
    const vibTest = el('button', 'set-btn', '试一下');
    vibTest.dataset.vibtest = '';
    vibRow.append(vibTest);
  }
  const { row: fxRow, map: fxBtns } = segRow('动效', 'fx', [['0', '关'], ['1', '减弱'], ['2', '全']]);
  /* 新手提示（v11 · ③）：管破产预警遮罩这类**引导**内容（开局叙事不受它管）。 */
  const hintBtn = el('button', 'set-btn on', '开');
  hintBtn.dataset.hint = 'toggle';
  const hintRow = el('div', 'set-row');
  hintRow.append(el('i', null, '新手提示'), hintBtn);
  /* 涨跌色方向（B5 · 用户 2026-09-30 拍板）：文案写**当前方向**（默认「绿涨」），
     `.on` 表示「已经从惯例切走了」—— 与前几个开关「on = 启用」的语气一致。
     偏好归 `main.js`（独立 localStorage 键），这里只负责显示。 */
  const colBtn = el('button', 'set-btn', '绿涨');
  colBtn.dataset.colors = 'toggle';
  const colRow = el('div', 'set-row');
  colRow.append(el('i', null, '涨跌色'), colBtn);
  const setCard = el('div', 'set-card');
  setCard.append(volRow, mktRow);
  if (vibRow) setCard.append(vibRow);
  setCard.append(fxRow, hintRow, colRow);
  const resetBtn = el('button', 'act flat', '重开本局');
  resetBtn.dataset.reset = '';
  /* 返回主菜单（2026-10-01 用户要求）：设置页原来是**没有出口**的 —— 底部 Tab 只在交易 /
     资产 / 设置三页之间切，玩家想回菜单只能刷新页面。这枚键停在原地（不 reload、不丢档），
     `main.js` 的 `onHome` 把时钟停住再弹菜单，本局状态一个字不动。 */
  const homeBtn = el('button', 'act flat', '返回主菜单');
  homeBtn.dataset.home = '';
  /* 按钮必须包在 `.row` 里：`.act` 自己带 `flex: 1`，直接放进纵向 flex 的 `.page` 会被拉满整屏 */
  const resetRow = el('div', 'row');
  resetRow.append(resetBtn, homeBtn);
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

  /* 真实历史指标条（里程碑 B · 2026-10-04）：波动率 / 距高 / 距低 / 成交额。
     2018 年之前拿不到 OI / 多空比 / 资金费率的历史 ⇒ 换成三样**只吃原始行情**就能算的真读数
     （口径见 `engine.reviewVolOf` / `reviewDrawdownOf` / `reviewVolUsdOf`）。
     ⚠️ 这一条只服务回顾页，不参与任何玩法判定；与 K 线头部那几枚读数同一性质（纯展示）。 */
  const rvStats = el('div', 'rv-stats');
  const rvStatCell = (label) => {
    const v = el('b');
    const c = el('div', 'rv-stat');
    c.append(el('i', null, label), v);
    rvStats.append(c);
    return v;
  };
  const rvStatVol = rvStatCell('波动率');
  const rvStatHi = rvStatCell('距高');
  const rvStatLo = rvStatCell('距低');
  const rvStatUsd = rvStatCell('成交额');

  const rvCanvas = el('canvas');
  const rvSym = el('b');
  const rvMcap = el('i');
  const rvSupp = el('i');
  const rvChg = el('span');
  const rvModeBtn = el('button', 'chip');
  rvModeBtn.dataset.mode = 'toggle';
  const rvHead = el('div', 'chart-head');
  rvHead.append(rvSym, rvMcap, rvSupp, rvChg, rvModeBtn);
  /* 市场热度（§73.5 · 2026-10-02）：与交易页**同一枚浮字**，压在同一个留白处（K 线左下角）
     —— 回顾页没有 `chart-eta` / `chart-lock`，所以这一列只有热度那一枚。
     ⚠️ 它必须和交易页长得一模一样：同一套 `.chart-heat` / `data-heat` 三档着色，
        读数走 `reviewHeatOf`（同一条方程、只吃原始行情）。 */
  const rvHeatBar = el('i');
  const rvHeatTxt = el('u');
  const rvHeatRow = el('div', 'row');
  rvHeatRow.append(rvHeatBar, rvHeatTxt);
  const rvHeatChip = el('div', 'chart-heat');
  rvHeatChip.append(rvHeatRow);
  const rvSide = el('div', 'chart-side');
  rvSide.append(rvHeatChip);
  const rvWrap = el('div', 'chart-wrap');
  rvWrap.append(rvCanvas, rvHead, rvSide);

  /* 日志栏**加长**（方案 §3.6）：回顾页没有操作区 / HUD / 持仓条，省下的高度全给它 ——
     固定几行常驻、超出就在面板内滚（与日志浮层同一套 `.log-row`，两个入口一副样子）。 */
  const rvLogs = el('div', 'rv-logs');

  const reviewPage = el('div', 'page review-page');
  reviewPage.append(rvTop, rvBar, rvSymbols, rvStats, rvWrap, rvLogs);

  /* ── 交易档案页（M2 · 2026-10-01）──
     与回顾页**同一副骨架**：整屏页（`#app.rv` 把常驻顶栏与 Tab 藏掉）＋ 页内自己一枚「返回」。
     列表内容由 `renderCareers()` 铺（`mount` 只建一个空容器），与回顾日志栏同一套写法。 */
  const careersTop = el('div', 'top');
  const careersWho = el('div', 'who');
  careersWho.append(el('b', null, '交易档案'));
  const careersExit = el('button', 'ic', '返回');
  careersExit.dataset.careers = 'exit';
  const careersTools = el('div', 'tools');
  careersTools.append(careersExit);
  careersTop.append(careersWho, careersTools);
  const careersList = el('div', 'careers-list');
  const careersPage = el('div', 'page careers-page');
  careersPage.append(careersTop, careersList);

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
    /* 交易档案页（M2）—— 与回顾页同样是**整屏页**，`#app.rv` 把常驻顶栏与 Tab 藏掉 */
    ['careers', careersPage],
  ]);

  root.append(top, tradePage, assetsPage, settingsPage, reviewPage, careersPage, tabs);

  return {
    root, dateEl, titleEl, pauseBtn,
    exBtn, exName, exRate,
    eqVal, eqSub, cashVal, cashSub,
    symbols, symBtns,
    canvas, chartWrap, chartHead, chSym, chMcap, chSupp, chChg, modeBtn, chartEta, chartLock,
    heatChip, heatBar, heatTxt, oiTxt, lsTxt,
    posbar, posSide, posPnl, posRate,
    logline, logRows,
    fracBtns, levRow, levBtns, spdBtns, tradeModeBtn,
    chanBtn, buyBtn, sellBtn, longBtn, shortBtn, closeBtn,
    pages, tabBtns, asUsd, asUsdSub, asUsdt, asUsdtSub, asTotal, asNote, asList,
    asCurve, eqRangeBtns, asBusy, asOnway, uPrice, uCard, uFracBtns, uBuyBtn, asExName, asExNote,
    volBtns, vibBtns, fxBtns, mktBtn, hintBtn, hintRow, colBtn,
    /* 回顾页（需求 4 · 方案 §3） */
    rvTop, rvBar, rvAuto, rvDate, rvPauseBtn: rvPause, rvSpdBtns, rvSymBtns,
    rvWrap, rvCanvas, rvHead, rvSym, rvMcap, rvSupp, rvChg, rvModeBtn, rvLogs,
    rvHeatChip, rvHeatBar, rvHeatTxt,
    rvStats, rvStatVol, rvStatHi, rvStatLo, rvStatUsd,
    /* 交易档案页（M2 · 2026-10-01） */
    careersPage, careersList,
    _levSignature: '',
    _posListSig: null,
    _rvLogSig: '',
    _careersSig: null,
  };
}

/**
 * 切页 —— **可见性的唯一写入口**（`.page.on` ＋ Tab 高亮一起翻）。
 *
 * ⚠️ 它由 `main.js` 的 `draw()` 在**量 K 线尺寸之前**调用，而不是放在 `update()` 里：
 *    隐藏的 `.trade-page` 是 `display:none`，量出来是 0×0 —— 先切页、再量，尺寸才是真的。
 * @param {object} refs `mount()` 的返回值
 * @param {'trade'|'assets'|'settings'|'review'|'careers'} name
 */
export function showPage(refs, name) {
  for (const [k, n] of refs.pages) n.classList.toggle('on', k === name);
  for (const [k, b] of refs.tabBtns) b.classList.toggle('on', k === name);
  /* 回顾页 / 交易档案页要把**三页常驻**的顶栏与 Tab 藏掉（`.page` 之外的节点，靠 `#app.rv`
     这个开关）—— 不藏的话它们会顶着两套顶栏（一套交易页的交易所键、一套自己的）。 */
  refs.root.classList.toggle('rv', name === 'review' || name === 'careers');
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
 * @param {object} view  `{ chartW, chartH, tab, muted, redUp, guide }` —— K 线区实测尺寸 ＋ 当前页 ＋ 两个浏览器偏好
 *   ＋ 是否在走新手引导（后四项由 `main.js` 注入：界面位置与浏览器偏好都不属于 `core` 的状态）
 */
export function update(refs, s, view) {
  const onTrade = view.tab === 'trade';

  setText(refs.dateEl, fmtDate(timeOf(s)));

  /* 顶栏按钮。⚠️ B30 的**待决态**（`s.pending`）下也要锁死：时钟已经停了，这时候
     「继续 / 暂停」和切页都不该可用 —— 玩家只有一个选择要回答（借，还是收摊）。
     ⚠️ 切页在 `main.js` 的 `onTab` 里也拦了一道（状态机不能只靠 DOM 兜底）。 */
  const lockedUI = !!s.over || !!s.pending;
  refs.pauseBtn.textContent = s.paused ? '继续' : '暂停';
  refs.pauseBtn.classList.toggle('on', s.paused);
  refs.pauseBtn.disabled = lockedUI;

  /* 设置页那些偏好控件（静态 DOM，不重建）：高亮 / 文案**只从这里写**。
     `view.vol` / `view.vib` / `view.fx` / `view.marketSound` / `view.redUp` 由 `main.js` 注入
     （它们都是浏览器偏好，不是主状态）；`s.hintOn` 是主状态。 */
  for (const [v, b] of refs.volBtns) b.classList.toggle('on', Number(v) === view.vol);
  refs.mktBtn.textContent = view.marketSound ? '开' : '关';
  refs.mktBtn.classList.toggle('on', view.marketSound);
  for (const [v, b] of refs.vibBtns) b.classList.toggle('on', Number(v) === view.vib);
  for (const [v, b] of refs.fxBtns) b.classList.toggle('on', Number(v) === view.fx);
  /* 挑战模式**整行不出现**（2026-10-01 用户拍板）：那一局恒为「老手」（`createState` 里
     `hintOn: !isChallenge`），没有任何入口能把它打开 —— 留一枚点了没反应的开关等于骗人。
     ⚠️ 用 `hidden` 而不是删节点：`refs.hintRow` 是 `mount()` 建好的静态 DOM，藏起来即可。 */
  refs.hintRow.hidden = isChallenge(s.scen);
  refs.hintBtn.textContent = s.hintOn ? '开' : '关';
  refs.hintBtn.classList.toggle('on', s.hintOn);
  refs.colBtn.textContent = view.redUp ? '红涨' : '绿涨';
  refs.colBtn.classList.toggle('on', view.redUp);

  /* 账户三格 */
  const eq = equity(s);
  refs.eqVal.textContent = moneySlot('eq', eq);
  refs.eqVal.className = 'num ' + (eq >= s.cash0 ? 'up' : 'down');
  /* 副行两个数**都带符号**（Batch 4 · B17）：正绿负红，与持仓盈亏同一口径。
     颜色写在这里而不是 CSS 默认值 —— 见 `style.css` 里 `.hud .cell u.up` 那段注释。 */
  refs.eqSub.textContent = `已实现 ${moneySlot('realized', s.realized, { sign: true })}`;
  /* `sign` ＝ 色盲第二通道（B6-c · §7.6）：在 `.up` / `.down` 的颜色之外再挂一枚 ▲/▼ */
  refs.eqSub.className = 'num sign ' + (s.realized >= 0 ? 'up' : 'down');

  refs.cashVal.textContent = moneySlot('cash', available(s));
  /* 副行优先级：有持仓时显示未实现盈亏，否则回落到「初始 $1,000」这个死常量。
     （原来「有贷款时优先显示负债」，已随 2026-10-01 的一次性救济金改造整体移除 —— 那笔钱不用还。） */
  if (anyHeld(s)) {
    const u = totalUnrealized(s);
    refs.cashSub.textContent = `未实现 ${moneySlot('unreal', u, { sign: true })}`;
    refs.cashSub.className = 'num sign ' + (u >= 0 ? 'up' : 'down');
  } else {
    refs.cashSub.textContent = `初始 ${fmtMoney(s.cash0)}`;
    refs.cashSub.className = 'num mut';
  }

  setText(refs.exName, exchangeOf(s.ex)?.name ?? '--');
  /* 上帝模式的**常驻标识**（本轮 ④）：改过资金 / 跳过日期之后，玩家得随时看得出「这一局不干净」。
     一个金色的「Degen」比任何一次性提示都持久，而且不额外占地（它本来就是顶栏标题）。
     ⚠️ 写 `className` 而不是 `classList.toggle`：标题只有这一种着色，没有第二种状态要叠。 */
  refs.titleEl.className = s.god ? 'gold' : '';
  /* 第二行平时是费率；**有在途转账时临时换成倒计时**（P2-A）——
     顶栏只有 46px 余量（375px 屏），「拥堵 严重」这类词根本放不下，
     所以拥堵状态词只出现在选所弹层里，顶栏这一行只承担倒计时。
     ⚠️ 费率**着色**（本轮 ④）：三家所差一个数量级（Bitfinex 0.20% ↔ BitMEX 0.05%），
        而这一行是全屏唯一显示它的地方 —— 不区分就等于把成本藏起来了。
        两档门槛直接落在真实数据上（≥0.20% 红 / ≥0.10% 金 / 其余留 mut 灰），
        与 `.pick-head` 的拥堵状态词同一套「两档门槛」写法，不引入新体系。
        ⚠️ 必须写成 `.top .ic.exbtn u.<色>` 这一级：`.top .ic.exbtn u`（0,3,1）压过全局
           `.gold`（0,1,0），直接挂类名会被 mut 灰吃掉（详见 `style.css` 那两条）。 */
  const now = timeOf(s);
  if (s.transfer) {
    setText(refs.exRate, `→ 剩 ${Math.max(0, s.transfer.arriveAt - s.i)}h`);
    setCls(refs.exRate, '');
  } else if (haltedAt(now, s.ex)) {
    /* 停机维护（B24）：第二行**顶掉费率**显示状态词 —— 这段时间开仓会被拒，
       不显式说一句，玩家只会觉得「按钮坏了」。（与转账倒计时同一优先级：先报状态、再报费率。） */
    setText(refs.exRate, '维护中');
    setCls(refs.exRate, 'down');
  } else {
    /* 费率随**下单模式**切换（v12 · 方案 §11.3）：杠杆与合约是两张表，顶栏必须显示玩家
       接下来真正会被收的那一档 —— OTC 跟随模式，所以也要算进去。
       （着色那两档是按**杠杆**费率定的门槛：Bitfinex 0.20% 红 /
        BitMEX 0.05% 灰 / Binance 0.04% 灰，合约费率普遍更低 ⇒ 落到灰档，不误导。） */
    /* v19：带上这家所**近 30 天**的成交量 —— 顶栏必须显示玩家**现在真的会付**的那一档，
       否则巨鲸看着 0.20% 却被收了 0.13%，账对不上。
       ⚠️ v20：成交量也按**产品线**分账 ⇒ 这里取的 `kind` 必须与 `openTrade` 同源（一处算、两处用）。 */
    const fk = s.mode === 'fut' ? 'fut' : 'margin';
    const fr = feeRateOf(s.ex, now, fk, vol30Of(s, s.ex, s.i, fk));
    setText(refs.exRate, `费率 ${fmtRate(fr, 2)}`);
    setCls(refs.exRate, fr >= 0.002 ? 'down' : fr >= 0.001 ? 'gold' : '');
  }

  /* 币种条：未解锁的币用**边框环**显示解锁进度（Batch 5 · B25）。
     进度由 `--pf` 这个 CSS 变量驱动（`style.css` 的 `.sym.locked` 拿它画锥形渐变环），
     值没变就不写 —— 每帧 4 个按钮的 `setProperty` 会触发样式失效，能省则省。 */
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
  const mark = lastPrice(s, sym);   // 三价：K 线画的是**最新价**，现价标记与它同源
  /* ⚠️ **K 线只在交易页画**（A6 · 方案 §6.2）：另两页没有 K 线，`.trade-page` 是 `display:none`，
     量出来的画布尺寸是 0×0。不跳过的话 `windowFor(dw≈1)` 会算出畸形视野，还会把夹取后的
     `yPx` 反写回 `view.js`（污染那一段的真实位移）。 */
  if (onTrade) syncChart(refs, s, view, sym, cur, mark);

  /* 持仓条：只显示当前所选币；**无持仓也常驻**（三格填 `--`），见 mount() 的注释 */
  if (cur) {
    const p = cur;
    const posMark = exMarkPrice(s, p.sym, p.ex);   // 三价：保证金率 / 安全垫按**标记价**（本仓所在所）
    /* 字面（2026-10-03 收窄）：**只留「币种 ＋ 倍数」**，方向改由颜色承担 ——
       `.posbar .side-long / .side-short`（绿多红空，见 style.css）。
       ⚠️ 原来写「买入 / 卖出」（合约写「多 / 空」）：`DOGE 买入 100x` ≈ 96px、`BTC 买入 100x` ≈ 88.8px，
          而 375px 屏每格只有 **75.25px** ⇒ 只要 `lev > 1` 必然被 `ellipsis` 截尾。
          压成 `DOGE 100x` = **64.8px**、`BTC 100x` = **57.6px**，两种工具同一副字面，终于放得下。
       ⚠️ **倍数只在 lev > 1 时写**（用户 2026-10-01）：1x 写个 `1x` 会与带杠杆的混同。 */
    setText(refs.posSide, `${p.sym}${p.lev > 1 ? ` ${p.lev}x` : ''}`);
    setCls(refs.posSide, 'num ' + (p.side === 'long' ? 'side-long' : 'side-short'));
    const pnl = unrealizedOf(s, p.sym);
    const pnlText = moneySlot('pospnl', pnl, { sign: true });
    setText(refs.posPnl, pnlText);
    setCls(refs.posPnl, 'num sign ' + (pnl >= 0 ? 'up' : 'down'));
    /* 未实现盈亏换值闪一下（2026-10-03）：与总资产同一副观感、同一条 `.flash` 重挂机制。
       ⚠️ 只在**显示值真的变了**的帧上闪 —— `moneySlot` 自带门槛迟滞，数字抖动不会一直触发。
          `setCls` 整写 `className` 会把上一帧的 `.flash` 擦掉，所以这一下必须排在其后。 */
    if (pnlText !== refs._posPnlText) { refs._posPnlText = pnlText; flash(refs.posPnl); }
    /* 第三格**只剩保证金率**（Batch 2 · B9，2026-09-29）：原来这里是「保证金率 / 强平价」，
       格宽只有 1/3 屏，两个数一串必然被 `text-overflow` 截掉尾巴（用户实机发现）。
       强平价已搬到 K 线的开仓线左端标签，这一格终于能完整放下一个数。
       **1x 多头**（无借入）没有维持保证金率这一说 —— 只有币价归零才归零本金（GDD §9.1），填 `--`。
       ⚠️ v9（§15.3 N5）：判据从「是不是杠杆 1x」换成 `canLiquidate` —— 杠杆 > 1 仓照样有强平线。
       ⚠️ 2026-10-03：判据再收窄成「有没有借入」—— **1x 空头借了全额币，这格要显示保证金率**。 */
    if (!canLiquidate(p)) {
      setText(refs.posRate, '--');
      setCls(refs.posRate, 'num mut');
      refs._rateDanger = false;   // 不可强平 ⇒ 没有「红区」这回事，复位（换仓后重新判）
    } else {
      const rate = posMark == null ? 0 : marginRateOf(p, posMark);
      setText(refs.posRate, fmtRate(rate));
      /* **三档颜色**（本轮 ⑥ · 用户拍板「像 OKX 一样」）—— 判据不是 `rate` 的绝对值，
         而是**按本仓自己的杠杆归一化的安全垫** `safetyOf`：
           开仓那一刻 = 1（满垫）、触及维持保证金率 = 0（该强平了）。
         ⚠️ 用绝对值会全错：100x 刚开出来时 `rate` 就是 1%，任何「< 5% 转红」的阈值都会
            让所有高杠杆仓位常年贴在红区，颜色不再携带任何信息。
         分档（与 `main.js` 那声预警同一个判据，不各写一份）：
           `> 0.5` 绿 · 安全 ｜ `0.2 ~ 0.5` 金 · 注意 ｜ `≤ 0.2` 红 · 危险 */
      const safe = safetyOf(p, posMark ?? 0);
      const danger = safe <= 0.2;
      setCls(refs.posRate, 'num ' + (danger ? 'down' : safe <= 0.5 ? 'gold' : 'up'));
      /* **进红区**那一刻脉冲一次（2026-10-03）：与 `main.js` 那声预警**同源同判据**
         （`safetyOf <= 0.2`）—— 它出声、这里出画，两边指的是同一件事。
         ⚠️ 只在**跨进**那一刻触发，回到注意区之上就复位 —— 否则会贴着阈值一直闪。 */
      if (danger !== refs._rateDanger) {
        refs._rateDanger = danger;
        if (danger) flash(refs.posRate);
      }
    }
  } else {
    for (const n of [refs.posSide, refs.posPnl, refs.posRate]) {
      setText(n, '--');
      setCls(n, 'num mut');
    }
    refs._rateDanger = false;   // 空仓：红区状态复位，下一张仓重新判「进没进红区」
  }

  /* 日志条：显示**最近两条**（`LOG_ROWS`，2026-10-03）。时间用**事件发生那一刻**的
     `at`，不是「现在」—— 否则一条发生在 2015-10-01 的爆仓，几天后会被标成今天。
     ⚠️ 前缀**只有时分**（2026-09-29）：完整日期已经在顶栏，这里再写一遍就是重复显示。
     ⚠️ **兜底文案是 `—`**（Batch 5 · B24）：那一行是日志的**空态**，而此刻行情往往已经在跑了
        —— 写「等待开盘」等于声称一件不成立的事。空态几乎只出现在老存档上（新开局的「开盘」
        日志由 `main.js` 的 `onIntro()` 补上），所以只在**第一行**兜底、第二行空着。 */
  for (let r = 0; r < refs.logRows.length; r++) {
    const cell = refs.logRows[r];
    const e = s.log[r];
    cell.row.hidden = !e && r > 0;
    if (!e) {                                   // 第一天就空着的那一槽
      setCls(cell.row, 'lg-row');
      setCls(cell.tag, 'log-tag sys');
      setText(cell.tag, r === 0 ? LOG_TAGS.sys : '');
      setText(cell.time, '');
      setText(cell.text, r === 0 ? '—' : '');
      setCls(cell.text, 'mut');
      cell._key = '';                           // 清签名：下一格新日志仍算「新的一条」，要滑入
      continue;
    }
    /* ⚠️ 类别一律走 `tagOf`（老存档没有 `tag` 字段、新闻到点要衰老）—— 不要直接读 `e.tag`。 */
    const tg = tagOf(e, s.i);
    setText(cell.tag, LOG_TAGS[tg]);
    setCls(cell.tag, `log-tag ${tg}`);
    setText(cell.time, fmtHour(GAME.start + (e.at ?? s.i) * HOUR_MS));
    setText(cell.text, e.text);
    /* 正文颜色仍走 `kind`；`.lg-row.news > span` 会把新闻那条提到正文色（同一先例，见 CSS）。 */
    setCls(cell.text, kindClsOf(e.kind));
    /* `mkt` = 全市场级事件（爆仓潮 / 归零 / 停机…）⇒ 加 2px 左边框 ＋ 淡红底，一眼抓住。 */
    setCls(cell.row, tg === 'mkt' ? 'lg-row alert' : 'lg-row');
    /* 来了**新的一条**就从下方滑入（落点 6c）：这两行是常驻节点，靠签名比对触发。
       ⚠️ 必须排在 `setCls(cell.row, …)` 之后 —— 那一行整写 `className`，会把上一帧的 `.in` 擦掉。
       ⚠️ 首帧（`_key` 未定义）只记签名、**不播** —— 否则开机那一帧两行一起滑一次。 */
    const key = `${tg}|${e.at ?? s.i}|${e.text}`;
    if (cell._key === undefined) cell._key = key;
    else if (key !== cell._key) { cell._key = key; replay(cell.row, 'in'); }
  }

  /* **下单一小时锁**（§73.8 · 2026-10-02 用户拍板）：一笔成交后 `s.lockI = s.i`，
     必须走满 1 游戏小时才解锁。判据 `pauseLocked` 与 `main.js` 闸门**同源**（不各算一遍）。 */
  const locked = pauseLocked(s);

  /* 模式键（U1 · §21.4；v9 · §15.6 N3）：字面是**当前**模式。`合约` 时走 `.on` ——
     与通道键同一约定：偏离默认态（杠杆）才高亮，让玩家一眼看见「我这一单是合约」。
     ⚠️ **该所此刻没有合约时整枚不出现**，且一切按杠杆处理。
        `s.mode` 的回退在 `engine.normalizeLeverage` 里做 —— 渲染层**只读不写**状态。 */
  const futAvail = futuresAvailable(s);
  const fut = futAvail && s.mode !== 'margin';
  refs.tradeModeBtn.hidden = !futAvail;
  refs.tradeModeBtn.textContent = fut ? '合约' : '杠杆';
  refs.tradeModeBtn.classList.toggle('on', fut);
  /* **持仓时不许切模式**（2026-10-02 用户拍板）：杠杆仓与合约仓不能并存（`posGate`）——
     切过去只会看见一排按不动的动作键，自相矛盾。两个方向都锁（合约仓也不许切回杠杆），
     先平仓再切。⚠️ 暂停 / 锁定期**照旧放行**：它只改「下一单的参数」，不动钱（见下面 `frozen` 那段）。 */
  refs.tradeModeBtn.disabled = !!cur;

  /* 该所此刻开没开**融资**（v10）—— 一个数决定两件事：「卖出」能不能开空、杠杆行是不是置灰。
     ⚠️ 只查**杠杆表**，与当前模式无关 —— 合约做空是保证金交易，不需要借币。 */
  const canLev = hasFinancingAt(now, s.ex);

  /* 动作行（v9 · §15.3 N4）：「没有的选项不显示」——
     杠杆三枚（盘口 / 买入 / 卖出）、合约四枚（盘口 / 做多 / 做空 / 平仓），两组互斥。
     「盘口」是换成交通道的空心键，两种模式都在。 */
  const marginMode = !fut;
  refs.buyBtn.hidden = !marginMode;
  refs.sellBtn.hidden = !marginMode;
  refs.longBtn.hidden = marginMode;
  refs.shortBtn.hidden = marginMode;
  refs.closeBtn.hidden = marginMode;

  /* 杠杆档：可选档位随「时间 ＋ 所选交易所 ＋ 模式」变化，签名变了才重建按钮。
     ⚠️ v9：两张表的上限不同（§15.1），切模式必须换一张 —— 所以 `kind` 要进签名。 */
  const kind = fut ? 'fut' : 'margin';
  const opts = leverageOptionsAt(now, s.ex, kind);
  /* 「有、但此刻点不动」的一行（v10 · ②）：杠杆模式下该所没有融资 ⇒ 可选档只剩一个 `1x`。
     **保留可见**（换所时不再忽隐忽现、K 线高度不跳），但整行走 `.off`（更暗 ＋ 虚线），
     点一下由 `main.js` 给一条「暂不可用 ｜ 为什么」。
     ⚠️ 用 `aria-disabled` 而不是 `disabled` —— 后者会连 `pointerdown` 一起吞掉，点了零反馈。 */
  const levOff = kind === 'margin' && !canLev;
  /* OTC 通道跟随模式（`engine.marginOf`），但杠杆**封顶 `OTC.levMax`**（2026-10-03 拍板）——
     超过封顶的档位（如 Bitfinex 2021 的 10x）在 OTC 下置灰，与 `main.js` 的夹取口径同源。 */
  const otcCap = chanOf(s) === 'otc' ? OTC.levMax : Infinity;
  /* 签名里带上**仓位自己的倍数**（`cur.lev`）：开仓 / 平仓都会让这一行重建 ——
     持仓期间除 `cur.lev` 那一格之外一律置灰，不重建就会烙着旧的「都能点」。
     （`s.lev` 本来也进签名，但持仓时它与 `cur.lev` 恒等，所以另加这一段。） */
  const sig = kind + ':' + opts.join(',') + '#' + s.lev + (levOff ? '!' : '') + '@' + (cur ? cur.lev : '-') + '&' + otcCap;
  if (sig !== refs._levSignature) {
    refs._levSignature = sig;
    refs.levRow.querySelectorAll('.opt').forEach(n => n.remove());
    refs.levBtns.clear();
    for (const v of opts) {
      const b = el('button', 'opt', v + 'x');
      b.dataset.lev = String(v);
      if (levOff || v > otcCap) {
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
        /* **持仓时杠杆锁死**（2026-10-02 用户拍板）：加仓必须同杠杆（`posGate`）⇒
           其余档位一律置灰真禁用（`.opt:disabled`），别让玩家「点了 5x、真下单才被拒」。 */
        if (cur && v !== cur.lev) b.disabled = true;
      }
      refs.levRow.append(b);
      refs.levBtns.set(v, b);
    }
  }

  /* 速度档 */
  for (const [v, b] of refs.spdBtns) b.classList.toggle('on', s.speed === v);

  /* 主按钮可用性。
     ⚠️ `lockedUI`（结束 / 待借贷决策）下一律不可用 —— 待决态只留遮罩上那两枚按钮。
     · 合约模式：做多 / 做空 —— 空仓可开、**同向可加仓**；反向那一枚禁用（先用平仓键平掉再反手）
     · 杠杆模式（v9）：买入 / 卖出 **手上有仓位时也照样可用** —— 反向那一枚就是平仓、
       同向那一枚是**加仓**（v13 · B4，并进同一条仓位；同一个币仍然只许一条）。

     ⚠️ **暂停闸门**（本轮 ④）：暂停时**所有会动钱的操作**都画成禁用（`.act:disabled` 的 .45）——
       原来暂停只由 `main.js` 的分派层拦下并回一条日志 ⇒ 按钮**看起来仍然是能按的**，
       玩家的第一反应是「点了没反应」，而不是「现在是暂停」。画灰才是诚实的状态。
       ⚠️ 只禁**下单 / 平仓 / 换所 / 切通道**这四类（用户拍板）；杠杆档 / 金额档 / 切模式 /
          切币 / 切页 / 日志浮层 / 设置 / 上帝面板**照常可用**，所以这里一个字都不碰它们。
       ⚠️ `view.guide` 豁免：新手引导期间 `s.paused` 恒为真，而第 4 步正高亮着「买入」教玩家怎么用 ——
          把那一枚画成灰与引导自相矛盾（详见 `main.js` 里 `view.guide` 那段注释）。 */
  const frozen = s.paused && !view.guide;
  /* 「行情还在路上」（2026-10-02 审计修 · 用户拍板）—— `s.sym` 已经切过去了，但那个币的数据包
     还在网络里（`market.loadCoin` 是**懒加载**）。这一窗只有几百毫秒，**持仓时却是致命的**：
     平仓键点不动、换所又被持仓挡着（`switchExchange` 要求先平仓）⇒ 玩家以为界面卡死了。
     所以这几枚一律走 `.off` ＋ `aria-disabled`（**保留可点**，点一下由 `main.js` 回一句
     「行情加载中」，数据到货后下一帧自动恢复），绝不画成 `disabled` —— 后者会吞掉点击、零反馈。 */
  const waiting = !isLoaded(sym) && !lockedUI && !frozen && !locked;
  const tradable = !lockedUI && !locked && !frozen && mark != null && isLoaded(sym);
  const dir = cur ? cur.side : null;
  /* 同向那一枚 = **加仓**（v13 · B4 / 方案 §5）：手上那条仓位与本键同向时不再禁掉 ——
     点下去会并进同一条仓位（改杠杆 / 换性质 / 反手这些冲突由 `engine.openTrade` 给一句明确文案，
     都属于「有、但这次不行」，不是「没有」）。反向那一枚在合约模式仍是禁用（那里有独立的平仓键）。 */
  refs.longBtn.disabled = !waiting && !(tradable && (!cur || dir === 'long'));
  refs.shortBtn.disabled = !waiting && !(tradable && (!cur || dir === 'short'));
  refs.closeBtn.disabled = !waiting && (!cur || lockedUI || frozen || locked);
  /* 杠杆模式这两枚**四件事共用**：空仓开仓 / 同向加仓 / 反向平仓 —— 所以只要 `tradable` 就能点。
     「卖出」唯一的例外见下（空仓且该所没有融资 ⇒ 开不出空单，那时才禁）。 */
  refs.buyBtn.disabled = !waiting && !tradable;
  /* 「卖出」＝开杠杆空单（要借币，v10）：该所没有融资时**空仓不许开空**。
     ⚠️ 判据只看 `dir === null`：手上压着一张空单时「卖出」是**加仓**（B4）、
        压着一张多单时它是**平多**，两件事都不需要借币 ⇒ 必须能点。
     ⚠️ 这种「点不动」同样走 `aria-disabled` ＋ `.off`（理由同杠杆行），点一下给一条解释。 */
  const sellOff = (!dir && !canLev) || waiting;
  refs.sellBtn.disabled = !waiting && !(tradable && !(sellOff && !waiting));
  refs.sellBtn.classList.toggle('off', sellOff);

  /* 金额档 —— **一档两用**（2026-10-02 用户拍板）：
       · **空仓 / 加仓**时它是「这一单用掉多少可用保证金」（`openTrade` 的 `frac`）；
       · **手上有仓位**时它是「**平掉多少**」（`closeTrade` 的 `frac`）—— 1/4 · 1/2 = 分批卖出，
         「全部」才是原来那个一键全平。
     置灰判据因此**跟着当前含义走**，两边都读 `engine` 里那两个纯判据（与分派层同源）：
       · 能平仓（`canReduce`）⇒ 判 `canCloseAt`：分批低于**最小平仓金额**的那几档才灰（「全部」恒可）；
       · 否则 ⇒ 判 `canOpenAt`：两个方向都开不出来才灰 —— 玩家可能想开多、也可能想开空，只堵一边会误灰。
     ⚠️ 排在动作键**之后**，因为它要读 `tradable`（与那几枚共用同一个闸门）。
     ⚠️ 数据包没到货时不判这两个（此时 `lastPrice` 为 null，六个档全会闪一下灰）——
        行情加载中由动作键那边的 `.off` 讲，这一排只是「下一单的参数」，不必跟着闪。 */
  const canReduce = !!cur && tradable;
  for (const [k, b] of refs.fracBtns) {
    const f = Number(k);
    b.classList.toggle('on', Math.abs(s.sizeFrac - f) < 1e-9);
    let off = lockedUI || locked;
    if (!off && isLoaded(sym)) {
      off = canReduce
        ? !canCloseAt(s, f)
        : !(canOpenAt(s, 'long', f) || canOpenAt(s, 'short', f));
    }
    b.disabled = off;
  }
  if (sellOff) refs.sellBtn.setAttribute('aria-disabled', 'true');
  else refs.sellBtn.removeAttribute('aria-disabled');
  /* 另外四枚的「行情加载中」也只挂样式、不禁用 —— 与「卖出」同一套（`.off` 本就带 `cursor: default`）。 */
  for (const b of [refs.buyBtn, refs.longBtn, refs.shortBtn, refs.closeBtn]) {
    b.classList.toggle('off', waiting);
    if (waiting) b.setAttribute('aria-disabled', 'true');
    else b.removeAttribute('aria-disabled');
  }

  /* 换所键（顶栏那枚双行按钮）**同样吃暂停闸门**（本轮 ④）：换所是一笔要等好几根 K 线的
     链上转账，属于「会动钱」四类之一 —— 暂停时它必须也点不动，否则玩家会以为只有下单被拦。 */
  refs.exBtn.disabled = frozen || locked;

  /* 通道切换键**四档状态**（P2-B 修订 · GDD §15.3；2026-10-02 加第四档）：
       ① 权益 ≤ 当年解锁线（`otcUnlockAt`，2020 起 $500 万）⇒ `hidden` ——
          一个 $1,000 开局的玩家不该看见自己用不了的东西
       ② 权益够、但**当前币**还没开通 OTC ⇒ 可见但禁用（灰框）——
          这一级存在的意义就是「切币时按钮不再忽隐忽现」，所以不能藏
       ③ **手上有仓位** ⇒ 禁用（2026-10-02 审计修）：通道是**这一笔交易身份**的一部分，
          加仓必须同通道（`posGate`）——「盘口仓 ＋ 切到 OTC」会让这一枚仓加不了仓。
          与「持仓不许切杠杆 / 合约」同一条规矩：**会改变这一笔交易身份的开关，持仓期间一律锁住**。
       ④ 其余 ⇒ 可用
     字面与高亮都跟着**生效通道**走 —— 看 `chanOf` 而不是 `s.chan`，
     否则会出现「键藏起来了、单子却还在走 OTC」这种玩家看不见的通道。 */
  const chan = chanOf(s);
  const unlocked = otcUnlocked(s);
  refs.chanBtn.hidden = !unlocked;
  refs.chanBtn.disabled = !(unlocked && otcOpenFor(s)) || frozen || locked || !!cur;
  refs.chanBtn.textContent = chan === 'otc' ? 'OTC' : '盘口';
  refs.chanBtn.classList.toggle('on', chan === 'otc');

  /* 资产页（§6.2 ①–⑤ 全部落地 · v13）：账本抬头 ＋ 两格余额 ＋ 总资产 ＋ 资金曲线 ＋ 买 U ＋ 持仓列表。
     切到别的页就不写 —— 那是隐藏 DOM，而且持仓列表是**重建**出来的，白建一遍不如不建。 */
  if (view.tab === 'assets') {
    /* ⑤ 账本抬头（方案 §6 · D3）：账是按所分的，所以先把「这两个数属于哪家所」写出来；
        右端接「在途」——它是**此刻唯一不在任何所账上的钱**，玩家在资产页看不见它就会以为钱丢了。 */
    const ex = exchangeOf(s.ex);
    refs.asExName.textContent = ex ? ex.name : s.ex;
    if (s.transfer) {
      const to = exchangeOf(s.transfer.to);
      refs.asExNote.textContent = `在途 ${to ? to.name : s.transfer.to} · 剩 ${Math.max(0, s.transfer.arriveAt - s.i)}h`;
    } else {
      refs.asExNote.textContent = '';
    }

    /* ① 两格余额（v13）：副行写**占比**（基数是当前所的余额合计，不是权益 ——
       权益里还有仓位与在途的钱，拿它当分母会让「美元 30%」这种读法失真）。 */
    const usd = slotOf(s, 'usd');
    const usdt = slotOf(s, 'usdt');
    const book = usd + usdt;
    refs.asUsd.textContent = moneySlot('usd', usd);
    refs.asUsdt.textContent = moneySlot('usdt', usdt);
    const share = v => (book > 0 ? `占 ${Math.round(v / book * 100)}%` : '--');
    refs.asUsdSub.textContent = share(usd);
    refs.asUsdtSub.textContent = share(usdt);

    /* 总资产（B6-c · §7.12 ④⑤）：全屏**唯一的主数值**（18px）＋ 换值闪一下。
       ⚠️ 这里改用 `classList.toggle` 而不是整体重写 `className` —— 整体重写会把下面刚挂上的
          `.flash` 一起擦掉（每帧擦一次 ⇒ 150ms 的动画只能播一帧）。 */
    refs.asTotal.classList.toggle('up', eq >= s.cash0);
    refs.asTotal.classList.toggle('down', eq < s.cash0);
    const totalText = moneySlot('eq', eq);
    if (totalText !== refs._totalText) {
      refs._totalText = totalText;
      refs.asTotal.textContent = totalText;
      /* 重挂 `.flash` 才会重播动画：`remove` 之后必须**强制一次样式重算**，否则同一帧内
         `add` 回去浏览器会认为「没变过」。这一下同步 reflow 只发生在**显示值真的变了**的帧上
         （`moneySlot` 自带门槛迟滞，数字抖动不会一直触发）。 */
      refs.asTotal.classList.remove('flash');
      void refs.asTotal.offsetWidth;
      refs.asTotal.classList.add('flash');
    }
    refs.asNote.textContent = `已实现 ${moneySlot('realized', s.realized, { sign: true })}`;
    /* 资产页这一格是 HUD「已实现」的**同款读数**，所以一并走色盲第二通道（§7.6 连带）。 */
    refs.asNote.className = 'num sign ' + (s.realized >= 0 ? 'up' : 'down');

    /* 明细拆解（用户 2026-10-01 拍板 · 选项 A）：两行常驻、$0.00 也写，口径见 `engine.equity`。
       ⚠️ 换所要求先全平（§7.2）⇒ 同一时刻钱要么在当前所、要么在途，这两行与上面两格不会重叠计。 */
    let busy = 0;
    for (const sym of heldSyms(s)) busy += s.positions[sym].margin;
    refs.asBusy.textContent = moneySlot('busy', busy);
    refs.asOnway.textContent = moneySlot('onway', s.transfer ? s.transfer.amount : 0);

    /* ② 资金曲线（方案 §4）：与 K 线同一个坑 —— 它是 canvas，容器一隐藏就量成 0，
       所以只在资产页（此刻必然可见）画。基准线恒取**开局资金**（$1,000）：
       它不是「成本」，是「到此为止赚了还是亏了」那条分界。
       `range` = 玩家那排区间键选的天数（`view.eqRange`，`0` = 全部）—— 高低点也随之只看该区间。 */
    for (const [k, b] of refs.eqRangeBtns) b.classList.toggle('on', Number(k) === view.eqRange);
    drawEquityCurve(refs.asCurve, {
      eq: s.eq,
      range: view.eqRange,
      base: s.cash0,
      cssW: refs.asCurve.clientWidth,
      cssH: refs.asCurve.clientHeight,
    });

    /* ③ 买 U（方案 §3.1）：2014-11-20 之前整块不存在 —— 那年头没有 U，也没什么可换的。 */
    const usdtLive = now >= USDT_LIVE;
    refs.uCard.hidden = !usdtLive;
    if (usdtLive) {
      refs.uPrice.textContent = `1 USDT = $${usdtPriceAt(now).toFixed(3)}`;
      /* 买 U 这一排同样吃**暂停闸门**与**下单一小时锁**（§73.8/§73.9）：换 U 与下单共用 `s.sizeFrac`，
         两者都被拦时这一排留着可点只会让玩家以为「换 U 也能钻空子」。 */
      for (const [k, b] of refs.uFracBtns) {
        b.classList.toggle('on', Math.abs(s.sizeFrac - Number(k)) < 1e-9);
        b.disabled = frozen || locked;
      }
      /* 没有美元可换 ⇒ 键画灰（`.act:disabled` 那档，与「暂停时画灰」同一副样子）。
         判据与 `engine.buyUsdt` 的 `!(usd > 0)` **同源** —— 那正是这一下点下去会失败的唯一原因。 */
      refs.uBuyBtn.disabled = frozen || locked || !(usd > 0);
    }

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
 *   `heat` 左下角那枚浮字底（`.chart-heat`）—— 实测它的高度当底部留白（2026-10-04）；
 *   `sym` / `i` 看哪个币的第几根；`view` 本帧尺寸；`mark` 标记价；
 *   `cur` 当前仓位（**回顾页恒传 null** —— 回顾没有持仓）
 *   `own` 是否把**玩家自己的成交额**并进量柱（v20）。交易页默认真；
 *         **回顾页必须传假** —— 那一屏讲市场史，玩家这一局的成交不该混进 2013 年的柱子
 *         （模块里那个 `playerVolSource` 注入的是**当前存档**的 `s.pvol`，不关掉就会串台）。
 *   `ns` 视野命名空间（2026-10-01）：交易页 `''`、回顾页 `'rv'` —— 两页的「当前根」不是一个东西
 *        （交易页看 `s.i`、回顾页看 `rv.i`），共用一格视野就会串台（见 `view.js` 的 `keyOf`）。
 *   `levels` 历史压力位（ROADMAP §六十五）。⚠️ **只有回顾页传**，交易页恒 null ——
 *        用户 2026-10-02 拍板「交易页只算不画」（那是手感，画出来只会干扰看盘）。
 * @returns {object} `windowFor` 的返回值（`mode` / `count` / `locked` / `right` 都要用）
 */
function chartOpts({ canvas, head, heat, sym, i, view, mark, cur, own = true, ns = '', levels = null }) {
  const win = windowFor(sym, i, view.chartW, own, ns);
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
  const effY = drawChart(canvas, {
    candles: win.candles,
    vols: win.vols,
    /* 玩家自己那一段（v20 · 杠杆 / 合约分色）—— 只换色不改高度，`chart.js` 把它叠画在柱底。
       ⚠️ `own=false`（回顾页）时 `win.pvols` 全是 `null`，`chart.js` 自己会跳过。 */
    pvols: win.pvols,
    /* 槽位数（= 视野要的根数）：柱宽按它算、柱子右对齐，币种刚上线时才不会一根撑满屏（B22）。 */
    slots: win.slots,
    /* 历史锚点刻度（P2-C）—— 与最右那根一起交给图上换算槽位 */
    anchors: anchorMarks,
    right: win.right,
    /* 量柱 P95 的缓存键（用户 2026-10-01 拍板）：`windowFor` 每帧重建 `vols`，所以不能用引用当键 ——
       用「这份视野是谁」的字符串。同一视野（未换币 / 未换粒度 / 未拖动）下 P95 恒定。 */
    cacheKey: `${sym}|${win.mode}|${win.right}|${win.count}`,
    /* 顶部留白 = 左上角遮罩的**实测**高度（Batch 5 · B27）：量不到时由 `chart.js` 退回自己的兜底常量。
       ⚠️ 量一次就缓存（用户 2026-10-01 拍板）：它只随**容器宽度**（换行）与**文案长度**变，
          每帧 `getBoundingClientRect` 会白白强制一次布局。键 = 宽度 ＋ 那几段文案的总长。 */
    topInset: headInset(head, view.chartW),
    /* 底部留白 = 左下角「热度 / OI / 多空」那一行的**实测**高度（2026-10-04 用户拍板「腾一行」）：
       价格区整块上移，量柱基线、右侧四档轴、开仓价签、强平签全部落到这一行之上。
       与 `topInset` 同一套缓存口径（量一次就存，见 `footInset`）。 */
    bottomInset: footInset(heat, view.chartW),
    mark,
    /* 历史压力位（ROADMAP §六十五）—— 只有回顾页会传进来（交易页恒 null，`chart.js` 自会跳过）。 */
    levels,
    entry: cur ? cur.entry : null,
    side: cur ? cur.side : null,
    /* 强平价交给图上的**开仓线左端标签**（Batch 2 · B9）。1x 多头（无借入）没有强平价 ⇒ 传 null。 */
    liq: cur && canLiquidate(cur) ? liquidationPrice(cur) : null,
    cssW: view.chartW,
    cssH: view.chartH,
    yPx: win.yPx,
  });
  if (effY !== win.yPx) setYPx(sym, effY, ns);
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

  /* 市场热度（§73.5）：0–1 的条 ＋ 贪婪 / 中性 / 恐慌 三档字面。判据与 `HEAT` 同源。
     ⚠️ **必须排在 `chartOpts` 之前**（2026-10-04）：`chartOpts` 把这一行的**实测高度**当底部留白
        （`footInset`），文案还没写进去量到的就是一格空底 —— 首帧会把量柱基线压低一行。 */
  const heat = heatOf(s, sym);
  refs.heatBar.style.setProperty('--heat', `${Math.round(heat * 100)}%`);
  refs.heatTxt.textContent = heat >= HEAT.greed ? '贪婪' : heat <= HEAT.panic ? '恐慌' : '中性';
  refs.heatChip.dataset.heat = heat >= HEAT.greed ? 'greedy' : heat <= HEAT.panic ? 'panic' : 'mid';
  /* 派生量两枚（缺口 4 / 19；2026-10-03 改口径）：OI（全市场，含玩家与 1:1 对手方）
     ＋ **散户多空比**（散盘子集，不含玩家 —— 全市场口径按定义恒为 1:1、零信息量，见
     `retailLongShareOf`）。取不到（散户两侧皆空）⇒ `--`，不硬凑一个 50/50。
     ⚠️ OI 走 `fmtQty`（= 无 `$` 的同一套后缀表）：这一行要挤下三格，`$` 是第一个被砍的。 */
  const ls = retailLongShareOf(s, sym);
  refs.oiTxt.textContent = `OI ${fmtQty(openInterestOf(s, sym))}`;
  refs.lsTxt.textContent = ls == null ? '多空 --' : `多空 ${Math.round(ls * 100)}/${Math.round((1 - ls) * 100)}`;

  const win = chartOpts({
    canvas: refs.canvas, head: refs.chartHead, heat: refs.heatChip, sym, i: s.i, view, mark, cur,
  });

  /* 粒度小字（Batch 3 · B12）：字面是当前粒度，点一下切到另一种（`main.js` 里定的目标档） */
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
}

/**
 * 回顾页的 **K 线 ＋ 它那几枚头部浮字**（币种 / 市值 / 流通 / 24h / 热度 / 画布／粒度小字）。
 *
 * 为什么整块抽出来（2026-10-04 性能修）：手势快路（`redrawChart`）要**单独**再跑一遍这一小块 ——
 * 拖动 / 捏合只改视野，页面其余部分一个字都不变，跑整页 `renderReview()` 是白跑。
 * 抽出来之后两个调用者共用同一份写入，快路不会与整页帧各写各的、写出两套观感。
 */
function reviewChartSync(refs, rv, view) {
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

  /* 市场热度（§73.5 · 2026-10-02）：与交易页**逐字同一套**写法 —— 同一条方程、同一个阈值、
     同一组 `data-heat` 类名。口径差异只有一处：回顾页读的是**原始行情**（这一屏本来就画原始 K 线）。 */
  const heat = reviewHeatOf(sym, rv.i);
  refs.rvHeatBar.style.setProperty('--heat', `${Math.round(heat * 100)}%`);
  refs.rvHeatTxt.textContent = heat >= HEAT.greed ? '贪婪' : heat <= HEAT.panic ? '恐慌' : '中性';
  refs.rvHeatChip.dataset.heat = heat >= HEAT.greed ? 'greedy' : heat <= HEAT.panic ? 'panic' : 'mid';

  const win = chartOpts({
    /* ⚠️ `own: false`（v20）：回顾那一屏**不并玩家自己的成交额** ——
       `playerVolSource` 注入的是当前存档的 `pvol`，不关掉就会把「你这一局在 2015 年买的那一笔」
       画进 2015 年的历史柱子里。 */
    canvas: refs.rvCanvas, head: refs.rvHead, heat: refs.rvHeatChip, sym, i: rv.i, view, mark, cur: null, own: false,
    /* 视野命名空间（2026-10-01）：回顾页自己一套，绝不与交易页那格串味 —— 见 `view.js` 的 `keyOf`。 */
    ns: 'rv',
    /* 历史压力位（ROADMAP §六十五）：按 `rv.i` 算「那一刻之前 30 天堆过货的价位」，画成一组横虚线。
       它是 `(sym, i)` 的纯函数（只吃原始行情）⇒ 回顾页不用新增任何状态、也不碰 `s`。 */
    levels: levelsOf(sym, rv.i),
  });
  refs.rvModeBtn.textContent = win.mode === '1d' ? '1日' : '1h';
}

/**
 * **手势快路**（2026-10-04 性能修）：只重画 K 线与它头部的浮字，不碰页面其余部分。
 *
 * 为什么需要它：拖动 / 捏合只改 `view.js` 里的视野 —— 页面上除 K 线之外**没有任何东西会变**。
 * 原来每个手势帧都跑整页 `update()`（交易页）／`renderReview()`（回顾页），
 * 手机上单帧成本压不进 16ms ⇒ 缩放 / 拖动明显掉帧。这条窄路把成本砍到「一次画布重绘 ＋ 十来处
 * 文本写入」。整页那一帧由 `main.js` 的 `scheduleFullDraw()`（手势停下 180ms）与时钟 `onFrame` 补上。
 *
 * @param {object} rv 回顾态（`null` = 交易页）；两个页面各有自己那一块 K 线区与头部。
 */
export function redrawChart(refs, s, rv, view) {
  if (rv) { reviewChartSync(refs, rv, view); return; }
  const sym = s.sym;
  syncChart(refs, s, view, sym, posOf(s, sym), lastPrice(s, sym));
}

/* ═════════════════════════ 资产页 · 持仓列表 ═════════════════════════ */

/**
 * 持仓列表的**签名** —— 列表是**重建**的，只在签名变化时重建（与杠杆档同一套写法）。
 * 签名里带上格式化后的盈亏，所以价格一动（在资产页点「继续」时会）数字跟着走。
 */
function posListSignature(s) {
  return heldSyms(s).map(sym => {
    const p = s.positions[sym];
    return `${sym}:${p.side}:${p.lev}:${isMargin(p) ? 'm' : 'f'}:${p.entry}:${unrealizedOf(s, sym).toFixed(2)}`;
  }).join('|');
}

/**
 * 按**杠杆 / 合约**两组列出全部持仓（§6.2 ④；2026-10-03「全程只做杠杆与合约」由三组并回两组）——
 * 用途是**跨币复盘**：一行一个币，「方向 ＋ 杠杆 ＋ 开仓价」在左、未实现盈亏在右。
 *
 * ⚠️ 与交易页那条持仓条不是重复（§14.7）：那条只看当前币、承担「风险仪表」的职责。
 * ⚠️ **开仓价**本轮加进来（用户拍板）：跨币复盘时「这笔单是贵还是便宜」必须能就地看出来，
 *    否则只有盈亏数字，换个币就不知道成本在哪。格式化走 `fmtLogPrice` —— 与日志串同一口径。
 */
function buildPosList(box, s) {
  box.textContent = '';
  const mgn = [];    // 杠杆：借钱 / 借币；有借入的（含 1x 空头）计息、有强平线，1x 多头无
  const fut = [];    // 合约
  for (const sym of heldSyms(s)) {
    const p = s.positions[sym];
    if (isMargin(p)) mgn.push(sym); else fut.push(sym);
  }

  if (!mgn.length && !fut.length) {
    box.append(el('div', 'pcard prow mut', '暂无持仓'));
    return;
  }

  for (const [label, syms] of [['杠杆', mgn], ['合约', fut]]) {
    if (!syms.length) continue;
    box.append(el('h4', null, label));
    const card = el('div', 'pcard');
    for (const sym of syms) {
      const p = s.positions[sym];
      const pnl = unrealizedOf(s, sym);
      /* 方向字面与交易页持仓条一一对应（v9 · §15.6 N4）：杠杆写「买入 / 卖出」、合约写「多 / 空」。 */
      const dirText = isMargin(p)
        ? `${p.side === 'long' ? '买入' : '卖出'}${p.lev > 1 ? ` ${p.lev}x` : ''}`
        : `${p.side === 'long' ? '多' : '空'} ${p.lev}x`;
      /* 杠杆多一行**币量**（用户 2026-10-01「花多少钱买了多少枚币」）——
         合约的 `size` 只是名义的折算，玩家不看这个数，所以不报。
      ⚠️ 本轮 B4 拆掉两处冗余字（2026-10-03）：币量后的「枚」与开仓价前的「开仓」——
         `买入 100x · 12,345.7 枚 · 开仓 49,123.4` ≈ 254px，而 375px 屏这一行只有 ≈ 237px，
         `ellipsis` 总是吃掉「开仓价」尾。去掉后 `买入 100x · 12,345.7 @ 49,123.4` ≈ **218px**，
         三项（方向 ＋ 倍数 / 币量 / 开仓价）一项没少；`@` 是日志串里「按此价成交」的同一口径。 */
      const qtyText = isMargin(p) ? ` · ${fmtQty(p.size)}` : '';
      const row = el('div', 'prow');
      /* ⚠️ 未实现盈亏改走**短档**（2026-10-03 用户拍板）：原来是 `fmtMoney`（永不换单位），
         百万级时印成 `+$12,345,678.9`（14 字符 ≈ 101px）。这一格是 `flex: none`，
         多出来的宽度全从中间那格（方向 ＋ 币量 ＋ 开仓价）身上抢 —— 「开仓 13.1」直接被
         `ellipsis` 吃掉。改走 `moneySlot` 后与交易页持仓条同档（`$12.3M`），共用同一套迟滞。 */
      row.append(
        el('b', null, sym),
        el('span', 'mut', `${dirText}${qtyText} @ ${fmtLogPrice(p.entry)}`),
        el('b', 'num sign ' + (pnl >= 0 ? 'up' : 'down'), moneySlot('plist:' + sym, pnl, { sign: true })),
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
 * 覆盖全屏的结束遮罩。两种结局：收盘结算（赢）/ 爆仓。
 * （原来还有一种「债务违约」，已随 2026-10-01 的一次性救济金改造整体移除 —— 那笔钱不用还。）
 */
export function renderOver(root, s) {
  root.querySelector('.over')?.remove();
  const box = el('div', 'over');
  const reason = s.over.reason;
  const win = reason === 'settled';
  /* `gaveup`（v21 · M1）：归零遮罩上主动点「就此收摊」——**不是**被打穿的，
     与爆仓分开说（`engine.OVER.GAVEUP` 的注释里写着同一个理由）。 */
  const quit = reason === 'gaveup';
  const eq = equity(s);

  const title = win ? '收盘结算' : (quit ? '收摊' : '爆仓');
  const body = win
    ? `你活到了 ${fmtDate(timeOf(s), false)}\n最终权益 ${fmtMoney(eq)}`
    : (quit
      ? `你主动收了摊\n最终权益 ${fmtMoney(eq)}`
      /* ⚠️ 文案与 `engine.endGame` 的「账户归零，游戏结束」、本函数下面那张遮罩的标题
         「账户归零」**统一**（2026-10-02 审计修）：原来是孤例「账户清零」。
         也**不再写「保证金归零」** —— 这一支同时接管挑战年代局的归零（`OVER.LIQUIDATED`
         在 `isChallenge` 那条路也会落进来），那种归零未必出自保证金；标题已是「爆仓」。 */
      : `账户归零\n倒在 ${fmtDate(timeOf(s))}`);

  box.append(el('b', win ? 'up' : 'down', title), el('p', null, body));
  const btn = el('button', null, '重新开始');
  btn.dataset.restart = '';
  /* 第二枚出口（2026-10-02 审计修）：「回主菜单」。原来整张遮罩只有「重新开始」一条路 ——
     本局结束后既回不了菜单，也看不了刚写进档案的那条记录，只能重开或刷新页面。
     ⚠️ 主菜单在这一刻**不是**「无处可去的界面」：开始游戏 / 挑战 / 历史回顾 / 交易档案都还在，
        只有「读取存档」会把人送回这张遮罩（那正是这一局的真相，不算陷阱）。
        ⇒ `main.js` 的 `onHome` 里那条 `if (s.over) return` 已一并撤掉。 */
  const home = el('button', 'flat', '回主菜单');
  home.dataset.home = '';
  const btns = el('div', 'over-btns');
  btns.append(btn, home);
  box.append(btns);
  root.append(box);
}

/**
 * 救济金遮罩（Batch 5 · B30）—— 归零那一刻出现，**时钟已停**，等玩家二选一。
 * 复用 `.over` 外壳（居中、吃满屏、不透明底）：它不是「可以点外面关掉」的菜单，
 * 是一个必须回答的问题 —— 与开场叙事同一种语气。
 * ⚠️ **不用还**（用户 2026-10-01 拍板）：原来那套「日息 0.1% × 180 天、到期自动清仓还款、
 *    还不上即债务违约」整体移除 —— 现在就是一笔一次性救济金，文案也得跟着说清楚。
 * ⚠️ 这一帧只画一次（`s.paused` 期间不再有 `onFrame`），所以不需要去重重建。
 */
export function renderLoan(root, s) {
  root.querySelector('.over')?.remove();
  const box = el('div', 'over');
  const amount = loanAmountAt();

  box.append(
    el('b', 'down', '账户归零'),
    el('p', null, `领取 ${fmtMoney(amount)} 救济金\n这笔钱不用还，一局只能领一次`),
  );
  const take = el('button', null, `领取 ${fmtMoney(amount)}`);
  take.dataset.loan = 'take';
  const give = el('button', 'flat', '就此收摊');
  give.dataset.loan = 'give';
  const btns = el('div', 'over-btns');
  btns.append(take, give);
  box.append(btns);
  root.append(box);
}

/**
 * 风险预警遮罩（v11 · ③）—— 会直接弄死人 / 重创杠杆仓的历史事件，提前 7 天出现，**时钟已停**。
 * 复用 `.over` 外壳（与借贷遮罩同一种语气：必须回答，不能点外面关掉）。
 *
 * ⚠️ **只陈述事实，不给行动建议**（拍板）：怎么应对是玩家的决策 —— 面板只说「7 天后有这么件事」。
 *    所以这里只有一条 `title`（来自锚点表，不额外写文案）＋ 一枚「知道了」。
 * ⚠️ 文案取自 `s.warnAt` 反查的锚点：`anchors.js` **不存 note**，所以能说的就是事件标题本身。
 * ⚠️ 这一帧只画一次（`s.paused` 期间不再有 `onFrame`），不需要去重重建。
 *
 * ⚠️ **标题与正文都改过（2026-10-02 审计修）**，两处各修一个毛病：
 *   ① 台头原来写「破产预警」—— 但这张遮罩服务的**六条 `warn` 锚点**里只有 2014-02-25
 *      那条交易所归零真是「破产」，其余五条是崩盘 / 挤兑 / 算法稳定币脱锚（2018-11-15、
 *      2020-03-12、2022-05-09、2022-11-11、2016-05-17）—— 统一口径改成**风险预警**。
 *   ② 正文原来是 `标题 ＋ 「将在 7 天后发生」`，而锚点的 `title` 全是**已经发生过的口吻**
 *      （「全球资产一起被抛售换现金」）—— 一句过去时 + 一句将来时并排，读起来自相矛盾。
 *      改成「还有 7 天」，时态中性，只交代**倒计时**这件事。
 */
export function renderWarn(root, s) {
  root.querySelector('.over')?.remove();
  const box = el('div', 'over');
  const a = anchorOfAt(s.warnAt);
  const title = a ? a.title : '历史事件';

  box.append(
    el('b', 'down', '风险预警'),
    el('p', null, `${title}\n还有 7 天`),
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
 * 三家全部列出，没开业的置灰 —— 顺带把时间线讲给玩家听。
 * （v31 起三家 `close` 全为 `null` ⇒ 本版没有会归零的所，「已归零」那支保留备用。）
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

  /* 有持仓时**除「当前所」以外的每一行都点不动**（2026-10-02 审计修 · 用户拍板）：
     `engine.switchExchange` 的硬规矩是「有持仓必须先全部平掉」（仓位挂在这一家所上、搬不走），
     原来弹层里的行**照样是可点的**——玩家点一下只换来一条错误日志。现在提前置灰，
     并让每行自己把原因写出来（「有持仓，先平仓」）。 */
  const holding = heldSyms(s).length > 0;

  for (const ex of EXCHANGES) {
    const notYet = t < ex.open;
    const dead = ex.close != null && t >= ex.close;
    const isCur = ex.id === s.ex;
    const row = el('button', 'pick-row');
    row.dataset.ex = ex.id;
    // 在途时**所有行都不可点**（同时在途只允许一笔）—— 让点不动的按钮先于错误日志表达这件事
    row.disabled = notYet || dead || !!s.transfer || (holding && !isCur);
    row.classList.toggle('on', isCur);

    /* 上行：名字 ＋ **两张费率**（v12 · 方案 §11.3）；下行：这家所自己的事
       （通道 / 到账预估 / 为什么不能选）。
       ⚠️ 合约那一档只在**该所此刻真有合约**时显示（`futSteps` 首档已开）——
          直接调 `feeRateOf(..., 'fut')` 会在没有合约的年份回落到杠杆值，
          于是 2013 年的 BitMEX 会凭空显示一行「合约 0.05%」。 */
    const { rail, n } = transferPlan(s, ex.id);
    const futOn = ex.futSteps != null && ex.futSteps[0].from <= t;
    const feeTxt = `费率 ${fmtRate(feeRateOf(ex.id, t, 'margin'), 2)}`
      + (futOn ? `｜合约 ${fmtRate(feeRateOf(ex.id, t, 'fut'), 2)}` : '');
    const l1 = el('div', 'pick-l1');
    l1.append(el('b', null, ex.name), el('u', null, feeTxt));
    /* 到账口径跟着通道走（§11.6）：链上通道仍报「确认数 ＋ 小时」，电汇时代改成「通道 ＋ 天数」
       —— 2013 年那行「2 确认 · 预估 3h」是链上才有的说法，电汇根本不吃拥堵。 */
    const note = notYet ? '还没开业'
      : dead ? '已归零'
        : s.transfer ? '转账在途'
          : isCur ? '当前所'
            : holding ? '有持仓，先平仓'
              : rail.hours ? `${rail.label} · ${Math.round(n / 24)} 天`
                : `${confirmationsOf(ex.id)} 确认 · 预估 ${n}h`;
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
  /* 三行改成**划转本身的账**（v12 · 方案 §11.4 / §11.7）：原来那行「费率」报的是目标所的
     **交易**费率，与「这一搬要花多少」根本不是一回事 ——「手续费」那一行（电汇 $20 / Omni $0.3 /
     ERC-20 $30）才是玩家按下确认后立刻会少掉的钱，必须让它站在这里。
     ⚠️ 「拥堵」只在**链上通道**出现：电汇不吃拥堵（§11.6），对那次搬家一个字节都不影响。 */
  const { rail, fee, n, extra } = transferPlan(s, id);
  const rows = el('div', 'confirm-rows');
  rows.append(
    line('通道', rail.label),
    ...(rail.hours ? [] : [line('拥堵', congestionLabel(congestion))]),
    /* 「额外确认」只在大额时出现（`extra > 0`）：小额不加行、不动既有排版，大额给一个「为什么更慢」的解释。 */
    ...(extra ? [line('额外确认', `+${extra} 个`)] : []),
    line('预估到账', rail.hours ? `${Math.round(n / 24)} 天` : `${n} 小时`),
    line('手续费', fmtMoneyShort(fee)),
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
  /* 主菜单弹窗（读取存档 / 挑战模式）挂在同一个 `#overlay` 上，却**不登记** `picker`
     —— 登记进去的话，关弹窗会把背后的主菜单一起清掉（见 `openMenuDlg` 那段注释）。
     所以这里显式捎带关一层：下面那句 `textContent = ''` 本来就会连它一起抹掉，
     但 `menuDlg` 那个引用得跟着清干净，否则下次 `closeMenuDlg()` 会去删一个已经不在树上的节点。 */
  closeMenuDlg();
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
    /* 类别一律走 `tagOf`（老存档没有 `tag` 字段、新闻到点要衰老）。
       整行左侧 2px 色条 = 类别色（CSS 里按 `.log-row.<tag>` 取），`mkt`（全市场级）再叠一层
       边框 ＋ 淡底 —— 与日志条那两行走**同一套** class，两个入口一副样子。 */
    const tg = tagOf(e, s.i);
    const row = el('div', `log-row ${tg}${tg === 'mkt' ? ' alert' : ''}`);
    row.append(el('i', `log-tag ${tg}`, LOG_TAGS[tg]));
    row.append(
      el('u', null, fmtHour(GAME.start + (e.at ?? s.i) * HOUR_MS)),
      el('span', kindClsOf(e.kind), e.text),
    );
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
export function openIntro(scenId) {
  closePicker();
  const ov = document.getElementById('overlay');
  if (!ov) return;

  /* 年代（M1 · 2026-10-01）：开场白必须**说清这一局从哪年开始** —— 否则年代局的开场
     与经典全程一字不差，玩家分不清自己选的那一局到底生效了没有。
     ⚠️ 经典全程那三行**一字不改**（Bitfinex / 币安都是玩家看惯的旧文案），其余年代走下面那支。 */
  const sc = scenarioOf(scenId);
  const money = `$${sc.cash.toLocaleString('en-US')}`;

  /* 整屏暗底（本轮 ①）—— 与主菜单同一块 `.menu-back`：开场白与主菜单是**连着的两屏**，
     中间不该出现「一屏有暗底、下一屏没有」的跳变。盒子本身仍是居中的 `.confirm`。 */
  const back = el('div', 'menu-back');
  const box = el('div', 'confirm intro');
  box.append(el('h3', null, 'Degen · 加密交易员'));
  if (sc.id === 'classic') {
    box.append(el('p', null,
      `2013 年 1 月，你带着 ${money} 走进 Bitfinex。\n`
      + '这里没有救世主：行情 24 小时不睡，交易所会说没就没。\n'
      + '从 Bitfinex 活到币安，撑到 2024 年底 —— 那就叫赢。'));
  } else {
    const at = new Date(sc.at);
    /* ⚠️ **同一笔钱只说一次**：`winter` / `degen` 的副题（`blurb`）本身就是「你只有多少钱」这句叙事，
       第一行再念一遍本金就成了原地重复。副题里已经写了那笔钱 ⇒ 第一行只报年月与交易所。 */
    const arrival = sc.blurb.includes(money)
      ? `，你走进 ${exchangeOf(sc.ex).name}。`
      : `，你带着 ${money} 走进 ${exchangeOf(sc.ex).name}。`;
    box.append(el('p', null,
      `${at.getUTCFullYear()} 年 ${at.getUTCMonth() + 1} 月${arrival}\n`
      + '这里没有救世主：行情 24 小时不睡，交易所会说没就没。\n'
      + `${sc.blurb}\n`
      + '撑到 2024 年底 —— 那就叫赢。'));
  }
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
 * 五枚入口决定后续：读取存档 / 开始游戏 / 挑战模式 / 历史回顾 / 交易档案。
 *
 * ⚠️ **整屏**（本轮 ① · 用户拍板）：铺满全屏的暗底 ＋ 居中一列（图标 / 标题 / 副标题 / 五入口）。
 *    之前它沿用 `.confirm`（`left/right:12px` 的一张小卡、且不铺暗底）—— 那副样子读起来像
 *    「页面中间弹了个提示」，不像**开机画面**。现在背后那层 `.menu-back` 把这个游戏彻底盖住。
 *    但它**仍然不是「点外面能关掉的菜单」**：`.menu-back` 不带 `pointerdown` 回调，点了不会关。
 * ⚠️ 弹窗期间时钟不启动（`main.js` 的 `clock.start()` 排在 `onMenu` 之后）。
 * ⚠️ **五枚入口的位置永不移动**（2026-10-02 · 用户拍板）：原来「读取存档」只在有档时出现、
 *    点开还会在按钮列下面**摊开**列表（`toggleScenarioList` / `slotList`），两种情况都会把
 *    其余几枚推上推下 —— 同一枚键在不同开机状态下落在不同位置，手指记忆就废了。
 *    现在没有档时「读取存档」**置灰常驻**，选择一律发生在新开的**弹窗**里
 *    （`openSavePick` / `openScenPick` / `openMenuDlg`），按钮列本身一个像素都不动。
 * ⚠️ 「开始游戏」在有档时会先变「确认重开」（双重确认的状态机在 `main.js`，理由同 `onReset`）。
 *
 * ⚠️ 「安装应用」（PWA）**只要不在桌面上跑就一律出现**（2026-10-01 改）。
 *    原来是「只有浏览器交出 `beforeinstallprompt` 才出现」—— 那条规矩在**能感知到失败**时才成立：
 *    按钮不出现，玩家知道这条路不通。可它挡不住「按钮出现了、点下去却什么都没发生」这种更糟的情况
 *    （Chrome 冷却期里 `prompt()` 静默失效），也直接把 iOS Safari / 国产内核挡在门外 ——
 *    那些机器**装得上，只是没有一键通道**。现在按钮常驻，点下去必定给到结果：原生弹窗，或三步图文。
 * ⚠️ 底部那行构建日期由 `vite.config.js` 的 `define` 注入（`__BUILD_DATE__`，UTC+8）——
 *    上传服务器后一眼能看出拿到的是不是最新版。
 */
export function openMenu({ canLoad = false } = {}) {
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

  /* 有档时「读取存档」是主入口（2026-10-01 用户拍板）：这一趟开机的目的多半是接着玩，
     它才给 `.act long`（主色实底），「开始游戏」顺势退成 `.act chan`。
     ⚠️ 但**位置永远在第一格**（2026-10-02 用户拍板）：没有档时只**置灰**、不隐藏 ——
        藏起来会让后面四枚整体上移一格，那正是本轮要修的东西。 */
  const btns = el('div', 'menu-btns');
  const load = el('button', canLoad ? 'act long' : 'act chan', '读取存档');
  load.dataset.menu = 'load';                 // 值即子命令，见 `main.js` 的 `onMenu`
  load.disabled = !canLoad;
  btns.append(load);
  const start = el('button', canLoad ? 'act chan' : 'act long', '开始游戏');
  start.dataset.menu = 'start';
  btns.append(start);
  /* 挑战模式（M1 · 2026-10-01）—— 年代局的**入口**（值 `'scen'`，见 `main.js` 的 `onMenu`）。
     它自己不开始游戏：点开先弹出那五张年代卡（`openScenPick`），玩家再在里面挑一张。 */
  const scen = el('button', 'act chan', '挑战模式');
  scen.dataset.menu = 'scen';
  btns.append(scen);
  const review = el('button', 'act chan', '历史回顾');
  review.dataset.menu = 'review';
  btns.append(review);
  /* 交易档案（M2 · 2026-10-01）—— 走进「玩过的每一局」那一页（`main.js` 的 `onMenu`）。
     与「历史回顾」同档：都是**看**的入口，都不是开新局。 */
  const careers = el('button', 'act chan', '交易档案');
  careers.dataset.menu = 'careers';
  btns.append(careers);
  /* 游戏说明（2026-10-02 用户要求）—— 讲**这个游戏是什么**：有哪些模块、机制怎么咬合、深度在哪。
     与「读取存档 / 挑战模式」同一条路：弹一层（`openMenuDlg`），菜单那几枚按钮一动不动。 */
  const about = el('button', 'act chan', '游戏说明');
  about.dataset.menu = 'about';
  btns.append(about);
  if (!isStandalone()) menuInstallBtn(btns);
  box.append(btns);
  /* ⚠️ 菜单本身**只有这一列按钮**（2026-10-02）：原来读档那两行与五张年代卡是摊在它下面的，
     现在都收进弹窗（`openSavePick` / `openScenPick`）—— 菜单高度从此恒定。 */

  /* 构建日期（UTC+8）——`__BUILD_DATE__` 由构建期替换成字面量字符串 */
  box.append(el('p', 'menu-build', `构建 ${__BUILD_DATE__}`));

  ov.append(back, box);
  ov.hidden = false;
  picker = ov;
}

/**
 * 是否已经「装在桌面上」在跑（独立窗口）。
 * 装了就不再显示安装入口 —— 那是玩家已经完成的事。
 * ⚠️ 两条都要判：标准是 `display-mode: standalone`，iOS Safari 用的是它自己那套
 *    `navigator.standalone`（它不实现 display-mode 媒体查询的那部分）。
 */
export function isStandalone() {
  try {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
  } catch { return false; }
}

/* ══════════════ 主菜单弹窗（2026-10-02 · 用户要求） ══════════════
   「读取存档」与「挑战模式」原来是在按钮列**下面摊开**一段列表（`.menu-slots` / `.menu-scens`）——
   一切进那个状态，菜单按钮就被推上推下，同一枚键在不同开机状态下落在不同位置，
   玩家的手指记忆直接失效。现在两处都改成**弹一层**：菜单那五枚永远不动。

   两条硬约束：
     ① **不能登记成 `picker`** —— `closePicker()` 清的是整个 `#overlay`（`textContent = ''`），
        而主菜单就住在里面；一关弹窗，菜单跟着一起没。所以这里另存 `menuDlg`，
        `closeMenuDlg()` 只摘自己那一层（主菜单原样留在背后）。
     ② 出口给**两个**：面板底部那枚「返回」（`data-menuback`，见 `bind.js` 的 `ACTION_KEYS`）
        ＋ 点暗底（沿用全站「点外面关掉」的既有惯例）—— 这是从开机画面走出去的路上的一层，
        不能让人找不到出口。 */

/** 当前打开的主菜单弹窗（整层 wrapper，含暗底与面板）。同一时刻只允许一个。 */
let menuDlg = null;

/** 关掉主菜单弹窗 —— 只摘自己那一层，**不动背后的主菜单**。 */
export function closeMenuDlg() {
  if (!menuDlg) return;
  menuDlg.remove();
  menuDlg = null;
}

/**
 * 弹一层的**公共骨架**（读取存档 / 挑战模式共用）：暗底 ＋ 居中确认盒 ＋ 一枚「返回」。
 * @param {string} title 面板抬头
 * @param {(box:HTMLElement)=>void} build 往盒子里填内容（抬头之下、「返回」之上）
 */
function openMenuDlg(title, build) {
  closeMenuDlg();
  const ov = document.getElementById('overlay');
  if (!ov) return;

  const wrap = el('div', 'menu-dlg');
  const back = el('div', 'pick-back');
  const box = el('div', 'confirm');
  box.append(el('h3', null, title));
  build(box);
  const btns = el('div', 'confirm-btns');
  const ret = el('button', 'act flat', '返回');
  ret.dataset.menuback = '';
  btns.append(ret);
  box.append(btns);

  back.addEventListener('pointerdown', () => closeMenuDlg());
  wrap.append(back, box);
  ov.append(wrap);          // ⚠️ 排在 `.menu-box` 之后 ⇒ 天然盖在菜单之上
  ov.hidden = false;
  menuDlg = wrap;
}

/** 弹窗里的行容器 —— 高度上限兜住「五张年代卡 ＋ 抬头 ＋ 返回」在矮屏上的溢出（内部滚动，
 *  「返回」在滚区之外，永远够得着）。 */
function dlgRows() {
  return el('div', 'dlg-rows');
}

/**
 * 「读取存档」弹窗 —— `slots` = `[{ key, name, date, money }]`，由 `main.js` 的 `menuSlots()` 现算。
 *
 * 每行两行结构（与选所弹层同一副）：**上行 = 名称 ＋ 金额，下行 = 停在哪一天**。
 * 普通槽的名称就是「普通模式」，挑战槽写**那一局到底是哪个年代**（用户 2026-10-02：
 * 「挑战模式存档则显示挑战模式名称 时间 金额」）。
 *
 * ⚠️ 行是 `<button>` 而**不是** `div`：整行都得能点。动作键 `data-slot`（值 = 槽位键
 *    `normal` / `challenge`）已在 `bind.js` 的 `ACTION_KEYS` 里 —— 漏登记就是「点了没反应」。
 */
export function openSavePick(slots) {
  openMenuDlg('读取存档', box => {
    const list = dlgRows();
    for (const it of slots) {
      const row = el('button', 'pick-row');
      row.dataset.slot = it.key;              // ⚠️ 动作键：`main.js` 的 `onSlot`
      const l1 = el('div', 'pick-l1');
      l1.append(el('b', null, it.name), el('span', 'num', it.money));
      row.append(l1, el('div', 'pick-note num', it.date));
      list.append(row);
    }
    box.append(list);
  });
}

/**
 * 「挑战模式」弹窗（M1 的时代卡，2026-10-02 从摊开改为弹出）。
 *
 * **为什么把「经典全程」排除在外**：它就是上面那枚「开始游戏」，列在这里等于同一个入口出现两次
 * （LESS IS MORE）。这里的五张卡全部是 `challenge: true` 的年代局。
 *
 * ⚠️ 卡片是 `<button>`：整张卡都得能点。动作键 `data-scen`（值 = `SCENARIOS[].id`），
 *    已在 `bind.js` 的 `ACTION_KEYS` 里。有挑战档时「先变红、再点一次」那套武装状态机
 *    照旧（`main.js` 的 `onScenario`），卡片节点在武装窗口内一直留在 DOM 里。
 */
export function openScenPick() {
  openMenuDlg('挑战模式', box => {
    const list = dlgRows();
    for (const sc of SCENARIOS) {
      if (!sc.challenge) continue;
      const row = el('button', 'scen');
      row.dataset.scen = sc.id;               // ⚠️ 动作键：`main.js` 的 `onScenario`
      row.append(el('b', null, sc.name));
      row.append(el('u', null, `${sc.from} → ${sc.to}`));
      row.append(el('span', null, sc.blurb));
      list.append(row);
    }
    box.append(list);
  });
}

/**
 * 「游戏说明」弹窗（2026-10-02 用户要求）—— 讲**这个游戏是什么**：
 * 有哪些模块、机制怎么咬合、深度在哪。**不是教程**（怎么点由新手引导负责），
 * 所以全文没有一步操作指令，只有「这里有什么、它为什么存在」。
 *
 * 六块：一局是什么 / 两个工具 / 两条通道 / 你的成交会改变行情 / 市场会自己动 / 两种收场。
 * 每块一行小标题 ＋ 一段说明，超长时内部滚动（`.about`），「返回」留在滚区之外。
 */
const ABOUT = [
  ['一局是什么',
    '2013 年 1 月 → 2024 年 12 月，行情就是 BTC / ETH / XRP / DOGE / SOL 的真实历史小时线。'
    + '从 $1,000 起步，赚到多少都算你的 —— 活到 2024-12-31 收盘即通关，爆仓归零即收场。'],
  ['两个工具',
    '杠杆：借钱买币 / 借币做空，按借入量计日息，维持线按所不同（9–15%）；1x 是最低档，多头不借不计息、不参与强平。'
    + '合约：USDT 本位，每 8 小时一次资金费，维持线 0.5% 起。倍数越高，强平线越近。'],
  ['两条通道',
    '盘口吃冲击与滑点，单子越大越贵；OTC 是私下一口价的大宗通道（单笔 ≥ 当年门槛，$10,000 起逐年抬升），'
    + '不吃滑点、但带一笔溢价（杠杆封顶 5x，可双向）。有持仓时，通道、杠杆、合约、交易所都会锁住 —— 先平仓再换。'],
  ['你的成交会改变行情',
    '每一笔都会在市场里留下永久的位移（买抬价、卖压价），持仓本身还带来抛压折价。'
    + '所以分批建仓、分批卖出（金额档 1/4 · 1/2 · 全部）是躲开冲击的正经打法 —— 同一根 K 线里不能连下。'],
  ['同样的钱，分量不一样',
    '巨鲸 NPC 会在关键时刻推价，新闻会在年代节点冒出来，市场流动性逐年增长 ——'
    + '一笔钱在 2013 年是巨鲸，到 2024 年只是零头。仓位相对市场越大，你自己的冲击就越贵。'],
  ['两种收场',
    '爆仓归零，或活到 2024 收盘。每局的结局会写进交易档案；'
    + '主菜单的挑战模式另有五个年代开局（冰封寒冬、ICO 狂潮、312 前夜、10U 战神、LUNA 归零周）。'],
];

export function openAbout() {
  openMenuDlg('游戏说明', box => {
    const rows = el('div', 'about');
    for (const [h, t] of ABOUT) {
      const blk = el('div', 'about-blk');
      blk.append(el('b', null, h), el('p', null, t));
      rows.append(blk);
    }
    box.append(rows);
  });
}

/** 菜单里的「安装应用」按钮（PWA） */
function menuInstallBtn(btns) {
  const inst = el('button', 'act chan', '安装应用');
  inst.dataset.menu = 'install';
  btns.append(inst);
}

/**
 * 安装图文引导（PWA · 2026-10-01，同日二次重做）。
 *
 * **为什么要按环境分岔**：2026-10-01 线上实测判明，`beforeinstallprompt` 在那边压根没触发过，
 * 而旧版引导对谁都念同一句「打开浏览器菜单（右上角 ⋮）→ 选『安装应用』」——
 * 在**应用内浏览器**（微信 / QQ / 抖音 / 小红书 / 支付宝）里，那个菜单**根本没有这一项**，
 * 玩家照着走就是死路一条，这就是「安装应用完全不起作用」的直接观感。
 * 现在按 `env.kind` 给**那台机器上真的存在**的那条路；应用内浏览器还会明说
 * 「这里装不了，先换浏览器」，而不是让玩家去菜单里找一个不存在的按钮。
 *
 * 这是照 `我创造的完美球员` 那套「保存至手机桌面」的思路来的：拿到桌面图标才是目的，
 * 原生弹窗只是最快的那条路 —— 弹窗没成，图文立刻顶上。
 *
 * 行为：**同一个按钮开 / 关**。展开返回 `true`，收起返回 `false`。
 * ⚠️ 旧版是「点一次就把按钮换成图文」，于是玩家**再也回不到菜单**（按钮没了、没有关闭口）——
 *    装不成的时候连「开始游戏」都少了一行。现在按钮常驻，图文是它下面可开可关的一段。
 */
export function toggleInstallGuide(env) {
  const box = document.querySelector('.menu-box');
  if (!box) return false;
  const btns = box.querySelector('.menu-btns');
  if (!btns) return false;

  const old = box.querySelector('.menu-guide');
  if (old) { old.remove(); return false; }     // 再点一次＝收起

  const { title, steps, note } = installSteps(env);
  const wrap = el('div', 'menu-guide');
  wrap.append(el('b', 'menu-guide-h', title));
  steps.forEach((t, i) => {
    const row = el('div', 'menu-step');
    row.append(el('i', null, String(i + 1)), el('span', null, t));
    wrap.append(row);
  });
  if (note) wrap.append(el('div', 'menu-note', note));
  btns.after(wrap);
  return true;
}

/** 各环境的三步文案。`env` 由 `main.js` 的 `installEnv()` 判定（UA 是那边唯一的信息源）。 */
function installSteps(env) {
  const nativeMiss = '本机浏览器没给出一键安装通道，按上面走同样能装。';
  switch (env.kind) {
    /* 应用内浏览器：装不了，先教换浏览器 —— 这是最常见的「点了没反应」现场 */
    case 'inapp':
      return {
        title: '先换到浏览器打开',
        steps: ['点右上角「···」打开菜单',
          '选「在浏览器打开」（微信里是「在默认浏览器打开」）',
          '到浏览器里再点一次「安装应用」'],
        note: `当前是${env.app}的内置浏览器，它不能把游戏装到桌面。`,
      };
    /* iOS Safari：从不发 beforeinstallprompt，只走分享面板 */
    case 'ios':
      return {
        title: '添加到主屏幕',
        steps: ['点浏览器**底部**工具栏的「分享」按钮',
          '在列表里找到「添加到主屏幕」',
          '点「添加」—— 桌面图标即可直接进入游戏'],
        note: null,
      };
    /* iOS 上的其它浏览器（Chrome / Edge / Firefox for iOS）：全被苹果锁死，装不了 */
    case 'ios-other':
      return {
        title: '用 Safari 打开',
        steps: ['iOS 上只有 Safari 能把网页装到桌面',
          '复制本页地址，改用 Safari 打开',
          '在 Safari 里点「分享」→「添加到主屏幕」'],
        note: '当前这个浏览器不支持添加到主屏幕。',
      };
    /* 安卓：原生弹窗若已给出，第 1 步就是点「安装」；否则退到浏览器菜单 */
    case 'android':
      return {
        title: '安装到桌面',
        steps: ['浏览器应已弹出安装确认 —— 点「安装」',
          '没弹出来：点右上角菜单 ⋮ →「安装应用」',
          '或选「添加到主屏幕」，确认后即可直接进入游戏'],
        note: env.native ? null : nativeMiss,
      };
    /* 桌面：地址栏右侧的安装图标是主路，浏览器菜单是备路 */
    default:
      return {
        title: '安装到本机',
        steps: ['点地址栏右侧的安装图标（⊕ / ⤓）',
          '或在浏览器菜单里选「安装 Degen」',
          '装好后从桌面 / 开始菜单直接进入游戏'],
        note: env.native ? null : nativeMiss,
      };
  }
}

/** 收掉菜单里的安装入口（按钮 ＋ 图文，幂等）。装好之后调用 —— 该做的事做完了。 */
export function menuRemoveInstall() {
  const box = document.querySelector('.menu-box');
  if (!box) return;
  const btn = box.querySelector('.menu-btns [data-menu="install"]');
  const guide = box.querySelector('.menu-guide');
  if (btn) btn.remove();
  if (guide) guide.remove();
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
 * ⚠️ 卡片**贴在高亮区的上或下**（本轮 ②）：不再固定贴底 —— 贴底时它离被圈中的控件可能隔半屏，
 *    玩家得来回找。取目标中心与视口中心比大小：在上半屏就贴它**下面**，在下半屏就贴**上面**；
 *    落地后若下方放不下（`r.bottom + 间距 + 卡高 > 视口高`）再翻到上方。
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

  /* 贴顶 / 贴底二选一（CSS 侧不预设 `top`/`bottom`，否则两条都写会把卡片拉成整屏高）。 */
  const GAP = 8;
  const vh = window.innerHeight;
  const below = (r.top + r.bottom) / 2 < vh / 2;
  const place = (isBelow) => {
    box.style.top = isBelow ? `${Math.round(r.bottom + GAP)}px` : '';
    box.style.bottom = isBelow ? '' : `${Math.round(vh - r.top + GAP)}px`;
  };
  place(below);

  ov.append(ring, box);
  ov.hidden = false;
  /* 落地后量真实高度：下方放不下（目标偏下）就翻到上方 —— 只有这一种越界可能，上方越界意味着目标在下半屏，不会同时发生。 */
  if (below && r.bottom + GAP + box.getBoundingClientRect().height > vh - GAP) place(false);
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
  /* K 线 ＋ 它那几枚头部浮字（币种 / 市值 / 流通 / 24h / 热度 / 画布）整块抽成 `reviewChartSync` ——
     手势快路（`redrawChart`）要**单独**再跑它一遍，不重铺整页。 */
  reviewChartSync(refs, rv, view);

  /* 真实历史指标（里程碑 B · 2026-10-04）—— 全部只吃原始行情，口径见 `engine.review*`。
     格式：波动率走 `fmtRate`（恒正、不带符号）、距高走 `fmtPct`（自带 −）、成交额走 `fmtCap`
     （带 k/M/B/T）；距低的倍数规则见下面那行注释。取不到时一律印 `--`。 */
  const dd = reviewDrawdownOf(sym, rv.i);
  refs.rvStatVol.textContent = fmtRate(reviewVolOf(sym, rv.i), 1);
  refs.rvStatHi.textContent = fmtPct(dd ? dd.hi : NaN, 1);
  /* 距历史低用**倍数**而不是百分比：早期币的涨幅是天文数字（BTC 2017 距 2012 低点 +203870%、
     要 9 个字符，中窄屏必然截断）；`2039×` 是同一个数、只要 5 个字符。
     ≥100 倍取整（六位数百分比的小数位没有信息量），否则一位小数。 */
  const mult = dd ? 1 + dd.lo : NaN;
  refs.rvStatLo.textContent = Number.isFinite(mult)
    ? (mult >= 100 ? Math.round(mult) : +mult.toFixed(1)) + '×'
    : '--';
  refs.rvStatUsd.textContent = fmtCap(reviewVolUsdOf(sym, rv.i));

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

/* ══════════════ 交易档案页（M2 · 2026-10-01） ══════════════ */

/* 结局的显示名走 `core/titles.js` 的 `OVER_LABEL`（与生涯海报同一份字）；
   这里只留**配色** —— 它要的是 CSS 类名，是 UI 层自己的事。 */
const OVER_TONE = { [OVER.LIQUIDATED]: 'down', [OVER.SETTLED]: 'up', [OVER.GAVEUP]: 'mut' };

/**
 * 交易档案页的写入口（与 `renderReview` 同一套写法：**只在签名变了时重建**）。
 * 数据是静态的（进页那一刻读一次），但 `draw()` 可能因别的理由被调到，签名能挡掉无谓重建。
 * @param {object} refs  `mount()` 的返回值
 * @param {Array<object>} list  `core/careers.js` 的记录（新的在前）
 */
export function renderCareers(refs, list) {
  const sig = list.map(r => r.id).join(',');
  if (sig === refs._careersSig) return;
  refs._careersSig = sig;
  refs.careersList.textContent = '';
  if (!list.length) {
    refs.careersList.append(el('div', 'careers-empty', '还没有已结束的对局'));
    return;
  }
  for (const r of list) refs.careersList.append(careerRow(r));
}

/**
 * 一条生涯记录 —— 四代信息：**年代 ＋ 称号 ＋ 结局** / **起止与天数** / **终值 ＋ 倍数** / **徽章**
 *
 * 头行末位两枚键（`u` 的 `margin-left:auto` 把它们一起顶到最右）：
 *   - **生成海报**（M5）：值带记录 id ⇒ `main.js` 按 id 取回那一条去画图（见 `onPoster`）；
 *   - **删除**（M5）：值同样带 id，走**武装式双重确认**（`main.js` 的 `armDelete`）——
 *     点一次只把这枚键改成红字「确认删除」，3 秒无后续自动还原；再点一次才真删。
 *     删除键排在左边、「生成海报」留在原来的最右位 —— 老玩家的手感不动。
 */
function careerRow(r) {
  const row = el('div', 'career');

  const head = el('div', 'career-head');
  head.append(el('b', null, scenarioOf(r.scen).name));
  head.append(el('em', 'career-title', titleOf(r)));
  head.append(el('u', OVER_TONE[r.reason] || 'mut', OVER_LABEL[r.reason] || '结束'));
  const del = el('button', 'career-del', '删除');
  del.dataset.careers = 'del:' + r.id;
  const poster = el('button', 'career-share', '生成海报');
  poster.dataset.careers = 'poster:' + r.id;
  head.append(del, poster);
  row.append(head);

  row.append(el('div', 'career-sub',
    `${fmtDate(r.start, false)} → ${fmtDate(r.end, false)} · ${r.days} 天`));

  const num = el('div', 'career-num');
  const tone = r.final >= r.cash0 ? 'up' : 'down';
  num.append(el('b', 'num ' + tone, fmtMoneyShort(r.final)));
  const mult = multOf(r);
  num.append(el('u', tone, `×${mult.toFixed(mult < 10 ? 2 : 1)}`));
  row.append(num);

  const badges = badgesOf(r);
  if (badges.length) {
    const bar = el('div', 'career-badges');
    for (const b of badges) bar.append(el('span', 'badge', b));
    row.append(bar);
  }

  return row;
}

/**
 * 生涯海报的预览层（M5 · 2026-10-02）—— 把 `ui/shareCard.js` 画好的那张 PNG 摊开给玩家看一眼。
 *
 * 与参考项目（`我创造的完美球员`）一致的三点：**先预览、再决定存不存**、图占主体、
 * 底下两枚键（保存 / 分享）。两点按本项目的规矩改：
 *   ⚠️ **不给「关闭」键** —— 沿用日志浮层那条拍板（点暗底关闭，多一枚按钮就多一处要读的字）；
 *      盒子高度只到 `70dvh`，上下留白足够点。
 *   ⚠️ **没有原生分享面板就不画那枚「分享」** —— 留一枚注定回「不支持」的键只会让人以为坏了。
 *
 * 与 `openLog` 同一条：关闭走**回调**而不是光调 `closePicker` —— 那张图的引用由
 * `main.js` 放掉（渲染层不碰这类资源的生命周期）。
 *
 * @param {string} url      海报的 **data URL**（PNG；见 `ui/shareCard.js::posterURL`）
 * @param {object} [opts]
 * @param {Function} [opts.onClose]  关闭后回调（`main.js` 在那里把引用放掉）
 * @param {boolean} [opts.canShare]  这台机器有没有原生分享面板
 */
export function openPoster(url, { onClose, canShare = false } = {}) {
  closePicker();
  const ov = document.getElementById('overlay');
  if (!ov) return;

  const back = el('div', 'pick-back');
  const box = el('div', 'poster');
  const img = el('img', 'poster-img');
  img.src = url;
  img.alt = '生涯海报';
  box.append(img);

  const save = el('button', 'act long', '保存图片');
  save.dataset.careers = 'psave';
  const btns = el('div', 'confirm-btns');
  btns.append(save);
  if (canShare) {
    const share = el('button', 'act flat', '分享');
    share.dataset.careers = 'pshare';
    btns.append(share);
  }
  box.append(btns);

  back.addEventListener('pointerdown', () => { closePicker(); if (onClose) onClose(); });
  ov.append(back, box);
  ov.hidden = false;
  picker = ov;
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
  /* ⚠️ 标题与史实说明**分两个元素**（2026-10-02 审计修 · 用户拍板）：原来两者拼在同一个 `<p>` 里
     只用一个 `\n` 隔开，字号/颜色一模一样 ⇒ 读起来像同一句话说了两遍。现在标题独立成行并加重，
     说明退成次要的素色段落（`review.js` 那边也同步把复述标题的句子删掉了）。 */
  box.append(el('p', 'nodecard-title', node.title));
  if (node.note) box.append(el('p', 'nodecard-note', node.note));

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
 *   **① 音效 / 行情音 / 新手提示 / 涨跌色 四个开关**
 *   **② 重开本局**（**页内双重确认**：第一次点变「确认重开」，3 秒不点自动还原）
 *
 * ⚠️ 原「订单冲击」开关已于 2026-10-01 随 `s.impactOn` 字段一起删除 —— 冲击是基础玩法，不再是选项。
 * ⚠️ 各控件的 DOM 都在 `mount()` 里一次建好（页是常驻骨架，不像弹层每次现建），
 *    文案 / 高亮由 `update()` 每帧从状态同步。
 * ⚠️ 双重确认的**状态机仍在 `main.js`**（`onReset` / `cancelReset`）：页是静态 DOM、
 *    不参与每帧重绘，把「已武装」这个状态放进渲染层只会两处打架。
 * ⚠️ 这个页**没有「关闭」出口** —— 底部 Tab 就是出口（切回交易 / 资产）。
 */

/* ═════════════════════════ 上帝模式面板（隐藏入口 · 方案 §2） ═════════════════════════ */

/**
 * 上帝面板。入口是**连点顶栏「Degen」5 次**解锁；解锁之后（`s.god` 非空）点一下标题就能重开
 * （计数与超时状态机在 `main.js`，与「重开本局」的双重确认同一个理由：这里是静态 DOM、不参与每帧重绘）。
 *
 * **只剩三件事**（2026-09-29 瘦身）：填入资金 / 跳到日期 / 关闭上帝模式。
 * ⚠️ 上帝模式与普通模式的全部差别就是这三条 ＋ `engine.checkRuin` 的归零不退出 ——
 *    原来那两套价格能力（「冲击倍率」`s.god.mult`、「手动砸盘 / 复位」`s.god.scale`）
 *    已整体删除：普通模式里看不到的暴涨暴跌全都出自它们，与「上帝模式只负责选时间、填资金」这条口径相悖。
 *
 * ⚠️ **日期控件是「年 / 月 / 日 三段档排」**（2026-09-30 裁决）—— 原生 `<input type="date">`
 *    已否决（手机上「点不准、也看不出要跳到哪天」）。三排按钮 ＋ 一行「当前 / 目标」读数 ＋
 *    一枚「跳到」，与杠杆 / 速度那套档位按钮同一设计语言。
 *    ⚠️ **点年 / 月 / 日只改「目标」，真正动状态的是「跳到」** —— 否则在 2 月与 3 月之间来回点时，
 *       每一下都会触发一次「回到过去」的状态重置（见 `main.js` 的 `godJump`）。
 *    ⚠️ 选中态由 `sel` 传入（`main.js` 的 `godSel` 暂存），本函数**自己无状态**。
 * ⚠️ **资金框不能挂 `data-*`**：`bind.js` 拦的是 `[data-*]` 的 `pointerdown` 并会 `preventDefault`，
 *    挂上去就打不了字了。所以值由动作处理函数从同一个面板里按类名读（`god-cash`）。
 *    ⚠️ 档排上那些是**按钮**、不是输入框，照旧挂 `data-*`（`godyear` / `godmon` / `godday`）。
 *
 * @param {object} s
 * @param {{y:number,m:number,d:number}|null} sel 日期选择器的**暂存目标**；`null` = 跟随当前游戏日期
 */
export function openGod(s, sel = null) {
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

  /* ② 跳到日期 —— 向前 = 时间自然流过（持仓保留）；向后 = 回到过去（保留资金、清空仓位）。
       形状 = 两行读数（当前 / 目标 ＋ 跳到）＋ 年 / 月 / 日 三排按钮。 */
  const now = timeOf(s);
  const today = new Date(now);
  const pick = sel ?? { y: today.getUTCFullYear(), m: today.getUTCMonth() + 1, d: today.getUTCDate() };
  /* 一枚档位按钮 —— 挂 `data-*`（这类是按钮，不受 `preventDefault` 影响），选中态走 `.on` */
  const pickBtn = (on, key, v) => {
    const b = el('button', on ? 'set-btn on' : 'set-btn', String(v));
    b.dataset[key] = String(v);
    return b;
  };

  const dRow = el('div', 'set-row');
  dRow.append(el('i', null, '当前'), el('b', 'num', fmtDate(now, false)));
  rows.append(dRow);

  const tRow = el('div', 'set-row');
  const tBox = el('div', 'god-target');
  tBox.append(el('i', null, '目标'), el('b', 'num', fmtDate(Date.UTC(pick.y, pick.m - 1, pick.d), false)));
  const gBtn = el('button', 'set-btn on', '跳到');
  gBtn.dataset.godgo = '';
  tRow.append(tBox, gBtn);
  rows.append(tRow);

  /* ⚠️ 年代开局（M1）起，年份档**从本局开局那一年**起排 —— 再往前没有这一局（`main.js`
     的 `godJump` 也会挡），列出来只是让人点一个跳不过去的年份。 */
  const y0 = new Date(scenarioOf(s.scen).at).getUTCFullYear();
  /* ⚠️ 上界跟着**本局终点**走（§73.7）：挑战局 2–4 个月就收摊，列到 2024 只是让人点一个跳不过去的年份。 */
  const y1 = new Date(GAME.start + (s.endI - 1) * HOUR_MS).getUTCFullYear();
  const yRow = el('div', 'god-pick god-years');
  for (let y = y0; y <= y1; y++) yRow.append(pickBtn(y === pick.y, 'godyear', y));
  rows.append(yRow);

  const mRow = el('div', 'god-pick god-months');
  for (let m = 1; m <= 12; m++) mRow.append(pickBtn(m === pick.m, 'godmon', m));
  rows.append(mRow);

  /* 日的枚数跟着选中的年月走 —— `new Date(Date.UTC(y, m, 0))` 就是该月的最后一天 */
  const days = new Date(Date.UTC(pick.y, pick.m, 0)).getUTCDate();
  const ddRow = el('div', 'god-pick god-days');
  for (let dd = 1; dd <= days; dd++) ddRow.append(pickBtn(dd === pick.d, 'godday', dd));
  rows.append(ddRow);

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
