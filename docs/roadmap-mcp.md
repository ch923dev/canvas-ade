# Canvas ADE × MCP — Integration Roadmap

> **Umbrella branch:** `feat/mcp-integration`. **Goal:** close the gap between the shipped MCP package
> (`@expanse-ade/mcp`, Phases 0–1) and a full AI-orchestrated swarm on the canvas — plus the
> **spatial UI** (connectors, on-canvas attention, audit viewer) that makes it Canvas ADE's
> differentiator. Builds out package Phases **2–9** + a **Feature Workspaces** (worktrees) enabler.
>
> **Decided 2026-06-03** (brainstorming): full P2–P9 closure · backend **and** spatial UI · Feature
> Workspaces in scope · **every task spans both repos** (package tool + app adapter/UI) · **every task
> ships with an e2e probe AND a manual test** · **a handoff doc is written after every task**.
>
> Companion docs: package phase ledger `Z:\canvas-ade-mcp\docs\roadmap.md` · status audit
> `docs/reviews/2026-06-03-mcp-status-audit.md` · **packaging & serving model**
> `docs/roadmap-mcp-packaging.md` (dev = `pnpm link`, release = bundled-in-MAIN) · MCP facts
> `mcp-spec-state-2026-06` (memory).

Legend: 🚦 hard gate · ✅ acceptance · 🔒 security-critical · ⛓ depends-on · 🧪 two-layer test
(contract + live-against-Canvas-ADE) · ∥ parallelizable.

---

## 0. Architecture recap (no separate backend)

`canvas-ade-mcp` is a **library, not a daemon**. `createMcpHttpServer(deps)` runs a loopback HTTP
listener **inside Electron MAIN**. MAIN **is** the backend. The only separate processes are the CLI
agents inside Terminal boards, which talk to MAIN over `127.0.0.1` with a per-board bearer token.

```
Terminal board's CLI agent (separate process)
        │  loopback HTTP + bearer token
        ▼
Electron MAIN ── hosts ──▶ canvas-ade-mcp (library, in-process)
   │   ▲                          │ calls
   │   │ mcp:boards (mirror)      ▼
   │   │                    Orchestrator adapter (MAIN-owned: PTY map + board mirror + worktrees)
   │   ▼ mcp:command (NEW, this roadmap)
 renderer (canvasStore) ◀── MAIN drives the canvas
```

Two repos, **one runtime**. The "backend implementation" of every milestone = the Orchestrator
adapter + IPC + worktree/git logic in **`canvas-ade` MAIN**, plus the tool/resource contract in the
**`canvas-ade-mcp`** library. There is no third component (multi-machine / remote / headless daemon
are all explicitly deferred).

---

## 1. Branch & cadence model

- **`feat/mcp-integration` is the umbrella** (mirrors `feat/whiteboard`). It is NOT merged to `main`
  per task — it accumulates milestones and merges to `main` at milestone boundaries (full gate +
  e2e + manual re-run before each → `main` PR).
- **Each task = one sub-branch off the umbrella**: `feat/mcp-<task-id>` (e.g. `feat/mcp-t1-1-status`).
  Squash-merge back into `feat/mcp-integration` when its card is green. One task in flight at a time
  unless cards are explicitly file-disjoint (declare zones on `ACTIVE-WORK.md` first).
- **The package repo** (`Z:\canvas-ade-mcp`) gets a matching branch + commit per task that needs a
  new tool/resource; bump its version and the app's dependency together (the app consumes the
  published `@expanse-ade/mcp`).
- **A handoff doc is written after EVERY task** → `docs/superpowers/handoffs/<YYYY-MM-DD>-mcp-<task-id>.md`.

### Per-task card template (mandatory fields)

| Field | Content |
|---|---|
| **Repos / zones** | package files touched + app files touched (declared on the coordination board) |
| **Build** | **pkg:** tool/resource + Zod schema + contract test. **app:** Orchestrator-adapter method + any IPC + any UI |
| **🧪 e2e** | a `CANVAS_SMOKE=mcp` probe in `src/main/mcpSmoke.ts` that **asserts the canvas actually changed** (not just that the call returned). New probes follow the existing `MCP_*_OK` marker style |
| **Manual** | **(a)** MCP **Inspector** (`@modelcontextprotocol/inspector`) against the live loopback server — call the tool/read the resource, eyeball the result; **(b)** a **real CLI agent** in a Terminal board, pointed at the server via a generated `.mcp.json`, exercising the capability end-to-end. Each lists explicit steps + expected output |
| **Gate** | `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build` (app) · `pnpm test && pnpm test:live` (pkg) · the two-layer 🧪 must be green |
| **Handoff** | written after the task: what landed, files, test evidence, follow-ups, next-task pointer |

### Manual-test harness (one-time setup, used by every card)

1. **Inspector:** `cd Z:\canvas-ade-mcp; pnpm exec @modelcontextprotocol/inspector` → connect to
   `http://127.0.0.1:<port>/mcp` with a minted bearer token (read the port + token from a dev-mode
   log line MAIN prints when `is.dev`). Gives a click-through UI for `tools/list`, `tools/call`,
   `resources/read`.
2. **Real agent:** a `.mcp.json` (written by the package's `writeMcpJson`) placed where the board's
   CLI reads it; launch e.g. `claude` in a Terminal board; confirm it lists the canvas tools and a
   tool call mutates the real canvas.

> **The two-layer test rule is non-negotiable** (the package's reason to exist): no tool/resource
> ships until it passes a contract test **and** a live test against the running Canvas ADE.

---

## 2. Dependency graph

```
M0 Foundation ──┬─▶ M1 Observation ──┬─▶ M3 Lifecycle ──▶ M4 Dispatch ──▶ M5 Barriers/Attention
                │                     │                       ▲                    │
                └─▶ M2 Connectors ────┴───────────────────────┘                    │
                                                                                   ▼
                          M6 Feature Workspaces ──┬─▶ M7 Git tools ────▶ M8 answer_permission
                                                  └─▶ M9 Best-of-N ─────────────▶ M10 Hardening
```

- **M2 Connectors** is independent of M1 (pure renderer/state) → can run ∥.
- **M6 Feature Workspaces** depends only on M3 (board lifecycle) and unblocks both M7 and M9.
- **M8** needs dispatch (M4) + barriers (M5). **M10** integrates everything.

---

## 3. Sibling subsystem — Brain + Memory, and how MCP connects to it

A separate MAIN subsystem (built on its own track, **not** in this roadmap and **not** in the
`canvas-ade-mcp` package) gives the desktop its own small LLM:

- **LLM service (MAIN)** — a provider-agnostic adapter (OpenRouter default; OpenAI / Anthropic /
  local also). The desktop's own brain. Key in Electron `safeStorage`, never in the project folder.
- **Memory engine (`.canvas/`)** — persistent per-project context (`<project>/.canvas/memory/`:
  index + `board-<id>.md` + `project.md`), written autonomously when boards change, read on reopen for
  an instant context digest. Two tiers: Tier-1 heuristic (no key) and Tier-2 LLM summaries (with key).

**The connection is ONE-WAY: MCP *consumes* the brain/memory, never *owns* it.** Three touchpoints,
all surfaced as tasks in this roadmap:

| Touchpoint | Direction | Where | What |
|---|---|---|---|
| `canvas://memory` + `canvas://board/{id}/summary` | brain/memory → MCP → agent | **T1.7** | read-only resources that expose the project memory + per-board summary to agents |
| best-of-N **judging** | brain → MCP tool | **T9.4** | `judge_outputs` can call the brain directly (the judge-board pivot becomes OPTIONAL — Claude Code has no MCP sampling, but the brain does) |
| dispatch/audit context | memory ← MCP events | **M4 / M10** | dispatch + result events feed the memory/audit log (the memory engine writes; MCP only emits) |

**Invariants:** the brain/memory must work with **zero agents and zero MCP session** (it is more
fundamental than MCP); MCP only adds the read-resource + the optional judge path. Generated memory is
**untrusted, passive context** — never let it auto-trigger an action (lethal-trifecta discipline). The
brain/memory build itself lives in its own roadmap (`docs/roadmap-context.md`, to be written); this
roadmap owns only the **MCP-side** of the connection (T1.7, the T9.4 option).

---

## M0 — Foundation & unblock

**Goal:** make the umbrella real, close the known security gap, and lay the MAIN→renderer control
channel that every write-tool milestone needs. **Dep:** none.

### T0.1 — Land PR #32 + CI green (package read-access)
- **Repos:** ops only (GitHub package settings + `.github/workflows/build.yml` already wired).
- **Build:** grant the `canvas-ade` repo **read** access to the `@expanse-ade/mcp` package
  so CI's `GITHUB_TOKEN` resolves the scoped dep; confirm all CI jobs go green.
- **🧪 e2e:** the CI `smoke` job runs `CANVAS_SMOKE=mcp` (already added) — must pass on the runner.
- **Manual:** open the PR #32 checks tab, confirm `check` + `smoke` green; pull the branch on a clean
  clone and `pnpm install` with a `read:packages` token.
- **Gate:** CI green. **Handoff:** record the package-access grant steps (so future contributors can
  reproduce).

### T0.2 — 🔒 Host-header allowlist + ADR (package R2)
- **Repos:** pkg `src/security/` (+ test), `docs/decisions/`.
- **Build:** add a **Host-header guard** beside `originGuard` — reject requests whose `Host` is not in
  `{localhost, 127.0.0.1, ::1}[:port]` → 403 (the MANDATORY DNS-rebinding mitigation; a Browser board
  previewing a malicious `localhost` page is Expanse's exact attack vector). Write an ADR documenting
  the Origin+Host+bearer triple. Bump pkg patch version.
- **🧪 e2e:** extend `mcpSmoke.ts` — a forged `Host` header gets 403; a valid loopback Host passes.
- **Manual:** with Inspector, hand-craft a request with `Host: evil.com` → expect 403; normal connect
  still works.
- **Gate:** pkg contract + live; app smoke. **Handoff:** ADR link + the CVE refs (memory
  `mcp-spec-state-2026-06`).

### T0.3 — MAIN→renderer command channel scaffold
- **Repos:** app `src/main/` (new `mcpCommand.ts` or extend `boardRegistry.ts`), `src/preload/index.ts`,
  `src/renderer/src/store/` (a `useMcpCommands` applier hook).
- **Build:** a one-way **MAIN→renderer** control channel (`mcp:command`) the inverse of the existing
  `mcp:boards` mirror — MAIN posts a typed command, the renderer applies it to `canvasStore` and
  acks. Ship it with a **no-op `ping` command only** (proves the round-trip); real commands
  (add/remove/select board) arrive in M3. Sender/recipient guarded; commands are control-plane only.
- **🧪 e2e:** `mcpSmoke.ts` issues a `ping` command from MAIN → asserts the renderer ack returns.
- **Manual:** dev-mode button or console call triggers a `ping`; confirm the ack in the MAIN log.
- **Gate:** app gate + smoke. **Handoff:** document the command envelope shape (the contract M3 builds on).

**🚦 M0 gate:** CI green on #32, Host-header guard live, command channel round-trips. Then M1/M2 open.

---

## M1 — Observation resources (package Phase 2)

**Goal:** give agents *eyes* — read-only board state, all safest-first. **Dep:** M0.
**Pkg surface:** `canvas://boards` (exists), `canvas://board/{id}/status`, `canvas://board-states`,
`canvas://attention`, `canvas://board/{id}/output`, `canvas://board/{id}/result`.

### T1.1 — Status buckets in the board mirror
- **Build:** **app** — enrich the renderer→MAIN snapshot so each board carries a coarse **status
  bucket** (`idle` / `running` / `awaiting-review` / `blocked` / `failed` / `static`), derived from
  terminal runtime state (`terminalRuntimeStore`) + `previewStore` load state, not just presence.
  **pkg** — `canvas://board/{id}/status` resource reads it.
- **🧪 e2e:** seed a terminal, drive it to running then exited; assert the status resource reflects
  each transition. **Manual:** Inspector reads `status` for a live vs idle board.

### T1.2 — `canvas://board-states` (bucketed roll-up)
- **Build:** pkg resource returning boards grouped by bucket; app already feeds buckets from T1.1.
- **🧪 e2e:** seed mixed-state boards; assert the roll-up counts. **Manual:** Inspector reads the map.

### T1.3 — `canvas://attention` (who needs a human)
- **Build:** pkg resource listing boards in `blocked`/`awaiting-review`/`failed`; app derives the set.
- **🧪 e2e:** force a board to `blocked`; assert it appears in attention, clears when resolved.
- **Manual:** Inspector + a real agent hitting a prompt.

### T1.4 — 🔒 `canvas://board/{id}/output` (capped + paginated)
- **Build:** **app** — a read-only, **size-capped** scrollback accessor in `pty.ts` (never dump raw
  buffer). **pkg** — paginated resource honoring the **25k MCP output cap**; cap, don't truncate-blind.
- **🧪 e2e:** run a command emitting > cap bytes; assert paginated, capped, ordered output.
- **Manual:** Inspector pages through a long-running board's output.

### T1.5 — `canvas://board/{id}/result` (structured)
- **Build:** pkg structured result resource (references, not raw logs); app exposes last-result.
- **🧪 e2e:** a board writes a result marker → resource returns it structured. **Manual:** Inspector.

### T1.6 — On-canvas status surfaced (spatial UI)
- **Build:** app — the board-chrome status indicator reflects the **same bucket** the MCP sees (one
  source of truth). No new MCP surface; this is the human-visible half of observation.
- **🧪 e2e:** existing board-chrome probe asserts the pill matches the bucket. **Manual:** eyeball a
  running vs blocked board on the canvas.

### T1.7 — Expose the Brain/Memory to agents (the MCP side of the §3 connection) — ✅ SHIPPED
> **SHIPPED** with MCP M0–M4. Pkg 0.8.2/0.9.0 register both resources (`dist/index.js`); the app injects
> `src/main/boardMemory.ts` (`readProjectMemory`/`readBoardSummary`) into `startMcpServer` → wired through
> `mcpOrchestrator.projectMemory()`/`boardSummary()`. Path-guarded id (≤64, `[A-Za-z0-9_-]`), 100k-char cap,
> graceful-empty. Covered: `boardMemory.test.ts` + the write→MCP-read join `boardMemory.join.integration.test.ts`
> + smoke `MCP_MEMORY_OK`. ⚠️ **Residual:** the served summary is LLM-generated (untrusted) → a consuming
> agent can be prompt-injected by it; passive on the desktop, but the consuming agent's safety is the new
> surface (ADR 0003 › M-expose residual). `project.md` rollup is written but not exposed (scope call).
- **Build:** **pkg** — read-only resources `canvas://memory` (project memory index) and
  `canvas://board/{id}/summary` (per-board summary). **app** — the Orchestrator adapter reads the
  sibling **memory engine's** `.canvas/memory/` (T6/sibling roadmap) and serves it; if the brain/memory
  subsystem is absent, the resources return an **empty/"unavailable"** payload (graceful — MCP never
  hard-depends on the brain). 🔒 memory is **passive context** — exposing it grants no action.
- **🧪 e2e:** seed a `.canvas/memory/` fixture → `canvas://memory` returns it; with no memory present →
  resource returns the empty/unavailable shape (not an error).
- **Manual:** Inspector reads `canvas://memory` + a board summary; a real agent reads project context
  on connect.

**🚦 M1 gate:** an agent enumerates + reads live board state; large output capped not blind; the
on-canvas pill agrees with `canvas://board-states`; `canvas://memory` serves (or gracefully empties).

---

## M2 — Spatial connectors (feature-proposal SB-4) ∥ M1

**Goal:** typed, **persisted** board-to-board connector edges — the visual substrate that M4 dispatch
flows along (drag a cable = an orchestration link). Generalizes the existing `PreviewEdge` /
`BrowserBoard.previewSourceId`. **Dep:** M0.

### T2.1 — Connector data model + persistence
- **Build:** app — a typed `connectors` array on the canvas doc (`{id, sourceId, targetId, kind}`,
  `kind ∈ {preview, orchestration}`), **schemaVersion bump + migration** (fold the existing
  `previewSourceId` into a `preview` connector). `simple-git`-free, renderer/state only.
- **🧪 e2e:** create a connector → save → reload → assert it round-trips. **Manual:** inspect
  `canvas.json` after drawing one.

### T2.2 — Draw / delete connector gesture
- **Build:** app — drag from a board's connector handle to another board creates an `orchestration`
  edge; delete via select+Del or the edge's ✕. Reuse the existing connect-gesture plumbing.
- **🧪 e2e:** synthetic gesture creates the edge; delete removes it + cleans up on board delete/dup.
- **Manual:** draw + delete a cable on the canvas; confirm persistence.

### T2.3 — Typed edge render
- **Build:** app — render `orchestration` edges distinctly from `preview` edges (style per DESIGN
  tokens); reroute on move; persist.
- **🧪 e2e:** assert both edge kinds render + reroute. **Manual:** eyeball both styles at zoom.

**🚦 M2 gate:** connectors persist, round-trip, and are visually distinct; no regression to preview
edges.

---

## M3 — Lifecycle tools (package Phase 3)

**Goal:** first *write* tools — board creation/teardown, no cross-agent influence yet. **Dep:** M1
(+ M0 command channel). 🔒 concurrency cap + idle-reaping is the runaway-swarm guard.

### T3.1 — `spawn_board(type, prompt?, cwd?)`
- **Build:** **pkg** tool (validates type, caps N). **app** — the Orchestrator adapter `spawnBoard`
  stops throwing; it issues an `mcp:command` (M0) → renderer adds a board to `canvasStore` at a free
  slot, returns the server-issued id. 🔒 hard **concurrency cap**.
- **🧪 e2e:** orchestrator calls `spawn_board('terminal')` → assert a **new board appears in the
  mirror + on the canvas** and a shell starts. **Manual:** real agent spawns a board; watch it appear.

### T3.2 — `close_board(id)` (graceful drain)
- **Build:** pkg tool; app adapter drains the PTY (not immediate kill) then removes the board via the
  command channel. (Dirty-worktree prompt arrives with M6.)
- **🧪 e2e:** spawn then close → board gone from mirror + canvas, PTY reaped. **Manual:** real agent
  closes a board.

### T3.3 — `configure_board(id, …)`
- **Build:** pkg tool; app adapter applies shell/launchCommand/cwd changes via the command channel.
- **🧪 e2e:** configure → assert the board's config changed. **Manual:** Inspector reconfigures.

### T3.4 — 🔒 Concurrency cap + idle-reaping
- **Build:** app — enforce a max live MCP-spawned board count; reap idle MCP-spawned boards after a
  TTL. Reject over-limit spawns with a clear error.
- **🧪 e2e:** spawn past the cap → rejection; an idle spawned board reaps. **Manual:** drive the cap.

**🚦 M3 gate:** an agent creates/destroys real boards within the cap; nothing auto-spawns unbounded.

---

## M4 — Dispatch (package Phase 4) 🔒

**Goal:** the orchestrator gains a *voice into another agent's shell* — maximum care. **Dep:** M2, M3.
🔒🚦 **gate:** no auto-dispatch from worker-originated (tainted) content; every dispatch is
human-confirmed + audited.

### T4.1 — Audit log infrastructure + viewer shell
- **Build:** app — an append-only **audit log** in MAIN (resolved target + full prompt + outputs +
  nonce + timestamp) persisted under `userData`; a minimal **audit-log viewer** UI (read-only list).
- **🧪 e2e:** a dispatched action writes an audit entry the probe reads back. **Manual:** open the
  viewer, see the entry.

### T4.2 — 🔒 Human-confirm modal infrastructure
- **Build:** app — a reusable **native Electron confirm modal** in MAIN (no client-elicitation
  dependency — MAIN owns the UI). Returns approve/deny to the calling tool. Used by M4/M6/M7.
- **🧪 e2e:** a tool requiring confirm blocks until the (harness-driven) modal resolves. **Manual:**
  trigger a confirm, click approve/deny, observe the gate.

### T4.3 — 🔒 `handoff_prompt` (blocking)
- **Build:** **pkg** tool (send → await idle → return result). **app** adapter: provenance-tag the
  prompt (unspoofable "from orchestrator"), single-use **nonce** + monotonic sequence, **human-confirm**
  (T4.2), write to the target board's PTY (MAIN already owns the PTY — terminal→terminal only, never
  Browser→PTY), await idle (M5 preview / interim poll), audit (T4.1). Bind to the opaque server id.
- **🧪 e2e:** `handoff_prompt(worker, "echo hi")` → text **lands in the worker PTY**, runs, result
  returns; replayed nonce rejected; label-targeting rejected; audit written. **Manual:** orchestrator
  agent hands a task to a worker agent; confirm prompt fires; worker runs it.

### T4.4 — `assign_prompt` (fire-and-forget) + `write_result`
- **Build:** pkg tools; app fire-and-forget dispatch; worker reports via `write_result` → feeds the
  `result` resource (T1.5).
- **🧪 e2e:** assign → worker runs async → `write_result` surfaces. **Manual:** real two-agent flow.

### T4.5 — `interrupt(id)`
- **Build:** pkg tool; app sends an interrupt (Ctrl-C equivalent) to the target PTY.
- **🧪 e2e:** a long task is interrupted. **Manual:** interrupt a runaway agent.

### T4.6 — Agent-to-agent over the connector cable (Maestri-borrow P2)
- **Build:** app — a dispatch from board A to board B is **expressed by an `orchestration` connector**
  (M2): the cable is the routing + intent UI; dispatch resolves its target from the edge. 🔒 relay is
  **terminal→terminal only**, one-directional, never Browser→PTY.
- **🧪 e2e:** draw a cable A→B, dispatch along it → lands in B. **Manual:** the spatial command-board
  demo — cable + handoff.

**🚦 M4 gate:** a confirmed, audited prompt executes in the target board; tainted worker output can
trigger nothing without the human gate.

---

## M5 — Barriers + event-driven attention (package Phase 5)

**Goal:** the orchestrator can *wait* efficiently — backbone of sequenced swarms. **Dep:** M1, M4.

### T5.1 — `canvas://attention` SSE subscription
- **Build:** pkg — resource subscription (`notifications/resources/updated` over GET-SSE), **no poll**.
  app — push attention changes to subscribers off real board-state changes.
- **🧪 e2e:** subscribe → mutate a board's state → subscriber woken. **Manual:** Inspector subscription.

### T5.2 — `wait_for_idle(id)` / `wait_for_all(ids[])`
- **Build:** pkg tools resolving off the T5.1 subscription. app — idle detection per board.
- **🧪 e2e:** dispatch + `wait_for_idle` resolves **exactly when the board goes idle** (not a timer).
- **Manual:** orchestrator waits on a real worker.

### T5.3 — Attention state distinction
- **Build:** app — distinguish `idle-done` vs `blocked-on-permission` vs `error/crashed` in the
  attention feed.
- **🧪 e2e:** a blocked worker surfaces as `blocked`, not `idle`. **Manual:** drive each state.

### T5.4 — On-canvas "needs-you" attention queue (feature-proposal SB-1, spatial UI)
- **Build:** app — a glanceable on-canvas queue / chrome badge of boards needing the human, driven by
  the same attention feed.
- **🧪 e2e:** queue reflects blocked boards. **Manual:** eyeball the queue as agents block/unblock.

**🚦 M5 gate:** barriers resolve event-driven (no busy-poll); the human can see at a glance who needs them.

---

## M6 — Feature Workspaces (worktree enabler)

**Goal:** git-worktree-per-board-**zone** (a cluster of boards), the locked deferred model — unblocks
M7 git tools and M9 best-of-N. **Dep:** M3. 🔒 carries the locked safety rules.

### T6.1 — Worktree manager in MAIN
- **Build:** app — a `simple-git`-backed worktree manager in MAIN (behind frame-guarded IPC):
  create/list/remove. 🔒 **reuse-if-exists**, **never nest-init** (refuse when inside a parent repo),
  always `git worktree remove` (never `rm -rf`).
- **🧪 e2e:** create a worktree for a zone → assert it exists on disk + in `git worktree list`; remove
  it cleanly. **Manual:** inspect the worktree dir + branch.

### T6.2 — Zone model (boards → one worktree+branch)
- **Build:** app — a **feature zone** abstraction: a cluster of boards bound to one worktree+branch;
  a board's `cwd` resolves to its zone's worktree checkout.
- **🧪 e2e:** group boards into a zone → their cwd points at the worktree. **Manual:** spawn a terminal
  in a zone, `pwd` shows the worktree.

### T6.3 — 🔒 Dirty-on-delete: keep + prompt
- **Build:** app — deleting a board/zone with a dirty worktree → **keep on disk + prompt**
  (commit / stash / discard / keep), never silent `--force`. Wire `close_board` (T3.2) to it.
- **🧪 e2e:** dirty worktree on close → prompt path taken, tree preserved. **Manual:** make it dirty,
  close, see the prompt.

### T6.4 — Wire `spawn_board(cwd)` to a zone worktree
- **Build:** app — `spawn_board` can target a zone → the new board's shell starts in that worktree.
- **🧪 e2e:** spawn into a zone → shell cwd = worktree. **Manual:** real agent spawns into a feature zone.

**🚦 M6 gate:** worktrees create/reuse/remove safely; no nest-init, no silent force; a board's cwd is
its zone's checkout.

---

## M7 — Git tools (package Phase 6) 🔒 ⛓ M6

**Goal:** review + integrate worker output, **scoped to each board's own worktree**. **Dep:** M6.
🔒🚦 **gate:** no tool can touch a tree other than its own board's.

### T7.1 — `canvas://board/{id}/diff` + `get_changed_files`
- **Build:** pkg paginated diff resource + changed-files resource; app reads the board's worktree diff.
- **🧪 e2e:** a worker edits files → orchestrator reads the correct hunks. **Manual:** Inspector diff.

### T7.2 — 🔒 `commit(id, msg)` (scoped)
- **Build:** pkg tool; app commits **only** in the board's `canvas-ade/<board-id>` worktree,
  server-enforced path scoping.
- **🧪 e2e:** commit advances that branch only; a cross-worktree path is refused. **Manual:** real commit.

### T7.3 — 🔒 `merge(id, into?)` (scoped, confirmed)
- **Build:** pkg tool; app merge scoped + `destructiveHint` + human-confirm (T4.2) + audit; conflicts
  **flagged, not auto-resolved**; never silent `--force`.
- **🧪 e2e:** merge with a conflict → flagged; unconfirmed destructive → blocked. **Manual:** drive a merge.

**🚦 M7 gate:** orchestrator reads + commits a worker's real worktree, scoped + confirmed + audited.

---

## M8 — `answer_permission` (package Phase 7) 🔒

**Goal:** approve/deny a permission prompt inside *another* agent's shell — the sharpest single tool.
**Dep:** M4, M5. 🔒🚦 **gate:** zero code paths allow an unconfirmed permission answer.

### T8.1 — Detect a worker permission prompt
- **Build:** app — recognize a blocked-on-permission state (PTY output heuristic per CLI) → surface as
  `blocked` in `canvas://attention` (T5.3).
- **🧪 e2e:** drive a worker to a real permission prompt → it surfaces as `blocked`. **Manual:** observe.

### T8.2 — 🔒 `answer_permission(id, yes|no)`
- **Build:** pkg tool; app writes the answer into the worker's PTY **only** after an **unconditional
  human-confirm** (T4.2) — never an orchestrator auto-answer, by construction. Full audit.
- **🧪 e2e:** blocked worker → orchestrator requests approval → human confirms → worker proceeds; any
  auto-answer path is impossible. **Manual:** the full human-in-the-loop unblock.

**🚦 M8 gate:** a blocked worker becomes unblockable *through the human*, never silently.

---

## M9 — Best-of-N + integration queue (package Phase 8) ⛓ M6

**Goal:** run N attempts, judge, land the winner without same-file collisions. **Dep:** M6.
**Judging backend (locked, memory `mcp-spec-state-2026-06`):** server-side MCP **sampling is out**
(Claude Code implements none). Two interchangeable backends instead (§3): **the Brain** (MAIN's LLM
service judges directly — preferred when a key is set) **or** a **judge-board** (a terminal judge
agent — the no-key fallback), always backed by a deterministic `register_gate`. See T9.4.

### T9.1 — `spawn_fanout(spec, N, mode)`
- **Build:** pkg tool (`best-of-n` | `split`); app spawns N zone-worktree boards. 🔒 cost-confirm
  (recommend 3–5, not "all"); `split` mode **requires disjoint file/worktree ownership**.
- **🧪 e2e:** fan a task 3 ways → 3 worktree boards appear. **Manual:** real fan-out on the canvas.

### T9.2 — `broadcast_prompt(ids[])`
- **Build:** pkg app-level loop of N targeted sends (spec forbids transport broadcast); Last-Event-ID
  resumability so a flaky connection can't drop a dispatch.
- **🧪 e2e:** broadcast reaches all targets; a dropped connection resumes. **Manual:** broadcast to 3.

### T9.3 — `compare_diffs(ids[])` / `canvas://diffs`
- **Build:** pkg aggregate-diff resource over the N worktrees (the judge's primary input).
- **🧪 e2e:** returns all N diffs. **Manual:** Inspector reads the aggregate.

### T9.4 — Judging (brain OR judge-board) + `register_gate`
- **Build:** pkg `register_gate(taskId, cmd)` — deterministic lint/typecheck/test gate (blocks on
  non-zero exit), always available. **Judging** (rubric'd ranking over `compare_diffs`) has two
  interchangeable backends (§3 connection): **(a) the Brain** — if the LLM service has a key, MAIN's
  `judge_outputs` calls it directly (preferred, no extra board); **(b) judge-board fallback** — spawn a
  judge terminal agent fed the rubric (works with no key, since Claude Code exposes no MCP sampling).
  Pick (a) when the brain is available, else (b).
- **🧪 e2e:** the deterministic gate blocks on a failing command; with the brain mocked, `judge_outputs`
  ranks N results; with no brain, the judge-board path ranks them. **Manual:** run a real best-of-3
  judge both ways (key set / key absent).

### T9.5 — `promote_winner(id)` + `merge_queue`
- **Build:** pkg tools; app — serialized **rebase-and-test land** behind the gate (integration is the
  real bottleneck); losers discarded with the dirty-worktree prompt (T6.3).
- **🧪 e2e:** a real best-of-N lands **exactly one** winner; the rest are discarded. **Manual:** full run.

**🚦 M9 gate:** a real best-of-N completes end-to-end and lands exactly one winner.

---

## M10 — Hardening + coordination layer + packaging (package Phase 9) 🔒

**Goal:** make the swarm safe, observable, shippable. **Dep:** all prior. 🔒🚦 **final gate:** the
lethal-trifecta path (orchestrator consuming tainted worker output) cannot trigger any action without
human-confirm.

### T10.1 — Coordination: self-claiming task graph
- **Build:** pkg `canvas://tasks` + `create_task`/`claim_task`/`update_status`/`add_dependency`
  (file-locked claiming + auto-unblock of dependents); app persists the graph.
- **🧪 e2e:** two workers self-claim disjoint tasks; a dependent auto-unblocks. **Manual:** drive a graph.

### T10.2 — Worker mailbox + results
- **Build:** pkg `send_message(boardId)` worker↔worker mailbox + `write_result` /
  `canvas://board/{id}/result` (references, not raw logs).
- **🧪 e2e:** A messages B; B reads it. **Manual:** two-agent mailbox exchange.

### T10.3 — Control-quality guards
- **Build:** pkg/app — `require_plan_approval` (worker read-only until approved), `effort` param
  (per-worker turn ceiling), stall-guard auto-interrupt, `budget_guard`.
- **🧪 e2e:** an over-budget / stalled worker is auto-interrupted; an unapproved plan can't write.
- **Manual:** trip each guard.

### T10.4 — 🔒 Safety hardening
- **Build:** injection **provenance-tagging + worker instruction-hardening verified together**
  (tagging alone ≈ 5% effective); network-egress restriction (cuts the trifecta's external leg);
  **session revocation** on `close_board`/`discard_worktree` (HTTP 404 the session so a killed board's
  agent can't call tools); confused-deputy controls (token bound to board + single loopback session).
- **🧪 e2e:** a documented injection attempt does **not** auto-drive the orchestrator; killing a board
  revokes its session mid-call. **Manual:** run the injection scenario.

### T10.5 — Packaging
- **Build:** version the contract; `list_changed` on tier promotion (no forced reconnect); stateless
  tools re-derive from token + `canvas.json` so a MAIN restart survives.
- **🧪 e2e:** restart MAIN mid-session → an agent reconnects + re-derives. **Manual:** kill+relaunch.

**🚦 M10 final gate:** a multi-worker, task-graph-coordinated run completes; a documented injection is
contained; revocation works; the lethal-trifecta path cannot fire without the human.

---

## Cross-cutting (every task)

- **Two-layer test gate is mandatory** — contract + live-against-Canvas-ADE. No exceptions.
- **Every task ships an e2e probe AND a manual test, and writes a handoff doc** (the user's standing
  requirement for this roadmap).
- **Never weaken the locked security model:** `contextIsolation`/`sandbox`/`no-nodeIntegration`;
  Browser content never reaches the PTY; loopback-only; capability split enforced **server-side by
  token** (never annotation/prompt).
- **Keep the app gate green** (typecheck/lint/format/unit/build) + the board e2e harness after every
  task; the MCP smoke (`CANVAS_SMOKE=mcp`) grows one probe per capability.
- **Coordination:** declare each sub-branch's zones on `.claude/coordination/ACTIVE-WORK.md` before
  editing; never run feature work in the `Z:\Canvas ADE` main dir (the 2026-06-03 collision lesson).
- **Add an MCP-layer ADR** when a load-bearing decision lands (transport, auth, safety-tier, worktrees).

## Deferred (not in this roadmap)

Multi-level orchestration (workers spawning sub-workers — Claude Code forbids it) · non-loopback /
remote MCP access · OAuth auth (static per-board tokens suffice locally) · cross-machine swarms · a
standalone/headless backend (MAIN is the backend).

## Open questions (resolve at the relevant milestone)

1. **Stateless RC (2026-07-28):** the package is stateful (`Mcp-Session-Id`); plan the stateless
   migration during M10 packaging (12-month overlap → ~mid-2027, transport isolated to one file).
2. **Per-CLI permission-prompt detection (M8):** the blocked-state heuristic is agent-specific — start
   with Claude Code, document the per-CLI matrix.
3. **`.mcp.json` per-board token wiring (M4):** confirm the exact path each target CLI reads
   (Claude Code / Codex / Cursor / Gemini) — primary docs noted in `mcp-spec-state-2026-06`.
