# Self-Smoke Harness — Stage 1 (in-process) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command boots the **built** app headless, seeds one of each board type, and asserts each works at runtime — terminal PTY↔xterm bridge, Browser **native-layer** `capturePage` (the gap `mainWindow.capturePage()` can't see), and Planning element round-trip — emitting machine-readable markers and exiting non-zero on any failure.

**Architecture:** Extend the existing `CANVAS_SMOKE` plumbing in `src/main/index.ts` with a new `CANVAS_SMOKE=e2e` mode. MAIN drives the renderer through `webContents.executeJavaScript` against an **env-gated** renderer test hook (`window.__canvasE2E`), gated by a `?e2e=1` query param on the loaded page (sandbox-proof — no preload/security change). The hook seeds boards via the existing Zustand store and reads back state. MAIN asserts the Browser native layer by reaching the already-existing `views` Map in `preview.ts` via a new exported accessor and calling `view.webContents.capturePage()` per view. Terminal output is read straight off the xterm framebuffer (`term.buffer.active`) — zero new deps, no `addon-serialize`.

**Tech Stack:** Electron 33 (main + preload + renderer), React 18 + React Flow v12, Zustand, `@xterm/xterm`, electron-vite (build → `out/`), Vitest 2 (pure-module tests only).

**Why this is Stage 1:** Closes the open **#1 live-verify gap** (boards never driven live) with **zero new dependencies** and no security surface change. Stage 2 (Playwright `_electron` for real DOM clicks/drag/pen) is a **separate plan** — see the closing note. Per `docs/research/self-smoke-testing.md` the in-process layer is the recommended first step.

**Run target (decided):** the **built** app (`out/main/index.js`), not the dev server. node-pty's Electron ABI then matches what ships, and there's no HMR flake. Every harness run = `pnpm build` then launch with the env var set.

**Determinism:** Browser boards point at the in-process `localServer.url` (already running during smoke — `src/main/localServer.ts`), never an external URL. A live URL → real `connected`; this also answers the Track-2 "connected-on-dead-URL?" question for free.

---

## File Structure

**Create:**
- `src/main/e2eReport.ts` — pure result summarizer (`summarizeE2E`): parts → `{ ok, exitCode, line }`. The only vitest-testable unit.
- `src/main/e2eReport.test.ts` — colocated tests for the summarizer.
- `src/main/e2eSmoke.ts` — MAIN orchestrator (`runE2ESmoke`): drives the renderer hook, asserts each board, returns a summary. Integration-verified via the run command (not vitest).
- `src/renderer/src/smoke/e2eRegistry.ts` — `isE2E()` (reads `?e2e=1`) + the `e2eTerminals` Map of live xterm instances by board id.
- `src/renderer/src/smoke/e2eHooks.ts` — `installE2EHooks(rf)`: defines `window.__canvasE2E` (seed/read helpers). Declares the `Window` global.

**Modify:**
- `src/main/preview.ts` — export `debugCaptureView(id)` + `debugViewIds()` (read-only accessors over the existing module-level `views` Map).
- `src/main/index.ts` — add the `CANVAS_SMOKE=e2e` branch (query-param load + run `runE2ESmoke` + set `process.exitCode`), and re-add a committed `CANVAS_SHOT` dev capture path.
- `src/renderer/src/canvas/Canvas.tsx` — install the hook inside `CanvasInner` (has `rf`) when `isE2E()`.
- `src/renderer/src/canvas/boards/TerminalBoard.tsx` — register/unregister the xterm instance in `e2eTerminals` when `isE2E()` (2 lines).

---

## Conventions for every run

- **Build first:** `pnpm build` (electron-vite → `out/`). The harness launches the built main.
- **Launch (PowerShell, this machine):**
  ```powershell
  pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start
  ```
  (`pnpm start` = `electron-vite preview` → runs `out/main/index.js`.) Unset afterward: `Remove-Item Env:\CANVAS_SMOKE`.
- **Expected on success:** stdout shows `E2E_TERMINAL …`, `E2E_BROWSER …`, `E2E_PLANNING …`, then `E2E_DONE {"ok":true,…}`, and the process exits 0. On any failure the matching marker has `"ok":false` and `E2E_DONE` has `"ok":false` with exit code 1.
- Gate checks before each commit: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`.

---

### Task 1: Pure result summarizer (`e2eReport`)

**Files:**
- Create: `src/main/e2eReport.ts`
- Test: `src/main/e2eReport.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/e2eReport.test.ts
import { describe, it, expect } from 'vitest'
import { summarizeE2E } from './e2eReport'

describe('summarizeE2E', () => {
  it('ok + exit 0 when every part passed', () => {
    const r = summarizeE2E([
      { name: 'terminal', ok: true },
      { name: 'browser', ok: true }
    ])
    expect(r.ok).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(r.line.startsWith('E2E_DONE ')).toBe(true)
  })

  it('not ok + exit 1 when any part failed', () => {
    const r = summarizeE2E([
      { name: 'terminal', ok: true },
      { name: 'browser', ok: false, detail: 'capture empty' }
    ])
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBe(1)
  })

  it('treats an empty list as failure (nothing actually ran)', () => {
    const r = summarizeE2E([])
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBe(1)
  })

  it('serializes parts into the E2E_DONE line', () => {
    const r = summarizeE2E([{ name: 'planning', ok: true, detail: '1 checklist' }])
    expect(r.line).toContain('"planning"')
    expect(r.line).toContain('1 checklist')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/e2eReport.test.ts`
Expected: FAIL — "Failed to resolve import './e2eReport'" / `summarizeE2E is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/e2eReport.ts
/**
 * Pure summarizer for the in-process E2E smoke (`CANVAS_SMOKE=e2e`). Keeps the
 * pass/fail + exit-code decision out of the Electron orchestrator so it can be
 * unit-tested without an Electron runtime. An empty parts list is a FAILURE —
 * it means nothing actually ran (e.g. the renderer hook never appeared).
 */
export interface E2EPart {
  /** Board/area name: 'terminal' | 'browser' | 'planning'. */
  name: string
  ok: boolean
  /** Human-readable evidence (echoed into the marker line). */
  detail?: string
}

export interface E2ESummary {
  ok: boolean
  /** 0 when ok, 1 otherwise — assigned to process.exitCode by the caller. */
  exitCode: number
  /** The `E2E_DONE …` stdout marker line. */
  line: string
}

export function summarizeE2E(parts: E2EPart[]): E2ESummary {
  const ok = parts.length > 0 && parts.every((p) => p.ok)
  return { ok, exitCode: ok ? 0 : 1, line: `E2E_DONE ${JSON.stringify({ ok, parts })}` }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/e2eReport.test.ts`
Expected: PASS — 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/e2eReport.ts src/main/e2eReport.test.ts
git commit -m "test(e2e): pure summarizer for in-process smoke results"
```

---

### Task 2: e2e flag + terminal registry (renderer) + query-param load (main)

**Files:**
- Create: `src/renderer/src/smoke/e2eRegistry.ts`
- Modify: `src/main/index.ts` (lines 12, 60-64, 77-85 region)

- [ ] **Step 1: Create the registry module**

```ts
// src/renderer/src/smoke/e2eRegistry.ts
/**
 * In-process E2E test surface (Stage 1). Everything here is INERT unless the page
 * was loaded with `?e2e=1` (set only by MAIN under `CANVAS_SMOKE=e2e`). This is a
 * registry + a flag — NOT a security change: `sandbox`/`contextIsolation`/
 * `nodeIntegration` are untouched, and nothing here is reachable in normal runs.
 */
import type { Terminal } from '@xterm/xterm'

/** True only when MAIN loaded the page with the e2e query flag. */
export function isE2E(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('e2e') === '1'
  } catch {
    return false
  }
}

/**
 * Live xterm instances by board id, populated by TerminalBoard ONLY in e2e mode so
 * the hook can read the framebuffer (`term.buffer.active`) — proving the full
 * PTY → MessagePort → renderer → xterm bridge without scraping the DOM.
 */
export const e2eTerminals = new Map<string, Terminal>()
```

- [ ] **Step 2: Add the e2e mode to the SMOKE comment + query-param load in main**

In `src/main/index.ts`, update the SMOKE comment (line 12) to document the new mode:

```ts
const SMOKE = process.env.CANVAS_SMOKE // "1"=self-test, "exit"=self-test+quit, "e2e"=board harness+quit
```

Replace the load block (currently lines 60-64) so e2e mode appends `?e2e=1`:

```ts
  const e2e = SMOKE === 'e2e'
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL']
    mainWindow.loadURL(e2e ? `${base}?e2e=1` : base)
  } else {
    mainWindow.loadFile(
      join(__dirname, '../renderer/index.html'),
      e2e ? { query: { e2e: '1' } } : undefined
    )
  }
```

- [ ] **Step 3: Verify the flag round-trips (temporary probe)**

Temporarily, inside the `if (SMOKE && mainWindow)` did-finish-load block in `index.ts`, add a one-line probe BEFORE the existing `runSelfTest` call:

```ts
      smokeLog('E2E_FLAG ' + (await mainWindow!.webContents.executeJavaScript(
        "new URLSearchParams(location.search).get('e2e')", true)))
```

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: stdout contains `E2E_FLAG 1`. (In plain `CANVAS_SMOKE=exit` mode it would print `E2E_FLAG null`.)

- [ ] **Step 4: Remove the temporary probe**

Delete the `E2E_FLAG` probe line added in Step 3 (Task 4 replaces it with the real orchestrator call).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/smoke/e2eRegistry.ts src/main/index.ts
git commit -m "feat(e2e): add CANVAS_SMOKE=e2e flag + query-param load + terminal registry"
```

---

### Task 3: Renderer test hook (`installE2EHooks`) + wire into Canvas

**Files:**
- Create: `src/renderer/src/smoke/e2eHooks.ts`
- Modify: `src/renderer/src/canvas/Canvas.tsx` (imports + `CanvasInner` effect)

- [ ] **Step 1: Create the hook module**

```ts
// src/renderer/src/smoke/e2eHooks.ts
/**
 * In-process E2E renderer hook (Stage 1). When the page is in e2e mode this installs
 * `window.__canvasE2E` — a tiny imperative surface MAIN drives via
 * `webContents.executeJavaScript`: seed boards through the real Zustand store, read
 * board/runtime state back, read a terminal's framebuffer, and fit the camera. All
 * return values are JSON-serializable so they survive the executeJavaScript bridge.
 *
 * Installed from CanvasInner (which owns the React Flow instance) and guarded by
 * isE2E(); a no-op in every normal run.
 */
import type { ReactFlowInstance } from '@xyflow/react'
import { useCanvasStore } from '../store/canvasStore'
import { usePreviewStore } from '../store/previewStore'
import { fromObject, type Board, type BoardType } from '../lib/boardSchema'
import { makeChecklist } from '../canvas/boards/planning/elements'
import { e2eTerminals } from './e2eRegistry'

/** Per-board runtime fields the harness asserts on (subset of PreviewRuntime). */
interface RuntimeProbe {
  status: string
  live: boolean
}

export interface CanvasE2E {
  /** Add a board at an auto-incremented world x; optionally patch durable props. */
  seedBoard: (type: BoardType, patch?: Partial<Board>) => string
  /** Current boards (plain data — serializable). */
  getBoards: () => Board[]
  /** Browser preview runtime for a board id, or null if none yet. */
  getRuntime: (id: string) => RuntimeProbe | null
  /** Whole xterm framebuffer for a terminal board id, or null if not registered. */
  readTerminal: (id: string) => string | null
  /** Append a checklist element (one starter item) to a planning board. */
  addChecklist: (id: string) => void
  /** Fit the camera to one board (id) or all boards — forces zoom ≥ LOD for capture. */
  fitView: (id?: string) => void
  /** True if the live store round-trips through toObject→fromObject without throwing. */
  roundTripOk: () => boolean
}

declare global {
  interface Window {
    __canvasE2E?: CanvasE2E
  }
}

let seedX = 0

export function installE2EHooks(rf: ReactFlowInstance): void {
  const api: CanvasE2E = {
    seedBoard(type, patch) {
      const store = useCanvasStore.getState()
      const id = store.addBoard(type, { x: seedX, y: 0 })
      seedX += 760 // wider than the largest default board (browser 700) → no overlap
      if (patch) store.updateBoard(id, patch)
      return id
    },
    getBoards() {
      return useCanvasStore.getState().boards
    },
    getRuntime(id) {
      const r = usePreviewStore.getState().byId[id]
      return r ? { status: r.status, live: r.live } : null
    },
    readTerminal(id) {
      const term = e2eTerminals.get(id)
      if (!term) return null
      const buf = term.buffer.active
      let out = ''
      for (let i = 0; i < buf.length; i++) {
        out += (buf.getLine(i)?.translateToString(true) ?? '') + '\n'
      }
      return out
    },
    addChecklist(id) {
      const store = useCanvasStore.getState()
      const b = store.boards.find((x) => x.id === id)
      if (!b || b.type !== 'planning') return
      const cl = makeChecklist(crypto.randomUUID(), crypto.randomUUID(), { x: 60, y: 60 })
      store.updateBoard(id, { elements: [...b.elements, cl] })
    },
    fitView(id) {
      const opts = { maxZoom: 1, padding: 0.2, duration: 0 } as const
      void rf.fitView(id ? { ...opts, nodes: [{ id }] } : opts)
    },
    roundTripOk() {
      try {
        fromObject(useCanvasStore.getState().toObject())
        return true
      } catch {
        return false
      }
    }
  }
  window.__canvasE2E = api
}
```

- [ ] **Step 2: Wire the hook into CanvasInner**

In `src/renderer/src/canvas/Canvas.tsx`, add imports near the other local imports (after line 40 `import DiagOverlay…`):

```ts
import { isE2E } from '../smoke/e2eRegistry'
import { installE2EHooks } from '../smoke/e2eHooks'
```

Then add an effect inside `CanvasInner` (place it right after the existing keydown `useEffect` that ends at line 164, before the `return`):

```ts
  // E2E (CANVAS_SMOKE=e2e): expose the imperative test hook once the canvas (and its
  // React Flow instance) is live. No-op in every normal run (guarded by isE2E()).
  useEffect(() => {
    if (isE2E()) installE2EHooks(rf)
  }, [rf])
```

- [ ] **Step 3: Verify the hook appears (temporary probe)**

Temporarily, in `index.ts`'s `if (SMOKE && mainWindow)` did-finish-load block, before `runSelfTest`, add:

```ts
      smokeLog('E2E_HOOK ' + (await mainWindow!.webContents.executeJavaScript(
        '!!window.__canvasE2E', true)))
```

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: stdout contains `E2E_HOOK true`. (The hook installs after React mounts; if it prints `false`, the orchestrator in Task 4 handles the wait — but at did-finish-load it is usually already `true`.)

- [ ] **Step 4: Remove the temporary probe; run gates**

Delete the `E2E_HOOK` line. Then:

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green (no new tests, but typecheck must accept the `Window.__canvasE2E` global + the hook module).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/smoke/e2eHooks.ts src/renderer/src/canvas/Canvas.tsx
git commit -m "feat(e2e): renderer test hook (window.__canvasE2E) installed from CanvasInner"
```

---

### Task 4: MAIN orchestrator skeleton + wire into index.ts

**Files:**
- Create: `src/main/e2eSmoke.ts`
- Modify: `src/main/index.ts` (did-finish-load block, lines 77-85 region)

- [ ] **Step 1: Create the orchestrator skeleton (boards seeded, no per-board asserts yet)**

```ts
// src/main/e2eSmoke.ts
/**
 * In-process board harness (CANVAS_SMOKE=e2e). MAIN seeds one of each board type
 * through the renderer hook (window.__canvasE2E) and asserts each works at runtime,
 * INCLUDING the Browser native WebContentsView layer that mainWindow.capturePage()
 * cannot see (asserted here via the preview manager's own per-view capturePage).
 *
 * Emits one marker line per board + a final E2E_DONE, and returns a summary whose
 * exitCode the caller assigns to process.exitCode. Verified by running the command;
 * not a vitest target (needs the live Electron runtime).
 */
import type { BrowserWindow } from 'electron'
import { summarizeE2E, type E2EPart } from './e2eReport'

/** Sentinel echoed into a terminal board to prove the PTY↔xterm data plane. */
const TERM_SENTINEL = 'CANVAS_E2E_TERM_OK'

function evalIn<T>(win: BrowserWindow, expr: string): Promise<T> {
  return win.webContents.executeJavaScript(expr, true) as Promise<T>
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll `fn` until it resolves truthy or the timeout elapses. */
async function poll(fn: () => Promise<boolean>, timeoutMs: number, stepMs = 120): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await delay(stepMs)
  }
}

export async function runE2ESmoke(win: BrowserWindow, localUrl: string): Promise<number> {
  const parts: E2EPart[] = []

  // The hook installs after React mounts — wait for it before driving anything.
  const hookReady = await poll(() => evalIn<boolean>(win, '!!window.__canvasE2E'), 8000)
  if (!hookReady) {
    const s = summarizeE2E([{ name: 'hook', ok: false, detail: 'window.__canvasE2E never appeared' }])
    console.log(s.line)
    return s.exitCode
  }

  // Tasks 5-7 push real parts here. For now, prove the seam: seed one of each and
  // assert they reached the store.
  await evalIn(win, "window.__canvasE2E.seedBoard('terminal')")
  await evalIn(win, `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(localUrl)} })`)
  await evalIn(win, "window.__canvasE2E.seedBoard('planning')")
  const count = await evalIn<number>(win, 'window.__canvasE2E.getBoards().length')
  parts.push({ name: 'seed', ok: count === 3, detail: `${count} boards` })

  const summary = summarizeE2E(parts)
  for (const p of parts) console.log(`E2E_${p.name.toUpperCase()} ${JSON.stringify(p)}`)
  console.log(summary.line)
  return summary.exitCode
}
```

- [ ] **Step 2: Wire the e2e branch into index.ts**

In `src/main/index.ts`, add the import near the other main imports (after line 7 `import { runSelfTest } from './selfTest'`):

```ts
import { runE2ESmoke } from './e2eSmoke'
```

Replace the existing `if (SMOKE && mainWindow) { … }` block (lines 77-85) with a branch on the mode:

```ts
  if (SMOKE && mainWindow) {
    mainWindow.webContents.once('did-finish-load', async () => {
      if (SMOKE === 'e2e') {
        const code = await runE2ESmoke(mainWindow!, localServer!.url)
        process.exitCode = code
        setTimeout(() => app.quit(), 400)
      } else {
        const ok = await runSelfTest(mainWindow!, localServer!.url)
        smokeLog(`SELFTEST_DONE ${JSON.stringify(ok)}`)
        if (SMOKE === 'exit') setTimeout(() => app.quit(), 400)
      }
    })
  }
```

- [ ] **Step 3: Run the harness — expect the skeleton to pass the seed check**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: stdout contains `E2E_SEED {"name":"seed","ok":true,"detail":"3 boards"}` and `E2E_DONE {"ok":true,…}`; process exits 0. Confirm exit code:

```powershell
pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start; "exit=$LASTEXITCODE"
```
Expected: `exit=0`.

- [ ] **Step 4: Confirm failure path sets exit 1 (sanity, then revert)**

Temporarily change `count === 3` to `count === 99` in `e2eSmoke.ts`, rebuild + run, confirm `E2E_DONE {"ok":false…}` and `exit=1`, then revert to `count === 3`.

- [ ] **Step 5: Commit**

```bash
git add src/main/e2eSmoke.ts src/main/index.ts
git commit -m "feat(e2e): MAIN orchestrator skeleton + CANVAS_SMOKE=e2e branch with exit code"
```

---

### Task 5: Terminal assertion (register xterm + readback over the full bridge)

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx` (register/unregister in `e2eTerminals`)
- Modify: `src/main/e2eSmoke.ts` (replace the terminal seed with a real assertion)

**What this proves:** the launch line written by MAIN (`pty.write`) is echoed by the PTY and flows PTY → MessagePort → `window.postMessage` → `TerminalBoard.onWinMsg` → `term.write`, landing in the xterm framebuffer. (Shell *execution* is already proven by `selfTest.testPty`; this proves the renderer bridge.)

- [ ] **Step 1: Write the assertion in the orchestrator (the "test")**

In `src/main/e2eSmoke.ts`, replace the terminal seed line from Task 4 with:

```ts
  // ── Terminal: seed with a launchCommand that echoes the sentinel, then read it
  // back off the xterm framebuffer (proves the PTY↔xterm data plane end to end). ──
  const termId = await evalIn<string>(
    win,
    `window.__canvasE2E.seedBoard('terminal', { launchCommand: 'echo ${TERM_SENTINEL}' })`
  )
  const termOk = await poll(async () => {
    const text = await evalIn<string | null>(
      win,
      `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
    )
    return typeof text === 'string' && text.includes(TERM_SENTINEL)
  }, 10000)
  parts.push({ name: 'terminal', ok: termOk, detail: termOk ? 'sentinel in framebuffer' : 'no sentinel' })
```

- [ ] **Step 2: Run to verify it FAILS (registry not populated yet)**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_TERMINAL {"name":"terminal","ok":false,"detail":"no sentinel"}` — `readTerminal` returns null because no instance is registered.

- [ ] **Step 3: Register the xterm instance in e2e mode**

In `src/renderer/src/canvas/boards/TerminalBoard.tsx`, add the import (after line 31 `} from './terminalState'`):

```ts
import { isE2E, e2eTerminals } from '../../smoke/e2eRegistry'
```

Inside `spawn()`, immediately after `termRef.current = term` and `fitRef.current = fit` (line 109), add:

```ts
    if (isE2E()) e2eTerminals.set(board.id, term)
```

In the teardown returned from `spawn()`, just before `term.dispose()` (line 187), add:

```ts
      if (isE2E()) e2eTerminals.delete(board.id)
```

- [ ] **Step 4: Run to verify it PASSES**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_TERMINAL {"name":"terminal","ok":true,"detail":"sentinel in framebuffer"}`.

- [ ] **Step 5: Run gates + commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add src/renderer/src/canvas/boards/TerminalBoard.tsx src/main/e2eSmoke.ts
git commit -m "feat(e2e): assert terminal PTY-to-xterm bridge via framebuffer readback"
```

---

### Task 6: Browser native-layer assertion (the gap)

**Files:**
- Modify: `src/main/preview.ts` (export `debugCaptureView` + `debugViewIds`)
- Modify: `src/main/e2eSmoke.ts` (replace the browser seed with a real assertion)

**What this proves:** the Browser board's native `WebContentsView` loads `localUrl`, reaches `connected`, attaches over its device stage, and yields a **non-blank** `capturePage()` — the exact native layer `mainWindow.capturePage()` is blind to.

- [ ] **Step 1: Add read-only capture accessors to preview.ts**

In `src/main/preview.ts`, append after `disposeAll()` (after line 276):

```ts
/**
 * E2E (in-process smoke) ONLY — read-only accessors over the live `views` Map.
 * `capturePage()` is BLANK for a detached/off-screen view, so this returns
 * `attached` too: the harness must ensure the board is live (zoom ≥ LOD, on-screen,
 * connected) before trusting `empty`. Not a security change — it exposes nothing the
 * preview IPC handlers don't already.
 */
export async function debugCaptureView(id: string): Promise<{ attached: boolean; empty: boolean }> {
  const e = views.get(id)
  if (!e || !e.attached) return { attached: false, empty: true }
  const img = await e.view.webContents.capturePage()
  return { attached: true, empty: img.isEmpty() }
}

/** E2E ONLY — ids of every native preview view currently created. */
export function debugViewIds(): string[] {
  return [...views.keys()]
}
```

- [ ] **Step 2: Write the assertion in the orchestrator**

In `src/main/e2eSmoke.ts`, add the import at the top (after the `e2eReport` import):

```ts
import { debugCaptureView } from './preview'
```

Replace the browser seed line from Task 4 with:

```ts
  // ── Browser: seed pointing at the in-process localServer (deterministic), fit the
  // camera to it (forces zoom ≥ LOD so the native view attaches), wait for the
  // connected status, then assert a NON-BLANK per-view capturePage (the gap). ──
  const browserId = await evalIn<string>(
    win,
    `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(localUrl)} })`
  )
  await delay(150) // let React Flow mount + measure the new node before fitView
  await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
  const connected = await poll(async () => {
    const rt = await evalIn<{ status: string; live: boolean } | null>(
      win,
      `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
    )
    return rt?.status === 'connected' && rt.live === true
  }, 10000)
  let capDetail = 'not connected'
  let browserOk = false
  if (connected) {
    const cap = await debugCaptureView(browserId)
    browserOk = cap.attached && !cap.empty
    capDetail = `attached=${cap.attached} empty=${cap.empty}`
  }
  parts.push({ name: 'browser', ok: browserOk, detail: capDetail })
```

- [ ] **Step 3: Run to verify it PASSES**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_BROWSER {"name":"browser","ok":true,"detail":"attached=true empty=false"}`.

If `status` reaches `connecting` but never `connected`: the live page is the `localServer` page (`localServer.ts` sets `document.title='localhost preview OK'` + logs `LOCAL_PAGE_OK`) — confirm `localServer` is up by checking the older `SELFTEST_DONE` preview field via `CANVAS_SMOKE=exit`. If `empty=true` while `attached=true`: the view was captured mid-gesture/off-screen — increase the `delay` before `fitView` to 300ms and re-run.

- [ ] **Step 4: Confirm the dead-URL path (answers the Track-2 question, then revert)**

Temporarily seed with a dead URL: change the seed to `{ url: 'http://127.0.0.1:1/' }`. Rebuild + run. Expected: `getRuntime().status` becomes `load-failed` (NOT `connected`), so `connected` stays false and `E2E_BROWSER` is `ok:false, detail:"not connected"`. This confirms a dead localhost reaches `load-failed`. Revert to `localUrl`.

- [ ] **Step 5: Run gates + commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add src/main/preview.ts src/main/e2eSmoke.ts
git commit -m "feat(e2e): assert Browser native WebContentsView via per-view capturePage"
```

---

### Task 7: Planning assertion + round-trip + committed CANVAS_SHOT path

**Files:**
- Modify: `src/main/e2eSmoke.ts` (replace the planning seed with a real assertion)
- Modify: `src/main/index.ts` (add the committed `CANVAS_SHOT` dev capture path)

- [ ] **Step 1: Write the planning assertion in the orchestrator**

In `src/main/e2eSmoke.ts`, replace the planning seed line from Task 4 with:

```ts
  // ── Planning: seed, add a checklist element, assert it persisted on the board AND
  // that the whole canvas round-trips through the schema (persistence-readiness). ──
  const planId = await evalIn<string>(win, "window.__canvasE2E.seedBoard('planning')")
  await evalIn(win, `window.__canvasE2E.addChecklist(${JSON.stringify(planId)})`)
  const planProbe = await evalIn<{ kinds: string[]; roundTrip: boolean }>(
    win,
    `(() => {
       const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(planId)});
       const kinds = b && b.type === 'planning' ? b.elements.map((e) => e.kind) : [];
       return { kinds, roundTrip: window.__canvasE2E.roundTripOk() };
     })()`
  )
  const planOk = planProbe.kinds.includes('checklist') && planProbe.roundTrip
  parts.push({
    name: 'planning',
    ok: planOk,
    detail: `elements=[${planProbe.kinds.join(',')}] roundTrip=${planProbe.roundTrip}`
  })
```

- [ ] **Step 2: Run to verify it PASSES**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_PLANNING {"name":"planning","ok":true,"detail":"elements=[checklist] roundTrip=true"}` and `E2E_DONE {"ok":true,…}` with `exit=0`.

- [ ] **Step 3: Add the committed CANVAS_SHOT dev capture path (HTML only)**

In `src/main/index.ts`, add the import at the top (after line 1):

```ts
import { writeFileSync } from 'fs'
```

Inside `createWindow()`, after the existing `if (SMOKE) { … console-message … }` block (after line 58), add:

```ts
  // Dev-only HTML screenshot path (committed, env-gated). Captures the renderer DOM
  // (NOT the native WebContentsView — that's what the e2e Browser capture is for).
  // Usage: $env:CANVAS_SHOT='C:\tmp\canvas.png'; pnpm start
  const shotPath = process.env.CANVAS_SHOT
  if (shotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await mainWindow!.webContents.capturePage()
          writeFileSync(shotPath, img.toPNG())
          smokeLog(`CANVAS_SHOT_DONE ${shotPath}`)
        } catch (err) {
          smokeLog(`CANVAS_SHOT_FAIL ${(err as Error).message}`)
        }
        app.quit()
      }, 800)
    })
  }
```

- [ ] **Step 4: Verify the screenshot path writes a PNG**

Run: `pnpm build; $env:CANVAS_SHOT="$PWD\canvas-shot.png"; pnpm start`
Expected: stdout `CANVAS_SHOT_DONE …\canvas-shot.png`; file exists and is a non-empty PNG (`(Get-Item .\canvas-shot.png).Length` > 0). Then `Remove-Item Env:\CANVAS_SHOT; Remove-Item .\canvas-shot.png`.

- [ ] **Step 5: Run full gates + commit**

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
git add src/main/e2eSmoke.ts src/main/index.ts
git commit -m "feat(e2e): assert Planning checklist + schema round-trip; add CANVAS_SHOT dev path"
```

---

### Task 8: Documentation + memory

**Files:**
- Modify: `CLAUDE.md` (Status — note the Stage 1 harness landed)
- Modify: `docs/handoffs/phase-2-followup.md` (mark Track 1 Stage 1 done; #1 closed)

- [ ] **Step 1: Update CLAUDE.md Status**

Add a bullet under the Phase 2 status noting: `CANVAS_SMOKE=e2e` in-process harness landed — seeds one of each board, asserts terminal framebuffer / Browser per-view `capturePage` / Planning round-trip, exits non-zero on failure; closes the #1 live-verify gap for the in-process layer (Stage 2 Playwright = separate plan). Mention the committed `CANVAS_SHOT` HTML capture path.

- [ ] **Step 2: Update the follow-up handoff**

In `docs/handoffs/phase-2-followup.md`, mark Track 1 Step 1 done and note the resolved open questions (dead-URL → `load-failed` confirmed; built `out/main` is the harness target; xterm framebuffer used over `addon-serialize`).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/handoffs/phase-2-followup.md
git commit -m "docs(e2e): record Stage 1 in-process harness + resolved open questions"
```

---

## Self-Review

**1. Spec coverage (vs `docs/research/self-smoke-testing.md` Staged plan step 1):**
- "env-gated test-only registry in MAIN exposing preview WebContentsViews" → Task 6 (`debugViewIds`/`debugCaptureView` over the existing `views` Map). ✓
- "Don't weaken sandbox/contextIsolation" → flag is a query param + read-only accessors; no `webPreferences` change. ✓
- "boot → add one of each board → assert terminal echo / per-board capturePage / Planning elements" → Tasks 4 (seed), 5 (terminal), 6 (browser capture), 7 (planning). ✓
- "emit markers / exit code" → Task 1 summarizer + Task 4 wiring. ✓
- "re-add CANVAS_SHOT as a committed dev-only path" → Task 7 Step 3. ✓
- Gotcha "capturePage blank when detached" → Task 6 returns `attached` + fits the camera + waits `connected` before capture. ✓
- Open question "dev server vs built" → decided built `out/main`; every run does `pnpm build` first. ✓
- Open question "connected-on-dead-URL" → Task 6 Step 4 confirms dead URL → `load-failed`. ✓
- NOT in scope (deferred to Stage 2 / its own plan): Playwright `_electron`, real DOM clicks/drag/resize/pan, perfect-freehand pointer-vs-mouse verification, `@xterm/addon-serialize`. Called out in the closing note. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows full code. ✓

**3. Type consistency:**
- `CanvasE2E` methods (`seedBoard`/`getBoards`/`getRuntime`/`readTerminal`/`addChecklist`/`fitView`/`roundTripOk`) defined in Task 3 and called with matching shapes in Tasks 4-7. ✓
- `E2EPart {name, ok, detail?}` / `E2ESummary {ok, exitCode, line}` defined in Task 1, consumed unchanged in Task 4. ✓
- `debugCaptureView(id) → {attached, empty}` defined in Task 6 Step 1, consumed in Step 2. ✓
- Store/lib signatures verified against source: `addBoard(type, {x,y}) → id`, `updateBoard(id, patch)`, `makeChecklist(id, itemId, at)`, `fromObject`/`toObject`, `usePreviewStore.getState().byId[id]` (`PreviewRuntime.status`/`.live`), `term.buffer.active.getLine(i).translateToString(true)`. ✓

---

## Stage 2 (Playwright `_electron`) — separate plan, NOT this one

Stage 1 closes the in-process gap. Stage 2 adds **real rendered-UI interaction** and is its own plan because it introduces dependencies and a different driving model:

- devDeps `@playwright/test` + `playwright`; an `e2e/` suite; `electron.launch({ args: ['out/main/index.js'] })` against the built app.
- Drive the dock/boards via `firstWindow()` `Page` — **needs `data-testid` added** to dock buttons (`AppChrome.DockBtn`), the URL input, and tool buttons (accessible names are currently fragile). Board nodes are already selectable via React Flow's `[data-id="<boardId>"]`.
- Native Browser layer: Playwright `connectOverCDP` collapses every `partition: preview-<id>` into ONE context (microsoft/playwright#34815, closed not-planned) — assert from MAIN via `electronApp.evaluate()` reaching the same `debugCaptureView` accessor this plan adds.
- **Verify empirically:** perfect-freehand listens for *pointer* events; Playwright `mouse.*` fires *mouse* — pen/arrow drag may silently no-op. Test pen last; fall back to a direct stroke-injection hook if synthetic pointer fails.
- Derive drag/click coordinates from `locator(...).boundingBox()` + the live camera transform — never hardcode.

When ready, brainstorm + write that as `docs/superpowers/plans/<date>-self-smoke-harness-stage2-playwright.md`.
```
