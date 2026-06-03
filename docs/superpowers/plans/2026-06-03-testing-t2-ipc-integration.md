# Testing T2 — IPC Integration Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three duplicated hand-rolled `ipcMain` fakes in the MAIN integration tests with one shared, no-dependency `ipcTestHarness`, and close the 100%-untested preload gap with a channel-mapping contract test — establishing the MAIN-IPC integration pattern T3 will copy.

**Architecture:** A new test-only helper `src/main/ipcTestHarness.ts` captures `ipcMain.handle` registrations so a test invokes a handler directly with a chosen sender (internal vs foreign). The three existing `*.integration.test.ts` files are retrofitted onto it (zero behavior change, identical counts). A new `src/preload/preloadApi.integration.test.ts` mocks `electron`, captures the `api` object that `contextBridge.exposeInMainWorld` exposes, and asserts every `api.*` method maps to the correct `ipcRenderer.invoke(channel, …args)`.

**Tech Stack:** TypeScript (strict), Vitest 2.1.9 (unit/integration workspace projects from T0), Electron 33 types. **No new dependencies.** All tests run in the existing `check` CI job (`pnpm test`).

**Branch:** `testing-strategy` (single branch / PR #37 — no new branch). Spec: `docs/superpowers/specs/2026-06-03-testing-t2-ipc-integration-design.md`. Roadmap: `docs/superpowers/specs/2026-06-03-testing-strategy-design.md` (§T2).

**Baseline before this work:** 633 tests green across 47 files (post-T0), typecheck + lint clean (one pre-existing PlanningBoard `no-console` warning). **Tasks 1–2 are count-neutral** (pure dedup → still 633). **Task 3 ADDS the preload contract tests** (this is intended — unlike T0, T2 grows coverage). The new total is confirmed empirically in Task 3.

---

## File Structure

- **Create** `src/main/ipcTestHarness.ts` — test-only helper: a fake capturing `ipcMain` + sender fixtures. One responsibility: stand up MAIN-IPC integration tests. No production module imports it (tree-shaken from the app bundle).
- **Modify** `src/main/projectIpc.integration.test.ts` — retrofit onto the harness (the reference example). Keeps its `vi.mock` collaborator stubs.
- **Modify** `src/main/pty.integration.test.ts` — retrofit onto the harness.
- **Modify** `src/main/preview.integration.test.ts` — retrofit onto the harness.
- **Create** `src/preload/preloadApi.integration.test.ts` — channel-mapping contract for all 28 invoke methods.
- **Modify** `docs/testing/TESTING.md` — append a "MAIN IPC integration — the harness" section.

---

## Task 1: Shared harness + retrofit `projectIpc` (the reference)

**Files:**
- Create: `src/main/ipcTestHarness.ts`
- Modify: `src/main/projectIpc.integration.test.ts`

- [ ] **Step 1: Create `src/main/ipcTestHarness.ts`**

```ts
/**
 * Test-only helper for MAIN-process IPC integration tests. Captures the handlers a
 * register*Handlers(ipcMain, …) call registers via ipcMain.handle, so a test can
 * invoke a handler directly with a chosen sender — no Electron boot. Pairs with the
 * sender fixtures below to exercise the foreign-sender guard (checklist #17/#20).
 *
 * NOT production code: nothing under src/main/*.ts (non-test) may import this, so
 * electron-vite tree-shakes it out of the app bundle. Vitest ignores it (no
 * `.test.` infix); it is only typechecked under tsconfig.node.
 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'

export type IpcHandler = (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown

export interface IpcCapture {
  /** Pass this where the production code expects Electron's ipcMain. */
  ipcMain: IpcMain
  /** Every channel registered via ipcMain.handle, keyed by channel name. */
  handlers: Map<string, IpcHandler>
  /** Invoke a captured handler as an internal/trusted caller (no senderFrame). */
  invoke: (channel: string, ...args: unknown[]) => unknown
  /** Invoke a captured handler as a specific sender (e.g. foreignEvent). */
  invokeAs: (event: IpcMainInvokeEvent, channel: string, ...args: unknown[]) => unknown
}

/** A minimal ipcMain stub that records `handle` registrations for direct invocation. */
export function createIpcCapture(): IpcCapture {
  const handlers = new Map<string, IpcHandler>()
  const ipcMain = {
    handle: (channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn)
    }
  } as unknown as IpcMain
  const run = (event: IpcMainInvokeEvent, channel: string, args: unknown[]): unknown => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return fn(event, ...args)
  }
  return {
    ipcMain,
    handlers,
    invoke: (channel, ...args) => run(internalEvent, channel, args),
    invokeAs: (event, channel, ...args) => run(event, channel, args)
  }
}

/** The trusted main-window frame identity the guard compares against. */
export const mainFrame = { id: 'main-frame' }

/** A synthetic/internal call (no senderFrame) — the guard treats it as trusted. */
export const internalEvent = { senderFrame: undefined } as unknown as IpcMainInvokeEvent

/** A real sender that is NOT the main frame (e.g. a preview board) — must be rejected. */
export const foreignEvent = {
  senderFrame: { id: 'preview-board-frame' }
} as unknown as IpcMainInvokeEvent

/** A getWin whose window resolves to the trusted mainFrame (for guard comparison). */
export const mainWin = (): BrowserWindow =>
  ({ webContents: { mainFrame } }) as unknown as BrowserWindow
```

- [ ] **Step 2: Retrofit `src/main/projectIpc.integration.test.ts` onto the harness**

Replace the import line `import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'` with a harness import added after the `registerProjectHandlers` import. The file head becomes:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
```

(Drop the `electron` type import — the harness owns those types now.)

Keep the entire `vi.hoisted` mocks block + the three `vi.mock(...)` calls unchanged. Replace the value import + `makeIpcMain` helper with:

```ts
import { registerProjectHandlers } from './projectIpc'
import { createIpcCapture, foreignEvent, mainWin } from './ipcTestHarness'
```

Delete the local `makeIpcMain()` function entirely (the harness replaces it). Keep the `beforeEach`.

In `describe('registerProjectHandlers (T4)', …)` and `describe('export:save', …)`, replace each
`const { ipcMain, invoke } = makeIpcMain(); registerProjectHandlers(ipcMain, getWin, '/userData')`
with `const cap = createIpcCapture(); registerProjectHandlers(cap.ipcMain, getWin, '/userData')`
and each `await invoke('channel', …)` with `await cap.invoke('channel', …)`. The local
`const getWin = (): null => null` in those two describes stays (internal calls never reach getWin).

In `describe('registerProjectHandlers — foreign-sender rejection (#17)', …)`, delete the local
`mainFrame` / `foreign` / `setup()` block and rewrite each test to use the harness. The whole describe
becomes:

```ts
describe('registerProjectHandlers — foreign-sender rejection (#17)', () => {
  function setup(): ReturnType<typeof createIpcCapture> {
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, mainWin, '/userData')
    return cap
  }

  it('project:open rejects a foreign sender and touches no store', async () => {
    const cap = setup()
    const result = await cap.invokeAs(foreignEvent, 'project:open', 'C:\\proj')
    expect(result).toEqual({ ok: false, error: 'forbidden' })
    expect(store.readProject).not.toHaveBeenCalled()
  })

  it('project:save rejects a foreign sender and writes nothing', async () => {
    const cap = setup()
    const result = await cap.invokeAs(foreignEvent, 'project:save', { schemaVersion: 2, boards: [] })
    expect(result).toBe(false)
    expect(store.writeProject).not.toHaveBeenCalled()
  })

  it('project:recents returns [] for a foreign sender', async () => {
    const cap = setup()
    expect(await cap.invokeAs(foreignEvent, 'project:recents')).toEqual([])
    expect(recents.listRecents).not.toHaveBeenCalled()
  })

  it('asset:write rejects a foreign sender', async () => {
    const cap = setup()
    expect(
      await cap.invokeAs(foreignEvent, 'asset:write', { bytes: new Uint8Array(), ext: 'png' })
    ).toEqual({ error: 'forbidden' })
  })

  it('export:save rejects a foreign sender', async () => {
    const cap = setup()
    expect(
      await cap.invokeAs(foreignEvent, 'export:save', {
        bytes: new Uint8Array(),
        ext: 'svg',
        defaultName: 'x'
      })
    ).toEqual({ ok: false, error: 'forbidden' })
  })

  it('dialog:openFolder returns null for a foreign sender and does not open dialog', async () => {
    const cap = setup()
    const result = await cap.invokeAs(foreignEvent, 'dialog:openFolder')
    expect(result).toBeNull()
    expect(electronDialog.showOpenDialog).not.toHaveBeenCalled()
  })

  it('project:create returns { ok: false, error: "forbidden" } for a foreign sender and does not call createProject', async () => {
    const cap = setup()
    const result = await cap.invokeAs(foreignEvent, 'project:create', {
      dir: 'C:\\proj',
      name: 'p',
      opts: {}
    })
    expect(result).toEqual({ ok: false, error: 'forbidden' })
    expect(store.createProject).not.toHaveBeenCalled()
  })

  it('project:current returns null for a foreign sender', async () => {
    const cap = setup()
    expect(await cap.invokeAs(foreignEvent, 'project:current')).toBeNull()
  })

  it('asset:read returns null for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'asset:read', 'someId')).toBeNull()
  })
})
```

- [ ] **Step 3: Verify the retrofit is count-neutral**

Run: `pnpm exec vitest run src/main/projectIpc.integration.test.ts`
Expected: PASS, **same test count as before** (the 17 handler/export/rejection tests — unchanged).

Run: `pnpm test`
Expected: PASS, **633 tests** (unchanged — pure dedup).

Run: `pnpm typecheck` → clean. Run: `pnpm lint` → 0 errors.

> If a count drifts or typecheck fails: the harness API (`invoke`/`invokeAs`/`mainWin`) does not match a call site. Fix the harness or the call, do not delete a test.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipcTestHarness.ts src/main/projectIpc.integration.test.ts
git commit -F - <<'EOF'
test(main): add shared ipcTestHarness + retrofit projectIpc onto it (T2)

Extract the duplicated hand-rolled ipcMain fake into one no-dep helper
(createIpcCapture + internalEvent/foreignEvent/mainWin fixtures) and move
projectIpc.integration.test.ts onto it. Pure dedup — identical assertions and
count. This file is the reference template for MAIN-IPC integration tests (T3).
EOF
```

---

## Task 2: Retrofit `pty` + `preview` integration files onto the harness

**Files:**
- Modify: `src/main/pty.integration.test.ts`
- Modify: `src/main/preview.integration.test.ts`

### Task 2a: `pty.integration.test.ts`

- [ ] **Step 1: Replace the file head + `setup()`**

Replace the imports:

```ts
import { describe, it, expect } from 'vitest'
import { registerPtyHandlers } from './pty'
import { createIpcCapture, foreignEvent, mainWin } from './ipcTestHarness'
```

(Drop `import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'`.)

Inside `describe('registerPtyHandlers — foreign-sender rejection (#17/#20 Browser↛PTY)', …)`, delete
the local `mainFrame` / `foreign` consts and rewrite `setup()`:

```ts
  function setup(): ReturnType<typeof createIpcCapture> {
    const cap = createIpcCapture()
    registerPtyHandlers(cap.ipcMain, mainWin)
    return cap
  }
```

Rewrite each test to invoke via the harness (one per channel):

```ts
  it('pty:spawn throws for a foreign sender (no shell is spawned)', () => {
    const cap = setup()
    expect(() => cap.invokeAs(foreignEvent, 'pty:spawn', { id: 'b1' })).toThrow(/forbidden sender/)
  })

  it('pty:kill returns false for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'pty:kill', 'b1')).toBe(false)
  })

  it('pty:shells returns [] for a foreign sender (no shell enumeration leaked)', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'pty:shells')).toEqual([])
  })

  it('terminal:detectPorts returns [] for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'terminal:detectPorts', 'b1')).toEqual([])
  })

  it('pty:disposeAll returns false for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'pty:disposeAll')).toBe(false)
  })

  it('pty:park returns false for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'pty:park', 'b1')).toBe(false)
  })

  it('pty:adopt returns { adopted: false } for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'pty:adopt', 'b1')).toEqual({ adopted: false })
  })
```

- [ ] **Step 2: Verify**

Run: `pnpm exec vitest run src/main/pty.integration.test.ts`
Expected: PASS, 7 tests (unchanged).

### Task 2b: `preview.integration.test.ts`

- [ ] **Step 3: Replace the file head + `setup()`**

Replace the imports:

```ts
import { describe, it, expect } from 'vitest'
import { registerPreviewHandlers } from './preview'
import { createIpcCapture, foreignEvent, mainWin } from './ipcTestHarness'
```

(Drop `import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'`.)

Delete the local `mainFrame` / `foreign` consts and rewrite `setup()` (note `registerPreviewHandlers`
takes a third `baseUrl` argument):

```ts
  function setup(): ReturnType<typeof createIpcCapture> {
    const cap = createIpcCapture()
    registerPreviewHandlers(cap.ipcMain, mainWin, 'http://127.0.0.1:0/')
    return cap
  }
```

Rewrite each test. The single-invocation tests:

```ts
  it('preview:open throws for a foreign sender (no native view created)', () => {
    const cap = setup()
    expect(() => cap.invokeAs(foreignEvent, 'preview:open', { id: 'b1', bounds: {} })).toThrow(
      /forbidden sender/
    )
  })

  it('preview:navigate returns false for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'preview:navigate', { id: 'b1', url: 'http://x/' })).toBe(false)
  })

  it('preview:goBack returns false for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'preview:goBack', 'b1')).toBe(false)
  })
```

The two `it.each` groups become (the harness `invokeAs` replaces `handlers.get(channel)!(foreign, …)`):

```ts
  it.each([
    ['preview:goForward', ['b1']],
    ['preview:reload', ['b1']]
  ] as const)('%s returns false for a foreign sender', (channel, args) => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, channel, ...args)).toBe(false)
  })

  it.each([
    ['preview:setBoundsBatch', [[]]],
    ['preview:detach', ['b1']],
    ['preview:detachAll', []],
    ['preview:attach', [{ id: 'b1', bounds: {} }]],
    ['preview:close', ['b1']],
    ['preview:closeAll', []]
  ] as const)('%s returns true for a foreign sender', (channel, args) => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, channel, ...args)).toBe(true)
  })

  it('preview:capture returns null for a foreign sender (async)', async () => {
    const cap = setup()
    expect(await cap.invokeAs(foreignEvent, 'preview:capture', 'b1')).toBeNull()
  })
```

- [ ] **Step 4: Verify both + full gate**

Run: `pnpm exec vitest run src/main/preview.integration.test.ts`
Expected: PASS, same count as before (3 + 2 + 6 + 1 = 12).

Run: `pnpm test`
Expected: PASS, **633 tests** (still count-neutral).

Run: `pnpm typecheck` → clean. Run: `pnpm lint` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/pty.integration.test.ts src/main/preview.integration.test.ts
git commit -m "test(main): retrofit pty + preview integration tests onto ipcTestHarness (T2)"
```

---

## Task 3: Preload channel-mapping contract test

**Files:**
- Create: `src/preload/preloadApi.integration.test.ts`

This proves every renderer-facing `api.*` method invokes the correct IPC channel with the correct
(possibly transformed) arguments — the 190-line preload is otherwise untested, so a channel-name typo
only surfaces at runtime/e2e. It is a characterization test: it locks the current, correct mapping and
catches future drift.

- [ ] **Step 1: Write the test**

Create `src/preload/preloadApi.integration.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasApi } from './index'

// Capture the exposed api + spy on ipcRenderer.invoke. vi.hoisted so the holder
// exists when the hoisted vi.mock factory runs.
const h = vi.hoisted(() => ({ invoke: vi.fn(), api: undefined as unknown }))

// Mock electron so importing the preload has no Electron dependency:
//  - contextBridge.exposeInMainWorld captures the api object
//  - ipcRenderer.invoke is the spy we assert against
//  - ipcRenderer.on / removeListener are no-ops (preload registers a pty:port
//    listener at import; it must not throw)
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, value: unknown) => {
      h.api = value
    }
  },
  ipcRenderer: {
    invoke: h.invoke,
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))

let api: CanvasApi

beforeEach(async () => {
  h.invoke.mockClear()
  // Force the `if (process.contextIsolated)` branch (the else branch references
  // `window`, undefined under the node test environment).
  ;(process as { contextIsolated?: boolean }).contextIsolated = true
  vi.resetModules()
  await import('./index') // side effect: calls exposeInMainWorld → fills h.api
  api = h.api as CanvasApi
})

// A fixed byte payload so the deep-equal in toHaveBeenCalledWith matches by reference.
const BYTES = new Uint8Array([1, 2, 3])

describe('preload api → terminal channels', () => {
  it.each([
    ['spawnTerminal', (a: CanvasApi) => a.spawnTerminal({ id: 'b1' }), ['pty:spawn', { id: 'b1' }]],
    ['killTerminal', (a: CanvasApi) => a.killTerminal('b1'), ['pty:kill', 'b1']],
    ['disposeAllTerminals', (a: CanvasApi) => a.disposeAllTerminals(), ['pty:disposeAll']],
    ['parkTerminal', (a: CanvasApi) => a.parkTerminal('b1'), ['pty:park', 'b1']],
    ['adoptTerminal', (a: CanvasApi) => a.adoptTerminal('b1'), ['pty:adopt', 'b1']],
    ['listShells', (a: CanvasApi) => a.listShells(), ['pty:shells']],
    ['detectPorts', (a: CanvasApi) => a.detectPorts('b1'), ['terminal:detectPorts', 'b1']]
  ] as const)('%s', (_label, call, expected) => {
    call(api)
    expect(h.invoke).toHaveBeenCalledWith(...expected)
  })
})

describe('preload api → preview channels', () => {
  const bounds = { x: 0, y: 0, width: 100, height: 100 }
  it.each([
    ['openPreview', (a: CanvasApi) => a.openPreview({ id: 'b1', bounds }), ['preview:open', { id: 'b1', bounds }]],
    ['setPreviewBoundsBatch', (a: CanvasApi) => a.setPreviewBoundsBatch([]), ['preview:setBoundsBatch', []]],
    ['capturePreview', (a: CanvasApi) => a.capturePreview('b1'), ['preview:capture', 'b1']],
    ['detachPreview', (a: CanvasApi) => a.detachPreview('b1'), ['preview:detach', 'b1']],
    ['detachAllPreviews', (a: CanvasApi) => a.detachAllPreviews(), ['preview:detachAll']],
    ['attachPreview', (a: CanvasApi) => a.attachPreview({ id: 'b1', bounds }), ['preview:attach', { id: 'b1', bounds }]],
    ['closePreview', (a: CanvasApi) => a.closePreview('b1'), ['preview:close', 'b1']],
    ['closeAllPreviews', (a: CanvasApi) => a.closeAllPreviews(), ['preview:closeAll']],
    ['navigatePreview', (a: CanvasApi) => a.navigatePreview('b1', 'http://x/'), ['preview:navigate', { id: 'b1', url: 'http://x/' }]],
    ['goBackPreview', (a: CanvasApi) => a.goBackPreview('b1'), ['preview:goBack', 'b1']],
    ['goForwardPreview', (a: CanvasApi) => a.goForwardPreview('b1'), ['preview:goForward', 'b1']],
    ['reloadPreview', (a: CanvasApi) => a.reloadPreview('b1'), ['preview:reload', 'b1']]
  ] as const)('%s', (_label, call, expected) => {
    call(api)
    expect(h.invoke).toHaveBeenCalledWith(...expected)
  })
})

describe('preload api → project / asset / dialog / export channels', () => {
  it.each([
    ['project.create', (a: CanvasApi) => a.project.create('C:\\p', 'n', { gitInit: true }), ['project:create', { dir: 'C:\\p', name: 'n', opts: { gitInit: true } }]],
    ['project.open', (a: CanvasApi) => a.project.open('C:\\p'), ['project:open', 'C:\\p']],
    ['project.save', (a: CanvasApi) => a.project.save({ schemaVersion: 2 }), ['project:save', { schemaVersion: 2 }]],
    ['project.recents', (a: CanvasApi) => a.project.recents(), ['project:recents']],
    ['project.current', (a: CanvasApi) => a.project.current(), ['project:current']],
    ['asset.write', (a: CanvasApi) => a.asset.write(BYTES, 'png'), ['asset:write', { bytes: BYTES, ext: 'png' }]],
    ['asset.read', (a: CanvasApi) => a.asset.read('id1'), ['asset:read', 'id1']],
    ['dialog.openFolder', (a: CanvasApi) => a.dialog.openFolder(), ['dialog:openFolder']],
    ['export.save', (a: CanvasApi) => a.export.save({ bytes: BYTES, ext: 'svg', defaultName: 'board' }), ['export:save', { bytes: BYTES, ext: 'svg', defaultName: 'board' }]]
  ] as const)('%s', (_label, call, expected) => {
    call(api)
    expect(h.invoke).toHaveBeenCalledWith(...expected)
  })
})

// The two listener methods (onPreviewEvent, project.onFlush) use ipcRenderer.on, not
// invoke — out of the invoke-mapping contract (see spec §error-handling). They are
// covered here only to the extent that the api exposes them without throwing.
describe('preload api shape', () => {
  it('exposes the listener methods (registered via ipcRenderer.on, not invoke)', () => {
    expect(typeof api.onPreviewEvent).toBe('function')
    expect(typeof api.project.onFlush).toBe('function')
  })
})
```

- [ ] **Step 2: Run the test**

Run: `pnpm exec vitest run src/preload/preloadApi.integration.test.ts`
Expected: PASS — 28 channel-mapping cases (7 terminal + 12 preview + 9 project/asset/dialog/export)
plus 1 shape test = **29 tests**. If a mapping assertion FAILS, the preload has a channel-name or
arg-shape bug — fix `src/preload/index.ts`, never loosen the test.

> If `await import('./index')` throws: confirm `process.contextIsolated = true` is set BEFORE the
> import (otherwise the `else` branch dereferences `window`), and that `ipcRenderer.on` is mocked.

- [ ] **Step 3: Confirm it lands in the integration project + new baseline**

Run: `pnpm test:integration`
Expected: PASS — now includes `src/preload/preloadApi.integration.test.ts`.

Run: `pnpm test`
Expected: PASS, **662 tests** (633 + 29). Record this as the new baseline.

Run: `pnpm typecheck` → clean. Run: `pnpm lint` → 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/preload/preloadApi.integration.test.ts
git commit -m "test(preload): channel-mapping contract for the contextBridge api (T2)"
```

---

## Task 4: Document the harness + final verify + push

**Files:**
- Modify: `docs/testing/TESTING.md`

- [ ] **Step 1: Append a "MAIN IPC integration — the harness" section** to `docs/testing/TESTING.md`, after the "Adding a test" section:

```markdown
## MAIN IPC integration — the harness

MAIN-process IPC handlers are integration-tested **without booting Electron** via
`src/main/ipcTestHarness.ts`. It captures the channels a `register*Handlers(ipcMain, …)` call
registers, so a test invokes a handler directly with a chosen sender:

- `createIpcCapture()` → `{ ipcMain, handlers, invoke, invokeAs }`. Pass `cap.ipcMain` to the
  production `register*Handlers`; then `cap.invoke('channel', …args)` calls the handler as a trusted
  internal caller, and `cap.invokeAs(foreignEvent, 'channel', …args)` calls it as a given sender.
- Sender fixtures: `internalEvent` (no `senderFrame` → trusted), `foreignEvent` (a non-main frame →
  must be rejected, checklist #17/#20), `mainWin` (a `getWin` resolving to the trusted main frame).

Reference template: `src/main/projectIpc.integration.test.ts` (happy-path handlers with `vi.mock`
collaborators + foreign-sender rejection). Copy its shape for new MAIN-IPC integration tests.

The renderer-facing preload bridge is contract-tested in `src/preload/preloadApi.integration.test.ts`:
every `api.*` method is asserted to invoke the right `ipcRenderer.invoke` channel with the right args.
```

- [ ] **Step 2: Final gate**

Run: `pnpm test`
Expected: PASS, **662 tests**, `unit` + `integration` project tags shown.

Run: `pnpm test:unit` → PASS (577 — unchanged; the preload test is integration, not unit).
Run: `pnpm test:integration` → PASS (now 85: prior 56 + 29 preload).
Run: `pnpm typecheck` → clean. Run: `pnpm lint` → 0 errors.

- [ ] **Step 3: Confirm the harness is not in the app bundle path**

Run: `git grep -l "ipcTestHarness" -- 'src/**/*.ts' ':!*.test.ts' ':!*.integration.test.ts'`
Expected: **no output** — only test files import the harness (so electron-vite tree-shakes it out).
If a non-test file appears, that is a bundling bug: remove the import.

- [ ] **Step 4: Commit + push**

```bash
git add docs/testing/TESTING.md
git commit -m "docs(testing): document the MAIN IPC harness + preload contract (T2)"
git push
```

(Updates PR #37 — the whole testing initiative on the one branch.)

---

## Self-Review

**Spec coverage (§T2 of the design):**
- No-dep shared harness (`createIpcCapture` + fixtures) → Task 1 Step 1. ✅
- Retrofit the 3 existing integration files, count-neutral → Tasks 1 (projectIpc) + 2 (pty/preview). ✅
- Preload channel-mapping contract (28 invoke methods, arg-transforms included) → Task 3. ✅
- `.on` listeners (`onPreviewEvent`/`onFlush`) out of the invoke contract, not silently dropped →
  Task 3 "preload api shape" describe + comment. ✅
- Doc: harness usage + projectIpc as the T3 reference template → Task 4 Step 1. ✅
- Count invariant: Tasks 1–2 neutral (633); Task 3 adds (662) → asserted in every verify step. ✅
- Harness not bundled into the app → Task 4 Step 3 grep guard. ✅
- Single branch / PR #37, one commit per phase → all commits on `testing-strategy`. ✅

**Placeholder scan:** none — every step has full code or an exact command + expected output. The
preload-test mechanism (vi.hoisted holder, `contextIsolated=true` before import, `resetModules`) is
spelled out, not described.

**Type consistency:** `createIpcCapture` / `IpcCapture` / `invoke` / `invokeAs` / `mainFrame` /
`internalEvent` / `foreignEvent` / `mainWin` names match between `ipcTestHarness.ts` and all four
consuming test files. `cap.invokeAs(foreignEvent, channel, …)` and `cap.invoke(channel, …)` shapes are
identical across Tasks 1–2. The preload test types the captured object as `CanvasApi` (exported from
`src/preload/index.ts:190`) and the `it.each` call signatures use real `api.*` method names.

**Count arithmetic:** prior integration = 56 (T0 final); preload adds 29 → integration 85; unit stays
577; total 577 + 85 = **662**. Consistent across Task 3 Step 3 and Task 4 Step 2.
```
