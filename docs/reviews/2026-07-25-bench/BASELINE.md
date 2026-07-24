# Bench baseline — 2026-07-25

Committed artifact: [`BASELINE.json`](BASELINE.json) (machine-readable; this file is the reading of it).
Produced by `pnpm bench:baseline`. Phase 0 gate artifact for the
[project-switch & perf audit](../2026-07-25-project-switch-perf-audit/AUDIT.md).

**8/8 configurations captured, `complete: true`.**

## Conditions — read these before comparing anything

```
AMD Ryzen 7 5800X · 8 cores / 16 threads · 31.9 GB RAM, 10.1 GB free
NVIDIA RTX 4060 · 2560×1440 @ 164 Hz  (p50 is vsync-quantized: 6.1 ms = 1 frame, 12.1 = 2, 18.3 = 3, 24.3 = 4)
Windows 11 10.0.26200 · Balanced power plan · Node v22.17.0
CPU load at rest, sampled immediately before the run: 49.2%
Contending: 37 × Code · 24 × msedgewebview2 · 22 × node · 9 × pwsh · Docker Desktop
```

**This is a loaded machine and the numbers say so.** `bench:baseline` warns above 25% and records the
state either way. That is a direct consequence of the investigation in
[`../2026-07-25-bench-baseline/BASELINE.md`](../2026-07-25-bench-baseline/BASELINE.md): the
2026-06-25 reference recorded fps without conditions, became unreproducible on identical source and
identical dependencies, and cost a full elimination pass to close out. A number without its
conditions is an anecdote.

How much this matters, measured across three runs of the same build within twenty minutes:

| CPU at rest | switch total @ 0 boards |
|---|---|
| ~30% (dedicated run) | 86.2 ms |
| 36.9% | 120.1 ms |
| 49.2% (this capture) | 101.2 ms |

Same code, ±40%. Compare against this baseline only at comparable load.

---

## Project-switch latency — the first ever measured

Median across 5 switches per configuration, warm-up discarded; `(min–max)` in parentheses.
Segments defined in `src/renderer/src/store/switchMetrics.ts`. Planning boards, no live terminals or
previews.

| boards | **total** | **arm** (dead air) | load | paint | mainOpen |
|---|---|---|---|---|---|
| 0 | **101.2** (74.1–135.5) | 49.3 (31.7–93.0) | 34.3 (26.3–48.6) | 11.1 (8.2–16.5) | 12.5 (10.8–13.8) |
| 8 | **123.7** (96.8–190.0) | 46.6 (37.0–106.0) | 38.6 (32.7–51.9) | 35.2 (27.1–40.5) | 11.5 (10.6–14.4) |
| 24 | **136.4** (130.4–215.8) | 41.0 (37.6–121.3) | 48.7 (44.0–50.3) | 46.5 (45.1–48.9) | 14.9 (12.0–15.6) |

`arm` = gesture → transition overlay armed · `load` = armed → project applied · `paint` = applied →
first painted frame · `total` = start → painted, minus any dialog time · `mainOpen` = MAIN's
`project:open` handler, which sits inside `load`.

### 1. PS-1's "~800 ms dead air" is not reproduced here — it measures 41–49 ms

The audit's single most user-visible defect was stated as ~800 ms before any visual feedback. It was
never measured; it was inferred by summing two 400 ms **budgets** — `SNAPSHOT_FETCH_BUDGET_MS` and
the thumbnail capture. Both are `Promise.race` **timeouts**, and a timeout only elapses when the work
behind it is slow.

Measured `arm` is **41–49 ms median**, with a tail to 121 ms.

**This does not refute R3, and the audit has been updated to say so rather than to close it.** The
measured configuration has no live terminals, no Browser boards and no assets — precisely the
conditions under which `captureProjectThumb` and the snapshot fetch would get slow enough for their
budgets to bite. R3 is **unproven**, not disproven, and the honest next step is to re-measure with
live resources before committing its 1.5 days.

What the data *does* say: `arm` is still the **largest single segment** at 0 boards (49 of 101 ms),
so R3's direction is right even at this magnitude — it is the difference between a ~100 ms switch and
a ~55 ms one, not between 800 ms and 100 ms.

### 2. `arm` does not scale with board count. `paint` scales hardest.

| segment | 0 → 24 boards | reading |
|---|---|---|
| `arm` | 49.3 → 41.0 | **flat** (the drift is inside the noise band) — thumbnail + snapshot cost is not board-sensitive here |
| `load` | 34.3 → 48.7 | +42% |
| `paint` | 11.1 → 46.5 | **4.2×** — the steepest per-board cost in the pipeline |
| `mainOpen` | 12.5 → 14.9 | **flat** |

`paint` is React mount plus the first painted frame. That is P-1/P-5 territory — the root-level
re-render fan-out — and it is now the one Phase 2 item with a number behind it. **This finding was
not anticipated by the audit.**

### 3. MAIN's `project:open` is flat at ~12 ms — R11 loses its justification

R11 (1 d) targeted DL-1 (`readBak` + `gcAssets` on the open path) and DL-2 (N × `existsSync` in
`rehydrateMissingSummaries`). The entire handler containing both costs **11.5–14.9 ms and does not
grow from 0 to 24 boards**. Neither cost is hot, and neither scales in the measured range.

Caveat that keeps this honest: the sweep varies *board* count, and DL-1's `gcAssets` scales with
*assets*, which these synthetic projects have none of. Audit Appendix A found a real project with 44
assets / 3.58 MB. **De-prioritize R11 pending an asset-bearing measurement** — do not delete it.

### 4. Against the NN/g limits

Every configuration lands in the 0.1–1 s band: perceptible, but well inside "flow of thought
uninterrupted". Nothing approaches the 1 s boundary. **Even an empty-canvas switch costs ~101 ms**,
so there is a fixed floor of roughly 100 ms that no amount of per-board optimization will move —
worth knowing before anyone spends days on the per-board side.

---

## Terminal load — all visible

| N | fitZoom | phase | fps | p50 | p95 | max | jank>33 ms |
|---|---|---|---|---|---|---|---|
| 1 | 1.000 | static | 155.3 | 6.1 | 6.5 | 17.8 | 0% |
| 1 | 1.000 | pan | 115.8 | 6.1 | 12.3 | 30.3 | 0% |
| 1 | 1.000 | zoom | 116.6 | 6.1 | 12.3 | 24.3 | 0% |
| 4 | 0.880 | static | 83.2 | 12.1 | 18.3 | 30.3 | 0% |
| 4 | 0.880 | pan | 106.7 | 6.2 | 18.1 | 30.3 | 0% |
| 4 | 0.880 | zoom | 123.2 | 6.1 | 12.2 | 30.3 | 0% |
| 8 | 0.571 | static | 47.4 | 18.3 | 30.4 | 54.4 | 4.7% |
| 8 | 0.571 | pan | 58.7 | 18.1 | 30.2 | 60.7 | 2.6% |
| 8 | 0.571 | zoom | 136.2 | 6.1 | 12.2 | 24.3 | 0% |

`zoom ≥ pan ≥ static` still holds at every N — the 2026-06-25 finding that camera motion is never the
bottleneck survives. The N=4 static row (83.2 fps, p50 12.1) is the one that triggered the regression
hunt; it is **closed as not a product regression** (see the linked write-up).

## Terminal liveness gating — off-screen streamers

| config | phase | fps | p50 | p95 |
|---|---|---|---|---|
| N=8, K=2 visible (6 gated) | static | 118.8 | 6.1 | 12.2 |
| N=8, K=2 visible | pan | 134.2 | 6.1 | 12.2 |
| N=8, K=2 visible | zoom | 114.0 | 6.1 | 12.3 |
| N=8, K=1 visible (7 gated) | static | 149.6 | 6.1 | 12.1 |
| N=8, K=1 visible | pan | 138.7 | 6.1 | 12.2 |
| N=8, K=1 visible | zoom | 137.1 | 6.1 | 12.2 |

Held bytes on gated streams (PTY alive, nothing rendered) — K=2: 2.41 MB across 6; K=1: 2.71 MB
across 7.

**The Lane A property holds.** K=1 visible runs at 149.6 fps static with 7 streamers behind it,
tracking the N=1 all-visible number (155.3) — off-screen cost is ~0. Held bytes are recorded
alongside fps deliberately: a gated stream that quietly stopped *holding* would still look fast on
fps alone, so the baseline needs both to detect that regression.

---

## Harness defects fixed to get here

The terminal bench could not produce a baseline at all, for two separate reasons.

1. **Mount is not streaming** (fixed in PR #385). `assertStreaming` sampled buffer growth once over a
   blind 1.5 s window after `terminalMounted`, but between mount and the first PTY byte sit the
   `pty:spawn` IPC, a possible ptyHost daemon cold start, the shell's boot, and `STREAM_CMD` being
   parsed. Failures were monotonic in warm-up. Fixed by polling for the precondition.

2. **Bounded scrollback defeats length-growth** (fixed here). Polling for *length* growth then failed
   at the opposite end of a long run: `terminal 1/1 never streamed (buffer never grew past 82436)` —
   a terminal that had emitted 82 KB and was streaming perfectly. xterm's scrollback is bounded, so
   once saturated, old lines trim as fast as new ones arrive and length plateaus permanently. Length
   is a liveness signal only while the buffer is still filling, which a sustained-streaming bench is
   guaranteed to outgrow. Fixed by comparing a content fingerprint (length + last 256 chars, computed
   in-page so each poll ships a short string, not 80 KB).

The full suite went from 7 passed / 1 failed to **8 passed**, and got faster (3.6 min → 1.9 min).

## Reproducing

```
pnpm bench:baseline              # build + all benches + machine state -> BASELINE.json
pnpm bench:baseline -- --no-build   # reuse the existing out/
pnpm bench                       # human-readable tables only, no artifact
```

Do not run concurrently with `pack:dir` or an e2e matrix — they share `out/`.
