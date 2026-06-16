# Command Board — design + phased plan

**Status:** Design proposal (not yet implemented). Design-artifact gate satisfied — see Mocks below.
**Date:** 2026-06-15 · **Author:** design session (workflow `command-board-research` + 5 verified dimensions).
**Form decided (user, 2026-06-15):** an **on-canvas "dock board"** that spawns + names a Named Group of
worker boards per task and wires to them — realized as the **Combined board (⑤)** below.
**Agency decided (user, 2026-06-15):** **hybrid** — a scripted state machine (safety envelope) **plus** a
read-only **app self-model** (PR-3, agency) **plus** an optional live Mermaid plan diagram (PR-6,
transparency). The agent reasons freely over the app; every write still pays `runGatedWrite`.
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

### Agentic via a read-only app-model (hybrid)
The board is **born agentic** without a new write path. The orchestrator/agent reads a single,
self-describing **app-model** (`app://model`, read-only — see PR-3): the board **types** and what each
is for, the **tool catalog**, the **live canvas** (boards/groups/connectors), and the **rules**. That
turns decomposition + routing from a hardcoded recipe into *reasoned* planning grounded in the actual
app — while the scripted state machine stays the **safety envelope** and *every write still pays
`runGatedWrite`*. Agency lives in the what/why; the gate governs the do. The same structured app-model
is the graph an optional live **Mermaid diagram** renders (PR-6), so the board's understanding is
*visible* as it works.

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

### App self-model — the read-only resource the agent reasons over (hybrid)
A single read-only MCP **resource** the orchestrator/agent reads (NOT a write path, NO token). It is what
makes routing *reasoned* instead of scripted; the scripted state machine stays the safety envelope.

```text
app://model  (read-only)
{
  boardTypes: [{ type, purpose, tools, states, seedable, autowire }],
  tools:      [{ name, purpose, tier }],
  canvas:     { boards, groups, connectors },   // live: listBoards + listGroups (groups land in PR-5)
  rules:      { spawnCap: 4, everyWriteGated: true, ... }
}
```

Static tier (`boardTypes` · `tools` · `rules`) has no dependencies and ships in PR-3; the `groups` /
`connectors` slice of `canvas` completes when PR-5 mirrors groups to MAIN. The same object is the graph
the optional live Mermaid plan diagram renders (PR-6).

**Persistence (v1): runtime-only.** The task queue lives entirely in the ephemeral `commandStore` and is
lost on quit — smallest, safest surface. **The Command board itself** is a persisted board (it is on the
canvas), which is the one breaking schema change (see Phase A). Durable queue across restarts is
deferred (sidecar JSON in `userData`/`.canvas/`, never `canvas.json`).

---

## 3. Prerequisites — must land BEFORE the Command board functions

These are ordered. **PR-0/PR-1 are in the base** (merged to `main` via #154, squash `1408060`); **PR-2 is
merged into the umbrella** (#164) and **PR-2b is shipped to npm** (`@expanse-ade/mcp@0.11.0`). The hybrid
decision (2026-06-15) adds one net-new read-only prerequisite — **PR-3, the App self-model** — and
re-orders the rest behind it, so the board is *born* agentic: a scripted state machine (safety envelope)
**plus** a read-only app-model (agency), optionally rendered as a live Mermaid diagram (transparency).
Each remaining slice is small and independently shippable **into the umbrella**. (The shipped IDs
PR-0/PR-1/PR-2/PR-2b are frozen; only the unbuilt slices were renumbered — old PR-3→PR-4, PR-4→PR-5,
PR-5→PR-6, PR-6→PR-7.)

| # | Prerequisite | Why it blocks the Command board | Status / where | Size |
|---|---|---|---|---|
| **PR-0** | **Per-task settle (running→idle)** — BUG-002/007. A live shell's status is permanently `running`; `awaitHandoffSettled` never wakes, so handoffs ride the 5-min backstop. Fix = write_result fast-path + a quiet-window check **inside `awaitHandoffSettled`** reading `pty.ts` `lastActivityAt` directly (NOT `deriveStatus`'s dead fallback) + exit-code gate. | **Everything depends on it.** Without it: kanban cards never leave "executing", the recap timeline never gets a completed entry, "done" never fires. | **✅ MERGED to `main` (#154, squash `1408060`).** Still **verify** the shipped settle matches the two-gate shape this design assumes before relying on kanban/recap. | S (verify) |
| **PR-1** | **Schema drift close** — BUG-013/014. MAIN `SCHEMA_VERSION` stuck at 9 while renderer `boardSchema` is 10; the drift-guard test hardcodes `9`. | Phase A mints a 4th board type `command` = a **breaking ADR 0007 double-bump** (`SCHEMA_VERSION` + `MIN_READER_VERSION`). That bump must start from a clean lock-step base, not on top of an existing drift. | **✅ MERGED to `main` (#154, squash `1408060`).** | S |
| **PR-2** | **`gitDiff` — un-stub + wire simple-git in MAIN.** Today `mcpOrchestrator.ts:751` throws `"gitDiff not available until Phase 6"`; **simple-git is not wired in MAIN at all**. | The result/recap zones show diffstats (`+218 −37`) and a "view diff" action — the core *value* of collect/merge and the recap timeline. No diff backing today. *(User-identified prerequisite.)* | **✅ MERGED into the umbrella (`feat/command-board`, PR #164).** `simple-git` MAIN-only in `gitDiff.ts`; read-only `gitDiff(boardId)` over the board's resolved spawn `cwd` (`boardCwds` map in `pty.ts`), terminal-type check + byte-accurate 100 KB clamp in `mcpOrchestrator`. Unit-tested + **proven live** (real `git diff HEAD` through a `CANVAS_E2E` seam → `e2e/gitDiff.e2e.ts`, 3/3 Win). Wire-reachable via PR-2b (`git_diff` tool, shipped `0.11.0`). | M |
| **PR-2b** | **`git_diff` MCP *tool* in `@expanse-ade/mcp`.** The installed package (`0.10.0`) registers **no `git_diff` tool** — only spawn/close/configure/handoff/assign/write_result/interrupt/relay/wait_for_idle/wait_for_all/ping. The orchestrator *interface* has `gitDiff(boardId)`, but nothing exposes it over the loopback wire, so an agent/orchestrator cannot call it. | PR-2 made the app side ready; the Command board's diffstats / "view diff" need an **agent-callable** tool. Without PR-2b, gitDiff is in-process only (the e2e seam). | **✅ SHIPPED as `@expanse-ade/mcp@0.11.0`** (orchestrator-tier `git_diff` tool calling `orchestrator.gitDiff`, mirroring `registerInterrupt`; published via OIDC). **App-pin bump `^0.10.0`→`^0.11.0` deferred** — rides with the S2 session's app-side `addPlanningElements` adoption (shared `Orchestrator` interface). | S–M |
| **PR-3** | **App self-model — read-only capability manifest** *(NEW; the hybrid agency layer)*. A single self-describing model the orchestrator/agent reads (no write path, no token): an MCP **resource** `app://model` exposing **board types** (purpose · tools · states · seedable/autowire), the **tool catalog** (name · purpose · tier), the **live canvas** (`boards`, and — once PR-5 lands — `groups`/`connectors` via `listBoards`/`listGroups`), and the **rules** (spawn cap, every-write-gated). | Flips routing/decomposition from a hardcoded recipe to *reasoned* planning grounded in the actual app, while the scripted state machine stays the **safety envelope**. Also the graph the optional live Mermaid diagram renders (PR-6). | **✅ APP-SIDE BUILT** (`feat/cmd-app-model`): `appModel.ts` pure builder (static board-type + tool/tier tables) + `describeApp()` orchestrator method + CANVAS_E2E seam. **boards + connectors live now**; `groups` stay `[]` until PR-5. 8 unit + 2 e2e green; typecheck/lint/format clean. Read-only, security-neutral (no write path, no token). Agent-facing MCP resource (`canvas://app-model`) deferred to **PR-3b**. | M |
| **PR-4** | **Worker result reporting** *(was PR-3)*. Worker agents must call worker-tier `write_result` on completion (via launch-prompt instruction / Stop hook), or rely on PR-0's inactivity floor. | The `done` state, the recap TIMELINE, and merge all need a real `BoardResult` (status/summary/refs). The orchestrator already scaffolds `onResultSettled`; the *signal* is missing. | **Net-new (mostly config).** For claude, reuse the existing recap transcript watcher (`agentRecapMap.ts`) to synthesize a result. | M |
| **PR-5** | **Group-aware orchestration** *(was PR-4)*. `spawnBoard({type,prompt?,cwd?})` makes **one** board, no group; **groups are renderer-only** (no `listGroups`/`sanitizeGroups` in `boardRegistry.ts`, `mcp:boards` pushes only `{boards, connectors}`). | The board spawns a **Named Group** of {terminal, planning, browser} per task and the roll-up/dispatch must address it. **Also completes PR-3's app-model live tier** (`groups`/`connectors`). | **(a) ✅ MERGED into the umbrella (PR #170)** — `groups[]` mirror: `sanitizeGroups` + `listGroups()` in `boardRegistry.ts` + `{boards,connectors,groups}` `mcp:boards` payload + `describeApp().canvas.groups` live. **(b) ✅ BUILT (PR-5b, app-side)** — `spawnGroup(input)` orchestrator primitive (`mcpLifecycle.ts`): mints every id, reserves ALL member slots against the cap (reserve-all-or-none, release-on-fail), drives ONE `sendCommand({type:'spawnGroup'})` → renderer creates the cluster (terminal + optional planning/browser) + Named Group + browser→terminal `previewSourceId` wiring in one undoable step. Content-less ⇒ cap-checked, NOT human-gated (the gate stays on content writes). Unit-tested (lifecycle cap/release/composition + renderer applier + free-slot placement) + **proven live** (real spawn through the `CANVAS_E2E __canvasE2EMain.spawnGroupNow` seam → `e2e/spawnGroup.e2e.ts`, 2/2 Win). **Agent-callable `spawn_group` MCP tool deferred to PR-5c** (same split as gitDiff/PR-2b — not yet wire-reachable). | L |
| **PR-6** | **Planning seed + live plan diagram** *(was PR-5; optional for v1)*. No API seeds Planning elements via MCP (`spawnBoard` only sets `launchCommand` for terminals). | Seed the Planning member with the decomposed subtask checklist — and, reusing the same write path, render the **app-model graph as a live Mermaid diagram** (the orchestration plan/topology, updating as the state machine advances). Consumes the S4 Mermaid Diagram element from the Planning-board epic as an **optional view**, never a dependency the board waits on. | **Net-new.** Could be deferred — ship v1 with terminal+browser groups; add the seeded Planning member + diagram view later. | M |
| **PR-7** | **Batch-authorization decision** *(was PR-6)*. A decomposed task fans out N subtasks → N `runGatedWrite` confirm dialogs. | Usable but noisy. Either accept per-line confirm for v1, or build one plan-approval modal (per-line sanitize+nonce+audit preserved). | **Decision (optionally defer impl).** Net-new on the most security-sensitive path. | Decide → S/M |

**Already shipped (NOT prerequisites):** Browser auto-wiring — the Browser member connects via the
shipped **port-detect → push-to-preview** (Slice C′). The dispatch gate, board registry, status buckets,
`subscribeStatus`, Named Board Groups (v6), and the terminal-recap pattern all exist.

### Prerequisite build order (small steps)
```
PR-0 settle ─┐ DONE — merged to main (#154); verify the settle shape before relying on it
PR-1 schema ─┘ DONE — merged to main (#154)
      └─► PR-2  gitDiff app-side (simple-git in MAIN)        DONE — merged into umbrella (#164)
            └─► PR-2b git_diff MCP *tool* (@expanse-ade/mcp) DONE — shipped 0.11.0 (app-pin bump deferred)
                  └─► PR-3 App self-model (read-only app://model)   DONE — merged into umbrella (#167)
                        └─► PR-4 worker result reporting           DONE — merged into umbrella (#169)
                              └─► PR-5a groups[] MAIN mirror (completes PR-3 live tier)  DONE — merged into umbrella (#170)
                                    └─► PR-5b spawnGroup primitive (app-side)            DONE — this PR (app-side; e2e seam)
                                          └─► PR-5c spawn_group MCP *tool* (@expanse-ade/mcp)  TODO — agent-callable (mirrors PR-2b)
   optional/consumer: PR-6 planning seed + live Mermaid plan diagram · decide: PR-7 batch-auth
   then: Command board phases A–F (all prerequisites land at PR-5b; PR-5c/6/7 are consumers)
```

---

## 4. The grand plan — Command board phases (AFTER prerequisites)

Each phase ends runnable + committed, on a `feat/*` worktree, merged sequentially through the full gate
+ e2e matrix (Canvas ADE convention).

| Phase | Deliverable | Needs | Schema |
|---|---|---|---|
| **A — Board shell** | **✅ BUILT (`feat/cmd-phase-a-shell`).** Mint board type `command` (breaking bump **11→12 / floor→12** + identity migration — main moved to v11 via the S4 Mermaid element, so the 4th board type lands at v12, NOT the originally-planned 10→11); the Combined board frame (`CommandBoard.tsx`: titlebar seg + inert submit well + worker-pool strip + empty 5-col kanban + collapse↔rail); ephemeral `commandStore` (runtime-only) + reset on project-load/e2e; **singleton** (enforced in `addBoard`); worker-pool auto-discovery (`workerPool.ts`, renderer mirror of `describeApp().canvas`, honors `monitorActivity` opt-out). No dispatch yet. Production mock re-shot (expanded + collapsed) + signed off; live-verified (4 @core e2e + screenshots). | PR-1 ✅ | **Breaking** |
| **B — Kanban + lifecycle** | The kanban body; cards = `commandStore` tasks bucketed by `TaskStatus`; cards move on `subscribeStatus`/settle events; honest "awaiting completion signal" sub-state. | PR-0 ✅ | No |
| **C — Dispatch + group spawn** | submit → decompose → `spawnGroup` ({terminal[, planning][, browser]}) → `dispatch`/`handoff` to members, **reasoned over the app-model** (routing within the scripted envelope); ephemeral routing-edge overlay (NOT persisted connectors); per-line `runGatedWrite` confirm; interrupt/retry. | PR-5, PR-4, PR-3 (app-model) | No |
| **D — Collect / merge + recap + diff** | snapshot `boardResult` into the result zone; the flip-to-recap face (②) with the TIMELINE; real diffstats + "view diff" via `gitDiff`. *(Optional: render the app-model as a live Mermaid plan diagram — PR-6.)* | PR-2 ✅ (+ PR-2b ✅), PR-4, PR-3 (app-model) | No |
| **E — Roll-up + rail polish** | the Group roll-up tab (③) with grouped-focus jump (reads the app-model `groups`); the always-on/collapsed rail (④); flip + seg transitions. | PR-5 mirror, PR-3 (app-model) | No |
| **F — Batch-auth + durability (optional)** | plan-approval batch authorization (per PR-7 decision); optional durable queue (sidecar JSON in `userData`/`.canvas/`, never `canvas.json`). | PR-7 | No (sidecar) |

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
- **Agency model (hybrid, decided 2026-06-15)** — a scripted state machine is the **safety envelope**; a
  **read-only app self-model** (`app://model`, PR-3) is the **agency layer** the agent reasons over; an
  optional live Mermaid diagram is the **transparency layer** (PR-6, consuming the Planning-epic S4
  element). The agent plans freely; *every write still pays `runGatedWrite`* — agency lives in the
  what/why, the gate governs the do. No new write path; no token in the renderer; the diagram is an
  optional view the board never waits on.
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
