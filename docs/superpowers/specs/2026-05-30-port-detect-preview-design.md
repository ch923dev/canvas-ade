# Design spec — Phase 3 Slice C′: Port detect → push to preview (+ link arrow)

> Status: approved-in-revision (brainstorm 2026-05-30). The final Phase 3 slice. Replaces the
> originally-scoped Slice C (git worktrees + per-board ports). **Worktrees are deferred** — see
> "Decision record" and the **Feature Workspaces** entry in `docs/roadmap.md` /
> `docs/feature-proposals.md`. Revision 2: the push also draws a persistent **connector arrow** from
> the Terminal to its Browser preview (a scoped slice of SB-4 connectors).

## One-liner

A Terminal board reads which localhost port its dev server printed, and one click opens (or points)
a Browser board at that URL **and draws a connector arrow Terminal → preview**. The arrow is the
durable pairing: re-pushing follows it to the same preview. **Detect, don't assign.** Agent-agnostic,
read-only, no git.

## Decision record (why this, not the old Slice C)

The roadmap's original Slice C bundled **git worktrees + per-board ports**. During brainstorming we
re-scoped:

1. **Worktrees deferred to a post-MCP phase.** They are genuinely useful but (a) the best model is
   still being shaped, (b) the strongest version is *Feature Workspaces* — a cluster of boards
   (terminal + browser + planning) for one feature, all backed by one worktree/branch — which wants
   the planned `canvas-ade-mcp` swarm layer to orchestrate it, and (c) deferring de-risks the Phase 3
   close. Captured as **Feature Workspaces** (roadmap + proposals FW-1); built when the MCP lands.

2. **Static port assignment dropped; runtime detection kept.** Assigning + injecting a port
   (env `PORT`/`--port`) is brittle and framework-specific, fighting the agent-agnostic
   `launchCommand` principle, and only valuable once multiple servers run (the worktree case). The
   reverse — let the server pick its port and **detect** it — is framework-agnostic and valuable from
   board one (auto-targets non-default ports like Next's 3000, Django's 8000).

3. **Add a preview connector arrow (rev 2).** The push creates a visible, persistent Terminal→Browser
   link so the canvas shows which agent owns which preview. This is a constrained instance of the
   future general connectors (SB-4): auto-created only, single-purpose, no draw-by-drag UX here.

## Scope

### In
- Detect candidate localhost URLs from a Terminal board's PTY output (server-printed `Local:` URLs).
- A **Preview** action in the Terminal board chrome that detects and pushes to a Browser board.
- A persistent **preview link**: `BrowserBoard.previewSourceId` records the owning terminal; a React
  Flow connector arrow Terminal → Browser is rendered from it and auto-reroutes on move.
- Push target resolution: follow an existing link if present; else reuse a sensible Browser; else
  spawn one near the terminal pre-filled with the detected URL — then record the link.
- Graceful handling of zero / multiple detected ports, and link cleanup on delete/duplicate.

### Out (deferred — do NOT build here)
- Git worktrees, git-init toggle, the Feature Workspaces zone model (post-MCP phase).
- Static port assignment + env injection (`board.port` is *not* injected anywhere).
- A live "server is up on :PORT" watcher/badge (detection is on-click only in v1).
- OS-level listening-port scan (`netstat`/`lsof`) of the agent's process tree (v1 is output-parse
  only; the OS scan is a clearly-scoped future enhancement for servers that don't print a URL).
- **General connectors (SB-4):** user-drawn edges between arbitrary boards, typed/labelled edges,
  connection handles UX, a root `edges` array. This slice ships ONLY the auto-created preview arrow,
  stored as a field — not the general connector system.

## Locked design decisions (resolved in brainstorm; do not re-decide)

| Topic | Decision |
|---|---|
| Trigger | **On-click**, not a background watcher. A `Preview` button detects when pressed. |
| Detection method | **Output-parse only** — regex the server-printed URL out of the PTY ring buffer. |
| Push target | **Follow-link-else-reuse-else-spawn.** If the terminal already owns a Browser (a board with `previewSourceId === terminalId`) → re-point it. Else: currently-selected Browser → use it; else exactly one Browser exists → use it; else spawn a fresh Browser near the terminal. Then set the link. |
| Preview link | A visible **connector arrow** Terminal→Browser, derived from `BrowserBoard.previewSourceId`. Rendered as a React Flow **floating edge** (no handles UX). One preview per terminal (last push wins); one owner per Browser. |
| Multiple ports | Show a small picker; user chooses. |
| Persistence | **No schema-version bump.** Add optional `BrowserBoard.previewSourceId?: string` (same forward-compat pattern as `cwd?`/`port?`). The arrow is derived; nothing else persisted. |
| Security | Read-only. Output → URL only. No Browser→PTY path. Detect IPC is frame-guarded like `projectIpc`. |

## Architecture

Five small, isolated units. The only one with real logic is the pure parser.

### 1. `src/main/portDetect.ts` (pure, unit-tested)

```
export interface DetectedUrl { url: string; host: string; port: number }
export function parsePortsFromOutput(raw: string): DetectedUrl[]
```
- Strip ANSI escapes; match `https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d+`.
- Normalize `0.0.0.0`/`[::]` → `localhost` for the browsable URL.
- Dedupe by `host:port`; order **most-recent-first**; prefer loopback over wildcard on ties.
- Pure and total: never throws; bad input → `[]`. No Node/Electron imports.

### 2. PTY detect IPC (in `src/main/pty.ts` handler registration)

`terminal:detectPorts(boardId) => DetectedUrl[]`, frame-guarded (mirror `isForeignSender`). Reads the
board's buffered output (live `sessions.get(id)?.buf.data` or parked buffer; empty → `[]`) and
delegates to `parsePortsFromOutput`.

### 3. preload bridge (`src/preload/index.ts` + `index.d.ts`)

`detectPorts: (boardId) => ipcRenderer.invoke('terminal:detectPorts', boardId)` — invoke-only on
`window.api`.

### 4. Renderer — push + link

- **Schema (`boardSchema.ts`):** add `previewSourceId?: string` to `BrowserBoard`; allow it in
  `assertBoard` (browser case: string-or-undefined). Round-trips via the existing structuredClone in
  `toObject`/`fromObject`. On load, **prune dangling**: if `previewSourceId` names a board that isn't
  present, clear it (don't fail the load).
- **Store (`canvasStore.ts`):** `pushPreview` logic (or a helper) resolves the target per the
  decision table and sets `target.previewSourceId`. `removeBoard` clears `previewSourceId` on any
  Browser whose source is the removed board (terminal removed) — Browser removal needs nothing
  (derived edge vanishes). `duplicateBoard` already deep-clones; **clear `previewSourceId` on a
  Browser clone** so a copy doesn't inherit the link.
- **`BoardActions` (boardActions.ts):** extend with `pushPreview(fromBoardId, url)`, implemented in
  `Canvas.tsx` (target resolution + free-space placement live with the other board actions).
- **`TerminalBoard.tsx`:** a `Preview` `IconBtn` → `await window.api.detectPorts(board.id)` → 0=toast
  / 1=`pushPreview` / >1=picker popover → `pushPreview`.

### 5. Renderer — the arrow (React Flow floating edge)

- Derive edges from boards: for each Browser with a present `previewSourceId`, emit one RF edge
  `{ id: 'preview-<browserId>', source: previewSourceId, target: browserId, type: 'preview' }`.
- Register an `edgeTypes.preview` custom **floating** edge: computes endpoints from the two nodes'
  measured rects (RF `getInternalNode`/`useInternalNode`), so **no `Handle` components are required**
  on boards (avoids interfering with xterm focus / native-view pointer zones — the SB-4 risk).
  Accent-token stroke + arrowhead at the Browser end; calm, matches the Planning arrow weight.
- Auto-reroute on node move is free (RF re-renders edges on position change).
- **Risk/spike (plan task 1):** confirm RF v12 renders a programmatic edge with the floating recipe
  and no handles. Fallback if it fights us: add a single hidden, `isConnectable={false}` source/target
  Handle per board (CSS-hidden, `pointer-events:none`) purely as an attach point.

## Data flow

```
[Preview click] → window.api.detectPorts(boardId)
   → IPC terminal:detectPorts (frame-guard) → ring buffer → parsePortsFromOutput → DetectedUrl[]
[renderer] count: 0 → toast · 1 → pushPreview(fromId,url) · >1 → picker → pushPreview(fromId,chosen)
[Canvas.pushPreview]
   target = browser where previewSourceId===fromId           // follow existing link
          ?? selectedBrowser ?? soleBrowser                   // reuse
          ?? addBoard('browser', freeSpaceNear(fromId))       // spawn
   updateBoard(target, { url, previewSourceId: fromId }); selectBoard(target)
[render] edges = browsers.filter(previewSourceId present-and-valid).map(→ preview edge)
[autosave] Browser.url + previewSourceId persisted (Slice A) → link survives reopen
```

## Error handling / graceful degradation

- Idle/never-run terminal → empty buffer → `[]` → zero-results toast. No error.
- Parser total (never throws); IPC returns `[]` for foreign senders.
- Dangling `previewSourceId` (source board gone) → edge simply not rendered; cleared on next load.
- Spawn failure → no-op + toast; never crash.
- Server prints no URL → `[]` (documented limit; OS-scan enhancement covers it later).

## Security

- Strictly read-only: reads captured PTY output, writes only a Browser URL + a link field. **No path
  from Browser content back to the PTY write channel** (locked invariant). One direction:
  Terminal-output → Browser-URL/link.
- `terminal:detectPorts` frame-guarded; runs in MAIN; renderer never touches the buffer directly.
- `contextIsolation`/`sandbox`/`nodeIntegration` untouched.

## Schema

No version bump. `BrowserBoard.previewSourceId?: string` added as an optional field (forward-compat
like `cwd?`/`port?`); `assertBoard` browser branch validates string-or-undefined; `fromObject` prunes
a dangling link on load. `BrowserBoard.url` (already persisted) carries the URL; `TerminalBoard.port?`
may optionally record last-seen for display (not required, not injected).

## Testing

- **Unit `parsePortsFromOutput`:** fixtures for vite (`➜  Local: http://localhost:5173/`), Next
  (`- Local: http://localhost:3000`), CRA (`Local: http://localhost:3000`), Django
  (`http://127.0.0.1:8000/`), Flask (`Running on http://127.0.0.1:5000`). Assert ANSI stripped;
  most-recent-first; `0.0.0.0`→`localhost`; dedupe; no-match → `[]`.
- **Unit target+link resolution** (pure helper): follow-existing-link; selected-browser; single-
  browser; none→spawn; sets `previewSourceId`. Re-push follows the link. `removeBoard(terminal)`
  clears dependent links; `duplicateBoard(browser)` drops the link.
- **Unit/round-trip schema:** `previewSourceId` survives `toObject`/`fromObject`; `assertBoard`
  accepts string/undefined; dangling pruned on load.
- **Edge derivation:** boards with a valid `previewSourceId` produce exactly one preview edge; none
  for dangling/absent.
- **IPC guard:** foreign sender → `[]`.
- **(Optional) E2E:** seed a terminal whose output contains a Local URL; assert `detectPorts` returns
  it and pushing yields a linked Browser.
- Full gate green: `pnpm typecheck && lint && format:check && test && build`.

## Acceptance criteria (done when)

- A Terminal running any dev server that prints its Local URL shows a working **Preview** action;
  clicking it opens/points a Browser board at `http://localhost:<port>` and **draws a connector arrow
  Terminal → Browser**.
- Non-default ports (3000/8000/…) detected correctly (not hard-coded 5173).
- Zero detection → clear "not detected yet" affordance; multiple → picker.
- Re-pushing follows the link to the same preview; the arrow reroutes live when either board moves and
  survives reopen.
- Deleting either board cleans up the link/arrow; duplicating a Browser starts unlinked.
- Read-only/security invariants hold; full gate green; parser + resolver + schema round-trip unit-tested.

## Deferred carry-forward (record, do not build)

- **Feature Workspaces** (worktree-backed board zones) — post-MCP phase.
- **General connectors (SB-4):** user-drawn typed/labelled edges, a root `edges` array, handle UX.
- OS listening-port scan for non-printing servers; live "server up" badge/watcher.
