# 方案 A · 对手方结算：让玩家已实现盈亏由对手方承担

## Context（为什么做）

用户要求：「我其实并不想让钱凭空出现，我想让游戏内无玩家的时候逻辑自洽，有来有回。
这样玩家进入市场的时候才能真正影响市场。」

审计已确认的现状（[engine.js:3029-3033](file:///f:/Cr3aM/Desktop/Degen/src/core/engine.js#L3029-L3033)）：

```js
const net = backMargin + pnl - fee;
credit(s, pos.ex, net, {...});   // 只有入账，没有任何配对扣款
```

- 玩家平仓**盈利** ⇒ `credit` 直接凭空造钱；**亏损** ⇒ 凭空销毁。全游戏只有**资金费**走
  `m.npcFund`（对手方池）是闭环的（审计 §14 已钉死其双向性与偿付上限）。
- 结果：玩家赚的钱没有出处，市场没有因为玩家赚钱而受损 ⇒ 玩家「不影响市场」。

**目标**：把 `m.npcFund` 从「资金费对手方池」升级为**对手方结算账户**，承接玩家全部已实现盈亏；
并给它一条**由市场自身驱动**的收入流，使无玩家时也有来有回。

---

## 核心口径（会计恒等式）

```
对手方池 Δ =  −玩家已实现盈亏
              −NPC 已实现盈亏（止损 / 止盈 / 减仓部分）
              + 资金费净额（现有：rate × npcN、玩家付出入池 / 收取出池）
池余额 < 0 ⇒ 保险基金 s.fund 补回 0      （现实：对手方穿仓 → SAFU 兜底）
池余额 > 上限 ⇒ 溢出转入 s.fund          （对手方盈利沉淀，池不无限膨胀）
```

四条纪律：
1. **`m.npcFund` 恒 ≥ 0**（现有不变量，审计 §7c / §9n / §14 依赖它）——由基金兜底保证。
2. **手续费不进池**（归交易所，本来就如此，不动）。
3. **保证金退回不进池**（是玩家自己的抵押品，本来就如此）。
   只有**毛盈亏 `pnl`** 参与对手方结算。
4. **强平盈亏仍走 `s.fund`**（`fundSettle`，现有口径不动）——避免与「止损/止盈进池」双重记账。

---

## 改动清单

### ① `src/core/engine.js` · `closeTrade`（L3015+）：玩家盈亏结算进池

在 `credit(...)` 之后、`s.realized +=` 附近插入：

```js
settlePlayerPnl(s, sym, pnl);   // 新增：pnl > 0 ⇒ 池付出；pnl < 0 ⇒ 池收入
```

新增内部函数 `settlePlayerPnl(s, sym, pnl)`（放在 `fundSettle` / `seedFund` 附近）：

- `const m = mktOf(s, sym);`（写路径，允许懒建）
- `m.npcFund -= pnl;`
- 下限：`if (m.npcFund < 0) { s.fund += m.npcFund; m.npcFund = 0; }`（基金可负，沿用现有设计）
- 上限：`const cap = poolCapOf(s, sym); if (m.npcFund > cap) { s.fund += m.npcFund - cap; m.npcFund = cap; }`
- `poolCapOf` 复用 `fundBaseOf` 同一把尺子（当日流动性 × `POOL.capFrac`），随年代自动缩放。

⚠️ 部分平仓（`frac < 1`）走同一分支，`pnl` 已是本笔的口径，无需额外处理。

### ② `src/core/engine.js` · NPC 已实现盈亏入池（无玩家时的收入流）

NPC 账本的 `long/short` 是**成本名义**（[engine.js:1231-1268](file:///f:/Cr3aM/Desktop/Degen/src/core/engine.js#L1231-L1268) 注释已明确）。
减仓那一刻的已实现盈亏：

- 多头减 `Δ`：`Δ × (现价 / longAvg − 1)`
- 空头减 `Δ`：`Δ × (1 − 现价 / shortAvg)`

**正 = NPC 赚 ⇒ 池付出；负 = NPC 亏 ⇒ 池收入。**

三处减仓点（穷举）：
| 位置 | 场景 | 处理 |
|---|---|---|
| `stepNpc`（L1533-1551） | 每小时靶心回归导致的减仓 | 减仓分支结算入池 |
| `flushSlot` 止损带（L1999-2006 / L2028-2035） | 散户自愿止损（平 50%） | 结算入池 |
| `flushSlot` 止盈带（L2007-2015 / L2036-2044） | 处置效应止盈（平 50%） | 结算入池 |
| `flushSlot` 强平分支（L1991-1996 / L2020-2025） | 跌破强平线全平 | **不改**，仍走 `fundSettle` → `s.fund` |

实现方式：`stepNpc` 增一个「结算回调」或直接返回本小时的 realised 值，由调用方（`tickMarket` ③③′）
累加后一次性写池 —— 避免在 `stepNpc` 里反向依赖 `mktOf`。`flushSlot` 已有 `m` 与 `sym` 参数，直接写池。

### ③ `src/core/engine.js` · `fundingForecastOf`（L1353-1360）：预测按池封顶

收钱侧（`fundingOf < 0` 且玩家有永续仓）返回
`receivable = min(|名义 × rate|, 池余)`，并在返回体加一个 `capped: boolean`（池不够时为 true）。
`settleFunding` 的实际结算逻辑**不动**（它本来就封顶）。

### ④ `src/ui/render.js` · 资金费读数旁补一枚池读数

在现有「资金费率 / 预计费率」那一行（约 L901-963）追加一小段 `对手方池 $X`；
池不足且玩家在收钱侧时该读数高亮或附加提示。**不新增面板**（LESS IS MORE）。
`view.js` / `main.js` 若已有该行的格式化入口则复用，不另开函数。

### ⑤ `src/core/config.js`（或 `positions.js` 常量区）· 新增 `POOL`

```js
export const POOL = { capFrac: 0.05 };   // 池上限 = 当日流动性 × 该值（与 INSURE.seed 同一把尺子）
```

数值依据：现实交易所对手方/清算缓冲量级为当日成交额的百分之几，与 `INSURE.seed = 0.02` 同档。
实施时按 12 年模拟复核一次量级，若池长期贴 0 或长期顶上限再调。

### ⑥ `tools/sim-audit.mjs` · 新增审计节 15（零和与自洽）

| 断言 | 内容 |
|---|---|
| 15a 零和（盈利） | 玩家平仓盈利 ⇒ `Δ现金 + Δ池 + Δ基金 = 0`（逐位，≤1e-6） |
| 15b 零和（亏损） | 玩家平仓亏损 ⇒ 池增加同一笔、现金减少同一笔 |
| 15c 池恒 ≥ 0 | 玩家巨幅盈利抽干池 ⇒ 池 = 0 且 `Δ基金 = −缺口` |
| 15d 上限溢出 | 玩家连续亏损把池顶到上限 ⇒ 溢出进基金，池 = cap |
| 15e 无玩家自洽 | 冻结玩家、推进 200 小时 ⇒ 池始终有限、非 NaN，且随 NPC 减仓变化（证明有收入流，而非恒 0） |
| 15f 预测 ≤ 实收 | `fundingForecastOf` 的预测收额 ≤ `settleFunding` 实收（不再高估） |
| 15g 锚点 | 源码锚点：`closeTrade` 内确有 `settlePlayerPnl` 调用；`fundSettle` 未被改动 |
| 15h 回归 | 现有 §14 / §9n / §7c 全绿（池 ≥ 0 不变量未被破坏） |

全部走**真引擎**（`openTrade` / `closeTrade` / `advanceOneHour`），不做源码正则假绿
（仅 15g 的「锚点」是刻意的源码断言，用于防回归删除）。

---

## 关键决策（已按「贴近现实」定，可否决）

1. **池耗尽时足额兑付、差额由 `s.fund` 兜**（而不是给玩家打折）
   —— 现实里交易所永远足额结算用户盈亏，兜底是 SAFU 的责任；打折会与日志「盈利 $X」自相矛盾。
2. **`s.fund` 允许为负**（现有设计，见 `INSURE` 注释）—— 负值语义 = 交易所层面的穿仓欠账。
3. **强平盈亏不进池**（仍进基金），只有自愿止损/止盈/减仓进池 —— 避免同一笔钱两边都记。
4. **字段名保留 `npcFund`**（不重命名）—— 审计与存档兼容成本最低；只改文档注释。
5. **不新增 NPC 账本字段、不升 `STATE_VERSION`** —— 沿用 `npcFund` / `advPush` / `intWin` 的懒建先例。

---

## 验证方式

```powershell
node tools/sim-audit.mjs     # 期望 ≥ 551 · 0（现有）＋ 新增 §15 全绿
npm run build                # 期望 ✓ built
```

量级复核（一次性，不入库）：跑 12 年模拟，采样 `m.npcFund` 与 `s.fund` 的分位，
确认池在 `[0, cap]` 内呼吸、不长期贴 0 / 贴顶；若贴顶则下调 `POOL.capFrac`。

完成后 `git commit`（逐文件 add、中文多条 `-m`、**不 push**）。

---

## 不做的事（边界）

- 不重写 `s.fund` 的现有进出（`fundSettle` / `adl` / `seedFund` 一个字不动）。
- 不新增玩家可见的大面板；不把 `s.fund` 暴露给玩家。
- 不改任何数值参数（`FR` / `INSURE` / `NPC` 全不动），只新增 `POOL.capFrac`。
- 不动存档版本号；旧档读到 `npcFund` 缺失时按 0 起算（现有懒建路径）。