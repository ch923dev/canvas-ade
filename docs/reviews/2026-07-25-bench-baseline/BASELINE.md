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

**Mixed, and the N=4 row is the one that was chased.** Its p50 moved 6.1 → 12.1 ms — in vsync terms,
from hitting every frame to every other frame. That is a discrete step, not drift. Meanwhile N=8
pan/zoom improved, so this is not a uniform slowdown. It was chased to ground and is **not a product
regression** — see the elimination table below.

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

> **Superseded — see *NOT A PRODUCT REGRESSION* below.** The reasoning in this subsection was the
> working hypothesis before the two elimination runs; it is kept because it is what motivated them, not
> because it holds. Direct measurement beat it.

The delta is present at N=4 and absent at N=1, so it is **not** a global per-frame overhead — it is work
that scales with board count. That read pointed at per-terminal *code* (P-2's forced layouts, P-1's
re-render fan-out, P-3's per-chunk JSON encode). All three were subsequently ruled out as the cause by
running the old source and the old lockfile directly. Load that scales with board count fits the same
shape, and that is what it turned out to be.

Wrinkle the code hypothesis never explained, and contention does: N=8 pan/zoom *improved* over the
reference while N=4 degraded.

### `fitZoom` ruled out

`git log --follow e2e/terminalLoad.bench.ts` shows exactly one prior commit — `78088bbc` (#259), which
created the file. `PINNED`, `CELL_W`, `CELL_H` and `PHASE_MS` were introduced there and never changed.
The harness inputs are byte-identical to those that produced the reference, so N=4 ran at fitZoom 0.880
in both. Not a confounder.

## NOT A PRODUCT REGRESSION — the reference is not reproducible from the repo

Three successive eliminations, each a direct measurement rather than an inference. **All negative.**

| # | Build | N=4 static | Verdict |
|---|---|---|---|
| — | Reference 2026-06-25 (`REPORT.md:110-138`) | 116–133 fps, p50 **6.1 ms** | the number being chased |
| 1 | Current main `2bdc517e` + current deps | 78.9 fps, p50 12.1 ms | — |
| 2 | App `78088bbc` + **current** deps | 75.6 fps, p50 12.1 ms | **app source exonerated** |
| 3 | App `78088bbc` + **its own lockfile** (`pnpm install --frozen-lockfile`, standalone clone) | **82.5 fps, p50 12.1 ms** | **dependencies exonerated** |

Run 3 is the controlling one: the *exact* source and the *exact* dependency tree that produced
116–133 fps in June measure 82.5 fps today. Confirmed genuinely different deps — the bundled chunk is
`xterm-Zq1Gu-mt.js` **414.71 kB** (xterm **5.5.0**, verified in `node_modules`) versus
`xterm-R4LLEgbX.js` 411.70 kB (xterm 6.x) for runs 1–2. Electron is **42.3.3 in both trees**, so the
runtime is identical too.

**`@xterm/xterm` 5.5 → 6.x was the prime suspect and is REFUTED.** So are `@xyflow/react`, the React 19
patches, and Vite 7 codegen — the whole old lockfile was installed, not just xterm.

Source, dependencies and Electron are therefore all eliminated. **Nothing in the repository explains the
delta**, so a bisect over the 365 intervening commits would have found nothing (and, run in a worktree,
could not have: `node_modules` is a junction to MAIN's, so every step would have used current deps).

### What actually explains it: measurement contention

The only remaining variable is the machine, and it is not quiet:

```
8 cores / 16 threads · 31.9 GB RAM, 8.8 GB free · Balanced power plan
CPU load at rest: 76%
37 × Code · 24 × node · 10 × pwsh · Docker Desktop · 7 × chrome
```

This fits the observed shape precisely. N=4 spawns four full-tilt `pwsh` streamers plus main-process
encode plus the renderer. At **N=1 that fits in the remaining headroom and matches the reference within
noise** (153.7–160 vs ~163 fps, p50 6.1 ms in both). At N=4 it does not, and the frame slips from one
vsync interval to two. A per-terminal *code* cost would have shown up in runs 2 and 3; contention is
what is left, and it is load-dependent exactly where the delta appears.

Not proven — proving it needs a re-run on a quiet machine, which means closing the user's editor and
Docker. But it is the only surviving candidate, and the N=1 control agreeing with the reference while
N=4 disagrees is hard to explain any other way.

Two earlier conclusions in this document were wrong and are superseded: P-2 was ranked best-fit from the
N-scaling shape (superseded by run 2), and run 2 was then read as proving a dependency cause (superseded
by run 3).

### Consequences

1. **The 2026-06-25 numbers are not a valid regression target** and should not be chased further. They
   were captured under unrecorded machine conditions that no longer hold.
2. **The tables above become the reference** for this machine — but only as long as the load is
   comparable.
3. **R2 must record machine state with the numbers** (core count, CPU load at rest, refresh rate, notable
   running processes). A bench number without its conditions is what produced this entire investigation.
   This extends R2's scope in `docs/reviews/2026-07-25-project-switch-perf-audit/AUDIT.md`.
4. **P-1 / P-2 / P-3 remain valid findings on their own merits.** They simply did not cause this delta.

## Reproducing

```
CANVAS_E2E=1 pnpm build
pnpm exec playwright test --config playwright.bench.config.ts
```

Do not run this concurrently with `pack:dir` or an e2e matrix — they share `out/`.
