# Testing T5 — re-enable the e2e CI gate · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the testing-strategy initiative — turn the frozen e2e into a trusted, stable green CI gate running the T4 Playwright `_electron` suite on a **windows-latest + ubuntu-latest** matrix, add cross-platform process-tree-kill coverage, defer auto-update to Phase 5.

**Architecture:** Five sub-phases on the single `testing-strategy` branch (PR #37): **T5a** spikes the one unresolved unknown (does `capturePage` come back non-blank on the runners — Linux launch/sandbox/node-pty already research-resolved); **T5b** extracts a pure kill-command builder (unit, both platforms) + adds a real-spawn-and-reap e2e; **T5c** rewrites the stale `smoke` job (pr + staging) to run `pnpm test:e2e` on the matrix and removes `if: false`; **T5d** proves it green + stable on the real runners; **T5e** lifts the freeze + ships PR #37.

**Tech stack:** `@playwright/test` `_electron` (v1.60, already in), Electron 33, node-pty 1.2.0-beta.13, Vitest 2.1.9, GitHub Actions (Win + Ubuntu), `xvfb-run` on Linux.

**Spec:** `docs/superpowers/specs/2026-06-03-testing-t5-ci-gate-design.md`
**Research:** `docs/research/2026-06-03-electron-playwright-linux-ci.md` (verified Linux-CI facts)

---

## 🔒 Non-negotiable constraints

- **No new branch.** Commit on `testing-strategy`; `git push` updates PR #37.
- **Never weaken the app sandbox.** `--no-sandbox` is a flag on the **test Electron launch only**
  (`_electron.launch({ args })`), CI+Linux-gated — it does **not** touch `webPreferences.sandbox:true`.
- **No new runtime deps.** Playwright + xvfb are already-available infra.
- **Vitest `pnpm test` stays the `check` gate** (676), a SEPARATE job. Do NOT fold `pnpm test:e2e` into
  `pnpm test`.
- **The proof is on the runner.** Local green ≠ done. Every CI change is validated by pushing and
  watching the Actions run (`gh run watch` / `gh run view <id> --log-failed`); the gate must be stable
  across ≥2–3 runs before T5 is finished.
- **Commits with backticks** → quoted heredoc `git commit -F -` (memory `bash-tool-commit-backticks`).
- **Leave untracked files alone** (`canvas.json*`, `.claude/coordination/*`).

## Baseline (confirm before starting)

- [ ] **Step 0: Confirm the baseline is green.**

Run:
```bash
pnpm test            # expect: 676 passed (48 files)
pnpm typecheck       # expect: clean
pnpm lint            # expect: 0 errors (2 pre-existing no-console warnings OK)
pnpm run format:check # expect: All matched files use Prettier code style!
```
Expected: as annotated. HEAD is `8f6410d` (T4 shipped). PR #37 open + MERGEABLE.
(`pnpm test:e2e` → 20 green locally on Windows is the T4 baseline; not re-run here.)

---

## File structure

| File | Responsibility | Phase |
|---|---|---|
| `e2e/fixtures.ts` | Add CI+Linux-gated launch args to `_electron.launch` (`--no-sandbox`, `--disable-dev-shm-usage`; GL flag iff spike requires). | T5a |
| `.github/workflows/_spike-e2e.yml` | THROWAWAY spike workflow (matrix, `workflow_dispatch`) — observe capturePage on the runners. Deleted at end of T5a. | T5a |
| `src/main/pty.ts` | Extract pure `killTreeCommand(platform, pid)`; `killTree` consumes it (zero behavior change). | T5b |
| `src/main/pty.test.ts` | Unit-test `killTreeCommand` both platforms. | T5b |
| `src/main/e2eMain.ts` | Add `childPidsOf(pid)` + `disposeAllPtys()` to the env-gated MAIN registry. | T5b |
| `e2e/processTree.e2e.ts` | New e2e: spawn a real child tree, reap, assert no orphans (runs on both legs). | T5b |
| `.github/workflows/pr.yml` | Rewrite `smoke` job → matrix `pnpm test:e2e`; remove `if: false`; failure artifact. | T5c |
| `.github/workflows/staging.yml` | Same `smoke` rewrite (leave `package` job as-is). | T5c |
| `playwright.config.ts` | `retries: process.env.CI ? 2 : 0`. | T5c |
| `docs/testing/TESTING.md` | "Still owed (T5)" → done/deferred; flake policy; launch flags. | T5e |
| `CLAUDE.md` | Lift the 2026-06-03 e2e FREEZE note. | T5e |

---

## T5a — Spike capturePage on the runners (de-risk FIRST)

**Why:** research resolved xvfb / `--no-sandbox` / node-pty ABID; the ONE unverified unknown is whether
`capturePage` returns a non-blank frame on `windows-latest` / `ubuntu-latest` (and which GL flag, if
any, Linux needs). The existing `browser`/`fullview`/`menu` capture probes already assert non-blank —
so running them on a throwaway matrix job IS the spike: green = capture works; a blank-frame failure =
add a GL flag. Resolve this before committing the real gate.

### Task A1: Add the research-confirmed Linux launch args to the fixtures

**Files:**
- Modify: `e2e/fixtures.ts` (the `_electron.launch` call, ~lines 19-24)

- [ ] **Step 1: Add a CI+Linux-gated launch-args helper and use it.**

Replace the `_electron.launch({...})` call in the `electronApp` fixture with:

```ts
// Headless Linux CI: Electron's SUID chrome-sandbox helper is misconfigured on
// unprivileged runners (Electron #42510) + Ubuntu 24.04 AppArmor restricts user
// namespaces → a sandboxed launch aborts/times out. --no-sandbox is a flag on the
// TEST launch ONLY; it does NOT change the app's webPreferences.sandbox:true.
// --disable-dev-shm-usage avoids the small /dev/shm on runners. Both are
// research-confirmed (docs/research/2026-06-03-electron-playwright-linux-ci.md).
// A software-GL flag may be appended after the T5a spike if capturePage is blank.
const launchArgs = ['out/main/index.js']
if (process.env.CI && process.platform === 'linux') {
  launchArgs.push('--no-sandbox', '--disable-dev-shm-usage')
}
const app = await _electron.launch({
  args: launchArgs,
  env: { ...process.env, CANVAS_E2E: '1' }
})
```

- [ ] **Step 2: Verify locally nothing broke (args are a no-op off-CI / off-Linux).**

Run: `pnpm test:e2e` (Windows local — `process.env.CI` unset, so args unchanged)
Expected: still 20 passed (no behavior change locally).

- [ ] **Step 3: Commit.**

```bash
git add e2e/fixtures.ts
git commit -m "test(e2e): research-confirmed Linux-CI launch args (--no-sandbox, --disable-dev-shm-usage)"
```

### Task A2: Throwaway spike workflow — observe capturePage on the runners

**Files:**
- Create: `.github/workflows/_spike-e2e.yml`

- [ ] **Step 1: Write the spike workflow (matrix, capture probes only, manual trigger).**

```yaml
name: _spike-e2e

# THROWAWAY (T5a) — observe whether capturePage returns a non-blank frame on the
# Win + Linux runners. Deleted once the GL question is answered. Trigger manually.
on:
  workflow_dispatch:
  push:
    branches: [testing-strategy]
    paths: ['.github/workflows/_spike-e2e.yml', 'e2e/fixtures.ts']

permissions:
  contents: read

jobs:
  spike:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - name: Install Xvfb (Linux only)
        if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y xvfb
      - name: Spike capture probes (Linux)
        if: runner.os == 'Linux'
        run: xvfb-run -a pnpm exec playwright test browser fullview menu
      - name: Spike capture probes (Windows)
        if: runner.os == 'Windows'
        run: pnpm exec playwright test browser fullview menu
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: spike-report-${{ matrix.os }}
          path: playwright-report/
          if-no-files-found: ignore
```

Note: `pretest:e2e` only runs for `pnpm test:e2e`; here we call `pnpm exec playwright test`
directly, so add an explicit build. Insert before the spike steps:
```yaml
      - run: pnpm exec electron-vite build
```

- [ ] **Step 2: Commit + push the spike.**

```bash
git add .github/workflows/_spike-e2e.yml
git commit -m "ci(spike): throwaway e2e capturePage spike on Win+Linux runners (T5a)"
git push
```

- [ ] **Step 3: Watch the run on the actual runners.**

Run:
```bash
gh run list --workflow=_spike-e2e.yml --branch testing-strategy --limit 1
gh run watch <run-id>
```
Expected (one of):
- **Both legs green** → capturePage works on both; **no GL flag needed**. Proceed to Step 5.
- **Linux (or Windows) `browser`/`fullview`/`menu` fails** on a blank-frame / capture assertion →
  capturePage needs software GL on that leg. Go to Step 4.

- [ ] **Step 4 (only if a leg's capture failed): add the GL flag, re-spike.**

Download the failing report to confirm it's a blank-capture assertion (not an unrelated launch error):
```bash
gh run download <run-id> -n spike-report-ubuntu-latest -D /tmp/spike-report
```
Then append the GL flag in `e2e/fixtures.ts` (same CI+Linux block from Task A1):
```ts
if (process.env.CI && process.platform === 'linux') {
  launchArgs.push('--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader')
}
```
Commit + push, re-watch the spike. If still blank, try `--use-angle=swiftshader` (replace
`--use-gl=swiftshader`), then `--disable-gpu` as an additional flag. Record which combination yields
green — it carries into the real gate. (If Windows also needs it, widen the gate to
`process.env.CI` without the `linux` check for the GL flag specifically.)

- [ ] **Step 5: Delete the throwaway spike workflow.**

```bash
git rm .github/workflows/_spike-e2e.yml
git commit -m "ci(spike): remove throwaway capturePage spike — capture verdict recorded (T5a)"
```
Record the verdict (GL flag needed? which?) in the T5c commit message + TESTING.md (T5e). The
`fixtures.ts` launch args (incl. any GL flag) stay.

---

## T5b — Process-tree-kill (unit + e2e)

**Why:** `killTree` in `pty.ts` is **private** and its command construction is **NOT** unit-tested
(`pty.test.ts` injects a mocked `killTree`). Extract a pure builder + unit-test both platforms, then
prove the real reap end-to-end on both legs (Windows `taskkill /T /F`, Linux negative-pgid).

### Task B1: Extract a pure `killTreeCommand` builder + unit-test both platforms

**Files:**
- Modify: `src/main/pty.ts` (the private `killTree`, ~lines 629-666)
- Test: `src/main/pty.test.ts` (add a `describe`)

- [ ] **Step 1: Write the failing unit test.**

Add to `src/main/pty.test.ts` — first add `killTreeCommand` to the existing import from `./pty`, then:

```ts
// T5: the OS process-tree kill command builder. Extracted pure so the actual
// argv/signal (previously buried in the private killTree) is asserted directly —
// agentic CLIs spawn child trees; a bare kill leaves orphans.
describe('killTreeCommand (T5 — process-tree kill builder)', () => {
  it('builds `taskkill /PID <pid> /T /F` on win32', () => {
    expect(killTreeCommand('win32', 1234)).toEqual({
      kind: 'taskkill',
      file: 'taskkill',
      args: ['/PID', '1234', '/T', '/F']
    })
  })

  it('targets the negative pgid with SIGKILL on linux', () => {
    expect(killTreeCommand('linux', 1234)).toEqual({
      kind: 'pgid',
      pgid: -1234,
      signal: 'SIGKILL'
    })
  })

  it('targets the negative pgid with SIGKILL on darwin', () => {
    expect(killTreeCommand('darwin', 999)).toEqual({
      kind: 'pgid',
      pgid: -999,
      signal: 'SIGKILL'
    })
  })
})
```

- [ ] **Step 2: Run it — verify it fails (not exported yet).**

Run: `pnpm test:unit -- pty`
Expected: FAIL — `killTreeCommand is not a function` / import error.

- [ ] **Step 3: Add the pure builder + refactor `killTree` to consume it.**

In `src/main/pty.ts`, add the exported type + function just above the private `killTree`:

```ts
/**
 * The OS-specific command for reaping a process's whole tree. Extracted PURE from
 * killTree so the exact argv (Windows) / signal+pgid (POSIX) is unit-testable —
 * agentic CLIs spawn child process trees and a bare kill() leaves orphans (#49).
 */
export type KillTreeCommand =
  | { kind: 'taskkill'; file: 'taskkill'; args: string[] }
  | { kind: 'pgid'; pgid: number; signal: 'SIGKILL' }

export function killTreeCommand(platform: NodeJS.Platform, pid: number): KillTreeCommand {
  if (platform === 'win32') {
    // taskkill /T reaps the descendant tree (proc.kill() only signals the console
    // process list, not deeply re-parented children).
    return { kind: 'taskkill', file: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] }
  }
  // POSIX: the pty session is its own process group; kill the negative pgid.
  return { kind: 'pgid', pgid: -pid, signal: 'SIGKILL' }
}
```

Then replace the body of the private `killTree` to consume it (behavior identical to today):

```ts
function killTree(proc: pty.IPty): Promise<void> {
  const cmd = killTreeCommand(process.platform, proc.pid)
  if (cmd.kind === 'taskkill') {
    const reaped = new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      execFile(cmd.file, cmd.args, () => finish())
      // Bounded fallback: never block shutdown indefinitely on a hung taskkill.
      setTimeout(finish, 2000).unref?.()
    })
    // ALSO dispose node-pty's ConPTY/conout worker deterministically.
    try {
      proc.kill()
    } catch {
      /* ConPTY already torn down */
    }
    return reaped
  } else {
    try {
      process.kill(cmd.pgid, cmd.signal)
    } catch {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }
    return Promise.resolve()
  }
}
```

- [ ] **Step 4: Run the unit test + the full suite.**

Run: `pnpm test:unit -- pty`
Expected: PASS (3 new `killTreeCommand` cases + all existing pty cases).
Run: `pnpm test`
Expected: 679 passed (676 + 3). `pnpm typecheck` clean.

- [ ] **Step 5: Commit.**

```bash
git add src/main/pty.ts src/main/pty.test.ts
git commit -m "test(pty): extract pure killTreeCommand + unit-test both platforms (T5)"
```

### Task B2: Add `childPidsOf` + `disposeAllPtys` to the MAIN registry

**Files:**
- Modify: `src/main/e2eMain.ts` (interface `E2EMain` + the installed object)

- [ ] **Step 1: Add the imports + interface methods.**

At the top of `src/main/e2eMain.ts`, extend the imports:
```ts
import { execFileSync } from 'child_process'
```
and add `disposeAllPtys` to the existing pty import:
```ts
import { debugTerminalPid, debugWriteTerminal, disposeAllPtys } from './pty'
```

Add to the `E2EMain` interface:
```ts
  /** Live descendant pids of `pid` (transitive). [] when the tree is fully reaped. */
  childPidsOf(pid: number): number[]
  /** Tear down EVERY pty session (live + parked) — the real MAIN kill path. */
  disposeAllPtys(): Promise<void>
```

- [ ] **Step 2: Add a pure-ish descendant walker (module scope, above `installE2EMain`).**

```ts
/**
 * All (pid, ppid) pairs on the OS — Windows via PowerShell CIM, POSIX via `ps`.
 * Used only by the env-gated childPidsOf to assert a killed tree left no orphans.
 */
function listProcessParents(): Array<{ pid: number; ppid: number }> {
  let out = ''
  try {
    if (process.platform === 'win32') {
      out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'
        ],
        { encoding: 'utf8' }
      )
    } else {
      out = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
    }
  } catch {
    return []
  }
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 2)
    .map(([a, b]) => ({ pid: Number(a), ppid: Number(b) }))
    .filter((p) => Number.isFinite(p.pid) && Number.isFinite(p.ppid))
}

/** Breadth-first transitive descendants of `root` from a (pid→ppid) snapshot. */
function descendantPids(root: number): number[] {
  const all = listProcessParents()
  const childrenOf = new Map<number, number[]>()
  for (const { pid, ppid } of all) {
    const arr = childrenOf.get(ppid) ?? []
    arr.push(pid)
    childrenOf.set(ppid, arr)
  }
  const out: number[] = []
  const queue = [...(childrenOf.get(root) ?? [])]
  while (queue.length) {
    const pid = queue.shift() as number
    out.push(pid)
    queue.push(...(childrenOf.get(pid) ?? []))
  }
  return out
}
```

- [ ] **Step 3: Wire both into the installed registry object.**

Inside `installE2EMain`'s `globalThis.__canvasE2EMain = { ... }`, add:
```ts
    childPidsOf(pid) {
      return descendantPids(pid)
    },
    disposeAllPtys() {
      return disposeAllPtys()
    },
```

- [ ] **Step 4: Typecheck + lint.**

Run: `pnpm typecheck && pnpm lint`
Expected: clean / 0 errors. (`e2eMain.ts` is not in the Vitest suite — it's MAIN registry code
driven only by Playwright, so no unit test; it's exercised by Task B3's e2e.)

- [ ] **Step 5: Commit.**

```bash
git add src/main/e2eMain.ts
git commit -m "test(e2e): MAIN registry childPidsOf + disposeAllPtys for the process-tree probe (T5)"
```

### Task B3: New `processTree.e2e.ts` — real spawn-and-reap on both legs

**Files:**
- Create: `e2e/processTree.e2e.ts`

- [ ] **Step 1: Write the e2e spec.**

```ts
import { test, expect } from './fixtures'
import { evalIn, mainCall, seed } from './helpers'

// A persistent child the shell spawns under itself, cross-shell (pwsh / bash):
// `node -e "setInterval(...)"` runs node as a child of the spawned shell, so it
// shows up under childPidsOf(rootPid). node is on PATH on every runner (setup-node)
// and locally. The interval keeps it alive until the tree is reaped.
const CHILD = `node -e "setInterval(()=>{}, 1000000)"`

test.describe('process-tree kill (real child tree — node-pty / OS reap)', () => {
  test('killing a terminal reaps its whole child tree (no orphans)', async ({
    page,
    electronApp
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: CHILD })

    // Root = the spawned shell's pid; the node child re-parents under it.
    const rootPid = await mainCall<number | null>(electronApp, 'terminalPid', id)
    expect(rootPid, 'terminal spawned').not.toBeNull()

    // Wait for the child tree to come up (the node child appears under the shell).
    await expect
      .poll(() => mainCall<number[]>(electronApp, 'childPidsOf', rootPid), { timeout: 15_000 })
      .not.toEqual([])

    // Delete the board (parks the session) then drive the real MAIN teardown that
    // reaps live + parked trees — taskkill /T /F on Windows, negative-pgid on POSIX.
    await evalIn(page, `window.__canvasE2E.deleteBoard(${JSON.stringify(id)})`)
    await mainCall(electronApp, 'disposeAllPtys')

    // The whole descendant tree must be gone — this is the orphan assertion.
    await expect
      .poll(() => mainCall<number[]>(electronApp, 'childPidsOf', rootPid), { timeout: 15_000 })
      .toEqual([])
    expect(await mainCall<number | null>(electronApp, 'terminalPid', id)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it locally (Windows) — verify it passes.**

Run: `pnpm test:e2e -- processTree`
Expected: PASS (1 test). The suite total is now 21.
Note: if `childPidsOf(rootPid)` never becomes non-empty, the shell may not have spawned the child yet
— confirm `node` is on PATH in the spawn env; the terminal inherits `process.env` (pty.ts spawns with
`env: { ...process.env }`).

- [ ] **Step 3: Run the whole e2e suite — confirm no regression.**

Run: `pnpm test:e2e`
Expected: 21 passed locally (Windows).

- [ ] **Step 4: Commit.**

```bash
git add e2e/processTree.e2e.ts
git commit -m "test(e2e): real child-tree spawn-and-reap probe — no orphans, both legs (T5)"
```

---

## T5c — Rewrite the stale smoke jobs (the gate)

**Why:** both `smoke` jobs still run `pnpm start` with `CANVAS_SMOKE=e2e` — a mode T4 **deleted**.
Rewrite each to run the Playwright suite on the Win+Linux matrix, add CI retries + a failure artifact,
and remove `if: false`.

### Task C1: `playwright.config.ts` — CI retries

**Files:**
- Modify: `playwright.config.ts`

- [ ] **Step 1: Set CI retries (keep workers:1 / fullyParallel:false).**

Change `retries: 0,` to:
```ts
  // Bounded CI retries: browser-trio / whiteboard-fullview-add are documented ENV
  // capturePage/determinism flakes on contended runners (memory e2e-browser-trio-flake),
  // not bugs. 0 locally so a real local failure is loud. workers:1 stays.
  retries: process.env.CI ? 2 : 0,
```

- [ ] **Step 2: Sanity-run locally (retries stay 0 off-CI).**

Run: `pnpm test:e2e -- processTree`
Expected: PASS, no retry behavior locally.

- [ ] **Step 3: Commit.**

```bash
git add playwright.config.ts
git commit -m "test(e2e): retries:2 on CI for the documented env flakes (T5)"
```

### Task C2: Rewrite the `smoke` job in `pr.yml`

**Files:**
- Modify: `.github/workflows/pr.yml` (the whole `smoke` job, lines ~33-59)

- [ ] **Step 1: Replace the stale `smoke` job.**

Delete the existing `smoke:` block (the `if: false` … `CANVAS_SMOKE: e2e` one) and replace with:

```yaml
  # Playwright _electron e2e gate (T5). Runs the real built app on a Win + Linux
  # matrix — the ONLY tier allowed to touch the native layer (WebContentsView /
  # node-pty / OS process-tree kill). Separate from `check` (Vitest stays the unit/
  # integration gate). Linux needs Xvfb + --no-sandbox (set in e2e/fixtures.ts).
  smoke:
    needs: check
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - run: corepack enable
      # postinstall (electron-builder install-app-deps) rebuilds node-pty for the
      # Electron ABI on every OS — no extra rebuild step needed.
      - run: pnpm install --frozen-lockfile
      - name: Install Xvfb (Linux only)
        if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y xvfb
      - name: Playwright e2e (Linux, under Xvfb)
        if: runner.os == 'Linux'
        run: xvfb-run -a pnpm test:e2e
      - name: Playwright e2e (Windows)
        if: runner.os == 'Windows'
        run: pnpm test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report-${{ matrix.os }}
          path: playwright-report/
          if-no-files-found: ignore
          retention-days: 7
```

(`pnpm test:e2e`'s `pretest:e2e` = `electron-vite build`, so no separate build step. `_electron`
uses the node_modules Electron — no `playwright install`.)

- [ ] **Step 2: Lint the YAML mentally — confirm no leftover `if: false` / `CANVAS_SMOKE`.**

Run: `grep -n "if: false\|CANVAS_SMOKE" .github/workflows/pr.yml`
Expected: no output.

- [ ] **Step 3: Commit.**

```bash
git add .github/workflows/pr.yml
git commit -m "ci(pr): re-enable e2e gate — Playwright on Win+Linux matrix, drop stale CANVAS_SMOKE (T5)"
```

### Task C3: Rewrite the `smoke` job in `staging.yml`

**Files:**
- Modify: `.github/workflows/staging.yml` (the `smoke` job, lines ~34-57; leave `package` untouched)

- [ ] **Step 1: Replace the stale `smoke` job** with the SAME block as Task C2 Step 1 (identical job).

- [ ] **Step 2: Confirm no leftovers + `package` job intact.**

Run: `grep -n "if: false\|CANVAS_SMOKE" .github/workflows/staging.yml`
Expected: no output.
Run: `grep -n "package:" .github/workflows/staging.yml`
Expected: the `package:` job still present.

- [ ] **Step 3: Commit.**

```bash
git add .github/workflows/staging.yml
git commit -m "ci(staging): re-enable e2e gate on push-to-main — Playwright Win+Linux matrix (T5)"
```

---

## T5d — Prove green + STABLE on the real runners

**Why:** local green is necessary but NOT sufficient. A one-off pass is not a trusted gate.

- [ ] **Step 1: Push everything + watch the PR run.**

```bash
git push
gh run list --branch testing-strategy --workflow=pr.yml --limit 1
gh run watch <run-id>
```
Expected: `check` green (676 Vitest); **both `smoke` matrix legs green** (Win + Linux, e2e incl.
`processTree`).

- [ ] **Step 2: On any failure — triage from the artifact, don't guess.**

```bash
gh run view <run-id> --log-failed
gh run download <run-id> -n playwright-report-ubuntu-latest -D /tmp/pw-report   # or -windows-latest
```
- Blank-capture on a leg → revisit the GL flag (T5a Step 4) in `fixtures.ts`.
- Launch timeout on Linux → confirm `--no-sandbox` is applied (CI+linux gate) + Xvfb installed.
- A flake that **passed on retry** (Playwright marks it "flaky") on the documented env probes
  (browser-trio / whiteboard-fullview-add) → acceptable; note it.

- [ ] **Step 3: Prove STABILITY — re-run the gate ≥2–3×.**

```bash
gh workflow run pr.yml --ref testing-strategy   # or: gh run rerun <run-id>
# repeat; watch each
gh run watch <new-run-id>
```
Expected: green across **every** re-run. A probe that flakes **past** the 2 retries, or a NEW flake,
is a FAIL of T5 — **fix determinism** (preferred) or, if truly irreducible env, **quarantine that one
probe** out of the gate (`test.skip` with a `// QUARANTINE(T5):` comment + a `log` line in TESTING.md
naming exactly what's excluded and why). Never ship a coin-flip gate.

- [ ] **Step 4: Checkpoint — do not proceed to T5e until ≥2–3 consecutive green gate runs.**

---

## T5e — Finish (lift the freeze, ship PR #37)

### Task E1: Update `docs/testing/TESTING.md`

**Files:**
- Modify: `docs/testing/TESTING.md` (the "Still owed (T5)" line + the E2E section)

- [ ] **Step 1: Replace the "Still owed (T5)" line.**

Change:
```
**Still owed (T5):** re-enable the e2e CI gate, a cross-platform process-tree-kill check, and an
auto-update e2e (gated on Phase 5 packaging).
```
to:
```
**CI gate (T5, shipped):** the Playwright suite is a CI gate again — the `smoke` job runs
`pnpm test:e2e` on a **windows-latest + ubuntu-latest** matrix in `pr.yml` + `staging.yml`
(`needs: check`, separate from the Vitest gate). Linux runs under `xvfb-run -a` with CI-gated
`--no-sandbox` + `--disable-dev-shm-usage`<GL-FLAG-IF-USED>. Flake policy: `retries: 2` on CI,
`workers: 1`. Process-tree-kill is covered by `killTreeCommand` (unit, both platforms) +
`e2e/processTree.e2e.ts` (real child-tree reap on both legs).

**Still owed (deferred to Phase 5):** an **auto-update** e2e — electron-updater/packaging/signing
don't exist yet, so the update flow can't be e2e-tested. It is the one remaining e2e-only surface.
```
Replace `<GL-FLAG-IF-USED>` with the actual GL flag the spike settled on, or delete the placeholder if
none was needed.

- [ ] **Step 2: Commit.**

```bash
git add docs/testing/TESTING.md
git commit -m "docs(testing): TESTING.md — e2e gate re-enabled (Win+Linux), auto-update deferred (T5)"
```

### Task E2: Lift the e2e FREEZE note in `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md` (the `> **⚠️ E2E FROZEN (2026-06-03).**` blockquote in › Status)

- [ ] **Step 1: Replace the freeze blockquote.**

Replace the entire `> **⚠️ E2E FROZEN …` blockquote with:
```
> **✅ E2E GATE RE-ENABLED (2026-06-03, T5).** The e2e tier is now a trusted CI gate again —
> Playwright `_electron` (`pnpm test:e2e`) runs in the `smoke` job on a **windows-latest +
> ubuntu-latest** matrix (`pr.yml` + `staging.yml`, `needs: check`), replacing the deleted
> `CANVAS_SMOKE=e2e` harness. Flake policy: `retries: 2` on CI, `workers: 1`. This **supersedes** the
> 2026-06-03 freeze. The `check` job (typecheck · lint · format · unit + integration) and the `smoke`
> job are BOTH gates now — do not merge red. The one e2e-only surface still uncovered is **auto-update**
> (deferred to Phase 5 — needs packaging/electron-updater).
```

- [ ] **Step 2: Commit.**

```bash
git add CLAUDE.md
git commit -m "docs: lift the e2e freeze — Playwright gate re-enabled on Win+Linux (T5)"
```

### Task E3: Final full-gate verification + push

- [ ] **Step 1: Run the entire local gate.**

Run:
```bash
pnpm test            # 679 (676 + 3 killTreeCommand)
pnpm typecheck       # clean
pnpm lint            # 0 errors
pnpm run format:check # clean
pnpm test:e2e        # 21 green locally (Windows)
```
Expected: as annotated.

- [ ] **Step 2: Push + confirm the gate is green on the runner one more time.**

```bash
git push
gh run watch <run-id>
```
Expected: `check` + both `smoke` legs green.

### Task E4: Update memory + finish the branch

- [ ] **Step 1: Update memory `testing-strategy`.**

Append to `C:\Users\De Asis PC\.claude\projects\Z--Canvas-ADE\memory\testing-strategy.md`:
> **T5 SHIPPED — initiative COMPLETE** (2026-06-03, PR #37). E2e re-enabled as a trusted CI gate:
> `smoke` job runs `pnpm test:e2e` (Playwright `_electron`) on a **windows-latest + ubuntu-latest**
> matrix in pr.yml + staging.yml (`needs: check`, separate from the Vitest gate). Linux recipe
> (research-verified, `docs/research/2026-06-03-electron-playwright-linux-ci.md`): `apt-get install -y
> xvfb` → `xvfb-run -a pnpm test:e2e`; CI+Linux launch args `--no-sandbox` + `--disable-dev-shm-usage`
> (+ `<GL flag>` if used) on the TEST launch only (app sandbox untouched); node-pty ABI via the existing
> `postinstall`. Flake policy: `retries: process.env.CI ? 2 : 0`, `workers: 1`. Process-tree-kill:
> pure `killTreeCommand` (unit, both platforms — was previously UNtested) + `e2e/processTree.e2e.ts`
> (real child-tree reap on both legs). **Auto-update e2e remains DEFERRED to Phase 5** (the one e2e-only
> surface left — needs packaging/electron-updater).

- [ ] **Step 2: Invoke `superpowers:finishing-a-development-branch`.**

PR #37 (T0–T5) is the complete testing-strategy initiative, ready to merge to main per the CLAUDE.md
sequential-merge rule (re-run the FULL gate — now including the re-enabled e2e smoke — after merge).
Follow the skill's options (merge / PR / cleanup).

---

## Self-review notes (for the executor)

- **Test count drift:** Vitest goes 676 → **679** (3 `killTreeCommand` cases). E2e goes 20 → **21**
  (`processTree`). Update both numbers anywhere a doc cites them.
- **`killTreeCommand` name** is used identically in pty.ts (export), pty.test.ts (import), and the
  refactored `killTree` body — do not rename per-task.
- **`childPidsOf` / `disposeAllPtys`** are added to the `E2EMain` interface AND the installed object in
  the same task (B2); `processTree.e2e.ts` (B3) calls both via `mainCall`.
- **GL flag is conditional** — only T5a Step 4 adds it, only if the spike shows blank capture. Carry the
  verdict into TESTING.md + CLAUDE.md + memory (replace the `<GL flag>` placeholders).
- **Order matters:** T5a (spike, settles launch args) → T5b (kill, pure + e2e) → T5c (rewrite jobs) →
  T5d (prove stable) → T5e (docs + ship). Don't flip the gate (C2/C3) before the spike (A2) proves
  capturePage works, or the first real gate run could be red for a known-avoidable reason.
