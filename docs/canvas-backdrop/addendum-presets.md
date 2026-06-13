# Addendum — Pre-built backdrop preset library (signed off 2026-06-12)

> Extends `spec.md` (the PR 1/PR 2 contract is unchanged). Direction + roster decided by user vote
> on the rendered concept artifact `mocks/scene-concepts.html` (static frames of every concept,
> deterministic mulberry32 seeds). Same doc lifecycle: this folder is deleted in the PR that merges
> the last backdrop PR.

## 1. Decisions (user vote, 2026-06-12)

| Topic | Decision |
|---|---|
| PR 3 scene roster | **ALL voted in**: `aurora-night` · `starfield-nebula` · `sunset-ocean` · `snowfall-ridge` · `rainy-window` · `city-lights` + revive **`drift`** + **`current`** (the ambient pair from the original signed-off `ambient-bg-v2.html` mock, numbers already user-tuned). With `blossom-river` (PR 2) = 9 bundled scenes. |
| Scene variants | `sceneVariant?: string` rides schema v9 from PR 1 (additive optional — zero-cost now, enables palette swaps like Blossom River · Dusk later with no migration). |
| World-grid variants (PR 4) | **Approved** — picker's grid row becomes a style pick `dots · lines · cross` (React Flow native `BackgroundVariant`s) + the existing on/off. `gridStyle?` is designed into v9 now (optional, default `'dots'`) so PR 4 needs no schema bump. |
| Tier-A static textures (Graphite/Blueprint/Horizon/Carbon) | **Not greenlit** — user leans scenes. Revisit only if asked; the registry's `css` path stays in the design so they'd be additive. |
| Sign-off depth | The voted concept frames ARE the direction artifact. Each scene still gets an **in-app screenshot during its implementation commit** (composition check under real chrome + default dim 0.25) — lighter than a fresh sign-off loop, per the already-approved direction. |
| `misty-pines` addition (2026-06-13) | **Added to the PR 3 roster by user request** — generated interactively ("surprise me, productivity-calm"), pixels approved on the full mock `mocks/scene-misty-pines.html` (blossom-river-pattern, seed 13). Roster = **10 bundled scenes**. Bonus property: ALL its motion is loop-periodic over 120s (integer harmonics), which is how the user's interim WebM wallpaper was recorded seamlessly — port the motion as-is. |
| Video-backdrop ride-alongs (2026-06-13) | See §6 — `writeAsset` ext-allowlist fix ships with PR 2 (already cherry-picked onto this branch); accept-list drift-guard test assigned to PR 3. |

## 2. Registry — the extensibility seam (lands in PR 1)

```ts
// canvas/backdrop/sceneRegistry.ts
export interface SceneDef {
  id: string                      // persisted in canvas.json background.scene
  label: string                   // picker row / palette verb
  tier: 'ambient' | 'scenic'      // ('texture' reserved, not greenlit)
  create(canvas: HTMLCanvasElement, opts: SceneOpts): SceneHandle
  palettes?: Record<string, ScenePalette>  // sceneVariant values
  thumb: string                   // inline SVG/data-URI for the gallery picker
}
export interface SceneHandle { start(): void; stop(): void; renderStill(): void }
```

- `background.scene` is validated against `SCENE_IDS` in `fromObject`; unknown id ⇒ **fall back to
  none + toast** (mirrors the missing-asset rule — no migration ever needed when presets come/go).
- `sceneVariant` validated against the scene's `palettes` keys; unknown ⇒ default palette.
- Adding a preset = one module under `scenes/` + one registry row. Picker rows, palette verbs,
  thumbnails, and the registry drift-guard test (every id renders + round-trips persistence) all
  derive from the registry.

## 3. Roster — render notes (from the voted concept mock)

| id | tier | Motion (≤30fps, stops on hidden/reduced/none) | Mock seed |
|---|---|---|---|
| `drift` | ambient | dot-grid luminance wave, ~18s period (mock-tuned numbers) | ambient mock |
| `current` | ambient | flow-field particle trails, swirl/eddy params (mock-tuned) | ambient mock |
| `aurora-night` | scenic | curtain bands sway ~20s; stars static | 11 |
| `starfield-nebula` | scenic | slow twinkle only — near-static | 23 |
| `sunset-ocean` | scenic | ripple/sun-path dashes drift | 5 |
| `snowfall-ridge` | scenic | snow drifts down slowly | 17 |
| `rainy-window` | scenic | droplets slide; bokeh static | 29 |
| `city-lights` | scenic | windows flicker occasionally; antenna blink | 41 |
| `blossom-river` | scenic | per PR 2 (approved, seed 7) | 7 |
| `misty-pines` | scenic | fog banks sway between ridge layers · light rays pulse · 2 bird flocks cross (1 span/loop) · dust motes — all periodic over 120s (full mock `mocks/scene-misty-pines.html`, approved 2026-06-13) | 13 |

Perf contract per scene (inherits spec §6): single shared `<canvas>`, dpr clamp 1.5, frame budget
target ≤2ms at 1080p (blossom-river's measured bar), full rAF stop when hidden / reduced-motion
(one `renderStill` frame) / source ≠ scene.

## 4. Plan deltas (extends spec §8)

**PR 3 — preset library**
- S8 gallery picker upgrade: radio rows → tier-grouped thumbnail grid (🎨 in-app screenshot pass
  on the picker itself before merge; popover keeps the PREV-C ref-counted token).
- S9 port `drift` + `current` from the approved ambient mock.
- S10 the seven scenic scenes (six voted + `misty-pines`, added 2026-06-13) — **one commit per
  scene**, each with its in-app screenshot; if review size balloons, split into PR 3a (S8+S9) /
  PR 3b (S10) at the implementer's discretion.
- S11 registry drift-guard unit test + preset persistence e2e (set each id → reload → renders).
- S11b asset accept-list drift guard (§6): a unit test asserting the renderer accept lists
  (BackdropPicker `IMAGE_EXTS`/`VIDEO_EXTS` + useBackdropMedia `MIME_BY_EXT` keys) are a **subset
  of MAIN's `ASSET_EXTS`** — or fold all three onto one shared constants module if a clean shared
  location exists (renderer + MAIN both already import nothing across that boundary; the test is
  the cheaper, equally effective option).

**PR 4 — world-grid variants**
- S12 `gridStyle: 'dots' | 'lines' | 'cross'` in the picker grid row (RF `BackgroundVariant`
  native; FadingDots keeps `gridDotOpacity` fade for all three). No schema bump (field minted in v9).

## 5. Schema v9 (final shape — supersedes spec §5 block)

```ts
background?: {
  kind: 'none' | 'file' | 'scene'
  assetId?: string         // kind 'file': 'assets/<sha>.<ext>'
  scene?: string           // kind 'scene': SCENE_IDS-validated; unknown ⇒ none + toast
  sceneVariant?: string    // optional palette variant; unknown ⇒ scene default
  dim: number              // clamp [0, 0.85]
  saturation: number       // clamp [0.2, 1.2]
  gridDots: boolean        // grid-on-top toggle
  gridStyle?: 'dots' | 'lines' | 'cross'  // default 'dots'; consumed by PR 4
}
```

## 6. Ride-along fixes — video-backdrop import (found 2026-06-13, in the field)

The first real video-wallpaper import after PR 1 merged failed at the IPC boundary:
`Backdrop import failed: writeAsset: unsupported ext webm`.

- **Root cause:** accept-list drift across the process/trust boundary. PR 1 added video support to
  both renderer lists (BackdropPicker `VIDEO_EXTS`, useBackdropMedia `MIME_BY_EXT` + the `<video>`
  render path) but MAIN's `ASSET_EXTS` in `src/main/projectStore.ts` kept the W4 image-only set.
  MAIN re-validates by design (renderer is untrusted), so the duplication is intentional — the
  drift is the defect. Renderer-side tests mock `asset.write`, MAIN-side tests never asserted
  parity, no e2e imports a real video → the gap was only observable end-to-end.
- **Fix (ships with PR 2 — ALREADY on this branch):** commit `41e93db` (cherry-pick of the parked
  `fix/backdrop-video-assets` @ `941fd41`) — `ASSET_EXTS` += `webm`/`mp4`, kept-in-sync comment,
  parity regression test (write/read round-trip + case normalization). Verified on the source
  commit: cheap trio + unit 2254 green.
- **Hardening (PR 3, S11b above):** the subset drift-guard test, so the next ext added to one side
  fails a unit test instead of a user's import.
- ⚠️ The MAIN working tree carries the same one-line edit **uncommitted** (live unblock for the
  user's dev app). Whoever merges PR 2: `git checkout -- src/main/projectStore.ts` on main before
  pulling.
