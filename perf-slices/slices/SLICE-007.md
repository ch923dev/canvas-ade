# SLICE-007 — OsrNetworkPanel: memoize filter/sort pipeline

- **Dimension:** algorithmic complexity / hot loops; client render · **Severity:** med · **Effort:** S
- **Finding:** `osr-netpanel-unmemoized-pipeline`
- **Where:** `src/renderer/src/canvas/boards/osr/OsrNetworkPanel.tsx:108-118` (`applyNetFilter` +
  `waterfallWindow` + `summaryStats` + `sortRecords` inline in the render body); helpers in
  `src/renderer/src/lib/osrNetFormat.ts`.

## Baseline (measured, reproduced)

- All four passes run **unmemoized** in the render body. MAIN flushes a delta every `FLUSH_MS=100ms`
  while the panel is subscribed (`previewOsrNetwork.ts:28`); `osrNetworkStore.apply` mints a new
  `byBoard[id]` reference per delta → the panel re-renders **10×/s**.
- At the `MAX_RECORDS=1000` ring cap with a **Name sort** active, the pipeline measured **~13.2
  ms/render** (micro-bench, N=1000, exact pipeline) — dominated by `sortRecords`: `urlName()` calls
  `new URL()` **per row inside** the O(N log N) comparator (~4,464 `new URL()` per render). At 10
  renders/s = **~132 ms/s** of renderer main-thread CPU. (Initiator sort = 2.88 ms; numeric/no sort
  is negligible — the cost is sort-mode dependent, but filter/stats still re-run each render.)
- A decorate-sort-undecorate variant (`urlName` once per row) measured **1.10 ms vs 5.07 ms** naive
  = ~4.6× faster.

## Target

`useMemo` the filter → waterfall → summary → sort pipeline keyed on `(records, filter, sortKey,
sortDir)`; precompute `urlName` once per row (decorate-sort-undecorate) so the comparator does no
`new URL()`. **Target: <2 ms/render under Name sort (from ~13 ms); no recompute when unrelated state
changes.**

## Validation

1. Re-run the pipeline micro-bench with the memoized + decorated path → <2 ms/render at N=1000 Name
   sort.
2. Profiler: typing in an unrelated field / a no-op re-render does not recompute the pipeline.
3. Filtered/sorted/summary output identical for several filter+sort combinations.

## Invariant (must stay identical)

Filter results, sort order (all columns + directions), and summary stats are identical.

## Files touched

- `src/renderer/src/canvas/boards/osr/OsrNetworkPanel.tsx`.
- `src/renderer/src/lib/osrNetFormat.ts` (decorate helper, if added).

## Collisions

- **`OsrNetworkPanel.tsx` shared with SLICE-010** → sequence (007 then 010).
