# Terminal load bench — baseline

**Captured:** 2026-07-25 · **Base commit:** `2bdc517e` (main, v0.32.0) + the readiness-gate fix on `fix/bench-readiness-gate` (v0.32.1)
**Machine:** dev box, Windows 11, ~165 Hz display (p50 values are vsync-quantized: 6.1 ms ≈ 1 frame, 12.1 ≈ 2, 24.3 ≈ 4)
**Build:** `CANVAS_E2E=1 pnpm build` (the bench needs the `window.__canvasE2E` hooks)
**Run:** `pnpm exec playwright test --config playwright.bench.config.ts` — **5/5 passed in 1.6 min**

> Initial capture was one run per configuration. **N=1 and N=4 were then repeated 3× each** (see
> *Repeat runs* below) — N=1 serves as the control. N=8 and the gating configs remain single-run.

## Why this run exists

The harness could not previously produce a baseline at all. `assertStreaming` sampled terminal buffer
growth once over a fixed 1.5 s window immediately after `terminalMounted`, but mount is not streaming —
between mount and the first PTY byte sit the `pty:spawn` IPC, a possible ptyHost daemon cold start, the
shell's boot, and `STREAM_CMD` being written as the first PTY line. The failures were monotonic in
warm-up across a run:

| Test (run order) | Duration | Streaming | Outcome |
|---|---|---|---|
| N=1 | 4.6 s | 0/1 | ✗ failed before `measurePhase` |
| N=4 | 2.9 s | 0/4 | ✗ failed, then worker teardown timed out (240 s) |
| N=8 | 12.7 s | 7/8 | ✗ |
| K=2 gating | 9.8 s | 1/2 | ✗ |
| K=1 gating | 17.9 s | 1/1 | ✓ |

No fps was ever recorded for the four failures — they died at the precondition. The fix polls per
terminal for real buffer growth (`STREAM_WARMUP_MS = 45_000`) instead of assuming it. Only the slowest
terminal pays the wait; the measured phases are unchanged, so numbers stay comparable to earlier reports.

## All-visible load

| N | fitZoom | phase | fps | p50 | p95 | p99 | max | jank>33ms | jank>50ms |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1.000 | static | 153.7 | 6.1 ms | 12.0 ms | 12.3 ms | 30.4 ms | 0% | 0% |
| 1 | 1.000 | pan | 150.1 | 6.1 | 12.1 | 12.3 | 24.2 | 0% | 0% |
| 1 | 1.000 | zoom | 140.2 | 6.1 | 12.2 | 12.4 | 18.8 | 0% | 0% |
| 4 | 0.880 | static | 81.5 | 12.1 | 18.2 | 24.3 | 36.4 | 0.3% | 0% |
| 4 | 0.880 | pan | 90.6 | 12.1 | 18.2 | 24.2 | 30.3 | 0% | 0% |
| 4 | 0.880 | zoom | 88.1 | 12.1 | 18.2 | 18.3 | 30.4 | 0% | 0% |
| 8 | 0.571 | static | 40.1 | 24.3 | 30.4 | 48.3 | 48.4 | 3.7% | 0% |
| 8 | 0.571 | pan | 63.6 | 12.1 | 30.4 | 42.5 | 133.2 | 2.7% | 0.8% |
| 8 | 0.571 | zoom | 88.2 | 12.1 | 18.2 | 18.3 | 24.4 | 0% | 0% |

## Liveness gating (off-screen streamers)

| Config | phase | fps | p50 | p95 | p99 | max | jank>33ms |
|---|---|---|---|---|---|---|---|
| N=8, K=2 visible (6 gated) | static | 116.6 | 6.1 ms | 12.2 ms | 18.2 ms | 24.3 ms | 0% |
| N=8, K=2 visible | pan | 117.4 | 6.1 | 12.2 | 18.2 | 24.2 | 0% |
| N=8, K=2 visible | zoom | 109.7 | 6.2 | 12.3 | 18.2 | 24.2 | 0% |
| N=8, K=1 visible (7 gated) | static | 155.5 | 6.1 | 6.3 | 12.2 | 18.3 | 0% |
| N=8, K=1 visible | pan | 132.2 | 6.1 | 12.2 | 12.4 | 18.3 | 0% |
| N=8, K=1 visible | zoom | 124.3 | 6.1 | 12.2 | 12.4 | 36.4 | 0.2% |

Held bytes on gated (PTY alive, not rendered) streams — K=2: `[43564, 165698, 495473, 50515, 155842, 456542]`
(1.37 MB across 6). K=1: `[220482, 214648, 227614, 228357, 129775, 211541, 210424]` (1.44 MB across 7).

**Gating still works as designed.** K=1 visible at 155.5 fps static tracks the N=1 all-visible number
(153.7) while 7 streamers run behind it — the off-screen cost is ~0, which is the property Lane A exists
to hold.

## Delta vs the 2026-06-25 reference

Reference: `docs/research/2026-06-25-terminal-dom-renderer/REPORT.md:110-138`.

| Config | 2026-06-25 | 2026-07-25 | Δ |
|---|---|---|---|
| N=1 static | ~163 fps, p50 6.1 | 153.7, p50 6.1 | −6% |
| N=4 static | 116–133 fps, p50 6.1 | **81.5, p50 12.1** | **−30…−39%, p50 doubled** |
| N=4 zoom | 144–160 fps | **88.1** | **−39…−45%** |
| N=8 static | 45 fps, p50 24 | 40.1, p50 24.3 | −11% |
| N=8 pan | 55 fps | 63.6 | **+16%** |
| N=8 zoom | 65 fps | 88.2 | **+36%** |
| Gating, K=2 | 133.9 fps | 116.6 | −13% |

**Mixed, and the N=4 row is the one to chase.** Its p50 moved 6.1 → 12.1 ms — in vsync terms, from
hitting every frame to every other frame. That is a discrete step, not drift. Meanwhile N=8 pan/zoom
improved, so this is not a uniform slowdown.

## Repeat runs — N=4 regression CONFIRMED, N=1 clean

`pnpm exec playwright test --config playwright.bench.config.ts --grep "N=(1|4) streaming terminals" --repeat-each=3`
— 6/6 passed in 1.9 min. N=1 is the control: if it drifted too, the N=4 delta would be machine noise.

**N=1 (control), fps:**

| run | static | pan | zoom |
|---|---|---|---|
| 1 | 160.4 | 134.5 | 135.8 |
| 2 | 160.0 | 135.3 | 130.1 |
| 3 | 159.9 | 137.6 | 136.7 |

Static spread is **0.5 fps across three runs (0.3%)** — the machine was quiet and the harness is stable.
Against the reference's ~163 fps, **N=1 has not regressed.**

**N=4, fps (including the initial capture):**

| run | static | pan | zoom |
|---|---|---|---|
| baseline | 81.5 | 90.6 | 88.1 |
| 1 | 81.4 | 89.1 | 88.7 |
| 2 | 74.8 | 83.3 | 79.6 |
| 3 | 77.7 | 84.7 | 84.7 |
| **mean** | **78.9** | 86.9 | 85.3 |

Four of four runs land in 74.8–81.5 static, never approaching the reference's 116–133. **p50 was 12.1 ms
in every run — never 6.1.** Verdict: **real regression at N=4, −32…−41% static and −40…−50% zoom.**

### What the shape implies

The regression is present at N=4 and absent at N=1, so it is **not** a global per-frame overhead — it is
per-terminal work that scales with board count. Candidates, ranked, cross-referenced to
`docs/reviews/2026-07-25-project-switch-perf-audit/AUDIT.md`:

1. **P-2** — `useTerminalLiveness.ts:54,116` and `useOffscreenLiveness.ts:55,125` each perform a
   `getBoundingClientRect()` forced layout plus an O(boards) loop on *every* `boards` reference change.
   Effectively free at N=1; grows with N. Best fit.
2. **P-1** — `App` re-renders 14 unmemoized children on every store mutation (`App.tsx:124-179` +
   `useMcpPublish.ts:25`); mutation rate scales with the number of live terminals.
3. **P-3** — the PTY wire JSON-encodes per chunk with no daemon-side batching
   (`daemonMain.ts:82-84,184-188`); N streams multiply that main-process cost.

Unexplained wrinkle: N=8 pan/zoom *improved* over the reference while N=4 degraded. N=8 runs at
fitZoom 0.571 vs N=4's 0.880 — the lower zoom likely masks the same cost behind cheaper glyph raster.

### Remaining confounder

The reference does not state its per-row `fitZoom`. Ours is pinned at 0.880 across all four N=4 runs, so
it is not run-to-run variance — but if the reference sampled N=4 at a different fit zoom, some of the
delta is not like-for-like. Checkable in the harness's git history before any bisect.

**Next:** confirm the reference `fitZoom`, then bisect N=4 static across the range since 2026-06-25.
The recorded `zoom ≥ pan ≥ static` finding (camera motion is never the bottleneck; cost is the
write/DOM-mutation path) argues for starting at P-2 and the ptyHost daemon merge.

## Reproducing

```
CANVAS_E2E=1 pnpm build
pnpm exec playwright test --config playwright.bench.config.ts
```

Do not run this concurrently with `pack:dir` or an e2e matrix — they share `out/`.
