# ADR 0006 — Canvas backdrop (wallpaper mode)

- **Status:** accepted (spec signed off 2026-06-11; preset library + grid variants by user vote
  2026-06-12 — `docs/canvas-backdrop/` carries the per-slice detail until PR 2 merges; this ADR is
  the durable residue).
- **Context:** the user wants wallpaper-grade art behind the boards (vivid scenes or their own
  image/video), beyond the flat `--void`. `design-reference/` is read-only and predates this, so
  the visual-contract amendment lives here (like the D0 token deltas).

## Decision

A per-project **screen-fixed** backdrop layer behind the React Flow surface — desktop-wallpaper
semantics, NOT world-anchored (it never pans/zooms with the camera, and therefore never subscribes
to it). Sources: `none` (default — pixel-identical to pre-v9) · `file` (user image/video via the
existing `asset:write`/`asset:read` IPC, caps 30MB/200MB) · `scene` (bundled procedural canvas,
≤30fps, paused on `document.hidden`, a single still under reduced-motion). Controls: dim 0–0.85
(default 0.25) and saturation 0.2–1.2 (default 0.70); the grid lattice becomes opt-in above an
active backdrop. Persisted as optional `background` on `canvas.json` (**schema v9**, identity
migration); **settings-class like `viewport` — never on the undo rail**.

Scene ids resolve against `canvas/backdrop/sceneRegistry.ts` at RENDER time: a malformed
background **degrades** on load (a cosmetic field must never send a project to `.bak` recovery)
and a well-formed unknown id is **preserved** (newer preset packs degrade to void + toast in older
builds instead of being destroyed). Missing wallpaper file ⇒ revert-to-none + toast; import
failures toast — no silent paths.

## Consequences

- Board chrome stays fully opaque (translucency/glass = explicitly deferred); live native preview
  views paint above everything regardless (inherent, ADR 0002) — accepted.
- The layer is `pointer-events:none`, below RF, and never joins `chromeExclusionZones`.
- Amends the "no gradients/illustrative art" chrome rule for THIS opt-in layer only; all chrome
  above it keeps the DESIGN.md contract.
- Bundled-scene roster (9 scenes), palette variants (`sceneVariant`), and the world-grid style pick
  (`gridStyle` dots/lines/cross — React Flow native variants) ship across PRs 2–4 with **zero
  further migrations** (all v9 fields were minted up front).
