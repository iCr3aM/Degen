/**
 * 状态定义与工厂
 * ===============================================================
 * 一个档 = 一个普通对象，可以直接 JSON 序列化 —— 存档就靠这一条性质。
 *
 * 时间只有**一个**真相源：`s.i`（全程第几根小时 K 线）。
 * 日期、行情、解锁币种全部由它派生（`format.fmtDate` / `market`），谁都不许另存一份时间。
 */

import { GAME } from './config.js';

/* ⚠️ v15（C8-B2 · 2026-09-30）：新增限价挂单 `s.orders`——挂单即冻结保证金，
   并把冻结款计入 `equity`。旧档没有这张表，`createState` 之外没有任何地方能补出来 ⇒ **弃档重开**（既有规范）。 */
export const STATE_VERSION = 15;

export function createState() {
  return {
    v: STATE_VERSION,

    /** 当前处在全程第几根小时 K 线（0 = 2013-01-01 00:00 UTC） */
    i: 0,

    /**
     * 本局的全局随机种子（S0 · 细粒度模拟的地基）—— 所有细刻度随机数的唯一源头
     * （见 `rng.js` 的 `rand`）。现在恒为 `GAME.seed`，S4 肉鸽化时才改由玩家输入 / 日期派生。
     */
    seed: GAME.seed,

    /** 当前所在的交易所 id（见 `config.EXCHANGES`）—— 开局那 $3,000 存在 Mt.Gox */
    ex: GAME.ex,

    /**
     * 各交易所的余额 —— **资产按所分账 ＋ 每所两格**（v13 · 方案 §2）：
     *
     *     `books[exId] = { usd, usdt }`
     *
     * - **按所分账**（GDD §7.2）：Mt.Gox 归零时只清它自己那一格，玩家早搬走的钱安然无恙。
     * - **两格**（v13 新增）：`usd` = 美元法币、`usdt` = 稳定币。开局那 $3,000 是**美元**
     *   —— 2013 年世界上还没有 USDT（Tether 2014-11 才在 Omni 上发币），
     *   当年入金、电汇、结算全部走法币。要玩合约得先在资产页「买 U」。
     *   ⚠️ 两者**面值 1:1** 参与权益计算（见 `engine.equity`）—— 溢价只在「买 U」那一刻结算。
     */
    books: { [GAME.ex]: { usd: GAME.cash, usdt: 0 } },

    /**
     * 持仓表（逐仓，**每个币最多一条**）—— 键 = 币符号，`{}` 表示空仓。
     * 多条仓位可以同时存在（BTC 多单 + ETH 空单），各自独立算保证金率与强平价；
     * 全仓模式是 GDD §9.2 里「后期解锁」的东西，本版不做。
     */
    positions: {},

    /**
     * 限价挂单表（C8-B2 · ROADMAP §33）—— 与 `positions` **同构**：键 = 币符号，`{}` = 无挂单，
     * **每币最多一张**（LESS IS MORE）。
     *
     *     `orders[sym] = { side, lev, spot, ex, limit, dLock, size, filled, margin, mix }`
     *
     * - `side`   ：`'long'` / `'short'`
     * - `limit`  ：挂单价 L（触及即成交，成交价**恒 = L**，跳空也不给 price improvement）
     * - `dLock`  ：挂单那一刻锁定的偏离度 `|L − 中间价| / 中间价` —— 深度上限 Q 用它，
     *              不随行情漂移（否则挂单越久越容易成交，那是错的）
     * - `size`   ：挂单名义**币量**（不是保证金），`filled` = 已成交币量（分批建仓）
     * - `margin` ：**仍未成交**部分冻结的保证金（已经离开 `books`，但钱还是玩家的）
     * - `mix`    ：冻结时说好的两格构成 —— 撤单 / 成交原路退回用（与 `positions.mix` 同一套）
     *
     * ⚠️ `margin` **必须**计入 `equity()`（见 `engine.equity`）—— 钱只是离开了 `books`，
     *    没离开本局；漏了就会「一挂单就被误判破产」（与 `s.transfer.amount` 同一先例）。
     * ⚠️ `margin` **不进** `spendableOf` —— 冻结的钱不能再拿来开新仓。
     */
    orders: {},

    /**
     * 在途的划转（P2-A）—— `null` 或 `{ amount, fee, rail, cur, from, to, departAt, arriveAt }`。
     * **同时只允许一笔**（LESS IS MORE），且这笔钱**不在任何交易所的账上**（`books` 里已经扣掉了）：
     *   - 它**计入权益**（否则一换所权益就显示 $0，还会被误判成破产）
     *   - 它**不计入可用保证金**（`cashOf` 只看 `books`，天然满足）
     *   - 它是**唯一能躲过交易所归零的钱** —— 已经在路上，不归任何一家所管
     *
     * ⚠️ v12 起多了两个字段（方案 §11.4）：`fee` = 发起时就已扣走的划转手续费（**不在**
     *    `amount` 里 —— `amount` 是**实际到账**的净额），`rail` = 走的哪条通道（`wire` / `omni` /
     *    `erc20` / `trc20`）。两个字段目前都只供展示与排查，账目本身在发起那一刻就已经结清。
     * ⚠️ **v13 再加 `cur`**（方案 §2.3）：这笔钱是 `'usd'` 还是 `'usdt'` —— 由发起时的年代定
     *    （`config.cashCurAt`，与通道同步：电汇时代搬美元、链上时代搬 U）。到账时进新所的**那一格**，
     *    否则 2013 年的 Mt.Gox 会凭空冒出一笔 USDT。
     */
    transfer: null,

    /**
     * 玩家造成的那部分拥堵（P2-A）—— `[{ add, at }]`，48 游戏小时内线性衰减到 0。
     * ⚠️ 拥堵的年代基础值与锚点加成都是 `s.i` 的纯函数，**不入存档**；只有这一份要存。
     */
    pulse: [],

    /**
     * 订单冲击总开关（基础玩法，默认**开**）—— 设置面板里可关。
     * ⚠️ 它在**主状态**里，不在 `degen_settings`（音效那种纯 UI 偏好）：它会改变权益、强平、
     *    滑点、资金费的计算结果，是玩法逻辑。放进设置存档会出现「同一份档在不同机器上跑出不同结果」。
     */
    impactOn: true,

    /**
     * 订单冲击池 —— `sym -> [{ v, at }, …]`：`v` = 该笔成交留下的冲击量（正 = 买上去、负 = 砸下来），
     * `at` = 写入它的那个 `s.i`。行情位移 = `Σ v_k × decay(s.i − at_k)`，**逐根**衰减（Bouchaud 幂律）。
     *
     * ⚠️ C1（2026-09-29）：由「单池 `{v, at}`」改成**逐笔列表**（≤ `SHOCK.listMax` 笔）——
     *    单池下第二次加仓会吃掉第一次的衰减进度。上限溢出时最旧的几笔按残存值归并成一项。
     *
     * ⚠️ 与 `pulse` 是两套东西，别混：
     *    `pulse`  = 「链上转账造成的拥堵」→ 只影响**转账延迟**，不动价格
     *    这里     = 「下单造成的价格位移」→ 只影响**价格**，不动拥堵
     */
    flow: {},

    /** 当前正在看的币种 */
    sym: 'BTC',

    /**
     * 下单模式（U1 · ROADMAP §21.4）—— `'spot'`（现货，默认）或 `'fut'`（合约）。
     * ⚠️ 它只决定**「1x 做多」**这一种组合的语义：`'spot'` ⇒ 现货（不强平、不付资金费）；
     *    `'fut'` ⇒ 合约（也付资金费、也有强平价）。**做空与任何 ≥2x 恒为合约**（与模式无关），
     *    因为那两种本来就需要维持保证金 —— 见 `engine.openTrade()` 里那个 `spot` 表达式。
     * ⚠️ OTC 通道恒为现货（不随它变）。
     */
    mode: GAME.mode,

    /**
     * 下单通道（P2-B3 · GDD §15.3）—— `'book'`（盘口，默认）或 `'otc'`（场外大宗）。
     * ⚠️ 它是**玩家的选择**，所以必须入存档；但「OTC 是否生效」由 `engine.chanOf` 判 ——
     *    权益掉回门槛下时自动退回盘口，免得玩家卡在一个已经藏起来的通道里。
     */
    chan: 'book',

    /** 玩家选择的杠杆（会在档位表里夹取，见 `config.leverageOptionsAt`） */
    lev: 1,

    /** 下单金额占「可用保证金」的比例，1 = 全部 */
    sizeFrac: 1,

    /** 速度倍率：1 / 5 / 10 / 50（`config.SPEEDS` 是唯一真源） */
    speed: 1,

    /** 暂停 */
    paused: false,

    /**
     * 已实现盈亏累计（含**全部**手续费与资金费），用于战后复盘。
     * ⚠️ 口径是「真实现金变动」：开仓费、资金费、平仓盈亏 − 平仓费、爆仓 / 归零的保证金全在里面
     *    （Batch 5 · B23 补齐了前两项）。它**不参与任何玩法判定** —— 破产看的是 `equity(s)`。
     */
    realized: 0,

    /**
     * 资金曲线（v13 · 方案 §4）—— `s.eq[n]` = **第 n 个游戏日**记录的权益，升序。
     * 由 `engine.sampleEquity()` 在每根小时 K 线跑完时补记（`s.eq.length` 天然就是「下一个要记的日子」，
     * 所以不需要另存一份「上次记到哪天」的眼睛）。
     * ⚠️ 全程 4,383 个点 ≈ 45 KB —— 存得下，但**不许**改成每小时的粒度（那是 10 万个数）。
     */
    eq: [],

    /**
     * 场外配资（Batch 5 · B30）—— 只在**资产归零**时触发一次。
     *   `loaned`：本局是否已经借过（只给一次机会，第二次归零就是真结束）
     *   `loan`  ：在贷：`null` 或 `{ amount, owe, dueAt }`
     *   `pending`：待玩家决策：`null` / `'loan'`（归零后的借贷遮罩）/ `'warn'`（破产预警遮罩）。
     *     **两种待决态下时钟都暂停**（`s.paused` 同真），遮罩替掉正常界面（见 `main.js` 的 `draw`）。
     *     ⚠️ `'warn'` 与 `'loan'` 是**两回事**：前者只是提醒（点「知道了」即可），后者是要命的二选一。
     *     所有 `s.pending` 的消费点都必须按**值**分派，不能只判真值。
     */
    loaned: false,
    loan: null,
    pending: null,

    /**
     * 破产预警遮罩记的**是哪个事件**（`anchors.warnAnchorAt` 命中锚点的 `at`）。
     * 只在 `pending === 'warn'` 期间有效；渲染层拿它反查文案（`anchorOfAt`）。
     */
    warnAt: null,

    /**
     * 新手提示开关（v11 · ③）—— 开局叙事弹窗上「我是新手 / 我是老手」二选一写入。
     * 管的是**引导类**内容：破产预警遮罩、以及将来的开仓提示 / 教学。
     * ⚠️ **开场叙事不受它管**（老手新首都该看一遍）—— 那是 `openIntro` 无条件弹的。
     * ❗ 它落在**主状态**里（与 `impactOn` 同一个理由）：预警遮罩会暂停游戏、改变时间推进的节奏，
     *    不是纯 UI 偏好，放进 `degen_settings` 会让同一份档在不同机器上跑出不同结果。
     */
    hintOn: true,

    /** 上帝模式下「已归零」的一次性提示标志 —— 避免每根 K 线刷一条日志；填入资金后清掉 */
    godRuined: false,

    /**
     * 上帝模式（连点顶栏「Degen」5 次开启）—— `null` = 从未开启。
     *   `mult`     ：订单冲击倍率，1 = 按现实平方根定律，面板可调 1~100
     *   `scale`    ：手动设价，`sym -> 价格乘数`（**全局永久**，靠「复位」还原）
     *   `lastFill` ：上次「填入资金」用的数，归零后一键补回
     * ⚠️ 手动设价与订单冲击是两套位移，**相乘**叠加 —— 见 `god.js` 的 `factorFor`。
     */
    god: null,

    /** 游戏结束：null 或 { reason, at } */
    over: null,

    /** 流水日志（最近若干条，倒序展示） */
    log: [],
  };
}

/* ───────────────────────── 两格账本（v13 · 方案 §2） ───────────────────────── */

/** 一格空账 —— **冻结常量**：`bookOf` 在「这所还没去过」时返回它，
 *  调用方一旦就地改它就会在严格模式（ESM 天然严格）下当场抛错，而不是悄悄污染所有人。 */
const ZERO_BOOK = Object.freeze({ usd: 0, usdt: 0 });

/** 一格新的空账（**每次都是新对象** —— 不许把上面的冻结常量拿去用） */
export const blankBook = () => ({ usd: 0, usdt: 0 });

/** 取某一所的账，缺省「当前所」；没去过 ⇒ 冻结的空账（只读，别改它） */
export const bookOf = (s, ex = s.ex) => s.books[ex] ?? ZERO_BOOK;

/** 取某一所的账，没有就**建一格**（写账前必须先过这一步） */
export const ensureBook = (s, ex = s.ex) => (s.books[ex] ??= blankBook());

/**
 * 某一所的**总余额**（两格之和）—— 面值 1:1。
 * ⚠️ 它与 `engine.equity` 的口径必须一致：USDT 在权益里也按 $1 计，
 *    溢价已经在「买 U」那一刻结清，不再按市价重估（否则同一笔钱被计两次价）。
 */
export const cashOf = (s, ex = s.ex) => { const b = bookOf(s, ex); return b.usd + b.usdt; };

/** 当前所**这一格**的余额（资产页分列显示用） */
export const slotOf = (s, cur, ex = s.ex) => bookOf(s, ex)[cur] ?? 0;

/**
 * **这一单能用多少钱**（`openTrade` 的保证金基数）。
 * - `mustUsdt`（合约）：只认 USDT —— USDT 本位永续，保证金必须是 U。
 * - 否则（现货 / OTC）：两格之和，先扣 U 不足补美元（见 `debit`）。
 */
export const spendableOf = (s, mustUsdt = false) => {
  const b = bookOf(s);
  return mustUsdt ? b.usdt : b.usd + b.usdt;
};

/**
 * **扣款** —— 优先扣 USDT、不足部分补 USD（方案 §9.2 ②）。
 * @param {boolean} mustUsdt 合约保证金：只认 USDT，美元那一格**一分都不许动**
 * @returns {{usd:number, usdt:number}|null} 实际从两格各扣了多少（**原路退回用这个**）；
 *   余额不够返回 `null`，且**一格都不动**（调用方可安全地直接拒绝）。
 */
export function debit(s, amount, mustUsdt = false) {
  const b = ensureBook(s);
  if (!(amount > 0)) return { usd: 0, usdt: 0 };
  if (mustUsdt) {
    if (b.usdt + 1e-9 < amount) return null;
    b.usdt -= amount;
    return { usd: 0, usdt: amount };
  }
  if (b.usd + b.usdt + 1e-9 < amount) return null;
  const usdt = Math.min(b.usdt, amount);
  b.usdt -= usdt;
  const usd = amount - usdt;
  b.usd -= usd;
  return { usd, usdt };
}

/**
 * **入账** —— 按 `mix`（当初扣的那两笔）的**比例**分回两格：平仓原路退回。
 *   2013 年那 $3,000 是美元 ⇒ 平仓回的还是美元（否则 Mt.Gox 会凭空空降 USDT）。
 * 盈利 / 亏损按同比例放大缩小（两格一起长、一起缩），不会凭空改变资产构成。
 *
 * ⚠️ `mix` 缺失或两格全 0（老档、贷款、转账到账）⇒ **整笔进 USDT** ——
 *    现代年代的钱默认就是 U；需要按币种入账的调用方（转账到账）自己指定格子，不走这里。
 * ⚠️ `amount` 可以是**负数**（极小保证金下平仓费 > 权益的边角）：两格按比例一起减，
 *    与原实现「余额可直接被减成负数」逐位一致 —— 那时会被 `isBankrupt` 接住。
 */
export function credit(s, ex, amount, mix) {
  const b = ensureBook(s, ex);
  if (!Number.isFinite(amount) || amount === 0) return;
  const total = mix ? mix.usd + mix.usdt : 0;
  const usdt = total > 0 ? amount * (mix.usdt / total) : amount;
  b.usdt += usdt;
  b.usd += amount - usdt;
}

/** 某个币的持仓；没持仓取到 `undefined`，统一折成 `null` 方便判断 */
export const posOf = (s, sym) => s.positions[sym] ?? null;

/** 当前所有持仓的币符号（顺序 = 建仓先后） */
export const heldSyms = s => Object.keys(s.positions);

/**
 * 某个币**已被玩家锁走的枚数**（P2-B2 · GDD §15.1 / §15.4）—— 派生量，**不入存档**。
 * 每币最多一条仓位，所以 O(1) 就够。
 *
 * 三条口径：
 *   - 只有**多头方向**算数：空头并没有把币从市场里拿走
 *   - **OTC 买来的币不算**（§15.3：对手方私下一口价，不从市场拿走流通量）
 *   - 没持仓 ⇒ 0
 */
export function capturedOf(s, sym) {
  const pos = s.positions[sym];
  if (!pos || pos.side !== 'long' || pos.otc) return 0;
  return pos.size;
}

/** 是否持有任何仓位 */
export const anyHeld = s => heldSyms(s).length > 0;

/** 日志上限：只留最近这些条，免得存档无限膨胀 */
export const LOG_MAX = 60;

/**
 * 追加一条日志（新的在前）。
 *
 * ⚠️ **相邻同文案折叠**（2026-09-29 拍板）：若与最新一条的正文**完全相同**，只把它的时候戳
 *    推到 `s.i`，不再新增一条。置灰键（如「杠杆 暂不可用 ｜ 该所此刻没有融资业务」）长期置灰，
 *    连点十几次就会用同一句话刷满整格；折叠后「点了 12 次」在日志里就是一条，
 *    且时间戳停在最后一次点击 —— 正是「只留最新一次的那条」。
 *    只在**相邻**时折叠（中间夹了别的日志就各留一条），所以时间线不会被压平。
 * ⚠️ 判据只用 `text`、**不含** `kind`：同一句话在不同入口可能一个 `info` 一个 `bad`
 *    （如「现货做空 暂不可用」主入口是 `info`、引擎兜底是 `bad`），带上 kind 判就会漏合并。
 * ⚠️ 结构零变化（仍是 `{at,text,kind}`）⇒ 不改 `STATE_VERSION`，老档照读。
 */
export function pushLog(s, text, kind = 'info') {
  const head = s.log[0];
  if (head && head.text === text) { head.at = s.i; return; }
  s.log.unshift({ at: s.i, text, kind });
  if (s.log.length > LOG_MAX) s.log.length = LOG_MAX;
}
