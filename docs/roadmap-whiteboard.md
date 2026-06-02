# Whiteboard Roadmap — Excalidraw feature integration

A **separate feature track** for the Planning whiteboard, sequencing the feasible findings from
[`research/excalidraw-feature-borrowing.md`](research/excalidraw-feature-borrowing.md) into shippable
slices. Independent of the main build order ([`roadmap.md`](roadmap.md)) — this is parallel feature
work and **does NOT block Phase 5 (packaging) or the MCP layer**.

**Source of truth:** the research doc is the *why/how/risk* reference; this is the *order + status*.
Borrow IDEAS, not the library — Excalidraw-the-dependency is rejected (`decisions/0001-stack.md`);
our whiteboard stays custom (vendored perfect-freehand + React Flow edges).

Legend: ✅ done · 🚧 in progress · ⛓ depends on · 📏 measured/tested · S/M/L/XL effort.

---

## Non-negotiable constraints (every slice)

Carried from the research + locked decisions. A slice that violates one is wrong, not clever.

- **Calm Linear/Raycast aesthetic** — one accent, no Tweaks panel, no decorative scribble.
- **One undo checkpoint per gesture** + the `lastRecorded` phantom-undo discipline (sync the
  module-level `lastRecorded` or a no-op gesture pushes a phantom step). See memory
  `undo-lastrecorded-phantom`; this is the exact class of Round-3 finding **WB-1** (fixed
  2026-06-02 on `fix/round3-backlog` — arrow/pen now defer the checkpoint to commit, like move).
- **SVG-under-DOM two-layer split** is fixed (arrows/strokes render *under* the DOM cards so cards
  stay clickable) — this caps cross-kind z-ordering; do not assume it can change without a rewrite.
- **Sandbox/isolation locked** — pasted/loaded content stays in renderer DOM, NEVER near the PTY.
- **Scene/session split** — geometry persists in `canvas.json`; selection/tool/draft stay ephemeral
  in Zustand, never serialized.

---

## Sequencing rationale

1. **Eraser is the on-ramp.** It builds the pure cross-kind hit-test helpers
   (point-to-bezier arrow · point-in-outline stroke · bbox card) in a new unit-tested
   `planning/erase.ts`. Those exact helpers are then reused by W2 multi-select's marquee and W2
   snapping's anchor extraction. Self-contained S win, zero persisted schema, no React Flow collision.
2. **Multi-select is the structural unlock.** Grouping, align/distribute, and group-duplicate are all
   blocked today purely because selection is a single `selectedElId: string | null`. Build the
   selection set once → the W3 follow-ons fall out.
3. **Snapping pairs with multi-select** — shares the per-kind anchors/bbox helper.
4. **Image + assets deferred to W4** (decided 2026-06-02) — interaction wins ride the existing pointer
   loop with zero/low schema; the assets pipeline is the one heavy-infra item (MAIN-side blob GC +
   schema migration), so it lands after the cheap wins.
5. **Shapes epic stays deferred** — the single missing primitive that gates sloppiness, bound-arrow
   reflow, Mermaid/AI-diagram, and faithful flowcharts. XL. Out of this track entirely.

---

## Phase W1 — Quick wins (S) ⛓ none

Zero/low schema, all ride the existing board-local pointer loop.

### W1.1 — Eraser tool 🚦 **recommended first slice**
Swipe-to-delete whole elements (atomic), with a hover trail + candidate dimming.
- **Why:** real gap — deletion today is one-at-a-time (select-then-Backspace). Swipe is materially
  faster for cleanup. Every primitive already exists.
- **How:** add `'erase'` to the `PlanTool` union + `TOOLS` cluster (`PlanningBoard.tsx:61/63`),
  `cursor:'cell'`. `onWellPointerDown`: branch on `tool==='erase'` → `beginChange()` ONCE, set
  `drag.current={mode:'erase', removed:Set<string>}`, capture pointer. `onWellPointerMove`: hit-test
  `toBoard(e)` per element (card = x/y/w/h rect; arrow = point-to-bezier distance sampling
  `arrowPath`; stroke = point-in-polygon against the perfect-freehand outline / tolerance band),
  accumulate ids, pass `pendingErase:Set` to `WhiteboardSvg` to dim candidates + draw the trail in the
  existing draft slot. `onWellPointerUp`: `commit(elements.filter(e=>!removed.has(e.id)))` as ONE
  checkpoint. Hit-test helpers → new pure `planning/erase.ts`, unit-tested like `elements.test.ts`.
- **Out of scope:** partial stroke/arrow erasing (Excalidraw #4904) — atomic-only.
- **📏** unit tests for each hit-test kind; e2e: erase swipe removes elements as one undo step.

### W1.2 — Board-scoped tool shortcuts (letters only: s/n/c/a/p/e)
- **Why:** keyboard-first for the tools we have; draw-once-then-revert-to-select already exists.
- **How:** keydown on the focusable well div (`PlanningBoard.tsx:399` `tabIndex=0`, `onKeyDown :407`)
  mapping `s/n/c/a/p/e → setTool` when the board owns focus, beside the existing Delete/Backspace
  branch. **CRITICAL: `e.stopPropagation()`** so bare keys don't also fire the global Canvas bindings
  (the global typing-guard only suppresses INPUT/TEXTAREA/contentEditable, NOT a focusable div).
  **Letters only** — avoid the number row to dodge the live global `1`(fit)/`0`(recenter)/`t`(tidy).
- **📏** unit/e2e: focused board key sets tool; global fit/tidy NOT triggered.

### W1.3 — Scene/session no-persist guardrail (doc only, no feature)
- **Why:** we already follow the scene/appState split by omission; make the contract explicit so a
  future contributor can't route ephemeral state into `elements[]` or a board patch key.
- **How:** one-line comment in `boardSchema.ts` `toObject()` naming the contract; one-line note on the
  `updateBoard` patch-key allowlist (`['x','y','w','h','title','z','elements']`) that
  draft/preview/selection must never become a patch key; one sentence in CLAUDE.md. No code feature.

---

## Phase W2 — Selection core (L + M) ⛓ W1.1

### W2.1 — Multi-select (L)
Marquee + Shift-click additive + multi-drag + group-delete. **Selection subset only** — no
resize/rotate handles (those need a transform subsystem, disproportionate for a sketch surface).
- **Why:** universal Figma/PowerPoint grammar, near-zero learning curve, AND the structural unlock for
  W3.
- **How:** (1) `selectedElId: string|null → Set<string>` (`PlanningBoard.tsx:91`), threaded through
  `WhiteboardSvg.onSelect`, the three card components' `onDragStart`, and the Delete handler
  (`:407-414`). (2) new `drag.mode:'marquee'`: pointer-down on **empty** well in select mode → dashed
  rect (draft-overlay pattern), hit-test each element's bbox on pointer-up. (3) new pure
  `elementBBox(el):{x,y,w,h}` in `elements.ts`, discriminating on kind (cards have w/h; stroke =
  min/max of points; arrow = endpoint bbox; text = measured/fixed), unit-tested. (4) multi-drag folds
  `translateElement` across the set under ONE `beginChange()`; multi-delete iterates `removeElement`.
  Sync module `lastRecorded`.
- **Risks:** marquee must start only on empty well (pointer-capture interplay). Cross-kind bbox must
  NOT assume w/h (arrows/strokes have no top-left) or it silently mis-selects. Don't orphan checklist
  auto-grow state on delete. Keep resize/rotate handles OUT.
- **📏** unit `elementBBox` per kind; e2e: marquee selects, shift-click adds, multi-drag = one undo.

### W2.2 — In-board snapping + alignment guide lines (M)
Edge/center snap while dragging, guides render in the draft slot.
- **Why:** real-time alignment turns tidying into a felt affordance. Single isolated choke point
  (every move funnels through one rounded `dx/dy` before `setDragPos`).
- **How:** in `onWellPointerMove` (~`:279`, move case) adjust computed `dx/dy` against neighbor anchors
  before `setDragPos`; pointer-up's `translateElement` (`:319`) keeps it one checkpoint. Pure
  `anchors` helper returning `{left,centerX,right,top,centerY,bottom}` per kind (note trivial;
  checklist uses `growForChecklist` measured height; endpoint-only for arrow/stroke; DOM-measured for
  auto-sized text). Guides gated on transient state mirroring `draftArrow`/`draftStroke`. Snap on/off
  **pill in the board TOOLS cluster** (not a global hotkey). Thresholds in BOARD-LOCAL px (zoom-stable).
- **Risks:** zoom-stability (board-local px). Union sprawl — handle all five kinds. Runtime-measured
  sizes not in schema → first-frame anchors can be stale. **CUT** equal-gap distance pills (O(n²)/frame)
  and grid mode (clashes with the 12px dot lattice) from v1.
- **📏** pen.test-style unit on the snap math; e2e: drag snaps to neighbor edge/center.

---

## Phase W3 — Selection follow-ons (M) ⛓ W2.1

All unlocked by the selection set; each independently shippable.

- **Alt-drag duplicate** — cheap follow-on once the selection set exists: alt-held drag clones the
  selection at the drag offset, one checkpoint.
- **Align / distribute** — operate on the multi-select set using `elementBBox`. Align L/C/R/T/M/B;
  distribute H/V. Needs multi-select first.
- **`locked?: boolean`** (schema bump) — add OPTIONAL `locked?` to `ElementCommon`
  (`boardSchema.ts:57-61`), forward default-inject `false` (the one Excalidraw migration nugget worth
  adopting — new optional field, no version branch beyond the assert update). Gate in
  `onWellPointerDown` hit-testing, `startElementDrag`, and the Backspace handler. Pick off AFTER an
  element context-menu exists.
- **Lightweight grouping (`groupId`)** — move/delete-together only. **NOT cross-kind z-reorder** —
  that's structurally crippled by the SVG-under-DOM split and unifying the layer is a whiteboard
  rewrite (jeopardizes the stroke-outline WeakMap cache + hit-testing contract). Add `groupId?` when
  scheduled.
- **📏** align/distribute math unit-tested; group move/delete = one undo step.

---

## Phase W4 — Image element + assets pipeline (L) ⛓ W1 (sequenced after interaction)

Paste/drag-drop a screenshot onto a plan, backed by a real `assets/` blob pipeline. Images are
HTML/SVG → **no WebContentsView occlusion concern** (advantage over Browser boards).

- **Element (easy half):** add `ImageElement {kind:'image', x,y,w,h, assetId}` to the union
  (`boardSchema.ts:104`); `assertPlanningElement` case (kind, finite x/y/w/h, non-empty `assetId`);
  `makeImage` factory + trivial `translateElement 'image'` case (top-left, like note); new
  `ImageCard.tsx` mirroring `NoteCard.tsx`; `onPaste`/`onDrop` on `.pl-well`. CSP already allows
  `img-src 'self' data: blob:` (`index.html:16`).
- **Persistence (the real cost):** build the `assets/` pipeline CLAUDE.md describes but that does NOT
  yet exist (`projectStore.ts` writes ONLY `canvas.json`). MAIN-side IPC writes pasted bytes to
  `<projectDir>/assets/<sha1>.<ext>` via `write-file-atomic`; store the **relative path** (NEVER a
  base64 data URL); dedup on hash. Load via preload `asset:read`→bytes→`blob:` URL (chosen over a
  custom protocol; CSP already allows `blob:`), never `file://`. GC = mark-and-sweep at project open
  (undo-safe — bytes never deleted mid-session). Bump `SCHEMA_VERSION 3→4` + `MIGRATIONS[3]` (W3 took v3).
- **Risks:** the `assets/` infra is the bulk — easy to under-estimate because the element half looks
  trivial. **The base64-inline shortcut VIOLATES the locked "heavy blobs in `assets/` by path, not
  inlined" rule** — bloats every autosave, defeats dedup; do NOT take it. Asset orphan/leak if delete
  doesn't GC (same class as the WebContentsView no-`destroy()` leak). Undo-of-a-delete must not require
  resurrecting GC'd bytes → prefer ref-count + lazy GC, or never-delete-bytes. `.bak` rotation covers
  `canvas.json` ONLY, not `assets/` → `ImageCard` needs a missing-asset fallback. Pasted image is
  untrusted — renderer DOM only, never near the PTY. Defer flip/resize/element-clipboard.
- **📏** schema migrate 3→4 round-trip; dedup + GC unit tests; e2e: paste image persists + reloads.

---

## Phase W5 — Export (M) ⛓ none (standalone)

PNG/SVG export of a Planning board. **Drop the round-trip + font parts** — emitting native
`.excalidraw` JSON would be a lie unless we map every element to their schema (ADR 0001 reject), and
the "deliverable + editable source" value is already delivered by `canvas.json`.
- **How:** render the board's elements to an offscreen SVG (reuse `WhiteboardSvg` paths + card
  geometry) → serialize for SVG export; rasterize to PNG via canvas. Pure-ish, reads element state.
- **📏** export produces a valid file matching on-board geometry.

---

## Deferred — the shapes epic (XL, NOT in this track)

The single missing primitive — geometric SHAPES (rect/ellipse/diamond) + shape-bound connectors —
gates ALL of the following. Each *looks* like a small toggle but silently drags in the whole epic.

| Feature | Blocked on |
|---|---|
| Sloppiness / Rough.js | shapes; also clashes with the calm aesthetic + redundant with perfect-freehand |
| Bound-arrow reflow / living connectors | bindable shapes + `boundElements` registry + reflow; React Flow edges already cover the node-follow case (ADR 0001). *Cheap ~80% later: nearest-card-edge endpoint snapping on draw/drag-end, no live reflow.* |
| Mermaid-to-diagram · AI text-to-diagram · wireframe-to-code | shapes + a Mermaid→our-schema compiler; AI needs an LLM-call layer we lack (agent-agnostic via PTY). A static Mermaid SVG via the W4 Image element satisfies ~80% cheaply. |
| Font/size/align props panel · Excalifont | violates the LOCKED "Tweaks panel cut" + single-accent contract |

Also out: calligraphic pressure-taper pen (deliberately tuned OFF — `thinning:0`,
`simulatePressure:false`; mouse has no real pressure), stylus `pressures[]` sidecar, lenient
`restore()` default-injection (would mask corrupt files instead of failing over to `canvas.json.bak`).

---

## Status

| Phase | Status |
|---|---|
| W1 — Quick wins | ✅ done (2026-06-02) — eraser (W1.1) · letter shortcuts (W1.2) · scene/session guardrail (W1.3). Integrated on top of #15 (WB-1); 502 unit green, lint+typecheck clean, e2e PLANNING ok (browser-trio = known env flake). Branch `feat/whiteboard-w1-integ`. |
| W2 — Selection core | ✅ done (2026-06-02) — multi-select (marquee intersect + Shift-add + multi-drag + group-delete) · in-board snapping (edge/center guides, snap pill). Pure helpers elementBBox/anchors/translateMany + marquee.ts + snapping.ts unit-tested; e2e whiteboard-group-delete/multidrag/snap green. Branch feat/whiteboard-w2. |
| W3 — Selection follow-ons | ✅ done (2026-06-03) — alt-drag duplicate · align/distribute (L/C/R/T/M/B + H/V) · `locked?` (resists drag/erase/delete incl. the per-element X) · lightweight `groupId` grouping (move/delete-together), all via a right-click `ElementContextMenu` (select-then-act). Schema **v2→v3** (optional `locked?`/`groupId?` on `ElementCommon`, additive no-op migration, no default-inject). Pure `align.ts` + `elements.ts` mutators (isLocked/expandGroups/duplicateElements/group/ungroup/setLocked) unit-tested; lock wins over group; one undo checkpoint per gesture. Subagent-driven TDD workflow; gate green (556 unit, lint+typecheck+format:check), e2e `E2E_DONE ok:true` incl. 4 new W3 probes (alt-dup synthetic-altKey real-coords, lock, group, align). Branch `feat/whiteboard-w3` → targets `feat/whiteboard`. |
| W4 — Image + assets | ✅ done (2026-06-03) — paste/drop a screenshot → `image` element backed by an `assets/<sha1>.<ext>` blob pipeline (relative path, dedup on hash, mark-and-sweep GC at open). blob-via-preload load (CSP unchanged); ImageCard with missing-asset fallback. Schema **v3→v4** (additive no-op `MIGRATIONS[3]`). Subagent-driven TDD; per-task two-stage review. e2e: real `webContents.paste()` persists + reloads + dedups + GCs. Branch `feat/whiteboard-w4` → `feat/whiteboard`. |
| W5 — Export | not started |

Promote a slice's detailed spec/plan into `docs/superpowers/specs/` when it's scheduled; update this
table as slices land. Per-slice *why/how/risk* depth lives in
[`research/excalidraw-feature-borrowing.md`](research/excalidraw-feature-borrowing.md).
