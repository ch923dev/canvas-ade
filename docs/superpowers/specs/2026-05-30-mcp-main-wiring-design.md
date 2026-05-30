# Design — Canvas ADE ⇄ MCP MAIN-wiring (trimmed)

**Date:** 2026-05-30
**Status:** Approved (brainstorming)
**Branch:** `feat/mcp-main-wiring` (worktree off `origin/main`)

## Purpose

Host the `canvas-ade-mcp` MCP server inside Canvas ADE's Electron MAIN process and prove an
external MCP client can connect to the **real running app** over loopback with tier enforcement
intact. This is foundation/plumbing — no end-user feature, no agent consumes it yet (the
`.mcp.json` that points a board's CLI at the server is deferred to the worktree slice). It buys:

1. **Lifecycle plumbing** — server starts on boot, closes on quit, degrades gracefully on bind failure.
2. **A real `Orchestrator` adapter foundation** (PTY-backed) for Phase 2 observation resources.
3. **The two-layer live test flipped** from "spin a fake server in the test" → "boot the real
   Canvas ADE and connect to the server it hosts" — the form the roadmap's test rule has awaited.

## Key facts that shaped this design

- `canvas-ade-mcp` is a **library, not a daemon**: it exports `createMcpHttpServer(deps)` which, when
  called, starts a loopback HTTP listener **inside the calling process**. The clients are *separate*
  processes (an agentic CLI in a board's shell) talking to MAIN over loopback HTTP — hence an HTTP
  server hosted in-process.
- Canvas ADE MAIN is **CJS**; `canvas-ade-mcp` is **ESM-only**. MAIN loads it via
  `await import('canvas-ade-mcp')` inside an async startup fn; the package is externalized
  (electron-vite `externalizeDepsPlugin`) so its deps (sdk/express/zod) resolve from hoisted
  `node_modules` at runtime, unbundled.
- Board metadata (type/status/list) lives in renderer Zustand; MAIN owns only the **PTY session map**.
  The adapter is therefore **PTY-session-backed** — zero renderer/preload/IPC changes.
- Canvas ADE's **git-worktrees-per-board slice is not built yet**, so `.mcp.json` has nowhere to
  live → deferred.

## Scope (trimmed)

**In:**
- Add `canvas-ade-mcp` as a `file:../canvas-ade-mcp` dependency.
- A **pure** orchestrator adapter (`buildPtyOrchestrator`) over an injected `BoardRegistry`
  interface — no electron/pty/sdk value imports, so its contract test runs without node-pty.
- `startMcpServer(registry)` — dynamic-imports the package, creates a `TokenStore`, mints one **app
  orchestrator** token, calls `createMcpHttpServer`, returns a handle (`port`, `close`, `tokens`,
  `mintWorkerToken(boardId)`). Graceful-degrade (try/catch → `null`) exactly like `startLocalServer`.
- A read accessor on `pty.ts`: `listPtySessions()` returning `{ id, status }[]` (track last
  `PtyState` per session).
- MAIN wiring in `index.ts`: start in `app.whenReady`, close in `shutdown()`.
- **Contract test** (`mcpOrchestrator.test.ts`, vitest): the pure adapter over a fake registry.
- **Live test** (`mcpSmoke.ts`, `CANVAS_SMOKE=mcp`): boot the real app, connect two MCP clients,
  assert tier enforcement.

**Out (explicit):** `.mcp.json` writing, worktrees, renderer/preload changes, auto-mint/revoke of
per-board tokens on spawn/kill, MCP spawn/dispatch/git tools (Phases 2–6).

## Components

### `src/main/mcpOrchestrator.ts` (new, pure)
```ts
import type { Orchestrator, BoardSummary } from 'canvas-ade-mcp' // type-only, erased at build
import type { BoardId } from 'canvas-ade-mcp'

/** Minimal MAIN-owned board state the adapter reads (a thin view over the PTY session map). */
export interface BoardRegistry {
  listSessions(): Array<{ id: string; status: string }>
}

/**
 * Build an Orchestrator backed by the PTY session registry. Pure: no electron, pty, or sdk value
 * imports, so the contract test runs without node-pty. Methods with no MAIN source yet throw an
 * explicit phase-gated error (no registered tool/resource reaches them in this milestone).
 */
export function buildPtyOrchestrator(registry: BoardRegistry): Orchestrator
```
Mapping:
- `listBoards()` → `registry.listSessions().map(s => ({ id: s.id, type: 'terminal', status: s.status }))`
- `boardStatus(id)` → the session's status, or throws `board not found` if absent
- `spawnBoard` → throws `spawnBoard not available until Phase 3`
- `dispatchPrompt` → throws `dispatchPrompt not available until Phase 4`
- `gitDiff` → throws `gitDiff not available until Phase 6`

### `src/main/mcp.ts` (new, wiring)
```ts
export interface RunningMcp {
  port: number
  tokens: import('canvas-ade-mcp').TokenStore
  orchestratorToken: string
  mintWorkerToken(boardId: string): string
  close(): Promise<void>
}
export async function startMcpServer(registry: BoardRegistry): Promise<RunningMcp | null>
```
- `const { createMcpHttpServer, TokenStore, mintBoardToken } = await import('canvas-ade-mcp')`
- `const tokens = new TokenStore()`
- `const { token: orchestratorToken } = mintBoardToken(tokens, { boardId: 'app', tier: 'orchestrator' })`
- `const server = await createMcpHttpServer({ orchestrator: buildPtyOrchestrator(registry), tokens })`
- `mintWorkerToken(boardId) => mintBoardToken(tokens, { boardId, tier: 'worker' }).token`
- try/catch around the whole thing → log + `return null` on failure (graceful, like `localServer`).

### `src/main/pty.ts` (modify, additive)
- Add `state: PtyState` to the `Session` interface; set it on `running` / `exited`.
- Export `listPtySessions(): Array<{ id: string; status: PtyState }>` — snapshot of live sessions.

### `src/main/index.ts` (modify)
- In `app.whenReady`, after `registerPtyHandlers`, call
  `mcp = await startMcpServer({ listSessions: listPtySessions })` and keep the handle.
- In `shutdown()`, `await mcp?.close()` (idempotent; null-safe).

### `electron.vite.config.ts` — verify `externalizeDepsPlugin` covers the new dep (it externalizes
everything in `dependencies` by default; no change expected, confirmed during the plan).

## Testing (two-layer)

### Contract — `src/main/mcpOrchestrator.test.ts` (vitest, pure)
- `listBoards` maps a fake registry's sessions to `{id,type:'terminal',status}`.
- `boardStatus` returns a known session's status; throws for an unknown id.
- `spawnBoard` / `dispatchPrompt` / `gitDiff` reject with their phase-gated messages.
No node-pty import (the adapter file imports only `type`s from the package).

### Live — `src/main/mcpSmoke.ts` driven by `CANVAS_SMOKE=mcp`
Mirrors `e2eSmoke.ts`. After the app boots and `startMcpServer` has mounted:
1. `mintWorkerToken('smoke-worker')` and read the app orchestrator token from the handle.
2. `await import('@modelcontextprotocol/sdk/client/index.js')` + `streamableHttp.js`; connect two
   `Client`s to `http://127.0.0.1:<mcp.port>/mcp` with the two bearer tokens.
3. Assert: orchestrator `tools/list` includes `orchestrator_ping` and `callTool` returns
   `orchestrator-pong`; worker `tools/list` omits it and `callTool` returns `isError`.
4. Print `MCP_LIST_OK`, `MCP_TIER_OK`, then `MCP_DONE`; set `process.exitCode` non-zero on any
   failed assertion; route through `shutdown()` then `app.exit(code)` (same pattern as the e2e path).

Run: `pnpm build; $env:CANVAS_SMOKE='mcp'; pnpm start`.

## Error handling

- MCP server bind failure → caught in `startMcpServer`, logged, returns `null`; app boots without it
  (the server is a convenience layer, never a hard boot dependency — mirrors `startLocalServer`).
- `shutdown()` null-safe and idempotent; closing the MCP server drains its sessions then the HTTP
  listener (the package's `close()` already does both).
- Adapter methods that throw are unreachable via any Phase-1 tool/resource; the throw is the honest
  contract for "not wired yet," asserted by the contract test.

## PR

Worktree off `origin/main`, branch `feat/mcp-main-wiring`, PR targets `main`. Never touches the
checked-out `phase-3-board-actions`. Commits per slice; push + open PR after both test layers pass.
