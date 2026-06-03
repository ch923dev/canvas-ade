# Testing T5 — re-enable the e2e CI gate · design

**Date:** 2026-06-03 · **Branch:** `testing-strategy` (single branch for the whole initiative; PR #37) · **Status:** design, pre-plan
**Parent:** `docs/superpowers/specs/2026-06-03-testing-strategy-design.md` §T5
**Sibling:** `docs/superpowers/specs/2026-06-03-testing-t4-playwright-design.md` (the harness this gates)
**Research backing:** `docs/research/2026-06-03-testing-strategy.md` (§7 hard surfaces) · `docs/research/self-smoke-testing.md`

---

## Goal

Finish the testing-strategy initiative (T0–T5). Turn the brittle, **frozen** e2e into a **trusted,
stable, green CI gate** that runs the T4 Playwright `_electron` suite on a **Windows + Linux matrix**,
add cross-platform **process-tree-kill** coverage, and **defer auto-update** e2e to Phase 5.

**The unique T5 risk: the proof is in CI, not local.** Every prior phase was provable on the Windows
dev machine. T5's deliverable is a *trusted green gate on GitHub runners* — so the exit bar is a
green run **watched on the actual runner** (`gh run watch` / `gh run view --log-failed`) and proven
**stable across ≥2–3 runs**, not merely passing once. A flaky gate is worse than no gate — flakiness
is exactly why e2e was frozen (CLAUDE.md › Status, 2026-06-03).

### In scope
- Rewrite the **stale** `smoke` job in `pr.yml` **and** `staging.yml` → run `pnpm test:e2e`
  (Playwright), as a **Windows + Linux matrix**; remove `if: false`.
- A **flake policy** that keeps the gate trusted (bounded CI retries for documented env flakes).
- **Process-tree-kill**: extract + unit-test the kill-command builder (both platforms), add ONE
  real-spawn-and-reap e2e that runs on **both** legs (Windows `taskkill`, Linux negative-pgid).
- **Prove stable** on the runner; lift the e2e freeze; ready PR #37 to merge.

### Out of scope (explicit)
- **Auto-update e2e — DEFERRED to Phase 5.** electron-updater / packaging / signing do not exist yet
  (installers unsigned, no updater wired). The auto-update flow *cannot* be e2e-tested before
  packaging lands. It is the **one** remaining e2e-only surface; tracked as a TODO, does NOT block T5.
- `production.yml` (release-publish, packaging-only) — left untouched; it has no `smoke` job today and
  release builds should not be gated on a multi-minute e2e launch.
- **No new branch** (commit on `testing-strategy`; push updates PR #37). **No new runtime deps** (CI
  infra steps like `xvfb` are fine). **No security weakening** (see locked constraint).

---

## 🔒 Locked security constraint (carried from T4)

The app's `webPreferences` — `contextIsolation:true` / `sandbox:true` / `nodeIntegration:false` — is
**never** weakened to make a test pass. The Playwright harness is **MAIN-process-helpers only**.

Linux-CI nuance (resolved in T5a, below): the *Chromium-process* sandbox on a headless runner is a
**launch-time** concern, distinct from the app's `webPreferences.sandbox`. The preferred path keeps
the SUID `chrome-sandbox` helper. **Only if** the T5a spike proves Electron cannot launch under it on
`ubuntu-latest` do we pass `--no-sandbox` to the **test launch** — CI-gated (`process.env.CI`),
test-only, and it does **not** touch `webPreferences`. This is documented as a tradeoff, not a silent
flip, and is a last resort after xvfb is in place.

---

## Decisions (from brainstorming, 2026-06-03)

| Decision | Choice | Why |
|---|---|---|
| CI-blank-capture de-risk | **Spike first, then decide GL** | Empirically verify `capturePage` on the real runners before committing the full gate (brief's "resolve this FIRST"). Add a software-GL flag only if a leg returns blank. |
| Flake policy | **Bounded CI retries: `process.env.CI ? 2 : 0`** | Per-test retries cost nothing on a deterministic suite; bounded retries are acceptable for a **documented env flake** (browser-trio / whiteboard-fullview-add are PROVEN GPU-contention flakes, not bugs — memory `e2e-browser-trio-flake`). Prefer fixing determinism where cheap; retries cover the irreducible contention. `workers:1` stays. |
| Process-tree-kill real test tier | **Playwright e2e spec** (+ pure arg-builder unit, both platforms) | The e2e exercises the **real** app `deleteBoard→park→killTree` path on the real OS; a node-only test would prove only the kill primitive, not the wiring. |
| Gate scope | **`pr.yml` + `staging.yml`** | pr.yml = PR gate; staging.yml = push-to-main (CLAUDE.md sequential-merge "rerun full gate + e2e after each merge"). production.yml untouched. |
| Runner matrix | **`windows-latest` + `ubuntu-latest`**, `fail-fast: false` | Linux leg proves the *nix negative-pgid kill path for real (vs unit-only) and broadens native-surface coverage. The fragile part (headless display) is bounded by the T5a spike. |
| Auto-update | **Deferred to Phase 5** | No packaging/updater exists; cannot be tested. The one remaining e2e-only surface. |

---

## Architecture — five sub-phases

All land on `testing-strategy` / PR #37. Each leaves CI green (the `check` gate is unchanged
throughout; the `smoke` gate is only flipped on in T5c after the spike proves it viable).

### T5a — CI spike (de-risk `capturePage` + Linux launch FIRST)

A **throwaway** minimal `smoke` job (matrix Win + Linux) that runs the existing T4 suite, pushed to
PR #37 and **watched on the runner**. It answers the make-or-break empirical questions *before* the
real gate is committed:

- **Windows:** does `mainWindow`-external per-view `capturePage` return a **non-blank** frame for the
  `browser` / `fullview` / `menu` probes on `windows-latest`'s interactive desktop session?
- **Linux:** does Electron **launch at all** under `xvfb-run` on headless `ubuntu-latest`? Does the
  Chromium sandbox need handling? Does `capturePage` come back non-blank? Is a GL flag required?

Outcomes feed the launch-arg + workflow decisions:
- Non-blank without a flag → no GL flag on that leg.
- Blank → add `--use-gl=swiftshader` / `--use-angle=swiftshader` to the e2e Electron launch args,
  **CI-gated** (`process.env.CI`), in `e2e/fixtures.ts`; re-spike to confirm.
- Linux launch failure under the SUID sandbox → add `--no-sandbox` to the **test launch only**
  (CI-gated), document the tradeoff; otherwise keep the SUID helper.

The spike job is **deleted** once its questions are answered (it is not the final gate — T5c is). T5a
produces no production code beyond possibly the CI-gated launch args, which carry forward.

### T5b — process-tree-kill (unit + e2e)

**Finding:** `killTree` in `src/main/pty.ts` is a **private** function and its command construction is
**NOT** unit-tested — `pty.test.ts` injects a *mocked* `killTree` into the lifecycle cores. So the
actual `taskkill /PID <pid> /T /F` argv (Windows) and `kill(-pid, SIGKILL)` negative-pgid (POSIX) are
unverified. T5b closes that, then proves the real reap end-to-end.

1. **Extract a pure builder.** Pull the platform branch out of `killTree` into an exported pure
   function — `killTreeCommand(platform: NodeJS.Platform, pid: number)` — returning a discriminated
   result: `{ kind: 'taskkill', file: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] }` on
   `win32`, `{ kind: 'pgid', signal: 'SIGKILL', pgid: -pid }` on POSIX. `killTree` consumes it
   (`execFile(r.file, r.args)` / `process.kill(r.pgid, r.signal)`). **Zero behavior change** — the
   exact same argv/signal as today (verified against the current `pty.ts` lines).
2. **Unit-test both branches** in `pty.test.ts`: assert the Windows argv is exactly
   `['/PID','<pid>','/T','/F']` with file `taskkill`, and the POSIX result is `pgid === -pid` with
   `SIGKILL`. No native runtime needed (pure).
3. **MAIN registry helper `childPidsOf(pid)`** in `src/main/e2eMain.ts` (env-gated, test-only): an OS
   query returning the live descendant pids of `pid`. Windows: `Get-CimInstance Win32_Process` /
   `wmic process where (ParentProcessId=…)`; POSIX: `pgrep -P` walked transitively (or read the
   process group). Returns `number[]`. Used only to assert "no orphans remain".
4. **New e2e spec `e2e/processTree.e2e.ts`** (runs on both matrix legs): seed a `terminal` board whose
   `launchCommand` spawns a **child process tree** (a shell that backgrounds a sleeper, or a node
   child that forks); poll until `childPidsOf(rootPid)` is non-empty (tree is up); `deleteBoard` then
   force the reap (drive `disposeAll`, or wait past `PARK_TTL`, or the explicit kill path — settle in
   the plan against `deleteBoard`'s park semantics); assert `childPidsOf(rootPid)` is **empty** (and
   the root pid is gone). Windows exercises `taskkill /T /F`; Linux exercises the negative-pgid reap —
   the real cross-platform payoff. Local count: e2e suite goes **20 → 21**.

### T5c — rewrite the stale smoke jobs (the gate)

Both `smoke` jobs (`pr.yml`, `staging.yml`) today still run `pnpm build` then
`pnpm start` with `env: CANVAS_SMOKE: e2e` — a mode **T4 deleted**. Rewrite each:

- **`if: false` removed.**
- `runs-on: ${{ matrix.os }}` with `strategy: { fail-fast: false, matrix: { os: [windows-latest,
  ubuntu-latest] } }`. `needs: check`.
- Steps: `checkout` → `setup-node@v4` (22) → `setup-python@v5` (3.11, for the node-pty rebuild) →
  `corepack enable` → `pnpm install --frozen-lockfile` (**`postinstall` =
  `electron-builder install-app-deps` rebuilds node-pty against the Electron ABI** — no extra rebuild
  step) → **run e2e**. No separate `pnpm build` (the `pretest:e2e` hook = `electron-vite build`). No
  `playwright install` (`_electron` uses the `node_modules` Electron, not a downloaded browser).
- **Per-OS run step:** Linux uses `xvfb-run -a pnpm test:e2e`; Windows uses `pnpm test:e2e`. Gated on
  `runner.os` (two steps with `if:`, or a matrix `run_cmd` var).
- **Artifact on failure:** `upload-artifact` the `playwright-report/` (and traces) `if: failure()` for
  triage of a runner-only flake.
- `playwright.config.ts`: `retries: process.env.CI ? 2 : 0`; `workers:1` / `fullyParallel:false` stay
  (native-view + PTY + GPU serialization, and it dampens the contention flake).

### T5d — prove STABLE on the runner

Local green is **necessary but not sufficient.** Push to PR #37, `gh run watch`, and on green
**re-run the smoke workflow ≥2–3×** (`gh workflow run` / re-push / the workflow_dispatch trigger) to
prove it is not a one-off. Triage any failure from the uploaded report.

- A probe that flakes **within** the 2 retries on a documented env flake (browser-trio /
  whiteboard-fullview-add) → acceptable; note it.
- A probe that flakes **past** retries, or a *new* flake → **fix determinism** (preferred) or, if
  truly irreducible env, **quarantine that single probe** out of the gate and `log()` exactly what's
  excluded and why (TESTING.md). Never ship a coin-flip gate.

### T5e — finish

- **CLAUDE.md › Status:** the 2026-06-03 e2e **FREEZE** note is **lifted** — replace it with the new
  reality (e2e is a trusted Playwright `_electron` gate on a Win+Linux matrix; the `check` job +
  `smoke` job are both gates).
- **`docs/testing/TESTING.md`:** update "Still owed (T5)" → process-tree-kill **done**, gate
  **re-enabled** (Win+Linux), and auto-update **deferred to Phase 5** (the one remaining e2e-only
  surface). Document the chosen flake/retry policy + any GL/sandbox launch flag.
- **Memory `testing-strategy`:** append "T5 shipped — initiative COMPLETE" with the gate recipe
  (rewritten smoke → `pnpm test:e2e` matrix; `retries: CI?2:0`; xvfb + any GL/`--no-sandbox` flag),
  the process-tree-kill test location, and the auto-update deferral.
- **`finishing-a-development-branch`:** PR #37 (T0–T5) is now ready to merge to main per the CLAUDE.md
  sequential-merge rule (re-run the FULL gate — now including the re-enabled e2e smoke — after merge).

---

## Files touched

| File | Change |
|---|---|
| `.github/workflows/pr.yml` | Rewrite `smoke` job → matrix `pnpm test:e2e`; remove `if: false`; failure artifact. |
| `.github/workflows/staging.yml` | Same rewrite (keep the `package` matrix job as-is). |
| `playwright.config.ts` | `retries: process.env.CI ? 2 : 0`. |
| `e2e/fixtures.ts` | CI-gated launch args (GL / `--no-sandbox`) **iff** the T5a spike requires them. |
| `src/main/pty.ts` | Extract pure `killTreeCommand`; `killTree` consumes it (no behavior change). |
| `src/main/pty.test.ts` | Unit-test `killTreeCommand` both platforms. |
| `src/main/e2eMain.ts` | Add `childPidsOf(pid)` registry helper. |
| `e2e/processTree.e2e.ts` | New real-spawn-and-reap e2e (runs on both legs). |
| `docs/testing/TESTING.md` | "Still owed" → done/deferred; flake policy; launch flags. |
| `CLAUDE.md` | Lift the e2e freeze note. |

No new `package.json` deps (Playwright + xvfb are already-available infra).

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `capturePage` returns a blank frame on a CI runner (no real GPU) | **T5a spike resolves empirically per-OS** before committing the gate; add `--use-gl=swiftshader`/`--use-angle=swiftshader` (CI-gated) only where blank. Capture **while on-screen** (already the T4 pattern). |
| Electron won't launch headless on `ubuntu-latest` | `xvfb-run -a`; if the SUID sandbox blocks launch, CI-only `--no-sandbox` on the **test launch** (not `webPreferences`) as a documented last resort. Spike proves which is needed. |
| Gate is flaky → distrust → re-freeze | `retries: CI?2:0` + `workers:1`; prove **stable ≥2–3 runs**; quarantine-and-log any irreducible single offender rather than shipping a coin-flip. |
| node-pty ABI mismatch on a runner | `postinstall` (`electron-builder install-app-deps`) rebuilds for the Electron ABI on every `pnpm install`, both OSes. |
| `killTreeCommand` extraction subtly changes the kill | Pure refactor asserted **identical** argv/signal to current `pty.ts`; lifecycle cores already covered; full `pnpm test` 676 must hold. |
| CI cost (2 runners × build + 6 Electron launches) | `fail-fast:false`, parallel legs → wall-clock ≈ one leg; accepted for the final gate. `workers:1` stays (native serialization). |
| Linux `childPidsOf` / pgid query differs from Windows | Platform-branch the helper; the e2e asserts the same invariant (no orphans) on both; the unit test covers the command builder regardless. |

---

## Validation gate (must be green before finishing)

- `pnpm test` → **676** (Vitest unchanged + the new `killTreeCommand` unit cases — confirm the exact
  count after adding them; the kill-builder cases raise it, e2e is separate).
- `pnpm typecheck` clean · `pnpm lint` 0 errors · `pnpm run format:check` clean.
- `pnpm test:e2e` → green locally (Windows), now **21** tests incl. `processTree.e2e.ts`.
- **The rewritten `smoke` job runs GREEN on the actual GitHub runners (Win + Linux), watched via
  `gh run watch`, and STABLE across ≥2–3 runs.**
- `if: false` gone from the `smoke` job in **both** `pr.yml` and `staging.yml`; **no** stale
  `CANVAS_SMOKE=e2e` step remains.
- CLAUDE.md freeze note lifted; TESTING.md + memory updated; auto-update documented as deferred.

---

## Cadence & finish

Commit **design + plan first** (docs-only), then implement. Plan →
`docs/superpowers/plans/2026-06-03-testing-t5-ci-gate.md` (writing-plans next). Execute via sonnet
implementers (never haiku — memory `workflow-model-sonnet-not-haiku`) or inline executing-plans.
**Validate every CI change by pushing and watching the Actions run** — local green is necessary but
NOT sufficient for T5. On a stable green gate: `finishing-a-development-branch`; PR #37 (T0–T5) is the
complete initiative, ready to merge to main.

---

## Open questions (resolve in the plan / empirically in T5a)

- **T5a outcome → launch args.** Exact GL flag (`swiftshader` via `--use-gl` vs `--use-angle`) and
  whether Linux needs `--no-sandbox` — decided by the spike, not pre-committed.
- **Reap trigger in `processTree.e2e.ts`.** Does `deleteBoard` park (120s TTL) the terminal, requiring
  `disposeAll` or an explicit kill to reap within the test window? Settle against `pty.ts`'s park/adopt
  path in the plan (a delete→`disposeAll` or a direct kill, not a 120s wait).
- **`childPidsOf` implementation per OS.** `wmic` is deprecated on newer Windows — prefer
  `Get-CimInstance`/PowerShell or a `tasklist`-based walk; confirm availability on `windows-latest`.
- **Child-tree spawn recipe** that is deterministic and cross-platform (a sleeper child the test can
  reliably detect then assert gone) — pin in the plan.
