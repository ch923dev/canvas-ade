# SLICE-010 — OsrNetworkPanel: virtualize the request table

- **Dimension:** client render; scalability cliff · **Severity:** med · **Effort:** M
- **Finding:** `osr-netpanel-unvirtualized-table`
- **Where:** `src/renderer/src/canvas/boards/osr/OsrNetworkPanel.tsx:341-349` (`sortedRows.map →
  <Row/>`) + `:529-596` (`Row`, not `React.memo`'d).

## Baseline (measured, reproduced)

- `sortedRows.map` renders one `<Row>` (a `<tr>` with 7 cells incl. a per-row waterfall bar) for
  **every** filtered record, no windowing/virtualization, `Row` not memoized.
- At `MAX_RECORDS=1000` the store updates every `FLUSH_MS=100ms` (10×/s), so **~10,000 React
  elements are allocated/reconciled per delta** (1000 rows × ~10 `createElement`). Micro-bench of the
  exact render body: **3.46 ms/render unsorted, 23.3 ms/render Name-sorted** — and that's the JS floor
  *before* React's reconcile/diff/commit of 10,000 unmemoized elements.
- Bounded (renderer ring caps at 1000) so not unbounded, but the **full 1000-row DOM tree re-renders
  per delta**. The panel is in the lazy `BrowserBoard` chunk, so this is render-perf, not bundle.

## Target

Windowed/virtualized rows (only render the viewport — `react-window` is already a dependency) +
`React.memo` on `Row`. **Target: rendered `<tr>` count bounded to the viewport (~30–60); per-delta
reconcile cost <5 ms at 1000 records.** Compounds with SLICE-007 (memoized pipeline).

## Validation

1. Inspect the DOM: at 1000 records only ~viewport rows exist as `<tr>`.
2. Profiler: per-delta commit <5 ms at the 1000-record cap on a chatty page.
3. Scroll reveals all records; sort/filter still correct; waterfall bars align.

## Invariant (must stay identical)

All records reachable by scrolling; sort/filter/summary correctness unchanged; column layout +
waterfall bars visually identical.

## Files touched

- `src/renderer/src/canvas/boards/osr/OsrNetworkPanel.tsx`.

## Collisions

- **`OsrNetworkPanel.tsx` shared with SLICE-007** → Wave 2, after 007.
