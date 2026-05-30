# MCP MAIN-wiring Implementation Plan (trimmed)

> **For agentic workers:** implement task-by-task in the worktree `Z:\canvas-ade-wiring` (branch
> `feat/mcp-main-wiring`, off `origin/main`). Pairs with the spec
> `docs/superpowers/specs/2026-05-30-mcp-main-wiring-design.md`. Steps use checkbox syntax.

**Goal:** Host `canvas-ade-mcp` inside Canvas ADE MAIN + prove an external MCP client connects to
the real app over loopback with tier enforcement, via a PTY-backed Orchestrator adapter.

**Architecture:** MAIN (CJS) loads the ESM-only package via `await import('canvas-ade-mcp')`; a pure
`buildPtyOrchestrator` adapter reads MAIN's PTY session map; `startMcpServer` mounts the loopback
HTTP server and degrades gracefully. Two-layer test: pure contract (vitest) + real-app live smoke
(`CANVAS_SMOKE=mcp`).

**Tech:** Electron 33 / electron-vite (CJS main), vitest 2, TypeScript 5.6. `canvas-ade-mcp` already
installed as `file:../canvas-ade-mcp` (deps hoisted, node-pty rebuilt). Run with `corepack pnpm`.

**Invariants (do not violate):**
- Adapter file imports ONLY `type`s from `canvas-ade-mcp` (so the contract test never loads node-pty).
- Package loaded via dynamic `import()` inside an async fn (CJS→ESM bridge); never a top-level `import`.
- MCP server is a convenience layer — bind failure must NOT crash boot (try/catch → null, like `startLocalServer`).
- Control plane only: the adapter never streams PTY output; `dispatchPrompt` is phase-gated (throws).
- No renderer/preload/IPC changes. No `.mcp.json`. No worktrees.

---

## Task 1: PTY session read accessor

**Files:** Modify `src/main/pty.ts`

- [ ] **Step 1:** Add `state` to the `Session` interface and track it.

In the `interface Session { ... }` block add:
```ts
  /** Last lifecycle state pushed to the renderer — read by the MCP board registry. */
  state: PtyState
```

- [ ] **Step 2:** Set `state` at the points the session posts a lifecycle.

Where a session is created in `sessions.set(opts.id, { proc, port: port1, buf })`, change to:
```ts
    sessions.set(opts.id, { proc, port: port1, buf, state: 'running' })
```
In `adopt`, the `sessions.set(id, { proc: p.proc, port: port1, buf: p.buf })` becomes:
```ts
    sessions.set(id, { proc: p.proc, port: port1, buf: p.buf, state: 'running' })
```
In the `proc.onExit` handler, after the identity-guarded live lookup, when `live && live.proc === proc`, set `live.state = 'exited'` (alongside the existing port posts).

- [ ] **Step 3:** Export the accessor (place near `debugTerminalPid`).
```ts
/**
 * Snapshot of live PTY sessions for the MCP board registry (read-only; control
 * plane only — never the PTY data stream). Parked (deleted-but-undoable) sessions
 * are excluded: they are not live boards.
 */
export function listPtySessions(): Array<{ id: string; status: PtyState }> {
  return [...sessions.entries()].map(([id, s]) => ({ id, status: s.state }))
}
```

- [ ] **Step 4:** `corepack pnpm typecheck:node` — expect clean. Commit:
```bash
git add src/main/pty.ts && git commit -m "feat(mcp): expose listPtySessions() read accessor"
```

---

## Task 2: Pure orchestrator adapter + contract test

**Files:** Create `src/main/mcpOrchestrator.ts`, `src/main/mcpOrchestrator.test.ts`

- [ ] **Step 1:** Write the failing contract test `src/main/mcpOrchestrator.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildPtyOrchestrator, type BoardRegistry } from './mcpOrchestrator'

const registry = (sessions: Array<{ id: string; status: string }>): BoardRegistry => ({
  listSessions: () => sessions
})

describe('buildPtyOrchestrator', () => {
  it('maps PTY sessions to terminal board summaries', async () => {
    const orch = buildPtyOrchestrator(registry([{ id: 'b1', status: 'running' }]))
    expect(await orch.listBoards()).toEqual([{ id: 'b1', type: 'terminal', status: 'running' }])
  })

  it('boardStatus returns a known session status', async () => {
    const orch = buildPtyOrchestrator(registry([{ id: 'b1', status: 'exited' }]))
    expect(await orch.boardStatus('b1')).toBe('exited')
  })

  it('boardStatus throws for an unknown board', async () => {
    const orch = buildPtyOrchestrator(registry([]))
    await expect(orch.boardStatus('nope')).rejects.toThrow(/not found/)
  })

  it('spawnBoard / dispatchPrompt / gitDiff are phase-gated', async () => {
    const orch = buildPtyOrchestrator(registry([]))
    await expect(orch.spawnBoard({ type: 'terminal' })).rejects.toThrow(/Phase 3/)
    await expect(orch.dispatchPrompt('b1', 'hi')).rejects.toThrow(/Phase 4/)
    await expect(orch.gitDiff('b1')).rejects.toThrow(/Phase 6/)
  })
})
```

- [ ] **Step 2:** `corepack pnpm test run src/main/mcpOrchestrator.test.ts` → FAIL (module missing).

- [ ] **Step 3:** Implement `src/main/mcpOrchestrator.ts` (type-only package imports):
```ts
import type { BoardId, BoardSummary, Orchestrator } from 'canvas-ade-mcp'

/** The thin MAIN-owned board view the adapter reads (a slice of the PTY session map). */
export interface BoardRegistry {
  listSessions(): Array<{ id: string; status: string }>
}

/**
 * Build an Orchestrator backed by the PTY session registry. Pure — imports only
 * types from the package, so the contract test runs without loading node-pty.
 * Methods with no MAIN source yet throw an explicit phase-gated error; no tool or
 * resource registered in this milestone reaches them.
 */
export function buildPtyOrchestrator(registry: BoardRegistry): Orchestrator {
  return {
    async listBoards(): Promise<BoardSummary[]> {
      return registry.listSessions().map((s) => ({ id: s.id, type: 'terminal', status: s.status }))
    },
    async boardStatus(boardId: BoardId): Promise<string> {
      const found = registry.listSessions().find((s) => s.id === boardId)
      if (!found) throw new Error(`board not found: ${boardId}`)
      return found.status
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

- [ ] **Step 4:** `corepack pnpm test run src/main/mcpOrchestrator.test.ts` → PASS (4 tests). Then `corepack pnpm typecheck:node` → clean. Commit:
```bash
git add src/main/mcpOrchestrator.ts src/main/mcpOrchestrator.test.ts
git commit -m "feat(mcp): pure PTY-backed Orchestrator adapter + contract test"
```

---

## Task 3: startMcpServer wiring module

**Files:** Create `src/main/mcp.ts`

- [ ] **Step 1:** Implement `src/main/mcp.ts`:
```ts
import type { BoardRegistry } from './mcpOrchestrator'
import { buildPtyOrchestrator } from './mcpOrchestrator'
import type { TokenStore } from 'canvas-ade-mcp'

export interface RunningMcp {
  port: number
  tokens: TokenStore
  orchestratorToken: string
  /** Mint a worker-tier token bound to a board id (consumer: a later .mcp.json slice / the smoke). */
  mintWorkerToken(boardId: string): string
  close(): Promise<void>
}

/**
 * Mount the canvas-ade-mcp loopback HTTP server inside MAIN. The package is
 * ESM-only and MAIN is CJS, so it is loaded via dynamic import() inside this async
 * fn. A bind/load failure is non-fatal (the server is a convenience layer, not a
 * boot dependency) — log and return null, mirroring startLocalServer.
 */
export async function startMcpServer(registry: BoardRegistry): Promise<RunningMcp | null> {
  try {
    const { createMcpHttpServer, TokenStore, mintBoardToken } = await import('canvas-ade-mcp')
    const tokens = new TokenStore()
    const { token: orchestratorToken } = mintBoardToken(tokens, { boardId: 'app', tier: 'orchestrator' })
    const server = await createMcpHttpServer({
      orchestrator: buildPtyOrchestrator(registry),
      tokens
    })
    return {
      port: server.port,
      tokens,
      orchestratorToken,
      mintWorkerToken: (boardId) => mintBoardToken(tokens, { boardId, tier: 'worker' }).token,
      close: () => server.close()
    }
  } catch (err) {
    console.error('Could not start the MCP server — continuing without it.', err)
    return null
  }
}
```

- [ ] **Step 2:** `corepack pnpm typecheck:node` → clean (dynamic-import types resolve from the package's `dist/index.d.ts`). Commit:
```bash
git add src/main/mcp.ts && git commit -m "feat(mcp): startMcpServer mount with graceful degrade"
```

---

## Task 4: MAIN lifecycle wiring

**Files:** Modify `src/main/index.ts`

- [ ] **Step 1:** Add imports near the other `./` imports:
```ts
import { registerPtyHandlers, disposeAllPtys, listPtySessions } from './pty'
import { startMcpServer, type RunningMcp } from './mcp'
```
(extend the existing `./pty` import; add the `./mcp` import.)

- [ ] **Step 2:** Add a module-scope handle beside `let localServer`:
```ts
let mcp: RunningMcp | null = null
```

- [ ] **Step 3:** In `app.whenReady().then(...)`, after `registerPtyHandlers(ipcMain, () => mainWindow)`:
```ts
  mcp = await startMcpServer({ listSessions: listPtySessions })
```

- [ ] **Step 4:** In `shutdown()`, close the MCP server alongside the others (await it before the local server close):
```ts
function shutdown(): Promise<void> {
  const drained = disposeAllPtys()
  disposeAllPreviews()
  const mcpClosed = mcp?.close() ?? Promise.resolve()
  mcp = null
  localServer?.close()
  localServer = null
  return Promise.all([drained, mcpClosed]).then(() => undefined)
}
```

- [ ] **Step 5:** `corepack pnpm typecheck:node` → clean. Commit:
```bash
git add src/main/index.ts && git commit -m "feat(mcp): mount MCP server on boot, close on shutdown"
```

---

## Task 5: Live smoke (`CANVAS_SMOKE=mcp`)

**Files:** Create `src/main/mcpSmoke.ts`, modify `src/main/index.ts`

- [ ] **Step 1:** Create `src/main/mcpSmoke.ts`:
```ts
import type { RunningMcp } from './mcp'

/** stdout marker (EPIPE-safe like index.ts's smokeLog). */
function log(line: string): void {
  try {
    console.log(line)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') throw err
  }
}

async function connect(url: string, token: string): Promise<{ list: string[]; call: unknown; close: () => Promise<void> }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'mcp-smoke', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  await client.connect(transport)
  const list = (await client.listTools()).tools.map((t) => t.name)
  return {
    list,
    call: await client.callTool({ name: 'orchestrator_ping' }).catch((e: unknown) => ({ threw: String(e) })),
    close: () => client.close()
  }
}

/**
 * Live test against the REAL running Canvas ADE: the MCP server is already mounted
 * in app.whenReady. Connect two clients (orchestrator + worker tokens) over
 * loopback and assert the tier split holds in the real process. Returns an exit
 * code (0 = pass). Mirrors e2eSmoke's run/exit contract.
 */
export async function runMcpSmoke(mcp: RunningMcp | null): Promise<number> {
  if (!mcp) {
    log('MCP_FAIL server-not-mounted')
    return 1
  }
  const url = `http://127.0.0.1:${mcp.port}/mcp`
  let code = 0
  try {
    const workerToken = mcp.mintWorkerToken('smoke-worker')
    const orch = await connect(url, mcp.orchestratorToken)
    const worker = await connect(url, workerToken)

    const orchHas = orch.list.includes('orchestrator_ping')
    const workerHas = worker.list.includes('orchestrator_ping')
    if (orchHas && !workerHas) log('MCP_LIST_OK')
    else {
      log(`MCP_FAIL list orch=${orchHas} worker=${workerHas}`)
      code = 1
    }

    const orchPong = JSON.stringify(orch.call).includes('orchestrator-pong')
    const workerDenied = JSON.stringify(worker.call).toLowerCase().includes('not found')
    if (orchPong && workerDenied) log('MCP_TIER_OK')
    else {
      log(`MCP_FAIL tier orchPong=${orchPong} workerDenied=${workerDenied}`)
      code = 1
    }

    await orch.close()
    await worker.close()
  } catch (err) {
    log(`MCP_FAIL ${(err as Error).message}`)
    code = 1
  }
  log('MCP_DONE')
  return code
}
```

- [ ] **Step 2:** Wire it in `src/main/index.ts`. Extend the `SMOKE` comment and the
`did-finish-load` smoke branch. Add an import:
```ts
import { runMcpSmoke } from './mcpSmoke'
```
In the `if (SMOKE && mainWindow)` `did-finish-load` handler, add an `mcp` branch BEFORE the e2e branch:
```ts
      if (SMOKE === 'mcp') {
        const code = await runMcpSmoke(mcp)
        process.exitCode = code
        await shutdown()
        app.exit(code)
      } else if (SMOKE === 'e2e') {
```
(Keep the existing `e2e` / else bodies intact; this just adds the leading `mcp` case.)

- [ ] **Step 3:** Update the `SMOKE` env comment on the `const SMOKE = ...` line to mention `"mcp"=MCP tier smoke+quit`.

- [ ] **Step 4:** `corepack pnpm typecheck:node` → clean. Commit:
```bash
git add src/main/mcpSmoke.ts src/main/index.ts
git commit -m "test(mcp): live CANVAS_SMOKE=mcp tier-enforcement smoke"
```

---

## Task 6: Full verification + PR

- [ ] **Step 1:** Gates: `corepack pnpm typecheck` (node+preload+web), `corepack pnpm lint`,
  `corepack pnpm format:check`, `corepack pnpm test run` (contract incl. mcpOrchestrator). All green.
  Fix prettier with `corepack pnpm format` if it flags new files.
- [ ] **Step 2:** Build + live smoke: `corepack pnpm build`, then `$env:CANVAS_SMOKE='mcp'; corepack pnpm start`.
  Expect stdout `MCP_LIST_OK`, `MCP_TIER_OK`, `MCP_DONE` and exit code 0.
- [ ] **Step 3:** Push + PR:
```bash
git push -u origin feat/mcp-main-wiring
gh pr create --base main --title "feat: wire canvas-ade-mcp into MAIN (Phase 1 hosting)" --body "<summary>"
```

## Self-review (against spec)
- Lifecycle plumbing → Tasks 3,4. Adapter foundation → Task 2. Live test flipped to real app → Task 5. ✓
- ESM/CJS via dynamic import → Task 3. Graceful degrade → Task 3,4. Pure adapter (no node-pty in contract) → Task 2. ✓
- No renderer/preload/.mcp.json/worktree changes. ✓
- Type names consistent: `BoardRegistry`, `buildPtyOrchestrator`, `RunningMcp`, `startMcpServer`, `listPtySessions`, `runMcpSmoke`. ✓
