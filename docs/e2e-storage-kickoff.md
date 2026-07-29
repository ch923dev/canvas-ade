# e2e storage kickoff — the trace-buffer slice

You are the dedicated lane agent for **e2e storage containment**. Work autonomously up to (not past) merge. This file is your brief.

## Mission

The e2e suite is filling the system drive. Not slowly — **measured at 50–100 GB/hour while the suite runs**, on a box whose C: has 12–18 GB free. The anchor of this lane is the trace payload declared in `e2e/fixtures.ts:75`; everything else in scope exists because that one call's backing buffers are never bounded and never guaranteed to be cleaned up.

This is not a disk-cleanup task. Deleting the artifacts is a 10-minute script and it buys about one hour. **The lane succeeds when a full matrix run has a bounded, measured, self-cleaning temp footprint** — and still produces the failure evidence the suite exists to produce.

**Proof (exit):** a full `pnpm test:e2e:matrix` run, measured start-to-finish, leaves ≤ 2 GB of residue in the temp root and holds a stated peak ceiling; a run killed mid-flight (Ctrl-C, crashed Electron, killed worker) leaves zero orphan directories; a failing spec still attaches a usable `trace.zip` + `failure.png` to the HTML report.

## The measured situation (do not re-derive — this was audited 2026-07-29)

- **1,383** `playwright-artifacts-*` / `playwright-tracing-*` directories in `%LOCALAPPDATA%\Temp`, totalling **110.31 GB** — 78% of everything reclaimable on the drive.
- Oldest survivor dated **2026-06-15**. Six weeks of accumulation, never swept.
- Growth watched live: **852 → 1,366 directories in 19 minutes**. C: free oscillated 16.70 → **8.22** → 18.79 GB across a single sampling window.
- The rest of the drive's top consumers for scale: Docker `docker_data.vhdx` 55 GB, `Onlysales.vhdx` 49 GB, Electron/canvas-ade e2e profiles 48 GB logical (**only 5.27 GB actually stale** — the rest are live).
- A 74.85 GB deletion elsewhere on the drive was fully reabsorbed by this suite inside an hour. That is the observation that promoted this from housekeeping to a lane.

## Read first (in order)

1. **`e2e/fixtures.ts` lines 70–79** — the anchor:
   ```ts
   await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
   ```
   This starts **one** recording on a **worker-scoped** context. With `workers:1` that context is alive for all 342 specs. Playwright buffers raw trace data — screenshots especially — into a temp directory for the entire lifetime of that context, not per chunk.
2. **`e2e/fixtures.ts` lines 103–114** — why the discard is not a reclaim. `stopChunk()` with no path (L112) drops the chunk *logically*. The backing temp dir keeps growing. Green runs are cheap in *report* size and expensive in *temp* size, and the comment at L26 ("on success the chunk is discarded so green runs stay cheap") is true about the report and misleading about the disk.
3. **`e2e/fixtures.ts` line 81** — `await app.close()`. The only cleanup path. It does not run on SIGINT, on a killed worker, or on an Electron crash. Every abnormal exit orphans that run's directories permanently. Six weeks of Ctrl-C is what 1,383 directories looks like.
4. **`e2e/fixtures.ts` line 19** — "it discards + relaunches the worker only after a test FAILS". Each relaunch allocates a fresh artifacts dir. **Failures multiply directories**, so the documented ambient flake set is also a disk amplifier.
5. `playwright.config.ts` — confirm before theorising: there is **no `use.trace` / `use.video` / `use.screenshot` block**. Config-level retention knobs are not in play; the fixture is the only lever. `workers: Number(process.env.E2E_WORKERS ?? 1)` — the push leg opts into 2, which doubles concurrent buffers.
6. `CLAUDE.md` › Conventions › the full-matrix rule (`pnpm test:e2e:matrix`, both legs, mandatory once per PR at the merge gate, ~30 min measured). Your changes must be proven against **that** run, not a single spec.

## Scope — IN

- **Measure before you change anything (MUST, gate on it).** Instrument a full matrix run for temp-root delta: peak bytes held, residue after clean exit, residue after `SIGINT` mid-run. Record it in the PR. Every claim below is a hypothesis until this baseline exists — including the headline one. Do not open with the fix.
- **Bound the trace payload.** The hypothesis: `screenshots: true` dominates the buffer, and dropping it to
  ```ts
  tracing.start({ screenshots: false, snapshots: true, sources: true })
  ```
  cuts the per-run footprint substantially while keeping the DOM timeline and sources that make a failure trace readable. **Prove the ratio with the harness above, and prove the evidence is still usable** — take a real failure, open its `trace.zip` in `show-report`, confirm you can still diagnose it. If the evidence degrades unacceptably, say so and fall back to scope item 3; do not ship a cheaper trace that nobody can debug with.
- **Guarantee teardown on abnormal exit.** `app.close()` on the happy path is not enough. Install `SIGINT`/`SIGTERM` handling (and Playwright's `globalTeardown`) so a killed run cleans its own directories. This is the item that stops permanent accumulation, and it is worth more than the payload reduction over a six-week window.
- **A pretest sweep with an explicit retention window.** Delete `playwright*` temp dirs older than N days at `pretest:e2e`. Note the pattern: `playwright-artifacts-*` alone is **not sufficient** — the suite also emits `playwright-tracing-*`, and an artifacts-only glob silently leaves half of it behind. Match `playwright*`.
- **Relocate the artifact temp root off the system drive.** `_electron.launch` already takes an `env` (fixtures.ts:53). Pointing the run's `TMPDIR`/`TEMP` at a non-system volume makes a runaway a nuisance rather than an outage. Decide whether this is a repo default or a documented local opt-in — a hardcoded absolute path in a committed file is wrong for CI and for other machines.
- **CI parity.** Whatever bound you set locally must hold on the Linux Docker leg (`Dockerfile.e2e`), where the reporter is already overridden. A fix that only works on the Windows leg is half a fix.
- Unit coverage on any sweep/retention helper — it is a pure function over paths and mtimes, so test it directly rather than through the suite.

## Scope — OUT (do not build)

- **Removing trace-on-failure.** The evidence pipeline is the point. `retain-on-failure` semantics stay; only the payload and its lifecycle are in scope.
- **Moving to config-level `use.trace`.** The hand-rolled per-test chunking in the `page` fixture is deliberate (it titles chunks per test and attaches selectively). Do not "simplify" it into `use.trace` — that is a different behaviour wearing the same name.
- **The rest of the C: audit.** Docker vhdx compaction, the 49 GB `Onlysales.vhdx`, `hiberfil.sys`, the Steam library, `C:\Mount`. Real, separately actionable, not this lane.
- **Reducing the flake set to reduce directory count.** Fewer failures would mean fewer relaunches, but chasing the documented ambient classes (`menuShell`, `terminalCrisp:155/:200`, `voiceCloud`, `gitDiff`/`dataFlow`) is its own lane and a trap for this one.
- **Lowering `E2E_WORKERS`.** Concurrency is a measured 39% speed win (config comment, 2026-07-28). Buying disk with wall-clock is a trade the user has already priced the other way; do not silently reverse it.

## Design notes

- **The buffer is per-context, not per-chunk.** Any fix framed as "discard the chunk sooner" misreads the mechanism. The lifetime that matters is `tracing.start` → context close, and with `workers:1` that is the whole run.
- **Two independent failure modes, two independent fixes.** *Volume* (payload per run) and *persistence* (orphans across runs) are separate. The payload reduction does nothing about six weeks of orphans; the teardown fix does nothing about a single run's peak. Ship both or state which you dropped and why.
- **Disclosure, per house rule.** If the sweep enforces a retention window, the run must say so — a silent deletion of a developer's trace from a debugging session two days ago is exactly the kind of surprise this codebase's disclosure convention exists to prevent.
- **`workers:2` doubles concurrent buffers.** Whatever ceiling you measure at 1, state the number at 2. The push leg runs at 2.

## Ritual + gotchas

- `M:/expanse` main dirs are shared across sessions — **verify branch before any commit; work in a git worktree**: `pwsh .claude/tools/new-worktree.ps1 -Name e2e-storage -Branch fix/e2e-storage`.
- **Version bump:** current is **0.39.1**; next free minor is **0.40.0** — VERIFY nothing else claimed it in `ACTIVE-WORK.md` / open PRs first.
- **This file is at repo root, which is MAIN.** Per `CLAUDE.md` › "Feature work lives on a worktree, not `main`", move it onto the lane branch as your first commit.
- **Manual dev check BEFORE `git push`** (title-stamped: `$env:CANVAS_DEV_TITLE='PR#NNN e2e-storage'; pnpm dev`). Push fires the e2e gate; wrong order is expensive. **Kill the dev instance before running the matrix.**
- **Full matrix at the merge gate, both legs, sequentially** (`pnpm test:e2e` then `pnpm test:e2e:linux` — parallel legs flake). Legs exceed the 10-min tool ceiling → run each in the background and push `--no-verify` with results attributed on the PR.
- **Check free disk before starting a matrix run.** Below ~20 GB the run can exhaust the drive mid-flight and produce failures that look exactly like real bugs. This lane, of all lanes, must not misattribute a full-disk failure to the code.
- **The matrix earns its keep — read its failures as real until proven ambient.** Rerun the failing spec isolated at `--retries=0`, check blast radius, baseline from clean `main` if unsure. Branch-fails + baseline-passes = regression, not flake.
- **Documented ambient classes on this box** (do not chase): units `pathSafe` (8.3-TEMP) + `pty.recapenv`; e2e `menuShell` / `projectSwitcher:96`, `terminalCrisp:155/:200`, `voiceCloud`, `gitDiff` / `dataFlow`.
- **Never `pnpm install` through the worktree node_modules junction** (it targets MAIN). If an install IS needed: kill dev electron instances first, use `printf 'y\n' | pnpm install`, then VERIFY `node_modules/@expanse-ade/mcp/package.json`.
- **Do NOT merge. Open PR(s), get green, report. Merge needs explicit user authorization.**

## Reporting

- `write_result` on YOUR board with `{status, summary, refs: [PR URL, branch, measurement artifact]}` at each milestone: baseline measured → payload decision made (with the ratio) → PR open + green → done.
- The baseline measurement is a deliverable in its own right. Attach it even if the lane stalls after it.
- Blocked > trivially: `write_result` status `blocked` with exactly what you need; keep the terminal alive.
