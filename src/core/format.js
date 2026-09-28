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
 *   108143.1 / 1234.56 / 3.1416 / 0.52341 / 0.00012345
 */
export function fmtPrice(p) {
  if (!Number.isFinite(p)) return '--';
  const a = Math.abs(p);
  let d;
  if (a >= 1000) d = 2;
  else if (a >= 100) d = 3;
  else if (a >= 1) d = 4;
  else if (a >= 0.01) d = 5;
  else if (a >= 0.0001) d = 6;
  else d = 8;

  const neg = p < 0;
  const s = Math.abs(p).toFixed(d);
  const [ip, fp] = s.split('.');
  return (neg ? '-' : '') + group(ip) + (fp ? '.' + fp : '');
}

/**
 * 金额（USDT）：**固定 $ + 千分位 + 一位小数**，永不换单位。
 * 权益从 $3,000.0 长到 $12,345,678.9 时，只有位数在变，格式一个字符都不变。
 *
 * ⚠️ 两位 → **一位**（Batch 2 · B7，2026-09-29）：手机上每个数字都要挤在 91–179px 的格子里，
 *    第二位小数（1 分）在这个游戏里没有任何决策价值 —— 权益 $3,000.0 与 $3,000.00 一样够用。
 */
export function fmtMoney(n, { sign = false } = {}) {
  if (!Number.isFinite(n)) return '--';
  const neg = n < 0;
  const a = Math.abs(n);
  const s = a.toFixed(1);
  const [ip, fp] = s.split('.');
  const body = '$' + group(ip) + '.' + fp;
  if (neg) return '-' + body;
  return (sign ? '+' : '') + body;
}

/**
 * 百分比：涨跌幅 / 保证金率。`+1.2%` / `-4.6%`
 *
 * ⚠️ 默认两位 → **一位**（Batch 2 · B7）。要更高精度就显式传 `digits`（资金费率传 4）。
 */
export function fmtPct(x, digits = 1) {
  if (!Number.isFinite(x)) return '--';
  const v = x * 100;
  return (v >= 0 ? '+' : '') + v.toFixed(digits) + '%';
}

/**
 * 不带符号的百分比（保证金率这类恒正的值）。默认**一位**小数（Batch 2 · B7）。
 *
 * ⚠️ **费率必须显式传 2**：四家所是 0.20% / 0.10% / 0.05% / 0.04%，压到一位后
 *    BitMEX 与 Binance 会双双变成「0.0%」—— 那不是省地方，是把信息抹掉了。
 */
export function fmtRate(x, digits = 1) {
  if (!Number.isFinite(x)) return '--';
  return (x * 100).toFixed(digits) + '%';
}

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

/** 游戏内日期：`2013-01-01 00:00`（UTC，与数据源同一时区） */
export function fmtDate(ts, withHour = true) {
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
  const d = new Date(ts);
  return String(d.getUTCHours()).padStart(2, '0') + ':00';
}
