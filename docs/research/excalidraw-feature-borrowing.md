# Research — borrowing the best of Excalidraw for our custom whiteboard

> Deep-research output (2026-06-01), web-sourced + grounded in the actual codebase +
> adversarially feasibility-checked against our stack. **Report only — nothing built
> or committed.** Borrow IDEAS, not the library: Excalidraw-the-dependency is rejected
> (`../decisions/0001-stack.md`); our whiteboard is custom (vendored perfect-freehand +
> React Flow edges). Method: 4 parallel web-research facets → codebase grounding pass →
> per-finding feasibility verify (43 raw findings → 19 feasible) → prioritized synthesis.

## TL;DR

Our custom Planning whiteboard **already matches Excalidraw's best architectural
decisions independently**: a discriminated-union element model on `kind`
(note/text/arrow/stroke/checklist), a clean scene-vs-session split (geometry persisted
in `canvas.json`; selection/tool/draft kept ephemeral in Zustand, never serialized),
perfect-freehand strokes as filled-outline polygons, double-click-to-create text, and
container-bound text (notes/checklists).

So most of Excalidraw's headline features are **either already shipped or gated behind one
primitive we deliberately do NOT have: a geometric SHAPE subsystem** (rect/ellipse/diamond)
plus shape-bound connectors. That single missing primitive is what makes Sloppiness/Rough.js,
bound-arrow reflow, Mermaid-to-diagram, AI text-to-diagram, group bounding-box transforms,
and faithful flowcharts all **XL** — every one of them requires building shapes first.

**The recurring trap:** a feature that *looks* like a small toggle (Sloppiness, "just
shortcuts", "wrap text in a container") silently drags in the whole shapes epic.

**The real near-term opportunity** is the cluster of selection/interaction primitives that
ride entirely on the existing board-local pointer loop and the `translateElement` delta-mover,
plus an image element that fills a genuine gap. **Recommended order: eraser → multi-select →
grouping/alignment/duplicate; image+assets pipeline as a separate deliberate phase; defer
everything that needs shapes.**

## Constraints any candidate must respect

- Locked calm **Linear/Raycast aesthetic** — no Tweaks panel, one accent, no decorative scribble.
- **Single undo checkpoint per gesture** discipline + the documented `lastRecorded`
  phantom-undo class (see memory `undo-lastrecorded-phantom`).
- The **SVG-under-DOM two-layer render split** (arrows/strokes hardcoded *under* the DOM cards
  so cards stay clickable) — this caps cross-kind z-ordering.
- Sandbox/isolation locked — pasted/loaded content stays in renderer DOM, never near the PTY.

---

## Quick wins (S — ride the existing pointer loop, zero/low schema)

### 1. Eraser tool — swipe-to-delete whole elements (atomic), hover-trail + candidate dimming
**Why.** Real gap: deletion today is one-element-at-a-time (`selectedElId` is a single id)
via select-then-Backspace. A swipe eraser is materially faster for cleanup. Every primitive
it needs already exists (tool union, captured pointer loop, `removeElement`, screen→board
mapping, single-gesture undo, draft-overlay slot for the trail). No schema change (erasing
only removes), no React Flow involvement (operates on `board.elements`, not RF nodes/edges).

**How.** Add `'erase'` to the `PlanTool` union + `TOOLS` cluster (`PlanningBoard.tsx:61/63`)
with an `IconBtn` and `cursor:'cell'`. In `onWellPointerDown`, branch on `tool==='erase'`:
`beginChange()` ONCE, set `drag.current={mode:'erase', removed:Set<string>}`, capture pointer.
In `onWellPointerMove`, hit-test `toBoard(e)` per element (cards: x/y/w/h rect; arrow:
point-to-bezier distance sampling `arrowPath`; stroke: point-in-polygon against the
perfect-freehand outline / tolerance band around the centerline) and accumulate ids; pass a
`pendingErase:Set` prop to `WhiteboardSvg` to dim candidates + render the trail in the existing
draft slot. In `onWellPointerUp`, `commit(elements.filter(e=>!removed.has(e.id)))` as ONE
checkpoint. Put hit-test helpers in a new pure `planning/erase.ts` so they unit-test like
`elements.test.ts`. **Keep atomic-only** — partial stroke/arrow erasing (Excalidraw #4904) is
an explicit out-of-scope rabbit hole.

### 2. Board-scoped tool shortcuts — mnemonic LETTERS only (s/n/c/a/p + e)
**Why.** Keeps the user on the keyboard for the tools we actually have; the
"draw-once-then-revert-to-select" model Excalidraw is praised for is already how the board
behaves (every create path calls `setTool('select')`). Pure local UI-state change.

**How.** Add a keydown handler on the already-focusable well div (`PlanningBoard.tsx:399`,
`tabIndex=0`, `onKeyDown` at `:407`) mapping `s/n/c/a/p/e` to `setTool` when this board owns
focus, alongside the existing Delete/Backspace branch. **CRITICAL: `e.stopPropagation()`** so
bare keys don't also fire the global Canvas bindings — the global typing-guard only suppresses
INPUT/TEXTAREA/contentEditable, NOT a focusable plain div (the tidy `t` binding already needed an
explicit `!closest('.react-flow__node')` guard for exactly this). **Letters only** — avoid the
number row to sidestep the live global `1` (fitView) / `0` (recenter) / `t` (tidy) collisions.

### 3. Make the scene/session no-persist boundary explicit (doc + patch-key guardrail)
**Why.** We already follow Excalidraw's scene-vs-appState split correctly *by omission*
(`toObject` writes only `{schemaVersion, viewport, boards}`; selection/tool/draft live in
Zustand and never serialize; `fromObject` drops a corrupt viewport to fit-on-load). Borrow
only the *discipline* (their `cleanAppStateForExport`): make the contract explicit so a future
contributor adding per-board ephemeral state doesn't accidentally route it into `elements[]` or
a board patch key and cause stale-tool/selection bloat bugs.

**How.** One-line comment in `boardSchema.ts` `toObject()` naming the contract; one-line note on
the `updateBoard` patch-key allowlist (planning keys = `['x','y','w','h','title','z','elements']`)
that draft/preview/selection must never become a patch key; one sentence in CLAUDE.md. No code feature.

---

## High value (worth a phase)

### Multi-select — marquee + Shift-click additive + multi-drag + group-delete (selection subset ONLY)
**Effort: L.** Universal Figma/PowerPoint selection grammar, near-zero learning curve, AND the
**structural unlock** for grouping, alignment/distribute, and group-duplicate later — all blocked
today because selection is a single `selectedElId:string|null`. Multi-drag already has its
primitive: `translateElement` shifts EVERY kind by a delta, so multi-drag is just folding that
delta across a selection set on one undo checkpoint. No RF conflict (RF selects nodes at the
canvas level, never inside the well).

**How.** (1) `selectedElId:string|null → Set<string>` (`PlanningBoard.tsx:91`), threaded through
`WhiteboardSvg.onSelect`, the three card components' `onDragStart`, and the Delete handler
(`:407-414`). (2) New `drag.mode:'marquee'`: pointer-down on EMPTY well in select mode starts a
dashed rect (draft-overlay pattern), hit-test each element's bbox on pointer-up. (3) New pure
`elementBBox(el):{x,y,w,h}` helper in `elements.ts` discriminating on kind (cards have w/h;
stroke = min/max of points; arrow = endpoint bbox; text = measured/fixed), unit-tested. (4)
Multi-drag folds `translateElement` across the set under ONE `beginChange()`; multi-delete
iterates `removeElement`. Sync module-level `lastRecorded` (phantom-undo class).

**Risks.** Marquee must start only on empty well (pointer-capture interplay). Cross-kind bbox math
must NOT assume w/h (arrows/strokes have no top-left) or it silently mis-selects. Don't orphan
checklist auto-grow state on delete. **Keep resize/rotate handles OUT** — they need a whole
transform subsystem (per-kind scale semantics for auto-sized text/checklists, rotation-aware
render AND hit-test) disproportionate for a sketch surface. Alt-drag-duplicate is a cheap
follow-on once the selection set exists.

### Image element + clipboard/drag-drop paste, backed by a real `assets/` blob pipeline
**Effort: L.** Pasting a screenshot of a running app onto a plan is a natural on-brand flow and a
real gap — there's no way to get any image onto a board today. The element half follows the exact
discriminated-union pattern we already walked for note/checklist; images are HTML/SVG so there's
**NO native WebContentsView occlusion concern** (an advantage over Browser boards). Content-hash
dedup keeps `canvas.json` small.

**How.** *Element (easy half):* add `ImageElement {kind:'image', x,y,w,h, assetId}` to the union
(`boardSchema.ts:104`), a validator case in `assertPlanningElement` (`:284`), `makeImage` + a
trivial `translateElement` case (top-left only, like note), a new `ImageCard.tsx` mirroring
`NoteCard.tsx`, and an `onPaste`/`onDrop` handler on `.pl-well`. CSP already allows
`img-src 'self' data: blob:` (`index.html:16`). *Persistence (the real cost):* build the `assets/`
pipeline CLAUDE.md describes but that does NOT yet exist (`projectStore.ts` writes ONLY
`canvas.json`) — MAIN-side IPC writes pasted bytes to `<projectDir>/assets/<sha1>.<ext>` via
`write-file-atomic`, store the **relative path** (never a base64 data URL) in the element, dedup
on hash, orphan-GC (or ref-count) on element/board delete. Load via custom protocol or preload
`readFile→blob:` URL, never `file://`. Bump `SCHEMA_VERSION 2→3` + a `MIGRATIONS` entry
(`boardSchema.ts:207`).

**Risks.** The `assets/` infra is the bulk of the work and easy to under-estimate because the
element half looks trivial. **The base64-inline shortcut is S/easy but directly VIOLATES the
locked "heavy blobs in `assets/` by path, not inlined" rule**, bloats every autosave, defeats
dedup. Asset orphan/leak if delete doesn't GC (same class as the WebContentsView no-`destroy()`
leak). Undo-of-a-delete must not require resurrecting GC'd bytes — prefer ref-count + lazy GC, or
never-delete-bytes. `.bak` rotation covers `canvas.json` only, NOT `assets/`, so `ImageCard` needs
a missing-asset fallback. Pasted image is untrusted — confine to renderer DOM, never near the PTY.
Defer flip/resize/element-clipboard.

### In-board object snapping + alignment guide lines (edge/center snap while dragging)
**Effort: M.** Real-time alignment turns tidying into a felt affordance. Single well-isolated
choke point: every move funnels through one rounded `dx/dy` in `onWellPointerMove` before
`setDragPos`, final write deferred to pointer-up — so snapped moves stay one undo step for free,
and guides render as a few extra `<line>` in the existing draft slot. Distinct from RF's
node-level `snapToGrid`.

**How.** In `onWellPointerMove` (~`:279`, move case) adjust the computed `dx/dy` against neighbor
anchors before `setDragPos`; pointer-up's `translateElement` (`:319`) keeps it one checkpoint.
Pure `anchors` helper returning `{left,centerX,right,top,centerY,bottom}` per kind (trivial for
note; checklist uses the measured height from `growForChecklist`; endpoint-only for arrow/stroke;
DOM-measured for auto-sized text). Render guides gated on a transient state mirroring
`draftArrow`/`draftStroke`. Snap on/off **pill in the board TOOLS cluster** (not a global hotkey).
Express thresholds in BOARD-LOCAL px so snapping stays zoom-stable; pen.test-style unit test.

**Risks.** Zoom-stability (thresholds must be board-local px / zoom-aware). Union sprawl: a naive
get-bounds that assumes w/h silently mis-snaps text/checklist/arrow/stroke — handle all five
kinds. Runtime-measured sizes aren't in the schema so first-frame anchors can be stale. **CUT
equal-gap distance pills** (O(n²)-ish per frame = scope-creep tail) and **grid mode** (clashes
with the 12px dot lattice) from v1. Multi-select align/distribute needs multi-select first.

---

## Avoid (tempting but bad fit)

| Feature | Why not |
|---|---|
| **Sloppiness / Rough.js** (Architect/Artist/Cartoonist) | Applies to GEOMETRIC shapes we don't have; Rough.js itself is ~9KB but the prerequisite is the whole shapes subsystem. Clashes with the locked calm aesthetic and is redundant with the organic feel perfect-freehand already gives — two competing sketchy styles on one surface. |
| **Bound-arrow reflow / living connectors** | Intersection math is the tip of an iceberg (bindable shapes + `boundElements` registry + start/endBinding + focus/gap + reflow-on-move). Our `ArrowElement` is `{x,y,x2,y2}` and `translateElement` moves both endpoints together — opposite of anchored reflow. The canonical use (connectors that follow nodes) is already React Flow edges at board-level (ADR 0001 dup). Prime `lastRecorded` phantom-undo source. *Cheap ~80% subset later: nearest-card-edge endpoint snapping on draw/drag-end, no live reflow.* |
| **Grouping + cross-kind z-order + locking (bundled)** | Cross-kind z-order is structurally crippled by the SVG-under-DOM split (can't bring an arrow above a note); unifying that layer is a whiteboard rewrite jeopardizing the stroke-outline WeakMap cache + hit-testing contract. Grouping needs multi-select first. **Only `locked?:boolean` is self-contained** — pick it off AFTER multi-select + once an element context-menu exists. |
| **Mermaid-to-diagram + AI text-to-diagram + wireframe-to-code** | All need shapes we don't have + a Mermaid→our-schema compiler (off-the-shelf only emits Excalidraw JSON, ADR 0001 reject). A static Mermaid SVG (via the Image element) satisfies ~80% of the agent-output case cheaply. AI text-to-diagram needs an LLM-call layer we deliberately lack (agent-agnostic via PTY, no SDK/key store); "no API token" is impossible without a hosted backend, contradicting single-user-desktop. Wireframe-to-code collapses into already-roadmapped screenshot-capture (`capturePage`) + write-context-into-bound-Terminal (`pty.write`) + a Browser board. |
| **Font/size/align props panel + Excalifont; embedded-scene round-trip export** | Props/font panel violates the LOCKED "Tweaks panel cut entirely" decision + single-accent contract; Excalifont/Virgil clashes with the visual language. Embedded-scene round-trip's value ("one file is deliverable + editable source") is ALREADY delivered by `canvas.json` — no flatten-then-lose-source problem. Emitting native `.excalidraw` JSON would be a lie unless we map every element to their schema (ADR 0001). **NOTE: plain PNG/SVG EXPORT of a Planning board is a genuine M-sized gap worth a standalone item later** — just drop the round-trip + font parts. |
| **Calligraphic pressure-taper pen + stylus pressure sidecar; Excalidraw `restore()` default-injection migration** | Taper is already deliberately tuned OFF (`thinning:0`, `simulatePressure:false` in `svgPaths.ts`): mouse/trackpad has no real pressure, velocity-simulated width reads wobbly + fights the calm aesthetic. Flipping it is a ~2-line taste toggle, not a feature. Stylus `pressures[]` sidecar + migration is a rabbit hole for a mouse-centric tool. Their lenient `restore()` default-injection would risk silently "healing" genuinely corrupt files instead of failing over to `canvas.json.bak` (our strict validator deliberately throws). The one transferable nugget — *inject defaults for NEW optional fields instead of bumping schemaVersion* — is just a doc convention. |

---

## Data-model changes (scoped to the above; explicitly avoiding the shapes epic)

All in `src/renderer/src/lib/boardSchema.ts` unless noted.

1. **Multi-select — no schema change.** `selectedElId:string|null` → `Set<string>` at the
   STORE/UI layer only (session state, never serialized — honors the scene/appState split). New
   pure `elementBBox(el):{x,y,w,h}` helper in `canvas/boards/planning/elements.ts`, unit-tested.

2. **Image element — schema bump 2→3.** Add to the union (`:104`):
   ```ts
   export interface ImageElement extends ElementCommon {
     kind: 'image'; w: number; h: number;
     assetId: string; // relative path under <projectDir>/assets/, e.g. assets/<sha1>.png — NEVER a base64 data URL
   }
   ```
   Add to `PlanningElement` union; `assertPlanningElement` case (validate kind, finite x/y/w/h,
   non-empty `assetId`; on load, drop element or show missing-asset fallback if the file is absent,
   mirroring existing dangling-`previewSourceId` pruning). `makeImage` factory + trivial
   `translateElement 'image'` case. Bump `SCHEMA_VERSION 2→3` + `MIGRATIONS[3]` forward-inject. New
   MAIN-side surface in `projectStore.ts`: `assetWrite(bytes)→sha1 path` (dedup), `assetRead(path)`,
   orphan GC / ref-count on remove. `assets/` is NOT covered by `.bak` rotation — rely on the
   missing-asset fallback.

3. **Locking (optional, AFTER multi-select — schema bump).** Add OPTIONAL `locked?:boolean` to
   `ElementCommon` (`:57-61`), forward default-inject `false` (the one Excalidraw migration nugget
   worth adopting — new OPTIONAL field, no version branch beyond the assert update). Gate in
   `onWellPointerDown` hit-testing, `startElementDrag`, and the Backspace handler.

4. **Eraser, shortcuts, snapping, export — NO schema changes.** Eraser only removes; shortcuts /
   snap-toggle are session UI state in Zustand (never in `elements[]` or a board patch key);
   snapping mutates in-flight `dx/dy` and commits via the existing `translateElement`; export reads
   element state and produces a file.

**Explicitly NOT added (would require the deferred shapes epic):** no rectangle/ellipse/diamond
kinds; no `startBinding`/`endBinding`/`boundElements`/`focus`/`gap` on `ArrowElement`; no migration
of `ArrowElement {x,y,x2,y2}` to point-relative `points[]`; no `pressures[]` sidecar on
`StrokeElement`; no per-element font/size/color/align fields (locked Tweaks-panel cut); no
`groupId` (defer until grouping is scheduled); no fractional index (single-user, array order suffices).

---

## Recommended first slice: the Eraser

Highest value-per-effort, lowest risk. Fills a real gap, adds ZERO persisted schema, no React Flow
collision. It **proves out the cross-kind hit-test helpers** (point-to-bezier arrows,
point-in-outline strokes, bbox cards) in a new unit-tested pure `planning/erase.ts` — and **those
exact helpers are then reused by multi-select's marquee hit-test and by snapping's anchor
extraction**. So eraser is both a self-contained S win AND the natural on-ramp to the larger
interaction phase (multi-select → grouping/alignment/duplicate), banking a shippable,
e2e-coverable improvement before committing to the L work. Keep it atomic-only; keep the whole
swipe as ONE `beginChange()` (phantom-undo class).

---

*Method note: 4 parallel web-research facets (core UX, data model, collab/extras, embeddable API)
→ codebase grounding (Explore agent over the Planning/whiteboard surface) → per-finding adversarial
feasibility verify against our stack → prioritized synthesis. 49 agents, 43 raw findings → 19
feasible. Not yet on the roadmap — promote chosen slices into `../roadmap.md` when scheduled.*
