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
  /* Batch 4：`settings`（顶栏第三枚）/ `snd`（音效开关）/ `reset`（面板内重开）/ `sclose`（关面板）
     / `intro`（开场弹窗的「开始交易」）
     Batch 5（B30）：`loan`（归零遮罩上的「借续命」/「就此收摊」） */
  'settings', 'snd', 'reset', 'sclose', 'intro', 'loan',
  /* A6（方案 §6.4）：`tab` ＝ 底部 Tab 三条（交易 / 资产 / 设置）。
     ⚠️ `settings` **保留**（§9 B8）：顶栏那枚「设置」按钮已随 A6 撤掉，但设置页里
        将来仍可能复用它做一个「关」的出口 —— 现在页的出口就是底部 Tab，所以没有任何 DOM 挂它。 */
  'tab',
  /* 上帝模式 ＋ 订单冲击：`god`（顶栏标题连点 5 次的隐藏入口）/ `impact`（设置面板的冲击开关）
     / `godcash` `goddate` `godoff`（上帝面板内的各枚按钮）
     ⚠️ 原来的 `godmult` `godscale` `godreset` 三枚已随上帝模式瘦身整体删除（2026-09-29）。 */
  'god', 'impact', 'godcash', 'goddate', 'godoff',
  /* U1（ROADMAP §21.4）：`mode2`（操作区「金额」行末尾那枚「现货 / 合约」模式键）。
     ⚠️ 用 `mode2` 而不是 `mode` —— `mode` 已被 K 线左上角那枚**粒度**小字占用（`main.js` 的 `d.mode`）。
     v9（§15.3 N4）：`buy` / `sell` ＝ 现货模式那两枚动作键（借 U 买入 / 借币卖出）。 */
  'mode2', 'buy', 'sell',
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
