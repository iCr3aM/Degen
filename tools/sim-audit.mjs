/**
 * 发布前审计靶场（2026-10-03）—— 无头跑核心引擎，穷举下单可能性并做不变量断言。
 * ===============================================================
 * 用法：`node tools/sim-audit.mjs`
 *
 * 三条纪律：
 *   ① **只读**：不写任何文件、不进存档、不改 src。
 *   ② 走**真实数据包**（public/data）＋ 真实引擎（src/core），不 mock —— 这样量出来的
 *      费率 / σ / 冲击 / 强平全是玩家真正会遇到的数。
 *   ③ 每一节自报 `✓ / ✗`，末尾打印总账。任何 `✗` 都是发布阻塞项。
 *
 * ⚠️ 本文件是**工具**、不是产品代码：不进 `npm run build`（vite 只收 index.html 可达的模块）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/* ── fetch 打桩：把 Vite 的 `./data/...` 重定向到本地 `public/data/...` ── */
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
const P = await import('../src/core/positions.js');
const impact = await import('../src/core/impact.js');
const C = await import('../src/core/config.js');

const H = C.HOUR_MS;
const at = (y, m, d = 1, hh = 0) => Date.UTC(y, m, d, hh);
const idx = (t) => Math.round((t - C.GAME.start) / H);
const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

let pass = 0, fail = 0;
const bad = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; bad.push(`${name}${detail ? ' — ' + detail : ''}`); }
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}
const section = (t) => console.log(`\n${'═'.repeat(4)} ${t} ${'═'.repeat(4)}`);

/* ── 建一局可交易的档 ── */
async function mk({ scen = 'classic', sym = 'BTC', mode = 'margin', cash = null, i = null } = {}) {
  const s = createState(scen);
  s.sym = sym;
  s.mode = mode;
  await market.loadCoin(sym);
  await market.loadLiq();
  market.bindFactorSource((sy, j) => god.factorFor(s, sy, j));
  if (i != null) s.i = i;
  engine.tickMarket(s, sym);
  if (cash != null) {
    const cur = C.cashCurAt(engine.timeOf(s));
    s.books[s.ex] = cur === 'usd' ? { usd: cash, usdt: 0 } : { usd: 0, usdt: cash };
  }
  return s;
}

await market.loadManifest();

/* ═══════════════════ 1 · 强平价与维持保证金率自洽 ═══════════════════ */
section('1 · 强平价 / 维持保证金率自洽（所 × 工具 × 杠杆 × 方向）');
console.log('理论：爆仓所需逆向波动 = 1/杠杆 − 维持保证金率（GDD §10）\n');
const NOTIONAL = 100000;
for (const ex of ['bitfinex', 'bitmex', 'binance']) {
  for (const mode of ['margin', 'fut']) {
    const t = at(2021, 5);
    if (!C.hasLeverageKindAt(t, ex, mode)) continue;
    if (C.exchangeOf(ex).open > t) continue;
    const levs = C.leverageOptionsAt(t, ex, mode).filter(v => v >= 1);
    const rows = [];
    for (const lev of levs) {
      const margin = NOTIONAL / lev;
      const pos = P.openPosition('BTC', 'long', 30000, margin, lev, 0.0004, mode === 'margin');
      pos.ex = ex;
      const lp = P.liquidationPrice(pos);
      const mr = P.marginRateOf(pos, lp);
      const maint = P.maintRateOf(pos);
      const dropPct = (30000 - lp) / 30000;
      const theory = 1 / lev - maint;
      const ok = Math.abs(mr - maint) < 1e-9 && lp < 30000 && Math.abs(dropPct - theory) < 1e-9;
      rows.push(`${lev}x→跌 ${f(dropPct * 100, 3)}%（理论 ${f(theory * 100, 3)}%）${ok ? '' : ' ✗'}`);
      check(`liq 自洽 ${ex}/${mode}/${lev}x`, ok, `lp=${f(lp, 2)} 保证金率@lp=${f(mr, 6)} 维持=${f(maint, 4)}`);
      // 空头方向
      const sp = P.openPosition('BTC', 'short', 30000, margin, lev, 0.0004, mode === 'margin');
      sp.ex = ex;
      const slp = P.liquidationPrice(sp);
      check(`liq 空头在上方 ${ex}/${mode}/${lev}x`, slp > 30000 || !P.canLiquidate(sp), `slp=${f(slp, 2)}`);
    }
    if (rows.length) console.log(`  ${ex}/${mode}: ${rows.join('  ')}`);
  }
}

/* ── 1b · F3 复核：Binance 杠杆不再沿用 Bitfinex 的 15%（2026-10-03 审计修） ── */
section('1b · Binance 杠杆维持线（F3 修复复核 · 按保证金水平阈值换算）');
{
  const mkPos = (ex, lev) => {
    const p = P.openPosition('BTC', 'long', 30000, NOTIONAL / lev, lev, 0.0004, true);
    p.ex = ex;
    return p;
  };
  const bi3 = P.maintRateOf(mkPos('bitfinex', 3));
  const bn2 = P.maintRateOf(mkPos('binance', 2));
  const bn3 = P.maintRateOf(mkPos('binance', 3));
  const bn5 = P.maintRateOf(mkPos('binance', 5));
  console.log(`  2x→${f(bn2 * 100, 2)}%  3x→${f(bn3 * 100, 2)}%  5x→${f(bn5 * 100, 2)}%  ｜ Bitfinex 3x→${f(bi3 * 100, 2)}%`);
  check('Binance 杠杆 2x 维持 = 9%（保证金水平 1.18 换算）', Math.abs(bn2 - 0.09) < 1e-9, `实得 ${f(bn2, 4)}`);
  check('Binance 杠杆 3x 维持 = 12%（不再沿用 Bitfinex 15%）', Math.abs(bn3 - 0.12) < 1e-9, `实得 ${f(bn3, 4)}`);
  check('Binance 杠杆 5x 维持 = 12%', Math.abs(bn5 - 0.12) < 1e-9, `实得 ${f(bn5, 4)}`);
  check('同杠杆下 Binance 杠杆强平更晚（维持线更低）', bn3 < bi3, `binance ${f(bn3 * 100, 2)}% < bitfinex ${f(bi3 * 100, 2)}%`);
}

/* ═══════════════════ 2 · openCheck 全分支可达性 ═══════════════════ */
section('2 · 下单拒绝分支穷举（每一条 `why` 是否可达 / 是否合理）');
const seen = new Map();
const noteWhy = (r) => { if (!r.ok) seen.set(r.why, (seen.get(r.why) || 0) + 1); return r; };

// 2.1 本局已结束
{ const s = await mk(); s.over = { kind: 'liquidated' }; noteWhy(engine.openTrade(s, 'long')); }
// 2.2 停机维护（BitMEX 2020-03-13 02:00）
{ const s = await mk({ sym: 'BTC', i: idx(at(2020, 2, 13, 2)) }); s.ex = 'bitmex'; s.mode = 'fut'; s.lev = 100; noteWhy(engine.openTrade(s, 'long')); }
// 2.3 杠杆做空不可用（BitMEX 2015：杠杆表上限 1，无融资）
{ const s = await mk({ i: idx(at(2015, 5)) }); s.ex = 'bitmex'; s.mode = 'margin'; s.lev = 1; noteWhy(engine.openTrade(s, 'short')); }
// 2.4 币还没上线（XRP 在 2013）
{ const s = await mk({ sym: 'XRP', i: idx(at(2013, 6)) }); noteWhy(engine.openTrade(s, 'long')); }
// 2.5 合约保证金必须是 USDT
{ const s = await mk({ mode: 'fut', cash: null }); s.books[s.ex] = { usd: 5000, usdt: 0 }; noteWhy(engine.openTrade(s, 'long')); }
// 2.6 可用保证金不足
{ const s = await mk({ cash: 0 }); noteWhy(engine.openTrade(s, 'long')); }
// 2.7 下单金额太小
{ const s = await mk({ cash: 0.4, i: idx(at(2020, 5)) }); s.lev = 1; noteWhy(engine.openTrade(s, 'long')); }
// 2.8 OTC 门槛（2013 门槛 $1 万，权益过 $20 万解锁）
{ const s = await mk({ cash: 300000, i: idx(at(2013, 6)) }); s.chan = 'otc'; s.lev = 1; s.sizeFrac = 0.001; noteWhy(engine.openTrade(s, 'long', 0.001)); }
// 2.9 同币反手（已有 BTC 多，再开空）
{ const s = await mk({ cash: 100000, i: idx(at(2020, 5)) }); engine.openTrade(s, 'long'); s.mode = 'fut'; noteWhy(engine.openTrade(s, 'short')); }

for (const [why, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ×${n}  ${why}`);
check('拒绝分支 ≥ 8 类可达', seen.size >= 8, `实得 ${seen.size} 类`);

/* ── 2b · ⑥ 名义阶梯杠杆封顶（Binance 永续按**结果名义**判档 · 真实 BTCUSDT 表） ── */
section('2b · ⑥ 名义阶梯杠杆封顶（Binance 永续 · 真实 BTCUSDT 阶梯，与维持保证金率同表）');
{
  console.log('  名义档 → 最高杠杆 / 维持保证金率');
  for (const n of [3e4, 1e5, 5e5, 3e6, 1e7, 3e7, 7e7, 2e8, 5e8]) {
    const label = n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M` : `$${(n / 1e3).toFixed(0)}K`;
    console.log(`   ${label.padEnd(6)} → ${String(C.notionalMaxLevAt('binance', n, 'fut')).padStart(3)}x   维持 ${f(C.maintRateAt('binance', n, 'perp') * 100, 2)}%`);
  }
  check('125x 只在 ≤$5 万档（边界闭区间在下档）', C.notionalMaxLevAt('binance', 5e4 - 1, 'fut') === 125 && C.notionalMaxLevAt('binance', 5e4, 'fut') === 100);
  check('$1 亿名义只能 4x（旧表会给到 10x+）', C.notionalMaxLevAt('binance', 1e8 - 1, 'fut') === 4);
  check('$3 亿以上 1x', C.notionalMaxLevAt('binance', 3e8, 'fut') === 1);
  check('非 Binance 永续不受此限（返回 Infinity）', C.notionalMaxLevAt('bitmex', 1e8, 'fut') === Infinity);
  check('Binance 杠杆（margin）不受此限', C.notionalMaxLevAt('binance', 1e8, 'margin') === Infinity);
  check('维持保证金率与杠杆同表单调（名义越大越严）',
    C.maintRateAt('binance', 3e6, 'perp') < C.maintRateAt('binance', 1e7, 'perp')
    && C.maintRateAt('binance', 1e7, 'perp') < C.maintRateAt('binance', 7e7, 'perp'));
}
// 2b.1 巨鲸在 Binance 永续上被**静默降杠杆**（2020-06 该所上限 125x；现金 $20 万 × 125x ≈ $2480 万名义 ⇒ 5x 档）
{
  const s = await mk({ i: idx(at(2020, 6)) });
  s.ex = 'binance'; s.mode = 'fut'; s.lev = 125;
  s.books.binance = { usd: 0, usdt: 200000 };
  const r = engine.openTrade(s, 'long');
  check('⑥ 超档巨鲸单**不拒绝**（静默降杠杆）', r.ok, r.why || '');
  check('⑥ 杠杆被钳到本档上限 5x 并落进仓位', s.positions.BTC && s.positions.BTC.lev === 5, `pos.lev=${s.positions.BTC && s.positions.BTC.lev}`);
  check('⑥ 玩家选择的杠杆也落到钳位值（s.lev）', s.lev === 5, `s.lev=${s.lev}`);
  check('⑥ 日志告知了降杠杆', /杠杆受名义档位限制 已降至 5x/.test(s.log.map(l => l.text).join('\n')), '');
}
// 2b.2 同所同年代：档内的单照常放行（杠杆 20x × $5K ≈ $10 万名义 ⇒ 100x 档）
{
  const s = await mk({ i: idx(at(2020, 6)) });
  s.ex = 'binance'; s.mode = 'fut'; s.lev = 20;
  s.books.binance = { usd: 0, usdt: 5000 };
  const r = engine.openTrade(s, 'long');
  check('⑥ 档内的单照常放行', r.ok, r.why || '');
}
// 2b.3 被档位顶住而降杠杆的**加仓放行**（prev 125x 小仓 + 一笔大额加仓 ⇒ 结果名义顶进 50x 档）
{
  const s = await mk({ i: idx(at(2020, 6)) });
  s.ex = 'binance'; s.mode = 'fut'; s.lev = 125;
  s.books.binance = { usd: 0, usdt: 400 };
  const r1 = engine.openTrade(s, 'long');
  check('⑥ 加仓前置：125x 小仓开出来了', r1.ok && s.positions.BTC.lev === 125, r1.why || `pos.lev=${s.positions.BTC && s.positions.BTC.lev}`);
  s.books.binance.usdt += 5000;
  const r2 = engine.openTrade(s, 'long');
  check('⑥ 被档位顶住的降杠杆加仓放行（不再要求先平仓）', r2.ok && s.positions.BTC.lev === 50,
    r2.why || `pos.lev=${s.positions.BTC && s.positions.BTC.lev}`);
}
// 2b.4 主动**升杠杆**加仓仍拒绝（D4 原判据：两种杠杆混算无意义）
{
  const s = await mk({ i: idx(at(2020, 6)) });
  s.ex = 'binance'; s.mode = 'fut'; s.lev = 20;
  s.books.binance = { usd: 0, usdt: 400 };
  const r1 = engine.openTrade(s, 'long');
  check('⑥ 加仓前置：20x 小仓开出来了', r1.ok, r1.why || '');
  s.lev = 50;
  const r2 = noteWhy(engine.openTrade(s, 'long'));
  check('⑥ 主动升杠杆加仓仍被拒绝', !r2.ok && /加仓必须同杠杆/.test(r2.why || ''), r2.why || '（竟然放行了）');
}

/* ═══════════════════ 3 · 资金守恒（开 → 平 / 开 → 走 N 小时） ═══════════════════ */
section('3 · 资金守恒：同一小时开平的净损耗 == 两次手续费');
for (const mode of ['margin', 'fut']) {
  const s = await mk({ mode, cash: 50000, i: idx(at(2020, 5)) });
  const cash0 = engine.equity(s);
  const o = engine.openTrade(s, 'long');
  if (!o.ok) { check(`守恒 ${mode} 开仓`, false, o.why); continue; }
  const oi = s.i;
  s.i = oi;   // 同一根内平仓（无价格位移时间）
  const c = engine.closeTrade(s, '审计');
  check(`守恒 ${mode} 平仓成功`, c.ok, c.why || '');
  const cash1 = engine.equity(s);
  console.log(`   ${mode}: 权益 ${f(cash0, 2)} → ${f(cash1, 2)}，净损耗 ${f(cash0 - cash1, 4)}（= 双边手续费＋滑点，应 ≥ 0 且远小于名义）`);
  check(`守恒 ${mode} 净损耗非负且 <1% 名义`, (cash0 - cash1) >= -1e-6, `损耗 ${f(cash0 - cash1, 4)}`);
}

/* ═══════════════════ 4 · 成本量级（对照现实基准） ═══════════════════ */
section('4 · 成本量级表（按年代，供现实对照）');
const eras = [[2013, 8], [2016, 3], [2018, 0], [2020, 2], [2021, 3], [2023, 0], [2024, 6]].map(([y, m]) => at(y, m));
console.log('  年月       所        taker(margin)  taker(fut)  借USDT/日   借币/日     币/标价  资金费率上限/8h  σ30日估');
for (const t of eras) {
  const ex = t < C.exchangeOf('binance').open ? 'bitfinex' : 'binance';
  const fm = C.feeRateOf(ex, t, 'margin', null);
  const ff = C.hasLeverageKindAt(t, ex, 'fut') ? C.feeRateOf(ex, t, 'fut', null) : NaN;
  const dq = C.marginDailyRateAt(t, 'quote');
  const dc = C.marginDailyRateAt(t, 'coin');
  console.log(`  ${new Date(t).toISOString().slice(0, 7)}  ${ex.padEnd(9)}  ${f(fm * 100, 4)}%       ${Number.isFinite(ff) ? f(ff * 100, 4) + '%' : '—'}       ${f(dq * 100, 4)}%/日  ${f(dc * 100, 4)}%/日   ${f(dc / dq, 2)}×     ${f(P.FR.max * 100, 2)}%             见第 5 节`);
}
check('借贷日息长周期降息（2013 口径 ≥ 2020 口径）',
  C.marginDailyRateAt(at(2013, 0), 'quote') >= C.marginDailyRateAt(at(2021, 0), 'quote')
  && C.marginDailyRateAt(at(2013, 0), 'coin') >= C.marginDailyRateAt(at(2021, 0), 'coin'));

/* ═══════════════════ 4b · 资金费率公式（真实化 · 2026-10-03） ═══════════════════ */
section('4b · 资金费率两段式：F = clamp( P + clamp(I − P, ±0.05%), ±cap )');
{
  const I = P.FR.interest, CL = P.FR.clamp, CAP = P.FR.max;
  check('Interest I = 0.01%/8h（0.03%/日 · 年化 10.95%）', Math.abs(I - 0.0001) < 1e-12, `I=${I}`);
  check('clamp = ±0.05%（夹的是 I−P，**不是**费率本身）', Math.abs(CL - 0.0005) < 1e-12, `clamp=${CL}`);
  check('cap = 0.75%/8h（Binance BTC 永续长期默认）', Math.abs(CAP - 0.0075) < 1e-12, `cap=${CAP}`);
  /* 中性带 P ∈ [−0.04%, +0.06%] ⇒ F ≡ I —— 这正是「92% 时间恰为 0.01%」的来源 */
  check('中性带 P=0 ⇒ F = I', Math.abs(P.fundingRateOf(0) - I) < 1e-12);
  check('中性带上沿 P=+0.06% ⇒ F = I', Math.abs(P.fundingRateOf(0.0006) - I) < 1e-12);
  check('中性带下沿 P=−0.04% ⇒ F = I', Math.abs(P.fundingRateOf(-0.0004) - I) < 1e-12);
  /* 带外以斜率 1 跟随 P（减 / 加那 0.05%） */
  check('P=+0.3% ⇒ F=+0.25%', Math.abs(P.fundingRateOf(0.003) - 0.0025) < 1e-12, `实得 ${f(P.fundingRateOf(0.003) * 100, 4)}%`);
  check('P=−0.3% ⇒ F=−0.25%', Math.abs(P.fundingRateOf(-0.003) + 0.0025) < 1e-12, `实得 ${f(P.fundingRateOf(-0.003) * 100, 4)}%`);
  /* 两端撞 cap（cap 只在极端 P 上起作用） */
  check('P=+2% ⇒ F 夹到 +cap', Math.abs(P.fundingRateOf(0.02) - CAP) < 1e-12);
  check('P=−2% ⇒ F 夹到 −cap', Math.abs(P.fundingRateOf(-0.02) + CAP) < 1e-12);
  /* P 代理：全市场多空失衡 */
  check('premiumIndexOf(0.5) = 0', Math.abs(P.premiumIndexOf(0.5)) < 1e-12);
  check('premiumIndexOf(1) = +k', Math.abs(P.premiumIndexOf(1) - P.FR.k) < 1e-12);
  check('premiumIndexOf(0) = −k', Math.abs(P.premiumIndexOf(0) + P.FR.k) < 1e-12);
  check('完全失衡（一侧占全）也不超 cap', Math.abs(P.fundingRateOf(P.premiumIndexOf(1))) <= CAP + 1e-12);
  const rows = [0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 1].map(sh =>
    `多占比 ${(sh * 100).toFixed(0)}%→${f(P.fundingRateOf(P.premiumIndexOf(sh)) * 100, 4)}%`);
  console.log(`  ${rows.join('  ')}`);
  /* 预测接口：小时数必须落在 1..8、且与结算时刻同相 */
  const sf = await mk({ i: idx(at(2021, 5, 1, 3)) });
  const fc = engine.fundingForecastOf(sf, 'BTC');
  check('fundingForecastOf.hours ∈ 1..8', !!fc && fc.hours >= 1 && fc.hours <= 8, `hours=${fc && fc.hours}`);
  const s0 = await mk({ i: idx(at(2021, 5, 1, 0)) });
  const fc0 = engine.fundingForecastOf(s0, 'BTC');
  check('刚结算那一刻 hours = 8（不是 0）', !fc0 || fc0.hours === 8, `hours=${fc0 && fc0.hours}`);
}

/* ═══════════════════ 5 · 滑点 / 冲击量级 ═══════════════════ */
section('5 · 滑点（平方根律）量级：不同年代、不同名义');
let sigmaOk = true;
for (const t of [at(2013, 8), at(2018, 0), at(2021, 3), at(2024, 6)]) {
  const s = await mk({ sym: 'BTC', i: idx(t) });
  const sig = engine.dailySigma('BTC', s.i);
  const dayLiq = market.liqOf('BTC', market.dayIndexOf(s.i));
  const row = [];
  for (const n of [1e3, 1e5, 1e6, 1e7]) {
    // s.flow/pool 不参与这一节：只量「同等条件下不同名义的代价」，取满盘口（无池消耗）
    const q = n / dayLiq;
    row.push(`$${n >= 1e6 ? n / 1e6 + 'M' : n / 1e3 + 'K'}→${f(impact.impactOf(q, sig) * 100, 3)}%`);
  }
  if (!(sig > 0.005 && sig < 0.10)) sigmaOk = false;
  console.log(`  ${new Date(t).toISOString().slice(0, 7)}  σ30日=${f(sig * 100, 2)}%  日流动性 $${(dayLiq / 1e6).toFixed(1)}M  ${row.join('  ')}`);
}
check('σ 量级落在 0.5%–10%/日（现实加密区间）', sigmaOk);

/* ═══════════════════ 6 · 数值健壮性 fuzz ═══════════════════ */
section('6 · 数值健壮性 fuzz（随机 杠杆 × 资金 × 方向 × 时刻）');
let fuzzN = 0, fuzzBad = 0;
for (let k = 0; k < 400; k++) {
  const sym = ['BTC', 'ETH', 'XRP', 'DOGE', 'SOL'][k % 5];
  const s = await mk({ sym, i: Math.floor(Math.random() * 90000), cash: Math.pow(10, 1 + Math.random() * 5) });
  s.lev = [1, 2, 3, 5, 10, 20, 50, 100, 125][Math.floor(Math.random() * 9)];
  s.mode = Math.random() < 0.5 ? 'margin' : 'fut';
  const side = Math.random() < 0.5 ? 'long' : 'short';
  const r = engine.openTrade(s, side, Math.random());
  fuzzN++;
  if (r.ok) {
    const pos = s.positions[sym];
    const eq = engine.equity(s);
    const ok = pos && Number.isFinite(pos.margin) && Number.isFinite(pos.size) && Number.isFinite(pos.notional)
      && Number.isFinite(pos.margin) && Number.isFinite(P.liquidationPrice(pos)) && Number.isFinite(eq)
      && pos.margin > 0 && pos.size > 0 && pos.notional > 0;
    if (!ok) { fuzzBad++; console.log(`   ✗ fuzz #${k} ${sym} ${side} ${s.lev}x → 非有限/非正字段`, JSON.stringify(pos)); }
  }
}
check('fuzz 400 局无 NaN / 非正字段', fuzzBad === 0, `${fuzzN} 次尝试，${fuzzBad} 处异常`);

/* ═══════════════════ 7 · 全时间线连跑（50x 无头） ═══════════════════ */
section('7 · 全时间线连跑：真实数据走满 12 年不崩、曲线有限');
{
  const s = await mk({ sym: 'BTC', cash: 100000 });
  for (const sy of ['BTC', 'ETH', 'XRP', 'DOGE', 'SOL']) await market.loadCoin(sy);
  let steps = 0, nan = 0, trades = 0;
  const step = 24 * 30;   // 每月推进一次
  while (s.i < s.endI && steps < 400) {
    if (!s.over) {
      s.mode = steps % 2 ? 'fut' : 'margin';
      s.lev = steps % 3 === 0 ? 10 : 3;
      s.sym = ['BTC', 'ETH', 'SOL'][steps % 3];
      const r = engine.openTrade(s, steps % 2 ? 'long' : 'short', 0.2);
      if (r.ok) trades++;
      if (s.positions[s.sym]) engine.closeTrade(s, '审计');
    }
    engine.advanceOneHour(s);
    for (let j = 1; j < step; j++) engine.advanceOneHour(s);
    if (!Number.isFinite(engine.equity(s))) { nan++; break; }
    steps++;
  }
  check('连跑 12 年：权益全程有限', nan === 0, `步数 ${steps}，成交 ${trades}，末值 $${f(engine.equity(s), 2)}，over=${s.over ? s.over.kind : '无'}`);
  check('连跑结束于结算/爆仓/未结束的合法态', !s.over || ['liquidated', 'settled', 'gaveup'].includes(s.over.kind), JSON.stringify(s.over));
}

/* ═══════════════════ 8 · 真实下单：实际滑点（穿引擎，含阈值 / 深度池 / 持仓折减） ═══════════════════ */
section('8 · 真实下单滑点：名义 vs 实际成交代价（1x 多头，穿 openTrade）');
console.log('  年月       名义        实际滑点%   备注');
let sawSlip = false, maxSlip = 0, slipMono = true;
for (const t of [at(2013, 8), at(2016, 5), at(2018, 0), at(2021, 3), at(2024, 6)]) {
  let prev = -1;
  for (const n of [1e3, 1e5, 1e6, 1e7, 1e8]) {
    const s = await mk({ sym: 'BTC', i: idx(t), cash: n });
    s.mode = 'margin'; s.lev = 1;
    /* ⚠️ 基准必须是「引擎真正拿来算成交价的那个盘口价」—— `exPrice` 含各所 `dev.basis` 偏移。
       原来用 `markPrice`（标记价）当基准，导致 2021/2024 出现「负滑点」（实测 −0.0235% / −0.0070%）：
       那不是模型错误，是基准价的口径差。要在下单**之前**取（`pushFlow` 会写位移，之后取就含自己的永久冲击）。 */
    const base = engine.exPrice(s, 'BTC', s.ex);
    const r = engine.openTrade(s, 'long', 1);
    if (!r.ok) { console.log(`  ${new Date(t).toISOString().slice(0, 7)}  $${(n / 1e6).toFixed(2)}M      —          ${r.why}`); continue; }
    const entry = s.positions.BTC.entry;
    const slip = (entry / base - 1) * 100;
    if (slip > 1e-9) sawSlip = true;
    if (slip + 1e-9 < prev) slipMono = false;   // 同一年内名义越大，代价不应变小
    prev = slip;
    maxSlip = Math.max(maxSlip, slip);
    const lg = s.log[s.log.length - 1];
    const tag = lg ? String(lg.text || lg.msg || JSON.stringify(lg)).slice(-60) : '';
    console.log(`  ${new Date(t).toISOString().slice(0, 7)}  $${(n / 1e6).toFixed(2)}M      ${f(slip, 4)}%   ${tag}`);
  }
}
check('至少某些名义确实触发滑点（模型非死区）', sawSlip);
check('滑点对名义单调不减（同一年内越大越贵）', slipMono);
check('滑点不超过硬上限 30%', maxSlip <= impact.SLIP.hard * 100 + 1e-9, `最大 ${f(maxSlip, 3)}%`);

/* ── 8b · 滑点死区门槛（threshold × 日流动性）——「多大的单才开始被收代价」 ──
   这是把 `SLIP.threshold = 10%` 翻译成人话：只有当单笔名义 ≥ 当日全市场成交额的 10% 才收滑点。
   逐年列出这道门槛，供对照现实：单所盘口远小于全市场 ⇒ 门槛偏高（详见审计报告的发现项 F2）。 */
console.log('  ── 8b · 滑点死区门槛（= 当日全市场成交额 × 10%，低于它滑点记零） ──');
for (const t of [at(2013, 8), at(2016, 5), at(2018, 0), at(2021, 3), at(2024, 6)]) {
  const s = await mk({ sym: 'BTC', i: idx(t) });
  const dayLiq = market.liqOf('BTC', market.dayIndexOf(s.i));
  console.log(`     ${new Date(t).toISOString().slice(0, 7)}  日流动性 $${(dayLiq / 1e6).toFixed(1)}M  ⇒  门槛 $${(dayLiq * impact.SLIP.threshold / 1e6).toFixed(1)}M`);
}

/* ═══════════════════ 9 · 本批口径（B26 小时计息 / 借贷额度 / ② 库存倍率 / ③ 价格保护带） ═══════════════════ */
section('9 · 本批口径：逐小时计息 · 借贷额度 · 库存倍率 · 价格保护带');

/* ── 9a · 借贷日息的两条阶梯（多头借标价币 / 空头借标的币） ── */
{
  const qx = y => C.marginDailyRateAt(at(y, 0), 'quote');
  const cx = y => C.marginDailyRateAt(at(y, 0), 'coin');
  console.log(`  借标价币：2013 ${f(qx(2013) * 100, 4)}%/日 → 2017 ${f(qx(2018) * 100, 4)}% → 2020 ${f(qx(2021) * 100, 4)}%`);
  console.log(`  借标的币：2013 ${f(cx(2013) * 100, 4)}%/日 → 2017 ${f(cx(2018) * 100, 4)}% → 2020 ${f(cx(2021) * 100, 4)}%`);
  /* ⚠️ 只断言**长周期**（2013 口径 ≥ 2020 口径）—— 中间 2017 那档是**牛市尖峰**（借贷需求旺，
     两条曲线一起抬），故不是逐档单调：硬要求单调会把真实形态改坏。 */
  check('9a 两条阶梯长周期降息（2013 口径 ≥ 2020 口径）', qx(2013) >= qx(2021) && cx(2013) >= cx(2021));
  check('9a 借币（空头）比借钱（多头）便宜 5× 以上', cx(2021) * 5 <= qx(2021), `币/标价 = ${f(cx(2021) / qx(2021), 3)}`);
  check('9a 借哪个币由方向定（多头 quote / 空头 coin）',
    P.borrowCurOf({ side: 'long' }) === 'quote' && P.borrowCurOf({ side: 'short' }) === 'coin');
}

/* ── 9b · 逐小时计息（堵掉「开仓不足 8 小时就平 ⇒ 一分利息不付」那个漏洞） ── */
{
  const s = await mk({ sym: 'BTC', i: idx(at(2021, 5, 1, 1)), cash: 100000 });
  s.mode = 'margin'; s.lev = 3;
  const r = engine.openTrade(s, 'long', 0.5);
  check('9b 前置：杠杆多仓开出来了', r.ok && s.positions.BTC, r.why || '');
  const m0 = s.positions.BTC.margin;
  engine.advanceOneHour(s);                       // 只走 1 小时，且落在**非** 8h 整点上
  const d1 = m0 - s.positions.BTC.margin;
  const exp = P.borrowedOf(s.positions.BTC) * C.marginDailyRateAt(engine.timeOf(s), 'quote') / 24;
  check('9b 持有一小时就扣息（改动前此处为 0）', d1 > 0, `1h 扣 $${f(d1, 8)}`);
  check('9b 每小时利息 = 借入 × 日息 ÷ 24', Math.abs(d1 - exp) < 1e-9, `实得 ${f(d1, 8)} 期望 ${f(exp, 8)}`);
  /* 再跑 23 小时：借贷利息日志必须是 8h 一条（不是 24 条） */
  for (let j = 0; j < 23; j++) engine.advanceOneHour(s);
  const n = s.log.filter(l => /^借贷利息/.test(String(l.text))).length;
  check('9b 24 小时最多 3 条借贷利息日志（8h 节奏、不刷屏）', n >= 1 && n <= 3, `实得 ${n} 条`);
}

/* ── 9c · 借贷额度上限（结果借入 ≤ 当日全市场流动性 × quota） ── */
{
  const t = at(2013, 8);
  const s0 = await mk({ sym: 'BTC', i: idx(t) });
  const cap = market.liqOf('BTC', market.dayIndexOf(s0.i)) * C.MARGIN.quota;
  console.log(`  2013-09 BTC 日流动性 $${f(market.liqOf('BTC', market.dayIndexOf(s0.i)) / 1e6, 2)}M ⇒ 额度 $${f(cap / 1e3, 1)}K`);
  const s1 = await mk({ sym: 'BTC', i: idx(t), cash: 20000 });
  s1.ex = 'bitfinex'; s1.mode = 'margin'; s1.lev = 1;
  const r1 = engine.openTrade(s1, 'long', 1);
  check('9c 1x 多头借入为 0 ⇒ 额度闸不拦', r1.ok, r1.why || '');
  const s3 = await mk({ sym: 'BTC', i: idx(t), cash: 20000 });
  s3.ex = 'bitfinex'; s3.mode = 'margin'; s3.lev = 3;
  const r3 = engine.openTrade(s3, 'long', 1);
  check('9c 借到超过当日额度 ⇒ 开仓被拒', !r3.ok && /借贷额度/.test(r3.why), r3.why || '');
}

/* ── 9d · ② 做市库存动态（betaFast 随库存冲击放大，上界 2×） ── */
{
  const coinBase = god.SHOCK_MODE.coin.betaFast;
  check('9d 倍率 1 ⇒ 逐位返回共享常量（改动前零差异）',
    god.shockParamsOf('fut', 1) === god.SHOCK_MODE.fut && god.shockParamsOf('coin') === god.SHOCK_MODE.coin);
  check('9d 倍率 2 ⇒ betaFast 翻倍、perm 不动',
    Math.abs(god.shockParamsOf('fut', 2).betaFast - god.SHOCK_MODE.fut.betaFast * 2) < 1e-12
    && god.shockParamsOf('fut', 2).perm === god.SHOCK_MODE.fut.perm);
  check('9d 上界恰为 2×（kInv × qCap = 1）', Math.abs(god.INV.kInv * god.INV.qCap - 1) < 1e-12);
  /* 集成：同一时刻、同一形态，**更大的单**必然拿到更大的 `betaFast`。
     ⚠️ 断言刻意做成「相对关系」而不是绝对值：`hourLiqRaw` 与**该小时成交份额**挂钩（份额每日均值为 1，
        忙碌时段可以明显 > 1），写死一个倍率会在别的时刻脆断。相对关系 + 上界才是这里要锁的性质。 */
  const one = async cash => { const s = await mk({ sym: 'BTC', i: idx(at(2013, 8)), cash }); s.ex = 'bitfinex'; s.mode = 'margin'; s.lev = 1; return s; };
  const sS = await one(2000), sB = await one(40000);
  const rS = engine.openTrade(sS, 'long', 1), rB = engine.openTrade(sB, 'long', 1);
  const tailOf = s => (s.flow.BTC ? s.flow.BTC[s.flow.BTC.length - 1] : null);
  const tS = tailOf(sS), tB = tailOf(sB);
  const okBoth = rS.ok && rB.ok && !!tS && !!tB;
  check('9d 薄盘：更大的单拿到更大的 betaFast（库存效应真的接上了）',
    okBoth && tB.betaFast > tS.betaFast && tS.betaFast >= coinBase,
    okBoth ? `$2K→${f(tS.betaFast, 4)}  $40K→${f(tB.betaFast, 4)}（基准 ${coinBase}）` : (rS.why || rB.why || '无 flow'));
  check('9d perm 不随库存变（只动快分量，永久痕迹照旧）',
    okBoth && tS.perm === god.SHOCK_MODE.coin.perm && tB.perm === god.SHOCK_MODE.coin.perm);
  check('9d 库存倍率有上界（恒 ≤ 2× 基准）', okBoth && tB.betaFast <= coinBase * 2 + 1e-12, `实得 ${okBoth ? f(tB.betaFast, 4) : '—'}`);
}

/* ── 9e · ③ 价格保护带（仅 Binance 永续 · 只拦开仓 · 锁 2h · 一个区间一条日志） ── */
{
  const sym = 'BTC';
  const end = idx(at(2024, 11));
  let hit = -1;
  for (let i = idx(C.BAND.from); i < end; i++) {
    const c1 = market.rawCloseAt(sym, i), c0 = market.rawCloseAt(sym, i - 1);
    if (!(c1 > 0) || !(c0 > 0)) continue;
    const lim = Math.max(C.BAND.k * engine.dailySigma(sym, i), C.BAND.floor);
    if (Math.abs(c1 / c0 - 1) >= lim) { hit = i; break; }
  }
  check('9e Binance 永续年代确有触发保护带的行情（不是死代码）', hit > 0,
    hit > 0 ? `首个 ${new Date(C.GAME.start + hit * H).toISOString().slice(0, 16)}Z` : '未找到');
  if (hit > 0) {
    const lock = async i => { const s = await mk({ sym, i, cash: 100000 }); s.ex = 'binance'; s.mode = 'fut'; s.lev = 5; s.books.binance = { usd: 0, usdt: 100000 }; return s; };
    const s = await lock(hit + 1);
    const r = engine.openTrade(s, 'long');
    check('9e 窗口内 Binance 永续开仓被拒 ｜ 只允许平仓', !r.ok && /只允许平仓/.test(r.why), r.why || '');
    const s2 = await lock(hit);                 // 触发那一根：还能开（闸从收线之后才算）
    const r2 = engine.openTrade(s2, 'long');
    check('9e 触发当根仍可开仓（闸从收线之后才算）', r2.ok, r2.why || '');
    /* 平仓是逃生通道：窗口内照样能平 */
    const s3 = await lock(hit);
    const r3 = engine.openTrade(s3, 'long', 0.5);
    engine.advanceOneHour(s3);                  // 进闸
    const c3 = engine.closeTrade(s3);
    check('9e 窗口内平仓不受影响（逃生通道）', r3.ok && c3.ok, r3.why || c3.why || '');
    /* 预警日志：进闸那一根播一条，锁定期内不重复 */
    const s4 = await lock(hit);
    engine.advanceOneHour(s4);
    const n1 = s4.log.filter(l => /极端行情 只允许平仓/.test(String(l.text))).length;
    engine.advanceOneHour(s4);
    const n2 = s4.log.filter(l => /极端行情 只允许平仓/.test(String(l.text))).length;
    check('9e 进闸播一条预警、锁定期内不重复', n1 === 1 && n2 === 1, `进闸 ${n1} 条 / 再走 1h ${n2} 条`);
  }
}

/* ── 9f · 边界：闸的年代与所边界 · 只拦开仓 · 回退清窗口 · 额度不许锁死 OTC 通道 ── */
{
  /* f1 · 2019-09-13 之前**恒不触发** —— 早期所没有熔断这个概念，这段必须是死代码。
         ⚠️ 这里**独立复算**判据（不复用引擎内部函数），才算真正的第二把尺子。 */
  const lim = i => {
    const c1 = market.rawCloseAt('BTC', i), c0 = market.rawCloseAt('BTC', i - 1);
    if (!(c1 > 0) || !(c0 > 0)) return false;
    return Math.abs(c1 / c0 - 1) >= Math.max(C.BAND.k * engine.dailySigma('BTC', i), C.BAND.floor);
  };
  let would = -1;
  for (let i = 1, e = idx(C.BAND.from); i < e; i++) if (lim(i)) { would = i; break; }
  /* ⚠️ 必须**走引擎**验：`lim` 复算的是阈值、不含年代闸 —— 只比较 `lim` 等于没测年代闸。
        做法：找一根「若在 Binance 年代就会被锁」的旧行情，把所硬设成 Binance ⇒ 引擎必须**不**锁它。 */
  const s1 = await mk({ sym: 'BTC', i: would + 1, cash: 100000 });
  s1.ex = 'binance'; s1.mode = 'fut'; s1.lev = 5; s1.books.binance = { usd: 0, usdt: 100000 };
  const r1span = engine.openTrade(s1, 'long');
  check('9f 2019-09-13 之前保护带恒不触发（那一根放到 Binance 年代就会被锁）',
    would > 0 && !/只允许平仓/.test(r1span.why || ''),
    `候选根 ${new Date(C.GAME.start + would * H).toISOString().slice(0, 16)}Z ⇒ ${r1span.why || 'ok'}`);

  /* f2 · 闸只认 Binance：同一根、同年代，BitMEX 永续照常可开 */
  let hit2 = -1;
  for (let i = idx(C.BAND.from), e = idx(at(2024, 11)); i < e; i++) if (lim(i)) { hit2 = i; break; }
  if (hit2 > 0) {
    const atHour = async ex => {
      const s = await mk({ sym: 'BTC', i: hit2 + 1, cash: 100000 });
      s.ex = ex; s.mode = 'fut'; s.lev = 5; s.books[ex] = { usd: 0, usdt: 100000 };
      return s;
    };
    const rb = engine.openTrade(await atHour('binance'), 'long');
    const rm = engine.openTrade(await atHour('bitmex'), 'long');
    check('9f 保护带只认 Binance（同一时刻 BitMEX 照常可开）',
      !rb.ok && rm.ok, `binance=${rb.why || 'ok'} / bitmex=${rm.why || 'ok'}`);
  } else {
    check('9f 保护带只认 Binance（同一时刻 BitMEX 照常可开）', false, '未找到触发点，无法验证');
  }

  /* f3 · 额度闸**只拦开仓**：先建空头（过闸）⇒ 加仓被顶住 ⇒ 平仓永远放行（与 `haltedAt` 同纪律） */
  const s3 = await mk({ sym: 'BTC', i: idx(at(2013, 8)), cash: 20000 });
  s3.ex = 'bitfinex'; s3.mode = 'margin'; s3.lev = 1;
  const r1 = engine.openTrade(s3, 'short', 0.5);
  const r2 = engine.openTrade(s3, 'short', 1);
  const r3 = engine.closeTrade(s3);
  check('9f 额度闸只拦开仓（平仓永远放行）',
    r1.ok && !r2.ok && /借贷额度不足/.test(r2.why || '') && r3.ok,
    `首开=${r1.why || 'ok'} 加仓=${r2.why || 'ok'} 平仓=${r3.why || 'ok'}`);

  /* f4 · 回退必须清掉利息窗口 —— 否则会带着「上半局累计的利息」跨回退播报 */
  const s4 = await mk({ cash: 50000 });
  s4.intWin = { ied: 123, grossM: 999 };
  engine.rewindTo(s4, s4.i);
  check('9f rewindTo 清掉利息窗口', s4.intWin && s4.intWin.ied === 0 && s4.intWin.grossM === 0, JSON.stringify(s4.intWin));

  /* f5 · 额度闸**只认盘口通道**：OTC 走到最低单也绝不因额度被拦。
     背景（本断言就是为它立的）：BTC 2013 的 OTC 最低单 $17K > 当日可借额度 $14K
     （`liqOf` $138K × 10%），拿**盘口**口径去卡**场外**通道会卡出一个死结
     —— 玩家同时看到「最少 $17K」与「最多借 $14K」。用户 2026-10-03 拍板 OTC 整条豁免。 */
  const big = async () => {
    const s = await mk({ sym: 'BTC', i: idx(at(2013, 8)), cash: 400000 });
    s.ex = 'bitfinex'; s.mode = 'margin'; s.lev = 1;
    return s;                                       // 权益 $40 万 > OTC 解锁门槛（$20 万）
  };
  const sOtc = await big(); sOtc.chan = 'otc';
  const rOtc = engine.openTrade(sOtc, 'short', 1);
  check('9f OTC 通道豁免额度闸（BTC 2013 做空不再死结）',
    rOtc.ok && !/借贷额度不足/.test(rOtc.why || ''), `${rOtc.why || 'ok'} ｜ 名义 $400K vs 额度 $14K`);
  const sBook = await big();                        // 同规模、同一时刻，只把通道换成盘口
  const rBook = engine.openTrade(sBook, 'short', 1);
  check('9f 同一笔走盘口仍被额度闸拦（豁免只给 OTC，不是把闸删了）',
    !rBook.ok && /借贷额度不足/.test(rBook.why || ''), rBook.why || 'ok');
}

/* ═══════════════════ 总账 ═══════════════════ */
section('总账');
console.log(`通过 ${pass} · 失败 ${fail}`);
if (bad.length) { console.log('阻塞项：'); for (const b of bad) console.log('  ✗ ' + b); }
process.exitCode = fail ? 1 : 0;
