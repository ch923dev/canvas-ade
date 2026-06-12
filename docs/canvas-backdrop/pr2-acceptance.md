# PR 2 — Blossom River scene: testing + acceptance criteria

> The working contract for PR 2 (S6 scene port + S7 motion gating), written BEFORE implementation
> (user mandate 2026-06-13). **Nothing is pushed — no commit reaches origin, no PR opens — until
> every AC below is verified AND the user has signed off on the manual test (§4).**
> Same doc lifecycle as the rest of this folder (dies with the last backdrop PR).

## 1. Scope

- **S6** — port the approved mock renderer (`mocks/scene-blossom-river.html`, **seed 7 fixed**) to
  `src/renderer/src/canvas/backdrop/scenes/blossomRiver.ts`; register it in `sceneRegistry.ts`;
  the picker row derives from the registry (no picker code change expected).
- **S7** — scene `<canvas>` host + `SceneHandle` lifecycle in `BackdropLayer.tsx`: ≤30fps rAF,
  full stop on `document.hidden`, one static still under `prefers-reduced-motion` (live toggle,
  no reload), e2e probe 3.
- **Riding along (already on the branch):** `6209e6c` webm/mp4 `ASSET_EXTS` fix (+ parity test),
  `b42314c` addendum §6 / misty-pines docs.

Out of scope: every other scene (PR 3), gallery picker (PR 3), `gridStyle` (PR 4), palette variants.

## 2. Acceptance criteria

### Functional

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | The backdrop picker shows a **Blossom River** row (scene tag); selecting it sets `background = { kind:'scene', scene:'blossom-river' }` and the scene renders behind all boards. | unit (picker) + manual M-2 |
| AC-2 | Composition matches the approved mock: **seed 7**, same palette, same painter pipeline (sky → clouds → mountains → land → far trees → river → reflections → shimmer → trees → tufts → petals). | manual M-3 (side-by-side vs mock) |
| AC-3 | Dim (0–0.85) and saturation (0.2–1.2) sliders affect the scene **live** (CSS filter + veil — no scene re-render needed). | manual M-4 |
| AC-4 | Scene persists: save → reopen restores `blossom-river` and it renders (probe 1 now exercises the KNOWN-scene path end-to-end). | e2e probe 1 (existing) |
| AC-5 | Animation runs ≤30fps (33ms frame gate): clouds drift, water shimmers, petals fall. | unit (frame gate) + manual M-3 |
| AC-6 | `prefers-reduced-motion`: exactly **one static still** (the mock's t=38.2 export phase), zero rAF scheduled; toggling the OS setting live switches animate↔still **without reload**. | unit + e2e probe 3 + manual M-5 |
| AC-7 | `document.hidden`: the rAF loop **fully stops**; resumes on visible. | unit (layer + handle) |
| AC-8 | Unknown scene ids still degrade exactly as PR 1 shipped (void + preserved setting + keyed toast) — `'probe-scene'`/`'not-shipped-yet'` paths untouched. | existing unit + e2e probe 2 |
| AC-9 | Input passthrough unchanged: real OS drag reaches canvas content through the scene layer. | e2e probe 2 (existing) |
| AC-10 | Pane resize: the scene rebuilds to the new size (no stretch/smear); under reduced-motion the still repaints at the new size. | unit (resize) + manual M-6 |
| AC-11 | Switching back to **None** restores the pixel-identical pre-v9 void (layer unmounts, rAF stops, no orphan canvas). | unit + manual M-7 |
| AC-12 | Video-wallpaper ride-along proven in-app: a `.webm` imports end-to-end (the `41e93db`→`6209e6c` fix; user's misty-pines file is the fixture). | manual M-8 |

### Invariants (must hold, spec §4 — regressions block the PR)

| ID | Criterion |
|---|---|
| IN-1 | The layer/scene never reads the viewport — zero camera subscriptions; pan/zoom causes **no** scene re-render (screen-fixed). |
| IN-2 | `pointer-events: none`; the scene canvas never wins a hit-test; never joins `chromeExclusionZones`. |
| IN-3 | No new MAIN/IPC surface; renderer never touches Node (the scene is pure canvas-2D). |
| IN-4 | `background` changes stay settings-class: never on the undo rail; persisted via the normal debounced autosave. |
| IN-5 | Sandbox/contextIsolation untouched. |

### Performance

| ID | Criterion | Verified by |
|---|---|---|
| PF-1 | Frame cost ≈ the mock's bar: target **≤2ms at 1080p** buffer (measure once in-app via the perf probe in M-9). | manual M-9 |
| PF-2 | Canvas buffer dpr is clamped at **1.5**. | unit |
| PF-3 | **Zero** rAF callbacks while: kind=none · reduced-motion · `document.hidden` · scene unmounted. | unit |

## 3. Test matrix (automated)

**Unit/integration (vitest, jsdom):**
- `sceneRegistry.test.ts` — `blossom-river` registered (id/label/tier/thumb), `getScene` round-trip, unknown id → `undefined`.
- `scenes/blossomRiver.test.ts` — stubbed 2D context + rAF + ResizeObserver:
  `create()` returns a handle without painting · `renderStill()` paints exactly one frame, schedules nothing ·
  `start()` begins the loop, first tick paints, then the 33ms gate skips/admits frames ·
  `start()` idempotent (no double loop) · `stop()` cancels + idempotent ·
  `reducedMotion: true` ⇒ `start()` is a no-op (zero rAF, zero paints) ·
  dpr clamp 1.5 · resize → buffer + model rebuild (+ still repaint when not running) ·
  jsdom-safe: `getContext` null / `clientWidth` 0 fall back without throwing (1920×1080 buffer).
- `BackdropLayer.test.tsx` (extend) — known scene mounts the `<canvas data-test="backdrop-scene">` with the saturate filter ·
  handle lifecycle: `create`+`start` when motion allowed, `create`+`renderStill` (never `start`-paint) under reduced ·
  `visibilitychange` hidden → `stop()`, visible → resume · unmount/scene-switch → `stop()` ·
  all existing PR 1 tests stay green (unknown-scene ids in them remain unregistered).
- `BackdropPicker.test.tsx` (extend) — Blossom River row renders from the registry; click sets the store.

**E2E (Playwright `_electron`, `e2e/backdrop.e2e.ts`):**
- Probe 3 (NEW, S7): scene active → two pixel-hashes 450ms apart **differ** (animation alive — the
  counter-control) → `emulateMedia({ reducedMotion: 'reduce' })` → two pixel-hashes 450ms apart are
  **identical** (frozen still). Hash = strided `getImageData` reduce in-page (no MB-size dataURLs over the wire).
- Probes 1/2/4 (existing) stay green — probe 1 upgrades to the known-scene path for free.

**Gates (in order):**
1. Cheap trio: `typecheck · lint · format:check`.
2. Full unit suite (worktree, nvm node 22.17 + corepack pnpm).
3. `pnpm test:e2e` (Windows leg) — must be green BEFORE the manual session.
4. **Manual test + user sign-off (§4) — the push gate.**
5. `pnpm test:e2e:matrix` BOTH legs manually before the first push (pre-push hook skips brand-new
   remote branches; Docker Desktop up; #135 means no WSL exception applies).

## 4. Manual test script (with the user, BEFORE push/PR)

Run the real app (`pnpm dev` in the worktree). Evidence: screenshot per ✓ where visual.

| # | Step | Pass when |
|---|---|---|
| M-1 | Launch, open/create a project. | Void canvas identical to current main (backdrop off by default). |
| M-2 | Camera cluster → Backdrop → pick **Blossom River**. | Row exists with `scene` tag; scene appears behind boards instantly; dim 25% / sat 0.70 defaults applied. |
| M-3 | Watch ~10s; compare against `mocks/scene-blossom-river.html` (seed 7) side by side. | Same composition (river bend, tree placement, mountains); clouds drift, shimmer moves, petals fall smoothly; **in-app screenshot recorded** (addendum sign-off contract). |
| M-4 | Drag Dim 0→85% and Saturation 0.2→1.2. | Live response, no flicker, no scene restart. |
| M-5 | Toggle OS reduced-motion (Win: Settings → Accessibility → Visual effects → Animation effects OFF) with the scene visible. | Animation freezes to a clean still WITHOUT reload; re-enable → animation resumes. |
| M-6 | Resize the window (incl. maximize/restore). | Scene re-fits with no stretching/smearing; still mode also re-fits. |
| M-7 | Switch backdrop → None. | Pre-v9 void restored exactly; no residual canvas (DevTools: no `backdrop-scene` element, no rAF activity). |
| M-8 | Wallpaper… → import the misty-pines `.webm`. | Video imports + plays muted/looped (ride-along proof); switch back to Blossom River after. |
| M-9 | DevTools console perf probe (10s sample, instructions inline in the session). | Mean frame ≤ ~2ms at 1080p-class buffer; rAF stops when the window is hidden (probe prints 0 callbacks while minimized). |
| M-10 | Pan/zoom the canvas hard while the scene runs. | Backdrop stays screen-fixed; no stutter coupling with the camera; boards drag normally over it (AC-9 spot check). |
| M-11 | Reload the project (close/reopen). | Blossom River + dim/sat restored (AC-4 spot check). |

**Sign-off line:** user approves pixels + behavior → only then: push branch → full matrix → open PR 2.

## 5. Definition of done (PR 2)

Gate chain §3 all green + §4 signed off + e2e header comment updated (registry no longer empty) +
roadmap backdrop line bumped (PR 1 merged, PR 2 in review) + ACTIVE-WORK row updated on merge +
build-history entry in the merge's docs commit + main's uncommitted `projectStore.ts` unblock edit
discarded at merge time (`git checkout -- src/main/projectStore.ts` on main).
