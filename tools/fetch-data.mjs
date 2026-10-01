/**
 * 行情数据管线 —— 抓真实历史小时线，打包成运行时直接读的离线数据包
 * ==========================================================================
 * 产出：
 *   public/data/index.json   清单（每个币的起点 / 根数 / 缩放 / 数据来源统计）
 *   public/data/{SYM}.bin    gzip 压缩的 Int32 负载，每根 K 线 4 个整数
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 数据来源与优先级（全部零成本、无需 API Key）
 * ─────────────────────────────────────────────────────────────────────────
 *   ① Bitstamp v2 OHLC     —— 小时线，USD 本位，BTC 全程 2013-01 起
 *   ② Bitfinex v2 candles  —— 小时线，USD 本位
 *   ③ Binance v3 klines    —— 小时线，从各币上币日起
 *   ④ Binance.US v3 klines —— 接口与 ③ 同形，但**是另一家交易所、另一本账**。
 *      存在的唯一理由：Binance 自家 K 线库里 SOLUSDT / SOLBTC / SOLBUSD 三对
 *      **同时**缺了同样的 20 个小时（官方月度归档也同缺），而 Binance.US 的
 *      SOLUSD 一根不少。只当补洞源，目前仅 SOL 用，排在 ③ 之后。
 *   ⑤ CryptoDataDownload 静态 CSV 归档 —— 补 ①–④ 都给不出的早期年份。
 *      Poloniex 的 `DOGE/BTC`、`XRP/BTC` 小时档能回到 2014；
 *      BTC 计价的那几档乘同一时刻的 BTC/USD 即换回美元。
 *   ⑥ Kraken 官方 OHLCVT 归档（本地 CSV，`Kraken_OHLCVT_Full_2026Q2/`）—— 小时线。
 *      它存在的**唯一**理由是多所聚合（见下面的「多所聚合」段）：同一小时要有**几家报价**
 *      才谈得上把单所的「针」投出去，而 Kraken 是免费可得里覆盖最全的第二票来源。
 *      ⚠️ Kraken 的配对名不是通用写法：BTC 是 `XBT`、**DOGE 是 `XDG`**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 多所聚合（2026-10-01，K 线全市场校准 K1）
 * ─────────────────────────────────────────────────────────────────────────
 * 在此之前，同一小时**只保留优先级最高的那一家**（后来的只补洞、绝不覆盖）。后果是：
 * 某一家某一小时的坏价（薄盘错价、satoshi 量化跳变）会**原样**进包，在图上就是一根针。
 *
 * 现在 `AGG_COINS` 里的币改成「每一家都覆盖整条窗口 → 逐小时逐字段投票」：
 *   - 取价：`medoid()`（到其余各值对数距离最小的那**一家**）。**不做加权、不做合成** ——
 *     每一根 K 线仍然是某家交易所真实报过的价，平均则会把坏源摊进价格里。
 *   - 兜底：不变量修正 `H ≥ max(O,C)`、`L ≤ min(O,C)`。
 *   - 成交量：**只认主源**（优先级最高的那家）。改成跨所求和会同时动 `liq.bin`、
 *     滑点分母与拥堵脉冲阈值 —— 本轮刻意不动，单开一批再议。
 * 未列入 `AGG_COINS` 的币走原路（按优先级补洞），输出**逐位不变** —— 分批推进的隔离保证。
 *
 * ⚠️ **本管线不造 K 线。** 「日线插值」与「平线补齐」已整块删除（含 FLAT_TAG）：
 *    - **开头的空档**（配置里 `unlock` 写早了）→ 直接**裁掉**，数据包的起点
 *      以实测的「第一根真 K 线」为准，并回写进 index.json；
 *    - **中间的空档**（所有源都缺某一小时）→ 逐段打进日志、写进 index.json
 *      的 `gapHours` / `gapRanges`，绝不静默。
 *    当前 5 个币的 `gapHours` 已全部为 0（SOL 那 20 根由 ④ 补掉了）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么是 gzip + 手写二进制，而不是 JSON
 * ─────────────────────────────────────────────────────────────────────────
 * 5 个币合计 ≈ 41.3 万根小时 K。写成 JSON 是几十 MB 级别，
 * 远超 GDD §19.2 给的「行情包 1–3MB」预算。所以：
 *   - 每根 K 线存 4 个 Int32：`[o, h-o, l-o, c-o]`（后三个是相对开盘的增量，
 *     同根 K 线内 h/l/c 与 o 的差通常很小 ⇒ 高位字节全是 0 或 0xFF ⇒ gzip 压得动）
 *   - 时间戳**完全不存**：数据是逐小时连续的，时刻由 `起点 + 序号 × 3600s` 推出
 *   - **成交量份额**（Batch 3 · B11，2026-09-29 拍板「方案 B」）：在同一个 `.bin` 的
 *     **尾部追加 `count` 个字节**（`round(该小时成交额 ÷ 当日成交额 × 255)`），
 *     只 +6.25% 体积就能画量柱；绝对量由 `liq.bin` 的日流动性给出（份额 × `liqOf`）。
 *     详见 `encodeCoin()`。日流动性本身仍**另出一个 `liq.bin`**：抓价时顺手捞到的真实成交额
 *     按日聚合成「日流动性」，供 P2-A 的拥堵脉冲阈值与 P2-B 的滑点分母使用。详见下文「日流动性」段。
 *   - 价格乘一个每币固定的 `scale`（10 的幂），把浮点压成整数
 * 最终体积见脚本结尾打印的实测值。
 *
 * ⚠️ 文件同时以**未压缩字节数**为准做完整性校验：运行时解压后必须恰好是 `count × 17` 字节
 *    （`count × 4` 个 Int32 ＋ `count` 个 Uint8）。
 *
 * 用法：
 *   node tools/fetch-data.mjs --probe            只探测各数据源的最早可用时刻，不下载
 *   node tools/fetch-data.mjs                    全量抓取并打包
 *   node tools/fetch-data.mjs --only=BTC,ETH     只抓指定币种
 *   node tools/fetch-data.mjs --from-cache       只用 .cache/ 里已有的分页结果，不发网络请求
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { GAME, COINS, HOUR_MS, DATA_DIR } from '../src/core/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', DATA_DIR);
const CACHE_DIR = join(ROOT, '.cache');
/** Kraken 官方 OHLCVT 归档（本地，不进 git）。见文件头数据源 ⑥ */
const KRAKEN_DIR = join(ROOT, 'Kraken_OHLCVT_Full_2026Q2');

/* ═══════════════════ 代理自举（Windows 上的第一道坎） ═══════════════════
 * Node 的 `fetch` **不看系统代理**。开发机若挂着 Clash / 加速器（Windows 的
 * Internet 设置里 `ProxyEnable=1, ProxyServer=127.0.0.1:7897`），`fetch` 会要直连
 * DNS 解析出来的假地址，然后一路 connect timeout —— 报错还是一句没头没脑的
 * 「fetch failed」，极难查。
 *
 * 解法：登录时先把系统代理读出来，再带 `--use-env-proxy` 把自己重启一次
 * （Node ≥ 24 才有这个开关）。已经带过就直接往下走，不会无限重启。
 * 想绕过代理（直连可用时）：设 `DEGEN_NO_PROXY=1`。
 */
function bootstrapProxy() {
  if (process.env.DEGEN_PROXY_READY) return;
  if (process.env.DEGEN_NO_PROXY) return;

  let server = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!server && process.platform === 'win32') {
    try {
      const out = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8' }).stdout || '';
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/.test(out);
      const m = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(out);
      if (enabled && m) server = m[1].includes('://') ? m[1] : `http://${m[1]}`;
    } catch { /* 读不到就按直连走 */ }
  }
  if (!server) return;

  const url = server.includes('://') ? server : `http://${server}`;
  console.log(`（经代理 ${url} 启动）\n`);
  const r = spawnSync(process.execPath,
    ['--use-env-proxy', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, HTTP_PROXY: url, HTTPS_PROXY: url, DEGEN_PROXY_READY: '1' } });
  process.exit(r.status ?? 1);
}
bootstrapProxy();

const args = new Set(process.argv.slice(2));
const PROBE = args.has('--probe');
const FROM_CACHE = args.has('--from-cache');
const onlyArg = [...args].find(a => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',').map(s => s.trim().toUpperCase())) : null;

const END_TS = GAME.end;                 // 排他上界：2025-01-01T00:00Z
/**
 * **两条时间基座**（2026-09-30 拆开，此前是同一个常数）：
 *   - `START_TS` = `GAME.start`：**游戏时间轴**的零点。运行时的 `s.i` 是「自它起算的小时序号」，
 *     数据包里的 `manifest.start` 也必须是它 —— **不许动**。
 *   - `DATA_TS`  = 各币 `unlock` 里**最早的那个**：**数据窗口**的零点。BTC 的回溯段
 *     （2012-09-27 起，见 `config.COINS`）落在这里 ⇒ 数据窗口比游戏窗口早 96 小时。
 *     管线内部一律用 `DATA_TS`（`idxOf` / `tsOf` / `dayUsd` 下标），于是**下标全非负**，
 *     不必给整条管线引负序号；运行时那侧只在 `market.liqOf` 加一个 `preDays` 偏移。
 */
const START_TS = GAME.start;
const DATA_TS = Math.min(...COINS.map(c => c.unlock));
/** 数据窗口比游戏窗口早多少小时（BTC 回溯段长度）；`0` = 没有回溯段 */
const PRE_HOURS = (START_TS - DATA_TS) / HOUR_MS;
const TOTAL_HOURS = (END_TS - START_TS) / HOUR_MS;    // 游戏窗口根数（清单里的 `totalHours`）
const DATA_HOURS = (END_TS - DATA_TS) / HOUR_MS;      // 数据窗口根数（一切切片的长度都用它）
/** 全程天数（每天 24 根小时 K，最后一天可能不足 24 根，向上取整）—— 日流动性按这个刻度落盘 */
const TOTAL_DAYS = Math.ceil(DATA_HOURS / 24);
/** 日流动性的「天 0」比游戏开局早几天 —— 运行时 `liqOf` 靠它把 `dayIndexOf(s.i)` 平移过来 */
const PRE_DAYS = Math.round(PRE_HOURS / 24);

const idxOf = ts => (ts - DATA_TS) / HOUR_MS;
const tsOf = i => DATA_TS + i * HOUR_MS;

/**
 * 已经建好的币的美元序列：`sym → (ms) => 当时的收盘价`。
 * 用途只有一个 —— BTC 计价的小时线（Poloniex 的早期 XRP/BTC、DOGE/BTC）要乘 BTC/USD 才能换回美元。
 * BTC 排在 `COINS` 第一位，所以轮到 DOGE / XRP 时它一定已经就位。
 */
const PRICE = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const pad = (s, n) => String(s).padEnd(n);

/**
 * 向前探路：某些币在 `start` 早于它的数据起点时，接口**不夹取、直接给空页**
 * （实测 LTC/ETH 在 2016-01 请求就是空）。所以空页不能当成「到头了」，
 * 得往前跳一段重试，直到真的拿到第一根。返回第一个有数据的游标，或 null。
 */
async function skipToFirstData(probe, fromMs, toMs, stepMs, label) {
  // 探路次数由区间长度决定：窗口很窄（比如只缺早期半年）时，别傻乎乎地一直往前跳到宇宙尽头。
  const maxJumps = Math.max(1, Math.min(60, Math.ceil((toMs - fromMs) / stepMs)));
  let cursor = fromMs;
  for (let n = 0; n < maxJumps; n++) {
    if (await probe(cursor)) return cursor;
    cursor += stepMs;
  }
  log(`    ${label}：探路 ${maxJumps} 次（至 ${new Date(cursor).toISOString().slice(0, 10)}）仍未取到数据，放弃`);
  return null;
}

/** 带退避的 GET，带超时。429/5xx 最多重试 5 次。 */
async function getJSON(url, { tries = 6, label = '' } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'accept': 'application/json', 'user-agent': 'degen-datapipe/0.1' },
        signal: AbortSignal.timeout(30000),
      });
      // 限流三兄弟：429（太频繁）、401/403（CoinGecko 在超频时也会用它们回你）
      // 都按「退避重试」处理，退避步长拉到 20 秒 —— 免费接口的窗口是每分钟几次，太急只会一直撞墙。
      if (res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) {
        const wait = (res.status === 429 || res.status < 400 ? 20000 : 8000) * (i + 1);
        log(`    ${label} ${res.status}，${wait / 1000}s 后重试（${i + 1}/${tries}）`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw new Error(`${label} 失败：${err.message}`);
      await sleep(2000 * (i + 1));
    }
  }
  return null;
}

/* ── 磁盘缓存：所有分页响应都落盘，重跑时不重复打网络（也顺便避开限流） ── */

function cachePath(key) {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150);
  return join(CACHE_DIR, `${safe}.json`);
}

async function cachedJSON(key, url, delayMs = 0, label = '') {
  const p = cachePath(key);
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  if (FROM_CACHE) return null;
  if (delayMs) await sleep(delayMs);
  const data = await getJSON(url, { label });
  if (data == null) return null;
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(p, JSON.stringify(data));
  return data;
}

/* ══════════════════════════ 数据源 ①：Bitstamp ══════════════════════════ */

/**
 * 小时线分页。`start` 是秒级 Unix，limit 上限 1000 ⇒ 每页约 41 天，回补 12 年要 100+ 页。
 * 这里直接从头往尾拉，天然覆盖全部可得区间。
 */
async function fetchBitstamp(pair, fromMs, toMs) {
  const out = new Map();           // hourIndex -> [o,h,l,c,usd]
  let pages = 0;
  let earliest = Infinity;

  const page = async sec => {
    const url = `https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=3600&limit=1000&start=${sec}`;
    const j = await cachedJSON(`bs_${pair}_${sec}`, url, 220, `bitstamp ${pair}`);
    return (j && j.data && j.data.ohlc) || [];
  };

  // 先找真正的起点：从窗口左端起，空页就往前跳 60 天
  const firstMs = await skipToFirstData(
    async ms => (await page(Math.floor(ms / 1000))).length > 0,
    fromMs, toMs, 60 * 86400e3, `bitstamp ${pair}`);
  if (firstMs == null) return { rows: out, earliest: null, pages };

  let cursor = Math.floor(firstMs / 1000);
  while (cursor * 1000 < toMs) {
    const rows = await page(cursor);
    if (!rows.length) break;

    for (const r of rows) {
      const ts = Number(r.timestamp) * 1000;
      if (ts < DATA_TS || ts >= toMs) continue;      // 回溯段照收（原来这里丢掉了 BTC 的 2011–2012）
      const o = +r.open, h = +r.high, l = +r.low, c = +r.close;
      if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
      const i = idxOf(ts);
      if (!Number.isInteger(i)) continue;
      // Bitstamp 行内的 `volume` 是**基础币**成交量 ⇒ × 收盘价换回美元成交额
      out.set(i, [o, h, l, c, +(r.volume > 0 ? r.volume * c : 0)]);
      if (ts < earliest) earliest = ts;
    }

    const last = Number(rows[rows.length - 1].timestamp) * 1000;
    const next = last / 1000 + 3600;
    if (next <= cursor) break;          // 防死循环
    cursor = next;
    pages++;
    if (pages > 200) break;
  }
  return { rows: out, earliest: out.size ? earliest : null, pages };
}

/* ══════════════════════════ 数据源 ②：Bitfinex ══════════════════════════ */

/**
 * Bitfinex v2 candles，小时线，USD 本位。
 * ⚠️ 返回的每行是 `[MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]` —— **先收盘再最高最低**，
 *    顺序和所有人的直觉相反，抄错就会把 high/low 对调，图上每根 K 线的影线都是反的。
 *    `r[5]` 的 VOLUME 是**基础币**成交量 ⇒ × 收盘价换回美元成交额。
 * `sort=1` 是升序，`limit` 上限 10000 ⇒ 一页 416 天，回补几年只要几页。
 */
async function fetchBitfinex(pair, fromMs, toMs) {
  const out = new Map();
  let pages = 0;

  const page = async (startMs, endMs) => {
    const url = `https://api-pub.bitfinex.com/v2/candles/trade:1h:${pair}/hist`
      + `?limit=10000&start=${startMs}&end=${endMs}&sort=1`;
    const d = await cachedJSON(`bf_${pair}_${startMs}`, url, 260, `bitfinex ${pair}`);
    return Array.isArray(d) ? d : [];
  };

  // Bitfinex 对不存在的交易对返回 `["error", ...]`，对窗口内无数据返回 `[]`。两者都当空。
  const firstMs = await skipToFirstData(
    async ms => (await page(ms, ms + 90 * 86400e3)).length > 0,
    fromMs, toMs, 90 * 86400e3, `bitfinex ${pair}`);
  if (firstMs == null) return { rows: out, pages };

  let cursor = firstMs;
  while (cursor < toMs) {
    const rows = await page(cursor, toMs);
    if (!rows.length) break;

    for (const r of rows) {
      const ts = Number(r[0]);
      if (ts < DATA_TS || ts >= toMs) continue;
      const o = +r[1], c = +r[2], h = +r[3], l = +r[4];
      if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
      const i = idxOf(ts);
      if (!Number.isInteger(i)) continue;
      out.set(i, [o, h, l, c, +(r[5] > 0 ? r[5] * c : 0)]);
    }

    const last = Number(rows[rows.length - 1][0]);
    const next = last + HOUR_MS;
    if (next <= cursor) break;
    cursor = next;
    pages++;
    if (pages > 40) break;
  }
  return { rows: out, pages };
}

/* ═══════════════ 数据源 ③：Binance / Binance.US ═══════════════
 * 这两家是**不同的交易所**（不同实体、不同订单簿、价格也略有差异），但 K 线接口同形，
 * 所以共用一个工厂。`tag` 只用来区分磁盘缓存键，免得两家的分页互相覆盖。
 *
 * 为什么要有 Binance.US：Binance 自己的 K 线库里，SOLUSDT / SOLBTC / SOLBUSD 三对
 * **同时**缺了同样的 20 个小时（2020-11 → 2023-03，官方月度归档也同缺），而 Binance.US
 * 的 SOLUSD 这 20 小时一根不少。它只当「补洞源」，排在 Binance 之后。
 */
const makeBinanceFetcher = (base, tag, label) => async (symbol, fromMs, toMs) => {
  const out = new Map();
  let pages = 0;

  const page = async ms => {
    const url = `${base}/api/v3/klines?symbol=${symbol}&interval=1h`
      + `&startTime=${ms}&limit=1000`;
    const rows = await cachedJSON(`${tag}_${symbol}_${ms}`, url, 200, `${label} ${symbol}`);
    return Array.isArray(rows) ? rows : [];
  };

  // 同上：Binance 对「上币之前」的 startTime 一般会夹取，但不保证，照样探一次路
  const firstMs = await skipToFirstData(
    async ms => (await page(ms)).length > 0,
    fromMs, toMs, 90 * 86400e3, `${label} ${symbol}`);
  if (firstMs == null) return { rows: out, pages };

  let cursor = firstMs;
  while (cursor < toMs) {
    const rows = await page(cursor);
    if (!rows.length) break;

    for (const r of rows) {
      const ts = Number(r[0]);
      if (ts < DATA_TS || ts >= toMs) continue;
      const o = +r[1], h = +r[2], l = +r[3], c = +r[4];
      if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
      const i = idxOf(ts);
      if (!Number.isInteger(i)) continue;
      // `r[7]` 是**计价币成交额**（USDT 档即美元额）—— 直接就是我们要的数，不用再乘价格
      out.set(i, [o, h, l, c, +(r[7] > 0 ? r[7] : 0)]);
    }

    const last = Number(rows[rows.length - 1][0]);
    const next = last + HOUR_MS;
    if (next <= cursor) break;
    cursor = next;
    pages++;
    if (pages > 200) break;

    // 已经追平「现在」就停，不要空转
    if (last >= Date.now() - HOUR_MS) break;
  }
  return { rows: out, pages };
};

const fetchBinance = makeBinanceFetcher('https://api.binance.com', 'bn', 'binance');
const fetchBinanceUS = makeBinanceFetcher('https://api.binance.us', 'bnus', 'binance.us');

/* ══════════════ 数据源 ④：CryptoDataDownload 静态 CSV 归档（小时线） ══════════════ */

const CDD_BASE = 'https://www.cryptodatadownload.com/cdd/';

/**
 * 为什么要有这个源：**官方 API 全都给不出早期年份**（2026-09 实测）
 *   - Bitstamp / Binance / Bitfinex 只能从各自的上市日开始给
 *   - 交易所的公开 REST 历史也普遍只留最近几年
 * 而 CDD 把各交易所的完整历史打包成静态 CSV，**不需要 key、不需要翻页**。
 * 其中 Poloniex 的归档能回到 2014-01（DOGE/BTC）与 2014-08（XRP/BTC），
 * 正好补上 2013–2017 这段最关键的早期行情。
 *
 * 文件格式（实测）：第 1 行是站点横幅，第 2 行是表头，
 * 之后每行 `unix(ms), date, symbol, open, high, low, close, ...`，**按时间倒序**。
 */
async function fetchCDDText(file) {
  const p = cachePath(`cdd_${file}`);
  if (existsSync(p)) return readFileSync(p, 'utf8');
  if (FROM_CACHE) return null;
  const url = CDD_BASE + file;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'accept': '*/*', 'user-agent': 'Mozilla/5.0 degen-datapipe/0.1' },
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) { log(`    ${file} HTTP ${res.status}，${4 * (i + 1)}s 后重试`); await sleep(4000 * (i + 1)); continue; }
      const text = await res.text();
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(p, text);
      return text;
    } catch (err) {
      if (i === 3) { log(`    ${file} 下载失败：${err.message}`); return null; }
      await sleep(4000 * (i + 1));
    }
  }
  return null;
}

/** 解析 CDD CSV → `[[ts, o, h, l, c, quoteVol], ...]`（只留四价都为正的行） */
function parseCDD(text) {
  const rows = [];
  if (!text) return rows;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('http') || line.startsWith('unix')) continue;
    const c = line.split(',');
    const ts = Number(c[0]);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const o = +c[3], h = +c[4], l = +c[5], cl = +c[6];
    if (!(o > 0 && h > 0 && l > 0 && cl > 0)) continue;
    // ⚠️ CDD 的**表头与值是反的**（2026-09-29 逐文件实测，7 个文件一致）：
    //    表头写 `...,close,Volume ETH,Volume USDT,...`，但 `c[7]` 才是**计价币成交额**、
    //    `c[8]` 是标的数量 —— ETHUSDT 样例行 `1,265,067.95 ÷ 2405.02 ≈ 526.01 = c[8]` ✓。
    //    照表头读会把两者对调，成交额错两个数量级。
    rows.push([ts, o, h, l, cl, +(c[7] > 0 ? +c[7] : 0)]);
  }
  return rows;
}

/**
 * 小时线 CSV → `hourIndex → [o,h,l,c,usd]`
 *
 * `quote: 'USDT'` 的档本身就是美元/稳定币计价，成交额 `c[7]` 直接就是美元额；
 * `quote: 'BTC'` 的档（Poloniex 早期只有 `DOGE/BTC`、`XRP/BTC`）要乘以**同一时刻**的
 * BTC/USD 才换回美元 —— 价与量**乘同一个乘数**，所以成交额也是同比例换算。
 *
 * ⚠️ 这里**只做逐根换算，绝不插值**：两个乘数都是真小时线，换算出来的每一根
 *    也对应真实成交的那一小时。BTC 计价那几档在 2014 年的报价精度只有 1 聪
 *    （`DOGE/BTC = 0.00000065`），所以那段的日内波动会大量来自 BTC 本身。
 */
async function fetchCDDHourly(file, quote, btcAt) {
  const out = new Map();
  const needBTC = quote === 'BTC';
  if (needBTC && !btcAt) return { rows: out };
  for (const [ts, o, h, l, c, qv] of parseCDD(await fetchCDDText(file))) {
    if (ts < DATA_TS || ts >= END_TS) continue;
    const i = idxOf(ts);
    if (!Number.isInteger(i)) continue;
    if (!needBTC) { out.set(i, [o, h, l, c, qv]); continue; }
    const bp = btcAt(ts);
    if (!(bp > 0)) continue;
    out.set(i, [o * bp, h * bp, l * bp, c * bp, qv * bp]);
  }
  return { rows: out };
}

/* ══════════════ 数据源 ⑥：Kraken 官方 OHLCVT 归档（本地 CSV，小时线） ══════════════
 * 文件 `{PAIR}_60.csv`，无表头，列 = `unixtime(s), open, high, low, close, volume, trades`。
 * 实测覆盖（2026-06-30 收官）：XBTUSD 2013-10-06 起、ETHUSD 2015-08-07 起、
 * **XRPXBT / XDGXBT / ETHXBT 2016-07-19 起**、XRPUSD 2017-05-18 起、
 * **XDGUSD 2019-12-19 起**、SOLUSD 2021-06-17 起。
 *
 * ⚠️ 归档里的 `volume` 是**标的数量**，与 ①–④ 的计价币成交额不同口径 ⇒
 *    **只当价格票**，第 5 列恒填 0（成交量只认主源，见文件头「多所聚合」）。
 *
 * **一家只投一票**：`KRAKEN_PAIRS` 是**按优先级排列的档位表**，同一小时取第一个有报价的档
 * （USD 档优先，未上线时才退到 XBT 档）。这样 Kraken 每小时至多一票，不会因为 USD/XBT
 * 两个订单簿都覆盖同一小时而把票数灌成两票、在 `medoid` 里过度加权。
 * XBT 计价档（`XRPXBT` / `XDGXBT`）要乘**同一时刻的 BTC/USD** 才换回美元 ——
 * 与 ⑤ 的 Poloniex BTC 档同理、同乘数（价与量同比例，但本档量不采）。
 */
const KRAKEN_PAIRS = {
  BTC: [['XBTUSD', 'USD']],
  ETH: [['ETHUSD', 'USD']],
  XRP: [['XRPUSD', 'USD'], ['XRPXBT', 'BTC']],
  DOGE: [['XDGUSD', 'USD'], ['XDGXBT', 'BTC']],
  SOL: [['SOLUSD', 'USD']],
};

/** Kraken 归档 -> `hourIndex → [o,h,l,c,usd]`。多档按优先级合并，一家只投一票。 */
function fetchKraken(sym, fromMs, toMs, btcAt) {
  const out = new Map();
  for (const [pair, quote] of KRAKEN_PAIRS[sym] || []) {
    const p = join(KRAKEN_DIR, `${pair}_60.csv`);
    if (!existsSync(p)) continue;
    const needBTC = quote === 'BTC';
    if (needBTC && !btcAt) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue;
      const c = line.split(',');
      const ts = Number(c[0]) * 1000;
      if (!(ts >= fromMs) || ts >= toMs) continue;
      let o = +c[1], h = +c[2], l = +c[3], cl = +c[4];
      if (!(o > 0 && h > 0 && l > 0 && cl > 0)) continue;
      const i = idxOf(ts);
      if (!Number.isInteger(i)) continue;
      if (out.has(i)) continue;                    // 前面的档优先，一家一票
      if (needBTC) {
        const bp = btcAt(ts);
        if (!(bp > 0)) continue;
        o *= bp; h *= bp; l *= bp; cl *= bp;
      }
      out.set(i, [o, h, l, cl, 0]);
    }
  }
  return { rows: out, pages: 0 };
}

/* ═══════════════════════ 多所聚合（文件头「多所聚合」段） ═══════════════════════ */

/**
 * 五个币**全部**走多所聚合（K 线全市场校准，2026-10-01：K1 = BTC → K2 = ETH/XRP
 * → K2b = Bitfinex 投票源 → K3 = DOGE/SOL）。名单之外若还有币，走原来的「按优先级补洞」，
 * 输出逐位不变 —— 这是分批推进时的隔离保证，现在名单已满。
 */
const AGG_COINS = new Set(['BTC', 'ETH', 'XRP', 'DOGE', 'SOL']);

/**
 * 逐字段鲁棒中位：从各源**真实报过的值**里挑一个（medoid = 到其余各值对数距离之和最小者）。
 *
 * 为什么不是「取平均」：平均会把一家的坏价**摊进**价格里（Bitstamp 301 / Kraken 4000
 * 平均出 2150，比原来还糟）。medoid 只会把孤立的那家**丢掉**，且结果永远等于某家的真值。
 * 平局按**传入顺序**（＝数据源优先级）取前者：
 *   1 家 → 就是它；2 家 → 平局 ⇒ 取主源（与改造前逐位一致）；3 家 → 恰是中位数；4+ 家 → 离群者出局。
 */
function medoid(vals) {
  if (vals.length === 1) return vals[0];
  let best = 0, bestScore = Infinity;
  for (let a = 0; a < vals.length; a++) {
    let s = 0;
    for (let b = 0; b < vals.length; b++) s += Math.abs(Math.log(vals[a] / vals[b]));
    if (s < bestScore - 1e-12) { bestScore = s; best = a; }
  }
  return vals[best];
}

/** 一小时的多源报价 → 一根 K 线：逐字段 medoid ＋ 不变量修正 */
function aggregateHour(list) {
  const o = medoid(list.map(r => r[0]));
  const c = medoid(list.map(r => r[3]));
  let h = medoid(list.map(r => r[1]));
  let l = medoid(list.map(r => r[2]));
  if (h < o) h = o;
  if (h < c) h = c;
  if (l > o) l = o;
  if (l > c) l = c;
  return [o, h, l, c];
}

/* ══════════════════════════ 组装单个币种 ══════════════════════════ */

/**
 * 组装单个币种的完整小时序列。
 *
 * 两种模式（由 `AGG_COINS` 决定，见文件头「多所聚合」段）：
 *   - **聚合**：每一家源都覆盖整条窗口，逐小时逐字段投票（`aggregateHour`），单所的「针」被其余几票投出去；
 *   - **补洞**（未列入的币）：源依次上，**后来的只补前面的空洞**，绝不覆盖 —— 与改造前逐位一致。
 *
 * 每根存 **5 列**：`[o, h, l, c, usd]` —— `usd` 是那一小时的真实美元成交额
 * （第 5 列只用于聚合日流动性，不进 K 线包）。
 *
 * 收尾三步（这一版的重点）：
 *  ① **裁掉开头的空档** —— `config.unlock` 只是「最早可能」，真正的起点是实测的第一根真 K 线；
 *  ② **中间的空档**逐段记进 `stats.gapRanges` 并打印（价格沿用上一根收盘 = 该小时无成交，
 *     成交额记 0）；
 *  ③ 一根数据都没有 → 直接报错，绝不产出全 0 的假序列。
 * @returns {{ startI, count, held, dayUsd, stats }}
 */
async function buildCoin(coin) {
  const AGG = AGG_COINS.has(coin.sym);
  const startI = idxOf(coin.unlock);
  const count = DATA_HOURS - startI;
  const held = new Float64Array(count * 5);       // [o,h,l,c,usd] × count
  const have = new Uint8Array(count);             // 0 = 还是空的
  // 逐小时成交额按日累加 —— 日流动性（liq.bin）的唯一原料。
  // 这里累加的是**最终留在 held 里的那一份**，所以多源拼接后的日成交额天然连续，
  // 不会出现「同一小时被两家源各记一次」。
  const dayUsd = new Float64Array(TOTAL_DAYS);
  const stats = { hourly: 0, gapHours: 0, gapRanges: [], bySource: [] };

  /** 聚合模式：`k → 那一小时各源的 [o,h,l,c,usd]`，**按数据源优先级顺序**进来（`medoid` 靠它裁平局） */
  const cells = AGG ? new Array(count) : null;

  /** 补洞模式：还没落子的小时 */
  const holeList = () => {
    const a = [];
    for (let k = 0; k < count; k++) if (!have[k]) a.push(k);
    return a;
  };

  // 数据来源标号：只用来区分「这根是谁给的」，每条源取一个新的，保证不重号
  let tagSeq = 0;
  const nextTag = () => ++tagSeq;

  /** 一条数据源跑完后的统一记账 */
  const absorb = (label, rows, tag) => {
    let added = 0;
    for (const [i, v] of rows) {
      if (i < startI) continue;
      const k = i - startI;
      if (cells) {
        let c = cells[k];
        if (!c) { c = cells[k] = []; have[k] = tag; }
        c.push(v);
        added++;                   // 聚合模式：added = 这家**投出的票数**（＝它覆盖到的小时数）
      } else {
        if (have[k]) continue;
        held[k * 5] = v[0]; held[k * 5 + 1] = v[1]; held[k * 5 + 2] = v[2]; held[k * 5 + 3] = v[3];
        held[k * 5 + 4] = v[4] > 0 ? v[4] : 0;
        have[k] = tag;
        dayUsd[Math.floor(i / 24)] += held[k * 5 + 4];
        added++;
      }
    }
    stats.bySource.push([label, added]);
    log(`    ${label}: ${cells ? `覆盖 ${added} 根` : `补入 ${added} 根`}`);
  };

  /** 这一趟该抓多长：聚合模式每家都得覆盖**整条窗口**（否则它没有投票资格）；补洞模式只抓还有洞的那一段 */
  const spanOf = () => {
    if (cells) return [tsOf(startI), tsOf(startI + count)];
    const holes = holeList();
    if (!holes.length) return null;
    return [tsOf(startI + holes[0]), tsOf(startI + holes[holes.length - 1]) + HOUR_MS];
  };

  /* ── ① 小时级 USD/USDT 源：官方 API ── */
  // 补洞模式下每家只抓「还有洞」的那一段：缺口常常只是早期几年，窗口若不收窄，
  // 就得把整条 12 年时间轴重新捞一遍，而其中九成上一家已经给过了 —— 纯属白打。
  // 顺序即优先级（聚合模式裁平局也按它）。
  const API = [
    ['bitstamp', fetchBitstamp, coin.src.bitstamp],
    ['bitfinex', fetchBitfinex, coin.src.bitfinex],
    ['binance', fetchBinance, coin.src.binance],
    ['binanceus', fetchBinanceUS, coin.src.binanceus],
  ];
  for (const [key, fetcher, pair] of API) {
    const span = spanOf();
    if (!span) { log(`    ${key}：已无空缺，跳过`); break; }
    if (!pair) { log(`    ${key}：该币无此交易对`); continue; }
    try {
      absorb(`${key} ${pair}`, (await fetcher(pair, span[0], span[1])).rows, nextTag());
    } catch (err) {
      log(`    ${key} ${pair} 取数失败：${err.message}`);
    }
  }

  /* ── ② 小时级归档 CSV（CryptoDataDownload）—— USDT 直铺 / BTC 计价换算 ── */
  for (const src of coin.cdd || []) {
    if (!spanOf()) { log(`    ${src.file}：已无空缺，跳过`); break; }
    try {
      absorb(src.file, (await fetchCDDHourly(src.file, src.quote, PRICE.get('BTC'))).rows, nextTag());
    } catch (err) {
      log(`    ${src.file} 取数失败：${err.message}`);
    }
  }

  /* ── ③ Kraken 官方归档（本地 CSV）—— **只服务聚合模式**；补洞模式必须逐位不变 ── */
  if (cells) {
    const pairs = KRAKEN_PAIRS[coin.sym];
    if (pairs) {
      const label = `kraken ${pairs.map(x => x[0]).join('+')}`;
      try {
        absorb(label, (await fetchKraken(coin.sym, tsOf(startI), tsOf(startI + count), PRICE.get('BTC'))).rows, nextTag());
      } catch (err) {
        log(`    ${label} 读取失败：${err.message}`);
      }
    }
  }

  /* ── ④ 额外投票源（`config.COINS[].votes`）—— **只投票、不定成交量** ──
   * 排在整条优先级链的**最末**（Kraken 之后）⇒ 永远成不了「主源」（成交量仍归 ⑤ 里的 `list[0]`），
   * 且只在「该小时已经 ≥3 家报价」时才真正改变 `medoid` 的结果。见 `config.js` 的 `votes` 段。
   * 同样**只服务聚合模式**：补洞模式必须逐位不变。 */
  if (cells) {
    for (const v of coin.votes || []) {
      if (v.exch !== 'bitfinex') continue;
      try {
        absorb(`votes bitfinex ${v.pair}`, (await fetchBitfinex(v.pair, tsOf(startI), tsOf(startI + count))).rows, nextTag());
      } catch (err) {
        log(`    votes bitfinex ${v.pair} 取数失败：${err.message}`);
      }
    }
  }

  /* ── ⑤ 聚合：逐字段 medoid ＋ 不变量修正；成交量只认主源 ── */
  if (cells) {
    let multi = 0, votes = 0;
    for (let k = 0; k < count; k++) {
      const list = cells[k];
      if (!list) continue;
      const [o, h, l, c] = aggregateHour(list);
      held[k * 5] = o; held[k * 5 + 1] = h; held[k * 5 + 2] = l; held[k * 5 + 3] = c;
      // 主源 = 优先级最高、**且这一小时确实报了价**的那家（`absorb` 按优先级顺序 push，故是 `list[0]`）。
      // 成交量改成跨所求和会同时动 liq.bin、滑点分母与拥堵脉冲阈值 —— 本轮刻意不动。
      held[k * 5 + 4] = list[0][4] > 0 ? list[0][4] : 0;
      dayUsd[Math.floor((startI + k) / 24)] += held[k * 5 + 4];
      votes += list.length;
      if (list.length > 1) multi++;
    }
    stats.votes = votes;
    stats.multi = multi;
    log(`    聚合：${multi} 小时有 ≥2 家报价（合计 ${votes} 票）`);
  }

  // 收尾统计：真正有数据的小时数（两种模式同口径；无成交小时要到第 ⑦ 步才标 255）
  for (let k = 0; k < count; k++) if (have[k]) stats.hourly++;

  /* ── ⑥ 裁掉开头的空档：起点以「实测的第一根真 K 线」为准 ── */
  let lead = 0;
  while (lead < count && !have[lead]) lead++;
  if (lead === count) throw new Error(`${coin.sym}: 一根数据都没有 —— 检查 config.unlock 与数据源`);
  if (lead > 0) {
    log(`    ⚠️ 实测起点 ${new Date(tsOf(startI + lead)).toISOString().slice(0, 16)}`
      + ` 晚于配置的 ${new Date(coin.unlock).toISOString().slice(0, 16)}，裁掉前 ${lead} 小时`);
  }

  /* ── ⑦ 中间的空档：不造数据，只在日志与 index.json 里逐段留痕 ── */
  let lastKnown = held[lead * 5 + 3];
  let runStart = -1;
  const flushGap = end => {
    if (runStart < 0) return;
    stats.gapRanges.push([tsOf(startI + runStart), tsOf(startI + end)]);
    runStart = -1;
  };
  for (let k = lead; k < count; k++) {
    if (have[k]) { lastKnown = held[k * 5 + 3]; flushGap(k); continue; }
    held[k * 5] = held[k * 5 + 1] = held[k * 5 + 2] = held[k * 5 + 3] = lastKnown;
    held[k * 5 + 4] = 0;               // 该小时无成交 ⇒ 成交额 0，不参与日流动性
    have[k] = 255;                     // 「该小时无成交」的专用标号，与数据源标号不会撞
    stats.gapHours++;
    if (runStart < 0) runStart = k;
  }
  flushGap(count);

  const outI = startI + lead;
  const outCount = count - lead;
  return { startI: outI, count: outCount, held: held.subarray(lead * 5), dayUsd, stats };
}

/* ══════════════════════════ 编码与落盘 ══════════════════════════ */

/**
 * 选缩放因子：让「最大价 × scale」落在 1e8 附近（至少留 8 位有效数字），
 * 同时不能撑爆 Int32（上限 2.147e9）。返回 10 的幂。
 */
function chooseScale(maxPrice) {
  const e = Math.floor(8 - Math.log10(maxPrice));
  return Math.pow(10, Math.max(0, Math.min(8, e)));
}

/**
 * 打包一个币：前半是 OHLC（`count × 16` 字节），**尾部追加 `count` 个字节的成交量份额**
 * （Batch 3 · B11，2026-09-29 拍板「方案 B」）。
 *
 * 为什么不是「第 5 列 Int32」而是一个字节：
 *   ① 画量柱只需要**相对量**，1/255 的日内分辨率（≈0.4%）肉眼完全够；
 *   ② 绝对美元成交额跨 7 个数量级（2013 BTC 小时额 ≈ $2e4 → 2024 峰值 $1e9+），
 *      单一 scale 两头难兼顾，而份额天然归一；
 *   ③ 份额 × `liqOf(sym, day)` ＝ 该小时的美元量，**与 P2-B 滑点用的那一份流动性同源**
 *      （日线模式下 24 根相加也正好等于 `liqOf`，不用再聚合）。
 * 有成交的小时**至少给 1**，否则极小的份额会被量化成 0、量柱整根消失。
 */
function encodeCoin(held, count, scale, dayUsd, startI) {
  const buf = Buffer.allocUnsafe(count * 17);
  // ⚠️ 布局是**两段式**：前 `count × 16` 字节是 OHLC（步长仍是 16），
  //    成交量份额**整段追加在尾部**（第 `count*16 + k` 字节）。
  //    不能写成「OHLC 步长 17、份额跟在每根后面」——那样 OHLC 就不再是连续的 Int32 数组，
  //    运行时得逐根拼，白白多一层开销（这个坑在 2026-09-29 的字节校验里被逮到过）。
  const VOL_BASE = count * 16;
  for (let k = 0; k < count; k++) {
    const o = held[k * 5], h = held[k * 5 + 1], l = held[k * 5 + 2], c = held[k * 5 + 3];
    const usd = held[k * 5 + 4];
    const O = Math.round(o * scale);
    buf.writeInt32LE(O, k * 16);
    buf.writeInt32LE(Math.round(h * scale) - O, k * 16 + 4);
    buf.writeInt32LE(Math.round(l * scale) - O, k * 16 + 8);
    buf.writeInt32LE(Math.round(c * scale) - O, k * 16 + 12);

    const day = Math.floor((startI + k) / 24);
    const total = dayUsd[day];
    const share = total > 0 ? usd / total : 0;
    let b = Math.round(share * 255);
    if (usd > 0 && b < 1) b = 1;
    buf[VOL_BASE + k] = b > 255 ? 255 : b;
  }
  return buf;
}

/* ═════════════════ 日流动性（liq.bin，P2-A 拥堵脉冲 / P2-B 滑点共用） ═════════════════
 * 为什么不塞进 K 线包：每根多 4 字节会让 3.35 MB 的包体再涨 25%，破 GDD §19.2 的预算。
 * 日流动性只用来算一个「10% 阈值」，**日粒度足够**（§6.4 与 §14.3 用的都是「日流动性」）。
 *
 * 口径（ROADMAP §五 P2-A，2026-09-29 拍板）= **两端锚定 ＋ 真实年内形状**：
 *   ① 形状：沿抓价那条链逐小时取真实美元成交额 → 按日求和 → ÷ 该币当年的真实日均
 *   ② 两端锚定：L(年) = 早锚 × (晚锚 ÷ 早锚) ^ ((年 − 首年) ÷ (2024 − 首年))
 *       合成 liq(日) = L(年) × 形状(日)  ⇒ **年均正好落在锚上、年内起伏全真**
 *
 * ⚠️ **不做平滑**（2026-09-29 定案，原方案的「7 日滚动中位数」已删）：实测 7 日窗口会把
 *    验收口径⑦要求的「年内同形 > 0.9」压到 0.73–0.86（3 日窗口也只到 0.88–0.95），
 *    与「年内起伏全真」直接冲突。去掉平滑后相关**恒为 1.000**（形状本就是真实成交额的等比缩放）。
 *    代价：liq 逐日抖动 = 真实抖动，10% 脉冲阈值跟着抖 —— 这是真实市场形态，接受。
 *
 * ⚠️ §15.2 的 2013 早锚（$50 万）比实测的 Bitstamp 单所 2013 日均（$426 万）还低 8.5×。
 *    ⇒ **不要**把 `L ÷ 真实` 解释成「全市场 ÷ 单所」。真实成交额只提供「形状」，量级完全由锚决定。
 */

/** §15.2 的早 / 晚锚（美元/天）。ETH / SOL 早锚与 SOL 晚锚是 §15.2 没写的三个数，
 *  按「同年 BTC 的 锚 ÷ 真值 比」推得（ROADMAP §五 P2-A「定稿口径」）。 */
const LIQ_ANCHORS = {
  BTC:  { early: 5e5,   late: 3e10   },   // 2013-01 → 2024，年化 ×3.35
  DOGE: { early: 1e3,   late: 2e9    },
  XRP:  { early: 5e3,   late: 2e9    },
  ETH:  { early: 1e3,   late: 1.5e10 },
  SOL:  { early: 9.2e7, late: 2e9    },   // 晚锚不取 $93 亿的推值，与 XRP / DOGE 同档
};

/** 第 d 天的年份（UTC） */
const yearOfDay = d => new Date(tsOf(d * 24)).getUTCFullYear();

/**
 * 由「逐日真实美元成交额」算出该币的日流动性序列。
 * @param {string} sym
 * @param {Float64Array} dayUsd  全程逐日真实成交额（未上线日为 0）
 * @param {number} firstDay      该币第一根真 K 线所在的天（**覆盖起点**，可早于锚定日）
 * @param {number} anchorDay     **锚定日** —— `LIQ_ANCHORS.early` 落在这一天所在的年
 *   ⚠️ 与 `firstDay` 分开是 2026-09-30 回溯段的直接结果：BTC 的覆盖起点落在 2012 年，
 *      但锚**必须仍然锚在 2013 年**，否则 `firstYear` 变成 2012 ⇒ 2013–2024 全年流动性数值
 *      会整体平移（滑点分母、脉冲阈值跟着全变）。分开之后：覆盖多出的那几天走**几何向后外推**
 *      （`L(2013−k)` 用同一个幂式算出，2013 年本身仍是 `early`）⇒ **2013+ 逐位不变**。
 * @returns {{ liq: Float32Array, firstYear, anchorEarly, anchorLate, mean: object, corr: object }}
 *   `mean` = 每年**实际算出的**年均（供验收口径⑦核对）；
 *   `corr` = 年内同形度 `{ mean, worst }`（无平滑 ⇒ 应为 1.000）
 */
function buildLiqDaily(sym, dayUsd, firstDay, anchorDay) {
  const { early, late } = LIQ_ANCHORS[sym];
  const firstYear = yearOfDay(anchorDay);
  const liq = new Float32Array(TOTAL_DAYS);

  /** 按年求和 / 计数 → 年均表 */
  const tally = (fn) => {
    const acc = new Map();
    for (let d = firstDay; d < TOTAL_DAYS; d++) {
      const y = yearOfDay(d);
      const e = acc.get(y) || [0, 0];
      e[0] += fn(d); e[1] += 1;
      acc.set(y, e);
    }
    const out = new Map();
    for (const [y, [sum, n]] of acc) out.set(y, n ? sum / n : 0);
    return out;
  };

  // ① 形状：逐日 ÷ 当年日均 ⇒ 年均恰为 1
  const shapeAvg = tally(d => dayUsd[d]);
  const shape = new Float64Array(TOTAL_DAYS);
  for (let d = firstDay; d < TOTAL_DAYS; d++) {
    const avg = shapeAvg.get(yearOfDay(d));
    shape[d] = avg > 0 ? dayUsd[d] / avg : 1;
  }

  // ② 两端锚定几何插值 + 合成
  const span = Math.max(1, 2024 - firstYear);
  const mean = {};
  for (let d = firstDay; d < TOTAL_DAYS; d++) {
    const y = yearOfDay(d);
    const L = early * Math.pow(late / early, (y - firstYear) / span);
    liq[d] = L * shape[d];
    mean[y] = (mean[y] || 0) + liq[d];    // 先累加，收尾除以天数
  }
  {
    const cnt = new Map();
    for (let d = firstDay; d < TOTAL_DAYS; d++) {
      const y = yearOfDay(d);
      cnt.set(y, (cnt.get(y) || 0) + 1);
    }
    for (const y in mean) mean[y] /= cnt.get(Number(y)) || 1;
  }

  return {
    liq, firstYear, anchorEarly: early, anchorLate: late, mean,
    corr: intraYearCorr(liq, dayUsd, firstDay),
  };
}

/**
 * 皮尔逊相关系数（限定 `[from, to]` 闭区间）
 */
function pearson(a, b, from, to) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let d = from; d <= to; d++) {
    const x = a[d], y = b[d];
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  if (n < 2) return null;
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) ** 2;
  const vb = sbb / n - (sb / n) ** 2;
  const den = Math.sqrt(va * vb);
  return den > 0 ? cov / den : null;
}

/**
 * **年内**同形度：合成日流动性与真实日成交额逐年求相关，再按天数加权平均
 * （验收口径⑦要求 > 0.9）。本管线**不做平滑**，所以这个值应当**恒为 1.000** ——
 * 年内 liq = 常数 × 真实日均成交额，是真实序列的等比缩放。
 * 它不是「像不像」的近似判断，而是**回归断言**：哪天掉下 1，说明形状的口径被改动了。
 *
 * ⚠️ 必须**按年**算：跨年时 liq 的量级由锚的几何插值决定，而真实成交额有自己的年度水平，
 *    两者本来就被刻意解耦（§15.2 的锚比真实值高/低几倍到几百倍）⇒ 跨年相关系数会很低，
 *    那不是形状坏了，是量级口径不同。本条只回答「年内起伏像不像」。
 */
function intraYearCorr(liq, dayUsd, firstDay) {
  const acc = new Map();
  for (let d = firstDay; d < TOTAL_DAYS; d++) {
    const y = yearOfDay(d);
    const e = acc.get(y) || [0, 0];    // [起, 止]
    if (!e[1]) e[0] = d;
    e[1] = d;
    acc.set(y, e);
  }
  let wsum = 0, w = 0, worst = 1;
  for (const [y, [a, b]] of acc) {
    const n = b - a + 1;
    if (n < 60) continue;              // 首年常常只有几十天，样本太短，不计入
    const r = pearson(liq, dayUsd, a, b);
    if (r == null) continue;
    wsum += r * n; w += n; worst = Math.min(worst, r);
  }
  return { mean: w ? wsum / w : 0, worst: w ? worst : 0 };
}

/** 把 5 个币的日流动性拼成一个 Float32LE 大包（币序 = `COINS` 顺序，每天一个值） */
function encodeLiq(perCoin) {
  const buf = Buffer.allocUnsafe(COINS.length * TOTAL_DAYS * 4);
  COINS.forEach((c, n) => {
    const a = perCoin[c.sym];
    const off = n * TOTAL_DAYS * 4;
    for (let d = 0; d < TOTAL_DAYS; d++) buf.writeFloatLE(a ? (a[d] || 0) : 0, off + d * 4);
  });
  return buf;
}

/**
 * 五币逐年流通量（GDD §15.1 的「玩家可控制上限」与 §15.4 的「供应量消耗」用）。
 *
 * 数据来源（2026-10-01 二次核校 —— 逐锚点对 Coin Metrics `SplyCur` 与 CMC 历史快照）：
 *   BTC   blockchain.info `total-bitcoins` 逐日序列（八个锚点对 `SplyCur` **全部 0.0%**）
 *   ETH   Coin Metrics `SplyCur`（创世值已按真值修正为 72,307,863；Merge 后叠加 EIP-1559 一度通缩）
 *   DOGE  Coin Metrics `SplyCur`（⚠️「初始 1000 亿」是错的 —— 2014-01-01 只有 190 亿、当年 8 月已冲到
 *         895 亿，2015 起才固定 +52.6 亿/年 ⇒ **必须逐年给锚点**，否则 2014–2017 段只剩真值四成）
 *   SOL   Coin Metrics 社区免费档**不提供** SOL 的 SplyCur / CapMrktCurUSD（403）⇒ 起点 820 万与端点
 *         429M / 483M 由 SEC 文件（SR-NYSEARCA-2025-06 / S-3）证实；中间锚 4750 万无一手出处
 *   XRP   Coin Metrics **只给总量不给流通量**（恒返回 1000 亿）⇒ 改用 CMC 历史快照的 `Circulating Supply`
 *         实读值逐年铺（2014-08 起）；⚠️ 2014 下半年 CMC 自己改过口径，8.25B → 28.99B 那条台阶是**来源自带的**
 *
 * ⚠️ 一张「表」，不是逐日序列 —— 与 §15.2 的日流动性不同，流通量只做逐年参考与上限判定。
 *    P2-B 落地时若要逐日精度，再单独接 API。本轮（P2-A）不消费它，先随 manifest 落盘备查。
 */
const CIRCULATING = {
  BTC: {
    unit: 'BTC',
    points: {
      '2013-01-01': 10614075, '2016-01-01': 15029575, '2018-01-01': 16774525, '2020-01-01': 18133650,
      '2021-01-01': 18586956, '2022-01-01': 18916244, '2024-01-01': 19586163, '2024-12-31': 19803534,
    },
  },
  ETH: {
    unit: 'ETH',
    points: {
      '2015-08-08': 72307863, '2016-01-01': 76166279, '2018-01-01': 96712859, '2021-01-01': 114093438,
      '2022-01-01': 118049178, '2024-01-01': 120187795, '2024-12-31': 120471971,
    },
  },
  XRP: {
    unit: 'XRP',
    // 流通量口径（不再混用 1000 亿总量）。逐点 = CMC 历史快照 `Circulating Supply` 的实读值。
    // ⚠️ 2014 下半年 CMC 改过 XRP 口径（8 月 8.25B → 10 月 28.99B），这条台阶是来源本身的，不是插值误差。
    points: {
      '2014-08-14': 8252600677, '2014-10-05': 28989252282, '2015-08-09': 31908551587,
      '2016-08-14': 35558046921, '2017-01-01': 36337298649, '2018-08-12': 39299874590,
      '2020-08-09': 44862646997, '2021-01-03': 45404028640, '2024-08-11': 56104361423,
      '2024-12-31': 57900000000,
    },
  },
  DOGE: {
    unit: 'DOGE',
    // 2014 年内从 190 亿冲到 895 亿（初期高奖励挖矿），此后才降到 +52.6 亿/年 ⇒ 逐年锚点不能省。
    points: {
      '2014-01-21': 33322735360, '2015-01-01': 97191116170, '2016-01-01': 102438605652,
      '2017-01-01': 107493315652, '2018-01-01': 112532135652, '2021-01-01': 127649065504,
      '2022-01-01': 132623305487, '2024-01-01': 142480185486, '2024-12-31': 147435315475,
    },
  },
  SOL: {
    unit: 'SOL',
    // ⚠️ `2021-01-01: 47,500,000` 是**史料推断的近似锚点**，无一手出处（SEC 仅证实 8M 起点与 429M / 483M 端点）。
    points: {
      '2020-08-11': 8200000, '2021-01-01': 47500000, '2024-01-01': 429000000, '2024-12-31': 483000000,
    },
  },
};

/* ══════════════════════════ probe ══════════════════════════ */

async function probe() {
  log('\n── 数据源可用区间探测 ─────────────────────────────');
  for (const c of COINS) {
    const line = [pad(c.sym, 6), pad(new Date(c.unlock).toISOString().slice(0, 10), 12)];
    if (c.src.bitstamp) {
      const url = `https://www.bitstamp.net/api/v2/ohlc/${c.src.bitstamp}/?step=3600&limit=5&start=${Math.floor(c.unlock / 1000)}`;
      const j = await getJSON(url, { label: 'bitstamp' }).catch(() => null);
      const rows = (j && j.data && j.data.ohlc) || [];
      line.push(pad(`bs=${rows.length ? new Date(Number(rows[0].timestamp) * 1000).toISOString().slice(0, 16) : '无'}`, 22));
      await sleep(300);
    } else line.push(pad('bs=-', 22));
    if (c.src.binance) {
      const url = `https://api.binance.com/api/v3/klines?symbol=${c.src.binance}&interval=1h&limit=5&startTime=${c.unlock}`;
      const rows = await getJSON(url, { label: 'binance' }).catch(() => null);
      line.push(`bn=${Array.isArray(rows) && rows.length ? new Date(Number(rows[0][0])).toISOString().slice(0, 16) : '无'}`);
      await sleep(300);
    } else line.push('bn=-');
    log('  ' + line.join('  '));
  }
  log('');
}

/* ══════════════════════════ 主流程 ══════════════════════════ */

async function main() {
  if (PROBE) return probe();

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  log(`\n游戏时间轴：${new Date(START_TS).toISOString()} → ${new Date(END_TS).toISOString()}`);
  log(`数据时间轴：${new Date(DATA_TS).toISOString()} → ${new Date(END_TS).toISOString()}`);
  log(`每小时一根：游戏窗 ${TOTAL_HOURS} 根，数据窗 ${DATA_HOURS} 根（多出的 ${PRE_HOURS} 根 = BTC 回溯段）\n`);

  const manifest = {
    v: 1,
    start: START_TS,
    end: END_TS,
    totalHours: TOTAL_HOURS,
    /* 数据窗比游戏窗早多少小时（0 = 没有回溯段）。**运行时不用它** ——
       负的小时序号由各币 `meta.start < start` 自然推出（`market.rangeOf`）；
       这里只是把「回溯段有多长」写清楚，免得日后误判数据包损坏。 */
    preHours: PRE_HOURS,
    encoding: 'gzip(int32le[o, h-o, l-o, c-o] × count ＋ uint8 成交量份额 × count)',
    coins: {},
  };

  let sumRaw = 0, sumZip = 0;
  const liqPerCoin = {};              // sym -> Float32Array（日流动性）
  const anchorDayOf = {};             // sym -> 锚定日（**数据窗**天序号），写清单用

  for (const coin of COINS) {
    if (ONLY && !ONLY.has(coin.sym)) continue;
    log(`▸ ${coin.sym} ${coin.name}`);
    const t0 = Date.now();
    const { startI, count, held, dayUsd, stats } = await buildCoin(coin);

    let maxPrice = 0;
    for (let k = 0; k < count; k++) {
      const h = held[k * 5 + 1];
      if (h > maxPrice) maxPrice = h;
    }
    const scale = chooseScale(maxPrice);

    const raw = encodeCoin(held, count, scale, dayUsd, startI);
    const zip = gzipSync(raw, { level: 9 });
    writeFileSync(join(OUT_DIR, `${coin.sym}.bin`), zip);

    manifest.coins[coin.sym] = {
      name: coin.name,
      file: `${coin.sym}.bin`,
      start: tsOf(startI),
      count,
      scale,
      /* 尾部还有 count 个字节的成交量份额（0~255 ＝ 该小时占当日成交额的比例 ×255）——
         运行时按 `count*16` 偏移切开；见文件头与 `encodeCoin()`。 */
      vol: true,
      maxPrice: Number(maxPrice.toFixed(8)),
      first: +held[3].toFixed(8),
      last: +held[(count - 1) * 5 + 3].toFixed(8),
      bytes: raw.length,
      zipped: zip.length,
      sources: {
        hourly: stats.hourly,
        gapHours: stats.gapHours,
        gapRanges: stats.gapRanges.map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()]),
        detail: Object.fromEntries(stats.bySource),
      },
    };
    sumRaw += raw.length;
    sumZip += zip.length;

    /* 日流动性：把这一币的逐日真实成交额折算成 liq（年均落在锚上，年内形状全真） */
    const firstDay = Math.floor(startI / 24);
    /* 锚定日 = 「游戏开局那天」与「该币首日」里**较晚**的那个 —— BTC 的覆盖起点在 2012，
       锚仍锚在 2013（见 `buildLiqDaily` 的注释）；其余币首日本来就晚于开局，两者相同。 */
    const anchorDay = Math.max(PRE_DAYS, firstDay);
    anchorDayOf[coin.sym] = anchorDay;
    const L = buildLiqDaily(coin.sym, dayUsd, firstDay, anchorDay);
    liqPerCoin[coin.sym] = L.liq;
    const yFirst = L.firstYear;
    log(`  日流动性：首年 ${yFirst} 锚 $${L.anchorEarly.toLocaleString()} ／ 2024 锚 $${L.anchorLate.toLocaleString()}`
      + ` ｜ 实测年均 首年 $${Math.round(L.mean[yFirst]).toLocaleString()}`
      + ` ／ 2024 $${Math.round(L.mean[2024]).toLocaleString()}`
      + ` ｜ 年内同形 加权 ${L.corr.mean.toFixed(3)} ／ 最差年 ${L.corr.worst.toFixed(3)}`);

    // 把这一条时间轴的美元序列留给后面的币 —— BTC 计价的小时线要靠它换回美元
    PRICE.set(coin.sym, ms => {
      const i = idxOf(ms);
      const k = i - startI;
      if (!Number.isInteger(i) || k < 0 || k >= count) return null;
      return held[k * 5 + 3];
    });

    const pct = (n) => (n / count * 100).toFixed(1) + '%';
    log(`  ${count} 根 ｜ 真小时线 ${pct(stats.hourly)} ｜ 无成交桥接 ${stats.gapHours} 根`);
    log(`  ${(raw.length / 1048576).toFixed(2)}MB → gzip ${(zip.length / 1048576).toFixed(2)}MB ｜ scale 1e${Math.log10(scale)} ｜ ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const [a, b] of stats.gapRanges) {
      log(`    ⚠️ 无成交小时：${new Date(a).toISOString().slice(0, 16)} → ${new Date(b).toISOString().slice(0, 16)}`);
    }
    // 每抓完一个币就把清单落盘：整条管线要跑很久，中途断了也不至于把前面的成果全丢掉。
    writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(manifest, null, 2));
    log('');
  }

  log(`──────────────────────────────────────────────`);
  log(`合计：未压缩 ${(sumRaw / 1048576).toFixed(2)}MB → gzip ${(sumZip / 1048576).toFixed(2)}MB`);

  /* ── 日流动性落盘（liq.bin）＋ 清单里的锚与流通量表 ── */
  const liqRaw = encodeLiq(liqPerCoin);
  const liqZip = gzipSync(liqRaw, { level: 9 });
  writeFileSync(join(OUT_DIR, 'liq.bin'), liqZip);

  // 每个币的「第一根真 K 线」所在天 —— **游戏窗**天序号（自 2013-01-01 起算，BTC 为负），
  // 与 `liq.bin` 自己的轴（数据窗，天 0 = 2012-09-27）差 `preDays`。纯信息字段、运行时不读。
  // `firstYear` 取的是**锚定日**所在的年：BTC 覆盖起点在 2012，锚仍锚在 2013（见 `buildLiqDaily`）。
  const coinStartDay = {};
  for (const c of COINS) {
    const m = manifest.coins[c.sym];
    if (m) coinStartDay[c.sym] = Math.floor(Math.round((m.start - START_TS) / HOUR_MS) / 24);
  }
  manifest.liq = {
    file: 'liq.bin',
    // 币序 = COINS 顺序；每个币连续 TOTAL_DAYS 个 Float32LE（美元/天），未上线日为 0
    encoding: `gzip(float32le × ${TOTAL_DAYS} × ${COINS.length})`,
    start: START_TS,
    days: TOTAL_DAYS,
    /* liq 的「天 0」比游戏开局早几天 —— 运行时 `liqOf` 靠它把 `dayIndexOf(s.i)` 平移过来
       （轴是数据窗口，2026-09-30）。**忘了它，2013 之后的流动性会整体错位 96 天。** */
    preDays: PRE_DAYS,
    order: COINS.map(c => c.sym),
    anchors: Object.fromEntries(COINS.map(c => [c.sym, LIQ_ANCHORS[c.sym]])),
    firstYear: Object.fromEntries(COINS.map(c => [c.sym, yearOfDay(anchorDayOf[c.sym])])),
    smoothing: null,   // 不做平滑（2026-09-29 定案）：年内形状 = 真实成交额的等比缩放，同形度恒 1.000
    firstDay: coinStartDay,
    bytes: liqRaw.length,
    zipped: liqZip.length,
  };
  manifest.circulating = CIRCULATING;
  writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(manifest, null, 2));

  log(`日流动性：${(liqRaw.length / 1024).toFixed(0)}KB → gzip ${(liqZip.length / 1024).toFixed(0)}KB（${TOTAL_DAYS} 天 × ${COINS.length} 币）`);
  log(`清单：public/${DATA_DIR}/index.json\n`);
}

main().catch(err => { console.error('\n抓数失败：', err); process.exit(1); });
