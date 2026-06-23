# SLICE-006 — OSR: eliminate BGRA→RGBA main-thread swizzle

- **Dimension:** client render / hot loops; renderer-main-thread concurrency · **Severity:** med ·
  **Effort:** L
- **Finding:** `osr-bgra-fullframe-swizzle-cpu`
- **Where:** `src/renderer/src/canvas/boards/useOffscreenPreview.ts:75-104` (`applyFrame`) +
  `src/renderer/src/lib/bgraToRgba.ts:29-54`.

## Baseline (measured, reproduced)

- Every paint, the renderer swizzles BGRA→RGBA over the **whole** supersampled frame before
  `putImageData`. Micro-bench of the exact word-path swizzle on a 2560×1600 (15.63 MB) frame:
  **~4.52–4.80 ms/frame**; the per-byte fallback path (taken when the buffer view isn't 4-aligned /
  even-length) = **~8.19–8.34 ms/frame** (~1.7× worse).
- At 30 fps: **~138 ms/s per S=2 desktop board**; at `MAX_LIVE=4` = **~542 ms/s ≈ 54–58% of one
  core**, spent only swizzling, before `putImageData`.

## Target

Remove the main-thread swizzle. Options (pick by feasibility): (a) request the offscreen frame in
RGBA order so no swizzle is needed; (b) upload BGRA directly to a WebGL/`ImageBitmap` texture and let
the GPU handle the channel order; (c) `createImageBitmap` from the raw buffer. **Target: ~0
main-thread swizzle CPU (from ~58% of a core at 4 boards).** SLICE-005's dirty-rect crop reduces the
bytes swizzled per frame and compounds this win.

## Validation

1. Re-run the swizzle micro-bench against the new path → ~0 ms/frame main-thread (or moved to GPU/
   worker, measured).
2. Visual check: colors correct on a known image (no red/blue channel swap), no tearing, at S=1 and
   S=2.
3. `@preview` e2e green.

## Invariant (must stay identical)

Preview colors correct (channel order), no tearing, identical at all presets/supersamples.

## Files touched

- `src/renderer/src/canvas/boards/useOffscreenPreview.ts` (`applyFrame` blit path).
- `src/renderer/src/lib/bgraToRgba.ts` (remove/replace, or keep as S=1 fallback).

## Collisions

- **`useOffscreenPreview.ts` shared with SLICE-002 and SLICE-005** → Wave 2, after 002.
