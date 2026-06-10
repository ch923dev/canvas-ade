/**
 * The unified menu viewport clamp (D1-C) — pure, shared by every popover via the
 * <Menu> shell. Lifted from ElementContextMenu's flip-at-the-pointer + BoardMenu's
 * trigger-anchored flip-above + D0-4's maxHeight scroll cap.
 */

const PAD = 8

export interface MenuPlacement {
  top: number
  left: number
  /** Viewport-capped height (D0-4: a long list scrolls instead of running off-screen). */
  maxHeight: number
}

export interface AnchorInput {
  /** Raw point (context menus) — flip to the pointer's other side near an edge. */
  point?: { x: number; y: number }
  /** Trigger rect (dropdowns) — drop below, flip above on bottom overflow. */
  trigger?: { top: number; left: number; right: number; bottom: number }
  align: 'left' | 'right'
  gap: number
}

export function clampMenuToViewport(
  anchor: AnchorInput,
  menu: { width: number; height: number },
  vw: number,
  vh: number,
  pad: number = PAD
): MenuPlacement {
  let top: number
  let left: number
  if (anchor.point) {
    // Context-menu placement: open at the pointer, flip to its other side near an edge
    // (ElementContextMenu's algorithm), then clamp both axes as a backstop.
    const { x, y } = anchor.point
    left = x + menu.width > vw - pad ? Math.max(pad, x - menu.width) : x
    top = y + menu.height > vh - pad ? Math.max(pad, y - menu.height) : y
  } else if (anchor.trigger) {
    // Dropdown placement: align under the trigger, flip above it when the bottom edge
    // would overflow (BoardMenu's algorithm).
    const t = anchor.trigger
    left = anchor.align === 'right' ? t.right - menu.width : t.left
    top = t.bottom + anchor.gap
    if (top + menu.height > vh - pad) {
      const flipped = t.top - menu.height - anchor.gap
      top = flipped >= pad ? flipped : Math.max(pad, vh - menu.height - pad)
    }
  } else {
    top = pad
    left = pad
  }
  left = Math.max(pad, Math.min(left, vw - menu.width - pad))
  top = Math.max(pad, top)
  return { top, left, maxHeight: Math.max(80, vh - top - pad) }
}
