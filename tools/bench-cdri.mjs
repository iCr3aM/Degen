/**
 * CDRI 隐藏基准校准（2026-10-04）—— 拿本作引擎的衍生品风险读数去对现实。
 * ===============================================================
 * 目的（用户原话）：「先放入游戏内，但不加入游戏内显示，用于测试我们的游戏基准是否接近现实」。
 * 本脚本是那枚**只读基准**（`god.CDRI` ＋ `engine.cdriOf`）的第二把尺子：跑一遍历史，
 * 把 5 项输入的**游戏分布**与**现实基准区间**并排打出来，逐项判「在/不在量级内」。
 *
 * 三条纪律（与 `sim-audit.mjs` 同）：
 *   ① **只读**：不写 dist、不改任何源文件 —— 只 import 引擎 + 数据包。
 *   ② 走**真实数据包**（public/data）＋ 真实引擎（src/core），不 mock。
 *   ③ 24h 清算**独立测量**：引擎没有 24h 清算台账（加了要动存档 `STATE_VERSION`）⇒
 *      这里在**脚本自己的循环**里用可观测的公开量 `s.stat.liqNotional` 的**逐时差分**累计
 *      24 小时滚动强平额（`s.stat.liqNotional` 是强平名义的**累计**，口径与 Coinglass 公告一致：
 *      **只含强平、不含自愿止损波**；§17.3（2026-10-04）起**同时含 NPC 侧与玩家自身**的强平），
 *      再除以当时的 OI。
 *      ⚠️ 本脚本**不替玩家下单** ⇒ 运行时玩家侧贡献恒为 0，读数即「市场级（NPC）清算强度」。
 *
 * 现实基准（来源：coinglass.com/learn/cdri-zh ／ Amberdata《Leverage & Liquidations》
 *           ／ K33 ／ CoinGlass 2025 半年报）：
 *   · CDRI：0–100，四档 0–30 低 / 30–60 中性 / 60–80 高 / 80–100 极端。
 *   · OI÷24h 成交额：BTC OI $30–70B ÷ 24h 成交 $30–60B ⇒ **0.5–2**。
 *   · 资金费率：中性 0.01%/8h；常态 |0.005–0.05%|；偏拥挤 ≥0.0137%；极端峰值 0.0273%；上限 0.75%。
 *   · 平均杠杆：散户常态 **3–10x**，>20x 拥挤（BitMEX 被强平账户均 58x 是极端子集）。
 *   · 多空比：Binance 散户多头占比常态 **44–71%**。
 *   · 已实现波动率：BTC 年化常态 **30–120%**，中位 50–60%。
 *   · 24h 清算强度（清算额/OI）：常态 <1%；偏高 1–2%；级联 >5%（2025-10-10 = 4.82%）。
 *
 * 运行：node tools/bench-cdri.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/* ── fetch 打桩：把 Vite 的 `./data/...` 重定向到本地 `public/data/...`（同 sim-audit） ── */
const origFetch = globalThis.fetch;
globalThis.fetch = async (u) => {
  const s0 = String(u);
  if (/^https?:/i.test(s0)) return origFetch(u);
  const rel = s0.replace(/^\.?\//, '');
  const p = path.join(ROOT, rel.startsWith('data/') ? path.join('public', rel) : rel);
  const buf = fs.readFileSync(p);
  return new Response(buf, { status: 200 });
};

const { createState } = await import('../src/core/state.js');
const engine = await import('../src/core/engine.js');
const market = await import('../src/core/market.js');
const god = await import('../src/core/god.js');
const { sigmaOf } = await import('../src/core/impact.js');

/* 「原始行情的**日收盘**年化 σ」—— 与 CDRI 的 vol 项（`dailySigma × √365`）**逐字同估计量 /
   同窗口**（`sigmaOf` 总体标准差、30 个日收益、`d×24+23` 的日收盘），唯一差别是读 `rawCloseAt`
   （**不含任何位移**）。用来把「显示 σ / 原始 σ」的**放大倍数**量出来 —— 与现实带来回比。 */
const rawDailyVolOf = (sym, i) => {
  const d = Math.floor(i / 24);
  if (d < 32) return NaN;
  const arr = [];
  for (let k = d - 31; k < d; k++) arr.push(market.rawCloseAt(sym, k * 24 + 23));
  return sigmaOf(arr) * Math.sqrt(365);
};

const SYMS = ['BTC', 'ETH', 'SOL', 'DOGE'];
const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '--');
const PS = [0.05, 0.25, 0.5, 0.75, 0.95];
const q = (arr, ps = PS) => {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return ps.map(() => NaN);
  return ps.map(p => a[Math.min(a.length - 1, Math.floor(p * a.length))]);
};

await market.loadManifest();
await market.loadLiq();   // ⚠️ 流动性锚：没有它 `liqOf` 恒 0 ⇒ NPC 不建仓、`reviewVolUsdOf` 全 NaN
for (const sy of SYMS) { try { await market.loadCoin(sy); } catch { /* 数据缺失的币跳过 */ } }

/**
 * 跑一个币的全程：逐小时 `advanceOneHour`，每 24 小时采样一次 `cdriOf`，
 * 并逐时累计 24h 滚动强平额。
 * ⚠️ 起跑点落在该币**数据起点**（早于解锁的小时没有行情，采样出来全中性、会污染分布）。
 * ⚠️ **`s.lev = 5` 是「开闸」而非「放大」**（2026-10-04 实测确认）：`cascadeMulOf(s)` 在两处
 *    生效 —— ① `stampede` 的**门**（`≤ 0` 就整条不发）；② 热度方程里给**玩家自己那一笔量**
 *    （`m.pv`）加料的倍率。本局**不交易 ⇒ `m.pv ≡ 0` ⇒ ②恒不生效**，所以 `lev` 只影响①这道门：
 *    默认（`lev=1` ⇒ 实物换手 ⇒ 0）时 NPC 级联整条不发（实测 0 次强平、年化波动率中位 0.70）；
 *    `lev>1` 时门打开（实测 `lev=5` 与 `lev=10` 结果**逐位相同**，因为②没量可放大）。
 *    取 `5` 只是「`min(lev/5,3)` 恰为 1」这个名义上的中性值，便于阅读；换成 2~∞ 结果不变。
 *    ⇒ 这份基准 = **「级联开着、但没有任何玩家冲击」的 12 年市场**。
 * ⚠️ `s.hintOn=false`：免掉「破产预警遮罩」把时钟停下（本局不交易、权益不会归零，只为稳妥）。
 */
async function run(sym) {
  const r = market.rangeOf(sym);
  if (!r) return null;
  const s = createState('classic');
  s.sym = sym;
  s.lev = 5;             // 中性解锁级联闸（倍率恰为 1）—— 见上面的注释
  s.hintOn = false;
  s.i = Math.max(0, r[0]);
  market.bindFactorSource((sy, j) => god.factorFor(s, sy, j));
  engine.tickMarket(s, sym);

  const samples = [];             // 每 24h 的 { v, band, parts }
  const liqRatios = [];           // 每 24h 的 { ratio, liq, oi }
  const ring = [];                // 最近 24 小时的强平额（滚动）
  let ringSum = 0, prevLiq = s.stat.liqNotional, hours = 0, liqHours = 0;

  while (s.i < s.endI - 1 && hours < 200000) {
    engine.advanceOneHour(s);
    hours++;
    if (s.over) break;
    const now = s.stat.liqNotional;
    const d = now - prevLiq; prevLiq = now;         // 本小时的强平名义（NPC 侧 ＋ 玩家侧；本脚本玩家侧恒 0）
    if (d > 0) liqHours++;
    ring.push(d); ringSum += d;
    if (ring.length > 24) ringSum -= ring.shift();

    if (s.i % 24 === 0) {
      const res = engine.cdriOf(s, sym);
      /* 原始行情波动率（**不含 NPC 位移**）—— 供下面 vol 项交叉核对：基准读的 `dailySigma` 含位移，
         而它才是「数据包历史行情本身」的量级。 */
      res.rv = engine.reviewVolOf(sym, s.i);
      res.rvDaily = rawDailyVolOf(sym, s.i);   // 同日收盘估计量下的**原始** σ（隔离位移层）
      samples.push({ i: s.i, ...res });
      const oi = engine.openInterestOf(s, sym);
      liqRatios.push({ i: s.i, ratio: oi > 0 ? ringSum / oi : NaN, liq: ringSum, oi });
    }
  }
  return { s, sym, samples, liqRatios, hours, liqHours };
}

/* ── 现实基准区间（逐项对照，判「在/不在量级内」看**中位数**） ── */
const REAL = [
  { key: 'oi',   lo: 0.5,    hi: 2.0,    d: 3, name: 'OI ÷ 24h 成交额', unit: '',   ref: '现实 0.5–2（BTC OI $30–70B ÷ 24h 成交 $30–60B）' },
  { key: 'fund', lo: 0.0067, hi: 0.0667, d: 5, name: '|资金费率| ÷ 上限', unit: '', ref: '现实 0.0067–0.0667（= 常态 |0.005–0.05%|/8h ÷ 0.75%；中性 0.01%=0.0133 · 极端峰值 0.0273%=0.0364 · 上限 0.75%=1）' },
  { key: 'lev',  lo: 3,      hi: 10,     d: 2, name: '名义加权平均杠杆', unit: 'x', ref: '现实 3–10x 常态；>20x 拥挤（被强平账户均 58x 是极端子集）' },
  { key: 'ls',   lo: 0.12,   hi: 0.42,   d: 3, name: '|散户多头占比−0.5|÷0.5', unit: '', ref: '现实 0.12–0.42（= |44%−50%|÷0.5 … |71%−50%|÷0.5；多头占比 44–71%）' },
  { key: 'vol',  lo: 0.30,   hi: 1.20,   d: 3, name: '年化已实现波动率', unit: '', ref: '现实 0.30–1.20（BTC 年化 30–120%，中位 50–60%）' },
];

console.log('\n════════ CDRI 隐藏基准校准（游戏引擎 vs 现实） ════════');
console.log(`CDRI 四档边界 ${JSON.stringify(god.CDRI.bands)} ｜ 权重 ${JSON.stringify(god.CDRI.w)}`);

const results = [];
for (const sym of SYMS) {
  if (!market.rangeOf(sym)) { console.log(`\n── ${sym}：无数据，跳过 ──`); continue; }
  const res = await run(sym);
  if (!res || !res.samples.length) { console.log(`\n── ${sym}：无采样，跳过 ──`); continue; }
  results.push(res);

  const { samples, liqRatios, hours, liqHours } = res;

  console.log(`\n${'═'.repeat(4)} ${sym} · ${samples.length} 个日采样 / ${hours} 小时 / 有强平的小时 ${liqHours} ${'═'.repeat(4)}`);

  /* ① 复合读数 v 与四档分布 */
  const vs = samples.map(x => x.v);
  const qv = q(vs);
  const bands = { low: 0, mid: 0, high: 0, extreme: 0 };
  for (const x of samples) bands[x.band]++;
  const bandPct = k => (bands[k] / samples.length * 100).toFixed(1);
  console.log(`  CDRI v：p05/p25/p50/p75/p95 = ${qv.map(x => f(x, 1)).join(' / ')}`);
  console.log(`  四档占比：低 ${bandPct('low')}% · 中 ${bandPct('mid')}% · 高 ${bandPct('high')}% · 极端 ${bandPct('extreme')}%`);

  /* ② 逐项：游戏分布 vs 现实区间 */
  console.log('  逐项（原始值分布 p05/p25/p50/p75/p95）：');
  for (const R of REAL) {
    const raws = samples.map(x => x.parts[R.key].raw);
    const scores = samples.map(x => x.parts[R.key].score);
    const missing = samples.filter(x => !x.parts[R.key].ok).length;
    const qr = q(raws), qs = q(scores, [0.5]);
    const med = qr[2];
    const inside = Number.isFinite(med) && med >= R.lo && med <= R.hi;
    console.log(`   · ${R.name.padEnd(22)} ${qr.map(x => f(x, R.d)).join(' / ')}${R.unit.padEnd(2)}` +
      `  中位分值 ${f(qs[0], 0)}  缺失 ${missing}/${samples.length}`);
    console.log(`     ${R.ref}`);
    console.log(`     ⇒ 中位数${inside ? ' **在**' : ' **不在**'}量级内`);
  }

  /* ②b vol 交叉核对：基准读的 `dailySigma`（**含 NPC 位移**）vs `reviewVolOf`（原始行情，**不含位移**）。
        级联开着时 `npcShock` 位移会顶高 σ ⇒ 前者偏高；后者才是数据包历史行情本身的量级，用来隔离成因。 */
  const rvq = q(samples.map(x => x.rv));
  console.log(`   · ${'年化波动率 · 原始行情'.padEnd(22)} ${rvq.map(x => f(x, 3)).join(' / ')}  （reviewVolOf，不含位移；现实 0.30–1.20）`);
  /* ②c **同估计量**的放大倍数：显示 σ（CDRI vol 项，读 `dailySigma` 含位移）vs 原始 σ
        （`rawDailyVolOf`，同一「日收盘」估计量、读 `rawCloseAt`）。倍数 ≈ 1 即「与真实行情同量级」。 */
  const dvq = q(samples.map(x => x.rvDaily));
  const medDisp = q(samples.map(x => x.parts.vol.raw), [0.5])[0];
  const medRaw = dvq[2];
  const amp = medRaw > 0 ? medDisp / medRaw : NaN;
  console.log(`   · ${'年化波动率 · 同日收盘原始'.padEnd(22)} ${dvq.map(x => f(x, 3)).join(' / ')}  （sigmaOf(rawCloseAt)，与显示 σ 同估计量）`);
  console.log(`     ⇒ 显示 σ ÷ 原始 σ（中位）= ${f(amp, 2)}×  ${Number.isFinite(amp) && amp <= 1.25 ? '**贴近现实**' : '**偏高**'}`);

  /* ③ 独立测量的 24h 清算强度（清算额 ÷ OI） */
  const ratios = liqRatios.map(x => x.ratio);
  const ge1 = ratios.filter(x => x >= 0.01).length;
  const ge2 = ratios.filter(x => x >= 0.02).length;
  const ge5 = ratios.filter(x => x >= 0.05).length;
  const nz = ratios.filter(x => x > 0).length;
  console.log(`  24h 清算强度（清算额 ÷ OI）：p05/p25/p50/p75/p95 = ` +
    q(ratios).map(x => f(x * 100, 3) + '%').join(' / '));
  console.log(`     非零日 ${nz}/${ratios.length} ｜ ≥1% ${ge1} 天 ｜ ≥2% ${ge2} 天 ｜ ≥5%（级联）${ge5} 天`);
  console.log(`     现实：常态 <1% · 偏高 1–2% · 级联 >5%（2025-10-10 = 4.82%）`);
  console.log(`     ⚠️ 本脚本不替玩家下单：liqNotional 的**玩家侧贡献恒为 0**，读数即 NPC 侧市场清算强度。`);
}

/* ── 总账 ── */
console.log(`\n${'═'.repeat(4)} 总账 ${'═'.repeat(4)}`);
console.log(`样本币种 ${results.length} 个 ｜ 采样点 ${results.reduce((a, r) => a + r.samples.length, 0)} 个`);
console.log('⚠️ 本脚本只读：不写 dist、不改任何源文件。');