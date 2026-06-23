# Canvas ADE — Design-System Constraints for the JSON Data-Flow Viewer

Extracted verbatim from `tokens.css` and `boards/browser-devtools.css`. Values are exact. No files were edited.

---

## 1. Token Cheat-Sheet

### Surfaces (furthest → closest)
| Token | Value | Use |
|---|---|---|
| `--void` | `#0a0a0b` | Furthest backdrop; also the checkmark glyph color on filled accent |
| `--grid-dot` | `#202022` | Canvas dot grid |
| `--surface` | `#141416` | Default panel ground (the `.bb-net` shell) |
| `--surface-raised` | `#1a1a1d` | Hover rows, meta strips, subtab bar, sticky headers |
| `--surface-overlay` | `#1e1e22` | Popovers, load button bg |
| `--inset` | `#0e0e10` | Recessed wells: filter box, dock-switch track, progress-bar track, timing bars |

### Borders
| Token | Value | Use |
|---|---|---|
| `--border-subtle` | `rgba(255,255,255,0.06)` | Most internal hairlines (row separators, header bottom) |
| `--border` | `rgba(255,255,255,0.10)` | Panel dock edge (top/left split border), popover edge |
| `--border-strong` | `rgba(255,255,255,0.16)` | Checkbox outline, load button border, scrollbar thumb |

### Text
| Token | Value | Contrast note |
|---|---|---|
| `--text` | `#ededee` | Primary; emphasized values (`.bb-net-v`, `.net-name`) |
| `--text-2` | `#9b9ba1` | Secondary body / dd values / input text |
| `--text-3` | `#7b7b81` | Tertiary: labels, keys (dt), dim meta. AA-safe floor for readable text |
| `--text-faint` | `#46464b` | DISABLED-ONLY (~2.8:1). Never for readable content |

### Accent + status (the constraint that drives §3)
| Token | Value | Rule |
|---|---|---|
| `--accent` | `#4f8cff` | The ONE functional accent. Structure, selection, focus, active tab |
| `--accent-hover` | `#6ea0ff` | Accent hover only |
| `--accent-wash` | `rgba(79,140,255,0.14)` | Selected-row / active-toggle fill |
| `--ok` | `#3ecf8e` | Status green (success, live, outgoing WS frame) |
| `--warn` | `#e8b339` | Status amber (paused, dropped) |
| `--err` | `#f2545b` | Status red (failures, ≥400, invalid regex) |

Derived accent tints in use (no new hex): `color-mix(in srgb, var(--accent) 35–45%, transparent)` for waterfall-wait bars, WS pills, active pill borders.

### Other chrome colors
| Token | Value |
|---|---|
| `--scrim` | `rgba(0,0,0,0.5)` (modal) |
| `--connector` / `--connector-selected` | `#5a6573` / `#e6e6e6` |
| note tints (yellow/blue/green fill+edge) | low-chroma pairs, e.g. `--note-blue-fill #16202b` / `--note-blue-edge #22354a` |
| `--notch` | `#15161a` |

### Fonts
| Token | Stack |
|---|---|
| `--ui` | `'Geist', system-ui, -apple-system, sans-serif` |
| `--mono` | `'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace` |
| `--term-mono` | `'Cascadia Mono', Consolas, 'SF Mono', Menlo, ui-monospace, monospace` (xterm grid only) |
| `--serif` | `Georgia, 'Times New Roman', serif` |

Geist + Geist Mono are self-hosted variable woff2 (weight 100–900), `font-display: swap`, CSP `font-src 'self'`.

### Type scale (size / line-height / weight / tracking)
| Role | `--fs` | `--lh` | `--fw` | `--tr` | Notes |
|---|---|---|---|---|---|
| micro | 10px | 14px | 500 | 0.06em | UPPERCASE section labels, table `th` |
| meta | 11px | 16px | 450 | 0 | mono meta/status; the dominant size in the devtools panel |
| label | 12px | 16px | 500 | 0 | tabs, titles, buttons |
| body | 13px | 20px | 400 | 0 | notes, menu items |
| term | 12.5px | 19px | 400 | 0 | terminal output (mono) |
| h | 15px | 22px | 600 | -0.01em | dialog/empty-state headings |

Helper classes `.t-micro/.t-meta/.t-label/.t-body/.t-term/.t-h` apply a full role in one class. `.t-micro` and `.t-meta`/`.t-term` set `text-transform`/`font-family` for you.

### Radius
| Token | Value | Use |
|---|---|---|
| `--r-board` | 8px | Board outer |
| `--r-inner` | 6px | Popovers, inner panels |
| `--r-ctl` | 5px | Controls: filter box, flags, dock-switch, load button, pills track |
| `--r-pill` | 999px | Pills, status dots, WS badges |

Ad-hoc smaller radii seen in the devtools file: `3px` (badges, small toggles), `4px` (tools, preview img, dl-show), `2px` (waterfall/timing bars).

### Spacing (base 4px)
`--space-2 .. --space-32` = 2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32px, named by px value. The devtools panel leans on **6 / 8 / 10 / 12 / 13px** paddings.

### Shadows (the ONLY two in the system)
| Token | Value | Use |
|---|---|---|
| `--shadow-board` | `0 1px 2px rgba(0,0,0,.45), 0 10px 28px -12px rgba(0,0,0,.6)` | Board elevation |
| `--shadow-pop` | `0 8px 24px -6px rgba(0,0,0,.7)` | Popovers |

No other shadows allowed (no glow, no glassmorphism, no gradients). Density: `--titlebar-h: 34px`, compact-only.

---

## 2. Existing `.bb-net-*` Vocabulary a New Viewer Must Match

The DevTools Network inspector is the closest existing precedent: a DOM panel that **splits** `.bb-stage` (it is a flex sibling that resizes the browser region, NOT an overlay), clips/rounds with the board, and supports two docks. A JSON viewer should reuse this exact shell and idiom.

### Panel shell
- **`.bb-net`** — the panel root: `position:relative; display:flex; flex-direction:column; min-width/height:0; background:var(--surface); color:var(--text); font-family:var(--ui); overflow:hidden`. This is your container contract.
- **`.bb-net-bottom`** — bottom-drawer dock: `width:100%; height:50%; border-top:1px solid var(--border)`.
- **`.bb-net-right`** — right dock: `height:100%; width:44%; max-width:560px; min-width:240px; border-left:1px solid var(--border)`. Right dock also hides wide columns (`.net-col-type/-initiator/-wf { display:none }`) and switches pills to horizontal-scroll — i.e. the **narrow layout is a real responsive state, not a shrink**.

### Resize handle affordance language (reuse verbatim)
- **`.bb-net-resize`** — `position:absolute; z-index:6; touch-action:none`. A thin invisible hit-strip straddling the split border.
- **`::before`** — the visible line: `background:var(--accent); opacity:0; transition:opacity .12s ease`. Fades to `opacity:.7` on `:hover`/`:active` only.
- Geometry: bottom dock `top:-3px; height:7px; cursor:ns-resize` with a `2px`-tall accent line; right dock `left:-3px; width:7px; cursor:ew-resize` with a `2px`-wide accent line.
- This is explicitly "the same affordance language as the planning width handle." **A JSON viewer's split/resize must use this identical pattern** (7px hit-strip, 2px accent line, 0→0.7 fade).

### Scroll body / padding contract
- **`.bb-net-list`** (the main scroll region): `flex:1; min-height:0; overflow:auto; scrollbar-width:thin; scrollbar-color:var(--border-strong) transparent`.
- **`.bb-net-dbody`** (the detail scroll body — the closest analog to a JSON pane): `flex:1; min-height:0; overflow:auto; **padding:10px 13px**; scrollbar-width:thin; scrollbar-color:var(--border-strong) transparent`. **Use `10px 13px` padding and this exact thin-scrollbar treatment for a JSON scroll body.**
- **`.bb-net-bodytext`** (raw response body — the most direct precedent for monospace text dumps): `margin:0; width:100%; white-space:pre-wrap; word-break:break-all; font-family:var(--mono); **font-size:11px**; color:var(--text-2); max-height:100%`. A JSON viewer's pre/code block should inherit this: mono, 11px, `--text-2`, `pre-wrap` + `break-all`.

### Headers / sub-tabs
- **`.bb-net-head` / `.bb-net-tools`** — top bars: `height:32px; display:flex; align-items:center; gap:2px (tools 6px); border-bottom:1px solid var(--border-subtle)`.
- **`.bb-net-tab`** — top-level tab: `height:32px; padding:0 9px; font-size:var(--fs-label); font-weight:500; font-family:var(--ui); color:var(--text-3); border-bottom:2px solid transparent; margin-bottom:-1px`. Hover → `--text-2`. Active (`.bb-net-tab-on`) → `color:var(--text); border-bottom-color:var(--accent)`.
- **`.bb-net-subtabs` / `.bb-net-subtab`** — the detail sub-tab row (Headers / Preview / Timing pattern): bar is `height:28px; background:var(--surface-raised); border-bottom:1px solid var(--border-subtle); padding:0 10px; gap:2px`. Each subtab `height:28px; padding:0 8px; color:var(--text-3); font-size:var(--fs-meta); border-bottom:2px solid transparent`. Active (`.bb-net-subtab-on`) → `color:var(--text); border-bottom-color:var(--accent)`. **This is the canonical pattern for "Raw / Parsed / Tree" view switching in a JSON viewer.**
- **Per-section source toggle** (`.bb-net-srctoggle`): a borderless `--accent` text button, `font-size:10px`, underline-on-hover — the established idiom for a "view source / parsed" link. Reuse it for "Raw ⇄ Tree" or "expand all."

### Key/value & header DL/DT/DD (the structured-data precedent)
- **`.bb-net-kv`** — flex column, `gap:8px; font-size:var(--fs-meta); color:var(--text-2); line-height:16px`.
- **`.bb-net-k`** — the key label: `color:var(--text-3); margin-right:6px`.
- **`.bb-net-v`** — the value: `font-family:var(--mono); color:var(--text); word-break:break-all`. **This is the load-bearing precedent: in existing structured data, the KEY is dim (`--text-3`) and the VALUE is bright mono (`--text`).** A JSON viewer should follow the same hierarchy.
- **`.bb-net-headers dl`** — two-column grid: `grid-template-columns: minmax(90px,30%) 1fr; gap:2px 10px`, children `<div>` set to `display:contents` so dt/dd land on the grid directly.
- **`.bb-net-headers dt`** — `color:var(--text-3); font-family:var(--mono); font-size:10.5px; word-break:break-all`.
- **`.bb-net-headers dd`** — `margin:0; color:var(--text-2); font-family:var(--mono); font-size:10.5px; word-break:break-all`.
- **`.bb-net-statusdot`** — the 7px status dot idiom: `var(--ok)` default, `.bad → var(--err)`. This is how status is conveyed: an 8px-class dot, never text color alone (except the parity exceptions below).

### Status/parity conventions worth copying
- Selection: `.bb-net-sel` → `background:var(--accent-wash); color:var(--text)`, plus a `box-shadow: inset 2px 0 0 var(--accent)` accent rail on the name cell.
- Failure parity: whole row goes `--err` (`.bb-net-fail`). Invalid input borders `--err` (`.bb-net-filter-err`).
- "No yellow token for a non-status concept" precedent: WS control frames are rendered **dim + italic** (`--text-3`, `font-style:italic`) because the design has no decorative yellow — a direct template for how to encode a non-status JSON category without inventing a color.
- Empty state: `.bb-net-empty` → centered, italic, `--text-3`, `font-size:var(--fs-meta)`.

---

## 3. THE KEY DESIGN TENSION — JSON Syntax Coloring vs. One-Accent / Status-Only

**Constraint:** the system is strictly ONE functional accent (`--accent` blue) plus status-only color (`--ok`/`--warn`/`--err`), explicitly "no glassmorphism/gradients/glow," "calm/dense Linear-Raycast feel." Status colors carry *meaning* (success/warn/error) and must NOT be repurposed decoratively — yet the file already shows the escape hatch (WS control frames use dim+italic *because there is no decorative yellow*, and note tints prove low-chroma derived hues are sanctioned for non-status, non-accent roles).

**Conventional JSON highlighting** wants 4–6 hues (string / number / boolean / null / key / punctuation). That directly violates the one-accent rule. Three restrained, on-brand resolutions:

### Option A — Monochrome + accent-on-keys (only keys carry weight)
Everything is grayscale on the existing text ramp; the accent does one job: structure.
- **Keys** → `--accent` (`#4f8cff`), mono. This mirrors the existing `.bb-net-origin`/`.net-name` precedent where accent marks the "name."
- **Values (all types)** → `--text` bright mono.
- **Punctuation `{}[],:`** → `--text-3`.
- **Structural guides** (indent rails, collapse carets, line numbers) → `--text-faint`/`--border-subtle`.
- **null/undefined** → `--text-3` italic (the dim+italic "control" idiom already in the codebase).

**Pros:** zero new palette; perfectly on-brand; reads like the existing `.bb-net-kv` (dim key → bright value, just inverted to accent-key); fastest to ship; calm/dense. **Cons:** no type discrimination among values — strings vs numbers vs booleans look identical (some users scan by value color); inverts the existing kv hierarchy (there keys are *dim*, here keys are *accent*) so it must be applied consistently or it'll feel inconsistent with the headers DL.

### Option B — Low-chroma derived palette, muted status variants for value-TYPE tint only
Keep keys/structure monochrome+accent (as A), but tint *value types* with desaturated, low-chroma hues derived from the existing tokens — used strictly as a quiet semantic legend, never at full status saturation:
- **string** → `--ok`-derived muted green, e.g. `color-mix(in srgb, var(--ok) 55%, var(--text-2))`.
- **number** → `--accent`-derived muted blue, `color-mix(in srgb, var(--accent) 55%, var(--text-2))`.
- **boolean** → `--warn`-derived muted amber, `color-mix(in srgb, var(--warn) 55%, var(--text-2))`.
- **null** → `--text-3` italic.
- Keys → `--text` or `--accent`; punctuation → `--text-3`.

The `color-mix` toward `--text-2` keeps chroma low enough to read as the note-tint family, not as status. This is the *same technique* the note tints (`--note-*`) and the accent-mix borders already use.

**Pros:** familiar JSON readability (type-at-a-glance); palette is provably derived from existing tokens, so it stays "in-family"; precedented by note tints + `color-mix` accent borders. **Cons:** reuses status HUES decoratively — risks semantic collision (a muted-green string near a real `--ok` status dot, or muted-amber boolean near a `--warn` paused badge, could read as status). Highest review risk against the "status-only color" rule; needs the muted variants to be visibly distinct from the real status tokens, and ideally not co-located with status UI.

### Option C — Accent-for-structure + grayscale-for-values, weight/style as the type cue
A middle path: NO value-type hues at all; encode type with **weight and style** on the grayscale ramp instead of color.
- **Keys** → `--text-2`, mono (matches the existing dd convention).
- **Punctuation / structure** → `--text-3`.
- **string** → `--text` normal.
- **number** → `--text` mono (numbers already read distinct via `tabular-nums`, used elsewhere as `font-variant-numeric`).
- **boolean / null** → `--text-3` *italic* (the established control-frame idiom).
- **Accent** reserved for interaction only: selected node rail (`inset 2px 0 0 var(--accent)`), active fold, search-match highlight (`--accent-wash`), matching the `.bb-net-sel` precedent.

**Pros:** strictest adherence — accent stays purely functional/interactive (exactly as the rest of the app uses it), zero status-hue reuse, no new tokens; weight/italic type cues are already a sanctioned idiom here. **Cons:** weakest type discrimination (string vs number distinguishable only by content, not color); leans hard on typography that some users won't parse as semantic.

### Recommendation

**Ship Option A (monochrome + accent-on-keys) as the default**, with **Option B available as an opt-in "syntax tint" toggle** if user testing shows the monochrome tree is hard to scan.

Rationale:
- A is the only option with **zero tension** against the locked rules — it spends the single accent on *structure* (keys), which is the highest-value discriminator in JSON, and leaves all status semantics untouched. It also matches the closest in-app precedent (`.bb-net-kv` accent-marks-the-name, dim-key/bright-value) and the calm/dense aesthetic.
- C is the safest but loses too much scannability for a *data-flow visualizer* whose whole point is reading values quickly; the typography-only cue is too subtle for the dense use case.
- B delivers the best raw readability but is the only option that **repurposes status hues decoratively**, which is precisely the rule the contract guards — so it should not be the default. If adopted, gate it behind a toggle, keep the mixes pulled ≥45% toward `--text-2`, and keep tinted values out of any region that also shows real status dots/badges to avoid the semantic collision.

Net: default to A's accent-on-keys monochrome; reserve B's derived low-chroma tints as a togglable enhancement, never co-located with status UI; never use full-saturation `--ok/--warn/--err` for value types.