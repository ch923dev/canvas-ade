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

Perf contract per scene (inherits spec §6): single shared `<canvas>`, dpr clamp 1.5, frame budget
target ≤2ms at 1080p (blossom-river's measured bar), full rAF stop when hidden / reduced-motion
(one `renderStill` frame) / source ≠ scene.

## 4. Plan deltas (extends spec §8)

**PR 3 — preset library**
- S8 gallery picker upgrade: radio rows → tier-grouped thumbnail grid (🎨 in-app screenshot pass
  on the picker itself before merge; popover keeps the PREV-C ref-counted token).
- S9 port `drift` + `current` from the approved ambient mock.
- S10 the six voted scenes — **one commit per scene**, each with its in-app screenshot; if review
  size balloons, split into PR 3a (S8+S9) / PR 3b (S10) at the implementer's discretion.
- S11 registry drift-guard unit test + preset persistence e2e (set each id → reload → renders).

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
