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
 * 金额（USDT）：**固定 $ + 千分位 + 两位小数**，永不换单位。
 * 权益从 $3,000.00 长到 $12,345,678.90 时，只有位数在变，格式一个字符都不变。
 */
export function fmtMoney(n, { sign = false } = {}) {
  if (!Number.isFinite(n)) return '--';
  const neg = n < 0;
  const a = Math.abs(n);
  const s = a.toFixed(2);
  const [ip, fp] = s.split('.');
  const body = '$' + group(ip) + '.' + fp;
  if (neg) return '-' + body;
  return (sign ? '+' : '') + body;
}

/** 百分比：涨跌幅 / 保证金率。`+1.23%` / `-4.56%` */
export function fmtPct(x, digits = 2) {
  if (!Number.isFinite(x)) return '--';
  const v = x * 100;
  return (v >= 0 ? '+' : '') + v.toFixed(digits) + '%';
}

/** 不带符号的百分比（保证金率这类恒正的值） */
export function fmtRate(x, digits = 2) {
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
