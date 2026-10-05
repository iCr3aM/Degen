/**
 * 数值与时间格式化
 * ===============================================================
 * 一条硬规矩（用户 2026-09-28）：「UI 列宽固定，不许跳动」。
 * 所以这里的每个函数都只**按量级切换小数位**，不做「有时带单位、有时不带」这种事 ——
 * 同一个位置上的字符串长度只随数字位数变化，不会因为格式换了而突然变胖或变瘦。
 */

/** 千分位（只处理整数部分） */
function group(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 价格：按量级选小数位，保证任何价位的币都读得出有效数字。
 *   108143.1 / 1234.56 / 3.1416 / 0.52341 / 0.000123
 * ⚠️ 不导出（2026-10-02 审计）：它只服务本文件（`fmtMoneyShort` / `fmtQty`），
 *    外部读者一律走那两个 —— 放出去只会多一套「价格怎么显示」的口径。
 *
 * ⚠️ 最末档 `d = 8 → 6`（2026-10-05）：DOGE 早期 `$0.000089` 这类价，8 位小数会印成
 *    `0.00008900`（10 字符）—— 持仓行 / 日志里刚好多出一截、被 `text-overflow` 啃掉价格尾部。
 *    收成 6 位后任何 `< 0.01` 的价恒定 8 字符（`0.000089`），量级信息不丢（第 6 位仍有值），
 *    与上面 `[0.0001, 0.01)` 那一档的 `d = 6` 也并成同一口径。
 */
function fmtPrice(p) {
  if (!Number.isFinite(p)) return '--';
  const a = Math.abs(p);
  let d;
  if (a >= 1000) d = 2;
  else if (a >= 100) d = 3;
  else if (a >= 1) d = 4;
  else if (a >= 0.01) d = 5;
  else d = 6;

  const neg = p < 0;
  const s = Math.abs(p).toFixed(d);
  const [ip, fp] = s.split('.');
  return (neg ? '-' : '') + group(ip) + (fp ? '.' + fp : '');
}

/**
 * 日志串里的**成交价**（本轮 ② · 用户 2026-09-29 拍板）：
 *   - **≥ $1 ⇒ 固定 1 位小数**（`13.1` / `1,234.5`）—— 日志里的第二位小数（甚至第三四位）
 *     对玩家毫无决策价值，只会把 nowrap 的日志条撑长；
 *   - **< $1 ⇒ 交给 `fmtPrice`**（`0.5234` / `0.00012345`）—— 这类币压低到 1 位会变成 `0.5`
 *     甚至 `0.0`，那是把信息抹掉而不是省地方（与 `fmtRate` 必须显式传 2 位同一个道理）。
 *
 * ⚠️ 只给**日志**用。K 线轴 / 强平价标签 / 持仓条那些位置要的是精确读数，仍走 `fmtPrice`。
 * ⚠️ 它顺带干掉了 `engine.js` 原来那个 `showPrice`（8 位有效数字去浮点尾噪）：
 *    `toFixed` 本来就不带尾噪，`< $1` 那支又走 `fmtPrice`（内部也是 `toFixed`）。
 */
export function fmtLogPrice(p) {
  if (!Number.isFinite(p)) return '--';
  const a = Math.abs(p);
  if (a < 1) return fmtPrice(p);
  const [ip, fp] = a.toFixed(1).split('.');
  return (p < 0 ? '-' : '') + group(ip) + '.' + fp;
}

/**
 * 金额（USDT）：**固定 $ + 千分位 + 一位小数**，永不换单位。
 * 权益从 $1,000.0 长到 $12,345,678.9 时，只有位数在变，格式一个字符都不变。
 *
 * ⚠️ 两位 → **一位**（Batch 2 · B7，2026-09-29）：手机上每个数字都要挤在 91–179px 的格子里，
 *    第二位小数（1 分）在这个游戏里没有任何决策价值 —— 权益 $1,000.0 与 $1,000.00 一样够用。
 */
export function fmtMoney(n, { sign = false } = {}) {
  if (!Number.isFinite(n)) return '--';
  const s = Math.abs(n).toFixed(1);
  /* ⚠️ P1-15（2026-10-04 审计）：舍入到 0 的极小小负值（如借贷利息 −$0.0001）不许带负号 ——
     否则输出 `-$0.0`，一个「负的零」既刺眼又让玩家以为账没结清。`+s === 0` 即「已舍成零」。 */
  const neg = n < 0 && Number(s) !== 0;
  const [ip, fp] = s.split('.');
  const body = '$' + group(ip) + '.' + fp;
  if (neg) return '-' + body;
  return (sign ? '+' : '') + body;
}

/**
 * 金额的**后缀档**（⑤⑥ 批 · 方案 §20.3.3，2026-09-29）：`k / M / B` 三档，**纯函数**。
 * 档位 `0` = 无后缀、`1` = k、`2` = M、`3` = B；上沿是 `1e5 / 1e6 / 1e9`。
 *
 * 为什么单开一档、而不是往 `fmtMoney` 里加分支：
 *   ① `fmtMoney` 上面那段注释是**承诺**（「永不换单位」）—— 它有固定列宽的职责，不掺这个；
 *   ② 后缀是**显示取舍**，什么时候用由**调用方**决定：
 *        · 日志串（`engine.js`）—— 文本一旦 `pushLog` 就冻结，直接按门槛用；
 *        · 活值（`render.js`）—— 每帧重算，必须走**迟滞**，不能在这里判断。
 *
 * ⚠️ `|n| < 1e5` 时**逐位走 `fmtMoney`**（`$1,000.0` 原样）—— 早期玩家在万级，`k` 反而陌生。
 * ⚠️ 迟滞版 `moneyTierHeld`（导出）与这里**共用同一组下沿**（升档立刻、降档滞后 10%）—— 不许各写一份。
 */
// ⚠️ 不导出（2026-10-04 审计 R23）：迟滞版 `moneyTierHeld` 才是外部入口，纯门槛只在本文件内用。
function moneyTier(a) {
  return a < 1e5 ? 0 : a < 1e6 ? 1 : a < 1e9 ? 2 : 3;
}

/** 各档下沿 —— 迟滞与 `moneyTier` 共用同一组数，不许各写一份 */
const TIER_LOW = [1e5, 1e6, 1e9];
/** 降档迟滞比例：跌破上一档下沿的 90% 才回落（升档不设死区 —— 显示不下的那一刻就该换） */
const TIER_HOLD = 0.9;

/**
 * **带迟滞的**档位选择（⑥ · 方案 §20.3.3）：活值每帧重算，纯门槛会在 `1e5 / 1e6 / 1e9`
 * 边界上逐帧闪（`$999,999.9` ↔ `$1.0M`）。所以这里要上一个「上一帧是哪一档」：
 *   - **升档立刻**（`nat >= prev`）；
 *   - **降档要跌破上一档下沿的 90%** 才回落，否则保持原档。
 *
 * ⚠️ 死区内的固有代价：同一个数两种显示取决于「之前到过哪」—— 这是消抖的必付成本。
 * ⚠️ **纯函数**，记忆由调用方持有（`render.js` 的模块级 `Map`）—— 这里不许存状态。
 * @param {number|null|undefined} prev 上一帧的档位（无记忆时传 `null`）
 * @param {number} a 金额的绝对值
 */
export function moneyTierHeld(prev, a) {
  const nat = moneyTier(a);
  if (prev == null || nat >= prev) return nat;
  return a >= TIER_LOW[prev - 1] * TIER_HOLD ? prev : nat;
}

/** 档位 → `[基数, 后缀, 小数位]`（第 0 档为空，表示「交给 fmtMoney」）
 *  ⚠️ 三档小数位**一律 1 位**（2026-10-03 用户拍板）：`B` 原来是 2 位（`$12.34B`）——
 *     量级越大位数越多，正好在最窄的格子里最长。收成 1 位后 `$12.3B`，与 `K` / `M` 同档。
 *     ⚠️ `T`（只在市值 ≥ $1e12 出现，见 `fmtCap`）**刻意留 2 位**：BTC 顶点的 $1.98T
 *        收成 $2.0T 是把真信息抹掉，而 `$1.98T` 只有 6 字符、任何格子都放得下。
 *  ⚠️ 改这里会同时改到 `fmtQty`（流通量）：它共用这张表。 */
const TIER_UNIT = [[], [1e3, 'K', 1], [1e6, 'M', 1], [1e9, 'B', 1]];

function shortBody(a, tier) {
  if (tier === 0) return null;                    // 交给 fmtMoney
  const [base, suf, d] = TIER_UNIT[tier];
  const s = (a / base).toFixed(d);
  if (Number(s) >= 1000) {                        // 进位兜底：`999,999` → `1000.0K` ⇒ 抬到 `$1.0M`
    /* ⚠️ 兜底那几行的小数位必须与**目标档**的 `TIER_UNIT` 逐位相同，否则同一个数在门槛
       两侧换了写法（`$999.9B` ↔ `$1000.0B`）。B 收成 1 位后这里也跟着收（2026-10-03）。 */
    if (tier === 1) return '$' + (a / 1e6).toFixed(1) + 'M';
    if (tier === 2) return '$' + (a / 1e9).toFixed(1) + 'B';
    /* ⚠️ `tier === 3` 的兜底（2026-10-02 审计补）：`B` 是最后一档，原来没有这一行，
       `9.99995e11 ~ 1e12` 这一段会印成 `$1000.00B`（而 `fmtCap` 在 `≥ 1e12` 时印 `$1.00T`）
       —— 同一串数字在门槛两侧换了个写法。补上 T 之后 `fmtMoneyShort` / `fmtCap` 一致。 */
    if (tier === 3) return '$' + (a / 1e12).toFixed(2) + 'T';
  }
  return '$' + s + suf;
}

/**
 * 带 `k / M / B` 后缀的金额。**纯门槛**（1e5 / 1e6 / 1e9），无任何记忆。
 *
 * ⚠️ 与已删除的 `fmtMoneyCompact` 无关：那个是 `1e15~1e21` 的**科学计数法**（上帝模式的溢出保护，
 *    已随 v33 整块删除）；这个是**商业后缀**，服务列宽与日志串长（方案 §20.3.3）。
 *
 * `minTier` 是给 `render.js` 的**迟滞**用的：降档时把上一档钉住，直到跌破下沿的 90%。
 */
export function fmtMoneyShort(n, { sign = false, minTier = 0 } = {}) {
  if (!Number.isFinite(n)) return '--';
  const a = Math.abs(n);
  const body = shortBody(a, Math.max(minTier, moneyTier(a)));
  if (body == null) return fmtMoney(n, { sign });    // < 1e5：与 fmtMoney 逐位相同
  return (n < 0 ? '-' : sign ? '+' : '') + body;
}

/**
 * **币的数量**（流通量这类）：`10.6M` / `483.0M` / `147.44B`，**不带 `$`**。
 *
 * 与 `fmtMoneyShort` 共用同一套后缀表（`TIER_UNIT`），只有两处不同：
 *   - 没有货币符号；
 *   - `< 1e4` 走**千分位整数**（`8,200`）—— 数量到这个量级不需要小数；
 *     但 **`< 1` 保留小数**（`0.0167`）：小额币量取整会印成「0」。
 * ⚠️ 单独一个函数而不是给 `fmtMoneyShort` 加个开关：那个的职责是**金额**，
 *    `$` 与 `sign` 都是它的语义；混进来会逼着每个调用点都多想一层。
 * ⚠️ 另一个用途（2026-10-03）：K 线左下角那行三格里的 **OI** 也走这里 ——
 *    不是「币量」，纯粹是那一行塞不下 `$`（见 `render.js` 的 `.chart-heat`）。
 */
export function fmtQty(n) {
  if (!Number.isFinite(n)) return '--';
  const a = Math.abs(n);
  /* ⚠️ `< 1` 必须留小数（2026-10-02 审计修）：$1,000 买 BTC 只买到 0.0167 枚，
     取整会印成「0 枚」—— 那是把信息抹掉，不是省地方。这里直接借 `fmtPrice` 的量级小数位。 */
  if (a < 1e4) return a >= 1 ? group(String(Math.round(a))) : fmtPrice(n);
  const tier = a < 1e6 ? 1 : a < 1e9 ? 2 : 3;
  const [base, suf, d] = TIER_UNIT[tier];
  const s = (a / base).toFixed(d);
  if (Number(s) >= 1000) {                        // 进位兜底：`999,999` → `1000.0K` ⇒ 抬一档
    /* ⚠️ R21（2026-10-04 审计）：兜底位的小数位必须与**目标档**的 `TIER_UNIT` 逐位相同，
       否则同一个数在门槛两侧换写法。原 tier2 用 2 位（印 `1.00B`，而 `TIER_UNIT` 的 B 是 1 位），
       且缺 tier3 兜底 ⇒ `≥ 1e12` 会印成 `1000.0B`（而 `fmtCap` 在 `≥ 1e12` 印 `$1.00T`）。 */
    if (tier === 1) return (a / 1e6).toFixed(1) + 'M';
    if (tier === 2) return (a / 1e9).toFixed(1) + 'B';
    if (tier === 3) return (a / 1e12).toFixed(2) + 'T';
  }
  return s + suf;
}

/**
 * **市值**（流通量 × 价格）：`$1.98T` / `$376.4B` / `$12.3M`。
 *
 * 比 `fmtMoneyShort` 多一档 `T`：BTC 在 2021 / 2024 的市值是 `$1.3e12` / `$1.98e12`，
 * 只按 `B` 印会变成 `$1300.00B`（四个数字位，撑爆 K 线头部那一行）。
 * ⚠️ **不动 `fmtMoneyShort` 的档位门槛**（`1e5 / 1e6 / 1e9`）：那是权益 / 盈亏用的金额格式，
 *    改它等于改存档外的既有读数；市值只有这一处消费，各给各的档，互不影响。
 */
export function fmtCap(n) {
  if (!Number.isFinite(n)) return '--';
  const a = Math.abs(n);
  if (a >= 1e12) return (n < 0 ? '-' : '') + '$' + (a / 1e12).toFixed(2) + 'T';
  return fmtMoneyShort(n);
}

/**
 * 百分比：涨跌幅 / 保证金率。`+1.2%` / `-4.6%`
 *
 * ⚠️ 默认两位 → **一位**（Batch 2 · B7）。要更高精度就显式传 `digits`（资金费率传 4）。
 */
export function fmtPct(x, digits = 1) {
  if (!Number.isFinite(x)) return '--';
  const v = x * 100;
  /* ⚠️ R20（2026-10-04 审计）：先舍零再判号 —— 极小小负值（如 `-0.0001`）原来印 `-0.0%`，
     与 `fmtMoney` 已修的负零同类。舍成零后按「零」显示（`+0.0%`，与真 0 一致），不带负号。 */
  const r = Number(v.toFixed(digits));
  return (r >= 0 ? '+' : '') + r.toFixed(digits) + '%';
}

/**
 * 不带符号的百分比（保证金率这类恒正的值）。默认**一位**小数（Batch 2 · B7）。
 *
 * ⚠️ **费率必须显式传 2**：三家所是 0.20% / 0.10% / 0.05% / 0.04%，压到一位后
 *    BitMEX 与 Binance 会双双变成「0.0%」—— 那不是省地方，是把信息抹掉了。
 */
export function fmtRate(x, digits = 1) {
  if (!Number.isFinite(x)) return '--';
  return (x * 100).toFixed(digits) + '%';
}

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

/** 游戏内日期：`2013-01-01 00:00`（UTC，与数据源同一时区） */
export function fmtDate(ts, withHour = true) {
  if (!Number.isFinite(ts)) return '--';      // R22：与其余 fmt* 同口径（否则印 `NaN-NaN-NaN`）
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = MONTHS[d.getUTCMonth()];
  const day = String(d.getUTCDate()).padStart(2, '0');
  if (!withHour) return `${y}-${m}-${day}`;
  return `${y}-${m}-${day} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
}

/**
 * 只到小时：`00:00`。
 * 专给**日志条前缀**用（2026-09-29）：完整日期已由顶栏承担，日志条再写一遍就是重复。
 * 保留小时是因为日志里可能有「几小时前」的事件（如资金费率每 8 游戏小时一次）。
 */
export function fmtHour(ts) {
  if (!Number.isFinite(ts)) return '--';      // R22：同 `fmtDate`
  const d = new Date(ts);
  return String(d.getUTCHours()).padStart(2, '0') + ':00';
}
