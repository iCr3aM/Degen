/**
 * 行情读取层 —— 读预置数据包（GDD §19.1：运行时只用本地数据，不依赖在线 API）
 * ===============================================================
 * 数据包长什么样、怎么压的，见 `tools/fetch-data.mjs` 的文件头。这里只做三件事：
 *   ① 读清单 `data/index.json`
 *   ② 按需解压单个币（**懒加载**：没看过的币不下载，首屏因此很轻）
 *   ③ 把「第 i 根」翻译成 OHLC
 *
 * ⚠️ 时间戳不在文件里 —— 它是 `start + 序号 × 3600s` 推出来的。这是体积换来的，
 *    也是「s.i 是唯一时间真相源」这条设计的直接结果。
 */

import { HOUR_MS, DATA_DIR } from './config.js';

const BASE = (import.meta.env && import.meta.env.BASE_URL) || './';

let manifest = null;
const series = new Map();      // sym -> { ints: Int32Array, vol: Uint8Array }（vol = 成交量份额，Batch 3）
const inflight = new Map();    // sym -> Promise（防并发重复下载）

let liqBuf = null;             // Float32Array，长度 = days × 币数（日流动性，P2-A）
let liqInflight = null;

/**
 * 价格位移源（上帝模式 ＋ 订单冲击）—— 由 `main.js`（唯一的接线层）注入 `(sym, j) => 系数`。
 *
 * ⚠️ **注入式**，不直接 import 状态：market.js 是最底层的数据读取者，不该知道 `s` 长什么样。
 * ⚠️ 未注入（或返回 1）时 `candleAt` 走原路径，与数据包**逐位相同** —— 离线断言靠这一条。
 */
let factorSource = null;

/** 注入价格位移源；不传 = 解除（回到原始数据） */
export function bindFactorSource(fn) { factorSource = fn || null; }

/** 一天 = 24 根 K 线（GDD §11：1 根 K 线 = 1 游戏小时） */
export const HOURS_PER_DAY = 24;

export const isLoaded = sym => series.has(sym);

/** 极简 gzip 解压：解压流已进入所有现代移动浏览器（2023 起全覆盖） */
async function gunzip(buf) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前浏览器不支持 DecompressionStream，无法解压行情数据');
  }
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** 读清单。只需一次。 */
export async function loadManifest() {
  if (manifest) return manifest;
  const res = await fetch(`${BASE}${DATA_DIR}/index.json`);
  if (!res.ok) {
    throw new Error(`行情清单读取失败（HTTP ${res.status}）`);
  }
  manifest = await res.json();
  return manifest;
}

/**
 * 加载（并缓存）某个币的整条序列。
 * 文件 = gzip(`count × 16` 字节的 OHLC ＋ `count` 字节的成交量份额)，切成两个视图共享同一块内存。
 * @returns {Promise<{ints:Int32Array, vol:Uint8Array}>} ints 长度 = count × 4，依次是 [o, h-o, l-o, c-o]
 */
export function loadCoin(sym) {
  if (series.has(sym)) return Promise.resolve(series.get(sym));
  if (inflight.has(sym)) return inflight.get(sym);

  const p = (async () => {
    const mf = await loadManifest();
    const meta = mf.coins[sym];
    if (!meta) throw new Error(`清单里没有 ${sym}`);
    const raw = await gunzip(await fetchBuffer(`${BASE}${DATA_DIR}/${meta.file}`));
    const want = meta.count * 17;              // 4 列 Int32（16B）＋ 1 字节成交量份额
    if (raw.byteLength !== want) {
      throw new Error(`${sym} 数据长度不符：期望 ${want} 字节，实得 ${raw.byteLength}`);
    }
    const rec = {
      ints: new Int32Array(raw, 0, meta.count * 4),
      vol: new Uint8Array(raw, meta.count * 16, meta.count),
    };
    series.set(sym, rec);
    return rec;
  })();

  inflight.set(sym, p);
  /* ⚠️ 失败**不缓存**（正式版）：弱网抖一下就让某个币在本会话里永远加载不出来，代价太大。
     并发去重仍由 `inflight` 保证（同一次请求只发一份）；失败后清掉键，下次调用可重试。 */
  p.catch(() => inflight.delete(sym));
  return p;
}

/** 该币数据包覆盖的 K 线序号区间 [起, 止) */
export function rangeOf(sym) {
  const meta = manifest && manifest.coins[sym];
  if (!meta) return null;
  const a = Math.round((meta.start - manifest.start) / HOUR_MS);
  return [a, a + meta.count];
}

/** 第 i 根是否落在该币的数据区间内 */
export function hasCandle(sym, i) {
  const r = rangeOf(sym);
  return !!r && i >= r[0] && i < r[1];
}

/** 从数据包解码第 i 根（**不含价格位移**）—— `candleAt` / `rawCloseAt` 共用的底座 */
function decodeAt(sym, i) {
  const rec = series.get(sym);
  const r = rangeOf(sym);
  if (!rec || !r) return null;
  if (i < r[0] || i >= r[1]) return null;
  const meta = manifest.coins[sym];
  const ints = rec.ints;
  const k = (i - r[0]) * 4;
  const scale = meta.scale;
  const o = ints[k] / scale;
  return {
    o,
    h: o + ints[k + 1] / scale,
    l: o + ints[k + 2] / scale,
    c: o + ints[k + 3] / scale,
  };
}

/**
 * 取第 i 根 K 线。未加载 / 越界时返回 null —— **调用方必须能接受 null**，
 * 因为币种在解锁之前本来就没有行情。
 * @returns {{o:number,h:number,l:number,c:number}|null}
 */
export function candleAt(sym, i) {
  const c = decodeAt(sym, i);
  if (!c) return null;

  /* 价格位移：系数按**根**取（一笔单只影响它之后的行情），不是全局常数 —— 见 god.js 的文件头 */
  const f = factorSource ? factorSource(sym, i) : 1;
  if (f === 1) return c;
  return { o: c.o * f, h: c.h * f, l: c.l * f, c: c.c * f };
}

/**
 * 第 i 根的收盘价，**不含任何价格位移** —— 就是数据包里的原值。
 *
 * ⚠️ 新闻条的涨跌幅走这条（P2-C ①·补）：那个数要的是**真实行情**，
 *    不能把玩家自己砸出来的位移算进去 —— 否则新闻条会显示一条「历史上根本没发生过」的涨跌幅。
 */
export function rawCloseAt(sym, i) {
  const c = decodeAt(sym, i);
  return c ? c.c : null;
}

/**
 * 第 i 根的**成交量份额**（0~1 ＝ 该小时占当日成交额的比重，Batch 3 · B11 拍板「方案 B」）。
 * 绝对美元量 = 本值 × `liqOf(sym, dayIndexOf(i))`（P2-B 滑点用的就是那一份日流动性）。
 * 未加载 / 越界 ⇒ 0；调用方一律按「无成交」处理（不参与任何玩法逻辑，只影响量柱高度）。
 */
export function volumeAt(sym, i) {
  const rec = series.get(sym);
  const r = rangeOf(sym);
  if (!rec || !r || i < r[0] || i >= r[1]) return 0;
  return rec.vol[i - r[0]] / 255;
}

/**
 * 玩家自己的成交额源 —— 由 `main.js`（唯一的接线层）注入 `i => 美元名义额`。
 *
 * ⚠️ 与 `factorSource` 同一范式：market.js 是最底层的数据读取者，**不该知道 `s` 长什么样**，
 *    所以这里只留一个注入点，由接线层把 `s.pvol` 递进来。未注入时恒返回 0 ⇒ 量柱与
 *    「数据包逐位相同」—— 离线断言靠这一条。
 */
let playerVolSource = null;

/** 注入玩家成交量源；不传 = 解除（回到只有数据包份额的量柱） */
export function bindPlayerVolSource(fn) { playerVolSource = fn || null; }

/**
 * 第 i 根 K 线上**玩家自己**贡献的成交额（美元）—— 加在包内份额折算出的市场成交额之上。
 * 未注入 / 该小时没成交 ⇒ 0。调用方一律按「只有市场那一份」处理。
 */
export function playerVolAt(i) {
  return playerVolSource ? (playerVolSource(i) || 0) : 0;
}

/** 只取收盘价 —— 标记价用这个 */
export function closeAt(sym, i) {
  const c = candleAt(sym, i);
  return c ? c.c : null;
}

/* ═════════════════ 流通量（manifest.circulating，本轮 ⑤） ═════════════════
 * 数据长什么样：`{ [sym]: { unit, points: { 'YYYY-MM-DD': 数量 } } }`（`tools/fetch-data.mjs` 落盘）。
 * 它是**逐年几个锚点**、不是逐日序列 —— 所以这里按**小时序号线性插值**，
 * 两点之间是直线。市值 = 本值 × 标记价，只用来在 K 线头部报一个量级，不参与任何玩法判定。
 *
 * ⚠️ 只读 `manifest`（已在内存里，**不额外下载任何文件**）。
 * ⚠️ 单位是「该币自己的币数」—— 头部要的就是这个，不做任何美元换算。
 */
let supplyPts = null;          // sym -> [{ h, n }]（h = 自 manifest.start 起的小时序号，升序）

function supplyPoints(sym) {
  if (!manifest || !manifest.circulating) return null;
  const c = manifest.circulating[sym];
  if (!c || !c.points) return null;
  if (!supplyPts) supplyPts = new Map();
  let arr = supplyPts.get(sym);
  if (arr) return arr;
  arr = Object.keys(c.points)
    .map(d => ({ h: Math.round((Date.parse(`${d}T00:00:00Z`) - manifest.start) / HOUR_MS), n: c.points[d] }))
    .sort((a, b) => a.h - b.h);
  supplyPts.set(sym, arr);
  return arr;
}

/**
 * 第 i 根的**流通量**（该币自己的币数）；区间外**取端点值**（不外推）。
 * @returns {number|null} 清单里没有这个币 ⇒ null（调用方一律省略这一格）
 */
export function supplyAt(sym, i) {
  const arr = supplyPoints(sym);
  if (!arr || !arr.length) return null;
  if (i <= arr[0].h) return arr[0].n;
  const last = arr[arr.length - 1];
  if (i >= last.h) return last.n;
  for (let k = 1; k < arr.length; k++) {
    if (i <= arr[k].h) {
      const a = arr[k - 1];
      const b = arr[k];
      const span = b.h - a.h;
      return span > 0 ? a.n + (b.n - a.n) * ((i - a.h) / span) : b.n;
    }
  }
  return last.n;
}

/* ═════════════════ 日流动性（liq.bin，P2-A 拥堵脉冲 / P2-B 滑点共用） ═════════════════
 * 与 K 线包不同的三点，都是刻意的：
 *   ① **整包一次加载** —— 只有 86 KB（gzip 63 KB），且拥堵计算随时要用（连 BTC 都要），
 *      按币懒加载省不了多少，反而让「算一次拥堵」变成异步。
 *   ② **Float32，不是 Int32** —— 它是美元/天的绝对量（$1e3 ~ $3e10），不需要 K 线那套相对编码。
 *   ③ **时间轴是「天」，不是「小时」** —— 索引 = 自 2013-01-01 起的天序号 = `floor(i / 24)`。
 *      ⚠️ 但 `liq.bin` 的「天 0」比游戏开局早 `manifest.liq.preDays` 天（BTC 的 2012 回溯段，
 *         2026-09-30）：那条轴是**数据窗口**（最早的 `unlock`），而运行时的 `dayIndexOf(s.i)`
 *         是**游戏窗口**。平移只发生在 `liqOf` 里一处，别在调用方各自加减。
 * 口径（两端锚定 ＋ 真实年内形状）见 `tools/fetch-data.mjs` 的日流动性一节。
 */

/** 加载日流动性包。只需一次；与 `loadCoin` 一样做并发去重（失败**不缓存**，可重试）。 */
export function loadLiq() {
  if (liqBuf) return Promise.resolve(liqBuf);
  if (liqInflight) return liqInflight;

  liqInflight = (async () => {
    const mf = await loadManifest();
    const meta = mf.liq;
    if (!meta) throw new Error('行情清单缺少日流动性数据');
    const raw = await gunzip(await fetchBuffer(`${BASE}${DATA_DIR}/${meta.file}`));
    const f = new Float32Array(raw);
    const want = meta.days * meta.order.length;
    if (f.length !== want) throw new Error(`liq 数据长度不符：期望 ${want} 个浮点，实得 ${f.length}`);
    liqBuf = f;
    return f;
  })();

  liqInflight.catch(() => { liqInflight = null; });   // 同上：失败不缓存，下次可重试
  return liqInflight;
}

/** K 线序号 → 天序号 */
export const dayIndexOf = i => Math.floor(i / HOURS_PER_DAY);

/**
 * 某币某天的日流动性（美元/天，GDD §15.2）。
 * @param {string} sym
 * @param {number} dayIndex  自 2013-01-01 起的天序号（用 `dayIndexOf(s.i)` 换算）
 * @returns {number|null} 未加载 / 越界 / 该币当天还没上线 ⇒ null（调用方一律当作「无流动性」）
 */
export function liqOf(sym, dayIndex) {
  if (!liqBuf || !manifest || !manifest.liq) return null;
  const days = manifest.liq.days;
  /* 游戏窗口的天序号 → 数据窗口的天序号（BTC 回溯段 96 天，其余币 `preDays` 同样是 96
     但它们的行情本来就在 2013 之后 ⇒ 平移后落在前半段的 0 值区，语义仍是「没上线」）。 */
  const d = dayIndex + (manifest.liq.preDays || 0);
  if (!Number.isInteger(dayIndex) || d < 0 || d >= days) return null;
  const n = manifest.liq.order.indexOf(sym);
  if (n < 0) return null;
  const v = liqBuf[n * days + d];
  return v > 0 ? v : null;      // 0 = 该币当天还没有行情（数据管线里未上线日写 0）
}
