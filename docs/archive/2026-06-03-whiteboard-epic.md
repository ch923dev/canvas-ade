# Whiteboard epic (W1–W5) — compiled build-log

> Point-in-time record of the Planning-whiteboard feature track (Excalidraw-idea borrowing).
> **Not live truth** — durable contract is `CLAUDE.md`; forward work is `docs/roadmap.md`. The
> per-slice roadmap (`roadmap-whiteboard.md`), the research source
> (`research/excalidraw-feature-borrowing.md`), and the per-slice TDD plans/specs/handoffs were
> **compiled into this file and deleted** on 2026-06-04. Originals live in git history —
> `git log --all --oneline -- docs/roadmap-whiteboard.md docs/superpowers/` then check out the path.

**Shipped:** all five slices on `main` via `feat/whiteboard` umbrella PR #34 (`9533f67`, 2026-06-03).
Schema reached **v4**. Borrow ideas, not the library — Excalidraw-the-dependency stays rejected (ADR 0001);
our whiteboard is custom (vendored perfect-freehand + React Flow edges).

## Non-negotiable constraints (held by every slice)

- Calm Linear/Raycast aesthetic — one accent, no Tweaks panel, no decorative scribble.
- One undo checkpoint per gesture + the `lastRecorded` phantom-undo discipline (memory
  `undo-lastrecorded-phantom`; this is Round-3 finding WB-1, fixed 2026-06-02).
- SVG-under-DOM two-layer split is fixed (arrows/strokes render *under* the DOM cards so cards stay
  clickable) — caps cross-kind z-ordering; not changeable without a rewrite.
- Sandbox/isolation locked — pasted/loaded content stays in renderer DOM, never near the PTY.
- Scene/session split — geometry persists in `canvas.json`; selection/tool/draft stay ephemeral in Zustand.

## Slices

| Slice | Shipped | What landed | Commit |
|---|---|---|---|
| **W1 — Quick wins** | 2026-06-02 | Eraser (swipe-to-delete whole elements, atomic, pure `planning/erase.ts` hit-test helpers) · board-scoped letter shortcuts (s/n/c/a/p/e, `stopPropagation` so bare keys don't fire global Canvas bindings) · scene/session no-persist guardrail (doc-only contract). | `0324610` (#16) |
| **W2 — Selection core** | 2026-06-02 | Multi-select (`selectedElId → Set<string>`, marquee intersect, Shift-add, multi-drag, group-delete; no resize/rotate handles by design) · in-board snapping (edge/center guides, snap pill, board-local px). Pure `elementBBox`/`anchors`/`marquee.ts`/`snapping.ts`, unit-tested. | `8505a81` (#19) |
| **W3 — Selection follow-ons** | 2026-06-03 | Alt-drag duplicate · align/distribute (L/C/R/T/M/B + H/V) · `locked?` · lightweight `groupId` grouping (move/delete-together, **not** cross-kind z-reorder), all via a right-click `ElementContextMenu`. Schema **v2→v3** (additive optional fields). Pure `align.ts` + `elements.ts` mutators. **Align ships board-edge-relative** (`ALIGN_PAD` from the well), not selection-bbox-relative — a deliberate deviation from the design spec. | `0ef7963` (#28) |
| **W4 — Image + assets** | 2026-06-03 | Paste/drop a screenshot → `image` element backed by an `assets/<sha1>.<ext>` blob pipeline (relative path, dedup on hash, mark-and-sweep GC at open, blob-via-preload load, missing-asset fallback). Schema **v3→v4**. **Paste = a document-level `paste` listener gated on well-focus** — Chromium dispatches `paste` at the document, not the focused non-editable well, so a well `onPaste` never fires for Ctrl+V (memory `paste-fires-at-document`). | `b8759a7` (#30) |
| **W5 — Export** | 2026-06-03 | PNG/SVG export of a Planning board. Pure `whiteboardExport.ts` (`boardToSvg`) reuses `arrowPath`/`strokeToPath`/`elementBBox`; resolves CSS-var tokens to literals (`exportColors.ts`); images base64-inline **into the artifact only** (never `canvas.json`). Renderer `exportBoard.ts` rasterizes SVG→PNG offscreen; MAIN `export:save` IPC = native save dialog + `write-file-atomic` (foreign-sender guarded). Read-only — no store write, no undo. | `2551798` (#33) |

Bundled on the same track: **Planning full-view = camera fit** (`00e5a13`) — full view of a Planning
board is a `rf.fitView` CAMERA fit, **NOT** a portal + CSS-transform (a second transform was the
add-note coordinate bug; `toBoard` inverts only one). Do not re-introduce a portal for Planning. The
checklist whole-body drag fix landed alongside. (Bounded-box world coords remain the long-term direction.)

Final gate at W5: 591 unit green, typecheck+lint+format:check clean; the homegrown `CANVAS_SMOKE=e2e`
probes (since retired in favour of Playwright `_electron`, see `2026-06-03-testing-strategy-initiative.md`)
were green bar the known browser-trio env flake (memory `e2e-browser-trio-flake`).

## Deferred — the shapes epic (XL, NOT in this track)

Geometric SHAPES (rect/ellipse/diamond) + shape-bound connectors is the single missing primitive that
gates the features below. Each *looks* like a small toggle but silently drags in the whole epic. Kept
out deliberately — see `docs/roadmap.md` › Deferred and the still-relevant draw.io research.

| Feature | Blocked on |
|---|---|
| Sloppiness / Rough.js | shapes; also clashes with the calm aesthetic + redundant with perfect-freehand |
| Bound-arrow reflow / living connectors | bindable shapes + `boundElements` registry + reflow; React Flow edges already cover the node-follow case (ADR 0001). Cheap ~80% later: nearest-card-edge endpoint snapping on draw/drag-end, no live reflow. |
| Mermaid-to-diagram · AI text-to-diagram · wireframe-to-code | shapes + a Mermaid→our-schema compiler; AI needs an LLM-call layer (agent-agnostic via PTY). A static Mermaid SVG via the W4 Image element satisfies ~80% cheaply. |
| Font/size/align props panel · Excalifont | violates the LOCKED "Tweaks panel cut" + single-accent contract |

Also out: calligraphic pressure-taper pen (tuned OFF — `thinning:0`, `simulatePressure:false`), stylus
`pressures[]` sidecar, lenient `restore()` default-injection (would mask corrupt files instead of failing
over to `canvas.json.bak`).
