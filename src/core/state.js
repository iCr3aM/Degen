/**
 * 状态定义与工厂
 * ===============================================================
 * 一个档 = 一个普通对象，可以直接 JSON 序列化 —— 存档就靠这一条性质。
 *
 * 时间只有**一个**真相源：`s.i`（全程第几根小时 K 线）。
 * 日期、行情、解锁币种全部由它派生（`format.fmtDate` / `market`），谁都不许另存一份时间。
 */

import { GAME } from './config.js';

export const STATE_VERSION = 9;

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
     * 各交易所的余额（USDT）—— **资产按所分账**（GDD §7.2）：
     * Mt.Gox 归零时只清零它自己的那一格，玩家早搬走的钱安然无恙。
     * 没有持仓占用的那一格，就是「可用保证金」（当前所的那一格）。
     */
    books: { [GAME.ex]: GAME.cash },

    /**
     * 持仓表（逐仓，**每个币最多一条**）—— 键 = 币符号，`{}` 表示空仓。
     * 多条仓位可以同时存在（BTC 多单 + ETH 空单），各自独立算保证金率与强平价；
     * 全仓模式是 GDD §9.2 里「后期解锁」的东西，本版不做。
     */
    positions: {},

    /**
     * 在途的链上转账（P2-A）—— `null` 或 `{ amount, from, to, departAt, arriveAt }`。
     * **同时只允许一笔**（LESS IS MORE），且这笔钱**不在任何交易所的账上**（`books` 里已经扣掉了）：
     *   - 它**计入权益**（否则一换所权益就显示 $0，还会被误判成破产）
     *   - 它**不计入可用保证金**（`cashOf` 只看 `books`，天然满足）
     *   - 它是**唯一能躲过交易所归零的钱** —— 已经在链上，不归任何一家所管
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
     * 场外配资（Batch 5 · B30）—— 只在**资产归零**时触发一次。
     *   `loaned`：本局是否已经借过（只给一次机会，第二次归零就是真结束）
     *   `loan`  ：在贷：`null` 或 `{ amount, owe, dueAt }`
     *   `pending`：待玩家决策：`null` 或 `'loan'`（归零后的借贷遮罩；**此期间时钟暂停**）
     */
    loaned: false,
    loan: null,
    pending: null,

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

/**
 * 当前交易所的余额（= 可用保证金）。
 * 没去过的交易所 `books` 里没有那一格，所以取不到就当 0。
 */
export const cashOf = s => s.books[s.ex] ?? 0;

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

/** 追加一条日志（新的在前） */
export function pushLog(s, text, kind = 'info') {
  s.log.unshift({ at: s.i, text, kind });
  if (s.log.length > LOG_MAX) s.log.length = LOG_MAX;
}
