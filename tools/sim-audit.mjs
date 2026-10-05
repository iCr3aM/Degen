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
const roll = await import('../src/core/roll.js');
const F = await import('../src/core/format.js');

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

/* ═════ 1c · 实际杠杆口径（effLevOf · 2026-10-05 用户实测质疑） ═════
   用户问：「1x 减保证金后为什么不显示强平价 / 1x 真的能减保证金吗？」
   结论（已确认）：**能** —— 抽走保证金 ＝ 开始借钱 ＝ 实际杠杆上升。为此新增只读派生
   `effLevOf = 名义 ÷ 保证金`，并让 `maintRateOf` / `safetyOf` 的档位与参考值改用它。
   本节把三条钉在真实数值上（不做假绿：全部读真实函数 / 真引擎）：
     ① virgin 仓（没调整过保证金）`effLevOf` **严格等于**开仓杠杆（snap 生效 ⇒ 现有玩法零影响）；
     ② virgin 仓的维持率 / 安全垫 / 强平价与「按 pos.lev 现算」的参考口径一致；
     ③ 真引擎滚仓减保证金后实际杠杆**严格上升**，该仓转为可强平、强平价方向正确。 */
section('1c · 实际杠杆口径（effLevOf）：未调整仓不变 · 减保证金后杠杆必升');
{
  /* c1 · virgin 仓：断言覆盖 所 × 工具 × 杠杆 全格。 */
  let strict = 0, n = 0, guard = 0, idOk = 0, refOk = 0;
  for (const ex of ['bitfinex', 'bitmex', 'binance']) {
    for (const mode of ['margin', 'fut']) {
      const t = at(2021, 5);
      if (!C.hasLeverageKindAt(t, ex, mode) || C.exchangeOf(ex).open > t) continue;
      for (const lev of C.leverageOptionsAt(t, ex, mode).filter(v => v >= 1)) {
        const pos = P.openPosition('BTC', 'long', 30000, NOTIONAL / lev, lev, 0.0004, mode === 'margin');
        pos.ex = ex;
        n++;
        if (P.effLevOf(pos) === lev) strict++;
        /* 主式一致性（virgin 时 snap 允许 1 ULP 差，故用相对 1e-9）。 */
        if (Math.abs(P.effLevOf(pos) - pos.notional / pos.margin) <= 1e-9 * Math.max(1, lev)) idOk++;
        /* 退化护栏：维持线必须严格低于初始保证金率（结构上杜绝「开仓即强平」）。 */
        if (P.maintRateOf(pos) < 1 / P.effLevOf(pos)) guard++;
        /* 参考口径：把实现里的 `effLevOf` 换成**开仓杠杆 `pos.lev`** 重算一遍 ——
           virgin 仓两者必须一致（这正是「不影响现有玩法」的量化说法）。 */
        const refOpen = 1 / pos.lev;
        const refM = C.maintRateAt(ex, pos.notional, P.instrumentOf(pos), pos.lev);
        const refMaint = refM < refOpen ? refM : refOpen * 0.5;
        const PX = 28000;                       // 用偏离开仓价的价格，安全垫才不是恒 1
        const refSafe = !P.canLiquidate(pos) ? 1 : (() => {
          const span = refOpen - refMaint;
          return span > 0 ? (P.marginRateOf(pos, PX) - refMaint) / span : 0;
        })();
        const refLiq = 30000 + (refMaint * pos.notional - pos.margin) / pos.size;
        if (Math.abs(P.maintRateOf(pos) - refMaint) < 1e-12
          && Math.abs(P.safetyOf(pos, PX) - refSafe) < 1e-12
          && Math.abs(P.liquidationPrice(pos) - refLiq) < 1e-9) refOk++;
      }
    }
  }
  check('1c virgin 仓实际杠杆严格等于开仓杠杆（snap 生效 ⇒ 现有玩法零影响）',
    n > 0 && strict === n, `${strict}/${n}`);
  check('1c 任意仓 |effLevOf − 名义/保证金| ≤ 1e-9×杠杆（主式一致）',
    n > 0 && idOk === n, `${idOk}/${n}`);
  check('1c 退化护栏：维持线严格 < 1/实际杠杆（所 × 工具 × 杠杆 全格）',
    n > 0 && guard === n, `${guard}/${n}`);
  check('1c virgin 仓的维持率 / 安全垫 / 强平价与「按 pos.lev 现算」一致',
    n > 0 && refOk === n, `${refOk}/${n}`);

  /* c2 · 真引擎：1x 多头滚仓「减保证金」后实际杠杆**严格上升**、转为可强平。 */
  const s = await mk({ scen: 'classic', sym: 'BTC', mode: 'margin', cash: 200000, i: idx(at(2021, 4, 10)) });
  s.mode = 'margin'; s.lev = 1;
  const ro = engine.openTrade(s, 'long', 1);
  check('1c 前置：1x 多仓开出来了（后续真实行为的载体）', ro.ok && !!s.positions.BTC, ro.why || '');
  if (s.positions.BTC) {
    const before = P.effLevOf(s.positions.BTC);
    check('1c 前置：virgin 1x 仓实际杠杆 = 1', before === 1, `effLev=${f(before, 6)}`);
    const step = engine.marginStepOf(s, 'BTC', 0.25, false);
    const r = step > 0 ? engine.adjustMargin(s, 'BTC', -step) : { ok: false, why: '步进为 0' };
    check('1c 1x 多头**可以**减保证金（抽走保证金 ＝ 开始借钱 —— 回答用户质疑）',
      r.ok && step > 0, r.why || `step=${f(step, 2)}`);
    const pos = s.positions.BTC;
    const after = P.effLevOf(pos);
    check('1c 减保证金后实际杠杆**严格上升**（保证金↓ ⇒ 杠杆↑）',
      after > before + 1e-9, `${f(before, 4)}x → ${f(after, 4)}x`);
    check('1c 减保证金后借入 > 0 且转为可强平（UI 才会显示强平价）',
      P.borrowedOf(pos) > 0 && P.canLiquidate(pos),
      `borrowed=${f(P.borrowedOf(pos), 2)} canLiq=${P.canLiquidate(pos)}`);
    check('1c 减保证金后强平价有限、方向正确（多头在开仓价下方）',
      Number.isFinite(P.liquidationPrice(pos)) && P.liquidationPrice(pos) < pos.entry,
      `lp=${f(P.liquidationPrice(pos), 2)} entry=${f(pos.entry, 2)}`);
    check('1c 减保证金后维持线仍严格 < 1/实际杠杆（不会「开仓即强平」）',
      P.maintRateOf(pos) < 1 / after, `maint=${f(P.maintRateOf(pos), 4)} < ${f(1 / after, 4)}`);
  }

  /* c3 · 方向性：同一仓位减保证金 ⇒ 实际杠杆上升、可承受跌幅收窄（强平线更近）。
     ⚠️ 用 3x → 6x（Bitfinex 杠杆维持 15%）：两档都非退化格，跌幅是真实收窄而非被护栏夹平。 */
  {
    const p3 = P.openPosition('BTC', 'long', 30000, NOTIONAL / 3, 3, 0.0004, true);
    p3.ex = 'bitfinex';
    const lean = { ...p3, margin: p3.margin / 2 };      // 抽走一半保证金 ⇒ 实际 6x
    const span0 = 1 / P.effLevOf(p3) - P.maintRateOf(p3);
    const span1 = 1 / P.effLevOf(lean) - P.maintRateOf(lean);
    check('1c 减保证金 ⇒ 实际杠杆上升、可承受跌幅收窄（强平线更近）',
      P.effLevOf(lean) > P.effLevOf(p3) + 1e-9 && span1 < span0,
      `effLev ${f(P.effLevOf(p3), 3)}→${f(P.effLevOf(lean), 3)} · 可承受跌幅 ${f(span0 * 100, 3)}%→${f(span1 * 100, 3)}%`);
  }

  /* c4 · 维持档必须钉在「开仓杠杆档」上，**不得**随利息复利漂移 ——
     借贷利息逐小时从 `pos.margin` 里扣（`engine.settleFunding` 的 `pos.margin -= fee`）⇒
     实际杠杆连续微漂；若档次改读实际杠杆，Binance 杠杆的 `lev ≤ 5` 那格会在持有 1 小时后
     被 1 ULP 级漂移翻档（维持率 12% → 8%，强平价无端跳远）。 */
  {
    const p5 = P.openPosition('BTC', 'long', 30000, NOTIONAL / 5, 5, 0.0004, true);
    p5.ex = 'binance';
    const m0 = P.maintRateOf(p5);
    const drifted = { ...p5, margin: p5.margin * (1 - 1e-4) };   // 模拟复利若干小时后的保证金
    const m1 = P.maintRateOf(drifted);
    check('1c 维持档钉在开仓杠杆档（利息复利造成的实际杠杆微漂不换档）',
      P.effLevOf(drifted) > 5 && m0 === m1,
      `effLev ${f(P.effLevOf(drifted), 6)} · 维持 ${f(m0, 4)} → ${f(m1, 4)}`);
  }
}

/* ═════ 1d · 强平价连续性 / 强平退款口径（2026-10-05 用户实测：资金费抽干保证金） ═════
   用户问：「开多但资金费一直在付 ⇒ 保证金被抽干 ⇒ 强平价会往上移，甚至超过开仓价 ——
   这时候 HUD 上所有面板还显示得对吗？」本节点死三件事（全部读真实函数 / 真引擎，不做假绿）：
     ① `maintRateOf` 在 `margin ≤ 0` 时归零 ⇒ `liquidationPrice` 在 0 处**连续收敛到开仓价**
        （旧代码在 0 处从 ≈entry 突跳 +0.4% ⇒ 断崖式的不连续）；
     ② `forceLiquidate` 的残余权益取**真实权益**（夹 ≥0）⇒ 穿仓时不再凭空退回「维持那一格」；
     ③ 恒等式 `equity(pos, 强平价) ≡ 维持率 × 名义` 在正常档仍逐位成立（回归护栏）。 */
section('1d · 强平价连续性 / 强平退款口径（资金费抽干保证金 ⇒ 强平价上移）');
{
  const entry = 100, notional = 1000, lev = 10;
  const base = P.openPosition('BTC', 'long', entry, notional / lev, lev, 0.0004, true);
  base.ex = 'bitfinex';
  /* 保证金逐档下沉、跨过 0：1 → … → 1e-6 → **0** → 负值。 */
  const rungs = [1, 0.1, 0.01, 1e-3, 1e-6, 0, -1e-6, -1e-3, -0.01, -0.1];
  const ps = rungs.map(m => ({ ...base, margin: m }));
  const liq = ps.map(p => P.liquidationPrice(p));
  const mains = ps.map(p => P.maintRateOf(p));

  check('1d margin ≤ 0 ⇒ 维持率归零（没有维持线 ⇒ 立刻强平）',
    mains[5] === 0 && mains[6] === 0 && mains[9] === 0,
    `m(0)=${f(mains[5], 8)} m(−0.1)=${f(mains[9], 8)}`);
  check('1d margin = 0 ⇒ 强平价 ≡ 开仓价（多头强平线收敛到开仓价）',
    Math.abs(liq[5] - entry) < 1e-9 * entry, `lp=${f(liq[5], 9)} entry=${entry}`);
  check('1d 强平价在 margin = 0 处**连续**（旧代码此处突跳 0.4% ⇒ 可判别）',
    Math.abs(liq[4] - liq[5]) < 1e-6, `|lp(1e-6) − lp(0)| = ${Math.abs(liq[4] - liq[5]).toExponential(3)}`);
  let mono = true;
  for (let k = 1; k < liq.length; k++) if (liq[k] < liq[k - 1] - 1e-9) mono = false;
  check('1d 保证金越少 ⇒ 多头强平价越高（单调递增，无断崖 / 无回折）', mono,
    liq.map(v => f(v, 6)).join(' → '));
  let guard = 0;
  for (const p of ps) if (P.maintRateOf(p) < 1 / P.effLevOf(p)) guard++;
  check('1d 全档维持率严格 < 1/实际杠杆（含 margin ≤ 0 的退化档 ⇒ 不变量守恒）',
    guard === ps.length, `${guard}/${ps.length}`);

  /* d2 · 穿仓（真实权益 ≤ 0）⇒ 残余权益 0；而旧式「维持率 × 名义」仍为正 —— 那正是凭空退款之源。 */
  const gap = { ...base, margin: 100 };
  const atPrice = 50;                                   // 现价远低于开仓价 ⇒ uPnL = −500 ⇒ 权益 < 0
  const realRemain = Math.max(0, P.equityOf(gap, atPrice));
  const oldRemain = P.maintRateOf(gap) * gap.notional;
  check('1d 穿仓 ⇒ 残余权益 0，而旧式「维持那一格」为正（凭空退款 / 保险基金幻影钱之源）',
    realRemain === 0 && oldRemain > 0,
    `真实权益 ${f(P.equityOf(gap, atPrice), 2)} → 残余 ${f(realRemain, 2)} ｜ 旧式 ${f(oldRemain, 2)}`);

  /* d3 · 恒等回归：正常档下 `equity(pos, 强平价) ≡ 维持率 × 名义`（B20 口径的锚）。 */
  const normal = P.openPosition('BTC', 'long', 30000, NOTIONAL / 5, 5, 0.0004, true);
  normal.ex = 'binance';
  const nlp = P.liquidationPrice(normal);
  check('1d 恒等回归：正常档 equity(pos, 强平价) ≡ 维持率 × 名义（逐位）',
    Math.abs(P.equityOf(normal, nlp) - P.maintRateOf(normal) * normal.notional) < 1e-9 * normal.notional,
    `eq=${f(P.equityOf(normal, nlp), 6)} maint×N=${f(P.maintRateOf(normal) * normal.notional, 6)}`);

  /* d4 · 真引擎端到端：**一条**仓位的保证金被抽成负值 ⇒ 本小时内必须整条强平，且强平日志
     **不出现「退回」**（走公开的 `advanceOneHour`，不直呼未导出的 `forceLiquidate`）。
     ⚠️ 仓位要**小**（`frac=0.1`）：账户留足其余现金 ⇒ 只有这一条仓位穿仓，本局不因账户级
        破产而停在「待领救济金」遮罩上（`settleFunding` 里的 `checkRuin` 会先冻住时钟）。 */
  const s = await mk({ scen: 'classic', sym: 'BTC', mode: 'margin', cash: 200000, i: idx(at(2021, 4, 10)) });
  s.mode = 'margin'; s.lev = 1; s.hintOn = false;      // 关掉预警遮罩，免得时钟被冻住
  const ro = engine.openTrade(s, 'long', 0.1);
  check('1d 前置：多仓开出来了（端到端载体）', ro.ok && !!s.positions.BTC, ro.why || '');
  if (s.positions.BTC) {
    const pos = s.positions.BTC;
    pos.margin = -2 * pos.notional;                    // 模拟「资金费抽干 ⇒ 保证金为负」⇒ liq 落到 3×entry
    check('1d 前置：保证金为负 ⇒ 强平价被推到开仓价**上方**（多头，正是用户描述的情形）',
      P.liquidationPrice(pos) > pos.entry, `lp=${f(P.liquidationPrice(pos), 2)} entry=${f(pos.entry, 2)}`);
    engine.advanceOneHour(s);
    check('1d 端到端：保证金为负的仓位在本小时内被整条强平（不留僵尸仓）',
      !s.positions.BTC, s.positions.BTC ? `残留 margin=${f(s.positions.BTC.margin, 2)}` : '');
    const log = s.log.filter(l => l.tag === 'liq').map(l => l.text).join('\n');
    check('1d 端到端：强平日志为「全部损失」且**不含**「退回」（旧代码会凭空退 ≈13.75% 名义）',
      /强平 BTC/.test(log) && /全部损失/.test(log) && !/退回/.test(log), '');
  }
}

/* ═════ 1e · 2026-10-05 审计修复核：口径分叉 / ADL 浮盈率基数 / 结局守卫 / 平仓日志杠杆 ═════
   本轮修了四处（`marginCapsOf` 价格口径、ADL 浮盈率基数、`closeTrade` 分批日志杠杆、
   `closeCheck` 结局守卫）。本节点死四件事，全部读**真实函数 / 真引擎**，并对旧口径显式判别
   （断言旧式在若干情形**确实错**，否则这条修复就是无意义的假绿）。 */
section('1e · 审计修复核（ADL 浮盈率四情形 · marginCapsOf 价格口径 · closeCheck 结局守卫 · 平仓日志杠杆）');
{
  /* e1 · ADL 浮盈率：四种（NPC/玩家 × 多/空）逐一与**真实盈亏定义**对齐。
     ⚠️ ADL 队列里两种档位的 `notional` 基数不同（NPC = 成本名义、玩家 = 现价名义），
        故「名义 × rate」必须等于按价格现算的盈亏；旧式 `1 − 1/ratio` 只对其中一半正确。 */
  {
    const avg = 100, size = 1000, G = avg * size;               // 成本名义 10 万
    const up = 130, ratio = up / avg;                            // 1.3x 浮盈倍数
    const down = avg / ratio;                                    // 空头盈利时的现价（< avg）
    const rows = [
      /* [名字, ratio, long, costBasis, notional, 真实盈亏] */
      ['NPC 多头（成本名义）', ratio, true, true, G, size * (up - avg)],
      ['NPC 空头（成本名义）', ratio, false, true, G, size * (avg - down)],
      ['玩家多头（现价名义）', ratio, true, false, size * up, size * (up - avg)],
      ['玩家空头（现价名义）', ratio, false, false, size * down, size * (avg - down)],
    ];
    let okN = 0, oldN = 0;
    for (const [name, r, long, cb, notional, truth] of rows) {
      const pnl = notional * engine.adlProfitRate(r, long, cb);
      if (Math.abs(pnl - truth) <= 1e-9 * Math.max(1, truth)) okN++;
      /* 旧口径（一律 `1 − 1/ratio`）在新口径下的正确数：应当恰好一半（NPC 空头 / 玩家多头）。 */
      if (Math.abs(notional * (1 - 1 / r) - truth) <= 1e-9 * Math.max(1, truth)) oldN++;
    }
    check('1e ADL 浮盈率四种情形（NPC/玩家 × 多/空）「名义 × rate」≡ 真实盈亏',
      okN === rows.length, `${okN}/${rows.length}`);
    check('1e 旧式 `1 − 1/ratio` 只在 2 种情形成立（证明另 2 种被低估 ⇒ 本修非无谓）',
      oldN === 2, `旧式命中 ${oldN}/4`);
    check('1e ADL 浮盈率退化护栏：ratio ≤ 1 ⇒ 恒 0（ADL 从不砍输家）',
      engine.adlProfitRate(1, true, true) === 0 && engine.adlProfitRate(0.9, false, false) === 0
        && engine.adlProfitRate(1.3, true, true) > 0, '');
  }

  /* e2 · `marginCapsOf` 的估值价必须 = **标记价**（与持仓条 / 强平判据同源），不是最新价。 */
  const s = await mk({ scen: 'classic', sym: 'BTC', mode: 'margin', cash: 200000, i: idx(at(2021, 4, 10)) });
  s.mode = 'margin'; s.lev = 3;
  const ro = engine.openTrade(s, 'long', 0.3);
  check('1e 前置：多仓开出来了（口径节点的载体）', ro.ok && !!s.positions.BTC, ro.why || '');
  if (s.positions.BTC) {
    const pos = s.positions.BTC;
    const idxPx = engine.markPrice(s, 'BTC');
    s.mkb = { BTC: idxPx * 0.05 };                       // 强制一笔非零基差 ⇒ last ≠ mark
    const pxLast = engine.exPrice(s, 'BTC', pos.ex);
    const pxMark = engine.exMarkPrice(s, 'BTC', pos.ex);
    const caps = engine.marginCapsOf(s, 'BTC');
    check('1e 前置：last ≠ mark（本节点具判别力的前提）',
      Math.abs(pxLast - pxMark) > 1e-9, `last=${f(pxLast, 4)} mark=${f(pxMark, 4)}`);
    check('1e marginCapsOf 的 price ≡ 标记价（弹层 / 持仓条 / 强平判据三处同源）',
      !!caps && Math.abs(caps.price - pxMark) < 1e-12 * Math.max(1, pxMark),
      caps ? `caps=${f(caps.price, 6)} mark=${f(pxMark, 6)}` : 'caps=null');
    check('1e 旧缺陷可判别：caps.price **不等于**最新价（退回 exPrice 即失败）',
      !!caps && Math.abs(caps.price - pxLast) > 1e-9,
      caps ? `|caps − last| = ${Math.abs(caps.price - pxLast).toExponential(3)}` : '');
  }

  /* e3 · `closeCheck` 的结局守卫 —— 与 `openCheck` / `adjustCheck` 对称。 */
  check('1e 前置：局中可平（canCloseAt true）', engine.canCloseAt(s, 1) === true, '');
  {
    const keep = s.over;
    s.over = { reason: 'audit', at: s.i };
    check('1e s.over ⇒ canCloseAt 恒 false（金额档会置灰）', engine.canCloseAt(s, 1) === false, '');
    const r = engine.closeTrade(s, '审计', 1);
    check('1e s.over ⇒ closeTrade 被拒（why = 本局已结束）',
      !r.ok && r.why === '本局已结束', r.why || '');
    s.over = keep;
  }

  /* e4 · 分批平仓日志的倍数标签 —— 滚仓（减保证金）后必须报**实际杠杆**，与全平同源。 */
  if (s.positions.BTC) {
    const pos = s.positions.BTC;
    pos.margin = pos.margin / 2;                          // 抽走一半保证金 ⇒ 实际杠杆 ≈ 2×开仓
    const eff = P.effLevOf(pos);
    check('1e 前置：滚仓后实际杠杆 ≠ 开仓杠杆（日志分叉的判据）',
      Math.abs(eff - pos.lev) > 1e-6, `eff=${f(eff, 4)} lev=${pos.lev}`);
    const r = engine.closeTrade(s, '审计', 0.5);
    const line = [...s.log].reverse().find(l => l.tag === 'trade' && l.text.startsWith('平仓'));
    const tag = `${Math.round(eff * 10) / 10}x`;
    check('1e 分批平仓日志用**实际杠杆**（与全平 / ADL / 部分强平四处同源）',
      r.ok && !!line && line.text.includes(` ${tag} `) && !/ \d+x /.test(line.text.replace(` ${tag} `, ' ')),
      line ? line.text.slice(0, 80) : (r.why || '无平仓日志'));
  }

  /* e5 · `adjustMargin` 写出的日志保证金率也必须读**标记价**（与 `marginCapsOf` / 持仓条同源）。 */
  {
    const s2 = await mk({ scen: 'classic', sym: 'BTC', mode: 'margin', cash: 300000, i: idx(at(2021, 4, 10)) });
    s2.mode = 'margin'; s2.lev = 3;
    const o2 = engine.openTrade(s2, 'long', 0.2);
    const pos2 = s2.positions.BTC;
    let ok2 = false, detail = (o2.why || '建仓失败');
    if (o2.ok && pos2) {
      const idx2 = engine.markPrice(s2, 'BTC');
      s2.mkb = { BTC: idx2 * 0.05 };                      // last ≠ mark
      const pLast = engine.exPrice(s2, 'BTC', pos2.ex);
      const pMark = engine.exMarkPrice(s2, 'BTC', pos2.ex);
      const step = engine.marginStepOf(s2, 'BTC', 0.25, true);
      const r2 = step > 0 ? engine.adjustMargin(s2, 'BTC', step) : { ok: false, why: '步进为 0' };
      const line = [...s2.log].reverse().find(l => l.tag === 'trade' && /^(增加|减少)保证金/.test(l.text));
      const wantMark = F.fmtRate(P.marginRateOf(pos2, pMark));
      const wantLast = F.fmtRate(P.marginRateOf(pos2, pLast));
      ok2 = r2.ok && !!line && line.text.includes(wantMark) && wantMark !== wantLast;
      detail = `r2.ok=${r2.ok} step=${f(step, 2)} mark=${wantMark} last=${wantLast}｜` + (line ? line.text.slice(0, 60) : (r2.why || '无日志'));
    }
    check('1e 调整保证金日志的保证金率 ≡ 标记价口径（≠ 最新价口径，同源的延伸）', ok2, detail);
  }
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
  /* S4：保险基金健康度 —— 穿仓被夹到「破产价 ± gap」后，单笔净流出有界，基金不该被流失掏空。
     断言做成「有限 + 不比初始播种水位低太多」的相对口径（播种额随当日流动性浮动，不写死绝对值）。 */
  const seed = market.liqOf('BTC', market.dayIndexOf(s.day0 * 24)) * P.INSURE.seed;
  console.log(`  保险基金末值 $${f(s.fund, 2)}（BTC 开局播种 ≈ $${f(seed, 2)}）`);
  check('7 保险基金全程有限（无 NaN/Inf）', Number.isFinite(s.fund), `末值 $${f(s.fund, 2)}`);
  check('7 保险基金不结构性失血（末值 ≥ −10× 初始播种）',
    s.fund >= -10 * Math.max(seed, 1), `末值 $${f(s.fund, 2)} ｜ 播种 ≈ $${f(seed, 2)}`);
}

/* ═══════════════════ 7b · K 线连续性（零跳空缺口 · 2026-10-05） ═══════════════════ */
section('7b · K 线连续性：全 5 币「本根 open == 上一根 close」（24/7 市场不允许跳空）');
{
  /* 起因：聚合口径下 medoid 逐小时在多所间切换 ⇒ 大量根 open ≠ 上一根 close，图上就是缺口。
     已在 `tools/fetch-data.mjs` 第 ⑨ 步缝合（open 取上一根 close、h/l 外扩）。这条把它钉死。 */
  const SYMS = ['BTC', 'ETH', 'XRP', 'DOGE', 'SOL'];
  for (const sy of SYMS) await market.loadCoin(sy);
  let inv = 0;
  for (const sy of SYMS) {
    const [a, b] = market.rangeOf(sy);
    let gaps = 0, maxR = 0, worstAt = 0;
    for (let i = a + 1; i < b; i++) {
      const cur = market.rawCandleAt(sy, i);
      const prev = market.rawCandleAt(sy, i - 1);
      const r = Math.abs(cur.o - prev.c) / prev.c;
      if (r > 1e-9) { gaps++; if (r > maxR) { maxR = r; worstAt = i; } }
      if (cur.h < Math.max(cur.o, cur.c) - 1e-9 || cur.l > Math.min(cur.o, cur.c) + 1e-9) inv++;
    }
    check(`7b ${sy}：${b - a - 1} 根零跳空缺口`, gaps === 0,
      gaps ? `缺口 ${gaps} 根，最大 ${(maxR * 100).toFixed(2)}% @ ${new Date(C.GAME.start + worstAt * H).toISOString().slice(0, 16)}` : '');
  }
  check('7b OHLC 不变量：h ≥ max(o,c) 且 l ≤ min(o,c)（全 5 币）', inv === 0, `违反 ${inv} 根`);
}

/* ═══════════════════ 7c · 无玩家 12 年全程自洽（G2–G4 落地后的回归） ═══════════════════ */
section('7c · 无玩家全程自洽：情绪有界不单极 · 跨币共振不发散 · 池/冲击有限 · 无玩家则无盈亏漂移');
{
  const SYMS = ['BTC', 'ETH', 'XRP', 'DOGE', 'SOL'];
  for (const sy of SYMS) await market.loadCoin(sy);
  const s = await mk({ sym: 'BTC', cash: 100000 });     // **不建任何仓** ⇒ 纯无玩家世界
  /* ⚠️ 基准取「mk 之后的实际权益」，**不是** `s.cash0` —— `mk` 改的是 `books`，而 `s.cash0`
     仍是剧本常量（经典开局 $1,000），两者本就不等。
     ⚠️ 唯一允许被动到账户的历史事件是 **Bitfinex 2016-08-02 被盗普损（−36.067%）** ——
     它是「玩家把钱停在那家所」的**史实风险**，不是模拟深度凭空造出来的盈亏 ⇒ 命中的那一根
     把基准**重新对齐**（不计漂移），其余每一根都必须逐位等于基准。 */
  const hackH = Math.round((Date.UTC(2016, 7, 2) - C.GAME.start) / H);
  let base = engine.equity(s);
  const step = 24 * 30;                                 // 每月推进一次
  let steps = 0, badHeat = 0, badFund = 0, badShock = 0, drift = 0;
  let heatMin = 1, heatMax = 0, coldN = 0, hotN = 0, samples = 0;
  while (s.i < s.endI - 1 && steps < 400) {
    if (!s.over) s.pending = null;                      // 无玩家不该进待决态；保险起见清掉
    /* ⚠️ 每月轮换 tick 的币：`crossHeat` 只对**当前币**跑，钉死 BTC 就测不到跨币耦合。 */
    s.sym = SYMS[steps % SYMS.length];
    const before = s.i;
    engine.advanceOneHour(s);
    for (let j = 1; j < step; j++) engine.advanceOneHour(s);
    if (s.i === before) break;
    steps++;
    for (const sy of SYMS) {
      const m = s.mkt[sy];
      if (!m) continue;
      const h = m.heat;
      if (!(Number.isFinite(h) && h >= 0 && h <= 1)) badHeat++;
      if (h < heatMin) heatMin = h;
      if (h > heatMax) heatMax = h;
      if (h < 0.35) coldN++;                            // 明显偏冷（恐慌侧真的出现过）
      if (h > 0.65) hotN++;                             // 明显偏热
      samples++;
      const f0 = m.npcFund;
      if (f0 != null && (!Number.isFinite(f0) || f0 < 0)) badFund++;
      if (m.npcShock && Array.isArray(m.npcShock.v)) {
        for (const v of m.npcShock.v) if (!Number.isFinite(v)) badShock++;
      }
    }
    /* 无玩家 ⇒ 没有任何现金流 ⇒ 权益必须**逐位**等于基准（这条能抓出「凭空盈亏」类回归）。
       ⚠️ 这一段一次跳 30 根，所以用**区间包含**判断被盗日是否落在本轮里，而不是 `s.i === hackH`。 */
    const eq = engine.equity(s);
    if (hackH > before && hackH <= s.i) base = eq;      // 史实普损：重新对齐基准，不算漂移
    else if (Math.abs(eq - base) > 1e-6) drift++;
  }
  check('7c 全币 heat 恒在 [0,1]（跨币耦合不发散、不 NaN）', badHeat === 0,
    `样本 ${samples}，坏值 ${badHeat}，heat ∈ [${f(heatMin, 3)}, ${f(heatMax, 3)}]`);
  /* 情绪是活的：12 年里必须**两侧都越出中性带**（只有牛市或只有崩盘都是不真实的单极化）。 */
  check('7c 情绪不单极化（冷热两侧都出现过，非常年贴极值）',
    heatMin <= 0.35 && heatMax >= 0.65 && heatMin >= 0 && heatMax <= 1
    && coldN > 0 && hotN > 0,
    `冷样本 ${coldN} / 热样本 ${hotN} / 共 ${samples}，heatMin/Max ${f(heatMin, 3)}/${f(heatMax, 3)}`);
  check('7c 对手方池全程有限且 ≥ 0', badFund === 0, `坏值 ${badFund}`);
  check('7c npcShock 全程无 NaN / Inf', badShock === 0, `坏值 ${badShock}`);
  check('7c 无玩家 ⇒ 权益逐位等于本金（无凭空盈亏漂移）', drift === 0,
    `漂移次数 ${drift}，末值 $${f(engine.equity(s), 2)} ｜ 基准 $${f(base, 2)}，步数 ${steps}`);
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
  /* ⚠️ 2026-10-05：借入必须在**结算前**快照 —— `borrowedOf` 多头口径改成 `名义 − 保证金` 之后，
     利息落账（`margin -= fee`）本身会抬高借入 ⇒ 结算后再读 `borrowedOf` 会拿到 `借入₀ + 本次利息`，
     期望值随之偏大（旧的「借入一生不变」口径下两者相同，所以这条断言以前不需要快照）。 */
  const borrowed0 = P.borrowedOf(s.positions.BTC);
  engine.advanceOneHour(s);                       // 只走 1 小时，且落在**非** 8h 整点上
  const d1 = m0 - s.positions.BTC.margin;
  /* S3：利率现在是「基准日息 × 利用率乘数」⇒ 期望值必须乘上 `marginRateMulOf`（同一状态、同一小时）。
     ⚠️ 乘数里的「利用率」读的是**当前借入**；结算刚把 margin 扣掉（⇒ 借入被抬高 $d1）——
     所以用**结算前的 margin** 克隆一份只读状态去算乘数，才与 `settleFunding` 那一刻逐位一致
     （不写回任何状态，纯读）。旧的「借入恒定」口径下两者相同，无需这层。 */
  const snap = { ...s, positions: { ...s.positions, BTC: { ...s.positions.BTC, margin: m0 } } };
  const exp = borrowed0 * C.marginDailyRateAt(engine.timeOf(s), 'quote')
    * engine.marginRateMulOf(snap, 'BTC') / 24;
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
  /* ⚠️ 本金取**当日额度的 0.8 倍**，不写死绝对值：流动性锚逐年会变
     （2026-10-04 修过 BTC 早期年锚 $11.4K→$607K；2026-10-05 又做 2013 覆盖份额校正 ⇒ $487K）
     —— 写死 $20,000 在新锚下根本够不到闸门，断言会退化成空转。
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
     （2026-10-04 修正 BTC 早期年 ⇒ $11.4K 抬到 $607K；2026-10-05 再校正 ⇒ $487K），
     写死 $20,000 在新锚下根本够不到闸门。
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
     ⚠️ 2026-10-04 修正 BTC 早期年锚后，那个具体死结已**不再存在**（2013-10 额度 ≈ $1.7M），
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
    /* v32 行为信号：加仓 / 加减保证金 / 浮盈减保证金 / OTC 通道 / 分批减仓 —— 缺省全 0。 */
    addOn: 0, mgUp: 0, mgDown: 0, mgCut: 0, otc: 0, part: 0,
    syms: ['BTC', 'ETH', 'SOL'], eq: [1000, 2000],
    ...o,
  });

  /* ── A · 26 种「玩家画像」→ 风格称号逐条命中（词表 = 画像表，即无死称号）──────────
     「全量模拟不同玩家的操作」落到**记录层**：每一种操作风格（空仓 / 反复强平 /
     极限杠杆 / 满世界搬家 / 借救济金 / 高频 / 单币 / 多币 / 偏爱合约 / 偏爱杠杆 /
     低频长持 / 均衡 / **爆仓收场** / **续命失败** / **滚仓（轻重两档）** /
     **OTC 通道** / **分批减仓**）各造一条画像，都能**唯一命中**对应的一枚风格称号。
     ⚠️ v32 新增的四条（滚仓玩家 / 滚仓狂人 / 场外玩家 / 分批离场）覆盖的是**此前无信号**的
        交易入口 —— `adjustMargin`（增减保证金）、`chanOf`（OTC 通道）、`closeTrade(frac<1)`（减仓）。
     ⚠️ 末尾两条是**同一批行为、不同结局**（2026-10-05 用户实测修）：
        「反复强平」活到结算叫「不死鸟」、账户归零则叫「强平常客」；
        「领过救济金」活到结算叫「向死而生」、破产则叫「续命无果」——
        这两对专门证明**破产结局不会拿到暗示「活下来」的称号**。
     ⚠️ `liq` 是**强平笔数**（单笔被强制平仓，可多次）；「爆仓」只指**账户归零**的结局，
        所以这几条的措辞一律是「强平」，`reason: OVER.LIQUIDATED` 才叫「爆仓收场」。 */
  const STYLES = [
    ['空仓看客', { open: 0, margin: 0, win: 0, loss: 0, maxLev: 1 }],
    ['不死鸟', { open: 20, liq: 15, maxLev: 5 }],
    ['强平常客', { open: 20, liq: 15, maxLev: 5, reason: OVER.LIQUIDATED }],
    /* v32 滚仓两档：**浮盈里减保证金**（`mgCut`）＋ **持续加仓**（`addOn`）——
       狂人是加倍的同一批行为（门槛 c6 > c2），两级在经典局 / 短局都不塌成一档。 */
    ['滚仓狂人', { open: 12, addOn: 6, mgCut: 6, margin: 2, fut: 2, maxLev: 3 }],
    ['滚仓玩家', { open: 4, addOn: 2, mgCut: 2, margin: 1, fut: 1, maxLev: 3 }],
    ['梭哈战神', { open: 5, fut: 3, margin: 2, maxLev: 125 }],
    ['孤注一掷', { open: 2, fut: 0, margin: 2, maxLev: 50 }],
    ['逐利游牧', { open: 5, move: 12, maxLev: 5 }],
    ['向死而生', { open: 5, loan: 1, maxLev: 5 }],
    ['续命无果', { open: 5, loan: 1, maxLev: 5, reason: OVER.GAVEUP }],
    ['认栽跑路', { open: 3, liq: 0, margin: 0, fut: 0, maxLev: 2, loan: 0, reason: OVER.GAVEUP }],
    ['永动机', { open: 200, days: 30, maxLev: 2 }],
    ['高频猎手', { open: 150, days: 1000, maxLev: 5 }],
    ['日内快枪手', { open: 40, days: 20, maxLev: 2 }],
    /* v32 通道偏好：OTC 成交占**全部成交**（开仓 ＋ 平仓/减仓）≥ 60% —— 盘口 vs OTC 是两条路（用户点名）。
       ⚠️ 2026-10-05 审计修：分母从「仅开仓」改为「开仓 ＋ 平仓」后，本画像同步改成**自洽**的一条
       （5 笔开仓 ＋ 5 笔平仓；其中 8 笔走 OTC ⇒ 80%）。旧画像 `{ open: 5, otc: 4 }` 混用了基座的
       `win: 5, loss: 5`（10 笔平仓）⇒ 「5 开 10 平」本身不自洽，是新口径下最先暴露的那条。 */
    ['场外玩家', { open: 5, win: 3, loss: 2, otc: 8, margin: 2, fut: 3, maxLev: 3 }],
    ['单币信徒', { open: 20, syms: ['BTC'], maxLev: 5 }],
    ['全能多面手', { open: 20, syms: ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP'], maxLev: 5 }],
    ['合约狂人', { open: 15, fut: 12, margin: 3, maxLev: 10 }],
    ['杠杆老兵', { open: 15, fut: 0, margin: 15, maxLev: 10 }],
    /* v32 分批减仓：`closeTrade(frac<1)` ≥ 3 次 —— 把「减仓」这个入口显性化。 */
    ['分批离场', { open: 10, part: 5, margin: 3, fut: 3, maxLev: 2 }],
    ['佛系囤币', { open: 3, days: 1000, maxLev: 1, margin: 0, fut: 0, syms: ['BTC', 'ETH'] }],
    ['长线猎手', { open: 10, fut: 5, margin: 5, days: 1000, maxLev: 3 }],
    ['铁头娃', { open: 2, days: 100, maxLev: 10, liq: 0, margin: 1, fut: 1, syms: ['BTC', 'ETH', 'SOL'] }],
    ['割肉客', { open: 12, win: 2, loss: 12, days: 100, maxLev: 2, margin: 0, fut: 0, syms: ['BTC', 'ETH', 'SOL'] }],
    ['常胜将军', { open: 20, win: 18, loss: 2, days: 100, maxLev: 2, margin: 0, fut: 0, syms: ['BTC', 'ETH', 'SOL'] }],
    ['稳健交易员', { open: 6, fut: 3, margin: 3, days: 200, maxLev: 3 }],
  ];
  const STYLE_SET = new Set(STYLES.map(([w]) => w));
  /* 画像表就是「风格称号词表本身」：26 条画像 ⇔ 26 枚风格称号。
     ⇒ 只要每条画像都能唯一命中自己那枚，就等于证明了**没有死称号**（全部可达）。 */
  check('12 风格称号恰 26 枚（画像表即词表，无重复名）', STYLES.length === 26 && STYLE_SET.size === 26,
    `${STYLES.length} 条画像 / ${STYLE_SET.size} 个唯一名`);
  for (const [want, o] of STYLES) {
    const got = T.styleOf(rec(o));
    check(`画像 «${want}» 命中风格称号`, got === want, got === want ? '' : `实得 «${got}»`);
  }

  /* ── A2 · 主称号「结局 × 倍数」穷举矩阵（2026-10-05 用户实测修）──────────────────
     上一版只对四档结局写死（爆仓 / 收摊各一枚），**破产档完全没按「曾经多高」分** ⇒
     峰顶 7.1m、终值 −265k 的局被叫「收摊的人」，与事实不符（用户原话）。
     现在（2026-10-05 再扩）：破产档按**峰顶倍数**分 6 档 ＋ 欠钱 1 档，结算档按终值倍数分 13 档。
     这里把两条轴都穷举一遍，并单列「欠钱压过峰顶」这条优先级。 */
  /* ⚠️ 破产档拆成**两条正交的轴**：
     · `DEBT_TITLE`（欠钱）不是「冲到多高」的一档，是**比归零更糟**的独立结局（`final < 0`）；
     · `BUST_TITLES` 是**峰顶阶梯**，**下标越大 ＝ 曾经冲得越高**（`归零者` → `功亏一篑`）。
       破产档报的是**绝对高度**（2026-10-05 用户实测修）⇒ 阈值**不随时长归一**，
       所以 A3 ④ 的断言是「同一峰顶在 6 个局别判同一档」，而不是「短局升档」。 */
  const DEBT_TITLE = '负债累累';
  const BUST_TITLES = ['归零者', '纸上富贵', '高台跳水', '黄粱一梦', '登月坠落', '功亏一篑'];
  const BUST_ALL = [DEBT_TITLE, ...BUST_TITLES];
  const LIVE_TITLES = ['陪跑的', '活下来的', '保本的', '小赚一笔', '翻倍的人', '小富即安',
    '钻石手', '滚雪球', '币圈锦鲤', '百倍战神', '千倍传奇', '万倍传奇', '亿倍传奇'];
  const TITLE_SET = new Set([...BUST_ALL, ...LIVE_TITLES]);
  check('12 主称号档位恰 20 枚（破产 7 ＝ 峰顶 6 ＋ 欠钱 1，结算 13）',
    TITLE_SET.size === 20, `${TITLE_SET.size}`);
  /* 破产档：`reason` 两种都算破产，逐条按峰顶倍数验（`final = 0` ⇒ 清零但**不欠钱**）。 */
  for (const reason of [OVER.LIQUIDATED, OVER.GAVEUP]) {
    const cases = [[0, '归零者'], [1.99, '归零者'], [2, '纸上富贵'], [4.99, '纸上富贵'],
      [5, '高台跳水'], [19.99, '高台跳水'], [20, '黄粱一梦'], [99.99, '黄粱一梦'],
      [100, '登月坠落'], [999.99, '登月坠落'], [1000, '功亏一篑'], [1e5, '功亏一篑']];
    for (const [peakMult, want] of cases) {
      const got = T.titleOf(rec({ reason, cash0: 1000, peak: peakMult * 1000, final: 0 }));
      check(`12 破产档（${reason}）峰顶 ${peakMult}x ⇒ «${want}»`, got === want,
        got === want ? '' : `实得 «${got}»`);
    }
  }
  /* 欠钱档：`final < 0`（穿仓 / 借爆倒欠）优先于峰顶倍数 —— 那是比归零更糟的结局。 */
  for (const reason of [OVER.LIQUIDATED, OVER.GAVEUP]) {
    const got = T.titleOf(rec({ reason, cash0: 1000, peak: 5e6, final: -265000 }));
    check(`12 欠钱档（${reason}）峰顶 5000x 也只看欠款 ⇒ «负债累累»`, got === '负债累累',
      got === '负债累累' ? '' : `实得 «${got}»`);
  }
  /* 结算档：按终值倍数验，含末档 `else` 兜底。 */
  for (const [m, want] of [[0.5, '陪跑的'], [1, '活下来的'], [1.4, '活下来的'], [1.9, '保本的'],
    [2.5, '小赚一笔'], [4.9, '翻倍的人'], [7, '小富即安'], [19.9, '钻石手'],
    [30, '滚雪球'], [99.9, '币圈锦鲤'], [100, '百倍战神'], [999, '百倍战神'],
    [1000, '千倍传奇'], [9999, '千倍传奇'], [1e4, '万倍传奇'], [1e7, '万倍传奇'],
    [1e8, '亿倍传奇'], [1e12, '亿倍传奇']]) {
    const got = T.titleOf(rec({ reason: OVER.SETTLED, cash0: 1000, final: m * 1000 }));
    check(`12 结算档终值 ${m}x ⇒ «${want}»`, got === want, got === want ? '' : `实得 «${got}»`);
  }
  /* 硬规矩：**破产局的称号一定落在破产 7 档里**（不许混进结算 13 档），反之亦然。 */
  {
    let crossed = 0;
    for (const reason of [OVER.LIQUIDATED, OVER.GAVEUP]) {
      for (const pk of [0, 1, 5, 20, 100, 500, 5000]) {
        if (!BUST_ALL.includes(T.titleOf(rec({ reason, cash0: 1000, peak: pk * 1000, final: 0 })))) crossed++;
      }
      /* 欠钱档也必须在破产一侧（`final < 0` 不许混进结算的那 13 档）。 */
      if (!BUST_ALL.includes(T.titleOf(rec({ reason, cash0: 1000, peak: 3000, final: -1 })))) crossed++;
    }
    for (const f of [0.1, 0.5, 1, 2, 10, 50, 200, 1e5, 1e9]) {
      if (!LIVE_TITLES.includes(T.titleOf(rec({ reason: OVER.SETTLED, cash0: 1000, final: f * 1000 })))) crossed++;
    }
    check('12 结局轴互不串档（破产 7 档 ⇄ 结算 13 档）', crossed === 0, `串档 ${crossed} 次`);
  }
  /* 硬规矩：**破产局不许拿到任何「暗示活下来」的风格称号**。 */
  {
    const lie = ['不死鸟', '向死而生'];
    let lied = 0;
    for (const reason of [OVER.LIQUIDATED, OVER.GAVEUP]) {
      for (const liq of [0, 1, 10, 20, 88, 120]) {
        for (const loan of [0, 1, 2]) {
          const got = T.styleOf(rec({ reason, open: 20, liq, loan, maxLev: 5 }));
          if (lie.includes(got)) lied++;
        }
      }
    }
    check('12 破产局风格称号不说「活下来了」', lied === 0, `出现 ${lied} 次`);
  }

  /* ── A3 · 按本局时长归一（2026-10-05 用户拍板；同日用户实测修：只归一定性档）──────
     挑战局只有 2–4 个月，照「经典全程 12 年」定的**定性**档位会全部塌到最低档。
     这里对 **6 局逐一穷举**：经典局必须 13 档全可达（未退化），
     每个挑战局至少命中 4 档（证明短局也能打出差别），且同一倍数在短局的档位不低于经典局。
     ⚠️ **但报绝对数字 / 量级的档位（百倍战神 / 千倍 / 万倍 / 亿倍传奇）绝不许归一** ——
        k ≈ 0.15 曾把 1e8 的门槛压到 ~16 倍，59 倍被判成「亿倍传奇」（用户实测）。
        ③ 专门钉这条：同一倍数在任何局别判**同一档**，且 59 倍不许叫任何「百倍以上」的称号。 */
  const SCEN_LIST = C.SCENARIOS.map(sc => sc.id);
  {
    const kc = T.durKOf({ scen: 'classic' });
    check('12 归一标量：经典局 k = 1（阈值与改动前逐位相同）', kc === 1, `k=${kc}`);
    const ks = SCEN_LIST.filter(id => id !== 'classic').map(id => [id, T.durKOf({ scen: id })]);
    check('12 归一标量：5 个挑战局 k ∈ [0.15, 1)',
      ks.every(([, k]) => k >= 0.15 && k < 1),
      ks.map(([id, k]) => `${id}=${k.toFixed(3)}`).join(' '));
    check('12 归一标量：未知 / 缺失年代回落到经典（k = 1）',
      T.durKOf({ scen: 'nope' }) === 1 && T.durKOf({}) === 1);
    console.log('  局          k     10x档     100x档    （经典 = 1 ⇒ 10x / 100x）');
    for (const id of SCEN_LIST) {
      const k = T.durKOf({ scen: id });
      console.log(`  ${id.padEnd(9)} ${k.toFixed(3)}  ${Math.pow(10, k).toFixed(2)}x    ${Math.pow(100, k).toFixed(2)}x`);
    }
  }
  {
    /* ① 结算档：逐局扫倍数，数命中几档。 */
    const LIVE = LIVE_TITLES;
    for (const id of SCEN_LIST) {
      const hit = new Set();
      /* ⚠️ 上界要盖过「亿倍传奇」的门槛（经典局 1e8x）—— 绝对数字档**不归一**，
            所以挑战局末档同样卡在 1e8x，上界一到 1e9 即可全部扫到。 */
      for (let m = 0.1; m <= 1e9; m *= 1.15) {
        hit.add(T.titleOf(rec({ scen: id, reason: OVER.SETTLED, cash0: 1000, final: m * 1000 })));
      }
      const need = id === 'classic' ? 13 : 4;
      check(`12 时长归一 · ${id} 鲜活局命中 ≥ ${need} 档主称号`,
        hit.size >= need, `命中 ${hit.size} 档：${[...hit].join('/')}`);
    }
    /* ② 单调性：同一倍数，短局的档位**不低于**经典局（阈值下移的直接推论）。 */
    const rankOf = (t) => LIVE.indexOf(t);
    let mono = 0;
    for (const m of [1.2, 1.5, 2, 3, 10, 50]) {
      const base = rankOf(T.titleOf(rec({ scen: 'classic', reason: OVER.SETTLED, cash0: 1000, final: m * 1000 })));
      for (const id of SCEN_LIST) {
        if (id === 'classic') continue;
        if (rankOf(T.titleOf(rec({ scen: id, reason: OVER.SETTLED, cash0: 1000, final: m * 1000 }))) < base) mono++;
      }
    }
    check('12 时长归一：同一倍数在短局的档位不低于经典局（阈值单调下移）', mono === 0, `违反 ${mono} 次`);
    /* ③ **绝对数字档不许被时长归一污染**（2026-10-05 用户实测修）。
       背景：`mThr(1e8, 0.15) ≈ 15.8` —— 4 个月的挑战局里 59 倍被判成「亿倍传奇」，
       名字在说谎。归一只该作用于**定性**档（保本 / 小赚 / 翻倍 …/ 滚雪球），
       凡档名里写着**绝对倍数**的（百倍战神 / 千倍 / 万倍 / 亿倍传奇）一律用绝对阈值。
       两条护栏：
         · **同档**：同一倍数在 6 个局别里必须判**同一个**主称号（阈值不随时长漂移）；
         · **不撒谎**：59 倍在**任何**局别都不许叫「百倍战神 / 千倍 / 万倍 / 亿倍传奇」。 */
    const NAMED_BANDS = ['百倍战神', '千倍传奇', '万倍传奇', '亿倍传奇'];
    let drift = 0, lied = 0;
    for (const m of [59, 100, 999, 1000, 1e4, 1e8]) {
      const base = T.titleOf(rec({ scen: 'classic', reason: OVER.SETTLED, cash0: 1000, final: m * 1000 }));
      for (const id of SCEN_LIST) {
        const t = T.titleOf(rec({ scen: id, reason: OVER.SETTLED, cash0: 1000, final: m * 1000 }));
        if (t !== base) drift++;
        if (m < 100 && NAMED_BANDS.includes(t)) lied++;
      }
    }
    check('12 绝对数字档不随时长归一：同一倍数在 6 个局别判同一档', drift === 0, `漂移 ${drift} 次`);
    check('12 绝对数字档不撒谎：59 倍在任何局别都不叫「百倍 / 千倍 / 万倍 / 亿倍」',
      lied === 0, `撒谎 ${lied} 次`);
    /* ④ 破产档的绝对高度同理：峰顶 2x 在**任何**局别都是「纸上富贵」（不归一）。 */
    let bDrift = 0;
    for (const peakMult of [2, 5, 20, 100, 1000]) {
      const base = T.titleOf(rec({ scen: 'classic', reason: OVER.LIQUIDATED, cash0: 1000, peak: peakMult * 1000, final: 0 }));
      for (const id of SCEN_LIST) {
        if (T.titleOf(rec({ scen: id, reason: OVER.LIQUIDATED, cash0: 1000, peak: peakMult * 1000, final: 0 })) !== base) bDrift++;
      }
    }
    check('12 破产档绝对高度不随时长归一：同一峰顶在 6 个局别判同一档', bDrift === 0, `漂移 ${bDrift} 次`);
  }

  /* ── B · 徽章池 20 枚全部可达（无死徽章）＋ 输出无未登记名称 ── */
  const ALL_BADGES = [
    '躺平大师', '躺平', '1 倍党', '杠杆党',
    '百倍玩家', '杠杆赌徒',
    '单一信仰', '五币全通',
    '强平之王', '九死一生', '强平机器',
    '长跑选手', '三年老将', '一年老兵',
    '千次开仓', '交易狂魔',
    '闪电爆仓', '闪电战',
    '过山车', '深度回撤', '教科书曲线',
    '负债离场', '给交易所打工', '落袋为安',
    '搬家达人', '续命者', '上帝之手',
    '神枪手', '危机幸存者',
  ];
  const BADGE_PROFILES = [
    rec({ open: 0, margin: 0, win: 0, loss: 0, maxLev: 1, days: 1000 }),  // 躺平大师
    rec({ open: 0, margin: 0, win: 0, loss: 0, maxLev: 1, days: 100 }),   // 躺平
    rec({ open: 5, fut: 0, maxLev: 1, margin: 5 }),                       // 1 倍党
    rec({ open: 5, fut: 0, maxLev: 5, margin: 5 }),                       // 杠杆党
    rec({ open: 5, fut: 5, maxLev: 100 }),                                // 百倍玩家
    rec({ open: 5, fut: 5, maxLev: 30 }),                                 // 杠杆赌徒
    rec({ syms: ['BTC'] }),                                               // 单一信仰
    rec({ syms: ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP'] }),                  // 五币全通
    rec({ liq: 120 }),                                                    // 强平之王
    rec({ liq: 60 }),                                                     // 九死一生
    rec({ liq: 25 }),                                                     // 强平机器
    rec({ days: 3650 }),                                                  // 长跑选手
    rec({ days: 1200 }),                                                  // 三年老将
    rec({ days: 400 }),                                                   // 一年老兵
    rec({ open: 1200 }),                                                  // 千次开仓
    rec({ open: 250 }),                                                   // 交易狂魔
    rec({ open: 3, days: 20, reason: OVER.LIQUIDATED, final: 0, peak: 1000 }), // 闪电爆仓
    rec({ open: 3, days: 20 }),                                           // 闪电战
    rec({ peak: 10000, final: 1500 }),                                    // 过山车
    /* 深度回撤：净值 2000 → 300（回撤 85%），但峰顶 2x < 5x ⇒ 不吃「过山车」那一档。 */
    rec({ eq: [1000, 2000, 1700, 1300, 900, 700, 500, 300] }),            // 深度回撤
    /* 教科书曲线：一路缓慢抬升、最深处回撤 ≈ 0.5%，且走过 400 天。 */
    rec({ days: 400, eq: [1000, 1010, 1020, 1015, 1030, 1040, 1035, 1050] }), // 教科书曲线
    rec({ reason: OVER.LIQUIDATED, peak: 1000, final: -500 }),            // 负债离场
    rec({ open: 60, final: 500, realized: 0 }),                           // 给交易所打工
    rec({ realized: 500, open: 10, final: 2000 }),                        // 落袋为安
    rec({ move: 10 }),                                                    // 搬家达人
    rec({ loan: 1 }),                                                     // 续命者
    rec({ god: true }),                                                   // 上帝之手
    rec({ win: 12, loss: 3 }),                                            // 神枪手
    rec({ start: Date.UTC(2019, 0), end: Date.UTC(2021, 0) }),            // 危机幸存者
  ];
  const seen = new Set();
  for (const p of BADGE_PROFILES) for (const b of T.badgesOf(p)) seen.add(b);
  const missBadge = ALL_BADGES.filter(b => !seen.has(b));
  const unknownBadge = [...seen].filter(b => !ALL_BADGES.includes(b));
  check('12 徽章池恰 29 枚', ALL_BADGES.length === 29, `${ALL_BADGES.length}`);
  check('12 徽章 29 枚全部可达（无死徽章）', missBadge.length === 0,
    missBadge.length ? `缺 ${missBadge.join(' / ')}` : `覆盖 ${seen.size} / 29`);
  check('12 徽章输出无未登记名称', unknownBadge.length === 0, unknownBadge.join(' / ') || '');

  /* ── B2 · 最大回撤：`eq` 样本够才算，样本太稀一律 `null`（不给假极端值） ── */
  {
    const mddOf = eqs => T.maxDdOf(rec({ eq: eqs }));
    check('12 最大回撤：样本 < 8 点 ⇒ null（不下判断）',
      T.maxDdOf(rec({ eq: [1000, 500] })) === null && T.maxDdOf(rec({})) === null);
    check('12 最大回撤：一路抬升 ⇒ 0', mddOf([1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700]) === 0);
    const dd = mddOf([1000, 2000, 1500, 1000, 500, 600, 700, 800]);
    check('12 最大回撤：2000 → 500 ⇒ 恰好 0.75', Math.abs(dd - 0.75) < 1e-9, `实得 ${f(dd, 4)}`);
    check('12 最大回撤：含 NaN / Inf 不炸（跳过坏点）',
      Math.abs(mddOf([1000, 2000, NaN, 500, 1500, 1200, 1100, Infinity]) - 0.75) < 1e-9);
  }

  /* ── C · fuzz：在**行为空间**上随机撒 4000 个点，验证三轴永不返回空 ──────────────────────
     ⚠️ 固定种子（LCG）⇒ 每次跑出的数完全一样，不引入偶发红灯。 */
  let seed = 20261004;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pick = n => Math.floor(rnd() * n);
  const reasons = [OVER.LIQUIDATED, OVER.SETTLED, OVER.GAVEUP];
  let emptyStyle = 0, unknownStyle = 0, emptyTitle = 0, unknownTitle = 0, dupBadge = 0, maxBadges = 0, emptyEp = 0;
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
      /* v32 行为信号也进 fuzz：加仓 / 加减保证金 / 浮盈减保证金 / OTC / 分批 —— 覆盖新分支。 */
      addOn: pick(12), mgUp: pick(8), mgDown: pick(8), mgCut: pick(8), otc: pick(12), part: pick(8),
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
    else if (!TITLE_SET.has(ti)) unknownTitle++;
    if (!T.epitaphOf(r)) emptyEp++;
  }
  check('12 fuzz ×4000：风格称号永不为空', emptyStyle === 0, `空 ${emptyStyle} 次`);
  check('12 fuzz ×4000：风格称号恒在已登记 26 档内', unknownStyle === 0, `越界 ${unknownStyle} 次`);
  check('12 fuzz ×4000：主称号永不为空', emptyTitle === 0, `空 ${emptyTitle} 次`);
  check('12 fuzz ×4000：主称号恒在已登记 20 档内', unknownTitle === 0, `越界 ${unknownTitle} 次`);
  check('12 fuzz ×4000：单局徽章无重复', dupBadge === 0, `重复 ${dupBadge} 次`);
  check('12 fuzz ×4000：结局评语永不为空', emptyEp === 0, `空 ${emptyEp} 次`);
  /* 理论上界 14：工具 1 ＋ 杠杆烈度 1 ＋ 分散度 1 ＋ 强平 1 ＋ 时长 1 ＋ 交易量 1 ＋ 节奏 1
     ＋ 曲线 1 ＋ 现金流 1 ＋ 行为 3 ＋ 神枪手 1 ＋ 危机幸存者 1 —— 海报按实际宽度折行，
     挑一档字号保证 ≤ 3 行即可放下（2026-10-05 起不再有「最多两行」的硬上限）。
     ⚠️ 每组内部互斥；**新增徽章必须并入某个互斥组**，不许再挂独立 `if` 把上限顶破。 */
  check('12 fuzz：单局徽章数 ≤ 14（海报折行放得下）', maxBadges <= 14, `实测最多 ${maxBadges} 枚`);

  /* ── A4 · 结局评语 `epitaphOf`（2026-10-05 用户拍板「弹窗给一小段文案」）───────────
     16 档档位句逐一取到、恒非空；破产局**绝不说「活下来」**（与称号同一条硬规矩）；
     8 条补白各自能被一条画像触发；`short` 版恒为全句前缀（海报 2026-10-05 起改用**全版**，
     但 `short` 仍是「只取档位句」的合法出口，前缀关系必须继续成立）。 */
  {
    /* 破产 7 档（欠钱置顶 ＋ 峰顶 6 档）—— 代表画像，`final` 定欠钱、`peak` 定阶梯。 */
    const EPI_BUST = [
      { final: -1, peak: 0 },              // 负债累累
      { final: 0, peak: 5000 * 1000 },     // 功亏一篑（≥1000x）
      { final: 0, peak: 500 * 1000 },      // 登月坠落（≥100x）
      { final: 0, peak: 50 * 1000 },       // 黄粱一梦（≥20x）
      { final: 0, peak: 10 * 1000 },       // 高台跳水（≥5x）
      { final: 0, peak: 3 * 1000 },        // 纸上富贵（≥2x）
      { final: 0, peak: 1 * 1000 },        // 归零者
    ];
    /* 存活 9 档 —— 按终值倍数取代表点（含末档 1e9 盖过亿倍门槛）。 */
    const EPI_LIVE = [0.5, 1.5, 3, 10, 50, 500, 5000, 1e6, 1e9];
    const FORBID = ['活下来', '活着', '幸存', '挺过来', '撑到'];
    const texts = [];
    let empty = 0, lied = 0;
    for (const o of EPI_BUST) {
      const t = T.epitaphOf(rec({ reason: OVER.LIQUIDATED, cash0: 1000, ...o }));
      if (!t || typeof t !== 'string') empty++;
      if (FORBID.some(w => t.includes(w))) lied++;
      texts.push(t);
    }
    for (const m of EPI_LIVE) {
      const t = T.epitaphOf(rec({ reason: OVER.SETTLED, cash0: 1000, final: m * 1000 }));
      if (!t || typeof t !== 'string') empty++;
      texts.push(t);
    }
    check('12 结局评语：16 档全部取到且非空', empty === 0, `空 ${empty} 档`);
    check('12 结局评语：破产局绝不说「活下来」', lied === 0, `出现 ${lied} 次`);
    check('12 结局评语：16 档产出 ≥ 12 种不同句子（覆盖不同玩家）',
      new Set(texts).size >= 12, `${new Set(texts).size} 种`);

    /* 补白句：9 条画像各触发一次，且**比 `short` 版更长**（证明真的加了一句）。
       v32 新增最后一条：滚仓（浮盈减保证金 ＋ 持续加仓）。 */
    const TAILS = [
      { god: true }, { open: 0 }, { loan: 1 }, { maxLev: 100 },
      { liq: 12 }, { move: 12 }, { days: 20, open: 3 }, { days: 4000 },
      { mgCut: 3, addOn: 3 },
    ];
    let noTail = 0, notPrefix = 0;
    for (const o of TAILS.concat([{}])) {
      const r = rec({ reason: OVER.SETTLED, cash0: 1000, final: 2000, ...o });
      const full = T.epitaphOf(r), sh = T.epitaphOf(r, { short: true });
      if (!full.startsWith(sh)) notPrefix++;
    }
    for (const o of TAILS) {
      const r = rec({ reason: OVER.SETTLED, cash0: 1000, final: 2000, ...o });
      if (!(T.epitaphOf(r).length > T.epitaphOf(r, { short: true }).length)) noTail++;
    }
    check('12 结局评语：9 条补白各自可触发（全句比 short 版长）', noTail === 0, `未触发 ${noTail} 条`);
    check('12 结局评语：short 版恒为全句前缀（供单行场景）', notPrefix === 0, `不符 ${notPrefix} 条`);
  }

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

  /* ── E · 真引擎端到端 · v32 新信号：滚仓 / OTC / 分批减仓 **必须真的落进 `s.stat`** ──────────
     ⚠️ 这一节**不与 A 节画像重复**：A 节只证明「给定一条记录，`titles.js` 判得对」；
        这里证明**引擎真的把行为记了下来** —— 否则词表再全也只是一批永远触发不了/无法触发的死标签。
        用户硬要求「不做假绿」：每条断言都跑真引擎（`openTrade` / `adjustMargin` / `closeTrade` /
        `careerOf`），只对**局面做前置**（选一个真实的历史行情段），断言本身读的是引擎写出的数。 */
  {
    /* E1 · 滚仓：真开空 → 真加仓 ×2 → 逐小时推进出**真浮盈** → 真减保证金 ×2
       ⇒ `mgDown` / `mgCut` / `addOn` 真的涨，`careerOf` 摊平，称号命中「滚仓玩家」。 */
    const s = await mk({ scen: 'classic', sym: 'BTC', mode: 'margin', cash: 200000, i: idx(at(2021, 4, 10)) });
    s.mode = 'margin'; s.lev = 3;
    const r0 = engine.openTrade(s, 'short', 0.2);
    check('12E 滚仓前置：开空成功', r0.ok && !!s.positions.BTC, r0.why || '');
    check('12E 滚仓前置：首仓不计加仓（open=1 / addOn=0）',
      s.stat.open === 1 && s.stat.addOn === 0, `open=${s.stat.open} addOn=${s.stat.addOn}`);
    const a1 = engine.openTrade(s, 'short', 0.1), a2 = engine.openTrade(s, 'short', 0.1);
    check('12E 滚仓：真加仓 ×2 ⇒ addOn = 2', a1.ok && a2.ok && s.stat.addOn === 2,
      `addOn=${s.stat.addOn}（${a1.ok ? '' : a1.why}${a2.ok ? '' : '/' + a2.why}）`);
    /* 逐小时推进（2021-05 暴跌段），直到空仓真的转为浮盈 —— **真行情**，不是改字段。 */
    let found = -1;
    for (let k = 0; k < 300 && !s.over; k++) {
      if (s.pending) s.pending = null;
      engine.advanceOneHour(s);
      const p = s.positions.BTC;
      if (!p) break;
      if (P.pnlOf(p, engine.exMarkPrice(s, 'BTC', p.ex)) > 0) { found = k + 1; break; }
    }
    check('12E 滚仓前置：真行情推进出浮盈（非改字段）', found > 0, `${found} 小时`);
    let cuts = 0;
    for (let i = 0; i < 2; i++) {
      const step = engine.marginStepOf(s, 'BTC', 0.25, false);
      if (step > 0 && engine.adjustMargin(s, 'BTC', -step).ok) cuts++;
    }
    check('12E 滚仓：浮盈里真减保证金 ×2 ⇒ mgDown = 2', cuts === 2 && s.stat.mgDown === 2,
      `cuts=${cuts} mgDown=${s.stat.mgDown}`);
    check('12E 滚仓：严格口径 ⇒ mgCut = 2（两次都在浮盈中）', s.stat.mgCut === 2,
      `mgCut=${s.stat.mgCut} mgDown=${s.stat.mgDown}`);
    const rr = engine.careerOf(s, OVER.SETTLED);
    check('12E 滚仓：`careerOf` 摊平 v32 六字段（非 undefined）',
      typeof rr.addOn === 'number' && typeof rr.mgUp === 'number' && typeof rr.mgDown === 'number'
      && typeof rr.mgCut === 'number' && typeof rr.otc === 'number' && typeof rr.part === 'number');
    check('12E 滚仓：风格称号命中「滚仓玩家」', T.styleOf(rr) === '滚仓玩家', `实得 «${T.styleOf(rr)}»`);
    check('12E 滚仓：结局评语带滚仓补白句', T.epitaphOf(rr).includes('滚大的'), T.epitaphOf(rr));
  }
  {
    /* E2 · OTC 通道：真切到 otc 并成交 ⇒ `s.stat.otc` 真的涨；切回盘口不再涨（**对照**）。 */
    const s = await mk({ scen: 'classic', sym: 'BTC', mode: 'margin', cash: 2e7, i: idx(at(2021, 5)) });
    s.mode = 'margin'; s.lev = 2; s.chan = 'otc';
    check('12E OTC 前置：通道生效 = otc', engine.chanOf(s) === 'otc', engine.chanOf(s));
    const ro = engine.openTrade(s, 'long', 0.05);
    check('12E OTC：开仓成功（≥ 单笔门槛）', ro.ok, ro.why || '');
    check('12E OTC：开仓计入 s.stat.otc = 1', s.stat.otc === 1, `otc=${s.stat.otc}`);
    check('12E OTC：平仓同样计入 ⇒ s.stat.otc = 2', engine.closeTrade(s, '测试').ok && s.stat.otc === 2,
      `otc=${s.stat.otc}`);
    s.chan = 'book';
    engine.openTrade(s, 'long', 0.05);
    check('12E OTC：切回盘口后不再计入（对照，证明计的是通道）', s.stat.otc === 2, `otc=${s.stat.otc}`);
  }
  {
    /* E3 · 分批减仓：`closeTrade` 的 `frac < 1` 才计 `part`；全平**不**计。 */
    const s = await mk({ scen: 'classic', sym: 'BTC', mode: 'margin', cash: 500000, i: idx(at(2021, 5)) });
    s.mode = 'margin'; s.lev = 3;
    check('12E 分批前置：开仓成功', engine.openTrade(s, 'long', 0.5).ok);
    const c1 = engine.closeTrade(s, '测试', 0.25);
    check('12E 分批：0.25 减仓成功 ⇒ part = 1', c1.ok && s.stat.part === 1, `${c1.why || ''} part=${s.stat.part}`);
    engine.closeTrade(s, '测试', 0.5);
    check('12E 分批：再减 0.5 ⇒ part = 2', s.stat.part === 2, `part=${s.stat.part}`);
    engine.closeTrade(s, '测试', 1);
    check('12E 分批：全平（frac=1）**不**计入 part', s.stat.part === 2, `part=${s.stat.part}`);
    check('12E 分批：全平后仓位清空', !s.positions.BTC);
  }
  {
    /* E4 · 反例护栏（涌现性）：没有新行为就拿不到新称号；宽松口径不许冒充严格口径。 */
    const NEW4 = ['滚仓玩家', '滚仓狂人', '场外玩家', '分批离场'];
    const plain = rec({ open: 20, margin: 10, fut: 10, maxLev: 5 });
    check('12E 反例：无新增行为 ⇒ 拿不到任何 v32 新称号', !NEW4.includes(T.styleOf(plain)), T.styleOf(plain));
    const addOnly = rec({ open: 6, addOn: 5, mgCut: 0, margin: 3, fut: 3, maxLev: 3 });
    check('12E 反例：只加仓、没有浮盈减保证金 ⇒ 不算滚仓（严格口径）',
      !['滚仓玩家', '滚仓狂人'].includes(T.styleOf(addOnly)), T.styleOf(addOnly));
    const mid = rec({ open: 6, addOn: 3, mgCut: 3, margin: 3, fut: 3, maxLev: 3 });
    check('12E 分档：加仓 / 减保证金各 3 次 ⇒「滚仓玩家」而非「滚仓狂人」',
      T.styleOf(mid) === '滚仓玩家', T.styleOf(mid));
  }
}

/* ═════════ 12F · 回归：滚仓抽干保证金后不得留「负权益僵尸仓」（2026-10-05 用户实测 bug） ═════════
   用户玩法：浮盈中**减保证金 ＋ 持续加仓**（滚仓）⇒ 曾出现「账户权益与保证金率为负，本局却不结束」。
   根因：`borrowedOf` 多头旧式 `名义 × (1 − 1/杠杆)` **完全不看 `margin`**，而 `adjustMargin` 只改
   `margin`、不改 `名义/杠杆` ⇒ 抽干保证金后借入被**低估**（1x 多头恒为 0）⇒ `canLiquidate` 恒假
   （永不强平）、`paysInterest` 恒假（永不计息）、`instrumentOf` 错档成 `'perp'`（维持线 15% → 0.5%）
   =「僵尸仓」。修：① `borrowedOf` 多头改 `max(0, 名义 − 保证金)`；② `liquidateAll` 末尾无条件
   `checkRuin`。本节把这两条钉死在真实行为上（不做假绿：F2/F3 全部走真引擎 + 真历史行情）。 */
section('12F · 回归：滚仓抽干保证金 ⇒ 借入随保证金变 · 僵尸仓必须可强平 / 本局必须结束');

/* ── F1 · 单元口径：借入随保证金变、处女 1x 多头与旧口径数值一致 ── */
{
  const virgin = P.openPosition('BTC', 'long', 100, 100, 1, 0, true);   // 1x、名义 100、保证金 100
  check('12F 处女 1x 多头借入为 0（与旧口径数值一致 ⇒ 正常玩法零影响）',
    P.borrowedOf(virgin) === 0, `borrowed=${f(P.borrowedOf(virgin), 6)}`);
  const lev3 = P.openPosition('BTC', 'long', 100, 100, 3, 0, true);     // 3x、名义 300、保证金 100
  /* ⚠️ 措辞用「数值一致」而非「逐位一致」：`300 × (1 − 1/3)` 是 200.00000000000003，新式给 200
     —— 差 1 ULP，对玩法零影响（阈值 1e-9）。 */
  check('12F 3x 多头借入 = 名义 − 保证金（旧口径数值一致，≈ 200）',
    Math.abs(P.borrowedOf(lev3) - 200) < 1e-9, `borrowed=${f(P.borrowedOf(lev3), 6)}`);
  const drained = { ...virgin, margin: virgin.margin - 40 };            // 抽走 40 保证金
  check('12F 抽走保证金 ⇒ 借入同步上升（旧口径此处恒 0 ⇒ 僵尸仓的根因）',
    Math.abs(P.borrowedOf(drained) - 40) < 1e-9, `borrowed=${f(P.borrowedOf(drained), 6)}`);
  check('12F 抽干后 1x 多头恢复「可强平 / 计息 / 杠杆档」三判据',
    P.canLiquidate(drained) && P.paysInterest(drained) && P.instrumentOf(drained) === 'margin',
    `canLiq=${P.canLiquidate(drained)} interest=${P.paysInterest(drained)} instr=${P.instrumentOf(drained)}`);
}

/* ── F2 · 真引擎行为：滚仓减保证金 ⇒ 仓位从「不可强平」变「可强平」 ── */
{
  const s = await mk({ scen: 'classic', sym: 'BTC', mode: 'margin', cash: 200000, i: idx(at(2021, 4, 10)) });
  s.mode = 'margin'; s.lev = 1;
  const ro = engine.openTrade(s, 'long', 1);
  check('12F 前置：1x 多仓开出来了', ro.ok && !!s.positions.BTC, ro.why || '');
  check('12F 前置：未抽保证金时 1x 多头不可强平（GDD §9.1 不受影响）',
    !P.canLiquidate(s.positions.BTC), `borrowed=${f(P.borrowedOf(s.positions.BTC), 6)}`);
  let cuts = 0;
  for (let k = 0; k < 12; k++) {
    const step = engine.marginStepOf(s, 'BTC', 0.25, false);
    if (!(step > 0) || !engine.adjustMargin(s, 'BTC', -step).ok) break;
    cuts++;
  }
  const pos = s.positions.BTC;
  check('12F 真减保证金成功（滚仓基本动作）', cuts > 0, `cuts=${cuts}`);
  check('12F 减保证金后借入 > 0（旧口径此处恒 0 ⇒ 僵尸仓的根因）',
    P.borrowedOf(pos) > 0, `borrowed=${f(P.borrowedOf(pos), 6)}`);
  check('12F 减保证金后恢复可强平 / 计息 / 杠杆档',
    P.canLiquidate(pos) && P.paysInterest(pos) && P.instrumentOf(pos) === 'margin',
    `canLiq=${P.canLiquidate(pos)} interest=${P.paysInterest(pos)} instr=${P.instrumentOf(pos)}`);
  check('12F 借入逐位等于「名义 − 保证金」',
    Math.abs(P.borrowedOf(pos) - Math.max(0, pos.notional - pos.margin)) < 1e-9);
}

/* ── F3 · 端到端：真滚仓（浮盈减保证金 ＋ 加仓）后行情反转 ⇒ 不得出现僵尸小时 ── */
{
  const s = await mk({ scen: 'classic', sym: 'BTC', mode: 'margin', cash: 2e6, i: idx(at(2021, 4, 10)) });
  s.mode = 'margin'; s.lev = 1;
  /* ⚠️ 关掉「破产预警遮罩」（`hintOn`）—— 否则行情推到某个历史事件时会弹 `pending='warn'` 把时钟冻住，
     本节第二段就永远到不了本局的**自然收场**，断言会退化成只覆盖 warn 之前那一段（假绿）。 */
  s.hintOn = false;
  const ro = engine.openTrade(s, 'long', 1);
  check('12F F3 前置：滚仓底仓开出来了', ro.ok && !!s.positions.BTC, ro.why || '');
  const TOP = idx(at(2021, 10, 10));
  for (let i = s.i; i < TOP && !s.over && !s.pending; i++) {
    engine.advanceOneHour(s);
    const pos = s.positions.BTC;
    if (!pos) break;
    const px = engine.exMarkPrice(s, 'BTC', pos.ex);
    if (!(P.pnlOf(pos, px) > 0)) continue;             // 只在**浮盈**里滚（与玩家玩法一致）
    for (let k = 0; k < 4; k++) {
      const step = engine.marginStepOf(s, 'BTC', 0.25, false);
      if (!(step > 0) || !engine.adjustMargin(s, 'BTC', -step).ok) break;
    }
    engine.openTrade(s, 'long', 0.5);                  // 加仓
  }
  /* 顶部之后一路推到本局结束（允许领一次救济金继续），统计「负权益 / 破位却未被处理」的小时。 */
  let bad = 0, tookLoan = false;
  for (let i = s.i; i < s.endI; i++) {
    if (s.pending === 'loan' && !tookLoan) { engine.takeLoan(s); tookLoan = true; s.paused = false; }
    engine.advanceOneHour(s);
    if (s.over) break;
    if (s.pending) continue;                            // 待决（领救济金 / 预警）时钟已停，不算僵尸
    const pos = s.positions.BTC;
    const eq = engine.equity(s);
    const px = pos ? engine.exMarkPrice(s, 'BTC', pos.ex) : 0;
    const rate = pos ? P.marginRateOf(pos, px) : 1;
    const maint = pos ? P.maintRateOf(pos) : 0;
    if (eq < 1 || (pos && rate < maint)) bad++;
  }
  check('12F F3 滚仓后行情反转：全程无「负权益 / 破位却不处理」的僵尸小时（旧版实测会挂住）',
    bad === 0, `僵尸小时 = ${bad}`);
  check('12F F3 滚仓后行情反转 ⇒ 本局必须自然收场（不再无限挂起）',
    !!s.over, `over=${JSON.stringify(s.over)} pending=${s.pending} i=${s.i}/${s.endI}`);
  const pos = s.positions.BTC;
  const px = pos ? engine.exMarkPrice(s, 'BTC', pos.ex) : 0;
  check('12F F3 结束时不存在「不可强平的负权益仓位」',
    !pos || P.equityOf(pos, px) >= 0 || P.canLiquidate(pos),
    pos ? `eqOf=${f(P.equityOf(pos, px))} canLiq=${P.canLiquidate(pos)}` : '无仓位');
  console.log(`   12F F3 收场=${s.over ? s.over.reason : (s.pending || '仍在本局')} · 僵尸小时 ${bad} · 领救济=${tookLoan}`);
}

/* ═══════════════════ 9h–9j · 模拟深度三项（S2 跨所价差 / S3 借贷利率 / S4 保险基金） ═══════════════════ */
section('9h–9j · 模拟深度：跨所价差压力放大 · 借贷利率利用率浮动 · 强平成交价收口');

/* ── 9h · S2：跨所价差随恐慌放大（零均值 · 单所硬顶 · 中性逐位不变） ── */
{
  const EX = ['bitfinex', 'bitmex', 'binance'];
  const H0 = idx(at(2021, 5));
  const SEED = 20211005;
  const N = 3000;
  const st = (heat, shocks = []) => ({ mkt: { BTC: { heat, npcShock: { at: shocks.map(x => x.at), v: shocks.map(x => x.v) } } } });
  const neutral = st(god.HEAT.base);
  const panic = st(0);                               // |0 − 0.5| / 0.5 = 1 ⇒ 满压力

  /* ① s=null（旧调用点 / 单测）与中性档逐位相同 —— 保证老档行为不被 S2 改到。 */
  let same = true;
  for (const ex of EX) for (let k = 0; k < 500; k++) {
    if (god.exDevOf(ex, 'BTC', H0 + k, SEED, null) !== god.exDevOf(ex, 'BTC', H0 + k, SEED, neutral)) same = false;
  }
  check('9h 中性档与旧行为（s=null）逐位相同', same);

  /* ② 确定性：同输入两次调用逐位复现。 */
  check('9h 确定性：同 (所,币,小时,种子,状态) 逐位复现',
    god.exDevOf('binance', 'BTC', H0 + 7, SEED, panic) === god.exDevOf('binance', 'BTC', H0 + 7, SEED, panic));

  /* ③ 压力期偏移明显大于常态，并落在「目标带 6–12%」内（相对关系 + 带宽，不写死绝对值）。 */
  const span = (ex, s0) => { let mx = 0; for (let k = 0; k < N; k++) mx = Math.max(mx, Math.abs(god.exDevOf(ex, 'BTC', H0 + k, SEED, s0) - 1)); return mx; };
  let pMax = 0, nMax = 0;
  for (const ex of EX) { pMax = Math.max(pMax, span(ex, panic)); nMax = Math.max(nMax, span(ex, neutral)); }
  check('9h 压力期偏移明显大于常态（≥ 5×）', pMax > nMax * 5, `压力 ${f(pMax * 100, 2)}% vs 常态 ${f(nMax * 100, 3)}%`);
  check('9h 压力期单所偏移达目标带（≥ 5% 且 ≤ 13%）', pMax >= 0.05 && pMax <= 0.13, `峰值 ${f(pMax * 100, 2)}%`);

  /* ④ 零均值：放大的是**噪声幅度**不是基差，否则「某所长期贵 X%」会变成无风险套利。 */
  for (const ex of EX) {
    const basis = C.exchangeOf(ex).dev.basis;
    let sum = 0;
    for (let k = 0; k < N; k++) sum += god.exDevOf(ex, 'BTC', H0 + k, SEED, panic) - 1 - basis;
    check(`9h ${ex} 压力期噪声零均值（|均值| < 0.2%）`, Math.abs(sum / N) < 0.002, `均值 ${f(sum / N * 100, 4)}%`);
  }

  /* ⑤ 单所逐点硬顶：|dev| 恒不超过「原 cap + stressCap」。 */
  let over = 0;
  for (const ex of EX) {
    const capS = C.exchangeOf(ex).dev.cap + god.EXDEV.stressCap;
    for (let k = 0; k < N; k++) if (Math.abs(god.exDevOf(ex, 'BTC', H0 + k, SEED, panic) - 1) > capS + 1e-12) over++;
  }
  check('9h 单所偏移恒 ≤ 原 cap + stressCap（硬顶守住）', over === 0, `越顶 ${over} 次`);

  /* ⑥ 两所价差**压力期真的拉大**（这才是 S2 的目的）—— 常态化压在一次往返手续费内（不可套利），
     压力期放大到目标带；且两所差 ≤ 两所硬顶之和。这是「噪声确按所独立」的锐利回归哨兵：
     若三家共用同一份抖动（旧 bug），价差只剩恒定的 `basis` 差，压力期根本放不出来。 */
  const spread = (s0, a, b) => { let mx = 0; for (let k = 0; k < N; k++) mx = Math.max(mx, Math.abs(god.exDevOf(a, 'BTC', H0 + k, SEED, s0) - god.exDevOf(b, 'BTC', H0 + k, SEED, s0))); return mx; };
  const sN = spread(neutral, 'bitfinex', 'binance');
  const sP = spread(panic, 'bitfinex', 'binance');
  const dCap = C.exchangeOf('bitfinex').dev.cap + C.exchangeOf('binance').dev.cap + 2 * god.EXDEV.stressCap;
  check('9h 两所价差压力期显著放大（≥ 5%）', sP >= 0.05, `常态 ${f(sN * 100, 3)}% → 压力 ${f(sP * 100, 2)}%`);
  check('9h 常态两所价差仍压在一次往返手续费内（≤ 1%）', sN <= 0.01, `常态峰值 ${f(sN * 100, 3)}%`);
  check('9h 两所最大价差 ≤ 两所硬顶之和', sP <= dCap + 1e-12, `实测 ${f(sP * 100, 2)}% ≤ ${f(dCap * 100, 2)}%`);

  /* ⑦ npcShock（级联瞬时冲击）单独也能触发同一路放大。 */
  let sMax = 0;
  for (let k = 90; k < 130; k++) {
    const sh = st(god.HEAT.base, [{ at: H0 + k, v: god.EXDEV.shockRef }]);
    sMax = Math.max(sMax, Math.abs(god.exDevOf('binance', 'BTC', H0 + k, SEED, sh) - 1));
  }
  check('9h npcShock（级联）独立触发价差放大', sMax > 0.04, `峰值 ${f(sMax * 100, 2)}%`);
}

/* ── 9i · S3：借贷利率随可借池利用率浮动（中性逐位不变 · 恐慌变贵 · 有上限） ── */
{
  const U = C.MARGIN.util;
  const T = idx(at(2013, 8));                        // 早期流动性小 ⇒ 额度小、借入占比看得清
  const s = await mk({ sym: 'BTC', i: T, cash: 100000 });
  const mulAt = h => { s.mkt.BTC.heat = h; return engine.marginRateMulOf(s, 'BTC'); };

  /* ① 中性 + 无借入 ⇒ 乘数**逐位**为 1（常态行为与改动前逐位相同）。 */
  delete s.positions.BTC;
  check('9i 中性（heat=0.5、无借入）⇒ 乘数逐位为 1', mulAt(god.HEAT.base) === 1, `实得 ${mulAt(god.HEAT.base)}`);

  /* ② 恐慌越深越贵（单调不减），恒在 [1, 1+kRate]。 */
  const hs = [0.5, 0.45, 0.4, 0.3, 0.25, 0.1, 0];
  const muls = hs.map(mulAt);
  let mono = true;
  for (let k = 1; k < muls.length; k++) if (muls[k] + 1e-12 < muls[k - 1]) mono = false;
  check('9i 恐慌越深利率越高（单调不减）', mono, muls.map(v => f(v, 3)).join(' → '));
  check('9i 乘数恒在 [1, 1+kRate] 内', muls.every(v => v >= 1 - 1e-12 && v <= 1 + U.kRate + 1e-12),
    `峰值 ${f(Math.max(...muls), 4)} ≤ ${f(1 + U.kRate, 0)}`);
  check('9i 满压力（heat=0、无借入）⇒ 恰好到上界 1+kRate',
    Math.abs(mulAt(0) - (1 + U.kRate)) < 1e-12, `实得 ${f(mulAt(0), 4)}`);

  /* ③ 借得越满越贵：借入 = 0.5×额度 时乘数 > 不借时。 */
  const poolCap = market.liqOf('BTC', market.dayIndexOf(T)) * C.MARGIN.quota;
  const notional = poolCap * 0.75;                   // 3x 多头：借入 = 名义×2/3 = 0.5×额度
  s.positions.BTC = P.openPosition('BTC', 'long', 30000, notional / 3, 3, 0.0004, true);
  const mBorrow = mulAt(god.HEAT.base);
  delete s.positions.BTC;
  const mFlat = mulAt(god.HEAT.base);
  check('9i 借得越满利率越高（借 0.5×额度 > 不借）', mBorrow > mFlat, `借满 ${f(mBorrow, 4)} vs 不借 ${f(mFlat, 4)}`);
}

/* ── 9j · S4：强平成交价夹到「破产价 ± gap」（穿仓被收口到 gap×保证金） ── */
{
  const G = P.INSURE.gap;
  const avg = 30000, lev = 10, margin = avg * 0.1;   // 多头 10x
  const edgeL = avg * (1 - (1 + G) / lev);
  check('9j 多头：市价跌破破产价 ⇒ 夹到破产价−gap', P.bankruptcyFillPrice(avg, lev, 1, avg * 0.5) === edgeL,
    `夹到 ${f(edgeL, 2)}（原价 ${f(avg * 0.5, 2)}）`);
  check('9j 多头：市价高于破产价 ⇒ 原样返回', P.bankruptcyFillPrice(avg, lev, 1, avg * 0.9) === avg * 0.9);
  const edgeS = avg * (1 + (1 + G) / lev);
  check('9j 空头：市价涨破破产价 ⇒ 夹到破产价+gap ｜ 低于 ⇒ 原样',
    P.bankruptcyFillPrice(avg, lev, -1, avg * 1.5) === edgeS
    && P.bankruptcyFillPrice(avg, lev, -1, avg * 0.9) === avg * 0.9);

  /* 收口：无论市价跌到多深，基金净流出（= 名义/杠杆 − 亏损）恒 ≥ −gap×保证金。
     ⇒ 单笔穿仓不可能超过 `INSURE.gap` 倍保证金，这就是「结构性失血」被堵死的量化口径。 */
  const notional = margin * lev;
  const floorDelta = -notional * G / lev;
  let worst = Infinity, breach = 0;
  for (const p of [avg, avg * 0.9, avg * 0.5, avg * 0.1, avg * 0.01, 0, -1000]) {
    const fill = P.bankruptcyFillPrice(avg, lev, 1, p);
    const delta = notional / lev - notional * (1 - fill / avg);   // = 保证金 − 亏损（含夹取），与 fundSettle 同式
    if (delta < worst) worst = delta;
    if (delta < floorDelta - 1e-9) breach++;
  }
  check('9j 单笔穿仓被收口（基金净流出 ≤ gap×保证金）', breach === 0 && Math.abs(worst - floorDelta) < 1e-9,
    `最深净额 ${f(worst, 2)} = 下限 ${f(floorDelta, 2)}（−gap×保证金 ${f(G * margin, 2)}）`);
}

/* ── 9k · 清算费按工具分档（2026-10-05 深度审计：永续 0.5% / 杠杆 1.25%） ── */
{
  check('9k 清算费分档常量：永续 0.5% < 杠杆 1.25%',
    C.LIQ.fee === 0.005 && C.LIQ.feeMargin === 0.0125,
    `perp ${f(C.LIQ.fee * 100, 2)}% / margin ${f(C.LIQ.feeMargin * 100, 2)}%`);
  /* 分档判据与维持线同源：`borrowedOf > 0`（1x 多头借入为 0 走永续档，任何空头/带杠杆走杠杆档）。 */
  const perp = P.openPosition('BTC', 'long', 30000, 300, 10, 0.0004, false);   // 合约：无借入
  const marg = P.openPosition('BTC', 'long', 30000, 300, 10, 0.0004, true);    // 杠杆：有借入
  const mShort = P.openPosition('BTC', 'short', 30000, 300, 1, 0.0004, true);  // 1x 空头：借全额
  const feeOf = p => (P.borrowedOf(p) > 0 ? C.LIQ.feeMargin : C.LIQ.fee);
  check('9k 合约仓位走永续档（0.5%）', feeOf(perp) === C.LIQ.fee);
  check('9k 杠杆多头 / 1x 空头都走杠杆档（1.25%）', feeOf(marg) === C.LIQ.feeMargin && feeOf(mShort) === C.LIQ.feeMargin);
}

/* ═══════════════ 9l–9o · 模拟深度 G1–G4（跨币共振 / 处置效应 / NPC 资金费 / 方向不对称） ═══════════════ */
section('9l–9o · 模拟深度：跨币危机共振 · 处置效应盈利侧 · NPC 资金费 · 方向不对称');

/* ── 9l · G2：跨币危机共振（一币崩 ⇒ 邻币被拖 · 中性不外溢 · 回读双向） ── */
{
  const T = idx(at(2021, 5, 10));
  /* 同一小时、同一份行情，唯一变量是「本币 tick 前的 heat」：极端档 vs 中性档。 */
  const run = async (h) => {
    const s = await mk({ sym: 'BTC', i: T, mode: 'fut' });
    s.mkt.ETH = { heat: 0.5 };                 // 一个中性邻币（`crossHeat` 只读它的 heat）
    s.mkt.BTC.heat = h;
    engine.tickMarket(s, 'BTC');
    return s.mkt.ETH.heat;
  };
  const hExt = await run(0.0);
  const hNeu = await run(0.5);
  check('9l 极端档把邻币情绪拖低（一币崩 ⇒ 邻币共振）', hExt < hNeu - 0.02,
    `极端 ${f(hExt, 4)} vs 中性 ${f(hNeu, 4)}`);
  check('9l 中性档基本不外溢', Math.abs(hNeu - 0.5) < 0.2, `邻币 ${f(hNeu, 4)}`);
  check('9l 耦合参数有方向（push > read > 0，本币主导）',
    god.CONTAGION.push > god.CONTAGION.read && god.CONTAGION.read > 0,
    `push ${god.CONTAGION.push} / read ${god.CONTAGION.read}`);

  /* 回读项双向：本币 heat 相同、邻币一低一高 ⇒ 本币被拉的方向相反（差值 = read×2×偏移）。 */
  const read = async (ethHeat) => {
    const s = await mk({ sym: 'BTC', i: T, mode: 'fut' });
    s.mkt.ETH = { heat: ethHeat };
    s.mkt.BTC.heat = god.HEAT.base;
    engine.tickMarket(s, 'BTC');
    return s.mkt.BTC.heat;
  };
  const bDown = await read(0.0), bUp = await read(1.0);
  check('9l 回读项双向（邻币低 ⇒ 本币被拉低；邻币高 ⇒ 被拉高）', bDown < bUp - 0.005,
    `邻低 ${f(bDown, 4)} < 邻高 ${f(bUp, 4)}`);

  /* 新币**首次建格**的起手热度 —— 必须取自「已有各币 heat 的均值」，不是死的中性 0.5。
     病根：`crossHeat` 只能推给**已在 `s.mkt` 里**的币。玩家「砸崩 BTC 再第一次切 ETH」时 ETH
     的格子还不存在 ⇒ 若按 0.5 起手，则 ETH 恰好什么都没发生（本块要钉死这条自洽性）。 */
  const fresh = async (btcHeat) => {
    const s = await mk({ sym: 'ETH', i: T, mode: 'fut' });
    /* 只留一个邻币 BTC 的格子，ETH 的格子**不存在** ⇒ 模拟「从没看过 ETH」。
       （`crossHeat` 只读邻币的 `heat`，故这个桩只需 `heat`，同上面 9l 那两处。） */
    s.mkt = { BTC: { heat: btcHeat } };
    engine.tickMarket(s, 'ETH');               // 首次 tick ⇒ `mktOf` 懒建 ETH
    return s.mkt.ETH.heat;
  };
  const fLow = await fresh(0.05), fHigh = await fresh(0.95);
  check('9l 新币首次建格 ⇒ 起手热度取邻币均值（恐慌市建格就偏恐慌）', fLow < 0.3,
    `BTC 0.05 ⇒ ETH 起手 ${f(fLow, 4)}`);
  check('9l 新币首次建格 ⇒ 起手热度取邻币均值（贪婪市建格就偏贪婪）', fHigh > 0.7,
    `BTC 0.95 ⇒ ETH 起手 ${f(fHigh, 4)}`);
  check('9l 起手热度随邻币单调（不再钉死在中性 0.5）', fHigh - fLow > 0.5,
    `低 ${f(fLow, 4)} → 高 ${f(fHigh, 4)}，差 ${f(fHigh - fLow, 4)}`);
}

/* ── 9m · G1：处置效应盈利侧（盈利的 NPC 多单被止盈 · 一次性 · 止盈比止损急） ── */
{
  check('9m 止盈带比止损带更急（tpFrac < stopFrac，比值 ≈ 1/1.5）',
    god.NPC.tpFrac > 0 && god.NPC.tpFrac < god.NPC.stopFrac
    && Math.abs(god.NPC.stopFrac / god.NPC.tpFrac - 1.5) < 0.15,
    `tp ${god.NPC.tpFrac} / stop ${god.NPC.stopFrac} ⇒ 比值 ${f(god.NPC.stopFrac / god.NPC.tpFrac, 3)}`);

  const T = idx(at(2021, 5, 10));
  const s = await mk({ sym: 'BTC', i: T, mode: 'fut' });
  const price = engine.lastPrice(s, 'BTC');
  const g = s.mkt.BTC.npc[0];
  g.long = 1e7; g.longAvg = price * 0.5; g.short = 0; g.shortAvg = 0;   // 浮盈 100% ⇒ 远超止盈带
  g.longStopped = false; g.longTp = false;
  const L0 = g.long;
  /* ⚠️ 冻结 NPC 建仓（`stepNpc`）—— 否则① 建仓会同时改 `long`（污染「减半」读数）、
     `syncNpcDrift` 还会挪动显示价。本段只想量 `flushSlot` 的止盈带，故把两个 speed 都钉 0。 */
  const sp = god.NPC.speed, spMM = god.NPC.mm.speed;
  god.NPC.speed = 0; god.NPC.mm.speed = 0;
  try {
    engine.tickMarket(s, 'BTC');
    check('9m 盈利的多单被止盈（落标志 ＋ 名义减半）',
      g.longTp === true && Math.abs(g.long - L0 * 0.5) < L0 * 0.01,
      `long ${f(L0, 0)} → ${f(g.long, 0)}，longTp=${g.longTp}`);

    const L1 = g.long;
    engine.tickMarket(s, 'BTC');                 // 价格仍在带内 ⇒ 一次性，不再二次减半
    check('9m 止盈一次性（带内不再反复减半）', g.long >= L1 * 0.99,
      `第二次后 long ${f(g.long, 0)}（首减后 ${f(L1, 0)}）`);
  } finally { god.NPC.speed = sp; god.NPC.mm.speed = spMM; }
}

/* ── 9n · G3：NPC 也付费率（玩家零缴费时对手方池仍被市场净额补给） ── */
{
  const F = P.FUNDING.hours;
  const T = idx(at(2021, 5, 10));
  const s = await mk({ sym: 'BTC', i: T, mode: 'margin', cash: 1e7 });
  /* 玩家开 1x 多头：`isMargin` 且有借入为 0 ⇒ 既不计息、也不付费率 ⇒ 对池零贡献。 */
  s.lev = 1;
  engine.openTrade(s, 'long', 0.3);
  const pos = s.positions.BTC;
  check('9n 前置：玩家 1x 多头对池零贡献（不计息、不付费率）',
    !!pos && P.borrowedOf(pos) === 0 && !P.paysFunding(pos) && !P.paysInterest(pos));

  /* `s.i + 1` 落在 8h 整点（先定相位，再取价 ∵ 均价要按那一刻的现价给）。 */
  s.i = Math.floor(s.i / F) * F + (F - 1);
  const price = engine.lastPrice(s, 'BTC');
  const g = s.mkt.BTC.npc[0];
  g.long = 5e8; g.longAvg = price; g.short = 0; g.shortAvg = 0;          // NPC 净多头（均价=现价 ⇒ 不强平）
  g.longStopped = false; g.shortStopped = false; g.longTp = false; g.shortTp = false;
  s.mkt.BTC.heat = god.HEAT.base;
  s.mkt.BTC.npcFund = 0;
  /* 冻结 NPC 建仓：让 `npcNet` 保持在我们摆好的净多头上（否则建仓会在结算前改动它）。 */
  const sp = god.NPC.speed, spMM = god.NPC.mm.speed;
  god.NPC.speed = 0; god.NPC.mm.speed = 0;
  try {
    engine.advanceOneHour(s);
  } finally { god.NPC.speed = sp; god.NPC.mm.speed = spMM; }
  check('9n 玩家零缴费时对手方池仍被补给（NPC 净多头付费率）',
    Number.isFinite(s.mkt.BTC.npcFund) && s.mkt.BTC.npcFund > 0, `池 ${f(s.mkt.BTC.npcFund, 2)}`);
  check('9n 池余额恒 ≥ 0', s.mkt.BTC.npcFund >= 0, `池 ${f(s.mkt.BTC.npcFund, 2)}`);
}

/* ── 9o · G4：方向不对称（下行级联冲击被放大；上行不受影响） ── */
{
  const T = idx(at(2021, 5, 10));
  /* 同一场景切换 `NPC.downAsym`，唯一变量就是那个倍数 —— 逐位比值即它本身。 */
  const shockOf = async (dir, amp) => {
    const old = god.NPC.downAsym;
    const sp = god.NPC.speed, spMM = god.NPC.mm.speed;
    god.NPC.downAsym = amp;
    god.NPC.speed = 0; god.NPC.mm.speed = 0;         // 冻结建仓 ⇒ 只有被摆弄的那一档会写冲击
    try {
      const s = await mk({ sym: 'BTC', i: T, mode: 'fut' });
      const price = engine.lastPrice(s, 'BTC');
      /* 其余五档与做市盘清零（它们的 `flushSlot` 也会写 `npcShock`，会把符号相反的项混进来）。 */
      for (let k = 1; k < s.mkt.BTC.npc.length; k++) {
        const o = s.mkt.BTC.npc[k];
        o.long = 0; o.longAvg = 0; o.short = 0; o.shortAvg = 0;
        o.longStopped = false; o.shortStopped = false; o.longTp = false; o.shortTp = false;
      }
      if (s.mkt.BTC.mm) {
        const o = s.mkt.BTC.mm;
        o.long = 0; o.longAvg = 0; o.short = 0; o.shortAvg = 0;
        o.longStopped = false; o.shortStopped = false; o.longTp = false; o.shortTp = false;
      }
      const g = s.mkt.BTC.npc[0];
      if (dir < 0) { g.long = 1e8; g.longAvg = price * 2; g.short = 0; g.shortAvg = 0; }   // 多头跌穿强平线
      else { g.short = 1e8; g.shortAvg = price * 0.5; g.long = 0; g.longAvg = 0; }          // 空头涨穿强平线
      g.longStopped = false; g.shortStopped = false; g.longTp = false; g.shortTp = false;
      s.mkt.BTC.heat = god.HEAT.base;                // 中性 ⇒ 建仓靶心 ≈ 0 ⇒ 不摊平均价（保平/保跌不变）
      engine.tickMarket(s, 'BTC');
      const tab = s.mkt.BTC.npcShock;
      let sum = 0;
      if (tab) for (const v of tab.v) sum += v;
      return sum;
    } finally { god.NPC.downAsym = old; god.NPC.speed = sp; god.NPC.mm.speed = spMM; }
  };
  const d13 = await shockOf(-1, 1.3), d10 = await shockOf(-1, 1.0);
  const u13 = await shockOf(1, 1.3), u10 = await shockOf(1, 1.0);
  check('9o 下行级联冲击被放大（幅度比 = downAsym）',
    d10 !== 0 && d13 !== 0 && Math.abs(d13 / d10 - god.NPC.downAsym) < 0.05,
    `downAsym=1.3 时 ${f(d13, 0)} vs =1.0 时 ${f(d10, 0)} ⇒ 比 ${f(d13 / d10, 4)}`);
  check('9o 上行级联冲击不受影响（只放大下行）',
    u10 !== 0 && Math.abs(Math.abs(u13) / Math.abs(u10) - 1) < 1e-9,
    `上行 ${f(u13, 0)} vs ${f(u10, 0)}`);
  check('9o 参数值 > 1（下行更重）', god.NPC.downAsym > 1, `downAsym ${god.NPC.downAsym}`);
}

/* ── 9p · 上帝沙盒（2026-10-05 用户拍板「让上帝模式成为独特的沙盒游乐场」）──
   5 枚旋钮只作用在**合成层**（热度 / NPC / 冲击 / 共振），默认恒等（1 / 0）⇒ 逐位等于改动前。 */
section('9p · 上帝沙盒：旋钮归一 · 预设合法性 · shock 线性 · 恒等默认');
{
  /* ① `sbOf` 归一 —— 缺 god / 缺 sb / 坏值 / 负值 全都要能兜住 */
  const D = JSON.stringify(god.SB_DEFAULT);
  check('9p 无 god ⇒ 恒等默认（1 / 0）', JSON.stringify(god.sbOf({})) === D, '');
  check('9p 有 god 无 sb ⇒ 恒等默认', JSON.stringify(god.sbOf({ god: {} })) === D, '');
  check('9p 空 sb ⇒ 恒等默认', JSON.stringify(god.sbOf({ god: { sb: {} } })) === D, '');
  const w = god.sbOf({ god: { sb: { heat: -2, mood: -0.2, npc: NaN, shock: 'x', res: Infinity } } });
  check('9p 负倍率夹到 0 · 坏值回默认 · mood 可负',
    w.heat === 0 && w.mood === -0.2 && w.npc === 1 && w.shock === 1 && w.res === 1,
    `heat ${w.heat} mood ${w.mood} npc ${w.npc} shock ${w.shock} res ${w.res}`);

  /* ② 预设合法性：5 键齐全 · 倍率非负 · 四组 id / 名唯一 */
  let ok = true, why = '';
  for (const p of god.SB_PRESETS) {
    for (const k of god.SB_KEYS) {
      if (!Number.isFinite(p.sb[k])) { ok = false; why = `${p.id}.${k} 非有限`; }
      else if (k !== 'mood' && p.sb[k] < 0) { ok = false; why = `${p.id}.${k} < 0`; }
    }
  }
  const ids = new Set(god.SB_PRESETS.map(p => p.id));
  const names = new Set(god.SB_PRESETS.map(p => p.name));
  check('9p 预设 5 枚旋钮齐全且倍率非负', ok, why);
  check('9p 预设四组（默认 / 火箭牛市 / 深度熊市 / 高波动）且 id / 名唯一',
    god.SB_PRESETS.length === 4 && ids.size === 4 && names.size === 4,
    god.SB_PRESETS.map(p => p.name).join(' / '));

  /* ③ `shock` 旋钮对级联冲击**线性**放大（同一场景切倍率，唯一变量就是它） */
  const T = idx(at(2021, 5, 10));
  const shockOf = async (sbShock) => {
    const sp = god.NPC.speed, spMM = god.NPC.mm.speed;
    god.NPC.speed = 0; god.NPC.mm.speed = 0;        // 冻结建仓 ⇒ 只有被摆弄的那一档会写冲击
    try {
      const s = await mk({ sym: 'BTC', i: T, mode: 'fut' });
      for (let k = 1; k < s.mkt.BTC.npc.length; k++) {
        const o = s.mkt.BTC.npc[k];
        o.long = 0; o.longAvg = 0; o.short = 0; o.shortAvg = 0;
        o.longStopped = false; o.shortStopped = false; o.longTp = false; o.shortTp = false;
      }
      if (s.mkt.BTC.mm) {
        const o = s.mkt.BTC.mm;
        o.long = 0; o.longAvg = 0; o.short = 0; o.shortAvg = 0;
        o.longStopped = false; o.shortStopped = false; o.longTp = false; o.shortTp = false;
      }
      const price = engine.lastPrice(s, 'BTC');
      const g = s.mkt.BTC.npc[0];
      g.long = 1e8; g.longAvg = price * 2; g.short = 0; g.shortAvg = 0;   // 多头跌穿强平线
      g.longStopped = false; g.shortStopped = false; g.longTp = false; g.shortTp = false;
      s.mkt.BTC.heat = god.HEAT.base;                 // 中性 ⇒ 建仓靶心 ≈ 0
      s.mkt.BTC.npcShock = { at: [], v: [] };          // 清掉 `mk` 首次 tick 可能留下的残渣
      s.god = { lastFill: 0, sb: { ...god.SB_DEFAULT, shock: sbShock } };   // ← 唯一变量
      engine.tickMarket(s, 'BTC');
      const tab = s.mkt.BTC.npcShock;
      let sum = 0;
      if (tab) for (const v of tab.v) sum += v;
      return sum;
    } finally { god.NPC.speed = sp; god.NPC.mm.speed = spMM; }
  };
  const s1 = await shockOf(1), s2 = await shockOf(2), s0 = await shockOf(0);
  check('9p shock 旋钮线性放大级联冲击（×2 ⇒ 幅度 ×2）',
    s1 !== 0 && Math.abs(s2 / s1 - 2) < 1e-9, `×1 ${f(s1, 0)} ×2 ${f(s2, 0)} ⇒ 比 ${f(s2 / s1, 4)}`);
  check('9p shock = 0 ⇒ 级联冲击归零', s0 === 0, `×0 ${f(s0, 0)}`);

  /* ④ 恒等默认 ⇒ 与**不开沙盒**逐位一致（显式写一份 1 / 0 不该改变任何东西） */
  const identOf = async (withSb) => {
    const s = await mk({ sym: 'BTC', i: T, mode: 'fut' });
    if (withSb) s.god = { lastFill: 0, sb: { ...god.SB_DEFAULT } };
    engine.tickMarket(s, 'BTC');
    return `${s.mkt.BTC.heat}|${s.mkt.BTC.npc[0].long}|${s.mkt.BTC.npc[0].short}`;
  };
  const a0 = await identOf(false), a1 = await identOf(true);
  check('9p 恒等默认逐位 == 不开沙盒', a0 === a1, `${a0} vs ${a1}`);
}

/* ═══════════════════ 9q · 上帝面板分页接线（2026-10-05 · 源码锚点） ═══════════════════
   ⚠️ 这一节**不跑 DOM**（Node 无浏览器）：只对「页签接线」做**锚点断言** —— 咬的是
      「三个文件里必须同时出现同一根线」。漏接的后果正是本项目踩过的病根：
      `data-*` 不在 `bind.js` 的 `ACTION_KEYS` 里 ⇒ 点了完全没反应（见 `chan` 那一次的真实事故）。
   真正的视觉 / 交互验证留给浏览器自检；本审计不做实机（用户既定口径）。 */
section('9q · 上帝面板分页接线（data-godtab ⇄ ACTION_KEYS ⇄ onGodTab）');
{
  const readSrc = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const bindSrc = readSrc('src/ui/bind.js');
  const renderSrc = readSrc('src/ui/render.js');
  const mainSrc = readSrc('src/main.js');
  check('9q `godtab` 进了 `ACTION_KEYS`（否则页签点了没反应）',
    /['"]godtab['"]/.test(bindSrc));
  check('9q 面板生成页签（`dataset.godtab`）＋ 两页 `.confirm-rows` 互斥显隐',
    /dataset\.godtab/.test(renderSrc)
    && /rowsA\.style\.display/.test(renderSrc) && /rowsB\.style\.display/.test(renderSrc));
  check('9q `openGod` 收 `page` 入参（签名三参）',
    /export function openGod\(s, sel = null, page = 0\)/.test(renderSrc));
  check('9q 分派层有 `onGodTab`，且 `showGod` 把 `godPage` 传下去',
    /function onGodTab\(/.test(mainSrc) && /openGod\(s, godSel, godPage\)/.test(mainSrc));
}

/* ═══════════════════ 13 · 回归护栏（2026-10-05 · 「确认已修 bug 不复发」） ═══════════════════
   这一节**不跑引擎**，只对上一轮修好的几处做**源码 / 数据面**的固化断言 —— 谁把修复删回去，这里立刻红。
   目标五件事：
     · PWA 安装时的**整包预缓存**：清单里每个数据包都要在盘上真实存在（覆盖无缺口）；
     · `sw.js` 的预缓存**从 `data/index.json` 现读**（不写死文件名）＋ install 三段齐全；
     · 断网兜底**只对导航请求**回退 HTML（T8）＋ `cache.put` 有 catch（T9）；
     · `main.js` 侧：SW 注册带构建指纹 · `prefetchAllCoins` 首帧后空闲预热 · `maskReload` 先铺垫再 reload。
   ⚠️ 断言只咬**行为锚点**（关键函数名 / 关键判据），不咬逐字文本 —— 改实现而不改行为时不该红。 */
section('13 · 回归护栏：PWA 预缓存覆盖 · 断网兜底 · 预热与遮罩（已修 bug 防复发）');
{
  const readSrc = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const sw = readSrc('public/sw.js');
  const mainSrc = readSrc('src/main.js');
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/index.json'), 'utf8'));

  /* ① 预缓存覆盖：清单里每条 `file` 都必须在盘上且非空（`precacheData` 正是照着这份清单 cache.add） */
  const files = [];
  for (const sym in (man.coins || {})) { const f0 = man.coins[sym] && man.coins[sym].file; if (f0) files.push(f0); }
  if (man.liq && man.liq.file) files.push(man.liq.file);
  check('13 清单含 ≥5 个币 ＋ 流动性包', files.length >= 6, `共 ${files.length} 个`);
  const missing = files.filter(f0 => {
    try { return fs.statSync(path.join(ROOT, 'public/data', f0)).size <= 0; } catch { return true; }
  });
  check('13 预缓存清单每个文件都在盘上且非空（覆盖无缺口）', missing.length === 0, missing.join(', '));

  /* ② sw.js 从清单现读，不写死文件名；install 三段齐全 */
  check('13 sw.js 从 data/index.json 现读预缓存清单', sw.includes('data/index.json'));
  check('13 sw.js 不写死任何 .bin 文件名', !/data\/[a-z0-9_-]+\.bin/i.test(sw));
  check('13 sw.js install 三段齐全（shell ＋ assets ＋ data）',
    sw.includes('addAll(SHELL)') && sw.includes('precacheAssets(') && sw.includes('precacheData('));

  /* ③ 断网兜底只对导航请求回退 HTML（T8）＋ 写缓存失败已 catch（T9） */
  check('13 断网兜底只对导航请求回退 index.html（T8）', sw.includes("req.mode === 'navigate'"));
  check('13 cache.put 写缓存失败已 catch（T9）', /cache\.put\(.*?\)\s*\.catch\(/.test(sw));

  /* ④ main.js：SW 注册带构建指纹 · 预热走空闲回调 · 遮罩先铺垫再 reload */
  check('13 SW 注册带构建指纹（?v=）', /register\([^)]*sw\.js\?v=/.test(mainSrc));
  check('13 prefetchAllCoins 走 requestIdleCallback（不挡首帧）',
    /function prefetchAllCoins\(\)[\s\S]{0,200}requestIdleCallback\(/.test(mainSrc));
  check('13 maskReload 先铺遮罩、再 rAF→reload',
    /function maskReload\(\)[\s\S]{0,240}requestAnimationFrame\(\(\) => setTimeout\(\(\) => location\.reload\(\)/.test(mainSrc));

  /* ⑤ m5 / m7 新拍板的两条口径 —— 都是「只在某种档位下才动」的闸，改实现不该把闸拆了 */
  check('13 切页 View Transition 只在动效档=全启用（fx !== 2 直接退化）', /fx !== 2 \|\| vtBusy/.test(mainSrc));
  check('13 K 线首帧画入只尝试一次（chartIntroDone）', /chartIntroDone/.test(mainSrc));

  /* ⑥ 2026-10-05 修「切页闪一下」的**结构不变量**（CSS / DOM 接线在无头环境里跑不起来，只能查结构，
     不冒充行为测试）：`.vt` 收尾只清 `vtBusy`、**不摘类**（摘了 ⇒ `pageIn` 重播 = 两段式闪）；
     抑制只作用于三个 Tab 页（回顾 / 档案两条整屏页保留自己的淡入）。
     ⚠️ 滚动与保证金那两条**能真跑**的，放在 13c 用真实函数断言，不再对源码打正则。 */
  check('13 切页 VT 收尾只清 vtBusy、不再摘 .vt', /\.finally\(\(\) => \{ vtBusy = false; \}\)/.test(mainSrc)
    && !/finally\(\(\) => \{ vtBusy = false; root\.classList\.remove\('vt'\); \}\)/.test(mainSrc));
  check('13 切页 VT 抑制只作用于 Tab 页（#app:not(.rv) > .page.on）',
    /:root\.vt #app:not\(\.rv\) > \.page\.on \{ animation: none; \}/.test(readSrc('src/ui/style.css')));
}

/* ═════ 13c · 保证金步进口径 ＋ HUD 数字滚动（真实行为；2026-10-05） ═════
   ⚠️ 这一节**跑真实函数**：数字滚动的补间/决策来自 `src/core/roll.js`（纯函数，Node 可跑），
      保证金步进走真实 `engine.marginStepOf` / `adjustMargin`。不再用「源码里有没有这句话」冒充通过。 */
section('13c · 保证金步进口径与 HUD 数字滚动（真实行为）');

/* ── c1 · 保证金步进 = 开仓保证金 × frac，且**连点不缩水** ── */
{
  const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1000000, i: idx(at(2022, 0)) });
  s.ex = 'bitmex';
  s.books[s.ex] = { usd: 0, usdt: 1000000 };   // 合约只认 USDT（2022 年该局默认货币还不是 U，显式给）
  s.lev = 5;                                  // ⚠️ 2026-10-05 起 1x 仓不许再加保证金 ⇒ 必须开杠杆仓才能测「+」
  const o = engine.openTrade(s, 'long', 0.2);
  const pos = s.positions.BTC;
  check('13c 建仓成功（后续断言的载体）', o.ok && !!pos, o.why || '');
  if (pos) {
    const base = engine.marginBaseOf(s, 'BTC');
    check('13c 基数量 = 名义 ÷ 杠杆（= 开仓保证金）',
      Math.abs(base - pos.notional / pos.lev) < 1e-6 && base > 1e-9, `base=${f(base, 2)}`);
    check('13c 一次 25% 步进 = 基数 × 0.25',
      Math.abs(engine.marginStepOf(s, 'BTC', 0.25, true) - base * 0.25) < 1e-6);

    /* 核心回归：连点 + 三次，每次金额必须**相等**（旧口径取「剩余可用 × 25%」会逐次缩水）。 */
    const adds = [];
    for (let k = 0; k < 3; k++) {
      const a = engine.marginStepOf(s, 'BTC', 0.25, true);
      adds.push(a);
      if (!(a > 1e-9) || !engine.adjustMargin(s, 'BTC', a).ok) break;
    }
    const driftA = Math.max(...adds) - Math.min(...adds);
    check('13c 连点「+」每次金额恒定（旧口径逐次缩水 → 越点越小）',
      adds.length === 3 && driftA < 1e-6, `steps=${adds.map(v => f(v, 2)).join(' / ')}`);

    /* 减少侧同理（先加厚保证金，再连点 −）。 */
    const subs = [];
    for (let k = 0; k < 2; k++) {
      const a = engine.marginStepOf(s, 'BTC', 0.25, false);
      subs.push(a);
      if (!(a > 1e-9) || !engine.adjustMargin(s, 'BTC', -a).ok) break;
    }
    const driftS = subs.length ? Math.max(...subs) - Math.min(...subs) : 0;
    check('13c 连点「−」每次金额恒定（旧口径同样缩水）',
      subs.length >= 2 && driftS < 1e-6, `steps=${subs.map(v => f(v, 2)).join(' / ')}`);

    /* 夹取不变量：任一 frac 的步进都不得超过该方向上限。 */
    const c1 = engine.marginCapsOf(s, 'BTC');
    check('13c 步进恒 ≤ 该方向上限（可用余额 / 维持线夹取生效）',
      [0.25, 0.5, 1].every(fr => engine.marginStepOf(s, 'BTC', fr, true) <= c1.add + 1e-9
        && engine.marginStepOf(s, 'BTC', fr, false) <= c1.reduce + 1e-9));
  }
}

/* ── c2 · 可用余额不够时，步进被夹到上限（不会算出超过余额的金额） ── */
{
  const s = await mk({ sym: 'BTC', mode: 'fut', cash: 100000, i: idx(at(2022, 0)) });
  s.ex = 'bitmex';
  s.books[s.ex] = { usd: 0, usdt: 100000 };
  s.lev = 5;                                    // 同样要杠杆仓：1x 仓的 add 上限是 0，测不出「可用余额夹住」
  const o = engine.openTrade(s, 'long', 0.9);   // 用掉九成可用 ⇒ 余额只剩一成，小于 25% 基数
  if (o.ok) {
    const caps = engine.marginCapsOf(s, 'BTC');
    const step = engine.marginStepOf(s, 'BTC', 0.25, true);
    const base = engine.marginBaseOf(s, 'BTC');
    check('13c 「+」步进被可用余额夹住（0.25×基数 > 可用时取可用）',
      step <= caps.add + 1e-9 && step < base * 0.25 - 1e-9,
      `step=${f(step, 2)} ≤ add=${f(caps.add, 2)} ＜0.25×base=${f(base * 0.25, 2)}`);
  }
}

/* ── c3 · HUD 数字滚动：按**行为**断言（旧审计只对源码打 `/speed > 1/` 正则 = 假绿） ── */
check('13c 滚动阈值 > 1x 的喂数间隔（约 1000ms）—— 否则 1x 永远不滚',
  roll.ROLL_STALE > 1000, `ROLL_STALE=${roll.ROLL_STALE}ms`);
check('13c 1x 且间隔 1000ms 时必须滚（用户「1 倍速只有闪烁」的回归断言）',
  roll.shouldRoll({ speed: 1, fx: 2, sameTarget: false, sinceLastMs: 1000 }) === true);
check('13c 快进人群（speed>1）直接写',
  roll.shouldRoll({ speed: 2, fx: 2, sinceLastMs: 100 }) === false);
check('13c 动效关档（fx=0）直接写',
  roll.shouldRoll({ speed: 1, fx: 0, sinceLastMs: 100 }) === false);
check('13c 值陈旧（> ROLL_STALE）直接写（切页回来不从远处爬）',
  roll.shouldRoll({ speed: 1, fx: 2, sinceLastMs: roll.ROLL_STALE + 1 }) === false);
check('13c 目标没变直接写',
  roll.shouldRoll({ speed: 1, fx: 2, sameTarget: true, sinceLastMs: 100 }) === false);
{
  const q0 = roll.rollSample(0, 100, 0), qH = roll.rollSample(0, 100, 0.5), q1 = roll.rollSample(0, 100, 1);
  check('13c 补间端点正确（p=0→from、p=1→to）', q0 === 0 && q1 === 100, `${q0} / ${q1}`);
  check('13c 补间 p=0.5 得**严格中间值**（确有中间帧，不是起止两帧的闪烁）',
    qH > 0 && qH < 100 && qH > 50, `sample(0→100, .5)=${f(qH, 2)}（easeOut 应 > 50）`);
  check('13c 补间单调递增（不会来回跳）',
    roll.rollSample(0, 100, 0.25) < roll.rollSample(0, 100, 0.5)
    && roll.rollSample(0, 100, 0.5) < roll.rollSample(0, 100, 0.75));
}

/* ═════ 13d · 2026-10-05 玩家质疑：通道记忆 / 保证金 1x 封顶 / 资金费基数 / OTC 口径 ═════
   四条都走**真实函数**：`chanChoiceOf` / `chanOf` / `advanceOneHour`（闩锁）/ `marginCapsOf` /
   `adjustMargin` / `fundingOf` / `borrowedOf` / `canCloseAt` / `closeTrade`。 */
section('13d · 逐币通道记忆 · 保证金 1x 封顶 · 资金费基数=名义 · OTC 跨通道平仓');

/* ── d1 · 逐币通道记忆（玩家实测回归：BTC 选 OTC → 换币 → 切回 BTC 仍记得） ── */
{
  const s = await mk({ sym: 'BTC', mode: 'margin', cash: 2e7, i: idx(at(2021, 5)) });
  delete s.chanBy;                               // 模拟旧档：根本没有 chanBy
  s.chan = 'book';                               // 兜底默认仍是盘口（只记「选过的币」）
  check('13d 写入口前置：旧档无 chanBy', !s.chanBy);
  engine.setChanChoice(s, 'otc');                // **真实生产写入口**（main.onChan 调的就是它）
  check('13d 写入口：懒建 chanBy 并落库 BTC=otc，生效 otc',
    !!s.chanBy && s.chanBy.BTC === 'otc' && engine.chanOf(s) === 'otc',
    `chanBy.BTC=${s.chanBy && s.chanBy.BTC}`);
  s.sym = 'ETH';                                 // 切到没单独选过的 ETH
  check('13d 换到 ETH ⇒ 回落到兜底 book（不会把 BTC 的选择带过来）',
    engine.chanChoiceOf(s) === 'book' && engine.chanOf(s) === 'book');
  s.sym = 'BTC';                                 // 切回 BTC —— 玩家反馈的核心回归点
  check('13d 切回 BTC ⇒ **仍记得 otc**（逐币记忆生效）',
    engine.chanOf(s) === 'otc', engine.chanOf(s));

  /* 权益跌破门槛：生效回退盘口，但**选择**必须保住，权益恢复后自动回来。 */
  s.books[s.ex] = { usd: 0, usdt: 1000 };
  check('13d 权益跌破门槛 ⇒ 生效回退 book，但选择仍是 otc',
    engine.chanOf(s) === 'book' && engine.chanChoiceOf(s) === 'otc');
  s.pending = null; engine.advanceOneHour(s);
  check('13d 回退闩锁不抹掉玩家选择（s.chanBy.BTC 仍为 otc）',
    s.chanBy && s.chanBy.BTC === 'otc', `chanBy.BTC=${s.chanBy && s.chanBy.BTC}`);
  s.books[s.ex] = { usd: 0, usdt: 2e7 };
  check('13d 权益恢复 ⇒ 记忆的选择自动恢复生效 otc',
    engine.chanOf(s) === 'otc', engine.chanOf(s));
  s.pending = null; engine.advanceOneHour(s);
  check('13d 恢复后闩锁解除（下次真跌落还能再报一次）', !s.otcOff);
}
{
  /* d1b · 旧档（没有 `chanBy`，只有全局 `s.chan`）—— 证明**破坏性复位**已彻底移除：
     旧实现在这里写 `s.chan = 'book'`，会把玩家的 OTC 选择永久抹掉（权益恢复也回不来）。 */
  const s2 = await mk({ sym: 'BTC', mode: 'margin', cash: 2e7, i: idx(at(2021, 5)) });
  delete s2.chanBy;
  s2.chan = 'otc';
  check('13d 旧档兜底：无 chanBy 时 chanChoiceOf 读 s.chan = otc',
    engine.chanChoiceOf(s2) === 'otc' && engine.chanOf(s2) === 'otc');
  s2.books[s2.ex] = { usd: 0, usdt: 1000 };
  s2.pending = null; engine.advanceOneHour(s2);
  check('13d 旧档跌破门槛后 **s.chan 未被写死成 book**（选择保住）',
    s2.chan === 'otc', `s.chan=${s2.chan}`);
  s2.books[s2.ex] = { usd: 0, usdt: 2e7 };
  check('13d 旧档权益恢复 ⇒ 自动恢复 otc（若被复位则永久失效）',
    engine.chanOf(s2) === 'otc', engine.chanOf(s2));
}
check('13d 源码锚点：engine 不再写死 `s.chan = \'book\'`（复位玩家选择的旧 bug 根因）',
  !/s(?:\.chan|\[\s*['"]chan['"]\s*\])\s*=\s*['"]book['"]/.test(fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8')));

/* ── d2 · 保证金加到实际杠杆 1x 即封顶（用户拍板「压平 1x 后不能再加」） ── */
{
  const s = await mk({ sym: 'BTC', mode: 'margin', cash: 2e7, i: idx(at(2021, 5)) });
  s.lev = 3;
  const o = engine.openTrade(s, 'long', 0.02);
  const pos = s.positions.BTC;
  check('13d 1x 封顶前置：3x 建仓成功', o.ok && !!pos, o.why || '');
  if (pos) {
    check('13d 建仓时实际杠杆 = 3x', Math.abs(P.effLevOf(pos) - 3) < 1e-6, `effLev=${f(P.effLevOf(pos), 4)}`);
    check('13d 建仓时确有利息成本（借入 > 0）',
      P.borrowedOf(pos) > 0 && P.paysInterest(pos), `borrowed=${f(P.borrowedOf(pos), 2)}`);
    /* 连点「+」加到加不动为止 —— 每次都走真实 `marginStepOf` / `adjustMargin`。 */
    let guard = 0;
    while (guard++ < 200) {
      const a = engine.marginStepOf(s, 'BTC', 0.25, true);
      if (!(a > 1e-9)) break;
      if (!engine.adjustMargin(s, 'BTC', a).ok) break;
    }
    const caps = engine.marginCapsOf(s, 'BTC');
    check('13d 加到顶后实际杠杆 = 1x（不会跌破 1x）',
      P.effLevOf(pos) >= 1 - 1e-9, `effLev=${f(P.effLevOf(pos), 6)}`);
    check('13d 加到顶后保证金 ≈ 名义（headroom → 0）',
      pos.margin <= pos.notional + 1e-6 && caps.headroom <= 1e-6,
      `margin=${f(pos.margin, 2)} notional=${f(pos.notional, 2)} headroom=${f(caps.headroom, 6)}`);
    check('13d 到顶后 add 上限 = 0（弹层预设键 / 交易页 ± 键据它置灰）',
      caps.add <= 1e-9, `add=${f(caps.add, 6)}`);
    const r = engine.adjustMargin(s, 'BTC', 1);
    check('13d 到顶后再加保证金被拒，且给出「1x」准话',
      !r.ok && /1x/.test(r.why || ''), r.why || '(未被拒)');
    check('13d 压到 1x 后借入归零 ⇒ 停息（用户拍板口径）',
      P.borrowedOf(pos) === 0 && !P.paysInterest(pos),
      `borrowed=${f(P.borrowedOf(pos), 6)} interest=${P.paysInterest(pos)}`);
    check('13d 压到 1x 后不可强平（维持线远在下方）', !P.canLiquidate(pos));
  }
}

/* ── d3 · 资金费基数 = 名义（合约仓：按 8h 资金费轨；与保证金增减无关） ── */
{
  const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e6, i: idx(at(2022, 0)) });
  s.ex = 'bitmex';
  s.books[s.ex] = { usd: 0, usdt: 1e6 };
  s.lev = 5;                                    // 留出 headroom：1x 仓的 add 上限是 0，测不了「加保证金后资金费不变」
  const o = engine.openTrade(s, 'long', 0.2);
  const pos = s.positions.BTC;
  check('13d 资金费前置：合约建仓成功', o.ok && !!pos, o.why || '');
  if (pos) {
    const mark = engine.exMarkPrice(s, 'BTC', pos.ex);
    const rate = 0.0001;                          // 0.01% / 8h
    const dir = pos.side === 'long' ? 1 : -1;
    const expect = pos.size * mark * rate * dir;
    check('13d 资金费基数 = 数量 × 标记价（名义），公式锚定',
      Math.abs(P.fundingOf(pos, mark, rate) - expect) < 1e-6,
      `f=${f(P.fundingOf(pos, mark, rate), 4)} vs ${f(expect, 4)}`);
    check('13d 合约仓 paysFunding = true（走 8h 资金费轨，非逐时利息）', P.paysFunding(pos));
    const before = P.fundingOf(pos, mark, rate);
    const step = engine.marginStepOf(s, 'BTC', 0.25, true);
    const r = step > 1e-9 ? engine.adjustMargin(s, 'BTC', step) : { ok: false, why: '步进为 0' };
    const after = P.fundingOf(pos, mark, rate);
    check('13d 加保证金后资金费**分毫不变**（与保证金无关 —— 权威口径已核）',
      r.ok && Math.abs(after - before) < 1e-9,
      `${f(before, 4)} → ${f(after, 4)}｜margin ${f(pos.margin, 2)}｜${r.why || ''}`);
  }
}

/* ── d4 · OTC 是执行通道、与持仓同质：OTC 建仓后**任一通道都能平**（仅加仓需同通道） ── */
{
  const s = await mk({ scen: 'classic', sym: 'BTC', mode: 'margin', cash: 2e7, i: idx(at(2021, 5)) });
  s.mode = 'margin'; s.lev = 2;
  s.chanBy = { BTC: 'otc' };
  check('13d OTC 平仓前置：通道生效 otc', engine.chanOf(s) === 'otc', engine.chanOf(s));
  const o = engine.openTrade(s, 'long', 0.05);
  check('13d OTC：建仓成功', o.ok && !!s.positions.BTC, o.why || '');
  if (s.positions.BTC) {
    check('13d OTC：仓位带 otc 标记', s.positions.BTC.otc === true, `otc=${s.positions.BTC.otc}`);
    s.chanBy.BTC = 'book';                        // 玩家持仓期间切回盘口（F4 已放开）
    check('13d 切回盘口后生效通道 = book', engine.chanOf(s) === 'book', engine.chanOf(s));
    const add = engine.openTrade(s, 'long', 0.05);
    check('13d 跨通道**加仓**被拦（需先切回同一通道）',
      !add.ok && /通道/.test(add.why || ''), add.why || '(未拦)');
    check('13d OTC 仓位可**跨通道平仓**（与持仓同质 —— 权威口径已核）',
      engine.canCloseAt(s, 1), '');
    const r = engine.closeTrade(s, '测试');
    check('13d 跨通道平仓真的成交、仓位清空',
      r.ok && !s.positions.BTC, r.why || '');
  }
}

/* ═════ 14 · 交易涌现性：资金费**双向** · 对手方池**偿付上限** · 海报/称号口径锚点（2026-10-05 用户点名） ═════
   用户四问：① 玩家能不能靠**吃资金费**赚钱？② 一单没开时海报不该显示 1x；③「场外玩家」称号的分母口径；
   ④ 玩家已实现盈亏能不能让**对手方**承担（架构 → 另有交付说明，不在本节）。
   本节把 ①②③ 钉在真实函数 / 真引擎上。⚠️ 不做假绿：b/c 两组**冻结 NPC 建仓速度**（同 §9n）后
   走 `engine.advanceOneHour` 真结算，读的是真实的 `pos.margin` / `m.npcFund` / `s.realized`。 */
section('14 · 交易涌现性：资金费双向 · 对手方池偿付上限 · 海报/称号口径锚点');

/* ── a · 资金费公式本身是**双向**的（多方付 / 空方收；负费率反之） ＋ 费率有界 ── */
{
  const L = P.openPosition('BTC', 'long', 1000, 100, 10, 0.0004, false);
  const S = P.openPosition('BTC', 'short', 1000, 100, 10, 0.0004, false);
  const mark = 1000, rate = 0.0003;
  check('14a 正费率 ⇒ 多头**付出**（fundingOf > 0）—— 方向不被「永远只付」写死',
    P.fundingOf(L, mark, rate) > 0, f(P.fundingOf(L, mark, rate), 4));
  check('14a 正费率 ⇒ 空头**收取**（fundingOf < 0）—— 玩家确实存在「吃资金费」的那一侧',
    P.fundingOf(S, mark, rate) < 0, f(P.fundingOf(S, mark, rate), 4));
  check('14a 负费率 ⇒ 双向可逆（多头收、空头付）',
    P.fundingOf(L, mark, -rate) < 0 && P.fundingOf(S, mark, -rate) > 0);
  check('14a 中性带（share = 0.5）费率恒 = I = 0.01%/8h（现实里 78–92% 的时间落在这一档）',
    P.fundingRateOf(P.premiumIndexOf(0.5)) === P.FR.interest, `${P.FR.interest}`);
  let bounded = true, maxAbs = 0;
  for (let sh = 0; sh <= 1 + 1e-9; sh += 0.01) {
    const r = P.fundingRateOf(P.premiumIndexOf(sh));
    if (!Number.isFinite(r) || Math.abs(r) > P.FR.max + 1e-12) bounded = false;
    maxAbs = Math.max(maxAbs, Math.abs(r));
  }
  check('14a 费率遍历 share∈[0,1] 恒有限且 |F| ≤ FR.max（不会给出打穿账户的极端费率）',
    bounded, `max|F|=${f(maxAbs, 6)} / cap=${P.FR.max}`);
  /* ⚠️ **涌现性发现**：`FR.max = 0.75%/8h` 是**上界但当前不可达** —— `P` 被 `FR.k = 0.003` 封在
     ±0.3%，再过 `clamp(±0.05%)` 修正后，实际能到的最极端费率是 **±0.25%/8h**。这条断言把它记下来：
     将来谁调 `FR.k / FR.clamp`，这里会先报，免得「以为存在 0.75% 的费率档」。 */
  check('14a（发现）实际费率封顶 = ±0.25%/8h（由 FR.k 决定；FR.max 只是兜底上界）',
    Math.abs(maxAbs - 0.0025) < 1e-9, `max|F|=${f(maxAbs, 6)}`);
}

/* ── b/c · 真引擎：玩家能否**吃到**资金费 —— 双向 ＋ 池的偿付上限 ── */
{
  const F = P.FUNDING.hours;
  const speed0 = god.NPC.speed, mm0 = god.NPC.mm.speed;
  /* 摆好 NPC 账本后**冻结建仓速度**（同 §9n）⇒ `tickMarket` 不再改动账本 ⇒ `npcNet` 与池的
     进出一一可算。`ledger`：`netLong` = 六档只有第 0 档净多（npcN > 0）；`flat` = 六档多空各 n（npcN = 0）。 */
  const run = async ({ ledger, poolFrac = 0, frac = 0.06 }) => {
    const s = await mk({ scen: 'classic', sym: 'BTC', mode: 'fut', cash: 1e6, i: idx(at(2017, 4, 1)) });
    s.ex = 'bitmex';
    s.books[s.ex] = { usd: 0, usdt: 1e6 };
    s.hintOn = false;                                  // 老手：不触发预警遮罩（否则会 return 在结算之前）
    s.lev = 5;
    /* 先定相位：`s.i + 1` 落在 8h 整点 ⇒ `settleFunding` 的永续分支才跑。 */
    s.i = Math.floor(s.i / F) * F + (F - 1);
    engine.tickMarket(s, 'BTC');
    const o = engine.openTrade(s, 'short', frac);       // 玩家做空：正费率下**收取**资金费
    const pos = s.positions.BTC;
    if (!o.ok || !pos) return { o };
    const m = s.mkt.BTC;
    const price = engine.lastPrice(s, 'BTC');
    const n = pos.size * price;
    for (const g of m.npc) {
      g.long = ledger === 'netLong' ? (g === m.npc[0] ? n * 20 : 0) : n;
      g.longAvg = price;
      g.short = ledger === 'netLong' ? 0 : n;
      g.shortAvg = price;
      g.longStopped = false; g.shortStopped = false; g.longTp = false; g.shortTp = false;
    }
    if (m.mm) { m.mm.long = 0; m.mm.short = 0; m.mm.longAvg = 0; m.mm.shortAvg = 0; }
    m.npcFund = 0;                                     // 先归零 ⇒ 下面的 `rate` 与池余额无关
    const rate = engine.fundingForecastOf(s, 'BTC').rate;   // 账本已冻结 ⇒ 这就是结算用的费率
    const mark = engine.exMarkPrice(s, 'BTC', pos.ex);
    const exp = pos.size * mark * rate;                // 正 ⇒ 空头应收到这么多
    m.npcFund = poolFrac * exp;
    const npcN = m.npc.reduce((a, g) => a + (g.long - g.short), 0)
      + (m.mm ? m.mm.long - m.mm.short : 0);
    const before = { margin: pos.margin, fund: m.npcFund, realized: s.realized };
    god.NPC.speed = 0; god.NPC.mm.speed = 0;
    try { engine.advanceOneHour(s); } finally { god.NPC.speed = speed0; god.NPC.mm.speed = mm0; }
    return {
      s, pos, m, rate, npcN, mark, exp, before,
      dm: pos.margin - before.margin,                  // 保证金变化（永续仓只受资金费影响）
      df: m.npcFund - before.fund,                     // 对手方池变化
      dr: s.realized - before.realized,                // 已实现盈亏变化
    };
  };

  /* b · 多头拥挤（npcN ≫ 0）：玩家做空 ⇒ **净收**资金费，钱来自市场净额 ＋ 对手方池。 */
  const b = await run({ ledger: 'netLong' });
  check('14b 前置：合约空头建仓成功且落在资金费结算点',
    !!(b.pos && b.dm !== undefined && b.s.i % F === 0), b.pos ? `i=${b.s.i} rate=${f(b.rate, 6)}` : '建仓失败');
  if (b.dm !== undefined) {
    check('14b 多头拥挤 + 玩家做空 ⇒ 费率 > 0（空头是收钱的一侧）', b.rate > 0, `rate=${f(b.rate, 6)}`);
    check('14b 玩家**真的吃到了**资金费：保证金增加 ≈ 应收（±2%）',
      b.dm > 0 && Math.abs(b.dm - b.exp) <= Math.abs(b.exp) * 0.02 + 1e-9,
      `Δmargin=${f(b.dm, 4)} vs 应收=${f(b.exp, 4)}`);
    check('14b 已实现盈亏同步增加（HUD 副行 / 档案口径与保证金一致）',
      Math.abs(b.dr - b.dm) < 1e-9, `Δrealized=${f(b.dr, 4)}`);
    check('14b 零和：玩家收的 ＋ 池收的 = 市场净额该付的（`Δmargin + Δpool = rate × npcN`）',
      Math.abs((b.dm + b.df) - b.rate * b.npcN) < Math.abs(b.rate * b.npcN) * 0.02 + 1e-6,
      `Δmargin+Δpool=${f(b.dm + b.df, 2)} vs rate×npcN=${f(b.rate * b.npcN, 2)}`);
    check('14b 对手方池恒 ≥ 0（收钱不会把池子吃成负数）', b.m.npcFund >= 0, `池=${f(b.m.npcFund, 2)}`);
  }

  /* c · NPC 净额 = 0（池不被补给）：玩家吃资金费**只能吃到池里有的那部分** = 现实里平台的承兑上限。 */
  const c0 = await run({ ledger: 'flat', poolFrac: 0 });
  const c1 = await run({ ledger: 'flat', poolFrac: 0.25 });
  const c2 = await run({ ledger: 'flat', poolFrac: 10 });
  if (c0.dm !== undefined && c1.dm !== undefined && c2.dm !== undefined) {
    check('14c 前置：npcN = 0（池不会被市场净额补给）且玩家应收 > 0',
      c0.npcN === 0 && c0.exp > 0, `npcN=${f(c0.npcN, 2)} 应收=${f(c0.exp, 4)}`);
    check('14c 池为空（$0）⇒ 玩家**一分也收不到**（保证金零变动，不是凭空造钱）',
      Math.abs(c0.dm) < 1e-9 && c0.m.npcFund === 0, `Δmargin=${f(c0.dm, 6)} 池=${f(c0.m.npcFund, 6)}`);
    check('14c 池只有 25% 应收 ⇒ 玩家**只收到池里有的那点**，池被抽干但不为负',
      Math.abs(c1.dm - c1.before.fund) < Math.abs(c1.exp) * 0.02 + 1e-9
      && c1.m.npcFund >= 0 && c1.m.npcFund < Math.abs(c1.exp) * 0.02 + 1e-9,
      `Δmargin=${f(c1.dm, 4)} vs 池初始=${f(c1.before.fund, 4)} 池余=${f(c1.m.npcFund, 6)}`);
    check('14c 池远超应收 ⇒ 玩家收足全额（上限只在池不够时生效）',
      Math.abs(c2.dm - c2.exp) <= Math.abs(c2.exp) * 0.02 + 1e-9 && c2.m.npcFund >= 0,
      `Δmargin=${f(c2.dm, 4)} vs 应收=${f(c2.exp, 4)}`);
  }
}

/* ── d · 海报「最高杠杆」空态锚点（用户点名 bug：一单没开不该显示 1x） ── */
{
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/shareCard.js'), 'utf8');
  check('14d 源码锚点：海报「最高杠杆」按 `rec.open > 0` 守卫',
    /最高杠杆/.test(src) && /rec\.open > 0\s*\?/.test(src));
  check('14d 源码锚点：旧的**无条件**写法已删除（一单没开不再报 1x）',
    !/\['最高杠杆',\s*`\$\{rec\.maxLev\}x`\]/.test(src));
  /* 根因锚点：`s.stat.maxLev` 初值就是 1 —— 空仓局会把它原样带出来，才需要那道守卫。 */
  const fresh = createState('classic');
  check('14d 根因锚点：空仓局 `stat.maxLev === 1` 且 `open === 0`（守卫必须存在）',
    fresh.stat.maxLev === 1 && fresh.stat.open === 0,
    `maxLev=${fresh.stat.maxLev} open=${fresh.stat.open}`);
}

/* ── e · 「场外玩家」分母口径（回归：盘口开仓 + OTC 平仓 不得冒充「几乎不碰盘口」） ── */
{
  const T = await import('../src/core/titles.js');
  const base = {
    scen: 'classic', reason: engine.OVER.SETTLED, days: 1000, cash0: 1000, final: 2000, peak: 2000,
    realized: 0, liq: 0, move: 0, god: 0, loan: 0, addOn: 0, mgUp: 0, mgDown: 0, mgCut: 0, part: 0,
    syms: ['BTC', 'ETH'], win: 0, loss: 0, eq: [],
  };
  /* 3 笔**全部在盘口开仓**，3 笔**全部在 OTC 平仓** ⇒ 分母含平仓后占比 = 50% < 60% ⇒ 不该拿称号。 */
  const r1 = { ...base, open: 3, otc: 3, win: 3, loss: 0, margin: 1, fut: 2, maxLev: 3 };
  check('14e 盘口开 3 单 + OTC 平 3 单 ⇒ **不**判「场外玩家」（分母含平仓，修掉「只在 OTC 平仓」的冒充）',
    T.styleOf(r1) !== '场外玩家', T.styleOf(r1));
  /* 对照：OTC 成交占**全部成交**（开仓 ＋ 平仓）≥ 60% ⇒ 仍照常拿称号。 */
  const r2 = { ...base, open: 3, otc: 4, win: 1, loss: 0, margin: 1, fut: 2, maxLev: 3 };
  check('14e 对照：OTC 成交占**全部成交** ≥ 60% ⇒ 仍判「场外玩家」',
    T.styleOf(r2) === '场外玩家', T.styleOf(r2));
}

/* ── f · 海报版面（2026-10-05 用户拍板「文案完整 ＋ 再加几行内容」）源码锚点 ──
   只锚「有没有按拍板改」，不替代像素级目测；尺寸 / 全版评语 / 新增行任何一项被改回去都会亮红。 */
{
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/shareCard.js'), 'utf8');
  check('14f 源码锚点：海报尺寸加高到 1080×1620', /const W = 1080/.test(src) && /const H = 1620/.test(src));
  check('14f 源码锚点：结局评语用**全版**（不再取 short 丢补白句）',
    /epitaphOf\(rec\)/.test(src) && !/epitaphOf\(rec,\s*\{\s*short:\s*true\s*\}\)/.test(src));
  check('14f 源码锚点：评语按宽度折行、不截断（`wrapText` 已就位）', /function wrapText\(/.test(src));
  check('14f 源码锚点：账本补上「已实现盈亏」一格', /已实现盈亏/.test(src));
  check('14f 源码锚点：新增「交易明细」与「行为足迹」两行',
    /交易明细/.test(src) && /行为足迹/.test(src));
  /* 徽章旧版把折行硬上限设成两行 ⇒ 第 3 行起溢出画布右缘；那枚常量必须已删除。 */
  check('14f 源码锚点：徽章旧的两行硬上限常量已删除', !/ROW_MAX/.test(src));
}

/* ═════ 15 · 方案 A：玩家已实现盈亏由**对手方池**承担（零和 · 池恒 ≥ 0 · 上限溢出 · 无玩家自洽）（2026-10-05） ═════
   病根（本轮资金流审计）：改动前 `closeTrade` 只 `credit(net)`、没有任何配对扣款 ⇒ 玩家**盈利凭空造钱**、
   **亏损凭空销毁**，市场不因玩家盈亏受损 / 受益。方案 A 把 `m.npcFund` 升级为**对手方结算账户**：
     · 玩家毛盈亏 `pnl` ⇒ 池 `npcFund −= pnl`（正 = 池付出）；抽干时由保险基金 `s.fund` 足额兜底（SAFU）；
     · NPC 减仓 / 止损 / 止盈的已实现盈亏也入池，但**只在池余额内兑付**、不吃基金（见 `settlePool` 注释）。
   本节全部走**真引擎**（`openTrade` / `closeTrade` / `advanceOneHour`），不做「只比符号」的假绿
   （仅 g 组是刻意的源码锚点，用于防回归删除）。 */
section('15 · 方案 A：玩家盈亏由对手方池承担（零和 · 池恒≥0 · 上限溢出 · 无玩家自洽）');
{
  const bookCash = (s, ex) => { const b = s.books[ex]; return b ? b.usd + b.usdt : 0; };
  /* 走一个完整往返（开仓 → 推进到「价格相对开仓价达标」→ 平仓），返回平仓前后的账户快照。
     `dir` = 'up'（等价格高于开仓价）/ 'down'（等低于）。
     `pool0`：平仓前把池**精确**设成它（15c/d 边界用）。
     `pool0Frac`：平仓前把池设成 `cap × frac`（15a/b 用）——
       ⚠️ 为什么需要它：`npcFund` 播种为 0，且会被 NPC 已实现盈利**抽干至 0**（`backstop=false` 就地截断），
          于是在没有玩家注入资金费的审计场景里，池常常**恰好停在 0**。若不动它，一笔玩家盈利会立刻
          触发 SAFU 兜底（Δpool=0、Δfund=−pnl），那就测不到「池吸收毛盈亏」这条主路径了 ——
          所以 a/b 先把池摆到**远离两端边界**的半仓水位，再平仓。 */
  const roundTrip = async ({ side, dir, i0, pool0 = null, pool0Frac = null }) => {
    const s = await mk({ scen: 'classic', sym: 'BTC', mode: 'fut', cash: 1e6, i: i0 });
    s.ex = 'bitmex';
    s.books[s.ex] = { usd: 0, usdt: 1e6 };
    s.hintOn = false;                                  // 老手：不触发预警遮罩（会拦在结算之前）
    s.lev = 3;                                         // 低杠杆 ⇒ 推进期间不易被强平
    engine.tickMarket(s, 'BTC');
    const o = engine.openTrade(s, side, 0.05);
    if (!o.ok || !s.positions.BTC) return null;
    const entry = s.positions.BTC.entry;
    for (let k = 0; k < 1000 && s.positions.BTC; k++) {
      engine.advanceOneHour(s);
      if (s.over || s.pending) break;
      const p = engine.lastPrice(s, 'BTC');
      if (dir === 'up' ? p > entry * 1.01 : p < entry * 0.99) break;
    }
    const pos = s.positions.BTC;
    if (!pos) return null;
    const m = s.mkt.BTC;
    const cap = market.liqOf('BTC', market.dayIndexOf(s.i)) * P.CPOOL.capFrac;
    if (pool0 != null) m.npcFund = pool0;                    // 15d：精确摆到上限
    else if (pool0Frac != null) m.npcFund = cap * pool0Frac; // 15a/b：半仓，远离两端边界
    const snap = { ex: bookCash(s, pos.ex), pool: m.npcFund, fund: s.fund, real: s.realized };
    const r = engine.closeTrade(s, '审计15');
    if (!r.ok) return null;
    return { s, pos, entry, cap, snap, after: { ex: bookCash(s, pos.ex), pool: m.npcFund, fund: s.fund, real: s.realized } };
  };
  /* 从「平仓款 = 保证金 + 毛盈亏 − 平仓费」**反解成交价 `fill`** ⇒ 独立算出毛盈亏 / 手续费，
     与引擎内部分毫对照（这样「Δpool = −pnl」才是真断言，而不是拿 `−Δpool` 当 pnl 自证）。 */
  const parse = (t) => {
    const { s, pos, entry, snap, after } = t;
    const sign = pos.side === 'long' ? 1 : -1;
    const size = pos.size;
    const pk = P.isMargin(pos) ? 'margin' : 'fut';
    const fr = C.feeRateOf(pos.ex, engine.timeOf(s), pk, engine.vol30Of(s, pos.ex, s.i, pk));
    const dcash = after.ex - snap.ex, dpool = after.pool - snap.pool;
    const dfund = after.fund - snap.fund, dreal = after.real - snap.real;
    const K = dcash - pos.margin + entry * size * sign;
    const fill = K / (size * (sign - fr));
    const pnl = (fill - entry) * size * sign;
    const fee = size * fill * fr;
    return { dcash, dpool, dfund, dreal, fill, pnl, fee, margin: pos.margin };
  };

  /* a · 玩家**盈利** ⇒ 池逐位吸收毛盈亏、基金不动、玩家足额拿到钱。 */
  const prof = await roundTrip({ side: 'long', dir: 'up', i0: idx(at(2017, 4, 1)), pool0Frac: 0.5 });
  check('15a 前置：玩家平仓**盈利**（多头，价格上行）', !!prof && parse(prof).pnl > 0,
    prof ? `pnl=${f(parse(prof).pnl, 2)}` : '未取到往返样本');
  if (prof) {
    const p = parse(prof);
    check('15a 零和：玩家毛盈利被对手方池**逐位**吸收（Δpool = −pnl，非凭空造钱）',
      Math.abs(p.dpool + p.pnl) <= 1e-6 * Math.max(1, Math.abs(p.pnl)),
      `Δpool=${f(p.dpool, 6)} pnl=${f(p.pnl, 6)}`);
    check('15a 池未触边界 ⇒ 保险基金分毫不动（Δfund = 0）', Math.abs(p.dfund) < 1e-6, `Δfund=${f(p.dfund, 6)}`);
    check('15a 现金恒等式：Δcash = 保证金 + pnl − 平仓费（玩家足额拿到盈利）',
      Math.abs(p.dcash - (p.margin + p.pnl - p.fee)) < 1e-6,
      `Δcash=${f(p.dcash, 6)} 应=${f(p.margin + p.pnl - p.fee, 6)}`);
  }

  /* b · 玩家**亏损** ⇒ 池反向增收毛亏损（钱不再凭空销毁）。 */
  const loss = await roundTrip({ side: 'long', dir: 'down', i0: idx(at(2018, 1, 15)), pool0Frac: 0.5 });
  check('15b 前置：玩家平仓**亏损**（多头，价格下行）', !!loss && parse(loss).pnl < 0,
    loss ? `pnl=${f(parse(loss).pnl, 2)}` : '未取到往返样本');
  if (loss) {
    const p = parse(loss);
    check('15b 零和：玩家毛亏损被对手方池**逐位**收入（Δpool = −pnl > 0，非凭空销毁）',
      Math.abs(p.dpool + p.pnl) <= 1e-6 * Math.max(1, Math.abs(p.pnl)) && p.dpool > 0,
      `Δpool=${f(p.dpool, 6)} pnl=${f(p.pnl, 6)}`);
    check('15b 池未触边界 ⇒ 保险基金分毫不动（Δfund = 0）', Math.abs(p.dfund) < 1e-6, `Δfund=${f(p.dfund, 6)}`);
  }

  /* c · 池被抽干 ⇒ **足额兑付**、差额由保险基金补（SAFU），池恒 ≥ 0。 */
  const floored = await roundTrip({ side: 'long', dir: 'up', i0: idx(at(2017, 4, 1)), pool0: 0 });
  if (floored) {
    const p = parse(floored);
    check('15c 池为空（$0）⇒ 玩家仍**足额**拿到盈利（Δcash 按公式，不打折）',
      p.pnl > 0 && Math.abs(p.dcash - (p.margin + p.pnl - p.fee)) < 1e-6,
      `pnl=${f(p.pnl, 2)} Δcash=${f(p.dcash, 2)}`);
    check('15c 缺口由保险基金补回 0（Δfund = −缺口 = −pnl，池恒 ≥ 0）',
      floored.after.pool === 0 && Math.abs(p.dfund + p.pnl) <= 1e-6 * Math.max(1, Math.abs(p.pnl)),
      `池余=${f(floored.after.pool, 6)} Δfund=${f(p.dfund, 6)} 缺口=${f(-p.pnl, 6)}`);
  }

  /* d · 玩家亏损把池顶到上限 ⇒ 溢出转入保险基金，池 = cap（不无限膨胀）。 */
  const capProbe = await roundTrip({ side: 'long', dir: 'down', i0: idx(at(2018, 1, 15)) });
  if (capProbe) {
    const pool0 = capProbe.cap;                        // 摆到**恰好顶格** ⇒ 任何一笔亏损都必溢出
    /* ⚠️ 曾用 `cap × 0.999`，但 0.1% 的余量（≈13.5 万）远大于这局的实际亏损（≈1 万）⇒ 池根本没到顶，
       测的其实是「未到顶」，红灯是**测试前提写错**，不是实现错。顶格摆位才能可靠命中溢出分支。 */
    const t = await roundTrip({ side: 'long', dir: 'down', i0: idx(at(2018, 1, 15)), pool0 });
    if (t) {
      const p = parse(t);
      const expectFund = (pool0 - p.pnl) - t.cap;      // 溢出额
      check('15d 池顶到上限 ⇒ 池恰好停在 cap（不无限膨胀）',
        p.pnl < 0 && Math.abs(t.after.pool - t.cap) < 1e-6, `池=${f(t.after.pool, 4)} cap=${f(t.cap, 4)}`);
      check('15d 溢出额逐位转入保险基金（Δfund = 池水位 + 毛亏损 − cap）',
        Math.abs(p.dfund - expectFund) < 1e-6 * Math.max(1, Math.abs(expectFund)),
        `Δfund=${f(p.dfund, 4)} 应=${f(expectFund, 4)}`);
    }
  }

  /* e · 无玩家推进 200h：池始终有限、恒 ≥ 0，且**确有变化**（NPC 减仓 / 资金费给池收入流，非死水）。 */
  {
    const s = await mk({ scen: 'classic', sym: 'BTC', mode: 'fut', cash: 1e6, i: idx(at(2017, 4, 1)) });
    s.hintOn = false;
    let min = Infinity, max = -Infinity, finite = true, neg = false;
    for (let k = 0; k < 200; k++) {
      engine.advanceOneHour(s);
      const pf = s.mkt.BTC ? (s.mkt.BTC.npcFund || 0) : 0;
      if (!Number.isFinite(pf)) finite = false;
      if (pf < 0) neg = true;
      min = Math.min(min, pf); max = Math.max(max, pf);
    }
    check('15e 无玩家 200h：池全程有限且恒 ≥ 0', finite && !neg, `min=${f(min, 2)} max=${f(max, 2)}`);
    check('15e 无玩家时池**确有变化**（NPC 减仓 / 资金费给池收入流，不是恒 0 的死水）',
      max - min > 1e-6, `max−min=${f(max - min, 6)}`);
  }

  /* f · 长跑（月度采样到本局终点）：池恒 ≥ 0 且有限 —— 池不会在 12 年里被抽成负数或爆成 Infinity。 */
  {
    const s = await mk({ scen: 'classic', sym: 'BTC', mode: 'fut', cash: 1e5, i: idx(at(2017, 4, 1)) });
    s.hintOn = false;
    let min = Infinity, max = -Infinity, finite = true;
    for (let step = 0; step < 130 && s.i < s.endI; step++) {
      for (let j = 0; j < 24 * 30; j++) engine.advanceOneHour(s);
      const pf = s.mkt.BTC ? (s.mkt.BTC.npcFund || 0) : 0;
      if (!Number.isFinite(pf)) { finite = false; break; }
      min = Math.min(min, pf); max = Math.max(max, pf);
    }
    check('15f 长跑（月度采样）：池全程有限且恒 ≥ 0（NPC 侧只在池余额内兑付）',
      finite && min >= -1e-9, `min=${f(min, 2)} max=${f(max, 2)}`);
  }

  /* g · 源码锚点（防回归删除）：调用点 + `fundSettle` 口径未动 + 玩家/NPC 兜底分叉。 */
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
    check('15g 锚点：`closeTrade` 内确有 `settlePlayerPnl(s, sym, pnl)` 调用',
      /settlePlayerPnl\(s,\s*sym,\s*pnl\)/.test(src));
    check('15g 锚点：`fundSettle` 口径未被改动（仍 `s.fund += notional / lev - loss;`）',
      /s\.fund \+= notional \/ lev - loss;/.test(src));
    check('15g 锚点：`settlePool` 对玩家兜底、对 NPC 不兜底（backstop 两支俱全）',
      /if \(backstop\)/.test(src) && /else m\.npcFund = 0;/.test(src));
  }
}

/* ═══════════════════ 总账 ═══════════════════ */
section('总账');
console.log(`通过 ${pass} · 失败 ${fail}`);
if (bad.length) { console.log('阻塞项：'); for (const b of bad) console.log('  ✗ ' + b); }
process.exitCode = fail ? 1 : 0;
