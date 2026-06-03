# Testing Strategy Initiative (T0–T5) — compiled

**Date:** 2026-06-03 · **Branch:** `testing-strategy` (PR #37) · **Status:** complete

This single doc compiles the testing-strategy initiative — the per-phase design specs, implementation
plans, and research that were collapsed for repo hygiene (the repo's standard pattern; originals are in
git history — see the pointer at the end). The **living** testing contract is `docs/testing/TESTING.md`;
this is the **why/history**.

---

## Goal & model

Move the suite to the **Testing Trophy** (mostly integration; thin, trustworthy e2e) and make the
brittle, frozen e2e a real gate again. Tiers: **Static** (tsc + ESLint) · **Unit** · **Integration
(largest)** · **thin E2E**. Decision rule, tier map, and "what each tier may touch" live in
`TESTING.md`.

**Research backing (deep-research, 24/24 claims verified):** the model is the Trophy, *not* the
unit-heavy pyramid (the pro-pyramid claim was the one refuted). The repo was never raw-volume
e2e-heavy (~3:1 unit:e2e); the real problems were (1) a brittle homegrown `CANVAS_SMOKE=e2e` harness
frozen in CI, (2) security/MAIN files with no fast test, (3) probes duplicating unit coverage.

---

## The six phases

| Phase | What shipped |
|---|---|
| **T0 — Foundation** | Identity doc `TESTING.md` (3-tier taxonomy + decision rule + security→tier map). Split Vitest into **`unit` + `integration`** projects (`vitest.workspace.ts`; Vitest 2.1.9 = workspace file, not v3 `test.projects`). Naming: `*.test.*`=unit, `*.integration.test.*`=integration; `.ts`→node, `.tsx`→jsdom. Classified/retrofitted every file. Zero behavior change (633 tests held). |
| **T1 — Security-unit gap** | Extracted `src/main/windowSecurity.ts` (pure: `buildMainWindowWebPreferences` #3/#4, `windowOpenDecision` #14, `computeAppOrigin`+`navDecision` #13) from `index.ts`, unit-tested. Foreign-sender **rejection** tests for every guarded IPC handler in pty/preview/projectIpc (#17/#20). |
| **T2 — IPC integration layer** | Rejected `electron-mock-ipc` → built a **no-dep** `src/main/ipcTestHarness.ts` (`createIpcCapture()` → `{ipcMain, handlers, invoke, invokeAs}` + sender fixtures). Retrofitted projectIpc/pty/preview onto it. Added `preloadApi.integration.test.ts` (all 28 `api.*` channel mappings). |
| **T3 — Push-down** | Migrated 5 probe areas (whiteboard/menu/layout/planning/previewLink) DOWN to Vitest and **deleted** the redundant probe code; the homegrown harness shrank to native/real-instance slivers. 3 reusable jsdom-harness gotchas (stub `setPointerCapture`; seed notes WITH text; flush each pointer event in its own `act()`). |
| **T4 — Playwright `_electron`** | Replaced the homegrown harness with `@playwright/test` `_electron` (only new dep of the whole initiative). **20 e2e** in `e2e/` (terminal·browser·fullview·menu·previewLink·whiteboard). Boot via `CANVAS_E2E=1` (renderer `?e2e=1` hook + MAIN `globalThis.__canvasE2EMain` registry; **sandbox untouched, MAIN-helpers only**). Per-spec Electron instance + `reset()`. `src/main/e2e/**` + `e2eReport` deleted → Vitest 680→676. |
| **T5 — Gate** | Process-tree-kill coverage + the e2e gate decision (below). Vitest 676→**679** (the `killTreeCommand` unit cases); e2e 20→**21** (`processTree`). |

---

## T5 in detail

### Process-tree-kill
`killTree` in `pty.ts` was private and its command-string **untested** (`pty.test.ts` injected a mocked
`killTree`). Extracted a pure `killTreeCommand(platform, pid)` → `{kind:'taskkill', file, args:['/PID',
…,'/T','/F']}` on win32, `{kind:'pgid', pgid:-pid, signal:'SIGKILL'}` on POSIX; `killTree` consumes it
(zero behavior change). Unit-tested both platforms. New `e2e/processTree.e2e.ts`: a real `node -e` child
**prints its own pid** into the terminal framebuffer; the probe parses that exact pid and asserts it is
reaped after `deleteBoard` + `disposeAllPtys` (via a MAIN `pidsAlive(pids)` helper). Windows exercises
`taskkill /T /F`, Linux the negative-pgid reap.

**Bug the Win+Linux matrix caught (and the lesson):** the first design walked the whole OS pid→ppid
graph (`childPidsOf`). On Windows that (a) **cycles** via pid reuse / self-parent (PID 0→0) → unbounded
BFS → `RangeError: Invalid array length`, and (b) reaches System(4) + reuses the freed root pid after
the kill → false orphans. **Never walk the OS tree from a root pid; capture the child's own pid.**

### Linux-CI research (verified)
For Playwright `_electron` on headless `ubuntu-latest`:
- **Xvfb required** (`xvfb-run -a`); do **not** assume it's pre-installed → `apt-get install -y xvfb`.
- **Sandboxed Electron aborts/times out on CI Linux** (SUID `chrome-sandbox` misconfig + 24.04 AppArmor
  userns) → pass `--no-sandbox` (+ `--disable-dev-shm-usage`) to the **test launch only**
  (`e2e/fixtures.ts`, CI+Linux gated). Disabling `app.enableSandbox()` in app code was **refuted 0-3** —
  the app's `webPreferences.sandbox:true` stays untouched.
- **node-pty ABI** rebuild is handled by the existing `postinstall` (`electron-builder install-app-deps`,
  auto-detect); `--force-abi` was refuted.
- **capturePage on headless Linux:** the one unresolved research unknown → spiked empirically. A
  throwaway CI matrix proved capturePage is **non-blank on both runners** with the above args — **no GL
  flag needed**.

### The e2e gate decision — LOCAL pre-commit, not GitHub Actions
GitHub Actions e2e was **billing-blocked**, and the native/Docker e2e is cheaper + faster on the dev
box. So e2e was **removed from Actions** (the `smoke` job is gone from `pr.yml` + `staging.yml`; the
Actions CI gate is the `check` job only — typecheck/lint/format/vitest) and runs **locally as a
`pre-commit` hook**:
- `.githooks/pre-commit` → `pnpm test:e2e:matrix` (full **Windows-native + Linux-Docker** matrix).
- Enabled per-clone by a no-dep `package.json` `prepare` script (`git config core.hooksPath .githooks`).
- The hook checks Docker is up and sets `E2E_PRECOMMIT=1` → Playwright `retries:2` so the documented
  browser-trio env flake can't false-block a commit. Bypass a WIP commit with `git commit --no-verify`.
- Local matrix scripts: `pnpm test:e2e` (Windows native) · `pnpm test:e2e:linux` (Docker,
  `Dockerfile.e2e`) · `pnpm test:e2e:matrix` (both). **Docker gotcha:** the image CMD uses
  `--reporter=line` — the default `list` reporter's tty cursor-control blocks on a non-TTY stdout
  (looks hung with zero output); `line` streams unbuffered.

**Proof:** both legs green + stable — Windows 21/21 on the dev machine, Linux 21/21 ×2 consecutive via
Docker (incl. the negative-pgid reap).

**Deferred:** an **auto-update** e2e (the one remaining e2e-only surface) → Phase 5, needs
packaging/electron-updater.

---

## Locked outcomes (carry forward)

- **Never weaken the sandbox** (`contextIsolation:true`/`sandbox:true`/`nodeIntegration:false`). The
  e2e harness is MAIN-helpers-only; `--no-sandbox` is a test-launch flag, never a `webPreferences` change.
- Vitest stays the `check` gate (679); e2e is the separate local pre-commit gate.
- Component-render (jsdom) tests count as **integration**.
- Baselines at close: **Vitest 679** (unit 592 / integration 88-ish across 48 files), e2e **21**.

## Originals

The per-phase specs (`docs/superpowers/specs/2026-06-03-testing-*`), plans
(`docs/superpowers/plans/2026-06-03-testing-*`), and research
(`docs/research/2026-06-03-{testing-strategy,electron-playwright-linux-ci}.md`) were collapsed into this
doc and removed from the tree. Recover any of them from git history:

```bash
git log --oneline --all -- docs/superpowers/specs/2026-06-03-testing-t5-ci-gate-design.md
git show <commit>:docs/superpowers/plans/2026-06-03-testing-t5-ci-gate.md
```
