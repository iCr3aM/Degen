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
const failed = new Map();      // sym -> Error

let liqBuf = null;             // Float32Array，长度 = days × 币数（日流动性，P2-A）
let liqInflight = null;

/** 一天 = 24 根 K 线（GDD §11：1 根 K 线 = 1 游戏小时） */
export const HOURS_PER_DAY = 24;

export const getManifest = () => manifest;
export const isLoaded = sym => series.has(sym);
export const isLiqLoaded = () => !!liqBuf;

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
    throw new Error(`行情清单读取失败（HTTP ${res.status}）—— 先跑一次 npm run data 生成数据包`);
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
  if (failed.has(sym)) return Promise.reject(failed.get(sym));
  if (inflight.has(sym)) return inflight.get(sym);

  const p = (async () => {
    const mf = await loadManifest();
    const meta = mf.coins[sym];
    if (!meta) throw new Error(`清单里没有 ${sym}`);
    const raw = await gunzip(await fetchBuffer(`${BASE}${DATA_DIR}/${meta.file}`));
    const want = meta.count * 17;              // 4 列 Int32（16B）＋ 1 字节成交量份额
    if (raw.byteLength !== want) {
      throw new Error(`${sym} 数据长度不符：期望 ${want} 字节，实得 ${raw.byteLength} —— 先重新跑 npm run data`);
    }
    const rec = {
      ints: new Int32Array(raw, 0, meta.count * 4),
      vol: new Uint8Array(raw, meta.count * 16, meta.count),
    };
    series.set(sym, rec);
    return rec;
  })();

  inflight.set(sym, p);
  p.catch(err => failed.set(sym, err));
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

/**
 * 取第 i 根 K 线。未加载 / 越界时返回 null —— **调用方必须能接受 null**，
 * 因为币种在解锁之前本来就没有行情。
 * @returns {{o:number,h:number,l:number,c:number}|null}
 */
export function candleAt(sym, i) {
  const rec = series.get(sym);
  const r = rangeOf(sym);
  if (!rec || !r) return null;
  if (i < r[0] || i >= r[1]) return null;
  const meta = manifest.coins[sym];
  const ints = rec.ints;
  const k = (i - r[0]) * 4;
  const s = meta.scale;
  const o = ints[k] / s;
  return { o, h: o + ints[k + 1] / s, l: o + ints[k + 2] / s, c: o + ints[k + 3] / s };
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

/** 只取收盘价 —— 标记价用这个 */
export function closeAt(sym, i) {
  const c = candleAt(sym, i);
  return c ? c.c : null;
}

/* ═════════════════ 日流动性（liq.bin，P2-A 拥堵脉冲 / P2-B 滑点共用） ═════════════════
 * 与 K 线包不同的三点，都是刻意的：
 *   ① **整包一次加载** —— 只有 86 KB（gzip 63 KB），且拥堵计算随时要用（连 BTC 都要），
 *      按币懒加载省不了多少，反而让「算一次拥堵」变成异步。
 *   ② **Float32，不是 Int32** —— 它是美元/天的绝对量（$1e3 ~ $3e10），不需要 K 线那套相对编码。
 *   ③ **时间轴是「天」，不是「小时」** —— 索引 = 自 2013-01-01 起的天序号 = `floor(i / 24)`。
 * 口径（两端锚定 ＋ 真实年内形状）见 `tools/fetch-data.mjs` 的日流动性一节。
 */

/** 加载日流动性包。只需一次；与 `loadCoin` 一样做并发去重与失败缓存。 */
export function loadLiq() {
  if (liqBuf) return Promise.resolve(liqBuf);
  if (liqInflight) return liqInflight;

  liqInflight = (async () => {
    const mf = await loadManifest();
    const meta = mf.liq;
    if (!meta) throw new Error('清单里没有 liq 段 —— 先重新跑一次 npm run data');
    const raw = await gunzip(await fetchBuffer(`${BASE}${DATA_DIR}/${meta.file}`));
    const f = new Float32Array(raw);
    const want = meta.days * meta.order.length;
    if (f.length !== want) throw new Error(`liq 数据长度不符：期望 ${want} 个浮点，实得 ${f.length}`);
    liqBuf = f;
    return f;
  })();

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
  if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= days) return null;
  const n = manifest.liq.order.indexOf(sym);
  if (n < 0) return null;
  const v = liqBuf[n * days + dayIndex];
  return v > 0 ? v : null;      // 0 = 该币当天还没有行情（数据管线里未上线日写 0）
}
