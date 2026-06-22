# Canvas ADE — Performance Slices (ROI-ranked wave queue)

> **Review date:** 2026-06-23 · **Base:** `main` (post PA umbrella + Planning epic, both complete)
> **Method:** measurement-grounded perf review — 8 file-zone discovery agents → 1 adversarial
> verifier per candidate (re-derive complexity / re-measure bytes / re-count allocs / micro-bench)
> → roadmap reconciliation → slicing. **43 candidates → 15 CONFIRMED → 13 slices** (3 confirmed
> findings share one root cause). 27 candidates killed as not-material; 1 already shipped by design.
> Raw findings: `.canvas/tmp/perf-findings.json`. Unconfirmed: `unconfirmed.md`. Reconciliation:
> `skipped-roadmap.md`.
>
> **No code was changed.** This is a measure-and-plan package, consumable as-is by
> `parallel-fix-runner` (this file = INDEX, `slices/` = cards).

## ⚠️ Measurement caveat — the `out/` build is UNMINIFIED

Raw chunk byte figures (e.g. FileBoard 2.6 MB, index 1.36 MB) come from an **unminified**
`electron-vite build` artifact (`pretest:e2e` output). `esbuild --minify` roughly halves raw JS.
**Therefore all bundle targets below are stated in gzip** (whitespace-independent) and in terms of
*unreachable code removed*, not raw bytes. Minification is a separate, orthogonal win
(`cs-index-chunk-unsplit-eager` in `unconfirmed.md`) and is intentionally NOT a slice here.

## Reconciliation summary

The obvious wins were already shipped, which is why this list is "deep cuts," not low-hanging fruit:
- **PA umbrella (complete):** PERF-02/04/05/06/07, PERSIST-01/02, PREV-01/02, GROUP-07, CANVAS-01.
- **Planning epic (complete):** React.memo cards (#158), unified geometry (#162), per-frame
  re-render kills (#200).
- **White space (excluded from PA, hunted hardest here):** File Tree, File Board, Command Board.

No CONFIRMED finding is *fully* covered by planned work → **0 full SKIPs**. Two are **PARTIAL**
(kept + cross-referenced): OSR frame pipeline (PA-7 fixed renderer-side coalesce only; MAIN-side
payload/alloc untouched) and Planning snap (the R3 spatial index is *deferred* in the
planning-board-optimization research). See `skipped-roadmap.md`.

## Execution status (Wave 1 run — 2026-06-23) — see `FIX-REPORT.md`

Branch `perf/fixes-wave1` (off `perf/slices-2026-06-23`). **Not merged** (per CLAUDE.md: each needs a
manual dev check + e2e + bot review). One commit per slice; full `typecheck`+`lint`+`build` green.

| Slice | Status | Automated verification |
|---|---|---|
| 001 | ✅ fixed | FileBoard chunk 708→**486 KB gzip** (−31%); 0 legacy grammars; build+tc+lint |
| 003 | 🔶 needs-review | tc+lint green; render-count delta needs live profiler |
| 004 | ✅ fixed | `snapping`/`elements` 69/69 (invariant); tc+lint; per-frame perf pending bench |
| 007 | ✅ fixed | `osrNetFormat` 83/83 (sort/filter invariant); tc+lint; render perf pending profiler |
| 011 | 🔶 needs-review | tc+lint green; O(N²)→O(N) draft + visual accept need live draw |
| 012 | 🔶 needs-review | tc+lint green; **UX call** (2000 vs 5000) + memory probe pending |
| 013 | ✅ fixed | cold-start index 305→**255 KB gzip** (−50); FileTree → 51 KB on-demand chunk |
| 009 | 🔶 needs-review | **Wave 2** (branch `perf/fixes-wave2`); `useDeferredValue` defers markdown/snapshot reparse; tc+lint; live typing-latency check pending |
| 005 | ✅ fixed | **Wave 2 live OSR session** — empirical probe proved the paint dirtyRect is device-px (== image) at S=2 → crop now applies at S>1. previewOsr 38/38 unit + **live e2e 7/7** (new `osrCropSupersample` guard + paint/screenshot/hover-S2/idle regression). Partial paints at S>1 now ship the damage rect (e.g. 478×35) instead of the full 16.4 MB frame. |
| 006 | ✅ fixed | **Wave 2 live OSR session** — BGRA→RGBA swizzle moved off the main thread into a round-trip worker (`osrBlitWorker`); frame buffers transfer zero-copy, `putImageData` stays on the main-thread 2D canvas (so `osrCanvasNonBlank`/clear/evict are unchanged), gen-guard drops stale post-clear frames. `bgraToRgba` now worker-only (structural off-main proof) + 7/7 unit; **live e2e 10/10** (paint/partial-typing/reconnect-clear/screenshot/hover-S2/idle/crop). Worker loads under `script-src 'self'`. |
| 002 | ⏳ ROI-reduced (live app) | **SLICE-005 + 006 shrank its surface:** partial paints now ship tiny cropped regions (005) and the swizzle is off-main (006), so the remaining main→renderer IPC *copy* matters **only for full-repaint-heavy previews** (video/animation). Lower priority; needs a MessagePort/transferable transport rewrite + `pnpm dev` verify. |
| 008 | ✅ fixed | **Wave 2** — the snapshot Lezer highlight no longer blocks the frame on file open. A worker was rejected (the LRParser isn't structured-cloneable + re-importing the grammars would duplicate every CM grammar into a 2nd chunk, undoing SLICE-001); instead Lezer's INCREMENTAL parser is driven in `PARSE_SLICE_MS=8` batches that yield via a MessageChannel ping. Small files (≤30 KB) stay synchronous (flash-free); large files render plaintext immediately, then swap in the highlight. New `useFileSnapshotHtml` hook (keeps FileBoard under the max-lines gate). `fileBoardSyntax` unit (7/7) pins the async output **byte-identical** to `buildSnapshotHtml`; **live e2e 14/14** (`file.e2e` + a new large-file async-highlight guard). FileBoard chunk unchanged (1.74 MB → no worker dup). **Surfaced + fixed a latent SLICE-013 regression:** the lazy FileTree no longer mounts while collapsed, so 8 tree e2e probes (file + fileTree specs) now reveal the panel first via a new `revealSidePanel()` seam (separate `fix(filetree)` commit). |
| 010 | ⏳ needs live app | 010 = OsrNetworkPanel table virtualization (the `wfWin` prop defeats a plain memo). Needs a `pnpm dev` session to implement+verify responsibly. |

## ROI-ranked queue

| # | Slice | Dim | Baseline → Target | Effort | Sev | Files | Collides-with |
|---|---|---|---|---|---|---|---|
| **001** | FileBoard: drop unreachable CodeMirror grammars | bundle | ~708 KB gzip chunk (~100 of 103 grammars unreachable) → ~150–200 KB gzip | M | med | `fileBoardSyntax.ts` | 008 (same file) |
| **002** | OSR: transferable ArrayBuffer for frame IPC | I/O payload | ~492 MB/s copied main→renderer per S=2 board (×≤4); ~3.5–4.65 ms/frame structured-clone → zero-copy | M | **high** | `previewOsr.ts`, `useOffscreenPreview.ts` | 005, 006 |
| **003** | CommandBoard: derived-fingerprint subscription | render fan-out | ~60 full-subtree re-renders/s during *any* board drag → 0 | S | med | `CommandBoard.tsx` | — |
| **004** | Planning: per-drag static snap cache | hot loop / allocs | 144 µs + ~908 allocs per pointermove frame @300 elts → <20 µs, ~0 allocs | M | med | `usePlanningPointer.ts`, `snapping.ts` | — |
| **005** | OSR: dirty-rect crop at supersample>1 | per-frame alloc / payload | full 16.4 MB frame every paint @S=2 (≤2 GB/s alloc @4 boards) → crop to damage (caret blink ≈ KB) | L | med | `previewOsr.ts` | 002 (seq) |
| **006** | OSR: eliminate BGRA→RGBA main-thread swizzle | hot loop | ~4.8 ms/frame; ~58% of a core @4 boards → ~0 main-thread | L | med | `useOffscreenPreview.ts`, `bgraToRgba.ts` | 002 (seq) |
| **007** | OsrNetworkPanel: memoize filter/sort pipeline | hot loop | ~13 ms/render (Name sort) ×10/s → <2 ms/render | S | med | `OsrNetworkPanel.tsx`, `osrNetFormat.ts` | 010 (same file) |
| **008** | FileBoard: snapshot highlight off main thread | blocking | 64–197 ms sync Lezer parse on file open (200 KB) → <16 ms long-task | L | med | `fileBoardSyntax.ts`, `FileBoard.tsx` | 001, 009 (seq) |
| **009** | FileBoard: debounce markdown re-parse | hot loop | ~2.5 ms full re-parse *per keystroke* (Split mode) → on idle | S | med | `FileBoard.tsx` | 008 (seq) |
| **010** | OsrNetworkPanel: virtualize the request table | scalability cliff | ~10,000 React elements reconciled per 100 ms delta → viewport-bounded | M | med | `OsrNetworkPanel.tsx` | 007 (seq) |
| **011** | Planning: incremental pen-draft tessellation | O(N²) | ~135 ms recompute over an 800-pt stroke → O(N), bounded/frame | M | low | `WhiteboardSvg.tsx`, `pen.ts` | — |
| **012** | Terminal: cap xterm scrollback memory | memory | ~137 MB arrayBuffers @20 full terminals, never released on LOD → <55 MB | S | low | `useTerminalSpawn.ts` | — |
| **013** | Cold-start: lazy-load FileTree side panel | cold-start | ~34 KB gzip (react-arborist/window, ~11% of entry) eager though panel is collapsed → lazy | S | low | `SidePanel.tsx`, `AppChrome.tsx` | — |

## Wave plan (file-disjoint = parallelizable)

- **Wave 1 (8-way parallel — lead of each lane):** `001 · 002 · 003 · 004 · 007 · 011 · 012 · 013`
  (all touch disjoint files). Land the top-ROI four first (001, 002, 003, 004).
- **Wave 2 (after each lane's Wave-1 predecessor):** `005` (after 002, `previewOsr.ts`) · `006`
  (after 002, `useOffscreenPreview.ts`) · `008` (after 001, `fileBoardSyntax.ts`) · `010` (after 007,
  `OsrNetworkPanel.tsx`). These four are mutually file-disjoint → parallel.
- **Wave 3:** `009` (after 008, `FileBoard.tsx`).

## Estimated total gain (at the stated real-input workloads)

- **Heavy live preview (4 Browser boards @ S=2, 30 fps):** ~1+ CPU core reclaimed (002 MAIN copy
  ~0.5 core + 006 swizzle ~0.58 core) and ~2 GB/s of short-lived GC churn removed (005); small
  paints (caret/scroll) drop from 16.4 MB/frame to ≈KB (005).
- **First File-board open:** ~500 KB gzip less to fetch/parse (001) + the open-time main-thread
  block falls from 64–197 ms to <16 ms (008); markdown typing 2.5 ms/keystroke → ~0 (009).
- **Planning drag @300 elements:** ~17 ms/s main-thread + ~108k allocs/s removed (004); long pen
  strokes no longer hit ~135 ms recompute (011).
- **Any board drag with a Command board present:** 60 wasted full-subtree re-renders/s → 0 (003).
- **Network inspector (chatty SPA, Name sort):** ~13 ms/render → <2 ms (007); ~10k elements/delta →
  viewport (010).
- **Memory:** ~80 MB saved at 20 open terminals (012); ~34 KB gzip off cold-start entry (013).
