# Design spec — Phase 3 Slice C′: Port detect → push to preview

> Status: approved (brainstorm 2026-05-30). The final Phase 3 slice. Replaces the originally-scoped
> Slice C (git worktrees + per-board ports). **Worktrees are deferred** — see "Decision record" and
> the new **Feature Workspaces** entry in `docs/roadmap.md` / `docs/feature-proposals.md`.

## One-liner

A Terminal board reads which localhost port its dev server printed, and one click opens (or points)
a Browser board at that URL. **Detect, don't assign.** Agent-agnostic, read-only, no git.

## Decision record (why this, not the old Slice C)

The roadmap's original Slice C bundled **git worktrees + per-board ports**. During brainstorming we
re-scoped:

1. **Worktrees deferred to a post-MCP phase.** They are genuinely useful but (a) the best model is
   still being shaped, (b) the strongest version is *Feature Workspaces* — a cluster of boards
   (terminal + browser + planning) for one feature, all backed by one worktree/branch — which wants
   the planned `canvas-ade-mcp` swarm layer to orchestrate it, and (c) deferring de-risks the Phase 3
   close. Building a feature you can't yet explain cleanly is the trap we avoid. Captured as
   **Feature Workspaces** (roadmap + proposals); built when the MCP setup lands.

2. **Static port assignment dropped; runtime detection kept.** The old plan *assigned* a port and
   *injected* it (env `PORT` / `--port`) so the dev server would use it — brittle and framework-
   specific, fighting the agent-agnostic `launchCommand` principle, and only valuable once multiple
   servers run at once (the parallel-agent / worktree case). The reverse — let the server pick its
   own port and **detect** it — is framework-agnostic, works with any dev server, and is valuable
   from board one (auto-targets non-default ports like Next's 3000 or Django's 8000). So this slice
   ships detection + "push to preview" and nothing of the static-assignment design.

## Scope

### In
- Detect candidate localhost URLs from a Terminal board's PTY output (server-printed `Local:` URLs).
- A **Preview** action in the Terminal board chrome that detects and pushes to a Browser board.
- Resolve a push target: reuse an existing Browser board when sensible, else spawn one near the
  terminal pre-filled with the detected URL.
- Graceful handling of zero / multiple detected ports.

### Out (deferred — do NOT build here)
- Git worktrees, git-init toggle, the Feature Workspaces zone model (post-MCP phase).
- Static port assignment + env injection (`board.port` is *not* injected anywhere).
- A live "server is up on :PORT" watcher/badge (detection is on-click only in v1).
- OS-level listening-port scan (`netstat`/`lsof`) of the agent's process tree (v1 is output-parse
  only; the OS scan is a clearly-scoped future enhancement for servers that don't print a URL).
- Persistent Terminal↔Browser pairing / connector edges (future — SB-4 connectors).

## Locked design decisions (resolved in brainstorm; do not re-decide)

| Topic | Decision |
|---|---|
| Trigger | **On-click**, not a background watcher. A `Preview` button detects when pressed. |
| Detection method | **Output-parse only** — regex the server-printed URL out of the PTY ring buffer. |
| Push target | **Reuse-else-spawn** — selected Browser board → use it; else exactly one Browser exists → use it; else spawn a fresh Browser near the terminal. No persistent pairing state in v1. |
| Multiple ports | Show a small picker; user chooses. |
| Persistence | No schema bump. Browser `url` (already persisted) carries the pairing across reopen; `board.port` (already in schema) optionally records last-seen for display. |
| Security | Read-only. Output → URL only. No Browser→PTY path. Detect IPC is frame-guarded like `projectIpc`. |

## Architecture

Four small, isolated units. The only one with real logic is the pure parser — everything else is
thin wiring over existing seams.

### 1. `src/main/portDetect.ts` (pure, unit-tested)

```
export interface DetectedUrl { url: string; host: string; port: number }
export function parsePortsFromOutput(raw: string): DetectedUrl[]
```

Responsibilities:
- Strip ANSI escape codes from `raw` (dev servers colorize the `Local:` line).
- Match `https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d+)?` (default port 80/443 when
  absent — but in practice always present for dev servers).
- Normalize `0.0.0.0` / `[::]` host → `localhost` for the preview URL (you can't browse `0.0.0.0`).
- Dedupe by `host:port`.
- **Order: most-recent-first** (a server restarted on a new port should surface the latest), and
  prefer `localhost`/`127.0.0.1` over wildcard binds when ports tie.
- Pure and total: never throws; bad input → `[]`.

Depends on: nothing (no Node/Electron imports → trivially testable in Vitest).

### 2. PTY detect IPC (in `src/main/pty.ts` handler registration)

A new control-plane handler `terminal:detectPorts`:
- `(e, boardId: string) => DetectedUrl[]`
- Frame-guarded (reject foreign senders — mirror `isForeignSender` in `projectIpc.ts`).
- Reads the board's buffered output: the live session's ring buffer (`sessions.get(id)?.buf.data`)
  or, if parked, the parked buffer. Empty/absent → `[]`.
- Delegates to `parsePortsFromOutput`.

Depends on: `portDetect.ts`, the existing `sessions`/parked maps + 256 KB ring buffer in `pty.ts`.

### 3. preload bridge (`src/preload/index.ts`)

```
detectPorts: (boardId: string): Promise<DetectedUrl[]> => ipcRenderer.invoke('terminal:detectPorts', boardId)
```
Invoke-only, on the existing `window.api` surface (typed in `index.d.ts`).

### 4. Renderer

- **`BoardActions` (boardActions.ts)** — extend the context with
  `pushPreview(fromBoardId: string, url: string): void`, implemented in `Canvas.tsx` so target
  resolution + free-space placement live with the other board-level actions (Slice B pattern):
  - Resolve target: currently-selected Browser board → it; else if exactly one Browser board exists
    → it; else `addBoard('browser', <free space near fromBoard>)`.
  - `updateBoard(targetId, { url })` and `selectBoard(targetId)`. (Reuse case keeps the board's
    current viewport preset; spawn case uses the Browser default preset.)
- **`TerminalBoard.tsx`** — a `Preview` `IconBtn` beside stop/configure/restart:
  - On click → `await window.api.detectPorts(board.id)`.
  - `0` results → inline toast/affordance: *"No dev server detected yet — start it, then try again."*
  - `1` → `pushPreview(board.id, urls[0].url)`.
  - `>1` → a small popover picker (host:port list) → `pushPreview` with the chosen URL.

## Data flow

```
[Preview click] → window.api.detectPorts(boardId)
   → IPC terminal:detectPorts (frame-guard) → read ring buffer → parsePortsFromOutput → DetectedUrl[]
[renderer] switch on count:
   0 → toast
   1 → pushPreview(fromId, url)
   >1 → picker → pushPreview(fromId, chosenUrl)
[Canvas.pushPreview] resolve target Browser (reuse|spawn) → updateBoard(target,{url}) → selectBoard
[autosave] Browser.url persisted (Slice A) → pairing survives reopen
```

## Error handling / graceful degradation

- **Idle / never-run terminal** → empty buffer → `[]` → the zero-results toast. No error.
- **Parser** is total (never throws); guards malformed/odd input to `[]`.
- **IPC** returns `[]` for a foreign sender (defense-in-depth, BUG-033 pattern) — never throws to the
  renderer.
- **No Browser board + spawn fails** (shouldn't, but) → no-op + the same toast; never crash.
- Detection on a server that prints no URL → `[]` (documented limitation; the OS port-scan
  enhancement covers it later).

## Security

- Strictly read-only: the feature reads already-captured PTY output and writes only a Browser board
  URL. There is **no path from Browser content back to the PTY write channel** (the locked
  invariant). The flow is Terminal-output → Browser-URL, one direction.
- `terminal:detectPorts` is frame-guarded; runs in MAIN; renderer never touches the buffer directly.
- `contextIsolation`/`sandbox`/`nodeIntegration` untouched.

## Schema

No bump. Fields already present:
- `BrowserBoard.url` persists the pushed URL → the pairing is durable for free.
- `TerminalBoard.port?: number` may optionally be set to the last-detected port for display (not
  injected, not required). If we choose not to write it, no change at all.

## Testing

- **Unit `parsePortsFromOutput`** (the core): fixtures for vite (`➜  Local: http://localhost:5173/`),
  Next (`- Local: http://localhost:3000`), CRA (`Local: http://localhost:3000`), Django
  (`Starting development server at http://127.0.0.1:8000/`), Flask
  (`Running on http://127.0.0.1:5000`). Assert: ANSI stripped; multiple matches → most-recent-first;
  `0.0.0.0` normalized to `localhost`; dedupe by host:port; no-match → `[]`.
- **Unit target-resolution** (pure helper extracted from `pushPreview`): selected-browser case;
  single-browser case; none → spawn-near; multiple browsers + none selected → spawn-near (documented
  default).
- **IPC guard**: foreign sender → `[]`.
- **(Optional) E2E**: extend `selfTest.ts`/e2e to seed a terminal whose output contains a Local URL
  and assert `detectPorts` returns it.
- Full gate must stay green: `pnpm typecheck && lint && format:check && test && build`.

## Acceptance criteria (done when)

- A Terminal board running a dev server (any framework that prints its Local URL) shows a working
  **Preview** action; clicking it opens/points a Browser board at the detected `http://localhost:<port>`.
- Non-default ports (3000/8000/etc.) are detected correctly, not hard-coded to 5173.
- Zero detection → clear "not detected yet" affordance; multiple → a picker.
- Reuse-else-spawn target resolution behaves per the locked decision; the pushed URL survives reopen.
- Read-only/security invariants hold; full verification gate green; the parser + resolver unit-tested.

## Deferred carry-forward (record, do not build)

- **Feature Workspaces** (worktree-backed board zones) — the deferred big idea; post-MCP phase.
- OS listening-port scan of the agent process tree (robust detection for non-printing servers).
- Live "server up" badge / watcher.
- Persistent Terminal↔Browser pairing + connector edges (SB-4).
