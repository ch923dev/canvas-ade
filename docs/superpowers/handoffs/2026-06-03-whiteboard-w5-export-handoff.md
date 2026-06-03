# Handoff — Whiteboard W5 (Export) · next phase

**Date:** 2026-06-03 · **Epic branch:** `feat/whiteboard` (tip `b8759a7`, W1–W4 merged) ·
**Next branch:** `feat/whiteboard-w5` off `feat/whiteboard`.

W4 (image + assets) shipped (PR #30, squashed into `feat/whiteboard`). The whiteboard epic now
has eraser (W1) · multi-select + snapping (W2) · selection follow-ons (W3) · image/assets (W4).
**W5 = Export** is the last planned slice in `docs/roadmap-whiteboard.md`; the shapes epic stays
deferred (XL, out of track).

## Scope — W5 Export (M, standalone, ⛓ none)

PNG/SVG export of a single Planning board. Source of truth: `docs/roadmap-whiteboard.md` › Phase W5
and `docs/research/excalidraw-feature-borrowing.md`.

- **Drop the round-trip + font parts.** Do NOT emit native `.excalidraw` JSON (would be a lie unless
  every element maps to their schema — ADR 0001 rejects the dependency). The "deliverable + editable
  source" value is already covered by `canvas.json`. SVG + PNG raster only.
- **How (intended):** render the board's elements to an **offscreen SVG** — reuse `WhiteboardSvg`
  path/geometry generation (arrows via `arrowPath`, strokes via the perfect-freehand outline) plus the
  card geometry (note/text/checklist/image rects). Serialize that SVG for the SVG export; rasterize to
  PNG by drawing the SVG into an offscreen `<canvas>` and `toBlob('image/png')`. Pure-ish — reads
  element state, no new persisted schema, no React Flow collision.
- **Image elements (W4) in export:** an `image` element's pixels live in `assets/<sha1>` as a `blob:`
  URL via `useAssetUrl`. For SVG/PNG export, inline the bitmap (read bytes → base64 data URI) **only in
  the exported artifact** — exporting is a one-shot deliverable, so base64 is correct HERE (this does
  NOT violate the "no base64 in canvas.json" rule, which is about persistence). Handle a missing asset
  (GC'd / restored from .bak) gracefully — skip or draw the fallback tile, never throw.
- **Trigger UI:** an Export entry on the board (BoardFrame action slot or the `⋯` board menu →
  "Export PNG / Export SVG"). Save via a MAIN-side save dialog + `write-file-atomic` (bytes/string).
  Keep it calm — no options panel beyond format (single-accent / no-Tweaks contract).

## Non-negotiable constraints (carry from the roadmap)

- Calm Linear/Raycast aesthetic; one accent; **no Tweaks/options panel**.
- One undo checkpoint per gesture + the `lastRecorded` phantom-undo discipline (memory
  `undo-lastrecorded-phantom`). Export is read-only → no checkpoint, but don't trip a phantom step.
- Sandbox/isolation locked — exported bytes are produced in the renderer and handed to MAIN for the
  save dialog; **never near the PTY**.
- Scene/session split — export reads `board.elements`; never serialize selection/tool/draft.

## Acceptance / tests

- Unit: the geometry serializer produces an SVG whose element coords match on-board geometry (reuse the
  `pen.test` / `elements.test` style — assert path `d`/rects per kind).
- e2e: trigger export on a seeded planning board → a valid PNG **and** SVG file is written; the SVG
  contains the expected number of element nodes; an image element's bitmap is embedded (not a dead
  `blob:` ref); a board with a missing asset still exports without throwing.
- Gate (run from the worktree): `typecheck` · `lint` · `format:check` · `test` · `CANVAS_SMOKE=e2e`
  → `E2E_DONE ok:true`.

## Process / gotchas (from W4, still live)

- **Run the session FROM the worktree**; `-C "Z:\canvas-ade-whiteboard-w5"` / absolute paths, never
  `cd` (git-bash cwd resets between Bash calls). Commit via quoted heredoc `-F -` (memory
  `bash-tool-commit-backticks`). `prettier --write` touched files before committing (the gate runs
  `format:check`).
- **e2e:** kill stray electron (`taskkill //F //IM electron.exe //T`), `pnpm build`, then
  `$env:CANVAS_SMOKE='e2e'; pnpm start`.
- **Known CI red, NOT yours:** `whiteboard-fullview-add` (W3 camera-fit probe) fails **deterministically
  on the GitHub runner** — "camera did not fit … zoom stayed ~1" — even after a prior de-flake; it
  passes locally. Chronic `package` matrix is red too (unsigned until Phase 5). Treat `check` + a local
  green `E2E_DONE` as the real gate. **A genuinely useful side-quest:** harden `whiteboard-fullview-add`
  so the animated camera fit is deterministic on a slow headless host (the poll for `r.width/offsetWidth
  > 1.3` never crosses on CI) — this is what keeps the `smoke` job red on every whiteboard PR.
- **Paste mechanism (W4 lesson, memory `paste-fires-at-document`):** Chromium dispatches `paste` at the
  **document**, not the focused non-editable well — a React `onPaste` on a canvas surface never fires
  for Ctrl+V; use a document listener gated on focus, and drive e2e with a **real** Ctrl+V
  (`sendInputEvent`), never `webContents.paste()` (no-op on non-editable) or a synthetic event.

## Branch ordering / coordination

- W5 is **standalone** (⛓ none) — can start immediately off `feat/whiteboard`.
- Land via squash PR → `feat/whiteboard` (NOT main), like W1–W4. Re-pull `feat/whiteboard` first; the
  `wb-sync` worktree's local copy was stale after the W4 + workflow merges.
- New CI: `feat/whiteboard` now carries the split workflows (`pr.yml` on PRs, `staging.yml` on push to
  `main`, `production.yml`). The whole whiteboard epic promotes to `main` (→ staging/production) once
  W5 lands and the team decides to ship the epic.
