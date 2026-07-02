/**
 * OS-3 Phase 4 — pure helpers for the OSR native-widget overlays (`<select>` / date / color).
 *
 * The previewed page renders offscreen to a bitmap, so its native popup widgets never composite
 * (electron #34095). We detect the interaction in MAIN, ship the widget's page rect + state, and
 * draw our OWN overlay over the host `<canvas>` (which clips/rounds like any DOM node). These
 * functions are the geometry + value math, kept pure + unit-tested; the React overlays in
 * `canvas/boards/osr/*` are thin wrappers over them. No DOM, no Electron.
 */

/** A widget's bounding rect in PAGE CSS px (the active preset's logical box), as reported by the
 *  injected page hook via `el.getBoundingClientRect()`. */
export interface PageRect {
  x: number
  y: number
  width: number
  height: number
}

/** A rect in FRAME-local px (the `.bb-frame` content box the overlay is positioned within). */
export interface FrameRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Map a widget's page rect → frame-local px. The host `<canvas>` fills `.bb-frame` (inset:0) and
 * the page lays out at `pageW × pageH` (the live preset), so the mapping is a pure proportional
 * scale — no camera math (React Flow scales the whole `.bb-frame` subtree, overlay included). A
 * zero-size page guards against a divide-by-zero before first layout.
 */
export function pageRectToFrame(
  rect: PageRect,
  pageW: number,
  pageH: number,
  frameW: number,
  frameH: number
): FrameRect {
  if (pageW <= 0 || pageH <= 0) return { x: 0, y: 0, w: 0, h: 0 }
  const sx = frameW / pageW
  const sy = frameH / pageH
  return {
    x: rect.x * sx,
    y: rect.y * sy,
    w: rect.width * sx,
    h: rect.height * sy
  }
}

/**
 * Vertical placement for a popup anchored to a widget: below the widget if it fits inside the
 * frame, else above it, else clamped to the frame top (a popup taller than the frame). Mirrors a
 * real browser's select-popup flip. `gap` is the px between the widget edge and the popup.
 */
export function placePopupTop(
  anchorTop: number,
  anchorBottom: number,
  popupH: number,
  frameH: number,
  gap = 2
): number {
  if (anchorBottom + gap + popupH <= frameH) return anchorBottom + gap // below — common case
  const above = anchorTop - gap - popupH
  if (above >= 0) return above // flip above
  return Math.max(0, frameH - popupH) // taller than the frame — pin inside, bottom-aligned
}

/** Clamp a popup's left edge so a `popupW`-wide popup stays inside `[0, frameW]`. */
export function clampPopupLeft(left: number, popupW: number, frameW: number): number {
  if (popupW >= frameW) return 0
  return Math.max(0, Math.min(left, frameW - popupW))
}

/** One cell of the month grid. `iso` is the `YYYY-MM-DD` value for a `<input type=date>`. */
export interface DayCell {
  day: number
  iso: string
  /** False for the leading/trailing days that belong to the prev/next month. */
  inMonth: boolean
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `YYYY-MM-DD` for a Y/M(0-based)/D triple. */
export function isoDate(year: number, month0: number, day: number): string {
  return `${year}-${pad2(month0 + 1)}-${pad2(day)}`
}

/**
 * A 6×7 calendar matrix for `month0` (0-based) of `year`, Sunday-first, including the
 * leading/trailing days from the adjacent months (marked `inMonth:false`). Pure — uses UTC math
 * so it never depends on the host timezone. Always 42 cells (stable grid height → no layout jump).
 */
export function monthGrid(year: number, month0: number): DayCell[] {
  const first = new Date(Date.UTC(year, month0, 1))
  const startDow = first.getUTCDay() // 0=Sun
  const cells: DayCell[] = []
  // Start at the Sunday on/before the 1st.
  const start = new Date(Date.UTC(year, month0, 1 - startDow))
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getTime() + i * 86400000)
    const y = d.getUTCFullYear()
    const m = d.getUTCMonth()
    const day = d.getUTCDate()
    cells.push({ day, iso: isoDate(y, m, day), inMonth: m === month0 })
  }
  return cells
}

/** Month label, e.g. `June 2026`. Pure (UTC). */
export function monthLabel(year: number, month0: number): string {
  const MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ]
  return `${MONTHS[((month0 % 12) + 12) % 12]} ${year}`
}

/**
 * Parse a `YYYY-MM-DD` value → {year, month0, day}, or null if malformed OR calendar-invalid
 * (e.g. `2026-02-30`, `2026-04-31`) — validated against the actual days-in-month (UTC, so it
 * never depends on the host timezone; leap years fall out of `Date` for free).
 */
export function parseIsoDate(value: string): { year: number; month0: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const year = Number(m[1])
  const month0 = Number(m[2]) - 1
  const day = Number(m[3])
  if (month0 < 0 || month0 > 11 || day < 1) return null
  const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()
  if (day > daysInMonth) return null
  return { year, month0, day }
}

/** HSV (h∈[0,360), s/v∈[0,1]) → `#rrggbb` (uppercase). Pure. */
export function hsvToHex(h: number, s: number, v: number): string {
  const hh = ((h % 360) + 360) % 360
  const ss = Math.max(0, Math.min(1, s))
  const vv = Math.max(0, Math.min(1, v))
  const c = vv * ss
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const mm = vv - c
  let r = 0
  let g = 0
  let b = 0
  if (hh < 60) [r, g, b] = [c, x, 0]
  else if (hh < 120) [r, g, b] = [x, c, 0]
  else if (hh < 180) [r, g, b] = [0, c, x]
  else if (hh < 240) [r, g, b] = [0, x, c]
  else if (hh < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const to = (n: number): string =>
    Math.round((n + mm) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  return `#${to(r)}${to(g)}${to(b)}`
}

/** `#rgb`/`#rrggbb` (any case, optional `#`) → HSV, or null if not a valid hex colour. */
export function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
  const norm = normalizeHex(hex)
  if (!norm) return null
  const r = parseInt(norm.slice(1, 3), 16) / 255
  const g = parseInt(norm.slice(3, 5), 16) / 255
  const b = parseInt(norm.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  if (h < 0) h += 360
  const s = max === 0 ? 0 : d / max
  return { h, s, v: max }
}

/** Normalize a hex colour to `#RRGGBB` (uppercase), expanding `#rgb`; null if invalid. */
export function normalizeHex(hex: string): string | null {
  const t = hex.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(t)) {
    const [a, b, c] = t
    return `#${a}${a}${b}${b}${c}${c}`.toUpperCase()
  }
  if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t}`.toUpperCase()
  return null
}
