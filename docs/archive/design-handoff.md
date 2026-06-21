# Canvas ADE — Design Handoff

This is a self-contained design handoff for Canvas ADE (rebranding to Expanse). Claude Design has no repo access — everything needed is in this doc. It covers the existing design system (tokens, components, information architecture, patterns) so you can recreate it faithfully, plus a ready-to-fill brief template for designing a new feature against it.

---

## 1. Overview

Canvas ADE (rebranding to Expanse) is an infinite, zoomable desktop canvas — think Figma or tldraw, but purpose-built as a power-tool for a solo developer doing AI-assisted development. The user drags resizable boards onto the canvas, zooms out to see the full project at a glance, and zooms in to work a single board. The visual language is deliberately calm, dense, and precise — closer to Linear, Raycast, or tldraw's own UI than to any "AI app." The surface is deep dark (`#0a0a0b` void) with a subtle dot grid and pure-neutral grey boards; chrome recedes until the user touches it. There is exactly one accent colour — blue `#4f8cff` — used strictly to signal active, selected, or running state, never as decoration. Everything else is neutral grey with no purple, no gradients, no glassmorphism, no glow, and no drop-shadows beyond the two flat elevation shadows permitted by the system.

It is a single-window Electron 42 + React 18 desktop app. **A project = one canvas** (one `canvas.json`). There are three board types:

- **Terminal** — a live CLI coding agent running in a real shell.
- **Browser** — a responsive preview of the user's running localhost app in a device frame (offscreen render → DOM `<canvas>`).
- **Planning** — a whiteboard: notes, arrows, text, freehand, checklists, and Mermaid diagrams. A **Checklist is an element inside a Planning board**, not a fourth board type.

### Board chrome contract

Every board — Terminal, Browser, or Planning — shares identical chrome geometry. Only the type glyph and content slot differ.

#### Outer shell

- **Corner radius:** `--r-board: 8px` (CSS variable; the shipped app locks to `8px`).
- **Border at rest:** `1px solid rgba(255,255,255,.06)` (`--border-subtle`).
- **Border on hover:** `1px solid rgba(255,255,255,.10)` (`--border`).
- **Border when selected:** the border stays neutral; selection is signalled entirely by an accent **ring** — `box-shadow: 0 0 0 1.5px var(--accent)` (`#4f8cff`), prepended to the resting board shadow.
- **Resting shadow:** `0 1px 2px rgba(0,0,0,.45), 0 10px 28px -12px rgba(0,0,0,.6)` (`--shadow-board`).
- **Body background:** `--surface: #141416` (all types); Terminal content well uses the deeper `--inset: #0e0e10`.
- **Dim when another board is focused:** `opacity: 0.55`, `transition: opacity .15s`.

#### Title bar (drag handle)

- **Height:** `34px` (`--titlebar-h`; the shipped compact default). A `40px` roomy variant is described but not shipped — the density/tweaks panel was cut.
- **Background:** `--surface-raised: #1a1a1d` at rest; `--accent-wash: rgba(79,140,255,.14)` when the board is selected.
- **Bottom border:** `1px solid --border-subtle` divides header from content.
- **Left side (left → right):**
  1. **Type glyph** — 15–16px monochrome glyph, tinted to the status-dot colour (`--text-3` `#7b7b81` at rest / `--text-2` `#9b9ba1` when selected):
     - Terminal: `›` + a 6×11px filled block cursor — green `--ok` (`#3ecf8e`) when running, `--text-3` when idle.
     - Browser: small SVG framed window (rect + top-bar line + one dot), `1.4px stroke`.
     - Planning: dashed-stroke square + pen-stroke path, `1.4px stroke`, `strokeDasharray: "2.4 2.6"` on the rect.
  2. **Type tag** — `10px` mono uppercase (`TERMINAL` / `BROWSER` / `PLANNING`), `font-weight: 500`, `letter-spacing: +0.06em`, colour `--text-3` (`#7b7b81`). Uses the `--mono` family.
  3. **Title text** — `12px`, `font-weight: 500`, `--text-2` (`#9b9ba1`) at rest → `--text` (`#ededee`) when selected. Inline-editable on double-click or F2. Truncates with `text-overflow: ellipsis`.
- **Right side (left → right):**
  - Optional **status pill** — 7–8px circle dot + mono `11px` label (e.g. `● claude-code · 02:14`). Dot colour: `--ok` for running/connected, `--warn` for waiting, `--err` for failure, `--text-3` for idle. Shown only on hover or when selected.
  - Per-type **action icon buttons** (see per-type content below; shown on hover/select).
  - **Connector handle** — press-drag to draw an orchestration cable to another board.
  - **Maximize / full-view button** — 24×24px icon button (`name: "maximize"`), becomes "Exit full view" inside full view.
  - **Overflow `⋯` button** — 24×24px. Menu items: **Full view**, **Duplicate**, "Add to {group}" / "Remove from group" rows, separator, **Delete** (danger red `--err: #f2545b`).
- Action icon buttons are `24×24px`, `border-radius: 5px` (`--r-ctl`), `border: 1px solid transparent`, `background: --surface-overlay` (`#1e1e22`) on hover, `color: --text-3` at rest / `--text-2` on hover / `--accent` when active.

#### Content slot

- Fills the remaining height below the title-bar divider (`flex: 1, min-height: 0`).
- `background: --surface` (`#141416`) for Browser and Planning; `background: --inset` (`#0e0e10`) for Terminal.
- Internal padding: `12px` on the Terminal output well.

#### Resize handles

- **8 handles total:** 4 corners (`nw`, `ne`, `se`, `sw`) + 4 edge midpoints (`n`, `s`, `e`, `w`).
- **Corner handles:** `9–10px` square, `background: --surface-overlay` (`#1e1e22`), `border: 1px solid --border-strong` (`rgba(255,255,255,.16)`), `border-radius: 2px`. The bottom-right (`se`) corner carries an extra `box-shadow: 0 0 0 1px var(--accent)` — the primary resize affordance.
- **Edge midpoints:** `16×16px` hit area (visual line only, ~2px wide). No fill.
- **Visibility:** fade in (100ms) on hover or selection. Hidden when the board is in LOD mode.
- **Min board size:** `240×160px` (world-space, unchanged by zoom).
- **Cursor:** `nwse-resize` (corner NW/SE), `nesw-resize` (corner NE/SW), `ns-resize` (N/S edges), `ew-resize` (E/W edges).

#### Selected / hover treatment

| State | Border | Ring | Title bar | Title text | Dim opacity |
|---|---|---|---|---|---|
| Resting | `1px --border-subtle` | none | `--surface-raised` | `--text-2` | 1.0 |
| Hover | `1px --border` | none | `--surface-raised` | `--text-2` | 1.0 |
| Selected | `1px` neutral | `box-shadow: 0 0 0 1.5px --accent` | `--accent-wash` tint | `--text` | 1.0 |
| Focused (camera) | as Selected | as Selected | as Selected | `--text` | others → 0.55 |
| Dimmed (others in focus) | `1px --border-subtle` | none | `--surface-raised` | `--text-2` | 0.55 |

#### LOD card (zoom < 0.4 / 40%)

At camera scale below `0.4`, boards collapse to a single flat card — no content, no divider:
- Full `position: absolute; inset: 0` div with `background: --surface-raised`, same `border-radius: --r-board`, `border: 1px solid --border-subtle`, `box-shadow: --shadow-board` (accent ring when selected).
- **Left:** type glyph scaled up `1.6×` + type tag (10px mono, `--text-3`) + title (15px, `font-weight: 600`, `--text`, truncated).
- **Right:** 9×9px status dot (same colour logic as the full status pill).
- Running animation (`ca-pulse` on the dot) preserved.
- LOD card and full-detail render crossfade over 100ms on the crossing edge.

#### Running progress sliver

When `running === true`, a `2px` absolute bar spans the full width at the top of the board (`top: 0`, `z-index: 3`), `background: --accent` (`#4f8cff`), indeterminate loop animation `1.2s linear`. The pre-run **spawning** variant slows to `2.4s` at `opacity: 0.55`.

#### Full view overlay

- Triggered by the maximize button or `⋯ → Full view`.
- Full-screen `position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,.66)` scrim (intentionally heavier than the `--scrim` modal token at `rgba(0,0,0,.5)`).
- The board renders at full selected state: `box-shadow: 0 0 0 1.5px var(--accent), var(--shadow-board)`, `border-radius: --r-board`, `overflow: hidden`. Entrance: scrim `opacity 0→1` and frame `scale(0.98)→scale(1)` at `200ms cubic-bezier(0.2,0.7,0.2,1)`.
- A first-open-per-session **"Esc to exit" hint** pill fades in bottom-center and fades after 3s.
- Exit via: the title-bar full-view toggle (icon becomes Exit), `Esc` key, or scrim click.
- Full view does NOT move the camera — it portals the live board content into the overlay while the board stays in its React Flow node position. (Planning full view instead uses a camera fit, `rf.fitView`.)

#### Canvas backdrop and app chrome

- **Void:** `#0a0a0b` background.
- **Dot grid (default):** `1px` radial-gradient dot, colour `--grid-dot: #202022`, on a `24px` world-space lattice. Dot position tracks the camera so the grid pans/scales with it. Opacity fades below ~40% zoom and effectively to void below 30%. Alt modes: thin lines, cross, or plain (none).
- **Top-left:** Project switcher pill — `height: 34px`, `border-radius: 8px`, `background: --surface-raised`, `border: 1px solid --border-subtle`, popover shadow. Contains: `◇` diamond icon (accent), project name (`13px`, `font-weight: 600`, `--text`), board count (mono `11px` `--text-3`), chevron (`--text-3`).
- **Top-right:** Camera cluster — pill: `padding: 3px`, `border-radius: 9px`, same shell. Contains: fit button (28×28px) · divider (1px `--border-subtle`, `18px` tall) · zoom-out · zoom% readout (mono `11px`, `--text-2`, `44px` wide) · zoom-in · divider · focus-group (when groups exist) · tidy-layout picker · backdrop picker · divider · settings. Active tool: `background: --accent-wash`, `color: --accent`.
- **Top-center dock:** same pill style, `padding: 4px`, `gap: 3px`. Auto-hides behind a `56×6px` grabber bar. Contains: `▦ Select` (32×28px) · divider · `+ Terminal` · `+ Browser` · `+ Planning` (each `height: 32px`, `padding: 0 11px 0 9px`, `border-radius: 6px`, type glyph + `+` glyph + label `12.5px font-weight: 500`).
- **Bottom-right:** optional minimap island (same pill shell) + the toast island.
- **Popover shadow:** `0 8px 24px -6px rgba(0,0,0,.7)` (`--shadow-pop`; used on all floating chrome islands).
- **Optional wallpaper:** per-project screen-fixed background layer (none / user file / bundled scene), with dim and saturation controls (schema version 9 `background` key). Settings-class — never undoable.

> **Note on the dock:** the original visual prototype showed a 5-tool Planning cluster (`select · note · check · arrow · pen`). The shipped product adds `text`, `erase`, `diagram`, snap, and export. The shipped list below in Section 3 is the implemented contract. The cut "tweaks panel" (accent/grid/density/corners) is not in the product — defaults are locked to blue accent / dots grid / compact / `8px` soft corners.

---

## 2. Design tokens

Calm, dense, Linear/Raycast feel. One accent blue. No glassmorphism/gradients/glow. All values below are the canonical live tokens.

### 2.1 Colors

#### Surfaces — furthest (darkest) → closest (lightest)

| CSS variable | Hex | Role |
|---|---|---|
| `--void` | `#0a0a0b` | Infinite canvas backdrop; body background |
| `--grid-dot` | `#202022` | Dot/line/cross grid marks drawn on the void |
| `--surface` | `#141416` | Board body / content background; digest panel bg |
| `--surface-raised` | `#1a1a1d` | Board title bar, toolbars, popovers, menus, pills |
| `--surface-overlay` | `#1e1e22` | Tooltips, dropdowns, OSR widget overlays, command palette |
| `--inset` | `#0e0e10` | Terminal screen well, text inputs, code inputs |

#### Borders

| CSS variable | Value | Role |
|---|---|---|
| `--border-subtle` | `rgba(255, 255, 255, 0.06)` | Resting board edge, dividers, backdrop picker border |
| `--border` | `rgba(255, 255, 255, 0.10)` | Hovered board edge, control borders, device frame at rest |
| `--border-strong` | `rgba(255, 255, 255, 0.16)` | Active controls, device frame, resize handles |

#### Text

| CSS variable | Hex | Role |
|---|---|---|
| `--text` | `#ededee` | Primary text; selected board title |
| `--text-2` | `#9b9ba1` | Secondary — board titles at rest, menu items, descriptions |
| `--text-3` | `#7b7b81` | Tertiary — meta labels, mono status, readable hints, watermark, placeholder, type tags, done-state items. (Lightened `#6a6a70` → `#7b7b81` in audit D0-2 to pass WCAG AA at 10px micro tags.) |
| `--text-faint` | `#46464b` | **Disabled states ONLY** (~2.8:1 contrast). Never for readable hints/watermarks/done items. |

#### Accent + Status

| CSS variable | Value | Role |
|---|---|---|
| `--accent` | `#4f8cff` | **The single accent blue.** Selected board ring, active tool, focus states, run progress sliver, caret. Functional only — never decorative. |
| `--accent-hover` | `#6ea0ff` | Accent on hover/pointer-over states |
| `--accent-wash` | `rgba(79, 140, 255, 0.14)` | Selected title-bar tint, focus fill, drag-to-create ghost fill |
| `--ok` | `#3ecf8e` | Running / success status (8px dot, 1px ring) |
| `--warn` | `#e8b339` | Waiting for input / diff pending (8px dot, 1px ring) |
| `--err` | `#f2545b` | Failed run / error (8px dot/ring; also error text and danger menu items) |

#### Overlay + one-off chrome colors

| CSS variable | Value | Role |
|---|---|---|
| `--scrim` | `rgba(0, 0, 0, 0.5)` | Modal scrim (Confirm dialogs, RecapConsent, Settings). The full-view overlay uses its own hardcoded `rgba(0,0,0,0.66)` — intentionally heavier. |
| `--connector` | `#5a6573` | Orchestration-connector arrowhead at rest |
| `--connector-selected` | `#e6e6e6` | Orchestration-connector arrowhead when selected |
| `--notch` | `#15161a` | Browser device-frame notch (mobile preset only) |

#### Planning board — sticky-note tints

Four muted, low-chroma tints so the single accent stays the only saturated colour. Each has a fill + a slightly stronger edge.

| Name | Fill token | Fill hex | Edge token | Edge hex |
|---|---|---|---|---|
| `yellow` | `--note-yellow-fill` | `#2a2818` | `--note-yellow-edge` | `#3d3a22` |
| `blue` | `--note-blue-fill` | `#16202b` | `--note-blue-edge` | `#22354a` |
| `green` | `--note-green-fill` | `#16241d` | `--note-green-edge` | `#21392c` |
| `plain` | *(falls back to)* `--surface-raised` | `#1a1a1d` | *(falls back to)* `--border` | `rgba(255,255,255,0.10)` |

#### Minimap-specific CSS hooks (React Flow overrides)

| CSS variable | Value | Role |
|---|---|---|
| `--xy-minimap-background-color` | `var(--surface-raised)` = `#1a1a1d` | Minimap island background |
| `--xy-minimap-mask-background-color` | `rgba(10, 10, 11, 0.5)` | Dim veil over off-viewport area |
| `--xy-minimap-mask-stroke-color` | `var(--accent)` = `#4f8cff` | Viewport window ring |
| `--xy-minimap-node-background-color` | `var(--border-strong)` = `rgba(255,255,255,0.16)` | Board rects |
| `--xy-minimap-node-stroke-color` | `transparent` | No node stroke |

#### Hardcoded spot colors (not tokenized)

| Value | Where used |
|---|---|
| `#fff` | Selected date-picker day fill; drag-to-create type chip text; multi-select Connect button text |
| `rgba(0, 0, 0, 0.66)` | Full-view overlay scrim (heavier than `--scrim`; no token) |
| `rgba(255, 92, 92, 0.18)` | Alignment-guide overlap-nudge fill (soft red, "you're stacking") |
| `rgba(0,0,0,0.4)` / `rgba(0,0,0,0.45)` | Browser stage hatch mix; board resting-shadow alpha |
| `rgba(79, 140, 255, 0.32)` | Primary OSR dialog button border (between `--accent-wash` and `--accent`) |

### 2.2 Typography

#### Font families

| CSS variable | Full stack | Use |
|---|---|---|
| `--ui` | `'Geist', system-ui, -apple-system, sans-serif` | All chrome, labels, planning notes, menus, dialogs. Self-hosted variable woff2, weight 100–900. |
| `--mono` | `'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace` | Terminal UI chrome, type glyphs, meta/status text, zoom %, code snippets. Self-hosted variable woff2. |
| `--term-mono` | `'Cascadia Mono', Consolas, 'SF Mono', Menlo, ui-monospace, monospace` | **Terminal grid (xterm canvas) only.** System fonts preferred — thin webfonts blur on xterm's grayscale-AA atlas. |
| `--serif` | `Georgia, 'Times New Roman', serif` | Defined as a token; used only by the `serif` FreeText option. |

#### Type scale

| Scale | Size | Line-height | Weight | Letter-spacing | Use |
|---|---|---|---|---|---|
| `micro` (`--fs-micro`) | `10px` | `14px` | `500` | `+0.06em` + UPPERCASE | Section labels, board-type tag (`TERMINAL`/`BROWSER`/`PLANNING`) |
| `meta` (`--fs-meta`) | `11px` | `16px` | `450` | `0` | Mono meta text, status breadcrumb, zoom %, recent paths. Uses `--mono`. |
| `label` (`--fs-label`) | `12px` | `16px` | `500` | `0` | Board title, button text, toolbar labels |
| `body` (`--fs-body`) | `13px` | `20px` | `400` | `0` | Planning notes, menu items, general prose |
| `term` (`--fs-term`) | `12.5px` | `19px` | `400` | `0` | Terminal output text (uses `--term-mono`) |
| `h` (`--fs-h`) | `15px` | `22px` | `600` | `-0.01em` | Empty-state headings, dialog titles |

**Body default:** `font-size: 13px` on `<body>`. `-webkit-font-smoothing: antialiased` global. Welcome-screen h1 is a hardcoded `22px` with `600`/`-0.01em` (no token). Helper classes `.t-micro` `.t-meta` `.t-label` `.t-body` `.t-term` `.t-h` apply the full role bundle; `.t-meta` / `.t-term` also set `font-family: var(--mono)`.

### 2.3 Spacing

Base unit = 4px. **Steps:** 2, 4, 6, 8, 12, 16, 20, 24, 32. Each token is named by its px value (`--space-8` = 8px). **No `--space-10`, `--space-14`, or `--space-28`** — in-between sizes are hardcoded.

| Token | Value | | Token | Value |
|---|---|---|---|---|
| `--space-2` | `2px` | | `--space-16` | `16px` |
| `--space-4` | `4px` (base) | | `--space-20` | `20px` |
| `--space-6` | `6px` | | `--space-24` | `24px` |
| `--space-8` | `8px` | | `--space-32` | `32px` |
| `--space-12` | `12px` | | | |

### 2.4 Radii

| CSS variable | Value | Role |
|---|---|---|
| `--r-board` | `8px` | Board outer shell; welcome buttons; placement ghost |
| `--r-inner` | `6px` | Content wells, device frame, popover panels, toast items, digest cards, minimap |
| `--r-ctl` | `5px` | Buttons, chips, control inputs, port picker, URL field, resize handles (half) |
| `--r-pill` | `999px` | Status pills, connection dot, paused badge, color-picker knobs |

**Other radii hardcoded in components (not tokenized):** `4px` (kbd chips, backdrop thumb, hue knob, group-name input); `7px` (backdrop segmented control, bd-tile, tidy-preset); `8px` (backdrop picker menu, project-switcher menu, text-toolbar, group-box-tab); `9px` (group FAB); `3px` (dock handle bar). One-offs not aliased to any `--r-*`.

### 2.5 Shadows / Elevation

Only two shadows in the system.

| CSS variable | Full value | Role |
|---|---|---|
| `--shadow-board` | `0 1px 2px rgba(0,0,0,0.45), 0 10px 28px -12px rgba(0,0,0,0.6)` | Board resting state; port picker |
| `--shadow-pop` | `0 8px 24px -6px rgba(0,0,0,0.7)` | Popovers, menus, tooltips, toasts, minimap, FABs, full-view hint |

**Selected board ring** (not a drop shadow): `box-shadow: 0 0 0 1.5px var(--accent)` — the consistent selection grammar for boards, focus rings on controls, and the full-view frame. **Full-view frame** stacks `0 0 0 1.5px var(--accent)` + `--shadow-board`. **TextToolbar** uses a hardcoded `0 4px 16px rgba(0,0,0,0.4)` — a third, intermediate shadow not tokenized.

### 2.6 Density / Chrome dimensions

| CSS variable | Value | Role |
|---|---|---|
| `--titlebar-h` | `34px` | Board title-bar height (compact mode — the shipped default) |

Hardcoded (no CSS token): resize handles 10×10px corners / 1px edge lines; min board size 240×160px (JS); camera zoom range 0.1–2.5 (JS); grid lattice 24px world-space pitch (JS canvas); dock grabber bar 56×6px, radius 3px. A roomy 40px title bar is described in the design contract but not shipped.

### 2.7 Motion

| Name | Value | Where used |
|---|---|---|
| Camera fit/focus duration | `200ms` (`CAMERA_MS`) | React Flow `fitView` / `setViewport` |
| Camera easing | `cubic-bezier(0.2, 0.7, 0.2, 1)` (`EASE_STANDARD`) | Camera fit/focus; full-view enter/exit; group absorb reflow |
| Board shell transitions | `opacity 0.12s ease-out`, `border-color 0.1s`, `box-shadow 0.12s ease-out` | `.ca-board-shell` |
| Focus/selection ring | `0.12s ease-out` | Board select ring |
| Handle fade-in | `100ms ease-out` | Resize handles on hover/select |
| LOD crossfade | `100ms ease-out` (in), `0.12s` (out) | `.ca-lod-card` / `.ca-lod-out` |
| Run progress sliver | `1.2s linear infinite` (`2.4s` + `opacity 0.55` spawning) | `.ca-progress-bar` |
| Caret blink | `1s steps(1) infinite` | `.ca-blink` |
| Running caret | `0.9s steps(1) infinite` | `.ca-caret-run` |
| Status dot pulse | `1.8s ease-out infinite` | `.ca-pulse` |
| Dock pill reveal | `0.12s ease-out` (opacity + translateY -6px) | `.ca-dock-pill` |
| Full-view scrim / frame | `200ms cubic-bezier(0.2,0.7,0.2,1)` | `.fullview-scrim` / `.fullview-frame` (scale 0.98→1) |
| Toast slide-in | `140ms ease-out` (opacity + translateY 6px) | `.toast-item` |
| Command palette | `120ms ease-out` (opacity + translateY -4px) | `.cp-island` |
| Minimap | `120ms ease-out` (opacity + translateY 6px) | `.wayfinding-minimap` |
| Group absorb reflow | `280ms cubic-bezier(0.2,0.7,0.2,1)` | `.reflowing` board nodes + group box |
| Icon/control hover | `0.1s` | `.ca-t-ctl` |
| Checklist progress bar | `0.18s` | `.ca-t-fill` (width) |

**`prefers-reduced-motion`:** all animation loops drop to `none !important`; all transition utilities drop to `none !important`; camera ops collapse to `duration: 0`.

### 2.8 Browser board — device-frame presets

| Preset | Inner logical width × height | Notes |
|---|---|---|
| Mobile | `390 × 844` | iPhone 14-class; mobile notch shown |
| Tablet | `834 × 1112` | iPad-class; no notch |
| Desktop | `1280 × 800` | Widescreen; no notch |

A segmented control (`Mobile · Tablet · Desktop`) in the title bar drives a true responsive reflow (the offscreen window sends the logical width to Chromium so media queries respond). The OSR `<canvas>` is supersampled: `S = deviceFitScale × settledZoom × DPR`. **Canvas camera zoom range:** `0.1–2.5` (10%–250%); below `0.4` boards switch to LOD card; dots fade below 30%.

### 2.9 Token gaps / notes

1. **`exportColors.ts` stale `text3`:** the SVG-export mirror hardcodes `text3: '#6a6a70'` — the pre-D0-2 value. The live `--text-3` is `#7b7b81`. SVG exports render third-level text slightly darker/lower-contrast.
2. **Full-view scrim has no token** (`rgba(0,0,0,0.66)`), intentionally distinct from `--scrim`.
3. **`--serif` used only by FreeText's serif option**; otherwise unused.
4. **Roomy density described, not tokenized** — only `--titlebar-h: 34px` (compact) exists.
5. **TextToolbar shadow** (`0 4px 16px rgba(0,0,0,0.4)`) is a third, un-tokenized shadow.
6. **Hardcoded radii** (`4/7/8/9px`) won't respond to a global radius retheme.
7. **Accent button border** `rgba(79,140,255,0.32)` is an un-tokenized medium-strength accent border.
8. **Spacing scale skips 10/14/28px** — in-between sizes are hardcoded.
9. **Alignment-guide overlap red** `rgba(255,92,92,0.18)` is un-tokenized and distinct from `--err`.

---

## 3. Component inventory

### Board chrome

**`BoardFrame`** — Universal shell wrapping all three board types. Two modes: full chrome (title bar + content well) and LOD card. Key props: `type: 'terminal' | 'browser' | 'planning'`, `boardId?`, `title`, `selected?`, `hovered?`, `dimmed?`, `lod?`, `fullView?`, `running?`, `spawning?`, `status?: { dot: string, label?: string }`, `actions?: ReactNode`, `contentBg?` (`--inset` for terminal, else `--surface`), `onFull?`, `onDuplicate?`, `onDelete?`, `onAddToGroup?`, `onRemoveFromGroup?`, `onStartConnect?`, `children`.

**`BoardTitle`** (internal) — Inline-editable title. Rest: `12px/500`, `--text` when selected else `--text-2`, ellipsis. Edit mode: `<input class="board-title-edit nodrag nopan">`. Double-click or F2 enters; Enter/blur commits, Esc cancels.

**`IconBtn`** — 24×24 title-bar icon button. Props: `name: IconName`, `title`, `active?`, `danger?`, `disabled?`, `size?` (default 15), `sw?` (stroke-width), `restColor?` (default `--text-3`), `onClick?`, `onLongPress?`, `longPressMs?` (default 500), `onContextMenu?`, `onPointerDown?`. Colours: active → `--accent`; danger+hover → `--err`; hover → `--text-2`; rest → `restColor`. Hover bg `--surface-overlay`. Focus ring `0 0 0 1.5px --accent`. `border-radius: --r-ctl`. Disabled: `opacity 0.35`.

**`BoardMenu`** — `⋯` overflow popover (trigger `IconBtn name="more"`). Via shared `Menu` shell, right-aligned. Items: Full view, Duplicate, "Add to {group}" per eligible group, Remove from group, Delete (danger).

**`BoardNode`** — React Flow custom node wrapper. Owns zoom-LOD crossfade, `NodeResizer` (visible when `selected || hovered`, min `MIN_BOARD_SIZE`), a stable `contentHost` portal (avoids remount during full-view), and `opacity 0.55` dimming. Dispatches (lazy) to `TerminalBoard`, `BrowserBoard`, `PlanningBoard`.

### Boards / content

**`TerminalBoard`** — Wraps `BoardFrame type="terminal" contentBg="var(--inset)"`. Title-bar `actions` (on select/hover): font `−`/`+`, Interrupt (`stop`, while running), Preview (`globe`), Configure (`settings`), Restart (`restart`, long-press → `TerminalRestartMenu`), Recap flip. Content: xterm.js WebGL screen (`nodrag nowheel`, 12px padding), optional idle overlay ("Start {identity}"), port picker, `BrowserPickPanel`, `TerminalHint`. Font range 8–22px (default 12.5px).

**`BrowserBoard`** — Wraps `BoardFrame type="browser"`. Title-bar `actions`: `ViewportControl` (Mobile/Tablet/Desktop) + back/forward/reload + an editable URL bar below the title bar. Content: `.bb-frame` with a DOM `<canvas>` (OSR BGRA blit), a hidden composition-proxy `<textarea>`, `OsrWidgetLayer`, and a fallback status layer (connecting / load-failed / crashed).

**`PlanningBoard`** — Wraps `BoardFrame type="planning" contentBg="var(--surface)"`. Title-bar `actions`: `PlanningToolbar` (selected-only). Content: `.pl-well` with a 12×12 dot-grid (`radial-gradient(var(--grid-dot) 1px, transparent 1px)`); cursor changes by tool. Hosts `WhiteboardSvg`, element cards, `TextToolbar`, draft preview, empty-state hint, `ElementContextMenu`.

### Whiteboard elements (inside `PlanningBoard`)

**`NoteCard`** — Sticky note, `position: absolute`, `width: element.w`. Tints `yellow`/`blue`/`green`/`plain` (see §2.1). `border-radius: --r-inner`, `box-shadow: --shadow-pop`, selection `outline: 1.5px solid --accent, outline-offset: 2`. Body: auto-sized `<textarea>` 12px/16px, `--ui`, `--text`, `padding: 9px 11px`. Hover tint-swatch pill (4 swatches, select-tool only). Slight drop rotation (±1.2°). Memoized.

**`FreeText`** — Plain-text element, no card chrome. Selection ring as above. Family: `sans` (`--ui`) / `mono` (`--term-mono`) / `serif` (`--serif`); size S=11 / M=13 / L=18 / XL=26 px; align left/center/right; color default (`--text`) / muted (`--text-2`) / faint (`--text-3`) / accent (`--accent`); bold boolean. 6px left drag-gutter. Auto-sizes textarea. Memoized.

**`ChecklistCard`** — Task checklist, `position: absolute`, `width: element.w`. `background: --surface-raised`, `border: 1px --border`, `border-radius: --r-board`, `padding: 11px 12px 12px`, `box-shadow: --shadow-pop`, selection ring as above. Header: editable title (12.5px/600), `done/total` mono counter (11px, `--text-3`). 3px progress bar (`background: --inset`, accent fill animates). Rows: 16×16 `Checkbox` (`--r-ctl`, filled `--accent` when done), item input (12px, `--text-2` undone / `--text-3` + line-through done). "Add item" link. Auto-grows parent board height. Memoized.

**`DiagramCard`** — Mermaid diagram, absolute at `element.x/y`, `width/height`. Selection ring as above. Renders the worker SVG as `<img>` (blob URL). `</>` toggle opens an inline mono source editor (debounced 450ms commit). Corner-resize handle. Inline error on parse fail. Memoized.

**`ImageCard`** — Dropped/pasted raster image; renders blob URL as `<img>`, absolute. Memoized.

**`WhiteboardSvg`** — Full-well vector layer (`position: absolute, inset: 0`). Committed arrows (SVG cubic bezier + filled arrowhead, `stroke: --text-3`, selected `--accent`) and freehand strokes (perfect-freehand → filled `<path>`, same scheme). Draft overlays, marquee rect (dashed `--accent`), alignment guides. `pointer-events: none` in draw modes.

**`TextToolbar`** — Floating typography toolbar for `FreeText`. Groups: font-family (3 toggles), size (S M L XL), align (3), bold, color swatches (4 circles). Class `.pl-text-toolbar`; buttons `.pl-tt-btn` / `.is-active`. ~380px wide.

### Chrome & overlays

**`AppChrome`** — Top-level floating shell composing `ProjectSwitcher` (top-left), `CameraCluster` (top-right), `Dock` (top-center), `SettingsModal`, `RecapConsentModal`. Islands float at `z-index: 50`.

**`ProjectSwitcher`** — Top-left pill (`height 34, border-radius 8, --surface-raised, 1px --border-subtle, --shadow-pop`). Diamond (`--accent`), project name, board count, chevron/spinner. Dropdown via `Menu` (left-aligned): recents, divider, "Open folder…", "Create project…". Dims + disables during switch.

**`CameraCluster`** — Top-right pill. Controls 28×28 each (`border-radius 6`): fit, divider, zoom-out, zoom-% reset (44px, mono 11px, `--text-2`), zoom-in, divider, `FocusGroupBtn` (when ≥1 group), `TidyMenu`, `BackdropPicker`, divider, settings. Active: `--accent-wash` / `--accent`. Hover: `--surface-overlay` / `--text`.

**`Dock`** — Top-center pill, auto-hides behind a slim handle bar when the cursor leaves a 600×120px proximity zone (100ms enter delay, 1500ms hide grace). Pinned open when a tool is armed, canvas is empty, or focus is inside. Buttons: Select (32×28), divider, Terminal/Browser/Planning `DockBtn`s (height 32, glyph + `+` + label 12.5px/500).

**`TidyMenu`** (in `CameraCluster`) — Grid picker popover (`width 248, --surface-overlay, 1px --border-subtle, --r-ctl, --shadow-pop, padding 8`). Header "Tidy layout" (11px/600, `--text-3`). Grid of preset thumbnails: 66×42px mini tiles with fractional zone rects (`--border` rest, `--accent` hover).

**`BackdropPicker`** — Camera-cluster wallpaper popover. Rows: None, bundled scenes (ambient/scenic), Wallpaper… (images ≤30MB, videos ≤200MB). Dim slider, saturation slider, grid-style segmented control (Off/Dots/Lines/Cross). Via `Menu` shell.

**`GroupBoxLayer`** — Canvas overlay inside React Flow (`z-index 5`, rides the viewport transform). One `div.group-box` per named group, drawn 20px outside member bounds (+12px inset per nesting level). `button.group-box-tab` (click = select members, double-click = focus, right-click = menu). Drop-target state: `group-box--drop-target` (accent glow). Box body `pointer-events: none`; only the tab is interactive.

**`GroupContextMenu`** — Right-click on a group tab (via `Menu`, point-anchored). Items: Rename, Focus, Add selected boards (disabled when none selected), divider, Remove group (danger).

**`GroupNamePopover`** — Inline `<input>` for (re)naming a group. Fixed-position, `z-index 250`, body-portaled. Enter/blur commit, Esc cancel.

**`GroupFocusPicker`** — Which-group picker (≥2 groups) for camera-focus. Rendered inline in `Canvas` via the shared `Menu` shell (no dedicated component file).

**`FullViewModal`** — Full-screen overlay. Scrim `.fullview-scrim` opacity 0→1, `rgba(0,0,0,0.66)`. Frame `.fullview-frame`, accent ring (1.5px `--accent`), scale .98→1. Portals the matching board's content into `fullview-host`. First-open-only "Esc to exit" hint (3s).

**`DigestPanel`** — Right-edge slide-in side panel of per-board context cards (slides `transform 200ms ease`). Each card: type tag (TERM/WEB/PLAN), title, Tier-1 digest lines or Tier-2 prose, `⟳` refresh. `inert` when closed. Width set in CSS (~280–320px).

**`AlignmentGuides`** — Screen-space SVG (`pointer-events: none`). Edge/center align lines (dashed `--accent`, 60% opacity), gap connectors (line + 5px ticks + px label pill), overlap tint rects (semi-transparent accent fill). Subscribes only to the camera transform — never re-renders from board changes.

**`MinimapIsland`** — Bottom-right React Flow `<MiniMap>` (`.wayfinding-minimap`, themed via `--xy-minimap-*`). Board rects `--border-strong`; viewport mask `--accent`, `maskStrokeWidth 1.5`. Click board → camera-fit; click empty → teleport. Toggled by `m` (null DOM when hidden).

**`BackdropLayer`** — Screen-fixed wallpaper behind React Flow (`pointer-events: none`). Image / video / animated `<canvas>` scene, with dim (CSS brightness) and saturation filters. Never re-renders on pan/zoom.

**`EmptyState`** — Shown when a project has no boards (`z-index 10`, pointer-through except buttons). Diamond watermark (`--text-3`, 60% opacity, 38px), heading + body (13px `--text-3`), three dashed ghost board-add buttons (`1px dashed --border`, radius 8, `--text-2`).

**`WelcomeScreen`** — Full-screen project picker (status `welcome | error | loading`). Recent projects, Open folder…, Create project…. Loading variant shows "Loading…".

### OSR / Browser widget overlays

**`OsrWidgetLayer`** — Per-board overlay div inside `.bb-frame` (above the canvas). Reads this board's open dialog/popup; full-frame input-intercept (modal for dialogs, click-away for popups). Hosts one of: `OsrJsDialog`, `OsrSelectOverlay`, `OsrDatePicker`, `OsrColorPicker`.

**`OsrJsDialog`** — Modal for previewed-page `alert`/`confirm`/`prompt`. `.bb-osr-dialog`, `role="dialog" aria-modal="true"`. Origin label ("This page says"), message, optional `<input>` for prompt. Cancel (confirm/prompt) + OK (primary). Enter=OK, Esc=Cancel.

**`OsrSelectOverlay` / `OsrDatePicker` / `OsrColorPicker`** — HTML replacements for native `<select>` / `<input type="date">` / `<input type="color">` popups in OSR, positioned in frame-local coords mapped from the page's popup rect.

### Inputs & controls

**`Icon`** — Monochrome SVG. Props: `name`, `size?` (16), `sw?` (1.5), `style?`. All icons 24-unit viewBox, `stroke="currentColor"`, `fill="none"`, round caps/joins. Catalogue includes: `play pause restart stop more fit plus minus select note text arrow pen erase diagram refresh back forward chevron search diamond grid maximize minimize x copy check trash settings globe external camera download volume volume-x magnet align-* distribute-h distribute-v connector agent-claude agent-codex agent-gemini agent-opencode agent-shell` (single-path) and `mobile tablet desktop` (multi-primitive).

**`TypeGlyph`** — Board type glyph, `currentColor`. Terminal: mono `›` + 6×11 block caret (blinks while running). Browser: 15×15 framed-window SVG. Planning: 15×15 dashed square + pen stroke. Props: `type`, `running?`.

**`Menu`** — Shared popover shell. Body portal; measures+clamps into viewport before paint; flips above on bottom overflow. Dismisses on Esc / outside `pointerdown` (capture) / `resize`. Roving tabindex + Arrow/Home/End over `[role="menuitem"]` / `[role="menuitemradio"]`; Tab closes; focus restore on close. Props: `anchor: {x,y} | RefObject`, `align?: 'left' | 'right'`, `gap?`, `onClose`, `label?`, `className?`, `style?`, `reclampKey?`, `autoFocus?` (default true).

**`Modal`** — Shared modal primitive. Body portal. Scrim `--scrim`. Tab trap; Esc on bubble-phase window listener (yields to full-view's capture listener). Focus to `initialFocusRef` or first focusable on mount, restored on unmount. Props: `label`, `onClose`, `closeDisabled?`, `zIndex`, `confirmGate?`, `initialFocusRef?`, `scrimProps?`, `cardProps?`, `cardStyle?`, `children`.

**`ElementContextMenu`** — Right-click menu for Planning elements (reused for the Terminal well). Point-anchored, `width 184`, `z-index 9999`, via `Menu`. Entry kinds: `action` (optional `danger` = `--err`), `iconRow` (label + icon-button strip), `swatchRow` (16×16 swatches with accent ring on current).

**`PlanningToolbar`** — Planning tool cluster (title-bar `actions`, selected-only). `IconBtn`s in a `--inset` pill (`1px --border-subtle`, `--r-inner`): select, note, text, check, diagram, arrow, pen, erase (size 15), divider, magnet (snap toggle), divider, `ExportPopover` trigger.

**`ViewportControl`** (in `BrowserBoard`) — Segmented 3-button (`Mobile | Tablet | Desktop`). Active: `--accent-wash` / `--accent`, label shown. Inactive: transparent, `--text-3`, icon only. Height 22px, `padding 0 8`, `border-radius 4`. Inner `VpToggle` shows label only when active.

**`ExportPopover`** (in `PlanningToolbar`) — Download trigger + mini popover (PNG / SVG). Body-portaled, right-aligned.

**`BrowserPickPanel`** — Multi-select panel (in the terminal well, `.ca-port-picker`) for routing a preview URL to browser boards. Checkbox candidate list + "New browser" row + Confirm/Cancel.

**`TerminalRestartMenu`** — Small `Menu` popover anchored to the restart button: Resume (`claude --resume <sessionId>`) and New session.

**`PresetThumb`** (in `TidyMenu`) — 66×42px zone-layout preview tile; inner `.ca-zone` rects (rest `--border` bg, hover `--accent`).

### Feedback

**`ToastIsland`** — Bottom-right toast stack (`z-index` from CSS; `toast-island--lifted` clears the minimap). Max 3 visible. Each `ToastItem`: `role="alert"` (error) / `role="status"` (other), 5000ms auto-dismiss (sticky toasts never expire), coloured dot (`data-kind`), message, optional action button, dismiss `✕`. Kinds: `info | error | warn | success` (see gap note).

**`TerminalHint`** — First-run hint pill in a bare terminal well (`.ca-term-hint`). Action button ("Set a launch command (e.g. claude) ⚙") + dismiss `×` (dismisses app-wide forever). Rendered only when `launchCommand` is empty and `state !== 'idle'`.

**`RecapView`** — Terminal recap back-face (flip). Zone 1 (status colour/label from `--warn`/`--ok`/`--err`/`--text-3`, NOW/NEXT narrative, Resume/Start/Refresh), Zone 2 (timeline beats, CHANGED/COMMANDS chips, last-ask footer). `background: --surface` (opaque). `IconBtn name="refresh"` re-summarizes.

**`SettingsModal`** — LLM settings on the `Modal` primitive. Provider selector (OpenRouter/OpenAI/Anthropic/Local), model input, optional base URL, masked write-only API key, key-status indicator, env-var hint, recap consent toggle. Busy lock during save.

**`RecapConsentModal`** — One-time consent prompt for terminal recap (transcript-reading). On `Modal`. Enable/Decline. Fires on first project open with undecided consent (guarded against showing when no project is open).

**`ConfirmModal`** — MCP dangerous-action gate. FIFO queue, one at a time on `Modal` (`z-index 10000, confirmGate=true`). Title + scrollable body (`max-height 50vh`). Deny (secondary) + Approve (`background: --accent`). Esc = Deny.

**`ErrorBoundary`** — Per-board fallback. Renders `<div class="board-error" style="padding:16; color:var(--text-2)">This board failed to render</div>` on uncaught render errors.

**`NewTerminalDialog`** — Portal modal (create / edit). Agent preset picker (Claude / GPT / Gemini / Shell), `CommandBuilder` (searchable flag composer), shell selector, working-directory field, font-size picker (8–22px, default 12.5px), Cancel / Create (or Apply & restart).

**`CommandPalette`** — Portal overlay (Ctrl+K → commands; `?` → shortcuts). Center, `max-height 60vh`, animated in 120ms. Search input (combobox, ↑/↓, Enter). Command rows grouped by section (Canvas / Board / Group / View); static shortcuts reference in the shortcuts view.

**`AuditLogViewer`** — Developer/diagnostic portal panel (internal tooling, no user-facing design spec).

### Component gaps / notes

- `ExportPopover` hand-rolls its own portal + dismiss instead of the shared `Menu` shell — the only popover not on the shared primitive.
- `ToastIsland` CSS implies `info / warn / success / error` via `data-kind`, but the store's `Toast` type only exports `kind: 'info' | 'error'` — warn/success colours are unreachable via the public API.
- `Modal` and `FullViewModal` keep intentionally different scrim weights (`--scrim` token vs explicit `rgba(0,0,0,0.66)`) — two scrim implementations.
- `ElementContextMenu` injects a scoped `<style>` block inside the `Menu` portal rather than a CSS module/global class.
- `TypeGlyph` Terminal is a DOM span (text + block span); Browser/Planning are inline SVGs — substrate differs.
- `DockBtn` / `ToolBtn` (private to `AppChrome`) duplicate most of `IconBtn`'s hover/active/colour logic at 28–32px — effectively a second button primitive with no shared abstraction.
- The `BrowserBoard` URL bar is a bespoke inline component with no exported name.

---

## 4. Information architecture

### Overview

Single-window Electron app — no routes or browser-style history. The window holds one of two mutually exclusive top-level surfaces — the **Launch / Project Picker** or the **Canvas Workspace** — with floating modal layers over either. Active surface is driven by `project.status` in Zustand: `'welcome' | 'loading' | 'error'` → launch screen; `'open'` → canvas workspace.

### Surface tree

```
Window (single Electron BrowserWindow, fixed inset 0)
│
├── [status: welcome | loading | error]  →  Launch Screen  (WelcomeScreen)
│       ├── App mark (diamond, 38px, var(--text-3))
│       ├── Headline  "Canvas ADE"
│       ├── Error line (var(--err), conditional) / Loading line ("Loading…", role=status)
│       ├── Action row:  "Create project…"  ·  "Open folder…"  (OS folder picker → canvas.json)
│       └── Recent projects list (stored in userData, not the project folder)
│             ├── Recent row × N:  <name> + <path>  ·  "✕" remove
│             └── "Clear all"
│
└── [status: open]  →  Canvas Workspace  (Canvas wrapping ReactFlowProvider)
        │
        ├── BackdropLayer  (screen-fixed wallpaper; none | file | scene)
        │
        ├── ReactFlow pane  (infinite, zoom 0.1–2.5)
        │     ├── Grid  (dots/lines/cross; opacity fades as zoom decreases)
        │     ├── GroupBoxLayer  (outline boxes + name tabs; z-index 5)
        │     ├── Board nodes × N  (BoardNode → BoardFrame + per-type content)
        │     │     ├── LOD card  (zoom < ~40%: glyph 1.6× · TYPE tag · title · status dot)
        │     │     └── Full-chrome board:
        │     │           ├── Title bar  (drag handle; selected → --accent-wash)
        │     │           │     glyph · TYPE tag · title (dbl-click/F2) · status (hover/select)
        │     │           │     · per-type actions · connector handle · full-view · ⋯ menu
        │     │           ├── Progress sliver  (2px top; running / spawning)
        │     │           └── Content well:
        │     │                 ├─ [terminal]  xterm canvas · idle overlay · port picker ·
        │     │                 │              BrowserPickPanel · TerminalHint · context menu · RecapView
        │     │                 ├─ [browser]   <canvas> OSR · URL bar · device frame ·
        │     │                 │              OsrWidgetLayer · "paused" badge
        │     │                 └─ [planning]  WhiteboardSvg · NoteCard · FreeText · ChecklistCard ·
        │     │                                ImageCard · DiagramCard · ElementContextMenu
        │     ├── Edges:  "preview" (accent; terminal → browser)  ·  "orchestration" (--connector / --connector-selected)
        │     ├── AlignmentGuides  (ephemeral snap lines + overlap tints; never persisted)
        │     └── MinimapIsland  (bottom-right; toggle `m`; board rects --border-strong, viewport --accent)
        │
        ├── AppChrome  (floating islands, z-index 50, never full-width):
        │     ├── Project switcher  (top-left)   ── pill + dropdown Menu (recents / Open / Create)
        │     ├── Camera cluster   (top-right)   ── fit · −/NN%/+ · focus-group · tidy · backdrop · settings
        │     └── Board dock       (top-center)  ── auto-hide pill: Select · +Terminal · +Browser · +Planning
        │
        ├── Drag-to-create capture overlay  (z-index 40; crosshair; ghost rect + type chip while a dock tool is armed)
        ├── Connector rubber-band           (ephemeral SVG; dashed --border-strong while dragging a connector)
        ├── Empty-state overlay             (z-index 10; watermark + heading + 3 ghost board buttons; 0 boards)
        ├── Group-create FAB                (when ≥2 boards selected; "⌘G / Ctrl+G  Group N")
        ├── Group overlays                  (one at a time: GroupNamePopover · GroupFocusPicker · GroupContextMenu)
        └── DigestPanel                     (right-edge slide-in; per-board context cards; auto-opens on load)
│
├── FullViewModal       (portal; fullscreen; scrim 66% black; 1.5px accent ring; portals live board content; "Esc to exit" hint)
├── CommandPalette      (portal; Ctrl+K commands / `?` shortcuts)
├── SettingsModal       (portal; LLM provider/model/key + recap-consent toggle)
├── RecapConsentModal   (portal; once per project when consent 'undecided')
├── ConfirmModal        (portal; destructive-action confirm; Zustand-driven)
├── AuditLogViewer      (portal; developer/diagnostic; only when canvas open)
├── ToastIsland         (App root; survives project switch; kinds info / error; sticky error → Retry)
└── NewTerminalDialog   (portal; create/edit; preset picker · CommandBuilder · shell · cwd · font size 8–22px)
```

### How surfaces relate

- **Launch → Canvas Workspace** is the only top-level transition. On boot, App calls `window.api.project.current()`; an existing recent project opens immediately, skipping the launch screen. The `'loading'` status re-renders the WelcomeScreen with a loading message (same DOM, no separate skeleton). The prior canvas is torn down before the new one mounts — two projects are never simultaneously visible.
- **Persistent chrome** (always mounted while the workspace is open): AppChrome, DigestPanel, ToastIsland. ToastIsland mounts at the App root so toasts survive the launch/workspace transition.
- **Ephemeral chrome** (mounted on demand, layered over the canvas, destroyed when their trigger clears): alignment guides, drag-to-create capture overlay, connector rubber-band, empty-state, group FAB, and the three group overlays.
- **Portal modals** (body-portaled, above all canvas content; each on the shared `Modal` primitive): FullViewModal, CommandPalette, SettingsModal, RecapConsentModal, ConfirmModal, NewTerminalDialog, AuditLogViewer. **Esc priority:** ConfirmModal → CommandPalette → FullViewModal (capture-phase Esc).
- **A project = one canvas.** No tabbed multi-canvas or split-pane. One `canvas.json` at the project-folder root; the canvas holds `N` boards. Boards can be organized into **Named Groups** (zero or more; a board belongs to at most one). Groups are a camera-fit affordance + logical organization layer drawn in `GroupBoxLayer` — not a separate surface.
- **Full view** does not change the camera or create a surface — it portals the live board content into a fullscreen overlay while the board stays in its node position. (Planning full view uses a camera fit instead.)

### IA gaps / notes

- DigestPanel width is set in CSS (~280–320px), not the component file.
- BackdropPicker popover dimensions/content structure not captured in this pass.
- AuditLogViewer is internal diagnostic tooling, not a user-facing surface.
- SettingsModal has no tab structure — LLM config + recap toggle coexist on one card; max-width set in `Modal`'s `cardStyle`.
- Treat `'loading'` as a state variant of the Launch Screen, not a separate frame.

---

## 5. Patterns & conventions

### Layout: canvas, sizing, chrome placement, z-ordering

**Canvas surface**
- Backdrop `#0a0a0b` (`--void`). Grid drawn in screen space, pans/scales with the camera. Default **dots**: 1px circles `#202022` on a **24 world-px lattice** (`GRID_GAP = 24`). Alt: thin lines / cross / plain.
- Grid dot opacity: `clamp((zoom − 0.18) / 0.22, 0.15, 1)` — floor 0.15 at heavy zoom-out, full by ~40%; effectively fades to void below 30%.
- Camera zoom range **0.1 → 2.5** (`Z_MIN`/`Z_MAX`). Transform `translate(x, y) scale(z)`, origin `0 0`.
- Pan: drag empty canvas (`grab` → `grabbing`). Zoom: Ctrl/⌘ + wheel or pinch, toward cursor.

**Board sizing**
- Minimum `240 × 160 px` world-space (`MIN_BOARD_SIZE`). Defaults on create: Terminal `420 × 340`, Browser `700 × 500`, Planning `516 × 366`. Boards keep world-space size at all zoom levels.
- LOD below **40% zoom** (`LOD_ZOOM = 0.4`): compact card (glyph + tag + title + 8–9px dot), 100ms crossfade (`ca-lod-card` / `ca-lod-out`).
- Resize: 8 handles (4 corners 10×10px, 4 edge midpoints with 8px hit area), `--surface-overlay` fill, `1px --border-strong`, `border-radius 2px`; bottom-right has extra `box-shadow: 0 0 0 1px var(--accent)`. 100ms fade-in on hover/select.

**Floating app chrome — all islands, never full-width bars (tldraw-style)**
- **Top-left:** Project switcher pill — `◇` 16px `--accent` + name (`.t-label` 12px/500) + `· N boards` (11px mono `--text-3`). `--surface-raised`, `1px --border-subtle`, `--shadow-pop`.
- **Top-right:** Camera cluster — fit · divider · `−` / `NN%` / `+` · divider · focus-group (when groups) · tidy picker · backdrop picker · divider · settings.
- **Top-center:** Board dock — auto-hiding pill (`--surface-raised`, 4px padding, 3px gap), hides behind a 56×6px grabber bar (`--border`, radius 3px). Reveals on entering a **600×120px** zone (100ms enter / 1.5s hide grace); pinned when armed, empty, or focus-within. Wrapper `pointer-events: none`; only the revealed pill opts back in.
- **Bottom-right:** Minimap island (`--surface-raised`, `1px --border-subtle`, `--r-inner`, `--shadow-pop`; board rects `--border-strong`, selected `--accent`, viewport ring `--accent`; entrance 120ms; toggle `m`).
- **Bottom-right toasts:** `right: 16px; bottom: 16px`, `z-index 10100`. When the minimap is visible, toasts lift to `bottom: 175px`.

**Z-ordering (back → front)**
1. Backdrop layer (`--void` / wallpaper) · 2. React Flow surface (board nodes, world-space) · 3. Alignment guides SVG (`z-index 5`, pointer-events none) · 4. Group box layer (RF node order) · 5. Floating chrome islands (~`z-index 50`) · 6. Digest panel (`z-index 70`) · 7. Full-view scrim (`z-index 200`, `rgba(0,0,0,0.66)`) · 8. Board menus (`z-index 250`, so ⋯ works inside full view) · 9. Settings modal (`z-index 300`) · 10. Toast island (`z-index 10100`, over every modal). The OSR `<canvas>` composites inside `.bb-frame` (a normal DOM node — clips & z-orders); OSR widget overlays render at `z-index 3` inside `.bb-frame`. The IME proxy `<textarea>` is `opacity:0; pointer-events:none` — never `display:none` (would kill focus/composition).

### States: loading, empty, error, paused/frozen, disabled

- **Empty canvas:** centered low-key prompt over the canvas (`z-index 10`, pointer-through wrapper). `◇` 38px `--text-3` @60% + `h`-scale heading "Empty canvas" (`--text`, 15px/600/−0.01em) + body ("Drop a board to start — spin up a coding agent, preview your running app, or sketch a plan." `--text-3`, 13px, `line-height 1.5`, max 320px). Three ghost-outline buttons (`1px dashed --border`, transparent, `--text-2`, 13px/500, radius 8, `padding 9px 14px`) mirror the dock's three types. Tone: direct, two clauses max, no exclamation marks.
- **Loading / switch:** switcher pill `opacity 0.6`, disabled; name "Loading…"; chevron → spinning refresh (`digest-spin 0.8s linear infinite`). Welcome loading variant: "Loading…" in `--text-2` at `--fs-meta`.
- **Error:** Welcome error in `--err` at `--fs-meta`. Browser board state overlay `.bb-state` (`inset:0`, `--surface`, centered): title 12px/500 `--text-2`, subtitle 10.5px mono `--text-3` (single-line ellipsis). Crashed board adds a `.bb-reload-btn` ("Reload", `padding 3px 14px`, `1px --border-subtle`, `--accent-wash` bg, `--accent` text, `--r-ctl`, 11px/500; hover `border-color --accent`) — crashes never auto-loop, this is the only recovery. URL invalid: `.bb-url-invalid` `border-color --err` + inline error (`--err`, 10.5px mono). **Save failure:** a sticky error toast (never expires) with "Retry"; the canvas stays usable. Switch-save failure aborts the switch with the same sticky toast.
- **Paused/frozen preview:** evicted from the MAX_LIVE pool (~4): last frame frozen on the `<canvas>` + `.bb-paused-badge` ("Paused", `top:8 right:8`, `padding 2px 8`, `1px --border-subtle`, `--surface-raised`, `--text-2`, radius 999, 10px/500). Off-screen/below-LOD-but-within-cap boards just freeze (no badge).
- **Disabled:** `--text-faint` `#46464b` is disabled-only. `IconBtn` disabled `opacity 0.35`; general buttons `opacity 0.45`; disabled dropdown options & group-ctx rows use `--text-faint`.
- **Terminal "spawning":** progress sliver with `ca-progress-spawn` — `2.4s` duration, `opacity 0.55` (activity before full running).

### Interaction patterns

- **Select / multi-select / marquee:** single click selects; empty-canvas click clears; React Flow handles marquee drag. Selected board: `box-shadow: 0 0 0 1.5px var(--accent), var(--shadow-board)`; title `--text-2`→`--text`; title bar tints `--accent-wash`; the 1px border stays neutral (the ring is the entire signal). `Ctrl/⌘+G` groups the selection.
- **Drag-to-create:** arm a type from the dock → crosshair capture overlay (`inset:0; z-index 40`). Drag paints a `.placement-ghost` (`1px solid --accent`, `--accent-wash`, `--r-board`, fixed, pointer-events none) with a corner label chip (`.placement-ghost-chip`, `--accent` bg, `#fff` text, 11px/500, radius 5, `padding 2px 7`). Click-no-drag creates at default size centered on the click. Sub-minimum drags clamp to 240×160 anchored at the gesture top-left. Clicking "Select" disarms.
- **Alignment guides (drag-time):** screen-space SVG (`z-index 5`, pointer-events none). Align lines `stroke: --accent`, `stroke-width 1`, `dasharray 4 6`. Gap connectors solid accent + a px pill (`fill: #fff`, 10px, tabular-nums). Overlap nudge: `rgba(255,92,92,0.18)` wash, no border. Snap suppressed while Ctrl/⌘ held.
- **Grouping (Ctrl+G):** ≥2 selected → dashed `.group-box` (`border: 1.5px solid var(--accent-wash)`, `--r-ctl`, pointer-events none) with a centered `.group-box-tab` (20px/700 `--text`, `--surface-raised`, `1px --border-subtle`, radius 8, `padding 4px 16`; hover `--accent` + `--accent-wash` border). Drop-target: `border-color --accent`, 2px, `color-mix(in srgb, var(--accent) 8%, transparent)`. Absorb reflow `280ms cubic-bezier(0.2,0.7,0.2,1)` on board transforms + box geometry. Group FAB (bottom-center during multi-select): `height 34`, `padding 0 14`, 12.5px, `--accent` on `--surface-raised`, `1px --accent-wash`, radius 9, `--shadow-pop`; hover `--accent-wash`.
- **Focus / full-view:** **Focus** (double-click, or Enter on a keyboard-selected board) animates the camera so the board fills the viewport (64px padding, maxZoom 2, 200ms `cubic-bezier(0.2,0.7,0.2,1)`); others dim to 55%; the board does not move; Esc or double-click empty exits. **Full view** (maximize / ⋯) lifts the board into a fixed overlay without moving the camera (scrim `rgba(0,0,0,0.66)`, `z-index 200`; board `box-shadow: 0 0 0 1.5px var(--accent), var(--shadow-board)`, `--r-board`, `overflow hidden`; enter scrim `opacity 0→1` + frame `scale 0.98→1`). First entry per session: a bottom-center "Esc to exit" hint with `<kbd>` chips (`background --surface`, `1px --border`, radius 4, `padding 1px 5`, mono 11px `--text`). Exit: title-bar toggle, Esc (capture phase — beats xterm's stopPropagation), or scrim click.
- **Tidy / auto-layout:** `T` or the grid icon opens a right-aligned preset picker (FancyZones-style thumbnails). `.ca-tidy-preset` (74px): transparent → `--surface-raised` on hover; inner `.ca-zone` rects `--text-3` → `--accent` on hover (`transition 0.1s`); label `--text-2` → `--text`. After apply: reflow then `fitView` (64px, maxZoom 2, 200ms).
- **Context menus / board menu:** `⋯` (`more` icon 16px, `stroke-width 2.6`, rest `--text-2`; open → `--accent`). `.board-menu` (`min-width 132`, `--surface-overlay`, `1px --border-subtle`, `--r-ctl`, `--shadow-pop`, `padding 4`, `z-index 250`). Items 12px, `padding 6px 10`, `--text-2` → `--text` on hover (`--surface-raised` bg); danger hover `--err`. Text-only, no icons. Project-switcher menu `min-width 220`, items 13px `--text`, `padding 7px 10`, hover `--surface-overlay`. All menus: body portals, viewport-clamped, right-aligned under trigger (flip above on overflow), Esc / outside-click / resize close, roving tabindex + arrow nav, re-click-trigger toggles closed. Focus ring `0 0 0 1.5px var(--accent)`.
- **Command palette (Ctrl+K):** center, `max-height 60vh`, in 120ms (`opacity + translateY(-4px)`). `?` opens shortcuts. Search input bare `--text` 13px (placeholder `--text-3`). Rows `.cp-row` height 30, `--r-ctl`, `--text-2`; hover `--surface-overlay`; active `--accent-wash` + `--text`; glyph 16px mono `--text-3` (active `--accent`). Section headers 10px/500/UPPER/+0.06em `--text-3`. Footer mono 11px `--text-3`, `border-top 1px --border-subtle`. Empty state centered 13px `--text-3`.

**Keyboard shortcuts**

| Key | Action |
|---|---|
| `1` | Zoom to fit (all boards, 64px pad, maxZoom 2) |
| `0` | Reset zoom (100%, recentered) |
| `T` | Tidy layout |
| `F` | Focus selected group |
| `M` | Toggle minimap |
| `?` | Command palette — shortcuts view |
| Ctrl/⌘+`K` | Command palette — commands view |
| Ctrl/⌘+`Z` | Undo |
| Ctrl/⌘+`Shift+Z` / Ctrl+`Y` | Redo |
| Ctrl/⌘+`G` | Group selection |
| `Esc` | Clear selection / exit full view (capture phase) |
| `F2` / dbl-click title | Inline rename selected board |
| `Enter` (on board) | Focus (camera fit) |
| `Tab` / `Shift+Tab` | Cycle board selection |
| Arrow keys | Nudge board 1px (Shift = 10px) |
| `Alt+Arrow` | Resize board 1px (Shift = 10px) |
| `Backspace` / `Delete` | Remove selected board or connector |

*Bare-key shortcuts (1, 0, T, F, M, ?) are guarded — they don't fire when a text input is focused or the pointer is inside a `.react-flow__node`; Tab/Enter/Arrow require focus on `body` or the pane.*

### Visual voice rules

- **Zero decorative chrome.** No glassmorphism, no UI-surface gradients, no glow, no colored drop-shadows. The only gradients in the whole system are functional: the indeterminate progress sliver (`linear-gradient(90deg, transparent, var(--accent), transparent)`), the browser stage hatching (45° repeating-linear of two inset tones), and the color-picker hue ramp. No filled, colored primary buttons — the "primary" pattern is `color: var(--accent)` + `border-color: var(--accent)` + `background: var(--accent-wash)`.
- **One accent, one role.** `--accent` `#4f8cff` = selected / focused / running / active / current-segment value, never decoration (hover `--accent-hover` `#6ea0ff`, fill `--accent-wash`). Status hues only at 8px dots / 1px rings: `--ok` `#3ecf8e`, `--warn` `#e8b339`, `--err` `#f2545b`. Orchestration arrowheads: `--connector` `#5a6573` rest / `--connector-selected` `#e6e6e6`.
- **Calm/dense Linear-Raycast feel.** Compact type scale; 34px title bar; paddings step in 4px. Chrome recedes until touched (status labels only on hover/select; planning-element delete buttons `opacity:0` until hover; dock hides behind a handle; minimap off by default). `--text-3` `#7b7b81` is the minimum readable non-disabled text (WCAG AA at the 10px tag size); `--text-faint` is disabled-only. UI font Geist everywhere except terminal output (`--term-mono`) and mono meta (`--mono`: URL bars, readouts, zoom %, status, board count, type tags, `<kbd>`).
- **Exactly two shadows.** `--shadow-board` (boards), `--shadow-pop` (popovers/menus). The selected ring (`0 0 0 1.5px var(--accent)`) is prepended to `--shadow-board`, not an extra elevation. Device-frame inset uses a single `box-shadow: 0 1px 0 rgba(255,255,255,0.05) inset` highlight.
- **Motion.** Camera ops `200ms cubic-bezier(0.2,0.7,0.2,1)`; pan/wheel-zoom 1:1 no easing. Board ring/dim `120ms ease-out`; handles 100ms; LOD crossfade 100ms; hover border 100ms; full-view 200ms (scrim + scale 0.98→1); progress `1.2s linear` (spawning `2.4s`/`0.55`); status pulse `1.8s`; caret blink `1s steps(1)`; toast 140ms; minimap 120ms; dock auto-hide 120ms; digest slide `200ms ease`; group reflow `280ms`. `prefers-reduced-motion` → all loops `none !important`, all transitions `none !important`, camera `duration: 0` (the full-view JS timer still runs, just without the tween).
- **Scrollbars:** `scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent`.
- **Accessibility built-ins:** color-only status signals carry a paired `<span class="sr-only">` and/or `role="status" aria-live="polite"` region; `SrBoardStatus` is always-mounted and fires only on real transitions. Focus rings `box-shadow: 0 0 0 1.5px var(--accent)` (suppressing the default `:focus-visible` outline) on planning inputs, welcome/nav buttons, project-switcher items, group rows, tidy tiles, board menu items. `sr-only` = standard clip-rect.

### Patterns gaps / notes

- `--text-faint` disabled-only is a soft rule — code discipline, no lint guard.
- Type-tag text uses `.t-micro` properties but applies `font-family: var(--mono)` inline (`.t-micro` sets no family).
- No documented z-index constant registry (5, 40, 50, 70, 200, 250, 300, 10100 are scattered) — correct order, but additions could collide.
- `--scrim` (modal) and the full-view scrim (`rgba(0,0,0,0.66)`) are deliberately not consolidated.
- Planning's 12px dot grid is implemented inline, not tokenized (distinct from the 24px canvas lattice).
- Note tint `plain` has no `--note-plain-*` token (falls back to `--surface-raised` / `--border`).
- No first-launch onboarding beyond the empty-canvas prompt.
- No keyboard path to drag-size a board (click-to-create at default size only).
- Planning arrows use `--border-strong` (rest) / `--accent` (selected), NOT `--connector` / `--connector-selected` (those are canvas-edge only) — two parallel "connector" color systems.

---

## 6. New feature brief

> **READY-TO-FILL PRD TEMPLATE.** No feature is specified yet — fill this in when you start a new feature. The user is just initializing the design. Leave the bracketed placeholders until there is a concrete feature to design; then replace each `[…]` and design every named surface against Sections 2–5 above.

When a feature is chosen, copy this skeleton and complete each field. Keep every answer concrete — name the exact tokens and components you'll reuse so the new work stays visually identical to the existing system.

### PRD skeleton

**Goal**
[What problem this feature solves / the outcome. One or two sentences — the user-facing result, not the implementation.]

**Primary user flow**
[Step-by-step, the happy path. Number the steps. Start from where the user is (which surface) and end at the completed outcome. Note any branch points or error paths separately below the happy path.]

**Screens / surfaces needed**
[List which frames to design. For EACH, classify it as one of: a new **board type** (rare — adds a 4th type to Terminal/Browser/Planning and must follow the full board-chrome contract in Section 1); a **Planning element** (a card inside a Planning board, like NoteCard/ChecklistCard/DiagramCard); a **modal** (portal on the shared `Modal` primitive); or **chrome** (a floating island, dock button, camera-cluster control, menu, or overlay). State the surface's default size and where it lives (top-left / top-right / top-center dock / bottom-right / portal).]

**Tokens to reuse**
[Point to specific tokens from Section 2 so the feature stays consistent. At minimum name: the accent (`--accent` `#4f8cff` + `--accent-wash` for fills), the surface ramp (`--void` / `--surface` / `--surface-raised` / `--surface-overlay` / `--inset`), text ramp (`--text` / `--text-2` / `--text-3`; never `--text-faint` except disabled), borders (`--border-subtle` / `--border` / `--border-strong`), radii (`--r-board` 8 / `--r-inner` 6 / `--r-ctl` 5 / `--r-pill`), the two shadows (`--shadow-board` / `--shadow-pop`), and any status hues you need (`--ok` / `--warn` / `--err`). Spacing in 4px steps.]

**Components to reuse**
[Point to specific components from Section 3 — do not invent new primitives where one exists. Typically: `BoardFrame` + `IconBtn` (board chrome & title-bar actions), `Dock` / `CameraCluster` islands (entry points), the shared `Menu` shell (any popover — do NOT hand-roll), the shared `Modal` primitive (any dialog), `Icon` + `TypeGlyph` (glyphs), `ToastIsland` (feedback), `ElementContextMenu` (right-click), `EmptyState` (zero-state). Name the closest existing component and whether you extend it or compose with it.]

**Consistency checklist**
- [ ] One accent only (`#4f8cff`) — functional, never decorative. No second hue beyond the status dots.
- [ ] No glassmorphism, no gradients on UI surfaces, no glow, no colored drop-shadows. Only the two system shadows.
- [ ] Calm/dense Linear-Raycast feel — compact type scale, 4px spacing steps, chrome recedes until touched.
- [ ] Dark theme on the `--void`/`--surface` ramp — no light surfaces.
- [ ] Match the board-chrome contract (Section 1) for anything board-shaped: 8px radius, neutral border, accent ring for selection, 34px title bar, 8 resize handles, LOD card below 40% zoom.
- [ ] Popovers go through the shared `Menu` shell; dialogs through the shared `Modal` primitive; floating islands use the pill shell (`--surface-raised` + `1px --border-subtle` + `--shadow-pop`).
- [ ] Primary action = accent-on-wash (`color: --accent` + `border-color: --accent` + `background: --accent-wash`), never a solid-colored slab.
- [ ] Honor `prefers-reduced-motion` and the `0.2,0.7,0.2,1` camera easing for any new motion.
- [ ] Add a `sr-only` label / `aria-live` region for any color-only status signal; focus ring `0 0 0 1.5px --accent`.

*Worked example (hypothetical, for level of detail only): For a "Snippet" board that pins a saved terminal command — **Goal:** let the user park reusable CLI commands on the canvas and re-run them in any Terminal board. **Primary user flow:** (1) from the dock, arm "+ Snippet"; (2) drag out a board; (3) type or paste a command; (4) hover a Terminal board's title bar → a "Run here" affordance appears; (5) click to inject the command. **Surfaces:** the Snippet board itself = a new board type (full board-chrome contract, default ~320×180, `--inset` content well like Terminal); the "Run here" affordance = chrome (a title-bar `IconBtn name="play"` on Terminal boards). **Tokens:** `--surface` body, `--inset` code well, `--accent` for the active "Run here" state, mono `--term-mono` for the command text, `--r-board` 8px. **Components:** `BoardFrame` (shell), `IconBtn` (the play affordance), `ToastIsland` (a "Sent to Terminal" success toast). **Consistency:** the play button is accent-on-wash when armed; the command text uses the terminal mono font; selection is the accent ring, not a colored border.*
