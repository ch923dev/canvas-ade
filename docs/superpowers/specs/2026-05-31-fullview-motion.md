# Spec — Full-view enter/exit motion + §6.1 top band (Phase 4, Slice 5)

> Written 2026-05-31. The last Phase 4 slice. Grounds the implementation that closes the
> design pass. Read alongside the plan `docs/superpowers/plans/2026-05-31-phase-4-design-pass.md`
> and the progress handoff `docs/handoffs/2026-05-31-phase-4-progress-handoff.md`.

## Goal

Today `FullViewModal` mounts/unmounts **instantly** — no entry or exit motion — and has **no
§6.1 top band**. This slice adds:

1. **Enter/exit motion** (DESIGN §9 / §6.1): scrim opacity-fade + frame `scale(.98)→1` + opacity,
   `200ms cubic-bezier(.2,.7,.2,1)`, reversed on close. Gated by `prefers-reduced-motion` → instant.
2. **§6.1 top band**: a header row atop the frame — `FULL VIEW` label (left) + `✕ Esc` exit
   button (right). A 4th close path; the board keeps its own titlebar/maximize (additive).

## The hard constraint (why this was deferred)

A Browser board's native `WebContentsView` is an OS compositor layer — it **cannot be CSS-animated,
clipped, or rounded** (ADR 0002). The full-view native rect binds to the portaled `.bb-frame` DOM
rect via `BrowserPreviewLayer.fullViewBoundsFor` (a per-frame rAF). A CSS `scale()` on
`.fullview-frame` **pollutes** that `getBoundingClientRect()` → the native view would lag/distort
for the 200ms tween.

**Decision (owner-confirmed): hold-then-snap.** While the frame is mid-transform (enter OR exit),
the full-view board's native view is **held detached**; it attaches at the final bounds once motion
settles. Terminal / Planning boards are pure HTML and scale smoothly with the frame.

## Design decisions (owner-confirmed)

- **Frame motion:** `scale(.98→1)` + opacity, `transform-origin: center`, 200ms standard curve.
- **Native view during tween:** held detached, snaps in at settle (not "let it follow").
- **§6.1 band:** add it. `FULL VIEW` + `✕ Esc`. Keep the board's own titlebar maximize too.

## Mechanism

### Canvas state machine (`Canvas.tsx`)
`fullViewId` stays the source of truth for relocation; it **must not clear until the exit fade
completes**, or the board relocates back to canvas mid-fade and tears the session. Two motion flags:

- `fullViewEntering` — true from open until the enter tween settles.
- `fullViewClosing` — true from a close request until the exit tween settles.
- `fullViewMotion = fullViewEntering || fullViewClosing` — passed to `BrowserPreviewLayer` to gate
  the native-view hold.

Transitions:
- **open** (`openFullView(id)`): `entering=true`, `closing=false`, `fullViewId=id`.
- **enter settled** (`onEntered` from modal): `entering=false` → native attaches.
- **close request** (`closeFullView`: Esc / scrim / band ✕ / ⤢ toggle): `closing=true`, **keep id**.
- **exit settled** (`onExited` from modal): `fullViewId=null`, both flags false → board relocates
  back, canvas views reattach.
- **hard close** (duplicate / delete / pushPreview): clear id + flags instantly (board is gone/changed
  — no exit anim).

`requestFullView(id)` toggles: open if a different/no board, else `closeFullView`.

### FullViewModal (`FullViewModal.tsx`)
- Props: `closing`, `onClose`, `onEntered`, `onExited`, `onHost`.
- Mounts with the closed state; flips an `open` flag on the next animation frame so the CSS
  transition runs from the closed values. Fires `onEntered` after `CAMERA_MS` (reduced-motion → 0).
- When `closing` flips true, removes `open` (exit tween) and fires `onExited` after `CAMERA_MS`.
- Renders the §6.1 band as the first child of `.fullview-frame`, above `.fullview-host`.
- Timers (`setTimeout CAMERA_MS`) drive the lifecycle callbacks — not `transitionend`, which is
  unreliable under reduced-motion (no event fires) and across multiple animated properties.

### CSS (`index.css`)
- `.fullview-scrim { opacity:0; transition: opacity 200ms <ease> }` → `[data-open]` opacity 1.
- `.fullview-frame { opacity:0; transform: scale(.98); transform-origin:center; transition }` →
  `[data-open] .fullview-frame` opacity 1 / scale 1.
- `.fullview-band` / `.fullview-label` / `.fullview-close` — token-styled header row (~36px).
- Reduced-motion block gains `.fullview-scrim, .fullview-frame { transition: none !important }`.

### BrowserPreviewLayer (`BrowserPreviewLayer.tsx`)
- New `fullViewMotion` prop → `fullViewMotionRef`, set + re-run `applyLiveness` in the focus effect.
- `applyLiveness` full-view branch: while motion, **close** the full-view board's view (don't
  attach); attach only when motion is false.
- Full-view rAF tick: skip the held-attach + flush while motion is true.

## e2e (`e2eSmoke.ts`)

The e2e `setFullView` hook sets `fullViewId` raw (bypasses the motion flags) → existing parts
(`terminal-fullview`, `fullview-preview`, `fullview-emulator`) keep their **instant** behavior and
stay green. The band shrinks the host → re-verify `fullview-emulator` geometry tolerances hold
(device stays height-bound + centered; ratios are scale/height invariant).

New part **`fullview-band`**: open full view, assert `.fullview-band` exists with a `FULL VIEW`
label + a `.fullview-close` button; click `.fullview-close` and assert the modal animates closed and
unmounts (`.fullview-scrim` gone) — exercising the band + the real close→exit→unmount state machine.

## Verify
`pnpm lint ; pnpm typecheck ; pnpm test` clean. Then `pnpm build` +
`$env:CANVAS_SMOKE='e2e'; pnpm start` → `terminal-fullview`, `fullview-preview`,
`fullview-emulator`, `fullview-band` green (browser-trio env-flake excepted; rerun for clean 19/19).
