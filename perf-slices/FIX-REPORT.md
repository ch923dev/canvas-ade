# Fix Run Report — Wave 1

Generated: 2026-06-23 · Package: `perf-slices/` · Repo: `Z:\Canvas ADE` · Branch: `perf/fixes-wave1`
(off `perf/slices-2026-06-23`; base = `main`@`8e11155c` — rebase onto `origin/main` `a1f33a7c` is
conflict-free, all slice files disjoint from PR #217, do before merge)

| Outcome | Count |
|---------|-------|
| Fixed (automated target verified) | 4 — SLICE-001, 004, 007, 013 |
| Needs review (impl + gate green; runtime metric needs live app) | 3 — SLICE-003, 011, 012 |
| Blocked | 0 |
| Deferred to next pass | 6 — SLICE-002, 005, 006, 008, 009, 010 |

**Verification done centrally (no merge to `main`):** `pnpm typecheck` (node+preload+web) ✓ ·
`pnpm lint` on all changed files ✓ (0 errors) · `pnpm build` ✓ · unit suites `osrNetFormat` 83/83,
`snapping`+`elements` 69/69 ✓ · production-build gzip measurement for the bundle slices.
**Not done (by construction — needs the live Electron app / your manual dev check):** runtime render
counts, per-frame allocation/CPU deltas, OSR/memory behavior, highlight spot-checks. Per CLAUDE.md
every PR needs a title-stamped manual dev check + e2e matrix + bot review before merge — none of these
are merged.

**Wave plan executed:** Wave 1 (file-disjoint, parallel) — 001 · 003 · 004 · 007 · 011 · 012 · 013.
(002 + Wave 2 [005/006/008/009/010] deferred — see end.)

**One commit per slice on `perf/fixes-wave1`:**
`dfcda3cf`(001) · `93c5886a`(003) · `d71a0da7`(007) · `2dd318e2`(011) · `94a405ea`(012) ·
`c7c4ff90`(004) · `519d51f1`(013), on top of `65b4295e` (the perf-slices package).

> ⚠️ **Concurrent-session incident (resolved, no data lost):** mid-run an external actor checked out
> `fix/gitdiff-gaps` in this shared working dir (producing untracked `gitdiff-audit/`), which briefly
> diverted two of my commits onto that branch. Recovered: 004/013 cherry-picked back onto
> `perf/fixes-wave1`; `fix/gitdiff-gaps` restored to `a1f33a7c`; `gitdiff-audit/` (untracked)
> preserved. See the run summary in the chat.

---

### SLICE-001: FileBoard — drop unreachable CodeMirror grammars — FIXED
- **Commit:** `dfcda3cf` · **Wave 1** · **Collision group:** fileBoardSyntax (with 008)
- **Files changed:** `src/renderer/src/canvas/boards/fileBoardSyntax.ts`
- **Fix summary:** Replaced the `@uiw/codemirror-extensions-langs` barrel + runtime `loadLanguage(name)`
  name-indexing with explicit static imports of only the ~17 `@codemirror/lang-*` packages reachable
  from `LANG_BY_EXT`, behind a static `LANG_FACTORY` map (verbatim copies of the barrel's factory
  calls/options). Bundler now drops the entire `@codemirror/legacy-modes` pack + unmapped grammars.
- **Verification:** `pnpm build` → FileBoard chunk **2,602,396 → 1,735,849 B raw; 708 → 486 KB gzip
  (−222 KB, −31%)**. `grep` for legacy grammars (brainfuck/cobol/fortran/verilog/smalltalk) in the
  emitted chunk = **0** (was many). typecheck + lint green.
- **Notes:** The reachable modern lang-* packs are themselves large (JS/TS/cpp/php/html/vue/sql/md
  Lezer grammars), so the win is −31% gzip, not the optimistic ~75% — still a real cut on first
  File-board open. Highlight parity for mapped exts is reasoned-equivalent (verbatim mapping) +
  type-safe; a live spot-check (ts/py/sql/vue/scss/md fences) is the remaining manual check.
  **Follow-up:** declare the 17 `@codemirror/lang-*` as direct `package.json` deps (currently resolve
  via `node-linker=hoisted`).

### SLICE-004: Planning — per-drag static snap cache — FIXED
- **Commit:** `c7c4ff90` · **Wave 1** · **Collision group:** none
- **Files changed:** `planning/snapping.ts`, `planning/usePlanningPointer.ts`
- **Fix summary:** `precomputeStatics()` builds the non-moving neighbour bboxes+anchors once at drag
  start; `computeSnap` accepts `BBox[] | StaticSnap[]` (raw path kept for back-compat) and reads
  cached `s.anchors` instead of recomputing per frame. Cache lives on the move-drag record, rebuilt
  defensively if the element set changes mid-gesture, torn down on pointer-up.
- **Verification:** `snapping.test.ts` + `elements.test.ts` **69/69** (invariant: identical guides +
  snapped positions via the unchanged raw-BBox path). typecheck + lint green.
- **Notes:** The per-frame CPU/alloc delta (144 µs/908 allocs → <20 µs/~0 @300 elts) needs a live/
  bench confirm — invariant is unit-proven, perf is the pending manual check.

### SLICE-007: OsrNetworkPanel — memoize pipeline + decorate-sort — FIXED
- **Commit:** `d71a0da7` · **Wave 1** · **Collision group:** OsrNetworkPanel (with 010)
- **Files changed:** `osr/OsrNetworkPanel.tsx`, `lib/osrNetFormat.ts`
- **Fix summary:** Wrapped filter→waterfall→summary→sort in one `useMemo` keyed on
  (records, typeKeys, filter, regex, invert, sort), hoisted above the early return (hook-order safe);
  converted `sortRecords` to decorate-sort-undecorate so `urlName()`→`new URL()` runs once/row, not
  per comparison.
- **Verification:** `osrNetFormat.test.ts` **83/83** (identical sort order/filter/summary). typecheck
  + lint green.
- **Notes:** The ~13 ms→<2 ms/render win + no-recompute-on-idle relies on the store returning a stable
  `records` ref on empty flushes (confirmed in `osrNetworkStore`); profiler confirm pending.

### SLICE-013: Cold-start — lazy-load FileTree side panel — FIXED
- **Commit:** `519d51f1` · **Wave 1** · **Collision group:** none (SidePanel only; AppChrome left
  untouched — Suspense kept self-contained in the panel)
- **Files changed:** `src/renderer/src/canvas/SidePanel.tsx`
- **Fix summary:** `React.lazy(() => import('./FileTree'))` adapted for the named forwardRef export;
  a guarded render-time `revealedOnce` latch (React's "adjust state from prior renders" pattern — the
  agent's original setState-in-effect tripped the repo's react-hooks rule and was rewritten) mounts
  the chunk on first panel reveal, then keeps it mounted; Suspense fallback inside the panel chrome.
- **Verification:** `pnpm build` → cold-start `index` chunk **1,361,679 → 1,102,729 B raw; 305 → 255
  KB gzip (−50 KB)**; new on-demand `FileTree` chunk = 258,618 B raw / 50,647 gzip. typecheck + lint
  green (incl. the react-hooks fix).
- **Notes:** Live check: confirm the panel opens/works on first reveal with the one-time chunk fetch.

### SLICE-003: CommandBoard — derived-fingerprint subscription — NEEDS-REVIEW
- **Commit:** `93c5886a` · **Wave 1** · **Collision group:** none
- **Files changed:** `src/renderer/src/canvas/boards/CommandBoard.tsx`
- **Fix summary:** Replaced `useCanvasStore((s)=>s.boards)` with a derived primitive `poolKey`
  fingerprint (id~type~terminal-monitorActivity, position omitted; GROUP-07 pattern); `pool` memo reads
  `getState().boards` keyed on `[poolKey, running]`. Position-only drag frames no longer re-render the
  subtree.
- **Verification:** typecheck + lint green (2 pre-existing STYLE-02 token-drift warnings in the file,
  unrelated, warn-only).
- **Notes / blockers:** The ~60 re-renders/s→0 during drag needs React DevTools Profiler in the live
  app — automated gate can't confirm the render-count delta.

### SLICE-011: Planning — incremental pen-draft tessellation — NEEDS-REVIEW
- **Commit:** `2dd318e2` · **Wave 1** · **Collision group:** none
- **Files changed:** `planning/WhiteboardSvg.tsx`, `lib/pen.ts`
- **Fix summary:** Added O(N) `draftPolyline()` (raw `M/L` centerline) in `pen.ts`; the in-progress
  draft now renders a constant-width stroked centerline (size = `STROKE_OPTIONS.size`, thinning=0 so
  it reads faithfully) instead of re-running `getStroke` over the whole growing list each frame. The
  committed stroke path (pointer-up → full `getStroke`) is unchanged.
- **Verification:** typecheck + lint green.
- **Notes / blockers:** Committed-stroke identity is by construction (commit path untouched); the draft
  is a hair simpler in shape mid-gesture (acceptable per the invariant). The O(N²)→O(N) per-frame win
  + visual acceptability of the draft need a live draw test.

### SLICE-012: Terminal — cap xterm scrollback 5000→2000 — NEEDS-REVIEW
- **Commit:** `94a405ea` · **Wave 1** · **Collision group:** none
- **Files changed:** `src/renderer/src/canvas/boards/terminal/useTerminalSpawn.ts`
- **Fix summary:** Lowered the default `scrollback` from 5000 to 2000 (one-line default change +
  rationale comment) to cut resident xterm buffer ~60% per terminal.
- **Verification:** typecheck + lint green.
- **Notes / blockers:** **UX decision** — 2000 vs 5000 is a product call; confirm the shorter history
  is acceptable. Memory delta (~137 MB→~55 MB @20 terminals) needs an in-app `arrayBuffers` probe.

---

## Deferred to the next pass (not attempted in Wave 1)

| Slice | Why deferred |
|---|---|
| **SLICE-002** (OSR transferable IPC) | HIGH-value but HIGH-risk (use-after-transfer can break the whole preview); needs live verification — do with the app running, not blind. |
| **SLICE-005** (OSR dirty-rect crop @S>1) | Wave 2; risk-L (the coord-space mapping that #159 disabled); depends on `previewOsr.ts` (002's file). |
| **SLICE-006** (OSR swizzle) | Wave 2; depends on `useOffscreenPreview.ts` (002's file). |
| **SLICE-008** (FileBoard snapshot off-thread) | Wave 2; shares `fileBoardSyntax.ts` with 001 (now landed) — rebase then implement. |
| **SLICE-009** (markdown debounce) | Wave 2; shares `FileBoard.tsx` with 008. |
| **SLICE-010** (NetPanel virtualize) | Wave 2; shares `OsrNetworkPanel.tsx` with 007 (now landed). |
