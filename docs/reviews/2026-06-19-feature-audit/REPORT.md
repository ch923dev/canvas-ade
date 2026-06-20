# Canvas ADE — Feature Improvement Audit (2026-06-19)

> Forward-looking **improvement** audit of the shipped, on-`main` feature set — performance,
> UI/UX, styling, accessibility, and code quality. This is **not** a bug hunt (the codebase has
> a heavily-remediated bug-hunt/design-audit trail through 2026-06-15 with no open findings); it
> targets the *next* tier of polish and leverage.
>
> **Method:** adversarial multi-agent audit — 11 parallel domain auditors (8 feature lanes + 3
> cross-cutting lenses) → an independent skeptic per lane re-read the cited code in the current tree
> to confirm/downgrade/reject each finding. **52 raw findings → 47 survived verification** (5 rejected),
> deduped to **43 unique** confirmed items + 7 unverified terminal notes.
> 22 agents · ~2.6M tokens · 885 tool calls.

---

## 1. Executive summary

The product is **mature and well-engineered**. The OSR preview path hits its zero-per-frame-IPC
design goal, the React Flow node list is per-id cached, store mutations are immutable-ref-checked,
autosave is debounced + key-gated, board chunks are code-split, and the design contract is closely
followed. No new correctness, security, or data-loss findings emerged — consistent with the prior
remediation history.

The remaining improvement surface is **concentrated in four themes**, almost all of which are
small, high-leverage fixes rather than rewrites:

| # | Theme | What it is | Headliner |
|---|---|---|---|
| **A** | Per-frame re-render class | A few components subscribe reactively to the live camera transform and re-run full work bodies on *every* pan/zoom frame | `CANVAS-01`, `PLAN-01` (both **High**, ~1-line fixes) |
| **B** | A11y on custom / canvas controls | Icon-button toolbars, the dock, and canvas affordances skip the `aria-label` / `aria-pressed` / focus-ring / progressbar patterns that the rest of the app already uses | `PLAN-02` (**High**) + a cluster of Mediums |
| **C** | Silent operations / missing positive feedback | Save state, MCP refresh, rejected connectors, run timer give the user no confirmation that work happened | `PERSIST-03`, `TERM-01`, `GROUP-04` |
| **D** | Token/contract drift & maintainability | Hand-coded literals bypassing tokens, two ~770-line host files, a couple of stale doc/contract lines | `STYLE-02`, `CHROME-05`, `TERM-07` |

### Top priorities ("do these first")

1. **Kill the per-camera-frame re-render class (Theme A).** `CANVAS-01` and `PLAN-01` are each
   effectively one-line fixes (drop a dead `useMemo` dep; read zoom from a ref instead of a reactive
   subscription) that remove whole-component re-renders on every pan/zoom frame. Biggest felt
   smoothness win for the least code. Pull `PERF-04`, `CHROME-01`, `GROUP-07`, `PERF-05` in alongside.
2. **One accessibility pass over custom controls (Theme B).** Fixing `IconBtn` once (`PLAN-02`) gives
   the planning toolbar, snap, and export controls an accessible name + pressed state in a single
   change; add `aria-pressed` to the dock/camera buttons, a focus ring to chrome controls, and the
   URL-input / checklist-progressbar semantics. Mostly `S`-effort, large coverage.
3. **Add positive feedback where operations are currently silent (Theme C).** A quiet save-state
   indicator, a wired run timer, and a "couldn't connect / already connected" toast convert
   invisible system behavior into trust.

---

## 2. Scope & method

**In scope (shipped on `main`):** canvas core / camera / chrome, terminal board, browser/preview
(OSR), planning/whiteboard, board groups & connectors, persistence/schema/undo, MCP/Context/LLM
backend + digest UI, app chrome / shell / Ctrl+K palette — graded against `design-reference/project/DESIGN.md`
and the perf / UX / styling / a11y / code-quality / architecture axes.

**Explicitly excluded** (in-flight work being iterated separately): **File Tree** (not built) and
**Command Board** (#182 — `boards/command/**`, `commandStore`, `workerPool`, `routingEdges`,
`RoutingEdge`, the orchestrator dock board). The Ctrl+K **command palette** (`palette/**`, shipped in
#121) is a separate shipped feature and was audited.

**Severity (improvement-audit calibration):** `High` = users clearly feel it / real perf or
data-safety-adjacent cost · `Medium` = noticeable rough edge or maintainability risk · `Low` =
refinement / nice-to-have. **Effort:** `S` < half day · `M` ~1-2 days · `L` multi-day/epic.

**Verification:** every finding was re-checked by an independent skeptic agent that opened the cited
files in the current tree. Severities below are **post-verification** (some were downgraded). The two
High perf findings were additionally hand-verified for this report (line refs current as of audit).

**Dedup note:** the cross-cutting PERF lane independently re-found three feature-lane items
(`PERF-01`=`CANVAS-01`, `PERF-03`=`PLAN-01`, `PERF-02`=`PREV-02`) — corroboration, merged below.
`PERF-07` folds into `PERSIST-01`.

---

## 3. Cross-cutting themes

### Theme A — Per-frame re-render class (performance)

A small number of components subscribe to the **live camera transform** and re-run substantial work
on every pan/zoom frame, often for a value they barely use:

- **`CANVAS-01` (High)** — `Canvas.tsx:161` reactively reads `viewport`, fed into the digest memo
  (`:257-259`, dep `[boards, viewport, connectors]`). But `buildDigest` never reads the camera
  viewport (`digest.ts` only references `b.viewport`, a board's *device* preset). Every pan frame
  re-renders all of `CanvasInner` and re-allocates a fresh `CanvasDigest` — even with the panel closed.
- **`PLAN-01` (High)** — `PlanningBoard.tsx:79` subscribes to `s.transform[2]` (zoom) only as a
  fallback for `screenScale`; every planning board re-runs its filter/map body each zoom frame.
- **`PERF-04` (Medium)** — every board's title-bar `BoardMenu` subscribes to the whole `groups` array,
  so any group create/rename/membership change re-renders *every* board's title bar.
- **`GROUP-07` (Low)** — `GroupBoxLayer` recomputes *all* group boxes (O(groups²) nesting scan) on
  every board-drag frame.
- **`PERF-05` (Low)** — `BoardNode` maintains terminal+preview runtime subscriptions + computes
  `lodPill` for every board even at full detail (only used inside the LOD card).

**Fix pattern:** read the camera/zoom lazily (ref updated via subscribe, or `getState()`/`rf.getZoom()`
at gesture time) instead of binding it into render; narrow store selectors; gate work on visibility.

### Theme B — Accessibility of custom & canvas controls

The app's primitives (`Modal`, `TextToolbar`, `NewTerminalDialog`) already use `aria-label` +
`aria-pressed` + focus rings correctly — but several control surfaces never adopted the pattern:

- **`PLAN-02` (High)** — planning tool cluster `IconBtn`s expose no accessible name (title-only) and
  no `aria-pressed`; the active tool is signalled by glyph color alone. Fixing `IconBtn` once also
  fixes snap/export and other title-bar controls.
- **`CHROME-02` (Medium)** — dock + camera buttons signal armed/active by color only, no `aria-pressed`.
- **`A11Y-01` (Medium)** — `ca-t-ctl` (dock/camera), `project-switcher-trigger`, and the zoom `%`
  button fall back to Chromium's dim default outline; the rest of the app uses a 1.5px accent ring.
- **`PREV-04` (Medium)** — the preview URL `<input>` has no `aria-label` and no `aria-invalid`.
- **`PLAN-04` (Medium)** — the checklist progress bar has no `role="progressbar"` / `aria-value*`.
- **`PLAN-03` (Medium)** — `text` and `diagram` tools have no keyboard shortcut (mouse-only).
- **`GROUP-01` / `GROUP-02` (Medium)** — connectors and the group name-tab have no keyboard path.
- **`STYLE-01` (Medium)** — filled `--accent` + `--text` modal primary buttons sit at ~2.8:1 (below
  WCAG AA), and contradict the app's documented "never a filled slop button" grammar.

### Theme C — Silent operations / missing positive feedback

The UI tends to surface only failures; success and in-progress states are invisible:

- **`PERSIST-03` (Medium)** — `saveStatusStore` models only a nullable failure string; there is no
  saving/saved state, so the user gets zero confirmation work is persisted until a disk error.
- **`TERM-01` (Medium)** — the run timer is fully implemented + unit-tested but never wired into the
  `TerminalBoard` status pill (`statusFor` called without the timer arg).
- **`GROUP-04` (Low)** — a rejected connector (self-link / duplicate / empty drop) just vanishes; the
  duplicate case gives no "already connected" signal.
- **`GROUP-03` (Medium)** — a connector drag never highlights the board it will land on (the group-box
  drag does light its drop target — asymmetric).
- **`MCP-04` (Low)** — the digest refresh button is silent on no-key / budget-exceeded / error.

### Theme D — Token/contract drift & maintainability

- **`STYLE-02` (Medium)** — no lint guards raw `fontSize`/`borderRadius`/hex literals in inline
  styles, so token changes can't propagate and drift is invisible (literals already present in
  `SettingsModal`, `BoardFrame`, `RecapConsentModal`).
- **`CHROME-05` / `TERM-07` (Low)** — `AppChrome.tsx` (~779 lines) and `TerminalBoard.tsx` (~770
  lines) are large multi-concern hosts with no size gate.
- **`CANVAS-06` (Low)** — `--grid-dot` hue hard-coded in `FadingDots`; **`CANVAS-02` (Low)** — dead
  `fullViewMotion` flag + stale comment referencing the deleted native preview engine.
- **`PLAN-06` (Low)** — empty-state hint and DESIGN.md §7.3 omit the shipped `text`/`diagram` tools.

---

## 4. Findings by domain

> Severity is post-verification. "Files" gives the primary reference; see the raw audit output for
> full evidence. ⚑ = also surfaced independently by the cross-cutting PERF lane.

### 4.1 Canvas core / camera / chrome

| ID | Sev | Cat | Eff | Finding | Primary file |
|---|---|---|---|---|---|
| CANVAS-01 ⚑ | **High** | perf | S | Camera `viewport` is a dead dep in the digest memo → full re-render + digest realloc every pan frame | `Canvas.tsx:161,257-259` |
| CANVAS-02 | Low | code | S | Dead `fullViewMotion` flag + comment referencing the deleted WebContentsView engine | `useFullView.ts:37,63-68,137` |
| CANVAS-04 | Low | arch | S | Focus-zoom raster cap duplicated across two hooks (no shared helper) | `useBoardKeyboardNav.ts:206`, `useFullView.ts:26` |
| CANVAS-05 | Low | styling | S | Resize handles diverge from §6 (10px corners; invisible edge midpoints) | `index.css:818-840` |
| CANVAS-06 | Low | code | S | `--grid-dot` hue hard-coded in `FadingDots` (token drift risk) | `Canvas.tsx:108-124` |

> **CANVAS-03 rejected** — premise stale: the dock moved to top-center (#75), so boards added at
> pane-center don't collide with it.

### 4.2 Terminal board

| ID | Sev | Cat | Eff | Finding | Primary file |
|---|---|---|---|---|---|
| TERM-01 | **Medium** | ux | S | Run timer implemented + tested but **not wired** into the status pill | `TerminalBoard.tsx:286` |
| TERM-02 † | Medium | ux | S | Status/identity label only visible on hover/select | `BoardFrame.tsx:713` |
| TERM-03 † | Medium | styling | S | `CommandBuilder` flag hint uses `--text-faint` (disabled-only per D0-2) | `CommandBuilder.tsx:343` |
| TERM-04 † | Medium | ux | M | Exited / spawn-failed states lack an in-well re-run CTA | `useTerminalSpawn.ts:479` |
| TERM-05 † | Low | perf | S | Recap re-fetches the whole bundle on every flip | `RecapView.tsx:158` |
| TERM-06 † | Low | ux | S | Interrupt (Ctrl-C) gives no visual confirmation | `TerminalBoard.tsx:293` |
| TERM-07 † | Low | code | M | `TerminalBoard.tsx` is a ~770-line god-host | `TerminalBoard.tsx` |
| TERM-08 † | Low | perf | S | All terminals subscribe to the global settled-zoom store (per-settle fan-out) | `useTerminalSpawn.ts:224` |

> † `TERM-02..08` were reported by the terminal auditor but truncated out of the structured output by
> an agent token cap, so **only `TERM-01` was independently verified**. Treat `TERM-02..08` as
> credible-but-unverified — confirm against source before scheduling.

### 4.3 Browser / Preview (OSR)

| ID | Sev | Cat | Eff | Finding | Primary file |
|---|---|---|---|---|---|
| PREV-01 | **Medium** | perf | M | Full-view preview blurs — supersample sized from on-canvas geometry, not the full-view frame (bounded by the 2× cap) | `BrowserBoard.tsx:156`, `osrSizing.ts:79` |
| PREV-02 ⚑ | **Medium** | perf | M | Inbound frames blit synchronously; each board adds its own broadcast listener (O(N) fan-out, no rAF coalesce) | `useOffscreenPreview.ts:105`, `preload/index.ts:326` |
| PREV-04 | **Medium** | a11y | S | URL input has no accessible name / `aria-invalid` | `BrowserBoard.tsx:418` |
| PREV-03 | Low | perf | M | Liveness ignores screen-space z-occlusion — a fully-covered board keeps streaming (MAIN-side CPU only) | `useOffscreenLiveness.ts:67` |

### 4.4 Planning / Whiteboard

| ID | Sev | Cat | Eff | Finding | Primary file |
|---|---|---|---|---|---|
| PLAN-01 ⚑ | **High** | perf | S | `PlanningBoard` re-renders every camera frame for a zoom value used only as a fallback | `PlanningBoard.tsx:79,160` |
| PLAN-02 | **High** | a11y | S | Tool-cluster `IconBtn`s have no accessible name / `aria-pressed` (fix once → covers snap/export too) | `PlanningToolbar.tsx:59`, `BoardFrame.tsx:316` |
| PLAN-03 | Medium | a11y | S | `text` + `diagram` tools have no keyboard shortcut | `tools.ts:14` |
| PLAN-04 | Medium | a11y | S | Checklist progress bar not announced (`role="progressbar"` missing) | `ChecklistCard.tsx:217` |
| PLAN-05 | Medium | ux | M | Sticky notes + checklists are fixed-width with no resize affordance (only Diagram resizes) | `NoteCard.tsx:117`, `ChecklistCard.tsx:135` |
| PLAN-06 | Low | ux | S | Empty-state hint + DESIGN.md §7.3 omit `text`/`diagram` | `PlanningBoard.tsx:730` |
| PLAN-07 | Low | perf | S | `WhiteboardSvg` unmemoized (re-reconciles on parent render; mostly subsumed by PLAN-01) | `WhiteboardSvg.tsx:72` |
| PLAN-08 | Low | ux | M | Arrows can't carry a label (additive schema field) | `elements.ts:111` |

### 4.5 Board groups & connectors

| ID | Sev | Cat | Eff | Finding | Primary file |
|---|---|---|---|---|---|
| GROUP-01 | Medium | a11y | M | Connectors have no keyboard path (create/select/delete are mouse-only; no palette verb) | `BoardFrame.tsx:737`, `Canvas.tsx:813` |
| GROUP-02 | Medium | a11y | M | Group name-tab is mouse-only; double-click flashes select-then-focus | `GroupBoxLayer.tsx:70-83` |
| GROUP-03 | Medium | ux | M | Connector drag shows no drop-target highlight (asymmetric with group-box drag) | `useBoardPlacement.ts:226` |
| GROUP-04 | Low | ux | S | Rejected connector (self/duplicate/empty) fails silently | `connectorSlice.ts:24` |
| GROUP-05 | Low | ux | M | Adding a board to a group always re-tiles every member (discards manual layout) | `useGroupInteractions.ts:129` |
| GROUP-06 | Low | ux | S | "Remove from group" is all-or-nothing (no per-group target when in several) | `BoardFrame.tsx:451` |
| GROUP-07 | Low | perf | M | `GroupBoxLayer` recomputes all boxes (O(groups²)) per board-drag frame | `GroupBoxLayer.tsx:33` |

### 4.6 Persistence / schema / undo

| ID | Sev | Cat | Eff | Finding | Primary file |
|---|---|---|---|---|---|
| PERSIST-01 ⚑ | **Medium** | perf | S | Autosave deep-clones the canvas in `toObject`, again across IPC, then stringifies in MAIN — 3 deep passes per ~1s tick (+ `previewConnectorsFor` recompute) | `boardSchema.ts:467`, `useAutosave.ts:123` |
| PERSIST-03 | **Medium** | ux | M | No positive save-state feedback — UI surfaces only failure, never saving/saved | `saveStatusStore.ts`, `AppChrome.tsx:105` |
| PERSIST-02 | Low | code | S | `createAutosaver` has no in-flight guard (narrow overlapping-save window) | `useAutosave.ts:52-97` |

> **PERSIST-04 rejected** — `canUndo`/`canRedo` are already derived and the Ctrl+K palette already
> exposes Undo/Redo (disabled when rails empty). Only a missing AppChrome toolbar icon remains (Low/opt).

### 4.7 MCP / Context / LLM backend + digest UI

| ID | Sev | Cat | Eff | Finding | Primary file |
|---|---|---|---|---|---|
| MCP-03 | Low | perf | M | Audit JSONL unbounded; whole-file read per open (fields are size-capped) | `auditLog.ts:62` |
| MCP-04 | Low | ux | M | Digest refresh silent on no-key / budget / error | `Canvas.tsx:293` |
| MCP-05 | Low | ux | S | `maxCallsPerDay` enforced but no UI field / usage peek | `SettingsModal.tsx:196` |
| MCP-06 | Low | styling | S | Digest status colors only style 2 of ~6 status values (rest fall to `--text-2`) | `index.css:2543` |
| MCP-07 | Low | code | M | `SAFE_ID` regex copy-pasted across `canvasMemory`/`boardMemory` (a sync test guards it) | `summaryLoop.ts:119` |
| MCP-08 | Low | ux | S | Digest prose untruncated (no line-clamp/expand) | `DigestPanel.tsx:138` |

> **MCP-01 rejected** ("use Modal" is wrong — `AuditLogViewer` is a persistent side panel, not an
> overlay; only its `role="dialog"` attribute is arguably imprecise). **MCP-02 rejected** —
> `buildDigest` is already memoized; the "per drag frame" claim was false.

### 4.8 App chrome / shell / palette

| ID | Sev | Cat | Eff | Finding | Primary file |
|---|---|---|---|---|---|
| CHROME-02 | **Medium** | a11y | S | Dock + camera buttons signal active by color only, no `aria-pressed` | `AppChrome.tsx:601-706` |
| A11Y-01 | **Medium** | a11y | S | `ca-t-ctl` / project-switcher / zoom-`%` buttons lack the app's styled focus ring | `AppChrome.tsx:601`, `index.css:1475` |
| CHROME-01 | Low | perf | S | Dock auto-hide calls `getBoundingClientRect` on every global `pointermove` (passive; minor) | `AppChrome.tsx:498-505` |
| CHROME-05 | Low | code | M | `AppChrome.tsx` (~779 lines) bundles the project-switch pipeline with camera/dock UI | `AppChrome.tsx:93-312` |

> **CHROME-04 rejected** — the dock is pinned open in the common states (empty project / tool armed /
> keyboard focus); auto-hide is a deliberate, documented tradeoff, not a discoverability bug.

### 4.9 Cross-cutting (styling / perf / a11y)

| ID | Sev | Cat | Eff | Finding | Primary file |
|---|---|---|---|---|---|
| STYLE-01 | **Medium** | styling | S | Filled `--accent`+`--text` modal primaries ~2.8:1 (below AA); contradicts the no-filled-button grammar | `ConfirmModal.tsx:103`, `RecapConsentModal.tsx:161`, `SettingsModal.tsx:371` |
| STYLE-02 | **Medium** | code | M | No lint guards raw `fontSize`/`borderRadius`/hex literals in inline styles | `eslint.config.mjs`, `SettingsModal.tsx`, `BoardFrame.tsx` |
| PERF-04 | **Medium** | perf | S | Every board title bar re-renders on any group mutation (whole-array `groups` subscription in `BoardMenu`) | `BoardFrame.tsx:389` |
| PERF-05 | Low | perf | S | `BoardNode` keeps runtime-store subs + computes `lodPill` for all boards (only used in LOD card) | `BoardNode.tsx:130-134` |
| PERF-06 | Low | perf | M | PTY ring buffer does an O(256KB) string copy per output chunk once full (heavy-output agents) | `pty.ts:94-97,400` |

---

## 5. Prioritized improvement roadmap

Sequenced so the highest felt-impact, lowest-risk work lands first. Effort is cumulative-rough.

### Wave 1 — Performance quick wins  ·  ~1-2 days  ·  highest leverage
The "smoothness" wave — mostly one-line / one-selector changes that remove per-frame work.
- `CANVAS-01` — drop `viewport` from the digest memo deps (and the reactive read). **(S, High)**
- `PLAN-01` / `PERF-03` — read zoom from a ref instead of subscribing in `PlanningBoard`. **(S, High)**
- `PERF-04` — move the `groups` read into the `BoardMenu` popover body / narrow the selector. **(S)**
- `CHROME-01` — cache the dock wrapper rect; recompute on resize. **(S)**
- `PERF-05` — lift `lodPill` + its subscriptions into the LOD-card branch. **(S)**
- `GROUP-07` — recompute only the dragged board's groups during a drag. **(M)**
- `PLAN-07` — `React.memo` `WhiteboardSvg` (mostly subsumed by `PLAN-01`). **(S)**

### Wave 2 — Accessibility cluster  ·  ~2-3 days
A single sweep over custom controls; `PLAN-02` (fixing `IconBtn`) does the heavy lifting.
- `PLAN-02` — give `IconBtn` `aria-label` (default from `title`) + `aria-pressed`; `aria-hidden` the
  inner glyph; pass human labels. **(S, High)** — also fixes snap/export + many title-bar controls.
- `CHROME-02` — `aria-pressed` on dock/camera toggle buttons. **(S)**
- `A11Y-01` — add `ca-t-ctl:focus-visible` accent ring; include switcher + `%`. **(S)**
- `PREV-04` — `aria-label="Preview URL"` + `aria-invalid`. **(S)**
- `PLAN-04` — `role="progressbar"` + `aria-value*` on the checklist bar. **(S)**
- `PLAN-03` — keyboard shortcuts for `text`/`diagram` (e.g. `x`/`d`, collision-checked). **(S)**
- `STYLE-01` — switch modal primaries to accent-on-wash (or a near-void foreground). **(S)**

### Wave 3 — Feedback & trust UX  ·  ~2-3 days
Make invisible system behavior visible.
- `PERSIST-03` — promote `saveStatusStore` to idle/saving/saved/error; render a quiet `--text-3`
  status by the board count. **(M)**
- `TERM-01` — wire the existing run timer into the status pill. **(S)**
- `GROUP-04` — toast on rejected connector (self / already connected). **(S)**
- `GROUP-03` — highlight the resolved connector drop target mid-drag. **(M)**
- `MCP-04` — surface the reason a digest refresh produced nothing. **(M)**
- (verify-first) `TERM-04` re-run CTA on exited/failed terminals; `TERM-06` interrupt confirmation.

### Wave 4 — Heavier perf + feature gaps  ·  ~1 week
- `PREV-01` — make `useOffscreenSizing` full-view-aware; re-send `osrResize` on enter/exit. **(M)**
- `PREV-02` / `PERF-02` — single shared OSR frame/cursor dispatcher keyed by board id + rAF coalesce. **(M)**
- `PERSIST-01` — drop the `toObject` clone (IPC already isolates); memoize `previewConnectorsFor`. **(S/M)**
- `PLAN-05` — reuse the DiagramCard resize-handle pattern for notes + checklists (width). **(M)**
- `GROUP-01` / `GROUP-02` — keyboard paths for connectors + the group name-tab. **(M each)**
- `GROUP-05` / `GROUP-06` — add-without-relayout + per-group remove. **(M / S)**

### Wave 5 — Maintainability & polish  ·  opportunistic
- `STYLE-02` — `no-restricted-syntax` lint for numeric `fontSize`/`borderRadius` + raw hex in styles. **(M)**
- `CHROME-05` / `TERM-07` — extract from the two ~770-line hosts (apply the file-size doctrine). **(M)**
- `CANVAS-02/04/05/06` — dead flag, focus-zoom helper, resize-handle spec fidelity, grid token. **(S each)**
- `MCP-03/05/06/07/08` — log rotation, budget UI, status colors, shared `SAFE_ID`, prose clamp. **(S/M)**
- `PLAN-06` — fix the empty-state hint + DESIGN.md §7.3 tool list. **(S)**
- `PLAN-08` — arrow labels (additive schema bump per ADR 0007). **(M, feature)**
- `PERF-06` — chunk-deque PTY ring buffer. **(M)**
- `PERSIST-02` — single-flight autosave latch. **(S)**
- `MCP-01` — correct `AuditLogViewer`'s `role` attribute (panel, not dialog). **(S)**

---

## 6. Appendix

### 6.1 Rejected findings (transparency)

| ID | Why rejected |
|---|---|
| CANVAS-03 | Dock is top-center (#75), not bottom — pane-center boards don't collide with it. |
| PERSIST-04 | `canUndo`/`canRedo` already derived; Ctrl+K palette already exposes Undo/Redo. |
| MCP-01 | "Use Modal" is wrong for a persistent side panel; only the `role` attribute is imprecise. |
| MCP-02 | `buildDigest` is already memoized; the "per drag frame" recompute claim was false. |
| CHROME-04 | Dock auto-hide is a deliberate, documented tradeoff; pinned open in common states. |

### 6.2 Unverified (terminal lane truncation)

`TERM-02..08` were reported by the auditor but truncated out of structured output by an agent token
cap, so they were **not** independently verified. They are credible (status-label hover-only,
`--text-faint` flag hint, exited-state re-run CTA, recap re-fetch, interrupt confirmation, the
god-host file, settled-zoom fan-out) — re-confirm against source before scheduling.

### 6.3 Tally

- **52** raw findings → **47** confirmed (5 rejected) → **43** unique after dedup, + **7** unverified.
- By post-verification severity: **3 High** · **17 Medium** · **23 Low** (excluding the 7 unverified).
- By category (confirmed): performance 14 · accessibility 9 · ux 11 · code-quality 6 · styling 4 · architecture 1.
- The three Highs: `CANVAS-01` (digest per-frame), `PLAN-01` (planning per-frame), `PLAN-02` (toolbar a11y).

### 6.4 What is *healthy* (don't re-audit)

OSR zero-per-frame-camera-IPC architecture · per-id RF node cache · immutable-ref store guards ·
debounced+key-gated autosave + `.bak` fallback · two-tier schema versioning · code-split board
chunks · terminal WebGL-under-scale re-raster · LOD as a derived boolean · the prior bug-hunt /
design-audit (D0-D4) remediation (contrast, scrim tokens, reduced-motion, checkbox roles, ghost
tokens) all hold.

---

*Generated by an adversarial multi-agent audit (11 domain auditors + per-lane skeptic verifiers).
Findings are code-grounded with `file:line` references; see the raw run output for full evidence per
finding.*
