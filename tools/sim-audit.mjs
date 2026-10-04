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
/* T3（2026-10-04 审计）：只数「≥8 类」太松 —— 改文案 / 漏一条分支都能蒙过。
   这里**逐条点名**（用子串匹配，容忍 `why` 里的动态数字），漏一条就红。 */
for (const w of ['本局已结束', '停机维护', '杠杆做空 暂不可用', '还没上线', '合约保证金必须是 USDT',
  '可用保证金不足', '下单金额太小', 'OTC 单笔最少', '反手请先平仓']) {
  check(`拒绝分支命中「${w}」`, [...seen.keys()].some(k => k.includes(w)));
}

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

/* ═══════════════════ 2c · 结局状态机（归零 → 待决 / 领救济 / 收摊 / 挑战 / 上帝） ═══════════════════ */
section('2c · 结局状态机：checkRuin 的几条出口逐条走一遍');
{
  /* 逼破产的**公开路径**（`checkRuin` 未导出）：开一张小仓（`closeTrade` 得有仓才走），
     再把本所那格现金写成巨额负数 ⇒ `equity ≪ MIN_NOTIONAL`，平仓 ⇒ `closeTrade` 末尾的
     `checkRuin` 判归零。⚠️ 负现金只是**逼破产的手段**，不是真实余额（真实归零是余额 ≈ 0）；
     因此验「领救济金到账」时看的是**差额**，这个人为偏移不影响结论。 */
  const ruin = (s, why = '审计-逼破产') => {
    s.lev = 1;
    const o = engine.openTrade(s, 'long', 0.2);
    if (!o.ok) return o;
    s.books[s.ex] = { usd: -1e9, usdt: 0 };
    engine.closeTrade(s, why);
    return { ok: true };
  };
  const drown = async (opts = {}) => { const s = await mk({ cash: 1000, ...opts }); await ruin(s); return s; };

  // ① 经典局首次归零 ⇒ 待决（pending='loan'、paused、本局未结束、还没领过）
  {
    const s = await drown();
    check('2c 经典局首次归零进「待决」而非结束',
      s.pending === 'loan' && s.paused === true && s.over == null,
      `pending=${s.pending} paused=${s.paused} over=${JSON.stringify(s.over)}`);
    check('2c 首次归零时尚未记「已领救济金」', s.loaned !== true, `loaned=${s.loaned}`);
  }
  // ② 待决态领救济金 ⇒ 时钟解冻、账上按**救济金额**加钱
  {
    const s = await drown();
    const before = engine.equity(s);
    const r = engine.takeLoan(s);
    const after = engine.equity(s);
    check('2c 领救济金成功且清掉待决', r.ok && s.pending == null && s.loaned === true,
      r.why || `pending=${s.pending} loaned=${s.loaned}`);
    check('2c 救济金到账金额 = loanAmountAt()（不多不少一次）',
      Math.abs((after - before) - C.loanAmountAt()) < 1e-6, `Δ=${f(after - before, 4)} 应=${f(C.loanAmountAt(), 4)}`);
  }
  // ③ 领过救济金后再归零 ⇒ 直接 LIQUIDATED（不再弹遮罩）
  {
    const s = await drown();
    engine.takeLoan(s);
    s.books[s.ex] = { usd: 1000, usdt: 0 };   // 把逼破产的人为负现金还原成「可开一笔小仓」
    await ruin(s, '审计-逼破产-二次');
    check('2c 二次归零（已领过救济金）⇒ LIQUIDATED',
      !!s.over && s.over.reason === 'liquidated' && s.pending == null,
      `over=${JSON.stringify(s.over)} pending=${s.pending}`);
  }
  // ④ 待决态「就此收摊」⇒ GAVEUP（不是 LIQUIDATED）
  {
    const s = await drown();
    const r = engine.giveUp(s);
    check('2c 待决态收摊 ⇒ GAVEUP（不是 LIQUIDATED）',
      !!s.over && s.over.reason === 'gaveup' && r.why === 'gaveup',
      `over=${JSON.stringify(s.over)} r.why=${r.why}`);
  }
  // ⑤ 挑战局归零 ⇒ 当场 LIQUIDATED（不发救济金、不弹待决）
  {
    const s = await drown({ scen: 'degen' });
    check('2c 挑战局归零即终局 LIQUIDATED（不发救济金）',
      !!s.over && s.over.reason === 'liquidated' && s.pending == null && C.isChallenge(s.scen),
      `over=${JSON.stringify(s.over)} pending=${s.pending}`);
  }
  // ⑥ 上帝模式归零 ⇒ 不结束本局（写 godRuined、over 仍为空）
  {
    const s = await mk({ cash: 1000 });
    god.enableGod(s);
    await ruin(s, '审计-逼破产-上帝');
    check('2c 上帝模式归零不结束本局（godRuined=true、over=null）',
      s.godRuined === true && s.over == null, `godRuined=${s.godRuined} over=${JSON.stringify(s.over)}`);
  }
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
  /* T4（2026-10-04 审计）：`!fc0 || …` 在 `fc0` 为 null 时**空过** —— 改成必须拿到预测再判值。 */
  check('刚结算那一刻 hours = 8（不是 0）', !!fc0 && fc0.hours === 8, `hours=${fc0 && fc0.hours}`);
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
section('6 · 数值健壮性 fuzz（固定种子 · 杠杆 × 资金 × 方向 × 时刻）');
/* T6（2026-10-04 审计）：原来用**未播种**的 `Math.random` —— 同一个用例跑两次结果不同，
   红了也没法复盘。改用本地播种 PRNG（mulberry32），种子写死 ⇒ 任何机器、任何次数都是同一串。 */
let fuzzSeed = 0x12345678 | 0;
const rf = () => {
  fuzzSeed = (fuzzSeed + 0x6d2b79f5) | 0;
  let t = Math.imul(fuzzSeed ^ (fuzzSeed >>> 15), 1 | fuzzSeed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
let fuzzN = 0, fuzzBad = 0, fuzzRej = 0, fuzzNoWhy = 0;
for (let k = 0; k < 400; k++) {
  const sym = ['BTC', 'ETH', 'XRP', 'DOGE', 'SOL'][k % 5];
  const s = await mk({ sym, i: Math.floor(rf() * 90000), cash: Math.pow(10, 1 + rf() * 5) });
  s.lev = [1, 2, 3, 5, 10, 20, 50, 100, 125][Math.floor(rf() * 9)];
  s.mode = rf() < 0.5 ? 'margin' : 'fut';
  const side = rf() < 0.5 ? 'long' : 'short';
  const r = engine.openTrade(s, side, rf());
  fuzzN++;
  if (!r.ok) {
    /* T6：被拒也必须给出**非空 `why`** —— 空理由 ⇒ UI 弹不出任何提示，玩家只看到「没反应」。 */
    fuzzRej++;
    if (!r.why || typeof r.why !== 'string' || !r.why.trim()) {
      fuzzNoWhy++;
      console.log(`   ✗ fuzz #${k} ${sym} ${side} ${s.lev}x 被拒却没给 why`, JSON.stringify(r));
    }
    continue;
  }
  const pos = s.positions[sym];
  const eq = engine.equity(s);
  const ok = pos && Number.isFinite(pos.margin) && Number.isFinite(pos.size) && Number.isFinite(pos.notional)
    && Number.isFinite(P.liquidationPrice(pos)) && Number.isFinite(eq)
    && pos.margin > 0 && pos.size > 0 && pos.notional > 0;
  if (!ok) { fuzzBad++; console.log(`   ✗ fuzz #${k} ${sym} ${side} ${s.lev}x → 非有限/非正字段`, JSON.stringify(pos)); continue; }
  /* T6：成交后**同一小时平仓**，做两条守恒断言。
     ⚠️ 不能要求「权益只减不增」—— `SHOCK.closeGive = 0.35` 是**有意的单向棘轮**（平仓只回吐
        开仓冲击的 35%），自买自卖会留下残余位移、往返可小幅为正（god.js SHOCK 注释：需持仓
        超过当日流动性三成才够得到）。所以这里只卡**有界 + 净平**：一趟往返的权益变化不得超过
        该仓位名义的一半（残余位移被 `riseMax`+20% / `fallMax`−45% 夹住，而双重记账之类的真 bug
        会远超此），且平完必须不留仓。 */
  const before = engine.equity(s);
  const notional = pos.notional;
  engine.closeTrade(s, '审计-fuzz');
  const after = engine.equity(s);
  if (!Number.isFinite(after) || s.positions[sym] || Math.abs(after - before) > 0.5 * notional + 1e-6) {
    fuzzBad++;
    console.log(`   ✗ fuzz #${k} ${sym} ${side} ${s.lev}x 同小时开平不守恒/未平净 ${f(before, 4)} → ${f(after, 4)}`
      + ` 名义 ${f(notional, 2)} 残留仓=${!!s.positions[sym]}`);
  }
}
check('fuzz 400 局无 NaN / 非正字段', fuzzBad === 0, `${fuzzN} 次尝试（拒 ${fuzzRej}），${fuzzBad} 处异常`);
check('fuzz 每一笔被拒都带非空 why', fuzzNoWhy === 0, `${fuzzRej} 笔被拒，${fuzzNoWhy} 笔无理由`);

/* ═══════════════════ 7 · 全时间线连跑（50x 无头） ═══════════════════ */
section('7 · 全时间线连跑：真实数据走满 12 年不崩、曲线有限');
{
  const s = await mk({ sym: 'BTC', cash: 100000 });
  for (const sy of ['BTC', 'ETH', 'XRP', 'DOGE', 'SOL']) await market.loadCoin(sy);
  let steps = 0, nan = 0, trades = 0, frozen = 0;
  const step = 24 * 30;   // 每月推进一次
  while (s.i < s.endI && steps < 400) {
    /* T1（2026-10-04 审计）：中途归零会进 `'loan'` 待决态（`s.pending`）⇒ `advanceOneHour`
       在开头直接 return、**时钟冻结**，之后每一轮都空转，`steps` 硬撑到 400 还判「权益有限」——
       等于根本没走到时间线尽头（T5 的结束态断言也就跟着空过）。本审计只关心「钱会不会算崩」，
       不关心救济金弹窗 ⇒ 每轮先清掉待决，让时钟继续走。 */
    if (!s.over) s.pending = null;
    if (!s.over) {
      s.mode = steps % 2 ? 'fut' : 'margin';
      s.lev = steps % 3 === 0 ? 10 : 3;
      s.sym = ['BTC', 'ETH', 'SOL'][steps % 3];
      const r = engine.openTrade(s, steps % 2 ? 'long' : 'short', 0.2);
      if (r.ok) trades++;
      if (s.positions[s.sym]) engine.closeTrade(s, '审计');
    }
    const before = s.i;
    engine.advanceOneHour(s);
    for (let j = 1; j < step; j++) engine.advanceOneHour(s);
    if (!Number.isFinite(engine.equity(s))) { nan++; break; }
    if (s.i === before) { frozen++; break; }   // 时钟没动（且非终局）⇒ 别在死循环里空转到 steps 上限
    steps++;
  }
  check('连跑 12 年：权益全程有限', nan === 0, `步数 ${steps}，成交 ${trades}，末值 $${f(engine.equity(s), 2)}，over=${s.over ? s.over.reason : '无'}`);
  /* T1：断言时钟**真的走到底**（引擎在终点会把 `s.i` 钉在 `endI-1` 并结算 ⇒ 判 `>= endI-1`）。 */
  check('时钟真的走到底（推进到本局终点）', s.i >= s.endI - 1, `s.i=${s.i} endI=${s.endI} 步数=${steps} 冻结=${frozen}`);
  /* T5：原来白名单里含「未结束」⇒ `s.over` 全 null 也能过，等于没验退出条件。改成必须**真实命中**终局。 */
  check('连跑结束于结算/爆仓/收摊的真实终局',
    !!s.over && ['liquidated', 'settled', 'gaveup'].includes(s.over.reason),
    `over=${JSON.stringify(s.over)}`);
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
  const dayLiq = market.liqOf('BTC', market.dayIndexOf(s0.i));
  const cap = dayLiq * C.MARGIN.quota;
  console.log(`  2013-09 BTC 日流动性 $${f(dayLiq / 1e6, 2)}M ⇒ 额度 $${f(cap / 1e3, 1)}K`);
  /* ⚠️ 本金取**当日额度的 0.8 倍**，不写死绝对值：流动性锚逐年会变（2026-10-04 修正过 BTC 早期年，
     2013-09 额度从 $11.4K 抬到 $607K）—— 写死 $20,000 在新锚下根本够不到闸门，断言会退化成空转。
     3x 多头借入 = 名义 × 2/3 = 本金 × 2 = 1.6×额度 > 额度 ⇒ 必被拒。 */
  const cash = cap * 0.8;
  const s1 = await mk({ sym: 'BTC', i: idx(t), cash });
  s1.ex = 'bitfinex'; s1.mode = 'margin'; s1.lev = 1;
  const r1 = engine.openTrade(s1, 'long', 1);
  check('9c 1x 多头借入为 0 ⇒ 额度闸不拦', r1.ok, r1.why || '');
  const s3 = await mk({ sym: 'BTC', i: idx(t), cash });
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

  /* f3 · 额度闸**只拦开仓**：先建空头（过闸）⇒ 加仓被顶住 ⇒ 平仓永远放行（与 `haltedAt` 同纪律）
     ⚠️ 本金取**当日额度的 1.5 倍**，不写死绝对值：2013-09 的额度随流动性锚变动
     （2026-10-04 修正 BTC 早期年 ⇒ $11.4K 抬到 $607K），写死 $20,000 在新锚下根本够不到闸门。
     1x 空头借入 = 名义 = 本金 ⇒ 半仓 0.75×额度（过闸），全仓 1.5×额度（被拒）。 */
  const sPre = await mk({ sym: 'BTC', i: idx(at(2013, 8)) });
  const cap2013 = market.liqOf('BTC', market.dayIndexOf(sPre.i)) * C.MARGIN.quota;
  const cash2013 = cap2013 * 1.5;
  const s3 = await mk({ sym: 'BTC', i: idx(at(2013, 8)), cash: cash2013 });
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
     立这条的起因是 2026-10-03 的**死结**：当时 BTC 2013 的 OTC 最低单 $17K > 当日可借额度 $14K
     （旧锚 `liqOf` $138K × 10%），拿**盘口**口径去卡**场外**通道会卡出一个死结
     —— 玩家同时看到「最少 $17K」与「最多借 $14K」。
     ⚠️ 2026-10-04 修正 BTC 早期年锚后，那个具体死结已**不再存在**（2013-10 额度 ≈ $2.2M），
        但 OTC 与盘口本就是两把尺子（场外撮合不吃盘口深度）⇒ 豁免照旧保留。
     本金取**当日额度的 1.5 倍**（不写死绝对值，同 f3）：权益须先过 OTC 解锁门槛。 */
  const big = async () => {
    const s = await mk({ sym: 'BTC', i: idx(at(2013, 8)), cash: cash2013 });
    s.ex = 'bitfinex'; s.mode = 'margin'; s.lev = 1;
    return s;                                       // 权益 1.5×额度 > OTC 解锁门槛（$20 万）
  };
  const sOtc = await big(); sOtc.chan = 'otc';
  const rOtc = engine.openTrade(sOtc, 'short', 1);
  check('9f OTC 通道豁免额度闸（BTC 2013 做空不再死结）',
    rOtc.ok && !/借贷额度不足/.test(rOtc.why || ''), `${rOtc.why || 'ok'} ｜ 名义 ${f(cash2013 / 1e3, 0)}K vs 额度 ${f(cap2013 / 1e3, 0)}K`);
  const sBook = await big();                        // 同规模、同一时刻，只把通道换成盘口
  const rBook = engine.openTrade(sBook, 'short', 1);
  check('9f 同一笔走盘口仍被额度闸拦（豁免只给 OTC，不是把闸删了）',
    !rBook.ok && /借贷额度不足/.test(rBook.why || ''), rBook.why || 'ok');
}

/* ── 9g · 缺口 15：档 3「强平簇吸引」（距离感知加速 · 上界 · 预警 · 回退） ── */
{
  /* 场景：2017-01 BitMEX 永续 —— 当年盘口尚薄、杠杆档齐全，同一时刻 / 同一本金 / 同一方向，
     **只变杠杆** ⇒ 只变「到强平线的距离」。走合约通道是因为 `margin` 的借贷额度闸会把大单拒掉。
     ⚠️ 这四个参数是探针挑出来的（`tools/_probe9g.mjs`，用完即删）：先扫一遍「时刻 × 本金 × 杠杆组」，
        只留**同时**满足下列全部条件的组合，再在**本块的真实结构**（`on` 先算、`off` 后算，中间隔着
        若干次模拟）下复跑确认 —— 不能只在探针里相邻测量通过，因为引擎存在**跨运行末位漂移**
        （同一 far 档的 `kAim` 开 / 关本应逐位相同，早先 2016-06 那组会在 h6 起分叉 1 ULP）。
        入选条件：① 四档 exposure 都 ≥ t3（最低的 3x 也有 ~199%）；② `d` 一近一远正好跨在 dRef 两侧；
        ③ **far 档全程最小 `d` 仍 ≥ dRef**（窗口内不许跌进距离闸）；④ far 开 / 关逐位相同、near 严格变大；
        ⑤ far 不播预警、near 播。命中后在**本块复跑**确认的是 `2017-01 / $5M / [3,5,10,20]` 这一组。
     ⚠️ 断言一律做成**相对关系**（`kAim` 开 / 关的自我对照），不写死绝对值 —— 同 §9d 的纪律。 */
  const T = idx(at(2017, 0));
  const CASH = 5e6;
  const LEVS = [3, 5, 10, 20];
  const SIG = engine.dailySigma('BTC', T);
  const DREF = C.ADV.dRefSig * SIG;
  const liqDay = market.liqOf('BTC', market.dayIndexOf(T));
  console.log(`  2017-01 BitMEX 永续 杠杆档 ${LEVS.join(' / ')} ｜ σ_30日 ${f(SIG * 100, 2)}%`
    + ` ⇒ dRef = ${f(DREF * 100, 2)}% ｜ t3 = ${f(C.ADV.t3 * 100, 0)}% ｜ 当日流动性 $${f(liqDay / 1e6, 1)}M`);

  /**
   * 跑一档：同一状态、同一本金、同一方向，**只变杠杆**（⇒ 只变到强平线的距离）与 `kAim`。
   * ⚠️ 断言一律做成**相对关系**（`kAim` 开 / 关的自我对照），不写死绝对值 —— 同 §9d 的纪律。
   */
  const run = async (lev, kAim) => {
    const saved = C.ADV.kAim;
    C.ADV.kAim = kAim;
    const s = await mk({ sym: 'BTC', i: T, mode: 'fut', cash: CASH });
    s.ex = 'bitmex'; s.lev = lev;
    s.books = { bitmex: { usd: 0, usdt: CASH } };
    const r = engine.openTrade(s, 'short', 1);
    let push = 0, d = NaN, minD = NaN, n3 = 0;
    if (r.ok && s.positions.BTC) {
      const mk0 = engine.lastPrice(s, 'BTC');
      d = Math.abs(mk0 - P.liquidationPrice(s.positions.BTC)) / mk0;
      minD = d;
      for (let k = 0; k < 12 && s.positions.BTC; k++) {
        engine.advanceOneHour(s);
        /* ⚠️ 同时记**窗口内每一步**的到强平线距离：只测 t=0 会被「开局够远、中途贴近」骗过 ——
           far 的前提必须用**全程最小 d** 来判（否则参数一漂移，用例会悄悄退化成空转）。 */
        if (s.positions.BTC) {
          const mkK = engine.lastPrice(s, 'BTC');
          const dK = Math.abs(mkK - P.liquidationPrice(s.positions.BTC)) / mkK;
          if (dK < minD) minD = dK;
        }
        const p = Number.isFinite(s.mkt.BTC.advPush) ? Math.abs(s.mkt.BTC.advPush) : 0;
        if (p > push) push = p;
      }
      n3 = s.log.filter(l => /强平线/.test(String(l.text))).length;
    }
    C.ADV.kAim = saved;
    /* 本小时峰值 exposure（`S.adv[sym].v`，与 `advAimAmp` 同口径）—— 用来证明两个闸门都真的开着 */
    const e = s.adv && s.adv.BTC ? s.adv.BTC.v : 0;
    return { ok: r.ok, why: r.why, push, d, minD, n3, e, s };
  };

  const on = [];
  for (const lev of LEVS) on.push({ lev, ...(await run(lev, 1)) });
  const good = on.filter(o => o.ok && Number.isFinite(o.d));
  if (!good.length) {
    check('9g 前置：2017-01 BitMEX 永续做空能开出来', false,
      on.map(o => `${o.lev}x:${o.why || 'ok'}`).join(' | '));
  } else {
    good.sort((a, b) => a.d - b.d);
    const near = good[0], far = good[good.length - 1];
    console.log('  开档 3：' + good.map(o => `${o.lev}x d=${f(o.d * 100, 2)}% minD=${f(o.minD * 100, 2)}% e=${f(o.e * 100, 0)}% push=${f(o.push * 100, 3)}%`).join(' ｜ '));
    check('9g 前置：这一对确实跨在 dRef 两侧（否则测不到距离闸）',
      near.d < DREF && far.d >= DREF, `${f(near.d * 100, 2)}% < ${f(DREF * 100, 2)}% ≤ ${f(far.d * 100, 2)}%`);
    /* ⚠️ 加强前提（比「t=0 够远」更严）：far 必须**整个测量窗口内始终** d ≥ dRef，
       否则窗口中某一小时 `advAimAmp` 合法地 > 1、②「逐位相同」就退化成空转（曾经发生过）。 */
    check('9g 前置：远强平线那档全程最小 d 仍 ≥ dRef（窗口内不许跌进距离闸）',
      far.minD >= DREF, `窗口 minD ${f(far.minD * 100, 2)}% ≥ dRef ${f(DREF * 100, 2)}%`);
    /* ⚠️ 两个闸都要真的开着，否则「档 3 生效」可能靠曝光、而「距离闸」可能靠曝光不足而假通过 */
    check('9g 前置：近强平线那档曝光 ≥ t3（档 3 的曝光闸真的开在「距离」这一侧）',
      near.e >= C.ADV.t3, `e ${f(near.e * 100, 1)}% ≥ t3 ${f(C.ADV.t3 * 100, 0)}%`);
    check('9g 前置：远强平线那档曝光 ≥ t3 且档 2 推价 > 0（距离是**唯一**的关闸理由）',
      far.e >= C.ADV.t3 && far.push > 0,
      `e ${f(far.e * 100, 1)}% ≥ t3 ${f(C.ADV.t3 * 100, 0)}% ｜ push ${f(far.push * 100, 3)}%`);

    /* ① 档 3 真的加了力：同一状态、只切 `kAim` ⇒ 近强平线的推价必须**严格变大** */
    const nearOff = await run(near.lev, 0);
    check('9g 档 3 生效：近强平线时推价严格大于「关掉档 3」',
      nearOff.ok && near.push > nearOff.push + 1e-12,
      `开 ${f(near.push * 100, 3)}% vs 关 ${f(nearOff.push * 100, 3)}%`);

    /* ② 距离闸（§5.4 不做凭空针对）：远强平线时 `kAim` 开 / 关**逐位相同**（`amp` 恰为 1）。
       ⚠️ 2026-10-04：由「严格 `===`」放宽为**相对 1e-9 容差**。数学上 `amp = 1` ⇒ 两次运行逐位相同，
          但引擎存在**跨运行末位漂移**（本块开头的注释已记过）：`kAim` 先开 4 档、再关 3 档，
          浮点累加次序不同 ⇒ 实测分叉在 **5e-11（相对）** 量级（1.3878247659369e-2 vs
          1.3878247658617e-2），显示到小数点后 3 位完全一样。1e-9 的容差仍能抓出任何真实的
          `amp ≠ 1`（档 3 的倍率 ≥ 1.05 量级 ⇒ 差异 ≥ 5%，差三个数量级）。 */
    const farOff = await run(far.lev, 0);
    const farAmpErr = Math.abs(far.push - farOff.push) / Math.max(Math.abs(far.push), 1e-12);
    check('9g 距离闸：远强平线（d ≥ dRef）时档 3 一个字都不改（amp = 1）',
      farOff.ok && farAmpErr <= 1e-9,
      `开 ${f(far.push * 100, 3)}% vs 关 ${f(farOff.push * 100, 3)}%（相对差 ${farAmpErr.toExponential(1)}）`);

    /* ③ 上界：唯一允许破 σ 的地方，但仍是**有界**的（`aimCap × σ`） */
    const cap = C.ADV.aimCap * SIG;
    const worst = Math.max(...on.map(o => o.push), nearOff.push, farOff.push);
    /* ⚠️ `m.advPush` 是**缓动后**的推价（一阶低通）⇒ 上界与目标值同阶，留 1e-9 余量避免浮点脆断 */
    check('9g 推价上界 ≤ aimCap × σ（破 σ 但有界，不累积）',
      worst <= cap + 1e-9, `实得最大 ${f(worst * 100, 3)}% ｜ 上界 ${f(cap * 100, 3)}%（σ = ${f(SIG * 100, 2)}%）`);

    /* ④ 预警（§5.2 硬要求）：进档 3 播一条、闩锁不重复；远强平线那条路不播 */
    check('9g 进档 3 播一条「强平线」预警（不是死代码）', near.n3 >= 1, `实得 ${near.n3} 条`);
    check('9g 远强平线不播档 3 预警（不做凭空针对）', far.n3 === 0, `实得 ${far.n3} 条`);
  }

  /* ⑤ 回退必须复位闩锁 —— 否则回退后再进档 3 就永远不再提醒（同 `advWarn` / `advWarn2`） */
  const s5 = await mk({ cash: 50000 });
  s5.advWarn3 = true;
  engine.rewindTo(s5, s5.i);
  check('9g rewindTo 复位档 3 预警闩锁', s5.advWarn3 === false, `实得 ${s5.advWarn3}`);
}

/* ═══════════════════ 10 · 存档往返（存 → 读 → 再存 幂等 · 读回的盘能继续跑） ═══════════════════ */
section('10 · 存档往返（JSON 序列化 ⇒ 逐位可复现 · 两槽互不覆盖）');
{
  const save = await import('../src/core/save.js');
  const { STATE_VERSION } = await import('../src/core/state.js');

  /* ⚠️ Node 里**没有** `localStorage`，而 `save.js` 直接读这个全局 —— 本小节**临时**装一个内存版，
     跑完在 `finally` 里恢复原值（原本没有就删掉），绝不污染全局、也不改 `src/`。 */
  const hadLS = 'localStorage' in globalThis;
  const prevLS = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: k => (mem.has(String(k)) ? mem.get(String(k)) : null),
    setItem: (k, v) => { mem.set(String(k), String(v)); },
    removeItem: k => { mem.delete(String(k)); },
    clear: () => mem.clear(),
  };

  /* ⚠️ 体例说明（**不伪装通过**）：任务书把 `shaped` / `parse` 列为 `save.js` 的导出，实际它们是
     **模块内私有函数**（`src/core/save.js:62` / `:72`），Node 里 import 不到 —— 所以本小节不直接
     调它们，改测它们的**效果**：`loadSlot()` / `hasSave()` 内部走的就是 `parse()` ⇒ `shaped()`，
     回写一份 JSON 往返档后 `hasSave` 仍为真，即等价于「`shaped()` 没丢那 12 个键」。
     另：`localStorage` 走上面的内存打桩，所以 `save` / `load` / `wipe` 在 Node 下**确实可用**。 */
  try {
    /* 跑一局：真下单 ⇒ 真持仓，再推进若干小时，让派生量非平凡（利息 / 价格位移都已经发生） */
    const s = await mk({ scen: 'classic', sym: 'BTC', cash: 50000, i: idx(at(2020, 5)) });
    s.mode = 'margin'; s.lev = 2;
    const o = engine.openTrade(s, 'long', 0.5);
    check('10 前置：存档局的仓开出来了', o.ok && !!s.positions.BTC, o.why || '');
    for (let k = 0; k < 28; k++) engine.advanceOneHour(s);
    const eq0 = engine.equity(s);

    check('10 save() 落盘返回真', save.save(s) === true);
    const back = save.load();
    check('10 load() 拿回一份可用档（版本相符）', !!back && back.v === STATE_VERSION, back ? `v=${back.v}` : 'null');
    if (back) {
      check('10 往返后权益一致（1e-6 容差）',
        Math.abs(engine.equity(back) - eq0) < 1e-6, `${f(engine.equity(back), 6)} vs ${f(eq0, 6)}`);
      const p0 = s.positions.BTC, p1 = back.positions.BTC;
      const dOk = !!p0 && !!p1
        && Math.abs(P.liquidationPrice(p1) - P.liquidationPrice(p0)) < 1e-6
        && Math.abs(p1.margin - p0.margin) < 1e-6
        && Math.abs(p1.entry - p0.entry) < 1e-9
        && Math.abs(p1.size - p0.size) < 1e-9;
      check('10 往返后关键派生量一致（强平价 / 保证金 / 均价 / 数量）', dOk,
        dOk ? `强平价差 ${f(Math.abs(P.liquidationPrice(p1) - P.liquidationPrice(p0)), 9)}` : '有字段漂移');
      check('10 往返后时间 / 模式 / 所 / 币一并还原',
        back.i === s.i && back.mode === s.mode && back.sym === s.sym && back.ex === s.ex,
        `i=${back.i}/${s.i} mode=${back.mode}/${s.mode}`);

      /* JSON 往返 + `SHAPE` 12 键白名单（键名照抄 `save.js:60`）—— 这正是 `shaped()` 的判据本身 */
      const rt = JSON.parse(JSON.stringify(back));
      const SHAPE_KEYS = ['books', 'positions', 'flow', 'overhang', 'pool', 'adv', 'mkt', 'pvol', 'stat', 'pulse', 'log', 'eq'];
      const missing = SHAPE_KEYS.filter(k => !(k in rt));
      check('10 JSON 往返后 SHAPE 的 12 个键一个不丢', missing.length === 0, missing.length ? `缺 ${missing.join(' / ')}` : '12 / 12');
      /* 回写这份往返档后被 `hasSave` 接受 ⇒ `shaped()` 真的认它（第二把尺子） */
      mem.set('degen_save_normal', JSON.stringify(rt));
      check('10 回写往返档后 shaped() 仍认（hasSave 为真）', save.hasSave('normal') === true);

      /* 读回来的盘继续跑：不抛异常、权益有限 */
      const r2 = save.load();
      let threw = null;
      try { for (let k = 0; k < 3; k++) engine.advanceOneHour(r2); } catch (e) { threw = String((e && e.message) || e); }
      check('10 读回的盘能继续 advanceOneHour（不抛异常）', threw === null, threw || '');
      check('10 续跑后权益仍有限', !!r2 && Number.isFinite(engine.equity(r2)), r2 ? `权益 ${f(engine.equity(r2), 2)}` : 'null');
    } else {
      for (const nm of ['10 往返后关键派生量一致（强平价 / 保证金 / 均价 / 数量）',
        '10 JSON 往返后 SHAPE 的 12 个键一个不丢',
        '10 读回的盘能继续 advanceOneHour（不抛异常）']) check(nm, false, 'load() 返回 null，无法验证');
    }

    /* ── 两槽并存（`degen_save_normal` / `degen_save_challenge`）互不覆盖 ── */
    const chal = await mk({ scen: 'degen', sym: 'BTC' });
    check('10 槽位由 scen 推导：经典 ⇒ normal', save.saveSlotOf(s.scen) === 'normal', s.scen);
    check('10 槽位由 scen 推导：年代局 ⇒ challenge', save.saveSlotOf(chal.scen) === 'challenge', chal.scen);
    check('10 槽位显示名', save.slotName('normal') === '普通模式' && save.slotName('challenge') === '挑战模式');
    mem.clear();
    check('10 写 normal 槽成功', save.save(s) === true);
    check('10 写 challenge 槽成功', save.save(chal) === true);
    check('10 两槽互不覆盖（两个 hasSave 都为真）', save.hasSave('normal') === true && save.hasSave('challenge') === true);
    const ln = save.loadSlot('normal'), lc = save.loadSlot('challenge');
    check('10 两槽各自内容不同（scen 不同）', !!ln && !!lc && ln.scen !== lc.scen, `normal=${ln && ln.scen} / challenge=${lc && lc.scen}`);
    check('10 开局缺省先读 normal 槽（普通优先于挑战）', save.load().scen === 'classic');

    save.wipe('normal');
    check('10 wipe(normal) 后该槽 hasSave 为假', save.hasSave('normal') === false);
    check('10 wipe 只动本槽（challenge 仍可用）', save.hasSave('challenge') === true);
    save.wipe('challenge');
    check('10 wipe(challenge) 后该槽 hasSave 为假', save.hasSave('challenge') === false);
  } finally {
    if (hadLS) globalThis.localStorage = prevLS; else delete globalThis.localStorage;
  }
}

/* ═══════════════════ 11 · 跨年代边界（开所 / 闭所 / 维护窗口 · 全时间线扫描） ═══════════════════ */
section('11 · 跨年代边界：边界前后 openTrade 行为可解释 + 全时间线粗粒度扫描');
{
  /* 边界取自 `C.EXCHANGES`（开所 / 闭所 / 停机窗口）＋ 两类工具的**上线档**（`marginSteps` /
     `futSteps` 的各档 `from`）—— 全部由 `Date.UTC` 构造，与配置逐位同源，不另编时刻。 */
  const list = [];
  for (const ex of C.EXCHANGES) {
    if (ex.open >= C.GAME.start) list.push({ ex: ex.id, t: ex.open, kind: '开所' });
    if (ex.close != null) list.push({ ex: ex.id, t: ex.close, kind: '闭所' });
    for (const h of ex.halts || []) { list.push({ ex: ex.id, t: h.from, kind: '停机' }); list.push({ ex: ex.id, t: h.to, kind: '恢复' }); }
    for (const [steps, lab] of [[ex.marginSteps, '杠杆上线'], [ex.futSteps, '合约上线']]) {
      if (steps) for (const st of steps) list.push({ ex: ex.id, t: st.from, kind: lab });
    }
  }
  /* 同一所同一时刻去重（开所日往往就是首档上线日）；按时刻升序，输出可读 */
  const bounds = [...new Map(list.map(b => [`${b.ex}@${b.t}`, b])).values()].sort((a, b) => a.t - b.t);
  console.log(`  边界 ${bounds.length} 个（开所 / 闭所 / 停机 / 工具上线）｜ 闭所 ` +
    `${C.EXCHANGES.filter(e => e.close != null).length} 个（三家所 ` +
    `${C.EXCHANGES.every(e => e.close == null) ? '全部活到时间线末尾' : '有闭所事件'}）`);

  /* ⚠️ 「闭所日」在本时间线内**不可测**：`EXCHANGES[].close` 三家全为 `null` ——
     相应地 `advanceOneHour` 里那条 `collapseExchange` 交易所归零路径在本数据包下是**死代码**。
     如实记账，不伪造一条闭所边界。 */
  check('11 闭所日：三家所 close 全为 null（本时间线无闭所事件可测）',
    C.EXCHANGES.every(e => e.close == null),
    C.EXCHANGES.map(e => `${e.id}:${e.close == null ? '—' : new Date(e.close).toISOString().slice(0, 10)}`).join(' '));

  /* 打一根边界探针：把玩家放到**指定所**、同一时刻、同一本金（两格都给足，免被币种口径误拒） */
  const probe = async ({ ex, t, side = 'long', mode = 'margin', lev = 1, cash = 1000 }) => {
    const st = await mk({ sym: 'BTC', mode, i: idx(t) });
    st.ex = ex; st.lev = lev;
    st.books = { [ex]: { usd: cash, usdt: cash } };
    try { return engine.openTrade(st, side); } catch (e) { return { ok: false, why: `抛异常：${(e && e.message) || e}` }; }
  };
  const tag = r => (r.ok ? 'ok' : `拒(${r.why})`);

  for (const b of bounds) {
    const A = await probe({ ex: b.ex, t: b.t - H });
    const B = await probe({ ex: b.ex, t: b.t + H });
    /* 硬要求 ①：边界前 1 小时与后 1 小时，**开仓结果或能力清单必须真的变了一样**。
       ⚠️ T7（2026-10-04 审计）：原来的 `flipped || (A.ok && B.ok)` 等于「两侧都放行就无条件通过」——
          探针走的是最低档（1x · margin），很多边界（新增更高杠杆档 / 开融资）在这一档上看不出差别，
          于是「边界其实没生效」也会绿。改成：要么**开仓结果翻转**，要么**该所的杠杆/融资/停机
          能力签名翻转**（`capSig`）；两者都没变才是真正的异常。 */
    const flipped = (A.ok !== B.ok) || (A.why || '') !== (B.why || '');
    /* 能力签名要同时覆盖三类边界：①「有没有这一类杠杆」的闸（`hasLeverageKindAt`，
       开所日／首档上线日翻）；②可选档位与融资（`leverageOptionsAt` / `hasFinancingAt`，加档日翻）；
       ③停机窗口（`haltedAt`）。⚠️ 停机窗口只有 1 小时，±1h 的探针会**整段落在窗外**（见下方
       「停机窗口」那一节），故签名除比较 `t±H` 外还要看**边界那一刻本身** `t`。 */
    const capSig = t => JSON.stringify([
      C.hasLeverageKindAt(t, b.ex, 'margin'), C.hasLeverageKindAt(t, b.ex, 'fut'),
      C.leverageOptionsAt(t, b.ex, 'margin'), C.leverageOptionsAt(t, b.ex, 'fut'),
      C.hasFinancingAt(t, b.ex), C.haltedAt(t, b.ex),
    ]);
    const capFlipped = capSig(b.t - H) !== capSig(b.t) || capSig(b.t) !== capSig(b.t + H);
    check(`11 ${b.kind}边界 ${b.ex} ${new Date(b.t).toISOString().slice(0, 13)}Z（前1h vs 后1h）`,
      flipped || capFlipped,
      `前 ${tag(A)} ／ 后 ${tag(B)}${(flipped || capFlipped) ? '' : '（结果与能力清单都没变）'}`);
    /* 工具上线日若同时改「有没有融资」⇒ 空头侧必须跟着翻（杠杆做空要先借到币） */
    const finA = C.hasFinancingAt(b.t - H, b.ex), finB = C.hasFinancingAt(b.t + H, b.ex);
    if (finA !== finB) {
      const SA = await probe({ ex: b.ex, t: b.t - H, side: 'short', cash: 800 });
      const SB = await probe({ ex: b.ex, t: b.t + H, side: 'short', cash: 800 });
      check(`11 融资闸随 ${b.ex} 边界开启（空头理由翻转）${new Date(b.t).toISOString().slice(0, 13)}Z`,
        (SA.why || '') !== (SB.why || ''), `前 ${tag(SA)} ／ 后 ${tag(SB)}`);
    }
  }

  /* ── 停机窗口：±1h 在 1 小时窗口上可能整段落在窗口之外 ⇒ 单独锁「窗口内拒 / 恢复即放」 ── */
  for (const ex of C.EXCHANGES) for (const h of ex.halts || []) {
    const inWin = await probe({ ex: ex.id, t: h.from });
    const outWin = await probe({ ex: ex.id, t: h.to });
    check(`11 停机窗口内只平不开（${ex.id} ${new Date(h.from).toISOString().slice(0, 13)}Z）`,
      !inWin.ok && /停机维护/.test(inWin.why || ''), tag(inWin));
    check(`11 停机窗口结束即恢复开仓（${ex.id} ${new Date(h.to).toISOString().slice(0, 13)}Z）`,
      outWin.ok, tag(outWin));
  }

  /* ── 全时间线粗粒度扫描：每个采样点权益有限、持仓无 NaN / 非正字段 ── */
  {
    const st = await mk({ sym: 'BTC', cash: 1000 });
    st.hintOn = false;                        // 免去破产预警遮罩（它会让时钟停下、扫描卡住）
    for (const sy of ['BTC', 'ETH', 'XRP', 'DOGE', 'SOL']) await market.loadCoin(sy);
    let samples = 0, nanEq = 0, badPos = 0, heldSamples = 0;
    while (samples < 200 && st.i < st.endI - 1) {
      if (st.pending) st.pending = null;
      if (!st.over && Object.keys(st.positions).length === 0) {
        st.sym = 'BTC'; st.mode = 'margin'; st.lev = 1;
        engine.openTrade(st, 'long', 1);       // 建一条 1x 多头：不借钱、不爆仓，全程有仓可查
      }
      for (let k = 0; k < 720 && st.i < st.endI - 1; k++) engine.advanceOneHour(st);
      samples++;
      if (!Number.isFinite(engine.equity(st))) nanEq++;
      for (const sy of Object.keys(st.positions)) {
        const p = st.positions[sy];
        if (!(Number.isFinite(p.entry) && p.entry > 0
          && Number.isFinite(p.size) && p.size > 0
          && Number.isFinite(p.notional) && p.notional > 0
          && Number.isFinite(p.margin) && p.margin > 0)) badPos++;
      }
      if (Object.keys(st.positions).length) heldSamples++;
      if (st.over) break;
    }
    check('11 全时间线扫描：每个采样点权益有限', nanEq === 0, `${samples} 个采样点（步长 720h）`);
    check('11 全时间线扫描：持仓无 NaN 价格 / 非正仓位', badPos === 0, `异常 ${badPos} 处`);
    check('11 全时间线扫描：采样期确有持仓被检到（非空转）', heldSamples > 0, `${heldSamples}/${samples} 个采样点持仓`);
  }

  /* ── 挑战局 vs 经典局：终点不同，且挑战局确实落在自己的 endI ── */
  {
    const classicEnd = C.scenarioEndIndex('classic');
    const chalEnd = C.scenarioEndIndex('degen');
    const chal = createState('degen');
    check('11 经典局终点 = GAME.candles（与改动前逐位相同）', classicEnd === C.GAME.candles, `${classicEnd} vs ${C.GAME.candles}`);
    check('11 挑战局终点与经典局不同', chalEnd !== classicEnd, `degen ${chalEnd} vs classic ${classicEnd}`);
    check('11 挑战局 s.endI === scenarioEndIndex(scen)', chal.endI === chalEnd, `${chal.endI} vs ${chalEnd}`);
    let n = 0;
    while (!chal.over && n < 6000) { if (chal.pending) chal.pending = null; engine.advanceOneHour(chal); n++; }
    check('11 挑战局走满后确在 s.endI 结算（不陪跑到 2024）',
      !!chal.over && chal.over.reason === 'settled' && chal.i === chal.endI - 1,
      `${JSON.stringify(chal.over)} i=${chal.i} endI=${chal.endI}`);
  }
}

/* ═══════════════════ 12 · 称号三轴：覆盖矩阵 ＋ fuzz（无缺口） ═══════════════════ */
section('12 · 称号三轴：主称号 / 风格称号 / 徽章 —— 覆盖矩阵 ＋ 随机 fuzz（无缺口）');
{
  /* ⚠️ `titles.js` 是**纯函数**（不读 localStorage、不碰 DOM），所以本小节既不用打桩、也不改 src。 */
  const T = await import('../src/core/titles.js');
  const { OVER } = engine;

  /* 一条完整档案记录的**标准底稿**（键名照抄 `engine.recordCareer`），各画像只覆盖差异字段。 */
  const rec = (o = {}) => ({
    scen: 'classic', reason: OVER.SETTLED,
    start: Date.UTC(2018, 0), end: Date.UTC(2023, 0), days: 1000,
    cash0: 1000, final: 2000, peak: 2000, realized: 0,
    open: 10, win: 5, loss: 5, liq: 0,
    margin: 10, fut: 0, maxLev: 2,
    move: 0, god: false, loan: 0,
    syms: ['BTC', 'ETH', 'SOL'], eq: [1000, 2000],
    ...o,
  });

  /* ── A · 12 种「玩家画像」→ 风格称号逐条命中 ──────────────────────
     「全量模拟不同玩家的操作」落到**记录层**：每一种操作风格（空仓 / 反复爆仓 / 极限杠杆 /
     满世界搬家 / 借救济金 / 高频 / 单币 / 多币 / 偏爱合约 / 偏爱杠杆 / 低频长持 / 均衡）
     各造一条画像，都能**唯一命中**对应的一枚风格称号。 */
  const STYLES = [
    ['空仓看客', { open: 0, margin: 0, win: 0, loss: 0, maxLev: 1 }],
    ['不死鸟', { open: 20, liq: 15, maxLev: 5 }],
    ['梭哈战神', { open: 5, fut: 3, margin: 2, maxLev: 125 }],
    ['逐利游牧', { open: 5, move: 12, maxLev: 5 }],
    ['向死而生', { open: 5, loan: 1, maxLev: 5 }],
    ['高频猎手', { open: 150, days: 1000, maxLev: 5 }],
    ['单币信徒', { open: 20, syms: ['BTC'], maxLev: 5 }],
    ['全能多面手', { open: 20, syms: ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP'], maxLev: 5 }],
    ['合约狂人', { open: 15, fut: 12, margin: 3, maxLev: 10 }],
    ['杠杆老兵', { open: 15, fut: 0, margin: 15, maxLev: 10 }],
    ['长线猎手', { open: 10, fut: 5, margin: 5, days: 1000, maxLev: 3 }],
    ['稳健交易员', { open: 6, fut: 3, margin: 3, days: 200, maxLev: 3 }],
  ];
  const STYLE_SET = new Set(STYLES.map(([w]) => w));
  for (const [want, o] of STYLES) {
    const got = T.styleOf(rec(o));
    check(`12 画像 «${want}» 命中风格称号`, got === want, got === want ? '' : `实得 «${got}»`);
  }

  /* ── B · 徽章池 20 枚全部可达（无死徽章）＋ 输出无未登记名称 ── */
  const ALL_BADGES = [
    '躺平', '现货党', '杠杆党', '百倍玩家', '杠杆赌徒',
    '单一信仰', '五币全通', '九死一生', '爆仓机器',
    '搬家达人', '续命者', '上帝之手', '交易狂魔', '闪电战', '长跑选手',
    '过山车', '落袋为安', '给交易所打工', '神枪手', '危机幸存者',
  ];
  const BADGE_PROFILES = [
    rec({ open: 0, margin: 0, win: 0, loss: 0, maxLev: 1 }),        // 躺平
    rec({ open: 5, fut: 0, maxLev: 1 }),                            // 现货党
    rec({ open: 5, fut: 0, maxLev: 5 }),                            // 杠杆党
    rec({ open: 5, fut: 5, maxLev: 100 }),                          // 百倍玩家
    rec({ open: 5, fut: 5, maxLev: 30 }),                           // 杠杆赌徒
    rec({ syms: ['BTC'] }),                                         // 单一信仰
    rec({ syms: ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP'] }),            // 五币全通
    rec({ liq: 60 }),                                               // 九死一生
    rec({ liq: 25 }),                                               // 爆仓机器
    rec({ move: 10 }),                                              // 搬家达人
    rec({ loan: 1 }),                                               // 续命者
    rec({ god: true }),                                             // 上帝之手
    rec({ open: 200 }),                                             // 交易狂魔
    rec({ open: 3, days: 20 }),                                     // 闪电战
    rec({ days: 3650 }),                                            // 长跑选手
    rec({ peak: 10000, final: 1500 }),                              // 过山车
    rec({ realized: 500 }),                                         // 落袋为安
    rec({ open: 60, final: 500 }),                                  // 给交易所打工
    rec({ win: 12, loss: 3 }),                                      // 神枪手
    rec({ start: Date.UTC(2019, 0), end: Date.UTC(2021, 0) }),      // 危机幸存者
  ];
  const seen = new Set();
  for (const p of BADGE_PROFILES) for (const b of T.badgesOf(p)) seen.add(b);
  const missBadge = ALL_BADGES.filter(b => !seen.has(b));
  const unknownBadge = [...seen].filter(b => !ALL_BADGES.includes(b));
  check('12 徽章池恰 20 枚', ALL_BADGES.length === 20, `${ALL_BADGES.length}`);
  check('12 徽章 20 枚全部可达（无死徽章）', missBadge.length === 0,
    missBadge.length ? `缺 ${missBadge.join(' / ')}` : `覆盖 ${seen.size} / 20`);
  check('12 徽章输出无未登记名称', unknownBadge.length === 0, unknownBadge.join(' / ') || '');

  /* ── C · fuzz：在**行为空间**上随机撒 4000 个点，验证三轴永不返回空 ──────────────────────
     ⚠️ 固定种子（LCG）⇒ 每次跑出的数完全一样，不引入偶发红灯。 */
  let seed = 20261004;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pick = n => Math.floor(rnd() * n);
  const reasons = [OVER.LIQUIDATED, OVER.SETTLED, OVER.GAVEUP];
  let emptyStyle = 0, unknownStyle = 0, emptyTitle = 0, dupBadge = 0, maxBadges = 0;
  for (let n = 0; n < 4000; n++) {
    const symCount = pick(7);
    const open = pick(300);
    const r = rec({
      reason: reasons[pick(3)],
      start: Date.UTC(2013 + pick(10), pick(12)),
      end: Date.UTC(2015 + pick(10), pick(12)),
      days: pick(4000),
      cash0: [0, 1, 1000, 100000][pick(4)],
      final: pick(1e9),
      peak: pick(1e10),
      realized: pick(2e6) - 1e6,
      open, win: pick(open + 1), loss: pick(open + 1), liq: pick(120),
      margin: pick(open + 1), fut: pick(open + 1),
      maxLev: [1, 2, 5, 20, 50, 100, 125][pick(7)],
      move: pick(20), god: rnd() < 0.1, loan: pick(3),
      syms: Array.from({ length: symCount }, (_, k) => 'C' + k),
    });
    const st = T.styleOf(r);
    if (!st || typeof st !== 'string') emptyStyle++;
    else if (!STYLE_SET.has(st)) unknownStyle++;
    const bs = T.badgesOf(r);
    if (new Set(bs).size !== bs.length) dupBadge++;
    if (bs.length > maxBadges) maxBadges = bs.length;
    const ti = T.titleOf(r);
    if (!ti || typeof ti !== 'string') emptyTitle++;
  }
  check('12 fuzz ×4000：风格称号永不为空', emptyStyle === 0, `空 ${emptyStyle} 次`);
  check('12 fuzz ×4000：风格称号恒在已登记 12 档内', unknownStyle === 0, `越界 ${unknownStyle} 次`);
  check('12 fuzz ×4000：主称号永不为空', emptyTitle === 0, `空 ${emptyTitle} 次`);
  check('12 fuzz ×4000：单局徽章无重复', dupBadge === 0, `重复 ${dupBadge} 次`);
  /* 理论上界 14：工具 1 ＋ 杠杆烈度 1 ＋ 分散度 1 ＋ 爆仓 1 ＋ 行为 5（闪电战 / 长跑选手互斥）
     ＋ 曲线 3 ＋ 神枪手 1 ＋ 危机幸存者 1 —— 海报两行放得下的上限。 */
  check('12 fuzz：单局徽章数 ≤ 14（海报两行放得下）', maxBadges <= 14, `实测最多 ${maxBadges} 枚`);

  /* ── D · 真引擎端到端：真打一局 ⇒ 真实 `s.stat` 摊成记录 ⇒ 三轴合计 ≥ 2 枚称号 ── */
  {
    const s = await mk({ scen: 'classic', sym: 'BTC', mode: 'margin', cash: 200000, i: idx(at(2021, 5)) });
    s.mode = 'margin'; s.lev = 3;
    let opened = 0;
    for (let k = 0; k < 40 && !s.over; k++) {
      if (s.pending) s.pending = null;
      if (Object.keys(s.positions).length === 0) {
        if (engine.openTrade(s, 'long', 0.3).ok) opened++;
      } else {
        engine.closeTrade(s, '测试');
      }
      engine.advanceOneHour(s);
    }
    let peak = engine.equity(s);
    for (const v of s.eq) if (v > peak) peak = v;
    const r = rec({
      reason: s.over ? s.over.reason : OVER.SETTLED,
      start: C.GAME.start + s.day0 * 24 * H,
      end: engine.timeOf(s),
      days: Math.max(1, Math.round((s.i - s.day0 * 24) / 24)),
      cash0: s.cash0, final: engine.equity(s), peak, realized: s.realized,
      open: s.stat.open, win: s.stat.win, loss: s.stat.loss, liq: s.stat.liq,
      margin: s.stat.margin, fut: s.stat.fut, maxLev: s.stat.maxLev,
      move: s.stat.move, god: s.stat.god, loan: s.stat.loan,
      syms: Object.keys(s.stat.syms),
    });
    check('12 真引擎跑一局：确实开过仓（统计非空转）', opened > 0 && s.stat.open > 0,
      `open=${s.stat.open} liq=${s.stat.liq} 胜/负=${s.stat.win}/${s.stat.loss}`);
    check('12 真引擎跑一局：风格称号非空且在已登记清单内',
      !!T.styleOf(r) && STYLE_SET.has(T.styleOf(r)), `«${T.styleOf(r)}»`);
    check('12 真引擎跑一局：主称号 ＋ 风格称号合计 ≥ 2 枚',
      !!T.titleOf(r) && !!T.styleOf(r), `${T.titleOf(r)} · ${T.styleOf(r)} · 徽章 ${T.badgesOf(r).length} 枚`);
  }
}

/* ═══════════════════ 总账 ═══════════════════ */
section('总账');
console.log(`通过 ${pass} · 失败 ${fail}`);
if (bad.length) { console.log('阻塞项：'); for (const b of bad) console.log('  ✗ ' + b); }
process.exitCode = fail ? 1 : 0;
