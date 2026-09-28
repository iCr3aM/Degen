/**
 * 状态定义与工厂
 * ===============================================================
 * 一个档 = 一个普通对象，可以直接 JSON 序列化 —— 存档就靠这一条性质。
 *
 * 时间只有**一个**真相源：`s.i`（全程第几根小时 K 线）。
 * 日期、行情、解锁币种全部由它派生（`format.fmtDate` / `market`），谁都不许另存一份时间。
 */

import { GAME } from './config.js';

export const STATE_VERSION = 4;

export function createState() {
  return {
    v: STATE_VERSION,

    /** 当前处在全程第几根小时 K 线（0 = 2013-01-01 00:00 UTC） */
    i: 0,

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

    /** 当前正在看的币种 */
    sym: 'BTC',

    /** 玩家选择的杠杆（会在档位表里夹取，见 `config.leverageOptionsAt`） */
    lev: 1,

    /** 下单金额占「可用保证金」的比例，1 = 全部 */
    sizeFrac: 1,

    /** 速度倍率：1 / 2 / 5 / 10 / 20 */
    speed: 1,

    /** 暂停 */
    paused: false,

    /** 已实现盈亏累计（含手续费），用于战后复盘 */
    realized: 0,

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

/** 是否持有任何仓位 */
export const anyHeld = s => heldSyms(s).length > 0;

/** 日志上限：只留最近这些条，免得存档无限膨胀 */
export const LOG_MAX = 60;

/** 追加一条日志（新的在前） */
export function pushLog(s, text, kind = 'info') {
  s.log.unshift({ at: s.i, text, kind });
  if (s.log.length > LOG_MAX) s.log.length = LOG_MAX;
}
