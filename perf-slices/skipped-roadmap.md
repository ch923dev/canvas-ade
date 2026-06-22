# Roadmap reconciliation — skipped & partial

Per-CONFIRMED-item reconciliation against `docs/roadmap.md`, the **PA umbrella** (complete) and the
**Planning Board Optimization epic** (complete). Rule: fully covered → SKIP (annotate roadmap);
partial → KEEP + cross-ref; not covered → KEEP.

## Full SKIPs (covered by planned/shipped work)

**None.** Every CONFIRMED finding survives because the obvious wins already shipped and were
deliberately *not* re-flagged by the discovery agents. No confirmed item is fully addressed by
planned work, so nothing is dropped from the slice queue.

## Already shipped *by design* (not a regression — excluded from the queue)

| Candidate | Why it's not a slice |
|---|---|
| `osr-dirtyrect-disabled-at-supersample` | Dirty-rect crop is intentionally **S==1-only** per #159 (`7bffa2cc`: *"hardened to S==1-only … to avoid DIP/device coord-space mismatch at zoom"*). Not a bug. The *correct* re-enable (with proper coord mapping) is captured as **SLICE-005**, flagged risk-L. |

## PARTIAL — kept + cross-referenced

| Slice | Already-shipped overlap | Why still kept |
|---|---|---|
| **SLICE-002 / 005 / 006** (OSR frame pipeline) | **PA-7 (#196)** shipped PREV-02: *renderer-side* one shared frame/cursor IPC listener + rAF-coalesce, and PREV-01 full-view supersample. | PA-7 did **not** touch the **MAIN-side** cost: `emitFrame` still structured-clones (no transferable), `toBitmap` still allocates the full frame, and `osrPaintRect` still returns the whole frame at S>1. The ~492 MB/s–2 GB/s payload/alloc churn and ~58%-core swizzle are untouched. Cross-ref PA-7. |
| **SLICE-004** (planning per-drag snap cache) | The **planning-board-optimization research** (`docs/research/2026-06-15-planning-board-optimization/REPORT.md` §3b, finding R3) names a *"spatial bucket/grid index"* but explicitly **defers** it: *"Defer until the target element-count is known."* | The full spatial index (R3) stays deferred. SLICE-004 is the **cheap in-scope subset** (cache the unchanging static set across one drag's frames) that needs no element-count decision and no schema change. Cross-ref R3. |

## Context — why the queue is "deep cuts," not low-hanging fruit

The discovery agents were told the following are **already fixed on `main`** and must not be
re-flagged (they weren't — verified absent from the confirmed set). Recorded here so a reader knows
why the obvious items are missing:

- **PA umbrella (complete, `docs/reviews/2026-06-19-feature-audit.md`):** PERF-02/04/05/06/07,
  PERSIST-01 (drop `toObject` deep-clone), PERSIST-02 (memoize preview connectors + single-flight
  autosave), PREV-01/02, GROUP-07 (group-drag fingerprint selector), CANVAS-01 (per-frame digest
  re-render kill).
- **Planning Board Optimization epic (complete):** React.memo'd cards + dead `strokePaths` memo
  drop + lifted filters + live-read mutators (S1 #158); element registry + unified bbox/hit-test
  geometry (S3 #162); per-camera-frame planning re-render kill (PLAN-01, #200).

## Roadmap edits made (in place)

A **"Performance review (2026-06-23)"** block was added to `docs/roadmap.md` (under *Post-Phase-4 /
in flight*) pointing to this package and recording the two PARTIAL cross-refs above (OSR MAIN-side
payload; planning R3 deferral). No phase status was otherwise changed.
