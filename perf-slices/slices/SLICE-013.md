# SLICE-013 — Cold-start: lazy-load FileTree side panel

- **Dimension:** cold-start / client bundle · **Severity:** low · **Effort:** S
- **Finding:** `cs-filetree-arborist-eager-in-index`
- **Where:** `src/renderer/src/canvas/SidePanel.tsx:17` (`import { FileTree } from './FileTree'`) →
  `FileTree.tsx:28` (`react-arborist` → `react-window`); mounted in the eager shell at
  `AppChrome.tsx:83`.

## Baseline (measured, reproduced)

- `<SidePanel/>` is in the eager Canvas shell and **statically** imports `FileTree`, pulling
  `react-arborist` + `react-window` into the **cold-start `index` chunk** (built-chunk markers
  confirmed: `FixedSizeList`, `RowContainer`, `useSimpleTree`, `react-window`).
- Measured weight: the FileTree library trio minified (React external) = **129,713 B / 33,746 B
  gzipped** ≈ **~11% of the gzipped cold-start entry** (`index` = 305,364 B gzip). The side panel is
  collapsible and **need not be open at boot**, so this is eager cold-start cost for an off-first-paint
  feature. (Modest — the original ~1.6 MB claim was the unpacked source, not shipped bytes.)

## Target

`React.lazy` the `SidePanel`/`FileTree` so the arborist/window trio leaves the cold-start chunk and
loads on first panel open. **Target: ~34 KB gzip off the `index` entry chunk; a separate FileTree
chunk fetched on demand.**

## Validation

1. `pnpm build`; confirm `react-window`/arborist markers are **gone** from `index-*.js` and present
   in a new lazy chunk.
2. `gzip -c out/renderer/assets/index-*.js | wc -c` drops ~30 KB.
3. Open the file-tree panel at runtime — it loads and works identically (one-time chunk fetch).

## Invariant (must stay identical)

File tree behavior identical once opened; no regression in panel open/collapse; no first-paint
flash.

## Files touched

- `src/renderer/src/canvas/SidePanel.tsx` and/or `AppChrome.tsx` (lazy boundary + Suspense fallback).

## Collisions

- None (isolated). Parallel-safe in Wave 1.
