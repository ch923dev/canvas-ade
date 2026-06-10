# Spec — Canvas Backdrop (wallpaper mode)

> **Status:** direction + design artifact SIGNED OFF by the user 2026-06-11 (mock v2 + blossom-river
> scene, see `mocks/`). Implementation queued **after design-audit waves D3/D4** merge.
> **Branch:** `feat/canvas-backdrop` · two PRs (PR 1 core + user wallpaper · PR 2 bundled scene).
> **Doc lifecycle:** this folder is per-slice — DELETE it in the PR that merges PR 2 (build-history
> line is the residue).

## 1. Summary

A per-project backdrop layer behind the infinite canvas: the user's own wallpaper (image or looping
video) or a bundled procedural animated scene, with dim/saturation controls. **Screen-fixed** (does
not pan/zoom with the camera — desktop-wallpaper semantics). Default remains today's flat void —
**zero visual change for existing projects and for new projects until opted in.**

Origin: user vision = vivid wallpaper-grade art behind the boards (reference: anime river scene with
terminals floating over it), superseding an earlier ambient-texture concept (Drift/Current presets —
dropped from scope; revivable later as just another bundled scene).

## 2. Locked decisions

| Topic | Decision |
|---|---|
| Backdrop anchoring | Screen-fixed, fills the canvas pane. NOT world-anchored. |
| Sources | `none` (default) · `file` (user image/video → project `assets/`) · `scene` (bundled procedural: `blossom-river`) |
| Controls | Dim 0–0.85 (default **0.25**) · Saturation 0.2–1.2 (default **0.70**, user-tested) |
| Board chrome | **Unchanged** — boards stay fully opaque. Translucency/glass-blur = deferred follow-up, NOT v1. |
| Grid dots | Existing `FadingDots` stays, above the backdrop; toggle in picker (default OFF when a backdrop is active). |
| Animation policy | Video: muted loop. Scene: rAF ≤30fps. Both pause on `document.hidden`; freeze to a still under reduced-motion. |
| Persistence | `canvas.json` schema **v8 → v9**, optional `background` field. NOT undoable (settings-class, like `viewport`). |
| Native previews | Live Browser boards stay opaque over the backdrop (inherent — ADR 0002). Accepted. |
| Contract | Recorded as **ADR 0003** + a CLAUDE.md Locked-decisions row (`design-reference/` is read-only; amendments live in the ADR, as with the D0 token deltas). |

## 3. UX spec

**Picker** — a backdrop button in the camera cluster (top-right), sibling of the Tidy picker,
following its popover + `LAYOUT_PRESETS`-style pattern:

```
┌ Backdrop ──────────────────┐
│ ○ None                     │
│ ○ Blossom River   (scene)  │
│ ○ Wallpaper…  [choose file]│
│ ──────────────────────────│
│ Dim        ────●────  25%  │
│ Saturation ───●─────  0.70 │
│ ☐ grid dots on top         │
└────────────────────────────┘
```

- Sliders + dots toggle enabled only when source ≠ None. Changes apply live (no Apply button);
  persisted by the normal ~1s debounced autosave.
- "Wallpaper…" = `<input type=file>` (accept: png/jpg/jpeg/webp/gif/webm/mp4). On pick:
  ArrayBuffer in the renderer → existing `asset.write(bytes, ext)` IPC → store returned `assetId`.
  Re-picking replaces the reference (old asset stays in the content-addressed store; GC out of scope).
- **Missing asset on load** (file deleted / cloned project): fall back to plain void **+ toast**
  ("Backdrop file missing — reverted to none"). No silent failure.
- Popover must use the ref-counted popover token (PREV-C pattern) so it can't collide with
  Tidy/board menus.

**Design artifact (approved):** `mocks/ambient-bg-v2.html` (wallpaper layer + dim/saturation over
real-token board chrome) and `mocks/scene-blossom-river.html` (procedural scene, mulberry32 seed
**7** = the approved composition). User-tested wallpaper config: dim 0%, saturation 0.70, opaque
boards — defaults above bias dim to 0.25 for long-session readability; confirm at kickoff.

## 4. Architecture

**New:** `src/renderer/src/canvas/backdrop/`
- `BackdropLayer.tsx` — absolutely-positioned layer filling the canvas pane, **z-order below the
  React Flow container**, `pointer-events: none`. Renders one of: nothing · `<img>` ·
  `<video muted loop playsinline>` · `<canvas>` (scene). CSS `filter: saturate(S)` on the media;
  a sibling void-colored overlay div carries the dim alpha.
- `useBackdropMedia.ts` — `assetId` → `asset.read` bytes → Blob URL; revokes on
  change/unmount/project-switch; exposes load-state (drives missing-file fallback + toast).
- `scenes/blossomRiver.ts` *(PR 2)* — port of the mock renderer (`buildScene`/`renderScene`,
  seed fixed at 7); self-stopping ≤30fps rAF; full stop + one static frame under
  `prefersReducedMotion()` (live `change` listener) and on `visibilitychange`.

**Touched:**
- `canvas/Canvas.tsx` — mount `<BackdropLayer/>` behind ReactFlow; RF wrapper background becomes
  transparent only when a backdrop is active ("none" stays pixel-identical to today).
- `canvas/AppChrome.tsx` + new `canvas/BackdropPicker.tsx` — camera-cluster button + popover.
- `index.css` — picker styles; any picker transitions ride `ca-t-*` reduced-motion classes.

**Invariants (do not violate):**
- The layer never reads the viewport and never re-renders on pan/zoom (screen-fixed ⇒ no camera
  subscription at all).
- Renderer never touches Node/fs — media bytes only via the existing frame-guarded
  `asset:write`/`asset:read` IPC. **No new MAIN surface.**
- Backdrop never participates in `chromeExclusionZones`/preview-occlusion math — strictly beneath
  everything.
- Sandbox/contextIsolation untouched.

## 5. Persistence & schema

```ts
// boardSchema.ts — CanvasDoc, v9
background?: {
  kind: 'none' | 'file' | 'scene'
  assetId?: string        // kind 'file': 'assets/<sha>.<ext>'
  scene?: 'blossom-river' // kind 'scene'
  dim: number             // clamp [0, 0.85]
  saturation: number      // clamp [0.2, 1.2]
  gridDots: boolean
}
```

- Migration `8 → 9`: identity bump (field optional; absent ⇒ none). `fromObject` validates kind,
  clamps numbers, validates `assetId` shape (mirror the image-element validator,
  `boardSchema.ts:512`).
- ⚠️ **Schema v9 CLAIMED on ACTIVE-WORK.md** by this worktree — re-verify no competing claim at
  kickoff (v6/v7/v8 all collided historically).
- Store: `background` in `canvasState` + `setBackground(partial)` action; serialized via
  `toObject`; **excluded from undo past/future** (document next to the viewport exclusion).

## 6. Performance & limits

- Video: GPU decode, ~0 CPU; `video.pause()` on hidden + reduced-motion (paused first frame = the still).
- Scene: ~2ms/frame measured in the mock at 1080p; cap 30fps; rAF fully stops when
  hidden/reduced/none.
- Blob-URL holds the whole media file in memory → **import caps: 30MB image, 200MB video**;
  reject larger with a toast. (Streaming custom protocol = follow-up if anyone hits the cap.)

## 7. Testing

**Unit/integration:** migration v8→v9 (absent field · clamps · bad assetId rejection) · store
action + `toObject` round-trip · `useBackdropMedia` URL lifecycle (jsdom, mocked `asset.read`).

**E2E (Playwright `_electron`):**
1. Set scene backdrop → reload project → persists (fresh temp project per spec — no persistent
   userData pollution).
2. Backdrop active → board drag/marquee/pan still work (real input via `sendInputEvent`, NOT
   synthetic dispatch).
3. `emulateMedia` reduced-motion → scene canvas pixel-stable across 2 frames (animation halted). *(PR 2)*
4. Missing-asset project fixture → loads to void + toast visible.

**Gates:** cheap trio pre-commit · full unit · `pnpm test:e2e:matrix` both legs — run it
**manually before the branch's first push** (pre-push skips brand-new branches).

## 8. Plan

**PR 1 — core + user wallpaper**
- S1 schema v9 + store (+tests)
- S2 `BackdropLayer` + `useBackdropMedia` + Canvas mount
- S3 picker UI + toasts + import caps
- S4 e2e probes 1/2/4
- S5 ADR 0003 + CLAUDE.md Locked-decisions row + roadmap line

**PR 2 — bundled scene**
- S6 port `blossomRiver.ts` + picker row
- S7 reduced-motion/hidden gating + e2e probe 3

**Out of scope (recorded follow-ups):** board translucency/glass-blur · drag-drop-to-set-wallpaper
(conflicts with planning-image drop zones) · scene variants (dusk recolor) · asset GC · video
streaming protocol.

**Open at kickoff:** confirm defaults (dim 0.25 / sat 0.70) · confirm 200MB video cap · re-verify
schema v9 claim · confirm D3/D4 actually merged (rebase target = ACTIVE-WORK "Integration tip").
