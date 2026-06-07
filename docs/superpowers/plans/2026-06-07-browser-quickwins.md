# Browser board quick-wins — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four Browser-board quick-wins — auto-reconnect on refused, auto-push detected dev-server port to a linked board, open-in-OS-browser, and screenshot-to-clipboard+assets/ — with no schema bump and no security-invariant change.

**Architecture:** A renderer-side engine (single 1s `setInterval` + a pure `planAutoConnect` policy fn) drives reconnect/auto-push by reusing existing IPC (`requestReload` nonce, `detectPorts`, `updateBoard`). Two new frame-guarded main IPC handlers (`preview:openExternal`, `preview:screenshot`) reuse existing primitives (`openExternalSafe`, `capturePage`, content-addressed `writeAsset`, `clipboard`). UI is two URL-bar buttons + a transient note in `BrowserBoard`.

**Tech Stack:** Electron 42 main (`preview.ts`, new `previewScreenshot.ts`), React 18 renderer hooks + Zustand stores, Vitest unit/integration, Playwright `_electron` e2e.

**Worktree:** `feat/browser-quickwins` at `Z:\canvas-ade-browser-quickwins`. All commands run there. Spec: `docs/superpowers/specs/2026-06-07-browser-quickwins-design.md`.

**Deviations from spec (intentional refinements):**
- Screenshot file uses the existing content-addressed `writeAsset` (`assets/<sha1>.png`, dedup + traversal-safe + already tested) instead of a timestamped filename. The IPC returns the relative `assetId`.
- Auto-reconnect acts only on `status === 'load-failed'` (not on in-flight `connecting`), so a slow legitimate load is never interrupted. `detect` fires when a linked board has no usable URL yet.
- The engine keeps one always-on 1s interval (cost negligible; early-continues when idle) rather than start/stop bookkeeping (YAGNI).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/renderer/src/lib/autoConnect.ts` | **new** — pure `planAutoConnect` policy + `backoffTicks` helper (no React/IPC) |
| `src/renderer/src/lib/autoConnect.test.ts` | **new** — unit tests for the two pure fns |
| `src/renderer/src/canvas/boards/useBrowserAutoConnect.ts` | **new** — the engine hook (timer + per-board backoff, calls IPC/store) |
| `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx` | mount the new hook |
| `src/renderer/src/canvas/boards/BrowserBoard.tsx` | open-external + screenshot URL-bar buttons; transient note; "Reconnecting…" state |
| `src/renderer/src/canvas/Icon.tsx` | add `external` + `camera` glyphs |
| `src/main/preview.ts` | `preview:openExternal` handler; `captureViewPng` export; `debugCaptureViewPng` delegates to it |
| `src/main/previewScreenshot.ts` | **new** — `registerPreviewScreenshotHandler` (injected deps, testable) |
| `src/main/previewScreenshot.test.ts` | **new** — handler unit tests |
| `src/main/index.ts` | register the screenshot handler |
| `src/main/preview.integration.test.ts` | add `preview:openExternal` foreign-sender + scheme tests |
| `src/preload/index.ts` + `index.d.ts` | `openExternalPreview`, `screenshotPreview` + result type |
| `e2e/browserReconnect.e2e.ts` | **new** — auto-reconnect end-to-end |
| `e2e/browserScreenshot.e2e.ts` | **new** — screenshot writes a PNG asset |

---

## Task 1: Pure auto-connect policy (`autoConnect.ts`)

**Files:**
- Create: `src/renderer/src/lib/autoConnect.ts`
- Test: `src/renderer/src/lib/autoConnect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/autoConnect.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { planAutoConnect, backoffTicks } from './autoConnect'

describe('planAutoConnect', () => {
  it('idles when already connected (never clobbers a working preview)', () => {
    expect(planAutoConnect({ status: 'connected', hasUrl: true, hasSource: true })).toEqual({
      kind: 'idle'
    })
  })

  it('reloads a load-failed board that has a url', () => {
    expect(planAutoConnect({ status: 'load-failed', hasUrl: true, hasSource: false })).toEqual({
      kind: 'reload'
    })
  })

  it('detects when a linked board has no usable url yet', () => {
    expect(planAutoConnect({ status: 'idle', hasUrl: false, hasSource: true })).toEqual({
      kind: 'detect'
    })
    // load-failed + no url + linked → still discover the url
    expect(planAutoConnect({ status: 'load-failed', hasUrl: false, hasSource: true })).toEqual({
      kind: 'detect'
    })
  })

  it('idles a fresh/connecting board so a legitimate in-flight load is not interrupted', () => {
    expect(planAutoConnect({ status: 'idle', hasUrl: true, hasSource: false })).toEqual({
      kind: 'idle'
    })
    expect(planAutoConnect({ status: 'connecting', hasUrl: true, hasSource: true })).toEqual({
      kind: 'idle'
    })
  })

  it('idles when nothing can be done (no url, no source)', () => {
    expect(planAutoConnect({ status: 'load-failed', hasUrl: false, hasSource: false })).toEqual({
      kind: 'idle'
    })
  })
})

describe('backoffTicks', () => {
  it('ramps 1 → 2 → 4 and caps at 4 (base tick = 1s)', () => {
    expect(backoffTicks(1)).toBe(1)
    expect(backoffTicks(2)).toBe(2)
    expect(backoffTicks(3)).toBe(4)
    expect(backoffTicks(4)).toBe(4)
    expect(backoffTicks(10)).toBe(4)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/renderer/src/lib/autoConnect.test.ts`
Expected: FAIL — "Cannot find module './autoConnect'".

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/lib/autoConnect.ts`:

```ts
/**
 * Pure auto-connect policy for Browser boards (no React, no IPC) — unit-testable.
 *
 * Reconnect + auto-push are one loop: a board that is NOT connected should keep
 * trying until it is. The policy never touches a `connected` board (so a working
 * preview, or a route the user navigated to, is never clobbered):
 *  - `load-failed` + has url      → `reload` (retry the same url; recovers when the
 *                                    dev server comes up at that url).
 *  - linked terminal + no url yet → `detect` (discover the dev-server url from the
 *                                    terminal's printed output, then push it).
 * An in-flight `connecting` load is left alone so a slow-but-legitimate load is
 * never interrupted; if it fails it becomes `load-failed` and the reload path takes over.
 */
export type PreviewStatusLike = 'idle' | 'connecting' | 'connected' | 'load-failed'

export type AutoConnectPlan = { kind: 'idle' } | { kind: 'reload' } | { kind: 'detect' }

export interface AutoConnectInput {
  status: PreviewStatusLike
  /** board.url is a non-empty http(s) URL. */
  hasUrl: boolean
  /** board.previewSourceId is set (a linked source terminal). */
  hasSource: boolean
}

export function planAutoConnect(i: AutoConnectInput): AutoConnectPlan {
  if (i.status === 'connected') return { kind: 'idle' }
  if (i.status === 'load-failed' && i.hasUrl) return { kind: 'reload' }
  if (i.hasSource && !i.hasUrl) return { kind: 'detect' }
  return { kind: 'idle' }
}

/**
 * Ticks to wait before the NEXT attempt, given how many attempts already fired
 * (base tick = 1s): 1st→1s, 2nd→2s, 3rd+→4s. Caps at 4 so polling never stalls.
 */
export function backoffTicks(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1), 4)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/renderer/src/lib/autoConnect.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/autoConnect.ts src/renderer/src/lib/autoConnect.test.ts
git commit -m "feat(browser): pure auto-connect policy (planAutoConnect + backoffTicks)"
```

---

## Task 2: Auto-connect engine hook (`useBrowserAutoConnect.ts`)

**Files:**
- Create: `src/renderer/src/canvas/boards/useBrowserAutoConnect.ts`
- Modify: `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`

There is no fast unit harness for a timer-driven hook that reaches `window.api`; correctness of the policy is covered by Task 1 and the end-to-end behaviour by the Task 8 e2e. This task wires them together.

- [ ] **Step 1: Write the hook**

Create `src/renderer/src/canvas/boards/useBrowserAutoConnect.ts`:

```ts
/**
 * Browser-board auto-connect engine (renderer). One always-on 1s interval drives
 * BOTH reconnect-on-refused and auto-push-detected-port via the pure `planAutoConnect`
 * policy. It reuses existing IPC/store: a `reload` bumps `previewStore.requestReload`
 * (reconcile re-navigates), a `detect` polls `detectPorts` on the linked terminal and
 * (only while NOT connected) sets the board's url via `updateBoard` (a plain setter →
 * no undo step). Per-board exponential backoff (1→2→4s) avoids hammering a dead server.
 *
 * Mounted ONCE beside usePreviewManager (BrowserPreviewLayer). Reads stores via
 * getState() each tick (no selector → no re-render). Security: never writes the PTY;
 * detected URLs are used as-is (origin form from portDetect) and only steer the board url.
 */
import { useEffect, useRef } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { usePreviewStore } from '../../store/previewStore'
import type { BrowserBoard } from '../../lib/boardSchema'
import { planAutoConnect, backoffTicks, type PreviewStatusLike } from '../../lib/autoConnect'

const TICK_MS = 1000

interface Attempt {
  attempts: number
  waitTicks: number
  lastStatus: PreviewStatusLike
}

function isHttpUrl(u: string): boolean {
  try {
    const x = new URL(u)
    return x.protocol === 'http:' || x.protocol === 'https:'
  } catch {
    return false
  }
}

export function useBrowserAutoConnect(): void {
  const attemptsRef = useRef<Map<string, Attempt>>(new Map())

  useEffect(() => {
    const handle = setInterval(() => {
      const cs = useCanvasStore.getState()
      const pv = usePreviewStore.getState()
      const seen = new Set<string>()

      for (const b of cs.boards) {
        if (b.type !== 'browser') continue
        const board = b as BrowserBoard
        seen.add(board.id)
        const status = (pv.byId[board.id]?.status ?? 'idle') as PreviewStatusLike

        let a = attemptsRef.current.get(board.id)
        if (!a) {
          a = { attempts: 0, waitTicks: 0, lastStatus: status }
          attemptsRef.current.set(board.id, a)
        }
        // A status change restarts backoff (a fresh load-failed retries promptly).
        if (status !== a.lastStatus) {
          a.attempts = 0
          a.waitTicks = 0
          a.lastStatus = status
        }
        if (status === 'connected') {
          a.attempts = 0
          a.waitTicks = 0
          continue
        }
        if (a.waitTicks > 0) {
          a.waitTicks--
          continue
        }

        const plan = planAutoConnect({
          status,
          hasUrl: isHttpUrl(board.url),
          hasSource: !!board.previewSourceId
        })
        if (plan.kind === 'idle') continue

        a.attempts++
        a.waitTicks = backoffTicks(a.attempts)

        if (plan.kind === 'reload') {
          usePreviewStore.getState().requestReload(board.id)
        } else if (plan.kind === 'detect') {
          const sourceId = board.previewSourceId
          if (!sourceId) continue
          const bid = board.id
          void (async () => {
            let urls: Awaited<ReturnType<typeof window.api.detectPorts>>
            try {
              urls = await window.api.detectPorts(sourceId)
            } catch {
              return
            }
            if (!urls.length) return
            const next = urls[0].url
            // Re-read live state: skip if the board was deleted or has since connected.
            const live = useCanvasStore.getState()
            const fresh = live.boards.find((x) => x.id === bid)
            if (!fresh || fresh.type !== 'browser') return
            if ((usePreviewStore.getState().byId[bid]?.status ?? 'idle') === 'connected') return
            if ((fresh as BrowserBoard).url !== next) live.updateBoard(bid, { url: next })
          })()
        }
      }

      // GC bookkeeping for removed boards.
      for (const key of [...attemptsRef.current.keys()]) {
        if (!seen.has(key)) attemptsRef.current.delete(key)
      }
    }, TICK_MS)

    return () => clearInterval(handle)
  }, [])
}
```

- [ ] **Step 2: Mount the hook in BrowserPreviewLayer**

Modify `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx` — add the import and call:

```tsx
import type { ReactElement } from 'react'
import { usePreviewManager, type LayerProps } from './usePreviewManager'
import { useBrowserAutoConnect } from './useBrowserAutoConnect'

export function BrowserPreviewLayer(props: LayerProps): ReactElement | null {
  usePreviewManager(props)
  useBrowserAutoConnect()
  return null
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean (0 errors). Fix any unused-import / type errors before continuing.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/boards/useBrowserAutoConnect.ts src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx
git commit -m "feat(browser): auto-connect engine hook (reconnect + auto-push) mounted in preview layer"
```

---

## Task 3: "Reconnecting…" state in BrowserBoard

**Files:**
- Modify: `src/renderer/src/canvas/boards/BrowserBoard.tsx` (the `DeviceContent` load-failed branch, ~lines 313-321)

- [ ] **Step 1: Update the load-failed sub-text**

In `DeviceContent`, the load-failed branch currently shows `runtime.error || url` as the sub-text. Change the sub to read "Reconnecting…" so the board reads as alive (the engine always retries a load-failed board). Replace the load-failed `return` block:

```tsx
  if (runtime.status === 'load-failed') {
    return (
      <div className="bb-state">
        <div className="bb-state-title" style={{ color: 'var(--err)' }}>
          Couldn’t load
        </div>
        <div className="bb-state-sub">Reconnecting… · {runtime.error || url}</div>
      </div>
    )
  }
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/canvas/boards/BrowserBoard.tsx
git commit -m "feat(browser): show 'Reconnecting…' on a load-failed board (auto-connect is retrying)"
```

---

## Task 4: Open-in-OS-browser — main handler

**Files:**
- Modify: `src/main/preview.ts` (add handler inside `registerPreviewHandlers`, after `preview:reload` ~line 567)
- Test: `src/main/preview.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

In `src/main/preview.integration.test.ts`, add a new describe block (follow the existing `cap`/`mainWin` harness already used in that file; the existing `registerPreviewHandlers — foreign-sender rejection (#17)` block at line 81 shows the exact setup to copy):

```ts
describe('preview:openExternal', () => {
  it('rejects a foreign sender (returns false, no open)', () => {
    const opened: string[] = []
    // Reuse this file's existing harness: a real openExternal spy is not reachable
    // here, so assert the guard via the return value (false) like the #17 block does.
    const cap = makeIpcCapture() // same helper the file already uses
    registerPreviewHandlers(cap.ipcMain, mainWin, 'http://127.0.0.1:0/')
    expect(cap.invokeAs(foreignEvent, 'preview:openExternal', 'http://localhost:3000/')).toBe(false)
    expect(opened).toEqual([])
  })

  it('accepts a main-frame sender for an allowed scheme', () => {
    const cap = makeIpcCapture()
    registerPreviewHandlers(cap.ipcMain, mainWin, 'http://127.0.0.1:0/')
    expect(cap.invokeAs(validEvent, 'preview:openExternal', 'http://localhost:3000/')).toBe(true)
  })
})
```

> If the helper names in this file differ (`makeIpcCapture` / `foreignEvent` / `validEvent` / `mainWin`), use whatever the existing blocks in `preview.integration.test.ts` use — copy the closest existing block verbatim and change the channel + args. The assertion that matters: foreign sender → `false`, valid sender + allowed scheme → `true`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/main/preview.integration.test.ts`
Expected: FAIL — no `preview:openExternal` handler registered (invoke returns undefined / throws).

- [ ] **Step 3: Add the handler**

In `src/main/preview.ts`, inside `registerPreviewHandlers`, after the `preview:reload` handler (ends ~line 567), add:

```ts
  // Open the preview's current URL in the OS browser (for real DevTools / extensions).
  // Scheme stays allowlisted via openExternalSafe (Bug #23) — the renderer passes the
  // URL it already shows (liveUrl ?? board.url); nothing new can reach the OS handler
  // that window.open couldn't already. Frame-guarded (Bug #33).
  ipcMain.handle('preview:openExternal', (ev, url: string) => {
    if (isForeignSender(ev, getWin)) return false
    openExternalSafe(String(url))
    return true
  })
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run src/main/preview.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/preview.ts src/main/preview.integration.test.ts
git commit -m "feat(browser): preview:openExternal IPC (scheme-gated, frame-guarded)"
```

---

## Task 5: Screenshot — capture export + handler module

**Files:**
- Modify: `src/main/preview.ts` (add `captureViewPng` export; make `debugCaptureViewPng` delegate)
- Create: `src/main/previewScreenshot.ts`
- Create: `src/main/previewScreenshot.test.ts`
- Modify: `src/main/index.ts` (register the handler)

- [ ] **Step 1: Add `captureViewPng` to preview.ts and delegate the e2e helper**

In `src/main/preview.ts`, add a production capture export (near `debugCaptureViewPng`, ~line 606). Add:

```ts
/**
 * Capture a board's live native view as PNG bytes, or null if the view is missing /
 * detached / off-screen / blank / un-composited. `capturePage()` is BLANK for a
 * detached or off-screen view, so the caller must ensure the board is live first.
 * Used by the user-facing screenshot IPC (previewScreenshot.ts) and the e2e helper.
 */
export async function captureViewPng(id: string): Promise<Buffer | null> {
  const e = views.get(id)
  if (!e || !e.attached) return null
  try {
    const img = await e.view.webContents.capturePage()
    return img.isEmpty() ? null : img.toPNG()
  } catch {
    return null
  }
}
```

Then change `debugCaptureViewPng` (the existing e2e helper ~line 606) to delegate so there is one implementation:

```ts
export async function debugCaptureViewPng(id: string): Promise<Buffer | null> {
  return captureViewPng(id)
}
```

- [ ] **Step 2: Write the failing handler test**

Create `src/main/previewScreenshot.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { registerPreviewScreenshotHandler, type ScreenshotDeps } from './previewScreenshot'

// Minimal ipcMain capture (mirrors clipboardIpc.test.ts style).
function makeIpc(): {
  ipc: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => void }
  invoke: (ch: string, e: unknown, ...a: unknown[]) => unknown
} {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  return {
    ipc: { handle: (ch, fn) => handlers.set(ch, fn) },
    invoke: (ch, e, ...a) => handlers.get(ch)!(e, ...a)
  }
}

const PNG = Buffer.from([1, 2, 3])
function deps(over: Partial<ScreenshotDeps> = {}): ScreenshotDeps {
  return {
    capture: vi.fn(async () => PNG),
    writeImage: vi.fn(),
    currentDir: vi.fn(() => '/proj'),
    saveAsset: vi.fn(async () => ({ assetId: 'assets/abc.png' })),
    ...over
  }
}

// The shared frame guard treats a sender whose frame !== the main window's main frame as
// foreign. We pass a fake event the real isForeignSender rejects/accepts. Mirror the value
// the other *.integration.test.ts files use for foreign vs valid events.
const validEvent = { senderFrame: { url: 'app://main' } } // replace with this repo's valid shape
const foreignEvent = { senderFrame: null } // replace with this repo's foreign shape

describe('preview:screenshot', () => {
  it('copies to clipboard AND saves an asset when a project is open', async () => {
    const m = makeIpc()
    const d = deps()
    registerPreviewScreenshotHandler(m.ipc as never, () => ({}) as never, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(d.writeImage).toHaveBeenCalledWith(PNG)
    expect(d.saveAsset).toHaveBeenCalledWith('/proj', PNG, 'png')
    expect(res).toEqual({ ok: true, assetId: 'assets/abc.png' })
  })

  it('copies to clipboard only when no project is open', async () => {
    const m = makeIpc()
    const d = deps({ currentDir: () => null })
    registerPreviewScreenshotHandler(m.ipc as never, () => ({}) as never, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(d.writeImage).toHaveBeenCalled()
    expect(d.saveAsset).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: true, assetId: null })
  })

  it('returns not-live when the view is detached/off-screen (capture null)', async () => {
    const m = makeIpc()
    const d = deps({ capture: async () => null })
    registerPreviewScreenshotHandler(m.ipc as never, () => ({}) as never, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(d.writeImage).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: false, reason: 'not-live' })
  })

  it('still reports success (assetId null) when the file write fails', async () => {
    const m = makeIpc()
    const d = deps({
      saveAsset: async () => {
        throw new Error('ENOSPC')
      }
    })
    registerPreviewScreenshotHandler(m.ipc as never, () => ({}) as never, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(d.writeImage).toHaveBeenCalled()
    expect(res).toEqual({ ok: true, assetId: null })
  })

  it('rejects a foreign sender (no capture, no clipboard)', async () => {
    const m = makeIpc()
    const d = deps()
    registerPreviewScreenshotHandler(m.ipc as never, () => ({}) as never, d)
    const res = await m.invoke('preview:screenshot', foreignEvent, 'b1')
    expect(d.capture).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: false, reason: 'forbidden' })
  })
})
```

> The `validEvent` / `foreignEvent` shapes must match what `isForeignSender` (`src/main/ipcGuard.ts`) checks. Open `ipcGuard.ts` (and an existing `*.integration.test.ts` that builds these events) and copy the exact shapes. The behavioural assertions are what matter.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm exec vitest run src/main/previewScreenshot.test.ts`
Expected: FAIL — "Cannot find module './previewScreenshot'".

- [ ] **Step 4: Write the handler module**

Create `src/main/previewScreenshot.ts`:

```ts
/**
 * Frame-guarded "screenshot the live preview" IPC. Captures a Browser board's native
 * WebContentsView, copies the PNG to the OS clipboard, and (when a project is open)
 * saves it into the project's content-addressed `assets/` store. Deps are injected so
 * the handler is unit-testable without Electron (mirrors clipboardIpc.ts).
 *
 * Security: frame-guarded (isForeignSender); writes only inside the open project dir
 * (writeAsset); never touches the PTY. A detached/off-screen view captures blank, so
 * that case returns { ok:false, reason:'not-live' } and the renderer guides the user.
 */
import { clipboard, nativeImage, type IpcMain, type BrowserWindow } from 'electron'
import { isForeignSender } from './ipcGuard'
import { getCurrentDir, writeAsset } from './projectStore'
import { captureViewPng } from './preview'

export interface ScreenshotDeps {
  /** PNG bytes of the live view, or null if missing/detached/off-screen/blank. */
  capture(id: string): Promise<Buffer | null>
  writeImage(png: Buffer): void
  currentDir(): string | null
  saveAsset(dir: string, bytes: Uint8Array, ext: string): Promise<{ assetId: string }>
}

export type ScreenshotResult =
  | { ok: true; assetId: string | null }
  | { ok: false; reason: 'not-live' | 'forbidden' }

function realDeps(): ScreenshotDeps {
  return {
    capture: (id) => captureViewPng(id),
    writeImage: (png) => clipboard.writeImage(nativeImage.createFromBuffer(png)),
    currentDir: () => getCurrentDir(),
    saveAsset: (dir, bytes, ext) => writeAsset(dir, bytes, ext)
  }
}

export function registerPreviewScreenshotHandler(
  ipc: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: ScreenshotDeps = realDeps()
): void {
  ipc.handle('preview:screenshot', async (e, id: string): Promise<ScreenshotResult> => {
    if (isForeignSender(e, getWin)) return { ok: false, reason: 'forbidden' }
    const png = await deps.capture(String(id))
    if (!png) return { ok: false, reason: 'not-live' }
    deps.writeImage(png)
    const dir = deps.currentDir()
    if (!dir) return { ok: true, assetId: null }
    try {
      const { assetId } = await deps.saveAsset(dir, png, 'png')
      return { ok: true, assetId }
    } catch {
      // Disk full / locked / read-only: the clipboard copy already succeeded, so report
      // success with no path rather than failing the whole action.
      return { ok: true, assetId: null }
    }
  })
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm exec vitest run src/main/previewScreenshot.test.ts`
Expected: PASS.

- [ ] **Step 6: Register the handler in index.ts**

In `src/main/index.ts`: add the import near the other preview import (line 16):

```ts
import { registerPreviewScreenshotHandler } from './previewScreenshot'
```

and register it right after `registerPreviewHandlers(...)` (line 232):

```ts
  registerPreviewHandlers(ipcMain, () => mainWindow, defaultPreviewUrl)
  registerPreviewScreenshotHandler(ipcMain, () => mainWindow)
```

- [ ] **Step 7: Typecheck + run the main suite**

Run: `pnpm typecheck && pnpm exec vitest run src/main/previewScreenshot.test.ts src/main/preview.integration.test.ts`
Expected: clean typecheck, all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/preview.ts src/main/previewScreenshot.ts src/main/previewScreenshot.test.ts src/main/index.ts
git commit -m "feat(browser): preview:screenshot IPC — clipboard + content-addressed assets/ (frame-guarded)"
```

---

## Task 6: Preload surface (`openExternalPreview`, `screenshotPreview`)

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/preloadApi.integration.test.ts` (channel-mapping assertions, if the file enumerates the api)

- [ ] **Step 1: Add the result type + api methods**

In `src/preload/index.ts`, add the result type near the other mirrored types (after `PreviewEvent`, ~line 74):

```ts
/** Mirrors main `ScreenshotResult` (preview:screenshot). assetId is the relative
 *  `assets/<sha1>.png` path, or null when copied to clipboard but not saved. */
export type PreviewScreenshotResult =
  | { ok: true; assetId: string | null }
  | { ok: false; reason: 'not-live' | 'forbidden' }
```

In the `api` object's browser-navigation block (after `reloadPreview`, ~line 168), add:

```ts
  // Open the preview's current URL in the OS browser (scheme-gated in main).
  openExternalPreview: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('preview:openExternal', url),
  // Screenshot the live view → clipboard + project assets/. { ok:false, reason:'not-live' }
  // when the view is detached/off-screen (capturePage is blank then).
  screenshotPreview: (id: string): Promise<PreviewScreenshotResult> =>
    ipcRenderer.invoke('preview:screenshot', id),
```

- [ ] **Step 2: Update preload api channel-mapping test (if present)**

If `src/preload/preloadApi.integration.test.ts` enumerates api methods → channels (it asserts e.g. `['detectPorts', ..., ['terminal:detectPorts', 'b1']]`), add two rows:

```ts
    ['openExternalPreview', (a: CanvasApi) => a.openExternalPreview('http://x/'), ['preview:openExternal', 'http://x/']],
    ['screenshotPreview', (a: CanvasApi) => a.screenshotPreview('b1'), ['preview:screenshot', 'b1']],
```

- [ ] **Step 3: Typecheck + run preload test**

Run: `pnpm typecheck && pnpm exec vitest run src/preload/preloadApi.integration.test.ts`
Expected: clean, PASS. (`index.d.ts` needs no edit — `CanvasApi = typeof api` flows the new methods to `window.api` automatically.)

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/preload/preloadApi.integration.test.ts
git commit -m "feat(browser): preload openExternalPreview + screenshotPreview"
```

---

## Task 7: URL-bar buttons + icons + screenshot feedback

**Files:**
- Modify: `src/renderer/src/canvas/Icon.tsx` (add `external` + `camera`)
- Modify: `src/renderer/src/canvas/boards/BrowserBoard.tsx`

- [ ] **Step 1: Add the two icons**

In `src/renderer/src/canvas/Icon.tsx`, add to the `IconName` union (after `'globe'`):

```ts
  | 'external'
  | 'camera'
```

and to the `PATHS` record (after the `globe` entry, ~line 88):

```ts
  external: 'M14 5h5v5M19 5l-7 7M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  camera: 'M4 8h3l1.5-2h7L17 8h3v11H4zM12 16.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
```

- [ ] **Step 2: Add a transient note + two buttons to BrowserBoard**

In `src/renderer/src/canvas/boards/BrowserBoard.tsx`:

Add a transient note state near the other `useState` hooks in `BrowserBoard` (after the `lastUrl` state ~line 131):

```tsx
  const [note, setNote] = useState<string | null>(null)
```

Add the two handlers near `commitUrl` / `setViewport` (~line 153):

```tsx
  const openExternal = (): void => {
    void window.api.openExternalPreview(runtime.liveUrl ?? board.url)
  }

  const showNote = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote((n) => (n === msg ? null : n)), 2500)
  }

  const takeScreenshot = (): void => {
    void (async () => {
      const res = await window.api.screenshotPreview(board.id)
      if (!res.ok) showNote('Open the preview to screenshot it')
      else if (res.assetId) showNote('Screenshot copied + saved to assets/')
      else showNote('Screenshot copied to clipboard')
    })()
  }
```

In the URL bar, after the reload `NavBtn` (inside the `<div style={{ display: 'flex', gap: 2 ... }}>` group, ~line 201), add two buttons. The screenshot button is disabled unless the view is live (capturePage is blank otherwise):

```tsx
          <NavBtn name="camera" title="Screenshot" disabled={!runtime.live} onClick={takeScreenshot} />
          <NavBtn name="external" title="Open in browser" onClick={openExternal} />
```

Render the note inside the `bb-stage` (reusing the `.ca-preview-note` class from TerminalBoard) — add just before the closing `</div>` of `.bb-stage` (after the `.bb-frame` block, ~line 274):

```tsx
        {note && (
          <div
            className="ca-preview-note"
            role="status"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {note}
            <button className="ca-preview-dismiss" onClick={() => setNote(null)}>
              Dismiss
            </button>
          </div>
        )}
```

> `NavBtn` currently types `name` as `'back' | 'forward' | 'refresh'`. Widen it to also accept `'camera' | 'external'` (and keep the icon `size` logic — use 14 for the new ones): change the `NavBtn` prop type to `name: 'back' | 'forward' | 'refresh' | 'camera' | 'external'`.

- [ ] **Step 3: Typecheck + lint + build the renderer**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 4: Visual sanity check (HTML chrome only)**

Run: `pnpm build` then the HTML screenshot smoke if convenient. (Optional manual: `pnpm dev`, seed a Browser board, confirm the camera + external buttons render in the URL bar and the camera is disabled until connected.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/Icon.tsx src/renderer/src/canvas/boards/BrowserBoard.tsx
git commit -m "feat(browser): URL-bar screenshot + open-external buttons with transient note"
```

---

## Task 8: E2E — auto-reconnect + screenshot

**Files:**
- Create: `e2e/browserReconnect.e2e.ts`
- Create: `e2e/browserScreenshot.e2e.ts`

These drive the BUILT app (`out/main/index.js`). Build first: `pnpm build`.

- [ ] **Step 1: Write the auto-reconnect e2e**

Create `e2e/browserReconnect.e2e.ts`. It reserves a free loopback port, seeds a Browser board pointed at it (nothing listening → load-failed), then starts a real HTTP server on that exact port from the test process and asserts the board auto-reaches `connected` with NO manual reload:

```ts
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'
import { createServer, type Server } from 'http'
import { once } from 'events'

const runtimeStatus = (id: string, status: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`

async function freePort(): Promise<number> {
  const s = createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const addr = s.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

test.describe('browser board — auto-reconnect', () => {
  test('a refused board auto-connects once the dev server comes up', async ({ page }) => {
    const port = await freePort()
    const url = `http://127.0.0.1:${port}/`
    const id = await seed(page, 'browser', { url, viewport: 'desktop' })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)

    const failed = await pollEval(page, runtimeStatus(id, 'load-failed'), 12_000)
    expect(failed, 'reaches load-failed while nothing is listening').toBe(true)

    // Now start a server on that exact port — the engine should auto-reload + connect.
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html><title>up</title><h1>up</h1>')
    })
    server.listen(port, '127.0.0.1')
    await once(server, 'listening')
    try {
      const connected = await pollEval(page, runtimeStatus(id, 'connected'), 20_000)
      expect(connected, 'auto-reconnects without a manual reload').toBe(true)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
```

- [ ] **Step 2: Write the screenshot e2e**

Create `e2e/browserScreenshot.e2e.ts`. Seed + connect a board against the app's local server, capture, assert the returned asset path exists on disk. (Requires an open project so `assets/` resolves — use the e2e project helpers the suite already exposes: `createTempProject` / `joinPath` / `fileExists` in `__canvasE2EMain`.)

```ts
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const runtimeStatus = (id: string, status: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`

test.describe('browser board — screenshot', () => {
  test('captures the live view → clipboard + assets/ file', async ({ page, electronApp }) => {
    // Open a temp project so assets/ resolves.
    const projDir = await mainCall<string>(electronApp, 'createTempProject')
    try {
      const url = await mainCall<string>(electronApp, 'localUrl')
      const id = await seed(page, 'browser', { url, viewport: 'desktop' })
      await page.waitForTimeout(150)
      await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
      const connected = await pollEval(page, runtimeStatus(id, 'connected'), 12_000)
      expect(connected, 'connected before screenshot').toBe(true)
      await page.waitForTimeout(400) // settle paint so capturePage is non-blank

      const res = await evalIn<{ ok: boolean; assetId: string | null }>(
        page,
        `window.api.screenshotPreview(${JSON.stringify(id)})`
      )
      expect(res.ok, 'screenshot ok').toBe(true)
      expect(res.assetId, 'assetId returned (project open)').toBeTruthy()

      const abs = await mainCall<string>(electronApp, 'joinPath', projDir, res.assetId!)
      const exists = await mainCall<boolean>(electronApp, 'fileExists', abs)
      expect(exists, 'asset PNG written to disk').toBe(true)
    } finally {
      await mainCall<boolean>(electronApp, 'teardownProject')
    }
  })
})
```

> Verify the exact `__canvasE2EMain` helper names (`createTempProject`, `teardownProject`, `joinPath`, `fileExists`, `localUrl`) and the `evalIn` return-typing shape against `e2e/helpers.ts` + `src/main/e2eMain.ts`; adapt the calls if a signature differs. The behavioural assertions are the contract. If `createTempProject` returns an object (`{dir}`) rather than a string, destructure accordingly.

- [ ] **Step 3: Run both e2e specs (Windows-native)**

Run: `pnpm build` then `pnpm exec playwright test e2e/browserReconnect.e2e.ts e2e/browserScreenshot.e2e.ts`
Expected: PASS. (If `browserScreenshot` flakes on a blank capture in a GPU-contended run, increase the settle `waitForTimeout`; the native-view trio is a known env flake — memory `e2e-browser-trio-flake`.)

- [ ] **Step 4: Commit**

```bash
git add e2e/browserReconnect.e2e.ts e2e/browserScreenshot.e2e.ts
git commit -m "test(browser): e2e auto-reconnect + screenshot-to-assets"
```

---

## Task 9: Full gate + e2e matrix + cleanup

**Files:**
- Delete (throwaway from the screenshot session, if present in this worktree): none — `e2e/_shots.e2e.ts` + `.shots/` live in the MAIN dir, not this worktree; leave them for the user to remove.

- [ ] **Step 1: Full local gate**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm exec vitest run`
Expected: 0 type errors, 0 lint errors, format clean, all unit+integration green. (Gate MUST include `format:check` — memory `gate-must-run-format-check`.)

- [ ] **Step 2: E2E matrix (Windows-native + Linux-Docker)**

Run: `pnpm test:e2e:matrix`
Expected: both legs green. (e2e is the pre-push gate — memory `e2e-before-handoff`. If the live-`WebContentsView` trio flakes, rerun once — `e2e-browser-trio-flake`.)

- [ ] **Step 3: Format-fix if needed + final commit**

```bash
pnpm format
git add -A
git commit -m "chore(browser): format + gate green for quick-wins bundle"
```

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin feat/browser-quickwins
gh pr create --base main --head feat/browser-quickwins \
  --title "feat(browser): quick-wins — auto-reconnect, auto-push, open-external, screenshot" \
  --body "See docs/superpowers/specs/2026-06-07-browser-quickwins-design.md. Auto-reconnect on refused, auto-push detected port to a linked board, open-in-OS-browser, screenshot to clipboard + assets/. No schema bump, no weakened invariant. Gate + e2e matrix green."
```

---

## Self-review (author checklist — done)

- **Spec coverage:** auto-reconnect (Task 1+2+3+8), auto-push (Task 1+2+8), open-external (Task 4+6+7), screenshot (Task 5+6+7+8), no schema bump (confirmed — only `url` reused), security (frame-guards in 4+5, scheme-gate reused, assets-only write, no PTY). All covered.
- **Placeholder scan:** no TBD/TODO; the two notes about copying existing test-harness shapes (`isForeignSender` event shapes, `__canvasE2EMain` helper names) are explicit "verify against this file" instructions, not gaps — the behavioural assertions are fully specified.
- **Type consistency:** `ScreenshotResult` (main) ↔ `PreviewScreenshotResult` (preload) carry the same `{ ok, assetId } | { ok:false, reason }` shape; `planAutoConnect`/`backoffTicks`/`AutoConnectInput`/`PreviewStatusLike` names match across Tasks 1 and 2; `captureViewPng` defined in Task 5 used by `previewScreenshot.ts` in the same task; `NavBtn` name-union widened in Task 7 to match the new icons added in Task 7.
