# Command Board — design + phased plan

**Status:** Design proposal (not yet implemented). Design-artifact gate satisfied — see Mocks below.
**Date:** 2026-06-15 · **Author:** design session (workflow `command-board-research` + 5 verified dimensions).
**Form decided (user, 2026-06-15):** an **on-canvas "dock board"** that spawns + names a Named Group of
worker boards per task and wires to them — realized as the **Combined board (⑤)** below.
**Base:** this worktree (`feat/command-board`) is cut from `main` @ `1ab21ed` (post-#154), so the
bug-hunt fixes — including prerequisites PR-0 and PR-1 — are already in the tree.

> This is the *grand* plan. It is intentionally front-loaded with a **Prerequisites** section: the
> Command board cannot function until those land. Build the prerequisites first, in small steps, then
> the board phases.

---

## 1. Concept

A **Command board** is a first-class board on the canvas that acts as the orchestrator's face. A user
submits a task; the board drives the **already-shipped** MCP orchestrator (`src/main/mcpOrchestrator.ts`
+ `@expanse-ade/mcp`) to **decompose** it, **spawn a Named Group** of worker boards for it
(Terminal + Planning + Browser), **dispatch** subtasks to them, and **collect + merge** their results.

It adds **no new orchestrator write path** — it sequences existing tools (`spawnBoard`,
`configureBoard`, `dispatchPrompt`, `handoffPrompt`, `relayPrompt`, `interrupt`, `writeResult`,
`subscribeStatus`). Every cross-board write still pays the existing `runGatedWrite` gate
(sanitize → single-use nonce → human confirm → audit).

Each task → **its own named group** (a "feature zone"), exactly like Named Board Groups (v6). This is
the deferred **Feature Workspaces** vision, realized through a Command board.

### The board's face (Combined ⑤)
One cohesive board with four views over the **same** state (`commandStore` tasks · `boardResult`
records · `subscribeStatus` pushes):
- **Kanban body (①)** — lifecycle columns (queued · routing · executing · reporting · done); cards
  flow right as the state machine advances.
- **Group roll-up tab (③)** — the index of every Named Group it owns + a live progress roll-up; click
  a row → camera-fit that zone (reuses Named-Group grouped focus, S4).
- **Flip-to-recap face (②)** — reuses the shipped terminal-recap two-zone pattern (NOW + TIMELINE) at
  the orchestrator level; TIMELINE = finished tasks' `boardResult` (status/summary/refs).
- **Rail (④)** — the always-on / collapsed roll-up: submit + aggregate progress + counts.

### Mocks (design-artifact-before-code gate)
Throwaway token-built mocks (real `src/renderer/src/index.css` tokens), in `.claude/mocks/`:
- `command-board-dock-mock.{html,png}` — the on-canvas hub spawning the "Auth feature" group.
- `command-board-variants-mock.{html,png}` — the five faces (①–⑤) with per-variant "How" notes.
- `command-board-mock.{html,png}` — the earlier chrome-panel form (superseded; kept for reference).

A **token-built HTML/JSX mock screenshotted + signed off** still gates the *implementation* spec for the
final board (the variants mock satisfies the structure/flow tier; the production spec re-shoots the
single combined board with the collapsed-state alongside).

---

## 2. Architecture & data flow (summary)

The board is a thin renderer client. It holds an **ephemeral `commandStore`** (Zustand) and drives the
MAIN-resident orchestrator over the existing frame-guarded MCP IPC. **It holds no token** — the single
orchestrator-tier token is minted in MAIN bound to the synthetic `boardId:'app'`; the board is just the
UI. No second orchestrator authority is created.

```
 submit ─► DECOMPOSE ─► ROUTE ─► EXECUTE ─► REPORT ─► merge
   │          │           │         │          │
   │   spawnGroup +    listBoards  dispatch/  writeResult
   │   configureBoard  +agentKind  handoff    +subscribeStatus
   │   (named group)   +groups                 (settle, PR-0)
   └─ commandStore row, status=queued ───────────────► done/failed
```

Full architecture (token model, the `runGatedWrite` gate, discovery, state machine, persistence) is in
the workflow synthesis captured in this session; the load-bearing decisions are folded into §4–§5 here.

**Persistence (v1): runtime-only.** The task queue lives entirely in the ephemeral `commandStore` and is
lost on quit — smallest, safest surface. **The Command board itself** is a persisted board (it is on the
canvas), which is the one breaking schema change (see Phase A). Durable queue across restarts is
deferred (sidecar JSON in `userData`/`.canvas/`, never `canvas.json`).

---

## 3. Prerequisites — must land BEFORE the Command board functions

These are ordered. **PR-0 and PR-1 already MERGED to `main` (#154, squash `1408060`)** — this worktree is
based on that tip, so they are in. The rest (PR-2…PR-4) are net-new but each is a small,
independently-shippable slice. **Ship these first.**

| # | Prerequisite | Why it blocks the Command board | Status / where | Size |
|---|---|---|---|---|
| **PR-0** | **Per-task settle (running→idle)** — BUG-002/007. A live shell's status is permanently `running`; `awaitHandoffSettled` never wakes, so handoffs ride the 5-min backstop. Fix = write_result fast-path + a quiet-window check **inside `awaitHandoffSettled`** reading `pty.ts` `lastActivityAt` directly (NOT `deriveStatus`'s dead fallback) + exit-code gate. | **Everything depends on it.** Without it: kanban cards never leave "executing", the recap timeline never gets a completed entry, "done" never fires. | **✅ MERGED to `main` (#154, squash `1408060`).** Still **verify** the shipped settle matches the two-gate shape this design assumes before relying on kanban/recap. | S (verify) |
| **PR-1** | **Schema drift close** — BUG-013/014. MAIN `SCHEMA_VERSION` stuck at 9 while renderer `boardSchema` is 10; the drift-guard test hardcodes `9`. | Phase A mints a 4th board type `command` = a **breaking ADR 0007 double-bump** (`SCHEMA_VERSION` + `MIN_READER_VERSION`). That bump must start from a clean lock-step base, not on top of an existing drift. | **✅ MERGED to `main` (#154, squash `1408060`).** | S |
| **PR-2** | **`gitDiff` — un-stub + wire simple-git in MAIN.** Today `mcpOrchestrator.ts:751` throws `"gitDiff not available until Phase 6"`; **simple-git is not wired in MAIN at all**. | The result/recap zones show diffstats (`+218 −37`) and a "view diff" action — the core *value* of collect/merge and the recap timeline. No diff backing today. *(User-identified prerequisite.)* | **Net-new — START HERE.** Wire `simple-git` MAIN-only behind frame-guarded IPC (locked rule); implement read-only `gitDiff(boardId)` over the board's `cwd`. A small, safe slice of the deferred Feature-Workspaces git layer. | M |
| **PR-3** | **Worker result reporting.** Worker agents must call worker-tier `write_result` on completion (via launch-prompt instruction / Stop hook), or rely on PR-0's inactivity floor. | The `done` state, the recap TIMELINE, and merge all need a real `BoardResult` (status/summary/refs). The orchestrator already scaffolds `onResultSettled`; the *signal* is missing. | **Net-new (mostly config).** For claude, reuse the existing recap transcript watcher (`agentRecapMap.ts`) to synthesize a result. | M |
| **PR-4** | **Group-aware orchestration.** `spawnBoard({type,prompt?,cwd?})` makes **one** board, no group; **groups are renderer-only** (no `listGroups`/`sanitizeGroups` in `boardRegistry.ts`, `mcp:boards` pushes only `{boards, connectors}`). | The board spawns a **Named Group** of {terminal, planning, browser} per task and the roll-up/dispatch must address it. | **Net-new.** (a) Mirror `groups[]` to MAIN (`sanitizeGroups` + extend `mcp:boards` payload + `listGroups()`); (b) a `spawnGroup` / spawn-into-group primitive that creates the cluster + named group + connectors in one tracked step. | L |
| **PR-5** | **Planning checklist seeding** (optional for v1). No API seeds Planning elements via MCP (`spawnBoard` only sets `launchCommand` for terminals). | The Planning member of each group should be seeded with the decomposed subtask checklist. | **Net-new.** Could be deferred — ship v1 with terminal+browser groups, add the seeded Planning member later. | M |
| **PR-6** | **Batch-authorization decision.** A decomposed task fans out N subtasks → N `runGatedWrite` confirm dialogs. | Usable but noisy. Either accept per-line confirm for v1, or build one plan-approval modal (per-line sanitize+nonce+audit preserved). | **Decision (optionally defer impl).** Net-new on the most security-sensitive path. | Decide → S/M |

**Already shipped (NOT prerequisites):** Browser auto-wiring — the Browser member connects via the
shipped **port-detect → push-to-preview** (Slice C′). The dispatch gate, board registry, status buckets,
`subscribeStatus`, Named Board Groups (v6), and the terminal-recap pattern all exist.

### Prerequisite build order (small steps)
```
PR-0 settle ─┐ DONE — merged to main (#154); verify the settle shape before relying on it
PR-1 schema ─┘ DONE — merged to main (#154)
      └─► PR-2 gitDiff (+ simple-git in MAIN)   <-- START HERE (first net-new prereq)
            └─► PR-3 worker result reporting
                  └─► PR-4 group-aware spawn + groups[] MAIN mirror
   decide: PR-6 batch-auth · defer: PR-5 planning seed
```

---

## 4. The grand plan — Command board phases (AFTER prerequisites)

Each phase ends runnable + committed, on a `feat/*` worktree, merged sequentially through the full gate
+ e2e matrix (Canvas ADE convention).

| Phase | Deliverable | Needs | Schema |
|---|---|---|---|
| **A — Board shell** | Mint board type `command` (breaking bump 10→11 / floor→11 + migration); the Combined board frame (titlebar + seg control + submit well); ephemeral `commandStore`; capability auto-discovery of the worker pool (read-only `listBoards` filter by `agentKind`/`monitorActivity`). No dispatch yet. Re-shoot the production mock (combined + collapsed) and sign off first. | PR-1 ✅ | **Breaking** |
| **B — Kanban + lifecycle** | The kanban body; cards = `commandStore` tasks bucketed by `TaskStatus`; cards move on `subscribeStatus`/settle events; honest "awaiting completion signal" sub-state. | PR-0 ✅ | No |
| **C — Dispatch + group spawn** | submit → decompose → `spawnGroup` ({terminal[, planning][, browser]}) → `dispatch`/`handoff` to members; ephemeral routing-edge overlay (NOT persisted connectors); per-line `runGatedWrite` confirm; interrupt/retry. | PR-4, PR-3 | No |
| **D — Collect / merge + recap + diff** | snapshot `boardResult` into the result zone; the flip-to-recap face (②) with the TIMELINE; real diffstats + "view diff" via `gitDiff`. | PR-2, PR-3 | No |
| **E — Roll-up + rail polish** | the Group roll-up tab (③) with grouped-focus jump; the always-on/collapsed rail (④); flip + seg transitions. | PR-4 mirror | No |
| **F — Batch-auth + durability (optional)** | plan-approval batch authorization (per PR-6 decision); optional durable queue (sidecar JSON in `userData`/`.canvas/`, never `canvas.json`). | PR-6 | No (sidecar) |

---

## 5. Open decisions (genuine forks for the user)

1. **Placement of the Command board on the canvas** — a normal free board, or pinned/anchored ("dock")?
   (Both are the same board type; pinning is a behavior.)
2. **Group composition per task** — always {terminal + planning + browser}, or terminal-only by default
   with planning/browser added on demand? (Drives whether PR-5 is in the critical path.)
3. **Worker reuse** — fresh terminal per task (clean; serializes at `MCP_SPAWN_CAP=4`) vs a persistent
   pool of named-group workers (faster; state bleeds).
4. **Completion authority (PR-0)** — inactivity timeout authoritative + `write_result` as enrichment
   (works for plain shells) vs require cooperating agents to `write_result`; and `QUIET_MS` (~1.5s).
5. **Batch authorization (PR-6)** — one plan-approval modal vs confirm-per-subtask.
6. **Durable queue** — runtime-only v1 (recommended) vs sidecar JSON.

---

## 6. Locked constraints this design honors
- **Security never weakened** — `node-pty` + `simple-git` MAIN-only; renderer holds no token; all MCP IPC
  frame-guarded; every cross-board write pays `runGatedWrite`; browser-board content never reaches the
  PTY channel.
- **Design** — calm Linear/Raycast, one accent `#4f8cff`, no glass/gradient/glow; board chrome
  conventions; design-artifact-before-code.
- **Schema** — two-tier ADR 0007; the 4th board type is the one acknowledged breaking bump (Phase A);
  everything else is additive/runtime.
- **Doc lifecycle** — this is a durable design/research doc (not a slice spec); per-phase specs/plans are
  created and deleted on their own `feat/*` branches.

---

## 7. Pointers
- Existing orchestrator map + the running→idle root cause: this session's scout reports.
- `docs/feature-proposals.md` › OS-3 (the other active build) · the deferred **Feature Workspaces** entry
  in `docs/roadmap.md` (this design realizes it).
- Mocks: `.claude/mocks/command-board-*.{html,png}`.
- Prerequisite fixes PR-0/PR-1: **MERGED to `main` via #154** (squash `1408060`; bug-hunt 2026-06-15 package).
