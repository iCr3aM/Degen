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

const { createState, STATE_VERSION, usdtHeldOf } = await import('../src/core/state.js');
const engine = await import('../src/core/engine.js');
const market = await import('../src/core/market.js');
const god = await import('../src/core/god.js');
const P = await import('../src/core/positions.js');
const impact = await import('../src/core/impact.js');
const levels = await import('../src/core/levels.js');
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

/* NPC 节奏冻结（2026-10-08 sp 梯度改版同步）：npcBuild 的建仓/减仓速度改读 `NPC.ladder[k].sp`
   （档位速度，见 god.js ladder 注），旧探针只钉 `god.NPC.speed` 已冻结不住 ⇒ 六档 ＋ 做市
   一起钉。返回恢复函数，配 finally 用。 */
const npcFreeze = () => {
  const save = god.NPC.ladder.map(r => r.sp), mm = god.NPC.mm.speed;
  for (const r of god.NPC.ladder) r.sp = 0;
  god.NPC.mm.speed = 0;
  return () => { god.NPC.ladder.forEach((r, i) => { r.sp = save[i]; }); god.NPC.mm.speed = mm; };
};

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
  // ⑦ 「无限资金」默认关 ⇒ `enableGod` 补出 `inf: false`，且归零行为与改动前逐位相同
  {
    const s = await mk({ cash: 1000 });
    const g = god.enableGod(s);
    check('2c 无限资金默认关（enableGod 补 inf=false）', g.inf === false, `inf=${JSON.stringify(g.inf)}`);
    await ruin(s, '审计-无限资金-默认关');
    check('2c 默认关：归零只提示、不补钱（与改动前一致）',
      s.godRuined === true && engine.equity(s) <= 0 && s.over == null && s.pending == null,
      `equity=${f(engine.equity(s), 2)} godRuined=${s.godRuined} over=${JSON.stringify(s.over)}`);
  }
  // ⑧ 无限资金开启 ⇒ 归零**当场补满**到 `lastFill`，负账本一并清零，且不再走「归零不结束本局」
  {
    const s = await mk({ cash: 1000 });
    god.enableGod(s);
    s.god.inf = true;
    s.god.lastFill = 50000;
    await ruin(s, '审计-无限资金-开启');
    check('2c 无限资金：归零补满到 lastFill（设定，不是累加）',
      Math.abs(engine.equity(s) - 50000) < 1e-6, `equity=${f(engine.equity(s), 2)} 应=50000`);
    check('2c 无限资金：补满后本局未结束、未进待决',
      s.over == null && s.pending == null, `over=${JSON.stringify(s.over)} pending=${s.pending}`);
    check('2c 无限资金：godRuined 复位（下一次归零还能再补一遍）',
      s.godRuined === false, `godRuined=${s.godRuined}`);
    check('2c 无限资金：负账本一并清零（usd / usdt 都不为负）',
      s.books[s.ex].usd >= 0 && s.books[s.ex].usdt >= 0,
      `usd=${f(s.books[s.ex].usd, 2)} usdt=${f(s.books[s.ex].usdt, 2)}`);
    /* 补满之后余额 > 0 ⇒ 已不再是破产态 ⇒ 后面几小时**不许**再补一次（否则日志会被刷屏）。 */
    const n0 = s.log.filter(e => /无限资金，已补满/.test(e.text)).length;
    for (let k = 0; k < 5; k++) engine.advanceOneHour(s);
    const n1 = s.log.filter(e => /无限资金，已补满/.test(e.text)).length;
    check('2c 无限资金：补满后 5 小时不再补（不是每小时刷一条）', n1 === n0, `补满日志 ${n0} → ${n1}`);
  }
  // ⑨ `lastFill ≤ 0`（玩家自己填过 0）⇒ 退回普通提示，免得「补 0 元」变成每小时一条死循环
  {
    const s = await mk({ cash: 1000 });
    god.enableGod(s);
    s.god.inf = true;
    s.god.lastFill = 0;
    await ruin(s, '审计-无限资金-零额');
    check('2c 无限资金：lastFill=0 时退回普通提示（不补、不刷屏）',
      s.godRuined === true && engine.equity(s) <= 0 && s.over == null,
      `equity=${f(engine.equity(s), 2)} godRuined=${s.godRuined}`);
  }
  // ⑩ 旧档（有 god / 开过上帝模式，但**没有 inf 这个键**）⇒ 读侧一律当关
  {
    const s = await mk({ cash: 1000 });
    s.god = { lastFill: 50000, sb: { ...god.SB_DEFAULT } };   // 模拟 v31 旧档：只缺 inf
    await ruin(s, '审计-无限资金-旧档');
    check('2c 旧档缺 inf 键 ⇒ 视为关闭、不补钱',
      s.godRuined === true && engine.equity(s) <= 0 && s.over == null,
      `equity=${f(engine.equity(s), 2)} godRuined=${s.godRuined}`);
  }
  // ⑪ `godFillCash` 是「设定余额」：面板的「填入」与自动补满共用这一份，两处口径必须一致
  {
    const s = await mk({ cash: 123456, i: idx(at(2013, 0)) });
    god.enableGod(s);
    engine.godFillCash(s, 50000);
    check('2c godFillCash 是「设定」而不是「累加」',
      Math.abs(engine.equity(s) - 50000) < 1e-6, `equity=${f(engine.equity(s), 2)} 应=50000`);
    engine.godFillCash(s, 100);
    check('2c godFillCash 二次设定覆盖前值', Math.abs(engine.equity(s) - 100) < 1e-6,
      `equity=${f(engine.equity(s), 2)} 应=100`);
    check('2c godFillCash 同步 lastFill ＋ 复位 godRuined',
      s.god.lastFill === 100 && s.godRuined === false,
      `lastFill=${s.god.lastFill} godRuined=${s.godRuined}`);
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

/* ── 9d′ · 永久分量标定（缺口 9 · 2026-10-08 用户拍板「永久冲击偏高」） ──
   文献（Bouchaud 2019 / Almgren–Chriss，实测 arXiv:1901.05332）里 metaorder 冲击结束后位移
   **先回落到峰值的 2/3**、再幂律衰减收敛到**首日末的 1/2** ⇒ 永久/峰值 ≈ **1/3**。
   旧代码把这两步乘漏了（直接把 1/2 当成相对峰值）⇒ 渐近线停在峰值的一半、系统性地「留痕过深」。 */
{
  check('9d′ 永久分量常量：coin 0.28 / fut 0.18 / 兜底 0.22（峰值的 ≈1/3 上沿）',
    god.SHOCK_MODE.coin.perm === 0.28 && god.SHOCK_MODE.fut.perm === 0.18 && god.SHOCK.perm === 0.22,
    `coin=${god.SHOCK_MODE.coin.perm} fut=${god.SHOCK_MODE.fut.perm} 兜底=${god.SHOCK.perm}`);
  check('9d′ 三个永久分量都落在 0.15–0.34（贴近文献的 1/3，且仍高于高频小单样本）',
    [god.SHOCK_MODE.coin.perm, god.SHOCK_MODE.fut.perm, god.SHOCK.perm].every(p => p >= 0.15 && p <= 0.34));
  /* 行为锚：写一笔冲击后读**渐近线** —— 去掉 riseMax 夹子时 `playerFactor` = 1 + delta × decay(e)，
     e = 0 恒为满额、e → ∞ 收敛到 perm ⇒ 长期残值 = delta × perm。 */
  const sA = await mk({ sym: 'BTC', i: idx(at(2016, 1)), cash: 10000 });
  sA.god = { on: true };
  const PA = { perm: god.SHOCK_MODE.fut.perm, betaFast: god.SHOCK_MODE.fut.betaFast };
  god.addFlow(sA, 'BTC', 0.1, PA);
  const f0 = god.playerFactor(sA, 'BTC', sA.i);
  const fInf = god.playerFactor(sA, 'BTC', sA.i + 1e7);
  const fFar = god.playerFactor(sA, 'BTC', sA.i + 1e8);
  const ratio = (fInf - 1) / (f0 - 1);            // 长期残值 ÷ 峰值
  /* ⚠️ 不拿 perm 做逐位相等：慢幂律 `β = 0.3` 在 e = 1e7 时仍有 0.63% 的尾巴，
     故断言「比值落在 [perm, perm + 1pp]」—— 上界就是「两步乘漏」的旧口径是否被真的压下去。 */
  check('9d′ 长期残值 ÷ 峰值 = perm（10% 冲击 ⇒ ≈1.85%；旧口径 perm=0.40 ⇒ 4.1%）',
    f0 === 1.1 && ratio >= PA.perm && ratio <= PA.perm + 0.01,
    `e=0 ⇒ ${f(f0, 6)}；e=1e7 ⇒ ${f(fInf, 6)}；比值 ${f(ratio, 6)}（perm = ${PA.perm}）`);
  check('9d′ 残值单调下行且已收敛（再走一个数量级的变化 < 0.1pp）',
    fFar < fInf && fInf - fFar < 1e-3, `e=1e8 ⇒ ${f(fFar, 6)}`);
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

    /* ── 上帝状态不进存档（2026-10-07 用户拍板「一次性游戏」）──
       落盘的永远是普通局：save 剔除 god / godRuined（`save.js` 的 EPHEMERAL）；
       「这局用过上帝」由 `stat.god` 作证（结算 / 生涯档案要认得出它）。
       旧档兼容：历史版本落过 god 的档，读侧剥掉、不弃档（不升 STATE_VERSION）。 */
    const sG = await mk({ scen: 'classic', sym: 'BTC', cash: 50000, i: idx(at(2020, 5)) });
    god.enableGod(sG);
    engine.godFillCash(sG, 123456);
    check('10 前置：内存里 god 在且 stat.god 已置位', !!sG.god && sG.stat.god === true);
    check('10 上帝局落盘成功', save.save(sG) === true);
    const objG = JSON.parse(mem.get('degen_save_normal'));
    check('10 档文顶层没有 god / godRuined 键（不进存档）',
      !('god' in objG) && !('godRuined' in objG),
      `残留 ${['god', 'godRuined'].filter(k => k in objG).join('/') || '无'}`);
    check('10 stat.god 作证保留（结算 / 生涯认得出这局用过上帝）',
      objG.stat && objG.stat.god === true);
    const backG = save.loadSlot('normal');
    check('10 读回来是普通局且进度还在',
      !!backG && backG.god === undefined && backG.godRuined === undefined
      && Math.abs(engine.equity(backG) - 123456) < 1e-6,
      backG ? `equity=${f(engine.equity(backG), 2)}` : 'null');
    /* 旧档兼容：手工回写一份带 god 的档（历史版本形态），读回来被剥掉且不弃档 */
    mem.set('degen_save_normal', JSON.stringify(
      { ...objG, god: { lastFill: 9, inf: true, sb: { ...god.SB_DEFAULT } }, godRuined: true }));
    const backL = save.loadSlot('normal');
    check('10 旧档带 god 也读得出且被剥掉（不弃档）',
      !!backL && backL.god === undefined && backL.godRuined === undefined, '');

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

/* ═══════════════ 12 · 称号三轴 ＋ 结局标签：覆盖矩阵 ＋ fuzz（无缺口） ═══════════════ */
section('12 · 称号三轴（主称号 / 风格称号 / 徽章）＋ 结局标签 —— 覆盖矩阵 ＋ 随机 fuzz（无缺口）');
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
     现在（2026-10-05 再扩）：破产档按**峰顶倍数**分 6 档 ＋ 欠钱 1 档 ＋ 弹尽粮绝 1 档，
     结算档按终值倍数分 13 档。这里把两条轴都穷举一遍，并单列「欠钱压过峰顶」这条优先级。 */
  /* ⚠️ 破产档拆成**两条正交的轴**：
     · `DEBT_TITLE`（欠钱）不是「冲到多高」的一档，是**比归零更糟**的独立结局（`final < 0`）；
     · `STARVED_TITLE`（弹尽粮绝，2026-10-05 新增）也不是峰顶档 —— 它是**最低那一档的余额口径**：
       峰顶 < 2x 且 `final > 0`（账户还剩一点、却连最小一单都开不出）。判据与
       `engine.ruinLabelOf` 同源（权益 ≤ 0 ⇒ 归零者，> 0 ⇒ 弹尽粮绝）。
     · `BUST_TITLES` 是**峰顶阶梯**，**下标越大 ＝ 曾经冲得越高**（`归零者` → `功亏一篑`）。
       破产档报的是**绝对高度**（2026-10-05 用户实测修）⇒ 阈值**不随时长归一**，
       所以 A3 ④ 的断言是「同一峰顶在 6 个局别判同一档」，而不是「短局升档」。 */
  const DEBT_TITLE = '负债累累';
  const STARVED_TITLE = '弹尽粮绝';
  const BUST_TITLES = ['归零者', '纸上富贵', '高台跳水', '黄粱一梦', '登月坠落', '功亏一篑'];
  const BUST_ALL = [DEBT_TITLE, STARVED_TITLE, ...BUST_TITLES];
  const LIVE_TITLES = ['陪跑的', '活下来的', '保本的', '小赚一笔', '翻倍的人', '小富即安',
    '钻石手', '滚雪球', '币圈锦鲤', '百倍战神', '千倍传奇', '万倍传奇', '亿倍传奇'];
  const TITLE_SET = new Set([...BUST_ALL, ...LIVE_TITLES]);
  check('12 主称号档位恰 21 枚（破产 8 ＝ 峰顶 6 ＋ 欠钱 1 ＋ 弹尽粮绝 1，结算 13）',
    TITLE_SET.size === 21, `${TITLE_SET.size}`);
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
  /* 弹尽粮绝档（2026-10-05 新增）：**账户还剩一点、却开不出最小一单** ——
     用户原话「爆仓和开不出单的称号肯定是不一样的」。判据与 `engine.ruinLabelOf` 同源：
     权益 ≤ 0 ⇒「归零者」（账户真清零），权益 > 0 ⇒「弹尽粮绝」。 */
  for (const reason of [OVER.LIQUIDATED, OVER.GAVEUP]) {
    for (const [final, peakMult, want] of [
      [8, 1, '弹尽粮绝'],        // 只剩 $8（< $10.02 门槛）、峰顶 1x ⇒ 不是「归零者」
      [0.01, 1.99, '弹尽粮绝'],  // 名义上还剩 1 分钱也算「还剩一点」
      [0, 1, '归零者'],          // 真归零 ⇒ 仍是「归零者」
      [-1e-9, 1, '负债累累'],    // 只要为负 ⇒ 欠钱档置顶
      [8, 2, '纸上富贵'],        // 峰顶 ≥ 2x ⇒ 峰顶阶梯优先（弹尽粮绝只管最低一档）
      [8, 5000, '功亏一篑'],     // 峰顶越高越优先，与余额无关
    ]) {
      const got = T.titleOf(rec({ reason, cash0: 1000, peak: peakMult * 1000, final }));
      check(`12 破产档（${reason}）终值 ${final} / 峰顶 ${peakMult}x ⇒ «${want}»`, got === want,
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
  /* 硬规矩：**破产局的称号一定落在破产 8 档里**（不许混进结算 13 档），反之亦然。
     ⚠️ 终值三种符号（负 / 零 / 正）都要过一遍 —— 「弹尽粮绝」正是 `final > 0` 那一支。 */
  {
    let crossed = 0;
    for (const reason of [OVER.LIQUIDATED, OVER.GAVEUP]) {
      for (const final of [-1, 0, 8]) {
        for (const pk of [0, 1, 5, 20, 100, 500, 5000]) {
          if (!BUST_ALL.includes(T.titleOf(rec({ reason, cash0: 1000, peak: pk * 1000, final })))) crossed++;
        }
      }
    }
    for (const f of [0.1, 0.5, 1, 2, 10, 50, 200, 1e5, 1e9]) {
      if (!LIVE_TITLES.includes(T.titleOf(rec({ reason: OVER.SETTLED, cash0: 1000, final: f * 1000 })))) crossed++;
    }
    check('12 结局轴互不串档（破产 8 档 ⇄ 结算 13 档）', crossed === 0, `串档 ${crossed} 次`);
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
    /* ⚠️ 阈值 2026-10-07 改口径（每一笔仓位最多 1 次）后整体除以 5：100/50/20 → 20/10/4。
       这里跟着往下调，否则「强平机器」会被上一档吃掉、变成不可达的死徽章。 */
    rec({ liq: 30 }),                                                     // 强平之王（≥20）
    rec({ liq: 15 }),                                                     // 九死一生（≥10 且活到结算）
    rec({ liq: 6 }),                                                      // 强平机器（≥4）
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
     17 档档位句逐一取到、恒非空；破产局**绝不说「活下来」**（与称号同一条硬规矩）；
     8 条补白各自能被一条画像触发；`short` 版恒为全句前缀（海报 2026-10-05 起改用**全版**，
     但 `short` 仍是「只取档位句」的合法出口，前缀关系必须继续成立）。 */
  {
    /* 破产 8 档（欠钱置顶 ＋ 峰顶 6 档 ＋ 弹尽粮绝）—— 代表画像，`final` 定欠钱 / 弹尽粮绝、`peak` 定阶梯。 */
    const EPI_BUST = [
      { final: -1, peak: 0 },              // 负债累累
      { final: 0, peak: 5000 * 1000 },     // 功亏一篑（≥1000x）
      { final: 0, peak: 500 * 1000 },      // 登月坠落（≥100x）
      { final: 0, peak: 50 * 1000 },       // 黄粱一梦（≥20x）
      { final: 0, peak: 10 * 1000 },       // 高台跳水（≥5x）
      { final: 0, peak: 3 * 1000 },        // 纸上富贵（≥2x）
      { final: 0, peak: 1 * 1000 },        // 归零者
      { final: 8, peak: 1 * 1000 },        // 弹尽粮绝（账户还剩一点，却开不出最小一单）
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
    check('12 结局评语：17 档全部取到且非空', empty === 0, `空 ${empty} 档`);
    check('12 结局评语：破产局绝不说「活下来」', lied === 0, `出现 ${lied} 次`);
    check('12 结局评语：17 档产出 ≥ 12 种不同句子（覆盖不同玩家）',
      new Set(texts).size >= 12, `${new Set(texts).size} 种`);

    /* ⚠️ 最低那一档的两句必须**各自精确可取**（2026-10-05 新增弹尽粮绝句）——
       旧版那句「从零开始，也回到了零」在「账户还剩 $8」的局里是假话，两句不能混用。 */
    const lineZero = T.epitaphOf(rec({ reason: OVER.LIQUIDATED, cash0: 1000, peak: 1000, final: 0 }));
    const lineLeft = T.epitaphOf(rec({ reason: OVER.LIQUIDATED, cash0: 1000, peak: 1000, final: 8 }));
    check('12 结局评语：真归零 ⇒ 说「回到了零」', lineZero.includes('回到了零'), lineZero);
    check('12 结局评语：还剩一点 ⇒ 不说「回到了零」，且点明「不是归零，是出局」',
      !lineLeft.includes('回到了零') && lineLeft.includes('不是归零')
      && !FORBID.some(w => lineLeft.includes(w)), lineLeft);
    check('12 结局评语：两支确实是两句不同的话', lineZero !== lineLeft,
      lineZero === lineLeft ? '两支撞成同一句' : '');

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

  /* ── A5 · 结局口径穷举 `overLabelOf`（2026-10-05 用户原话：「你要详细检查所有的结束游戏的口径，
     比如玩家开不出仓、玩家爆仓、玩家第一次爆仓收摊、玩家开不出仓收摊」）────────────────
     结局标签是**一条独立的正交轴**：`reason`（怎么结束的）× 终值符号（还剩多少）。
     ⚠️ 这里穷举的是**全部可达组合**（不是抽样）——`reason` 3 种 × 终值 3 符号 = 9 格，
        其中 `SETTLED` 的三种终值符号在引擎里不可达（活着到收盘 ⇔ 权益必为正），
        但**函数不许崩、不许留空**，所以照测。 */
  {
    const CASES = [
      [OVER.SETTLED, 5000, '结算'],
      [OVER.LIQUIDATED, 0, '爆仓'],
      [OVER.LIQUIDATED, -1, '爆仓'],
      [OVER.LIQUIDATED, 8, '无力开仓'],
      [OVER.GAVEUP, 0, '归零收摊'],
      [OVER.GAVEUP, -1, '归零收摊'],
      [OVER.GAVEUP, 8, '断粮收摊'],
    ];
    const seen = new Set();
    for (const [reason, final, want] of CASES) {
      const got = T.overLabelOf(rec({ reason, cash0: 1000, peak: 1000, final }));
      check(`12 A5 结局标签（${reason} / 终值 ${final}）⇒ «${want}»`, got === want,
        got === want ? '' : `实得 «${got}»`);
      seen.add(want);
    }
    check('12 A5 五种口径两两不同（结算 / 爆仓 / 无力开仓 / 归零收摊 / 断粮收摊）', seen.size === 5, `${seen.size} 种`);
    /* 字数硬上限 4：档案页头行 `nowrap`（不许换行）＋ 海报与局名同行右对齐。 */
    let tooLong = 0;
    for (const [reason, final] of CASES) {
      const s = T.overLabelOf(rec({ reason, cash0: 1000, peak: 1000, final }));
      if (!s || s.length > 4) tooLong++;
    }
    check('12 A5 标签字数 2–4 字、恒非空（版面固定不换行）', tooLong === 0, `越界 ${tooLong} 条`);
    /* `SETTLED` 的三种终值符号都要有落点（引擎不可达，但函数不许返回空）。 */
    check('12 A5 SETTLED 恒为「结算」（含负 / 零这类不可达输入）',
      [5000, 0, -1].every(f => T.overLabelOf(rec({ reason: OVER.SETTLED, cash0: 1000, final: f })) === '结算'));
    /* 与 `titleOf` 的**同源**：标签说「无力开仓 / 断粮收摊」的局，称号必是「弹尽粮绝」。 */
    let drift = 0;
    for (const reason of [OVER.LIQUIDATED, OVER.GAVEUP]) {
      for (const final of [0, 8]) {
        const r = rec({ reason, cash0: 1000, peak: 1000, final });
        const lab = T.overLabelOf(r), ti = T.titleOf(r);
        const starved = lab === '无力开仓' || lab === '断粮收摊';
        if (starved !== (ti === STARVED_TITLE)) drift++;
      }
    }
    check('12 A5 标签的余额口径与主称号同源（无力开仓/断粮收摊 ⇔ 弹尽粮绝）', drift === 0, `错位 ${drift} 处`);
    /* 单一出口：两处 UI 都不许再直接下标取底表（否则缺口会重新长出来）。 */
    const uiFiles = ['src/ui/render.js', 'src/ui/shareCard.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'));
    check('12 A5 两处 UI 都走 `overLabelOf`，且都不再引用 `OVER_LABEL`',
      uiFiles.every(t => /overLabelOf\(/.test(t)) && uiFiles.every(t => !/OVER_LABEL/.test(t)));
    /* 弹窗大字标题与档案标签**同一个词**：`renderOver` 的标题也走 `overLabelOf`。 */
    check('12 A5 结算弹窗大字标题也走 `overLabelOf`（同一份字）',
      /overLabelOf\(\{\s*reason,\s*final:\s*eq\s*\}\)/.test(uiFiles[0]));
    /* 标题已经是余额口径 ⇒ 正文**不许再复述一遍**（否则「无力开仓」那一支会
       标题与正文同一个词、同一张卡重复两行）。断言只看 `renderOver` 这**一个函数体**，
       不看整个文件（`renderLoan` 那张遮罩仍然该走 `ruinLabelOf`）。 */
    const overFn = (uiFiles[0].match(/export function renderOver[\s\S]*?\n}\n/) || [''])[0];
    check('12 A5 结算弹窗正文不复述余额口径（`renderOver` 函数体内不出现 `ruinLabelOf`）',
      overFn.length > 0 && !/ruinLabelOf/.test(overFn));
    /* 主动收摊：标题已是「归零收摊 / 断粮收摊」⇒ 正文不许再写一遍「收了摊」。 */
    check('12 A5 收摊弹窗正文不复述「收摊」（标题已含该词）',
      !/收了摊/.test(overFn) && /你主动结束了这一局/.test(overFn));
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
     `syncNpcDrift` 还会挪动显示价。本段只想量 `flushSlot` 的止盈带，故六档 ＋ 做市一起钉 0（npcFreeze）。 */
  const unfreeze = npcFreeze();
  try {
    engine.tickMarket(s, 'BTC');
    check('9m 盈利的多单被止盈（落标志 ＋ 名义减半）',
      g.longTp === true && Math.abs(g.long - L0 * 0.5) < L0 * 0.01,
      `long ${f(L0, 0)} → ${f(g.long, 0)}，longTp=${g.longTp}`);

    const L1 = g.long;
    engine.tickMarket(s, 'BTC');                 // 价格仍在带内 ⇒ 一次性，不再二次减半
    check('9m 止盈一次性（带内不再反复减半）', g.long >= L1 * 0.99,
      `第二次后 long ${f(g.long, 0)}（首减后 ${f(L1, 0)}）`);
  } finally { unfreeze(); }
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
  const unfreeze = npcFreeze();
  try {
    engine.advanceOneHour(s);
  } finally { unfreeze(); }
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
    god.NPC.downAsym = amp;
    const unfreeze = npcFreeze();                    // 冻结建仓 ⇒ 只有被摆弄的那一档会写冲击
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
    } finally { god.NPC.downAsym = old; unfreeze(); }
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

  /* ② 预设合法性：6 键齐全 · 倍率非负 · 四组 id / 名唯一 */
  let ok = true, why = '';
  for (const p of god.SB_PRESETS) {
    for (const k of god.SB_KEYS) {
      if (!Number.isFinite(p.sb[k])) { ok = false; why = `${p.id}.${k} 非有限`; }
      else if (k !== 'mood' && p.sb[k] < 0) { ok = false; why = `${p.id}.${k} < 0`; }
    }
  }
  const ids = new Set(god.SB_PRESETS.map(p => p.id));
  const names = new Set(god.SB_PRESETS.map(p => p.name));
  check('9p 预设 6 枚旋钮齐全且倍率非负', ok, why);
  check('9p 预设四组（默认 / 火箭牛市 / 深度熊市 / 高波动）且 id / 名唯一',
    god.SB_PRESETS.length === 4 && ids.size === 4 && names.size === 4,
    god.SB_PRESETS.map(p => p.name).join(' / '));

  /* ③ `shock` 旋钮对级联冲击**线性**放大（同一场景切倍率，唯一变量就是它） */
  const T = idx(at(2021, 5, 10));
  const shockOf = async (sbShock) => {
    const unfreeze = npcFreeze();                   // 冻结建仓 ⇒ 只有被摆弄的那一档会写冲击
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
    } finally { unfreeze(); }
  };
  const s1 = await shockOf(1), s2 = await shockOf(2), s0 = await shockOf(0);
  check('9p shock 旋钮线性放大级联冲击（×2 ⇒ 幅度 ×2）',
    s1 !== 0 && Math.abs(s2 / s1 - 2) < 1e-9, `×1 ${f(s1, 0)} ×2 ${f(s2, 0)} ⇒ 比 ${f(s2 / s1, 4)}`);
  check('9p shock = 0 ⇒ 级联冲击归零', s0 === 0, `×0 ${f(s0, 0)}`);

  /* ④ 恒等默认 ⇒ 与**不开沙盒**逐位一致（显式写一份 1 / 0 不该改变任何东西）
     ⚠️ 2026-10-08（M4b）把这局的**深度旋钮**钉到 `liqMul: 1`：`identOf(false)` 根本没有 `s.god`
     ⇒ `godLiqMulOf` 恒 1；而 `identOf(true)` 若缺 `liqMul`，`enableGod` / 读侧补的是 **`'auto'`**
     —— 那是 2026-10-08 引入的**有意行为**（价移比跟随，拉盘后自动放大深度并同源放大 OI / 散户簿 /
     基金池），一旦有位移就不再是恒等。本断言咬的是「**沙盒旋钮**（`sb`）显式写默认值不改变任何
     东西」，不是「深度旋钮恒等」⇒ 把深度旋钮钉成 1，让变量只剩 `sb`，断言仍然咬它该咬的。 */
  const identOf = async (withSb) => {
    const s = await mk({ sym: 'BTC', i: T, mode: 'fut' });
    if (withSb) s.god = { lastFill: 0, sb: { ...god.SB_DEFAULT }, liqMul: 1 };
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
  check('9q 面板按页渲染（`dataset.goftab` ＋ godCashPage / godManipPage 分段）',
    /dataset\.goftab/.test(renderSrc)
    && /function godCashPage\(/.test(renderSrc) && /function godManipPage\(/.test(renderSrc));
  check('9q `godBody` 收 `page` 入参（2026-10-10 浮窗化：原 openGod modal → 浮窗主体渲染器）',
    /export function godBody\(s, page, gx = \{\}\)/.test(renderSrc));
  check('9q 分派层有 `onGodTab`，且 `showGod` 开合 god 浮窗（2026-10-10 浮窗化）',
    /function onGodTab\(/.test(mainSrc)
    && /const showGod = \(\) => \{ godFloatOpen = true; godVer\+\+; focusFloat\('god'\); after\(\); \}/.test(mainSrc));
  /* ⚠️ **穷举护栏**（`chan` / `godinf` 两次实测踩坑的病根）：render.js 渲染出的**每一个**
     `data-*` 动作键都必须注册进 ACTION_KEYS —— 漏一条 = `findActionEl` 认不出 = 点了没反应，
     且引擎/分派侧全绿也测不出来（按钮根本到不了 dispatch）。
     豁免名单 `STATE_MARKS`：**CSS 状态标记**（写在元素上给选择器/变量用，不是点击目标）——
       `pf`  = `--pf` 变量的镜像（锁定币进度环，带值比较守卫）；
       `heat` = `.chart-heat[data-heat=…]` 的着色桶（greedy/panic/缺省三档）；
       `pages` = 浮窗页签骨架的键串（`fPanel` 上给 `updateFloat` 判断「页签要不要随模式重建」，
       不是点击目标 —— 页签点击走 `goftab`，2026-10-07 市场浮窗复用骨架时新增）。
       `lvnews` / `lvcd` / `lveta` / `lvpin` / `lvwash` = god 浮窗**盘中轻刷新**（`syncGodLive`）
       的定点查询标记（2026-10-10 code review：冷却倒计时 / 自动新闻 eta / 插针置灰是时间驱动，
       不能只靠「打开那一刻」的渲染；这些标记只给 `querySelector` 用，不是点击目标）。
     新增状态标记要在这里补一行并说明用途；新增**按钮**漏注册则此断言当场咬死。 */
  const STATE_MARKS = new Set(['pf', 'heat', 'pages', 'lvnews', 'lvcd', 'lveta', 'lvpin', 'lvwash']);
  /* 只抓 `export const ACTION_KEYS = [ ... ];` **数组本体** —— 不扫全文：全文抓会把
     注释里提到的旧键 / 别的字符串也当「已注册」，护栏假绿。
     ⚠️ 数组本体里还夹着大量**解释性注释**（含 `'toggle'` / 旧键名的字面量）—— 必须**先剥注释**
     再抽键，否则注释里提到的字符串会被当成「已注册」⇒ 漏注册也测不出来（本护栏假绿）。 */
  const arrRaw = (bindSrc.match(/export const ACTION_KEYS = \[([\s\S]*?)\];/) || ['', ''])[1];
  const arrBody = arrRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const actionKeys = new Set([...arrBody.matchAll(/'([a-z0-9]+)'/g)].map(m => m[1]));
  check('9q 护栏活性：ACTION_KEYS 数组本体解析成功（否则本节护栏空转）',
    actionKeys.size >= 30, `解析出 ${actionKeys.size} 键`);
  const renderedKeys = new Set([...renderSrc.matchAll(/dataset\.([a-z0-9]+)\s*=/g)].map(m => m[1]));
  /* ⚠️ 静态正则抓不到**动态键工厂** `dataset[key] = v`（`segRow` 音量/震动/动效、`pickBtn`
     公元/月）—— 把**调用点传入的字面键**也收进来，否则从这两个工厂新加的按钮会绕过护栏
     （历史上 `vol/vib/fx` 与 `godyear/godmon` 都从这里出，静态正则看不到它们）。 */
  for (const m of renderSrc.matchAll(/segRow\('[^']*',\s*'([a-z0-9]+)'/g)) renderedKeys.add(m[1]);
  for (const m of renderSrc.matchAll(/pickBtn\([^)]*?'([a-z0-9]+)'/g)) renderedKeys.add(m[1]);
  const unbound = [...renderedKeys].filter(k => !actionKeys.has(k) && !STATE_MARKS.has(k));
  check('9q render 渲染的每个 data-*（含动态键工厂）都注册进 ACTION_KEYS（漏 = 点了没反应）',
    unbound.length === 0, unbound.length ? `漏 ${unbound.join('/')}` : `${renderedKeys.size} 键全覆盖（豁免状态标记 ${[...STATE_MARKS].join('/')}）`);
  /* 反向穷举：注册了却**从未**渲染的键（死键）。只放行已知的 `settings`（顶栏那枚已随 A6 撤，
     设置页将来可能复用它做出口，见 `bind.js` 注释）；其余一律咬死 —— 防「删了按钮忘摘键」。
     ⚠️ 与上一条成对：两条一起才封死「渲染 ⇄ 注册」两个方向的脱节。 */
  const DEAD_KEYS = new Set(['settings']);
  const unrendered = [...actionKeys].filter(k => !renderedKeys.has(k) && !DEAD_KEYS.has(k));
  check('9q 反向：ACTION_KEYS 无「未渲染的死键」（豁免 settings）',
    unrendered.length === 0, unrendered.length ? `死键 ${unrendered.join('/')}` : '全部有渲染出处');
  /* 第三向：注册的键必须在 `main.dispatch` 里有 `d.<key>` 的**任一读法**（`!==` / `===` /
     `typeof` 都算 —— `careers` 就是 `d.careers === 'exit'` 那一路，旧正则只认 `!==` 会误报）。
     键只是**标记**，没人读它照样点了没反应（`findActionEl` 命中 → `onAction` 派发 → dispatch
     逐条认领，三环缺一即死）。豁免同上 `settings`。 */
  const dispatched = new Set([...mainSrc.matchAll(/\bd\.([a-z][a-zA-Z0-9]*)/g)].map(m => m[1]));
  const undispatch = [...actionKeys].filter(k => !dispatched.has(k) && !DEAD_KEYS.has(k));
  check('9q 分派：每个 ACTION_KEY 都在 main.dispatch 有 `d.<key>` 分支（豁免 settings）',
    undispatch.length === 0, undispatch.length ? `未分派 ${undispatch.join('/')}` : '全部有分派分支');
}

/* ═══════════════════ 9r · 上帝操盘台（2026-10-07 · 吃单 / 洗售 / 幌骗） ═══════════════════
   三枚动作全部复用既有市场物理（`pushFlow` / `addPlayerVol` / heat）—— 这里咬的是操盘台自己的不变量：
     ① 吃单：实际位移 == 预览公式（净池、远离硬夹时精确相等）；实际花费 == 预览花费；
     ② 洗售：零位移（放量不推价）＋ 双边费如实落账 ＋ 假量进量柱与热度；
     ③ 幌骗：只动热度（即时 ±NUDGE、零成交零费用），随后随 `HEAT.k2` 均值回复自然消散；
     ④ 闸门：非上帝档 / 挑战局 / 名义额下限 / 非法方向 / 资金不足 一律 ok:false。
   挑战局的入口闸在 main 层（连点直接吞，无 DOM 不跑）；core 层的闸就是「没有 `s.god`」—— 两层都要咬住。 */
section('9r · 上帝操盘台：吃单位移=预览 · 洗售零位移 · 幌骗热度 · 闸门');
{
  const T = idx(at(2021, 5, 10));
  const NU = 1e-9;
  const clean = (s) => {           // 清掉 mk 首次 tick 可能留下的 NPC 残渣 ⇒ 净池起点（factor 恒 1）
    s.mkt.BTC.npcShock = { at: [], v: [] };
    s.mkt.BTC.npcDrift = { at: [], v: [] };
    s.overhang.BTC = { at: [], v: [], scar: [] };
  };

  /* ① 吃单：$20M @ 2021-05 BTC ⇒ 位移约 1.5%（远离 ±20% 硬夹），净池 ⇒ 预览即实值 */
  const sP = await mk({ sym: 'BTC', i: T, mode: 'fut', cash: 1e9 });
  god.enableGod(sP);
  clean(sP);
  const pvP = engine.manipPreview(sP, 'BTC', 1, 2e7);
  const c0 = market.closeAt('BTC', sP.i);
  const eq0 = engine.equity(sP);
  const rP = engine.godManipPush(sP, 'BTC', 1, 2e7);
  check('9r 吃单 ok · 实际位移 == 预览（净池 · 远离硬夹）',
    rP.ok && Math.abs(market.closeAt('BTC', sP.i) / c0 - 1 - pvP.impact) < NU,
    `实际 ${f(market.closeAt('BTC', sP.i) / c0 - 1, 6)} 预览 ${f(pvP.impact, 6)}`);
  check('9r 吃单花费 == 预览（手续费＋冲击成本，两格通道扣款）',
    Math.abs(eq0 - engine.equity(sP) - pvP.cost) < NU && Math.abs(rP.cost - pvP.cost) < NU,
    `花费 ${f(rP.cost, 2)}`);
  check('9r 吃单喂了热度（玩家成交 → m.pv，与真实成交同一口径）',
    Math.abs(sP.mkt.BTC.pv - 2e7) < NU, `pv ${f(sP.mkt.BTC.pv, 0)}`);

  /* ② 洗售：同额对倒 ⇒ 位移恒 0，付双边手续费，假量进量柱＋热度 */
  const sW = await mk({ sym: 'BTC', i: T, mode: 'fut', cash: 1e9 });
  god.enableGod(sW);
  const cW = market.closeAt('BTC', sW.i);
  const fW = god.factorFor(sW, 'BTC', sW.i);
  const eqW = engine.equity(sW);
  const pvW0 = sW.mkt.BTC.pv;
  const rW = engine.godManipWash(sW, 'BTC', 2e7);
  check('9r 洗售 ok · 零位移（放量不推价）',
    rW.ok && god.factorFor(sW, 'BTC', sW.i) === fW && market.closeAt('BTC', sW.i) === cW,
    `因子 ${f(god.factorFor(sW, 'BTC', sW.i), 9)}`);
  check('9r 洗售双边费如实落账', Math.abs(eqW - engine.equity(sW) - rW.fee) < NU, `双边费 ${f(rW.fee, 2)}`);
  check('9r 洗售假量进量柱＋热度（与真实成交同一口径）',
    Math.abs((sW.pvol.BTC[sW.i][sW.ex].fut?.u ?? 0) - 2e7) < NU
    && Math.abs(sW.mkt.BTC.pv - pvW0 - 2e7) < NU, '');

  /* ③ 幌骗：热度瞬时 ±NUDGE、零费用；随后随 `HEAT.k2` 均值回复自然消散。
     ⚠️ 消散**不咬「回到基点」**—— 真实行情本身就在推热度（实测平静窗口一周也能漂 ±0.1），
        那不是幌骗的锅。咬**双胞胎对照**：同一时刻、同一种子、同一行情的两份状态，
        唯一差别是 spoof 那一脚 ⇒ 两份的热度差只被 k2 衰减，168h（≈12 倍记忆时长）后必须几乎归零。
     ⚠️ 冻结 NPC（`npcFreeze` ＋ 清空建仓梯队，9p③ 同款）：不冻结的话 NPC 顺着被抬的热度建仓
        会把「幌骗的影响」通过级联固化成真实价格路径，消散就无从谈起。 */
  const freezeNpc = (s) => {
    for (let k = 0; k < s.mkt.BTC.npc.length; k++) {
      const o = s.mkt.BTC.npc[k];
      o.long = 0; o.longAvg = 0; o.short = 0; o.shortAvg = 0;
      o.longStopped = false; o.shortStopped = false; o.longTp = false; o.shortTp = false;
    }
    if (s.mkt.BTC.mm) {
      const o = s.mkt.BTC.mm;
      o.long = 0; o.longAvg = 0; o.short = 0; o.shortAvg = 0;
      o.longStopped = false; o.shortStopped = false; o.longTp = false; o.shortTp = false;
    }
  };
  /* 两份都先在 NPC 活跃时建好（初始 tick 的随机流逐位一致），再一起冻结 ＋ 清残渣。 */
  const sA = await mk({ sym: 'BTC', i: T, mode: 'fut', cash: 1e9 });
  god.enableGod(sA);
  const sB = await mk({ sym: 'BTC', i: T, mode: 'fut', cash: 1e9 });
  god.enableGod(sB);
  const unfreeze = npcFreeze();
  try {
    clean(sA); freezeNpc(sA);
    clean(sB); freezeNpc(sB);
    sA.mkt.BTC.heat = god.HEAT.base;
    sB.mkt.BTC.heat = god.HEAT.base;
    const eqS = engine.equity(sA);
    const rS = engine.godManipSpoof(sA, 'BTC', 1);
    check('9r 幌骗拉情绪即时 +NUDGE（零成交零费用）',
      rS.ok && Math.abs(sA.mkt.BTC.heat - (god.HEAT.base + god.MANIP_SPOOF_NUDGE)) < NU
      && engine.equity(sA) === eqS,
      `heat ${f(sA.mkt.BTC.heat, 4)}`);
    for (let k = 0; k < 168; k++) { engine.advanceOneHour(sA); engine.advanceOneHour(sB); }
    check('9r 幌骗热度 168h 后消散（双胞胎差 < 2 个百分点）',
      Math.abs(sA.mkt.BTC.heat - sB.mkt.BTC.heat) < 0.02,
      `A ${f(sA.mkt.BTC.heat, 4)} B ${f(sB.mkt.BTC.heat, 4)} 差 ${f(Math.abs(sA.mkt.BTC.heat - sB.mkt.BTC.heat), 5)}`);
  } finally { unfreeze(); }

  /* ④ 闸门：五条全都要拦得住 */
  const sN = await mk({ sym: 'BTC', i: T, mode: 'fut' });          // 没开上帝
  check('9r 非上帝档 ⇒ 三动作全被闸',
    engine.godManipPush(sN, 'BTC', 1, 2e7).ok === false
    && engine.godManipWash(sN, 'BTC', 2e7).ok === false
    && engine.godManipSpoof(sN, 'BTC', 1).ok === false, '');
  const sC = createState('luna');                                  // 挑战局：core 层同样没有 god 可借
  check('9r 挑战局（无 god）⇒ ok:false', engine.godManipPush(sC, 'BTC', 1, 2e7).ok === false, '');
  const sLow = await mk({ sym: 'BTC', i: T, mode: 'fut', cash: 100 });
  god.enableGod(sLow);
  const fLow = god.factorFor(sLow, 'BTC', sLow.i);
  check('9r 名义额下限 · 非法方向 · 资金不足 ⇒ 全被闸且不写任何位移',
    engine.godManipPush(sLow, 'BTC', 1, 999).ok === false
    && engine.godManipPush(sLow, 'BTC', 0, 2e7).ok === false
    && engine.godManipPush(sLow, 'BTC', 1, 2e7).ok === false
    && god.factorFor(sLow, 'BTC', sLow.i) === fLow, '');

  /* ⑤ 封顶封底只属于普通局（2026-10-07 用户拍板「上帝模式去掉封顶封底」）：
     `shockFactorOf` 的 ±20%/−45% 夹子只在 `s.god` 为空时生效 —— 同一份手工位移，
     普通局被夹、上帝局原样放行；挑战局 `s.god` 恒空 ⇒ 与普通局同一条（无需单测）。 */
  const sCap = await mk({ sym: 'BTC', i: T, mode: 'fut', cash: 1e9 });
  clean(sCap);
  sCap.flow.BTC = [{ at: T, v: 0.5 }];            // 位移 +50%：普通局夹到 +20%
  check('9r 普通局封顶（+50% ⇒ 因子 1.2）· 上帝局不封顶（⇒ 1.5）',
    Math.abs(god.factorFor(sCap, 'BTC', T) - 1.2) < NU, `普通 factor=${f(god.factorFor(sCap, 'BTC', T), 6)}`);
  god.enableGod(sCap);
  check('9r 上帝局不封顶（同一位移 ⇒ 1.5）· playerFactor 同步放行',
    Math.abs(god.factorFor(sCap, 'BTC', T) - 1.5) < NU
    && Math.abs(god.playerFactor(sCap, 'BTC', T) - 1.5) < NU,
    `god factor=${f(god.factorFor(sCap, 'BTC', T), 6)} player=${f(god.playerFactor(sCap, 'BTC', T), 6)}`);
  sCap.flow.BTC = [{ at: T, v: -0.8 }];           // −80%：普通局本该夹到 −45%
  check('9r 上帝局不封底（−80% ⇒ 因子 0.2）',
    Math.abs(god.factorFor(sCap, 'BTC', T) - 0.2) < NU, `god factor=${f(god.factorFor(sCap, 'BTC', T), 6)}`);
  delete sCap.god;                                // 回到普通局对照封底
  check('9r 普通局封底（−80% ⇒ 因子 0.55）',
    Math.abs(god.factorFor(sCap, 'BTC', T) - 0.55) < NU, `普通 factor=${f(god.factorFor(sCap, 'BTC', T), 6)}`);

  /* ⑥ 无限资金贯通操盘台（2026-10-07 用户报「按钮无效」的根因修复）：
     `s.god.inf` 开着 ⇒ debit 失败先补满（`godFillCash`，补款额 = max(lastFill, 代价)）再扣。 */
  const sInf = await mk({ sym: 'BTC', i: T, mode: 'fut', cash: 100 });
  god.enableGod(sInf);
  sInf.god.inf = true;
  const pvI = engine.manipPreview(sInf, 'BTC', 1, 2e7);
  const rI = engine.godManipPush(sInf, 'BTC', 1, 2e7);
  check('9r 无限资金贯通吃单（$100 现金也拉得动 $20M，扣完 = 补款额 − 代价）',
    rI.ok && Math.abs(engine.equity(sInf) - (Math.max(sInf.god.lastFill, pvI.cost) - pvI.cost)) < NU,
    `补款 ${f(Math.max(sInf.god.lastFill, pvI.cost), 0)} 花费 ${f(pvI.cost, 0)} 余 ${f(engine.equity(sInf), 2)}`);
  const rIw = engine.godManipWash(sInf, 'BTC', 2e7);
  check('9r 无限资金贯通洗售（双边费同样先补后扣）', rIw.ok, `fee ${f(rIw.fee || 0, 0)}`);
  check('9r 面板记忆：lastPush / lastWash 记下上次执行的名义额（重开面板预填）',
    sInf.god.lastPush === 2e7 && sInf.god.lastWash === 2e7,
    `push=${sInf.god.lastPush} wash=${sInf.god.lastWash}`);
}

/* ═══════════════════ 9s · 上帝局重开保上帝（2026-10-07 · 上帝信箱） ═══════════════════
   「重开本局」走投信箱 ＋ reload（M1 统一路），而 `s.god` 不进存档 ⇒ 不补一枚**一次性信箱**
   的话，上帝局一重开就无声掉回普通局。这一节对 main.js 做**源码锚点**断言（Node 无 DOM）：
     · `doRestart` 上帝局先投信箱（设置页「重开本局」＋ 结束遮罩「重新开始」两枚入口共用）；
     · 开机消费信箱 ＋ `enableGod` 落在开局对象建立**之后**（源序）；
     · 挑战局封锁（与 `onGodLogo` 第一行同一条）；
     · 上帝重开**不走开场白**、开局补日志 ＋ 当场弹面板（与 `onGodLogo` 进局同款）。 */
section('9s · 上帝局重开保上帝（doRestart 投信箱 → 开机 bootGod 落位）');
{
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  check('9s `doRestart` 上帝局先投信箱（`if (s.god) stashGod()`）',
    /if \(s\.god\) stashGod\(\);/.test(mainSrc));
  check('9s 开机消费信箱 ＋ 挑战局封锁（bootGod = pendingGod && !isChallenge）',
    /const bootGod = !!pendingGod && !isChallenge\(s\.scen\);/.test(mainSrc));
  /* 源序：`enableGod` 必须作用在**开局那一份** `s` 上 —— 写在 createState / 读档之前就是空放。 */
  const iCreate = mainSrc.indexOf('createState(pendingScen || DEFAULT_SCENARIO)');
  const iEnable = mainSrc.indexOf('if (bootGod) enableGod(s);');
  check('9s `enableGod` 落在开局对象建立之后（源序）',
    iCreate >= 0 && iEnable > iCreate, `createState@${iCreate} enableGod@${iEnable}`);
  check('9s 上帝重开不走开场白（fromScenarioPick 分支认 bootGod，直接 beginGame）',
    /if \(bootGod \|\| isChallenge\(s\.scen\)\) beginGame\(\);/.test(mainSrc));
  const bg = mainSrc.match(/function beginGame\(\) \{[\s\S]*?\n\}/);
  check('9s beginGame 内补上帝日志 ＋ 当场弹面板（bootGod → showGod）',
    !!bg && /bootGod/.test(bg[0]) && /showGod\(\)/.test(bg[0]),
    bg ? 'beginGame 已接线' : 'beginGame 未找到');
}

/* ═══════════════════ 9t · 爆仓潮解闸 ＋ 深度饱和放宽（2026-10-07 用户拍板） ═══════════════════
   两件事：
     ① **级联门控拆除**：`stampede` 原来被 `cascadeMulOf(s) <= 0`（玩家当前停在实物 1x）整条
        闸死 ⇒ 没开过杠杆单的玩家永远看不到爆仓潮。拍板后级联是 NPC 杠杆盘自己的生态，
        与玩家 UI 形态解耦；`cascadeMulOf` 只剩逐笔热度加料一处用途。
     ② **深度饱和**（2014 年「几十亿只拉 3%」的三层天花板：q>0.25 单笔饱和 / 上限=σ / 压力位
        吸收）：上帝局玩家侧 cap 放宽到 1.0（单笔上限 σ→2σ）；NPC 侧三通道不放宽（红线 A）；
        预览在饱和时提示「深度不足 · 超出部分无效」。
   ⚠️ 纯函数断言走 `impact.js`（无吸收、无状态）——`absorbedImpact` 非线性，含它的
      `manipPreview` 位移只做**单调**对比，不咬精确倍数。 */
section('9t · 爆仓潮解闸（stampede 不再看玩家形态）＋ 上帝局深度 cap 1.0 ＋ 预览饱和提示');
{
  const impactSrc = fs.readFileSync(path.join(ROOT, 'src/core/impact.js'), 'utf8');
  const engineSrc = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
  const renderSrc = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');

  /* ① 源码锚点：stampede 函数体里不再有 cascadeMulOf */
  const st = engineSrc.match(/function stampede\(\w+, \w+, \w+, \w+\) \{[\s\S]*?\n\}/);
  check('9t `stampede` 不再被 cascadeMulOf 门控（级联与玩家形态解耦）',
    !!st && !/cascadeMulOf/.test(st[0]), st ? '已解闸' : 'stampede 未找到');
  /* 计数口径：定义 1 ＋ stampede 头注引用旧门控代码 1 ＋ 热度加料调用 1 ⇒ 3；再多 ⇒ 出现了新调用点 */
  check('9t `cascadeMulOf` 只剩热度加料一处调用（定义＋头注引用＋调用 = 3）',
    [...engineSrc.matchAll(/cascadeMulOf\(s\)/g)].length === 3,
    `实得 ${[...engineSrc.matchAll(/cascadeMulOf\(s\)/g)].length} 处`);

  /* ② 深度 cap：纯函数层 —— 缺省逐位回归 ＋ 上帝局恰好 2 倍（2σ·√1 vs 2σ·√0.25 = σ） */
  const SIG = 0.03, BIG = 10;                       // BIG ≫ 任何 cap ⇒ 恒饱和
  const sig = (q, cap) => impact.permImpactOf(q, SIG, cap);
  check('9t 缺省 cap 逐位回归（不传 = SLIP.cap，普通局零差异）',
    [0.05, 0.2, 0.25, 0.3, BIG].every(q => impact.permImpactOf(q, SIG) === impact.permImpactOf(q, SIG, impact.SLIP.cap))
    && [0.2, 0.5, BIG].every(q => impact.impactOf(q, SIG) === impact.impactOf(q, SIG, impact.SLIP.cap)));
  check('9t 上帝局饱和位移 = 2σ（普通 = σ）—— cap 1.0 vs 0.25',
    Math.abs(sig(BIG, god.MANIP_GOD_CAP) - 2 * SIG) < 1e-9
    && Math.abs(sig(BIG, impact.SLIP.cap) - SIG) < 1e-9
    && Math.abs(sig(BIG, god.MANIP_GOD_CAP) / sig(BIG, impact.SLIP.cap) - 2) < 1e-9,
    `god=${f(sig(BIG, god.MANIP_GOD_CAP), 4)} norm=${f(sig(BIG, impact.SLIP.cap), 4)}`);

  /* ③ 行为层：同一局数据，普通局预览位移 < 上帝局（含压力位吸收仍单调）；sat 标志两端正确 */
  const T14 = idx(at(2014, 5, 15));
  const sN = await mk({ sym: 'BTC', mode: 'fut', cash: 1e12, i: T14 });
  const sG = await mk({ sym: 'BTC', mode: 'fut', cash: 1e12, i: T14 });
  god.enableGod(sG);
  const pvN = engine.manipPreview(sN, 'BTC', 1, 1e12);
  const pvG = engine.manipPreview(sG, 'BTC', 1, 1e12);
  check('9t 2014 深度：上帝局预览位移 > 普通局（cap 放宽只动玩家侧）',
    pvG.impact > pvN.impact, `god=${f(pvG.impact, 4)} norm=${f(pvN.impact, 4)}`);
  check('9t 预览 sat 标志：大名义（q≫cap）= true',
    pvN.sat === true && pvG.sat === true, `q ≫ 0.25`);
  const pvSmall = engine.manipPreview(sN, 'BTC', 1, 1e4);
  check('9t 预览 sat 标志：小额（q≪cap）= false', pvSmall.sat === false, `impact=${f(pvSmall.impact, 5)}`);

  /* ④ 预览提示 + cap 缺省参数锚点 */
  check('9t 预览行带「深度不足 · 超出部分无效」提示（render）',
    renderSrc.includes('深度不足 · 超出部分无效'));
  check('9t impact.js 五个入口都带缺省 cap（不传逐位不变）',
    (impactSrc.match(/cap = SLIP\.cap/g) || []).length === 5,
    `实得 ${(impactSrc.match(/cap = SLIP\.cap/g) || []).length} 处（2026-10-07 走簿新增 baseLadder / walkBook 两入口，同守「不传 = SLIP.cap」口径）`);
}

/* ═══════════════════ 9u · 上帝浮窗：godWatchOf 只读快照 ＋ 接线锚点（2026-10-07 用户拍板） ═══════════════════
   三层：
     ① 数据层：`godWatchOf` 的强平价位与 `flushSlot` **同一个公式**（long = 均价×(1−drop)、
        short = 均价×(1+drop)，drop = 1/lev − GAME.maintRate，lev 过 npcLevOf 年代封顶）——
        audit 侧**独立复算**再对；深度阈值与 SLIP 常数逐位一致；池容量 = POOL.capK × 本时基准。
     ② 接线层：bind 五枚新键 ＋ 转发原始事件；main 的 alpha 键 / 每帧接线 / 拖拽处理。
     ③ 样式层：`--god-alpha` 双写兜底（先 var(--panel) 后 color-mix），浮窗类名齐全。 */
section('9u · 上帝浮窗（godWatchOf 快照）＋ 接线锚点');
{
  const TU = idx(at(2021, 5, 10));
  const sW = await mk({ sym: 'BTC', mode: 'fut', cash: 1e6, i: TU });
  /* 清空 mk 首次 tick 可能留下的 NPC 残渣（与 9r 的 clean 同一理由），再手摆第 3 档（10x）两侧，
     ⇒ 名义总数精确 = 1.5M，占比断言才咬得住 2/3。 */
  for (const g of sW.mkt.BTC.npc) {
    g.long = 0; g.short = 0; g.longAvg = 0; g.shortAvg = 0;
    g.longStopped = false; g.shortStopped = false; g.longTp = false; g.shortTp = false;
  }
  const mmW = sW.mkt.BTC.mm;
  mmW.long = 0; mmW.short = 0; mmW.longAvg = 0; mmW.shortAvg = 0;
  const g2 = sW.mkt.BTC.npc[2];
  g2.long = 1_000_000; g2.longAvg = 50000;
  g2.short = 500_000; g2.shortAvg = 52000;
  const w = engine.godWatchOf(sW, 'BTC');
  const lev2 = god.npcLevOf(engine.timeOf(sW), god.NPC.ladder[2].lev);
  const drop2 = 1 / lev2 - C.GAME.maintRate;
  const nm2 = `${god.NPC.ladder[2].lev}x`;
  const liqL = w.liqs.find(l => l.side === 'long' && l.name === nm2);
  const liqS = w.liqs.find(l => l.side === 'short' && l.name === nm2);
  check('9u 强平价位与 flushSlot 同式（long = 均价×(1−drop)）',
    !!liqL && Math.abs(liqL.price - 50000 * (1 - drop2)) < 1e-6,
    `lev=${f(lev2, 1)} drop=${f(drop2, 4)}`);
  check('9u 强平价位与 flushSlot 同式（short = 均价×(1+drop)）',
    !!liqS && Math.abs(liqS.price - 52000 * (1 + drop2)) < 1e-6);
  check('9u 条宽权重 = 名义占比（1M / 1.5M = 2/3）',
    !!liqL && Math.abs(liqL.w - 2 / 3) < 1e-9);
  check('9u tiers 恒七行（六档 ＋ 做市盘）＋ heat/fng 在场',
    w.tiers.length === 7 && w.tiers.some(t => t.name === '做市')
    && w.heat >= 0 && w.heat <= 1
    && Number.isFinite(w.fng) && w.fng >= 0 && w.fng <= 100);
  const liqDayW = market.liqOf('BTC', market.dayIndexOf(sW.i)) || 0;
  check('9u 深度阈值 = SLIP 常数 × 日流动性（死区 10% / 顶格 25%）',
    Math.abs(w.depth.dead - liqDayW * impact.SLIP.threshold) < 1e-6
    && Math.abs(w.depth.sat - liqDayW * impact.SLIP.cap) < 1e-6,
    `liqDay=${f(liqDayW, 0)}`);
  check('9u 深度池容量 = POOL.capK × 本小时基准深度',
    Math.abs(w.depth.poolCap - impact.POOL.capK * w.depth.hourBase) < 1e-6);

  /* ② 接线锚点（源码层） */
  const bindSrc = fs.readFileSync(path.join(ROOT, 'src/ui/bind.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const styleSrc = fs.readFileSync(path.join(ROOT, 'src/ui/style.css'), 'utf8');
  const renderSrc = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
  check('9u bind 注册浮窗五键 ＋ 转发原始事件',
    bindSrc.includes("'godfloat', 'godalpha', 'gofloat', 'goftab', 'gofclose'")
    && bindSrc.includes('onAction(el, ev)'));
  check('9u main：alpha 独立键 ＋ 档位循环 ＋ 每帧接线 ＋ 拖拽处理',
    mainSrc.includes("GOD_ALPHA_KEY = 'degen_god_alpha'")
    && mainSrc.includes('[1, 0.8, 0.6, 0.4]')
    && mainSrc.includes('updateFloat(s, floatUi())')
    && mainSrc.includes('onGodFloatChip(node, ev)'));
  check('9u render：圆钮/面板/热力图类名 ＋ 导出 updateFloat',
    renderSrc.includes("'god-chip'") && renderSrc.includes("'god-float'")
    && renderSrc.includes('god-hm-bar') && renderSrc.includes('export function updateFloat'));
  check('9u style：--god-alpha 双写兜底 ＋ 浮窗类名齐全',
    (styleSrc.match(/--god-alpha/g) || []).length >= 2
    && styleSrc.includes('.god-chip') && styleSrc.includes('.god-float')
    && styleSrc.includes('.god-hm-now'));
}

/* ═══════════════════ 9v · 走簿逐档撮合 ＋ 订单簿页（2026-10-07 拍板四件套） ═══════════════════
   用户原话：「把滑点改成真走簿逐档撮合 / 放浮窗第四页 / 压力位挂单墙并入订单簿 / 在簿上·深度页露出。
   做完后要确认无玩家情况下数据自洽，和历史史实一样」。四组断言对应四条验收线：
     ① 恒等：walkBook ≡ impactOf —— 不是第二把尺子，是同一把尺子的离散实现（档边界逐位相等，
        档内黎曼误差有界）—— 这一条就是「数据自洽」在代价侧的落实；
     ② 墙精确耦合：absorbOf 的 eaten 折减与「本次成交吃掉的墙」逐位对账（手算锚）；
     ③ 同源：浮窗订单簿与玩家下一笔会撞的簿来自同一套 σ / cap / liq / levels —— 看到的就是会撞的；
     ④ 零漂移：NPC 三通道不经过走簿（eaten 缺省 null ⇒ absorbOf 逐位不变），无玩家局史实不变。
   ⚠️ 阈值 1% 是 `impact.js` baseLadder 头注的拍板锚（cap = SLIP.cap 玩家主口径，实测 0.261%）；
      cap = 1.0（上帝宽梯）档内黎曼误差随 h 放大（实测 3.9%，落在 q 刚出死区处）—— 阶梯簿
      部分档按全档均价成交的现实语义，不是 bug，单独放宽到 5% 并在此注明，勿混同主口径。 */
section('9v · 走簿逐档撮合 ＋ 订单簿页（恒等 / 墙耦合 / 同源 / 零漂移）');
{
  /* ① 恒等网格：σ × cap × q 全扫（含超顶格与 hard 钳制区） */
  {
    let n1 = 0, worst25 = 0, worst10 = 0;
    for (const sigma of [0.01, 0.05, 0.1, 0.15, 0.2, 0.3]) {
      for (const cap of [impact.SLIP.cap, 1.0]) {
        for (let q = impact.SLIP.threshold * 1.001; q <= cap * 1.4; q *= 1.37) {
          const ref = impact.impactOf(q, sigma, cap);
          if (!(ref > 0)) continue;                    // 死区两侧同记零，无可比偏差
          const e = Math.abs(impact.walkBook({ sigma, cap, q }).impact - ref) / ref;
          if (cap === impact.SLIP.cap) worst25 = Math.max(worst25, e);
          else worst10 = Math.max(worst10, e);
          n1++;
        }
      }
    }
    check('9v① 走簿 ≡ 连续式（cap=0.25 主口径，≤1%）',
      worst25 <= 0.01, `网格 ${n1} 点 · 最大 ${(worst25 * 100).toFixed(3)}%`);
    check('9v① 走簿 ≡ 连续式（cap=1.0 上帝宽梯，≤5% 离散取舍）',
      worst10 <= 0.05, `最大 ${(worst10 * 100).toFixed(3)}%`);
  }

  /* ①b 引擎侧多年对照：真实 σ / 真实流动性 / 真实 cap（普通局 ⇒ cap = SLIP.cap） */
  for (const [yy, big] of [[2013, 5e5], [2017, 5e6], [2021, 5e7], [2024, 5e8]]) {
    const sA = await mk({ sym: 'BTC', mode: 'fut', cash: 1e7, i: idx(at(yy, 5, 10)) });
    let ok = true, det = '', hit = 0;
    for (const notional of [big, big * 20]) {
      const wfA = engine.walkFillFor(sA, 'BTC', sA.i, notional, 1, engine.lastPrice(sA, 'BTC'));
      const refA = impact.impactOf(wfA.q, wfA.sigma, wfA.cap);
      if (!(refA > 0)) continue;
      const e = Math.abs(wfA.cost - refA) / refA;
      if (e > 0.01) ok = false;
      det += ` q=${f(wfA.q, 3)} err=${(e * 100).toFixed(2)}%`;
      hit++;
    }
    check(`9v①b ${yy} 引擎侧走簿 ≡ impactOf（≤1%）`,
      ok, det + (hit === 0 ? '（全死区，两侧同记零）' : ''));
  }

  /* ② 墙精确耦合手算（纯函数，不碰引擎）—— 期望值独立于实现 */
  const lv2w = [{ p: 100, w: 0.5 }, { p: 103, w: 1 }, { p: 110, w: 0.8 }];
  const noEat = levels.absorbOf(lv2w, 100, 1, 0.05);                                    // 撞 p=103 → 1−0.55
  const fullEat = levels.absorbOf(lv2w, 100, 1, 0.05, [{ p: 103, w: 1, frac: 1 }]);     // 吃光 → 不吸收
  const halfEat = levels.absorbOf(lv2w, 100, 1, 0.05, [{ p: 103, w: 1, frac: 0.5 }]);   // 吃半 → 1−0.55×0.5
  const outEat = levels.absorbOf(lv2w, 100, 1, 0.02, [{ p: 110, w: 1, frac: 1 }]);      // 墙在位移范围外
  check('9v② 墙吸收手算：不折减 = 0.45', Math.abs(noEat - 0.45) < 1e-12, f(noEat, 4));
  check('9v② 墙吸收手算：全吃 → 1', fullEat === 1);
  check('9v② 墙吸收手算：吃半 = 0.725', Math.abs(halfEat - 0.725) < 1e-12, f(halfEat, 4));
  check('9v② 墙吸收手算：墙在位移范围外 → 不折减（=1）', outEat === 1);

  /* ③ 同源：浮窗订单簿 = **NPC 限价簿**（2026-10-08 三批拍板⑦「行为级离散簿」）——
     每行就是一笔真实挂单（同价已合并）；墙照插格间。基础档与 baseLadder 的逐位锚
     已随离散簿改版退役（回落路径的 18 档逐位锚移到 9af⑤ 的旋钮归零用例）。 */
  {
    const sB = await mk({ sym: 'BTC', mode: 'fut', cash: 1e7, i: idx(at(2021, 5, 10)) });
    for (let k = 0; k < 48; k++) engine.advanceOneHour(sB);   // 演化 48h：冷启动簿偏薄（老单已按寿命退场），活簿才是常态形态
    const bk = engine.godWatchOf(sB, 'BTC').book;
    check('9v③ 上帝视角带订单簿（离散簿：lob 标志 ＋ 中价 / σ / cap / liq ＋ 两侧 ≥18 行）',
      !!bk && bk.lob === true && bk.mid > 0 && bk.sigma > 0 && bk.cap > 0 && bk.liq > 0
      && bk.asks.length >= 18 && bk.bids.length >= 18);
    if (bk) {
      check('9v③ 离散簿契约：行价严格分居中价两侧 ＆ 同侧升/降序唯一 ＆ 名义为正',
        bk.asks.every((r, k) => r.price > bk.mid && r.notional > 0
          && (k === 0 || r.price > bk.asks[k - 1].price))
        && bk.bids.every((r, k) => r.price < bk.mid && r.notional > 0
          && (k === 0 || r.price < bk.bids[k - 1].price)));
      const lvB = levels.levelsOf('BTC', sB.i).filter(L => L.w > 0);
      const wallAsks = bk.asks.filter(r => r.wall);
      const wallBids = bk.bids.filter(r => r.wall);
      const askWalls = lvB.filter(L => L.p > bk.mid);
      const bidWalls = lvB.filter(L => L.p < bk.mid);
      check('9v③ 墙行逐条对账（价严格同源 ＋ 名义 = w × WALL_K × liq）',
        wallAsks.length === askWalls.length && wallBids.length === bidWalls.length
        && askWalls.every(L => {
          const r = wallAsks.find(x => x.price === L.p);
          return !!r && Math.abs(r.notional - L.w * levels.WALL_K * bk.liq) < 1e-6;
        })
        && bidWalls.every(L => {
          const r = wallBids.find(x => x.price === L.p);
          return !!r && Math.abs(r.notional - L.w * levels.WALL_K * bk.liq) < 1e-6;
        }),
        `墙 asks ${wallAsks.length} / bids ${wallBids.length}`);
      const wfB = engine.walkFillFor(sB, 'BTC', sB.i, bk.liq * 0.2, 1, bk.mid);
      check('9v③ walkFillFor 与簿同源（σ / cap / q 逐位 ＋ cost = walkBook 同参）',
        wfB.sigma === bk.sigma && wfB.cap === bk.cap
        && Math.abs(wfB.q - 0.2) < 1e-12
        && wfB.cost === impact.walkBook({ sigma: wfB.sigma, cap: wfB.cap, q: wfB.q }).impact);
      check('9v③ eaten 只含方向价距 ≤ reach 的真实墙（frac=1）',
        wfB.eaten.every(E => E.frac === 1
          && lvB.some(L => L.p === E.p && L.w === E.w)
          && Math.abs(E.p / bk.mid - 1) <= wfB.reach + 1e-12),
        `eaten ${wfB.eaten.length} 条`);
    }
  }

  /* ④ 零漂移（源码层）：NPC 三通道不经过走簿 —— 无玩家局逐位史实的结构性保证 */
  const engSrc = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
  const impSrc = fs.readFileSync(path.join(ROOT, 'src/core/impact.js'), 'utf8');
  const levSrc = fs.readFileSync(path.join(ROOT, 'src/core/levels.js'), 'utf8');
  check('9v④ 旧 bookFills 已退役（engine / impact 无残留）',
    !engSrc.includes('bookFills') && !impSrc.includes('bookFills'));
  check('9v④ walkFillFor 恰三处（定义 ＋ 开仓 ＋ 平仓；NPC 三通道不经它）',
    (engSrc.match(/walkFillFor\(/g) || []).length === 3);
  check('9v④ pushFlow 第 8 参 eaten 缺省 null（NPC 通道零漂移的载体）',
    engSrc.includes('player = true, eaten = null'));
  check('9v④ 成交路径恰两处透传 walk.eaten（开仓 ＋ 平仓）',
    (engSrc.match(/walk\.eaten\)/g) || []).length === 2);
  check('9v④ absorbedImpact 全量透传 eaten 到 absorbOf',
    engSrc.includes('absorbOf(levelsOf(sym, s.i), p, dir, impact, eaten)'));
  check('9v④ absorbOf 第 5 参缺省 null ＋ WALL_K 导出 ＋ levelsOf 单槽缓存',
    levSrc.includes('export function absorbOf(levels, p, dir, impact, eaten = null)')
    && levSrc.includes('export const WALL_K = 0.05')
    && levSrc.includes('let lcSym') && levSrc.includes('lcSym = sym'));

  /* ⑤ 浮窗接线锚：第 4 页订单簿 ＋ 普通 / 挑战局市场浮窗 */
  const bindSrc9v = fs.readFileSync(path.join(ROOT, 'src/ui/bind.js'), 'utf8');
  const mainSrc9v = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const rendSrc9v = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
  const styleSrc9v = fs.readFileSync(path.join(ROOT, 'src/ui/style.css'), 'utf8');
  check('9v⑤ bind 注册 mktfloat 键', bindSrc9v.includes("'mktfloat'"));
  check('9v⑤ main：市场浮窗开关（localStorage 持久化 ＋ 页表随模式）',
    mainSrc9v.includes("MKT_FLOAT_KEY = 'degen_mkt_float'")
    && mainSrc9v.includes('MKT_FLOAT_PAGES') && mainSrc9v.includes('on: !menuUp && (s.god ? godFloatOn : mktFloatOn)'));
  check('9v⑤ render：订单簿页 coinglass 三列（价格/数量/金额累计 ＋ 量条∝数量）＋ 设置页开关 ＋ 深度页墙汇总',
    rendSrc9v.includes('gb-row') && rendSrc9v.includes('gb-mid') && rendSrc9v.includes('gb-head')
    && rendSrc9v.includes('r.notional / r.price') && rendSrc9v.includes('fmtQty(r.qty)')
    && rendSrc9v.includes('fmtMoneyShort(r.cum)') && rendSrc9v.includes('qty: r.notional / r.price, cum')
    && rendSrc9v.includes('mktFloatBtn') && rendSrc9v.includes('压力位墙'));
  check('9v⑤ style：订单簿行样式（9px 固定口径 ＋ 墙金色）＋ 三列表头 ＋ 红卖绿买（真实盘口配色）',
    styleSrc9v.includes('.gb-row') && styleSrc9v.includes('.gb-mid')
    && styleSrc9v.includes('.gb-row.wall') && styleSrc9v.includes('.gb-head')
    && /\.gb-ask b \{ color: var\(--down\)/.test(styleSrc9v)
    && /\.gb-bid b \{ color: var\(--up\)/.test(styleSrc9v));
  /* ── ⑥ 订单簿网格化（2026-10-08 用户拍板「步进网格 ＋ 视野收窄 ±2~3%」；三批修订）──
     纯显示层改版：`niceStepOf`（已上收进 engine，四批离散簿共用）取 1-2-5×10ⁿ 步进、
     簿行直接读 NPC 限价簿、墙不吸附网格。
     三批（2026-10-08）：`gb-far` 汇总行删除（远场一直有单，靠步进 ×5/×8 翻看）＋
     行数自适应装框（手机 / 桌面订单簿页都不滚动）＋ 买卖比改读真实簿量。
     承重结构 `baseLadder` / `walkBook` 不动（9v①~④ 照旧）。 */
  check('9v⑥ render：订单簿网格化（niceStepOf 步进 ＋ 按 step 分桶装框 ＋ gb-far 退役；旧逐档切窗 baseAsks/cut 退役）',
    rendSrc9v.includes('const step = niceStepOf(b.mid)') && !rendSrc9v.includes("'gb-far'")
    && rendSrc9v.includes('const fitRows =') && rendSrc9v.includes('const bucketOf =')
    && rendSrc9v.includes('const midK = Math.floor(b.mid / step')
    && rendSrc9v.includes('const tot = aUsd + bUsd')
    && !rendSrc9v.includes('baseAsks') && !rendSrc9v.includes('const cut = rows'));
  /* 行为锚不取副本：正则把 engine.js 里的 `niceStepOf` **原样提取**成真函数再执行 ——
     被测对象就是 shipped 源码，副本漂移无从谈起。（四批：函数上收进 engine 供簿/图共用。） */
  check('9v⑥ niceStepOf 行为锚（源码提取执行）：108k→200 · 3.9k→10 · 2.3→0.005 · 0.16→0.0002',
    (() => {
      const body = engSrc.match(/export function niceStepOf\(p\) \{([\s\S]*?)\n\}/)[1];
      const niceStepOf = new Function('p', body);
      const near = (a, z) => Math.abs(a - z) <= Math.abs(z) * 1e-12;
      return near(niceStepOf(108000), 200) && near(niceStepOf(3900), 10)
        && near(niceStepOf(2.3), 0.005) && near(niceStepOf(0.16), 0.0002);
    })());
  check('9v⑥ style：gb-far 退役 ＋ 1280px 档随订单簿行同步放大（11px/15px ＋ 三列 78/52/68）',
    !styleSrc9v.includes('.gb-far')
    && styleSrc9v.includes('.gb-row, .gb-head { font-size: 11px; line-height: 15px; }')
    && styleSrc9v.includes('flex: 0 0 78px'));
}

/* ═══════════════════ 9w · NPC 双侧基底 ＋ 档名生效杠杆 ＋ 50x 预算 ═══════════════════
   本批收口（2026-10-07 用户七问；2026-10-08 修订）：
     ② NPC 双侧基底（`NPC.base`）：净敞口恒等（代数镜像 ＋ 源码锚）· 全币两侧常在 · OI 地板 ——
        「无玩家自洽」的仓位面收口；
     ③ `godWatchOf` 档名带**生效杠杆**（2016-05-13 前封顶 ⇒「100x→3x」，名实同尺）；
     ④ 50x 速度的单「游戏秒」成本预算：50 × advanceOneHour ＋ 60 × godWatchOf 计时；
     ⑤ 浮窗页表锚（上帝 4 页 / 普通 2 页）—— ⚠️ 旧页 4「逐笔成交」连同 `tape.js` 已退役
        （2026-10-08 用户拍板：明细行数随本小时进度漂移、拖动浮窗时列表乱跳），
        这里改成**负向锚**：tape / gd 行 / 页 4 不许再回来。 */
section('9w · NPC 双侧基底 ＋ 档名生效杠杆 ＋ 50x 性能预算');
{
  /* ── ② NPC 双侧基底 ──
     恒等式（代数镜像）：long 靶 = B + t⁺、short 靶 = B + t⁻（t = t⁺ − t⁻）⇒
     净敞口递推 netₙ₊₁ = netₙ + (t − netₙ)·speed，与无基底**逐位同轨** —— 基底只抬 OI 地板。 */
  {
    /* npcBuild 现读**档位速度** `NPC.ladder[k].sp`（2026-10-08 sp 改版）⇒ 恒等式要对**每一个
       档位速度**都成立（两侧同速 ⇒ `lonB − shoB == net0`，与速度取值无关）。 */
    const B = 1000, t = 2500;
    let worst = 0;
    for (const speed of god.NPC.ladder.map(r => r.sp)) {
      let lonB = 0, shoB = 0, net0 = 0;
      for (let n = 0; n < 40; n++) {
        lonB += (B + Math.max(0, t) - lonB) * speed;
        shoB += (B + Math.max(0, -t) - shoB) * speed;
        net0 += (t - net0) * speed;
      }
      worst = Math.max(worst, Math.abs(lonB - shoB - net0));
    }
    check('9w② 基底净敞口恒等：有基底 long−short == 无基底 net（40 步同轨 × 六档 sp）',
      worst < 1e-6, `最大差 ${f(worst, 12)}`);
  }
  const engSrc9w = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
  check('9w② npcBuild 靶心构造：基底叠在 max(0,·) 之外 ＋ 动量/基底走档位速度 sp ＋ 护盘/外部流当根入仓（恒等式前提）',
    engSrc9w.includes("stepNpc(m.npc[k], 'long', b + Math.max(0, target * w), price, floor, NPC.ladder[k].sp, s, sym)")
    && engSrc9w.includes("stepNpc(m.npc[k], 'short', b + Math.max(0, -target * w), price, floor, NPC.ladder[k].sp, s, sym)")
    && engSrc9w.includes('const b = low ? liqDay * NPC.base * w : 0')
    && engSrc9w.includes('const buy = (dipBuy + Math.max(0, extFlow)) * w;'));

  /* ②′ 全币两侧常在（「怎么会无 NPC 持仓」的行为面）：72 小时烧入后逐币断言。
     地板 = 2 × base × Σw(生效≤10x) × 日流动性（×0.5 = 收敛 / 止损摩擦余量）。
     ⚠️ 做市盘**不**断言「至多一侧」：镜像靶心随趋势净仓翻号，旧侧残仓要按速度线性衰减
     几小时才清零 —— 翻转后的暂态双侧是收敛动力学的固有现象，不是缺陷。 */
  const SYMS9w = ['BTC', 'ETH', 'XRP', 'DOGE', 'SOL'];
  for (const sy of SYMS9w) await market.loadCoin(sy);
  const sB = await mk({ sym: 'BTC', cash: 1e6, i: idx(at(2019, 6, 1)) });
  for (let n = 0; n < 72; n++) engine.advanceOneHour(sB);
  const wLow = god.NPC.ladder.reduce((a, r) =>
    a + (god.npcLevOf(engine.timeOf(sB), r.lev) <= 10 ? r.w : 0), 0);
  let sideFail = '', oiFail = '', floorN = 0;
  for (const sy of SYMS9w) {
    const liqDay = market.liqOf(sy, market.dayIndexOf(sB.i)) || 0;
    const m = sB.mkt[sy];
    if (!(liqDay > 0) || !m) continue;                    // 流动性未覆盖 ⇒ npcBuild 合法早退
    let lo = 0, sh = 0, tot = 0;
    for (const g of m.npc) { lo += g.long || 0; sh += g.short || 0; tot += (g.long || 0) + (g.short || 0); }
    if (!(lo > 0) || !(sh > 0)) sideFail += `${sy}:两侧 `;
    if (m.mm && ((m.mm.long || 0) < 0 || (m.mm.short || 0) < 0)) sideFail += `${sy}:做市负仓 `;
    floorN++;
    const floor = 2 * god.NPC.base * wLow * liqDay * 0.5;
    if (tot < floor) oiFail += `${sy}(${f(tot, 0)}<${f(floor, 0)}) `;
  }
  check('9w②′ 全币低杠杆档两侧常在（72h 烧入 · 无玩家）',
    floorN > 0 && sideFail === '', sideFail || `${floorN} 币全过`);
  check('9w②′ 全币 NPC OI ≥ 基底地板（2 × 0.12 × Σw低 × 日流动性 × 0.5）',
    floorN > 0 && oiFail === '', oiFail || `${floorN} 币达标`);

  /* ── ③ 档名带生效杠杆（「3 倍和 100 倍强平价一样」的口径修复） ── */
  const sN = await mk({ sym: 'BTC', cash: 1e6, i: idx(at(2014, 6, 1)) });
  const wN = engine.godWatchOf(sN, 'BTC');
  const capRow = wN.tiers.find(t => t.name === '100x→3x');
  check('9w③ 年代封顶档名：2014 年 100x 行显示「100x→3x」（lev = 生效 3）',
    !!capRow && capRow.lev === 3);
  check('9w③ 封顶年没有裸「100x / 50x / 20x」行（旧名 = 名实不符根源）',
    !wN.tiers.some(t => t.name === '100x' || t.name === '50x' || t.name === '20x'));
  check('9w③ 封顶行强平价按**生效杠杆**算（drop = 1/3 − MMR；同价聚合 ⇒ 档名 join，用 includes）',
    capRow && capRow.long > 0 && capRow.longAvg > 0
      ? wN.liqs.some(l => l.name.includes('100x→3x') && l.side === 'long'
        && Math.abs(l.price - capRow.longAvg * (1 - (1 / 3 - C.GAME.maintRate))) < 1e-6)
      : true,
    `long=${f(capRow ? capRow.long : 0, 0)}`);
  const sU = await mk({ sym: 'BTC', cash: 1e6, i: idx(at(2021, 5, 10)) });
  const wU = engine.godWatchOf(sU, 'BTC');
  check('9w③ 未封顶年代档名全裸（含 100x，无「→」）',
    wU.tiers.some(t => t.name === '100x') && !wU.tiers.some(t => t.name.includes('→')));

  /* ── ④ 50x 速度的单「游戏秒」预算：50 × advanceOneHour ＋ 60 × godWatchOf（每帧浮窗快照）
         必须远低于 1s 墙钟 —— 实测打印；阈值 400ms 已留 4× 余量（手机 ≈ 慢 3–5×）。 ── */
  {
    const sP = await mk({ sym: 'BTC', cash: 1e6, i: idx(at(2021, 5, 10)) });
    for (let n = 0; n < 5; n++) engine.advanceOneHour(sP);          // 预热（惰性加载 / 播种）
    const t0 = process.hrtime.bigint();
    for (let n = 0; n < 50; n++) engine.advanceOneHour(sP);
    for (let n = 0; n < 60; n++) engine.godWatchOf(sP, 'BTC');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    check('9w④ 50x 单游戏秒预算（50 小时步 ＋ 60 帧快照）< 400ms',
      ms < 400, `实测 ${f(ms, 1)} ms`);
  }

  /* ── ⑤ 浮窗页表锚（成交页退役 · 负向锚）──
     旧页 4「逐笔成交」连同 `tape.js` 已删除（2026-10-08 用户拍板）。负向锚防止它被无意加回来；
     `floatPage` 的夹取纪律（不在页表内 ⇒ 回页 0）在 main.js `floatUi()` 里，行为面由 9v⑤ 侧面覆盖。 */
  const mainSrc9w = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const rendSrc9w = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
  const styleSrc9w = fs.readFileSync(path.join(ROOT, 'src/ui/style.css'), 'utf8');
  check('9w⑤ main：浮窗页表 5 页 / 3 页（成交页已退役；页 4 = 日志 tape）＋ prog 接线已摘',
    mainSrc9w.includes("[[0, '热力'], [1, '巨鲸'], [2, '深度'], [3, '订单'], [4, '日志']]")
    && mainSrc9w.includes("[[3, '订单'], [2, '深度'], [4, '日志']]")
    && !mainSrc9w.includes("'成交'") && !mainSrc9w.includes('prog:'));
  check('9w⑤ render/style：tape ＋ gd 行结构全链路退役（不许再回来）＋ 圆钮「详」仍在',
    !fs.existsSync(path.join(ROOT, 'src/core/tape.js'))
    && !rendSrc9w.includes('tape24h') && !rendSrc9w.includes('gd-row') && !rendSrc9w.includes('prog')
    && rendSrc9w.includes("'详'")
    && !styleSrc9w.includes('.gd-row') && !styleSrc9w.includes('.gd-buy') && !styleSrc9w.includes('.gd-sell'));
  check('9w⑤ style：浮窗尺寸走 :root 变量（兜底值即手机端 340px×64dvh / 热力图 240px）',
    /\.god-float \{[^}]*width: var\(--float-w, 340px\)/.test(styleSrc9w)
    && /\.god-float \{[^}]*height: var\(--float-h, 64dvh\)/.test(styleSrc9w)
    && /\.god-hm \{[^}]*height: var\(--hm-h, 240px\)/.test(styleSrc9w));
  /* 9w⑥（2026-10-08 桌面端适配；三批「压缩上下高度」两轮后定档 60/64dvh）：浮窗按视口宽度
     分两档（手机端兜底值不变），`render.js` 的拖拽夹取、热力图级联与订单簿装框读**同一份**
     CSS 变量 ⇒ 几处不会各说各话。 */
  check('9w⑥ 桌面端浮窗分档（1280px / 1680px）＋ 超宽容器 1520px ＋ render.js 读同一份变量',
    styleSrc9w.includes('--float-w: 420px; --float-h: 60dvh; --hm-h: 280px')
    && styleSrc9w.includes('--float-w: 480px; --float-h: 64dvh; --hm-h: 330px')
    && styleSrc9w.includes('@media (min-width: 1280px)') && styleSrc9w.includes('@media (min-width: 1680px)')
    && styleSrc9w.includes('#app { max-width: 1520px; }')
    && rendSrc9w.includes("px('--float-w', 340)") && rendSrc9w.includes("px('--float-h', ch * 0.64)")
    && rendSrc9w.includes("px('--hm-h', 240)") && rendSrc9w.includes('cw - geo.w - 8')
    && rendSrc9w.includes('const HM_H = floatGeo().hm'));
  /* 9w⑥-bis（2026-10-08 用户两轮反馈「桌面端有些文字、数字太小」）：浮窗字号桌面档整体上调
     两档（密读数 12px / 热力图条 10.5px / 订单簿 11px/15px ＋ 列宽 78/52/68）—— 只在
     ≥1280px 媒体块内，手机端「尽量小」拍板逐位不动。热力图条**行高 12px 不动**
     （级联 GAP 的锚，9x④ 单锚）。 */
  check('9w⑥-bis 浮窗字号桌面档上调（12 / 10.5 / 11px ＋ gb 列宽 78/52/68）＋ 手机端不动',
    styleSrc9w.includes('.god-ftab, .god-fx, .god-frow2, .god-fnote { font-size: 12px; }')
    && styleSrc9w.includes('.god-hm-bar { font-size: 10.5px; }')
    && styleSrc9w.includes('.god-hm-now { font-size: 11px; }')
    && styleSrc9w.includes('.gb-row, .gb-head { font-size: 11px; line-height: 15px; }')
    && styleSrc9w.includes('.gb-row i, .gb-head i { flex: 0 0 78px; }')
    && !styleSrc9w.includes('.gb-far')
    && /\.god-hm-bar \{[^}]*font-size: 8\.5px/.test(styleSrc9w)
    && /\.gb-row \{[^}]*font-size: 9px/.test(styleSrc9w));
  {
    /* `floatGeo` 里 px() 的行为复刻：px 直取、vh/dvh 按视口比换算、空值/垃圾值走兜底。
       （改档只写 CSS 变量，若解析写错就会静默退回手机端尺寸 ⇒ 这条把它钉住。） */
    const ch = 800;
    const px = (v, dflt) => {
      const n = parseFloat(v);
      if (!v || !Number.isFinite(n)) return dflt;
      return /v[hd]$/.test(v) ? (n / 100) * ch : n;
    };
    check('9w⑥ 浮窗变量解析：420px→420 ／ 78dvh→624 ／ 空值与垃圾值→兜底',
      px('420px', 340) === 420 && px('78dvh', 0) === 624
      && px('', 340) === 340 && px('abc', 340) === 340);
  }
}

/* ═══════════════════ 9x · 浮窗分档精度 ＋ 热力图级联去重叠 ═══════════════════
   本批收口（2026-10-07，9w 后续三问；2026-10-08 修订——② tape24h 随成交页退役整块删除）：
     ① `fmtFloatPrice`：浮窗价格读数按量级分档（≥$1,000 一位 / ≥$1 两位 / <$1 委托 fmtPrice）——
        修「订单簿步进不随币价变化」：ETH 2016 在 $1.5 时档距只有 ~$0.04，旧 fmtLogPrice
        一位小数把相邻档舍成同一个号（两档都显「1.5」），玩家看到的步进恒为零。
        日志口径不动（fmtLogPrice 仍 1 位，2026-09-29 拍板）；
     ③ 热力图像素级去重叠：条与现价线合并进同一场排序级联（行距恒 12px）——
        旧 gap 公式随条数变密反而缩水（n=10 时仅 5.3px），高杠杆档互相压字、100x 条压现价线；
     ④ 热力图条不再裁剪：`overflow: hidden` 会把窄条（$239.7K 的 100x 条只剩 26px）的文字啃掉。 */
section('9x · 浮窗分档精度 fmtFloatPrice ＋ 热力图级联去重叠');
{
  /* ── ① fmtFloatPrice：量级分档（对照旧口径演示病根） ── */
  check('9x① ≥$1,000 一位小数（千分位保留）：12,345.7',
    F.fmtFloatPrice(12345.67) === '12,345.7', F.fmtFloatPrice(12345.67));
  check('9x① 边界：$1,000 一位 / $1 两位',
    F.fmtFloatPrice(1000) === '1,000.0' && F.fmtFloatPrice(1) === '1.00',
    `${F.fmtFloatPrice(1000)} / ${F.fmtFloatPrice(1)}`);
  check('9x① ≥$1 两位小数：$1.50 与 $1.54 可分（旧 fmtLogPrice 两档同显「1.5」＝ 病根复现）',
    F.fmtFloatPrice(1.5) === '1.50' && F.fmtFloatPrice(1.54) === '1.54'
    && F.fmtLogPrice(1.5) === F.fmtLogPrice(1.54), `旧口径 ${F.fmtLogPrice(1.54)} 不可分`);
  check('9x① <$1 委托 fmtPrice：与 fmtLogPrice 同口径（DOGE 级 8 字符）',
    F.fmtFloatPrice(0.000089) === F.fmtLogPrice(0.000089) && F.fmtFloatPrice(0.000089) === '0.000089'
    && F.fmtFloatPrice(0.5) === F.fmtLogPrice(0.5), F.fmtFloatPrice(0.000089));
  check('9x① 负价 ＋ 非有限值：-3.14 ＋ 非 finite ⇒ --',
    F.fmtFloatPrice(-3.1416) === '-3.14'
    && F.fmtFloatPrice(NaN) === '--' && F.fmtFloatPrice(Infinity) === '--');

  /* ── ③④ render / style 接线锚 ──
     （旧 ② tape24h 块已随成交页退役删除——负向锚在 9w⑤。） */
  const rendSrc9x = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
  const styleSrc9x = fs.readFileSync(path.join(ROOT, 'src/ui/style.css'), 'utf8');
  const fbody = rendSrc9x.slice(rendSrc9x.indexOf('function floatBody'),
    rendSrc9x.indexOf('export function updateFloat'));
  check('9x③ 浮窗四页价格读数全走 fmtFloatPrice（floatBody 区间内不再有 fmtLogPrice）',
    fbody.includes('fmtFloatPrice') && (fbody.match(/fmtFloatPrice/g) || []).length >= 5
    && !fbody.includes('fmtLogPrice'),
    `floatBody 内 ${fbody ? (fbody.match(/fmtFloatPrice/g) || []).length : 0} 处`);
  check('9x③ 热力图级联：条与现价线同一场排序 ＋ 行距恒 12px ＋ 旧 gap 公式已退役 ＋ 视窗自适应覆盖全部远档',
    rendSrc9x.includes('rows.push({ y: yFrac(w.price), now: true })')
    && rendSrc9x.includes('const GAP = 12 / HM_H')
    && rendSrc9x.includes('rows.sort((a, b) => a.y - b.y)')
    && rendSrc9x.includes('const pad = (hi - lo) * 0.06 || w.price * 0.04;')
    && !rendSrc9x.includes('BAND = 0.35')
    && !rendSrc9x.includes('Math.max(1, vis.length - 1) - 12')
    && !rendSrc9x.includes('条远档强平在'));
  const styleNoCmt = styleSrc9x.replace(/\/\*[\s\S]*?\*\//g, '');
  check('9x④ 热力图条不裁剪：.god-hm-bar 无 overflow:hidden（窄条文字完整）＋ 行高 12px 与 GAP 同源',
    !/\.god-hm-bar \{[^}]*overflow\s*:\s*hidden/.test(styleNoCmt)
    && /\.god-hm-bar \{[^}]*line-height: 12px/.test(styleNoCmt));

  /* ── ⑤ 热力图级联双向化（2026-10-08 bug 修：「左下角又堆在了一起」＝ 4f92f43 级联的回归） ──
     旧版只做**正向**（自顶向下推）：底部密集条目（长侧强平挤在下方）越界后被 `clampT` 夹到同一
     `top` ⇒ 左下角堆叠；左上角因上侧条目少、未越界而正常。修法：正向推 ＋ 反向回推 ＋ 整体
     平移入界；总跨度超可用区（n 大且分布极散）时压自然位置再叠加 rank×GAP 兜底（行距恒 ≥ GAP）。 */
  check('9x⑤ 热力图级联双向化：正向推 ＋ 反向回推 ＋ 基准先取出 ＋ 兜底保留行距（源码锚）',
    rendSrc9x.includes('rows[i].t = i ? Math.max(rows[i].y, rows[i - 1].t + GAP) : rows[i].y')
    && rendSrc9x.includes('rows[i].t = Math.min(rows[i].t, rows[i + 1].t - GAP)')
    && rendSrc9x.includes('const o0 = rows[0].t') && rendSrc9x.includes('const span = rows[n - 1].t - o0')
    && rendSrc9x.includes('1 - MARGIN - (ySpan * k + (n - 1) * GAP)'));
  {
    /* 行为断言（不只锚源码）：逐字复刻 render.js 页 0 级联，跑密集数据集统计「同行重叠/越界」。
       回归场景（底部密集）旧正向级联最小行距 0px、21 对重叠；新布局四组数据集零问题。 */
    const HM = 240, GP = 12 / HM, MG = 6 / HM, AV = 1 - 2 * MG;
    const layout = ys => {
      const r = ys.map(y => ({ y })).sort((a, b) => a.y - b.y);
      for (let i = 0; i < r.length; i++) r[i].t = i ? Math.max(r[i].y, r[i - 1].t + GP) : r[i].y;
      for (let i = r.length - 2; i >= 0; i--) r[i].t = Math.min(r[i].t, r[i + 1].t - GP);
      const o0 = r[0].t, n = r.length, sp = r[n - 1].t - o0;
      if (sp <= AV) { const b = Math.min(Math.max(o0, MG), 1 - MG - sp); for (const x of r) x.t += b - o0; }
      else {
        const free = AV - (n - 1) * GP, ysp = r[n - 1].y - r[0].y;
        const k = ysp > 0 ? Math.max(0, Math.min(1, free / ysp)) : 1;
        const b = Math.min(Math.max(r[0].y, MG), 1 - MG - (ysp * k + (n - 1) * GP));
        for (let i = 0; i < n; i++) r[i].t = b + (r[i].y - r[0].y) * k + i * GP;
      }
      return r;
    };
    const scan = r => {
      let stack = 0, oob = 0, minSep = Infinity;
      for (let i = 0; i < r.length; i++) {
        if (r[i].t < MG - 1e-9 || r[i].t > 1 - MG + 1e-9) oob++;
        for (let j = i + 1; j < r.length; j++) {
          const d = Math.abs(r[j].t - r[i].t);
          if (d < minSep) minSep = d;
          if (d < GP - 1e-9) stack++;
        }
      }
      return { stack, oob, minSep: minSep === Infinity ? GP : minSep };
    };
    const yf = p => (135 - p) / 70;               // price=100、视窗 ±35% → yFrac
    const sets = [
      [...[66, 66.5, 67, 67.5, 68, 68.5, 69].map(yf), ...[120, 124, 128].map(yf), 0.5],  // 底部密集（回归场景）
      [[66, 67, 68, 69.5].map(yf), [118, 122, 126, 130].map(yf), 0.5].flat(),            // 双侧密集 ＋ 现价线
      [...[65.2, 70, 78, 86, 94, 102, 110, 118, 126, 133].map(yf), 0.5],                 // 极散铺满 ±35%
      [0.5],                                                                             // 仅现价线（n=1 边界）
    ];
    const res = sets.map(layout).map(scan);
    const bad = res.reduce((a, s) => a + s.stack + s.oob, 0);
    check('9x⑤ 布局行为：底部密集/双侧密集/极散/单行四组数据集「零同行重叠 ＋ 零越界」',
      bad === 0, `问题数 ${bad}（旧正向级联此四组为 27）`);
    check('9x⑤ 回归复现：底部密集组最小行距 ≥ 12px（旧正向级联此组被夹成 0px 同行堆叠）',
      res[0].minSep * HM >= 12 - 1e-6, `${(res[0].minSep * HM).toFixed(2)}px`);
  }
}

/* ═══════════════════ 9y · 深跌护盘买盘 ＋ y 轴/浮窗步进自适应 ═══════════════════
   本批收口（2026-10-07，9x 后续三问）：
     ① 护盘（用户拍板「特别低的价格肯定是有人护盘的」）：`NPC.dip` —— 回撤越深 NPC 抄底盘
        越大（涌现式，**不恢复位移硬夹**，「去掉封顶封底」拍板保持）。护盘读**盘面价**
        （lastPrice 含位移）⇒ 玩家砸盘真实触发；买盘推价回升 ⇒ 回撤收窄 ⇒ 护盘减弱
        （负反馈自稳定，不自激发散、也不把价托回原价 —— cap 有界，现实里抄底盘会被埋）。
        方向性买盘只加**长侧**、只给生效杠杆 ≤10x 档（与基底同判据）。
     ② y 轴步进自适应（用户拍板）：`fmtAxisPrice(p, step)` —— 小数位 = max(量级档位,
        ⌈−log₁₀(step)⌉)，步进 = 视野跨度/3（chart.js 3 等分网格）；被砸盘砸出的极窄视野
        相邻刻度不再同显同一个数。
     ③ 浮窗同步（用户拍板「y 轴步进同步检查详情浮窗」）：订单簿页把**档距**（基础档前两行
        价差，比例阶梯第一段最细、取它最保守）传给 `fmtFloatPrice(p, step)` —— 千分位风格
        不变，价格被砸到 <$0.01、档距 <$1e-6 时相邻档也不会同显。 */
section('9y · 深跌护盘 dipOf ＋ y 轴/浮窗步进自适应 fmtAxisPrice');
{
  const godSrc9y = fs.readFileSync(path.join(ROOT, 'src/core/god.js'), 'utf8');

  /* ── ① dipOf：常数 ＋ 公式逐位复刻 ＋ 有界性 ── */
  check('9y① dip 常数：ref 0.15 / full 0.5 / cap 0.12（cap 与 NPC.base 同量级，护盘显著不夺主）',
    godSrc9y.includes('dip: {') && godSrc9y.includes('ref: 0.15,')
    && godSrc9y.includes('full: 0.5,') && godSrc9y.includes('cap: 0.12,'));
  const sD = await mk({ sym: 'BTC', cash: 1e6, i: idx(at(2021, 4, 20)) });
  const ddD = engine.dipOf(sD, 'BTC');
  check('9y① 2021-05-20（5·19 暴跌次日）护盘触发：dipOf > 0',
    ddD > 0 && ddD <= god.NPC.dip.cap, `dip=${ddD.toFixed(4)}`);
  const curD = engine.lastPrice(sD, 'BTC');
  let hiD = 0;
  for (let back = 1; back <= 24; back++) { const c = market.candleAt('BTC', sD.i - back); if (c && c.h > hiD) hiD = c.h; }
  const ddRaw = 1 - curD / hiD;
  const expD = ddRaw <= god.NPC.dip.ref ? 0
    : Math.min(god.NPC.dip.cap, god.NPC.dip.cap * (ddRaw - god.NPC.dip.ref) / (god.NPC.dip.full - god.NPC.dip.ref));
  check('9y① dipOf 与公式逐位一致（cur = lastPrice · hi = 近 24 根已收盘 K 线高点，接线没错位）',
    Math.abs(ddD - expD) < 1e-15, `dip=${ddD} · expect=${expD}`);
  const sSh = await mk({ sym: 'BTC', cash: 1e6, i: idx(at(2019, 5, 1)) });
  check('9y① 浅跌恒零：2019-06 横盘段 dipOf == 0（回撤 ≤ ref ⇒ 与旧档逐位同轨）',
    engine.dipOf(sSh, 'BTC') === 0);
  let okBound = true;
  for (const [y, m, d] of [[2017, 8, 1], [2020, 2, 15], [2021, 4, 20], [2022, 4, 30], [2024, 7, 5]]) {
    const sX = await mk({ sym: 'BTC', cash: 1e6, i: idx(at(y, m, d)) });
    const dv = engine.dipOf(sX, 'BTC');
    if (!(dv >= 0 && dv <= god.NPC.dip.cap)) okBound = false;
  }
  check('9y① 有界性：任意历史日期 dipOf ∈ [0, cap]（5 个采样点，含 2017-09 / 2020-03 极端段）', okBound);

  /* ── ①′ 滑窗缓存等价（2026-10-08 · 跳时间卡死修复）：热路径右移 ＋ 回退作废，均与直扫逐位一致 ── */
  const sW = await mk({ sym: 'BTC', cash: 1e6, i: idx(at(2021, 4, 20)) });
  for (let k = 0; k < 50; k++) engine.advanceOneHour(sW);      // 连续 50 根热路径（copyWithin 右移）
  const dipW = engine.dipOf(sW, 'BTC');
  let hiW = 0;
  for (let back = 1; back <= 24; back++) { const c = market.candleAt('BTC', sW.i - back); if (c && c.h > hiW) hiW = c.h; }
  const ddW = 1 - engine.lastPrice(sW, 'BTC') / hiW;
  const expW = ddW <= god.NPC.dip.ref ? 0
    : Math.min(god.NPC.dip.cap, god.NPC.dip.cap * (ddW - god.NPC.dip.ref) / (god.NPC.dip.full - god.NPC.dip.ref));
  check('9y①′ 滑窗缓存：连续推进 50 根后 dipOf 与直扫逐位一致（copyWithin 右移没丢根/错位）',
    Math.abs(dipW - expW) < 1e-15, `dip=${dipW} · expect=${expW}`);
  const iBack = idx(at(2021, 4, 20));
  engine.rewindTo(sW, iBack);                                   // 回退 → 缓存整表作废 → 冷路径重建
  const dipB = engine.dipOf(sW, 'BTC');
  let hiB = 0;
  for (let back = 1; back <= 24; back++) { const c = market.candleAt('BTC', sW.i - back); if (c && c.h > hiB) hiB = c.h; }
  const ddB = 1 - engine.lastPrice(sW, 'BTC') / hiB;
  const expB = ddB <= god.NPC.dip.ref ? 0
    : Math.min(god.NPC.dip.cap, god.NPC.dip.cap * (ddB - god.NPC.dip.ref) / (god.NPC.dip.full - god.NPC.dip.ref));
  check('9y①′ 回退后 dipOf 与直扫仍逐位一致（rewindTo resetDipCache ＋ 连续性冷启动双保险）',
    Math.abs(dipB - expB) < 1e-15, `dip=${dipB} · expect=${expB}`);

  /* ── ② 接线：方向性（只长侧）＋ 低杠杆判据 ＋ 全币覆盖 ── */
  const engSrc9y = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
  check('9y② 接线：dipOf 导出 ＋ npcBuild 长侧 dipBuy（买加长侧）＋ npcOtherTick 复用（护盘覆盖全币）',
    engSrc9y.includes('export function dipOf')
    && engSrc9y.includes('const dipBuy = d3.dipBuy;')
    && engSrc9y.includes("stepNpc(m.npc[k], 'long', b + Math.max(0, target * w), price, floor, NPC.ladder[k].sp, s, sym)")
    && engSrc9y.includes('const buy = (dipBuy + Math.max(0, extFlow)) * w;')
    && engSrc9y.includes('npcBuild(s, sym, m, s.i);')
    && engSrc9y.includes('import { candleAt, closeAt, dayIndexOf'));

  /* ── ③ fmtAxisPrice：y 轴刻度 ── */
  check('9y③ 不传 step 与旧轴口径逐位相同（k 单位 / 整数 / 一位 / 两位 / 四位 / 六位）',
    F.fmtAxisPrice(108000) === '108.0k' && F.fmtAxisPrice(1234.56) === '1235'
    && F.fmtAxisPrice(105.25) === '105.3' && F.fmtAxisPrice(1.54) === '1.54'
    && F.fmtAxisPrice(0.052) === '0.0520' && F.fmtAxisPrice(0.000089) === '0.000089');
  check('9y③ k 档按 step/1000 提位：step=$50 ⇒ 108.00k（相邻刻度 $50 可分）',
    F.fmtAxisPrice(108000, 50) === '108.00k', F.fmtAxisPrice(108000, 50));
  check('9y③ 病根回归：窄视野 span=$0.02 ⇒ 步进 $0.0067 三根刻度互异（旧口径后两根同显 1.51）',
    F.fmtAxisPrice(1.5, 0.02 / 3) === '1.500'
    && F.fmtAxisPrice(1.5067, 0.02 / 3) === '1.507'
    && F.fmtAxisPrice(1.5133, 0.02 / 3) === '1.513');
  check('9y③ DOGE 级窄视野：step=$1.7e-6 ⇒ 6 位相邻可分',
    F.fmtAxisPrice(0.000089, 1.7e-6) === '0.000089'
    && F.fmtAxisPrice(0.0000907, 1.7e-6) === '0.000091');
  check('9y③ 非有限 ⇒ -- ＋ 负价直显（步进提位负号不丢）',
    F.fmtAxisPrice(NaN) === '--' && F.fmtAxisPrice(-3.1416, 0.005) === '-3.142');

  /* ── ④ fmtFloatPrice 的 step：浮窗档位（千分位风格不变） ── */
  check('9y④ 浮窗 step 提位：$1.5 档距 $0.004 ⇒ 1.500 ＋ BTC 档距 $0.5 不提位（12,345.7）',
    F.fmtFloatPrice(1.5, 0.004) === '1.500' && F.fmtFloatPrice(12345.67, 0.5) === '12,345.7');
  check('9y④ 极端档距（护盘砸穿后的沙盒）：价 $0.000108 档距 $1e-6 ⇒ 6 位相邻可分 ＋ $1e-8 ⇒ 提到 8 位',
    F.fmtFloatPrice(0.000108, 1e-6) === '0.000108' && F.fmtFloatPrice(0.000109, 1e-6) === '0.000109'
    && F.fmtFloatPrice(0.000108, 1e-8) === '0.00010800');

  /* ── ⑤ render / chart 源码锚 ── */
  const chartSrc9y = fs.readFileSync(path.join(ROOT, 'src/ui/chart.js'), 'utf8');
  const rendSrc9y = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
  check('9y⑤ chart：axisLabel 委托 fmtAxisPrice ＋ 网格刻度传 span/3（entry/强平/mark 单值标签不传）',
    chartSrc9y.includes('import { fmtAxisPrice, fmtMoneyShort }')
    && chartSrc9y.includes('const axisLabel = fmtAxisPrice;')
    && chartSrc9y.includes('axisLabel(p, span / 3)'));
  check('9y⑤ render：订单簿档位 / mid 传 step（niceStepOf 1-2-5 网格步进，2026-10-08 网格化改版），热力图/巨鲸页仍量级口径',
    rendSrc9y.includes('const step = niceStepOf(b.mid)')
    && rendSrc9y.includes('fmtFloatPrice(r.price, step)')
    && rendSrc9y.includes('fmtFloatPrice(b.mid, step)'));
}

/* ═══════════════════ 9z · 深跌护盘三层（2026-10-08 大改） ═══════════════════
   收口（用户拍板「机构护盘 / 散户护盘 / 做市商护盘」三层大改，调研锚见 god.NPC.dip 表头）：
     ① `dipBuyOf` 纯函数逐位锚定：机构储备（播种 / 封顶 / 涓流 / 耗尽）＋ 散户极恐接盘
        （fng 严格 < 22，越恐越接、上限 3%）；储备上限 = `seedBase[sym]`（现实量级：LFG 2022
        持仓 0.13 × 日额）**× 年代系数**（缺口 3：早期机构护盘事实为零 ⇒ 1/10 起）；
     ② 接线：npcBuild 走 dipBuyOf（储备落账 ＋ dipGone 复位/告警）＋ settleFng 双调用点
        （都在 npcBuild 之前 ⇒ 散户层读的 fng 全币同相位）＋ 格子新键不升 STATE_VERSION；
     ③ 做市相位：回撤加深 →mmCut（先撤单）/ 收窄 →mmBoost（V 型回补）/ 平时 ×1 —— 靶心乘子、
        不加新状态，且**倍率按回撤深度线性插值**（缺口 8：实测 −98% 的极端读数只在最深那一根）；
        2025-10-10 实测锚：可见深度 $103.64M → $0.17M，≈35 分钟恢复九成；
     ④ 行为：耗尽机制探针（现实量级下单次崩盘烧不光储备 ⇒ 合成「储备归零」探针验证
        dipGone 翻真 ＋ 日志落账；LFG 锚：护盘不是无限弹药，但 33 亿美元也确实托不住）。 */
section('9z · 深跌护盘三层 dipBuyOf ＋ 做市相位');
{
  /* ── ① dipBuyOf 逐位（缺口 3：存量上限 `seedBase.BTC = 0.15`／取用 0.005／涓流 0.0002）──
     默认 seed = seedBase.BTC = 0.15 ⇒ capRes = 1e6×0.15 = 150000；want = 1e6×dip×0.005。 */
  const r1 = engine.dipBuyOf(1e6, 0.2, null, 50);   // 新格子：res=null ⇒ 按满仓播种
  check('9z① 播种取用：res=null ⇒ 满仓 0.15×liqDay，instBuy = min(储备, liqDay×dip×0.005)，散户层不触发（fng=50）',
    r1.instBuy === 1000 && r1.resAfter === 149000 && r1.dipBuy === 1000 && !r1.gone && r1.retailBuy === 0,
    `inst=${r1.instBuy} res=${r1.resAfter}`);
  const r2 = engine.dipBuyOf(1e6, 0, 1e5, 50);      // 涓流回补：dip=0 ⇒ 不取用，只 +200/h
  check('9z① 涓流回补：res + instFlow×liqDay（每小时 +200），封顶不越 0.15×liqDay',
    r2.resAfter === 100200 && r2.instBuy === 0
    && engine.dipBuyOf(1e6, 0, 149900, 50).resAfter === 150000, `res=${r2.resAfter}`);
  const r3 = engine.dipBuyOf(1e6, 0.2, 0, 10);      // 耗尽：储备 0，涓流 200 < want 1000 ⇒ 全花光
  check('9z① 储备耗尽：只有涓流盘可花（200 < want 1000）⇒ resAfter = 0 ⇒ gone；散户层极恐补位（fng=10）',
    r3.instBuy === 200 && r3.resAfter === 0 && r3.gone
    && Math.abs(r3.retailBuy - 1e6 * 0.03 * (1 - 10 / 22)) < 1e-9,
    `inst=${r3.instBuy} retail=${r3.retailBuy}`);
  check('9z① 散户层口径：fng=11 ⇒ retail = liqDay×0.03×0.5（逐位）；fng=22 ⇒ 0（严格 <）；NaN ⇒ 中性 50 ⇒ 0；dip=0 ⇒ 只有散户层',
    engine.dipBuyOf(1e6, 0.2, 1e6, 11).retailBuy === 15000
    && engine.dipBuyOf(1e6, 0.2, 1e6, 22).retailBuy === 0
    && engine.dipBuyOf(1e6, 0.2, 1e6, NaN).retailBuy === 0
    && engine.dipBuyOf(1e6, 0, 1e6, 11).dipBuy === engine.dipBuyOf(1e6, 0, 1e6, 11).retailBuy);

  /* ── ①′ instSeedOf 逐位（缺口 3：储备上限 = seedBase[sym] × 年代系数）──
     现实锚（LFG 2022）：80,394 BTC ≈ $3.3B ÷ 当年 BTC 日成交额 ≈ $25B ⇒ 0.13 ⇒ `seedBase.BTC = 0.15`；
     年代系数让早期（机构护盘事实为零）按 1/10 起，逐段抬到 1（MSTR 2020 首买 / LFG 2021 成形）。 */
  check('9z①′ 年代系数：BTC 在 2013/2016 → ×0.10（0.015）；2018 → ×0.25（0.0375）；2021 → ×0.50（0.075）；2023 起 → ×1.00（0.15）',
    Math.abs(god.instSeedOf('BTC', Date.UTC(2013, 0, 1)) - 0.015) < 1e-12
    && Math.abs(god.instSeedOf('BTC', Date.UTC(2016, 5, 1)) - 0.015) < 1e-12
    && Math.abs(god.instSeedOf('BTC', Date.UTC(2018, 5, 1)) - 0.0375) < 1e-12
    && Math.abs(god.instSeedOf('BTC', Date.UTC(2021, 0, 1)) - 0.075) < 1e-12
    && Math.abs(god.instSeedOf('BTC', Date.UTC(2024, 0, 1)) - 0.15) < 1e-12,
    `2021=${god.instSeedOf('BTC', Date.UTC(2021, 0, 1))}`);
  check('9z①′ 按币分档（同为 2024）：BTC 0.15 > ETH 0.10 > SOL 0.05 > XRP 0.03 > DOGE 0.02',
    god.instSeedOf('BTC', Date.UTC(2024, 0, 1)) > god.instSeedOf('ETH', Date.UTC(2024, 0, 1))
    && god.instSeedOf('ETH', Date.UTC(2024, 0, 1)) > god.instSeedOf('SOL', Date.UTC(2024, 0, 1))
    && god.instSeedOf('SOL', Date.UTC(2024, 0, 1)) > god.instSeedOf('XRP', Date.UTC(2024, 0, 1))
    && god.instSeedOf('XRP', Date.UTC(2024, 0, 1)) > god.instSeedOf('DOGE', Date.UTC(2024, 0, 1)));
  check('9z①′ 未列出的币 ⇒ 0（无机构护盘）；年代系数只抬不降（逐段查表，缺省取首段）',
    god.instSeedOf('LTC', Date.UTC(2024, 0, 1)) === 0
    && god.instSeedOf('BTC', Date.UTC(2012, 0, 1)) === god.instSeedOf('BTC', Date.UTC(2013, 0, 1)));

  /* ── ②③ 接线 / 相位源锚 ── */
  const engSrc9z = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
  check('9z② 接线：npcBuild 走 dipBuyOf（储备上限按币×年代 instSeedOf ＋ 储备落账 ＋ dipGone 复位/告警）＋ settleFng 双调用点（npcBuild 之前）',
    engSrc9z.includes('const d3 = dipBuyOf(liqDay, dip, m.dipRes, m.fng, instSeedOf(sym, t));')
    && engSrc9z.includes('const t = timeOf(s);')
    && engSrc9z.includes('m.dipRes = d3.resAfter;')
    && engSrc9z.includes('if (dip === 0) m.dipGone = false;')
    && engSrc9z.includes('机构护盘储备耗尽')
    && engSrc9z.indexOf('settleFng(s, sym, m, i);') < engSrc9z.indexOf('  npcBuild(s, sym, m, i);')
    && engSrc9z.includes('settleFng(s, sym, m, s.i);'));
  check('9z② instSeedOf 自 god.js 导入（引擎侧必须显式传，不靠默认兜底）',
    /import\s*\{[^}]*instSeedOf[^}]*\}\s*from\s*'\.\/god\.js'/.test(engSrc9z));
  check('9z② 格子新键（不升 STATE_VERSION）：dipRes / dipPrev / dipGone 惰性播种＋防御读',
    engSrc9z.includes('dipRes: null, dipPrev: 0, dipGone: false'));
  check('9z③ 做市相位：加深 ⇒ →mmCut / 收窄 ⇒ →mmBoost / 平时 ×1（靶心乘子，不加新状态）',
    engSrc9z.includes('const cutT = dip / NPC.dip.cap;')
    && engSrc9z.includes('const mmMul = dip > 0 && dip >= dipPrev ? 1 + (NPC.dip.mmCut - 1) * cutT')
    && engSrc9z.includes(': (dipPrev > 0 && dip < dipPrev ? 1 + (NPC.dip.mmBoost - 1) * cutT : 1);')
    && engSrc9z.includes('-NPC.mm.absorb * mmMul * trendNet(m)'));
  /* 倍率插值的行为锚（内联复刻 npcBuild 的那两行）—— 缺口 8 修正：原来 `mmCut` 是常量，
     只要「回撤加深」就整档套用；现在按 `cutT = dip / cap` 线性插值，最深那一根才取满。 */
  {
    const CAP = god.NPC.dip.cap;
    const mmOf = (dip, dipPrev) => {
      const cutT = dip / CAP;
      return dip > 0 && dip >= dipPrev ? 1 + (god.NPC.dip.mmCut - 1) * cutT
        : (dipPrev > 0 && dip < dipPrev ? 1 + (god.NPC.dip.mmBoost - 1) * cutT : 1);
    };
    check('9z③ 加深腿端点：dip = cap（最深）⇒ 恰为 mmCut（承接只剩 3% ≈ −97% 真空）',
      Math.abs(mmOf(CAP, CAP) - god.NPC.dip.mmCut) < 1e-12
      && god.NPC.dip.mmCut === 0.03, `实得 ${f(mmOf(CAP, CAP), 6)}`);
    check('9z③ 加深腿单调：跌得越深撤得越狠（dip 0.02 > 0.06 > cap 倍率严格递减）',
      mmOf(0.02, 0.01) > mmOf(0.06, 0.01) && mmOf(0.06, 0.01) > mmOf(CAP, 0.01)
      && mmOf(0.02, 0.01) < 1,
      `${f(mmOf(0.02, 0.01), 4)} / ${f(mmOf(0.06, 0.01), 4)} / ${f(mmOf(CAP, 0.01), 4)}`);
    check('9z③ 回补腿：同为 cap 深度时取满 mmBoost（×2.0）；无深跌 ⇒ 逐位 ×1（旧档同轨）',
      Math.abs(mmOf(CAP * 0.5, CAP) - (1 + (god.NPC.dip.mmBoost - 1) * 0.5)) < 1e-12
      && god.NPC.dip.mmBoost === 2 && mmOf(0, 0) === 1 && mmOf(0, 0.05) === 1,
      `回补=${f(mmOf(CAP * 0.5, CAP), 4)} 平时=${mmOf(0, 0)}`);
    check('9z③ 回补速度：撤单必须在一根内成型（mm.speed 0.5 → 0.8）',
      god.NPC.mm.speed === 0.8, `实得 ${god.NPC.mm.speed}`);
    check('9z③ 相位公式在端点与「深浅无关」两侧都连续（cutT → 0 ⇒ 倍率 → 1）',
      Math.abs(mmOf(1e-9, 0) - 1) < 1e-6);
  }

  /* ── ④ 行为：耗尽探针 ──
     ⚠️ dipOf 的回看窗只有 24 根**已收盘小时线** ⇒ 深跌是**阵发**的（一次暴跌后 ~24–36h 内
        dip > 0，随后高点滚出窗口）—— 不存在「连续 240 小时深跌」。
     ⚠️ **现实量级下，单次崩盘不足以烧光机构储备**（缺口 3 修正后的事实）：储备 = 0.15 × 日额，
        最深回撤每根取用 0.12×0.005 = 0.0006 × 日额 ⇒ 要**连续 ~10 天**最深回撤才见底，
        而 dip 阵发、且每小时 +0.0002 涓流回补 ⇒ 自然归零是**罕见**事件（LFG 花掉 33 亿美元仍崩盘）。
        所以耗尽行为**不靠长跑**，而是合成探针：先扫到一根 dip ≥ 0.06 的深跌根（> 涓流 0.0002/取用
        0.005 = 0.04 的门槛 ⇒ 该根涓流会被花光），把储备直接置 0（等价「已耗尽」），重 tick 同一根
        （dip 不变、want ≥ 涓流 ⇒ resAfter = 0）⇒ dipGone 翻真 ＋ 日志落账。 */
  const sZ = await mk({ sym: 'BTC', cash: 1e6, i: idx(at(2020, 2, 12, 0)) }); // at() 月 0 基 ⇒ 2020-03-12
  let deep = 0, dipZ = 0;
  for (let k = 0; k < 96; k++) {
    engine.advanceOneHour(sZ);
    dipZ = engine.dipOf(sZ, 'BTC');
    if (dipZ >= 0.06) { deep = sZ.i; break; }       // 需 dip·rate ≥ instFlow ⇒ dip ≥ 0.04，取 0.06 留余量
  }
  check('9z④-a 前提：3·12 崩盘段 96 小时内出现 dip ≥ 0.06 的深跌根（> 涓流入不敷出的门槛 0.04）',
    deep > 0, `dip=${dipZ} @i=${deep}`);
  if (deep > 0) {
    const mZ = sZ.mkt.BTC;
    mZ.dipRes = 0; mZ.dipGone = false;             // 等价「储备已耗尽」
    engine.tickMarket(sZ, 'BTC');                   // 同一根重跑（探针）：dip 同、储备只剩涓流
    check('9z④ 耗尽行为：储备归零 ⇒ dipGone 翻真 ＋「储备耗尽」日志落账（只剩涓流盘）',
      mZ.dipGone === true && sZ.log.some(e => e.text.includes('机构护盘储备耗尽')),
      `dip=${dipZ}`);
  }
}

/* ═══════════════════ 9aa · 监管事件锚点（2026-10-08 · 缺口 6） ═══════════════════
   7 条监管/合规锚点进 `anchors.js` —— **只出新闻与 K 线标记，零人工涨跌幅**（P2-C 红线）；
   结果新闻的判定走 `candleAt`（含玩家位移）⇒ 动态；不产生链上拥堵（`congestion` 全 null）。
   同时固化两件事：① 全表相邻锚点 ≥ 24h（24h 新闻窗不叠）；② 与 `review.js` EXTRA 的回顾节点**不撞 `at`**。 */
section('9aa · 监管事件锚点 7 条 ＋ 回顾节点去重');
{
  const A = await import('../src/core/anchors.js');
  const RV = await import('../src/core/review.js');
  const all = A.allAnchors();
  const NEW = [
    Date.UTC(2014, 2, 25), Date.UTC(2018, 1, 6), Date.UTC(2019, 6, 12),
    Date.UTC(2021, 8, 24), Date.UTC(2022, 7, 8), Date.UTC(2023, 5, 5), Date.UTC(2023, 10, 21),
  ];
  const got = NEW.map(t => all.find(a => a.t === t));

  check('9aa① 锚点表 20 → 27 条（新增 7 条监管事件）', all.length === 27, `实得 ${all.length}`);
  check('9aa① 7 条新锚点按 `t` 全部落表', got.every(Boolean), NEW.filter((t, k) => !got[k]).join(','));
  check('9aa① `at` 逐位 = (t − GAME.start) ÷ 1h',
    NEW.every((t, k) => got[k] && got[k].at === Math.round((t - C.GAME.start) / H)));
  check('9aa① 形态：chain ∈ {btc, eth, null}；监管事件不产生链上拥堵（congestion 全 null）',
    got.every(a => a && (a.chain === 'btc' || a.chain === 'eth' || a.chain === null) && a.congestion === null));
  check('9aa① 首条新闻只讲事件、不含价格数字（标题无「$」无「%」）',
    got.every(a => a && !/[$%]/.test(a.title)));
  check('9aa① 全部落在行程内（早于 GAME.end = 2025-01-01）', NEW.every(t => t < Date.UTC(2025, 0, 1)));

  check('9aa② 结果新闻规格合法：带 `rt` 的必有 `r`，k ∈ {lvl, mv}、w ≥ 1、sym 与 dir 齐备',
    got.every(a => a && (!a.rt || (a.r && (a.r.k === 'lvl' || a.r.k === 'mv')
      && a.r.w >= 1 && !!a.r.sym && (a.r.dir === 1 || a.r.dir === -1)))));
  const ats = all.map(a => a.at).sort((x, y) => x - y);
  check('9aa② 全表相邻锚点至少相隔 24h（24h 新闻窗不叠）',
    ats.every((x, k) => k === 0 || x - ats[k - 1] >= 24));
  check('9aa② 每条新锚点的首条新闻在自己的播报时刻命中（`===` 判等 ⇒ 恰一次）',
    got.every(a => { const hit = A.newsStartAt(a.at + (a.h || 0) + 1); return hit && hit.t === a.t; }));

  const rv = RV.RV_NODES;
  const rvAt = rv.map(n => n.at);
  const dup = rvAt.filter((x, k) => rvAt.indexOf(x) !== k);
  check('9aa③ 回顾节点无重复 `at`（anchors 27 ＋ EXTRA 25 互不撞车）', dup.length === 0, dup.join(','));
  check('9aa③ 回顾节点总数 = 27 ＋ 25 = 52', rv.length === 52, `实得 ${rv.length}`);
  check('9aa③ 7 条新锚点在回顾里都有节点、且 note 非空',
    got.every(a => { const n = rv.find(v => v.at === a.at); return n && typeof n.note === 'string' && n.note.length > 0; }));
  check('9aa③ Tornado Cash 回顾切到 ETH（事件在以太坊上）',
    (rv.find(v => v.at === Math.round((Date.UTC(2022, 7, 8) - C.GAME.start) / H)) || {}).sym === 'ETH');
}

/* ═══════════════════ 9ab · 稳定币脱锚市值重估（缺口 2 · 2026-10-08） ═══════════════════
   口径（用户拍板「市值重估参与破产判定」）：`cashOf`（面值 = 可交易余额）与 `cashMtmOf`
   （市值 = 财富口径）**分立**；换汇那一刻**不结账**（`qty × p ≡ usd` ⇒ 权益守恒），盈亏改由
   持有期 `markUsdt` 逐小时结进 `s.realized`；`equity` 走市值口径 ⇒ 脱锚真的缩水、参与破产判定。 */
section('9ab · 稳定币脱锚市值重估 USDT：cashMtmOf / markUsdt / 破产市值口径');
{
  /* 找一个 2022-05 Terra 拖累段的深折价小时 */
  let iD = null;
  for (let i = idx(at(2022, 4, 1)); i < idx(at(2022, 7, 1)); i++) {
    if (C.usdtPriceAt(C.GAME.start + i * H) < 0.99) { iD = i; break; }
  }
  check('9ab① 前置：2022-05 Terra 拖累段存在深折价（usdtPriceAt < 0.99）', iD != null, `i=${iD}`);

  const s = await mk({ i: iD });
  s.hintOn = false;
  s.books[s.ex] = { usd: 1e6, usdt: 0 };
  const p = C.usdtPriceAt(engine.timeOf(s));
  check('9ab① 面值 vs 市值：全 USD 时两者相等（无 U ⇒ 无重估差）',
    engine.available(s) === 1e6 && engine.cashMtmOf(s) === 1e6,
    `面值=${f(engine.available(s), 2)} 市值=${f(engine.cashMtmOf(s), 2)}`);

  const eqA = engine.equity(s);
  const rBuy = engine.buyUsdt(s, 1);
  const qty = usdtHeldOf(s);
  const eqB = engine.equity(s);
  check('9ab② 折价买 U ⇒ 换汇当下权益守恒（qty × p ≡ usd ⇒ 价差 0）',
    rBuy.ok && Math.abs(eqB - eqA) < 1e-6 && qty > 0,
    `买前=${f(eqA, 6)} 买后=${f(eqB, 6)} qty=${f(qty, 2)} 汇率=${f(p, 4)}`);
  check('9ab② 面值 ≠ 市值：折价持有 U ⇒ 面值 > 市值（市值 = qty × 汇率）',
    engine.available(s) > engine.cashMtmOf(s)
    && Math.abs(engine.cashMtmOf(s) - qty * p) < 1e-6,
    `面值=${f(engine.available(s), 2)} 市值=${f(engine.cashMtmOf(s), 2)} qty×p=${f(qty * p, 2)}`);

  /* ③ 逐小时重估：找一个汇率真的动了的小时，Δrealized 必须 = qty × (p1 − p0) */
  let i2 = null;
  for (let i = iD + 1; i < iD + 240; i++) {
    if (C.usdtPriceAt(C.GAME.start + i * H) !== C.usdtPriceAt(C.GAME.start + (i - 1) * H)) { i2 = i; break; }
  }
  check('9ab③ 前置：脱锚段内存在逐小时汇率变动的小时', i2 != null, `i2=${i2}`);
  if (i2 != null) {
    const p0 = C.usdtPriceAt(C.GAME.start + (i2 - 1) * H);
    const p1 = C.usdtPriceAt(C.GAME.start + i2 * H);
    const before = s.realized;
    engine.markUsdt(s, i2);
    check('9ab③ markUsdt 结账 = 持仓量 × (p1 − p0)（持有期兑现，非买入即锁定）',
      Math.abs((s.realized - before) - qty * (p1 - p0)) < 1e-6 * Math.max(1, qty),
      `Δ=${f(s.realized - before, 4)} 期望=${f(qty * (p1 - p0), 4)} p0=${f(p0, 5)} p1=${f(p1, 5)}`);
  }

  /* ④ 平段零开销：v0 === v1 的区间里 markUsdt 早退、一分钱不动。
     用 2021-06→2022-05 的双 1.000 段（相邻两锚同值 ⇒ 逐小时恒等，这才是真正的平段）。 */
  const iFlat = idx(at(2021, 7, 1));
  const pf0 = C.usdtPriceAt(C.GAME.start + (iFlat - 1) * H);
  const pf1 = C.usdtPriceAt(C.GAME.start + iFlat * H);
  check('9ab④ 前置：存在汇率平段（p0 === p1，2021-06→2022-05 双 1.000 段）', pf0 === pf1, `p0=${f(pf0, 5)} p1=${f(pf1, 5)}`);
  {
    const before = s.realized;
    engine.markUsdt(s, iFlat);
    check('9ab④ 平段（p0 === p1）⇒ markUsdt 早退、s.realized 一分钱不动', s.realized === before);
  }

  /* ⑤ 常态 $1.000 平段：市值口径 ≈ 面值（差异 < 0.5%） */
  {
    const s2 = await mk({ i: idx(at(2024, 6, 1)) });
    s2.books[s2.ex] = { usd: 0, usdt: 1e6 };
    check('9ab⑤ 常态 $1.000 平段：市值口径 ≈ 面值（差异 < 0.5%）',
      Math.abs(engine.cashMtmOf(s2) - engine.available(s2)) / 1e6 < 0.005,
      `面值=${f(engine.available(s2), 2)} 市值=${f(engine.cashMtmOf(s2), 2)}`);
  }

  /* ⑥ 源码接线 */
  const engSrc9ab = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
  check('9ab⑥ 接线：advanceOneHour 调 markUsdt ＋ equity 走 cashMtmOf ＋ 两函数均已导出',
    engSrc9ab.includes('markUsdt(s, s.i);')
    && engSrc9ab.includes('let sum = cashMtmOf(s);')
    && /export function cashMtmOf/.test(engSrc9ab)
    && /export function markUsdt/.test(engSrc9ab));
  check('9ab⑥ buyUsdt 已删「买入即结算 s.realized += got − usd」（旧无风险套利口径）',
    !/s\.realized \+= got - usd;/.test(engSrc9ab));
  check('9ab⑥ 不升 STATE_VERSION（纯口径改动，零新状态字段）', STATE_VERSION === 32, `v=${STATE_VERSION}`);
}

/* ═══════════════════ 9ac · 巨鲸 / 机构持仓队列（缺口 4 · 2026-10-08） ═══════════════════
   口径：公开披露的**美元名义额** ÷ 执行窗口天数 ⇒ 美元/天；与 `dipBuy` 同址注入 `npcBuild`
   靶心（买加长侧 / 卖加短侧，只给生效杠杆 ≤ 10x 档）；位移走既有链路（`synthGive` 折减），
   **不写 `s.flow`**、零新状态 ⇒ 不升 `STATE_VERSION`。 */
section('9ac · 巨鲸/机构队列 WHALES：逐位摊平 ＋ 买卖都含 ＋ 靶心注入 ＋ 披露播报');
{
  check('9ac① 表 18 条、字段齐备（t/sym/dir/usd/days/who）', god.WHALES.length === 18
    && god.WHALES.every(e => Number.isFinite(e.t) && e.sym && (e.dir === 1 || e.dir === -1)
      && e.usd > 0 && e.days >= 1 && e.who), `n=${god.WHALES.length}`);
  const buys = god.WHALES.filter(e => e.dir > 0), sells = god.WHALES.filter(e => e.dir < 0);
  check('9ac① 买卖都含（用户拍板）：买入 13 条 ＋ 卖出 5 条',
    buys.length === 13 && sells.length === 5, `买=${buys.length} 卖=${sells.length}`);
  check('9ac① 全部落在行程内（披露日 < GAME.end = 2025-01-01）',
    god.WHALES.every(e => e.t < C.GAME.end));

  /* ② 逐位摊平：窗口内 = dir × usd ÷ days；窗口边界前一 / 后一天 = 0 */
  const e0 = god.WHALES[0];
  const d0 = Math.round((e0.t - C.GAME.start) / H / 24);
  const per = e0.dir * e0.usd / e0.days;
  check('9ac② 摊平逐位：窗口首日 = dir × usd ÷ days',
    Math.abs(god.whaleFlowAt('BTC', d0) - per) < 1e-6, `实得=${f(god.whaleFlowAt('BTC', d0), 2)} 期望=${f(per, 2)}`);
  check('9ac② 窗口末日在内（d0 + days − 1 仍计）＋ 窗口外两侧为 0',
    Math.abs(god.whaleFlowAt('BTC', d0 + e0.days - 1) - per) < 1e-6
    && god.whaleFlowAt('BTC', d0 - 1) === 0
    && god.whaleFlowAt('BTC', d0 + e0.days) === 0);
  check('9ac② 买入为正 / 卖出为负（方向性）',
    god.whaleFlowAt('BTC', Math.round((sells[0].t - C.GAME.start) / H / 24)) < 0);
  check('9ac② 非 BTC / 未列出的币 ⇒ 0（本轮只有 BTC）',
    god.whaleFlowAt('ETH', d0) === 0 && god.whaleFlowAt('DOGE', d0) === 0);

  /* ③ 抽查真实披露日 */
  const mstr = god.WHALES.find(e => e.t === Date.UTC(2024, 10, 25));
  check('9ac③ 抽查：MSTR 2024-11-25 单笔 $5.4B / 30 天 / 买入（本表最大买入）',
    !!mstr && mstr.dir === 1 && Math.abs(mstr.usd - 5.40e9) < 1 && mstr.days === 30,
    mstr ? `usd=${f(mstr.usd, 0)} days=${mstr.days}` : '未找到');
  const mtgox = god.WHALES.find(e => e.who.includes('Mt.Gox'));
  check('9ac③ 抽查：Mt.Gox 分发（$8.1B / 120 天 / 卖出，长期分发窗口）',
    !!mtgox && mtgox.dir === -1 && mtgox.days === 120, mtgox ? `days=${mtgox.days}` : '未找到');
  check('9ac③ 刻意排除「查封 ≠ 抛售」：表内无 Silk Road 查封 / Bitfinex 查封两条',
    !god.WHALES.some(e => /Silk Road 案 6|69,370|Bitfinex 9|94,643/.test(e.who)));

  /* ④ 接线：npcBuild 注入 extFlow（whaleFlowAt + etfFlowAt），买加长侧 / 卖加短侧，只给 ≤10x 档 */
  const engSrc9ac = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
  check('9ac④ 接线：npcBuild 读 extFlow = whaleFlowAt + etfFlowAt（按游戏日 dayIndexOf）',
    engSrc9ac.includes('const extFlow = eventsOff(s) ? 0 : (whaleFlowAt(sym, dayIdx) + etfFlowAt(sym, dayIdx));')
    && engSrc9ac.includes('const dayIdx = dayIndexOf(i);'));
  check('9ac④ 注入方式：买加长侧 / 卖加短侧（当根全量入仓 · 与 stepNpc 加仓同一会计），只在 low（≤10x）档',
    engSrc9ac.includes('const buy = (dipBuy + Math.max(0, extFlow)) * w;')
    && engSrc9ac.includes('const sell = Math.max(0, -extFlow) * w;')
    && engSrc9ac.includes('m.npc[k].long = c + buy;')
    && engSrc9ac.includes('m.npc[k].short = c + sell;'));
  check('9ac④ 外部流量只进 NPC 账本（直接入仓），不写玩家痕迹通道 s.flow',
    !/extFlow[\s\S]{0,120}s\.flow/.test(engSrc9ac));
  check('9ac④ god.js 两函数自 god.js 导入引擎',
    /import\s*\{[^}]*whaleFlowAt[^}]*\}\s*from\s*'\.\/god\.js'/.test(engSrc9ac)
    && /import\s*\{[^}]*etfFlowAt[^}]*\}\s*from\s*'\.\/god\.js'/.test(engSrc9ac));

  /* ⑤ 播报：命中披露日那一根 → 含方向；非披露日 → null（日粒度判等 ⇒ 一局一次） */
  const iw = idx(e0.t);
  check('9ac⑤ 披露播报命中披露日那一根、含方向与主体',
    (god.whaleNewsAt(iw) || '').includes('买入') && (god.whaleNewsAt(iw) || '').includes(e0.who),
    god.whaleNewsAt(iw) || 'null');
  check('9ac⑤ 非披露日 ⇒ null（日粒度 floor 判等 ⇒ 一局一次）',
    god.whaleNewsAt(iw + 24) === null && god.whaleNewsAt(idx(at(2013, 5, 1))) === null);
  check('9ac⑤ 接线：advanceOneHour 播报 whaleNewsAt（推入日志）',
    engSrc9ac.includes('const wnews = whaleNewsAt(s.i);')
    && engSrc9ac.includes("if (wnews) pushLog(s, wnews, 'news', 'mkt');"));
}

/* ═══════════════════ 9ad · 现货 ETF 日频净流入（缺口 5 · 2026-10-08） ═══════════════════
   口径：一级市场申赎净额（AP 创设/赎回），月度真数据 ÷ 当月**交易日数** ⇒ 美元/天；
   起用日严格锚在上市首日（BTC 2024-01-11 / ETH 2024-07-23），周末休市一律 0；
   与巨鲸同址注入 `npcBuild` 靶心。 */
section('9ad · 现货 ETF 月度净流入：起用日 ＋ 交易日摊平 ＋ 符号 ＋ 月度播报');
{
  const btc = god.ETF_FLOW.BTC, eth = god.ETF_FLOW.ETH;
  check('9ad① 表结构：BTC 12 条月度 ＋ ETH 6 条月度（只到 2024-12，行程终点 2025-01-01）',
    btc.months.length === 12 && eth.months.length === 6);
  check('9ad① 起用日 = 上市首日：BTC 2024-01-11 / ETH 2024-07-23',
    btc.from === Date.UTC(2024, 0, 11) && eth.from === Date.UTC(2024, 6, 23));
  const dFrom = Math.round((btc.from - C.GAME.start) / H / 24);
  check('9ad① 早于上市首日 ⇒ 0（BTC 起用前一天、ETH 在其后仍 0）',
    god.etfFlowAt('BTC', dFrom - 1) === 0 && god.etfFlowAt('ETH', dFrom + 5) === 0);

  /* ② 交易日摊平：独立复算 2024-11 的周一至周五天数，断言单日 = 月额 ÷ N */
  const weekdaysIn = (y, m, fromMs) => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    let n = 0;
    for (let dd = 1; dd <= last; dd++) {
      const ms = Date.UTC(y, m, dd);
      if (ms < fromMs) continue;
      const w = new Date(ms).getUTCDay();
      if (w !== 0 && w !== 6) n++;
    }
    return n;
  };
  const dNov = Math.round((Date.UTC(2024, 10, 6) - C.GAME.start) / H / 24);   // 2024-11-06（周三）
  const nNov = weekdaysIn(2024, 10, btc.from);
  check('9ad② 摊平逐位：2024-11 工作日单日 = 月额 ÷ 当月交易日数（独立复算 N）',
    Math.abs(god.etfFlowAt('BTC', dNov) - 6.500e9 / nNov) < 1e-6,
    `实得=${f(god.etfFlowAt('BTC', dNov), 2)} 期望=${f(6.500e9 / nNov, 2)} N=${nNov}`);

  /* ③ 周末休市 ⇒ 0（2024-11-09 周六 / 11-10 周日）*/
  const dSat = Math.round((Date.UTC(2024, 10, 9) - C.GAME.start) / H / 24);
  check('9ad③ 周末（美国休市）⇒ 0（周六/周日）',
    god.etfFlowAt('BTC', dSat) === 0 && god.etfFlowAt('BTC', dSat + 1) === 0);

  /* ④ 符号：净流出月 ⇒ 日频为负（4 月 / 8 月 BTC、7 月 ETH） */
  const dApr = Math.round((Date.UTC(2024, 3, 15) - C.GAME.start) / H / 24);
  const dAug = Math.round((Date.UTC(2024, 7, 15) - C.GAME.start) / H / 24);
  const dEthJul = Math.round((Date.UTC(2024, 6, 25) - C.GAME.start) / H / 24);
  check('9ad④ 净流出月 ⇒ 日频为负（4 月 / 8 月 BTC、7 月 ETH）',
    god.etfFlowAt('BTC', dApr) < 0 && god.etfFlowAt('BTC', dAug) < 0 && god.etfFlowAt('ETH', dEthJul) < 0,
    `4月BTC=${f(god.etfFlowAt('BTC', dApr), 0)} 8月BTC=${f(god.etfFlowAt('BTC', dAug), 0)} 7月ETH=${f(god.etfFlowAt('ETH', dEthJul), 0)}`);

  /* ⑤ 自洽：当月每个工作日的日频流量之和 = 月净额 */
  let sum = 0;
  for (let dd = 1; dd <= 30; dd++) {
    const ms = Date.UTC(2024, 10, dd);
    const w = new Date(ms).getUTCDay();
    if (w === 0 || w === 6) continue;
    sum += god.etfFlowAt('BTC', Math.round((ms - C.GAME.start) / H / 24));
  }
  check('9ad⑤ 自洽：2024-11 全月工作日日频之和 = 月净额（+$65 亿）',
    Math.abs(sum - 6.500e9) < 1, `Σ=${f(sum, 0)}`);

  /* ⑥ 播报：每月 1 日播上月净额；非月初 ⇒ null；ETH 上市前的月份只报 BTC */
  const en = god.etfNewsAt(idx(at(2024, 8, 1)));      // 2024-09-01 播 8 月（BTC 净流出）
  check('9ad⑥ 月初播上月净额（含 BTC/ETH 并排与符号）',
    !!en && en.includes('BTC') && en.includes('8 月净流入') && en.includes('−'), en || 'null');
  check('9ad⑥ 非月初 ⇒ null；ETH 上市前的月份只报 BTC（不编 ETH）',
    god.etfNewsAt(idx(at(2024, 1, 15))) === null
    && !(god.etfNewsAt(idx(at(2024, 2, 1))) || '').includes('ETH'),
    god.etfNewsAt(idx(at(2024, 2, 1))) || 'null');

  /* ⑦ 接线 ＋ 不升版本 */
  const engSrc9ad = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
  check('9ad⑦ 接线：advanceOneHour 播报 etfNewsAt（推入日志）',
    engSrc9ad.includes('const enews = etfNewsAt(s.i);')
    && engSrc9ad.includes("if (enews) pushLog(s, enews, 'news', 'mkt');"));
  check('9ad⑦ 不升 STATE_VERSION（纯表 ＋ 纯函数，零新状态）', STATE_VERSION === 32, `v=${STATE_VERSION}`);
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

/* ── d2 · 超额抵押解锁（2026-10-09 用户拍板，推翻 2026-10-05 的「1x 封顶」）：保证金可越过名义，
      保证金率 > 100% 合法（Aave 超额抵押 120–150%、Bybit IM Rate 同款）；借入归零 ⇒ 停息、无强平线。 ── */
{
  const s = await mk({ sym: 'BTC', mode: 'margin', cash: 2e7, i: idx(at(2021, 5)) });
  s.lev = 3;
  const o = engine.openTrade(s, 'long', 0.02);
  const pos = s.positions.BTC;
  check('13d 超额抵押前置：3x 建仓成功', o.ok && !!pos, o.why || '');
  if (pos) {
    check('13d 建仓时实际杠杆 = 3x', Math.abs(P.effLevOf(pos) - 3) < 1e-6, `effLev=${f(P.effLevOf(pos), 4)}`);
    check('13d 建仓时确有利息成本（借入 > 0）',
      P.borrowedOf(pos) > 0 && P.paysInterest(pos), `borrowed=${f(P.borrowedOf(pos), 2)}`);
    /* 连点「+」加到余额耗尽为止 —— 每次都走真实 `marginStepOf` / `adjustMargin`。 */
    let guard = 0;
    while (guard++ < 400) {
      const a = engine.marginStepOf(s, 'BTC', 0.25, true);
      if (!(a > 1e-9)) break;
      if (!engine.adjustMargin(s, 'BTC', a).ok) break;
    }
    const caps = engine.marginCapsOf(s, 'BTC');
    check('13d 越过名义：保证金 > 名义 ⇒ 保证金率 > 100%（超额抵押合法态）',
      pos.margin > pos.notional && P.marginRateOf(pos, engine.exMarkPrice(s, 'BTC', pos.ex)) > 1,
      `margin=${f(pos.margin, 0)} notional=${f(pos.notional, 0)}`);
    check('13d 超额抵押后实际杠杆 < 1x（effLevOf 显示真实值）', P.effLevOf(pos) < 1,
      `effLev=${f(P.effLevOf(pos), 4)}`);
    check('13d 加到余额耗尽后 add 上限 = 0（弹层预设键 / 交易页 ± 键据它置灰）',
      caps.add <= 1e-9, `add=${f(caps.add, 6)}`);
    const r = engine.adjustMargin(s, 'BTC', 1);
    check('13d 余额耗尽后再加被拒，话术是「可用余额不足」（1x 封顶话术已删）',
      !r.ok && /可用余额不足/.test(r.why || ''), r.why || '(未被拒)');
    check('13d 借入归零 ⇒ 停息（不再借钱，利息停）',
      P.borrowedOf(pos) === 0 && !P.paysInterest(pos),
      `borrowed=${f(P.borrowedOf(pos), 6)} interest=${P.paysInterest(pos)}`);
    check('13d 超额抵押后不可强平（无借入 ⇒ 无维持线）', !P.canLiquidate(pos));
    check('13d 超额抵押后仍可减（reduce 正常，回到杠杆态）', caps.reduce > 1e-9,
      `reduce=${f(caps.reduce, 0)}`);
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
  /* 摆好 NPC 账本后**冻结建仓**（npcFreeze，同 §9n）⇒ `tickMarket` 不再改动账本 ⇒ `npcNet` 与池的
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
    /* ⚠️ 缺口 2（2026-10-08）后 `advanceOneHour` 会先跑一次 `markUsdt`（持有 U 的汇率重估）
       —— 它也写 `s.realized` ⇒ 本条断言必须把它单独拎出来，「Δrealized == Δmargin」才成立。
       `markUsdt` 排在 `settleFunding` **之前**（engine 里 `s.i += 1` 之后立刻调）⇒ 用它那一刻
       的持仓量（= 此刻的 `usdtHeldOf`，结算尚未动账）。 */
    const qtyU = usdtHeldOf(s);
    const iN = s.i + 1;
    const markTerm = qtyU * (C.usdtPriceAt(C.GAME.start + iN * H) - C.usdtPriceAt(C.GAME.start + (iN - 1) * H));
    const unfreeze = npcFreeze();
    try { engine.advanceOneHour(s); } finally { unfreeze(); }
    return {
      s, pos, m, rate, npcN, mark, exp, before, markTerm,
      dm: pos.margin - before.margin,                  // 保证金变化（永续仓只受资金费影响）
      df: m.npcFund - before.fund,                     // 对手方池变化
      dr: s.realized - before.realized,                // 已实现盈亏变化（含汇率重估那一项）
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
    check('14b 已实现盈亏同步增加（HUD 副行 / 档案口径与保证金一致，扣掉汇率重估那一项）',
      Math.abs(b.dr - (b.dm + b.markTerm)) < 1e-9, `Δrealized=${f(b.dr, 4)} Δmargin=${f(b.dm, 4)} markU=${f(b.markTerm, 4)}`);
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

/* ── g · 资金曲线裁头 `trimFlatStart`（2026-10-05 用户拍板「只有钱有变化之后才有曲线」）──
   纯函数，Node 可直接导入（chart.js 顶层不碰 DOM；`theme()` 只在被调用时才读 `getComputedStyle`）。
   这里把四个边界钉死：长度不足 / 开局就动 / 观望 N 天后动 / 整场没动 ＋ 浮点容差 ＋ 纯函数。 */
{
  const { trimFlatStart } = await import('../src/ui/chart.js');
  check('14g `trimFlatStart` 已导出', typeof trimFlatStart === 'function');

  /* ① 长度 < 3：无从判「开头有没有平线」⇒ 原样返回同一引用（逐位不变）。 */
  const a0 = [1000, 1000];
  check('14g 长度 < 3 ⇒ 原样返回（同一引用）', trimFlatStart(a0) === a0);

  /* ② 开局第 1 点就与首点不同（`k === 1`，首点与其自身恒等故 `k` 至少为 1）⇒ 一个点都不裁。 */
  const a1 = [1000, 1200, 1100];
  check('14g 开局就动（k=1）⇒ 原样返回', trimFlatStart(a1) === a1);

  /* ③ 观望 3 天后才动 ⇒ 从首个不同点的**前一点**切起（保留起笔点，曲线仍从基准线上起笔）。 */
  const a2 = [1000, 1000, 1000, 1200, 900];
  const r2 = trimFlatStart(a2);
  check('14g 观望 N 天后动 ⇒ 裁到 k-1（保留紧邻的起笔点）',
    r2.length === 3 && r2[0] === 1000 && r2[1] === 1200 && r2[2] === 900,
    `len=${r2.length} ${JSON.stringify(r2)}`);

  /* ④ 整场一单没开 ⇒ 全段都等于本金，没有「起笔之后」⇒ 原样返回一条平线。 */
  const a3 = [1000, 1000, 1000, 1000];
  check('14g 整场没动过 ⇒ 原样返回（那种局本就该是一条平线）', trimFlatStart(a3) === a3);

  /* ⑤ 浮点容差：差额小于 `CURVE_FLAT_EPS` 仍算「没动」，不吃浮点误差。 */
  const a4 = [1000, 1000 + 1e-12, 1000, 900];
  const r4 = trimFlatStart(a4);
  check('14g 首段浮点噪声不计入「已动」（容差）',
    r4.length === 2 && r4[0] === 1000 && r4[1] === 900,
    `len=${r4.length} ${JSON.stringify(r4)}`);

  /* ⑥ 纯函数：`slice` 出新数组，入参一个字节都不动。 */
  const a5 = [1000, 1000, 1200];
  trimFlatStart(a5);
  check('14g 纯函数：不改入参（slice 出新数组）',
    a5.length === 3 && a5[0] === 1000 && a5[1] === 1000 && a5[2] === 1200);

  /* ⑦⑧ 两处画曲线的接入点（同一局在哪儿看都是同一段）—— 防回归删除。 */
  const chartSrc = fs.readFileSync(path.join(ROOT, 'src/ui/chart.js'), 'utf8');
  const shareSrc = fs.readFileSync(path.join(ROOT, 'src/ui/shareCard.js'), 'utf8');
  check('14g 源码锚点：`curveWindow` **先切窗、后裁头**（顺序不能反）',
    /const win = from > 0 \? src\.slice\(from\) : src;[\s\S]{0,80}?const eq = trimFlatStart\(win\);/.test(chartSrc));
  check('14g 源码锚点：生涯海报接入同一裁剪',
    /trimFlatStart\(Array\.isArray\(rec\.eq\)/.test(shareSrc));
}

/* ── h · 配色收口（2026-10-05 用户圈定清单）—— 全部只是源码锚点，防回归删除 ──
   ① K 线三处彩色签的**文字色**改走 `--on-*`（原来硬编码在绘制处，主题改了不跟）；
   ② 复盘页日志条补齐「六类芯片」——它是三处日志入口里最后一个跟上的；
   ③ 海报交易明细首行「胜 / 负 / 胜率」按涨跌色**分段**上色。 */
{
  const chartSrc = fs.readFileSync(path.join(ROOT, 'src/ui/chart.js'), 'utf8');
  const reviewSrc = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
  const shareSrc = fs.readFileSync(path.join(ROOT, 'src/ui/shareCard.js'), 'utf8');

  /* ① 硬编码值必须已从**绘制语句**里消失（注释里留个读数不算）。 */
  check('14h K 线：开仓价签文字色不再硬编码 `#1a1405`，改走 `T.ON_GOLD`',
    !/ctx\.fillStyle\s*=\s*'#1a1405'/.test(chartSrc) && /T\.ON_GOLD/.test(chartSrc));
  check('14h K 线：强平价签文字色不再硬编码 `#1a0508`，改走 `T.ON_DOWN`',
    !/ctx\.fillStyle\s*=\s*'#1a0508'/.test(chartSrc) && /T\.ON_DOWN/.test(chartSrc));
  check('14h K 线：现价签文字色按涨跌取 `T.ON_UP` / `T.ON_DOWN`',
    /col === T\.UP \? T\.ON_UP : T\.ON_DOWN/.test(chartSrc));
  check('14h K 线：`--on-*` 三枚 token 已进 `THEME_VARS`',
    /ON_GOLD: '--on-gold'/.test(chartSrc) && /ON_DOWN: '--on-down'/.test(chartSrc)
    && /ON_UP: '--on-up'/.test(chartSrc));

  /* ② 复盘页日志：旧的**单色**写法必须已删除，改与浮层同款（类别芯片 ＋ 色条）。 */
  check('14h 复盘页日志：旧版按 `kind` 单色渲染的写法已删除',
    !/log-row ' \+ \(e\.kind === 'bad'/.test(reviewSrc));
  check('14h 复盘页日志：补上类别芯片 `log-tag`', /el\('i', `log-tag \$\{tg\}`/.test(reviewSrc));

  /* ③ 海报明细：按段数组 `segsA` ＋ 逐段上色（`statA` 由各段 join 出，两处不漂字）。 */
  check('14h 海报明细：首行按段上色（`segsA`）且 `statA` 由各段拼出',
    /const segsA = \[/.test(shareSrc) && /segsA\.map\(\(\[txt\]\) => txt\)\.join\(''\)/.test(shareSrc)
    && /for \(const \[txt, cls\] of segsA\)/.test(shareSrc));
}

/* ── i · 资金曲线纵轴范围 `curveRange`（2026-10-05 用户反馈「资金量大时短区间是一条贴顶直线」）──
   `drawEquityCurve` 取的窗口就是「已按 `range` 切片 ＋ 已裁掉观望期平线」的那一段，纵轴整块
   由这个纯函数算。这里用真实数值把「按窗口自适应、区间一换整条重算」钉死。 */
{
  const { curveRange } = await import('../src/ui/chart.js');
  const lg = v => Math.log10(Math.max(1, v));

  /* ① 资金 $1M、一周窗口只在 ±3.5% 内波动：本金（$1,000）必须**被排除**，纵轴按窗口铺满。 */
  const eqA = [1e6, 950000, 1020000, 990000, 1005000];
  const A = curveRange(eqA, 1000);
  const spanA = lg(Math.max(...eqA)) - lg(Math.min(...eqA));
  check('14i 大资金 + 窄窗口 ⇒ 本金被排除、纵轴按窗口铺满（不再横跨 3 个数量级）',
    A.baseIn === false && (A.hi - A.lo) < 0.1 && (A.hi - A.lo) < spanA * 1.3,
    `baseIn=${A.baseIn} 纵轴跨度=${f(A.hi - A.lo, 4)} 数据跨度=${f(spanA, 4)}`);
  check('14i 窗口波动占可见高度 > 70%（高/低点因此看得见）',
    spanA / (A.hi - A.lo) > 0.7, `占比=${f(spanA / (A.hi - A.lo), 3)}`);

  /* ② 贴近本金的窄窗口（$1,000 → $1,050）：本金并入，且纵轴**不再被旧的 0.1 下限钉住**。 */
  const B = curveRange([1000, 1020, 1050], 1000);
  check('14i 贴近本金的窄窗口 ⇒ 本金并入，纵轴跨度 < 0.05（旧 0.1 下限会把 +5% 压平）',
    B.baseIn === true && (B.hi - B.lo) < 0.05 && B.lo <= lg(1000) && B.hi >= lg(1050),
    `baseIn=${B.baseIn} 纵轴跨度=${f(B.hi - B.lo, 4)}`);

  /* ③ 全程一条平线（一单没开）⇒ 仍撑开极小一档，避免除 0；上下界有限。 */
  const C = curveRange([1000, 1000, 1000], 1000);
  check('14i 平线窗口 ⇒ 撑开极小一档（有限、非 0）',
    Number.isFinite(C.lo) && Number.isFinite(C.hi) && C.hi > C.lo && (C.hi - C.lo) < 1e-6,
    `lo=${f(C.lo, 8)} hi=${f(C.hi, 8)}`);

  /* ④ 接入锚点：`drawEquityCurve` 必须走它（防回归成「又写回 lg(base) 起手」）。 */
  const chartSrc = fs.readFileSync(path.join(ROOT, 'src/ui/chart.js'), 'utf8');
  check('14i 源码锚点：`drawEquityCurve` 纵轴走 `curveRange`、不再从 `lg(base)` 起手',
    /const \{ lo, hi, baseIn \} = curveRange\(eq, o\.base\)/.test(chartSrc)
    && !/let lo = lg\(o\.base\)/.test(chartSrc));
  check('14i 源码锚点：本金基准虚线只在 `baseIn` 为真时才画',
    /if \(baseIn\) \{[\s\S]*?yOf\(o\.base\)/.test(chartSrc));
}

/* ── j · 资金曲线展示窗口 `curveWindow`（2026-10-05 用户拍板「只加起止日期」）──
   它是**唯一真相源**：`drawEquityCurve`（画的那条线）与资产页那行「起 → 止 · N 天」说明行共用它
   ⇒ 画的段与写的段永远同一段。这里把「切窗 ＋ 裁头」两动作的组合边界钉死，并断言
   `all[first] === eq[0]`（说明行换算日期就靠 `first` 这个下标）。 */
{
  const { curveWindow } = await import('../src/ui/chart.js');
  check('14j `curveWindow` 已导出', typeof curveWindow === 'function');

  /* ① range = 0 ⇒ 全段；开局就动（k=1）⇒ 不裁，first = 0。 */
  const all1 = [1000, 1200, 1300, 1400];
  const w1 = curveWindow(all1, 0);
  check('14j range=0 ⇒ 取全段、first=0',
    w1.eq.length === 4 && w1.first === 0 && w1.eq[0] === all1[0],
    `len=${w1.eq.length} first=${w1.first}`);

  /* ② 全段带观望平线：裁到首个不同点的前一点；`first` 指向 `all` 中该点的下标。 */
  const all2 = [1000, 1000, 1000, 1200, 1300, 1400];
  const w2 = curveWindow(all2, 0);
  check('14j 全段裁头 ⇒ 保留起笔点、first 指向 `all` 中该点',
    w2.eq.length === 4 && w2.first === 2 && all2[w2.first] === w2.eq[0] && w2.eq[1] === 1200,
    `len=${w2.eq.length} first=${w2.first}`);

  /* ③ range 切窗后再裁窗内开头的观望期 —— **只看窗内**，不吃窗口外的平线。 */
  const all3 = [1000, 1000, 1000, 1500, 1500, 1600];
  const w3 = curveWindow(all3, 3);
  check('14j 切窗后裁窗内观望期（不吃窗口外的平线）',
    w3.eq.length === 2 && w3.eq[0] === 1500 && w3.eq[1] === 1600 && w3.first === 4
    && all3[w3.first] === w3.eq[0],
    `len=${w3.eq.length} first=${w3.first} ${JSON.stringify(w3.eq)}`);

  /* ④ range 大于长度 ⇒ 退化成全段（`from` 夹到 0），不应出现负下标。 */
  const w4 = curveWindow(all1, 999);
  check('14j range > 长度 ⇒ 退化为全段（first 不为负）',
    w4.eq.length === 4 && w4.first === 0);

  /* ⑤ 窗口内仍平线（一单没动）⇒ 原样一条平线（不是「空」），first 指向窗口首点。 */
  const all5 = [1000, 1000, 1000, 1000, 1000];
  const w5 = curveWindow(all5, 2);
  check('14j 窗口内全程平线 ⇒ 仍返回该窗口（不是空）',
    w5.eq.length === 2 && w5.first === 3 && all5[w5.first] === w5.eq[0]);

  /* ⑥ 非数组入参：不抛错，返回空窗。 */
  const w6 = curveWindow(undefined, 7);
  check('14j 非数组入参 ⇒ 返回空窗（不抛错）', w6.eq.length === 0 && w6.first === 0);

  /* ⑦ 纯函数：入参一个字节都不动（切窗 / 裁头都走新数组）。 */
  const all7 = [1000, 1000, 1200, 1300];
  curveWindow(all7, 3);
  check('14j 纯函数：不改入参',
    all7.length === 4 && all7[0] === 1000 && all7[1] === 1000 && all7[2] === 1200 && all7[3] === 1300);

  /* ⑧⑨ 两处接入点：canvas 绘制与资产页说明行**共用**同一个 `curveWindow`（防回归各写一份）。 */
  const chartSrc = fs.readFileSync(path.join(ROOT, 'src/ui/chart.js'), 'utf8');
  const renderSrc = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
  check('14j 源码锚点：`drawEquityCurve` 的窗口走 `curveWindow(all, …)`',
    /const \{ eq \} = curveWindow\(all, Number\(o\.range\) \|\| 0\)/.test(chartSrc));
  check('14j 源码锚点：资产页说明行与绘制共用 `curveWindow(s.eq, view.eqRange)`',
    /curveWindow\(s\.eq, view\.eqRange\)/.test(renderSrc)
    && /curve-cap/.test(renderSrc));
}

/* ── k · 细节修复（2026-10-05 用户圈定清单）──────────────────────────────
   ① 档案头行「永不换行」＋ 武装文案与「删除」等宽；
   ② K 线极小价标签（PAD_R 56 ＋ 轴签 10px）装得下 8 字符；
   ③ 极小价格式化收成 6 位小数（≤8 字符），不再被持仓行 ellipsis 啃尾；
   ④ 破产局「倍数」改报**峰顶倍数**（不再印 ×0.00 坏值）；
   ⑤ 海报明细补「平仓 M 笔」口径。
   ⚠️ ①②⑤ 只能做源码锚点（CSS / 绘制 / 版面，Node 里量不到像素）；③④ 是纯函数，跑真实取值。 */
{
  /* ① CSS：头行三道锁 ＋ 二次确认弹层不折行 */
  const css = fs.readFileSync(path.join(ROOT, 'src/ui/style.css'), 'utf8');
  check('14k 档案头行 `white-space: nowrap`（六元素同排不折行）',
    /\.career-head \{[^}]*white-space: nowrap/.test(css));
  check('14k 档案「终值 ＋ 倍数」行 `white-space: nowrap`（改报「峰值 ×N」后同锁不折行）',
    /\.career-num \{[^}]*white-space: nowrap/.test(css));
  check('14k 档案头行称号 / 风格可截尾（`min-width:0` ＋ ellipsis）',
    /\.career-title \{[^}]*min-width: 0[^}]*text-overflow: ellipsis/.test(css)
    && /\.career-style \{[^}]*min-width: 0[^}]*text-overflow: ellipsis/.test(css));
  check('14k 档案头行的局名 / 结局 / 两枚键 `flex:none`（永不被挤窄）',
    /\.career-head b \{[^}]*flex: none/.test(css)
    && /\.career-head u \{[^}]*flex: none/.test(css)
    && /\.career-del \{[^}]*flex: none/.test(css)
    && /\.career-share \{[^}]*flex: none/.test(css));
  check('14k 二次确认弹层行 `white-space: nowrap`',
    /\.confirm-row \{[^}]*white-space: nowrap/.test(css));

  /* ② 武装文案收成「确认」：与「删除」同为 2 汉字 ⇒ 武装前后零位移 */
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  check('14k 武装文案收成「确认」（2 汉字，与「删除」等宽 ⇒ 零位移）',
    /node\.textContent = '确认';/.test(mainSrc) && !/node\.textContent = '确认删除';/.test(mainSrc));

  /* ③ K 线：PAD_R 56 ＋ 轴签 / 三处价签 10px ⇒ 8 字符（`0.000089`）装得下 */
  const chartSrc = fs.readFileSync(path.join(ROOT, 'src/ui/chart.js'), 'utf8');
  check('14k 源码锚点：`PAD_R` 加宽到 56', /export const PAD_R = 56;/.test(chartSrc));
  check('14k 源码锚点：轴签 / 开仓签 / 强平签 / 现价签统一 10px（≥4 处）',
    (chartSrc.match(/'10px ui-monospace, monospace'/g) || []).length >= 4,
    `${(chartSrc.match(/'10px ui-monospace, monospace'/g) || []).length} 处`);
  /* 像素账：10px 等宽 ≈ 6px/字 ⇒ 8 字符 48px ≤ 可用 `PAD_R − 6 = 50px`。 */
  const avail = 56 - 6, labelW = 8 * 10 * 0.6;
  check('14k 极小价标签（8 字符）塞得进右侧标签位', labelW <= avail, `label=${labelW} avail=${avail}`);

  /* ④ 极小价格式化：`0.000089` 必须恰好 8 字符（旧口径是 10 字符的 `0.00008900`） */
  check('14k `fmtLogPrice` 极小价完整且 ≤8 字符（DOGE 级）',
    F.fmtLogPrice(0.000089) === '0.000089', F.fmtLogPrice(0.000089));
  /* 上沿：`[1e-4, 1e-2)` 那一档本来就是 6 位 —— 两档并档后接口连续、不跳字符数。 */
  check('14k 极小价与上一档口径连续（`0.000123` 恒 8 字符）',
    F.fmtLogPrice(0.000123) === '0.000123' && F.fmtLogPrice(0.000123).length === 8,
    F.fmtLogPrice(0.000123));

  /* ⑤ 倍数：破产 / 近乎归零 ⇒ 改报峰顶倍数（档案页 ＋ 海报共用 `multShown`） */
  const T = await import('../src/core/titles.js');
  const mrec = (o) => ({ cash0: 1000, final: 2000, peak: 3000, reason: engine.OVER.SETTLED, ...o });
  const ok = T.multShown(mrec({}));
  check('14k 结算局倍数 = `final / cash0`（正常档不带「峰值」前缀）',
    ok.peak === false && Math.abs(ok.v - 2) < 1e-9, `v=${ok.v} peak=${ok.peak}`);
  const bust = T.multShown(mrec({ reason: engine.OVER.LIQUIDATED, final: 0, peak: 47000 }));
  check('14k 破产局改报峰顶倍数（`峰值 ×47`，不再印 ×0.00）',
    bust.peak === true && Math.abs(bust.v - 47) < 1e-9, `v=${bust.v} peak=${bust.peak}`);
  const near = T.multShown(mrec({ final: 5, peak: 900 }));      // 终值仅剩 0.5% 本金
  check('14k 兜底：终值 ≤ 本金 1% 的结算局也改报峰顶（避开 ×0.00 坏值）',
    near.peak === true && Math.abs(near.v - 0.9) < 1e-9, `v=${near.v} peak=${near.peak}`);
  const justAbove = T.multShown(mrec({ final: 20, peak: 900 })); // 2% 本金 ⇒ 门槛之上，仍报终值
  check('14k 门槛之上（终值 2% 本金）仍报终值倍数（不误触发峰顶）',
    justAbove.peak === false && Math.abs(justAbove.v - 0.02) < 1e-9, `peak=${justAbove.peak}`);

  /* ⑥ 两处接入点 ＋ 海报明细补「平仓 M 笔」（防回归各写一份 / 又被删掉） */
  const shareSrc = fs.readFileSync(path.join(ROOT, 'src/ui/shareCard.js'), 'utf8');
  const renderSrc = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
  check('14k 海报 / 档案倍数共用 `multShown`（同一局两处口径一致）',
    /multShown\(rec\)/.test(shareSrc) && /multShown\(r\)/.test(renderSrc)
    && !/multOf/.test(shareSrc) && !/multOf/.test(renderSrc));
  check('14k 海报明细补「平仓 M 笔」口径（开仓 ≠ 平仓，摆在明面）',
    /平仓 \$\{closed\} 笔/.test(shareSrc));
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

/* ═══════════ 16 · 归零门槛「无死区」（2026-10-05 · 10U 战神 ＋ 无力开仓） ═══════════ */
section('16 · 归零门槛无死区（同源判据 · 门槛处恰好翻转 · 公开路径实证）');
{
  /* 用户诉求（原话）：「假设玩家提前平仓，但是资金已不足以开仓，如何解决？……不要有缺口，
     不能有缺口，不允许有缺口」。本节把「缺口宽度 = 0」变成可执行断言 —— 三件事：
       ① `engine.ruinFloorOf` 复算 == 两条可用通道各按**上限杠杆**算出的 `openNeedAt` 取更低者；
       ② 在门槛处**真实开仓闸门**（`canOpenAt`）恰好翻转：门槛上开得出、门槛下开不出（二分实证）；
       ③ 走**公开时钟路径**（`advanceOneHour`；无持仓 ⇒ 末尾无条件 `checkRuin`）实证：
         权益落在门槛下 ⇒ 判归零；落在门槛上 ⇒ 不判。
     ⚠️ 门槛公式 = `max($1, 最小名义) × (1 / 杠杆 + 开仓费率)`（**含开仓费**）。 */
  const setCash = (s, cash) => {
    const cur = C.cashCurAt(engine.timeOf(s));
    s.books[s.ex] = cur === 'usd' ? { usd: cash, usdt: 0 } : { usd: 0, usdt: cash };
  };
  /* 复算门槛（用 config 的基本件独立再算一遍，**不调** `ruinFloorOf`）——「同源」的可证伪版本。 */
  const floorFromPrimitives = (s, ex, t) => {
    let mn = Infinity;
    for (const k of ['margin', 'fut']) {
      if (!C.hasLeverageKindAt(t, ex, k)) continue;
      const need = C.openNeedAt(ex, t, k, C.maxLeverageAt(t, ex, k), engine.vol30Of(s, ex, s.i, k));
      if (need < mn) mn = need;
    }
    return Number.isFinite(mn) ? mn : C.MIN_NOTIONAL;
  };
  /* ⚠️ 探针口径（这一版踩过的坑，留档）：
     ① **不能用「大资金」当探针**（`cash = $1e6`）—— 早期 Bitfinex 的**借贷额度上限**是
        `当日流动性 × MARGIN.quota`，$1e6 × 3.3x 在 2013 年当场被它挡住 ⇒ 一个小时也扫不到。
     ② **不能用「全局门槛」当那一档的翻转点** —— 全局门槛取两条通道的**更低者**（如 Binance
        2021 是合约 $0.042），而 `margin` 模式自己的门槛是 $2.01（最小名义 $10 ÷ 5x）⇒
        在 $0.042 附近二分只会得到「两档都开不出」，探针看起来像「引擎有缺口」，其实是**探针错了**。
     ⇒ 正解：每个通道各按**自己**的 `openNeedAt(ex, t, kind, 该通道上限杠杆)` 取一档，
        并在一根「只有资金闸门在拦路」的小时上做二分（用 `openTrade` 的失败文案认闸门：
        `下单金额太小` ⇒ 这一根的拦路者正是资金闸门；停机 / 极端行情 / 借贷额度 ⇒ 换下一根）。 */
  const kindNeedAt = (s, kind) => {
    const t = engine.timeOf(s);
    if (!C.hasLeverageKindAt(t, s.ex, kind)) return null;
    const lev = Math.max(1, C.maxLeverageAt(t, s.ex, kind));
    s.lev = lev;
    return C.openNeedAt(s.ex, t, kind, lev, engine.vol30Of(s, s.ex, s.i, kind));
  };

  for (const sc of C.SCENARIOS) {
    for (const kind of ['margin', 'fut']) {
      const t0 = C.GAME.start + C.scenarioStartIndex(sc.id) * H;
      /* 该局开局那一刻**这条通道根本不存在** ⇒ 它不是一个选项：`ruinFloorOf` 跳过它，
         这里也不断言（旧式会在这里凭空造一个 $1 门槛，那正是被修的缺口之一）。 */
      if (!(C.hasLeverageKindAt(t0, sc.ex, kind) && (C.exchangeOf(sc.ex)?.open ?? Infinity) <= t0)) continue;
      const tag = `${sc.id}/${kind}`;

      /* ① 同源：门槛 == 独立复算 */
      const s1 = await mk({ scen: sc.id, mode: kind });
      s1.hintOn = false;
      s1.lev = Math.max(1, C.maxLeverageAt(t0, sc.ex, kind));
      const F = engine.ruinFloorOf(s1);
      const expect = floorFromPrimitives(s1, sc.ex, t0);
      check(`16a 门槛同源 ${tag}`, Math.abs(F - expect) <= 1e-12 * Math.max(1, F),
        `floor=${f(F, 8)} 复算=${f(expect, 8)}`);

      /* ② 门槛处恰好翻转（纯闸门二分）：`canOpenAt` 的翻转点 == 该通道自己的门槛。 */
      const s2 = await mk({ scen: sc.id, mode: kind });
      s2.hintOn = false;
      let chI2 = null, need2 = 0, lastWhy = '';
      for (let k = 0; k < 240 && s2.i < s2.endI - 1; k++) {
        const need = kindNeedAt(s2, kind);
        if (need != null) {
          setCash(s2, need * 0.5);
          const rLow = engine.openTrade(s2, 'long', 1);   // 0.5×门槛 ⇒ 必被资金闸门拒（失败路径不动状态）
          setCash(s2, need * 2);
          const hiOk = engine.canOpenAt(s2, 'long', 1);
          if (!rLow.ok && hiOk) { chI2 = s2.i; need2 = need; break; }
          lastWhy = rLow.ok ? '0.5×门槛竟然开得出（门槛算错）'
            : `${String(rLow.why).split(' ')[0]}${hiOk ? '' : ' ／ 2×门槛也不可开'}`;
        }
        engine.advanceOneHour(s2);
        if (s2.over || s2.pending) break;
      }
      if (chI2 == null) {
        check(`16b 探针小时可用 ${tag}`, false, `240 小时内找不到「只有资金闸门在拦路」的小时（最后一根：${lastWhy}）`);
        continue;
      }
      setCash(s2, need2 * 0.5);
      const lowOk = engine.openTrade(s2, 'long', 1).ok;   // 失败路径不动状态
      setCash(s2, need2 * 2);
      const highOk = engine.canOpenAt(s2, 'long', 1);
      check(`16b 探针小时：0.5×门槛被拒、2×门槛可开 ${tag}`, lowOk === false && highOk === true,
        `i=${chI2} need=${f(need2, 8)} 半档=${lowOk} 双档=${highOk}`);
      let lo = need2 * 0.5, hi = need2 * 2;
      for (let n = 0; n < 80; n++) {
        const mid = (lo + hi) / 2;
        setCash(s2, mid);
        if (engine.canOpenAt(s2, 'long', 1)) hi = mid; else lo = mid;
      }
      check(`16b 门槛处恰好翻转 ${tag}`,
        Math.abs(hi - need2) <= 1e-12 * Math.max(1, need2),
        `flip=${f(hi, 10)} 门槛=${f(need2, 10)} 相对差=${((hi - need2) / Math.max(1, need2)).toExponential(2)}`);
      setCash(s2, need2 * (1 + 1e-9));
      const justAbove = engine.canOpenAt(s2, 'long', 1);
      setCash(s2, need2 * (1 - 1e-9));
      const justBelow = engine.canOpenAt(s2, 'long', 1);
      check(`16b 门槛上下一线之差翻转 ${tag}`, justAbove === true && justBelow === false,
        `上=${justAbove} 下=${justBelow}`);

      /* ③ 公开路径：无持仓 ＋ `advanceOneHour` ⇒ `liquidateAll` 末尾无条件 `checkRuin`。
         ⚠️ `s.hintOn = false` 关掉「破产预警遮罩」—— 否则它抢先把 `s.pending` 置成 `'warn'`，
            `checkRuin` 的幂等闸会直接返回，探针就测不到东西（那是遮罩流程、不是缺口）。 */
      const chI = chI2;
      const s3 = await mk({ scen: sc.id, mode: kind, i: chI });
      s3.hintOn = false;
      s3.lev = Math.max(1, C.maxLeverageAt(engine.timeOf(s3), sc.ex, kind));
      const iBase = s3.i;
      s3.i = iBase + 1;
      const F3 = engine.ruinFloorOf(s3);          // 判定发生在**下一根**小时，门槛取那一根
      s3.i = iBase;
      /* ⚠️ 用**美元**（面值 ≡ 市值）而不是 `setCash`：缺口 2 后 `equity` 按市值重估现金，
         `setCash` 在 2014-10 之后的年代把现金放进 U 那一格 ⇒ 权益还会乘上当时的 USDT 汇率，
         而这里的探针要的是**美元门槛的 ±1e-6 精确边界**（汇率那一层由 9ab 单独锚定）。 */
      s3.books[s3.ex] = { usd: F3 * (1 - 1e-6), usdt: 0 };
      engine.advanceOneHour(s3);
      const belowRuined = s3.pending === 'loan' || !!s3.over;
      check(`16c 低于门槛 ⇒ 判归零（公开路径）${tag}`, belowRuined,
        `cash=${f(F3 * (1 - 1e-6), 8)} floor=${f(F3, 8)} pending=${s3.pending} over=${s3.over ? s3.over.reason : 'null'}`);

      const s4 = await mk({ scen: sc.id, mode: kind, i: chI });
      s4.hintOn = false;
      s4.lev = Math.max(1, C.maxLeverageAt(engine.timeOf(s4), sc.ex, kind));
      s4.i = iBase + 1;
      const F4 = engine.ruinFloorOf(s4);
      s4.i = iBase;
      s4.books[s4.ex] = { usd: F4 * (1 + 1e-6), usdt: 0 };
      engine.advanceOneHour(s4);
      check(`16c 高于门槛 ⇒ 不判 ${tag}`, !s4.pending && !s4.over,
        `cash=${f(F4 * (1 + 1e-6), 8)} floor=${f(F4, 8)} pending=${s4.pending} over=${s4.over ? s4.over.reason : 'null'}`);
    }
  }

  /* 16d · 开局校验（10U 战神：本金低于 1x 门槛 ⇒ 开局自动拉满该通道杠杆）。 */
  {
    const t0 = C.GAME.start + C.scenarioStartIndex('degen') * H;
    const levMax = C.maxLeverageAt(t0, 'binance', 'margin');
    const need1x = C.openNeedAt('binance', t0, 'margin', 1);
    const dg = createState('degen');
    check('16d 10U 战神：本金确实低于 1x 最小一单门槛（否则无需自动拉杠杆）',
      need1x > 10, `1x门槛=${f(need1x, 4)} 本金=10`);
    check('16d 10U 战神：开局杠杆 = 该所杠杆上限（自动拉满）',
      dg.lev === levMax, `lev=${dg.lev} 上限=${levMax}`);
    const sd = await mk({ scen: 'degen' });
    check('16d 10U 战神：开局 `canOpenAt` 为真（开局就能开仓，无死局）',
      engine.canOpenAt(sd, 'long', 1),
      `cash=${f(engine.equity(sd), 4)} floor=${f(engine.ruinFloorOf(sd), 6)} lev=${sd.lev}`);
    const cl = createState('classic');
    check('16d classic：开局杠杆仍为 1（逐位不变）', cl.lev === 1, `lev=${cl.lev}`);
  }

  /* 16e · 四类「小时内立即判定」各一条真实行为断言（不是读源码，是走真路径）。
     ⚠️ 这四类在改动前只有「下一根 K 线」才兜住 ⇒ 存在最长 1 小时的死区。 */
  {
    /* ① 开仓费：现金恰在门槛上 ⇒ 付掉开仓费后权益当场掉到门槛下。
       用 Bitfinex 2013 开局那一刻（唯一可用通道 = 杠杆，行情闸门全开）。 */
    const s = await mk({ scen: 'classic', mode: 'margin' });
    s.hintOn = false;
    s.lev = Math.max(1, C.maxLeverageAt(engine.timeOf(s), s.ex, 'margin'));
    const F = engine.ruinFloorOf(s);
    setCash(s, F * (1 + 1e-9));
    const r = engine.openTrade(s, 'long', 1);
    check('16e ①开仓费压到门槛下 ⇒ 当场判归零（开仓本身成功）',
      r.ok && (s.pending === 'loan' || !!s.over),
      `ok=${r.ok} pending=${s.pending} over=${s.over ? s.over.reason : 'null'} 权益=${f(engine.equity(s), 8)} floor=${f(F, 8)}`);
  }
  {
    /* ② 换所费：把钱搬到只剩手续费那么多 ⇒ 转账后新所余额近 0。 */
    const s = await mk({ scen: 'classic', mode: 'margin', i: idx(at(2017, 9, 1)) });
    s.hintOn = false;
    const plan = engine.transferPlan(s, 'binance');
    setCash(s, plan.fee + 0.01);
    const r = engine.switchExchange(s, 'binance');
    check('16e ②换所费压到门槛下 ⇒ 当场判归零（转账本身已发起）',
      r.ok && r.why == null && (s.pending === 'loan' || !!s.over),
      `ok=${r.ok} why=${r.why || '—'} fee=${f(plan.fee, 4)} 权益=${f(engine.equity(s), 6)} pending=${s.pending} over=${s.over ? s.over.reason : 'null'}`);
  }
  {
    /* ③ 买 U 溢价：**换汇本身不产生价差**（缺口 2 · 2026-10-08 市值口径）。
       ⚠️ 旧断言「溢价买入当场结账 ⇒ 权益掉到门槛下、判归零」**已被推翻** —— 那正是旧口径
          （`s.realized += got − usd`）的问题：它把溢价当成即时亏损、且让折价买入变成无风险套利。
          现在 `equity` 按市值重估（`qty × p ≡ usd`）⇒ 权益守恒、不误判归零；盈亏改由持有期
          `markUsdt` 逐小时结（9ab 有逐位锚定）。 */
    let iU = null;
    for (let i = idx(C.USDT_LIVE) + 1; i < idx(at(2024, 1, 1)); i += 3) {
      if (C.usdtPriceAt(C.GAME.start + i * H) > 1.005) { iU = i; break; }
    }
    check('16e ③前置：时间轴上确有「买 U 溢价」的小时（> $1.005）', iU != null, `i=${iU}`);
    if (iU != null) {
      const s = await mk({ scen: 'classic', mode: 'margin', i: iU });
      s.hintOn = false;
      s.books[s.ex] = { usd: 50000, usdt: 0 };
      const price = C.usdtPriceAt(engine.timeOf(s));
      const before = engine.equity(s);
      const r = engine.buyUsdt(s, 1);
      const after = engine.equity(s);
      check('16e ③买 U 溢价 ⇒ 权益守恒（|Δ| < 1e-6）、不误判归零（换汇不产生价差）',
        r.ok && Math.abs(after - before) < 1e-6 && !s.pending && !s.over,
        `ok=${r.ok} 前=${f(before, 8)} 后=${f(after, 8)} 汇率=${f(price, 4)} pending=${s.pending}`);
    }
  }
  {
    /* ④ 减少保证金：纯资金腾挪 ⇒ 权益不变 ⇒ **不许**误判归零（防假阳性）。 */
    const s = await mk({ scen: 'classic', mode: 'margin', cash: 1e5, i: idx(at(2021, 5, 1)) });
    s.hintOn = false;
    s.lev = 1;
    const o = engine.openTrade(s, 'long', 1);
    const caps = o.ok ? engine.marginCapsOf(s, 'BTC') : null;
    const red = caps && caps.reduce > 0 ? Math.min(caps.reduce, s.positions.BTC.margin * 0.25) : 0;
    const r = red > 0 ? engine.adjustMargin(s, 'BTC', -red) : { ok: false };
    check('16e ④减少保证金不误判归零（权益不变 ⇒ 不触发）',
      o.ok && red > 0 && r.ok && !s.pending && !s.over,
      `开仓=${o.ok} 可减=${f(red, 2)} 调整=${r.ok} pending=${s.pending} over=${s.over ? s.over.reason : 'null'}`);
  }

  /* 16f · 两句话的自适应文案（与 `isBankrupt` 同一把尺子）。 */
  {
    const s = await mk({ scen: 'classic', mode: 'margin' });
    setCash(s, 0);
    check('16f 权益 ≤ 0 ⇒「账户归零」', engine.ruinLabelOf(s) === '账户归零', `eq=${f(engine.equity(s), 6)}`);
    const s2 = await mk({ scen: 'classic', mode: 'margin' });
    s2.hintOn = false;
    s2.lev = Math.max(1, C.maxLeverageAt(engine.timeOf(s2), s2.ex, 'margin'));
    setCash(s2, engine.ruinFloorOf(s2) * 0.5);
    check('16f 权益 > 0 但低于门槛 ⇒「无力开仓」',
      engine.equity(s2) > 0 && engine.ruinLabelOf(s2) === '无力开仓',
      `eq=${f(engine.equity(s2), 8)} floor=${f(engine.ruinFloorOf(s2), 8)}`);
  }

  /* 16g · 源码 / 导出锚点（防回归删除）：三处共用同一个式子，缺一即拆掉「同源」。 */
  {
    check('16g 锚点：`config.openNeedAt` 已导出（门槛 / 开局校验 / 审计三处共用的那个式子）',
      typeof C.openNeedAt === 'function');
    const src = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
    check('16g 锚点：`engine.ruinFloorOf` 与 `engine.ruinLabelOf` 均已导出',
      /export const ruinFloorOf/.test(src) && /export const ruinLabelOf/.test(src));
    const hits = (src.match(/checkRuin\(s\);/g) || []).length;
    check('16g 锚点：`checkRuin(s)` 直接调用点 ≥ 5（平仓 / 开仓 / 调保证金 / 买 U / 换所）',
      hits >= 5, `实得 ${hits} 处`);
    const rsrc = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
    const rl = (rsrc.match(/ruinLabelOf\(s\)/g) || []).length;
    check('16g 锚点：`ruinLabelOf` 只在归零遮罩用一次（结算页正文不复述，改走 `overLabelOf`）',
      rl === 1 && /overLabelOf\(\{\s*reason,\s*final:\s*eq\s*\}\)/.test(rsrc), `实得 ${rl} 处`);
  }

  /* 16h · 单笔最小名义的**交易对**维度（2026-10-05 · Binance 合约 2023-11-02 起按交易对拆档）。
     现实口径（联网核对）：2023-11-02 官方只上调 `BTCUSDT` → $100、`ETHUSDT` → $20，
     其余 U 本位永续（DOGE / XRP / SOL…）仍是 $5 ⇒ 旧版「一律 $20」在 BTC 上偏松、在其余币上偏紧。 */
  {
    const tB = at(2023, 9, 1);   // 2023-11-02 之前（时间轴内）
    const tA = at(2024, 6, 1);   // 2023-11-02 之后（本作时间轴止于 2024-12-31）
    const mn = (t, sym) => C.minNotionalAt('binance', t, 'fut', sym);
    check('16h 2023-11-02 前：Binance 合约 BTC / ETH / DOGE 一律 $5',
      mn(tB, 'BTC') === 5 && mn(tB, 'ETH') === 5 && mn(tB, 'DOGE') === 5,
      `BTC=${mn(tB, 'BTC')} ETH=${mn(tB, 'ETH')} DOGE=${mn(tB, 'DOGE')}`);
    check('16h 2023-11-02 起：BTC=$100、ETH=$20、DOGE / XRP / SOL=$5（按交易对拆档）',
      mn(tA, 'BTC') === 100 && mn(tA, 'ETH') === 20 &&
      ['DOGE', 'XRP', 'SOL'].every(x => mn(tA, x) === 5),
      `BTC=${mn(tA, 'BTC')} ETH=${mn(tA, 'ETH')} DOGE=${mn(tA, 'DOGE')} XRP=${mn(tA, 'XRP')} SOL=${mn(tA, 'SOL')}`);
    check('16h 不传交易对 ⇒ 取该档最便宜的一格 $5（`ruinFloorOf` 的可达下界）',
      C.minNotionalAt('binance', tA, 'fut') === 5 &&
      Math.abs(C.openNeedAt('binance', tA, 'fut', 20) - 5 * (1 / 20 + C.feeRateOf('binance', tA, 'fut'))) <= 1e-12,
      `minNotional=${C.minNotionalAt('binance', tA, 'fut')} need=${f(C.openNeedAt('binance', tA, 'fut', 20), 8)}`);
    check('16h 其它所 / 其它产品不受交易对维度影响（BitMEX 合约 $1；Binance 杠杆 $10 → $5）',
      C.minNotionalAt('bitmex', tA, 'fut', 'BTC') === 1 &&
      C.minNotionalAt('binance', tA, 'margin', 'BTC') === 5 &&
      C.minNotionalAt('binance', at(2020, 1, 1), 'margin', 'BTC') === 10);

    /* 真闸门（不是读表）：同所同时刻、同一笔探针资金 @ 该通道上限杠杆 —— BTC 单被最小名义拒，DOGE 单照开。
       探针资金取两者门槛（`openNeedAt`，按**当前**上限杠杆算）的**中点** ⇒ 与上限杠杆解耦：
       2026-10-05 删掉 Binance 2021 的 20x 档、上限变 125x 后，这条仍能证明「按交易对拆档确实生效」。 */
    const levFut = Math.max(1, C.maxLeverageAt(tA, 'binance', 'fut'));
    const needBtc = C.openNeedAt('binance', tA, 'fut', levFut, null, 'BTC');
    const needDoge = C.openNeedAt('binance', tA, 'fut', levFut, null, 'DOGE');
    const cashProbe = (needBtc + needDoge) / 2;   // BTC（$100）与 DOGE（$5）门槛的中点
    const canOpenFut = async (sym) => {
      const s = await mk({ scen: 'classic', sym, mode: 'fut', i: idx(tA) });
      s.hintOn = false;
      s.ex = 'binance';
      s.books.binance = { usd: 0, usdt: cashProbe };
      s.lev = levFut;
      return engine.canOpenAt(s, 'long', 1);
    };
    const okBtc = await canOpenFut('BTC');
    const okDoge = await canOpenFut('DOGE');
    check('16h 真闸门：探针资金 @ Binance 合约上限杠杆 —— BTC 单被拒、DOGE 单可开（交易对拆档确实生效）',
      okBtc === false && okDoge === true,
      `BTC=${okBtc} DOGE=${okDoge} lev=${levFut} cash=${f(cashProbe, 4)} needBTC=${f(needBtc, 4)} needDOGE=${f(needDoge, 4)}`);
  }
}

/* ═══════════════════ 9y · 大单日志 tape（aggr 式 · 2026-10-08 拍板⑤） ═══════════════════
   引擎侧会话级 `s.feed`（不进存档 / rewindTo 清空 / FEED_CAP 环形封顶）：
     · 六型：0 开多 ▲ / 1 开空 ▼ / 2 平多 △ / 3 平空 ▽ / 4 爆多 💥 / 5 爆空 💥；
     · 分档 = 名义 ÷ 当日流动性 五档（0.1% / 0.5% / 1% / 2% / 5%，`feedTier` / `FEED_STEPS`）；
     · 挂点：NPC 六档建减仓（stepNpc）、护盘/巨鲸/ETF 急购、止损/止盈/强平（flushSlot，
       做市盘 quiet 不上 tape —— 对手盘流动性不是方向性合约单）、玩家被强平（事实流）；
     · 浮窗页 4「日志」（上帝 5 页 / 普通局 3 页），gfd-* 样式，装框不滚动。 */
{
  section('9ae · 大单日志 tape（aggr 式）');
  const readSrc9y = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const engSrc9y = readSrc9y('src/core/engine.js');
  const saveSrc9y = readSrc9y('src/core/save.js');
  const stateSrc9y = readSrc9y('src/core/state.js');
  const mainSrc9y = readSrc9y('src/main.js');
  const renderSrc9y = readSrc9y('src/ui/render.js');
  const styleSrc9y = readSrc9y('src/ui/style.css');

  check('9ae① 引擎：feedPush / feedTier / FEED_STEPS / FEED_CAP（1200 硬顶）＋ FEED_DAYS 保留窗口 ＋ rewindTo 清空',
    engSrc9y.includes('function feedPush(s, sym, k, price, notional, minTier = -1)')
    && engSrc9y.includes('export function feedTier(notional, liqDay)')
    && engSrc9y.includes('export const FEED_STEPS = [0.001, 0.005, 0.01, 0.02, 0.05]')
    && engSrc9y.includes('export const FEED_CAP = 1200')
    && engSrc9y.includes('export const FEED_DAYS = 3;')
    && engSrc9y.includes('if (s.feed.length > FEED_CAP || s.feed[0].i < s.i - FEED_DAYS * 24) {')
    && engSrc9y.includes('s.feed = [];'));

  check('9ae② 挂点：六档建减仓发事件（s, sym）＋ 做市盘两处**不带**（对手盘不上 tape）',
    engSrc9y.includes("stepNpc(m.npc[k], 'long', b + Math.max(0, target * w), price, floor, NPC.ladder[k].sp, s, sym)")
    && engSrc9y.includes("stepNpc(m.npc[k], 'short', b + Math.max(0, -target * w), price, floor, NPC.ladder[k].sp, s, sym)")
    && engSrc9y.includes("stepNpc(m.mm, 'long', targetMM, price, floorMM, NPC.mm.speed)")
    && engSrc9y.includes('flushSlot(s, sym, m, m.mm, NPC.mm.lev, lastPrice(s, sym), true)'));

  check('9ae③ 挂点：flushSlot 止损/止盈/强平六处（quiet 闸门）＋ 护盘/巨鲸急购 ＋ 玩家强平（事实流）',
    engSrc9y.includes('if (!quiet) feedPush(s, sym, 4, price, g.long)')
    && engSrc9y.includes('if (!quiet) feedPush(s, sym, 5, price, g.short)')
    && engSrc9y.split('if (!quiet) feedPush(s, sym, 2, price, cut)').length >= 3
    && engSrc9y.split('if (!quiet) feedPush(s, sym, 3, price, cut)').length >= 3
    && engSrc9y.includes('feedPush(s, sym, 0, price, buy)')
    && engSrc9y.includes('feedPush(s, sym, 1, price, sell)')
    && engSrc9y.split("feedPush(s, pos.sym, pos.side === 'long' ? 4 : 5, atPrice, notional, 0)").length >= 3);

  check('9ae④ 分档行为锚：5%→4 · 2%→3 · 1%→2 · 0.5%→1 · 0.1%→0 · 0.09%→−1（跨年代自适应的同一把尺）',
    engine.feedTier(5, 100) === 4 && engine.feedTier(2, 100) === 3 && engine.feedTier(1, 100) === 2
    && engine.feedTier(0.5, 100) === 1 && engine.feedTier(0.1, 100) === 0 && engine.feedTier(0.09, 100) === -1
    && engine.feedTier(1, 0) === -1 && engine.feedTier(0, 100) === -1);

  /* 行为锚：大波动段（2020-10 → 2021-10，含 2021-05 崩盘）推进 720h —— 事件必有、字段完整、
     六型至少三种、rewindTo 清空（会话级）。推进成本 ~0.05ms/h（feedPush 是纯算术＋环形 push）。 */
  {
    const s9ae = await mk({ i: idx(at(2020, 10, 1)) });
    for (let k = 0; k < 720; k++) engine.advanceOneHour(s9ae);
    const f9ae = s9ae.feed || [];
    const kinds9ae = [0, 0, 0, 0, 0, 0];
    for (const e of f9ae) kinds9ae[e.k]++;
    check('9ae⑤ 行为：720h 大波动段 feed 非空、字段完整（p>0/n>0/t∈0..4/合法币）、密度不刷屏（<2 条/h）',
      f9ae.length > 0
      && f9ae.every(e => e.p > 0 && e.n > 0 && e.t >= 0 && e.t <= 4
        && C.COINS.some(c => c.sym === e.sym) && Number.isInteger(e.k))
      && f9ae.length < 720 * 2,
      `n=${f9ae.length}（${(f9ae.length / 720).toFixed(2)} 条/h）`);
    check('9ae⑤ 行为：六型至少三种（开/平/爆都有机会发生）', kinds9ae.filter(n => n > 0).length >= 3,
      `kinds=[${kinds9ae.join(',')}]`);
    engine.rewindTo(s9ae, idx(at(2017, 1, 1)));
    check('9ae⑤ 行为：rewindTo 清空 feed ＋ 跳后照常推进', Array.isArray(s9ae.feed) && s9ae.feed.length === 0);
  }

  check('9ae⑥ 存档 / 状态：EPHEMERAL 含 feed ＋ createState 带 feed:[]',
    saveSrc9y.includes("const EPHEMERAL = ['god', 'godRuined', 'feed']") && stateSrc9y.includes('feed: [],'));

  check('9ae⑦ UI：页表（上帝 5 页 / 普通 3 页）＋ render 页 4 分支（gfd-*）＋ 样式（六型分色＋五档背景）',
    mainSrc9y.includes("const GOD_FLOAT_PAGES = [[0, '热力'], [1, '巨鲸'], [2, '深度'], [3, '订单'], [4, '日志']]")
    && mainSrc9y.includes("const MKT_FLOAT_PAGES = [[3, '订单'], [2, '深度'], [4, '日志']]")
    && renderSrc9y.includes('else if (page === 4)') && renderSrc9y.includes("'gfd-head'")
    && renderSrc9y.includes('gfd-lq') && renderSrc9y.includes('gfd-ls')
    && styleSrc9y.includes('.gfd-row') && styleSrc9y.includes('.gfd-row.t3') && styleSrc9y.includes('.gfd-row.t4')
    && styleSrc9y.includes('.gfd-lq i, .gfd-lq span') && styleSrc9y.includes('#ec407a') && styleSrc9y.includes('#ff9800'));
  /* 桌面 ≥1280 的浮窗日志页字号与订单簿对齐（2026-10-09 用户报「桌面端字体偏小」）：`.gfd-*`
     原来漏了这档覆盖、停在手机 9px/13px，与同结构 `.gb-*`（11/15）不一致 —— 这里咬住修复。 */
  check('9ae⑦b style：桌面 ≥1280 补 `.gfd-*` 覆盖（11px/15px，与订单簿同口径）',
    styleSrc9y.includes('.gfd-head, .gfd-row { font-size: 11px; line-height: 15px; }'));
  /* 2026-10-09 用户拍板⑥：日志页底部加**过滤档**（0.1% / 0.5% / 1% / 2% / 5% 当日流动性）——
     五档按钮 ＋ 会话级 `logFilt` ＋ `goffilt` 三链路缺一即「点了没反应」。 */
  check('9ae⑧ 日志页过滤档：五档按钮（feedPctLabel·goffilt）＋ 会话级 logFilt ＋ bind 收键 ＋ t4 底色',
    renderSrc9y.includes('const feedPctLabel') && renderSrc9y.includes('b.dataset.goffilt = String(i)')
    && renderSrc9y.includes('r.t >= lf') && renderSrc9y.includes('defaultBody(s, ui.page, ui.step, ui.filt)')
    && mainSrc9y.includes('let logFilt = 0;') && mainSrc9y.includes('function onGodFloatFilt(node)')
    && mainSrc9y.includes('filt: logFilt,') && mainSrc9y.includes('if (d.goffilt !== undefined) return onGodFloatFilt(node);')
    && readSrc9y('src/ui/bind.js').includes("'goffilt'")
    && styleSrc9y.includes('.gfd-row.t4'));
}

/* ═══════════════════ 9af · NPC 限价单离散簿（2026-10-08 三批拍板⑦） ═══════════════════
   「限价单系统，只给 NPC 加入」—— 行为级离散簿：每小时每币生成真实挂单（近场指数
   e^(−kδ) ＋ 远场 Pareto α=1.8 ＋ 整数关口加成 ＋ 买侧不对称），按距离随时间撤单，
   被行情吃穿的档 70% 概率跳价回填 ×1.5~3（做市商防御性补墙）。
   红线 A（不双重计价）：连续曲线（baseLadder / walkBook）**原样保留**为玩家成本 ＋
   总量基线 —— 簿只管显示（bookForWatch）＋ tape 播报（大档被吃穿）。
   随机数走 randFast 32 位通道（chan 'lob'/'lobf'），不污染行情 / 决策通道；撤单抖动
   用价签哈希（零随机数）⇒ 同一种子同一时刻 ⇒ 逐位同一本簿。 */
section('9af · NPC 限价单离散簿（行为级 ＋ 显示/播报读簿 ＋ 连续曲线保留为基线）');
{
  const engSrc9af = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
  const stateSrc9af = fs.readFileSync(path.join(ROOT, 'src/core/state.js'), 'utf8');
  const godSrc9af = fs.readFileSync(path.join(ROOT, 'src/core/god.js'), 'utf8');
  const saveSrc9af = fs.readFileSync(path.join(ROOT, 'src/core/save.js'), 'utf8');
  const rendSrc9af = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');

  /* ① 结构锚：簿四件套 ＋ 双钩子 ＋ 存档口径 ＋ 旋钮 */
  check('9af① 引擎：LOB 常数表 ＋ randFast 导入 ＋ lob 专用双通道 ＋ lobOf/lobTick/bookForWatch 在位',
    engSrc9af.includes('export const LOB = {')
    && engSrc9af.includes("import { hashStr, rand, randFast } from './rng.js';")
    && engSrc9af.includes("hashStr('lob')") && engSrc9af.includes("hashStr('lobf')")
    && engSrc9af.includes('function lobOf(s, sym)')
    && engSrc9af.includes('function lobTick(s, sym)')
    && engSrc9af.includes('function bookForWatch(s, sym, price)'));
  check('9af① 挂点：tickMarket / npcOtherTick 每币每小时一刻度（恰两处）＋ rewindTo 清簿 ＋ 冷启动兜底',
    (engSrc9af.match(/lobTick\(s, sym\);/g) || []).length === 2
    && engSrc9af.includes('s.lob = {};')
    && engSrc9af.includes('if (!s.lob) s.lob = {};'));
  check('9af① 状态 / 存档：createState 带 lob:{} ＋ 不进 EPHEMERAL（随 {...s} 落盘）＋ 不进 SHAPE（旧档不弃）',
    stateSrc9af.includes('lob: {}')
    && saveSrc9af.includes("const EPHEMERAL = ['god', 'godRuined', 'feed']")
    && !/const SHAPE = \{[^}]*lob/.test(saveSrc9af));
  check('9af① 旋钮：SB_KEYS 六键含 lob ＋ sbOf 归一 lob ＋ 四预设全带 lob=1',
    godSrc9af.includes("SB_KEYS = ['heat', 'mood', 'npc', 'shock', 'res', 'lob']")
    && godSrc9af.includes('lob: mul(b && b.lob, 1)')
    && god.SB_PRESETS.every(p => p.sb.lob === 1));

  /* ② 确定性：簿是 `(seed, sym, hour)` 的纯函数 ⇒ 两个**独立开局**走同一小时序列
     ⇒ 逐位同一本簿。（rewindTo 跳时间重建的是「另一段历史的世界」，价格位移层不必与
     全新局逐位同 —— 那是既有口径；这里只锁「同种子同时序 ⇒ 同簿」。） */
  {
    const run48 = async () => {
      const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e7, i: idx(at(2021, 5, 10)) });
      for (let k = 0; k < 48; k++) engine.advanceOneHour(s);
      return engine.godWatchOf(s, 'BTC').book;
    };
    const bA = await run48(), bB = await run48();
    check('9af② 确定性：双独立局同走 48h ⇒ 两侧逐位同一本簿（价 ＋ 名义 ＋ 行数）',
      bA && bB && bA.lob === true && bB.lob === true
      && bA.asks.length === bB.asks.length && bA.bids.length === bB.bids.length
      && bA.asks.every((r, j) => r.price === bB.asks[j].price && r.notional === bB.asks[j].notional)
      && bA.bids.every((r, j) => r.price === bB.bids[j].price && r.notional === bB.bids[j].notional),
      `asks ${bA.asks.length}/${bB.asks.length} · bids ${bA.bids.length}/${bB.bids.length}`);
    /* rewindTo 清簿（源码锚在 9af①）＋ 落点冷启动重长：契约完整即可（价距分居两侧 ＋ 非空） */
    const sW = await mk({ sym: 'BTC', mode: 'fut', cash: 1e7, i: idx(at(2021, 5, 10)) });
    for (let k = 0; k < 12; k++) engine.advanceOneHour(sW);
    engine.rewindTo(sW, idx(at(2021, 5, 10)));
    check('9af② rewindTo 清空 s.lob（跳时间后簿由种子重长，不携带跳前形态）',
      (!sW.lob || !sW.lob.BTC || (sW.lob.BTC.asks.length === 0 && sW.lob.BTC.bids.length === 0)));
    const bW = engine.godWatchOf(sW, 'BTC').book;
    check('9af② rewindTo 后冷启动重长：lob 标志 ＋ 两侧非空 ＋ 价距严格分居',
      bW && bW.lob === true && bW.asks.length > 0 && bW.bids.length > 0
      && bW.asks.every(r => r.price > bW.mid) && bW.bids.every(r => r.price < bW.mid));
  }

  /* ③ 720h 行为：治理器把单侧簿质量锚在基线（capQ × 本小时基准深度）附近 ＋ 结构上限 */
  {
    const sQ = await mk({ i: idx(at(2020, 10, 1)) });
    for (let k = 0; k < 720; k++) engine.advanceOneHour(sQ);
    let coins = 0, expect = 0, qFail = '', sFail = '', miss = '';
    for (const c of C.COINS) {
      if (!market.hasCandle(c.sym, sQ.i)) continue;          // 数据窗口未覆盖 ⇒ 合法缺席
      expect++;
      const b = sQ.lob && sQ.lob[c.sym];
      if (!b || !b.asks.length || !b.bids.length) { miss += `${c.sym}缺簿 `; continue; }
      coins++;
      const liq = engine.godWatchOf(sQ, c.sym).book.liq;   // hourLiqOf（含池回补折减）≤ 治理器的 base
      for (const [nm, arr] of [['asks', b.asks], ['bids', b.bids]]) {
        if (arr.length > engine.LOB.maxSide) sFail += `${c.sym}.${nm}=${arr.length}超顶 `;
        let mass = 0;
        for (const o of arr) mass += o.n;
        const r = mass / (engine.LOB.capQ * liq);
        if (!(r > 0.2) || !(r < 12)) qFail += `${c.sym}.${nm}=${f(r, 2)}× `;
      }
    }
    check('9af③ 行为：720h 后活簿单侧 ≤ maxSide（防泄漏硬顶生效）', sFail === '', sFail || '全部达标');
    check('9af③ 行为：单侧质量锚在基线附近（0.2~12× capQ×liq —— 治理器在位、不死不爆）',
      qFail === '', qFail || '全部达标');
    check('9af③ 行为：数据窗口覆盖的每个币两侧都长出活簿（近场指数保证贴中恒有单）',
      expect > 0 && coins === expect, `coins=${coins}/${expect}${miss ? ' · ' + miss : ''}`);
  }

  /* ④ 旋钮归零 ⇒ 冷启动不生成、推进 24h 仍回落连续合成（2026-10-07 形态 18 档逐位保留） */
  {
    const sZ = await mk({ sym: 'BTC', mode: 'fut', cash: 1e7, i: idx(at(2021, 5, 10)) });
    sZ.god = { lastFill: 0, sb: { ...god.SB_DEFAULT, lob: 0 } };
    engine.rewindTo(sZ, idx(at(2021, 5, 10)));   // mk 热身已按默认密度建簿 ⇒ 清掉，让 lob=0 从第一刻生效
    const bZ = engine.godWatchOf(sZ, 'BTC').book;
    for (let k = 0; k < 24; k++) engine.advanceOneHour(sZ);
    const bZ2 = engine.godWatchOf(sZ, 'BTC').book;
    const ladZ = impact.baseLadder(bZ2.sigma, bZ2.cap);
    const baseA = bZ2.asks.filter(r => !r.wall), baseB = bZ2.bids.filter(r => !r.wall);
    check('9af④ 旋钮 lob=0 ⇒ 簿恒空、回落连续合成（无 lob 标志 ＋ 两侧 18 基础档 baseLadder 逐位复刻）',
      bZ && bZ2 && !bZ.lob && !bZ2.lob
      && baseA.length === 18 && baseB.length === 18
      && ladZ.every((r, j) => Math.abs(baseA[j].price - bZ2.mid * (1 + r.d)) < 1e-9
        && Math.abs(baseA[j].notional - r.nq * bZ2.liq) < 1e-6
        && Math.abs(baseB[j].price - bZ2.mid * (1 - r.d)) < 1e-9)
      && sZ.lob.BTC && sZ.lob.BTC.asks.length === 0 && sZ.lob.BTC.bids.length === 0);
  }

  /* ⑤ 存档往返 ＋ 旧档兼容 */
  {
    const sO = await mk({ sym: 'BTC', mode: 'fut', cash: 1e7, i: idx(at(2021, 5, 10)) });
    for (let k = 0; k < 6; k++) engine.advanceOneHour(sO);
    const round = JSON.parse(JSON.stringify({ ...sO }));   // save() 的 {...s}＋stringify 同款路径
    check('9af⑤ 往返：lob 随档序列化（JSON 往返逐位同簿）',
      round.lob && round.lob.BTC
      && JSON.stringify(round.lob.BTC) === JSON.stringify(sO.lob.BTC));
    delete round.lob;                                      // 旧档：根本没有这个键
    const bO = engine.godWatchOf(round, 'BTC').book;
    check('9af⑤ 旧档无 lob ⇒ 读侧惰性冷启动不炸（冷启动簿两侧 ≥18 行）',
      bO && bO.lob === true && bO.asks.length >= 18 && bO.bids.length >= 18);
  }

  /* ⑥ render 锚：页 3 直接读簿行 ＋ 整数关口标记 ＋ 步进底栏 */
  check('9af⑥ render：页 3 按 step 分桶读簿（sideOf(askMap/bidMap)）＋ 关口标记（k%10/%5）＋ 步进底栏接线在位',
    rendSrc9af.includes('const A = sideOf(askMap, 1)')
    && rendSrc9af.includes('const B = sideOf(bidMap, -1)')
    && rendSrc9af.includes('k % 10 === 0 ? 1 : k % 5 === 0 ? 2 : 0')
    && rendSrc9af.includes('b.dataset.gofstep = String(v)'));
}

/* ═══════════════════ 9ag · 插针剧本 ＋ 假消息 ＋ K线强平叠加（2026-10-08 三批拍板③） ═══════════════════
   上帝操盘台第三批：① 插针 = 一键吃穿最大强平簇再回位 —— **没有直接设价通道**，每小时
   伺服一笔真实吃单（godManipPush 同一物理：花钱 / 吃深度 / 被硬夹），簇检测与 flushSlot
   的强平判定逐位同源（godWatchOf.liqs 的 price 就是 longAvg×(1−drop) / shortAvg×(1+drop)）
   ⇒ 推到位的那一根 NPC 真的爆（tape k=4/k=5）；② 假消息 = 热度一脚 ＋ 小额跟风单 ＋
   news 金底播报，**幅度**走 randFast 通道 'news'（确定性）、**选条**走轮换计数（M4d）；③ 强平叠加 = 主图右轴档位条
   （godWatchOf.liqs 同一份数据）。全部挂 s.god（不进存档）⇒ 不升 STATE_VERSION。 */
section('9ag · 插针剧本 ＋ 假消息 ＋ 强平叠加（伺服走真实吃单物理 ＋ 全链路确定性）');
{
  const rd9ag = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const engSrc9ag = rd9ag('src/core/engine.js');
  const godSrc9ag = rd9ag('src/core/god.js');
  const mainSrc9ag = rd9ag('src/main.js');
  const bindSrc9ag = rd9ag('src/ui/bind.js');
  const rendSrc9ag = rd9ag('src/ui/render.js');
  const chartSrc9ag = rd9ag('src/ui/chart.js');
  const styleSrc9ag = rd9ag('src/ui/style.css');

  /* ① 结构锚：状态机 ＋ 伺服挂点 ＋ 常数 ＋ UI 接线（bind.js 漏键 = 按钮没反应，9q 教训） */
  check('9ag① 引擎：godPinStart/Tick/Stop/FakeNews 导出 ＋ 伺服挂点在 pending 检查后、tickMarket 前 ＋ rewindTo 作废',
    engSrc9ag.includes('export function godPinStart(s, sym, dir)')
    && engSrc9ag.includes('export function godPinTick(s)')
    && engSrc9ag.includes('export function godPinStop(s)')
    && engSrc9ag.includes('export function godFakeNews(s, sym, dir)')
    && engSrc9ag.includes('if (s.pending) return;\n\n  /* 交易所收入分流')
    && engSrc9ag.includes('exRevSweep(s);\n\n  /* 插针剧本伺服')   // 2026-10-09 回流管道：排在伺服 / NPC 刻度之前
    && engSrc9ag.includes('godPinTick(s);\n\n  /* 自动扫单伺服')   // 2026-10-09：扫单伺服紧随插针（同一时序纪律）
    && engSrc9ag.includes('godEatTick(s);\n\n  /* 自动化伺服')     // 2026-10-10：自动化伺服紧随扫单
    && engSrc9ag.includes('godAutoTick(s);\n\n  /* NPC 情绪 / 踩踏级联')
    /* 2026-10-08 M4k：作废行扩成对象体（插针 ＋ 沙盒世界偏向台阶 `sbBias` 一起清）；
       M4d：再并进假消息的冷却 / 轮换计数（`newsAt` / `newsN`）。 */
    && engSrc9ag.includes('if (s.god) {')
    && engSrc9ag.includes('s.god.pin = null;')
    && engSrc9ag.includes('s.god.sbBias = null;')
    && engSrc9ag.includes('s.god.newsAt = null;')
    && engSrc9ag.includes('s.god.newsN = null;'));
  check('9ag① god.js：MANIP_PIN 五参 ＋ MANIP_NEWS 利好/利空模板 ＋ %S 占位',
    godSrc9ag.includes('export const MANIP_PIN = { qStep: 0.35, overshoot: 0.005, backTol: 0.004, maxN: 8, maxH: 36 };')
    && godSrc9ag.includes('export const MANIP_NEWS = {')
    && godSrc9ag.includes('good:') && godSrc9ag.includes('bad:')
    && engSrc9ag.includes('fillNews(tpls[n % tpls.length], newsVars(s, sym))'));
  check('9ag① 接线：main 分派三键 ＋ 处理器 ＋ bind ACTION_KEYS ＋ render 三行按钮 ＋ chart 读取/着色 ＋ 置灰样式',
    mainSrc9ag.includes('if (d.godpin !== undefined)') && mainSrc9ag.includes('if (d.godnews !== undefined)')
    && mainSrc9ag.includes('if (d.godliqov !== undefined)') && mainSrc9ag.includes('function onGodPin')
    && mainSrc9ag.includes('function onGodNews')
    && bindSrc9ag.includes("'godpin'") && bindSrc9ag.includes("'godnews'") && bindSrc9ag.includes("'godliqov'")
    && rendSrc9ag.includes("pinDn.dataset.godpin = '-1'") && rendSrc9ag.includes("newsUp.dataset.godnews = '1'")
    && rendSrc9ag.includes("ovBtn.dataset.godliqov = ''") && rendSrc9ag.includes('pinDn.disabled = !!s.god.pin')
    && rendSrc9ag.includes('liqBars: s.god && s.god.liqOverlay ? godWatchOf(s, sym).liqs : null')
    && chartSrc9ag.includes('right, levels, liqBars } = o;')
    && chartSrc9ag.includes("L.side === 'long' ? T.DOWN : T.UP")
    && styleSrc9ag.includes('.set-btn:disabled'));

  /* ② 假消息：确定性（双局逐位同果）＋ 物理三件套 ＋ 资金闸 */
  {
    const mkNews = async () => {
      const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e7, i: idx(at(2021, 5, 10)) });
      s.god = { lastFill: 1e9, inf: true, sb: { ...god.SB_DEFAULT } };
      s.mkt.BTC.heat = 0.3;                            // 归一低温：热度脚不被 clamp01 截断，断言稳定
      return s;
    };
    const a = await mkNews(), b = await mkNews();
    const hA = a.mkt.BTC.heat, hB = b.mkt.BTC.heat;
    const pA = engine.lastPrice(a, 'BTC'), pB = engine.lastPrice(b, 'BTC');
    const ra = engine.godFakeNews(a, 'BTC', 1), rb = engine.godFakeNews(b, 'BTC', 1);
    const dA = a.mkt.BTC.heat - hA, dB = b.mkt.BTC.heat - hB;
    check('9ag② 假消息确定性：双局热度脚/花费/播报文本逐位相同',
      ra.ok && rb.ok && Math.abs(dA - dB) < 1e-12 && Math.abs(ra.cost - rb.cost) < 1e-9
      && a.log[0].text === b.log[0].text);
    /* ⚠️ 2026-10-08 M4d：热度脚区间随 `MANIP_NEWS_RANGE` 上调（0.2~0.4 → 0.28~0.55）。 */
    check('9ag② 假消息物理：热度一脚 ∈ [0.28,0.55] ＋ 位移真动了 ＋ news 金底芯片 ＋ 模板含币符号',
      dA >= 0.28 - 1e-9 && dA <= 0.55 + 1e-9 && engine.lastPrice(a, 'BTC') !== pA
      && a.log[0].tag === 'news' && a.log[0].text.includes('BTC') && ra.cost > 0);
    const c = await mkNews();
    for (const bk of Object.values(c.books)) { bk.usd = 0; bk.usdt = 0; }
    c.god.inf = false; c.god.lastFill = 0;
    const rc = engine.godFakeNews(c, 'BTC', 1);
    check('9ag② 假消息资金闸：无限资金关 ＋ 账户归零 ⇒ 拒绝且不播报',
      !rc.ok && /资金不足/.test(rc.why) && c.log[0] == null);
  }

  /* ③ 插针全链路：强塞一档高杠杆多头（审计直改状态 = 「NPC 早已建仓」）→ 启动 →
     伺服推进 → flushSlot 真爆（tape k=4）→ 回位收场；双局全程逐位确定。 */
  const pinRun = async () => {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e7, i: idx(at(2021, 5, 10)) });
    s.god = { lastFill: 1e9, inf: true, sb: { ...god.SB_DEFAULT } };
    const cur = engine.lastPrice(s, 'BTC');
    const t = engine.timeOf(s);
    let kBest = -1, bestDrop = Infinity;             // 有效杠杆最高的档 ⇒ 簇离现价最近
    for (let k = 0; k < s.mkt.BTC.npc.length; k++) {
      const drop = 1 / god.npcLevOf(t, god.NPC.ladder[k].lev) - C.GAME.maintRate;
      if (drop > 0 && drop < bestDrop) { bestDrop = drop; kBest = k; }
    }
    const g = s.mkt.BTC.npc[kBest];
    g.long = 2e7; g.longAvg = cur; g.longStopped = false; g.longTp = false;
    /* 预期针尖要用**引擎同源**的选择逻辑算：godPinStart 挑的是「名义最大的前方案」，预热期
       其他档已有真实持仓 ⇒ 不能拿我强塞的那一档当预期（那是 9ag③ 首版的错口径）。 */
    let best = null;
    for (const l of engine.godWatchOf(s, 'BTC').liqs) {
      if (l.side !== 'long' || !(l.price < cur)) continue;
      if (!best || l.notional > best.notional) best = l;
    }
    const st = engine.godPinStart(s, 'BTC', -1);
    let h = 0, sawK4 = false;
    while (s.god.pin && h < god.MANIP_PIN.maxH + 10) {
      engine.advanceOneHour(s);
      h++;
      if (s.feed.some(x => x.k === 4)) sawK4 = true;
    }
    return {
      ok: st.ok, tip: st.tip, bestPrice: best ? best.price : 0, bestBelow: best ? best.price < cur : false,
      h, sawK4, gone: !s.god.pin,
      logs: s.log.map(l => l.text).join('|'),
      feed: JSON.stringify(s.feed), mkt: JSON.stringify(s.mkt.BTC.npc),
    };
  };
  {
    const A = await pinRun(), B = await pinRun();
    const tipTheoretical = A.bestPrice * (1 - god.MANIP_PIN.overshoot);
    check('9ag③ 插针启动：簇 = 下方名义最大档（godWatchOf.liqs 同源）⇒ 针尖越过簇价 0.5%',
      A.ok && A.bestBelow && A.h > 0 && Math.abs(A.tip - tipTheoretical) < 1e-9 * tipTheoretical);
    check('9ag③ 全链路：伺服收场 ＋ 簇真爆了（tape k=4）＋ 日志有回位完成/中止',
      A.gone && A.sawK4 && /回位完成|插针中止/.test(A.logs));
    check('9ag③ 确定性：双独立局全程日志 / tape / NPC 持仓逐位相同',
      A.logs === B.logs && A.feed === B.feed && A.mkt === B.mkt && A.h === B.h);
  }

  /* ④ 拉针镜像 ＋ 手动停 ＋ 跳时间作废 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e7, i: idx(at(2021, 5, 10)) });
    s.god = { lastFill: 1e9, inf: true, sb: { ...god.SB_DEFAULT } };
    const cur = engine.lastPrice(s, 'BTC');
    const t = engine.timeOf(s);
    let kBest = -1, bestDrop = Infinity;
    for (let k = 0; k < s.mkt.BTC.npc.length; k++) {
      const drop = 1 / god.npcLevOf(t, god.NPC.ladder[k].lev) - C.GAME.maintRate;
      if (drop > 0 && drop < bestDrop) { bestDrop = drop; kBest = k; }
    }
    const g = s.mkt.BTC.npc[kBest];
    g.short = 2e7; g.shortAvg = cur; g.shortStopped = false; g.shortTp = false;
    /* 预期针尖与 9ag③ 同一口径：godWatchOf.liqs 同源选择（上方名义最大的空头簇）。 */
    let best = null;
    for (const l of engine.godWatchOf(s, 'BTC').liqs) {
      if (l.side !== 'short' || !(l.price > cur)) continue;
      if (!best || l.notional > best.notional) best = l;
    }
    const up = engine.godPinStart(s, 'BTC', 1);
    const upTipOk = up.ok && best && Math.abs(up.tip - best.price * (1 + god.MANIP_PIN.overshoot)) < 1e-9 * up.tip;
    const again = engine.godPinStart(s, 'BTC', 1);   // 进行中再启 ⇒ 拒绝
    const stop = engine.godPinStop(s);
    const stopped = stop.ok && !s.god.pin;
    engine.godPinStart(s, 'BTC', 1);
    const hadPin = !!s.god.pin;
    engine.rewindTo(s, s.i - 1);
    check('9ag④ 拉针镜像（tip = shortAvg×(1+drop)×(1+0.005)）＋ 进行中再启拒绝 ＋ 停 ＋ 跳时间作废',
      upTipOk && !again.ok && stopped && hadPin && s.god.pin === null);
  }
}

/* ═══════════════════ 9ah · M4 深度倍数全套放大 ＋ 爆仓潮自适应 ＋ 上帝新闻（2026-10-08） ═══════════════════
   M4b：上帝「深度」旋钮（`godLiqMulOf`）⇒ 一处 `gm` 闸门（`godScale`）贯通市场规模类分母 / 读数
        （NPC 靶心 / 基底 / OI / 量柱 / 簿 / 基金池 / 对抗性暴露）；玩家自己的名义额**不过闸**（红线 A）；
   M4c：爆仓潮 / ADL 阈值同源放大（`liqEventScaleOf = gm × npc`）＋ 日志冷却（`NPC.liqEventCd`）；
   M4d：上帝新闻（模板各 16 条 ＋ 冷却 `MANIP_NEWS_CD` ＋ 轮换去重 ＋ 「新闻源与事件」开关）；
   M4f：桌面日志条 2 → 6 行（`LOG_ROWS` 断点与 CSS 同源）。
   ⚠️ 全部在 `gm === 1` / 缺键时**逐位早退** ⇒ 普通 / 挑战局零回归（9p 恒等断言咬住这一条）。 */
section('9ah · M4 深度倍数全套放大 ＋ 爆仓潮自适应 ＋ 上帝新闻（结构锚 ＋ 行为锚）');
{
  const rd9ah = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const engSrc9ah = rd9ah('src/core/engine.js');
  const godSrc9ah = rd9ah('src/core/god.js');
  const mainSrc9ah = rd9ah('src/main.js');
  const bindSrc9ah = rd9ah('src/ui/bind.js');
  const rendSrc9ah = rd9ah('src/ui/render.js');
  const cssSrc9ah = rd9ah('src/ui/style.css');

  /* ① 结构锚：两枚缩放闸 ＋ 七处接入点 ＋ 爆仓潮阈值 / 冷却 ＋ 新闻闸 ＋ UI 接线 */
  check('9ah① M4b 结构：godScale / liqEventScaleOf 定义 ＋ NPC 靶心 / OI / 暴露 / 做市 / feedTier / 基金池 同源接入',
    engSrc9ah.includes('function godScale(s, sym, v) {')
    && engSrc9ah.includes('return gm === 1 ? v : v * gm;')
    && engSrc9ah.includes('function liqEventScaleOf(s, sym) {')
    && engSrc9ah.includes('return godLiqMulOf(s, sym) * sbOf(s).npc;')
    && engSrc9ah.includes('function baseBookOiOf(s, sym)')
    && engSrc9ah.includes('return godScale(s, sym, Number.isFinite(v) && v > 0 ? OI.bookTurn * v : 0);')
    && engSrc9ah.includes('const d = godScale(s, sym, raw);')
    && engSrc9ah.includes('const raw = godScale(s, sym, hourLiqRaw(s, sym, s.i));')
    && engSrc9ah.includes('feedTier(notional, godScale(s, sym, liqOf(sym, dayIndexOf(s.i))))')
    && engSrc9ah.includes('const liq = godScale(s, sym, liqOf(sym, dayIndexOf(s.i)));'));
  check('9ah① M4c 结构：阈值同源放大（liqEventScaleOf）＋ 日志冷却（NPC.liqEventCd）＋ 冷却不动 ADL',
    godSrc9ah.includes('liqEventCd: 12,')
    && engSrc9ah.includes('const thr = liqDay > 0 ? liqDay * NPC.liqEventFrac * liqEventScaleOf(s, sym) : 0;')
    && engSrc9ah.includes('if (s.i - last >= NPC.liqEventCd) {')
    && /if \(s\.i - last >= NPC\.liqEventCd\) \{[\s\S]*?pushLog\(s, `爆仓潮[\s\S]*?adl\(s, sym, m,/.test(engSrc9ah));
  check('9ah① M4d 结构：MANIP_NEWS_CD ＋ 模板各 16 条 ＋ 冷却 / 轮换 ＋ noRealNews 默认 true ＋ extFlow / 播报双闸',
    godSrc9ah.includes('export const MANIP_NEWS_CD = 8;')
    && /export const MANIP_NEWS = \{[\s\S]*?good: \[[\s\S]*?\],[\s\S]*?bad: \[[\s\S]*?\],\s*\};/.test(godSrc9ah)
    && (godSrc9ah.match(/'快讯 ｜/g) || []).length >= 80
    && godSrc9ah.includes('if (s.god.noRealNews == null) s.god.noRealNews = true;')
    && engSrc9ah.includes('const cd = s.i - last;')
    && engSrc9ah.includes('if (cd < MANIP_NEWS_CD) return { ok: false, why: `冷却中（还需 ${MANIP_NEWS_CD - cd} 小时）` };')
    && engSrc9ah.includes('s.god.newsN[key] = n + 1;')
    && engSrc9ah.includes('const extFlow = eventsOff(s) ? 0 : (whaleFlowAt(sym, dayIdx) + etfFlowAt(sym, dayIdx));')
    && engSrc9ah.includes('if (!eventsOff(s)) {')
    && engSrc9ah.includes('s.god.newsAt = null;')
    && engSrc9ah.includes('s.god.newsN = null;'));
  check('9ah① M4d/M4e/M4f 接线：godreal 三处 ＋ 冷却置灰 ＋ 长按连发 ＋ 日志条 6 行/120px',
    bindSrc9ah.includes("'godreal'")
    && mainSrc9ah.includes('if (d.godreal !== undefined)') && mainSrc9ah.includes('s.god.noRealNews = !s.god.noRealNews;')
    && rendSrc9ah.includes("realBtn.dataset.godreal = ''")
    && rendSrc9ah.includes('if (newsCd < MANIP_NEWS_CD) { newsDn.disabled = true; newsUp.disabled = true; }')
    && mainSrc9ah.includes('const PUMP_REPEAT_MS = 200;')
    && mainSrc9ah.includes('function pumpStop()') && mainSrc9ah.includes('pumpAcc.timer = setInterval(')
    && mainSrc9ah.includes('window.addEventListener(\'pointerup\', pumpStop);')
    && mainSrc9ah.includes('return onGodPump(node, ev);')
    && rendSrc9ah.includes("&& window.matchMedia('(min-width: 1280px)').matches) ? 6 : 2;")
    && cssSrc9ah.includes('.logline { height: calc(120px * var(--ui)); }'));

  /* ② M4b 行为：深度 ×1/×4/×8 ⇒ 本时深度严格成比例、OI / 散户簿近似成比例（纯缩放） */
  const scaleProbe = async (mul) => {
    const s = await mk({ sym: 'BTC', i: idx(at(2021, 1, 1)) });
    god.enableGod(s);
    s.god.sb = { ...god.SB_DEFAULT };
    s.god.liqMul = mul;
    let oi = 0, bk = 0, dep = 0, n = 0;
    for (let k = 0; k < 240; k++) {
      engine.advanceOneHour(s);
      if (s.over || s.pending) break;
      const m = s.mkt.BTC;
      let b = 0;
      for (const g of m.npc) b += g.long + g.short;
      if (m.mm) b += m.mm.long + m.mm.short;
      oi += engine.openInterestOf(s, 'BTC'); bk += b;
      dep += engine.godWatchOf(s, 'BTC').depth.hourBase; n++;
    }
    return { oi: oi / n, bk: bk / n, dep: dep / n };
  };
  {
    const r1 = await scaleProbe(1), r4 = await scaleProbe(4), r8 = await scaleProbe(8);
    const near = (a, b, tol) => Math.abs(a / b - 1) <= tol;
    check('9ah② M4b 行为：本时深度严格 ×1/×4/×8 ＋ OI / 散户簿同倍放大（纯缩放、玩家仓位不过闸）',
      near(r4.dep, r1.dep * 4, 1e-6) && near(r8.dep, r1.dep * 8, 1e-6)
      && near(r8.oi / r1.oi, 8, 0.25) && near(r4.oi / r1.oi, 4, 0.25)
      && near(r8.bk / r1.bk, 8, 0.25) && near(r4.bk / r1.bk, 4, 0.25),
      `dep ${f(r4.dep / r1.dep, 3)}/${f(r8.dep / r1.dep, 3)} · oi ${f(r8.oi / r1.oi, 2)} · bk ${f(r8.bk / r1.bk, 2)}`);
  }

  /* ③ M4c 行为：阈值闸门 —— 「不联动」列随倍数暴涨（×8 ⇒ ×8 刷屏）；「联动」列保持同量级。
     口径：逐小时 `r = Δstat.liqNotional ÷ 当日流动性`；老规则 `r ≥ frac`、新规则 `r ≥ frac×gm×npc`。 */
  const thrProbe = async (mul, npc) => {
    const s = await mk({ sym: 'BTC', i: idx(at(2020, 3, 1)) });
    god.enableGod(s);
    s.god.sb = { ...god.SB_DEFAULT, npc };
    s.god.liqMul = mul;
    const frac = god.NPC.liqEventFrac;
    let prev = s.stat.liqNotional || 0, oldN = 0, newN = 0;
    for (let k = 0; k < 720; k++) {
      engine.advanceOneHour(s);
      if (s.over || s.pending) break;
      const now = s.stat.liqNotional || 0, d = now - prev; prev = now;
      const liqDay = market.liqOf('BTC', Math.floor(s.i / 24)) || 0;
      if (liqDay > 0 && d > 0) {
        const r = d / liqDay, thr = frac * engine.godLiqMulOf(s, 'BTC') * god.sbOf(s).npc;
        if (r >= frac) oldN++;
        if (r >= thr) newN++;
      }
    }
    return { oldN, newN };
  };
  {
    const base = await thrProbe(1, 1), big = await thrProbe(8, 30);
    check('9ah③ M4c 行为：深度×8 ＋ 散户×30 ⇒ 旧阈值刷屏、新阈值自适应抑制',
      base.oldN === 0 && big.oldN >= 10 && big.newN <= 1,
      `不联动 ${base.oldN}→${big.oldN} 条 · 联动 ${base.newN}→${big.newN} 条`);
  }

  /* ④ M4d 行为：noRealNews 默认 true ＋ 冷却拒发 ＋ 16 连发轮换不重样 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e8, i: idx(at(2021, 5, 10)) });
    god.enableGod(s);
    s.god.inf = true; s.god.lastFill = 1e9;
    const defOff = s.god.noRealNews === true;
    const a = engine.godFakeNews(s, 'BTC', 1);
    /* ⚠️ 播报文本必须**当场**取 —— `advanceOneHour` 每小时会插别的日志把队首顶掉。 */
    const seen = new Set([s.log[0].text]);
    engine.advanceOneHour(s);
    const b = engine.godFakeNews(s, 'BTC', 1);              // 1h 后仍在 8h 冷却里 ⇒ 拒
    check('9ah④ M4d 行为：进入上帝模式默认关真实新闻 ＋ 冷却期内拒发',
      defOff && a.ok && !b.ok && /冷却/.test(b.why),
      `noRealNews=${s.god.noRealNews} · 二次 ${b.ok ? 'ok' : b.why}`);
    /* 16 连发（每次隔 9h > 冷却）⇒ 16 条文本两两不同（轮换去重生效） */
    for (let k = 0; k < 15; k++) {
      for (let h = 0; h < 9; h++) engine.advanceOneHour(s);
      const r = engine.godFakeNews(s, 'BTC', 1);
      if (r.ok) seen.add(s.log[0].text);
    }
    check('9ah④ M4d 行为：连按 16 次 ⇒ 16 条播报两两不同（轮换计数去重）＋ 全部含币符号',
      seen.size === 16 && [...seen].every(t => t.includes('BTC')),
      `去重后 ${seen.size} 条`);
    check('9ah④ M4d 常数：利好 / 利空各 86 条（6 类风格 ＋ 早期年代风味 ＋ 年代扩容 40）＋ 冷却 8h',
    god.MANIP_NEWS.good.length === 86 && god.MANIP_NEWS.bad.length === 86 && god.MANIP_NEWS_CD === 8,
    `good=${god.MANIP_NEWS.good.length} bad=${god.MANIP_NEWS.bad.length}`);
  }
}

/* ═══════════════════ 9ai · 新闻占位符 / 上帝终局（2026-10-09） ═══════════════════
   需求 1/2：新闻文案里的数字必须**取自此刻的真实状态**（含玩家位移）—— `newsVars` 是唯一产出处，
   `fillNews` 单遍替换；本节点固化：① `title` 永远不含数字；② `rt` / 假新闻模板填充后无残留占位符、
   无换行；③ `newsVars` 幂等、对表外 / 未加载币不抛、非上帝局偏离恒 0。
   需求 3：上帝走完全程 ⇒ `s.god.ended`，**不结算 / 不档案 / 不海报**（`s.over` 保持 null），
   且 `ended` 后 `advanceOneHour` 幂等（「继续」不可能续跑）；`rewindTo` 复位该旗标。 */
section('9ai · 新闻占位符 newsVars / fillNews ＋ 上帝终局 s.god.ended');
{
  const A = await import('../src/core/anchors.js');
  const all = A.allAnchors();

  /* ① 全表 title 只讲事件、**不含价格 / 百分比符号**（红线：价格数字一律落 rt 结果条）。 */
  const badTitle = all.filter(a => /[$%]/.test(a.title));
  check('9ai① 全表 title 不含价格 / 百分比符号（[$%]；史实年份 / 枚数等事实数字不算）',
    badTitle.length === 0, badTitle.map(a => a.title).join(' | '));

  /* 建一局上帝板（有位移源），填充与终局一手测。 */
  const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e8, i: idx(at(2021, 5, 10)) });
  god.enableGod(s);

  /* ② 结果条 rt（带占位符）经 `fillNews` 填充后：无残留 `%`、无换行、非空。 */
  const filled = all.filter(a => a.rt)
    .map(a => engine.fillNews(a.rt, engine.newsVars(s, (a.r && a.r.sym) || 'BTC', { r: a.r, at: a.at })));
  const badFill = filled.filter(t => /%[A-Za-z]/.test(t) || t.includes('\n') || t.trim().length < 4);
  check('9ai② 结果条 rt 填充后无残留占位符 / 无换行 / 非空',
    filled.length >= 20 && badFill.length === 0, badFill.join(' | '));

  /* 假新闻模板（46＋46，混合类型：裸字符串全期可用 / `{t, from}` 年代门控）经 `fillNews` 填充后：
     无残留 `%`、无换行、全部含币符号。⚠️ 2026-10-09 年代门控：先抹平成字符串再填充。 */
  const nv = engine.newsVars(s, 'BTC');
  const flat = tpl => (typeof tpl === 'string' ? tpl : tpl.t);
  const fake = god.MANIP_NEWS.good.concat(god.MANIP_NEWS.bad).map(tpl => engine.fillNews(flat(tpl), nv));
  const badFake = fake.filter(t => /%[A-Za-z]/.test(t) || t.includes('\n') || !t.includes('BTC'));
  check('9ai② 假新闻模板 172 条填充后无残留占位符 / 无换行 / 全部含币符号',
    badFake.length === 0, badFake.join(' | '));

  /* ③ `newsVars` 幂等（同状态两次调用逐键相等 ⇒ 重放确定性）；表外币不抛、价格走 `--`。 */
  const nv2 = engine.newsVars(s, 'BTC');
  check('9ai③ newsVars 幂等（两次调用逐键相等，重放确定性）',
    JSON.stringify(nv) === JSON.stringify(nv2));
  let threw = false, zz = null;
  try { zz = engine.newsVars(s, 'ZZZ'); } catch { threw = true; }
  check('9ai③ 表外币（ZZZ）调用不抛、价格走 `--` 兜底',
    !threw && !!zz && zz['%L'] === '--', threw ? 'threw' : `${zz && zz['%L']}`);

  /* ④ 偏离 `%M` 必须**逐位**等于现价相对史实的位移（`closeAt / rawCloseAt − 1`）——
     这条是「新闻数字取自此刻真实状态」的算术锚（普通局的 NPC 漂移也让 %M ≠ 0，故不假定为 0）。 */
  const n = await mk({ sym: 'BTC', i: idx(at(2021, 5, 10)) });
  const nvN = engine.newsVars(n, 'BTC');
  const lastN = market.closeAt('BTC', n.i), rawN = market.rawCloseAt('BTC', n.i);
  check('9ai④ 偏离 %M 逐位 = closeAt / rawCloseAt − 1（位移口径正确）',
    nvN['%M'] === F.fmtPct(lastN / rawN - 1),
    `%M=${nvN['%M']} 实测=${F.fmtPct(lastN / rawN - 1)}`);

  /* ⑤ 上帝终局：下一小时即到终点 ⇒ ended / paused 立起、`s.over` 保持 null（不调 endGame）。 */
  s.i = s.endI - 1;
  engine.advanceOneHour(s);
  check('9ai⑤ 走完全程 ⇒ `s.god.ended` ＋ `s.paused` 立起，`s.over` 保持 null（不结算 / 不档案）',
    s.god.ended === true && s.paused === true && s.over === null,
    `ended=${s.god.ended} paused=${s.paused} over=${s.over}`);
  /* 幂等闸：ended 后再推两小时 —— 时钟定型、日志不再增长。 */
  const logN = s.log.length, iN = s.i;
  engine.advanceOneHour(s);
  engine.advanceOneHour(s);
  check('9ai⑤ ended 后 advanceOneHour 幂等（`s.i` 不变、日志不增长）',
    s.i === iN && s.log.length === logN, `Δi=${s.i - iN} Δlog=${s.log.length - logN}`);

  /* ⑥ `rewindTo` 复位 ended（与它复位 over / paused 同一处理）。 */
  engine.rewindTo(s, idx(at(2021, 1, 1)));
  check('9ai⑥ rewindTo 复位 `s.god.ended = false`', s.god.ended === false, String(s.god.ended));

  /* ⑦ 落盘剔除：`s.god` 属 EPHEMERAL ⇒ ended 随会话级状态一起不落盘。 */
  const saveSrc = fs.readFileSync(path.join(ROOT, 'src/core/save.js'), 'utf8');
  check('9ai⑦ save.js 的 EPHEMERAL 含 `god`（ended 不落盘 / 不升档位）',
    /const EPHEMERAL = \[[^\]]*'god'/.test(saveSrc));

  /* ⑧ 接线锚：真实结果条 / 假新闻都经 `fillNews(newsVars(…))`；终局走 ended 而非 endGame。 */
  const engSrc = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
  const rendSrc = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  check('9ai⑧ 引擎：真实结果条与假新闻播报都走 `fillNews(…, newsVars(…))`（数值同源）',
    engSrc.includes('fillNews(rnews.rt, newsVars(')
    && engSrc.includes('fillNews(tpls[n % tpls.length], newsVars(s, sym))'));
  check('9ai⑧ 上帝终局接线：engine 立 ended / main 见 ended 弹遮罩 / render 有独立 renderGodEnd',
    engSrc.includes('if (s.over || s.pending || (s.god && s.god.ended)) return;')
    && mainSrc.includes('s.god && s.god.ended')
    && mainSrc.includes('godEndOpen = false')
    && rendSrc.includes('export function renderGodEnd(root, s)'));
}

/* ═══════════════════ 9aj · 上帝沙盒旋钮 × 面板档位表（2026-10-09） ═══════════════════
   病根（用户报「进上帝模式后点 degen 无弹窗 / 重开本局报 `nt[F] is not iterable`」）：
   `god.js` 的 `SB_KEYS` 加了第 6 枚 `lob`（挂单密度），而 `render.js` 的 `SB_STEPS` 只有前 5 枚 ——
   `for (const v of SB_STEPS['lob'])` 遍历 `undefined` ⇒ 直接抛 ⇒ `openGod` 整个炸掉、遮罩被开半截。
   ⚠️ 静态护栏只能咬「两表键集相等」这一条不变量（值域是否合理由 9ai / 9ah 的行为锚管）。 */
section('9aj · 上帝沙盒旋钮 SB_KEYS × 面板档位表 SB_STEPS（2026-10-09 面板打不开的病根）');
{
  const godSrcAj = fs.readFileSync(path.join(ROOT, 'src/core/god.js'), 'utf8');
  const rendSrcAj = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
  const mainSrcAj = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const keysRaw = (godSrcAj.match(/export const SB_KEYS = \[([^\]]*)\];/) || ['', ''])[1];
  const sbKeys = [...keysRaw.matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  const stepsRaw = (rendSrcAj.match(/const SB_STEPS = \{([\s\S]*?)\};/) || ['', ''])[1];
  const stepKeys = [...stepsRaw.matchAll(/(?:^|[{\s,])([a-z]+)\s*:\s*\[/g)].map(m => m[1]);
  const missing = sbKeys.filter(k => !stepKeys.includes(k));
  const extra = stepKeys.filter(k => !sbKeys.includes(k));
  check('9aj① `SB_KEYS` 每一枚旋钮在 `SB_STEPS` 都有档位（缺 = 面板 `for…of undefined` 直接炸）',
    sbKeys.length >= 6 && missing.length === 0,
    missing.length ? `缺档位 ${missing.join('/')}` : `${sbKeys.length} 枚全覆盖`);
  check('9aj② `SB_STEPS` 无表外多余键（与 `SB_KEYS` 键集严格相等）',
    extra.length === 0, extra.length ? `多余 ${extra.join('/')}` : '无多余');
  /* 每档必须是**非空数组**（空数组不抛，但渲染出一排没有按钮的空行 = 静默失灵）。 */
  const empty = stepKeys.filter((k, i) => !/\[[^\]]/.test((stepsRaw.match(new RegExp(k + '\\s*:\\s*(\\[[^\\]]*\\])')) || ['', '[]'])[1]));
  check('9aj③ 每枚旋钮的档位表都非空', empty.length === 0, empty.join('/') || '全部非空');
  /* `SB_DEFAULT` 的键集同样必须与 `SB_KEYS` 相等（缺键 ⇒ 预设回填 `undefined` ⇒ NaN 落进状态）。 */
  const defRaw = (godSrcAj.match(/export const SB_DEFAULT = \{([^}]*)\};/) || ['', ''])[1];
  const defKeys = [...defRaw.matchAll(/([a-z]+)\s*:/g)].map(m => m[1]);
  const defMissing = sbKeys.filter(k => !defKeys.includes(k));
  check('9aj④ `SB_DEFAULT` 覆盖全部 `SB_KEYS`（缺键 ⇒ 预设回填 NaN）',
    defMissing.length === 0, defMissing.join('/') || '全覆盖');
  /* 四组预设也必须逐键齐全（`onSbPreset` 按 `SB_KEYS` 逐键读 `p.sb[k]`）。 */
  const presetsRaw = (godSrcAj.match(/export const SB_PRESETS = \[([\s\S]*?)\n\];/) || ['', ''])[1];
  const presetBodies = [...presetsRaw.matchAll(/sb:\s*\{([^}]*)\}/g)].map(m => m[1]);
  const presetBad = presetBodies
    .map((b, i) => ({ i, miss: sbKeys.filter(k => !new RegExp(k + '\\s*:').test(b)) }))
    .filter(x => x.miss.length);
  check('9aj⑤ 每组世界预设 `sb` 覆盖全部 `SB_KEYS`（缺键 ⇒ 该旋钮回默认、预设语义漂）',
    presetBodies.length === 4 && presetBad.length === 0,
    presetBad.map(x => `#${x.i} 缺 ${x.miss.join('/')}`).join(' | ') || `${presetBodies.length} 组齐全`);

  /* ⑥「进主菜单不许有浮窗残留」（2026-10-09 用户要求）—— 静态锚在**入口唯一性**上：
     浮窗圆钮 / 面板挂在 `document.body`（不在 `#app`），`openMenu` 里的 `closePicker` 够不着；
     而 `updateFloat` 只在 `draw()` 里跑、回菜单那几个入口又都停了钟 ⇒ 之后再没有一帧。
     所以每个弹菜单的入口都必须走 `openMenuClean`（它 `openMenu` ＋ `updateFloat(null, null)`）。
     ⚠️ 咬的是「main.js 里没有裸 `openMenu(` 调用」——比逐个入口点断言更耐重构。 */
  /* ⚠️ 先把 `openMenuClean` 的函数体剥掉再数 —— 它内部那一声 `openMenu(opts)` 是**预期**的。 */
  const noClean = mainSrcAj.replace(/function openMenuClean\(opts\) \{[\s\S]*?\n\}/, '');
  const bare = [...noClean.matchAll(/(^|[^A-Za-z])openMenu\(/g)].length;
  check('9aj⑥ main.js 弹主菜单一律走 `openMenuClean`（无裸 `openMenu(`，否则浮窗残留在菜单上）',
    mainSrcAj.includes('function openMenuClean(opts) {')
    && mainSrcAj.includes('openMenu(opts);')
    && mainSrcAj.includes('updateFloat(null, null);')
    && bare === 0, bare ? `裸调用 ${bare} 处` : '入口唯一');
  /* 档案 / 回顾两支同样在 `try` 外 return，浮窗得**就地**摘（历史上正是这里漏出「档案页叠浮窗」）。 */
  check('9aj⑥ 档案 / 回顾两支都就地 `updateFloat(null, null)`（`try` 外提前 return，漏了必残留）',
    /if \(arch\) \{ updateFloat\(null, null\)/.test(mainSrcAj)
    && /if \(rv\) \{ updateFloat\(null, null\)/.test(mainSrcAj));
}

/* ═══════════════════ 9ak · 上帝「新闻源与事件」总闸（2026-10-09 扩容） ═══════════════════
   「新闻源」扩名成「新闻源与事件」：上帝关（`s.god.noRealNews` 默认 true）⇒ 全部史实事件注入
   一起熄火 —— 新闻播报 ×4 / extFlow / 交易所停机（播报＋只平不开）/ 被盗削减 / 交易所归零 /
   破产预警遮罩 / K 线锚点刻度。普通局与挑战局无 `s.god` ⇒ 闸恒开，口径与真实历史逐位一致
   （普通局停机/被盗的史实行为另由 §2.2 / §11 / 本节④⑥ 咬住）。 */
section('9ak · 上帝「新闻源与事件」总闸：普通/挑战照常 · 上帝关 ⇒ 全部熄火');
{
  const readSrcAk = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const engSrcAk = readSrcAk('src/core/engine.js');
  const renderSrcAk = readSrcAk('src/ui/render.js');
  const mainSrcAk = readSrcAk('src/main.js');

  /* ① 结构：总闸导出 ＋ 引擎全部闸口 ＋ render/main 随扩名 */
  check('9ak① 结构：eventsOff 导出 ＋ 引擎七处闸口（extFlow/播报/停机播报/停机限制/归零/被盗/预警）',
    /export function eventsOff\(s\) \{\s*return !!\(s\.god && s\.god\.noRealNews\);\s*\}/.test(engSrcAk)
    && engSrcAk.includes('const extFlow = eventsOff(s) ? 0 :')
    && engSrcAk.includes('if (!eventsOff(s)) {')                       // 4 条新闻播报
    && engSrcAk.includes('if (!eventsOff(s)) for (const h of ex.halts || []) {')   // 停机播报
    && engSrcAk.includes('if (!eventsOff(s) && haltedAt(timeOf(s), s.ex)) {')      // 停机限制
    && engSrcAk.split('if (!eventsOff(s)) for (const ex of EXCHANGES) {').length >= 3  // 归零＋被盗
    && engSrcAk.includes('if (s.hintOn && !eventsOff(s)) {'));          // 破产预警遮罩
  check('9ak② render：停机状态词 / K 线锚点刻度随总闸熄火 ＋ 面板行改「新闻源与事件」',
    renderSrcAk.includes('!eventsOff(s) && haltedAt(now, s.ex)')
    && renderSrcAk.includes('anchors: !eventsOff(s),')
    && renderSrcAk.includes("el('i', null, '新闻源与事件')"));
  check('9ak③ main：开关日志文案随扩名更新（关/开两条）',
    mainSrcAk.includes('新闻源与事件已关闭') && mainSrcAk.includes('新闻源与事件已开启'));

  /* ② 行为：BitMEX 停机窗口（2020-03-13 02:00–03:00）—— 普通局拒 / 上帝关事件放 */
  const openAt = async (t, godOn) => {
    const s = await mk({ sym: 'BTC', mode: 'margin', i: idx(t) });
    s.ex = 'bitmex'; s.lev = 1;
    s.books.bitmex = { usd: 1000, usdt: 1000 };
    if (godOn) god.enableGod(s);
    return { s, r: engine.openTrade(s, 'long') };
  };
  {
    const A = await openAt(at(2020, 2, 13, 2), false);
    const B = await openAt(at(2020, 2, 13, 3), false);
    check('9ak④ 普通局：停机窗口内拒「停机维护」/ 恢复即放（史实口径不变，与 §11 互证）',
      !A.r.ok && /停机维护/.test(A.r.why || '') && B.r.ok);
    const G = await openAt(at(2020, 2, 13, 2), true);
    check('9ak⑤ 上帝关事件：同一停机窗口可开仓（停机这条史实事件被真正关闭）',
      G.r.ok && G.s.god.noRealNews === true, G.r.ok ? 'ok' : `拒(${G.r.why})`);
  }

  /* ③ 行为：Bitfinex 被盗削减（B21 · 2016-08-02 普损 36.067%）—— 普通局照削、上帝关事件不动账 */
  {
    const run = async (godOn) => {
      const s = await mk({ sym: 'BTC', mode: 'margin', i: idx(at(2016, 7, 2)) - 1 });
      s.books.bitfinex = { usd: 1000, usdt: 1000 };
      if (godOn) god.enableGod(s);
      engine.advanceOneHour(s);              // 跨到 2016-08-02 00:00 那一根
      return { book: s.books.bitfinex, hacked: (s.log || []).some(l => /被盗/.test(l.text || l.msg || '')) };
    };
    const N = await run(false);
    const G = await run(true);
    check('9ak⑥ 普通局：被盗日普损 36.067% 照削 ＋ 有播报（B21 史实口径不变）',
      Math.abs(N.book.usd - 639.33) < 1e-6 && Math.abs(N.book.usdt - 639.33) < 1e-6 && N.hacked,
      `usd=${f(N.book.usd, 2)} usdt=${f(N.book.usdt, 2)} log=${N.hacked}`);
    check('9ak⑦ 上帝关事件：被盗日余额分文不动 ＋ 无播报',
      G.book.usd === 1000 && G.book.usdt === 1000 && !G.hacked,
      `usd=${f(G.book.usd, 2)} usdt=${f(G.book.usdt, 2)} log=${G.hacked}`);
  }

  /* ④ 行为：破产预警遮罩（Mt.Gox 2014-02-25 warn 锚点前 7 天）—— 普通局（hintOn）弹、上帝关事件不弹。
     ⚠️ 上帝支先 `enableGod`（它会把 hintOn 强制关掉）再显式开回 hintOn —— 隔离出 `eventsOff` 这一道闸。 */
  {
    const warnI = idx(at(2014, 1, 25)) - 7 * 24;
    const run = async (godOn) => {
      const s = await mk({ sym: 'BTC', mode: 'margin', i: warnI - 1 });
      s.hintOn = true;
      if (godOn) { god.enableGod(s); s.hintOn = true; }
      engine.advanceOneHour(s);
      return { pending: s.pending, warnAt: s.warnAt };
    };
    const N = await run(false);
    const G = await run(true);
    check('9ak⑧ 普通局（hintOn）：Mt.Gox 前 7 天弹破产预警遮罩（v11 口径不变）',
      N.pending === 'warn' && N.warnAt === idx(at(2014, 1, 25)),
      `pending=${N.pending} warnAt=${N.warnAt}`);
    check('9ak⑨ 上帝关事件：同一时刻不弹预警（遮罩也是史实利空事件的播报）',
      G.pending == null && G.warnAt == null,
      `pending=${G.pending} warnAt=${G.warnAt}`);
  }
}

/* ═══════════════════ 9al · 玩家仓位可见性 ＋ 插针预算同源（2026-10-09） ═══════════════════
   用户四问落地的三条改动：① 插针「预算用尽」根因 = 预算冻结在启动时刻、而 q 逐根随深度
   旋钮（自动档 ×1~×8）重算 ⇒ 自动档几根烧穿；修为预算与 q 同源取**当前**本时深度，且
   「预算用尽 / 时长用尽」分开播报。② 玩家仓位上浮窗：热力图「你」条 / 巨鲸置顶行 /
   订单页强平价格标记（playerPosOf 与持仓条同源）。③ 玩家自己的强平 minTier=0 强制上 tape
   （小仓在深市年代永远够不着 0.1% 阈值 ⇒ 旧口径日志页看不到自己爆仓）。 */
section('9al · 玩家仓位可见性（热力图/巨鲸/订单/tape）＋ 插针预算同源');
{
  const readSrcAl = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const engSrcAl = readSrcAl('src/core/engine.js');
  const renderSrcAl = readSrcAl('src/ui/render.js');
  const styleSrcAl = readSrcAl('src/ui/style.css');

  /* ① 结构：插针预算与 q 同源 ＋ 两类中止分开播报 ＋ 启动态不再带冻结 cap */
  check('9al① 插针预算：逐根取当前 hourLiqBase（深度旋钮不再提前烧穿）＋ 预算/时长分开播报',
    engSrcAl.includes('const base = hourLiqBase(s, pin.sym, s.i);\n  const q = Math.max(MANIP_MIN, MANIP_PIN.qStep * base);')
    && engSrcAl.includes('pin.n > MANIP_PIN.maxN * base')
    && engSrcAl.includes('插针中止 ｜ 预算用尽，已停止')
    && engSrcAl.includes('插针中止 ｜ 时长用尽，已停止')
    && !engSrcAl.includes('cap: MANIP_PIN.maxN * base'));

  /* ② 结构：playerPosOf 派生 ＋ 三页标记 ＋ 样式三族 ＋ 沙盒标签带当前值 */
  check('9al② 玩家仓位上浮窗：热力图「你」条 / 巨鲸置顶行 / 订单页强平格标记 ＋ you 样式',
    renderSrcAl.includes('function playerPosOf(s)')
    && renderSrcAl.includes('god-hm-bar ${r.l.side} you')
    && renderSrcAl.includes("'god-frow2 you'")
    && renderSrcAl.includes("r.you ? '你 '")
    && renderSrcAl.includes('you: isYou,')   // 2026-10-09 强平名义注入：isYou 同时决定标记与加量
    && styleSrcAl.includes('.god-hm-bar.you') && styleSrcAl.includes('.god-frow2.you')
    && styleSrcAl.includes('.gb-row.you i'));
  check('9al③ 沙盒旋钮标签带当前值（预设的非档位值如 ×1.4 / +0.12 玩家可见）',
    renderSrcAl.includes("const sbLabel = key === 'mood'")
    && renderSrcAl.includes("row.append(el('i', null, sbLabel));"));

  /* ③ 行为：玩家小仓强平也上 tape（2021-04-14 开 10x 多 $100K 名义 ⇒ 04-18 崩盘打爆；
     名义 ≪ 0.1% 日流动性（≈$10M+）⇒ 旧口径 tier=−1 被丢，新口径 minTier=0 强制入带 t=0）。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e5, i: idx(at(2021, 3, 14)) });
    s.lev = 10;
    const o = engine.openTrade(s, 'long', 1);
    let saw = false;
    for (let h = 0; h < 24 * 30 && !saw; h++) {
      engine.advanceOneHour(s);
      if (s.over || s.pending) { if (s.pending) s.pending = null; }
      saw = (s.feed || []).some(x => x.k === 4 && x.n < 2e6 && x.t === 0);
    }
    check('9al④ 行为：玩家 $1M 小仓爆仓上 tape（k=4 · n<2M · t=0 强制档）—— 旧口径会被 0.1% 阈值丢掉',
      saw && o.ok, o.ok ? (saw ? 'feed 命中' : '30 天内未爆仓（行情判据漂移，查 2021-04 K 线）') : `开仓拒(${o.why})`);
  }
}

/* ═══════════════════ 9am · 假新闻年代门控（2026-10-09 审计「假新闻年代口径」§四） ═══════════════════
   选条前 `manipTplsOf(key, timeOf(s))` 过滤 —— 裸字符串全期可用，`{ t, from }` 锚定史实首发日。
   审计锚（§四.4）：① 四采样点过滤池无越期禁词；② 池大小下限（保「连按不重样」的量）；
   ③ 条目唯一；④ 引擎行为：2013 年播报不含越期词；⑤ 门控边界逐位判定。 */
section('9am · 假新闻年代门控：四采样点禁词 ＋ 池下限 ＋ 唯一性 ＋ 引擎行为');
{
  /* 禁词按采样点分级：越期词 = 该时刻「按史实还不可能出现」的叙事关键词。
     ⚠️ 「链上」不作禁词 —— 2013-03 双花分叉事故即史实，链上检测叙事不算穿帮（god.js ⑤组注）。 */
  const SAMPLES = [
    { at: Date.UTC(2013, 5, 15), ban: ['ETF', '永续', '资金费率', '上市公司', '巨鲸地址', '活跃地址', '交易所储备', '支付巨头', '评级机构', '零手续费', '主网', '对冲基金', '主流指数', '官方采用', '储备方案', '稳定币'] },
    { at: Date.UTC(2015, 5, 15), ban: ['ETF', '永续', '资金费率', '上市公司', '巨鲸地址', '活跃地址', '交易所储备', '支付巨头', '评级机构', '零手续费', '主网', '对冲基金', '主流指数', '官方采用', '储备方案'] },
    { at: Date.UTC(2019, 5, 15), ban: ['ETF', '上市公司', '支付巨头', '官方采用', '储备方案', '主流指数'] },
    { at: Date.UTC(2023, 5, 15), ban: ['ETF 单日净流入', 'ETF 单日净流出', 'ETF 审批'] },
  ];
  for (const { at, ban } of SAMPLES) {
    for (const key of ['good', 'bad']) {
      const pool = god.manipTplsOf(key, at);
      const hit = ban.filter(w => pool.some(t => t.includes(w)));
      check(`9am① ${key} @ ${new Date(at).toISOString().slice(0, 10)}：过滤池无越期禁词 ＋ 池 ≥20 ＋ 条目唯一`,
        hit.length === 0 && pool.length >= 20 && new Set(pool).size === pool.length,
        hit.length ? `越期词 ${hit.join('/')}` : `池 ${pool.length} 条`);
    }
  }
  /* ② 引擎行为：2013-06 开上帝连发 6 条假新闻（利好利空交替），播报全过门控。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e8, i: idx(at(2013, 6, 15)) });
    god.enableGod(s);
    s.god.inf = true; s.god.lastFill = 1e9;
    const ban = SAMPLES[0].ban;
    const texts = [];
    for (let k = 0; k < 6; k++) {
      const r = engine.godFakeNews(s, 'BTC', k % 2 ? -1 : 1);
      if (r.ok) texts.push(s.log[0].text);        // 播报必须当场取（同 9ah④）
      for (let h = 0; h < 9; h++) engine.advanceOneHour(s);
    }
    const hit = texts.filter(t => ban.some(w => t.includes(w)));
    check('9am② 引擎行为：2013 年连发 6 条假新闻全部过门控（无越期词 ＋ 含币符号）',
      texts.length === 6 && hit.length === 0 && texts.every(t => t.includes('BTC')),
      hit.length ? hit.join(' | ') : `${texts.length} 条全净`);
  }
  /* ③ 门控边界：`time == from` 可出场、`from − 1ms` 不出场（`>=` 判定，逐位）。 */
  {
    const g = god.MANIP_NEWS.good.find(e => typeof e !== 'string' && e.from === Date.UTC(2016, 4, 13));
    const before = god.manipTplsOf('good', Date.UTC(2016, 4, 13) - 1).includes(g.t);
    const on = god.manipTplsOf('good', Date.UTC(2016, 4, 13)).includes(g.t);
    check('9am③ 边界：`time == from` 可出场、`from − 1ms` 不出场（`>=` 判定）', !before && on);
  }
}

/* ═══════════════════ 9an · 交易所收入回流管道（2026-10-09 审计「资金回流」§二） ═══════════════════
   玩家侧费用先落 `s.exRev` 一本账，每小时 `exRevSweep` 分流：10% → `s.fund`（入流封顶）、
   5% → 护盘储备（capRes 封顶）、85% = 运营利润。无玩家自洽由构造保证（收入源全是玩家/上帝侧
   动作 ⇒ 无玩家 exRev 恒 0 ⇒ sweep no-op ⇒ NPC 世界逐位不变）。 */
section('9an · 回流管道：费用落账 · 每小时分流逐位 · 双封顶 · 无玩家恒 0');
{
  const readSrcAn = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const engSrcAn = readSrcAn('src/core/engine.js');
  const cfgSrcAn = readSrcAn('src/core/config.js');
  const stSrcAn = readSrcAn('src/core/state.js');

  /* ① 结构：sweep 接线（NPC 刻度之前）＋ rewindTo 清零 ＋ state 播种 ＋ 七个收入落点 ＋ 比例 */
  check('9an① 结构：exRevSweep 进 advanceOneHour（插针伺服之前）＋ rewindTo 清零 ＋ state 播种 exRev',
    engSrcAn.includes('exRevSweep(s);\n\n  /* 插针剧本伺服')
    && engSrcAn.includes('s.exRev = 0;')
    && stSrcAn.includes('exRev: 0,'));
  check('9an② 七个收入落点齐全（开/平仓费 · OTC 溢价×2 · 转账费 · 借贷利息 · 上帝吃单/跟风单 · 洗售）',
    engSrcAn.includes('exCharge(s, fee);                     // 手续费进交易所收入账')
    && engSrcAn.includes("if (otc) exCharge(s, notional * cost / (1 + (side === 'long' ? 1 : -1) * cost));")
    && engSrcAn.includes('if (otc) exCharge(s, notional * cost);')
    && engSrcAn.includes('exCharge(s, fee);                                    // 转账费进交易所收入账')
    && engSrcAn.includes('exCharge(s, fee);                      // 借贷利息进交易所收入账')
    && engSrcAn.includes('exCharge(s, notional * p.feeRate);   // 手续费部分进交易所收入账')
    && engSrcAn.includes('exCharge(s, fee);                    // 洗售双边手续费全额进交易所收入账'));
  check('9an③ config：EXREV 总回流 15%（fundShare 0.10 ＋ dipShare 0.05，∈ 审计区间 10~20%）',
    cfgSrcAn.includes('fundShare: 0.10') && cfgSrcAn.includes('dipShare: 0.05'));

  /* ② 行为：开＋平手续费落账 ＋ sweep 分流**逐位直测**（导出直调，免端到端被护盘买压反馈污染）。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e7, i: idx(at(2021, 5, 10)) });
    s.lev = 5;
    engine.openTrade(s, 'long', 0.5);
    engine.closeTrade(s, '手动', 1);
    const rev = s.exRev;
    check('9an④ 行为：开＋平手续费精确落进 exRev（>0 ＋ 与 realized 里的费用同源）', rev > 0, `rev=${f(rev, 2)}`);
    /* 直调 sweep：预置 fund / dipRes（有限值 ＋ 远低于各自封顶）⇒ 分流逐位 = rev × 比例。
       单币局（mkt 只有 BTC）⇒ 摊给 BTC 的份额 = b 全额。 */
    s.fund = 1e6; s.mkt.BTC.dipRes = 1e6;
    engine.exRevSweep(s);
    check('9an④′ sweep 逐位：fund +10% ＋ dipRes +5% ＋ 账本清零 ＋ 其余 85% 不落账',
      Math.abs(s.fund - 1e6 - rev * 0.10) < rev * 1e-12 + 1e-6
      && Math.abs(s.mkt.BTC.dipRes - 1e6 - rev * 0.05) < rev * 1e-12 + 1e-6
      && s.exRev === 0,
      `Δfund=${f(s.fund - 1e6, 2)} Δdip=${f(s.mkt.BTC.dipRes - 1e6, 2)} rev=${f(rev, 2)}`);
  }

  /* ③ 双封顶（存量不动口径）：基金存量高于软上限 ⇒ 入流全耗散不缩水；dipRes 顶格 ⇒ 回补全耗散。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e7, i: idx(at(2021, 5, 10)) });
    s.lev = 5;
    engine.openTrade(s, 'long', 0.5); engine.closeTrade(s, '手动', 1);
    const rev = s.exRev;
    s.fund = 1e12;                                    // ≫ 软上限（Σ liqDay × 2%）⇒ 入流必须全耗散
    const dip0 = s.mkt.BTC.dipRes = 1e12;             // ≫ capRes ⇒ 回补必须全耗散
    engine.exRevSweep(s);
    check('9an⑤ 双封顶：基金存量超额时入流全耗散（存量不动）＆ dipRes 顶格时回补全耗散',
      s.fund === 1e12 && s.mkt.BTC.dipRes === dip0 && rev > 0,
      `fund=${f(s.fund, 0)} dip=${f(s.mkt.BTC.dipRes, 0)}`);
  }

  /* ④ 洗售费精确落账（godManipWash 返回的 fee == exRev 增量，逐位）。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e7, i: idx(at(2021, 5, 10)) });
    god.enableGod(s); s.god.inf = true; s.god.lastFill = 1e9;
    const r = engine.godManipWash(s, 'BTC', 1e6);
    check('9an⑥ 上帝洗售双边手续费精确落账（exRev == 返回的 fee）',
      r.ok && s.exRev === r.fee, `fee=${f(r.fee || 0, 2)}`);
  }

  /* ⑤ 无玩家自洽：纯 NPC 推进 48h ⇒ exRev 恒 0（sweep no-op ⇒ NPC 世界逐位不变）。 */
  {
    const s = await mk({ sym: 'BTC', i: idx(at(2021, 5, 10)) });
    for (let h = 0; h < 48; h++) engine.advanceOneHour(s);
    check('9an⑦ 无玩家 48h：exRev 恒 0（费用源全是玩家/上帝侧动作 ⇒ 回流管道休眠）',
      s.exRev === 0, `exRev=${s.exRev}`);
  }
}

/* ═══════════════════ 9ao · 现实地板 ＋ 订单簿潜在基线（2026-10-09 三修） ═══════════════════
   ① 上帝局价格乘数现实地板（`SHOCK.godFloor`）：NPC 世界层照夹 fallMax/riseMax（沙盒 ×3 的
   级联不许把市值砸到 $0.1 / 枚数爆出流通量），玩家层不夹（2026-10-07 拍板不动），地板 0.01 兜底；
   ② 订单簿潜在基线（`latentOf`）：空桶不是 0 —— 做市商底仓恒正、买厚卖薄（用户口径「价格越低
   买盘越多、上方薄但非零」）；③ 日志页过滤行固定（`.gfd-list` 固定高，按钮不随内容跳）。 */
section('9ao · 现实地板 godFloor ＋ 潜在基线 latentOf ＋ 步进行固定');
{
  /* ① 纯函数：任何价距恒正 ＋ 方向不对称（买厚卖薄、买远增厚、卖远缓降）。 */
  {
    const sigma = 0.035, cap = 0.25, liq = 1e7, price = 120, step = 0.2;   // 2013 BTC 量纲
    let allPos = true, bMid = 0, bFar = 0, aMid = 0, aFar = 0, bAllGe = true;
    for (let i = 1; i <= 400; i++) {
      const nb = engine.latentOf(sigma, cap, liq, price, price - (i + 1) * step, price - i * step, -1);
      const na = engine.latentOf(sigma, cap, liq, price, price + i * step, price + (i + 1) * step, 1);
      if (!(nb > 0) || !(na > 0)) { allPos = false; break; }
      if (nb < na) bAllGe = false;
      if (i === 5) { bMid = nb; aMid = na; }
      if (i === 200) { bFar = nb; aFar = na; }
    }
    check('9ao① latentOf：贴中 1~400 格恒 > 0 ＋ 同价距买 ≥ 卖', allPos && bAllGe);
    check('9ao② latentOf：买侧随价距增厚（支撑聚集）＆ 卖侧远档更薄但不真空',
      bFar > bMid && aFar > 0 && aFar < aMid,
      `b ${f(bMid, 0)}→${f(bFar, 0)} · a ${f(aMid, 0)}→${f(aFar, 0)}`);
    check('9ao③ latentOf：退化输入（缺 σ/非正带）回落不抛', engine.latentOf(NaN, cap, liq, price, 119, 120, -1) > 0
      && engine.latentOf(sigma, cap, liq, price, 120, 120, -1) === 0);
  }
  /* ② 行为：沙盒 ×3 上帝局纯 NPC 推进 ⇒ 级联被夹（factor ≥ 1+fallMax）；玩家巨额 flow ⇒ 地板兜底。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e8, i: idx(at(2013, 8, 1)) });
    god.enableGod(s);
    s.god.inf = true; s.god.lastFill = 1e10;
    s.god.liqMul = 8;
    s.god.sb = { ...god.SB_DEFAULT, heat: 3, npc: 3, shock: 3, res: 3, lob: 3 };
    let minF = Infinity;
    for (let h = 0; h < 720; h++) {
      engine.advanceOneHour(s);
      if (s.over) break;
      const fq = god.factorFor(s, 'BTC', s.i);
      if (fq < minF) minF = fq;
      if (fq < god.SHOCK.godFloor - 1e-12) { minF = fq; break; }
    }
    check('9ao④ 沙盒 ×3 级联：NPC 世界层照夹 ⇒ factor ≥ 1+fallMax（不再 1e-9）',
      minF >= 1 + god.SHOCK.fallMax - 1e-9, `minF=${f(minF, 4)}`);
    /* 玩家自己砸穿：地板兜底在 0.01（−99%，LUNA/FTT 级小时极值），不是 1e-9。 */
    god.addFlow(s, 'BTC', -0.9);                                         // 玩家层巨额永久位移（uncapped）
    const fFloor = god.factorFor(s, 'BTC', s.i);
    check('9ao⑤ 玩家层不夹但现实地板兜底（factor ≥ 0.01）',
      fFloor >= god.SHOCK.godFloor - 1e-12, `f=${f(minF, 4)} → ${f(fFloor, 4)}`);
  }
  /* ③ 源断言：地板常量 ＋ NPC 层夹 ＋ 渲染基线填充 ＋ 日志列表固定高。 */
  {
    const godSrcAo = fs.readFileSync(path.join(ROOT, 'src/core/god.js'), 'utf8');
    const engSrcAo = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
    const rendSrcAo = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
    const styleSrcAo = fs.readFileSync(path.join(ROOT, 'src/ui/style.css'), 'utf8');
    check('9ao⑥ 结构：SHOCK.godFloor = 0.01 ＋ factorFor NPC 层照夹（普通局整段夹不变）',
      godSrcAo.includes('godFloor: 0.01,')
      && godSrcAo.includes('const npcC = Math.min(SHOCK.riseMax, Math.max(SHOCK.fallMax, npcPart));')
      && godSrcAo.includes('if (!s.god) return shockFactorOf(playerPart + npcPart, false);')
      && godSrcAo.includes('return Math.max(f, SHOCK.godFloor);'));
    check('9ao⑦ 结构：render 空桶填 latentOf ＋ 买卖比含基线 ＋ 日志列表固定高',
      rendSrcAo.includes('const base = o ? o.notional : latent(k, dir);')   // 2026-10-09 强平注入改形：base ＋ isYou 加量
      && rendSrcAo.includes('aUsd += oa ? oa.notional : latent(ka, 1);')
      && rendSrcAo.includes("list.style.height = `${maxRows * rowH}px`;")
      && styleSrcAo.includes('.gfd-list { overflow-y: auto;'));
  }
}

/* ═══════════════════ 9ap · 做空供应量上限（§9.5 重启 · 2026-10-09 三拍板） ═══════════════════
   借币池 = 真实流通量 × MARGIN.shortShare（1%——GDD 原表 5/8/10% 会被流动性闸永久遮蔽，联网核实
   现实借币峰值 ≈ 流通量 0.034%）；硬拒（同额度闸 UX）＋ marginRateMulOf 的 kink/jump 费率飙升段
   （借满池 → 乘数 25× → 借币日息 2017 档 0.5%/日 = GDD 原设极值）。只限杠杆空头；NPC 不占池；
   OTC 豁免 —— 与 quota 闸同口径。 */
section('9ap · 做空供应量上限：硬拒 · 费率 jump · 同口径范围');
{
  const cfgSrcAp = fs.readFileSync(path.join(ROOT, 'src/core/config.js'), 'utf8');
  const engSrcAp = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
  check('9ap① 结构：shortShare 1% ＋ kink/jump ＋ openCheck 供应闸（只卡空头）＋ marginRateMulOf jump 段',
    cfgSrcAp.includes('shortShare: 0.01,') && cfgSrcAp.includes('kink: 0.8,') && cfgSrcAp.includes('jump: 12,')
    && engSrcAp.includes("return { ok: false, why: `做空供应量不足 ｜ 全市场可借 ≈ ${fmtQty(supDay * MARGIN.shortShare)} 枚（流通量 1%）` };")
    && engSrcAp.includes('if (pos && pos.side === \'short\' && isMargin(pos)) {')
    && engSrcAp.includes('if (useSup > U.kink) mul += U.jump * Math.min(1, (useSup - U.kink) / (1 - U.kink));'));
  /* ② 行为：把流动性闸临时调大隔离出供应闸 —— 超过流通量 1% 的杠杆空头被拒、以内放行。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'margin', cash: 1e9, i: idx(at(2013, 8, 1)) });
    const saveQuota = C.MARGIN.quota;
    C.MARGIN.quota = 1e9;                                   // 隔离流动性闸，单测供应闸
    s.lev = 5;
    const sup = market.supplyAt('BTC', Math.floor(s.i / 24));
    const capUsd = sup * 0.01 * engine.lastPrice(s, 'BTC');
    const over = engine.openTrade(s, 'short', 0.02);        // $2e7 × 5x ≫ 供应闸 ⇒ 必拒
    const ok = engine.canOpenAt(s, 'short', 0.000001);      // $5e3 ≪ 供应闸 ⇒ 放行
    /* 长仓不受供应闸约束（借美元）——趁流动性闸仍被隔离时测小单 */
    const longOk = engine.canOpenAt(s, 'long', 0.000001);
    C.MARGIN.quota = saveQuota;
    check('9ap② 硬拒：超流通量 1% 的杠杆空头被拒（why 带可借枚数）· 小单放行',
      over.ok === false && /做空供应量不足/.test(over.why) && ok === true,
      `cap≈$${f(capUsd, 0)} over=${over.ok ? 'ok' : over.why.slice(0, 30)}`);
    check('9ap③ 同口径：多头（借美元）不受供应闸约束', longOk === true);
  }
  /* ③ 费率 jump：杠杆空头借入逼近池上限 ⇒ 乘数越过 kRate 上界（jump 生效）；多头恒 ≤ 上界。
     ⚠️ heat 归一 0.5（stress 0 ⇒ 无恐慌抽贷），隔离出 jump 段的贡献。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'margin', cash: 1e9, i: idx(at(2017, 8, 1)) });
    s.mkt.BTC.heat = 0.5;
    const sup = market.supplyAt('BTC', Math.floor(s.i / 24));
    const capUsd = sup * 0.01 * engine.lastPrice(s, 'BTC');
    /* 空头仓位：名义 = 池的 99%（kink 之上 ⇒ jump 段开火）与 30%（kink 之下 ⇒ 无 jump）
       ⚠️ 手工仓必须带 `isMargin: true`（`borrowedOf` / `isMargin` 的判据字段）。 */
    const big = { sym: 'BTC', side: 'short', notional: capUsd * 0.99, margin: capUsd * 0.99 / 5, lev: 5, isMargin: true, entry: engine.lastPrice(s, 'BTC'), size: (capUsd * 0.99) / engine.lastPrice(s, 'BTC'), openFee: 0, ex: s.ex, mix: { usd: 1, usdt: 0 }, otc: false, liqCounted: false };
    const small = { ...big, notional: capUsd * 0.30, margin: capUsd * 0.30 / 5, size: (capUsd * 0.30) / engine.lastPrice(s, 'BTC') };
    const long = { ...big, side: 'long' };
    s.positions.BTC = big;
    const mulBig = engine.marginRateMulOf(s, 'BTC');
    s.positions.BTC = small;
    const mulSmall = engine.marginRateMulOf(s, 'BTC');
    s.positions.BTC = long;
    const mulLong = engine.marginRateMulOf(s, 'BTC');
    delete s.positions.BTC;
    const mulNone = engine.marginRateMulOf(s, 'BTC');
    check('9ap④ 费率 jump：空头借入 99% 池 ⇒ 乘数越过 kRate 上界（jump 生效）；30% 池 ⇒ 无 jump',
      mulBig > 1 + C.MARGIN.util.kRate + 1e-9 && mulSmall <= 1 + C.MARGIN.util.kRate + 1e-9,
      `99%→${f(mulBig, 2)}× 30%→${f(mulSmall, 2)}×`);
    check('9ap⑤ 范围：多头不进 jump 段（≤ kRate 上界）＆ 无仓常态乘数恒 1',
      mulLong <= 1 + C.MARGIN.util.kRate + 1e-9 && mulNone === 1,
      `long=${f(mulLong, 2)} none=${f(mulNone, 2)}`);
  }
}

/* ═══════════════════ 9aq · tape 保留窗口 ＋ 强平价挂单注入（2026-10-09 三拍板） ═══════════════════ */
section('9aq · tape 3 日保留窗口 ＋ 订单簿强平价注入');
{
  /* ① 行为：超龄条目被窗口裁掉（3 日 = 72h）、新鲜条目保留、FEED_CAP 1200 硬顶仍在。 */
  {
    const s = await mk({ sym: 'BTC', i: idx(at(2021, 5, 10)) });
    s.feed = [
      { i: s.i - 73 * 24, sym: 'BTC', k: 0, p: 5e4, n: 1e7, t: 4 },   // 73 天前 ⇒ 必须被裁
      { i: s.i - 2 * 24, sym: 'BTC', k: 2, p: 5e4, n: 1e7, t: 3 },    // 2 天前 ⇒ 留
      { i: s.i - 1, sym: 'BTC', k: 4, p: 5e4, n: 1e7, t: 4 },         // 1 小时前 ⇒ 留
    ];
    engine.feedPush(s, 'BTC', 0, 5e4, 1e7, 0);                        // 推一根触发窗口扫描
    check('9aq① tape 保留窗口：>72h 的开平爆仓记录被裁、窗口内保留（超出显示数量由显示层截断）',
      s.feed.length === 3 && s.feed.every(r => r.i >= s.i - 3 * 24),
      `留存 ${s.feed.length} 条`);
  }
  /* ② 源断言：强平价格注入玩家名义（NPC 量＋玩家量同格）＋ 买卖比不计条件单 ＋ 你 标记沿用。 */
  {
    const rendSrcAq = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
    check('9aq② 订单簿：强平价格 = NPC 挂单 ＋ 玩家强平名义（多头砸买盘/空头买卖盘，几何自动对侧）＋ 买卖比不计',
      rendSrcAq.includes('const isYou = you && k === youK;')
      && rendSrcAq.includes('const notional = base + (isYou ? you.pos.notional : 0);')
      && rendSrcAq.includes('买卖比不计它（那是「将会发生」的条件单，不是已挂的流动性）'));
    /* ③ 保证金率口径锚（2026-10-09 联网核实）：`marginRateOf = 权益 ÷ 名义` 属「资金方向」口径
       —— >100% = 超额抵押 / 浮盈丰厚，现实合法（Bybit IM Rate ≥100% 只是不能再加仓、
       Aave 超额抵押 120–150%）；本作借入归零 ⇒ 无强平线（instrumentOf 翻 perp）已处理。
       UI 不封顶、不改码 —— 断言公式注释在场，防将来口径漂移。 */
    const posSrcAq = fs.readFileSync(path.join(ROOT, 'src/core/positions.js'), 'utf8');
    check('9aq③ 保证金率口径：权益/名义（资金方向）—— >100% = 超额抵押合法态，不封顶',
      posSrcAq.includes('保证金率 = 仓位权益 / 名义价值')
      && posSrcAq.includes('export function marginRateOf(pos, price) {'));
  }
}

/* ═══════════════════ 9ar · 扫单 ＋ 目标价（2026-10-09 三批拍板「一键吃单开关」） ═══════════════════ */
section('9ar · 扫单 godEatBook ＋ 目标价 godTargetPush ＋ 自动伺服');
{
  /* ① 扫单行为：手工布簿 → 一口吃光该侧（离散单清空）→ 费用进 exRev（回流管道）→ 对侧不动。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e9, i: idx(at(2021, 5, 10)) });
    god.enableGod(s);
    s.god.inf = true; s.god.lastFill = 1e11;
    engine.tickMarket(s, 'BTC');                    // 冷启动生成活簿
    const b = s.lob.BTC;
    check('9ar① 前置：冷启动后离散簿非空', Array.isArray(b.asks) && b.asks.length > 0,
      `asks=${b.asks.length} bids=${b.bids.length}`);
    const sumA = b.asks.reduce((a, r) => a + r.n, 0), nB = b.bids.length;
    s.exRev = 0;
    const r = engine.godEatBook(s, 'BTC', 1);
    check('9ar② 扫单：吃光卖盘（ate = 求和 ＋ 该侧清空 ＋ 买侧原样）',
      r.ok && Math.abs(r.ate - sumA) < 1e-6 && b.asks.length === 0 && b.bids.length === nB,
      `ate=${f(r.ate, 0)}`);
    check('9ar③ 扫单费用进交易所收入账（exRev > 0，回流管道口径）', s.exRev > 0, `exRev=${f(s.exRev, 0)}`);
  }
  /* ② 目标价行为：二分反解的名义实推位移 ≥ 目标（99% 口径），返回 sat 语义与名义回读。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e9, i: idx(at(2021, 5, 10)) });
    god.enableGod(s);
    s.god.inf = true; s.god.lastFill = 1e11;
    engine.tickMarket(s, 'BTC');
    const r = engine.godTargetPush(s, 'BTC', 1, 0.03);
    check('9ar④ 目标价：+3% 反解名义后实推位移 ≥ 2.97%（名义回读 ＋ 非饱和）',
      r.ok && r.impact >= 0.03 * 0.999 && r.n >= 1000 && !r.sat,
      `n=${f(r.n, 0)} impact=${f(r.impact, 4)}`);
    const r2 = engine.godTargetPush(s, 'BTC', -1, 0.03);
    check('9ar⑤ 反方向同款（砸 3%）', r2.ok && r2.impact <= -0.03 * 0.999,
      `impact=${f(r2.impact, 4)}`);
  }
  /* ③ 自动伺服：s.god.eat 开着 ⇒ advanceOneHour 每根吃光（吃一根清一侧，下一根回填再吃）。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e9, i: idx(at(2021, 5, 10)) });
    god.enableGod(s);
    s.god.inf = true; s.god.lastFill = 1e11;
    engine.tickMarket(s, 'BTC');
    s.god.eat = { dir: 1, sym: 'BTC' };
    const asks0 = s.lob.BTC.asks.length;
    engine.advanceOneHour(s);
    const clearedOnce = s.lob.BTC.asks.length < asks0;
    engine.advanceOneHour(s);
    engine.advanceOneHour(s);
    check('9ar⑥ 自动扫单：每根伺服（首根清空卖盘，后续回填-再吃循环不炸）',
      clearedOnce && s.over !== true, `asks ${asks0}→${clearedOnce ? 0 : '?'} → ${s.lob.BTC.asks.length}`);
  }
  /* ④ 源断言：UI 三行 ＋ main 派发 ＋ bind 键表 ＋ advanceOneHour 伺服挂点。 */
  {
    const rendSrcAr = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
    const mainSrcAr = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
    const bindSrcAr = fs.readFileSync(path.join(ROOT, 'src/ui/bind.js'), 'utf8');
    const engSrcAr = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
    check('9ar⑦ 结构：扫单/目标价三行 UI ＋ main 派发与处理器 ＋ bind 键表 ＋ godEatTick 伺服挂点',
      rendSrcAr.includes("eatAuto.dataset.godeatauto = '';")
      && rendSrcAr.includes("b.dataset.godtgt = `1:${pct / 100}`;")
      && mainSrcAr.includes('return onGodEat(d.godeat !== undefined ? Number(d.godeat) : null);')
      && mainSrcAr.includes('function onGodTarget(dir, pct) {')
      && bindSrcAr.includes("'godeat',") && bindSrcAr.includes("'godtgt',")
      && engSrcAr.includes('godEatTick(s);'));
  }
}

/* ═══════════════════ 9as · 自动化伺服 ＋ 自动新闻币种权重（2026-10-10 拍板） ═══════════════════ */
section('9as · 自动新闻（币种权重）＋ 自动造量 ＋ 自动拉盘 ＋ 互斥');
{
  /* ① 币种权重：BTC（大流动性）显著多于 DOGE（小流动性），且两者都抽得到（5% 地板）。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e9, i: idx(at(2021, 5, 10)) });
    await market.loadCoin('DOGE');
    engine.tickMarket(s, 'DOGE');
    check('9as① 前置：两币都在 s.mkt 里', !!s.mkt.BTC && !!s.mkt.DOGE,
      `keys=${Object.keys(s.mkt).join(',')}`);
    const cnt = {}; let badSym = '';
    const i0 = s.i;
    for (let h = 0; h < 600; h++) {
      s.i = i0 + h;                                  // 逐小时推进（不改世界，只测抽样）
      const sym = engine.autoNewsSym(s);
      if (!(sym in s.mkt)) { if (!badSym) badSym = `h=${h} sym=${sym}`; }
      cnt[sym] = (cnt[sym] || 0) + 1;
    }
    const nB = cnt.BTC || 0, nD = cnt.DOGE || 0;
    check('9as② 权重：BTC（大流动性）抽取次数显著多于 DOGE（小流动性）',
      nB > nD * 1.5, `BTC=${nB} DOGE=${nD}`);
    check('9as③ 5% 地板：小币仍抽得到（DOGE 命中 > 0）且不抽未上市币',
      nD > 0 && badSym === '', badSym || `DOGE=${nD}/600`);
  }
  /* ② 单币 / 空 mkt 退化：不抛、返回 s.sym。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e9, i: idx(at(2013, 6, 1)) });
    check('9as④ 退化：只有 BTC 时恒返回 BTC', engine.autoNewsSym(s) === 'BTC');
    const s2 = await mk({ sym: 'BTC', mode: 'fut', cash: 1e9, i: idx(at(2013, 6, 1)) });
    s2.mkt = {};
    check('9as⑤ 退化：s.mkt 为空 ⇒ 退回 s.sym（不抛）', engine.autoNewsSym(s2) === 'BTC');
  }
  /* ③ 自动造量：开 autoWash 跑一根 ⇒ 假量入账（m.pv）；关掉不产生。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e9, i: idx(at(2021, 5, 10)) });
    god.enableGod(s);
    s.god.inf = true; s.god.lastFill = 1e11;
    engine.tickMarket(s, 'BTC');
    s.god.autoWash = true; s.god.autoWashSym = 'BTC';
    /* ⚠️ 直调伺服（**不** `advanceOneHour`）—— 推进时钟会让 `tickMarket` 把 m.pv 结算清零，
       测不到「这一根洗了多少」（2026-10-10 测试口径修）。 */
    engine.godAutoTick(s);
    check('9as⑥ 自动造量：伺服一根 ⇒ 有假量（m.pv 入账）', (s.mkt.BTC.pv || 0) > 0,
      `pv=${(s.mkt.BTC.pv || 0).toExponential(2)}`);
  }
  /* ④ 自动拉盘：开 autoPump=+1 跑若干根 ⇒ 价格上移；且与 autoWash 互斥（引擎单点）。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e9, i: idx(at(2021, 5, 10)) });
    god.enableGod(s);
    s.god.inf = true; s.god.lastFill = 1e12;
    engine.tickMarket(s, 'BTC');
    const p0 = engine.lastPrice(s, 'BTC');
    s.god.autoPump = 1; s.god.autoPumpSym = 'BTC'; s.god.lastPush = 2e8;
    for (let h = 0; h < 3; h++) engine.advanceOneHour(s);
    check('9as⑦ 自动拉盘：连续伺服 ⇒ 价格上移（组合拳持续推）',
      engine.lastPrice(s, 'BTC') > p0, `p0=${f(p0, 0)} → ${f(engine.lastPrice(s, 'BTC'), 0)}`);
    /* 互斥：autoPump 开着时 autoWash 分支不进（同根不双倍洗售）—— 用 swap 计数间接验证。 */
    const src = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
    check('9as⑧ 互斥：拉盘开着时造量分支短路（`!g.autoPump && g.autoWash`）',
      src.includes('if (!g.pin && !g.autoPump && g.autoWash) {'));
  }
  /* ⑤ 自动新闻：autoNews 开 ⇒ 到点播报一条 + 重排 12~36h；方向开关生效。 */
  {
    const s = await mk({ sym: 'BTC', mode: 'fut', cash: 1e9, i: idx(at(2021, 5, 10)) });
    god.enableGod(s);
    s.god.inf = true; s.god.lastFill = 1e11;
    engine.tickMarket(s, 'BTC');
    s.mkt.BTC.heat = 0.5;
    s.god.autoNews = 1; s.god.autoNewsAt = s.i;      // 立刻到点
    const i0 = s.i;
    engine.advanceOneHour(s);
    /* ⚠️ `advanceOneHour` 先推进 `s.i` 再跑伺服 ⇒ `newsAt` 落在 `i0 + 1`（不是在 i0）——
       断言按真实时序写（2026-10-10 测试口径修）。 */
    check('9as⑨ 自动新闻：到点播报一条（newsAt 落位）＋ 下次时刻重排在 12~36h',
      Number.isFinite(s.god.newsAt) && s.god.newsAt >= i0 && s.god.newsAt <= i0 + 1
      && Number.isFinite(s.god.autoNewsAt) && s.god.autoNewsAt >= i0 + 12 && s.god.autoNewsAt <= i0 + 37,
      `newsAt=${s.god.newsAt}（i0=${i0}） next=${s.god.autoNewsAt} (Δ=${s.god.autoNewsAt - i0}h)`);
    /* 混合方向：用 `newsN.good/bad` 的增量判方向（文案本身不含「利好/利空」字样）；
       ⚠️ 每次清 `newsAt` 绕开 8h 冷却（这里测的是「方向随机」而非「冷却」）。 */
    const dirSet = new Set();
    s.god.autoNews = 0;
    for (let h = 0; h < 80; h++) {
      s.god.autoNewsAt = s.i;
      s.god.newsAt = null;
      const g0 = s.god.newsN ? s.god.newsN.good : 0;
      const b0 = s.god.newsN ? s.god.newsN.bad : 0;
      engine.godAutoTick(s);
      const g1 = s.god.newsN ? s.god.newsN.good : 0;
      const b1 = s.god.newsN ? s.god.newsN.bad : 0;
      if (g1 > g0) dirSet.add(1); else if (b1 > b0) dirSet.add(-1);
      s.i += 24;                                     // 每次跳一天（远离冷却窗）
    }
    check('9as⑩ 混合方向：autoNews=0 时两个方向都会被抽到（非恒一元）',
      dirSet.size === 2, `观测方向 = {${[...dirSet].join(',')}}`);
  }
  /* ⑥ 源断言：挂点 + rewindTo 清 autoNewsAt + 三个开关读法。 */
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/engine.js'), 'utf8');
    check('9as⑪ 结构：godAutoTick 进 advanceOneHour（扫单之后）＋ rewindTo 清 autoNewsAt ＋ 导出 autoNewsSym',
      src.includes('godAutoTick(s);\n\n  /* NPC 情绪 / 踩踏级联')
      && src.includes('s.god.autoNewsAt = null;')
      && src.includes('export function autoNewsSym(s) {')
      && src.includes('export function godAutoTick(s) {'));
    const rendSrcAs = fs.readFileSync(path.join(ROOT, 'src/ui/render.js'), 'utf8');
    check('9as⑫ 结构：god 浮窗盘中轻刷新（syncGodLive 定点改文本/disabled，不重建整块）',
      rendSrcAs.includes('function syncGodLive(panel, s) {')
      && rendSrcAs.includes("if (inst.id === 'god') syncGodLive(inst.panel, s);")
      && rendSrcAs.includes("panel.querySelectorAll('[data-lvnews]')")
      && rendSrcAs.includes("panel.querySelector('[data-lvcd]')")
      && rendSrcAs.includes("panel.querySelector('[data-lveta]')")
      && rendSrcAs.includes("panel.querySelectorAll('[data-lvpin]')")
      && rendSrcAs.includes("panel.querySelectorAll('[data-lvwash]')"));
  }
}

/* ═══════════════════ 总账 ═══════════════════ */
section('总账');
console.log(`通过 ${pass} · 失败 ${fail}`);
if (bad.length) { console.log('阻塞项：'); for (const b of bad) console.log('  ✗ ' + b); }
process.exitCode = fail ? 1 : 0;
