# Command Board — Phase C plan: Dispatch + group spawn

**Status:** Plan for sign-off (design-artifact gate below). **Date:** 2026-06-16.
**Branch:** `feat/cmd-phase-c-dispatch` (off umbrella `feat/command-board` @ `efa2a8b5`, Phase B).
**Slice doc** — deleted on merge per the doc-lifecycle policy; the build-history line is the residue.
The durable design lives in this dir's `README.md` (§4 Phase C row, §5 open decisions).

Phase C is the first phase that **wires the renderer `commandStore` to the MAIN-resident orchestrator**
and turns a queued card into real work: `submit → spawn a named group → dispatch the prompt → advance
the kanban on the live status stream → settle`.

---

## 1. Decisions locked (this session, 2026-06-16)

Resolving the §5 forks that gate Phase C scope — all on the recommended option:

| Fork | Decision | Consequence |
|---|---|---|
| **Decompose mechanism (v1)** | **Scripted dispatch.** One submit = one subtask. The board (over a NEW frame-guarded renderer→MAIN IPC) calls `spawnGroup` then `dispatchPrompt`; the kanban advances on the status stream. **No LLM decomposition.** | True agent-driven decompose (a spawned orchestrator agent reasoning over `app://model`) is deferred until **PR-5c** (`spawn_group` MCP tool) + **PR-3b** (`canvas://app-model` resource) are wire-reachable. The scripted state machine stays the safety envelope. |
| **§5 #2 Group composition** | **Terminal-only by default**; `+planning` / `+browser` opt-in per task via submit-well toggles. | One cap slot/task → up to 4 concurrent tasks. No PR-6 planning-seed dependency. Browser member (when toggled) auto-wires via the shipped port-detect→preview. |
| **§5 #3 Worker reuse** | **Fresh group per task.** Work serializes at `MCP_SPAWN_CAP=4`. The named group persists on canvas after `done` for inspection (user-closeable). | No state bleed; no "which worker is free" tracking. Matches the Feature-Workspaces "one zone per task" model. |

**Carried (not re-decided here):**
- **§5 #5 Batch-auth → Phase F.** Phase C uses **per-line `runGatedWrite` confirm** via the existing
  `ConfirmModal` (each dispatched prompt = one confirm dialog). With terminal-only composition that is
  one confirm per task — acceptable; the plan-approval modal is Phase F.
- **§5 #4 Completion authority** — PR-0's shipped **two-gate settle** (inactivity floor authoritative +
  `write_result` enrichment, `QUIET_MS≈1.5s`). Robust for plain shells; no change needed.

---

## 2. Base / rebase note (not a Phase C task)

This worktree's `CLAUDE.md` still describes the **`WebContentsView`** preview engine — the stack was cut
from `main @ 1ab21ed` (post-#154), **before** the OSR migration (#172/#174, OS-3 Phase 5C) landed on
`main`. **Phase C touches no preview code** (commandStore · CommandBoard · dispatch IPC · routing
overlay), so this drift is irrelevant to the phase. The whole `feat/command-board` stack rebasing onto
current `main` (OSR reconciliation) + the full cross-OS e2e matrix + the gitDiff Windows-teardown flake
fix is a **separate eventual task at stack→main merge time**, tracked in `ACTIVE-WORK.md`.

---

## 3. What exists vs. what Phase C builds (grounded map)

Confirmed by a read-only sweep of the umbrella tip:

**Already live (MAIN orchestrator — `mcpOrchestrator.ts` / `mcpLifecycle.ts`):**
- `spawnGroup({name, planning?, browser?}) → {groupId, terminalId, planningId?, browserId?}` — mints all
  ids in MAIN, reserves all member slots against the cap (reserve-all-or-none), one `sendCommand` to the
  renderer. **Cap-checked, NOT human-gated** (content-less). (`mcpLifecycle.ts:135-196`)
- `dispatchPrompt(boardId, text)` (fire-and-forget) + `handoffPrompt(boardId, text)` (dispatch + await
  idle) + `interrupt(boardId)` — **all route through the shared `runGatedWrite` gate**
  (sanitize → single-use nonce → human confirm → PTY write → audit). (`mcpOrchestrator.ts:205-324,
  571-834`)
- `runGatedWrite`'s human-confirm is **already a renderer modal**: `ConfirmModal.tsx` over
  `window.api.mcp.onConfirm` (`mcp:confirm` channel). Phase C reuses it verbatim. (`ConfirmModal.tsx`,
  `preload/index.ts:557`)
- `subscribeStatus(listener) → unsubscribe` + the PR-0 two-gate settle (status stream + `onResultSettled`)
  + `boardResult(boardId)`. (`mcpOrchestrator.ts:374-391`, `mcpLifecycle.ts:146-182`)
- `describeApp()` app-model (boards/connectors/groups live). (`appModel.ts`)

**Already live (renderer):**
- `commandStore` — `TaskStatus = 'queued'|'routing'|'executing'|'reporting'|'done'|'failed'`,
  `CommandTask = {id, title, status}`, `addTask/setTaskStatus/retryTask/clearTasks`,
  `tasksInColumn` (failed→Done bucketing). (`commandStore.ts`)
- The kanban + cards + worker-pool strip (Phase B). `submit` currently **only** `addTask`→`queued`, no
  dispatch (`CommandBoard.tsx:294-336`).
- Persisted connectors drawn as RF custom edge types `OrchestrationEdge`/`PreviewEdge`, hydrated each
  frame by pure functions from `canvasStore.connectors`. (`Canvas.tsx:93-94`, `edges/`)

**The gaps Phase C fills:**
1. **❌ No renderer→MAIN orchestrator IPC.** The orchestrator is reachable only from a spawned MCP agent
   (loopback wire) + the `__canvasE2EMain` e2e seam. Preload exposes only `publishBoards` · `onCommand` ·
   `readAudit` · `onConfirm`. **Phase C adds a frame-guarded `window.api.mcp.{spawnGroup, dispatchPrompt,
   interrupt}` channel** (the renderer still holds **no token** — MAIN owns the orchestrator; every write
   still pays the confirm gate).
2. **❌ Status → kanban wiring.** Push the orchestrator's `subscribeStatus`/settle signal to the renderer
   so cards advance through the columns.
3. **❌ Ephemeral routing-edge overlay** — command board → its in-flight group members; transient (NOT
   persisted connectors).

---

## 4. Architecture

### 4.1 The new renderer→MAIN orchestrator IPC (the load-bearing addition)

```
 CommandBoard / commandStore                MAIN (mcpOrchestrator)
   │  window.api.mcp.spawnGroup(input)  ──►  ipcMain.handle('mcp:spawnGroup')
   │      ◄── {groupId, terminalId,...}        └─ frameGuard → orchestrator.spawnGroup(input)
   │  window.api.mcp.dispatchPrompt(id, text) ► ipcMain.handle('mcp:dispatchPrompt')
   │      ◄── (confirm modal pops; resolves         └─ frameGuard → orchestrator.dispatchPrompt
   │           after approve+write, or rejects)         (= runGatedWrite: sanitize→nonce→CONFIRM→write→audit)
   │  window.api.mcp.interrupt(id)      ──►  ipcMain.handle('mcp:interrupt')
   │                                            └─ frameGuard → orchestrator.interrupt (gated, Ctrl-C)
   │  window.api.mcp.onTaskStatus(cb)   ◄──  webContents.send('mcp:status', change)  (from subscribeStatus)
```

**Security (never weakened):**
- The renderer holds **no orchestrator token**. The single orchestrator-tier identity stays in MAIN bound
  to the synthetic `boardId:'app'`. The new channel only lets the renderer *request* orchestrator actions;
  MAIN executes them and **every cross-board write still pays `runGatedWrite` + the confirm modal**.
- Each new `ipcMain.handle` is **frame-guarded** (same `senderFrame`/origin check as the existing MCP IPC)
  — this is the established pattern, not a new exception.
- `spawnGroup` is content-less → cap-checked only (no confirm). `dispatchPrompt`/`interrupt` carry content
  → the gate fires. No new write path; no sandbox/isolation change.
- **Handlers live in a dedicated `src/main/mcpOrchestratorIpc.ts`** (registered from `index.ts`), NOT
  inlined into `index.ts` (keeps it under the 700-code-line cap and one-file-one-purpose).

### 4.2 The scripted dispatch state machine

```
 submit(title, {planning?, browser?})
   └─► addTask(title)                         status = queued
        └─► spawnGroup({name: title, planning, browser})   (cap-checked; may reject if cap full)
             └─ store task.group = {groupId, terminalId, planningId?, browserId?}
             └─ setTaskStatus(id, routing)    ← routing-edge overlay appears
                  └─► dispatchPrompt(terminalId, title)   (per-line runGatedWrite confirm modal)
                       ├─ approved + written → setTaskStatus(id, executing)
                       └─ denied / cap-full / spawn-fail → setTaskStatus(id, failed)  (retry re-spawns)
        ◄── mcp:status (subscribeStatus): terminal running→idle / boardResult settled
             └─ setTaskStatus(id, reporting) → done   (routing-edge overlay fades)
```

- **Settle source (sub-decision, resolved):** drive `executing→reporting→done` from the **MAIN
  `subscribeStatus`/`onResultSettled`** push (`mcp:status`), NOT the renderer's local `terminalRuntimeStore`
  running map — PR-0's two-gate settle is authoritative and MAIN-side, and a plain idle flip can't tell
  "agent finished" from "agent waiting for input". `boardResult` (PR-4-synthesized) carries the
  status/summary used by Phase D's recap/diff.
- **`retryTask` (failed → re-dispatch):** re-queues, then re-runs the spawn→dispatch choreography with a
  fresh group (the old failed group is left on canvas / closeable). Extends the existing `retryTask`.
- **`interrupt`:** an executing card's ↻/■ control calls `window.api.mcp.interrupt(terminalId)` (gated
  Ctrl-C). On confirm it does NOT auto-fail — the status stream decides the resulting state.

### 4.3 Task → group mapping (runtime-only, NO schema change)

`CommandTask` gains an optional runtime field — **never serialized** (the command board persists as a
board, but its task queue is ephemeral per the README's "Persistence v1: runtime-only"):

```ts
interface CommandTask {
  id: string
  title: string
  status: TaskStatus
  group?: { groupId: string; terminalId: string; planningId?: string; browserId?: string }
}
```

---

## 5. Design artifact (for sign-off — UI-before-code gate)

Calm Linear/Raycast; one accent `#4f8cff`; tokens from `src/renderer/src/index.css`. Three deltas over
the Phase B board. (Lightest medium = ASCII wireframes for layout/flow + state, per the doctrine; the
kanban/board chrome already shipped with HTML mocks in Phase A/B.)

### 5.1 Submit well — composition toggles (terminal-only default)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ⌘  Describe a task to dispatch…                              [ Dispatch ] │   ← input + button (Phase B)
│                                                                            │
│   spawn:  [▣ Terminal]   [+ Planning]   [+ Browser]                        │   ← NEW: composition chips
│           └ always on ─┘  └─── opt-in toggles (off by default) ───┘        │     Terminal locked-on (faint,
└──────────────────────────────────────────────────────────────────────────┘     non-toggle); +chips accent
                                                                                   when active, border when not
```
- `Terminal` chip is always-on and visually locked (can't toggle off) — every group has a terminal.
- `+ Planning` / `+ Browser` are off by default; active = accent fill, inactive = `--border-strong`
  outline. The chosen composition is read at submit time and passed to `spawnGroup`.

### 5.2 Task card — lifecycle states (kanban)

```
 QUEUED            ROUTING           EXECUTING               REPORTING        DONE / FAILED
┌──────────┐      ┌──────────┐      ┌──────────────┐        ┌──────────┐     ┌──────────────┐
│• Build    │ ──► │◌ Build    │ ──► │◍ Build        │  ──►   │◐ Build    │ ─► │● Build  ↗zone │  done
│  auth flow│     │  auth flow│     │  auth flow    │        │  auth flow│    │  +218 −37  ⟶  │  (Phase D
└──────────┘      │ spawning… │     │ awaiting       │        │ collecting│    └──────────────┘   diff/recap)
 • text-faint     └──────────┘      │ completion…  ■│        └──────────┘     ┌──────────────┐
 dot              ◌ accent dot      └──────────────┘         ◐ warn dot      │✕ Build    ↻   │  failed
                  (spawning group)  ◍ ok dot + ■ interrupt    (settling)      │  auth flow    │  ↻ = retry
                                    "awaiting completion…"                    └──────────────┘  (re-spawn)
```
- Dot colors reuse Phase B's `STATUS_DOT` (queued=faint, routing=accent, executing=ok, reporting=warn,
  done=ok, failed=err). **New:** the `■` interrupt control on executing cards; the `↗zone` jump + diffstat
  arrive in **Phase D** (shown greyed here for continuity, not built in C).
- The honest **"awaiting completion…"** executing sub-state (Phase B) stays; it means "dispatched, waiting
  for the settle signal."

### 5.3 Ephemeral routing-edge overlay (on canvas)

```
        ┌─────────────────────┐
        │  ▦ COMMAND          │
        │  ───────────────    │              ┌──────────────┐
        │  ◍ Build auth flow ─┼╌╌╌╌╌╌╌╌╌╌╌►  │ ▣ auth flow   │  (terminal member, executing)
        │  ◌ Add dark mode  ──┼╌╌╌╌╌╌╌╌╮      │   • running   │
        └─────────────────────┘        ╰╌╌►  │ ▤ auth flow   │  (planning member, if toggled)
                                              └──────────────┘
   ╌╌╌►  dashed accent (#4f8cff) edge, command board → each in-flight member.
         appears on `routing`, stays through `executing`, FADES out on `done`/`failed`.
         NOT persisted (never in canvas.json connectors) — a transient overlay only.
```
- **Implementation:** a new RF custom edge type `routing` (sibling to `orchestration`/`preview`), fed by a
  **pure `routingEdges(tasks, boards)`** function from the commandStore task→group map + live board
  positions. RF gives us the floating path + camera-transform sync for free (same machinery as
  `OrchestrationEdge.floatingPath`) — **no separate SVG layer to camera-sync**. The edges are derived, not
  stored, so they vanish automatically when a task settles or its card is cleared.

> **Sign-off needed on §5.** If you'd rather review pixels than ASCII for the composition chips / routing
> edges, I can shoot a throwaway token-built HTML mock (Playwright `_electron`) before C2/C3 — say the word.

---

## 6. Slices (each ends runnable + committed; sequential PRs into `feat/command-board`)

| Slice | Deliverable | Files (primary) | Tests |
|---|---|---|---|
| **C1 — Orchestrator IPC** | Frame-guarded `window.api.mcp.{spawnGroup, dispatchPrompt, interrupt}` + `onTaskStatus` push; MAIN handlers in a new `mcpOrchestratorIpc.ts`; preload + `index.d.ts` types. No UI change (drive via the e2e seam). | `src/main/mcpOrchestratorIpc.ts` (new), `src/main/index.ts` (register), `src/preload/index.ts` + `index.d.ts` | integration test for each handler (frame-guard + orchestrator call + gate path); reuse `mcpCommand.integration.test.ts` shape |
| **C2 — Dispatch choreography** | Wire `submit` → spawn→dispatch→advance; composition toggles; task→group map; `interrupt`/`retry`; status→kanban via `onTaskStatus`. | `src/renderer/src/store/commandStore.ts`, `CommandBoard.tsx` (+ extract `SubmitWell`/`TaskCard` to own files if near cap), new `lib/commandDispatch.ts` (pure state-machine helpers) | unit: dispatch reducer / transitions / retry / cap-full→failed; e2e `@core`: submit→queued→routing (seam-driven spawn) |
| **C3 — Routing-edge overlay** | RF `routing` edge type + pure `routingEdges(tasks, boards)`; appears on routing/executing, fades on settle. | `src/renderer/src/canvas/edges/RoutingEdge.tsx` (new), `lib/routingEdges.ts` (new), `Canvas.tsx` (register type) | unit: `routingEdges` derivation (only in-flight tasks, only existing boards); e2e `@core`: edge present while routing, gone after settle |

**File-size doctrine:** `CommandBoard.tsx` is 661 code-lines today (under the 700 global cap, no pin).
C2 grows it → **extract `SubmitWell`, `TaskCard`, `PoolStrip` into sibling files and pure dispatch logic
into `lib/commandDispatch.ts`** so the board file stays a thin composition root well under the cap. Pin it
downward only if it lands a pinned-tier file. `preload/index.ts` (591) and the new `mcpOrchestratorIpc.ts`
stay under 700.

---

## 7. Schema impact

**None.** Phase C is runtime-only — the task→group map lives in the ephemeral `commandStore`; routing
edges are derived, never persisted. No `SCHEMA_VERSION`/`MIN_READER_VERSION` move (the v12 board-type bump
was Phase A's one breaking change).

---

## 8. Testing & verification

- **Unit (vitest):** the dispatch state machine (`lib/commandDispatch.ts`), `routingEdges` derivation,
  `retryTask` re-spawn, cap-full→`failed`.
- **Integration:** the three new IPC handlers (frame-guard rejection + happy-path orchestrator call +
  confirm-gate round-trip), mirroring `mcpCommand.integration.test.ts`.
- **e2e (`@core`, Playwright `_electron`):** extend `commandBoard.e2e.ts` — submit enqueues→routing,
  spawn drives a group (via `__canvasE2EMain` seam to keep it deterministic), routing edge appears then
  clears on settle. Tag `@core` (renderer-scoped Windows leg); the C1 `src/main`+`src/preload` diff is
  `LINUX_SENSITIVE` → its push runs the **full Docker matrix** (and the full matrix is mandatory at the
  pre-merge gate regardless).
- **Manual dev check (mandatory):** `$env:CANVAS_DEV_TITLE='PR#NNN cmd-phase-c'; pnpm dev` — submit a real
  task, watch a group spawn + the prompt dispatch (confirm modal), the card march the columns, the routing
  edge appear/fade. Confirm the window title before sign-off.

---

## 9. Out of scope / deferred (NOT Phase C)

- **Agent-driven decompose** — needs PR-5c (`spawn_group` MCP tool) + PR-3b (`canvas://app-model`
  resource). Phase C's IPC is the substrate it will reuse.
- **PR-6 planning-seed** (seed the Planning member's checklist) + the live Mermaid plan diagram — optional,
  rides with `+Planning` later.
- **Phase D** — collect/merge, flip-to-recap face, real diffstats + "view diff" (`gitDiff`), the `↗zone`
  jump + `+218 −37` on done cards.
- **Phase E** — group roll-up tab + grouped-focus camera jump + rail polish.
- **Phase F** — batch-auth plan-approval modal (replaces per-line confirm) + optional durable queue.
