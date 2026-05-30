# MCP Phase-2 Slice 1 — all-board-types `listBoards` Implementation Plan

> Implement in the worktree `Z:\canvas-ade-boards` (branch `feat/mcp-board-listing`, stacked off
> `feat/mcp-main-wiring`). Pairs with `docs/superpowers/specs/2026-05-30-mcp-board-listing-design.md`.
> The package side is DONE: `@ch923dev/canvas-ade-mcp@0.2.0` (adds `BoardSummary.title`) is published.
> Deps are pre-installed at `0.2.0`. Do NOT run `pnpm install`, electron, `pnpm build`/`start`, or push
> — the orchestrator handles install/build/smoke/PR.

**Goal:** MCP `listBoards()` returns every board (terminal/browser/planning + future) with a coarse
status, via a renderer→MAIN push-mirror.

**Invariants:**
- Snapshot is `{id,type,title}` only — no page/whiteboard content crosses the boundary.
- `mcpOrchestrator.ts` imports only `type`s from `@ch923dev/canvas-ade-mcp` (contract test stays node-pty-free).
- New IPC channel `mcp:boards` is sender-guarded (`isForeignSender` pattern from `pty.ts`).
- Graceful: no snapshot yet → empty list. Don't touch the e2e/selfTest smoke branches except as specified.

---

## Task 1: boardRegistry (MAIN) + contract test

**Files:** create `src/main/boardRegistry.ts`, `src/main/boardRegistry.test.ts`

- [ ] **Step 1 — failing test** `src/main/boardRegistry.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { __setMirrorForTest, listBoardMirror, sanitizeSnapshot } from './boardRegistry'

describe('boardRegistry', () => {
  it('sanitizeSnapshot keeps well-formed entries and drops malformed ones', () => {
    const out = sanitizeSnapshot([
      { id: 'a', type: 'terminal', title: 'T' },
      { id: 'b', type: 'browser', title: 'B' },
      { id: 1, type: 'planning', title: 'P' }, // bad id
      { id: 'c', type: 'planning' }, // missing title
      'nope'
    ])
    expect(out).toEqual([
      { id: 'a', type: 'terminal', title: 'T' },
      { id: 'b', type: 'browser', title: 'B' }
    ])
  })

  it('listBoardMirror returns the last stored snapshot (empty by default)', () => {
    __setMirrorForTest([{ id: 'x', type: 'terminal', title: 'X' }])
    expect(listBoardMirror()).toEqual([{ id: 'x', type: 'terminal', title: 'X' }])
    __setMirrorForTest([])
    expect(listBoardMirror()).toEqual([])
  })
})
```

- [ ] **Step 2 — run** `corepack pnpm test run src/main/boardRegistry.test.ts` → FAIL (missing module).

- [ ] **Step 3 — implement** `src/main/boardRegistry.ts`:
```ts
import type { IpcMain, BrowserWindow, IpcMainEvent } from 'electron'

/** Minimal board projection the renderer pushes to MAIN (control plane; no content). */
export interface BoardMirror {
  id: string
  type: string
  title: string
}

let mirror: BoardMirror[] = []

/** Keep only well-formed {id,type,title} string entries; drop anything else. */
export function sanitizeSnapshot(input: unknown): BoardMirror[] {
  if (!Array.isArray(input)) return []
  const out: BoardMirror[] = []
  for (const b of input) {
    if (
      b &&
      typeof b === 'object' &&
      typeof (b as BoardMirror).id === 'string' &&
      typeof (b as BoardMirror).type === 'string' &&
      typeof (b as BoardMirror).title === 'string'
    ) {
      const { id, type, title } = b as BoardMirror
      out.push({ id, type, title })
    }
  }
  return out
}

/** Last snapshot the renderer pushed (empty until the renderer mounts + publishes). */
export function listBoardMirror(): BoardMirror[] {
  return mirror
}

/** Test seam — set the mirror directly (unit tests only). */
export function __setMirrorForTest(next: BoardMirror[]): void {
  mirror = next
}

/**
 * Register the renderer→MAIN board-snapshot channel. Sender-guarded so only the
 * main window's main frame can publish (mirrors pty.ts's isForeignSender). The
 * snapshot is control-plane metadata only — never board content.
 */
export function registerBoardRegistryHandler(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null
): void {
  ipcMain.on('mcp:boards', (e: IpcMainEvent, boards: unknown) => {
    const main = getWin()?.webContents.mainFrame
    if (main && e.senderFrame && e.senderFrame !== main) return // foreign frame
    mirror = sanitizeSnapshot(boards)
  })
}
```

- [ ] **Step 4 — run** the test → PASS. Commit `feat(mcp): board snapshot registry (renderer→MAIN mirror)`.

---

## Task 2: generalize the orchestrator adapter + test

**Files:** modify `src/main/mcpOrchestrator.ts`, `src/main/mcpOrchestrator.test.ts`

- [ ] **Step 1 — rewrite** `src/main/mcpOrchestrator.ts` (read the current file first):
```ts
import type { BoardId, BoardSummary, Orchestrator } from '@ch923dev/canvas-ade-mcp'

/** MAIN-owned board sources the adapter reads: the renderer mirror + the PTY map. */
export interface BoardRegistry {
  listBoards(): Array<{ id: string; type: string; title: string }>
  listSessions(): Array<{ id: string; status: string }>
}

function deriveStatus(
  board: { id: string; type: string },
  sessionById: Map<string, string>
): string {
  if (board.type === 'terminal') return sessionById.get(board.id) ?? 'no-session'
  if (board.type === 'browser') return 'open'
  if (board.type === 'planning') return 'static'
  return 'unknown'
}

/**
 * Build an Orchestrator backed by the board mirror, with PTY status overlaid on
 * terminal boards. Pure (type-only package imports → contract test loads no
 * node-pty). spawnBoard/dispatchPrompt/gitDiff stay phase-gated.
 */
export function buildOrchestrator(registry: BoardRegistry): Orchestrator {
  const sessionMap = (): Map<string, string> =>
    new Map(registry.listSessions().map((s) => [s.id, s.status]))
  return {
    async listBoards(): Promise<BoardSummary[]> {
      const sessions = sessionMap()
      return registry
        .listBoards()
        .map((b) => ({ id: b.id, type: b.type, title: b.title, status: deriveStatus(b, sessions) }))
    },
    async boardStatus(boardId: BoardId): Promise<string> {
      const board = registry.listBoards().find((b) => b.id === boardId)
      if (!board) throw new Error(`board not found: ${boardId}`)
      return deriveStatus(board, sessionMap())
    },
    async spawnBoard(): Promise<{ id: BoardId }> {
      throw new Error('spawnBoard not available until Phase 3')
    },
    async dispatchPrompt(): Promise<void> {
      throw new Error('dispatchPrompt not available until Phase 4')
    },
    async gitDiff(): Promise<string> {
      throw new Error('gitDiff not available until Phase 6')
    }
  }
}
```

- [ ] **Step 2 — rewrite** `src/main/mcpOrchestrator.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildOrchestrator, type BoardRegistry } from './mcpOrchestrator'

function reg(
  boards: Array<{ id: string; type: string; title: string }>,
  sessions: Array<{ id: string; status: string }> = []
): BoardRegistry {
  return { listBoards: () => boards, listSessions: () => sessions }
}

describe('buildOrchestrator', () => {
  it('lists all board types with title + derived status', async () => {
    const orch = buildOrchestrator(
      reg(
        [
          { id: 't1', type: 'terminal', title: 'Term' },
          { id: 'b1', type: 'browser', title: 'Web' },
          { id: 'p1', type: 'planning', title: 'Plan' }
        ],
        [{ id: 't1', status: 'running' }]
      )
    )
    expect(await orch.listBoards()).toEqual([
      { id: 't1', type: 'terminal', title: 'Term', status: 'running' },
      { id: 'b1', type: 'browser', title: 'Web', status: 'open' },
      { id: 'p1', type: 'planning', title: 'Plan', status: 'static' }
    ])
  })

  it('a terminal board with no live PTY reads no-session', async () => {
    const orch = buildOrchestrator(reg([{ id: 't1', type: 'terminal', title: 'T' }]))
    expect(await orch.boardStatus('t1')).toBe('no-session')
  })

  it('boardStatus throws for an unknown board', async () => {
    const orch = buildOrchestrator(reg([]))
    await expect(orch.boardStatus('nope')).rejects.toThrow(/not found/)
  })

  it('spawnBoard / dispatchPrompt / gitDiff are phase-gated', async () => {
    const orch = buildOrchestrator(reg([]))
    await expect(orch.spawnBoard({ type: 'terminal' })).rejects.toThrow(/Phase 3/)
    await expect(orch.dispatchPrompt('b', 'x')).rejects.toThrow(/Phase 4/)
    await expect(orch.gitDiff('b')).rejects.toThrow(/Phase 6/)
  })
})
```

- [ ] **Step 3 — run** `corepack pnpm test run src/main/mcpOrchestrator.test.ts src/main/boardRegistry.test.ts` → PASS. Commit `feat(mcp): board-mirror Orchestrator adapter (all types + coarse status)`.

---

## Task 3: wire the registry into startMcpServer

**Files:** modify `src/main/mcp.ts`

- [ ] **Step 1** — replace the `buildPtyOrchestrator(registry)` usage. Current `mcp.ts` imports
  `buildPtyOrchestrator` + takes a `BoardRegistry` of `{listSessions}`. Update to:
  - import `{ buildOrchestrator, type BoardRegistry } from './mcpOrchestrator'`
  - `startMcpServer` signature stays `(registry: BoardRegistry)`; pass it straight to
    `buildOrchestrator(registry)` in the `createMcpHttpServer({ orchestrator: buildOrchestrator(registry), tokens })` call.
- [ ] **Step 2** — `corepack pnpm typecheck:node` → clean. Commit `feat(mcp): inject board-mirror registry`.

---

## Task 4: MAIN lifecycle + smoke renderer hook

**Files:** modify `src/main/index.ts`

- [ ] **Step 1** — import `listBoardMirror, registerBoardRegistryHandler` from `./boardRegistry`; import `listPtySessions` is already present.
- [ ] **Step 2** — in `app.whenReady`, after `registerPtyHandlers(...)`:
```ts
  registerBoardRegistryHandler(ipcMain, () => mainWindow)
  mcp = await startMcpServer({ listBoards: listBoardMirror, listSessions: listPtySessions })
```
  (replace the existing `mcp = await startMcpServer({ listSessions: listPtySessions })` line.)
- [ ] **Step 3** — the live smoke needs the renderer's seeding hook + the publish hook. Extend the
  e2e-query gate so `SMOKE === 'mcp'` ALSO loads the renderer with `?e2e=1`:
  - find `const e2e = SMOKE === 'e2e'` and the two `loadURL`/`loadFile` calls that branch on `e2e`.
  - introduce `const seedHarness = SMOKE === 'e2e' || SMOKE === 'mcp'` and use `seedHarness` for the
    `?e2e=1` query in BOTH load paths (keep the `e2e` constant for the e2e-only smoke branch logic).
- [ ] **Step 4** — pass the window to the mcp smoke: change the `SMOKE === 'mcp'` branch to
  `const code = await runMcpSmoke(mcp, mainWindow!)`.
- [ ] **Step 5** — `corepack pnpm typecheck:node` → clean. Commit `feat(mcp): register board registry + seed harness for mcp smoke`.

---

## Task 5: preload bridge

**Files:** modify `src/preload/index.ts`, `src/preload/index.d.ts`

- [ ] **Step 1** — add to the `api` object in `src/preload/index.ts`:
```ts
  // ── MCP board mirror (control plane; metadata only — id/type/title, never content) ──
  mcp: {
    publishBoards: (boards: Array<{ id: string; type: string; title: string }>): void =>
      ipcRenderer.send('mcp:boards', boards)
  },
```
- [ ] **Step 2** — ensure `index.d.ts` types resolve `window.api.mcp.publishBoards`. The repo derives
  `CanvasApi = typeof api`; confirm `index.d.ts` re-exports/types `window.api` as `CanvasApi` (extend
  if it enumerates members explicitly). Run `corepack pnpm typecheck:preload && corepack pnpm typecheck:web`.
- [ ] **Step 3** — commit `feat(mcp): preload publishBoards bridge`.

---

## Task 6: renderer publisher hook

**Files:** create `src/renderer/src/store/useMcpPublish.ts`; modify `src/renderer/src/App.tsx`

- [ ] **Step 1** — create `src/renderer/src/store/useMcpPublish.ts`:
```ts
import { useEffect } from 'react'
import { useCanvasStore } from './canvasStore'

/**
 * Publish a minimal board snapshot (id/type/title) to MAIN's MCP board registry
 * whenever the canvas changes. Debounced; control-plane metadata only (no board
 * content). A no-op if the bridge is absent (e.g. a non-Electron test runtime).
 */
export function useMcpPublish(): void {
  const boards = useCanvasStore((s) => s.boards)
  useEffect(() => {
    const publish = window.api?.mcp?.publishBoards
    if (!publish) return
    const t = setTimeout(() => {
      publish(boards.map((b) => ({ id: b.id, type: b.type, title: b.title })))
    }, 150)
    return () => clearTimeout(t)
  }, [boards])
}
```
- [ ] **Step 2** — call `useMcpPublish()` once near the top of `App` in `src/renderer/src/App.tsx`
  (alongside other top-level hooks). Import it.
- [ ] **Step 3** — `corepack pnpm typecheck:web` → clean. Commit `feat(mcp): renderer publishes board snapshot`.

---

## Task 7: live smoke — assert all types

**Files:** modify `src/main/mcpSmoke.ts`

- [ ] **Step 1** — change `runMcpSmoke(mcp)` → `runMcpSmoke(mcp, win: BrowserWindow)` (import the type).
- [ ] **Step 2** — after the existing tier checks pass, seed one of each board type through the
  renderer hook and assert the orchestrator client's `listBoards` (via the MCP `canvas://boards`
  resource OR a direct list) reflects all three. Add a helper that reads the resource:
```ts
// after orch/worker connected + tier checks:
const evalIn = <T,>(expr: string): Promise<T> =>
  win.webContents.executeJavaScript(expr, true) as Promise<T>
const hookReady = await poll(() => evalIn<boolean>('!!window.__canvasE2E'), 8000)
if (!hookReady) { log('MCP_FAIL no-seed-hook'); code = 1 }
else {
  await evalIn("window.__canvasE2E.seedBoard('terminal')")
  await evalIn("window.__canvasE2E.seedBoard('browser')")
  await evalIn("window.__canvasE2E.seedBoard('planning')")
  // Poll the MCP boards resource until the mirror has propagated all three types.
  const types = await pollTypes(orchClient, 8000) // read canvas://boards, parse JSON, collect b.type
  const ok = ['terminal', 'browser', 'planning'].every((t) => types.includes(t))
  if (ok) log('MCP_BOARDS_OK') else { log(`MCP_FAIL boards types=${types.join(',')}`); code = 1 }
}
```
  - Implement `poll` (copy the small poller from e2eSmoke.ts) and `pollTypes` (call
    `client.readResource({ uri: 'canvas://boards' })`, `JSON.parse` the text content, map `b.type`,
    retry until all three present or timeout).
  - The orchestrator `Client` must be kept (don't close it before this). Read the current mcpSmoke
    structure and adapt — keep the two `SmokeClient`s; expose their underlying `Client` (or add a
    `readBoards()` method to the smoke client) so the resource can be read.
- [ ] **Step 3** — `corepack pnpm typecheck:node` → clean. Commit `test(mcp): live smoke asserts all board types listed`.

---

## Task 8 (orchestrator-run): verify + PR — NOT for the implementing agent

Full gates (`typecheck`/`lint`/`format:check`/`test`), `build`, `CANVAS_SMOKE=mcp` smoke
(`MCP_LIST_OK · MCP_TIER_OK · MCP_BOARDS_OK · MCP_DONE`, exit 0), push, stacked PR vs `feat/mcp-main-wiring`.

## Self-review (vs spec)
- All 3 types listed (Task 2) · mirror bridge (Tasks 1,4,5,6) · coarse status (Task 2) · package title
  (done) · two-layer test (contract Tasks 1-2 + live Task 7). Minimal snapshot, sender-guard,
  graceful-empty all honored. Type names consistent: `BoardMirror`, `buildOrchestrator`,
  `BoardRegistry`, `listBoardMirror`, `registerBoardRegistryHandler`, `useMcpPublish`.
