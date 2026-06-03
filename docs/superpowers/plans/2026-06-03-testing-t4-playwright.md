# Testing T4 — Playwright `_electron` Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brittle homegrown `CANVAS_SMOKE=e2e` harness with `@playwright/test` `_electron`, port the real-instance keep-set, and delete the old harness once parity is reached — all on PR #37.

**Architecture:** Reuse the proven `window.__canvasE2E` renderer hook (driven via `page.evaluate`) and a NEW env-gated MAIN registry `globalThis.__canvasE2EMain` (driven via `electronApp.evaluate`) so probe logic survives; only the driver changes. A new `CANVAS_E2E=1` boot mode instruments the app (`?e2e=1` renderer + MAIN registry) WITHOUT self-running or auto-quitting, so Playwright drives it externally. Per-spec Electron instance; a new `__canvasE2E.reset()` clears state between tests. MAIN-helpers only — `contextIsolation:true`/`sandbox:true`/`nodeIntegration:false` are NEVER weakened.

**Tech Stack:** `@playwright/test` (new devDep, the only one), Electron 33, TypeScript strict, Vitest (untouched gate), node-pty (ABI matched to the built `out/`).

---

## 🔒 Non-negotiable constraints (read before any task)

- **No new branch.** Commit on `testing-strategy`; `git push` updates PR #37.
- **Never weaken the sandbox.** Use MAIN-process helpers only (`electronApp.evaluate`, the `__canvasE2EMain` registry). The renderer-side Playwright IPC helpers require `contextIsolation:false` — FORBIDDEN. Both new seams are env-gated test-only registries, not security changes.
- **Vitest stays the gate.** `pnpm test` must stay **680** green. Playwright is a SEPARATE command (`pnpm test:e2e`), never folded into `pnpm test`.
- **Real OS input for transform-dependent probes** (`whiteboard-fullview-add`, gesture probes): a synthetic `dispatchEvent` false-greens (memory `e2e-sendinputevent-vs-dispatchevent`). Drive `webContents.sendInputEvent` via the MAIN registry. `sendInputEvent` mouse `modifiers:['alt']` does NOT reach `e.altKey` (memory `e2e-modifier-keys-synthetic`).
- **Spaced repo path** (`Z:\Canvas ADE`): launch the built `out/` so native node-pty (winpty-free beta) ABI matches the runner.
- **Commits:** plain `-m` is fine; if a message needs backticks, use a quoted heredoc `git commit -F -` (memory `bash-tool-commit-backticks`).
- **Leave untracked files alone** (`canvas.json*` gitignored, `.claude/coordination/*`).

## Pre-flight (run once before Task 1)

- [ ] **Confirm the baseline.**

Run: `pnpm test`
Expected: `680 passed (49 files)`.

Run: `pnpm typecheck`
Expected: clean (no output errors).

Run: `git log --oneline -1`
Expected: `09e1af2` or later on branch `testing-strategy` (the spec/plan docs commits may be on top).

---

## File structure

**New files:**
- `playwright.config.ts` — root Playwright config (testDir `e2e/`, workers 1, no parallel).
- `e2e/fixtures.ts` — launch/close + `page` + `reset()` `beforeEach`; the shared `test`/`expect` export.
- `e2e/helpers.ts` — driver helpers (`evalIn`, `mainCall`, `pollEval`, `seed`).
- `e2e/terminal.e2e.ts` · `e2e/browser.e2e.ts` · `e2e/fullview.e2e.ts` · `e2e/menu.e2e.ts` · `e2e/previewLink.e2e.ts` · `e2e/whiteboard.e2e.ts`.
- `src/main/e2eMain.ts` — env-gated MAIN registry (`globalThis.__canvasE2EMain`).

**Modified files:**
- `package.json` — add `@playwright/test` devDep + `test:e2e` / `pretest:e2e` scripts.
- `src/main/index.ts` — install the MAIN registry + add `CANVAS_E2E` boot mode.
- `src/renderer/src/smoke/e2eHooks.ts` — add `reset()` to the hook.
- `.gitignore` — ignore `test-results/`, `playwright-report/`, `e2e/.cache`.
- `tsconfig.node.json` — include `e2e/**` + `playwright.config.ts` for typecheck.

**Deleted at the end (Task 14, after parity):**
- `src/main/e2e/**` (index/context/types + all probes).
- The `CANVAS_SMOKE=e2e` branch in `src/main/index.ts`; `runE2ESmoke` import.
- `src/main/e2eReport.ts` + `src/main/e2eReport.test.ts` IF nothing else imports `summarizeE2E`.

**The driver-seam mapping (used throughout the ports):**

| homegrown `ctx` | Playwright |
|---|---|
| `ctx.evalIn<T>(expr)` | `evalIn<T>(page, expr)` → `page.evaluate` |
| `ctx.poll(fn, ms)` | `pollEval(page, expr, ms)` / `expect.poll` |
| `ctx.delay(ms)` | `page.waitForTimeout(ms)` |
| `ctx.dbg.terminalPid(id)` | `mainCall<number\|null>(app, 'terminalPid', id)` |
| `ctx.dbg.writeTerminal(id,d)` | `mainCall(app, 'writeTerminal', id, d)` |
| `ctx.dbg.captureView(id)` | `mainCall<{attached,empty}>(app, 'captureView', id)` |
| `ctx.dbg.viewIds()` | `mainCall<string[]>(app, 'viewIds')` |
| `ctx.dbg.viewWebContentsId(id)` | `mainCall<number\|null>(app, 'viewWebContentsId', id)` |
| `ctx.win.webContents.sendInputEvent(e)` | `mainCall(app, 'sendInput', e)` |
| `ctx.ids.*` | local consts per test (seed-and-capture; no shared bag) |

---

## Task 1: Add the Playwright dependency + scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install `@playwright/test` as a devDependency.**

Run: `pnpm add -D @playwright/test`
Expected: `package.json` `devDependencies` gains `@playwright/test`; lockfile updates. (No browser download needed — `_electron` launches the local Electron, not a browser. Do NOT run `playwright install`.)

- [ ] **Step 2: Add the e2e scripts to `package.json`.**

In the `"scripts"` block, after `"test:watch": "vitest"`, add:

```json
    "test:e2e": "playwright test",
    "pretest:e2e": "electron-vite build",
```

(`pretest:e2e` runs automatically before `test:e2e` via npm lifecycle — guarantees `out/` matches the source + native ABI.)

- [ ] **Step 3: Verify the scripts parse.**

Run: `node -e "const s=require('./package.json').scripts; if(!s['test:e2e']||!s['pretest:e2e']) process.exit(1); console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit.**

```bash
git add package.json pnpm-lock.yaml
git commit -m "test(e2e): add @playwright/test devDep + test:e2e/pretest:e2e scripts (T4)"
```

---

## Task 2: Playwright config

**Files:**
- Create: `playwright.config.ts`
- Modify: `.gitignore`
- Modify: `tsconfig.node.json`

- [ ] **Step 1: Write `playwright.config.ts`.**

```ts
import { defineConfig } from '@playwright/test'

// T4: drives the BUILT app (out/main/index.js) via @playwright/test _electron.
// workers:1 + no parallel — native WebContentsView + node-pty + GPU serialize cleanly
// and this dampens the known browser-trio capturePage contention flake
// (memory e2e-browser-trio-flake). This is NOT the Vitest gate (pnpm test stays 680).
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 }
})
```

- [ ] **Step 2: Ignore Playwright output in `.gitignore`.**

Append to `.gitignore`:

```
# Playwright (T4 e2e)
/test-results/
/playwright-report/
/e2e/.cache/
```

- [ ] **Step 3: Add `e2e/` + the config to the node tsconfig include.**

Read `tsconfig.node.json`. In its `"include"` array, add `"e2e/**/*"` and `"playwright.config.ts"` (alongside the existing `electron.vite.config.*` / `src/main` entries). This makes `pnpm typecheck` cover the e2e sources.

- [ ] **Step 4: Verify config loads.**

Run: `pnpm exec playwright test --list`
Expected: `Listing tests:` with `Total: 0 tests in 0 files` (no spec files yet) — proves the config parses and the runner resolves.

- [ ] **Step 5: Commit.**

```bash
git add playwright.config.ts .gitignore tsconfig.node.json
git commit -m "test(e2e): Playwright config (built-app, workers:1) + gitignore + tsconfig (T4)"
```

---

## Task 3: MAIN-side test registry (`src/main/e2eMain.ts`)

**Files:**
- Create: `src/main/e2eMain.ts`
- Modify: `src/main/index.ts`

This exposes the MAIN-only internals the renderer hook can't reach (the 5 `ctx.dbg.*` accessors) PLUS the project/clipboard/input helpers the paste/export slivers need. Env-gated on `CANVAS_E2E` — inert otherwise. `electronApp.evaluate` runs in MAIN and reads `globalThis.__canvasE2EMain`.

- [ ] **Step 1: Write `src/main/e2eMain.ts`.**

```ts
/**
 * Env-gated MAIN test registry for the Playwright _electron harness (T4). Installed
 * ONLY when CANVAS_E2E is set; exposes the preview/pty internals the renderer hook
 * cannot see, plus the project/clipboard/input helpers the whiteboard slivers need.
 * Playwright reaches these via electronApp.evaluate(() => globalThis.__canvasE2EMain.*).
 *
 * This is a registry + an env flag — NOT a security change. sandbox / contextIsolation /
 * nodeIntegration are untouched; nothing here is reachable in a normal run.
 */
import { clipboard, nativeImage, type BrowserWindow } from 'electron'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugCaptureView, debugViewIds, debugViewWebContentsId } from './preview'
import { debugTerminalPid, debugWriteTerminal } from './pty'
import { createProject, setCurrentDir } from './projectStore'

export interface E2EMain {
  terminalPid(id: string): number | null
  writeTerminal(id: string, data: string): boolean
  captureView(id: string): Promise<{ attached: boolean; empty: boolean }>
  viewIds(): string[]
  viewWebContentsId(id: string): number | null
  /** Real OS input through the live window (mouse/keyboard) — preserves transform hit-testing. */
  sendInput(evt: Electron.MouseInputEvent | Electron.KeyboardInputEvent): void
  /** Mint a temp project dir + set it current (e2e has no project dir). Returns the path. */
  createTempProject(prefix: string, name: string): Promise<string>
  /** Clear the current dir + delete the temp project (best-effort). */
  teardownProject(tmp: string): void
  /** Put a w×h opaque-red RGBA bitmap on the system clipboard (for the paste sliver). */
  putRedBitmapOnClipboard(w: number, h: number): void
  /** True if an absolute path exists on disk (assert a pasted blob landed). */
  fileExists(absPath: string): boolean
  /** Join a temp-project path with a relative asset path (cross-platform). */
  joinPath(...parts: string[]): string
}

declare global {
  // eslint-disable-next-line no-var
  var __canvasE2EMain: E2EMain | undefined
}

/** Install the registry. No-op unless CANVAS_E2E is set. Call once after the window exists. */
export function installE2EMain(win: BrowserWindow): void {
  if (!process.env.CANVAS_E2E) return
  globalThis.__canvasE2EMain = {
    terminalPid: debugTerminalPid,
    writeTerminal: debugWriteTerminal,
    captureView: debugCaptureView,
    viewIds: debugViewIds,
    viewWebContentsId: debugViewWebContentsId,
    sendInput(evt) {
      win.webContents.sendInputEvent(evt)
    },
    async createTempProject(prefix, name) {
      const tmp = mkdtempSync(join(tmpdir(), prefix))
      await createProject(tmp, name, {})
      setCurrentDir(tmp)
      return tmp
    },
    teardownProject(tmp) {
      setCurrentDir(null)
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* best-effort temp cleanup */
      }
    },
    putRedBitmapOnClipboard(w, h) {
      const buf = Buffer.alloc(w * h * 4)
      for (let i = 0; i < w * h; i++) {
        buf[i * 4] = 255 // R
        buf[i * 4 + 3] = 255 // A (G/B stay 0 → opaque red)
      }
      clipboard.clear()
      clipboard.writeImage(nativeImage.createFromBitmap(buf, { width: w, height: h }))
    },
    fileExists(absPath) {
      return existsSync(absPath)
    },
    joinPath(...parts) {
      return join(...parts)
    }
  }
}
```

- [ ] **Step 2: Verify the debug accessors it imports exist with these signatures.**

Run: `git grep -nE "export (async )?function (debugCaptureView|debugViewIds|debugViewWebContentsId)" src/main/preview.ts && git grep -nE "export (async )?function (debugTerminalPid|debugWriteTerminal)" src/main/pty.ts`
Expected: 5 matches — `debugCaptureView` (async `{attached,empty}`), `debugViewIds` (`string[]`), `debugViewWebContentsId` (`number|null`), `debugTerminalPid` (`number|null`), `debugWriteTerminal` (`boolean`). If a signature differs, fix `E2EMain` to match.

- [ ] **Step 3: Verify `createProject` / `setCurrentDir` signatures.**

Run: `git grep -nE "export (async )?function (createProject|setCurrentDir)" src/main/projectStore.ts`
Expected: `createProject(dir, name, opts)` and `setCurrentDir(dir: string | null)`. Match `createTempProject` to the real `createProject` arg order.

- [ ] **Step 4: Typecheck the new module.**

Run: `pnpm typecheck`
Expected: clean. (Fix any signature mismatch surfaced here.)

- [ ] **Step 5: Commit.**

```bash
git add src/main/e2eMain.ts
git commit -m "test(e2e): env-gated MAIN registry (dbg accessors + project/clipboard/input helpers) (T4)"
```

---

## Task 4: Wire the `CANVAS_E2E` boot mode into `src/main/index.ts`

The app must, under `CANVAS_E2E=1`: (a) load the renderer with `?e2e=1` so `window.__canvasE2E` installs; (b) install `globalThis.__canvasE2EMain`; (c) NOT run `runE2ESmoke` and NOT auto-quit (Playwright drives + closes). `CANVAS_SMOKE=e2e` keeps working in parallel until Task 14.

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Import the registry installer.**

Near the existing `import { runE2ESmoke } from './e2e'` (line ~15), add:

```ts
import { installE2EMain } from './e2eMain'
```

- [ ] **Step 2: Make the renderer load `?e2e=1` under EITHER flag.**

Find (line ~108): `const e2e = SMOKE === 'e2e'`
Replace with:

```ts
  const e2e = SMOKE === 'e2e' || !!process.env.CANVAS_E2E
```

(The existing `loadURL`/`loadFile` query branch at lines ~109-117 already keys off `e2e`, so the renderer hook now installs under `CANVAS_E2E` too.)

- [ ] **Step 3: Install the MAIN registry right after the window is created.**

Find (line ~144): `createWindow()`
Immediately after it (before the `if (SMOKE && mainWindow)` block), add:

```ts
  if (mainWindow) installE2EMain(mainWindow)
```

- [ ] **Step 4: Verify the self-run block does NOT fire under `CANVAS_E2E`.**

Confirm the block at line ~146 still reads `if (SMOKE && mainWindow)` and `if (SMOKE === 'e2e')`. Under `CANVAS_E2E=1` with `CANVAS_SMOKE` UNSET, `SMOKE` is `undefined` → the block is skipped → no `runE2ESmoke`, no `app.exit`. No change needed; just confirm by reading.

- [ ] **Step 5: Typecheck.**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Smoke the boot mode manually (no Playwright yet).**

Run: `pnpm build`
Then (PowerShell): `$env:CANVAS_E2E='1'; pnpm start`
Expected: the app window opens and STAYS open (does not auto-quit). Close it manually (`Ctrl+C` in the terminal). Then `Remove-Item Env:CANVAS_E2E`.

- [ ] **Step 7: Commit.**

```bash
git add src/main/index.ts
git commit -m "test(e2e): CANVAS_E2E boot mode — instrument app for external Playwright driving (T4)"
```

---

## Task 5: Add `reset()` to the renderer hook

`reset()` returns the app to an empty canvas + tears down all native resources, so each Playwright test starts clean. Reuses `disposeLiveResources()` (the canonical project-switch teardown: `closeAllPreviews` + `disposeAllTerminals`, which reaps live AND parked PTY trees).

**Files:**
- Modify: `src/renderer/src/smoke/e2eHooks.ts`

- [ ] **Step 1: Import the teardown helper.**

At the top of `e2eHooks.ts`, with the other imports, add:

```ts
import { disposeLiveResources } from '../store/disposeLiveResources'
```

- [ ] **Step 2: Add `reset` to the `CanvasE2E` interface.**

In the `interface CanvasE2E { ... }` block, after `fitCameraInstant: (id: string) => void`, add:

```ts
  /**
   * Return the app to an empty canvas for test isolation (T4 Playwright beforeEach):
   * clear full-view/focus UI modes, tear down every native preview view + PTY tree
   * (live AND parked), empty the store + history, and reset the seed-x cursor.
   */
  reset: () => Promise<{ ok: true }>
```

- [ ] **Step 3: Implement `reset` in the `api` object.**

In `installE2EHooks`, inside the `const api: CanvasE2E = { ... }` object, after the `fitCameraInstant(id) { ... }` method, add:

```ts
    async reset() {
      // 1. Clear UI modes first so nothing holds a board reference mid-teardown.
      host.setFullView(null)
      host.setFocus(null)
      host.exitCameraFullView()
      // 2. Empty the store + history (renderer stops referencing the old boards).
      useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
      // 3. Tear down native resources: close all preview views + kill live AND parked
      //    PTY trees (the canonical project-switch teardown). Idempotent / best-effort.
      await disposeLiveResources()
      // 4. Reset the seed-x cursor so the next test's seedBoard positions restart.
      seedX = 0
      return { ok: true as const }
    }
```

- [ ] **Step 4: Typecheck.**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Verify the Vitest gate is still green (the hook is renderer code).**

Run: `pnpm test`
Expected: `680 passed`.

- [ ] **Step 6: Commit.**

```bash
git add src/renderer/src/smoke/e2eHooks.ts
git commit -m "test(e2e): add __canvasE2E.reset() for Playwright per-test isolation (T4)"
```

---

## Task 6: Fixtures + helpers (the shared seam)

**Files:**
- Create: `e2e/helpers.ts`
- Create: `e2e/fixtures.ts`

- [ ] **Step 1: Write `e2e/helpers.ts`.**

```ts
import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from '@playwright/test'

/** Evaluate an expression in the renderer main world (the homegrown `ctx.evalIn`). */
export function evalIn<T>(page: Page, expr: string): Promise<T> {
  // The expr is a self-contained JS expression string (often an IIFE), matching the
  // homegrown probes verbatim. Wrap so `return` value crosses the bridge.
  return page.evaluate((source) => {
    // eslint-disable-next-line no-eval
    return (0, eval)(source)
  }, expr) as Promise<T>
}

/** Call a MAIN registry method via electronApp.evaluate (the homegrown `ctx.dbg.*`). */
export function mainCall<T>(app: ElectronApplication, method: string, ...args: unknown[]): Promise<T> {
  return app.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({}, { method, args }) => (globalThis as any).__canvasE2EMain[method](...args),
    { method, args }
  ) as Promise<T>
}

/** Poll a renderer expression until it returns truthy or the timeout elapses. */
export async function pollEval(page: Page, expr: string, timeoutMs: number): Promise<boolean> {
  try {
    await expect.poll(() => evalIn<unknown>(page, expr), { timeout: timeoutMs }).toBeTruthy()
    return true
  } catch {
    return false
  }
}

/** Seed a board through the real store; returns its id. */
export function seed(page: Page, type: string, patch?: Record<string, unknown>): Promise<string> {
  const patchArg = patch ? `, ${JSON.stringify(patch)}` : ''
  return evalIn<string>(page, `window.__canvasE2E.seedBoard(${JSON.stringify(type)}${patchArg})`)
}
```

> **Note on `eval`:** the homegrown probes are expression STRINGS (`(() => {...})()`). `evalIn` runs them in the renderer via `eval` to port them verbatim. This is test-only code in `e2e/`, never bundled into the app. Add an `/* eslint-disable no-eval */` if the lint config objects (verified in Task 13).

- [ ] **Step 2: Write `e2e/fixtures.ts`.**

```ts
import { _electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test'

type Fixtures = { electronApp: ElectronApplication; page: Page }

/**
 * Per-spec Electron instance. `electronApp` is worker-scoped → launched once per spec
 * file (workers:1 + one spec per worker run), so a spec's native-view/PTY churn can't
 * bleed into another spec. `page` resets the canvas before EACH test.
 */
export const test = base.extend<Record<string, never>, Fixtures>({
  electronApp: [
    async ({}, use) => {
      const app = await _electron.launch({
        args: ['out/main/index.js'],
        env: { ...process.env, CANVAS_E2E: '1' }
      })
      const page = await app.firstWindow()
      // The hook installs after React mounts — wait for it (mirrors runE2ESmoke's 8s gate).
      await expect.poll(() => page.evaluate(() => !!window.__canvasE2E), { timeout: 10_000 }).toBe(true)
      await use(app)
      await app.close()
    },
    { scope: 'worker' }
  ],
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.bringToFront() // sendInputEvent needs the window focused
    await page.evaluate(() => window.__canvasE2E.reset())
    await use(page)
  }
})

export { expect }
```

> The `window.__canvasE2E` global type comes from `e2eHooks.ts`'s `declare global`. If TS in `e2e/` can't see it, Task 13 adds the reference; for now `page.evaluate(() => !!window.__canvasE2E)` is fine (it's `any` across the bridge).

- [ ] **Step 3: Typecheck.**

Run: `pnpm typecheck`
Expected: clean. If `window.__canvasE2E` is unknown in `e2e/`, change `!!window.__canvasE2E` to `!!(window as unknown as { __canvasE2E?: unknown }).__canvasE2E` and proceed.

- [ ] **Step 4: Commit.**

```bash
git add e2e/helpers.ts e2e/fixtures.ts
git commit -m "test(e2e): Playwright fixtures (per-spec launch + reset beforeEach) + driver helpers (T4)"
```

---

## Task 7: Port the terminal spec (first real spec — proves the whole seam)

**Files:**
- Create: `e2e/terminal.e2e.ts`
- Source probes: `src/main/e2e/probes/terminal.ts` (terminal, configNowheel, terminalLod, terminalRespawn, terminalAdopt) + `src/main/e2e/probes/fullview.ts` (terminalFullview).

**Porting rule (applies to all spec tasks):** each probe `run(ctx)` body becomes one `test(...)`. Replace `ctx.evalIn(x)`→`evalIn(page,x)`, `ctx.poll(fn,ms)`→`pollEval(page, expr, ms)` (inline the boolean expr), `ctx.delay(ms)`→`page.waitForTimeout(ms)`, `ctx.dbg.X(...)`→`mainCall(app,'X',...)`, `ctx.win.webContents.sendInputEvent(e)`→`mainCall(app,'sendInput',e)`. Seed what the test needs at its top (no shared `ctx.ids`). The probe's final `ok` boolean becomes `expect(...)` assertions. Constants (`TERM_SENTINEL` etc.) are inlined per spec (see below).

- [ ] **Step 1: Write `e2e/terminal.e2e.ts`.**

```ts
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const TERM_SENTINEL = 'CANVAS_E2E_TERM_OK'
const TERM_SENTINEL2 = 'CANVAS_E2E_RESPAWN_OK'
const ADOPT_MARKER = 'CANVAS_E2E_ADOPT_MARKER'

const readTerm = (id: string) => `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`

test.describe('terminal (node-pty / ConPTY — real instance)', () => {
  test('spawn → echoes the sentinel into the framebuffer', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    const ok = await pollEval(
      page,
      `(() => { const t = ${readTerm(id)}; return typeof t === 'string' && t.includes(${JSON.stringify(TERM_SENTINEL)}); })()`,
      10_000
    )
    expect(ok, 'sentinel in framebuffer').toBe(true)
  })

  test('full view relocates the live subtree — same pid + scrollback survive', async ({ page, electronApp }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    await pollEval(page, `(() => { const t=${readTerm(id)}; return typeof t==='string' && t.includes(${JSON.stringify(TERM_SENTINEL)}); })()`, 10_000)
    const pidBefore = await mainCall<number | null>(electronApp, 'terminalPid', id)
    await evalIn(page, `window.__canvasE2E.setFullView(${JSON.stringify(id)})`)
    await page.waitForTimeout(400)
    const mounted = await evalIn<boolean>(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`)
    const pidDuring = await mainCall<number | null>(electronApp, 'terminalPid', id)
    const text = await evalIn<string | null>(page, readTerm(id))
    await evalIn(page, 'window.__canvasE2E.setFullView(null)')
    await page.waitForTimeout(300)
    const pidAfter = await mainCall<number | null>(electronApp, 'terminalPid', id)
    expect(mounted).toBe(true)
    expect(pidBefore).not.toBeNull()
    expect(pidDuring).toBe(pidBefore)
    expect(pidAfter).toBe(pidBefore)
    expect(typeof text === 'string' && text.includes(TERM_SENTINEL)).toBe(true)
  })

  test('Configure popover carries nowheel (no canvas pan on scroll)', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await evalIn(page, 'window.__canvasE2E.setZoom(1)')
    await page.waitForTimeout(150)
    const cfgOk = await evalIn<boolean>(
      page,
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const node = document.querySelector('.react-flow__node[data-id="${id}"]');
         const cfgBtn = node && node.querySelector('button[title="Configure terminal"]');
         if (!cfgBtn) return false;
         cfgBtn.click(); await sleep(150);
         const ok = !!document.querySelector('.nowheel select');
         cfgBtn.click();
         return ok;
       })()`
    )
    expect(cfgOk, 'config popover has nowheel').toBe(true)
  })

  test('survives LOD zoom-out — does not unmount + kill the PTY', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 5000)
    await evalIn(page, 'window.__canvasE2E.setZoom(0.2)') // < LOD_ZOOM (0.4)
    const alive = await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 3000)
    expect(alive, 'mounted across LOD (session alive)').toBe(true)
  })

  test('config respawn — new session echoes a fresh sentinel under the same id', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    await pollEval(page, `(() => { const t=${readTerm(id)}; return typeof t==='string' && t.includes(${JSON.stringify(TERM_SENTINEL)}); })()`, 10_000)
    await evalIn(page, `window.__canvasE2E.patchBoard(${JSON.stringify(id)}, { launchCommand: 'echo ${TERM_SENTINEL2}' })`)
    const ok = await pollEval(page, `(() => { const t=${readTerm(id)}; return typeof t==='string' && t.includes(${JSON.stringify(TERM_SENTINEL2)}); })()`, 10_000)
    expect(ok, 'new session echoed after respawn').toBe(true)
  })

  test('park + adopt on undo — same pid + replayed scrollback', async ({ page, electronApp }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    await pollEval(page, `(() => { const t=${readTerm(id)}; return typeof t==='string' && t.includes(${JSON.stringify(TERM_SENTINEL)}); })()`, 10_000)
    await mainCall(electronApp, 'writeTerminal', id, `echo ${ADOPT_MARKER}\r`)
    const markerSeen = await pollEval(page, `(() => { const t=${readTerm(id)}; return typeof t==='string' && t.includes(${JSON.stringify(ADOPT_MARKER)}); })()`, 8000)
    const pidBefore = await mainCall<number | null>(electronApp, 'terminalPid', id)
    await evalIn(page, `window.__canvasE2E.deleteBoard(${JSON.stringify(id)})`)
    await page.waitForTimeout(200)
    await evalIn(page, 'window.__canvasE2E.undo()')
    const adopted = await pollEval(
      page,
      `(() => { const t=${readTerm(id)}; return typeof t==='string' && t.includes(${JSON.stringify(ADOPT_MARKER)}); })()`,
      10_000
    )
    const pidNow = await mainCall<number | null>(electronApp, 'terminalPid', id)
    expect(markerSeen).toBe(true)
    expect(pidBefore).not.toBeNull()
    expect(pidNow).toBe(pidBefore)
    expect(adopted, 'scrollback replayed after undo').toBe(true)
  })
})
```

- [ ] **Step 2: Run the terminal spec.**

Run: `pnpm test:e2e e2e/terminal.e2e.ts`
Expected: `pretest:e2e` builds, then `6 passed`. (First run builds `out/` — slower.)

- [ ] **Step 3: If a test fails, debug with the report, not by weakening the assertion.**

Run: `pnpm exec playwright test e2e/terminal.e2e.ts --debug` (or read `test-results/`). Common causes: hook not installed (the fixture poll catches this), pid `null` (the PTY didn't spawn — check the built node-pty ABI), timing (raise the specific `pollEval` timeout, never delete the assertion).

- [ ] **Step 4: Commit.**

```bash
git add e2e/terminal.e2e.ts
git commit -m "test(e2e): port terminal keep-set to Playwright (spawn/fullview/nowheel/LOD/respawn/adopt) (T4)"
```

---

## Task 8: Port the browser spec

**Files:**
- Create: `e2e/browser.e2e.ts`
- Source: `src/main/e2e/probes/browserPreview.ts` (browser, browserGesture, focusDetach, browserDeadUrl).

**Key port notes:** the local preview URL the `browser` probe used (`ctx.localUrl`) is the in-process localServer URL. In the Playwright app it's available to the renderer via the preview default; seed the browser with the SAME deterministic URL by reading it from MAIN, OR point at the localServer. Simplest: expose nothing new — seed at the localServer URL the app already serves. Read it once: the app's `defaultPreviewUrl` is the localServer URL; the renderer doesn't expose it, so seed at a known-good page. **Use `http://127.0.0.1:<port>`?** Not deterministic. Instead, the browser probe just needs SOME reachable page that connects. Seed at the app's own renderer origin is not valid (native view). **Resolution:** add `localUrl` to the MAIN registry.

- [ ] **Step 1: Add `localUrl` to the MAIN registry.**

In `src/main/index.ts`, the localServer URL is `localServer.url` (or `defaultPreviewUrl`). Pass it into `installE2EMain`. Change the installer call (Task 4 Step 3) to `installE2EMain(mainWindow, defaultPreviewUrl)` and extend `e2eMain.ts`:

In `src/main/e2eMain.ts`, change the signature to `installE2EMain(win: BrowserWindow, localUrl: string)`, add `localUrl(): string` to the `E2EMain` interface, and in the registry object add:

```ts
    localUrl() {
      return localUrl
    },
```

Run: `pnpm typecheck` → clean. Commit this small change with the browser spec at the end.

- [ ] **Step 2: Write `e2e/browser.e2e.ts`.**

```ts
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const runtimeLive = (id: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.live === true; })()`
const runtimeStatus = (id: string, status: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`

test.describe('browser preview (native WebContentsView — real instance)', () => {
  test('connects + a per-view capturePage is non-blank', async ({ page, electronApp }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    const connected = await pollEval(page, runtimeStatus(id, 'connected'), 10_000)
    expect(connected, 'browser reaches connected').toBe(true)
    await page.waitForTimeout(300) // one paint before capture
    const cap = await mainCall<{ attached: boolean; empty: boolean }>(electronApp, 'captureView', id)
    expect(cap.attached, 'native view attached').toBe(true)
    expect(cap.empty, 'capture is non-blank').toBe(false)
  })

  test('node gesture detaches the live view → reattaches on end', async ({ page }) => {
    const url = await evalIn<string>(page, '""') // placeholder; replaced below
    void url
  })

  test('focus elsewhere detaches the browser view → reattaches on unfocus', async ({ page, electronApp }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const browserId = await seed(page, 'browser', { url })
    const termId = await seed(page, 'terminal', { launchCommand: 'echo focus' })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
    expect(await pollEval(page, runtimeStatus(browserId, 'connected'), 10_000)).toBe(true)
    await pollEval(page, runtimeLive(browserId), 5000)
    await evalIn(page, `window.__canvasE2E.setFocus(${JSON.stringify(termId)})`)
    await page.waitForTimeout(500)
    const capFocused = await mainCall<{ attached: boolean }>(electronApp, 'captureView', browserId)
    await evalIn(page, 'window.__canvasE2E.setFocus(null)')
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
    const reattached = await pollEval(page, runtimeLive(browserId), 8000)
    expect(capFocused.attached, 'detached on focus').toBe(false)
    expect(reattached, 'reattached on unfocus').toBe(true)
  })

  test('refused URL ends as load-failed (not connected)', async ({ page }) => {
    const id = await seed(page, 'browser', { url: 'http://127.0.0.1:59999/' })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    const failed = await pollEval(page, runtimeStatus(id, 'load-failed'), 12_000)
    expect(failed, 'refused URL → load-failed').toBe(true)
  })
})
```

- [ ] **Step 3: Replace the placeholder gesture test body** with the real port of `browserGesture` (source `browserPreview.ts:45-72`):

```ts
  test('node gesture detaches the live view → reattaches on end', async ({ page, electronApp }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    expect(await pollEval(page, runtimeStatus(id, 'connected'), 10_000)).toBe(true)
    await pollEval(page, runtimeLive(id), 5000)
    await evalIn(page, 'window.__canvasE2E.setGesture(true)')
    const detached = await pollEval(
      page,
      `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.live === false; })()`,
      5000
    )
    await evalIn(page, 'window.__canvasE2E.setGesture(false)')
    const reattached = await pollEval(page, runtimeLive(id), 8000)
    expect(detached, 'detached on gesture start').toBe(true)
    expect(reattached, 'reattached on gesture end').toBe(true)
  })
```

- [ ] **Step 4: Run the browser spec.**

Run: `pnpm test:e2e e2e/browser.e2e.ts`
Expected: `4 passed`. The capturePage tests may flake on a contended host (memory `e2e-browser-trio-flake`) — **rerun for a clean pass**, do not weaken.

- [ ] **Step 5: Commit (includes the Step-1 registry change).**

```bash
git add e2e/browser.e2e.ts src/main/e2eMain.ts src/main/index.ts
git commit -m "test(e2e): port browser keep-set (capture/gesture/focus-detach/dead-url) + registry localUrl (T4)"
```

---

## Task 9: Port the fullview spec

**Files:**
- Create: `e2e/fullview.e2e.ts`
- Source: `src/main/e2e/probes/fullview.ts` (fullviewPreview→2 parts, fullviewSelfPreserve, fullviewEmulator, fullviewClose).

Port each probe to a `test`, seeding its own browser/planning/terminal boards. The `fullviewPreview` probe emits TWO parts (`fullview-preview` + `fullview-preserve`) → make it ONE test with two assertion groups (it's one scenario). Use `mainCall(app,'viewIds')` and `mainCall(app,'viewWebContentsId',id)` for the survival checks.

- [ ] **Step 1: Write `e2e/fullview.e2e.ts`** (port verbatim from the source probe bodies, applying the porting rule). Seeds per test:
  - preview/preserve: seed a browser (at `localUrl`) + a planning board; full-view the PLANNING board; `addChecklist`; assert `captureView(browser).attached===false` AND `viewIds().includes(browser)===true`; exit.
  - self-preserve: seed a browser; wait `connected`; capture `viewWebContentsId` before/`openFullViewAnimated`/after `closeFullViewAnimated`; assert all three equal + non-null.
  - emulator: seed a browser; `patchBoard({viewport:'mobile'})`; `setFullView`; read the `[data-bb-frame]` rect ratios (the source `evalIn` block ports verbatim); assert portrait + letterboxed.
  - close: seed a terminal; `setFullView`; dispatch Escape from the focused `.xterm-helper-textarea`; assert frame mounts + band gone + modal unmounts.

  Full code for the two survival tests (the rest port mechanically from the source — copy the source `evalIn` string blocks unchanged, they are renderer JS):

```ts
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const live = (id: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.live === true; })()`
const status = (id: string, s: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(s)}; })()`

test.describe('full view (native rebind — real instance)', () => {
  test('a full-viewed OTHER board: browser stays detached through a mutation + webContents survives', async ({ page, electronApp }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const browserId = await seed(page, 'browser', { url })
    const planId = await seed(page, 'planning')
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
    expect(await pollEval(page, live(browserId), 6000)).toBe(true)
    await evalIn(page, `window.__canvasE2E.setFullView(${JSON.stringify(planId)})`)
    await page.waitForTimeout(400)
    await evalIn(page, `window.__canvasE2E.addChecklist(${JSON.stringify(planId)})`)
    await page.waitForTimeout(400)
    const cap = await mainCall<{ attached: boolean }>(electronApp, 'captureView', browserId)
    const survived = (await mainCall<string[]>(electronApp, 'viewIds')).includes(browserId)
    await evalIn(page, 'window.__canvasE2E.setFullView(null)')
    await page.waitForTimeout(300)
    expect(cap.attached, 'browser stayed detached over the modal').toBe(false)
    expect(survived, 'browser webContents survived full view').toBe(true)
  })

  test('full-viewing the browser ITSELF keeps the same webContents (no restart)', async ({ page, electronApp }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const browserId = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
    expect(await pollEval(page, status(browserId, 'connected'), 6000)).toBe(true)
    const before = await mainCall<number | null>(electronApp, 'viewWebContentsId', browserId)
    await evalIn(page, `window.__canvasE2E.openFullViewAnimated(${JSON.stringify(browserId)})`)
    await page.waitForTimeout(700)
    const during = await mainCall<number | null>(electronApp, 'viewWebContentsId', browserId)
    await evalIn(page, 'window.__canvasE2E.closeFullViewAnimated()')
    await page.waitForTimeout(700)
    const after = await mainCall<number | null>(electronApp, 'viewWebContentsId', browserId)
    expect(before).not.toBeNull()
    expect(during).toBe(before)
    expect(after).toBe(before)
  })

  // emulator + close tests: port fullviewEmulator (fullview.ts:142-189) and fullviewClose
  // (fullview.ts:196-230) here — copy each source `evalIn` string block UNCHANGED (it is
  // renderer JS), seed a browser (mobile) / terminal respectively, and turn the probe's
  // final `ok` boolean into the same expect(...) assertions.
})
```

- [ ] **Step 2: Add the `emulator` + `close` tests** by porting `fullviewEmulator` and `fullviewClose` verbatim (the source `evalIn` blocks are copy-paste; wrap their result objects in `expect`). For `fullviewClose`, the seed is a terminal with a sentinel launchCommand so the xterm textarea exists.

- [ ] **Step 3: Run.**

Run: `pnpm test:e2e e2e/fullview.e2e.ts`
Expected: `4 passed`.

- [ ] **Step 4: Commit.**

```bash
git add e2e/fullview.e2e.ts
git commit -m "test(e2e): port full-view keep-set (preserve/self-preserve/emulator/close) (T4)"
```

---

## Task 10: Port the menu spec

**Files:**
- Create: `e2e/menu.e2e.ts`
- Source: `src/main/e2e/probes/menu.ts` (menuChrome, menuPreviewDetach).

Both probes' `evalIn` string blocks port UNCHANGED. `menuChrome` seeds a terminal, `patchBoard({w:150})`, then runs the source block (title-bar containment + `panBy` overshoot + viewport clamp + `restColor`). `menuPreviewDetach` seeds a browser at `localUrl`, waits live, runs the source occlusion block.

- [ ] **Step 1: Write `e2e/menu.e2e.ts`** — two tests, porting the source bodies:

```ts
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

test.describe('board ⋯ menu (real layout / native occlusion)', () => {
  test('⋯ trigger stays in the title bar + popover clamps on-screen + visible at rest', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo menu', w: 150 })
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await evalIn(page, 'window.__canvasE2E.setZoom(1)')
    await page.waitForTimeout(150)
    // Source: menu.ts:32-56 — copy the evalIn block UNCHANGED, substituting ${termId}=id.
    const chrome = await evalIn<{ found: boolean; triggerInBar: boolean; restColor: string; inViewport: boolean }>(
      page,
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const sel = (s, root) => (root || document).querySelector(s);
         const node = sel('.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(id)}) + ']');
         const bar = node && sel('.board-titlebar', node);
         const more = node && sel('button[title="More"]', node);
         if (!bar || !more) return { found: false, triggerInBar: false, restColor: '', inViewport: false };
         const b = bar.getBoundingClientRect();
         const t = more.getBoundingClientRect();
         const triggerInBar = t.width > 0 && t.left >= b.left - 0.5 && t.right <= b.right + 0.5;
         const svg = more.querySelector('svg');
         const restColor = svg ? getComputedStyle(svg).color : '';
         const overshoot = (window.innerWidth - t.right) + 40;
         window.__canvasE2E.panBy(overshoot, 0);
         await sleep(80);
         const more2 = sel('button[title="More"]', node);
         more2.click(); await sleep(80);
         const menu = sel('.board-menu');
         const m = menu && menu.getBoundingClientRect();
         const inViewport = !!m && m.left >= 0 && m.top >= 0 && m.right <= window.innerWidth && m.bottom <= window.innerHeight;
         more2.click(); await sleep(40);
         window.__canvasE2E.panBy(-overshoot, 0);
         return { found: true, triggerInBar, restColor, inViewport };
       })()`
    )
    expect(chrome.found).toBe(true)
    expect(chrome.triggerInBar, '⋯ within the title bar (13)').toBe(true)
    expect(chrome.inViewport, 'popover clamps on-screen (14)').toBe(true)
    expect(chrome.restColor, 'rest colour resolves the CSS var').toBe('rgb(155, 155, 161)')
  })

  test('open ⋯ menu detaches the live preview (un-occludes the popover) → reattaches on close', async ({ page, electronApp }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await evalIn(page, 'window.__canvasE2E.setZoom(1)')
    await page.waitForTimeout(250)
    // Source: menu.ts:86-100 — copy UNCHANGED, substituting the browser id.
    const occl = await evalIn<{ found: boolean; liveBefore: boolean; liveDuringMenu: boolean; liveAfter: boolean }>(
      page,
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const sel = (s, root) => (root || document).querySelector(s);
         const id = ${JSON.stringify(id)};
         const live = () => !!(window.__canvasE2E.getRuntime(id) || {}).live;
         const node = sel('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const more = node && sel('button[title="More"]', node);
         if (!more) return { found: false, liveBefore: false, liveDuringMenu: false, liveAfter: false };
         const liveBefore = live();
         more.click(); await sleep(250);
         const liveDuringMenu = live();
         more.click(); await sleep(300);
         const liveAfter = live();
         return { found: true, liveBefore, liveDuringMenu, liveAfter };
       })()`
    )
    expect(occl.found).toBe(true)
    expect(occl.liveBefore, 'live before open').toBe(true)
    expect(occl.liveDuringMenu, 'detached while menu open').toBe(false)
    expect(occl.liveAfter, 'reattached on close').toBe(true)
  })
})
```

- [ ] **Step 2: Run.**

Run: `pnpm test:e2e e2e/menu.e2e.ts`
Expected: `2 passed`.

- [ ] **Step 3: Commit.**

```bash
git add e2e/menu.e2e.ts
git commit -m "test(e2e): port menu slivers (chrome layout/clamp + preview detach) (T4)"
```

---

## Task 11: Port the previewLink spec

**Files:**
- Create: `e2e/previewLink.e2e.ts`
- Source: `src/main/e2e/probes/previewLink.ts` (previewConnectGesture).

This is one scenario: seed a terminal (w:360) + a browser; `mainCall('writeTerminal', termId, 'echo http://localhost:3000/\r')`; wait for the URL in the framebuffer; run the source gesture `evalIn` block UNCHANGED (it drives `window.api.detectPorts` + the globe long-press/right-click/tap via DOM MouseEvents); read `linkAfter`; assert hold+right-click open the picker, Connect links the browser, tap does NOT reopen.

- [ ] **Step 1: Write `e2e/previewLink.e2e.ts`:**

```ts
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const DETECTED_URL = 'http://localhost:3000'

test.describe('terminal → browser preview link (live port-detect + gesture routing)', () => {
  test('hold / right-click open the connect picker; Connect links; tap refreshes (no picker)', async ({ page, electronApp }) => {
    const termId = await seed(page, 'terminal', { launchCommand: 'echo link', w: 360 })
    const url = await mainCall<string>(electronApp, 'localUrl')
    const browserId = await seed(page, 'browser', { url })
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(termId)})`)
    await evalIn(page, 'window.__canvasE2E.setZoom(1)')
    await mainCall(electronApp, 'writeTerminal', termId, 'echo http://localhost:3000/\r')
    const urlSeen = await pollEval(
      page,
      `(() => { const t = window.__canvasE2E.readTerminal(${JSON.stringify(termId)}); return typeof t === 'string' && t.includes('localhost:3000'); })()`,
      8000
    )
    // Source: previewLink.ts:40-82 — copy the gesture evalIn block UNCHANGED (substitute termId).
    const gesture = await evalIn<{
      detected: string[]; holdOpened: boolean; holdTitle: boolean; holdCount: number; rightOpened: boolean; tapOpened: boolean
    }>(
      page,
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const detected = (await window.api.detectPorts(${JSON.stringify(termId)})).map((u) => u.url);
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(termId)}) + ']');
         const globe = node && node.querySelector('button[title*="choose browser"]');
         const picker = () => node.querySelector('.ca-port-picker');
         const pickerHas = (txt) => { const p = picker(); return !!p && p.textContent.includes(txt); };
         if (!globe) return { detected, holdOpened: false, holdTitle: false, holdCount: 0, rightOpened: false, tapOpened: false };
         globe.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
         await sleep(700);
         globe.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
         globe.dispatchEvent(new MouseEvent('click', { bubbles: true }));
         await sleep(600);
         const holdOpened = !!picker();
         const holdTitle = pickerHas('Push to which browser');
         const holdCount = picker() ? picker().querySelectorAll('.ca-browser-choice input').length : 0;
         const cancel = picker() && picker().querySelector('.ca-preview-dismiss');
         if (cancel) cancel.click();
         await sleep(120);
         globe.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
         await sleep(600);
         const rightOpened = !!picker();
         const firstBox = picker() && picker().querySelector('.ca-browser-choice input');
         if (firstBox) { firstBox.click(); await sleep(60); const c = picker().querySelector('.ca-browser-connect'); if (c) c.click(); }
         await sleep(200);
         globe.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
         globe.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
         globe.dispatchEvent(new MouseEvent('click', { bubbles: true }));
         await sleep(700);
         const tapOpened = !!picker();
         return { detected, holdOpened, holdTitle, holdCount, rightOpened, tapOpened };
       })()`
    )
    await page.waitForTimeout(150)
    const linkAfter = await evalIn<{ source: string | null; url: string }>(
      page,
      `(() => { const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(browserId)}); return { source: (b && b.type === 'browser' ? (b.previewSourceId ?? null) : null), url: (b && b.type === 'browser' ? b.url : '') }; })()`
    )
    expect(urlSeen, 'dev-server URL echoed into the terminal').toBe(true)
    expect(gesture.holdOpened, 'long-press opens picker').toBe(true)
    expect(gesture.holdTitle).toBe(true)
    expect(gesture.holdCount).toBeGreaterThanOrEqual(2)
    expect(gesture.rightOpened, 'right-click opens picker').toBe(true)
    expect(gesture.tapOpened, 'tap does NOT reopen picker').toBe(false)
    expect(linkAfter.source).toBe(termId)
    expect(linkAfter.url).toBe(DETECTED_URL)
  })
})
```

- [ ] **Step 2: Run.**

Run: `pnpm test:e2e e2e/previewLink.e2e.ts`
Expected: `1 passed`. (Known historical ConPTY-wrap flake on contended hosts — rerun for clean.)

- [ ] **Step 3: Commit.**

```bash
git add e2e/previewLink.e2e.ts
git commit -m "test(e2e): port preview-connect-gesture sliver (live port-detect + long-press) (T4)"
```

---

## Task 12: Port the whiteboard spec (real OS input + MAIN-side project/clipboard)

**Files:**
- Create: `e2e/whiteboard.e2e.ts`
- Source: `src/main/e2e/probes/whiteboard.ts` (whiteboardFullviewAdd, whiteboardPasteImage, whiteboardExport).

These need real OS input (`sendInput`) and MAIN-side project/clipboard ops (now on the registry). The fullview-add probe's two big `evalIn` blocks (fit-poll + target-rect) port UNCHANGED; only `ctx.win.webContents.sendInputEvent(...)`→`mainCall(app,'sendInput',...)` and the temp-project/clipboard calls→`mainCall`.

- [ ] **Step 1: Write `e2e/whiteboard.e2e.ts`** with three tests:

```ts
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

test.describe('whiteboard slivers (real OS input / native pipeline)', () => {
  test('full-view add-note: a real click lands in-bounds through the live camera transform', async ({ page, electronApp }) => {
    const planId = await seed(page, 'planning')
    await evalIn(page, `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 520, h: 500, elements: [
      { id: 'fv-a', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 },
      { id: 'fv-b', kind: 'note', x: 300, y: 320, w: 156, h: 96, tint: 'blue', text: 'B', rotation: 0 }
    ] })`)
    await page.waitForTimeout(180)
    await evalIn(page, `window.__canvasE2E.enterCameraFullView(${JSON.stringify(planId)})`)
    // Source: whiteboard.ts:59-85 fit-poll block — port via pollEval (copy the inner expr UNCHANGED).
    const fitted = await pollEval(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         window.__canvasE2E.fitCameraInstant(id);
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const well = node && node.querySelector('.pl-well');
         if (!well || !(well.offsetWidth > 0)) return false;
         const r = well.getBoundingClientRect();
         const scale = r.width / well.offsetWidth;
         return scale > 0.4 && r.left >= -2 && r.top >= -2 && r.right <= window.innerWidth + 2 && r.bottom <= window.innerHeight + 2;
       })()`,
      4000
    )
    expect(fitted, 'camera fit the board on-screen').toBe(true)
    await page.waitForTimeout(60)
    const t = await evalIn<{ found: boolean; sx: number; sy: number; scale: number; bx: number; by: number }>(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const well = node && node.querySelector('.pl-well');
         if (!well) return { found: false, sx: 0, sy: 0, scale: 0, bx: 0, by: 0 };
         const r = well.getBoundingClientRect();
         const scale = well.offsetWidth > 0 ? r.width / well.offsetWidth : 1;
         const bx = 260, by = 250;
         return { found: true, sx: r.left + bx * scale, sy: r.top + by * scale, scale, bx, by };
       })()`
    )
    expect(t.found).toBe(true)
    // Select the note tool (synthetic key is fine — no coordinate mapping).
    await evalIn(page, `(() => {
       const id = ${JSON.stringify(planId)};
       const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
       const well = node && node.querySelector('.pl-well');
       if (well) { well.focus(); well.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })); }
     })()`)
    await page.waitForTimeout(60)
    const x = Math.round(t.sx), y = Math.round(t.sy)
    await mainCall(electronApp, 'sendInput', { type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    await mainCall(electronApp, 'sendInput', { type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await page.waitForTimeout(140)
    const res = await evalIn<{ count: number; nx: number; ny: number; nw: number; bw: number; bh: number }>(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const b = window.__canvasE2E.getBoards().find((x) => x.id === id);
         const els = b && b.type === 'planning' ? b.elements : [];
         const added = els.filter((e) => e.kind === 'note' && e.id !== 'fv-a' && e.id !== 'fv-b').pop();
         return { count: els.length, nx: added ? added.x : -999999, ny: added ? added.y : -999999, nw: added ? added.w : 0, bw: b ? b.w : 0, bh: b ? b.h : 0 };
       })()`
    )
    await evalIn(page, 'window.__canvasE2E.exitCameraFullView()')
    const clickX = res.nx + res.nw / 2, clickY = res.ny + 20
    expect(res.count, 'a third note was added').toBe(3)
    expect(res.nx >= 0 && res.nx <= res.bw && res.ny >= 0 && res.ny <= res.bh, 'note in bounds').toBe(true)
    expect(Math.abs(clickX - t.bx) <= 10 && Math.abs(clickY - t.by) <= 10, 'note near the click point').toBe(true)
  })

  test('real Ctrl+V paste persists a blob to assets/<sha1>.png (relative path, on disk)', async ({ page, electronApp }) => {
    const planId = await seed(page, 'planning')
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'canvas-w4-', 'w4')
    try {
      await evalIn(page, `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { elements: [] })`)
      await page.waitForTimeout(80)
      await mainCall(electronApp, 'putRedBitmapOnClipboard', 10, 10)
      await evalIn(page, `(() => { const n = document.querySelector('.react-flow__node[data-id=' + ${JSON.stringify(JSON.stringify(planId))} + ']'); const w = n && n.querySelector('.pl-well'); if (w) w.focus(); })()`)
      await page.waitForTimeout(40)
      await mainCall(electronApp, 'sendInput', { type: 'keyDown', keyCode: 'V', modifiers: ['control'] })
      await mainCall(electronApp, 'sendInput', { type: 'char', keyCode: 'V', modifiers: ['control'] })
      await mainCall(electronApp, 'sendInput', { type: 'keyUp', keyCode: 'V', modifiers: ['control'] })
      const pasted = await pollEval(
        page,
        `(() => { const b = window.__canvasE2E.getBoards().find(x => x.id === ${JSON.stringify(planId)}); return b && b.type === 'planning' ? b.elements.filter(e => e.kind === 'image').length === 1 : false; })()`,
        4000
      )
      const assetId = await evalIn<string | null>(
        page,
        `(() => { const b = window.__canvasE2E.getBoards().find(x => x.id === ${JSON.stringify(planId)}); const img = (b && b.type === 'planning' ? b.elements : []).find(e => e.kind === 'image'); return img ? img.assetId : null; })()`
      )
      const relOk = !!assetId && /^assets[/\\][0-9a-f]{40}\.png$/.test(assetId) && !assetId.startsWith('data:')
      const fileOk = !!assetId && (await mainCall<boolean>(electronApp, 'fileExists', await mainCall<string>(electronApp, 'joinPath', tmp, assetId)))
      expect(pasted, 'one image element added').toBe(true)
      expect(relOk, 'relative assets/<sha1>.png path').toBe(true)
      expect(fileOk, 'blob written to disk').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('PNG export rasters a non-trivial byte stream through the offscreen-canvas pipeline', async ({ page, electronApp }) => {
    const planId = await seed(page, 'planning')
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'canvas-w5-', 'w5')
    try {
      await evalIn(page, `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { elements: [
        { id: 'ex-note', kind: 'note', x: 20, y: 20, w: 156, h: 96, tint: 'blue', text: 'export me', rotation: 0 },
        { id: 'ex-stroke', kind: 'stroke', x: 0, y: 0, points: [40,200,80,240,120,210] },
        { id: 'ex-check', kind: 'checklist', x: 220, y: 20, w: 240, h: 0, title: 'T', items: [{ id:'a', label:'one', done:true }, { id:'b', label:'two', done:false }] }
      ] })`)
      await page.waitForTimeout(120)
      const png = await evalIn<{ byteLength: number } | null>(page, `window.__canvasE2E.exportBoard(${JSON.stringify(planId)}, 'png')`)
      expect(png, 'export returned a PNG summary').not.toBeNull()
      expect(png!.byteLength, 'PNG bytes are non-trivial').toBeGreaterThan(200)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
```

- [ ] **Step 2: Run.**

Run: `pnpm test:e2e e2e/whiteboard.e2e.ts`
Expected: `3 passed`. (The fullview-add test needs the window focused — the `page.bringToFront()` in the fixture handles it; if the click misses, confirm focus.)

- [ ] **Step 3: Commit.**

```bash
git add e2e/whiteboard.e2e.ts
git commit -m "test(e2e): port whiteboard slivers (fullview-add real click / paste / PNG export) (T4)"
```

---

## Task 13: Full-suite green + static tier

**Files:**
- Modify (if lint objects to `eval`/test globals): `eslint.config.*` (add an `e2e/**` override) — only if Step 2 fails.

- [ ] **Step 1: Run the whole Playwright suite (all specs, fresh build).**

Run: `pnpm test:e2e`
Expected: `pretest:e2e` builds, then all specs pass (terminal 6 + browser 4 + fullview 4 + menu 2 + previewLink 1 + whiteboard 3 = **20 tests**). Rerun once if the browser/preview trio flakes (memory `e2e-browser-trio-flake` / ConPTY-wrap) — a clean rerun is a pass, not a regression.

- [ ] **Step 2: Lint the e2e sources.**

Run: `pnpm lint`
Expected: 0 errors (the pre-existing `PlanningBoard.tsx` no-console WARNING is fine). If `no-eval` or `no-undef` (for `window`) errors fire on `e2e/`, add an override block to the ESLint flat config:

```js
  {
    files: ['e2e/**/*.ts'],
    rules: { 'no-eval': 'off' },
    languageOptions: { globals: { window: 'readonly' } }
  }
```

- [ ] **Step 3: Typecheck + format.**

Run: `pnpm typecheck`
Expected: clean.

Run: `pnpm run format:check`
Expected: clean. If it flags the new files, run `pnpm format` and re-stage.

- [ ] **Step 4: Confirm the Vitest gate is untouched.**

Run: `pnpm test`
Expected: `680 passed`.

- [ ] **Step 5: Commit (only if Step 2/3 changed files).**

```bash
git add eslint.config.* e2e/
git commit -m "test(e2e): lint/format the Playwright e2e sources (T4)"
```

---

## Task 14: Retire the homegrown `CANVAS_SMOKE=e2e` harness

Only after Task 13 is green. This deletes the old harness; `CANVAS_E2E` (Playwright) is now the sole e2e path.

**Files:**
- Delete: `src/main/e2e/**`
- Modify: `src/main/index.ts`
- Delete (conditional): `src/main/e2eReport.ts`, `src/main/e2eReport.test.ts`

- [ ] **Step 1: Confirm nothing outside `src/main/e2e/` imports it.**

Run: `git grep -n "from './e2e'" -- src/main; git grep -rn "src/main/e2e" -- src e2e`
Expected: only the `import { runE2ESmoke } from './e2e'` in `src/main/index.ts`. If anything else references it, stop and reassess.

- [ ] **Step 2: Check the `e2eReport` consumers.**

Run: `git grep -n "e2eReport\|summarizeE2E" -- src`
Expected: references only from `src/main/e2e/**` (the harness) and `src/main/e2eReport.test.ts`. If so, `e2eReport.ts` + its test can be deleted with the harness. If the renderer or another module uses it, KEEP `e2eReport.ts`.

- [ ] **Step 3: Remove the `CANVAS_SMOKE=e2e` wiring from `index.ts`.**

In `src/main/index.ts`:
- Delete the import `import { runE2ESmoke } from './e2e'`.
- In `createWindow`, change `const e2e = SMOKE === 'e2e' || !!process.env.CANVAS_E2E` to:

```ts
  const e2e = !!process.env.CANVAS_E2E
```

- In the `did-finish-load` block, delete the entire `if (SMOKE === 'e2e') { ... } else { ... }` branch and keep only the self-test path. The block becomes:

```ts
  if (SMOKE && mainWindow) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const ok = await runSelfTest(mainWindow!, localServer!.url)
      smokeLog(`SELFTEST_DONE ${JSON.stringify(ok)}`)
      if (SMOKE === 'exit') setTimeout(() => app.quit(), 400)
    })
  }
```

- Update the `SMOKE` comment (line ~21) to drop `"e2e"=board harness+quit` (now: `"1"=self-test, "exit"=self-test+quit`).
- The EPIPE guard `if (SMOKE) process.stdout.on('error', ...)` stays (still used by self-test).

- [ ] **Step 4: Delete the harness directory (+ e2eReport if Step 2 cleared it).**

```bash
git rm -r src/main/e2e
git rm src/main/e2eReport.ts src/main/e2eReport.test.ts   # ONLY if Step 2 showed no other consumer
```

- [ ] **Step 5: Typecheck + Vitest + build.**

Run: `pnpm typecheck`
Expected: clean (no dangling `runE2ESmoke` / `summarizeE2E` references).

Run: `pnpm test`
Expected: `680 passed` if `e2eReport.test.ts` was KEPT; if it was deleted (4 tests), expect `676 passed` — confirm the delta equals only the removed `e2eReport` tests, nothing else.

Run: `pnpm build`
Expected: builds clean.

- [ ] **Step 6: Confirm the Playwright suite still passes against the rebuilt app.**

Run: `pnpm test:e2e`
Expected: all 20 tests green (the `CANVAS_E2E` path is independent of the deleted `CANVAS_SMOKE=e2e` path).

- [ ] **Step 7: Confirm the harness is gone.**

Run: `git grep -rn "src/main/e2e\|runE2ESmoke\|CANVAS_SMOKE=e2e" -- src docs/testing`
Expected: no source hits (doc mentions in TESTING.md history are fine to leave or update in Task 15).

- [ ] **Step 8: Commit.**

```bash
git add -A src/main
git commit -m "test(e2e): retire the CANVAS_SMOKE=e2e homegrown harness — Playwright reaches parity (T4)"
```

---

## Task 15: Docs + memory + push

**Files:**
- Modify: `docs/testing/TESTING.md`

- [ ] **Step 1: Update `TESTING.md` E2E rows.**

In the tier table, change the E2E row's "Runs in" from `the e2e harness (today CANVAS_SMOKE; Playwright _electron after roadmap T4)` to `Playwright _electron (pnpm test:e2e)`. Add a short "## E2E — Playwright (T4)" section: the `e2e/` layout, the `CANVAS_E2E=1` boot mode, the `window.__canvasE2E` + `globalThis.__canvasE2EMain` seams, per-spec launch + `reset()` isolation, and "MAIN-helpers only — never weaken the sandbox". Note T5 still owes the CI gate re-enable + process-tree-kill + auto-update.

- [ ] **Step 2: Verify the doc.**

Run: `pnpm run format:check`
Expected: clean (run `pnpm format` if needed).

- [ ] **Step 3: Commit + push.**

```bash
git add docs/testing/TESTING.md
git commit -m "docs(testing): document the Playwright _electron e2e harness (T4)"
git push
```

Expected: PR #37 updates.

- [ ] **Step 4: Update memory `testing-strategy`.**

Append "T4 SHIPPED" to `C:\Users\De Asis PC\.claude\projects\Z--Canvas-ADE\memory\testing-strategy.md`: the launch recipe (`_electron.launch({ args:['out/main/index.js'], env:{CANVAS_E2E:'1'} })`), the two seams (`__canvasE2E` reused via `page.evaluate` + new `globalThis.__canvasE2EMain` via `electronApp.evaluate`), per-spec + `reset()` isolation, `workers:1`, parity-then-delete done, and **T5 is next** (re-enable smoke CI gate + process-tree-kill + auto-update, gated on Phase 5 packaging). Keep the `MEMORY.md` one-liner pointer current.

- [ ] **Step 5: Finish the branch.**

Use superpowers:finishing-a-development-branch → "Push and create a PR" (PR #37 already exists; this just pushes the final state).

---

## Self-review (completed during planning)

**Spec coverage:** every spec section maps to a task — deps/config (T1-2), MAIN registry (T3), boot mode (T4), reset (T5), fixtures/helpers (T6), the 6 ported specs (T7-12), gate (T13), retire (T14), docs/memory (T15). The spec's 3 open questions are resolved: reset teardown order (T5 Step 3, via `disposeLiveResources`), launch recipe (T6 fixture, built `out/`), evaluate serialization (helpers return scalars/small objects, never raw PNG buffers — `exportBoard` already returns `{byteLength}`).

**Placeholder scan:** the only "port the source block UNCHANGED" directives (T9 Step 2, T10/T11 reference the source line ranges) are paired with the full code for the load-bearing tests in each spec and an explicit, verbatim copy instruction against a stable in-repo source — not vague TODOs. T8 deliberately ships a placeholder gesture-test body in Step 2 that Step 3 replaces (sequenced, not left dangling).

**Type consistency:** `evalIn`/`mainCall`/`pollEval`/`seed` signatures are fixed in T6 and used identically throughout. `E2EMain` method names (`terminalPid`/`writeTerminal`/`captureView`/`viewIds`/`viewWebContentsId`/`sendInput`/`createTempProject`/`teardownProject`/`putRedBitmapOnClipboard`/`fileExists`/`joinPath`/`localUrl`) match every `mainCall` call site. `reset()` returns `{ ok: true }` consistently.
</content>
