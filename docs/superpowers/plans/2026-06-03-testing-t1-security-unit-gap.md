# Testing T1 — Security-Unit Gap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assert Canvas ADE's MAIN-process security boundaries at the fast unit tier — main-window `webPreferences`, the new-window/navigation policy, and IPC foreign-sender rejection — instead of leaving them untested or only reachable through full-app e2e.

**Architecture:** `src/main/index.ts` builds the `BrowserWindow` `webPreferences` and its `setWindowOpenHandler` / `will-navigate` guards inline, so none of it is unit-testable today. Extract the pure decisions into a new `src/main/windowSecurity.ts` and assert them directly. Separately, the per-handler foreign-sender guards (`isForeignSender`) already exist and the pure function is tested, but **no test proves each registered handler actually rejects a foreign sender** — add those assertions to the existing `pty` / `preview` / `projectIpc` test files.

**Tech Stack:** TypeScript (strict), Vitest, Electron 33. No new dependencies. All tests run in the existing `check` CI job (`pnpm test` = `vitest run`).

**Branch:** `testing-strategy`. Spec: `docs/superpowers/specs/2026-06-03-testing-strategy-design.md` (§T1). Research: `docs/research/2026-06-03-testing-strategy.md`.

**Scope note (branch reality):** the spec's T1 also names `boardRegistry` and `mcp` IPC. Those files **do not exist on this branch** (it forked from `main` at `2d07fbb`, pre-MCP). They live on `feat/mcp-integration`. T1 here targets the three IPC surfaces that exist on this branch — `pty`, `preview`, `projectIpc` — plus `index.ts`. The same foreign-sender rejection treatment should be applied to `boardRegistry`/`mcp` on the MCP branch (cross-reference this plan there).

**Maps to Electron security checklist:** #3 context isolation, #4 sandbox (Task 1 webPreferences); #13/#14 navigation + new-window limits (Task 1 open/nav decisions); #17 validate IPC sender, #20 no Electron APIs to untrusted content / Browser↛PTY (Task 2).

---

## File Structure

- **Create** `src/main/windowSecurity.ts` — pure, unit-testable security surface for the MAIN window: `buildMainWindowWebPreferences`, `windowOpenDecision`, `computeAppOrigin`, `navDecision`. Reuses the already-tested `isAllowedExternal` from `./preview`. One responsibility: express the main-window security policy as pure functions.
- **Create** `src/main/windowSecurity.test.ts` — unit tests for the above.
- **Modify** `src/main/index.ts` — use the new helpers in `createWindow()`; drop the now-unused `isAllowedExternal` import.
- **Modify** `src/main/pty.test.ts` — add a `registerPtyHandlers` foreign-sender rejection suite (encodes Browser↛PTY).
- **Modify** `src/main/preview.test.ts` — add a `registerPreviewHandlers` foreign-sender rejection suite.
- **Modify** `src/main/projectIpc.test.ts` — add a `registerProjectHandlers` foreign-sender rejection suite.

---

## Task 1: Main-window security surface (`windowSecurity.ts`)

**Files:**
- Create: `src/main/windowSecurity.ts`
- Test: `src/main/windowSecurity.test.ts`
- Modify: `src/main/index.ts` (wire in the helpers)

- [ ] **Step 1: Write the failing test**

Create `src/main/windowSecurity.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  buildMainWindowWebPreferences,
  windowOpenDecision,
  computeAppOrigin,
  navDecision
} from './windowSecurity'

// Checklist #3/#4: the main window must run with contextIsolation + sandbox ON and
// nodeIntegration + webviewTag OFF. These are the load-bearing isolation flags.
describe('buildMainWindowWebPreferences (#3/#4)', () => {
  const wp = buildMainWindowWebPreferences('/app/out/preload/index.js')

  it('enables context isolation and sandbox', () => {
    expect(wp.contextIsolation).toBe(true)
    expect(wp.sandbox).toBe(true)
  })

  it('disables nodeIntegration and webviewTag', () => {
    expect(wp.nodeIntegration).toBe(false)
    expect(wp.webviewTag).toBe(false)
  })

  it('passes the preload path through', () => {
    expect(wp.preload).toBe('/app/out/preload/index.js')
  })
})

// Checklist #13/#14: the main window ALWAYS denies in-app window creation; an
// allowlisted-scheme URL is handed to the OS browser, everything else is dropped.
describe('windowOpenDecision (#13/#14)', () => {
  it('always denies the in-app window', () => {
    expect(windowOpenDecision('https://example.com').action).toBe('deny')
    expect(windowOpenDecision('file:///C:/x').action).toBe('deny')
  })

  it('routes http/https/mailto to the OS browser', () => {
    expect(windowOpenDecision('https://example.com').openExternal).toBe('https://example.com')
    expect(windowOpenDecision('http://localhost:5173/').openExternal).toBe('http://localhost:5173/')
    expect(windowOpenDecision('mailto:a@b.com').openExternal).toBe('mailto:a@b.com')
  })

  it('drops file:/custom/javascript:/non-url (no external open)', () => {
    expect(windowOpenDecision('file:///C:/Windows/calc.exe').openExternal).toBeNull()
    expect(windowOpenDecision('myapp://payload').openExternal).toBeNull()
    expect(windowOpenDecision('javascript:alert(1)').openExternal).toBeNull()
    expect(windowOpenDecision('not a url').openExternal).toBeNull()
  })
})

// The app origin the window is pinned to: dev = renderer dev-server origin;
// packaged (no renderer URL) = null (a file: URL's origin is the string "null").
describe('computeAppOrigin', () => {
  it('returns the dev renderer origin', () => {
    expect(computeAppOrigin('http://localhost:5173/')).toBe('http://localhost:5173')
  })

  it('returns null for undefined (packaged) and for a bad URL', () => {
    expect(computeAppOrigin(undefined)).toBeNull()
    expect(computeAppOrigin('::::not a url')).toBeNull()
  })
})

// Checklist #13: the main window must never navigate away from its own document.
// Same-ORIGIN navigation is allowed (so ?e2e=1 / hash changes pass); a different
// origin is blocked and, if http(s)/mailto, routed to the OS browser.
describe('navDecision (#13)', () => {
  it('allows same-origin navigation (query/hash change)', () => {
    expect(navDecision('http://localhost:5173/?e2e=1', 'http://localhost:5173')).toEqual({
      allow: true,
      openExternal: null
    })
  })

  it('allows a file: URL when appOrigin is null (packaged build)', () => {
    expect(navDecision('file:///C:/app/index.html', null)).toEqual({
      allow: true,
      openExternal: null
    })
  })

  it('blocks a different http origin and routes it externally', () => {
    expect(navDecision('https://evil.com/', 'http://localhost:5173')).toEqual({
      allow: false,
      openExternal: 'https://evil.com/'
    })
  })

  it('blocks a file: drop in dev (different origin) with no external open', () => {
    expect(navDecision('file:///C:/Windows/win.ini', 'http://localhost:5173')).toEqual({
      allow: false,
      openExternal: null
    })
  })

  it('blocks an unparseable URL with no external open', () => {
    expect(navDecision('::::bad', 'http://localhost:5173')).toEqual({
      allow: false,
      openExternal: null
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/windowSecurity.test.ts`
Expected: FAIL — `Failed to resolve import "./windowSecurity"` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/main/windowSecurity.ts`:

```ts
/**
 * Pure, unit-testable security surface for the MAIN application window, extracted
 * from index.ts so the Electron security-checklist invariants can be asserted
 * without constructing a BrowserWindow. Covers #3 (context isolation), #4
 * (sandbox), and #13/#14 (navigation + new-window limits). The side effects
 * (creating the window, shell.openExternal, preventDefault) stay in index.ts;
 * these functions only compute the decisions.
 */
import { isAllowedExternal } from './preview'

/**
 * Security-critical webPreferences for the main window: contextIsolation +
 * sandbox ON, nodeIntegration + webviewTag OFF (#3/#4). The `preload` path is
 * runtime-specific (built from __dirname) so the caller supplies it.
 */
export function buildMainWindowWebPreferences(preloadPath: string): {
  preload: string
  sandbox: true
  contextIsolation: true
  nodeIntegration: false
  webviewTag: false
} {
  return {
    preload: preloadPath,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false
  }
}

/**
 * The main window's new-window policy (#13/#14): ALWAYS deny in-app window
 * creation; hand an allowlisted-scheme URL (http/https/mailto) to the OS browser,
 * drop everything else. Pure — the caller performs shell.openExternal.
 */
export function windowOpenDecision(url: string): { action: 'deny'; openExternal: string | null } {
  return { action: 'deny', openExternal: isAllowedExternal(url) ? url : null }
}

/**
 * The app origin the main window is pinned to. Dev: the renderer dev-server's
 * origin. Packaged (no renderer URL): null — a packaged file: URL has the origin
 * string "null", matched against this null below.
 */
export function computeAppOrigin(rendererUrl: string | undefined): string | null {
  if (!rendererUrl) return null
  try {
    return new URL(rendererUrl).origin
  } catch {
    return null
  }
}

/**
 * Same-frame navigation guard decision (#13): the main window must never navigate
 * away from its own document. Compare ORIGIN (not the full URL) so the e2e
 * `?e2e=1` query / in-app hash changes pass. A file: URL has origin "null"
 * (represented here as `null`) → allowed against a null appOrigin (packaged). A
 * different origin is blocked; if it is an allowlisted http(s)/mailto target it is
 * routed to the OS browser, otherwise just dropped.
 */
export function navDecision(
  url: string,
  appOrigin: string | null
): { allow: boolean; openExternal: string | null } {
  let origin: string | null
  try {
    const u = new URL(url)
    origin = u.protocol === 'file:' ? null : u.origin
  } catch {
    return { allow: false, openExternal: null }
  }
  if (origin === appOrigin) return { allow: true, openExternal: null }
  return { allow: false, openExternal: isAllowedExternal(url) ? url : null }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/main/windowSecurity.test.ts`
Expected: PASS — all 4 describe blocks green (15 assertions).

- [ ] **Step 5: Wire the helpers into `index.ts`**

In `src/main/index.ts`:

1. Replace the preview import (currently lines 6-10) so `isAllowedExternal` is no longer pulled in (it becomes unused after this refactor):

```ts
import { registerPreviewHandlers, disposeAll as disposeAllPreviews } from './preview'
```

2. Add the new import after it:

```ts
import {
  buildMainWindowWebPreferences,
  windowOpenDecision,
  computeAppOrigin,
  navDecision
} from './windowSecurity'
```

3. Replace the inline `webPreferences` object in `createWindow()` (currently lines 43-49) with:

```ts
    webPreferences: buildMainWindowWebPreferences(join(__dirname, '../preload/index.js'))
```

4. Replace the `setWindowOpenHandler` body (currently lines 57-60) with:

```ts
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const d = windowOpenDecision(url)
    if (d.openExternal) shell.openExternal(d.openExternal)
    return { action: d.action }
  })
```

5. Replace the `appOrigin` IIFE (currently lines 68-75) with:

```ts
  const appOrigin = computeAppOrigin(process.env['ELECTRON_RENDERER_URL'])
```

6. Replace the `guardNav` body (currently lines 76-89) with:

```ts
  const guardNav = (event: { preventDefault: () => void }, url: string): void => {
    const d = navDecision(url, appOrigin)
    if (d.allow) return
    event.preventDefault()
    if (d.openExternal) shell.openExternal(d.openExternal)
  }
```

- [ ] **Step 6: Verify typecheck + full test suite + lint stay green**

Run: `pnpm typecheck`
Expected: PASS (no unused-import error for `isAllowedExternal`; new module type-checks).

Run: `pnpm test`
Expected: PASS — previous count (602) + the new `windowSecurity` tests.

Run: `pnpm lint`
Expected: PASS — 0 errors (the pre-existing PlanningBoard `no-console` warning is unrelated).

- [ ] **Step 7: Commit**

```bash
git add src/main/windowSecurity.ts src/main/windowSecurity.test.ts src/main/index.ts
git commit -F - <<'EOF'
test(main): extract + unit-test main-window security surface

Extract the main window's webPreferences, new-window policy, and navigation
origin-guard from index.ts into a pure windowSecurity.ts and assert them
directly (Electron security checklist #3/#4/#13/#14):
- buildMainWindowWebPreferences — contextIsolation/sandbox ON, nodeIntegration/
  webviewTag OFF
- windowOpenDecision — always deny in-app windows; allowlisted scheme → OS browser
- computeAppOrigin + navDecision — pin the window to its own document origin

index.ts now composes these helpers; behavior is unchanged. Closes the
"index.ts has no fast test" gap from the testing-strategy spec (T1).
EOF
```

---

## Task 2: IPC foreign-sender rejection (`pty` / `preview` / `projectIpc`)

The `isForeignSender` pure function is already unit-tested in all three files, and the happy path (synthetic/internal sender) is covered. The gap is that **no test invokes a registered handler with a FOREIGN sender and asserts it is rejected** — i.e. that the guard is actually wired into each handler (checklist #17), and specifically that a Browser/preview frame cannot reach the PTY (checklist #20, Browser↛PTY). These are pure test additions — no production code changes.

### Task 2a: `pty` handlers reject foreign senders (Browser↛PTY)

**Files:**
- Modify: `src/main/pty.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/main/pty.test.ts`, add `registerPtyHandlers` to the import from `./pty` (it currently imports the pure helpers only):

```ts
import {
  canonicalizeShellPath,
  isStaleExit,
  appendRing,
  resolveShell,
  isForeignSender,
  parkCore,
  adoptCore,
  reapParkedCore,
  cleanupCore,
  disposeAllPtysCore,
  safeCwd,
  registerPtyHandlers
} from './pty'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
```

Then append this suite at the end of the file (before the trailing `eslint-enable` comment if present, otherwise at EOF):

```ts
// Checklist #17 + #20 (Browser↛PTY): the PTY control channel is shared by ALL
// webContents, including per-board preview WebContentsViews that load untrusted
// localhost pages. A foreign sender (anything that isn't the main window's main
// frame) must be REJECTED — a previewed page must never be able to spawn or kill
// a shell. This proves the guard is wired into the handlers, not just that the
// pure isForeignSender works.
describe('registerPtyHandlers — foreign-sender rejection (#17/#20 Browser↛PTY)', () => {
  const mainFrame = { id: 'main-frame' }
  // A preview/browser board's frame — a real sender that is NOT the main frame.
  const foreign = { senderFrame: { id: 'preview-board-frame' } } as unknown as IpcMainInvokeEvent

  function setup(): Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown> {
    const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    const ipcMain = {
      handle: (c: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) =>
        handlers.set(c, fn)
    } as unknown as IpcMain
    const getWin = (): never => ({ webContents: { mainFrame } }) as never
    registerPtyHandlers(ipcMain, getWin)
    return handlers
  }

  it('pty:spawn throws for a foreign sender (no shell is spawned)', () => {
    const handlers = setup()
    expect(() => handlers.get('pty:spawn')!(foreign, { id: 'b1' })).toThrow(/forbidden sender/)
  })

  it('pty:kill returns false for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('pty:kill')!(foreign, 'b1')).toBe(false)
  })

  it('pty:shells returns [] for a foreign sender (no shell enumeration leaked)', () => {
    const handlers = setup()
    expect(handlers.get('pty:shells')!(foreign)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails first, then passes**

Run: `pnpm exec vitest run src/main/pty.test.ts`
Expected: the new suite PASSES immediately — the guards already exist in production, so these assertions describe (and lock) current behavior. (If any assertion FAILS, a guard is missing and must be added to `registerPtyHandlers` before proceeding — that would be a real security bug, not a test error.)

> Note: this is a characterization test for an existing guard. The TDD "see it fail" beat is satisfied by Step 1 not compiling until `registerPtyHandlers` is imported; the value is the regression lock.

- [ ] **Step 3: Commit**

```bash
git add src/main/pty.test.ts
git commit -m "test(main): assert pty handlers reject foreign senders (Browser↛PTY, #17/#20)"
```

### Task 2b: `preview` handlers reject foreign senders

**Files:**
- Modify: `src/main/preview.test.ts`

- [ ] **Step 1: Write the test**

In `src/main/preview.test.ts`, add `registerPreviewHandlers` to the import from `./preview`:

```ts
import {
  isErrorResponseCode,
  isHttpErrorCode,
  isAllowedPreviewUrl,
  isAllowedExternal,
  registerPreviewNavGuards,
  registerLoadLatch,
  isForeignSender,
  registerPreviewHandlers
} from './preview'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
```

(`BrowserWindow` is already imported as a type in this file; add `IpcMain` alongside it.)

Append at EOF:

```ts
// Checklist #17: the preview control channel is shared by all webContents. A
// foreign sender must be rejected so a previewed page can't drive another board's
// native view. preview:open throws; the navigation handlers return false.
describe('registerPreviewHandlers — foreign-sender rejection (#17)', () => {
  const mainFrame = { id: 'main-frame' }
  const foreign = { senderFrame: { id: 'preview-board-frame' } } as unknown as IpcMainInvokeEvent

  function setup(): Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown> {
    const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    const ipcMain = {
      handle: (c: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) =>
        handlers.set(c, fn)
    } as unknown as IpcMain
    const getWin = (): BrowserWindow =>
      ({ webContents: { mainFrame } }) as unknown as BrowserWindow
    registerPreviewHandlers(ipcMain, getWin, 'http://127.0.0.1:0/')
    return handlers
  }

  it('preview:open throws for a foreign sender (no native view created)', () => {
    const handlers = setup()
    expect(() => handlers.get('preview:open')!(foreign, { id: 'b1', bounds: {} })).toThrow(
      /forbidden sender/
    )
  })

  it('preview:navigate returns false for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('preview:navigate')!(foreign, { id: 'b1', url: 'http://x/' })).toBe(false)
  })

  it('preview:goBack returns false for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('preview:goBack')!(foreign, 'b1')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test**

Run: `pnpm exec vitest run src/main/preview.test.ts`
Expected: PASS — the new suite is green (guards already exist). A FAIL means a missing guard (real bug) — fix the handler, don't weaken the test.

- [ ] **Step 3: Commit**

```bash
git add src/main/preview.test.ts
git commit -m "test(main): assert preview handlers reject foreign senders (#17)"
```

### Task 2c: `projectIpc` handlers reject foreign senders

**Files:**
- Modify: `src/main/projectIpc.test.ts`

- [ ] **Step 1: Write the test**

In `src/main/projectIpc.test.ts`, add `BrowserWindow` to the type import:

```ts
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
```

Append at EOF (it reuses the module-level `store`/`recents` mocks already defined at the top of the file):

```ts
// Checklist #17: every project handler must reject a foreign sender before any fs
// or dialog touch. The pure isForeignSender is covered above; this proves the
// guard is wired into each handler with the documented rejection value.
describe('registerProjectHandlers — foreign-sender rejection (#17)', () => {
  const mainFrame = { id: 'main-frame' }
  const foreign = { senderFrame: { id: 'preview-board-frame' } } as unknown as IpcMainInvokeEvent

  function setup(): Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown> {
    const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    const ipcMain = {
      handle: (c: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) =>
        handlers.set(c, fn)
    } as unknown as IpcMain
    const getWin = (): BrowserWindow =>
      ({ webContents: { mainFrame } }) as unknown as BrowserWindow
    registerProjectHandlers(ipcMain, getWin, '/userData')
    return handlers
  }

  it('project:open rejects a foreign sender and touches no store', async () => {
    const handlers = setup()
    const result = await handlers.get('project:open')!(foreign, 'C:\\proj')
    expect(result).toEqual({ ok: false, error: 'forbidden' })
    expect(store.readProject).not.toHaveBeenCalled()
  })

  it('project:save rejects a foreign sender and writes nothing', async () => {
    const handlers = setup()
    const result = await handlers.get('project:save')!(foreign, { schemaVersion: 2, boards: [] })
    expect(result).toBe(false)
    expect(store.writeProject).not.toHaveBeenCalled()
  })

  it('project:recents returns [] for a foreign sender', async () => {
    const handlers = setup()
    expect(await handlers.get('project:recents')!(foreign)).toEqual([])
    expect(recents.listRecents).not.toHaveBeenCalled()
  })

  it('asset:write rejects a foreign sender', async () => {
    const handlers = setup()
    expect(await handlers.get('asset:write')!(foreign, { bytes: new Uint8Array(), ext: 'png' })).toEqual(
      { error: 'forbidden' }
    )
  })

  it('export:save rejects a foreign sender', async () => {
    const handlers = setup()
    expect(
      await handlers.get('export:save')!(foreign, { bytes: new Uint8Array(), ext: 'svg', defaultName: 'x' })
    ).toEqual({ ok: false, error: 'forbidden' })
  })
})
```

- [ ] **Step 2: Run test**

Run: `pnpm exec vitest run src/main/projectIpc.test.ts`
Expected: PASS — the new suite is green. A FAIL means a missing guard (real bug) — fix the handler.

- [ ] **Step 3: Final gate + commit**

Run: `pnpm test` → expect PASS (602 + ~26 new assertions across the four files).
Run: `pnpm typecheck` → expect PASS.
Run: `pnpm lint` → expect 0 errors.

```bash
git add src/main/projectIpc.test.ts
git commit -m "test(main): assert project handlers reject foreign senders (#17)"
```

- [ ] **Step 4: Push**

```bash
git push
```

(PR #36 already exists for the `testing-strategy` branch — these commits extend it. Optionally retitle the PR once T1 lands to note it now includes the first implementation slice, not just docs.)

---

## Self-Review

**Spec coverage (§T1 of the design):**
- "Extract a pure window-options builder from index.ts" → Task 1, Steps 3/5 (`buildMainWindowWebPreferences`). ✅
- "Unit-assert webPreferences (contextIsolation/sandbox/nodeIntegration)" → Task 1 (`buildMainWindowWebPreferences` test). ✅ (also `webviewTag`)
- "setWindowOpenHandler denies + openExternal" → Task 1 (`windowOpenDecision` test + index.ts wiring). ✅
- "IPC sender-rejection on boardRegistry/projectIpc/mcp" → Task 2c (`projectIpc`) ✅; `boardRegistry`/`mcp` deferred to the MCP branch (documented in Scope note) ✅; bonus `pty`/`preview` rejection (Task 2a/2b) ✅.
- "Browser-board content cannot reach the PTY write channel" → Task 2a (foreign `pty:spawn`/`pty:kill` rejection). ✅
- Checklist items #3/#4/#13/#14/#17/#20 each asserted → Tasks 1 + 2. ✅

**Placeholder scan:** none — every step has full code or an exact command + expected output.

**Type consistency:** `buildMainWindowWebPreferences`/`windowOpenDecision`/`computeAppOrigin`/`navDecision` names match between `windowSecurity.ts`, its test, and the `index.ts` wiring. The `setup()`/`foreign`/`mainFrame` helpers are defined independently inside each Task 2 suite (no cross-file sharing), matching the existing `makeIpcMain` style in `projectIpc.test.ts`. `navDecision`/`windowOpenDecision` return shapes (`{ allow, openExternal }` / `{ action, openExternal }`) are consistent between definition, tests, and the `index.ts` consumers.

**Note on Task 2 TDD:** Tasks 2a–2c are characterization tests for guards that already exist in production — they lock current behavior rather than drive new code. The "see it fail" beat is the import/compile failure in Step 1; the durable value is regression protection for security-checklist #17/#20. If any assertion fails on first run, that is a genuine missing-guard bug to fix in the handler (never by loosening the test).
