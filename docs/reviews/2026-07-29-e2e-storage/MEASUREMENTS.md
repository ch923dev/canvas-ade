# e2e storage containment — measurements (2026-07-29/30)

Lane `fix/e2e-storage`. All runs on the Windows dev box, full 344-spec suite, built
worktree at `e34274fa` (v0.39.1) unless noted. Sampler: `sample-temp.mjs` (node; 10s
interval over `%LOCALAPPDATA%\Temp\playwright*` — the pwsh variants died mid-run twice,
apparently collateral of specs that `taskkill` shell trees). Raw CSVs sit next to this
file.

## The backlog (pre-treatment state)

| Metric | Value |
|---|---|
| `playwright*` dirs in `%TEMP%` | **1,383** (799 `artifacts-*`, 581 `tracing-*`, 3 other) |
| Total size | **103.54 GB** (audit two days prior said 110.31 — churn between audits) |
| Oldest survivor | **2026-04-22** (worse than the kickoff's 2026-06-15 estimate) |
| C: free before → after sweep | 18.68 → **132.53 GB** |

Full listing: `pretreatment-temp-inventory.csv`. An `artifacts-*`-only glob would have
left 581 tracing dirs behind — the kickoff's `playwright*` warning is confirmed by data,
and a third family exists (`playwright-transform-cache`, a ~4.4 MB shared cache worth
KEEPING — it is bounded and reused, not per-run scratch).

## Baseline runs (screenshots:true, workers:1, retries:2)

| Run | Outcome | Wall | `%TEMP%` residue after |
|---|---|---|---|
| A | 341 passed / 3 skipped, exit 0 | 10.0m | **0.746 GB** / 3 dirs |
| A2 | 340 passed / 1 flaky / 3 skipped, exit 0 | 10.0m | **0.674 GB** / 5 dirs (597.6 MB + 87.7 MB artifacts) |
| B | hard-killed (`taskkill /T /F`) at spec 173/344 | — | **0.306 GB** / 3 dirs orphaned |

**The load-bearing finding: a fully GREEN run orphans its trace buffer EVERY time.**
`app.close()` is not the missing piece — Playwright's own temp cleanup races the worker
process's exit and loses. The kickoff's framing (orphans come from SIGINT/crash) is
incomplete: abnormal exits orphan a *partial* buffer, but normal exits orphan the *whole*
one. A2's two artifacts dirs also confirm the failure-multiplier: the one flaky test
discarded + relaunched the worker, minting a second buffer dir.

Buffer growth ≈ **60 MB/min** at workers:1 (sampler CSVs). A single run therefore holds
~0.6 GB peak — the audited "50–100 GB/hr" drain is NOT one run's rate; it is stacked +
repeated runs (push legs, retries, relaunch churn) on a 6-week never-swept graveyard.

## Payload experiment (screenshots:false, workers:1)

| Run | Outcome | Wall | Peak = residue |
|---|---|---|---|
| C | 341 passed / 3 skipped, exit 0 | 9.4m | **69.5 MB** (65.1 MB artifacts) |

**Ratio: ~620–674 MB → 69.5 MB ≈ 9×.** Tracing screenshots were ~89% of the buffer.

**Evidence usability (forced failure, screenshots:false):** trace.zip contains 8 DOM
frame-snapshots, all 4 actions (before/after pairs), input events, and the call-stack
`.stacks` sources; `failure.png` (renderer DOM) still attaches separately. Eyeballed in
`show-report` → trace viewer: action tree, live DOM snapshot render, Call/Log/Errors/
Console/Network/Source tabs all functional (`trace-viewer-noscreenshots-proof.png`).
Lost: the filmstrip thumbnails and canvas-bitmap contents — the latter was never in DOM
snapshots anyway; `failure.png` covers the visual. Verdict: **ships**.

## Fix verification (screenshots:false + tracesDir relocation + sweeps)

| Run | Config | Outcome | Wall | `%TEMP%` peak | `%TEMP%` residue |
|---|---|---|---|---|---|
| D | **workers:2** (push-leg config) | 338 passed / 3 flaky¹ / 3 skipped, exit 0 | 6.3m | **4.5 MB** | **0 dirs** (transform-cache only) |

¹ boardKeyboard:58 · terminal:62 · mcp:1288 — the documented workers:2 OS-contention
classes (playwright.config.ts comment), retries absorbed them.

With `tracesDir` relocated to `test-results/.pw-trace/w<N>`, `%TEMP%` carries only
kilobyte-scale launch scratch (downloads staging, client stacks). The payload
(~70 MB/run, bounded by run C's measurement) lives in the checkout on M:, is reclaimed
by `globalTeardown`, and would be wiped by Playwright's own `test-results` clean on the
next run even if teardown never fired. Forced-failure probe re-run under the full
machinery: trace.zip still exports from the relocated buffer, `.pw-trace` reclaimed,
`%TEMP%` delta zero.

**Hard-kill + retention demo (run E):** suite `taskkill /T /F`-killed at ~90s; orphaned
tmpdir crumbs backdated 8h (standing in for a dead run aged past the 6h window); next
run's `globalSetup` swept them with the disclosure line. Recorded below.

Run E, recorded: `taskkill /T /F` at ~90s stranded exactly 1 tmpdir crumb dir
(`playwright-artifacts-8edlSE`) + `test-results/.pw-trace` (teardown never ran — expected
for a hard kill). After backdating the crumb 8h, the next invocation (noteTint.e2e.ts,
3 passed) printed both disclosure lines and finished with `%TEMP%` = transform-cache only
and `.pw-trace` gone:

```
[e2e-temp] retention sweep: removed 1 playwright scratch dir(s) idle >6h in
  C:\Users\...\Temp: playwright-artifacts-8edlSE (E2E_KEEP_TMP=1 skips this)
[e2e-temp] run cleanup: removed 1 playwright scratch dir(s) this run created in ...
```

## Exit criteria vs measurements

| Criterion | Result |
|---|---|
| Full run ≤ 2 GB residue in temp root | **0 dirs / ~0 bytes** (+4.4 MB retained shared cache) |
| Stated peak ceiling | `%TEMP%` **4.5 MB** (workers:2); repo-side buffer **~70 MB**, auto-reclaimed |
| Killed run leaves zero orphans | Ctrl-C class: globalTeardown sweeps (Playwright runs teardown on interrupt). `/F`-kill class: ≤ ~5 MB crumbs + repo buffer, both reclaimed at the next invocation (setup sweep + Playwright's test-results wipe) — demo above |
| Failing spec still debuggable | trace.zip (DOM snapshots + actions + sources) + failure.png, viewer-verified |

## Decisions carried into the diff

- `screenshots:false` — 9× measured, evidence proven usable.
- `tracesDir` → per-checkout `test-results/.pw-trace/w<N>` — repo-relative (CI/Docker
  safe), off the system drive, per-worker at workers:2, sibling-checkout-safe reclaim.
  This SUPERSEDES the kickoff's TMPDIR/TEMP-env relocation idea: no absolute paths, no
  env plumbing, and reclaim becomes provably scoped to this checkout.
- Retention sweep at `globalSetup` (6h idle, `playwright*` minus `transform-cache`,
  disclosed per deletion, `E2E_KEEP_TMP=1` opt-out) — replaces the kickoff's
  `pretest:e2e` placement: same moment in the lifecycle, but it also runs for
  `--grep`/single-spec invocations that skip the pretest build, and it shares state
  (the pre-run snapshot) with `globalTeardown` in the same process.
- No extra SIGINT/SIGTERM handlers: Playwright already runs globalTeardown on
  interrupt; a second handler would race it. Hard kills are the setup sweep's job.
- Linux Docker leg: same code path runs in the container (tmpfs, discarded with the
  container) — parity is structural; verified green at the merge-gate matrix.
