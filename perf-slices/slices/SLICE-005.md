# SLICE-005 — OSR: dirty-rect crop at supersample>1

- **Dimension:** memory (per-frame alloc) / payload size · **Severity:** med · **Effort:** L (risk)
- **Finding:** the alloc/crop half of `mip-osr-tobitmap-per-frame-main`
- **Where:** `src/main/previewOsr.ts:224-231` (`osrPaintRect` returns the WHOLE frame when
  `e.superSample>1`) + `:517-531` (paint → `patch.toBitmap()`).

## Baseline (measured, reproduced)

- At S>1, `osrPaintRect` returns the whole frame, so **every** paint allocates a fresh full-frame
  BGRA Buffer via `patch.toBitmap()` (16.4 MB at S=2 desktop) regardless of how small the actual
  damage is (a 1-px caret blink still ships 16.4 MB).
- At 30 fps one desktop board = **~492 MB/s** of short-lived Buffer alloc in MAIN; `MAX_LIVE=4` worst
  case ≈ **2 GB/s** of GC churn. `toBitmap` alloc+copy measured ~3.56 ms/desktop frame.

## ⚠️ Why this is risk-L (read before implementing)

Dirty-rect crop at S>1 was **intentionally disabled** in #159 (`7bffa2cc`): *"honor dirtyRect …
hardened to S==1-only (osrPaintRect) to avoid any DIP/device coord-space mismatch at zoom."* The
`dirtyRect` arrives in **DIP**; at S>1 the frame is in **device px**. This slice must correctly map
`dirtyRect` → device-px crop (multiply by S, clamp to bounds, handle fractional S from
`deviceFitScale × settledZoom × DPR`) and partial-blit on the renderer. Get the coord mapping wrong
and you reintroduce the smear/tear #159 fixed. (Listed separately in `unconfirmed.md` as
`osr-dirtyrect-disabled-at-supersample` = "shipped by design"; this slice is the *correct* re-enable,
not a regression claim.)

## Target

Crop each paint to its (S-scaled) dirty rect; `toBitmap` only the damaged sub-rect; renderer blits
the sub-rect at the right offset. **Target: small paints (caret/scroll/cursor) drop from 16.4 MB to
≈ KB; full-repaint frames unchanged.** Pairs with SLICE-002 (transferable) to cut both alloc and
copy. Best landed **after** SLICE-002.

## Validation

1. Caret-blink-only page: per-frame `toBitmap` bytes ≈ the caret rect, not 16.4 MB; MAIN alloc rate
   for that page drops ~100×.
2. Full-page animation: behaves as today (full frames).
3. Pixel-diff a scroll + a partial-update page at S=2 against current build — **no smear/tear**
   (the #159 regression class). `@preview` e2e green.

## Invariant (must stay identical)

Pixel-identical output at S=1 and S>1 across scroll, animation, caret, and full repaint; supersample
crispness preserved; no stale regions left from a too-small crop.

## Files touched

- `src/main/previewOsr.ts` (`osrPaintRect` S>1 branch, paint handler, `emitFrame` rect metadata).
- `src/renderer/src/canvas/boards/useOffscreenPreview.ts` (partial blit at offset) — coordinate with
  SLICE-002/006 which also touch this file.

## Collisions

- **`previewOsr.ts` + `useOffscreenPreview.ts` shared with SLICE-002 and SLICE-006** → Wave 2, after
  002.
