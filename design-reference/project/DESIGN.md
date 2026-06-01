# Canvas ADE — Design Spec

A desktop (Electron + React + tldraw) app for AI-assisted development. Each
**project** is an infinite, zoomable **canvas**. Items on the canvas are
**boards** of three types: **Terminal** (a live CLI coding agent), **Browser**
(a responsive preview of the running app), and **Planning** (notes / sketches /
arrows). Zoom out to see the whole project; zoom in to work one board.

This document is the implementation contract: design tokens + board chrome
rules. Two reference artifacts ship alongside it:

- `Canvas ADE.html` — the live pan/zoom prototype.
- `Frames Overview.html` — every key state laid out flat for inspection.

---

## 1. Design principles

1. **Calm and dense, not loud.** Linear / Raycast / tldraw, not "AI app." The
   canvas is the surface; chrome recedes until you touch it.
2. **One accent, used functionally only.** Blue means *active / selected /
   running*. It is never decoration. Everything else is neutral grey.
3. **No slop.** No purple gradients, no glassmorphism, no glow, no drop-shadow
   for its own sake. Borders and one flat elevation shadow do the work.
4. **The board is the atom.** All three types share identical chrome geometry so
   the canvas reads as one system. Only the type glyph and content differ.
5. **Legible at every zoom.** Boards degrade to a Level-of-Detail (LOD) card
   below ~40% zoom: title + glyph + status, nothing else.

---

## 2. Color tokens

Pure-neutral dark theme (zero hue in the greys). Hex is the source of truth.

### Surfaces (darkest → lightest, i.e. furthest → closest)
| Token | Hex | Use |
|---|---|---|
| `--void` | `#0a0a0b` | the infinite canvas backdrop |
| `--grid-dot` | `#202022` | dot/line grid marks on the void |
| `--surface` | `#141416` | board body / content background |
| `--surface-raised` | `#1a1a1d` | board title bar, toolbars |
| `--surface-overlay` | `#1e1e22` | popovers, menus, tooltips |
| `--inset` | `#0e0e10` | terminal screen, inputs, code wells |

### Borders
| Token | Hex / value | Use |
|---|---|---|
| `--border-subtle` | `rgba(255,255,255,.06)` | resting board edge, dividers |
| `--border` | `rgba(255,255,255,.10)` | hovered edge, control borders |
| `--border-strong` | `rgba(255,255,255,.16)` | active controls, device frame |

### Text
| Token | Hex | Use |
|---|---|---|
| `--text` | `#ededee` | primary |
| `--text-2` | `#9b9ba1` | secondary / board titles at rest |
| `--text-3` | `#6a6a70` | tertiary, meta, mono labels |
| `--text-faint` | `#46464b` | disabled, watermark |

### Accent + status (status hues are muted, used as 8px dots / 1px rings only)
| Token | Hex | Use |
|---|---|---|
| `--accent` | `#4f8cff` | selected board ring, focus, run progress |
| `--accent-hover` | `#6ea0ff` | accent on hover |
| `--accent-wash` | `rgba(79,140,255,.14)` | selected title-bar tint, focus fill |
| `--ok` | `#3ecf8e` | running / success status dot |
| `--warn` | `#e8b339` | waiting-for-input / diff pending |
| `--err` | `#f2545b` | failed run, error |

> Tweakable in the prototype: accent (blue / green / amber / mono) and grid
> style. Ship default = **blue**.

---

## 3. Typography

| Family | Stack | Use |
|---|---|---|
| UI | `Geist`, system-ui, sans-serif | all chrome, labels, planning notes |
| Mono | `Geist Mono`, ui-monospace, monospace | terminal, type glyphs, meta, code, zoom % |

### Scale (px / line-height / weight / tracking)
| Name | Size | LH | Wt | Tracking | Use |
|---|---|---|---|---|---|
| `micro` | 10 | 14 | 500 | +0.06em UPPER | section labels, board-type tag |
| `meta` | 11 | 16 | 450 | 0 | mono meta, status text, breadcrumb |
| `label` | 12 | 16 | 500 | 0 | board title, button text, toolbar |
| `body` | 13 | 20 | 400 | 0 | planning notes, menu items |
| `term` | 12.5 | 19 | 400 | 0 | terminal output (mono) |
| `h` | 15 | 22 | 600 | -0.01em | empty-state heading, dialog title |

Minimum on-canvas type at 100% zoom is 10px. Below 40% zoom boards switch to
LOD and only the title (rendered at a zoom-compensated size) shows.

---

## 4. Spacing, radius, elevation

- **Spacing base = 4px.** Steps: 2, 4, 6, 8, 12, 16, 20, 24, 32.
- **Radius:** `--r-board: 8px` · `--r-inner: 6px` (content wells, device frame)
  · `--r-ctl: 5px` (buttons/chips) · `--r-pill: 999px` (status pills).
- **Elevation** (the *only* shadows in the system):
  - board resting: `0 1px 2px rgba(0,0,0,.45), 0 10px 28px -12px rgba(0,0,0,.6)`
  - popover/menu: `0 8px 24px -6px rgba(0,0,0,.7)`
  - selected board adds the accent ring (below), not extra shadow.
- **Density** (tweakable): `compact` (default) vs `roomy`. Compact title bar =
  34px; roomy = 40px. All paddings scale ±2px.

---

## 5. Canvas

- Background `--void`. Grid drawn in screen space so it pans/scales with the
  camera. Default = **dots**: 1px `--grid-dot` dot on a 24px (world) lattice;
  alt = thin **lines**; alt = **plain**.
- Camera = `{x, y, z}`. World→screen: `translate(x,y) scale(z)`,
  `transform-origin: 0 0`. Zoom range `0.1 … 2.5`.
- **Pan:** drag empty canvas (grab → grabbing cursor); or two-finger
  trackpad scroll. **Zoom:** ⌘/Ctrl + wheel, or pinch, zoomed toward the
  cursor; or the toolbar `−` / `%` / `+` controls.
- `Zoom to fit` frames all boards with 64px padding. Double-click a board =
  **focus**: animate camera so that board fills the viewport (LOD off).
- Grid dot opacity fades out below 30% zoom to keep the overview clean.

---

## 6. Board chrome (shared by all three types)

```
┌─────────────────────────────────────────────┐  ← 1px --border-subtle, --r-board
│ [glyph] Title…                  [actions] ⋯ │  ← title bar, --surface-raised, 34px
├─────────────────────────────────────────────┤  ← 1px --border-subtle divider
│                                             │
│                  CONTENT                    │  ← --surface (or --inset for terminal)
│                                             │
└─────────────────────────────────────────────┘
        ▢ resize handles on hover/select
```

### Title bar (height: compact 34 / roomy 40)
- **Left:** `type glyph` (16px mono monochrome) + a 10px `micro` **type tag**
  (`TERMINAL` / `BROWSER` / `PLANNING`) in `--text-3` + the **title** (`label`,
  `--text-2`; `--text` when selected). Title is inline-editable on double-click.
- **Right:** per-type **actions** (see §7), then a **maximize** button
  (`⤢ Full view`) that opens the board edge-to-edge (see §6.1), then a `⋯`
  overflow menu (**Full view · Duplicate · Delete**). Actions are 24px icon
  buttons, `--text-3`, hover → `--text-2` on `--surface-overlay`.
- Title bar is the **drag handle** for moving the board.

### Type glyphs (monochrome, drawn with CSS/mono chars — never illustrative)
- Terminal: `›_` (mono, `--text-3`; caret blinks `--ok` while running).
- Browser: a 2-bar window mark (top bar + frame), 1px stroke.
- Planning: a small dotted-square / pen-stroke mark.

### States
| State | Treatment |
|---|---|
| Resting | 1px `--border-subtle`, resting shadow |
| Hover | edge → `--border`; resize handles fade in |
| Selected | 1.5px `--accent` ring (`box-shadow: 0 0 0 1.5px --accent`); title text → `--text`; title-bar tint `--accent-wash` |
| Focused (zoomed-in) | as selected; canvas dims other boards to 55% opacity |
| Full view | board opens edge-to-edge over a 66%-black scrim, accent ring; exit via the title-bar full-view toggle icon (becomes "Exit full view"), Esc, or scrim click — no separate top band (descoped 2026-06-01); content renders at full chrome scale |
| LOD (z < .4) | single card: glyph + title + status dot, centered; no content, no chrome divider |

### 6.1 Full view & duplicate
- **Full view** (maximize button, `⋯` menu, or via the overflow) lifts a single
  board into a fullscreen overlay — distinct from **focus** (which animates the
  *camera* to fit a board but stays on-canvas). Full view is a modal layer: it
  does not move the camera, dims the canvas, and exits via the title-bar
  full-view toggle icon (which becomes "Exit full view"), or `Esc` / scrim click.
  No separate top band (descoped 2026-06-01). Use it to read a long terminal run
  or inspect a preview at size. The board keeps all its chrome and controls
  (e.g. viewport toggles).
- **Duplicate** clones a board (geometry + state) offset by 36px and selects the
  copy. Primary use: fork a **Browser** board so one can sit on Mobile and
  another on Tablet side-by-side. Available from the `⋯` menu.

### Resize handles
- 8 handles: 4 corners (8×8px) + 4 edge midpoints (hit area 8px, visual 2px
  line). Visible only on hover or when selected. Fill `--surface-overlay`,
  1px `--border-strong`; corner handles square with `--r-ctl/2`. Bottom-right
  is always slightly more visible (it's the primary resize affordance).
- Min board size: 240×160. Boards keep world-space size across zoom.

---

## 7. Per-type content & actions

### 7.1 Terminal board — a live CLI coding agent
- Content well = `--inset`, mono `term` text, 12px padding.
- **Header row** inside content (or in title bar): agent identity pill —
  `● claude-code` / `● codex` with an `--ok` dot when running, `--warn` when
  awaiting input, `--err` on failure. A run timer (`mm:ss`, mono `--text-3`).
- **Mid-run rendering:** streamed output lines; tool-call lines prefixed with a
  dim `›`; file-edit lines show `+`/`−` counts in `--ok`/`--err`; a working
  line with an animated braille/▍ spinner + current action ("Editing
  src/canvas.ts…"); blinking caret at the input prompt `›`.
- **Actions:** `▮▮ pause/▶ run`, `⟳ restart`, `⤓ interrupt` (Ctrl-C),
  overflow. While running, top edge of the board shows a 2px `--accent`
  indeterminate progress sliver.
- Input affordance at the bottom: a single mono prompt line where the user can
  type a follow-up instruction.

### 7.2 Browser board — responsive preview in a device frame
- Content = `--surface`; the rendered app sits inside a **device frame**
  (1px `--border-strong`, `--r-inner`, subtle inset). The frame *and the board*
  resize together — board chrome wraps the frame with 12px gutter.
- **Viewport toggles** in the title-bar actions: a segmented control
  `Mobile · Tablet · Desktop` (icon + active = `--accent` text on
  `--accent-wash`). Switching sets the device frame's inner width:
  - Mobile 390×844 · Tablet 834×1112 · Desktop 1280×800 (scaled to fit board).
- A compact **URL/route bar** above the frame: `◂ ▸ ⟳  localhost:5173 ▾` mono
  `--text-3`, with a live `--ok` "connected" dot. Right side: current viewport
  dimensions readout (`390 × 844`, mono `--text-3`).
- Optional device chrome: status-bar notch on mobile, none on desktop.

### 7.3 Planning board — whiteboard layer
- Content = `--surface` with a *finer* dot grid (12px) to read as a sketch
  surface distinct from the void.
- Holds free elements: **checklists**, **sticky notes** (`--surface-raised`,
  soft shadow, 4 muted note tints at low chroma), **text**,
  **arrows/connectors** (1.5px `--border-strong`, arrowhead), and **freehand
  strokes** (`--text-2`).
- **Checklist element:** a `--surface-raised` card, `--r-board`, with a title +
  `done/total` mono count, a 3px `--accent` progress bar, and rows of
  togglable items. Item = 16px `--r-ctl` checkbox (checked = filled `--accent`
  + `--void` check glyph) and a `body` label that goes `--text-faint` +
  strikethrough when done. Checklists scale with the board, so resize the
  planning board to give a long list room. Toggling is live.
- **Actions:** mini tool cluster — `select · note · checklist · arrow · pen` —
  only shown when the planning board is selected; otherwise it's just content.
- Connectors may originate from a planning board and point at another board's
  title bar (cross-board arrows live on the canvas layer, above boards).

---

## 8. App chrome (screen-space, floats over canvas)

- **Top-left:** app mark (`◇` 16px) + **project switcher**
  `canvas-ade ▾` (`label`, `--text`), opens a menu of projects (each = its own
  canvas). To its right, a faint board count `· 4 boards` (`meta`, `--text-3`).
- **Top-right:** camera cluster — `⤢ fit`, then `−  142%  +` (mono `meta`),
  divider, `⊞ overview`. All 28px controls on a single
  `--surface-raised` pill, 1px `--border-subtle`.
- **Bottom-center:** the **board dock** — a `--surface-raised` pill with the
  add-board tools: `▦ select` (default), then `+ Terminal`, `+ Browser`,
  `+ Planning`. Active tool = `--accent`. This is the primary creation UI.
- **Bottom-right (optional):** minimap — `--surface-raised` rounded rect, board
  rects in `--border-strong`, viewport rect in `--accent`.
- All app chrome uses the popover shadow and sits at `--surface-raised`. Never
  full-width bars — everything is a floating island, tldraw-style.

### Empty project
- No boards. Centered, low-key prompt: app mark watermark, `h` heading
  "Empty canvas", one line of `body` `--text-3` ("Drop a board to start —
  spin up an agent, preview your app, or sketch a plan."), and three large
  ghost-outline buttons mirroring the dock (`+ Terminal / + Browser /
  + Planning`). The dock and top chrome remain visible.

---

## 9. Motion

- Camera pan: direct (1:1, no easing). Zoom: direct while wheeling; `fit` /
  `focus` animate `200ms cubic-bezier(.2,.7,.2,1)`.
- Board select ring: `120ms ease-out`. Handle fade: `100ms`.
- Terminal spinner: 80ms/frame braille cycle. Caret blink: 1s step.
- Run progress sliver: 1.2s linear indeterminate loop.
- Respect `prefers-reduced-motion`: drop spinner→static glyph, no progress loop.

---

## 10. Implementation notes (tldraw)

- Each board = a custom tldraw `ShapeUtil` (`terminal`, `browser`, `planning`)
  with shared chrome rendered in a base component; type-specific content via a
  slot. Selection ring / resize handles come from tldraw — restyle to match
  §6, don't reinvent.
- Terminal content = an `xterm.js` instance bridged to the agent PTY; Browser
  content = a `<webview>`/`<iframe>` to `localhost`; Planning = native tldraw
  shapes (notes/arrows/draw) grouped under the planning frame.
- LOD: use tldraw's zoom level to swap the board's render between full and card.
- Persist camera + board geometry per project. Keep grid + chrome in screen
  space (tldraw's overlay layer), boards in page space.
