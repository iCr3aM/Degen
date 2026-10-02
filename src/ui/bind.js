/**
 * 事件接线（唯一的点击入口）
 * ===============================================================
 * 用 `pointerdown` 而不是 `click`：按下那一刻就派发到命中元素上，不受松手位置影响。
 * 本版虽然不再每帧重建 DOM，但 K 线区每帧都在重绘、倍速档会在 `update()` 里被重建，
 * 用 `click` 仍然会在「按下 → 松手」之间被换掉的节点上丢事件。规矩沿用参考项目那一套。
 *
 * ⚠️ 保留 `click` 通道但**只处理 `detail === 0`**（键盘激活）—— 否则一次鼠标点击会跑两遍。
 */

/** 所有动作键。渲染出的 `data-*` 必须落在这里，否则点了没反应。 */
export const ACTION_KEYS = [
  'sym', 'ex', 'exok', 'exno', 'frac', 'lev', 'speed', 'act', 'pause', 'restart', 'wipe', 'mode',
  /* Batch 4：`settings`（顶栏第三枚）/ `reset`（面板内重开）/ `sclose`（关面板）
     / `intro`（开场弹窗的「开始交易」）
     Batch 5（B30）：`loan`（归零遮罩上的「借续命」/「就此收摊」）
     ⚠️ 原来的 `snd`（音效开关）已随 T-2 的「音量四档」整体删除（2026-10-01）——
        它被 `vol` 取代（`data-vol="0|1|2|3"`），所以这一条不再留在表里。 */
  'settings', 'market', 'reset', 'sclose', 'intro', 'loan',
  /* A6（方案 §6.4）：`tab` ＝ 底部 Tab 三条（交易 / 资产 / 设置）。
     ⚠️ `settings` **保留**（§9 B8）：顶栏那枚「设置」按钮已随 A6 撤掉，但设置页里
        将来仍可能复用它做一个「关」的出口 —— 现在页的出口就是底部 Tab，所以没有任何 DOM 挂它。 */
  'tab',
  /* 上帝模式：`god`（顶栏标题连点 5 次的隐藏入口）
     / `godcash` `godyear` `godmon` `godday` `godgo` `godoff`（上帝面板内的各枚按钮）
     ⚠️ 原来的 `godmult` `godscale` `godreset` 三枚已随上帝模式瘦身整体删除（2026-09-29）；
        `goddate` 随原生日期框一起删除，日期改由 `godyear` / `godmon` / `godday` 三排档位选择、
        `godgo` 才真正跳（2026-09-30）。 */
  'god', 'godcash', 'godyear', 'godmon', 'godday', 'godgo', 'godoff',
  /* U1（ROADMAP §21.4）：`mode2`（操作区「金额」行末尾那枚「杠杆 / 合约」模式键）。
     ⚠️ 用 `mode2` 而不是 `mode` —— `mode` 已被 K 线左上角那枚**粒度**小字占用（`main.js` 的 `d.mode`）。
     v9（§15.3 N4）：`buy` / `sell` ＝ 杠杆模式那两枚动作键（借 U 买入 / 借币卖出）。 */
  'mode2', 'buy', 'sell',
  /* v11（③）：`warn`（破产预警遮罩的那枚「知道了」）/ `hint`（设置页「新手提示」开关）。
     v11（⑤ · 方案 §20.2.1）：`log` ＝ **日志条整条**（点开日志浮层看全 30 条）。 */
  'warn', 'hint', 'log',
  /* 新手分步引导：`guide` ＝ 那张卡片上的「下一步 / 开始交易」。
     ⚠️ 漏进这张表 = 「点了没反应」—— `findActionEl` 只认 `ACTION_SELECTOR` 里出现过的键
     （本轮实测就是这个 bug：引导第一步之后再点「下一步」不走）。 */
  'guide',
  /* 需求 4（《主菜单与历史回顾模式方案》§2 / §3）：`menu` ＝ 主菜单各入口
     （`load` 读取存档 / `start` 开始 / `scen` 挑战 / `review` 回顾 / `careers` 档案 / `install` 安装）。
     2026-10-02 起 `load` / `scen` 只负责**弹一层**（`render.openSavePick` / `openScenPick`），
     选择在弹窗里发生 —— 菜单按钮不再随选择摊开而位移；
     `review` ＝ 回顾页的**全部**动作 —— 值是子命令（`exit` / `pause` / `spd:100` / `sym:BTC`
     / `years` / `year:2017` / `go` / `skip` / `all`），分派见 `main.js` 的 `onReview`。 */
  'menu', 'review',
  /* M2 交易档案（2026-10-01）：`careers` ＝ 档案页的动作 —— `exit`（顶栏「返回」）／
     `share:<id>`（每条生涯那枚「分享」，M4）。分派见 `main.js` 的 `dispatch`。 */
  'careers',
  /* M1 年代开局（2026-10-01）：`scen` ＝ 「挑战模式」弹窗里那五张年代卡，
     值是 `config.SCENARIOS[].id`（`winter` / `ico` / `pre312` / `degen` / `luna`），
     分派见 `main.js` 的 `onScenario`。 */
  'scen',
  /* v13（《资产页与手机端 UI 打磨方案》§3.1）：`buyu` ＝ 资产页「买 U」卡片上的
     三枚金额档（`0.25` / `0.5` / `1`）＋ 那枚「兑换」键（`go`）。
     B5：`colors` ＝ 设置页的「涨跌色」开关（绿涨红跌 ⇄ 红涨绿跌）。 */
  'buyu', 'colors',
  /* 资金曲线区间（用户 2026-10-01 拍板）：`eqrange` ＝ 资产页曲线上方那排档位键，
     值是「最近多少个游戏日」（`7` / `30` / `90` / `365` / `0`，`0` = 全部）。 */
  'eqrange',
  /* T-2（2026-10-01）：设置页那三排档位组 —— 值是档位下标（字符串）。
     `vol`（音量：0 关 / 1 小 / 2 中 / 3 大）／`vib`（震动：0 关 / 1 弱 / 2 强）／
     `fx`（动效：0 关 / 1 减弱 / 2 全）。 */
  'vol', 'vib', 'fx',
  /* 2026-10-03：`vibtest` ＝ 设置页「震动」那一行末尾的「试一下」自检键 —— 无视档位直接震
     一条加长模式，用来分辨「档位关着」与「手机/浏览器根本不震」（分派见 `main.js` 的 `onVibTest`）。 */
  'vibtest',
  /* 存档拆两槽（2026-10-01 用户要求）：
     `home` ＝ 设置页那枚「返回主菜单」（不 reload、不丢档，只把时钟停住再弹菜单）；
     `slot` ＝ 主菜单「读取存档」**弹窗**里那几行，值是槽位键（`normal` / `challenge`）。
     2026-10-02：`menuback` ＝ 那两枚主菜单弹窗（读取存档 / 挑战模式）底部的「返回」。 */
  'home', 'slot', 'menuback',
];

export const ACTION_SELECTOR = ACTION_KEYS.map(k => `[data-${k}]`).join(',');

export const PRIMARY_EVENT = 'pointerdown';
export const KEYBOARD_EVENT = 'click';

const HAS_POINTER = typeof window !== 'undefined' && typeof window.PointerEvent === 'function';

export function findActionEl(target) {
  return target && target.closest ? target.closest(ACTION_SELECTOR) : null;
}

/**
 * @param {HTMLElement} container  挂载容器（`#app`）
 * @param {(el:HTMLElement)=>void} onAction
 */
export function bindActions(container, onAction) {
  const handle = ev => {
    const el = findActionEl(ev.target);
    if (!el || el.disabled) return;
    ev.stopPropagation();
    if (ev.cancelable !== false && ev.preventDefault) ev.preventDefault();
    onAction(el);
  };

  const handleClick = ev => {
    if (HAS_POINTER && ev.detail !== 0) {
      const el = findActionEl(ev.target);
      if (el && ev.cancelable !== false && ev.preventDefault) ev.preventDefault();
      return;
    }
    handle(ev);
  };

  // boot 面板挂在 body 上，所以监听挂 body —— 一次性覆盖 #app 与它
  const target = container || document.body;
  target.addEventListener(PRIMARY_EVENT, handle, true);
  target.addEventListener(KEYBOARD_EVENT, handleClick, true);

  return {
    off() {
      target.removeEventListener(PRIMARY_EVENT, handle, true);
      target.removeEventListener(KEYBOARD_EVENT, handleClick, true);
    },
  };
}

/* ═════════════════════ K 线手势（Batch 3 · B13 / B14） ═════════════════════
 * 单指拖动（平移）／双指捏合（缩放 x）／双击（复位）。
 *
 * 为什么绑在**画布**上而不是 body：上面那套动作键分派只认 `[data-*]`，画布没有动作键，
 * 两套互不打扰；绑在画布上也天然把「拖 K 线」和「点按钮」分开。
 *
 * ⚠️ 两个坑：① `style.css` 必须给画布 `touch-action: none`，否则浏览器吞掉 `pointermove`；
 *             ② 拖动时要用 `setPointerCapture`，手指滑出画布（很常见）仍能收到 move。
 *
 * 判定阈值：累计位移 > 4px 才算「拖动」—— 否则一次点按被手指抖动歪 1px 也会锁视野。
 */

/** 双击的两次按下间隔上限（ms）与允许的位移（px） */
const TAP_MS = 300;
const TAP_PX = 24;
/** 起拖阈值（px）：手指抖动不算拖动 */
const DRAG_PX = 4;
/** 单次捏合事件的最大缩放比（防手指跳变时视野闪飞） */
const ZOOM_STEP = 2;

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{pan:(dx:number,dy:number)=>void, zoom:(f:number)=>void, reset:()=>void}} h
 *   `pan` 的 dx/dy 是**本次事件**的位移（不是累计）；`zoom` 的 f < 1 = 放大（可见根数变少）
 */
export function bindChart(canvas, h) {
  const pts = new Map();          // pointerId -> {x, y}
  let pinchDist = 0;
  let travel = 0;                 // 本次拖动累计位移
  let lastTapAt = 0;
  let tapX = 0, tapY = 0;

  const onDown = ev => {
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(ev.pointerId); } catch { /* 已释放 / 不支持的浏览器，忽略 */ }
    }

    if (pts.size === 1) {
      travel = 0;
      const now = performance.now();
      /* 双击**手动判**：触屏上 `dblclick` 只在部分浏览器里派发（且要先有 tap 延迟），不可靠 */
      if (now - lastTapAt < TAP_MS && Math.abs(ev.clientX - tapX) < TAP_PX && Math.abs(ev.clientY - tapY) < TAP_PX) {
        lastTapAt = 0;
        h.reset();
        return;
      }
      lastTapAt = now;
      tapX = ev.clientX;
      tapY = ev.clientY;
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinchDist = dist2(a, b);
    }
    if (ev.cancelable !== false && ev.preventDefault) ev.preventDefault();
  };

  const onMove = ev => {
    const p = pts.get(ev.pointerId);
    if (!p) return;
    const dx = ev.clientX - p.x;
    const dy = ev.clientY - p.y;
    p.x = ev.clientX;
    p.y = ev.clientY;
    travel += Math.abs(dx) + Math.abs(dy);

    /* 双指：只比距离，不看方向 —— 分开 = 放大（可见根数变少） */
    if (pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = dist2(a, b);
      if (pinchDist > 0 && d > 0) {
        const f = Math.min(ZOOM_STEP, Math.max(1 / ZOOM_STEP, pinchDist / d));
        if (f !== 1) h.zoom(f);
      }
      pinchDist = d;
      return;
    }
    if (travel <= DRAG_PX) return;
    h.pan(dx, dy);
  };

  const onUp = ev => {
    pts.delete(ev.pointerId);
    if (pts.size < 2) pinchDist = 0;
    if (canvas.releasePointerCapture) {
      try { canvas.releasePointerCapture(ev.pointerId); } catch { /* 同上 */ }
    }
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  return {
    off() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    },
  };
}
