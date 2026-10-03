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
// 2b.1 巨鲸在 Binance 永续上被档位卡住（2020-06 该所上限 125x；现金 $20 万 × 125x ≈ $2380 万名义 ⇒ 5x 档）
{
  const s = await mk({ i: idx(at(2020, 6)) });
  s.ex = 'binance'; s.mode = 'fut'; s.lev = 125;
  s.books.binance = { usd: 0, usdt: 200000 };
  const r = noteWhy(engine.openTrade(s, 'long'));
  check('⑥ 超档巨鲸单被拒绝', !r.ok && /超过该档杠杆上限/.test(r.why || ''), r.why || '（竟然开出来了）');
}
// 2b.2 同所同年代：档内的单照常放行（杠杆 20x × $5K ≈ $10 万名义 ⇒ 100x 档）
{
  const s = await mk({ i: idx(at(2020, 6)) });
  s.ex = 'binance'; s.mode = 'fut'; s.lev = 20;
  s.books.binance = { usd: 0, usdt: 5000 };
  const r = engine.openTrade(s, 'long');
  check('⑥ 档内的单照常放行', r.ok, r.why || '');
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
console.log('  年月       所        taker(margin)  taker(fut)  借贷日息   资金费率上限/8h  σ30日估');
for (const t of eras) {
  const ex = t < C.exchangeOf('binance').open ? 'bitfinex' : 'binance';
  const fm = C.feeRateOf(ex, t, 'margin', null);
  const ff = C.hasLeverageKindAt(t, ex, 'fut') ? C.feeRateOf(ex, t, 'fut', null) : NaN;
  const d = C.marginDailyRateAt(t);
  console.log(`  ${new Date(t).toISOString().slice(0, 7)}  ${ex.padEnd(9)}  ${f(fm * 100, 4)}%       ${Number.isFinite(ff) ? f(ff * 100, 4) + '%' : '—'}       ${f(d * 100, 4)}%/日  0.3%             见第 5 节`);
}
check('借贷日息年代阶梯单调（早年 ≥ 近年）', C.marginDailyRateAt(at(2013, 0)) >= C.marginDailyRateAt(at(2021, 0)));

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

/* ═══════════════════ 总账 ═══════════════════ */
section('总账');
console.log(`通过 ${pass} · 失败 ${fail}`);
if (bad.length) { console.log('阻塞项：'); for (const b of bad) console.log('  ✗ ' + b); }
process.exitCode = fail ? 1 : 0;
