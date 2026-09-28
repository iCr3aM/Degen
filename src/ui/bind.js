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
export const ACTION_KEYS = ['sym', 'ex', 'frac', 'lev', 'speed', 'act', 'pause', 'restart', 'wipe'];

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
