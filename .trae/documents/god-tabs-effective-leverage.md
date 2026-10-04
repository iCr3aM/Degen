# 上帝模式分页 ＋ 仓位「实际杠杆」口径修正

## Context（为什么做这件事）

用户实测反馈三点：

1. **上帝模式弹窗太长**：资金 / 跳到日期 / 沙盒三大块挤在一页，要求拆成两页 tab，并确保游戏内所有既有功能仍正常。
2. **1x 杠杆减少保证金后不显示强平价**，并质疑「1x 真的可以减少保证金吗？减保证金 ⇒ 杠杆必然上升」。
   - 「不显示强平价」是上一轮已修 bug 的同一处：UI 用 `canLiquidate(pos)` 当门槛（`render.js:1022` / `:1484` / `:2038`），而旧口径下 1x 多头恒为「不可强平」⇒ 恒填 `--`。根因已修（commit `38df8f5`），现在会显示。
   - **但暴露了更深的问题**：减保证金后 `pos.margin` 变小、`notional` 不变 ⇒ 仓位的真实杠杆已经上升，而界面仍显示开仓时冻结的 `pos.lev`（=1）⇒ 持仓条说「1x」，却同时给出强平价与保证金率，自相矛盾。
   - 结论（已确认）：**1x 减保证金是合法的**——抽走保证金 = 开始借钱 = 实际杠杆上升；引擎已在按 `borrowedOf = 名义 − 保证金` 计息/强平。
3. 要求梳理并修好**所有与交易有关的显示链路**。

## 决定（已与用户确认）

- **杠杆口径**：只新增**只读派生** `effLevOf(pos) = pos.notional / pos.margin`，**不重写** `pos.lev`。
  - 用途：① UI 显示真实杠杆；② `maintRateOf` / `safetyOf` 的维持档与参考值改用实际杠杆（强平价 / 安全垫更准）。
  - **保持不变**（避免玩法行为变化）：`shockKindOf(isMargin, pos.lev)` 的入参、杠杆按钮行的锁定逻辑（仍按开仓 `cur.lev`）、`marginBaseOf` 的固定基数。
- **上帝面板两页**：第 1 页「资金·时间」= 填入资金 ＋ 跳到日期；第 2 页「沙盒」= 5 枚旋钮 ＋ 世界预设 ＋ 种子。关闭按钮常驻底部。

## 改动清单

### 1. `src/core/positions.js` — 新增 `effLevOf`，维持率与安全垫改口径

- 新增 `export const effLevOf`（紧邻 `borrowedOf` / `instrumentOf`）：
  - 边界：`!(pos && pos.margin > 0 && pos.notional > 0)` ⇒ 退 `pos?.lev ?? 0`（避免 `Infinity/NaN`）。
  - 主式 `notional / margin`，但**必须 snap 到 `pos.lev`**：`|r − L| ≤ 1e-9 × max(1, L)` 时返回 `L`。
    - 理由：开仓时 `notional = margin × lev` 在 IEEE 下 `notional/margin` 可能差 1 ULP（如 `0.3/0.1 = 3.0000000000000004`），而 `binanceMarginMaint` 的档位判据是 `lev ≤ 3/5/10` —— 1 ULP 就会把 3x 从 `1.18` 档翻到 `1.15` 档。
    - snap 保证**未调整过保证金的仓位逐位不变**。
- `maintRateOf(pos)`：`const lv = effLevOf(pos);` → `maintRateAt(pos.ex, pos.notional, instrumentOf(pos), lv)`；`const open = 1 / lv;`，退化格仍返回 `open * MAINT_MAX_SHARE`。
  - 退化支恒返回 `0.5/effLev < 1/effLev` ⇒ **结构上不可能「开仓即强平」**；且「可承受跌幅 = `1/effLev − maint`」随 `effLev` 单调收窄 ⇒ 减保证金后强平线**确实更近**（方向正确）。
- `safetyOf(pos, price)`：`const open = 1 / effLevOf(pos);`（其余不动）。

### 2. `src/core/engine.js` — 无需改代码，但需复核连带项

- `marginBaseOf` **保持不变**（仍 `pos.notional / pos.lev` = 开仓保证金）。这是 2026-10-05 用户拍板的「固定基数」（避免连点时步长缩水），改它会破坏 `sim-audit` 13c 的 drift 断言，也不符合既定口径。
- `marginCapsOf` 的 `floorEquity = PARTIAL_TARGET * maintRateOf(pos) * pos.notional` 会自动吃到新 `maintRateOf`（被减过保证金的仓，可减上限随维持率变化）—— 复核其为有限非负即可。
- `adjustMargin` / `adjustCheck` / `openTrade` 加仓分支：**不改**。

### 3. `src/ui/render.js` — 持仓条与弹窗显示真实杠杆

- import 追加 `effLevOf`。
- 持仓条 `render.js:1006`：`const lv = effLevOf(p);` 文案 `${p.sym}${lv > 1 ? ` ${Math.round(lv * 10) / 10}x` : ''}`（保持「1x 不显示」；整数不显小数、非整数保留 1 位）。
- `openMarginDlg`（`:2034-2039`）：在「保证金」与「保证金率」之间新增一行 `实际杠杆`（同款格式化），让玩家一眼看到「减保证金 ⇒ 杠杆上升」。
- 更新两处已过时的注释 / 说明文案：`render.js:1019-1021`（1x 多头论述）、`render.js:2408`（「1x…不借不计息、不参与强平」需补「抽走保证金后即产生借入」）。
- `chart.js` **不改**：强平线走 `canLiquidate` ＋ `liquidationPrice`，已随上面自动正确。

### 4. 上帝模式两页 tab（`render.js` / `main.js` / `bind.js`）

- `main.js`：新增模块级 `let godPage = 0;`（比照现有 `godSel`）；打开面板处重置为 0；调 `openGod(s, godSel, godPage)`。
- `render.js:openGod`：签名改 `(s, sel = null, page = 0)`；`h3` 之后插一条页签行（`.set-row` 内两枚 `.set-btn`，当前页挂 `.on`，按钮挂 `data-godtab="0"/"1"`，文案「资金·时间」「沙盒」）。
- 容器切分：把原单一 `rows`（`.confirm-rows`）拆成**两个** `.confirm-rows`，A 页装 ①资金 ＋ ②日期，B 页装 ③沙盒；互斥切换用 **inline `el.style.display`**（`''` / `'none'`）—— 因为 `.godp .confirm-rows { display: grid }` 特异度高于 UA 的 `[hidden] { display: none }`，用 `hidden` 会失效。
- 关闭按钮（`data-godoff` / `data-sclose`）留在两页之外、常驻底部。
- `bind.js`：`ACTION_KEYS` 增 `'godtab'`；`main.js` 的派发层加 `if (d.godtab !== undefined) return onGodTab(node);`，新 `onGodTab(node)` 写 `godPage` 后重开面板。
- **输入框 `.god-cash` / `.god-seed` 仍不挂 `data-*`**（`bind.js` 会 `preventDefault`，挂上就打不了字），`readGodInput()` 不变。
- **`style.css` 不动**（复用现有 `.set-btn.on` 选中态与 `.set-row` 布局）。

## 验证

- `node tools/sim-audit.mjs` —— 期望全绿；**重点复核**：
  - §1/1b（liq 自洽）：未调整仓应逐位不变（snap 生效）。
  - §13c（`marginStepOf` 漂移）：因 `marginBaseOf` 未改，应保持原判据通过。
  - §12F（滚仓僵尸仓回归）：maintRate 改口径后重跑，僵尸小时仍须为 0、本局须自然收场。
  - §9h–9k（保险基金 / 清算费）：`maintRateOf` 参与残余权益，复核未受非预期影响。
- 新增断言（真实行为，禁止假绿）：
  - `effLevOf(pos) === pos.lev`（virgin 仓，**严格相等**）；任意仓 `|effLevOf − notional/margin| < 1e-9`。
  - 真引擎 `adjustMargin(s, 'BTC', -step)` 后 `effLevOf` **严格上升**（直接断言数值，不断言源码）。
  - virgin 仓 `maintRateOf` / `safetyOf` / `liquidationPrice` 与基线逐位一致（`< 1e-12`）。
  - 退化护栏：枚举 所 × 杠杆 的 virgin 仓，断言 `maintRateOf(pos) < 1/effLevOf(pos)`（杜绝开仓即强平）。
- `npm run build` 通过。
- 手动链路自检（代码级）：1x 开仓 → 减保证金 → 持仓条显示如 `5.6x`、可减按钮生效、K 线出现强平线、弹窗显示「实际杠杆 / 强平价」；上帝面板两页互切、资金 / 跳日期 / 沙盒 / 种子全部仍可用。
- 完成后 `git commit`（中文、多条 `-m`、逐文件 add、**不 push**）。

## 关键文件

- `src/core/positions.js`（`effLevOf` / `maintRateOf` / `safetyOf`）
- `src/ui/render.js`（持仓条 / 调整保证金弹窗 / 上帝面板分页 / 注释文案）
- `src/main.js`（`godPage` 暂存 / 派发 `onGodTab`）
- `src/ui/bind.js`（`godtab` 事件键）
- `tools/sim-audit.mjs`（新增 / 复核断言）
