# 交易模块口径审计：强平价连续性 / 强平退款 / HUD 准确性

## Summary

用户提出两件事：

1. **是否新增一套 NPC 持仓账本？** —— 逐条核对后结论是 **不新增**（用户已确认走「不新增，只做审计修复」）。理由见下「Part A 结论」。
2. **强平价越过开仓价时，HUD 各面板是否仍然正确？** 要求详细检查所有交易模块，口径贴近现实、实时准确。

本轮实际要做的（Part B）是 3 处真实缺陷修复 + 1 处展示不准确 + 审计断言：

| # | 缺陷 | 文件 |
|---|------|------|
| 1 | 保证金被资金费抽干后 `maintRateOf` 在 `margin = 0` 处**突跳**（强平价不连续） | `src/core/positions.js` |
| 2 | `forceLiquidate` 用「维持保证金那一格」当残余权益 ⇒ 权益已 ≤ 0 时**凭空退款**给玩家、并给保险基金加幻影钱 | `src/core/engine.js` |
| 3 | K 线图上「强平价」标签**永远贴在开仓线的 y**，与实际价格不符 | `src/ui/chart.js` |
| 4 | 审计靶场缺这些口径的断言（禁止假绿） | `tools/sim-audit.mjs` |

---

## Part A 结论：不加 NPC 持仓账本（有据）

现有链路**已经**实现了「玩家成交推动 NPC 净持仓」，且 NPC 盈亏已有归属：

```
openTrade / closeTrade / forceLiquidate / partialLiquidate
        └─ pushFlow(..., player=true)  →  mkt[sym].pv  += 本笔名义      (engine.js:973)
                    │
        tickMarket 每小时把 pv 当**放大器**喂热度                        (engine.js:2095-2104)
                    │
        NPC 六档靶心 target = sb.npc × NPC.mom × (heat − HEAT.base) × liqDay  (engine.js:2123)
                    │
        stepNpc → npcNet(m)                                              (engine.js:1288)
                    ├─→ syncNpcDrift   （价位偏移）                      (engine.js:1577)
                    ├─→ longShareOf    （资金费拥挤度）                  (engine.js:1331)
                    └─→ npcFund        （对手方池结算）                  (engine.js:3884-3885)

NPC 自己的已实现盈亏 → flushSlot → fundSettle → s.fund（保险基金）
```

再叠一条显式的「反向吸收腿」账本，会在 `pushFlow`（价格冲击）与 `longShareOf`（资金费拥挤度）上**把同一份成交计价两次**；而且数学上「把对手方镜像计入多空比」会让全市场口径**必然回到 50/50**（这正是 `retailLongShareOf` 被拆出来的原因，见 `engine.js:1366-1372`）。⇒ **不加。**

⚠️ 唯一仍缺的是「玩家已实现盈亏没有对手方承担」（`closeTrade` 直接 `credit`），但用户此前已明确否决为玩家盈亏引入会被掏空的池子（现实零和、交易所不因池空限制提盈）。本方案不动它。

---

## Current State Analysis（Part B）

### 缺陷 1 · 维持线在保证金被抽干处突跳

- `settleFunding` 逐小时无条件 `pos.margin -= fee`（[engine.js:3856](file:///f:/Cr3aM/Desktop/Degen/src/core/engine.js#L3852-L3861)、[engine.js:3902](file:///f:/Cr3aM/Desktop/Degen/src/core/engine.js#L3902-L3906)），没有下限 ⇒ `pos.margin` 可为 **0 或负**。
- [effLevOf](file:///f:/Cr3aM/Desktop/Degen/src/core/positions.js#L279-L284)：`margin <= 0` 时 **snap 回 `pos.lev`**。
- [maintRateOf](file:///f:/Cr3aM/Desktop/Degen/src/core/positions.js#L333-L338)：`open = 1 / effLevOf(pos)` ⇒ 正常侧 `margin→0+` 时 `open→∞`、`maint = 0.5×open → 0`；一旦 `margin ≤ 0`，`effLev` 突然变小、`open` 变大、退化护栏失效 ⇒ **`maint` 跳回正常档**。

数值例（多头，`entry=100`、`notional=1000`、`size=10`、`lev=10`、Bitfinex 杠杆 `m=0.15`）：

| `pos.margin` | `effLevOf` | `maintRateOf` | `liquidationPrice` |
|---|---|---|---|
| `+1` | 1000 | 0.0005 | 99.95（< 开仓价） |
| `→ 0+` | → ∞ | → 0 | → **100.0** |
| `0`（snap 生效） | 10 | 0.004 | **100.4**（突跳 +0.4） |
| `−1` | 10 | 0.004 | 100.5 |

⇒ 这正是用户描述的「资金费一直付 ⇒ 强平价往上移并超过开仓价」在不连续处的那一帧。

⚠️ 澄清：**「多头强平价高于开仓价」本身不是 bug**（现实中被抽保证金/欠费时确实如此）。要修的是它**不连续**，以及下游按不连续值算账。

### 缺陷 2 · 强平退款可能凭空造钱

[forceLiquidate](file:///f:/Cr3aM/Desktop/Degen/src/core/engine.js#L3068-L3079)：

```js
const remain = maintRateOf(pos) * pos.notional;   // ← 当作「触发时的残余权益」
const feeRate = borrowedOf(pos) > 0 ? LIQ.feeMargin : LIQ.fee;
const back = Math.max(0, remain - pos.notional * feeRate);
s.fund += remain - back;
```

真实残余权益是 `equityOf(pos, atPrice) = pos.margin + pnlOf(pos, atPrice)`。两者在**正常档**满足恒等式：
`equityOf(pos, liquidationPrice(pos)) ≡ maintRateOf(pos) × pos.notional`（可直接代入展开验证）。
但一旦 `equity ≤ 0`（`margin` 被抽干 / `frac == 1` 的强打路径），`maintRateOf(pos)×notional` 仍是个**正数**：

- 杠杆仓（`maint = 15%`、`LIQ.feeMargin = 1.25%`、`config.js:561`）⇒ `back ≈ 13.75% × 名义` 凭空退回给玩家，`s.fund` 同时被加上这笔幻影钱。
- 永续默认档 `maint = 0.5% = LIQ.fee` ⇒ `back = 0`，**逐位不变**（所以这个洞只在杠杆仓 / 高名义档暴露）。

### 缺陷 3 · 图上强平价标签位置不准确

[chart.js:446-463](file:///f:/Cr3aM/Desktop/Degen/src/ui/chart.js#L446-L463)：标签挂在**开仓线的 y**（`ty`）。强平价与开仓价不同 y 时（哪怕二者都在可视区内），读数会被贴到错的位置 —— 与用户「实时、准确」的要求不符。

### 展示层其余核对结论（**无需改**）

- 未实现盈亏走 `unrealizedOf`（标记价）⇒ 与强平价无关，**不会算错**；持仓条 / 持仓列表按符号上色（[render.js:1012-1015](file:///f:/Cr3aM/Desktop/Degen/src/ui/render.js#L1012-L1015)、[render.js:1411-1425](file:///f:/Cr3aM/Desktop/Degen/src/ui/render.js#L1411-L1425)）✅
- ROE 已有 `m > 0` 护栏（[render.js:1422](file:///f:/Cr3aM/Desktop/Degen/src/ui/render.js#L1422)、[render.js:1717](file:///f:/Cr3aM/Desktop/Degen/src/ui/render.js#L1717)）✅
- 持仓条第三格「保证金率」与弹层的「保证金率/强平价」都读同一份 `marginRateOf` / `liquidationPrice`，同源无重复实现 ✅
- `adjustMargin` 的减仓下限用 `equityOf − PARTIAL_TARGET×maint×notional`（[engine.js:2851-2852](file:///f:/Cr3aM/Desktop/Degen/src/core/engine.js#L2851-L2852)），margin ≤ 0 时自然退化到 0 ✅

---

## Proposed Changes

### 改动 1 — `src/core/positions.js`：维持线在保证金 ≤ 0 时归零（连续收敛）

**What**：`maintRateOf` 在算完 `m`、算 `open` 之前插入一行护栏。

**How**（[positions.js:333-338](file:///f:/Cr3aM/Desktop/Degen/src/core/positions.js#L333-L338)）：

```js
export function maintRateOf(pos) {
  const lv = Math.max(1, pos.lev || 0);
  const m = maintRateAt(pos.ex, pos.notional, instrumentOf(pos), lv);
  /* 保证金已被资金费 / 利息抽干（≤ 0）⇒ 视为无维持线（立刻强平）。
     ⇒ 强平价连续收敛：`margin→0+` 时 `0.5/实际杠杆 → 0`，`margin=0` 时正好取到 0
       （强平价 ≡ 开仓价），不再在 0 处突跳；`margin<0` 时强平价 = `entry + dir×(−margin)/size`。
     ⚠️ 正常仓（margin > 0）逐位不变；不变量 `maint < 1/实际杠杆` 仍然成立（0 < 1/lev）。 */
  if (!(pos.margin > 0)) return 0;
  const open = 1 / effLevOf(pos);
  return m < open ? m : open * MAINT_MAX_SHARE;
}
```

**Why**：这是把现有退化护栏（`MAINT_MAX_SHARE`）**连续延拓过 0 点**，不动正常格定价；`reduceFraction` 因 `goal = 1.1×0 = 0` 走 `return 1` ⇒ 直接全平，符合「保证金已耗尽」的现实处置。

**Why not 改 `effLevOf`**：让它返回 `Infinity` 会污染 `lvTagOf`（日志印 `Infinityx`）与持仓条倍数显示。只改 `maintRateOf` 是最小影响面。

### 改动 2 — `src/core/engine.js`：强平退款改用真实残余权益

**What**：`forceLiquidate` 的 `remain` 换成触发价上的真实权益。

**How**（[engine.js:3069](file:///f:/Cr3aM/Desktop/Degen/src/core/engine.js#L3068-L3079)）：

```js
/* 残余权益 = 触发价上的**真实权益**（保证金 ＋ 未实现盈亏），不是「维持保证金那一格」。
   ⚠️ 恒等式：在**强平价上** `equityOf(pos, liqPrice) ≡ maintRateOf(pos) × notional`
      ⇒ 正常档（触线即平）逐位等价；但跳空越过强平价、滑价更远、权益已 ≤ 0、
      或保证金被资金费抽干时两者不等 —— 旧式会按「维持那一格」凭空退款。
   ⚠️ 权益 ≤ 0 ⇒ remain = 0 ⇒ 退款 0、保险基金不再收幻影钱、穿仓缺口为坏账。 */
const remain = Math.max(0, equityOf(pos, atPrice));
```

`back` / `s.fund += remain - back` / `s.realized -= pos.margin - back` 三行**保持不动**（语义自动修正）。
`equityOf` 已在 [engine.js:24](file:///f:/Cr3aM/Desktop/Degen/src/core/engine.js#L24) 导入，无需改 import。

**同时更新该函数头注**（[engine.js:3055-3067](file:///f:/Cr3aM/Desktop/Degen/src/core/engine.js#L3055-L3067)）里 B20 那段：把「残余权益 ＝ 维持保证金率 × 名义」改成「＝ 触发价上的真实权益」，并写清「正常档逐位等价 / 权益 ≤ 0 时不再凭空退款」。
**并补一条注释**说明 `s.realized -= pos.margin - back` 在 `margin < 0` 时会把「逐小时多扣的那部分」还回来（让 `s.realized` 与真实现金变动保持对账），不是凭空加分。

### 改动 3 — `src/ui/chart.js`：强平价标签落在自己的 y

**What**：标签优先画在**强平价自己的 y**；只有强平价落在可视价格区之外时，才回落到开仓线的 y（保留「不贴画布边缘」的原有意图）。

**How**（[chart.js:455-463](file:///f:/Cr3aM/Desktop/Degen/src/ui/chart.js#L455-L463)）：

```js
if (Number.isFinite(liq)) {
  const lyRaw = yOf(liq);
  /* 强平价落在**本帧价格区可视范围内** ⇒ 标签挂在它自己的 y（读数与线对得上）；
     越界 ⇒ 回落到开仓线那一枚已成型的 y（`ty`），维持「不贴画布边缘」的原有约定。 */
  const ly = lyRaw >= top && lyRaw <= bot
    ? Math.round(clamp(lyRaw, top + 8, bot - 8)) + .5
    : ty;
  const ltag = '强 ' + axisLabel(liq);
  const lw = ctx.measureText(ltag).width + 6;
  ctx.fillStyle = T.DOWN;
  ctx.fillRect(0, ly - 8, lw, 16);
  ctx.fillStyle = '#1a0508';
  ctx.textAlign = 'left';
  ctx.fillText(ltag, 3, ly);
}
```

字号 / 颜色 / 字面（`强 ` + `axisLabel`）一律不变。⚠️ 只改标签 y，**不动开仓价的线/签**。

### 改动 4 — `tools/sim-audit.mjs`：新增一节断言（紧跟 `1c` 之后）

新增 `section('1d · 强平价连续性 / 强平退款口径（资金费抽干保证金）')`，逐条：

1. **连续性**：构造多头仓（Bitfinex 杠杆，`entry/notional/size/lev` 固定），`margin` 从 `+ε` 逐档降到 `−ε`（例如 `+1, +0.5, +0.1, +0.01, 1e-6, 0, −1e-6, −0.01, −1`）：
   - 断言相邻档 `liquidationPrice` 差 **单调、无跳变**（阈值取 `entry×1e-4` 量级，具体值在实现时按实测钉死）；
   - 断言 `margin = 0` 时 `liquidationPrice ≈ entry`（`|Δ| < 1e-9×entry`）；
   - 断言 `margin ≤ 0` 时 `maintRateOf(pos) === 0`。
2. **不变量**：对上述每一档断言 `maintRateOf(pos) < 1 / effLevOf(pos)`（与 1c 同一护栏口径）。
3. **无凭空退款（真引擎）**：走真引擎路径——
   - 开一笔永续多头 → 取 `s.positions.BTC`，**手工把 `pos.margin` 置为负值**（模拟资金费抽干）→ 记下 `s.fund`、`s.realized` → 调 `engine.advanceOneHour(s)` → 断言该仓已被强平、且 **`s.fund` 不因这一笔增加**、**`s.realized` 不因这一笔增加**（`s.realized` 的变化应等于 `+(-oldMargin)` 那条对账修正，不超过 `|oldMargin| + 手续费`）；
   - ⚠️ 用 `advanceOneHour` 而不是直接调 `forceLiquidate`（后者未导出）。
4. **恒等回归（证明改动 2 对正常档逐位等价）**：任取正常档仓位，断言
   `| equityOf(pos, liquidationPrice(pos)) − maintRateOf(pos) × pos.notional | < 1e-9 × pos.notional`。
5. **用户场景端到端**：开一笔永续多头，把时钟从某个资金费为负的时段推 200–500 小时，断言：
   - `advanceOneHour` 返回后，`s.positions` 中**不存在 `margin ≤ 0` 的仓**（有钱被抽干就必须已在同一小时内被强平）；
   - 全程不存在「`equityOf(pos, mark) ≤ 0` 且 `!canLiquidate(pos)`」的僵尸仓（扩展现有 `12F` 口径）。

⚠️ 不许用「只跑不炸」当通过；每一条都要有可证伪的数值判据。实现时先跑一遍把阈值调准，再定稿。

### 改动 5 — 注释同步（纯注释）

`positions.js` 的 `MAINT_MAX_SHARE` 段落补一句「本护栏在 `margin ≤ 0` 时取 0（见 `maintRateOf`）」，避免注释与代码不符。

---

## Assumptions & Decisions

1. **Part A 不做**（用户已确认）。理由见上，不需要新状态字段、不动存档形状、不升 `STATE_VERSION`。
2. **强平价高于开仓价不是 bug**：多头被抽保证金时现实中确实如此。本轮保证它**连续**，并保证 HUD 与账目在该状态下不撒谎。
3. **穿仓缺口为坏账**：权益 ≤ 0 时退款 0、保险基金不收幻影钱。不改 `LIQ.fee` / `LIQ.feeMargin` 数值（`config.js:561`）。
4. **不改 `effLevOf`**：避免 `Infinity` 污染日志与 UI 倍数显示。
5. **不改 `s.realized -= pos.margin - back` 的表达**：`margin < 0` 时的 `+` 是把逐小时多扣的还回去，与真实现金变动对账；只补注释。
6. **不改正常档行为**：改动 1 只命中 `margin ≤ 0`；改动 2 在「触线即平」的正常档与旧式**逐位等价**（有恒等式与断言 4 兜住）。
7. **不新增存档字段** ⇒ 不动 `STATE_VERSION`、不动 `save.js` 的 `SHAPE`。

## Verification

1. `node tools/sim-audit.mjs` → 期望 **失败 0**，通过数 ≥ 506 + 本轮新增条数。
2. `npm run build` → 通过。
3. 抽查改动真伪：
   - `grep -n "maintRateOf" src/core/positions.js` 确认护栏位置（`m` 之后、`open` 之前）；
   - `grep -n "const remain" src/core/engine.js` 确认已改为 `equityOf(pos, atPrice)`；
   - 手工复核断言 3 的 `s.fund` / `s.realized` 前后值（打印在 `detail` 里）。
4. `git commit`：中文、多条 `-m`、逐文件 `git add`（`src/core/positions.js`、`src/core/engine.js`、`src/ui/chart.js`、`tools/sim-audit.mjs`）、**不 push**。
